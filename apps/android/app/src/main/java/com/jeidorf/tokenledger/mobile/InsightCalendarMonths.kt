package com.jeidorf.tokenledger.mobile

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerColors
import java.time.LocalDate
import java.time.YearMonth
import kotlin.math.pow
import kotlin.math.roundToInt

internal data class InsightCalendarMonth(
    val yearMonth: YearMonth,
    val cells: List<InsightCalendarCell?>
)

/** 将可信全局日期轴投影为周一开头的自然月网格；查询范围只保留在 cell 高亮属性中。 */
internal fun insightCalendarMonths(axis: InsightCalendarAxis): List<InsightCalendarMonth> {
    val selectableStart = axis.selectableStart
    val selectableEnd = axis.selectableEnd
    if (!axis.isTrusted || selectableStart == null || selectableEnd == null || selectableStart > selectableEnd) {
        return emptyList()
    }

    // 按日期建索引，覆盖轴上出现过的每一天——不再像修复前那样只留 selectable 的日子：
    // 本月末尾落在 cutoff 之后、但仍属于同一自然月的日子（Future）此前会被 "只留 selectable" 的过滤
    // 连同 "不属于本月" 的网格占位一起归零成 null，界面因此无法把它画成"未来"，只能画成透明空白，
    // 和真正的网格占位没有区别（T10.209 修复 GLB-01 相邻的一处退化：未来≠未知空白）。
    val cellsByDate = axis.cells.associateBy(InsightCalendarCell::date)
    val firstMonth = YearMonth.from(selectableStart)
    val lastMonth = YearMonth.from(selectableEnd)

    return generateSequence(firstMonth) { current ->
        current.plusMonths(1).takeIf { it <= lastMonth }
    }.map { month ->
        val firstDate = month.atDay(1)
        val gridStart = firstDate.minusDays((firstDate.dayOfWeek.value - 1).toLong())
        InsightCalendarMonth(
            yearMonth = month,
            cells = List(42) { index ->
                val date = gridStart.plusDays(index.toLong())
                if (YearMonth.from(date) != month) {
                    null
                } else {
                    cellsByDate[date] ?: InsightCalendarCell(
                        date = date,
                        tokens = 0L,
                        availability = axis.availabilityFor(date),
                        inQueryRange = false
                    )
                }
            }
        )
    }.toList()
}

/**
 * 复用 [InsightCalendarAxis] 公开的 cutoff/selectable 边界重建某一天的可得性；与 `InsightCalendar.kt` 里
 * `generateCalendarCells` 私有的同名判定同源同序（先未来、再覆盖外、否则可信），只是这里只用公开字段，
 * 供网格补位使用，不需要 [axis] 之外的任何上下文（两处 axis 构造函数都满足 `heatmapStart == selectableStart`
 * 且 `heatmapEnd == selectableEnd`，见 InsightCalendar.kt 的 `buildInsightCalendarAxis` 两个重载）。
 */
private fun InsightCalendarAxis.availabilityFor(date: LocalDate): InsightCalendarCellAvailability {
    val cutoff = cutoffDate
    val start = selectableStart
    val end = selectableEnd
    return when {
        cutoff != null && date > cutoff -> InsightCalendarCellAvailability.Future
        start == null || end == null || date !in start..end -> InsightCalendarCellAvailability.OutsideHeatmapCoverage
        else -> InsightCalendarCellAvailability.Covered
    }
}

// ---------------------------------------------------------------------------------------
// 五级分位量化（T10.173 §3.8，T10.209）。
// ---------------------------------------------------------------------------------------

/** 五级热力分级的分位阈值：1-4 级按「本次参与量化的非零已知日」的 25/50/75 百分位切分。 */
internal data class HeatLevelThresholds(val p25: Long, val p50: Long, val p75: Long)

/**
 * 计算分位阈值。传入的必须是**已知且非零**的 Token 数（[InsightCalendarCell.knownTokens] 中 > 0 的部分）；
 * 未知（不可选）或已知为 0 的日子不参与分位计算，否则大量 0 会把阈值压到底，让"多"档形同虚设。
 *
 * 边界情形（对应任务范围「记录空月与全等月如何处理」）：
 * - **空年/空窗口**（[values] 为空，即参与量化的窗口里没有任何非零已知日）：返回 `null`。[heatLevel] 对
 *   所有 `tokens <= 0` 的日子仍回落到 0 级；调用方不应把"这里没有阈值"理解成"这里等同 0 级"——0 级只画给
 *   **已知**的 0，未知日子（未来/未查询）的呈现完全由非颜色线索（描边/点）负责，不经过这张色阶。
 *   月面板里"这个月一天数据都没有"因此渲染为清一色 0 级实心格，是分位量化在退化输入下的正常结果，不是特例。
 * - **全等**（本次窗口的非零日全部同值）：三个分位数重合为同一个值，[heatLevel] 级联比较里"不高于 p25"
 *   的第一档分支先命中，统一给 1 级，不会因为并列就抬到更高档——这是分位定义的自然结果：分位数分的是
 *   "有多少天不超过这个值"的名次，而不是"这个值离峰值多远"，所以一整年只有一种非零取值时，它们全部
 *   排在同一个（最低的）名次档。这与旧的按峰值线性插值不同，属刻意的行为差异（P2-9 的成因正是线性插值），
 *   已在 `HeatLevelQuantizationTest` 里覆盖。
 */
