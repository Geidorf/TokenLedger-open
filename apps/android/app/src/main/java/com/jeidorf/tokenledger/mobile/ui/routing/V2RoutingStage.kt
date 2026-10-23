package com.jeidorf.tokenledger.mobile.ui.routing

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ledgerTween
import com.jeidorf.tokenledger.mobile.routing.RoutingFlow
import com.jeidorf.tokenledger.mobile.routing.RoutingFlowPhase
import com.jeidorf.tokenledger.mobile.routing.RoutingHopOutcome
import com.jeidorf.tokenledger.mobile.routing.RoutingNode
import com.jeidorf.tokenledger.mobile.routing.RoutingNodeState
import com.jeidorf.tokenledger.mobile.routing.RoutingPlaybackTracker
import com.jeidorf.tokenledger.mobile.routing.RoutingScene
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshots
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.sources.sourceTileInitials
import kotlinx.coroutines.delay

/**
 * 网关舞台（设计文档 docs/design/routing-animation-v1.md 的手机竖排版）：Agent 一排在上，
 * 网关居中，上游成员一列在下；连线从网关下沿弯到左侧竖线再接到各成员行。
 *
 * - 在途：Agent→网关、网关→成员两段虚线流动；成员行描白边，写「应答中…」。
 * - 新出现的已结束流：光点按尝试顺序依次跑，失败的一段变危险色、跑到近处回弹消失。
 * - 最近 [RECENT_LIT_MS] 内结束的最新一条流，连线按结果点亮（成功绿、失败危险色虚线）。
 *   手机读到的快照比桌面晚 5～10 秒，所以停留比桌面的 12 秒长。
 * - 关闭动画（系统设置或墨水屏）时不流动、不跑光点，只保留点亮状态与说明。
 */
internal const val RECENT_LIT_MS = 30_000L

private val AGENT_TILE_HEIGHT = 60.dp
private val AGENT_GAP = 8.dp
private val AGENT_MAX_WIDTH = 96.dp
private val HUB_GAP = 34.dp
private val HUB_HEIGHT = 56.dp
private val HUB_MAX_WIDTH = 150.dp
private val TARGET_TOP_GAP = 26.dp
private val TARGET_ROW_HEIGHT = 40.dp
private val TARGET_ROW_GAP = 6.dp
private val TARGET_INSET = 22.dp
private val GUTTER_X = 8.dp

private const val SEGMENT_MS = 700
private const val SEGMENT_GAP_MS = 250L
private const val MAX_PLAY_MS = 4_000

/** Agent 身份色：图表色 1/2/7/3，不用红绿琥珀，免得和状态混淆（与桌面同序）。 */
internal fun routingAgentColor(palette: MobileV2Palette, index: Int): Color {
    val slots = intArrayOf(0, 1, 6, 2)
    val chart = palette.tokens.chart
    if (palette.isEInk || index !in slots.indices) return palette.muted
    return chart.getOrElse(slots[index]) { palette.muted }
}

private data class StageGeometry(
    val width: Float,
    val height: Float,
    val agentCenters: List<Offset>,
    val agentWidth: Float,
    val hubTop: Float,
    val hubBottom: Float,
    val hubCenterX: Float,
    val hubWidth: Float,
    val targetCenters: List<Offset>,
    val targetLeft: Float,
    val gutterX: Float
)

