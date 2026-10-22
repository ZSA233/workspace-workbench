package dev.paseo.pocket

import android.net.Uri
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
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.regex.Pattern

@RunWith(AndroidJUnit4::class)
class FileSaveDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private fun views(view: View): List<WebView> = if (view is WebView) listOf(view)
        else if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun evaluate(web: WebView, script: String): String {
        val queue = ArrayBlockingQueue<String>(1)
        instrumentation.runOnMainSync { web.evaluateJavascript(script) { queue.offer(it) } }
        return queue.poll(15, TimeUnit.SECONDS) ?: error("No JavaScript response")
    }
    @Test(timeout = 90000) fun trustedPageSavesThroughSystemDocumentPicker() {
        device.executeShellCommand("am start -n ${instrumentation.targetContext.packageName}/dev.paseo.pocket.MainActivity")
        var activity: MainActivity? = null
        var web: WebView? = null
        val deadline = System.currentTimeMillis() + 25000
        while (System.currentTimeMillis() < deadline) {
            instrumentation.runOnMainSync {
                activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().firstOrNull()
                web = activity?.let { views(it.window.decorView).firstOrNull() }
            }
            if (web != null && evaluate(web!!, "typeof WorkbenchFileSave === 'object'") == "true") break
            Thread.sleep(200)
        }
        val view = web ?: error("No WebView")
        assertEquals("Trusted page save bridge installed", "true", evaluate(view, "typeof WorkbenchFileSave === 'object'"))
        evaluate(view, "window.saveProof='pending';WorkbenchFileSave.open('workbench-save-proof.txt').then(async out=>{await out.write(new TextEncoder().encode('Pocket bounded save proof'));await out.close();window.saveProof='complete'}).catch(e=>window.saveProof='error:'+e.message);void 0")
        var savedUri: Uri? = null
        instrumentation.runOnMainSync {
            val field = MainActivity::class.java.getDeclaredField("saveCallback").apply { isAccessible = true }
            @Suppress("UNCHECKED_CAST") val callback = field.get(activity) as ((Uri?) -> Unit)
            field.set(activity, { uri: Uri? -> savedUri = uri; callback(uri) })
        }
        val save = device.wait(Until.findObject(By.text(Pattern.compile("(?i)save|保存"))), 15000)
            ?: device.wait(Until.findObject(By.res("com.android.documentsui", "button1")), 5000)
            ?: error("System Save action not found")
        save.click()
        var result = ""
        val until = System.currentTimeMillis() + 20000
        while (System.currentTimeMillis() < until) { result = evaluate(view, "window.saveProof"); if (result != "\"pending\"") break; Thread.sleep(100) }
        assertEquals("\"complete\"", result)
        val uri = savedUri ?: error("No system-selected destination")
        val content = instrumentation.targetContext.contentResolver.openInputStream(uri)!!.bufferedReader().use { it.readText() }
        assertEquals("Pocket bounded save proof", content)
        android.provider.DocumentsContract.deleteDocument(instrumentation.targetContext.contentResolver, uri)
    }
}
