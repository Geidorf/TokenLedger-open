package com.jeidorf.tokenledger.mobile

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters

internal enum class InsightCalendarCellAvailability {
    Covered,
    OutsideHeatmapCoverage,
    OutsideQueryRange,
    Future
}

internal data class InsightCalendarCell(
    val date: LocalDate,
    val tokens: Long,
    val availability: InsightCalendarCellAvailability,
    /** 所选范围仅高亮；可信全局覆盖内的日期均可点击复盘。 */
    val inQueryRange: Boolean = true
) {
    val selectable: Boolean get() = availability == InsightCalendarCellAvailability.Covered
    /** 只有 Covered 的 0 才是可信空记录；完整周占位不暴露为 0。 */
    val knownTokens: Long? get() = tokens.takeIf { selectable }
    val isFuture: Boolean get() = availability == InsightCalendarCellAvailability.Future
    val isInQueryCoverage: Boolean get() = inQueryRange
    val isInHeatmapCoverage: Boolean
        get() = availability != InsightCalendarCellAvailability.OutsideHeatmapCoverage
}

internal data class InsightCalendarAxis(
    val cells: List<InsightCalendarCell>,
    val timezone: String?,
    val cutoffDate: LocalDate?,
    val selectableStart: LocalDate? = null,
    val selectableEnd: LocalDate? = null,
    val unavailableReason: String? = null,
    /** 格内数值是哪个指标、怎么写成文字（§2.6）；默认有效 Token。 */
    val valueFormat: HeatmapValueFormat = HeatmapValueFormat()
) {
    val isTrusted: Boolean get() = unavailableReason == null

    fun isDateSelectable(date: LocalDate): Boolean =
        selectableStart?.let { start -> selectableEnd?.let { end -> date in start..end } } == true
}

/** 按可信热力图覆盖呈现全局日期；查询范围不裁剪底图。 */
internal fun buildInsightCalendarAxis(
    stats: StatsData,
    query: DashboardQuery,
    valueFormat: HeatmapValueFormat = HeatmapValueFormat()
): InsightCalendarAxis {
    val context = trustedCalendarContext(stats, query)
    if (context.unavailableReason != null) return context.toUnavailableAxis()
    val values = heatmapMetricValues(valueFormat.metric, stats.heatmap, stats.heatmapRequests, stats.heatmapCost)
        ?: return context.toUnavailableAxis().copy(
            unavailableReason = heatmapMetricUnavailableReason(valueFormat.metric),
            valueFormat = valueFormat
        )

    val selectableStart = context.heatmapStart
    val selectableEnd = minOf(context.heatmapEnd, context.cutoffDate)
    if (selectableStart > selectableEnd) {
        return InsightCalendarAxis(
            cells = emptyList(),
            timezone = context.timezone,
            cutoffDate = context.cutoffDate,
            unavailableReason = "当前范围没有可信日历覆盖"
        )
    }

    val gridStart = selectableStart.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
    val gridEnd = selectableEnd.with(TemporalAdjusters.nextOrSame(DayOfWeek.SUNDAY))
    return InsightCalendarAxis(
        cells = generateCalendarCells(gridStart, gridEnd, values.mapKeys { LocalDate.parse(it.key) }, context),
        timezone = context.timezone,
        cutoffDate = context.cutoffDate,
        selectableStart = selectableStart,
        selectableEnd = selectableEnd,
        valueFormat = valueFormat
    )
}

