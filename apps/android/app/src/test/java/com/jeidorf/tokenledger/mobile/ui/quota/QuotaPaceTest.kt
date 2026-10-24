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
    fun paceIsSpokenForScreenReaders() {
        assertEquals("按时间匀速应剩 40%，用得偏快", quotaPaceAccessibilityNote(0.2f, 0.4f))
        assertEquals("按时间匀速应剩 40%，没有超出匀速", quotaPaceAccessibilityNote(0.62f, 0.4f))
    }
}
