package com.jeidorf.tokenledger.mobile

import android.graphics.Bitmap
import android.os.Bundle
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** T10.118c：直接组合生产图表、排行、额度卡与选择控件的 N2301 原生验收。 */
class ChartQuotaNativeTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun normalTrendUsesProductionChartAndTable() {
        mount(ChartQuotaPreviewSurface.Trend, chartStats(), metric = ReportMetricMode.Cost)
        text("同期趋势").assertIsDisplayed()
        described("当前峰值时段 2026-09-07 01:00:00，$12.34，3 条记录").assertIsDisplayed()
        text("当前周期 · 费用").assertIsDisplayed()
        text("上一周期 · 费用").assertIsDisplayed()
        val rows = compose.onAllNodes(hasContentDescription("本期时段 ", substring = true)).fetchSemanticsNodes()
            .map { it.config[SemanticsProperties.ContentDescription].single() }
        assertEquals(listOf(
            "本期时段 2026-09-07 01:00:00，$12.34；上期时段 2026-09-06 01:00:00，$6.78",
            "本期时段 2026-09-07 02:00:00，<$0.01；上期时段 2026-09-06 02:00:00，<$0.01",
            "本期时段 不可得，不可得；上期时段 2026-09-06 03:00:00，$1.20"
        ), rows)
        record("trend-normal", injectedFontScale = 1f)
    }

    @Test
    fun emptyCurrentTrendHasHonestEmptyState() {
        mount(ChartQuotaPreviewSurface.Trend, chartStats(current = emptyList()), metric = ReportMetricMode.Cost)
        assertTrue(compose.onAllNodesWithText("当前范围暂无费用趋势", substring = true).fetchSemanticsNodes().isNotEmpty())
        record("trend-current-empty", injectedFontScale = 1f)
    }

    @Test
    fun missingPreviousTrendRemainsUnavailable() {
        mount(ChartQuotaPreviewSurface.Trend, chartStats(previous = emptyList()), metric = ReportMetricMode.Cost)
        assertTrue(compose.onAllNodesWithText("上一周期数据不可得", substring = true).fetchSemanticsNodes().isNotEmpty())
        record("trend-missing-previous", injectedFontScale = 1f)
    }

    @Test
    fun unequalTrendPeriodsKeepEveryOriginalSlot() {
        val stats = chartStats(
            current = listOf(point("2026-09-07 01:00:00", 17, .2)),
            previous = listOf(
                point("2026-09-06 01:00:00", 13, .1),
                point("2026-09-06 02:00:00", 19, .3)
            )
        )
        mount(ChartQuotaPreviewSurface.Trend, stats, metric = ReportMetricMode.Cost)
        val rows = compose.onAllNodes(hasContentDescription("本期时段 ", substring = true))
            .fetchSemanticsNodes().map { it.config[SemanticsProperties.ContentDescription].single() }
        assertEquals("两个原始槽位都必须存在：$rows", 2, rows.size)
        assertEquals(listOf(
            "本期时段 2026-09-07 01:00:00，$0.20；上期时段 2026-09-06 01:00:00，$0.10",
            "本期时段 不可得，不可得；上期时段 2026-09-06 02:00:00，$0.30"
        ), rows)
        record("trend-unequal", injectedFontScale = 1f)
    }

    @Test
    fun sixSourcesUseFullDenominatorAndNeutralRemainder() {
        mount(ChartQuotaPreviewSurface.Sources, chartStats())
        val donut = compose.onNode(hasContentDescription("来源构成，总计 210,000 Token", substring = true))
        val semantics = donut.fetchSemanticsNode().config[SemanticsProperties.ContentDescription].joinToString()
        assertTrue(semantics.contains("未显示 10,000 Token"))
        assertTrue(semantics.endsWith("未显示 10,000 Token，5%"))
        assertFalse(semantics.contains("来源 6"))
        val rawValues = chartStats().tools.values.map { it.effectiveTokens }.sortedDescending()
        val total = rawValues.sum()
        val remainder = total - rawValues.take(5).sum()
        assertEquals(210_000L, total)
        assertEquals(10_000L, remainder)
        val remainderPercent = remainder * 100.0 / total
        assertTrue(remainderPercent >= 4.7 && remainderPercent <= 4.8)
        val neutral = donutPresentation(rawValues.take(5), total).segments.single { it.sourceIndex == null }
        assertEquals(remainder, neutral.value)
        text("未显示 5%").assertIsDisplayed().assertHasNoClickAction()
        assertTrue(compose.onAllNodes(hasText("未显示 5%") and hasClickAction()).fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodes(hasText("opencode") and hasClickAction()).fetchSemanticsNodes().isEmpty())
        record("sources-six-full-denominator", injectedFontScale = 1f)
    }

    @Test
    fun zeroSourceDoesNotCreateArcOrVisibleRow() {
        mount(ChartQuotaPreviewSurface.OverviewTools, chartStats(zeroTools = setOf("opencode")))
        compose.onNode(hasContentDescription("来源构成，总计 200,000 Token", substring = true)).assertIsDisplayed()
        compose.onNodeWithText("opencode", useUnmergedTree = true).assertDoesNotExist()
        record("sources-zero-segment", injectedFontScale = 1f)
    }

    @Test
    fun allZeroCompositionUsesHonestEmptyState() {
        mount(ChartQuotaPreviewSurface.Composition, chartStats(allZero = true))
        assertTrue(compose.onAllNodesWithText("暂无 Token 构成", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodes(hasContentDescription("暂无来源构成")).fetchSemanticsNodes().isNotEmpty())
        record("sources-all-zero", injectedFontScale = 1f)
    }

    @Test
    fun constrained320DpFontScaleTwoKeepsToolRanking() {
        mount(ChartQuotaPreviewSurface.OverviewTools, chartStats(), widthDp = 320, heightDp = 1500, fontScale = 2f)
        assertConstrainedWidth(320)
        listOf("codex", "claude", "gemini", "cursor").forEach { name ->
            assertTrue("missing tool $name", compose.onAllNodesWithText(name, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        }
        record("ranking-tools-320-font2", injectedFontScale = 2f, constrainedWidthDp = 320)
    }

    @Test
    fun constrained320DpFontScaleTwoKeepsModelRanking() {
        mount(ChartQuotaPreviewSurface.ModelRanking, chartStats(), widthDp = 320, heightDp = 1500, fontScale = 2f)
        assertConstrainedWidth(320)
        listOf("gpt-5-long-context", "claude-sonnet", "gemini-pro").forEach { name -> text(name).assertIsDisplayed() }
        record("ranking-models-320-font2", injectedFontScale = 2f, constrainedWidthDp = 320)
    }

    @Test
    fun constrained320DpFontScaleTwoMasksEveryModelCost() {
        mount(
            ChartQuotaPreviewSurface.ModelRanking,
            chartStats(),
            metric = ReportMetricMode.Cost,
            masked = true,
            widthDp = 320,
            heightDp = 1100,
            fontScale = 2f
        )
        assertConstrainedWidth(320)
        compose.onAllNodesWithText("***", substring = true, useUnmergedTree = true).fetchSemanticsNodes().let {
            assertTrue("masked cost must remain visibly represented", it.isNotEmpty())
        }
        val trees = semanticsDumps()
        listOf(trees.first, trees.second).forEach { tree ->
            assertFalse(tree.contains("12.34"))
            assertFalse(tree.contains("6.78"))
        }
        record("ranking-cost-masked-320-font2", injectedFontScale = 2f, constrainedWidthDp = 320)
    }

    @Test
    fun quotaMixedHistoryPreservesPerWindowFreshness() {
        mount(ChartQuotaPreviewSurface.Quota, chartStats(), quota = quotaAvailable(QuotaKind.Mixed))
        text("部分历史").assertIsDisplayed()
        val descriptions = compose.onAllNodes(hasContentDescription("更新于 ", substring = true))
            .fetchSemanticsNodes().flatMap { it.config[SemanticsProperties.ContentDescription] }
            .filter { it.contains("更新于 ") }
        assertEquals("必须发现两个独立额度窗口：$descriptions", 2, descriptions.size)
        val fresh = descriptions.single { it.contains("，5 小时额度，") }
        val old = descriptions.single { it.contains("，每周额度，") }
        assertTrue(fresh.startsWith("Codex 订阅额度，"))
        assertTrue(old.startsWith("Codex 订阅额度，"))
        assertTrue(fresh.contains("数据新鲜"))
        assertTrue(fresh.contains("可用 72%"))
        assertTrue(fresh.contains("更新于 2026-09-07 09:59:50 +08:00"))
        assertTrue(old.contains("历史数据"))
        assertTrue(old.contains("可用 72%"))
        assertTrue(old.contains("更新于 2026-09-06 09:00:00 +08:00"))
        record("quota-mixed-history", injectedFontScale = 1f)
    }

    @Test
    fun quotaExplicitErrorOverridesHistoricalValues() {
        mount(ChartQuotaPreviewSurface.Quota, chartStats(), quota = quotaAvailable(QuotaKind.Error))
        text("Codex 订阅额度").assertIsDisplayed()
        text("额度来源暂不可用").assertIsDisplayed()
        text("按桌面端额度页提示处理来源，完成刷新与同步后重新读取。").assertIsDisplayed()
        val descriptions = compose.onAllNodes(hasContentDescription("更新于 ", substring = true))
            .fetchSemanticsNodes().flatMap { it.config[SemanticsProperties.ContentDescription] }
        assertEquals(2, descriptions.size)
        descriptions.forEach { description ->
            assertTrue(description.contains("暂时不可用"))
            assertFalse(description.contains("72%"))
        }
        semanticsDumps().toList().forEach { assertFalse(it.contains("72%")) }
        assertTrue(
            compose.onAllNodesWithText("可用 72%", substring = true, useUnmergedTree = true)
                .fetchSemanticsNodes().isEmpty()
        )
        record("quota-explicit-error", injectedFontScale = 1f)
    }

    @Test
    fun quotaExpandedDetailsKeepFullTimesUnknownsAndPrivacyBoundary() {
        mount(
            ChartQuotaPreviewSurface.Quota,
            chartStats(),
            quota = quotaAvailable(QuotaKind.Details),
            details = true,
            widthDp = 320,
            heightDp = 1800,
            fontScale = 2f
        )
        assertConstrainedWidth(320)
        listOf(
            "消费者订阅 · 稳定来源",
            "云端投影 2026-09-07 10:00:03 +08:00",
            "本机缓存 未知",
            "观测 2026-09-07 09:59:50 +08:00",
            "抓取／读取 2026-09-07 09:59:55 +08:00",
            "重置 2026-09-08 08:00:00 +08:00"
        ).forEach { expected ->
            assertTrue("missing detail: $expected", compose.onAllNodesWithText(expected, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        }
        described("Codex 订阅额度 详情").fetchSemanticsNode().config[SemanticsProperties.StateDescription].let {
            assertEquals("详情已展开", it)
        }
        val trees = semanticsDumps()
        listOf(trees.first, trees.second).forEach { tree ->
            assertFalse(tree.contains("/Users/private"))
            assertFalse(tree.contains("token-secret"))
        }
        record("quota-details-320-font2", injectedFontScale = 2f, constrainedWidthDp = 320)
    }

    @Test
    fun fourControlStatesKeepMinimumTargetsAndNeighborGeometry() {
        val state = mutableStateOf(ChartQuotaControlState.Unselected)
        mount(ChartQuotaPreviewSurface.Controls, chartStats(), widthDp = 320, heightDp = 640,
            fontScale = 2f, controlState = state)
        val groups = listOf(
            "metric-token" to hasContentDescription("Token 消耗视图"),
            "metric-cost" to hasContentDescription("预估费用视图"),
            "currency-cny" to hasContentDescription("人民币币种"),
            "currency-usd" to hasContentDescription("美元币种"),
            "pane-trend" to (hasText("趋势") and hasClickAction()),
            "pane-sources" to (hasText("来源") and hasClickAction()),
            "pane-calendar" to (hasText("日历") and hasClickAction()),
            "pane-details" to (hasText("请求") and hasClickAction()),
            "refresh" to (hasClickAction() and (hasText("重新读取") or hasText("读取中…")))
        )
        val firstBounds = linkedMapOf<String, Rect>()
        ChartQuotaControlState.entries.forEachIndexed { index, next ->
            compose.runOnIdle { state.value = next }
            compose.waitForIdle()
            assertConstrainedWidth(320)
            text(next.label).assertIsDisplayed()
            ChartQuotaControlState.entries.filter { it != next }.forEach { text(it.label).assertDoesNotExist() }
            val viewport = compose.onNodeWithTag(CONTAINER_TAG).fetchSemanticsNode().boundsInRoot
            assertEquals("真实可见视口高度", 640f * compose.density.density, viewport.height, .5f)
            val evidenceBounds = linkedMapOf<String, Rect>()
            groups.forEach { (name, matcher) ->
                val nodes = compose.onAllNodes(matcher).fetchSemanticsNodes()
                assertEquals("$name 在当前状态必须唯一", 1, nodes.size)
                compose.onNode(matcher).assertIsDisplayed()
                val rect = nodes.single().boundsInRoot
                assertTrue("$name width below 48dp: $rect", rect.width >= minTargetPx() - .5f)
                assertTrue("$name height below 48dp: $rect", rect.height >= minTargetPx() - .5f)
                assertTrue("$name 必须完整处于视口: $rect / $viewport",
                    rect.left >= viewport.left && rect.top >= viewport.top &&
                        rect.right <= viewport.right && rect.bottom <= viewport.bottom)
                if (index == 0) firstBounds[name] = rect else {
                    val baseline = firstBounds.getValue(name)
                    assertEquals("$name relative x changed", baseline.left, rect.left, .5f)
                    assertEquals("$name relative y changed", baseline.top, rect.top, .5f)
                    assertEquals("$name width changed", baseline.width, rect.width, .5f)
                    assertEquals("$name height changed", baseline.height, rect.height, .5f)
                }
                evidenceBounds[name] = rect
            }
            record("controls-${next.name.lowercase()}-320-font2", evidenceBounds,
                injectedFontScale = 2f, constrainedWidthDp = 320)
        }
        assertEquals("九个控件完成四态测量", 9, firstBounds.size)
    }

    private fun mount(
        surface: ChartQuotaPreviewSurface,
        stats: StatsData,
        metric: ReportMetricMode = ReportMetricMode.Tokens,
        quota: QuotaUiState.Available? = null,
        details: Boolean = false,
        masked: Boolean = false,
        widthDp: Int? = null,
        heightDp: Int = 1800,
        fontScale: Float = 1f,
        controlState: State<ChartQuotaControlState>? = null
    ) {
        compose.setContent {
            val systemDensity = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(systemDensity.density, fontScale)) {
                val modifier = if (widthDp == null) Modifier.fillMaxSize() else Modifier.width(widthDp.dp).height(heightDp.dp)
                Box(modifier.testTag(CONTAINER_TAG)) {
                    V2ChartQuotaPreviewContent(surface, stats, metric = metric, quota = quota, details = details, masked = masked,
                        controlState = controlState?.value ?: ChartQuotaControlState.Unselected)
                }
            }
        }
        compose.waitForIdle()
    }

    private fun chartStats(
        current: List<ComparisonSeriesPoint> = listOf(
            point("2026-09-07 01:00:00", 1_234_567, 12.34),
            point("2026-09-07 02:00:00", 420_000, .007)
        ),
        previous: List<ComparisonSeriesPoint> = listOf(
            point("2026-09-06 01:00:00", 900_123, 6.78),
            point("2026-09-06 02:00:00", 230_000, .003),
            point("2026-09-06 03:00:00", 310_000, 1.2)
        ),
        zeroTools: Set<String> = emptySet(),
        allZero: Boolean = false
    ): StatsData {
        val names = listOf("codex", "claude", "gemini", "cursor", "aider", "opencode")
        val tools = names.mapIndexed { index, name ->
            val value = if (allZero || name in zeroTools) 0L else (6 - index) * 10_000L
            ToolStat(name, value, 0, 0, value, 0.0, 1)
        }
        val models = listOf(
            ModelStat("gpt-5-long-context", 120_000, 7, input = 100_000, output = 20_000, cached = 9_000, cost = 12.34),
            ModelStat("claude-sonnet", 70_000, 5, input = 60_000, output = 10_000, cached = 4_000, cost = 6.78),
            ModelStat("gemini-pro", 20_000, 2, input = 18_000, output = 2_000, cached = 0, cost = null)
        )
        val effective = tools.sumOf(ToolStat::effectiveTokens)
        val summary = Summary(
            totalTokens = effective,
            inputTokens = effective,
            outputTokens = 0,
            cachedTokens = 0,
            totalCost = 19.12,
            totalRequests = 15
        )
        return StatsData(
            summary = summary,
            tools = tools.associateBy(ToolStat::name),
            models = models.associateBy(ModelStat::name),
            trends = emptyList(),
            heatmap = emptyMap(),
            history = emptyList(),
            machines = listOf("n2301-fixture"),
            meta = StatsMeta(
                generatedAt = "2026-09-07T10:00:03+08:00",
                lastRefreshedAt = "2026-09-07T10:00:03+08:00",
                timezone = "Asia/Shanghai",
                range = "today",
                machine = null,
                stale = false,
                contractVersion = 2,
                query = StatsQueryEcho(range = "today", timezone = "Asia/Shanghai", tokenMode = "effective")
            ),
            comparison = UsageComparison(
                window = ComparisonWindow(
                    kind = "dayOverDay",
                    timezone = "Asia/Shanghai",
                    bucket = "hour",
                    currentStart = "2026-09-07T00:00:00+08:00",
                    currentEnd = "2026-09-08T00:00:00+08:00",
                    previousStart = "2026-09-06T00:00:00+08:00",
                    previousEnd = "2026-09-07T00:00:00+08:00",
                    alignedThrough = "2026-09-07T10:00:03+08:00"
                ),
                current = ComparisonPeriod(summary, current),
                previous = ComparisonPeriod(summary.copy(inputTokens = 140_000), previous),
                delta = ComparisonDelta(
                    MetricDelta(70_000.0, 50.0, "up"),
                    MetricDelta(3.0, 25.0, "up"),
                    MetricDelta(5.0, 35.0, "up")
                )
            )
        )
    }

    private fun point(bucket: String, tokens: Long, cost: Double) = ComparisonSeriesPoint(bucket, tokens, 3, cost)

    private enum class QuotaKind { Mixed, Error, Details }

    private fun quotaAvailable(kind: QuotaKind): QuotaUiState.Available {
        val fresh = quotaWindow("five-hour", "5 小时窗口", "2026-09-07T09:59:50+08:00", 300)
        val old = quotaWindow("week", "7 天窗口", "2026-09-06T09:00:00+08:00", 10_080)
        val provider = QuotaProviderEnvelope(
            schemaVersion = 1,
            providerId = "openai-codex-local",
            displayName = "Codex",
            scope = QuotaScope.ConsumerSubscription,
            mode = QuotaMode.Automatic,
            capability = QuotaCapability.Stable,
            status = if (kind == QuotaKind.Error) QuotaProviderStatus.Error else QuotaProviderStatus.Ok,
            windows = if (kind == QuotaKind.Details) listOf(fresh) else listOf(fresh, old),
            reasonCode = if (kind == QuotaKind.Error) "upstream_unavailable" else null
        )
        val snapshot = QuotaTransportSnapshot(
            transportVersion = 2,
            epoch = 7,
            revision = 12,
            generatedAt = "2026-09-07T10:00:03+08:00",
            providers = listOf(provider)
        )
        return QuotaUiState.Available(
            snapshot = snapshot,
            showingCachedData = false,
            savedAtEpochMillis = 0,
            evaluatedAtEpochMillis = Instant.parse("2026-09-07T02:00:00Z").toEpochMilli()
        )
    }

    private fun quotaWindow(id: String, label: String, observedAt: String, minutes: Int) = QuotaWindowSnapshot(
        providerId = "openai-codex-local",
        windowId = id,
        windowLabel = label,
        scope = QuotaScope.ConsumerSubscription,
        source = QuotaSource.LocalAuthorized,
        status = QuotaWindowStatus.Ok,
        used = 27.5,
        limit = 100.0,
        remaining = 72.5,
        unit = QuotaUnit.Percent,
        windowMinutes = minutes,
        resetsAt = "2026-09-08T08:00:00+08:00",
        observedAt = observedAt,
        fetchedAt = "2026-09-07T09:59:55+08:00",
        staleAfterSeconds = 60,
        reasonCode = null
    )

    private fun text(value: String): SemanticsNodeInteraction = compose.onNodeWithText(value, useUnmergedTree = true)

    private fun described(value: String): SemanticsNodeInteraction =
        compose.onNodeWithContentDescription(value, useUnmergedTree = true)

    private fun assertConstrainedWidth(widthDp: Int) {
        val container = compose.onNodeWithTag(CONTAINER_TAG, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertEquals(
            "受约束容器等价于${widthDp}dp，不代表设备物理宽度",
            widthDp * compose.density.density,
            container.width,
            .5f
        )
    }

    private fun minTargetPx(): Float = 48f * compose.density.density

    private fun semanticsDumps(): Pair<String, String> =
        compose.onRoot(useUnmergedTree = false).printToString() to compose.onRoot(useUnmergedTree = true).printToString()

    private fun record(
        caseName: String,
        extraBounds: Map<String, Rect> = emptyMap(),
        injectedFontScale: Float,
        constrainedWidthDp: Int? = null
    ) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val output = File(instrumentation.targetContext.filesDir, OUTPUT_DIRECTORY).apply { mkdirs() }
        val container = compose.onNodeWithTag(CONTAINER_TAG, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val bounds = JSONObject().put("container", container.toJson()).apply {
            extraBounds.forEach { (name, rect) -> put(name, rect.toJson()) }
        }
        val (merged, unmerged) = semanticsDumps()
        val data = JSONObject()
            .put("case", caseName)
            .put("fixture", true)
            .put("realPlatformRendering", true)
            .put("deviceModel", "NIO N2301")
            .put("physicalDeviceWidthDp", InstrumentationRegistry.getInstrumentation().targetContext.resources.configuration.screenWidthDp)
            .put("density", compose.density.density)
            .put("injectedFontScale", injectedFontScale)
            .put("containerKind", if (constrainedWidthDp == null) "device-root" else "dp-constrained-test-container")
            .put("constrainedContainerWidthDp", constrainedWidthDp ?: JSONObject.NULL)
            .put("boundsPx", bounds)
            .put("mergedSemantics", merged)
            .put("unmergedSemantics", unmerged)
        File(output, "$caseName.json").writeText(data.toString(2))
        File(output, "$caseName.png").outputStream().use {
            check(compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it))
        }
        instrumentation.sendStatus(0, Bundle().apply { putString("stream", "T10.118c $caseName $bounds\n") })
    }

    private fun Rect.toJson(): JSONArray = JSONArray(listOf(left.toDouble(), top.toDouble(), right.toDouble(), bottom.toDouble()))

    private companion object {
        const val CONTAINER_TAG = "chart-quota-container"
        const val OUTPUT_DIRECTORY = "t10-118c/chart-quota-r2"
    }
}
