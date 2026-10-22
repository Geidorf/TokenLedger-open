package com.jeidorf.tokenledger.mobile

import java.io.IOException
import java.time.LocalDate
import kotlin.coroutines.resume
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
class DashboardViewModelTest {
    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun rapidRangeChangesAreLatestWinsEvenWhenOldCallFinishesLate() = runTest {
        val todayResult = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val weekResult = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val repository = FakeDashboardRepository { session, range, _ ->
            when (range) {
                RangeKey.Today -> todayResult.awaitIgnoringCancellation()
                RangeKey.Week -> weekResult.await()
                else -> session to stats(0)
            }
        }
        val viewModel = viewModel(repository)

        viewModel.selectRange(RangeKey.Week)
        weekResult.complete(SESSION to stats(200))
        todayResult.complete(SESSION to stats(100))
        runCurrent()

        assertEquals(RangeKey.Week, viewModel.uiState.value.query.range)
        assertEquals(200L, viewModel.uiState.value.data?.summary?.totalTokens)
        assertEquals(DashboardLoadingMode.Idle, viewModel.uiState.value.loadingMode)
    }

    @Test
    fun repeatedRefreshOfSameQueryRejectsLateUiSessionAndCacheCommits() = runTest {
        val firstResult = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val secondResult = CompletableDeferred<Pair<MobileSession, StatsData>>()
        var requestCount = 0
        val repository = FakeDashboardRepository { _, _, _ ->
            requestCount += 1
            if (requestCount == 1) {
                firstResult.awaitIgnoringCancellation()
            } else {
                secondResult.await()
            }
        }
        val cache = FakeDashboardCache()
        val viewModel = viewModel(repository, cache)

        viewModel.refresh()
        secondResult.complete(REFRESHED_SESSION_2 to stats(200))
        firstResult.complete(REFRESHED_SESSION_1 to stats(100))
        runCurrent()

        assertEquals(200L, viewModel.uiState.value.data?.summary?.totalTokens)
        assertEquals(REFRESHED_SESSION_2, viewModel.uiState.value.session)
        assertEquals(listOf(REFRESHED_SESSION_2), repository.persistedSessions)
        assertEquals(1, cache.savedSnapshots.size)
        assertEquals(200L, cache.savedSnapshots.single().snapshot.stats.summary.totalTokens)
        assertTrue(cache.savedSnapshots.single().requestId > 0L)
    }

    @Test
    fun signOutGenerationRejectsAResponseThatIgnoresCancellation() = runTest {
        val lateResult = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val repository = FakeDashboardRepository { _, _, _ ->
            lateResult.awaitIgnoringCancellation()
        }
        val cache = FakeDashboardCache()
        val viewModel = viewModel(repository, cache)

        viewModel.signOut()
        lateResult.complete(SESSION to stats(999))
        runCurrent()

        assertEquals(DashboardSessionState.SignedOut, viewModel.uiState.value.sessionState)
        assertNull(viewModel.uiState.value.visibleData)
        assertEquals(1, repository.clearSessionCalls)
        assertEquals(listOf(SESSION.userId), cache.clearedUsers)
    }

    @Test
    fun signOutGenerationAlsoRejectsLateSessionRestore() = runTest {
        val restoredSession = CompletableDeferred<MobileSession?>()
        val repository = FakeDashboardRepository(
            fetch = { session, _, _ -> session to stats(1) },
            restore = { restoredSession.awaitIgnoringCancellation() }
        )
        val viewModel = viewModel(repository)

        viewModel.signOut()
        restoredSession.complete(SESSION)
        runCurrent()

        assertEquals(DashboardSessionState.SignedOut, viewModel.uiState.value.sessionState)
        assertNull(viewModel.uiState.value.session)
        assertEquals(1, repository.clearSessionCalls)
    }

    @Test
    fun authExpiryUsesDedicatedStateAndClearsSessionData() = runTest {
        val repository = FakeDashboardRepository { _, _, _ ->
            throw DashboardAuthExpiredException()
        }
        val cache = FakeDashboardCache()
        val viewModel = viewModel(repository, cache)
        runCurrent()

        assertTrue(viewModel.uiState.value.sessionState is DashboardSessionState.Expired)
        assertNull(viewModel.uiState.value.session)
        assertNull(viewModel.uiState.value.visibleData)
        assertEquals(1, repository.clearSessionCalls)
        assertEquals(listOf(SESSION.userId), cache.clearedUsers)
    }

