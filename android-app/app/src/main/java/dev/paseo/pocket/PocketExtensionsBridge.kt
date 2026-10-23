package dev.paseo.pocket

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.util.UUID

/** Owns the page extension lifetime. This channel accepts UI state, never device commands. */
class PocketExtensionsBridge(private val webView: WebView, private val bundle: WebBundle,
    private val diagnostics: Diagnostics) : AutoCloseable {
    private val token = UUID.randomUUID().toString()
    private var generation = UUID.randomUUID().toString()
    private var document: String? = null
    private var script: ScriptHandler? = null
    private var installed = false
    private var closed = false
    private var foreground = true
    private var sidebarOpen = false
    private var bucketAt = 0L
    private var bucketCount = 0
    private val handler = Handler(Looper.getMainLooper())
    private val diagnosticCodes = setOf("extension_adapter_unavailable", "extension_listener_failed", "extension_registration_invalid")

    fun install() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        val fingerprint = bundle.manifest.getJSONArray("files").let { entries ->
            (0 until entries.length()).map { entries.getJSONObject(it) }
                .find { it.optString("path") == ENTRY }?.optString("sha256")
        }
        if (bundle.version != "0.12.0" || fingerprint != SHA256) return
        runCatching {
            WebViewCompat.addWebMessageListener(webView, "PocketExtensionsChannel", setOf(PageOrigin.BASE)) { _, data, origin, mainFrame, _ ->
                if (closed || !mainFrame || !PageOrigin.isLocal(origin.toString()) || !PageOrigin.isLocal(webView.url ?: "")) return@addWebMessageListener
                val now = SystemClock.elapsedRealtime()
                if (now - bucketAt >= 1000) { bucketAt = now; bucketCount = 0 }
                if (++bucketCount > 30) return@addWebMessageListener
                val raw = runCatching { data.data }.getOrNull() ?: return@addWebMessageListener
                if (raw.length > 4096) return@addWebMessageListener
                val message = runCatching { JSONObject(raw) }.getOrNull() ?: return@addWebMessageListener
                if (message.optString("token") != token) return@addWebMessageListener
                val doc = message.optString("doc")
                if (!Regex("[a-zA-Z0-9-]{1,64}").matches(doc)) return@addWebMessageListener
                if (message.optString("type") == "hello") {
                    if (document == null) call("activate(${JSONObject.quote(doc)},${JSONObject.quote(generation)})")
                } else if (message.optString("generation") == generation) {
                    if (message.optString("type") == "activated" && document == null) {
                        document = doc; call("foreground($foreground)")
                    } else if (document == doc) when (message.optString("type")) {
                        "state" -> sidebarOpen = message.optBoolean("open")
                        "diagnostic" -> message.optString("code").takeIf { it in diagnosticCodes }?.let { diagnostics.record(it) }
                    }
                }
            }
            installed = true
            fun asset(name: String) = webView.context.assets.open(name).bufferedReader().use { it.readText() }
            val config = JSONObject().put("origin", PageOrigin.BASE).put("token", token)
                .put("webVersion", bundle.version).put("bundleSha256", fingerprint)
            val source = "window.__pocketExtensions = (${asset("pocket-extensions.js")})($config," +
                "${asset("pocket-extensions-core.js")},${asset("pocket-extensions-paseo-0.12.js")});"
            script = WebViewCompat.addDocumentStartJavaScript(webView, source, setOf(PageOrigin.BASE))
        }.onFailure { close(); diagnostics.record("extension_adapter_unavailable") }
    }

    fun pageStarted() { generation = UUID.randomUUID().toString(); document = null; sidebarOpen = false; bucketCount = 0 }
    fun foreground(value: Boolean) { foreground = value; if (document != null) call("foreground($value)") }

    /** False avoids any JS round trip when there is no overlay. */
    fun handleBack(fallback: () -> Unit): Boolean {
        if (closed || !sidebarOpen || document == null) return false
        val ticket = generation
        var finished = false
        val timeout = Runnable { if (!finished) { finished = true; if (!closed && generation == ticket) fallback() } }
        handler.postDelayed(timeout, 250)
        runCatching { webView.evaluateJavascript("window.__pocketExtensions?.handleBack() === true") { result ->
            if (finished) return@evaluateJavascript
            finished = true; handler.removeCallbacks(timeout)
            if (!closed && generation == ticket && result != "true") fallback()
        } }.onFailure { handler.removeCallbacks(timeout); if (!finished) { finished = true; fallback() } }
        return true
    }

    private fun call(command: String) {
        if (!closed) runCatching { webView.evaluateJavascript("window.__pocketExtensions?.$command;void 0", null) }
    }
    override fun close() {
        if (closed) return
        call("dispose()")
        closed = true; sidebarOpen = false; document = null; handler.removeCallbacksAndMessages(null)
        runCatching { script?.remove() }
        if (installed) runCatching { WebViewCompat.removeWebMessageListener(webView, "PocketExtensionsChannel") }
    }
    companion object {
        const val ENTRY = "_expo/static/js/web/index-07fb71ae403dd83a2c7484a3338718f8.js"
        const val SHA256 = "0551012c13e098ebdd9ba96ef639952b84ba25a15e766d41b215c20841bd3381"
    }
}
