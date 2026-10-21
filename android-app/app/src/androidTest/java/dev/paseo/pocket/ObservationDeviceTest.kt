package dev.paseo.pocket

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
import dev.paseo.pocket.observation.ObservationController
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/** Runs on an isolated emulator; never executes an agent task or clears app storage. */
@RunWith(AndroidJUnit4::class)
class ObservationDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private fun launch() { device.executeShellCommand("am start -n dev.paseo.pocket/.MainActivity") }
    private fun activity(action: (MainActivity) -> Unit) = instrumentation.runOnMainSync {
        action(ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().single())
    }
    private fun observation(activity: MainActivity) = MainActivity::class.java.getDeclaredField("observation")
        .also { it.isAccessible = true }.get(activity) as ObservationController
    private fun webViews(view: View): List<WebView> = if (view is WebView) listOf(view)
        else if (view is ViewGroup) (0 until view.childCount).flatMap { webViews(view.getChildAt(it)) } else emptyList()
    private fun evaluate(webView: WebView, code: String): String {
        val result = ArrayBlockingQueue<String>(1)
        instrumentation.runOnMainSync { webView.evaluateJavascript(code) { result.offer(it ?: "null") } }
        return result.poll(5, TimeUnit.SECONDS) ?: error("WebView did not respond")
    }
    private fun waitFor(check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 20000
        while (System.currentTimeMillis() < deadline) { if (runCatching(check).getOrDefault(false)) return; Thread.sleep(100) }
        error("Observation condition did not become ready")
    }
    @Test(timeout = 90000) fun realBundleBridgePerformanceAndRecordingRetainThePage() {
        val major = androidx.webkit.WebViewCompat.getCurrentWebViewPackage(instrumentation.targetContext)?.versionName?.substringBefore('.')?.toIntOrNull() ?: 0
        org.junit.Assume.assumeTrue("Full page requires updated WebView", major >= WebRuntime.MINIMUM_CHROMIUM)
        launch()
        waitFor { var ready = false; activity { ready = observation(it).trace.adapter == "attached" }; ready }
        lateinit var first: WebView
        activity { first = webViews(it.window.decorView).single() }
        assertEquals("true", evaluate(first, "window.__pocketObservation != null && window.__paseoHostRuntimeStore != null"))
        evaluate(first, "window.__pocketDraftFixture='draft kept';true")
        device.findObject(By.desc("Paseo Pocket 工具")).click()
        device.wait(Until.findObject(By.descStartsWith("连接与诊断，")), 5000).click()
        assertNotNull(device.wait(Until.findObject(By.res("dev.paseo.pocket", "observation_status")), 5000))
        device.findObject(By.text("查看性能")).click()
        waitFor { var sampled = false; activity { sampled = observation(it).performance.cpuPercent != null && observation(it).performance.pssKiB != null }; sampled }
        assertTrue(device.findObject(By.res("dev.paseo.pocket", "observation_performance")).text.contains("App 进程"))
        activity { observation(it).startRecording() }
        device.findObject(By.desc("关闭面板")).click()
        activity { assertSame(first, webViews(it.window.decorView).single()); assertTrue(observation(it).isRecording) }
        device.pressHome(); Thread.sleep(500); launch()
        waitFor { var ready = false; activity { ready = !observation(it).isRecording }; ready }
        activity { assertSame(first, webViews(it.window.decorView).single()) }
        assertEquals("\"draft kept\"", evaluate(first, "window.__pocketDraftFixture"))
        evaluate(first, "delete window.__pocketDraftFixture;true")
    }
}
