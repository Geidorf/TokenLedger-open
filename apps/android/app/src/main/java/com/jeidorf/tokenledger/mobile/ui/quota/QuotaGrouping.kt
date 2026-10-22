package com.jeidorf.tokenledger.mobile.ui.quota

import com.jeidorf.tokenledger.mobile.QuotaDisplayValue
import com.jeidorf.tokenledger.mobile.QuotaProviderEnvelope
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.QuotaSeverity
import com.jeidorf.tokenledger.mobile.QuotaWindowSnapshot
import com.jeidorf.tokenledger.mobile.QuotaWindowStatus
import com.jeidorf.tokenledger.mobile.displayValue
import com.jeidorf.tokenledger.mobile.effectiveStatus
import com.jeidorf.tokenledger.mobile.quotaSeverityForFraction
import java.time.Instant

internal fun v2QuotaRemainingFraction(value: QuotaDisplayValue.Progress): Float =
    value.remaining
        ?.div(value.limit)
        ?.toFloat()
        ?.coerceIn(0f, 1f)
        ?: (1f - value.fraction).coerceIn(0f, 1f)

internal const val TODAY_SOURCE_LIMIT = 3
internal const val TODAY_QUOTA_LIMIT = 2

internal enum class QuotaDisplayGroup(val label: String) {
    Attention("需关注"),
    Available("可用"),
    History("历史")
}

internal const val QUOTA_HISTORY_DEFAULT_EXPANDED = false

internal data class QuotaProviderGroups(
    val attention: List<QuotaProviderEnvelope>,
    val available: List<QuotaProviderEnvelope>,
    val history: List<QuotaProviderEnvelope>
)

/** 只编排现有 Quota v1 投影，不重算 Provider/窗口状态，也不补造未知值。 */
internal fun quotaDisplayGroup(
    provider: QuotaProviderEnvelope,
    now: Instant,
    showingCachedData: Boolean = false
): QuotaDisplayGroup {
    val windowStatuses = provider.windows.map { it.effectiveStatus(now, showingCachedData) }
    val allWindowsHistorical = windowStatuses.isNotEmpty() &&
        windowStatuses.all { it == QuotaWindowStatus.Stale }
    val windowlessHistory = provider.status == QuotaProviderStatus.Stale && provider.windows.isEmpty()
    if (showingCachedData || allWindowsHistorical || windowlessHistory) {
        return QuotaDisplayGroup.History
    }
    if (provider.status != QuotaProviderStatus.Ok || QuotaWindowStatus.Stale in windowStatuses) {
        return QuotaDisplayGroup.Attention
    }
    val trustworthyValues = provider.windows.mapNotNull { window ->
        window.displayValue().takeIf { window.effectiveStatus(now) == QuotaWindowStatus.Ok }
    }
    val hasLowRemaining = trustworthyValues
        .filterIsInstance<QuotaDisplayValue.Progress>()
        .any { quotaSeverityForFraction(v2QuotaRemainingFraction(it)) != QuotaSeverity.Healthy }
    return when {
        hasLowRemaining -> QuotaDisplayGroup.Attention
        trustworthyValues.isNotEmpty() -> QuotaDisplayGroup.Available
        else -> QuotaDisplayGroup.Attention
    }
}

internal fun groupQuotaProviders(
    providers: List<QuotaProviderEnvelope>,
    now: Instant,
    showingCachedData: Boolean = false
): QuotaProviderGroups {
    val grouped = providers.groupBy { quotaDisplayGroup(it, now, showingCachedData) }
    return QuotaProviderGroups(
        attention = grouped[QuotaDisplayGroup.Attention].orEmpty(),
        available = grouped[QuotaDisplayGroup.Available].orEmpty(),
        history = grouped[QuotaDisplayGroup.History].orEmpty()
    )
}

internal fun latestQuotaObservedAt(providers: List<QuotaProviderEnvelope>): String? = providers
    .asSequence()
    .flatMap { it.windows.asSequence() }
    .maxByOrNull(QuotaWindowSnapshot::observedInstant)
    ?.observedAt
