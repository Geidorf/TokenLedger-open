package com.jeidorf.tokenledger.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 摆件模式与渲染策略的性质测试。
 *
 * 这一层刻意不依赖 Compose：`AmbientMode` / `resolveRenderProfile` 是纯决策，能在 JVM 上
 * 穷举验证。golden 截图只能事后确认"这一张长这样"，穷举断言才能保证"五个模式确实不同"
 * 这类跨模式性质不被某次改动悄悄破坏。
 */
class AmbientModeTest {
    private val appearances = LedgerAppearance.entries
    private val modes = AmbientMode.entries

    // ---- 持久化 ----

    @Test
    fun everyStoredValueRoundTripsAndIsUnique() {
        modes.forEach { mode ->
            assertEquals(mode, AmbientMode.fromStored(mode.storedValue))
        }
        assertEquals(modes.size, modes.map { it.storedValue }.toSet().size)
    }

    @Test
    fun legacyWidgetPresentationValuesUpgradeWithoutVisibleChange() {
        // 升级用户设备上留存的 widget_presentation 字符串。polished 曾是默认观感，
        // 必须落到信息量相当的 Console；eink 落到墨水日报。
        assertEquals(AmbientMode.Console, AmbientMode.fromStored("polished"))
        assertEquals(AmbientMode.Ledger, AmbientMode.fromStored("eink"))
    }

    @Test
    fun unknownAndMissingValuesFallBackWithoutThrowing() {
        assertEquals(AmbientMode.Console, AmbientMode.fromStored(null))
        assertEquals(AmbientMode.Console, AmbientMode.fromStored("mode-from-the-future"))
        modes.forEach { fallback ->
            assertEquals(fallback, AmbientMode.fromStored(null, fallback = fallback))
            assertEquals(fallback, AmbientMode.fromStored("", fallback = fallback))
        }
    }

    @Test
    fun defaultModeFollowsTheDisplayHardwareNotTheThemePreference() {
        assertEquals(AmbientMode.Ledger, defaultAmbientMode(isEInkDisplay = true))
        assertEquals(AmbientMode.Console, defaultAmbientMode(isEInkDisplay = false))
    }

    // ---- 分档本身 ----

    /**
     * 验收 V2 的机器可读形式。以前"E-ink 摆件"和"精致摆件"编排完全相同，差别只在 palette，
     * 于是"两个模式"实际上是一个模式配两套颜色。元素集合两两不等就把这种退化挡在编译期之后
     * 的第一道门。
     */
    @Test
    fun allFiveModesRenderGenuinelyDifferentElementSets() {
        modes.forEach { a ->
            modes.filter { it != a }.forEach { b ->
                assertNotEquals("$a 与 $b 的元素集合不应相同", a.elements, b.elements)
            }
        }
    }

    /**
     * 每一档都必须有一个明确的"主语"。旧断言写的是"都要有巨型 Token 数字"，那是把
     * Console 的编排当成了普遍规律；额度墙改成仪表盘网格后主语是百分比而不是 Token，
     * 硬塞一个巨型数字反而稀释了这一档。规则因此放宽为：Token 数字或额度块，至少有一个。
     */
    @Test
    fun everyModeCommitsToASubjectAndCarriesBothSummaries() {
        modes.forEach { mode ->
            assertTrue(
                "$mode 必须有主语：巨型 Token 数字或额度块",
                AmbientElement.HeroTokens in mode.elements || mode.showsQuota
            )
            assertTrue("$mode 需要非空文案", mode.label.isNotBlank() && mode.summary.isNotBlank())
            // 每一档都要有自己的墨水屏说明，否则预览卡打开墨水屏开关时无话可说。
            assertTrue("$mode 缺少墨水屏摘要", mode.einkSummary.isNotBlank())
            assertNotEquals("$mode 的墨水屏摘要不应与彩色摘要雷同", mode.summary, mode.einkSummary)
        }
        assertTrue(AmbientElement.HeroTokens in AmbientMode.Glance.elements)
        assertFalse("额度墙只讲还剩多少，不该再放 Token 数字", AmbientElement.HeroTokens in AmbientMode.QuotaWall.elements)
    }

    @Test
    fun einkSummariesAreDistinctPerMode() {
        assertEquals(modes.size, modes.map { it.einkSummary }.toSet().size)
    }

    @Test
    fun quotaFlagAgreesWithTheElementSet() {
        modes.forEach { mode ->
            val hasQuotaElement = AmbientElement.QuotaCapsules in mode.elements ||
                AmbientElement.QuotaBoard in mode.elements ||
                AmbientElement.QuotaGaugeGrid in mode.elements
            assertEquals("$mode 的 showsQuota 应与元素集合一致", hasQuotaElement, mode.showsQuota)
        }
        assertFalse(AmbientMode.Glance.showsQuota)
        assertTrue(AmbientMode.QuotaWall.showsQuota)
    }

