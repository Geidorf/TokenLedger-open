package com.jeidorf.tokenledger.mobile

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.os.Bundle
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.WorkManager
import com.jeidorf.tokenledger.mobile.widget.TokenLedgerBarWidgetReceiver
import com.jeidorf.tokenledger.mobile.widget.TokenLedgerComboWidgetReceiver
import com.jeidorf.tokenledger.mobile.widget.TokenLedgerQuotaWidgetReceiver
import com.jeidorf.tokenledger.mobile.widget.TokenLedgerRingWidgetReceiver
import com.jeidorf.tokenledger.mobile.widget.TokenLedgerWidget
import com.jeidorf.tokenledger.mobile.widget.TokenLedgerWidgetReceiver
import com.jeidorf.tokenledger.mobile.widget.WidgetConfig
import com.jeidorf.tokenledger.mobile.widget.WidgetConfigStore
import com.jeidorf.tokenledger.mobile.widget.WidgetMode
import com.jeidorf.tokenledger.mobile.widget.WidgetRange
import com.jeidorf.tokenledger.mobile.widget.WidgetState
import com.jeidorf.tokenledger.mobile.widget.WidgetStateRepository
import com.jeidorf.tokenledger.mobile.widget.WidgetThemeMode
import com.jeidorf.tokenledger.mobile.widget.widgetLayoutDescription
import java.io.File
import java.security.KeyStore
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * T10.118d 的真机 Launcher 辅助入口。
 *
 * 这里只写 `.qa` target context：匿名 fixture、每实例配置和 `.qa` 自有 WorkManager。
 * Launcher 的添加、缩放、重新配置、截图与 UI 树仍由真实系统桌面完成，本类不伪造它们。
 */
