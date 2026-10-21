package dev.paseo.pocket.updates

import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import java.util.Locale

class UpdateUi(private val activity: AppCompatActivity, private val updates: PageUpdates,
    private val sourceUrl: () -> String, private val reload: () -> Unit) : AutoCloseable {
    private var dialog: AlertDialog? = null
    private var details: TextView? = null
    private var progress: ProgressBar? = null

    init { updates.listener = { render(it) } }
    fun show() {
        if (dialog?.isShowing == true) return
        val padding = (24 * activity.resources.displayMetrics.density).toInt()
        val content = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL; setPadding(padding, padding / 2, padding, padding)
        }
        details = TextView(activity).also { content.addView(it) }
        progress = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).also {
            content.addView(it, LinearLayout.LayoutParams(-1, -2))
        }
        val popup = MaterialAlertDialogBuilder(activity).setTitle("页面版本").setView(content)
            .setPositiveButton("检查页面更新", null).setNegativeButton("返回", null).setNeutralButton("取消操作", null).create()
        dialog = popup
        popup.setOnShowListener {
            popup.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { primary() }
            popup.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener { updates.cancel() }
            render(updates.status)
        }
        popup.setOnDismissListener { details = null; progress = null; dialog = null }
        popup.show()
    }

    private fun primary() {
        val state = updates.status
        when (state.kind) {
            "candidate" -> state.candidate?.let(updates::download)
            "ready" -> {
                MaterialAlertDialogBuilder(activity).setTitle("应用页面更新？")
                    .setMessage("页面将重新打开。请先发送或保存尚未发送的内容。主机配对及网页本地数据会保留。")
                    .setNegativeButton("暂不应用", null).setPositiveButton("应用更新") { _, _ ->
                        state.readyId?.let { updates.apply(it) { reload(); render(updates.status) } }
                    }.show()
            }
            else -> updates.check(sourceUrl())
        }
    }

    private fun render(state: UpdateStatus) {
        val popup = dialog ?: return
        val current = updates.currentVersion
        val description = when (state.kind) {
            "checking" -> "正在检查所选来源…"
            "candidate" -> "候选版本：${state.candidate?.version}" + if (state.candidate?.version == current) "（与当前相同，可重新验证安装）" else ""
            "downloading" -> "正在下载：${mb(state.downloaded)} MB" + if (state.total > 0) " / ${mb(state.total)} MB" else ""
            "verifying" -> "正在验证签名、摘要及完整网页资源…"
            "ready" -> "${state.candidate?.version} 已验证，等待应用。"
            "applying" -> "正在切换完整页面版本…"
            "applied" -> "页面更新已应用。"
            "cancelled" -> "已取消，当前版本保持可用。"
            "failed" -> errorText(state.failure)
            else -> "仅在你点击时检查更新。"
        }
        details?.text = "Paseo $current\nPaseo Pocket 0.1.0 · 非官方客户端\n\n$description"
        val busy = state.kind in setOf("checking", "downloading", "verifying", "applying")
        progress?.apply {
            visibility = if (busy) View.VISIBLE else View.GONE
            isIndeterminate = state.kind != "downloading" || state.total <= 0
            if (!isIndeterminate) { max = 1000; progress = ((state.downloaded * 1000) / state.total).toInt() }
        }
        popup.getButton(AlertDialog.BUTTON_POSITIVE)?.apply {
            isEnabled = !busy
            text = when (state.kind) { "candidate" -> "下载并验证"; "ready" -> "应用更新"; else -> "检查页面更新" }
        }
        popup.getButton(AlertDialog.BUTTON_NEUTRAL)?.apply {
            visibility = if (busy && state.kind != "applying") View.VISIBLE else View.GONE
        }
    }

    override fun close() { dialog?.dismiss(); updates.listener = null }
    companion object {
        private fun mb(bytes: Long) = String.format(Locale.ROOT, "%.1f", bytes / 1048576.0)
        fun errorText(code: String?): String = when (code) {
            "unknown_signing_key" -> "更新使用了未知签名密钥，请先升级 APK。当前页面保持不变。"
            "signature_invalid" -> "签名校验失败，已拒绝更新。"
            "digest_mismatch", "integrity_invalid" -> "归档摘要不匹配，已拒绝更新。"
            "space_low" -> "可用空间不足，请留出至少 352 MB 再重试。"
            "network_failed", "archive_truncated" -> "下载连接失败或数据不完整，请重试。"
            "downgrade_blocked" -> "来源提供了较旧页面；为保护本地数据，已拒绝降级。"
            "unsafe_path", "archive_type", "duplicate_path", "size_limit" -> "更新归档不符合安全限制，已拒绝安装。"
            "resources_missing" -> "更新缺少必要网页资源，当前版本保持不变。"
            "invalid_url" -> "更新来源必须为不含登录信息和片段的 HTTPS 地址。"
            else -> "更新未完成。当前页面保持可用，可在诊断中查看错误代码。"
        }
    }
}
