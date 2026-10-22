package com.jeidorf.tokenledger.mobile.ui.sources

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.formatInteger
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.trend.normalizedDataBarFraction
import kotlin.math.max

@Composable
internal fun V2ToolDistributionCard(
    palette: MobileV2Palette,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    onOpenTool: (String) -> Unit,
    limit: Int = 4,
    title: String = "工具分布",
    actionLabelOverride: String? = null,
    onOpenRemainder: (() -> Unit)? = null
) {
    val displayedTokens = remember(stats.summary, tokenDisplayMode) {
        displayedTokenCount(tokenDisplayMode, stats.summary.effectiveTokens, stats.summary.cachedTokens)
    }
    val total = remember(displayedTokens) { max(displayedTokens, 1L) }
    val rows = remember(stats.tools, tokenDisplayMode, total, limit) {
        todaySourceRows(stats.tools.values, tokenDisplayMode, total, limit)
    }
    val maximum = rows.maxOfOrNull { it.tokens } ?: 0L

    V2Card(palette) {
        Column(Modifier.fillMaxWidth()) {
            Text(title, color = palette.text, style = LedgerType.titleM)
            if (rows.isEmpty()) Text("暂无工具来源", color = palette.muted, fontSize = LedgerFont.label)
            Spacer(Modifier.height(LedgerSpace.sm))
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(LedgerSpace.xs)) {
                rows.forEach { item ->
                    val opensEntity = item.opensEntity
                    V2SourceRow(
                        palette = palette,
                        color = palette.tokens.chartSlot(item.slot),
                        label = item.name,
                        value = item.tokensLabel,
                        note = item.share,
                        barFraction = normalizedDataBarFraction(item.tokens, maximum),
                        onClick = {
                            if (opensEntity) onOpenTool(item.name)
                            else onOpenRemainder?.invoke()
                        },
                        actionLabelOverride = when {
                            actionLabelOverride != null && opensEntity -> actionLabelOverride
                            opensEntity -> null
                            else -> "查看其余来源"
                        },
                        accessibilityValue = "${formatInteger(item.tokens)} ${tokenDisplayMode.label} Token"
                    )
                }
            }
        }
    }
}
