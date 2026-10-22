package com.jeidorf.tokenledger.mobile

import java.io.IOException
import java.time.LocalDate
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
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
class DashboardViewModelQueryTest {
    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun switchingAccountResetsQueryAndAllowsSelectingPreviousRange() = runTest {
        assertSessionQueryReset(signOut = true, expire = false)
    }

    @Test
    fun directSignInResetsQueryWithoutExplicitLogout() = runTest {
        assertSessionQueryReset(signOut = false, expire = false)
    }

    @Test
    fun authExpiryResetsQueryBeforeNextSignIn() = runTest {
        assertSessionQueryReset(signOut = false, expire = true)
    }

    private suspend fun assertSessionQueryReset(signOut: Boolean, expire: Boolean) {
        var expired = false
        val repository = QueryRepository { session, query, _ ->
            if (expired) throw DashboardAuthExpiredException()
            session to stats(100, query)
        }
        val viewModel = viewModel(repository, QueryCache())
        viewModel.selectRange(RangeKey.Week)
        viewModel.toggleMachine("studio")
        viewModel.toggleTool("codex")
        viewModel.toggleModel("gpt-5")
        viewModel.setSearch("account-a")
        assertTrue(viewModel.uiState.value.query.hasFilters)
        if (expire) {
            expired = true
            viewModel.selectRange(RangeKey.Month)
            assertTrue(viewModel.uiState.value.sessionState is DashboardSessionState.Expired)
        } else if (signOut) {
            viewModel.signOut()
        }
        if (signOut || expire) assertEquals(DashboardQuery(), viewModel.uiState.value.query)
        expired = false
        repository.signInSession = SESSION.copy(userId = "account-b")
        viewModel.signIn("b@example.test", "password")
        assertEquals("account-b", viewModel.uiState.value.session?.userId)
        assertEquals(DashboardQuery(), viewModel.uiState.value.query)
        val requestCount = repository.requests.size
        viewModel.selectRange(RangeKey.Week)
        assertTrue(repository.requests.size > requestCount)
        assertEquals(DashboardQuery(range = RangeKey.Week), repository.requests.last().query)
        viewModel.selectRange(RangeKey.Month)
        assertEquals(DashboardQuery(range = RangeKey.Month), repository.requests.last().query)
    }

    @Test
    fun rapidMultiSelectChangesAreLatestWinsAndUseCanonicalCacheIdentity() = runTest {
        val initial = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val firstFilter = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val latestFilter = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val repository = QueryRepository { session, query, _ ->
            when (query.machines) {
                emptyList<String>() -> initial.awaitIgnoringCancellation()
                listOf("studio") -> firstFilter.awaitIgnoringCancellation()
                listOf("mac", "studio") -> latestFilter.await()
                else -> session to stats(0, query)
            }
        }
        val cache = QueryCache()
        val viewModel = viewModel(repository, cache)

        viewModel.toggleMachine("studio")
        viewModel.toggleMachine("mac")
        viewModel.setSearch(" session ")
        latestFilter.complete(
            SESSION to stats(
                300,
                DashboardQuery(machines = listOf("mac", "studio"), search = "session")
            )
        )
        firstFilter.complete(SESSION to stats(200, DashboardQuery(machines = listOf("studio"))))
        initial.complete(SESSION to stats(100, DashboardQuery()))
        runCurrent()

        assertEquals(listOf("mac", "studio"), viewModel.uiState.value.query.machines)
        assertEquals(300L, viewModel.uiState.value.data?.summary?.effectiveTokens)
        assertEquals(listOf("mac", "studio"), cache.saved.last().machines)
        assertEquals("session", viewModel.uiState.value.query.search)
    }

    @Test
    fun entityRequestsSeparateSelectorFromQueryAndAppendKindIdToCacheKey() = runTest {
        val repository = QueryRepository { session, query, _ -> session to stats(100, query) }
        val cache = QueryCache()
        val viewModel = viewModel(repository, cache)
        runCurrent()

        viewModel.openTool("codex")
        runCurrent()
        val toolRequest = repository.requests.last()
        assertTrue(toolRequest.query.tools.isEmpty())
        assertEquals(DashboardEntity(DashboardEntity.TOOL, "codex"), toolRequest.entity)

        viewModel.openModel("gpt-5")
        runCurrent()
        val modelRequest = repository.requests.last()
        assertEquals(listOf("codex"), modelRequest.query.tools)
        assertTrue(modelRequest.query.models.isEmpty())
        assertEquals(DashboardEntity(DashboardEntity.MODEL, "gpt-5"), modelRequest.entity)
        assertEquals(DashboardEntity(DashboardEntity.MODEL, "gpt-5"), cache.saved.last().entity)

        viewModel.navigateBack()
        runCurrent()
        assertEquals(DashboardEntity(DashboardEntity.TOOL, "codex"), viewModel.uiState.value.entity)
    }

