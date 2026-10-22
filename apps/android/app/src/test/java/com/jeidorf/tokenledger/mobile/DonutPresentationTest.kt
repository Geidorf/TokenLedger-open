package com.jeidorf.tokenledger.mobile

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

class DonutPresentationTest {
    private fun hit(chart: DonutPresentation, angle: Float): Int? {
        val radians = Math.toRadians(angle.toDouble())
        return donutSegmentAtOffset(chart, 100f + (90 * cos(radians)).toFloat(), 100f + (90 * sin(radians)).toFloat(), 200f, 20f)
    }

    @Test fun sixSourcesKeepFullDenominatorAndNeutralRemainder() {
        val all = listOf(60L, 50L, 40L, 30L, 20L, 10L)
        val chart = donutPresentation(all.take(5), all.sum())
        assertTrue(chart.valid)
        assertEquals(6, chart.segments.size)
        assertEquals(60.0 / 210, chart.selected(0)!!.fraction, 1e-12)
        assertEquals(360.0 * 60 / 210, chart.selected(0)!!.sweepDegrees.toDouble(), 0.0001)
        val remainder = chart.segments.last()
        assertNull(remainder.sourceIndex)
        assertEquals(10L, remainder.value)
        assertNull(hit(chart, remainder.startDegrees + remainder.sweepDegrees / 2))
        chart.segments.filter { it.sourceIndex != null }.forEach {
            assertEquals(it.sourceIndex, hit(chart, it.startDegrees + it.sweepDegrees / 2))
            assertEquals(it, chart.selected(it.sourceIndex))
        }
    }

    @Test fun zerosNeverCreateArcsOrHitTargetsAndIndicesStayStable() {
        val chart = donutPresentation(listOf(0, 40, 0, 60), 100)
        assertEquals(listOf(1, 3), chart.segments.map { it.sourceIndex })
        assertNull(chart.selected(0))
        assertNull(chart.selected(2))
        assertEquals(1, hit(chart, -89f))
        assertEquals(3, hit(chart, 269f))
    }

    @Test fun allZeroIsEmptyAndCenterAndOutsideAreNotSources() {
        val empty = donutPresentation(listOf(0, 0, 0), 0)
        assertTrue(empty.valid)
        assertTrue(empty.segments.isEmpty())
        assertNull(hit(empty, 0f))
        val chart = donutPresentation(listOf(100), 100)
        assertNull(donutSegmentAtOffset(chart, 100f, 100f, 200f, 20f))
        assertNull(donutSegmentAtOffset(chart, 201f, 100f, 200f, 20f))
    }

    @Test fun inconsistentAndOverflowingTotalsAreNeverClampedIntoAChart() {
        listOf(donutPresentation(listOf(101), 100), donutPresentation(listOf(-1, 101), 100),
            donutPresentation(listOf(Long.MAX_VALUE, 1), Long.MAX_VALUE), donutPresentation(listOf(1), 0)).forEach {
            assertFalse(it.valid)
            assertTrue(it.segments.isEmpty())
            assertNull(it.selected(0))
        }
    }
}