/** 辅助年度响应只贡献热力图；高亮始终来自主查询。 */
internal fun buildInsightCalendarAxis(
    state: CalendarHeatmapUiState,
    valueFormat: HeatmapValueFormat = HeatmapValueFormat()
): InsightCalendarAxis {
    if (state !is CalendarHeatmapUiState.Available) {
        val reason = when (state) {
            is CalendarHeatmapUiState.Loading -> "正在加载全局日历"
            is CalendarHeatmapUiState.Unavailable -> state.message
            else -> "全局日历尚未加载"
        }
        return InsightCalendarAxis(emptyList(), null, null, unavailableReason = reason)
    }
    val start = parseLocalDate(state.coverageStart)
    val end = parseLocalDate(state.coverageEnd)
    val zone = runCatching { ZoneId.of(state.timezone) }.getOrNull()
    if (start == null || end == null || start > end || zone == null ||
        state.heatmap.keys.any { parseLocalDate(it) == null } || state.heatmap.values.any { it < 0L }) {
        return InsightCalendarAxis(emptyList(), state.timezone, null, unavailableReason = "全局日历覆盖无效")
    }
    val cutoff = state.generatedAt?.let { parseInsightCutoffDate(it, zone) } ?: end
    val query = state.selectionQuery
    val bounds = when (query.range) {
        RangeKey.Today -> cutoff to cutoff
        RangeKey.Week -> cutoff.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)) to cutoff
        RangeKey.Month -> cutoff.withDayOfMonth(1) to cutoff
        RangeKey.Year -> cutoff.withDayOfYear(1) to cutoff
        RangeKey.All -> LocalDate.MIN to cutoff
        RangeKey.Custom -> (query.start?.let(::parseLocalDate) ?: LocalDate.MAX) to
            (query.end?.let(::parseLocalDate) ?: LocalDate.MIN)
    }
    val coveredEnd = minOf(end, cutoff)
    if (start > coveredEnd) return InsightCalendarAxis(emptyList(), state.timezone, cutoff, unavailableReason = "全局日历尚无可信日期")
    val values = heatmapMetricValues(valueFormat.metric, state.heatmap, state.heatmapRequests, state.heatmapCost)
        ?: return InsightCalendarAxis(
            emptyList(), state.timezone, cutoff,
            unavailableReason = heatmapMetricUnavailableReason(valueFormat.metric), valueFormat = valueFormat
        )
    val context = TrustedCalendarContext(state.timezone, cutoff, bounds.first, bounds.second, start, coveredEnd)
    return InsightCalendarAxis(
        cells = generateCalendarCells(start.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)),
            coveredEnd.with(TemporalAdjusters.nextOrSame(DayOfWeek.SUNDAY)),
            values.mapKeys { LocalDate.parse(it.key) }, context),
        timezone = state.timezone, cutoffDate = cutoff, selectableStart = start, selectableEnd = coveredEnd,
        valueFormat = valueFormat
    )
}

internal data class InsightCalendarDateEligibility(
    val selectable: Boolean,
    val unavailableReason: String? = null
)

/** ViewModel 发起单日请求前复用这一入口，不依赖设备当前日期。 */
internal fun insightCalendarDateEligibility(
    stats: StatsData,
    query: DashboardQuery,
    date: LocalDate
): InsightCalendarDateEligibility {
    val axis = buildInsightCalendarAxis(stats, query)
    return if (axis.isDateSelectable(date)) {
        InsightCalendarDateEligibility(selectable = true)
    } else {
        InsightCalendarDateEligibility(
            selectable = false,
            unavailableReason = axis.unavailableReason ?: "日期不在当前可信覆盖范围内"
        )
    }
}

/** 兼容旧图表固定周数入口；新洞察页应传全局 DashboardQuery。 */
internal fun buildInsightCalendarAxis(stats: StatsData, weeks: Int): InsightCalendarAxis {
    require(weeks > 0)
    val query = stats.meta?.query?.toDashboardQueryOrNull()
        ?: return InsightCalendarAxis(emptyList(), stats.meta?.timezone, null, unavailableReason = "响应未提供查询范围")
    val fullAxis = buildInsightCalendarAxis(stats, query)
    val cutoff = fullAxis.cutoffDate ?: return fullAxis
    if (!fullAxis.isTrusted) return fullAxis
    val context = trustedCalendarContext(stats, query)
    val gridEnd = cutoff.with(TemporalAdjusters.nextOrSame(DayOfWeek.SUNDAY))
    val gridStart = gridEnd.minusDays(weeks * 7L - 1L)
    return fullAxis.copy(
        cells = generateCalendarCells(gridStart, gridEnd, stats.validHeatmapValues(), context)
    )
}

private data class TrustedCalendarContext(
    val timezone: String?,
    val cutoffDate: LocalDate,
    val queryStart: LocalDate,
    val queryEnd: LocalDate,
    val heatmapStart: LocalDate,
    val heatmapEnd: LocalDate,
    val unavailableReason: String? = null
) {
    fun toUnavailableAxis() = InsightCalendarAxis(
        cells = emptyList(),
        timezone = timezone,
        cutoffDate = cutoffDate.takeUnless { it == LocalDate.MIN },
        unavailableReason = unavailableReason
    )
}