internal fun heatLevelThresholds(values: List<Long>): HeatLevelThresholds? {
    if (values.isEmpty()) return null
    val sorted = values.sorted()
    fun percentile(q: Double): Long {
        val index = (q * (sorted.size - 1)).roundToInt().coerceIn(0, sorted.size - 1)
        return sorted[index]
    }
    return HeatLevelThresholds(percentile(0.25), percentile(0.50), percentile(0.75))
}

/**
 * 五级热力分级：0 级 = 已知为 0；1-4 级按 [thresholds] 切分。只应对**已知**（`selectable`）日调用；
 * 未查询/未来的空格子不经过这个函数上色，由描边/点两种非颜色线索单独呈现（GLB-01：未知不画成 0）。
 *
 * `thresholds == null` 只会在调用方传入的分位集合为空、却仍然给出一个正数时出现——正常调用不会走到这里
 * （分位集合本应包含这个正数本身），这里保守回落到 1 级（"有数据，但不知道具体分位"）而不是崩溃或瞎猜更高档。
 */
internal fun heatLevel(tokens: Long, thresholds: HeatLevelThresholds?): Int = when {
    tokens <= 0L -> 0
    thresholds == null -> 1
    tokens <= thresholds.p25 -> 1
    tokens <= thresholds.p50 -> 2
    tokens <= thresholds.p75 -> 3
    else -> 4
}

/** 供年度小格与月面板共用：从一批 cell 里筛出已知且非零的 token 数，作为分位输入。 */
internal fun knownNonZeroTokens(cells: List<InsightCalendarCell?>): List<Long> =
    cells.filterNotNull().mapNotNull(InsightCalendarCell::knownTokens).filter { it > 0L }

/** 月面板的一格：日历格与它的热力级别（未来 / 覆盖外为 null，不经过色阶，GLB-01）。 */
internal data class MonthPanelDay(val cell: InsightCalendarCell, val level: Int?)

/**
 * 月面板某月 6×7 网格的逐格级别（R-69 FI-3）：阈值取**整条 axis** 的已知非零日，与年度小格
 * （`V2CalendarMonthGrid`）同一把尺子，不按单月重算，也不丢掉阈值。月面板日格只从这里拿级别，
 * `InsightCalendarMonthsTest.monthPanelLevelsUseTheAxisWideScale` 锁住这一点。
 */
internal fun monthPanelDays(axis: InsightCalendarAxis, yearMonth: YearMonth): List<MonthPanelDay?> {
    val thresholds = heatLevelThresholds(knownNonZeroTokens(axis.cells))
    val cells = insightCalendarMonths(axis).firstOrNull { it.yearMonth == yearMonth }?.cells ?: return emptyList()
    return cells.map { cell ->
        cell?.let { MonthPanelDay(it, it.knownTokens?.let { tokens -> heatLevel(tokens, thresholds) }) }
    }
}

// ---------------------------------------------------------------------------------------
// TalkBack 摘要文案（T10.173 §6.1，T10.172 C9）。
// ---------------------------------------------------------------------------------------

/**
 * 月节点读屏摘要：合计、活跃天数与最高日；没有可信日子时不编造数字（C9）。月内有日子落在当前查询范围、
 * 或有覆盖外（未查询）的日子时，按连续段说出来（方案 §6.1，R-69 P2-3）；没有就不说。
 */
internal fun monthAccessibilitySummary(yearMonth: YearMonth, cells: List<InsightCalendarCell?>): String {
    val days = cells.filterNotNull()
    val covered = days.filter(InsightCalendarCell::selectable)
    val monthLabel = "${yearMonth.monthValue}月"
    // 与日节点同一口径：查询高亮只画在可信日上；不可选又不是未来的日子读「未查询」（见 dayAccessibilityLabel）。
    val rangeNotes = buildString {
        dayRunsPhrase(covered.filter(InsightCalendarCell::inQueryRange))?.let { append("；当前查询 $it") }
        dayRunsPhrase(days.filter { !it.selectable && !it.isFuture })?.let { append("；${it}未查询") }
    }
    if (covered.isEmpty()) return "$monthLabel：尚无可信数据$rangeNotes。双击选择日期"
    val total = covered.fold(0L) { sum, cell -> sum + (cell.knownTokens ?: 0L) }
    val activeDays = covered.count { (it.knownTokens ?: 0L) > 0L }
    val peak = covered.filter { (it.knownTokens ?: 0L) > 0L }.maxByOrNull { it.knownTokens ?: 0L }
    val peakPhrase = peak?.let { "，最高 ${it.date.dayOfMonth} 日" } ?: ""
    return "$monthLabel：合计 ${v2FormatTokens(total)}，活跃 $activeDays 天$peakPhrase$rangeNotes。双击选择日期"
}

