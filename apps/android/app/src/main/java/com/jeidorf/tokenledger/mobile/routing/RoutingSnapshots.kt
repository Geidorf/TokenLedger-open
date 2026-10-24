package com.jeidorf.tokenledger.mobile.routing

import org.json.JSONArray
import org.json.JSONObject
import java.time.OffsetDateTime

/**
 * 实时路由快照（契约 docs/contracts/routing-snapshot-v1.md）的 Android 侧模型：解析
 * `get_routing_snapshots_v1` 的返回体，合并多台桌面的快照，再按设计文档
 * docs/design/routing-animation-v1.md 的场景结构算出节点与统计。路由页与锁屏动态壁纸共用，
 * 这里只有纯 Kotlin，不碰 Android 与 Compose，便于单测。
 *
 * 诚实规则与桌面一致：每条流都对应桌面上的一条真实记录；没有快照、快照过期时只给出原因，
 * 不编流量；`routed` 只表示已接通（可能仍在流式），不算完成。
 */

enum class RoutingSourceId(val wire: String, val label: String) {
    TokenLedger("tokenledger", "自带网关"),
    External("external", "外部网关");

    companion object {
        fun fromWire(value: String): RoutingSourceId? = entries.firstOrNull { it.wire == value }
    }
}

enum class RoutingHopOutcome(val wire: String) {
    Ok("ok"), Failed("failed"), Rejected("rejected"), Skipped("skipped"), Pending("pending");

    companion object {
        fun fromWire(value: String): RoutingHopOutcome? = entries.firstOrNull { it.wire == value }
    }
}

/** 含义同设计文档：在途、已接通（可能仍在流式）、已结束且成功、没有成员接通。 */
enum class RoutingFlowPhase(val wire: String) {
    Inflight("inflight"), Routed("routed"), Done("done"), Failed("failed");

    companion object {
        fun fromWire(value: String): RoutingFlowPhase? = entries.firstOrNull { it.wire == value }
    }
}

data class RoutingHop(
    /** `供应商/模型`。 */
    val target: String,
    val outcome: RoutingHopOutcome,
    val status: Int? = null
)

data class RoutingFlow(
    /** 16 位十六进制，同一请求在前后快照中相同。 */
    val id: String,
    val source: RoutingSourceId,
    val agent: String,
    /** `group/<组 ID>` 或直连请求的模型名。 */
    val via: String,
    val phase: RoutingFlowPhase,
    /** 记录时间换算到服务器时钟后的毫秒数（在途流为开始时间）。 */
    val atServerMs: Long,
    /** 在途流在等什么：slot / rpm / upstream。 */
    val waitingOn: String? = null,
    val hops: List<RoutingHop> = emptyList(),
    /** 来自哪台桌面（契约 §3.1 的设备哈希）。 */
    val device: String = ""
)

data class RoutingSourceState(
    val id: RoutingSourceId,
    val reachable: Boolean,
    val note: String? = null
)

data class RoutingDeviceSnapshot(
    val device: String,
    /** 服务器收到这份快照的时间。 */
    val receivedAtMs: Long,
    val sources: List<RoutingSourceState>,
    /** 新在前；时间已换算到服务器时钟。 */
    val flows: List<RoutingFlow>
)

data class RoutingSnapshotsResult(
    val serverTimeMs: Long,
    /** 按 receivedAt 新在前。 */
    val snapshots: List<RoutingDeviceSnapshot>,
    /** 结构不合规而被跳过的快照条数（旧客户端遇到 v2 等）。 */
    val skipped: Int = 0
)

class RoutingSnapshotFormatException(message: String) : IllegalArgumentException(message)

enum class RoutingNodeState { Ok, Failed, Busy, Idle }

data class RoutingNode(
    val id: String,
    val label: String,
    /** 折叠的 `+N` 节点。 */
    val more: Int? = null,
    val state: RoutingNodeState = RoutingNodeState.Idle,
    /** 最近一次失败的状态码。 */
    val status: Int? = null
)

data class RoutingStats(val requests: Int, val rerouted: Int, val failed: Int, val inflight: Int)

/** 路由页与壁纸顶部的一句状态。 */
sealed interface RoutingLiveness {
    /** 云端没有任何快照：桌面没打开「把实时路由同步到手机」。 */
    data object NoSnapshot : RoutingLiveness
    /** 至少一台桌面在 90 秒内发过快照。[ageMs] 是最新那份的年龄。 */
    data class Live(val ageMs: Long) : RoutingLiveness
    /** 所有快照都超过 90 秒：桌面已离线 [minutes] 分钟（不足 1 分钟按 1 算）。 */
    data class Offline(val minutes: Long) : RoutingLiveness
}

data class RoutingDeviceSources(val device: String, val live: Boolean, val sources: List<RoutingSourceState>)