private fun trustedCalendarContext(stats: StatsData, query: DashboardQuery): TrustedCalendarContext {
    fun unavailable(timezone: String? = stats.meta?.timezone, reason: String) = TrustedCalendarContext(
        timezone, LocalDate.MIN, LocalDate.MIN, LocalDate.MIN, LocalDate.MIN, LocalDate.MIN, reason
    )

    val meta = stats.meta ?: return unavailable(reason = "响应未提供日历元数据")
    val timezone = meta.timezone?.takeIf(String::isNotBlank)
        ?: return unavailable(reason = "响应未提供日历时区")
    val zone = runCatching { ZoneId.of(timezone) }.getOrNull()
        ?: return unavailable(timezone, "响应日历时区无效")
    val echo = meta.query ?: return unavailable(timezone, "响应未提供查询范围")
    val comparisonTimezone = stats.comparison?.window?.timezone
    if (echo.timezone != timezone || (comparisonTimezone != null && comparisonTimezone != timezone)) {
        return unavailable(timezone, "响应日历时区不一致")
    }
    if (echo.range != query.range.rpcValue ||
        (query.range == RangeKey.Custom && (echo.start != query.start || echo.end != query.end))
    ) {
        return unavailable(timezone, "响应查询范围与全局范围不一致")
    }
    if (stats.heatmap.keys.any { parseLocalDate(it) == null } || stats.heatmap.values.any { it < 0L }) {
        return unavailable(timezone, "响应日历数据无效")
    }

    val cutoffRaw = stats.comparison?.window?.currentEnd ?: meta.generatedAt
    val cutoffDate = cutoffRaw?.let { parseInsightCutoffDate(it, zone) }
        ?: return unavailable(timezone, "响应未提供可信截止时间")
    val customStart = query.start?.let(::parseLocalDate)
    val customEnd = query.end?.let(::parseLocalDate)
    val queryBounds = when (query.range) {
        RangeKey.Today -> cutoffDate to cutoffDate
        RangeKey.Week -> cutoffDate.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)) to cutoffDate
        RangeKey.Month -> cutoffDate.withDayOfMonth(1) to cutoffDate
        RangeKey.Year -> cutoffDate.withDayOfYear(1) to cutoffDate
        RangeKey.All -> LocalDate.MIN to cutoffDate
        RangeKey.Custom -> {
            if (customStart == null || customEnd == null || customStart > customEnd) {
                return unavailable(timezone, "自定义范围日期无效")
            }
            customStart to minOf(customEnd, cutoffDate)
        }
    }
    val heatmapStart = if (query.range == RangeKey.Custom) customStart!! else cutoffDate.withDayOfYear(1)
    val heatmapEnd = if (query.range == RangeKey.Custom) minOf(customEnd!!, cutoffDate) else cutoffDate
    return TrustedCalendarContext(
        timezone, cutoffDate, queryBounds.first, queryBounds.second, heatmapStart, heatmapEnd
    )
}

private fun generateCalendarCells(
    gridStart: LocalDate,
    gridEnd: LocalDate,
    values: Map<LocalDate, Long>,
    context: TrustedCalendarContext
): List<InsightCalendarCell> {
    val days = ChronoUnit.DAYS.between(gridStart, gridEnd).toInt() + 1
    return List(days) { index ->
        val date = gridStart.plusDays(index.toLong())
        val availability = when {
            date > context.cutoffDate -> InsightCalendarCellAvailability.Future
            date !in context.heatmapStart..context.heatmapEnd -> InsightCalendarCellAvailability.OutsideHeatmapCoverage
            else -> InsightCalendarCellAvailability.Covered
        }
        InsightCalendarCell(
            date = date,
            tokens = values[date] ?: 0L,
            availability = availability,
            inQueryRange = availability == InsightCalendarCellAvailability.Covered && date in context.queryStart..context.queryEnd
        )
    }
}

private fun StatsData.validHeatmapValues(): Map<LocalDate, Long> =
    heatmap.mapKeys { (key, _) -> LocalDate.parse(key) }

private fun StatsQueryEcho.toDashboardQueryOrNull(): DashboardQuery? {
    val rangeKey = RangeKey.entries.firstOrNull { it.rpcValue == range } ?: return null
    return DashboardQuery(range = rangeKey, start = start, end = end)
}

private fun parseLocalDate(raw: String): LocalDate? = runCatching { LocalDate.parse(raw) }.getOrNull()

private fun parseInsightCutoffDate(raw: String, zone: ZoneId): LocalDate? {
    val value = raw.trim()
    if (value.isEmpty()) return null
    return try {
        ZonedDateTime.parse(value).withZoneSameInstant(zone).toLocalDate()
    } catch (_: DateTimeParseException) {
        try {
            OffsetDateTime.parse(value).atZoneSameInstant(zone).toLocalDate()
        } catch (_: DateTimeParseException) {
            try {
                Instant.parse(value).atZone(zone).toLocalDate()
            } catch (_: DateTimeParseException) {
                try {
                    LocalDateTime.parse(value, DateTimeFormatter.ISO_LOCAL_DATE_TIME).toLocalDate()
                } catch (_: DateTimeParseException) {
                    runCatching {
                        LocalDateTime.parse(value, DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"))
                            .toLocalDate()
                    }.getOrNull()
                }
            }
        }
    }
}

internal fun dashboardRangeLabel(query: DashboardQuery): String = when (query.range) {
    RangeKey.Custom -> if (query.start == query.end) query.start.orEmpty() else "${query.start.orEmpty()} 至 ${query.end.orEmpty()}"
    else -> query.range.label
}
