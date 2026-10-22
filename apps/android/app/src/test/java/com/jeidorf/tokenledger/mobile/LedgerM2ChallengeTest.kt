package com.jeidorf.tokenledger.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

/**
 * Milestone 2 Coordinate Math & Boundary Adversarial Challenge Tests.
 * Stress-tests donutSliceAtOffset, heatmapCellAtPosition, shouldAnchorTooltipToRight,
 * and formatTrendAnchorLabel against edge cases, boundary conditions, and invalid inputs.
 */
class LedgerM2ChallengeTest {

    // =========================================================================
    // 1. donutSliceAtOffset Adversarial Stress Tests
    // =========================================================================

    @Test
    fun donutSliceAtOffset_negativeTouchCoordinates_returnsNull() {
        val sizePx = 200f // center at (100, 100), outerRadius = 100, max slop = 120
        val values = listOf(50L, 50L)

        // Substantial negative coordinates (outside outer radius slop)
        assertNull(donutSliceAtOffset(touchX = -50f, touchY = -50f, sizePx = sizePx, values = values))
        assertNull(donutSliceAtOffset(touchX = -100f, touchY = 100f, sizePx = sizePx, values = values))
        assertNull(donutSliceAtOffset(touchX = 100f, touchY = -50f, sizePx = sizePx, values = values))
        assertNull(donutSliceAtOffset(touchX = -1000f, touchY = -1000f, sizePx = sizePx, values = values))
        assertNull(donutSliceAtOffset(touchX = -0.001f, touchY = -0.001f, sizePx = sizePx, values = values))
    }

    @Test
    fun donutSliceAtOffset_exactCenterHoleTouch_returnsNull() {
        val sizePx = 200f // outerRadius = 100, inner hole threshold = 20f
        val values = listOf(30L, 70L)

        // Exact center (0 distance from center)
        assertNull(donutSliceAtOffset(touchX = 100f, touchY = 100f, sizePx = sizePx, values = values))

        // Within center hole threshold (dist < outerRadius * 0.2f = 20f)
        assertNull(donutSliceAtOffset(touchX = 110f, touchY = 100f, sizePx = sizePx, values = values)) // dist = 10f
        assertNull(donutSliceAtOffset(touchX = 100f, touchY = 115f, sizePx = sizePx, values = values)) // dist = 15f
        assertNull(donutSliceAtOffset(touchX = 100f, touchY = 85f, sizePx = sizePx, values = values))  // dist = 15f
        assertNull(donutSliceAtOffset(touchX = 85f, touchY = 100f, sizePx = sizePx, values = values))  // dist = 15f
        assertNull(donutSliceAtOffset(touchX = 113.4f, touchY = 113.4f, sizePx = sizePx, values = values)) // dist ≈ 18.9f
        assertNull(donutSliceAtOffset(touchX = 119.99f, touchY = 100f, sizePx = sizePx, values = values)) // dist = 19.99f
    }

    @Test
    fun donutSliceAtOffset_outsideOuterRadius_returnsNull() {
        val sizePx = 200f // outerRadius = 100, outer slop threshold = 120f
        val values = listOf(40L, 60L)

        // Points outside the 1.2x outer radius slop limit (> 120f)
        assertNull(donutSliceAtOffset(touchX = 221f, touchY = 100f, sizePx = sizePx, values = values)) // dist = 121f
        assertNull(donutSliceAtOffset(touchX = 100f, touchY = 225f, sizePx = sizePx, values = values)) // dist = 125f
        assertNull(donutSliceAtOffset(touchX = 100f, touchY = -25f, sizePx = sizePx, values = values))  // dist = 125f
        assertNull(donutSliceAtOffset(touchX = -25f, touchY = 100f, sizePx = sizePx, values = values))  // dist = 125f
        assertNull(donutSliceAtOffset(touchX = 300f, touchY = 300f, sizePx = sizePx, values = values))
        assertNull(donutSliceAtOffset(touchX = 5000f, touchY = 5000f, sizePx = sizePx, values = values))

        // Points right within outer slop limit (100f <= dist <= 120f) should be accepted
        assertEquals(0, donutSliceAtOffset(touchX = 100f, touchY = 0f, sizePx = sizePx, values = values)) // dist = 100f (12 o'clock, slice 0)
        assertEquals(0, donutSliceAtOffset(touchX = 100f, touchY = -15f, sizePx = sizePx, values = values)) // dist = 115f <= 120f
    }

