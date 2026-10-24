package com.jeidorf.tokenledger.mobile.split

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.ui.split.SplitDimension
import com.jeidorf.tokenledger.mobile.ui.split.SplitMetric
import com.jeidorf.tokenledger.mobile.ui.split.UsageSplitPreviewHost

// 「用量拆分」卡片：Agent 按 Token、设备按费用（深色）、模型按记录数、账号不可用说明，以及 320dp 放大字号。

@PreviewTest
@Preview(name = "Usage split agent tokens light", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun UsageSplitAgentTokensLightScreenshot() {
    UsageSplitPreviewHost(LedgerAppearance.Light, SplitDimension.Agent)
}

@PreviewTest
@Preview(name = "Usage split device cost dark", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun UsageSplitDeviceCostDarkScreenshot() {
    UsageSplitPreviewHost(LedgerAppearance.Dark, SplitDimension.Device, SplitMetric.Cost)
}

@PreviewTest
@Preview(name = "Usage split model requests light", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun UsageSplitModelRequestsLightScreenshot() {
    UsageSplitPreviewHost(LedgerAppearance.Light, SplitDimension.Model, SplitMetric.Requests)
}

@PreviewTest
@Preview(name = "Usage split account unavailable dark", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun UsageSplitAccountUnavailableDarkScreenshot() {
    UsageSplitPreviewHost(LedgerAppearance.Dark, SplitDimension.Account)
}

@PreviewTest
@Preview(name = "Usage split narrow 320 font2", device = "spec:width=320dp,height=1400dp,dpi=160", fontScale = 2f, locale = "zh-rCN")
@Composable
fun UsageSplitNarrowLargeTextScreenshot() {
    UsageSplitPreviewHost(LedgerAppearance.Light, SplitDimension.Agent)
}
