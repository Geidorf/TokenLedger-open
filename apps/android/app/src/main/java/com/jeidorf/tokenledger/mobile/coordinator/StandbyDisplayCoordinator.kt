package com.jeidorf.tokenledger.mobile.coordinator

import com.jeidorf.tokenledger.mobile.DailyQuoteDataSource
import com.jeidorf.tokenledger.mobile.DailyQuoteSnapshot
import com.jeidorf.tokenledger.mobile.DashboardTimeProvider
import com.jeidorf.tokenledger.mobile.dailyQuoteFor
import java.time.LocalDate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

internal data class StandbySubState(
    val lowPowerDisplayVisible: Boolean = false,
    val dailyQuote: DailyQuoteSnapshot? = null
)

internal class StandbyDisplayCoordinator(
    private val dailyQuoteRepository: DailyQuoteDataSource,
    private val timeProvider: DashboardTimeProvider,
    private val coroutineScope: CoroutineScope,
    private val automaticRefreshEnabled: Boolean = true,
    private val hasSession: () -> Boolean,
    private val getSessionGeneration: () -> Long,
    private val onTriggerRefresh: (forceQuota: Boolean) -> Unit,
    private val onTriggerMidnightRefresh: () -> Unit
) {
    companion object {
        const val LOW_POWER_REFRESH_INTERVAL_MS = 5L * 60L * 1_000L
        private const val MIDNIGHT_SETTLE_DELAY_MS = 2_000L
    }

    private val _standbyState = MutableStateFlow(StandbySubState())
    val standbyState: StateFlow<StandbySubState> = _standbyState.asStateFlow()

    private var lowPowerRefreshJob: Job? = null
    private var midnightJob: Job? = null
    private var dailyQuoteJob: Job? = null
    private var dailyQuoteMidnightJob: Job? = null
    private var requestedDailyQuoteDate: LocalDate? = null
    private var lastLowPowerRefreshAttemptEpochMillis = 0L

    val isLowPowerDisplayVisible: Boolean
        get() = _standbyState.value.lowPowerDisplayVisible

    fun setVisible(visible: Boolean) {
        _standbyState.update { it.copy(lowPowerDisplayVisible = visible) }
    }

    fun openLowPowerDisplay(hasVisibleData: Boolean, onPrepareUi: () -> Unit) {
        if (!hasSession() || !hasVisibleData) return
        cancelTimers()
        onPrepareUi()
        _standbyState.update { it.copy(lowPowerDisplayVisible = true) }
        refreshDailyQuoteForCurrentDate()
        scheduleDailyQuoteMidnightRefresh()
        startLowPowerDisplayRefresh(forceQuota = true)
        scheduleLowPowerRefresh()
    }

    fun closeLowPowerDisplay(onForegroundAfterClose: () -> Unit) {
        if (!_standbyState.value.lowPowerDisplayVisible) return
        lowPowerRefreshJob?.cancel()
        dailyQuoteMidnightJob?.cancel()
        _standbyState.update { it.copy(lowPowerDisplayVisible = false) }
        onForegroundAfterClose()
    }

    fun onForeground(onStaleOrChangedRefresh: () -> Unit) {
        if (_standbyState.value.lowPowerDisplayVisible) {
            refreshDailyQuoteForCurrentDate()
            scheduleDailyQuoteMidnightRefresh()
            if (lowPowerRefreshIsDue()) {
                startLowPowerDisplayRefresh(forceQuota = false)
            }
            scheduleLowPowerRefresh()
            return
        }
        scheduleMidnightRefresh()
        onStaleOrChangedRefresh()
    }

    fun onBackground(onPauseTasks: () -> Unit) {
        if (!_standbyState.value.lowPowerDisplayVisible) return
        lowPowerRefreshJob?.cancel()
        dailyQuoteMidnightJob?.cancel()
        onPauseTasks()
    }

    fun onClockChanged(onClockRefresh: () -> Unit) {
        if (!hasSession()) return
        if (_standbyState.value.lowPowerDisplayVisible) {
            refreshDailyQuoteForCurrentDate()
            scheduleDailyQuoteMidnightRefresh()
            startLowPowerDisplayRefresh(forceQuota = false)
            scheduleLowPowerRefresh()
            return
        }
        scheduleMidnightRefresh()
        onClockRefresh()
    }

    fun refreshDailyQuoteForCurrentDate() {
        val date = timeProvider.currentDate()
        if (requestedDailyQuoteDate == date) return
        requestedDailyQuoteDate = date
        _standbyState.update {
            it.copy(dailyQuote = DailyQuoteSnapshot(date, dailyQuoteFor(date)))
        }
        dailyQuoteJob?.cancel()
        dailyQuoteJob = coroutineScope.launch {
            val quote = runCatching { dailyQuoteRepository.quoteFor(date) }
                .getOrElse { dailyQuoteFor(date) }
            if (
                requestedDailyQuoteDate == date &&
                timeProvider.currentDate() == date
            ) {
                _standbyState.update {
                    it.copy(dailyQuote = DailyQuoteSnapshot(date, quote))
                }
            }
        }
    }

    fun scheduleDailyQuoteMidnightRefresh() {
        dailyQuoteMidnightJob?.cancel()
        if (!automaticRefreshEnabled || !_standbyState.value.lowPowerDisplayVisible) return
        dailyQuoteMidnightJob = coroutineScope.launch {
            while (isActive && _standbyState.value.lowPowerDisplayVisible) {
                delay(timeProvider.millisUntilNextMidnight() + MIDNIGHT_SETTLE_DELAY_MS)
                if (!_standbyState.value.lowPowerDisplayVisible) return@launch
                refreshDailyQuoteForCurrentDate()
            }
        }
    }

    fun scheduleMidnightRefresh() {
        midnightJob?.cancel()
        if (!automaticRefreshEnabled || !hasSession()) return
        val scheduledGeneration = getSessionGeneration()
        midnightJob = coroutineScope.launch {
            while (isActive && scheduledGeneration == getSessionGeneration()) {
                delay(timeProvider.millisUntilNextMidnight() + MIDNIGHT_SETTLE_DELAY_MS)
                if (scheduledGeneration != getSessionGeneration() || !hasSession()) {
                    return@launch
                }
                onTriggerMidnightRefresh()
            }
        }
    }

    fun scheduleLowPowerRefresh() {
        lowPowerRefreshJob?.cancel()
        if (
            !automaticRefreshEnabled ||
            !_standbyState.value.lowPowerDisplayVisible ||
            !hasSession()
        ) {
            return
        }
        val scheduledGeneration = getSessionGeneration()
        lowPowerRefreshJob = coroutineScope.launch {
            while (
                isActive &&
                scheduledGeneration == getSessionGeneration() &&
                _standbyState.value.lowPowerDisplayVisible
            ) {
                delay(millisUntilLowPowerRefresh())
                if (
                    scheduledGeneration != getSessionGeneration() ||
                    !_standbyState.value.lowPowerDisplayVisible ||
                    !hasSession()
                ) {
                    return@launch
                }
                startLowPowerDisplayRefresh(forceQuota = false)
            }
        }
    }

    fun startLowPowerDisplayRefresh(forceQuota: Boolean) {
        if (!_standbyState.value.lowPowerDisplayVisible || !hasSession()) return
        lastLowPowerRefreshAttemptEpochMillis = timeProvider.nowEpochMillis()
        onTriggerRefresh(forceQuota)
    }

    fun lowPowerRefreshIsDue(): Boolean {
        val lastAttempt = lastLowPowerRefreshAttemptEpochMillis
        if (lastAttempt == 0L) return true
        val now = timeProvider.nowEpochMillis()
        return now < lastAttempt || now - lastAttempt >= LOW_POWER_REFRESH_INTERVAL_MS
    }

    private fun millisUntilLowPowerRefresh(): Long {
        val lastAttempt = lastLowPowerRefreshAttemptEpochMillis
        if (lastAttempt == 0L) return 1_000L
        val now = timeProvider.nowEpochMillis()
        if (now < lastAttempt) return 1_000L
        return (LOW_POWER_REFRESH_INTERVAL_MS - (now - lastAttempt))
            .coerceIn(1_000L, LOW_POWER_REFRESH_INTERVAL_MS)
    }

    fun cancelTimers() {
        midnightJob?.cancel()
        lowPowerRefreshJob?.cancel()
        dailyQuoteJob?.cancel()
        dailyQuoteMidnightJob?.cancel()
    }

    fun reset() {
        cancelTimers()
        requestedDailyQuoteDate = null
        lastLowPowerRefreshAttemptEpochMillis = 0L
        _standbyState.value = StandbySubState()
    }
}
