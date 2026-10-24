package com.jeidorf.tokenledger.mobile.widget

import android.content.Context
import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.DashboardCache
import com.jeidorf.tokenledger.mobile.DashboardCacheKey
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.MobileSession
import com.jeidorf.tokenledger.mobile.QuotaCache
import com.jeidorf.tokenledger.mobile.QuotaCacheKey
import com.jeidorf.tokenledger.mobile.QuotaDisplayValue
import com.jeidorf.tokenledger.mobile.QuotaProviderEnvelope
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.QuotaWindowSnapshot
import com.jeidorf.tokenledger.mobile.QuotaWindowStatus
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.SessionStore
import com.jeidorf.tokenledger.mobile.displayValue
import com.jeidorf.tokenledger.mobile.effectiveStatus
import com.jeidorf.tokenledger.mobile.hiddenDrawableWindowCount
import com.jeidorf.tokenledger.mobile.localizedCompactWindowLabel
import com.jeidorf.tokenledger.mobile.localizedDisplayName
import com.jeidorf.tokenledger.mobile.orderedQuotaProvidersForDisplay
import com.jeidorf.tokenledger.mobile.primaryWindowIsRoleSubstitute
import com.jeidorf.tokenledger.mobile.selectPrimaryDisplayWindow
import com.jeidorf.tokenledger.mobile.selectSecondaryDisplayWindow
import com.jeidorf.tokenledger.mobile.BuildConfig
import java.time.Instant
import java.util.TimeZone
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 数据桥（T8.3）：复用既有仓库层的加密 last-known-good 缓存（[QuotaCache]/[DashboardCache]）
 * 与会话（[SessionStore]），映射为 [WidgetState]。小组件进程只读缓存，不新建网络层；
 * 后台再取由 [WidgetRefreshWorker] 负责。
 *
 * 诚实额度原则（REQ-WIDGET-02）：
 *  - 无会话 → [WidgetState.NeedLogin]；
 *  - 额度与用量缓存皆缺失 → [WidgetState.NoData]；
 *  - 有缓存但缺项 → 该区块置空，另一区块照常展示；
 *  - 额度窗口过期 → 通过 [QuotaWindowSnapshot.effectiveStatus] 如实降级为 stale，绝不补 0。
 */
internal class WidgetStateRepository(context: Context) {
    private val appContext = context.applicationContext

    suspend fun load(range: RangeKey, includeRouting: Boolean = false): WidgetState {
        val session = withContext(Dispatchers.IO) {
            runCatching { SessionStore(appContext).load() }.getOrNull()
        } ?: return WidgetState.NeedLogin

        val nowMillis = System.currentTimeMillis()
        val now = Instant.ofEpochMilli(nowMillis)
        val quota = loadQuota(session, now, nowMillis)
        val usage = loadUsage(session, range, nowMillis)
        val routing = if (includeRouting) {
            withContext(Dispatchers.IO) { WidgetRoutingStore.load(appContext, session.userId) }
        } else null
        // 裁决逻辑下沉到纯函数 resolveWidgetState（WidgetCycling.kt），此处 session 非空即视作已登录。
        return resolveWidgetState(hasSession = true, quota = quota, usage = usage, routing = routing)
    }

    private suspend fun loadQuota(
        session: MobileSession,
        now: Instant,
        nowMillis: Long
    ): WidgetQuota? {
        val decoded = runCatching {
            QuotaCache(appContext).load(QuotaCacheKey(session.userId), nowMillis)
        }.getOrNull() ?: return null
        val snapshot = decoded.snapshot.snapshot
        if (snapshot.providers.isEmpty()) return null

        // 映射为纯 CPU 计算（无挂起点）；即使某字段异常也降级为不显示额度，绝不让小组件整体崩溃。
        return runCatching {
            val providers = snapshot.providers
                .orderedQuotaProvidersForDisplay()
                .map { mapProvider(it, now, nowMillis) }
            WidgetQuota(providers = providers, rows = widgetQuotaBarRows(snapshot.providers, now, nowMillis))
        }.getOrNull()
    }

