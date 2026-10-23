package com.jeidorf.tokenledger.mobile.ui.controls

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.MeasurePolicy
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selectableGroup
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.LedgerEasing
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerMotion
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ledgerTween
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_SEGMENT_GAP
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_SEGMENT_INSET
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_TOUCH_TARGET
import com.jeidorf.tokenledger.mobile.ui.foundation.drawV2SelectionPill
import com.jeidorf.tokenledger.mobile.ui.foundation.v2SegmentTrackHeight
import kotlin.math.floor
import kotlin.math.roundToInt

/** 溢出侧渐隐的宽度（§4.3：28dp）。 */
internal val V2_RANGE_EDGE_FADE: Dp = LedgerSpace.xxxl - LedgerSpace.xs

/**
 * 范围轨道（§4.3，「永远一行」）：按内容取宽（每项最小 48dp），不再等分挤压；轨道整体放不下时
 * 横向滚动，选中项自动滚到 28dp 渐隐之外；「自定义」是紧跟轨道右侧 8dp 的 48dp 方形按钮，
 * 生效时滑动胶囊离开轨道。
 *
 * **首帧就对（R-67 修复 P1-3）：** 各项的位置由下面的 `Layout` 在测量时写进 [V2RangeTrack]
 * （普通数组，不是快照状态），同一帧稍后的绘制（胶囊）与摆放之前的滚入（[V2RangeTrack.reveal]）
 * 直接读——不再等 `onGloballyPositioned` 写回快照状态、下一帧才出胶囊。胶囊坐标就是各项在轨道
 * 内容里的坐标，左右与各项对齐、上下内缩 4（轨道 12 − 4 = 胶囊 8 的同心关系，§3.4）。
 * 渐隐在绘制阶段读滚动位置：内容不溢出时一侧也不画（P2-3，首帧不再有「幽灵渐隐」）。
 */
