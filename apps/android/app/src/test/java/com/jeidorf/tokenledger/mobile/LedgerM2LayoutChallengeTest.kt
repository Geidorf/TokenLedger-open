package com.jeidorf.tokenledger.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Adversarial layout density, responsive breakpoints, and drilldown state challenge suite
 * for Milestone 2 (F-10 through F-17).
 */
class LedgerM2LayoutChallengeTest {

    // =========================================================================
    // Challenge 1: isLandscapeOrCompactHeight Edge Heights & Boundary Sweep
    // =========================================================================

    @Test
    fun isLandscapeOrCompactHeightEvaluatesRequiredEdgeHeights() {
        // Required edge heights: 0, 499, 500, 501, 1080
        assertTrue("Height 0dp must evaluate to compact/landscape (<500dp)", isLandscapeOrCompactHeight(0))
        assertTrue("Height 499dp must evaluate to compact/landscape (<500dp)", isLandscapeOrCompactHeight(499))
        assertFalse("Height 500dp is the threshold boundary and must evaluate to false", isLandscapeOrCompactHeight(500))
        assertFalse("Height 501dp must evaluate to false (>=500dp)", isLandscapeOrCompactHeight(501))
        assertFalse("Height 1080dp must evaluate to false (>=500dp)", isLandscapeOrCompactHeight(1080))
    }

    @Test
    fun isLandscapeOrCompactHeightStressTestsNegativeAndExtremeDimensions() {
        // Negative dimensions (e.g. malformed or uninitialized configuration values)
        assertTrue("Negative height -1dp should be < 500dp", isLandscapeOrCompactHeight(-1))
        assertTrue("Negative height -500dp should be < 500dp", isLandscapeOrCompactHeight(-500))
        assertTrue("Int.MIN_VALUE should be < 500dp", isLandscapeOrCompactHeight(Int.MIN_VALUE))

        // Large device dimensions (Foldable unfolded, desktop, large tablet)
        assertFalse("Height 1200dp should evaluate to false", isLandscapeOrCompactHeight(1200))
        assertFalse("Height 2160dp (4K) should evaluate to false", isLandscapeOrCompactHeight(2160))
        assertFalse("Int.MAX_VALUE should evaluate to false", isLandscapeOrCompactHeight(Int.MAX_VALUE))
    }

    @Test
    fun isLandscapeOrCompactHeightRealisticDeviceBreakpoints() {
        // Typical landscape phone heights:
        // 320dp (compact phone landscape), 360dp, 390dp (iPhone landscape), 412dp (Pixel landscape)
        val landscapeHeights = listOf(320, 360, 375, 390, 411, 412, 480)
        landscapeHeights.forEach { h ->
            assertTrue("Expected height $h dp to be classified as landscape/compact", isLandscapeOrCompactHeight(h))
        }

        // Typical portrait phone & tablet heights:
        // 640dp, 740dp, 800dp, 844dp, 892dp, 915dp, 1024dp
        val portraitHeights = listOf(640, 740, 800, 844, 892, 915, 1024)
        portraitHeights.forEach { h ->
            assertFalse("Expected height $h dp to NOT be classified as landscape/compact", isLandscapeOrCompactHeight(h))
        }
    }

    // =========================================================================
    // Challenge 2: 2-Column KPI Grid (specs.chunked(2)) Data Integrity & Spacers
    // =========================================================================

    private data class TestKpiSpec(val id: Int, val title: String)

    /**
     * Simulates the exact Compose layout structure implemented in LedgerDashboardV2Ui.kt:
     *
     * specs.chunked(2).forEach { row ->
     *     Row {
     *         row.forEach { spec -> V2KpiCard(spec, Modifier.weight(1f)) }
     *         if (row.size == 1) {
     *             Spacer(Modifier.weight(1f))
     *         }
     *     }
     * }
     */
    private data class SimulatedRowResult(
        val totalRows: Int,
        val renderedCardIds: List<Int>,
        val rowsWithSpacer: Int,
        val maxCardsPerRow: Int
    )

    private fun simulateKpiGridLayout(specs: List<TestKpiSpec>): SimulatedRowResult {
        val rows = specs.chunked(2)
        val rendered = mutableListOf<Int>()
        var spacersCount = 0
        var maxInRow = 0

        rows.forEach { row ->
            maxInRow = maxOf(maxInRow, row.size)
            row.forEach { spec ->
                rendered.add(spec.id)
            }
            if (row.size == 1) {
                spacersCount++
            }
        }

        return SimulatedRowResult(
            totalRows = rows.size,
            renderedCardIds = rendered,
            rowsWithSpacer = spacersCount,
            maxCardsPerRow = maxInRow
        )
    }

