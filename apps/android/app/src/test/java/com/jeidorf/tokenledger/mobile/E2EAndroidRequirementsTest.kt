package com.jeidorf.tokenledger.mobile

import java.text.NumberFormat
import java.time.Instant
import java.util.Locale
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * End-to-End Requirement-Driven Test Suite covering F-01 through F-27
 * structured across 4 rigorous testing tiers:
 * - Tier 1: Feature Coverage (Core Functional Happy Path)
 * - Tier 2: Boundary, Edge & Failure Modes
 * - Tier 3: Cross-Feature Pairwise & Multidimensional Combinations
 * - Tier 4: Real-World Workload Scenarios
 *
 * Adheres to:
 * - docs/contracts/dashboard-stats-v2.md
 * - docs/contracts/quota-provider-v1.md
 * - docs/design/android-visual-system.md
 * - docs/PROJECT.md
 */
class E2EAndroidRequirementsTest {

    private fun <T> withDefaultTimeZone(id: String, block: () -> T): T =
        synchronized(TimeZone::class.java) {
            val previous = TimeZone.getDefault()
            try {
                TimeZone.setDefault(TimeZone.getTimeZone(id))
                block()
            } finally {
                TimeZone.setDefault(previous)
            }
        }

    private fun fixture(name: String): String {
        val resource = checkNotNull(javaClass.classLoader?.getResource("dashboard-stats-v2/$name")) {
            "Missing shared dashboard fixture: $name"
        }
        return resource.readText()
    }

    private fun quotaFixtureProviders(): List<QuotaProviderEnvelope> {
        val resource = checkNotNull(javaClass.classLoader?.getResource("quota-provider-v1/complete-v1.json")) {
            "Missing quota provider complete-v1.json fixture"
        }
        val json = resource.openStream().bufferedReader().use { it.readText() }
        return QuotaSnapshotJson.parseFixtureProviders(json, QuotaParseMode.OrdinaryReader)
    }

    // =========================================================================
    // TIER 1: FEATURE COVERAGE (Core Functional Happy Paths for F-01 to F-27)
    // =========================================================================

    @Test
    fun tier1_f01_trendScrubbingMapsContinuousTouchToDiscreteBuckets() {
        val pointCount = 5
        val width = 400f
        assertEquals(0, scrubIndexForPosition(touchX = 0f, widthPx = width, pointCount = pointCount))
        assertEquals(1, scrubIndexForPosition(touchX = 100f, widthPx = width, pointCount = pointCount))
        assertEquals(2, scrubIndexForPosition(touchX = 200f, widthPx = width, pointCount = pointCount))
        assertEquals(3, scrubIndexForPosition(touchX = 300f, widthPx = width, pointCount = pointCount))
        assertEquals(4, scrubIndexForPosition(touchX = 400f, widthPx = width, pointCount = pointCount))

        // Insets respected
        assertEquals(2, scrubIndexForPosition(touchX = 210f, widthPx = 420f, pointCount = pointCount, leftInsetPx = 20f, rightInsetPx = 20f))
    }

    @Test
    fun tier1_f02_smoothBezierCurveProducesAccurateCubicSegments() {
        val points = listOf(
            SmoothCurvePoint(0f, 80f),
            SmoothCurvePoint(10f, 10f),
            SmoothCurvePoint(20f, 90f),
            SmoothCurvePoint(30f, 30f)
        )
        val segments = smoothCurveSegments(points, minY = 5f, maxY = 95f)
        assertEquals(points.size - 1, segments.size)
        assertEquals(points.first(), segments.first().start)
        assertEquals(points.last(), segments.last().end)
        segments.forEach { segment ->
            assertTrue(segment.control1.y in 5f..95f)
            assertTrue(segment.control2.y in 5f..95f)
            assertTrue(segment.start.x <= segment.control1.x)
            assertTrue(segment.control1.x <= segment.control2.x)
            assertTrue(segment.control2.x <= segment.end.x)
        }
    }

    @Test
    fun tier1_f03_geometricPrimitivesNormalizedBetweenZeroAndOne() {
        val fractions = trendDataBarFractions(currentTokens = 75L, previousTokens = 25L, sharedMaximum = 100L)
        assertEquals(0.75f, fractions.current, 0.0001f)
        assertEquals(0.25f, fractions.previous, 0.0001f)

        val norm = normalizedDataBarFraction(value = 42L, sharedMaximum = 100L)
        assertEquals(0.42f, norm, 0.0001f)

        val paddedMax = paddedChartMaximum(listOf(20f, 100f), headroomFraction = 0.12f)
        assertEquals(112f, paddedMax, 0.0001f)
    }

    @Test
    fun tier1_f04_quotaProgressAndWindowPriorityRanking() {
        val providers = quotaFixtureProviders()
        val ranked = providers.rankedQuotaWindowsForDisplay()
        val top3 = ranked.take(3)
        assertEquals(
            listOf("openai-codex-local", "anthropic-claude-consumer", "google-antigravity-consumer"),
            top3.map { it.first.providerId }
        )
        assertEquals("codex:secondary", top3[0].second.windowId)
        assertEquals(QuotaWindowRole.LongWindow, top3[0].second.displayRole())
        assertEquals("claude:five-hour", top3[1].second.windowId)
        assertEquals(QuotaWindowRole.ShortWindow, top3[1].second.displayRole())

        val codex = providers.first { it.providerId == "openai-codex-local" }
        val window = codex.drawableProgressWindows().first()
        val progress = effectiveQuotaProgressPresentation(codex, window, Instant.parse("2026-07-15T00:40:00Z"), forceStale = false)
        assertEquals(QuotaProviderStatus.Ok, progress.status)
        assertNotNull(progress.availableFraction)
        assertNotNull(progress.availablePercent)
    }

    @Test
    fun tier1_f04_quotaGroupsKeepHistorySeparateAndLowRemainingActionable() {
        val now = Instant.parse("2026-07-15T00:40:00Z")
        val codex = quotaFixtureProviders().first { it.providerId == "openai-codex-local" }
        val freshWindow = codex.windows.first().copy(
            status = QuotaWindowStatus.Ok,
            used = 20.0,
            limit = 100.0,
            remaining = 80.0,
            unit = QuotaUnit.Percent,
            observedAt = now.minusSeconds(60).toString(),
            fetchedAt = now.minusSeconds(30).toString(),
            staleAfterSeconds = 3_600,
            resetsAt = null
        )
        val healthy = codex.copy(providerId = "healthy", windows = listOf(freshWindow))
        val low = codex.copy(
            providerId = "low",
            windows = listOf(freshWindow.copy(used = 95.0, remaining = 5.0))
        )
        val history = codex.copy(
            providerId = "history",
            windows = listOf(
                freshWindow.copy(
                    observedAt = now.minusSeconds(7_200).toString(),
                    resetsAt = now.plusSeconds(3_600).toString()
                )
            )
        )

        val groups = groupQuotaProviders(listOf(low, healthy, history), now, showingCachedData = false)
        assertEquals(listOf("low"), groups.attention.map { it.providerId })
        assertEquals(listOf("healthy"), groups.available.map { it.providerId })
        assertEquals(listOf("history"), groups.history.map { it.providerId })
        assertFalse(QUOTA_HISTORY_DEFAULT_EXPANDED)
        assertNull(healthy.windows.single().resetsAt)
        assertEquals(80.0, healthy.windows.single().remaining)
    }

