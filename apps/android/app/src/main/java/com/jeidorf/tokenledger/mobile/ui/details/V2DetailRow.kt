package com.jeidorf.tokenledger.mobile.ui.details

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.CostPrecision
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.LogHistoryItem
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.detailRequestCountLabel
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.shortTime
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.sources.V2SourceTile
import com.jeidorf.tokenledger.mobile.toolChartSlot
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney
import com.jeidorf.tokenledger.mobile.v2FormatTokens

internal fun displayedHistoryTokenCount(
    mode: TokenDisplayMode,
    detail: LogHistoryItem
): Long = displayedTokenCount(mode, detail.effectiveTokens, detail.cachedTokens)

/**
 * 云端明细按小时聚合上传，同步时 `session_id` 固定为 `"agg"`（见桌面
 * `src-tauri/src/commands/mod.rs`），会话 ID 与「按此会话过滤」对这类行没有意义
 * （T10.172 P1-3 / C3）。`granularity` 取自详情 v2 RPC 的 `UsageDetailsPage.granularity`；
 * 旧版三参 RPC 回退同样读云端聚合表，因此调用方缺省也传 `"hour"`。本机若存在真实
 * 会话 ID 的明细来源（非 `"hour"` 粒度），以下判断保持原会话详情行为不变。
 */
internal fun v2DetailIsCloudAggregate(granularity: String): Boolean =
    granularity.equals("hour", ignoreCase = true)

internal fun v2DetailDialogTitle(granularity: String): String =
    if (v2DetailIsCloudAggregate(granularity)) "小时聚合记录" else "会话详情"

/** 云端小时聚合行没有单次会话概念，用说明句代替会话 ID；本机真实会话保持原样（返回 null）。 */
internal fun v2DetailAggregateNotice(granularity: String): String? =
    if (v2DetailIsCloudAggregate(granularity)) "云端按小时聚合，不含单次会话" else null

/** 云端聚合行永不提供「按此会话过滤」；本机真实会话仍需要处理器与非空会话 ID。 */
internal fun v2DetailShowSessionFilter(
    granularity: String,
    sessionId: String,
    hasFilterHandler: Boolean
): Boolean = hasFilterHandler && sessionId.isNotBlank() && !v2DetailIsCloudAggregate(granularity)

/**
 * TalkBack 点击提示需要说清楚会打开什么，而不是笼统的“操作”；直接派生自弹窗标题，
 * 保证提示文案与实际打开的弹窗标题不会各说各话。
 */
