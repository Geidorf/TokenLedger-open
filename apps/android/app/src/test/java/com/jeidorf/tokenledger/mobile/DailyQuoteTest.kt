package com.jeidorf.tokenledger.mobile

import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DailyQuoteTest {
    @Test
    fun `same local date always returns same quote`() {
        val date = LocalDate.of(2026, 7, 16)

        assertEquals(dailyQuoteFor(date), dailyQuoteFor(date))
    }

    @Test
    fun `next local date advances daily quote`() {
        val date = LocalDate.of(2026, 7, 16)

        assertNotEquals(dailyQuoteFor(date), dailyQuoteFor(date.plusDays(1)))
    }

    @Test
    fun `hitokoto response keeps bounded text author and work`() {
        val quote = parseHitokotoDailyQuote(
            """{"hitokoto":"青枫江上秋帆远，白帝城边古木疏。","from":"送李少府贬峡中王少府贬长沙","from_who":"高适"}"""
        )

        assertEquals("青枫江上秋帆远，白帝城边古木疏。", quote?.text)
        assertEquals("高适 · 《送李少府贬峡中王少府贬长沙》", quote?.source)
        assertEquals(DailyQuoteOrigin.Hitokoto, quote?.origin)
    }

    @Test
    fun `hitokoto response rejects missing or oversized visible fields`() {
        assertNull(parseHitokotoDailyQuote("""{"hitokoto":"","from":"unknown"}"""))
        assertNull(
            parseHitokotoDailyQuote(
                """{"hitokoto":"${"长".repeat(MAX_DAILY_QUOTE_TEXT_LENGTH + 1)}","from":"unknown"}"""
            )
        )
    }

    @Test
    fun `hitokoto response never renders json null as an author`() {
        val jsonNull = parseHitokotoDailyQuote(
            """{"hitokoto":"生活的理想，就是为了理想的生活。","from":"弗拉基米尔·伊里奇·列宁","from_who":null}"""
        )
        val stringNull = parseHitokotoDailyQuote(
            """{"hitokoto":"生活的理想，就是为了理想的生活。","from":"弗拉基米尔·伊里奇·列宁","from_who":"null"}"""
        )

        assertEquals("《弗拉基米尔·伊里奇·列宁》", jsonNull?.source)
        assertEquals("《弗拉基米尔·伊里奇·列宁》", stringNull?.source)
    }

    @Test
    fun `cached placeholder strings are rejected`() {
        assertNull(validateCachedDailyQuote("日日行，不怕千万里。", "undefined", "hitokoto"))
        assertNull(validateCachedDailyQuote("日日行，不怕千万里。", "null", "hitokoto"))
    }

    @Test
    fun `legacy cached composite source removes placeholder author`() {
        val quote = validateCachedDailyQuote(
            text = "任何一件事都具有两面性。",
            source = "null · 《弗拉基米尔·伊里奇·列宁》",
            origin = "hitokoto"
        )

        assertEquals("《弗拉基米尔·伊里奇·列宁》", quote?.source)
        assertEquals(DailyQuoteOrigin.Hitokoto, quote?.origin)
    }
}
