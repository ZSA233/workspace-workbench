package dev.paseo.pocket

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.view.View
import android.view.ViewGroup
import android.widget.CompoundButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.ColorRes
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import com.google.android.material.button.MaterialButton

/** Small native design vocabulary shared by the handle, tool pages and dialogs. */
object ShellUi {
    private data class Paint(@param:ColorRes val background: Int?, @param:ColorRes val foreground: Int?,
        val radius: Int, val topOnly: Boolean, val ripple: Boolean, val stroke: Boolean)

    fun dp(context: Context, value: Int) = (value * context.resources.displayMetrics.density + .5f).toInt()
    fun color(context: Context, @ColorRes value: Int) = ContextCompat.getColor(context, value)
    fun paint(view: View, @ColorRes background: Int? = null, @ColorRes foreground: Int? = null,
        radius: Int = 0, topOnly: Boolean = false, ripple: Boolean = false, stroke: Boolean = false) {
        view.setTag(R.id.shell_paint, Paint(background, foreground, radius, topOnly, ripple, stroke))
        refresh(view)
    }
    fun refresh(view: View, palette: Context = view.context) {
        val spec = view.getTag(R.id.shell_paint) as? Paint
        if (spec != null) {
            spec.background?.let { background ->
                val ripple = ColorStateList.valueOf(ColorUtils.setAlphaComponent(color(palette, R.color.shell_accent), 35))
                if (view is MaterialButton) {
                    view.backgroundTintList = ColorStateList.valueOf(color(palette, background))
                    view.cornerRadius = dp(palette, spec.radius)
                    view.rippleColor = ripple
                    view.elevation = 0f; view.stateListAnimator = null
                } else {
                    val shape = GradientDrawable().apply {
                        setColor(color(palette, background))
                        val r = dp(palette, spec.radius).toFloat()
                        if (spec.topOnly) cornerRadii = floatArrayOf(r,r,r,r,0f,0f,0f,0f) else cornerRadius = r
                        if (spec.stroke) setStroke(dp(palette, 1), color(palette, R.color.shell_line))
                    }
                    view.background = if (spec.ripple) RippleDrawable(ripple, shape, null) else shape
                }
            }
            spec.foreground?.let { foreground ->
                val tint = color(palette, foreground)
                when (view) {
                    is TextView -> view.setTextColor(tint)
                    is ImageView -> view.imageTintList = ColorStateList.valueOf(tint)
                }
            }
        }
        if (view is CompoundButton) view.buttonTintList = ColorStateList(
            arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
            intArrayOf(color(palette, R.color.shell_accent), color(palette, R.color.shell_muted)))
        if (view is ViewGroup) for (i in 0 until view.childCount) refresh(view.getChildAt(i), palette)
    }
    fun column(context: Context) = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    fun text(context: Context, value: String, size: Float = 14f, muted: Boolean = false, medium: Boolean = false) =
        TextView(context).apply {
            text = value; textSize = size
            includeFontPadding = false
            if (medium) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            paint(this, foreground = if (muted) R.color.shell_muted else R.color.shell_ink)
        }
    fun icon(context: Context, drawable: Int) = ImageView(context).apply {
        setImageResource(drawable)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        paint(this, foreground = R.color.shell_accent)
    }
    fun button(context: Context, label: String, primary: Boolean = false, action: () -> Unit) =
        MaterialButton(context).apply {
            text = label; textSize = 14f; isAllCaps = false
            minHeight = dp(context, 44); minimumHeight = dp(context, 44)
            insetTop = 0; insetBottom = 0; strokeWidth = 0
            setPadding(dp(context, 14), dp(context, 10), dp(context, 14), dp(context, 10))
            // The stateful native button remains responsible for focus and click semantics.
            paint(this, if (primary) R.color.shell_accent else R.color.shell_soft,
                if (primary) R.color.shell_on_accent else R.color.shell_ink, radius = 11, ripple = true)
            setOnClickListener { action() }
        }
    fun add(parent: LinearLayout, view: View, gap: Int = 10) {
        parent.addView(view, LinearLayout.LayoutParams(-1, -2).apply {
            if (parent.childCount > 0) topMargin = dp(parent.context, gap)
        })
    }
}
