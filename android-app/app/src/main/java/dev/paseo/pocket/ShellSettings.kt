package dev.paseo.pocket

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
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
            else -> error("Unknown shell settings section")
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
            .setItems(arrayOf("清理临时资源缓存", "查看有限诊断", "网页引擎与更新", "开源许可")) { _, which ->
                when (which) {
                    0 -> MaterialAlertDialogBuilder(activity).setTitle("清理 App 共用资源缓存？")
                        .setMessage("保留已安装页面、Cookie、主机配对及网页本地数据。当前页面不会刷新。")
                        .setNegativeButton("取消", null).setPositiveButton("清理") { _, _ ->
                            if (!session().destroyed) session().webView.clearCache(true)
                            diagnostics.record("cache_cleared")
                        }.show()
                    1 -> diagnosticInfo()
                    2 -> engineInfo()
                    else -> {
                        val text = activity.assets.open("legal/Paseo-0.12.0.txt").bufferedReader().use { it.readText() }
                        MaterialAlertDialogBuilder(activity).setTitle("Paseo · Apache 2.0")
                            .setMessage(text).setPositiveButton("返回", null).show()
                    }
                }
            }.setNegativeButton("返回", null).show()
    }

    private fun engineInfo() {
        val provider = WebViewCompat.getCurrentWebViewPackage(activity)
        val label = provider?.applicationInfo?.loadLabel(activity.packageManager)?.toString() ?: "系统 WebView"
        MaterialAlertDialogBuilder(activity).setTitle("网页引擎")
            .setMessage("$label\n${provider?.versionName ?: "版本不可用"}\n${provider?.packageName ?: ""}\n\nApp 跟随 Android 选择的 WebView。可在系统开发者选项的 WebView 实现中选择系统允许的引擎。切换会影响其他使用 WebView 的 App，并可能重启当前 App；请先处理未发送内容。")
            .setPositiveButton("更新引擎") { _, _ ->
                val name = provider?.packageName ?: "com.google.android.webview"
                val uri = if (name.startsWith("com.google.")) Uri.parse("https://play.google.com/store/apps/details?id=$name")
                    else Uri.parse("package:$name")
                openSystem(Intent(if (uri.scheme == "package") Settings.ACTION_APPLICATION_DETAILS_SETTINGS else Intent.ACTION_VIEW, uri))
            }
            .setNeutralButton("系统设置") { _, _ -> openSystem(Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)) }
            .setNegativeButton("返回", null).show()
    }

    private fun openSystem(intent: Intent) {
        try { activity.startActivity(intent) }
        catch (_: android.content.ActivityNotFoundException) { Toast.makeText(activity, "请在系统设置中查看 WebView 实现", Toast.LENGTH_LONG).show() }
    }

    private fun diagnosticInfo() {
        val text = "Paseo Pocket ${AppVersion.name}\nPaseo ${session().bundle.version}\nAndroid API ${android.os.Build.VERSION.SDK_INT}\n" +
            "WebView ${WebViewCompat.getCurrentWebViewPackage(activity)?.let { "${it.packageName} ${it.versionName}" } ?: "不可用"}\n\n" + diagnostics.snapshot()
        MaterialAlertDialogBuilder(activity).setTitle("有限诊断（无会话内容）").setMessage(text)
            .setNegativeButton("返回", null).setPositiveButton("复制") { _, _ ->
                activity.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Paseo Pocket diagnostics", text))
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