    @Test
    fun donutSliceAtOffset_zeroOrNearZeroSizePx_returnsNull() {
        val values = listOf(10L, 20L, 30L)

        // Zero and negative sizePx
        assertNull(donutSliceAtOffset(touchX = 0f, touchY = 0f, sizePx = 0f, values = values))
        assertNull(donutSliceAtOffset(touchX = 10f, touchY = 10f, sizePx = -100f, values = values))
        assertNull(donutSliceAtOffset(touchX = -5f, touchY = -5f, sizePx = -0.001f, values = values))

        // Near-zero sizePx: any realistic touch offset is vastly outside outerRadius * 1.2f
        assertNull(donutSliceAtOffset(touchX = 10f, touchY = 10f, sizePx = 0.0001f, values = values))
        assertNull(donutSliceAtOffset(touchX = 0f, touchY = 0f, sizePx = 1e-6f, values = values))
    }

    @Test
    fun donutSliceAtOffset_emptyOrSingleElementSlicesList() {
        val sizePx = 200f
        // Empty list must always return null
        assertNull(donutSliceAtOffset(touchX = 150f, touchY = 100f, sizePx = sizePx, values = emptyList()))
        assertNull(donutSliceAtOffset(touchX = 100f, touchY = 50f, sizePx = sizePx, values = emptyList()))

        // Single-element slice list (100% of pie)
        val singleSlice = listOf(5000L)
        // All valid radial touches across all 4 quadrants should return index 0
        assertEquals(0, donutSliceAtOffset(touchX = 100f, touchY = 50f, sizePx = sizePx, values = singleSlice))  // top
        assertEquals(0, donutSliceAtOffset(touchX = 150f, touchY = 100f, sizePx = sizePx, values = singleSlice)) // right
        assertEquals(0, donutSliceAtOffset(touchX = 100f, touchY = 150f, sizePx = sizePx, values = singleSlice)) // bottom
        assertEquals(0, donutSliceAtOffset(touchX = 50f, touchY = 100f, sizePx = sizePx, values = singleSlice))  // left
    }

    @Test
    fun donutSliceAtOffset_allSlicesWithZeroTokens_doesNotThrowAndReturnsValidIndex() {
        val sizePx = 200f
        // When all tokens are 0L, total sum is 0L, which is safely coerced to 1L
        val zeroSlices = listOf(0L, 0L, 0L)
        val result = donutSliceAtOffset(touchX = 150f, touchY = 100f, sizePx = sizePx, values = zeroSlices)
        assertNotNull(result)
        assertTrue("Result index must be in valid slice range", result!! in zeroSlices.indices)
        assertEquals(zeroSlices.lastIndex, result)

        val singleZero = listOf(0L)
        val singleResult = donutSliceAtOffset(touchX = 150f, touchY = 100f, sizePx = sizePx, values = singleZero)
        assertEquals(0, singleResult)
    }

