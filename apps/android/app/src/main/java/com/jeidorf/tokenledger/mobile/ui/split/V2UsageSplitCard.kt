package com.jeidorf.tokenledger.mobile.ui.split

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.VALUE_UNAVAILABLE
import com.jeidorf.tokenledger.mobile.formatSharePercent
import com.jeidorf.tokenledger.mobile.stableToolColorIndex
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Segment
import com.jeidorf.tokenledger.mobile.ui.foundation.V2SegmentedToggle
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE
import com.jeidorf.tokenledger.mobile.ui.foundation.v2DataBarBackground
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney
import com.jeidorf.tokenledger.mobile.ui.sources.V2SourceTile
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens

private const val SPLIT_COLLAPSED_ROWS = 8

/**
 * 用量拆分（对齐桌面「用量 › 概览 › 用量拆分」）：同一份云端统计按 Agent、模型、设备或账号拆，
 * 指标在 Token、记录数与预估费用之间切换。Agent 与模型行点开专属看板；设备行只读；
 * 账号维度云端没有数据，整卡写明原因而不是显示空列表。
 */
@Composable
internal fun V2UsageSplitCard(
    palette: MobileV2Palette,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    machineFiltered: Boolean,
    onOpenTool: (String) -> Unit,
    onOpenModel: (String) -> Unit,
    initialDimension: SplitDimension = SplitDimension.Agent,
    initialMetric: SplitMetric = SplitMetric.Tokens
) {
    var dimension by rememberSaveable { mutableStateOf(initialDimension) }
    var metric by rememberSaveable { mutableStateOf(initialMetric) }
    var expanded by rememberSaveable(dimension) { mutableStateOf(false) }
    val masked = LocalCostMaskEnabled.current
    val currency = LocalDashboardCurrency.current
    val context = LocalContext.current
    val result = splitUsage(stats, dimension, metric, tokenDisplayMode, machineFiltered)
    val hideCost = metric == SplitMetric.Cost && masked

    fun format(metricValue: Double?, target: SplitMetric): String = when {
        metricValue == null -> VALUE_UNAVAILABLE
        target == SplitMetric.Tokens -> v2FormatTokens(metricValue.toLong())
        target == SplitMetric.Requests -> "${v2FormatNumber(metricValue.toLong())} 条"
        else -> v2FormatMoney(context, metricValue, masked, currency)
    }

    V2Card(palette) {
        Text("用量拆分", color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(LedgerSpace.sm))
        V2SegmentedToggle(
            palette = palette,
            options = SplitDimension.entries.map { V2Segment(it, it.label, contentDescription = "按${it.label}拆分") },
            selected = dimension,
            onSelect = { dimension = it },
            boundsKeyPrefix = "split-dimension"
        )
        Spacer(Modifier.height(LedgerSpace.sm))
        V2SegmentedToggle(
            palette = palette,
            options = SplitMetric.entries.map {
                V2Segment(it, it.label, contentDescription = "按${it.label}排序", activeContent = palette.blue, activeContainer = palette.blueSoft)
            },
            selected = metric,
            onSelect = { metric = it },
            boundsKeyPrefix = "split-metric"
        )
        when (result) {
            is SplitResult.Unavailable -> Text(
                result.reason,
                color = palette.muted,
                fontSize = LedgerFont.label,
                modifier = Modifier.padding(vertical = LedgerSpace.lg)
            )
            is SplitResult.Available -> {
                val rows = if (hideCost) result.rows.sortedBy { it.name } else result.rows
                Row(Modifier.fillMaxWidth().padding(top = LedgerSpace.md), verticalAlignment = Alignment.Bottom) {
                    Text(
                        format(result.total.takeIf { rows.isNotEmpty() }, metric),
                        color = palette.text,
                        fontSize = LedgerFont.displaySmall,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f)
                    )
                }
                Text(
                    buildString {
                        append("${rows.size} 个${dimension.label}")
                        if (result.unknownCount > 0) append(" · ${result.unknownCount} 项${metric.label}不可得")
                        append(if (hideCost) " · 费用已隐藏 · 按名称列出" else " · 按${metric.label}排序")
                    },
                    color = palette.muted,
                    fontSize = LedgerFont.caption,
                    modifier = Modifier.padding(vertical = LedgerSpace.sm)
                )
                HorizontalDivider(color = palette.divider)
                val maximum = rows.maxOfOrNull { it.value(metric) ?: 0.0 } ?: 0.0
                rows.take(if (expanded) Int.MAX_VALUE else SPLIT_COLLAPSED_ROWS).forEach { row ->
                    val value = row.value(metric)
                    val share = result.sharePercent(row, metric)
                    val secondary = if (metric == SplitMetric.Tokens) {
                        "${v2FormatNumber(row.requests)} 条记录"
                    } else {
                        "${row.tokens?.let(::v2FormatTokens) ?: VALUE_UNAVAILABLE} Token"
                    }
                    V2SplitRow(
                        palette = palette,
                        color = splitColor(palette, dimension, row.name),
                        label = row.name,
                        value = format(value, metric),
                        note = listOfNotNull(
                            if (hideCost) null else share?.let(::formatSharePercent),
                            secondary
                        ).joinToString(" · "),
                        barFraction = if (hideCost || maximum <= 0.0 || value == null) 0f else (value / maximum).toFloat(),
                        onClick = when (dimension) {
                            SplitDimension.Agent -> ({ onOpenTool(row.name) })
                            SplitDimension.Model -> ({ onOpenModel(row.name) })
                            SplitDimension.Device, SplitDimension.Account -> null
                        }
                    )
                }
                if (rows.isEmpty()) {
                    Text("当前范围没有数据", color = palette.muted, fontSize = LedgerFont.label, modifier = Modifier.padding(vertical = LedgerSpace.lg))
                }
                if (rows.size > SPLIT_COLLAPSED_ROWS) {
                    TextButton(onClick = { expanded = !expanded }, modifier = Modifier.fillMaxWidth()) {
                        Text(if (expanded) "收起" else "查看全部 ${rows.size} 项")
                    }
                }
            }
        }
    }
}

private fun splitColor(palette: MobileV2Palette, dimension: SplitDimension, name: String): Color = when (dimension) {
    SplitDimension.Agent -> listOf(palette.blue, palette.green, palette.amber, palette.violet)[stableToolColorIndex(name)]
    SplitDimension.Model -> palette.violet
    SplitDimension.Device, SplitDimension.Account -> palette.green
}

/** 拆分行：身份块 + 名称与占比 + 右侧数值，底部数据条；[onClick] 为 null 时只读。 */
@Composable
private fun V2SplitRow(
    palette: MobileV2Palette,
    color: Color,
    label: String,
    value: String,
    note: String,
    barFraction: Float,
    onClick: (() -> Unit)?
) {
    val clickModifier = if (onClick != null) {
        Modifier.clickable(role = Role.Button, onClickLabel = "打开 $label 专属看板", onClick = onClick)
    } else {
        Modifier
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .v2DataBarBackground(palette, color, barFraction)
            .then(clickModifier)
            .semantics(mergeDescendants = true) { contentDescription = "$label，$value，$note" }
            .padding(start = 4.dp, end = 4.dp, top = 8.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        V2SourceTile(palette, label, color)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, color = palette.text, fontSize = LedgerFont.label, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(note, color = palette.faint, fontSize = LedgerFont.caption, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(8.dp))
        Text(value, color = palette.text, fontSize = LedgerFont.label, fontWeight = FontWeight.SemiBold)
        if (onClick != null) {
            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = palette.faint, modifier = Modifier.size(V2_ICON_INLINE))
        }
    }
}
