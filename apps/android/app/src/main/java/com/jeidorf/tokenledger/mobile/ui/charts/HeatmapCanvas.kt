package com.jeidorf.tokenledger.mobile.ui.charts

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.InsightCalendarAxis
import com.jeidorf.tokenledger.mobile.InsightCalendarCell
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.heatLevel
import com.jeidorf.tokenledger.mobile.heatLevelThresholds
import com.jeidorf.tokenledger.mobile.heatmapCellAtPosition
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSize
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_TOUCH_TARGET
import com.jeidorf.tokenledger.mobile.v2FormatTokens

internal data class HeatmapCellSelection(
    val date: String,
    val tokens: Long,
    val column: Int,
    val row: Int
)

/** 未来点直径 2.4dp、查询范围内缩留白 1.5dp：与 V2CalendarMonthGrid.kt 的 V2MiniMonthCanvas 同一套线索
 * 常量（这张图的格子和年度小格量级相近，都是几十 dp 内的小格；48dp 大格的月面板用了更宽的留白，
 * 见 V2CalendarSection.kt 的 V2CalendarDayCell 类注释）。 */
private val HEATMAP_FUTURE_DOT_RADIUS = 1.2.dp
private val HEATMAP_QUERY_HALO_MARGIN = 1.5.dp

/**
 * 单格的绘制计划：区分未来（点）、覆盖外（描边斜线格）与已知（五级分位色，命中查询范围再加内缩+描边）——
 * 和 [InsightCalendarCellAvailability] 三态一一对应，取代旧版按 axisCell?.selectable 单一布尔外加
 * `Color.Transparent` 的两态糊法（未来和覆盖外过去共用同一个透明格，界面上没有区别，见任务日志）。
 */
private sealed class HeatmapCellPlan {
    abstract val topLeft: Offset
    abstract val size: Size

    data class Future(override val topLeft: Offset, override val size: Size) : HeatmapCellPlan()
    data class OutsideCoverage(override val topLeft: Offset, override val size: Size) : HeatmapCellPlan()
    data class Covered(
        override val topLeft: Offset,
        override val size: Size,
        val fill: Color,
        val inQueryRange: Boolean
    ) : HeatmapCellPlan()
}

/** [drawHeatmapCell] 用到的像素参数：在 drawWithCache 里按当前密度算一次（近 12 周热力与图例键共用）。 */
private class HeatmapCellInk(
    val palette: MobileV2Palette,
    val cornerRadius: CornerRadius,
    val coverageOutline: Stroke,
    val queryRing: Stroke,
    val haloMarginPx: Float,
    val dotRadiusPx: Float,
    val dotColor: Color
)

private fun Density.heatmapCellInk(palette: MobileV2Palette) = HeatmapCellInk(
    palette = palette,
    cornerRadius = CornerRadius(2.dp.toPx(), 2.dp.toPx()),
    coverageOutline = Stroke(width = LedgerStroke.hairline.toPx()),
    queryRing = Stroke(width = LedgerStroke.calendarQuery.toPx()),
    haloMarginPx = HEATMAP_QUERY_HALO_MARGIN.toPx(),
    dotRadiusPx = HEATMAP_FUTURE_DOT_RADIUS.toPx(),
    dotColor = if (palette.isEInk) Color.Black else palette.faint.copy(alpha = 0.85f)
)

/**
 * 画一格：未来 = 淡点（墨水屏另加黑框），覆盖外 = 圆角内斜线 + outline 细框，已知 = 五级色阶；落在当前查询范围时
 * 填色内缩、外沿描 text 粗框（描边只落在底色留白上，不叠在填色上，任意分级下 ≈ text 对卡片底色）。
 * 近 12 周热力与图例键共用这一段，图例里的「覆盖外 / 当前查询 / 未来」与格子画法相同（R-69 P2-2）。
 */
