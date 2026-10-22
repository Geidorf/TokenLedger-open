package com.jeidorf.tokenledger.mobile.ui.calendar

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.v2FormatNumber

@Composable
internal fun V2DayReviewSummary(
    palette: MobileV2Palette,
    date: String,
    stats: StatsData,
    onReturnFromDay: () -> Unit
) {
    V2Card(palette) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("$date 当天复盘", color = palette.text, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
            }
            TextButton(onClick = onReturnFromDay, modifier = Modifier.heightIn(min = 48.dp)) { Text("返回原视图") }
        }
        Text(
            "${v2FormatNumber(stats.summary.totalRequests)} 条记录 · ${stats.models.size} 个模型 · ${stats.tools.size} 个工具",
            color = palette.muted,
            fontSize = LedgerFont.label
        )
    }
}
