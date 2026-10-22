package com.jeidorf.tokenledger.mobile.ui.quota

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2StableChoiceText
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_TOUCH_TARGET
import com.jeidorf.tokenledger.mobile.ui.foundation.observeChoiceBounds
import com.jeidorf.tokenledger.mobile.ui.navigation.V2IconAction

@Composable
internal fun V2QuotaStateCard(
    palette: MobileV2Palette,
    title: String,
    body: String,
    actionLabel: String? = null,
    actionEnabled: Boolean = true,
    onAction: (() -> Unit)? = null,
    onBounds: ((String, List<Int>) -> Unit)? = null
) {
    V2Card(palette) {
        Text(
            title,
            color = palette.text,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.semantics { heading() }
        )
        Text(
            body,
            color = palette.muted,
            fontSize = LedgerFont.caption,
            lineHeight = 16.sp,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
        )
        if (actionLabel != null && onAction != null) {
            OutlinedButton(
                onClick = onAction,
                enabled = actionEnabled,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .observeChoiceBounds("refresh", onBounds),
                border = BorderStroke(1.dp, palette.divider)
            ) {
                V2StableChoiceText(
                    listOf("重新读取", "读取中…", actionLabel),
                    actionLabel,
                    TextStyle(fontSize = LedgerFont.body, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center),
                    palette.text
                )
            }
        }
    }
}

/**
 * 额度页顶部的传输状态：一行文字 + 一个刷新图标，替代原来的整张说明卡。
 * 完整时间戳留在 contentDescription 里，读屏仍能拿到精确值。
 */
@Composable
internal fun V2QuotaTransportLine(
    palette: MobileV2Palette,
    label: String,
    timestamp: String,
    refreshing: Boolean,
    onRefresh: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = V2_TOUCH_TARGET)
            .semantics(mergeDescendants = true) {
                contentDescription = "$label，云端投影 $timestamp"
                liveRegion = LiveRegionMode.Polite
            },
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            "$label · $timestamp",
            color = palette.faint,
            fontSize = LedgerFont.caption,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        V2IconAction(
            palette = palette,
            icon = Icons.Default.Refresh,
            contentDescription = if (refreshing) "正在重新读取额度" else "重新读取额度",
            onClick = onRefresh,
            enabled = !refreshing
        )
    }
}
