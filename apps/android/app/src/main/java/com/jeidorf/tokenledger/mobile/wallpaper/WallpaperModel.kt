package com.jeidorf.tokenledger.mobile.wallpaper

import com.jeidorf.tokenledger.mobile.routing.RoutingEmptyReason
import com.jeidorf.tokenledger.mobile.routing.RoutingFlow
import com.jeidorf.tokenledger.mobile.routing.RoutingFlowPhase
import com.jeidorf.tokenledger.mobile.routing.RoutingLiveness
import com.jeidorf.tokenledger.mobile.routing.RoutingPlaybackQueue
import com.jeidorf.tokenledger.mobile.routing.RoutingPlaybackTracker
import com.jeidorf.tokenledger.mobile.routing.RoutingReadFailure
import com.jeidorf.tokenledger.mobile.routing.RoutingScene
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshots
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshotsResult

/**
 * 一次读取云端快照的结果。时间用 `SystemClock.elapsedRealtime()`，不受手机改时间影响。
 * [account] 是这次读取用的已保存登录的用户 id；读取失败时也带上（读不到登录本身时为 null），
 * 换了账号就丢掉上一个账号留下的画面。
 */
internal sealed interface WallpaperRead {
    data class Ok(val result: RoutingSnapshotsResult, val readAtElapsedMs: Long, val account: String) : WallpaperRead
    /** 手机上没有登录云端账户。 */
    data object SignedOut : WallpaperRead
    /** 这个安装包没有配置云端地址。 */
    data object NotConfigured : WallpaperRead
    data class Failed(val reason: RoutingReadFailure, val account: String? = null) : WallpaperRead
}

internal enum class StatusTone { Live, Neutral, Warning }

internal data class StatusLine(val text: String, val tone: StatusTone)

/** 正在播放的一条流：光点在第 [segment] 段，走到 [progress]。 */
internal data class ActivePlay(val flow: RoutingFlow, val segment: Int, val progress: Float)

/** 播完后按结果点亮的连线。 */
internal data class LitFlow(val flow: RoutingFlow, val ok: Boolean)

/** 画一帧需要的一切；渲染器只读它，不做决定。 */
internal data class WallpaperFrame(
    val status: StatusLine,
    /** null：还没读到过数据，或读不到（未登录、未部署）。 */
    val scene: RoutingScene?,
    val active: ActivePlay?,
    val lit: List<LitFlow>,
    /** 有在途请求且桌面在线：虚线流动、网关脉冲。 */
    val inflight: Boolean,
    val caption: String?,
    /** 最近一条点亮连线还要多久熄灭。 */
    val nextLingerEndMs: Long?,
    /** 还有一条流没播完；段与段之间的间隔里 [active] 为 null，但仍要继续排帧。 */
    val playing: Boolean,
)

/**
 * 壁纸的状态机：吃进每次读取的结果，按契约 §5 决定播放什么，再按需要吐出一帧。
 * 纯 Kotlin，时间全部由调用方传入，便于单测。
 *
 * 诚实规则：
 * - 每条光点都对应快照里一条真实记录，且只在它第一次出现时播一次（[RoutingPlaybackTracker]）。
 * - 是否可播一律问 [RoutingScene.canPlay]：整体在线、所属设备在线、10 分钟内；排队的流出队时再问一遍。
 * - 桌面离线、没有快照、未登录、云端未部署时只显示原因，不播放。
 * - 说明里写「N 秒前」，不把几秒到一分钟后的回放说成实时。
 */
