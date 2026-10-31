package com.jeidorf.tokenledger.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * T10.184（T10.162 A3）：summary.cacheSavings 解析矩阵。
 *
 * 契约 `docs/contracts/dashboard-stats-v2.md` §2.4；方案 `docs/design/cache-savings-net-v1.md`
 * §3.1/§4.1/§4.4/§4.7。字段名与形状与 T10.183（`codex/T10.183-cache-net-local`@c6b7bfc8）在
 * 桌面/Rust 端落地的完全一致：本任务从该提交按 blob 哈希核对后逐字节复制了两份共享 fixture
 * 到本分支同路径（T10.183 尚未合并；两边各自新增同内容文件，按 root 的说明可以干净合并，见任务日志）。
 *
 * [sharedValidFixtureCasesParseExactlyAsExpected]、[sharedInvalidFixtureCasesDropTheWholeExtensionButKeepCore]
 * 直接读取共享 fixture 逐用例复核（契约 §8：Kotlin/TS/Rust 测试读同一份文件，不各端复制 JSON）；
 * 其余测试针对派单要求的具体场景（缺字段、null、负净值、兜底标注、混用来源不可得、旧缓存、非法整体丢弃）
 * 单独命名，便于按场景核对。
 */
class CacheSavingsParsingTest {

    @Test
    fun cacheSavingsCapabilityDefaultsFalseAndParsesCanonicalMetaValue() {
        fun parse(capabilityJson: String?): StatsData {
            val meta = capabilityJson?.let { """, "meta": {"capabilities": {"cacheSavings": $it}}""" }.orEmpty()
            return StatsJson.parse(
                """
                {
                  "summary": {"totalTokens": 1, "inputTokens": 1, "outputTokens": 0, "cachedTokens": 0,
                    "totalCost": 0, "totalRequests": 1, "avgTokensPerReq": 1},
                  "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []$meta
                }
                """.trimIndent()
            )
        }

        assertFalse(parse(null).capabilities.cacheSavings)
        assertFalse(parse("false").capabilities.cacheSavings)
        assertTrue(parse("true").capabilities.cacheSavings)
    }

    private fun fixture(name: String): JSONObject {
        val resource = checkNotNull(javaClass.classLoader?.getResource("dashboard-stats-v2/$name")) {
            "Missing shared dashboard fixture: $name"
        }
        return JSONObject(resource.readText())
    }

    /** 把 fixture 用例的 summary 合进 statsTemplate，得到一份完整 Stats v2 响应（fixture 自带的约定）。 */
    private fun buildStatsJson(fixtureRoot: JSONObject, caseSummary: JSONObject): String {
        val root = JSONObject(fixtureRoot.getJSONObject("statsTemplate").toString())
        root.put("summary", JSONObject(caseSummary.toString()))
        return root.toString()
    }

