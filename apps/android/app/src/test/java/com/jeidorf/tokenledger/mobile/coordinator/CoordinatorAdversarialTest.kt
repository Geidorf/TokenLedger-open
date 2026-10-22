package com.jeidorf.tokenledger.mobile.coordinator

import com.jeidorf.tokenledger.mobile.CalendarHeatmapUiState
import com.jeidorf.tokenledger.mobile.CanonicalDashboardQuery
import com.jeidorf.tokenledger.mobile.DashboardAuthExpiredException
import com.jeidorf.tokenledger.mobile.DashboardCacheKey
import com.jeidorf.tokenledger.mobile.DashboardCachedSnapshot
import com.jeidorf.tokenledger.mobile.DashboardDataSource
import com.jeidorf.tokenledger.mobile.DashboardEntity
import com.jeidorf.tokenledger.mobile.DashboardLoadingMode
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.DashboardRequestIdentity
import com.jeidorf.tokenledger.mobile.DashboardSessionState
import com.jeidorf.tokenledger.mobile.DashboardSnapshotStore
import com.jeidorf.tokenledger.mobile.DashboardTimeProvider
import com.jeidorf.tokenledger.mobile.MobileSession
import com.jeidorf.tokenledger.mobile.QUOTA_TRANSPORT_VERSION
import com.jeidorf.tokenledger.mobile.QuotaCacheKey
import com.jeidorf.tokenledger.mobile.QuotaCacheWriteIdentity
import com.jeidorf.tokenledger.mobile.QuotaCachedSnapshot
import com.jeidorf.tokenledger.mobile.QuotaCapability
import com.jeidorf.tokenledger.mobile.QuotaDataSource
import com.jeidorf.tokenledger.mobile.QuotaMode
import com.jeidorf.tokenledger.mobile.QuotaProviderEnvelope
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.QuotaScope
import com.jeidorf.tokenledger.mobile.QuotaSnapshotStore
import com.jeidorf.tokenledger.mobile.QuotaSource
import com.jeidorf.tokenledger.mobile.QuotaTransportSnapshot
import com.jeidorf.tokenledger.mobile.QuotaUiState
import com.jeidorf.tokenledger.mobile.QuotaUnit
import com.jeidorf.tokenledger.mobile.QuotaWindowSnapshot
import com.jeidorf.tokenledger.mobile.QuotaWindowStatus
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.StatsMeta
import com.jeidorf.tokenledger.mobile.StatsQueryEcho
import com.jeidorf.tokenledger.mobile.Summary
import com.jeidorf.tokenledger.mobile.UsageDetailsPage
import com.jeidorf.tokenledger.mobile.effectiveStatus
import com.jeidorf.tokenledger.mobile.nextFreshnessDeadline
import java.io.IOException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CoordinatorAdversarialTest {
    private val testDispatcher = StandardTestDispatcher()
    private val testScope = TestScope(testDispatcher)

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    // =========================================================================
    // Fake & Fixture Definitions
    // =========================================================================

    private class MutableTimeProvider(
        var epochMillis: Long = 1_750_000_100_000L,
        var date: LocalDate = LocalDate.of(2026, 7, 15),
        var tz: String = "Asia/Shanghai"
    ) : DashboardTimeProvider {
        override fun nowEpochMillis(): Long = epochMillis
        override fun currentDate(): LocalDate = date
        override fun timezoneId(): String = tz
        override fun millisUntilNextMidnight(): Long = 60_000L
    }

    private class FakeDashboardDataSource : DashboardDataSource {
        override val isConfigured: Boolean = true

        var onFetchStats: (suspend (MobileSession, DashboardQuery, DashboardEntity?) -> Pair<MobileSession, StatsData>)? = null
        var onFetchNextDetails: (suspend (MobileSession, DashboardQuery, DashboardEntity?, String) -> Pair<MobileSession, UsageDetailsPage>)? = null
        var onSignIn: (suspend (String, String) -> MobileSession)? = null
        var onRestoreSession: (suspend () -> MobileSession?)? = null

        val persistedSessions = mutableListOf<MobileSession>()
        var clearSessionCount = 0

        override suspend fun restoreSession(): MobileSession? =
            onRestoreSession?.invoke()

        override suspend fun signIn(email: String, password: String): MobileSession =
            onSignIn?.invoke(email, password) ?: DUMMY_SESSION.copy(email = email)

        override suspend fun persistSession(session: MobileSession) {
            persistedSessions.add(session)
        }

        override suspend fun clearSession() {
            clearSessionCount++
        }

        override suspend fun fetchStats(
            session: MobileSession,
            range: RangeKey,
            machine: String
        ): Pair<MobileSession, StatsData> =
            fetchStats(session, DashboardQuery(range = range, machine = machine), null)

        override suspend fun fetchStats(
            session: MobileSession,
            query: DashboardQuery
        ): Pair<MobileSession, StatsData> =
            fetchStats(session, query, null)

        override suspend fun fetchStats(
            session: MobileSession,
            query: DashboardQuery,
            entity: DashboardEntity?
        ): Pair<MobileSession, StatsData> =
            onFetchStats?.invoke(session, query, entity)
                ?: (session to createDummyStats(100L))

        override suspend fun fetchNextDetails(
            session: MobileSession,
            query: DashboardQuery,
            cursor: String
        ): Pair<MobileSession, UsageDetailsPage> =
            fetchNextDetails(session, query, null, cursor)

        override suspend fun fetchNextDetails(
            session: MobileSession,
            query: DashboardQuery,
            entity: DashboardEntity?,
            cursor: String
        ): Pair<MobileSession, UsageDetailsPage> =
            onFetchNextDetails?.invoke(session, query, entity, cursor)
                ?: (session to UsageDetailsPage(
                    items = emptyList(),
                    nextCursor = null,
                    hasMore = false,
                    totalCount = 0L,
                    filteredSummary = Summary(totalTokens = 0, inputTokens = 0, outputTokens = 0),
                    availableFilters = com.jeidorf.tokenledger.mobile.AvailableFilters()
                ))
    }

    private class FakeSnapshotStore : DashboardSnapshotStore {
        var onLoad: (suspend (DashboardCacheKey) -> DashboardCachedSnapshot?)? = null
        val savedSnapshots = mutableListOf<Pair<DashboardCacheKey, DashboardCachedSnapshot>>()
        val clearedUsers = mutableListOf<String>()

        override suspend fun load(key: DashboardCacheKey): DashboardCachedSnapshot? =
            onLoad?.invoke(key)

        override suspend fun save(key: DashboardCacheKey, snapshot: DashboardCachedSnapshot, requestId: Long) {
            savedSnapshots.add(key to snapshot)
        }

        override suspend fun clearUser(userId: String) {
            clearedUsers.add(userId)
        }
    }

    private class FakeQuotaRepository : QuotaDataSource {
        var onFetchQuotaSnapshots: (suspend (MobileSession) -> QuotaTransportSnapshot)? = null

        override suspend fun fetchQuotaSnapshots(session: MobileSession): QuotaTransportSnapshot =
            onFetchQuotaSnapshots?.invoke(session)
                ?: createDummyQuotaSnapshot(epoch = 1L, revision = 1L)
    }

    private class FakeQuotaStore : QuotaSnapshotStore {
        val savedSnapshots = mutableListOf<QuotaCachedSnapshot>()
        val invalidations = mutableListOf<Pair<QuotaCacheKey, QuotaCacheWriteIdentity>>()

        override suspend fun load(key: QuotaCacheKey, nowEpochMillis: Long): com.jeidorf.tokenledger.mobile.DecodedQuotaCache? = null

        override suspend fun save(
            key: QuotaCacheKey,
            snapshot: QuotaCachedSnapshot,
            identity: QuotaCacheWriteIdentity
        ) {
            savedSnapshots.add(snapshot)
        }

        override suspend fun invalidate(key: QuotaCacheKey, identity: QuotaCacheWriteIdentity) {
            invalidations.add(key to identity)
        }
    }

    // =========================================================================
    // TARGET 1: Concurrency & Latest-Wins in DashboardStatsCoordinator
    // =========================================================================

    @Test
    fun concurrentQueryTogglesNeverEmitStaleCacheAfterNewerQueryCompletes() = testScope.runTest {
        val repository = FakeDashboardDataSource()
        val cache = FakeSnapshotStore()
        val timeProvider = MutableTimeProvider()

        var currentSession: MobileSession? = DUMMY_SESSION
        var sessionGeneration = 1L

        val queryA = DashboardQuery(range = RangeKey.Today)
        val queryB = DashboardQuery(range = RangeKey.Week)

        val cacheDeferredA = CompletableDeferred<DashboardCachedSnapshot?>()
        val networkDeferredA = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val networkDeferredB = CompletableDeferred<Pair<MobileSession, StatsData>>()

        cache.onLoad = { key ->
            if (key.range == RangeKey.Today) {
                cacheDeferredA.await()
            } else {
                null
            }
        }

        repository.onFetchStats = { _, query, _ ->
            if (query.range == RangeKey.Today) {
                networkDeferredA.await()
            } else {
                networkDeferredB.await()
            }
        }

        val coordinator = DashboardStatsCoordinator(
            repository = repository,
            cache = cache,
            timeProvider = timeProvider,
            coroutineScope = this,
            getSessionGeneration = { sessionGeneration },
            getCurrentSession = { currentSession },
            onSessionPersist = { _, _ -> true },
            onSessionUpdated = { currentSession = it },
            onAuthExpired = {},
            onPresetCalendarPublish = { _, _, _ -> },
            onCalendarSynchronize = { _, _, _ -> },
            onQuotaTrigger = { _, _ -> },
            onFallbackQueryReset = {}
        )

        // Step 1: Start Query A (its cache load will suspend on cacheDeferredA)
        coordinator.startDashboardRequest(queryA, null)
        runCurrent()
        assertEquals(DashboardLoadingMode.InitialLoad, coordinator.statsState.value.loadingMode)
        assertNull(coordinator.statsState.value.visibleData)

        // Step 2: Quickly toggle to Query B before Query A finishes
        coordinator.startDashboardRequest(queryB, null)
        runCurrent()

        // Step 3: Query B network completes fast with fresh data (totalTokens = 200)
        networkDeferredB.complete(DUMMY_SESSION to createDummyStats(200L))
        runCurrent()

        // State must now reflect Query B's fresh data
        assertEquals(200L, coordinator.statsState.value.visibleData?.summary?.totalTokens)
        assertFalse(coordinator.statsState.value.showingCachedData)
        assertEquals(DashboardLoadingMode.Idle, coordinator.statsState.value.loadingMode)

        // Step 4: Now Query A's delayed cache load finishes with stale cached data (totalTokens = 100)
        cacheDeferredA.complete(DashboardCachedSnapshot(createDummyStats(100L), 1_000L))
        runCurrent()

        // EMPIRICAL CHALLENGE: Query B's fresh data must NOT be overwritten by Query A's stale cache!
        assertEquals(200L, coordinator.statsState.value.visibleData?.summary?.totalTokens)
        assertFalse(coordinator.statsState.value.showingCachedData)
        assertEquals(DashboardLoadingMode.Idle, coordinator.statsState.value.loadingMode)

        // Step 5: Query A's network call also finishes late
        networkDeferredA.complete(DUMMY_SESSION to createDummyStats(150L))
        runCurrent()

        // EMPIRICAL CHALLENGE: Query A's late network response must also be rejected
        assertEquals(200L, coordinator.statsState.value.visibleData?.summary?.totalTokens)
        assertFalse(coordinator.statsState.value.showingCachedData)
    }

    @Test
    fun rapidAlternatingQueriesAlwaysSettleOnLatestQuery() = testScope.runTest {
        val repository = FakeDashboardDataSource()
        val cache = FakeSnapshotStore()
        val timeProvider = MutableTimeProvider()

        var currentSession: MobileSession? = DUMMY_SESSION
        val sessionGeneration = 1L

        val queries = (1..10).map { i ->
            val startDay = String.format(java.util.Locale.US, "2026-07-%02d", i)
            val endDay = String.format(java.util.Locale.US, "2026-07-%02d", i + 10)
            DashboardQuery(range = RangeKey.Custom, start = startDay, end = endDay)
        }

        val deferreds = queries.map { CompletableDeferred<Pair<MobileSession, StatsData>>() }

        repository.onFetchStats = { _, query, _ ->
            val index = queries.indexOf(query)
            if (index >= 0) {
                deferreds[index].await()
            } else {
                DUMMY_SESSION to createDummyStats(0L)
            }
        }

        val coordinator = DashboardStatsCoordinator(
            repository = repository,
            cache = cache,
            timeProvider = timeProvider,
            coroutineScope = this,
            getSessionGeneration = { sessionGeneration },
            getCurrentSession = { currentSession },
            onSessionPersist = { _, _ -> true },
            onSessionUpdated = { currentSession = it },
            onAuthExpired = {},
            onPresetCalendarPublish = { _, _, _ -> },
            onCalendarSynchronize = { _, _, _ -> },
            onQuotaTrigger = { _, _ -> },
            onFallbackQueryReset = {}
        )

        // Rapidly fire all 10 queries in order
        queries.forEach { q ->
            coordinator.startDashboardRequest(q, null)
        }
        runCurrent()

        // Complete deferreds in REVERSE order (oldest completes last)
        for (i in deferreds.indices.reversed()) {
            deferreds[i].complete(DUMMY_SESSION to createDummyStats((i + 1) * 1000L))
            runCurrent()
        }

        // Must strictly settle on query 10's data (10_000L)
        assertEquals(10_000L, coordinator.statsState.value.visibleData?.summary?.totalTokens)
        assertEquals(DashboardLoadingMode.Idle, coordinator.statsState.value.loadingMode)
    }

    // =========================================================================
    // TARGET 2: Auth Invalidation Race in SessionCoordinator
    // =========================================================================

    @Test
    fun signOutCancelsInFlightNetworkOperationsAndGuardsSessionPersist() = testScope.runTest {
        val repository = FakeDashboardDataSource()
        val timeProvider = MutableTimeProvider()

        val sessionCoordinator = SessionCoordinator(repository, this)
        var currentSession: MobileSession? = DUMMY_SESSION
        sessionCoordinator.setSessionState(DashboardSessionState.Authenticated(DUMMY_SESSION))

        val networkDeferred = CompletableDeferred<Pair<MobileSession, StatsData>>()
        repository.onFetchStats = { _, _, _ ->
            networkDeferred.await()
        }

        val statsCoordinator = DashboardStatsCoordinator(
            repository = repository,
            cache = FakeSnapshotStore(),
            timeProvider = timeProvider,
            coroutineScope = this,
            getSessionGeneration = { sessionCoordinator.sessionGeneration },
            getCurrentSession = { currentSession },
            onSessionPersist = { freshSession, isCurrent ->
                sessionCoordinator.persistSessionIfCurrent(freshSession, isCurrent)
            },
            onSessionUpdated = { currentSession = it },
            onAuthExpired = {},
            onPresetCalendarPublish = { _, _, _ -> },
            onCalendarSynchronize = { _, _, _ -> },
            onQuotaTrigger = { _, _ -> },
            onFallbackQueryReset = {}
        )

        // Launch in-flight dashboard request for session
        statsCoordinator.startDashboardRequest(DashboardQuery(), null)
        runCurrent()
        assertTrue(statsCoordinator.isRequestActive)

        // Sign out while network call is in flight
        sessionCoordinator.advanceSessionGeneration()
        sessionCoordinator.cancelActiveAuthJobs()
        statsCoordinator.invalidateDashboardRequest()
        statsCoordinator.reset()
        currentSession = null
        sessionCoordinator.signOut {}
        runCurrent()

        assertEquals(DashboardSessionState.SignedOut, sessionCoordinator.sessionState.value)
        assertNull(currentSession)

        // In-flight network returns a refreshed session for User A
        val refreshedSession = DUMMY_SESSION.copy(accessToken = "refreshed-token")
        networkDeferred.complete(refreshedSession to createDummyStats(500L))
        runCurrent()

        // EMPIRICAL CHALLENGE:
        // 1. Refreshed session must NOT be persisted
        assertTrue(repository.persistedSessions.isEmpty())
        // 2. Session must remain SignedOut
        assertEquals(DashboardSessionState.SignedOut, sessionCoordinator.sessionState.value)
        // 3. Repository clearSession was executed
        assertEquals(1, repository.clearSessionCount)
        // 4. Stats state remains empty
        assertNull(statsCoordinator.statsState.value.visibleData)
    }

    @Test
    fun signOutFollowedImmediatelyBySignInOrdersBarriersCorrectly() = testScope.runTest {
        val repository = FakeDashboardDataSource()
        val sessionCoordinator = SessionCoordinator(repository, this)
        sessionCoordinator.setSessionState(DashboardSessionState.Authenticated(DUMMY_SESSION))

        val executionOrder = mutableListOf<String>()

        repository.onSignIn = { email, _ ->
            executionOrder.add("signIn:$email")
            DUMMY_SESSION.copy(userId = "user_b", email = email)
        }

        // Custom clear session tracking order
        var clearJob: Job? = null
        val sessionClearBarrier = sessionCoordinator.enqueueSessionClear().also { clearJob = it }
        val attemptGen = sessionCoordinator.advanceSessionGeneration()

        sessionCoordinator.signIn(
            email = "user_b@test.com",
            password = "password",
            attemptGeneration = attemptGen,
            sessionClearBarrier = sessionClearBarrier,
            barriers = emptyList(),
            onSuccess = {
                executionOrder.add("onSuccess:${it.email}")
            },
            onError = {}
        )

        runCurrent()

        // ClearSession must be ordered before signIn completion
        assertTrue(repository.clearSessionCount >= 1)
        assertEquals(listOf("signIn:user_b@test.com", "onSuccess:user_b@test.com"), executionOrder)
        assertEquals("user_b", (sessionCoordinator.sessionState.value as DashboardSessionState.Authenticated).session.userId)
    }

    // =========================================================================
    // TARGET 3: Monotonic Clocks in QuotaSyncCoordinator
    // =========================================================================

    @Test
    fun quotaRejectsBackwardRevisionAndSetsWarningAndRetainsSnapshot() = testScope.runTest {
        val quotaRepo = FakeQuotaRepository()
        val quotaStore = FakeQuotaStore()
        val timeProvider = MutableTimeProvider()
        val session = DUMMY_SESSION

        val coordinator = QuotaSyncCoordinator(
            quotaRepository = quotaRepo,
            quotaCache = quotaStore,
            timeProvider = timeProvider,
            coroutineScope = this,
            quotaFreshnessSchedulingEnabled = false,
            getSessionGeneration = { 1L },
            getCurrentSession = { session },
            isLowPowerDisplayVisible = { false }
        )

        // Establish initial quota state with epoch = 5, revision = 10
        val snapshotInitial = createDummyQuotaSnapshot(epoch = 5L, revision = 10L)
        quotaRepo.onFetchQuotaSnapshots = { snapshotInitial }
        coordinator.startQuotaRequest(session, force = true)
        runCurrent()

        val stateInitial = coordinator.quotaState.value as QuotaUiState.Available
        assertEquals(5L, stateInitial.snapshot.epoch)
        assertEquals(10L, stateInitial.snapshot.revision)
        assertFalse(stateInitial.showingCachedData)
        assertNull(stateInitial.warning)

        // Cloud returns backward time travel (same epoch 5, older revision 9)
        val backwardSnapshot = createDummyQuotaSnapshot(epoch = 5L, revision = 9L)
        quotaRepo.onFetchQuotaSnapshots = { backwardSnapshot }
        coordinator.startQuotaRequest(session, force = true)
        runCurrent()

        // EMPIRICAL CHALLENGE:
        // Must reject backward snapshot, retain revision 10, set showingCachedData = true, and set warning
        val stateAfter = coordinator.quotaState.value as QuotaUiState.Available
        assertEquals(10L, stateAfter.snapshot.revision)
        assertTrue(stateAfter.showingCachedData)
        assertEquals("云端返回了较旧的额度修订，已保留较新的本机快照", stateAfter.warning)
    }

    @Test
    fun quotaRejectsBackwardEpochAndSetsWarningAndRetainsSnapshot() = testScope.runTest {
        val quotaRepo = FakeQuotaRepository()
        val quotaStore = FakeQuotaStore()
        val timeProvider = MutableTimeProvider()
        val session = DUMMY_SESSION

        val coordinator = QuotaSyncCoordinator(
            quotaRepository = quotaRepo,
            quotaCache = quotaStore,
            timeProvider = timeProvider,
            coroutineScope = this,
            quotaFreshnessSchedulingEnabled = false,
            getSessionGeneration = { 1L },
            getCurrentSession = { session },
            isLowPowerDisplayVisible = { false }
        )

        // Initial snapshot with epoch = 5, revision = 2
        quotaRepo.onFetchQuotaSnapshots = { createDummyQuotaSnapshot(epoch = 5L, revision = 2L) }
        coordinator.startQuotaRequest(session, force = true)
        runCurrent()

        // Backward epoch = 4, revision = 999
        quotaRepo.onFetchQuotaSnapshots = { createDummyQuotaSnapshot(epoch = 4L, revision = 999L) }
        coordinator.startQuotaRequest(session, force = true)
        runCurrent()

        val stateAfter = coordinator.quotaState.value as QuotaUiState.Available
        assertEquals(5L, stateAfter.snapshot.epoch)
        assertEquals(2L, stateAfter.snapshot.revision)
        assertTrue(stateAfter.showingCachedData)
        assertEquals("云端返回了较旧的额度修订，已保留较新的本机快照", stateAfter.warning)
    }

    @Test
    fun quotaAcceptsMonotonicallyIncreasingRevisionsAndEpochs() = testScope.runTest {
        val quotaRepo = FakeQuotaRepository()
        val quotaStore = FakeQuotaStore()
        val timeProvider = MutableTimeProvider()
        val session = DUMMY_SESSION

        val coordinator = QuotaSyncCoordinator(
            quotaRepository = quotaRepo,
            quotaCache = quotaStore,
            timeProvider = timeProvider,
            coroutineScope = this,
            quotaFreshnessSchedulingEnabled = false,
            getSessionGeneration = { 1L },
            getCurrentSession = { session },
            isLowPowerDisplayVisible = { false }
        )

        quotaRepo.onFetchQuotaSnapshots = { createDummyQuotaSnapshot(epoch = 1L, revision = 1L) }
        coordinator.startQuotaRequest(session, force = true)
        runCurrent()

        // Monotonic step 1: increment revision
        quotaRepo.onFetchQuotaSnapshots = { createDummyQuotaSnapshot(epoch = 1L, revision = 2L) }
        coordinator.startQuotaRequest(session, force = true)
        runCurrent()

        val stateRev2 = coordinator.quotaState.value as QuotaUiState.Available
        assertEquals(2L, stateRev2.snapshot.revision)
        assertFalse(stateRev2.showingCachedData)
        assertNull(stateRev2.warning)

        // Monotonic step 2: advance epoch
        quotaRepo.onFetchQuotaSnapshots = { createDummyQuotaSnapshot(epoch = 2L, revision = 1L) }
        coordinator.startQuotaRequest(session, force = true)
        runCurrent()

        val stateEpoch2 = coordinator.quotaState.value as QuotaUiState.Available
        assertEquals(2L, stateEpoch2.snapshot.epoch)
        assertEquals(1L, stateEpoch2.snapshot.revision)
        assertFalse(stateEpoch2.showingCachedData)
    }

    @Test
    fun quotaWindowStalenessTransitionsAndEffectiveStatus() {
        val observed = Instant.parse("2026-07-15T10:00:00Z")
        val window = QuotaWindowSnapshot(
            providerId = "openai",
            windowId = "hourly",
            windowLabel = "1 小时",
            scope = QuotaScope.ConsumerSubscription,
            source = QuotaSource.OfficialApi,
            status = QuotaWindowStatus.Ok,
            used = 10.0,
            limit = 100.0,
            remaining = 90.0,
            unit = QuotaUnit.Percent,
            windowMinutes = 60,
            resetsAt = "2026-07-15T11:00:00Z",
            observedAt = observed.toString(),
            fetchedAt = observed.toString(),
            staleAfterSeconds = 300, // 5 minutes -> stale at 10:05:00Z
            reasonCode = null
        )

        val provider = QuotaProviderEnvelope(
            schemaVersion = 1,
            providerId = "openai",
            displayName = "OpenAI",
            scope = QuotaScope.ConsumerSubscription,
            mode = QuotaMode.Automatic,
            capability = QuotaCapability.Stable,
            status = QuotaProviderStatus.Ok,
            windows = listOf(window),
            reasonCode = null
        )

        // Before stale deadline (10:04:59Z) -> Ok
        val beforeStale = Instant.parse("2026-07-15T10:04:59Z")
        assertEquals(QuotaWindowStatus.Ok, window.effectiveStatus(beforeStale))
        assertEquals(QuotaProviderStatus.Ok, provider.effectiveStatus(beforeStale))

        // Exactly at stale deadline (10:05:00Z) -> Stale
        val atStale = Instant.parse("2026-07-15T10:05:00Z")
        assertEquals(QuotaWindowStatus.Stale, window.effectiveStatus(atStale))
        assertEquals(QuotaProviderStatus.Stale, provider.effectiveStatus(atStale))

        // Well after stale deadline (10:10:00Z) -> Stale
        val afterStale = Instant.parse("2026-07-15T10:10:00Z")
        assertEquals(QuotaWindowStatus.Stale, window.effectiveStatus(afterStale))
        assertEquals(QuotaProviderStatus.Stale, provider.effectiveStatus(afterStale))

        // Forced stale -> Stale regardless of clock
        assertEquals(QuotaWindowStatus.Stale, window.effectiveStatus(beforeStale, forceStale = true))
        assertEquals(QuotaProviderStatus.Stale, provider.effectiveStatus(beforeStale, forceStale = true))
    }

    // =========================================================================
    // TARGET 4: Heatmap Boundaries in CalendarHeatmapCoordinator
    // =========================================================================

    @Test
    fun calendarHeatmapQueryHandlesLeapYearsCorrectly() {
        // Case 1: Active leap year (2024), today is March 1, 2024
        val leapDayToday = LocalDate.of(2024, 3, 1)
        val febQuery = DashboardQuery(
            range = RangeKey.Custom,
            start = "2024-02-01",
            end = "2024-02-29"
        )
        val result1 = calendarHeatmapQuery(febQuery, leapDayToday)
        assertEquals("2024-01-01", result1.start)
        assertEquals("2024-03-01", result1.end)

        // Case 2: Past leap year (2024) viewed from 2025
        val today2025 = LocalDate.of(2025, 6, 15)
        val pastLeapQuery = DashboardQuery(
            range = RangeKey.Custom,
            start = "2024-02-15",
            end = "2024-02-29"
        )
        val result2 = calendarHeatmapQuery(pastLeapQuery, today2025)
        assertEquals("2024-01-01", result2.start)
        assertEquals("2024-12-31", result2.end)

        // Case 3: Past non-leap year (2023) viewed from 2025
        val nonLeapQuery = DashboardQuery(
            range = RangeKey.Custom,
            start = "2023-02-15",
            end = "2023-02-28"
        )
        val result3 = calendarHeatmapQuery(nonLeapQuery, today2025)
        assertEquals("2023-01-01", result3.start)
        assertEquals("2023-12-31", result3.end)

        // Case 4: Century leap year 2000 (leap) vs 2100 (non-leap)
        assertTrue(LocalDate.of(2000, 1, 1).isLeapYear)
        assertFalse(LocalDate.of(2100, 1, 1).isLeapYear)

        val leap2000Query = DashboardQuery(
            range = RangeKey.Custom,
            start = "2000-02-01",
            end = "2000-02-29"
        )
        val result4 = calendarHeatmapQuery(leap2000Query, today2025)
        assertEquals("2000-01-01", result4.start)
        assertEquals("2000-12-31", result4.end)
    }

    @Test
    fun calendarHeatmapQueryHandlesYearTransitions() {
        // Today is New Year's Day (Jan 1, 2026)
        val newYearsDay = LocalDate.of(2026, 1, 1)

        // Querying previous year's last day (Dec 31, 2025)
        val lastDayPrevYear = DashboardQuery(
            range = RangeKey.Custom,
            start = "2025-12-31",
            end = "2025-12-31"
        )
        val resultPrev = calendarHeatmapQuery(lastDayPrevYear, newYearsDay)
        assertEquals("2025-01-01", resultPrev.start)
        assertEquals("2025-12-31", resultPrev.end)

        // Querying today (Jan 1, 2026)
        val todayQuery = DashboardQuery(
            range = RangeKey.Custom,
            start = "2026-01-01",
            end = "2026-01-01"
        )
        val resultToday = calendarHeatmapQuery(todayQuery, newYearsDay)
        assertEquals("2026-01-01", resultToday.start)
        assertEquals("2026-01-01", resultToday.end)
    }

    @Test
    fun calendarHeatmapQueryClampsFutureCutoffToToday() {
        val today = LocalDate.of(2026, 7, 15)
        val futureEndQuery = DashboardQuery(
            range = RangeKey.Custom,
            start = "2026-05-01",
            end = "2026-12-31"
        )
        val result = calendarHeatmapQuery(futureEndQuery, today)
        assertEquals("2026-01-01", result.start)
        assertEquals("2026-07-15", result.end)
    }

    @Test
    fun calendarCutoffTimezoneBoundaryCalculatesCorrectCoverage() = testScope.runTest {
        val repository = FakeDashboardDataSource()
        val cache = FakeSnapshotStore()
        val timeProvider = MutableTimeProvider(tz = "Asia/Shanghai")

        val coordinator = CalendarHeatmapCoordinator(
            repository = repository,
            cache = cache,
            timeProvider = timeProvider,
            coroutineScope = this,
            sessionMutationMutex = kotlinx.coroutines.sync.Mutex(),
            getCurrentSession = { DUMMY_SESSION },
            getSessionGeneration = { 1L },
            onSessionUpdated = {},
            onAuthExpired = {}
        )

        // Query for year 2025 custom range
        val customQuery = DashboardQuery(
            range = RangeKey.Custom,
            start = "2025-01-01",
            end = "2025-12-31"
        )

        // When cloud generatedAt is UTC 2025-12-31T15:59:59Z, in Asia/Shanghai (+08:00) that is 2025-12-31 23:59:59
        val stats2025 = createDummyStats(
            tokens = 1000L,
            generatedAt = "2025-12-31T15:59:59Z",
            timezone = "Asia/Shanghai",
            range = "custom",
            queryEcho = StatsQueryEcho(
                range = "custom",
                start = "2025-01-01",
                end = "2025-12-31",
                timezone = "Asia/Shanghai"
            )
        )

        repository.onFetchStats = { _, _, _ ->
            DUMMY_SESSION to stats2025
        }

        coordinator.synchronizeCalendarHeatmap(
            query = customQuery,
            entity = null,
            dayReviewReturn = null,
            session = DUMMY_SESSION
        )
        runCurrent()

        val calendarState = coordinator.calendarState.value as CalendarHeatmapUiState.Available
        assertEquals("2025-01-01", calendarState.coverageStart)
        assertEquals("2025-12-31", calendarState.coverageEnd)
    }

    // =========================================================================
    // Helper Methods
    // =========================================================================

    private companion object {
        val DUMMY_SESSION = MobileSession(
            accessToken = "access-token-123",
            refreshToken = "refresh-token-123",
            userId = "user_alpha",
            email = "alpha@example.com",
            expiresAtEpochSeconds = Long.MAX_VALUE
        )

        fun createDummyStats(
            tokens: Long,
            generatedAt: String = "2026-07-15T12:00:00Z",
            timezone: String = "Asia/Shanghai",
            range: String = "today",
            queryEcho: StatsQueryEcho = StatsQueryEcho(range = range, timezone = timezone)
        ): StatsData = StatsData(
            summary = Summary(totalTokens = tokens, inputTokens = tokens * 8 / 10, outputTokens = tokens * 2 / 10),
            tools = emptyMap(),
            models = emptyMap(),
            trends = emptyList(),
            heatmap = mapOf("2026-07-15" to tokens),
            history = emptyList(),
            machines = emptyList(),
            meta = StatsMeta(
                generatedAt = generatedAt,
                lastRefreshedAt = generatedAt,
                timezone = timezone,
                range = range,
                machine = null,
                stale = false,
                query = queryEcho
            )
        )

        fun createDummyQuotaSnapshot(
            epoch: Long,
            revision: Long,
            generatedAt: String = "2026-07-15T12:00:00Z"
        ): QuotaTransportSnapshot = QuotaTransportSnapshot(
            transportVersion = QUOTA_TRANSPORT_VERSION,
            epoch = epoch,
            revision = revision,
            generatedAt = generatedAt,
            providers = listOf(
                QuotaProviderEnvelope(
                    schemaVersion = 1,
                    providerId = "codex",
                    displayName = "Codex Pro",
                    scope = QuotaScope.ConsumerSubscription,
                    mode = QuotaMode.Automatic,
                    capability = QuotaCapability.Stable,
                    status = QuotaProviderStatus.Ok,
                    windows = listOf(
                        QuotaWindowSnapshot(
                            providerId = "codex",
                            windowId = "daily",
                            windowLabel = "每日额度",
                            scope = QuotaScope.ConsumerSubscription,
                            source = QuotaSource.OfficialApi,
                            status = QuotaWindowStatus.Ok,
                            used = 25.0,
                            limit = 100.0,
                            remaining = 75.0,
                            unit = QuotaUnit.Percent,
                            windowMinutes = 1440,
                            resetsAt = "2026-07-16T00:00:00Z",
                            observedAt = generatedAt,
                            fetchedAt = generatedAt,
                            staleAfterSeconds = 600,
                            reasonCode = null
                        )
                    ),
                    reasonCode = null
                )
            )
        )
    }
}