@Composable
internal fun V2GlobalRangeControl(
    palette: MobileV2Palette,
    query: DashboardQuery,
    onSelect: (RangeKey) -> Unit,
    onRequestCustomRange: () -> Unit
) {
    val tokens = palette.tokens
    val motion = ledgerMotionEnabled(tokens.isEInk)
    val options = remember { RangeKey.entries.filter { it != RangeKey.Custom } }
    val scrollState = rememberScrollState()
    val density = LocalDensity.current
    val trackHeight = remember(density.fontScale) {
        with(density) { v2SegmentTrackHeight(LedgerType.label.lineHeight.toDp()) }
    }
    val fadePx = with(density) { V2_RANGE_EDGE_FADE.toPx() }
    val trackShape = RoundedCornerShape(LedgerRadius.segmentTrack)
    val trackColor = if (tokens.isEInk) tokens.card else tokens.raised
    val customActive = query.range == RangeKey.Custom
    val selectedIndex = options.indexOf(query.range)
    val track = remember(options) { V2RangeTrack(options.size) }
    val measurePolicy = remember(track, trackHeight) { track.measurePolicy(trackHeight) }

    // 胶囊按「第几项」做动画（与 V2SegmentedToggle 同一手法），绘制时在相邻两项的实际位置之间插值。
    // 第一帧的目标就是当前项，直接落位；从「自定义」切回常规项时 heldSelection 仍为假，也直接落位不滑。
    var heldSelection by remember { mutableStateOf(selectedIndex >= 0) }
    val pillSlot = animateFloatAsState(
        targetValue = selectedIndex.coerceAtLeast(0).toFloat(),
        animationSpec = ledgerTween(
            LedgerMotion.INDICATOR_MILLIS,
            motion && heldSelection && selectedIndex >= 0,
            easing = LedgerEasing.EaseOutExpo
        ),
        label = "rangePill"
    )
    SideEffect { heldSelection = selectedIndex >= 0 }

    // 之后换选中项：滚到两侧渐隐之外。第一帧与尺寸变化由下面的 layout 在摆放前直接落位，不走这里。
    LaunchedEffect(selectedIndex) {
        val target = track.revealTarget(selectedIndex, scrollState.value, fadePx) ?: return@LaunchedEffect
        if (target != scrollState.value) {
            scrollState.animateScrollTo(
                target,
                ledgerTween(LedgerMotion.INDICATOR_MILLIS, motion, easing = LedgerEasing.EaseOutExpo)
            )
        }
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Layout(
            content = {
                options.forEach { range ->
                    V2RangeOption(palette, range, query.range == range, onSelect, minHeight = trackHeight)
                }
            },
            modifier = Modifier
                // 按内容取宽、上限为剩余宽度：放得下时视口就是内容本身，按钮紧跟其后（P2-3）。
                .weight(1f, fill = false)
                .layout { measurable, constraints ->
                    val viewport = measurable.measure(constraints)
                    track.reveal(selectedIndex, viewport.width, scrollState, fadePx)
                    layout(viewport.width, viewport.height) { viewport.place(0, 0) }
                }
                // 渐隐画在视口坐标里、不随内容滚动。
                .drawWithContent {
                    drawContent()
                    val start = scrollState.value > 0
                    val end = scrollState.value < scrollState.maxValue
                    val (leftFade, rightFade) = if (layoutDirection == LayoutDirection.Ltr) start to end else end to start
                    val fade = V2_RANGE_EDGE_FADE.toPx().coerceAtMost(size.width / 2f)
                    if (leftFade) {
                        drawRect(
                            Brush.horizontalGradient(listOf(trackColor, trackColor.copy(alpha = 0f)), startX = 0f, endX = fade),
                            size = Size(fade, size.height)
                        )
                    }
                    if (rightFade) {
                        drawRect(
                            Brush.horizontalGradient(
                                listOf(trackColor.copy(alpha = 0f), trackColor),
                                startX = size.width - fade,
                                endX = size.width
                            ),
                            topLeft = Offset(size.width - fade, 0f),
                            size = Size(fade, size.height)
                        )
                    }
                }
                .horizontalScroll(scrollState)
                .semantics { selectableGroup() }
                .clip(trackShape)
                .background(trackColor)
                .then(
                    if (tokens.isEInk) Modifier.border(LedgerStroke.einkCard, tokens.outline, trackShape)
                    else Modifier
                )
                .drawBehind {
                    if (customActive) return@drawBehind
                    val pill = track.pillRect(pillSlot.value, size.height, V2_SEGMENT_INSET.toPx())
                        ?: return@drawBehind
                    val left = if (layoutDirection == LayoutDirection.Ltr) pill.left else size.width - pill.right
                    drawV2SelectionPill(tokens, Offset(left, pill.top), pill.size, tokens.selected)
                },
            measurePolicy = measurePolicy
        )
        Spacer(Modifier.width(LedgerSpace.sm))
        // 「自定义」按钮（§4.3）：轨道右侧独立的 48dp 方形按钮，raised 底、与轨道同圆角、日历图标；
        // 自定义生效时（胶囊离开轨道）切为 primaryContainer 底 + primary 图标。语义与旧实现
        // 同款、只换了视觉：契约「Android dashboard range and insight selectors expose one
        // selected radio option」按字面核对这一段。
        val customShape = RoundedCornerShape(LedgerRadius.segmentTrack)
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(customShape)
                .background(if (customActive) tokens.primaryContainer else tokens.raised)
                .then(
                    when {
                        // 墨水屏：不分选中态、常驻 1.5dp 黑边（与轨道同款），本身就是非颜色线索。
                        tokens.isEInk -> Modifier.border(LedgerStroke.einkCard, tokens.outline, customShape)
                        // 选中的非颜色线索（root 决定 R-18）：旧实现是 IconButton 外挂 1dp `palette.blue`
                        // 描边，这里换成同色的直角描边——按钮本身不参与滑动胶囊，仍要单独钉住这一条。
                        customActive -> Modifier.border(LedgerStroke.hairline, tokens.primary, customShape)
                        else -> Modifier
                    }
                )
                .clickable(onClickLabel = "选择自定义日期范围") { onRequestCustomRange() }
                .semantics {
                    selected = query.range == RangeKey.Custom
                    role = Role.RadioButton
                    stateDescription = if (query.range == RangeKey.Custom) "已选择" else "未选择"
                },
            contentAlignment = Alignment.Center
        ) {
            Icon(
                Icons.Default.CalendarMonth,
                contentDescription = "自定义",
                tint = if (customActive) tokens.primary else tokens.muted
            )
        }
    }
}