data class RoutingScene(
    val liveness: RoutingLiveness,
    val devices: List<RoutingDeviceSources>,
    val agents: List<RoutingNode>,
    val targets: List<RoutingNode>,
    /** 新在前，按 id 去重。 */
    val flows: List<RoutingFlow>,
    val stats: RoutingStats,
    /** null 表示有流可画。 */
    val empty: RoutingEmptyReason?
) {
    val playable: Boolean get() = liveness is RoutingLiveness.Live
}

enum class RoutingEmptyReason { NoSnapshot, Offline, Idle }

object RoutingSnapshots {
    /** 快照超过这个年龄就算桌面离线（契约 §5）。 */
    const val OFFLINE_AFTER_MS = 90_000L
    /** 早于这个年龄的流不播放（契约 §5）。 */
    const val PLAYABLE_WITHIN_MS = 10 * 60_000L
    /** 播放后连线按结果保持点亮的时长（设计文档「停留」）。 */
    const val FLOW_LINGER_MS = 12_000L
    const val MAX_AGENTS = 4
    const val MAX_TARGETS = 5
    const val UNKNOWN_AGENT = "Agent"

    /**
     * 解析 `get_routing_snapshots_v1` 的返回体。外层结构不对时抛 [RoutingSnapshotFormatException]；
     * 单份快照不合规（例如以后的 v2）只跳过那一份并计入 [RoutingSnapshotsResult.skipped]。
     */
    fun parse(json: String): RoutingSnapshotsResult {
        val root = try {
            JSONObject(json)
        } catch (error: Exception) {
            throw RoutingSnapshotFormatException("routing snapshots: not a JSON object")
        }
        val serverTime = parseTime(root.optString("serverTime"))
            ?: throw RoutingSnapshotFormatException("routing snapshots: serverTime missing")
        val rows = root.optJSONArray("snapshots") ?: JSONArray()
        var skipped = 0
        val snapshots = buildList {
            for (index in 0 until rows.length()) {
                val parsed = rows.optJSONObject(index)?.let(::parseRow)
                if (parsed == null) skipped++ else add(parsed)
            }
        }.sortedByDescending { it.receivedAtMs }
        return RoutingSnapshotsResult(serverTime, snapshots, skipped)
    }

    private fun parseRow(row: JSONObject): RoutingDeviceSnapshot? {
        val device = row.optString("device").takeIf { it.isNotBlank() } ?: return null
        val receivedAt = parseTime(row.optString("receivedAt")) ?: return null
        val snapshot = row.optJSONObject("snapshot") ?: return null
        if (snapshot.optInt("v", -1) != 1) return null
        val generatedAt = parseTime(snapshot.optString("generatedAt")) ?: return null
        // 桌面时钟 → 服务器时钟：收到时间减生成时间（含一次网络延迟，秒级够用）。
        val offset = receivedAt - generatedAt
        val sources = snapshot.optJSONArray("sources").objects().mapNotNull { source ->
            val id = RoutingSourceId.fromWire(source.optString("id")) ?: return@mapNotNull null
            RoutingSourceState(id, source.optBoolean("reachable", false), source.optStringOrNull("note"))
        }.distinctBy { it.id }
        val flows = snapshot.optJSONArray("flows").objects().mapNotNull { parseFlow(it, offset, device) }
        return RoutingDeviceSnapshot(device, receivedAt, sources, flows)
    }

    private fun parseFlow(flow: JSONObject, offsetMs: Long, device: String): RoutingFlow? {
        val id = flow.optString("id").takeIf { it.isNotBlank() } ?: return null
        val source = RoutingSourceId.fromWire(flow.optString("source")) ?: return null
        val phase = RoutingFlowPhase.fromWire(flow.optString("phase")) ?: return null
        val at = parseTime(flow.optString("at")) ?: return null
        val hops = flow.optJSONArray("hops").objects().mapNotNull { hop ->
            val target = hop.optString("target").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val outcome = RoutingHopOutcome.fromWire(hop.optString("outcome")) ?: RoutingHopOutcome.Failed
            val status = if (hop.has("status") && !hop.isNull("status")) hop.optInt("status").takeIf { it in 100..599 } else null
            RoutingHop(target, outcome, status)
        }
        return RoutingFlow(
            id = id,
            source = source,
            agent = flow.optString("agent").trim().ifEmpty { UNKNOWN_AGENT },
            via = flow.optString("via").trim(),
            phase = phase,
            atServerMs = at + offsetMs,
            waitingOn = if (phase == RoutingFlowPhase.Inflight) flow.optStringOrNull("waitingOn") else null,
            hops = hops,
            device = device
        )
    }