    @Test
    fun kpiGridChunkedIntegrityWithEmptySpecs() {
        val emptySpecs = emptyList<TestKpiSpec>()
        val result = simulateKpiGridLayout(emptySpecs)

        assertEquals("Empty specs must produce 0 rows", 0, result.totalRows)
        assertEquals("Empty specs must render 0 cards", 0, result.renderedCardIds.size)
        assertEquals("Empty specs must render 0 spacers", 0, result.rowsWithSpacer)
        assertEquals("Empty specs maxCardsPerRow must be 0", 0, result.maxCardsPerRow)
    }

    @Test
    fun kpiGridChunkedIntegrityWithOddNumberOfSpecs() {
        val oddCounts = listOf(1, 3, 5, 7, 99)

        for (count in oddCounts) {
            val specs = (0 until count).map { TestKpiSpec(id = it, title = "KPI #$it") }
            val result = simulateKpiGridLayout(specs)

            // 1. Every single item must be rendered in exact original order
            assertEquals("Rendered card count must match specs size for count=$count", count, result.renderedCardIds.size)
            assertEquals("Rendered card IDs must preserve exact original order", specs.map { it.id }, result.renderedCardIds)

            // 2. Exactly (count + 1) / 2 rows must be produced
            val expectedRowCount = (count + 1) / 2
            assertEquals("Row count mismatch for count=$count", expectedRowCount, result.totalRows)

            // 3. For an odd count, exactly 1 row (the terminal row) must have size 1 and require a spacer
            assertEquals("Odd counts must have exactly 1 row with a balancing spacer", 1, result.rowsWithSpacer)

            // 4. Maximum cards per row must never exceed 2
            assertTrue("Max cards per row must be <= 2", result.maxCardsPerRow in 1..2)

            // 5. Direct chunked verification: flattening chunks must recreate original list perfectly
            val chunks = specs.chunked(2)
            assertEquals("Flattened chunks must equal original list", specs, chunks.flatten())
            assertEquals("Terminal row must have size 1 for odd count=$count", 1, chunks.last().size)
            if (chunks.size > 1) {
                for (i in 0 until chunks.size - 1) {
                    assertEquals("All non-terminal rows must have exactly 2 items", 2, chunks[i].size)
                }
            }
        }
    }

    @Test
    fun kpiGridChunkedIntegrityWithEvenNumberOfSpecs() {
        val evenCounts = listOf(2, 4, 6, 100)

        for (count in evenCounts) {
            val specs = (0 until count).map { TestKpiSpec(id = it, title = "KPI #$it") }
            val result = simulateKpiGridLayout(specs)

            assertEquals("Rendered card count must match specs size for count=$count", count, result.renderedCardIds.size)
            assertEquals("Row count mismatch for count=$count", count / 2, result.totalRows)
            assertEquals("Even counts must have 0 rows with a balancing spacer", 0, result.rowsWithSpacer)
            assertEquals("Max cards per row must be 2", 2, result.maxCardsPerRow)

            val chunks = specs.chunked(2)
            assertEquals(specs, chunks.flatten())
            chunks.forEach { row ->
                assertEquals("Every row in even specs must have exactly 2 items", 2, row.size)
            }
        }
    }

    // =========================================================================
    // Challenge 3: trendSeriesBuckets & Anchor Midpoint Calculation Resilience
    // =========================================================================

    private fun createDummyComparison(buckets: List<String>): UsageComparison {
        return UsageComparison(
            window = ComparisonWindow(
                kind = "dayOverDay",
                timezone = "UTC",
                bucket = "hour",
                currentStart = "2026-09-01T00:00:00Z",
                currentEnd = "2026-09-02T00:00:00Z",
                previousStart = "2026-08-31T00:00:00Z",
                previousEnd = "2026-09-01T00:00:00Z",
                alignedThrough = "2026-09-02T00:00:00Z"
            ),
            current = ComparisonPeriod(
                summary = Summary(totalTokens = 100L, totalCost = 0.05),
                series = buckets.map { ComparisonSeriesPoint(bucket = it, tokens = 10L, requests = 1L, cost = 0.005) }
            ),
            previous = ComparisonPeriod(
                summary = Summary(totalTokens = 80L, totalCost = 0.04),
                series = emptyList()
            ),
            delta = ComparisonDelta(
                tokens = MetricDelta(20.0, 25.0, "up"),
                requests = MetricDelta(0.0, 0.0, "neutral"),
                cost = MetricDelta(0.01, 25.0, "up")
            )
        )
    }

