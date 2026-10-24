package com.jeidorf.tokenledger.mobile.ui.dimensions

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.dimensions.CloudContextComposition
import com.jeidorf.tokenledger.mobile.dimensions.CloudSession
import com.jeidorf.tokenledger.mobile.dimensions.CloudSessions
import com.jeidorf.tokenledger.mobile.dimensions.DimensionPart
import com.jeidorf.tokenledger.mobile.dimensions.DimensionsReadFailure
import com.jeidorf.tokenledger.mobile.dimensions.UsageDimensions
import com.jeidorf.tokenledger.mobile.stableToolColorIndex
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.v2DataBarBackground
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney
import com.jeidorf.tokenledger.mobile.ui.sources.V2SourceTile
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import java.time.format.DateTimeFormatter
import java.util.Locale

/** 首屏显示的会话行数；其余写「另有 N 个」。 */
private const val SESSIONS_SHOWN = 20
private val SESSION_DATE = DateTimeFormatter.ofPattern("M月d日")

internal const val DIMENSION_DESKTOP_HINT = "在桌面「设置 › 数据与帮助」打开对应的云端同步后，这里会显示。"

internal fun dimensionsFailureMessage(failure: DimensionsReadFailure): String = when (failure) {
    DimensionsReadFailure.NotDeployed -> "云端还没开通会话与构成数据，更新云端数据库后这里会显示。"
    DimensionsReadFailure.Unauthorized -> "登录已过期，回到概览下拉刷新后再看。"
    DimensionsReadFailure.BadFormat -> "云端返回的会话数据格式不对，暂时无法显示。"
    DimensionsReadFailure.Unavailable -> "暂时读不到会话数据，稍后再试。"
}

/** 「会话」子页里节律之后的两张卡：会话排行与平均 Context 构成。 */
internal fun LazyListScope.v2DimensionItems(palette: MobileV2Palette, feed: DimensionsFeed) {
    val dimensions = feed.dimensions
    if (dimensions == null) {
        if (!feed.signedIn) return
        item(key = "dimensions-state", contentType = "context") {
            V2Card(palette) {
                Text("会话排行", color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold)
                Text(
                    feed.failure?.let(::dimensionsFailureMessage) ?: "正在读取会话…",
                    color = palette.muted,
                    fontSize = LedgerFont.label
                )
                if (feed.failure == DimensionsReadFailure.Unavailable) {
                    TextButton(onClick = feed.retry) { Text("重试") }
                }
            }
        }
        return
    }
    item(key = "dimensions-sessions", contentType = "sources") { V2CloudSessionsCard(palette, dimensions) }
    item(key = "dimensions-context", contentType = "chart") { V2CloudContextCard(palette, dimensions) }
}

@Composable
private fun V2DimensionHeader(palette: MobileV2Palette, title: String, subtitle: String) {
    Text(title, color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold)
    Text(subtitle, color = palette.muted, fontSize = LedgerFont.caption, modifier = Modifier.padding(bottom = LedgerSpace.sm))
}

@Composable
private fun V2DimensionNotice(palette: MobileV2Palette, part: DimensionPart<*>, what: String) {
    val message = when (part) {
        DimensionPart.Filtered -> "云端的$what没有按模型（账号与构成也没有按 Agent）拆分，当前筛选下给不出，清除筛选后可见。"
        else -> "云端还没有$what。$DIMENSION_DESKTOP_HINT"
    }
    Text(message, color = palette.muted, fontSize = LedgerFont.label)
}

private fun retentionNote(dimensions: UsageDimensions): String? =
    if (dimensions.rangeBeforeRetention) {
        "云端只保留最近 ${dimensions.retentionDays} 天，${dimensions.coverageStart.format(SESSION_DATE)}之前没有数据。"
    } else {
        null
    }

@Composable
private fun V2CloudSessionsCard(palette: MobileV2Palette, dimensions: UsageDimensions) {
    V2Card(palette) {
        when (val part = dimensions.sessions) {
            is DimensionPart.Ok -> V2CloudSessionsContent(palette, part.value, retentionNote(dimensions))
            else -> {
                V2DimensionHeader(palette, "会话排行", "按有效 Token")
                V2DimensionNotice(palette, part, "会话数据")
            }
        }
    }
}

@Composable
private fun V2CloudSessionsContent(palette: MobileV2Palette, sessions: CloudSessions, retention: String?) {
    V2DimensionHeader(palette, "会话排行", "${v2FormatNumber(sessions.sessionCount)} 个会话 · 按有效 Token")
    HorizontalDivider(color = palette.divider)
    val shown = sessions.rows.take(SESSIONS_SHOWN)
    val maximum = shown.maxOfOrNull { it.tokens }?.coerceAtLeast(1L) ?: 1L
    shown.forEach { session -> V2CloudSessionRow(palette, session, session.tokens.toFloat() / maximum) }
    val hidden = sessions.sessionCount - shown.size
    val notes = buildList {
        if (hidden > 0) add("另有 ${v2FormatNumber(hidden)} 个会话")
        if (sessions.truncatedDays > 0) add("有 ${sessions.truncatedDays} 天会话太多，只上传了当天最大的 500 个")
        add("同一会话在不同设备上分开计")
        retention?.let(::add)
    }
    Text(notes.joinToString("；"), color = palette.faint, fontSize = LedgerFont.caption, modifier = Modifier.padding(top = LedgerSpace.sm))
}

