package com.jeidorf.tokenledger.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.random.Random

class Milestone1ChallengerStressTest {

    // =========================================================================
    // Challenge 1: streamSmoothCurveSegments vs smoothCurveSegments Equivalence
    // =========================================================================

    private fun collectStreamed(
        points: List<SmoothCurvePoint>,
        tension: Float = 0.9f,
        minY: Float = Float.NEGATIVE_INFINITY,
        maxY: Float = Float.POSITIVE_INFINITY
    ): List<FloatArray> {
        val result = mutableListOf<FloatArray>()
        streamSmoothCurveSegments(points, tension, minY, maxY) { c1x, c1y, c2x, c2y, endX, endY ->
            result.add(floatArrayOf(c1x, c1y, c2x, c2y, endX, endY))
        }
        return result
    }

    private fun assertSegmentsMatchStream(
        points: List<SmoothCurvePoint>,
        tension: Float = 0.9f,
        minY: Float = Float.NEGATIVE_INFINITY,
        maxY: Float = Float.POSITIVE_INFINITY,
        scenario: String = ""
    ) {
        val expected = smoothCurveSegments(points, tension, minY, maxY)
        val streamed = collectStreamed(points, tension, minY, maxY)

        assertEquals("[$scenario] Segment count mismatch", expected.size, streamed.size)
        expected.forEachIndexed { i, seg ->
            val arr = streamed[i]
            assertEquals("[$scenario seg $i] c1x mismatch", seg.control1.x, arr[0], 0.0001f)
            assertEquals("[$scenario seg $i] c1y mismatch", seg.control1.y, arr[1], 0.0001f)
            assertEquals("[$scenario seg $i] c2x mismatch", seg.control2.x, arr[2], 0.0001f)
            assertEquals("[$scenario seg $i] c2y mismatch", seg.control2.y, arr[3], 0.0001f)
            assertEquals("[$scenario seg $i] endX mismatch", seg.end.x, arr[4], 0.0001f)
            assertEquals("[$scenario seg $i] endY mismatch", seg.end.y, arr[5], 0.0001f)
        }
    }

    @Test
    fun verifyCurveStreamingEmptyAndSinglePointEdgeCases() {
        // Empty
        assertSegmentsMatchStream(emptyList(), scenario = "empty")
        assertEquals(0, collectStreamed(emptyList()).size)
        assertEquals(0, smoothCurveSegments(emptyList()).size)

        // Single point
        val single = listOf(SmoothCurvePoint(42f, 84f))
        assertSegmentsMatchStream(single, scenario = "single-point")
        assertEquals(0, collectStreamed(single).size)
        assertEquals(0, smoothCurveSegments(single).size)
    }

    @Test
    fun verifyCurveStreamingTwoPoints() {
        val twoPoints = listOf(
            SmoothCurvePoint(0f, 10f),
            SmoothCurvePoint(100f, 90f)
        )
        assertSegmentsMatchStream(twoPoints, scenario = "two-points")
    }

    @Test
    fun verifyCurveStreamingCollinearPoints() {
        // Horizontal collinear
        val horizontal = (0..10).map { SmoothCurvePoint(it * 10f, 50f) }
        assertSegmentsMatchStream(horizontal, scenario = "collinear-horizontal")
        val hStream = collectStreamed(horizontal)
        hStream.forEachIndexed { idx, arr ->
            assertEquals("Horizontal c1y at $idx", 50f, arr[1], 0.0001f)
            assertEquals("Horizontal c2y at $idx", 50f, arr[3], 0.0001f)
            assertEquals("Horizontal endY at $idx", 50f, arr[5], 0.0001f)
        }

        // Diagonal collinear
        val diagonal = (0..10).map { SmoothCurvePoint(it * 10f, it * 10f) }
        assertSegmentsMatchStream(diagonal, scenario = "collinear-diagonal")

        // Vertical collinear (same X)
        val vertical = (0..10).map { SmoothCurvePoint(10f, it * 20f) }
        assertSegmentsMatchStream(vertical, scenario = "collinear-vertical")
    }

    @Test
    fun verifyCurveStreamingExtremeSpikesAndBoundsClamping() {
        val spikes = listOf(
            SmoothCurvePoint(0f, 50f),
            SmoothCurvePoint(10f, 100_000f),
            SmoothCurvePoint(20f, -100_000f),
            SmoothCurvePoint(30f, 50f),
            SmoothCurvePoint(40f, 100_000f),
            SmoothCurvePoint(50f, 0f)
        )

        // Clamped to [0f, 100f]
        assertSegmentsMatchStream(spikes, minY = 0f, maxY = 100f, scenario = "spikes-clamped")
        val clampedStream = collectStreamed(spikes, minY = 0f, maxY = 100f)
        clampedStream.forEachIndexed { idx, arr ->
            assertTrue("c1y out of clamped bounds at $idx: ${arr[1]}", arr[1] in 0f..100f)
            assertTrue("c2y out of clamped bounds at $idx: ${arr[3]}", arr[3] in 0f..100f)
        }

        // Unclamped
        assertSegmentsMatchStream(spikes, scenario = "spikes-unclamped")
    }