    @Test
    fun signOutRejectsLateSignInBeforeItCanPersistTheSession() = runTest {
        val lateSignIn = CompletableDeferred<MobileSession>()
        val repository = FakeDashboardRepository(
            fetch = { session, _, _ -> session to stats(1) },
            restore = { null },
            signInRequest = { _, _ -> lateSignIn.awaitIgnoringCancellation() }
        )
        val viewModel = viewModel(repository)

        viewModel.signIn("old@example.com", "secret")
        viewModel.signOut()
        lateSignIn.complete(OTHER_USER_SESSION)
        runCurrent()

        assertEquals(DashboardSessionState.SignedOut, viewModel.uiState.value.sessionState)
        assertTrue(repository.persistedSessions.isEmpty())
        assertEquals(2, repository.clearSessionCalls)
    }

    @Test
    fun signOutClearIsOrderedAfterAnInFlightPersistThatIgnoresCancellation() = runTest {
        val persistStarted = CompletableDeferred<Unit>()
        val finishPersist = CompletableDeferred<Unit>()
        val repository = FakeDashboardRepository(
            fetch = { session, _, _ -> session to stats(1) },
            restore = { null },
            signInRequest = { _, _ -> OTHER_USER_SESSION },
            beforePersist = {
                persistStarted.complete(Unit)
                finishPersist.awaitIgnoringCancellation()
            }
        )
        val viewModel = viewModel(repository)

        viewModel.signIn("other@example.com", "secret")
        persistStarted.await()
        viewModel.signOut()
        finishPersist.complete(Unit)
        runCurrent()

        assertEquals(DashboardSessionState.SignedOut, viewModel.uiState.value.sessionState)
        assertNull(repository.storedSession)
        assertEquals(2, repository.clearSessionCalls)
    }

    @Test
    fun accountSwitchRejectsLateOldAccountSessionPersistence() = runTest {
        val oldAccount = CompletableDeferred<MobileSession>()
        val newAccount = CompletableDeferred<MobileSession>()
        var signInCount = 0
        val repository = FakeDashboardRepository(
            fetch = { session, _, _ -> session to stats(1) },
            restore = { null },
            signInRequest = { _, _ ->
                signInCount += 1
                if (signInCount == 1) {
                    oldAccount.awaitIgnoringCancellation()
                } else {
                    newAccount.await()
                }
            }
        )
        val viewModel = viewModel(repository)

        viewModel.signIn("old@example.com", "secret")
        viewModel.signIn("new@example.com", "secret")
        newAccount.complete(OTHER_USER_SESSION)
        oldAccount.complete(SESSION)
        runCurrent()

        assertEquals(OTHER_USER_SESSION, viewModel.uiState.value.session)
        assertEquals(listOf(OTHER_USER_SESSION), repository.persistedSessions)
        assertEquals(2, repository.clearSessionCalls)
    }

    @Test
    fun encryptedSnapshotIsShownWhenNetworkRefreshFails() = runTest {
        val cachedStats = stats(321)
        val cache = FakeDashboardCache(
            loadResult = DashboardCachedSnapshot(
                stats = cachedStats,
                savedAtEpochMillis = 1_750_000_000_000L
            )
        )
        val repository = FakeDashboardRepository { _, _, _ ->
            throw IOException("offline")
        }
        val viewModel = viewModel(repository, cache)
        runCurrent()

        assertEquals(cachedStats, viewModel.uiState.value.visibleData)
        assertTrue(viewModel.uiState.value.showingCachedData)
        assertEquals(1_750_000_000_000L, viewModel.uiState.value.lastUpdatedEpochMillis)
        assertTrue(viewModel.uiState.value.error is DashboardUiError.Network)
        assertTrue(viewModel.uiState.value.userVisibleError?.contains("网络不可用") == true)
        assertTrue(viewModel.uiState.value.userVisibleError?.contains("正在显示") == true)
    }

    @Test
    fun entityDrillDownRestoresPreviousQueryAndSectionOnBack() = runTest {
        val repository = FakeDashboardRepository { session, _, _ -> session to stats(100) }
        val viewModel = viewModel(repository)
        runCurrent()

        viewModel.openTool("codex")
        runCurrent()
        assertEquals(DashboardSection.Entity, viewModel.uiState.value.section)
        assertEquals("codex", viewModel.uiState.value.query.tool)
        assertEquals(1, viewModel.uiState.value.navigationStack.size)
        assertEquals("codex", repository.fetchedQueries.last().tool)

        viewModel.navigateBack()
        runCurrent()
        assertEquals(DashboardSection.Overview, viewModel.uiState.value.section)
        assertNull(viewModel.uiState.value.query.tool)
        assertTrue(viewModel.uiState.value.navigationStack.isEmpty())
    }

