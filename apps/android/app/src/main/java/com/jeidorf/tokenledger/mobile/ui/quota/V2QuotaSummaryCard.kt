package com.jeidorf.tokenledger.mobile.ui.quota

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.LocalLedgerNow
import com.jeidorf.tokenledger.mobile.QuotaDisplayValue
import com.jeidorf.tokenledger.mobile.QuotaProviderEnvelope
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.QuotaSeverity
import com.jeidorf.tokenledger.mobile.QuotaUiState
import com.jeidorf.tokenledger.mobile.QuotaWindowSnapshot
import com.jeidorf.tokenledger.mobile.displayValue
import com.jeidorf.tokenledger.mobile.effectiveStatus
import com.jeidorf.tokenledger.mobile.localizedCompactWindowLabel
import com.jeidorf.tokenledger.mobile.localizedDisplayName
import com.jeidorf.tokenledger.mobile.localizedLabel
import com.jeidorf.tokenledger.mobile.localizedWindowLabel
import com.jeidorf.tokenledger.mobile.quotaAvailableAccessibilityLabel
import com.jeidorf.tokenledger.mobile.quotaAvailablePercent
import com.jeidorf.tokenledger.mobile.quotaHistoryMetadataLabel
import com.jeidorf.tokenledger.mobile.quotaProgressWindowsForDisplay
import com.jeidorf.tokenledger.mobile.quotaSeverityForAvailablePercent
import com.jeidorf.tokenledger.mobile.quotaWindowAccessibilityDescription
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSize
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.v2ResetLabel
import com.jeidorf.tokenledger.mobile.ui.foundation.v2ShortDateTime

@Composable
internal fun V2QuotaSummaryCard(
    palette: MobileV2Palette,
    quota: QuotaUiState,
    onClick: () -> Unit,
    limit: Int = 3
) {
    V2Card(
        palette = palette,
        modifier = Modifier
            .clickable(
                role = Role.Button,
                onClickLabel = "打开额度详情",
                onClick = onClick
            )
            .semantics(mergeDescendants = true) { }
    ) {
        when (quota) {
            QuotaUiState.Loading -> Text("额度快照读取中…", color = palette.muted)
            is QuotaUiState.Unsynced -> Text("尚未从桌面同步额度快照", color = palette.muted, fontSize = LedgerFont.label)
            is QuotaUiState.Unavailable -> Text(quota.message, color = palette.muted, fontSize = LedgerFont.label)
            is QuotaUiState.Available -> {
                val windows = quotaProgressWindowsForDisplay(quota.snapshot.providers, limit = limit)
                if (windows.isEmpty()) {
                    Text("当前快照没有可绘制的百分比窗口", color = palette.muted, fontSize = LedgerFont.label)
                } else {
                    windows.forEachIndexed { index, (provider, window) ->
                        if (index > 0) HorizontalDivider(color = palette.divider)
                        V2QuotaSummaryRow(
                            palette = palette,
                            provider = provider,
                            window = window,
                            forceStale = quota.showingCachedData
                        )
                    }
                }
            }
        }
        // 整张卡已可点（见上方 clickable，onClickLabel = "打开额度详情"）直达额度页；
        // 这里在今日页内联展示，不是分区标题，没有「查看全部」，卡底再放一条只是
        // 通向同一处的重复入口，还多占一行。
    }
}

@Composable
internal fun V2QuotaSummaryRow(
    palette: MobileV2Palette,
    provider: QuotaProviderEnvelope,
    window: QuotaWindowSnapshot,
    forceStale: Boolean
) {
    val now = LocalLedgerNow.current()
    val providerStatus = provider.effectiveStatus(now, forceStale)
    val windowStatus = window.effectiveStatus(now, forceStale)
    val mayShowValue = providerStatus == QuotaProviderStatus.Ok ||
        providerStatus == QuotaProviderStatus.Stale
    val progress = window.displayValue()
        .takeIf { mayShowValue } as? QuotaDisplayValue.Progress
    val remainingFraction = progress?.let(::v2QuotaRemainingFraction)
    // A-Q2：数字是「100 − round(已用)」的整数，档位按这个数分（与额度页、摆件、小组件、桌面同数同档）。
    // 此前这里截断取整（剩余 19.6% 写「19% 可用」、0.4% 写「0% 可用」），档位又按未取整的比例。
    val availablePercent = progress?.let(::quotaAvailablePercent)
    val valueText = availablePercent?.let { "$it% 可用" }
        ?: providerStatus.localizedLabel()
    val severity = availablePercent?.let(::quotaSeverityForAvailablePercent)
    val providerName = provider.localizedDisplayName()
    val statusText = if (providerStatus == QuotaProviderStatus.Ok) {
        windowStatus.localizedLabel()
    } else {
        providerStatus.localizedLabel()
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp)
            .semantics {
                contentDescription = quotaWindowAccessibilityDescription(
                    providerName = providerName,
                    windowLabel = window.localizedWindowLabel(providerName),
                    statusLabel = statusText,
                    valueLabel = availablePercent?.let(::quotaAvailableAccessibilityLabel),
                    resetLabel = v2ResetLabel(window.resetsAt),
                    observedLabel = v2ShortDateTime(window.observedAt)
                )
            },
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    providerName,
                    color = palette.text,
                    style = LedgerType.titleS,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                // 副标题固定写窗口，状态交给下面那行元数据。此前非 Ok 时这里写的是
                // statusText，而元数据行是「$statusText · 更新于 …」——同一个词在
                // 三行之内出现两次（四种非 Ok 状态都如此），窗口标签反而被挤掉了，
                // 于是数据一旦转历史，就再也看不出这个百分比说的是 5 小时还是每周。
                Text(
                    window.localizedCompactWindowLabel(providerName),
                    color = palette.faint,
                    style = LedgerType.meta,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
            if (availablePercent != null) {
                // 数字不染色（§4.9）。档位写在下面那一行，颜色不再是唯一线索。
                Row(verticalAlignment = Alignment.Bottom) {
                    Text("$availablePercent%", color = palette.text, style = LedgerType.numS)
                    Spacer(Modifier.width(LedgerSpace.xs))
                    Text("可用", color = palette.muted, style = LedgerType.caption)
                }
            } else {
                Text(
                    valueText,
                    color = v2QuotaStatusColor(palette, providerStatus),
                    style = LedgerType.numS
                )
            }
        }
        if (remainingFraction != null) {
            val historical = providerStatus == QuotaProviderStatus.Stale
            V2QuotaProgressBar(
                palette = palette,
                fraction = remainingFraction,
                degraded = !historical && providerStatus != QuotaProviderStatus.Ok,
                historical = historical,
                height = LedgerSize.quotaBarOverview
            )
        }
        if (providerStatus == QuotaProviderStatus.Ok && severity != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    severity.label,
                    color = when (severity) {
                        QuotaSeverity.Warning -> palette.amber
                        QuotaSeverity.Critical -> palette.danger
                        QuotaSeverity.Healthy -> palette.muted
                    },
                    style = LedgerType.meta
                )
                Text(
                    " · ${v2ResetLabel(window.resetsAt)}",
                    color = palette.faint,
                    style = LedgerType.meta
                )
            }
        }
        quotaHistoryMetadataLabel(
            status = providerStatus,
            observedLabel = v2ShortDateTime(window.observedAt)
        )?.let { metadata ->
            Text(
                metadata,
                color = v2QuotaStatusColor(palette, providerStatus),
                style = LedgerType.meta
            )
        }
    }
}
