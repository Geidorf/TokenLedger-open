package com.jeidorf.tokenledger.mobile

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_CONTROL_HEIGHT
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_SEGMENT_INSET
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_TOUCH_TARGET
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.v2SegmentTrackHeight
import com.jeidorf.tokenledger.mobile.ui.foundation.v2SegmentedToggleWidth
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.pow

/**
 * Empirical adversarial challenge and stress-test suite for Milestone 1:
 * Modern Design System Overhaul (M3 & HIG Standards).
 *
 * Covers:
 * 1. Responsive layout breakpoints (320dp, 390dp, 430dp) & dynamic font scaling (1.0, 1.5, 2.0).
 * 2. Visual boundary clarity, elevation contracts, and WCAG AA contrast verification across Light, Dark, and EInk.
 * 3. Component geometry, touch target compliance, and font scale overflow boundaries.
 */
class Milestone1DesignChallengerStressTest {

    // =========================================================================
    // Challenge 1: Responsive Layout Breakpoints & Dynamic Font Scaling Limits
    // =========================================================================

    @Test
    fun verifyDashboardLayoutModeAcrossBreakpointsAndFontScales() {
        val widths = listOf(320, 359, 360, 390, 412, 430, 600, 840)
        val fontScales = listOf(0.85f, 1.0f, 1.15f, 1.30f, 1.49f, 1.5f, 1.75f, 2.0f, 2.5f)

        for (w in widths) {
            for (fs in fontScales) {
                val mode = dashboardLayoutMode(w, fs)
                val expectedCompact = w < 360 || fs >= 1.5f
                val expectedMode = if (expectedCompact) DashboardLayoutMode.Compact else DashboardLayoutMode.Standard
                assertEquals("Layout mode mismatch at width=$w, fontScale=$fs", expectedMode, mode)
            }
        }
    }

    @Test
    fun verifyHeroValuesStackingAcrossBreakpointsAndFontScales() {
        // Standard phone widths
        val compactPhoneWidth = 320   // Small budget/compact Android
        val standardPhoneWidth = 390  // iPhone / standard Android
        val largePhoneWidth = 430     // Pro Max / Ultra

        // Font scale 1.0 (standard)
        assertTrue("320dp at 1.0x font must stack hero values to avoid clipping", shouldStackDashboardHeroValues(1.0f, compactPhoneWidth))
        assertFalse("390dp at 1.0x font must keep side-by-side row", shouldStackDashboardHeroValues(1.0f, standardPhoneWidth))
        assertFalse("430dp at 1.0x font must keep side-by-side row", shouldStackDashboardHeroValues(1.0f, largePhoneWidth))

        // Font scale 1.5 (large / accessibility)
        assertTrue("320dp at 1.5x font must stack hero values", shouldStackDashboardHeroValues(1.5f, compactPhoneWidth))
        assertTrue("390dp at 1.5x font must stack hero values to avoid overlap", shouldStackDashboardHeroValues(1.5f, standardPhoneWidth))
        assertTrue("430dp at 1.5x font must stack hero values to avoid overlap", shouldStackDashboardHeroValues(1.5f, largePhoneWidth))

        // Font scale 2.0 (maximum accessibility)
        assertTrue("320dp at 2.0x font must stack hero values", shouldStackDashboardHeroValues(2.0f, compactPhoneWidth))
        assertTrue("390dp at 2.0x font must stack hero values", shouldStackDashboardHeroValues(2.0f, standardPhoneWidth))
        assertTrue("430dp at 2.0x font must stack hero values", shouldStackDashboardHeroValues(2.0f, largePhoneWidth))
    }