    // ---- 设置页预览 ----

    /**
     * 真机反馈 ①：切换顶部模式 chip 时，下方示意图纹丝不动。
     *
     * 根因是那张预览卡只吃 `AmbientRenderProfile`，从不看 `AmbientMode`——而深浅色下五档的
     * profile 差别很小，肉眼看上去就是"完全没变"。预览改为按 [ambientPreviewElements] 逐块
     * 渲染后，"换档必然换内容"就成了一条纯函数性质，可以在这里穷举断言。
     */
    @Test
    fun previewElementsDifferForEveryPairOfModes() {
        modes.forEach { a ->
            modes.filter { it != a }.forEach { b ->
                assertNotEquals(
                    "$a 与 $b 的预览区块列表相同，切档时用户看不出变化",
                    ambientPreviewElements(a),
                    ambientPreviewElements(b)
                )
            }
        }
    }

    @Test
    fun previewElementsAreASubsetOfTheModeInDeclarationOrder() {
        modes.forEach { mode ->
            val preview = ambientPreviewElements(mode)
            assertTrue("$mode 预览区块必须来自该档的元素集合", mode.elements.containsAll(preview))
            assertTrue("$mode 预览不能为空", preview.isNotEmpty())
            assertEquals("$mode 预览区块不应重复", preview.size, preview.toSet().size)
            // 顺序必须由枚举声明顺序决定，否则同一档每次重组的排版都可能不同。
            assertEquals(preview.sortedBy { it.ordinal }, preview)
        }
        // 热力图在缩略卡里挤成一团黑，墨水日报那一档明确不画。
        assertFalse(AmbientElement.Heatmap in ambientPreviewElements(AmbientMode.Ledger))
        assertTrue(AmbientElement.Heatmap in AmbientMode.Ledger.elements)
    }

    @Test
    fun displayOrderIsAPermutationSortedByDensity() {
        val ordered = AmbientMode.orderedForDisplay()
        assertEquals(modes.toSet(), ordered.toSet())
        assertEquals(modes.size, ordered.size)
        assertEquals(ordered.map { it.density }.sorted(), ordered.map { it.density })
        // 密度并列时退回声明顺序，保证设置页每次打开的排列完全一致。
        ordered.zipWithNext().filter { (a, b) -> a.density == b.density }.forEach { (a, b) ->
            assertTrue("$a 应排在 $b 之前", a.ordinal < b.ordinal)
        }
    }

    // ---- 真实设备视口 ----

    @Test
    fun connectedDevicesResolveByBothWidthAndHeight() {
        val einkReader = resolveAmbientViewport(widthDp = 998f, heightDp = 701f)
        val oppoTablet = resolveAmbientViewport(widthDp = 960f, heightDp = 633f)

        assertEquals(AmbientViewportKind.LandscapeRegular, einkReader.kind)
        assertEquals(AmbientViewportKind.LandscapeCompact, oppoTablet.kind)
        assertTrue(einkReader.landscape)
        assertTrue(oppoTablet.landscape)
        assertTrue(oppoTablet.verticalPaddingDp < einkReader.verticalPaddingDp)
        assertEquals(1f, einkReader.consoleTopWeight + einkReader.consoleChartWeight + einkReader.consoleFooterWeight, 0.001f)
        assertEquals(1f, oppoTablet.consoleTopWeight + oppoTablet.consoleChartWeight + oppoTablet.consoleFooterWeight, 0.001f)
    }

    @Test
    fun gestureNavigationShallowLandscapeGetsItsOwnPolicy() {
        val shallow = resolveAmbientViewport(widthDp = 844f, heightDp = 390f)

        assertEquals(AmbientViewportKind.LandscapeShallow, shallow.kind)
        assertTrue(shallow.verticalPaddingDp < 18f)
        assertTrue(shallow.consoleChartWeight > shallow.consoleTopWeight / 2f)
    }

    @Test
    fun quotaWallBalancesFourWindowsAsTwoByTwo() {
        assertEquals(1, ambientQuotaWallColumns(1, landscape = true))
        assertEquals(2, ambientQuotaWallColumns(2, landscape = true))
        assertEquals(3, ambientQuotaWallColumns(3, landscape = true))
        assertEquals(2, ambientQuotaWallColumns(4, landscape = true))
        assertEquals(3, ambientQuotaWallColumns(5, landscape = true))
        assertEquals(2, ambientQuotaWallColumns(4, landscape = false))
    }

