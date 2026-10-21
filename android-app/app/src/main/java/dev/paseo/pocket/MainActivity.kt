package dev.paseo.pocket

import android.os.Bundle
import android.graphics.Rect
import android.view.View
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder

class MainActivity : AppCompatActivity() {
    private lateinit var session: WebSession
    private var sheet: ToolSheet? = null
    private lateinit var root: FrameLayout
    private var imeVisible = false
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val prefs = ShellPreferences(this)
        session = WebSession(this, prefs)
        root = FrameLayout(this)
        val page = FrameLayout(this)
        page.addView(session.webView, FrameLayout.LayoutParams(-1, -1))
        root.addView(page, FrameLayout.LayoutParams(-1, -1))
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
                    session.webView.canGoBack() -> session.webView.goBack()
                    else -> moveTaskToBack(true)
                }
            }
        })
        session.start()
    }

    private fun showTools() {
        if (sheet?.isShowing == true) return
        sheet = ToolSheet(this) { section ->
            MaterialAlertDialogBuilder(this).setTitle(when (section) {
                "appearance" -> "外观"
                "version" -> "页面版本 · ${session.bundle.version}"
                "source" -> "更新来源"
                else -> "缓存与诊断"
            }).setMessage("Paseo Pocket").setPositiveButton("返回", null).show()
        }.also { it.show() }
    }

    override fun onResume() { super.onResume(); if (::session.isInitialized) session.webView.onResume() }
    override fun onPause() { if (::session.isInitialized) session.webView.onPause(); super.onPause() }
    override fun onDestroy() { sheet?.dismiss(); if (::session.isInitialized) session.destroy(); super.onDestroy() }
}