    @Test
    fun donutSliceAtOffset_angleBoundaries_0_90_180_270_360() {
        val sizePx = 200f
        val centerX = 100f
        val centerY = 100f
        val r = 50f // safe radius between 20f and 120f
        // 4 slices of equal value (90 degrees each)
        // Slice 0: [0°, 90°)   -> 12 o'clock to 3 o'clock
        // Slice 1: [90°, 180°) -> 3 o'clock to 6 o'clock
        // Slice 2: [180°, 270°) -> 6 o'clock to 9 o'clock
        // Slice 3: [270°, 360°) -> 9 o'clock to 12 o'clock
        val values = listOf(25L, 25L, 25L, 25L)

        // 0° boundary (12 o'clock, dx=0, dy=-r): normalized = 0.0° -> slice 0
        assertEquals(0, donutSliceAtOffset(centerX, centerY - r, sizePx, values))

        // 90° boundary (3 o'clock, dx=r, dy=0): normalized = 90.0° -> slice 1
        assertEquals(1, donutSliceAtOffset(centerX + r, centerY, sizePx, values))

        // 180° boundary (6 o'clock, dx=0, dy=r): normalized = 180.0° -> slice 2
        assertEquals(2, donutSliceAtOffset(centerX, centerY + r, sizePx, values))

        // 270° boundary (9 o'clock, dx=-r, dy=0): normalized = 270.0° -> slice 3
        assertEquals(3, donutSliceAtOffset(centerX - r, centerY, sizePx, values))

        // Just before 360° / 0° wrap-around (e.g. 11:59:59 o'clock, dx = -0.01, dy = -r)
        assertEquals(3, donutSliceAtOffset(centerX - 0.01f, centerY - r, sizePx, values))

        // Slices with non-uniform weights: 60°, 120°, 180°
        val nonUniform = listOf(60L, 120L, 180L) // total = 360L
        // Slice 0: [0°, 60°)
        // Slice 1: [60°, 180°)
        // Slice 2: [180°, 360°)

        // At 0° (12 o'clock) -> slice 0
        assertEquals(0, donutSliceAtOffset(centerX, centerY - r, sizePx, nonUniform))
        // At 59° -> slice 0
        val rad59 = Math.toRadians(-90.0 + 59.0)
        val x59 = centerX + (r * cos(rad59)).toFloat()
        val y59 = centerY + (r * sin(rad59)).toFloat()
        assertEquals(0, donutSliceAtOffset(x59, y59, sizePx, nonUniform))

        // At 60° -> slice 1
        val rad60 = Math.toRadians(-90.0 + 60.0)
        val x60 = centerX + (r * cos(rad60)).toFloat()
        val y60 = centerY + (r * sin(rad60)).toFloat()
        assertEquals(1, donutSliceAtOffset(x60, y60, sizePx, nonUniform))

        // At 180° (6 o'clock) -> slice 2
        assertEquals(2, donutSliceAtOffset(centerX, centerY + r, sizePx, nonUniform))
    }

    @Test
    fun donutSliceAtOffset_full360DegreeSweepStressTest() {
        val sizePx = 300f
        val centerX = 150f
        val centerY = 150f
        val r = 75f
        val slices = listOf(100L, 200L, 300L) // 60°, 120°, 180°

        var lastIndex = -1
        // Sweep entire circle from 0 to 360 degrees in 0.5° steps
        for (deg in 0 until 720) {
            val sweepDeg = deg * 0.5
            // Convert normalized degree (0° at 12 o'clock) to mathematical angle (0° at 3 o'clock)
            val mathRad = Math.toRadians(-90.0 + sweepDeg)
            val touchX = centerX + (r * cos(mathRad)).toFloat()
            val touchY = centerY + (r * sin(mathRad)).toFloat()

            val slice = donutSliceAtOffset(touchX, touchY, sizePx, slices)
            assertNotNull("Slice should not be null for valid radial touch at $sweepDeg deg", slice)
            assertTrue("Slice must be in bounds [0, 2]", slice!! in 0..2)

            if (sweepDeg < 60.0) {
                assertEquals("Should be slice 0 for deg < 60", 0, slice)
            } else if (sweepDeg < 180.0) {
                assertEquals("Should be slice 1 for 60 <= deg < 180", 1, slice)
            } else {
                assertEquals("Should be slice 2 for deg >= 180", 2, slice)
            }
        }
    }

    // =========================================================================
    // 2. heatmapCellAtPosition Adversarial Stress Tests
    // =========================================================================

    @Test
    fun heatmapCellAtPosition_negativeTouchCoordinates_returnsNull() {
        val width = 200f
        val height = 70f
        val cols = 10
        val rows = 7

        assertNull(heatmapCellAtPosition(-0.01f, 20f, width, height, cols, rows))
        assertNull(heatmapCellAtPosition(20f, -0.01f, width, height, cols, rows))
        assertNull(heatmapCellAtPosition(-50f, -50f, width, height, cols, rows))
        assertNull(heatmapCellAtPosition(-1000f, 35f, width, height, cols, rows))
    }

