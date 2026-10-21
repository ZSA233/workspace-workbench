package dev.paseo.pocket

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.FrameLayout
import android.widget.TextView
import kotlin.math.abs

@SuppressLint("ViewConstructor")
class FloatingTool(context: Context, private val prefs: ShellPreferences, onClick: () -> Unit) : FrameLayout(context) {
    private val bounds = Rect()
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f; private var downY = 0f
    private var startX = 0f; private var startY = 0f
    private var dragging = false
    private var keyboardVisible = false
    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()

    init {
        layoutParams = LayoutParams(dp(48), dp(48))
        isClickable = true; isFocusable = true
        contentDescription = "Workbench 工具"
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        addView(TextView(context).apply {
            text = "WB"; textSize = 11f; gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.rgb(60, 83, 74)) }
            elevation = dp(3).toFloat()
        }, LayoutParams(dp(36), dp(36), Gravity.CENTER))
        setOnClickListener { onClick() }
    }

    fun updateBounds(rect: Rect, imeVisible: Boolean) {
        bounds.set(rect)
        keyboardVisible = imeVisible
        restoreDock()
    }

    private fun restoreDock() {
        val left = bounds.left + dp(4); val right = (bounds.right - dp(52)).coerceAtLeast(left)
        val top = bounds.top + dp(4); val bottom = (bounds.bottom - dp(52)).coerceAtLeast(top)
        x = if (prefs.dockRight) right.toFloat() else left.toFloat()
        y = DockGeometry.position(top.toFloat(), bottom.toFloat(), prefs.dockFraction)
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
                    x = (startX + dx).coerceIn((bounds.left + dp(4)).toFloat(), (bounds.right - dp(52)).coerceAtLeast(bounds.left + dp(4)).toFloat())
                    y = (startY + dy).coerceIn((bounds.top + dp(4)).toFloat(), (bounds.bottom - dp(52)).coerceAtLeast(bounds.top + dp(4)).toFloat())
                }
            }
            MotionEvent.ACTION_UP -> {
                parent.requestDisallowInterceptTouchEvent(false)
                if (!dragging) performClick()
                else {
                    prefs.dockRight = x + width / 2 > bounds.centerX()
                    // An IME clamp must not overwrite the position used after the keyboard closes.
                    if (!keyboardVisible) prefs.dockFraction = DockGeometry.fraction(y,
                        (bounds.top + dp(4)).toFloat(), (bounds.bottom - dp(52)).toFloat())
                    restoreDock()
                }
            }
            MotionEvent.ACTION_CANCEL -> { parent.requestDisallowInterceptTouchEvent(false); restoreDock() }
        }
        return true
    }

    override fun performClick(): Boolean { super.performClick(); return true }
}
