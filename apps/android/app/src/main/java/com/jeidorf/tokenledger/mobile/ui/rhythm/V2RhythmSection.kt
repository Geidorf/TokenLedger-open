package com.jeidorf.tokenledger.mobile.ui.rhythm

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.rhythm.ActivityRhythm
import com.jeidorf.tokenledger.mobile.rhythm.RhythmReadFailure
import com.jeidorf.tokenledger.mobile.stableToolColorIndex
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.v2DataBarBackground
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Share
import com.jeidorf.tokenledger.mobile.ui.sources.V2SourceTile
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import java.time.format.DateTimeFormatter

internal const val RHYTHM_CLOUD_LIMIT_NOTE =
    "云端只有按小时汇总的数据，没有会话列表和每条记录的请求大小。完整的会话分析在桌面「用量 › 会话」。"

private val WEEKDAY_LABELS = listOf("一", "二", "三", "四", "五", "六", "日")
private val RANGE_DATE = DateTimeFormatter.ofPattern("M月d日")

internal fun rhythmFailureMessage(failure: RhythmReadFailure): String = when (failure) {
    RhythmReadFailure.NotDeployed -> "云端还没开通活动节律，更新云端数据库后这里会显示。"
    RhythmReadFailure.Unauthorized -> "登录已过期，回到概览下拉刷新后再看。"
    RhythmReadFailure.BadFormat -> "云端返回的活动节律格式不对，暂时无法显示。"
    RhythmReadFailure.Unavailable -> "暂时读不到活动节律，稍后再试。"
}

/**
 * 「用量 › 会话」子页（对齐桌面「用量 › 会话」的云端可得部分）：总量、24 小时分布、
 * 星期 × 小时热力、Agent 与模型排行。云端没有会话列表，页底写明。
 */
internal fun LazyListScope.v2RhythmItems(palette: MobileV2Palette, feed: RhythmFeed) {
    val rhythm = feed.rhythm
    if (rhythm == null) {
        item(key = "rhythm-state", contentType = "context") {
            V2Card(palette) {
                Text(
                    feed.failure?.let(::rhythmFailureMessage) ?: if (feed.signedIn) "正在读取活动节律…" else "登录后可查看活动节律。",
                    color = palette.muted,
                    fontSize = LedgerFont.label
                )
                if (feed.failure == RhythmReadFailure.Unavailable) {
                    TextButton(onClick = feed.retry) { Text("重试") }
                }
            }
        }
        item(key = "rhythm-note", contentType = "context") { V2RhythmNote(palette) }
        return
    }
    item(key = "rhythm-summary", contentType = "summary") { V2RhythmSummaryCard(palette, rhythm) }
    if (rhythm.summary.requests == 0L) {
        item(key = "rhythm-note", contentType = "context") { V2RhythmNote(palette) }
        return
    }
    item(key = "rhythm-hours", contentType = "chart") { V2RhythmHourCard(palette, rhythm) }
    item(key = "rhythm-weekday", contentType = "chart") { V2RhythmWeekdayCard(palette, rhythm) }
    item(key = "rhythm-tools", contentType = "sources") {
        V2RhythmRanking(palette, "Agent", rhythm.tools.map { it.id to it.tokens }, rhythm.summary.tokens, agent = true)
    }
    item(key = "rhythm-models", contentType = "sources") {
        V2RhythmRanking(palette, "模型", rhythm.modelTotals, rhythm.summary.tokens, agent = false)
    }
    item(key = "rhythm-note", contentType = "context") { V2RhythmNote(palette) }
}

@Composable
private fun V2RhythmSummaryCard(palette: MobileV2Palette, rhythm: ActivityRhythm) {
    val summary = rhythm.summary
    V2Card(palette) {
        Text("活动节律", color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold)
        Text(
            "${rhythm.start.format(RANGE_DATE)} – ${rhythm.end.format(RANGE_DATE)}" +
                if (rhythm.rangeTruncated) " · 仅统计最近 731 天" else "",
            color = palette.faint,
            fontSize = LedgerFont.caption
        )
        Spacer(Modifier.height(LedgerSpace.sm))
        Text(v2FormatTokens(summary.tokens), color = palette.text, fontSize = LedgerFont.displaySmall, fontWeight = FontWeight.SemiBold)
        Text("有效 Token", color = palette.muted, fontSize = LedgerFont.caption)
        Spacer(Modifier.height(LedgerSpace.sm))
        Text(
            "${v2FormatNumber(summary.requests)} 条记录 · 活跃 ${summary.activeDays} 天 · ${summary.toolCount} 个 Agent · ${summary.modelCount} 个模型",
            color = palette.muted,
            fontSize = LedgerFont.label
        )
    }
}

/**
 * 柱图与热力格画在 Canvas 里，TalkBack 读不到单个格子，所以把每个有用量的小时连同数值写进说明，
 * 没用量的小时不念，避免一行念 24 遍「0」。
 */
internal fun rhythmHourBreakdown(tokensByHour: List<Long>): String {
    val active = tokensByHour.withIndex().filter { it.value > 0L }
    if (active.isEmpty()) return "各时段都没有用量"
    return "有用量的时段：" + active.joinToString("、") { (hour, tokens) -> "$hour 点 ${v2FormatTokens(tokens)}" }
}

