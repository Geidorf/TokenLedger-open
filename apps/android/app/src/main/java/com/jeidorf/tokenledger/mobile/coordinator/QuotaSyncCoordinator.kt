package com.jeidorf.tokenledger.mobile.coordinator

import com.jeidorf.tokenledger.mobile.DashboardRequestIdentity
import com.jeidorf.tokenledger.mobile.DashboardTimeProvider
import com.jeidorf.tokenledger.mobile.MobileSession
import com.jeidorf.tokenledger.mobile.QUOTA_READ_V2_FUNCTION
import com.jeidorf.tokenledger.mobile.QUOTA_TRANSPORT_VERSION
import com.jeidorf.tokenledger.mobile.QuotaCacheKey
import com.jeidorf.tokenledger.mobile.QuotaCacheWriteIdentity
import com.jeidorf.tokenledger.mobile.QuotaCachedSnapshot
import com.jeidorf.tokenledger.mobile.QuotaContractException
import com.jeidorf.tokenledger.mobile.QuotaDataSource
import com.jeidorf.tokenledger.mobile.QuotaSnapshotStore
import com.jeidorf.tokenledger.mobile.QuotaTransportSnapshot
import com.jeidorf.tokenledger.mobile.QuotaUiState
import com.jeidorf.tokenledger.mobile.SupabaseHttpException
import com.jeidorf.tokenledger.mobile.SupabaseResponseTooLargeException
import com.jeidorf.tokenledger.mobile.isMissingRpcSignature
import com.jeidorf.tokenledger.mobile.isQuotaCacheReadable
import com.jeidorf.tokenledger.mobile.nextFreshnessDeadline
import java.io.IOException
import java.time.Instant
import java.util.concurrent.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal data class QuotaRequestKey(
    val requestId: Long,
    val sessionGeneration: Long,
    val userId: String,
    val transportVersion: Int = QUOTA_TRANSPORT_VERSION
) {
    fun cacheKey(): QuotaCacheKey = QuotaCacheKey(userId, transportVersion)
}

