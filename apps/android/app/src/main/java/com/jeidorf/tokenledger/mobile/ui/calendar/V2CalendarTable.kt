package com.jeidorf.tokenledger.mobile.ui.calendar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.recentDailyActivityRows
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.v2DataBarBackground

@Composable
internal fun V2CalendarTable(palette: MobileV2Palette, stats: StatsData, query: DashboardQuery) {
    val masked = LocalCostMaskEnabled.current
    val currency = LocalDashboardCurrency.current
    val tableRows = remember(stats, query, masked, currency) { recentDailyActivityRows(stats, query, masked, currency) }
    V2Card(palette) {
        Text("最近活跃日期", color = palette.text, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
        Text("按已有记录汇总，未逐笔核价", color = palette.faint, fontSize = LedgerFont.label)
        if (stats.dailyCosts == null && tableRows.isNotEmpty()) {
            Text("当前数据未提供每日费用；可打开当天复盘查看汇总。", color = palette.muted, fontSize = LedgerFont.label)
        }
        Spacer(Modifier.height(8.dp))
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val stacked = maxWidth < 330.dp || LocalDensity.current.fontScale >= 1.5f
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                tableRows.forEach { row ->
                    val rowModifier = Modifier.fillMaxWidth()
                        .v2DataBarBackground(palette, palette.blue, row.fraction)
                        // The summary reads its visible date once; only calendar cells are day buttons.
                        .semantics(mergeDescendants = true) {}
                        .padding(horizontal = 8.dp, vertical = 8.dp)
                    val amountText: @Composable () -> Unit = {
                        Text(
                            "预估费用 ${row.amount.text}",
                            color = palette.text,
                            fontSize = LedgerFont.body,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.clearAndSetSemantics { contentDescription = row.amount.accessibility }
                        )
                    }
                    if (stacked) {
                        Column(rowModifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(row.date, color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.Medium)
                            Text("有效 Token ${row.tokenLabel}", color = palette.muted, fontSize = LedgerFont.body)
                            amountText()
                        }
                    } else {
                        Row(rowModifier, verticalAlignment = Alignment.CenterVertically) {
                            Text(row.date, color = palette.text, fontSize = LedgerFont.body, modifier = Modifier.weight(1f))
                            Column(
                                Modifier.weight(1.4f),
                                horizontalAlignment = Alignment.End,
                                verticalArrangement = Arrangement.spacedBy(4.dp)
                            ) {
                                Text("有效 Token ${row.tokenLabel}", color = palette.muted, fontSize = LedgerFont.body)
                                amountText()
                            }
                        }
                    }
                }
            }
        }
        if (tableRows.isEmpty()) Text("当前响应没有活跃日期数据。", color = palette.muted, fontSize = LedgerFont.label)
    }
}
