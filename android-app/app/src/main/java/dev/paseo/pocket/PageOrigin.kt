package dev.paseo.pocket

import java.net.URI

object PageOrigin {
    const val HOST = "appassets.androidplatform.net"
    const val BASE = "https://$HOST"

    fun isLocal(url: String): Boolean = runCatching {
        val uri = URI(url)
        uri.scheme == "https" && uri.host == HOST && uri.port == -1 && uri.userInfo == null
    }.getOrDefault(false)

    fun safeRestorePath(url: String): String? = runCatching {
        if (!isLocal(url)) return null
        val uri = URI(url)
        val path = uri.rawPath.ifEmpty { "/" }
        // Pairing offers, tokens, and form data must never enter native route storage.
        if (uri.rawQuery != null || uri.rawFragment != null || !isSpaRoute(uri.path)) return null
        path
    }.getOrNull()

    fun isSpaRoute(path: String): Boolean = path == "/" ||
        (path.startsWith("/") && !path.contains('\\') && !path.contains("..") &&
            !path.startsWith("/_expo/") && !path.substringAfterLast('/').contains('.'))

    fun resourcePath(path: String): String? {
        val relative = path.removePrefix("/")
        if (relative.isEmpty() || relative.length > 1024 || relative.contains('\\') ||
            relative.any { it.code < 32 } || relative.split('/').any { it.isEmpty() || it == "." || it == ".." }) return null
        return relative
    }
}
