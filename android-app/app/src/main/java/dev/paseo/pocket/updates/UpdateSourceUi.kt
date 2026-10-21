package dev.paseo.pocket.updates

import android.content.Context
import android.text.InputType
import android.view.View
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import androidx.appcompat.app.AppCompatActivity
import dev.paseo.pocket.ShellPreferences
import dev.paseo.pocket.ShellUi
import dev.paseo.pocket.R
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout

class UpdateSourceUi(private val activity: AppCompatActivity, private val prefs: ShellPreferences, private val updates: PageUpdates) {
    private fun busy() = updates.status.kind in setOf("checking", "downloading", "verifying", "applying")
    fun content(context: Context, saved: () -> Unit, openVersion: () -> Unit): View {
        val content = ShellUi.column(context)
        if (busy()) {
            ShellUi.add(content, ShellUi.text(context, "请先完成或取消当前网页更新，再切换来源。"))
            ShellUi.add(content, ShellUi.button(context, "前往网页更新", primary = true, action = openVersion))
            return content
        }
        val group = RadioGroup(context)
        val official = RadioButton(context).apply { id = View.generateViewId(); text = "官方"; minHeight = ShellUi.dp(context, 44); ShellUi.paint(this, foreground = R.color.shell_ink) }
        val custom = RadioButton(context).apply { id = View.generateViewId(); text = "自定义"; minHeight = ShellUi.dp(context, 44); ShellUi.paint(this, foreground = R.color.shell_ink) }
        group.addView(official); group.addView(custom)
        group.check(if (prefs.customSource) custom.id else official.id)
        ShellUi.add(content, group)
        val input = TextInputEditText(context).apply {
            id = R.id.update_source_url
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true); setText(prefs.customSourceUrl); textSize = 16f
        }
        val field = TextInputLayout(context).apply {
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            val radius = ShellUi.dp(context, 10).toFloat()
            setBoxCornerRadii(radius, radius, radius, radius)
            boxStrokeColor = ShellUi.color(context, R.color.shell_accent)
            hint = "https://mirror.example/latest.json"
            addView(input, LinearLayout.LayoutParams(-1, -2))
            visibility = if (prefs.customSource) View.VISIBLE else View.GONE
        }
        group.setOnCheckedChangeListener { _, checked -> field.visibility = if (checked == custom.id) View.VISIBLE else View.GONE }
        ShellUi.add(content, field)
        ShellUi.add(content, ShellUi.text(context, "仅用于网页资源。镜像保留官方签名与摘要，保存后需手动检查网页更新。", 12f, muted = true))
        val note = ShellUi.text(context, "", 12f, muted = true).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        ShellUi.add(content, note)
        ShellUi.add(content, ShellUi.button(context, "保存", primary = true) {
            if (busy()) { note.text = "更新正在进行，请先完成或取消当前操作。" }
            else {
                val value = input.text.toString().trim()
                try {
                    if (custom.isChecked) httpsUri(value)
                    val changed = prefs.customSource != custom.isChecked || (custom.isChecked && prefs.customSourceUrl != value)
                    if (custom.isChecked) prefs.customSourceUrl = value
                    prefs.customSource = custom.isChecked
                    if (changed) updates.sourceChanged()
                    activity.currentFocus?.clearFocus()
                    saved()
                } catch (_: UpdateFailure) { field.error = "请输入不含登录信息和片段的 HTTPS 地址" }
            }
        })
        return content
    }
}
