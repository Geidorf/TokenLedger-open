package com.jeidorf.tokenledger.mobile

import java.time.DayOfWeek
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InsightCalendarTest {
    @Test
    fun auxiliaryYearKeepsGlobalCellsAndHighlightsOnlySelectedDay() {
        val selection = DashboardQuery(range = RangeKey.Custom, start = "2026-09-03", end = "2026-09-03")
        val axis = buildInsightCalendarAxis(CalendarHeatmapUiState.Available(
            heatmap = mapOf("2026-01-01" to 42L, "2026-09-03" to 8L),
            query = selection.copy(start = "2026-01-01", end = "2026-09-08"), selectionQuery = selection,
            timezone = "Asia/Shanghai", generatedAt = "2026-09-08T12:00:00+08:00",
            coverageStart = "2026-01-01", coverageEnd = "2026-09-08", showingCachedData = false
        ))
        assertTrue(axis.isDateSelectable(date("2026-01-01")))
        assertEquals(42L, axis.cells.single { it.date == date("2026-01-01") }.knownTokens)
        assertEquals(listOf(date("2026-09-03")), axis.cells.filter { it.inQueryRange }.map { it.date })
        assertFalse(axis.isDateSelectable(date("2026-09-09")))
    }

    @Test
    fun presetsKeepGlobalHeatmapAndOnlyHighlightSelectedRange() {
        val source = stats(mapOf("2026-01-01" to 1L, "2026-09-03" to 3L))
        val starts = mapOf(RangeKey.Today to "2026-09-03", RangeKey.Week to "2026-08-31",
            RangeKey.Month to "2026-09-01", RangeKey.Year to "2026-01-01", RangeKey.All to "2026-01-01")
        starts.forEach { (range, start) ->
            val query = DashboardQuery(range = range)
            val axis = buildInsightCalendarAxis(source.withQuery(query), query)
            assertEquals(date("2026-01-01"), axis.selectableStart)
            assertEquals(date("2026-09-03"), axis.selectableEnd)
            assertTrue(axis.cells.filter { it.inQueryRange }.all { it.date >= date(start) })
            assertTrue(axis.isDateSelectable(date("2026-01-01")))
        }
    }

    @Test
    fun todayActivityRowsExcludeOtherDaysDespiteYearWire() {
        val query = DashboardQuery(range = RangeKey.Today)
        val source = stats(mapOf("2026-01-01" to 999999L, "2026-09-02" to 999L, "2026-09-03" to 3L)).withQuery(query)
        val rows = recentDailyActivityRows(source, query, false)
        assertEquals(listOf("2026-09-03"), rows.map { it.date })
        assertEquals(3L, rows.single().effectiveTokens)
    }

    @Test
    fun customCrossesYearAndBuildsCompleteWeeks() {
        val query = DashboardQuery(range = RangeKey.Custom, start = "2025-12-30", end = "2026-01-02")
        val axis = buildInsightCalendarAxis(
            stats(mapOf("2025-12-31" to 42L), "2026-01-02T12:00:00+08:00").withQuery(query), query
        )

        assertEquals(DayOfWeek.MONDAY, axis.cells.first().date.dayOfWeek)
        assertEquals(DayOfWeek.SUNDAY, axis.cells.last().date.dayOfWeek)
        assertEquals(date("2025-12-30"), axis.selectableStart)
        assertEquals(date("2026-01-02"), axis.selectableEnd)
        assertEquals(42L, axis.cells.single { it.date == date("2025-12-31") }.knownTokens)
    }

    @Test
    fun sparseWireInteriorMissingDateIsTrustedEmpty() {
        val query = DashboardQuery(range = RangeKey.Month)
        val axis = buildInsightCalendarAxis(
            stats(mapOf("2026-09-01" to 10L, "2026-09-03" to 30L)).withQuery(query), query
        )
        val empty = axis.cells.single { it.date == date("2026-09-02") }

        assertTrue(empty.selectable)
        assertEquals(0L, empty.knownTokens)
    }

    @Test
    fun paddingAndFutureDoNotExposeKnownZero() {
        val query = DashboardQuery(range = RangeKey.Today)
        val axis = buildInsightCalendarAxis(stats(emptyMap()).withQuery(query), query)

        // 全局覆盖内、查询范围外仍可用；它不高亮。
        val before = axis.cells.single { it.date == date("2026-09-02") }
        assertTrue(before.selectable)
        assertFalse(before.inQueryRange)
        assertEquals(0L, before.knownTokens)
        // 真正不该暴露 0 的是未来日。
        val future = axis.cells.single { it.date == date("2026-09-04") }
        assertEquals(InsightCalendarCellAvailability.Future, future.availability)
        assertNull(future.knownTokens)
        assertFalse(future.selectable)
    }

    @Test
    fun comparisonCutoffWinsAndUsesDeclaredTimezone() {
        val query = DashboardQuery(range = RangeKey.Today)
        val source = stats(emptyMap(), "2026-09-05T12:00:00+08:00").withQuery(query).copy(
            comparison = comparison("2026-09-03T16:30:00Z", "Asia/Shanghai")
        )

        assertEquals(date("2026-09-04"), buildInsightCalendarAxis(source, query).cutoffDate)
    }

    @Test
    fun missingConflictingOrMismatchedMetadataFailsClosed() {
        val year = DashboardQuery(range = RangeKey.Year)
        assertFalse(buildInsightCalendarAxis(stats(emptyMap()).copy(meta = null), year).isTrusted)

        val timezoneConflict = stats(emptyMap()).copy(
            comparison = comparison("2026-09-03T12:00:00+08:00", "UTC")
        )
        assertEquals("响应日历时区不一致", buildInsightCalendarAxis(timezoneConflict, year).unavailableReason)
        assertEquals(
            "响应查询范围与全局范围不一致",
            buildInsightCalendarAxis(stats(emptyMap()), DashboardQuery(range = RangeKey.Month)).unavailableReason
        )
    }

    @Test
    fun eligibilityUsesTrustedBoundaryAndNoDeviceClock() {
        val query = DashboardQuery(range = RangeKey.Week)
        val source = stats(emptyMap()).withQuery(query)

        // 点击按全局可信底图覆盖判断；所选本周只影响高亮。
        assertTrue(insightCalendarDateEligibility(source, query, date("2026-01-01")).selectable)
        assertTrue(insightCalendarDateEligibility(source, query, date("2026-08-30")).selectable)
        assertTrue(insightCalendarDateEligibility(source, query, date("2026-09-03")).selectable)
        assertFalse(insightCalendarDateEligibility(source, query, date("2025-12-31")).selectable)
        assertFalse(insightCalendarDateEligibility(source, query, date("2026-09-04")).selectable)
    }

    @Test
    fun customFutureEndClipsAtTrustedCutoff() {
        val query = DashboardQuery(range = RangeKey.Custom, start = "2026-09-01", end = "2026-09-10")
        val axis = buildInsightCalendarAxis(stats(emptyMap()).withQuery(query), query)

        assertEquals(date("2026-09-03"), axis.selectableEnd)
        assertFalse(axis.isDateSelectable(date("2026-09-04")))
    }

    @Test
    fun postgresLocalTimestampFormsRemainSupported() {
        val query = DashboardQuery(range = RangeKey.Year)
        assertEquals(
            date("2026-07-14"),
            buildInsightCalendarAxis(stats(emptyMap(), "2026-07-14T23:59:59").withQuery(query), query).cutoffDate
        )
        assertEquals(
            date("2026-07-14"),
            buildInsightCalendarAxis(stats(emptyMap(), "2026-07-14 23:59:59").withQuery(query), query).cutoffDate
        )
    }

    @Test
    fun customRangeLabelShowsSingleDayAndInterval() {
        assertEquals("2026-09-03", dashboardRangeLabel(DashboardQuery(range = RangeKey.Custom, start = "2026-09-03", end = "2026-09-03")))
        assertEquals(
            "2026-09-01 至 2026-09-03",
            dashboardRangeLabel(DashboardQuery(range = RangeKey.Custom, start = "2026-09-01", end = "2026-09-03"))
        )
    }

    private fun date(raw: String) = LocalDate.parse(raw)

    private fun StatsData.withQuery(query: DashboardQuery): StatsData = copy(
        meta = meta?.copy(
            range = query.range.rpcValue,
            query = StatsQueryEcho(query.range.rpcValue, "Asia/Shanghai", start = query.start, end = query.end)
        )
    )

    private fun stats(
        heatmap: Map<String, Long>,
        generatedAt: String = "2026-09-03T12:00:00+08:00"
    ) = StatsData(
        Summary(), emptyMap(), emptyMap(), emptyList(), heatmap, emptyList(), emptyList(),
        StatsMeta(
            generatedAt, null, "Asia/Shanghai", "year", null, false, 2,
            StatsQueryEcho("year", "Asia/Shanghai")
        )
    )

    private fun comparison(end: String, timezone: String) = UsageComparison(
        ComparisonWindow("periodOverPeriod", timezone, "day", null, end, null, null, null),
        ComparisonPeriod(Summary(), emptyList()),
        ComparisonPeriod(Summary(), emptyList()),
        ComparisonDelta(
            MetricDelta(0.0, null, "flat"), MetricDelta(0.0, null, "flat"), MetricDelta(0.0, null, "flat")
        )
    )
}
