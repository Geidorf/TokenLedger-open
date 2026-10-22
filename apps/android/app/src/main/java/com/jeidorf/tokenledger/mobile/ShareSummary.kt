package com.jeidorf.tokenledger.mobile

import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.YearMonth
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToLong

internal enum class ShareLayoutKey(
    val stableKey: String,
    val label: String,
    val description: String
) {
    Scorecard("scorecard", "数据海报", "趋势、构成与关键数据"),
    Journal("journal", "协作手记", "活跃轨迹与阶段小结"),
    Achievement("achievement", "连续成就", "用一个数字放大持续协作"),
    Receipt("receipt", "协作结算单", "逐项列出这一周期的成果"),
    Signal("signal", "极简信号", "聚焦有效 Token 与输入输出")
}

internal data class SharePoint(
    val bucket: String,
    val dateLabel: String,
    val weekdayLabel: String?,
    val tokens: Long,
    val requests: Long,
    val inProgress: Boolean = false
)

internal data class ShareSummary(
    val range: RangeKey,
    val title: String,
    val periodLabel: String,
    val effectiveTokens: Long,
    val inputTokens: Long,
    val outputTokens: Long,
    val cachedTokens: Long,
    val totalRequests: Long,
    val deltaPercent: Double?,
    val activeDays: Int?,
    val longestStreakDays: Int?,
    val peakLabel: String?,
    val peakTokens: Long?,
    val cacheReusePercent: Int?,
    val costCny: Double?,
    val netSavedCostCny: Double?,
    val topTool: String?,
    val topModel: String?,
    val points: List<SharePoint>,
    val highlight: String,
    val dataSourceLabel: String,
    val generatedDateLabel: String,
    val includesEstimates: Boolean,
    val stale: Boolean,
    val costMasked: Boolean
) {
    val shareCaption: String
        get() = "${title} · ${formatCompactTokens(effectiveTokens)} 有效 Token · 来自 TokenLedger"
}

private data class ShareTimeContext(
    val zoneId: ZoneId,
    val cutoffDate: LocalDate,
    val cutoffHour: Int,
    val cutoffHourInProgress: Boolean
)

