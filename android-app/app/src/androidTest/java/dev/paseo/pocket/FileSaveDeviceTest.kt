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
    private fun trustedPage(): Pair<MainActivity, WebView> {
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
        return Pair(activity!!, view)
    }
    @Test(timeout = 90000) fun trustedPageSavesThroughSystemDocumentPicker() {
        val (activity, view) = trustedPage()
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
        evaluate(view, "window.uploadProof='pending';const input=document.createElement('input');input.type='file';input.accept='text/plain';input.onchange=async()=>window.uploadProof=input.files.length?await input.files[0].text():'cancelled';const button=document.createElement('button');button.textContent='Choose proof file';button.style.cssText='position:fixed;top:96px;left:12px;z-index:2147483647;padding:16px';button.onclick=()=>input.click();document.body.append(input,button);void 0")
        device.wait(Until.findObject(By.text("Choose proof file")), 10000)?.click() ?: error("Upload proof control not found")
        device.wait(Until.findObject(By.text("workbench-save-proof.txt")), 15000)?.click() ?: error("Saved proof file not available in system picker")
        val uploadedUntil = System.currentTimeMillis() + 15000
        var uploaded = ""
        while (System.currentTimeMillis() < uploadedUntil) { uploaded = evaluate(view, "window.uploadProof"); if (uploaded != "\"pending\"") break; Thread.sleep(100) }
        assertEquals("\"Pocket bounded save proof\"", uploaded)
        android.provider.DocumentsContract.deleteDocument(instrumentation.targetContext.contentResolver, uri)
    }
    @Test(timeout = 90000) fun cancelledPickerNeverCreatesAWriterOrTransfer() {
        val (_, view) = trustedPage()
        evaluate(view, "window.saveChoice='pending';window.createdTransfers=0;WorkbenchFileSave.open('workbench-cancel-proof.txt').then(async out=>{window.createdTransfers++;await out.abort();window.saveChoice='unexpected'}).catch(e=>window.saveChoice=e.name);void 0")
        val picker = device.wait(Until.findObject(By.text(Pattern.compile("(?i)save|保存"))), 15000)
            ?: device.wait(Until.findObject(By.res("com.android.documentsui", "button1")), 5000)
            ?: error("System picker did not open")
        assertNotNull(picker)
        assertEquals("No transfer before Save confirmation", "0", evaluate(view, "window.createdTransfers"))
        device.pressBack()
        val until = System.currentTimeMillis() + 15000
        var result = ""
        while (System.currentTimeMillis() < until) { result = evaluate(view, "window.saveChoice"); if (result != "\"pending\"") break; Thread.sleep(100) }
        assertEquals("\"AbortError\"", result)
        assertEquals("No writer or transfer after cancellation", "0", evaluate(view, "window.createdTransfers"))
    }
    @Test(timeout = 120000) fun secondPickerAllowsFirstWriterAndIndependentCancellation() {
        val (_, view) = trustedPage()
        fun waitValue(expression: String, expected: String) {
            val until = System.currentTimeMillis() + 20000
            while (System.currentTimeMillis() < until) { if (evaluate(view, expression) == expected) return; Thread.sleep(100) }
            assertEquals(expected, evaluate(view, expression))
        }
        fun savePicker() {
            val save = device.wait(Until.findObject(By.text(Pattern.compile("(?i)save|保存"))), 15000)
                ?: device.wait(Until.findObject(By.res("com.android.documentsui", "button1")), 5000)
                ?: error("System save picker missing")
            save.click()
        }
        val suffix = System.currentTimeMillis()
        evaluate(view, "window.multiFirst='pending';window.multiSecond='pending';WorkbenchFileSave.open('qa-first-$suffix.txt').then(out=>{window.firstWriter=out;window.multiFirst='ready'}).catch(e=>window.multiFirst=e.message);WorkbenchFileSave.open('qa-cancel-$suffix.txt').then(out=>{window.secondWriter=out;window.multiSecond='ready'}).catch(e=>window.multiSecond=e.name);void 0")
        savePicker(); waitValue("window.multiFirst", "\"ready\"")
        device.wait(Until.findObject(By.text(Pattern.compile("(?i)save|保存"))), 15000) ?: error("Second picker not queued")
        evaluate(view, "window.multiWrite='pending';firstWriter.write(new TextEncoder().encode('first while second choosing')).then(()=>window.multiWrite='written').catch(e=>window.multiWrite=e.message);void 0")
        waitValue("window.multiWrite", "\"written\"")
        device.pressBack(); waitValue("window.multiSecond", "\"AbortError\"")
        evaluate(view, "window.multiClose='pending';firstWriter.close().then(()=>window.multiClose='closed');void 0")
        waitValue("window.multiClose", "\"closed\"")
        evaluate(view, "window.zeroSave='pending';WorkbenchFileSave.open('qa-empty-$suffix.txt').then(async out=>{await out.close();window.zeroSave='closed'}).catch(e=>window.zeroSave=e.message);void 0")
        savePicker(); waitValue("window.zeroSave", "\"closed\"")
    }

}
