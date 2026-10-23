package com.jeidorf.tokenledger.mobile.ui.quota

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QuotaPaceTest {
    private val now = Instant.parse("2026-09-07T02:00:00Z")

    @Test
    fun paceIsRemainingTimeOverWindowLength() {
        // 5 小时窗口还剩 2 小时：匀速用完时此刻应剩 40%。
        assertEquals(0.4f, quotaPaceRemainingFraction(300, "2026-09-07T12:00:00+08:00", now)!!, 0.0001f)
    }

    @Test
    fun elapsedResetDrawsNoLineAndFarResetClampsToOne() {
        assertNull(quotaPaceRemainingFraction(300, "2026-09-07T01:00:00Z", now))
        assertEquals(1f, quotaPaceRemainingFraction(60, "2026-09-08T02:00:00Z", now)!!, 0.0001f)
    }

    @Test
    fun missingWindowOrResetDrawsNoPaceLine() {
        assertNull(quotaPaceRemainingFraction(null, "2026-09-07T04:00:00Z", now))
        assertNull(quotaPaceRemainingFraction(0, "2026-09-07T04:00:00Z", now))
        assertNull(quotaPaceRemainingFraction(300, null, now))
        assertNull(quotaPaceRemainingFraction(300, "不是时间", now))
    }

    @Test
    fun projectsShortfallFromAverageRateSinceWindowStart() {
        // 5 小时窗口已过 3 小时用掉 80%，剩 20% 按同速 45 分钟用完，而重置还要 2 小时：早 75 分钟。
        assertEquals(75L, quotaProjectedShortfallMinutes(300, "2026-09-07T04:00:00Z", 0.2f, now))
        assertEquals(
            "照现在的速度，5 小时额度会比重置早 1 小时 15 分钟用完。",
            quotaShortfallNote("5 小时额度", 75L)
        )
    }

    @Test
    fun noShortfallWhenOnPaceExhaustedOrTooEarly() {
        assertNull(quotaProjectedShortfallMinutes(300, "2026-09-07T04:00:00Z", 0.5f, now))
        assertNull(quotaProjectedShortfallMinutes(300, "2026-09-07T04:00:00Z", 0f, now))
        // 窗口才开 5 分钟，样本太少不外推。
        assertNull(quotaProjectedShortfallMinutes(300, "2026-09-07T06:55:00Z", 0.5f, now))
        assertNull(quotaProjectedShortfallMinutes(null, "2026-09-07T04:00:00Z", 0.2f, now))
    }

    @Test
    fun shortfallNoteUsesCoarsestUnit() {
        assertEquals("照现在的速度，每周额度会比重置早 25 分钟用完。", quotaShortfallNote("每周额度", 25L))
        assertEquals("照现在的速度，每周额度会比重置早 2 小时用完。", quotaShortfallNote("每周额度", 120L))
        assertEquals("照现在的速度，每周额度会比重置早 3 天用完。", quotaShortfallNote("每周额度", 3L * 24L * 60L + 30L))
    }

    @Test
    fun paceIsSpokenForScreenReaders() {
        assertEquals("按时间匀速应剩 40%，用得偏快", quotaPaceAccessibilityNote(0.2f, 0.4f))
        assertEquals("按时间匀速应剩 40%，没有超出匀速", quotaPaceAccessibilityNote(0.62f, 0.4f))
    }
}