internal fun buildShareSummary(
    stats: StatsData,
    range: RangeKey,
    costMasked: Boolean,
    generatedAt: Instant = Instant.now(),
    cnyExchangeRate: Double = BuildConfig.TOKENLEDGER_CNY_EXCHANGE_RATE
): ShareSummary {
    val summary = stats.summary
    val effectiveTokens = runCatching {
        Math.addExact(summary.inputTokens, summary.outputTokens)
    }.getOrNull() ?: summary.totalTokens.takeIf { it >= 0L } ?: 0L
    val comparison = stats.comparison
    val timeContext = deriveShareTimeContext(stats, range)
    val comparisonPoints = comparison
        ?.takeIf { comparisonMatchesRange(it, range) }
        ?.current
        ?.series
        .orEmpty()
        .mapNotNull { point ->
            if (point.tokens < 0L || point.requests < 0L || timeContext == null) return@mapNotNull null
            if (!bucketIsObserved(point.bucket, range, timeContext)) return@mapNotNull null
            sharePoint(point.bucket, point.tokens, point.requests, range, timeContext)
        }
    val fallbackPoints = if (comparisonPoints.isEmpty() && timeContext != null) {
        stats.trends.mapNotNull { point ->
            val tokens = sumNonNegativeLongsOrNull(
                point.values.filterKeys { !it.startsWith("__") }.values
            ) ?: return@mapNotNull null
            if (tokens < 0L || !bucketIsObserved(point.date, range, timeContext)) return@mapNotNull null
            sharePoint(point.date, tokens, point.requests, range, timeContext)
        }
    } else {
        emptyList()
    }
    val points = (comparisonPoints.ifEmpty { fallbackPoints }).takeLast(31)
    val activeDates = timeContext?.let { activeDatesForRange(stats, range, points, it) }
    val activeDays = when {
        timeContext == null -> null
        range == RangeKey.Today -> if (effectiveTokens > 0L) 1 else 0
        !activeDates.isNullOrEmpty() -> activeDates.distinct().size
        else -> null
    }
    val longestStreak = activeDates
        ?.takeIf { it.isNotEmpty() }
        ?.let(::longestDateStreak)
    val peak = when {
        timeContext == null -> null
        range == RangeKey.Today -> points.filter { it.tokens > 0L }.maxByOrNull { it.tokens }
        else -> points.filter { it.tokens > 0L }.maxByOrNull { it.tokens }
            ?: heatmapPeakForRange(stats, range, timeContext)
    }
    val deltaPercent = comparison
        ?.takeIf { timeContext != null }
        ?.takeIf { range in setOf(RangeKey.Today, RangeKey.Week, RangeKey.Month, RangeKey.Custom) }
        ?.takeIf { comparisonMatchesRange(it, range) }
        ?.takeIf { it.current.summary.effectiveTokens == effectiveTokens }
        ?.delta
        ?.tokens
        ?.percent
        ?.takeIf(Double::isFinite)

    val read = summary.cacheReadTokens
    val write = summary.cacheWriteTokens
    val reliableCacheSplit = summary.cacheSplitKnown && read >= 0L && write >= 0L &&
        runCatching { Math.addExact(read, write) }.getOrNull() == summary.cachedTokens
    val cacheReusePercent = if (reliableCacheSplit) {
        val cacheRead = read
        val denominator = runCatching { Math.addExact(summary.inputTokens, cacheRead) }.getOrNull()
        if (cacheRead > 0L && denominator != null && denominator > 0L) {
            (cacheRead * 100.0 / denominator).roundToLong().toInt().coerceIn(0, 100)
        } else {
            null
        }
    } else {
        null
    }
    val topTool = stats.tools.values
        .filter { it.effectiveTokens > 0L }
        .maxWithOrNull(compareBy<ToolStat> { it.effectiveTokens }.thenByDescending { it.name })
        ?.name
    val topModel = stats.models.values
        .filter { it.effectiveTokens > 0L }
        .maxWithOrNull(compareBy<ModelStat> { it.effectiveTokens }.thenByDescending { it.name })
        ?.name
    val stale = stats.meta?.stale == true
    val visibleCost = !costMasked && summary.totalCost > 0.0 && summary.totalCost.isFinite()
    // 海报展示「缓存净节省」而不是毛值（root 2026-09-25 18:50 决定；用户决定 Q3/Q7；方案
    // §4.6 A3）：只有 netSavedUsd 有限且 > 0、缓存读写拆分可证明、且费用未被隐藏时才显示；
    // 从不画毛值 cacheSavedUsd、负净值或不可得值。旧响应没有 canonical 能力位，即使对象意外
    // 存在也仍按不可得处理；新响应只有显式声明能力才允许消费。
    // root R-36 P3-5：海报没有位置画「含兜底单价」标注（用户决定 Q4 要求），只要任一
    // 兜底计数 > 0 就整体不画净节省，退回其他事实补位，避免呈现一个未标注兜底来源的数字。
    // 对象本身合法仍不等于来源声明了这项能力。旧来源可能携带未知/试验字段；Android 只在
    // canonical 能力位明确为 true 时消费，缺失与 false 都按不可得处理（Stats v2 §2.4）。
    val cacheSavings = summary.cacheSavings.takeIf { stats.capabilities.cacheSavings }
    val netSavedUsd = cacheSavings?.netSavedUsd
    val hasFallbackPricing = cacheSavings != null &&
        (cacheSavings.fallbackPricedReadTokens > 0L || cacheSavings.fallbackPricedWriteTokens > 0L)
    val visibleNetSavedCost = reliableCacheSplit && !costMasked && !hasFallbackPricing &&
        netSavedUsd != null && netSavedUsd.isFinite() && netSavedUsd > 0.0
    val exchangeRate = cnyExchangeRate.takeIf { it.isFinite() && it > 0.0 } ?: 7.2
    val sourceDate = timeContext?.cutoffDate

    return ShareSummary(
        range = range,
        title = shareTitle(range),
        periodLabel = sharePeriodLabel(range, comparison, sourceDate, timeContext?.zoneId),
        effectiveTokens = effectiveTokens,
        inputTokens = summary.inputTokens,
        outputTokens = summary.outputTokens,
        cachedTokens = summary.cachedTokens,
        totalRequests = summary.totalRequests,
        deltaPercent = deltaPercent,
        activeDays = activeDays,
        longestStreakDays = longestStreak,
        peakLabel = peak?.let(::peakLabel),
        peakTokens = peak?.tokens,
        cacheReusePercent = cacheReusePercent,
        costCny = summary.totalCost.times(exchangeRate).takeIf { visibleCost },
        netSavedCostCny = netSavedUsd?.times(exchangeRate)?.takeIf { visibleNetSavedCost },
        topTool = topTool,
        topModel = topModel,
        points = points,
        highlight = if (timeContext == null) {
            "时间洞察不可得，核心用量仍按来源数据展示"
        } else {
            shareHighlight(range, activeDays, longestStreak, peak)
        },
        dataSourceLabel = if (stale) "已同步账本 · 历史快照" else "已同步账本",
        generatedDateLabel = generatedAt
            .atZone(timeContext?.zoneId ?: ZoneOffset.UTC)
            .toLocalDate()
            .format(DateTimeFormatter.ofPattern("yyyy.MM.dd")),
        includesEstimates = stats.tools.keys.any { it.lowercase(Locale.ROOT) in ESTIMATED_TOOLS },
        stale = stale,
        costMasked = costMasked
    )
}

