package com.jeidorf.tokenledger.mobile

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerColors
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerPalettes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 安卓看板 WCAG 回归闸门（T10.138 立，T10.177 按 T10.173 §3.1 重写）。
 *
 * 断言全部读生产色源 [LedgerPalettes]（及由它派生的 [v2Palette]），不复制任何色值——
 * 色板只要漂移到不达标，这里当场红。对比度按 WCAG 2.x 公式：通道线性化后取
 * L = 0.2126R + 0.7152G + 0.0722B，比值 = (L亮 + 0.05) / (L暗 + 0.05)；半透明色先与底色合成。
 *
 * 分三类：
 * - 文字（正文 ≥4.5:1）：`text / muted / faint / primary / accent / *Text` 落在 `page / card / raised / popover` 上；
 * - 非文字功能边界（≥3:1）：`outline` 对四档表面、图表系列与状态图形在卡片上；
 * - 装饰发丝线：`divider` 在深浅色落在 1.1–2.0:1（既不隐形也不变粗），墨水屏与 `outline` 同为纯黑。
 * 另把 §3.1 对比度表逐格钉住（±0.01），防止令牌抄错一位却仍恰好过线。
 * 此前本文件的注释写着 divider ≥3:1，断言却只剩墨水屏一条（T10.173 D11）。
 */
class MobileV2PaletteContrastTest {

    private val surfaces = listOf("page", "card", "raised", "popover")

    private fun linearize(channel: Float): Double {
        val cs = channel.toDouble()
        return if (cs <= 0.03928) cs / 12.92 else Math.pow((cs + 0.055) / 1.055, 2.4)
    }

    private fun luminance(color: Color): Double =
        0.2126 * linearize(color.red) + 0.7152 * linearize(color.green) + 0.0722 * linearize(color.blue)

    /** 半透明前景先按 alpha 合成到不透明底色上（sRGB 空间，与渲染一致）。 */
    private fun over(foreground: Color, background: Color): Color {
        val a = foreground.alpha
        return Color(
            red = a * foreground.red + (1 - a) * background.red,
            green = a * foreground.green + (1 - a) * background.green,
            blue = a * foreground.blue + (1 - a) * background.blue
        )
    }

    private fun contrast(foreground: Color, background: Color): Double {
        val la = luminance(over(foreground, background))
        val lb = luminance(background)
        val (light, dark) = if (la >= lb) la to lb else lb to la
        return (light + 0.05) / (dark + 0.05)
    }

    private fun assertContrast(name: String, foreground: Color, background: Color, minimum: Double) {
        val ratio = contrast(foreground, background)
        assertTrue(
            "$name 对比度 %.3f:1，低于要求的 %.2f:1".format(ratio, minimum),
            ratio >= minimum
        )
    }

    private fun surface(c: LedgerColors, name: String): Color = when (name) {
        "page" -> c.page
        "card" -> c.card
        "raised" -> c.raised
        "popover" -> c.popover
        else -> error(name)
    }

    private fun role(c: LedgerColors, name: String): Color = when (name) {
        "text" -> c.text
        "muted" -> c.muted
        "faint" -> c.faint
        "primary" -> c.primary
        "accent" -> c.accent
        "successText" -> c.successText
        "warningText" -> c.warningText
        "dangerText" -> c.dangerText
        "outline" -> c.outline
        "divider" -> c.divider
        else -> error(name)
    }

    private val themes = listOf(LedgerPalettes.Dark, LedgerPalettes.Light, LedgerPalettes.EInk)

    @Test
    fun onBlueTextMeetsAaOnBlueButtons() {
        LedgerAppearance.entries.forEach { appearance ->
            val palette = v2Palette(appearance)
            assertContrast("${appearance.name} onBlue/blue", palette.onBlue, palette.blue, 4.5)
        }
    }

    @Test
    fun textAndForegroundMeetAaOnSurfaces() {
        LedgerAppearance.entries.forEach { appearance ->
            val palette = v2Palette(appearance)
            assertContrast("${appearance.name} text/surface", palette.text, palette.surface, 4.5)
            assertContrast("${appearance.name} muted/surface", palette.muted, palette.surface, 4.5)
            assertContrast("${appearance.name} faint/surface", palette.faint, palette.surface, 4.5)
            assertContrast("${appearance.name} text/background", palette.text, palette.background, 4.5)
        }
    }

