package dev.paseo.pocket

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.webkit.WebViewCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder

class ShellSettings(private val activity: AppCompatActivity, private val prefs: ShellPreferences,
    private val session: () -> WebSession, private val diagnostics: Diagnostics,
    private val appearanceChanged: () -> Unit) {
    fun show(section: String) {
        when (section) {
            "appearance" -> appearance()
            "cache" -> cache()
            "source" -> MaterialAlertDialogBuilder(activity).setTitle("更新来源").setMessage("官方 npm 发布源")
                .setPositiveButton("返回", null).show()
            else -> MaterialAlertDialogBuilder(activity).setTitle("页面版本")
                .setMessage("Paseo ${session().bundle.version}\n内置完整网页 · Paseo Pocket 0.1.0")
                .setPositiveButton("返回", null).show()
        }
    }

    private fun appearance() {
        val values = listOf("system", "light", "dark")
        MaterialAlertDialogBuilder(activity).setTitle("外观")
            .setSingleChoiceItems(arrayOf("跟随系统", "明亮", "深色"), values.indexOf(prefs.appearance)) { dialog, which ->
                prefs.appearance = values[which]
                applyAppearance(prefs.appearance)
                appearanceChanged()
                diagnostics.record("appearance_changed")
                dialog.dismiss()
            }.setNegativeButton("返回", null).show()
    }

    private fun cache() {
        MaterialAlertDialogBuilder(activity).setTitle("缓存与诊断")
            .setItems(arrayOf("清理临时资源缓存", "查看有限诊断", "开源许可")) { _, which ->
                when (which) {
                    0 -> MaterialAlertDialogBuilder(activity).setTitle("清理 App 共用资源缓存？")
                        .setMessage("保留已安装页面、Cookie、主机配对及网页本地数据。当前页面不会刷新。")
                        .setNegativeButton("取消", null).setPositiveButton("清理") { _, _ ->
                            if (!session().destroyed) session().webView.clearCache(true)
                            diagnostics.record("cache_cleared")
                        }.show()
                    1 -> diagnosticInfo()
                    else -> {
                        val text = activity.assets.open("legal/Paseo-0.12.0.txt").bufferedReader().use { it.readText() }
                        MaterialAlertDialogBuilder(activity).setTitle("Paseo · Apache 2.0")
                            .setMessage(text).setPositiveButton("返回", null).show()
                    }
                }
            }.setNegativeButton("返回", null).show()
    }

    private fun diagnosticInfo() {
        val text = "Paseo Pocket 0.1.0\nPaseo ${session().bundle.version}\nAndroid API ${android.os.Build.VERSION.SDK_INT}\n" +
            "WebView ${WebViewCompat.getCurrentWebViewPackage(activity)?.versionName ?: "不可用"}\n\n" + diagnostics.snapshot()
        MaterialAlertDialogBuilder(activity).setTitle("有限诊断（无会话内容）").setMessage(text)
            .setNegativeButton("返回", null).setPositiveButton("复制") { _, _ ->
                activity.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Workbench diagnostics", text))
            }.show()
    }

    companion object {
        fun applyAppearance(value: String) = AppCompatDelegate.setDefaultNightMode(when (value) {
            "light" -> AppCompatDelegate.MODE_NIGHT_NO
            "dark" -> AppCompatDelegate.MODE_NIGHT_YES
            else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
        })
    }
}
