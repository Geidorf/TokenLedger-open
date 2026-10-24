package com.jeidorf.tokenledger.mobile.ui.quota

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material3.Icon
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerMotion
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.QuotaProviderEnvelope
import com.jeidorf.tokenledger.mobile.QuotaUiState
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ledgerTween
import com.jeidorf.tokenledger.mobile.orderedQuotaProvidersForFullDisplay
import com.jeidorf.tokenledger.mobile.quotaRecoveryActionLabel
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_TOUCH_TARGET
import com.jeidorf.tokenledger.mobile.ui.foundation.v2ShortDateTime
import com.jeidorf.tokenledger.mobile.ui.onboarding.V2EmptyAction
import com.jeidorf.tokenledger.mobile.ui.onboarding.V2EmptyState
import java.time.Instant

internal fun LazyListScope.v2QuotaItems(
    palette: MobileV2Palette,
    quota: QuotaUiState,
    onRefresh: () -> Unit,
    dashboardLoading: Boolean
) {
    item(key = "quota-heading", contentType = "heading") {
        Text("订阅窗口", color = palette.text, style = LedgerType.titleM)
    }
    when (quota) {
        QuotaUiState.Loading -> item(key = "quota-loading", contentType = "status") {
            V2QuotaStateCard(palette, "正在读取额度快照", "主看板不会等待额度来源。")
        }
        is QuotaUiState.Unsynced -> item(key = "quota-unsynced", contentType = "status") {
            V2QuotaStateCard(
                palette = palette,
                title = "尚未同步",
                body = quota.message,
                actionLabel = quotaRecoveryActionLabel(quota, refreshing = dashboardLoading),
                actionEnabled = !dashboardLoading,
                onAction = onRefresh
            )
        }
        is QuotaUiState.Unavailable -> item(key = "quota-unavailable", contentType = "status") {
            V2QuotaStateCard(
                palette = palette,
                title = "额度暂不可用",
                body = quota.message,
                actionLabel = quotaRecoveryActionLabel(quota, refreshing = dashboardLoading),
                actionEnabled = !dashboardLoading,
                onAction = onRefresh
            )
        }
        is QuotaUiState.Available -> {
            // 离线总状态已在顶栏说明；历史分组和窗口行各自保留语义与观测时间，
            // 不再在这里重复同一份缓存时间或把缓存误称为已更新。
            if (!quota.showingCachedData) item(key = "quota-transport", contentType = "status") {
                V2QuotaTransportLine(
                    palette = palette,
                    label = "额度已同步",
                    timestamp = v2ShortDateTime(quota.snapshot.generatedAt),
                    refreshing = quota.refreshing || dashboardLoading,
                    onRefresh = onRefresh
                )
            }
            val providers = quota.snapshot.providers.orderedQuotaProvidersForFullDisplay()
            if (providers.isEmpty()) {
                item(key = "quota-empty", contentType = "status") {
                    V2EmptyState(
                        palette = palette,
                        icon = Icons.Default.Speed,
                        title = "还没有额度来源",
                        body = "额度由桌面端读取后经云端同步过来。在电脑「设置 › 订阅额度」里选择要读取的来源，" +
                            "桌面读到后这里会显示各窗口的剩余额度。手机不读取订阅凭据。",
                        secondary = V2EmptyAction(
                            if (dashboardLoading) "刷新中…" else "刷新",
                            enabled = !dashboardLoading,
                            onClick = onRefresh
                        )
                    )
                }
            } else {
                val now = Instant.ofEpochMilli(quota.evaluatedAtEpochMillis)
                val groups = groupQuotaProviders(providers, now, quota.showingCachedData)
                if (groups.attention.isNotEmpty()) {
                    item(key = "quota-attention-heading", contentType = "heading") {
                        V2QuotaGroupHeading(palette, QuotaDisplayGroup.Attention, groups.attention.size)
                    }
                    groups.attention.forEach { provider ->
                        item(key = "quota-attention-${provider.stableKey}", contentType = "quota-provider") {
                            V2ProviderCard(palette, provider, quota, initiallyExpanded = true)
                        }
                    }
                }
                if (groups.available.isNotEmpty()) {
                    item(key = "quota-available-heading", contentType = "heading") {
                        V2QuotaGroupHeading(palette, QuotaDisplayGroup.Available, groups.available.size)
                    }
                    groups.available.forEach { provider ->
                        item(key = "quota-available-${provider.stableKey}", contentType = "quota-provider") {
                            V2ProviderCard(palette, provider, quota, initiallyExpanded = false)
                        }
                    }
                }
                if (groups.history.isNotEmpty()) {
                    item(key = "quota-history", contentType = "quota-history") {
                        V2QuotaHistoryGroup(palette, groups.history, quota)
                    }
                }
            }
            quota.warning?.let { warning -> item(key = "quota-warning", contentType = "status") { V2QuotaStateCard(palette, "快照提醒", warning) } }
            val paceNow = Instant.ofEpochMilli(quota.evaluatedAtEpochMillis)
            val anyPaceLine = providers.any { provider ->
                quotaCapabilityTrustsTimeline(provider.capability) &&
                    provider.windows.any { quotaPaceRemainingFraction(it.windowMinutes, it.resetsAt, paceNow) != null }
            }
            if (anyPaceLine) item(key = "quota-pace-note", contentType = "note") {
                Text(
                    QUOTA_PACE_NOTE,
                    color = palette.muted,
                    style = LedgerType.meta,
                    modifier = Modifier.padding(horizontal = 2.dp)
                )
            }
        }
    }
}

