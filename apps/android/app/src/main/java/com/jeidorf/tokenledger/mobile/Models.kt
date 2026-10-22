package com.jeidorf.tokenledger.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters

/** Token 派生加法遇到异常大值时饱和，避免 Long 回绕成负数并被静默丢弃。 */
internal fun safeTokenAdd(left: Long, right: Long): Long = when {
    left < 0L || right < 0L -> 0L
    else -> runCatching { Math.addExact(left, right) }.getOrElse { Long.MAX_VALUE }
}

/** 读取可选数值字段：缺失、null 或非法值返回 null，区别于 optLong/optDouble 的 0 默认值。 */
private fun JSONObject.optLongOrNull(name: String): Long? {
    if (!has(name) || isNull(name)) return null
    val decimal = when (val value = opt(name)) {
        is Byte, is Short, is Int, is Long -> BigDecimal.valueOf((value as Number).toLong())
        is Number -> value.toString().toBigDecimalOrNull()
        is String -> value.trim().takeIf(String::isNotEmpty)?.toBigDecimalOrNull()
        else -> null
    } ?: return null
    return runCatching { decimal.longValueExact() }.getOrNull()
}

private fun JSONObject.optFiniteNonNegativeDoubleOrNull(name: String): Double? {
    if (!has(name) || isNull(name)) return null
    val value = when (val raw = opt(name)) {
        is Number -> raw.toDouble()
        is String -> raw.toDoubleOrNull()
        else -> null
    }
    return value?.takeIf { it.isFinite() && it >= 0.0 }
}

/**
 * 严格数值读取：只接受 JSON number（拒绝字符串等其他类型），缺失/null/非有限值一律返回 null。
 * 用于 cacheSavings 的三个金额字段——契约要求「金额必须是有限的 JSON number，字符串不接受」。
 */
private fun JSONObject.strictFiniteDoubleOrNull(name: String): Double? {
    if (!has(name) || isNull(name)) return null
    val value = opt(name) as? Number ?: return null
    return value.toDouble().takeIf(Double::isFinite)
}

/** JS `Number.isSafeInteger` 的安全整数上界：2^53 − 1。 */
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

/**
 * 严格安全整数读取：只接受 JSON number 类型、值为整数、且落在 [0, 2^53−1]（与 TS
 * `tokenCount`/`Number.isSafeInteger` 对齐）。字符串（即便数值上合法）、小数、负数、
 * 超出安全整数范围的值、缺失、null 一律返回 null。用于 cacheSavings 的两个兜底计数与
 * 对象内部重新核验的拆分三元组（root R-36 P2-1）——既有的 optLongOrNull/longValue
 * 对字符串和小数更宽松，是为兼容旧端的拆分字段本身保留的，不在这里复用。
 */
private fun JSONObject.strictSafeIntegerOrNull(name: String): Long? {
    if (!has(name) || isNull(name)) return null
    val raw = opt(name) as? Number ?: return null
    val decimal = when (raw) {
        is Byte, is Short, is Int, is Long -> BigDecimal.valueOf(raw.toLong())
        else -> raw.toString().toBigDecimalOrNull() ?: return null
    }
    val exact = runCatching { decimal.longValueExact() }.getOrNull() ?: return null
    return exact.takeIf { it in 0L..MAX_SAFE_INTEGER }
}

enum class RangeKey(val rpcValue: String, val label: String) {
    Today("today", "今日"),
    Week("week", "本周"),
    Month("month", "本月"),
    Year("year", "今年"),
    All("all", "总计"),
    Custom("custom", "自定义")
}

data class Summary(
    val totalTokens: Long = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cachedTokens: Long = 0,
    /** 缓存读/写数值保留旧端兼容；是否显式存在必须看 cacheSplitKnown。 */
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
    /** 缓存读取节省（毛值，等于 cacheSavings?.readSavedUsd）。缺失/null/非法一律为 null，不得回退到 0（GLB-01）。 */
    val cacheSavedUsd: Double? = null,
    val totalCost: Double = 0.0,
    val totalRequests: Long = 0,
    val avgTokensPerReq: Long = 0,
    val cacheSplitKnown: Boolean = cacheReadTokens != 0L || cacheWriteTokens != 0L,
    /**
     * 缓存净节省明细（契约 §2.4，T10.162）。出现条件与 cacheReadTokens/cacheWriteTokens 完全相同：
     * 缺失即不可得，绝不补 0。追加在末尾以兼容既有 Kotlin 位置参数调用。
     */
    val cacheSavings: CacheSavings? = null
) {
    /**
     * 有效 Token（输入+输出），在客户端计算，因此即使云端仍是旧口径
     * （totalTokens 含缓存），主面板数字也一致正确。
     */
    val effectiveTokens: Long get() = safeTokenAdd(inputTokens, outputTokens)
}

/** 缓存净节省的价格来源：本机当前价格表，或云端按上传设备当时价格表冻结（B 期）。 */
enum class CacheSavingsPriceBasis(val wireValue: String) {
    LocalPrices("local-prices"),
    UploadedPrices("uploaded-prices")
}

/**
 * 缓存净节省明细（契约 `dashboard-stats-v2.md` §2.4，方案 `cache-savings-net-v1.md` §3.1/§4.1）。
 * `netSavedUsd` 可为负（写入溢价高于读取节省）；两个 fallback 字段是单价来自兜底而非价格表列价的
 * Token 数（非负整数，各自不超过同一 summary 的 cacheReadTokens/cacheWriteTokens）。
 */
data class CacheSavings(
    val readSavedUsd: Double,
    val writePremiumUsd: Double,
    val netSavedUsd: Double,
    val fallbackPricedReadTokens: Long,
    val fallbackPricedWriteTokens: Long,
    val priceBasis: CacheSavingsPriceBasis
)

data class ToolStat(
    val name: String,
    val input: Long,
    val output: Long,
    val cached: Long,
    val total: Long,
    val cost: Double,
    val requests: Long,
    /** 缺失表示来源无法证明；真实 0 必须保留为 0。 */
    val cacheRead: Long? = null,
    val cacheWrite: Long? = null,
    val models: Map<String, Long> = emptyMap(),
    val heatmap: Map<String, Long> = emptyMap()
) {
    /** 有效 Token（输入+输出），客户端计算，口径与桌面端一致。 */
    val effectiveTokens: Long get() = safeTokenAdd(input, output)
}