internal fun StatsData.matchesShareRange(range: RangeKey): Boolean {
    val responseMeta = meta ?: return false
    if (responseMeta.range != range.rpcValue) return false
    if (range != RangeKey.Custom) return true

    val query = responseMeta.query ?: return false
    if (query.range != RangeKey.Custom.rpcValue) return false
    val start = query.start?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: return false
    val end = query.end?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: return false
    return !start.isAfter(end)
}

/** 海报的 Token 写法与应用同一套（A-Q1，[formatTokenMagnitude]）；此前这里另有一份，999,500 写成 `1000K`。 */
internal fun formatCompactTokens(value: Long): String = v2FormatTokens(value)

/** 海报的变化率与应用同一套（R-11，[formatChangePercent]）；没有可证明的变化率时整项省略。 */
internal fun formatShareDelta(value: Double?): String? = value?.takeIf(Double::isFinite)?.let(::formatChangePercent)

private fun deriveShareTimeContext(stats: StatsData, range: RangeKey): ShareTimeContext? {
    val meta = stats.meta ?: return null
    val assertedRange = meta.query?.range ?: meta.range
    if (assertedRange != null && assertedRange != range.rpcValue) return null
    val zoneId = meta.timezone.toIanaZoneIdOrNull() ?: return null
    val sourceZone = zoneId.id
    val queryZone = meta.query?.timezone
    if (queryZone != null && queryZone != sourceZone) return null
    val windowZone = stats.comparison?.window?.timezone
    if (windowZone != null && windowZone != sourceZone) return null

    val comparisonEnd = stats.comparison?.window?.currentEnd
    if (comparisonEnd != null && windowZone == sourceZone) {
        comparisonEnd.toCivilCutoffOrNull(zoneId)?.let { return it }
    }

    // generatedAt 只有在 meta/query 双方明确确认同一 IANA 时区时才可作为来源截止点。
    if (queryZone != sourceZone) return null
    return meta.generatedAt.toInstantOrNull()
        ?.atZone(zoneId)
        ?.let { ShareTimeContext(zoneId, it.toLocalDate(), it.hour, cutoffHourInProgress = false) }
}

private fun String?.toIanaZoneIdOrNull(): ZoneId? {
    val value = this?.trim().orEmpty()
    if (value !in ZoneId.getAvailableZoneIds()) return null
    return runCatching { ZoneId.of(value) }.getOrNull()
}

private fun String?.toInstantOrNull(): Instant? {
    val value = this?.trim().orEmpty()
    if (value.isEmpty()) return null
    return runCatching { Instant.parse(value) }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(value).toInstant() }.getOrNull()
}