    @Test
    fun offlineRangeTransitionKeepsStableFrameOnlyWhileTargetRequestIsPending() = runTest {
        val weekResult = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val repository = QueryRepository { session, query, _ ->
            if (query.range == RangeKey.Week) weekResult.await()
            else session to stats(100, query)
        }
        val cache = QueryCache()
        val viewModel = viewModel(repository, cache)
        runCurrent()

        viewModel.selectRange(RangeKey.Week)
        assertEquals(RangeKey.Week, viewModel.uiState.value.query.range)
        assertEquals(100L, viewModel.uiState.value.visibleData?.summary?.effectiveTokens)
        assertEquals(DashboardLoadingMode.Refreshing, viewModel.uiState.value.loadingMode)

        weekResult.completeExceptionally(IOException("offline"))
        runCurrent()

        assertNull(viewModel.uiState.value.visibleData)
        assertNull(viewModel.uiState.value.lastUpdatedEpochMillis)
        assertFalse(viewModel.uiState.value.showingCachedData)
        assertTrue(viewModel.uiState.value.error is DashboardUiError.Network)
        assertEquals(RangeKey.Week, cache.loaded.last().range)
    }

    @Test
    fun offlineCustomAndEntityTransitionsNeverSettleGlobalSnapshotUnderNewIdentity() = runTest {
        val customResult = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val entityResult = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val repository = QueryRepository { session, query, entity ->
            when {
                entity != null -> entityResult.await()
                query.range == RangeKey.Custom -> customResult.await()
                else -> session to stats(100, query)
            }
        }
        val viewModel = viewModel(repository, QueryCache())
        runCurrent()

        viewModel.selectCustomRange("2026-07-01", "2026-07-07")
        assertEquals(100L, viewModel.uiState.value.visibleData?.summary?.effectiveTokens)
        customResult.completeExceptionally(IOException("custom offline"))
        runCurrent()
        assertNull(viewModel.uiState.value.visibleData)

        viewModel.selectRange(RangeKey.Today)
        runCurrent()
        assertEquals(100L, viewModel.uiState.value.visibleData?.summary?.effectiveTokens)

        viewModel.openTool("codex")
        assertEquals(100L, viewModel.uiState.value.visibleData?.summary?.effectiveTokens)
        entityResult.completeExceptionally(IOException("entity offline"))
        runCurrent()

        assertEquals(DashboardEntity(DashboardEntity.TOOL, "codex"), viewModel.uiState.value.entity)
        assertNull(viewModel.uiState.value.visibleData)
        assertTrue(viewModel.uiState.value.error is DashboardUiError.Network)
    }

    @Test
    fun matchingTargetCacheReplacesTransitionFrameAndSameQueryFailureKeepsLastKnownGood() = runTest {
        var weekAttempts = 0
        val weekQuery = DashboardQuery(range = RangeKey.Week)
        val cachedWeek = stats(220, weekQuery)
        val cache = QueryCache { key ->
            if (key.range == RangeKey.Week) DashboardCachedSnapshot(cachedWeek, 2_200L) else null
        }
        val repository = QueryRepository { session, query, _ ->
            if (query.range == RangeKey.Week) {
                weekAttempts += 1
                throw IOException("offline")
            }
            session to stats(100, query)
        }
        val viewModel = viewModel(repository, cache)
        runCurrent()

        viewModel.selectRange(RangeKey.Week)
        runCurrent()
        assertEquals(220L, viewModel.uiState.value.visibleData?.summary?.effectiveTokens)
        assertTrue(viewModel.uiState.value.showingCachedData)
        assertEquals(2_200L, viewModel.uiState.value.lastUpdatedEpochMillis)
        assertTrue(viewModel.uiState.value.error is DashboardUiError.Network)

        viewModel.refresh()
        runCurrent()
        assertEquals(2, weekAttempts)
        assertEquals(220L, viewModel.uiState.value.visibleData?.summary?.effectiveTokens)
        assertEquals(1, cache.loaded.count { it.range == RangeKey.Week })
    }