    @Test
    fun heatmapCellAtPosition_beyondCanvasWidthHeight_returnsNull() {
        val width = 200f
        val height = 70f
        val cols = 10
        val rows = 7

        // Exact boundary (x >= widthPx or y >= heightPx)
        assertNull(heatmapCellAtPosition(200f, 35f, width, height, cols, rows))
        assertNull(heatmapCellAtPosition(100f, 70f, width, height, cols, rows))
        assertNull(heatmapCellAtPosition(200f, 70f, width, height, cols, rows))

        // Outside canvas bounds
        assertNull(heatmapCellAtPosition(200.5f, 35f, width, height, cols, rows))
        assertNull(heatmapCellAtPosition(100f, 70.5f, width, height, cols, rows))
        assertNull(heatmapCellAtPosition(500f, 500f, width, height, cols, rows))
        assertNull(heatmapCellAtPosition(Float.MAX_VALUE, Float.MAX_VALUE, width, height, cols, rows))

        // Just inside canvas bounds
        val cellNearBottomRight = heatmapCellAtPosition(199.9f, 69.9f, width, height, cols, rows)
        assertNotNull(cellNearBottomRight)
        assertTrue("Col must be in 0 until cols", cellNearBottomRight!!.first in 0 until cols)
        assertTrue("Row must be in 0 until rows", cellNearBottomRight.second in 0 until rows)
    }

    @Test
    fun heatmapCellAtPosition_zeroOrNegativeCanvasDimensions_returnsNull() {
        assertNull(heatmapCellAtPosition(10f, 10f, 0f, 70f, 10, 7))
        assertNull(heatmapCellAtPosition(10f, 10f, 200f, 0f, 10, 7))
        assertNull(heatmapCellAtPosition(10f, 10f, 0f, 0f, 10, 7))
        assertNull(heatmapCellAtPosition(10f, 10f, -100f, 70f, 10, 7))
        assertNull(heatmapCellAtPosition(10f, 10f, 200f, -50f, 10, 7))
    }

    @Test
    fun heatmapCellAtPosition_zeroOrNegativeGridRowsOrColumns_returnsNull() {
        val width = 200f
        val height = 70f

        assertNull(heatmapCellAtPosition(10f, 10f, width, height, columns = 0, rows = 7))
        assertNull(heatmapCellAtPosition(10f, 10f, width, height, columns = 10, rows = 0))
        assertNull(heatmapCellAtPosition(10f, 10f, width, height, columns = -5, rows = 7))
        assertNull(heatmapCellAtPosition(10f, 10f, width, height, columns = 10, rows = -1))
        assertNull(heatmapCellAtPosition(10f, 10f, width, height, columns = 0, rows = 0))
    }

    @Test
    fun heatmapCellAtPosition_denseGridCellMappingStressTest() {
        val width = 300f
        val height = 140f
        val cols = 15
        val rows = 7
        val gap = 2f

        val cellWidth = ((width - gap * (cols - 1)) / cols).coerceAtLeast(1f)
        val cellHeight = ((height - gap * (rows - 1)) / rows).coerceAtLeast(1f)

        // Verify that center of every single cell maps to its expected coordinate
        for (c in 0 until cols) {
            for (r in 0 until rows) {
                val cx = c * (cellWidth + gap) + cellWidth / 2f
                val cy = r * (cellHeight + gap) + cellHeight / 2f
                val result = heatmapCellAtPosition(cx, cy, width, height, cols, rows, gap)
                assertEquals("Cell center ($cx, $cy) must map to ($c, $r)", c to r, result)
            }
        }
    }

    // =========================================================================
    // 3. shouldAnchorTooltipToRight Boundary Stress Tests
    // =========================================================================

    @Test
    fun shouldAnchorTooltipToRight_adversarialInputs() {
        val chartWidth = 1000f

        // touchX < 0: strictly on the left of chart, tooltip should anchor to the right
        assertTrue(shouldAnchorTooltipToRight(touchX = -10f, chartWidth = chartWidth))
        assertTrue(shouldAnchorTooltipToRight(touchX = -500f, chartWidth = chartWidth))
        assertTrue(shouldAnchorTooltipToRight(touchX = -0.001f, chartWidth = chartWidth))

        // touchX == width / 2: exactly at center threshold (500f), not < 500f -> false (anchors to left)
        assertFalse(shouldAnchorTooltipToRight(touchX = 500f, chartWidth = chartWidth))

        // Just on either side of width / 2
        assertTrue(shouldAnchorTooltipToRight(touchX = 499.99f, chartWidth = chartWidth))
        assertFalse(shouldAnchorTooltipToRight(touchX = 500.01f, chartWidth = chartWidth))

        // touchX > width: strictly on the right of chart, tooltip should anchor to the left (false)
        assertFalse(shouldAnchorTooltipToRight(touchX = 1000.01f, chartWidth = chartWidth))
        assertFalse(shouldAnchorTooltipToRight(touchX = 1500f, chartWidth = chartWidth))
        assertFalse(shouldAnchorTooltipToRight(touchX = 50000f, chartWidth = chartWidth))

        // chartWidth <= 0
        // width = 0f: 0 * 0.5 = 0f. touchX < 0 is true, touchX >= 0 is false
        assertFalse(shouldAnchorTooltipToRight(touchX = 0f, chartWidth = 0f))
        assertFalse(shouldAnchorTooltipToRight(touchX = 10f, chartWidth = 0f))
        assertTrue(shouldAnchorTooltipToRight(touchX = -10f, chartWidth = 0f))

        // Negative chartWidth (e.g. unmeasured or corrupted layout)
        // chartWidth = -100f, midpoint = -50f
        assertTrue(shouldAnchorTooltipToRight(touchX = -60f, chartWidth = -100f))
        assertFalse(shouldAnchorTooltipToRight(touchX = -40f, chartWidth = -100f))
    }