/** 把同一个月里的若干天按连续段读成「1 日至 4 日、9 日」；一天都没有时返回 null。 */
private fun dayRunsPhrase(days: List<InsightCalendarCell>): String? {
    val sorted = days.map { it.date.dayOfMonth }.distinct().sorted()
    if (sorted.isEmpty()) return null
    val runs = mutableListOf<IntRange>()
    var start = sorted.first()
    var end = start
    sorted.drop(1).forEach { day ->
        if (day == end + 1) {
            end = day
        } else {
            runs += start..end
            start = day
            end = day
        }
    }
    runs += start..end
    return runs.joinToString("、") { run -> if (run.first == run.last) "${run.first} 日" else "${run.first} 日至 ${run.last} 日" }
}

/** 日节点读屏状态：未来 / 未查询 / 已知为零 / 具体数值——四选一，不靠颜色区分（T10.173 §6.1）。 */
internal fun dayAccessibilityLabel(cell: InsightCalendarCell): String {
    val dateLabel = "${cell.date.monthValue}月${cell.date.dayOfMonth}日"
    return when {
        cell.isFuture -> "$dateLabel，未来"
        !cell.selectable -> "$dateLabel，未查询"
        (cell.knownTokens ?: 0L) <= 0L -> "$dateLabel，无消耗"
        else -> "$dateLabel，${v2FormatTokens(cell.knownTokens!!)}"
    }
}

// ---------------------------------------------------------------------------------------
// 月面板日期数字的文字色（T10.209）：4 级热力在深色主题下填色本身相当亮（与 primary 同色相），
// 直接套主题的"文字用浅色"直觉会失败（复算：深色 4 级 text 只剩 2.415:1）；改成真的算两个候选
// 各自的对比度，选高的那个，不看主题深浅猜。
// R-69 P1-2：1–3 级是带透明度的 chart-1，必须先按 alpha 合成到月面板底色上再比，否则比的是
// 不透明的 chart-1，浅色 1–3 级与深色 1–2 级会挑错（实测 1.31–3.02:1）。
// ---------------------------------------------------------------------------------------

/**
 * 月面板第 [level] 级日格上的日期数字色：把 `heat[level]` 合成到月面板底色 [LedgerColors.popover]
 * （底部面板的 containerColor）上，再在本主题两个候选里挑对比度高的那个——深色 `page`/`text`，
 * 浅色 `text`/`onPrimaryFill`，墨水屏黑/白。`InsightCalendarMonthsTest` 对三套主题的每一级断言 ≥4.5:1。
 */
internal fun monthPanelDayLabelColor(tokens: LedgerColors, level: Int): Color {
    val fill = tokens.heat[level].compositeOver(tokens.popover)
    return when {
        tokens.isEInk -> heatLevelLabelColor(fill, Color.Black, Color.White)
        tokens.isDark -> heatLevelLabelColor(fill, tokens.page, tokens.text)
        else -> heatLevelLabelColor(fill, tokens.text, tokens.onPrimaryFill)
    }
}

/** WCAG 2.x 相对亮度对比度，只读 RGB、不看 alpha：两个颜色都必须是不透明的（半透明色先合成到底色上）。 */
internal fun wcagContrastRatio(a: Color, b: Color): Double {
    val l1 = relativeLuminance(a)
    val l2 = relativeLuminance(b)
    val lighter = maxOf(l1, l2)
    val darker = minOf(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)
}

private fun relativeLuminance(color: Color): Double {
    fun channel(component: Float): Double {
        val v = component.toDouble()
        return if (v <= 0.03928) v / 12.92 else ((v + 0.055) / 1.055).pow(2.4)
    }
    return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue)
}

/**
 * 在 [darkCandidate] 与 [lightCandidate] 两个"本主题已有"的候选文字色里，挑对 [fill] 对比度更高的
 * 那个——不是按主题深浅猜，是按两边算出来的比值挑。[fill] 必须是合成后的不透明色，见 [monthPanelDayLabelColor]。
 */
internal fun heatLevelLabelColor(fill: Color, darkCandidate: Color, lightCandidate: Color): Color =
    if (wcagContrastRatio(darkCandidate, fill) >= wcagContrastRatio(lightCandidate, fill)) darkCandidate else lightCandidate
