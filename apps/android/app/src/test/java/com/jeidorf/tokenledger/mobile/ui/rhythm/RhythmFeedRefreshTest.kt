package com.jeidorf.tokenledger.mobile.ui.rhythm

import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.MobileSession
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.rhythm.ActivityRhythmJson
import com.jeidorf.tokenledger.mobile.rhythm.ActivityRhythmSource
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class RhythmFeedRefreshTest {
    private val session = MobileSession("access", "refresh", "user-1", "u@example.com", 4_102_444_800L)
    private val query = DashboardQuery(range = RangeKey.Week)

    private fun rhythmJson(tokens: Long) = """
        {"meta":{"source":"cloud","start":"2026-10-19","end":"2026-10-24","timezone":"Asia/Shanghai","rangeTruncated":false},
         "summary":{"tokens":$tokens,"inputTokens":$tokens,"outputTokens":0,"cachedTokens":0,"requests":1,"activeDays":1,"toolCount":1,"modelCount":1},
         "tools":[{"id":"codex","tokens":$tokens,"requests":1}],
         "dayHours":[{"date":"2026-10-24","hour":9,"tokens":$tokens,"requests":1}],
         "modelHours":[{"hour":9,"model":"gpt-5","tokens":$tokens,"requests":1}],
         "modelDays":[]}
    """.trimIndent()

    @Test
    fun refreshWithTheSameQueryChangesTheRequestKey() {
        val first = cloudFeedRequestKey("user-1", query, refreshKey = "2026-10-24T09:00:00Z", attempt = 0, timezone = "Asia/Shanghai")
        assertEquals(first, cloudFeedRequestKey("user-1", query, "2026-10-24T09:00:00Z", 0, "Asia/Shanghai"))
        assertNotEquals(first, cloudFeedRequestKey("user-1", query, "2026-10-24T09:05:00Z", 0, "Asia/Shanghai"))
        assertNotEquals(first, cloudFeedRequestKey("user-1", query, "2026-10-24T09:00:00Z", 0, "Europe/Berlin"))
        assertNotEquals(first, cloudFeedRequestKey("user-1", query, "2026-10-24T09:00:00Z", 1, "Asia/Shanghai"))
    }

    @Test
    fun everyLoadAfterASuccessReadsTheSourceAgain() = runTest {
        var calls = 0
        val source = ActivityRhythmSource { _, _ ->
            calls++
            ActivityRhythmJson.parse(rhythmJson(100L * calls))
        }
        val first = loadRhythmFeed(session, query, "Asia/Shanghai", source)
        val second = loadRhythmFeed(session, query, "Asia/Shanghai", source)
        assertEquals(2, calls)
        assertEquals(100L, first.rhythm?.summary?.tokens)
        assertEquals(200L, second.rhythm?.summary?.tokens)
    }
}
