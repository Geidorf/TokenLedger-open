package com.jeidorf.tokenledger.mobile.ui.calendar

import org.junit.Assert.assertEquals
import org.junit.Test

class V2CalendarMonthGridLayoutTest {
    @Test
    fun phoneWidthsKeepReadableMonthColumns() {
        assertEquals(2, calendarMonthsPerRow(screenWidthDp = 320, fontScale = 1f))
        assertEquals(3, calendarMonthsPerRow(screenWidthDp = 390, fontScale = 1f))
        assertEquals(3, calendarMonthsPerRow(screenWidthDp = 430, fontScale = 1f))
    }

    @Test
    fun largeTextReducesColumnsBeforeMonthCardsCollide() {
        assertEquals(2, calendarMonthsPerRow(screenWidthDp = 390, fontScale = 1.5f))
        assertEquals(1, calendarMonthsPerRow(screenWidthDp = 430, fontScale = 2f))
    }
}
