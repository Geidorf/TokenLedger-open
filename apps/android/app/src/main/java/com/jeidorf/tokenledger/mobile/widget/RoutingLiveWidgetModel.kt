package com.jeidorf.tokenledger.mobile.widget

import com.jeidorf.tokenledger.mobile.routing.RoutingFlow
import com.jeidorf.tokenledger.mobile.routing.RoutingFlowPhase
import com.jeidorf.tokenledger.mobile.routing.RoutingHopOutcome
import com.jeidorf.tokenledger.mobile.routing.RoutingNodeState
import com.jeidorf.tokenledger.mobile.routing.RoutingReadFailure
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshots
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshotsResult
import kotlin.math.floor
import org.json.JSONArray
import org.json.JSONObject

/**
 * 「实时路由」桌面小组件（[RoutingLiveWidget]）的纯逻辑。数据与路由页、锁屏壁纸同一份
 * routing-snapshot-v1（桌面 → 云端 → 手机），合并规则一律走 [RoutingSnapshots.merge]。
 *
 * Glance 不能逐帧动画，所以这里存的是「读到那一刻」的一帧：节点、最近 3 条已结束的调用、在途数。
 * 渲染时按读取后流逝的时间往后推：说明里写「N 分钟前」，只有 10 分钟内的调用才点亮连线
 * （与 [com.jeidorf.tokenledger.mobile.routing.RoutingScene.canPlay] 同一窗口），读到时还在途、
 * 但已过去 90 秒以上的请求不再画成在途。不存设备名、不存任何凭据。
 */
internal data class RoutingLiveNode(
    val label: String,
    val state: RoutingNodeState,
    /** 折叠节点「+N」的 N；普通节点为 null。 */
    val more: Int? = null,
    /** 最近一次失败的状态码。 */
    val status: Int? = null
)

internal data class RoutingLiveHop(val target: String, val outcome: RoutingHopOutcome, val status: Int? = null)

internal data class RoutingLiveFlow(
    val agent: String,
    val phase: RoutingFlowPhase,
    val hops: List<RoutingLiveHop>,
    /** 读到时这条调用的年龄。 */
    val ageMs: Long,
    /** [RoutingSnapshots.describe] 的整句，给读屏用。 */
    val description: String
)

internal data class RoutingLiveSnapshot(
    val userId: String,
    val state: WidgetRoutingState,
    /** 读到快照时手机的墙钟（epoch ms）。 */
    val capturedAtEpochMs: Long,
    /** 读到时最新一份快照的年龄；没有快照时为 null。 */
    val snapshotAgeMs: Long? = null,
    val agents: List<RoutingLiveNode> = emptyList(),
    val targets: List<RoutingLiveNode> = emptyList(),
    /** 新在前，最多 [RoutingLiveWidgetMetrics.MAX_ROWS] 条已结束的调用。 */
    val flows: List<RoutingLiveFlow> = emptyList(),
    /** 读到时在途的请求数（只算在线设备的）。 */
    val inflight: Int = 0
)

/** 快照 → 一帧。 */
internal fun routingLiveSnapshot(
    userId: String,
    result: RoutingSnapshotsResult,
    capturedAtEpochMs: Long
): RoutingLiveSnapshot {
    if (result.snapshots.isEmpty()) {
        return RoutingLiveSnapshot(userId, WidgetRoutingState.NoSnapshot, capturedAtEpochMs)
    }
    val scene = RoutingSnapshots.merge(result)
    val freshest = result.snapshots.maxOf { it.receivedAtMs }
    fun node(node: com.jeidorf.tokenledger.mobile.routing.RoutingNode) =
        RoutingLiveNode(node.label, node.state, node.more, node.status)
    return RoutingLiveSnapshot(
        userId = userId,
        state = WidgetRoutingState.Ok,
        capturedAtEpochMs = capturedAtEpochMs,
        snapshotAgeMs = (result.serverTimeMs - freshest).coerceAtLeast(0L),
        agents = scene.agents.map(::node),
        targets = scene.targets.map(::node),
        flows = scene.flows
            .filter { it.phase != RoutingFlowPhase.Inflight }
            .take(RoutingLiveWidgetMetrics.MAX_ROWS)
            .map { liveFlow(it, result.serverTimeMs) },
        inflight = if (scene.playable) scene.stats.inflight else 0
    )
}

