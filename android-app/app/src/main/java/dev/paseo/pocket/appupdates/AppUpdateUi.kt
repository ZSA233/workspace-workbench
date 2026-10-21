package dev.paseo.pocket.appupdates

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import dev.paseo.pocket.R
import dev.paseo.pocket.ShellUi
import dev.paseo.pocket.updates.UpdateGate
import java.text.DateFormat
import java.util.Date
import java.util.Locale

class AppUpdateUi(private val activity: AppCompatActivity, private val updates: AppUpdates,
    private val permission: (Intent) -> Unit, private val changed: () -> Unit = {},
    private val openWeb: () -> Unit = {}) : AutoCloseable {
    private var details: TextView? = null
    private var progress: ProgressBar? = null
    private var primary: MaterialButton? = null
    private var cancel: MaterialButton? = null
    private var blocking: TextView? = null
    private var otherButton: MaterialButton? = null
    private var dialog: AlertDialog? = null
    private var active = false
    private var awaitingPermission = false
    private var installAfterResume = false
    private var installMessage: String? = null
    private val unsubscribe = updates.subscribe {
        if (updates.state.kind !in setOf("ready", "verifying")) installMessage = null
        render(); changed()
    }
    private val stopGate = updates.gate.subscribe { render(); changed() }
    val summary: String get() {
        val state = updates.state
        return when (state.kind) {
            "available" -> if (state.cached) "上次发现 ${state.update?.release?.version}" else "新版本 ${state.update?.release?.version}"
            "ready" -> "安装包已就绪"
            "checking" -> "正在检查应用更新"
            "downloading" -> if (state.total > 0) "正在下载 · ${(state.downloaded * 100 / state.total).coerceIn(0, 100)}%" else "正在下载 APK"
            "verifying" -> "正在校验安装包"
            else -> if (state.cached && state.update != null) "上次发现 ${state.update.release.version}" else "Pocket ${updates.installed.version}"
        }
    }
    fun content(context: Context): View {
        detach()
        return ShellUi.column(context).apply {
            ShellUi.add(this, ShellUi.text(context, "更新 Paseo Pocket 安卓应用，需要通过系统安装。安装会结束当前应用进程，请先处理未发送内容。", 12f, muted = true))
            details = ShellUi.text(context, "").also { it.id = R.id.app_update_status; ShellUi.add(this, it) }
            blocking = ShellUi.text(context, "网页更新正在进行，请先完成或取消该操作。", 12f, muted = true).also { ShellUi.add(this, it) }
            otherButton = ShellUi.button(context, "前往网页更新", action = openWeb).also { ShellUi.add(this, it) }
            progress = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).also { ShellUi.add(this, it) }
            primary = ShellUi.button(context, "检查应用更新", primary = true, action = ::primaryAction).also { ShellUi.add(this, it) }
            cancel = ShellUi.button(context, "取消操作") { updates.cancel() }.also { ShellUi.add(this, it) }
            ShellUi.add(this, MaterialSwitch(context).apply {
                text = "自动检查应用更新"; textSize = 14f; isChecked = updates.automatic
                setOnCheckedChangeListener { _, checked -> updates.setAutomatic(checked) }
            })
            ShellUi.add(this, ShellUi.text(context, "回到前台时每 24 小时最多检查一次；仅提示版本，下载和安装由你确认。", 12f, muted = true))
            ShellUi.add(this, ShellUi.button(context, "在 GitHub 查看发布") {
                openExternal(updates.state.update?.release?.page(updates.client.policy.repository) ?: updates.client.policy.releasesPage)
            })
            render()
        }
    }
    fun foreground(value: Boolean) {
        active = value; updates.foreground(value)
        if (value && installAfterResume) { installAfterResume = false; requestInstall() }
        if (!value) { dialog?.dismiss(); dialog = null }
    }
    private fun primaryAction() {
        if (updates.gate.blocked(UpdateGate.Target.APP)) return
        installMessage = null
        val state = updates.state
        when (state.kind) {
            "available" -> state.update?.let(updates::download)
            "ready" -> {
                dialog = MaterialAlertDialogBuilder(activity).setTitle("安装 Pocket ${state.update?.release?.version}？")
                    .setMessage("安装会结束当前应用进程。请先处理尚未发送的内容，主机配对和设置会保留，随后由 Android 确认安装。")
                    .setNegativeButton("稍后", null).setPositiveButton("继续安装") { _, _ -> requestInstall() }.show()
            }
            else -> updates.check()
        }
    }
    private fun requestInstall() {
        if (!active || updates.gate.blocked(UpdateGate.Target.APP)) return
        if (!activity.packageManager.canRequestPackageInstalls()) {
            awaitingPermission = true
            try { permission(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))) }
            catch (_: android.content.ActivityNotFoundException) { awaitingPermission = false; installMessage = "请在系统设置中允许 Pocket 安装应用，再重试。"; render() }
            return
        }
        updates.verifyForInstall { file ->
            try {
                activity.startActivity(InstallIntent.create(activity, file))
                installMessage = "已交给系统安装。若取消安装，可稍后重试；实际版本以下次启动时显示的版本为准。"
                render()
            }
            catch (_: android.content.ActivityNotFoundException) { installMessage = "没有可用的系统安装器，可从 GitHub 手动下载安装。"; render() }
            catch (_: SecurityException) { installMessage = "系统没有允许此次安装，请确认安装权限后重试。"; render() }
        }
    }
    fun permissionReturned() {
        if (!awaitingPermission) return
        awaitingPermission = false
        if (activity.packageManager.canRequestPackageInstalls()) {
            if (active) requestInstall() else installAfterResume = true
        } else { installMessage = "尚未允许安装应用；下载的安装包已保留，可稍后重试。"; render() }
    }
    private fun openExternal(address: String) {
        try { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(address))) }
        catch (_: android.content.ActivityNotFoundException) { installMessage = "没有可用的浏览器。"; render() }
    }
    private fun render() {
        val state = updates.state
        val cache = if (state.cached && state.update != null) "\n上次确认的版本：${state.update.release.version}（缓存信息，不代表已检查到最新）" else ""
        val note = when (state.kind) {
            "restoring" -> "正在核对已下载的安装包…"
            "checking" -> "正在检查 Pocket 正式版…"
            "available" -> "新版本 ${state.update?.release?.version} · ${mb(state.update?.release?.apkBytes ?: 0)} MB\n\n${state.update?.release?.notes.orEmpty()}"
            "up_to_date" -> "本次检查未发现更新的 Pocket 正式版。"
            "downloading" -> "正在下载 APK：${mb(state.downloaded)} MB" + if (state.total > 0) " / ${mb(state.total)} MB" else ""
            "verifying" -> "正在校验安装包、版本和签名身份…"
            "ready" -> "Pocket ${state.update?.release?.version} 已下载并核对，等待系统安装。"
            "cancelled" -> "已取消，可重新检查。"
            "failed" -> errorText(state.failure)
            else -> "从 GitHub 检查 Pocket 正式发布。"
        }
        details?.text = "当前应用：Pocket ${updates.installed.version}（${updates.installed.code}）\n" +
            "APK 来源：GitHub · ${updates.client.policy.repository}\n" +
            "上次尝试：${time(updates.lastAttempt)}\n上次成功检查：${time(updates.lastChecked)}\n\n${installMessage ?: note}$cache"
        val busy = state.kind in setOf("restoring", "checking", "downloading", "verifying")
        val blocked = updates.gate.blocked(UpdateGate.Target.APP)
        blocking?.visibility = if (blocked) View.VISIBLE else View.GONE
        otherButton?.visibility = if (blocked) View.VISIBLE else View.GONE
        progress?.apply {
            visibility = if (busy) View.VISIBLE else View.GONE
            isIndeterminate = state.kind != "downloading" || state.total <= 0
            if (!isIndeterminate) { max = 1000; progress = (state.downloaded * 1000 / state.total).toInt().coerceIn(0, 1000) }
        }
        primary?.apply {
            isEnabled = !busy && !blocked; alpha = if (isEnabled) 1f else .5f
            text = when (state.kind) { "available" -> "下载 APK"; "ready" -> "安装 APK"; else -> "检查应用更新" }
        }
        cancel?.visibility = if (busy && state.kind != "restoring") View.VISIBLE else View.GONE
    }
    fun detach() { details = null; progress = null; primary = null; cancel = null; blocking = null; otherButton = null }
    override fun close() { active = false; dialog?.dismiss(); unsubscribe(); stopGate(); detach() }
    companion object {
        private fun mb(bytes: Long) = String.format(Locale.ROOT, "%.1f", bytes / 1048576.0)
        private fun time(value: Long) = if (value > 0) DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(value)) else "尚未检查"
        fun errorText(code: String?): String = when (code) {
            "network_failed", "archive_truncated" -> "无法连接 GitHub 或下载中断，也可能遇到请求限额；请稍后重试或打开发布页。"
            "signer_mismatch" -> "安装包签名身份与当前应用不符，已拒绝更新。"
            "digest_mismatch", "apk_incomplete" -> "安装包摘要不符或下载不完整，已拒绝更新。"
            "apk_identity", "apk_invalid", "release_invalid" -> "发布信息或安装包身份不匹配，已拒绝更新。"
            "downgrade_blocked" -> "发布版本号未递增，已拒绝覆盖安装。"
            "android_unsupported" -> "新版本不支持当前 Android 系统。"
            "history_limit" -> "发布记录超过本次检查范围，请在 GitHub 查看 Pocket 发布。"
            "space_low" -> "存储空间不足，请清理后重试。"
            "size_limit" -> "发布信息或安装包超出大小限制，已停止下载。"
            else -> "应用更新未完成，当前 App 和配对数据保持可用。"
        }
    }
}
