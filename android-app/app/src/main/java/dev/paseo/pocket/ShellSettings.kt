package dev.paseo.pocket

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import android.view.View
import android.widget.RadioButton
import android.widget.RadioGroup
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.webkit.WebViewCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import dev.paseo.pocket.observation.ObservationController
import dev.paseo.pocket.observation.ObservationUi

class ShellSettings(private val activity: AppCompatActivity, private val prefs: ShellPreferences,
    private val session: () -> WebSession, private val diagnostics: Diagnostics,
    private val observation: ObservationController,
    private val appearanceChanged: () -> Unit) {
    private val observationUi = ObservationUi(observation)
    fun connectionSummary() = observationUi.summary()
    fun observeConnection(listener: () -> Unit) = observation.subscribe { if (observation.isForeground) listener() }
    fun detachObservation() = observationUi.detach()
    fun appearanceContent(context: Context): View {
        val group = RadioGroup(context)
        val options = listOf("system" to "跟随系统", "light" to "明亮", "dark" to "深色")
        val values = mutableMapOf<Int, String>()
        for ((value, label) in options) {
            val radio = RadioButton(context).apply {
                id = View.generateViewId(); text = label; textSize = 14f
                minHeight = ShellUi.dp(context, 44)
                ShellUi.paint(this, foreground = R.color.shell_ink)
            }
            values[radio.id] = value; group.addView(radio)
            if (prefs.appearance == value) group.check(radio.id)
        }
        group.setOnCheckedChangeListener { _, id ->
            val value = values.getValue(id)
            if (prefs.appearance != value) {
                prefs.appearance = value; applyAppearance(value); appearanceChanged()
                diagnostics.record("appearance_changed")
            }
        }
        return group
    }

    fun cacheContent(context: Context): View = ShellUi.column(context).apply {
        ShellUi.add(this, observationUi.content(context))
        ShellUi.add(this, ShellUi.button(context, "清理临时资源缓存") {
            MaterialAlertDialogBuilder(activity).setTitle("清理 App 共用资源缓存？")
                .setMessage("保留已安装页面、Cookie、主机配对及网页本地数据。当前页面不会刷新。")
                .setNegativeButton("取消", null).setPositiveButton("清理") { _, _ ->
                    if (!session().destroyed) session().webView.clearCache(true)
                    diagnostics.record("cache_cleared")
                }.show()
        })
        ShellUi.add(this, ShellUi.text(context, "保留主机配对、已安装页面与网页本地数据。", 12f, muted = true))
        ShellUi.add(this, ShellUi.button(context, "查看最近诊断", action = ::diagnosticInfo))
        ShellUi.add(this, ShellUi.button(context, "网页引擎与更新", action = ::engineInfo))
        ShellUi.add(this, ShellUi.button(context, "开源许可") {
            val paseo = activity.assets.open("legal/Paseo-0.12.0.txt").bufferedReader().use { it.readText() }
            val lucide = activity.resources.openRawResource(R.raw.lucide_license).bufferedReader().use { it.readText() }
            MaterialAlertDialogBuilder(activity).setTitle("开源许可")
                .setMessage("Paseo · Apache 2.0\n\n$paseo\n\nLucide Icons\n\n$lucide").setPositiveButton("返回", null).show()
        })
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
        MaterialAlertDialogBuilder(activity).setTitle("诊断报告（无会话内容）").setMessage(text)
            .setNeutralButton("分享") { _, _ ->
                activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_TEXT, text), "分享诊断"))
            }
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
