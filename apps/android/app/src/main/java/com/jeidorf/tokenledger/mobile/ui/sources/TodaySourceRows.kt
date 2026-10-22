package com.jeidorf.tokenledger.mobile.ui.sources

import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ToolStat
import com.jeidorf.tokenledger.mobile.assignToolChartSlots
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.safeTokenAdd
import com.jeidorf.tokenledger.mobile.ui.foundation.LEDGER_CHART_SLOT_OTHER
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Share
import com.jeidorf.tokenledger.mobile.v2FormatTokens

/**
 * 今日「主要来源」：前 [limit] 名各一行，其余并成「其他」。
 * 身份色走 [assignToolChartSlots]；「其他」固定中性槽，不拿工具名去哈希。
 * 点名进行进工具专属看板；「其他」不冒充某个工具。
 */
internal data class TodaySourceRowModel(
    val name: String,
    val tokens: Long,
    val tokensLabel: String,
    val share: String,
    val slot: Int,
    val opensEntity: Boolean
)

internal fun todaySourceRows(
    tools: Collection<ToolStat>,
    mode: TokenDisplayMode,
    displayedTotal: Long,
    limit: Int = 3
): List<TodaySourceRowModel> {
    val ranked = tools.sortedByDescending { displayedTokenCount(mode, it.effectiveTokens, it.cached) }
    val topCount = limit.coerceAtLeast(1)
    val top = ranked.take(topCount)
    val rest = ranked.drop(topCount)
    val denominator = displayedTotal.coerceAtLeast(0L)
    val slots = assignToolChartSlots(top.map { it.name })
    val rows = top.mapIndexed { index, tool ->
        val tokens = displayedTokenCount(mode, tool.effectiveTokens, tool.cached)
        TodaySourceRowModel(
            name = tool.name,
            tokens = tokens,
            tokensLabel = v2FormatTokens(tokens),
            share = v2Share(tokens, denominator),
            slot = slots[index],
            opensEntity = true
        )
    }
    if (rest.isEmpty()) return rows
    val restTokens = rest.fold(0L) { sum, tool ->
        safeTokenAdd(sum, displayedTokenCount(mode, tool.effectiveTokens, tool.cached))
    }
    return rows + TodaySourceRowModel(
        name = "其他",
        tokens = restTokens,
        tokensLabel = v2FormatTokens(restTokens),
        share = v2Share(restTokens, denominator),
        slot = LEDGER_CHART_SLOT_OTHER,
        opensEntity = false
    )
}
