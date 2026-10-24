package com.jeidorf.tokenledger.mobile.ui.dimensions

import com.jeidorf.tokenledger.mobile.dimensions.DimensionsReadFailure
import com.jeidorf.tokenledger.mobile.dimensions.UsageDimensionsJson
import java.util.Locale

internal enum class DimensionsPreviewKind { Live, DesktopOff, NotDeployed }

/** 截图夹具：会话排行与 Context 构成的有数、桌面未开启、云端未部署三种状态。 */
internal fun dimensionsPreviewFeed(kind: DimensionsPreviewKind): DimensionsFeed = when (kind) {
    DimensionsPreviewKind.Live -> DimensionsFeed(signedIn = true, dimensions = UsageDimensionsJson.parse(dimensionsPreviewJson(live = true)))
    DimensionsPreviewKind.DesktopOff -> DimensionsFeed(signedIn = true, dimensions = UsageDimensionsJson.parse(dimensionsPreviewJson(live = false)))
    DimensionsPreviewKind.NotDeployed -> DimensionsFeed(signedIn = true, failure = DimensionsReadFailure.NotDeployed)
}

private fun dimensionsPreviewJson(live: Boolean): String {
    if (!live) {
        return """{"meta":{"source":"cloud","start":"2026-07-01","end":"2026-07-28","timezone":"Asia/Shanghai","retentionDays":90,"coverageStart":"2026-05-01"},
            "sessions":{"state":"empty"},"providers":{"state":"empty"},"contextComposition":{"state":"empty"}}"""
    }
    val tools = listOf("codex", "claude", "codex", "opencode", "claude", "minimax")
    val models = listOf("gpt-5", "claude-opus-4", null, "qwen3-coder", "claude-sonnet-4", "MiniMax-M2")
    val rows = tools.mapIndexed { index, tool ->
        val tokens = 1_840_000L / (index + 1)
        val model = models[index]?.let { "\"$it\"" } ?: "null"
        val key = String.format(Locale.ROOT, "%032x", index + 1)
        val lastDay = if (index == 0) 27 else 26 - index
        """{"id":"$key","machine":"${if (index % 2 == 0) "MacBook-Pro" else "Windows-Workstation"}","tool":"$tool","tokens":$tokens,
            "requests":${120 / (index + 1)},"cost":${if (index == 3) "null" else String.format(Locale.ROOT, "%.4f", tokens * 0.000002)},"days":${if (index == 0) 2 else 1},
            "firstDate":"2026-07-${26 - index}","lastDate":"2026-07-$lastDay","firstAt":"09:${10 + index}","lastAt":"18:4$index","topModel":$model}"""
    }
    return """{"meta":{"source":"cloud","start":"2026-07-01","end":"2026-07-28","timezone":"Asia/Shanghai","retentionDays":90,"coverageStart":"2026-05-01"},
        "sessions":{"state":"ok","sessionCount":37,"truncatedDays":0,"sessionLimit":100,"rows":[${rows.joinToString(",")}]},
        "providers":{"state":"ok","rows":[{"provider":"openai","input":800000,"output":90000,"cached":1200000,"cacheWrite":0,"total":890000,"requests":420,"cost":3.21}]},
        "contextComposition":{"state":"ok","requests":420,"promptTokens":12600000,"systemBytes":2520000,"toolsBytes":5880000,"historyBytes":10500000,
          "toolResultsBytes":8400000,"attachmentsBytes":420000,"messages":9800,"toolResults":3100,"attachments":12}}"""
}
