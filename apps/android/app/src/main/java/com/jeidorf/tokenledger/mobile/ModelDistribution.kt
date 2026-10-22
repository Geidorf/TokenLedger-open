package com.jeidorf.tokenledger.mobile

/**
 * 模型金额分布与缓存拆分的纯计算层（REQ-DRILL-04）。模型费用缺失与真实 0
 * 是两种不同事实；缓存读写也只接受服务端同时给出且与合计严格一致的拆分。
 */

data class ModelCostRow(
    val model: ModelStat,
    val cost: Double?,
    val costSharePercent: Double?,
    val effectiveTokens: Long?,
    val cacheReusePercent: Double?,
    val requests: Long
)

data class ModelCacheSegment(
    val kind: String,
    val label: String,
    val tokens: Long
)

data class ModelCacheBreakdown(
    val segments: List<ModelCacheSegment>,
    val hasReadWriteSplit: Boolean,
    val reusePercent: Double?,
    val totalTokens: Long?
)

private data class ProvenModelCacheSplit(val read: Long, val write: Long)

private fun ModelStat.provenCacheSplit(): ProvenModelCacheSplit? {
    val read = cacheRead ?: return null
    val write = cacheWrite ?: return null
    if (cached < 0L || read < 0L || write < 0L) return null
    val total = runCatching { Math.addExact(read, write) }.getOrNull() ?: return null
    return if (total == cached) ProvenModelCacheSplit(read, write) else null
}

fun modelCostDistribution(
    models: List<ModelStat>,
    summaryTotalCost: Double? = null
): List<ModelCostRow> {
    val rows = models
        .map { model ->
            val inputKnown = model.input >= 0L
            val outputKnown = model.output >= 0L
            val effective = if (inputKnown && outputKnown) {
                runCatching { Math.addExact(model.input, model.output) }.getOrNull()
            } else {
                null
            }
            val cost = model.cost?.takeIf { it.isFinite() && it >= 0.0 }
            val split = model.provenCacheSplit()
            val reuse = split?.read?.let { read ->
                val denominator = if (inputKnown) {
                    runCatching { Math.addExact(model.input, read) }.getOrNull()
                } else {
                    null
                }
                denominator?.takeIf { it > 0L }?.let {
                    Math.round((read.toDouble() / it) * 1000) / 10.0
                }
            }
            ModelCostRow(model, cost, null, effective, reuse, model.requests)
        }
        .filter { row ->
            if (models.size <= 1) return@filter true
            row.cost != null ||
                (row.effectiveTokens ?: 0L) > 0L ||
                row.model.cached > 0L ||
                row.model.total > 0L
        }

    val totalKnownCost = rows.mapNotNull { it.cost }.fold(0.0) { sum, value -> sum + value }
        .takeIf(Double::isFinite)
    val totalCost = when {
        totalKnownCost == null -> null
        summaryTotalCost != null && summaryTotalCost.isFinite() && summaryTotalCost >= totalKnownCost -> {
            summaryTotalCost
        }
        else -> totalKnownCost
    }
    return rows
        .map { row ->
            row.copy(
                costSharePercent = when {
                    row.cost != null && totalCost != null && totalCost > 0.0 -> {
                        Math.round((row.cost / totalCost) * 1000) / 10.0
                    }
                    row.cost == 0.0 && totalCost == 0.0 -> 0.0
                    else -> null
                }
            )
        }
        .sortedWith { left, right ->
            when {
                left.cost == null && right.cost != null -> 1
                left.cost != null && right.cost == null -> -1
                left.cost != null && right.cost != null -> {
                    val byCost = right.cost.compareTo(left.cost)
                    if (byCost != 0) {
                        byCost
                    } else {
                        val byTokens = (right.effectiveTokens ?: 0L)
                            .compareTo(left.effectiveTokens ?: 0L)
                        if (byTokens != 0) byTokens else left.model.name.compareTo(right.model.name)
                    }
                }
                else -> {
                    val byTokens = (right.effectiveTokens ?: 0L)
                        .compareTo(left.effectiveTokens ?: 0L)
                    if (byTokens != 0) byTokens else left.model.name.compareTo(right.model.name)
                }
            }
        }
}

fun modelCacheBreakdown(model: ModelStat): ModelCacheBreakdown {
    val split = model.provenCacheSplit()
    val segments = mutableListOf(
        ModelCacheSegment("input", "未命中输入", model.input),
        ModelCacheSegment("output", "输出", model.output)
    )
    if (split != null) {
        segments.add(ModelCacheSegment("cacheRead", "命中缓存读", split.read))
        segments.add(ModelCacheSegment("cacheWrite", "缓存写", split.write))
    } else {
        segments.add(ModelCacheSegment("cacheCombined", "缓存合计", model.cached))
    }

    val reuse = split?.read?.let { read ->
        runCatching { Math.addExact(model.input, read) }.getOrNull()
            ?.takeIf { model.input >= 0L && it > 0L }
            ?.let { denominator ->
                Math.round((read.toDouble() / denominator) * 1000) / 10.0
            }
    }

    val totalTokens = runCatching {
        Math.addExact(Math.addExact(model.input, model.output), model.cached)
    }.getOrNull()

    return ModelCacheBreakdown(
        segments = segments,
        hasReadWriteSplit = split != null,
        reusePercent = reuse,
        totalTokens = totalTokens
    )
}
