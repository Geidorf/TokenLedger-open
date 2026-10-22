package com.jeidorf.tokenledger.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CompositionAvailabilityTest {
    @Test
    fun missingInputAndOutputRemainUnavailableWithoutFallingBackToTokens() {
        val entity = StatsJson.parseEntityDashboard(
            entityJson(
                machine = """
                    {"value":"device-a","tokens":431000,"requests":1,"cost":0}
                """.trimIndent()
            )
        )

        assertNull(entity.composition.machines.single().effectiveTokens)
    }

    @Test
    fun explicitZeroInputAndOutputRemainARealZero() {
        val entity = StatsJson.parseEntityDashboard(
            entityJson(
                machine = """
                    {"value":"device-a","tokens":0,"inputTokens":0,"outputTokens":0,"cachedTokens":0,"requests":0,"cost":0}
                """.trimIndent()
            )
        )

        assertEquals(0L, entity.composition.machines.single().effectiveTokens)
        val reparsed = StatsJson.parseEntityDashboard(StatsJson.entityDashboardToJson(entity).toString())
        assertEquals(0L, reparsed.composition.machines.single().effectiveTokens)
    }

    @Test
    fun nullNegativeAndPartialBreakdownsRemainUnavailable() {
        val unavailableRows = listOf(
            """{"value":"null","tokens":9,"inputTokens":null,"outputTokens":0}""",
            """{"value":"negative","tokens":9,"inputTokens":-1,"outputTokens":10}""",
            """{"value":"partial","tokens":9,"inputTokens":9}"""
        )

        unavailableRows.forEach { machine ->
            val entry = StatsJson.parseEntityDashboard(entityJson(machine)).composition.machines.single()
            assertNull(entry.value, entry.effectiveTokens)
        }
    }

    @Test
    fun cacheRoundTripPreservesUnavailableBreakdown() {
        val parsed = StatsJson.parseEntityDashboard(
            entityJson("""{"value":"device-a","tokens":431000,"requests":1,"cost":0}""")
        )

        val reparsed = StatsJson.parseEntityDashboard(StatsJson.entityDashboardToJson(parsed).toString())

        assertNull(reparsed.composition.machines.single().effectiveTokens)
    }

    private fun entityJson(machine: String): String =
        """
        {
          "entity":{"kind":"model","tool":null,"model":"claude-fable-5-1"},
          "summary":{"inputTokens":400000,"outputTokens":31000,"totalRequests":1},
          "composition":{"tools":[],"models":[],"machines":[$machine]},
          "heatmap":{},
          "peak":{},
          "activity":{},
          "historyPage":{"items":[],"nextCursor":null,"hasMore":false,"totalCount":0,"filteredSummary":{},"availableFilters":{}},
          "granularity":"hour"
        }
        """.trimIndent()
}
