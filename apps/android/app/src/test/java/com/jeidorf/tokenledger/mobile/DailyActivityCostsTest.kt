package com.jeidorf.tokenledger.mobile

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DailyActivityCostsTest {
    private val query = DashboardQuery(range = RangeKey.Month)
    private fun fixture(): StatsData = StatsJson.parse(File("../../../fixtures/dashboard-stats-v2/daily-costs-v2.json").readText())
    private fun rows(stats: StatsData = fixture(), selected: DashboardQuery = query, masked: Boolean = false) =
        recentDailyActivityRows(stats, selected, masked, exchangeRate = 7.2)

    @Test fun todayDoesNotBorrowYearActivityOutsideDailyCostCoverage() {
        val base = fixture()
        val selected = DashboardQuery(range = RangeKey.Today)
        val source = base.copy(meta = base.meta!!.copy(range = "today", query = StatsQueryEcho("today", "Asia/Shanghai")),
            comparison = null,
            heatmap = base.heatmap + ("2026-01-01" to 9999L),
            dailyCosts = base.dailyCosts!!.copy(coverage = base.dailyCosts.coverage.copy(start = "2026-07-15"),
                days = base.dailyCosts.days.filter { it.date == "2026-07-15" }))
        val actual = rows(source, selected)
        assertEquals(listOf("2026-07-15"), actual.map { it.date })
        assertEquals("¥5.98", actual.single().amount.text)
    }

    @Test fun mapsSameResponseByDateAndKeepsEffectiveTokens() {
        val actual = rows()
        assertEquals(listOf("2026-07-15", "2026-07-14"), actual.map { it.date })
        assertEquals(listOf(400L, 500L), actual.map { it.effectiveTokens })
        assertEquals(listOf("¥5.98", "¥3.02"), actual.map { it.amount.text })
        assertEquals(listOf(0.8f, 1f), actual.map { it.fraction })
    }

    @Test fun usesCalendarIntersectionExcludesFutureAndLimitsRecentTen() {
        val base = fixture()
        val heatmap = (1..20).associate { "2026-07-%02d".format(it) to it.toLong() } +
            mapOf("2025-12-31" to 99L, "2026-06-30" to 88L, "2026-07-03" to 0L)
        val actual = rows(base.copy(heatmap = heatmap))
        assertEquals(10, actual.size)
        assertEquals("2026-07-15", actual.first().date)
        assertEquals("2026-07-06", actual.last().date)
        assertFalse(actual.any { it.date > "2026-07-15" })
    }

    @Test fun missingPartialLegacyAndUnmatchedAmountsStayUnavailable() {
        val base = fixture()
        val costs = requireNotNull(base.dailyCosts)
        listOf(
            base.copy(dailyCosts = null),
            base.copy(legacyRpc = true),
            base.copy(dailyCosts = costs.copy(coverage = costs.coverage.copy(state = DailyCostsCoverageState.Partial))),
            base.copy(dailyCosts = costs.copy(days = emptyList())),
            base.copy(dailyCosts = costs.copy(days = costs.days + costs.days))
        ).forEach { stats -> assertTrue(rows(stats).all { it.amount.text == "不可得" }) }
        DailyCostUnavailableReason.entries.forEach { reason ->
            val unavailable = costs.days.map { it.copy(status = DailyCostStatus.Unavailable, amountUsd = null, reason = reason) }
            assertTrue(rows(base.copy(dailyCosts = costs.copy(days = unavailable))).all { it.amount.text == "不可得" })
        }
    }

    @Test fun fullFilterIdentityMustMatchNotOnlyRange() {
        listOf(query.copy(machines = listOf("another")), query.copy(tools = listOf("codex")),
            query.copy(models = listOf("model")), query.copy(search = "session"))
            .forEach { selected -> assertTrue(rows(selected = selected).all { it.amount.text == "不可得" }) }
        val base = fixture()
        assertTrue(rows(base.copy(meta = base.meta!!.copy(entity = DashboardEntity("tool", "codex"))))
            .all { it.amount.text == "不可得" })
    }

    @Test fun equivalentCanonicalFiltersKeepAmounts() {
        val base = fixture()
        val echo = base.meta!!.query!!.copy(machines = listOf("a", "b"), tools = listOf("codex"))
        val stats = base.copy(meta = base.meta.copy(query = echo))
        assertEquals("¥5.98", rows(stats, query.copy(machines = listOf("b", "a", "a"), tools = listOf(" codex "))).first().amount.text)
    }

    @Test fun malformedOptionalWireKeepsOldCoreButNeverShowsAmount() {
        listOf("future-status", "unavailable").forEach { status ->
            val raw = JSONObject(File("../../../fixtures/dashboard-stats-v2/daily-costs-v2.json").readText())
            raw.getJSONObject("dailyCosts").getJSONArray("days").getJSONObject(0).put("status", status)
            val stats = StatsJson.parse(raw.toString())
            assertEquals(900L, stats.summary.effectiveTokens)
            assertTrue(rows(stats).all { it.amount.text == "不可得" })
        }
    }

    @Test fun untrustedCalendarAndOtherRangeDoNotInventActivity() {
        assertTrue(rows(fixture().copy(meta = null)).isEmpty())
        assertTrue(rows(selected = query.copy(range = RangeKey.Week)).isEmpty())
        assertTrue(rows(fixture().copy(heatmap = emptyMap())).isEmpty())
    }

    @Test fun positiveSmallValuesNeverRoundToZeroInEitherCurrency() {
        assertEquals("<¥0.01", dailyAmountLabel(0.0001, false, exchangeRate = 7.2).text)
        assertEquals("预估费用不足0.01元", dailyAmountLabel(0.0001, false, exchangeRate = 7.2).accessibility)
        assertEquals("预估费用8,888.83元", dailyAmountLabel(1234.56, false, exchangeRate = 7.2).accessibility)
        assertEquals("<$0.01", dailyAmountLabel(0.009, false, CurrencyUnit.USD).text)
        assertEquals("$0.01", dailyAmountLabel(0.01, false, CurrencyUnit.USD).text)
        assertEquals("¥8,888.83", dailyAmountLabel(1234.56, false, exchangeRate = 7.2).text)
    }

    @Test fun invalidOrLegacyZeroAndInvalidConversionStayUnavailable() {
        listOf(null, 0.0, -1.0, Double.NaN, Double.POSITIVE_INFINITY).forEach {
            assertEquals("不可得", dailyAmountLabel(it, false).text)
            // 读屏念全称（T10.154 §4.1 末行）。
            assertEquals("预估费用不可得", dailyAmountLabel(it, false).accessibility)
        }
        listOf(0.0, -1.0, Double.NaN, Double.POSITIVE_INFINITY).forEach {
            assertEquals("不可得", dailyAmountLabel(1.0, false, exchangeRate = it).text)
        }
        assertEquals("不可得", dailyAmountLabel(Double.MAX_VALUE, false, exchangeRate = 7.2).text)
        assertEquals("$1.00", dailyAmountLabel(1.0, false, CurrencyUnit.USD, Double.NaN).text)
    }

    @Test fun maskingProjectsAwayAllRawAmountsBeforeRendering() {
        listOf(null, 0.0, 0.0001, 123456.78, Double.NaN).forEach { amount ->
            val label = dailyAmountLabel(amount, true, exchangeRate = Double.NaN)
            assertEquals(DailyAmountLabel("¥***.*", "预估费用已隐藏"), label)
        }
        assertTrue(rows(masked = true).all { it.amount == DailyAmountLabel("¥***.*", "预估费用已隐藏") })
        assertEquals("$***.*", dailyAmountLabel(0.8, true, CurrencyUnit.USD).text)
    }
}
