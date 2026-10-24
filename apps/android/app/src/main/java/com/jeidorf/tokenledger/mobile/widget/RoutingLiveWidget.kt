package com.jeidorf.tokenledger.mobile.widget

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.text.TextPaint
import android.text.TextUtils
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.jeidorf.tokenledger.mobile.MainActivity
import com.jeidorf.tokenledger.mobile.SessionStore
import com.jeidorf.tokenledger.mobile.routing.RoutingNodeState
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerPalettes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 「实时路由」桌面小组件（4×3，最小 4×2）：上面一帧路由图（Agent → 网关 → 供应商/模型，10 分钟内的
 * 调用按结果点亮），下面最近 3 条调用。Glance 不能逐帧动画，所以是「近实时静态帧」：数据由
 * [RoutingLiveScheduler] 每几分钟读一次，卡头如实写多久前读的。主题按实例配置读取。
 */
internal class RoutingLiveWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val appContext = context.applicationContext
        val appWidgetId = runCatching {
            GlanceAppWidgetManager(appContext).getAppWidgetId(id)
        }.getOrNull()
        val theme = appWidgetId
            ?.let { WidgetConfigStore.load(appContext, it).theme }
            ?: WidgetThemeMode.System
        val state = withContext(Dispatchers.IO) {
            val session = runCatching { SessionStore(appContext).load() }.getOrNull()
            if (session == null) RoutingLiveWidgetState.NeedLogin
            else RoutingLiveWidgetState.Ready(RoutingLiveStore.load(appContext, session.userId))
        }
        provideContent { RoutingLiveBody(state, theme, System.currentTimeMillis()) }
    }
}

internal sealed interface RoutingLiveWidgetState {
    data object NeedLogin : RoutingLiveWidgetState
    data class Ready(val snapshot: RoutingLiveSnapshot?) : RoutingLiveWidgetState
}

internal class RoutingLiveWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget get() = RoutingLiveWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        runCatching { WidgetScheduler.ensurePeriodicRefresh(context) }
        runCatching { RoutingLiveScheduler.enqueueNow(context) }
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: android.appwidget.AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        runCatching { WidgetScheduler.ensurePeriodicRefresh(context) }
        runCatching { RoutingLiveScheduler.enqueueNow(context) }
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        appWidgetIds.forEach { WidgetConfigStore.remove(context, it) }
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        runCatching { RoutingLiveScheduler.cancel(context) }
        runCatching {
            if (shouldCancelWidgetRefresh(WidgetConfigStore.backgroundConsumerCount(context))) {
                WidgetScheduler.cancelPeriodicRefresh(context)
            }
        }
    }
}

@Composable
private fun RoutingLiveBody(state: RoutingLiveWidgetState, theme: WidgetThemeMode, nowEpochMs: Long) {
    val colors = rememberWidgetColors(theme)
    val size = LocalSize.current
    val fontScale = LocalContext.current.resources.configuration.fontScale
    val view = (state as? RoutingLiveWidgetState.Ready)?.let { routingLiveView(it.snapshot, nowEpochMs) }
    val description = view?.let(::routingLiveAccessibility) ?: "实时路由；需要登录；双击打开 TokenLedger"
    CompositionLocalProvider(LocalWidgetColors provides colors) {
        Box(
            GlanceModifier.fillMaxSize()
                .appWidgetBackground()
                .background(colors.background)
                .widgetContainerCorner()
                .clickable(actionStartActivity<MainActivity>())
                .semantics { contentDescription = description }
                .padding(
                    horizontal = WidgetMetrics.horizontalPadding(size.width),
                    vertical = WidgetMetrics.verticalPadding(size.height)
                ),
            contentAlignment = Alignment.Center
        ) {
            val plan = routingLiveLayout(size.width.value, size.height.value, fontScale)
            when {
                view == null -> LiveCenterMessage("! 需要登录", "打开 TokenLedger 登录后显示实时路由")
                !plan.sufficient -> LiveCenterMessage("尺寸不足", "请放大以显示实时路由")
                else -> RoutingLiveCard(view, plan, colors)
            }
        }
    }
}