private fun String.toCivilCutoffOrNull(zoneId: ZoneId): ShareTimeContext? {
    val zoned = toInstantOrNull()?.atZone(zoneId)
        ?: runCatching {
            val localDateTime = LocalDateTime.parse(trim())
            val offsets = zoneId.rules.getValidOffsets(localDateTime)
            if (offsets.size != 1) return@runCatching null
            ZonedDateTime.ofStrict(localDateTime, offsets.single(), zoneId)
        }.getOrNull()
        ?: return null
    val closesWholeDay = zoned.hour == 23 && zoned.minute == 59 && zoned.second == 59
    return ShareTimeContext(
        zoneId = zoneId,
        cutoffDate = zoned.toLocalDate(),
        cutoffHour = zoned.hour,
        cutoffHourInProgress = !closesWholeDay
    )
}

private fun bucketIsObserved(bucket: String, range: RangeKey, context: ShareTimeContext): Boolean = when (range) {
    RangeKey.Today -> {
        val value = bucket.trim()
        Regex("^(?:[01]\\d|2[0-3]):00$").matches(value) &&
            value.take(2).toInt() <= context.cutoffHour
    }
    RangeKey.Week -> {
        val date = parseDateBucket(bucket)
        val weekStart = context.cutoffDate.minusDays((context.cutoffDate.dayOfWeek.value - 1).toLong())
        date != null && !date.isBefore(weekStart) && !date.isAfter(context.cutoffDate)
    }
    RangeKey.Month -> {
        val date = parseDateBucket(bucket)
        date != null && date.year == context.cutoffDate.year &&
            date.monthValue == context.cutoffDate.monthValue && !date.isAfter(context.cutoffDate)
    }
    RangeKey.Year -> {
        val value = bucket.trim()
        val month = runCatching { YearMonth.parse(value) }.getOrNull()
        month != null && month.year == context.cutoffDate.year &&
            month <= YearMonth.from(context.cutoffDate)
    }
    RangeKey.All -> parseDateBucket(bucket)?.let { !it.isAfter(context.cutoffDate) } == true
    RangeKey.Custom -> {
        val hour = bucket.trim().takeIf { Regex("^(?:[01]\\d|2[0-3]):00$").matches(it) }
        hour?.take(2)?.toIntOrNull()?.let { it <= context.cutoffHour }
            ?: (parseDateBucket(bucket)?.let { !it.isAfter(context.cutoffDate) } == true)
    }
}

private fun comparisonMatchesRange(comparison: UsageComparison, range: RangeKey): Boolean {
    val kind = comparison.window.kind.lowercase(Locale.ROOT).replace("_", "")
    return when (range) {
        RangeKey.Today -> kind == "dayoverday"
        RangeKey.Week -> kind == "weekoverweek"
        RangeKey.Month -> kind == "monthovermonth"
        RangeKey.Year, RangeKey.All -> false
        RangeKey.Custom -> kind == "periodoverperiod"
    }
}

private fun shareTitle(range: RangeKey): String = when (range) {
    RangeKey.Today -> "我的 AI 协作日报"
    RangeKey.Week -> "我的 AI 协作周报"
    RangeKey.Month -> "我的 AI 协作月报"
    RangeKey.Year -> "我的 AI 协作年报"
    RangeKey.All -> "AI 协作里程碑"
    RangeKey.Custom -> "我的 AI 协作复盘"
}

