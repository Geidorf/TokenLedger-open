package com.jeidorf.tokenledger.mobile

import java.io.ByteArrayInputStream
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SupabaseGatewayTest {
    @Test
    fun statsPayloadUsesTodayAndTimezone() {
        val gateway = SupabaseGateway("https://example.supabase.co", "sb_publishable_test")
        val payload = gateway.createStatsPayload(
            userId = "00000000-0000-0000-0000-000000000000",
            range = "",
            machine = "all_cloud",
            timezone = "Asia/Shanghai"
        )

        assertEquals("today", payload.getString("p_range"))
        assertEquals("Asia/Shanghai", payload.getString("p_timezone"))
        assertTrue(payload.isNull("p_machine"))
    }

    @Test
    fun statsPayloadKeepsMachineFilter() {
        val gateway = SupabaseGateway("https://example.supabase.co", "sb_publishable_test")
        val payload = gateway.createStatsPayload(
            userId = "00000000-0000-0000-0000-000000000000",
            range = "week",
            machine = "workstation",
            timezone = "UTC"
        )

        assertEquals("week", payload.getString("p_range"))
        assertEquals("workstation", payload.getString("p_machine"))
        assertEquals(JSONObject::class.java, payload::class.java)
    }

    @Test
    fun legacyStatsPayloadOmitsTimezone() {
        val gateway = SupabaseGateway("https://example.supabase.co", "sb_publishable_test")
        val payload = gateway.createStatsPayload(
            userId = "00000000-0000-0000-0000-000000000000",
            range = "today",
            machine = "all_cloud",
            timezone = "Asia/Shanghai",
            includeTimezone = false
        )

        assertEquals("today", payload.getString("p_range"))
        assertTrue(payload.isNull("p_machine"))
        assertTrue(!payload.has("p_timezone"))
    }

    @Test
    fun detectsMissingRpcSignature() {
        val error = SupabaseHttpException(
            status = 404,
            code = "PGRST202",
            detail = "Could not find the function public.get_dashboard_stats(p_machine, p_range, p_timezone, p_user) in the schema cache",
            displayMessage = "Supabase request failed"
        )

        assertTrue(error.isMissingRpcSignature("get_dashboard_stats"))
    }

    @Test
    fun onlyStableOldNormalizerDiagnosticMapsToCustomRangeCapability() {
        val oldNormalizer = SupabaseHttpException(
            status = 400,
            code = "22023",
            detail = "query-v2: invalid range custom",
            displayMessage = "Supabase request failed"
        )
        assertTrue(oldNormalizer.isLegacyCustomRangeRejection())
        assertTrue(
            !SupabaseHttpException(
                status = 400,
                code = "22023",
                detail = "query-v2: custom range exceeds 731 days",
                displayMessage = "Supabase request failed"
            ).isLegacyCustomRangeRejection()
        )
        assertTrue(
            !SupabaseHttpException(
                status = 500,
                code = "22023",
                detail = "query-v2: invalid range custom",
                displayMessage = "Supabase request failed"
            ).isLegacyCustomRangeRejection()
        )
    }

    @Test
    fun v2PayloadCarriesEveryFilterAndEffectiveQueryContext() {
        val gateway = SupabaseGateway("https://example.supabase.co", "sb_publishable_test")
        val payload = gateway.createV2QueryPayload(
            userId = "user-1",
            query = DashboardQuery(
                range = RangeKey.Month,
                machine = "macbook",
                tool = "codex",
                model = "gpt-5"
            ),
            timezone = "Asia/Shanghai"
        )

        assertEquals("month", payload.getString("p_range"))
        assertEquals("macbook", payload.getString("p_machine"))
        assertEquals("codex", payload.getString("p_tool"))
        assertEquals("gpt-5", payload.getString("p_model"))
        assertEquals("Asia/Shanghai", payload.getString("p_timezone"))
    }

    @Test
    fun detailsPayloadNormalizesAllMachinesAndBoundsPageSize() {
        val gateway = SupabaseGateway("https://example.supabase.co", "sb_publishable_test")
        val payload = gateway.createDetailsPayload(
            userId = "user-1",
            query = DashboardQuery(machine = DashboardQuery.ALL_MACHINES),
            timezone = "UTC",
            cursor = "v1.cursor",
            limit = 1000
        )

        assertTrue(payload.isNull("p_machine"))
        assertTrue(payload.isNull("p_tool"))
        assertTrue(payload.isNull("p_model"))
        assertEquals("v1.cursor", payload.getString("p_cursor"))
        assertEquals(100, payload.getInt("p_limit"))
    }

    @Test
    fun boundedResponseReaderAcceptsExactLimitAndRejectsOneExtraByte() {
        val exact = "额度".toByteArray(Charsets.UTF_8)
        assertEquals(
            "额度",
            readUtf8ResponseBounded(ByteArrayInputStream(exact), exact.size)
        )
        assertThrows(SupabaseResponseTooLargeException::class.java) {
            readUtf8ResponseBounded(ByteArrayInputStream(exact + byteArrayOf(0)), exact.size)
        }
    }

    @Test
    fun comparisonMayReturnSqlNullWithoutMakingYearOrAllDashboardFail() {
        assertEquals(
            null,
            normalizeRpcObjectEnvelope(
                functionName = "get_usage_comparison_v2",
                raw = "null",
                allowNullEnvelope = true
            )
        )
    }

    @Test
    fun requiredV2EnvelopesStillRejectBlankAndNullResponses() {
        assertThrows(DashboardQueryContractException::class.java) {
            normalizeRpcObjectEnvelope(
                functionName = "get_usage_details_v2",
                raw = "null",
                allowNullEnvelope = false
            )
        }
        assertThrows(DashboardQueryContractException::class.java) {
            normalizeRpcObjectEnvelope(
                functionName = "get_usage_comparison_v2",
                raw = "  ",
                allowNullEnvelope = true
            )
        }
    }
}
