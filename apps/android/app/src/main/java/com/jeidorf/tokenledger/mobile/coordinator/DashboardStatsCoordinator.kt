package com.jeidorf.tokenledger.mobile.coordinator

import com.jeidorf.tokenledger.mobile.DashboardAuthExpiredException
import com.jeidorf.tokenledger.mobile.DashboardCacheKey
import com.jeidorf.tokenledger.mobile.DashboardCachedSnapshot
import com.jeidorf.tokenledger.mobile.DashboardDataSource
import com.jeidorf.tokenledger.mobile.DashboardEntity
import com.jeidorf.tokenledger.mobile.DashboardLoadingMode
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.DashboardQueryContract
import com.jeidorf.tokenledger.mobile.DashboardRequestIdentity
import com.jeidorf.tokenledger.mobile.DashboardSnapshotStore
import com.jeidorf.tokenledger.mobile.DashboardTimeProvider
import com.jeidorf.tokenledger.mobile.DashboardUiError
import com.jeidorf.tokenledger.mobile.MobileSession
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.SupabaseHttpException
import java.io.IOException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal data class StatsSubState(
    val data: StatsData? = null,
    val cachedData: StatsData? = null,
    val loadingMode: DashboardLoadingMode = DashboardLoadingMode.Idle,
    val error: DashboardUiError? = null,
    val lastUpdatedEpochMillis: Long? = null,
    val showingCachedData: Boolean = false,
    val loadingMore: Boolean = false,
    val paginationError: String? = null,
    /** Canonical session/query/entity identity for [data] or [cachedData]. */
    val contentIdentity: String? = null
) {
    val visibleData: StatsData?
        get() = data ?: cachedData
}

internal data class DashboardRequestKey(
    val requestId: Long,
    val sessionGeneration: Long,
    val userId: String,
    val query: DashboardQuery,
    val entity: DashboardEntity?,
    val timezoneId: String
) {
    fun cacheKey(): DashboardCacheKey = DashboardCacheKey.from(
        userId = userId,
        query = query,
        timezoneId = timezoneId,
        entity = entity
    )

    fun contentIdentity(): String = "$sessionGeneration|${cacheKey().canonicalValue()}"
}