    /**
     * Replicates the exact anchor calculation logic from LedgerDashboardV2Ui.kt lines 5018-5020:
     *
     * val startAnchor = axisLabels.firstOrNull()?.let(::formatTrendAnchorLabel).orEmpty()
     * val endAnchor = if (axisLabels.size > 1) axisLabels.last().let(::formatTrendAnchorLabel) else ""
     * val midAnchor = if (axisLabels.size > 2) axisLabels[axisLabels.size / 2].let(::formatTrendAnchorLabel) else ""
     */
    private fun extractAnchorLabels(axisLabels: List<String>): Triple<String, String, String> {
        val startAnchor = axisLabels.firstOrNull()?.let(::formatTrendAnchorLabel).orEmpty()
        val endAnchor = if (axisLabels.size > 1) axisLabels.last().let(::formatTrendAnchorLabel) else ""
        val midAnchor = if (axisLabels.size > 2) axisLabels[axisLabels.size / 2].let(::formatTrendAnchorLabel) else ""
        return Triple(startAnchor, midAnchor, endAnchor)
    }

    @Test
    fun trendSeriesBucketsWithNullOrEmptyInputs() {
        // 1. Both comparison and fallback empty/null
        val emptyFallback = emptyList<TrendPoint>()
        assertEquals(emptyList<String>(), trendSeriesBuckets(comparison = null, fallback = emptyFallback))

        // 2. Comparison is null, but fallback has points
        val fallbackPoints = listOf(
            TrendPoint(date = "2026-09-01", values = emptyMap()),
            TrendPoint(date = "2026-09-02", values = emptyMap())
        )
        assertEquals(listOf("2026-09-01", "2026-09-02"), trendSeriesBuckets(comparison = null, fallback = fallbackPoints))

        // 3. Comparison has empty series, fallback is empty
        val emptyComparison = createDummyComparison(emptyList())
        assertEquals(emptyList<String>(), trendSeriesBuckets(comparison = emptyComparison, fallback = emptyFallback))

        // 4. Comparison has empty series, fallback has points -> should fall back gracefully
        assertEquals(listOf("2026-09-01", "2026-09-02"), trendSeriesBuckets(comparison = emptyComparison, fallback = fallbackPoints))

        // 5. Comparison has series, fallback is empty -> uses comparison
        val activeComparison = createDummyComparison(listOf("2026-09-03", "2026-09-04"))
        assertEquals(listOf("2026-09-03", "2026-09-04"), trendSeriesBuckets(comparison = activeComparison, fallback = emptyFallback))

        // 6. Both have items -> comparison takes priority
        assertEquals(listOf("2026-09-03", "2026-09-04"), trendSeriesBuckets(comparison = activeComparison, fallback = fallbackPoints))
    }

    @Test
    fun trendAnchorLabelsWithEmptySeries() {
        val (start, mid, end) = extractAnchorLabels(emptyList())
        assertEquals("", start)
        assertEquals("", mid)
        assertEquals("", end)
    }

    @Test
    fun trendAnchorLabelsWithSinglePointDoesNotCrashNorDuplicate() {
        val singlePoint = listOf("2026-09-01")
        val (start, mid, end) = extractAnchorLabels(singlePoint)

        assertEquals("Single point must populate start anchor", "09-01", start)
        assertEquals("Single point must leave midpoint empty to prevent overlapping/duplication", "", mid)
        assertEquals("Single point must leave end anchor empty to prevent overlapping/duplication", "", end)
    }

    @Test
    fun trendAnchorLabelsWithTwoPointsDoesNotCrashNorDuplicateMidpoint() {
        val twoPoints = listOf("2026-09-01", "2026-09-02")
        val (start, mid, end) = extractAnchorLabels(twoPoints)

        assertEquals("Start anchor must match point 0", "09-01", start)
        assertEquals("End anchor must match point 1", "09-02", end)
        assertEquals("Midpoint must remain empty for 2-point series to avoid collision with start or end", "", mid)

        assertNotEquals("Start and end must be distinct", start, end)
    }

