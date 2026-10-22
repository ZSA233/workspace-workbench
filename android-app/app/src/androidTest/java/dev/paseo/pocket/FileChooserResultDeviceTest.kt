package dev.paseo.pocket

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.WebChromeClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises Android Intent/ClipData and the installed WebView provider without launching a picker. */
@RunWith(AndroidJUnit4::class)
class FileChooserResultDeviceTest {
    private val first = Uri.parse("content://pocket-test.invalid/first.png")
    private val second = Uri.parse("content://pocket-test.invalid/second.png")
    private fun clips(vararg files: Uri) = ClipData.newRawUri("Selected images", files.first()).apply {
        files.drop(1).forEach { addItem(ClipData.Item(it)) }
    }

    @Test fun singleDataUriIsPreserved() {
        assertArrayEquals(arrayOf(first), FileChooserResult.parse(Activity.RESULT_OK, Intent().setData(first)))
    }

    @Test fun clipDataOnlySingleImageIsDelivered() {
        val result = Intent().apply { clipData = clips(first) }
        val providerCount = WebChromeClient.FileChooserParams.parseResult(Activity.RESULT_OK, result)?.size ?: 0
        val parsed = FileChooserResult.parse(Activity.RESULT_OK, result)
        // Capture the installed provider's behavior without requiring future
        // providers to retain their current ClipData-only parsing limitation.
        Log.i("PocketFileChooserQA", "result_ok=1 data_count=0 clip_count=1 provider_count=$providerCount parsed_count=${parsed?.size ?: 0}")
        assertArrayEquals(arrayOf(first), parsed)
    }

    @Test fun clipDataOnlyMultipleImagesRetainTheirOrder() {
        val result = Intent().apply { clipData = clips(first, second) }
        assertArrayEquals(arrayOf(first, second), FileChooserResult.parse(Activity.RESULT_OK, result))
    }

    @Test fun dataAndClipDataAreMergedWithoutDuplicateImages() {
        val result = Intent().setData(first).apply { clipData = clips(first, second, first) }
        assertArrayEquals(arrayOf(first, second), FileChooserResult.parse(Activity.RESULT_OK, result))
    }

    @Test fun cancellationAndUnexpectedResultCodesDoNotDeliverUris() {
        val result = Intent().setData(first).apply { clipData = clips(second) }
        assertNull(FileChooserResult.parse(Activity.RESULT_CANCELED, result))
        assertNull(FileChooserResult.parse(Activity.RESULT_FIRST_USER, result))
    }

    @Test fun absentResultAndItemsWithoutUrisResolveCancellation() {
        assertNull(FileChooserResult.parse(Activity.RESULT_OK, null))
        assertNull(FileChooserResult.parse(Activity.RESULT_OK, Intent()))
        val textOnly = Intent().apply { clipData = ClipData.newPlainText("Not a selected file", "ignored") }
        assertNull(FileChooserResult.parse(Activity.RESULT_OK, textOnly))
    }
}
