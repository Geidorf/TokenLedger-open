package com.jeidorf.tokenledger.mobile.ui.calendar

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.HeatLevelThresholds
import com.jeidorf.tokenledger.mobile.InsightCalendarAxis
import com.jeidorf.tokenledger.mobile.InsightCalendarCell
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.heatLevel
import com.jeidorf.tokenledger.mobile.heatLevelThresholds
import com.jeidorf.tokenledger.mobile.insightCalendarMonths
import com.jeidorf.tokenledger.mobile.knownNonZeroTokens
import com.jeidorf.tokenledger.mobile.monthAccessibilitySummary
import com.jeidorf.tokenledger.mobile.ui.charts.drawUnknownHatchCell
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSize
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import java.time.YearMonth

/** 年度小格网格的一格宽/高与列间隙：固定值，不再按容器宽度拉伸（T10.173 §3.6）。 */
private val MONTH_GRID_COLUMNS = 7
private val MONTH_CELL_CORNER = 2.dp
/** 未来点直径 2.4dp（§3.8）；查询范围描边的内缩留白，确保描边完全落在卡片底色上而不是叠在色阶格上
 * （T10.209 复算：文字色直接叠在 4 级实心格上，深色主题只有 2.415:1，见任务日志的对比度小节）。 */
private val FUTURE_DOT_RADIUS = 1.2.dp
private val QUERY_HALO_MARGIN = 1.5.dp

/** 年历在窄屏与大字体下的列数；抽成纯函数锁住 320/390/430dp 与 150%/200% 边界。 */
internal fun calendarMonthsPerRow(screenWidthDp: Int, fontScale: Float): Int = when {
    fontScale >= 2f -> 1
    fontScale >= 1.5f || screenWidthDp < 360 -> 2
    else -> 3
}

@Composable
internal fun V2CalendarMonthGrid(
    palette: MobileV2Palette,
    axis: InsightCalendarAxis,
    focusMonth: YearMonth? = null,
    onFocusRestored: () -> Unit = {},
    onOpenMonth: (YearMonth) -> Unit
) {
    val months = remember(axis) { insightCalendarMonths(axis) }
    val thresholds = remember(axis) { heatLevelThresholds(knownNonZeroTokens(axis.cells)) }
    val fontScale = LocalDensity.current.fontScale
    // 年视图 < 360dp 时改 2 列（T10.173 §7.4 收尾句）；字体放大时进一步收窄，避免行过宽。
    // 注意：这里的"列"是一行摆几个月历小卡片，和 V2MiniMonthCanvas 内部固定 7 列（周一至周日）是两回事。
    val monthsPerRow = calendarMonthsPerRow(LocalConfiguration.current.screenWidthDp, fontScale)
    val monthWidth = LedgerSize.heatCell * MONTH_GRID_COLUMNS + LedgerSpace.hairline * (MONTH_GRID_COLUMNS - 1)
    Column(verticalArrangement = Arrangement.spacedBy(LedgerSpace.md)) {
        months.chunked(monthsPerRow).forEach { row ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(
                    LedgerSpace.sm,
                    alignment = Alignment.CenterHorizontally
                )
            ) {
                row.forEach { month ->
                    val summary = remember(month) { monthAccessibilitySummary(month.yearMonth, month.cells) }
                    val focusRequester = remember(month.yearMonth) { FocusRequester() }
                    LaunchedEffect(focusMonth) {
                        if (month.yearMonth == focusMonth) {
                            focusRequester.requestFocus()
                            onFocusRestored()
                        }
                    }
                    Column(
                        Modifier
                            .focusProperties { canFocus = true }
                            .focusRequester(focusRequester)
                            .clickable(role = Role.Button) { onOpenMonth(month.yearMonth) }
                            .semantics(mergeDescendants = true) { contentDescription = summary }
                    ) {
                        Text(
                            "${month.yearMonth.monthValue}月",
                            color = palette.text,
                            fontSize = LedgerFont.caption,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(bottom = LedgerSpace.xs).semantics { heading() }
                        )
                        V2MiniMonthCanvas(palette, month.cells, thresholds)
                    }
                }
                repeat(monthsPerRow - row.size) { Spacer(Modifier.width(monthWidth)) }
            }
        }
    }
}

