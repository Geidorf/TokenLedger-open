package com.jeidorf.tokenledger.mobile

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/**
 * 直接挂载生产趋势组件，验证图表点选后两个下钻动作都保留原始时段。
 *
 * 测试只使用内存 fixture 和回调探针，不读取或修改账号、PrivacyStore 与设备数据。
 */
class TrendDrillNativeTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun fontScaleOneKeepsLeftMiddleAndRightBucketForBothActions() {
        verifyTrendDrill(fontScale = 1f)
    }

    @Test
    fun fontScaleTwoKeepsLeftMiddleAndRightBucketForBothActions() {
        verifyTrendDrill(fontScale = 2f)
    }

    private fun verifyTrendDrill(fontScale: Float) {
        val callbacks = mutableListOf<Pair<String, InsightPane>>()
        mount(fontScale) { bucket, pane -> callbacks += bucket to pane }

        val plotBounds = compose.onNode(
            hasContentDescription("当前峰值时段", substring = true),
            useUnmergedTree = true
        ).assertIsDisplayed().fetchSemanticsNode().boundsInRoot

        BUCKETS.forEachIndexed { index, expectedBucket ->
            selectBucket(plotBounds, index, fontScale)
            callbacks.clear()
            tapAction("当天来源")
            assertEquals(
                "fontScale=$fontScale、index=$index 的来源下钻必须只回调一次原始桶",
                listOf(expectedBucket to InsightPane.Sources),
                callbacks.toList()
            )

            selectBucket(plotBounds, index, fontScale)
            callbacks.clear()
            tapAction("当天明细")
            assertEquals(
                "fontScale=$fontScale、index=$index 的明细下钻必须只回调一次原始桶",
                listOf(expectedBucket to InsightPane.Details),
                callbacks.toList()
            )
        }
    }

    private fun mount(fontScale: Float, onOpenBucket: (String, InsightPane) -> Unit) {
        compose.setContent {
            val systemDensity = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(systemDensity.density, fontScale)) {
                Box(Modifier.width(TEST_WIDTH_DP.dp).height(TEST_HEIGHT_DP.dp)) {
                    V2ChartQuotaPreviewContent(
                        surface = ChartQuotaPreviewSurface.Trend,
                        stats = trendStats(),
                        metric = ReportMetricMode.Tokens,
                        onOpenTrendBucket = onOpenBucket
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    private fun selectBucket(plotBounds: Rect, index: Int, fontScale: Float) {
        val density = compose.density.density
        val externalAnchors = fontScale >= 1.5f || deviceWidthDp() < 360
        val numericAxisWidthDp = if (externalAnchors) 88f else 48f * fontScale
        val graphLeft = plotBounds.left + 8f * density
        val graphRight = plotBounds.right - (numericAxisWidthDp + 12f) * density
        val fraction = index.toFloat() / (BUCKETS.size - 1).toFloat()
        val pointInRoot = Offset(
            x = graphLeft + (graphRight - graphLeft) * fraction,
            y = plotBounds.center.y
        )

        tapRoot(pointInRoot)
        compose.onNodeWithText("当天来源").assertIsDisplayed()
        compose.onNodeWithText("当天明细").assertIsDisplayed()
    }

    private fun tapAction(label: String) {
        val bounds = compose.onNodeWithText(label).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        tapRoot(bounds.center)
    }

    private fun tapRoot(pointInRoot: Offset) {
        val root = compose.onRoot(useUnmergedTree = true)
        val rootBounds = root.fetchSemanticsNode().boundsInRoot
        root.performTouchInput {
            click(Offset(pointInRoot.x - rootBounds.left, pointInRoot.y - rootBounds.top))
        }
        compose.waitForIdle()
    }

    private fun deviceWidthDp(): Int =
        InstrumentationRegistry.getInstrumentation().targetContext.resources.configuration.screenWidthDp

    private fun trendStats(): StatsData {
        val current = listOf(
            point(BUCKETS[0], 120_000, 1.2),
            point(BUCKETS[1], 240_000, 2.4),
            point(BUCKETS[2], 360_000, 3.6)
        )
        val previous = listOf(
            point("2026-09-06 01:00:00", 90_000, .9),
            point("2026-09-06 02:00:00", 180_000, 1.8),
            point("2026-09-06 03:00:00", 270_000, 2.7)
        )
        val summary = Summary(
            totalTokens = 720_000,
            inputTokens = 720_000,
            outputTokens = 0,
            cachedTokens = 0,
            totalCost = 7.2,
            totalRequests = 9
        )
        return StatsData(
            summary = summary,
            tools = emptyMap(),
            models = emptyMap(),
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
                previous = ComparisonPeriod(summary.copy(totalTokens = 540_000, inputTokens = 540_000), previous),
                delta = ComparisonDelta(
                    MetricDelta(180_000.0, 33.33, "up"),
                    MetricDelta(0.0, 0.0, "flat"),
                    MetricDelta(1.8, 33.33, "up")
                )
            )
        )
    }

    private fun point(bucket: String, tokens: Long, cost: Double) =
        ComparisonSeriesPoint(bucket, tokens, 3, cost)

    private companion object {
        const val TEST_WIDTH_DP = 320
        const val TEST_HEIGHT_DP = 1800

        val BUCKETS = listOf(
            "2026-09-07 01:00:00",
            "2026-09-07 02:00:00",
            "2026-09-07 03:00:00"
        )
    }
}
