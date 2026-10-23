package com.jeidorf.tokenledger.mobile

import androidx.compose.animation.core.TweenSpec
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jeidorf.tokenledger.mobile.ui.foundation.LEDGER_CHART_SLOTS
import com.jeidorf.tokenledger.mobile.ui.foundation.LEDGER_CHART_SLOT_OTHER
import com.jeidorf.tokenledger.mobile.ui.foundation.LEDGER_HEAT_LEVELS
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerColors
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerPalettes
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSize
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerTypography
import com.jeidorf.tokenledger.mobile.ui.foundation.V2BadgeTone
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_ACTION
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_TEXT
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_TOUCH_TARGET
import com.jeidorf.tokenledger.mobile.ui.foundation.ledgerColorScheme
import com.jeidorf.tokenledger.mobile.ui.foundation.v2BadgeColors
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FirstFittingIndex
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FittedFontSizes
import com.jeidorf.tokenledger.mobile.ui.foundation.v2QuotaBandColor
import com.jeidorf.tokenledger.mobile.ui.foundation.v2WithFontSize
import com.jeidorf.tokenledger.mobile.widget.WidgetColors
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * T10.177（T10.173 §3 A0）：单一色源 `LedgerTokens.kt` 与由它派生的一切。
 *
 * 这里钉的是「派生关系」而不是色值本身——色值的对比度在 [MobileV2PaletteContrastTest]：
 * M3 36 个槽位逐个来自令牌、`v2Palette` 旧字段是哪个角色的别名、小组件与启动窗口 XML
 * 取的是哪一档、工具身份落在哪个图表槽、间距是否在 4dp 栅格上、动效关闭时是否归零。
 */
class LedgerTokensTest {

    private val themes = listOf(LedgerPalettes.Dark, LedgerPalettes.Light, LedgerPalettes.EInk)

    // ---------------------------------------------------------------------
    // 色板结构
    // ---------------------------------------------------------------------

    @Test
    fun everyThemeHasEightChartSlotsAndFiveHeatLevels() {
        themes.forEach { c ->
            assertEquals("${c.appearance} chart", LEDGER_CHART_SLOTS, c.chart.size)
            assertEquals("${c.appearance} heat", LEDGER_HEAT_LEVELS, c.heat.size)
            (1..LEDGER_CHART_SLOTS).forEach { slot -> assertEquals(c.chart[slot - 1], c.chartSlot(slot)) }
            assertEquals("槽位按 8 取模", c.chartSlot(1), c.chartSlot(9))
            assertEquals("热力 0 级就是 raised", c.raised, c.heat.first())
        }
    }

    @Test
    fun chartPaletteIsUserChoiceB() {
        // U-4（2026-09-25）用户选方案 B：深浅两套逐值钉住，与桌面 `--chart-1…8` 同值同序（桌面由另一任务同步）。
        assertEquals(
            listOf(
                Color(0xFF6B9DFF), Color(0xFF907ADC), Color(0xFF2DD4BF), Color(0xFFFBBF24),
                Color(0xFFFB7185), Color(0xFF3FE480), Color(0xFF3DBDF7), Color(0xFFFB923C)
            ),
            LedgerPalettes.Dark.chart
        )
        assertEquals(
            listOf(
                Color(0xFF2F6BE6), Color(0xFF8972FE), Color(0xFF0D9488), Color(0xFFD57501),
                Color(0xFFD41340), Color(0xFF16A34A), Color(0xFF1D85C3), Color(0xFFD34C04)
            ),
            LedgerPalettes.Light.chart
        )
        // 语义色不跟着图表色改（U-4 只动 chart）。
        assertEquals(Color(0xFFC4B5FD), LedgerPalettes.Dark.accent)
        assertEquals(Color(0xFF6FD99B), LedgerPalettes.Dark.success)
        assertEquals(Color(0xFF7C3AED), LedgerPalettes.Light.brand2)
    }

    @Test
    fun heatAndTertiaryDeriveFromTheChart() {
        // P3-11：热力 1–4 级与 M3 tertiary 从图表色派生，重调 chart 时不会停在旧色相。
        // 派生结果仍逐值等于 §3.8 的取值。
        assertEquals(
            listOf(Color(0xFF2D2D33), Color(0x476B9DFF), Color(0x806B9DFF), Color(0xBD6B9DFF), Color(0xFF6B9DFF)),
            LedgerPalettes.Dark.heat
        )
        assertEquals(
            listOf(Color(0xFFF1F1F4), Color(0x332F6BE6), Color(0x662F6BE6), Color(0xA82F6BE6), Color(0xFF2F6BE6)),
            LedgerPalettes.Light.heat
        )
        listOf(LedgerPalettes.Dark, LedgerPalettes.Light).forEach { c ->
            c.heat.drop(1).forEach { level ->
                assertEquals("${c.appearance} 热力只用 chart-1 的色相", c.chart[0], level.copy(alpha = 1f))
            }
            assertTrue("${c.appearance} 热力 alpha 逐级递增", c.heat.drop(1).zipWithNext().all { (a, b) -> a.alpha < b.alpha })
        }
        themes.forEach { c -> assertEquals("${c.appearance} tertiary = chart-3", c.chart[2], c.tertiary) }
    }

    @Test
    fun chartOtherMatchesTheDesktopNeutral() {
        // R-16：「其他」与桌面 T10.178 的 TOOL_COLOR_OTHER_*（--color-text-muted）同值；墨水屏取网格灰。
        assertEquals(Color(0xFFA5ACB9), LedgerPalettes.Dark.chartOther)
        assertEquals(Color(0xFF586273), LedgerPalettes.Light.chartOther)
        assertEquals(Color(0xFF8C8C8C), LedgerPalettes.EInk.chartOther)
        themes.forEach { c -> assertEquals(c.chartOther, c.chartSlot(LEDGER_CHART_SLOT_OTHER)) }
    }