    @Test
    fun trendAnchorLabelsWithThreeOrMorePointsComputesMidpointCorrectly() {
        // 3 points: indices 0, 1, 2. Midpoint = 3 / 2 = 1
        val threePoints = listOf("2026-09-01", "2026-09-02", "2026-09-03")
        val (start3, mid3, end3) = extractAnchorLabels(threePoints)
        assertEquals("09-01", start3)
        assertEquals("09-02", mid3)
        assertEquals("09-03", end3)
        assertTrue("All 3 anchors must be distinct for 3 points", start3 != mid3 && mid3 != end3 && start3 != end3)

        // 4 points: indices 0, 1, 2, 3. Midpoint = 4 / 2 = 2
        val fourPoints = listOf("2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04")
        val (start4, mid4, end4) = extractAnchorLabels(fourPoints)
        assertEquals("09-01", start4)
        assertEquals("09-03", mid4)
        assertEquals("09-04", end4)
        assertTrue("All 3 anchors must be distinct for 4 points", start4 != mid4 && mid4 != end4 && start4 != end4)

        // 30 points: midpoint is index 15
        val thirtyPoints = (1..30).map { String.format("2026-09-%02d", it) }
        val (start30, mid30, end30) = extractAnchorLabels(thirtyPoints)
        assertEquals("09-01", start30)
        assertEquals("09-16", mid30) // index 15 -> day 16
        assertEquals("09-30", end30) // index 29 -> day 30
    }

    @Test
    fun formatTrendAnchorLabelResilienceAcrossFormats() {
        // ISO Date YYYY-MM-DD
        assertEquals("09-04", formatTrendAnchorLabel("2026-09-04"))
        // ISO Month YYYY-MM
        assertEquals("09", formatTrendAnchorLabel("2026-09"))
        // ISO DateTime with 'T'
        assertEquals("09-04 14:30", formatTrendAnchorLabel("2026-09-04T14:30:00+08:00"))
        // ISO DateTime with space
        assertEquals("09-04 09:15", formatTrendAnchorLabel("2026-09-04 09:15:00"))
        // Hour format
        assertEquals("14:00", formatTrendAnchorLabel("14:00"))
        // Already short
        assertEquals("08-15", formatTrendAnchorLabel("08-15"))
        // Trims leading/trailing whitespace
        assertEquals("09-04", formatTrendAnchorLabel("   2026-09-04   "))
        // Blank string
        assertEquals("", formatTrendAnchorLabel("   "))
    }

    // =========================================================================
    // Challenge 4: Drilldown Search Query Filter Logic & State Immutability
    // =========================================================================

    @Test
    fun drilldownSearchCopyPreservesAllOtherQueryParameters() {
        // Construct a saturated query with non-default values across all dimensions
        val initialQuery = DashboardQuery(
            range = RangeKey.Month,
            machines = listOf("host-worker-1", "host-worker-2"),
            tools = listOf("claude-code", "cursor"),
            models = listOf("claude-3-5-sonnet", "gpt-4o"),
            search = "original-search-filter",
            tokenMode = "effective",
            compatibilityToolSelector = "legacy-tool-override",
            compatibilityModelSelector = "legacy-model-override"
        )

        val targetSessionId = "sess_m2_drilldown_9988aabb"

        // Execute session drilldown filter mutation: query.copy(search = sessionId)
        val updatedQuery = initialQuery.copy(search = targetSessionId)

        // Verify that target parameter is updated
        assertEquals("Search parameter must be updated to target sessionId", targetSessionId, updatedQuery.search)

        // Verify strict immutability and preservation of ALL other parameters
        assertEquals("Timeframe/range must be preserved", initialQuery.range, updatedQuery.range)
        assertEquals("Machines list must be preserved", initialQuery.machines, updatedQuery.machines)
        assertEquals("Tools list must be preserved", initialQuery.tools, updatedQuery.tools)
        assertEquals("Models list must be preserved", initialQuery.models, updatedQuery.models)
        assertEquals("TokenMode must be preserved", initialQuery.tokenMode, updatedQuery.tokenMode)
        assertEquals("CompatibilityToolSelector must be preserved", initialQuery.compatibilityToolSelector, updatedQuery.compatibilityToolSelector)
        assertEquals("CompatibilityModelSelector must be preserved", initialQuery.compatibilityModelSelector, updatedQuery.compatibilityModelSelector)

        // Verify helper properties
        assertEquals("Machine helper must be preserved", initialQuery.machine, updatedQuery.machine)
        assertEquals("Tool helper must be preserved", initialQuery.tool, updatedQuery.tool)
        assertEquals("Model helper must be preserved", initialQuery.model, updatedQuery.model)
        assertTrue("hasFilters must remain true", updatedQuery.hasFilters)
    }

