package com.jeidorf.tokenledger.mobile.ui.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.CalendarHeatmapUiState
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.HeatmapMetric
import com.jeidorf.tokenledger.mobile.HeatmapValueFormat
import com.jeidorf.tokenledger.mobile.InsightCalendarAxis
import com.jeidorf.tokenledger.mobile.InsightCalendarCell
import com.jeidorf.tokenledger.mobile.InsightCalendarCellAvailability
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.MonthPanelDay
import com.jeidorf.tokenledger.mobile.ProvideLedgerPalette
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenLedgerTheme
import com.jeidorf.tokenledger.mobile.buildInsightCalendarAxis
import com.jeidorf.tokenledger.mobile.dayAccessibilityLabel
import com.jeidorf.tokenledger.mobile.monthPanelDayLabelColor
import com.jeidorf.tokenledger.mobile.monthPanelDays
import com.jeidorf.tokenledger.mobile.safeTokenAdd
import com.jeidorf.tokenledger.mobile.ui.charts.V2HeatmapScaleLegend
import com.jeidorf.tokenledger.mobile.ui.charts.drawUnknownHatchCell
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Segment
import com.jeidorf.tokenledger.mobile.ui.foundation.V2SegmentedToggle
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import com.jeidorf.tokenledger.mobile.ui.navigation.V2IconAction
import java.time.LocalDate
import java.time.YearMonth

