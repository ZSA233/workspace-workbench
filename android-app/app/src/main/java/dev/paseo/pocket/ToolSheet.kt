package dev.paseo.pocket

import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.view.ContextThemeWrapper
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import dev.paseo.pocket.updates.PageUpdates
import dev.paseo.pocket.updates.UpdateSourceUi
import dev.paseo.pocket.updates.UpdateUi

/** One native sheet. Navigating its pages never touches the WebView. */
class ToolSheet(private val activity: AppCompatActivity, private val prefs: ShellPreferences,
    private val updates: PageUpdates, private val settings: ShellSettings, private val updateUi: UpdateUi) : BottomSheetDialog(activity) {
    private val surface = ShellUi.column(context)
    private val body = ShellUi.column(context)
    private val title = ShellUi.text(context, "工具", 17f, medium = true)
    private val summaries = mutableMapOf<String, Pair<TextView, View>>()
    private var selectedPage = "tools"
    private var stopObserving: (() -> Unit)? = null
    private fun dp(n: Int) = ShellUi.dp(context, n)

    init {
        surface.id = R.id.tool_sheet
        surface.setPadding(dp(16), dp(10), dp(16), dp(20))
        ShellUi.paint(surface, R.color.shell_surface, radius = 25, topOnly = true)
        surface.addView(View(context).apply { ShellUi.paint(this, R.color.shell_line, radius = 2) },
            LinearLayout.LayoutParams(dp(32), dp(4)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(10) })
        val header = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(ShellUi.icon(context, R.drawable.ic_route), LinearLayout.LayoutParams(dp(30), dp(30)).apply { marginEnd = dp(10) })
        val heading = ShellUi.column(context).apply {
            addView(title); addView(ShellUi.text(context, "Paseo Pocket", 12f, muted = true))
        }
        header.addView(heading, LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(ImageButton(context).apply {
            setImageResource(R.drawable.ic_x); contentDescription = "关闭面板"
            setPadding(dp(12), dp(12), dp(12), dp(12))
            ShellUi.paint(this, R.color.shell_surface, R.color.shell_muted, radius = 14, ripple = true)
            setOnClickListener { dismiss() }
        }, LinearLayout.LayoutParams(dp(44), dp(44)))
        surface.addView(header, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(14) })
        surface.addView(ScrollView(context).apply {
            isFillViewport = false; clipToPadding = false
            addView(body, FrameLayout.LayoutParams(-1, -2))
        }, LinearLayout.LayoutParams(-1, -2))
        setContentView(surface)
        window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val decor = window?.decorView ?: return dismiss()
                // Before API 30 a resizing dialog can briefly resemble an IME inset.
                if (decor.findFocus() is EditText && ViewCompat.getRootWindowInsets(decor)?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
                    WindowInsetsControllerCompat(requireNotNull(window), decor).hide(WindowInsetsCompat.Type.ime())
                    body.requestFocus()
                } else if (selectedPage != "tools") navigate("tools")
                else dismiss()
            }
        })
        setOnShowListener {
            findViewById<FrameLayout>(com.google.android.material.R.id.design_bottom_sheet)?.setBackgroundColor(android.graphics.Color.TRANSPARENT)
            behavior.isFitToContents = true; behavior.skipCollapsed = true
            behavior.state = BottomSheetBehavior.STATE_EXPANDED
            window?.setDimAmount(.22f)
            refreshAppearance()
        }
        ViewCompat.setOnApplyWindowInsetsListener(surface) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val imeBottom = if (surface.findFocus() is EditText) insets.getInsets(WindowInsetsCompat.Type.ime()).bottom else 0
            // Limit the sheet, not the webpage. Scroll keeps every action reachable on short screens.
            behavior.maxHeight = (activity.resources.displayMetrics.heightPixels - bars.top - maxOf(bars.bottom, imeBottom)).coerceAtLeast(dp(96))
            insets
        }
        navigate("tools")
        stopObserving = settings.observeConnection(::refreshSummary)
    }

    private fun tile(id: String, name: String, icon: Int): View {
        val tile = ShellUi.column(context).apply {
            minimumHeight = dp(106); setPadding(dp(12), dp(15), dp(12), dp(12))
            isClickable = true; isFocusable = true
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
            ShellUi.paint(this, R.color.shell_soft, radius = 16, ripple = true)
            setOnClickListener { navigate(id) }
        }
        tile.addView(ShellUi.icon(context, icon), LinearLayout.LayoutParams(dp(21), dp(21)).apply { bottomMargin = dp(8) })
        tile.addView(ShellUi.text(context, name, medium = true).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO })
        val summary = ShellUi.text(context, "", 12f, muted = true).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        tile.addView(summary)
        summaries[id] = summary to tile
        ViewCompat.setAccessibilityDelegate(tile, object : AccessibilityDelegateCompat() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
                super.onInitializeAccessibilityNodeInfo(host, info); info.className = "android.widget.Button"
                info.text = name
                info.contentDescription = "$name，${summary.text}"
            }
        })
        return tile
    }

    fun refreshSummary() {
        if (selectedPage != "tools") return
        summaries["appearance"]?.first?.text = when (prefs.appearance) { "light" -> "明亮"; "dark" -> "深色"; else -> "跟随系统" }
        summaries["version"]?.first?.text = "${updates.currentVersion} · 手动更新"
        summaries["source"]?.first?.text = if (prefs.customSource) "自定义" else "官方"
        summaries["cache"]?.first?.text = settings.connectionSummary()
    }

    private fun navigate(page: String) {
        updateUi.detach()
        settings.detachObservation()
        body.isFocusableInTouchMode = true
        selectedPage = page; summaries.clear(); body.removeAllViews()
        title.text = when (page) { "appearance" -> "外观"; "version" -> "网页版本"; "source" -> "更新来源"; "cache" -> "连接与诊断"; else -> "工具" }
        if (page == "tools") {
            val entries = listOf(Triple("appearance", "外观", R.drawable.ic_palette), Triple("version", "网页版本", R.drawable.ic_package_check),
                Triple("source", "更新来源", R.drawable.ic_cloud_download), Triple("cache", "连接与诊断", R.drawable.ic_activity))
            for (row in entries.chunked(2)) {
                val layout = LinearLayout(context)
                row.forEachIndexed { index, (id, name, icon) ->
                    layout.addView(tile(id, name, icon), LinearLayout.LayoutParams(0, -1, 1f).apply { if (index == 0) marginEnd = dp(9) })
                }
                body.addView(layout, LinearLayout.LayoutParams(-1, -2).apply { if (body.childCount > 0) topMargin = dp(9) })
            }
            refreshSummary()
        } else {
            // A long-lived Dialog theme may predate an in-place night-mode change.
            val pageContext = ContextThemeWrapper(activity, R.style.Theme_PaseoPocket)
            val content = when (page) {
                "appearance" -> settings.appearanceContent(pageContext)
                "version" -> updateUi.content(pageContext)
                "source" -> UpdateSourceUi(activity, prefs, updates).content(pageContext, { hideKeyboard(); navigate("tools") }, { navigate("version") })
                else -> settings.cacheContent(pageContext)
            }
            body.addView(content, LinearLayout.LayoutParams(-1, -2))
            ShellUi.add(body, ShellUi.button(pageContext, "返回工具") { hideKeyboard(); navigate("tools") })
        }
        refreshAppearance()
        body.requestFocus()
    }

    private fun hideKeyboard() {
        window?.let { WindowInsetsControllerCompat(it, it.decorView).hide(WindowInsetsCompat.Type.ime()) }
    }
    fun refreshAppearance() {
        ShellUi.refresh(surface, activity)
        window?.let {
            @Suppress("DEPRECATION")
            it.navigationBarColor = ShellUi.color(activity, R.color.shell_surface)
            val dark = activity.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK == android.content.res.Configuration.UI_MODE_NIGHT_YES
            WindowInsetsControllerCompat(it, it.decorView).apply { isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark }
        }
        refreshSummary()
    }
    override fun dismiss() {
        stopObserving?.invoke(); stopObserving = null
        hideKeyboard(); updateUi.detach(); settings.detachObservation(); super.dismiss()
    }
}