    @Test
    fun offlineEntityBackNavigationRestoresOnlyTheGlobalCacheIdentity() = runTest {
        var offline = false
        val globalQuery = DashboardQuery()
        val globalStats = stats(100, globalQuery)
        val cache = QueryCache { key ->
            if (key.entity == null) DashboardCachedSnapshot(globalStats, 1_100L) else null
        }
        val repository = QueryRepository { session, query, entity ->
            if (offline) throw IOException("offline")
            session to stats(if (entity == null) 100 else 300, query)
        }
        val viewModel = viewModel(repository, cache)
        runCurrent()
        viewModel.openTool("codex")
        runCurrent()
        assertEquals(300L, viewModel.uiState.value.visibleData?.summary?.effectiveTokens)

        offline = true
        viewModel.navigateBack()
        runCurrent()

        assertNull(viewModel.uiState.value.entity)
        assertEquals(100L, viewModel.uiState.value.visibleData?.summary?.effectiveTokens)
        assertTrue(viewModel.uiState.value.showingCachedData)
        assertEquals(1_100L, viewModel.uiState.value.lastUpdatedEpochMillis)
        assertTrue(viewModel.uiState.value.error is DashboardUiError.Network)
    }

    @Test
    fun dayReviewKeepsFiltersAndRestoresOriginalQueryAndSection() = runTest {
        val repository = QueryRepository { session, query, _ -> session to stats(100, query) }
        val viewModel = viewModel(repository, QueryCache())
        runCurrent()
        viewModel.selectSection(DashboardSection.Trends)
        viewModel.toggleTool("codex")
        viewModel.setSearch("session")
        viewModel.selectRange(RangeKey.Month)
        runCurrent()

        viewModel.openDayDetails("2026-07-12")
        runCurrent()
        assertEquals(DashboardSection.Details, viewModel.uiState.value.section)
        assertEquals(RangeKey.Custom, viewModel.uiState.value.query.range)
        assertEquals("2026-07-12", viewModel.uiState.value.query.start)
        assertEquals("2026-07-12", viewModel.uiState.value.query.end)
        assertEquals(listOf("codex"), viewModel.uiState.value.query.tools)
        assertEquals("session", viewModel.uiState.value.query.search)

        viewModel.returnFromDayDetails()
        runCurrent()
        assertEquals(DashboardSection.Trends, viewModel.uiState.value.section)
        assertEquals(RangeKey.Month, viewModel.uiState.value.query.range)
        assertEquals(listOf("codex"), viewModel.uiState.value.query.tools)
        assertEquals("session", viewModel.uiState.value.query.search)
        assertTrue(viewModel.uiState.value.dayReviewReturn == null)
    }

    @Test
    fun presetReusesMainResponseForCalendarWithoutAnAuxiliaryRequest() = runTest {
        val repository = QueryRepository { session, query, _ -> session to stats(100, query) }
        val viewModel = viewModel(repository, QueryCache())
        runCurrent()

        assertEquals(1, repository.requests.size)
        val calendar = viewModel.uiState.value.calendarHeatmap as CalendarHeatmapUiState.Available
        assertEquals(DashboardQuery(), calendar.query)
        assertEquals(mapOf("2026-07-01" to 1L, "2026-07-15" to 2L), calendar.heatmap)
        assertFalse(calendar.showingCachedData)
    }

    @Test
    fun customRangeLoadsIndependentFullTargetYearCalendarAndPreservesFilters() = runTest {
        val repository = QueryRepository { session, query, _ ->
            val response = if (query.start == "2025-01-01" && query.end == "2025-12-31") {
                stats(900, query).copy(heatmap = mapOf("2025-02-03" to 77L))
            } else if (query.range == RangeKey.Custom) {
                stats(123, query).copy(heatmap = mapOf(requireNotNull(query.end) to 3L))
            } else {
                stats(123, query)
            }
            session to response
        }
        val viewModel = viewModel(repository, QueryCache())
        runCurrent()
        viewModel.toggleMachine("studio")
        viewModel.toggleTool("codex")
        viewModel.setSearch("session")
        runCurrent()
        val before = repository.requests.size

        viewModel.selectCustomRange("2025-04-03", "2025-04-03")
        runCurrent()

        val requests = repository.requests.drop(before)
        assertEquals(2, requests.size)
        val calendarRequest = requests.single { it.query.start == "2025-01-01" }
        assertEquals("2025-12-31", calendarRequest.query.end)
        assertEquals(listOf("studio"), calendarRequest.query.machines)
        assertEquals(listOf("codex"), calendarRequest.query.tools)
        assertEquals("session", calendarRequest.query.search)
        assertEquals(123L, viewModel.uiState.value.data?.summary?.effectiveTokens)
        val calendar = viewModel.uiState.value.calendarHeatmap as CalendarHeatmapUiState.Available
        assertEquals(mapOf("2025-02-03" to 77L), calendar.heatmap)
        assertEquals(calendarRequest.query, calendar.query)
    }

