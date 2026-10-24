package com.jeidorf.tokenledger.mobile.adaptive

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerDashboardPreviewHost
import com.jeidorf.tokenledger.mobile.ui.me.V2MePage
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane
import com.jeidorf.tokenledger.mobile.ui.navigation.MobileDestination
import com.jeidorf.tokenledger.mobile.ui.routing.LocalRoutingFeedOverride
import com.jeidorf.tokenledger.mobile.ui.routing.RoutingPreviewKind
import com.jeidorf.tokenledger.mobile.ui.routing.routingPreviewFeed

// 平板、折叠屏与横屏：四个一级分区和「我的」子页在宽窗口下的版式。
// 尺寸取常见窗口：平板横屏 1280×800、平板竖屏 800×1280、折叠屏内屏 673×841、手机横屏 844×390。

private const val TABLET_LANDSCAPE = "spec:width=1280dp,height=800dp,dpi=160"
private const val TABLET_PORTRAIT = "spec:width=800dp,height=1280dp,dpi=160"
private const val FOLDABLE_INNER = "spec:width=673dp,height=841dp,dpi=160"
private const val PHONE_LANDSCAPE = "spec:width=844dp,height=390dp,dpi=160"

@Composable
private fun AdaptivePage(
    appearance: LedgerAppearance,
    destination: MobileDestination = MobileDestination.Usage,
    insightPane: InsightPane = InsightPane.Overview,
    mePage: V2MePage = V2MePage.Root
) {
    CompositionLocalProvider(LocalRoutingFeedOverride provides routingPreviewFeed(RoutingPreviewKind.Live)) {
        LedgerDashboardPreviewHost(
            appearance = appearance,
            destination = destination,
            insightPane = insightPane,
            mePage = mePage
        )
    }
}

@PreviewTest
@Preview(name = "Tablet landscape overview dark", device = TABLET_LANDSCAPE, uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun TabletLandscapeOverviewDarkScreenshot() = AdaptivePage(LedgerAppearance.Dark)

@PreviewTest
@Preview(name = "Tablet landscape overview light", device = TABLET_LANDSCAPE, uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true, backgroundColor = 0xFFF4F5F7)
@Composable
fun TabletLandscapeOverviewLightScreenshot() = AdaptivePage(LedgerAppearance.Light)

@PreviewTest
@Preview(name = "Tablet landscape trend light", device = TABLET_LANDSCAPE, uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true, backgroundColor = 0xFFF4F5F7)
@Composable
fun TabletLandscapeTrendLightScreenshot() = AdaptivePage(LedgerAppearance.Light, insightPane = InsightPane.Trend)

@PreviewTest
@Preview(name = "Tablet landscape requests dark", device = TABLET_LANDSCAPE, uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun TabletLandscapeRequestsDarkScreenshot() = AdaptivePage(LedgerAppearance.Dark, insightPane = InsightPane.Details)

@PreviewTest
@Preview(name = "Tablet landscape routing dark", device = TABLET_LANDSCAPE, uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun TabletLandscapeRoutingDarkScreenshot() = AdaptivePage(LedgerAppearance.Dark, MobileDestination.Routing)

@PreviewTest
@Preview(name = "Tablet landscape quota light", device = TABLET_LANDSCAPE, uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true, backgroundColor = 0xFFF4F5F7)
@Composable
fun TabletLandscapeQuotaLightScreenshot() = AdaptivePage(LedgerAppearance.Light, MobileDestination.Quota)

@PreviewTest
@Preview(name = "Tablet landscape me dark", device = TABLET_LANDSCAPE, uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun TabletLandscapeMeDarkScreenshot() = AdaptivePage(LedgerAppearance.Dark, MobileDestination.Me)

@PreviewTest
@Preview(name = "Tablet landscape me standby light", device = TABLET_LANDSCAPE, uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true, backgroundColor = 0xFFF4F5F7)
@Composable
fun TabletLandscapeMeStandbyLightScreenshot() = AdaptivePage(LedgerAppearance.Light, MobileDestination.Me, mePage = V2MePage.Standby)

@PreviewTest
@Preview(name = "Tablet portrait overview light", device = TABLET_PORTRAIT, uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true, backgroundColor = 0xFFF4F5F7)
@Composable
fun TabletPortraitOverviewLightScreenshot() = AdaptivePage(LedgerAppearance.Light)

@PreviewTest
@Preview(name = "Foldable inner overview dark", device = FOLDABLE_INNER, uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun FoldableInnerOverviewDarkScreenshot() = AdaptivePage(LedgerAppearance.Dark)

@PreviewTest
@Preview(name = "Phone landscape overview dark", device = PHONE_LANDSCAPE, uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun PhoneLandscapeOverviewDarkScreenshot() = AdaptivePage(LedgerAppearance.Dark)

@PreviewTest
@Preview(name = "Phone landscape routing light", device = PHONE_LANDSCAPE, uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true, backgroundColor = 0xFFF4F5F7)
@Composable
fun PhoneLandscapeRoutingLightScreenshot() = AdaptivePage(LedgerAppearance.Light, MobileDestination.Routing)
