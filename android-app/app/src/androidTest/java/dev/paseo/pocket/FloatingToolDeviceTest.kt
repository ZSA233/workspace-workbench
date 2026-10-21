package dev.paseo.pocket

import android.graphics.Rect
import android.os.SystemClock
import android.view.MotionEvent
import java.io.File
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

@RunWith(AndroidJUnit4::class)
class FloatingToolDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private fun activity(block: (MainActivity) -> Unit) = instrumentation.runOnMainSync {
        block(ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().single())
    }
    private fun click(text: String) {
        val item = device.wait(Until.findObject(By.text(text)), 5000) ?: error("Missing control: $text")
        item.click(); device.waitForIdle(500)
    }

    @Test(timeout = 240000) fun keyboardLandscapeLargeFontAndRepeatedMenus() {
        org.junit.Assume.assumeTrue("Explicitly enable isolated layout checks", InstrumentationRegistry.getArguments().getString("layoutChecks") == "true")
        val context = instrumentation.targetContext
        val oldFont = device.executeShellCommand("settings get system font_scale").trim()
        val captures = File(context.getExternalFilesDir(null), "tool-acceptance").apply { mkdirs() }
        fun capture(name: String) { device.waitForIdle(1000); assertTrue(device.takeScreenshot(File(captures, "$name.png"))) }
        fun open() {
            if (device.hasObject(By.desc("关闭面板"))) return
            val handle = device.wait(Until.findObject(By.desc("Paseo Pocket 工具")), 10000) ?: error("Missing handle")
            handle.click()
            assertNotNull(device.wait(Until.findObject(By.desc("关闭面板")), 5000))
        }
        fun close() {
            device.findObject(By.desc("关闭面板"))?.click()
            assertNotNull(device.wait(Until.findObject(By.desc("Paseo Pocket 工具")), 5000))
        }
        fun reachCache() {
            val scroll = device.findObject(By.clazz(android.widget.ScrollView::class.java))
            scroll?.scroll(androidx.test.uiautomator.Direction.DOWN, 1f)
            assertNotNull(device.wait(Until.findObject(By.descStartsWith("缓存与诊断，")), 5000))
        }
        device.executeShellCommand("am start -n dev.paseo.pocket/.MainActivity")
        try {
            repeat(20) { open(); close() }
            open(); capture("tools-portrait")
            click("更新来源"); click("自定义")
            val input = device.wait(Until.findObject(By.res("dev.paseo.pocket", "update_source_url")), 5000)
            input.click()
            val ime = android.provider.Settings.Secure.getString(context.contentResolver, android.provider.Settings.Secure.DEFAULT_INPUT_METHOD).substringBefore('/')
            assertNotNull("Keyboard must actually appear", device.wait(Until.findObject(By.pkg(ime)), 10000))
            capture("source-keyboard")
            val keyboard = device.findObject(By.pkg(ime)).visibleBounds
            assertTrue("Source input must stay above the keyboard", input.visibleBounds.bottom <= keyboard.top)
            device.pressBack(); device.waitForIdle(1000)
            assertNotNull(device.findObject(By.res("dev.paseo.pocket", "update_source_url")))
            click("返回工具"); close()
            device.setOrientationLeft(); device.waitForIdle(1000)
            open(); reachCache(); capture("tools-landscape"); close()
            device.setOrientationNatural(); device.unfreezeRotation(); device.waitForIdle(1000)
            device.executeShellCommand("wm size 840x1900") // 320dp on the isolated API 37 / 420dpi image.
            device.executeShellCommand("settings put system font_scale 2.0")
            device.waitForIdle(1500)
            open(); reachCache(); capture("tools-320dp-large-font"); close()
        } finally {
            device.findObject(By.desc("关闭面板"))?.click()
            device.executeShellCommand("wm size reset")
            device.executeShellCommand(if (oldFont == "null") "settings delete system font_scale" else "settings put system font_scale $oldFont")
            device.setOrientationNatural(); device.unfreezeRotation()
        }
    }

    @Test(timeout = 60000) fun edgeHandleGridNavigationAndCancelledDrag() {
        val prefs = ShellPreferences(instrumentation.targetContext)
        val oldRight = prefs.dockRight; val oldFraction = prefs.dockFraction
        val oldCustom = prefs.customSource; val oldUrl = prefs.customSourceUrl
        device.executeShellCommand("am start -n dev.paseo.pocket/.MainActivity")
        assertNotNull(device.wait(Until.findObject(By.desc("Paseo Pocket 工具")), 15000))
        try {
            activity { app ->
                val icon = app.packageManager.getApplicationIcon(app.packageName)
                assertTrue(icon is android.graphics.drawable.AdaptiveIconDrawable)
                if (android.os.Build.VERSION.SDK_INT >= 33)
                    assertNotNull((icon as android.graphics.drawable.AdaptiveIconDrawable).monochrome)
                val handle = app.findViewById<FloatingTool>(R.id.floating_tool)
                assertEquals(ShellUi.dp(app, 48), handle.width)
                assertEquals(ShellUi.dp(app, 56), handle.height)
                val start = SystemClock.uptimeMillis()
                for ((action, x) in listOf(MotionEvent.ACTION_DOWN to 24f, MotionEvent.ACTION_MOVE to -1000f, MotionEvent.ACTION_CANCEL to -1000f)) {
                    val event = MotionEvent.obtain(start, SystemClock.uptimeMillis(), action, x, 28f, 0)
                    handle.dispatchTouchEvent(event); event.recycle()
                }
                assertEquals(oldRight, prefs.dockRight)
                assertEquals(oldFraction, prefs.dockFraction, .0001f)
            }
            device.findObject(By.desc("Paseo Pocket 工具")).click()
            val appearance = device.wait(Until.findObject(By.descStartsWith("外观，")), 5000)
            val version = device.findObject(By.descStartsWith("网页版本，"))
            val source = device.findObject(By.descStartsWith("更新来源，"))
            val cache = device.findObject(By.descStartsWith("缓存与诊断，"))
            assertNotNull(appearance); assertNotNull(version); assertNotNull(source); assertNotNull(cache)
            assertEquals(appearance.visibleBounds.top, version.visibleBounds.top)
            assertEquals(source.visibleBounds.top, cache.visibleBounds.top)
            assertTrue(appearance.visibleBounds.right < version.visibleBounds.right)
            val tiles = listOf(appearance, version, source, cache)
            val minimum = ShellUi.dp(instrumentation.targetContext, 106)
            val settled = SystemClock.uptimeMillis() + 5000
            while (tiles.any { it.visibleBounds.height() < minimum } && SystemClock.uptimeMillis() < settled) SystemClock.sleep(100)
            for (tile in tiles) {
                assertTrue("Every tool tile must remain fully visible at its 106dp minimum", tile.visibleBounds.height() >= ShellUi.dp(instrumentation.targetContext, 106))
            }
            assertNull(device.findObject(By.desc("Paseo Pocket 工具")))
            click("外观")
            device.pressBack()
            assertNotNull(device.wait(Until.findObject(By.text("网页版本")), 5000))
            click("更新来源"); click("自定义")
            device.pressBack() // input has not been focused, so back returns to the grid.
            assertEquals("Unsaved source choice must not apply", oldCustom, prefs.customSource)
            assertEquals(oldUrl, prefs.customSourceUrl)
            device.pressBack()
            assertNotNull(device.wait(Until.findObject(By.desc("Paseo Pocket 工具")), 5000))
            val handle = device.findObject(By.desc("Paseo Pocket 工具"))
            val screen = Rect(0, 0, device.displayWidth, device.displayHeight)
            val from = handle.visibleBounds
            val glyphOffset = ShellUi.dp(instrumentation.targetContext, 13)
            device.swipe(if (oldRight) from.right - glyphOffset else from.left + glyphOffset, from.centerY(), 24, screen.centerY(), 25)
            device.waitForIdle(500)
            assertFalse(prefs.dockRight)
            val left = device.findObject(By.desc("Paseo Pocket 工具")).visibleBounds
            device.swipe(left.left + glyphOffset, left.centerY(), device.displayWidth - 24, screen.centerY(), 25)
            device.waitForIdle(500)
            assertTrue(prefs.dockRight)
        } finally {
            device.findObject(By.desc("关闭面板"))?.click()
            instrumentation.runOnMainSync { prefs.dockRight = oldRight; prefs.dockFraction = oldFraction }
            activity { app -> app.findViewById<FloatingTool>(R.id.floating_tool).apply { refreshAppearance(); requestLayout() } }
        }
    }
}