    @Test
    fun currentOrFutureCustomEndClipsCalendarQueryToToday() {
        val query = DashboardQuery(
            range = RangeKey.Custom,
            start = "2026-07-01",
            end = "2027-01-01",
            machines = listOf("studio")
        )

        assertEquals(
            query.copy(start = "2026-01-01", end = "2026-07-15"),
            calendarHeatmapQuery(query, LocalDate.of(2026, 7, 15))
        )
    }

    @Test
    fun calendarAuxiliaryFailureDoesNotReplaceSuccessfulMainResponse() = runTest {
        val repository = QueryRepository { session, query, _ ->
            if (query.start == "2025-01-01") throw IOException("calendar unavailable")
            session to stats(123, query)
        }
        val viewModel = viewModel(repository, QueryCache())
        runCurrent()

        viewModel.selectCustomRange("2025-04-03", "2025-04-03")
        runCurrent()

        val state = viewModel.uiState.value
        assertEquals(123L, state.data?.summary?.effectiveTokens)
        assertNull(state.error)
        assertTrue(state.calendarHeatmap is CalendarHeatmapUiState.Unavailable)
    }

    @Test
    fun lateOlderCalendarResponseCannotReplaceLatestSelectedYear() = runTest {
        val oldYear = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val repository = QueryRepository { session, query, _ ->
            when {
                query.start == "2025-01-01" -> oldYear.awaitIgnoringCancellation()
                query.start == "2024-01-01" -> session to stats(400, query).copy(
                    heatmap = mapOf("2024-03-01" to 44L)
                )
                else -> session to stats(100, query)
            }
        }
        val viewModel = viewModel(repository, QueryCache())
        runCurrent()

        viewModel.selectCustomRange("2025-04-03", "2025-04-03")
        viewModel.selectCustomRange("2024-04-03", "2024-04-03")
        runCurrent()
        oldYear.complete(
            SESSION to stats(
                500,
                DashboardQuery(range = RangeKey.Custom, start = "2025-01-01", end = "2025-12-31")
            ).copy(heatmap = mapOf("2025-03-01" to 55L))
        )
        runCurrent()

        val calendar = viewModel.uiState.value.calendarHeatmap as CalendarHeatmapUiState.Available
        assertEquals("2024-01-01", calendar.query.start)
        assertEquals(mapOf("2024-03-01" to 44L), calendar.heatmap)
    }

    @Test
    fun rapidDayChangesKeepFirstGlobalSnapshotAndIgnoreCancelledOlderSuccess() = runTest {
        val dayA = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val dayB = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val repository = QueryRepository { session, query, _ ->
            when (query.start) {
                "2026-07-10" -> dayA.awaitIgnoringCancellation()
                "2026-07-11" -> dayB.await()
                else -> session to stats(900, query)
            }
        }
        val viewModel = viewModel(repository, QueryCache())
        runCurrent()
        viewModel.selectRange(RangeKey.Month)
        viewModel.selectSection(DashboardSection.Trends)
        viewModel.toggleMachine("studio")
        viewModel.setSearch("session")
        runCurrent()

        viewModel.openDayDetails("2026-07-10")
        viewModel.openDayDetails("2026-07-11")
        dayB.complete(SESSION to stats(222, dayQuery("2026-07-11", listOf("studio"), "session")))
        dayA.complete(SESSION to stats(111, dayQuery("2026-07-10", listOf("studio"), "session")))
        runCurrent()

        val state = viewModel.uiState.value
        assertEquals("2026-07-11", state.query.start)
        assertEquals(222L, state.data?.summary?.effectiveTokens)
        assertEquals(RangeKey.Month, state.dayReviewReturn?.query?.range)
        assertEquals(DashboardSection.Trends, state.dayReviewReturn?.section)
        assertEquals(listOf("studio"), state.query.machines)
        assertEquals("session", state.query.search)
    }

