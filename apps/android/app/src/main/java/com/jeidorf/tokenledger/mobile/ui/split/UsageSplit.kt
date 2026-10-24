package com.jeidorf.tokenledger.mobile.ui.split

import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.isKnownCost

/** 用量拆分的维度，与桌面「用量拆分」同名同序。 */
internal enum class SplitDimension(val label: String) {
    Agent("Agent"),
    Model("模型"),
    Device("设备"),
    Account("账号")
}

/** 拆分指标：Token 跟随概览的 Token 口径，记录数是账本行数，费用是预估。 */
internal enum class SplitMetric(val label: String) {
    Tokens("Token"),
    Requests("记录数"),
    Cost("费用")
}

/** 一行拆分结果；[tokens] 为 null 表示数据源没给出完整的输入与输出，不按 0 显示。 */
internal data class SplitRow(
    val name: String,
    val tokens: Long?,
    val requests: Long,
    val cost: Double?
) {
    fun value(metric: SplitMetric): Double? = when (metric) {
        SplitMetric.Tokens -> tokens?.toDouble()
        SplitMetric.Requests -> requests.toDouble()
        SplitMetric.Cost -> cost?.takeIf(::isKnownCost)
    }
}

internal sealed interface SplitResult {
    /** [rows] 已按所选指标降序排好；取不到值的行排在最后。[total] 是可得值之和。 */
    data class Available(
        val rows: List<SplitRow>,
        val total: Double,
        val unknownCount: Int
    ) : SplitResult

    data class Unavailable(val reason: String) : SplitResult
}

internal const val SPLIT_ACCOUNT_UNAVAILABLE =
    "账号来自桌面网关记下的供应商，只保存在那台电脑上，云端没有这份数据。在桌面「用量 › 概览」里可以按账号拆分。"
internal const val SPLIT_DEVICE_MISSING = "云端这次没有返回设备分布，下拉刷新后再看。"
internal const val SPLIT_DEVICE_FILTERED = "已按设备筛选，清除设备筛选后才能按设备拆分。"
internal const val SPLIT_DEVICE_SINGLE = "只有一台设备上传过这段时间的数据，按设备拆分没有可比的项。"

/**
 * 把一份云端统计按 [dimension] 拆开。Agent 与模型来自 `tools` / `models`，设备来自
 * `machineDistribution`；账号（网关供应商）云端没有，如实返回不可用，不从其他字段推断。
 */
internal fun splitUsage(
    stats: StatsData,
    dimension: SplitDimension,
    metric: SplitMetric,
    tokenMode: TokenDisplayMode,
    machineFiltered: Boolean
): SplitResult {
    val rows = when (dimension) {
        SplitDimension.Agent -> stats.tools.values.map {
            SplitRow(it.name, displayedTokenCount(tokenMode, it.effectiveTokens, it.cached), it.requests, it.cost)
        }
        SplitDimension.Model -> stats.models.values.map {
            SplitRow(it.name, displayedTokenCount(tokenMode, it.effectiveTokens, it.cached), it.requests, it.cost)
        }
        SplitDimension.Device -> {
            if (machineFiltered) return SplitResult.Unavailable(SPLIT_DEVICE_FILTERED)
            val machines = stats.machineDistribution ?: return SplitResult.Unavailable(SPLIT_DEVICE_MISSING)
            if (machines.size == 1) return SplitResult.Unavailable(SPLIT_DEVICE_SINGLE)
            machines.map { entry ->
                SplitRow(
                    entry.value,
                    entry.effectiveTokens?.let { displayedTokenCount(tokenMode, it, entry.cachedTokens) },
                    entry.requests,
                    entry.cost
                )
            }
        }
        SplitDimension.Account -> return SplitResult.Unavailable(SPLIT_ACCOUNT_UNAVAILABLE)
    }
    val sorted = rows.sortedWith(
        compareByDescending<SplitRow> { it.value(metric) ?: Double.NEGATIVE_INFINITY }.thenBy { it.name }
    )
    val known = sorted.mapNotNull { it.value(metric) }
    return SplitResult.Available(sorted, known.sum(), sorted.size - known.size)
}

/** 占比文案用的百分数（0–100）；总和为 0 或取不到值时为 null。 */
internal fun SplitResult.Available.sharePercent(row: SplitRow, metric: SplitMetric): Double? {
    val value = row.value(metric) ?: return null
    return if (total > 0.0) value / total * 100.0 else null
}