@Composable
private fun V2CloudSessionRow(palette: MobileV2Palette, session: CloudSession, fraction: Float) {
    val color = listOf(palette.blue, palette.green, palette.amber, palette.violet)[stableToolColorIndex(session.tool)]
    val masked = LocalCostMaskEnabled.current
    val currency = LocalDashboardCurrency.current
    val cost = session.cost?.let { v2FormatMoney(LocalContext.current, it, masked, currency) }
    val dates = if (session.firstDate == session.lastDate) {
        "${session.firstDate.format(SESSION_DATE)} ${session.firstAt}–${session.lastAt}"
    } else {
        "${session.firstDate.format(SESSION_DATE)} ${session.firstAt} – ${session.lastDate.format(SESSION_DATE)} ${session.lastAt}"
    }
    val detail = listOfNotNull(session.machine, dates, "${v2FormatNumber(session.requests)} 条", session.topModel, cost).joinToString(" · ")
    Row(
        Modifier
            .fillMaxWidth()
            .v2DataBarBackground(palette, color, fraction)
            .semantics(mergeDescendants = true) {
                contentDescription = "${session.tool} 会话，${v2FormatTokens(session.tokens)} 有效 Token，$detail"
            }
            .padding(vertical = LedgerSpace.sm, horizontal = LedgerSpace.xs),
        verticalAlignment = Alignment.CenterVertically
    ) {
        V2SourceTile(palette, session.tool, color)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(session.tool, color = palette.text, fontSize = LedgerFont.label, fontWeight = FontWeight.Medium, maxLines = 1)
            Text(detail, color = palette.faint, fontSize = LedgerFont.caption, maxLines = 3)
        }
        Spacer(Modifier.width(LedgerSpace.sm))
        Text(v2FormatTokens(session.tokens), color = palette.text, fontSize = LedgerFont.label, fontWeight = FontWeight.SemiBold)
    }
}

/** 平均 Context 构成的一段：名称、平均字节、占比。 */
internal data class ContextSlice(val label: String, val averageBytes: Long, val share: Double)

/** 各段平均字节与占比；总字节为 0 时返回空表（不画全 0 的条）。 */
internal fun contextSlices(context: CloudContextComposition): List<ContextSlice> {
    val parts = listOf(
        "系统提示" to context.systemBytes,
        "工具定义" to context.toolsBytes,
        "历史对话" to context.historyBytes,
        "工具结果" to context.toolResultsBytes,
        "附件" to context.attachmentsBytes
    )
    val total = parts.fold(0L) { sum, (_, bytes) -> runCatching { Math.addExact(sum, bytes) }.getOrElse { Long.MAX_VALUE } }
    if (total <= 0L) return emptyList()
    return parts.map { (label, bytes) -> ContextSlice(label, bytes / context.requests, bytes.toDouble() / total) }
}

internal fun formatContextBytes(bytes: Long): String = when {
    bytes >= 1_048_576L -> String.format(Locale.ROOT, "%.1f MB", bytes / 1_048_576.0)
    bytes >= 1_024L -> String.format(Locale.ROOT, "%.1f KB", bytes / 1_024.0)
    else -> "$bytes B"
}

@Composable
private fun V2CloudContextCard(palette: MobileV2Palette, dimensions: UsageDimensions) {
    V2Card(palette) {
        when (val part = dimensions.context) {
            is DimensionPart.Ok -> {
                val context = part.value
                val slices = contextSlices(context)
                V2DimensionHeader(
                    palette,
                    "平均 Context 构成",
                    "${v2FormatNumber(context.requests)} 次经网关的请求 · 平均输入约 ${v2FormatTokens(context.promptTokens / context.requests)} Token"
                )
                HorizontalDivider(color = palette.divider)
                if (slices.isEmpty()) {
                    Text("这些请求没有记下构成大小。", color = palette.muted, fontSize = LedgerFont.label, modifier = Modifier.padding(top = LedgerSpace.sm))
                }
                slices.forEach { slice ->
                    val percent = String.format(Locale.ROOT, "%.0f%%", slice.share * 100)
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .v2DataBarBackground(palette, palette.violet, slice.share.toFloat())
                            .semantics(mergeDescendants = true) {
                                contentDescription = "${slice.label}，平均 ${formatContextBytes(slice.averageBytes)}，占 $percent"
                            }
                            .padding(vertical = LedgerSpace.sm, horizontal = LedgerSpace.xs)
                    ) {
                        Text(slice.label, color = palette.text, fontSize = LedgerFont.label, modifier = Modifier.weight(1f))
                        Text("${formatContextBytes(slice.averageBytes)} · $percent", color = palette.muted, fontSize = LedgerFont.label)
                    }
                }
                Spacer(Modifier.height(LedgerSpace.xs))
                Text(
                    listOfNotNull("只统计经桌面网关、记下了构成的请求；大小按字节，Token 为估算", retentionNote(dimensions)).joinToString("；"),
                    color = palette.faint,
                    fontSize = LedgerFont.caption
                )
            }
            else -> {
                V2DimensionHeader(palette, "平均 Context 构成", "经网关的请求")
                V2DimensionNotice(palette, part, "构成数据")
            }
        }
    }
}
