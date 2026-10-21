package dev.paseo.pocket

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.RadioButton
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import androidx.test.uiautomator.StaleObjectException
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ShellDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private fun webViews(view: View): List<WebView> = if (view is WebView) listOf(view)
        else if (view is ViewGroup) (0 until view.childCount).flatMap { webViews(view.getChildAt(it)) } else emptyList()
    private fun evaluate(webView: WebView, code: String): String {
        val result = ArrayBlockingQueue<String>(1)
        instrumentation.runOnMainSync { webView.evaluateJavascript(code) { result.offer(it) } }
        return result.poll(15, TimeUnit.SECONDS) ?: error("WebView did not answer")
    }
    private fun waitPage(webView: WebView) {
        val until = System.currentTimeMillis() + 25_000
        while (System.currentTimeMillis() < until) {
            if (evaluate(webView, "document.body.innerText.length > 0") == "true") return
            Thread.sleep(100)
        }
        fail("Bundled page did not render")
    }
    private fun assertNativeInsetsAreNotRepeated(webView: WebView) {
        assertEquals("Native padding must not also become CSS safe-area padding", "true", evaluate(webView,
            "(()=>{const e=document.createElement('div');e.style.cssText='padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';document.body.appendChild(e);const s=getComputedStyle(e);const ok=[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft].every(x=>parseFloat(x)===0);e.remove();return ok})()"))
    }
    private fun launch() {
        val provider = androidx.webkit.WebViewCompat.getCurrentWebViewPackage(instrumentation.targetContext)
        val major = provider?.versionName?.substringBefore('.')?.toIntOrNull() ?: 0
        org.junit.Assume.assumeTrue("Requires an updated system WebView", major >= WebRuntime.MINIMUM_CHROMIUM)
        device.executeShellCommand("am start -n dev.paseo.pocket/.MainActivity")
        val deadline = System.currentTimeMillis() + 15000
        while (System.currentTimeMillis() < deadline) {
            var found = false
            instrumentation.runOnMainSync {
                found = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).any { it is MainActivity }
            }
            if (found) return
            Thread.sleep(100)
        }
        error("MainActivity did not resume")
    }
    private fun onActivity(action: (MainActivity) -> Unit) {
        instrumentation.runOnMainSync {
            action(ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().single())
        }
    }
    private fun clickText(text: String) {
        repeat(3) { attempt ->
            device.waitForIdle(500)
            val selector = if (text in setOf("跟随系统", "明亮", "深色")) By.clazz(RadioButton::class.java).text(text) else By.text(text)
            var item = device.wait(Until.findObject(selector), 5000)
            if (item == null || item.visibleBounds.isEmpty) {
                androidx.test.uiautomator.UiScrollable(androidx.test.uiautomator.UiSelector().scrollable(true)).scrollTextIntoView(text)
                item = device.wait(Until.findObject(selector), 5000)
            }
            val target = item ?: error("Missing UI: $text")
            try { target.click(); device.waitForIdle(1000); return }
            catch (error: StaleObjectException) { if (attempt == 2) throw error }
        }
    }
    private fun openTools() {
        val handle = device.wait(Until.findObject(By.desc("Paseo Pocket 工具")), 5000) ?: error("Missing tool handle")
        handle.click(); device.waitForIdle(500)
    }
    private fun closeTools() {
        device.findObject(By.desc("关闭面板")).click()
        assertTrue(device.wait(Until.gone(By.desc("关闭面板")), 5000))
        assertNotNull(device.wait(Until.findObject(By.desc("Paseo Pocket 工具")), 5000))
    }

    @Test(timeout = 90000) fun menusAppearanceAndBackgroundKeepOneWebViewAndDraft() {
        val prefs = ShellPreferences(instrumentation.targetContext)
        val previousAppearance = prefs.appearance
        launch()
        run {
            lateinit var first: WebView
            onActivity { first = webViews(it.window.decorView).single() }
            waitPage(first)
            assertNativeInsetsAreNotRepeated(first)
            evaluate(first, "window.__pocketFixture='retained';document.body.insertAdjacentHTML('beforeend','<textarea id=\"pocket-fixture-draft\">unsent fixture</textarea>');true")
            repeat(3) {
                openTools()
                clickText("外观")
                clickText(if (it % 2 == 0) "深色" else "明亮")
                onActivity { activity -> assertSame(first, webViews(activity.window.decorView).single()) }
                assertEquals("\"retained\"", evaluate(first, "window.__pocketFixture"))
                assertEquals("\"unsent fixture\"", evaluate(first, "document.getElementById('pocket-fixture-draft').value"))
                onActivity { activity ->
                    val dark = activity.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK == android.content.res.Configuration.UI_MODE_NIGHT_YES
                    assertEquals(it % 2 == 0, dark)
                    if (android.os.Build.VERSION.SDK_INT >= 29) {
                        val light = android.util.TypedValue()
                        assertTrue(activity.theme.resolveAttribute(android.R.attr.isLightTheme, light, true))
                        assertEquals("Activity isLightTheme must match its configuration", !dark, light.data != 0)
                    }
                }
                clickText("返回工具")
                closeTools()
                // WebView can defer its media-query update until the modal returns window focus.
                val expected = (it % 2 == 0).toString()
                val themeDeadline = System.currentTimeMillis() + 10000
                while (evaluate(first, "matchMedia('(prefers-color-scheme: dark)').matches") != expected && System.currentTimeMillis() < themeDeadline) Thread.sleep(100)
                assertEquals(expected, evaluate(first, "matchMedia('(prefers-color-scheme: dark)').matches"))
            }
            openTools()
            clickText("连接与诊断"); clickText("网页引擎与更新")
            assertNotNull(device.wait(Until.findObject(By.text("网页引擎")), 5000))
            val provider = WebViewCompat.getCurrentWebViewPackage(instrumentation.targetContext)
            assertNotNull(device.findObject(By.textContains(requireNotNull(provider?.versionName))))
            clickText("返回")
            clickText("返回工具")
            closeTools()
            try {
                device.setOrientationLeft(); device.waitForIdle(1000)
                onActivity { activity -> assertSame(first, webViews(activity.window.decorView).single()) }
                assertNativeInsetsAreNotRepeated(first)
                assertEquals("\"unsent fixture\"", evaluate(first, "document.getElementById('pocket-fixture-draft').value"))
            } finally { device.setOrientationNatural(); device.unfreezeRotation() }
            device.pressHome()
            launch()
            assertEquals("\"retained\"", evaluate(first, "window.__pocketFixture"))
            assertNativeInsetsAreNotRepeated(first)
            evaluate(first, "document.getElementById('pocket-fixture-draft').remove();delete window.__pocketFixture;true")
            instrumentation.runOnMainSync { prefs.appearance = previousAppearance; ShellSettings.applyAppearance(previousAppearance) }
        }
    }

    @Test(timeout = 90000) fun localResourcesAndStorageWorkAndRendererRecoveryIsManual() {
        launch()
        run {
            lateinit var webView: WebView
            onActivity { webView = webViews(it.window.decorView).single() }
            waitPage(webView)
            assertEquals("true", evaluate(webView, "isSecureContext && !!indexedDB"))
            assertEquals("true", evaluate(webView, "performance.getEntriesByType('resource').filter(x=>/\\.(js|css|woff2?)(\\?|$)/.test(x.name)).every(x=>new URL(x.name).origin===location.origin)"))
            assertEquals("true", evaluate(webView, "localStorage.setItem('pocket.fixture','kept');localStorage.getItem('pocket.fixture')==='kept'"))
            val result = ArrayBlockingQueue<Boolean>(1)
            instrumentation.runOnMainSync {
                if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_VIEW_RENDERER_TERMINATE))
                    result.offer(WebViewCompat.getWebViewRenderProcess(webView)?.terminate() == true)
                else result.offer(false)
            }
            if (result.poll(5, TimeUnit.SECONDS) == true) {
                assertNotNull(device.wait(Until.findObject(By.text("网页渲染进程已退出")), 10_000))
                onActivity { assertEquals(0, webViews(it.window.decorView).size) }
                clickText("重新打开页面")
                onActivity { webView = webViews(it.window.decorView).single() }
                waitPage(webView)
                assertEquals("\"kept\"", evaluate(webView, "localStorage.getItem('pocket.fixture')"))
            }
            evaluate(webView, "localStorage.removeItem('pocket.fixture');true")
        }
    }

    @Test(timeout = 180000) fun customSourceUpdateUiPreservesStorageAndAppliesOnlyAfterConfirmation() {
        val argument = InstrumentationRegistry.getArguments().getString("mirrorUrl")
        org.junit.Assume.assumeTrue(argument != null)
        val url = requireNotNull(argument)
        val prefs = ShellPreferences(instrumentation.targetContext)
        val oldCustom = prefs.customSource; val oldUrl = prefs.customSourceUrl
        launch()
        lateinit var original: WebView
        onActivity { original = webViews(it.window.decorView).single() }
        waitPage(original)
        evaluate(original, "localStorage.setItem('pocket.fixture.update','kept');window.__pocketFixture='before-update';true")
        try {
            openTools(); clickText("更新来源")
            clickText("自定义")
            val sourceField = device.wait(Until.findObject(By.res("dev.paseo.pocket", "update_source_url")), 15000)
            assertNotNull("Custom source field is not visible", sourceField)
            sourceField.text = "https://name:password@localhost:19443/latest.json"
            clickText("保存")
            assertNotNull(device.wait(Until.findObject(By.text("请输入不含登录信息和片段的 HTTPS 地址")), 5000))
            assertEquals(oldCustom, prefs.customSource)
            assertEquals(oldUrl, prefs.customSourceUrl)
            sourceField.text = url + "-missing"
            clickText("保存"); clickText("网页版本"); clickText("检查页面更新")
            assertNotNull(device.wait(Until.findObject(By.textContains("连接失败")), 15000))
            assertEquals("\"before-update\"", evaluate(original, "window.__pocketFixture"))
            clickText("返回工具"); clickText("更新来源"); clickText("自定义")
            val retryField = device.wait(Until.findObject(By.res("dev.paseo.pocket", "update_source_url")), 5000)
            retryField.text = url.replace("/latest.json", "/slow/latest.json")
            clickText("保存"); clickText("网页版本"); clickText("检查页面更新")
            assertNotNull(device.wait(Until.findObject(By.textContains("候选版本")), 15000))
            clickText("下载并验证")
            closeTools()
            openTools(); clickText("网页版本")
            assertNotNull(device.wait(Until.findObject(By.text("取消操作")), 5000))
            clickText("取消操作")
            assertNotNull(device.wait(Until.findObject(By.textContains("已取消")), 15000))
            onActivity { assertSame(original, webViews(it.window.decorView).single()) }
            clickText("返回工具"); clickText("更新来源"); clickText("自定义")
            val finalField = device.wait(Until.findObject(By.res("dev.paseo.pocket", "update_source_url")), 5000)
            finalField.text = url
            assertNotNull(device.wait(Until.findObject(By.res("dev.paseo.pocket", "update_source_url").text(url)), 5000))
            clickText("保存")
            assertTrue(device.wait(Until.gone(By.res("dev.paseo.pocket", "update_source_url")), 5000) == true)
            assertTrue("Saved source did not become active", prefs.customSource)
            assertEquals("\"before-update\"", evaluate(original, "window.__pocketFixture"))
            clickText("网页版本")
            clickText("检查页面更新")
            assertNotNull(device.wait(Until.findObject(By.textContains("候选版本")), 15000))
            // Detach the update page without cancelling the lifecycle-owned transfer.
            clickText("下载并验证")
            closeTools()
            openTools(); clickText("网页版本")
            assertNotNull(device.wait(Until.findObject(By.textContains("等待应用")), 60000))
            onActivity { assertSame(original, webViews(it.window.decorView).single()) }
            assertEquals("\"before-update\"", evaluate(original, "window.__pocketFixture"))
            clickText("应用更新")
            // A second confirmation protects unsent text before the explicit reload.
            assertNotNull(device.wait(Until.findObject(By.text("应用页面更新？")), 5000))
            device.findObjects(By.text("应用更新")).last().click()
            assertNotNull(device.wait(Until.findObject(By.textContains("页面更新已应用")), 30000))
            clickText("返回工具")
            closeTools()
            lateinit var replacement: WebView
            onActivity { replacement = webViews(it.window.decorView).single() }
            assertNotSame(original, replacement)
            waitPage(replacement)
            assertEquals("\"kept\"", evaluate(replacement, "localStorage.getItem('pocket.fixture.update')"))
            evaluate(replacement, "localStorage.removeItem('pocket.fixture.update');true")
        } finally { prefs.customSourceUrl = oldUrl; prefs.customSource = oldCustom }
    }
}