    @Test
    fun dayReviewRestoresOriginalEntityAndContributionMode() = runTest {
        val repository = QueryRepository { session, query, _ -> session to stats(100, query) }
        val viewModel = viewModel(repository, QueryCache())
        runCurrent()
        viewModel.selectRange(RangeKey.Month)
        viewModel.selectContributionMode(ContributionMode.Models)
        viewModel.openTool("codex")
        runCurrent()
        val originalQuery = viewModel.uiState.value.query
        val originalEntity = viewModel.uiState.value.entity

        viewModel.openDayDetails("2026-07-12")
        runCurrent()
        assertEquals(originalEntity, viewModel.uiState.value.entity)
        assertEquals(originalQuery.tools, viewModel.uiState.value.query.tools)

        viewModel.returnFromDayDetails()
        runCurrent()
        assertEquals(DashboardSection.Entity, viewModel.uiState.value.section)
        assertEquals(originalEntity, viewModel.uiState.value.entity)
        assertEquals(originalQuery, viewModel.uiState.value.query)
        assertEquals(ContributionMode.Models, viewModel.uiState.value.contributionMode)
    }

    @Test
    fun leavingDayReviewRejectsLateSuccessFailureAndPagination() = runTest {
        val lateDay = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val latePage = CompletableDeferred<Pair<MobileSession, UsageDetailsPage>>()
        val repository = QueryRepository(
            fetch = { session, query, _ ->
                if (query.range == RangeKey.Custom) lateDay.awaitIgnoringCancellation()
                else session to stats(900, query)
            },
            fetchNext = { _, _, _, _ -> latePage.awaitIgnoringCancellation() }
        )
        val viewModel = viewModel(repository, QueryCache())
        runCurrent()
        viewModel.selectRange(RangeKey.Month)
        runCurrent()
        viewModel.openDayDetails("2026-07-12")
        lateDay.complete(
            SESSION to stats(120, dayQuery("2026-07-12")).copy(
                detailsPage = detailsPage(nextCursor = "next"),
                capabilities = DashboardCapabilities(details = true)
            )
        )
        runCurrent()
        viewModel.loadMoreDetails()
        runCurrent()

        assertTrue(viewModel.restoreGlobalQueryFromDayReview())
        runCurrent()
        latePage.complete(SESSION to detailsPage(nextCursor = null, id = 2L))
        runCurrent()

        assertEquals(RangeKey.Month, viewModel.uiState.value.query.range)
        assertEquals(900L, viewModel.uiState.value.data?.summary?.effectiveTokens)
        assertNull(viewModel.uiState.value.paginationError)
        assertFalse(viewModel.restoreGlobalQueryFromDayReview())
    }

    @Test
    fun leavingDayReviewRejectsLateFailureAndSectionSelectionRestoresGlobal() = runTest {
        val lateFailure = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val repository = QueryRepository { session, query, _ ->
            if (query.range == RangeKey.Custom) lateFailure.awaitIgnoringCancellation()
            else session to stats(900, query)
        }
        val viewModel = viewModel(repository, QueryCache())
        runCurrent()
        viewModel.selectRange(RangeKey.Month)
        runCurrent()
        viewModel.openDayDetails("2026-07-12")
        viewModel.selectSection(DashboardSection.Contributions)
        runCurrent()
        lateFailure.completeExceptionally(IOException("late failure"))
        runCurrent()

        assertEquals(DashboardSection.Contributions, viewModel.uiState.value.section)
        assertEquals(RangeKey.Month, viewModel.uiState.value.query.range)
        assertEquals(900L, viewModel.uiState.value.data?.summary?.effectiveTokens)
        assertNull(viewModel.uiState.value.error)
    }

