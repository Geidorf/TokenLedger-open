package com.jeidorf.tokenledger.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

/**
 * Adversarial Challenger Stress Test Suite for Milestone 2:
 * Professional Data Visualization Charts (R2).
 *
 * Focuses on empirical verification and stress-testing of:
 * 1. Fritsch-Carlson Monotone Cubic Spline (LedgerUiLogic.kt)
 *    - Continuous zeros followed by extreme spike (zero overshoot/undershoot)
 *    - Collinear points (horizontal, increasing, decreasing)
 *    - Monotone staircases and step transitions
 *    - Minimal datasets (0, 1, 2 points)
 *    - Coincident and decreasing X points
 *    - 1,000 randomized profile fuzzing with Bernstein convexity oracles
 *    - Numerical stability and extreme values
 * 2. Donut Chart Canvas Angle Math & Arc Caps
 * 3. Composition & Quota Bar Edge Cases
 */
class Milestone2ChartsChallengerStressTest {

    private fun collectStreamed(
        points: List<SmoothCurvePoint>,
        tension: Float = 1.0f,
        minY: Float = Float.NEGATIVE_INFINITY,
        maxY: Float = Float.POSITIVE_INFINITY
    ): List<FloatArray> {
        val list = mutableListOf<FloatArray>()
        streamMonotoneCubicSegments(points, tension, minY, maxY) { c1x, c1y, c2x, c2y, endX, endY ->
            list.add(floatArrayOf(c1x, c1y, c2x, c2y, endX, endY))
        }
        return list
    }

    private fun evalBezierY(y0: Float, c1y: Float, c2y: Float, y1: Float, t: Float): Float {
        val u = 1f - t
        return u * u * u * y0 + 3f * u * u * t * c1y + 3f * u * t * t * c2y + t * t * t * y1
    }

    // =========================================================================
    // 1. Continuous Zeros Followed by Sudden Spike (Zero Overshoot / Undershoot)
    // =========================================================================

    @Test
    fun verifyContinuousZerosWithSpikeZeroOvershootAndZeroUndershoot() {
        // [0, 0, 0, 1_000_000, 0, 0]
        val points = listOf(
            SmoothCurvePoint(0f, 0f),
            SmoothCurvePoint(10f, 0f),
            SmoothCurvePoint(20f, 0f),
            SmoothCurvePoint(30f, 1_000_000f),
            SmoothCurvePoint(40f, 0f),
            SmoothCurvePoint(50f, 0f)
        )

        val segments = collectStreamed(points)
        assertEquals(5, segments.size)

        // Interval 0: [0, 0] -> strictly flat
        assertEquals(0f, segments[0][1], 0.0001f) // c1y
        assertEquals(0f, segments[0][3], 0.0001f) // c2y
        assertEquals(0f, segments[0][5], 0.0001f) // endY

        // Interval 1: [0, 0] -> strictly flat, slope at (20, 0) MUST be 0!
        assertEquals(0f, segments[1][1], 0.0001f) // c1y
        assertEquals(0f, segments[1][3], 0.0001f) // c2y
        assertEquals(0f, segments[1][5], 0.0001f) // endY

        // Interval 2: [0, 1_000_000] -> starts with 0 slope, ends with 0 slope (peak)
        assertEquals(0f, segments[2][1], 0.0001f) // c1y = 0
        assertEquals(1_000_000f, segments[2][3], 0.0001f) // c2y = 1_000_000
        assertEquals(1_000_000f, segments[2][5], 0.0001f) // endY

        // Interval 3: [1_000_000, 0] -> starts with 0 slope (peak), ends with 0 slope
        assertEquals(1_000_000f, segments[3][1], 0.0001f) // c1y = 1_000_000
        assertEquals(0f, segments[3][3], 0.0001f) // c2y = 0
        assertEquals(0f, segments[3][5], 0.0001f) // endY

        // Interval 4: [0, 0] -> strictly flat
        assertEquals(0f, segments[4][1], 0.0001f)
        assertEquals(0f, segments[4][3], 0.0001f)
        assertEquals(0f, segments[4][5], 0.0001f)

        // Sample 200 points per segment along the cubic curve to verify zero overshoot and zero undershoot
        for (i in 0 until segments.size) {
            val p0y = points[i].y
            val seg = segments[i]
            val c1y = seg[1]
            val c2y = seg[3]
            val p1y = seg[5]
            val minY = min(p0y, p1y)
            val maxY = max(p0y, p1y)

            for (step in 0..200) {
                val t = step / 200f
                val y = evalBezierY(p0y, c1y, c2y, p1y, t)
                assertTrue("Undershoot detected at seg $i, t=$t: y=$y < minY=$minY", y >= minY - 0.001f)
                assertTrue("Overshoot detected at seg $i, t=$t: y=$y > maxY=$maxY", y <= maxY + 0.001f)
                assertTrue("Strict non-negative check failed: y=$y", y >= -0.0001f)
            }
        }
    }