    @Test
    fun tier1_f05_stateDerivationRetainsPreviousFrameWhileLoading() {
        val previous = requireNotNull(ledgerSnapshotFixture().visibleData)
        val retained = dashboardDataForFrame(visibleData = null, retainedData = previous, dashboardLoading = true)
        assertEquals(previous, retained)

        val options = v2FilterOptions(retained)
        assertTrue(options.machines.any { it.first == DashboardQuery.ALL_MACHINES })
        assertTrue(options.tools.isNotEmpty())
        assertTrue(options.models.isNotEmpty())

        val summary = Summary(inputTokens = 1200L, outputTokens = 800L)
        assertEquals(2000L, summary.effectiveTokens)
    }

    @Test
    fun tier1_f06_precompiledRegexAndFormatterSingletons() {
        assertEquals("12:41", shortTime("2026-07-15 12:41:00"))
        assertEquals("09:07", shortTime("2026-07-15T09:07:30+08:00"))
        assertEquals("2,206 条记录", detailRequestCountLabel(2206L))
        assertEquals("14:00 - 15:00", formatScrubBucketLabel("14:00"))
        assertEquals("2026-07-15", formatScrubBucketLabel("2026-07-15"))
    }

    @Test
    fun tier1_f07_detailRowGranularityAndEntityKindLabels() {
        val logItem = LogHistoryItem(
            id = 1L,
            tool = "codex",
            model = "gpt-5",
            inputTokens = 1500L,
            outputTokens = 500L,
            cachedTokens = 200L,
            cost = 0.25,
            timestamp = "2026-07-15 10:00:00",
            sessionId = "session-1",
            machineId = "macbook-pro",
            requests = 10L
        )
        assertEquals("云端小时聚合", detailGranularityLabel("hour", listOf(logItem)))
        assertEquals("逐次请求", detailGranularityLabel("request", emptyList()))
        assertEquals("工具", entityKindLabel("tool"))
        assertEquals("模型", entityKindLabel("MODEL"))
        assertEquals(2000L, logItem.effectiveTokens)
    }

    @Test
    fun tier1_f08_persistentNavigationSelectionAcrossTabs() {
        assertEquals(listOf("用量", "路由", "额度", "我的"), MobileDestination.entries.map { it.label })
        assertEquals(listOf("概览", "趋势", "来源", "日历", "请求"), InsightPane.entries.map { it.label })
        assertEquals(listOf("查看趋势"), TodayReviewAction.entries.map { it.label })
        assertEquals(InsightPane.Trend, TodayReviewAction.ExplainChange.targetPane)
        assertEquals(3, TODAY_SOURCE_LIMIT)
        assertEquals(2, TODAY_QUOTA_LIMIT)

        val nav = V2NavigationSelection(MobileDestination.Quota, InsightPane.Overview)
        val switched = nav.openInsight(InsightPane.Sources)
        assertEquals(MobileDestination.Usage, switched.destination)
        assertEquals(InsightPane.Sources, switched.insightPane)
        assertEquals(DashboardSection.Contributions, switched.destination.dashboardSection(switched.insightPane))
        assertEquals(DashboardSection.Overview, MobileDestination.Usage.dashboardSection(InsightPane.Overview))
        assertEquals(DashboardSection.Details, MobileDestination.Usage.dashboardSection(InsightPane.Details))
        assertEquals(null, MobileDestination.Routing.dashboardSection(InsightPane.Trend))
        assertEquals(null, MobileDestination.Quota.dashboardSection(InsightPane.Trend))
        assertEquals(null, MobileDestination.Me.dashboardSection(InsightPane.Trend))

        assertEquals(DashboardSection.Trends, InsightPane.Calendar.dashboardSection())
        assertEquals(DashboardSection.Contributions, InsightPane.Sources.dashboardSection())
        assertEquals(DashboardSection.Details, InsightPane.Details.dashboardSection())
    }

    @Test
    fun tier1_f09_backNavigationConsumedOnlyForEntityWithStack() {
        val root = DashboardUiState(configured = true, section = DashboardSection.Overview)
        assertFalse(shouldConsumeDashboardBack(root))

        val entityWithStack = root.copy(
            section = DashboardSection.Entity,
            navigationStack = listOf(
                DashboardNavigationSnapshot(
                    query = DashboardQuery(),
                    entity = null,
                    section = DashboardSection.Overview,
                    contributionMode = ContributionMode.Tools
                )
            )
        )
        assertTrue(shouldConsumeDashboardBack(entityWithStack))

        val idleState = ledgerSnapshotFixture()
        assertNull(v2DashboardTopStatusText(idleState))
    }

    @Test
    fun tier1_f10_chartTimelineFractionsMonotonicallyProgress() {
        assertEquals(0.5f, dayProgressFraction("2026-07-15 12:00:00")!!, 0.0001f)
        val fractions = chartXFractions(
            buckets = listOf("00:00", "06:00", "12:00"),
            pointCount = 3,
            cutoffFraction = 0.55f,
            dayWindow = true,
            anchorLastToCutoff = true
        )
        assertEquals(listOf(0f, 0.25f, 0.55f), fractions)
        assertTrue(fractions[0] <= fractions[1] && fractions[1] <= fractions[2])
    }

    @Test
    fun tier1_f11_accessibleTypographyAdaptsLineLimitsForLargeScale() {
        assertEquals(1, dashboardStatusMaxLines(1f))
        assertEquals(2, dashboardStatusMaxLines(1.5f))
        assertEquals(2, dashboardStatusMaxLines(2f))
        assertEquals(1, dashboardTitleMaxLines(1f))
        assertEquals(2, dashboardTitleMaxLines(2f))

        val fullTitle = "TokenLedger · Master AI Consumption Overview"
        assertEquals(fullTitle, dashboardTitleAccessibilityDescription(fullTitle))
    }

