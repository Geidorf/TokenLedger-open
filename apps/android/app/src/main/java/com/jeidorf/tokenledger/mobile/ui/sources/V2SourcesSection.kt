package com.jeidorf.tokenledger.mobile.ui.sources

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.LocalSetDashboardCurrency
import com.jeidorf.tokenledger.mobile.LocalToggleCostMask
import com.jeidorf.tokenledger.mobile.ModelStat
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ToolStat
import com.jeidorf.tokenledger.mobile.COST_UNAVAILABLE_SPOKEN
import com.jeidorf.tokenledger.mobile.VALUE_UNAVAILABLE
import com.jeidorf.tokenledger.mobile.costMaskActionLabel
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.formatInteger
import com.jeidorf.tokenledger.mobile.isKnownCost
import com.jeidorf.tokenledger.mobile.modelCostDistribution
import com.jeidorf.tokenledger.mobile.sourceCostStructureLabel
import com.jeidorf.tokenledger.mobile.stableToolColorIndex
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE
import com.jeidorf.tokenledger.mobile.ui.foundation.tokenModeToggle
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Share
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import kotlin.math.max

internal data class V2SourceAnalysisPreparedData(
    val tools: List<ToolStat>,
    val models: List<ModelStat>,
    val visibleTools: List<ToolStat>,
    val toolMaximum: Long,
    val displayedTokens: Long,
    val toolDonutValues: List<Long>
)