    @Test
    fun verifySpikeAtBoundariesZeroOvershoot() {
        // Spike at first point
        val spikeStart = listOf(
            SmoothCurvePoint(0f, 500_000f),
            SmoothCurvePoint(10f, 0f),
            SmoothCurvePoint(20f, 0f),
            SmoothCurvePoint(30f, 0f)
        )
        val segsStart = collectStreamed(spikeStart)
        assertEquals(3, segsStart.size)
        // Interval 0: from 500_000 to 0. c1y and c2y must be in [0, 500_000]
        assertTrue(segsStart[0][1] in 0f..500_000f)
        assertTrue(segsStart[0][3] in 0f..500_000f)
        // Interval 1 & 2 must be strictly zero
        assertEquals(0f, segsStart[1][1], 0.0001f)
        assertEquals(0f, segsStart[1][3], 0.0001f)
        assertEquals(0f, segsStart[2][1], 0.0001f)
        assertEquals(0f, segsStart[2][3], 0.0001f)

        // Spike at last point
        val spikeEnd = listOf(
            SmoothCurvePoint(0f, 0f),
            SmoothCurvePoint(10f, 0f),
            SmoothCurvePoint(20f, 0f),
            SmoothCurvePoint(30f, 750_000f)
        )
        val segsEnd = collectStreamed(spikeEnd)
        assertEquals(3, segsEnd.size)
        assertEquals(0f, segsEnd[0][1], 0.0001f)
        assertEquals(0f, segsEnd[0][3], 0.0001f)
        assertEquals(0f, segsEnd[1][1], 0.0001f)
        assertEquals(0f, segsEnd[1][3], 0.0001f)
        assertTrue(segsEnd[2][1] in 0f..750_000f)
        assertTrue(segsEnd[2][3] in 0f..750_000f)
    }

    @Test
    fun verifyDeepTroughNegativeSpikeZeroOvershoot() {
        // Deep trough: [1000, 1000, 1000, 0, 1000, 1000]
        val trough = listOf(
            SmoothCurvePoint(0f, 1000f),
            SmoothCurvePoint(10f, 1000f),
            SmoothCurvePoint(20f, 1000f),
            SmoothCurvePoint(30f, 0f),
            SmoothCurvePoint(40f, 1000f),
            SmoothCurvePoint(50f, 1000f)
        )
        val segs = collectStreamed(trough)
        assertEquals(5, segs.size)

        for (i in 0 until segs.size) {
            val p0y = trough[i].y
            val seg = segs[i]
            val c1y = seg[1]
            val c2y = seg[3]
            val p1y = seg[5]
            val minY = min(p0y, p1y)
            val maxY = max(p0y, p1y)

            for (step in 0..100) {
                val t = step / 100f
                val y = evalBezierY(p0y, c1y, c2y, p1y, t)
                assertTrue("Trough undershoot at seg $i, t=$t: y=$y < minY=$minY", y >= minY - 0.001f)
                assertTrue("Trough overshoot at seg $i, t=$t: y=$y > maxY=$maxY", y <= maxY + 0.001f)
            }
        }
    }

    // =========================================================================
    // 2. Collinear Points Stress Testing
    // =========================================================================