    @Test
    fun quotaWallVisualAndPixelShiftCyclesAreDeterministic() {
        assertEquals(QuotaWallVisual.Bar, QuotaWallVisual.Ring.next())
        assertEquals(QuotaWallVisual.Ring, QuotaWallVisual.Bar.next())
        assertEquals(AmbientPixelShift(0, 0), ambientPixelShift(0))
        assertEquals(ambientPixelShift(0), ambientPixelShift(9))
        assertEquals(ambientPixelShift(8), ambientPixelShift(-1))
        (-20..20).forEach { step ->
            val shift = ambientPixelShift(step)
            assertTrue(shift.xDp in -6..6)
            assertTrue(shift.yDp in -4..4)
        }
    }

    // ---- 渲染策略 ----

    @Test
    fun profileResolutionIsTotalOverTheFullModeByThemeMatrix() {
        var resolved = 0
        modes.forEach { mode ->
            appearances.forEach { appearance ->
                resolveRenderProfile(mode, appearance)
                resolved += 1
            }
        }
        assertEquals(modes.size * appearances.size, resolved)
    }

    /** 深浅色只是配色，不是渲染约束。这条断言防止有人再把配色差异塞回策略层。 */
    @Test
    fun darkAndLightResolveToIdenticalProfiles() {
        modes.forEach { mode ->
            assertEquals(
                "$mode 在深浅色下应解析出完全相同的渲染策略",
                resolveRenderProfile(mode, LedgerAppearance.Dark),
                resolveRenderProfile(mode, LedgerAppearance.Light)
            )
        }
    }

    /**
     * E-ink 是物理约束（抗锯齿差、残影、灰阶不可靠），因此**每一个**模式在墨水屏配色下
     * 都必须被夹到墨水屏能画的画风，而不是只有"墨水日报"那一档才照顾墨水屏。
     */
    @Test
    fun theEInkPaletteConstrainsEveryModeNotJustTheLedgerOne() {
        modes.forEach { mode ->
            val profile = resolveRenderProfile(mode, LedgerAppearance.EInk)
            assertNotEquals("$mode: 1bit 屏上实心大色块会退化成纯黑", FillPolicy.Solid, profile.fillPolicy)
            assertNotEquals("$mode: 环形进度全是斜边，1bit 下不可读", ProgressStyle.Ring, profile.progressStyle)
            assertEquals("$mode: 曲线斜边在低 DPI 墨水屏上是锯齿", ChartStyle.SteppedBar, profile.chartStyle)
            assertTrue("$mode: 圆角应被夹到 4dp 内", profile.cornerRadiusDp <= 4f)
            assertTrue("$mode: 描边至少 2dp 才画得出来", profile.strokeWidthDp >= 2f)
            assertTrue("$mode: 数字应等宽以免刷新时抖动", profile.useMonospaceNumerals)
            assertEquals(
                "$mode: 墨水屏重绘必须对齐整点刻度",
                RefreshCadence.AlignedQuarterHour,
                profile.refreshCadence
            )
            assertTrue("$mode: 墨水屏重绘前需要消影", profile.ghostBusting)
        }
    }

    /**
     * 真机反馈 ②/③ 的策略侧断言。
     *
     * "环在 1bit 上不可读"这条规则原本是一刀切，代价是额度墙在墨水屏下退化成一排细条——
     * 而那一档的**主语**就是环，降级等于取消这一档。真正的原因是描边太细，不是环不对，
     * 所以额度墙走 [ProgressStyle.DitheredRing]（粗描边 + 虚线轨道），其余档仍降级为条。
     */
    @Test
    fun theEInkQuotaWallKeepsItsGaugesWhileOtherModesDegradeToBars() {
        assertEquals(
            ProgressStyle.DitheredRing,
            resolveRenderProfile(AmbientMode.QuotaWall, LedgerAppearance.EInk).progressStyle
        )
        assertEquals(
            ProgressStyle.Ring,
            resolveRenderProfile(AmbientMode.QuotaWall, LedgerAppearance.Dark).progressStyle
        )
        assertEquals(
            ProgressStyle.Bar,
            resolveRenderProfile(AmbientMode.Console, LedgerAppearance.EInk).progressStyle
        )
        // 墨水日报本来就用字符轨道，不该被墨水屏分支改写成别的东西。
        assertEquals(
            ProgressStyle.CharTrack,
            resolveRenderProfile(AmbientMode.Ledger, LedgerAppearance.EInk).progressStyle
        )
    }

    /** 反向：常规屏幕不应被墨水屏的约束波及。 */
    @Test
    fun regularScreensKeepTheRicherRenderingAffordances() {
        val console = resolveRenderProfile(AmbientMode.Console, LedgerAppearance.Dark)
        assertEquals(FillPolicy.Solid, console.fillPolicy)
        assertEquals(ProgressStyle.Ring, console.progressStyle)
        assertEquals(ChartStyle.SmoothArea, console.chartStyle)
        assertFalse(console.ghostBusting)
        assertEquals(RefreshCadence.OnDataChange, console.refreshCadence)
    }

