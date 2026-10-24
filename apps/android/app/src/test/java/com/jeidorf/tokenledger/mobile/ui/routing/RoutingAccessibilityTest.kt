package com.jeidorf.tokenledger.mobile.ui.routing

import com.jeidorf.tokenledger.mobile.routing.RoutingFlow
import com.jeidorf.tokenledger.mobile.routing.RoutingFlowPhase
import com.jeidorf.tokenledger.mobile.routing.RoutingHop
import com.jeidorf.tokenledger.mobile.routing.RoutingHopOutcome
import com.jeidorf.tokenledger.mobile.routing.RoutingSourceId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RoutingAccessibilityTest {
    private val flow = RoutingFlow(
        id = "f1",
        source = RoutingSourceId.External,
        agent = "claude",
        via = "sonnet",
        phase = RoutingFlowPhase.Done,
        atServerMs = 0L,
        waitingOn = null,
        hops = listOf(RoutingHop("anthropic/sonnet", RoutingHopOutcome.Ok))
    )

    @Test
    fun `live announcement does not change while the visible age ticks`() {
        // 第一分钟里「N 秒前」每秒一变；播报区的内容只要变，TalkBack 就再念一遍。
        val captions = (0L..90L).map { routingFooterCaption(flow, it * 1_000L) }.toSet()
        var announced: RoutingAnnouncement? = null
        val announcements = (0L..90L).map {
            nextRoutingAnnouncement(announced, flow).also { next -> announced = next }.text
        }.toSet()
        assertTrue("visible caption keeps showing the age", captions.size > 50)
        assertEquals(1, announcements.size)
        assertTrue(announcements.single().isNotBlank())
        assertTrue("no age in what gets announced", "秒前" !in announcements.single() && "最近" !in announcements.single())
    }

    @Test
    fun `every new flow changes the announcement, even with the same description`() {
        val first = nextRoutingAnnouncement(null, flow)
        val twin = nextRoutingAnnouncement(first, flow.copy(id = "f2"))
        assertNotEquals("same agent, target and outcome must still be announced", first.text, twin.text)
        val third = nextRoutingAnnouncement(twin, flow.copy(id = "f3"))
        assertNotEquals(twin.text, third.text)
        val other = nextRoutingAnnouncement(third, flow.copy(id = "f4", agent = "codex"))
        assertNotEquals(third.text, other.text)
        assertEquals("", nextRoutingAnnouncement(other, null).text)
    }

    @Test
    fun `the same flow is announced again only when what it says changes`() {
        val inflight = flow.copy(phase = RoutingFlowPhase.Inflight, hops = listOf(RoutingHop("anthropic/sonnet", RoutingHopOutcome.Pending)))
        val first = nextRoutingAnnouncement(null, inflight)
        assertEquals(first, nextRoutingAnnouncement(first, inflight))
        assertNotEquals(first.text, nextRoutingAnnouncement(first, flow).text)
    }

    @Test
    fun `stage blocks keep their 100 percent size and only grow with larger text`() {
        assertEquals(60f, grownBlockHeight(base = 60f, textNow = 40f, textAtBase = 40f), 0f)
        assertEquals("smaller text never shrinks a block", 40f, grownBlockHeight(base = 40f, textNow = 18f, textAtBase = 20f), 0f)
        assertEquals("200% text grows by exactly the extra text height", 72f, grownBlockHeight(base = 40f, textNow = 52f, textAtBase = 20f), 0f)
    }

    @Test
    fun `footer stacks caption above the numbers from 150 percent text`() {
        assertTrue(!routingFooterStacks(1.0f) && !routingFooterStacks(1.3f))
        assertTrue(routingFooterStacks(1.5f) && routingFooterStacks(2.0f))
    }
}
