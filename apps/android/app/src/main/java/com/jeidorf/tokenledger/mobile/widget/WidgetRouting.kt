package com.jeidorf.tokenledger.mobile.widget

import com.jeidorf.tokenledger.mobile.routing.RoutingFlowPhase
import com.jeidorf.tokenledger.mobile.routing.RoutingReadFailure
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshots
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshotsResult
import org.json.JSONObject

/**
 * 额度条底部那一行路由（routing-snapshot-v1，桌面 → 云端 → 手机）。小组件不常驻，只在后台刷新时读一次快照，
 * 所以这里存的是「读到那一刻」的摘要：最新一条已结束的调用和快照年龄。渲染时按读取后流逝的时间往后推，
 * 写「N 分钟前」，不把旧快照说成实时。不存设备名、不存任何凭据。
 */
internal enum class WidgetRoutingState(val storageValue: String) {
    Ok("ok"),
    /** 云端没有任何快照：电脑端没打开「把实时路由同步到手机」。 */
    NoSnapshot("no_snapshot"),
    NotDeployed("not_deployed"),
    Unauthorized("unauthorized");

    companion object {
        fun fromStorage(value: String?): WidgetRoutingState? = entries.firstOrNull { it.storageValue == value }
    }
}

internal data class WidgetRoutingSummary(
    val userId: String,
    val state: WidgetRoutingState,
    /** 读到快照时手机的墙钟（epoch ms）。 */
    val capturedAtEpochMs: Long,
    /** 读到时最新一份快照的年龄；没有快照时为 null。 */
    val snapshotAgeMs: Long? = null,
    val latestAgent: String? = null,
    /** 最后一跳的 `供应商/模型`；没有任何跳时为 null。 */
    val latestTarget: String? = null,
    val latestFailed: Boolean = false,
    /** 这次调用中途换过成员（试了不止一个）。 */
    val latestRerouted: Boolean = false,
    /** 读到时最新那条调用的年龄。 */
    val latestAgeMs: Long? = null
)

internal enum class WidgetRoutingTone { Ok, Failed, Neutral, Warning }

internal data class WidgetRoutingLine(val text: String, val tone: WidgetRoutingTone)

/** 快照 → 摘要。合并规则与路由页、壁纸共用 [RoutingSnapshots.merge]。 */
internal fun widgetRoutingSummary(
    userId: String,
    result: RoutingSnapshotsResult,
    capturedAtEpochMs: Long
): WidgetRoutingSummary {
    if (result.snapshots.isEmpty()) {
        return WidgetRoutingSummary(userId, WidgetRoutingState.NoSnapshot, capturedAtEpochMs)
    }
    val scene = RoutingSnapshots.merge(result)
    val freshest = result.snapshots.maxOf { it.receivedAtMs }
    val latest = scene.flows.firstOrNull { it.phase != RoutingFlowPhase.Inflight }
    return WidgetRoutingSummary(
        userId = userId,
        state = WidgetRoutingState.Ok,
        capturedAtEpochMs = capturedAtEpochMs,
        snapshotAgeMs = (result.serverTimeMs - freshest).coerceAtLeast(0L),
        latestAgent = latest?.agent,
        latestTarget = latest?.hops?.lastOrNull()?.target,
        latestFailed = latest?.phase == RoutingFlowPhase.Failed,
        latestRerouted = (latest?.hops?.size ?: 0) > 1,
        latestAgeMs = latest?.let { (result.serverTimeMs - it.atServerMs).coerceAtLeast(0L) }
    )
}

/**
 * 读失败 → 摘要。网络或服务暂时不可用时返回 null：保留上一份摘要（渲染时它会按年龄如实变旧），
 * 不用一句「读不到」覆盖还有用的信息。
 */
internal fun widgetRoutingFailureSummary(
    userId: String,
    failure: RoutingReadFailure,
    capturedAtEpochMs: Long
): WidgetRoutingSummary? = when (failure) {
    RoutingReadFailure.NotDeployed -> WidgetRoutingSummary(userId, WidgetRoutingState.NotDeployed, capturedAtEpochMs)
    RoutingReadFailure.Unauthorized -> WidgetRoutingSummary(userId, WidgetRoutingState.Unauthorized, capturedAtEpochMs)
    RoutingReadFailure.BadFormat, RoutingReadFailure.Unavailable -> null
}