private fun DrawScope.drawHeatmapCell(plan: HeatmapCellPlan, ink: HeatmapCellInk) {
    val palette = ink.palette
    when (plan) {
        is HeatmapCellPlan.Future -> {
            if (palette.isEInk) {
                drawRoundRect(Color.Black, plan.topLeft, plan.size, ink.cornerRadius, style = ink.coverageOutline)
            }
            drawCircle(
                color = ink.dotColor,
                radius = ink.dotRadiusPx,
                center = Offset(
                    plan.topLeft.x + plan.size.width / 2f,
                    plan.topLeft.y + plan.size.height / 2f
                )
            )
        }
        is HeatmapCellPlan.OutsideCoverage -> {
            drawUnknownHatchCell(plan.topLeft, plan.size, ink.cornerRadius, palette)
            drawRoundRect(palette.outline, plan.topLeft, plan.size, ink.cornerRadius, style = ink.coverageOutline)
        }
        is HeatmapCellPlan.Covered -> {
            if (plan.inQueryRange) {
                drawRoundRect(
                    color = plan.fill,
                    topLeft = Offset(plan.topLeft.x + ink.haloMarginPx, plan.topLeft.y + ink.haloMarginPx),
                    size = Size(plan.size.width - ink.haloMarginPx * 2, plan.size.height - ink.haloMarginPx * 2),
                    cornerRadius = ink.cornerRadius
                )
                drawRoundRect(palette.text, plan.topLeft, plan.size, ink.cornerRadius, style = ink.queryRing)
            } else {
                drawRoundRect(color = plan.fill, topLeft = plan.topLeft, size = plan.size, cornerRadius = ink.cornerRadius)
                if (palette.isEInk) {
                    drawRoundRect(Color.Black, plan.topLeft, plan.size, ink.cornerRadius, style = ink.coverageOutline)
                }
            }
        }
    }
}

