package dev.paseo.pocket

import android.os.SystemClock
import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/** A DOM file-input adapter, separate from the verified page bundle and native save bridge. */
class PocketImageInput(private val webView: WebView, private val webVersion: String,
    private val diagnostics: Diagnostics) : AutoCloseable {
    private var script: ScriptHandler? = null
    private var installed = false
    private var closed = false
    private var bucketStart = 0L
    private var bucketSize = 0
    private val events = setOf("image_input_selected", "image_input_ready", "image_input_unsupported", "image_input_unreadable",
        "image_attachment_ready", "image_attachment_unconfirmed", "image_attachment_failed")
    fun install() {
        if (webVersion !in setOf("0.12.0", "0.13.0") || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        runCatching {
            val source = webView.context.assets.open("pocket-image-input.js").bufferedReader().use { it.readText() }
            WebViewCompat.addWebMessageListener(webView, "PocketImageInputChannel", setOf(PageOrigin.BASE)) { _, data, origin, mainFrame, _ ->
                if (closed || !mainFrame || !PageOrigin.isLocal(origin.toString()) || !PageOrigin.isLocal(webView.url ?: "")) return@addWebMessageListener
                val now = SystemClock.elapsedRealtime()
                if (now - bucketStart >= 1000) { bucketStart = now; bucketSize = 0 }
                if (++bucketSize > 12) return@addWebMessageListener
                val event = runCatching { data.data }.getOrNull()
                if (event in events) diagnostics.record(event!!)
            }
            installed = true
            script = WebViewCompat.addDocumentStartJavaScript(webView,
                "window.__pocketImageInput = ($source)(${JSONObject().put("webVersion", webVersion)});", setOf(PageOrigin.BASE))
        }.onFailure { close(); diagnostics.record("image_input_adapter_unavailable") }
    }
    override fun close() {
        if (closed) return
        closed = true
        runCatching { webView.evaluateJavascript("window.__pocketImageInput?.dispose();void 0", null) }
        runCatching { script?.remove() }
        if (installed && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
            runCatching { WebViewCompat.removeWebMessageListener(webView, "PocketImageInputChannel") }
    }
}
