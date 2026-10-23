package com.jeidorf.tokenledger.mobile.ui.hero

import androidx.compose.foundation.background
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.ShowChart
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.ArrowDropUp
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Icon
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
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.LocalToggleCostMask
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.costMaskAccessibilityDescription
import com.jeidorf.tokenledger.mobile.costMaskActionLabel
import com.jeidorf.tokenledger.mobile.costMaskStateDescription
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.shouldStackDashboardHeroValues
import com.jeidorf.tokenledger.mobile.ui.charts.V2TrendChart
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSize
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_TEXT
import com.jeidorf.tokenledger.mobile.ui.foundation.nextTokenDisplayMode
import com.jeidorf.tokenledger.mobile.ui.foundation.tokenModeToggle
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane
import com.jeidorf.tokenledger.mobile.ui.navigation.TodayReviewAction
import com.jeidorf.tokenledger.mobile.v2FormatTokens

/**
 * 用量概览主区（重构方案 v2，对齐参考设计）：一句变化说明 → 一张分格汇总卡 → 一张每日走势卡。
 *
 * 汇总卡上半是 Token 与预估费用两格（窄屏或大字时上下排），下半是活跃、缓存复用率、记录数三格，
 * 格间只用发丝线分隔，不再有品牌光晕与盒中盒。主数字仍是唯一的 Token 口径切换入口，
 * 费用格仍是费用隐身开关；走势卡底部保留「查看趋势」行动行。
 */
@Composable
internal fun V2HeroCard(
    palette: MobileV2Palette,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit,
    onOpenInsights: (InsightPane) -> Unit
) {
    val summary = stats.summary
    val comparison = stats.comparison
    val tokenCapsule = heroChangeCapsule(comparison, comparison?.delta?.tokens)
    val costCapsule = heroChangeCapsule(comparison, comparison?.delta?.cost)
    val displayedTokens = displayedTokenCount(tokenDisplayMode, summary.effectiveTokens, summary.cachedTokens)
    val stackValues = shouldStackDashboardHeroValues(LocalDensity.current.fontScale, LocalConfiguration.current.screenWidthDp)
    val baseline = heroBaselineCaption(comparison)
    val subline = heroTokenSubline(summary, tokenDisplayMode)
    val peak = todayPeakLabel(stats)
    val actionLabel = todayTrendActionLabel(peak)
    val metricSlots = todayMetricStrip(stats)
    Column(verticalArrangement = Arrangement.spacedBy(LedgerSpace.md)) {
        HeroChangeLine(palette, tokenCapsule, baseline)
        V2Card(palette, contentPadding = PaddingValues(0.dp)) {
            val tokenCell: @Composable (Modifier) -> Unit = { modifier ->
                Column(modifier.padding(LedgerSpace.lg), verticalArrangement = Arrangement.spacedBy(LedgerSpace.xs)) {
                    Text("${tokenDisplayMode.label} Token", color = palette.muted, style = LedgerType.caption)
                    V2HeroTokenValueRow(
                        palette = palette,
                        displayedTokens = displayedTokens,
                        tokenDisplayMode = tokenDisplayMode,
                        onTokenDisplayModeChange = onTokenDisplayModeChange
                    )
                    Text(subline, color = palette.faint, style = LedgerType.meta)
                }
            }
            val costCell: @Composable (Modifier) -> Unit = { modifier ->
                Box(modifier.padding(LedgerSpace.lg)) {
                    V2HeroCostToggle(
                        palette,
                        summary.totalCost,
                        stacked = true,
                        costCapsule = costCapsule,
                        horizontalAlignment = Alignment.Start
                    )
                }
            }
            if (stackValues) {
                tokenCell(Modifier.fillMaxWidth())
                HeroGridRule(palette)
                costCell(Modifier.fillMaxWidth())
            } else {
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                    tokenCell(Modifier.weight(1f))
                    Box(Modifier.fillMaxHeight().width(LedgerStroke.hairline).background(palette.divider))
                    costCell(Modifier.weight(1f))
                }
            }
            HeroGridRule(palette)
            Box(Modifier.padding(horizontal = LedgerSpace.sm, vertical = LedgerSpace.xs)) {
                TodayMetricStrip(palette, metricSlots, stacked = stackValues)
            }
        }
        V2Card(palette, contentPadding = PaddingValues(start = LedgerSpace.md, end = LedgerSpace.md, top = LedgerSpace.md, bottom = LedgerSpace.xs)) {
            Text("每日 Token", color = palette.muted, style = LedgerType.caption)
            Spacer(Modifier.height(LedgerSpace.sm))
            V2TrendChart(
                palette = palette,
                comparison = stats.comparison,
                fallback = stats.trends,
                modifier = Modifier.fillMaxWidth().height(108.dp),
                compact = true
            )
            TodayTrendActionRow(palette, actionLabel) {
                onOpenInsights(TodayReviewAction.ExplainChange.targetPane!!)
            }
        }
    }
}