    /** 墨水日报自带墨水画风，换到深色配色也不该变回曲线与环形进度。 */
    @Test
    fun ledgerModeKeepsItsPrintLookUnderColourPalettes() {
        appearances.forEach { appearance ->
            val profile = resolveRenderProfile(AmbientMode.Ledger, appearance)
            assertEquals(ChartStyle.SteppedBar, profile.chartStyle)
            assertEquals(ProgressStyle.CharTrack, profile.progressStyle)
            assertTrue(profile.useMonospaceNumerals)
        }
    }

    @Test
    fun resolutionIsPureAndRepeatable() {
        modes.forEach { mode ->
            appearances.forEach { appearance ->
                assertEquals(
                    resolveRenderProfile(mode, appearance),
                    resolveRenderProfile(mode, appearance)
                )
            }
        }
    }

    // ---- 节奏序列 ----

    /**
     * 今日只走到当前小时，序列比昨日短。若用 `current.size - 1` 当分母，今日曲线会被拉伸
     * 铺满整幅图，看起来像"今天一整天都在用"。横轴格数必须由分桶语义决定。
     */
    @Test
    fun hourlyBucketsKeepATwentyFourHourAxisEvenWhenTodayIsPartial() {
        val series = ambientRhythmSeries(
            comparison = comparisonFixture(bucket = "hour", currentPoints = 8, previousPoints = 24),
            fallback = emptyList()
        )
        assertEquals(23, series.axisSpan)
        assertEquals(8, series.current.size)
        assertEquals(24, series.previous.size)
        assertTrue(series.isHourly)
        assertEquals("昨日", series.previousLabel)
        assertEquals("24 小时节奏", series.title)
    }

    /** 其它分桶下硬画 24 小时刻度会是谎言，标题与对比线名称都得随分桶改写。 */
    @Test
    fun nonHourlyBucketsSpanTheirOwnLengthAndRelabelThePreviousLine() {
        val series = ambientRhythmSeries(
            comparison = comparisonFixture(bucket = "day", currentPoints = 5, previousPoints = 7),
            fallback = emptyList()
        )
        assertEquals(6, series.axisSpan)
        assertFalse(series.isHourly)
        assertEquals("上一周期", series.previousLabel)
        assertEquals("按日节奏", series.title)
    }

    @Test
    fun axisSpanNeverCollapsesToZeroOnDegenerateSeries() {
        listOf(
            ambientRhythmSeries(comparison = null, fallback = emptyList()),
            ambientRhythmSeries(
                comparison = comparisonFixture(bucket = "week", currentPoints = 1, previousPoints = 0),
                fallback = emptyList()
            )
        ).forEach { series ->
            assertTrue("横轴格数不能为 0，否则除法会炸", series.axisSpan >= 1)
        }
    }

    /** comparison 不可用时退回 trend，且不把 `__requests` 这类保留键算进 Token。 */
    @Test
    fun trendFallbackSumsOnlyRealMetricKeys() {
        val series = ambientRhythmSeries(
            comparison = null,
            fallback = listOf(
                TrendPoint("2026-07-24", mapOf("codex" to 100L, "__requests" to 999L)),
                TrendPoint("2026-07-25", mapOf("codex" to 40L, "claude" to 60L))
            )
        )
        assertEquals(listOf(100f, 100f), series.current)
        assertTrue(series.previous.isEmpty())
        assertTrue(series.hasData)
    }

    @Test
    fun allZeroSeriesReportsNoData() {
        val series = ambientRhythmSeries(
            comparison = comparisonFixture(
                bucket = "hour",
                currentPoints = 3,
                previousPoints = 3,
                tokensPerPoint = 0
            ),
            fallback = emptyList()
        )
        assertFalse(series.hasData)
    }

    private fun comparisonFixture(
        bucket: String,
        currentPoints: Int,
        previousPoints: Int,
        tokensPerPoint: Long = 1_000
    ): UsageComparison {
        fun period(count: Int) = ComparisonPeriod(
            summary = Summary(),
            series = (0 until count).map { index ->
                ComparisonSeriesPoint(
                    bucket = index.toString(),
                    tokens = tokensPerPoint,
                    requests = 1,
                    cost = 0.0
                )
            }
        )
        val zeroDelta = MetricDelta(absolute = 0.0, percent = 0.0, direction = "flat")
        return UsageComparison(
            window = ComparisonWindow(
                kind = "dayOverDay",
                timezone = "Asia/Shanghai",
                bucket = bucket,
                currentStart = null,
                currentEnd = null,
                previousStart = null,
                previousEnd = null,
                alignedThrough = null
            ),
            current = period(currentPoints),
            previous = period(previousPoints),
            delta = ComparisonDelta(zeroDelta, zeroDelta, zeroDelta)
        )
    }
}