private fun liveFlow(flow: RoutingFlow, serverTimeMs: Long) = RoutingLiveFlow(
    agent = flow.agent,
    phase = flow.phase,
    hops = flow.hops.map { RoutingLiveHop(it.target, it.outcome, it.status) },
    ageMs = (serverTimeMs - flow.atServerMs).coerceAtLeast(0L),
    description = RoutingSnapshots.describe(flow)
)

/** 读失败 → 一帧。网络或格式问题返回 null：保留上一帧（它会按年龄如实变旧）。 */
internal fun routingLiveFailureSnapshot(
    userId: String,
    failure: RoutingReadFailure,
    capturedAtEpochMs: Long
): RoutingLiveSnapshot? = when (failure) {
    RoutingReadFailure.NotDeployed -> RoutingLiveSnapshot(userId, WidgetRoutingState.NotDeployed, capturedAtEpochMs)
    RoutingReadFailure.Unauthorized -> RoutingLiveSnapshot(userId, WidgetRoutingState.Unauthorized, capturedAtEpochMs)
    RoutingReadFailure.BadFormat, RoutingReadFailure.Unavailable -> null
}

// ---------------------------------------------------------------------------------------------
// 渲染时的呈现
// ---------------------------------------------------------------------------------------------

internal data class RoutingLiveRow(
    /** 例如「Claude Code → anthropic/sonnet」「Codex 失败 · 429」。 */
    val text: String,
    /** 例如「3 分钟前」。 */
    val ago: String,
    val tone: WidgetRoutingTone,
    /** 中途换过成员：行尾写「已切换」，不只靠颜色。 */
    val rerouted: Boolean,
    val accessibility: String
)

/** 帧里一条要点亮的连线：Agent → 网关 → 某个上游。 */
internal data class RoutingLiveEdge(val agent: String, val target: String?, val ok: Boolean)

internal data class RoutingLiveView(
    /** 卡头右侧一句状态。 */
    val status: String,
    val statusTone: WidgetRoutingTone,
    /** null：没有可画的节点（未部署、没有快照、还没读到…），卡片只写原因。 */
    val agents: List<RoutingLiveNode>?,
    val targets: List<RoutingLiveNode>,
    /** 10 分钟内的调用，新在前；每条只点亮它最后一跳（失败的跳以危险色虚线另画）。 */
    val lit: List<RoutingLiveFlow>,
    /** 读到时有在途且读取不足 90 秒：网关画成忙碌态。 */
    val busy: Boolean,
    val rows: List<RoutingLiveRow>,
    /** 没有行时卡片正文那一句。 */
    val emptyText: String?
)

