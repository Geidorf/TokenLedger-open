package com.jeidorf.tokenledger.mobile.ui.hero

import com.jeidorf.tokenledger.mobile.ComparisonSeriesPoint
import com.jeidorf.tokenledger.mobile.MetricDelta
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.Summary
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.UsageComparison
import com.jeidorf.tokenledger.mobile.comparisonKindPresentation
import com.jeidorf.tokenledger.mobile.formatChangePercent
import com.jeidorf.tokenledger.mobile.formatSignedInteger
import com.jeidorf.tokenledger.mobile.ui.foundation.v2CacheHit
import com.jeidorf.tokenledger.mobile.ui.foundation.v2SignedNumber
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import java.time.LocalDate

/**
 * 今日主卡的纯展示（T10.173 §4.5、§7.1，并入 C6 / Q3 推荐项 B）。
 *
 * 变化胶囊只有四种说法，且不带颜色：有百分比、新增、基线缺失、无自动基线。
 * 云端「上期全 0 仍不可证明」的判定属于 C2，本包不改比较语义：比较对象缺失才写
 * 「无自动基线」，`direction = new` 写「新增」，百分比缺失写「基线缺失」；已给出的百分比照常显示。
 * Android 概览不放缓存净节省。
 */
internal enum class HeroBaselineKind { Percent, New, Missing, NoAuto }

internal data class HeroChangeCapsule(
    val kind: HeroBaselineKind,
    val text: String,
    /** 仅百分比胶囊使用；持平与后三种说法不画箭头。 */
    val arrowUp: Boolean?
)

internal data class TodaySecondaryMetric(
    val label: String,
    val value: String,
    val note: String
)

internal const val TODAY_SECONDARY_SLOT_COUNT = 3

internal fun heroChangeCapsule(comparison: UsageComparison?, delta: MetricDelta?): HeroChangeCapsule {
    if (comparison == null) return HeroChangeCapsule(HeroBaselineKind.NoAuto, "无自动基线", null)
    if (delta == null) return HeroChangeCapsule(HeroBaselineKind.Missing, "基线缺失", null)
    if (delta.direction == "new") return HeroChangeCapsule(HeroBaselineKind.New, "新增", null)
    val percent = delta.percent
    if (percent == null || !percent.isFinite()) return HeroChangeCapsule(HeroBaselineKind.Missing, "基线缺失", null)
    val text = formatChangePercent(percent)
    val arrowUp = if (text == "0.0%" || text == "不可得") null else percent > 0.0
    return HeroChangeCapsule(HeroBaselineKind.Percent, text, arrowUp)
}

internal fun heroBaselineCaption(comparison: UsageComparison?): String? =
    comparison?.let { comparisonKindPresentation(it.window.kind).heroBaselineLabel }

/** 有效口径写输入 / 输出；含缓存口径写有效 / 缓存。有效 Token 仍是输入 + 输出。 */
internal fun heroTokenSubline(summary: Summary, mode: TokenDisplayMode): String = when (mode) {
    TokenDisplayMode.All ->
        "有效 ${v2FormatTokens(summary.effectiveTokens)} · 缓存 ${v2FormatTokens(summary.cachedTokens)}"
    TokenDisplayMode.Effective ->
        "输入 ${v2FormatTokens(summary.inputTokens)} · 输出 ${v2FormatTokens(summary.outputTokens)}"
}

/**
 * 三格固定槽位：活跃、缓存复用率、记录数。缺数据的槽留空，不把旁边的格子拉宽。
 * 记录数始终占第三格（0 是真实的 0）。缓存拆分不可证明时第二格留空，且任何一格都不写缓存净节省。
 */
internal fun todayMetricStrip(stats: StatsData): List<TodaySecondaryMetric?> {
    val slots = listOf(activeMetric(stats), cacheReuseMetric(stats.summary), recordMetric(stats))
    check(slots.size == TODAY_SECONDARY_SLOT_COUNT)
    return slots
}

internal fun todayTrendActionLabel(peak: String?): String =
    if (peak.isNullOrBlank()) "查看趋势" else "查看趋势 · 峰值 $peak"

/** 峰值时钟取桶上已经写明的时刻或日期，不按设备时区重算。没有时刻也没有日期时不编一个。 */
internal fun todayPeakLabel(stats: StatsData): String? {
    val peak = stats.comparison?.current?.series
        ?.maxWithOrNull(compareBy<ComparisonSeriesPoint> { it.tokens }.thenBy { it.bucket })
        ?.takeIf { it.tokens > 0L }
        ?: return null
    return peakClockLabel(peak.bucket)
}

