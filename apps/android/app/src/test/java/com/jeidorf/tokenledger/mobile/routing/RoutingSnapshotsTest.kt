package com.jeidorf.tokenledger.mobile.routing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoutingSnapshotsTest {
    private fun row(
        device: String,
        receivedAt: String,
        generatedAt: String,
        flows: String,
        sources: String = """[{"id":"tokenledger","reachable":true}]""",
        version: Int = 1
    ) = """{"device":"$device","receivedAt":"$receivedAt","snapshot":{"v":$version,"generatedAt":"$generatedAt","sources":$sources,"flows":$flows}}"""

    private fun envelope(serverTime: String, vararg rows: String) =
        """{"serverTime":"$serverTime","snapshots":[${rows.joinToString(",")}]}"""

    private val failover = """{"id":"9f2c4e1a7b3d5f60","source":"tokenledger","agent":"codex","via":"group/coding","phase":"routed","at":"2026-10-24T06:59:58.120Z","hops":[{"target":"openai/gpt-5","outcome":"failed","status":429},{"target":"deepseek/deepseek-chat","outcome":"ok"}]}"""

    @Test
    fun `parses the contract example and maps desktop time onto the server clock`() {
        // 桌面时钟比服务器慢 2 秒：生成于 06:59:58，服务器 07:00:00 收到。
        val result = RoutingSnapshots.parse(
            envelope(
                "2026-10-24T07:00:05+00:00",
                row("a1b2c3d4e5f60718", "2026-10-24T07:00:00.000+00:00", "2026-10-24T06:59:58.000Z", "[$failover]")
            )
        )
        val snapshot = result.snapshots.single()
        val flow = snapshot.flows.single()
        assertEquals("codex", flow.agent)
        assertEquals(RoutingFlowPhase.Routed, flow.phase)
        assertEquals(listOf(429, null), flow.hops.map { it.status })
        assertEquals(RoutingSnapshots.parseTime("2026-10-24T07:00:00.120Z"), flow.atServerMs)

        val scene = RoutingSnapshots.merge(result)
        assertEquals(RoutingLiveness.Live(5_000L), scene.liveness)
        assertNull(scene.empty)
        assertEquals(listOf("codex"), scene.agents.map { it.label })
        assertEquals(listOf(RoutingNodeState.Failed, RoutingNodeState.Ok), scene.targets.map { it.state })
        assertEquals(429, scene.targets.first().status)
        assertEquals(RoutingStats(requests = 1, rerouted = 1, failed = 0, inflight = 0), scene.stats)
        assertEquals(
            "codex 的请求（group/coding）：openai/gpt-5 返回 429，已切换到 deepseek/deepseek-chat，已接通",
            RoutingSnapshots.describe(scene.flows.single())
        )
    }

    @Test
    fun `no snapshot means no-snapshot, never an idle animation`() {
        val scene = RoutingSnapshots.merge(RoutingSnapshots.parse("""{"serverTime":"2026-10-24T07:00:00Z","snapshots":[]}"""))
        assertEquals(RoutingLiveness.NoSnapshot, scene.liveness)
        assertEquals(RoutingEmptyReason.NoSnapshot, scene.empty)
        assertTrue(scene.flows.isEmpty())
    }

    @Test
    fun `stale snapshots are offline, drop in-flight flows and keep finished ones for the list`() {
        val inflight = """{"id":"00000000000000aa","source":"external","agent":"claude","via":"m","phase":"inflight","at":"2026-10-24T06:50:00Z","waitingOn":"rpm","hops":[{"target":"x/m","outcome":"pending"}]}"""
        val result = RoutingSnapshots.parse(
            envelope(
                "2026-10-24T07:00:00Z",
                row("a1b2c3d4e5f60718", "2026-10-24T06:57:00Z", "2026-10-24T06:57:00Z", "[$inflight,$failover]")
            )
        )
        val scene = RoutingSnapshots.merge(result)
        assertEquals(RoutingLiveness.Offline(3L), scene.liveness)
        assertEquals(listOf("9f2c4e1a7b3d5f60"), scene.flows.map { it.id })
        assertEquals(0, scene.stats.inflight)
        assertNull(scene.empty)
        assertTrue(!scene.playable)
    }

    @Test
    fun `merges devices, de-duplicates flows by id and keeps newest first`() {
        val older = """{"id":"00000000000000b1","source":"tokenledger","agent":"Agent","via":"gpt-5","phase":"failed","at":"2026-10-24T06:59:00Z","hops":[{"target":"openai/gpt-5","outcome":"failed","status":500}]}"""
        val result = RoutingSnapshots.parse(
            envelope(
                "2026-10-24T07:00:10Z",
                row("aaaaaaaaaaaaaaaa", "2026-10-24T07:00:00Z", "2026-10-24T07:00:00Z", "[$failover]"),
                row("bbbbbbbbbbbbbbbb", "2026-10-24T07:00:05Z", "2026-10-24T07:00:05Z", "[$older,$failover]")
            )
        )
        assertEquals(listOf("bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa"), result.snapshots.map { it.device })
        val scene = RoutingSnapshots.merge(result)
        assertEquals(listOf("9f2c4e1a7b3d5f60", "00000000000000b1"), scene.flows.map { it.id })
        assertEquals(RoutingStats(requests = 2, rerouted = 1, failed = 1, inflight = 0), scene.stats)
        assertEquals("请求（gpt-5）失败：500", RoutingSnapshots.describe(scene.flows[1]))
    }

    @Test
    fun `unknown snapshot versions are skipped, not guessed`() {
        val result = RoutingSnapshots.parse(
            envelope(
                "2026-10-24T07:00:00Z",
                row("aaaaaaaaaaaaaaaa", "2026-10-24T07:00:00Z", "2026-10-24T07:00:00Z", "[]", version = 2)
            )
        )
        assertEquals(1, result.skipped)
        assertEquals(RoutingEmptyReason.NoSnapshot, RoutingSnapshots.merge(result).empty)
    }

    @Test(expected = RoutingSnapshotFormatException::class)
    fun `missing server time is a format error`() {
        RoutingSnapshots.parse("""{"snapshots":[]}""")
    }

    @Test
    fun `folds extra agents and targets into +N nodes`() {
        val flows = (1..7).map { index ->
            RoutingFlow(
                id = "f$index",
                source = RoutingSourceId.TokenLedger,
                agent = "agent$index",
                via = "group/g",
                phase = RoutingFlowPhase.Done,
                atServerMs = 1_000L * index,
                hops = listOf(RoutingHop("p$index/m", RoutingHopOutcome.Ok))
            )
        }.sortedByDescending { it.atServerMs }
        val scene = RoutingSnapshots.sceneFromFlows(flows)
        assertEquals(listOf("agent7", "agent6", "agent5", "agent4", "+3"), scene.agents.map { it.label })
        assertEquals(3, scene.agents.last().more)
        assertEquals(6, scene.targets.size)
        assertEquals("+2", scene.targets.last().label)
    }

    @Test
    fun `plays a flow once, only while live and only when recent`() {
        val result = RoutingSnapshots.parse(
            envelope(
                "2026-10-24T07:00:05Z",
                row("aaaaaaaaaaaaaaaa", "2026-10-24T07:00:00Z", "2026-10-24T07:00:00Z", "[$failover]")
            )
        )
        val now = result.serverTimeMs
        val tracker = RoutingPlaybackTracker()
        val scene = RoutingSnapshots.merge(result)
        assertEquals(listOf("9f2c4e1a7b3d5f60"), tracker.takeNew(scene, now).map { it.id })
        assertTrue(tracker.takeNew(scene, now).isEmpty())

        val stale = RoutingPlaybackTracker()
        assertTrue(stale.takeNew(scene, now + RoutingSnapshots.PLAYABLE_WITHIN_MS + 1_000L).isEmpty())
    }

    @Test
    fun `describes in-flight requests by what they wait on`() {
        val flow = RoutingFlow(
            id = "x",
            source = RoutingSourceId.External,
            agent = "claude",
            via = "sonnet",
            phase = RoutingFlowPhase.Inflight,
            atServerMs = 0L,
            waitingOn = "slot",
            hops = listOf(RoutingHop("anthropic/sonnet", RoutingHopOutcome.Pending))
        )
        assertEquals("claude 的请求正发往 anthropic/sonnet，排队等空位", RoutingSnapshots.describe(flow))
    }

    @Test
    fun `an in-flight request plays once it finishes under the same id`() {
        fun flow(phase: RoutingFlowPhase) = RoutingFlow(
            id = "same",
            source = RoutingSourceId.External,
            agent = "claude",
            via = "sonnet",
            phase = phase,
            atServerMs = 1_000L,
            hops = listOf(RoutingHop("anthropic/sonnet", if (phase == RoutingFlowPhase.Inflight) RoutingHopOutcome.Pending else RoutingHopOutcome.Ok))
        )
        val tracker = RoutingPlaybackTracker()
        val live = RoutingLiveness.Live(0L)
        val inflight = RoutingSnapshots.sceneFromFlows(listOf(flow(RoutingFlowPhase.Inflight))).copy(liveness = live)
        assertTrue(tracker.takeNew(inflight, 2_000L).isEmpty())
        val done = RoutingSnapshots.sceneFromFlows(listOf(flow(RoutingFlowPhase.Done))).copy(liveness = live)
        assertEquals(listOf("same"), tracker.takeNew(done, 2_000L).map { it.id })
    }

    @Test
    fun `playback queue keeps only the newest and drops stale or offline flows`() {
        fun flow(id: String, at: Long) = RoutingFlow(
            id = id,
            source = RoutingSourceId.TokenLedger,
            agent = "a",
            via = "m",
            phase = RoutingFlowPhase.Done,
            atServerMs = at,
            hops = listOf(RoutingHop("p/m", RoutingHopOutcome.Ok))
        )
        val queue = RoutingPlaybackQueue(capacity = 3)
        queue.offer((1..5).map { flow("f$it", it * 1_000L) })
        assertEquals(3, queue.size)
        assertEquals("f3", queue.next(playable = true, nowServerMs = 6_000L)?.id)

        val later = 4_000L + RoutingSnapshots.PLAYABLE_WITHIN_MS
        assertEquals("f5", queue.next(playable = true, nowServerMs = later)?.id)
        assertNull(queue.next(playable = true, nowServerMs = later))

        queue.offer(listOf(flow("g", 10_000L)))
        assertNull(queue.next(playable = false, nowServerMs = 10_000L))
        assertEquals(0, queue.size)
    }
}
