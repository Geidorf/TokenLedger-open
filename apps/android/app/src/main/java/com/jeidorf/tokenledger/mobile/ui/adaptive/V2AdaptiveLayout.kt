package com.jeidorf.tokenledger.mobile.ui.adaptive

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane
import com.jeidorf.tokenledger.mobile.ui.navigation.MobileDestination

/**
 * 窗口宽度档（与 Material 3 窗口尺寸类同一组断点）：手机竖屏 Compact；折叠屏内屏、平板竖屏
 * Medium，换侧边导航栏、内容单栏居中；平板横屏、手机横屏 Expanded，再拆成双栏。
 * 断点自己算而不引 window-size-class 依赖：外壳本来就用 BoxWithConstraints 拿到了窗口宽度。
 */
internal enum class V2WindowWidthClass { Compact, Medium, Expanded }

internal fun v2WindowWidthClass(widthDp: Int): V2WindowWidthClass = when {
    widthDp < 600 -> V2WindowWidthClass.Compact
    widthDp < 840 -> V2WindowWidthClass.Medium
    else -> V2WindowWidthClass.Expanded
}

/** 双栏只在 Expanded 且没放大到紧凑版式时开；200% 字号下两栏各自都太窄，退回单栏。 */
internal fun v2UsesTwoPane(widthDp: Int, fontScale: Float): Boolean =
    v2WindowWidthClass(widthDp) == V2WindowWidthClass.Expanded && fontScale < 1.5f

/** 宽窗口单栏时内容的最大宽度：卡片和数据条不被拉成一整条。 */
internal val V2_SINGLE_PANE_MAX_WIDTH = 720.dp

/**
 * 用量子页在双栏时右栏放哪个子页：概览配来源（用量拆分），趋势与日历互配，请求配趋势。
 * 返回 null 表示这个子页没有伴随栏，单栏居中显示（来源本身已是整页排行，其余子页同理）。
 */
internal fun InsightPane.v2CompanionPane(): InsightPane? = when (this) {
    InsightPane.Overview -> InsightPane.Sources
    InsightPane.Trend -> InsightPane.Calendar
    InsightPane.Calendar -> InsightPane.Trend
    InsightPane.Details -> InsightPane.Trend
    else -> null
}

/** 宽窗口下每个一级分区怎么铺。 */
internal enum class V2PaneArrangement {
    /** 手机竖屏：照旧一栏铺满。 */
    Full,
    /** Medium，或没有伴随栏的子页：一栏，限宽居中。 */
    Centered,
    /** Expanded：左栏主内容，右栏伴随内容。 */
    Split,
    /** Expanded 下自己横向展开的页（路由舞台与最近调用并排、额度卡两列）：一栏铺满。 */
    Spread
}

internal fun v2PaneArrangement(
    wide: Boolean,
    twoPane: Boolean,
    destination: MobileDestination,
    insightPane: InsightPane
): V2PaneArrangement = when {
    !wide -> V2PaneArrangement.Full
    !twoPane -> V2PaneArrangement.Centered
    destination == MobileDestination.Usage ->
        if (insightPane.v2CompanionPane() != null) V2PaneArrangement.Split else V2PaneArrangement.Centered
    destination == MobileDestination.Me -> V2PaneArrangement.Split
    else -> V2PaneArrangement.Spread
}

/**
 * 按 [arrangement] 摆一栏或两栏。两栏各占一半；每栏的列表自带左右 14dp 内边距，
 * 中间自然留出 28dp 的栏间距，和卡片之间的节奏一致。
 */
@Composable
internal fun V2AdaptivePanes(
    arrangement: V2PaneArrangement,
    primary: @Composable (Modifier) -> Unit,
    secondary: (@Composable (Modifier) -> Unit)?
) {
    when {
        arrangement == V2PaneArrangement.Split && secondary != null -> Row(
            modifier = Modifier.fillMaxSize(),
            horizontalArrangement = Arrangement.Start
        ) {
            primary(Modifier.weight(1f).fillMaxHeight())
            secondary(Modifier.weight(1f).fillMaxHeight())
        }
        arrangement == V2PaneArrangement.Centered -> Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.TopCenter
        ) {
            primary(Modifier.widthIn(max = V2_SINGLE_PANE_MAX_WIDTH).fillMaxSize())
        }
        else -> primary(Modifier.fillMaxSize())
    }
}

/** 右栏顶上的小节眉题：告诉人这一栏是哪个子页，和左栏的页签对得上。 */
@Composable
internal fun V2PaneEyebrow(palette: MobileV2Palette, text: String) {
    Text(
        text,
        color = palette.muted,
        style = LedgerType.caption,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .padding(top = 14.dp, bottom = 2.dp, start = 2.dp)
            .semantics { heading() }
    )
}
