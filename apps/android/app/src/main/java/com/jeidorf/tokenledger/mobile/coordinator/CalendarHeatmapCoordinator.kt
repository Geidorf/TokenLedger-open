package com.jeidorf.tokenledger.mobile.coordinator

import com.jeidorf.tokenledger.mobile.CalendarHeatmapUiState
import com.jeidorf.tokenledger.mobile.DashboardAuthExpiredException
import com.jeidorf.tokenledger.mobile.DashboardCacheKey
import com.jeidorf.tokenledger.mobile.DashboardCachedSnapshot
import com.jeidorf.tokenledger.mobile.DashboardDataSource
import com.jeidorf.tokenledger.mobile.DashboardEntity
import com.jeidorf.tokenledger.mobile.DashboardNavigationSnapshot
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.DashboardQueryContract
import com.jeidorf.tokenledger.mobile.DashboardRequestIdentity
import com.jeidorf.tokenledger.mobile.DashboardSnapshotStore
import com.jeidorf.tokenledger.mobile.DashboardTimeProvider
import com.jeidorf.tokenledger.mobile.MobileSession
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.SessionRefreshPolicy
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.SupabaseHttpException
import java.io.IOException
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.concurrent.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal data class CalendarHeatmapRequestKey(
    val requestId: Long,
    val sessionGeneration: Long,
    val userId: String,
    val sourceQuery: DashboardQuery,
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
}

internal data class CalendarHeatmapIdentity(
    val sourceQuery: DashboardQuery,
    val query: DashboardQuery,
    val entity: DashboardEntity?,
    val timezoneId: String
)

internal fun calendarHeatmapQuery(query: DashboardQuery, today: LocalDate): DashboardQuery {
    val normalized = DashboardQueryContract.normalize(query)
    if (normalized.range != RangeKey.Custom) return normalized
    val selectedEnd = LocalDate.parse(requireNotNull(normalized.end))
    val targetDate = minOf(selectedEnd, today)
    val targetEnd = if (targetDate.year == today.year) today else targetDate.withDayOfYear(targetDate.lengthOfYear())
    return DashboardQueryContract.normalize(
        normalized.copy(
            start = targetDate.withDayOfYear(1).toString(),
            end = targetEnd.toString()
        )
    )
}

