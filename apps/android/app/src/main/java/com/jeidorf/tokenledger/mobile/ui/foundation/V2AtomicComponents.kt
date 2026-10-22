package com.jeidorf.tokenledger.mobile.ui.foundation

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.IntrinsicMeasurable
import androidx.compose.ui.layout.IntrinsicMeasureScope
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.MeasurePolicy
import androidx.compose.ui.layout.MeasureResult
import androidx.compose.ui.layout.MeasureScope
import androidx.compose.ui.layout.Placeable
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selectableGroup
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.LedgerEasing
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerMotion
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.QuotaSeverity
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.dashboardLoadingAccessibilityDescription
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ledgerTween

internal typealias V2RetainedDataHolder = com.jeidorf.tokenledger.mobile.V2RetainedDataHolder

internal fun dashboardDataForFrame(
    visibleData: StatsData?,
    retainedData: StatsData?,
    dashboardLoading: Boolean
): StatsData? = visibleData ?: retainedData.takeIf { dashboardLoading }

internal fun v2DashboardTopStatusText(
    state: DashboardUiState,
    displayedStats: StatsData? = state.visibleData
): String? {
    val stats = displayedStats
    return when {
        state.dashboardLoading && stats == null -> "正在加载数据"
        state.dashboardLoading && state.showingCachedData ->
            "正在刷新 · 快照截至 ${v2ShortDateTime(stats?.meta?.generatedAt)}"
        state.dashboardLoading -> "正在刷新数据"
        state.error != null && stats != null -> state.userVisibleError ?: "刷新失败 · 显示已有数据"
        state.showingCachedData -> "离线快照 · 截至 ${v2ShortDateTime(stats?.meta?.generatedAt)}"
        stats?.meta?.stale == true -> "数据已过期 · 保留可验证快照"
        stats?.legacyRpc == true -> "兼容模式 · 部分洞察不可用"
        else -> null
    }
}

@Composable
internal fun V2LoadingState(
    palette: MobileV2Palette,
    showingCachedData: Boolean
) {
    val description = dashboardLoadingAccessibilityDescription(showingCachedData)
    Box(
        Modifier
            .fillMaxSize()
            .semantics {
                liveRegion = LiveRegionMode.Polite
            },
        contentAlignment = Alignment.Center
    ) {
        CircularProgressIndicator(
            color = palette.tokens.primary,
            modifier = Modifier.semantics { contentDescription = description }
        )
    }
}

/**
 * 整页状态卡（加载失败、专属看板不可用）：`titleM` 标题 + `body` `muted` 说明 + 主按钮。
 * 主按钮按 §4.10：`primaryFill` 底、圆角 12、高 48、`label` 字，按压 `PRESS`。
 */
@Composable
internal fun V2FullState(
    palette: MobileV2Palette,
    title: String,
    body: String,
    action: String,
    onAction: () -> Unit
) {
    val tokens = palette.tokens
    val interaction = remember { MutableInteractionSource() }
    Box(Modifier.fillMaxSize().padding(LedgerSpace.xxl), contentAlignment = Alignment.Center) {
        V2Card(palette, modifier = Modifier.widthIn(max = 420.dp)) {
            Text(
                title,
                style = LedgerType.titleM,
                color = tokens.text,
                modifier = Modifier.semantics { heading() }
            )
            Spacer(Modifier.height(LedgerSpace.xs))
            Text(
                body,
                style = LedgerType.body,
                color = tokens.muted,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
            )
            Spacer(Modifier.height(LedgerSpace.lg))
            Button(
                onClick = onAction,
                interactionSource = interaction,
                shape = RoundedCornerShape(LedgerRadius.md),
                colors = ButtonDefaults.buttonColors(
                    containerColor = tokens.primaryFill,
                    contentColor = tokens.onPrimaryFill
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = LedgerSize.button)
                    .pressScale(interaction, ledgerMotionEnabled(palette.isEInk))
            ) {
                Text(action, style = LedgerType.label)
            }
        }
    }
}

