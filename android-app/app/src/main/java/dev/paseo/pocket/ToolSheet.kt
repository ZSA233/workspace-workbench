package dev.paseo.pocket

import android.content.Context
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton

class ToolSheet(context: Context, onSelect: (String) -> Unit) : BottomSheetDialog(context) {
    init {
        val pad = (20 * context.resources.displayMetrics.density).toInt()
        val content = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        content.addView(TextView(context).apply { text = "Paseo Pocket"; textSize = 22f; gravity = Gravity.START })
        for ((id, label) in listOf("appearance" to "外观", "version" to "页面版本",
            "source" to "更新来源", "cache" to "缓存与诊断")) {
            content.addView(MaterialButton(context, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = label
                setOnClickListener { dismiss(); onSelect(id) }
            }, LinearLayout.LayoutParams(-1, -2))
        }
        setContentView(content)
    }
}
