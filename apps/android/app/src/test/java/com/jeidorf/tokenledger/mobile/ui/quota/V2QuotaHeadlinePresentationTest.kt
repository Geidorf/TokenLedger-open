package com.jeidorf.tokenledger.mobile.ui.quota

import com.jeidorf.tokenledger.mobile.QuotaDisplayValue
import com.jeidorf.tokenledger.mobile.QuotaUnit
import com.jeidorf.tokenledger.mobile.QuotaWindowStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class V2QuotaHeadlinePresentationTest {
    @Test
    fun availablePercentageUsesNumericPrimaryAndSecondaryQualifier() {
        val actual = quotaHeadlinePresentation(
            QuotaDisplayValue.Progress(43.0, 100.0, 57.0, QuotaUnit.Percent, 0.43f),
            QuotaWindowStatus.Ok
        )

        assertEquals("57%", actual.primary)
        assertEquals("可用", actual.qualifier)
    }

    @Test
    fun availableCreditsUseTheSameSecondaryQualifier() {
        val actual = quotaHeadlinePresentation(
            QuotaDisplayValue.Absolute(null, 100.0, 2.5, QuotaUnit.Credits),
            QuotaWindowStatus.Ok
        )

        assertEquals("2.5 Credits", actual.primary)
        assertEquals("可用", actual.qualifier)
    }

    @Test
    fun usedAmountAndUnavailableStatusKeepTheirOriginalMeaning() {
        val used = quotaHeadlinePresentation(
            QuotaDisplayValue.Absolute(17.0, null, null, QuotaUnit.Requests),
            QuotaWindowStatus.Ok
        )
        val unavailable = quotaHeadlinePresentation(null, QuotaWindowStatus.Error)

        assertEquals("已用 17 次请求", used.primary)
        assertNull(used.qualifier)
        assertEquals("暂时不可用", unavailable.primary)
        assertNull(unavailable.qualifier)
    }
}