/**
 * 范围轨道的几何（§4.3）：左右内缩 4、项间距 4，各项按内容取宽（最小 48dp 由 [V2RangeOption] 保证）、
 * 高度等于轨道高。坐标一律从起始边量（LTR 即从左量），摆放用 `placeRelative`，RTL 自动镜像。
 * 测量时写、同一帧的绘制与摆放前读；普通字段，写了不触发重组。
 */
private class V2RangeTrack(count: Int) {
    val starts = FloatArray(count)
    val widths = FloatArray(count)
    var contentWidth = 0f
        private set
    private var measured = false
    private var revealedViewport = -1
    private var revealedContent = -1f

    fun measurePolicy(trackHeight: Dp) = MeasurePolicy { measurables, _ ->
        val height = trackHeight.roundToPx()
        val placeables = measurables.map { it.measure(Constraints(minHeight = height, maxHeight = height)) }
        val offsets = v2RangeOptionStarts(
            placeables.map { it.width },
            inset = V2_SEGMENT_INSET.roundToPx(),
            gap = V2_SEGMENT_GAP.roundToPx()
        )
        placeables.forEachIndexed { index, placeable ->
            starts[index] = offsets[index].toFloat()
            widths[index] = placeable.width.toFloat()
        }
        val width = offsets.last()
        contentWidth = width.toFloat()
        measured = true
        layout(width, height) {
            placeables.forEachIndexed { index, placeable -> placeable.placeRelative(offsets[index], 0) }
        }
    }

    /** 胶囊矩形（内容坐标、从起始边量）：见 [v2RangePillRect]。 */
    fun pillRect(slot: Float, trackHeight: Float, inset: Float): Rect? =
        if (measured) v2RangePillRect(slot, starts, widths, trackHeight, inset) else null

    /** 让第 [index] 项落在渐隐之外的滚动位置；还没量过或不是常规项时返回 null。 */
    fun revealTarget(index: Int, current: Int, fade: Float): Int? {
        if (!measured || index !in starts.indices || revealedViewport < 0) return null
        return v2RangeRevealScroll(
            current = current.toFloat(),
            itemStart = starts[index],
            itemEnd = starts[index] + widths[index],
            viewport = revealedViewport.toFloat(),
            content = contentWidth,
            fade = fade
        ).roundToInt()
    }

    /**
     * 首帧与视口 / 内容宽度变化时：在摆放之前把选中项直接滚到渐隐之外（`dispatchRawDelta` 同步改
     * 滚动位置，紧接着的摆放就读到新值，所以第一帧就是滚好的）。选中项变化不走这里，由调用方动画滚入。
     */
    fun reveal(index: Int, viewport: Int, scrollState: ScrollState, fade: Float) {
        if (!measured || (viewport == revealedViewport && contentWidth == revealedContent)) return
        revealedViewport = viewport
        revealedContent = contentWidth
        val target = revealTarget(index, scrollState.value, fade) ?: return
        if (target != scrollState.value) scrollState.dispatchRawDelta((target - scrollState.value).toFloat())
    }
}

