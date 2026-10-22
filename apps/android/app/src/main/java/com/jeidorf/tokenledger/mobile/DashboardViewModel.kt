package com.jeidorf.tokenledger.mobile

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.jeidorf.tokenledger.mobile.coordinator.CalendarHeatmapCoordinator
import com.jeidorf.tokenledger.mobile.coordinator.DashboardStatsCoordinator
import com.jeidorf.tokenledger.mobile.coordinator.DrillDownCoordinator
import com.jeidorf.tokenledger.mobile.coordinator.FilterAndQueryCoordinator
import com.jeidorf.tokenledger.mobile.coordinator.QuotaSyncCoordinator
import com.jeidorf.tokenledger.mobile.coordinator.SessionCoordinator
import com.jeidorf.tokenledger.mobile.coordinator.StandbyDisplayCoordinator
import com.jeidorf.tokenledger.mobile.coordinator.StandbySubState
import java.time.Duration
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Process-wide request identities keep cache writes ordered even when an old ViewModel outlives a
 * replacement. A new process gets a new writer ID, so reset counters never compare against an
 * identity from a previous process lifetime.
 */
internal object DashboardRequestIdentity {
    val writerId: String = UUID.randomUUID().toString()
    private val requestCounter = AtomicLong(0L)
    private val sessionGenerationCounter = AtomicLong(0L)

    fun nextId(): Long = requestCounter.incrementAndGet()

    fun nextSessionGeneration(): Long = sessionGenerationCounter.incrementAndGet()
}

internal interface DashboardTimeProvider {
    fun nowEpochMillis(): Long

    fun currentDate(): LocalDate

    fun timezoneId(): String

    fun millisUntilNextMidnight(): Long
}

internal object SystemDashboardTimeProvider : DashboardTimeProvider {
    override fun nowEpochMillis(): Long = System.currentTimeMillis()

    override fun currentDate(): LocalDate = LocalDate.now()

    override fun timezoneId(): String = ZoneId.systemDefault().id.ifBlank { "UTC" }

    override fun millisUntilNextMidnight(): Long {
        val now = ZonedDateTime.now()
        val nextMidnight = now.toLocalDate().plusDays(1).atStartOfDay(now.zone)
        return Duration.between(now, nextMidnight).toMillis().coerceAtLeast(1_000L)
    }
}

internal fun calendarHeatmapQuery(query: DashboardQuery, today: LocalDate): DashboardQuery =
    com.jeidorf.tokenledger.mobile.coordinator.calendarHeatmapQuery(query, today)