internal class DashboardStatsCoordinator(
    private val repository: DashboardDataSource,
    private val cache: DashboardSnapshotStore,
    private val timeProvider: DashboardTimeProvider,
    private val coroutineScope: CoroutineScope,
    private val getSessionGeneration: () -> Long,
    private val getCurrentSession: () -> MobileSession?,
    private val onSessionPersist: suspend (MobileSession, () -> Boolean) -> Boolean,
    private val onSessionUpdated: (MobileSession) -> Unit,
    private val onAuthExpired: (String) -> Unit,
    private val onPresetCalendarPublish: (requestKey: DashboardRequestKey, stats: StatsData, showingCachedData: Boolean) -> Unit,
    private val onCalendarSynchronize: (query: DashboardQuery, entity: DashboardEntity?, session: MobileSession) -> Unit,
    private val onQuotaTrigger: (session: MobileSession, force: Boolean) -> Unit,
    private val onFallbackQueryReset: (fallbackQuery: DashboardQuery) -> Unit
) {
    companion object {
        const val FOREGROUND_REFRESH_INTERVAL_MS = 60_000L
    }

    private val _statsState = MutableStateFlow(StatsSubState())
    val statsState: StateFlow<StatsSubState> = _statsState.asStateFlow()

    private var activeRequestId = 0L
    private var activePaginationRequestId = 0L
    private var requestJob: Job? = null
    private var paginationJob: Job? = null
    private var cacheClearJob: Job? = null

    var lastSuccessfulDate: LocalDate? = null
        private set
    var lastSuccessfulAtEpochMillis = 0L
        private set
    var lastSuccessfulTimezoneId: String? = null
        private set
    var forceQuotaAfterDashboard = false

    val isRequestActive: Boolean
        get() = requestJob?.isActive == true

    fun setStatsStateFor(
        query: DashboardQuery,
        entity: DashboardEntity?,
        state: StatsSubState
    ) {
        val session = getCurrentSession()
        val identity = session?.let {
            DashboardRequestKey(
                requestId = 0L,
                sessionGeneration = getSessionGeneration(),
                userId = it.userId,
                query = DashboardQueryContract.normalize(query),
                entity = entity?.let(DashboardQueryContract::normalizeEntity),
                timezoneId = timeProvider.timezoneId()
            ).contentIdentity()
        }
        _statsState.value = state.copy(contentIdentity = identity)
    }

    fun updateStatsState(transform: (StatsSubState) -> StatsSubState) {
        _statsState.update(transform)
    }

    fun startDashboardRequest(
        currentQuery: DashboardQuery,
        currentEntity: DashboardEntity?
    ) {
        val session = getCurrentSession() ?: return
        val requestId = DashboardRequestIdentity.nextId()
        activeRequestId = requestId
        requestJob?.cancel()
        paginationJob?.cancel()
        activePaginationRequestId = DashboardRequestIdentity.nextId()

        val requestKey = DashboardRequestKey(
            requestId = requestId,
            sessionGeneration = getSessionGeneration(),
            userId = session.userId,
            query = DashboardQueryContract.normalize(currentQuery),
            entity = currentEntity?.let(DashboardQueryContract::normalizeEntity),
            timezoneId = timeProvider.timezoneId()
        )
        val targetContentIdentity = requestKey.contentIdentity()
        val shouldLoadCache = _statsState.value.let {
            it.visibleData == null || it.contentIdentity != targetContentIdentity
        }

        _statsState.update {
            if (!matches(requestKey, currentQuery, currentEntity)) it else it.copy(
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
        onCalendarSynchronize(requestKey.query, requestKey.entity, session)

        requestJob = coroutineScope.launch {
            if (shouldLoadCache) {
                val cached = try {
                    cache.load(requestKey.cacheKey())
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                    null
                }
                if (!isCurrent(requestKey, currentQuery, currentEntity)) return@launch
                if (cached != null) {
                    _statsState.update {
                        if (!matches(requestKey, currentQuery, currentEntity)) it else it.copy(
                            data = null,
                            cachedData = cached.stats,
                            loadingMode = DashboardLoadingMode.Refreshing,
                            lastUpdatedEpochMillis = cached.savedAtEpochMillis,
                            showingCachedData = true,
                            contentIdentity = targetContentIdentity
                        )
                    }
                    onPresetCalendarPublish(requestKey, cached.stats, true)
                }
            }

            val result = try {
                repository.fetchStats(
                    session = currentSession(requestKey, currentQuery, currentEntity) ?: return@launch,
                    query = requestKey.query,
                    entity = requestKey.entity
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (expired: DashboardAuthExpiredException) {
                handleAuthExpired(requestKey, currentQuery, currentEntity)
                return@launch
            } catch (error: Throwable) {
                if (!isCurrent(requestKey, currentQuery, currentEntity)) return@launch
                _statsState.update {
                    if (!matches(requestKey, currentQuery, currentEntity)) it
                    else it.afterRequestFailure(error, targetContentIdentity)
                }
                val forceQuota = forceQuotaAfterDashboard
                forceQuotaAfterDashboard = false
                getCurrentSession()?.let { onQuotaTrigger(it, forceQuota) }
                return@launch
            }

            if (!isCurrent(requestKey, currentQuery, currentEntity)) return@launch
            val (freshSession, freshStats) = result
            if (freshSession.userId != requestKey.userId) {
                handleAuthExpired(requestKey, currentQuery, currentEntity)
                return@launch
            }

            val sessionBeforeCommit = currentSession(requestKey, currentQuery, currentEntity) ?: return@launch
            if (freshSession != sessionBeforeCommit) {
                val persisted = try {
                    onSessionPersist(freshSession) { isCurrent(requestKey, currentQuery, currentEntity) }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Throwable) {
                    if (!isCurrent(requestKey, currentQuery, currentEntity)) return@launch
                    _statsState.update {
                        if (!matches(requestKey, currentQuery, currentEntity)) it
                        else it.afterRequestFailure(error, targetContentIdentity)
                    }
                    return@launch
                }
                if (!persisted) return@launch
            }

            if (
                requestKey.entity == null &&
                requestKey.query.machines.size == 1 &&
                !freshStats.capabilities.details &&
                requestKey.query.machines.single() !in freshStats.machines
            ) {
                _statsState.update {
                    if (!matches(requestKey, currentQuery, currentEntity)) it else it.copy(
                        data = null,
                        cachedData = null,
                        loadingMode = DashboardLoadingMode.InitialLoad,
                        error = null,
                        lastUpdatedEpochMillis = null,
                        showingCachedData = false,
                        contentIdentity = null
                    )
                }
                onSessionUpdated(freshSession)
                val fallbackQuery = requestKey.query.withFilters(machines = emptyList())
                onFallbackQueryReset(fallbackQuery)
                return@launch
            }

            val now = timeProvider.nowEpochMillis()
            lastSuccessfulDate = timeProvider.currentDate()
            lastSuccessfulAtEpochMillis = now
            lastSuccessfulTimezoneId = requestKey.timezoneId
            _statsState.update {
                if (!matches(requestKey, currentQuery, currentEntity)) it else it.copy(
                    data = freshStats,
                    cachedData = null,
                    loadingMode = DashboardLoadingMode.Idle,
                    error = null,
                    lastUpdatedEpochMillis = now,
                    showingCachedData = false,
                    contentIdentity = targetContentIdentity
                )
            }
            onSessionUpdated(freshSession)
            onPresetCalendarPublish(requestKey, freshStats, false)

            val forceQuota = forceQuotaAfterDashboard
            forceQuotaAfterDashboard = false
            onQuotaTrigger(freshSession, forceQuota)

            try {
                cache.save(
                    requestKey.cacheKey(),
                    DashboardCachedSnapshot(stats = freshStats, savedAtEpochMillis = now),
                    requestId = requestKey.requestId
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                // Cache persistence must never turn a successful network refresh into a UI error.
            }
        }
    }

    fun loadMoreDetails(
        currentQuery: DashboardQuery,
        currentEntity: DashboardEntity?
    ) {
        val state = _statsState.value
        val session = getCurrentSession() ?: return
        if (state.loadingMode != DashboardLoadingMode.Idle || isRequestActive) return
        val expectedGeneration = getSessionGeneration()
        val expectedQuery = DashboardQueryContract.normalize(currentQuery)
        val expectedEntity = currentEntity?.let(DashboardQueryContract::normalizeEntity)
        val expectedTimezoneId = timeProvider.timezoneId()
        val expectedContentIdentity = DashboardRequestKey(
            requestId = 0L,
            sessionGeneration = expectedGeneration,
            userId = session.userId,
            query = expectedQuery,
            entity = expectedEntity,
            timezoneId = expectedTimezoneId
        ).contentIdentity()
        if (state.contentIdentity != expectedContentIdentity) return
        val page = state.data?.detailsPage ?: return
        val cursor = page.nextCursor ?: return
        if (!page.hasMore || state.loadingMore) return
        val requestId = DashboardRequestIdentity.nextId()
        activePaginationRequestId = requestId
        val requestKey = DashboardRequestKey(
            requestId = requestId,
            sessionGeneration = expectedGeneration,
            userId = session.userId,
            query = expectedQuery,
            entity = expectedEntity,
            timezoneId = expectedTimezoneId
        )
        paginationJob?.cancel()
        _statsState.update { it.copy(loadingMore = true, paginationError = null) }

        paginationJob = coroutineScope.launch {
            val result = try {
                repository.fetchNextDetails(session, requestKey.query, requestKey.entity, cursor)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (expired: DashboardAuthExpiredException) {
                if (paginationIsCurrent(requestKey)) {
                    onAuthExpired(session.userId)
                }
                return@launch
            } catch (error: Throwable) {
                if (paginationIsCurrent(requestKey)) {
                    _statsState.update {
                        it.copy(
                            loadingMore = false,
                            paginationError = error.message?.takeIf(String::isNotBlank)
                                ?: "无法加载更多"
                        )
                    }
                }
                return@launch
            }
            if (!paginationIsCurrent(requestKey)) return@launch
            val (freshSession, nextPage) = result
            if (freshSession.userId != session.userId) {
                _statsState.update {
                    it.copy(loadingMore = false, paginationError = "会话身份已变化，请重新登录")
                }
                return@launch
            }
            if (freshSession != getCurrentSession()) {
                val persisted = runCatching {
                    onSessionPersist(freshSession) {
                        paginationIsCurrent(requestKey)
                    }
                }.getOrDefault(false)
                if (!persisted || !paginationIsCurrent(requestKey)) {
                    return@launch
                }
            }
            _statsState.update { current ->
                if (!paginationIsCurrent(requestKey)) current
                else {
                    val currentData = current.data ?: return@update current.copy(loadingMore = false)
                    val merged = (currentData.detailsPage ?: page).append(nextPage)
                    current.copy(
                        data = currentData.copy(
                            history = merged.items,
                            detailsPage = merged,
                            entityDashboard = currentData.entityDashboard?.let {
                                it.copy(historyPage = it.historyPage.append(nextPage))
                            }
                        ),
                        loadingMore = false,
                        paginationError = null
                    )
                }
            }
            onSessionUpdated(freshSession)
            if (paginationIsCurrent(requestKey)) {
                val updated = _statsState.value.data
                if (updated != null) {
                    runCatching {
                        cache.save(
                            requestKey.cacheKey(),
                            DashboardCachedSnapshot(
                                stats = updated,
                                savedAtEpochMillis = _statsState.value.lastUpdatedEpochMillis
                                    ?: timeProvider.nowEpochMillis()
                            ),
                            requestId = requestKey.requestId
                        )
                    }
                }
            }
        }
    }

    fun invalidateDashboardRequest() {
        activeRequestId = DashboardRequestIdentity.nextId()
        requestJob?.cancel()
        paginationJob?.cancel()
        activePaginationRequestId = DashboardRequestIdentity.nextId()
    }

    fun invalidateClockSensitiveData() {
        _statsState.update {
            it.copy(
                data = null,
                cachedData = null,
                loadingMode = DashboardLoadingMode.InitialLoad,
                error = null,
                lastUpdatedEpochMillis = null,
                showingCachedData = false,
                contentIdentity = null
            )
        }
    }

    fun resetRefreshBookkeeping() {
        lastSuccessfulDate = null
        lastSuccessfulAtEpochMillis = 0L
        lastSuccessfulTimezoneId = null
        forceQuotaAfterDashboard = false
    }

    fun enqueueCacheClear(userId: String) {
        val previous = cacheClearJob
        cacheClearJob = coroutineScope.launch {
            previous?.join()
            runCatching { cache.clearUser(userId) }
        }
    }

    fun currentCacheClearJob(): Job? = cacheClearJob

    fun reset() {
        invalidateDashboardRequest()
        resetRefreshBookkeeping()
        _statsState.value = StatsSubState()
    }

    private fun currentSession(
        requestKey: DashboardRequestKey,
        currentQuery: DashboardQuery,
        currentEntity: DashboardEntity?
    ): MobileSession? {
        if (!isCurrent(requestKey, currentQuery, currentEntity)) return null
        return getCurrentSession()
    }

    private fun isCurrent(
        requestKey: DashboardRequestKey,
        currentQuery: DashboardQuery,
        currentEntity: DashboardEntity?
    ): Boolean = matches(requestKey, currentQuery, currentEntity)

    private fun StatsSubState.afterRequestFailure(
        error: Throwable,
        targetContentIdentity: String
    ): StatsSubState {
        val retained = if (contentIdentity == targetContentIdentity) {
            this
        } else {
            copy(
                data = null,
                cachedData = null,
                lastUpdatedEpochMillis = null,
                showingCachedData = false,
                contentIdentity = null
            )
        }
        return retained.copy(
            loadingMode = DashboardLoadingMode.Idle,
            error = error.toUiError(
                hasVisibleData = retained.visibleData != null,
                lastUpdatedEpochMillis = retained.lastUpdatedEpochMillis
            )
        )
    }

    private fun matches(
        requestKey: DashboardRequestKey,
        currentQuery: DashboardQuery,
        currentEntity: DashboardEntity?
    ): Boolean =
        requestKey.requestId == activeRequestId &&
            requestKey.sessionGeneration == getSessionGeneration() &&
            requestKey.userId == getCurrentSession()?.userId &&
            requestKey.query == currentQuery &&
            requestKey.entity == currentEntity &&
            requestKey.timezoneId == timeProvider.timezoneId()

    private fun paginationIsCurrent(requestKey: DashboardRequestKey): Boolean =
        requestKey.requestId == activePaginationRequestId &&
            requestKey.sessionGeneration == getSessionGeneration() &&
            requestKey.userId == getCurrentSession()?.userId &&
            requestKey.timezoneId == timeProvider.timezoneId() &&
            requestKey.contentIdentity() == _statsState.value.contentIdentity &&
            !isRequestActive

    private fun handleAuthExpired(
        requestKey: DashboardRequestKey,
        currentQuery: DashboardQuery,
        currentEntity: DashboardEntity?
    ) {
        if (!isCurrent(requestKey, currentQuery, currentEntity)) return
        onAuthExpired(requestKey.userId)
    }

    private fun Throwable.toUiError(
        hasVisibleData: Boolean,
        lastUpdatedEpochMillis: Long?
    ): DashboardUiError {
        val suffix = if (hasVisibleData) {
            lastUpdatedEpochMillis?.let {
                "，正在显示 ${formatLastUpdated(it)} 的数据"
            } ?: "，继续显示上次成功的数据"
        } else {
            ""
        }
        return when {
            this is IOException -> DashboardUiError.Network("网络不可用$suffix")
            this is SupabaseHttpException && (status == 408 || status == 429 || status >= 500) ->
                DashboardUiError.Network("云端暂时不可用$suffix")
            else -> DashboardUiError.Unexpected(
                message?.takeIf(String::isNotBlank) ?: "加载失败"
            )
        }
    }

    private fun formatLastUpdated(epochMillis: Long): String {
        val zone = runCatching { ZoneId.of(timeProvider.timezoneId()) }
            .getOrDefault(ZoneId.systemDefault())
        return DateTimeFormatter.ofPattern("MM-dd HH:mm", Locale.SIMPLIFIED_CHINESE)
            .format(Instant.ofEpochMilli(epochMillis).atZone(zone))
    }
}
