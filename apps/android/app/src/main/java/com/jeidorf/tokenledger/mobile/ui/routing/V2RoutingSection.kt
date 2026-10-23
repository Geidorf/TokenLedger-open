package com.jeidorf.tokenledger.mobile.ui.routing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.routing.RoutingEmptyReason
import com.jeidorf.tokenledger.mobile.routing.RoutingFlow
import com.jeidorf.tokenledger.mobile.routing.RoutingFlowPhase
import com.jeidorf.tokenledger.mobile.routing.RoutingHopOutcome
import com.jeidorf.tokenledger.mobile.routing.RoutingLiveness
import com.jeidorf.tokenledger.mobile.routing.RoutingReadFailure
import com.jeidorf.tokenledger.mobile.routing.RoutingScene
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshots
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card

/** 「最近调用」最多列几条（快照本身最多 24 条）。 */
private const val RECENT_ROWS = 12

/**
 * 「路由」一级页（重构 R4）：桌面网关的实时路由经云端快照（契约 routing-snapshot-v1）中转到手机，
 * 这里画 Agent → 网关 → 上游成员的舞台和最近调用。没有快照、桌面离线、云端没部署时如实说明，
 * 不画假的流向、不编数字；快照有 5～10 秒延迟，时间一律写「N 秒前」。
 */
internal fun LazyListScope.v2RoutingItems(palette: MobileV2Palette, feed: RoutingFeed) {
    item(key = "routing-page", contentType = "routing") {
        V2RoutingPage(palette, feed)
    }
}

@Composable
private fun V2RoutingPage(palette: MobileV2Palette, feed: RoutingFeed) {
    val now = rememberRoutingServerNow(feed)
    val scene = remember(feed.result, now / 1_000L) { feed.result?.let { RoutingSnapshots.merge(it, now) } }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        V2RoutingEyebrow(palette, feed, scene)
        val blocker = routingBlocker(feed, scene)
        if (blocker != null) {
            V2Card(palette) {
                Text(blocker.first, color = palette.text, style = LedgerType.titleM)
                Text(blocker.second, color = palette.muted, fontSize = LedgerFont.label, modifier = Modifier.padding(top = 4.dp))
            }
        }
        if (scene != null && scene.empty == null) {
            V2Card(palette) {
                V2RoutingStage(palette, scene, now)
                V2RoutingFooter(palette, scene, now)
            }
            V2RoutingRecent(palette, scene.flows.take(RECENT_ROWS), now)
        }
    }
}

/** 挡住舞台的原因：标题 + 说明。null 表示可以画舞台。 */
internal fun routingBlocker(feed: RoutingFeed, scene: RoutingScene?): Pair<String, String>? {
    if (!feed.signedIn) return "登录后显示路由" to "路由页读取的是你登录的云同步账号下，桌面网关发来的实时路由快照。"
    if (scene == null) {
        return when (feed.failure) {
            null -> "正在读取路由…" to "第一次读取需要几秒钟。"
            RoutingReadFailure.NotDeployed -> "云端还没有开通实时路由同步" to
                "云端数据库部署实时路由快照的读取函数后，这里会显示桌面网关的实时路由。"
            RoutingReadFailure.Unauthorized -> "登录已过期" to "回到用量页下拉刷新续期后，路由会自动继续读取。"
            RoutingReadFailure.BadFormat -> "读不懂云端的路由数据" to "云端返回的格式与本应用不一致，可能需要更新应用。"
            RoutingReadFailure.Unavailable -> "暂时读不到云端" to "网络或云端服务暂时不可用，稍后会自动重试。"
        }
    }
    return when (scene.empty) {
        RoutingEmptyReason.NoSnapshot -> "还没有路由数据" to
            "在桌面端设置里打开「把实时路由同步到手机」，网关经手的每个请求会在几秒内出现在这里：" +
            "哪个 Agent 发的、分到哪个账号、哪个在应答、哪个在限流。"
        RoutingEmptyReason.Offline -> {
            val minutes = (scene.liveness as? RoutingLiveness.Offline)?.minutes ?: 1L
            "桌面已离线 $minutes 分钟" to "桌面重新联网且同步保持打开后，这里会继续显示。"
        }
        RoutingEmptyReason.Idle -> "网关空闲" to "桌面在线，最近 10 分钟没有经过网关的请求。"
        null -> null
    }
}

