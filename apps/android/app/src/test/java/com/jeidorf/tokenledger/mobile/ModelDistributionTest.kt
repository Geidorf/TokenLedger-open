package com.jeidorf.tokenledger.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelDistributionTest {
    private fun model(
        name: String,
        cost: Double? = 1.0,
        input: Long = 100,
        output: Long = 100,
        cached: Long = 0,
        cacheRead: Long? = null,
        cacheWrite: Long? = null
    ) = ModelStat(
        name = name,
        total = input + output + cached,
        requests = 1,
        input = input,
        output = output,
        cached = cached,
        cost = cost,
        cacheRead = cacheRead,
        cacheWrite = cacheWrite
    )

    @Test
    fun sortsModelsByCostDescendingAndComputesShare() {
        val rows = modelCostDistribution(
            listOf(
                model("cheap", cost = 1.0),
                model("expensive", cost = 9.0)
            )
        )
        assertEquals(listOf("expensive", "cheap"), rows.map { it.model.name })
        assertEquals(90.0, requireNotNull(rows[0].costSharePercent), 1e-9)
        assertEquals(10.0, requireNotNull(rows[1].costSharePercent), 1e-9)
        assertEquals(200L, rows[0].effectiveTokens)
    }

    @Test
    fun keepsKnownFreeModelsDistinctFromMissingRows() {
        val rows = modelCostDistribution(
            listOf(
                model("empty", cost = 0.0, input = 0, output = 0, cached = 0),
                model("real", cost = 2.0, input = 10, output = 20)
            )
        )
        assertEquals(listOf("real", "empty"), rows.map { it.model.name })
        assertEquals(0.0, rows.last().cost)
    }

    @Test
    fun usesSummaryCostAsDenominatorAndKeepsUnallocatedShareVisible() {
        val rows = modelCostDistribution(
            listOf(
                model("primary", cost = 60.0),
                model("secondary", cost = 20.0),
                model("unknown", cost = null, input = 50, output = 0)
            ),
            summaryTotalCost = 100.0
        )

        assertEquals(60.0, requireNotNull(rows.first { it.model.name == "primary" }.costSharePercent), 1e-9)
        assertEquals(20.0, requireNotNull(rows.first { it.model.name == "secondary" }.costSharePercent), 1e-9)
        assertNull(rows.first { it.model.name == "unknown" }.costSharePercent)
    }

    @Test
    fun keepsCacheOnlyModelsAndSortsUnknownCostsByEffectiveTokens() {
        val rows = modelCostDistribution(
            listOf(
                model("cache-only", cost = null, input = 0, output = 0, cached = 100),
                model("small-unknown", cost = null, input = 1, output = 1),
                model("large-unknown", cost = null, input = 20, output = 10)
            )
        )

        assertEquals(
            listOf("large-unknown", "small-unknown", "cache-only"),
            rows.map { it.model.name }
        )
    }

    @Test
    fun costPrivacyAlsoMasksShareAndHistoryUsesCombinedCacheOnce() {
        assertEquals("占比已隐藏", modelCostShareLabel(costMasked = true, sharePercent = 90.0))
        assertEquals("90%", modelCostShareLabel(costMasked = false, sharePercent = 90.0))

        val detail = LogHistoryItem(
            id = 1,
            tool = "codex",
            model = "gpt",
            inputTokens = 60,
            outputTokens = 40,
            cachedTokens = 30,
            cacheWriteTokens = 10,
            cost = 1.0,
            timestamp = "2026-09-01 10:00:00",
            sessionId = "s",
            machineId = "m"
        )
        assertEquals(100L, displayedHistoryTokenCount(TokenDisplayMode.Effective, detail))
        assertEquals(130L, displayedHistoryTokenCount(TokenDisplayMode.All, detail))
    }

    @Test
    fun derivedModelMetricsNeverWrapLongOrDoubleOverflow() {
        val overflow = ModelStat(
            name = "overflow",
            total = Long.MAX_VALUE,
            requests = 1,
            input = Long.MAX_VALUE,
            output = 1,
            cached = 1,
            cost = 1.0,
            cacheRead = 1,
            cacheWrite = 0
        )
        val row = modelCostDistribution(listOf(overflow)).single()
        assertNull(row.effectiveTokens)
        assertNull(row.cacheReusePercent)
        assertNull(modelCacheBreakdown(overflow).totalTokens)
        assertEquals(Long.MAX_VALUE, overflow.effectiveTokens)

        val costOverflowRows = modelCostDistribution(
            listOf(model("a", cost = Double.MAX_VALUE), model("b", cost = Double.MAX_VALUE))
        )
        assertTrue(costOverflowRows.all { it.costSharePercent == null })
    }

    @Test
    fun breakdownUsesReadWriteSplitWhenPresent() {
        val breakdown = modelCacheBreakdown(
            model("m", input = 200, output = 50, cached = 1300, cacheRead = 800, cacheWrite = 500)
        )
        assertTrue(breakdown.hasReadWriteSplit)
        assertEquals(
            listOf("input", "output", "cacheRead", "cacheWrite"),
            breakdown.segments.map { it.kind }
        )
        assertEquals(80.0, breakdown.reusePercent!!, 1e-9)
    }

    @Test
    fun breakdownFallsBackToCombinedWhenSplitAbsent() {
        val breakdown = modelCacheBreakdown(
            model("m", input = 200, output = 50, cached = 1300)
        )
        assertFalse(breakdown.hasReadWriteSplit)
        assertEquals(
            listOf("input", "output", "cacheCombined"),
            breakdown.segments.map { it.kind }
        )
        assertNull(breakdown.reusePercent)
    }

    @Test
    fun sharedFixturePreservesUnknownAndZeroCostAndOnlyAcceptsProvenSplit() {
        val stats = StatsJson.parse(fixture("unknown-cost-cache-provenance-v2.json"))
        val rows = modelCostDistribution(stats.models.values.toList(), stats.summary.totalCost)

        assertEquals(
            listOf("explicit-split", "inconsistent-cache-split", "known-free", "unknown-cost-combined-cache"),
            rows.map { it.model.name }
        )
        assertEquals(0.0, rows.first { it.model.name == "known-free" }.cost)
        assertNull(rows.first { it.model.name == "unknown-cost-combined-cache" }.cost)
        assertEquals(0.0, rows.first { it.model.name == "known-free" }.costSharePercent)
        assertNull(rows.first { it.model.name == "unknown-cost-combined-cache" }.costSharePercent)

        val explicit = modelCacheBreakdown(stats.models.getValue("explicit-split"))
        assertTrue(explicit.hasReadWriteSplit)
        assertEquals(listOf(80L, 20L), explicit.segments.takeLast(2).map { it.tokens })

        val convertedExplicit = stats.models.getValue("explicit-split").toCompositionEntry().toModelStat()
        assertEquals(80L, convertedExplicit.cacheRead)
        assertEquals(20L, convertedExplicit.cacheWrite)

        listOf("unknown-cost-combined-cache", "inconsistent-cache-split").forEach { name ->
            val source = stats.models.getValue(name)
            val breakdown = modelCacheBreakdown(source)
            assertFalse(breakdown.hasReadWriteSplit)
            assertEquals("cacheCombined", breakdown.segments.last().kind)
            assertNull(breakdown.reusePercent)
            val converted = source.toCompositionEntry().toModelStat()
            assertNull(converted.cacheRead)
            assertNull(converted.cacheWrite)
        }
    }

    @Test
    fun mixedOrNegativeCacheFieldsNeverInferTheMissingSide() {
        listOf(
            model("write-only", cached = 100, cacheWrite = 20),
            model("read-only", cached = 100, cacheRead = 80),
            model("negative", cached = 100, cacheRead = -1, cacheWrite = 101)
        ).forEach { source ->
            val breakdown = modelCacheBreakdown(source)
            assertFalse(breakdown.hasReadWriteSplit)
            assertEquals("cacheCombined", breakdown.segments.last().kind)
            assertNull(breakdown.reusePercent)
        }
    }

    private fun fixture(name: String): String {
        val resource = checkNotNull(javaClass.classLoader?.getResource("dashboard-stats-v2/$name")) {
            "Missing shared dashboard fixture: $name"
        }
        return resource.readText()
    }

    private fun ModelStat.toCompositionEntry(): CompositionEntry = CompositionEntry(
        value = name,
        tokens = total,
        inputTokens = input,
        outputTokens = output,
        cachedTokens = cached,
        cacheWriteTokens = cacheWrite,
        requests = requests,
        cost = cost,
        cacheReadTokens = cacheRead
    )
}
