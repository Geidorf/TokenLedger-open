package com.jeidorf.tokenledger.mobile

import java.io.File
import org.junit.Assert.*
import org.junit.Test

class AuditPresentationTest {
    @Test fun queryIdentityIncludesSearchAndSourcesEvenWithAllMachines() {
        val query = DashboardQuery(range = RangeKey.Custom, start = "2026-09-07", end = "2026-09-08",
            tools = listOf("codex"), models = listOf("model-a"), search = "audit-no-match")
        val label = dashboardQuerySummary(query)
        listOf("2026-09-07", "2026-09-08", "codex", "model-a", "audit-no-match").forEach {
            assertTrue("Missing query identity: $it in $label", label.contains(it))
        }
    }

    @Test fun filterCandidatesComeFromFacetsNotOnlyCurrentAggregates() {
        val stats = StatsJson.parse(File("../../../fixtures/dashboard-stats-v2/complete-v2.json").readText())
        val details = requireNotNull(stats.detailsPage)
        val input = stats.copy(tools = stats.tools.filterKeys { it == "codex" },
            detailsPage = details.copy(availableFilters = AvailableFilters(
                tools = listOf(FilterOption("codex", 5), FilterOption("claude", 3)))))
        assertTrue(v2FilterOptions(input).tools.any { it.first == "claude" })
    }
    @Test fun narrowHeroProtectsPercentageAndUnit() {
        assertTrue(shouldStackDashboardHeroValues(1f, 320))
        assertFalse(shouldStackDashboardHeroValues(1f, 390))
        assertTrue(shouldStackDashboardHeroValues(2f, 430))
    }

    @Test fun toolColorsRemainIdenticalWhenRankChanges() {
        val first = listOf("codex", "claude", "antigravity").associateWith(::stableToolColorIndex)
        val reordered = listOf("antigravity", "codex", "claude").associateWith(::stableToolColorIndex)
        assertEquals(first, reordered)
        assertEquals(4, listOf("codex", "antigravity", "marvis", "claude").map(::stableToolColorIndex).distinct().size)
    }
    @Test fun costStructureSuppressesUnknownMaskedAndInvalidDenominators() {
        assertEquals("codex：预估费用占比 75.0%，有效 Token 占比 50.0%",
            sourceCostStructureLabel("codex", 3.0, 4.0, 50, 100, false, true))
        assertNull(sourceCostStructureLabel("codex", 3.0, 4.0, 50, 100, true, true))
        assertNull(sourceCostStructureLabel("codex", 3.0, 4.0, 50, 100, false, false))
        assertNull(sourceCostStructureLabel("codex", null, 4.0, 50, 100, false, true))
        assertNull(sourceCostStructureLabel("codex", 0.0, 0.0, 0, 0, false, true))
        assertNull(sourceCostStructureLabel("codex", Double.NaN, 4.0, 50, 100, false, true))
    }
}
