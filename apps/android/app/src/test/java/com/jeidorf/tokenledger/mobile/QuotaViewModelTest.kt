package com.jeidorf.tokenledger.mobile

import java.io.IOException
import java.time.LocalDate
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class QuotaViewModelTest {
    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun quotaFailureNeverTakesDownStatsDashboard() = runTest {
        val viewModel = viewModel(quota = FakeQuotaDataSource { throw IOException("offline") })
        runCurrent()

        assertEquals(321L, viewModel.uiState.value.data?.summary?.effectiveTokens)
        assertTrue(viewModel.uiState.value.session != null)
        assertTrue(viewModel.uiState.value.quota is QuotaUiState.Unavailable)
        assertNull(viewModel.uiState.value.error)
    }

    @Test
    fun signOutRejectsQuotaResponseThatIgnoresCancellation() = runTest {
        val late = CompletableDeferred<QuotaTransportSnapshot>()
        val cache = FakeQuotaStore()
        val viewModel = viewModel(
            quota = FakeQuotaDataSource { late.awaitIgnoringCancellation() },
            quotaCache = cache
        )

        viewModel.signOut()
        late.complete(snapshot())
        runCurrent()

        assertEquals(DashboardSessionState.SignedOut, viewModel.uiState.value.sessionState)
        assertTrue(viewModel.uiState.value.quota is QuotaUiState.Unsynced)
        assertTrue(cache.saved.isEmpty())
        assertEquals("user-1", cache.invalidated.last().first.userId)
    }

    @Test
    fun sameUserImmediateReloginWaitsForSignOutQuotaInvalidation() = runTest {
        val invalidationStarted = CompletableDeferred<Unit>()
        val releaseInvalidation = CompletableDeferred<Unit>()
        val cache = FakeQuotaStore(
            invalidateBlock = { _, _ ->
                invalidationStarted.complete(Unit)
                releaseInvalidation.await()
            }
        )
        val repository = ReloginDashboardDataSource()
        val viewModel = viewModel(
            quota = FakeQuotaDataSource { snapshot() },
            quotaCache = cache,
            repository = repository
        )
        runCurrent()

        viewModel.signOut()
        invalidationStarted.await()
        viewModel.signIn("user@example.com", "secret")
        runCurrent()

        assertEquals(0, repository.signInCalls)
        assertEquals(DashboardLoadingMode.SigningIn, viewModel.uiState.value.loadingMode)

        releaseInvalidation.complete(Unit)
        runCurrent()

        assertEquals(1, repository.signInCalls)
        assertTrue(viewModel.uiState.value.sessionState is DashboardSessionState.Authenticated)
    }

    @Test
    fun emptyProviderSetMeansUnsyncedAndPersistsVersionInsteadOfShowingZero() = runTest {
        val cache = FakeQuotaStore()
        val empty = snapshot().copy(epoch = 8, revision = 13, providers = emptyList())
        val viewModel = viewModel(
            quota = FakeQuotaDataSource { empty },
            quotaCache = cache
        )
        runCurrent()

        assertTrue(viewModel.uiState.value.quota is QuotaUiState.Unsynced)
        assertNull(viewModel.uiState.value.quotaSnapshot)
        assertEquals(empty, cache.saved.last().second.snapshot)
        assertTrue(cache.invalidated.isEmpty())
    }

    @Test
    fun newerEmptyProjectionRejectsLaterOldNonemptyResponse() = runTest {
        val original = snapshot()
        val empty = original.copy(epoch = original.epoch + 1, revision = original.revision + 1,
            providers = emptyList(), providerStates = emptyList())
        var calls = 0
        val cache = FakeQuotaStore()
        val viewModel = viewModel(
            quota = FakeQuotaDataSource { if (++calls == 1) empty else original }, quotaCache = cache
        )
        runCurrent()
        viewModel.refresh()
        runCurrent()
        assertTrue(viewModel.uiState.value.quota is QuotaUiState.Unsynced)
        assertEquals(listOf(empty), cache.saved.map { it.second.snapshot })
    }

    @Test
    fun previousProcessEmptyCacheKeepsUnsyncedAndRejectsOlderResponse() = runTest {
        val original = snapshot()
        val empty = original.copy(epoch = original.epoch + 1, revision = original.revision + 1,
            providers = emptyList(), providerStates = emptyList())
        val response = CompletableDeferred<QuotaTransportSnapshot>()
        val cache = FakeQuotaStore(loadResult = decoded(QuotaCachedSnapshot(empty, FakeTime.now - 1)))
        val viewModel = viewModel(quota = FakeQuotaDataSource { response.await() }, quotaCache = cache)
        runCurrent()
        assertNull(viewModel.uiState.value.quotaSnapshot)
        response.complete(original)
        runCurrent()
        assertTrue(viewModel.uiState.value.quota is QuotaUiState.Unsynced)
        assertTrue(cache.saved.isEmpty())
        assertTrue(cache.invalidated.isEmpty())
    }

    @Test
    fun olderEmptyProjectionKeepsNewerNonemptyForegroundSnapshot() = runTest {
        val current = snapshot()
        var calls = 0
        val cache = FakeQuotaStore()
        val viewModel = viewModel(quota = FakeQuotaDataSource {
            if (++calls == 1) current else current.copy(revision = current.revision - 1,
                providers = emptyList(), providerStates = emptyList())
        }, quotaCache = cache)
        runCurrent()
        viewModel.refresh()
        runCurrent()
        assertEquals(current, viewModel.uiState.value.quotaSnapshot)
        assertEquals(listOf(current), cache.saved.map { it.second.snapshot })
        assertTrue(cache.invalidated.isEmpty())
    }

    @Test
    fun lowerEpochOrRevisionCannotReplaceNewerSnapshot() = runTest {
        var calls = 0
        val current = snapshot()
        val older = current.copy(revision = current.revision - 1)
        val viewModel = viewModel(
            quota = FakeQuotaDataSource {
                calls += 1
                if (calls == 1) current else older
            }
        )
        runCurrent()
        viewModel.refresh()
        runCurrent()

        val quota = viewModel.uiState.value.quota as QuotaUiState.Available
        assertEquals(current.revision, quota.snapshot.revision)
        assertTrue(quota.showingCachedData)
        assertTrue(quota.warning?.contains("较旧") == true)
    }

    @Test
    fun qualifiedCacheSurvivesNetworkFailureAndIsExplicitlyHistorical() = runTest {
        val cached = QuotaCachedSnapshot(snapshot(), FakeTime.now - 60_000L)
        val viewModel = viewModel(
            quota = FakeQuotaDataSource { throw IOException("offline") },
            quotaCache = FakeQuotaStore(loadResult = decoded(cached))
        )
        runCurrent()

        val quota = viewModel.uiState.value.quota as QuotaUiState.Available
        assertTrue(quota.showingCachedData)
        assertEquals(cached.snapshot, quota.snapshot)
        assertTrue(quota.warning?.contains("历史快照") == true || quota.warning?.contains("网络") == true)
    }

    @Test
    fun networkQuotaWaitsForLkgRestoreBeforeARefreshCanFail() = runTest {
        val restored = CompletableDeferred<DecodedQuotaCache?>()
        var networkCalls = 0
        val cached = QuotaCachedSnapshot(snapshot(), FakeTime.now - 60_000L)
        val viewModel = viewModel(
            quota = FakeQuotaDataSource {
                networkCalls += 1
                throw IOException("offline")
            },
            quotaCache = FakeQuotaStore { restored.await() }
        )
        runCurrent()
        assertEquals(0, networkCalls)

        restored.complete(decoded(cached))
        runCurrent()

        assertEquals(1, networkCalls)
        val quota = viewModel.uiState.value.quota as QuotaUiState.Available
        assertEquals(cached.snapshot, quota.snapshot)
        assertTrue(quota.showingCachedData)
    }

    @Test
    fun cacheFromOldSessionGenerationCannotRestoreIntoSameUserUi() = runTest {
        val cached = QuotaCachedSnapshot(snapshot(), FakeTime.now - 60_000L)
        val oldGenerationEntry = DecodedQuotaCache(
            snapshot = cached,
            metadata = QuotaCacheWriteIdentity(
                writerId = DashboardRequestIdentity.writerId,
                requestId = 1,
                sessionGeneration = 0,
                epoch = cached.snapshot.epoch,
                revision = cached.snapshot.revision
            )
        )
        val cache = FakeQuotaStore(loadResult = oldGenerationEntry)
        val viewModel = viewModel(
            quota = FakeQuotaDataSource { throw IOException("offline") },
            quotaCache = cache
        )
        runCurrent()

        assertTrue(viewModel.uiState.value.quota !is QuotaUiState.Available)
        assertTrue(cache.invalidated.any { it.second.sessionGeneration > 0L })
    }

    @Test
    fun replacementViewModelUsesANewerProcessWideSessionGeneration() = runTest {
        val firstCache = FakeQuotaStore()
        viewModel(
            quota = FakeQuotaDataSource { snapshot() },
            quotaCache = firstCache
        )
        runCurrent()
        val firstGeneration = firstCache.saved.last().third.sessionGeneration

        val replacementCache = FakeQuotaStore()
        viewModel(
            quota = FakeQuotaDataSource { snapshot() },
            quotaCache = replacementCache
        )
        runCurrent()

        assertTrue(replacementCache.saved.last().third.sessionGeneration > firstGeneration)
    }

    @Test
    fun lowPowerDisplayRejectsLateDashboardWritesAndCommitsItsFreshRequest() = runTest {
        val lateStats = CompletableDeferred<Pair<MobileSession, StatsData>>()
        val repository = SequencedDashboardDataSource { lateStats.awaitIgnoringCancellation() }
        val viewModel = viewModel(
            quota = FakeQuotaDataSource { throw IOException("offline") },
            repository = repository
        )
        runCurrent()

        viewModel.refresh()
        runCurrent()
        assertTrue(viewModel.uiState.value.dashboardLoading)
        viewModel.openLowPowerDisplay()
        lateStats.complete(
            SESSION to STATS.copy(
                summary = Summary(totalTokens = 999, inputTokens = 900, outputTokens = 99)
            )
        )
        runCurrent()

        assertTrue(viewModel.uiState.value.lowPowerDisplayVisible)
        assertEquals(DashboardLoadingMode.Idle, viewModel.uiState.value.loadingMode)
        assertEquals(999L, viewModel.uiState.value.data?.summary?.effectiveTokens)
    }

    @Test
    fun lowPowerDisplayRejectsLateQuotaAndRefreshesQuotaOnEntry() = runTest {
        var calls = 0
        val first = CompletableDeferred<QuotaTransportSnapshot>()
        val viewModel = viewModel(
            quota = FakeQuotaDataSource {
                calls += 1
                if (calls == 1) first.awaitIgnoringCancellation() else snapshot()
            }
        )
        runCurrent()
        assertEquals(1, calls)

        viewModel.openLowPowerDisplay()
        first.complete(snapshot())
        viewModel.onForeground()
        viewModel.onClockChanged()
        runCurrent()

        assertEquals(2, calls)
        assertTrue(viewModel.uiState.value.quota is QuotaUiState.Available)
        viewModel.closeLowPowerDisplay()
        runCurrent()

        assertEquals(2, calls)
        assertTrue(viewModel.uiState.value.quota is QuotaUiState.Available)
    }

    @Test
    fun lowPowerDisplayRefreshesStatsEveryFiveMinutesAndQuotaEveryFifteen() = runTest {
        var statsCalls = 0
        var quotaCalls = 0
        val time = MutableFakeTime()
        val repository = CountingDashboardDataSource {
            statsCalls += 1
            STATS.copy(
                summary = Summary(
                    totalTokens = statsCalls.toLong(),
                    inputTokens = statsCalls.toLong(),
                    outputTokens = 0
                )
            )
        }
        val viewModel = DashboardViewModel(
            repository = repository,
            cache = FakeDashboardStore,
            quotaRepository = FakeQuotaDataSource {
                quotaCalls += 1
                snapshot().copy(revision = quotaCalls.toLong())
            },
            quotaCache = FakeQuotaStore(),
            timeProvider = time,
            automaticRefreshEnabled = true,
            quotaFreshnessSchedulingEnabled = false
        )
        runCurrent()
        assertEquals(1, statsCalls)
        assertEquals(1, quotaCalls)

        viewModel.openLowPowerDisplay()
        runCurrent()
        assertEquals(2, statsCalls)
        assertEquals(2, quotaCalls)

        repeat(2) {
            time.now += DashboardViewModel.LOW_POWER_REFRESH_INTERVAL_MS
            advanceTimeBy(DashboardViewModel.LOW_POWER_REFRESH_INTERVAL_MS)
            runCurrent()
        }
        assertEquals(4, statsCalls)
        assertEquals(2, quotaCalls)

        time.now += DashboardViewModel.LOW_POWER_REFRESH_INTERVAL_MS
        advanceTimeBy(DashboardViewModel.LOW_POWER_REFRESH_INTERVAL_MS)
        runCurrent()
        assertEquals(5, statsCalls)
        assertEquals(3, quotaCalls)

        viewModel.onBackground()
        time.now += DashboardViewModel.LOW_POWER_REFRESH_INTERVAL_MS * 3
        advanceTimeBy(DashboardViewModel.LOW_POWER_REFRESH_INTERVAL_MS * 3)
        runCurrent()
        assertEquals(5, statsCalls)
        assertEquals(3, quotaCalls)
    }

    private fun viewModel(
        quota: QuotaDataSource,
        quotaCache: FakeQuotaStore = FakeQuotaStore(),
        repository: DashboardDataSource = FakeDashboardDataSource
    ): DashboardViewModel = DashboardViewModel(
        repository = repository,
        cache = FakeDashboardStore,
        quotaRepository = quota,
        quotaCache = quotaCache,
        timeProvider = FakeTime,
        automaticRefreshEnabled = false,
        quotaFreshnessSchedulingEnabled = false
    )

    private fun snapshot(): QuotaTransportSnapshot {
        val root = JSONObject(fixture("transport-v2.json"))
        return QuotaSnapshotJson.parseTransport(root.getJSONObject("readResponse").toString())
    }

    private fun fixture(name: String): String {
        val resource = checkNotNull(javaClass.classLoader?.getResource("quota-provider-v1/$name"))
        return resource.readText()
    }

    private fun decoded(cached: QuotaCachedSnapshot): DecodedQuotaCache = DecodedQuotaCache(
        snapshot = cached,
        metadata = QuotaCacheWriteIdentity(
            writerId = "previous-process",
            requestId = 1,
            sessionGeneration = 1,
            epoch = cached.snapshot.epoch,
            revision = cached.snapshot.revision
        )
    )

    private suspend fun <T> CompletableDeferred<T>.awaitIgnoringCancellation(): T =
        suspendCoroutine { continuation ->
            invokeOnCompletion { continuation.resume(getCompleted()) }
        }

    private class FakeQuotaDataSource(
        private val block: suspend () -> QuotaTransportSnapshot
    ) : QuotaDataSource {
        override suspend fun fetchQuotaSnapshots(session: MobileSession): QuotaTransportSnapshot =
            block()
    }

    private class FakeQuotaStore(
        var loadResult: DecodedQuotaCache? = null,
        private val loadBlock: (suspend () -> DecodedQuotaCache?)? = null,
        private val invalidateBlock: suspend (
            QuotaCacheKey,
            QuotaCacheWriteIdentity
        ) -> Unit = { _, _ -> }
    ) : QuotaSnapshotStore {
        constructor(loadBlock: suspend () -> DecodedQuotaCache?) : this(
            loadResult = null,
            loadBlock = loadBlock
        )

        val saved = mutableListOf<Triple<QuotaCacheKey, QuotaCachedSnapshot, QuotaCacheWriteIdentity>>()
        val invalidated = mutableListOf<Pair<QuotaCacheKey, QuotaCacheWriteIdentity>>()

        override suspend fun load(
            key: QuotaCacheKey,
            nowEpochMillis: Long
        ): DecodedQuotaCache? = loadBlock?.invoke() ?: loadResult

        override suspend fun save(
            key: QuotaCacheKey,
            snapshot: QuotaCachedSnapshot,
            identity: QuotaCacheWriteIdentity
        ) {
            saved += Triple(key, snapshot, identity)
        }

        override suspend fun invalidate(key: QuotaCacheKey, identity: QuotaCacheWriteIdentity) {
            invalidated += key to identity
            invalidateBlock(key, identity)
        }
    }

    private class ReloginDashboardDataSource : DashboardDataSource {
        var signInCalls = 0
        override val isConfigured: Boolean = true
        override suspend fun restoreSession(): MobileSession = SESSION
        override suspend fun signIn(email: String, password: String): MobileSession {
            signInCalls += 1
            return SESSION
        }
        override suspend fun persistSession(session: MobileSession) = Unit
        override suspend fun clearSession() = Unit
        override suspend fun fetchStats(
            session: MobileSession,
            range: RangeKey,
            machine: String
        ): Pair<MobileSession, StatsData> = session to STATS
    }

    private class SequencedDashboardDataSource(
        private val secondResponse: suspend () -> Pair<MobileSession, StatsData>
    ) : DashboardDataSource {
        private var calls = 0
        override val isConfigured: Boolean = true
        override suspend fun restoreSession(): MobileSession = SESSION
        override suspend fun signIn(email: String, password: String): MobileSession = SESSION
        override suspend fun persistSession(session: MobileSession) = Unit
        override suspend fun clearSession() = Unit
        override suspend fun fetchStats(
            session: MobileSession,
            range: RangeKey,
            machine: String
        ): Pair<MobileSession, StatsData> {
            calls += 1
            return if (calls == 1) session to STATS else secondResponse()
        }
    }

    private class CountingDashboardDataSource(
        private val stats: () -> StatsData
    ) : DashboardDataSource {
        override val isConfigured: Boolean = true
        override suspend fun restoreSession(): MobileSession = SESSION
        override suspend fun signIn(email: String, password: String): MobileSession = SESSION
        override suspend fun persistSession(session: MobileSession) = Unit
        override suspend fun clearSession() = Unit
        override suspend fun fetchStats(
            session: MobileSession,
            range: RangeKey,
            machine: String
        ): Pair<MobileSession, StatsData> = session to stats()
    }

    private data object FakeDashboardDataSource : DashboardDataSource {
        override val isConfigured: Boolean = true
        override suspend fun restoreSession(): MobileSession = SESSION
        override suspend fun signIn(email: String, password: String): MobileSession = SESSION
        override suspend fun persistSession(session: MobileSession) = Unit
        override suspend fun clearSession() = Unit
        override suspend fun fetchStats(
            session: MobileSession,
            range: RangeKey,
            machine: String
        ): Pair<MobileSession, StatsData> = session to STATS
    }

    private data object FakeDashboardStore : DashboardSnapshotStore {
        override suspend fun load(key: DashboardCacheKey): DashboardCachedSnapshot? = null
        override suspend fun save(
            key: DashboardCacheKey,
            snapshot: DashboardCachedSnapshot,
            requestId: Long
        ) = Unit
        override suspend fun clearUser(userId: String) = Unit
    }

    private data object FakeTime : DashboardTimeProvider {
        const val now = 1_752_556_860_000L
        override fun nowEpochMillis(): Long = now
        override fun currentDate(): LocalDate = LocalDate.of(2026, 7, 15)
        override fun timezoneId(): String = "Asia/Shanghai"
        override fun millisUntilNextMidnight(): Long = 60_000L
    }

    private class MutableFakeTime : DashboardTimeProvider {
        var now: Long = FakeTime.now
        override fun nowEpochMillis(): Long = now
        override fun currentDate(): LocalDate = LocalDate.of(2026, 7, 15)
        override fun timezoneId(): String = "Asia/Shanghai"
        override fun millisUntilNextMidnight(): Long = 24L * 60L * 60L * 1_000L
    }

    private companion object {
        val SESSION = MobileSession(
            accessToken = "access",
            refreshToken = "refresh",
            userId = "user-1",
            email = "user@example.com",
            expiresAtEpochSeconds = Long.MAX_VALUE
        )
        val STATS = StatsData(
            summary = Summary(totalTokens = 321, inputTokens = 300, outputTokens = 21),
            tools = emptyMap(),
            models = emptyMap(),
            trends = emptyList(),
            heatmap = emptyMap(),
            history = emptyList(),
            machines = emptyList(),
            meta = null
        )
    }
}