    @Test
    fun paletteLookupMatchesAppearance() {
        LedgerAppearance.entries.forEach { appearance ->
            val colors = LedgerPalettes.of(appearance)
            assertEquals(appearance, colors.appearance)
            assertEquals(appearance == LedgerAppearance.EInk, colors.isEInk)
            assertEquals(appearance == LedgerAppearance.Dark, colors.isDark)
        }
    }

    @Test
    fun einkPaletteHasNoHueAndNoTranslucency() {
        val c = LedgerPalettes.EInk
        val transparentAllowed = setOf("ambientStart", "ambientEnd", "cardHighlight", "shadow", "pillShadow", "scrim")
        roles(c).forEach { (name, color) ->
            if (name in transparentAllowed) {
                assertEquals("墨水屏 $name 只能是全透明", 0f, color.alpha, 0f)
            } else {
                assertEquals("墨水屏 $name 不许半透明", 1f, color.alpha, 0f)
                assertTrue("墨水屏 $name 不许有色相：$color", color.red == color.green && color.green == color.blue)
            }
        }
        val black = Color(0xFF000000)
        listOf(
            c.primary, c.primaryFill, c.accent, c.brand1, c.brand2, c.success, c.successText, c.warning,
            c.warningText, c.danger, c.dangerText, c.divider, c.outline, c.cardBorder, c.popoverBorder,
            c.selected, c.text
        ).forEach { assertEquals(black, it) }
        c.chart.forEach { assertEquals("墨水屏图表只靠线型与纹理区分，色值一律纯黑", black, it) }
        assertEquals(
            listOf(Color(0xFFF2F2F2), Color(0xFFC8C8C8), Color(0xFF969696), Color(0xFF5A5A5A), black),
            c.heat
        )
        assertEquals("选中态反白", Color(0xFFFFFFFF), c.onSelected)
    }

    @Test
    fun dividerAndOutlineAreSeparateRoles() {
        // #237：装饰线与功能边界分开。深浅色的 divider 半透明、outline 不透明；墨水屏两者都是纯黑。
        listOf(LedgerPalettes.Dark, LedgerPalettes.Light).forEach { c ->
            assertTrue("${c.appearance} divider 应是半透明发丝线", c.divider.alpha < 0.2f)
            assertEquals("${c.appearance} outline 必须不透明", 1f, c.outline.alpha, 0f)
            assertTrue(c.divider != c.outline)
        }
        assertEquals(LedgerPalettes.EInk.divider, LedgerPalettes.EInk.outline)
    }

    // ---------------------------------------------------------------------
    // Material 3 主题（§3.2）
    // ---------------------------------------------------------------------

    @Test
    fun materialColorSchemeAssignsEverySlotFromTokens() {
        themes.forEach { c ->
            val s = ledgerColorScheme(c)
            val expected = linkedMapOf(
                "primary" to c.primary, "onPrimary" to c.onPrimary,
                "primaryContainer" to c.primaryContainerSolid, "onPrimaryContainer" to c.onPrimaryContainer,
                "inversePrimary" to c.inversePrimary,
                "secondary" to c.accent, "onSecondary" to c.onAccent,
                "secondaryContainer" to c.primaryContainerSolid, "onSecondaryContainer" to c.onPrimaryContainer,
                "tertiary" to c.tertiary, "onTertiary" to c.onTertiary,
                "tertiaryContainer" to c.raised, "onTertiaryContainer" to c.text,
                "background" to c.page, "onBackground" to c.text,
                "surface" to c.page, "onSurface" to c.text,
                "surfaceVariant" to (if (c.isEInk) c.card else c.raised), "onSurfaceVariant" to c.muted,
                "surfaceTint" to c.page,
                "inverseSurface" to c.inverseSurface, "inverseOnSurface" to c.inverseOnSurface,
                "error" to c.danger, "onError" to c.onError,
                "errorContainer" to c.errorContainer, "onErrorContainer" to c.onErrorContainer,
                "outline" to c.outline, "outlineVariant" to c.divider,
                "scrim" to c.scrim,
                "surfaceBright" to c.surfaceBright, "surfaceContainer" to c.raised,
                "surfaceContainerHigh" to c.surfaceContainerHigh, "surfaceContainerHighest" to c.surfaceContainerHighest,
                "surfaceContainerLow" to c.surfaceContainerLow, "surfaceContainerLowest" to c.surfaceContainerLowest,
                "surfaceDim" to c.surfaceDim
            )
            val actual = linkedMapOf(
                "primary" to s.primary, "onPrimary" to s.onPrimary,
                "primaryContainer" to s.primaryContainer, "onPrimaryContainer" to s.onPrimaryContainer,
                "inversePrimary" to s.inversePrimary,
                "secondary" to s.secondary, "onSecondary" to s.onSecondary,
                "secondaryContainer" to s.secondaryContainer, "onSecondaryContainer" to s.onSecondaryContainer,
                "tertiary" to s.tertiary, "onTertiary" to s.onTertiary,
                "tertiaryContainer" to s.tertiaryContainer, "onTertiaryContainer" to s.onTertiaryContainer,
                "background" to s.background, "onBackground" to s.onBackground,
                "surface" to s.surface, "onSurface" to s.onSurface,
                "surfaceVariant" to s.surfaceVariant, "onSurfaceVariant" to s.onSurfaceVariant,
                "surfaceTint" to s.surfaceTint,
                "inverseSurface" to s.inverseSurface, "inverseOnSurface" to s.inverseOnSurface,
                "error" to s.error, "onError" to s.onError,
                "errorContainer" to s.errorContainer, "onErrorContainer" to s.onErrorContainer,
                "outline" to s.outline, "outlineVariant" to s.outlineVariant,
                "scrim" to s.scrim,
                "surfaceBright" to s.surfaceBright, "surfaceContainer" to s.surfaceContainer,
                "surfaceContainerHigh" to s.surfaceContainerHigh, "surfaceContainerHighest" to s.surfaceContainerHighest,
                "surfaceContainerLow" to s.surfaceContainerLow, "surfaceContainerLowest" to s.surfaceContainerLowest,
                "surfaceDim" to s.surfaceDim
            )
            assertEquals("M3 ColorScheme 应有 36 个槽位", 36, expected.size)
            assertEquals("${c.appearance} 的 M3 槽位没有全部来自令牌", expected, actual)
        }
    }

