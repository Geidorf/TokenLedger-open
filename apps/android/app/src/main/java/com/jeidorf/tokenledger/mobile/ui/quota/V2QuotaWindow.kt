package com.jeidorf.tokenledger.mobile.ui.quota

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LocalLedgerNow
import com.jeidorf.tokenledger.mobile.QuotaCardWindowPresentation
import com.jeidorf.tokenledger.mobile.QuotaDisplayValue
import com.jeidorf.tokenledger.mobile.QuotaProviderEnvelope
import com.jeidorf.tokenledger.mobile.QuotaWindowStatus
import com.jeidorf.tokenledger.mobile.localizedDisplayName
import com.jeidorf.tokenledger.mobile.localizedLabel
import com.jeidorf.tokenledger.mobile.localizedWindowLabel
import com.jeidorf.tokenledger.mobile.quotaFullTimestamp
import com.jeidorf.tokenledger.mobile.quotaSeverityForFraction
import com.jeidorf.tokenledger.mobile.quotaValueLabel
import com.jeidorf.tokenledger.mobile.quotaWindowAccessibilityDescription
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun V2QuotaWindow(palette: MobileV2Palette, provider: QuotaProviderEnvelope, presentation: QuotaCardWindowPresentation) {
    val window = presentation.window
    val value = presentation.value
    val valueText = quotaValueLabel(value) ?: presentation.status.localizedLabel()
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
        Modifier.fillMaxWidth().padding(vertical = 8.dp).clearAndSetSemantics {
            contentDescription = quotaWindowAccessibilityDescription(
                provider.localizedDisplayName(), name, presentation.status.localizedLabel(),
                // 颜色只表达剩余量，读屏必须能听到同一件事，否则色觉障碍与墨水屏都读不出"快用完了"。
                quotaValueLabel(value)?.let { label -> severity?.let { "$label（${it.label}）" } ?: label },
                resetText, quotaFullTimestamp(window.observedAt)
            )
        },
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            if (maxWidth < 330.dp || LocalDensity.current.fontScale >= 1.5f) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        name, color = palette.text, fontSize = LedgerFont.label, fontWeight = FontWeight.Medium,
                        maxLines = 2, overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        valueText, color = statusColor, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold,
                        maxLines = 2, overflow = TextOverflow.Ellipsis
                    )
                }
            } else {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        name, color = palette.text, fontSize = LedgerFont.label,
                        modifier = Modifier.weight(1f),
                        maxLines = 2, overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        valueText, color = statusColor, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f), textAlign = TextAlign.End,
                        maxLines = 2, overflow = TextOverflow.Ellipsis
                    )
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
        // 「重置 2026-09-08 00:00:00」这类完整时间戳挪进详情抽屉，外层只留一句相对说法。
        // 详情里本来就有一份逐字相同的，此前是两处并存。
        //
        // 重置时间与状态是同一个窗口的两句注脚，此前各占一行：三个窗口的卡片就多出三行
        // 只有 11sp 的小字。合成一行，窄屏或大字体时由 FlowRow 自己折。两句仍分开着色，
        // 状态是琥珀色的信号，不能被并进灰色的注脚里。
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(
                compactResetText, color = palette.faint, fontSize = LedgerFont.caption,
                maxLines = 1, overflow = TextOverflow.Ellipsis
            )
            if (value != null && presentation.status != QuotaWindowStatus.Ok) {
                Text("·", color = palette.faint, fontSize = LedgerFont.caption)
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(statusColor.copy(alpha = if (palette.isEInk) 0f else 0.12f))
                        .padding(horizontal = 4.dp, vertical = 1.dp)
                ) {
                    Text(
                        presentation.status.localizedLabel(),
                        color = statusColor,
                        fontSize = LedgerFont.caption,
                        fontWeight = FontWeight.Medium
                    )
                }
            }
        }
    }
}