internal fun routingLiveView(snapshot: RoutingLiveSnapshot?, nowEpochMs: Long): RoutingLiveView {
    fun message(status: String, tone: WidgetRoutingTone, empty: String) =
        RoutingLiveView(status, tone, null, emptyList(), emptyList(), false, emptyList(), empty)
    if (snapshot == null) return message("正在读取…", WidgetRoutingTone.Neutral, "正在读取实时路由")
    val elapsed = (nowEpochMs - snapshot.capturedAtEpochMs).coerceAtLeast(0L)
    return when (snapshot.state) {
        WidgetRoutingState.NoSnapshot -> message(
            "未同步", WidgetRoutingTone.Neutral, "在电脑端「桌面挂件 › 手机动态壁纸」打开同步后显示"
        )
        WidgetRoutingState.NotDeployed -> message("未部署", WidgetRoutingTone.Warning, "云端尚未部署实时路由同步")
        WidgetRoutingState.Unauthorized -> message("需重新登录", WidgetRoutingTone.Warning, "登录已过期，打开 TokenLedger 重新登录")
        WidgetRoutingState.Ok -> {
            val snapshotAge = snapshot.snapshotAgeMs ?: 0L
            val onlineAtCapture = snapshotAge <= RoutingSnapshots.OFFLINE_AFTER_MS
            val (status, tone) = if (onlineAtCapture) {
                // 读到时桌面在线；之后多久没再读就如实写多久前读的，不写「实时」。
                val read = if (elapsed < 60_000L) "刚刚读取" else "${formatRoutingAgo(elapsed)}读取"
                "桌面在线 · $read" to WidgetRoutingTone.Ok
            } else {
                "桌面离线 · ${formatRoutingAgo(snapshotAge + elapsed)}在线" to WidgetRoutingTone.Neutral
            }
            val aged = snapshot.flows.map { it to it.ageMs + elapsed }
            val rows = aged.map { (flow, age) -> routingLiveRow(flow, age) }
            RoutingLiveView(
                status = status,
                statusTone = tone,
                agents = snapshot.agents,
                targets = snapshot.targets,
                lit = aged.filter { (_, age) -> age < RoutingSnapshots.PLAYABLE_WITHIN_MS }.map { it.first },
                busy = onlineAtCapture && snapshot.inflight > 0 && elapsed < RoutingSnapshots.OFFLINE_AFTER_MS,
                rows = rows,
                emptyText = if (rows.isEmpty()) "暂无请求" else null
            )
        }
    }
}

internal fun routingLiveRow(flow: RoutingLiveFlow, ageMs: Long): RoutingLiveRow {
    val who = if (flow.agent == RoutingSnapshots.UNKNOWN_AGENT) "请求" else flow.agent
    val last = flow.hops.lastOrNull()
    val rerouted = flow.hops.size > 1
    val ago = formatRoutingAgo(ageMs)
    val (text, tone) = when {
        flow.phase == RoutingFlowPhase.Failed ->
            "$who 失败${last?.status?.let { " · $it" } ?: ""}" to WidgetRoutingTone.Failed
        last == null -> "$who 已处理" to WidgetRoutingTone.Ok
        else -> "$who → ${last.target}" to WidgetRoutingTone.Ok
    }
    return RoutingLiveRow(text, ago, tone, rerouted && tone == WidgetRoutingTone.Ok, "${flow.description}，$ago")
}

/** 帧里要点亮的连线。同一对 Agent/上游只画一次，取最新那条的结果。 */
internal fun routingLiveEdges(view: RoutingLiveView): List<RoutingLiveEdge> {
    val agents = view.agents?.map { it.label }?.toSet() ?: return emptyList()
    val targets = view.targets.map { it.label }.toSet()
    val seen = HashSet<Pair<String, String?>>()
    return buildList {
        for (flow in view.lit) {
            if (flow.agent !in agents) continue
            if (flow.hops.isEmpty()) {
                if (seen.add(flow.agent to null)) add(RoutingLiveEdge(flow.agent, null, flow.phase != RoutingFlowPhase.Failed))
                continue
            }
            for (hop in flow.hops) {
                if (hop.target !in targets || hop.outcome == RoutingHopOutcome.Skipped) continue
                if (!seen.add(flow.agent to hop.target)) continue
                add(RoutingLiveEdge(flow.agent, hop.target, hop.outcome == RoutingHopOutcome.Ok))
            }
        }
    }
}

/** 整张卡给读屏的一句话。 */
internal fun routingLiveAccessibility(view: RoutingLiveView): String = buildList {
    add("实时路由")
    add(view.status)
    if (view.rows.isEmpty()) view.emptyText?.let(::add)
    view.rows.forEach { add(it.accessibility) }
    add("双击打开 TokenLedger")
}.joinToString("；")

// ---------------------------------------------------------------------------------------------
// 版面
// ---------------------------------------------------------------------------------------------