/** 汇总卡格间的横向发丝线。 */
@Composable
private fun HeroGridRule(palette: MobileV2Palette) {
    Box(Modifier.fillMaxWidth().height(LedgerStroke.hairline).background(palette.divider))
}

/** 卡片上方的一行变化说明：基线名 + 不带颜色的变化胶囊；无基线时只写「无自动基线」等说法。 */
@Composable
private fun HeroChangeLine(palette: MobileV2Palette, capsule: HeroChangeCapsule, baseline: String?) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LedgerSpace.sm)
    ) {
        if (baseline != null) {
            Text(baseline, color = palette.muted, style = LedgerType.meta)
        }
        HeroChangeCapsuleView(palette, capsule)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun V2HeroTokenValueRow(
    palette: MobileV2Palette,
    displayedTokens: Long,
    tokenDisplayMode: TokenDisplayMode,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit,
    modifier: Modifier = Modifier
) {
    val formattedTokens = v2FormatTokens(displayedTokens)
    val nextMode = nextTokenDisplayMode(tokenDisplayMode)
    FlowRow(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(LedgerRadius.sm))
            .tokenModeToggle(
                current = tokenDisplayMode,
                onChange = onTokenDisplayModeChange,
                displayedValue = formattedTokens
            ),
        horizontalArrangement = Arrangement.spacedBy(LedgerSpace.sm),
        verticalArrangement = Arrangement.spacedBy(LedgerSpace.xs)
    ) {
        Text(
            formattedTokens,
            color = palette.text,
            style = LedgerType.numL,
            maxLines = 1,
            softWrap = false,
            modifier = Modifier.align(Alignment.CenterVertically)
        )
        Row(
            modifier = Modifier
                .align(Alignment.CenterVertically)
                .heightIn(min = 24.dp)
                .clip(RoundedCornerShape(LedgerRadius.sm))
                .background(palette.raised)
                .padding(horizontal = LedgerSpace.sm),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(tokenDisplayMode.label, color = palette.text, style = LedgerType.labelS, fontWeight = FontWeight.SemiBold)
            Text(" ⇄ ", color = palette.faint, style = LedgerType.labelS)
            Text(nextMode.label, color = palette.faint, style = LedgerType.labelS)
        }
    }
}

@Composable
internal fun V2HeroCostToggle(
    palette: MobileV2Palette,
    totalCost: Double,
    stacked: Boolean,
    costCapsule: HeroChangeCapsule? = null,
    horizontalAlignment: Alignment.Horizontal = Alignment.End
) {
    val context = LocalContext.current
    val isCostMasked = LocalCostMaskEnabled.current
    val onToggleCostMask = LocalToggleCostMask.current
    val currency = LocalDashboardCurrency.current
    val modifier = Modifier
        .heightIn(min = 48.dp)
        .then(if (stacked) Modifier.fillMaxWidth() else Modifier.widthIn(min = 48.dp))
        .clip(RoundedCornerShape(LedgerRadius.sm))
        .toggleable(
            value = isCostMasked,
            role = Role.Switch,
            onValueChange = { onToggleCostMask() }
        )
        .semantics {
            contentDescription = costMaskAccessibilityDescription(isCostMasked)
            stateDescription = costMaskStateDescription(isCostMasked)
            onClick(costMaskActionLabel(isCostMasked), null)
        }
        .padding(horizontal = LedgerSpace.xs, vertical = LedgerSpace.hairline)
    Column(modifier = modifier, horizontalAlignment = horizontalAlignment) {
        V2HeroCostLabel(palette, isCostMasked)
        Text(
            v2FormatMoney(context, totalCost, isCostMasked, currency),
            color = palette.text,
            style = LedgerType.numM,
            maxLines = 1,
            softWrap = false
        )
        if (costCapsule != null && costCapsule.kind != HeroBaselineKind.NoAuto && costCapsule.kind != HeroBaselineKind.Missing) {
            HeroChangeCapsuleView(palette, costCapsule)
        }
    }
}