    @Test
    fun nestedEntityDrillDownReturnsOneLevelAtATime() = runTest {
        val repository = FakeDashboardRepository { session, _, _ -> session to stats(100) }
        val viewModel = viewModel(repository)
        runCurrent()

        viewModel.openTool("codex")
        runCurrent()
        viewModel.openModel("gpt-5")
        runCurrent()

        assertEquals(DashboardSection.Entity, viewModel.uiState.value.section)
        assertEquals("codex", viewModel.uiState.value.query.tool)
        assertEquals("gpt-5", viewModel.uiState.value.query.model)
        assertEquals(2, viewModel.uiState.value.navigationStack.size)

        viewModel.navigateBack()
        runCurrent()
        assertEquals(DashboardSection.Entity, viewModel.uiState.value.section)
        assertEquals("codex", viewModel.uiState.value.query.tool)
        assertNull(viewModel.uiState.value.query.model)
        assertEquals(1, viewModel.uiState.value.navigationStack.size)

        viewModel.navigateBack()
        runCurrent()
        assertEquals(DashboardSection.Overview, viewModel.uiState.value.section)
        assertNull(viewModel.uiState.value.query.tool)
        assertNull(viewModel.uiState.value.query.model)
        assertTrue(viewModel.uiState.value.navigationStack.isEmpty())
    }

    @Test
    fun detailsPaginationAppendsRowsAndPersistsTheExpandedSnapshot() = runTest {
        val first = detailsPage(id = 2, cursor = "v1.next", hasMore = true)
        val next = detailsPage(id = 1, cursor = null, hasMore = false)
        val repository = FakeDashboardRepository(
            nextDetailsRequest = { session, _, cursor ->
                assertEquals("v1.next", cursor)
                session to next
            }
        ) { session, _, _ ->
            session to stats(100).copy(
                history = first.items,
                detailsPage = first,
                capabilities = DashboardCapabilities(details = true)
            )
        }
        val cache = FakeDashboardCache()
        val viewModel = viewModel(repository, cache)
        runCurrent()

        viewModel.loadMoreDetails()
        runCurrent()

        val merged = viewModel.uiState.value.data?.detailsPage
        assertEquals(listOf(2L, 1L), merged?.items?.map { it.id })
        assertTrue(merged?.hasMore == false)
        assertEquals(2, cache.savedSnapshots.size)
        assertEquals(2, cache.savedSnapshots.last().snapshot.stats.detailsPage?.items?.size)
    }

    @Test
    fun queryTransitionBlocksPaginationFromUsingThePreviousSnapshotCursor() = runTest {
        val firstPage = detailsPage(id = 2, cursor = "v1.next", hasMore = true)
        val weekResult = CompletableDeferred<Pair<MobileSession, StatsData>>()
        var paginationCalls = 0
        val repository = FakeDashboardRepository(
            nextDetailsRequest = { session, _, _ ->
                paginationCalls += 1
                session to detailsPage(id = 1, cursor = null, hasMore = false)
            }
        ) { session, range, _ ->
            if (range == RangeKey.Week) weekResult.await()
            else session to stats(100).copy(
                history = firstPage.items,
                detailsPage = firstPage,
                capabilities = DashboardCapabilities(details = true)
            )
        }
        val cache = FakeDashboardCache()
        val viewModel = viewModel(repository, cache)
        runCurrent()

        viewModel.selectRange(RangeKey.Week)
        viewModel.loadMoreDetails()
        runCurrent()
        assertEquals(0, paginationCalls)

        weekResult.complete(SESSION to stats(200))
        runCurrent()
        assertEquals(200L, viewModel.uiState.value.data?.summary?.totalTokens)
        assertEquals(RangeKey.Week, cache.savedSnapshots.last().key.range)
        assertEquals(200L, cache.savedSnapshots.last().snapshot.stats.summary.totalTokens)
        assertTrue(
            cache.savedSnapshots.none {
                it.key.range == RangeKey.Week && it.snapshot.stats.summary.totalTokens == 100L
            }
        )
    }

