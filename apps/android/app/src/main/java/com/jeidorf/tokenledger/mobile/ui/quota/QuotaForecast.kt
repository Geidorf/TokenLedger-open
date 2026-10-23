package com.jeidorf.tokenledger.mobile.ui.quota

import com.jeidorf.tokenledger.mobile.QuotaCapability
import com.jeidorf.tokenledger.mobile.QuotaWindowSnapshot
import java.time.Instant
import java.time.OffsetDateTime

/**
 * 额度用尽预测（重构 R3），与桌面 `src/utils/quotaPace.ts` 同一套规则，规格见
 * docs/design/forecast-and-pace-v1.md §3.1–§3.2。只读 Quota v1 窗口已有字段，不写回快照。
 *
 * 「照此速度」指窗口开始到**观测时刻**的平均速度：已用比例对应的是 observedAt，不是此刻，
 * 用此刻会把同一份快照的速度越算越慢。
 */

/** 只有 stable 与 plan-dependent 来源的窗口时长与重置时间可信；experimental 的时间线由推断得到。 */
internal fun quotaCapabilityTrustsTimeline(capability: QuotaCapability): Boolean =
    capability == QuotaCapability.Stable || capability == QuotaCapability.PlanDependent

/**
 * 照此速度会比重置早多少分钟用完；不满足资格、不会提前用完或已经用完时返回 null。
 * 调用方只在窗口状态为 Ok、数值为百分比进度时调用，[usedFraction] 为观测时的已用比例。
 */
internal fun quotaForecastShortfallMinutes(
    window: QuotaWindowSnapshot,
    capability: QuotaCapability,
    usedFraction: Double,
    now: Instant
): Long? {
    if (!quotaCapabilityTrustsTimeline(capability)) return null
    val windowMs = window.windowMinutes?.takeIf { it > 0 }?.let { it * MINUTE_MS } ?: return null
    val reset = parseInstant(window.resetsAt)?.toEpochMilli() ?: return null
    val observed = parseInstant(window.observedAt)?.toEpochMilli() ?: return null
    val fetched = parseInstant(window.fetchedAt)?.toEpochMilli()

    // §3.1 第 4 条：reset 精度按时间戳推断最粗的一种，超过窗口时长 5% 不预测。
    val precisionMs = inferResetPrecisionMs(reset, listOfNotNull(observed, fetched))
    if (precisionMs > windowMs * MAX_RESET_PRECISION_FRACTION) return null

    // 第 5 条：已过重置或观测过期，不从历史快照外推。
    val nowMs = now.toEpochMilli()
    if (reset <= nowMs || nowMs >= observed + window.staleAfterSeconds * 1_000L) return null

    // 第 6 条：观测须落在 [窗口起点 − 容差, resetsAt) 内。
    val start = reset - windowMs
    val tolerance = maxOf(TIMELINE_TOLERANCE_MIN_MS, (windowMs * TIMELINE_TOLERANCE_FRACTION).toLong())
    if (observed < start - tolerance || observed >= reset) return null

    // 第 7 条：已经用完不是「提前用完」的预测。
    if (usedFraction <= 0.0 || usedFraction >= 1.0) return null

    // 第 8 条：至少过去窗口的 10%，多日窗口另需一整天。
    val elapsed = observed - start
    val minElapsed = maxOf(
        (windowMs * MIN_ELAPSED_FRACTION).toLong(),
        if (windowMs > DAY_MS) DAY_MS else 0L
    )
    if (elapsed <= 0L || elapsed < minElapsed) return null

    // §3.2：用完时刻 = observedAt + (1 − used) / (used / e)。
    val exhaustsAt = observed + (1.0 - usedFraction) * elapsed / usedFraction
    val shortfallMinutes = Math.round((reset - exhaustsAt) / MINUTE_MS)
    return shortfallMinutes.takeIf { it >= 1L }
}

/** 与桌面 `inferResetPrecisionSeconds` 相同：reset 与基准时刻之差恰为整天 / 整小时 / 整分钟时取该单位。 */
internal fun inferResetPrecisionMs(reset: Long, bases: List<Long>): Long {
    var coarsest = 0L
    for (base in bases) {
        val difference = reset - base
        if (difference <= 0L) continue
        val unit = RESET_PRECISION_UNITS_MS.firstOrNull { difference % it == 0L }
        if (unit != null) coarsest = maxOf(coarsest, unit)
    }
    return coarsest
}

private fun parseInstant(raw: String?): Instant? = raw?.let {
    runCatching { OffsetDateTime.parse(it).toInstant() }.getOrNull()
}

private const val MINUTE_MS = 60_000L
private const val DAY_MS = 24L * 60L * MINUTE_MS
private const val MIN_ELAPSED_FRACTION = 0.1
private const val MAX_RESET_PRECISION_FRACTION = 0.05
private const val TIMELINE_TOLERANCE_MIN_MS = 5L * MINUTE_MS
private const val TIMELINE_TOLERANCE_FRACTION = 0.01
private val RESET_PRECISION_UNITS_MS = listOf(DAY_MS, 60L * MINUTE_MS, MINUTE_MS)
