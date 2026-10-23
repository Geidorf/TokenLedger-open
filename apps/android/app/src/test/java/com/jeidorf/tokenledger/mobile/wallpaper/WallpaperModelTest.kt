package com.jeidorf.tokenledger.mobile.wallpaper

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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WallpaperModelTest {
    private val server = 1_800_000_000_000L

    private fun flow(id: String, ageMs: Long, phase: RoutingFlowPhase = RoutingFlowPhase.Routed) = RoutingFlow(
        id = id,
        source = RoutingSourceId.TokenLedger,
        agent = "codex",
        via = "group/coding",
        phase = phase,
        atServerMs = server - ageMs,
        hops = if (phase == RoutingFlowPhase.Inflight) {
            listOf(RoutingHop("openai/gpt-5", RoutingHopOutcome.Pending))
        } else {
            listOf(RoutingHop("openai/gpt-5", RoutingHopOutcome.Failed, 429), RoutingHop("deepseek/deepseek-chat", RoutingHopOutcome.Ok, 200))
        },
        device = "d1"
    )

    private fun result(vararg flows: RoutingFlow, snapshotAgeMs: Long = 3_000) = RoutingSnapshotsResult(
        serverTimeMs = server,
        snapshots = listOf(
            RoutingDeviceSnapshot("d1", server - snapshotAgeMs, listOf(RoutingSourceState(RoutingSourceId.TokenLedger, true)), flows.toList())
        )
    )

    @Test
    fun aNewFlowPlaysOnceThenStaysLitThenFades() {
        val model = WallpaperModel()
        model.accept(WallpaperRead.Ok(result(flow("a", ageMs = 4_000)), readAtElapsedMs = 0), nowElapsedMs = 0)
        val first = model.frame(0, reduceMotion = false)
        assertNotNull(first.active)
        assertEquals(0, first.active!!.segment)
        assertTrue(first.caption!!.contains("秒前"))
        assertEquals(StatusTone.Live, first.status.tone)

        // Same flow in the next snapshot: not replayed.
        model.accept(WallpaperRead.Ok(result(flow("a", ageMs = 9_000)), readAtElapsedMs = 5_000), nowElapsedMs = 5_000)
        val afterPlay = model.frame(5_000, reduceMotion = false)
        assertNull(afterPlay.active)
        assertEquals(listOf("a"), afterPlay.lit.map { it.flow.id })
        assertTrue(afterPlay.lit.single().ok)
        assertTrue(afterPlay.caption!!.startsWith("最近："))

        assertTrue(model.frame(5_000 + WallpaperTimeline.LINGER_MS, reduceMotion = false).lit.isEmpty())
    }

    @Test
    fun oldFlowsAndOfflineDesktopsDoNotPlay() {
        val model = WallpaperModel()
        model.accept(WallpaperRead.Ok(result(flow("old", ageMs = 11 * 60_000L)), 0), 0)
        assertNull(model.frame(0, false).active)

        val offline = WallpaperModel()
        offline.accept(WallpaperRead.Ok(result(flow("x", ageMs = 2_000), snapshotAgeMs = 5 * 60_000L), 0), 0)
        val frame = offline.frame(0, false)
        assertNull(frame.active)
        assertFalse(frame.inflight)
        assertEquals("桌面已离线 5 分钟", frame.status.text)
    }

    @Test
    fun inFlightRequestsAnimateOnlyWhileLive() {
        val model = WallpaperModel()
        model.accept(WallpaperRead.Ok(result(flow("live", ageMs = 1_000, phase = RoutingFlowPhase.Inflight)), 0), 0)
        val frame = model.frame(0, false)
        assertTrue(frame.inflight)
        assertNull("in-flight flows are not played as dots", frame.active)
        assertTrue(frame.caption!!.contains("正发往 openai/gpt-5"))
    }

    @Test
    fun reducedMotionLightsWithoutPlaying() {
        val model = WallpaperModel()
        model.accept(WallpaperRead.Ok(result(flow("a", ageMs = 1_000)), 0), 0)
        val frame = model.frame(0, reduceMotion = true)
        assertNull(frame.active)
        assertEquals(listOf("a"), frame.lit.map { it.flow.id })
    }

    @Test
    fun everyEmptyStateSaysWhy() {
        assertEquals("正在读取实时路由…", WallpaperModel().frame(0, false).status.text)
        fun statusOf(read: WallpaperRead) = WallpaperModel().apply { accept(read, 0) }.frame(0, false)
        assertTrue(statusOf(WallpaperRead.SignedOut).status.text.contains("登录"))
        assertTrue(statusOf(WallpaperRead.NotConfigured).status.text.contains("没有配置"))
        assertTrue(statusOf(WallpaperRead.Failed(RoutingReadFailure.NotDeployed)).status.text.contains("尚未部署"))
        assertTrue(statusOf(WallpaperRead.Failed(RoutingReadFailure.Unavailable)).status.text.contains("稍后重试"))
        val none = statusOf(WallpaperRead.Ok(RoutingSnapshotsResult(server, emptyList()), 0))
        assertTrue(none.status.text.contains("打开同步"))
        assertNull(none.caption)
        val idle = statusOf(WallpaperRead.Ok(result(), 0))
        assertEquals("桌面在线 · 暂无请求", idle.status.text)
    }

    @Test
    fun signingOutDropsTheOldAccountsScene() {
        val model = WallpaperModel()
        model.accept(WallpaperRead.Ok(result(flow("a", ageMs = 1_000)), 0), 0)
        model.accept(WallpaperRead.SignedOut, 1_000)
        val frame = model.frame(1_000, false)
        assertNull(frame.scene)
        assertNull(frame.active)
        assertTrue(frame.lit.isEmpty())
    }

    @Test
    fun aFailedReadKeepsTheLastSceneButSaysSo() {
        val model = WallpaperModel()
        model.accept(WallpaperRead.Ok(result(flow("a", ageMs = 1_000)), 0), 0)
        model.accept(WallpaperRead.Failed(RoutingReadFailure.Unavailable), 5_000)
        val frame = model.frame(5_000, false)
        assertNotNull(frame.scene)
        assertEquals(StatusTone.Warning, frame.status.tone)
        assertTrue(frame.status.text.startsWith("暂时读不到云端"))
    }
}