    @Test
    fun materialSchemeMatchesSection32Values() {
        val dark = ledgerColorScheme(LedgerPalettes.Dark)
        assertEquals(Color(0xFFA5B4FC), dark.primary)
        assertEquals(Color(0xFF383A49), dark.primaryContainer)
        assertEquals(Color(0xFF232327), dark.surfaceContainerLow)
        assertEquals(Color(0xFF2D2D33), dark.surfaceContainer)
        assertEquals(Color(0xFF303036), dark.surfaceContainerHigh)
        assertEquals(Color(0xFF3A3A42), dark.surfaceContainerHighest)
        assertEquals(Color(0xFF45272A), dark.errorContainer)
        assertEquals(Color(0xA8050507), dark.scrim)
        val light = ledgerColorScheme(LedgerPalettes.Light)
        assertEquals(Color(0xFF4F46E5), light.primary)
        assertEquals(Color(0xFFEFEEFD), light.primaryContainer)
        assertEquals(Color(0xFFF9F9FB), light.surfaceContainerLow)
        assertEquals(Color(0xFFF1F1F4), light.surfaceContainer)
        assertEquals(Color(0xFFE9E9EE), light.surfaceContainerHigh)
        assertEquals(Color(0xFFFBE9E9), light.errorContainer)
        assertEquals(Color(0x4714161E), light.scrim)
        val eink = ledgerColorScheme(LedgerPalettes.EInk)
        assertEquals("墨水屏只有 surfaceContainer 不是白", Color(0xFFF2F2F2), eink.surfaceContainer)
        listOf(
            eink.surface, eink.background, eink.surfaceVariant, eink.surfaceContainerLowest, eink.surfaceContainerLow,
            eink.surfaceContainerHigh, eink.surfaceContainerHighest, eink.surfaceDim, eink.surfaceBright
        ).forEach { assertEquals(Color(0xFFFFFFFF), it) }
    }

    @Test
    fun typographySlotsAreTheLedgerTypeStyles() {
        // P3-5：上面只钉字号；这里钉整份样式（字重、行高、字距、tnum），映射改错一个槽就红。
        val t = LedgerTypography
        assertEquals(LedgerType.numXL, t.displayLarge)
        assertEquals(LedgerType.numL, t.displayMedium)
        assertEquals(LedgerType.numM, t.displaySmall)
        assertEquals(LedgerType.numM, t.headlineLarge)
        assertEquals(LedgerType.numM, t.headlineMedium)
        assertEquals(LedgerType.titleL, t.headlineSmall)
        assertEquals(LedgerType.titleL, t.titleLarge)
        assertEquals(LedgerType.titleM, t.titleMedium)
        assertEquals(LedgerType.titleS, t.titleSmall)
        assertEquals(LedgerType.meta, t.bodySmall)
        assertEquals(LedgerType.label, t.labelLarge)
        assertEquals(LedgerType.labelS, t.labelMedium)
        assertEquals(LedgerType.caption, t.labelSmall)
        // Text() 的默认值（root 2026-09-25）：只定字号与常规字重，不带行高。
        assertEquals(TextStyle(fontWeight = FontWeight.Normal, fontSize = 14.sp), t.bodyLarge)
        assertEquals(TextStyle(fontWeight = FontWeight.Normal, fontSize = 12.sp), t.bodyMedium)
        // 各样式的字重与行高（§3.7）。
        val weightsAndLineHeights = linkedMapOf(
            "numXL" to (LedgerType.numXL.fontWeight to LedgerType.numXL.lineHeight),
            "numL" to (LedgerType.numL.fontWeight to LedgerType.numL.lineHeight),
            "numM" to (LedgerType.numM.fontWeight to LedgerType.numM.lineHeight),
            "numS" to (LedgerType.numS.fontWeight to LedgerType.numS.lineHeight),
            "titleL" to (LedgerType.titleL.fontWeight to LedgerType.titleL.lineHeight),
            "titleM" to (LedgerType.titleM.fontWeight to LedgerType.titleM.lineHeight),
            "titleS" to (LedgerType.titleS.fontWeight to LedgerType.titleS.lineHeight),
            "bodyL" to (LedgerType.bodyL.fontWeight to LedgerType.bodyL.lineHeight),
            "body" to (LedgerType.body.fontWeight to LedgerType.body.lineHeight),
            "label" to (LedgerType.label.fontWeight to LedgerType.label.lineHeight),
            "labelS" to (LedgerType.labelS.fontWeight to LedgerType.labelS.lineHeight),
            "meta" to (LedgerType.meta.fontWeight to LedgerType.meta.lineHeight),
            "caption" to (LedgerType.caption.fontWeight to LedgerType.caption.lineHeight)
        )
        val semi = FontWeight.SemiBold
        val medium = FontWeight.Medium
        val normal = FontWeight.Normal
        assertEquals(
            linkedMapOf(
                "numXL" to (semi to 44.sp), "numL" to (semi to 36.sp), "numM" to (semi to 28.sp), "numS" to (semi to 22.sp),
                "titleL" to (semi to 28.sp), "titleM" to (semi to 24.sp), "titleS" to (semi to 20.sp),
                "bodyL" to (normal to 24.sp), "body" to (normal to 22.sp), "label" to (medium to 20.sp),
                "labelS" to (medium to 16.sp), "meta" to (normal to 18.sp), "caption" to (medium to 16.sp)
            ),
            weightsAndLineHeights
        )
    }