internal class WallpaperModel(
    private val tracker: RoutingPlaybackTracker = RoutingPlaybackTracker(),
) {
    private data class Playing(val flow: RoutingFlow, val startMs: Long, val plan: WallpaperTimeline.Plan)
    private data class Lit(val flow: RoutingFlow, val ok: Boolean, val finishedAtMs: Long)

    private var latest: WallpaperRead? = null
    private var account: String? = null
    private var lastGood: WallpaperRead.Ok? = null
    private var queue = RoutingPlaybackQueue()
    private var playing: Playing? = null
    private val lit = LinkedHashMap<String, Lit>()

    fun accept(read: WallpaperRead, nowElapsedMs: Long) {
        latest = read
        val readAccount = when (read) {
            is WallpaperRead.Ok -> read.account
            is WallpaperRead.Failed -> read.account
            else -> null
        }
        // 壁纸不可见期间换了账号时收不到 SignedOut：按读取所用的账号判断，先清掉旧账号的画面。
        if (readAccount != null && readAccount != account) {
            clear()
            account = readAccount
        }
        when (read) {
            is WallpaperRead.Ok -> {
                lastGood = read
                val scene = sceneAt(nowElapsedMs) ?: return
                queue.offer(tracker.takeNew(scene, serverNow(nowElapsedMs)))
            }
            // 换账号或退出登录：旧账号的数据不能再画。
            WallpaperRead.SignedOut, WallpaperRead.NotConfigured -> {
                clear()
                account = null
            }
            is WallpaperRead.Failed -> if (read.reason == RoutingReadFailure.NotDeployed) clear()
        }
    }

    private fun clear() {
        lastGood = null
        queue = RoutingPlaybackQueue()
        playing = null
        lit.clear()
    }

    private fun serverNow(nowElapsedMs: Long): Long {
        val good = lastGood ?: return 0L
        return good.result.serverTimeMs + (nowElapsedMs - good.readAtElapsedMs).coerceAtLeast(0L)
    }

    private fun sceneAt(nowElapsedMs: Long): RoutingScene? =
        lastGood?.let { RoutingSnapshots.merge(it.result, serverNow(nowElapsedMs)) }

    fun frame(nowElapsedMs: Long, reduceMotion: Boolean): WallpaperFrame {
        val scene = sceneAt(nowElapsedMs)
        val serverNow = serverNow(nowElapsedMs)
        advance(nowElapsedMs, reduceMotion, scene, serverNow)
        val active = playing?.let { current ->
            WallpaperTimeline.cursor(current.plan, nowElapsedMs - current.startMs)
                ?.let { ActivePlay(current.flow, it.segment, it.progress) }
        }
        val litFlows = lit.values.map { LitFlow(it.flow, it.ok) }
        val inflight = scene?.playable == true && scene.stats.inflight > 0
        val nextLingerEnd = lit.values.minOfOrNull { it.finishedAtMs + WallpaperTimeline.LINGER_MS - nowElapsedMs }
        return WallpaperFrame(
            status = status(scene),
            scene = scene,
            active = active,
            lit = litFlows,
            inflight = inflight,
            caption = caption(scene, active, serverNow),
            nextLingerEndMs = nextLingerEnd,
            playing = playing != null,
        )
    }

    private fun advance(nowMs: Long, reduceMotion: Boolean, scene: RoutingScene?, serverNow: Long) {
        playing?.let { current ->
            if (nowMs - current.startMs >= current.plan.totalMs) {
                lit[current.flow.id] = Lit(current.flow, current.flow.phase != RoutingFlowPhase.Failed, current.startMs + current.plan.totalMs)
                playing = null
            }
        }
        // 出队时按当前场景复查：离线、设备掉线或已超出窗口的流直接丢掉，恢复在线后也不补播。
        fun nextPlayable(): RoutingFlow? = scene?.let { queue.next(it, serverNow) }
        if (reduceMotion) {
            // 减少动态效果：不跑光点，直接按结果点亮。
            playing?.let { lit[it.flow.id] = Lit(it.flow, it.flow.phase != RoutingFlowPhase.Failed, nowMs) }
            playing = null
            while (true) {
                val flow = nextPlayable() ?: break
                lit[flow.id] = Lit(flow, flow.phase != RoutingFlowPhase.Failed, nowMs)
            }
        } else if (playing == null) {
            nextPlayable()?.let { flow ->
                playing = Playing(flow, nowMs, WallpaperTimeline.plan(flow.hops.size))
            }
        }
        lit.entries.removeAll { !WallpaperTimeline.lit(it.value.finishedAtMs, nowMs) }
    }

    private fun status(scene: RoutingScene?): StatusLine {
        return when (val read = latest) {
            null -> StatusLine("正在读取实时路由…", StatusTone.Neutral)
            WallpaperRead.NotConfigured -> StatusLine("这个版本没有配置云同步，无法显示实时路由", StatusTone.Warning)
            WallpaperRead.SignedOut -> StatusLine("在 TokenLedger 里登录云端账户后显示实时路由", StatusTone.Warning)
            is WallpaperRead.Failed -> when {
                read.reason == RoutingReadFailure.NotDeployed ->
                    StatusLine("云端尚未部署实时路由同步", StatusTone.Warning)
                read.reason == RoutingReadFailure.Unauthorized ->
                    StatusLine("登录已过期，打开 TokenLedger 重新登录", StatusTone.Warning)
                scene != null -> StatusLine("暂时读不到云端，稍后重试 · ${livenessText(scene)}", StatusTone.Warning)
                else -> StatusLine("暂时读不到云端，稍后重试", StatusTone.Warning)
            }
            is WallpaperRead.Ok -> when {
                scene == null -> StatusLine("正在读取实时路由…", StatusTone.Neutral)
                scene.liveness is RoutingLiveness.Live -> StatusLine(livenessText(scene), StatusTone.Live)
                else -> StatusLine(livenessText(scene), StatusTone.Neutral)
            }
        }
    }

    private fun livenessText(scene: RoutingScene): String = when (val liveness = scene.liveness) {
        RoutingLiveness.NoSnapshot -> "在电脑端「桌面挂件 › 手机动态壁纸」打开同步后显示"
        is RoutingLiveness.Offline -> "桌面已离线 ${liveness.minutes} 分钟"
        is RoutingLiveness.Live -> {
            val seconds = (liveness.ageMs / 1000L).coerceAtLeast(0L)
            if (scene.empty == RoutingEmptyReason.Idle) "桌面在线 · 暂无请求" else "近实时 · 数据 $seconds 秒前"
        }
    }

    private fun caption(scene: RoutingScene?, active: ActivePlay?, serverNow: Long): String? {
        if (scene == null) return null
        fun ago(flow: RoutingFlow): String {
            val seconds = ((serverNow - flow.atServerMs) / 1000L).coerceAtLeast(0L)
            return if (seconds < 60) "$seconds 秒前" else "${seconds / 60} 分钟前"
        }
        active?.let { return "${RoutingSnapshots.describe(it.flow)} · ${ago(it.flow)}" }
        if (scene.playable) {
            scene.flows.firstOrNull { it.phase == RoutingFlowPhase.Inflight }?.let { return RoutingSnapshots.describe(it) }
        }
        lit.values.maxByOrNull { it.finishedAtMs }?.let { return "最近：${RoutingSnapshots.describe(it.flow)} · ${ago(it.flow)}" }
        return scene.flows.firstOrNull { it.phase != RoutingFlowPhase.Inflight }
            ?.let { "最近：${RoutingSnapshots.describe(it)} · ${ago(it)}" }
    }
}
