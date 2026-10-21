package dev.paseo.pocket.updates

import android.content.Context
import android.os.Handler
import android.os.Looper
import dev.paseo.pocket.Diagnostics
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CancellationException
import java.util.concurrent.Executors

data class UpdateStatus(val kind: String = "idle", val candidate: PackageMetadata? = null,
    val readyId: String? = null, val downloaded: Long = 0, val total: Long = -1, val failure: String? = null)

/** One lifecycle-owned worker; no timers or automatic update requests. */
class PageUpdates(context: Context, private val diagnostics: Diagnostics) : AutoCloseable {
    val trust = PackageTrust.parse(JSONObject(context.assets.open("paseo/_trust.json").bufferedReader().use { it.readText() }))
    val store = BundleStore(File(context.filesDir, "pages"), trust,
        VerifiedBundle.parse(JSONObject(context.assets.open("paseo/_workbench.json").bufferedReader().use { it.readText() }), trust))
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val transport = HttpsTransport()
    var currentVersion = runCatching { store.activeMetadata().version }.getOrDefault(store.builtIn.metadata.version)
        private set
    private var token = 0
    private var closed = false
    private var cancellation: TransferCancellation? = null
    var status = UpdateStatus()
        private set
    var listener: ((UpdateStatus) -> Unit)? = null

    init {
        executor.execute {
            try {
                store.cleanInterrupted()
                val pending = store.pending()
                if (pending != null) main.post {
                    if (!closed && token == 0) publish(UpdateStatus("ready", pending.metadata, pending.metadata.id))
                }
            } catch (_: Exception) { diagnostics.record("update_pending_invalid") }
        }
    }

    private fun publish(next: UpdateStatus) { status = next; listener?.invoke(next) }
    private fun busy() = status.kind in setOf("checking", "downloading", "verifying", "applying")

    private fun run(initial: UpdateStatus, work: (TransferCancellation, (UpdateStatus) -> Unit) -> Unit) {
        if (closed || busy()) return
        val run = ++token
        val cancel = TransferCancellation(); cancellation = cancel
        publish(initial)
        executor.execute {
            val update: (UpdateStatus) -> Unit = { next -> main.post { if (!closed && token == run) publish(next) } }
            try { work(cancel, update) }
            catch (_: CancellationException) { diagnostics.record("update_cancelled"); update(UpdateStatus("cancelled")) }
            catch (failure: Exception) {
                if (runCatching { cancel.check() }.isFailure) update(UpdateStatus("cancelled"))
                else {
                    val code = (failure as? UpdateFailure)?.code ?: "operation_failed"
                    diagnostics.record("update_$code")
                    update(UpdateStatus("failed", failure = code))
                }
            }
        }
    }

    fun check(metadataUrl: String) = run(UpdateStatus("checking")) { cancel, update ->
        val candidate = trust.verify(PackageMetadata.parse(JSONObject(transport.metadata(metadataUrl, cancel))))
        ensure(compareVersions(candidate.version, store.activeMetadata().version) >= 0, "downgrade_blocked")
        cancel.check()
        update(UpdateStatus("candidate", candidate))
    }

    fun download(candidate: PackageMetadata) = run(UpdateStatus("downloading", candidate)) { cancel, update ->
        trust.verify(candidate); store.reserveSpace()
        ensure(compareVersions(candidate.version, store.activeMetadata().version) >= 0, "downgrade_blocked")
        val temporary = store.downloadFile()
        try {
            transport.download(candidate, temporary, cancel) { bytes, total ->
                update(UpdateStatus("downloading", candidate, downloaded = bytes, total = total))
            }
            cancel.check(); update(UpdateStatus("verifying", candidate))
            val bundle = store.install(temporary, candidate, cancel::check)
            cancel.check(); diagnostics.record("update_verified")
            update(UpdateStatus("ready", bundle.metadata, bundle.metadata.id))
        } finally { temporary.delete() }
    }

    fun apply(id: String, complete: () -> Unit) = run(UpdateStatus("applying", status.candidate, id)) { cancel, update ->
        cancel.check()
        store.activate(id)
        diagnostics.record("update_applied")
        update(UpdateStatus("applied"))
        main.post { if (!closed) { currentVersion = store.activeMetadata().version; complete() } }
    }

    fun cancel() { if (status.kind in setOf("checking", "downloading", "verifying")) cancellation?.cancel() }
    override fun close() { closed = true; listener = null; cancellation?.cancel(); executor.shutdown() }
}
