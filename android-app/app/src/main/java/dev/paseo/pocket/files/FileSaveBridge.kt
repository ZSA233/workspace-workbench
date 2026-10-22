package dev.paseo.pocket.files

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.util.Base64
import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.paseo.pocket.PageOrigin
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

/** A separate, origin-restricted save channel. It never accepts filesystem paths or URLs. */
class FileSaveBridge(private val webView: WebView,
    private val choose: (String, (Uri?) -> Unit) -> Unit) {
    private val token = UUID.randomUUID().toString()
    private var generation = UUID.randomUUID().toString()
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var script: ScriptHandler? = null
    private var installed = false
    private var closed = false
    private data class Picker(val id: String, val ticket: String, val name: String, val reply: JavaScriptReplyProxy)
    private val pickers = ArrayDeque<Picker>() // Main thread; independent of the I/O lane.
    private var picking: Picker? = null
    private val sessions = SaveSessions<Uri>(
        { webView.context.contentResolver.openOutputStream(it, "w") ?: error("Cannot open selected document") },
        { DocumentsContract.deleteDocument(webView.context.contentResolver, it); Unit })

    private fun nextPicker() {
        if (closed || picking != null || pickers.isEmpty()) return
        val picker = pickers.removeFirst(); picking = picker
        choose(picker.name) { selected ->
            picking = null
            if (closed || generation != picker.ticket) {
                if (selected != null) worker.execute { runCatching { DocumentsContract.deleteDocument(webView.context.contentResolver, selected) } }
                if (closed) worker.shutdown()
            } else if (selected == null) respond(picker.reply, picker.id, picker.ticket, "Save cancelled", 0)
            else worker.execute {
                val error = runCatching { sessions.register(picker.id, selected) }.exceptionOrNull()
                handler.post { respond(picker.reply, picker.id, picker.ticket, error?.message, 0) }
            }
            nextPicker()
        }
    }

    fun install() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        WebViewCompat.addWebMessageListener(webView, "PocketFileSaveChannel", setOf(PageOrigin.BASE)) { _, message, origin, mainFrame, reply ->
            if (closed || !mainFrame || !PageOrigin.isLocal(origin.toString()) || !PageOrigin.isLocal(webView.url ?: "")) return@addWebMessageListener
            val raw = runCatching { message.data }.getOrNull() ?: return@addWebMessageListener
            if (raw.length > 710000) return@addWebMessageListener
            val request = runCatching { JSONObject(raw) }.getOrNull() ?: return@addWebMessageListener
            if (request.optString("token") != token) return@addWebMessageListener
            val id = request.optString("id")
            if (!Regex("[a-zA-Z0-9_-]{1,100}").matches(id)) return@addWebMessageListener
            val ticket = generation
            fun answer(error: String? = null, savedOffset: Long = 0) = respond(reply, id, ticket, error, savedOffset)
            val action = request.optString("action")
            if (action == "open") {
                val name = SaveProtocol.name(request.optString("name"))
                if (name == null) { answer("Invalid file name"); return@addWebMessageListener }
                pickers.addLast(Picker(id, ticket, name, reply)); nextPicker()
            } else {
                val saveId = request.optString("saveId")
                worker.execute {
                    var confirmed = 0L
                    val error = runCatching {
                        confirmed = when (action) {
                            "write" -> sessions.write(saveId, request.getLong("offset"), Base64.decode(request.getString("data"), Base64.NO_WRAP))
                            "close" -> sessions.close(saveId)
                            "abort" -> sessions.abort(saveId)
                            else -> error("Unknown save action")
                        }
                    }.exceptionOrNull()
                    handler.post { answer(error?.message, confirmed) }
                }
            }
        }
        installed = true
        val source = webView.context.assets.open("pocket-file-save.js").bufferedReader().use { it.readText() }
        script = WebViewCompat.addDocumentStartJavaScript(webView,
            "($source)(${JSONObject.quote(token)});", setOf(PageOrigin.BASE))
    }
    private fun respond(reply: JavaScriptReplyProxy, id: String, ticket: String, error: String?, offset: Long) {
        if (closed || generation != ticket) return
        runCatching { reply.postMessage(JSONObject().put("id", id).put("error", error ?: JSONObject.NULL).put("offset", offset).toString()) }
    }
    fun pageStarted() { generation = UUID.randomUUID().toString(); pickers.clear(); worker.execute(sessions::clear) }
    fun close() {
        if (closed) return
        closed = true; pickers.clear()
        runCatching { script?.remove() }
        if (installed) runCatching { WebViewCompat.removeWebMessageListener(webView, "PocketFileSaveChannel") }
        worker.execute(sessions::clear)
        // Keep the I/O lane only until an already displayed picker can release its URI.
        if (picking == null) worker.shutdown()
    }
}