/** Token 为估算值（字符数推算）的工具，UI 以 ≈ 标注以示区分。 */
val ESTIMATED_TOOLS: Set<String> = setOf("antigravity", "trae")

data class ModelStat(
    val name: String,
    val total: Long,
    val requests: Long,
    val input: Long = 0,
    val output: Long = 0,
    val cached: Long = 0,
    /** 缺失表示费用不可得；真实 0 必须保留为 0.0。 */
    val cost: Double? = null,
    val heatmap: Map<String, Long> = emptyMap(),
    /** 缓存读/写拆分；来源未返回时为 null（缺失≠0，不得把合计伪装成命中缓存）。 */
    val cacheRead: Long? = null,
    val cacheWrite: Long? = null
) {
    /** 有效 Token（输入+输出），客户端计算，口径与桌面端一致；输入输出为 0 时不回退到 total。 */
    val effectiveTokens: Long get() = safeTokenAdd(input, output)
}

data class TrendPoint(
    val date: String,
    val values: Map<String, Long>,
    /** 该时间桶的请求数，来自新版 RPC 的保留键 __requests；旧版 RPC 没有该键时为 0。 */
    val requests: Long = 0
)

data class LogHistoryItem(
    val id: Long,
    val tool: String,
    val model: String,
    val inputTokens: Long,
    val outputTokens: Long,
    val cachedTokens: Long,
    val cacheWriteTokens: Long = 0,
    val cost: Double,
    val timestamp: String,
    val sessionId: String,
    val machineId: String,
    /** 云端详情页是小时聚合行；旧主 RPC 未返回时为 0。 */
    val requests: Long = 0
) {
    /** 有效 Token（输入+输出），客户端计算。 */
    val effectiveTokens: Long get() = safeTokenAdd(inputTokens, outputTokens)
}

/** v2 RPC capability is recorded per response; unavailable never means an empty metric. */
data class DashboardCapabilities(
    val comparison: Boolean = false,
    val details: Boolean = false,
    val entityDashboard: Boolean = false,
    val multiFilterSearch: Boolean = false,
    /** true 才表示生产者按 Stats v2 §2.4 生成了可信的缓存净节省对象。 */
    val cacheSavings: Boolean = false
)

data class StatsQueryEcho(
    val range: String? = null,
    val timezone: String? = null,
    val machine: String? = null,
    val tool: String? = null,
    val model: String? = null,
    val tokenMode: String? = null,
    val machines: List<String> = DashboardQueryContract.legacyMachineValues(machine),
    val tools: List<String> = DashboardQueryContract.legacyOptionalValues("tools", tool),
    val models: List<String> = DashboardQueryContract.legacyOptionalValues("models", model),
    val search: String? = null,
    val start: String? = null,
    val end: String? = null
)

data class ComparisonWindow(
    val kind: String,
    val timezone: String,
    val bucket: String,
    val currentStart: String?,
    val currentEnd: String?,
    val previousStart: String?,
    val previousEnd: String?,
    val alignedThrough: String?
)

data class ComparisonSeriesPoint(
    val bucket: String,
    val tokens: Long,
    val requests: Long,
    val cost: Double
)

data class ComparisonPeriod(
    val summary: Summary,
    val series: List<ComparisonSeriesPoint>
)

data class MetricDelta(
    val absolute: Double,
    val percent: Double?,
    val direction: String
)

data class ComparisonDelta(
    val tokens: MetricDelta,
    val requests: MetricDelta,
    val cost: MetricDelta
)

data class UsageComparison(
    val window: ComparisonWindow,
    val current: ComparisonPeriod,
    val previous: ComparisonPeriod,
    val delta: ComparisonDelta
)

data class FilterOption(val value: String, val count: Long)

data class AvailableFilters(
    val tools: List<FilterOption> = emptyList(),
    val models: List<FilterOption> = emptyList(),
    val machines: List<FilterOption> = emptyList()
)

data class UsageDetailsPage(
    val items: List<LogHistoryItem>,
    val nextCursor: String?,
    val hasMore: Boolean,
    val totalCount: Long,
    val filteredSummary: Summary,
    val availableFilters: AvailableFilters,
    val granularity: String = "hour"
) {
    fun append(next: UsageDetailsPage): UsageDetailsPage {
        val merged = (items + next.items).distinctBy { "${it.timestamp}|${it.id}" }
        return copy(
            items = merged,
            nextCursor = next.nextCursor,
            hasMore = next.hasMore,
            totalCount = next.totalCount,
            filteredSummary = next.filteredSummary,
            availableFilters = next.availableFilters,
            granularity = next.granularity
        )
    }
}

data class EntityDescriptor(
    val kind: String,
    val tool: String?,
    val model: String?,
    val id: String = model ?: tool ?: ""
) {
    val label: String get() = id.ifBlank { model ?: tool ?: "未知来源" }
}

data class CompositionEntry(
    val value: String,
    val tokens: Long,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cachedTokens: Long = 0,
    val cacheWriteTokens: Long? = null,
    val requests: Long = 0,
    /** 缺失表示费用不可得；真实 0 必须保留为 0.0。 */
    val cost: Double? = null,
    /** 追加在末尾以兼容既有 Kotlin 位置参数调用。 */
    val cacheReadTokens: Long? = null,
    /** 只有输入、输出字段均由数据源显式提供且有效时，才可展示有效 Token。 */
    val effectiveTokensAvailable: Boolean = true
) {
    /**
     * 有效 Token 严格等于输入+输出。null 表示数据源未提供完整拆分；不得回退到 tokens。
     * 显式提供的 0+0 由 effectiveTokensAvailable 保留为真实 0。
     */
    val effectiveTokens: Long?
        get() = if (effectiveTokensAvailable) safeTokenAdd(inputTokens, outputTokens) else null
}

data class EntityComposition(
    val tools: List<CompositionEntry> = emptyList(),
    val models: List<CompositionEntry> = emptyList(),
    val machines: List<CompositionEntry> = emptyList()
)

data class EntityPeak(
    val bucket: String?,
    val tokens: Long,
    val requests: Long,
    val cost: Double
)