@RunWith(AndroidJUnit4::class)
class LauncherWidgetNativeTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context: Context get() = instrumentation.targetContext.applicationContext

    @Test
    fun seedAnonymousFixtureAndStopQaRefresh() = runBlocking {
        seedAnonymousFixture(expiresAtEpochSeconds = 1L)
    }

    /**
     * 与上面同一份匿名 fixture，但把会话有效期设到将来。**要先断网再启动。**
     *
     * ```
     * adb shell cmd connectivity airplane-mode enable
     * adb shell am instrument -w -e class \
     *   'com.jeidorf.tokenledger.mobile.LauncherWidgetNativeTest#seedActiveFixtureForOnDeviceWalkthrough' \
     *   com.jeidorf.tokenledger.mobile.qa.test/androidx.test.runner.AndroidJUnitRunner
     * adb shell monkey -p com.jeidorf.tokenledger.mobile.qa -c android.intent.category.LAUNCHER 1
     * ```
     *
     * **断网这一步不是可选的**，原因值得写清楚，省得下一个人少一步又得出错误结论：
     * [DashboardViewModel] 启动时会拿 token 去后端换数据，假 token 拿到 401 就走
     * `DashboardAuthExpiredException` 清会话，界面停在「会话已过期」。**但 401 与网络错误
     * 是两条路**——`DashboardUiState` 的注释专门写了这一句，`DashboardRepository` 也写了
     * "transport/5xx errors remain retryable and the encrypted session is kept so the
     * offline snapshot can continue to render"。断网时没有 401，会话留着；而
     * `startDashboardRequest` 在没有可见数据时**先 `cache.load` 把快照灌进 `cachedData`**
     * 再发请求，请求失败只改 `loadingMode` 与 `error`，缓存原样保留。于是这一屏就出来了。
     *
     * 2026-09-08 T10.132 曾在这里写下「主看板没有绕过网络的读缓存分支」，**那是错的**：
     * 当时只读了两处 `Expired` 的来源，没读 `cache.load` 那一支。同日 T10.133 实测推翻，
     * 登录后的概览 / 洞察 / 额度 / 摆件四屏都是这样走查出来的。
     *
     * 全程不涉及真实凭据——token 是写死的假串，邮箱用 `.invalid` 保留域，
     * `require` 限定只能落在 `.qa` 包，而且断网时根本没有后端参与。
     * 重复种之前要先跑 [cleanupFixtureAndRestoreQaState]。
     *
     * 缓存里是 fixture 数据。**T10.133 第八批之前它只有汇总**——没有来源/模型分布、
     * 没有日历热力、没有趋势序列，于是前七批的真机走查看到的几乎全是空态（那也确实
     * 抓出了一批空态 bug）。现在补齐了：四个来源、四个模型、两台设备、120 天热力、
     * 按档位分桶的同期序列（今日走 24 小时桶、本周/本月走日桶）、12 条明细与按日金额。
     *
     * 数据必须**自洽**：四个来源的 input/output/cached/requests 分别精确加总回 summary，
     * 成本按有效 Token 摊分且末位吃掉余数。夹具自相矛盾（构成环的百分比与顶部总量对不上）
     * 比夹具单薄更难查——那会让走查的人去追一个并不存在的界面 bug。
     */
    @Test
    fun seedActiveFixtureForOnDeviceWalkthrough() = runBlocking {
        seedAnonymousFixture(expiresAtEpochSeconds = System.currentTimeMillis() / 1000 + 86_400)
        report("fixture-session-active for UI walkthrough")
    }

    private suspend fun seedAnonymousFixture(expiresAtEpochSeconds: Long) {
        require(context.packageName == QA_PACKAGE) { "fixture may only target $QA_PACKAGE" }
        backupQaStateOnce()
        cancelQaRefresh()

        SESSION_AND_CACHE_PREFS.forEach(::clearPreferences)
        PrivacyStore.setCostMaskEnabled(context, false)
        val session = MobileSession(
            accessToken = "fixture-access-token",
            refreshToken = "fixture-refresh-token",
            userId = FIXTURE_USER,
            email = "fixture@example.invalid",
            expiresAtEpochSeconds = expiresAtEpochSeconds
        )
        val sessionStore = SessionStore(context)
        check(sessionStore.activate(sessionStore.generation(), session))

        val now = System.currentTimeMillis()
        val timezoneId = TimeZone.getDefault().id.ifBlank { "UTC" }
        val today = LocalDate.now(runCatching { ZoneId.of(timezoneId) }.getOrDefault(ZoneId.systemDefault()))
        WidgetRange.entries.forEachIndexed { index, range ->
            val key = DashboardCacheKey.from(
                userId = FIXTURE_USER,
                query = DashboardQuery(range = range.rangeKey),
                timezoneId = timezoneId,
                entity = null
            )
            DashboardCache(context).save(
                key,
                DashboardCachedSnapshot(fixtureStats(range, timezoneId, today), now),
                requestId = (index + 1).toLong()
            )
        }

        val baseQuota = fixtureQuota(Instant.ofEpochMilli(now))
        // T10.218 的主 Activity 视觉走查沿用同一隔离缓存，只扩展被评审截断的账号名称。
        val visualReview = arguments().getString("visualReview") == "true"
        val quota = if (visualReview) baseQuota.copy(providers = baseQuota.providers.map { provider ->
            if (provider.providerId == "fixture-team-plan") {
                provider.copy(displayName = "团队共享 OpenAPI 额度 · 北美研发账号")
            } else provider
        }) else baseQuota
        QuotaCache(context).save(
            QuotaCacheKey(FIXTURE_USER),
            QuotaCachedSnapshot(quota, now),
            QuotaCacheWriteIdentity(
                writerId = "t10-118d-launcher-fixture",
                requestId = 1L,
                sessionGeneration = 1L,
                epoch = quota.epoch,
                revision = quota.revision
            )
        )
        cancelQaRefresh()

        val state = WidgetStateRepository(context).load(RangeKey.Today)
        assertTrue(state is WidgetState.Ready)
        state as WidgetState.Ready
        assertEquals(987_600_000L, state.usage?.effectiveTokens)
        assertEquals(4, state.quota?.providers?.size)
        report("fixture-seeded user=$FIXTURE_USER ranges=3 providers=4 refresh=cancelled expiresAt=$expiresAtEpochSeconds")
    }

    @Test
    fun refreshInstalledFixtureWidgetsAndRecordBaseline() = runBlocking {
        val instances = installedInstances()
        assertTrue("环形额度实例缺失", instances.any { it.mode == WidgetMode.MultiRing })
        assertTrue("单行消耗实例缺失", instances.any { it.mode == WidgetMode.SingleUsage })
        assertTrue("组合卡实例缺失", instances.any { it.mode == WidgetMode.BarUsage })

        instances.forEach { instance ->
            WidgetConfigStore.lockMode(context, instance.appWidgetId, instance.mode)
        }
        updateInstalledWidgets()
        cancelQaRefresh()

        val snapshot = instanceSnapshot(instances)
        File(context.filesDir, INSTANCE_BASELINE_FILE).writeText(snapshot.toString(2))
        report("fixture-instances=${instances.joinToString { "${it.mode.storageValue}:${it.appWidgetId}" }}")
    }

    @Test
    fun refreshInstalledFixtureWidgets() = runBlocking {
        val instances = installedInstances()
        assertTrue("没有已安装的 QA 小组件", instances.isNotEmpty())
        updateInstalledWidgets()
        cancelQaRefresh()
        report("fixture-refreshed count=${instances.size}")
    }

    @Test
    fun setCostMaskAndRefresh() = runBlocking {
        val enabled = arguments().getString("masked")?.toBooleanStrictOrNull()
            ?: error("missing boolean instrumentation argument: masked")
        PrivacyStore.setCostMaskEnabled(context, enabled)
        updateInstalledWidgets()
        cancelQaRefresh()

        val state = WidgetStateRepository(context).load(RangeKey.Today)
        assertTrue(state is WidgetState.Ready)
        installedInstances().forEach { instance ->
            val config = WidgetConfigStore.load(context, instance.appWidgetId, instance.mode)
            val description = widgetLayoutDescription(state, config, enabled)
            if (enabled) {
                assertTrue(description.contains(MASKED_COST))
                assertFalse(description.contains(RAW_COST))
            } else {
                assertTrue(description.contains(RAW_COST))
            }
        }
        report("fixture-cost-mask=$enabled raw-cost-present=${!enabled}")
    }

    @Test
    fun assertLauncherReconfigurationIsIsolated() {
        val baselineFile = File(context.filesDir, INSTANCE_BASELINE_FILE)
        assertTrue("缺少实例配置基线", baselineFile.isFile)
        val changedId = arguments().getString("widgetId")?.toIntOrNull()
            ?: error("missing integer instrumentation argument: widgetId")
        val expectedProvider = arguments().getString("providerId")?.takeUnless { it == "all" }
        val expectedRange = WidgetRange.fromStorage(arguments().getString("range"))
        val expectedTheme = WidgetThemeMode.fromStorage(arguments().getString("theme"))
        val before = JSONObject(baselineFile.readText()).getJSONArray("instances")
        val beforeById = (0 until before.length()).associate { index ->
            before.getJSONObject(index).getInt("appWidgetId") to before.getJSONObject(index)
        }
        val current = installedInstances()
        assertEquals(beforeById.keys, current.map { it.appWidgetId }.toSet())

        current.forEach { instance ->
            val config = WidgetConfigStore.load(context, instance.appWidgetId, instance.mode)
            if (instance.appWidgetId == changedId) {
                assertEquals(expectedProvider, config.providerId)
                assertEquals(expectedRange, config.range)
                assertEquals(expectedTheme, config.theme)
            } else {
                val original = beforeById.getValue(instance.appWidgetId)
                assertEquals(original.optString("providerId").ifBlank { null }, config.providerId)
                assertEquals(original.getString("range"), config.range.storageValue)
                assertEquals(original.getString("theme"), config.theme.storageValue)
                assertEquals(original.getString("mode"), config.mode.storageValue)
            }
        }
        report("fixture-config-isolated changed=$changedId total=${current.size}")
    }

    @Test
    fun cleanupFixtureAndRestoreQaState() = runBlocking {
        cancelQaRefresh()
        restoreQaState()
        File(context.filesDir, INSTANCE_BASELINE_FILE).delete()
        if (installedInstances().isNotEmpty()) updateInstalledWidgets()
        cancelQaRefresh()
        report("fixture-cleaned restored=true refresh=cancelled")
    }

    private suspend fun updateInstalledWidgets() {
        val manager = GlanceAppWidgetManager(context)
        manager.getGlanceIds(TokenLedgerWidget::class.java).forEach { glanceId ->
            TokenLedgerWidget().update(context, glanceId)
        }
    }

    private fun installedInstances(): List<FixtureInstance> {
        val manager = AppWidgetManager.getInstance(context)
        return WIDGET_TARGETS.flatMap { target ->
            manager.getAppWidgetIds(ComponentName(context, target.receiver)).map { id ->
                FixtureInstance(id, target.mode)
            }
        }.distinctBy(FixtureInstance::appWidgetId).sortedBy(FixtureInstance::appWidgetId)
    }

    private fun instanceSnapshot(instances: List<FixtureInstance>): JSONObject = JSONObject().put(
        "instances",
        JSONArray().apply {
            instances.forEach { instance ->
                val config = WidgetConfigStore.load(context, instance.appWidgetId, instance.mode)
                put(JSONObject()
                    .put("appWidgetId", instance.appWidgetId)
                    .put("mode", config.mode.storageValue)
                    .put("providerId", config.providerId ?: "")
                    .put("range", config.range.storageValue)
                    .put("theme", config.theme.storageValue))
            }
        }
    )

    /** 一个来源的种子数据。四项加总必须回到 [fixtureStats] 里的 summary。 */
    private data class FixtureTool(
        val name: String,
        val model: String,
        val machine: String,
        val input: Long,
        val output: Long,
        val cached: Long,
        val requests: Long
    )

    private val fixtureTools = listOf(
        FixtureTool("codex", "gpt-5", "MacBook-Pro", 420_000_000L, 40_000_000L, 5_000_000L, 1_800L),
        FixtureTool("claude", "claude-opus-4", "MacBook-Pro", 270_000_000L, 26_000_000L, 4_000_000L, 1_300L),
        FixtureTool("gemini", "gemini-2.5-pro", "Windows-Workstation", 140_000_000L, 14_600_000L, 2_300_000L, 820L),
        FixtureTool("opencode", "qwen3-coder", "Windows-Workstation", 70_000_000L, 7_000_000L, 1_000_000L, 401L)
    )

    /** 按权重把一个总量摊到 count 个桶里，末位吃掉余数，保证分桶之和等于总量。 */
    private fun <T> spread(count: Int, total: Long, build: (index: Int, value: Long) -> T): List<T> {
        val weights = (0 until count).map { (((it * 37 + 11) % 23) + 6).toLong() }
        val weightSum = weights.sum().coerceAtLeast(1L)
        var left = total
        return (0 until count).map { index ->
            val value = if (index == count - 1) left else total * weights[index] / weightSum
            left -= value
            build(index, value)
        }
    }

    private fun fixtureStats(range: WidgetRange, timezoneId: String, today: LocalDate): StatsData {
        val summary = Summary(
            totalTokens = 987_600_000L,
            inputTokens = 900_000_000L,
            outputTokens = 87_600_000L,
            cachedTokens = 12_300_000L,
            cacheReadTokens = 10_000_000L,
            cacheWriteTokens = 2_300_000L,
            cacheSavedUsd = 321.0,
            totalCost = FIXTURE_COST_USD,
            totalRequests = 4_321L,
            avgTokensPerReq = 228_558L,
            cacheSplitKnown = true
        )
        val zone = runCatching { ZoneId.of(timezoneId) }.getOrDefault(ZoneId.systemDefault())
        val effectiveTotal = fixtureTools.sumOf { it.input + it.output }

        // 成本按有效 Token 摊分，末位吃掉余数——四项之和必须正好是 FIXTURE_COST_USD。
        val costs = fixtureTools.map { seed ->
            (FIXTURE_COST_USD * (seed.input + seed.output) / effectiveTotal * 100.0).toLong() / 100.0
        }.toMutableList()
        costs[costs.lastIndex] = FIXTURE_COST_USD - costs.dropLast(1).sum()
    // 按来源名索引成本，不要用 fixtureTools.indexOf(it)：那条路依赖 data class 结构相等，
    // 一旦两条种子恰好数值相同就会命中去重后的同一个下标。
    val costByTool = fixtureTools.mapIndexed { index, seed -> seed.name to costs[index] }.toMap()

        val tools = fixtureTools.mapIndexed { index, seed ->
            val cacheRead = seed.cached * 4 / 5
            seed.name to ToolStat(
                name = seed.name,
                input = seed.input,
                output = seed.output,
                cached = seed.cached,
                // total 是有效 Token（输入+输出），缓存单列不重复计入。
                total = seed.input + seed.output,
                cost = costs[index],
                requests = seed.requests,
                cacheRead = cacheRead,
                cacheWrite = seed.cached - cacheRead,
                models = mapOf(seed.model to seed.input + seed.output)
            )
        }.toMap()

        val models = fixtureTools.mapIndexed { index, seed ->
            val cacheRead = seed.cached * 4 / 5
            seed.model to ModelStat(
                name = seed.model,
                total = seed.input + seed.output,
                requests = seed.requests,
                input = seed.input,
                output = seed.output,
                cached = seed.cached,
                cost = costs[index],
                cacheRead = cacheRead,
                cacheWrite = seed.cached - cacheRead
            )
        }.toMap()

        // 120 天热力：留出空闲日，否则日历上"活跃天"会等于覆盖天数，看不出疏密。
        val heatmap = (0 until 120).associate { offset ->
            val date = today.minusDays((119 - offset).toLong())
            val idle = offset % 13 == 0 || (date.dayOfWeek.value >= 6 && offset % 3 == 0)
            date.toString() to if (idle) 0L else ((offset * 137L + offset % 7 * 613L) % 900L + 60L) * 100_000L
        }

        val trendDays = when (range) {
            WidgetRange.Today -> 1
            WidgetRange.Week -> 7
            WidgetRange.Month -> 30
        }
        val trends = (0 until trendDays).map { offset ->
            val date = today.minusDays((trendDays - 1 - offset).toLong())
            val dayTokens = heatmap[date.toString()] ?: 0L
            TrendPoint(
                date = date.toString(),
                values = fixtureTools.associate { seed ->
                    seed.name to dayTokens * (seed.input + seed.output) / effectiveTotal
                },
                requests = dayTokens / 200_000L
            )
        }

        // 今日走 24 小时桶（契约里 bucket=hour 的 series 标签形如 "00:00"），
        // 本周/本月走日桶。窗口 kind 必须是契约的闭合枚举，写 "fixture" 会被当成
        // "无自动基线"，同期对比整块就哑了——前七批看到的正是这个。
        val hourly = range == WidgetRange.Today
        val currentBuckets = if (hourly) 18 else trendDays
        val previousBuckets = if (hourly) 24 else trendDays
        fun label(index: Int, count: Int): String =
            if (hourly) {
                String.format(Locale.US, "%02d:00", index)
            } else {
                today.minusDays((count - 1 - index).toLong()).toString()
            }

        val currentRequests = spread(currentBuckets, summary.totalRequests) { _, value -> value }
        val currentCosts = spread(currentBuckets, (FIXTURE_COST_USD * 100).toLong()) { _, value -> value }
        val currentSeries = spread(currentBuckets, summary.totalTokens) { index, tokens ->
            ComparisonSeriesPoint(
                bucket = label(index, currentBuckets),
                tokens = tokens,
                requests = currentRequests[index],
                cost = currentCosts[index] / 100.0
            )
        }

        val previousSummary = summary.copy(
            totalTokens = 887_600_000L,
            inputTokens = 800_000_000L,
            totalRequests = 4_000L,
            totalCost = FIXTURE_COST_USD - 100.0,
            avgTokensPerReq = 221_900L
        )
        val previousRequests = spread(previousBuckets, previousSummary.totalRequests) { _, value -> value }
        val previousCosts = spread(previousBuckets, (previousSummary.totalCost * 100).toLong()) { _, value -> value }
        val previousSeries = spread(previousBuckets, previousSummary.totalTokens) { index, tokens ->
            ComparisonSeriesPoint(
                bucket = label(index, previousBuckets),
                tokens = tokens,
                requests = previousRequests[index],
                cost = previousCosts[index] / 100.0
            )
        }

        val history = (0 until 12).map { index ->
            val seed = fixtureTools[index % fixtureTools.size]
            val at = today.atStartOfDay(zone).plusHours(8L + index).toOffsetDateTime().toString()
            LogHistoryItem(
                id = 1_000L + index,
                tool = seed.name,
                model = seed.model,
                inputTokens = seed.input / 40,
                outputTokens = seed.output / 40,
                cachedTokens = seed.cached / 40,
                cacheWriteTokens = seed.cached / 200,
                cost = costs[index % costs.size] / 40.0,
                timestamp = at,
                sessionId = "session-${1_000 + index}",
                machineId = seed.machine,
                requests = seed.requests / 40
            )
        }
        val detailsPage = UsageDetailsPage(
            items = history,
            nextCursor = null,
            hasMore = false,
            totalCount = history.size.toLong(),
            filteredSummary = summary,
            availableFilters = AvailableFilters(
                tools = fixtureTools.map { FilterOption(it.name, it.requests) },
                models = fixtureTools.map { FilterOption(it.model, it.requests) },
                machines = fixtureTools.groupBy { it.machine }
                    .map { (machine, group) -> FilterOption(machine, group.sumOf { it.requests }) }
            )
        )

        val machineDistribution = fixtureTools.groupBy { it.machine }.map { (machine, group) ->
            CompositionEntry(
                value = machine,
                tokens = group.sumOf { it.input + it.output },
                inputTokens = group.sumOf { it.input },
                outputTokens = group.sumOf { it.output },
                cachedTokens = group.sumOf { it.cached },
                requests = group.sumOf { it.requests },
                cost = group.sumOf { costByTool.getValue(it.name) }
            )
        }

        val costDays = (0 until 30).map { offset ->
            val date = today.minusDays((29 - offset).toLong())
            val tokens = heatmap[date.toString()] ?: 0L
            DailyCostDay(
                date = date.toString(),
                amountUsd = if (tokens == 0L) 0.0 else tokens / 6_000.0,
                status = DailyCostStatus.RecordedEstimate
            )
        }

        return StatsData(
            summary = summary,
            tools = tools,
            models = models,
            trends = trends,
            heatmap = heatmap,
            history = history,
            machines = fixtureTools.map { it.machine }.distinct(),
            meta = StatsMeta(
                generatedAt = Instant.now().toString(),
                lastRefreshedAt = Instant.now().toString(),
                timezone = timezoneId,
                range = range.rangeKey.rpcValue,
                machine = null,
                stale = false,
                contractVersion = 2,
                query = StatsQueryEcho(
                    range = range.rangeKey.rpcValue,
                    timezone = timezoneId,
                    tokenMode = "effective"
                )
            ),
            comparison = UsageComparison(
                window = ComparisonWindow(
                    kind = when (range) {
                        WidgetRange.Today -> "dayOverDay"
                        WidgetRange.Week -> "weekOverWeek"
                        WidgetRange.Month -> "monthOverMonth"
                    },
                    timezone = timezoneId,
                    bucket = if (hourly) "hour" else "day",
                    currentStart = today.minusDays((currentBuckets - 1).toLong())
                        .atStartOfDay(zone).toOffsetDateTime().toString(),
                    currentEnd = today.atStartOfDay(zone).plusHours(23).toOffsetDateTime().toString(),
                    previousStart = today.minusDays((previousBuckets * 2 - 1).toLong())
                        .atStartOfDay(zone).toOffsetDateTime().toString(),
                    previousEnd = today.minusDays(previousBuckets.toLong())
                        .atStartOfDay(zone).plusHours(23).toOffsetDateTime().toString(),
                    alignedThrough = today.atStartOfDay(zone).plusHours(17).toOffsetDateTime().toString()
                ),
                current = ComparisonPeriod(summary, currentSeries),
                previous = ComparisonPeriod(previousSummary, previousSeries),
                delta = ComparisonDelta(
                    tokens = MetricDelta(100_000_000.0, 12.7, "up"),
                    requests = MetricDelta(321.0, 8.0, "up"),
                    cost = MetricDelta(100.0, 3.0, "up")
                )
            ),
            detailsPage = detailsPage,
            capabilities = DashboardCapabilities(
                comparison = true,
                details = true,
                entityDashboard = true,
                multiFilterSearch = true
            ),
            machineDistribution = machineDistribution,
            dailyCosts = DailyCosts(
                coverage = DailyCostsCoverage(
                    start = today.minusDays(29).toString(),
                    end = today.toString(),
                    timezone = timezoneId,
                    state = DailyCostsCoverageState.Complete
                ),
                days = costDays
            )
        )
    }

    private fun fixtureQuota(now: Instant): QuotaTransportSnapshot {
        fun window(
            providerId: String,
            id: String,
            label: String,
            minutes: Int,
            available: Double
        ) = QuotaWindowSnapshot(
            providerId = providerId,
            windowId = id,
            windowLabel = label,
            scope = QuotaScope.ConsumerSubscription,
            source = QuotaSource.LocalAuthorized,
            status = QuotaWindowStatus.Ok,
            used = 100.0 - available,
            limit = 100.0,
            remaining = available,
            unit = QuotaUnit.Percent,
            windowMinutes = minutes,
            resetsAt = now.plusSeconds(86_400L).toString(),
            observedAt = now.toString(),
            fetchedAt = now.toString(),
            staleAfterSeconds = 86_400,
            reasonCode = null
        )
        fun provider(id: String, name: String, windows: List<QuotaWindowSnapshot>) =
            QuotaProviderEnvelope(
                schemaVersion = 1,
                providerId = id,
                displayName = name,
                scope = QuotaScope.ConsumerSubscription,
                mode = QuotaMode.Automatic,
                capability = QuotaCapability.Stable,
                status = QuotaProviderStatus.Ok,
                windows = windows,
                reasonCode = null
            )

        val codexId = "openai-codex-local"
        val claudeId = "anthropic-claude-consumer"
        val antigravityId = "google-antigravity-consumer"
        val teamId = "fixture-team-plan"
        return QuotaTransportSnapshot(
            transportVersion = QUOTA_TRANSPORT_VERSION,
            epoch = 42L,
            revision = 7L,
            generatedAt = now.toString(),
            providers = listOf(
                provider(codexId, "Codex", listOf(
                    window(codexId, "five-hour", "5 小时窗口", 300, 72.5),
                    window(codexId, "week", "7 天窗口", 10_080, 45.0),
                    window(codexId, "month", "30 天窗口", 43_200, 30.0)
                )),
                provider(claudeId, "Claude", listOf(window(claudeId, "five-hour", "5 小时窗口", 300, 18.0))),
                provider(antigravityId, "Antigravity", listOf(window(antigravityId, "five-hour", "5 小时窗口", 300, 4.0))),
                provider(teamId, "Fixture Team", listOf(window(teamId, "day", "每日窗口", 1_440, 63.0)))
            )
        )
    }

    private fun backupQaStateOnce() {
        val backup = File(context.filesDir, BACKUP_FILE)
        check(!backup.exists()) { "QA fixture backup already exists; refuse to overwrite" }
        val aliases = KEY_ALIASES.associateWith(::keyAliasExists)
        val prefs = JSONArray().apply {
            BACKED_UP_PREFS.forEach { name -> put(snapshotPreferences(name)) }
        }
        backup.writeText(JSONObject()
            .put("schema", 1)
            .put("preferences", prefs)
            .put("keyAliases", JSONObject(aliases))
            .toString(2))
    }

    private fun snapshotPreferences(name: String): JSONObject {
        val values = JSONArray()
        context.getSharedPreferences(name, Context.MODE_PRIVATE).all.forEach { (key, value) ->
            val entry = JSONObject().put("key", key)
            when (value) {
                is String -> entry.put("type", "string").put("value", value)
                is Boolean -> entry.put("type", "boolean").put("value", value)
                is Long -> entry.put("type", "long").put("value", value)
                is Int -> entry.put("type", "int").put("value", value)
                is Float -> entry.put("type", "float").put("value", value.toDouble())
                is Set<*> -> entry.put("type", "strings").put("value", JSONArray(value.filterIsInstance<String>()))
                else -> error("unsupported preference type for $name/$key")
            }
            values.put(entry)
        }
        return JSONObject().put("name", name).put("values", values)
    }

    private fun restoreQaState() {
        val backup = File(context.filesDir, BACKUP_FILE)
        check(backup.isFile) { "missing QA fixture backup" }
        val root = JSONObject(backup.readText())
        val prefs = root.getJSONArray("preferences")
        repeat(prefs.length()) { restorePreferences(prefs.getJSONObject(it)) }
        val aliases = root.getJSONObject("keyAliases")
        KEY_ALIASES.forEach { alias ->
            if (!aliases.getBoolean(alias) && keyAliasExists(alias)) {
                KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
            }
        }
        backup.delete()
    }

    private fun restorePreferences(snapshot: JSONObject) {
        val editor = context.getSharedPreferences(snapshot.getString("name"), Context.MODE_PRIVATE)
            .edit().clear()
        val values = snapshot.getJSONArray("values")
        repeat(values.length()) { index ->
            val entry = values.getJSONObject(index)
            val key = entry.getString("key")
            when (entry.getString("type")) {
                "string" -> editor.putString(key, entry.getString("value"))
                "boolean" -> editor.putBoolean(key, entry.getBoolean("value"))
                "long" -> editor.putLong(key, entry.getLong("value"))
                "int" -> editor.putInt(key, entry.getInt("value"))
                "float" -> editor.putFloat(key, entry.getDouble("value").toFloat())
                "strings" -> {
                    val valuesArray = entry.getJSONArray("value")
                    editor.putStringSet(key, (0 until valuesArray.length()).map(valuesArray::getString).toSet())
                }
                else -> error("unsupported preference backup type")
            }
        }
        check(editor.commit())
    }

    private fun clearPreferences(name: String) {
        check(context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit())
    }

    private fun cancelQaRefresh() {
        WorkManager.getInstance(context).cancelAllWork().result.get(20, TimeUnit.SECONDS)
    }

    private fun keyAliasExists(alias: String): Boolean =
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.containsAlias(alias)

    private fun arguments(): Bundle = InstrumentationRegistry.getArguments()

    private fun report(message: String) {
        instrumentation.sendStatus(0, Bundle().apply { putString("stream", "T10.118d $message\n") })
    }

    private data class FixtureInstance(val appWidgetId: Int, val mode: WidgetMode)
    private data class WidgetTarget(
        val receiver: Class<out androidx.glance.appwidget.GlanceAppWidgetReceiver>,
        val mode: WidgetMode
    )

    private companion object {
        const val QA_PACKAGE = "com.jeidorf.tokenledger.mobile.qa"
        const val FIXTURE_USER = "t10-118d-fixture-user"
        const val FIXTURE_COST_USD = 17_866.71388888889
        const val RAW_COST = "¥128,640.34"
        const val MASKED_COST = "¥***.*"
        const val BACKUP_FILE = "t10-118d-launcher-r1-qa-backup.json"
        const val INSTANCE_BASELINE_FILE = "t10-118d-launcher-r1-instance-baseline.json"

        val SESSION_AND_CACHE_PREFS = listOf(
            "tokenledger_mobile_session",
            "tokenledger_dashboard_cache",
            "tokenledger_quota_cache"
        )
        val BACKED_UP_PREFS = SESSION_AND_CACHE_PREFS + "tokenledger_privacy"
        val KEY_ALIASES = listOf(
            "tokenledger_mobile_session_key",
            "tokenledger_dashboard_cache_key",
            "tokenledger_quota_cache_key"
        )
        val WIDGET_TARGETS = listOf(
            WidgetTarget(TokenLedgerWidgetReceiver::class.java, WidgetMode.BarUsage),
            WidgetTarget(TokenLedgerRingWidgetReceiver::class.java, WidgetMode.MultiRing),
            WidgetTarget(TokenLedgerBarWidgetReceiver::class.java, WidgetMode.SingleUsage),
            WidgetTarget(TokenLedgerComboWidgetReceiver::class.java, WidgetMode.BarUsage),
            WidgetTarget(TokenLedgerQuotaWidgetReceiver::class.java, WidgetMode.QuotaBars)
        )
    }
}
