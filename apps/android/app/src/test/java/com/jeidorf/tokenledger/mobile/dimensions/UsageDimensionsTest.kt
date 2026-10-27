package com.jeidorf.tokenledger.mobile.dimensions

import com.jeidorf.tokenledger.mobile.SupabaseHttpException
import com.jeidorf.tokenledger.mobile.DashboardAuthExpiredException
import com.jeidorf.tokenledger.mobile.ui.dimensions.contextSlices
import com.jeidorf.tokenledger.mobile.ui.dimensions.formatContextBytes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class UsageDimensionsTest {
    private fun response(
        sessions: String = SESSIONS_OK,
        providers: String = PROVIDERS_OK,
        context: String = CONTEXT_OK,
        start: String = "2026-10-01"
    ) = """
        {"meta":{"source":"cloud","start":"$start","end":"2026-10-24","timezone":"Asia/Shanghai","retentionDays":90,"coverageStart":"2026-07-26"},
         "sessions":$sessions,"providers":$providers,"contextComposition":$context}
    """.trimIndent()

    @Test
    fun parsesAllThreeDimensions() {
        val parsed = UsageDimensionsJson.parse(response())
        val sessions = (parsed.sessions as DimensionPart.Ok).value
        assertEquals(3L, sessions.sessionCount)
        assertEquals("codex", sessions.rows.single().tool)
        assertNull(sessions.rows.single().topModel)
        val providers = (parsed.providers as DimensionPart.Ok).value
        assertEquals(listOf("openai", "other"), providers.map { it.provider })
        assertNull(providers.last().cost)
        // cached 是读写合计：500 = 读 480 + 写 20。
        assertEquals(500L, providers.first().cached)
        assertEquals(20L, providers.first().cacheWrite)
        assertEquals(480L, providers.first().cacheRead)
        assertEquals(0L, providers.last().cacheRead)
        assertTrue(providers.last().isOther)
        assertEquals(6L, (parsed.context as DimensionPart.Ok).value.requests)
        assertEquals(false, parsed.rangeBeforeRetention)
        assertTrue(UsageDimensionsJson.parse(response(start = "2026-07-01")).rangeBeforeRetention)
    }

    @Test
    fun emptyAndFilteredStatesCarryNoNumbers() {
        val parsed = UsageDimensionsJson.parse(
            response(sessions = """{"state":"empty"}""", providers = """{"state":"filtered"}""", context = """{"state":"empty"}""")
        )
        assertEquals(DimensionPart.Empty, parsed.sessions)
        assertEquals(DimensionPart.Filtered, parsed.providers)
        assertEquals(DimensionPart.Empty, parsed.context)
    }

    @Test
    fun rejectsResponsesThatBreakTheContract() {
        listOf(
            response(sessions = SESSIONS_OK.replace("\"0123456789abcdef0123456789abcdef\"", "\"raw-session-id\"")),
            response(sessions = SESSIONS_OK.replace("\"08:05\"", "\"8:05\"")),
            response(sessions = SESSIONS_OK.replace("\"sessionCount\":3", "\"sessionCount\":0")),
            response(providers = PROVIDERS_OK.replace("\"openai\"", "\"my-relay\"")),
            response(providers = PROVIDERS_OK.replace("\"total\":450", "\"total\":451")),
            response(providers = PROVIDERS_OK.replace("\"cost\":0.12", "\"cost\":-1")),
            response(providers = PROVIDERS_OK.replace("\"cacheWrite\":20", "\"cacheWrite\":501")),
            response(context = CONTEXT_OK.replace("\"requests\":6", "\"requests\":0")),
            response(sessions = """{"state":"maybe"}"""),
            response().replace("\"cloud\"", "\"local\"")
        ).forEach { raw -> assertThrows(raw, UsageDimensionsFormatException::class.java) { UsageDimensionsJson.parse(raw) } }
    }

    @Test
    fun missingRpcIsNotDeployedAndAuthFailuresStayDistinct() {
        val missing = SupabaseHttpException(
            status = 404,
            code = "PGRST202",
            detail = "Could not find the function public.get_usage_dimensions_v1(p_query) in the schema cache",
            displayMessage = "not found"
        )
        assertEquals(DimensionsReadFailure.NotDeployed, DimensionsReadFailure.classify(missing))
        assertEquals(DimensionsReadFailure.BadFormat, DimensionsReadFailure.classify(UsageDimensionsFormatException("x")))
        assertEquals(DimensionsReadFailure.Unauthorized, DimensionsReadFailure.classify(DashboardAuthExpiredException()))
        assertEquals(
            DimensionsReadFailure.Unauthorized,
            DimensionsReadFailure.classify(SupabaseHttpException(401, null, "expired", "expired"))
        )
    }

    @Test
    fun contextSlicesAverageAndShareBytes() {
        val context = CloudContextComposition(4, 4_000, 400, 0, 1_200, 400, 0, 10, 2, 0)
        val slices = contextSlices(context)
        assertEquals(listOf(100L, 0L, 300L, 100L, 0L), slices.map { it.averageBytes })
        assertEquals(0.6, slices[2].share, 1e-9)
        assertTrue(contextSlices(context.copy(systemBytes = 0, historyBytes = 0, toolResultsBytes = 0)).isEmpty())
        assertEquals("1.5 KB", formatContextBytes(1_536))
        assertEquals("900 B", formatContextBytes(900))
    }

    private companion object {
        const val SESSIONS_OK = """{"state":"ok","sessionCount":3,"truncatedDays":0,"sessionLimit":100,"rows":[
            {"id":"0123456789abcdef0123456789abcdef","machine":"device-a","tool":"codex","tokens":550,"requests":3,"cost":0.27,
             "days":2,"firstDate":"2026-10-23","lastDate":"2026-10-24","firstAt":"08:05","lastAt":"11:15","topModel":null}]}"""
        const val PROVIDERS_OK = """{"state":"ok","rows":[
            {"provider":"openai","input":400,"output":50,"cached":500,"cacheWrite":20,"total":450,"requests":6,"cost":0.12},
            {"provider":"other","input":10,"output":5,"cached":0,"cacheWrite":0,"total":15,"requests":1,"cost":null}]}"""
        const val CONTEXT_OK = """{"state":"ok","requests":6,"promptTokens":900,"systemBytes":10,"toolsBytes":0,"historyBytes":20,
            "toolResultsBytes":0,"attachmentsBytes":0,"messages":4,"toolResults":0,"attachments":0}"""
    }
}