@Composable
internal fun V2SourceAnalysis(
    palette: MobileV2Palette,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit,
    selectedTools: List<String>,
    onToolFilterChange: (String?) -> Unit,
    onOpenTool: (String) -> Unit,
    onOpenModel: (String) -> Unit
) {
    var showModels by rememberSaveable { mutableStateOf(false) }
    var showCost by rememberSaveable { mutableStateOf(false) }
    var expanded by rememberSaveable(showModels) { mutableStateOf(false) }
    val masked = LocalCostMaskEnabled.current
    val currency = LocalDashboardCurrency.current
    val context = LocalContext.current
    data class Source(val name: String, val tokens: Long, val requests: Long, val cost: Double?, val effective: Long)
    val rows = if (showModels) {
        modelCostDistribution(stats.models.values.toList(), stats.summary.totalCost).map {
            Source(it.model.name, displayedTokenCount(tokenDisplayMode, it.model.effectiveTokens, it.model.cached), it.model.requests, it.cost, it.model.effectiveTokens)
        }
    } else stats.tools.values.map { Source(it.name, displayedTokenCount(tokenDisplayMode, it.effectiveTokens, it.cached), it.requests, it.cost, it.effectiveTokens) }
    val sorted = if (showCost && masked) rows.sortedBy { it.name }
        else if (showCost) rows.sortedByDescending { it.cost ?: -1.0 } else rows.sortedByDescending { it.tokens }
    val maxValue = sorted.maxOfOrNull { if (showCost) it.cost ?: 0.0 else it.tokens.toDouble() } ?: 0.0
    val totalTokens = displayedTokenCount(tokenDisplayMode, stats.summary.effectiveTokens, stats.summary.cachedTokens)
    val total = if (showCost) stats.summary.totalCost else totalTokens.toDouble()
    V2Card(palette) {
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.weight(1f).heightIn(min = 48.dp).clickable(
                    role = Role.Button,
                    onClickLabel = if (showModels) "切换为工具来源" else "切换为模型来源"
                ) { showModels = !showModels },
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(if (showModels) "模型来源" else "工具来源", color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold)
                Icon(Icons.Default.SwapHoriz, null, tint = palette.muted, modifier = Modifier.padding(start = 6.dp).size(V2_ICON_INLINE))
            }
            Row(
                Modifier.heightIn(min = 48.dp).clickable(role = Role.Button, onClickLabel = "切换排序指标") { showCost = !showCost },
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(if (showCost) "预估费用" else "${tokenDisplayMode.label} Token", color = palette.blue, fontSize = LedgerFont.caption)
                Icon(Icons.Default.SwapHoriz, null, tint = palette.blue, modifier = Modifier.size(V2_ICON_INLINE))
            }
        }
        val setCurrency = LocalSetDashboardCurrency.current
        val toggleMask = LocalToggleCostMask.current
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (showCost) v2FormatMoney(context, stats.summary.totalCost, masked, currency) else v2FormatTokens(totalTokens),
                color = palette.text,
                fontSize = LedgerFont.displaySmall,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).wrapContentHeight(Alignment.CenterVertically).then(
                    if (showCost) Modifier.clickable(role = Role.Button, onClickLabel = "切换币种") {
                        setCurrency(if (currency == CurrencyUnit.CNY) CurrencyUnit.USD else CurrencyUnit.CNY)
                    } else Modifier.tokenModeToggle(tokenDisplayMode, onTokenDisplayModeChange, v2FormatTokens(totalTokens))
                )
            )
            if (showCost) {
                IconButton(onClick = toggleMask) {
                    Icon(
                        if (masked) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                        contentDescription = costMaskActionLabel(masked),
                        tint = palette.muted
                    )
                }
            }
        }
        Text(
            "${rows.size} 个${if (showModels) "模型" else "工具"} · ${v2FormatNumber(stats.summary.totalRequests)} 条记录 · ${if (showCost && masked) "费用已隐藏 · 按名称列出" else "按${if (showCost) "费用" else "用量"}排序"}",
            color = palette.muted,
            fontSize = LedgerFont.caption,
            modifier = Modifier.padding(vertical = 8.dp)
        )
        if (showCost) {
            val completeCosts = rows.all { it.cost != null && it.cost.isFinite() && it.cost >= 0 } &&
                kotlin.math.abs(rows.sumOf { it.cost ?: 0.0 } - stats.summary.totalCost) < 0.000001
            sorted.firstOrNull()?.let { row ->
                sourceCostStructureLabel(
                    row.name,
                    row.cost,
                    stats.summary.totalCost,
                    row.effective,
                    stats.summary.effectiveTokens,
                    masked,
                    completeCosts
                )?.let { label ->
                    Text(label, color = palette.muted, fontSize = LedgerFont.caption, modifier = Modifier.padding(bottom = 8.dp))
                }
            }
        }
        HorizontalDivider(color = palette.divider)
        sorted.take(if (expanded) Int.MAX_VALUE else 8).forEach { row ->
            val value = if (showCost) row.cost ?: 0.0 else row.tokens.toDouble()
            // 读不到、非有限或为负的费用写「不可得」，读屏念「预估费用不可得」（T10.154 A11）。
            val costText = if (isKnownCost(row.cost)) v2FormatMoney(context, row.cost, masked, currency) else VALUE_UNAVAILABLE
            val costSpoken = if (isKnownCost(row.cost)) costText else COST_UNAVAILABLE_SPOKEN
            V2SourceRow(
                palette,
                if (showModels) palette.violet else listOf(palette.blue, palette.green, palette.amber, palette.violet)[stableToolColorIndex(row.name)],
                row.name,
                value = if (showCost) costText else v2FormatTokens(row.tokens),
                note = "${if (showCost) modelCostShareLabel(masked, row.cost?.takeIf { total > 0 }?.let { it / total * 100 }) else v2Share(row.tokens, max(totalTokens, 1L))} · ${v2FormatNumber(row.requests)} 条记录",
                barFraction = if ((showCost && masked) || maxValue <= 0) 0f else (value / maxValue).toFloat().coerceIn(0f, 1f),
                secondaryValue = if (showCost) "${v2FormatTokens(row.tokens)} Token" else costText,
                accessibilityValue = if (showCost) costSpoken else "${formatInteger(row.tokens)} ${tokenDisplayMode.label} Token",
                onClick = { if (showModels) onOpenModel(row.name) else onOpenTool(row.name) }
            )
        }
        if (rows.isEmpty()) Text("当前范围没有来源数据", color = palette.muted, fontSize = LedgerFont.label, modifier = Modifier.padding(vertical = 16.dp))
        if (rows.size > 8) {
            TextButton(onClick = { expanded = !expanded }, modifier = Modifier.fillMaxWidth()) {
                Text(if (expanded) "收起" else "查看全部 ${rows.size} 项")
            }
        }
    }
}