data class EntityActivity(
    val activeDays: Long,
    val firstSeenAt: String?,
    val lastSeenAt: String?
)

data class EntityDashboard(
    val entity: EntityDescriptor,
    val summary: Summary,
    val comparison: UsageComparison?,
    val composition: EntityComposition,
    val heatmap: Map<String, Long>,
    val peak: EntityPeak,
    val activity: EntityActivity,
    val historyPage: UsageDetailsPage,
    val granularity: String = "hour"
)

data class StatsMeta(
    val generatedAt: String?,
    val lastRefreshedAt: String?,
    val timezone: String?,
    val range: String?,
    val machine: String?,
    val stale: Boolean,
    val contractVersion: Int = 1,
    val query: StatsQueryEcho? = null,
    val entity: DashboardEntity? = null
)

enum class DailyCostsCoverageState(val wireValue: String) {
    Complete("complete"),
    Partial("partial")
}

enum class DailyCostStatus(val wireValue: String) {
    RecordedEstimate("recorded-estimate"),
    Unavailable("unavailable")
}

enum class DailyCostUnavailableReason(val wireValue: String) {
    IncompleteCoverage("incomplete-coverage"),
    MissingCost("missing-cost"),
    InvalidCost("invalid-cost"),
    LegacyZero("legacy-zero")
}

data class DailyCostsCoverage(
    val start: String?,
    val end: String,
    val timezone: String,
    val state: DailyCostsCoverageState
)

data class DailyCostDay(
    val date: String,
    val amountUsd: Double?,
    val status: DailyCostStatus,
    val reason: DailyCostUnavailableReason? = null
)

data class DailyCosts(
    val coverage: DailyCostsCoverage,
    val days: List<DailyCostDay>
)

data class StatsData(
    val summary: Summary,
    val tools: Map<String, ToolStat>,
    val models: Map<String, ModelStat>,
    val trends: List<TrendPoint>,
    val heatmap: Map<String, Long>,
    val history: List<LogHistoryItem>,
    val machines: List<String>,
    val meta: StatsMeta?,
    /** true 表示本次数据来自旧版 3 参 RPC 回退（无时区参数，日界按 UTC 解析）。 */
    val legacyRpc: Boolean = false,
    val comparison: UsageComparison? = null,
    val detailsPage: UsageDetailsPage? = null,
    val entityDashboard: EntityDashboard? = null,
    val capabilities: DashboardCapabilities = DashboardCapabilities(),
    /** null 表示云端尚未支持 T6.3；空列表表示支持但当前查询没有设备数据。 */
    val machineDistribution: List<CompositionEntry>? = null,
    /** null 表示旧响应、缺字段或整个可选扩展未通过严格契约校验。 */
    val dailyCosts: DailyCosts? = null
)

data class MobileSession(
    val accessToken: String,
    val refreshToken: String,
    val userId: String,
    val email: String,
    val expiresAtEpochSeconds: Long
)

object StatsJson {
    fun parse(raw: String): StatsData {
        val root = JSONObject(raw)
        val summary = parseSummary(requireCoreSummary(root.optJSONObject("summary")))
        val tools = parseTools(root.optJSONObject("tools"))
        val models = parseModels(root.optJSONObject("models"))
        val trends = parseTrends(root.optJSONArray("trends"))
        val heatmap = parseLongMap(root.optJSONObject("heatmap"))
        val history = parseHistory(root.optJSONArray("history"))
        val machines = parseStringList(root.optJSONArray("machines"))
        val metaObject = root.optJSONObject("meta")
        val meta = metaObject?.let(::parseMeta)
        val comparison = root.optJSONObject("comparison")?.let(::parseComparison)
        return StatsData(
            summary = summary,
            tools = tools,
            models = models,
            trends = trends,
            heatmap = heatmap,
            history = history,
            machines = machines,
            meta = meta,
            machineDistribution = if (
                root.has("machineDistribution") && !root.isNull("machineDistribution")
            ) {
                parseComposition(root.optJSONArray("machineDistribution"))
            } else {
                null
            },
            legacyRpc = root.optBoolean("legacyRpc", false),
            comparison = comparison,
            // `historyPage` is the shared StatsData v2 contract name. Keep the
            // Android cache's older `detailsPage` alias readable during rollout.
            detailsPage = (root.optJSONObject("detailsPage")
                ?: root.optJSONObject("historyPage"))?.let(::parseDetailsPage),
            entityDashboard = root.optJSONObject("entityDashboard")?.let(::parseEntityDashboard),
            // Android caches historically stored capabilities at the root. New
            // network responses use the canonical `meta.capabilities` envelope.
            capabilities = (root.optJSONObject("capabilities")
                ?: metaObject?.optJSONObject("capabilities"))?.let(::parseCapabilities)
                ?: DashboardCapabilities(),
            dailyCosts = if (root.has("dailyCosts") && !root.isNull("dailyCosts")) {
                root.optJSONObject("dailyCosts")?.let {
                    parseDailyCosts(it, meta, root.optJSONObject("comparison")?.optJSONObject("window"))
                }
            } else {
                null
            }
        )
    }

    internal fun dailyCostsToJson(dailyCosts: DailyCosts): JSONObject = JSONObject()
        .put("coverage", JSONObject()
            .put("start", dailyCosts.coverage.start ?: JSONObject.NULL)
            .put("end", dailyCosts.coverage.end)
            .put("timezone", dailyCosts.coverage.timezone)
            .put("state", dailyCosts.coverage.state.wireValue))
        .put("days", JSONArray().apply {
            dailyCosts.days.forEach { day ->
                put(JSONObject()
                    .put("date", day.date)
                    .put("amountUsd", day.amountUsd ?: JSONObject.NULL)
                    .put("status", day.status.wireValue)
                    .apply { day.reason?.let { put("reason", it.wireValue) } })
            }
        })

    fun parseComparison(raw: String): UsageComparison? =
        raw.takeIf(String::isNotBlank)?.let { parseComparison(JSONObject(it)) }

    fun parseDetailsPage(raw: String): UsageDetailsPage = parseDetailsPage(JSONObject(raw))

    fun parseEntityDashboard(raw: String): EntityDashboard = parseEntityDashboard(JSONObject(raw))

