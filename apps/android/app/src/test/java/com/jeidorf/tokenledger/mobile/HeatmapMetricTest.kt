package com.jeidorf.tokenledger.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class HeatmapMetricTest {
    private val heatmap = mapOf("2026-09-01" to 1_000L, "2026-09-02" to 0L)

    @Test
    fun requestsAndCostParseWhenKeysMatchHeatmap() {
        val requests = parseHeatmapRequests(JSONObject("""{"2026-09-01":12,"2026-09-02":0}"""), heatmap)
        val cost = parseHeatmapCost(JSONObject("""{"2026-09-01":0.123456,"2026-09-02":0}"""), heatmap)
        assertEquals(mapOf("2026-09-01" to 12L, "2026-09-02" to 0L), requests)
        assertEquals(0.123456, cost!!.getValue("2026-09-01"), 0.0)
    }

    @Test
    fun anyInvalidDayDropsTheWholeField() {
        listOf(
            """{"2026-09-01":12}""",
            """{"2026-09-01":12,"2026-09-02":0,"2026-09-03":1}""",
            """{"2026-09-01":12,"2026-09-03":0}""",
            """{"2026-09-01":1.5,"2026-09-02":0}""",
            """{"2026-09-01":-1,"2026-09-02":0}""",
            """{"2026-09-01":"12","2026-09-02":0}"""
        ).forEach { raw -> assertNull(raw, parseHeatmapRequests(JSONObject(raw), heatmap)) }
        listOf(
            """{"2026-09-01":-0.5,"2026-09-02":0}""",
            """{"2026-09-01":0.5}""",
            """{"2026-09-01":null,"2026-09-02":0}"""
        ).forEach { raw -> assertNull(raw, parseHeatmapCost(JSONObject(raw), heatmap)) }
        assertNull(parseHeatmapRequests(null, heatmap))
        assertNull(parseHeatmapCost(null, heatmap))
    }

    @Test
    fun statsJsonReadsEachFieldIndependently() {
        val stats = StatsJson.parse(
            """{"summary":{"totalTokens":1000,"inputTokens":800,"outputTokens":200,"cachedTokens":0,"totalCost":0.1,"totalRequests":12,"avgTokensPerReq":83},
               "heatmap":{"2026-09-01":1000,"2026-09-02":0},
               "heatmapRequests":{"2026-09-01":12,"2026-09-02":0}}"""
        )
        assertNotNull(stats.heatmapRequests)
        assertNull(stats.heatmapCost)
    }

    @Test
    fun metricValuesConvertCostToMicrosAndReportMissing() {
        assertEquals(heatmap, heatmapMetricValues(HeatmapMetric.Tokens, heatmap, null, null))
        assertNull(heatmapMetricValues(HeatmapMetric.Requests, heatmap, null, mapOf("2026-09-01" to 1.0)))
        assertNull(heatmapMetricValues(HeatmapMetric.Cost, heatmap, heatmap, null))
        assertEquals(
            mapOf("2026-09-01" to 123_456L),
            heatmapMetricValues(HeatmapMetric.Cost, heatmap, null, mapOf("2026-09-01" to 0.123456))
        )
    }

    @Test
    fun calendarAxisUsesSelectedMetricAndExplainsMissingOne() {
        val selection = DashboardQuery(range = RangeKey.Year)
        val state = CalendarHeatmapUiState.Available(
            heatmap = heatmap, query = selection, selectionQuery = selection,
            timezone = "Asia/Shanghai", generatedAt = "2026-09-02T12:00:00+08:00",
            coverageStart = "2026-01-01", coverageEnd = "2026-09-02", showingCachedData = false,
            heatmapRequests = mapOf("2026-09-01" to 12L, "2026-09-02" to 0L)
        )
        val requests = buildInsightCalendarAxis(state, HeatmapValueFormat(HeatmapMetric.Requests))
        assertEquals(12L, requests.cells.single { it.date.toString() == "2026-09-01" }.knownTokens)
        assertEquals(HeatmapMetric.Requests, requests.valueFormat.metric)

        val cost = buildInsightCalendarAxis(state, HeatmapValueFormat(HeatmapMetric.Cost))
        assertEquals(heatmapMetricUnavailableReason(HeatmapMetric.Cost), cost.unavailableReason)
        assertEquals(emptyList<InsightCalendarCell>(), cost.cells)
    }

    @Test
    fun labelsFollowTheMetric() {
        val cell = InsightCalendarCell(java.time.LocalDate.parse("2026-09-01"), 1_234L, InsightCalendarCellAvailability.Covered)
        val zero = cell.copy(tokens = 0L)
        assertEquals("9月1日，1,234 条", dayAccessibilityLabel(cell, HeatmapValueFormat(HeatmapMetric.Requests)))
        assertEquals("9月1日，无记录", dayAccessibilityLabel(zero, HeatmapValueFormat(HeatmapMetric.Requests)))
        assertEquals("9月1日，无费用", dayAccessibilityLabel(zero, HeatmapValueFormat(HeatmapMetric.Cost)))
        assertEquals(
            formatCostForDisplay(0.001234, currency = CurrencyUnit.USD),
            HeatmapValueFormat(HeatmapMetric.Cost, CurrencyUnit.USD).format(1_234L)
        )
    }
}