    @Test
    fun dayReviewRejectsUntrustedAndFutureDatesWithoutStartingRequests() = runTest {
        var trusted = false
        val repository = QueryRepository { session, query, _ ->
            session to if (trusted) stats(100, query) else stats(100, query).copy(meta = null)
        }
        val viewModel = viewModel(repository, QueryCache())
        runCurrent()
        val afterInitial = repository.requests.size

        assertFalse(viewModel.openDayDetails("2026-07-12"))
        assertEquals(afterInitial, repository.requests.size)
        assertEquals(RangeKey.Today, viewModel.uiState.value.query.range)

        trusted = true
        viewModel.selectRange(RangeKey.Month)
        runCurrent()
        val afterTrusted = repository.requests.size
        assertFalse(viewModel.openDayDetails("2026-07-16"))
        assertEquals(afterTrusted, repository.requests.size)
        assertEquals(RangeKey.Month, viewModel.uiState.value.query.range)
        assertTrue(viewModel.uiState.value.error?.message?.isNotBlank() == true)
    }

    @Test
    fun failedDayReviewCanRetrySameTrustedDay() = runTest {
        var attempts = 0
        val repository = QueryRepository { session, query, _ ->
            if (query.range == RangeKey.Custom && attempts++ == 0) throw IOException("offline")
            session to stats(if (query.range == RangeKey.Custom) 321 else 900, query)
        }
        val viewModel = viewModel(repository, QueryCache())
        runCurrent()
        viewModel.selectRange(RangeKey.Month)
        runCurrent()
        viewModel.openDayDetails("2026-07-12")
        runCurrent()
        assertTrue(viewModel.uiState.value.error is DashboardUiError.Network)

        viewModel.refresh()
        runCurrent()
        assertEquals(2, attempts)
        assertEquals(321L, viewModel.uiState.value.data?.summary?.effectiveTokens)
        assertNull(viewModel.uiState.value.error)
    }

    @Test
    fun returningWithNoCacheKeepsGlobalFrameWhileRefreshWaitsAndFails() = runTest {
        val refresh = CompletableDeferred<Pair<MobileSession, StatsData>>()
        var returning = false
        val repository = QueryRepository { session, query, _ ->
            when {
                query.range == RangeKey.Custom -> session to stats(12, query)
                returning -> refresh.await()
                else -> session to stats(900, query)
            }
        }
        // QueryCache.load always returns null: the visible global frame is the only fallback.
        val viewModel = viewModel(repository, QueryCache())
        runCurrent()
        viewModel.selectRange(RangeKey.Month)
        runCurrent()
        val global = viewModel.uiState.value
        assertTrue(viewModel.openDayDetails("2026-07-12"))
        runCurrent()
        assertEquals(12L, viewModel.uiState.value.visibleData?.summary?.effectiveTokens)

        returning = true
        viewModel.returnFromDayDetails()
        val immediate = viewModel.uiState.value
        assertEquals(global.query, immediate.query)
        assertEquals(global.visibleData, immediate.visibleData)
        assertEquals(global.lastUpdatedEpochMillis, immediate.lastUpdatedEpochMillis)
        assertEquals(global.showingCachedData, immediate.showingCachedData)
        assertEquals(DashboardLoadingMode.Refreshing, immediate.loadingMode)
        runCurrent()
        assertEquals(900L, viewModel.uiState.value.visibleData?.summary?.effectiveTokens)

        refresh.completeExceptionally(IOException("return refresh unavailable"))
        runCurrent()
        assertEquals(global.visibleData, viewModel.uiState.value.visibleData)
        assertEquals(global.lastUpdatedEpochMillis, viewModel.uiState.value.lastUpdatedEpochMillis)
        assertTrue(viewModel.uiState.value.error is DashboardUiError.Network)
        assertNull(viewModel.uiState.value.dayReviewReturn)
    }

    private fun viewModel(repository: QueryRepository, cache: QueryCache): DashboardViewModel =
        DashboardViewModel(
            repository = repository,
            cache = cache,
            timeProvider = QueryTimeProvider,
            automaticRefreshEnabled = false
        )

    private fun stats(tokens: Long, query: DashboardQuery): StatsData = StatsData(
        summary = Summary(totalTokens = tokens, inputTokens = tokens),
        tools = emptyMap(),
        models = emptyMap(),
        trends = emptyList(),
        heatmap = mapOf("2026-07-01" to 1L, "2026-07-15" to 2L),
        history = emptyList(),
        machines = listOf("mac", "studio"),
        meta = StatsMeta(
            generatedAt = "2026-07-15T12:00:00+08:00",
            lastRefreshedAt = null,
            timezone = "Asia/Shanghai",
            range = query.range.rpcValue,
            machine = query.machine,
            stale = false,
            contractVersion = 2,
            query = StatsQueryEcho(
                range = query.range.rpcValue,
                timezone = "Asia/Shanghai",
                machines = query.machines,
                tools = query.tools,
                models = query.models,
                search = query.search,
                start = query.start,
                end = query.end,
                tokenMode = query.tokenMode
            )
        ),
        capabilities = DashboardCapabilities(details = true, multiFilterSearch = true)
    )

