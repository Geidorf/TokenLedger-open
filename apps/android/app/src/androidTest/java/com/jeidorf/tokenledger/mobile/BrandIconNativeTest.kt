package com.jeidorf.tokenledger.mobile

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** T10.222b：QA/Debug 包中的 Launcher 自适应图标与海报真实绘制证据。 */
class BrandIconNativeTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val targetContext get() = instrumentation.targetContext.applicationContext

    @Test
    fun adaptiveLauncherLayersAndFivePosterLayoutsRenderToEvidence() {
        requireDebugOrQaTarget()
        assumeTrue("monochrome layer contract requires Android 13+", Build.VERSION.SDK_INT >= 33)

        val evidence = evidenceDirectory()
        val launcher = requireNotNull(targetContext.getDrawable(R.mipmap.ic_launcher))
        val round = requireNotNull(targetContext.getDrawable(R.mipmap.ic_launcher_round))
        assertTrue("ic_launcher 应为自适应图标", launcher is AdaptiveIconDrawable)
        assertTrue("ic_launcher_round 应为自适应图标", round is AdaptiveIconDrawable)

        listOf("launcher" to launcher, "launcher-round" to round).forEach { (name, drawable) ->
            val adaptive = drawable as AdaptiveIconDrawable
            val foreground = requireNotNull(adaptive.foreground) { "$name foreground 缺失" }
            saveDrawable(foreground, evidence, "$name-foreground.png")
            val monochrome = adaptive.monochrome
            assertNotNull("$name monochrome layer 缺失", monochrome)
            saveDrawable(requireNotNull(monochrome), evidence, "$name-monochrome.png")
            saveDrawable(adaptive, evidence, "$name-composed.png")
        }

        val summary = ShareSummary(
            range = RangeKey.Week,
            title = "匿名协作摘要",
            periodLabel = "本周",
            effectiveTokens = 0L,
            inputTokens = 0L,
            outputTokens = 0L,
            cachedTokens = 0L,
            totalRequests = 0L,
            deltaPercent = null,
            activeDays = null,
            longestStreakDays = null,
            peakLabel = null,
            peakTokens = null,
            cacheReusePercent = null,
            costCny = null,
            netSavedCostCny = null,
            topTool = null,
            topModel = null,
            points = emptyList(),
            highlight = "",
            dataSourceLabel = "匿名 QA 夹具",
            generatedDateLabel = "2026.10.01",
            includesEstimates = false,
            stale = false,
            costMasked = true
        )
        ShareLayoutKey.entries.forEach { layout ->
            val bitmap = SharePosterRenderer.render(targetContext, summary, layout)
            assertEquals("${layout.stableKey} 海报宽度", 1080, bitmap.width)
            assertEquals("${layout.stableKey} 海报高度", 1920, bitmap.height)
            val png = SharePosterRenderer.encodePng(bitmap)
            assertTrue("${layout.stableKey} PNG 不应为空", png.isNotEmpty())
            File(evidence, "poster-${layout.stableKey}.png").writeBytes(png)
            bitmap.recycle()
        }
        instrumentation.sendStatus(0, Bundle().apply {
            putString("stream", "T10.222b 写入普通/圆形/monochrome 图层与五种匿名海报证据至 ${evidence.absolutePath}\n")
        })
    }

    private fun saveDrawable(drawable: Drawable, directory: File, filename: String) {
        val bitmap = Bitmap.createBitmap(432, 432, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        drawable.setBounds(0, 0, bitmap.width, bitmap.height)
        drawable.draw(canvas)
        assertTrue("$filename 必须绘制可见像素", hasVisiblePixels(bitmap))
        File(directory, filename).outputStream().use { output ->
            assertTrue("$filename PNG 写入失败", bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
        }
        bitmap.recycle()
    }

    private fun hasVisiblePixels(bitmap: Bitmap): Boolean {
        for (y in 0 until bitmap.height step 4) for (x in 0 until bitmap.width step 4) {
            if (bitmap.getPixel(x, y) ushr 24 != 0) return true
        }
        return false
    }

    private fun requireDebugOrQaTarget() {
        val packageName = targetContext.packageName
        check(packageName.endsWith(".debug") || packageName.endsWith(".qa")) {
            "T10.222b evidence fixture may run only in a Debug or QA package: $packageName"
        }
    }

    private fun evidenceDirectory(): File = File(targetContext.filesDir, "evidence/T10.222").apply { mkdirs() }
}
