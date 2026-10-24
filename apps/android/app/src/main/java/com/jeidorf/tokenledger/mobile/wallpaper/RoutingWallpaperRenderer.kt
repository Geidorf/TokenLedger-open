package com.jeidorf.tokenledger.mobile.wallpaper

import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.graphics.RectF
import android.graphics.Typeface
import androidx.compose.ui.graphics.toArgb
import com.jeidorf.tokenledger.mobile.routing.RoutingFlow
import com.jeidorf.tokenledger.mobile.routing.RoutingFlowPhase
import com.jeidorf.tokenledger.mobile.routing.RoutingHopOutcome
import com.jeidorf.tokenledger.mobile.routing.RoutingNode
import com.jeidorf.tokenledger.mobile.routing.RoutingNodeState
import com.jeidorf.tokenledger.mobile.routing.RoutingScene
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshots
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerColors
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerPalettes

/**
 * 用 Canvas 画锁屏动态壁纸：Agent（左）→ 网关（中）→ 供应商/模型（右），结构与桌面路由舞台一致。
 * 舞台放在屏幕中段，避开锁屏顶部时钟与底部快捷入口。颜色取自设计令牌，不另起一套。
 */
internal class RoutingWallpaperRenderer(private val density: Float) {
    private var colors: LedgerColors = LedgerPalettes.Dark
    private var agentColors: IntArray = intArrayOf()

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.DEFAULT }
    private val path = Path()
    private val measure = PathMeasure()
    private val pos = FloatArray(2)
    private val rect = RectF()

    fun setDark(dark: Boolean) {
        colors = if (dark) LedgerPalettes.Dark else LedgerPalettes.Light
        // 设计文档：Agent 用 chart-1/2/7/3，避开红绿琥珀以免和状态混淆。
        agentColors = intArrayOf(0, 1, 6, 2).map { colors.chart[it].toArgb() }.toIntArray()
    }

    init {
        setDark(true)
    }

    private fun dp(value: Float) = value * density

    private data class Layout(
        val hubX: Float,
        val hubY: Float,
        val hubRadius: Float,
        val nodeWidth: Float,
        val nodeHeight: Float,
        val agents: Map<String, Pair<Float, Float>>,
        val targets: Map<String, Pair<Float, Float>>,
    )

    private fun layout(scene: RoutingScene, width: Float, height: Float): Layout {
        val padding = dp(16f)
        val nodeWidth = ((width - padding * 2) * 0.34f).coerceAtMost(dp(168f))
        val nodeHeight = dp(34f)
        val gap = dp(52f)
        val centerY = height * 0.52f
        fun column(ids: List<String>, x: Float): Map<String, Pair<Float, Float>> {
            val top = centerY - (ids.size - 1) * gap / 2f
            return ids.mapIndexed { index, id -> id to (x to top + index * gap) }.toMap()
        }
        return Layout(
            hubX = width / 2f,
            hubY = centerY,
            hubRadius = dp(22f),
            nodeWidth = nodeWidth,
            nodeHeight = nodeHeight,
            agents = column(scene.agents.map { it.id }, padding + nodeWidth / 2f),
            targets = column(scene.targets.map { it.id }, width - padding - nodeWidth / 2f),
        )
    }

    fun draw(canvas: Canvas, frame: WallpaperFrame, nowElapsedMs: Long) {
        val width = canvas.width.toFloat()
        val height = canvas.height.toFloat()
        canvas.drawColor(colors.chrome.toArgb())

        val scene = frame.scene
        val stageTop = height * 0.30f
        drawStatus(canvas, frame.status, width, stageTop)
        if (scene == null || scene.agents.isEmpty() && scene.targets.isEmpty()) {
            drawHubOnly(canvas, width, height, frame)
            frame.caption?.let { drawCaption(canvas, it, width, height * 0.52f + dp(80f)) }
            return
        }
        val layout = layout(scene, width, height)

        // 空闲连线：每个 Agent 与每个上游都连到网关。
        stroke.pathEffect = null
        stroke.strokeWidth = dp(1.25f)
        stroke.color = withAlpha(colors.outline.toArgb(), 0x55)
        layout.agents.values.forEach { (x, y) -> drawWire(canvas, x + layout.nodeWidth / 2f, y, layout.hubX - layout.hubRadius, layout.hubY) }
        layout.targets.values.forEach { (x, y) -> drawWire(canvas, layout.hubX + layout.hubRadius, layout.hubY, x - layout.nodeWidth / 2f, y) }

        // 停留：按结果点亮（成功绿色、失败危险色虚线）。
        frame.lit.forEach { lit -> drawFlowWires(canvas, layout, scene, lit.flow, if (lit.ok) colors.success.toArgb() else colors.danger.toArgb(), dashed = !lit.ok, phase = 0f) }

        // 在途：两段连线虚线流动，网关外圈脉冲。
        val dashPhase = (nowElapsedMs % WallpaperTimeline.DASH_PERIOD_MS).toFloat() / WallpaperTimeline.DASH_PERIOD_MS
        if (frame.inflight) {
            scene.flows.filter { it.phase == RoutingFlowPhase.Inflight }.forEach { flow ->
                drawFlowWires(canvas, layout, scene, flow, colors.warning.toArgb(), dashed = true, phase = dashPhase)
            }
            val pulse = (nowElapsedMs % 1_400L).toFloat() / 1_400f
            stroke.pathEffect = null
            stroke.strokeWidth = dp(2f)
            stroke.color = withAlpha(colors.primary.toArgb(), ((1f - pulse) * 160).toInt())
            canvas.drawCircle(layout.hubX, layout.hubY, layout.hubRadius + dp(4f) + pulse * dp(14f), stroke)
        }

        drawHub(canvas, layout.hubX, layout.hubY, layout.hubRadius)
        scene.agents.forEachIndexed { index, node ->
            val (x, y) = layout.agents.getValue(node.id)
            drawNode(canvas, node, x, y, layout, if (node.more == null) agentColors[index % agentColors.size] else colors.faint.toArgb())
        }
        scene.targets.forEach { node ->
            val (x, y) = layout.targets.getValue(node.id)
            drawNode(canvas, node, x, y, layout, null)
        }

        frame.active?.let { drawDot(canvas, layout, scene, it) }

        val lowestNode = (layout.agents.values + layout.targets.values).maxOfOrNull { it.second } ?: layout.hubY
        val stageBottom = maxOf(lowestNode + layout.nodeHeight / 2f, layout.hubY + layout.hubRadius)
        frame.caption?.let { drawCaption(canvas, it, width, stageBottom + dp(28f)) }
        drawStats(canvas, scene, width, stageBottom + dp(56f))
    }

    private fun drawStatus(canvas: Canvas, status: StatusLine, width: Float, y: Float) {
        text.textAlign = Paint.Align.CENTER
        text.textSize = dp(13f)
        text.color = when (status.tone) {
            StatusTone.Live -> colors.success.toArgb()
            StatusTone.Warning -> colors.warning.toArgb()
            StatusTone.Neutral -> colors.muted.toArgb()
        }
        canvas.drawText(fit(status.text, width - dp(32f)), width / 2f, y, text)
        text.textSize = dp(11f)
        text.color = colors.faint.toArgb()
        canvas.drawText("TOKENLEDGER · 网关路由", width / 2f, y - dp(22f), text)
    }

    private fun drawHubOnly(canvas: Canvas, width: Float, height: Float, frame: WallpaperFrame) {
        drawHub(canvas, width / 2f, height * 0.52f, dp(22f))
        if (frame.scene?.playable == true) {
            text.textAlign = Paint.Align.CENTER
            text.textSize = dp(12f)
            text.color = colors.faint.toArgb()
            canvas.drawText("有请求时这里会实时流动", width / 2f, height * 0.52f + dp(48f), text)
        }
    }

    private fun drawHub(canvas: Canvas, x: Float, y: Float, radius: Float) {
        fill.color = colors.primaryFill.toArgb()
        canvas.drawCircle(x, y, radius, fill)
        text.textAlign = Paint.Align.CENTER
        text.textSize = dp(11f)
        text.color = colors.onPrimaryFill.toArgb()
        canvas.drawText("网关", x, y + dp(4f), text)
    }

    private fun drawNode(canvas: Canvas, node: RoutingNode, x: Float, y: Float, layout: Layout, accent: Int?) {
        rect.set(x - layout.nodeWidth / 2f, y - layout.nodeHeight / 2f, x + layout.nodeWidth / 2f, y + layout.nodeHeight / 2f)
        fill.color = colors.card.toArgb()
        canvas.drawRoundRect(rect, dp(10f), dp(10f), fill)
        stroke.pathEffect = null
        stroke.strokeWidth = dp(1f)
        stroke.color = if (node.state == RoutingNodeState.Failed) colors.danger.toArgb() else colors.cardBorder.toArgb()
        canvas.drawRoundRect(rect, dp(10f), dp(10f), stroke)

        val dotX = rect.left + dp(12f)
        fill.color = accent ?: when (node.state) {
            RoutingNodeState.Ok -> colors.success.toArgb()
            RoutingNodeState.Failed -> colors.danger.toArgb()
            RoutingNodeState.Busy -> colors.warning.toArgb()
            RoutingNodeState.Idle -> colors.faint.toArgb()
        }
        canvas.drawCircle(dotX, y, dp(3.5f), fill)

        text.textAlign = Paint.Align.LEFT
        text.textSize = dp(12f)
        text.color = colors.text.toArgb()
        val tag = node.status?.takeIf { node.state == RoutingNodeState.Failed }?.toString()
        val tagWidth = tag?.let { text.measureText(it) + dp(8f) } ?: 0f
        canvas.drawText(fitLabel(node.label, rect.right - dotX - dp(10f) - tagWidth), dotX + dp(8f), y + dp(4f), text)
        if (tag != null) {
            text.textAlign = Paint.Align.RIGHT
            text.color = colors.dangerText.toArgb()
            canvas.drawText(tag, rect.right - dp(8f), y + dp(4f), text)
        }
    }

    /** 一条流经过的连线：Agent→网关，以及网关→它尝试过的每个成员（折叠的落到 +N）。 */
    private fun drawFlowWires(canvas: Canvas, layout: Layout, scene: RoutingScene, flow: RoutingFlow, color: Int, dashed: Boolean, phase: Float) {
        stroke.strokeWidth = dp(2f)
        stroke.color = color
        stroke.pathEffect = if (dashed) DashPathEffect(floatArrayOf(dp(6f), dp(5f)), -phase * dp(11f)) else null
        agentPoint(layout, scene, flow)?.let { (x, y) -> drawWire(canvas, x + layout.nodeWidth / 2f, y, layout.hubX - layout.hubRadius, layout.hubY) }
        flow.hops.forEach { hop ->
            targetPoint(layout, scene, hop.target)?.let { (x, y) -> drawWire(canvas, layout.hubX + layout.hubRadius, layout.hubY, x - layout.nodeWidth / 2f, y) }
        }
        stroke.pathEffect = null
    }

    private fun drawDot(canvas: Canvas, layout: Layout, scene: RoutingScene, active: ActivePlay) {
        val flow = active.flow
        val agentColor = scene.agents.indexOfFirst { it.id == flow.agent }
            .takeIf { it >= 0 }?.let { agentColors[it % agentColors.size] } ?: colors.primary.toArgb()
        var progress = active.progress
        val color: Int
        if (active.segment == 0) {
            val (x, y) = agentPoint(layout, scene, flow) ?: return
            setWire(x + layout.nodeWidth / 2f, y, layout.hubX - layout.hubRadius, layout.hubY)
            color = agentColor
        } else {
            val hop = flow.hops.getOrNull(active.segment - 1) ?: return
            val (x, y) = targetPoint(layout, scene, hop.target) ?: return
            setWire(layout.hubX + layout.hubRadius, layout.hubY, x - layout.nodeWidth / 2f, y)
            color = when (hop.outcome) {
                RoutingHopOutcome.Ok -> colors.success.toArgb()
                RoutingHopOutcome.Skipped -> colors.faint.toArgb()
                RoutingHopOutcome.Pending -> agentColor
                RoutingHopOutcome.Failed, RoutingHopOutcome.Rejected -> {
                    progress = WallpaperTimeline.failedPosition(progress)
                    colors.danger.toArgb()
                }
            }
        }
        measure.setPath(path, false)
        measure.getPosTan(measure.length * progress.coerceIn(0f, 1f), pos, null)
        fill.color = withAlpha(color, 0x55)
        canvas.drawCircle(pos[0], pos[1], dp(7f), fill)
        fill.color = color
        canvas.drawCircle(pos[0], pos[1], dp(3.5f), fill)
    }

    private fun drawCaption(canvas: Canvas, caption: String, width: Float, y: Float) {
        text.textAlign = Paint.Align.CENTER
        text.textSize = dp(12f)
        text.color = colors.muted.toArgb()
        canvas.drawText(fit(caption, width - dp(32f)), width / 2f, y, text)
    }

    private fun drawStats(canvas: Canvas, scene: RoutingScene, width: Float, y: Float) {
        val stats = scene.stats
        text.textAlign = Paint.Align.CENTER
        text.textSize = dp(11f)
        text.color = colors.faint.toArgb()
        canvas.drawText("在途 ${stats.inflight} · 已改道 ${stats.rerouted} · 失败 ${stats.failed}", width / 2f, y, text)
    }

    private fun agentPoint(layout: Layout, scene: RoutingScene, flow: RoutingFlow): Pair<Float, Float>? =
        layout.agents[flow.agent] ?: layout.agents[RoutingSnapshots.FOLDED_AGENTS].takeIf { scene.agents.any { it.more != null } }

    private fun targetPoint(layout: Layout, scene: RoutingScene, target: String): Pair<Float, Float>? =
        layout.targets[target] ?: layout.targets[RoutingSnapshots.FOLDED_TARGETS].takeIf { scene.targets.any { it.more != null } }

    private fun setWire(x1: Float, y1: Float, x2: Float, y2: Float) {
        val mid = (x1 + x2) / 2f
        path.reset()
        path.moveTo(x1, y1)
        path.cubicTo(mid, y1, mid, y2, x2, y2)
    }

    private fun drawWire(canvas: Canvas, x1: Float, y1: Float, x2: Float, y2: Float) {
        setWire(x1, y1, x2, y2)
        canvas.drawPath(path, stroke)
    }

    /** 保留尾部（模型名不同的部分通常在后面），中间用省略号。 */
    private fun fitLabel(label: String, maxWidth: Float): String {
        if (text.measureText(label) <= maxWidth) return label
        var keep = label.length - 1
        while (keep > 2) {
            val head = (keep - 1) / 2
            val candidate = label.take(head) + "…" + label.takeLast(keep - head)
            if (text.measureText(candidate) <= maxWidth) return candidate
            keep--
        }
        return "…"
    }

    private fun fit(value: String, maxWidth: Float): String {
        if (text.measureText(value) <= maxWidth) return value
        var end = value.length
        while (end > 1 && text.measureText(value, 0, end) + text.measureText("…") > maxWidth) end--
        return value.take(end) + "…"
    }

    private fun withAlpha(color: Int, alpha: Int): Int = (color and 0x00FFFFFF) or (alpha.coerceIn(0, 255) shl 24)
}
