package com.jeidorf.tokenledger.mobile.ui.quota

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerMotion
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.LocalLedgerNow
import com.jeidorf.tokenledger.mobile.QuotaCardWindowPresentation
import com.jeidorf.tokenledger.mobile.QuotaDisplayValue
import com.jeidorf.tokenledger.mobile.QuotaProviderEnvelope
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.QuotaScope
import com.jeidorf.tokenledger.mobile.QuotaSource
import com.jeidorf.tokenledger.mobile.QuotaUiState
import com.jeidorf.tokenledger.mobile.QuotaWindowStatus
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ledgerTween
import com.jeidorf.tokenledger.mobile.localizedDisplayName
import com.jeidorf.tokenledger.mobile.localizedWindowLabel
import com.jeidorf.tokenledger.mobile.quotaCacheTimestamp
import com.jeidorf.tokenledger.mobile.quotaCardPresentation
import com.jeidorf.tokenledger.mobile.quotaFullTimestamp
import com.jeidorf.tokenledger.mobile.quotaRecoveryGuidance
import com.jeidorf.tokenledger.mobile.quotaSeverityForFraction
import com.jeidorf.tokenledger.mobile.quotaValueLabel
import com.jeidorf.tokenledger.mobile.quotaWindowAccessibilityDescription
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2BadgeTone
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2StableChoiceText
import com.jeidorf.tokenledger.mobile.ui.foundation.V2StatusBadge
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_CONTROL_HEIGHT
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Capability
import com.jeidorf.tokenledger.mobile.ui.foundation.v2QuotaReason
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Scope
import com.jeidorf.tokenledger.mobile.ui.foundation.v2ShortDateTime
import com.jeidorf.tokenledger.mobile.localizedLabel
import java.time.Instant
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius

@Composable
internal fun V2ProviderCard(
    palette: MobileV2Palette,
    provider: QuotaProviderEnvelope,
    available: QuotaUiState.Available,
    initiallyExpanded: Boolean = false
) {
    var expanded by rememberSaveable(provider.stableKey) { mutableStateOf(initiallyExpanded) }
    val motion = ledgerMotionEnabled(palette.isEInk)
    val now = Instant.ofEpochMilli(available.evaluatedAtEpochMillis)
    val presentation = quotaCardPresentation(provider, now, available.showingCachedData)
    val providerName = provider.localizedDisplayName()
    val largeText = LocalDensity.current.fontScale >= 1.5f
    // 历史组标题已说明全局状态；历史窗口在行内各自说明状态和观测时间。
    // 只有混合、授权或错误等不能由窗口行概括的来源状态才显示卡片徽标。
    val showProviderHeadline = presentation.headline !in setOf("历史数据", "本机历史快照")
    V2Card(palette) {
        val badgeTone = when (presentation.status) {
            QuotaProviderStatus.Ok -> V2BadgeTone.Positive
            QuotaProviderStatus.AuthRequired -> V2BadgeTone.Warning
            QuotaProviderStatus.Error -> V2BadgeTone.Danger
            QuotaProviderStatus.Stale -> V2BadgeTone.Warning
            QuotaProviderStatus.Unsupported -> V2BadgeTone.Neutral
        }
        if (largeText) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    providerName, color = palette.text, style = LedgerType.titleM,
                    modifier = Modifier.semantics { heading() },
                    maxLines = Int.MAX_VALUE
                )
                if (showProviderHeadline) V2StatusBadge(
                    palette = palette,
                    label = presentation.headline,
                    tone = badgeTone
                )
                TextButton(
                    onClick = { expanded = !expanded },
                    modifier = Modifier.align(Alignment.End).heightIn(min = V2_CONTROL_HEIGHT)
                        .semantics { stateDescription = if (expanded) "详情已展开" else "详情已收起"; contentDescription = "$providerName 详情" }
                ) {
                    V2StableChoiceText(
                        listOf("详情", "收起"), if (expanded) "收起" else "详情",
                        TextStyle(fontSize = LedgerFont.label, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center), palette.blue
                    )
                }
            }
        } else {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        providerName, color = palette.text, style = LedgerType.titleM,
                        modifier = Modifier.semantics { heading() },
                        maxLines = 2, overflow = TextOverflow.Ellipsis
                    )
                    if (showProviderHeadline) V2StatusBadge(
                        palette = palette,
                        label = presentation.headline,
                        tone = badgeTone
                    )
                }
                Spacer(Modifier.width(8.dp))
                TextButton(
                    onClick = { expanded = !expanded },
                    modifier = Modifier.width(maxOf(64f, 48f * LocalDensity.current.fontScale).dp).heightIn(min = V2_CONTROL_HEIGHT)
                        .semantics { stateDescription = if (expanded) "详情已展开" else "详情已收起"; contentDescription = "$providerName 详情" }
                ) {
                    V2StableChoiceText(
                        listOf("详情", "收起"), if (expanded) "收起" else "详情",
                        TextStyle(fontSize = LedgerFont.label, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center), palette.blue
                    )
                }
            }
        }
        presentation.windows.forEachIndexed { index, window ->
            if (index > 0) HorizontalDivider(color = palette.divider)
            V2ProviderWindowRow(palette, provider, window)
        }
        if (provider.windows.isEmpty() || (provider.status != QuotaProviderStatus.Ok &&
            provider.reasonCode !in setOf(null, "observation_stale", "reset_elapsed"))) {
            val reason = if (provider.reasonCode == "upstream_unavailable" && provider.scope != QuotaScope.ApiOrganization) "额度来源暂不可用" else v2QuotaReason(provider.reasonCode, provider.scope)
            Text(reason, color = palette.muted, fontSize = LedgerFont.label)
            Text(quotaRecoveryGuidance(provider), color = palette.muted, fontSize = LedgerFont.label)
        }
        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(ledgerTween(LedgerMotion.EMPHASIZED_MILLIS, motion)) +
                fadeIn(ledgerTween(LedgerMotion.STANDARD_MILLIS, motion)),
            exit = shrinkVertically(ledgerTween(LedgerMotion.EMPHASIZED_MILLIS, motion)) +
                fadeOut(ledgerTween(LedgerMotion.FAST_MILLIS, motion))
        ) {
            Column {
                HorizontalDivider(color = palette.divider)
                V2QuotaProviderDetails(palette, provider, available)
            }
        }
    }
}