// Optional screenshot observer runs against actual composed targets; production has no observer.
internal fun Modifier.observeChoiceBounds(key: String, observer: ((String, List<Int>) -> Unit)?): Modifier =
    if (observer == null) this else onGloballyPositioned { coordinates ->
        val position = coordinates.positionInParent()
        observer(key, listOf(position.x.toInt(), position.y.toInt(), coordinates.size.width, coordinates.size.height))
    }

/**
 * [V2SegmentedToggle] 的一段。`activeContent` / `activeContainer` 留空时用分段胶囊的
 * `selected` / `onSelected`；墨水屏一律黑底白字，不认这两个覆盖值。
 */
internal data class V2Segment<T>(
    val value: T,
    val label: String,
    val contentDescription: String = label,
    val activeContent: Color? = null,
    val activeContainer: Color? = null
)

/**
 * 分段轨道的可见高度（§4.3）：`max(48, 文字行高 + 16)`。[labelLineHeight] 由调用方按
 * 系统字体倍率换算（含 Android 14 起的非线性放大），触达高度不低于 [V2_TOUCH_TARGET]。
 */
internal fun v2SegmentTrackHeight(labelLineHeight: Dp): Dp =
    maxOf(V2_CONTROL_HEIGHT, labelLineHeight + LedgerSpace.lg)

/**
 * 分段控件（§4.3）：`raised` 轨道、圆角 12、内缩 4；选中项背后是一枚**滑动胶囊**
 * （`selected` 底、圆角 8，浅色下沿 1dp 短阴影、深色顶部 1dp 内高光，内缘 1dp `primary` 描边——
 * 胶囊对轨道只有 1.25 / 1.14，描边是选中的非颜色线索，root 决定 R-18），用 `INDICATOR`
 * 在选项间移动，首帧直接落位。墨水屏：白底 1.5dp 黑边轨道、黑胶囊白字、无动画。
 * 每项仍是单选 / 页签语义，带 `selected` 与状态描述。文字不省略：段被压窄时见 [V2SegmentLabel]（R-31）。
 *
 * **轨道随折行文字长高（R-40，T10.208；R-67 修复轮）：** 轨道高度与每段的可点区域用 `heightIn(min = …)`
 * 而不是 `height(…)`；背景轨道（含滑动胶囊）用 `Modifier.matchParentSize()` 跟随实际内容高度，
 * 不再定死在可见高度上。哪一段的 [V2SegmentLabel] 真的折了行，该段（进而整条轨道随之长高，
 * 其余段用 `verticalAlignment = Alignment.CenterVertically` 在长高后的行里居中）就跟着长高，
 * 胶囊与折行文字一起被包住，不会像 R2-P3-1 那样画到轨道外面；兜底不设行数上限，字一个不丢。
 * [onLabelLayout] 只给截图夹具用：报出每段真正摆上去的那份文字的排版结果，生产不传。
 */