@Composable
internal fun V2InsightCalendarCard(
    palette: MobileV2Palette,
    stats: StatsData,
    onOpenDay: (String) -> Unit,
    query: DashboardQuery,
    initialSelectedDate: String? = null,
    globalAxis: InsightCalendarAxis? = null,
    calendarNotice: String? = null,
    restoreFocusDate: String? = null,
    onFocusRestored: () -> Unit = {},
    calendarState: CalendarHeatmapUiState? = null,
    initialMetric: HeatmapMetric = HeatmapMetric.Tokens
) {
    val costMasked = LocalCostMaskEnabled.current
    val currency = LocalDashboardCurrency.current
    var metric by rememberSaveable { mutableStateOf(initialMetric) }
    // 隐藏费用时连费用色阶也不画：颜色深浅本身就泄露相对金额。
    val metricOptions = remember(costMasked) {
        HeatmapMetric.entries.filter { it != HeatmapMetric.Cost || !costMasked }.map { V2Segment(it, it.label, "按${it.label}着色") }
    }
    val activeMetric = metric.takeIf { option -> metricOptions.any { it.value == option } } ?: HeatmapMetric.Tokens
    val format = HeatmapValueFormat(activeMetric, currency)
    // 日期选择只依赖可信覆盖，不随可选着色指标的缺失而关闭。
    val dateAxis = remember(stats, query, globalAxis, calendarState) {
        globalAxis ?: calendarState?.let { buildInsightCalendarAxis(it) } ?: buildInsightCalendarAxis(stats, query)
    }
    val canPickDay = dateAxis.isTrusted && dateAxis.cells.any(InsightCalendarCell::selectable)
    val axis = remember(stats, query, dateAxis, calendarState, format) {
        when {
            activeMetric == HeatmapMetric.Tokens -> dateAxis
            calendarState != null -> buildInsightCalendarAxis(calendarState, format)
            else -> buildInsightCalendarAxis(stats, query, format)
        }
    }
    var showDayPicker by rememberSaveable { mutableStateOf(false) }
    var pickerDate by rememberSaveable(initialSelectedDate) { mutableStateOf(initialSelectedDate) }
    // 月面板：点年度小格里的月份打开，月内可信日期点入单日复盘（T10.173 §7.4）；
    // 存字符串而不是 YearMonth，配置变化后可用默认 Saver 还原。
    var openMonth by rememberSaveable { mutableStateOf<String?>(null) }
    V2Card(palette) {
        Box(Modifier.heightIn(min = 48.dp), contentAlignment = Alignment.CenterStart) {
            Text("全局用量日历", color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
        }
        V2SegmentedToggle(palette, metricOptions, activeMetric, { metric = it }, Modifier.padding(bottom = 8.dp))
        if (!axis.isTrusted || axis.cells.none(InsightCalendarCell::selectable)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    axis.unavailableReason ?: "当前范围没有可信的日期覆盖",
                    color = palette.muted, fontSize = LedgerFont.label,
                    modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite }
                )
                if (canPickDay) {
                    V2IconAction(palette, Icons.Default.CalendarMonth, "选择日期查看当天复盘", { showDayPicker = true })
                }
            }
            return@V2Card
        }
        val covered = axis.cells.filter(InsightCalendarCell::selectable)
        val total = covered.fold(0L) { sum, cell -> safeTokenAdd(sum, cell.tokens) }
        Text(
            format.format(total),
            color = palette.text,
            fontSize = LedgerFont.displaySmall,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(top = 8.dp)
        )
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "年度累计${activeMetric.label} · ${covered.count { it.tokens > 0 }} 天活跃\n${axis.selectableStart} 至 ${axis.selectableEnd} · ${axis.timezone}",
                color = palette.muted,
                fontSize = LedgerFont.caption,
                modifier = Modifier.weight(1f)
            )
            if (canPickDay) {
                V2IconAction(palette, Icons.Default.CalendarMonth, "选择日期查看当天复盘", { showDayPicker = true })
            }
        }
        HorizontalDivider(color = palette.divider, modifier = Modifier.padding(vertical = 10.dp))
        V2HeatmapScaleLegend(palette)
        Spacer(Modifier.height(8.dp))
        // 只消费本次单日返回的焦点请求，普通切页不重放旧日期，保留后续手动阅读位置。
        val focusMonth = remember(restoreFocusDate) {
            restoreFocusDate?.let { runCatching { YearMonth.from(LocalDate.parse(it)) }.getOrNull() }
        }
        V2CalendarMonthGrid(palette, axis, focusMonth, onFocusRestored) { month -> openMonth = month.toString() }
        Text(
            "峰值 ${format.format(covered.maxOfOrNull { it.tokens } ?: 0L)}",
            color = palette.muted,
            fontSize = LedgerFont.caption,
            modifier = Modifier.padding(vertical = 10.dp)
        )
        calendarNotice?.let {
            Text(
                it,
                color = palette.muted,
                fontSize = LedgerFont.caption,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
            )
        }
    }
    if (showDayPicker && canPickDay) {
        V2SingleDayDialog(palette, dateAxis, pickerDate, onDismiss = { showDayPicker = false }) { date ->
            showDayPicker = false
            onOpenDay(date)
        }
    }
    openMonth?.let { raw ->
        val yearMonth = runCatching { YearMonth.parse(raw) }.getOrNull()
        if (yearMonth != null) {
            V2CalendarMonthPanel(palette, yearMonth, axis, onDismiss = { openMonth = null }) { date ->
                openMonth = null
                onOpenDay(date)
            }
        } else {
            openMonth = null
        }
    }
}

/**
 * 点月份后的底部面板（T10.173 §7.4）：7 列 48dp 日格，带日期数字与同色阶底；可信日期点入单日复盘，
 * 未来与覆盖外不可点（DESIGN §6.2.1「点击整个月份」规则）。内容见 [V2CalendarMonthPanelContent]。
 */
@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun V2CalendarMonthPanel(
    palette: MobileV2Palette,
    yearMonth: YearMonth,
    axis: InsightCalendarAxis,
    onDismiss: () -> Unit,
    onSelectDay: (String) -> Unit
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = palette.tokens.popover,
        contentColor = palette.text
    ) {
        V2CalendarMonthPanelContent(palette, yearMonth, axis, onSelectDay)
    }
}

/**
 * 月面板内容（R-69 抽出，截图测试直接摆它：`ModalBottomSheet` 在 layoutlib 里渲染不出来）。
 * 逐格级别只从 [monthPanelDays] 拿——分位阈值取全局 axis，与年度小格同一把尺子，图例、年度小格与
 * 本面板共用同一个分级函数（R-69 FI-3）。内容纵向可滚：日格随宽度等分，844×390 横屏里 5–6 行
 * 放不下，滚动后每一周都点得到（R-69 P2-5）。
 */