/**
 * 单个月份的 6×7 小格画布：10dp 格 + 2dp 间隙（[LedgerSize.heatCell] / [LedgerSpace.hairline]），
 * 不写日期数字（T10.173 §3.6：整月是一个点击目标）。五级分位量化上色，外加三种非颜色线索：
 * 未来=淡点，覆盖外=描边斜线格，当前查询范围=文字色描边（描边落在内缩后留出的卡片底色上，
 * 不叠在色阶填色上，见对比度小节）。
 */
@Composable
private fun V2MiniMonthCanvas(palette: MobileV2Palette, cells: List<InsightCalendarCell?>, thresholds: HeatLevelThresholds?) {
    val columns = MONTH_GRID_COLUMNS
    val rows = cells.size / columns
    val cellSize = LedgerSize.heatCell
    val gap = LedgerSpace.hairline
    val width = cellSize * columns + gap * (columns - 1)
    val height = cellSize * rows + gap * (rows - 1)
    Box(
        Modifier
            .size(width, height)
            .drawWithCache {
                val cellPx = cellSize.toPx()
                val gapPx = gap.toPx()
                val corner = CornerRadius(MONTH_CELL_CORNER.toPx(), MONTH_CELL_CORNER.toPx())
                val haloMarginPx = QUERY_HALO_MARGIN.toPx()
                val queryRing = Stroke(width = LedgerStroke.calendarQuery.toPx())
                val coverageOutline = Stroke(width = LedgerStroke.hairline.toPx())
                val dotRadiusPx = FUTURE_DOT_RADIUS.toPx()
                val dotColor = if (palette.isEInk) Color.Black else palette.faint.copy(alpha = 0.85f)
                onDrawBehind {
                    cells.forEachIndexed { index, cell ->
                        if (cell == null) return@forEachIndexed
                        val column = index % columns
                        val row = index / columns
                        val topLeft = Offset(column * (cellPx + gapPx), row * (cellPx + gapPx))
                        val boxSize = Size(cellPx, cellPx)
                        when {
                            cell.isFuture -> {
                                if (palette.isEInk) {
                                    drawRoundRect(Color.Black, topLeft, boxSize, corner, style = coverageOutline)
                                }
                                drawCircle(
                                    color = dotColor,
                                    radius = dotRadiusPx,
                                    center = Offset(topLeft.x + cellPx / 2f, topLeft.y + cellPx / 2f)
                                )
                            }
                            !cell.selectable -> {
                                drawUnknownHatchCell(topLeft, boxSize, corner, palette)
                                drawRoundRect(palette.outline, topLeft, boxSize, corner, style = coverageOutline)
                            }
                            else -> {
                                val level = heatLevel(cell.knownTokens ?: 0L, thresholds)
                                val fill = palette.tokens.heat[level]
                                if (cell.inQueryRange) {
                                    // 内缩填色，让描边完全落在卡片底色的留白上（不叠加在填色上），
                                    // 保证任意分级下描边对底色都 ≥3:1（复算见任务日志）。
                                    drawRoundRect(
                                        color = fill,
                                        topLeft = Offset(topLeft.x + haloMarginPx, topLeft.y + haloMarginPx),
                                        size = Size(cellPx - haloMarginPx * 2, cellPx - haloMarginPx * 2),
                                        cornerRadius = corner
                                    )
                                    drawRoundRect(palette.text, topLeft, boxSize, corner, style = queryRing)
                                } else {
                                    drawRoundRect(fill, topLeft, boxSize, corner)
                                    if (palette.isEInk) {
                                        drawRoundRect(Color.Black, topLeft, boxSize, corner, style = coverageOutline)
                                    }
                                }
                            }
                        }
                    }
                }
            }
    )
}