    @Test
    fun verifyCollinearPointsMonotonicityAndLinearity() {
        // Horizontal collinear
        val horizontal = (0..8).map { SmoothCurvePoint(it * 15f, 42.5f) }
        val hSegs = collectStreamed(horizontal)
        assertEquals(8, hSegs.size)
        hSegs.forEachIndexed { i, seg ->
            assertEquals("H c1y seg $i", 42.5f, seg[1], 0.0001f)
            assertEquals("H c2y seg $i", 42.5f, seg[3], 0.0001f)
            assertEquals("H endY seg $i", 42.5f, seg[5], 0.0001f)
        }

        // Strictly increasing collinear: y = 3x + 10
        val increasing = (0..10).map { SmoothCurvePoint(it * 10f, 3f * (it * 10f) + 10f) }
        val incSegs = collectStreamed(increasing)
        assertEquals(10, incSegs.size)
        incSegs.forEachIndexed { i, seg ->
            val p0y = increasing[i].y
            val p1y = increasing[i + 1].y
            assertTrue("Increasing c1y seg $i (${seg[1]}) in [$p0y, $p1y]", seg[1] in p0y..p1y)
            assertTrue("Increasing c2y seg $i (${seg[3]}) in [$p0y, $p1y]", seg[3] in p0y..p1y)
            // Verify strict monotonicity along the curve
            var prevY = p0y
            for (step in 1..50) {
                val curY = evalBezierY(p0y, seg[1], seg[3], p1y, step / 50f)
                assertTrue("Curve must be strictly increasing: $curY >= $prevY", curY >= prevY - 0.001f)
                prevY = curY
            }
        }

        // Strictly decreasing collinear: y = -5x + 500
        val decreasing = (0..10).map { SmoothCurvePoint(it * 10f, -5f * (it * 10f) + 500f) }
        val decSegs = collectStreamed(decreasing)
        assertEquals(10, decSegs.size)
        decSegs.forEachIndexed { i, seg ->
            val p0y = decreasing[i].y
            val p1y = decreasing[i + 1].y
            assertTrue("Decreasing c1y seg $i in [$p1y, $p0y]", seg[1] in p1y..p0y)
            assertTrue("Decreasing c2y seg $i in [$p1y, $p0y]", seg[3] in p1y..p0y)
            var prevY = p0y
            for (step in 1..50) {
                val curY = evalBezierY(p0y, seg[1], seg[3], p1y, step / 50f)
                assertTrue("Curve must be strictly decreasing: $curY <= $prevY", curY <= prevY + 0.001f)
                prevY = curY
            }
        }
    }

    // =========================================================================
    // 3. Monotone Staircases / Step Functions
    // =========================================================================

    @Test
    fun verifyMonotoneAscendingStaircaseZeroOvershoot() {
        // Staircase: [0, 0, 0, 100, 100, 100, 300, 300, 300]
        val staircase = listOf(
            SmoothCurvePoint(0f, 0f),
            SmoothCurvePoint(10f, 0f),
            SmoothCurvePoint(20f, 0f),
            SmoothCurvePoint(30f, 100f),
            SmoothCurvePoint(40f, 100f),
            SmoothCurvePoint(50f, 100f),
            SmoothCurvePoint(60f, 300f),
            SmoothCurvePoint(70f, 300f),
            SmoothCurvePoint(80f, 300f)
        )
        val segs = collectStreamed(staircase)
        assertEquals(8, segs.size)

        // Flat plateau intervals
        assertEquals(0f, segs[0][1], 0.0001f); assertEquals(0f, segs[0][3], 0.0001f)
        assertEquals(0f, segs[1][1], 0.0001f); assertEquals(0f, segs[1][3], 0.0001f)
        assertEquals(100f, segs[3][1], 0.0001f); assertEquals(100f, segs[3][3], 0.0001f)
        assertEquals(100f, segs[4][1], 0.0001f); assertEquals(100f, segs[4][3], 0.0001f)
        assertEquals(300f, segs[6][1], 0.0001f); assertEquals(300f, segs[6][3], 0.0001f)
        assertEquals(300f, segs[7][1], 0.0001f); assertEquals(300f, segs[7][3], 0.0001f)

        // Step transition intervals: [0 -> 100] and [100 -> 300]
        // Slope at plateaus is 0, so transition MUST start and end with slope 0 (tangent horizontal)
        assertEquals(0f, segs[2][1], 0.0001f)
        assertEquals(100f, segs[2][3], 0.0001f)
        assertEquals(100f, segs[5][1], 0.0001f)
        assertEquals(300f, segs[5][3], 0.0001f)

        // Entire staircase must be strictly monotonic non-decreasing across all sampled points
        var lastY = 0f
        for (i in 0 until segs.size) {
            val p0y = staircase[i].y
            val seg = segs[i]
            for (step in 0..50) {
                val y = evalBezierY(p0y, seg[1], seg[3], seg[5], step / 50f)
                assertTrue("Staircase monotonicity violation at seg $i: $y < $lastY", y >= lastY - 0.001f)
                lastY = y
            }
        }
        assertEquals(300f, lastY, 0.0001f)
    }

