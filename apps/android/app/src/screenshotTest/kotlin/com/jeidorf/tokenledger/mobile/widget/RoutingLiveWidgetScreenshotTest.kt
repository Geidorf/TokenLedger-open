package com.jeidorf.tokenledger.mobile.widget

import android.content.res.Configuration
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.routing.RoutingFlowPhase
import com.jeidorf.tokenledger.mobile.routing.RoutingHopOutcome
import com.jeidorf.tokenledger.mobile.routing.RoutingNodeState

/**
 * 实时路由小组件（[RoutingLiveWidget]）的主机视觉夹具：Glance 不能直接截图，这里用 Compose 按生产代码的
 * 版面预算（[routingLiveLayout]）、呈现函数（[routingLiveView]）与同一个路由帧位图渲染器
 * （[RoutingLiveFrameRenderer]）画同一张卡。不是实际 Launcher 验收。
 */
private const val CAPTURED = 1_800_000_000_000L

private fun hop(target: String, outcome: RoutingHopOutcome, status: Int? = null) = RoutingLiveHop(target, outcome, status)

private val busySnapshot = RoutingLiveSnapshot(
    userId = "u1",
    state = WidgetRoutingState.Ok,
    capturedAtEpochMs = CAPTURED,
    snapshotAgeMs = 4_000,
    agents = listOf(
        RoutingLiveNode("Claude Code", RoutingNodeState.Busy),
        RoutingLiveNode("Codex", RoutingNodeState.Idle),
        RoutingLiveNode("Cursor", RoutingNodeState.Idle)
    ),
    targets = listOf(
        RoutingLiveNode("anthropic/sonnet", RoutingNodeState.Ok),
        RoutingLiveNode("openai/gpt-5", RoutingNodeState.Ok),
        RoutingLiveNode("relay-a/gpt-5", RoutingNodeState.Failed, status = 429),
        RoutingLiveNode("deepseek/chat", RoutingNodeState.Failed, status = 500)
    ),
    flows = listOf(
        RoutingLiveFlow("Claude Code", RoutingFlowPhase.Done, listOf(hop("anthropic/sonnet", RoutingHopOutcome.Ok)),
            20_000, "Claude Code 的请求由 anthropic/sonnet 完成"),
        RoutingLiveFlow(
            "Codex", RoutingFlowPhase.Done,
            listOf(hop("relay-a/gpt-5", RoutingHopOutcome.Failed, 429), hop("openai/gpt-5", RoutingHopOutcome.Ok)),
            2 * 60_000, "Codex 的请求：relay-a/gpt-5 返回 429，已切换到 openai/gpt-5，已完成"
        ),
        RoutingLiveFlow("Cursor", RoutingFlowPhase.Failed, listOf(hop("deepseek/chat", RoutingHopOutcome.Failed, 500)),
            6 * 60_000, "Cursor 的请求（default）失败：500")
    ),
    inflight = 1
)

