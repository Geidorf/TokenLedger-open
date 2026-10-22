package com.jeidorf.tokenledger.mobile.ui.calendar

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.InsightCalendarAxis
import com.jeidorf.tokenledger.mobile.InsightCalendarCell
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.isLandscapeOrCompactHeight
import com.jeidorf.tokenledger.mobile.ui.charts.V2HeatmapChart
import com.jeidorf.tokenledger.mobile.ui.charts.V2HeatmapScaleLegend
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.v2FormatTokens

internal data class V2HeatmapCardAggregates(
    val activeDays: Int,
    val peak: Long,
    val formattedPeak: String
)

@Composable
internal fun V2HeatmapCard(
    palette: MobileV2Palette,
    axis: InsightCalendarAxis,
    compact: Boolean,
    onClick: (() -> Unit)?
) {
    if (!axis.isTrusted) {
        V2Card(palette) {
            Text(axis.unavailableReason ?: "当前范围日历不可得", color = palette.muted, fontSize = LedgerFont.label)
        }
        return
    }
    val heatmap = remember(axis) {
        axis.cells.filter(InsightCalendarCell::selectable).associate { it.date.toString() to it.tokens }
    }
    val previewAxis = remember(axis, compact) { axis.copy(cells = axis.cells.takeLast(if (compact) 84 else 126)) }
    // 统计跟着图走：图画的是最近 N 周，数字就只报这 N 周。此前数字统计整个 axis，
    // 与下方 12 周的图对不上。
    val aggregates = remember(previewAxis) {
        var count = 0
        var maxTokens = 0L
        for (cell in previewAxis.cells) {
            val v = cell.knownTokens ?: continue
            if (v > 0L) count++
            if (v > maxTokens) maxTokens = v
        }
        V2HeatmapCardAggregates(
            activeDays = count,
            peak = maxTokens,
            formattedPeak = v2FormatTokens(maxTokens)
        )
    }
    val activeDays = aggregates.activeDays
    val actionLabel = if (compact) "打开日历洞察" else "查看活跃日历"
    val contentDesc = remember(activeDays, aggregates.formattedPeak, actionLabel) {
        "活跃日历，${activeDays} 天有记录，峰值 ${aggregates.formattedPeak}，$actionLabel"
    }
    val cardModifier = onClick?.let { action ->
        Modifier
            .clickable(role = Role.Button, onClickLabel = actionLabel, onClick = action)
            .semantics(mergeDescendants = true) {
                contentDescription = contentDesc
            }
    } ?: Modifier
    val isCompactHeight = isLandscapeOrCompactHeight(LocalConfiguration.current.screenHeightDp)
    val chartHeight = if (compact) {
        if (isCompactHeight) 76.dp else 92.dp
    } else {
        if (isCompactHeight) 110.dp else 150.dp
    }
    V2Card(
        palette = palette,
        modifier = cardModifier,
        contentPadding = PaddingValues(16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("近 ${(previewAxis.cells.size / 7).coerceAtLeast(1)} 周活跃", color = palette.faint, fontSize = LedgerFont.caption)
                Text("$activeDays 天有记录", color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold)
            }
            if (compact && onClick != null) Icon(Icons.Default.ChevronRight, contentDescription = "打开日历洞察", tint = palette.blue)
        }
        Spacer(Modifier.height(10.dp))
        V2HeatmapChart(
            palette = palette,
            heatmap = heatmap,
            modifier = Modifier.fillMaxWidth().height(chartHeight),
            weeks = (previewAxis.cells.size / 7).coerceAtLeast(1),
            interactive = false,
            calendarAxis = previewAxis,
            compactCalendar = true
        )
        Spacer(Modifier.height(8.dp))
        V2HeatmapScaleLegend(palette)
    }
}