/** 各项的起始坐标（末位附带内容总宽）：`inset` + 前面各项宽 + 间距，最后再加一个 `inset`。 */
internal fun v2RangeOptionStarts(widths: List<Int>, inset: Int, gap: Int): List<Int> {
    val starts = ArrayList<Int>(widths.size + 1)
    var x = inset
    widths.forEachIndexed { index, width ->
        starts += x
        x += width + if (index < widths.lastIndex) gap else 0
    }
    starts += x + inset
    return starts
}

/**
 * 胶囊矩形：[slot] 是动画中的「第几项」（可带小数），左右在相邻两项之间线性插值；上下各内缩
 * [inset]（§4.3「内缩 4」）。没有项时返回 null。
 */
internal fun v2RangePillRect(
    slot: Float,
    starts: FloatArray,
    widths: FloatArray,
    trackHeight: Float,
    inset: Float
): Rect? {
    if (starts.isEmpty() || widths.size != starts.size) return null
    val clamped = slot.coerceIn(0f, starts.lastIndex.toFloat())
    val index = floor(clamped).toInt().coerceAtMost(starts.lastIndex)
    val next = (index + 1).coerceAtMost(starts.lastIndex)
    val fraction = clamped - index
    val start = starts[index] + (starts[next] - starts[index]) * fraction
    val width = widths[index] + (widths[next] - widths[index]) * fraction
    return Rect(start, inset, start + width, trackHeight - inset)
}

/**
 * 把 [itemStart, itemEnd] 这一项滚到渐隐之外的滚动位置（从起始边量）。渐隐只画在还能往那一侧
 * 滚的一边：滚到头时那一侧没有渐隐，只要落在视口内即可。项比「视口 − 两侧渐隐」还宽时保起始边。
 */
internal fun v2RangeRevealScroll(
    current: Float,
    itemStart: Float,
    itemEnd: Float,
    viewport: Float,
    content: Float,
    fade: Float
): Float {
    val max = (content - viewport).coerceAtLeast(0f)
    if (max == 0f) return 0f
    var target = current.coerceIn(0f, max)
    if (itemEnd > target + viewport - fade) target = (itemEnd + fade - viewport).coerceAtMost(max)
    if (itemStart < target + fade) target = (itemStart - fade).coerceAtLeast(0f)
    return target
}

/**
 * 范围轨道里的一格：按内容取宽（文字自然宽度 + 左右 [LedgerSpace.sm]），不写死、不等分，
 * 至少 48dp（§4.3「每项最小 48dp」、§6.3 触达下限，R-67 修复 P2-1），所以永远单行、永远不需要缩字
 * 或折行——压窄只会发生在等分宽度的轨道（[V2InsightStrip] 那一类），这里结构上就不会走到 R-40 的
 * 折行分支。背景与滑动胶囊由 [V2GlobalRangeControl] 统一画，这一格只负责文字、点击与语义；
 * [minHeight] 与轨道可见高度同值，由调用方算一次传下来，不重复计算。
 */
@Composable
internal fun V2RangeOption(
    palette: MobileV2Palette,
    range: RangeKey,
    active: Boolean,
    onSelect: (RangeKey) -> Unit,
    minHeight: Dp,
    modifier: Modifier = Modifier
) {
    val tokens = palette.tokens
    val motion = ledgerMotionEnabled(tokens.isEInk)
    val content by animateColorAsState(
        targetValue = if (active) tokens.onSelected else tokens.muted,
        animationSpec = ledgerTween(LedgerMotion.FAST_MILLIS, motion),
        label = "rangeOptionContent"
    )
    Box(
        modifier = modifier
            .widthIn(min = V2_TOUCH_TARGET)
            .heightIn(min = minHeight)
            .clickable(onClickLabel = if (active) null else "切换到${range.label}") { onSelect(range) }
            .semantics {
                this.selected = active
                role = Role.RadioButton
                stateDescription = if (active) "已选择" else "未选择"
            }
            .padding(horizontal = LedgerSpace.sm),
        contentAlignment = Alignment.Center
    ) {
        Text(
            range.label,
            color = content,
            fontSize = LedgerFont.label,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Visible
        )
    }
}