private fun stageGeometry(widthPx: Float, agents: Int, targets: Int, px: (Dp) -> Float): StageGeometry {
    val agentCount = agents.coerceAtLeast(1)
    // Agent 少时块不拉满整行，按最大宽度居中排。
    val agentWidth = minOf((widthPx - px(AGENT_GAP) * (agentCount - 1)) / agentCount, px(AGENT_MAX_WIDTH))
    val agentRowStart = (widthPx - agentWidth * agentCount - px(AGENT_GAP) * (agentCount - 1)) / 2f
    val agentCenters = List(agents) { index ->
        Offset(agentRowStart + index * (agentWidth + px(AGENT_GAP)) + agentWidth / 2f, px(AGENT_TILE_HEIGHT))
    }
    val hubTop = px(AGENT_TILE_HEIGHT) + px(HUB_GAP)
    val hubBottom = hubTop + px(HUB_HEIGHT)
    val targetTop = hubBottom + px(TARGET_TOP_GAP)
    val rowStep = px(TARGET_ROW_HEIGHT) + px(TARGET_ROW_GAP)
    val targetCenters = List(targets) { index ->
        Offset(px(TARGET_INSET), targetTop + index * rowStep + px(TARGET_ROW_HEIGHT) / 2f)
    }
    val height = if (targets == 0) hubBottom else targetTop + targets * rowStep - px(TARGET_ROW_GAP)
    return StageGeometry(
        width = widthPx,
        height = height,
        agentCenters = agentCenters,
        agentWidth = agentWidth,
        hubTop = hubTop,
        hubBottom = hubBottom,
        hubCenterX = widthPx / 2f,
        hubWidth = minOf(px(HUB_MAX_WIDTH), widthPx * 0.5f),
        targetCenters = targetCenters,
        targetLeft = px(TARGET_INSET),
        gutterX = px(GUTTER_X)
    )
}

private fun agentWire(g: StageGeometry, index: Int): Path = Path().apply {
    val from = g.agentCenters[index]
    moveTo(from.x, from.y)
    val bend = (g.hubTop - from.y) * 0.55f
    cubicTo(from.x, from.y + bend, g.hubCenterX, g.hubTop - bend, g.hubCenterX, g.hubTop)
}

private fun targetWire(g: StageGeometry, index: Int): Path = Path().apply {
    val to = g.targetCenters[index]
    moveTo(g.hubCenterX, g.hubBottom)
    val curveEnd = minOf(to.y, g.hubBottom + (g.targetCenters.first().y - g.hubBottom) * 0.7f)
    cubicTo(g.hubCenterX, g.hubBottom + 16f, g.gutterX, g.hubBottom + 6f, g.gutterX, curveEnd)
    lineTo(g.gutterX, to.y)
    lineTo(to.x, to.y)
}

/** 播放中的一条流：第几段、段内进度、这段的颜色与是否失败回弹。 */
private data class PlayingDot(val path: Path, val progress: Float, val color: Color, val bounce: Boolean)