    @Test
    fun typographySlotsFollowSection37WithLegacyBodyDefaults() {
        val t = LedgerTypography
        val sizes = linkedMapOf(
            "displayLarge" to t.displayLarge.fontSize, "displayMedium" to t.displayMedium.fontSize,
            "displaySmall" to t.displaySmall.fontSize, "headlineLarge" to t.headlineLarge.fontSize,
            "headlineMedium" to t.headlineMedium.fontSize, "headlineSmall" to t.headlineSmall.fontSize,
            "titleLarge" to t.titleLarge.fontSize, "titleMedium" to t.titleMedium.fontSize,
            "titleSmall" to t.titleSmall.fontSize, "bodyLarge" to t.bodyLarge.fontSize,
            "bodyMedium" to t.bodyMedium.fontSize, "bodySmall" to t.bodySmall.fontSize,
            "labelLarge" to t.labelLarge.fontSize, "labelMedium" to t.labelMedium.fontSize,
            "labelSmall" to t.labelSmall.fontSize
        )
        val expected = linkedMapOf(
            "displayLarge" to 40.sp, "displayMedium" to 32.sp,
            "displaySmall" to 24.sp, "headlineLarge" to 24.sp,
            "headlineMedium" to 24.sp, "headlineSmall" to 20.sp,
            "titleLarge" to 20.sp, "titleMedium" to 16.sp,
            "titleSmall" to 14.sp,
            // root 2026-09-25：Text() 的默认样式 A0 保持 14 / 12，最后一个 A 任务再切到 16 / 14。
            "bodyLarge" to 14.sp, "bodyMedium" to 12.sp,
            "bodySmall" to 12.sp, "labelLarge" to 14.sp, "labelMedium" to 12.sp, "labelSmall" to 11.sp
        )
        assertEquals(expected, sizes)
    }

    @Test
    fun fontScaleAndTextStylesStayOnTheLadder() {
        assertEquals(
            listOf(11.sp, 12.sp, 14.sp, 16.sp, 20.sp, 24.sp, 32.sp, 40.sp),
            listOf(
                LedgerFont.caption, LedgerFont.label, LedgerFont.body, LedgerFont.subtitle,
                LedgerFont.title, LedgerFont.headline, LedgerFont.displaySmall, LedgerFont.display
            )
        )
        val ladder = setOf(
            LedgerFont.caption, LedgerFont.label, LedgerFont.body, LedgerFont.subtitle,
            LedgerFont.title, LedgerFont.headline, LedgerFont.displaySmall, LedgerFont.display
        )
        val styles = mapOf(
            "numXL" to LedgerType.numXL, "numL" to LedgerType.numL, "numM" to LedgerType.numM,
            "numS" to LedgerType.numS, "titleL" to LedgerType.titleL, "titleM" to LedgerType.titleM,
            "titleS" to LedgerType.titleS, "bodyL" to LedgerType.bodyL, "body" to LedgerType.body,
            "label" to LedgerType.label, "labelS" to LedgerType.labelS, "meta" to LedgerType.meta,
            "caption" to LedgerType.caption
        )
        styles.forEach { (name, style) ->
            assertTrue("$name 的字号 ${style.fontSize} 不在 LedgerFont 档上", style.fontSize in ladder)
            assertTrue("$name 的行高必须不小于字号", style.lineHeight.value >= style.fontSize.value)
            val tabular = style.fontFeatureSettings == TABULAR_NUMERALS
            assertEquals("$name：只有数字样式用 tnum", name.startsWith("num"), tabular)
        }
        // 多行中文正文行高 ≥ 1.5 倍（§3.7）。
        assertTrue(LedgerType.body.lineHeight.value / LedgerType.body.fontSize.value >= 1.5f)
        assertTrue(LedgerType.bodyL.lineHeight.value / LedgerType.bodyL.fontSize.value >= 1.5f)
        // 徽标 24dp = caption 行高 16 + 上下各 4。
        assertEquals(16f, LedgerType.caption.lineHeight.value, 0f)
    }

    // ---------------------------------------------------------------------
    // 旧色板别名、小组件、启动窗口
    // ---------------------------------------------------------------------

    @Test
    fun mobileV2PaletteFieldsAreAliasesOfTokenRoles() {
        LedgerAppearance.entries.forEach { appearance ->
            val p = v2Palette(appearance)
            val c = LedgerPalettes.of(appearance)
            assertSame("每套外观共享一个色板实例", p, v2Palette(appearance))
            assertSame(c, p.tokens)
            assertEquals(c.page, p.background)
            assertEquals(c.card, p.surface)
            assertEquals(c.surfaceContainerLow, p.surfaceContainerLow)
            assertEquals(c.raised, p.surfaceContainer)
            assertEquals(if (c.isEInk) c.raised else c.surfaceContainerHigh, p.surfaceContainerHigh)
            assertEquals(c.raised, p.raised)
            assertEquals(c.primaryContainerSolid, p.selected)
            assertEquals(c.text, p.text)
            assertEquals(c.muted, p.muted)
            assertEquals(c.faint, p.faint)
            assertEquals(c.divider, p.divider)
            assertEquals(c.divider, p.outlineVariant)
            assertEquals(c.outline, p.outline)
            assertEquals(c.primary, p.blue)
            assertEquals(c.onPrimary, p.onBlue)
            assertEquals(c.primaryContainer, p.blueSoft)
            assertEquals(c.successText, p.green)
            assertEquals(c.warningText, p.amber)
            assertEquals(c.accent, p.violet)
            assertEquals(c.dangerText, p.danger)
            assertEquals(c.isEInk, p.isEInk)
        }
    }