    @Test
    fun verifySharePeriodSelectorWrappingResilience() {
        // Under 350dp or fontScale >= 1.5f must wrap
        assertTrue("320dp at 1.0x must wrap share period selector", shouldWrapSharePeriodSelector(320, 1.0f))
        assertFalse("390dp at 1.0x must not wrap share period selector", shouldWrapSharePeriodSelector(390, 1.0f))
        assertFalse("430dp at 1.0x must not wrap share period selector", shouldWrapSharePeriodSelector(430, 1.0f))

        assertTrue("390dp at 1.5x must wrap share period selector", shouldWrapSharePeriodSelector(390, 1.5f))
        assertTrue("430dp at 2.0x must wrap share period selector", shouldWrapSharePeriodSelector(430, 2.0f))
    }

    @Test
    fun verifySegmentedToggleWidthCalculationAndScreenCapacity() {
        // 3 segments (e.g. Day, Week, Month)
        val width3 = v2SegmentedToggleWidth(3)
        // (48 + 1) * 3 + 4 * 2 + 4 * 2 = 147 + 8 + 8 = 163.dp
        assertEquals(163.dp, width3)
        assertTrue("3-segment toggle must fit within 320dp screen with 16dp margins (width <= 288dp)", width3.value <= 288f)

        // 4 segments (e.g. Trend, Sources, Calendar, Details)
        val width4 = v2SegmentedToggleWidth(4)
        // (49) * 4 + 4 * 3 + 8 = 196 + 12 + 8 = 216.dp
        assertEquals(216.dp, width4)
        assertTrue("4-segment toggle must fit within 320dp screen with 16dp margins", width4.value <= 288f)

        // 5 segments
        val width5 = v2SegmentedToggleWidth(5)
        // 49 * 5 + 4 * 4 + 8 = 245 + 16 + 8 = 269.dp
        assertEquals(269.dp, width5)
        assertTrue("5-segment toggle must fit within 320dp screen with 16dp margins", width5.value <= 288f)

        // Degenerate / Boundary checks
        assertEquals(v2SegmentedToggleWidth(1), v2SegmentedToggleWidth(0))
        assertEquals(v2SegmentedToggleWidth(1), v2SegmentedToggleWidth(-5))
    }

    @Test
    fun verifySegmentedToggleHeightScalingWithFontScale() {
        // T10.177（T10.173 §4.3）：轨道高 = max(48, 分段文字行高 + 16)，触达高 = max(48, 轨道高)。
        // 分段文字是 LedgerType.label（14sp / 行高 20sp）。此前的公式是「label 12sp × 倍率 + 18，
        // 再另加 8dp 触达区」，默认字号下占 56dp；新规格可见即触达，48dp 一行。
        // 这里按线性倍率换算行高；生产代码用 Density.toDp()，Android 14 起的非线性放大只会更小。
        fun heights(fontScale: Float): Pair<Float, Float> {
            val lineHeight = (LedgerType.label.lineHeight.value * fontScale).dp
            val visible = v2SegmentTrackHeight(lineHeight)
            val touch = maxOf(V2_TOUCH_TARGET, visible)
            return visible.value to touch.value
        }

        assertEquals(20f, LedgerType.label.lineHeight.value, 0.001f)
        assertEquals(48.dp, V2_CONTROL_HEIGHT)

        val (vis10, touch10) = heights(1.0f)
        // 20 + 16 = 36 <= 48
        assertEquals("At 1.0x font, visible height is minimum 48dp", 48f, vis10, 0.001f)
        assertEquals("At 1.0x font, touch height equals the visible track", 48f, touch10, 0.001f)

        val (vis15, touch15) = heights(1.5f)
        // 30 + 16 = 46 <= 48
        assertEquals("At 1.5x font, visible height stays at minimum 48dp", 48f, vis15, 0.001f)
        assertEquals("At 1.5x font, touch height stays at 48dp", 48f, touch15, 0.001f)

        val (vis20, touch20) = heights(2.0f)
        // 40 + 16 = 56 > 48
        assertEquals("At 2.0x font, visible height grows to 56dp", 56f, vis20, 0.001f)
        assertEquals("At 2.0x font, touch height follows the track", 56f, touch20, 0.001f)

        val (vis30, touch30) = heights(3.0f)
        // 60 + 16 = 76
        assertEquals("At 3.0x font, visible height scales up to 76dp", 76f, vis30, 0.001f)
        assertEquals("At 3.0x font, touch height scales up to 76dp", 76f, touch30, 0.001f)
    }

