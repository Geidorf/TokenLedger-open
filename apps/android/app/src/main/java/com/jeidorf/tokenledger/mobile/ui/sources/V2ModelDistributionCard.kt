package com.jeidorf.tokenledger.mobile.ui.sources

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.COST_UNAVAILABLE_SPOKEN
import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerMotion
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.ModelStat
import com.jeidorf.tokenledger.mobile.ProvideLedgerPalette
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenLedgerTheme
import com.jeidorf.tokenledger.mobile.VALUE_UNAVAILABLE
import com.jeidorf.tokenledger.mobile.formatInteger
import com.jeidorf.tokenledger.mobile.isKnownCost
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ledgerTween
import com.jeidorf.tokenledger.mobile.modelCostDistribution
import com.jeidorf.tokenledger.mobile.safeTokenAdd
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Share
import com.jeidorf.tokenledger.mobile.ui.trend.normalizedDataBarFraction
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import kotlin.math.max

internal enum class ModelMetricMode(val label: String) {
    Tokens("有效 Token"),
    Cost("费用")
}

@Composable
internal fun V2ModelDistributionCard(
    palette: MobileV2Palette,
    models: List<ModelStat>,
    summaryEffectiveTokens: Long,
    summaryTotalCost: Double,
    selectedToolName: String?,
    onResetTool: () -> Unit,
    onOpenModel: (String) -> Unit,
    initialMode: ModelMetricMode = ModelMetricMode.Tokens,
    onSwitchSource: (() -> Unit)? = null
) {
    var metricModeName by rememberSaveable { mutableStateOf(initialMode.name) }
    val metricMode = ModelMetricMode.entries.firstOrNull { it.name == metricModeName } ?: ModelMetricMode.Tokens
    val costMasked = LocalCostMaskEnabled.current
    val currency = LocalDashboardCurrency.current
    val context = LocalContext.current
    val tokenRows = remember(models) { models.sortedByDescending(ModelStat::effectiveTokens) }
    val costRows = remember(models, summaryTotalCost, costMasked) {
        modelCostDistribution(models, summaryTotalCost).let { rows -> if (costMasked) rows.sortedBy { it.model.name } else rows }
    }
    val maxTokens = tokenRows.maxOfOrNull(ModelStat::effectiveTokens) ?: 0L
    val totalModelTokens = summaryEffectiveTokens.coerceAtLeast(
        tokenRows.fold(0L) { total, model -> safeTokenAdd(total, model.effectiveTokens) }
    )
    val maxCost = costRows.mapNotNull { it.cost }.maxOrNull() ?: 0.0
    var showAll by rememberSaveable(metricModeName) { mutableStateOf(false) }
    val visibleCount = if (showAll) Int.MAX_VALUE else 8
    val motion = ledgerMotionEnabled(palette.isEInk)

    // 「查看全部 N 个模型」此前是整块高度硬跳；animateContentSize 让新增的行推着卡片长出来，
    // 用户看得见是自己那一下起的作用。墨水屏与关闭动画时时长为 0。
    V2Card(palette, modifier = Modifier.animateContentSize(ledgerTween(LedgerMotion.EMPHASIZED_MILLIS, motion))) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (onSwitchSource == null) "模型分布" else "模型来源 ⇄",
                color = palette.text,
                fontWeight = FontWeight.SemiBold,
                fontSize = LedgerFont.body,
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).then(
                    if (onSwitchSource != null) Modifier.clickable(role = Role.Button, onClickLabel = "切换为工具来源", onClick = onSwitchSource) else Modifier
                ).padding(vertical = 14.dp).semantics { heading() }
            )
            Row(
                Modifier.heightIn(min = 48.dp).clickable(role = Role.Button, onClickLabel = "切换模型排序指标") {
                    metricModeName = if (metricMode == ModelMetricMode.Tokens) ModelMetricMode.Cost.name else ModelMetricMode.Tokens.name
                },
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(if (metricMode == ModelMetricMode.Tokens) "有效 Token" else "预估费用", color = palette.blue, fontSize = LedgerFont.caption)
                Icon(Icons.Default.SwapHoriz, null, tint = palette.blue, modifier = Modifier.size(V2_ICON_INLINE))
            }
        }
        if (selectedToolName != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("当前工具：$selectedToolName", color = palette.muted, fontSize = LedgerFont.caption, modifier = Modifier.weight(1f))
                TextButton(onClick = onResetTool, modifier = Modifier.heightIn(min = 48.dp)) { Text("重置") }
            }
        }
        Spacer(Modifier.height(6.dp))
        when (metricMode) {
            ModelMetricMode.Tokens -> tokenRows.take(visibleCount).forEach { model ->
                val value = model.effectiveTokens
                val cacheNote = if (model.cached > 0L) "缓存另计 ${v2FormatTokens(model.cached)}" else "缓存另计 0"
                V2SourceRow(
                    palette = palette,
                    color = palette.violet,
                    label = model.name,
                    value = v2FormatTokens(value),
                    note = "${v2Share(value, max(totalModelTokens, 1L))} · $cacheNote · ${v2FormatNumber(model.requests)} 条记录",
                    barFraction = normalizedDataBarFraction(value, maxTokens),
                    onClick = { onOpenModel(model.name) },
                    accessibilityValue = "${formatInteger(value)} 有效 Token",
                    accessibilityNote = "${v2Share(value, max(totalModelTokens, 1L))}，缓存另计 ${formatInteger(model.cached)}，${formatInteger(model.requests)} 条记录"
                )
            }
            ModelMetricMode.Cost -> costRows.take(visibleCount).forEach { row ->
                // 费用读不到写「不可得」，读屏念「预估费用不可得」（T10.154 A12）。
                val costKnown = isKnownCost(row.cost)
                val costText = if (costKnown) v2FormatMoney(context, row.cost, costMasked, currency) else VALUE_UNAVAILABLE
                V2SourceRow(
                    palette = palette,
                    color = palette.violet,
                    label = row.model.name,
                    value = costText,
                    note = modelCostShareLabel(costMasked, row.costSharePercent),
                    barFraction = row.cost?.takeIf { !costMasked && maxCost > 0.0 }?.let { (it / maxCost).toFloat().coerceIn(0f, 1f) } ?: 0f,
                    onClick = { onOpenModel(row.model.name) },
                    accessibilityValue = if (costKnown) costText else COST_UNAVAILABLE_SPOKEN
                )
            }
        }
        if ((metricMode == ModelMetricMode.Tokens && tokenRows.isEmpty()) ||
            (metricMode == ModelMetricMode.Cost && costRows.isEmpty())
        ) {
            Text("当前范围没有模型数据。", color = palette.muted, fontSize = LedgerFont.caption)
        }
        val rowCount = if (metricMode == ModelMetricMode.Tokens) tokenRows.size else costRows.size
        if (rowCount > 8) {
            TextButton(
                onClick = { showAll = !showAll },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
            ) { Text(if (showAll) "收起" else "查看全部 $rowCount 个模型") }
        }
    }
}

@Composable
internal fun V2ModelDistributionPreviewContent(
    appearance: LedgerAppearance,
    stats: StatsData,
    showCost: Boolean,
    currency: CurrencyUnit = CurrencyUnit.CNY,
    costMasked: Boolean = false
) {
    val palette = remember(appearance) { v2Palette(appearance) }
    TokenLedgerTheme(appearance) {
        CompositionLocalProvider(LocalDashboardCurrency provides currency, LocalCostMaskEnabled provides costMasked) {
            ProvideLedgerPalette(appearance) {
                Box(Modifier.fillMaxSize().background(palette.background).padding(14.dp)) {
                    V2ModelDistributionCard(
                        palette = palette,
                        models = stats.models.values.toList(),
                        summaryEffectiveTokens = stats.summary.effectiveTokens,
                        summaryTotalCost = stats.summary.totalCost,
                        selectedToolName = null,
                        onResetTool = {},
                        onOpenModel = {},
                        initialMode = if (showCost) ModelMetricMode.Cost else ModelMetricMode.Tokens
                    )
                }
            }
        }
    }
}