@Composable
private fun V2RhythmHourCard(palette: MobileV2Palette, rhythm: ActivityRhythm) {
    val hours = rhythm.hourTotals
    val peakHour = hours.indices.maxByOrNull { hours[it].tokens } ?: 0
    val maximum = hours.maxOf { it.tokens }.coerceAtLeast(1L)
    val description = "24 小时分布，最忙 $peakHour 点到 ${peakHour + 1} 点，${v2FormatTokens(hours[peakHour].tokens)} 有效 Token；" +
        rhythmHourBreakdown(hours.map { it.tokens })
    V2Card(palette) {
        Text("一天里的时段", color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold)
        Text(
            "最忙 ${"%02d".format(peakHour)}:00–${"%02d".format((peakHour + 1) % 24)}:00 · ${v2FormatTokens(hours[peakHour].tokens)} Token",
            color = palette.muted,
            fontSize = LedgerFont.caption
        )
        Spacer(Modifier.height(LedgerSpace.md))
        val bar = palette.blue
        val track = palette.divider
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(96.dp)
                .semantics { contentDescription = description }
        ) {
            val slot = size.width / 24f
            val width = (slot * 0.64f).coerceAtLeast(1f)
            hours.forEachIndexed { hour, bucket ->
                val x = slot * hour + (slot - width) / 2f
                val fraction = bucket.tokens.toFloat() / maximum
                val height = (size.height * fraction).coerceAtLeast(if (bucket.tokens > 0) 2f else 1f)
                drawRoundRect(
                    color = if (bucket.tokens > 0) bar else track,
                    topLeft = Offset(x, size.height - height),
                    size = Size(width, height),
                    cornerRadius = CornerRadius(width / 3f)
                )
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = LedgerSpace.xs)) {
            listOf("0", "6", "12", "18", "23").forEachIndexed { index, label ->
                Text(
                    label,
                    color = palette.faint,
                    fontSize = LedgerFont.caption,
                    textAlign = when (index) {
                        0 -> TextAlign.Start
                        4 -> TextAlign.End
                        else -> TextAlign.Center
                    },
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}

@Composable
private fun V2RhythmWeekdayCard(palette: MobileV2Palette, rhythm: ActivityRhythm) {
    val grid = rhythm.weekdayHourTokens
    val maximum = grid.maxOf { row -> row.maxOrNull() ?: 0L }.coerceAtLeast(1L)
    val busiest = grid.indices.maxByOrNull { grid[it].sum() } ?: 0
    V2Card(palette) {
        Text("星期 × 时段", color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold)
        Text("周${WEEKDAY_LABELS[busiest]}用得最多 · 颜色越深 Token 越多", color = palette.muted, fontSize = LedgerFont.caption)
        Spacer(Modifier.height(LedgerSpace.md))
        val hot = palette.blue
        val empty = palette.divider
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            grid.forEachIndexed { day, row ->
                Row {
                    Text(WEEKDAY_LABELS[day], color = palette.faint, fontSize = LedgerFont.caption, modifier = Modifier.width(18.dp))
                    Canvas(
                        Modifier
                            .weight(1f)
                            .height(14.dp)
                            .semantics {
                                contentDescription = "周${WEEKDAY_LABELS[day]}，合计 ${v2FormatTokens(row.sum())} 有效 Token；" +
                                    rhythmHourBreakdown(row)
                            }
                    ) {
                        val slot = size.width / 24f
                        val gap = 2f
                        row.forEachIndexed { hour, tokens ->
                            val alpha = if (tokens <= 0L) 0f else 0.18f + 0.82f * (tokens.toFloat() / maximum)
                            drawRoundRect(
                                color = if (tokens <= 0L) empty else hot.copy(alpha = alpha),
                                topLeft = Offset(slot * hour + gap / 2f, 0f),
                                size = Size((slot - gap).coerceAtLeast(1f), size.height),
                                cornerRadius = CornerRadius(3f)
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun V2RhythmRanking(
    palette: MobileV2Palette,
    title: String,
    rows: List<Pair<String, Long>>,
    total: Long,
    agent: Boolean
) {
    val shown = rows.take(8)
    val maximum = shown.maxOfOrNull { it.second }?.coerceAtLeast(1L) ?: 1L
    V2Card(palette) {
        Text("按$title", color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold)
        Text("${rows.size} 个$title · 有效 Token", color = palette.muted, fontSize = LedgerFont.caption, modifier = Modifier.padding(bottom = LedgerSpace.sm))
        HorizontalDivider(color = palette.divider)
        shown.forEach { (name, tokens) ->
            val color = if (agent) {
                listOf(palette.blue, palette.green, palette.amber, palette.violet)[stableToolColorIndex(name)]
            } else {
                palette.violet
            }
            val share = v2Share(tokens, total)
            Row(
                Modifier
                    .fillMaxWidth()
                    .v2DataBarBackground(palette, color, tokens.toFloat() / maximum)
                    .semantics(mergeDescendants = true) { contentDescription = "$name，${v2FormatTokens(tokens)} 有效 Token，占 $share" }
                    .padding(vertical = LedgerSpace.sm, horizontal = LedgerSpace.xs)
            ) {
                V2SourceTile(palette, name, color)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(name, color = palette.text, fontSize = LedgerFont.label, fontWeight = FontWeight.Medium, maxLines = 2)
                    Text(share, color = palette.faint, fontSize = LedgerFont.caption)
                }
                Text(v2FormatTokens(tokens), color = palette.text, fontSize = LedgerFont.label, fontWeight = FontWeight.SemiBold)
            }
        }
        if (rows.size > shown.size) {
            Text("另有 ${rows.size - shown.size} 个$title", color = palette.faint, fontSize = LedgerFont.caption, modifier = Modifier.padding(top = LedgerSpace.sm))
        }
    }
}

@Composable
private fun V2RhythmNote(palette: MobileV2Palette) {
    Text(
        RHYTHM_CLOUD_LIMIT_NOTE,
        color = palette.faint,
        fontSize = LedgerFont.caption,
        modifier = Modifier.padding(horizontal = LedgerSpace.lg, vertical = LedgerSpace.sm)
    )
}