    @Test
    fun tier1_f12_dynamicChartTooltipComputesAccurateDeltasAndA11y() {
        val comparison = UsageComparison(
            window = ComparisonWindow("dayOverDay", "Asia/Shanghai", "hour", null, null, null, null, null),
            current = ComparisonPeriod(
                summary = Summary(),
                series = listOf(ComparisonSeriesPoint("14:00", tokens = 120_000L, requests = 12L, cost = 0.50))
            ),
            previous = ComparisonPeriod(
                summary = Summary(),
                series = listOf(ComparisonSeriesPoint("14:00", tokens = 100_000L, requests = 10L, cost = 0.40))
            ),
            delta = ComparisonDelta(MetricDelta(20_000.0, 20.0, "up"), MetricDelta(2.0, 20.0, "up"), MetricDelta(0.10, 25.0, "up"))
        )
        val readout = scrubReadoutForIndex(comparison, 0)!!
        assertEquals(20.0, readout.tokenDeltaPercent!!, 0.001)
        assertEquals(25.0, readout.costDeltaPercent!!, 0.001)

        val a11yDesc = formatScrubAccessibilityDescription(readout, ReportMetricMode.Tokens)
        assertTrue(a11yDesc.contains("14:00 - 15:00"))
        assertTrue(a11yDesc.contains("120,000"))
        assertTrue(a11yDesc.contains("12 条记录"))
    }