@Composable
internal fun V2RoutingStage(
    palette: MobileV2Palette,
    scene: RoutingScene,
    nowServerMs: Long,
    modifier: Modifier = Modifier
) {
    val motion = ledgerMotionEnabled(palette.isEInk)
    val agentIndex = scene.agents.withIndex().associate { (index, node) -> node.id to index }
    val targetIndex = scene.targets.withIndex().associate { (index, node) -> node.id to index }
    val agentColor = { agent: String -> agentIndex[agent]?.let { routingAgentColor(palette, it) } ?: palette.muted }
    val latest = scene.flows.firstOrNull { it.phase != RoutingFlowPhase.Inflight }
        ?.takeIf { nowServerMs - it.atServerMs in 0 until RECENT_LIT_MS }
    val inflight = scene.flows.filter { it.phase == RoutingFlowPhase.Inflight }

    // 虚线流动用帧时钟推相位（0.7 秒一周期），不经 tween：关动画时根本不跑。
    var dash by remember { mutableFloatStateOf(0f) }
    val animateDash = motion && inflight.isNotEmpty()
    LaunchedEffect(animateDash) {
        dash = 0f
        if (!animateDash) return@LaunchedEffect
        while (true) {
            withFrameMillis { ms -> dash = -18f * ((ms % SEGMENT_MS) / SEGMENT_MS.toFloat()) }
        }
    }

    // 新出现的流排队依次播放；只在动画开启时跑光点。
    val tracker = remember { RoutingPlaybackTracker() }
    var playing by remember { mutableStateOf<Pair<RoutingFlow, Float>?>(null) }
    val queue = remember { ArrayDeque<RoutingFlow>() }
    val currentNow by rememberUpdatedState(nowServerMs)
    val flowIds = scene.flows.joinToString(",") { it.id }
    LaunchedEffect(flowIds, scene.playable) {
        val fresh = tracker.takeNew(scene, currentNow)
        if (motion) queue.addAll(fresh)
    }
    LaunchedEffect(motion) {
        if (!motion) return@LaunchedEffect
        val progress = Animatable(0f)
        while (true) {
            val next = queue.removeFirstOrNull()
            if (next == null) {
                delay(250L)
                continue
            }
            val segments = 1 + next.hops.size
            val perSegment = minOf(SEGMENT_MS.toLong(), MAX_PLAY_MS / segments.toLong()).toInt()
            for (segment in 0 until segments) {
                progress.snapTo(0f)
                playing = next to segment.toFloat()
                progress.animateTo(1f, ledgerTween(perSegment, motion, easing = LinearEasing)) {
                    playing = next to (segment + value)
                }
                delay(SEGMENT_GAP_MS.coerceAtMost(perSegment / 2L))
            }
            playing = null
        }
    }

    BoxWithConstraints(modifier.fillMaxWidth()) {
        val density = LocalDensity.current
        val px = { dp: Dp -> with(density) { dp.toPx() } }
        val widthPx = with(density) { maxWidth.toPx() }
        val g = remember(widthPx, scene.agents.size, scene.targets.size, density) {
            stageGeometry(widthPx, scene.agents.size, scene.targets.size, px)
        }
        val heightDp = with(density) { g.height.toDp() }
        val agentWidthDp = with(density) { g.agentWidth.toDp() }
        val summary = stageSummary(scene)

        Box(
            Modifier
                .fillMaxWidth()
                .height(heightDp)
                .clearAndSetSemantics { contentDescription = summary }
        ) {
            Canvas(Modifier.fillMaxSize()) {
                val idle = palette.divider
                val thin = Stroke(width = 1.25.dp.toPx(), cap = StrokeCap.Round)
                val flowing = { color: Color, path: Path ->
                    drawPath(
                        path,
                        color,
                        style = Stroke(
                            width = 1.5.dp.toPx(),
                            cap = StrokeCap.Round,
                            pathEffect = PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 4.dp.toPx()), dash.dp.toPx())
                        )
                    )
                }
                scene.agents.indices.forEach { drawPath(agentWire(g, it), idle, style = thin) }
                scene.targets.indices.forEach { drawPath(targetWire(g, it), idle, style = thin) }

                // 最近结束的一条：按结果点亮。
                latest?.let { flow ->
                    agentIndex[flow.agent]?.let { drawPath(agentWire(g, it), agentColor(flow.agent), style = Stroke(1.5.dp.toPx(), cap = StrokeCap.Round)) }
                    flow.hops.forEach { hop ->
                        val index = targetIndex[hop.target] ?: return@forEach
                        val ok = hop.outcome == RoutingHopOutcome.Ok
                        drawPath(
                            targetWire(g, index),
                            if (ok) palette.tokens.success else palette.tokens.danger,
                            style = Stroke(
                                width = 1.5.dp.toPx(),
                                cap = StrokeCap.Round,
                                pathEffect = if (ok) null else PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx()))
                            )
                        )
                    }
                }
                // 在途：两段虚线流动。
                inflight.forEach { flow ->
                    val color = agentColor(flow.agent)
                    agentIndex[flow.agent]?.let { flowing(color, agentWire(g, it)) }
                    flow.hops.forEach { hop -> targetIndex[hop.target]?.let { flowing(color, targetWire(g, it)) } }
                }
                playing?.let { (flow, position) ->
                    playingDot(g, flow, position, agentIndex, targetIndex, agentColor(flow.agent), palette)?.let { drawDot(it) }
                }
            }

            scene.agents.forEachIndexed { index, node ->
                val center = g.agentCenters[index]
                V2RoutingAgentTile(
                    palette = palette,
                    node = node,
                    color = routingAgentColor(palette, index),
                    modifier = Modifier
                        .offset(x = with(density) { (center.x - g.agentWidth / 2f).toDp() })
                        .width(agentWidthDp)
                        .height(AGENT_TILE_HEIGHT)
                )
            }
            V2RoutingHub(
                palette = palette,
                scene = scene,
                busy = inflight.isNotEmpty(),
                modifier = Modifier
                    .offset(
                        x = with(density) { (g.hubCenterX - g.hubWidth / 2f).toDp() },
                        y = with(density) { g.hubTop.toDp() }
                    )
                    .width(with(density) { g.hubWidth.toDp() })
                    .height(HUB_HEIGHT)
            )
            scene.targets.forEachIndexed { index, node ->
                val center = g.targetCenters[index]
                val lit = latest?.hops?.any { it.target == node.id && it.outcome == RoutingHopOutcome.Ok } == true
                V2RoutingTargetRow(
                    palette = palette,
                    node = node,
                    lit = lit,
                    modifier = Modifier
                        .offset(
                            x = TARGET_INSET,
                            y = with(density) { (center.y - px(TARGET_ROW_HEIGHT) / 2f).toDp() }
                        )
                        .width(with(density) { (g.width - g.targetLeft).toDp() })
                        .height(TARGET_ROW_HEIGHT)
                )
            }
        }
    }
}

