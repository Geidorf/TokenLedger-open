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
import org.junit.Assert.assertNull
import org.junit.Test

/** 额度条底部路由行：快照摘要、按年龄往后推、失败时的保留规则与存取。 */
class WidgetRoutingTest {
    private val server = 1_800_000_000_000L
    private val captured = 1_700_000_000_000L

    private fun flow(id: String, ageMs: Long, phase: RoutingFlowPhase, vararg hops: RoutingHop) = RoutingFlow(
        id = id, source = RoutingSourceId.TokenLedger, agent = "Claude Code", via = "default",
        phase = phase, atServerMs = server - ageMs, hops = hops.toList(), device = "d1"
    )

    private fun result(snapshotAgeMs: Long, vararg flows: RoutingFlow) = RoutingSnapshotsResult(
        serverTimeMs = server,
        snapshots = listOf(
            RoutingDeviceSnapshot("d1", server - snapshotAgeMs, listOf(RoutingSourceState(RoutingSourceId.TokenLedger, true)), flows.toList())
        )
    )

    @Test
    fun latestFinishedCallBecomesOneLineAndAgesAfterCapture() {
        val summary = widgetRoutingSummary(
            "u1",
            result(
                3_000,
                flow("a", 2 * 60_000L, RoutingFlowPhase.Done, RoutingHop("anthropic/sonnet", RoutingHopOutcome.Ok)),
                flow("b", 1_000L, RoutingFlowPhase.Inflight, RoutingHop("anthropic/sonnet", RoutingHopOutcome.Pending))
            ),
            captured
        )
        assertEquals(WidgetRoutingState.Ok, summary.state)
        val line = widgetRoutingLine(summary, captured + 10 * 60_000L)
        assertEquals("路由 · Claude Code → anthropic/sonnet · 12 分钟前", line.text)
        assertEquals(WidgetRoutingTone.Ok, line.tone)
    }

    @Test
    fun reroutedAndFailedCallsAreSpelledOut() {
        val rerouted = widgetRoutingSummary(
            "u1",
            result(
                3_000,
                flow(
                    "a", 30_000L, RoutingFlowPhase.Done,
                    RoutingHop("p1/m", RoutingHopOutcome.Failed, 429), RoutingHop("p2/m", RoutingHopOutcome.Ok)
                )
            ),
            captured
        )
        assertEquals("路由 · Claude Code → p2/m（已切换）· 刚刚", widgetRoutingLine(rerouted, captured).text)
        val failed = widgetRoutingSummary(
            "u1",
            result(3_000, flow("a", 30_000L, RoutingFlowPhase.Failed, RoutingHop("p1/m", RoutingHopOutcome.Failed, 500))),
            captured
        )
        val line = widgetRoutingLine(failed, captured)
        assertEquals("路由 · Claude Code 失败 · 刚刚", line.text)
        assertEquals(WidgetRoutingTone.Failed, line.tone)
    }

    @Test
    fun emptyAndOfflineStatesSayWhyInsteadOfInventingTraffic() {
        val none = widgetRoutingSummary("u1", RoutingSnapshotsResult(server, emptyList()), captured)
        assertEquals(WidgetRoutingState.NoSnapshot, none.state)
        assertEquals("路由 · 在电脑端「桌面挂件 › 手机动态壁纸」打开同步后显示", widgetRoutingLine(none, captured).text)
        val idle = widgetRoutingSummary("u1", result(3_000), captured)
        assertEquals("路由 · 桌面在线 · 暂无请求", widgetRoutingLine(idle, captured).text)
        assertEquals("路由 · 暂无请求 · 桌面 5 分钟前在线", widgetRoutingLine(idle, captured + 5 * 60_000L).text)
    }

    @Test
    fun transientFailuresKeepThePreviousSummary() {
        assertNull(widgetRoutingFailureSummary("u1", RoutingReadFailure.Unavailable, captured))
        assertNull(widgetRoutingFailureSummary("u1", RoutingReadFailure.BadFormat, captured))
        assertEquals(
            WidgetRoutingState.NotDeployed,
            widgetRoutingFailureSummary("u1", RoutingReadFailure.NotDeployed, captured)?.state
        )
    }

    @Test
    fun summaryRoundTripsAndRejectsGarbage() {
        val summary = WidgetRoutingSummary(
            userId = "u1", state = WidgetRoutingState.Ok, capturedAtEpochMs = captured, snapshotAgeMs = 3_000,
            latestAgent = "Claude Code", latestTarget = "p2/m", latestFailed = false, latestRerouted = true, latestAgeMs = 30_000
        )
        assertEquals(summary, decodeWidgetRoutingSummary(encodeWidgetRoutingSummary(summary)))
        val bare = WidgetRoutingSummary("u1", WidgetRoutingState.NoSnapshot, captured)
        assertEquals(bare, decodeWidgetRoutingSummary(encodeWidgetRoutingSummary(bare)))
        assertNull(decodeWidgetRoutingSummary(null))
        assertNull(decodeWidgetRoutingSummary("not json"))
        assertNull(decodeWidgetRoutingSummary("""{"v":2,"userId":"u1","state":"ok","capturedAt":1}"""))
        assertNull(decodeWidgetRoutingSummary("""{"v":1,"userId":"u1","state":"weird","capturedAt":1}"""))
    }

    @Test
    fun clockGoingBackwardsNeverWritesNegativeAges() {
        val summary = widgetRoutingSummary(
            "u1",
            result(3_000, flow("a", 60_000L, RoutingFlowPhase.Done, RoutingHop("p/m", RoutingHopOutcome.Ok))),
            captured
        )
        assertEquals("路由 · Claude Code → p/m · 1 分钟前", widgetRoutingLine(summary, captured - 3_600_000L).text)
    }
}