    @Test
    fun verifyCurveStreamingTensionVariations() {
        val points = listOf(
            SmoothCurvePoint(0f, 10f),
            SmoothCurvePoint(20f, 80f),
            SmoothCurvePoint(40f, 30f),
            SmoothCurvePoint(60f, 120f)
        )

        listOf(0.0f, 0.25f, 0.5f, 0.9f, 1.0f, -0.5f, 1.5f).forEach { tension ->
            assertSegmentsMatchStream(points, tension = tension, scenario = "tension-$tension")
        }
    }

    @Test
    fun verifyCurveStreamingFuzzingRandomDatasets() {
        val rng = Random(42)
        repeat(500) { iter ->
            val pointCount = rng.nextInt(2, 50)
            var currentX = 0f
            val points = (0 until pointCount).map {
                currentX += rng.nextFloat() * 20f
                SmoothCurvePoint(currentX, rng.nextFloat() * 1000f - 500f)
            }
            val tension = rng.nextFloat() * 1.5f - 0.25f
            val minY = rng.nextFloat() * -200f
            val maxY = rng.nextFloat() * 200f + 200f

            assertSegmentsMatchStream(points, tension, minY, maxY, scenario = "fuzz-$iter")
        }
    }

    @Test
    fun verifyCurveStreamingLargeDatasetPerformance() {
        val count = 5_000
        val points = (0 until count).map { SmoothCurvePoint(it.toFloat(), (it % 100).toFloat()) }
        var streamedSegments = 0
        streamSmoothCurveSegments(points) { _, _, _, _, _, _ ->
            streamedSegments++
        }
        assertEquals(count - 1, streamedSegments)
    }

    // =========================================================================
    // Challenge 2: Multi-Threaded formatInteger Stress Testing
    // =========================================================================

    @Test
    fun stressTestFormatIntegerHighConcurrency() {
        val threadCount = 32
        val iterationsPerThread = 10_000
        val executor = Executors.newFixedThreadPool(threadCount)

        val boundaryValues = listOf(
            Long.MIN_VALUE,
            Long.MIN_VALUE + 1,
            -1_000_000_000_000L,
            -1_000_000L,
            -1_000L,
            -999L,
            -1L,
            0L,
            1L,
            999L,
            1_000L,
            1_000_000L,
            1_000_000_000L,
            1_000_000_000_000L,
            Long.MAX_VALUE - 1,
            Long.MAX_VALUE
        )

        val tasks = (0 until threadCount).map { threadId ->
            Callable<Pair<Int, String?>> {
                val threadRng = Random(threadId * 1000L)
                val oracle = NumberFormat.getIntegerInstance(Locale.US)

                for (i in 0 until iterationsPerThread) {
                    val valueToTest = if (i < boundaryValues.size) {
                        boundaryValues[i]
                    } else {
                        threadRng.nextLong()
                    }

                    val actual = formatInteger(valueToTest)
                    val expected = oracle.format(valueToTest)

                    if (actual != expected) {
                        return@Callable threadId to "Mismatch on val $valueToTest: expected '$expected' but got '$actual'"
                    }
                }
                threadId to null
            }
        }

        val futures = executor.invokeAll(tasks)
        executor.shutdown()
        assertTrue("Executor should terminate within 30 seconds", executor.awaitTermination(30, TimeUnit.SECONDS))

        futures.forEach { future ->
            val (threadId, error) = future.get()
            assertNull("Thread $threadId failed: $error", error)
        }
    }

    // =========================================================================
    // Challenge 3: shortTime and dayProgressFraction Boundary & Invalid Cases
    // =========================================================================

    @Test
    fun verifyShortTimeAndDayProgressNullAndBlank() {
        assertEquals("当前进度", shortTime(null))
        assertEquals("当前进度", shortTime(""))
        assertEquals("当前进度", shortTime("   "))
        assertEquals("当前进度", shortTime("\t\n"))

        assertNull(dayProgressFraction(null))
        assertNull(dayProgressFraction(""))
        assertNull(dayProgressFraction("   "))
        assertNull(dayProgressFraction("\t\n"))
    }

