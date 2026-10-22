package com.jeidorf.tokenledger.mobile

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2BadgeTone
import com.jeidorf.tokenledger.mobile.ui.foundation.v2BadgeColors
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import com.jeidorf.tokenledger.mobile.ui.quota.v2QuotaRemainingFraction
import com.jeidorf.tokenledger.mobile.ui.quota.v2RelativeReset
import com.jeidorf.tokenledger.mobile.ui.quota.v2SeverityColor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.Instant
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Adversarial Challenger Stress Test Suite for Milestone 3:
 * Information De-noising & Progressive Disclosure (M15 / R3).
 *
 * Empirical verification covers:
 * 1. Responsive layout at 320dp viewport width & dynamic font scaling (1.5x - 2.0x).
 * 2. Boundary conditions: 0 quota, 100% quota, missing reset dates, extreme long names.
 * 3. Mathematical verification of WCAG 2.1 AA contrast ratios for the production V2StatusBadge
 *    colours ([v2BadgeColors], T10.177 tokens) across the Light, Dark and E-Ink palettes.
 */
class Milestone3DenoisingChallengerStressTest {

    // =========================================================================
    // Challenge 1: Responsive Layout at 320dp & Dynamic Font Scaling (1.5x - 2.0x)
    // =========================================================================

    @Test
    fun verifyHeroValuesStackingAcrossBreakpointsAndFontScales() {
        val compactPhoneWidth = 320
        val standardPhoneWidth = 390
        val largePhoneWidth = 430

        // 320dp width must ALWAYS stack hero values to avoid clipping across all font scales
        assertTrue("320dp at 1.0x font must stack hero values", shouldStackDashboardHeroValues(1.0f, compactPhoneWidth))
        assertTrue("320dp at 1.5x font must stack hero values", shouldStackDashboardHeroValues(1.5f, compactPhoneWidth))
        assertTrue("320dp at 2.0x font must stack hero values", shouldStackDashboardHeroValues(2.0f, compactPhoneWidth))

        // Standard and large phones keep side-by-side at 1.0x, but MUST stack at 1.5x and 2.0x
        assertFalse("390dp at 1.0x font remains side-by-side", shouldStackDashboardHeroValues(1.0f, standardPhoneWidth))
        assertTrue("390dp at 1.5x font must stack", shouldStackDashboardHeroValues(1.5f, standardPhoneWidth))
        assertTrue("390dp at 2.0x font must stack", shouldStackDashboardHeroValues(2.0f, standardPhoneWidth))

        assertFalse("430dp at 1.0x font remains side-by-side", shouldStackDashboardHeroValues(1.0f, largePhoneWidth))
        assertTrue("430dp at 1.5x font must stack", shouldStackDashboardHeroValues(1.5f, largePhoneWidth))
        assertTrue("430dp at 2.0x font must stack", shouldStackDashboardHeroValues(2.0f, largePhoneWidth))
    }

    @Test
    fun verifyV2ProviderCardDetailsButtonWidthScaling() {
        // TextButton width in V2ProviderCard: maxOf(64f, 48f * fontScale).dp
        fun detailButtonWidth(fontScale: Float) = maxOf(64f, 48f * fontScale).dp

        assertEquals(64.dp, detailButtonWidth(1.0f))
        assertEquals(72.dp, detailButtonWidth(1.5f))
        assertEquals(96.dp, detailButtonWidth(2.0f))

        // On a 320dp viewport with 16dp outer card padding (available = 288dp)
        // Ensure detail button leaves sufficient room (>150dp) for provider name & status badge
        val cardInnerWidth = 288f - 24f
        val remainingForHeaderAt200 = cardInnerWidth - detailButtonWidth(2.0f).value - 8f
        assertTrue("Header column must have at least 150dp width at font scale 2.0x", remainingForHeaderAt200 >= 150f)
    }