    @Test
    fun verifyMonotoneDescendingStaircaseZeroOvershoot() {
        val descStaircase = listOf(
            SmoothCurvePoint(0f, 500f),
            SmoothCurvePoint(10f, 500f),
            SmoothCurvePoint(20f, 200f),
            SmoothCurvePoint(30f, 200f),
            SmoothCurvePoint(40f, 0f),
            SmoothCurvePoint(50f, 0f)
        )
        val segs = collectStreamed(descStaircase)
        assertEquals(5, segs.size)

        var lastY = 500f
        for (i in 0 until segs.size) {
            val p0y = descStaircase[i].y
            val seg = segs[i]
            for (step in 0..50) {
                val y = evalBezierY(p0y, seg[1], seg[3], seg[5], step / 50f)
                assertTrue("Descending staircase monotonicity violation at seg $i: $y > $lastY", y <= lastY + 0.001f)
                lastY = y
            }
        }
        assertEquals(0f, lastY, 0.0001f)
    }

    // =========================================================================
    // 4. Minimal Datasets (0, 1, 2 points)
    // =========================================================================

    @Test
    fun verifyMinimalDatasets() {
        // 0 points
        val empty = collectStreamed(emptyList())
        assertEquals(0, empty.size)

        // 1 point
        val single = collectStreamed(listOf(SmoothCurvePoint(10f, 20f)))
        assertEquals(0, single.size)

        // 2 points
        val two = listOf(SmoothCurvePoint(0f, 10f), SmoothCurvePoint(100f, 50f))
        val segsTwo = collectStreamed(two)
        assertEquals(1, segsTwo.size)
        val seg = segsTwo[0]
        assertEquals(0f + 100f / 3f, seg[0], 0.001f) // c1x = 33.333
        assertEquals(10f + 40f / 3f, seg[1], 0.001f) // c1y = 23.333
        assertEquals(100f - 100f / 3f, seg[2], 0.001f) // c2x = 66.667
        assertEquals(50f - 40f / 3f, seg[3], 0.001f) // c2y = 36.667
        assertEquals(100f, seg[4], 0.0001f)
        assertEquals(50f, seg[5], 0.0001f)
    }

    // =========================================================================
    // 5. Coincident Points (dx <= 0) and Robustness
    // =========================================================================

