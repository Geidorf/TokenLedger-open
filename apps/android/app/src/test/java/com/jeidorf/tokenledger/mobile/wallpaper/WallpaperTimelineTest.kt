package com.jeidorf.tokenledger.mobile.wallpaper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WallpaperTimelineTest {
    @Test
    fun aSingleAttemptPlaysTwoSegmentsAtNaturalSpeed() {
        val plan = WallpaperTimeline.plan(hopCount = 1)
        assertEquals(2, plan.segments.size)
        assertEquals(0L, plan.segments[0].startMs)
        assertEquals(950L, plan.segments[1].startMs)
        assertEquals(1_650L, plan.totalMs)
    }

    @Test
    fun manyAttemptsCompressIntoFourSeconds() {
        for (hops in 0..8) {
            val plan = WallpaperTimeline.plan(hops)
            assertTrue("hops=$hops total=${plan.totalMs}", plan.totalMs <= WallpaperTimeline.MAX_PLAY_MS)
            assertEquals(hops + 1, plan.segments.size)
            plan.segments.zipWithNext().forEach { (a, b) -> assertTrue(b.startMs >= a.startMs + a.durationMs) }
        }
    }

    @Test
    fun cursorWalksSegmentsInOrderAndEnds() {
        val plan = WallpaperTimeline.plan(2)
        assertEquals(0, WallpaperTimeline.cursor(plan, 0)!!.segment)
        assertEquals(0.5f, WallpaperTimeline.cursor(plan, 350)!!.progress, 0.01f)
        assertNull("gap between segments draws nothing", WallpaperTimeline.cursor(plan, 800))
        assertEquals(1, WallpaperTimeline.cursor(plan, 1_000)!!.segment)
        assertNull(WallpaperTimeline.cursor(plan, plan.totalMs))
        assertNull(WallpaperTimeline.cursor(plan, -1))
    }

    @Test
    fun aFailedSegmentBouncesBackBeforeTheNode() {
        assertEquals(0.88f, WallpaperTimeline.failedPosition(0.8f), 0.001f)
        assertTrue(WallpaperTimeline.failedPosition(1f) < 0.88f)
        assertTrue((0..100).map { WallpaperTimeline.failedPosition(it / 100f) }.all { it < 0.9f })
    }

    @Test
    fun lingerLastsTwelveSeconds() {
        assertTrue(WallpaperTimeline.lit(1_000, 1_000))
        assertTrue(WallpaperTimeline.lit(1_000, 12_999))
        assertTrue(!WallpaperTimeline.lit(1_000, 13_000))
        assertTrue("future finish does not light", !WallpaperTimeline.lit(1_000, 999))
    }

    @Test
    fun framesOnlyRunWhileSomethingMoves() {
        val idle = FramePacer.Activity(visible = true, reduceMotion = false, playing = false, inflight = false, nextLingerEndMs = null)
        assertNull(FramePacer.nextFrameDelay(idle))
        assertEquals(FramePacer.PLAYING_FRAME_MS, FramePacer.nextFrameDelay(idle.copy(playing = true, inflight = true)))
        assertEquals(FramePacer.INFLIGHT_FRAME_MS, FramePacer.nextFrameDelay(idle.copy(inflight = true)))
        assertEquals(5_001L, FramePacer.nextFrameDelay(idle.copy(nextLingerEndMs = 5_000)))
        assertNull("hidden never schedules", FramePacer.nextFrameDelay(idle.copy(visible = false, playing = true)))
        assertEquals(
            "reduced motion only redraws when a lit wire goes out",
            2_001L,
            FramePacer.nextFrameDelay(idle.copy(reduceMotion = true, playing = true, inflight = true, nextLingerEndMs = 2_000))
        )
    }

    @Test
    fun powerSaveStopsPerFrameRedrawsEvenWithAnimatorsOn() {
        // 省电模式下 ValueAnimator.areAnimatorsEnabled() 仍是 true，所以要单独看。
        val busy = FramePacer.Activity(visible = true, reduceMotion = false, powerSave = true, playing = true, inflight = true, nextLingerEndMs = null)
        assertNull(FramePacer.nextFrameDelay(busy))
        assertEquals("a lit wire still goes out on time", 3_001L, FramePacer.nextFrameDelay(busy.copy(nextLingerEndMs = 3_000)))
    }
}
