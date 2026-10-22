package com.jeidorf.tokenledger.mobile.widget

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest

@PreviewTest
@Preview(
    name = "Ledger Rings Dark 430x720",
    device = "spec:width=430dp,height=720dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerRingsDarkScreenshot() {
    LedgerRingsDarkPreview()
}

@PreviewTest
@Preview(
    name = "Ledger Rings Light 430x720",
    device = "spec:width=430dp,height=720dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFF4F4F7
)
@Composable
fun LedgerRingsLightScreenshot() {
    LedgerRingsLightPreview()
}

@PreviewTest
@Preview(
    name = "Ledger Rings States 430x220",
    device = "spec:width=430dp,height=220dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerRingsStatesScreenshot() {
    LedgerRingsStatesPreview()
}

@PreviewTest
@Preview(
    name = "Single Usage Picker 320x80",
    device = "spec:width=320dp,height=80dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = false
)
@Composable
fun SingleUsagePickerScreenshot() {
    SingleUsagePickerPreview()
}

@PreviewTest
@Preview(
    name = "Single Usage 200 percent 320x80",
    device = "spec:width=320dp,height=80dp,dpi=160",
    fontScale = 2f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = false
)
@Composable
fun SingleUsageLargeTextScreenshot() {
    SingleUsageLargeTextPreview()
}

@PreviewTest
@Preview(
    name = "Login 200 percent 320x80",
    device = "spec:width=320dp,height=80dp,dpi=160",
    fontScale = 2f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = false
)
@Composable
fun LoginLargeTextScreenshot() {
    LoginLargeTextPreview()
}

@PreviewTest
@Preview(
    name = "Empty 200 percent 320x80",
    device = "spec:width=320dp,height=80dp,dpi=160",
    fontScale = 2f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = false
)
@Composable
fun EmptyLargeTextScreenshot() {
    EmptyLargeTextPreview()
}

@PreviewTest
@Preview(
    name = "Ring Picker 200x200",
    device = "spec:width=200dp,height=200dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = false
)
@Composable
fun RingPickerScreenshot() {
    RingPickerPreview()
}

@PreviewTest
@Preview(
    name = "Combo Picker 400x200",
    device = "spec:width=400dp,height=200dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = false
)
@Composable
fun ComboPickerScreenshot() {
    ComboPickerPreview()
}