    @Test
    fun widgetColorsDeriveFromTheSameTokens() {
        listOf(true to LedgerPalettes.Dark, false to LedgerPalettes.Light).forEach { (night, c) ->
            val w = WidgetColors(night)
            assertEquals(c.card, w.backgroundColor)
            assertEquals(c.raised, w.surfaceColor)
            assertEquals(c.text, w.textColor)
            assertEquals(c.muted, w.mutedColor)
            assertEquals(c.faint, w.faintColor)
            assertEquals(c.divider, w.dividerColor)
            assertEquals(c.primary, w.blueColor)
            // R-17：圆环与进度条轨道取现成的 surfaceContainerHighest（raised 叠在 card 上深色只有 1.08:1）。
            assertEquals(c.surfaceContainerHighest, w.trackColor)
            assertEquals(c.successText, w.greenColor)
            assertEquals(c.warningText, w.amberColor)
            assertEquals(c.warningSoft, w.amberTrackColor)
            assertEquals(c.dangerText, w.dangerColor)
            // 圆环位图：同一个 *Color 的 toArgb()，危险色不再另写一套；同一状态的圆环与进度条同色。
            assertEquals(w.backgroundColor.toArgb(), w.backgroundArgb)
            assertEquals(w.trackColor.toArgb(), w.trackArgb)
            assertEquals(w.blueColor.toArgb(), w.blueArgb)
            assertEquals(w.amberColor.toArgb(), w.amberArgb)
            assertEquals(w.dangerColor.toArgb(), w.dangerArgb)
            // 充足 = 蓝（V-Q1），小组件与应用额度条同一个 primary。
            assertEquals(c.quotaHealthy.toArgb(), w.blueArgb)
        }
    }

    @Test
    fun quotaBandsFollowUserDecisionVQ1() {
        listOf(LedgerPalettes.Dark, LedgerPalettes.Light).forEach { c ->
            assertEquals("充足 = 蓝（primary），与桌面、小组件一致", c.primary, v2QuotaBandColor(c, QuotaSeverity.Healthy))
            assertEquals(c.warning, v2QuotaBandColor(c, QuotaSeverity.Warning))
            assertEquals(c.danger, v2QuotaBandColor(c, QuotaSeverity.Critical))
        }
        QuotaSeverity.entries.forEach { severity ->
            assertEquals("墨水屏不用色相表达档位", LedgerPalettes.EInk.text, v2QuotaBandColor(LedgerPalettes.EInk, severity))
        }
    }

    @Test
    fun badgeColorsUseSoftContainersAndTextShades() {
        listOf(LedgerPalettes.Dark, LedgerPalettes.Light).forEach { c ->
            val positive = v2BadgeColors(c, V2BadgeTone.Positive)
            assertEquals(c.successSoft, positive.container)
            assertEquals(c.successText, positive.content)
            assertEquals(c.success, positive.dot)
            assertEquals(null, positive.border)
            val neutral = v2BadgeColors(c, V2BadgeTone.Neutral)
            assertEquals(c.raised, neutral.container)
            assertEquals(c.muted, neutral.content)
        }
        V2BadgeTone.entries.forEach { tone ->
            val eink = v2BadgeColors(LedgerPalettes.EInk, tone)
            assertEquals("墨水屏徽标透明底", 0f, eink.container.alpha, 0f)
            assertEquals("墨水屏徽标靠 1dp 黑边区分", LedgerPalettes.EInk.outline, eink.border)
            assertEquals(LedgerPalettes.EInk.text, eink.content)
        }
    }

    @Test
    fun launchWindowColorsMatchTokens() {
        val dark = LedgerPalettes.Dark
        for (path in listOf("src/main/res/values/colors.xml", "src/main/res/values-night/colors.xml")) {
            val colors = readColorResources(path)
            assertEquals("$path 只放启动窗口需要的颜色", setOf("tl_paper", "tl_primary"), colors.keys)
            assertEquals("$path tl_paper 必须等于 page", hex(dark.page), colors.getValue("tl_paper"))
            assertEquals("$path tl_primary 必须等于 primary", hex(dark.primary), colors.getValue("tl_primary"))
        }
        val styles = resourceFile("src/main/res/values/styles.xml").readText()
        listOf("android:windowBackground", "android:statusBarColor", "android:navigationBarColor").forEach { item ->
            assertTrue("$item 应取 @color/tl_paper", Regex("""name="$item">@color/tl_paper<""").containsMatchIn(styles))
        }
        assertTrue("colorAccent 应取 @color/tl_primary", styles.contains("""name="android:colorAccent">@color/tl_primary<"""))
        assertTrue("styles.xml 不许再写色值字面量", !Regex("""#[0-9A-Fa-f]{6}""").containsMatchIn(styles))
    }

    // ---------------------------------------------------------------------
    // 工具身份色（§3.8，用户决定 V-Q6）
    // ---------------------------------------------------------------------

    @Test
    fun toolChartSlotFollowsTheSlotTable() {
        val table = mapOf(
            1 to listOf("antigravity", "gemini"),
            2 to listOf("codex", "marvis", "hermes"),
            3 to listOf("pi"),
            4 to listOf("opencode", "workbuddy"),
            5 to listOf("reasonix", "deepseek", "grok"),
            6 to listOf("claude", "qclaw"),
            7 to listOf("kilo", "kimi", "trae"),
            8 to listOf("minimax", "zcode")
        )
        table.forEach { (slot, names) ->
            names.forEach { name ->
                assertEquals(name, slot, toolChartSlot(name))
                assertEquals("$name 大写", slot, toolChartSlot(name.uppercase()))
                assertEquals("$name 首尾空白（R-8 a 先规范化）", slot, toolChartSlot("  ${name.uppercase()}\t"))
            }
        }
        // R-8 b：别名先归到本名再查表，两端逐字相同（以桌面 T10.178 的别名表为准）。
        val aliases = listOf(
            "deepseekgui" to "deepseek", "dsh" to "deepseek", "kimidesktop" to "kimi", "mavis" to "marvis"
        )
        aliases.forEach { (alias, canonical) ->
            assertEquals(alias, toolChartSlot(canonical), toolChartSlot(alias))
            assertEquals("$alias 大写加空白", toolChartSlot(canonical), toolChartSlot(" ${alias.uppercase()} "))
        }
    }