private fun playingDot(
    g: StageGeometry,
    flow: RoutingFlow,
    position: Float,
    agentIndex: Map<String, Int>,
    targetIndex: Map<String, Int>,
    color: Color,
    palette: MobileV2Palette
): PlayingDot? {
    val segment = position.toInt()
    val progress = position - segment
    if (segment == 0) {
        // 折叠进 +N 的 Agent 从折叠节点出发。
        val index = agentIndex[flow.agent] ?: agentIndex[RoutingSnapshots.FOLDED_AGENTS] ?: return null
        return PlayingDot(agentWire(g, index), progress, color, bounce = false)
    }
    val hop = flow.hops.getOrNull(segment - 1) ?: return null
    val index = targetIndex[hop.target] ?: targetIndex[RoutingSnapshots.FOLDED_TARGETS] ?: return null
    val ok = hop.outcome == RoutingHopOutcome.Ok || hop.outcome == RoutingHopOutcome.Pending
    return PlayingDot(targetWire(g, index), progress, if (ok) color else palette.tokens.danger, bounce = !ok)
}

private fun DrawScope.drawDot(dot: PlayingDot) {
    val measure = PathMeasure()
    measure.setPath(dot.path, false)
    val length = measure.length
    if (length <= 0f) return
    // 失败的一段跑到 85% 处回弹并淡出。
    val travel = if (dot.bounce) {
        if (dot.progress < 0.7f) dot.progress / 0.7f * 0.85f else 0.85f - (dot.progress - 0.7f) / 0.3f * 0.15f
    } else dot.progress
    val alpha = if (dot.bounce && dot.progress > 0.7f) 1f - (dot.progress - 0.7f) / 0.3f else 1f
    val point = measure.getPosition(travel * length)
    drawCircle(dot.color.copy(alpha = alpha * 0.25f), radius = 7.dp.toPx(), center = point)
    drawCircle(dot.color.copy(alpha = alpha), radius = 3.5.dp.toPx(), center = point)
}

private fun stageSummary(scene: RoutingScene): String {
    val agents = scene.agents.filter { it.more == null }.joinToString("、") { it.label }
    val busy = scene.targets.filter { it.state == RoutingNodeState.Busy }.joinToString("、") { it.label }
    val failed = scene.targets.filter { it.state == RoutingNodeState.Failed }.joinToString("、") { node ->
        node.label + (node.status?.let { " 返回 $it" } ?: " 失败")
    }
    return buildString {
        append("网关路由：")
        append(if (agents.isEmpty()) "暂无 Agent" else "Agent $agents")
        if (busy.isNotEmpty()) append("；正在应答：$busy")
        if (failed.isNotEmpty()) append("；最近失败：$failed")
    }
}

