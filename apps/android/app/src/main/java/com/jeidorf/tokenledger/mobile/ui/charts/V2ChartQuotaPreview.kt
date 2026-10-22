package com.jeidorf.tokenledger.mobile.ui.charts

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.ProvideLedgerPalette
import com.jeidorf.tokenledger.mobile.QuotaUiState
import com.jeidorf.tokenledger.mobile.ReportMetricMode
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.TokenLedgerTheme
import com.jeidorf.tokenledger.mobile.ui.calendar.V2CalendarTable
import com.jeidorf.tokenledger.mobile.ui.controls.V2CurrencyToggle
import com.jeidorf.tokenledger.mobile.ui.controls.V2InsightStrip
import com.jeidorf.tokenledger.mobile.ui.controls.V2MetricModeToggle
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.observeChoiceBounds
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import com.jeidorf.tokenledger.mobile.ui.hero.V2CompositionCard
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane
import com.jeidorf.tokenledger.mobile.ui.quota.V2ProviderCard
import com.jeidorf.tokenledger.mobile.ui.quota.V2QuotaStateCard
import com.jeidorf.tokenledger.mobile.ui.sources.ModelMetricMode
import com.jeidorf.tokenledger.mobile.ui.sources.V2ModelDistributionCard
import com.jeidorf.tokenledger.mobile.ui.sources.V2SourceAnalysis
import com.jeidorf.tokenledger.mobile.ui.sources.V2ToolDistributionCard
import com.jeidorf.tokenledger.mobile.ui.trend.V2TrendInsightCard
import com.jeidorf.tokenledger.mobile.ui.trend.V2TrendTable

internal enum class ChartQuotaPreviewSurface { Trend, TrendTable, Sources, OverviewTools, Composition, ModelRanking, Quota, Controls }
internal enum class ChartQuotaControlState(val label: String) {
    Unselected("未选中"), Selected("已选中"), Disabled("禁用"), Loading("加载中")
}

@Composable
internal fun V2ChartQuotaPreviewContent(
    surface: ChartQuotaPreviewSurface,
    stats: StatsData,
    appearance: LedgerAppearance = LedgerAppearance.Light,
    metric: ReportMetricMode = ReportMetricMode.Tokens,
    currency: CurrencyUnit = CurrencyUnit.USD,
    quota: QuotaUiState.Available? = null,
    details: Boolean = false,
    masked: Boolean = false,
    controlState: ChartQuotaControlState = ChartQuotaControlState.Unselected,
    onControlBounds: ((String, List<Int>) -> Unit)? = null,
    onOpenTrendBucket: ((String, InsightPane) -> Unit)? = null
) {
    val palette = remember(appearance) { v2Palette(appearance) }
    TokenLedgerTheme(appearance) {
        ProvideLedgerPalette(appearance) {
            CompositionLocalProvider(LocalCostMaskEnabled provides masked) {
                Column(Modifier.fillMaxSize().background(palette.background).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    when (surface) {
                        ChartQuotaPreviewSurface.Trend -> {
                            V2TrendInsightCard(palette, stats, TokenDisplayMode.Effective, {}, metric, currency, {}, {}, onOpenBucket = onOpenTrendBucket)
                            V2TrendTable(palette, stats, metric, currency)
                        }
                        ChartQuotaPreviewSurface.TrendTable -> V2TrendTable(palette, stats, metric, currency)
                        ChartQuotaPreviewSurface.Sources -> V2SourceAnalysis(palette, stats, TokenDisplayMode.Effective, {}, emptyList(), {}, {}, {})
                        ChartQuotaPreviewSurface.OverviewTools -> V2ToolDistributionCard(palette, stats, TokenDisplayMode.Effective, {})
                        ChartQuotaPreviewSurface.Composition -> {
                            V2CompositionCard(palette, stats, TokenDisplayMode.All)
                            V2ToolDistributionCard(palette, stats, TokenDisplayMode.Effective, {})
                        }
                        ChartQuotaPreviewSurface.ModelRanking -> V2ModelDistributionCard(
                            palette, stats.models.values.toList(), stats.summary.effectiveTokens,
                            stats.summary.totalCost, null, {}, {}, if (metric == ReportMetricMode.Cost) ModelMetricMode.Cost else ModelMetricMode.Tokens
                        )
                        ChartQuotaPreviewSurface.Quota -> requireNotNull(quota).let { available ->
                            available.snapshot.providers.forEach { V2ProviderCard(palette, it, available, initiallyExpanded = details) }
                        }
                        ChartQuotaPreviewSurface.Controls -> V2ControlBoundsPreview(palette, controlState, onControlBounds)
                    }
                }
            }
        }
    }
}

@Composable
private fun V2ControlBoundsPreview(
    palette: MobileV2Palette,
    state: ChartQuotaControlState,
    onBounds: ((String, List<Int>) -> Unit)?
) {
    val minimumPx = with(LocalDensity.current) { 48.dp.toPx() }
    val measured = remember { mutableMapOf<String, List<Int>>() }
    val observe: (String, List<Int>) -> Unit = { key, bounds ->
        check(bounds[2] >= minimumPx - .01f && bounds[3] >= minimumPx - .01f) { "$key target below 48dp: $bounds" }
        val horizontalBounds = listOf(bounds[0], bounds[2], bounds[3])
        measured[key]?.let { check(it == horizontalBounds) { "$key relative x/width/height changed between states: $it -> $horizontalBounds" } }
        measured[key] = horizontalBounds
        onBounds?.invoke(key, bounds)
    }
    val index = state.ordinal
    Text(state.label, color = palette.text, fontSize = LedgerFont.label)
    V2MetricModeToggle(
        palette, if (index % 2 == 0) ReportMetricMode.Tokens else ReportMetricMode.Cost,
        onBounds = observe, enabled = index < 2, onChange = {}
    )
    V2CurrencyToggle(
        palette, if (index % 2 == 0) CurrencyUnit.CNY else CurrencyUnit.USD,
        onBounds = observe, enabled = index < 2, onChange = {}
    )
    V2InsightStrip(palette, InsightPane.entries[index], {}, enabled = index < 2, onBounds = observe)
    V2QuotaStateCard(
        palette, "额度", "云端投影时间未知", if (index == 3) "读取中…" else "重新读取",
        actionEnabled = index < 2, onAction = {}, onBounds = observe
    )
}

/**
 * Offline preview for the daily-costs table (`V2CalendarTable`). T10.136 removed that table
 * from the live calendar page, so this preview is now its only caller, kept for screenshot
 * baselines rather than mirroring anything users currently see.
 */
@Composable
internal fun V2DailyCostsPreviewContent(
    appearance: LedgerAppearance,
    stats: StatsData,
    query: DashboardQuery,
    masked: Boolean = false
) {
    val palette = remember(appearance) { v2Palette(appearance) }
    TokenLedgerTheme(appearance) {
        ProvideLedgerPalette(appearance) {
            CompositionLocalProvider(LocalCostMaskEnabled provides masked) {
                Column(Modifier.fillMaxSize().background(palette.background).padding(14.dp)) {
                    V2CalendarTable(palette, stats, query)
                }
            }
        }
    }
}
