package com.jeidorf.tokenledger.mobile.ui.calendar

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.hero.V2MetricDivider
import com.jeidorf.tokenledger.mobile.ui.hero.V2MiniMetric
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens

internal data class V2CalendarSummaryMetrics(
    val activeDaysLabel: String,
    val peakLabel: String,
    val averageLabel: String
)

@Composable
internal fun V2CalendarSummary(palette: MobileV2Palette, heatmap: Map<String, Long>) {
    val metrics = remember(heatmap) {
        var activeDays = 0L
        var peak = 0L
        var sum = 0L
        for (v in heatmap.values) {
            if (v > 0L) {
                activeDays++
                sum += v
                if (v > peak) peak = v
            }
        }
        val average = if (activeDays > 0L) sum / activeDays else 0L
        V2CalendarSummaryMetrics(
            activeDaysLabel = v2FormatNumber(activeDays),
            peakLabel = v2FormatTokens(peak),
            averageLabel = v2FormatTokens(average)
        )
    }
    V2Card(palette) {
        Text("活跃日历", color = palette.text, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(12.dp))
        if (LocalDensity.current.fontScale >= 1.5f) {
            V2MiniMetric("活跃天", metrics.activeDaysLabel, palette, Modifier.fillMaxWidth(), stacked = true)
            V2MiniMetric("峰值日", metrics.peakLabel, palette, Modifier.fillMaxWidth(), stacked = true)
            V2MiniMetric("活跃日均", metrics.averageLabel, palette, Modifier.fillMaxWidth(), stacked = true)
        } else {
            Row {
                V2MiniMetric("活跃天", metrics.activeDaysLabel, palette, Modifier.weight(1f))
                V2MetricDivider(palette)
                V2MiniMetric("峰值日", metrics.peakLabel, palette, Modifier.weight(1f))
                V2MetricDivider(palette)
                V2MiniMetric("活跃日均", metrics.averageLabel, palette, Modifier.weight(1f))
            }
        }
    }
}