    @Test
    fun sharedValidFixtureCasesParseExactlyAsExpected() {
        val fixtureRoot = fixture("cache-savings-v2.json")
        val cases = fixtureRoot.getJSONArray("cases")
        assertTrue("fixture must carry cases", cases.length() > 0)
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val name = case.getString("name")
            val stats = StatsJson.parse(buildStatsJson(fixtureRoot, case.getJSONObject("summary")))
            val expected = case.getJSONObject("expected")
            val actual = requireNotNull(stats.summary.cacheSavings) { "case $name: cacheSavings unexpectedly null" }
            assertEquals("case $name: readSavedUsd", expected.getDouble("readSavedUsd"), actual.readSavedUsd, 1e-9)
            assertEquals("case $name: writePremiumUsd", expected.getDouble("writePremiumUsd"), actual.writePremiumUsd, 1e-9)
            assertEquals("case $name: netSavedUsd", expected.getDouble("netSavedUsd"), actual.netSavedUsd, 1e-9)
            assertEquals(
                "case $name: fallbackPricedReadTokens",
                expected.getLong("fallbackPricedReadTokens"),
                actual.fallbackPricedReadTokens
            )
            assertEquals(
                "case $name: fallbackPricedWriteTokens",
                expected.getLong("fallbackPricedWriteTokens"),
                actual.fallbackPricedWriteTokens
            )
            assertEquals("case $name: priceBasis", expected.getString("priceBasis"), actual.priceBasis.wireValue)
        }
    }

    @Test
    fun sharedInvalidFixtureCasesDropTheWholeExtensionButKeepCore() {
        val fixtureRoot = fixture("cache-savings-invalid-v2.json")
        val cases = fixtureRoot.getJSONArray("cases")
        assertTrue("fixture must carry cases", cases.length() > 0)
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val name = case.getString("name")
            val summaryJson = case.getJSONObject("summary")
            val stats = StatsJson.parse(buildStatsJson(fixtureRoot, summaryJson))
            assertNull("case $name: cacheSavings must be dropped as a whole", stats.summary.cacheSavings)
            // 不可得不等于整份 summary 失效：旧核心字段必须原样保留。
            assertEquals(
                "case $name: core totalTokens must survive",
                summaryJson.getLong("totalTokens"),
                stats.summary.totalTokens
            )
            assertEquals(
                "case $name: core totalCost must survive",
                summaryJson.getDouble("totalCost"),
                stats.summary.totalCost,
                1e-9
            )
        }
    }

    @Test
    fun missingCacheSavingsFieldIsUnknownNotZero() {
        // 拆分可证明，但响应里完全没有 cacheSavings/cacheSavedUsd 键（例如旧 B 期还没铺开的云端范围）。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 24, "inputTokens": 10, "outputTokens": 14, "cachedTokens": 100,
                "cacheReadTokens": 90, "cacheWriteTokens": 10, "totalCost": 1.5, "totalRequests": 3, "avgTokensPerReq": 8},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        assertTrue(stats.summary.cacheSplitKnown)
        assertNull(stats.summary.cacheSavedUsd)
        assertNull(stats.summary.cacheSavings)
    }

    @Test
    fun explicitNullCacheSavingsIsUnknown() {
        // 显式 null 与缺失同义：都是不可得，不能被读成 0 或空对象。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 24, "inputTokens": 10, "outputTokens": 14, "cachedTokens": 100,
                "cacheReadTokens": 90, "cacheWriteTokens": 10, "cacheSavedUsd": null, "cacheSavings": null,
                "totalCost": 1.5, "totalRequests": 3, "avgTokensPerReq": 8},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        assertNull(stats.summary.cacheSavedUsd)
        assertNull(stats.summary.cacheSavings)
    }

    @Test
    fun negativeNetSavingsIsKeptWithSign() {
        // 方案 §3.4 第 2 行 / 共享 fixture negative-net：写入溢价高于读取节省时带符号照实保留。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 60000, "inputTokens": 50000, "outputTokens": 10000, "cachedTokens": 1200000,
                "cacheReadTokens": 200000, "cacheWriteTokens": 1000000, "cacheSavedUsd": 0.54,
                "cacheSavings": {"readSavedUsd": 0.54, "writePremiumUsd": 0.75, "netSavedUsd": -0.21,
                  "fallbackPricedReadTokens": 0, "fallbackPricedWriteTokens": 0, "priceBasis": "local-prices"},
                "totalCost": 4.11, "totalRequests": 1, "avgTokensPerReq": 60000},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        val cacheSavings = requireNotNull(stats.summary.cacheSavings)
        assertEquals(-0.21, cacheSavings.netSavedUsd, 1e-9)
        assertTrue(cacheSavings.netSavedUsd < 0.0)
    }

    @Test
    fun writePriceFallbackMarkerIsPreserved() {
        // 方案 §3.4 第 4 行 / 共享 fixture write-price-fallback：kimi-k2.6 缺写价，
        // 兜底写入量必须原样保留下来供界面标注「含兜底单价」（呈现本身留给 A2/B2）。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 100000, "inputTokens": 80000, "outputTokens": 20000, "cachedTokens": 6000000,
                "cacheReadTokens": 4000000, "cacheWriteTokens": 2000000, "cacheSavedUsd": 3.0,
                "cacheSavings": {"readSavedUsd": 3.0, "writePremiumUsd": 0.45, "netSavedUsd": 2.55,
                  "fallbackPricedReadTokens": 0, "fallbackPricedWriteTokens": 2000000, "priceBasis": "local-prices"},
                "totalCost": 2.997, "totalRequests": 1, "avgTokensPerReq": 100000},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        val cacheSavings = requireNotNull(stats.summary.cacheSavings)
        assertEquals(0L, cacheSavings.fallbackPricedReadTokens)
        assertEquals(2_000_000L, cacheSavings.fallbackPricedWriteTokens)
    }

    @Test
    fun mixedSourcesWithUnprovenSplitAreUnknown() {
        // 用户决定 Q6 / 共享 fixture split-unproven-object-absent：范围内混有像 Codex 这样只报读取、
        // 不报写入量的来源时，生产端已经把拆分、cacheSavedUsd 与 cacheSavings 一起省略；
        // Android 在解析边界看到的就是「这三者都不存在」，必须保持不可得，不得部分采信。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 240000, "inputTokens": 200000, "outputTokens": 40000, "cachedTokens": 9800000,
                "totalCost": 8.25, "totalRequests": 2, "avgTokensPerReq": 120000},
              "tools": {
                "claude": {"name": "claude", "input": 100000, "output": 20000, "cached": 9000000, "cacheRead": 8000000, "cacheWrite": 1000000, "total": 9120000, "cost": 6.75, "requests": 1},
                "codex": {"name": "codex", "input": 100000, "output": 20000, "cached": 800000, "cacheRead": 800000, "total": 920000, "cost": 1.5, "requests": 1}
              },
              "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        assertFalse(stats.summary.cacheSplitKnown)
        assertNull(stats.summary.cacheSavedUsd)
        assertNull(stats.summary.cacheSavings)
        // 工具拆分也必须双侧显式且与 combined 一致；单侧上报保持 combined。
        assertEquals(8_000_000L, stats.tools.getValue("claude").cacheRead)
        assertNull(stats.tools.getValue("codex").cacheRead)
        assertNull(stats.tools.getValue("codex").cacheWrite)
    }

    /** 组一份 schema `schemaVersion` 的缓存整体 JSON，`legacyStatsJson` 是里面的 `stats` 载荷。 */
    private fun legacyCacheJson(key: DashboardCacheKey, schemaVersion: Int, legacyStatsJson: JSONObject): String =
        JSONObject()
            .put("schemaVersion", schemaVersion)
            .put("writerId", "process-1")
            .put("requestId", 1L)
            .put("userId", key.userId)
            .put("range", key.range.rpcValue)
            .put("start", JSONObject.NULL)
            .put("end", JSONObject.NULL)
            .put("machine", key.machine)
            .put("timezoneId", key.timezoneId)
            .put("tool", JSONObject.NULL)
            .put("model", JSONObject.NULL)
            .put("machines", JSONArray(key.machines))
            .put("tools", JSONArray(key.tools))
            .put("models", JSONArray(key.models))
            .put("search", JSONObject.NULL)
            .put("tokenMode", key.tokenMode)
            .put("entity", JSONObject.NULL)
            .put("savedAtEpochMillis", 123L)
            .put("stats", legacyStatsJson)
            .toString()

    @Test
    fun oldCacheWithoutCacheSavingsFieldStaysReadable() {
        // 旧缓存（T10.184 之前写入，schema 3，从未有过 cacheSavings 这个键）必须继续可读，
        // 不失效：不可得地解析为 null，不崩溃。旧的 cacheSavedUsd 数值——不管当年写的是不是
        // 0.0——一律在读出时强制视为不可得（root R-36 P3-1）：schema 3 时代唯一的写入路径
        // 是 doubleValue（缺失即 0.0），旧值不是验证过的净节省，不能继续当已知值使用。
        val key = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Today,
            machine = DashboardQuery.ALL_MACHINES,
            timezoneId = "UTC"
        )
        val legacyStatsJson = JSONObject(
            """
            {
              "summary": {"totalTokens": 24, "inputTokens": 10, "outputTokens": 14, "cachedTokens": 100,
                "cacheReadTokens": 90, "cacheWriteTokens": 10, "cacheSavedUsd": 0.0,
                "totalCost": 1.5, "totalRequests": 3, "avgTokensPerReq": 8},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": [],
              "legacyRpc": false, "capabilities": {"comparison": false, "details": false, "entityDashboard": false, "multiFilterSearch": false}
            }
            """.trimIndent()
        )

        val decoded = requireNotNull(
            DashboardSnapshotJson.decode(legacyCacheJson(key, schemaVersion = 3, legacyStatsJson), key)
        )

        assertNull(decoded.stats.summary.cacheSavedUsd)
        assertNull(decoded.stats.summary.cacheSavings)
        assertEquals(24, decoded.stats.summary.effectiveTokens)
    }

    @Test
    fun schemaFourRoundTripKeepsAKnownGrossValueUnlikeLegacySchemaThree() {
        // root R-36 P3-1：写入端已经升到 schema 4；同一个 cacheSavedUsd 数值在 schema 4 里
        // 是真正验证过的已知值，不该被 schema 3 那条“强制视为不可得”的兼容规则误伤。
        val key = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Today,
            machine = DashboardQuery.ALL_MACHINES,
            timezoneId = "UTC"
        )
        val statsJson = JSONObject(
            """
            {
              "summary": {"totalTokens": 24, "inputTokens": 10, "outputTokens": 14, "cachedTokens": 100,
                "cacheReadTokens": 90, "cacheWriteTokens": 10, "cacheSavedUsd": 0.42,
                "totalCost": 1.5, "totalRequests": 3, "avgTokensPerReq": 8},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": [],
              "legacyRpc": false, "capabilities": {"comparison": false, "details": false, "entityDashboard": false, "multiFilterSearch": false}
            }
            """.trimIndent()
        )

        assertEquals(4, CACHE_SCHEMA_VERSION)
        val decoded = requireNotNull(
            DashboardSnapshotJson.decode(legacyCacheJson(key, schemaVersion = CACHE_SCHEMA_VERSION, statsJson), key)
        )

        assertEquals(0.42, requireNotNull(decoded.stats.summary.cacheSavedUsd), 1e-9)
    }

    @Test
    fun invalidShapeDropsTheWholeExtensionButKeepsCore() {
        // 契约 §2.4 消费端校验举例：netSavedUsd 没有等于 readSavedUsd − writePremiumUsd（超出容差）。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 120000, "inputTokens": 100000, "outputTokens": 20000, "cachedTokens": 9000000,
                "cacheReadTokens": 8000000, "cacheWriteTokens": 1000000, "cacheSavedUsd": 21.6,
                "cacheSavings": {"readSavedUsd": 21.6, "writePremiumUsd": 0.75, "netSavedUsd": 21.6,
                  "fallbackPricedReadTokens": 0, "fallbackPricedWriteTokens": 0, "priceBasis": "local-prices"},
                "totalCost": 6.75, "totalRequests": 1, "avgTokensPerReq": 120000},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        assertNull(stats.summary.cacheSavings)
        // 旧字段（毛值）与拆分 Token 数照常保留：不可得只丢新对象，不牵连核心。
        assertEquals(21.6, requireNotNull(stats.summary.cacheSavedUsd), 1e-9)
        assertEquals(8_000_000L, stats.summary.cacheReadTokens)
        assertEquals(1_000_000L, stats.summary.cacheWriteTokens)
    }

    @Test
    fun cacheSavedUsdAsNonNumericStringDropsWholeCacheSavingsButKeepsCore() {
        // root R-26：外层 cacheSavedUsd 键存在但类型不对（字符串）时，即便 cacheSavings 对象
        // 自己的六个字段都合法，也必须整体丢弃——不能因为它先被外层宽松的
        // optFiniteNonNegativeDoubleOrNull 折叠成 null 就和「键缺失」混为一谈而放行。
        // parseCacheSavings 必须直接读原始键，对齐 T10.183 TS 端 parseCacheSavings 的
        // typeof cacheSavedUsd !== 'number' 分支。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 120000, "inputTokens": 100000, "outputTokens": 20000, "cachedTokens": 9000000,
                "cacheReadTokens": 8000000, "cacheWriteTokens": 1000000, "cacheSavedUsd": "not-a-number",
                "cacheSavings": {"readSavedUsd": 21.6, "writePremiumUsd": 0.75, "netSavedUsd": 20.85,
                  "fallbackPricedReadTokens": 0, "fallbackPricedWriteTokens": 0, "priceBasis": "local-prices"},
                "totalCost": 6.75, "totalRequests": 1, "avgTokensPerReq": 120000},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        assertNull(stats.summary.cacheSavings)
        // 外层字段走既有的宽松规则单独解析，非数字字符串同样不可得——两侧独立判定，结论恰好一致。
        assertNull(stats.summary.cacheSavedUsd)
        assertEquals(8_000_000L, stats.summary.cacheReadTokens)
    }

    @Test
    fun cacheSavedUsdAsNaNDropsWholeCacheSavings() {
        // root R-36 P3-7 更正：这条只刻画本单测用的桌面版 org.json（JVM，Maven 依赖）的
        // tokener 行为——裸 NaN 不是合法 JSON 数字字面量，不以数字/负号开头的裸词落回字符串
        // 处理，因此落在「不是 Number 类型」分支，和上一个用例一样只丢 cacheSavings 这一个
        // 对象。真机上 Android 平台内置的 org.json 对裸 NaN、Infinity 或 1e309 这类数字字面量
        // 的处理不同：会让整条响应的 JSON 解析直接抛异常（不是把单个字段悄悄退化成字符串），
        // 即整体丢的是「这次 parse」而不只是 cacheSavings 对象。这里绿灯只证明 JVM 侧不会把
        // NaN 悄悄收编成 0，不能当作已经验证过真机行为。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 120000, "inputTokens": 100000, "outputTokens": 20000, "cachedTokens": 9000000,
                "cacheReadTokens": 8000000, "cacheWriteTokens": 1000000, "cacheSavedUsd": NaN,
                "cacheSavings": {"readSavedUsd": 21.6, "writePremiumUsd": 0.75, "netSavedUsd": 20.85,
                  "fallbackPricedReadTokens": 0, "fallbackPricedWriteTokens": 0, "priceBasis": "local-prices"},
                "totalCost": 6.75, "totalRequests": 1, "avgTokensPerReq": 120000},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        assertNull(stats.summary.cacheSavings)
        assertNull(stats.summary.cacheSavedUsd)
    }

    @Test
    fun cacheSavedUsdNegativeDropsWholeCacheSavings() {
        // 负值类型合法（是个数字），但既不满足外层字段自己的非负要求，也不可能落在
        // readSavedUsd（非负）的容差窗口内——两条独立规则殊途同归，都判不可得。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 120000, "inputTokens": 100000, "outputTokens": 20000, "cachedTokens": 9000000,
                "cacheReadTokens": 8000000, "cacheWriteTokens": 1000000, "cacheSavedUsd": -21.6,
                "cacheSavings": {"readSavedUsd": 21.6, "writePremiumUsd": 0.75, "netSavedUsd": 20.85,
                  "fallbackPricedReadTokens": 0, "fallbackPricedWriteTokens": 0, "priceBasis": "local-prices"},
                "totalCost": 6.75, "totalRequests": 1, "avgTokensPerReq": 120000},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        assertNull(stats.summary.cacheSavings)
        assertNull(stats.summary.cacheSavedUsd)
    }

    @Test
    fun cacheSavedUsdOutsideToleranceDropsWholeCacheSavings() {
        // 类型和符号都合法，但数值和 readSavedUsd 对不上（远超容差），cacheSavings 整体作废；
        // 外层字段本身数值合法（有限非负），按既有规则原样保留——两者独立判定，互不牵连。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 120000, "inputTokens": 100000, "outputTokens": 20000, "cachedTokens": 9000000,
                "cacheReadTokens": 8000000, "cacheWriteTokens": 1000000, "cacheSavedUsd": 0.99,
                "cacheSavings": {"readSavedUsd": 21.6, "writePremiumUsd": 0.75, "netSavedUsd": 20.85,
                  "fallbackPricedReadTokens": 0, "fallbackPricedWriteTokens": 0, "priceBasis": "local-prices"},
                "totalCost": 6.75, "totalRequests": 1, "avgTokensPerReq": 120000},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        assertNull(stats.summary.cacheSavings)
        assertEquals(0.99, requireNotNull(stats.summary.cacheSavedUsd), 1e-9)
    }

    @Test
    fun cacheSavedUsdNullOrAbsentKeepsOtherwiseValidCacheSavings() {
        // root R-26 第三点：cacheSavedUsd 缺失或显式 null 都不影响 cacheSavings 本身是否可信——
        // 分别验证「键完全不存在」与「键存在但是 JSON null」两种写法都保留 cacheSavings。
        val cacheSavingsJson = """{"readSavedUsd": 21.6, "writePremiumUsd": 0.75, "netSavedUsd": 20.85,
                  "fallbackPricedReadTokens": 0, "fallbackPricedWriteTokens": 0, "priceBasis": "local-prices"}"""

        val whenAbsent = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 120000, "inputTokens": 100000, "outputTokens": 20000, "cachedTokens": 9000000,
                "cacheReadTokens": 8000000, "cacheWriteTokens": 1000000,
                "cacheSavings": $cacheSavingsJson,
                "totalCost": 6.75, "totalRequests": 1, "avgTokensPerReq": 120000},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )
        assertNull(whenAbsent.summary.cacheSavedUsd)
        assertEquals(21.6, requireNotNull(whenAbsent.summary.cacheSavings).readSavedUsd, 1e-9)

        val whenExplicitNull = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 120000, "inputTokens": 100000, "outputTokens": 20000, "cachedTokens": 9000000,
                "cacheReadTokens": 8000000, "cacheWriteTokens": 1000000, "cacheSavedUsd": null,
                "cacheSavings": $cacheSavingsJson,
                "totalCost": 6.75, "totalRequests": 1, "avgTokensPerReq": 120000},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )
        assertNull(whenExplicitNull.summary.cacheSavedUsd)
        assertEquals(21.6, requireNotNull(whenExplicitNull.summary.cacheSavings).readSavedUsd, 1e-9)
    }

    @Test
    fun validCacheSavingsWithPositiveFallbackReadTokensParses() {
        // root R-26 第四点：合法对象里 fallbackPricedReadTokens > 0（此前的用例只覆盖过
        // fallbackPricedWriteTokens > 0；读/写两侧互不对称，单独补一个读取侧兜底的用例）。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 100000, "inputTokens": 80000, "outputTokens": 20000, "cachedTokens": 6000000,
                "cacheReadTokens": 4000000, "cacheWriteTokens": 2000000, "cacheSavedUsd": 3.0,
                "cacheSavings": {"readSavedUsd": 3.0, "writePremiumUsd": 0.3, "netSavedUsd": 2.7,
                  "fallbackPricedReadTokens": 1500000, "fallbackPricedWriteTokens": 0, "priceBasis": "uploaded-prices"},
                "totalCost": 2.997, "totalRequests": 1, "avgTokensPerReq": 100000},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        val cacheSavings = requireNotNull(stats.summary.cacheSavings)
        assertEquals(1_500_000L, cacheSavings.fallbackPricedReadTokens)
        assertEquals(0L, cacheSavings.fallbackPricedWriteTokens)
        assertEquals(CacheSavingsPriceBasis.UploadedPrices, cacheSavings.priceBasis)
    }

    @Test
    fun fallbackCountAsStringDropsWholeCacheSavingsButKeepsCore() {
        // root R-36 P2-1（对照表 I27/I28）：兜底计数必须是 JSON number；哪怕字符串数值上
        // 合法（"0"），也必须整体丢弃——之前复用的 optLongOrNull 会把它读成 0 而错误放行。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 120000, "inputTokens": 100000, "outputTokens": 20000, "cachedTokens": 9000000,
                "cacheReadTokens": 8000000, "cacheWriteTokens": 1000000, "cacheSavedUsd": 21.6,
                "cacheSavings": {"readSavedUsd": 21.6, "writePremiumUsd": 0.75, "netSavedUsd": 20.85,
                  "fallbackPricedReadTokens": 0, "fallbackPricedWriteTokens": "0", "priceBasis": "local-prices"},
                "totalCost": 6.75, "totalRequests": 1, "avgTokensPerReq": 120000},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        assertNull(stats.summary.cacheSavings)
        assertEquals(21.6, requireNotNull(stats.summary.cacheSavedUsd), 1e-9)
    }

    @Test
    fun splitFieldAsStringDropsWholeCacheSavingsButKeepsCore() {
        // root R-36 P2-1（对照表 S05/S08）：cacheSavings 对象依赖的拆分三元组必须重新按
        // 严格安全整数校验；数字字符串（"8000000"）不接受，即便外层的 cacheSplitKnown 判定
        // （为兼容旧端而宽松）已经把这次响应当成拆分可证明。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 120000, "inputTokens": 100000, "outputTokens": 20000, "cachedTokens": 9000000,
                "cacheReadTokens": "8000000", "cacheWriteTokens": 1000000, "cacheSavedUsd": 21.6,
                "cacheSavings": {"readSavedUsd": 21.6, "writePremiumUsd": 0.75, "netSavedUsd": 20.85,
                  "fallbackPricedReadTokens": 0, "fallbackPricedWriteTokens": 0, "priceBasis": "local-prices"},
                "totalCost": 6.75, "totalRequests": 1, "avgTokensPerReq": 120000},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        assertNull(stats.summary.cacheSavings)
    }

    @Test
    fun cachedTokensFractionalDropsWholeCacheSavingsButKeepsCore() {
        // root R-36 P2-1（对照表 S07）：cachedTokens 必须是安全整数；带小数点的总量
        // （即便原有的 longValue 会直接截断成一个和 cacheReadTokens + cacheWriteTokens
        // 相等的整数）也必须让 cacheSavings 整体作废，不能沿用截断后的宽松结果。
        val stats = StatsJson.parse(
            """
            {
              "summary": {"totalTokens": 120000, "inputTokens": 100000, "outputTokens": 20000, "cachedTokens": 9000000.5,
                "cacheReadTokens": 8000000, "cacheWriteTokens": 1000000, "cacheSavedUsd": 21.6,
                "cacheSavings": {"readSavedUsd": 21.6, "writePremiumUsd": 0.75, "netSavedUsd": 20.85,
                  "fallbackPricedReadTokens": 0, "fallbackPricedWriteTokens": 0, "priceBasis": "local-prices"},
                "totalCost": 6.75, "totalRequests": 1, "avgTokensPerReq": 120000},
              "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": [], "machines": []
            }
            """.trimIndent()
        )

        assertNull(stats.summary.cacheSavings)
    }

    @Test
    fun roundTripPreservesCacheSavingsThroughEncodeDecode() {
        val key = DashboardCacheKey(
            userId = "user-1",
            range = RangeKey.Week,
            machine = DashboardQuery.ALL_MACHINES,
            timezoneId = "Asia/Shanghai"
        )
        val cacheSavings = CacheSavings(
            readSavedUsd = 21.6,
            writePremiumUsd = 0.75,
            netSavedUsd = 20.85,
            fallbackPricedReadTokens = 0,
            fallbackPricedWriteTokens = 0,
            priceBasis = CacheSavingsPriceBasis.LocalPrices
        )
        val summary = Summary(
            totalTokens = 120_000,
            inputTokens = 100_000,
            outputTokens = 20_000,
            cachedTokens = 9_000_000,
            cacheReadTokens = 8_000_000,
            cacheWriteTokens = 1_000_000,
            cacheSavedUsd = 21.6,
            totalCost = 6.75,
            totalRequests = 1,
            avgTokensPerReq = 120_000,
            cacheSplitKnown = true,
            cacheSavings = cacheSavings
        )
        val stats = StatsData(
            summary = summary,
            tools = emptyMap(),
            models = emptyMap(),
            trends = emptyList(),
            heatmap = emptyMap(),
            history = emptyList(),
            machines = emptyList(),
            meta = null,
            capabilities = DashboardCapabilities(cacheSavings = true)
        )
        val snapshot = DashboardCachedSnapshot(stats, savedAtEpochMillis = 1_750_000_000_000L)
        val writeMetadata = DashboardCacheWriteMetadata("process-1", requestId = 1L)

        val decoded = requireNotNull(
            DashboardSnapshotJson.decode(DashboardSnapshotJson.encode(key, snapshot, writeMetadata), key)
        )

        assertEquals(cacheSavings, decoded.stats.summary.cacheSavings)
        assertTrue(decoded.stats.capabilities.cacheSavings)
        assertEquals(21.6, requireNotNull(decoded.stats.summary.cacheSavedUsd), 1e-9)
    }
}
