package dev.paseo.pocket

import android.os.Bundle
import android.content.Context
import android.content.res.Configuration
import android.content.ActivityNotFoundException
import android.graphics.Color
import android.graphics.Rect
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.view.Gravity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.graphics.Insets
import com.google.android.material.button.MaterialButton
import dev.paseo.pocket.updates.PageUpdates
import dev.paseo.pocket.updates.UpdateUi
import dev.paseo.pocket.observation.ObservationController
import dev.paseo.pocket.observation.BackgroundPolicy
import dev.paseo.pocket.appupdates.AppUpdates
import dev.paseo.pocket.appupdates.AppUpdateUi

class MainActivity : AppCompatActivity() {
    private lateinit var session: WebSession
    private var sheet: ToolSheet? = null
    private lateinit var root: FrameLayout
    private lateinit var tool: FloatingTool
    private lateinit var page: FrameLayout
    private lateinit var prefs: ShellPreferences
    private lateinit var diagnostics: Diagnostics
    private lateinit var observation: ObservationController
    private lateinit var background: BackgroundPolicy
    private val lifecycleHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private lateinit var settings: ShellSettings
    private lateinit var updates: PageUpdates
    private lateinit var updateUi: UpdateUi
    private lateinit var appUpdates: AppUpdates
    private lateinit var appUpdateUi: AppUpdateUi
    private var saveCallback: ((Uri?) -> Unit)? = null
    private val savePicker = registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val callback = saveCallback; saveCallback = null; callback?.invoke(uri)
    }
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        fileCallback = null
    }
    private val installPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (::appUpdateUi.isInitialized) appUpdateUi.permissionReturned()
    }
    private var imeVisible = false
    private var recoveryVisible = false
    private var resumedAfterMs: Long? = null
    companion object { private var processStarted = false }
    override fun attachBaseContext(newBase: Context) {
        // AppCompat wraps the Activity context here. Restore the saved mode before
        // that wrapper and the first WebView resolve their initial theme.
        ShellSettings.applyAppearance(ShellPreferences(newBase).appearance)
        super.attachBaseContext(newBase)
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        prefs = ShellPreferences(this)
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        diagnostics = Diagnostics(this)
        diagnostics.record(if (!processStarted) "process_started" else "activity_recreated")
        processStarted = true
        if (savedInstanceState != null) diagnostics.record("activity_restored")
        observation = ObservationController(diagnostics)
        background = BackgroundPolicy(android.os.SystemClock::elapsedRealtime, { delay, action ->
            val runnable = Runnable(action)
            lifecycleHandler.postDelayed(runnable, delay)
            val cancel: () -> Unit = { lifecycleHandler.removeCallbacks(runnable) }
            cancel
        }, pause = {
            if (::session.isInitialized && !session.destroyed) session.webView.pauseTimers()
        }, resume = {
            if (::session.isInitialized && !session.destroyed) session.webView.resumeTimers()
        }, diagnostics::record)
        updates = PageUpdates(this, diagnostics)
        updateUi = UpdateUi(this, updates, { prefs.updateUrl(updates.trust.officialUrl) },
            reload = { session.destroy(); createSession(); session.start() },
            changed = { sheet?.refreshSummary() }, sourceName = { if (prefs.customSource) "自定义" else "官方" })
        appUpdates = AppUpdates(this, diagnostics, gate = updates.gate)
        appUpdateUi = AppUpdateUi(this, appUpdates, permission = { installPermission.launch(it) },
            changed = { sheet?.refreshSummary() }, openWeb = ::showWebUpdates)
        root = FrameLayout(this)
        page = FrameLayout(this)
        root.addView(page, FrameLayout.LayoutParams(-1, -1))
        createSession()
        settings = ShellSettings(this, prefs, { session }, diagnostics, observation, ::updateSystemAppearance)
        tool = FloatingTool(this, prefs, ::showTools)
        root.addView(tool)
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val gestures = insets.getInsets(WindowInsetsCompat.Type.systemGestures())
            val navigation = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            val guard = DockGeometry.legacyGestureGuard(android.os.Build.VERSION.SDK_INT, gestures.left, gestures.right,
                navigation.bottom, resources.displayMetrics.density)
            imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
            page.setPadding(safe.left, safe.top, safe.right, maxOf(safe.bottom, ime.bottom))
            root.post { tool.updateBounds(Rect(safe.left, safe.top, root.width - safe.right,
                root.height - maxOf(safe.bottom, ime.bottom)), imeVisible, guard) }
            // The native container already reserves these areas. Passing them to WebView
            // would also expose CSS env(safe-area-inset-*), doubling the page's padding.
            WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(), Insets.NONE)
                .setInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(), Insets.NONE)
                .setDisplayCutout(null)
                .build()
        }
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> ViewCompat.requestApplyInsets(root) }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    imeVisible -> WindowInsetsControllerCompat(window, root).hide(WindowInsetsCompat.Type.ime())
                    sheet?.isShowing == true -> sheet?.dismiss()
                    !session.destroyed && session.webView.canGoBack() -> session.webView.goBack()
                    else -> moveTaskToBack(true)
                }
            }
        })
        updateSystemAppearance()
        session.start()
    }

    private fun showTools() {
        if (sheet?.isShowing == true) return
        WindowInsetsControllerCompat(window, root).hide(WindowInsetsCompat.Type.ime())
        tool.visibility = android.view.View.INVISIBLE
        sheet = ToolSheet(this, prefs, updates, settings, updateUi, appUpdateUi).also { panel ->
            panel.setOnDismissListener {
                sheet = null
                tool.visibility = android.view.View.VISIBLE
                tool.updateGestureExclusion()
            }
            panel.show()
        }
    }

    private fun showWebUpdates() { showTools(); sheet?.openWebUpdates() }

    private fun createSession() {
        recoveryVisible = false
        page.removeAllViews()
        session = WebSession(this, prefs, diagnostics, observation, ::showRecovery, updates.store.activeDirectory(), chooseSave = { name, callback ->
            if (saveCallback != null) callback(null) else { saveCallback = callback; try { savePicker.launch(name) } catch (_: ActivityNotFoundException) { saveCallback = null; callback(null) } }
        }) { callback, params ->
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            try { filePicker.launch(params.createIntent()); true }
            catch (_: ActivityNotFoundException) {
                fileCallback?.onReceiveValue(null); fileCallback = null
                diagnostics.record("file_picker_unavailable"); true
            }
        }
        page.addView(session.webView, FrameLayout.LayoutParams(-1, -1))
        background.pageReplaced()
    }

    private fun showRecovery(reason: String) {
        if (isFinishing || isDestroyed || recoveryVisible) return
        recoveryVisible = true
        fileCallback?.onReceiveValue(null); fileCallback = null
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setPadding(40, 40, 40, 40)
            setBackgroundColor(if (isDark()) Color.rgb(18, 22, 20) else Color.rgb(247, 248, 245))
        }
        content.addView(TextView(this).apply {
            text = when (reason) { "renderer_gone" -> "网页渲染进程已退出"; "webview_too_old" -> "系统 WebView 版本过旧"; else -> "本地页面加载失败" }
            textSize = 22f; gravity = Gravity.CENTER
        })
        content.addView(TextView(this).apply {
            text = if (reason == "webview_too_old") "请更新系统 WebView 至 Chromium 100 或以上，再重新打开页面。建议使用系统可用的最新版本。"
                else "配对数据仍保留。重新打开页面后请检查会话状态。"
            gravity = Gravity.CENTER
        })
        if (reason == "webview_too_old") content.addView(MaterialButton(this).apply {
            text = "更新系统 WebView"
            setOnClickListener {
                val provider = androidx.webkit.WebViewCompat.getCurrentWebViewPackage(this@MainActivity)?.packageName
                val uri = if (provider?.startsWith("com.google.") == true)
                    Uri.parse("https://play.google.com/store/apps/details?id=$provider")
                    else Uri.parse("package:${provider ?: "com.google.android.webview"}")
                val action = if (uri.scheme == "package") android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS else android.content.Intent.ACTION_VIEW
                runCatching { startActivity(android.content.Intent(action, uri)) }
            }
        })
        content.addView(MaterialButton(this).apply {
            text = "重新打开页面"
            setOnClickListener {
                session.destroy(); createSession(); session.start()
                diagnostics.record("page_reopened_manually")
            }
        })
        page.addView(content, FrameLayout.LayoutParams(-1, -1))
    }

    private fun isDark() = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    private fun updateSystemAppearance() {
        if (!::root.isInitialized) return
        // AppCompat can deliver uiMode without recreating this Activity. Re-resolve the
        // DayNight theme so WebView sees the matching framework isLightTheme attribute.
        theme.applyStyle(R.style.Theme_PaseoPocket, true)
        if (::session.isInitialized && !session.destroyed)
            session.webView.dispatchConfigurationChanged(Configuration(resources.configuration))
        val dark = isDark()
        root.setBackgroundColor(ShellUi.color(this, R.color.shell_background))
        if (::tool.isInitialized) tool.refreshAppearance()
        sheet?.refreshAppearance()
        WindowInsetsControllerCompat(window, root).apply {
            isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark
        }
    }
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        updateSystemAppearance()
        if (::root.isInitialized) ViewCompat.requestApplyInsets(root)
    }

    override fun onStart() {
        super.onStart()
        resumedAfterMs = background.foreground()
    }
    override fun onResume() {
        super.onResume()
        if (::session.isInitialized && !session.destroyed) { session.webView.resumeTimers(); session.webView.onResume() }
        observation.foreground(true, resumedAfterMs)
        appUpdateUi.foreground(true)
        resumedAfterMs = null
    }
    override fun onPause() {
        appUpdateUi.foreground(false)
        observation.foreground(false)
        if (::session.isInitialized && !session.destroyed) session.webView.onPause()
        super.onPause()
    }
    override fun onStop() { background.background(); super.onStop() }
    override fun onDestroy() {
        saveCallback?.invoke(null); saveCallback = null
        if (::background.isInitialized) background.close()
        sheet?.dismiss(); fileCallback?.onReceiveValue(null); fileCallback = null
        if (::session.isInitialized) session.destroy()
        if (::observation.isInitialized) observation.close()
        if (::updateUi.isInitialized) updateUi.close()
        if (::updates.isInitialized) updates.close()
        if (::appUpdateUi.isInitialized) appUpdateUi.close()
        if (::appUpdates.isInitialized) appUpdates.close()
        if (::diagnostics.isInitialized) diagnostics.close()
        super.onDestroy()
    }
}