    // =========================================================================
    // Challenge 2: Boundary Clarity, Elevation Contracts, and WCAG AA Contrast
    // =========================================================================

    private fun linearize(channel: Float): Double {
        val cs = channel.toDouble()
        return if (cs <= 0.03928) cs / 12.92 else ((cs + 0.055) / 1.055).pow(2.4)
    }

    private fun luminance(color: Color): Double =
        0.2126 * linearize(color.red) + 0.7152 * linearize(color.green) + 0.0722 * linearize(color.blue)

    private fun contrast(a: Color, b: Color): Double {
        val la = luminance(a)
        val lb = luminance(b)
        val (light, dark) = if (la >= lb) la to lb else lb to la
        return (light + 0.05) / (dark + 0.05)
    }

    @Test
    fun verifyLightModeTonalSurfaceHierarchyAndTextContrast() {
        val light = v2Palette(LedgerAppearance.Light)
        val tokens = light.tokens

        // 1. Surface hierarchy actually used by the UI (T10.173 §3.2–§3.3, T10.177).
        // 旧断言钉的是 M3 默认的 surfaceContainerLow > surfaceContainer > High 阶梯；新方案有意改为
        // 「外壳 < 页面 < 卡片 / 浮层」加卡内 raised 块，surfaceContainerLow 已无调用方，不再断言。
        val lumChrome = luminance(tokens.chrome)
        val lumPage = luminance(light.background)
        val lumCard = luminance(light.surface)
        val lumRaised = luminance(light.raised)
        val lumHigh = luminance(light.surfaceContainerHigh)

        assertEquals("Light background is the page tier", tokens.page, light.background)
        assertEquals("Light surface is the card tier", tokens.card, light.surface)
        assertTrue("Light card must be brighter than the page it sits on", lumCard > lumPage)
        assertTrue("Light page must be brighter than the chrome (navigation / system bars)", lumPage > lumChrome)
        assertTrue("Light raised blocks must be darker than the page, so they read inside white cards", lumPage > lumRaised)
        assertTrue("Light surfaceContainerHigh is the deeper in-card fill, darker than raised", lumRaised > lumHigh)
        assertEquals("Light popover (sheets, menus) is white like cards", tokens.card, tokens.popover)

        // 2. Verify WCAG AA text contrast on surface (>= 4.5:1 for body/muted/faint)
        val textContrast = contrast(light.text, light.surface)
        val mutedContrast = contrast(light.muted, light.surface)
        val faintContrast = contrast(light.faint, light.surface)

        assertTrue("Light text/surface contrast must be >= 4.5 (got $textContrast)", textContrast >= 4.5)
        assertTrue("Light muted/surface contrast must be >= 4.5 (got $mutedContrast)", mutedContrast >= 4.5)
        assertTrue("Light faint/surface contrast must be >= 4.5 (got $faintContrast)", faintContrast >= 4.5)

        // 3. Verify text contrast on background
        val textBgContrast = contrast(light.text, light.background)
        val mutedBgContrast = contrast(light.muted, light.background)
        assertTrue("Light text/background contrast must be >= 4.5 (got $textBgContrast)", textBgContrast >= 4.5)
        assertTrue("Light muted/background contrast must be >= 4.0 (got $mutedBgContrast)", mutedBgContrast >= 4.0)

        // 4. Verify interactive buttons & chips
        val onBlueContrast = contrast(light.onBlue, light.blue)
        assertTrue("Light onBlue/blue contrast must be >= 4.5 (got $onBlueContrast)", onBlueContrast >= 4.5)
    }

