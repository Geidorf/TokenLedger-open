package com.jeidorf.tokenledger.mobile.calendar

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.HeatmapMetric
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.ui.calendar.V2InsightCalendarPreviewContent
import com.jeidorf.tokenledger.mobile.ui.calendar.heatmapMetricPreviewStats

// 覆盖记录数与费用着色、费用整项缺失，以及窄屏大字状态。

@PreviewTest
@Preview(
    name = "Calendar metric requests dark",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun CalendarMetricRequestsDarkScreenshot() {
    val stats = heatmapMetricPreviewStats() ?: return
    V2InsightCalendarPreviewContent(LedgerAppearance.Dark, stats, "2026-07-14", HeatmapMetric.Requests)
}

@PreviewTest
@Preview(
    name = "Calendar metric cost light",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFF4F5F7
)
@Composable
fun CalendarMetricCostLightScreenshot() {
    val stats = heatmapMetricPreviewStats() ?: return
    V2InsightCalendarPreviewContent(LedgerAppearance.Light, stats, "2026-07-14", HeatmapMetric.Cost)
}

@PreviewTest
@Preview(
    name = "Calendar metric cost missing",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun CalendarMetricCostMissingScreenshot() {
    val stats = heatmapMetricPreviewStats(withCost = false) ?: return
    V2InsightCalendarPreviewContent(LedgerAppearance.Dark, stats, "2026-07-14", HeatmapMetric.Cost)
}

@PreviewTest
@Preview(
    name = "Calendar metric 320 font2",
    device = "spec:width=320dp,height=900dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFF4F5F7,
    fontScale = 2f
)
@Composable
fun CalendarMetricNarrowLargeTextScreenshot() {
    val stats = heatmapMetricPreviewStats() ?: return
    V2InsightCalendarPreviewContent(LedgerAppearance.Light, stats, "2026-07-14", HeatmapMetric.Requests)
}