internal fun peakClockLabel(bucket: String): String? {
    val text = bucket.trim()
    Regex("""^(\d{1,2}):(\d{2})$""").matchEntire(text)?.let { match ->
        val hour = match.groupValues[1].toIntOrNull() ?: return null
        val minute = match.groupValues[2].toIntOrNull() ?: return null
        if (hour !in 0..23 || minute !in 0..59) return null
        return "%02d:%02d".format(hour, minute)
    }
    Regex("""T(\d{2}):(\d{2})""").find(text)?.let { match ->
        return "${match.groupValues[1]}:${match.groupValues[2]}"
    }
    Regex("""^\d{4}-(\d{2})-(\d{2})$""").matchEntire(text)?.let { match ->
        return "${match.groupValues[1]}-${match.groupValues[2]}"
    }
    return null
}

private fun activeMetric(stats: StatsData): TodaySecondaryMetric? {
    val comparison = stats.comparison
    val series = comparison?.current?.series.orEmpty()
    if (comparison != null && series.isNotEmpty()) {
        val hourly = comparison.window.bucket.equals("hour", ignoreCase = true) ||
            series.all { peakClockLabel(it.bucket)?.contains(':') == true && !it.bucket.contains('-') }
        val active = series.count { it.tokens > 0L }
        val previous = comparison.previous.series
        val previousActive = previous.count { it.tokens > 0L }
        val deltaNote = if (previous.isEmpty()) "" else activeDeltaNote(active - previousActive, if (hourly) "小时" else "天")
        return if (hourly) {
            TodaySecondaryMetric("活跃时段", "$active/${series.size} 小时", deltaNote)
        } else {
            val note = listOf(deltaNote, provenStreakNote(stats.heatmap)).filter { it.isNotBlank() }.joinToString(" · ")
            TodaySecondaryMetric("活跃天数", "$active/${series.size} 天", note)
        }
    }
    return activeFromHeatmap(stats)
}

private fun activeFromHeatmap(stats: StatsData): TodaySecondaryMetric? {
    val days = completeHeatmap(stats.heatmap) ?: return null
    if (days.isEmpty()) return null
    val active = days.values.count { it > 0L }
    return TodaySecondaryMetric("活跃天数", "$active/${days.size} 天", streakNoteFromDays(days))
}

private fun activeDeltaNote(delta: Int, unit: String): String =
    if (delta == 0) "" else "${formatSignedInteger(delta.toLong())} $unit"

/**
 * 热力覆盖必须从最早一天到最晚一天每天都有键，才写连续天数。
 * 连续段伸到覆盖的第一天时只给下界「≥ N 天」。
 */
internal fun provenStreakNote(heatmap: Map<String, Long>): String {
    val days = completeHeatmap(heatmap) ?: return ""
    return streakNoteFromDays(days)
}

private fun streakNoteFromDays(days: Map<LocalDate, Long>): String {
    if (days.isEmpty()) return ""
    val earliest = days.keys.min()
    val latest = days.keys.max()
    var cursor = if ((days[latest] ?: 0L) > 0L) latest else latest.minusDays(1)
    if (cursor < earliest || (days[cursor] ?: 0L) <= 0L) return ""
    var count = 0
    while (cursor >= earliest && (days[cursor] ?: 0L) > 0L) {
        count++
        cursor = cursor.minusDays(1)
    }
    if (count == 0) return ""
    return if (cursor < earliest) "≥ $count 天" else "连续 $count 天"
}

private fun completeHeatmap(heatmap: Map<String, Long>): Map<LocalDate, Long>? {
    if (heatmap.isEmpty()) return emptyMap()
    val parsed = LinkedHashMap<LocalDate, Long>(heatmap.size)
    for ((key, tokens) in heatmap) {
        val date = runCatching { LocalDate.parse(key.trim().take(10)) }.getOrNull() ?: return null
        if (parsed.put(date, tokens) != null) return null
    }
    val earliest = parsed.keys.min()
    val latest = parsed.keys.max()
    var day = earliest
    while (!day.isAfter(latest)) {
        if (day !in parsed) return null
        day = day.plusDays(1)
    }
    return parsed
}

/** 拆分不可证明时不占格。副行只写缓存读，不写净节省、毛节省或金额。 */
internal fun cacheReuseMetric(summary: Summary): TodaySecondaryMetric? {
    val rate = v2CacheHit(summary)
    if (rate == "—" || rate == "不可得") return null
    if (!summary.cacheSplitKnown || summary.cacheReadTokens < 0L) return null
    return TodaySecondaryMetric("缓存复用率", rate, "缓存读 ${v2FormatTokens(summary.cacheReadTokens)}")
}

private fun recordMetric(stats: StatsData): TodaySecondaryMetric =
    TodaySecondaryMetric("记录数", v2FormatNumber(stats.summary.totalRequests), recordNote(stats))

private fun recordNote(stats: StatsData): String {
    val comparison = stats.comparison ?: return ""
    val delta = comparison.delta.requests
    return when (heroChangeCapsule(comparison, delta).kind) {
        HeroBaselineKind.New -> "新增"
        HeroBaselineKind.Percent -> {
            val base = comparisonKindPresentation(comparison.window.kind).heroBaselineLabel
            "$base ${v2SignedNumber(delta.absolute)}"
        }
        HeroBaselineKind.Missing, HeroBaselineKind.NoAuto -> ""
    }
}
