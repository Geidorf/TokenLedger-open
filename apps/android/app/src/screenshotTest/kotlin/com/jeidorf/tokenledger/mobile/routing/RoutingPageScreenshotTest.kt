package com.jeidorf.tokenledger.mobile.routing

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerDashboardPreviewHost
import com.jeidorf.tokenledger.mobile.ui.navigation.MobileDestination
import com.jeidorf.tokenledger.mobile.ui.routing.LocalRoutingFeedOverride
import com.jeidorf.tokenledger.mobile.ui.routing.RoutingPreviewKind
import com.jeidorf.tokenledger.mobile.ui.routing.routingPreviewFeed

// 重构 R4「路由」页：舞台 + 最近调用，以及没有快照、桌面离线、云端未部署三种如实空态。
// 快照用固定夹具注入（LocalRoutingFeedOverride），不发网络请求、不读墙上时钟。

@Composable
private fun RoutingPage(appearance: LedgerAppearance, kind: RoutingPreviewKind) {
    CompositionLocalProvider(LocalRoutingFeedOverride provides routingPreviewFeed(kind)) {
        LedgerDashboardPreviewHost(appearance = appearance, destination = MobileDestination.Routing)
    }
}

@PreviewTest
@Preview(name = "Routing live 390", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun RoutingLiveDarkScreenshot() = RoutingPage(LedgerAppearance.Dark, RoutingPreviewKind.Live)

@PreviewTest
@Preview(name = "Routing live light 390", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true, backgroundColor = 0xFFF4F5F7)
@Composable
fun RoutingLiveLightScreenshot() = RoutingPage(LedgerAppearance.Light, RoutingPreviewKind.Live)

@PreviewTest
@Preview(name = "Routing live 320", device = "spec:width=320dp,height=720dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun RoutingLiveNarrowScreenshot() = RoutingPage(LedgerAppearance.Dark, RoutingPreviewKind.Live)

@PreviewTest
@Preview(name = "Routing no snapshot", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun RoutingNoSnapshotScreenshot() = RoutingPage(LedgerAppearance.Dark, RoutingPreviewKind.NoSnapshot)

@PreviewTest
@Preview(name = "Routing offline light", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true, backgroundColor = 0xFFF4F5F7)
@Composable
fun RoutingOfflineLightScreenshot() = RoutingPage(LedgerAppearance.Light, RoutingPreviewKind.Offline)

@PreviewTest
@Preview(name = "Routing not deployed", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun RoutingNotDeployedScreenshot() = RoutingPage(LedgerAppearance.Dark, RoutingPreviewKind.NotDeployed)
