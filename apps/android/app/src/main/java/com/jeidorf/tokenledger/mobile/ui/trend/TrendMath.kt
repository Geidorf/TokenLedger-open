package com.jeidorf.tokenledger.mobile.ui.trend

import com.jeidorf.tokenledger.mobile.SmoothCurvePoint
import kotlin.math.max

internal data class TrendDataBarFractions(
    val current: Float,
    val previous: Float
)

internal fun normalizedDataBarFraction(value: Long, sharedMaximum: Long): Float {
    if (sharedMaximum <= 0L) return 0f
    return (value.coerceAtLeast(0L).toDouble() / sharedMaximum)
        .toFloat()
        .coerceIn(0f, 1f)
}

internal fun normalizedDataBarFraction(value: Double, sharedMaximum: Double): Float {
    if (!sharedMaximum.isFinite() || sharedMaximum <= 0.0) return 0f
    if (!value.isFinite() || value <= 0.0) return 0f
    return (value / sharedMaximum).toFloat().coerceIn(0f, 1f)
}

internal fun trendDataBarFractions(
    currentTokens: Long,
    previousTokens: Long,
    sharedMaximum: Long
): TrendDataBarFractions {
    return TrendDataBarFractions(
        current = normalizedDataBarFraction(currentTokens, sharedMaximum),
        previous = normalizedDataBarFraction(previousTokens, sharedMaximum)
    )
}

internal fun trendDataBarFractions(
    currentCost: Double,
    previousCost: Double,
    sharedMaximum: Double
): TrendDataBarFractions {
    return TrendDataBarFractions(
        current = normalizedDataBarFraction(currentCost, sharedMaximum),
        previous = normalizedDataBarFraction(previousCost, sharedMaximum)
    )
}

/** 同期曲线与游标使用同一条时间轴，避免不等长序列分别占满横向空间。 */
internal fun sharedTrendSlotCount(currentSize: Int, previousSize: Int): Int =
    max(currentSize, previousSize)

internal fun trendChartX(index: Int, slotCount: Int, left: Float, right: Float): Float =
    if (slotCount <= 1) left else left + (right - left) * index / (slotCount - 1f)

/**
 * 把一条曲线映射到与同期另一条曲线共用的横轴上。
 *
 * `values` 的每个点都按共用的 [slotCount] 定位，绝不能改用 `values.size`：
 * 两条长度不等的序列各自拉满全宽，会出现今日 17 点与昨日 23 点同 x 的"两把时间尺"。
 */
internal fun trendChartPoints(
    values: List<Float>,
    slotCount: Int,
    left: Float,
    right: Float,
    top: Float,
    bottom: Float,
    minimum: Float,
    maximum: Float
): List<SmoothCurvePoint> = values.mapIndexed { index, value ->
    val x = trendChartX(index, slotCount, left, right)
    val normalized = ((value - minimum) / (maximum - minimum).coerceAtLeast(1f)).coerceIn(0f, 1f)
    val y = bottom - (bottom - top) * normalized
    SmoothCurvePoint(x, y)
}