internal class QuotaSyncCoordinator(
    private val quotaRepository: QuotaDataSource,
    private val quotaCache: QuotaSnapshotStore,
    private val timeProvider: DashboardTimeProvider,
    private val coroutineScope: CoroutineScope,
    private val quotaFreshnessSchedulingEnabled: Boolean = true,
    private val getSessionGeneration: () -> Long,
    private val getCurrentSession: () -> MobileSession?,
    private val isLowPowerDisplayVisible: () -> Boolean
) {
    companion object {
        private const val QUOTA_FOREGROUND_INTERVAL_MS = 15L * 60L * 1_000L
    }

    private val _quotaState = MutableStateFlow<QuotaUiState>(QuotaUiState.Unsynced())
    val quotaState: StateFlow<QuotaUiState> = _quotaState.asStateFlow()

    // 空投影也保留版本水位，避免 Unsynced 丢失 latest-wins 依据。
    private var latestSnapshot: QuotaTransportSnapshot? = null
    private var latestSnapshotSession: Pair<String, Long>? = null
    private var activeQuotaRequestId = 0L
    private var lastQuotaAttemptEpochMillis = 0L
    private var quotaRestoreJob: Job? = null
    private var quotaStartAfterRestoreJob: Job? = null
    private var quotaJob: Job? = null
    private var quotaFreshnessJob: Job? = null
    private var quotaCacheMutationJob: Job? = null

    fun currentQuota(): QuotaUiState = _quotaState.value

    fun setQuota(state: QuotaUiState) {
        _quotaState.value = state
    }

    fun restoreQuotaCache(session: MobileSession) {
        val requestKey = newQuotaRequestKey(session)
        quotaRestoreJob?.cancel()
        if (quotaMatches(requestKey)) {
            _quotaState.value = QuotaUiState.Loading
        }
        quotaRestoreJob = coroutineScope.launch {
            val now = timeProvider.nowEpochMillis()
            val cachedEntry = try {
                quotaCache.load(requestKey.cacheKey(), now)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                null
            }
            if (!quotaIsCurrent(requestKey)) return@launch
            val cached = cachedEntry?.takeIf {
                isQuotaCacheReadable(
                    metadata = it.metadata,
                    writerId = DashboardRequestIdentity.writerId,
                    requestId = requestKey.requestId,
                    sessionGeneration = requestKey.sessionGeneration
                )
            }?.snapshot
            if (cachedEntry != null && cached == null) {
                enqueueQuotaInvalidation(
                    userId = requestKey.userId,
                    requestId = requestKey.requestId,
                    generation = requestKey.sessionGeneration,
                    epoch = cachedEntry.snapshot.snapshot.epoch,
                    revision = cachedEntry.snapshot.snapshot.revision
                )
            }
            if (quotaMatches(requestKey)) {
                latestSnapshot = cached?.snapshot
                latestSnapshotSession = requestKey.userId to requestKey.sessionGeneration
                _quotaState.value = if (cached == null || cached.snapshot.providers.isEmpty()) {
                    QuotaUiState.Unsynced()
                } else {
                    QuotaUiState.Available(
                        snapshot = cached.snapshot,
                        showingCachedData = true,
                        savedAtEpochMillis = cached.savedAtEpochMillis,
                        evaluatedAtEpochMillis = now,
                        refreshing = false,
                        warning = "正在显示本机保存的历史快照"
                    )
                }
            }
            scheduleQuotaFreshness()
        }
    }

    fun startQuotaRequestAfterRestore(
        session: MobileSession,
        force: Boolean = false,
        allowLowPowerDisplay: Boolean = false
    ) {
        val expectedGeneration = getSessionGeneration()
        val restore = quotaRestoreJob
        if (restore == null || !restore.isActive) {
            startQuotaRequest(session, force, allowLowPowerDisplay)
            return
        }
        quotaStartAfterRestoreJob?.cancel()
        quotaStartAfterRestoreJob = coroutineScope.launch {
            restore.join()
            val currentSession = getCurrentSession()
            if (
                getSessionGeneration() != expectedGeneration ||
                isLowPowerDisplayVisible() != allowLowPowerDisplay ||
                currentSession?.userId != session.userId
            ) {
                return@launch
            }
            startQuotaRequest(currentSession, force, allowLowPowerDisplay)
        }
    }

    fun startQuotaRequest(
        session: MobileSession,
        force: Boolean = false,
        allowLowPowerDisplay: Boolean = false
    ) {
        if (
            isLowPowerDisplayVisible() != allowLowPowerDisplay ||
            getCurrentSession()?.userId != session.userId
        ) {
            return
        }
        val now = timeProvider.nowEpochMillis()
        if (
            !force && lastQuotaAttemptEpochMillis > 0L &&
            now >= lastQuotaAttemptEpochMillis &&
            now - lastQuotaAttemptEpochMillis < QUOTA_FOREGROUND_INTERVAL_MS
        ) {
            return
        }
        lastQuotaAttemptEpochMillis = now
        val requestKey = newQuotaRequestKey(session)
        quotaJob?.cancel()
        if (quotaMatches(requestKey)) {
            val available = _quotaState.value as? QuotaUiState.Available
            _quotaState.value = available?.copy(refreshing = true, warning = null)
                ?: QuotaUiState.Loading
        }
        quotaJob = coroutineScope.launch {
            val snapshot = try {
                quotaRepository.fetchQuotaSnapshots(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                handleQuotaFailure(requestKey, error)
                return@launch
            }
            if (!quotaIsCurrent(requestKey)) return@launch
            val current = _quotaState.value as? QuotaUiState.Available
            val latest = latestSnapshot?.takeIf {
                latestSnapshotSession == (requestKey.userId to requestKey.sessionGeneration)
            } ?: current?.snapshot
            if (latest != null && snapshot.isOlderThan(latest)) {
                if (quotaMatches(requestKey)) {
                    _quotaState.value = current?.copy(
                        showingCachedData = true,
                        evaluatedAtEpochMillis = timeProvider.nowEpochMillis(),
                        refreshing = false,
                        warning = "云端返回了较旧的额度修订，已保留较新的本机快照"
                    ) ?: QuotaUiState.Unsynced()
                }
                scheduleQuotaFreshness()
                return@launch
            }

            val receivedAt = timeProvider.nowEpochMillis()
            if (quotaMatches(requestKey)) {
                latestSnapshot = snapshot
                latestSnapshotSession = requestKey.userId to requestKey.sessionGeneration
                _quotaState.value = if (snapshot.providers.isEmpty()) {
                    QuotaUiState.Unsynced()
                } else {
                    QuotaUiState.Available(
                        snapshot = snapshot,
                        showingCachedData = false,
                        savedAtEpochMillis = receivedAt,
                        evaluatedAtEpochMillis = receivedAt,
                        refreshing = false
                    )
                }
            }
            scheduleQuotaFreshness()
            if (!quotaIsCurrent(requestKey)) return@launch
            try {
                quotaCache.save(
                    requestKey.cacheKey(),
                    QuotaCachedSnapshot(snapshot, receivedAt),
                    requestKey.writeIdentity(snapshot.epoch, snapshot.revision)
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                // Quota cache persistence never turns a valid network snapshot into a UI error.
            }
        }
    }

    private fun handleQuotaFailure(requestKey: QuotaRequestKey, error: Throwable) {
        if (!quotaIsCurrent(requestKey)) return
        val clearUntrusted = error is QuotaContractException ||
            error is SupabaseResponseTooLargeException ||
            (error is SupabaseHttpException &&
                error.isMissingRpcSignature(QUOTA_READ_V2_FUNCTION))
        val now = timeProvider.nowEpochMillis()
        if (clearUntrusted) {
            enqueueQuotaInvalidation(
                userId = requestKey.userId,
                requestId = requestKey.requestId,
                generation = requestKey.sessionGeneration
            )
            if (quotaMatches(requestKey)) {
                _quotaState.value = QuotaUiState.Unsynced(
                    if (error is QuotaContractException || error is SupabaseResponseTooLargeException) {
                        "额度同步响应无法安全读取"
                    } else {
                        "当前云端尚未部署额度同步"
                    }
                )
            }
            return
        }

        if (quotaMatches(requestKey)) {
            val available = _quotaState.value as? QuotaUiState.Available
            val message = when {
                error is IOException -> "网络不可用，额度区域保留历史快照"
                error is SupabaseHttpException && error.status == 401 ->
                    "额度同步鉴权暂不可用，统计看板不受影响"
                error is SupabaseHttpException && (error.status == 408 || error.status == 429 || error.status >= 500) ->
                    "额度同步暂时不可用，统计看板不受影响"
                else -> "额度同步暂时不可用"
            }
            _quotaState.value = available?.copy(
                showingCachedData = true,
                evaluatedAtEpochMillis = now,
                refreshing = false,
                warning = message
            ) ?: QuotaUiState.Unavailable(message)
        }
        scheduleQuotaFreshness()
    }

    fun scheduleQuotaFreshness() {
        quotaFreshnessJob?.cancel()
        if (!quotaFreshnessSchedulingEnabled) return
        val available = _quotaState.value as? QuotaUiState.Available ?: return
        val nowMillis = timeProvider.nowEpochMillis()
        val now = Instant.ofEpochMilli(nowMillis)
        val deadline = available.snapshot.nextFreshnessDeadline(now) ?: return
        val delayMillis = (deadline.toEpochMilli() - nowMillis).coerceAtLeast(1_000L)
        val expectedEpoch = available.snapshot.epoch
        val expectedRevision = available.snapshot.revision
        quotaFreshnessJob = coroutineScope.launch {
            delay(delayMillis)
            val current = _quotaState.value as? QuotaUiState.Available
                ?: return@launch
            if (
                current.snapshot.epoch != expectedEpoch ||
                current.snapshot.revision != expectedRevision
            ) {
                return@launch
            }
            reevaluateQuotaNow()
        }
    }

    fun reevaluateQuotaNow() {
        val available = _quotaState.value as? QuotaUiState.Available ?: return
        val now = timeProvider.nowEpochMillis()
        val current = _quotaState.value as? QuotaUiState.Available
        if (
            current != null &&
            current.snapshot.epoch == available.snapshot.epoch &&
            current.snapshot.revision == available.snapshot.revision
        ) {
            _quotaState.value = current.copy(evaluatedAtEpochMillis = now)
        }
        scheduleQuotaFreshness()
    }

    fun resetLastQuotaAttempt() {
        lastQuotaAttemptEpochMillis = 0L
    }

    fun invalidateQuotaRequest() {
        activeQuotaRequestId = DashboardRequestIdentity.nextId()
        quotaRestoreJob?.cancel()
        quotaStartAfterRestoreJob?.cancel()
        quotaJob?.cancel()
        quotaFreshnessJob?.cancel()
    }

    fun enqueueQuotaInvalidation(
        userId: String,
        requestId: Long = DashboardRequestIdentity.nextId(),
        generation: Long = getSessionGeneration(),
        epoch: Long = 0L,
        revision: Long = 0L
    ) {
        val previous = quotaCacheMutationJob
        quotaCacheMutationJob = coroutineScope.launch {
            previous?.join()
            runCatching {
                quotaCache.invalidate(
                    QuotaCacheKey(userId),
                    QuotaCacheWriteIdentity(
                        writerId = DashboardRequestIdentity.writerId,
                        requestId = requestId,
                        sessionGeneration = generation,
                        epoch = epoch,
                        revision = revision
                    )
                )
            }
        }
    }

    fun currentQuotaMutationJob(): Job? = quotaCacheMutationJob

    fun reset() {
        invalidateQuotaRequest()
        lastQuotaAttemptEpochMillis = 0L
        latestSnapshot = null
        latestSnapshotSession = null
        _quotaState.value = QuotaUiState.Unsynced()
    }

    private fun newQuotaRequestKey(session: MobileSession): QuotaRequestKey {
        val requestId = DashboardRequestIdentity.nextId()
        activeQuotaRequestId = requestId
        return QuotaRequestKey(
            requestId = requestId,
            sessionGeneration = getSessionGeneration(),
            userId = session.userId
        )
    }

    private fun quotaIsCurrent(requestKey: QuotaRequestKey): Boolean =
        quotaMatches(requestKey)

    private fun quotaMatches(requestKey: QuotaRequestKey): Boolean =
        requestKey.requestId == activeQuotaRequestId &&
            requestKey.sessionGeneration == getSessionGeneration() &&
            requestKey.userId == getCurrentSession()?.userId &&
            requestKey.transportVersion == QUOTA_TRANSPORT_VERSION

    private fun QuotaRequestKey.writeIdentity(
        epoch: Long,
        revision: Long
    ): QuotaCacheWriteIdentity = QuotaCacheWriteIdentity(
        writerId = DashboardRequestIdentity.writerId,
        requestId = requestId,
        sessionGeneration = sessionGeneration,
        epoch = epoch,
        revision = revision
    )

    private fun QuotaTransportSnapshot.isOlderThan(other: QuotaTransportSnapshot): Boolean =
        epoch < other.epoch || (epoch == other.epoch && revision < other.revision)
}