@Composable
internal fun V2CalendarMonthPanelContent(
    palette: MobileV2Palette,
    yearMonth: YearMonth,
    axis: InsightCalendarAxis,
    onSelectDay: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val days = remember(axis, yearMonth) { monthPanelDays(axis, yearMonth) }
    Column(
        modifier
            .verticalScroll(rememberScrollState())
            .padding(horizontal = LedgerSpace.lg, vertical = LedgerSpace.sm)
    ) {
        Text(
            "$yearMonth",
            color = palette.text,
            fontSize = LedgerFont.subtitle,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.semantics { heading() }.padding(bottom = LedgerSpace.sm)
        )
        Row(Modifier.fillMaxWidth()) {
            listOf("一", "二", "三", "四", "五", "六", "日").forEach { weekday ->
                Text(
                    weekday,
                    color = palette.faint,
                    fontSize = LedgerFont.caption,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f)
                )
            }
        }
        // 6×7=42 格是固定网格（含月首/月末的占位 null）；短月末尾整行都是 null 时不渲染空行。
        days.chunked(7).filter { week -> week.any { it != null } }.forEach { week ->
            Row(Modifier.fillMaxWidth()) {
                week.forEach { day ->
                    V2CalendarDayCell(Modifier.weight(1f), palette, day, axis.valueFormat, onSelectDay)
                }
            }
        }
        Spacer(Modifier.height(LedgerSpace.md))
    }
}

/**
 * 月面板里的单日格：目标 48dp（[com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSize.touchTarget]），
 * 但 320dp 屏放不下 7×48dp（336dp 已经超过屏宽本身，与 M3 `DateRangePicker` 同样的几何限制，见 T10.177
 * 修复轮日志「320dp 核对与残留」），所以按 [Modifier.weight] 随行宽等分、用 [Modifier.aspectRatio] 保持
 * 正方形——390/430dp 下自然 ≥48dp，320dp 下略小但不裁切、不重叠（viewport 矩阵实测值见任务日志）。
 */
@Composable
internal fun V2CalendarDayCell(
    modifier: Modifier,
    palette: MobileV2Palette,
    day: MonthPanelDay?,
    format: HeatmapValueFormat = HeatmapValueFormat(),
    onSelectDay: (String) -> Unit
) {
    if (day == null) {
        Spacer(modifier.aspectRatio(1f))
        return
    }
    val cell = day.cell
    // 级别由 monthPanelDays 统一给出（全局分位尺子）；这里不再自己分级。未来 / 覆盖外为 null。
    val level = day.level
    val label = remember(cell, format) { dayAccessibilityLabel(cell, format) }
    val clickModifier = if (cell.selectable) {
        Modifier.clickable(role = Role.Button) { onSelectDay(cell.date.toString()) }
    } else {
        Modifier.semantics { disabled() }
    }
    Box(
        // 触达区取满 1/7 行宽（不裁进 padding），格与格之间的视觉留白改由下面 drawWithCache 内缩填色
        // 实现，不缩小可点范围——320dp 屏本来就不够放 7×48dp（见类注释），可点范围能保多大就保多大。
        modifier
            .aspectRatio(1f)
            .then(clickModifier)
            .semantics(mergeDescendants = true) { contentDescription = label }
            .drawWithCache {
                val corner = CornerRadius(LedgerRadius.xs.toPx(), LedgerRadius.xs.toPx())
                val visualGapPx = LedgerSpace.hairline.toPx()
                val haloMarginPx = visualGapPx + LedgerStroke.calendarQuery.toPx()
                val queryRing = Stroke(width = LedgerStroke.calendarQuery.toPx())
                val coverageOutline = Stroke(width = LedgerStroke.hairline.toPx())
                val dotRadiusPx = 2.dp.toPx()
                val dotColor = if (palette.isEInk) Color.Black else palette.faint.copy(alpha = 0.85f)
                fun inset(margin: Float) = Offset(margin, margin) to
                    androidx.compose.ui.geometry.Size(size.width - margin * 2, size.height - margin * 2)
                onDrawBehind {
                    val (visualTopLeft, visualSize) = inset(visualGapPx)
                    when {
                        cell.isFuture -> {
                            if (palette.isEInk) {
                                drawRoundRect(Color.Black, visualTopLeft, visualSize, corner, style = coverageOutline)
                            }
                            drawCircle(dotColor, radius = dotRadiusPx, center = Offset(size.width / 2f, size.height / 2f))
                        }
                        level == null -> {
                            drawUnknownHatchCell(visualTopLeft, visualSize, corner, palette)
                            drawRoundRect(palette.outline, visualTopLeft, visualSize, corner, style = coverageOutline)
                        }
                        else -> {
                            val fill = palette.tokens.heat[level]
                            if (cell.inQueryRange) {
                                // 内缩填色，让文字色描边完全落在卡片底色的留白上（不叠在填色上），
                                // 任意分级下都能保证 ≥3:1（复算见任务日志「对比度」小节）。
                                val (fillTopLeft, fillSize) = inset(haloMarginPx)
                                drawRoundRect(fill, fillTopLeft, fillSize, corner)
                                drawRoundRect(palette.text, visualTopLeft, visualSize, corner, style = queryRing)
                            } else {
                                drawRoundRect(fill, visualTopLeft, visualSize, corner)
                                if (palette.isEInk) {
                                    drawRoundRect(Color.Black, visualTopLeft, visualSize, corner, style = coverageOutline)
                                }
                            }
                        }
                    }
                }
            },
        contentAlignment = Alignment.Center
    ) {
        if (cell.selectable || cell.isFuture) {
            // 数字色按「合成到面板底色后的本级填色」逐级挑（R-69 P1-2），不照主题深浅猜，也不忽略透明度。
            val textColor = if (level == null) palette.faint else monthPanelDayLabelColor(palette.tokens, level)
            Text(cell.date.dayOfMonth.toString(), color = textColor, fontSize = LedgerFont.label)
        }
    }
}