    private fun dayQuery(
        date: String,
        machines: List<String> = emptyList(),
        search: String? = null
    ) = DashboardQuery(
        range = RangeKey.Custom,
        start = date,
        end = date,
        machines = machines,
        search = search
    )

    private fun detailsPage(nextCursor: String?, id: Long = 1L) = UsageDetailsPage(
        items = listOf(
            LogHistoryItem(
                id = id,
                tool = "codex",
                model = "gpt-5",
                inputTokens = 1,
                outputTokens = 1,
                cachedTokens = 0,
                cost = 0.0,
                timestamp = "2026-07-12T00:00:00+08:00",
                sessionId = "s-$id",
                machineId = "mac"
            )
        ),
        nextCursor = nextCursor,
        hasMore = nextCursor != null,
        totalCount = 2,
        filteredSummary = Summary(inputTokens = 2),
        availableFilters = AvailableFilters()
    )

    private suspend fun <T> CompletableDeferred<T>.awaitIgnoringCancellation(): T =
        suspendCoroutine { continuation ->
            invokeOnCompletion { continuation.resumeWith(runCatching { getCompleted() }) }
        }

    private data class Request(val query: DashboardQuery, val entity: DashboardEntity?)

    private class QueryRepository(
        private val fetchNext: suspend (
            MobileSession,
            DashboardQuery,
            DashboardEntity?,
            String
        ) -> Pair<MobileSession, UsageDetailsPage> = { _, _, _, _ ->
            throw DashboardCapabilityException("not available")
        },
        private val fetch: suspend (
            MobileSession,
            DashboardQuery,
            DashboardEntity?
        ) -> Pair<MobileSession, StatsData>
    ) : DashboardDataSource {
        override val isConfigured: Boolean = true
        val requests = mutableListOf<Request>()

        override suspend fun restoreSession(): MobileSession = SESSION

        var signInSession = SESSION

        override suspend fun signIn(email: String, password: String): MobileSession = signInSession

        override suspend fun persistSession(session: MobileSession) = Unit

        override suspend fun clearSession() = Unit

        override suspend fun fetchStats(
            session: MobileSession,
            range: RangeKey,
            machine: String
        ): Pair<MobileSession, StatsData> = fetch(
            session,
            DashboardQuery(range = range, machine = machine),
            null
        )

        override suspend fun fetchStats(
            session: MobileSession,
            query: DashboardQuery,
            entity: DashboardEntity?
        ): Pair<MobileSession, StatsData> {
            requests += Request(query, entity)
            return fetch(session, query, entity)
        }

        override suspend fun fetchNextDetails(
            session: MobileSession,
            query: DashboardQuery,
            entity: DashboardEntity?,
            cursor: String
        ): Pair<MobileSession, UsageDetailsPage> = fetchNext(session, query, entity, cursor)
    }

    private class QueryCache(
        private val onLoad: (DashboardCacheKey) -> DashboardCachedSnapshot? = { null }
    ) : DashboardSnapshotStore {
        val saved = mutableListOf<DashboardCacheKey>()
        val loaded = mutableListOf<DashboardCacheKey>()

        override suspend fun load(key: DashboardCacheKey): DashboardCachedSnapshot? {
            loaded += key
            return onLoad(key)
        }

        override suspend fun save(
            key: DashboardCacheKey,
            snapshot: DashboardCachedSnapshot,
            requestId: Long
        ) {
            saved += key
        }

        override suspend fun clearUser(userId: String) = Unit
    }

    private data object QueryTimeProvider : DashboardTimeProvider {
        override fun nowEpochMillis(): Long = 1_750_000_100_000L

        override fun currentDate(): LocalDate = LocalDate.of(2026, 7, 15)

        override fun timezoneId(): String = "Asia/Shanghai"

        override fun millisUntilNextMidnight(): Long = 60_000L
    }

    private companion object {
        val SESSION = MobileSession(
            accessToken = "access",
            refreshToken = "refresh",
            userId = "user-1",
            email = "user@example.com",
            expiresAtEpochSeconds = Long.MAX_VALUE
        )
    }
}