    @Test
    fun verifyDarkModeTonalSurfaceHierarchyAndTextContrast() {
        val dark = v2Palette(LedgerAppearance.Dark)
        val tokens = dark.tokens

        // 1. Surface hierarchy in the dark theme (T10.173 §3.2–§3.3): each step up is lighter —
        // chrome #0A0C10 < page #0D0F13 < card #15181E < raised #1B1F26 < popover #1D2129 < selected #2A303B.
        val tiers = listOf(
            "chrome" to tokens.chrome,
            "page" to dark.background,
            "card" to dark.surface,
            "raised" to dark.surfaceContainer,
            "popover" to tokens.popover,
            "selected" to tokens.selected
        )
        tiers.zipWithNext().forEach { (lower, upper) ->
            assertTrue(
                "Dark ${lower.first} must be darker than ${upper.first}",
                luminance(lower.second) < luminance(upper.second)
            )
        }
        assertEquals("Dark surfaceContainerHigh is the popover tone", tokens.popover, dark.surfaceContainerHigh)

        // 2. Verify WCAG AA text contrast on surface (>= 4.5:1)
        val textContrast = contrast(dark.text, dark.surface)
        val mutedContrast = contrast(dark.muted, dark.surface)
        val faintContrast = contrast(dark.faint, dark.surface)

        assertTrue("Dark text/surface contrast must be >= 4.5 (got $textContrast)", textContrast >= 4.5)
        assertTrue("Dark muted/surface contrast must be >= 4.5 (got $mutedContrast)", mutedContrast >= 4.5)
        assertTrue("Dark faint/surface contrast must be >= 4.5 (got $faintContrast)", faintContrast >= 4.5)

        // 3. Verify interactive buttons & chips
        val onBlueContrast = contrast(dark.onBlue, dark.blue)
        assertTrue("Dark onBlue/blue contrast must be >= 4.5 (got $onBlueContrast)", onBlueContrast >= 4.5)
    }

    @Test
    fun verifyEInkStructuralBoundaryIntegrity() {
        val eink = v2Palette(LedgerAppearance.EInk)

        // EInk must enforce structural borders because color contrast is unavailable
        assertTrue("EInk mode must declare isEInk = true", eink.isEInk)

        // Structural divider must meet WCAG non-text contrast minimum (>= 3.0:1)
        val divBgContrast = contrast(eink.divider, eink.background)
        val divSurfContrast = contrast(eink.divider, eink.surface)
        assertTrue("EInk divider/background contrast must be >= 3.0 (got $divBgContrast)", divBgContrast >= 3.0)
        assertTrue("EInk divider/surface contrast must be >= 3.0 (got $divSurfContrast)", divSurfContrast >= 3.0)

        // EInk text must be pure black on white
        assertEquals(Color.Black, eink.text)
        assertEquals(Color.White, eink.surface)
        assertEquals(Color.Black, eink.divider)
    }

    // =========================================================================
    // Challenge 3: Corner Radii & Geometry Consistency
    // =========================================================================

    @Test
    fun verifyCornerRadiusHierarchy() {
        // T10.173 §3.4 五档圆角（T10.177 起读生产令牌，不再在测试里各写一份）：
        // 6 表格徽标 < 8 胶囊与芯片 < 12 按钮与分段轨道 < 16 卡片 < 20 底部面板与对话框；墨水屏卡片统一 8。
        assertTrue("Badge radius must be smaller than pill radius", LedgerRadius.xs < LedgerRadius.sm)
        assertTrue("Pill radius must be smaller than control radius", LedgerRadius.sm < LedgerRadius.md)
        assertTrue("Control radius must be smaller than card radius", LedgerRadius.md < LedgerRadius.lg)
        assertTrue("Card radius must be smaller than sheet radius", LedgerRadius.lg < LedgerRadius.xl)
        assertEquals(16.dp, LedgerRadius.lg)
        assertEquals("E-Ink card radius is 8dp", 8.dp, LedgerRadius.einkCard)
        // 同心：分段轨道 12 − 内缩 4 = 胶囊 8。
        assertEquals(LedgerRadius.sm, LedgerRadius.md - V2_SEGMENT_INSET)
    }
}