@Composable
private fun RoutingLiveFixture(
    width: Int,
    height: Int,
    night: Boolean,
    snapshot: RoutingLiveSnapshot? = busySnapshot,
    nowEpochMs: Long = CAPTURED + 30_000L
) {
    val density = LocalDensity.current
    val scale = density.fontScale
    val palette = WidgetColors(night = night)
    val plan = routingLiveLayout(width.toFloat(), height.toFloat(), scale)
    val view = routingLiveView(snapshot, nowEpochMs)
    fun tone(t: WidgetRoutingTone): Color = when (t) {
        WidgetRoutingTone.Ok -> palette.greenColor
        WidgetRoutingTone.Failed -> palette.dangerColor
        WidgetRoutingTone.Warning -> palette.amberColor
        WidgetRoutingTone.Neutral -> palette.faintColor
    }
    val horizontal = if (width < 180) 8 else 10
    Box(
        Modifier.fillMaxSize().background(palette.backgroundColor, RoundedCornerShape(20.dp))
            .padding(horizontal = horizontal.dp, vertical = if (height < 82) 5.dp else 7.dp)
    ) {
        if (!plan.sufficient) {
            Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center) {
                Text("尺寸不足", color = palette.textColor, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                Text("请放大以显示实时路由", color = palette.mutedColor, fontSize = 11.sp)
            }
            return@Box
        }
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().height(plan.headerHeightDp.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("实时路由", color = palette.textColor, fontSize = 12.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                Spacer(Modifier.width(8.dp))
                Box(Modifier.size(6.dp).background(tone(view.statusTone), RoundedCornerShape(4.dp)))
                Spacer(Modifier.width(4.dp))
                Text(view.status, color = if (view.statusTone == WidgetRoutingTone.Warning) palette.amberColor else palette.mutedColor,
                    fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
            if (plan.showFrame && view.agents != null) {
                val bitmap = RoutingLiveFrameRenderer.render(
                    view, WidgetMetrics.innerWidthDp(width.toFloat()), plan.frameHeightDp, density.density, night
                )
                Image(bitmap.asImageBitmap(), contentDescription = null, contentScale = ContentScale.FillBounds,
                    modifier = Modifier.fillMaxWidth().height(plan.frameHeightDp.dp))
            }
            if (view.rows.isEmpty()) {
                Text(view.emptyText ?: "暂无请求", color = palette.mutedColor, fontSize = 11.sp, maxLines = 2,
                    modifier = Modifier.padding(top = 4.dp))
            }
            view.rows.take(plan.rowCount).forEach { row ->
                Row(Modifier.fillMaxWidth().height(plan.rowHeightDp.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(6.dp).background(tone(row.tone), RoundedCornerShape(4.dp)))
                    Spacer(Modifier.width(6.dp))
                    Text(row.text, color = if (row.tone == WidgetRoutingTone.Failed) palette.dangerColor else palette.textColor,
                        fontSize = 11.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f))
                    if (row.rerouted) {
                        Text("已切换", color = palette.amberColor, fontSize = 10.sp, maxLines = 1)
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(row.ago, color = palette.mutedColor, fontSize = 10.sp, maxLines = 1)
                }
            }
        }
    }
}

@PreviewTest
@Preview(name = "RoutingLive Dark", device = "spec:width=320dp,height=220dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun RoutingLiveDarkScreenshot() { RoutingLiveFixture(320, 220, night = true) }

@PreviewTest
@Preview(name = "RoutingLive Light", device = "spec:width=320dp,height=220dp,dpi=160", fontScale = 1.0f)
@Composable
fun RoutingLiveLightScreenshot() { RoutingLiveFixture(320, 220, night = false) }

@PreviewTest
@Preview(name = "RoutingLive Short", device = "spec:width=320dp,height=110dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun RoutingLiveShortScreenshot() { RoutingLiveFixture(320, 110, night = true) }

@PreviewTest
@Preview(name = "RoutingLive Stale", device = "spec:width=320dp,height=220dp,dpi=160", fontScale = 1.0f)
@Composable
fun RoutingLiveStaleScreenshot() {
    // 读到后 40 分钟没再读（手机省电或离线）：连线全部熄灭，行按真实年龄写。
    RoutingLiveFixture(320, 220, night = false, nowEpochMs = CAPTURED + 40 * 60_000L)
}

@PreviewTest
@Preview(name = "RoutingLive Offline", device = "spec:width=320dp,height=220dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun RoutingLiveOfflineScreenshot() {
    RoutingLiveFixture(320, 220, night = true, snapshot = busySnapshot.copy(snapshotAgeMs = 12 * 60_000L, inflight = 0))
}

@PreviewTest
@Preview(name = "RoutingLive NoSnapshot", device = "spec:width=320dp,height=220dp,dpi=160", fontScale = 1.0f)
@Composable
fun RoutingLiveNoSnapshotScreenshot() {
    RoutingLiveFixture(320, 220, night = false, snapshot = RoutingLiveSnapshot("u1", WidgetRoutingState.NoSnapshot, CAPTURED))
}

@PreviewTest
@Preview(name = "RoutingLive Font200", device = "spec:width=320dp,height=220dp,dpi=160", fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun RoutingLiveFont200Screenshot() { RoutingLiveFixture(320, 220, night = true) }
