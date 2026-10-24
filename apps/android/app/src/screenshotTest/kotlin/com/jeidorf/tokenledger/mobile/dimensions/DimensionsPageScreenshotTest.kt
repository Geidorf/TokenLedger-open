package com.jeidorf.tokenledger.mobile.dimensions

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerDashboardPreviewHost
import com.jeidorf.tokenledger.mobile.ui.dimensions.DimensionsPreviewKind
import com.jeidorf.tokenledger.mobile.ui.dimensions.LocalDimensionsFeedOverride
import com.jeidorf.tokenledger.mobile.ui.dimensions.dimensionsPreviewFeed
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane
import com.jeidorf.tokenledger.mobile.ui.rhythm.LocalRhythmFeedOverride
import com.jeidorf.tokenledger.mobile.ui.rhythm.RhythmFeed

// 「用量 › 会话」子页里的会话排行与平均 Context 构成：有数（明暗）、桌面未开启、云端未部署、窄屏放大字号。
// 节律部分固定为未登录空态，只看新加的两张卡。

@Composable
private fun DimensionsPage(appearance: LedgerAppearance, kind: DimensionsPreviewKind) {
    CompositionLocalProvider(
        LocalRhythmFeedOverride provides RhythmFeed(signedIn = false),
        LocalDimensionsFeedOverride provides dimensionsPreviewFeed(kind)
    ) {
        LedgerDashboardPreviewHost(appearance, insightPane = InsightPane.Sessions)
    }
}

@PreviewTest
@Preview(name = "Cloud sessions light", device = "spec:width=390dp,height=1500dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun CloudSessionsLightScreenshot() {
    DimensionsPage(LedgerAppearance.Light, DimensionsPreviewKind.Live)
}

@PreviewTest
@Preview(name = "Cloud sessions dark", device = "spec:width=390dp,height=1500dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun CloudSessionsDarkScreenshot() {
    DimensionsPage(LedgerAppearance.Dark, DimensionsPreviewKind.Live)
}

@PreviewTest
@Preview(name = "Cloud sessions desktop off", device = "spec:width=390dp,height=1000dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun CloudSessionsDesktopOffScreenshot() {
    DimensionsPage(LedgerAppearance.Light, DimensionsPreviewKind.DesktopOff)
}

@PreviewTest
@Preview(name = "Cloud sessions not deployed", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun CloudSessionsNotDeployedScreenshot() {
    DimensionsPage(LedgerAppearance.Light, DimensionsPreviewKind.NotDeployed)
}

@PreviewTest
@Preview(name = "Cloud sessions 320 font2", device = "spec:width=320dp,height=3000dp,dpi=160", fontScale = 2f, locale = "zh-rCN")
@Composable
fun CloudSessionsNarrowLargeTextScreenshot() {
    DimensionsPage(LedgerAppearance.Light, DimensionsPreviewKind.Live)
}
