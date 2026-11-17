package com.jeidorf.tokenledger.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ToolCostSemanticsTest {
    private fun parsedTool(cost: Any? = null, present: Boolean = false): ToolStat {
        val tool = JSONObject().put("input", 10).put("output", 2).put("total", 12).put("requests", 1)
        if (present) tool.put("cost", cost ?: JSONObject.NULL)
        return StatsJson.parse(
            JSONObject()
                .put("summary", StatsJson.summaryToJson(Summary()))
                .put("tools", JSONObject().put("fixture", tool))
                .toString()
        ).tools.getValue("fixture")
    }

    @Test
    fun missingNullAndInvalidToolCostsAreUnknownButZeroIsKnown() {
        assertNull(parsedTool().cost)
        assertNull(parsedTool(null, present = true).cost)
        listOf(-1.0, "NaN", "Infinity", "-Infinity", "1e999", "invalid", true).forEach { raw ->
            assertNull("invalid cost: $raw", parsedTool(raw, present = true).cost)
        }
        assertEquals(0.0, parsedTool(0, present = true).cost)
        assertEquals(1.25, parsedTool(1.25, present = true).cost)
    }

    @Test
    fun entityToolConversionDoesNotReplaceUnknownCostWithZero() {
        listOf(null, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, -1.0).forEach { cost ->
            assertNull(CompositionEntry(value = "fixture", tokens = 12, cost = cost).toToolStat().cost)
        }
        assertEquals(0.0, CompositionEntry(value = "fixture", tokens = 12, cost = 0.0).toToolStat().cost)
        assertEquals(1.25, CompositionEntry(value = "fixture", tokens = 12, cost = 1.25).toToolStat().cost)
    }

    @Test
    fun cacheRoundTripPreservesZeroAndSanitizesUnknownToolCosts() {
        val key = DashboardCacheKey("fixture-user", RangeKey.Today, DashboardQuery.ALL_MACHINES, "UTC")
        val base = StatsJson.parse(JSONObject().put("summary", StatsJson.summaryToJson(Summary())).toString())
        val template = parsedTool()
        listOf(null, Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, -1.0, 0.0, 1.25).forEach { cost ->
            val snapshot = DashboardCachedSnapshot(base.copy(tools = mapOf("fixture" to template.copy(cost = cost))), 123L)
            val encoded = DashboardSnapshotJson.encode(key, snapshot, DashboardCacheWriteMetadata("fixture", 1L))
            val decoded = requireNotNull(DashboardSnapshotJson.decode(encoded, key))
            val expected = cost?.takeIf { it.isFinite() && it >= 0.0 }
            assertEquals(expected, decoded.stats.tools.getValue("fixture").cost)
        }
    }

    @Test
    fun unknownToolCostIsNotDisplayedAsZero() {
        val unknown = parsedTool().cost
        assertEquals(VALUE_UNAVAILABLE, formatCostForDisplay(unknown, 7.0, false, CurrencyUnit.USD))
        assertEquals("$0.00", formatCostForDisplay(parsedTool(0, true).cost, 7.0, false, CurrencyUnit.USD))
    }
}
