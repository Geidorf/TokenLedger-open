package com.jeidorf.tokenledger.mobile.widget

import com.jeidorf.tokenledger.mobile.routing.RoutingDeviceSnapshot
import com.jeidorf.tokenledger.mobile.routing.RoutingFlow
import com.jeidorf.tokenledger.mobile.routing.RoutingFlowPhase
import com.jeidorf.tokenledger.mobile.routing.RoutingHop
import com.jeidorf.tokenledger.mobile.routing.RoutingHopOutcome
import com.jeidorf.tokenledger.mobile.routing.RoutingReadFailure
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshotsResult
import com.jeidorf.tokenledger.mobile.routing.RoutingSourceId
import com.jeidorf.tokenledger.mobile.routing.RoutingSourceState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 实时路由小组件：快照 → 一帧、按年龄往后推、点亮规则、版面、刷新节奏与存取。 */
class RoutingLiveWidgetTest {
    private val server = 1_800_000_000_000L
    private val captured = 1_700_000_000_000L

    private fun flow(id: String, agent: String, ageMs: Long, phase: RoutingFlowPhase, vararg hops: RoutingHop) = RoutingFlow(
        id = id, source = RoutingSourceId.TokenLedger, agent = agent, via = "default",
        phase = phase, atServerMs = server - ageMs, hops = hops.toList(), device = "d1"
    )

    private fun result(snapshotAgeMs: Long, vararg flows: RoutingFlow) = RoutingSnapshotsResult(
        serverTimeMs = server,
        snapshots = listOf(
            RoutingDeviceSnapshot("d1", server - snapshotAgeMs, listOf(RoutingSourceState(RoutingSourceId.TokenLedger, true)), flows.toList())
        )
    )

    private val busy = result(
        3_000,
        flow("a", "Claude Code", 20_000L, RoutingFlowPhase.Done, RoutingHop("anthropic/sonnet", RoutingHopOutcome.Ok)),
        flow(
            "b", "Codex", 2 * 60_000L, RoutingFlowPhase.Done,
            RoutingHop("p1/m", RoutingHopOutcome.Failed, 429), RoutingHop("p2/m", RoutingHopOutcome.Ok)
        ),
        flow("c", "Cursor", 6 * 60_000L, RoutingFlowPhase.Failed, RoutingHop("p3/m", RoutingHopOutcome.Failed, 500)),
        flow("d", "Claude Code", 9 * 60_000L, RoutingFlowPhase.Done, RoutingHop("anthropic/sonnet", RoutingHopOutcome.Ok)),
        flow("e", "Codex", 1_000L, RoutingFlowPhase.Inflight, RoutingHop("p2/m", RoutingHopOutcome.Pending))
    )

    @Test
    fun keepsTheThreeLatestFinishedCallsAndCountsInflight() {
        val snapshot = routingLiveSnapshot("u1", busy, captured)
        assertEquals(WidgetRoutingState.Ok, snapshot.state)
        assertEquals(listOf("Claude Code", "Codex", "Cursor"), snapshot.flows.map { it.agent })
        assertEquals(1, snapshot.inflight)
        assertEquals(listOf("Codex", "Claude Code", "Cursor"), snapshot.agents.map { it.label })
        assertTrue(snapshot.targets.any { it.label == "p1/m" })
    }

    @Test
    fun rowsSpellOutTargetsRerouteAndFailureAndAgeAfterCapture() {
        val view = routingLiveView(routingLiveSnapshot("u1", busy, captured), captured + 3 * 60_000L)
        assertEquals("桌面在线 · 3 分钟前读取", view.status)
        assertEquals(
            listOf("Claude Code → anthropic/sonnet", "Codex → p2/m", "Cursor 失败 · 500"),
            view.rows.map { it.text }
        )
        assertEquals(listOf("3 分钟前", "5 分钟前", "9 分钟前"), view.rows.map { it.ago })
        assertEquals(listOf(false, true, false), view.rows.map { it.rerouted })
        assertEquals(WidgetRoutingTone.Failed, view.rows[2].tone)
        // 读到时在途，但已过去 3 分钟：不再画成在途。
        assertFalse(view.busy)
        assertTrue(routingLiveView(routingLiveSnapshot("u1", busy, captured), captured + 10_000L).busy)
    }

