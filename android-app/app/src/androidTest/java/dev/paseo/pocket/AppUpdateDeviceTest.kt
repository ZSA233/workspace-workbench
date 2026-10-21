package dev.paseo.pocket

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.google.android.material.bottomsheet.BottomSheetDialog
import dev.paseo.pocket.appupdates.*
import dev.paseo.pocket.updates.HttpsTransport
import dev.paseo.pocket.updates.PageUpdates
import dev.paseo.pocket.updates.UpdateGate
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.URL
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HttpsURLConnection

@RunWith(AndroidJUnit4::class)
class AppUpdateDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)
    private fun main(action: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) { action(); return }
        val result = ArrayBlockingQueue<Result<Unit>>(1)
        Handler(Looper.getMainLooper()).post { result.offer(runCatching(action)) }
        (result.poll(10, TimeUnit.SECONDS) ?: error("Main thread did not answer")).getOrThrow()
    }
    private fun activity(action: (MainActivity) -> Unit) = main {
        action(ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().single())
    }
    private fun waitFor(check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 30000
        while (System.currentTimeMillis() < deadline) { if (check()) return; Thread.sleep(100) }
        error("App update condition did not complete")
    }
    private fun isolated() {
        org.junit.Assume.assumeTrue("Update fixtures require the separate QA package", context.packageName == "dev.paseo.pocket.qa")
        context.getSharedPreferences("app_updates", 0).edit().clear().putBoolean("automatic", false).commit()
    }
    private fun launch() {
        device.executeShellCommand("am start -n ${context.packageName}/dev.paseo.pocket.MainActivity")
        waitFor {
            var found = false
            main { found = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).any { it is MainActivity } }
            found
        }
    }
    private fun views(view: View): List<WebView> = if (view is WebView) listOf(view)
        else if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun evaluate(view: WebView, code: String): String {
        val result = ArrayBlockingQueue<String>(1)
        main { view.evaluateJavascript(code) { result.offer(it) } }
        return result.poll(10, TimeUnit.SECONDS) ?: error("Page did not answer")
    }
    private fun fixture(prefix: String = "", requests: AtomicInteger? = null): AppUpdateClient {
        val base = InstrumentationRegistry.getArguments().getString("appUpdateFixture")
        org.junit.Assume.assumeTrue("Requires the isolated signed APK fixture", base != null)
        return AppUpdateClient(AppReleasePolicy(BuildConfig.UPDATE_REPOSITORY, BuildConfig.UPDATE_CERTIFICATE_SHA256), HttpsTransport { original ->
            requests?.incrementAndGet()
            val path = if (original.host == "api.github.com") "releases" else "assets/${original.path.substringAfterLast('/')}"
            URL("${requireNotNull(base).trimEnd('/')}/$prefix$path").openConnection() as HttpsURLConnection
        })
    }
    private val installed = InstalledPocket("dev.paseo.pocket", "0.1.4", 5, BuildConfig.UPDATE_CERTIFICATE_SHA256)
    private fun status(updates: AppUpdates): String { var value = ""; main { value = updates.state.kind }; return value }
    private fun coordinator(root: File, client: AppUpdateClient, gate: UpdateGate = UpdateGate(),
        clock: () -> Long = System::currentTimeMillis): AppUpdates {
        lateinit var value: AppUpdates
        main { value = AppUpdates(context, Diagnostics(context), ApkTrust(context, installed), client, clock, root, gate); value.setAutomatic(false) }
        waitFor { status(value) != "restoring" }
        main { value.foreground(true) }
        return value
    }
    private fun storage() = File(context.filesDir, "apk-updates/packages/test-${UUID.randomUUID()}")
    private fun click(text: String) {
        val target = device.wait(Until.findObject(By.text(text)), 5000) ?: error("Missing control: $text")
        if (target.visibleBounds.isEmpty) {
            androidx.test.uiautomator.UiScrollable(androidx.test.uiautomator.UiSelector().scrollable(true)).scrollTextIntoView(text)
        }
        (device.findObject(By.text(text)) ?: error("Missing control: $text")).click()
    }

    @Test(timeout = 90000) fun applicationUpdateEntryKeepsWebViewAndIsSeparateFromWebUpdates() {
        isolated(); launch()
        val provider = androidx.webkit.WebViewCompat.getCurrentWebViewPackage(context)
        org.junit.Assume.assumeTrue("Requires a current WebView", (provider?.versionName?.substringBefore('.')?.toIntOrNull() ?: 0) >= WebRuntime.MINIMUM_CHROMIUM)
        lateinit var web: WebView
        activity { web = views(it.window.decorView).single() }
        waitFor { evaluate(web, "document.body.innerText.length > 0") == "true" }
        evaluate(web, "window.__pocketUpdateDraft='retained';const t=document.createElement('textarea');t.id='pocket-update-draft';t.value='unsent';document.body.appendChild(t);true")
        val prefs = ShellPreferences(context)
        val appearance = prefs.appearance
        val source = prefs.customSource
        val url = prefs.customSourceUrl
        val captures = File(context.getExternalFilesDir(null), "app-update-acceptance").apply { mkdirs() }
        try {
            device.wait(Until.findObject(By.desc("Paseo Pocket 工具")), 5000).click()
            for (mode in listOf("light", "dark")) {
                main { prefs.appearance = mode; ShellSettings.applyAppearance(mode) }
                device.waitForIdle(500)
                assertTrue(device.takeScreenshot(File(captures, "tools-$mode.png")))
                assertNotNull(device.findObject(By.descStartsWith("外观，")))
                val app = device.findObject(By.descStartsWith("应用升级，"))
                val webTile = device.findObject(By.descStartsWith("网页更新，"))
                val diagnostic = device.findObject(By.descStartsWith("连接与诊断，"))
                assertNotNull(app); assertNotNull(webTile); assertNotNull(diagnostic)
                assertEquals(app.visibleBounds.top, diagnostic.visibleBounds.top)
                assertTrue(webTile.visibleBounds.top < app.visibleBounds.top)
                assertNull(device.findObject(By.text("网页更新来源")))
            }
            click("应用升级")
            val details = device.wait(Until.findObject(By.res(context.packageName, "app_update_status")), 5000)
            assertNotNull(details); assertTrue(details.text.contains("当前应用：Pocket"))
            assertNotNull(device.findObject(By.text("自动检查应用更新")))
            assertNull(device.findObject(By.text("切换网页版本")))
            device.waitForIdle(500)
            assertTrue(device.takeScreenshot(File(captures, "app-upgrade-dark.png")))
            click("返回工具"); click("网页更新")
            assertNotNull(device.wait(Until.findObject(By.text("检查网页更新")), 5000))
            assertNull(device.findObject(By.text("安装 APK")))
            device.waitForIdle(500)
            assertTrue(device.takeScreenshot(File(captures, "web-update-dark.png")))
            click("网页更新来源"); click("自定义")
            device.pressBack()
            assertNotNull(device.wait(Until.findObject(By.text("检查网页更新")), 5000))
            assertEquals(source, prefs.customSource); assertEquals(url, prefs.customSourceUrl)
            device.pressBack()
            assertNotNull(device.wait(Until.findObject(By.descStartsWith("应用升级，")), 5000))
            activity { assertSame(web, views(it.window.decorView).single()) }
            device.findObject(By.desc("关闭面板")).click()
            assertEquals("\"retained\"", evaluate(web, "window.__pocketUpdateDraft"))
            assertEquals("\"unsent\"", evaluate(web, "document.getElementById('pocket-update-draft').value"))
        } finally {
            device.findObject(By.desc("关闭面板"))?.click()
            main { prefs.appearance = appearance; ShellSettings.applyAppearance(appearance) }
            evaluate(web, "document.getElementById('pocket-update-draft')?.remove();delete window.__pocketUpdateDraft;true")
        }
    }

    @Test(timeout = 150000) fun signedDownloadRestoresAndSystemInstallerUpgradesTheIsolatedMainApp() {
        isolated()
        org.junit.Assume.assumeTrue("Only enable installation in an owned disposable emulator",
            InstrumentationRegistry.getArguments().getString("allowIsolatedInstall") == "true")
        val root = storage(); val client = fixture(); var updates = coordinator(root, client)
        var ui: AppUpdateUi? = null; var panel: BottomSheetDialog? = null
        fun packageState() = device.executeShellCommand("dumpsys package dev.paseo.pocket")
        fun code(text: String) = Regex("versionCode=(\\d+)").find(text)?.groupValues?.get(1)?.toLong()
        fun uid(text: String) = Regex("(?:userId|appId)=(\\d+)").find(text)?.groupValues?.get(1)
        try {
            main { updates.check() }; waitFor { status(updates) == "available" }
            main { updates.download(requireNotNull(updates.state.update)) }; waitFor { status(updates) == "ready" }
            main { updates.close() }
            updates = coordinator(root, client); assertEquals("ready", status(updates))
            val update = requireNotNull(updates.state.update)
            val file = updates.apk(update); val intent = InstallIntent.create(context, file)
            assertEquals("content", intent.data?.scheme)
            assertEquals("${context.packageName}.apk-updates", intent.data?.authority)
            assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
            assertEquals(0, intent.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            assertEquals(file.length(), context.contentResolver.openInputStream(requireNotNull(intent.data))!!.use { it.readBytes().size.toLong() })
            val wrong = update.copy(certificateSha256 = "c".repeat(64))
            try { ApkTrust(context, installed.copy(certificate = wrong.certificateSha256)).verify(file, wrong); fail("Expected signer rejection") }
            catch (failure: dev.paseo.pocket.updates.UpdateFailure) { assertEquals("signer_mismatch", failure.code) }
            val before = packageState()
            assertNotNull("Install the old signed fixture in the owned emulator first", code(before))
            assertTrue(requireNotNull(code(before)) < update.versionCode)
            launch()
            val permission = AtomicReference<Intent>()
            assertFalse("Set the install app-op to deny before starting instrumentation", context.packageManager.canRequestPackageInstalls())
            activity { host ->
                ui = AppUpdateUi(host, updates, { permission.set(it) })
                panel = BottomSheetDialog(host).also { it.setContentView(ui!!.content(host)); it.show() }
                ui!!.foreground(true)
            }
            click("安装 APK"); click("继续安装")
            waitFor { permission.get() != null }
            assertEquals(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, permission.get().action)
            main { ui!!.permissionReturned() }
            assertNotNull(device.wait(Until.findObject(By.textContains("尚未允许安装应用")), 5000))
            assertTrue(file.exists()); assertEquals("ready", status(updates))
            device.executeShellCommand("appops set ${context.packageName} REQUEST_INSTALL_PACKAGES allow")
            click("安装 APK"); click("继续安装")
            waitFor { device.currentPackageName?.contains("packageinstaller") == true }
            var install = device.wait(Until.findObject(By.clazz("android.widget.Button").text(java.util.regex.Pattern.compile("(?i)install|update|安装|更新"))), 10000)
            assertNotNull("Android must ask for installation confirmation", install)
            device.pressBack()
            waitFor { device.currentPackageName == context.packageName }
            assertTrue(file.exists()); assertEquals("ready", status(updates))
            click("安装 APK"); click("继续安装")
            waitFor { device.currentPackageName?.contains("packageinstaller") == true }
            install = device.wait(Until.findObject(By.clazz("android.widget.Button").text(java.util.regex.Pattern.compile("(?i)install|update|安装|更新"))), 10000)
            assertNotNull(install); install.click()
            waitFor { code(packageState()) == update.versionCode }
            val after = packageState()
            assertTrue(after.contains("versionName=${update.release.version}"))
            assertNotNull(uid(before)); assertEquals(uid(before), uid(after))
        } finally {
            main { ui?.close(); panel?.dismiss(); updates.close() }
            // Revoking this app-op kills the UID on current Android. Reset it only
            // from the external runner after instrumentation has reported its result.
            root.deleteRecursively()
        }
    }

    @Test(timeout = 90000) fun dailyChecksCoalesceAndCachedCandidateSurvivesOfflineRestart() {
        isolated()
        val root = storage(); val requests = AtomicInteger(); val clock = AtomicLong(1_800_000_000_000)
        val gate = UpdateGate()
        var finish: (() -> Unit)? = null
        main { finish = gate.acquire(UpdateGate.Target.WEB) }
        var updates = coordinator(root, fixture(requests = requests), gate, clock::get)
        try {
            main { updates.setAutomatic(true); repeat(5) { updates.foreground(true) }; assertEquals(0L, updates.lastAttempt) }
            assertEquals(0, requests.get())
            main { finish!!(); repeat(5) { updates.foreground(true) } }
            waitFor { status(updates) == "available" }
            val first = requests.get(); assertEquals(3, first)
            main { repeat(5) { updates.foreground(false); updates.foreground(true) } }
            assertEquals(first, requests.get())
            clock.addAndGet(AppCheckSchedule.INTERVAL_MS - 1)
            main { updates.foreground(true) }; assertEquals(first, requests.get())
            clock.incrementAndGet()
            main { repeat(5) { updates.foreground(true) } }
            waitFor { status(updates) == "available" }; assertEquals(first * 2, requests.get())
            main { updates.check() }; waitFor { status(updates) == "available" }
            assertEquals(first * 3, requests.get())
            main { updates.setAutomatic(false); updates.close() }
            File(root, "download-interrupted.part").writeText("partial")
            updates = coordinator(root, fixture("offline/"), clock = clock::get)
            main { assertTrue(updates.state.cached); assertEquals(clock.get(), updates.lastChecked) }
            assertEquals("available", status(updates))
            assertFalse(File(root, "download-interrupted.part").exists())
            main { updates.check() }; waitFor { status(updates) == "failed" }
            main { assertTrue(updates.state.cached); assertNotNull(updates.state.update); assertEquals(clock.get(), updates.lastChecked) }
        } finally { main { updates.close() }; root.deleteRecursively() }
    }

    @Test(timeout = 90000) fun corruptDownloadIsRejectedAndPartialDownloadCanBeCancelled() {
        isolated()
        for (prefix in listOf("corrupt/", "slow/")) {
            val root = storage(); val gate = UpdateGate(); val updates = coordinator(root, fixture(prefix), gate)
            var pages: PageUpdates? = null
            try {
                main { updates.check() }; waitFor { status(updates) == "available" }
                main { updates.download(requireNotNull(updates.state.update)) }
                if (prefix == "slow/") {
                    waitFor { var done = 0L; main { done = updates.state.downloaded }; done > 0 }
                    main {
                        assertEquals(UpdateGate.Target.APP, gate.owner)
                        pages = PageUpdates(context, Diagnostics(context), gate)
                        pages!!.check("https://localhost:19446/missing")
                        assertEquals("idle", pages!!.status.kind)
                        updates.cancel()
                    }
                    waitFor { status(updates) == "cancelled" }
                    main { assertNull(gate.owner) }
                } else {
                    waitFor { status(updates) == "failed" }
                    main { assertEquals("digest_mismatch", updates.state.failure); assertNull(gate.owner) }
                }
                assertTrue(root.listFiles().orEmpty().none { it.extension == "part" })
                assertTrue(File(root, "packages").listFiles().orEmpty().none { it.extension == "apk" })
            } finally { main { pages?.close(); updates.close() }; root.deleteRecursively() }
        }
    }
}