private fun sharePeriodLabel(
    range: RangeKey,
    comparison: UsageComparison?,
    sourceDate: LocalDate?,
    sourceZone: ZoneId?
): String {
    if (sourceDate == null || sourceZone == null) {
        return when (range) {
            RangeKey.Today -> "来源日期不可得"
            RangeKey.Week -> "本周 · 来源截止不可得"
            RangeKey.Month -> "本月 · 来源截止不可得"
            RangeKey.Year -> "今年 · 来源截止不可得"
            RangeKey.All -> "累计 · 来源截止不可得"
            RangeKey.Custom -> "自定义区间 · 来源截止不可得"
        }
    }
    val matchingComparison = comparison?.takeIf { comparisonMatchesRange(it, range) }
    val start = matchingComparison?.window?.currentStart.toSourceDateOrNull(sourceZone)
    val end = matchingComparison?.window?.currentEnd.toSourceDateOrNull(sourceZone)
        ?.coerceAtMost(sourceDate)
    return when (range) {
        RangeKey.Today -> formatChineseDate(sourceDate)
        RangeKey.Week -> if (start != null && end != null) {
            "${start.monthValue}月${start.dayOfMonth}日—${end.monthValue}月${end.dayOfMonth}日"
        } else {
            "截至 ${formatChineseDate(sourceDate)}"
        }
        RangeKey.Month -> if (start != null && end != null) {
            "${start.year}年${start.monthValue}月 · 截至${end.dayOfMonth}日"
        } else {
            "${sourceDate.year}年${sourceDate.monthValue}月"
        }
        RangeKey.Year -> "${sourceDate.year}年 · 截至${sourceDate.monthValue}月${sourceDate.dayOfMonth}日"
        RangeKey.All -> "累计至 ${formatChineseDate(sourceDate)}"
        RangeKey.Custom -> if (start != null && end != null) {
            "${start.year}年${start.monthValue}月${start.dayOfMonth}日—${end.year}年${end.monthValue}月${end.dayOfMonth}日"
        } else {
            "截至 ${formatChineseDate(sourceDate)}"
        }
    }
}

private fun String?.toSourceDateOrNull(zoneId: ZoneId): LocalDate? {
    val value = this?.trim().orEmpty()
    if (value.isEmpty()) return null
    return toInstantOrNull()?.atZone(zoneId)?.toLocalDate()
        ?: runCatching { LocalDateTime.parse(value).toLocalDate() }.getOrNull()
        ?: runCatching { LocalDate.parse(value) }.getOrNull()
}

private fun sharePoint(
    bucket: String,
    tokens: Long,
    requests: Long,
    range: RangeKey,
    context: ShareTimeContext? = null
): SharePoint {
    val date = parseDateBucket(bucket)
    return SharePoint(
        bucket = bucket,
        dateLabel = when {
            date != null -> "${date.monthValue}/${date.dayOfMonth}"
            range == RangeKey.Today || (range == RangeKey.Custom && bucket.contains(':')) -> bucket.take(5)
            else -> bucket
        },
        weekdayLabel = date?.let(::weekdayLabel),
        tokens = tokens,
        requests = requests,
        inProgress = (range == RangeKey.Today || range == RangeKey.Custom) && context != null &&
            context.cutoffHourInProgress && bucket.take(2).toIntOrNull() == context.cutoffHour
    )
}

private fun activeDatesForRange(
    stats: StatsData,
    range: RangeKey,
    points: List<SharePoint>,
    context: ShareTimeContext
): List<LocalDate> {
    if (range == RangeKey.Today || (range == RangeKey.Custom && points.any { it.bucket.contains(':') })) {
        return if (stats.summary.effectiveTokens > 0L) listOf(context.cutoffDate) else emptyList()
    }
    // comparison.current.series 是与本期 summary 同一窗口、同一筛选的稠密序列，
    // 优先用它计算周期活跃日。热力图是跨范围的日历视图，只能在同期序列缺失时后备，
    // 否则一个滞后或不同步的热力图会把本期已经存在的活跃日错误抹掉。
    val pointDates = points.asSequence()
        .filter { it.tokens > 0L }
        .mapNotNull { parseDateBucket(it.bucket) }
        .distinct()
        .sorted()
        .toList()
    if (pointDates.isNotEmpty()) return pointDates
    val heatmapDates = activeHeatmapEntries(stats, range, context).map { it.first }
    if (heatmapDates.isNotEmpty()) return heatmapDates.distinct().sorted()
    return emptyList()
}

private fun activeHeatmapEntries(
    stats: StatsData,
    range: RangeKey,
    context: ShareTimeContext
): List<Pair<LocalDate, Long>> {
    val weekStart = context.cutoffDate.minusDays((context.cutoffDate.dayOfWeek.value - 1).toLong())
    return stats.heatmap.entries.asSequence()
        .filter { it.value > 0L }
        .mapNotNull { (bucket, tokens) -> parseDateBucket(bucket)?.let { it to tokens } }
        .filter { (date) -> !date.isAfter(context.cutoffDate) }
        .filter { (date) ->
            when (range) {
                RangeKey.Today -> date == context.cutoffDate
                RangeKey.Week -> !date.isBefore(weekStart)
                RangeKey.Month -> date.year == context.cutoffDate.year && date.monthValue == context.cutoffDate.monthValue
                RangeKey.Year -> date.year == context.cutoffDate.year
                RangeKey.All -> true
                RangeKey.Custom -> true
            }
        }
        .sortedBy { it.first }
        .toList()
}