    internal fun parseMeta(raw: String): StatsMeta? = JSONObject(raw)
        .optJSONObject("meta")
        ?.let(::parseMeta)

    internal fun comparisonToJson(comparison: UsageComparison): JSONObject = JSONObject()
        .put("window", JSONObject()
            .put("kind", comparison.window.kind)
            .put("timezone", comparison.window.timezone)
            .put("bucket", comparison.window.bucket)
            .putNullable("currentStart", comparison.window.currentStart)
            .putNullable("currentEnd", comparison.window.currentEnd)
            .putNullable("previousStart", comparison.window.previousStart)
            .putNullable("previousEnd", comparison.window.previousEnd)
            .putNullable("alignedThrough", comparison.window.alignedThrough))
        .put("current", periodToJson(comparison.current))
        .put("previous", periodToJson(comparison.previous))
        .put("delta", JSONObject()
            .put("tokens", deltaToJson(comparison.delta.tokens))
            .put("requests", deltaToJson(comparison.delta.requests))
            .put("cost", deltaToJson(comparison.delta.cost)))

    internal fun detailsPageToJson(page: UsageDetailsPage): JSONObject = JSONObject()
        .put("items", JSONArray().apply { page.items.forEach { put(historyToJson(it)) } })
        .putNullable("nextCursor", page.nextCursor)
        .put("hasMore", page.hasMore)
        .put("totalCount", page.totalCount)
        .put("filteredSummary", summaryToJson(page.filteredSummary))
        .put("availableFilters", JSONObject()
            .put("tools", filtersToJson(page.availableFilters.tools))
            .put("models", filtersToJson(page.availableFilters.models))
            .put("machines", filtersToJson(page.availableFilters.machines)))
        .put("granularity", page.granularity)

    internal fun entityDashboardToJson(dashboard: EntityDashboard): JSONObject = JSONObject()
        .put("entity", JSONObject()
            .put("kind", dashboard.entity.kind)
            .put("id", dashboard.entity.id)
            .putNullable("tool", dashboard.entity.tool)
            .putNullable("model", dashboard.entity.model))
        .put("summary", summaryToJson(dashboard.summary))
        .put("comparison", dashboard.comparison?.let(::comparisonToJson) ?: JSONObject.NULL)
        .put("composition", JSONObject()
            .put("tools", compositionToJson(dashboard.composition.tools))
            .put("models", compositionToJson(dashboard.composition.models))
            .put("machines", compositionToJson(dashboard.composition.machines)))
        .put("heatmap", JSONObject().apply {
            dashboard.heatmap.forEach { (key, value) -> put(key, value) }
        })
        .put("peak", JSONObject()
            .putNullable("bucket", dashboard.peak.bucket)
            .put("tokens", dashboard.peak.tokens)
            .put("requests", dashboard.peak.requests)
            .put("cost", dashboard.peak.cost))
        .put("activity", JSONObject()
            .put("activeDays", dashboard.activity.activeDays)
            .putNullable("firstSeenAt", dashboard.activity.firstSeenAt)
            .putNullable("lastSeenAt", dashboard.activity.lastSeenAt))
        .put("historyPage", detailsPageToJson(dashboard.historyPage))
        .put("granularity", dashboard.granularity)

    internal fun capabilitiesToJson(capabilities: DashboardCapabilities): JSONObject = JSONObject()
        .put("comparison", capabilities.comparison)
        .put("details", capabilities.details)
        .put("entityDashboard", capabilities.entityDashboard)
        .put("multiFilterSearch", capabilities.multiFilterSearch)
        .put("cacheSavings", capabilities.cacheSavings)

    internal fun parseSummary(obj: JSONObject?): Summary {
        if (obj == null) return Summary()
        val cachedTokens = obj.longValue("cachedTokens")
        val cacheReadTokens = obj.optLongOrNull("cacheReadTokens")
        val cacheWriteTokens = obj.optLongOrNull("cacheWriteTokens")
        val cacheSplitKnown = cacheReadTokens != null && cacheWriteTokens != null &&
            cachedTokens >= 0L && cacheReadTokens >= 0L && cacheWriteTokens >= 0L &&
            runCatching { Math.addExact(cacheReadTokens, cacheWriteTokens) }.getOrNull() == cachedTokens
        // 毛值（读取节省）：缺失、null 或非法一律不可得，不得回退到 0（GLB-01，方案 A1/D2）。
        val cacheSavedUsd = obj.optFiniteNonNegativeDoubleOrNull("cacheSavedUsd")
        // cacheSavings 的出现条件与 cacheReadTokens/cacheWriteTokens 完全相同（契约 §2.4）。
        val cacheSavings = if (cacheReadTokens != null && cacheWriteTokens != null && cacheSplitKnown) {
            parseCacheSavings(obj)
        } else {
            null
        }
        return Summary(
            totalTokens = obj.longValue("totalTokens"),
            inputTokens = obj.longValue("inputTokens"),
            outputTokens = obj.longValue("outputTokens"),
            cachedTokens = cachedTokens,
            cacheReadTokens = cacheReadTokens ?: 0L,
            cacheWriteTokens = cacheWriteTokens ?: 0L,
            cacheSavedUsd = cacheSavedUsd,
            totalCost = obj.doubleValue("totalCost"),
            totalRequests = obj.longValue("totalRequests"),
            avgTokensPerReq = obj.longValue("avgTokensPerReq"),
            cacheSplitKnown = cacheSplitKnown,
            cacheSavings = cacheSavings
        )
    }

    private const val CACHE_SAVINGS_TOLERANCE = 1e-6

