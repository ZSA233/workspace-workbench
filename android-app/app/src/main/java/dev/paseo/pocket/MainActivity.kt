package dev.paseo.pocket

import android.os.Bundle
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
import com.google.android.material.button.MaterialButton
import dev.paseo.pocket.updates.PageUpdates
import dev.paseo.pocket.updates.UpdateUi

class MainActivity : AppCompatActivity() {
    private lateinit var session: WebSession
    private var sheet: ToolSheet? = null
    private lateinit var root: FrameLayout
    private lateinit var page: FrameLayout
    private lateinit var prefs: ShellPreferences
    private lateinit var diagnostics: Diagnostics
    private lateinit var settings: ShellSettings
    private lateinit var updates: PageUpdates
    private lateinit var updateUi: UpdateUi
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        fileCallback = null
    }
    private var imeVisible = false
    override fun onCreate(savedInstanceState: Bundle?) {
        prefs = ShellPreferences(this)
        ShellSettings.applyAppearance(prefs.appearance)
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        diagnostics = Diagnostics(this)
        diagnostics.record("app_opened")
        updates = PageUpdates(this, diagnostics)
        updateUi = UpdateUi(this, updates, { updates.trust.officialUrl }) {
            session.destroy(); createSession(); session.start()
        }
        root = FrameLayout(this)
        page = FrameLayout(this)
        root.addView(page, FrameLayout.LayoutParams(-1, -1))
        createSession()
        settings = ShellSettings(this, prefs, { session }, diagnostics, ::updateSystemAppearance)
        val tool = FloatingTool(this, prefs, ::showTools)
        root.addView(tool)
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
            page.setPadding(safe.left, safe.top, safe.right, maxOf(safe.bottom, ime.bottom))
            root.post { tool.updateBounds(Rect(safe.left, safe.top, root.width - safe.right,
                root.height - maxOf(safe.bottom, ime.bottom)), imeVisible) }
            insets
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
        sheet = ToolSheet(this) { section ->
            if (section == "version") updateUi.show() else settings.show(section)
        }.also { it.show() }
    }

    private fun createSession() {
        page.removeAllViews()
        session = WebSession(this, prefs, diagnostics, ::showRecovery, updates.store.activeDirectory()) { callback, params ->
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            try { filePicker.launch(params.createIntent()); true }
            catch (_: ActivityNotFoundException) {
                fileCallback?.onReceiveValue(null); fileCallback = null
                diagnostics.record("file_picker_unavailable"); true
            }
        }
        page.addView(session.webView, FrameLayout.LayoutParams(-1, -1))
    }

    private fun showRecovery(reason: String) {
        if (isFinishing || isDestroyed) return
        fileCallback?.onReceiveValue(null); fileCallback = null
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setPadding(40, 40, 40, 40)
            setBackgroundColor(if (isDark()) Color.rgb(18, 22, 20) else Color.rgb(247, 248, 245))
        }
        content.addView(TextView(this).apply {
            text = if (reason == "renderer_gone") "网页渲染进程已退出" else "本地页面加载失败"
            textSize = 22f; gravity = Gravity.CENTER
        })
        content.addView(TextView(this).apply {
            text = "配对数据仍保留。重新打开页面后请检查会话状态。"; gravity = Gravity.CENTER
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
        val dark = isDark()
        root.setBackgroundColor(if (dark) Color.rgb(18, 22, 20) else Color.rgb(247, 248, 245))
        WindowInsetsControllerCompat(window, root).apply {
            isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark
        }
    }
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        updateSystemAppearance()
        if (::root.isInitialized) ViewCompat.requestApplyInsets(root)
    }

    override fun onResume() { super.onResume(); if (::session.isInitialized && !session.destroyed) session.webView.onResume() }
    override fun onPause() { if (::session.isInitialized && !session.destroyed) session.webView.onPause(); super.onPause() }
    override fun onDestroy() {
        sheet?.dismiss(); fileCallback?.onReceiveValue(null); fileCallback = null
        if (::session.isInitialized) session.destroy()
        if (::updateUi.isInitialized) updateUi.close()
        if (::updates.isInitialized) updates.close()
        if (::diagnostics.isInitialized) diagnostics.close()
        super.onDestroy()
    }
}