    @Test
    fun einkStructuralDividerMeetsNonTextMinimum() {
        val eink = v2Palette(LedgerAppearance.EInk)
        assertContrast("EInk divider/background", eink.divider, eink.background, 3.0)
        assertContrast("EInk divider/surface", eink.divider, eink.surface, 3.0)
    }

    @Test
    fun everyTextRoleMeetsAaOnEverySurface() {
        val textRoles = listOf("text", "muted", "faint", "primary", "accent", "successText", "warningText", "dangerText")
        themes.forEach { c ->
            textRoles.forEach { fg ->
                surfaces.forEach { bg ->
                    assertContrast("${c.appearance} $fg/$bg", role(c, fg), surface(c, bg), 4.5)
                }
            }
            // M3 surfaceContainerHigh 是卡内较深的填充（v2 别名），上面同样要能放正文。
            listOf("text", "muted", "faint", "primary").forEach { fg ->
                assertContrast("${c.appearance} $fg/surfaceContainerHigh", role(c, fg), c.surfaceContainerHigh, 4.5)
            }
        }
    }

    @Test
    fun outlineIsAFunctionalBoundaryOnEverySurface() {
        themes.forEach { c ->
            surfaces.forEach { bg -> assertContrast("${c.appearance} outline/$bg", c.outline, surface(c, bg), 3.0) }
            assertContrast("${c.appearance} outline/surfaceContainerHigh", c.outline, c.surfaceContainerHigh, 3.0)
        }
    }

    @Test
    fun dividerIsDecorativeNeitherInvisibleNorHeavy() {
        listOf(LedgerPalettes.Dark, LedgerPalettes.Light).forEach { c ->
            surfaces.forEach { bg ->
                val ratio = contrast(c.divider, surface(c, bg))
                assertTrue("${c.appearance} divider/$bg = %.3f，应在 1.1–2.0".format(ratio), ratio in 1.1..2.0)
            }
        }
        val eink = LedgerPalettes.EInk
        assertEquals("墨水屏的全部分隔用纯黑", Color(0xFF000000), eink.divider)
        assertEquals(Color(0xFF000000), eink.outline)
    }

    @Test
    fun pairedContainersCarryReadableContent() {
        themes.forEach { c ->
            val t = c.appearance
            assertContrast("$t onPrimary/primary", c.onPrimary, c.primary, 4.5)
            assertContrast("$t onPrimaryFill/primaryFill", c.onPrimaryFill, c.primaryFill, 4.5)
            val chip = over(c.primaryContainer, c.card)
            assertContrast("$t onPrimaryContainer/primaryContainer@card", c.onPrimaryContainer, chip, 4.5)
            assertContrast("$t primary/primaryContainer@card", c.primary, chip, 4.5)
            assertContrast("$t onPrimaryContainer/primaryContainerSolid", c.onPrimaryContainer, c.primaryContainerSolid, 4.5)
            assertContrast("$t onSelected/selected", c.onSelected, c.selected, 4.5)
            assertContrast("$t 未选中分段 muted/raised", c.muted, c.raised, 4.5)
            assertContrast("$t 未选中导航 faint/chrome", c.faint, c.chrome, 4.5)
            assertContrast("$t onErrorContainer/errorContainer", c.onErrorContainer, c.errorContainer, 4.5)
            assertContrast("$t onError/error", c.onError, c.danger, 4.5)
            assertContrast("$t onAccent/accent", c.onAccent, c.accent, 4.5)
            assertContrast("$t inverseOnSurface/inverseSurface", c.inverseOnSurface, c.inverseSurface, 4.5)
            assertContrast("$t chartAxis/card", c.chartAxis, c.card, 4.5)
        }
        // 纯色版与压在卡片上的半透明版是同一个颜色（§3.1 表的「约」值）。
        listOf(LedgerPalettes.Dark, LedgerPalettes.Light).forEach { c ->
            val composited = over(c.primaryContainer, c.card)
            assertEquals(c.primaryContainerSolid.red, composited.red, 1.5f / 255)
            assertEquals(c.primaryContainerSolid.green, composited.green, 1.5f / 255)
            assertEquals(c.primaryContainerSolid.blue, composited.blue, 1.5f / 255)
        }
    }