    /**
     * 合并所有设备的快照并算出场景。[nowServerMs] 是手机此刻对应的服务器时间：
     * 读取时的 serverTime 加上读取后流逝的时间，不依赖手机与桌面时钟一致。
     */
    fun merge(result: RoutingSnapshotsResult, nowServerMs: Long = result.serverTimeMs): RoutingScene {
        if (result.snapshots.isEmpty()) {
            return emptyScene(RoutingLiveness.NoSnapshot, RoutingEmptyReason.NoSnapshot)
        }
        val freshest = result.snapshots.maxOf { it.receivedAtMs }
        val freshestAge = (nowServerMs - freshest).coerceAtLeast(0L)
        val liveness = if (freshestAge <= OFFLINE_AFTER_MS) {
            RoutingLiveness.Live(freshestAge)
        } else {
            RoutingLiveness.Offline((freshestAge / 60_000L).coerceAtLeast(1L))
        }
        val devices = result.snapshots.map { snapshot ->
            RoutingDeviceSources(snapshot.device, nowServerMs - snapshot.receivedAtMs <= OFFLINE_AFTER_MS, snapshot.sources)
        }
        val liveDevices = devices.filter { it.live }.map { it.device }.toSet()
        // 离线设备的在途流不能再当在途画（不知道它后来怎样了），只留已结束的记录给「最近调用」。
        val flows = result.snapshots
            .flatMap { it.flows }
            .filter { it.phase != RoutingFlowPhase.Inflight || it.device in liveDevices }
            .distinctBy { it.id }
            .sortedWith(compareByDescending<RoutingFlow> { it.atServerMs }.thenBy { it.id })
        val scene = sceneFromFlows(flows)
        val empty = when {
            liveness is RoutingLiveness.Offline && flows.isEmpty() -> RoutingEmptyReason.Offline
            flows.isEmpty() -> RoutingEmptyReason.Idle
            else -> null
        }
        return scene.copy(liveness = liveness, devices = devices, empty = empty)
    }

    private fun emptyScene(liveness: RoutingLiveness, reason: RoutingEmptyReason) = RoutingScene(
        liveness = liveness,
        devices = emptyList(),
        agents = emptyList(),
        targets = emptyList(),
        flows = emptyList(),
        stats = RoutingStats(0, 0, 0, 0),
        empty = reason
    )

    /** 节点与统计：与桌面 `buildRoutingScene` 同一套规则（最新的流决定节点状态，多出的折叠成 +N）。 */
    internal fun sceneFromFlows(flows: List<RoutingFlow>): RoutingScene {
        data class Ranked(var node: RoutingNode, val at: Long)

        val agents = LinkedHashMap<String, Ranked>()
        val targets = LinkedHashMap<String, Ranked>()
        for (flow in flows) {
            val agent = agents[flow.agent]
            if (agent == null) {
                val state = if (flow.phase == RoutingFlowPhase.Inflight) RoutingNodeState.Busy else RoutingNodeState.Idle
                agents[flow.agent] = Ranked(RoutingNode(flow.agent, flow.agent, state = state), flow.atServerMs)
            } else if (flow.phase == RoutingFlowPhase.Inflight) {
                agent.node = agent.node.copy(state = RoutingNodeState.Busy)
            }
            for (hop in flow.hops) {
                val existing = targets[hop.target]
                if (existing != null) {
                    if (hop.outcome == RoutingHopOutcome.Pending) existing.node = existing.node.copy(state = RoutingNodeState.Busy)
                    continue
                }
                val state = when (hop.outcome) {
                    RoutingHopOutcome.Pending -> RoutingNodeState.Busy
                    RoutingHopOutcome.Ok -> RoutingNodeState.Ok
                    RoutingHopOutcome.Skipped -> RoutingNodeState.Idle
                    RoutingHopOutcome.Failed, RoutingHopOutcome.Rejected -> RoutingNodeState.Failed
                }
                val status = if (hop.outcome == RoutingHopOutcome.Ok || hop.outcome == RoutingHopOutcome.Pending) null else hop.status
                targets[hop.target] = Ranked(RoutingNode(hop.target, hop.target, state = state, status = status), flow.atServerMs)
            }
        }
        fun fold(items: Collection<Ranked>, limit: Int, foldId: String): List<RoutingNode> {
            val sorted = items.sortedByDescending { it.at }
            val kept = sorted.take(limit).map { it.node }
            val folded = sorted.size - kept.size
            return if (folded > 0) kept + RoutingNode(foldId, "+$folded", more = folded) else kept
        }
        val stats = RoutingStats(
            requests = flows.count { it.phase != RoutingFlowPhase.Inflight },
            rerouted = flows.count { it.hops.size > 1 },
            failed = flows.count { it.phase == RoutingFlowPhase.Failed },
            inflight = flows.count { it.phase == RoutingFlowPhase.Inflight }
        )
        return RoutingScene(
            liveness = RoutingLiveness.NoSnapshot,
            devices = emptyList(),
            agents = fold(agents.values, MAX_AGENTS, FOLDED_AGENTS),
            targets = fold(targets.values, MAX_TARGETS, FOLDED_TARGETS),
            flows = flows,
            stats = stats,
            empty = if (flows.isEmpty()) RoutingEmptyReason.Idle else null
        )
    }