@Composable
internal fun <T> V2SegmentedToggle(
    palette: MobileV2Palette,
    options: List<V2Segment<T>>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    role: Role = Role.Tab,
    columns: Int = options.size,
    boundsKeyPrefix: String? = null,
    onBounds: ((String, List<Int>) -> Unit)? = null,
    onLabelLayout: ((String, TextLayoutResult) -> Unit)? = null
) {
    val tokens = palette.tokens
    val motion = ledgerMotionEnabled(palette.isEInk)
    val labelStyle = LedgerType.label
    val labelLineHeight = with(LocalDensity.current) { labelStyle.lineHeight.toDp() }
    val visibleHeight = v2SegmentTrackHeight(labelLineHeight)
    val touchHeight = maxOf(V2_TOUCH_TARGET, visibleHeight)
    val trackShape = RoundedCornerShape(LedgerRadius.md)
    val slots = columns.coerceAtLeast(1)
    val rows = options.chunked(slots)
    val widestRow = rows.maxOfOrNull { it.size } ?: 1
    val minTrackWidth = v2SegmentedToggleWidth(widestRow)

    Column(
        modifier = modifier
            .width(IntrinsicSize.Max)
            .widthIn(min = minTrackWidth)
            .semantics { selectableGroup() },
        verticalArrangement = Arrangement.spacedBy(LedgerSpace.xs)
    ) {
        rows.forEach { row ->
            val selectedSlot = row.indexOfFirst { it.value == selected }
            val activeOption = row.getOrNull(selectedSlot)
            val pillColor = animateColorAsState(
                targetValue = if (tokens.isEInk) tokens.selected else activeOption?.activeContainer ?: tokens.selected,
                animationSpec = ledgerTween(LedgerMotion.FAST_MILLIS, motion),
                label = "segmentContainer"
            )
            // 胶囊只在同一行里滑；选中项从别的行移进来时直接落位，不从这一行的旧位置滑过来。
            var heldSelection by remember { mutableStateOf(selectedSlot >= 0) }
            val pillSlot = animateFloatAsState(
                targetValue = selectedSlot.coerceAtLeast(0).toFloat(),
                animationSpec = ledgerTween(
                    LedgerMotion.INDICATOR_MILLIS,
                    motion && heldSelection && selectedSlot >= 0,
                    easing = LedgerEasing.EaseOutExpo
                ),
                label = "segmentIndicator"
            )
            SideEffect { heldSelection = selectedSlot >= 0 }
            // R-40：外层不再钉死 touchHeight，改为下限，随内容（正常一行 = visibleHeight；
            // 某段被压窄到需要两行文字时）一起长高。背景轨道用 matchParentSize() 跟随最终高度，
            // 不再单独定高、单独居中——那样在外层长高后反而会比内容矮。
            Box(Modifier.fillMaxWidth().heightIn(min = touchHeight)) {
                Box(
                    Modifier
                        .matchParentSize()
                        .v2SegmentTrack(
                            colors = tokens,
                            shape = trackShape,
                            slots = slots,
                            pillSlot = pillSlot.takeIf { selectedSlot >= 0 },
                            pillColor = pillColor
                        )
                )
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = visibleHeight)
                        .padding(horizontal = V2_SEGMENT_INSET),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(V2_SEGMENT_GAP)
                ) {
                    row.forEach { option ->
                        val active = option.value == selected
                        val content by animateColorAsState(
                            targetValue = when {
                                !active -> tokens.muted
                                tokens.isEInk -> tokens.onSelected
                                else -> option.activeContent ?: tokens.onSelected
                            },
                            animationSpec = ledgerTween(LedgerMotion.FAST_MILLIS, motion),
                            label = "segmentContent"
                        )
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .heightIn(min = visibleHeight)
                                .then(
                                    boundsKeyPrefix?.let { prefix ->
                                        Modifier.observeChoiceBounds("$prefix-${option.label}", onBounds)
                                    } ?: Modifier
                                )
                                .clickable(enabled = enabled) { onSelect(option.value) }
                                .semantics {
                                    this.role = role
                                    this.selected = active
                                    contentDescription = option.contentDescription
                                    stateDescription = if (active) "已选择" else "未选择"
                                },
                            contentAlignment = Alignment.Center
                        ) {
                            V2SegmentLabel(
                                option.label, labelStyle, content,
                                onLayout = onLabelLayout?.let { observer -> { result -> observer(option.label, result) } }
                            )
                        }
                    }
                    repeat(slots - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

/**
 * 分段文字（R-31，两行兜底的长高见 R-40）：宁可收边距、缩字、折行、让轨道跟着长高，
 * 也不省略字符。
 *
 * 首选 [style] 单行、两侧各留 [LedgerSpace.sm]。父级把段压窄时依次退让：
 * 1. 两侧收到 [LedgerSpace.xs]（与轨道内缩同值；胶囊的 1dp 描边在段的最外缘，字离它仍有 3dp）；
 * 2. 沿 [LedgerFont] 的档缩字，到 `caption` 为止，行高按同一比例缩（[v2WithFontSize]），
 *    轨道不会被撑高（一行永远放得下时按原尺寸）；
 * 3. 仍放不下才在 `caption` 折行——`V2SegmentedToggle` 的轨道与该段的可点区域改用
 *    `heightIn(min = …)`（R-40），会跟着这里量出的折行高度一起长高，不裁切、不出省略号。
 *    **兜底不设行数上限（R-67 修复 P1-1）**：旧写法 `maxLines = 2` 在 320dp × 200% 下把「Token 消耗」
 *    排成「Tok / en」，第三行「消耗」被静默丢掉。能在词间断行时就在词间断（两行放得下就是两行）；
 *    只有一个词本身比格子还宽（200% 下 11sp 的「Token」约 61dp，五等分格只有 54dp）才会在词内折开，
 *    那也比丢字强。
 *
 * 固有宽度照旧按首选字号加两侧 [LedgerSpace.sm] 报：控件按最宽文案定宽的结果、100% / 150% 的版面都不变，
 * 只有被压窄时（例如 320dp × 200% 的「Token 消耗」）才走上面几步。与 [V2FittedValueText] 一样，
 * 每档各合成一份、测量时只摆放选中的那份；各份不进无障碍树，朗读只读一遍原文。
 * [onLayout] 只给截图夹具：测量时报出真正摆上去的那一份的 [TextLayoutResult]（行数、是否溢出）。
 */
@Composable
private fun V2SegmentLabel(
    text: String,
    style: TextStyle,
    color: Color,
    onLayout: ((TextLayoutResult) -> Unit)? = null
) {
    val styles = remember(style) { v2FittedFontSizes(style.fontSize).map { style.v2WithFontSize(it) } }
    // 每份候选最近一次的排版结果（下标与子项一致，末位是兜底）；没有观察者时不挂回调、不记录。
    val layouts = remember(styles) { arrayOfNulls<TextLayoutResult>(styles.size + 1) }
    val recordAt: (Int) -> ((TextLayoutResult) -> Unit)? = { index ->
        if (onLayout == null) null else { result -> layouts[index] = result }
    }
    Layout(
        content = {
            styles.forEachIndexed { index, candidate ->
                Text(
                    text,
                    style = candidate,
                    color = color,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    softWrap = false,
                    onTextLayout = recordAt(index),
                    modifier = Modifier.clearAndSetSemantics { }
                )
            }
            // 兜底：不设 maxLines，也就不会有被截掉的行；母级轨道用 heightIn(min = …) 长高来包住。
            Text(
                text,
                style = styles.last(),
                color = color,
                textAlign = TextAlign.Center,
                onTextLayout = recordAt(styles.size),
                modifier = Modifier.clearAndSetSemantics { }
            )
        },
        modifier = Modifier.semantics { this.text = AnnotatedString(text) },
        measurePolicy = remember(layouts, onLayout) { V2SegmentLabelMeasurePolicy(layouts, onLayout) }
    )
}

/** [V2SegmentLabel] 的测量：前几个子项是逐档的单行文字，最后一个是 `caption` 折行兜底。 */
private class V2SegmentLabelMeasurePolicy(
    private val layouts: Array<TextLayoutResult?>,
    private val onLayout: ((TextLayoutResult) -> Unit)?
) : MeasurePolicy {
    override fun MeasureScope.measure(measurables: List<Measurable>, constraints: Constraints): MeasureResult {
        val budget = (constraints.maxWidth - LedgerSpace.xs.roundToPx() * 2).coerceAtLeast(0)
        var chosen = measurables.lastIndex
        var fitted: Placeable? = null
        for (index in 0 until measurables.lastIndex) {
            val candidate = measurables[index].measure(Constraints())
            if (candidate.width <= budget) {
                chosen = index
                fitted = candidate
                break
            }
        }
        val label = fitted ?: measurables.last().measure(Constraints(maxWidth = budget))
        layouts[chosen]?.let { result -> onLayout?.invoke(result) }
        val width = (label.width + LedgerSpace.sm.roundToPx() * 2).coerceIn(constraints.minWidth, constraints.maxWidth)
        // 折行兜底时上下各留 [LedgerSpace.sm]（与可见高度「行高 + 16」同一规则）：段随之长高，胶囊上下
        // 内缩 4 后仍包住整块文字，描边不压字。单行各档不加，段高由调用方的可见高度下限决定。
        val padding = if (fitted == null) LedgerSpace.sm.roundToPx() else 0
        val height = (label.height + padding * 2).coerceIn(constraints.minHeight, constraints.maxHeight)
        return layout(width, height) {
            label.placeRelative(
                Alignment.CenterHorizontally.align(label.width, width, layoutDirection),
                Alignment.CenterVertically.align(label.height, height)
            )
        }
    }

    // 固有尺寸只看首选档：与改前的 `Text(…).padding(horizontal = LedgerSpace.sm)` 逐像素相同。
    override fun IntrinsicMeasureScope.maxIntrinsicWidth(measurables: List<IntrinsicMeasurable>, height: Int): Int =
        measurables.first().maxIntrinsicWidth(height) + LedgerSpace.sm.roundToPx() * 2

    override fun IntrinsicMeasureScope.minIntrinsicWidth(measurables: List<IntrinsicMeasurable>, height: Int): Int =
        measurables.first().minIntrinsicWidth(height) + LedgerSpace.sm.roundToPx() * 2

    override fun IntrinsicMeasureScope.minIntrinsicHeight(measurables: List<IntrinsicMeasurable>, width: Int): Int =
        measurables.first().minIntrinsicHeight(Constraints.Infinity)

    override fun IntrinsicMeasureScope.maxIntrinsicHeight(measurables: List<IntrinsicMeasurable>, width: Int): Int =
        measurables.first().maxIntrinsicHeight(Constraints.Infinity)
}

/**
 * 分段轨道与滑动胶囊的绘制。胶囊位置与颜色在绘制阶段读取动画值，
 * 动画进行中只重绘、不重组。各段等宽（`weight(1f)` 加空位补齐），胶囊按同一公式落位。
 */
private fun Modifier.v2SegmentTrack(
    colors: LedgerColors,
    shape: Shape,
    slots: Int,
    pillSlot: State<Float>?,
    pillColor: State<Color>
): Modifier = this
    .clip(shape)
    .background(if (colors.isEInk) colors.card else colors.raised)
    .then(if (colors.isEInk) Modifier.border(LedgerStroke.einkCard, colors.outline, shape) else Modifier)
    .drawBehind {
        val slot = pillSlot?.value ?: return@drawBehind
        val inset = V2_SEGMENT_INSET.toPx()
        val gap = V2_SEGMENT_GAP.toPx()
        val slotWidth = (size.width - inset * 2 - gap * (slots - 1)) / slots
        if (slotWidth <= 0f) return@drawBehind
        drawV2SelectionPill(
            colors = colors,
            topLeft = Offset(inset + slot * (slotWidth + gap), inset),
            size = Size(slotWidth, size.height - inset * 2),
            fill = pillColor.value
        )
    }

/**
 * 选中胶囊（§4.3）：[fill] 底、圆角 8（轨道 12 − 内缩 4），浅色下沿 1dp 短阴影、深色顶部 1dp 内高光。
 * 分段控件与范围轨道（`V2GlobalRangeControl`）共用这一份（R-67 修复 P1-3），选中线索只写在这里。
 *
 * 选中的非颜色线索（root 决定 R-18）：胶囊对轨道深 1.25、浅 1.14，只靠底色分不出选中项；
 * 沿胶囊内缘画 1dp `primary` 描边，对轨道与胶囊都 ≥4.9:1。墨水屏是黑胶囊，本身就是 21:1。
 * 契约「Android 自定义区间按钮随选中状态换底色与图标色…」钉住这条描边与两处调用。
 */
internal fun DrawScope.drawV2SelectionPill(colors: LedgerColors, topLeft: Offset, size: Size, fill: Color) {
    if (size.width <= 0f || size.height <= 0f) return
    val radius = LedgerRadius.sm.toPx()
    val hairline = LedgerStroke.hairline.toPx()
    if (colors.pillShadow.alpha > 0f) {
        drawRoundRect(colors.pillShadow, topLeft + Offset(0f, hairline), size, CornerRadius(radius))
    }
    drawRoundRect(fill, topLeft, size, CornerRadius(radius))
    if (colors.cardHighlight.alpha > 0f && size.width > radius * 2) {
        drawRect(
            colors.cardHighlight,
            topLeft = Offset(topLeft.x + radius, topLeft.y),
            size = Size(size.width - radius * 2, hairline)
        )
    }
    if (!colors.isEInk) {
        val half = hairline / 2f
        drawRoundRect(
            color = colors.primary,
            topLeft = topLeft + Offset(half, half),
            size = Size(size.width - hairline, size.height - hairline),
            cornerRadius = CornerRadius((radius - half).coerceAtLeast(0f)),
            style = Stroke(width = hairline)
        )
    }
}

// 所有候选文案共用测量槽；仅当前文案可见、可朗读，切换不会推移相邻控件。
@Composable
internal fun V2StableChoiceText(options: List<String>, value: String, style: TextStyle, color: Color) {
    Box(Modifier.fillMaxWidth()) {
        (options + value).distinct().forEach { option ->
            Text(
                option, style = style, color = if (option == value) color else Color.Transparent,
                modifier = if (option == value) Modifier else Modifier.clearAndSetSemantics { }
            )
        }
    }
}

/**
 * 单行数值，放不下时沿 [LedgerFont] 的档逐级缩小（T10.177 修复轮：评审 E-2、P3-14，root 决定 R-19）。
 *
 * 数字不换行（§3.7），窄格加大字体时旧写法 `maxLines = 1, softWrap = false` 会把「¥132.46」
 * 裁成「¥132.4」——读成另一个数。这里从 [style] 的字号起往下试，取第一档整段放得下的；
 * 格高固定取首选字号那一行，缩档的字在里面垂直居中，换档不会让格子忽高忽低。
 * 缩到 [minFontSize] 仍放不下才折行（最多两行），宁可折行也不丢位。
 * 每档各合成一份文字，测量时只摆放选中的那一份：不重组、不闪，其余几份不绘制、不进无障碍树。
 */
@Composable
internal fun V2FittedValueText(
    text: String,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
    minFontSize: TextUnit = LedgerFont.caption
) {
    val styles = remember(style, minFontSize) {
        v2FittedFontSizes(style.fontSize, minFontSize).map { style.v2WithFontSize(it) }
    }
    Layout(
        content = {
            styles.forEach { candidate ->
                Text(
                    text,
                    style = candidate,
                    color = color,
                    maxLines = 1,
                    softWrap = false,
                    modifier = Modifier.clearAndSetSemantics { }
                )
            }
            Text(
                text,
                style = styles.last(),
                color = color,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.clearAndSetSemantics { }
            )
        },
        modifier = modifier.semantics { this.text = AnnotatedString(text) }
    ) { measurables, constraints ->
        val singleLine = measurables.dropLast(1).map { it.measure(Constraints()) }
        val index = v2FirstFittingIndex(singleLine.map { it.width }, constraints.maxWidth)
        val chosen = if (index != null) {
            singleLine[index]
        } else {
            measurables.last().measure(constraints.copy(minWidth = 0, minHeight = 0))
        }
        val height = maxOf(singleLine.first().height, chosen.height)
            .coerceIn(constraints.minHeight, constraints.maxHeight)
        layout(chosen.width.coerceIn(constraints.minWidth, constraints.maxWidth), height) {
            chosen.placeRelative(0, (height - chosen.height) / 2)
        }
    }
}

/**
 * 换字号时行高按同一比例缩放。安卓 14 起的非线性字体缩放下，Compose 把 sp 行高按「行高 ÷ 字号」的比例
 * 折算到缩放后的字号上：只换字号、不动行高，小一档的字行盒反而更高（200% 字体下 numS 缩到 caption，
 * 行盒由 38.5 变 44，整行被撑高 5px）。按比例缩放后行盒只会变小，格高由首选字号那一行决定。
 */
internal fun TextStyle.v2WithFontSize(size: TextUnit): TextStyle =
    if (lineHeight.isSp && fontSize.isSp && fontSize.value > 0f) {
        copy(fontSize = size, lineHeight = lineHeight * (size.value / fontSize.value))
    } else {
        copy(fontSize = size)
    }

/** [V2FittedValueText] 依次试的字号：先 [preferred]，再沿 [LedgerFont] 的档往下，到 [minimum] 为止。 */
internal fun v2FittedFontSizes(preferred: TextUnit, minimum: TextUnit = LedgerFont.caption): List<TextUnit> {
    val ladder = listOf(
        LedgerFont.display, LedgerFont.displaySmall, LedgerFont.headline, LedgerFont.title,
        LedgerFont.subtitle, LedgerFont.body, LedgerFont.label, LedgerFont.caption
    )
    return listOf(preferred) + ladder.filter { it.value < preferred.value && it.value >= minimum.value }
}

/** 第一个宽度不超过 [maxWidth] 的候选下标；都放不下时返回 null。 */
internal fun v2FirstFittingIndex(widths: List<Int>, maxWidth: Int): Int? =
    widths.indexOfFirst { it <= maxWidth }.takeIf { it >= 0 }

internal enum class V2BadgeTone {
    Neutral,
    Positive,
    Warning,
    Danger,
    Info
}

/**
 * 徽标的底、圆点、字与边（§4.6）。`container` 可能是半透明的 `*Soft`，显示时压在所在表面上；
 * `border` 只有墨水屏有（透明底 + 1dp 黑边，靠边框而不是底色区分）。
 */
@Immutable
internal data class V2BadgeColors(
    val container: Color,
    val dot: Color,
    val content: Color,
    val border: Color?
)

internal fun v2BadgeColors(colors: LedgerColors, tone: V2BadgeTone): V2BadgeColors = when {
    colors.isEInk -> V2BadgeColors(Color.Transparent, colors.text, colors.text, colors.outline)
    tone == V2BadgeTone.Positive -> V2BadgeColors(colors.successSoft, colors.success, colors.successText, null)
    tone == V2BadgeTone.Warning -> V2BadgeColors(colors.warningSoft, colors.warning, colors.warningText, null)
    tone == V2BadgeTone.Danger -> V2BadgeColors(colors.dangerSoft, colors.danger, colors.dangerText, null)
    tone == V2BadgeTone.Info -> V2BadgeColors(colors.primaryContainer, colors.primary, colors.primary, null)
    else -> V2BadgeColors(colors.raised, colors.muted, colors.muted, null)
}

/**
 * 状态徽标（§4.6）：高 24（16 行高 + 2×4）、全圆角、内边距 8×4、6dp 圆点 + 4 + `caption`；
 * 色调 = `*Soft` 底 + `*Text` 字，中性 = `raised` 底 `muted` 字；墨水屏透明底 1dp 黑边、无圆点。
 * 五种调性在深浅色的卡片与页面上都 ≥4.5:1（`Milestone3DenoisingChallengerStressTest`）。
 */
@Composable
internal fun V2StatusBadge(
    palette: MobileV2Palette,
    label: String,
    tone: V2BadgeTone = V2BadgeTone.Neutral,
    modifier: Modifier = Modifier,
    leadingDot: Boolean = true
) {
    val colors = v2BadgeColors(palette.tokens, tone)
    val shape = CircleShape
    Row(
        modifier = modifier
            .clip(shape)
            .background(colors.container)
            .then(colors.border?.let { Modifier.border(LedgerStroke.hairline, it, shape) } ?: Modifier)
            .padding(horizontal = LedgerSpace.sm, vertical = LedgerSpace.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LedgerSpace.xs)
    ) {
        if (leadingDot && !palette.isEInk) {
            Box(
                Modifier
                    .size(LedgerSize.statusDot)
                    .clip(CircleShape)
                    .background(colors.dot)
            )
        }
        Text(
            text = label,
            style = LedgerType.caption,
            color = colors.content,
            maxLines = 1,
            softWrap = false
        )
    }
}

/**
 * 额度三档的图形色（用户决定 V-Q1）：充足 = `primary`（蓝），偏紧 = `warning`，告急 = `danger`；
 * 墨水屏一律 `text`。只定义到原子层：额度条与圆环由 A4 接入，届时取代 `v2SeverityColor` 的绿色取值。
 * 档位词的小字色用 `warningText` / `dangerText`，数字本身不染色（§4.9）。
 */
internal fun v2QuotaBandColor(colors: LedgerColors, severity: QuotaSeverity): Color = when {
    colors.isEInk -> colors.text
    severity == QuotaSeverity.Healthy -> colors.quotaHealthy
    severity == QuotaSeverity.Warning -> colors.quotaWarning
    else -> colors.quotaCritical
}