internal object RoutingLiveWidgetMetrics {
    const val MAX_ROWS = 3
    const val HEADER_DP = 22f
    const val ROW_DP = 22f
    /** 路由帧低于这个高度就不画，只留文字行。 */
    const val FRAME_MIN_DP = 64f
    const val FRAME_MAX_DP = 132f
    /** 帧至少要这么宽才放得下「Agent · 网关 · 上游」三列。 */
    const val FRAME_MIN_WIDTH_DP = 200f
}

internal data class RoutingLiveLayout(
    val sufficient: Boolean,
    val showFrame: Boolean,
    val frameHeightDp: Float,
    val rowCount: Int,
    val rowHeightDp: Float,
    val headerHeightDp: Float
)

/**
 * 尺寸只决定画不画路由帧、放几行。先保文字行（最多 3 行），剩下的高度够才画帧；
 * 大字体下行高跟着放大，帧先让位。
 */
internal fun routingLiveLayout(widthDp: Float, heightDp: Float, fontScale: Float): RoutingLiveLayout {
    val scale = if (fontScale.isFinite()) fontScale.coerceAtLeast(1f) else 1f
    val header = RoutingLiveWidgetMetrics.HEADER_DP * scale
    val rowHeight = RoutingLiveWidgetMetrics.ROW_DP * scale
    if (!widthDp.isFinite() || !heightDp.isFinite()) return RoutingLiveLayout(false, false, 0f, 0, rowHeight, header)
    val innerWidth = WidgetMetrics.innerWidthDp(widthDp)
    val available = WidgetMetrics.innerHeightDp(heightDp) - header
    val maxRows = RoutingLiveWidgetMetrics.MAX_ROWS
    fun slots(budget: Float) = floor(budget / rowHeight).toInt().coerceIn(0, maxRows)
    if (innerWidth < 120f * scale || slots(available) < 1) {
        return RoutingLiveLayout(false, false, 0f, 0, rowHeight, header)
    }
    val frameFits = innerWidth >= RoutingLiveWidgetMetrics.FRAME_MIN_WIDTH_DP
    val rowsWithFrame = slots(available - RoutingLiveWidgetMetrics.FRAME_MIN_DP)
    // 帧至少配两行（大字体下一行），否则文字更有用。
    val needRows = if (scale > 1.3f) 1 else minOf(2, maxRows)
    return if (frameFits && rowsWithFrame >= needRows) {
        val frame = (available - rowsWithFrame * rowHeight).coerceAtMost(RoutingLiveWidgetMetrics.FRAME_MAX_DP)
        RoutingLiveLayout(true, true, frame, rowsWithFrame, rowHeight, header)
    } else {
        RoutingLiveLayout(true, false, 0f, slots(available), rowHeight, header)
    }
}

// ---------------------------------------------------------------------------------------------
// 近实时刷新节奏
// ---------------------------------------------------------------------------------------------

internal object RoutingLiveCadence {
    /** 桌面在线且 10 分钟内有调用：3 分钟再读一次。 */
    const val ACTIVE_MS = 3 * 60_000L
    /** 桌面在线但空闲：10 分钟一次。 */
    const val IDLE_MS = 10 * 60_000L
}

/**
 * 下一次单独读路由快照的延迟；null 表示停下近实时链，交回 30 分钟的共用周期刷新
 * （桌面离线、没开同步、未部署、需重新登录时，频繁读也读不出新东西）。
 */
internal fun routingLiveNextDelayMs(snapshot: RoutingLiveSnapshot?): Long? {
    if (snapshot == null || snapshot.state != WidgetRoutingState.Ok) return null
    val age = snapshot.snapshotAgeMs ?: return null
    if (age > RoutingSnapshots.OFFLINE_AFTER_MS) return null
    val recent = snapshot.inflight > 0 ||
        snapshot.flows.any { it.ageMs < RoutingSnapshots.PLAYABLE_WITHIN_MS }
    return if (recent) RoutingLiveCadence.ACTIVE_MS else RoutingLiveCadence.IDLE_MS
}

// ---------------------------------------------------------------------------------------------
// 存取
// ---------------------------------------------------------------------------------------------

