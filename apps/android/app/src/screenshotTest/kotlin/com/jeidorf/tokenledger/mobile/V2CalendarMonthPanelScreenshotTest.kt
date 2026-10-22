package com.jeidorf.tokenledger.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.ui.calendar.V2CalendarMonthPanelContent
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import java.time.LocalDate
import java.time.YearMonth

// R-69：月面板此前在截图门禁里零覆盖——ModalBottomSheet 在 layoutlib 里只渲染出空白。这里直接摆面板内容
// V2CalendarMonthPanelContent（真实界面同一个组合函数），底色取面板的 popover。
// 夹具 2026 年 7 月：1–4 日覆盖外，25–31 日未来，13–19 日为当前查询；可信日 5–24 日里 6、12、20 日为 0，
// 其余 = 日 × 1000，阈值取整条 axis（p25 10K / p50 15K / p75 19K），0–4 级各出现至少一次，逐级核对
// 日期数字取色（P1-2）与月面板共用分级（FI-3）。横屏一张另用语义树核对面板可纵向滚动（P2-5）。

private fun allNodes(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::allNodes)

private fun monthPanelFixtureAxis(): InsightCalendarAxis {
    val start = LocalDate.of(2026, 7, 5)
    val end = LocalDate.of(2026, 7, 24)
    val zeroDays = setOf(6, 12, 20)
    val cells = generateSequence(start) { current -> current.plusDays(1).takeIf { it <= end } }.map { date ->
        InsightCalendarCell(
            date = date,
            tokens = if (date.dayOfMonth in zeroDays) 0L else date.dayOfMonth * 1_000L,
            availability = InsightCalendarCellAvailability.Covered,
            inQueryRange = date.dayOfMonth in 13..19
        )
    }.toList()
    return InsightCalendarAxis(
        cells = cells,
        timezone = "Asia/Shanghai",
        cutoffDate = end,
        selectableStart = start,
        selectableEnd = end
    )
}

@Composable
private fun MonthPanelFixture(appearance: LedgerAppearance, requireScroll: Boolean = false) {
    val root = LocalView.current as ViewRootForTest
    val axis = remember { monthPanelFixtureAxis() }
    val palette = remember(appearance) { v2Palette(appearance) }
    TokenLedgerTheme(appearance) {
        ProvideLedgerPalette(appearance) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(palette.tokens.popover)
                    .onGloballyPositioned {
                        if (!requireScroll) return@onGloballyPositioned
                        // 横屏 844×390：面板宽取 M3 底部面板上限 640dp，日格约 87dp，5 行放不下 390dp，
                        // 必须能纵向滚动，最后一周（27–31 日）才点得到。
                        val nodes = allNodes(root.semanticsOwner.rootSemanticsNode)
                        val range = nodes.firstNotNullOfOrNull { node ->
                            node.config.getOrElseNullable(SemanticsProperties.VerticalScrollAxisRange) { null }
                        }
                        val lastWeek = nodes.flatMap { it.config.getOrElse(SemanticsProperties.ContentDescription) { emptyList() } }
                            .filter { it.startsWith("7月31日") }
                        println("A6_PANEL_SCROLL|max=${range?.maxValue?.invoke()}|$lastWeek")
                        check(range != null && range.maxValue() > 0f) { "月面板在 844×390 下不能纵向滚动：$range" }
                        check(lastWeek == listOf("7月31日，未来")) { lastWeek.toString() }
                    },
                contentAlignment = Alignment.TopCenter
            ) {
                V2CalendarMonthPanelContent(
                    palette,
                    YearMonth.of(2026, 7),
                    axis,
                    onSelectDay = {},
                    modifier = Modifier.widthIn(max = 640.dp)
                )
            }
        }
    }
}

@PreviewTest
@Preview(name = "Calendar month panel light 390", device = "spec:width=390dp,height=600dp,dpi=160")
@Composable
fun CalendarMonthPanelLightScreenshot() { MonthPanelFixture(LedgerAppearance.Light) }

@PreviewTest
@Preview(name = "Calendar month panel dark 390", device = "spec:width=390dp,height=600dp,dpi=160")
@Composable
fun CalendarMonthPanelDarkScreenshot() { MonthPanelFixture(LedgerAppearance.Dark) }

@PreviewTest
@Preview(name = "Calendar month panel landscape 844x390", device = "spec:width=844dp,height=390dp,dpi=160")
@Composable
fun CalendarMonthPanelLandscapeScreenshot() { MonthPanelFixture(LedgerAppearance.Dark, requireScroll = true) }