internal fun v2DetailRowClickLabel(granularity: String): String =
    "打开${v2DetailDialogTitle(granularity)}"

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun V2DetailRow(
    palette: MobileV2Palette,
    detail: LogHistoryItem,
    tokenDisplayMode: TokenDisplayMode,
    granularity: String = "hour",
    onFilterSession: ((String) -> Unit)? = null
) {
    val context = LocalContext.current
    val costMasked = LocalCostMaskEnabled.current
    val currency = LocalDashboardCurrency.current
    var showSessionDialog by remember { mutableStateOf(false) }

    if (showSessionDialog) {
        AlertDialog(
            onDismissRequest = { showSessionDialog = false },
            containerColor = palette.surface,
            title = {
                Text(
                    v2DetailDialogTitle(granularity),
                    color = palette.text,
                    fontSize = LedgerFont.subtitle,
                    fontWeight = FontWeight.Bold
                )
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val aggregateNotice = v2DetailAggregateNotice(granularity)
                    if (aggregateNotice != null) {
                        Text(
                            aggregateNotice,
                            color = palette.muted,
                            fontSize = LedgerFont.caption
                        )
                    } else {
                        Text(
                            "会话 ID: ${detail.sessionId.ifBlank { "未知会话" }}",
                            color = palette.muted,
                            fontSize = LedgerFont.caption
                        )
                    }
                    Text(
                        "工具: ${detail.tool}  |  模型: ${detail.model}",
                        color = palette.text,
                        fontSize = LedgerFont.body,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        "设备: ${detail.machineId}  |  时间: ${shortTime(detail.timestamp)}",
                        color = palette.faint,
                        fontSize = LedgerFont.caption
                    )
                    HorizontalDivider(color = palette.divider)
                    Text("Token 构成:", color = palette.text, fontSize = LedgerFont.label, fontWeight = FontWeight.Medium)
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("输入 Token:", color = palette.muted, fontSize = LedgerFont.caption)
                        Text(v2FormatTokens(detail.inputTokens), color = palette.text, fontSize = LedgerFont.caption)
                    }
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("输出 Token:", color = palette.muted, fontSize = LedgerFont.caption)
                        Text(v2FormatTokens(detail.outputTokens), color = palette.text, fontSize = LedgerFont.caption)
                    }
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("缓存 Token:", color = palette.muted, fontSize = LedgerFont.caption)
                        Text(v2FormatTokens(detail.cachedTokens), color = palette.text, fontSize = LedgerFont.caption)
                    }
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("有效 Token (输入+输出):", color = palette.text, fontSize = LedgerFont.caption, fontWeight = FontWeight.SemiBold)
                        Text(v2FormatTokens(detail.effectiveTokens), color = palette.text, fontSize = LedgerFont.caption, fontWeight = FontWeight.Bold)
                    }
                    if (!costMasked) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("预估费用:", color = palette.text, fontSize = LedgerFont.caption)
                            Text(v2FormatMoney(context, detail.cost, costMasked, currency, CostPrecision.Record), color = palette.text, fontSize = LedgerFont.caption, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            },
            confirmButton = {
                if (v2DetailShowSessionFilter(granularity, detail.sessionId, onFilterSession != null)) {
                    TextButton(
                        onClick = {
                            showSessionDialog = false
                            onFilterSession?.invoke(detail.sessionId)
                        }
                    ) {
                        Text("按此会话过滤", color = palette.blue, fontWeight = FontWeight.Bold, fontSize = LedgerFont.label)
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = { showSessionDialog = false }) {
                    Text("关闭", color = palette.muted, fontSize = LedgerFont.label)
                }
            }
        )
    }

    V2Card(
        palette = palette,
        modifier = Modifier.clickable(
            onClickLabel = v2DetailRowClickLabel(granularity),
            role = Role.Button
        ) {
            showSessionDialog = true
        },
        contentPadding = PaddingValues(horizontal = 13.dp, vertical = 10.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            V2SourceTile(palette, detail.tool, palette.tokens.chartSlot(toolChartSlot(detail.tool)))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    "${detail.tool} · ${detail.model}",
                    color = palette.text,
                    fontSize = LedgerFont.label,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    "${shortTime(detail.timestamp)} · ${detail.machineId}",
                    color = palette.faint,
                    fontSize = LedgerFont.caption,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    v2FormatTokens(
                        displayedHistoryTokenCount(tokenDisplayMode, detail)
                    ),
                    color = palette.text,
                    fontSize = LedgerFont.body,
                    fontWeight = FontWeight.SemiBold
                )
                if (!costMasked) {
                    // 明细一行是一条记录：不足 1 个币种单位时保留 4 位（T10.154 §4.1「单条记录」）。
                    Text(v2FormatMoney(context, detail.cost, costMasked, currency, CostPrecision.Record), color = palette.muted, fontSize = LedgerFont.caption)
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        if (LocalDensity.current.fontScale >= 1.5f) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text("输入 ${v2FormatTokens(detail.inputTokens)}", color = palette.muted, fontSize = LedgerFont.caption)
                Text("输出 ${v2FormatTokens(detail.outputTokens)}", color = palette.muted, fontSize = LedgerFont.caption)
                Text("缓存 ${v2FormatTokens(detail.cachedTokens)}", color = palette.muted, fontSize = LedgerFont.caption)
                detailRequestCountLabel(detail.requests)?.let { requestLabel ->
                    Text(requestLabel, color = palette.faint, fontSize = LedgerFont.caption)
                }
            }
        } else {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "输入 ${v2FormatTokens(detail.inputTokens)}",
                    color = palette.muted,
                    fontSize = LedgerFont.caption,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    text = "输出 ${v2FormatTokens(detail.outputTokens)}",
                    color = palette.muted,
                    fontSize = LedgerFont.caption,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    text = "缓存 ${v2FormatTokens(detail.cachedTokens)}",
                    color = palette.muted,
                    fontSize = LedgerFont.caption,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                detailRequestCountLabel(detail.requests)?.let { requestLabel ->
                    Text(
                        text = requestLabel,
                        color = palette.faint,
                        fontSize = LedgerFont.caption,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false)
                    )
                }
            }
        }
    }
}
