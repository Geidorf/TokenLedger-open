package com.jeidorf.tokenledger.mobile.ui.adaptive

import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane
import com.jeidorf.tokenledger.mobile.ui.navigation.MobileDestination
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class V2AdaptiveLayoutTest {
    @Test
    fun widthClassesUseMaterialBreakpoints() {
        assertEquals(V2WindowWidthClass.Compact, v2WindowWidthClass(390))
        assertEquals(V2WindowWidthClass.Compact, v2WindowWidthClass(599))
        // 折叠屏内屏、平板竖屏
        assertEquals(V2WindowWidthClass.Medium, v2WindowWidthClass(600))
        assertEquals(V2WindowWidthClass.Medium, v2WindowWidthClass(839))
        // 手机横屏、平板横屏
        assertEquals(V2WindowWidthClass.Expanded, v2WindowWidthClass(840))
        assertEquals(V2WindowWidthClass.Expanded, v2WindowWidthClass(1280))
    }

    @Test
    fun twoPaneNeedsExpandedWidthAndNormalText() {
        assertTrue(v2UsesTwoPane(1280, 1f))
        assertTrue(v2UsesTwoPane(840, 1.49f))
        assertFalse(v2UsesTwoPane(839, 1f))
        assertFalse(v2UsesTwoPane(840, 1.5f))
        assertFalse(v2UsesTwoPane(1280, 2f))
    }

    @Test
    fun widePagesCenterBeforeExpandedTwoPane() {
        assertEquals(V2PaneArrangement.Full, v2WidePageArrangement(599, 1f))
        assertEquals(V2PaneArrangement.Centered, v2WidePageArrangement(600, 1f))
        assertEquals(V2PaneArrangement.Centered, v2WidePageArrangement(839, 1.49f))
        assertEquals(V2PaneArrangement.Split, v2WidePageArrangement(840, 1.49f))
        assertEquals(V2PaneArrangement.Centered, v2WidePageArrangement(840, 1.5f))
        assertEquals(V2PaneArrangement.Centered, v2WidePageArrangement(1280, 2f))
    }

    @Test
    fun contentFrameUsesWindowWidthWithoutKeepingLargeTextWide() {
        assertFalse(v2UsesWideContentFrame(599, navigationWide = false))
        assertTrue(v2UsesWideContentFrame(600, navigationWide = false))
        assertTrue(v2UsesWideContentFrame(1280, navigationWide = false))
        assertTrue(v2UsesWideContentFrame(390, navigationWide = true))
    }

    @Test
    fun everyDestinationHasAWideArrangement() {
        assertEquals(V2PaneArrangement.Full, v2PaneArrangement(false, false, MobileDestination.Usage, InsightPane.Overview))
        MobileDestination.entries.forEach { destination ->
            assertEquals(V2PaneArrangement.Centered, v2PaneArrangement(true, false, destination, InsightPane.Overview))
        }
        assertEquals(V2PaneArrangement.Split, v2PaneArrangement(true, true, MobileDestination.Usage, InsightPane.Overview))
        assertEquals(V2PaneArrangement.Split, v2PaneArrangement(true, true, MobileDestination.Usage, InsightPane.Sessions))
        assertEquals(V2PaneArrangement.Centered, v2PaneArrangement(true, true, MobileDestination.Usage, InsightPane.Sources))
        assertEquals(V2PaneArrangement.Spread, v2PaneArrangement(true, true, MobileDestination.Routing, InsightPane.Overview))
        assertEquals(V2PaneArrangement.Spread, v2PaneArrangement(true, true, MobileDestination.Quota, InsightPane.Overview))
        assertEquals(V2PaneArrangement.Split, v2PaneArrangement(true, true, MobileDestination.Me, InsightPane.Overview))
    }

    @Test
    fun companionPanesNeverPointAtThemselves() {
        assertEquals(InsightPane.Sources, InsightPane.Overview.v2CompanionPane())
        assertEquals(InsightPane.Calendar, InsightPane.Trend.v2CompanionPane())
        assertEquals(InsightPane.Trend, InsightPane.Sessions.v2CompanionPane())
        assertEquals(InsightPane.Trend, InsightPane.Calendar.v2CompanionPane())
        assertEquals(InsightPane.Trend, InsightPane.Details.v2CompanionPane())
        assertNull(InsightPane.Sources.v2CompanionPane())
        InsightPane.entries.forEach { pane -> assertTrue(pane.v2CompanionPane() != pane) }
    }
}