    private fun mapProvider(
        envelope: QuotaProviderEnvelope,
        now: Instant,
        nowMillis: Long
    ): WidgetQuotaProvider {
        val primarySource = envelope.selectPrimaryDisplayWindow()
        val providerName = envelope.localizedDisplayName()
        val primaryStatus = primarySource?.effectiveStatus(now)
        val effectiveStatus = envelope.effectiveStatus(now)
        val primary = primarySource?.let {
            mapWindow(
                window = it,
                status = primaryStatus ?: QuotaWindowStatus.Error,
                providerName = providerName,
                providerStatus = effectiveStatus
            )
        }
        val secondarySource = envelope.selectSecondaryDisplayWindow(primarySource)
        val secondary = secondarySource?.let {
            mapWindow(
                window = it,
                status = it.effectiveStatus(now),
                providerName = providerName,
                providerStatus = effectiveStatus
            )
        }

        val nextReset = primarySource?.resetInstant?.takeIf { it.isAfter(now) }
        val resetText = nextReset?.let {
            formatResetCountdown(it.toEpochMilli() - now.toEpochMilli())
        }

        val windowStale = effectiveStatus == QuotaProviderStatus.Stale
        return WidgetQuotaProvider(
            id = envelope.providerId,
            name = providerName,
            status = effectiveStatus,
            primary = primary,
            secondary = secondary,
            resetText = resetText,
            freshnessText = primaryWindowFreshnessText(primarySource, nowMillis),
            stale = windowStale,
            hiddenWindowCount = envelope.hiddenDrawableWindowCount(
                shown = listOfNotNull(primary, secondary).size
            ),
            primaryIsRoleSubstitute = envelope.primaryWindowIsRoleSubstitute(primarySource)
        )
    }

    private fun mapWindow(
        window: QuotaWindowSnapshot,
        status: QuotaWindowStatus,
        providerName: String,
        providerStatus: QuotaProviderStatus
    ): WidgetQuotaWindow {
        val label = window.localizedCompactWindowLabel(providerName)
        if (
            status == QuotaWindowStatus.Error ||
            status == QuotaWindowStatus.AuthRequired ||
            providerStatus == QuotaProviderStatus.Error ||
            providerStatus == QuotaProviderStatus.AuthRequired ||
            providerStatus == QuotaProviderStatus.Unsupported
        ) {
            return WidgetQuotaWindow(
                label = label,
                availableFraction = null,
                availableText = when {
                    providerStatus == QuotaProviderStatus.AuthRequired ||
                        status == QuotaWindowStatus.AuthRequired -> "需授权"
                    providerStatus == QuotaProviderStatus.Unsupported -> "不支持"
                    else -> "不可用"
                },
                status = status
            )
        }
        return when (val value = window.displayValue()) {
            is QuotaDisplayValue.Progress -> widgetProgressQuotaWindow(label, value, status)
            is QuotaDisplayValue.Absolute -> WidgetQuotaWindow(
                label = label,
                availableFraction = null,
                availableText = absoluteText(value),
                status = status
            )
            QuotaDisplayValue.UnlimitedCredits -> WidgetQuotaWindow(
                label = label,
                availableFraction = null,
                availableText = "不限额",
                status = status
            )
            null -> WidgetQuotaWindow(
                label = label,
                availableFraction = null,
                availableText = "不可用",
                status = status
            )
        }
    }

    private fun absoluteText(value: QuotaDisplayValue.Absolute): String = widgetRemainingQuotaText(value.remaining)

    private suspend fun loadUsage(
        session: MobileSession,
        range: RangeKey,
        nowMillis: Long
    ): WidgetUsage? {
        val timezoneId = TimeZone.getDefault().id.ifBlank { "UTC" }
        val key = runCatching {
            DashboardCacheKey.from(
                userId = session.userId,
                query = DashboardQuery(range = range),
                timezoneId = timezoneId,
                entity = null
            )
        }.getOrNull() ?: return null

        val cached = runCatching { DashboardCache(appContext).load(key) }
            .getOrElse { error ->
                if (error is CancellationException) throw error
                null
            } ?: return null

        val summary = cached.stats.summary
        val delta = cached.stats.comparison?.delta?.tokens?.let {
            WidgetDelta(direction = it.direction, percent = it.percent)
        }
        return WidgetUsage(
            range = WidgetRange.entries.firstOrNull { it.rangeKey == range } ?: WidgetRange.Today,
            effectiveTokens = summary.effectiveTokens,
            // 与主看板同一换算：费用或汇率非有限时是 null（不可得），不再乘出 NaN 或 ¥0.00（T10.154 A19）。
            costCny = CurrencyUnit.CNY.convertFromUsd(summary.totalCost, BuildConfig.TOKENLEDGER_CNY_EXCHANGE_RATE),
            requests = summary.totalRequests,
            freshnessText = formatRelativeTime(nowMillis - cached.savedAtEpochMillis),
            tokenDelta = delta
        )
    }
}
