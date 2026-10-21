package dev.paseo.pocket

import android.content.res.AssetManager
import android.net.Uri
import android.webkit.WebResourceResponse
import android.webkit.MimeTypeMap
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.File

class WebBundle(private val assets: AssetManager, private val installed: File? = null) {
    val manifest = JSONObject(open("_workbench.json").bufferedReader().use { it.readText() })
    val version: String = manifest.getJSONObject("metadata").getString("version")
    private val files = manifest.getJSONArray("files").let { rows ->
        (0 until rows.length()).map { rows.getJSONObject(it).getString("path") }.toSet()
    }
    private val loader = WebViewAssetLoader.Builder().setDomain(PageOrigin.HOST)
        .addPathHandler("/", WebViewAssetLoader.PathHandler { path ->
            val relative = PageOrigin.resourcePath(path)
            if (relative == null || relative !in files) missing()
            else runCatching { response(relative, open(relative)) }
                .getOrElse { missing() }
        }).build()
    private fun open(relative: String): InputStream = installed?.let { File(it, relative).inputStream() }
        ?: assets.open("paseo/$relative", AssetManager.ACCESS_STREAMING)
    fun isStaticResource(uri: Uri): Boolean {
        val relative = PageOrigin.resourcePath(uri.path ?: "")
        return PageOrigin.isLocal(uri.toString()) && ((relative != null && relative in files) ||
            uri.path?.startsWith("/_expo/") == true || uri.path?.startsWith("/assets/") == true)
    }

    fun intercept(uri: Uri, mainFrame: Boolean): WebResourceResponse? {
        if (!PageOrigin.isLocal(uri.toString())) return null
        val target = if (mainFrame && PageOrigin.isSpaRoute(uri.path ?: "/"))
            Uri.parse("${PageOrigin.BASE}/index.html") else uri
        return loader.shouldInterceptRequest(target) ?: missing()
    }

    private fun response(path: String, input: InputStream): WebResourceResponse {
        val extension = path.substringAfterLast('.', "").lowercase()
        val mime = when (extension) {
            "js", "mjs" -> "application/javascript"
            "wasm" -> "application/wasm"
            "json" -> "application/json"
            "woff2" -> "font/woff2"
            "woff" -> "font/woff"
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
        }
        return WebResourceResponse(mime, if (extension in setOf("html", "js", "css", "json", "svg", "txt")) "UTF-8" else null,
            200, "OK", mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"), input)
    }

    private fun missing() = WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
        mapOf("Cache-Control" to "no-store"), ByteArrayInputStream("Local page resource is missing. Open Paseo Pocket tools to recover.".toByteArray()))
}
