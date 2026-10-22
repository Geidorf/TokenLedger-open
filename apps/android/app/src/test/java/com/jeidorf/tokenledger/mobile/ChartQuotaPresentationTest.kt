package com.jeidorf.tokenledger.mobile

import java.io.File
import org.junit.Assert.*
import org.junit.Test

class ChartQuotaPresentationTest {
    private fun fixture() = StatsJson.parse(File("../../../fixtures/dashboard-stats-v2/complete-v2.json").readText())

    @Test fun trendKeepsUnpairedBucketsInsteadOfDroppingCurrentData() {
        val stats = fixture()
        val comparison = requireNotNull(stats.comparison)
        val points = (1..10).map { ComparisonSeriesPoint("2026-07-${it.toString().padStart(2, '0')}", it.toLong(), 2, .1) }
        val input = stats.copy(comparison = comparison.copy(current = comparison.current.copy(series = points), previous = comparison.previous.copy(series = emptyList())))
        val rows = trendTableRows(input, ReportMetricMode.Tokens)
        assertEquals(8, rows.size)
        assertEquals("2026-07-03", rows.first().bucket)
        assertTrue(rows.all { it.previous == null })
        assertEquals("上一周期数据不可得", trendAvailabilityMessage(input.comparison, input.trends, ReportMetricMode.Tokens))
        assertEquals("不可得", trendTableValue(rows.first().previous, ReportMetricMode.Tokens, CurrencyUnit.USD, false))
    }

    @Test fun absentCurrentAndAbsentComparisonAreDifferentFromKnownZero() {
        val stats = fixture()
        val comparison = requireNotNull(stats.comparison)
        val empty = comparison.copy(current = comparison.current.copy(series = emptyList()))
        assertEquals("当前范围暂无费用趋势", trendAvailabilityMessage(empty, emptyList(), ReportMetricMode.Cost))
        val zero = comparison.copy(current = comparison.current.copy(series = listOf(ComparisonSeriesPoint("00:00", 0, 0, 0.0))))
        assertNull(trendAvailabilityMessage(zero, emptyList(), ReportMetricMode.Cost))
        assertTrue(trendTableRows(stats.copy(comparison = null), ReportMetricMode.Cost).isEmpty())
        val fallback = stats.copy(comparison = null, trends = listOf(TrendPoint("2026-07-15 02:00:00", mapOf("codex" to 123456789L, "__requests" to 2))))
        val row = trendTableRows(fallback, ReportMetricMode.Tokens).single()
        assertEquals("123,456,789 有效 Token", trendTableValue(row.current, ReportMetricMode.Tokens, CurrencyUnit.USD, false))
        assertEquals("2026-07-15 02:00:00", row.bucket)
    }

    @Test fun costTableKeepsCurrencyAndMasksEveryAmount() {
        val point = ComparisonSeriesPoint("02:00", 0, 1, 12.34)
        assertEquals("$12.34", trendTableValue(point, ReportMetricMode.Cost, CurrencyUnit.USD, false))
        val masked = trendTableValue(point, ReportMetricMode.Cost, CurrencyUnit.USD, true)
        assertFalse(masked.contains("12.34"))
        assertTrue(masked.contains("***"))
    }
    @Test fun unequalPeriodsAlignByWindowSlotAndKeepBothOriginalBucketLabels() {
        val stats = fixture()
        val baseline = requireNotNull(stats.comparison)
        val current = listOf(ComparisonSeriesPoint("2026-09-07 01:00:00", 17, 1, .2))
        val previous = listOf(ComparisonSeriesPoint("2026-09-06 01:00:00", 13, 2, .1),
            ComparisonSeriesPoint("2026-09-06 02:00:00", 19, 3, .3))
        val input = stats.copy(comparison = baseline.copy(current = baseline.current.copy(series = current),
            previous = baseline.previous.copy(series = previous)))
        val rows = trendTableRows(input, ReportMetricMode.Tokens)
        assertEquals(2, rows.size)
        assertEquals("2026-09-07 01:00:00", rows[0].current!!.bucket)
        assertEquals("2026-09-06 01:00:00", rows[0].previous!!.bucket)
        assertEquals(17L, rows[0].current!!.tokens)
        assertEquals(13L, rows[0].previous!!.tokens)
        assertNull(rows[1].current)
        assertEquals("2026-09-06 02:00:00", rows[1].previous!!.bucket)
        assertEquals("不可得", trendTableValue(rows[1].current, ReportMetricMode.Tokens, CurrencyUnit.USD, false))
        assertEquals("19 有效 Token", trendTableValue(rows[1].previous, ReportMetricMode.Tokens, CurrencyUnit.USD, false))
    }

    @Test fun collapsedTrendRowsPreferMostRecentObservedCurrentBucketsOverFutureAlignmentRows() {
        val observed = (17..19).map { hour ->
            TrendTableRow(ComparisonSeriesPoint("${hour}:00", hour.toLong(), 1, 0.0), null)
        }
        val future = (20..23).map { hour ->
            TrendTableRow(null, ComparisonSeriesPoint("${hour}:00", hour.toLong(), 1, 0.0))
        }

        assertEquals(listOf("17:00", "18:00", "19:00"), collapsedTrendTableRows(observed + future).map { it.bucket })
    }

}
