package com.jeidorf.tokenledger.mobile.ui.controls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * T10.208 R-67 修复轮（评审 P1-3）：范围轨道的几何是纯函数——测量时算，同一帧的胶囊绘制与首帧滚入
 * 直接用。这里钉住评审复刻出的三处错：胶囊与各项对齐（不再左偏 4dp、贴轨道左缘）、上下内缩 4、
 * 滚入后选中项整格落在 28dp 渐隐之外。
 */
class V2RangeTrackGeometryTest {
    // 320dp × 100%：五项都被 48dp 下限撑到 48，内缩 4、间距 4 → 内容 264；视口 = 296 − 8 − 48 = 240。
    private val widths = listOf(48, 48, 48, 48, 48)
    private val starts = v2RangeOptionStarts(widths, inset = 4, gap = 4)

    @Test
    fun optionsStartAfterTheTrackInsetAndTheContentEndsWithIt() {
        assertEquals(listOf(4, 56, 108, 160, 212, 264), starts)
    }

    @Test
    fun pillSitsExactlyOnTheOptionAndIsInsetFourFromTheTrackEdges() {
        val pill = v2RangePillRect(0f, floats(starts.dropLast(1)), floats(widths), trackHeight = 48f, inset = 4f)!!
        assertEquals(4f, pill.left, 0f)
        assertEquals(52f, pill.right, 0f)
        assertEquals(4f, pill.top, 0f)
        // 高 40 = 48 − 2 × 4：轨道圆角 12 − 内缩 4 = 胶囊圆角 8 的同心关系（§3.4、§4.3）。
        assertEquals(44f, pill.bottom, 0f)
    }

    @Test
    fun pillInterpolatesBetweenNeighbouringOptionsWhileSliding() {
        val pill = v2RangePillRect(1.5f, floats(listOf(4, 56, 120)), floats(listOf(48, 60, 48)), 48f, 4f)!!
        assertEquals(88f, pill.left, 1e-3f)
        assertEquals(54f, pill.width, 1e-3f)
    }

    @Test
    fun noPillWithoutOptions() {
        assertNull(v2RangePillRect(0f, FloatArray(0), FloatArray(0), 48f, 4f))
    }

    @Test
    fun revealScrollsTheLastOptionClearOfTheFade() {
        // 选「总计」[212, 260]：滚到底（24），右侧不再有渐隐；左侧渐隐 [24, 52] 盖不到它。
        val target = v2RangeRevealScroll(0f, 212f, 260f, viewport = 240f, content = 264f, fade = 28f)
        assertEquals(24f, target, 0f)
        assertTrue(212f >= target + 28f && 260f <= target + 240f)
    }

    @Test
    fun revealKeepsAMiddleOptionOutOfBothFades() {
        // 视口 144、内容 264：滚动位置 0 时「今年」[160, 208] 有一半在右侧渐隐下（评审 P1-3 d）。
        val target = v2RangeRevealScroll(0f, 160f, 208f, viewport = 144f, content = 264f, fade = 28f)
        assertEquals(92f, target, 0f)
        assertTrue(160f >= target + 28f && 208f <= target + 144f - 28f)
    }

    @Test
    fun revealScrollsBackToTheStartForTheFirstOption() {
        assertEquals(0f, v2RangeRevealScroll(120f, 4f, 52f, 144f, 264f, 28f), 0f)
    }

    @Test
    fun revealLeavesAnOptionThatIsAlreadyClearAlone() {
        assertEquals(40f, v2RangeRevealScroll(40f, 108f, 156f, 144f, 264f, 28f), 0f)
    }

    @Test
    fun revealIsZeroWhenNothingOverflows() {
        assertEquals(0f, v2RangeRevealScroll(0f, 212f, 260f, 300f, 264f, 28f), 0f)
    }

    private fun floats(values: List<Int>) = FloatArray(values.size) { values[it].toFloat() }
}
