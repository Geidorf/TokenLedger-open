package com.jeidorf.tokenledger.mobile.ui.rhythm

import org.junit.Assert.assertEquals
import org.junit.Test

class RhythmHourBreakdownTest {
    @Test
    fun listsOnlyHoursWithUsageInOrder() {
        val hours = List(24) { 0L }.toMutableList().apply {
            this[9] = 1_200L
            this[14] = 35_000L
        }
        assertEquals("有用量的时段：9 点 1.2K、14 点 35.0K", rhythmHourBreakdown(hours))
    }

    @Test
    fun saysSoWhenNoHourHasUsage() {
        assertEquals("各时段都没有用量", rhythmHourBreakdown(List(24) { 0L }))
    }
}
