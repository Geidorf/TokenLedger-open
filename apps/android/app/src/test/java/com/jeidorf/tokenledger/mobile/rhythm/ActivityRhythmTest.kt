package com.jeidorf.tokenledger.mobile.rhythm

import com.jeidorf.tokenledger.mobile.SupabaseHttpException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivityRhythmTest {
    private val sample = """
        {"meta":{"source":"cloud","contractVersion":1,"range":"custom","start":"2026-09-21","end":"2026-09-27",
          "timezone":"Asia/Shanghai","rangeTruncated":false,"recordCount":7},
         "summary":{"tokens":600,"inputTokens":500,"outputTokens":100,"cachedTokens":50,"requests":7,
          "activeDays":2,"toolCount":2,"modelCount":2},
         "tools":[{"id":"codex","tokens":400,"requests":4},{"id":"claude","tokens":200,"requests":3}],
         "dayHours":[{"date":"2026-09-21","hour":9,"tokens":300,"requests":3},
                     {"date":"2026-09-21","hour":22,"tokens":100,"requests":1},
                     {"date":"2026-09-27","hour":9,"tokens":200,"requests":3}],
         "modelHours":[{"hour":9,"model":"m-a","tokens":500,"requests":6},{"hour":22,"model":"m-b","tokens":100,"requests":1}],
         "modelDays":[],
         "futureField":{"ignored":true}}
    """.trimIndent()

    @Test
    fun parsesAndAggregatesHoursAndWeekdays() {
        val rhythm = ActivityRhythmJson.parse(sample)
        assertEquals(600L, rhythm.summary.tokens)
        assertEquals(500L, rhythm.hourTotals[9].tokens)
        assertEquals(6L, rhythm.hourTotals[9].requests)
        assertEquals(100L, rhythm.hourTotals[22].tokens)
        // 2026-09-21 是周一，2026-09-27 是周日。
        assertEquals(300L, rhythm.weekdayHourTokens[0][9])
        assertEquals(100L, rhythm.weekdayHourTokens[0][22])
        assertEquals(200L, rhythm.weekdayHourTokens[6][9])
        assertEquals(listOf("m-a" to 500L, "m-b" to 100L), rhythm.modelTotals)
    }

    @Test
    fun rejectsResponsesOutsideTheContract() {
        listOf(
            sample.replace("\"source\":\"cloud\"", "\"source\":\"local\""),
            sample.replace("\"hour\":22,\"tokens\":100,\"requests\":1}", "\"hour\":24,\"tokens\":100,\"requests\":1}"),
            sample.replace("\"tokens\":600", "\"tokens\":-1"),
            sample.replace("\"tokens\":600", "\"tokens\":\"600\""),
            sample.replace("\"start\":\"2026-09-21\"", "\"start\":\"09/21\""),
            "{}"
        ).forEach { raw ->
            assertThrows(ActivityRhythmFormatException::class.java) { ActivityRhythmJson.parse(raw) }
        }
    }

    @Test
    fun missingRpcIsNotDeployedRatherThanAnError() {
        val missing = SupabaseHttpException(
            status = 404,
            code = "PGRST202",
            detail = "Could not find the function public.get_activity_rhythm_v1(p_query) in the schema cache",
            displayMessage = "not found"
        )
        assertEquals(RhythmReadFailure.NotDeployed, RhythmReadFailure.classify(missing))
        assertEquals(RhythmReadFailure.BadFormat, RhythmReadFailure.classify(ActivityRhythmFormatException("x")))
        assertTrue(RhythmReadFailure.classify(IllegalStateException()) == RhythmReadFailure.Unavailable)
    }
}
