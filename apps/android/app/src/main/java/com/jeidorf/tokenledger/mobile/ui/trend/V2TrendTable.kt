package com.jeidorf.tokenledger.mobile.ui.trend

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.ReportMetricMode
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.collapsedTrendTableRows
import com.jeidorf.tokenledger.mobile.formatInteger
import com.jeidorf.tokenledger.mobile.formatTrendAnchorLabel
import com.jeidorf.tokenledger.mobile.trendAvailabilityMessage
import com.jeidorf.tokenledger.mobile.trendTableRows
import com.jeidorf.tokenledger.mobile.trendTableValue
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card

@Composable
internal fun V2TrendTable(
    palette: MobileV2Palette,
    stats: StatsData,
    metricMode: ReportMetricMode,
    currency: CurrencyUnit,
    collapsible: Boolean = false,
    embedded: Boolean = false
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val isCostMasked = LocalCostMaskEnabled.current
    val rows = remember(stats, metricMode) { trendTableRows(stats, metricMode, limit = Int.MAX_VALUE) }
    val content: @Composable ColumnScope.() -> Unit = content@{
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).then(
                if (collapsible && rows.isNotEmpty()) {
                    Modifier.semantics { stateDescription = if (expanded) "已展开" else "已收起" }
                        .clickable(role = Role.Button, onClickLabel = if (expanded) "收起时段明细" else "展开时段明细") {
                            expanded = !expanded
                        }
                } else {
                    Modifier
                }
            ),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("时段明细 · ${rows.size}", color = palette.text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f).semantics { heading() })
            if (collapsible && rows.isNotEmpty()) {
                Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, contentDescription = null, tint = palette.muted)
            }
        }
        Text(
            if (metricMode == ReportMetricMode.Tokens) "单位：有效 Token" else "单位：${currency.label} · 预估费用",
            color = palette.muted,
            fontSize = LedgerFont.caption
        )
        if (rows.isEmpty()) {
            Text(
                trendAvailabilityMessage(stats.comparison, stats.trends, metricMode) ?: "当前范围暂无趋势数据",
                color = palette.muted,
                fontSize = LedgerFont.label
            )
            return@content
        }
        Spacer(Modifier.height(8.dp))
        // 对齐表可能在当前期末尾带着尚未发生的未来桶；收起态应先按当前期实际
        // 已观测的桶筛选，再显示最后三行。展开态仍完整保留两期的对齐关系和缺值。
        val visibleRows = if (collapsible && !expanded) collapsedTrendTableRows(rows) else rows
        Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            Text("时段", color = palette.faint, fontSize = LedgerFont.caption, modifier = Modifier.weight(0.8f))
            Text("本期", color = palette.faint, fontSize = LedgerFont.caption, textAlign = TextAlign.End, modifier = Modifier.weight(1.5f))
            Text("上期", color = palette.faint, fontSize = LedgerFont.caption, textAlign = TextAlign.End, modifier = Modifier.weight(1.5f))
        }
        visibleRows.forEachIndexed { index, row ->
            val currentLabel = trendTableValue(row.current, metricMode, currency, isCostMasked)
            val previousLabel = trendTableValue(row.previous, metricMode, currency, isCostMasked)
            Row(
                Modifier.fillMaxWidth().clearAndSetSemantics {
                    contentDescription = "本期时段 ${row.current?.bucket ?: "不可得"}，$currentLabel；上期时段 ${row.previous?.bucket ?: "不可得"}，$previousLabel"
                }.padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(formatTrendAnchorLabel(row.bucket), color = palette.muted, fontSize = LedgerFont.caption, modifier = Modifier.weight(0.8f))
                Text(if (metricMode == ReportMetricMode.Tokens) row.current?.tokens?.let(::formatInteger) ?: "—" else currentLabel, color = palette.text, fontSize = LedgerFont.caption, textAlign = TextAlign.End, modifier = Modifier.weight(1.5f))
                Text(if (metricMode == ReportMetricMode.Tokens) row.previous?.tokens?.let(::formatInteger) ?: "—" else previousLabel, color = palette.muted, fontSize = LedgerFont.caption, textAlign = TextAlign.End, modifier = Modifier.weight(1.5f))
            }
            if (index < visibleRows.lastIndex) HorizontalDivider(color = palette.divider)
        }
    }
    if (embedded) Column(Modifier.fillMaxWidth(), content = content) else V2Card(palette, content = content)
}