    @Test
    fun drilldownSearchFromDefaultQueryActivatesSearchFilterOnly() {
        val defaultQuery = DashboardQuery()
        assertNull("Default search should be null", defaultQuery.search)
        assertFalse("Default query should have no active filters", defaultQuery.hasFilters)

        val targetSessionId = "session_alpha_01"
        val drilldownQuery = defaultQuery.copy(search = targetSessionId)

        assertEquals(targetSessionId, drilldownQuery.search)
        assertTrue("Query with session search must report hasFilters == true", drilldownQuery.hasFilters)

        // All defaults must remain untouched
        assertEquals(RangeKey.Today, drilldownQuery.range)
        assertTrue("Machines must remain empty", drilldownQuery.machines.isEmpty())
        assertTrue("Tools must remain empty", drilldownQuery.tools.isEmpty())
        assertTrue("Models must remain empty", drilldownQuery.models.isEmpty())
        assertEquals(EFFECTIVE_TOKEN_MODE, drilldownQuery.tokenMode)
    }

    @Test
    fun drilldownSearchClearingPreservesOtherFilters() {
        val queryWithFilters = DashboardQuery(
            range = RangeKey.Week,
            tools = listOf("copilot"),
            models = listOf("gpt-4o"),
            search = "session-to-clear"
        )

        val clearedQuery = queryWithFilters.copy(search = null)
        assertNull("Search must be cleared to null", clearedQuery.search)
        assertEquals(RangeKey.Week, clearedQuery.range)
        assertEquals(listOf("copilot"), clearedQuery.tools)
        assertEquals(listOf("gpt-4o"), clearedQuery.models)
        assertTrue("hasFilters must still be true because tools/models are set", clearedQuery.hasFilters)
    }

    @Test
    fun drilldownSearchNormalizationStressTest() {
        // Standard session ID
        assertEquals("sess-12345", DashboardQueryContract.normalizeSearch("sess-12345"))

        // Whitespace surrounding session ID
        assertEquals("sess-trimmed", DashboardQueryContract.normalizeSearch("  sess-trimmed  \t\n"))

        // Empty or whitespace-only session string becomes null
        assertNull("Empty string normalizes to null", DashboardQueryContract.normalizeSearch(""))
        assertNull("Whitespace string normalizes to null", DashboardQueryContract.normalizeSearch("   "))
        assertNull("Null normalizes to null", DashboardQueryContract.normalizeSearch(null))

        // Session ID up to exactly 256 UTF-8 bytes is accepted
        val maxValidSessionId = "s".repeat(256)
        assertEquals(maxValidSessionId, DashboardQueryContract.normalizeSearch(maxValidSessionId))

        // Session ID exceeding 256 UTF-8 bytes throws DashboardQueryContractException
        val oversizedSessionId = "s".repeat(257)
        try {
            DashboardQueryContract.normalizeSearch(oversizedSessionId)
            fail("Expected DashboardQueryContractException for oversized search query")
        } catch (e: DashboardQueryContractException) {
            assertTrue(e.message?.contains("exceeds 256 UTF-8 bytes") == true)
        }
    }

    @Test
    fun drilldownCanonicalQuerySerializationPreservesSessionSearch() {
        val query = DashboardQuery(
            range = RangeKey.Week,
            tools = listOf("code-assistant"),
            models = listOf("claude-sonnet-4"),
            search = "session_xyz_777"
        )

        val canonical = DashboardQueryContract.canonical(query, timezone = "Asia/Shanghai")
        assertEquals("week", canonical.range)
        assertEquals("Asia/Shanghai", canonical.timezone)
        assertEquals(listOf("code-assistant"), canonical.tools)
        assertEquals(listOf("claude-sonnet-4"), canonical.models)
        assertEquals("session_xyz_777", canonical.search)
        assertTrue(canonical.hasFilters)

        val json = canonical.toJson()
        assertEquals("session_xyz_777", json.getString("search"))
        assertEquals("week", json.getString("range"))
        assertEquals("Asia/Shanghai", json.getString("timezone"))
    }
}
