package com.jeidorf.tokenledger.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class DashboardQueryContractTest {
    @Test
    fun sharedMultiFilterFixtureNormalizesAsciiTrimDedupeAndUnsignedUtf8Order() {
        val fixture = JSONObject(fixture("multi-filter-search-query-v2.json"))
        val normalized = DashboardQueryContract.normalize(query(fixture.getJSONObject("input")))
        val expected = fixture.getJSONObject("normalized")

        assertEquals(expected.stringList("machines"), normalized.machines)
        assertEquals(expected.stringList("tools"), normalized.tools)
        assertEquals(expected.stringList("models"), normalized.models)
        assertEquals(expected.getString("search"), normalized.search)
        assertEquals(EFFECTIVE_TOKEN_MODE, normalized.tokenMode)
        // U+E000 sorts before U+10000 by unsigned UTF-8 bytes, unlike UTF-16 code-unit order.
        assertEquals(listOf("claude-sonnet-4", "gpt-5-codex", "\uE000", "\uD800\uDC00"), normalized.models)

        val preserved = fixture.getJSONObject("preservedWhitespaceCase")
        val preservedQuery = DashboardQueryContract.normalize(query(preserved.getJSONObject("input")))
        val preservedExpected = preserved.getJSONObject("normalized")
        assertEquals(preservedExpected.stringList("machines"), preservedQuery.machines)
        assertEquals(preservedExpected.stringList("tools"), preservedQuery.tools)
        assertEquals(preservedExpected.getString("search"), preservedQuery.search)
    }

    @Test
    fun sharedInvalidCasesRejectTheWholeQuery() {
        val invalidCases = JSONObject(fixture("multi-filter-search-query-v2.json"))
            .getJSONArray("invalidCases")
        for (index in 0 until invalidCases.length()) {
            val invalid = invalidCases.getJSONObject(index)
            assertThrows(invalid.getString("name"), DashboardQueryContractException::class.java) {
                DashboardQueryContract.normalize(query(invalid.getJSONObject("input")))
            }
        }
    }

    @Test
    fun sharedLegacyFixtureReadsSingularEchoAndRejectsConflictingDoubleWrite() {
        val fixture = JSONObject(fixture("legacy-single-query-v2.json"))
        val oldEcho = DashboardQueryContract.readEcho(fixture.getJSONObject("oldV2ResponseMetaQuery"))
        val oldExpected = fixture.getJSONObject("oldV2ResponseNormalized")

        assertEquals(oldExpected.stringList("machines"), oldEcho.machines)
        assertEquals(oldExpected.stringList("tools"), oldEcho.tools)
        assertEquals(oldExpected.stringList("models"), oldEcho.models)
        assertNull(oldEcho.search)

        val cases = fixture.getJSONArray("cases")
        val legacySentinel = DashboardQueryContract.readEcho(cases.getJSONObject(0).getJSONObject("input"))
        assertTrue(legacySentinel.machines.isEmpty())
        assertEquals(listOf("codex"), legacySentinel.tools)

        val equivalent = DashboardQueryContract.readEcho(cases.getJSONObject(1).getJSONObject("input"))
        assertEquals(listOf("mac"), equivalent.machines)
        assertEquals(listOf("claude"), equivalent.tools)

        assertThrows(DashboardQueryContractException::class.java) {
            DashboardQueryContract.readEcho(cases.getJSONObject(2).getJSONObject("input"))
        }
    }

    @Test
    fun responseEchoBindsCanonicalQueryAndEntityIdentity() {
        val fixture = JSONObject(fixture("multi-filter-search-query-v2.json"))
        val request = fixture.getJSONObject("entityRequest")
        val entityObject = request.getJSONObject("entity")
        val entity = DashboardEntity(entityObject.getString("kind"), entityObject.getString("id"))
        val query = query(request.getJSONObject("query"))
        val canonical = DashboardQueryContract.canonical(query, "Asia/Shanghai", entity)
        val raw = JSONObject()
            .put("meta", JSONObject().put("query", canonical.toJson()).put("entity", entity.toJson()))
            .toString()

        DashboardQueryContract.requireResponseEcho(raw, canonical, entity)

        assertThrows(DashboardQueryContractException::class.java) {
            DashboardQueryContract.requireResponseEcho(
                raw,
                canonical,
                DashboardEntity(DashboardEntity.MODEL, "another-model")
            )
        }
    }

    @Test
    fun gatewayProducesOnlyCanonicalPluralV2Payloads() {
        val fixture = JSONObject(fixture("multi-filter-search-query-v2.json"))
        val normalizedInput = query(fixture.getJSONObject("input"))
        val gateway = SupabaseGateway("https://example.supabase.co", "sb_publishable_test")
        val dashboardPayload = gateway.createDashboardV2Payload(
            userId = "user-1",
            query = normalizedInput,
            timezone = "Asia/Shanghai"
        )
        val canonical = dashboardPayload.getJSONObject("p_query")

        assertEquals(listOf("MacBook-Pro", "Studio-PC"), canonical.stringList("machines"))
        assertEquals(listOf("claude", "codex"), canonical.stringList("tools"))
        assertEquals("Session_42%", canonical.getString("search"))
        assertFalse(dashboardPayload.has("p_machine"))
        assertFalse(dashboardPayload.has("p_tool"))
        assertFalse(dashboardPayload.has("p_model"))

        val entityRequest = fixture.getJSONObject("entityRequest")
        val entityObject = entityRequest.getJSONObject("entity")
        val entityPayload = gateway.createEntityV2Payload(
            userId = "user-1",
            query = query(entityRequest.getJSONObject("query")),
            timezone = "Asia/Shanghai",
            entity = DashboardEntity(entityObject.getString("kind"), entityObject.getString("id"))
        )
        assertEquals("model", entityPayload.getJSONObject("p_entity").getString("kind"))
        assertEquals("gpt-5-codex", entityPayload.getJSONObject("p_entity").getString("id"))
        assertTrue(entityPayload.getJSONObject("p_query").stringList("models").isEmpty())
        assertEquals(listOf("codex"), entityPayload.getJSONObject("p_query").stringList("tools"))
    }

    @Test
    fun customRangeIsStrictAndPartOfPayloadEchoAndCacheIdentity() {
        val first = DashboardQueryContract.normalize(
            DashboardQuery(range = RangeKey.Custom, start = "2026-03-08", end = "2026-03-08")
        )
        val payload = SupabaseGateway("https://example.supabase.co", "sb_publishable_test")
            .createDashboardV2Payload("user-1", first, "America/New_York")
            .getJSONObject("p_query")
        assertEquals("custom", payload.getString("range"))
        assertEquals("2026-03-08", payload.getString("start"))
        assertEquals("2026-03-08", payload.getString("end"))

        val canonical = DashboardQueryContract.canonical(first, "America/New_York")
        DashboardQueryContract.requireResponseEcho(
            JSONObject().put("meta", JSONObject().put("query", canonical.toJson())).toString(),
            canonical
        )
        val firstKey = DashboardCacheKey.from("user-1", first, "America/New_York", null)
        val secondKey = DashboardCacheKey.from(
            "user-1",
            first.copy(start = "2026-03-09", end = "2026-03-09"),
            "America/New_York",
            null
        )
        assertFalse(firstKey.canonicalValue() == secondKey.canonicalValue())
    }

    @Test
    fun customRangeRejectsMissingInvalidFutureStartAndMoreThan731Days() {
        val today = LocalDate.of(2026, 9, 6)
        assertThrows(DashboardQueryContractException::class.java) {
            DashboardQueryContract.normalizeBounds(RangeKey.Custom, null, "2026-09-06", today)
        }
        assertThrows(DashboardQueryContractException::class.java) {
            DashboardQueryContract.normalizeBounds(RangeKey.Custom, "2026-02-30", "2026-03-01", today)
        }
        assertThrows(DashboardQueryContractException::class.java) {
            DashboardQueryContract.normalizeBounds(RangeKey.Custom, "2026-09-07", "2026-09-08", today)
        }
        assertThrows(DashboardQueryContractException::class.java) {
            DashboardQueryContract.normalizeBounds(RangeKey.Custom, "2024-09-05", "2026-09-06", today)
        }
        assertEquals(
            "2026-09-06",
            DashboardQueryContract.normalizeBounds(
                RangeKey.Custom,
                "2026-09-06",
                "2026-09-20",
                today
            ).first
        )
        val preset = DashboardQueryContract.normalize(
            DashboardQuery(range = RangeKey.Week, start = "2026-09-01", end = "2026-09-06")
        )
        assertNull(preset.start)
        assertNull(preset.end)
    }

    @Test
    fun cacheIdentityIsOrderIndependentButSearchAndEntitySensitive() {
        val first = DashboardQuery(
            range = RangeKey.Month,
            machines = listOf("studio", "mac", "studio"),
            tools = listOf("codex", "claude"),
            search = " session "
        )
        val reordered = DashboardQuery(
            range = RangeKey.Month,
            machines = listOf("mac", "studio"),
            tools = listOf("claude", "codex"),
            search = "session"
        )
        val firstKey = DashboardCacheKey.from("user", first, "UTC", entity = null)
        val reorderedKey = DashboardCacheKey.from("user", reordered, "UTC", entity = null)

        assertEquals(firstKey.canonicalValue(), reorderedKey.canonicalValue())
        assertFalse(
            firstKey.canonicalValue() == DashboardCacheKey.from(
                "user",
                reordered.copy(search = "another"),
                "UTC",
                entity = null
            ).canonicalValue()
        )
        assertFalse(
            firstKey.canonicalValue() == DashboardCacheKey.from(
                "user",
                reordered,
                "UTC",
                entity = DashboardEntity(DashboardEntity.MODEL, "gpt-5")
            ).canonicalValue()
        )
    }

    @Test
    fun cacheSnapshotRoundTripsMultiQueryEchoAndEntityIdentity() {
        val query = DashboardQuery(
            range = RangeKey.Week,
            machines = listOf("mac", "studio"),
            tools = listOf("claude", "codex"),
            search = "session"
        )
        val entity = DashboardEntity(DashboardEntity.MODEL, "gpt-5")
        val key = DashboardCacheKey.from("user", query, "Asia/Shanghai", entity)
        val stats = StatsData(
            summary = Summary(
                totalTokens = 10,
                inputTokens = 4,
                outputTokens = 6,
                cachedTokens = 0,
                totalCost = 0.1,
                totalRequests = 1,
                avgTokensPerReq = 10
            ),
            tools = emptyMap(),
            models = emptyMap(),
            trends = emptyList(),
            heatmap = emptyMap(),
            history = emptyList(),
            machines = listOf("mac", "studio"),
            meta = StatsMeta(
                generatedAt = "2026-07-15T10:00:00+08:00",
                lastRefreshedAt = null,
                timezone = "Asia/Shanghai",
                range = "week",
                machine = null,
                stale = false,
                contractVersion = 2,
                query = StatsQueryEcho(
                    range = "week",
                    timezone = "Asia/Shanghai",
                    tokenMode = EFFECTIVE_TOKEN_MODE,
                    machines = listOf("mac", "studio"),
                    tools = listOf("claude", "codex"),
                    models = emptyList(),
                    search = "session"
                ),
                entity = entity
            )
        )
        val snapshot = DashboardCachedSnapshot(stats, savedAtEpochMillis = 123L)
        val raw = DashboardSnapshotJson.encode(
            key,
            snapshot,
            DashboardCacheWriteMetadata("writer", requestId = 7L)
        )

        assertEquals(snapshot, DashboardSnapshotJson.decode(raw, key))
    }

    @Test
    fun statsReaderExposesCanonicalQueryAndMultiFilterCapabilityFromSharedFixture() {
        val stats = StatsJson.parse(fixture("complete-v2.json"))

        assertEquals(listOf("macbook-pro"), stats.meta?.query?.machines)
        assertEquals(listOf("codex"), stats.meta?.query?.tools)
        assertEquals(listOf("gpt-5"), stats.meta?.query?.models)
        assertTrue(stats.capabilities.multiFilterSearch)
    }

    private fun query(obj: JSONObject): DashboardQuery = DashboardQuery(
        range = RangeKey.entries.first { it.rpcValue == obj.optString("range", "today") },
        start = obj.optNullableString("start"),
        end = obj.optNullableString("end"),
        machines = obj.stringListOrEmpty("machines"),
        tools = obj.stringListOrEmpty("tools"),
        models = obj.stringListOrEmpty("models"),
        search = obj.optNullableString("search"),
        tokenMode = obj.optString("tokenMode", EFFECTIVE_TOKEN_MODE)
    )

    private fun fixture(name: String): String {
        val resource = checkNotNull(javaClass.classLoader?.getResource("dashboard-stats-v2/$name")) {
            "Missing shared dashboard fixture: $name"
        }
        return resource.readText()
    }
}

private fun JSONObject.stringListOrEmpty(key: String): List<String> =
    optJSONArray(key)?.toStringList() ?: emptyList()

private fun JSONObject.stringList(key: String): List<String> =
    getJSONArray(key).toStringList()

private fun JSONArray.toStringList(): List<String> =
    List(length()) { index -> getString(index) }
