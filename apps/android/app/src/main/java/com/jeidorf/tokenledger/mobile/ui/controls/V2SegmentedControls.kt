package com.jeidorf.tokenledger.mobile.ui.controls

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selectableGroup
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.LedgerEasing
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerMotion
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.ReportMetricMode
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ledgerTween
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Segment
import com.jeidorf.tokenledger.mobile.ui.foundation.V2SegmentedToggle
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_TOUCH_TARGET
import com.jeidorf.tokenledger.mobile.ui.foundation.observeChoiceBounds
import com.jeidorf.tokenledger.mobile.ui.foundation.tokenModeToggle
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane

/**
 * 用量子页签（重构方案 v2）：对齐参考设计的下划线页签——一整行文字，选中项正文色加粗，
 * 下方一条 2dp 指示线滑到选中项，整行底部一条发丝分隔线。不再是带轨道的分段胶囊。
 *
 * 五项等分整行宽度、永远一行；每项至少 48dp 高，文字放不下时先换成两行，不截断。
 * 语义仍是一组单选（`selectableGroup` + 每项 `selected` / `stateDescription`），角色改为 [Role.Tab]，
 * 与底部导航一致；`onBounds` 仍按 `pane-<名称>` 上报每项的位置，供几何稳定性测试使用。
 */
@Composable
internal fun V2InsightStrip(
    palette: MobileV2Palette,
    selected: InsightPane,
    onSelect: (InsightPane) -> Unit,
    enabled: Boolean = true,
    onBounds: ((String, List<Int>) -> Unit)? = null
) {
    val tokens = palette.tokens
    val motion = ledgerMotionEnabled(tokens.isEInk)
    val panes = InsightPane.entries
    val selectedSlot = panes.indexOf(selected).coerceAtLeast(0)
    val indicatorSlot by animateFloatAsState(
        targetValue = selectedSlot.toFloat(),
        animationSpec = ledgerTween(LedgerMotion.INDICATOR_MILLIS, motion, easing = LedgerEasing.EaseOutExpo),
        label = "insightTabIndicator"
    )
    val divider = tokens.divider
    val indicator = tokens.text
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .semantics { selectableGroup() }
            .drawBehind {
                val line = LedgerStroke.hairline.toPx()
                drawRect(divider, topLeft = Offset(0f, size.height - line), size = Size(size.width, line))
                val slotWidth = size.width / panes.size
                val barWidth = minOf(INSIGHT_TAB_INDICATOR_WIDTH.toPx(), slotWidth)
                val barHeight = INSIGHT_TAB_INDICATOR_HEIGHT.toPx()
                drawRoundRect(
                    color = indicator,
                    topLeft = Offset(slotWidth * indicatorSlot + (slotWidth - barWidth) / 2f, size.height - barHeight),
                    size = Size(barWidth, barHeight),
                    cornerRadius = CornerRadius(barHeight / 2f)
                )
            }
    ) {
        panes.forEach { pane ->
            val active = pane == selected
            val content by animateColorAsState(
                targetValue = if (active) tokens.text else tokens.muted,
                animationSpec = ledgerTween(LedgerMotion.FAST_MILLIS, motion),
                label = "insightTabContent"
            )
            Box(
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = V2_TOUCH_TARGET)
                    .observeChoiceBounds("pane-${pane.label}", onBounds)
                    .clickable(enabled = enabled, role = Role.Tab) { onSelect(pane) }
                    .semantics {
                        this.selected = active
                        stateDescription = if (active) "已选择" else "未选择"
                    }
                    .padding(horizontal = LedgerSpace.xs, vertical = LedgerSpace.sm),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    pane.label,
                    color = content,
                    style = LedgerType.label,
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                    textAlign = TextAlign.Center,
                    maxLines = 2
                )
            }
        }
    }
}

/** 下划线指示器：宽度对齐两字页签的文字宽度，高 2dp。 */
private val INSIGHT_TAB_INDICATOR_WIDTH = 28.dp
private val INSIGHT_TAB_INDICATOR_HEIGHT = 2.dp

@Composable
internal fun V2MetricModeToggle(
    palette: MobileV2Palette,
    current: ReportMetricMode,
    onBounds: ((String, List<Int>) -> Unit)? = null,
    enabled: Boolean = true,
    onChange: (ReportMetricMode) -> Unit
) {
    V2SegmentedToggle(
        palette = palette,
        options = ReportMetricMode.entries.map { mode ->
            V2Segment(
                value = mode,
                label = mode.label,
                contentDescription = "${mode.label}视图",
                activeContent = palette.blue,
                activeContainer = palette.blueSoft
            )
        },
        selected = current,
        onSelect = onChange,
        // 宽度交给 V2SegmentedToggle 自己按最宽文案算；这里再写死就会截断文案。
        enabled = enabled,
        boundsKeyPrefix = "metric",
        onBounds = onBounds
    )
}

@Composable
internal fun V2CurrencyToggle(
    palette: MobileV2Palette,
    current: CurrencyUnit,
    onBounds: ((String, List<Int>) -> Unit)? = null,
    enabled: Boolean = true,
    onChange: (CurrencyUnit) -> Unit
) {
    V2SegmentedToggle(
        palette = palette,
        options = CurrencyUnit.entries.map { unit ->
            V2Segment(
                value = unit,
                label = unit.symbol,
                contentDescription = "${unit.label}币种",
                activeContent = palette.blue,
                activeContainer = palette.blueSoft
            )
        },
        selected = current,
        onSelect = onChange,
        // 触达下限已经是控件自己的兜底，这里不必也不该再写死。
        enabled = enabled,
        boundsKeyPrefix = "currency",
        onBounds = onBounds
    )
}

@Composable
internal fun V2TokenModeToggle(
    palette: MobileV2Palette,
    current: TokenDisplayMode,
    onChange: (TokenDisplayMode) -> Unit
) {
    androidx.compose.foundation.layout.Row(
        Modifier.heightIn(min = 48.dp).tokenModeToggle(current, onChange),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text("${current.label} Token", color = palette.blue, fontSize = LedgerFont.body)
        Icon(Icons.Default.SwapHoriz, null, tint = palette.blue, modifier = Modifier.size(V2_ICON_INLINE))
    }
}
