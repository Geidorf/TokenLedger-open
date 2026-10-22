package com.jeidorf.tokenledger.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.ui.calendar.V2CalendarMonthGrid
import com.jeidorf.tokenledger.mobile.ui.calendar.V2CalendarMonthPanelContent
import com.jeidorf.tokenledger.mobile.ui.charts.V2HeatmapChart
import com.jeidorf.tokenledger.mobile.ui.charts.V2HeatmapScaleLegend
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import java.time.LocalDate
import java.time.YearMonth

/** TOKE-14：同屏核对年度月格、月面板、图例与不足 12 周时的前置补位格。 */
@Composable
private fun Toke14HeatmapFixture(appearance: LedgerAppearance) {
    val palette = remember(appearance) { v2Palette(appearance) }
    val axis = remember {
        val start = LocalDate.of(2026, 7, 5)
        val end = LocalDate.of(2026, 7, 24)
        InsightCalendarAxis(
            cells = generateSequence(start) { it.plusDays(1).takeIf { next -> next <= end } }
                .map { date ->
                    InsightCalendarCell(
                        date = date,
                        tokens = if (date.dayOfMonth in setOf(6, 12, 20)) 0L else date.dayOfMonth * 1_000L,
                        availability = InsightCalendarCellAvailability.Covered,
                        inQueryRange = false
                    )
                }.toList(),
            timezone = "Asia/Shanghai",
            cutoffDate = end,
            selectableStart = start,
            selectableEnd = end
        )
    }
    val shortHeatmap = remember {
        (5..11).associate { day -> "2026-07-${day.toString().padStart(2, '0')}" to
            if (day == 5 || day == 7) 0L else day * 1_000L }
    }
    TokenLedgerTheme(appearance) {
        ProvideLedgerPalette(appearance) {
            Column(
                Modifier.fillMaxSize().background(palette.background).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Text("未知斜线 / 已知零实心", color = palette.text)
                Box(Modifier.fillMaxWidth().background(palette.surface).padding(10.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        V2HeatmapScaleLegend(palette)
                        Text("年度月格 · 7月1–4日未查询、6日为零", color = palette.text)
                        V2CalendarMonthGrid(palette, axis) { }
                    }
                }
                Text("月面板 · 1–4日未知 / 6、12、20日为零", color = palette.text)
                Box(Modifier.fillMaxWidth().height(300.dp).background(palette.tokens.popover)) {
                    V2CalendarMonthPanelContent(palette, YearMonth.of(2026, 7), axis, onSelectDay = {})
                }
                Text("近12周 · 前置11周未查询 / 第12周有真零", color = palette.text)
                Box(Modifier.fillMaxWidth().background(palette.surface).padding(8.dp)) {
                    V2HeatmapChart(palette, shortHeatmap, Modifier.fillMaxWidth().height(114.dp), weeks = 12, interactive = false)
                }
            }
        }
    }
}

@PreviewTest
@Preview(name = "TOKE14 Light 390", device = "spec:width=390dp,height=844dp,dpi=160")
@Composable
fun Toke14Light390Screenshot() { Toke14HeatmapFixture(LedgerAppearance.Light) }

@PreviewTest
@Preview(name = "TOKE14 Dark 390", device = "spec:width=390dp,height=844dp,dpi=160")
@Composable
fun Toke14Dark390Screenshot() { Toke14HeatmapFixture(LedgerAppearance.Dark) }

@PreviewTest
@Preview(name = "TOKE14 EInk 390", device = "spec:width=390dp,height=844dp,dpi=160")
@Composable
fun Toke14EInk390Screenshot() { Toke14HeatmapFixture(LedgerAppearance.EInk) }

@PreviewTest
@Preview(name = "TOKE14 Light 320", device = "spec:width=320dp,height=844dp,dpi=160")
@Composable
fun Toke14Light320Screenshot() { Toke14HeatmapFixture(LedgerAppearance.Light) }

@PreviewTest
@Preview(name = "TOKE14 EInk 320", device = "spec:width=320dp,height=844dp,dpi=160")
@Composable
fun Toke14EInk320Screenshot() { Toke14HeatmapFixture(LedgerAppearance.EInk) }
