package com.jeidorf.tokenledger.mobile.ui.ambient

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jeidorf.tokenledger.mobile.AmbientFont
import com.jeidorf.tokenledger.mobile.AmbientRenderProfile
import com.jeidorf.tokenledger.mobile.AmbientRhythmSeries
import com.jeidorf.tokenledger.mobile.AmbientViewportKind
import com.jeidorf.tokenledger.mobile.AmbientViewportPolicy
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.LowPowerPolicy
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TABULAR_NUMERALS
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ambientRhythmSeries
import com.jeidorf.tokenledger.mobile.dailyQuoteFor
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.ui.charts.V2HeatmapChart
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.tokenModeToggle
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * D5 墨水日报：等宽排版的全文本版面，无实心色块、无环形进度。
 */
@Composable
internal fun V2AmbientLedger(
    palette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    profile: AmbientRenderProfile,
    policy: LowPowerPolicy,
    viewport: AmbientViewportPolicy,
    onTokenDisplayModeChange: ((TokenDisplayMode) -> Unit)?
) {
    val tokens = displayedTokenCount(
        tokenDisplayMode,
        stats.summary.effectiveTokens,
        stats.summary.cachedTokens
    )
    val series = remember(stats) { ambientRhythmSeries(stats.comparison, stats.trends) }
    val today = state.dailyQuote?.date ?: LocalDate.now()
    val dateLabel = remember(today) {
        today.format(DateTimeFormatter.ofPattern("yyyy 年 M 月 d 日 EEEE", Locale.SIMPLIFIED_CHINESE))
    }
    if (viewport.landscape) {
        V2AmbientLedgerLandscape(
            palette = palette,
            state = state,
            stats = stats,
            tokenDisplayMode = tokenDisplayMode,
            profile = profile,
            policy = policy,
            viewport = viewport,
            tokens = tokens,
            series = series,
            dateLabel = dateLabel,
            onTokenDisplayModeChange = onTokenDisplayModeChange
        )
        return
    }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        // 报头
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "TOKENLEDGER 日报",
                color = palette.text,
                fontSize = AmbientFont.titleLarge,
                fontWeight = FontWeight.Bold,
                style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS),
                letterSpacing = 1.4.sp,
                modifier = Modifier.weight(1f).semantics { heading() }
            )
            V2JeidorfWordmark(palette, compact = true)
        }
        Text(
            "$dateLabel · ${state.query.range.label} · ${ambientCadenceLabel(profile)}",
            color = palette.muted,
            fontSize = AmbientFont.body,
            fontFamily = FontFamily.Monospace
        )
        V2LedgerRule(palette, thick = true)

        // 头版数字
        Row(
            Modifier
                .fillMaxWidth()
                .then(
                    if (onTokenDisplayModeChange != null) {
                        Modifier.tokenModeToggle(tokenDisplayMode, onTokenDisplayModeChange)
                    } else {
                        Modifier
                    }
                ),
            verticalAlignment = Alignment.Bottom
        ) {
            Text(
                v2FormatTokens(tokens),
                color = palette.text,
                fontSize = AmbientFont.displayLarge,
                lineHeight = 50.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.weight(1f),
                maxLines = 1
            )
            Text(
                "${tokenDisplayMode.label} TOKEN",
                color = palette.muted,
                fontSize = AmbientFont.body,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(bottom = 8.dp)
            )
        }
        V2AmbientMetricTriple(palette, stats, profile, Modifier.fillMaxWidth())
        V2LedgerRule(palette)

        V2LedgerSectionTitle(palette, "同期对比")
        V2AmbientComparisonTable(palette, stats, Modifier.fillMaxWidth())
        V2LedgerRule(palette)

        if (series.hasData) {
            V2LedgerSectionTitle(palette, series.title)
            V2AmbientRhythmChart(
                palette = palette,
                series = series,
                profile = profile,
                modifier = Modifier.fillMaxWidth().height(108.dp),
                showPrevious = true,
                fillArea = false
            )
            V2LedgerRule(palette)
        }

        V2LedgerSectionTitle(palette, "额度")
        V2AmbientQuotaBoard(
            palette = palette,
            state = state,
            profile = profile,
            limit = policy.visibleQuotaWindowLimit,
            columns = 1,
            modifier = Modifier.fillMaxWidth()
        )
        V2LedgerRule(palette)

        V2LedgerSectionTitle(palette, "12 周活跃度")
        V2HeatmapChart(palette, stats.heatmap, Modifier.fillMaxWidth().height(78.dp), weeks = 12)
        V2LedgerRule(palette)

        V2AmbientFreshnessFooter(palette, state, profile, Modifier.fillMaxWidth())

        state.dailyQuote?.quote?.let { quote ->
            V2LedgerRule(palette)
            Text(
                "「${quote.text}」",
                color = palette.text,
                fontSize = AmbientFont.label,
                lineHeight = 20.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = "今日一句：${quote.text}，${quote.source}" }
            )
            Text(
                "— ${quote.source}",
                color = palette.muted,
                fontSize = AmbientFont.body,
                style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS),
                textAlign = TextAlign.End,
                modifier = Modifier.fillMaxWidth()
            )
        }
        Spacer(Modifier.height(8.dp))
    }
}

/**
 * 横屏日报是一张固定版面的报纸，不允许依赖滚动才能看到下半版。
 */
