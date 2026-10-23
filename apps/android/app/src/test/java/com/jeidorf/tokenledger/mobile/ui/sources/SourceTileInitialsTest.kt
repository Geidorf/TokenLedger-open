package com.jeidorf.tokenledger.mobile.ui.sources

import org.junit.Assert.assertEquals
import org.junit.Test

class SourceTileInitialsTest {
    @Test
    fun multiWordNamesUseFirstLettersOfTwoWords() {
        assertEquals("CC", sourceTileInitials("Claude Code"))
        assertEquals("GC", sourceTileInitials("gemini-cli"))
        assertEquals("OC", sourceTileInitials("open_code agent"))
    }

    @Test
    fun singleLatinWordUsesFirstLetterAndNextConsonant() {
        assertEquals("Cd", sourceTileInitials("Codex"))
        assertEquals("Gm", sourceTileInitials("Gemini"))
        assertEquals("Ai", sourceTileInitials("Aio"))
        assertEquals("X", sourceTileInitials("x"))
    }

    @Test
    fun nonLatinAndBlankNamesStayShort() {
        assertEquals("通", sourceTileInitials("通义灵码"))
        assertEquals("?", sourceTileInitials("   "))
    }
}
