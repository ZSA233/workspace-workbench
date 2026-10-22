package dev.paseo.pocket

import android.app.Activity
import android.content.Intent
import android.net.Uri

/** Read the system chooser's complete result, including multi-selection ClipData. */
object FileChooserResult {
    fun parse(resultCode: Int, intent: Intent?): Array<Uri>? {
        if (resultCode != Activity.RESULT_OK || intent == null) return null
        // WebView's provider parser reads only Intent.data. Android photo pickers
        // can return ClipData alone, even when the user selected just one image.
        val files = linkedSetOf<Uri>()
        intent.data?.let(files::add)
        intent.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(files::add)
        }
        return files.takeIf { it.isNotEmpty() }?.toTypedArray()
    }
}