@Composable
private fun V2RoutingAgentTile(palette: MobileV2Palette, node: RoutingNode, color: Color, modifier: Modifier) {
    val shape = RoundedCornerShape(LedgerRadius.xl)
    val folded = node.more != null
    Column(
        modifier = modifier
            .background(palette.surfaceContainerLow, shape)
            .border(LedgerStroke.hairline, if (node.state == RoutingNodeState.Busy) color else palette.divider, shape)
            .padding(horizontal = 4.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically)
    ) {
        Box(
            Modifier
                .size(24.dp)
                .background(if (palette.isEInk || folded) Color.Transparent else color.copy(alpha = 0.18f), RoundedCornerShape(LedgerRadius.md))
                .then(if (palette.isEInk) Modifier.border(LedgerStroke.hairline, palette.text, RoundedCornerShape(LedgerRadius.md)) else Modifier),
            contentAlignment = Alignment.Center
        ) {
            Text(
                if (folded) node.label else sourceTileInitials(node.label),
                color = if (palette.isEInk || folded) palette.text else color,
                fontSize = LedgerFont.caption,
                fontWeight = FontWeight.Bold,
                maxLines = 1
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (!folded) Box(Modifier.size(6.dp).background(color, CircleShape))
            Text(
                if (folded) "更多" else node.label,
                color = palette.text,
                style = LedgerType.caption,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
private fun V2RoutingHub(palette: MobileV2Palette, scene: RoutingScene, busy: Boolean, modifier: Modifier) {
    val shape = RoundedCornerShape(LedgerRadius.xl + 2.dp)
    val liveSources = scene.devices.filter { it.live }.flatMap { it.sources }.filter { it.reachable }.map { it.id.label }.distinct()
    Column(
        modifier = modifier
            .background(palette.surface, shape)
            .border(1.5.dp, if (busy || scene.playable) palette.text else palette.divider, shape)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically)
    ) {
        Text("网关", color = palette.text, style = LedgerType.titleS, maxLines = 1)
        Text(
            if (liveSources.isEmpty()) "未连接" else liveSources.joinToString(" · "),
            color = palette.muted,
            style = LedgerType.caption,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

/** 成员行的右侧状态词。 */
internal fun routingTargetStatus(node: RoutingNode): String = when (node.state) {
    RoutingNodeState.Busy -> "应答中…"
    RoutingNodeState.Ok -> "正常"
    RoutingNodeState.Failed -> when (node.status) {
        null -> "失败"
        429 -> "限流 · 429"
        else -> "返回 ${node.status}"
    }
    RoutingNodeState.Idle -> if (node.more != null) "其余成员" else "已跳过"
}

@Composable
private fun V2RoutingTargetRow(palette: MobileV2Palette, node: RoutingNode, lit: Boolean, modifier: Modifier) {
    val shape = RoundedCornerShape(LedgerRadius.xl)
    val active = node.state == RoutingNodeState.Busy || lit
    val failed = node.state == RoutingNodeState.Failed
    val provider = node.label.substringBefore('/')
    val model = node.label.substringAfter('/', "")
    Row(
        modifier = modifier
            .background(if (active) palette.surfaceContainer else Color.Transparent, shape)
            .then(
                if (failed) Modifier.dashedBorder(palette.tokens.danger.copy(alpha = 0.7f), shape)
                else Modifier.border(if (active) 1.5.dp else LedgerStroke.hairline, if (active) palette.text else palette.divider, shape)
            )
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Box(
            Modifier
                .size(10.dp)
                .then(
                    if (active) Modifier.background(palette.text, CircleShape)
                    else Modifier.border(1.5.dp, palette.muted, CircleShape)
                )
        )
        Text(
            if (node.more != null) node.label else provider,
            color = if (failed) palette.muted else palette.text,
            style = LedgerType.label,
            maxLines = 1
        )
        Text(
            model,
            color = palette.muted,
            style = LedgerType.meta,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f)
        )
        Text(
            routingTargetStatus(node),
            color = when {
                failed -> palette.danger
                active -> palette.text
                else -> palette.muted
            },
            style = LedgerType.meta,
            maxLines = 1
        )
    }
}

private fun Modifier.dashedBorder(color: Color, shape: Shape): Modifier = drawBehind {
    val path = Path().apply { addOutline(shape.createOutline(size, layoutDirection, this@drawBehind)) }
    drawPath(
        path,
        color,
        style = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())))
    )
}