@Composable
internal fun V2HeroCostLabel(palette: MobileV2Palette, isCostMasked: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("预估费用", color = palette.muted, style = LedgerType.caption)
        Spacer(Modifier.width(LedgerSpace.xs))
        Icon(
            if (isCostMasked) Icons.Default.VisibilityOff else Icons.Default.Visibility,
            contentDescription = null,
            tint = palette.muted,
            modifier = Modifier.size(V2_ICON_TEXT)
        )
    }
}

@Composable
private fun HeroChangeCapsuleView(palette: MobileV2Palette, capsule: HeroChangeCapsule) {
    Row(
        // 最小高度而非固定高度：200% 字号下数字比 22dp 高，固定高度会把字上下裁掉（视觉审查 A1）。
        modifier = Modifier
            .heightIn(min = 22.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(palette.raised)
            .padding(horizontal = LedgerSpace.sm),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (capsule.arrowUp != null) {
            Icon(
                if (capsule.arrowUp) Icons.Filled.ArrowDropUp else Icons.Filled.ArrowDropDown,
                contentDescription = null,
                tint = palette.muted,
                modifier = Modifier.size(V2_ICON_TEXT)
            )
        }
        Text(capsule.text, color = palette.muted, style = LedgerType.labelS, maxLines = 1, softWrap = false)
    }
}

/**
 * 横排始终三格等宽，空槽不把旁边的格子拉宽（0–3 格不跳版）。
 * 纵排（窄屏或大字）只画出有数的格，避免空白行，每格仍是同一套「标签左、数值右」。
 */
@Composable
private fun TodayMetricStrip(
    palette: MobileV2Palette,
    slots: List<TodaySecondaryMetric?>,
    stacked: Boolean
) {
    if (stacked) {
        Column(Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            slots.filterNotNull().forEach { metric ->
                V2MiniMetric(
                    label = metric.label,
                    value = metric.value,
                    palette = palette,
                    modifier = Modifier.fillMaxWidth(),
                    stacked = true,
                    note = metric.note
                )
            }
        }
    } else {
        // 顶对齐：没有第二行说明的格（如活跃时段）不再整体下沉，三格标签同一基线（视觉审查 A10）。
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp),
            verticalAlignment = Alignment.Top
        ) {
            slots.forEachIndexed { index, metric ->
                if (index > 0) V2MetricDivider(palette)
                if (metric == null) {
                    Spacer(Modifier.weight(1f))
                } else {
                    V2MiniMetric(
                        label = metric.label,
                        value = metric.value,
                        palette = palette,
                        modifier = Modifier.weight(1f),
                        note = metric.note
                    )
                }
            }
        }
    }
}

@Composable
private fun TodayTrendActionRow(palette: MobileV2Palette, label: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(LedgerRadius.md))
            .clickable(role = Role.Button, onClickLabel = "查看趋势", onClick = onClick)
            .semantics { contentDescription = "$label。双击查看趋势" },
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            Icons.AutoMirrored.Filled.ShowChart,
            contentDescription = null,
            tint = palette.blue,
            modifier = Modifier.size(LedgerSize.iconInline)
        )
        Spacer(Modifier.width(LedgerSpace.sm))
        Text(label, color = palette.blue, style = LedgerType.label, modifier = Modifier.weight(1f))
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = palette.blue,
            modifier = Modifier.size(LedgerSize.iconText)
        )
    }
}