    @Test
    fun graphicsMeetNonTextMinimumOnCards() {
        themes.forEach { c ->
            c.chart.forEachIndexed { index, color ->
                assertContrast("${c.appearance} chart-${index + 1}/card", color, c.card, 3.0)
            }
            listOf("success" to c.success, "warning" to c.warning, "danger" to c.danger).forEach { (name, color) ->
                assertContrast("${c.appearance} $name/card", color, c.card, 3.0)
                assertContrast("${c.appearance} $name/raised", color, c.raised, 3.0)
            }
            // 「其他」中性色（R-8 d）：同样是图形，对卡片与页面 ≥3:1。
            assertContrast("${c.appearance} chartOther/card", c.chartOther, c.card, 3.0)
            assertContrast("${c.appearance} chartOther/page", c.chartOther, c.page, 3.0)
        }
        assertContrast("EInk chartGrid/card", LedgerPalettes.EInk.chartGrid, LedgerPalettes.EInk.card, 3.0)
        // U-4 方案 B：浅色 8 色在页面底上也 ≥3:1（此前 chart-4 只有 2.92，§3.8 因此限定浅色图表只画在卡片上）。
        LedgerPalettes.Light.chart.forEachIndexed { index, color ->
            assertContrast("Light chart-${index + 1}/page", color, LedgerPalettes.Light.page, 3.0)
        }
        // 深色柱尾（0.74）与象限点（0.88）是半透明画的，合成到卡片上仍 ≥3:1；浅色按 R-9 不透明绘制，不在此列。
        val dark = LedgerPalettes.Dark
        dark.chart.forEachIndexed { index, color ->
            listOf(0.88f, 0.74f).forEach { alpha ->
                assertContrast("Dark chart-${index + 1}@$alpha/card", color.copy(alpha = alpha), dark.card, 3.0)
            }
        }
    }

    /** R-16 与 R-17 的实测值（T10.177 修复轮日志引用这些数）。 */
    @Test
    fun otherNeutralAndWidgetTrackMatchRootDecisions() {
        // R-16：「其他」取桌面同值；对齐参考设计 后对卡片深 6.86、浅 6.16（此前借 outline，深 4.17、浅 3.83）。
        assertEquals(6.86, contrast(LedgerPalettes.Dark.chartOther, LedgerPalettes.Dark.card), 0.011)
        assertEquals(6.16, contrast(LedgerPalettes.Light.chartOther, LedgerPalettes.Light.card), 0.011)
        // R-17：挂件轨道对挂件容器深 1.39、浅 1.36（对齐参考设计 后重算；更早取 raised，深 1.08、浅 1.14）。不新增色值，也不求 3:1——
        // 轨道是装饰性的整圈参照，进度本身由填充色与百分比文字表达。
        listOf(true to 1.39, false to 1.36).forEach { (night, expected) ->
            val w = com.jeidorf.tokenledger.mobile.widget.WidgetColors(night)
            val ratio = contrast(w.trackColor, w.backgroundColor)
            assertEquals("${if (night) "深色" else "浅色"}挂件轨道/容器", expected, ratio, 0.011)
            assertTrue("挂件轨道要比旧的 raised 更看得见", ratio > contrast(if (night) LedgerPalettes.Dark.raised else LedgerPalettes.Light.raised, w.backgroundColor))
        }
    }