@Composable
internal fun V2QuotaGroupHeading(
    palette: MobileV2Palette,
    group: QuotaDisplayGroup,
    count: Int
) {
    Text(
        "${group.label} · $count",
        color = palette.text,
        style = LedgerType.titleS,
        modifier = Modifier.semantics { heading() }
    )
}

@Composable
internal fun V2QuotaHistoryGroup(
    palette: MobileV2Palette,
    providers: List<QuotaProviderEnvelope>,
    available: QuotaUiState.Available
) {
    var expanded by rememberSaveable { mutableStateOf(QUOTA_HISTORY_DEFAULT_EXPANDED) }
    val motion = ledgerMotionEnabled(palette.isEInk)
    val latestObservedAt = latestQuotaObservedAt(providers)?.let(::v2ShortDateTime) ?: "观测时间未知"
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = V2_TOUCH_TARGET)
                .clickable(role = Role.Button) { expanded = !expanded }
                .semantics {
                    heading()
                    stateDescription = if (expanded) "历史数据已展开" else "历史数据已收起"
                    contentDescription = "历史数据，${providers.size} 个来源，最近观测 $latestObservedAt"
                },
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text("历史数据 · ${providers.size}", color = palette.text, style = LedgerType.titleS)
                Text("最近观测 $latestObservedAt", color = palette.muted, style = LedgerType.meta)
            }
            Icon(
                imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                contentDescription = null,
                tint = palette.blue
            )
        }
        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(ledgerTween(LedgerMotion.EMPHASIZED_MILLIS, motion)) +
                fadeIn(ledgerTween(LedgerMotion.STANDARD_MILLIS, motion)),
            exit = shrinkVertically(ledgerTween(LedgerMotion.EMPHASIZED_MILLIS, motion)) +
                fadeOut(ledgerTween(LedgerMotion.FAST_MILLIS, motion))
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                providers.forEach { provider ->
                    V2ProviderCard(palette, provider, available, initiallyExpanded = false)
                }
            }
        }
    }
}

/** 匀速线的读法，放在额度列表末尾一次说清，不在每条窗口里重复。 */
internal const val QUOTA_PACE_NOTE = "竖线是按时间匀速用完时此刻应剩的位置，条比它短就是用快了。"