    @Test
    fun verifyV2SourceRowStackingThresholds() {
        // V2SourceRow: val stacked = maxWidth < 280.dp || LocalDensity.current.fontScale > 1.3f
        fun isStacked(maxWidthDp: Float, fontScale: Float) = maxWidthDp < 280f || fontScale > 1.3f

        // Under 280dp (e.g. 320dp screen inside nested cards) -> stacked regardless of font scale
        assertTrue("270dp at 1.0x must be stacked", isStacked(270f, 1.0f))

        // At standard 390dp width:
        assertFalse("350dp at 1.0x must not be stacked", isStacked(350f, 1.0f))
        assertFalse("350dp at 1.2x must not be stacked", isStacked(350f, 1.2f))
        assertTrue("350dp at 1.5x must be stacked", isStacked(350f, 1.5f))
        assertTrue("350dp at 2.0x must be stacked", isStacked(350f, 2.0f))
    }

    // =========================================================================
    // Challenge 2: Boundary Conditions (0 Quota, 100% Quota, Missing Dates, Long Names)
    // =========================================================================

    @Test
    fun verifyZeroQuotaBoundaryCondition() {
        // Case A: 0% used, 100% remaining
        val zeroUsed = QuotaDisplayValue.Progress(
            used = 0.0,
            limit = 100.0,
            remaining = 100.0,
            unit = QuotaUnit.Percent,
            fraction = 0f
        )
        val remainingFractionZeroUsed = v2QuotaRemainingFraction(zeroUsed)
        assertEquals(1.0f, remainingFractionZeroUsed, 0.0001f)
        val severityZeroUsed = quotaSeverityForFraction(remainingFractionZeroUsed)
        assertEquals(QuotaSeverity.Healthy, severityZeroUsed)

        val lightPalette = v2Palette(LedgerAppearance.Light)
        assertEquals(lightPalette.green, v2SeverityColor(lightPalette, severityZeroUsed))

        // Case B: 0 quota remaining (100% exhausted)
        val fullyExhausted = QuotaDisplayValue.Progress(
            used = 100.0,
            limit = 100.0,
            remaining = 0.0,
            unit = QuotaUnit.Percent,
            fraction = 1.0f
        )
        val remainingFractionExhausted = v2QuotaRemainingFraction(fullyExhausted)
        assertEquals(0.0f, remainingFractionExhausted, 0.0001f)
        val severityExhausted = quotaSeverityForFraction(remainingFractionExhausted)
        assertEquals(QuotaSeverity.Critical, severityExhausted)
        assertEquals(lightPalette.danger, v2SeverityColor(lightPalette, severityExhausted))

        // Case C: Over-quota (120% used, -20% remaining)
        val overQuota = QuotaDisplayValue.Progress(
            used = 120.0,
            limit = 100.0,
            remaining = -20.0,
            unit = QuotaUnit.Percent,
            fraction = 1.0f
        )
        val remainingFractionOver = v2QuotaRemainingFraction(overQuota)
        assertEquals("Remaining fraction must be clamped to 0f", 0.0f, remainingFractionOver, 0.0001f)
        assertEquals(QuotaSeverity.Critical, quotaSeverityForFraction(remainingFractionOver))
    }

    @Test
    fun verifyMissingAndCorruptResetDatesResilience() {
        val now = Instant.parse("2026-09-16T12:00:00Z")

        // Null reset date -> returns "未知"
        assertEquals("未知", v2RelativeReset(null, now))

        // Empty reset date -> returns "未知"
        assertEquals("未知", v2RelativeReset("", now))
        assertEquals("未知", v2RelativeReset("   ", now))

        // Malformed reset date -> returns "未知"
        assertEquals("未知", v2RelativeReset("not-a-timestamp", now))
        assertEquals("未知", v2RelativeReset("2026-99-99T99:99:99Z", now))

        // Elapsed reset date -> "已到期"
        val past = now.minus(Duration.ofMinutes(15)).toString()
        assertEquals("已到期", v2RelativeReset(past, now))

        // Minutes scale
        val in45m = now.plus(Duration.ofMinutes(45)).toString()
        assertEquals("45 分钟后", v2RelativeReset(in45m, now))

        // Hours scale
        val in4h = now.plus(Duration.ofHours(4)).toString()
        assertEquals("4 小时后", v2RelativeReset(in4h, now))

        // Days scale
        val in3d = now.plus(Duration.ofDays(3)).toString()
        assertEquals("3 天后", v2RelativeReset(in3d, now))
    }