    /**
     * R-18：范围选择与分段控件的选中态只靠底色时看不出来（选中底对页面深 1.31、浅 1.04；胶囊对轨道深 1.25、浅 1.14），
     * 所以选中项另加 1dp `primary` 描边作非颜色线索。描边两侧——外侧的页面或轨道、内侧的选中底或胶囊——都要 ≥3:1。
     */
    @Test
    fun selectedSegmentOutlineIsVisibleOnBothSides() {
        themes.forEach { c ->
            // V2RangeSelector：选中底 primaryContainerSolid 放在页面上（墨水屏也画这道黑边）。
            assertContrast("${c.appearance} 范围选择描边/page", c.primary, c.page, 3.0)
            assertContrast("${c.appearance} 范围选择描边/选中底", c.primary, c.primaryContainerSolid, 3.0)
        }
        listOf(LedgerPalettes.Dark, LedgerPalettes.Light).forEach { c ->
            // V2SegmentedToggle：胶囊 selected 放在 raised 轨道上。
            assertContrast("${c.appearance} 分段描边/轨道", c.primary, c.raised, 3.0)
            assertContrast("${c.appearance} 分段描边/胶囊", c.primary, c.selected, 3.0)
        }
        // 墨水屏的分段是白轨道上的黑胶囊，不画描边。
        assertContrast("EInk 分段胶囊/轨道", LedgerPalettes.EInk.selected, LedgerPalettes.EInk.card, 3.0)
        val d = LedgerPalettes.Dark
        val l = LedgerPalettes.Light
        assertEquals(8.70, contrast(d.primary, d.page), 0.011)
        assertEquals(5.63, contrast(d.primary, d.primaryContainerSolid), 0.011)
        assertEquals(6.86, contrast(d.primary, d.raised), 0.011)
        assertEquals(4.69, contrast(d.primary, d.selected), 0.011)
        assertEquals(5.77, contrast(l.primary, l.page), 0.011)
        assertEquals(5.48, contrast(l.primary, l.primaryContainerSolid), 0.011)
        assertEquals(5.58, contrast(l.primary, l.raised), 0.011)
        assertEquals(6.29, contrast(l.primary, l.selected), 0.011)
    }

    @Test
    fun textLadderStaysThreeDistinctSteps() {
        themes.forEach { c ->
            val ladder = listOf(c.text, c.muted, c.faint).map { contrast(it, c.raised) }
            assertTrue("${c.appearance} 三档文字不再单调递减：$ladder", ladder[0] > ladder[1] && ladder[1] > ladder[2])
            assertTrue("${c.appearance} muted 与 faint 挤在一起：$ladder", ladder[1] / ladder[2] >= 1.4)
        }
    }