/** 页首一行：ROUTING · 状态点 · 实时 / 离线 / 读取失败。 */
@Composable
private fun V2RoutingEyebrow(palette: MobileV2Palette, feed: RoutingFeed, scene: RoutingScene?) {
    val (dot, text) = routingStatusLine(palette, feed, scene)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 2.dp)
            .semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text("ROUTING", color = palette.muted, style = LedgerType.caption, fontWeight = FontWeight.SemiBold)
        Box(Modifier.size(6.dp).background(dot, CircleShape))
        Text(text, color = palette.muted, style = LedgerType.meta, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

private fun routingStatusLine(palette: MobileV2Palette, feed: RoutingFeed, scene: RoutingScene?): Pair<Color, String> {
    val stale = if (feed.failure != null && scene != null) "（读取失败，显示上次结果）" else ""
    return when (val liveness = scene?.liveness) {
        is RoutingLiveness.Live -> palette.tokens.success to "实时 · ${ago(liveness.ageMs)}更新$stale"
        is RoutingLiveness.Offline -> palette.tokens.warning to "桌面已离线 ${liveness.minutes} 分钟$stale"
        RoutingLiveness.NoSnapshot -> palette.faint to "桌面未开启路由同步"
        null -> (if (feed.failure != null) palette.tokens.danger else palette.faint) to
            (if (feed.failure != null) "读取失败" else "读取中")
    }
}

/** 「N 秒前」：快照有延迟，不把回放说成此刻。 */
internal fun ago(ageMs: Long): String {
    val seconds = (ageMs / 1_000L).coerceAtLeast(0L)
    return when {
        seconds < 5 -> "刚刚"
        seconds < 60 -> "$seconds 秒前"
        seconds < 3_600 -> "${seconds / 60} 分钟前"
        else -> "${seconds / 3_600} 小时前"
    }
}

/** 舞台下方：最新一条流的一句话说明（读屏礼貌播报）+ 请求 / 转路 / 报错。 */
@Composable
private fun V2RoutingFooter(palette: MobileV2Palette, scene: RoutingScene, now: Long) {
    val latest = scene.flows.firstOrNull()
    val caption = latest?.let { flow ->
        val age = now - flow.atServerMs
        val prefix = if (flow.phase != RoutingFlowPhase.Inflight && age >= RECENT_LIT_MS) "最近：" else ""
        "$prefix${RoutingSnapshots.describe(flow)}" + if (flow.phase == RoutingFlowPhase.Inflight) "" else " · ${ago(age)}"
    }.orEmpty()
    HorizontalDivider(color = palette.divider, modifier = Modifier.padding(top = 12.dp))
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Text(
            caption,
            color = palette.text,
            style = LedgerType.meta,
            modifier = Modifier
                .weight(1f)
                .semantics { liveRegion = LiveRegionMode.Polite }
        )
        V2RoutingStat(palette, scene.stats.requests + scene.stats.inflight, "请求")
        V2RoutingStat(palette, scene.stats.rerouted, "转路")
        V2RoutingStat(palette, scene.stats.failed, "报错")
    }
}

@Composable
private fun V2RoutingStat(palette: MobileV2Palette, value: Int, label: String) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.clearAndSetSemantics { contentDescription = "$label $value" }
    ) {
        Text(value.toString(), color = palette.text, style = LedgerType.numS)
        Text(label, color = palette.muted, style = LedgerType.caption)
    }
}

@Composable
private fun V2RoutingRecent(palette: MobileV2Palette, flows: List<RoutingFlow>, now: Long) {
    if (flows.isEmpty()) return
    V2Card(palette) {
        Text(
            "最近调用",
            color = palette.text,
            style = LedgerType.titleS,
            modifier = Modifier.semantics { heading() }
        )
        flows.forEachIndexed { index, flow ->
            if (index > 0) HorizontalDivider(color = palette.divider)
            V2RoutingRecentRow(palette, flow, now)
        }
    }
}

/** 调用行的状态词与颜色。 */
internal fun routingPhaseLabel(flow: RoutingFlow): String = when (flow.phase) {
    RoutingFlowPhase.Inflight -> "在途"
    RoutingFlowPhase.Routed -> if (flow.hops.size > 1) "转路接通" else "已接通"
    RoutingFlowPhase.Done -> if (flow.hops.size > 1) "转路完成" else "完成"
    RoutingFlowPhase.Failed -> "失败"
}

/** 尝试链：openai/gpt-5 429 → deepseek/deepseek-chat。 */
internal fun routingHopChain(flow: RoutingFlow): String =
    flow.hops.joinToString(" → ") { hop ->
        val mark = when (hop.outcome) {
            RoutingHopOutcome.Ok, RoutingHopOutcome.Pending -> ""
            RoutingHopOutcome.Skipped -> " 跳过"
            RoutingHopOutcome.Rejected -> hop.status?.let { " $it" } ?: " 拒绝"
            RoutingHopOutcome.Failed -> hop.status?.let { " $it" } ?: " 失败"
        }
        hop.target + mark
    }.ifEmpty { "选路中" }

@Composable
private fun V2RoutingRecentRow(palette: MobileV2Palette, flow: RoutingFlow, now: Long) {
    val phaseColor = when (flow.phase) {
        RoutingFlowPhase.Failed -> palette.danger
        RoutingFlowPhase.Inflight -> palette.text
        else -> palette.green
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 10.dp)
            .clearAndSetSemantics { contentDescription = RoutingSnapshots.describe(flow) + "，" + ago(now - flow.atServerMs) },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                buildString {
                    append(flow.agent)
                    if (flow.via.isNotEmpty()) append(" · ").append(flow.via)
                },
                color = palette.text,
                style = LedgerType.label,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                routingHopChain(flow),
                color = palette.muted,
                style = LedgerType.meta,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(routingPhaseLabel(flow), color = phaseColor, style = LedgerType.labelS)
            Text(ago(now - flow.atServerMs), color = palette.faint, style = LedgerType.caption)
        }
    }
}
