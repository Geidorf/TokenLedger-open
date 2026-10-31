package com.jeidorf.tokenledger.mobile

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.OffsetDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LedgerDashboardPreviewFixtureTest {
    @Test
    fun cacheSummaryPreservesReadWriteInvariant() {
        val summary = requireNotNull(ledgerSnapshotFixture().data).summary
        assertEquals(summary.cachedTokens, summary.cacheReadTokens + summary.cacheWriteTokens)
    }

    @Test
    fun quotaFixtureIsExplicitSyntheticSnapshotWithStableWindows() {
        val quota = ledgerSnapshotFixture().quota as QuotaUiState.Available
        assertEquals(QUOTA_TRANSPORT_VERSION, quota.snapshot.transportVersion)
        assertEquals(2, quota.snapshot.providers.size)
        assertEquals(4, quota.snapshot.providers.sumOf { it.windows.size })
        assertTrue(quota.snapshot.providers.all { provider ->
            provider.windows.all { window ->
                window.providerId == provider.providerId &&
                    window.scope == provider.scope &&
                    window.displayValue() is QuotaDisplayValue.Progress
            }
        })
    }

    @Test
    fun quotaStateFixturesCoverFreshStaleErrorEmptyAndLoginRequiredSemantics() {
        val fresh = ledgerFreshQuotaSnapshotFixture().quota as QuotaUiState.Available
        val now = Instant.ofEpochMilli(fresh.evaluatedAtEpochMillis)
        assertTrue(fresh.snapshot.providers.isNotEmpty())
        assertTrue(fresh.snapshot.providers.all { provider ->
            provider.effectiveStatus(now) == QuotaProviderStatus.Ok &&
                provider.windows.all { it.effectiveStatus(now) == QuotaWindowStatus.Ok }
        })

        val stale = ledgerStaleQuotaSnapshotFixture().quota as QuotaUiState.Available
        assertEquals(QuotaProviderStatus.Stale, stale.snapshot.providers.first().status)

        val error = ledgerErrorQuotaSnapshotFixture().quota as QuotaUiState.Available
        assertEquals(QuotaProviderStatus.Error, error.snapshot.providers.single().status)
        assertTrue(error.snapshot.providers.single().windows.isEmpty())

        val empty = ledgerEmptyQuotaSnapshotFixture().quota as QuotaUiState.Available
        assertTrue(empty.snapshot.providers.isEmpty())

        val loginRequired = ledgerLoginRequiredQuotaSnapshotFixture().quota as QuotaUiState.Available
        assertEquals(
            QuotaProviderStatus.AuthRequired,
            loginRequired.snapshot.providers.single().status
        )
        assertTrue(loginRequired.snapshot.providers.single().windows.isEmpty())
    }

    @Test
    fun currentSummaryDetailsToolsAndModelsDescribeTheSameUsage() {
        listOf(RangeKey.Today, RangeKey.Week, RangeKey.Month).forEach { range ->
            val data = requireNotNull(ledgerSnapshotFixture(range).data)
            val summary = data.summary
            val comparison = requireNotNull(data.comparison)
            val detailsPage = requireNotNull(data.detailsPage)

            assertEquals(summary, comparison.current.summary)
            assertEquals(summary, detailsPage.filteredSummary)
            assertSummaryInvariant(summary)
            assertToolsMatchSummary(data.tools.values, summary)
            assertModelsMatchSummary(data.models.values, summary)

            val modelTotalsFromTools = data.tools.values
                .flatMap { it.models.entries }
                .groupingBy { it.key }
                .fold(0L) { total, entry -> total + entry.value }
            assertEquals(data.models.mapValues { it.value.total }, modelTotalsFromTools)
        }
    }

    @Test
    fun dayWeekAndMonthFixturesUseCanonicalEqualProgressWindowsWithoutFutureBuckets() {
        assertAlignedFixture(
            range = RangeKey.Today,
            expectedKind = "dayOverDay",
            expectedBucket = "hour",
            expectedCurrentStart = "2026-07-15T00:00:00+08:00",
            expectedCurrentEnd = "2026-07-15T12:41:00+08:00",
            expectedPreviousStart = "2026-07-14T00:00:00+08:00",
            expectedPreviousEnd = "2026-07-14T12:41:00+08:00"
        )
        assertAlignedFixture(
            range = RangeKey.Week,
            expectedKind = "weekOverWeek",
            expectedBucket = "day",
            expectedCurrentStart = "2026-07-13T00:00:00+08:00",
            expectedCurrentEnd = "2026-07-15T12:41:00+08:00",
            expectedPreviousStart = "2026-07-06T00:00:00+08:00",
            expectedPreviousEnd = "2026-07-08T12:41:00+08:00"
        )
        assertAlignedFixture(
            range = RangeKey.Month,
            expectedKind = "monthOverMonth",
            expectedBucket = "day",
            expectedCurrentStart = "2026-07-01T00:00:00+08:00",
            expectedCurrentEnd = "2026-07-15T12:41:00+08:00",
            expectedPreviousStart = "2026-06-01T00:00:00+08:00",
            expectedPreviousEnd = "2026-06-15T12:41:00+08:00"
        )
    }

    @Test
    fun dayWeekAndMonthSeriesSummariesAndDeltasDescribeTheSameUsage() {
        listOf(RangeKey.Today, RangeKey.Week, RangeKey.Month).forEach { range ->
            val comparison = requireNotNull(ledgerSnapshotFixture(range).data?.comparison)
            assertPeriodMatchesSeries(comparison.current)
            assertPeriodMatchesSeries(comparison.previous)
            assertDeltaMatchesPeriods(
                current = comparison.current.summary.effectiveTokens.toDouble(),
                previous = comparison.previous.summary.effectiveTokens.toDouble(),
                delta = comparison.delta.tokens
            )
            assertDeltaMatchesPeriods(
                current = comparison.current.summary.totalRequests.toDouble(),
                previous = comparison.previous.summary.totalRequests.toDouble(),
                delta = comparison.delta.requests
            )
            assertDeltaMatchesPeriods(
                current = comparison.current.summary.totalCost,
                previous = comparison.previous.summary.totalCost,
                delta = comparison.delta.cost
            )
        }
    }

    private fun assertAlignedFixture(
        range: RangeKey,
        expectedKind: String,
        expectedBucket: String,
        expectedCurrentStart: String,
        expectedCurrentEnd: String,
        expectedPreviousStart: String,
        expectedPreviousEnd: String
    ) {
        val data = requireNotNull(ledgerSnapshotFixture(range).data)
        val comparison = requireNotNull(data.comparison)
        val window = comparison.window
        assertEquals(expectedKind, window.kind)
        assertEquals(expectedBucket, window.bucket)
        assertEquals(expectedCurrentStart, window.currentStart)
        assertEquals(expectedCurrentEnd, window.currentEnd)
        assertEquals(expectedPreviousStart, window.previousStart)
        assertEquals(expectedPreviousEnd, window.previousEnd)

        val currentStart = OffsetDateTime.parse(requireNotNull(window.currentStart))
        val currentEnd = OffsetDateTime.parse(requireNotNull(window.currentEnd))
        val previousStart = OffsetDateTime.parse(requireNotNull(window.previousStart))
        val previousEnd = OffsetDateTime.parse(requireNotNull(window.previousEnd))
        val generatedAt = OffsetDateTime.parse(requireNotNull(data.meta?.generatedAt))
        assertEquals(
            Duration.between(currentStart, currentEnd),
            Duration.between(previousStart, previousEnd)
        )
        assertEquals(currentEnd, OffsetDateTime.parse(requireNotNull(window.alignedThrough)))
        assertFalse(currentEnd.isAfter(generatedAt))
        assertFalse(previousEnd.isAfter(generatedAt))

        if (expectedBucket == "hour") {
            assertDenseHourBuckets(
                comparison.current.series.map { it.bucket },
                currentStart,
                currentEnd,
                generatedAt
            )
            assertDenseHourBuckets(
                comparison.previous.series.map { it.bucket },
                previousStart,
                previousEnd,
                generatedAt
            )
        } else {
            assertDenseDateBuckets(
                comparison.current.series.map { it.bucket },
                currentStart.toLocalDate(),
                currentEnd.toLocalDate(),
                generatedAt.toLocalDate()
            )
            assertDenseDateBuckets(
                comparison.previous.series.map { it.bucket },
                previousStart.toLocalDate(),
                previousEnd.toLocalDate(),
                generatedAt.toLocalDate()
            )
        }
        assertEquals(comparison.current.series.size, comparison.previous.series.size)
    }

    private fun assertDenseHourBuckets(
        actual: List<String>,
        start: OffsetDateTime,
        end: OffsetDateTime,
        generatedAt: OffsetDateTime
    ) {
        val firstBucket = start.withMinute(0).withSecond(0).withNano(0)
        val expected = generateSequence(firstBucket) { it.plusHours(1) }
            .takeWhile { !it.isAfter(end) }
            .map { it.toLocalTime().toString() }
            .toList()
        assertEquals(expected, actual)
        val bucketTimes = actual.map {
            OffsetDateTime.of(start.toLocalDate(), LocalTime.parse(it), start.offset)
        }
        assertTrue(bucketTimes.none { it.isAfter(end) || it.isAfter(generatedAt) })
    }

    private fun assertDenseDateBuckets(
        actual: List<String>,
        start: LocalDate,
        end: LocalDate,
        generatedDate: LocalDate
    ) {
        val expected = generateSequence(start) { it.plusDays(1) }
            .takeWhile { !it.isAfter(end) }
            .map(LocalDate::toString)
            .toList()
        assertEquals(expected, actual)
        assertTrue(actual.map(LocalDate::parse).none { it.isAfter(generatedDate) })
    }

    private fun assertPeriodMatchesSeries(period: ComparisonPeriod) {
        assertSummaryInvariant(period.summary)
        assertEquals(period.summary.effectiveTokens, period.series.sumOf { it.tokens })
        assertEquals(period.summary.totalTokens, period.series.sumOf { it.tokens })
        assertEquals(period.summary.totalRequests, period.series.sumOf { it.requests })
        assertEquals(period.summary.totalCost, period.series.sumOf { it.cost }, 1e-9)
    }

    private fun assertSummaryInvariant(summary: Summary) {
        assertEquals(summary.totalTokens, summary.effectiveTokens)
        assertEquals(summary.cachedTokens, summary.cacheReadTokens + summary.cacheWriteTokens)
        assertEquals(summary.avgTokensPerReq, summary.effectiveTokens / summary.totalRequests)
    }

    private fun assertToolsMatchSummary(tools: Collection<ToolStat>, summary: Summary) {
        tools.forEach { tool ->
            assertEquals("${tool.name} total", tool.effectiveTokens, tool.total)
            val read = tool.cacheRead
            val write = tool.cacheWrite
            if (read != null && write != null) {
                assertEquals("${tool.name} cache", tool.cached, read + write)
            }
            assertEquals("${tool.name} models", tool.total, tool.models.values.sum())
        }
        assertEquals(summary.totalTokens, tools.sumOf { it.total })
        assertEquals(summary.inputTokens, tools.sumOf { it.input })
        assertEquals(summary.outputTokens, tools.sumOf { it.output })
        assertEquals(summary.cachedTokens, tools.sumOf { it.cached })
        assertEquals(summary.cacheReadTokens, tools.mapNotNull { it.cacheRead }.sum())
        assertEquals(summary.cacheWriteTokens, tools.mapNotNull { it.cacheWrite }.sum())
        assertEquals(summary.totalCost, tools.sumOf { requireNotNull(it.cost) }, 1e-9)
        assertEquals(summary.totalRequests, tools.sumOf { it.requests })
    }

    private fun assertModelsMatchSummary(models: Collection<ModelStat>, summary: Summary) {
        models.forEach { model ->
            assertEquals("${model.name} total", model.input + model.output, model.total)
        }
        assertEquals(summary.totalTokens, models.sumOf { it.total })
        assertEquals(summary.inputTokens, models.sumOf { it.input })
        assertEquals(summary.outputTokens, models.sumOf { it.output })
        assertEquals(summary.cachedTokens, models.sumOf { it.cached })
        assertEquals(summary.totalCost, models.sumOf { requireNotNull(it.cost) }, 1e-9)
        assertEquals(summary.totalRequests, models.sumOf { it.requests })
    }

    private fun assertDeltaMatchesPeriods(current: Double, previous: Double, delta: MetricDelta) {
        val expectedAbsolute = current - previous
        assertEquals(expectedAbsolute, delta.absolute, 1e-9)
        assertEquals(expectedAbsolute / previous * 100.0, requireNotNull(delta.percent), 1e-9)
        assertEquals("up", delta.direction)
    }
}
