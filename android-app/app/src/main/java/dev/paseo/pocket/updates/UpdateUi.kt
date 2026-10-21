package dev.paseo.pocket.updates

import android.content.Context
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import dev.paseo.pocket.R
import dev.paseo.pocket.ShellUi
import java.util.Locale

/** The worker outlives its visible page; detached pages retain no native views. */
class UpdateUi(private val activity: AppCompatActivity, private val updates: PageUpdates,
    private val sourceUrl: () -> String, private val reload: () -> Unit,
    private val changed: () -> Unit = {}, private val sourceName: () -> String = { "官方" }) : AutoCloseable {
    private var details: TextView? = null
    private var progress: ProgressBar? = null
    private var primaryButton: MaterialButton? = null
    private var cancelButton: MaterialButton? = null
    private var sourceButton: MaterialButton? = null
    private var otherButton: MaterialButton? = null
    private var blocking: TextView? = null
    private var confirmation: AlertDialog? = null
    private val stopGate = updates.gate.subscribe { render(updates.status); changed() }

    val summary: String get() {
        val state = updates.status
        return when (state.kind) {
            "checking" -> "正在检查网页更新"
            "downloading" -> if (state.total > 0) "正在下载 · ${state.downloaded * 100 / state.total}%" else "正在下载网页资源"
            "verifying" -> "正在校验网页资源"
            "ready" -> "等待切换网页版本"
            "applying" -> "正在切换网页版本"
            else -> "网页 ${updates.currentVersion} · 手动更新"
        }
    }
    init { updates.listener = { render(it); changed() } }
    fun content(context: Context, openSource: () -> Unit, openApp: () -> Unit): View {
        detach()
        return ShellUi.column(context).apply {
            ShellUi.add(this, ShellUi.text(context, "只更新内置网页资源。切换版本会重新打开网页，无需安装 APK。", 12f, muted = true))
            details = ShellUi.text(context, "").also { it.id = R.id.web_update_status; ShellUi.add(this, it) }
            blocking = ShellUi.text(context, "应用升级正在进行，请先完成或取消该操作。", 12f, muted = true).also { ShellUi.add(this, it) }
            otherButton = ShellUi.button(context, "前往应用升级", action = openApp).also { ShellUi.add(this, it) }
            progress = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).also { ShellUi.add(this, it) }
            primaryButton = ShellUi.button(context, "检查网页更新", primary = true, action = ::primary).also { ShellUi.add(this, it) }
            cancelButton = ShellUi.button(context, "取消操作") { updates.cancel() }.also { ShellUi.add(this, it) }
            sourceButton = ShellUi.button(context, "网页更新来源", action = openSource).also { ShellUi.add(this, it) }
            render(updates.status)
        }
    }
    private fun primary() {
        if (updates.gate.blocked(UpdateGate.Target.WEB)) return
        val state = updates.status
        when (state.kind) {
            "candidate" -> state.candidate?.let(updates::download)
            "ready" -> confirmation = MaterialAlertDialogBuilder(activity).setTitle("切换网页版本？")
                .setMessage("网页将重新打开。请先处理尚未发送的内容。主机配对及网页本地数据会保留。")
                .setNegativeButton("暂不切换", null).setPositiveButton("切换网页版本") { _, _ ->
                    state.readyId?.let { updates.apply(it) { reload(); render(updates.status); changed() } }
                }.show()
            else -> updates.check(sourceUrl())
        }
    }
    private fun render(state: UpdateStatus) {
        val current = updates.currentVersion
        val description = when (state.kind) {
            "checking" -> "正在检查所选网页来源…"
            "candidate" -> "候选网页版本：${state.candidate?.version}" + if (state.candidate?.version == current) "（与当前相同，可重新验证）" else ""
            "downloading" -> "正在下载网页资源：${mb(state.downloaded)} MB" + if (state.total > 0) " / ${mb(state.total)} MB" else ""
            "verifying" -> "正在验证签名、摘要及完整网页资源…"
            "ready" -> "网页 ${state.candidate?.version} 已验证，等待切换网页版本。"
            "applying" -> "正在切换网页版本…"
            "applied" -> "网页版本已切换。"
            "cancelled" -> "已取消，当前网页版本保持可用。"
            "failed" -> errorText(state.failure)
            else -> "仅在你点击时检查网页更新。"
        }
        details?.text = "当前网页：Paseo $current\n网页更新来源：${sourceName()}\n\n$description"
        val busy = state.kind in setOf("checking", "downloading", "verifying", "applying")
        val blocked = updates.gate.blocked(UpdateGate.Target.WEB)
        blocking?.visibility = if (blocked) View.VISIBLE else View.GONE
        otherButton?.visibility = if (blocked) View.VISIBLE else View.GONE
        progress?.apply {
            visibility = if (busy) View.VISIBLE else View.GONE
            isIndeterminate = state.kind != "downloading" || state.total <= 0
            if (!isIndeterminate) { max = 1000; progress = ((state.downloaded * 1000) / state.total).toInt().coerceIn(0, 1000) }
        }
        primaryButton?.apply {
            isEnabled = !busy && !blocked; alpha = if (isEnabled) 1f else .5f
            text = when (state.kind) { "candidate" -> "下载网页资源"; "ready" -> "切换网页版本"; else -> "检查网页更新" }
        }
        sourceButton?.isEnabled = !busy
        cancelButton?.visibility = if (busy && state.kind != "applying") View.VISIBLE else View.GONE
    }
    fun detach() {
        details = null; progress = null; primaryButton = null; cancelButton = null
        sourceButton = null; otherButton = null; blocking = null
    }
    override fun close() { confirmation?.dismiss(); detach(); updates.listener = null; stopGate() }
    companion object {
        private fun mb(bytes: Long) = String.format(Locale.ROOT, "%.1f", bytes / 1048576.0)
        fun errorText(code: String?): String = when (code) {
            "unknown_signing_key" -> "更新使用了未知签名密钥，请先升级 APK。当前网页保持不变。"
            "signature_invalid" -> "签名校验失败，已拒绝更新。"
            "digest_mismatch", "integrity_invalid" -> "归档摘要不匹配，已拒绝更新。"
            "space_low" -> "可用空间不足，请留出至少 352 MB 再重试。"
            "network_failed", "archive_truncated" -> "下载连接失败或数据不完整，请重试。"
            "downgrade_blocked" -> "来源提供了较旧网页；为保护本地数据，已拒绝降级。"
            "unsafe_path", "archive_type", "duplicate_path", "size_limit" -> "更新归档不符合安全限制，已拒绝安装。"
            "resources_missing" -> "更新缺少必要网页资源，当前版本保持不变。"
            "invalid_url" -> "更新来源必须为不含登录信息和片段的 HTTPS 地址。"
            else -> "网页更新未完成。当前网页保持可用，可在诊断中查看错误代码。"
        }
    }
}