    @Test
    fun unregisteredToolsHashLikeTheDesktop() {
        // 与桌面 T10.178 `hashToolSlot`（FNV-1a 32 位，UTF-16 码元，(h >>> 0) % 8 + 1）逐个对拍的向量；
        // 桌面的固定向量到了以后由 root 合入时对齐两端（R-8 a）。
        val vectors = mapOf(
            "some_future_tool" to 5, "a-brand-new-cli" to 5, "cursor" to 8, "copilot" to 4,
            "windsurf" to 8, "aider" to 3, "amp" to 2, "cline" to 1, "qwen" to 7, "通义灵码" to 7,
            // 旧 Android 表把这两个名字算作 claude；R-8 以桌面别名表为准不再保留，按哈希落槽。
            "claude-code" to 4, "claude code" to 5
        )
        vectors.forEach { (name, slot) -> assertEquals(name, slot, toolChartSlot(name)) }
        // 桌面 T10.178 types.test.ts 的固定向量（['', 'x', 'some_future_tool', '未来工具', 'cursor', 'cline'] → [6, 8, 5, 1, 8, 1]），
        // 两端逐个相同（评审 P3-6 要求补上前面没有的三条）。
        assertEquals(
            listOf(6, 8, 5, 1, 8, 1),
            listOf("", "x", "some_future_tool", "未来工具", "cursor", "cline").map(::toolChartSlot)
        )
        assertEquals("哈希前先去空白、转小写", 8, toolChartSlot("  Cursor \n"))
        // P3-6：首尾空白按 JS `trim()` 的字符集去（去 U+FEFF、不去 U+001C–U+001F），与桌面逐个对拍的结果相同。
        val trimProbes = linkedMapOf(
            "codex\u001C" to 1, "\u001Ccodex" to 7, "\u001F" to 7,
            "\uFEFFcodex" to 2, "codex\uFEFF" to 2, "\uFEFF" to 6,
            "\u00A0Codex\u3000" to 2, "\u2028codex\u2029" to 2, "\u000Bcodex\u000C" to 2,
            "\u180Ecodex" to 1, "\u0085codex" to 8, "codex\u200B" to 6
        )
        trimProbes.forEach { (name, slot) ->
            val shown = name.map { if (it.code < 0x20 || it.code > 0x7E) "\\u%04X".format(it.code) else "$it" }.joinToString("")
            assertEquals("\"$shown\"", slot, toolChartSlot(name))
        }
        (0 until 500).map { "tool-$it" }.forEach { name ->
            val slot = toolChartSlot(name)
            assertTrue("$name 落在 $slot", slot in 1..LEDGER_CHART_SLOTS)
            assertEquals("同名必须同槽", slot, toolChartSlot(name))
        }
    }

    @Test
    fun sameViewCollisionsShiftByRankAndStayReproducible() {
        assertEquals(listOf(6, 2, 3), assignToolChartSlots(listOf("claude", "codex", "pi")))
        assertEquals(listOf(2, 3), assignToolChartSlots(listOf("codex", "marvis")))
        assertEquals(listOf(2, 3), assignToolChartSlots(listOf("marvis", "codex")))
        assertEquals(listOf(2, 3, 4), assignToolChartSlots(listOf("codex", "marvis", "hermes")))
        assertEquals(listOf(1, 6, 2), assignToolChartSlots(listOf("antigravity", "claude", "gemini")))
        assertEquals("8 之后回到 1", listOf(8, 1), assignToolChartSlots(listOf("minimax", "zcode")))
        val eight = listOf("antigravity", "codex", "pi", "opencode", "reasonix", "claude", "kilo", "minimax")
        assertEquals((1..8).toList(), assignToolChartSlots(eight))
        // R-8 d：第 9 名起不再分系列色，统一「其他」。
        assertEquals(
            (1..8).toList() + listOf(LEDGER_CHART_SLOT_OTHER, LEDGER_CHART_SLOT_OTHER),
            assignToolChartSlots(eight + "gemini" + "some_future_tool")
        )
        // 前 8 名大多挤在 2 号槽（mavis 经别名归到 marvis，amp 哈希也落 2），逐个顺延后仍是 8 个不同的槽。
        val crowded = listOf("codex", "marvis", "hermes", "mavis", "amp", "gemini", "antigravity", "zcode", "claude")
        assertEquals(listOf(2, 3, 4, 5, 6, 1, 7, 8, LEDGER_CHART_SLOT_OTHER), assignToolChartSlots(crowded))
        val six = listOf("codex", "claude", "antigravity", "marvis", "kimi", "opencode")
        assertEquals("六个工具同屏不撞色（D3）", 6, assignToolChartSlots(six).distinct().size)
        assertEquals(assignToolChartSlots(six), assignToolChartSlots(six))
        // 「其他」槽取中性色，不落到任何系列色上。
        themes.forEach { c ->
            assertEquals(c.chartOther, c.chartSlot(LEDGER_CHART_SLOT_OTHER))
            if (!c.isEInk) assertTrue("${c.appearance} 「其他」不能与系列色相同", c.chartOther !in c.chart)
        }
        assertTrue("墨水屏「其他」要与纯黑系列分得开", LedgerPalettes.EInk.chartOther != LedgerPalettes.EInk.chart.first())
    }

    // ---------------------------------------------------------------------
    // 数值自动缩字（R-19、评审 E-2 / P3-14）
    // ---------------------------------------------------------------------

