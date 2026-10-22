package com.jeidorf.tokenledger.mobile

import java.time.LocalDate
import java.time.ZoneId
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
class TrendDrillQueryTest {
    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun datedBucketKeepsItsLocalDateForSourceDrill() {
        val context = TrendDrillContext.fromBucket(
            bucket = "2026-09-08T08:00:00",
            originQuery = DashboardQuery(range = RangeKey.Week),
            referenceDate = LocalDate.of(2026, 9, 9),
            responseZone = ZoneId.of("Asia/Shanghai"),
            targetSection = DashboardSection.Contributions
        )

        assertEquals(LocalDate.of(2026, 9, 8), context?.date)
        assertEquals(DashboardSection.Contributions, context?.targetSection)
    }

    @Test
    fun hourOnlyBucketUsesOnlyAnUnambiguousOriginDate() {
        val context = TrendDrillContext.fromBucket(
            bucket = "08:00",
            originQuery = DashboardQuery(
                range = RangeKey.Custom,
                start = "2026-09-08",
                end = "2026-09-08"
            ),
            referenceDate = LocalDate.of(2026, 9, 9),
            responseZone = ZoneId.of("Asia/Shanghai"),
            targetSection = DashboardSection.Details
        )

        assertEquals(LocalDate.of(2026, 9, 8), context?.date)
    }

    @Test
    fun hourOnlyBucketWithoutADeterminableDateIsRejected() {
        val context = TrendDrillContext.fromBucket(
            bucket = "08:00",
            originQuery = DashboardQuery(range = RangeKey.Week),
            referenceDate = LocalDate.of(2026, 9, 9),
            responseZone = ZoneId.of("Asia/Shanghai"),
            targetSection = DashboardSection.Details
        )

        assertNull(context)
    }

    @Test
    fun invalidClockValuesAreRejectedAndRfc3339UsesTheResponseTimezone() {
        val origin = DashboardQuery(range = RangeKey.Week)
        val responseZone = ZoneId.of("Asia/Shanghai")

        assertNull(TrendDrillContext.fromBucket("2026-09-08T99:99", origin, LocalDate.of(2026, 9, 9), responseZone, DashboardSection.Details))
        assertNull(TrendDrillContext.fromBucket("99:99", origin, LocalDate.of(2026, 9, 9), responseZone, DashboardSection.Details))
        assertEquals(
            LocalDate.of(2026, 9, 9),
            TrendDrillContext.fromBucket(
                "2026-09-08T20:30:00Z",
                origin,
                LocalDate.of(2026, 9, 9),
                responseZone,
                DashboardSection.Details
            )?.date
        )
    }

    @Test
    fun trendBucketOpensRealDaySourcesAndBackRestoresEntityAndNavigation() = runTest {
        val viewModel = DashboardViewModel(
            repository = TrendRepository(),
            cache = TrendCache(),
            timeProvider = TrendTimeProvider,
            automaticRefreshEnabled = false
        )
        runCurrent()
        viewModel.selectRange(RangeKey.Week)
        viewModel.openTool("codex")
        runCurrent()

        assertTrue(viewModel.openTrendBucket("2026-09-08T08:00:00", DashboardSection.Contributions))
        runCurrent()
        val drilled = viewModel.uiState.value
        assertEquals(DashboardSection.Contributions, drilled.section)
        assertEquals(RangeKey.Custom, drilled.query.range)
        assertEquals("2026-09-08", drilled.query.start)
        assertEquals("2026-09-08", drilled.query.end)
        assertEquals(DashboardEntity(DashboardEntity.TOOL, "codex"), drilled.entity)
        assertEquals(RangeKey.Week, drilled.dayReviewReturn?.query?.range)
        assertEquals(DashboardSection.Entity, drilled.dayReviewReturn?.section)
        assertEquals(1, drilled.navigationStack.size)

        viewModel.navigateBack()
        runCurrent()
        val returned = viewModel.uiState.value
        assertEquals(DashboardSection.Entity, returned.section)
        assertEquals(RangeKey.Week, returned.query.range)
        assertEquals(DashboardEntity(DashboardEntity.TOOL, "codex"), returned.entity)
        assertEquals(1, returned.navigationStack.size)
        assertNull(returned.dayReviewReturn)
    }

    @Test
    fun ambiguousHourBucketDoesNotChangeTheCurrentQuery() = runTest {
        val viewModel = DashboardViewModel(
            repository = TrendRepository(),
            cache = TrendCache(),
            timeProvider = TrendTimeProvider,
            automaticRefreshEnabled = false
        )
        runCurrent()
        viewModel.selectRange(RangeKey.Week)
        runCurrent()

        assertFalse(viewModel.openTrendBucket("08:00", DashboardSection.Details))
        assertEquals(RangeKey.Week, viewModel.uiState.value.query.range)
        assertTrue(viewModel.uiState.value.error?.message?.contains("无法从该趋势时段") == true)
    }

    @Test
    fun futureTrendDateDoesNotBypassTheCurrentQueryBoundary() = runTest {
        val viewModel = DashboardViewModel(
            repository = TrendRepository(),
            cache = TrendCache(),
            timeProvider = TrendTimeProvider,
            automaticRefreshEnabled = false
        )
        runCurrent()

        assertFalse(viewModel.openTrendBucket("2026-09-10T08:00:00", DashboardSection.Details))
        assertEquals(RangeKey.Today, viewModel.uiState.value.query.range)
        assertTrue(viewModel.uiState.value.error?.message?.contains("可信查询范围") == true)
    }

    private class TrendRepository : DashboardDataSource {
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

        override suspend fun fetchStats(
            session: MobileSession,
            query: DashboardQuery,
            entity: DashboardEntity?
        ): Pair<MobileSession, StatsData> = session to stats()
    }

    private class TrendCache : DashboardSnapshotStore {
        override suspend fun load(key: DashboardCacheKey): DashboardCachedSnapshot? = null

        override suspend fun save(
            key: DashboardCacheKey,
            snapshot: DashboardCachedSnapshot,
            requestId: Long
        ) = Unit

        override suspend fun clearUser(userId: String) = Unit
    }

    private data object TrendTimeProvider : DashboardTimeProvider {
        override fun nowEpochMillis(): Long = 1_788_912_000_000L

        override fun currentDate(): LocalDate = LocalDate.of(2026, 9, 9)

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

        fun stats() = StatsData(
            summary = Summary(inputTokens = 1),
            tools = emptyMap(),
            models = emptyMap(),
            trends = emptyList(),
            heatmap = emptyMap(),
            history = emptyList(),
            machines = emptyList(),
            meta = null,
            capabilities = DashboardCapabilities(details = true, multiFilterSearch = true)
        )
    }
}