class DashboardViewModel internal constructor(
    private val repository: DashboardDataSource,
    private val cache: DashboardSnapshotStore,
    private val quotaRepository: QuotaDataSource = DisabledQuotaDataSource,
    private val quotaCache: QuotaSnapshotStore = NoopQuotaSnapshotStore,
    private val dailyQuoteRepository: DailyQuoteDataSource = LocalDailyQuoteDataSource,
    private val timeProvider: DashboardTimeProvider = SystemDashboardTimeProvider,
    private val automaticRefreshEnabled: Boolean = true,
    private val quotaFreshnessSchedulingEnabled: Boolean = true
) : ViewModel() {
    private val mutableUiState = MutableStateFlow(
        DashboardUiState(configured = repository.isConfigured)
    )
    val uiState: StateFlow<DashboardUiState> = mutableUiState.asStateFlow()

    private val sessionCoordinator = SessionCoordinator(
        repository = repository,
        coroutineScope = viewModelScope
    )

    private val filterCoordinator = FilterAndQueryCoordinator(
        initialQuery = DashboardQuery(),
        onQueryChanged = { newQuery ->
            mutableUiState.update {
                it.copy(
                    query = newQuery,
                    loadingMode = if (it.visibleData == null) {
                        DashboardLoadingMode.InitialLoad
                    } else {
                        DashboardLoadingMode.Refreshing
                    },
                    error = null,
                    loadingMore = false,
                    paginationError = null
                )
            }
            startDashboardRequest()
        },
        onError = { error ->
            mutableUiState.update { it.copy(error = error) }
        }
    )

    private val drillDownCoordinator = DrillDownCoordinator(
        timeProvider = timeProvider,
        onError = { error ->
            mutableUiState.update { it.copy(error = error) }
        }
    )

    private val standbyCoordinator = StandbyDisplayCoordinator(
        dailyQuoteRepository = dailyQuoteRepository,
        timeProvider = timeProvider,
        coroutineScope = viewModelScope,
        automaticRefreshEnabled = automaticRefreshEnabled,
        hasSession = { mutableUiState.value.session != null },
        getSessionGeneration = { sessionCoordinator.sessionGeneration },
        onTriggerRefresh = { forceQuota ->
            if (forceQuota) {
                statsCoordinator.forceQuotaAfterDashboard = true
            }
            if (!statsCoordinator.isRequestActive) {
                quotaCoordinator.reevaluateQuotaNow()
                startDashboardRequest()
            }
        },
        onTriggerMidnightRefresh = {
            statsCoordinator.invalidateClockSensitiveData()
            mutableUiState.update {
                it.copy(
                    data = null,
                    cachedData = null,
                    loadingMode = DashboardLoadingMode.InitialLoad,
                    error = null,
                    lastUpdatedEpochMillis = null,
                    showingCachedData = false
                )
            }
            startDashboardRequest()
        }
    )

    private val calendarCoordinator = CalendarHeatmapCoordinator(
        repository = repository,
        cache = cache,
        timeProvider = timeProvider,
        coroutineScope = viewModelScope,
        sessionMutationMutex = sessionCoordinator.sessionMutationMutex,
        getCurrentSession = { mutableUiState.value.session },
        getSessionGeneration = { sessionCoordinator.sessionGeneration },
        onSessionUpdated = { freshSession ->
            mutableUiState.update { it.copy(sessionState = DashboardSessionState.Authenticated(freshSession)) }
        },
        onAuthExpired = { userId ->
            handleAuthExpired(userId)
        }
    )

    private val quotaCoordinator = QuotaSyncCoordinator(
        quotaRepository = quotaRepository,
        quotaCache = quotaCache,
        timeProvider = timeProvider,
        coroutineScope = viewModelScope,
        quotaFreshnessSchedulingEnabled = quotaFreshnessSchedulingEnabled,
        getSessionGeneration = { sessionCoordinator.sessionGeneration },
        getCurrentSession = { mutableUiState.value.session },
        isLowPowerDisplayVisible = { mutableUiState.value.lowPowerDisplayVisible }
    )

    private val statsCoordinator = DashboardStatsCoordinator(
        repository = repository,
        cache = cache,
        timeProvider = timeProvider,
        coroutineScope = viewModelScope,
        getSessionGeneration = { sessionCoordinator.sessionGeneration },
        getCurrentSession = { mutableUiState.value.session },
        onSessionPersist = { freshSession, isCurrent ->
            sessionCoordinator.persistSessionIfCurrent(freshSession, isCurrent)
        },
        onSessionUpdated = { freshSession ->
            mutableUiState.update { it.copy(sessionState = DashboardSessionState.Authenticated(freshSession)) }
        },
        onAuthExpired = { userId ->
            handleAuthExpired(userId)
        },
        onPresetCalendarPublish = { reqKey, stats, showingCached ->
            calendarCoordinator.publishPresetCalendarHeatmap(
                requestKeyQuery = reqKey.query,
                requestKeyEntity = reqKey.entity,
                requestKeyTimezoneId = reqKey.timezoneId,
                stats = stats,
                currentQuery = mutableUiState.value.query,
                currentEntity = mutableUiState.value.entity,
                dayReviewReturn = mutableUiState.value.dayReviewReturn,
                showingCachedData = showingCached
            )
        },
        onCalendarSynchronize = { q, e, s ->
            calendarCoordinator.synchronizeCalendarHeatmap(
                query = q,
                entity = e,
                dayReviewReturn = mutableUiState.value.dayReviewReturn,
                session = s
            )
        },
        onQuotaTrigger = { s, force ->
            quotaCoordinator.startQuotaRequestAfterRestore(
                session = s,
                force = force,
                allowLowPowerDisplay = mutableUiState.value.lowPowerDisplayVisible
            )
        },
        onFallbackQueryReset = { fallbackQuery ->
            filterCoordinator.updateQuery(fallbackQuery)
        }
    )

    // Expose granular state flows for high-efficiency UI observing
    internal val quotaState: StateFlow<QuotaUiState> = quotaCoordinator.quotaState
    internal val calendarState: StateFlow<CalendarHeatmapUiState> = calendarCoordinator.calendarState
    internal val standbyState: StateFlow<StandbySubState> = standbyCoordinator.standbyState

    init {
        viewModelScope.launch {
            statsCoordinator.statsState.collect { s ->
                mutableUiState.update {
                    it.copy(
                        data = s.data,
                        cachedData = s.cachedData,
                        loadingMode = s.loadingMode,
                        error = s.error,
                        lastUpdatedEpochMillis = s.lastUpdatedEpochMillis,
                        showingCachedData = s.showingCachedData,
                        loadingMore = s.loadingMore,
                        paginationError = s.paginationError
                    )
                }
            }
        }
        viewModelScope.launch {
            quotaCoordinator.quotaState.collect { q ->
                mutableUiState.update { it.copy(quota = q) }
            }
        }
        viewModelScope.launch {
            calendarCoordinator.calendarState.collect { c ->
                mutableUiState.update { it.copy(calendarHeatmap = c) }
            }
        }
        viewModelScope.launch {
            standbyCoordinator.standbyState.collect { s ->
                mutableUiState.update {
                    it.copy(
                        lowPowerDisplayVisible = s.lowPowerDisplayVisible,
                        dailyQuote = s.dailyQuote
                    )
                }
            }
        }
        viewModelScope.launch {
            drillDownCoordinator.drillDownState.collect { d ->
                mutableUiState.update {
                    it.copy(
                        entity = d.entity,
                        section = d.section,
                        contributionMode = d.contributionMode,
                        navigationStack = d.navigationStack,
                        dayReviewReturn = d.dayReviewReturn
                    )
                }
            }
        }
        viewModelScope.launch {
            filterCoordinator.queryState.collect { q ->
                mutableUiState.update { it.copy(query = q) }
            }
        }
        viewModelScope.launch {
            sessionCoordinator.sessionState.collect { sess ->
                mutableUiState.update { it.copy(sessionState = sess) }
            }
        }

        if (repository.isConfigured) {
            restoreSession()
        } else {
            mutableUiState.update {
                it.copy(
                    sessionState = DashboardSessionState.SignedOut,
                    loadingMode = DashboardLoadingMode.Idle
                )
            }
        }
    }

    fun signIn(email: String, password: String) {
        val sessionClearBarrier = try {
            sessionCoordinator.enqueueSessionClear()
        } catch (_: Throwable) {
            mutableUiState.update { it.copy(error = DashboardUiError.Unexpected("无法撤销旧登录状态，请重试")) }
            return
        }
        val previousUserId = mutableUiState.value.session?.userId
        sessionCoordinator.advanceSessionGeneration()
        statsCoordinator.invalidateDashboardRequest()
        statsCoordinator.reset()
        quotaCoordinator.invalidateQuotaRequest()
        standbyCoordinator.cancelTimers()
        standbyCoordinator.reset()
        statsCoordinator.resetRefreshBookkeeping()
        calendarCoordinator.reset()
        drillDownCoordinator.resetState()
        filterCoordinator.reset()

        val attemptGeneration = sessionCoordinator.sessionGeneration
        previousUserId?.let { statsCoordinator.enqueueCacheClear(it) }
        previousUserId?.let { quotaCoordinator.enqueueQuotaInvalidation(it) }
        val cacheClearBarrier = statsCoordinator.currentCacheClearJob()
        val quotaClearBarrier = quotaCoordinator.currentQuotaMutationJob()

        mutableUiState.update {
            it.copy(
                sessionState = DashboardSessionState.SignedOut,
                data = null,
                cachedData = null,
                loadingMode = DashboardLoadingMode.SigningIn,
                error = null,
                lastUpdatedEpochMillis = null,
                showingCachedData = false,
                quota = QuotaUiState.Unsynced(),
                lowPowerDisplayVisible = false,
                dailyQuote = null
            )
        }

        sessionCoordinator.signIn(
            email = email,
            password = password,
            attemptGeneration = attemptGeneration,
            sessionClearBarrier = sessionClearBarrier,
            barriers = listOf(cacheClearBarrier, quotaClearBarrier),
            onSuccess = { session ->
                activateSession(session)
            },
            onError = { error ->
                mutableUiState.update {
                    it.copy(
                        sessionState = DashboardSessionState.SignedOut,
                        loadingMode = DashboardLoadingMode.Idle,
                        error = error
                    )
                }
            }
        )
    }

    fun selectRange(range: RangeKey) {
        filterCoordinator.selectRange(range, hasSession = mutableUiState.value.session != null)
    }

    fun selectCustomRange(start: String, end: String) {
        filterCoordinator.selectCustomRange(start, end, hasSession = mutableUiState.value.session != null)
    }

    fun openDayDetails(date: String): Boolean = drillDownCoordinator.openDayDetails(
        date = date,
        targetSection = DashboardSection.Details,
        trustedTrendDate = false,
        currentQuery = mutableUiState.value.query,
        visibleData = mutableUiState.value.visibleData,
        calendarHeatmap = mutableUiState.value.calendarHeatmap,
        lastUpdatedEpochMillis = mutableUiState.value.lastUpdatedEpochMillis,
        showingCachedData = mutableUiState.value.showingCachedData,
        hasSession = mutableUiState.value.session != null,
        customRangeQueryResolver = { sq, s, e ->
            filterCoordinator.customRangeQueryOrReport(sq, s, e)
        },
        onExecuteDayDrill = { query ->
            filterCoordinator.setQueryDirectly(query)
            mutableUiState.update {
                it.copy(
                    query = query,
                    loadingMode = if (it.visibleData == null) {
                        DashboardLoadingMode.InitialLoad
                    } else {
                        DashboardLoadingMode.Refreshing
                    },
                    error = null,
                    loadingMore = false,
                    paginationError = null
                )
            }
            startDashboardRequest()
        }
    )

    fun openTrendBucket(bucket: String, targetSection: DashboardSection): Boolean {
        val current = mutableUiState.value
        return drillDownCoordinator.openTrendBucket(
            bucket = bucket,
            targetSection = targetSection,
            currentQuery = current.query,
            visibleData = current.visibleData,
            calendarHeatmap = current.calendarHeatmap,
            lastUpdatedEpochMillis = current.lastUpdatedEpochMillis,
            showingCachedData = current.showingCachedData,
            hasSession = current.session != null,
            customRangeQueryResolver = { sq, s, e ->
                filterCoordinator.customRangeQueryOrReport(sq, s, e)
            },
            onExecuteDayDrill = { query ->
                filterCoordinator.setQueryDirectly(query)
                mutableUiState.update {
                    it.copy(
                        query = query,
                        loadingMode = if (it.visibleData == null) {
                            DashboardLoadingMode.InitialLoad
                        } else {
                            DashboardLoadingMode.Refreshing
                        },
                        error = null,
                        loadingMore = false,
                        paginationError = null
                    )
                }
                startDashboardRequest()
            }
        )
    }

    fun restoreGlobalQueryFromDayReview(): Boolean =
        drillDownCoordinator.restoreGlobalQueryFromDayReview { destination, source ->
            filterCoordinator.setQueryDirectly(destination.query)
            val sourceData = source?.stats?.takeUnless { source.showingCachedData }
            val sourceCached = source?.stats?.takeIf { source.showingCachedData }
            val mode = if (source != null) DashboardLoadingMode.Refreshing else DashboardLoadingMode.InitialLoad
            statsCoordinator.setStatsStateFor(
                query = destination.query,
                entity = destination.entity,
                state = com.jeidorf.tokenledger.mobile.coordinator.StatsSubState(
                    data = sourceData,
                    cachedData = sourceCached,
                    loadingMode = mode,
                    lastUpdatedEpochMillis = source?.lastUpdatedEpochMillis,
                    showingCachedData = source?.showingCachedData ?: false
                )
            )
            mutableUiState.update {
                it.copy(
                    query = destination.query,
                    section = destination.section,
                    entity = destination.entity,
                    contributionMode = destination.contributionMode,
                    dayReviewReturn = null,
                    data = sourceData,
                    cachedData = sourceCached,
                    loadingMode = mode,
                    error = null,
                    lastUpdatedEpochMillis = source?.lastUpdatedEpochMillis,
                    showingCachedData = source?.showingCachedData ?: false,
                    loadingMore = false,
                    paginationError = null
                )
            }
            startDashboardRequest()
        }

    fun returnFromDayDetails() {
        restoreGlobalQueryFromDayReview()
    }

    fun selectMachine(machine: String) {
        filterCoordinator.selectMachine(machine, hasSession = mutableUiState.value.session != null)
    }

    fun toggleMachine(machine: String) {
        filterCoordinator.toggleMachine(machine, hasSession = mutableUiState.value.session != null)
    }

    fun selectTool(tool: String?) {
        filterCoordinator.selectTool(tool, hasSession = mutableUiState.value.session != null)
    }

    fun toggleTool(tool: String) {
        filterCoordinator.toggleTool(tool, hasSession = mutableUiState.value.session != null)
    }

    fun selectModel(model: String?) {
        filterCoordinator.selectModel(model, hasSession = mutableUiState.value.session != null)
    }

    fun toggleModel(model: String) {
        filterCoordinator.toggleModel(model, hasSession = mutableUiState.value.session != null)
    }

    fun setSearch(search: String?) {
        filterCoordinator.setSearch(search, hasSession = mutableUiState.value.session != null)
    }

    fun clearFilters() {
        filterCoordinator.clearFilters(hasSession = mutableUiState.value.session != null)
    }

    fun selectSection(section: DashboardSection) {
        drillDownCoordinator.selectSection(section) {
            restoreGlobalQueryFromDayReview()
        }
    }

    fun selectContributionMode(mode: ContributionMode) {
        drillDownCoordinator.selectContributionMode(mode)
    }

    fun openTool(tool: String) {
        drillDownCoordinator.openTool(
            tool = tool,
            currentQuery = mutableUiState.value.query,
            hasSession = mutableUiState.value.session != null
        ) { entityQuery, targetEntity, newStack ->
            filterCoordinator.setQueryDirectly(entityQuery)
            mutableUiState.update {
                it.copy(
                    query = entityQuery,
                    entity = targetEntity,
                    section = DashboardSection.Entity,
                    navigationStack = newStack,
                    loadingMode = if (it.visibleData == null) {
                        DashboardLoadingMode.InitialLoad
                    } else {
                        DashboardLoadingMode.Refreshing
                    },
                    error = null,
                    loadingMore = false,
                    paginationError = null
                )
            }
            startDashboardRequest()
        }
    }

    fun openModel(model: String) {
        drillDownCoordinator.openModel(
            model = model,
            currentQuery = mutableUiState.value.query,
            hasSession = mutableUiState.value.session != null
        ) { entityQuery, targetEntity, newStack ->
            filterCoordinator.setQueryDirectly(entityQuery)
            mutableUiState.update {
                it.copy(
                    query = entityQuery,
                    entity = targetEntity,
                    section = DashboardSection.Entity,
                    navigationStack = newStack,
                    loadingMode = if (it.visibleData == null) {
                        DashboardLoadingMode.InitialLoad
                    } else {
                        DashboardLoadingMode.Refreshing
                    },
                    error = null,
                    loadingMore = false,
                    paginationError = null
                )
            }
            startDashboardRequest()
        }
    }

    fun navigateBack() {
        drillDownCoordinator.navigateBack(
            onRestoreFromDayReview = {
                restoreGlobalQueryFromDayReview()
            },
            onNavigateBackToSnapshot = { destination ->
                filterCoordinator.setQueryDirectly(destination.query)
                mutableUiState.update {
                    it.copy(
                        query = destination.query,
                        entity = destination.entity,
                        section = destination.section,
                        contributionMode = destination.contributionMode,
                        loadingMode = if (it.visibleData == null) {
                            DashboardLoadingMode.InitialLoad
                        } else {
                            DashboardLoadingMode.Refreshing
                        },
                        error = null,
                        loadingMore = false,
                        paginationError = null
                    )
                }
                startDashboardRequest()
            }
        )
    }

    fun loadMoreDetails() {
        statsCoordinator.loadMoreDetails(
            currentQuery = mutableUiState.value.query,
            currentEntity = mutableUiState.value.entity
        )
    }

    fun refresh() {
        if (mutableUiState.value.session != null) {
            statsCoordinator.forceQuotaAfterDashboard = true
            startDashboardRequest()
        }
    }

    fun openLowPowerDisplay() {
        standbyCoordinator.openLowPowerDisplay(hasVisibleData = mutableUiState.value.visibleData != null) {
            quotaCoordinator.reevaluateQuotaNow()
            statsCoordinator.invalidateDashboardRequest()
            quotaCoordinator.invalidateQuotaRequest()
            statsCoordinator.forceQuotaAfterDashboard = true
            mutableUiState.update {
                it.copy(
                    loadingMode = DashboardLoadingMode.Idle,
                    loadingMore = false,
                    quota = (it.quota as? QuotaUiState.Available)?.copy(refreshing = false)
                        ?: it.quota
                )
            }
        }
    }

    fun closeLowPowerDisplay() {
        standbyCoordinator.closeLowPowerDisplay {
            onForeground()
        }
    }

    fun onForeground() {
        val current = mutableUiState.value
        val session = current.session ?: return
        quotaCoordinator.reevaluateQuotaNow()
        standbyCoordinator.onForeground {
            val now = timeProvider.nowEpochMillis()
            val dateChanged = statsCoordinator.lastSuccessfulDate?.let { it != timeProvider.currentDate() } == true
            val timezoneChanged = statsCoordinator.lastSuccessfulTimezoneId?.let {
                it != timeProvider.timezoneId()
            } == true
            val stale = statsCoordinator.lastSuccessfulAtEpochMillis == 0L ||
                now - statsCoordinator.lastSuccessfulAtEpochMillis >= FOREGROUND_REFRESH_INTERVAL_MS
            val initialLoadRunning = current.loadingMode == DashboardLoadingMode.InitialLoad
            if ((dateChanged || timezoneChanged) && !initialLoadRunning) {
                statsCoordinator.invalidateClockSensitiveData()
                startDashboardRequest()
            } else if (stale && !initialLoadRunning) {
                startDashboardRequest()
            }
            if (
                session.expiresAtEpochSeconds > now / 1_000L + 60L &&
                !initialLoadRunning
            ) {
                quotaCoordinator.startQuotaRequestAfterRestore(session)
            }
        }
    }

    fun onBackground() {
        standbyCoordinator.onBackground {
            statsCoordinator.invalidateDashboardRequest()
            quotaCoordinator.invalidateQuotaRequest()
            mutableUiState.update {
                it.copy(
                    loadingMode = DashboardLoadingMode.Idle,
                    quota = (it.quota as? QuotaUiState.Available)?.copy(refreshing = false)
                        ?: it.quota
                )
            }
        }
    }

    fun onClockChanged() {
        standbyCoordinator.onClockChanged {
            quotaCoordinator.resetLastQuotaAttempt()
            quotaCoordinator.reevaluateQuotaNow()
            statsCoordinator.invalidateClockSensitiveData()
            startDashboardRequest()
        }
    }

    fun signOut() {
        try {
            sessionCoordinator.signOut { uid ->
                uid?.let { statsCoordinator.enqueueCacheClear(it) }
                uid?.let { quotaCoordinator.enqueueQuotaInvalidation(it) }
            }
        } catch (_: Throwable) {
            mutableUiState.update { it.copy(error = DashboardUiError.Unexpected("无法保存退出登录状态，请重试")) }
            return
        }
        sessionCoordinator.advanceSessionGeneration()
        sessionCoordinator.cancelActiveAuthJobs()
        statsCoordinator.invalidateDashboardRequest()
        quotaCoordinator.invalidateQuotaRequest()
        standbyCoordinator.cancelTimers()
        standbyCoordinator.reset()
        statsCoordinator.resetRefreshBookkeeping()
        calendarCoordinator.reset()
        drillDownCoordinator.resetState()
        filterCoordinator.reset()
        statsCoordinator.reset()
        quotaCoordinator.reset()
        mutableUiState.value = DashboardUiState(
            configured = repository.isConfigured,
            sessionState = DashboardSessionState.SignedOut,
            loadingMode = DashboardLoadingMode.Idle
        )
    }

    private fun restoreSession() {
        sessionCoordinator.restoreSession(
            onSuccess = { session ->
                activateSession(session)
            },
            onError = { error ->
                mutableUiState.update {
                    it.copy(
                        sessionState = DashboardSessionState.SignedOut,
                        loadingMode = DashboardLoadingMode.Idle,
                        error = error
                    )
                }
            },
            onSignedOut = {
                mutableUiState.update {
                    it.copy(
                        sessionState = DashboardSessionState.SignedOut,
                        loadingMode = DashboardLoadingMode.Idle
                    )
                }
            }
        )
    }

    private fun activateSession(session: MobileSession) {
        filterCoordinator.reset()
        mutableUiState.value = DashboardUiState(
            configured = repository.isConfigured,
            sessionState = DashboardSessionState.Authenticated(session),
            loadingMode = DashboardLoadingMode.InitialLoad,
            quota = QuotaUiState.Loading
        )
        standbyCoordinator.scheduleMidnightRefresh()
        quotaCoordinator.restoreQuotaCache(session)
        startDashboardRequest()
    }

    private fun startDashboardRequest() {
        val current = mutableUiState.value
        if (current.session == null) return
        statsCoordinator.startDashboardRequest(
            currentQuery = current.query,
            currentEntity = current.entity
        )
    }

    private fun handleAuthExpired(userId: String) {
        try {
            sessionCoordinator.handleAuthExpired(userId) { uid ->
                statsCoordinator.enqueueCacheClear(uid)
                quotaCoordinator.enqueueQuotaInvalidation(uid)
            }
        } catch (_: Throwable) {
            mutableUiState.update { it.copy(error = DashboardUiError.Unexpected("登录已失效，但无法清除本地会话，请重试退出登录")) }
            return
        }
        sessionCoordinator.advanceSessionGeneration()
        statsCoordinator.invalidateDashboardRequest()
        quotaCoordinator.invalidateQuotaRequest()
        standbyCoordinator.cancelTimers()
        standbyCoordinator.reset()
        statsCoordinator.resetRefreshBookkeeping()
        calendarCoordinator.reset()
        drillDownCoordinator.resetState()
        filterCoordinator.reset()
        statsCoordinator.reset()
        quotaCoordinator.reset()
        mutableUiState.value = DashboardUiState(
            configured = repository.isConfigured,
            sessionState = DashboardSessionState.Expired(),
            loadingMode = DashboardLoadingMode.Idle
        )
    }

    companion object {
        private const val FOREGROUND_REFRESH_INTERVAL_MS = DashboardStatsCoordinator.FOREGROUND_REFRESH_INTERVAL_MS
        internal const val LOW_POWER_REFRESH_INTERVAL_MS = StandbyDisplayCoordinator.LOW_POWER_REFRESH_INTERVAL_MS

        fun factory(context: Context): ViewModelProvider.Factory {
            val appContext = context.applicationContext
            return object : ViewModelProvider.Factory {
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    require(modelClass.isAssignableFrom(DashboardViewModel::class.java))
                    @Suppress("UNCHECKED_CAST")
                    return DashboardViewModel(
                        repository = DashboardRepository(appContext),
                        cache = DashboardCache(appContext),
                        quotaRepository = QuotaRepository(),
                        quotaCache = QuotaCache(appContext),
                        dailyQuoteRepository = DailyQuoteRepository(appContext)
                    ) as T
                }
            }
        }
    }
}