    /**
     * 解析 summary.cacheSavings（契约 §2.4）：任一校验不满足就整体丢弃，保留旧核心字段
     * （含 cacheSavedUsd）；未知附加键忽略。调用方只在 cacheSplitKnown 为真时调用，但
     * 那是给既有拆分字段用的宽松判定（兼容字符串/小数），这里对 cacheSavings 依赖的
     * 拆分三元组重新做严格安全整数校验（root R-36 P2-1），只让新对象更严，不改
     * Summary.cacheReadTokens/cacheWriteTokens/cacheSplitKnown 本身的既有语义。
     */
    private fun parseCacheSavings(summary: JSONObject): CacheSavings? {
        val raw = summary.optJSONObject("cacheSavings") ?: return null
        val cachedTokens = summary.strictSafeIntegerOrNull("cachedTokens") ?: return null
        val cacheReadTokens = summary.strictSafeIntegerOrNull("cacheReadTokens") ?: return null
        val cacheWriteTokens = summary.strictSafeIntegerOrNull("cacheWriteTokens") ?: return null
        if (runCatching { Math.addExact(cacheReadTokens, cacheWriteTokens) }.getOrNull() != cachedTokens) return null
        val readSaved = raw.strictFiniteDoubleOrNull("readSavedUsd")?.takeIf { it >= 0.0 } ?: return null
        val writePremium = raw.strictFiniteDoubleOrNull("writePremiumUsd")?.takeIf { it >= 0.0 } ?: return null
        val netSaved = raw.strictFiniteDoubleOrNull("netSavedUsd") ?: return null
        val tolerance = CACHE_SAVINGS_TOLERANCE * maxOf(1.0, readSaved + writePremium)
        if (kotlin.math.abs(netSaved - (readSaved - writePremium)) > tolerance) return null
        val fallbackRead = raw.strictSafeIntegerOrNull("fallbackPricedReadTokens")
            ?.takeIf { it in 0L..cacheReadTokens } ?: return null
        val fallbackWrite = raw.strictSafeIntegerOrNull("fallbackPricedWriteTokens")
            ?.takeIf { it in 0L..cacheWriteTokens } ?: return null
        val priceBasis = CacheSavingsPriceBasis.entries.firstOrNull {
            it.wireValue == raw.optString("priceBasis", "")
        } ?: return null
        // cacheSavedUsd 键存在且非 JSON null 时必须有限、且与 readSavedUsd 在同一容差内一致，
        // 否则整个 cacheSavings 扩展作废；键缺失或显式 null 不影响 cacheSavings 是否可信——
        // 必须直接读原始 JSON 键（而不是外层已经过 optFiniteNonNegativeDoubleOrNull 折叠过的
        // 值），否则「缺失」与「存在但是字符串/NaN/负数等垃圾值」会被误判成同一种情况
        // （root R-26；对齐 codex/T10.183-cache-net-local 的
        // src/utils/contracts/statsQuery.ts::parseCacheSavings）。
        if (summary.has("cacheSavedUsd") && !summary.isNull("cacheSavedUsd")) {
            val cacheSavedUsd = summary.strictFiniteDoubleOrNull("cacheSavedUsd")
            if (cacheSavedUsd == null || kotlin.math.abs(cacheSavedUsd - readSaved) > tolerance) return null
        }
        return CacheSavings(
            readSavedUsd = readSaved,
            writePremiumUsd = writePremium,
            netSavedUsd = netSaved,
            fallbackPricedReadTokens = fallbackRead,
            fallbackPricedWriteTokens = fallbackWrite,
            priceBasis = priceBasis
        )
    }

    private fun requireCoreSummary(obj: JSONObject?): JSONObject {
        requireNotNull(obj) { "StatsData is missing required summary" }
        listOf(
            "totalTokens",
            "inputTokens",
            "outputTokens",
            "cachedTokens",
            "totalCost",
            "totalRequests",
            "avgTokensPerReq"
        ).forEach { key ->
            val value = obj.opt(key)
            require(value is Number && value.toDouble().isFinite() && value.toDouble() >= 0.0) {
                "StatsData summary.$key is invalid"
            }
        }
        return obj
    }