    const val FOLDED_AGENTS = "+agents"
    const val FOLDED_TARGETS = "+targets"

    /** 一句话说明（与桌面 `describeFlow` 同一措辞），用于舞台下方说明与读屏。 */
    fun describe(flow: RoutingFlow): String {
        val who = if (flow.agent == UNKNOWN_AGENT) "请求" else "${flow.agent} 的请求"
        val via = flow.via.ifEmpty { flow.source.label }
        if (flow.phase == RoutingFlowPhase.Inflight) {
            val target = flow.hops.firstOrNull()?.target
            val wait = when (flow.waitingOn) {
                "slot" -> "排队等空位"
                "rpm" -> "等速率限制"
                "upstream" -> "等上游回复"
                else -> "处理中"
            }
            return if (target != null) "${who}正发往 $target，$wait" else "${who}正在选路，$wait"
        }
        val last = flow.hops.lastOrNull()
        if (last == null) return if (flow.phase == RoutingFlowPhase.Failed) "$who（$via）失败" else "$who（$via）已处理"
        val failedHops = flow.hops.filter { it.outcome != RoutingHopOutcome.Ok }
        val switched = if (failedHops.isNotEmpty() && flow.phase != RoutingFlowPhase.Failed) {
            failedHops.joinToString("，") { hop -> "${hop.target}${hop.status?.let { " 返回 $it" } ?: " 失败"}" } +
                "，已切换到 ${last.target}"
        } else null
        return when (flow.phase) {
            RoutingFlowPhase.Failed -> if (flow.hops.size > 1) {
                "$who（$via）依次试了 ${flow.hops.size} 个成员都没成功"
            } else {
                "$who（$via）失败${last.status?.let { "：$it" } ?: ""}"
            }
            RoutingFlowPhase.Routed -> if (switched != null) "$who（$via）：$switched，已接通" else "$who（$via）已接通 ${last.target}"
            else -> if (switched != null) "$who：$switched，已完成" else "${who}由 ${last.target} 完成"
        }
    }

    internal fun parseTime(raw: String?): Long? {
        if (raw.isNullOrBlank()) return null
        return runCatching { OffsetDateTime.parse(raw).toInstant().toEpochMilli() }.getOrNull()
    }
}

/**
 * 「第一次出现才播放一次、早于 10 分钟的不播放」（契约 §5）。路由页与壁纸各持一个实例；
 * 只认流 id，不依赖手机时钟。快照离线时不播放，但仍把看到的流记成已见，恢复在线后不补播旧流。
 */
class RoutingPlaybackTracker(private val maxRemembered: Int = 512) {
    private val seen = LinkedHashSet<String>()

    /** 返回本轮新出现、应当播放的流（旧在前，便于按发生顺序依次播）；最多 [limit] 条，取最新的。 */
    fun takeNew(scene: RoutingScene, nowServerMs: Long, limit: Int = 3): List<RoutingFlow> {
        val fresh = scene.flows.filter { flow ->
            flow.phase != RoutingFlowPhase.Inflight && seen.add(flow.id)
        }
        while (seen.size > maxRemembered) seen.remove(seen.first())
        if (!scene.playable) return emptyList()
        return fresh
            .filter { nowServerMs - it.atServerMs in -5_000L until RoutingSnapshots.PLAYABLE_WITHIN_MS }
            .take(limit)
            .reversed()
    }
}

/**
 * 待播放的流。轮询比播放快时只留最新的几条；取出时再查一遍：桌面端离线或已超出可播放窗口的直接丢掉，
 * 不在页面开久了之后补播很早以前的请求。
 */
class RoutingPlaybackQueue(private val capacity: Int = 3) {
    private val pending = ArrayDeque<RoutingFlow>()

    val size: Int get() = pending.size

    fun offer(flows: List<RoutingFlow>) {
        pending.addAll(flows)
        while (pending.size > capacity) pending.removeFirst()
    }

    fun next(playable: Boolean, nowServerMs: Long): RoutingFlow? {
        if (!playable) {
            pending.clear()
            return null
        }
        while (true) {
            val flow = pending.removeFirstOrNull() ?: return null
            if (nowServerMs - flow.atServerMs in -5_000L until RoutingSnapshots.PLAYABLE_WITHIN_MS) return flow
        }
    }
}

private fun JSONArray?.objects(): List<JSONObject> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

private fun JSONObject.optStringOrNull(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key).trim().takeIf { it.isNotEmpty() }
