package com.jeidorf.tokenledger.mobile.dimensions

import com.jeidorf.tokenledger.mobile.BuildConfig
import com.jeidorf.tokenledger.mobile.CanonicalDashboardQuery
import com.jeidorf.tokenledger.mobile.MobileSession
import com.jeidorf.tokenledger.mobile.SupabaseGateway
import com.jeidorf.tokenledger.mobile.SupabaseHttpException
import com.jeidorf.tokenledger.mobile.USAGE_DIMENSIONS_READ_FUNCTION
import com.jeidorf.tokenledger.mobile.isMissingRpcSignature
import java.math.BigDecimal
import java.time.LocalDate
import org.json.JSONException
import org.json.JSONObject

/**
 * 云端用量维度（契约 docs/contracts/usage-dimensions-cloud-v1.md）。三个维度由桌面各自开关上传，
 * 默认关闭，云端只保留最近 90 天；任何一个维度缺了都如实说，不从 `token_logs` 推算。
 */
internal data class UsageDimensions(
    val start: LocalDate,
    val end: LocalDate,
    val timezone: String,
    val retentionDays: Int,
    val coverageStart: LocalDate,
    val sessions: DimensionPart<CloudSessions>,
    val providers: DimensionPart<List<CloudProvider>>,
    val context: DimensionPart<CloudContextComposition>
) {
    /** 查询区间有一部分早于云端保留期，这部分没有数据。 */
    val rangeBeforeRetention: Boolean get() = start < coverageStart
}

/** 维度状态：有数据 / 桌面没开或区间内没有 / 当前筛选下云端给不出。 */
internal sealed interface DimensionPart<out T> {
    data class Ok<T>(val value: T) : DimensionPart<T>
    data object Empty : DimensionPart<Nothing>
    data object Filtered : DimensionPart<Nothing>
}

internal data class CloudSessions(
    val sessionCount: Long,
    val truncatedDays: Long,
    val sessionLimit: Int,
    val rows: List<CloudSession>
)

internal data class CloudSession(
    val id: String,
    val machine: String,
    val tool: String,
    val tokens: Long,
    val requests: Long,
    /** 美元；任一天不可估价时为 null，不当 0。 */
    val cost: Double?,
    val days: Long,
    val firstDate: LocalDate,
    val lastDate: LocalDate,
    val firstAt: String,
    val lastAt: String,
    val topModel: String?
)

internal data class CloudProvider(
    /** 白名单规范名或 `other`。 */
    val provider: String,
    val input: Long,
    val output: Long,
    val cached: Long,
    val cacheWrite: Long,
    val total: Long,
    val requests: Long,
    val cost: Double?
) {
    val isOther: Boolean get() = provider == CLOUD_PROVIDER_OTHER
}

internal const val CLOUD_PROVIDER_OTHER = "other"

/** 与 dashboard-stats-v2 §2.8 同形；平均值由读者用 [requests] 相除。 */
internal data class CloudContextComposition(
    val requests: Long,
    val promptTokens: Long,
    val systemBytes: Long,
    val toolsBytes: Long,
    val historyBytes: Long,
    val toolResultsBytes: Long,
    val attachmentsBytes: Long,
    val messages: Long,
    val toolResults: Long,
    val attachments: Long
)

internal class UsageDimensionsFormatException(message: String) : IllegalArgumentException(message)

private val HH_MM = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")
private val SESSION_KEY = Regex("^[0-9a-f]{32}$")
private val ALLOWED_PROVIDERS = setOf(
    "anthropic", "ark", "deepseek", "gemini", "glm", "groq", "kimi", "lmstudio", "mistral",
    "ollama", "openai", "openrouter", "qwen", "siliconflow", "xai", CLOUD_PROVIDER_OTHER
)

internal object UsageDimensionsJson {
    /** 严格按契约解析：任何一个维度不合规就整体拒绝，不拿部分结果当完整结果。 */
    fun parse(raw: String): UsageDimensions = try {
        val root = JSONObject(raw)
        val meta = root.getJSONObject("meta")
        if (meta.optString("source") != "cloud") throw UsageDimensionsFormatException("meta.source must be cloud")
        val retention = count(meta, "retentionDays")
        if (retention !in 1L..3_650L) throw UsageDimensionsFormatException("retentionDays out of range")
        UsageDimensions(
            start = date(meta.getString("start")),
            end = date(meta.getString("end")),
            timezone = meta.getString("timezone"),
            retentionDays = retention.toInt(),
            coverageStart = date(meta.getString("coverageStart")),
            sessions = part(root.getJSONObject("sessions"), ::sessions),
            providers = part(root.getJSONObject("providers"), ::providers),
            context = part(root.getJSONObject("contextComposition"), ::context)
        )
    } catch (error: JSONException) {
        throw UsageDimensionsFormatException(error.message ?: "malformed usage dimensions")
    }

    private fun <T> part(obj: JSONObject, read: (JSONObject) -> T): DimensionPart<T> =
        when (val state = obj.getString("state")) {
            "ok" -> DimensionPart.Ok(read(obj))
            "empty" -> DimensionPart.Empty
            "filtered" -> DimensionPart.Filtered
            else -> throw UsageDimensionsFormatException("unknown state: $state")
        }