@Composable
internal fun V2HeatmapChart(
    palette: MobileV2Palette,
    heatmap: Map<String, Long>,
    modifier: Modifier,
    weeks: Int,
    interactive: Boolean = true,
    calendarAxis: InsightCalendarAxis? = null,
    onOpenDay: ((String) -> Unit)? = null,
    initialSelectedDate: String? = null,
    compactCalendar: Boolean = false
) {
    val entries = remember(heatmap, weeks) { heatmap.entries.sortedBy { it.key }.takeLast(weeks * 7) }
    val values = remember(calendarAxis, entries) { calendarAxis?.cells?.map { it.knownTokens ?: 0L } ?: entries.map { it.value } }
    val maximum = remember(values) { (values.maxOrNull() ?: 1L).coerceAtLeast(1L) }
    val active = remember(values) { values.count { it > 0 } }
    // 五级分位量化（T10.173 §3.8，T10.209）：阈值只取这张图实际画出来的窗口（`calendarAxis` 已经是
    // 调用方裁过的窗口，见 V2HeatmapCard 的 previewAxis），和年度小格各画各的窗口、各自的分位，
    // 但共用同一个 heatLevel 分级函数与同一张 palette.tokens.heat 色阶——legend 与格子不会走偏
    // （HeatmapLevelSharingTest 覆盖）。
    val thresholds = remember(values) { heatLevelThresholds(values.filter { it > 0L }) }
    var selectedCell by remember(weeks, heatmap, calendarAxis, initialSelectedDate) {
        mutableStateOf(
            initialSelectedDate?.let { target ->
                val index = calendarAxis?.cells?.indexOfFirst { it.date.toString() == target } ?: -1
                calendarAxis?.cells?.getOrNull(index)?.takeIf(InsightCalendarCell::selectable)?.let { cell ->
                    HeatmapCellSelection(cell.date.toString(), cell.tokens, index / 7, index % 7)
                }
            }
        )
    }

    val tapModifier = if (interactive && (calendarAxis?.cells?.isNotEmpty() == true || entries.isNotEmpty())) {
        Modifier.pointerInput(weeks, entries, calendarAxis) {
            detectTapGestures { offset ->
                val pos = heatmapCellAtPosition(
                    x = offset.x,
                    y = offset.y,
                    widthPx = size.width.toFloat(),
                    heightPx = size.height.toFloat(),
                    columns = weeks,
                    rows = 7,
                    gapPx = 2.dp.toPx()
                )
                if (pos != null) {
                    val (col, row) = pos
                    val visualIndex = col * 7 + row
                    val entryIndex = entries.size - weeks * 7 + visualIndex
                    val axisCell = calendarAxis?.cells?.getOrNull(visualIndex)
                    if (axisCell?.selectable == true || calendarAxis == null && entryIndex in entries.indices) {
                        val date = axisCell?.date?.toString() ?: entries[entryIndex].key
                        val tokens = axisCell?.tokens ?: entries[entryIndex].value
                        if (onOpenDay != null) {
                            onOpenDay(date)
                        } else if (selectedCell?.column == col && selectedCell?.row == row) {
                            selectedCell = null
                        } else {
                            selectedCell = HeatmapCellSelection(date, tokens, col, row)
                        }
                    }
                }
            }
        }
    } else Modifier

    Column(modifier = modifier) {
        val gridModifier = if (calendarAxis != null && !compactCalendar) {
            Modifier.fillMaxWidth().height(190.dp)
        } else {
            Modifier.fillMaxWidth().weight(1f)
        }
        Row(modifier = gridModifier) {
            if (calendarAxis != null && !compactCalendar) {
                Column(
                    modifier = Modifier.width(24.dp).fillMaxHeight(),
                    verticalArrangement = Arrangement.SpaceEvenly,
                    horizontalAlignment = Alignment.Start
                ) {
                    listOf("一", "二", "三", "四", "五", "六", "日").forEach { weekday ->
                        Text(weekday, color = palette.faint, fontSize = LedgerFont.caption, maxLines = 1)
                    }
                }
            }
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .semantics {
                        contentDescription = if (compactCalendar) "全局活跃日历，$active 个活跃日期" else "消耗日历热力图，最近 $weeks 周，$active 个活跃日期，峰值 ${v2FormatTokens(maximum)}"
                    }
                    .then(tapModifier)
                    .drawWithCache {
                        val columns = weeks
                        val rows = 7
                        val gap = 2.dp.toPx()
                        val cellWidth = ((size.width - gap * (columns - 1)) / columns).coerceAtLeast(2f)
                        val cellHeight = ((size.height - gap * (rows - 1)) / rows).coerceAtLeast(2f)
                        val selectedStroke = Stroke(width = 1.6.dp.toPx())
                        // 五级分位量化 + 三种非颜色线索：未来=淡点、覆盖外=描边斜线格、当前查询范围=内缩填色+
                        // 文字色外描边——与 V2CalendarMonthGrid.kt / V2CalendarSection.kt 共用同一套规则
                        // （同一个 heatLevel 分级函数、同一张 palette.tokens.heat 色阶、同一套内缩+外描边
                        // 手法）；单格画法在 drawHeatmapCell，图例键也用它。
                        val ink = heatmapCellInk(palette)
                        val plans = List(columns * rows) { index ->
                            val entryIndex = entries.size - columns * rows + index
                            val axisCell = calendarAxis?.cells?.getOrNull(index)
                            val column = index / rows
                            val row = index % rows
                            val topLeft = Offset(column * (cellWidth + gap), row * (cellHeight + gap))
                            val cellSize = Size(cellWidth, cellHeight)
                            when {
                                axisCell != null && axisCell.isFuture ->
                                    HeatmapCellPlan.Future(topLeft, cellSize)
                                axisCell != null && !axisCell.selectable ->
                                    HeatmapCellPlan.OutsideCoverage(topLeft, cellSize)
                                axisCell == null && (calendarAxis != null || entryIndex !in entries.indices) ->
                                    HeatmapCellPlan.OutsideCoverage(topLeft, cellSize)
                                else -> {
                                    val value = axisCell?.knownTokens
                                        ?: (if (entryIndex in entries.indices) entries[entryIndex].value else 0L)
                                    HeatmapCellPlan.Covered(
                                        topLeft = topLeft,
                                        size = cellSize,
                                        fill = palette.tokens.heat[heatLevel(value, thresholds)],
                                        // 查询范围描边只在真的有 axis 驱动的查询范围时画；纯 entries 模式
                                        // （ambient/挂件预览，没有 calendarAxis）没有"查询范围"这个概念。
                                        inQueryRange = axisCell?.inQueryRange == true
                                    )
                                }
                            }
                        }
                        onDrawBehind {
                            plans.forEach { plan -> drawHeatmapCell(plan, ink) }
                            selectedCell?.let { sel ->
                                val selX = sel.column * (cellWidth + gap)
                                val selY = sel.row * (cellHeight + gap)
                                drawRoundRect(
                                    color = palette.text,
                                    topLeft = Offset(selX, selY),
                                    size = Size(cellWidth, cellHeight),
                                    cornerRadius = ink.cornerRadius,
                                    style = selectedStroke
                                )
                            }
                        }
                    }
            )
        }
        if (selectedCell != null) {
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp),
                shape = RoundedCornerShape(12.dp),
                color = if (palette.isEInk) palette.surface else palette.surfaceContainerHigh.copy(alpha = 0.96f),
                border = if (palette.isEInk) BorderStroke(1.dp, palette.text) else null,
                shadowElevation = if (palette.isEInk) 0.dp else 4.dp
            ) {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp)
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = selectedCell!!.date,
                            color = palette.text,
                            fontSize = LedgerFont.caption,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.weight(1f)
                        )
                        Text(
                            text = if (selectedCell!!.tokens > 0) "${v2FormatTokens(selectedCell!!.tokens)} · 活跃" else "无消耗",
                            color = if (selectedCell!!.tokens > 0) palette.blue else palette.muted,
                            fontSize = LedgerFont.caption
                        )
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.End,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        if (onOpenDay != null) {
                            TextButton(
                                onClick = { onOpenDay(selectedCell!!.date) },
                                modifier = Modifier.heightIn(min = 48.dp)
                            ) { Text("查看当天", color = palette.blue, fontSize = LedgerFont.caption) }
                        }
                        IconButton(onClick = { selectedCell = null }, modifier = Modifier.size(V2_TOUCH_TARGET)) {
                            Icon(
                                imageVector = Icons.Default.Close,
                                contentDescription = "关闭选中日期",
                                tint = palette.muted,
                                modifier = Modifier.size(V2_ICON_INLINE)
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * 年度小格 / 月面板 / 近 12 周热力共用的图例（T10.209，替代 V2ChartLegends.kt 里 4 格硬编码透明度的
 * [V2HeatmapLegend]——那 4 格是 P2-9 的成因：图例自己数透明度，格子另按峰值线性插值，两边各画各的）。
 * 色阶直接切 [MobileV2Palette.tokens] 的 `heat` 五色数组，和 [heatLevel] 分级函数上色时用的是同一张表；
 * 契约测试「Android 日历五级色阶图例与三处格子共用同一张表」防止又长出第二份色阶。
 *
 * 色阶后面是三种非颜色线索的键（R-69 P2-2，方案 §7.4）：覆盖外、当前查询、未来，每个键是一小格样本
 * （与格子同一段 [drawHeatmapCell] 画法）加短标签。整行仍按原来的宽度排，放不下就折行。
 *
 * [V2ChartLegends.V2HeatmapLegend] 本身不再被任何日历/热力组件引用（本文件是唯一调用方，已切到这里），
 * 归属 A3/T10.207 的清理项——见任务日志「建议写入 SSOT 的文字」。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun V2HeatmapScaleLegend(
    palette: MobileV2Palette,
    modifier: Modifier = Modifier
) {
    FlowRow(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(LedgerSpace.md),
        verticalArrangement = Arrangement.spacedBy(LedgerSpace.xs)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("少", color = palette.muted, fontSize = LedgerFont.caption)
            Spacer(Modifier.width(4.dp))
            palette.tokens.heat.forEach { levelColor ->
                Box(
                    modifier = Modifier
                        .padding(horizontal = 2.dp)
                        .size(width = 12.dp, height = 8.dp)
                        .background(levelColor, RoundedCornerShape(3.dp))
                        .then(if (palette.isEInk) Modifier.border(0.5.dp, Color.Black, RoundedCornerShape(3.dp)) else Modifier)
                )
            }
            Spacer(Modifier.width(4.dp))
            Text("多", color = palette.muted, fontSize = LedgerFont.caption)
        }
        V2HeatmapCueKey(palette, "覆盖外") { size -> HeatmapCellPlan.OutsideCoverage(Offset.Zero, size) }
        V2HeatmapCueKey(palette, "当前查询") { size ->
            HeatmapCellPlan.Covered(Offset.Zero, size, fill = palette.tokens.heat[2], inQueryRange = true)
        }
        V2HeatmapCueKey(palette, "未来") { size -> HeatmapCellPlan.Future(Offset.Zero, size) }
    }
}

/** 图例里的一个线索键：一格样本（10dp，与年度小格同尺寸、同一段 [drawHeatmapCell] 画法）+ 短标签。 */
@Composable
private fun V2HeatmapCueKey(palette: MobileV2Palette, label: String, plan: (Size) -> HeatmapCellPlan) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .size(LedgerSize.heatCell)
                .drawWithCache {
                    val ink = heatmapCellInk(palette)
                    val sample = plan(size)
                    onDrawBehind { drawHeatmapCell(sample, ink) }
                }
        )
        Spacer(Modifier.width(LedgerSpace.xs))
        Text(label, color = palette.muted, fontSize = LedgerFont.caption, maxLines = 1)
    }
}