private fun heatmapPeakForRange(
    stats: StatsData,
    range: RangeKey,
    context: ShareTimeContext
): SharePoint? = activeHeatmapEntries(stats, range, context)
    .maxByOrNull { it.second }
    ?.let { (date, tokens) -> sharePoint(date.toString(), tokens, 0L, range, context) }

private fun longestDateStreak(dates: List<LocalDate>): Int {
    var longest = 0
    var current = 0
    var previous: LocalDate? = null
    dates.distinct().sorted().forEach { date ->
        current = if (previous?.plusDays(1) == date) current + 1 else 1
        longest = maxOf(longest, current)
        previous = date
    }
    return longest
}

private fun shareHighlight(
    range: RangeKey,
    activeDays: Int?,
    longestStreak: Int?,
    peak: SharePoint?
): String = when (range) {
    RangeKey.Today -> peak?.let { "今天的协作峰值出现在 ${peakLabel(it)}" }
        ?: "今天留下了一段可验证的 AI 协作轨迹"
    RangeKey.Week -> when {
        activeDays != null && activeDays > 0 -> "这周，我和 AI 并肩协作了 $activeDays 天"
        peak != null -> "本周高光落在 ${peakLabel(peak)}"
        else -> "这周留下了一段可验证的 AI 协作轨迹"
    }
    RangeKey.Month -> when {
        activeDays != null && activeDays > 0 -> "这个月已有 $activeDays 天留下协作记录"
        else -> "这个月留下了一段可验证的 AI 协作轨迹"
    }
    RangeKey.Year -> when {
        longestStreak != null && longestStreak > 1 -> "今年最长连续记录 $longestStreak 天"
        activeDays != null && activeDays > 0 -> "今年已有 $activeDays 个活跃协作日"
        else -> "今年的 AI 协作记录仍在积累"
    }
    RangeKey.All -> when {
        activeDays != null && activeDays > 0 -> "已有 $activeDays 天写入我的 AI 协作账本"
        else -> "每一次协作，都在累积成个人里程碑"
    }
    RangeKey.Custom -> when {
        activeDays != null && activeDays > 0 -> "这段区间有 $activeDays 个活跃协作日"
        peak != null -> "区间高光落在 ${peakLabel(peak)}"
        else -> "这段区间留下了一段可验证的 AI 协作轨迹"
    }
}

private fun peakLabel(point: SharePoint): String {
    val date = parseDateBucket(point.bucket)
    val label = when {
        point.bucket.matches(Regex("^\\d{1,2}:\\d{2}")) -> point.bucket.take(5)
        date != null -> "${weekdayLabel(date)} · ${formatCompactTokens(point.tokens)}"
        else -> point.dateLabel
    }
    return if (point.inProgress) "$label（进行中）" else label
}

private fun weekdayLabel(date: LocalDate): String = when (date.dayOfWeek.value) {
    1 -> "周一"
    2 -> "周二"
    3 -> "周三"
    4 -> "周四"
    5 -> "周五"
    6 -> "周六"
    else -> "周日"
}

private fun formatChineseDate(date: LocalDate): String =
    "${date.year}年${date.monthValue}月${date.dayOfMonth}日"

private fun parseDateBucket(value: String?): LocalDate? {
    val source = value?.trim().orEmpty()
    if (!Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(source)) return null
    return runCatching { LocalDate.parse(source) }.getOrNull()
}

private fun sumNonNegativeLongsOrNull(values: Collection<Long>): Long? {
    var sum = 0L
    for (value in values) {
        if (value < 0L) return null
        sum = runCatching { Math.addExact(sum, value) }.getOrNull() ?: return null
    }
    return sum
}
