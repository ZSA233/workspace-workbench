package dev.paseo.pocket.observation

import android.os.SystemClock
import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.paseo.pocket.PageOrigin
import org.json.JSONObject
import java.util.UUID

/** One-way, bounded native observation channel. No filesystem or task commands. */
class ObservationBridge(private val webView: WebView, private val webVersion: String,
    private val message: (ObservationMessage) -> Unit, private val unavailable: (String) -> Unit) {
    private val token = UUID.randomUUID().toString()
    private var generation = UUID.randomUUID().toString()
    private var doc: String? = null
    private val candidates = mutableSetOf<String>()
    private var lastSeq = 0L
    private var script: ScriptHandler? = null
    private var installed = false
    private var closed = false
    private var activated = false
    private var foreground = false
    private var inspecting = false
    private var verifyOnActivation = false
    private var bucketStart = 0L
    private var bucketSize = 0

    fun install() {
        runCatching { installSupported() }.onFailure {
            script?.remove(); script = null
            if (installed) WebViewCompat.removeWebMessageListener(webView, "PocketObservationChannel")
            installed = false; unavailable("incompatible")
        }
    }
    private fun installSupported() {
        if (webVersion != "0.12.0") { unavailable("version"); return }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) { unavailable("capability"); return }
        val source = webView.context.assets.open("pocket-observer.js").bufferedReader().use { it.readText() }
        WebViewCompat.addWebMessageListener(webView, "PocketObservationChannel", setOf(PageOrigin.BASE)) { _, data, origin, mainFrame, _ ->
            if (closed || !mainFrame || !PageOrigin.isLocal(origin.toString())) return@addWebMessageListener
            val now = SystemClock.elapsedRealtime()
            if (now - bucketStart >= 1000) { bucketStart = now; bucketSize = 0 }
            if (++bucketSize > 30) return@addWebMessageListener
            val raw = runCatching { data.data }.getOrNull() ?: return@addWebMessageListener
            if (raw.length > 16384) return@addWebMessageListener
            val activatedDoc = runCatching { JSONObject(raw).takeIf { it.optString("type") == "activated" }?.optString("doc") }
                .getOrNull()?.takeIf { it in candidates }
            val decoded = ObservationMessage.parse(raw, token, generation, activatedDoc ?: doc) ?: return@addWebMessageListener
            if (decoded.type == "hello") {
                if (activated || candidates.size >= 4) return@addWebMessageListener
                candidates.add(decoded.doc)
                // Challenge the current document. A delayed hello from an old document cannot activate it.
                call("activate(${JSONObject.quote(decoded.doc)},${JSONObject.quote(generation)})")
            } else if (decoded.type == "activated" || decoded.seq > lastSeq) {
                if (decoded.type == "activated" && activated) return@addWebMessageListener
                lastSeq = decoded.seq
                if (decoded.type == "activated") {
                    activated = true; doc = decoded.doc; candidates.clear()
                    call("foreground($foreground,$verifyOnActivation)")
                    call("inspect($inspecting)")
                    verifyOnActivation = false
                } else message(decoded)
            }
        }
        installed = true
        val config = JSONObject().put("token", token).put("webVersion", webVersion)
        script = WebViewCompat.addDocumentStartJavaScript(webView,
            "window.__pocketObservation = ($source)($config);", setOf(PageOrigin.BASE))
    }
    fun pageStarted() {
        generation = UUID.randomUUID().toString(); doc = null; candidates.clear(); lastSeq = 0; activated = false
        bucketStart = 0; bucketSize = 0
        if (!installed) unavailable(if (webVersion == "0.12.0") "capability" else "version")
    }
    fun foreground(value: Boolean, verify: Boolean = false) {
        foreground = value
        if (activated) call("foreground($value,$verify)") else if (verify) verifyOnActivation = true
    }
    fun inspect(value: Boolean, reset: Boolean = false) { inspecting = value; if (activated) call("inspect($value,$reset)") }
    fun refresh() { if (activated) call("refresh()") }
    fun verify() { if (activated && foreground) call("verify()") }
    private fun call(command: String) {
        if (!closed) webView.evaluateJavascript("window.__pocketObservation?.$command;void 0", null)
    }
    fun close() {
        if (closed) return
        call("dispose()")
        closed = true; activated = false
        script?.remove()
        if (installed) WebViewCompat.removeWebMessageListener(webView, "PocketObservationChannel")
    }
}
