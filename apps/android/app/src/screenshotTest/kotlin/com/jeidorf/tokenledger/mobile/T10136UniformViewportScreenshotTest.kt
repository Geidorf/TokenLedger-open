package com.jeidorf.tokenledger.mobile

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest

// 同一设备、字号、主题与数据夹具；横向比较不缩放任何一张图。
@PreviewTest
@Preview(name = "Uniform overview 390x844", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1f, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun UniformOverviewScreenshot() {
    LedgerDashboardPreviewHost(LedgerAppearance.Dark)
}

@PreviewTest
@Preview(name = "Uniform trend 390x844", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1f, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun UniformTrendScreenshot() {
    LedgerDashboardPreviewHost(LedgerAppearance.Dark, destination = MobileDestination.Insights, insightPane = InsightPane.Trend)
}

@PreviewTest
@Preview(name = "Uniform sources 390x844", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1f, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun UniformSourcesScreenshot() {
    LedgerDashboardPreviewHost(LedgerAppearance.Dark, destination = MobileDestination.Insights, insightPane = InsightPane.Sources)
}

@PreviewTest
@Preview(name = "Uniform calendar 390x844", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1f, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun UniformCalendarScreenshot() {
    LedgerDashboardPreviewHost(LedgerAppearance.Dark, destination = MobileDestination.Insights, insightPane = InsightPane.Calendar)
}
