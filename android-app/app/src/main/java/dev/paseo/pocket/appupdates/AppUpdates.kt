package dev.paseo.pocket.appupdates

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.AtomicFile
import dev.paseo.pocket.BuildConfig
import dev.paseo.pocket.Diagnostics
import dev.paseo.pocket.updates.TransferCancellation
import dev.paseo.pocket.updates.UpdateFailure
import dev.paseo.pocket.updates.UpdateGate
import dev.paseo.pocket.updates.LimitedInput
import dev.paseo.pocket.updates.compareVersions
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.Executors

data class AppUpdateState(val kind: String = "idle", val update: AppUpdatePackage? = null,
    val downloaded: Long = 0, val total: Long = -1, val failure: String? = null, val cached: Boolean = false)

/** One foreground-triggered daily check and user-requested transfer, without a background service. */
class AppUpdates(context: Context, private val diagnostics: Diagnostics,
    private val trust: ApkTrust = ApkTrust(context),
    val client: AppUpdateClient = AppUpdateClient(AppReleasePolicy(BuildConfig.UPDATE_REPOSITORY, trust.installed.certificate)),
    private val clock: () -> Long = System::currentTimeMillis,
    private val root: File = File(context.filesDir, "apk-updates"),
    val gate: UpdateGate = UpdateGate()) : AutoCloseable {
    private val packages = File(root, "packages").apply { mkdirs() }
    private val pending = AtomicFile(File(root, "pending.json"))
    private val candidate = AtomicFile(File(root, "candidate.json"))
    private val preferences = context.getSharedPreferences("app_updates", Context.MODE_PRIVATE)
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val listeners = mutableSetOf<() -> Unit>()
    private var cancellation: TransferCancellation? = null
    private var release: (() -> Unit)? = null
    private var generation = 0
    private var closed = false
    private var foreground = false
    private var automaticOperation = false
    val installed get() = trust.installed
    val automatic get() = preferences.getBoolean("automatic", true)
    val lastAttempt get() = preferences.getLong("last_attempt", 0)
    val lastChecked get() = preferences.getLong("last_success", 0)
    var state = AppUpdateState("restoring"); private set
    private fun busy() = state.kind in setOf("restoring", "checking", "downloading", "verifying")
    fun subscribe(listener: () -> Unit): () -> Unit { listeners.add(listener); return { listeners.remove(listener); Unit } }
    private fun publish(next: AppUpdateState) {
        state = next
        if (!busy()) { val done = release; release = null; done?.invoke() }
        listeners.toList().forEach { it() }
    }
    fun apk(update: AppUpdatePackage) = File(packages, "${update.sha256}.apk")
    private fun read(record: AtomicFile): AppUpdatePackage? {
        if (!record.baseFile.exists() && !File(record.baseFile.path + ".bak").exists()) return null
        return runCatching {
            val text = LimitedInput(record.openRead(), 16384, {}).use { it.readBytes() }
            val update = AppUpdatePackage.restore(JSONObject(text.toString(Charsets.UTF_8)))
            requireUpdate(update.certificateSha256 == installed.certificate, "signer_mismatch")
            requireUpdate(update.versionCode > installed.code && compareVersions(update.release.version, installed.version) > 0, "downgrade_blocked")
            update
        }.getOrElse { record.delete(); null }
    }
    private fun write(record: AtomicFile, update: AppUpdatePackage) {
        val output = record.startWrite()
        try { output.write(update.json().toString().toByteArray(Charsets.UTF_8)); record.finishWrite(output) }
        catch (error: Exception) { record.failWrite(output); throw error }
    }
    private fun cleanPackages(keep: AppUpdatePackage?) {
        packages.listFiles()?.filter { it.isFile && (it.extension == "part" || (it.extension == "apk" && it.name != keep?.let { value -> apk(value).name })) }
            ?.forEach { it.delete() }
    }
    init {
        worker.execute {
            val savedCandidate = read(candidate)
            val restored = read(pending)?.let { saved ->
                runCatching { trust.verify(apk(saved), saved); saved }
                    .getOrElse { pending.delete(); diagnostics.record("apk_pending_invalid"); null }
            }
            root.listFiles()?.filter { it.name.startsWith("download-") && it.extension == "part" }?.forEach { it.delete() }
            cleanPackages(restored)
            main.post {
                if (!closed && generation == 0) {
                    publish(when {
                        restored != null -> AppUpdateState("ready", restored)
                        savedCandidate != null -> AppUpdateState("available", savedCandidate, cached = true)
                        else -> AppUpdateState()
                    })
                    if (foreground) checkAutomatic()
                }
            }
        }
    }

    fun foreground(value: Boolean) {
        foreground = value
        if (value) checkAutomatic()
        else if (automaticOperation && state.kind == "checking") cancellation?.cancel()
    }
    fun setAutomatic(value: Boolean) {
        preferences.edit().putBoolean("automatic", value).apply()
        if (!value && automaticOperation) cancellation?.cancel()
        if (value && foreground) checkAutomatic()
    }
    private fun checkAutomatic() {
        if (busy() || state.kind == "ready" || gate.owner != null) return
        if (AppCheckSchedule.due(automatic, lastAttempt, clock())) check(true)
    }
    private fun run(initial: AppUpdateState, automatic: Boolean = false,
        cancelled: AppUpdateState = AppUpdateState("cancelled", initial.update, cached = initial.update != null),
        work: (TransferCancellation, (AppUpdateState) -> Unit, Int) -> Unit) {
        if (closed || busy()) return
        release = gate.acquire(UpdateGate.Target.APP) ?: return
        val ticket = ++generation; val cancel = TransferCancellation()
        automaticOperation = automatic; cancellation = cancel
        publish(initial)
        worker.execute {
            val emit: (AppUpdateState) -> Unit = { next -> main.post { if (!closed && ticket == generation) publish(next) } }
            try { work(cancel, emit, ticket) }
            catch (_: CancellationException) { emit(cancelled) }
            catch (error: Exception) {
                if (runCatching { cancel.check() }.isFailure) emit(cancelled)
                else {
                    val code = (error as? UpdateFailure)?.code ?: "operation_failed"
                    diagnostics.record("apk_$code")
                    emit(AppUpdateState("failed", initial.update, failure = code, cached = initial.update != null))
                }
            }
        }
    }
    fun check(automatic: Boolean = false) {
        if (closed || busy() || state.kind == "ready" || gate.owner != null) return
        preferences.edit().putLong("last_attempt", clock()).apply()
        run(AppUpdateState("checking", state.update, cached = state.update != null), automatic) { cancel, emit, _ ->
            val update = client.latest(installed, cancel); cancel.check()
            if (update == null) candidate.delete() else write(candidate, update)
            preferences.edit().putLong("last_success", clock()).apply()
            diagnostics.record("apk_check_completed")
            emit(if (update == null) AppUpdateState("up_to_date") else AppUpdateState("available", update))
        }
    }
    fun download(update: AppUpdatePackage) {
        if (state.kind == "ready") return
        run(AppUpdateState("downloading", update)) { cancel, emit, _ ->
            requireUpdate(packages.usableSpace > update.release.apkBytes + 16L * 1024 * 1024, "space_low")
            val temporary = File(root, "download-${UUID.randomUUID()}.part")
            try {
                client.download(update, temporary, cancel) { done, total -> emit(AppUpdateState("downloading", update, done, total)) }
                cancel.check(); emit(AppUpdateState("verifying", update)); trust.verify(temporary, update, cancel::check)
                cancel.check()
                Files.move(temporary.toPath(), apk(update).toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                try { write(pending, update) } catch (error: Exception) { apk(update).delete(); throw error }
                cleanPackages(update)
                diagnostics.record("apk_download_verified"); emit(AppUpdateState("ready", update))
            } finally { temporary.delete() }
        }
    }
    fun verifyForInstall(complete: (File) -> Unit) {
        if (state.kind != "ready") return
        val update = state.update ?: return
        run(AppUpdateState("verifying", update), cancelled = AppUpdateState("ready", update)) { cancel, emit, ticket ->
            try { trust.verify(apk(update), update, cancel::check) }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { apk(update).delete(); pending.delete(); throw error }
            cancel.check(); emit(AppUpdateState("ready", update))
            main.post { if (!closed && foreground && generation == ticket && !gate.blocked(UpdateGate.Target.APP)) complete(apk(update)) }
        }
    }
    fun cancel() { if (state.kind in setOf("checking", "downloading", "verifying")) cancellation?.cancel() }
    override fun close() {
        closed = true; generation++; listeners.clear(); cancellation?.cancel(); worker.shutdown()
        val done = release; release = null; done?.invoke()
    }
}
