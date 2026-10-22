package com.jeidorf.tokenledger.mobile.ui.hero

import com.jeidorf.tokenledger.mobile.CacheSavings
import com.jeidorf.tokenledger.mobile.CacheSavingsPriceBasis
import com.jeidorf.tokenledger.mobile.ComparisonDelta
import com.jeidorf.tokenledger.mobile.ComparisonPeriod
import com.jeidorf.tokenledger.mobile.ComparisonSeriesPoint
import com.jeidorf.tokenledger.mobile.ComparisonWindow
import com.jeidorf.tokenledger.mobile.MetricDelta
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.Summary
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ToolStat
import com.jeidorf.tokenledger.mobile.UsageComparison
import com.jeidorf.tokenledger.mobile.assignToolChartSlots
import com.jeidorf.tokenledger.mobile.ui.foundation.LEDGER_CHART_SLOT_OTHER
import com.jeidorf.tokenledger.mobile.ui.foundation.v2CacheHit
import com.jeidorf.tokenledger.mobile.ui.sources.todaySourceRows
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TodayHeroPresentationTest {
    @Test
    fun changeCapsuleUsesFourNeutralPhrases() {
        val comparison = comparison(tokens = MetricDelta(10.0, 8.2, "up"))
        val up = heroChangeCapsule(comparison, comparison.delta.tokens)
        assertEquals(HeroBaselineKind.Percent, up.kind)
        assertEquals("+8.2%", up.text)
        assertEquals(true, up.arrowUp)

        val down = heroChangeCapsule(comparison, MetricDelta(-4.0, -3.2, "down"))
        assertEquals("−3.2%", down.text)
        assertEquals(false, down.arrowUp)

        val flat = heroChangeCapsule(comparison, MetricDelta(0.0, 0.04, "flat"))
        assertEquals("0.0%", flat.text)
        assertNull(flat.arrowUp)

        val fresh = heroChangeCapsule(comparison, MetricDelta(10.0, null, "new"))
        assertEquals(HeroBaselineKind.New, fresh.kind)
        assertEquals("新增", fresh.text)
        assertNull(fresh.arrowUp)

        val missing = heroChangeCapsule(comparison, MetricDelta(0.0, null, "flat"))
        assertEquals(HeroBaselineKind.Missing, missing.kind)
        assertEquals("基线缺失", missing.text)
        assertNull(missing.arrowUp)

        val noAuto = heroChangeCapsule(null, comparison.delta.tokens)
        assertEquals(HeroBaselineKind.NoAuto, noAuto.kind)
        assertEquals("无自动基线", noAuto.text)
        assertNull(noAuto.arrowUp)
        assertNull(heroBaselineCaption(null))
        assertEquals("较昨日同期", heroBaselineCaption(comparison))
    }

    @Test
    fun metricStripKeepsThreeSlotsAndOmitsUnprovenCache() {
        val withCache = stats(summary = provenSummary(), comparison = hourlyComparison())
        val full = todayMetricStrip(withCache)
        assertEquals(TODAY_SECONDARY_SLOT_COUNT, full.size)
        assertEquals(listOf("活跃时段", "缓存复用率", "记录数"), full.map { it?.label })
        assertEquals("2/3 小时", full[0]?.value)
        assertEquals(v2CacheHit(provenSummary()), full[1]?.value)
        assertEquals("缓存读 ${v2FormatTokens(216_400L)}", full[1]?.note)
        assertEquals(v2FormatNumber(3_127L), full[2]?.value)
        assertTrue(full[2]?.note.orEmpty().contains("较昨日同期"))

        val unknownCache = todayMetricStrip(stats(summary = Summary(totalRequests = 4L), comparison = null))
        assertEquals(TODAY_SECONDARY_SLOT_COUNT, unknownCache.size)
        assertNull(unknownCache[0])
        assertNull(unknownCache[1])
        assertEquals("记录数", unknownCache[2]?.label)
        assertEquals("", unknownCache[2]?.note)

        val spoken = full.joinToString(" ") { metric ->
            listOfNotNull(metric?.label, metric?.value, metric?.note).joinToString(" ")
        }
        assertFalse(spoken.contains("净节省"))
        assertFalse(spoken.contains("12.40"))
    }

    @Test
    fun streakOnlyWhenHeatmapCoverageIsComplete() {
        assertEquals("≥ 3 天", provenStreakNote(mapOf(
            "2026-07-13" to 1L,
            "2026-07-14" to 2L,
            "2026-07-15" to 3L
        )))
        assertEquals("连续 2 天", provenStreakNote(mapOf(
            "2026-07-13" to 0L,
            "2026-07-14" to 2L,
            "2026-07-15" to 3L
        )))
        assertEquals("", provenStreakNote(mapOf(
            "2026-07-13" to 1L,
            "2026-07-15" to 3L
        )))
    }

    @Test
    fun trendActionNamesThePeakWithoutInventingAClock() {
        val stats = stats(comparison = hourlyComparison())
        assertEquals("10:00", todayPeakLabel(stats))
        assertEquals("查看趋势 · 峰值 10:00", todayTrendActionLabel(todayPeakLabel(stats)))
        assertEquals("查看趋势", todayTrendActionLabel(null))
        assertEquals("13:05", peakClockLabel("2026-07-15T13:05:00+08:00"))
        assertEquals("07-15", peakClockLabel("2026-07-15"))
        assertNull(peakClockLabel("25:00"))
        assertEquals(
            "输入 ${v2FormatTokens(920_000L)} · 输出 ${v2FormatTokens(360_000L)}",
            heroTokenSubline(provenSummary(), TokenDisplayMode.Effective)
        )
        assertTrue(heroTokenSubline(provenSummary(), TokenDisplayMode.All).startsWith("有效 "))
    }

    @Test
    fun sourceRowsKeepTopThreeAndNeutralRemainder() {
        val tools = listOf(
            tool("codex", 500L),
            tool("claude", 400L),
            tool("pi", 300L),
            tool("antigravity", 200L),
            tool("grok", 100L)
        )
        val rows = todaySourceRows(tools, TokenDisplayMode.Effective, displayedTotal = 1_500L, limit = 3)
        assertEquals(listOf("codex", "claude", "pi", "其他"), rows.map { it.name })
        assertEquals(assignToolChartSlots(listOf("codex", "claude", "pi")), rows.take(3).map { it.slot })
        assertEquals(LEDGER_CHART_SLOT_OTHER, rows.last().slot)
        assertEquals(300L, rows.last().tokens)
        assertTrue(rows.take(3).all { it.opensEntity })
        assertFalse(rows.last().opensEntity)

        val collided = todaySourceRows(
            listOf(tool("codex", 10L), tool("marvis", 9L)),
            TokenDisplayMode.Effective,
            displayedTotal = 19L,
            limit = 3
        )
        assertEquals(listOf(2, 3), collided.map { it.slot })
        assertEquals(listOf("codex", "marvis"), collided.map { it.name })
    }

    private fun provenSummary() = Summary(
        inputTokens = 920_000L,
        outputTokens = 360_000L,
        cachedTokens = 248_400L,
        cacheReadTokens = 216_400L,
        cacheWriteTokens = 32_000L,
        totalRequests = 3_127L,
        cacheSavings = CacheSavings(
            readSavedUsd = 12.40,
            writePremiumUsd = 1.0,
            netSavedUsd = 12.40,
            fallbackPricedReadTokens = 0L,
            fallbackPricedWriteTokens = 0L,
            priceBasis = CacheSavingsPriceBasis.LocalPrices
        )
    )

    private fun stats(
        summary: Summary = provenSummary(),
        comparison: UsageComparison? = null,
        heatmap: Map<String, Long> = emptyMap()
    ) = StatsData(
        summary = summary,
        tools = emptyMap(),
        models = emptyMap(),
        trends = emptyList(),
        heatmap = heatmap,
        history = emptyList(),
        machines = emptyList(),
        meta = null,
        comparison = comparison
    )

    private fun hourlyComparison(): UsageComparison = comparison(
        tokens = MetricDelta(200.0, 12.4, "up"),
        requests = MetricDelta(348.0, 12.5, "up"),
        series = listOf(
            ComparisonSeriesPoint("09:00", tokens = 0L, requests = 0L, cost = 0.0),
            ComparisonSeriesPoint("10:00", tokens = 700L, requests = 2L, cost = 0.2),
            ComparisonSeriesPoint("11:00", tokens = 100L, requests = 1L, cost = 0.1)
        ),
        previous = listOf(
            ComparisonSeriesPoint("09:00", tokens = 50L, requests = 1L, cost = 0.0)
        )
    )

    private fun comparison(
        tokens: MetricDelta,
        requests: MetricDelta = MetricDelta(1.0, 1.0, "up"),
        series: List<ComparisonSeriesPoint> = emptyList(),
        previous: List<ComparisonSeriesPoint> = emptyList()
    ) = UsageComparison(
        window = ComparisonWindow(
            kind = "dayOverDay",
            timezone = "Asia/Shanghai",
            bucket = "hour",
            currentStart = "2026-07-15T00:00:00+08:00",
            currentEnd = "2026-07-15T11:00:00+08:00",
            previousStart = "2026-07-14T00:00:00+08:00",
            previousEnd = "2026-07-14T11:00:00+08:00",
            alignedThrough = "11:00"
        ),
        current = ComparisonPeriod(summary = Summary(), series = series),
        previous = ComparisonPeriod(summary = Summary(), series = previous),
        delta = ComparisonDelta(
            tokens = tokens,
            requests = requests,
            cost = MetricDelta(0.2, 4.0, "up")
        )
    )

    private fun tool(name: String, tokens: Long) = ToolStat(
        name = name,
        input = tokens,
        output = 0L,
        cached = 0L,
        total = tokens,
        cost = 0.0,
        requests = 1L
    )
}
