package com.jeidorf.tokenledger.mobile.ui.ambient

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jeidorf.tokenledger.mobile.AmbientFont
import com.jeidorf.tokenledger.mobile.AmbientRenderProfile
import com.jeidorf.tokenledger.mobile.ChartStyle
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.FillPolicy
import com.jeidorf.tokenledger.mobile.ReportMetricMode
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ambientRhythmSeries
import com.jeidorf.tokenledger.mobile.comparisonKindPresentation
import com.jeidorf.tokenledger.mobile.deltaPresentation
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.trendAvailabilityMessage
import com.jeidorf.tokenledger.mobile.ui.charts.V2LineLegend
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.tokenModeToggle
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import java.util.Locale

/**
 * D2 节奏：主角是 24 小时曲线与昨日对比线，数字退居标题行。
 */
@Composable
internal fun V2AmbientPulse(
    palette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    profile: AmbientRenderProfile,
    onTokenDisplayModeChange: ((TokenDisplayMode) -> Unit)?
) {
    val tokens = displayedTokenCount(
        tokenDisplayMode,
        stats.summary.effectiveTokens,
        stats.summary.cachedTokens
    )
    val delta = deltaPresentation(stats.comparison?.delta?.tokens)
    val directionalDelta = ambientDirectionalDelta(delta)
    val series = remember(stats) { ambientRhythmSeries(stats.comparison, stats.trends) }
    val peak = remember(series) {
        (series.current + series.previous).maxOrNull()?.toLong()?.let(::v2FormatTokens) ?: "—"
    }
    val currentHour = if (series.isHourly && series.current.isNotEmpty()) {
        String.format(Locale.US, "%02d:00", (series.current.size - 1).coerceAtMost(23))
    } else {
        null
    }
    Column(
        Modifier
            .fillMaxSize()
            .then(
                if (onTokenDisplayModeChange != null) {
                    Modifier.tokenModeToggle(tokenDisplayMode, onTokenDisplayModeChange)
                } else {
                    Modifier
                }
            ),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Row(verticalAlignment = Alignment.Bottom) {
            Column(Modifier.weight(1f)) {
                Text(
                    series.title,
                    color = palette.faint,
                    fontSize = AmbientFont.body,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 2.4.sp
                )
                Text(
                    v2FormatTokens(tokens),
                    color = palette.text,
                    fontSize = AmbientFont.hero,
                    lineHeight = 60.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-2).sp,
                    fontFamily = if (profile.useMonospaceNumerals) FontFamily.Monospace else FontFamily.Default,
                    maxLines = 1
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    directionalDelta,
                    color = palette.deltaColor(delta.tone),
                    fontSize = AmbientFont.headline,
                    fontWeight = FontWeight.Bold
                )
                Text(
                    comparisonKindPresentation(stats.comparison?.window?.kind).heroBaselineLabel,
                    color = palette.faint,
                    fontSize = AmbientFont.body
                )
            }
        }
        V2AmbientRhythmChart(
            palette = palette,
            series = series,
            profile = profile,
            modifier = Modifier.fillMaxWidth().weight(1f),
            showPrevious = true,
            fillArea = profile.fillPolicy != FillPolicy.Outline &&
                profile.chartStyle == ChartStyle.SmoothArea,
            showCurrentMarker = true,
            emptyMessage = trendAvailabilityMessage(
                stats.comparison, stats.trends, ReportMetricMode.Tokens
            )
        )
        if (series.current.isNotEmpty()) {
            if (series.isHourly) {
                Row(Modifier.fillMaxWidth()) {
                    listOf("00", "06", "12", "18").forEach { label ->
                        Text(
                            label,
                            color = palette.faint,
                            fontSize = AmbientFont.micro,
                            textAlign = TextAlign.Start,
                            modifier = Modifier.weight(1f)
                        )
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                V2LineLegend(palette.blue, false, "本期", palette)
                if (series.previous.isNotEmpty()) {
                    V2LineLegend(palette.muted, true, series.previousLabel, palette)
                }
                Spacer(Modifier.weight(1f))
                Text(
                    listOfNotNull("峰值 $peak", currentHour?.let { "当前 $it" }).joinToString(" · "),
                    color = palette.faint,
                    fontSize = AmbientFont.small
                )
            }
        }
        V2AmbientMetricTriple(palette, stats, profile, Modifier.fillMaxWidth())
        Text(
            "${state.query.range.label} · ${tokenDisplayMode.label} Token · ${ambientCadenceLabel(profile)}",
            color = palette.faint,
            fontSize = AmbientFont.small
        )
    }
}