    // =========================================================================
    // 4. formatTrendAnchorLabel Adversarial Stress Tests
    // =========================================================================

    @Test
    fun formatTrendAnchorLabel_emptyAndBlankStrings() {
        assertEquals("", formatTrendAnchorLabel(""))
        assertEquals("", formatTrendAnchorLabel("   "))
        assertEquals("", formatTrendAnchorLabel("\t\n  \r"))
    }

    @Test
    fun formatTrendAnchorLabel_malformedDates_doesNotThrowAndPreservesInput() {
        assertEquals("2026-9-4", formatTrendAnchorLabel("2026-9-4"))
        assertEquals("2026/09/04", formatTrendAnchorLabel("2026/09/04"))
        assertEquals("2026-", formatTrendAnchorLabel("2026-"))
        assertEquals("2026", formatTrendAnchorLabel("2026"))
        assertEquals("random-bucket-key", formatTrendAnchorLabel("random-bucket-key"))
        assertEquals("!!!", formatTrendAnchorLabel("!!!"))
        assertEquals("2026-09-04-invalid-extra", formatTrendAnchorLabel("2026-09-04-invalid-extra"))
    }

    @Test
    fun formatTrendAnchorLabel_edgeTimestamps() {
        // Daily ISO buckets (YYYY-MM-DD) -> extracts MM-DD
        assertEquals("01-01", formatTrendAnchorLabel("1970-01-01"))
        assertEquals("12-31", formatTrendAnchorLabel("9999-12-31"))
        assertEquals("01-01", formatTrendAnchorLabel("0001-01-01"))
        assertEquals("02-29", formatTrendAnchorLabel("2024-02-29")) // Leap day

        // Monthly ISO buckets (YYYY-MM) -> extracts MM
        assertEquals("01", formatTrendAnchorLabel("2026-01"))
        assertEquals("12", formatTrendAnchorLabel("2026-12"))

        // Full ISO timestamps with 'T' separator -> extracts MM-DD HH:MM
        assertEquals("09-04 00:00", formatTrendAnchorLabel("2026-09-04T00:00:00Z"))
        assertEquals("09-04 12:34", formatTrendAnchorLabel("2026-09-04T12:34:56.789Z"))
        assertEquals("01-01 00:00", formatTrendAnchorLabel("2026-01-01T00:00:00+08:00"))

        // Timestamps with space separator
        assertEquals("09-04 23:59", formatTrendAnchorLabel("2026-09-04 23:59:59"))
        assertEquals("09-04 08:30", formatTrendAnchorLabel("2026-09-04 08:30"))

        // Outer whitespace trimmed
        assertEquals("09-04", formatTrendAnchorLabel("   2026-09-04   "))
        assertEquals("09-04 14:00", formatTrendAnchorLabel("  2026-09-04T14:00:00Z \n"))
    }

    @Test
    fun formatTrendAnchorLabel_leapSeconds_handledCleanly() {
        // Leap seconds in ISO format (second = 60)
        // RegEx parser gracefully captures date and hour:minute without rejecting second 60
        assertEquals("12-31 23:59", formatTrendAnchorLabel("2016-12-31T23:59:60Z"))
        assertEquals("12-31 23:59", formatTrendAnchorLabel("2016-12-31 23:59:60"))
        assertEquals("06-30 23:59", formatTrendAnchorLabel("2015-06-30T23:59:60+00:00"))
    }
}