    @Test
    fun sameQueryRefreshBlocksPaginationWhileTheMainSnapshotIsBeingSaved() = runTest {
        val firstPage = detailsPage(id = 2, cursor = "v1.next", hasMore = true)
        val refreshSaveStarted = CompletableDeferred<Unit>()
        val releaseRefreshSave = CompletableDeferred<Unit>()
        var fetchCalls = 0
        var saveCalls = 0
        var paginationCalls = 0
        val repository = FakeDashboardRepository(
            nextDetailsRequest = { session, _, _ ->
                paginationCalls += 1
                session to detailsPage(id = 1, cursor = null, hasMore = false)
            }
        ) { session, _, _ ->
            fetchCalls += 1
            if (fetchCalls == 1) {
                session to stats(100).copy(
                    history = firstPage.items,
                    detailsPage = firstPage,
                    capabilities = DashboardCapabilities(details = true)
                )
            } else {
                session to stats(200).copy(
                    history = firstPage.items,
                    detailsPage = firstPage,
                    capabilities = DashboardCapabilities(details = true)
                )
            }
        }
        val cache = FakeDashboardCache { _ ->
            saveCalls += 1
            if (saveCalls == 2) {
                refreshSaveStarted.complete(Unit)
                releaseRefreshSave.await()
            }
        }
        val viewModel = viewModel(repository, cache)
        runCurrent()

        viewModel.refresh()
        refreshSaveStarted.await()
        assertEquals(DashboardLoadingMode.Idle, viewModel.uiState.value.loadingMode)
        viewModel.loadMoreDetails()
        runCurrent()
        assertEquals(0, paginationCalls)

        releaseRefreshSave.complete(Unit)
        runCurrent()
        assertEquals(2, cache.savedSnapshots.size)
        assertEquals(200L, cache.savedSnapshots.last().snapshot.stats.summary.totalTokens)
        assertTrue(cache.savedSnapshots.last().requestId > cache.savedSnapshots.first().requestId)
    }

    @Test
    fun detailsPaginationFailureExposesErrorAndCanBeRetried() = runTest {
        val first = detailsPage(id = 2, cursor = "v1.next", hasMore = true)
        val next = detailsPage(id = 1, cursor = null, hasMore = false)
        var attempts = 0
        val repository = FakeDashboardRepository(
            nextDetailsRequest = { session, _, cursor ->
                assertEquals("v1.next", cursor)
                attempts += 1
                if (attempts == 1) throw IllegalStateException("网络暂时不可用")
                session to next
            }
        ) { session, _, _ ->
            session to stats(100).copy(
                history = first.items,
                detailsPage = first,
                capabilities = DashboardCapabilities(details = true)
            )
        }
        val viewModel = viewModel(repository)
        runCurrent()

        viewModel.loadMoreDetails()
        runCurrent()

        assertFalse(viewModel.uiState.value.loadingMore)
        assertEquals("网络暂时不可用", viewModel.uiState.value.paginationError)

        viewModel.loadMoreDetails()
        runCurrent()

        assertEquals(2, attempts)
        assertNull(viewModel.uiState.value.paginationError)
        assertEquals(listOf(2L, 1L), viewModel.uiState.value.data?.detailsPage?.items?.map { it.id })
    }

    @Test
    fun v2EmptyMachineFilterIsPreservedForAnHonestEmptyState() = runTest {
        val emptyPage = UsageDetailsPage(
            items = emptyList(),
            nextCursor = null,
            hasMore = false,
            totalCount = 0,
            filteredSummary = Summary(),
            availableFilters = AvailableFilters()
        )
        val repository = FakeDashboardRepository { session, _, _ ->
            session to stats(0).copy(
                machines = emptyList(),
                detailsPage = emptyPage,
                capabilities = DashboardCapabilities(details = true)
            )
        }
        val viewModel = viewModel(repository)
        runCurrent()

        viewModel.selectMachine("offline-laptop")
        runCurrent()

        assertEquals("offline-laptop", viewModel.uiState.value.query.machine)
        assertEquals(0L, viewModel.uiState.value.data?.detailsPage?.totalCount)
    }

    private fun viewModel(
        repository: FakeDashboardRepository,
        cache: FakeDashboardCache = FakeDashboardCache()
    ): DashboardViewModel = DashboardViewModel(
        repository = repository,
        cache = cache,
        timeProvider = FakeTimeProvider,
        automaticRefreshEnabled = false
    )

    private fun stats(totalTokens: Long): StatsData = StatsData(
        summary = Summary(
            totalTokens = totalTokens,
            inputTokens = totalTokens,
            outputTokens = 0
        ),
        tools = emptyMap(),
        models = emptyMap(),
        trends = emptyList(),
        heatmap = emptyMap(),
        history = emptyList(),
        machines = listOf("machine-1"),
        meta = null
    )

