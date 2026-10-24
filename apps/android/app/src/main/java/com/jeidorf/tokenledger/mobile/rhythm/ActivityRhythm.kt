package com.jeidorf.tokenledger.mobile.rhythm

import com.jeidorf.tokenledger.mobile.ACTIVITY_RHYTHM_READ_FUNCTION
import com.jeidorf.tokenledger.mobile.BuildConfig
import com.jeidorf.tokenledger.mobile.CanonicalDashboardQuery
import com.jeidorf.tokenledger.mobile.MobileSession
import com.jeidorf.tokenledger.mobile.SupabaseGateway
import com.jeidorf.tokenledger.mobile.SupabaseHttpException
import com.jeidorf.tokenledger.mobile.isMissingRpcSignature
import java.math.BigDecimal
import java.time.DayOfWeek
import java.time.LocalDate
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * 云端活动节律（契约 docs/contracts/activity-rhythm-cloud-v1.md）。云端只有小时聚合，
 * 所以这里没有会话列表与请求大小；`tokens` 一律是有效 Token（输入 + 输出）。
 */
internal data class ActivityRhythm(
    val start: LocalDate,
    val end: LocalDate,
    val timezone: String,
    val rangeTruncated: Boolean,
    val summary: RhythmSummary,
    val tools: List<RhythmTool>,
    val dayHours: List<RhythmDayHour>,
    val modelHours: List<RhythmModelHour>
) {
    /** 0–23 时每小时的有效 Token 与记录数（所选范围内跨日合计）。 */
    val hourTotals: List<RhythmBucket> by lazy {
        val tokens = LongArray(24)
        val requests = LongArray(24)
        dayHours.forEach {
            tokens[it.hour] = safeAdd(tokens[it.hour], it.tokens)
            requests[it.hour] = safeAdd(requests[it.hour], it.requests)
        }
        (0 until 24).map { RhythmBucket(tokens[it], requests[it]) }
    }

    /** 星期（周一 = 0）× 小时的有效 Token；同一星期几的多天相加。 */
    val weekdayHourTokens: List<LongArray> by lazy {
        val grid = List(7) { LongArray(24) }
        dayHours.forEach {
            val row = grid[it.date.dayOfWeek.value - DayOfWeek.MONDAY.value]
            row[it.hour] = safeAdd(row[it.hour], it.tokens)
        }
        grid
    }

    /** 各模型的有效 Token 合计（由小时 × 模型汇总），降序。 */
    val modelTotals: List<Pair<String, Long>> by lazy {
        modelHours.groupBy { it.model }
            .map { (model, rows) -> model to rows.fold(0L) { sum, row -> safeAdd(sum, row.tokens) } }
            .sortedWith(compareByDescending<Pair<String, Long>> { it.second }.thenBy { it.first })
    }
}

internal data class RhythmSummary(
    val tokens: Long,
    val requests: Long,
    val cachedTokens: Long,
    val activeDays: Long,
    val toolCount: Long,
    val modelCount: Long
)

internal data class RhythmTool(val id: String, val tokens: Long, val requests: Long)
internal data class RhythmDayHour(val date: LocalDate, val hour: Int, val tokens: Long, val requests: Long)
internal data class RhythmModelHour(val hour: Int, val model: String, val tokens: Long, val requests: Long)
internal data class RhythmBucket(val tokens: Long, val requests: Long)

internal class ActivityRhythmFormatException(message: String) : IllegalArgumentException(message)

private fun safeAdd(left: Long, right: Long): Long =
    runCatching { Math.addExact(left, right) }.getOrElse { Long.MAX_VALUE }

internal object ActivityRhythmJson {
    /** 严格按契约解析；任何必填字段缺失或越界都整体拒绝，不拿部分数据当完整结果。 */
    fun parse(raw: String): ActivityRhythm = try {
        val root = JSONObject(raw)
        val meta = root.getJSONObject("meta")
        if (meta.optString("source") != "cloud") throw ActivityRhythmFormatException("meta.source must be cloud")
        val summary = root.getJSONObject("summary")
        ActivityRhythm(
            start = date(meta.getString("start")),
            end = date(meta.getString("end")),
            timezone = meta.getString("timezone"),
            rangeTruncated = meta.optBoolean("rangeTruncated", false),
            summary = RhythmSummary(
                tokens = count(summary, "tokens"),
                requests = count(summary, "requests"),
                cachedTokens = count(summary, "cachedTokens"),
                activeDays = count(summary, "activeDays"),
                toolCount = count(summary, "toolCount"),
                modelCount = count(summary, "modelCount")
            ),
            tools = root.getJSONArray("tools").objects().map {
                RhythmTool(it.getString("id"), count(it, "tokens"), count(it, "requests"))
            },
            dayHours = root.getJSONArray("dayHours").objects().map {
                RhythmDayHour(date(it.getString("date")), hour(it), count(it, "tokens"), count(it, "requests"))
            },
            modelHours = root.getJSONArray("modelHours").objects().map {
                RhythmModelHour(hour(it), it.getString("model"), count(it, "tokens"), count(it, "requests"))
            }
        )
    } catch (error: JSONException) {
        throw ActivityRhythmFormatException(error.message ?: "malformed activity rhythm")
    }

    private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

    private fun date(value: String): LocalDate =
        runCatching { LocalDate.parse(value) }.getOrElse { throw ActivityRhythmFormatException("bad date: $value") }

    private fun hour(obj: JSONObject): Int {
        val value = count(obj, "hour")
        if (value !in 0L..23L) throw ActivityRhythmFormatException("hour out of range")
        return value.toInt()
    }

    private fun count(obj: JSONObject, key: String): Long {
        val raw = obj.opt(key) as? Number ?: throw ActivityRhythmFormatException("$key must be a number")
        val exact = runCatching { BigDecimal(raw.toString()).longValueExact() }.getOrNull()
            ?: throw ActivityRhythmFormatException("$key must be an integer")
        if (exact < 0L) throw ActivityRhythmFormatException("$key must not be negative")
        return exact
    }
}

/** 读取活动节律；测试里换成假实现。 */
internal fun interface ActivityRhythmSource {
    suspend fun fetch(session: MobileSession, query: CanonicalDashboardQuery): ActivityRhythm
}

internal class ActivityRhythmRepository(
    private val gateway: SupabaseGateway = SupabaseGateway(
        supabaseUrl = BuildConfig.TOKENLEDGER_SUPABASE_URL,
        publishableKey = BuildConfig.TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY
    )
) : ActivityRhythmSource {
    override suspend fun fetch(session: MobileSession, query: CanonicalDashboardQuery): ActivityRhythm =
        ActivityRhythmJson.parse(gateway.fetchActivityRhythm(session, query))
}

/** 读取失败的原因，决定页面上怎么说。 */
internal enum class RhythmReadFailure {
    /** 云端还没部署活动节律接口（RPC 不存在）：如实说明，不当成错误。 */
    NotDeployed,
    /** 登录凭据过期或被拒；用量页刷新会续期。 */
    Unauthorized,
    /** 返回体不符合契约。 */
    BadFormat,
    /** 网络或服务暂时不可用。 */
    Unavailable;

    companion object {
        fun classify(error: Throwable): RhythmReadFailure = when {
            error is ActivityRhythmFormatException -> BadFormat
            error is SupabaseHttpException && error.isMissingRpcSignature(ACTIVITY_RHYTHM_READ_FUNCTION) -> NotDeployed
            error is SupabaseHttpException && (error.status == 401 || error.status == 403) -> Unauthorized
            else -> Unavailable
        }
    }
}