    private fun parseTools(obj: JSONObject?): Map<String, ToolStat> {
        if (obj == null) return emptyMap()
        val result = linkedMapOf<String, ToolStat>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val item = obj.optJSONObject(key) ?: continue
            result[key] = ToolStat(
                name = item.optString("name", key),
                input = item.longValue("input"),
                output = item.longValue("output"),
                cached = item.longValue("cached"),
                total = item.longValue("total"),
                cost = item.doubleValue("cost"),
                requests = item.longValue("requests"),
                cacheRead = item.optLongOrNull("cacheRead"),
                cacheWrite = item.optLongOrNull("cacheWrite"),
                models = parseLongMap(item.optJSONObject("models")),
                heatmap = parseLongMap(item.optJSONObject("heatmap"))
            )
        }
        return result
    }

    private fun parseModels(obj: JSONObject?): Map<String, ModelStat> {
        if (obj == null) return emptyMap()
        val result = linkedMapOf<String, ModelStat>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val item = obj.optJSONObject(key) ?: continue
            result[key] = ModelStat(
                name = item.optString("name", key),
                total = item.longValue("total"),
                requests = item.longValue("requests"),
                input = item.longValue("input"),
                output = item.longValue("output"),
                cached = item.longValue("cached"),
                cost = item.optFiniteNonNegativeDoubleOrNull("cost"),
                heatmap = parseLongMap(item.optJSONObject("heatmap")),
                cacheRead = item.optLongOrNull("cacheRead"),
                cacheWrite = item.optLongOrNull("cacheWrite")
            )
        }
        return result
    }

    private fun parseTrends(array: JSONArray?): List<TrendPoint> {
        if (array == null) return emptyList()
        return buildList {
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val date = item.optString("date")
                val values = linkedMapOf<String, Long>()
                val keys = item.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    // "date" 与 "__" 前缀是保留键（如 __requests），不属于工具序列。
                    if (key != "date" && !key.startsWith("__")) values[key] = item.longValue(key)
                }
                add(TrendPoint(date, values, requests = item.longValue("__requests")))
            }
        }
    }

    private fun parseHistory(array: JSONArray?): List<LogHistoryItem> {
        if (array == null) return emptyList()
        return buildList {
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                add(
                    LogHistoryItem(
                        id = item.longValue("id"),
                        tool = item.optString("tool"),
                        model = item.optString("model"),
                        inputTokens = item.longValue("inputTokens"),
                        outputTokens = item.longValue("outputTokens"),
                        cachedTokens = item.longValue("cachedTokens"),
                        cacheWriteTokens = item.longValue("cacheWriteTokens"),
                        cost = item.doubleValue("cost"),
                        timestamp = item.optString("timestamp"),
                        sessionId = item.optString("sessionId"),
                        machineId = item.optString("machineId"),
                        requests = item.longValue("requests")
                    )
                )
            }
        }
    }

    private fun parseComparison(obj: JSONObject): UsageComparison? {
        val window = obj.optJSONObject("window") ?: return null
        val current = obj.optJSONObject("current") ?: return null
        val previous = obj.optJSONObject("previous") ?: return null
        val delta = obj.optJSONObject("delta") ?: return null
        return UsageComparison(
            window = ComparisonWindow(
                kind = window.optString("kind"),
                timezone = window.optString("timezone"),
                bucket = window.optString("bucket"),
                currentStart = window.optNullableString("currentStart"),
                currentEnd = window.optNullableString("currentEnd"),
                previousStart = window.optNullableString("previousStart"),
                previousEnd = window.optNullableString("previousEnd"),
                alignedThrough = window.optNullableString("alignedThrough")
            ),
            current = parsePeriod(current),
            previous = parsePeriod(previous),
            delta = ComparisonDelta(
                tokens = parseDelta(delta.optJSONObject("tokens")),
                requests = parseDelta(delta.optJSONObject("requests")),
                cost = parseDelta(delta.optJSONObject("cost"))
            )
        )
    }

    private fun parseDailyCosts(
        obj: JSONObject,
        meta: StatsMeta?,
        comparisonWindow: JSONObject?
    ): DailyCosts? = runCatching {
        val coverageObject = obj.optJSONObject("coverage") ?: error("dailyCosts.coverage missing")
        val daysArray = obj.optJSONArray("days") ?: error("dailyCosts.days missing")
        val timezone = coverageObject.requiredString("timezone")
        val zone = ZoneId.of(timezone)
        val query = meta?.query ?: error("dailyCosts requires meta.query")
        require(meta.timezone == timezone && query.timezone == timezone)
        // Window metadata remains authoritative even when comparison periods are absent.
        require(comparisonWindow == null || !comparisonWindow.has("timezone") || comparisonWindow.opt("timezone") == timezone)
        val range = RangeKey.entries.firstOrNull { it.rpcValue == query.range }
            ?: error("dailyCosts query range invalid")

        val cutoffRaw = (comparisonWindow?.opt("currentEnd")?.takeUnless { it == JSONObject.NULL }
            ?: meta.generatedAt) as? String ?: error("dailyCosts cutoff missing or invalid")
        val cutoff = parseDailyCostsCutoff(cutoffRaw, zone)
            ?: error("dailyCosts cutoff invalid")
        val queryStart = query.start?.let(::parseDailyCostsDate)
        val queryEnd = query.end?.let(::parseDailyCostsDate)
        val expectedStart = when (range) {
            RangeKey.Today -> cutoff
            RangeKey.Week -> cutoff.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
            RangeKey.Month -> cutoff.withDayOfMonth(1)
            RangeKey.Year -> cutoff.withDayOfYear(1)
            RangeKey.All -> null
            RangeKey.Custom -> {
                require(queryStart != null && queryEnd != null && queryStart <= queryEnd)
                queryStart
            }
        }
        val expectedEnd = if (range == RangeKey.Custom) minOf(queryEnd!!, cutoff) else cutoff
        require(expectedStart == null || expectedStart <= expectedEnd)
        val coverageStartRaw = coverageObject.strictNullableString("start")
        val coverageEndRaw = coverageObject.requiredString("end")
        val coverageStart = coverageStartRaw?.let(::parseDailyCostsDate)
        val coverageEnd = parseDailyCostsDate(coverageEndRaw)
            ?: error("dailyCosts coverage end invalid")
        require(coverageStart == expectedStart && coverageEnd == expectedEnd)
        require((range == RangeKey.All) == (coverageStartRaw == null))

        val coverageState = DailyCostsCoverageState.entries.firstOrNull {
            it.wireValue == coverageObject.requiredString("state")
        } ?: error("dailyCosts coverage state invalid")
        var previousDate: LocalDate? = null
        val days = buildList {
            for (index in 0 until daysArray.length()) {
                val dayObject = daysArray.opt(index) as? JSONObject
                    ?: error("dailyCosts day must be object")
                val dateRaw = dayObject.requiredString("date")
                val date = parseDailyCostsDate(dateRaw) ?: error("dailyCosts day date invalid")
                val priorDate = previousDate
                require(priorDate == null || date > priorDate)
                require(date <= coverageEnd && (coverageStart == null || date >= coverageStart))
                previousDate = date

                val status = DailyCostStatus.entries.firstOrNull {
                    it.wireValue == dayObject.requiredString("status")
                } ?: error("dailyCosts day status invalid")
                val day = when (status) {
                    DailyCostStatus.RecordedEstimate -> {
                        val rawAmount = dayObject.opt("amountUsd")
                        require(rawAmount is Number)
                        val amount = rawAmount.toDouble()
                        require(amount.isFinite() && amount > 0.0)
                        require(!dayObject.has("reason"))
                        DailyCostDay(dateRaw, amount, status)
                    }
                    DailyCostStatus.Unavailable -> {
                        require(dayObject.has("amountUsd") && dayObject.isNull("amountUsd"))
                        val reason = DailyCostUnavailableReason.entries.firstOrNull {
                            it.wireValue == dayObject.requiredString("reason")
                        } ?: error("dailyCosts unavailable reason invalid")
                        DailyCostDay(dateRaw, null, status, reason)
                    }
                }
                if (coverageState == DailyCostsCoverageState.Partial) {
                    require(
                        day.status == DailyCostStatus.Unavailable &&
                            day.reason == DailyCostUnavailableReason.IncompleteCoverage
                    )
                }
                add(day)
            }
        }
        DailyCosts(
            coverage = DailyCostsCoverage(
                start = coverageStartRaw,
                end = coverageEndRaw,
                timezone = timezone,
                state = coverageState
            ),
            days = days
        )
    }.getOrNull()

    private fun parsePeriod(obj: JSONObject): ComparisonPeriod = ComparisonPeriod(
        summary = parseSummary(obj.optJSONObject("summary")),
        series = obj.optJSONArray("series").objects().map { point ->
            ComparisonSeriesPoint(
                bucket = point.optString("bucket"),
                tokens = point.longValue("tokens"),
                requests = point.longValue("requests"),
                cost = point.doubleValue("cost")
            )
        }
    )

    private fun parseDelta(obj: JSONObject?): MetricDelta = MetricDelta(
        absolute = obj?.doubleValue("absolute") ?: 0.0,
        percent = obj?.nullableDouble("percent"),
        direction = obj?.optString("direction", "flat") ?: "flat"
    )

    private fun parseDetailsPage(obj: JSONObject): UsageDetailsPage = UsageDetailsPage(
        items = parseHistory(obj.optJSONArray("items")),
        nextCursor = obj.optNullableString("nextCursor"),
        hasMore = obj.optBoolean("hasMore", false),
        totalCount = obj.longValue("totalCount"),
        filteredSummary = parseSummary(obj.optJSONObject("filteredSummary")),
        availableFilters = obj.optJSONObject("availableFilters")?.let { filters ->
            AvailableFilters(
                tools = parseFilters(filters.optJSONArray("tools")),
                models = parseFilters(filters.optJSONArray("models")),
                machines = parseFilters(filters.optJSONArray("machines"))
            )
        } ?: AvailableFilters(),
        granularity = obj.optString("granularity", "hour")
    )

    private fun parseFilters(array: JSONArray?): List<FilterOption> = array.objects().map {
        FilterOption(value = it.optString("value"), count = it.longValue("count"))
    }.filter { it.value.isNotBlank() }

    private fun parseEntityDashboard(obj: JSONObject): EntityDashboard {
        val entity = obj.optJSONObject("entity") ?: JSONObject()
        val composition = obj.optJSONObject("composition") ?: JSONObject()
        val peak = obj.optJSONObject("peak") ?: JSONObject()
        val activity = obj.optJSONObject("activity") ?: JSONObject()
        return EntityDashboard(
            entity = EntityDescriptor(
                kind = entity.optString("kind"),
                tool = entity.optNullableString("tool"),
                model = entity.optNullableString("model"),
                id = entity.optNullableString("id")
                    ?: entity.optNullableString("model")
                    ?: entity.optNullableString("tool")
                    ?: ""
            ),
            summary = parseSummary(obj.optJSONObject("summary")),
            comparison = obj.optJSONObject("comparison")?.let(::parseComparison),
            composition = EntityComposition(
                tools = parseComposition(composition.optJSONArray("tools")),
                models = parseComposition(composition.optJSONArray("models")),
                machines = parseComposition(composition.optJSONArray("machines"))
            ),
            heatmap = parseLongMap(obj.optJSONObject("heatmap")),
            peak = EntityPeak(
                bucket = peak.optNullableString("bucket"),
                tokens = peak.longValue("tokens"),
                requests = peak.longValue("requests"),
                cost = peak.doubleValue("cost")
            ),
            activity = EntityActivity(
                activeDays = activity.longValue("activeDays"),
                firstSeenAt = activity.optNullableString("firstSeenAt"),
                lastSeenAt = activity.optNullableString("lastSeenAt")
            ),
            historyPage = obj.optJSONObject("historyPage")?.let(::parseDetailsPage)
                ?: UsageDetailsPage(emptyList(), null, false, 0, Summary(), AvailableFilters()),
            granularity = obj.optString("granularity", "hour")
        )
    }

    private fun parseComposition(array: JSONArray?): List<CompositionEntry> = array.objects().map {
        val inputTokens = it.optLongOrNull("inputTokens")?.takeIf { value -> value >= 0L }
        val outputTokens = it.optLongOrNull("outputTokens")?.takeIf { value -> value >= 0L }
        CompositionEntry(
            value = it.optString("value"),
            tokens = it.longValue("tokens"),
            inputTokens = inputTokens ?: 0L,
            outputTokens = outputTokens ?: 0L,
            cachedTokens = it.longValue("cachedTokens"),
            cacheWriteTokens = it.optLongOrNull("cacheWriteTokens"),
            requests = it.longValue("requests"),
            cost = it.optFiniteNonNegativeDoubleOrNull("cost"),
            cacheReadTokens = it.optLongOrNull("cacheReadTokens"),
            effectiveTokensAvailable = inputTokens != null && outputTokens != null
        )
    }.filter { it.value.isNotBlank() }

    private fun parseCapabilities(obj: JSONObject): DashboardCapabilities = DashboardCapabilities(
        comparison = obj.optBoolean("comparison", false),
        details = obj.optBoolean(
            "detailPagination",
            obj.optBoolean("details", false)
        ),
        entityDashboard = obj.optBoolean("entityDashboard", false),
        multiFilterSearch = obj.optBoolean("multiFilterSearch", false),
        cacheSavings = obj.optBoolean("cacheSavings", false)
    )

    private fun parseQuery(obj: JSONObject): StatsQueryEcho = DashboardQueryContract.readEcho(obj)

    private fun parseMeta(obj: JSONObject): StatsMeta = StatsMeta(
        generatedAt = obj.optNullableString("generatedAt"),
        lastRefreshedAt = obj.optNullableString("lastRefreshedAt"),
        timezone = obj.optNullableString("timezone"),
        range = obj.optNullableString("range"),
        machine = obj.optNullableString("machine"),
        stale = obj.optBoolean("stale", false),
        contractVersion = obj.optInt("contractVersion", 1),
        query = obj.optJSONObject("query")?.let(::parseQuery),
        entity = obj.optJSONObject("entity")?.let { entity ->
            DashboardQueryContract.normalizeEntity(
                DashboardEntity(
                    kind = entity.optString("kind"),
                    id = entity.optString("id")
                )
            )
        }
    )

    private fun periodToJson(period: ComparisonPeriod): JSONObject = JSONObject()
        .put("summary", summaryToJson(period.summary))
        .put("series", JSONArray().apply {
            period.series.forEach { point ->
                put(JSONObject()
                    .put("bucket", point.bucket)
                    .put("tokens", point.tokens)
                    .put("requests", point.requests)
                    .put("cost", point.cost))
            }
        })

    private fun deltaToJson(delta: MetricDelta): JSONObject = JSONObject()
        .put("absolute", delta.absolute)
        .put("percent", delta.percent ?: JSONObject.NULL)
        .put("direction", delta.direction)

    private fun filtersToJson(filters: List<FilterOption>): JSONArray = JSONArray().apply {
        filters.forEach { put(JSONObject().put("value", it.value).put("count", it.count)) }
    }

    internal fun compositionToJson(entries: List<CompositionEntry>): JSONArray = JSONArray().apply {
        entries.forEach { entry ->
            put(JSONObject()
                .put("value", entry.value)
                .put("tokens", entry.tokens)
                .put("cachedTokens", entry.cachedTokens)
                .put("requests", entry.requests)
                .apply {
                    if (entry.effectiveTokensAvailable) {
                        put("inputTokens", entry.inputTokens)
                        put("outputTokens", entry.outputTokens)
                    }
                    entry.cacheReadTokens?.let { put("cacheReadTokens", it) }
                    entry.cacheWriteTokens?.let { put("cacheWriteTokens", it) }
                    entry.cost?.let { put("cost", it) }
                })
        }
    }

    internal fun summaryToJson(summary: Summary): JSONObject = JSONObject()
        .put("totalTokens", summary.totalTokens)
        .put("inputTokens", summary.inputTokens)
        .put("outputTokens", summary.outputTokens)
        .put("cachedTokens", summary.cachedTokens)
        .put("totalCost", summary.totalCost)
        .put("totalRequests", summary.totalRequests)
        .put("avgTokensPerReq", summary.avgTokensPerReq)
        .apply {
            // 未知一律不写键，而不是写 JSON null 或 0（修 D2：GLB-01 不可得不得存成 0）。
            summary.cacheSavedUsd?.let { put("cacheSavedUsd", it) }
            if (summary.cacheSplitKnown) {
                put("cacheReadTokens", summary.cacheReadTokens)
                put("cacheWriteTokens", summary.cacheWriteTokens)
                // 与解析侧对称：只有拆分成立时才可能写出 cacheSavings，避免序列化出
                // 「对象存在但拆分未证明」这种解析侧一定会丢弃的形状。
                summary.cacheSavings?.let { put("cacheSavings", cacheSavingsToJson(it)) }
            }
        }

    internal fun cacheSavingsToJson(cacheSavings: CacheSavings): JSONObject = JSONObject()
        .put("readSavedUsd", cacheSavings.readSavedUsd)
        .put("writePremiumUsd", cacheSavings.writePremiumUsd)
        .put("netSavedUsd", cacheSavings.netSavedUsd)
        .put("fallbackPricedReadTokens", cacheSavings.fallbackPricedReadTokens)
        .put("fallbackPricedWriteTokens", cacheSavings.fallbackPricedWriteTokens)
        .put("priceBasis", cacheSavings.priceBasis.wireValue)

    internal fun historyToJson(item: LogHistoryItem): JSONObject = JSONObject()
        .put("id", item.id)
        .put("tool", item.tool)
        .put("model", item.model)
        .put("inputTokens", item.inputTokens)
        .put("outputTokens", item.outputTokens)
        .put("cachedTokens", item.cachedTokens)
        .put("cacheWriteTokens", item.cacheWriteTokens)
        .put("cost", item.cost)
        .put("timestamp", item.timestamp)
        .put("sessionId", item.sessionId)
        .put("machineId", item.machineId)
        .put("requests", item.requests)

    private fun parseStringList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return buildList {
            for (i in 0 until array.length()) {
                val value = array.optString(i, "")
                if (value.isNotBlank()) add(value)
            }
        }
    }

    private fun parseLongMap(obj: JSONObject?): Map<String, Long> {
        if (obj == null) return emptyMap()
        val result = linkedMapOf<String, Long>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            result[key] = obj.longValue(key)
        }
        return result
    }
}