    @Test
    fun verifyExtremeLongProviderAndModelNamesResilience() {
        val longProviderName = "A".repeat(500)
        val longModelName = "gpt-4o-" + "very-long-specialized-fine-tuned-model-architecture-identifier-".repeat(10)
        val longWindowName = "Hourly-Rate-Limit-Window-" + "0123456789".repeat(20)

        // Verify QuotaWindowSnapshot handles extreme strings without crashing
        val window = QuotaWindowSnapshot(
            providerId = "p1",
            windowId = "w1",
            windowLabel = longWindowName,
            scope = QuotaScope.ConsumerSubscription,
            source = QuotaSource.OfficialApi,
            status = QuotaWindowStatus.Ok,
            used = 10.0,
            limit = 100.0,
            remaining = 90.0,
            unit = QuotaUnit.Percent,
            windowMinutes = 60,
            resetsAt = null,
            observedAt = "2026-09-16T12:00:00Z",
            fetchedAt = "2026-09-16T12:00:00Z",
            staleAfterSeconds = 3600,
            reasonCode = null
        )

        val envelope = QuotaProviderEnvelope(
            schemaVersion = 1,
            providerId = "p1",
            displayName = longProviderName,
            scope = QuotaScope.ConsumerSubscription,
            mode = QuotaMode.Automatic,
            capability = QuotaCapability.Stable,
            status = QuotaProviderStatus.Ok,
            windows = listOf(window),
            reasonCode = null
        )

        val presentation = quotaCardPresentation(envelope, Instant.parse("2026-09-16T12:00:00Z"), false)
        assertNotNull(presentation)
        assertEquals("已更新", presentation.headline)

        // Verify model distribution handles extreme long model names
        val modelStat = ModelStat(
            name = longModelName,
            total = 100_000L,
            requests = 10L,
            input = 80_000L,
            output = 20_000L,
            cached = 10_000L,
            cost = 1.50
        )
        val dist = modelCostDistribution(listOf(modelStat), 1.50)
        assertEquals(1, dist.size)
        assertEquals(longModelName, dist[0].model.name)
        assertEquals(100.0, dist[0].costSharePercent!!, 0.01)
    }

    // =========================================================================
    // Challenge 3: Mathematical WCAG 2.1 AA Contrast Verification for V2StatusBadge
    // =========================================================================

    private fun sRGBtoLinear(c: Float): Double {
        val cs = c.toDouble()
        return if (cs <= 0.03928) cs / 12.92 else ((cs + 0.055) / 1.055).pow(2.4)
    }

    private fun relativeLuminance(color: Color): Double =
        0.2126 * sRGBtoLinear(color.red) + 0.7152 * sRGBtoLinear(color.green) + 0.0722 * sRGBtoLinear(color.blue)

    private fun contrastRatio(fg: Color, bg: Color): Double {
        val l1 = relativeLuminance(fg)
        val l2 = relativeLuminance(bg)
        val light = max(l1, l2)
        val dark = min(l1, l2)
        return (light + 0.05) / (dark + 0.05)
    }

    /** [fg] 按自身 alpha 压在不透明的 [bg] 上（合成后按 8 位量化，与屏幕一致）。 */
    private fun compositeOver(fg: Color, bg: Color): Color {
        val a = fg.alpha
        return Color(
            red = a * fg.red + (1f - a) * bg.red,
            green = a * fg.green + (1f - a) * bg.green,
            blue = a * fg.blue + (1f - a) * bg.blue
        )
    }

