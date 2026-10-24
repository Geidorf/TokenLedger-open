package com.jeidorf.tokenledger.mobile.ui.dimensions

import com.jeidorf.tokenledger.mobile.dimensions.DimensionsReadFailure
import com.jeidorf.tokenledger.mobile.dimensions.UsageDimensionsJson
import org.json.JSONArray
import org.json.JSONObject

internal enum class DimensionsPreviewKind { Live, DesktopOff, NotDeployed }

internal fun dimensionsPreviewFeed(kind: DimensionsPreviewKind): DimensionsFeed = when (kind) {
    DimensionsPreviewKind.Live -> DimensionsFeed(signedIn = true, dimensions = UsageDimensionsJson.parse(dimensionsPreviewJson(true)))
    DimensionsPreviewKind.DesktopOff -> DimensionsFeed(signedIn = true, dimensions = UsageDimensionsJson.parse(dimensionsPreviewJson(false)))
    DimensionsPreviewKind.NotDeployed -> DimensionsFeed(signedIn = true, failure = DimensionsReadFailure.NotDeployed)
}

private fun dimensionsPreviewJson(live: Boolean): String {
    val meta = JSONObject().put("source", "cloud").put("start", "2026-07-01").put("end", "2026-07-28")
        .put("timezone", "Asia/Shanghai").put("retentionDays", 90).put("coverageStart", "2026-05-01")
    if (!live) return JSONObject().put("meta", meta)
        .put("sessions", JSONObject().put("state", "empty"))
        .put("providers", JSONObject().put("state", "empty"))
        .put("contextComposition", JSONObject().put("state", "empty")).toString()
    val tools = listOf("codex", "claude", "codex", "opencode", "claude", "minimax")
    val models = listOf("gpt-5", "claude-opus-4", null, "qwen3-coder", "claude-sonnet-4", "MiniMax-M2")
    val rows = JSONArray()
    tools.forEachIndexed { index, tool ->
        val tokens = 1_840_000L / (index + 1)
        rows.put(JSONObject().put("id", String.format(java.util.Locale.ROOT, "%032x", index + 1)).put("machine", if (index % 2 == 0) "device-a" else "device-b")
            .put("tool", tool).put("tokens", tokens).put("requests", 120 / (index + 1))
            .put("cost", if (index == 3) JSONObject.NULL else tokens * 0.000002)
            .put("days", if (index == 0) 2 else 1).put("firstDate", "2026-07-${26 - index}")
            .put("lastDate", "2026-07-${if (index == 0) 27 else 26 - index}")
            .put("firstAt", "09:${10 + index}").put("lastAt", "18:4$index").put("topModel", models[index] ?: JSONObject.NULL))
    }
    val providers = JSONArray()
        .put(JSONObject().put("provider", "openai").put("input", 400_000).put("output", 50_000)
            .put("cached", 500_000).put("cacheWrite", 20_000).put("total", 450_000)
            .put("requests", 120).put("cost", 0.54))
        .put(JSONObject().put("provider", "siliconflow").put("input", 120_000).put("output", 30_000)
            .put("cached", 80_000).put("cacheWrite", 5_000).put("total", 150_000)
            .put("requests", 40).put("cost", 0.18))
        .put(JSONObject().put("provider", "other").put("input", 10_000).put("output", 5_000)
            .put("cached", 0).put("cacheWrite", 0).put("total", 15_000)
            .put("requests", 3).put("cost", JSONObject.NULL))
    return JSONObject().put("meta", meta)
        .put("sessions", JSONObject().put("state", "ok").put("sessionCount", 37).put("truncatedDays", 0).put("sessionLimit", 100).put("rows", rows))
        .put("providers", JSONObject().put("state", "ok").put("rows", providers))
        .put("contextComposition", JSONObject().put("state", "ok").put("requests", 420).put("promptTokens", 12_600_000)
            .put("systemBytes", 2_520_000).put("toolsBytes", 5_880_000).put("historyBytes", 10_500_000)
            .put("toolResultsBytes", 8_400_000).put("attachmentsBytes", 420_000).put("messages", 9_800)
            .put("toolResults", 3_100).put("attachments", 12)).toString()
}