@Composable
internal fun V2QuotaProviderDetails(palette: MobileV2Palette, provider: QuotaProviderEnvelope, available: QuotaUiState.Available) {
    var diagnosticsExpanded by rememberSaveable(provider.providerId) { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 8.dp)
            .clip(RoundedCornerShape(LedgerRadius.md))
            .background(if (palette.isEInk) Color.Transparent else palette.surfaceContainerHigh)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        if (provider.status != QuotaProviderStatus.Ok &&
            provider.reasonCode !in setOf(null, "observation_stale", "reset_elapsed") && provider.windows.isNotEmpty()) {
            val reason = if (provider.reasonCode == "upstream_unavailable" && provider.scope != QuotaScope.ApiOrganization) "额度来源暂不可用" else v2QuotaReason(provider.reasonCode, provider.scope)
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (palette.isEInk) Color.Transparent else palette.surfaceContainer)
                    .then(if (palette.isEInk) Modifier.border(1.dp, palette.divider, RoundedCornerShape(8.dp)) else Modifier)
                    .padding(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text(reason, color = palette.amber, fontSize = LedgerFont.label, fontWeight = FontWeight.Medium)
                Text(quotaRecoveryGuidance(provider), color = palette.muted, fontSize = LedgerFont.caption)
            }
        }
        provider.reasonCode?.let { reasonCode ->
            Text("原因：${v2QuotaReason(reasonCode, provider.scope)}", color = palette.amber, fontSize = LedgerFont.caption)
        }
        TextButton(
            onClick = { diagnosticsExpanded = !diagnosticsExpanded },
            modifier = Modifier.heightIn(min = 36.dp)
        ) {
            Text(
                if (diagnosticsExpanded) "收起诊断信息" else "查看诊断信息",
                color = palette.blue,
                fontSize = LedgerFont.label,
                fontWeight = FontWeight.Medium
            )
        }
        if (diagnosticsExpanded) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (palette.isEInk) Color.Transparent else palette.surfaceContainer)
                    .padding(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text("${v2Scope(provider.scope)} · ${v2Capability(provider.capability)}", color = palette.muted, fontSize = LedgerFont.caption)
                Text("云端投影 ${quotaFullTimestamp(available.snapshot.generatedAt)}", color = palette.muted, fontSize = LedgerFont.caption)
                Text("本机缓存 ${quotaCacheTimestamp(available.savedAtEpochMillis)}", color = palette.muted, fontSize = LedgerFont.caption)
                provider.windows.forEach { window ->
                    Text(window.localizedWindowLabel(provider.localizedDisplayName()), color = palette.text, fontSize = LedgerFont.caption, fontWeight = FontWeight.Medium)
                    Text(
                        "来源：${when (window.source) {
                            QuotaSource.OfficialApi -> "官方 API"
                            QuotaSource.LocalAuthorized -> "本地授权来源"
                            QuotaSource.Manual -> "手工配置"
                        }}",
                        color = palette.muted,
                        fontSize = LedgerFont.caption
                    )
                    Text("观测 ${quotaFullTimestamp(window.observedAt)}", color = palette.muted, fontSize = LedgerFont.caption)
                    Text("抓取／读取 ${quotaFullTimestamp(window.fetchedAt)}", color = palette.muted, fontSize = LedgerFont.caption)
                    Text("重置 ${quotaFullTimestamp(window.resetsAt)}", color = palette.muted, fontSize = LedgerFont.caption)
                }
                if (provider.windows.isEmpty()) Text("来源观测与抓取时间未知", color = palette.muted, fontSize = LedgerFont.caption)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun V2ProviderWindowRow(
    palette: MobileV2Palette,
    provider: QuotaProviderEnvelope,
    presentation: QuotaCardWindowPresentation
) {
    val window = presentation.window
    val value = presentation.value
    val name = window.localizedWindowLabel(provider.localizedDisplayName())
    val resetText = "${if (value == null) "上次记录重置" else "重置"} ${quotaFullTimestamp(window.resetsAt)}"
    val compactResetText =
        "${if (value == null) "上次记录重置" else "重置"} ${v2RelativeReset(window.resetsAt, LocalLedgerNow.current())}"
    val severity = (value as? QuotaDisplayValue.Progress)
        ?.let { quotaSeverityForFraction(v2QuotaRemainingFraction(it)) }
    val statusColor = when {
        presentation.status == QuotaWindowStatus.Stale ||
            presentation.status == QuotaWindowStatus.AuthRequired -> palette.amber
        presentation.status == QuotaWindowStatus.Error -> palette.danger
        severity != null -> v2SeverityColor(palette, severity)
        else -> palette.text
    }

    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp)
            .clearAndSetSemantics {
                contentDescription = quotaWindowAccessibilityDescription(
                    provider.localizedDisplayName(), name, presentation.status.localizedLabel(),
                    quotaValueLabel(value)?.let { label -> severity?.let { "$label（${it.label}）" } ?: label },
                    resetText, quotaFullTimestamp(window.observedAt)
                )
            },
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            if (maxWidth < 330.dp || LocalDensity.current.fontScale >= 1.5f) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        name, color = palette.text, style = LedgerType.label,
                        maxLines = 2, overflow = TextOverflow.Ellipsis
                    )
                    V2QuotaHeadlineValue(palette, value, presentation.status, statusColor)
                }
            } else {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.Bottom
                ) {
                    Text(
                        name, color = palette.text, style = LedgerType.label,
                        modifier = Modifier.weight(1f).padding(end = 8.dp),
                        maxLines = 2, overflow = TextOverflow.Ellipsis
                    )
                    V2QuotaHeadlineValue(palette, value, presentation.status, statusColor)
                }
            }
        }

        if (value is QuotaDisplayValue.Progress) {
            V2QuotaProgressBar(
                palette = palette,
                fraction = v2QuotaRemainingFraction(value),
                degraded = presentation.status != QuotaWindowStatus.Ok
            )
        }

        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            severity?.let {
                Text(
                    it.label,
                    color = statusColor,
                    style = LedgerType.caption
                )
                Text("·", color = palette.faint, style = LedgerType.caption)
            }
            Text(
                compactResetText, color = palette.faint, style = LedgerType.caption,
                maxLines = 1, overflow = TextOverflow.Ellipsis
            )
            if (value != null && presentation.status != QuotaWindowStatus.Ok) {
                Text("·", color = palette.faint, style = LedgerType.caption)
                Text(
                    if (presentation.status == QuotaWindowStatus.Stale) {
                        "历史数据 · 观测 ${v2ShortDateTime(window.observedAt)}"
                    } else {
                        presentation.status.localizedLabel()
                    },
                    color = statusColor,
                    style = LedgerType.caption
                )
            }
        }
    }
}

