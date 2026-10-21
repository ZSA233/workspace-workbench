package dev.paseo.pocket

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import androidx.webkit.WebViewCompat
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LegacyWebViewDeviceTest {
    @Test(timeout = 30000) fun oldProviderShowsNativeUpgradeUiInsteadOfBlankPage() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val version = WebViewCompat.getCurrentWebViewPackage(context)?.versionName?.substringBefore('.')?.toIntOrNull() ?: 0
        assumeTrue(version in 1 until WebRuntime.MINIMUM_CHROMIUM)
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        device.executeShellCommand("am start -n ${context.packageName}/dev.paseo.pocket.MainActivity")
        assertNotNull(device.wait(Until.findObject(By.text("系统 WebView 版本过旧")), 15000))
        assertNotNull(device.findObject(By.text("更新系统 WebView")))
        device.findObject(By.desc("Paseo Pocket 工具")).click()
        assertNotNull(device.wait(Until.findObject(By.text("网页更新")), 3000))
        device.pressBack()
    }
}