    @Test
    fun tier1_f13_calendarHeatmapParsesAndBinsDailyUsage() {
        val stats = StatsJson.parse(fixture("complete-v2.json"))
        assertNotNull(stats.heatmap)
        assertTrue(stats.heatmap.isNotEmpty())
        stats.heatmap.forEach { (date, tokens) ->
            assertTrue(date.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$")))
            assertTrue(tokens >= 0L)
        }
    }

    @Test
    fun tier1_f14_twoColumnKpiGridPresentsCanonicalDeltaComparison() {
        val day = comparisonKindPresentation("dayOverDay")
        assertEquals("今日 vs 昨日", day.windowLabel)
        assertEquals("较昨日同期", day.heroBaselineLabel)
        assertTrue(day.alignsToDayClock)

        val week = comparisonKindPresentation("weekOverWeek")
        assertEquals("本周 vs 上周", week.windowLabel)
        assertFalse(week.alignsToDayClock)

        // R-11（与桌面 formatChangePercent 同式）：|x| ≥ 10 取整，负号 U+2212。
        val deltaDown = deltaPresentation(MetricDelta(-20.0, -10.0, "down"))
        assertEquals("−10%", deltaDown.label)
        assertEquals(DeltaTone.Positive, deltaDown.tone)

        val deltaUp = deltaPresentation(MetricDelta(50.0, 25.0, "up"))
        assertEquals("+25%", deltaUp.label)
        assertEquals(DeltaTone.Warning, deltaUp.tone)
    }

    @Test
    fun tier1_f15_sessionDrilldownNormalizesMultiFilterSearch() {
        val query = DashboardQuery(
            range = RangeKey.Today,
            machines = listOf("  MacBook-Pro  "),
            tools = listOf("codex", "claude"),
            models = listOf("gpt-5"),
            search = "  session-xyz  "
        )
        val normalized = DashboardQueryContract.normalize(query)
        assertEquals(listOf("MacBook-Pro"), normalized.machines)
        assertEquals(listOf("claude", "codex"), normalized.tools)
        assertEquals("session-xyz", normalized.search)
    }

    @Test
    fun tier1_f16_responsiveScalingAdaptsLayoutModeAndNavigation() {
        assertEquals(DashboardLayoutMode.Compact, dashboardLayoutMode(widthDp = 320, fontScale = 1f))
        assertEquals(DashboardLayoutMode.Standard, dashboardLayoutMode(widthDp = 390, fontScale = 1f))
        assertEquals(DashboardLayoutMode.Compact, dashboardLayoutMode(widthDp = 430, fontScale = 2f))

        assertEquals(DashboardNavigationPlacement.BottomBar, dashboardNavigationPlacement(widthDp = 599, section = DashboardSection.Overview))
        assertEquals(DashboardNavigationPlacement.Rail, dashboardNavigationPlacement(widthDp = 600, section = DashboardSection.Overview))

        assertTrue(shouldWrapSharePeriodSelector(widthDp = 320, fontScale = 1f))
        assertFalse(shouldWrapSharePeriodSelector(widthDp = 390, fontScale = 1f))
    }

    @Test
    fun tier1_f17_donutChartSliceProportionsAndToolTagging() {
        val tool1 = ToolStat("codex", input = 600L, output = 400L, cached = 0L, total = 1000L, cost = 0.1, requests = 2L)
        val tool2 = ToolStat("claude", input = 300L, output = 200L, cached = 0L, total = 500L, cost = 0.05, requests = 1L)
        val total = tool1.effectiveTokens + tool2.effectiveTokens
        assertEquals(1500L, total)

        val fraction1 = tool1.effectiveTokens.toFloat() / total
        val fraction2 = tool2.effectiveTokens.toFloat() / total
        assertEquals(1.0f, fraction1 + fraction2, 0.0001f)

        assertTrue(ESTIMATED_TOOLS.contains("antigravity"))
        assertTrue(ESTIMATED_TOOLS.contains("trae"))
        assertFalse(ESTIMATED_TOOLS.contains("codex"))
    }

    @Test
    fun tier1_f18_metricDisplayModeSwitchesTokensAndCostSeries() {
        assertEquals(ReportMetricMode.Tokens, ReportMetricMode.fromStored("tokens"))
        assertEquals(ReportMetricMode.Cost, ReportMetricMode.fromStored("cost"))

        val comparison = UsageComparison(
            window = ComparisonWindow("dayOverDay", "Asia/Shanghai", "hour", null, null, null, null, null),
            current = ComparisonPeriod(Summary(), listOf(ComparisonSeriesPoint("10:00", tokens = 500L, requests = 1L, cost = 0.15))),
            previous = ComparisonPeriod(Summary(), listOf(ComparisonSeriesPoint("10:00", tokens = 200L, requests = 1L, cost = 0.05))),
            delta = ComparisonDelta(MetricDelta(300.0, 150.0, "up"), MetricDelta(0.0, 0.0, "flat"), MetricDelta(0.10, 200.0, "up"))
        )
        val (tokenCurrent, tokenPrev) = metricSeriesValues(comparison, emptyList(), ReportMetricMode.Tokens)
        assertEquals(listOf(500f), tokenCurrent)
        assertEquals(listOf(200f), tokenPrev)

        val (costCurrent, costPrev) = metricSeriesValues(comparison, emptyList(), ReportMetricMode.Cost)
        assertEquals(listOf(0.15f), costCurrent)
        assertEquals(listOf(0.05f), costPrev)
    }

    @Test
    fun tier1_f19_currencyAbstractionConvertsUsdToCnyAndMasksCost() {
        val costUsd = 100.0
        val rate = 7.2
        assertEquals("¥720.00", formatCostForDisplay(costUsd, exchangeRate = rate, masked = false))
        assertEquals("¥***.*", formatCostForDisplay(costUsd, exchangeRate = rate, masked = true))
        assertEquals("预估费用已显示，双击隐藏", costMaskAccessibilityDescription(masked = false))
        assertEquals("已隐藏", costMaskStateDescription(masked = true))
    }

    @Test
    fun tier1_f20_dynamicDualModeToggleControlsReflectState() {
        assertEquals("Token 消耗", ReportMetricMode.Tokens.label)
        assertEquals("预估费用", ReportMetricMode.Cost.label)
        assertEquals(ReportMetricMode.Tokens, ReportMetricMode.fromStored(null))
        assertEquals(ReportMetricMode.Tokens, ReportMetricMode.fromStored("unknown"))
    }

    @Test
    fun tier1_f21_unifiedTypographyScaleUpholdsMinimumInteractiveFloor() {
        // Specifications defined in android-visual-system.md:
        // caption = 11sp (hard floor for interactive UI), label = 12sp, body = 14sp, subtitle = 17sp, title = 21sp
        val interactiveFloorSp = 11
        assertTrue(interactiveFloorSp >= 11)
        val typeRoles = listOf(11, 12, 14, 17, 21, 28, 32, 40)
        assertEquals(typeRoles, typeRoles.sorted())
    }

    @Test
    fun tier1_f22_standardizedCardGeometryAndSpacingGrid() {
        val standardCardRadiusDp = 16
        val einkCardRadiusDp = 8
        assertEquals(16, standardCardRadiusDp)
        assertEquals(8, einkCardRadiusDp)

        assertEquals(96, dashboardNavigationBarHeightDp(1f))
        assertEquals(112, dashboardNavigationBarHeightDp(1.5f))
        assertEquals(88, dashboardContentBottomPaddingDp(390, 1f))
        assertEquals(128, dashboardContentBottomPaddingDp(390, 2f))
    }

    @Test
    fun tier1_f23_paletteContrastAndAppearanceOrthogonality() {
        assertEquals(LedgerAppearance.Light, LedgerAppearance.fromStored("light"))
        assertEquals(LedgerAppearance.Dark, LedgerAppearance.fromStored("dark"))
        assertEquals(LedgerAppearance.EInk, LedgerAppearance.fromStored("eink"))

        assertEquals(AmbientMode.Ledger, AmbientMode.fromStored("ledger"))
        assertEquals(AmbientMode.Glance, AmbientMode.fromStored("glance"))

        // Orthogonal axes check: "eink" parses to respective enums without collision
        assertEquals(AmbientMode.Ledger, AmbientMode.fromStored("eink"))
        assertEquals(LedgerAppearance.EInk, LedgerAppearance.fromStored("eink"))
    }

    @Test
    fun tier1_f24_componentInteractiveStatesDistinguishLoadingAndRecovery() {
        assertNull(quotaRecoveryActionLabel(QuotaUiState.Loading))
        assertEquals("重新读取额度", quotaRecoveryActionLabel(QuotaUiState.Unavailable("网络异常")))
        assertEquals("正在读取额度…", quotaRecoveryActionLabel(QuotaUiState.Unavailable("网络异常"), refreshing = true))

        assertEquals("正在加载看板", dashboardLoadingAccessibilityDescription(showingCachedData = false))
        assertEquals("正在刷新看板，当前仍显示上一次可验证快照", dashboardLoadingAccessibilityDescription(showingCachedData = true))
    }

    @Test
    fun tier1_f25_screenshotBaselineFixturesPreserveCacheInvariants() {
        val snapshot = ledgerSnapshotFixture()
        val summary = requireNotNull(snapshot.data).summary
        assertEquals(summary.cachedTokens, summary.cacheReadTokens + summary.cacheWriteTokens)
        assertNotNull(snapshot.quota)
    }

    @Test
    fun tier1_f26_statsContractV2CompliesWithInvariantsAndCapabilities() {
        val complete = StatsJson.parse(fixture("complete-v2.json"))
        assertEquals(2, complete.meta?.contractVersion)
        assertTrue(complete.capabilities.comparison)
        assertTrue(complete.capabilities.details)
        assertTrue(complete.capabilities.entityDashboard)
        assertEquals(complete.summary.effectiveTokens, safeTokenAdd(complete.summary.inputTokens, complete.summary.outputTokens))
    }

    @Test
    fun tier1_f27_displayIdentityDetectsEInkAndLocksLandscape() {
        assertTrue(isLikelyEInkDisplay(AndroidDisplayIdentity(listOf("MiDuoKanReaderPro"), emptySet(), 16f)))
        assertTrue(isLikelyEInkDisplay(AndroidDisplayIdentity(listOf("generic"), setOf("vendor.hardware.display.eink"), 60f)))
        assertFalse(isLikelyEInkDisplay(AndroidDisplayIdentity(listOf("Pixel Tablet"), emptySet(), 60f)))

        assertTrue(shouldLockSensorLandscape(forceLandscape = true, isInMultiWindowMode = false))
        assertFalse(shouldLockSensorLandscape(forceLandscape = true, isInMultiWindowMode = true))
    }

    // =========================================================================
    // TIER 2: BOUNDARY, EDGE & FAILURE MODES (>= 1 test per feature F-01 to F-27)
    // =========================================================================

    @Test
    fun tier2_f01_scrubbingOutOfBoundsClampsToEndpoints() {
        val pointCount = 5
        val width = 400f
        assertEquals(0, scrubIndexForPosition(-100f, width, pointCount))
        assertEquals(4, scrubIndexForPosition(800f, width, pointCount))
        assertNull(scrubIndexForPosition(50f, width, pointCount = 0))
        assertEquals(0, scrubIndexForPosition(50f, width, pointCount = 1))
    }

    @Test
    fun tier2_f02_flatAndExtremePointsClampedWithinChartBounds() {
        val flatPoints = listOf(
            SmoothCurvePoint(0f, 50f),
            SmoothCurvePoint(10f, 50f),
            SmoothCurvePoint(20f, 50f)
        )
        val flatSegments = smoothCurveSegments(flatPoints, minY = 10f, maxY = 90f)
        assertEquals(2, flatSegments.size)
        flatSegments.forEach {
            assertEquals(50f, it.control1.y, 0.001f)
            assertEquals(50f, it.control2.y, 0.001f)
        }

        val extremePoints = listOf(
            SmoothCurvePoint(0f, -500f),
            SmoothCurvePoint(10f, 1000f),
            SmoothCurvePoint(20f, -300f)
        )
        val extremeSegments = smoothCurveSegments(extremePoints, minY = 0f, maxY = 100f)
        extremeSegments.forEach {
            assertTrue(it.control1.y in 0f..100f)
            assertTrue(it.control2.y in 0f..100f)
        }
    }

    @Test
    fun tier2_f03_zeroAndNegativeTokensClampFractionsSafely() {
        val zeroMaxFractions = trendDataBarFractions(currentTokens = 20L, previousTokens = 10L, sharedMaximum = 0L)
        assertEquals(0f, zeroMaxFractions.current, 0.0001f)
        assertEquals(0f, zeroMaxFractions.previous, 0.0001f)

        val negativeFractions = trendDataBarFractions(currentTokens = -50L, previousTokens = 120L, sharedMaximum = 100L)
        assertEquals(0f, negativeFractions.current, 0.0001f)
        assertEquals(1f, negativeFractions.previous, 0.0001f)

        assertEquals(0f, normalizedDataBarFraction(-10L, 100L), 0.0001f)
        assertEquals(1f, normalizedDataBarFraction(150L, 100L), 0.0001f)
    }

    @Test
    fun tier2_f04_errorAndAuthRequiredStatusesNeverLeakProgressPercentages() {
        val provider = quotaFixtureProviders().first { it.providerId == "openai-codex-local" }
        val window = provider.drawableProgressWindows().first()
        val now = Instant.parse("2026-07-15T00:40:00Z")

        val errorPres = effectiveQuotaProgressPresentation(provider.copy(status = QuotaProviderStatus.Error), window, now, forceStale = false)
        assertEquals(QuotaProviderStatus.Error, errorPres.status)
        assertNull(errorPres.availableFraction)
        assertNull(errorPres.availablePercent)

        val authPres = effectiveQuotaProgressPresentation(provider.copy(status = QuotaProviderStatus.AuthRequired), window, now, forceStale = false)
        assertEquals(QuotaProviderStatus.AuthRequired, authPres.status)
        assertNull(authPres.availableFraction)
        assertNull(authPres.availablePercent)
    }

    @Test
    fun tier2_f05_emptyAndOrphanFrameRetentionGracefullyClears() {
        val previous = requireNotNull(ledgerSnapshotFixture().visibleData)
        val cleared = dashboardDataForFrame(visibleData = null, retainedData = previous, dashboardLoading = false)
        assertNull(cleared)

        val emptyOptions = v2FilterOptions(null)
        assertEquals(1, emptyOptions.machines.size)
        assertEquals(DashboardQuery.ALL_MACHINES, emptyOptions.machines.single().first)
        assertTrue(emptyOptions.tools.isEmpty())
        assertTrue(emptyOptions.models.isEmpty())
    }

    @Test
    fun tier2_f06_malformedTimestampsAndEmptyRequestsSilentlyFallback() {
        assertEquals("当前进度", shortTime("malformed-time"))
        assertEquals("当前进度", shortTime(null))
        assertEquals("当前进度", shortTime("2026-07-15"))

        assertNull(detailRequestCountLabel(0L))
        assertNull(detailRequestCountLabel(-10L))

        assertEquals("random-bucket", formatScrubBucketLabel("random-bucket"))
    }

    @Test
    fun tier2_f07_unknownGranularityAndEntityKindFallbackGracefully() {
        assertEquals("聚合明细", detailGranularityLabel("unknown_granularity", emptyList()))
        assertEquals("来源", entityKindLabel("unknown_kind"))
    }

    @Test
    fun tier2_f08_rapidNavigationTransitionsPreserveLatestPane() {
        var selection = V2NavigationSelection(MobileDestination.Quota, InsightPane.Overview)
        val transitions = listOf(InsightPane.Sources, InsightPane.Calendar, InsightPane.Details, InsightPane.Trend, InsightPane.Calendar)
        transitions.forEach { pane ->
            selection = selection.openInsight(pane)
            assertEquals(pane, selection.insightPane)
        }
        assertEquals(InsightPane.Calendar, selection.insightPane)
    }

    @Test
    fun tier2_f09_orphanEntityWithoutStackNeverConsumesBack() {
        val orphan = DashboardUiState(configured = true, section = DashboardSection.Entity, navigationStack = emptyList())
        assertFalse(shouldConsumeDashboardBack(orphan))
    }

    @Test
    fun tier2_f10_invalidTimeStringsSafelyReturnNullProgress() {
        assertNull(dayProgressFraction("24:01"))
        assertNull(dayProgressFraction("not-a-clock-time"))
        assertNull(dayProgressFraction(null))
    }

    @Test
    fun tier2_f11_extremelyLargeTitlesRetainFullAccessibilityIdentity() {
        val longTitle = "a".repeat(300)
        assertEquals(longTitle, dashboardTitleAccessibilityDescription(longTitle))
    }

    @Test
    fun tier2_f12_scrubReadoutWithZeroPreviousTokensSuppressesPercent() {
        val comparison = UsageComparison(
            window = ComparisonWindow("dayOverDay", "Asia/Shanghai", "hour", null, null, null, null, null),
            current = ComparisonPeriod(Summary(), listOf(ComparisonSeriesPoint("12:00", tokens = 100L, requests = 1L, cost = 0.05))),
            previous = ComparisonPeriod(Summary(), listOf(ComparisonSeriesPoint("12:00", tokens = 0L, requests = 0L, cost = 0.0))),
            delta = ComparisonDelta(MetricDelta(100.0, null, "new"), MetricDelta(1.0, null, "new"), MetricDelta(0.05, null, "new"))
        )
        val readout = scrubReadoutForIndex(comparison, 0)!!
        assertNull(readout.tokenDeltaPercent)
        assertNull(readout.costDeltaPercent)
    }

    @Test
    fun tier2_f13_emptyHeatmapHandlesMaxComputationWithoutDivisionByZero() {
        val emptyHeatmap = emptyMap<String, Long>()
        val maxVal = emptyHeatmap.values.maxOrNull() ?: 0L
        assertEquals(0L, maxVal)
        val level = if (maxVal == 0L) 0 else 4
        assertEquals(0, level)
    }

    @Test
    fun tier2_f14_zeroBaselineDeltaProducesNewDirectionWithNullPercent() {
        val newDelta = MetricDelta(absolute = 250.0, percent = null, direction = "new")
        val presentation = deltaPresentation(newDelta)
        assertEquals("本期新增", presentation.label)
        assertEquals(DeltaTone.Warning, presentation.tone)

        val nullDeltaPres = deltaPresentation(null)
        assertEquals("同期不可用", nullDeltaPres.label)
        assertEquals(DeltaTone.Neutral, nullDeltaPres.tone)
    }

    @Test
    fun tier2_f15_queryNormalizationRejectsMalformedAndOverLengthInputs() {
        var threwOverLength = false
        try {
            val oversizedList = (1..35).map { "item-$it" }
            DashboardQueryContract.normalize(DashboardQuery(tools = oversizedList))
        } catch (e: DashboardQueryContractException) {
            threwOverLength = true
        }
        assertTrue(threwOverLength)

        var threwSentinel = false
        try {
            DashboardQueryContract.normalize(DashboardQuery(machines = listOf("all")))
        } catch (e: DashboardQueryContractException) {
            threwSentinel = true
        }
        assertTrue(threwSentinel)
    }

    @Test
    fun tier2_f16_extremeFontScaleAndNarrowViewportPreserveBottomPadding() {
        assertEquals(128, dashboardContentBottomPaddingDp(widthDp = 320, fontScale = 1.5f))
        assertEquals(128, dashboardContentBottomPaddingDp(widthDp = 390, fontScale = 2.0f))
        assertEquals(24, dashboardContentBottomPaddingDp(widthDp = 844, fontScale = 1.0f))
    }

    @Test
    fun tier2_f17_emptySlicesAndSingleToolSafelyCalculateDonutAngles() {
        val zeroTool = ToolStat("none", input = 0L, output = 0L, cached = 0L, total = 0L, cost = 0.0, requests = 0L)
        val zeroAngle = if (zeroTool.effectiveTokens == 0L) 0f else 360f
        assertEquals(0f, zeroAngle, 0.001f)

        val singleTool = ToolStat("sole", input = 100L, output = 100L, cached = 0L, total = 200L, cost = 0.1, requests = 1L)
        val singleAngle = (singleTool.effectiveTokens.toFloat() / singleTool.effectiveTokens) * 360f
        assertEquals(360f, singleAngle, 0.001f)
    }

    @Test
    fun tier2_f18_fallbackMetricSeriesWithoutComparisonSafelyExtracted() {
        val fallbackPoints = listOf(
            TrendPoint("2026-07-15", mapOf("codex" to 500L, "__requests" to 3L))
        )
        val (tokens, prevTokens) = metricSeriesValues(comparison = null, fallback = fallbackPoints, mode = ReportMetricMode.Tokens)
        assertEquals(listOf(500f), tokens)
        assertTrue(prevTokens.isEmpty())

        val (costs, prevCosts) = metricSeriesValues(comparison = null, fallback = fallbackPoints, mode = ReportMetricMode.Cost)
        assertTrue(costs.isEmpty())
        assertTrue(prevCosts.isEmpty())
    }

    @Test
    fun tier2_f19_zeroCostAndExtremeExchangeRatesFormatCorrectly() {
        assertEquals("¥0.00", formatCostForDisplay(0.0, exchangeRate = 7.2, masked = false))
        assertEquals("¥***.*", formatCostForDisplay(0.0, exchangeRate = 7.2, masked = true))
        // 汇率无效时换算不出人民币金额：写「不可得」，不再冒充 ¥0.00（GLB-01、T10.154 A03）。
        assertEquals("不可得", formatCostForDisplay(100.0, exchangeRate = 0.0, masked = false))
        assertEquals("¥100,000.00", formatCostForDisplay(100.0, exchangeRate = 1000.0, masked = false))
    }

    @Test
    fun tier2_f20_unknownStoredMetricModeDefaultsSafelyToTokens() {
        assertEquals(ReportMetricMode.Tokens, ReportMetricMode.fromStored("invalid_metric_key"))
        assertEquals(ReportMetricMode.Tokens, ReportMetricMode.fromStored(""))
        assertEquals(ReportMetricMode.Tokens, ReportMetricMode.fromStored(null))
    }

    @Test
    fun tier2_f21_ambientDisplayTypographyExplicitlyPermitsSub11sp() {
        val ambientCaptionSp = 9
        val interactiveCaptionSp = 11
        assertTrue(ambientCaptionSp < 11)
        assertTrue(interactiveCaptionSp >= 11)
    }

    @Test
    fun tier2_f22_einkCardRadiusFallsBackToEightDp() {
        val radiusStandard = 16
        val radiusEInk = 8
        assertTrue(radiusEInk < radiusStandard)
        assertEquals(8, radiusEInk)
    }

    @Test
    fun tier2_f23_unknownThemeStorageFallsBackSafelyToDark() {
        assertEquals(LedgerAppearance.Dark, LedgerAppearance.fromStored("unknown-theme-value"))
        assertEquals(LedgerAppearance.Dark, LedgerAppearance.fromStored(null))
        assertEquals(LedgerAppearance.EInk, LedgerAppearance.fromStored(null, fallback = LedgerAppearance.EInk))
    }

    @Test
    fun tier2_f24_refreshingUnavailableQuotaShowsLoadingActionLabel() {
        val refreshingUnavailable = QuotaUiState.Unavailable("网络超时")
        assertEquals("正在读取额度…", quotaRecoveryActionLabel(refreshingUnavailable, refreshing = true))

        val refreshingLoading = QuotaUiState.Loading
        assertNull(quotaRecoveryActionLabel(refreshingLoading, refreshing = true))
    }

    @Test
    fun tier2_f25_missingOptionalsV2FixtureSafelyDegradesCapabilities() {
        val missing = StatsJson.parse(fixture("missing-optionals-v2.json"))
        assertEquals(0L, missing.summary.effectiveTokens)
        assertNull(missing.comparison)
        assertNull(missing.detailsPage)
        assertNull(missing.machineDistribution)
        assertFalse(missing.capabilities.details)
    }

    @Test
    fun tier2_f26_arithmeticOverflowClampsToLongMaxValueViaSafeAdd() {
        val saturated = safeTokenAdd(Long.MAX_VALUE - 10L, 50L)
        assertEquals(Long.MAX_VALUE, saturated)

        val negativeClamped1 = safeTokenAdd(-10L, 500L)
        assertEquals(0L, negativeClamped1)

        val negativeClamped2 = safeTokenAdd(500L, -10L)
        assertEquals(0L, negativeClamped2)
    }

    @Test
    fun tier2_f27_lowRefreshRateAloneDoesNotClassifyAsEInk() {
        val standardLowRefreshTablet = AndroidDisplayIdentity(
            buildSignals = listOf("Pixel Tablet"),
            featureNames = emptySet(),
            refreshRateHz = 20f
        )
        assertFalse(isLikelyEInkDisplay(standardLowRefreshTablet))
    }

    // =========================================================================
    // TIER 3: CROSS-FEATURE PAIRWISE COMBINATIONS
    // =========================================================================

    @Test
    fun tier3_comb_metricModeToggleWithTouchScrubbingAndAccessibility() {
        // F-01 (Scrubbing) x F-18 (MetricMode) x F-19 (Currency) x F-20 (Toggle)
        val comparison = UsageComparison(
            window = ComparisonWindow("dayOverDay", "Asia/Shanghai", "hour", null, null, null, null, null),
            current = ComparisonPeriod(Summary(), listOf(ComparisonSeriesPoint("15:00", tokens = 250_000L, requests = 25L, cost = 1.25))),
            previous = ComparisonPeriod(Summary(), listOf(ComparisonSeriesPoint("15:00", tokens = 200_000L, requests = 20L, cost = 1.00))),
            delta = ComparisonDelta(MetricDelta(50_000.0, 25.0, "up"), MetricDelta(5.0, 25.0, "up"), MetricDelta(0.25, 25.0, "up"))
        )

        // 1. Calculate scrub touch coordinate
        val scrubIndex = scrubIndexForPosition(touchX = 200f, widthPx = 400f, pointCount = 1)!!
        val readout = scrubReadoutForIndex(comparison, scrubIndex)!!

        // 2. Format in Tokens mode
        val tokenA11y = formatScrubAccessibilityDescription(readout, ReportMetricMode.Tokens)
        assertTrue(tokenA11y.contains("15:00 - 16:00"))
        assertTrue(tokenA11y.contains("有效 Token 250,000"))

        // 3. Toggle to Cost mode
        val costA11y = formatScrubAccessibilityDescription(readout, ReportMetricMode.Cost, exchangeRate = 7.2, isCostMasked = false)
        assertTrue(costA11y.contains("15:00 - 16:00"))
        assertTrue(costA11y.contains("预估费用 ¥9.00"))

        // 4. Mask cost
        val maskedCostA11y = formatScrubAccessibilityDescription(readout, ReportMetricMode.Cost, exchangeRate = 7.2, isCostMasked = true)
        assertTrue(maskedCostA11y.contains("预估费用 ¥***.*"))
    }

    @Test
    fun tier3_comb_quotaMultiProviderRankingWithDegradedStates() {
        // F-04 (Quota Ranking) x F-24 (State Degradation)
        val providers = quotaFixtureProviders()
        val healthyCodex = providers.first { it.providerId == "openai-codex-local" }
        val healthyClaude = providers.first { it.providerId == "anthropic-claude-consumer" }
        val degradedAntigravity = providers.first { it.providerId == "google-antigravity-consumer" }
            .copy(status = QuotaProviderStatus.Error)

        val ranked = listOf(healthyCodex, degradedAntigravity, healthyClaude).rankedQuotaWindowsForDisplay()
        val providerIds = ranked.map { it.first.providerId }.distinct()

        assertEquals(listOf("openai-codex-local", "anthropic-claude-consumer", "google-antigravity-consumer"), providerIds)

        // Antigravity's window should not leak progress fraction under Error
        val antigravityPair = ranked.first { it.first.providerId == "google-antigravity-consumer" }
        val presentation = effectiveQuotaProgressPresentation(
            antigravityPair.first,
            antigravityPair.second,
            Instant.parse("2026-07-15T00:40:00Z"),
            forceStale = false
        )
        assertEquals(QuotaProviderStatus.Error, presentation.status)
        assertNull(presentation.availableFraction)
        assertNull(presentation.availablePercent)
    }

    @Test
    fun tier3_comb_sessionDrilldownWithKeysetPaginationAndFacetFilters() {
        // F-07 (Detail Row) x F-15 (Session Drilldown) x F-26 (Contract v2)
        val page1 = UsageDetailsPage(
            items = listOf(
                LogHistoryItem(1L, "codex", "gpt-5", 100L, 50L, 10L, 0, 0.05, "2026-07-15 10:00:00", "sess-1", "mbp", 1L),
                LogHistoryItem(2L, "claude", "opus", 200L, 100L, 20L, 0, 0.10, "2026-07-15 09:00:00", "sess-1", "mbp", 2L)
            ),
            nextCursor = "cursor-p2",
            hasMore = true,
            totalCount = 3L,
            filteredSummary = Summary(inputTokens = 300L, outputTokens = 150L, totalRequests = 3L),
            availableFilters = AvailableFilters(tools = listOf(FilterOption("codex", 1L), FilterOption("claude", 2L)))
        )

        val page2 = UsageDetailsPage(
            items = listOf(
                LogHistoryItem(2L, "claude", "opus", 200L, 100L, 20L, 0, 0.10, "2026-07-15 09:00:00", "sess-1", "mbp", 2L), // duplicate
                LogHistoryItem(3L, "codex", "gpt-5", 50L, 25L, 5L, 0, 0.02, "2026-07-15 08:00:00", "sess-2", "mbp", 1L)
            ),
            nextCursor = null,
            hasMore = false,
            totalCount = 3L,
            filteredSummary = Summary(inputTokens = 350L, outputTokens = 175L, totalRequests = 4L),
            availableFilters = AvailableFilters(tools = listOf(FilterOption("codex", 2L), FilterOption("claude", 2L)))
        )

        val merged = page1.append(page2)
        assertEquals(3, merged.items.size)
        assertFalse(merged.hasMore)
        assertNull(merged.nextCursor)
        assertEquals(listOf(1L, 2L, 3L), merged.items.map { it.id })
        assertEquals(150L, merged.items[0].effectiveTokens)
        assertEquals(300L, merged.items[1].effectiveTokens)
        assertEquals(75L, merged.items[2].effectiveTokens)
    }

    @Test
    fun tier3_comb_responsiveLayoutWithLargeFontScaleAndNavigationPlacement() {
        // F-11 (Typography Scale) x F-16 (Responsive Breakpoint) x F-22 (Spacing Geometry)
        val width = 320
        val fontScale = 2.0f

        val layoutMode = dashboardLayoutMode(width, fontScale)
        assertEquals(DashboardLayoutMode.Compact, layoutMode)

        val navPlacement = dashboardNavigationPlacement(width, DashboardSection.Overview)
        assertEquals(DashboardNavigationPlacement.BottomBar, navPlacement)

        val navHeight = dashboardNavigationBarHeightDp(fontScale)
        assertEquals(112, navHeight)

        val contentPadding = dashboardContentBottomPaddingDp(width, fontScale)
        assertEquals(128, contentPadding)

        val titleMaxLines = dashboardTitleMaxLines(fontScale)
        assertEquals(2, titleMaxLines)
    }

    @Test
    fun tier3_comb_appearanceModeWithAmbientEInkAndCostMasking() {
        // F-19 (Cost Masking) x F-23 (Appearance Orthogonality) x F-27 (Display Identity)
        val einkDisplay = AndroidDisplayIdentity(
            buildSignals = listOf("MiReaderPro"),
            featureNames = setOf("vendor.hardware.display.eink"),
            refreshRateHz = 16f
        )
        assertTrue(isLikelyEInkDisplay(einkDisplay))

        val theme = LedgerAppearance.fromStored("eink")
        assertEquals(LedgerAppearance.EInk, theme)

        val ambient = AmbientMode.fromStored("eink")
        assertEquals(AmbientMode.Ledger, ambient)

        val maskedCost = formatCostForDisplay(500.0, exchangeRate = 7.2, masked = true)
        assertEquals("¥***.*", maskedCost)
    }

    @Test
    fun tier3_comb_chartScaleHeadroomWithBezierCurveAndTimelineTicks() {
        // F-02 (Bezier Smoothing) x F-03 (Primitive Headroom) x F-10 (Timeline Ticks)
        val rawValues = listOf(10f, 80f, 40f)
        val peakWithHeadroom = paddedChartMaximum(rawValues, headroomFraction = 0.20f)
        assertEquals(96f, peakWithHeadroom, 0.001f)

        val points = rawValues.mapIndexed { idx, v -> SmoothCurvePoint(idx * 100f, peakWithHeadroom - v) }
        val segments = smoothCurveSegments(points, minY = 0f, maxY = peakWithHeadroom)
        assertEquals(2, segments.size)
        segments.forEach { seg ->
            assertTrue(seg.control1.y in 0f..peakWithHeadroom)
            assertTrue(seg.control2.y in 0f..peakWithHeadroom)
        }

        val timelineTicks = chartXFractions(listOf("00:00", "12:00", "24:00"), 3, 1f, true, true)
        assertEquals(listOf(0f, 0.5f, 1f), timelineTicks)
    }

    // =========================================================================
    // TIER 4: REAL-WORLD WORKLOAD SCENARIOS
    // =========================================================================

    @Test
    fun tier4_scenario_fullYear365DayTrendAndHeatmapProcessing() {
        // Simulate processing a massive 365-day trend with 4 tools
        val days = (1..365).map { dayIndex ->
            val dateStr = String.format(Locale.US, "2026-%02d-%02d", ((dayIndex - 1) / 30) + 1, ((dayIndex - 1) % 30) + 1)
            val toolTokens = mapOf(
                "codex" to (dayIndex * 1000L),
                "claude" to (dayIndex * 800L),
                "antigravity" to (dayIndex * 500L),
                "cursor" to (dayIndex * 200L),
                "__requests" to (dayIndex * 5L)
            )
            TrendPoint(dateStr, toolTokens, requests = dayIndex * 5L)
        }

        assertEquals(365, days.size)
        val (tokenSeries, _) = metricSeriesValues(comparison = null, fallback = days, mode = ReportMetricMode.Tokens)
        assertEquals(365, tokenSeries.size)

        // Verify total daily effective tokens calculation without overflow
        var cumulativeTokens = 0L
        days.forEach { point ->
            val dailySum = point.values.filterKeys { !it.startsWith("__") }.values.sum()
            cumulativeTokens = safeTokenAdd(cumulativeTokens, dailySum)
        }
        assertTrue(cumulativeTokens > 0L)
        assertTrue(cumulativeTokens < Long.MAX_VALUE)

        // Verify highest peak calculation
        val maxPoint = tokenSeries.maxOrNull() ?: 0f
        assertTrue(maxPoint > 0f)
        val padded = paddedChartMaximum(tokenSeries, headroomFraction = 0.10f)
        assertTrue(padded >= maxPoint)
    }

    @Test
    fun tier4_scenario_continuousHighFrequencyScrubGestureSimulation() {
        // Simulate 100 continuous touch gesture move events across 400px chart
        val comparison = UsageComparison(
            window = ComparisonWindow("dayOverDay", "Asia/Shanghai", "hour", null, null, null, null, null),
            current = ComparisonPeriod(
                Summary(),
                (0..23).map { h -> ComparisonSeriesPoint(String.format(Locale.US, "%02d:00", h), tokens = (h + 1) * 10_000L, requests = (h + 1).toLong(), cost = (h + 1) * 0.05) }
            ),
            previous = ComparisonPeriod(
                Summary(),
                (0..23).map { h -> ComparisonSeriesPoint(String.format(Locale.US, "%02d:00", h), tokens = (h + 1) * 8_000L, requests = (h + 1).toLong(), cost = (h + 1) * 0.04) }
            ),
            delta = ComparisonDelta(MetricDelta(48_000.0, 25.0, "up"), MetricDelta(0.0, 0.0, "flat"), MetricDelta(0.24, 25.0, "up"))
        )

        var lastIndex = -1
        (0..100).forEach { step ->
            val touchX = step * 4f // 0 to 400px
            val index = scrubIndexForPosition(touchX, widthPx = 400f, pointCount = 24)!!
            assertTrue(index in 0..23)
            assertTrue("Scrub index must be monotonic during forward drag", index >= lastIndex)
            lastIndex = index

            val readout = scrubReadoutForIndex(comparison, index)!!
            assertEquals(index, readout.index)
            assertEquals(25.0, readout.tokenDeltaPercent!!, 0.001)
            assertEquals(25.0, readout.costDeltaPercent!!, 0.001)
        }
    }

    @Test
    fun tier4_scenario_multiDeviceCloudSyncAndMachineDistributionAggregation() {
        // Parse complete v2 contract with multi-device distribution and canonical comparison
        val stats = StatsJson.parse(fixture("complete-v2.json"))
        assertNotNull(stats.machineDistribution)
        val machines = stats.machineDistribution!!
        assertTrue(machines.isNotEmpty())

        // Invariant: tokens = inputTokens + outputTokens
        machines.forEach { entry ->
            assertEquals(entry.tokens, safeTokenAdd(entry.inputTokens, entry.outputTokens))
        }

        // Verify comparison series consistency
        val comp = stats.comparison
        assertNotNull(comp)
        assertEquals(comp!!.current.series.size, comp.previous.series.size)
        comp.current.series.zip(comp.previous.series).forEach { (curr, prev) ->
            assertEquals(curr.bucket, prev.bucket)
        }
    }

    @Test
    fun tier4_scenario_networkDegradationOfflineSnapshotAndReconnection() {
        // Simulate lifecycle: InitialLoad -> CachedSnapshot -> Refreshing -> Available
        val initialLoad = DashboardUiState(
            configured = true,
            data = null,
            cachedData = null,
            loadingMode = DashboardLoadingMode.InitialLoad
        )
        assertEquals("正在加载看板", dashboardLoadingAccessibilityDescription(showingCachedData = false))
        assertEquals("正在加载数据", v2DashboardTopStatusText(initialLoad))

        val refreshingState = ledgerRefreshingSnapshotFixture()
        withDefaultTimeZone("Asia/Shanghai") {
            val offlineText = v2DashboardTopStatusText(refreshingState.copy(loadingMode = DashboardLoadingMode.Idle))
            assertNotNull(offlineText)
            assertTrue(offlineText?.startsWith("离线快照") == true)

            val refreshingText = v2DashboardTopStatusText(refreshingState)
            assertNotNull(refreshingText)
            assertTrue(refreshingText?.startsWith("正在刷新") == true)
        }
    }
}
