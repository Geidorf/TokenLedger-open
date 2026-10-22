package com.jeidorf.tokenledger.mobile.ui.hero

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSize
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2FittedValueText
import com.jeidorf.tokenledger.mobile.ui.foundation.v2CacheHit
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Share
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens

/**
 * 次级指标格（§4.5）：`caption` 标签 → `numS` 数值 → 可选 `meta` 副行。标签贴数值只隔 2dp 半格。
 * [stacked] 是纵排模式（§6.2）：「标签在左 · 数值在右」一行，标签可换行、数值不换行。
 * 数值放不下时逐档缩小（[V2FittedValueText]）：展示页三等分的格子在 200% 字体下曾把「¥132.46」
 * 裁成「¥132.4」（T10.177 评审 E-2，root 决定 R-19）。
 * [note] 为空时不占行，既有调用点的高度不变。
 */
@Composable
internal fun V2MiniMetric(
    label: String,
    value: String,
    palette: MobileV2Palette,
    modifier: Modifier = Modifier,
    stacked: Boolean = false,
    note: String = ""
) {
    if (stacked) {
        Column(modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = LedgerSpace.sm, horizontal = LedgerSpace.sm),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    label,
                    modifier = Modifier.weight(1f),
                    style = LedgerType.caption,
                    color = palette.muted,
                    maxLines = 2
                )
                Spacer(Modifier.width(LedgerSpace.md))
                V2FittedValueText(value, style = LedgerType.numS, color = palette.text)
            }
            if (note.isNotEmpty()) {
                Text(
                    note,
                    modifier = Modifier.padding(horizontal = LedgerSpace.sm),
                    style = LedgerType.meta,
                    color = palette.faint,
                    maxLines = 2
                )
            }
        }
    } else {
        Column(
            modifier.padding(vertical = LedgerSpace.sm, horizontal = LedgerSpace.sm),
            verticalArrangement = Arrangement.spacedBy(LedgerSpace.hairline)
        ) {
            Text(label, style = LedgerType.caption, color = palette.muted)
            V2FittedValueText(value, style = LedgerType.numS, color = palette.text)
            if (note.isNotEmpty()) {
                Text(note, style = LedgerType.meta, color = palette.faint, maxLines = 2)
            }
        }
    }
}

/** 指标格之间的 1dp 竖向装饰线（§4.5 格间 `divider`，无外框）。 */
@Composable
internal fun V2MetricDivider(palette: MobileV2Palette) {
    Box(Modifier.width(LedgerStroke.hairline).height(32.dp).background(palette.divider))
}

@Composable
internal fun V2KpiGrid(
    palette: MobileV2Palette,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    wide: Boolean
) {
    val summary = stats.summary
    val displayedTokens = displayedTokenCount(tokenDisplayMode, summary.effectiveTokens, summary.cachedTokens)
    val denominatorLabel = tokenDisplayMode.label
    val safeDisplayed = displayedTokens.coerceAtLeast(1L).toFloat()
    val safeAll = (summary.effectiveTokens + summary.cachedTokens).coerceAtLeast(1L).toFloat()
    val values = listOf(
        V2KpiSpec(
            "输入 Tokens",
            v2FormatTokens(summary.inputTokens),
            "占$denominatorLabel ${v2Share(summary.inputTokens, displayedTokens)}",
            palette.blue,
            if (displayedTokens > 0L) (summary.inputTokens.toFloat() / safeDisplayed).coerceIn(0f, 1f) else 0f
        ),
        V2KpiSpec(
            "输出 Tokens",
            v2FormatTokens(summary.outputTokens),
            "占$denominatorLabel ${v2Share(summary.outputTokens, displayedTokens)}",
            palette.green,
            if (displayedTokens > 0L) (summary.outputTokens.toFloat() / safeDisplayed).coerceIn(0f, 1f) else 0f
        ),
        V2KpiSpec(
            "缓存 Tokens",
            v2FormatTokens(summary.cachedTokens),
            if (tokenDisplayMode == TokenDisplayMode.All) "占全部 ${v2Share(summary.cachedTokens, displayedTokens)}" else "${v2CacheHit(summary)} 命中",
            palette.amber,
            if (tokenDisplayMode == TokenDisplayMode.All) (summary.cachedTokens.toFloat() / safeDisplayed).coerceIn(0f, 1f)
            else (summary.cachedTokens.toFloat() / safeAll).coerceIn(0f, 1f)
        ),
        V2KpiSpec("活跃模型", v2FormatNumber(stats.models.size.toLong()), "${stats.tools.size} 个工具在用", palette.violet)
    )
    if (LocalDensity.current.fontScale >= 1.5f) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            values.forEach { spec -> V2KpiCard(palette, spec, Modifier.fillMaxWidth()) }
        }
    } else if (wide) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
            values.forEach { spec -> V2KpiCard(palette, spec, Modifier.weight(1f)) }
        }
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            values.chunked(2).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                    row.forEach { spec -> V2KpiCard(palette, spec, Modifier.weight(1f)) }
                }
            }
        }
    }
}

internal data class V2KpiSpec(
    val label: String,
    val value: String,
    val note: String,
    val color: Color,
    val fraction: Float? = null
)

/**
 * KPI 格（§4.5）：8dp 身份点 + `caption` 标签 → `numM` 数值 → `meta` `faint` 副行 + 可选底部微缩占比条。
 * 不再有彩色左边条与副行底块（D5「盒中盒」）；数据参数（哪几格、什么颜色）A0 之后归 A5。
 * 两列布局要到 1.5 倍字体才改堆叠，320dp、1.3 倍时 7 位以上的金额会放不下，数值因此同样逐档缩小（评审 P3-14）。
 */
@Composable
internal fun V2KpiCard(palette: MobileV2Palette, spec: V2KpiSpec, modifier: Modifier = Modifier) {
    V2Card(palette, modifier = modifier) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LedgerSpace.sm)
        ) {
            Box(Modifier.size(LedgerSize.identityDot).clip(CircleShape).background(spec.color))
            Text(spec.label, style = LedgerType.caption, color = palette.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(LedgerSpace.sm))
        V2FittedValueText(spec.value, style = LedgerType.numM, color = palette.text)
        Spacer(Modifier.height(LedgerSpace.xs))
        Text(spec.note, style = LedgerType.meta, color = palette.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (!palette.isEInk && spec.fraction != null) {
            Spacer(Modifier.height(LedgerSpace.sm))
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(LedgerSpace.xs)
                    .clip(CircleShape)
                    .background(palette.surfaceContainerHigh)
            ) {
                Box(
                    Modifier
                        .fillMaxWidth(spec.fraction.coerceIn(0.04f, 1f))
                        .height(LedgerSpace.xs)
                        .clip(CircleShape)
                        .background(spec.color)
                )
            }
        }
    }
}
