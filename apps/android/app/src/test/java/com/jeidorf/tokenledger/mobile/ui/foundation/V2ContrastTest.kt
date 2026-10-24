package com.jeidorf.tokenledger.mobile.ui.foundation

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 身份色当小字（来源块、路由页 Agent 块里的缩写）必须达到 WCAG AA 4.5:1。
 * 改动前实测：深色 3.49～5.76，浅色 2.79～3.61（底色是同色 16～18% 的色块）。
 */
class V2ContrastTest {

    private val themes = listOf(LedgerPalettes.Dark, LedgerPalettes.Light)

    @Test
    fun `contrast ratio matches the WCAG reference values`() {
        assertEquals(21f, contrastRatio(Color.Black, Color.White), 0.01f)
        assertEquals(1f, contrastRatio(Color.White, Color.White), 0.001f)
    }

    @Test
    fun `identity initials on their tinted tile reach AA in every chart slot`() {
        themes.forEach { c ->
            val backgrounds = mapOf("card" to c.card, "surfaceContainerLow" to c.surfaceContainerLow)
            c.chart.forEachIndexed { slot, color ->
                backgrounds.forEach { (name, surface) ->
                    listOf(0.16f, 0.18f).forEach { alpha ->
                        val tile = color.copy(alpha = alpha).compositeOver(surface)
                        val readable = readableOn(color, tile, c.text)
                        val ratio = contrastRatio(readable, tile)
                        assertTrue(
                            "${c.appearance} chart-${slot + 1} on $name@$alpha = %.2f:1".format(ratio),
                            ratio >= 4.5f
                        )
                    }
                }
            }
        }
    }

    @Test
    fun `colors that already pass are left untouched`() {
        val dark = LedgerPalettes.Dark
        assertEquals(dark.text, readableOn(dark.text, dark.card, dark.muted))
    }

    @Test
    fun `adjusted colors move only as far as needed`() {
        val light = LedgerPalettes.Light
        val color = light.chart[1]
        val tile = color.copy(alpha = 0.16f).compositeOver(light.card)
        val readable = readableOn(color, tile, light.text)
        assertTrue(contrastRatio(readable, tile) < 5.0f)
    }
}