    @Test
    fun onlyCallsWithinTenMinutesLightTheFrame() {
        val snapshot = routingLiveSnapshot("u1", busy, captured)
        val fresh = routingLiveView(snapshot, captured)
        val edges = routingLiveEdges(fresh)
        assertTrue(RoutingLiveEdge("Claude Code", "anthropic/sonnet", true) in edges)
        assertTrue(RoutingLiveEdge("Codex", "p1/m", false) in edges)
        assertTrue(RoutingLiveEdge("Codex", "p2/m", true) in edges)
        assertTrue(RoutingLiveEdge("Cursor", "p3/m", false) in edges)
        // 5 分钟后：Cursor 那条（读到时 6 分钟）已超出 10 分钟，不再点亮；Codex 仍在。
        val later = routingLiveEdges(routingLiveView(snapshot, captured + 5 * 60_000L))
        assertFalse(later.any { it.agent == "Cursor" })
        assertTrue(later.any { it.agent == "Codex" })
        // 一小时后什么都不亮，但行仍按真实年龄列出。
        val stale = routingLiveView(snapshot, captured + 60 * 60_000L)
        assertTrue(routingLiveEdges(stale).isEmpty())
        assertEquals(3, stale.rows.size)
    }

    @Test
    fun offlineDesktopAndMissingDataSayWhy() {
        val offline = routingLiveView(
            routingLiveSnapshot("u1", result(5 * 60_000L, flow("a", "Codex", 6 * 60_000L, RoutingFlowPhase.Done)), captured),
            captured + 60_000L
        )
        assertEquals("桌面离线 · 6 分钟前在线", offline.status)
        assertEquals("Codex 已处理", offline.rows.single().text)
        val idle = routingLiveView(routingLiveSnapshot("u1", result(3_000), captured), captured)
        assertEquals("桌面在线 · 刚刚读取", idle.status)
        assertEquals("暂无请求", idle.emptyText)
        val none = routingLiveView(routingLiveSnapshot("u1", RoutingSnapshotsResult(server, emptyList()), captured), captured)
        assertNull(none.agents)
        assertEquals("在电脑端「桌面挂件 › 手机动态壁纸」打开同步后显示", none.emptyText)
        assertEquals("正在读取…", routingLiveView(null, captured).status)
        assertNull(routingLiveFailureSnapshot("u1", RoutingReadFailure.Unavailable, captured))
        val notDeployed = routingLiveFailureSnapshot("u1", RoutingReadFailure.NotDeployed, captured)
        assertEquals("云端尚未部署实时路由同步", routingLiveView(notDeployed, captured).emptyText)
    }

    @Test
    fun clockGoingBackwardsNeverWritesNegativeAges() {
        val view = routingLiveView(routingLiveSnapshot("u1", busy, captured), captured - 3_600_000L)
        assertEquals("刚刚", view.rows.first().ago)
        assertEquals("桌面在线 · 刚刚读取", view.status)
    }

    @Test
    fun layoutKeepsRowsFirstAndDrawsTheFrameOnlyWhenItFits() {
        val big = routingLiveLayout(320f, 220f, 1f)
        assertTrue(big.sufficient && big.showFrame)
        assertEquals(3, big.rowCount)
        assertTrue(big.frameHeightDp >= RoutingLiveWidgetMetrics.FRAME_MIN_DP)
        assertTrue(big.frameHeightDp <= RoutingLiveWidgetMetrics.FRAME_MAX_DP)
        val short = routingLiveLayout(320f, 110f, 1f)
        assertTrue(short.sufficient)
        assertFalse(short.showFrame)
        assertEquals(3, short.rowCount)
        val narrow = routingLiveLayout(190f, 220f, 1f)
        assertFalse(narrow.showFrame)
        val hugeFont = routingLiveLayout(320f, 220f, 2f)
        assertTrue(hugeFont.sufficient)
        assertTrue(hugeFont.rowCount >= 1)
        assertFalse(routingLiveLayout(100f, 60f, 1f).sufficient)
        assertFalse(routingLiveLayout(Float.NaN, 200f, 1f).sufficient)
    }