/** 渲染时的一行字。[nowEpochMs] 是渲染时刻的墙钟；墙钟回拨时按 0 处理，不写负数。 */
internal fun widgetRoutingLine(summary: WidgetRoutingSummary?, nowEpochMs: Long): WidgetRoutingLine {
    if (summary == null) return WidgetRoutingLine("路由 · 正在读取…", WidgetRoutingTone.Neutral)
    val elapsed = (nowEpochMs - summary.capturedAtEpochMs).coerceAtLeast(0L)
    return when (summary.state) {
        WidgetRoutingState.NoSnapshot ->
            WidgetRoutingLine("路由 · 在电脑端「桌面挂件 › 手机动态壁纸」打开同步后显示", WidgetRoutingTone.Neutral)
        WidgetRoutingState.NotDeployed ->
            WidgetRoutingLine("路由 · 云端尚未部署实时路由同步", WidgetRoutingTone.Warning)
        WidgetRoutingState.Unauthorized ->
            WidgetRoutingLine("路由 · 登录已过期，打开 TokenLedger 重新登录", WidgetRoutingTone.Warning)
        WidgetRoutingState.Ok -> {
            val agent = summary.latestAgent
            val latestAge = summary.latestAgeMs
            if (agent == null || latestAge == null) {
                val snapshotAge = (summary.snapshotAgeMs ?: 0L) + elapsed
                if (snapshotAge > RoutingSnapshots.OFFLINE_AFTER_MS) {
                    WidgetRoutingLine("路由 · 暂无请求 · 桌面 ${formatRoutingAgo(snapshotAge)}在线", WidgetRoutingTone.Neutral)
                } else {
                    WidgetRoutingLine("路由 · 桌面在线 · 暂无请求", WidgetRoutingTone.Neutral)
                }
            } else {
                val who = if (agent == RoutingSnapshots.UNKNOWN_AGENT) "请求" else agent
                val ago = formatRoutingAgo(latestAge + elapsed)
                when {
                    summary.latestFailed -> WidgetRoutingLine("路由 · $who 失败 · $ago", WidgetRoutingTone.Failed)
                    summary.latestTarget == null -> WidgetRoutingLine("路由 · $who 已处理 · $ago", WidgetRoutingTone.Ok)
                    summary.latestRerouted ->
                        WidgetRoutingLine("路由 · $who → ${summary.latestTarget}（已切换）· $ago", WidgetRoutingTone.Ok)
                    else -> WidgetRoutingLine("路由 · $who → ${summary.latestTarget} · $ago", WidgetRoutingTone.Ok)
                }
            }
        }
    }
}

/** 「刚刚」「3 分钟前」「2 小时前」「1 天前」。 */
internal fun formatRoutingAgo(ageMs: Long): String = formatRelativeTime(ageMs)

internal fun encodeWidgetRoutingSummary(summary: WidgetRoutingSummary): String = JSONObject().apply {
    put("v", 1)
    put("userId", summary.userId)
    put("state", summary.state.storageValue)
    put("capturedAt", summary.capturedAtEpochMs)
    summary.snapshotAgeMs?.let { put("snapshotAge", it) }
    summary.latestAgent?.let { put("agent", it) }
    summary.latestTarget?.let { put("target", it) }
    put("failed", summary.latestFailed)
    put("rerouted", summary.latestRerouted)
    summary.latestAgeMs?.let { put("latestAge", it) }
}.toString()

/** 解不出来（版本不对、字段缺失、被改坏）就当没有，绝不抛到小组件渲染里。 */
internal fun decodeWidgetRoutingSummary(raw: String?): WidgetRoutingSummary? {
    if (raw.isNullOrBlank()) return null
    return runCatching {
        val json = JSONObject(raw)
        if (json.optInt("v", -1) != 1) return null
        val userId = json.optString("userId").takeIf { it.isNotBlank() } ?: return null
        val state = WidgetRoutingState.fromStorage(json.optString("state")) ?: return null
        if (!json.has("capturedAt")) return null
        fun optLong(key: String): Long? = if (json.has(key) && !json.isNull(key)) json.getLong(key) else null
        fun optString(key: String): String? =
            if (json.has(key) && !json.isNull(key)) json.getString(key).takeIf { it.isNotBlank() } else null
        WidgetRoutingSummary(
            userId = userId,
            state = state,
            capturedAtEpochMs = json.getLong("capturedAt"),
            snapshotAgeMs = optLong("snapshotAge"),
            latestAgent = optString("agent"),
            latestTarget = optString("target"),
            latestFailed = json.optBoolean("failed", false),
            latestRerouted = json.optBoolean("rerouted", false),
            latestAgeMs = optLong("latestAge")
        )
    }.getOrNull()
}