internal class CalendarHeatmapCoordinator(
    private val repository: DashboardDataSource,
    private val cache: DashboardSnapshotStore,
    private val timeProvider: DashboardTimeProvider,
    private val coroutineScope: CoroutineScope,
    private val sessionMutationMutex: Mutex,
    private val getCurrentSession: () -> MobileSession?,
    private val getSessionGeneration: () -> Long,
    private val onSessionUpdated: (MobileSession) -> Unit,
    private val onAuthExpired: (String) -> Unit
) {
    private val _calendarState = MutableStateFlow<CalendarHeatmapUiState>(CalendarHeatmapUiState.Idle)
    val calendarState: StateFlow<CalendarHeatmapUiState> = _calendarState.asStateFlow()

    private var activeCalendarHeatmapRequestId = 0L
    private var calendarHeatmapIdentity: CalendarHeatmapIdentity? = null
    private var calendarHeatmapJob: Job? = null

    fun currentIdentity(): CalendarHeatmapIdentity? = calendarHeatmapIdentity

    fun setCalendarState(state: CalendarHeatmapUiState) {
        _calendarState.value = state
    }

    fun reset() {
        activeCalendarHeatmapRequestId = DashboardRequestIdentity.nextId()
        calendarHeatmapIdentity = null
        calendarHeatmapJob?.cancel()
        _calendarState.value = CalendarHeatmapUiState.Idle
    }

    fun cancelJob() {
        calendarHeatmapJob?.cancel()
    }

    fun synchronizeCalendarHeatmap(
        query: DashboardQuery,
        entity: DashboardEntity?,
        dayReviewReturn: DashboardNavigationSnapshot?,
        session: MobileSession
    ) {
        val sourceQuery = DashboardQueryContract.normalize(dayReviewReturn?.query ?: query)
        val sourceEntity = (if (dayReviewReturn != null) dayReviewReturn.entity else entity)
            ?.let(DashboardQueryContract::normalizeEntity)
        val calendarQuery = calendarHeatmapQuery(sourceQuery, timeProvider.currentDate())
        val identity = CalendarHeatmapIdentity(
            sourceQuery = sourceQuery,
            query = calendarQuery,
            entity = sourceEntity,
            timezoneId = timeProvider.timezoneId()
        )
        val existing = _calendarState.value
        if (sourceQuery.range != RangeKey.Custom) {
            activeCalendarHeatmapRequestId = DashboardRequestIdentity.nextId()
            calendarHeatmapJob?.cancel()
            val alreadyCurrent = existing is CalendarHeatmapUiState.Available &&
                calendarHeatmapIdentity == identity
            if (!alreadyCurrent) {
                calendarHeatmapIdentity = identity
                _calendarState.value = CalendarHeatmapUiState.Loading(sourceQuery, sourceQuery)
            }
            return
        }
        val alreadyCurrent = calendarHeatmapIdentity == identity &&
            (existing is CalendarHeatmapUiState.Loading ||
                (dayReviewReturn != null && existing is CalendarHeatmapUiState.Available))
        if (alreadyCurrent) return

        val requestKey = CalendarHeatmapRequestKey(
            requestId = DashboardRequestIdentity.nextId(),
            sessionGeneration = getSessionGeneration(),
            userId = session.userId,
            sourceQuery = sourceQuery,
            query = calendarQuery,
            entity = sourceEntity,
            timezoneId = timeProvider.timezoneId()
        )
        activeCalendarHeatmapRequestId = requestKey.requestId
        calendarHeatmapIdentity = identity
        calendarHeatmapJob?.cancel()
        _calendarState.value = CalendarHeatmapUiState.Loading(calendarQuery, sourceQuery)

        calendarHeatmapJob = coroutineScope.launch {
            val cached = try {
                cache.load(requestKey.cacheKey())
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                null
            }
            if (!calendarIsCurrent(requestKey, query, entity, dayReviewReturn)) return@launch
            cached?.stats?.toCalendarHeatmapState(
                requestKey.query,
                requestKey.sourceQuery,
                requestKey.timezoneId,
                showingCachedData = true
            )?.let { available ->
                if (calendarMatches(requestKey, query, entity, dayReviewReturn)) {
                    _calendarState.value = available
                }
            }

            val result = try {
                repository.fetchStats(
                    session = currentCalendarSession(requestKey, query, entity, dayReviewReturn) ?: return@launch,
                    query = requestKey.query,
                    entity = requestKey.entity
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (expired: DashboardAuthExpiredException) {
                handleCalendarAuthExpired(requestKey, query, entity, dayReviewReturn)
                return@launch
            } catch (error: Throwable) {
                if (!calendarIsCurrent(requestKey, query, entity, dayReviewReturn)) return@launch
                if (calendarMatches(requestKey, query, entity, dayReviewReturn)) {
                    val current = _calendarState.value
                    val nextState = if (current is CalendarHeatmapUiState.Available) {
                        current.copy(warning = error.calendarMessage())
                    } else {
                        CalendarHeatmapUiState.Unavailable(requestKey.query, error.calendarMessage())
                    }
                    _calendarState.value = nextState
                }
                return@launch
            }
            if (!calendarIsCurrent(requestKey, query, entity, dayReviewReturn)) return@launch
            val (freshSession, freshStats) = result
            if (freshSession.userId != requestKey.userId) {
                handleCalendarAuthExpired(requestKey, query, entity, dayReviewReturn)
                return@launch
            }
            val currentSession = currentCalendarSession(requestKey, query, entity, dayReviewReturn) ?: return@launch
            if (freshSession != currentSession) {
                val persisted = sessionMutationMutex.withLock {
                    if (!calendarIsCurrent(requestKey, query, entity, dayReviewReturn)) return@withLock false
                    if (SessionRefreshPolicy.isNewer(freshSession, getCurrentSession())) {
                        repository.persistSession(freshSession)
                    }
                    calendarIsCurrent(requestKey, query, entity, dayReviewReturn)
                }
                if (!persisted) return@launch
            }
            val available = freshStats.toCalendarHeatmapState(
                requestKey.query,
                requestKey.sourceQuery,
                requestKey.timezoneId,
                showingCachedData = false
            ) ?: CalendarHeatmapUiState.Unavailable(requestKey.query, "日历响应与请求范围不一致")
            val now = timeProvider.nowEpochMillis()
            if (calendarMatches(requestKey, query, entity, dayReviewReturn)) {
                if (SessionRefreshPolicy.isNewer(freshSession, getCurrentSession())) {
                    onSessionUpdated(freshSession)
                }
                _calendarState.value = available
            }
            if (!calendarIsCurrent(requestKey, query, entity, dayReviewReturn)) return@launch
            try {
                cache.save(
                    requestKey.cacheKey(),
                    DashboardCachedSnapshot(freshStats, now),
                    requestKey.requestId
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                // Calendar cache failure does not affect either dashboard response.
            }
        }
    }

    fun publishPresetCalendarHeatmap(
        requestKeyQuery: DashboardQuery,
        requestKeyEntity: DashboardEntity?,
        requestKeyTimezoneId: String,
        stats: StatsData,
        currentQuery: DashboardQuery,
        currentEntity: DashboardEntity?,
        dayReviewReturn: DashboardNavigationSnapshot?,
        showingCachedData: Boolean
    ) {
        if (requestKeyQuery.range == RangeKey.Custom) return
        val sourceQuery = DashboardQueryContract.normalize(dayReviewReturn?.query ?: currentQuery)
        val sourceEntity = if (dayReviewReturn != null) dayReviewReturn.entity else currentEntity
        if (sourceQuery != requestKeyQuery || sourceEntity != requestKeyEntity) return
        val calendar = stats.toCalendarHeatmapState(
            requestKeyQuery,
            requestKeyQuery,
            requestKeyTimezoneId,
            showingCachedData
        ) ?: CalendarHeatmapUiState.Unavailable(requestKeyQuery, "日历响应与请求范围不一致")
        calendarHeatmapIdentity = CalendarHeatmapIdentity(
            sourceQuery = requestKeyQuery,
            query = requestKeyQuery,
            entity = requestKeyEntity,
            timezoneId = requestKeyTimezoneId
        )
        _calendarState.value = calendar
    }

    private fun currentCalendarSession(
        requestKey: CalendarHeatmapRequestKey,
        currentQuery: DashboardQuery,
        currentEntity: DashboardEntity?,
        dayReviewReturn: DashboardNavigationSnapshot?
    ): MobileSession? =
        getCurrentSession().takeIf { calendarIsCurrent(requestKey, currentQuery, currentEntity, dayReviewReturn) }

    private fun calendarIsCurrent(
        requestKey: CalendarHeatmapRequestKey,
        currentQuery: DashboardQuery,
        currentEntity: DashboardEntity?,
        dayReviewReturn: DashboardNavigationSnapshot?
    ): Boolean = calendarMatches(requestKey, currentQuery, currentEntity, dayReviewReturn)

    private fun calendarMatches(
        requestKey: CalendarHeatmapRequestKey,
        currentQuery: DashboardQuery,
        currentEntity: DashboardEntity?,
        dayReviewReturn: DashboardNavigationSnapshot?
    ): Boolean {
        val source = dayReviewReturn
        val sourceQuery = DashboardQueryContract.normalize(source?.query ?: currentQuery)
        val sourceEntity = if (source != null) source.entity else currentEntity
        return requestKey.requestId == activeCalendarHeatmapRequestId &&
            requestKey.sessionGeneration == getSessionGeneration() &&
            requestKey.userId == getCurrentSession()?.userId &&
            requestKey.sourceQuery == sourceQuery &&
            requestKey.entity == sourceEntity &&
            requestKey.timezoneId == timeProvider.timezoneId()
    }

    private fun handleCalendarAuthExpired(
        requestKey: CalendarHeatmapRequestKey,
        currentQuery: DashboardQuery,
        currentEntity: DashboardEntity?,
        dayReviewReturn: DashboardNavigationSnapshot?
    ) {
        if (!calendarIsCurrent(requestKey, currentQuery, currentEntity, dayReviewReturn)) return
        onAuthExpired(requestKey.userId)
    }

    private fun StatsData.toCalendarHeatmapState(
        query: DashboardQuery,
        selectionQuery: DashboardQuery,
        timezoneId: String,
        showingCachedData: Boolean
    ): CalendarHeatmapUiState.Available? {
        val metadata = meta ?: return null
        val echo = metadata.query ?: return null
        if (metadata.timezone != timezoneId) return null
        val matchesQuery = runCatching {
            DashboardQueryContract.canonical(echo) ==
                DashboardQueryContract.canonical(query, timezoneId)
        }.getOrDefault(false)
        if (!matchesQuery || heatmap.keys.any { runCatching { LocalDate.parse(it) }.isFailure } ||
            heatmap.values.any { it < 0L }) return null

        val cutoff = parseCalendarCutoffDate(metadata.generatedAt, timezoneId) ?: return null
        val coverage = if (query.range == RangeKey.Custom) {
            val start = LocalDate.parse(requireNotNull(query.start))
            val end = minOf(LocalDate.parse(requireNotNull(query.end)), cutoff)
            if (start > end) return null
            start.toString() to end.toString()
        } else {
            cutoff.withDayOfYear(1).toString() to cutoff.toString()
        }
        return CalendarHeatmapUiState.Available(
            heatmap = heatmap,
            query = query,
            selectionQuery = selectionQuery,
            timezone = timezoneId,
            generatedAt = metadata.generatedAt,
            coverageStart = coverage.first,
            coverageEnd = coverage.second,
            showingCachedData = showingCachedData,
            heatmapRequests = heatmapRequests,
            heatmapCost = heatmapCost
        )
    }

    private fun parseCalendarCutoffDate(value: String?, timezoneId: String): LocalDate? {
        val raw = value?.takeIf(String::isNotBlank) ?: return null
        val zone = runCatching { ZoneId.of(timezoneId) }.getOrNull() ?: return null
        return runCatching { ZonedDateTime.parse(raw).withZoneSameInstant(zone).toLocalDate() }.getOrNull()
            ?: runCatching { OffsetDateTime.parse(raw).atZoneSameInstant(zone).toLocalDate() }.getOrNull()
            ?: runCatching { Instant.parse(raw).atZone(zone).toLocalDate() }.getOrNull()
            ?: runCatching { LocalDate.parse(raw) }.getOrNull()
    }

    private fun Throwable.calendarMessage(): String = when {
        this is IOException -> "日历数据暂时不可用"
        this is SupabaseHttpException && (status == 408 || status == 429 || status >= 500) ->
            "日历数据暂时不可用"
        else -> message?.takeIf(String::isNotBlank) ?: "日历数据加载失败"
    }
}
