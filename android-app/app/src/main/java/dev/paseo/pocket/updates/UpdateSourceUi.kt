package dev.paseo.pocket.updates

import android.text.InputType
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import dev.paseo.pocket.ShellPreferences
import dev.paseo.pocket.R
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout

class UpdateSourceUi(private val activity: AppCompatActivity, private val prefs: ShellPreferences, private val updates: PageUpdates) {
    fun show() {
        if (updates.status.kind in setOf("checking", "downloading", "verifying", "applying")) {
            MaterialAlertDialogBuilder(activity).setTitle("更新正在进行")
                .setMessage("请先在页面版本中完成或取消当前操作，再切换来源。")
                .setPositiveButton("返回", null).show()
            return
        }
        MaterialAlertDialogBuilder(activity).setTitle("更新来源")
            .setSingleChoiceItems(arrayOf("官方 · npm 发布源", "自定义 · HTTPS 更新信息"), if (prefs.customSource) 1 else 0) { dialog, which ->
                dialog.dismiss()
                if (which == 0) { prefs.customSource = false; updates.sourceChanged() }
                else editCustom()
            }.setNegativeButton("返回", null).show()
    }

    private fun editCustom() {
        val input = TextInputEditText(activity).apply {
            id = R.id.update_source_url
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true); setText(prefs.customSourceUrl)
        }
        val field = TextInputLayout(activity).apply {
            hint = "https://mirror.example/latest.json"
            addView(input, android.widget.LinearLayout.LayoutParams(-1, -2))
            val padding = (24 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding / 2, padding, 0)
        }
        val popup = MaterialAlertDialogBuilder(activity).setTitle("自定义更新信息地址")
            .setMessage("镜像必须保留官方包的签名与摘要。切换来源不会更新页面或清除主机配对。")
            .setView(field).setNegativeButton("取消", null).setPositiveButton("保存", null).create()
        popup.setOnShowListener {
            popup.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val value = input.text.toString().trim()
                try {
                    httpsUri(value)
                    prefs.customSourceUrl = value; prefs.customSource = true
                    updates.sourceChanged(); popup.dismiss()
                } catch (_: UpdateFailure) { field.error = "请输入不含登录信息和片段的 HTTPS 地址" }
            }
        }
        popup.show()
    }
}