    private fun detailsPage(id: Long, cursor: String?, hasMore: Boolean): UsageDetailsPage =
        UsageDetailsPage(
            items = listOf(
                LogHistoryItem(
                    id = id,
                    tool = "codex",
                    model = "gpt-5",
                    inputTokens = 8,
                    outputTokens = 2,
                    cachedTokens = 0,
                    cost = 0.1,
                    timestamp = "2026-07-15 0$id:00:00",
                    sessionId = "hour:$id",
                    machineId = "machine-1",
                    requests = 1
                )
            ),
            nextCursor = cursor,
            hasMore = hasMore,
            totalCount = 2,
            filteredSummary = Summary(inputTokens = 16, outputTokens = 4, totalRequests = 2),
            availableFilters = AvailableFilters()
        )

    /** Simulates a blocking transport that completes even after its coroutine Job is cancelled. */
    private suspend fun <T> CompletableDeferred<T>.awaitIgnoringCancellation(): T =
        suspendCoroutine { continuation ->
            invokeOnCompletion { continuation.resume(getCompleted()) }
        }

    private class FakeDashboardRepository(
        private val restore: suspend () -> MobileSession? = { SESSION },
        private val signInRequest: suspend (String, String) -> MobileSession = { _, _ -> SESSION },
        private val beforePersist: suspend (MobileSession) -> Unit = {},
        private val nextDetailsRequest: suspend (
            MobileSession,
            DashboardQuery,
            String
        ) -> Pair<MobileSession, UsageDetailsPage> = { _, _, _ ->
            throw DashboardCapabilityException("not available")
        },
        private val fetch: suspend (
            MobileSession,
            RangeKey,
            String
        ) -> Pair<MobileSession, StatsData>
    ) : DashboardDataSource {
        override val isConfigured: Boolean = true
        var clearSessionCalls: Int = 0
        val persistedSessions = mutableListOf<MobileSession>()
        val fetchedQueries = mutableListOf<DashboardQuery>()
        var storedSession: MobileSession? = null

        override suspend fun restoreSession(): MobileSession? = restore()

        override suspend fun signIn(email: String, password: String): MobileSession =
            signInRequest(email, password)

        override suspend fun persistSession(session: MobileSession) {
            beforePersist(session)
            persistedSessions += session
            storedSession = session
        }

        override suspend fun clearSession() {
            clearSessionCalls += 1
            storedSession = null
        }

        override suspend fun fetchStats(
            session: MobileSession,
            range: RangeKey,
            machine: String
        ): Pair<MobileSession, StatsData> = fetch(session, range, machine)

        override suspend fun fetchStats(
            session: MobileSession,
            query: DashboardQuery
        ): Pair<MobileSession, StatsData> {
            fetchedQueries += query
            return fetch(session, query.range, query.machine)
        }

        override suspend fun fetchNextDetails(
            session: MobileSession,
            query: DashboardQuery,
            cursor: String
        ): Pair<MobileSession, UsageDetailsPage> = nextDetailsRequest(session, query, cursor)

    }

    private data class SavedCacheSnapshot(
        val key: DashboardCacheKey,
        val snapshot: DashboardCachedSnapshot,
        val requestId: Long
    )

    private class FakeDashboardCache(
        var loadResult: DashboardCachedSnapshot? = null,
        private val beforeSave: suspend (SavedCacheSnapshot) -> Unit = {}
    ) : DashboardSnapshotStore {
        val clearedUsers = mutableListOf<String>()
        val savedSnapshots = mutableListOf<SavedCacheSnapshot>()

        override suspend fun load(key: DashboardCacheKey): DashboardCachedSnapshot? = loadResult

        override suspend fun save(
            key: DashboardCacheKey,
            snapshot: DashboardCachedSnapshot,
            requestId: Long
        ) {
            val saved = SavedCacheSnapshot(key, snapshot, requestId)
            beforeSave(saved)
            savedSnapshots += saved
        }

        override suspend fun clearUser(userId: String) {
            clearedUsers += userId
        }
    }

    private data object FakeTimeProvider : DashboardTimeProvider {
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
        val REFRESHED_SESSION_1 = SESSION.copy(
            accessToken = "access-1",
            refreshToken = "refresh-1"
        )
        val REFRESHED_SESSION_2 = SESSION.copy(
            accessToken = "access-2",
            refreshToken = "refresh-2"
        )
        val OTHER_USER_SESSION = MobileSession(
            accessToken = "other-access",
            refreshToken = "other-refresh",
            userId = "user-2",
            email = "other@example.com",
            expiresAtEpochSeconds = Long.MAX_VALUE
        )
    }
}