    @Test
    fun fittedValueTextStepsDownTheLedgerFontLadder() {
        assertEquals(listOf(16.sp, 14.sp, 12.sp, 11.sp), v2FittedFontSizes(LedgerType.numS.fontSize))
        assertEquals(listOf(24.sp, 20.sp, 16.sp, 14.sp, 12.sp, 11.sp), v2FittedFontSizes(LedgerType.numM.fontSize))
        assertEquals("最小档到 caption 为止，不低于可读下限", listOf(11.sp), v2FittedFontSizes(LedgerFont.caption))
        assertEquals(listOf(16.sp, 14.sp, 12.sp), v2FittedFontSizes(16.sp, minimum = LedgerFont.label))
        // 取第一档放得下的；刚好等宽算放得下；都放不下交给最小档折行（null）。
        assertEquals(0, v2FirstFittingIndex(listOf(80, 70, 60), 100))
        assertEquals(2, v2FirstFittingIndex(listOf(130, 112, 96, 88), 100))
        assertEquals(1, v2FirstFittingIndex(listOf(101, 100), 100))
        assertEquals(null, v2FirstFittingIndex(listOf(130, 120), 100))
        // 换档时行高按同一比例缩：非线性字体缩放（fontScale > 1.05）下 Compose 按「行高 ÷ 字号」折算 sp 行高，
        // 只换字号会让小一档的字行盒反而更高、把整行撑高。
        val caption = LedgerType.numS.v2WithFontSize(LedgerFont.caption)
        assertEquals(LedgerFont.caption, caption.fontSize)
        assertTrue(caption.lineHeight.isSp)
        assertEquals(22f * 11f / 16f, caption.lineHeight.value, 1e-4f)
        assertEquals(
            LedgerType.numS.lineHeight.value / LedgerType.numS.fontSize.value,
            caption.lineHeight.value / caption.fontSize.value,
            1e-6f
        )
        assertEquals("首选档原样返回", LedgerType.numS, LedgerType.numS.v2WithFontSize(LedgerType.numS.fontSize))
        assertEquals("没写行高时只换字号", TextStyle(fontSize = 12.sp), TextStyle(fontSize = 16.sp).v2WithFontSize(12.sp))
    }

    // ---------------------------------------------------------------------
    // 间距、尺寸、厚度、圆角（§3.4–§3.6）
    // ---------------------------------------------------------------------

    @Test
    fun spacingSitsOnTheFourDpGridWithOneNamedHalfStep() {
        assertEquals(2.dp, LedgerSpace.hairline)
        listOf(
            LedgerSpace.xs, LedgerSpace.sm, LedgerSpace.md, LedgerSpace.lg,
            LedgerSpace.xl, LedgerSpace.xxl, LedgerSpace.xxxl
        ).forEach { assertTrue("$it 不在 4dp 栅格上", it.value % 4f == 0f) }
        assertEquals(
            listOf(4.dp, 8.dp, 12.dp, 16.dp, 20.dp, 24.dp, 32.dp),
            listOf(LedgerSpace.xs, LedgerSpace.sm, LedgerSpace.md, LedgerSpace.lg, LedgerSpace.xl, LedgerSpace.xxl, LedgerSpace.xxxl)
        )
    }

    @Test
    fun sizesStrokesAndRadiiMatchTheTables() {
        assertEquals(V2_TOUCH_TARGET, LedgerSize.touchTarget)
        assertEquals(48.dp, V2_TOUCH_TARGET)
        assertEquals(listOf(16.dp, 20.dp, 24.dp), listOf(V2_ICON_TEXT, V2_ICON_INLINE, V2_ICON_ACTION))
        val sizes: List<Dp> = listOf(
            LedgerSize.navigationBar, LedgerSize.topBar, LedgerSize.segmentTrack, LedgerSize.segmentPill,
            LedgerSize.button, LedgerSize.chipVisible, LedgerSize.statusDot, LedgerSize.identityDot,
            LedgerSize.brandMark, LedgerSize.sourceMark, LedgerSize.sourceMarkQuota, LedgerSize.dataBar,
            LedgerSize.quotaBarOverview, LedgerSize.quotaBarPage, LedgerSize.heatCell
        )
        assertEquals(
            listOf(80, 64, 48, 40, 48, 32, 6, 8, 28, 32, 36, 4, 6, 8, 10).map { it.dp },
            sizes
        )
        assertEquals(
            listOf(1.dp, 1.5.dp, 2.dp, 2.dp, 2.25.dp, 1.5.dp, 1.dp, 1.5.dp, 2.dp),
            listOf(
                LedgerStroke.hairline, LedgerStroke.einkCard, LedgerStroke.focus, LedgerStroke.popoverEInk,
                LedgerStroke.currentSeries, LedgerStroke.previousSeries, LedgerStroke.grid,
                LedgerStroke.calendarQuery, LedgerStroke.dataBarCompact
            )
        )
        assertEquals(
            listOf(4.dp, 6.dp, 7.dp, 8.dp, 10.dp, 8.dp),
            listOf(LedgerRadius.xs, LedgerRadius.sm, LedgerRadius.md, LedgerRadius.lg, LedgerRadius.xl, LedgerRadius.einkCard)
        )
        // 同心：分段轨道 10 − 内缩 4 = 胶囊 6；轨道 48 − 2×4 = 胶囊 40。
        assertEquals(LedgerRadius.sm, LedgerRadius.segmentTrack - LedgerSpace.xs)
        assertEquals(LedgerSize.segmentPill, LedgerSize.segmentTrack - LedgerSpace.xs * 2)
    }

    // ---------------------------------------------------------------------
    // 动效（§3.9、§5）
    // ---------------------------------------------------------------------