    @Test
    fun verifyShortTimeAndDayProgressValidIsoTimestamps() {
        // Midnight
        assertEquals("00:00", shortTime("2026-09-04T00:00:00Z"))
        assertEquals(0.0f, dayProgressFraction("2026-09-04T00:00:00Z") ?: -1f, 0.0001f)

        // Noon
        assertEquals("12:00", shortTime("2026-09-04T12:00:00Z"))
        assertEquals(0.5f, dayProgressFraction("2026-09-04T12:00:00Z") ?: -1f, 0.0001f)

        // 6:00 AM (quarter day)
        assertEquals("06:00", shortTime("2026-09-04T06:00:00Z"))
        assertEquals(0.25f, dayProgressFraction("2026-09-04T06:00:00Z") ?: -1f, 0.0001f)

        // 18:00 PM (three quarter day)
        assertEquals("18:00", shortTime("2026-09-04T18:00:00Z"))
        assertEquals(0.75f, dayProgressFraction("2026-09-04T18:00:00Z") ?: -1f, 0.0001f)

        // End of day: 24:00
        assertEquals("24:00", shortTime("2026-09-04T24:00:00Z"))
        assertEquals(1.0f, dayProgressFraction("2026-09-04T24:00:00Z") ?: -1f, 0.0001f)

        // 23:59:59
        assertEquals("23:59", shortTime("2026-09-04T23:59:59Z"))
        val expectedFraction = (23 * 60 + 59) / 1440f
        assertEquals(expectedFraction, dayProgressFraction("2026-09-04T23:59:59Z") ?: -1f, 0.0001f)

        // Space separated
        assertEquals("14:22", shortTime("2026-09-04 14:22:15"))
        assertEquals((14 * 60 + 22) / 1440f, dayProgressFraction("2026-09-04 14:22:15") ?: -1f, 0.0001f)

        // Subsecond / Milliseconds
        assertEquals("15:30", shortTime("2026-09-04T15:30:45.123Z"))
        assertEquals((15 * 60 + 30) / 1440f, dayProgressFraction("2026-09-04T15:30:45.123Z") ?: -1f, 0.0001f)

        // Timezone offsets
        assertEquals("16:45", shortTime("2026-09-04T16:45:00+08:00"))
        assertEquals((16 * 60 + 45) / 1440f, dayProgressFraction("2026-09-04T16:45:00+08:00") ?: -1f, 0.0001f)
        assertEquals("08:15", shortTime("2026-09-04T08:15:00-05:00"))
        assertEquals((8 * 60 + 15) / 1440f, dayProgressFraction("2026-09-04T08:15:00-05:00") ?: -1f, 0.0001f)

        // Timestamps without seconds
        assertEquals("11:20", shortTime("2026-09-04T11:20Z"))
        assertEquals((11 * 60 + 20) / 1440f, dayProgressFraction("2026-09-04T11:20Z") ?: -1f, 0.0001f)

        // Single digit hours
        assertEquals("9:05", shortTime("2026-09-04T9:05:00Z"))
        assertEquals((9 * 60 + 5) / 1440f, dayProgressFraction("2026-09-04T9:05:00Z") ?: -1f, 0.0001f)
    }

    @Test
    fun verifyShortTimeAndDayProgressMalformedAndOutOfRange() {
        // 24:01 is invalid (only 24:00 is permitted as end of day)
        assertEquals("24:01", shortTime("2026-09-04T24:01:00Z"))
        assertNull("24:01 must yield null dayProgressFraction", dayProgressFraction("2026-09-04T24:01:00Z"))

        // Hour 25 is out of bounds
        assertEquals("25:00", shortTime("2026-09-04T25:00:00Z"))
        assertNull("Hour 25 must yield null dayProgressFraction", dayProgressFraction("2026-09-04T25:00:00Z"))

        // Minute 60 is out of bounds
        assertEquals("12:60", shortTime("2026-09-04T12:60:00Z"))
        assertNull("Minute 60 must yield null dayProgressFraction", dayProgressFraction("2026-09-04T12:60:00Z"))

        // Pure dates without time
        assertEquals("当前进度", shortTime("2026-09-04"))
        assertNull(dayProgressFraction("2026-09-04"))

        // Arbitrary non-timestamp strings
        assertEquals("当前进度", shortTime("invalid-timestamp"))
        assertNull(dayProgressFraction("invalid-timestamp"))

        assertEquals("当前进度", shortTime("hello world"))
        assertNull(dayProgressFraction("hello world"))

        assertEquals("当前进度", shortTime("T::"))
        assertNull(dayProgressFraction("T::"))

        assertEquals("当前进度", shortTime("T12:"))
        assertNull(dayProgressFraction("T12:"))

        assertEquals("当前进度", shortTime(":30"))
        assertNull(dayProgressFraction(":30"))

        assertEquals("当前进度", shortTime("T-1:00"))
        assertNull(dayProgressFraction("T-1:00"))
    }
}