    private data class BadgeContrast(val text: Double, val dot: Double)

    /**
     * 读**生产**的 [v2BadgeColors]（T10.177 起；此前测试里自拼一份徽标色，与界面并不同源），
     * 半透明底先压到 [underlying] 上再量：字对底、状态点对底。墨水屏的透明底即底色本身。
     */
    private fun badgeContrast(palette: MobileV2Palette, tone: V2BadgeTone, underlying: Color): BadgeContrast {
        val colors = v2BadgeColors(palette.tokens, tone)
        val container = compositeOver(colors.container, underlying)
        return BadgeContrast(
            text = contrastRatio(colors.content, container),
            dot = contrastRatio(colors.dot, container)
        )
    }

    @Test
    fun verifyDarkAndEInkStatusBadgesMeetWcagAaRequirements() {
        // Dark theme verification
        val dark = v2Palette(LedgerAppearance.Dark)
        val darkUnderlyings = listOf("background" to dark.background, "surface" to dark.surface)
        V2BadgeTone.entries.forEach { tone ->
            for ((layerName, under) in darkUnderlyings) {
                val ratio = badgeContrast(dark, tone, under)
                assertTrue(
                    "Dark theme badge $tone on $layerName contrast ${String.format("%.3f", ratio.text)}:1 must meet WCAG AA (>=4.5:1)",
                    ratio.text >= 4.5
                )
                assertTrue(
                    "Dark theme badge dot $tone on $layerName ${String.format("%.3f", ratio.dot)}:1 must meet non-text 3:1",
                    ratio.dot >= 3.0
                )
            }
        }

        // E-Ink theme verification: transparent container, black text and dot, black hairline border.
        val eink = v2Palette(LedgerAppearance.EInk)
        val einkUnderlyings = listOf("background" to eink.background, "surface" to eink.surface)
        V2BadgeTone.entries.forEach { tone ->
            assertEquals("E-Ink badge $tone keeps a structural border", eink.tokens.outline, v2BadgeColors(eink.tokens, tone).border)
            for ((layerName, under) in einkUnderlyings) {
                val ratio = badgeContrast(eink, tone, under)
                assertEquals(
                    "E-Ink theme badge $tone on $layerName must have 21:1 perfect contrast",
                    21.0, ratio.text, 0.01
                )
                assertEquals(21.0, ratio.dot, 0.01)
            }
        }
    }

    @Test
    fun verifyLightStatusBadgeContrastAudit() {
        // T10.177（root 授权的加强）：旧版把浅色 Positive / Warning 的不足钉成区间——卡片上 4.40–4.46 与
        // 4.45–4.50、页面底上 4.15–4.25 与 4.20–4.30——等于把缺陷写成了规格。T10.173 §3.1 改用
        // successText #166534 / warningText #8A4B00 配 10% 软底后，五种调性在页面底与卡片上一律 ≥4.5:1
        // （最低一格是 Danger 在页面底 4.59），状态点 ≥3:1。
        val light = v2Palette(LedgerAppearance.Light)
        val lightUnderlyings = listOf("background" to light.background, "surface" to light.surface)

        for ((layerName, under) in lightUnderlyings) {
            for (tone in V2BadgeTone.entries) {
                val ratio = badgeContrast(light, tone, under)
                assertTrue(
                    "Light badge $tone on $layerName contrast ${String.format("%.3f", ratio.text)}:1 must meet WCAG AA (>=4.5:1)",
                    ratio.text >= 4.5
                )
                assertTrue(
                    "Light badge dot $tone on $layerName ${String.format("%.3f", ratio.dot)}:1 must meet non-text 3:1",
                    ratio.dot >= 3.0
                )
            }
        }
    }
}