internal fun encodeRoutingLiveSnapshot(snapshot: RoutingLiveSnapshot): String = JSONObject().apply {
    put("v", 1)
    put("userId", snapshot.userId)
    put("state", snapshot.state.storageValue)
    put("capturedAt", snapshot.capturedAtEpochMs)
    snapshot.snapshotAgeMs?.let { put("snapshotAge", it) }
    fun nodes(list: List<RoutingLiveNode>) = JSONArray().apply {
        list.forEach { node ->
            put(JSONObject().apply {
                put("label", node.label)
                put("state", node.state.name)
                node.more?.let { put("more", it) }
                node.status?.let { put("status", it) }
            })
        }
    }
    put("agents", nodes(snapshot.agents))
    put("targets", nodes(snapshot.targets))
    put("flows", JSONArray().apply {
        snapshot.flows.forEach { flow ->
            put(JSONObject().apply {
                put("agent", flow.agent)
                put("phase", flow.phase.wire)
                put("age", flow.ageMs)
                put("description", flow.description)
                put("hops", JSONArray().apply {
                    flow.hops.forEach { hop ->
                        put(JSONObject().apply {
                            put("target", hop.target)
                            put("outcome", hop.outcome.wire)
                            hop.status?.let { put("status", it) }
                        })
                    }
                })
            })
        }
    })
    put("inflight", snapshot.inflight)
}.toString()

/** 解不出来（版本不对、字段缺失、被改坏）就当没有，绝不抛到小组件渲染里。 */
internal fun decodeRoutingLiveSnapshot(raw: String?): RoutingLiveSnapshot? {
    if (raw.isNullOrBlank()) return null
    return runCatching {
        val json = JSONObject(raw)
        if (json.optInt("v", -1) != 1) return null
        val userId = json.optString("userId").takeIf { it.isNotBlank() } ?: return null
        val state = WidgetRoutingState.fromStorage(json.optString("state")) ?: return null
        if (!json.has("capturedAt")) return null
        fun JSONArray?.objects(): List<JSONObject> =
            if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
        fun JSONObject.optIntOrNull(key: String): Int? = if (has(key) && !isNull(key)) getInt(key) else null
        fun nodes(key: String) = json.optJSONArray(key).objects().mapNotNull { node ->
            val label = node.optString("label").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val nodeState = RoutingNodeState.entries.firstOrNull { it.name == node.optString("state") } ?: RoutingNodeState.Idle
            RoutingLiveNode(label, nodeState, node.optIntOrNull("more"), node.optIntOrNull("status"))
        }
        val flows = json.optJSONArray("flows").objects().mapNotNull { flow ->
            val phase = RoutingFlowPhase.fromWire(flow.optString("phase")) ?: return@mapNotNull null
            if (!flow.has("age")) return@mapNotNull null
            RoutingLiveFlow(
                agent = flow.optString("agent").ifBlank { RoutingSnapshots.UNKNOWN_AGENT },
                phase = phase,
                hops = flow.optJSONArray("hops").objects().mapNotNull { hop ->
                    val target = hop.optString("target").takeIf { it.isNotBlank() } ?: return@mapNotNull null
                    RoutingLiveHop(
                        target,
                        RoutingHopOutcome.fromWire(hop.optString("outcome")) ?: RoutingHopOutcome.Failed,
                        hop.optIntOrNull("status")
                    )
                },
                ageMs = flow.getLong("age").coerceAtLeast(0L),
                description = flow.optString("description")
            )
        }
        RoutingLiveSnapshot(
            userId = userId,
            state = state,
            capturedAtEpochMs = json.getLong("capturedAt"),
            snapshotAgeMs = if (json.has("snapshotAge") && !json.isNull("snapshotAge")) json.getLong("snapshotAge") else null,
            agents = nodes("agents"),
            targets = nodes("targets"),
            flows = flows.take(RoutingLiveWidgetMetrics.MAX_ROWS),
            inflight = json.optInt("inflight", 0).coerceAtLeast(0)
        )
    }.getOrNull()
}