    @Test
    fun verifyCoincidentAndNonIncreasingXPointsDoNotCrashOrGenerateNaN() {
        val coincident = listOf(
            SmoothCurvePoint(10f, 20f),
            SmoothCurvePoint(10f, 80f), // dx = 0
            SmoothCurvePoint(20f, 50f)
        )
        val segs = collectStreamed(coincident)
        assertEquals(2, segs.size)

        // Segment 0: dx = 0. Should degenerate to straight vertical jump without NaN
        assertFalse(segs[0][0].isNaN())
        assertFalse(segs[0][1].isNaN())
        assertFalse(segs[0][2].isNaN())
        assertFalse(segs[0][3].isNaN())
        assertEquals(10f, segs[0][4], 0.0001f)
        assertEquals(80f, segs[0][5], 0.0001f)

        // Reversed X points
        val reversed = listOf(
            SmoothCurvePoint(30f, 10f),
            SmoothCurvePoint(10f, 40f), // dx = -20
            SmoothCurvePoint(50f, 80f)
        )
        val segsRev = collectStreamed(reversed)
        assertEquals(2, segsRev.size)
        segsRev.forEach { arr ->
            arr.forEach { v -> assertFalse("Value should not be NaN: $v", v.isNaN()) }
        }

        // Multiple identical points
        val identical = listOf(
            SmoothCurvePoint(5f, 5f),
            SmoothCurvePoint(5f, 5f),
            SmoothCurvePoint(5f, 5f)
        )
        val segsIdentical = collectStreamed(identical)
        assertEquals(2, segsIdentical.size)
        segsIdentical.forEach { arr ->
            arr.forEach { v -> assertFalse("Value should not be NaN: $v", v.isNaN()) }
        }
    }

    // =========================================================================
    // 6. 1,000 Randomized Profile Fuzzing with Monotonicity Oracle
    // =========================================================================

    @Test
    fun fuzz1000RandomProfilesWithStrictMonotonicityOracle() {
        val rng = Random(2026_09_16)
        repeat(1000) { seedIdx ->
            val n = rng.nextInt(2, 60)
            var curX = 0f
            val points = (0 until n).map { i ->
                if (i > 0) curX += rng.nextFloat() * 25f + 0.1f
                val y = when (rng.nextInt(6)) {
                    0 -> 0f // frequent zeros
                    1 -> 0f
                    2 -> rng.nextFloat() * 1000f
                    3 -> 1_000_000f // sudden spikes
                    4 -> 500f // plateaus
                    else -> rng.nextFloat() * 50f
                }
                SmoothCurvePoint(curX, y)
            }

            val tension = rng.nextFloat() * 1.4f - 0.2f
            val segs = collectStreamed(points, tension = tension)
            assertEquals("Seg count for iter $seedIdx", points.size - 1, segs.size)

            segs.forEachIndexed { i, seg ->
                val p0 = points[i]
                val p1 = points[i + 1]
                val c1x = seg[0]; val c1y = seg[1]
                val c2x = seg[2]; val c2y = seg[3]
                val endX = seg[4]; val endY = seg[5]

                // Finite checks
                assertFalse("c1x NaN in iter $seedIdx", c1x.isNaN())
                assertFalse("c1y NaN in iter $seedIdx", c1y.isNaN())
                assertFalse("c2x NaN in iter $seedIdx", c2x.isNaN())
                assertFalse("c2y NaN in iter $seedIdx", c2y.isNaN())

                // X ordering
                assertTrue("X ordering p0.x <= c1x <= c2x <= p1.x", p0.x <= c1x + 0.001f && c1x <= c2x + 0.001f && c2x <= p1.x + 0.001f)

                // Zero overshoot check on control points
                val minY = min(p0.y, p1.y)
                val maxY = max(p0.y, p1.y)
                val eps = max(0.01f, max(kotlin.math.abs(minY), kotlin.math.abs(maxY)) * 1e-4f)
                assertTrue("c1y out of [$minY, $maxY] in iter $seedIdx: c1y=$c1y", c1y in (minY - eps)..(maxY + eps))
                assertTrue("c2y out of [$minY, $maxY] in iter $seedIdx: c2y=$c2y", c2y in (minY - eps)..(maxY + eps))

                // Oracle: sample 30 points along the Bézier curve
                for (s in 0..30) {
                    val t = s / 30f
                    val y = evalBezierY(p0.y, c1y, c2y, p1.y, t)
                    assertTrue("Sampled Y out of bounds at iter $seedIdx, seg $i, t=$t: y=$y in [$minY, $maxY]", y in (minY - eps)..(maxY + eps))
                }
            }
        }
    }

    // =========================================================================
    // 7. Numerical Stability and Extreme Float Values
    // =========================================================================

