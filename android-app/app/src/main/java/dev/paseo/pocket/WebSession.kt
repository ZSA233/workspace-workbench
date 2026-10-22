package dev.paseo.pocket

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.view.ViewGroup
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import dev.paseo.pocket.files.FileSaveBridge
import dev.paseo.pocket.observation.ObservationBridge
import dev.paseo.pocket.observation.ObservationController
import java.io.File

class WebSession(private val activity: Activity, private val prefs: ShellPreferences,
    private val diagnostics: Diagnostics,
    private val observation: ObservationController,
    private val unavailable: (String) -> Unit,
    installed: File? = null,
    private val chooseSave: (String, (Uri?) -> Unit) -> Unit = { _, reply -> reply(null) },
    private val chooseFiles: (ValueCallback<Array<Uri>>, WebChromeClient.FileChooserParams) -> Boolean) {
    val bundle = WebBundle(activity.assets, installed)
    val webView: WebView = WebView(activity)
    var destroyed = false
        private set
    private lateinit var bridge: ObservationBridge
    private lateinit var fileSave: FileSaveBridge
    private lateinit var imageInput: PocketImageInput

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
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING))
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(webView.settings, false)
        bridge = ObservationBridge(webView, bundle.version, observation::message, observation::unavailable)
        bridge.install()
        fileSave = FileSaveBridge(webView, chooseSave)
        fileSave.install()
        imageInput = PocketImageInput(webView, bundle.version, diagnostics)
        imageInput.install()
        observation.bind(bridge)
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                if (destroyed) return
                observation.pageStarted(); bridge.pageStarted(); fileSave.pageStarted()
            }
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                bundle.intercept(request.url, request.isForMainFrame)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (PageOrigin.isLocal(request.url.toString())) return false
                if (!request.isForMainFrame) return true
                openExternal(request.url)
                return true
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                if (destroyed) return
                prefs.route = url
                if (::bridge.isInitialized) bridge.refresh()
            }
            override fun onPageFinished(view: WebView, url: String) { if (!destroyed) observation.pageFinished() }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (destroyed) return
                if (request.isForMainFrame) { observation.unavailable("load_error"); diagnostics.record("page_load_failed"); unavailable("page_load_failed") }
            }
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (destroyed) return
                if (request.isForMainFrame || bundle.isStaticResource(request.url)) {
                    observation.unavailable("load_error")
                    diagnostics.record("page_resource_missing"); unavailable("page_resource_missing")
                }
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (destroyed) return true
                observation.unavailable("renderer")
                diagnostics.record(if (detail.didCrash()) "renderer_crashed" else "renderer_reclaimed")
                destroy()
                unavailable("renderer_gone")
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) { if (!destroyed) observation.progress(newProgress) }
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
                chooseFiles(callback, params)
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (!destroyed && message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) diagnostics.record("page_console_error")
                return true
            }
        }
        val engine = WebRuntime.chromiumMajor(webView.settings.userAgentString)
        if (engine != null && engine < WebRuntime.MINIMUM_CHROMIUM) {
            observation.unavailable("engine")
            diagnostics.record("webview_too_old")
            unavailable("webview_too_old")
            return
        }
        diagnostics.record("page_opened")
        webView.loadUrl(PageOrigin.BASE + prefs.route)
    }

    private fun openExternal(uri: Uri) {
        if (uri.scheme !in setOf("http", "https", "mailto", "tel")) return
        try { activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)) }
        catch (_: ActivityNotFoundException) { /* No external handler installed. */ }
    }

    fun destroy() {
        if (destroyed) return
        destroyed = true
        if (::bridge.isInitialized) { observation.unbind(bridge); bridge.close() }
        if (::fileSave.isInitialized) fileSave.close()
        if (::imageInput.isInitialized) imageInput.close()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.stopLoading()
        webView.removeAllViews()
        webView.destroy()
    }
}
