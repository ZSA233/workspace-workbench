package dev.paseo.pocket

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import kotlin.math.abs

@SuppressLint("ViewConstructor", "RtlHardcoded") // Dock preferences refer to physical screen edges.
class FloatingTool(context: Context, private val prefs: ShellPreferences, onClick: () -> Unit) : FrameLayout(context) {
    private val bounds = Rect()
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f; private var downY = 0f
    private var startX = 0f; private var startY = 0f
    private var dragging = false
    private var keyboardVisible = false
    private var renderedDockRight: Boolean? = null
    private val mark = ShellUi.icon(context, R.drawable.ic_route)
    private val face = FrameLayout(context)
    private fun dp(n: Int) = ShellUi.dp(context, n)

    init {
        id = R.id.floating_tool
        layoutParams = LayoutParams(dp(48), dp(56))
        isClickable = true; isFocusable = true
        contentDescription = "Paseo Pocket 工具"
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        face.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        face.elevation = dp(3).toFloat()
        face.addView(mark, LayoutParams(dp(20), dp(20), Gravity.CENTER))
        addView(face, LayoutParams(dp(26), dp(52), Gravity.RIGHT or Gravity.CENTER_VERTICAL))
        setOnClickListener { onClick() }
        refreshAppearance()
    }

    fun refreshAppearance() {
        renderedDockRight = prefs.dockRight
        val r = dp(16).toFloat()
        face.background = GradientDrawable().apply {
            setColor(ShellUi.color(context, R.color.shell_surface))
            setStroke(dp(1), ShellUi.color(context, R.color.shell_line))
            cornerRadii = if (prefs.dockRight) floatArrayOf(r,r,0f,0f,0f,0f,r,r)
                else floatArrayOf(0f,0f,r,r,r,r,0f,0f)
        }
        val gravity = (if (prefs.dockRight) Gravity.RIGHT else Gravity.LEFT) or Gravity.CENTER_VERTICAL
        if ((face.layoutParams as LayoutParams).gravity != gravity) {
            face.layoutParams = (face.layoutParams as LayoutParams).apply { this.gravity = gravity }
        }
        ShellUi.refresh(mark)
    }

    fun updateBounds(rect: Rect, imeVisible: Boolean) {
        bounds.set(rect); keyboardVisible = imeVisible
        restoreDock()
    }

    private fun restoreDock() {
        val left = bounds.left; val right = (bounds.right - dp(48)).coerceAtLeast(left)
        val top = bounds.top + dp(4); val bottom = (bounds.bottom - dp(60)).coerceAtLeast(top)
        x = if (prefs.dockRight) right.toFloat() else left.toFloat()
        y = DockGeometry.position(top.toFloat(), bottom.toFloat(), prefs.dockFraction)
        if (renderedDockRight != prefs.dockRight) refreshAppearance()
        updateGestureExclusion()
    }

    fun updateGestureExclusion() {
        if (Build.VERSION.SDK_INT >= 29) ViewCompat.setSystemGestureExclusionRects(this,
            if (isShown) listOf(Rect(0, 0, dp(48), dp(56))) else emptyList())
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.rawX; downY = event.rawY; startX = x; startY = y; dragging = false
                parent.requestDisallowInterceptTouchEvent(true)
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = event.rawX - downX; val dy = event.rawY - downY
                if (abs(dx) > slop || abs(dy) > slop) dragging = true
                if (dragging) {
                    x = (startX + dx).coerceIn(bounds.left.toFloat(), (bounds.right - dp(48)).coerceAtLeast(bounds.left).toFloat())
                    y = (startY + dy).coerceIn((bounds.top + dp(4)).toFloat(), (bounds.bottom - dp(60)).coerceAtLeast(bounds.top + dp(4)).toFloat())
                }
            }
            MotionEvent.ACTION_UP -> {
                parent.requestDisallowInterceptTouchEvent(false)
                if (!dragging) performClick()
                else {
                    prefs.dockRight = x + width / 2 > bounds.centerX()
                    // IME bounds must never overwrite the dock used after the keyboard closes.
                    if (!keyboardVisible) prefs.dockFraction = DockGeometry.fraction(y,
                        (bounds.top + dp(4)).toFloat(), (bounds.bottom - dp(60)).toFloat())
                    restoreDock()
                }
            }
            MotionEvent.ACTION_CANCEL -> { parent.requestDisallowInterceptTouchEvent(false); dragging = false; restoreDock() }
        }
        return true
    }
    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        updateGestureExclusion()
    }
    override fun performClick(): Boolean { super.performClick(); return true }
}
