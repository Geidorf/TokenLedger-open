package com.jeidorf.tokenledger.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.ui.calendar.V2InsightCalendarCard
import com.jeidorf.tokenledger.mobile.ui.calendar.heatmapMetricPreviewStats
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** 可选热力图指标缺失时，原生日期入口仍应保留并可进入当天复盘。 */
class HeatmapMetricNavigationNativeTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun missingCostKeepsUnavailableCopyAndNavigatesFromTrustedInitialDate() {
        val stats = requireNotNull(heatmapMetricPreviewStats(withCost = false))
        assertTrue("夹具必须覆盖初选日期", stats.heatmap.containsKey(INITIAL_DATE))
        var openedDay: String? = null
        mount(stats) { openedDay = it }

        selectMetric("按费用着色")
        text(COST_UNAVAILABLE).assertIsDisplayed()
        openInitialDay()
        assertEquals(INITIAL_DATE, openedDay)
    }

    @Test
    fun missingRequestsKeepsUnavailableCopyAndNavigatesFromTrustedInitialDate() {
        val stats = requireNotNull(heatmapMetricPreviewStats())
            .copy(heatmapRequests = null)
        assertTrue("夹具必须覆盖初选日期", stats.heatmap.containsKey(INITIAL_DATE))
        var openedDay: String? = null
        mount(stats) { openedDay = it }

        selectMetric("按记录数着色")
        text(REQUESTS_UNAVAILABLE).assertIsDisplayed()
        openInitialDay()
        assertEquals(INITIAL_DATE, openedDay)
    }

    @Test
    fun untrustedCoverageDoesNotInventDateEntry() {
        val stats = requireNotNull(heatmapMetricPreviewStats()).copy(meta = null)
        mount(stats) {}

        text("响应未提供日历元数据").assertIsDisplayed()
        compose.onAllNodes(hasContentDescription(DAY_PICKER) and hasClickAction())
            .assertCountEquals(0)
    }

    private fun mount(stats: StatsData, onOpenDay: (String) -> Unit) {
        compose.setContent {
            val appearance = LedgerAppearance.Light
            val palette = remember(appearance) { v2Palette(appearance) }
            TokenLedgerTheme(appearance) {
                ProvideLedgerPalette(appearance) {
                    Box(Modifier.fillMaxSize().background(palette.background).padding(14.dp)) {
                        V2InsightCalendarCard(
                            palette = palette,
                            stats = stats,
                            onOpenDay = onOpenDay,
                            query = DashboardQuery(
                                range = RangeKey.Month,
                                start = stats.meta?.query?.start,
                                end = stats.meta?.query?.end
                            ),
                            initialSelectedDate = INITIAL_DATE
                        )
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    private fun selectMetric(contentDescription: String) {
        compose.onNode(hasContentDescription(contentDescription) and hasClickAction())
            .performClick()
            .assertIsSelected()
        compose.waitForIdle()
    }

    private fun openInitialDay() {
        compose.onNode(hasContentDescription(DAY_PICKER) and hasClickAction())
            .assertIsDisplayed()
            .assertHasClickAction()
            .performClick()
        compose.onNodeWithText("查看当天")
            .assertIsDisplayed()
            .performClick()
    }

    private fun text(value: String) =
        compose.onNodeWithText(value, useUnmergedTree = true)

    private companion object {
        const val INITIAL_DATE = "2026-07-14"
        const val DAY_PICKER = "选择日期查看当天复盘"
        const val REQUESTS_UNAVAILABLE =
            "云端还没有逐日记录数（需要部署最新的云端函数），先看有效 Token"
        const val COST_UNAVAILABLE =
            "这段时间有日子缺少估价，或云端还没部署逐日费用；不画费用热力，免得把缺失当成 0"
    }
}
