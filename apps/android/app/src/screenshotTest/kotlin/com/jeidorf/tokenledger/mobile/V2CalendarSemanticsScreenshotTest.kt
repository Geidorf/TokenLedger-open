package com.jeidorf.tokenledger.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.ui.calendar.V2CalendarDayCell
import com.jeidorf.tokenledger.mobile.ui.calendar.V2CalendarMonthGrid
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import java.time.LocalDate

// T10.209 范围 4：本机不启动模拟器，TalkBack 读屏顺序用 layoutlib 的语义树代替真机走查——
// 同 ChartQuotaTestfixScreenshotTest 的手法：截图测试跑在 layoutlib 上，onGloballyPositioned
// 里把 LocalView 转成 ViewRootForTest 取 rootSemanticsNode，按树的先序遍历（等价读屏顺序）
// 把 ContentDescription 摊平、打印并用 check() 钉死顺序与文案，这段 check 随 android:screenshot
// 一起跑，不是只读一次的旁白。

private fun allNodes(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::allNodes)

private fun descriptions(node: SemanticsNode): List<String> =
    node.config.getOrElse(SemanticsProperties.ContentDescription) { emptyList() } + node.children.flatMap(::descriptions)

private fun texts(node: SemanticsNode): List<String> =
    node.config.getOrElse(SemanticsProperties.Text) { emptyList() }.map { it.text } + node.children.flatMap(::texts)

/**
 * 月节点读屏顺序（C9）：两个月，一月有数据、二月覆盖但全零——分别核对「合计/活跃/最高日」与
 * 「合计 0，活跃 0 天，不编造最高日」两种文案（对应 [monthAccessibilitySummary] 的两条分支），
 * 顺序必须是先一月后二月（日历序，不是任意序）。夹具的格子都在当前查询范围内（inQueryRange 默认 true），
 * 所以两个月都读出「当前查询」段（R-69 P2-3）。
 */
@Composable
private fun CalendarMonthOrderFixture() {
    val root = LocalView.current as ViewRootForTest
    val axis = remember {
        val january = (1..31).map { day ->
            InsightCalendarCell(LocalDate.of(2026, 1, day), day.toLong(), InsightCalendarCellAvailability.Covered)
        }
        val february = (1..28).map { day ->
            InsightCalendarCell(LocalDate.of(2026, 2, day), 0L, InsightCalendarCellAvailability.Covered)
        }
        InsightCalendarAxis(
            cells = january + february,
            timezone = "Asia/Shanghai",
            cutoffDate = LocalDate.of(2026, 2, 28),
            selectableStart = LocalDate.of(2026, 1, 1),
            selectableEnd = LocalDate.of(2026, 2, 28)
        )
    }
    val palette = remember { v2Palette(LedgerAppearance.Light) }
    TokenLedgerTheme(LedgerAppearance.Light) {
        ProvideLedgerPalette(LedgerAppearance.Light) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(palette.background)
                    .onGloballyPositioned {
                        val merged = root.semanticsOwner.rootSemanticsNode
                        val all = descriptions(merged)
                        val monthNodes = all.filter { it.contains("双击选择日期") }
                        println("A6_MONTH_ORDER|$monthNodes")
                        println("A6_MONTH_TEXTS|${texts(merged)}")
                        check(
                            monthNodes == listOf(
                                "1月：合计 496，活跃 31 天，最高 31 日；当前查询 1 日至 31 日。双击选择日期",
                                "2月：合计 0，活跃 0 天；当前查询 1 日至 28 日。双击选择日期"
                            )
                        ) { monthNodes.toString() }
                    }
            ) {
                V2CalendarMonthGrid(palette, axis) { }
            }
        }
    }
}

/**
 * 日节点读屏顺序：未来 / 未查询 / 已知为零 / 具体数值——四选一，四态同排一次性核对
 * （对应 [dayAccessibilityLabel] 的四条分支），顺序是从左到右的摆放顺序。
 */
@Composable
private fun CalendarDayStatesFixture() {
    val root = LocalView.current as ViewRootForTest
    val thresholds = remember { heatLevelThresholds(listOf(5_000L)) }
    val future = InsightCalendarCell(LocalDate.of(2026, 5, 20), 0L, InsightCalendarCellAvailability.Future)
    val outside = InsightCalendarCell(LocalDate.of(2025, 12, 31), 0L, InsightCalendarCellAvailability.OutsideHeatmapCoverage)
    val zero = InsightCalendarCell(LocalDate.of(2026, 5, 10), 0L, InsightCalendarCellAvailability.Covered)
    val value = InsightCalendarCell(LocalDate.of(2026, 5, 15), 5_000L, InsightCalendarCellAvailability.Covered)
    val palette = remember { v2Palette(LedgerAppearance.Light) }
    TokenLedgerTheme(LedgerAppearance.Light) {
        ProvideLedgerPalette(LedgerAppearance.Light) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(palette.background)
                    .onGloballyPositioned {
                        val merged = root.semanticsOwner.rootSemanticsNode
                        val all = descriptions(merged)
                        println("A6_DAY_ORDER|$all")
                        check(
                            all == listOf(
                                "5月20日，未来",
                                "12月31日，未查询",
                                "5月10日，无消耗",
                                "5月15日，${v2FormatTokens(5_000L)}"
                            )
                        ) { all.toString() }
                    }
            ) {
                Row(Modifier.fillMaxWidth()) {
                    listOf(future, outside, zero, value).forEach { cell ->
                        val day = MonthPanelDay(cell, cell.knownTokens?.let { heatLevel(it, thresholds) })
                        V2CalendarDayCell(Modifier.weight(1f), palette, day) { }
                    }
                }
            }
        }
    }
}

@PreviewTest
@Preview(name = "Calendar month order", device = "spec:width=390dp,height=600dp,dpi=160")
@Composable
fun CalendarMonthOrderScreenshot() { CalendarMonthOrderFixture() }

@PreviewTest
@Preview(name = "Calendar day states order", device = "spec:width=390dp,height=200dp,dpi=160")
@Composable
fun CalendarDayStatesOrderScreenshot() { CalendarDayStatesFixture() }
