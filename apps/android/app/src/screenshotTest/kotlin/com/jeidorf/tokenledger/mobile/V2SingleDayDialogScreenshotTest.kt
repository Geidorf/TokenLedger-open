package com.jeidorf.tokenledger.mobile

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.ui.calendar.V2SingleDayDialogPreviewContent

// T10.177 P3-13 收尾 + T10.209 范围 5/6：V2SingleDayDialog 此前截图覆盖为零（弹层从不在预览里真正弹出），
// 320dp 屏下 M3 DatePickerDialog 的 requiredWidth(360.dp) 还会把首末两个日期圆点与"确定"按钮裁掉几像素。
// 这里新开一份夹具专测宽度（320dp）与放大字号（200%），不改其它人的截图测试文件。

@PreviewTest
@Preview(name = "Single day dialog light 390", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun SingleDayDialogLight390Screenshot() {
    V2SingleDayDialogPreviewContent(LedgerAppearance.Light, "2026-05-15")
}

@PreviewTest
@Preview(name = "Single day dialog dark 390", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun SingleDayDialogDark390Screenshot() {
    V2SingleDayDialogPreviewContent(LedgerAppearance.Dark, "2026-05-15")
}

@PreviewTest
@Preview(name = "Single day dialog narrow 320", device = "spec:width=320dp,height=844dp,dpi=160", fontScale = 1f, locale = "zh-rCN")
@Composable
fun SingleDayDialogNarrow320Screenshot() {
    V2SingleDayDialogPreviewContent(LedgerAppearance.Light, "2026-05-15")
}

@PreviewTest
@Preview(name = "Single day dialog large text 200", device = "spec:width=390dp,height=1400dp,dpi=160", fontScale = 2f, locale = "zh-rCN")
@Composable
fun SingleDayDialogLargeTextScreenshot() {
    V2SingleDayDialogPreviewContent(LedgerAppearance.Light, "2026-05-15")
}

@PreviewTest
@Preview(name = "Single day dialog narrow 320 font2", device = "spec:width=320dp,height=1400dp,dpi=160", fontScale = 2f, locale = "zh-rCN")
@Composable
fun SingleDayDialogNarrowLargeTextScreenshot() {
    V2SingleDayDialogPreviewContent(LedgerAppearance.Light, "2026-05-15")
}
