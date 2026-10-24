package com.jeidorf.tokenledger.mobile.ui.split

import com.jeidorf.tokenledger.mobile.CompositionEntry
import com.jeidorf.tokenledger.mobile.ModelStat
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.Summary
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ToolStat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UsageSplitTest {
    private fun stats(machines: List<CompositionEntry>? = null) = StatsData(
        summary = Summary(inputTokens = 400, outputTokens = 50, cachedTokens = 500, totalCost = 2.0, totalRequests = 6),
        tools = mapOf(
            "Codex" to ToolStat("Codex", input = 100, output = 20, cached = 500, total = 620, cost = 0.5, requests = 4),
            "Claude Code" to ToolStat("Claude Code", input = 300, output = 30, cached = 0, total = 330, cost = 1.5, requests = 2)
        ),
        models = mapOf(
            "m-a" to ModelStat("m-a", total = 120, requests = 4, input = 100, output = 20, cost = null),
            "m-b" to ModelStat("m-b", total = 330, requests = 2, input = 300, output = 30, cost = 1.5)
        ),
        trends = emptyList(),
        heatmap = emptyMap(),
        history = emptyList(),
        machines = emptyList(),
        meta = null,
        machineDistribution = machines
    )

    private fun available(result: SplitResult) = result as SplitResult.Available

    @Test
    fun agentRowsSortByMetricAndFollowTokenMode() {
        val byTokens = available(splitUsage(stats(), SplitDimension.Agent, SplitMetric.Tokens, TokenDisplayMode.Effective, false))
        assertEquals(listOf("Claude Code", "Codex"), byTokens.rows.map { it.name })
        assertEquals(450.0, byTokens.total!!, 0.0)

        val withCache = available(splitUsage(stats(), SplitDimension.Agent, SplitMetric.Tokens, TokenDisplayMode.All, false))
        assertEquals(listOf("Codex", "Claude Code"), withCache.rows.map { it.name })

        val byRequests = available(splitUsage(stats(), SplitDimension.Agent, SplitMetric.Requests, TokenDisplayMode.Effective, false))
        assertEquals("Codex", byRequests.rows.first().name)
        assertEquals(4.0 / 6.0 * 100.0, byRequests.sharePercent(byRequests.rows.first(), SplitMetric.Requests)!!, 1e-9)
    }

    @Test
    fun unknownModelCostSortsLastAndIsCounted() {
        val result = available(splitUsage(stats(), SplitDimension.Model, SplitMetric.Cost, TokenDisplayMode.Effective, false))
        assertEquals(listOf("m-b", "m-a"), result.rows.map { it.name })
        assertEquals(1, result.unknownCount)
        // 分母是汇总费用，不把已知的 1.5 归一成 100%。
        assertEquals(2.0, result.total!!, 0.0)
        assertEquals(75.0, result.sharePercent(result.rows.first(), SplitMetric.Cost)!!, 1e-9)
        assertNull(result.sharePercent(result.rows.last(), SplitMetric.Cost))
    }

    @Test
    fun unknownSummaryCostLeavesTotalAndSharesUnavailable() {
        val unknown = stats().copy(summary = Summary(totalCost = Double.NaN, totalRequests = 6))
        val result = available(splitUsage(unknown, SplitDimension.Model, SplitMetric.Cost, TokenDisplayMode.Effective, false))
        assertNull(result.total)
        assertNull(result.sharePercent(result.rows.first(), SplitMetric.Cost))
    }

    @Test
    fun deviceDimensionStatesWhyItIsUnavailable() {
        assertEquals(
            SplitResult.Unavailable(SPLIT_DEVICE_MISSING),
            splitUsage(stats(), SplitDimension.Device, SplitMetric.Tokens, TokenDisplayMode.Effective, false)
        )
        val one = listOf(CompositionEntry("pc", tokens = 10, inputTokens = 8, outputTokens = 2, requests = 1, cost = 0.1))
        assertEquals(
            SplitResult.Unavailable(SPLIT_DEVICE_SINGLE),
            splitUsage(stats(one), SplitDimension.Device, SplitMetric.Tokens, TokenDisplayMode.Effective, false)
        )
        assertEquals(
            SplitResult.Unavailable(SPLIT_DEVICE_FILTERED),
            splitUsage(stats(one), SplitDimension.Device, SplitMetric.Tokens, TokenDisplayMode.Effective, true)
        )
    }

    @Test
    fun deviceRowsKeepUnknownEffectiveTokensAsUnknown() {
        val machines = listOf(
            CompositionEntry("pc", tokens = 10, inputTokens = 8, outputTokens = 2, requests = 1, cost = 0.1),
            CompositionEntry("mac", tokens = 99, requests = 3, cost = null, effectiveTokensAvailable = false)
        )
        val result = available(splitUsage(stats(machines), SplitDimension.Device, SplitMetric.Tokens, TokenDisplayMode.Effective, false))
        assertEquals(listOf("pc", "mac"), result.rows.map { it.name })
        assertNull(result.rows.last().tokens)
        assertEquals(1, result.unknownCount)
    }

    @Test
    fun accountDimensionIsNeverInventedFromCloudData() {
        val result = splitUsage(stats(), SplitDimension.Account, SplitMetric.Tokens, TokenDisplayMode.Effective, false)
        assertTrue(result is SplitResult.Unavailable)
        assertEquals(SPLIT_ACCOUNT_UNAVAILABLE, (result as SplitResult.Unavailable).reason)
    }
}