@Composable
private fun RoutingLiveCard(view: RoutingLiveView, plan: RoutingLiveLayout, colors: WidgetColors) {
    val context = LocalContext.current
    val size = LocalSize.current
    Column(GlanceModifier.fillMaxSize()) {
        Row(
            GlanceModifier.fillMaxWidth().height(plan.headerHeightDp.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            LiveText("实时路由", colors.text, 12.sp, FontWeight.Bold)
            Spacer(GlanceModifier.width(8.dp))
            Box(GlanceModifier.size(6.dp).cornerRadius(4.dp).background(liveToneColor(colors, view.statusTone))) {}
            Spacer(GlanceModifier.width(4.dp))
            LiveText(
                view.status,
                if (view.statusTone == WidgetRoutingTone.Warning) colors.amber else colors.muted,
                10.sp,
                modifier = GlanceModifier.defaultWeight()
            )
        }
        if (plan.showFrame && view.agents != null) {
            val density = context.resources.displayMetrics.density
            val widthDp = WidgetMetrics.innerWidthDp(size.width.value)
            val bitmap = remember(view, plan.frameHeightDp, widthDp, colors.night, density) {
                RoutingLiveFrameRenderer.render(view, widthDp, plan.frameHeightDp, density, colors.night)
            }
            Image(
                ImageProvider(bitmap), contentDescription = null,
                modifier = GlanceModifier.fillMaxWidth().height(plan.frameHeightDp.dp),
                contentScale = ContentScale.FillBounds
            )
        }
        if (view.rows.isEmpty()) {
            LiveText(view.emptyText ?: "暂无请求", colors.muted, 11.sp, maxLines = 2,
                modifier = GlanceModifier.fillMaxWidth().padding(top = 4.dp))
        } else {
            view.rows.take(plan.rowCount).forEach { row -> RoutingLiveRowLine(row, plan.rowHeightDp, colors) }
        }
    }
}

@Composable
private fun RoutingLiveRowLine(row: RoutingLiveRow, heightDp: Float, colors: WidgetColors) {
    Row(
        GlanceModifier.fillMaxWidth().height(heightDp.dp).semantics { contentDescription = row.accessibility },
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(GlanceModifier.size(6.dp).cornerRadius(4.dp).background(liveToneColor(colors, row.tone))) {}
        Spacer(GlanceModifier.width(6.dp))
        LiveText(
            row.text,
            if (row.tone == WidgetRoutingTone.Failed) colors.danger else colors.text,
            11.sp, FontWeight.Medium, modifier = GlanceModifier.defaultWeight()
        )
        if (row.rerouted) {
            LiveText("已切换", colors.amber, 10.sp)
            Spacer(GlanceModifier.width(6.dp))
        }
        LiveText(row.ago, colors.muted, 10.sp, align = TextAlign.End)
    }
}

@Composable
private fun LiveCenterMessage(title: String, subtitle: String) {
    val colors = LocalWidgetColors.current
    Column(
        GlanceModifier.fillMaxSize(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        LiveText(title, colors.text, 14.sp, FontWeight.Bold, align = TextAlign.Center)
        Spacer(GlanceModifier.height(4.dp))
        LiveText(subtitle, colors.muted, 11.sp, maxLines = 2, align = TextAlign.Center)
    }
}

@Composable
private fun LiveText(
    text: String,
    color: ColorProvider,
    fontSize: TextUnit,
    weight: FontWeight = FontWeight.Normal,
    maxLines: Int = 1,
    align: TextAlign = TextAlign.Start,
    modifier: GlanceModifier = GlanceModifier
) {
    Text(
        text = text,
        maxLines = maxLines,
        modifier = modifier,
        style = TextStyle(color = color, fontSize = fontSize, fontWeight = weight, textAlign = align)
    )
}

private fun liveToneColor(colors: WidgetColors, tone: WidgetRoutingTone): ColorProvider = when (tone) {
    WidgetRoutingTone.Ok -> colors.green
    WidgetRoutingTone.Failed -> colors.danger
    WidgetRoutingTone.Warning -> colors.amber
    WidgetRoutingTone.Neutral -> colors.faint
}

/**
 * 路由帧位图：结构与路由页舞台、锁屏壁纸一致（Agent 左、网关中、上游右），颜色全部取设计令牌。
 * 空闲连线淡描；10 分钟内的调用按结果点亮：成功绿色实线，失败（含改道前失败的那一跳）危险色虚线。
 * 位图按实际像素尺寸画，避免 Launcher 拉伸后文字发虚。
 */
internal object RoutingLiveFrameRenderer {
    fun render(view: RoutingLiveView, widthDp: Float, heightDp: Float, density: Float, night: Boolean): Bitmap {
        val scale = density.coerceIn(1f, 3f)
        val width = (widthDp * scale).toInt().coerceAtLeast(1)
        val height = (heightDp * scale).toInt().coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        draw(Canvas(bitmap), view, scale, night)
        return bitmap
    }

    fun draw(canvas: Canvas, view: RoutingLiveView, scale: Float, night: Boolean) {
        val tokens = if (night) LedgerPalettes.Dark else LedgerPalettes.Light
        fun dp(value: Float) = value * scale
        val width = canvas.width.toFloat()
        val height = canvas.height.toFloat()
        val agents = view.agents.orEmpty()
        val targets = view.targets
        val agentColors = intArrayOf(0, 1, 6, 2).map { tokens.chart[it].toArgb() }

        val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
        val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
        val text = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(10f) }

        val nodeHeight = dp(18f).coerceAtMost(height / 4f + dp(4f))
        val nodeWidth = (width * 0.34f).coerceAtMost(dp(150f))
        val hubRadius = dp(13f).coerceAtMost(height / 3f)
        val hubX = width / 2f
        val hubY = height / 2f
        fun column(count: Int): List<Float> {
            if (count <= 0) return emptyList()
            val gap = ((height - nodeHeight) / count.coerceAtLeast(1)).coerceAtMost(nodeHeight + dp(10f))
            val top = hubY - (count - 1) * gap / 2f
            return List(count) { top + it * gap }
        }
        val agentYs = column(agents.size)
        val targetYs = column(targets.size)
        val agentRight = nodeWidth
        val targetLeft = width - nodeWidth

        val path = Path()
        fun wire(x1: Float, y1: Float, x2: Float, y2: Float) {
            path.reset()
            path.moveTo(x1, y1)
            val mid = (x1 + x2) / 2f
            path.cubicTo(mid, y1, mid, y2, x2, y2)
            canvas.drawPath(path, stroke)
        }

        // 空闲连线。
        stroke.pathEffect = null
        stroke.strokeWidth = dp(1f)
        stroke.color = tokens.outline.toArgb()
        stroke.alpha = 0x66
        agentYs.forEach { y -> wire(agentRight, y, hubX - hubRadius, hubY) }
        targetYs.forEach { y -> wire(hubX + hubRadius, hubY, targetLeft, y) }

        // 点亮：旧的先画，新的盖在上面。
        val dash = DashPathEffect(floatArrayOf(dp(4f), dp(3f)), 0f)
        stroke.strokeWidth = dp(1.75f)
        routingLiveEdges(view).asReversed().forEach { edge ->
            val agentIndex = agents.indexOfFirst { it.label == edge.agent }
            if (agentIndex < 0) return@forEach
            stroke.color = if (edge.ok) tokens.success.toArgb() else tokens.danger.toArgb()
            stroke.pathEffect = if (edge.ok) null else dash
            wire(agentRight, agentYs[agentIndex], hubX - hubRadius, hubY)
            val targetIndex = edge.target?.let { label -> targets.indexOfFirst { it.label == label } } ?: -1
            if (targetIndex >= 0) wire(hubX + hubRadius, hubY, targetLeft, targetYs[targetIndex])
        }
        stroke.pathEffect = null

        // 网关。
        fill.color = tokens.raised.toArgb()
        canvas.drawCircle(hubX, hubY, hubRadius, fill)
        stroke.strokeWidth = dp(if (view.busy) 2f else 1.25f)
        stroke.color = if (view.busy) tokens.primary.toArgb() else tokens.outline.toArgb()
        canvas.drawCircle(hubX, hubY, hubRadius, stroke)
        text.color = tokens.text.toArgb()
        text.textSize = dp(8f)
        text.isFakeBoldText = true
        drawCentered(canvas, text, "网关", hubX, hubY, hubRadius * 2f - dp(2f))

        // 节点。
        val rect = RectF()
        fun node(label: String, state: RoutingNodeState, folded: Boolean, left: Float, centerY: Float, accent: Int?) {
            rect.set(left, centerY - nodeHeight / 2f, left + nodeWidth, centerY + nodeHeight / 2f)
            fill.color = tokens.raised.toArgb()
            canvas.drawRoundRect(rect, nodeHeight / 2f, nodeHeight / 2f, fill)
            stroke.strokeWidth = dp(1f)
            stroke.pathEffect = if (state == RoutingNodeState.Failed) dash else null
            stroke.color = when (state) {
                RoutingNodeState.Failed -> tokens.danger.toArgb()
                RoutingNodeState.Busy -> tokens.primary.toArgb()
                RoutingNodeState.Ok, RoutingNodeState.Idle -> tokens.outline.toArgb()
            }
            canvas.drawRoundRect(rect, nodeHeight / 2f, nodeHeight / 2f, stroke)
            stroke.pathEffect = null
            var textLeft = rect.left + dp(7f)
            if (accent != null) {
                fill.color = accent
                canvas.drawCircle(rect.left + dp(7f), centerY, dp(2.5f), fill)
                textLeft = rect.left + dp(13f)
            }
            text.isFakeBoldText = false
            text.textSize = dp(9f)
            text.color = if (folded) tokens.muted.toArgb() else tokens.text.toArgb()
            val shown = TextUtils.ellipsize(label, text, rect.right - dp(6f) - textLeft, TextUtils.TruncateAt.MIDDLE).toString()
            val baseline = centerY - (text.descent() + text.ascent()) / 2f
            canvas.drawText(shown, textLeft, baseline, text)
        }
        agents.forEachIndexed { index, agent ->
            node(agent.label, agent.state, agent.more != null, 0f, agentYs[index],
                if (agent.more == null) agentColors[index % agentColors.size] else null)
        }
        targets.forEachIndexed { index, target ->
            node(target.label, target.state, target.more != null, targetLeft, targetYs[index], null)
        }
    }

    private fun drawCentered(canvas: Canvas, paint: TextPaint, label: String, x: Float, y: Float, maxWidth: Float) {
        val shown = TextUtils.ellipsize(label, paint, maxWidth, TextUtils.TruncateAt.END).toString()
        val textWidth = paint.measureText(shown)
        canvas.drawText(shown, x - textWidth / 2f, y - (paint.descent() + paint.ascent()) / 2f, paint)
    }
}
