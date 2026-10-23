package com.jeidorf.tokenledger.mobile

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest

// T10.209 范围 6：320/390/430dp × 200% 字号 × 明暗已经由 T10118DateCalendarMatrixScreenshot
// （同目录 LedgerDashboardScreenshotTest.kt，别人的文件，不改）覆盖；横屏是那张矩阵没有的维度，
// 新状态开新文件，不追加进别人的测试。

@PreviewTest
@Preview(
    name = "Insights calendar landscape 844x390",
    device = "spec:width=844dp,height=390dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardInsightsCalendarLandscapeScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        destination = MobileDestination.Usage,
        insightPane = InsightPane.Calendar,
        forceLandscape = true
    )
}

@PreviewTest
@Preview(
    // 名字短于深色那张：参考图路径要留在 check:paths 的 230 字符预算内（Windows MAX_PATH）。
    name = "Calendar landscape light 844x390",
    device = "spec:width=844dp,height=390dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFF4F5F7
)
@Composable
fun LedgerDashboardInsightsCalendarLandscapeLightScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Light,
        destination = MobileDestination.Usage,
        insightPane = InsightPane.Calendar,
        forceLandscape = true
    )
}
