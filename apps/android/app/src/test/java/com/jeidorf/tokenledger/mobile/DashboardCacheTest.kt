package com.jeidorf.tokenledger.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DashboardCacheTest {
    @Test
    fun snapshotJsonRoundTripsEveryCurrentDtoField() {
        val key = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Week,
            machine = "macbook|studio",
            timezoneId = "Asia/Shanghai",
            tool = "codex",
            model = "gpt-5"
        )
        val stats = completeStats()
        val snapshot = DashboardCachedSnapshot(stats, savedAtEpochMillis = 1_750_000_000_000L)
        val writeMetadata = DashboardCacheWriteMetadata("process-1", requestId = 42L)

        val decoded = DashboardSnapshotJson.decode(
            DashboardSnapshotJson.encode(key, snapshot, writeMetadata),
            key
        )

        assertEquals(snapshot, decoded)
        assertEquals(
            writeMetadata,
            DashboardSnapshotJson.writeMetadata(
                DashboardSnapshotJson.encode(key, snapshot, writeMetadata)
            )
        )
        assertTrue(key.canonicalValue().contains("14:macbook|studio"))
    }

    @Test
    fun snapshotWithoutWriteMetadataRemainsReadableAcrossTheUpgrade() {
        val key = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Today,
            machine = DashboardQuery.ALL_MACHINES,
            timezoneId = "Asia/Shanghai"
        )
        val snapshot = DashboardCachedSnapshot(completeStats(), savedAtEpochMillis = 123L)
        val legacyRoot = JSONObject(
            DashboardSnapshotJson.encode(
                key,
                snapshot,
                DashboardCacheWriteMetadata("process-1", requestId = 1L)
            )
        ).apply {
            remove("writerId")
            remove("requestId")
        }
        val legacyRaw = legacyRoot.toString()

        assertEquals(snapshot, DashboardSnapshotJson.decode(legacyRaw, key))
        assertNull(DashboardSnapshotJson.writeMetadata(legacyRaw))
    }

    @Test
    fun schemaV2SnapshotIsRejectedBecauseItCouldHaveCollapsedUnknownCostToZero() {
        val key = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Month,
            machine = DashboardQuery.ALL_MACHINES,
            timezoneId = "UTC"
        )
        val raw = JSONObject(
            DashboardSnapshotJson.encode(
                key,
                DashboardCachedSnapshot(completeStats(), savedAtEpochMillis = 123L),
                DashboardCacheWriteMetadata("process-1", requestId = 1L)
            )
        ).put("schemaVersion", 2).toString()

        assertEquals(4, CACHE_SCHEMA_VERSION)
        assertNull(DashboardSnapshotJson.decode(raw, key))
    }

    @Test
    fun mainBoardUnknownGrossCacheSavingsIsNeverWrittenIntoTheCacheAsANumber() {
        // root R-36 P3-4：独立评审的故障注入（DashboardCache.kt 把 null 毛值写成 0.0）此前
        // 只被一条无关的整体相等断言（snapshotJsonRoundTripsEveryCurrentDtoField）偶然检出；
        // 这里直接针对主看板 summary 写一条断言，不依赖那条测试夹具的巧合细节：编码后的原始
        // JSON 里，主看板 summary 必须完全没有 cacheSavedUsd 这个键（不是数字 0.0，也不是
        // JSON null），解码回来必须仍是 null。
        val key = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Month,
            machine = DashboardQuery.ALL_MACHINES,
            timezoneId = "UTC"
        )
        val stats = completeStats().copy(summary = completeStats().summary.copy(cacheSavedUsd = null))
        val snapshot = DashboardCachedSnapshot(stats, savedAtEpochMillis = 123L)

        val encoded = DashboardSnapshotJson.encode(
            key,
            snapshot,
            DashboardCacheWriteMetadata("process-1", requestId = 1L)
        )
        val encodedSummary = JSONObject(encoded).getJSONObject("stats").getJSONObject("summary")

        assertTrue(!encodedSummary.has("cacheSavedUsd"))
        assertNull(requireNotNull(DashboardSnapshotJson.decode(encoded, key)).stats.summary.cacheSavedUsd)
    }

    @Test
    fun snapshotRoundTripKeepsUnknownModelCostDistinctFromRealZero() {
        val key = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Month,
            machine = DashboardQuery.ALL_MACHINES,
            timezoneId = "UTC"
        )
        val stats = completeStats().copy(
            summary = completeStats().summary.copy(
                cacheReadTokens = 0,
                cacheWriteTokens = 0,
                cacheSplitKnown = false,
                // 拆分不再成立时 cacheSavings 也必须一并清空：写入侧只在 cacheSplitKnown
                // 时才会序列化该对象，留着旧值会造出「拆分未证明却带对象」这个解析侧一定
                // 丢弃的形状，导致编码-解码往返对不上号（而不是真的回归）。
                cacheSavings = null
            ),
            models = mapOf(
                "unknown" to ModelStat("unknown", 10, 1, input = 10, cost = null),
                "free" to ModelStat("free", 20, 1, input = 20, cost = 0.0)
            ),
            tools = mapOf(
                "unknown-tool" to ToolStat(
                    name = "unknown-tool",
                    input = 10,
                    output = 0,
                    cached = 5,
                    total = 10,
                    cost = 0.0,
                    requests = 1,
                    cacheRead = null,
                    cacheWrite = null
                )
            )
        )
        val snapshot = DashboardCachedSnapshot(stats, savedAtEpochMillis = 123L)

        val decoded = requireNotNull(
            DashboardSnapshotJson.decode(
                DashboardSnapshotJson.encode(
                    key,
                    snapshot,
                    DashboardCacheWriteMetadata("process-1", requestId = 1L)
                ),
                key
            )
        )

        assertTrue(!decoded.stats.summary.cacheSplitKnown)
        assertNull(decoded.stats.models.getValue("unknown").cost)
        assertNull(decoded.stats.models.getValue("unknown").cacheRead)
        assertNull(decoded.stats.models.getValue("unknown").cacheWrite)
        assertEquals(0.0, decoded.stats.models.getValue("free").cost)
        assertNull(decoded.stats.tools.getValue("unknown-tool").cacheRead)
        assertNull(decoded.stats.tools.getValue("unknown-tool").cacheWrite)
    }

    @Test
    fun snapshotJsonRejectsAnotherTimezoneOrQuery() {
        val key = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Today,
            machine = DashboardQuery.ALL_MACHINES,
            timezoneId = "Asia/Shanghai"
        )
        val raw = DashboardSnapshotJson.encode(
            key,
            DashboardCachedSnapshot(completeStats(), savedAtEpochMillis = 123L),
            DashboardCacheWriteMetadata("process-1", requestId = 1L)
        )

        assertNull(
            DashboardSnapshotJson.decode(
                raw,
                key.copy(timezoneId = "America/Los_Angeles")
            )
        )
        assertNull(DashboardSnapshotJson.decode(raw, key.copy(range = RangeKey.Month)))
    }

    @Test
    fun entityCacheIdentityIgnoresLegacyCompatibilitySelectorEcho() {
        val entity = DashboardEntity(DashboardEntity.TOOL, "codex")
        val seededKey = DashboardCacheKey.from(
            userId = "user-1",
            query = DashboardQuery(),
            timezoneId = "Asia/Shanghai",
            entity = entity
        )
        val runtimeKey = DashboardCacheKey.from(
            userId = "user-1",
            query = DashboardQuery(compatibilityToolSelector = "codex"),
            timezoneId = "Asia/Shanghai",
            entity = entity
        )
        val snapshot = DashboardCachedSnapshot(completeStats(), savedAtEpochMillis = 123L)
        val raw = DashboardSnapshotJson.encode(
            seededKey,
            snapshot,
            DashboardCacheWriteMetadata("process-1", requestId = 1L)
        )

        assertEquals(seededKey.canonicalValue(), runtimeKey.canonicalValue())
        assertEquals(snapshot, DashboardSnapshotJson.decode(raw, runtimeKey))
        assertNull(
            DashboardSnapshotJson.decode(
                raw,
                runtimeKey.copy(entity = DashboardEntity(DashboardEntity.TOOL, "claude"))
            )
        )

        val modelEntity = DashboardEntity(DashboardEntity.MODEL, "gpt-5")
        val seededModelKey = DashboardCacheKey.from(
            "user-1",
            DashboardQuery(tools = listOf("codex")),
            "Asia/Shanghai",
            modelEntity
        )
        val runtimeModelKey = DashboardCacheKey.from(
            "user-1",
            DashboardQuery(
                tools = listOf("codex"),
                compatibilityModelSelector = "gpt-5"
            ),
            "Asia/Shanghai",
            modelEntity
        )
        val modelRaw = DashboardSnapshotJson.encode(
            seededModelKey,
            snapshot,
            DashboardCacheWriteMetadata("process-1", requestId = 2L)
        )
        assertEquals(snapshot, DashboardSnapshotJson.decode(modelRaw, runtimeModelKey))
    }

    @Test
    fun legacySingleValueKeysStillMapToolAndModelIntoCanonicalPluralIdentity() {
        fun key(tool: String? = null, model: String? = null) = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Today,
            machine = DashboardQuery.ALL_MACHINES,
            timezoneId = "UTC",
            tool = tool,
            model = model
        ).canonicalValue()

        assertTrue(key(tool = "codex") != key(tool = "claude"))
        assertTrue(key(model = "gpt-5") != key(model = "claude-sonnet"))
    }

    @Test
    fun sharedDailyCostsFixtureRoundTripsThroughCacheWithNullAmounts() {
        val stats = StatsJson.parse(fixture("daily-costs-unavailable-v2.json"))
        val key = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Month,
            machine = DashboardQuery.ALL_MACHINES,
            timezoneId = "Asia/Shanghai"
        )
        val snapshot = DashboardCachedSnapshot(stats, savedAtEpochMillis = 123L)

        val decoded = requireNotNull(
            DashboardSnapshotJson.decode(
                DashboardSnapshotJson.encode(
                    key,
                    snapshot,
                    DashboardCacheWriteMetadata("process-1", requestId = 1L)
                ),
                key
            )
        )

        assertEquals(stats.dailyCosts, decoded.stats.dailyCosts)
        assertNull(decoded.stats.dailyCosts?.days?.first()?.amountUsd)
        assertEquals(
            DailyCostUnavailableReason.MissingCost,
            decoded.stats.dailyCosts?.days?.first()?.reason
        )
    }

    @Test
    fun cacheKeepsMissingOrNullDailyCostsUnavailableWithoutDefaulting() {
        val key = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Week,
            machine = "macbook|studio",
            timezoneId = "Asia/Shanghai",
            tool = "codex",
            model = "gpt-5"
        )
        val raw = JSONObject(
            DashboardSnapshotJson.encode(
                key,
                DashboardCachedSnapshot(completeStats().copy(dailyCosts = null), 123L),
                DashboardCacheWriteMetadata("process-1", requestId = 1L)
            )
        )
        assertTrue(raw.getJSONObject("stats").isNull("dailyCosts"))
        assertNull(DashboardSnapshotJson.decode(raw.toString(), key)?.stats?.dailyCosts)

        raw.getJSONObject("stats").remove("dailyCosts")
        assertNull(DashboardSnapshotJson.decode(raw.toString(), key)?.stats?.dailyCosts)
    }

    @Test
    fun malformedCachedDailyCostsIsDroppedWhileCoreSnapshotRemainsReadable() {
        val key = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Month,
            machine = DashboardQuery.ALL_MACHINES,
            timezoneId = "Asia/Shanghai"
        )
        val stats = StatsJson.parse(fixture("daily-costs-v2.json"))
        val raw = JSONObject(
            DashboardSnapshotJson.encode(
                key,
                DashboardCachedSnapshot(stats, 123L),
                DashboardCacheWriteMetadata("process-1", requestId = 1L)
            )
        )
        raw.getJSONObject("stats")
            .getJSONObject("dailyCosts")
            .getJSONArray("days")
            .getJSONObject(0)
            .put("amountUsd", "0.42")

        val decoded = requireNotNull(DashboardSnapshotJson.decode(raw.toString(), key))
        assertEquals(900L, decoded.stats.summary.totalTokens)
        assertNull(decoded.stats.dailyCosts)
    }

    @Test
    fun sharedFixtureCustomBoundsSurviveRealCacheEncodeDecode() {
        val fixtureRoot = JSONObject(fixture("daily-costs-v2.json")).apply {
            getJSONObject("meta").apply {
                put("range", "custom")
                getJSONObject("query")
                    .put("range", "custom")
                    .put("start", "2026-07-14")
                    .put("end", "2026-07-20")
            }
            getJSONObject("dailyCosts").getJSONObject("coverage")
                .put("start", "2026-07-14")
                .put("end", "2026-07-15")
        }
        val stats = StatsJson.parse(fixtureRoot.toString())
        val key = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Custom,
            start = "2026-07-14",
            end = "2026-07-20",
            machine = DashboardQuery.ALL_MACHINES,
            timezoneId = "Asia/Shanghai"
        )

        val decoded = requireNotNull(
            DashboardSnapshotJson.decode(
                DashboardSnapshotJson.encode(
                    key,
                    DashboardCachedSnapshot(stats, 123L),
                    DashboardCacheWriteMetadata("process-1", requestId = 1L)
                ),
                key
            )
        )

        assertEquals("2026-07-14", decoded.stats.meta?.query?.start)
        assertEquals("2026-07-20", decoded.stats.meta?.query?.end)
        assertEquals(stats.dailyCosts, decoded.stats.dailyCosts)
    }

    @Test
    fun cacheWriteOrderingRejectsOlderOrDuplicateRequestsFromSameProcess() {
        val existing = DashboardCacheWriteMetadata("process-1", requestId = 20L)

        assertTrue(
            shouldCommitCacheWrite(
                existing,
                DashboardCacheWriteMetadata("process-1", requestId = 21L)
            )
        )
        assertTrue(
            !shouldCommitCacheWrite(
                existing,
                DashboardCacheWriteMetadata("process-1", requestId = 20L)
            )
        )
        assertTrue(
            !shouldCommitCacheWrite(
                existing,
                DashboardCacheWriteMetadata("process-1", requestId = 19L)
            )
        )
        assertTrue(
            shouldCommitCacheWrite(
                existing,
                DashboardCacheWriteMetadata("process-2", requestId = 1L)
            )
        )
    }

    @Test
    fun requestIdentityIsStrictlyMonotonicWithinTheProcess() {
        val first = DashboardRequestIdentity.nextId()
        val second = DashboardRequestIdentity.nextId()

        assertTrue(second > first)
    }

    private fun completeStats(): StatsData = StatsData(
        summary = Summary(
            totalTokens = 110,
            inputTokens = 40,
            outputTokens = 60,
            cachedTokens = 10,
            cacheReadTokens = 8,
            cacheWriteTokens = 2,
            cacheSavedUsd = 0.15,
            totalCost = 1.25,
            totalRequests = 3,
            avgTokensPerReq = 36,
            cacheSplitKnown = true,
            cacheSavings = CacheSavings(
                readSavedUsd = 0.15,
                writePremiumUsd = 0.05,
                netSavedUsd = 0.10,
                fallbackPricedReadTokens = 0,
                fallbackPricedWriteTokens = 2,
                priceBasis = CacheSavingsPriceBasis.LocalPrices
            )
        ),
        tools = mapOf(
            "codex" to ToolStat(
                name = "codex",
                input = 40,
                output = 60,
                cached = 10,
                total = 100,
                cost = 1.25,
                requests = 3,
                cacheRead = 8,
                cacheWrite = 2,
                models = mapOf("gpt-5" to 100L),
                heatmap = mapOf("2026-07-15" to 100L)
            )
        ),
        models = mapOf(
            "gpt-5" to ModelStat(
                name = "gpt-5",
                total = 100,
                requests = 3,
                input = 40,
                output = 60,
                cached = 10,
                cost = 1.25,
                heatmap = mapOf("2026-07-15" to 100L)
            )
        ),
        trends = listOf(
            TrendPoint(
                date = "10:00",
                values = mapOf("codex" to 100L),
                requests = 3
            )
        ),
        heatmap = mapOf("2026-07-15" to 100L),
        history = listOf(
            LogHistoryItem(
                id = 7,
                tool = "codex",
                model = "gpt-5",
                inputTokens = 40,
                outputTokens = 60,
                cachedTokens = 8,
                cacheWriteTokens = 2,
                cost = 1.25,
                timestamp = "2026-07-15 10:00:00",
                sessionId = "session-1",
                machineId = "macbook|studio"
            )
        ),
        machines = listOf("macbook|studio"),
        meta = StatsMeta(
            generatedAt = "2026-07-15T10:00:00+08:00",
            lastRefreshedAt = "2026-07-15T09:59:55+08:00",
            timezone = "Asia/Shanghai",
            range = "week",
            machine = "macbook|studio",
            stale = false,
            contractVersion = 2,
            query = StatsQueryEcho(
                range = "week",
                timezone = "Asia/Shanghai",
                machine = "macbook|studio",
                tool = "codex",
                model = "gpt-5",
                tokenMode = "effective"
            )
        ),
        legacyRpc = true,
        comparison = comparisonFixture(),
        detailsPage = detailsFixture(),
        entityDashboard = EntityDashboard(
            entity = EntityDescriptor(kind = "model", tool = "codex", model = "gpt-5"),
            summary = Summary(inputTokens = 40, outputTokens = 60, totalRequests = 3),
            comparison = comparisonFixture(),
            composition = EntityComposition(
                tools = listOf(CompositionEntry("codex", 100, 40, 60, 8, 2, 3, 1.25)),
                models = listOf(CompositionEntry("gpt-5", 100, 40, 60, 8, 2, 3, 1.25)),
                machines = listOf(CompositionEntry("macbook|studio", 100, requests = 3, cost = 1.25))
            ),
            heatmap = mapOf("2026-07-15" to 100L),
            peak = EntityPeak("10:00", 100, 3, 1.25),
            activity = EntityActivity(1, "2026-07-15 10:00:00", "2026-07-15 10:00:00"),
            historyPage = detailsFixture()
        ),
        capabilities = DashboardCapabilities(
            comparison = true,
            details = true,
            entityDashboard = true,
            cacheSavings = true
        ),
        dailyCosts = DailyCosts(
            coverage = DailyCostsCoverage(
                start = "2026-07-13",
                end = "2026-07-15",
                timezone = "Asia/Shanghai",
                state = DailyCostsCoverageState.Complete
            ),
            days = listOf(
                DailyCostDay(
                    date = "2026-07-15",
                    amountUsd = 1.25,
                    status = DailyCostStatus.RecordedEstimate
                )
            )
        )
    )

    private fun comparisonFixture(): UsageComparison = UsageComparison(
        window = ComparisonWindow(
            kind = "weekOverWeek",
            timezone = "Asia/Shanghai",
            bucket = "day",
            currentStart = "2026-07-13",
            currentEnd = "2026-07-15T10:00:00+08:00",
            previousStart = "2026-07-06",
            previousEnd = "2026-07-13",
            alignedThrough = "2026-07-15"
        ),
        current = ComparisonPeriod(
            Summary(inputTokens = 40, outputTokens = 60, totalRequests = 3),
            listOf(ComparisonSeriesPoint("2026-07-15", 100, 3, 1.25))
        ),
        previous = ComparisonPeriod(
            Summary(inputTokens = 30, outputTokens = 50, totalRequests = 2),
            listOf(ComparisonSeriesPoint("2026-07-08", 80, 2, 1.0))
        ),
        delta = ComparisonDelta(
            tokens = MetricDelta(20.0, 25.0, "up"),
            requests = MetricDelta(1.0, 50.0, "up"),
            cost = MetricDelta(0.25, 25.0, "up")
        )
    )

    private fun detailsFixture(): UsageDetailsPage = UsageDetailsPage(
        items = listOf(
            LogHistoryItem(
                id = 7,
                tool = "codex",
                model = "gpt-5",
                inputTokens = 40,
                outputTokens = 60,
                cachedTokens = 8,
                cacheWriteTokens = 2,
                cost = 1.25,
                timestamp = "2026-07-15 10:00:00",
                sessionId = "hour:10",
                machineId = "macbook|studio",
                requests = 3
            )
        ),
        nextCursor = "v1.cursor",
        hasMore = true,
        totalCount = 4,
        filteredSummary = Summary(inputTokens = 40, outputTokens = 60, totalRequests = 3),
        availableFilters = AvailableFilters(
            tools = listOf(FilterOption("codex", 4)),
            models = listOf(FilterOption("gpt-5", 4)),
            machines = listOf(FilterOption("macbook|studio", 4))
        )
    )

    private fun fixture(name: String): String {
        val resource = checkNotNull(javaClass.classLoader?.getResource("dashboard-stats-v2/$name")) {
            "Missing shared dashboard fixture: $name"
        }
        return resource.readText()
    }
}
