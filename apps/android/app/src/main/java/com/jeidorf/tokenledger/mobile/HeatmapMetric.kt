package com.jeidorf.tokenledger.mobile

import java.math.BigDecimal
import java.util.Locale
import org.json.JSONObject

/**
 * 日历热力图的着色指标（契约 dashboard-stats-v2 §2.6）。有效 Token 一定有；记录数与费用
 * 是两个各自独立的可选字段，缺失就是不可得，不按 0 补，也不从别的字段推算。
 */
internal enum class HeatmapMetric(val label: String, val emptyLabel: String) {
    Tokens("有效 Token", "无消耗"),
    Requests("记录数", "无记录"),
    Cost("费用", "无费用")
}

/** 费用按微美元存进日历格的 Long，好与 Token、记录数共用同一套分位色阶。 */
internal const val HEATMAP_COST_MICROS_PER_USD = 1_000_000.0

/** 日历格数值的文字；数据类而不是函数，axis 仍能按值比较。 */
internal data class HeatmapValueFormat(
    val metric: HeatmapMetric = HeatmapMetric.Tokens,
    val currency: CurrencyUnit = CurrencyUnit.DEFAULT
) {
    fun format(value: Long): String = when (metric) {
        HeatmapMetric.Tokens -> v2FormatTokens(value)
        HeatmapMetric.Requests -> String.format(Locale.ROOT, "%,d 条", value)
        HeatmapMetric.Cost -> formatCostForDisplay(value / HEATMAP_COST_MICROS_PER_USD, currency = currency)
    }
}

/** 指标不可得时日历卡上的说明。 */
internal fun heatmapMetricUnavailableReason(metric: HeatmapMetric): String = when (metric) {
    HeatmapMetric.Tokens -> "当前范围没有可信的日期覆盖"
    HeatmapMetric.Requests -> "云端还没有逐日记录数（需要部署最新的云端函数），先看有效 Token"
    HeatmapMetric.Cost -> "这段时间有日子缺少估价，或云端还没部署逐日费用；不画费用热力，免得把缺失当成 0"
}

/** 选中指标的逐日数值；该指标不可得时返回 null。 */
internal fun heatmapMetricValues(
    metric: HeatmapMetric,
    tokens: Map<String, Long>,
    requests: Map<String, Long>?,
    cost: Map<String, Double>?
): Map<String, Long>? = when (metric) {
    HeatmapMetric.Tokens -> tokens
    HeatmapMetric.Requests -> requests
    HeatmapMetric.Cost -> cost?.mapValues { (_, usd) -> Math.round(usd * HEATMAP_COST_MICROS_PER_USD) }
}

/**
 * 严格读 `heatmapRequests`：日期键必须与同一对象的 `heatmap` 完全一致，值是正整数。
 * 任何一处不合规就整项丢弃，不拿部分天当完整结果。
 */
internal fun parseHeatmapRequests(raw: JSONObject?, heatmap: Map<String, Long>): Map<String, Long>? {
    if (raw == null || !raw.hasSameKeys(heatmap)) return null
    return raw.keys().asSequence().associateWith { key ->
        val number = raw.opt(key) as? Number ?: return null
        val exact = runCatching { BigDecimal(number.toString()).longValueExact() }.getOrNull() ?: return null
        if (exact <= 0L) return null
        exact
    }
}

/** 严格读 `heatmapCost`（美元）：键与 `heatmap` 一致，值为非负有限数；否则整项丢弃。 */
internal fun parseHeatmapCost(raw: JSONObject?, heatmap: Map<String, Long>): Map<String, Double>? {
    if (raw == null || !raw.hasSameKeys(heatmap)) return null
    return raw.keys().asSequence().associateWith { key ->
        val value = (raw.opt(key) as? Number)?.toDouble() ?: return null
        if (!value.isFinite() || value < 0.0 || value * HEATMAP_COST_MICROS_PER_USD >= Long.MAX_VALUE) return null
        value
    }
}

private fun JSONObject.hasSameKeys(heatmap: Map<String, Long>): Boolean =
    length() == heatmap.size && keys().asSequence().all(heatmap::containsKey)
