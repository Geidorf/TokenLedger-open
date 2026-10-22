package com.jeidorf.tokenledger.mobile.coordinator

import com.jeidorf.tokenledger.mobile.ContributionMode
import com.jeidorf.tokenledger.mobile.DailyQuoteDataSource
import com.jeidorf.tokenledger.mobile.DashboardEntity
import com.jeidorf.tokenledger.mobile.DashboardNavigationSnapshot
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.DashboardSection
import com.jeidorf.tokenledger.mobile.DashboardTimeProvider
import com.jeidorf.tokenledger.mobile.DashboardUiError
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.Summary
import com.jeidorf.tokenledger.mobile.StatsData
import java.time.LocalDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CoordinatorTest {
    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private data object FakeTime : DashboardTimeProvider {
        override fun nowEpochMillis(): Long = 1_750_000_100_000L
        override fun currentDate(): LocalDate = LocalDate.of(2026, 7, 15)
        override fun timezoneId(): String = "Asia/Shanghai"
        override fun millisUntilNextMidnight(): Long = 60_000L
    }

    @Test
    fun filterAndQueryCoordinatorHandlesTogglesAndSearchNormalization() {
        var lastError: DashboardUiError? = null
        val coordinator = FilterAndQueryCoordinator(
            initialQuery = DashboardQuery(),
            onQueryChanged = {},
            onError = { lastError = it }
        )

        coordinator.toggleMachine("MacBook", hasSession = true)
        assertEquals(listOf("MacBook"), coordinator.currentQuery().machines)

        coordinator.toggleMachine("MacBook", hasSession = true)
        assertTrue(coordinator.currentQuery().machines.isEmpty())

        coordinator.toggleTool("Codex", hasSession = true)
        assertEquals(listOf("Codex"), coordinator.currentQuery().tools)

        coordinator.setSearch("  search query  ", hasSession = true)
        assertEquals("search query", coordinator.currentQuery().search)

        coordinator.clearFilters(hasSession = true)
        assertFalse(coordinator.currentQuery().hasFilters)
        assertNull(coordinator.currentQuery().search)
        assertNull(lastError)
    }

    @Test
    fun filterAndQueryCoordinatorSelectCustomRangeValidatesDates() {
        var lastError: DashboardUiError? = null
        val coordinator = FilterAndQueryCoordinator(
            initialQuery = DashboardQuery(),
            onQueryChanged = {},
            onError = { lastError = it }
        )

        val valid = coordinator.selectCustomRange("2026-07-01", "2026-07-10", hasSession = true)
        assertEquals(RangeKey.Custom, valid?.range)
        assertEquals("2026-07-01", valid?.start)
        assertEquals("2026-07-10", valid?.end)
        assertNull(lastError)

        val invalid = coordinator.selectCustomRange("2026-07-10", "2026-07-01", hasSession = true)
        assertNull(invalid)
        assertTrue(lastError is DashboardUiError.Unexpected)
    }

    @Test
    fun drillDownCoordinatorHandlesEntityAndNavigationStack() {
        val coordinator = DrillDownCoordinator(timeProvider = FakeTime)

        var navigatedQuery: DashboardQuery? = null
        var navigatedEntity: DashboardEntity? = null
        var navigatedStack: List<DashboardNavigationSnapshot>? = null

        coordinator.openTool(
            tool = "codex",
            currentQuery = DashboardQuery(range = RangeKey.Week),
            hasSession = true
        ) { q, e, s ->
            navigatedQuery = q
            navigatedEntity = e
            navigatedStack = s
        }

        assertEquals(DashboardEntity(DashboardEntity.TOOL, "codex"), navigatedEntity)
        assertEquals(1, navigatedStack?.size)
        assertEquals(DashboardSection.Entity, coordinator.currentState().section)
        assertEquals(DashboardEntity(DashboardEntity.TOOL, "codex"), coordinator.currentState().entity)

        var restoredSnapshot: DashboardNavigationSnapshot? = null
        coordinator.navigateBack(
            onRestoreFromDayReview = {},
            onNavigateBackToSnapshot = { restoredSnapshot = it }
        )

        assertEquals(RangeKey.Week, restoredSnapshot?.query?.range)
        assertTrue(coordinator.currentState().navigationStack.isEmpty())
    }

    @Test
    fun drillDownCoordinatorPreservesAndRestoresDayReviewSnapshot() {
        val coordinator = DrillDownCoordinator(timeProvider = FakeTime)
        val dummyStats = StatsData(
            summary = Summary(totalTokens = 999, inputTokens = 900, outputTokens = 99),
            tools = emptyMap(),
            models = emptyMap(),
            trends = emptyList(),
            heatmap = emptyMap(),
            history = emptyList(),
            machines = emptyList(),
            meta = null
        )

        var drilledQuery: DashboardQuery? = null
        val opened = coordinator.openDayDetails(
            date = "2026-07-12",
            targetSection = DashboardSection.Details,
            trustedTrendDate = true,
            currentQuery = DashboardQuery(range = RangeKey.Month),
            visibleData = dummyStats,
            calendarHeatmap = com.jeidorf.tokenledger.mobile.CalendarHeatmapUiState.Idle,
            lastUpdatedEpochMillis = 1000L,
            showingCachedData = false,
            hasSession = true,
            customRangeQueryResolver = { q, s, e -> q.copy(range = RangeKey.Custom, start = s, end = e) },
            onExecuteDayDrill = { drilledQuery = it }
        )

        assertTrue(opened)
        assertEquals("2026-07-12", drilledQuery?.start)
        assertEquals(dummyStats, coordinator.currentDayReviewSource()?.stats)

        var restoredDestination: DashboardNavigationSnapshot? = null
        var restoredSource: DayReviewSourceSnapshot? = null
        coordinator.restoreGlobalQueryFromDayReview { dest, src ->
            restoredDestination = dest
            restoredSource = src
        }

        assertEquals(RangeKey.Month, restoredDestination?.query?.range)
        assertEquals(dummyStats, restoredSource?.stats)
        assertNull(coordinator.currentDayReviewSource())
    }

    @Test
    fun standbyDisplayCoordinatorTogglesVisibility() = runTest {
        val testScope = TestScope(testDispatcher)
        val dummyQuoteRepo = object : DailyQuoteDataSource {
            override suspend fun quoteFor(date: LocalDate): com.jeidorf.tokenledger.mobile.DailyQuote =
                com.jeidorf.tokenledger.mobile.DailyQuote("Stay focused.", "Author")
        }

        val coordinator = StandbyDisplayCoordinator(
            dailyQuoteRepository = dummyQuoteRepo,
            timeProvider = FakeTime,
            coroutineScope = testScope,
            automaticRefreshEnabled = false,
            hasSession = { true },
            getSessionGeneration = { 1L },
            onTriggerRefresh = {},
            onTriggerMidnightRefresh = {}
        )

        assertFalse(coordinator.isLowPowerDisplayVisible)
        coordinator.openLowPowerDisplay(hasVisibleData = true) {}
        assertTrue(coordinator.isLowPowerDisplayVisible)

        var foregroundTriggered = false
        coordinator.closeLowPowerDisplay { foregroundTriggered = true }
        assertFalse(coordinator.isLowPowerDisplayVisible)
        assertTrue(foregroundTriggered)
    }
}
