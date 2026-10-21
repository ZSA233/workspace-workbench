package dev.paseo.pocket

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

class WebSession(private val activity: Activity, private val prefs: ShellPreferences) {
    val bundle = WebBundle(activity.assets)
    val webView: WebView = WebView(activity)

    @SuppressLint("SetJavaScriptEnabled")
    fun start() {
        WebView.setWebContentsDebuggingEnabled((activity.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                bundle.intercept(request.url, request.isForMainFrame)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (PageOrigin.isLocal(request.url.toString())) return false
                if (!request.isForMainFrame) return true
                openExternal(request.url)
                return true
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                prefs.route = url
            }
        }
        webView.webChromeClient = WebChromeClient()
        webView.loadUrl(PageOrigin.BASE + prefs.route)
    }

    private fun openExternal(uri: Uri) {
        if (uri.scheme !in setOf("http", "https", "mailto", "tel")) return
        try { activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)) }
        catch (_: ActivityNotFoundException) { /* No external handler installed. */ }
    }

    fun destroy() {
        webView.stopLoading()
        webView.removeAllViews()
        webView.destroy()
    }
}