@Composable
internal fun V2AmbientLedgerLandscape(
    palette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    profile: AmbientRenderProfile,
    policy: LowPowerPolicy,
    viewport: AmbientViewportPolicy,
    tokens: Long,
    series: AmbientRhythmSeries,
    dateLabel: String,
    onTokenDisplayModeChange: ((TokenDisplayMode) -> Unit)?
) {
    val today = state.dailyQuote?.date ?: LocalDate.now()
    val quote = state.dailyQuote?.quote ?: remember(today) { dailyQuoteFor(today) }
    val compact = viewport.kind != AmbientViewportKind.LandscapeRegular
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(if (compact) 6.dp else 8.dp)
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "TOKENLEDGER 日报",
                color = palette.text,
                fontSize = if (compact) AmbientFont.title else AmbientFont.titleLarge,
                fontWeight = FontWeight.Bold,
                style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS),
                letterSpacing = 1.4.sp,
                modifier = Modifier.weight(1f).semantics { heading() }
            )
            Text(
                "$dateLabel · ${state.query.range.label} · ${ambientCadenceLabel(profile)}",
                color = palette.muted,
                fontSize = AmbientFont.small,
                fontFamily = FontFamily.Monospace
            )
            Spacer(Modifier.width(18.dp))
            V2JeidorfWordmark(palette, compact = true)
        }
        V2LedgerRule(palette, thick = true)
        Row(
            Modifier.fillMaxWidth().weight(1f),
            horizontalArrangement = Arrangement.spacedBy(if (compact) 10.dp else 14.dp)
        ) {
            Column(
                Modifier.fillMaxHeight().weight(0.95f),
                verticalArrangement = Arrangement.spacedBy(if (compact) 5.dp else 7.dp)
            ) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .then(
                            if (onTokenDisplayModeChange != null) {
                                Modifier.tokenModeToggle(tokenDisplayMode, onTokenDisplayModeChange)
                            } else {
                                Modifier
                            }
                        ),
                    verticalAlignment = Alignment.Bottom
                ) {
                    Text(
                        v2FormatTokens(tokens),
                        color = palette.text,
                        fontSize = if (compact) AmbientFont.display else AmbientFont.displayLarge,
                        lineHeight = if (compact) 41.sp else 47.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.weight(1f),
                        maxLines = 1
                    )
                    Text(
                        "${tokenDisplayMode.label} TOKEN",
                        color = palette.muted,
                        fontSize = AmbientFont.small,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.padding(bottom = 6.dp)
                    )
                }
                V2AmbientMetricTriple(palette, stats, profile, Modifier.fillMaxWidth())
                V2LedgerRule(palette)
                V2LedgerSectionTitle(palette, "同期对比")
                V2AmbientComparisonTable(palette, stats, Modifier.fillMaxWidth())
                if (series.hasData) {
                    V2LedgerRule(palette)
                    V2LedgerSectionTitle(palette, series.title)
                    V2AmbientRhythmChart(
                        palette = palette,
                        series = series,
                        profile = profile,
                        modifier = Modifier.fillMaxWidth().weight(1f),
                        showPrevious = true,
                        fillArea = false
                    )
                } else {
                    Spacer(Modifier.weight(1f))
                }
            }
            Spacer(Modifier.width(1.dp).fillMaxHeight().background(palette.divider))
            Column(
                Modifier.fillMaxHeight().weight(1.05f),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                V2LedgerSectionTitle(palette, "额度")
                V2AmbientQuotaBoard(
                    palette = palette,
                    state = state,
                    profile = profile,
                    limit = policy.visibleQuotaWindowLimit,
                    columns = 2,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }
        V2LedgerRule(palette, thick = true)
        Row(
            Modifier.fillMaxWidth().height(viewport.ledgerFooterHeightDp.dp),
            horizontalArrangement = Arrangement.spacedBy(if (compact) 10.dp else 14.dp)
        ) {
            Column(Modifier.fillMaxHeight().weight(1.15f)) {
                V2LedgerSectionTitle(palette, "12 周活跃度")
                Spacer(Modifier.height(4.dp))
                V2HeatmapChart(
                    palette,
                    stats.heatmap,
                    Modifier.fillMaxWidth().weight(1f),
                    weeks = 12
                )
            }
            Spacer(Modifier.width(1.dp).fillMaxHeight().background(palette.divider))
            Column(
                Modifier.fillMaxHeight().weight(1.05f)
                    .semantics { contentDescription = "今日一句：${quote.text}，${quote.source}" }
            ) {
                V2LedgerSectionTitle(palette, "今日一句")
                Spacer(Modifier.height(4.dp))
                Text(
                    "「${quote.text}」",
                    color = palette.text,
                    fontSize = if (compact) AmbientFont.body else AmbientFont.bodyLarge,
                    lineHeight = if (compact) 14.sp else 16.sp,
                    style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    "— ${quote.source}",
                    color = palette.muted,
                    fontSize = AmbientFont.small,
                    fontFamily = FontFamily.Monospace,
                    lineHeight = 11.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.End,
                    modifier = Modifier.fillMaxWidth()
                )
            }
            Spacer(Modifier.width(1.dp).fillMaxHeight().background(palette.divider))
            V2AmbientFreshnessFooter(
                palette = palette,
                state = state,
                profile = profile,
                modifier = Modifier.fillMaxHeight().weight(1f)
            )
        }
    }
}
