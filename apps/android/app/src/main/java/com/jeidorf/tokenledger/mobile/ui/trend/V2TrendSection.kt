package com.jeidorf.tokenledger.mobile.ui.trend

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalToggleCostMask
import com.jeidorf.tokenledger.mobile.ReportMetricMode
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.costMaskActionLabel
import com.jeidorf.tokenledger.mobile.costMaskStateDescription
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.isLandscapeOrCompactHeight
import com.jeidorf.tokenledger.mobile.metricSeriesValues
import com.jeidorf.tokenledger.mobile.trendAvailabilityMessage
import com.jeidorf.tokenledger.mobile.ui.charts.V2LineLegend
import com.jeidorf.tokenledger.mobile.ui.charts.V2TrendChart
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_ACTION
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_TOUCH_TARGET
import com.jeidorf.tokenledger.mobile.ui.foundation.tokenModeToggle
import com.jeidorf.tokenledger.mobile.ui.foundation.v2ComparisonLabel
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatPercent
import com.jeidorf.tokenledger.mobile.ui.foundation.v2SignedNumber
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane
import com.jeidorf.tokenledger.mobile.v2FormatTokens

@Composable
@OptIn(ExperimentalLayoutApi::class)
internal fun V2TrendInsightCard(
    palette: MobileV2Palette,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit,
    metricMode: ReportMetricMode,
    currency: CurrencyUnit,
    onMetricChange: (ReportMetricMode) -> Unit,
    onCurrencyChange: (CurrencyUnit) -> Unit,
    controlsEnabled: Boolean = true,
    includeDetails: Boolean = false,
    onOpenBucket: ((String, InsightPane) -> Unit)? = null
) {
    val context = LocalContext.current
    val isCostMasked = LocalCostMaskEnabled.current
    val displayedTokens = displayedTokenCount(tokenDisplayMode, stats.summary.effectiveTokens, stats.summary.cachedTokens)
    val comparison = stats.comparison
    val delta = if (metricMode == ReportMetricMode.Tokens) comparison?.delta?.tokens else comparison?.delta?.cost

    V2Card(palette) {
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).heightIn(min = 48.dp).clickable(
                enabled = controlsEnabled, role = Role.Button, onClickLabel = "切换趋势指标"
            ) { onMetricChange(if (metricMode == ReportMetricMode.Tokens) ReportMetricMode.Cost else ReportMetricMode.Tokens) },
                verticalAlignment = Alignment.CenterVertically) {
                Text(if (metricMode == ReportMetricMode.Tokens) "${tokenDisplayMode.label} Token" else "预估费用", color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.width(6.dp))
                Icon(Icons.Default.SwapHoriz, contentDescription = null, tint = palette.muted, modifier = Modifier.size(V2_ICON_INLINE))
            }
            if (metricMode == ReportMetricMode.Cost) {
                val toggleMask = LocalToggleCostMask.current
                IconButton(onClick = toggleMask, modifier = Modifier.size(V2_TOUCH_TARGET).semantics { stateDescription = costMaskStateDescription(isCostMasked) }) {
                    Icon(if (isCostMasked) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                        contentDescription = costMaskActionLabel(isCostMasked), tint = palette.muted, modifier = Modifier.size(V2_ICON_ACTION))
                }
            }
        }
        if (metricMode == ReportMetricMode.Tokens && tokenDisplayMode == TokenDisplayMode.All) {
            Text("含缓存 Token · 曲线仍按有效 Token", color = palette.faint, fontSize = LedgerFont.caption)
        }
        Spacer(Modifier.height(4.dp))
        val formattedTokens = v2FormatTokens(displayedTokens)
        val formattedCost = v2FormatMoney(context, stats.summary.totalCost, isCostMasked, currency)
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            Column(
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .then(
                        if (metricMode == ReportMetricMode.Tokens) {
                            Modifier.tokenModeToggle(
                                current = tokenDisplayMode,
                                onChange = onTokenDisplayModeChange,
                                displayedValue = formattedTokens
                            )
                        } else {
                            Modifier.clickable(
                                role = Role.Button,
                                onClickLabel = "切换币种为${if (currency == CurrencyUnit.CNY) "美元" else "人民币"}"
                            ) {
                                onCurrencyChange(if (currency == CurrencyUnit.CNY) CurrencyUnit.USD else CurrencyUnit.CNY)
                            }.semantics {
                                contentDescription = "当前预估费用 $formattedCost，点击切换币种"
                            }
                        }
                    )
            ) {
                if (metricMode == ReportMetricMode.Tokens) {
                    Text(formattedTokens, color = palette.text, fontSize = LedgerFont.displaySmall, fontWeight = FontWeight.SemiBold)
                } else {
                    Text(formattedCost, color = palette.text, fontSize = LedgerFont.displaySmall, fontWeight = FontWeight.SemiBold)
                }
            }
            Text(
                v2FormatPercent(delta?.percent),
                color = if ((delta?.absolute ?: 0.0) >= 0) palette.amber else palette.green,
                fontSize = LedgerFont.label,
                fontWeight = FontWeight.SemiBold
            )
        }
        Text(v2ComparisonLabel(comparison) + (comparison?.delta?.requests?.let {
            " · 记录数 ${v2SignedNumber(it.absolute)}"
        } ?: ""), color = palette.muted, fontSize = LedgerFont.caption,
            modifier = Modifier.padding(vertical = 6.dp))
        val isCompactHeight = isLandscapeOrCompactHeight(LocalConfiguration.current.screenHeightDp)
        V2TrendChart(
            palette = palette,
            comparison = stats.comparison,
            fallback = stats.trends,
            modifier = Modifier.fillMaxWidth().height(if (isCompactHeight) 120.dp else 170.dp),
            compact = false,
            metricMode = metricMode,
            isCostMasked = isCostMasked,
            currency = currency,
            interactive = true,
            honestEmptyState = true,
            onOpenBucket = onOpenBucket
        )
        val series = metricSeriesValues(stats.comparison, stats.trends, metricMode)
        if (series.first.isNotEmpty()) {
            trendAvailabilityMessage(stats.comparison, stats.trends, metricMode)?.let {
                Text(it, color = palette.muted, fontSize = LedgerFont.label)
            }
            if (LocalDensity.current.fontScale >= 1.5f || LocalConfiguration.current.screenWidthDp < 360) {
                val periods = listOf("本期" to stats.comparison?.current?.series.orEmpty(), "上期" to stats.comparison?.previous?.series.orEmpty())
                periods.filter { it.second.isNotEmpty() }.forEach { (name, points) ->
                    Text("$name ${points.first().bucket} → ${points.last().bucket}", color = palette.muted, fontSize = LedgerFont.caption)
                }
                if (stats.comparison == null && stats.trends.isNotEmpty()) {
                    Text("本期 ${stats.trends.first().date} → ${stats.trends.last().date}", color = palette.muted, fontSize = LedgerFont.caption)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), modifier = Modifier.padding(top = 6.dp)) {
            val activeColor = if (metricMode == ReportMetricMode.Cost && !palette.isEInk) palette.amber else palette.blue
            V2LineLegend(activeColor, false, "本期", palette)
            V2LineLegend(palette.muted, true, "上期", palette)
        }
        if (includeDetails) {
            HorizontalDivider(color = palette.divider, modifier = Modifier.padding(top = 12.dp))
            V2TrendTable(palette, stats, metricMode, currency, collapsible = true, embedded = true)
        }
    }
}