    /** T10.173 §3.1「对比度」表（2026-10 对齐参考设计 后重算），逐格：每格依次是深色 / 浅色 / 墨水屏（墨水屏只在表里给出的行才比）。 */
    @Test
    fun contrastTableMatchesSection31CellByCell() {
        val table: Map<String, List<List<Double?>>> = mapOf(
            "text" to listOf(listOf(14.86, 15.59, 21.00), listOf(13.41, 16.97, 21.00), listOf(11.72, 15.05, 18.76), listOf(11.23, 16.97, 21.00)),
            "muted" to listOf(listOf(9.39, 8.72, 12.63), listOf(8.48, 9.50, 12.63), listOf(7.41, 8.42, 11.29), listOf(7.10, 9.50, 12.63)),
            "faint" to listOf(listOf(6.37, 5.22, 7.00), listOf(5.75, 5.68, 7.00), listOf(5.03, 5.04, 6.26), listOf(4.81, 5.68, 7.00)),
            "primary" to listOf(listOf(8.70, 5.77, 21.00), listOf(7.85, 6.29, 21.00), listOf(6.86, 5.58, 18.76), listOf(6.58, 6.29, 21.00)),
            "accent" to listOf(listOf(9.40, 5.23, null), listOf(8.48, 5.70, null), listOf(7.41, 5.06, null), listOf(7.10, 5.70, null)),
            "successText" to listOf(listOf(9.98, 5.37, null), listOf(9.00, 5.84, null), listOf(7.87, 5.18, null), listOf(7.54, 5.84, null)),
            "warningText" to listOf(listOf(9.47, 5.97, null), listOf(8.55, 6.50, null), listOf(7.47, 5.77, null), listOf(7.16, 6.50, null)),
            "dangerText" to listOf(listOf(7.26, 5.45, null), listOf(6.55, 5.93, null), listOf(5.73, 5.26, null), listOf(5.49, 5.93, null)),
            "outline" to listOf(listOf(4.20, 3.79, null), listOf(3.79, 4.13, null), listOf(3.31, 3.66, null), listOf(3.17, 4.13, null)),
            "divider" to listOf(listOf(1.25, 1.19, null), listOf(1.26, 1.19, null), listOf(1.27, 1.19, null), listOf(1.27, 1.19, null))
        )
        table.forEach { (fg, cells) ->
            cells.forEachIndexed { surfaceIndex, perTheme ->
                val bg = surfaces[surfaceIndex]
                perTheme.forEachIndexed { themeIndex, expected ->
                    if (expected != null) {
                        val c = themes[themeIndex]
                        val actual = contrast(role(c, fg), surface(c, bg))
                        assertEquals("${c.appearance} $fg/$bg", expected, actual, 0.011)
                    }
                }
            }
        }
        // 表下的成对组合。
        assertEquals(9.06, contrast(LedgerPalettes.Dark.onPrimary, LedgerPalettes.Dark.primary), 0.011)
        assertEquals(6.29, contrast(LedgerPalettes.Dark.onPrimaryFill, LedgerPalettes.Dark.primaryFill), 0.011)
        assertEquals(6.29, contrast(LedgerPalettes.Light.onPrimaryFill, LedgerPalettes.Light.primaryFill), 0.011)
        assertEquals(8.01, contrast(LedgerPalettes.Dark.onSelected, LedgerPalettes.Dark.selected), 0.011)
        assertEquals(16.97, contrast(LedgerPalettes.Light.onSelected, LedgerPalettes.Light.selected), 0.011)
        assertEquals(6.69, contrast(LedgerPalettes.Dark.faint, LedgerPalettes.Dark.chrome), 0.011)
        assertEquals(4.82, contrast(LedgerPalettes.Light.faint, LedgerPalettes.Light.chrome), 0.011)
        assertEquals(10.31, contrast(LedgerPalettes.Dark.onErrorContainer, LedgerPalettes.Dark.errorContainer), 0.011)
        assertEquals(8.78, contrast(LedgerPalettes.Light.onErrorContainer, LedgerPalettes.Light.errorContainer), 0.011)
        assertEquals(3.40, contrast(LedgerPalettes.Light.success, LedgerPalettes.Light.raised), 0.011)
        // §3.8：图表系列在卡片上（U-4 方案 B 的取值，数字出自 _coord/scratch/U-4/summary.md §5）。
        assertEquals(
            listOf(5.88, 4.48, 8.41, 9.38, 5.82, 9.41, 7.32, 6.92),
            LedgerPalettes.Dark.chart.map { Math.round(contrast(it, LedgerPalettes.Dark.card) * 100) / 100.0 }
        )
        assertEquals(
            listOf(4.81, 3.56, 3.74, 3.29, 5.29, 3.30, 4.04, 4.37),
            LedgerPalettes.Light.chart.map { Math.round(contrast(it, LedgerPalettes.Light.card) * 100) / 100.0 }
        )
    }

    // ---------------------------------------------------------------------
    // 图表 8 色在色弱下仍分得开（U-4 方案 B，T10.161 门槛）
    // ---------------------------------------------------------------------

    /** Machado, Oliveira & Fernandes（2009）严重度 1.0 的模拟矩阵，作用在线性 RGB 上。 */
    private val machado: Map<String, Array<DoubleArray>> = mapOf(
        "deutan" to arrayOf(
            doubleArrayOf(0.367322, 0.860646, -0.227968), doubleArrayOf(0.280085, 0.672501, 0.047413),
            doubleArrayOf(-0.01182, 0.04294, 0.968881)
        ),
        "protan" to arrayOf(
            doubleArrayOf(0.152286, 1.052583, -0.204868), doubleArrayOf(0.114503, 0.786281, 0.099216),
            doubleArrayOf(-0.003882, -0.048116, 1.051998)
        ),
        "tritan" to arrayOf(
            doubleArrayOf(1.255528, -0.076749, -0.178779), doubleArrayOf(-0.078411, 0.930809, 0.147602),
            doubleArrayOf(0.004733, 0.691367, 0.3039)
        )
    )

