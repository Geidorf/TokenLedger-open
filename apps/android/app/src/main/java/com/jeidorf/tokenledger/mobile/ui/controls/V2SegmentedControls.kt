package com.jeidorf.tokenledger.mobile.ui.controls

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.ReportMetricMode
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Segment
import com.jeidorf.tokenledger.mobile.ui.foundation.V2SegmentedToggle
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE
import com.jeidorf.tokenledger.mobile.ui.foundation.tokenModeToggle
import com.jeidorf.tokenledger.mobile.ui.foundation.v2SegmentedToggleWidth
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane

/**
 * 复盘页签（§4.3）：等分宽度，永远一行，不再按 `maxWidth`/字体倍率折成 2×2 网格（T10.208 去掉）。
 *
 * `BoxWithConstraints` 只用来判断「这条可用宽度是否放得下 [V2SegmentedToggle] 自己算出的最小安全宽度
 * （[v2SegmentedToggleWidth]，与它内部 `widthIn(min = …)` 用的是同一份公式）」，不是旧版那种按
 * 断点二选一列数的响应式布局：
 * - 放得下（今天 4 个两字页签在 ≥320dp 下恒真，`v2SegmentedToggleWidth(4)` ≈ 216dp）：只传
 *   `Modifier.fillMaxWidth()`。[V2SegmentedToggle] 内部 `Modifier.width(IntrinsicSize.Max)` 收到
 *   `fillMaxWidth()` 这种「上下限相等」的约束时会把结果收敛到那个精确宽度，而不是回退到内容自身的
 *   固有宽度——这正是等分整行、而不是挤在一起的关键。
 * - 放不下（预留给未来页签数增加）：改传 `Modifier.fillMaxWidth().horizontalScroll(...)`。
 *   `horizontalScroll` 恒给子项无界宽度，此时 `IntrinsicSize.Max` 收敛到内容固有宽度（各页签自然宽度之和），
 *   轨道整体横向滚动，而不是折成两行。
 *
 * 两个分支都不会截断文字：真放不下时 [V2SegmentedToggle] 每段仍先收边距、再缩字、
 * 最后两行兜底（R-40 已让轨道随两行长高），这里的分支只决定「最外层要不要横向滚动」。
 */
@Composable
@OptIn(ExperimentalLayoutApi::class)
internal fun V2InsightStrip(
    palette: MobileV2Palette,
    selected: InsightPane,
    onSelect: (InsightPane) -> Unit,
    enabled: Boolean = true,
    onBounds: ((String, List<Int>) -> Unit)? = null
) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val minTrackWidth = v2SegmentedToggleWidth(InsightPane.entries.size)
        val fitsWithoutScroll = maxWidth >= minTrackWidth
        V2SegmentedToggle(
            palette = palette,
            options = InsightPane.entries.map { pane -> V2Segment(pane, pane.label) },
            selected = selected,
            onSelect = onSelect,
            modifier = if (fitsWithoutScroll) {
                Modifier.fillMaxWidth()
            } else {
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
            },
            enabled = enabled,
            // 这是页面切换，不是同一张图的数据切换，语义仍然是单选而非标签页。
            role = Role.RadioButton,
            columns = InsightPane.entries.size,
            boundsKeyPrefix = "pane",
            onBounds = onBounds
        )
    }
}

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
