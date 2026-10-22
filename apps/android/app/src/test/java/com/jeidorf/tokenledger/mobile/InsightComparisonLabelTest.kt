package com.jeidorf.tokenledger.mobile

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

class InsightComparisonLabelTest {
    @Test fun customDayDrillDownKeepsItsExistingComparisonLabel() {
        val comparison = requireNotNull(StatsJson.parse(File("../../../fixtures/dashboard-stats-v2/complete-v2.json").readText()).comparison)
        assertEquals("当前 vs 上一周期 · 同进度", v2ComparisonLabel(comparison.copy(window = comparison.window.copy(kind = "periodOverPeriod"))))
        assertEquals("当前范围没有自动基线", v2ComparisonLabel(null))
        assertEquals("当前范围没有自动基线", v2ComparisonLabel(comparison.copy(window = comparison.window.copy(kind = "future-kind"))))
    }
}