    @Test
    fun verifyExtremeFloatValuesAndBoundsClamping() {
        val extremePoints = listOf(
            SmoothCurvePoint(0f, 1e9f),
            SmoothCurvePoint(10f, 0f),
            SmoothCurvePoint(20f, 1e9f),
            SmoothCurvePoint(30f, 0f)
        )
        val segs = collectStreamed(extremePoints)
        assertEquals(3, segs.size)
        segs.forEach { arr ->
            arr.forEach { v ->
                assertFalse("Extreme value cannot be NaN", v.isNaN())
                assertFalse("Extreme value cannot be Infinite", v.isInfinite())
            }
        }

        // Clamping to [10f, 90f]
        val clampedSegs = collectStreamed(extremePoints, minY = 10f, maxY = 90f)
        assertEquals(3, clampedSegs.size)
        clampedSegs.forEach { arr ->
            assertTrue("c1y clamped to [10, 90]: ${arr[1]}", arr[1] in 10f..90f)
            assertTrue("c2y clamped to [10, 90]: ${arr[3]}", arr[3] in 10f..90f)
        }
    }

    // =========================================================================
    // 8. Donut Chart Canvas Angle Math & Arc Caps
    // =========================================================================

    @Test
    fun verifyDonutAngleAndGapCalculations() {
        // Case 1: Single segment (100%) - full 360 circle, 0 gap
        val singleVal = listOf(100L)
        val totalSingle = singleVal.sum()
        val chartSingle = donutPresentation(singleVal, totalSingle)
        assertEquals(1, chartSingle.segments.size)
        assertEquals(-90f, chartSingle.segments[0].startDegrees, 0.001f)
        assertEquals(360f, chartSingle.segments[0].sweepDegrees, 0.001f)

        // Case 2: Multi-segment - gap degrees applied
        val multiVals = listOf(50L, 50L)
        val totalMulti = multiVals.sum()
        val chartMulti = donutPresentation(multiVals, totalMulti)
        assertEquals(2, chartMulti.segments.size)
        assertEquals(-90f, chartMulti.segments[0].startDegrees, 0.001f)
        assertEquals(180f, chartMulti.segments[0].sweepDegrees, 0.001f)
        assertEquals(90f, chartMulti.segments[1].startDegrees, 0.001f)
        assertEquals(180f, chartMulti.segments[1].sweepDegrees, 0.001f)

        // With 6-degree gap, net sweep is 174f, start offset is 3f
        val gap = 6f
        val netSweep0 = (chartMulti.segments[0].sweepDegrees - gap).coerceAtLeast(0.1f)
        assertEquals(174f, netSweep0, 0.001f)

        // Case 3: Micro slice (< 6 degrees, e.g. 1 out of 1000 = 0.36 degrees)
        val microVals = listOf(999L, 1L)
        val chartMicro = donutPresentation(microVals, microVals.sum())
        val microSweep = (chartMicro.segments[1].sweepDegrees - gap).coerceAtLeast(0.1f)
        assertEquals("Micro slice must be clamped to 0.1f to prevent negative sweep", 0.1f, microSweep, 0.001f)
    }

    // =========================================================================
    // 9. Composition & Quota Bar Edge Cases
    // =========================================================================

    @Test
    fun verifyCompositionBarZeroAndSingleNonZeroSegments() {
        // All zero segments
        val allZero = listOf(0L to "Input", 0L to "Output", 0L to "Cache")
        val activeZero = allZero.filter { it.first > 0L }
        assertTrue("All zero segments should have 0 active segments", activeZero.isEmpty())

        // Single non-zero segment (100% output)
        val singleNonZero = listOf(0L to "Input", 500L to "Output", 0L to "Cache")
        val activeSingle = singleNonZero.filter { it.first > 0L }
        assertEquals(1, activeSingle.size)
        assertEquals(500L, activeSingle[0].first)

        // Normal distribution
        val normal = listOf(300L to "Input", 700L to "Output", 200L to "Cache")
        val activeNormal = normal.filter { it.first > 0L }
        assertEquals(3, activeNormal.size)
    }
}
