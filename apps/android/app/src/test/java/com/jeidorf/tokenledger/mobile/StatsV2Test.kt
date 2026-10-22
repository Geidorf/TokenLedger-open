package com.jeidorf.tokenledger.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StatsV2Test {
    @Test
    fun sharedContractFixturesKeepV1AndV2Compatible() {
        val legacy = StatsJson.parse(fixture("legacy-v1.json"))
        assertNull(legacy.meta)
        assertFalse(legacy.capabilities.details)

        val complete = StatsJson.parse(fixture("complete-v2.json"))
        assertEquals(2, complete.meta?.contractVersion)
        assertEquals("Asia/Shanghai", complete.meta?.query?.timezone)
        assertTrue(complete.capabilities.comparison)
        assertTrue(complete.capabilities.details)
        assertTrue(complete.capabilities.entityDashboard)
        assertEquals(11, complete.comparison?.current?.series?.size)
        assertEquals(3L, complete.detailsPage?.totalCount)
        assertEquals("gpt-5", complete.detailsPage?.availableFilters?.models?.single()?.value)
        assertEquals("macbook-pro", complete.machineDistribution?.single()?.value)
        assertEquals(1200L, complete.machineDistribution?.single()?.tokens)

        val missingOptionals = StatsJson.parse(fixture("missing-optionals-v2.json"))
        assertEquals(0, missingOptionals.summary.effectiveTokens)
        assertNull(missingOptionals.comparison)
        assertNull(missingOptionals.detailsPage)
        assertNull(missingOptionals.machineDistribution)
        assertFalse(missingOptionals.capabilities.details)

        val unknownFields = StatsJson.parse(fixture("unknown-fields-v2.json"))
        assertEquals(3, unknownFields.summary.effectiveTokens)
        assertEquals("Pacific/Auckland", unknownFields.meta?.timezone)
        assertTrue(unknownFields.capabilities.details)
    }

    @Test
    fun gatewayMergedCloudAggregatesNeedNoAndroidChange() {
        // dashboard-stats-v2 §2.5: desktops dedupe before upload, so the RPC
        // shape is unchanged; a gateway-only tool is just another tool row.
        val root = org.json.JSONObject(fixture("complete-v2.json"))
        root.getJSONObject("summary")
            .put("totalTokens", 1320)
            .put("inputTokens", 1000)
            .put("outputTokens", 320)
            .put("totalRequests", 4)
        root.getJSONObject("tools").put(
            "gateway",
            org.json.JSONObject(
                """{"name":"gateway","input":100,"output":20,"cached":0,"cacheRead":0,"cacheWrite":0,"total":120,"cost":0.01,"requests":1,"models":{"deepseek-chat":120}}"""
            )
        )
        root.getJSONObject("meta").getJSONObject("capabilities").put("gatewayLedger", true)

        val stats = StatsJson.parse(root.toString())

        assertEquals(1320, stats.summary.effectiveTokens)
        assertEquals(4L, stats.summary.totalRequests)
        val gateway = stats.tools.getValue("gateway")
        assertEquals(120L, gateway.total)
        assertEquals(gateway.input + gateway.output, gateway.total)
        assertEquals(0L, gateway.cached)
        assertEquals(1200L, stats.tools.getValue("codex").total)
        assertTrue(stats.capabilities.details)
    }

    @Test
    fun comparisonParsesEqualProgressSeriesAndNullablePercent() {
        val comparison = StatsJson.parseComparison(
            """
            {
              "window": {"kind":"dayOverDay","timezone":"Asia/Shanghai","bucket":"hour","currentStart":"2026-07-15 00:00:00","currentEnd":"2026-07-16 00:00:00","previousStart":"2026-07-14 00:00:00","previousEnd":"2026-07-15 00:00:00","alignedThrough":"2026-07-15 12:00:00"},
              "current": {"summary":{"inputTokens":100,"outputTokens":20,"totalRequests":3},"series":[{"bucket":"10:00","tokens":120,"requests":3,"cost":0.12}]},
              "previous": {"summary":{"inputTokens":0,"outputTokens":0,"totalRequests":0},"series":[{"bucket":"10:00","tokens":0,"requests":0,"cost":0}]},
              "delta": {
                "tokens":{"absolute":120,"percent":null,"direction":"new"},
                "requests":{"absolute":3,"percent":null,"direction":"new"},
                "cost":{"absolute":0.12,"percent":null,"direction":"new"}
              }
            }
            """.trimIndent()
        )!!

        assertEquals(120, comparison.current.summary.effectiveTokens)
        assertEquals("10:00", comparison.current.series.single().bucket)
        assertNull(comparison.delta.tokens.percent)
        assertEquals("new", comparison.delta.tokens.direction)
    }

    @Test
    fun detailsPageParsesFiltersAndAppendsKeysetPageWithoutDuplicates() {
        val first = StatsJson.parseDetailsPage(detailsJson(id = 2, hasMore = true, cursor = "v1.next"))
        val duplicateAndNext = StatsJson.parseDetailsPage(detailsJson(id = 2, hasMore = false, cursor = null))
        val merged = first.append(duplicateAndNext)

        assertEquals(1, merged.items.size)
        assertEquals(4, merged.items.single().requests)
        assertEquals("codex", merged.availableFilters.tools.single().value)
        assertFalse(merged.hasMore)
        assertNull(merged.nextCursor)
    }

    @Test
    fun entityDashboardKeepsCompositionAndActivity() {
        val entity = StatsJson.parseEntityDashboard(
            """
            {
              "entity":{"kind":"tool","tool":"codex","model":null},
              "summary":{"inputTokens":80,"outputTokens":20,"totalRequests":2},
              "comparison":null,
              "composition":{"tools":[],"models":[{"value":"gpt-5","tokens":100,"inputTokens":80,"outputTokens":20,"cachedTokens":10,"cacheWriteTokens":2,"requests":2,"cost":0.4}],"machines":[{"value":"macbook","tokens":100,"requests":2,"cost":0.4}]},
              "heatmap":{"2026-07-15":100},
              "peak":{"bucket":"10:00","tokens":100,"requests":2,"cost":0.4},
              "activity":{"activeDays":1,"firstSeenAt":"2026-07-15 10:00:00","lastSeenAt":"2026-07-15 10:00:00"},
              "historyPage":${detailsJson(id = 1, hasMore = false, cursor = null)},
              "granularity":"hour"
            }
            """.trimIndent()
        )

        assertEquals("codex", entity.entity.label)
        assertEquals("gpt-5", entity.composition.models.single().value)
        assertEquals(1, entity.activity.activeDays)
        assertEquals(100, entity.summary.effectiveTokens)
    }

    private fun detailsJson(id: Long, hasMore: Boolean, cursor: String?): String =
        """
        {
          "items":[{"id":$id,"tool":"codex","model":"gpt-5","inputTokens":8,"outputTokens":2,"cachedTokens":3,"cacheWriteTokens":1,"cost":0.1,"timestamp":"2026-07-15 10:00:00","sessionId":"hour:10","machineId":"macbook","requests":4}],
          "nextCursor":${cursor?.let { "\"$it\"" } ?: "null"},
          "hasMore":$hasMore,
          "totalCount":1,
          "filteredSummary":{"inputTokens":8,"outputTokens":2,"totalRequests":4},
          "availableFilters":{"tools":[{"value":"codex","count":1}],"models":[{"value":"gpt-5","count":1}],"machines":[{"value":"macbook","count":1}]},
          "granularity":"hour"
        }
        """.trimIndent()

    private fun fixture(name: String): String {
        val resource = checkNotNull(javaClass.classLoader?.getResource("dashboard-stats-v2/$name")) {
            "Missing shared dashboard fixture: $name"
        }
        return resource.readText()
    }
}
