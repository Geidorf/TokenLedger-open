package com.jeidorf.tokenledger.mobile.ui.rhythm

import com.jeidorf.tokenledger.mobile.rhythm.ActivityRhythmJson
import com.jeidorf.tokenledger.mobile.rhythm.RhythmReadFailure
import java.time.LocalDate
import org.json.JSONArray
import org.json.JSONObject

/** 「会话」子页截图夹具：按契约 activity-rhythm-cloud-v1 拼出的固定返回体，名字与数字都是演示数据。 */
internal enum class RhythmPreviewKind { Live, NotDeployed }

internal fun rhythmPreviewFeed(kind: RhythmPreviewKind): RhythmFeed = when (kind) {
    RhythmPreviewKind.Live -> RhythmFeed(signedIn = true, rhythm = ActivityRhythmJson.parse(rhythmPreviewJson()))
    RhythmPreviewKind.NotDeployed -> RhythmFeed(signedIn = true, failure = RhythmReadFailure.NotDeployed)
}

internal fun rhythmPreviewJson(): String {
    val start = LocalDate.of(2026, 7, 1)
    val dayHours = JSONArray()
    val modelHours = mutableMapOf<Pair<Int, String>, Pair<Long, Long>>()
    var tokens = 0L
    var requests = 0L
    for (day in 0 until 28) {
        val date = start.plusDays(day.toLong())
        val weekend = date.dayOfWeek.value >= 6
        for (hour in 0 until 24) {
            // 工作日上午与晚上两个高峰，周末只有下午有零星用量。
            val weight = when {
                weekend -> if (hour in 14..17) 2 else 0
                hour in 9..11 -> 9 - (hour - 10) * (hour - 10) * 2
                hour in 20..23 -> 6 - (hour - 21)
                hour in 13..18 -> 4
                else -> 0
            }
            if (weight <= 0) continue
            val t = weight * 4_200L + (day % 5) * 600L
            val r = weight * 3L + day % 3
            tokens += t
            requests += r
            dayHours.put(JSONObject().put("date", date.toString()).put("hour", hour).put("tokens", t).put("requests", r))
            val model = if (hour < 12) "gpt-5" else if (hour < 19) "claude-opus-4" else "qwen3-coder"
            val previous = modelHours[hour to model] ?: (0L to 0L)
            modelHours[hour to model] = (previous.first + t) to (previous.second + r)
        }
    }
    val modelArray = JSONArray()
    modelHours.keys.sortedWith(compareBy({ it.first }, { it.second })).forEach { key ->
        val (t, r) = modelHours.getValue(key)
        modelArray.put(JSONObject().put("hour", key.first).put("model", key.second).put("tokens", t).put("requests", r))
    }
    val tools = JSONArray()
        .put(JSONObject().put("id", "codex").put("tokens", tokens * 52 / 100).put("requests", requests / 2))
        .put(JSONObject().put("id", "claude").put("tokens", tokens * 31 / 100).put("requests", requests / 3))
        .put(JSONObject().put("id", "opencode").put("tokens", tokens - tokens * 52 / 100 - tokens * 31 / 100).put("requests", requests - requests / 2 - requests / 3))
    return JSONObject()
        .put(
            "meta",
            JSONObject().put("source", "cloud").put("contractVersion", 1).put("granularity", "hour").put("complete", true)
                .put("range", "custom").put("start", start.toString()).put("end", start.plusDays(27).toString())
                .put("timezone", "Asia/Shanghai").put("rangeDayLimit", 731).put("rangeTruncated", false)
                .put("recordCount", requests).put("firstRecordAt", JSONObject.NULL).put("lastRecordAt", JSONObject.NULL)
        )
        .put(
            "summary",
            JSONObject().put("tokens", tokens).put("inputTokens", tokens * 3 / 4).put("outputTokens", tokens - tokens * 3 / 4)
                .put("cachedTokens", tokens / 5).put("requests", requests).put("activeDays", 28).put("toolCount", 3).put("modelCount", 3)
        )
        .put("tools", tools)
        .put("dayHours", dayHours)
        .put("modelHours", modelArray)
        .put("modelDays", JSONArray())
        .toString()
}