private fun JSONArray?.objects(): List<JSONObject> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until length()) optJSONObject(index)?.let(::add)
    }
}

private fun JSONObject.nullableDouble(key: String): Double? =
    if (!has(key) || isNull(key)) null else doubleValue(key)

private fun JSONObject.putNullable(key: String, value: String?): JSONObject =
    put(key, value ?: JSONObject.NULL)

fun JSONObject.optNullableString(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key)

fun JSONObject.longValue(key: String): Long {
    val value = opt(key) ?: return 0
    return when (value) {
        is Number -> value.toLong()
        is String -> value.toDoubleOrNull()?.toLong() ?: 0
        else -> 0
    }
}

fun JSONObject.doubleValue(key: String): Double {
    val value = opt(key) ?: return 0.0
    return when (value) {
        is Number -> value.toDouble()
        is String -> value.toDoubleOrNull() ?: 0.0
        else -> 0.0
    }
}

private fun JSONObject.requiredString(key: String): String {
    require(has(key) && !isNull(key))
    return (opt(key) as? String) ?: error("$key must be string")
}

private fun JSONObject.strictNullableString(key: String): String? {
    require(has(key))
    if (isNull(key)) return null
    return (opt(key) as? String) ?: error("$key must be string or null")
}

private val DAILY_COST_DATE_PATTERN = Regex("^\\d{4}-\\d{2}-\\d{2}$")
private val DAILY_COST_LOCAL_TIMESTAMP_PATTERN = Regex(
    "^(\\d{4}-\\d{2}-\\d{2})[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?$"
)
private val DAILY_COST_OFFSET_TIMESTAMP_PATTERN = Regex(
    "^(\\d{4}-\\d{2}-\\d{2})[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$"
)

private fun parseDailyCostsDate(raw: String): LocalDate? {
    if (!DAILY_COST_DATE_PATTERN.matches(raw)) return null
    return runCatching { LocalDate.parse(raw, DateTimeFormatter.ISO_LOCAL_DATE) }.getOrNull()
}

private fun parseDailyCostsCutoff(raw: String, zone: ZoneId): LocalDate? {
    val value = raw
    val normalized = value.replace(' ', 'T')
    if (DAILY_COST_LOCAL_TIMESTAMP_PATTERN.matches(value)) {
        return runCatching {
            LocalDateTime.parse(normalized, DateTimeFormatter.ISO_LOCAL_DATE_TIME).toLocalDate()
        }.getOrNull()
    }
    if (!DAILY_COST_OFFSET_TIMESTAMP_PATTERN.matches(value)) return null
    return runCatching {
        OffsetDateTime.parse(normalized, DateTimeFormatter.ISO_OFFSET_DATE_TIME)
            .atZoneSameInstant(zone)
            .toLocalDate()
    }.getOrNull()
}