@Composable
internal fun V2InsightCalendarPreviewContent(
    appearance: LedgerAppearance,
    stats: StatsData,
    initialSelectedDate: String,
    initialMetric: HeatmapMetric = HeatmapMetric.Tokens
) {
    val palette = remember(appearance) { v2Palette(appearance) }
    TokenLedgerTheme(appearance) {
        ProvideLedgerPalette(appearance) {
            Box(Modifier.fillMaxSize().background(palette.background).padding(14.dp)) {
                V2InsightCalendarCard(
                    palette, stats, onOpenDay = {},
                    query = DashboardQuery(
                        range = RangeKey.entries.firstOrNull { it.rpcValue == stats.meta?.query?.range } ?: RangeKey.Today,
                        start = stats.meta?.query?.start, end = stats.meta?.query?.end
                    ),
                    initialSelectedDate = initialSelectedDate,
                    initialMetric = initialMetric
                )
            }
        }
    }
}

/**
 * [V2SingleDayDialog] 独立截图夹具（T10.177 P3-13 收尾，T10.209 范围 5）：修复前这个弹层截图覆盖为零——
 * `V2InsightCalendarPreviewContent` 传了 `initialSelectedDate` 却从不把 `showDayPicker` 置真，弹层
 * 永远不会在截图里出现。这里绕开卡片本身，直接摆弹层，专测 320dp 与 200% 字号两种此前没人验过的状态。
 */
@Composable
internal fun V2SingleDayDialogPreviewContent(
    appearance: LedgerAppearance,
    initialSelectedDate: String
) {
    val palette = remember(appearance) { v2Palette(appearance) }
    val axis = remember {
        val start = LocalDate.of(2026, 1, 1)
        val end = LocalDate.of(2026, 9, 20)
        InsightCalendarAxis(
            cells = generateSequence(start) { current -> current.plusDays(1).takeIf { it <= end } }
                .map { InsightCalendarCell(it, it.dayOfMonth * 1000L, InsightCalendarCellAvailability.Covered) }
                .toList(),
            timezone = "Asia/Shanghai",
            cutoffDate = end,
            selectableStart = start,
            selectableEnd = end
        )
    }
    TokenLedgerTheme(appearance) {
        ProvideLedgerPalette(appearance) {
            Box(Modifier.fillMaxSize().background(palette.background)) {
                V2SingleDayDialog(palette, axis, initialSelectedDate, onDismiss = {}, onSelect = {})
            }
        }
    }
}
