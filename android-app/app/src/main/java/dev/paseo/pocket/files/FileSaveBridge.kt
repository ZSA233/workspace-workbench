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
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** A separate, origin-restricted save channel. It never accepts filesystem paths or URLs. */
class FileSaveBridge(private val webView: WebView,
    private val choose: (String, (Uri?) -> Unit) -> Unit) {
    private val token = UUID.randomUUID().toString()
    private var generation = UUID.randomUUID().toString()
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    private var script: ScriptHandler? = null
    private var installed = false
    private var closed = false
    private var current: String? = null
    private var output: OutputStream? = null // Only touched by the serial I/O worker.
    private var uri: Uri? = null
    private var offset = 0L

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
            if (!busy.compareAndSet(false, true)) { answer("Another save request is pending"); return@addWebMessageListener }
            if (action == "open") {
                if (current != null) { busy.set(false); answer("A save is already open"); return@addWebMessageListener }
                val name = SaveProtocol.name(request.optString("name"))
                if (name == null) { busy.set(false); answer("Invalid file name"); return@addWebMessageListener }
                current = id
                choose(name) { selected ->
                    if (closed || generation != ticket || current != id) { busy.set(false); return@choose }
                    if (selected == null) { current = null; busy.set(false); answer("Save cancelled"); return@choose }
                    worker.execute {
                        val error = runCatching { output = webView.context.contentResolver.openOutputStream(selected, "w") ?: error("Cannot open selected document"); uri = selected; offset = 0L }.exceptionOrNull()
                        handler.post { busy.set(false); if (error != null) current = null; answer(error?.message) }
                    }
                }
            } else {
                if (request.optString("saveId") != current || current == null) { busy.set(false); answer("Save session expired"); return@addWebMessageListener }
                worker.execute {
                    val error = runCatching {
                        when (action) {
                            "write" -> {
                                val bytes = Base64.decode(request.getString("data"), Base64.NO_WRAP)
                                SaveProtocol.chunk(offset, request.getLong("offset"), bytes.size)
                                output?.write(bytes) ?: error("Save output is closed")
                                offset += bytes.size
                            }
                            "close" -> { output?.flush(); output?.close(); output = null; uri = null }
                            "abort" -> discard()
                            else -> error("Unknown save action")
                        }
                    }.exceptionOrNull()
                    val confirmed = offset
                    handler.post { busy.set(false); if (action == "close" && error == null || action == "abort") current = null; answer(error?.message, confirmed) }
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
    private fun discard() {
        runCatching { output?.close() }; output = null
        uri?.let { runCatching { DocumentsContract.deleteDocument(webView.context.contentResolver, it) } }; uri = null; offset = 0L
    }
    fun pageStarted() { generation = UUID.randomUUID().toString(); current = null; worker.execute(::discard) }
    fun close() {
        if (closed) return
        closed = true; current = null
        runCatching { script?.remove() }
        if (installed) runCatching { WebViewCompat.removeWebMessageListener(webView, "PocketFileSaveChannel") }
        worker.execute(::discard); worker.shutdown()
    }
}
