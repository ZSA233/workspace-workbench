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
import dev.paseo.pocket.appupdates.AppUpdateUi

/** One native sheet. Navigating its pages never touches the WebView. */
class ToolSheet(private val activity: AppCompatActivity, private val prefs: ShellPreferences,
    private val updates: PageUpdates, private val settings: ShellSettings, private val updateUi: UpdateUi,
    private val appUpdateUi: AppUpdateUi) : BottomSheetDialog(activity) {
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
                } else if (selectedPage != "tools") navigate(parentPage())
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
        // Material's edge-to-edge callback retains the status-bar mode from when
        // this Dialog was created. Reapply the current theme after a page resizes
        // the sheet, once its layout callback has restored that older mode.
        surface.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            surface.post { if (isShowing) refreshSystemBars() }
        }
        navigate("tools")
        stopObserving = settings.observeConnection(::refreshSummary)
    }

    private fun tile(id: String, name: String, icon: Int): View {
        val tile = ShellUi.column(context).apply {
            if (id == "app") this.id = R.id.app_update_entry
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
        summaries["version"]?.first?.text = updateUi.summary
        summaries["app"]?.first?.text = appUpdateUi.summary
        summaries["cache"]?.first?.text = settings.connectionSummary()
    }

    fun openAppUpdates() { navigate("app") }
    fun openWebUpdates() { navigate("version") }
    private fun parentPage() = if (selectedPage == "source") "version" else "tools"

    private fun navigate(page: String) {
        updateUi.detach()
        appUpdateUi.detach()
        settings.detachObservation()
        body.isFocusableInTouchMode = true
        selectedPage = page; summaries.clear(); body.removeAllViews()
        title.text = when (page) { "appearance" -> "外观"; "version" -> "网页更新"; "source" -> "网页更新来源"; "cache" -> "连接与诊断"; "app" -> "应用升级"; else -> "工具" }
        if (page == "tools") {
            val entries = listOf(Triple("appearance", "外观", R.drawable.ic_palette), Triple("version", "网页更新", R.drawable.ic_package_check),
                Triple("app", "应用升级", R.drawable.ic_cloud_download), Triple("cache", "连接与诊断", R.drawable.ic_activity))
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
                "version" -> updateUi.content(pageContext, { navigate("source") }, ::openAppUpdates)
                "source" -> UpdateSourceUi(activity, prefs, updates).content(pageContext, { hideKeyboard(); navigate("version") }, ::openWebUpdates)
                "app" -> appUpdateUi.content(pageContext)
                else -> settings.cacheContent(pageContext)
            }
            body.addView(content, LinearLayout.LayoutParams(-1, -2))
            ShellUi.add(body, ShellUi.button(pageContext, if (page == "source") "返回网页更新" else "返回工具") {
                hideKeyboard(); navigate(parentPage())
            })
        }
        refreshAppearance()
        body.requestFocus()
    }

    private fun hideKeyboard() {
        window?.let { WindowInsetsControllerCompat(it, it.decorView).hide(WindowInsetsCompat.Type.ime()) }
    }
    fun refreshAppearance() {
        ShellUi.refresh(surface, activity)
        refreshSystemBars()
        refreshSummary()
    }
    private fun refreshSystemBars() {
        window?.let {
            @Suppress("DEPRECATION")
            it.navigationBarColor = ShellUi.color(activity, R.color.shell_surface)
            val dark = activity.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK == android.content.res.Configuration.UI_MODE_NIGHT_YES
            WindowInsetsControllerCompat(it, it.decorView).apply { isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark }
        }
    }
    override fun dismiss() {
        stopObserving?.invoke(); stopObserving = null
        hideKeyboard(); updateUi.detach(); appUpdateUi.detach(); settings.detachObservation(); super.dismiss()
    }
}