    @Test
    fun motionTokensMatchTheDesktopPrimitives() {
        assertEquals(
            listOf(90, 120, 150, 180, 180, 220, 240, 320, 40, 4, 480, 300, 1800, 900),
            listOf(
                LedgerMotion.PRESS_MILLIS, LedgerMotion.FAST_MILLIS, LedgerMotion.POP_MILLIS,
                LedgerMotion.UPDATE_MILLIS, LedgerMotion.STANDARD_MILLIS, LedgerMotion.INDICATOR_MILLIS,
                LedgerMotion.EMPHASIZED_MILLIS, LedgerMotion.GROW_MILLIS, LedgerMotion.STAGGER_MILLIS,
                LedgerMotion.STAGGER_MAX_ITEMS, LedgerMotion.CHART_REVEAL_MILLIS,
                LedgerMotion.CHART_UPDATE_MILLIS, LedgerMotion.LIVE_MILLIS, LedgerMotion.SPIN_MILLIS
            )
        )
        assertEquals(0.97f, LedgerMotion.PRESSED_SCALE, 0f)
        assertEquals(10.dp, LedgerMotion.ENTER_OFFSET)
    }

    @Test
    fun disabledMotionCollapsesDurationAndDelayToZero() {
        val on = ledgerTween<Float>(LedgerMotion.INDICATOR_MILLIS, enabled = true, delayMillis = 40, easing = LedgerEasing.EaseOutExpo) as TweenSpec<Float>
        assertEquals(220, on.durationMillis)
        assertEquals(40, on.delay)
        assertSame(LedgerEasing.EaseOutExpo, on.easing)
        val off = ledgerTween<Float>(LedgerMotion.INDICATOR_MILLIS, enabled = false, delayMillis = 40) as TweenSpec<Float>
        assertEquals("关动画时时长归零", 0, off.durationMillis)
        assertEquals("关动画时延迟也归零，否则错开的卡片仍要等", 0, off.delay)
        val default = ledgerTween<Float>(LedgerMotion.FAST_MILLIS) as TweenSpec<Float>
        assertSame("默认曲线是 EaseOutQuart", LedgerEasing.EaseOutQuart, default.easing)
        // 三条曲线的端点与中段形状（单调、先快后慢）。
        listOf(LedgerEasing.EaseOutQuart, LedgerEasing.EaseOutExpo, LedgerEasing.EaseOutCubic).forEach { easing ->
            assertEquals(0f, easing.transform(0f), 1e-4f)
            assertEquals(1f, easing.transform(1f), 1e-4f)
            assertTrue("缓出曲线的中点应已走过一半以上", easing.transform(0.5f) > 0.5f)
        }
    }

    // ---------------------------------------------------------------------

    private fun roles(c: LedgerColors): Map<String, Color> = linkedMapOf(
        "chrome" to c.chrome, "page" to c.page, "card" to c.card, "raised" to c.raised,
        "selected" to c.selected, "onSelected" to c.onSelected, "popover" to c.popover,
        "text" to c.text, "muted" to c.muted, "faint" to c.faint,
        "divider" to c.divider, "outline" to c.outline,
        "primary" to c.primary, "onPrimary" to c.onPrimary, "primaryFill" to c.primaryFill,
        "onPrimaryFill" to c.onPrimaryFill, "primaryContainer" to c.primaryContainer,
        "primaryContainerSolid" to c.primaryContainerSolid, "onPrimaryContainer" to c.onPrimaryContainer,
        "accent" to c.accent, "onAccent" to c.onAccent,
        "brand1" to c.brand1, "brand2" to c.brand2, "brandSoftStart" to c.brandSoftStart,
        "brandSoftEnd" to c.brandSoftEnd, "ambientStart" to c.ambientStart, "ambientEnd" to c.ambientEnd,
        "success" to c.success, "successText" to c.successText, "warning" to c.warning,
        "warningText" to c.warningText, "danger" to c.danger, "dangerText" to c.dangerText,
        "successSoft" to c.successSoft, "warningSoft" to c.warningSoft, "dangerSoft" to c.dangerSoft,
        "cardBorder" to c.cardBorder, "cardHighlight" to c.cardHighlight, "popoverBorder" to c.popoverBorder,
        "shadow" to c.shadow, "pillShadow" to c.pillShadow,
        "chartGrid" to c.chartGrid, "chartAxis" to c.chartAxis,
        "tertiary" to c.tertiary, "onTertiary" to c.onTertiary, "onError" to c.onError,
        "errorContainer" to c.errorContainer, "onErrorContainer" to c.onErrorContainer,
        "surfaceContainerLowest" to c.surfaceContainerLowest, "surfaceContainerLow" to c.surfaceContainerLow,
        "surfaceContainerHigh" to c.surfaceContainerHigh, "surfaceContainerHighest" to c.surfaceContainerHighest,
        "surfaceDim" to c.surfaceDim, "surfaceBright" to c.surfaceBright,
        "inverseSurface" to c.inverseSurface, "inverseOnSurface" to c.inverseOnSurface,
        "inversePrimary" to c.inversePrimary, "scrim" to c.scrim
    )

    /** `#RRGGBB`（不透明色）或 `#AARRGGBB`，大写。 */
    private fun hex(color: Color): String {
        val argb = color.toArgb()
        return if (argb ushr 24 == 0xFF) {
            "#%06X".format(argb and 0xFFFFFF)
        } else {
            "#%08X".format(argb)
        }
    }

    private fun resourceFile(path: String): File =
        listOf(File(path), File("app", path), File("apps/android/app", path)).firstOrNull { it.isFile }
            ?: error("找不到 $path（当前目录 ${File(".").absolutePath}）")

    private fun readColorResources(path: String): Map<String, String> =
        Regex("""<color name="(\w+)">(#[0-9A-Fa-f]{6,8})</color>""")
            .findAll(resourceFile(path).readText())
            .associate { it.groupValues[1] to it.groupValues[2].uppercase() }
}