    private fun sessions(obj: JSONObject): CloudSessions {
        val array = obj.getJSONArray("rows")
        val rows = (0 until array.length()).map { index ->
            val row = array.getJSONObject(index)
            val id = row.getString("id")
            if (!SESSION_KEY.matches(id)) throw UsageDimensionsFormatException("bad session id")
            val firstDate = date(row.getString("firstDate"))
            val lastDate = date(row.getString("lastDate"))
            if (firstDate > lastDate) throw UsageDimensionsFormatException("firstDate after lastDate")
            CloudSession(
                id = id,
                machine = text(row, "machine"),
                tool = text(row, "tool"),
                tokens = count(row, "tokens"),
                requests = positive(row, "requests"),
                cost = cost(row),
                days = positive(row, "days"),
                firstDate = firstDate,
                lastDate = lastDate,
                firstAt = clock(row, "firstAt"),
                lastAt = clock(row, "lastAt"),
                topModel = if (row.isNull("topModel")) null else text(row, "topModel")
            )
        }
        val limit = count(obj, "sessionLimit")
        val total = count(obj, "sessionCount")
        if (rows.size > limit || total < rows.size) throw UsageDimensionsFormatException("session count inconsistent")
        return CloudSessions(total, count(obj, "truncatedDays"), limit.toInt(), rows)
    }

    private fun providers(obj: JSONObject): List<CloudProvider> {
        val array = obj.getJSONArray("rows")
        return (0 until array.length()).map { index ->
            val row = array.getJSONObject(index)
            val provider = row.getString("provider")
            if (provider !in ALLOWED_PROVIDERS) throw UsageDimensionsFormatException("provider not allowed")
            val input = count(row, "input")
            val output = count(row, "output")
            val total = count(row, "total")
            if (runCatching { Math.addExact(input, output) }.getOrNull() != total) {
                throw UsageDimensionsFormatException("provider total mismatch")
            }
            CloudProvider(provider, input, output, count(row, "cached"), count(row, "cacheWrite"), total, positive(row, "requests"), cost(row))
        }
    }

    private fun context(obj: JSONObject) = CloudContextComposition(
        requests = positive(obj, "requests"),
        promptTokens = count(obj, "promptTokens"),
        systemBytes = count(obj, "systemBytes"),
        toolsBytes = count(obj, "toolsBytes"),
        historyBytes = count(obj, "historyBytes"),
        toolResultsBytes = count(obj, "toolResultsBytes"),
        attachmentsBytes = count(obj, "attachmentsBytes"),
        messages = count(obj, "messages"),
        toolResults = count(obj, "toolResults"),
        attachments = count(obj, "attachments")
    )

    private fun date(value: String): LocalDate =
        runCatching { LocalDate.parse(value) }.getOrElse { throw UsageDimensionsFormatException("bad date: $value") }

    private fun text(obj: JSONObject, key: String): String {
        val value = obj.opt(key) as? String ?: throw UsageDimensionsFormatException("$key must be a string")
        if (value.isBlank() || value.length > 128) throw UsageDimensionsFormatException("$key length")
        return value
    }

    private fun clock(obj: JSONObject, key: String): String =
        text(obj, key).also { if (!HH_MM.matches(it)) throw UsageDimensionsFormatException("$key must be HH:MM") }

    private fun cost(obj: JSONObject): Double? {
        if (!obj.has("cost")) throw UsageDimensionsFormatException("cost missing")
        if (obj.isNull("cost")) return null
        val value = (obj.opt("cost") as? Number)?.toDouble() ?: throw UsageDimensionsFormatException("cost must be a number")
        if (!value.isFinite() || value < 0.0) throw UsageDimensionsFormatException("cost out of range")
        return value
    }

    private fun positive(obj: JSONObject, key: String): Long =
        count(obj, key).also { if (it < 1L) throw UsageDimensionsFormatException("$key must be positive") }

    private fun count(obj: JSONObject, key: String): Long {
        val raw = obj.opt(key) as? Number ?: throw UsageDimensionsFormatException("$key must be a number")
        val exact = runCatching { BigDecimal(raw.toString()).longValueExact() }.getOrNull()
            ?: throw UsageDimensionsFormatException("$key must be an integer")
        if (exact < 0L) throw UsageDimensionsFormatException("$key must not be negative")
        return exact
    }
}

/** 读取用量维度；测试里换成假实现。 */
internal fun interface UsageDimensionsSource {
    suspend fun fetch(session: MobileSession, query: CanonicalDashboardQuery): UsageDimensions
}

internal class UsageDimensionsRepository(
    private val gateway: SupabaseGateway = SupabaseGateway(
        supabaseUrl = BuildConfig.TOKENLEDGER_SUPABASE_URL,
        publishableKey = BuildConfig.TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY
    )
) : UsageDimensionsSource {
    override suspend fun fetch(session: MobileSession, query: CanonicalDashboardQuery): UsageDimensions =
        UsageDimensionsJson.parse(gateway.fetchUsageDimensions(session, query))
}

/** 读取失败的原因，决定页面上怎么说。 */
internal enum class DimensionsReadFailure {
    /** 云端还没部署用量维度接口（RPC 不存在）：如实说明，不当成错误。 */
    NotDeployed,
    Unauthorized,
    BadFormat,
    Unavailable;

    companion object {
        fun classify(error: Throwable): DimensionsReadFailure = when {
            error is UsageDimensionsFormatException -> BadFormat
            error is SupabaseHttpException && error.isMissingRpcSignature(USAGE_DIMENSIONS_READ_FUNCTION) -> NotDeployed
            error is SupabaseHttpException && (error.status == 401 || error.status == 403) -> Unauthorized
            else -> Unavailable
        }
    }
}
