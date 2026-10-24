package com.jeidorf.tokenledger.mobile.widget

import android.content.res.Configuration
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.TokenLedgerTheme

@Composable
private fun RoutingConfigPreview(appearance: LedgerAppearance, theme: WidgetThemeMode) {
    TokenLedgerTheme(appearance) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            RoutingWidgetConfigureScreen(theme, onConfirm = {}, onCancel = {})
        }
    }
}

@PreviewTest
@Preview(
    name = "Routing config dark zh", device = "spec:width=390dp,height=844dp,dpi=160",
    locale = "zh-rCN", uiMode = Configuration.UI_MODE_NIGHT_YES
)
@Composable
fun RoutingConfigDarkChineseScreenshot() =
    RoutingConfigPreview(LedgerAppearance.Dark, WidgetThemeMode.System)

@PreviewTest
@Preview(
    name = "Routing config light en", device = "spec:width=390dp,height=844dp,dpi=160",
    locale = "en", uiMode = Configuration.UI_MODE_NIGHT_NO
)
@Composable
fun RoutingConfigLightEnglishScreenshot() =
    RoutingConfigPreview(LedgerAppearance.Light, WidgetThemeMode.Light)

@PreviewTest
@Preview(
    name = "Routing config font150 zh", device = "spec:width=390dp,height=844dp,dpi=160",
    locale = "zh-rCN", fontScale = 1.5f, uiMode = Configuration.UI_MODE_NIGHT_NO
)
@Composable
fun RoutingConfigLargeTextChineseScreenshot() =
    RoutingConfigPreview(LedgerAppearance.Light, WidgetThemeMode.Dark)

@PreviewTest
@Preview(
    name = "Routing config narrow font200 en", device = "spec:width=320dp,height=900dp,dpi=160",
    locale = "en", fontScale = 2f, uiMode = Configuration.UI_MODE_NIGHT_YES
)
@Composable
fun RoutingConfigNarrowEnglishScreenshot() =
    RoutingConfigPreview(LedgerAppearance.Dark, WidgetThemeMode.Dark)