    /** T10.161 的门槛：28 对里最近的一对，正常视觉 ≥10，deutan ≥5.8，protan ≥5.4，tritan ≥3.3（CIEDE2000）。 */
    private val visionBars = linkedMapOf("normal" to 10.0, "deutan" to 5.8, "protan" to 5.4, "tritan" to 3.3)

    private fun toLinear(c: Double): Double = if (c <= 0.04045) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4)

    private fun fromLinear(c: Double): Double = if (c <= 0.0031308) 12.92 * c else 1.055 * Math.pow(maxOf(0.0, c), 1 / 2.4) - 0.055

    /** 8 位通道（与 U-4 脚本的 parseInt(hex) / 255 相同），按 [vision] 模拟后返回 sRGB 0..1、不取整。 */
    private fun simulate(color: Color, vision: String): DoubleArray {
        val argb = color.toArgb()
        val rgb = doubleArrayOf(((argb shr 16) and 0xFF) / 255.0, ((argb shr 8) and 0xFF) / 255.0, (argb and 0xFF) / 255.0)
        val m = machado[vision] ?: return rgb
        val lin = rgb.map(::toLinear)
        return DoubleArray(3) { row ->
            fromLinear((m[row][0] * lin[0] + m[row][1] * lin[1] + m[row][2] * lin[2]).coerceIn(0.0, 1.0))
        }
    }

    /** sRGB → CIE Lab（D65）。 */
    private fun lab(rgb: DoubleArray): DoubleArray {
        val (r, g, b) = rgb.map(::toLinear)
        fun f(t: Double) = if (t > 216.0 / 24389) Math.cbrt(t) else (24389.0 / 27 * t + 16) / 116
        val fx = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047)
        val fy = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b)
        val fz = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883)
        return doubleArrayOf(116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))
    }

    /** CIEDE2000（Sharma, Wu & Dalal 2005），与 U-4 的 palette-metrics.mjs 逐式相同。 */
    private fun deltaE00(p: DoubleArray, q: DoubleArray): Double {
        val rad = Math.PI / 180
        val (l1, a1, b1) = p.toList()
        val (l2, a2, b2) = q.toList()
        val pow25 = Math.pow(25.0, 7.0)
        val cBar7 = Math.pow((Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2, 7.0)
        val g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + pow25)))
        val a1p = (1 + g) * a1
        val a2p = (1 + g) * a2
        val c1p = Math.hypot(a1p, b1)
        val c2p = Math.hypot(a2p, b2)
        fun hue(a: Double, b: Double) = if (a == 0.0 && b == 0.0) 0.0 else (Math.atan2(b, a) / rad + 360) % 360
        val h1p = hue(a1p, b1)
        val h2p = hue(a2p, b2)
        var dhp = 0.0
        if (c1p * c2p != 0.0) {
            dhp = h2p - h1p
            if (dhp > 180) {
                dhp -= 360
            } else if (dhp < -180) {
                dhp += 360
            }
        }
        val dLp = l2 - l1
        val dCp = c2p - c1p
        val dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(dhp / 2 * rad)
        val lBar = (l1 + l2) / 2
        val cBarP = (c1p + c2p) / 2
        var hBar = h1p + h2p
        if (c1p * c2p != 0.0) {
            if (Math.abs(h1p - h2p) > 180) hBar += if (h1p + h2p < 360) 360.0 else -360.0
            hBar /= 2
        }
        val t = 1 - 0.17 * Math.cos((hBar - 30) * rad) + 0.24 * Math.cos(2 * hBar * rad) +
            0.32 * Math.cos((3 * hBar + 6) * rad) - 0.2 * Math.cos((4 * hBar - 63) * rad)
        val dTheta = 30 * Math.exp(-Math.pow((hBar - 275) / 25, 2.0))
        val cBarP7 = Math.pow(cBarP, 7.0)
        val rc = 2 * Math.sqrt(cBarP7 / (cBarP7 + pow25))
        val sl = 1 + 0.015 * Math.pow(lBar - 50, 2.0) / Math.sqrt(20 + Math.pow(lBar - 50, 2.0))
        val sc = 1 + 0.045 * cBarP
        val sh = 1 + 0.015 * cBarP * t
        val rt = -Math.sin(2 * dTheta * rad) * rc
        return Math.sqrt(
            Math.pow(dLp / sl, 2.0) + Math.pow(dCp / sc, 2.0) + Math.pow(dHp / sh, 2.0) + rt * (dCp / sc) * (dHp / sh)
        )
    }

    /** 8 个系列两两 28 对里、在 [vision] 下最近的一对：(色差, 槽位 i, 槽位 j)，槽位从 1 数。 */
    private fun closestPair(chart: List<Color>, vision: String): Triple<Double, Int, Int> {
        var best = Triple(Double.MAX_VALUE, 0, 0)
        for (i in chart.indices) {
            for (j in i + 1 until chart.size) {
                val distance = deltaE00(lab(simulate(chart[i], vision)), lab(simulate(chart[j], vision)))
                if (distance < best.first) best = Triple(distance, i + 1, j + 1)
            }
        }
        return best
    }

    @Test
    fun ciede2000MatchesSharmaReferencePairs() {
        // Sharma, Wu & Dalal（2005）表 1 的样例：实现抄错一处，下面的色弱断言就没有意义。
        listOf(
            Triple(doubleArrayOf(50.0, 2.6772, -79.7751), doubleArrayOf(50.0, 0.0, -82.7485), 2.0425),
            Triple(doubleArrayOf(50.0, 3.1571, -77.2803), doubleArrayOf(50.0, 0.0, -82.7485), 2.8615),
            Triple(doubleArrayOf(50.0, 2.8361, -74.02), doubleArrayOf(50.0, 0.0, -82.7485), 3.4412),
            Triple(doubleArrayOf(50.0, 0.0, 0.0), doubleArrayOf(50.0, -1.0, 2.0), 2.3669),
            Triple(doubleArrayOf(50.0, 2.5, 0.0), doubleArrayOf(73.0, 25.0, -18.0), 27.1492),
            Triple(doubleArrayOf(50.0, 2.5, 0.0), doubleArrayOf(61.0, -5.0, 29.0), 22.8977),
            Triple(doubleArrayOf(60.2574, -34.0099, 36.2677), doubleArrayOf(60.4626, -34.1751, 39.4387), 1.2644)
        ).forEach { (p, q, expected) -> assertEquals(expected, deltaE00(p, q), 1e-4) }
    }

    @Test
    fun chartSeriesStayDistinguishableUnderColourVisionDeficiency() {
        // U-4 方案 B：深浅两套各 28 对、4 种视觉全部过 T10.161 门槛。最近的一对逐个钉住（±0.01），
        // 取值与 _coord/scratch/U-4/summary.md §3 一致；色值被改动时这里会先动。
        val expected = linkedMapOf(
            LedgerPalettes.Dark to mapOf(
                "normal" to Triple(15.40, 1, 7), "deutan" to Triple(6.38, 1, 7),
                "protan" to Triple(8.02, 1, 7), "tritan" to Triple(3.63, 3, 6)
            ),
            LedgerPalettes.Light to mapOf(
                "normal" to Triple(12.46, 1, 7), "deutan" to Triple(6.38, 1, 7),
                "protan" to Triple(5.97, 1, 2), "tritan" to Triple(4.25, 3, 6)
            )
        )
        expected.forEach { (c, perVision) ->
            visionBars.forEach { (vision, bar) ->
                val (distance, i, j) = closestPair(c.chart, vision)
                assertTrue(
                    "${c.appearance} $vision 下最近的一对 c$i/c$j 只有 %.2f，低于 T10.161 门槛 $bar".format(distance),
                    distance >= bar
                )
                val (want, wantI, wantJ) = perVision.getValue(vision)
                assertEquals("${c.appearance} $vision 最近的一对", "c$wantI/c$wantJ", "c$i/c$j")
                assertEquals("${c.appearance} $vision 最近一对的色差", want, distance, 0.01)
            }
        }
    }
}
