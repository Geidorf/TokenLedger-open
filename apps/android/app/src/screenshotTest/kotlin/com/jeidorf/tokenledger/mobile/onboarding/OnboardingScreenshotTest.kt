package com.jeidorf.tokenledger.mobile.onboarding

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerDashboardPreviewHost
import com.jeidorf.tokenledger.mobile.ProvideLedgerPalette
import com.jeidorf.tokenledger.mobile.TokenLedgerTheme
import com.jeidorf.tokenledger.mobile.ledgerFreshAccountSnapshotFixture
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import com.jeidorf.tokenledger.mobile.ui.me.V2MeWallpaperState
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane
import com.jeidorf.tokenledger.mobile.ui.navigation.MobileDestination
import com.jeidorf.tokenledger.mobile.ui.onboarding.LocalV2DeviceFactsOverride
import com.jeidorf.tokenledger.mobile.ui.onboarding.V2DeviceFacts
import com.jeidorf.tokenledger.mobile.ui.onboarding.V2LoginIntro

// 首次启动引导与新账户空状态：已登录、桌面还没同步过任何数据的那一帧。
// 系统事实（壁纸、小组件）用 LocalV2DeviceFactsOverride 钉死，不读真机状态。
// 新账户的用量页顶栏不带分享：只有接入说明，没有可分享的统计。

private val FRESH_DEVICE = V2DeviceFacts(
    wallpaper = V2MeWallpaperState.Available,
    placedWidgets = 0,
    canPinWidget = true
)

@Composable
private fun FreshAccount(
    appearance: LedgerAppearance,
    destination: MobileDestination = MobileDestination.Usage,
    insightPane: InsightPane = InsightPane.Overview,
    guideVisible: Boolean = false,
    device: V2DeviceFacts = FRESH_DEVICE
) {
    CompositionLocalProvider(LocalV2DeviceFactsOverride provides device) {
        LedgerDashboardPreviewHost(
            appearance = appearance,
            state = ledgerFreshAccountSnapshotFixture(),
            destination = destination,
            insightPane = insightPane,
            guideVisible = guideVisible
        )
    }
}

@PreviewTest
@Preview(name = "First run guide 390", device = "spec:width=390dp,height=900dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun FirstRunGuideDarkScreenshot() = FreshAccount(LedgerAppearance.Dark, guideVisible = true)

@PreviewTest
@Preview(name = "First run guide light 390", device = "spec:width=390dp,height=900dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true, backgroundColor = 0xFFF4F5F7)
@Composable
fun FirstRunGuideLightScreenshot() = FreshAccount(LedgerAppearance.Light, guideVisible = true)

@PreviewTest
@Preview(name = "First run guide progressed e-ink 390", device = "spec:width=390dp,height=900dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true, backgroundColor = 0xFFFFFFFF)
@Composable
fun FirstRunGuideProgressedEInkScreenshot() = FreshAccount(
    LedgerAppearance.EInk,
    guideVisible = true,
    device = FRESH_DEVICE.copy(wallpaper = V2MeWallpaperState.Active, placedWidgets = 2)
)

@PreviewTest
@Preview(name = "First run guide large text 390", device = "spec:width=390dp,height=1600dp,dpi=160", fontScale = 2.0f, uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun FirstRunGuideFontScale200Screenshot() = FreshAccount(LedgerAppearance.Dark, guideVisible = true)

@PreviewTest
@Preview(name = "Fresh account overview 390", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun FreshAccountOverviewDarkScreenshot() = FreshAccount(LedgerAppearance.Dark)

@PreviewTest
@Preview(name = "Fresh account trend light 390", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true, backgroundColor = 0xFFF4F5F7)
@Composable
fun FreshAccountTrendLightScreenshot() = FreshAccount(LedgerAppearance.Light, insightPane = InsightPane.Trend)

@PreviewTest
@Preview(name = "Fresh account quota 390", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun FreshAccountQuotaDarkScreenshot() = FreshAccount(LedgerAppearance.Dark, destination = MobileDestination.Quota)

@PreviewTest
@Preview(name = "Fresh account me light 390", device = "spec:width=390dp,height=1100dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true, backgroundColor = 0xFFF4F5F7)
@Composable
fun FreshAccountMeLightScreenshot() = FreshAccount(LedgerAppearance.Light, destination = MobileDestination.Me)

@PreviewTest
@Preview(name = "Login intro 390", device = "spec:width=390dp,height=360dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun LoginIntroDarkScreenshot() {
    TokenLedgerTheme(LedgerAppearance.Dark) {
        ProvideLedgerPalette(LedgerAppearance.Dark) {
            val palette = v2Palette(LedgerAppearance.Dark)
            Box(Modifier.fillMaxSize().background(palette.background).padding(24.dp)) {
                V2Card(palette) { V2LoginIntro(palette) }
            }
        }
    }
}
