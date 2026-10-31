package com.jeidorf.tokenledger.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class StatsJsonTest {
    @Test
    fun rejectsMissingNullAndWrongCoreContainers() {
        listOf("tools", "models", "trends", "heatmap", "history").forEach { key ->
            listOf<Any?>(null, JSONObject.NULL, "invalid", 42, true).forEach { invalid ->
                val root = JSONObject(fixture("complete-v2.json"))
                if (invalid == null) root.remove(key) else root.put(key, invalid)
                assertThrows("$key=$invalid", IllegalArgumentException::class.java) {
                    StatsJson.parse(root.toString())
                }
            }
            val root = JSONObject(fixture("complete-v2.json"))
            root.put(key, if (key in listOf("trends", "history")) JSONObject() else JSONArray())
            assertThrows(IllegalArgumentException::class.java) { StatsJson.parse(root.toString()) }
        }
    }

    @Test
    fun rejectsInvalidCoreChildNumbers() {
        val root = JSONObject(fixture("legacy-v1.json"))
        val item = JSONObject("""{"input":1,"output":2,"cached":0,"total":3,"requests":1,"cost":0}""")
        listOf("input", "output", "cached", "total", "requests").forEach { key ->
            listOf<Any?>(null, JSONObject.NULL, "NaN", "Infinity", -1).forEach { invalid ->
                val tool = JSONObject(item.toString())
                if (invalid == null) tool.remove(key) else tool.put(key, invalid)
                root.put("tools", JSONObject().put("tool", tool))
                assertThrows(IllegalArgumentException::class.java) { StatsJson.parse(root.toString()) }
            }
        }
        root.put("tools", JSONObject())
        listOf("models", "trends", "heatmap", "history").forEach { key ->
            val bad = when (key) {
                "models" -> "{\"m\":{\"total\":1e999,\"requests\":1}}"
                "trends" -> "[{\"date\":\"10:00\",\"tool\":1e999}]"
                "heatmap" -> "{\"2026-01-01\":1e999}"
                else -> "[{\"id\":1,\"inputTokens\":1e999,\"outputTokens\":0,\"cachedTokens\":0,\"cost\":0}]"
            }
            val raw = root.toString().replace("\"$key\":" + root.get(key).toString(), "\"$key\":$bad")
            assertThrows(IllegalArgumentException::class.java) { StatsJson.parse(raw) }
        }
    }

    @Test
    fun cacheSplitsRequireBothSidesAndExactNonNegativeTotal() {
        listOf("tools", "models").forEach { key ->
            listOf("80,\"cacheWrite\":10", "-1,\"cacheWrite\":101", "9223372036854775807,\"cacheWrite\":1").forEach { split ->
                val root = JSONObject(fixture("legacy-v1.json"))
                root.put(key, JSONObject("""{"x":{"input":1,"output":0,"cached":100,"total":1,"requests":1,"cost":0,"cacheRead":$split}}"""))
                val stats = StatsJson.parse(root.toString())
                assertNull(if (key == "tools") stats.tools.getValue("x").cacheRead else stats.models.getValue("x").cacheRead)
                assertNull(if (key == "tools") stats.tools.getValue("x").cacheWrite else stats.models.getValue("x").cacheWrite)
            }
        }
    }

    @Test
    fun toolUnknownCostsStayNullAndDisplayUnavailable() {
        listOf<Any?>(null, JSONObject.NULL, "NaN", "Infinity", -1).forEach { cost ->
            val root = JSONObject(fixture("legacy-v1.json"))
            val item = JSONObject("""{"input":1,"output":0,"cached":0,"total":1,"requests":1}""")
            if (cost != null) item.put("cost", cost)
            root.put("tools", JSONObject().put("tool", item))
            val tool = StatsJson.parse(root.toString()).tools.getValue("tool")
            assertNull(tool.cost)
            assertEquals(VALUE_UNAVAILABLE, CurrencyUnit.USD.format(tool.cost))
            assertNull(CompositionEntry("tool", 1).toToolStat().cost)
        }
        assertEquals(0.0, CompositionEntry("free", 1, cost = 0.0).toToolStat().cost)
    }

    @Test
    fun parsesStatsWithoutMeta() {
        val stats = StatsJson.parse(
            """
            {
              "summary": {
                "totalTokens": 10,
                "inputTokens": 4,
                "outputTokens": 6,
                "cachedTokens": 0,
                "totalCost": 0.0123,
                "totalRequests": 2,
                "avgTokensPerReq": 5
              },
              "tools": {},
              "models": {},
              "trends": [],
              "heatmap": {},
              "history": [],
              "machines": []
            }
            """.trimIndent()
        )

        assertEquals(10, stats.summary.totalTokens)
        assertEquals(null, stats.meta)
    }

    @Test
    fun parsesFullStats() {
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 12, "inputTokens": 3, "outputTokens": 4, "cachedTokens": 5, "totalCost": 1.5, "totalRequests": 2, "avgTokensPerReq": 6},
              "tools": {"codex": {"name": "codex", "input": 3, "output": 4, "cached": 5, "total": 7, "cost": 1.5, "requests": 2, "models": {"gpt-5": 7}, "heatmap": {"2026-06-11": 7}}},
              "models": {"gpt-5": {"name": "gpt-5", "total": 7, "requests": 2}},
              "trends": [{"date": "10:00", "codex": 7}],
              "heatmap": {"2026-06-11": 7},
              "history": [{"id": 1, "tool": "codex", "model": "gpt-5", "inputTokens": 3, "outputTokens": 4, "cachedTokens": 0, "cost": 1.5, "timestamp": "2026-06-11 10:00:00", "sessionId": "s", "machineId": "m"}],
              "machines": ["m"],
              "meta": {"generatedAt": "now", "lastRefreshedAt": null, "timezone": "Asia/Shanghai", "range": "today", "machine": null, "stale": false}
            }
            """.trimIndent()
        )

        assertEquals(7, stats.tools.getValue("codex").total)
        assertEquals("Asia/Shanghai", stats.meta?.timezone)
        assertFalse(stats.meta?.stale ?: true)
    }

    @Test
    fun parsesTrendRequestsReservedKey() {
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 0, "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "totalCost": 0, "totalRequests": 0, "avgTokensPerReq": 0},
              "tools": {},
              "models": {},
              "trends": [
                {"date": "10:00", "codex": 7, "__requests": 3},
                {"date": "11:00", "claude": 5}
              ],
              "heatmap": {},
              "history": [],
              "machines": []
            }
            """.trimIndent()
        )

        // __requests 是保留键：进入 requests 字段，不混入工具序列。
        assertEquals(3, stats.trends[0].requests)
        assertEquals(mapOf("codex" to 7L), stats.trends[0].values)
        // 旧版 RPC 没有该键时回退为 0。
        assertEquals(0, stats.trends[1].requests)
        assertEquals(mapOf("claude" to 5L), stats.trends[1].values)
        assertFalse(stats.legacyRpc)
    }

    @Test
    fun computesEffectiveTokensAndCacheSplit() {
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 24, "inputTokens": 10, "outputTokens": 14, "cachedTokens": 100, "cacheReadTokens": 90, "cacheWriteTokens": 10, "cacheSavedUsd": 0.42, "totalCost": 1.5, "totalRequests": 3, "avgTokensPerReq": 8},
              "tools": {"claude": {"name": "claude", "input": 10, "output": 14, "cached": 100, "cacheRead": 90, "cacheWrite": 10, "total": 24, "cost": 1.5, "requests": 3}},
              "models": {},
              "trends": [],
              "heatmap": {},
              "history": [{"id": 1, "tool": "claude", "model": "fable", "inputTokens": 10, "outputTokens": 14, "cachedTokens": 100, "cacheWriteTokens": 10, "cost": 1.5, "timestamp": "2026-06-13 10:00:00", "sessionId": "s", "machineId": "m"}],
              "machines": []
            }
            """.trimIndent()
        )

        // 有效 Token = 输入 + 输出，与桌面端口径一致。
        assertEquals(24, stats.summary.effectiveTokens)
        assertEquals(90, stats.summary.cacheReadTokens)
        assertEquals(10, stats.summary.cacheWriteTokens)
        assertEquals(0.42, requireNotNull(stats.summary.cacheSavedUsd), 1e-9)
        assertEquals(24, stats.tools.getValue("claude").effectiveTokens)
        assertEquals(10L, requireNotNull(stats.tools.getValue("claude").cacheWrite))
        assertEquals(24, stats.history[0].effectiveTokens)
        assertEquals(10, stats.history[0].cacheWriteTokens)
    }

    @Test
    fun cacheFieldsStayUnknownOnLegacyRpc() {
        // 旧版云端 RPC 不返回缓存拆分字段，必须保留未知，effectiveTokens 仍可算。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 999, "inputTokens": 10, "outputTokens": 14, "cachedTokens": 100, "totalCost": 1.5, "totalRequests": 3, "avgTokensPerReq": 8},
              "tools": {"legacy": {"name": "legacy", "input": 10, "output": 14, "cached": 100, "total": 24, "cost": 1.5, "requests": 3}},
              "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        assertEquals(0, stats.summary.cacheReadTokens)
        assertEquals(0, stats.summary.cacheWriteTokens)
        assertFalse(stats.summary.cacheSplitKnown)
        assertNull(stats.tools.getValue("legacy").cacheRead)
        assertNull(stats.tools.getValue("legacy").cacheWrite)
        // T10.184：缺失的缓存节省必须解析为 null（不可得），不得回退到 0（GLB-01，修 D2 的解析侧对称）。
        assertNull(stats.summary.cacheSavedUsd)
        assertNull(stats.summary.cacheSavings)
        // 即使云端 totalTokens 仍是旧口径（含缓存），客户端有效口径不受影响。
        assertEquals(24, stats.summary.effectiveTokens)
    }

    @Test
    fun optionalCacheSplitsRejectFractionsOverflowAndInconsistentTotals() {
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 10, "inputTokens": 10, "outputTokens": 0, "cachedTokens": 100, "cacheReadTokens": 80.9, "cacheWriteTokens": 19.1, "totalCost": 0, "totalRequests": 1, "avgTokensPerReq": 10},
              "tools": {},
              "models": {
                "fractional": {"name": "fractional", "total": 10, "requests": 1, "input": 10, "output": 0, "cached": 100, "cacheRead": 80.9, "cacheWrite": 19.1},
                "overflow": {"name": "overflow", "total": 10, "requests": 1, "input": 10, "output": 0, "cached": 1, "cacheRead": 9223372036854775808, "cacheWrite": 0},
                "inconsistent": {"name": "inconsistent", "total": 10, "requests": 1, "input": 10, "output": 0, "cached": 100, "cacheRead": 80, "cacheWrite": 10}
              },
              "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        assertFalse(stats.summary.cacheSplitKnown)
        assertNull(stats.models.getValue("fractional").cacheRead)
        assertNull(stats.models.getValue("fractional").cacheWrite)
        assertNull(stats.models.getValue("overflow").cacheRead)
        assertFalse(modelCacheBreakdown(stats.models.getValue("inconsistent")).hasReadWriteSplit)
    }

    @Test
    fun rejectsMissingRequiredCoreSummaryFields() {
        assertThrows(IllegalArgumentException::class.java) {
            StatsJson.parse(
                """
                {
                  "summary": {"totalTokens": 3, "inputTokens": 1, "outputTokens": 2},
                  "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": []
                }
                """.trimIndent()
            )
        }
    }

    @Test
    fun effectiveTokensNeverFallsBackToTotalsWhenInputAndOutputAreZero() {
        // 四端铁律：有效 Token 恒等于 输入+输出。旧版脏数据可能出现 tokens/total>0
        // 但 input/output 均为 0（例如缓存专属批次或字段缺失）；此时有效值必须是 0，
        // 不得像历史 Bug 那样回退到 tokens/total，否则会与 Rust/Supabase/Web 三端分叉。
        val dirtyComposition = CompositionEntry(
            value = "legacy-tool",
            tokens = 500,
            inputTokens = 0,
            outputTokens = 0,
            cachedTokens = 20,
            cacheWriteTokens = 5,
            requests = 3,
            cost = 1.1
        )
        assertEquals(0L, dirtyComposition.effectiveTokens)

        val healthyComposition = CompositionEntry(
            value = "healthy-tool",
            tokens = 500,
            inputTokens = 200,
            outputTokens = 300,
            requests = 3,
            cost = 1.1
        )
        assertEquals(500L, healthyComposition.effectiveTokens)

        val dirtyModel = ModelStat(
            name = "legacy-model",
            total = 777,
            requests = 4,
            input = 0,
            output = 0,
            cached = 10,
            cost = 0.5
        )
        assertEquals(0L, dirtyModel.effectiveTokens)

        val healthyModel = ModelStat(
            name = "healthy-model",
            total = 777,
            requests = 4,
            input = 300,
            output = 477,
            cost = 0.5
        )
        assertEquals(777L, healthyModel.effectiveTokens)
    }

    @Test
    fun parsesSharedDailyCostsFixturesWithoutCopyingJson() {
        val available = StatsJson.parse(fixture("daily-costs-v2.json"))
        val unavailable = StatsJson.parse(fixture("daily-costs-unavailable-v2.json"))

        assertEquals(DailyCostsCoverageState.Complete, available.dailyCosts?.coverage?.state)
        assertEquals("2026-07-01", available.dailyCosts?.coverage?.start)
        assertEquals(0.42, available.dailyCosts?.days?.first()?.amountUsd ?: 0.0, 1e-9)
        assertEquals(DailyCostStatus.RecordedEstimate, available.dailyCosts?.days?.first()?.status)
        assertNull(available.dailyCosts?.days?.first()?.reason)
        assertEquals(
            listOf(
                DailyCostUnavailableReason.MissingCost,
                DailyCostUnavailableReason.InvalidCost,
                DailyCostUnavailableReason.LegacyZero,
                null
            ),
            unavailable.dailyCosts?.days?.map { it.reason }
        )
    }

    @Test
    fun oldMissingOrNullDailyCostsRemainsUsableAsUnavailableCapability() {
        val missing = JSONObject(fixture("daily-costs-v2.json")).apply { remove("dailyCosts") }
        val explicitNull = JSONObject(fixture("daily-costs-v2.json")).put("dailyCosts", JSONObject.NULL)

        assertEquals(900L, StatsJson.parse(missing.toString()).summary.totalTokens)
        assertNull(StatsJson.parse(missing.toString()).dailyCosts)
        assertNull(StatsJson.parse(explicitNull.toString()).dailyCosts)
    }

    @Test
    fun invalidDailyCostsShapeOrDiscriminatedAmountsDropsOnlyExtension() {
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { it.put("dailyCosts", JSONArray()) },
            { it.getJSONObject("dailyCosts").put("coverage", JSONArray()) },
            { it.getJSONObject("dailyCosts").put("days", JSONObject()) },
            { it.dailyCoverage().remove("start") },
            { it.dailyCoverage().put("start", 20260701) },
            { it.dailyCoverage().remove("end") },
            { it.dailyCoverage().put("state", "unknown") },
            { it.dailyCoverage().put("timezone", "Not/AZone") },
            { it.dailyCoverage().put("start", "2026-02-30") },
            { it.dailyDays().getJSONObject(0).put("date", "2026-02-30") },
            { it.dailyDays().getJSONObject(0).put("amountUsd", "0.42") },
            { it.dailyDays().getJSONObject(0).put("amountUsd", 0) },
            { it.dailyDays().getJSONObject(0).put("amountUsd", -0.1) },
            { it.dailyDays().getJSONObject(0).remove("amountUsd") },
            { it.dailyDays().getJSONObject(0).put("reason", JSONObject.NULL) },
            { it.dailyDays().getJSONObject(0).put("status", "unknown") },
            {
                it.dailyDays().getJSONObject(0)
                    .put("status", "unavailable")
                    .put("amountUsd", 0.42)
                    .put("reason", "missing-cost")
            },
            {
                it.dailyDays().getJSONObject(0)
                    .put("status", "unavailable")
                    .put("amountUsd", JSONObject.NULL)
                    .put("reason", "unknown")
            }
        )

        mutations.forEach(::assertDailyCostsRejected)

        val nonFiniteNumber = fixture("daily-costs-v2.json")
            .replace("\"amountUsd\": 0.42", "\"amountUsd\": 1e309")
        val nonFiniteStats = StatsJson.parse(nonFiniteNumber)
        assertEquals(900L, nonFiniteStats.summary.totalTokens)
        assertNull(nonFiniteStats.dailyCosts)
    }

    @Test
    fun duplicateUnorderedOrOutOfCoverageDaysRejectWholeExtension() {
        assertDailyCostsRejected { root ->
            root.dailyDays().put(JSONObject(root.dailyDays().getJSONObject(1).toString()))
        }
        assertDailyCostsRejected { root ->
            val days = root.dailyDays()
            root.getJSONObject("dailyCosts").put(
                "days",
                JSONArray().put(days.getJSONObject(1)).put(days.getJSONObject(0))
            )
        }
        assertDailyCostsRejected { root ->
            root.dailyDays().getJSONObject(0).put("date", "2026-06-30")
        }
    }

    @Test
    fun partialCoverageAllowsOnlyIncompleteCoverageUnavailableRows() {
        val valid = JSONObject(fixture("daily-costs-v2.json")).apply {
            dailyCoverage().put("state", "partial")
            getJSONObject("dailyCosts").put(
                "days",
                JSONArray().put(
                    JSONObject()
                        .put("date", "2026-07-14")
                        .put("amountUsd", JSONObject.NULL)
                        .put("status", "unavailable")
                        .put("reason", "incomplete-coverage")
                )
            )
        }
        assertEquals(DailyCostsCoverageState.Partial, StatsJson.parse(valid.toString()).dailyCosts?.coverage?.state)

        assertDailyCostsRejected { it.dailyCoverage().put("state", "partial") }
        assertDailyCostsRejected {
            it.dailyCoverage().put("state", "partial")
            it.dailyDays().getJSONObject(0)
                .put("status", "unavailable")
                .put("amountUsd", JSONObject.NULL)
                .put("reason", "missing-cost")
        }
    }

    @Test
    fun coverageMustMatchRangeAndTrustedCutoffAcrossAllRanges() {
        val cases = listOf(
            Triple("today", "2026-07-15", "2026-07-15"),
            Triple("week", "2026-07-13", "2026-07-15"),
            Triple("month", "2026-07-01", "2026-07-15"),
            Triple("year", "2026-01-01", "2026-07-15")
        )
        cases.forEach { (range, start, end) ->
            val root = dailyFixtureForRange(range, start, end)
            assertNotNull("range=$range", StatsJson.parse(root.toString()).dailyCosts)
        }

        val custom = dailyFixtureForRange("custom", "2026-07-10", "2026-07-15").apply {
            metaQuery().put("start", "2026-07-10").put("end", "2026-07-20")
        }
        assertNotNull(StatsJson.parse(custom.toString()).dailyCosts)

        val all = dailyFixtureForRange("all", null, "2026-07-15")
        assertTrue(all.dailyCoverage().isNull("start"))
        assertNotNull(StatsJson.parse(all.toString()).dailyCosts)

        assertDailyCostsRejected { it.dailyCoverage().put("start", JSONObject.NULL) }
        assertDailyCostsRejected { it.dailyCoverage().put("end", "2026-07-14") }
        assertDailyCostsRejected {
            it.getJSONObject("meta").put("timezone", "UTC")
        }
        assertDailyCostsRejected {
            it.metaQuery().put("timezone", "UTC")
        }
        assertDailyCostsRejected { it.remove("meta") }
        assertDailyCostsRejected { it.getJSONObject("meta").remove("query") }
        assertDailyCostsRejected { it.getJSONObject("meta").remove("generatedAt") }
        val invalidAllStart = dailyFixtureForRange("all", "2026-01-01", "2026-07-15")
        assertNull(StatsJson.parse(invalidAllStart.toString()).dailyCosts)
    }

    @Test
    fun redundantMetaRangeAndPresetBoundsDoNotInvalidateCanonicalQuery() {
        val root = JSONObject(fixture("daily-costs-v2.json")).apply {
            getJSONObject("meta").remove("range")
            metaQuery().put("start", "2020-01-01").put("end", "2030-01-01")
        }

        val stats = StatsJson.parse(root.toString())
        assertNotNull(stats.dailyCosts)
        assertNull(stats.meta?.range)
        assertNull(stats.meta?.query?.start)
        assertNull(stats.meta?.query?.end)
    }

    @Test
    fun futureOnlyCustomRangeIsRejectedWhenExpectedStartExceedsCutoff() {
        val root = dailyFixtureForRange("custom", "2026-07-16", "2026-07-15").apply {
            metaQuery().put("start", "2026-07-16").put("end", "2026-07-20")
        }

        assertNull(StatsJson.parse(root.toString()).dailyCosts)
    }

    @Test
    fun cutoffRequiresStrictTimestampButAcceptsFractionalLocalTime() {
        listOf(
            "2026-07-15",
            "2026-02-30T09:30:00",
            "2026-07-15T25:00:00",
            "2026-07-15 09:60:00"
        ).forEach { cutoff ->
            assertDailyCostsRejected { it.getJSONObject("meta").put("generatedAt", cutoff) }
        }

        val fractional = JSONObject(fixture("daily-costs-v2.json")).apply {
            getJSONObject("meta").put("generatedAt", "2026-07-15 09:30:00.123456")
        }
        assertNotNull(StatsJson.parse(fractional.toString()).dailyCosts)

        assertDailyCostsRejected {
            it.dailyDays().getJSONObject(0).put("date", "+10000-07-14")
        }
    }

    @Test
    fun offsetCutoffConvertsIntoDeclaredTimezoneAcrossNewYorkDst() {
        val root = dailyFixtureForRange("week", "2026-03-02", "2026-03-08").apply {
            getJSONObject("meta")
                .put("generatedAt", "2026-03-09T03:30:00Z")
                .put("timezone", "America/New_York")
            metaQuery().put("timezone", "America/New_York")
            dailyCoverage().put("timezone", "America/New_York")
        }

        val coverage = StatsJson.parse(root.toString()).dailyCosts?.coverage
        assertEquals("2026-03-02", coverage?.start)
        assertEquals("2026-03-08", coverage?.end)
    }

    @Test
    fun comparisonCutoffTakesPriorityAndItsTimezoneMustAgree() {
        val valid = JSONObject(fixture("daily-costs-v2.json")).apply {
            dailyCoverage().put("end", "2026-07-14")
            getJSONObject("dailyCosts").put(
                "days",
                JSONArray().put(dailyDays().getJSONObject(0))
            )
            put("comparison", comparison("Asia/Shanghai", "2026-07-14T23:00:00+08:00"))
        }
        assertEquals("2026-07-14", StatsJson.parse(valid.toString()).dailyCosts?.coverage?.end)

        assertDailyCostsRejected {
            it.put("comparison", comparison("UTC", "2026-07-14T23:00:00+08:00"))
        }
        assertDailyCostsRejected {
            it.put("comparison", comparison("Asia/Shanghai", "not-a-time"))
        }
    }

    @Test
    fun incompleteComparisonStillValidatesRawWindowMetadata() {
        listOf(
            JSONObject().put("timezone", "UTC").put("currentEnd", "2026-07-16T00:00:00Z"),
            JSONObject().put("timezone", "Asia/Shanghai").put("currentEnd", "not-a-time"),
            JSONObject().put("timezone", "Asia/Shanghai").put("currentEnd", 123),
            JSONObject().put("timezone", JSONObject.NULL)
        ).forEach { window ->
            assertDailyCostsRejected { it.put("comparison", JSONObject().put("window", window)) }
        }
    }

    @Test
    fun missingComparisonWindowMetadataStillFallsBackToGeneratedAt() {
        listOf(
            null,
            JSONObject(),
            JSONObject().put("window", JSONObject()),
            JSONObject().put("window", JSONObject().put("currentEnd", JSONObject.NULL))
        ).forEach { comparison ->
            val root = JSONObject(fixture("daily-costs-v2.json")).apply {
                remove("comparison")
                if (comparison != null) put("comparison", comparison)
            }
            val stats = StatsJson.parse(root.toString())
            assertEquals(900L, stats.summary.totalTokens)
            assertNotNull(stats.dailyCosts)
            assertEquals("2026-07-15", stats.dailyCosts?.coverage?.end)
        }
    }

    @Test
    fun incompleteComparisonStillPrioritizesValidWindowCutoff() {
        val root = JSONObject(fixture("daily-costs-v2.json")).apply {
            dailyCoverage().put("end", "2026-07-14")
            getJSONObject("dailyCosts").put("days", JSONArray().put(dailyDays().getJSONObject(0)))
            put("comparison", JSONObject().put("window", JSONObject()
                .put("timezone", "Asia/Shanghai")
                .put("currentEnd", "2026-07-14T23:00:00+08:00")))
        }
        val stats = StatsJson.parse(root.toString())
        assertNull(stats.comparison)
        assertEquals(900L, stats.summary.totalTokens)
        assertEquals("2026-07-14", stats.dailyCosts?.coverage?.end)
    }

    @Test
    fun unknownAdditionalDailyCostsKeysAreIgnored() {
        val root = JSONObject(fixture("daily-costs-v2.json")).apply {
            getJSONObject("dailyCosts").put("futureField", JSONObject().put("x", 1))
            dailyCoverage().put("futureCoverage", true)
            dailyDays().getJSONObject(0).put("futureDay", "kept-compatible")
        }

        assertEquals(2, StatsJson.parse(root.toString()).dailyCosts?.days?.size)
    }

    private fun assertDailyCostsRejected(mutate: (JSONObject) -> Unit) {
        val root = JSONObject(fixture("daily-costs-v2.json"))
        mutate(root)
        val stats = StatsJson.parse(root.toString())
        assertEquals(900L, stats.summary.totalTokens)
        assertNull(stats.dailyCosts)
    }

    private fun dailyFixtureForRange(
        range: String,
        start: String?,
        end: String
    ): JSONObject = JSONObject(fixture("daily-costs-v2.json")).apply {
        getJSONObject("meta").put("range", range)
        metaQuery().apply {
            put("range", range)
            remove("start")
            remove("end")
        }
        dailyCoverage().put("start", start ?: JSONObject.NULL).put("end", end)
        getJSONObject("dailyCosts").put("days", JSONArray())
    }

    private fun comparison(timezone: String, currentEnd: String): JSONObject = JSONObject()
        .put("window", JSONObject()
            .put("kind", "monthOverMonth")
            .put("timezone", timezone)
            .put("bucket", "day")
            .put("currentEnd", currentEnd))
        .put("current", JSONObject().put("summary", JSONObject()).put("series", JSONArray()))
        .put("previous", JSONObject().put("summary", JSONObject()).put("series", JSONArray()))
        .put("delta", JSONObject())

    private fun JSONObject.dailyCoverage(): JSONObject =
        getJSONObject("dailyCosts").getJSONObject("coverage")

    private fun JSONObject.dailyDays(): JSONArray = getJSONObject("dailyCosts").getJSONArray("days")

    private fun JSONObject.metaQuery(): JSONObject = getJSONObject("meta").getJSONObject("query")

    private fun fixture(name: String): String {
        val resource = checkNotNull(javaClass.classLoader?.getResource("dashboard-stats-v2/$name")) {
            "Missing shared dashboard fixture: $name"
        }
        return resource.readText()
    }
}
