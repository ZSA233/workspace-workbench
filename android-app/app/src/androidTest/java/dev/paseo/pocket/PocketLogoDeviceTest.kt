package dev.paseo.pocket

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import androidx.annotation.DrawableRes
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PocketLogoDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    private fun render(drawable: Drawable, size: Int = 432): Bitmap =
        Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888).also { bitmap ->
            drawable.setBounds(0, 0, size, size)
            drawable.draw(Canvas(bitmap))
        }

    private fun snapshot(name: String, bitmap: Bitmap) {
        if (InstrumentationRegistry.getArguments().getString("pocketLogoSnapshots") != "true") return
        val dir = File(context.cacheDir, "logo-verification").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun tintedMark(@DrawableRes id: Int): Bitmap {
        val mark = requireNotNull(ContextCompat.getDrawable(context, id)).mutate().apply {
            setTint(Color.rgb(53, 109, 93))
        }
        val result = render(mark)
        var tinted = 0
        for (y in 0 until result.height) for (x in 0 until result.width) {
            val pixel = result.getPixel(x, y)
            if (Color.alpha(pixel) > 200) {
                assertTrue("Small mark should accept the theme tint", Color.red(pixel) in 52..54 && Color.green(pixel) in 108..110 && Color.blue(pixel) in 92..94)
                tinted++
            }
        }
        assertTrue("Small mark must be visible", tinted > 1000)
        return result
    }

    @Test fun adaptiveAndSmallMarksRenderWithinBounds() {
        val foreground = render(requireNotNull(ContextCompat.getDrawable(context, R.drawable.ic_launcher_foreground)))
        var white = 0
        var mint = 0
        for (y in 0 until foreground.height) for (x in 0 until foreground.width) {
            val pixel = foreground.getPixel(x, y)
            if (Color.alpha(pixel) == 0) continue
            // The central 66 x 66 dp area survives standard adaptive icon masks.
            assertTrue("Foreground must stay inside the adaptive safe area", x in 84 until 348 && y in 84 until 348)
            if (Color.red(pixel) > 245 && Color.green(pixel) > 245 && Color.blue(pixel) > 245) white++
            if (Color.red(pixel) in 150..190 && Color.green(pixel) in 200..240 && Color.blue(pixel) in 170..210) mint++
        }
        assertTrue("Paseo mark must be visible", white > 1000)
        assertTrue("Pocket face must be visible", mint > 1000)

        val inline = tintedMark(R.drawable.ic_pocket_mark)
        val handle = tintedMark(R.drawable.ic_paseo_mark)

        val launcher = context.packageManager.getApplicationIcon(context.packageName)
        assertTrue(launcher is AdaptiveIconDrawable)
        snapshot("foreground", foreground)
        snapshot("launcher", render(launcher))
        snapshot("inline", inline)
        snapshot("handle", handle)
        if (Build.VERSION.SDK_INT >= 33) {
            val themed = (launcher as AdaptiveIconDrawable).monochrome
            assertNotNull("Themed launcher icon must be available", themed)
            val monochrome = render(requireNotNull(themed))
            var visible = 0
            for (y in 0 until monochrome.height) for (x in 0 until monochrome.width)
                if (Color.alpha(monochrome.getPixel(x, y)) > 0) visible++
            assertTrue("Themed launcher icon must render", visible > 1000)
            snapshot("monochrome", monochrome)
        }
    }
}