internal data class QuotaHeadlinePresentation(
    val primary: String,
    val qualifier: String?
)

/** 把「可用」从真实额度值中拆成次级标签；原始值仍由 quotaValueLabel 统一格式化。 */
internal fun quotaHeadlinePresentation(
    value: QuotaDisplayValue?,
    status: QuotaWindowStatus
): QuotaHeadlinePresentation {
    val raw = quotaValueLabel(value) ?: status.localizedLabel()
    return if (raw.startsWith("可用 ")) {
        QuotaHeadlinePresentation(primary = raw.removePrefix("可用 "), qualifier = "可用")
    } else {
        QuotaHeadlinePresentation(primary = raw, qualifier = null)
    }
}

@Composable
private fun V2QuotaHeadlineValue(
    palette: MobileV2Palette,
    value: QuotaDisplayValue?,
    status: QuotaWindowStatus,
    statusColor: Color
) {
    val presentation = quotaHeadlinePresentation(value, status)
    when (value) {
        is QuotaDisplayValue.Progress -> {
            V2QuotaHeadlineWithQualifier(palette, presentation, LedgerType.numM)
        }
        is QuotaDisplayValue.Absolute,
        QuotaDisplayValue.UnlimitedCredits -> {
            V2QuotaHeadlineWithQualifier(palette, presentation, LedgerType.numS)
        }
        null -> {
            Text(
                text = presentation.primary,
                color = statusColor,
                fontSize = LedgerFont.body,
                fontWeight = FontWeight.Medium
            )
        }
    }
}

@Composable
private fun V2QuotaHeadlineWithQualifier(
    palette: MobileV2Palette,
    presentation: QuotaHeadlinePresentation,
    numberStyle: TextStyle
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = presentation.primary,
            color = palette.text,
            style = numberStyle
        )
        presentation.qualifier?.let {
            Text(
                text = it,
                color = palette.muted,
                style = LedgerType.caption
            )
        }
    }
}
