package com.jeidorf.tokenledger.mobile.rhythm

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerDashboardPreviewHost
import com.jeidorf.tokenledger.mobile.ui.dimensions.DimensionsFeed
import com.jeidorf.tokenledger.mobile.ui.dimensions.LocalDimensionsFeedOverride
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane
import com.jeidorf.tokenledger.mobile.ui.rhythm.LocalRhythmFeedOverride
import com.jeidorf.tokenledger.mobile.ui.rhythm.RhythmPreviewKind
import com.jeidorf.tokenledger.mobile.ui.rhythm.rhythmPreviewFeed

// 「用量 › 会话」子页（云端活动节律）：浅色、深色、云端未部署，以及 320dp 放大字号。

@Composable
private fun RhythmPage(appearance: LedgerAppearance, kind: RhythmPreviewKind = RhythmPreviewKind.Live) {
    CompositionLocalProvider(
        LocalRhythmFeedOverride provides rhythmPreviewFeed(kind),
        LocalDimensionsFeedOverride provides DimensionsFeed(signedIn = false)
    ) {
        LedgerDashboardPreviewHost(appearance, insightPane = InsightPane.Sessions)
    }
}

@PreviewTest
@Preview(name = "Rhythm light 390", device = "spec:width=390dp,height=1400dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun RhythmLight390Screenshot() {
    RhythmPage(LedgerAppearance.Light)
}

@PreviewTest
@Preview(name = "Rhythm dark 390", device = "spec:width=390dp,height=1400dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun RhythmDark390Screenshot() {
    RhythmPage(LedgerAppearance.Dark)
}

@PreviewTest
@Preview(name = "Rhythm not deployed", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun RhythmNotDeployedScreenshot() {
    RhythmPage(LedgerAppearance.Light, RhythmPreviewKind.NotDeployed)
}

@PreviewTest
@Preview(name = "Rhythm narrow 320 font2", device = "spec:width=320dp,height=2000dp,dpi=160", fontScale = 2f, locale = "zh-rCN")
@Composable
fun RhythmNarrowLargeTextScreenshot() {
    RhythmPage(LedgerAppearance.Light)
}