    @Test
    fun cadenceSpeedsUpOnlyWhileTheDesktopIsLive() {
        val active = routingLiveSnapshot("u1", busy, captured)
        assertEquals(RoutingLiveCadence.ACTIVE_MS, routingLiveNextDelayMs(active, captured))
        val idle = routingLiveSnapshot("u1", result(3_000, flow("a", "Codex", 30 * 60_000L, RoutingFlowPhase.Done)), captured)
        assertEquals(RoutingLiveCadence.IDLE_MS, routingLiveNextDelayMs(idle, captured))
        assertNull(routingLiveNextDelayMs(routingLiveSnapshot("u1", result(5 * 60_000L), captured), captured))
        assertNull(routingLiveNextDelayMs(routingLiveSnapshot("u1", RoutingSnapshotsResult(server, emptyList()), captured), captured))
        assertNull(routingLiveNextDelayMs(routingLiveFailureSnapshot("u1", RoutingReadFailure.Unauthorized, captured), captured))
        assertNull(routingLiveNextDelayMs(null, captured))
    }

    @Test
    fun keptFrameAfterFailedReadsStopsTheChain() {
        // 成功读到一次在线活跃帧，之后连续网络/格式错误：保留的仍是这一帧。
        val kept = routingLiveSnapshot("u1", busy, captured)
        assertNull(routingLiveFailureSnapshot("u1", RoutingReadFailure.Unavailable, captured + 60_000L))
        // 下一次链上读取时（3 分钟后）它已不能算在线，链停下，交回周期刷新。
        assertNull(routingLiveNextDelayMs(kept, captured + RoutingLiveCadence.ACTIVE_MS))
        // 刚读到时 80 秒内仍算在线；在线但最近的调用随时间超过 10 分钟就降到空闲节奏。
        val quiet = routingLiveSnapshot(
            "u1", result(1_000, flow("a", "Codex", 9 * 60_000L + 30_000L, RoutingFlowPhase.Done)), captured
        )
        assertEquals(RoutingLiveCadence.ACTIVE_MS, routingLiveNextDelayMs(quiet, captured))
        assertEquals(RoutingLiveCadence.IDLE_MS, routingLiveNextDelayMs(quiet, captured + 60_000L))
    }

    @Test
    fun snapshotRoundTripsAndRejectsGarbage() {
        val snapshot = routingLiveSnapshot("u1", busy, captured)
        assertEquals(snapshot, decodeRoutingLiveSnapshot(encodeRoutingLiveSnapshot(snapshot)))
        val bare = RoutingLiveSnapshot("u1", WidgetRoutingState.NoSnapshot, captured)
        assertEquals(bare, decodeRoutingLiveSnapshot(encodeRoutingLiveSnapshot(bare)))
        assertNull(decodeRoutingLiveSnapshot(null))
        assertNull(decodeRoutingLiveSnapshot("not json"))
        assertNull(decodeRoutingLiveSnapshot("""{"v":2,"userId":"u1","state":"ok","capturedAt":1}"""))
        assertNull(decodeRoutingLiveSnapshot("""{"v":1,"userId":"","state":"ok","capturedAt":1}"""))
        // 存下来的不含设备标识。
        assertFalse(encodeRoutingLiveSnapshot(snapshot).contains("d1"))
    }

    @Test
    fun accessibilityReadsStatusAndEveryRow() {
        val view = routingLiveView(routingLiveSnapshot("u1", busy, captured), captured)
        val spoken = routingLiveAccessibility(view)
        assertTrue(spoken.startsWith("实时路由；桌面在线 · 刚刚读取；"))
        assertTrue(spoken.contains("已切换到 p2/m"))
        assertTrue(spoken.endsWith("双击打开 TokenLedger"))
    }
}
