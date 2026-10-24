package com.jeidorf.tokenledger.mobile.widget

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus

/**
 * 额度条（[WidgetMode.QuotaBars]）的主机视觉夹具：Glance 不能直接截图，这里用 Compose 按生产代码的
 * 版面预算（[widgetQuotaBarsLayout]）、文案函数与色源（[WidgetColors]）画同一张卡。不是实际 Launcher 验收。
 */
private val CAPTURED = 1_800_000_000_000L

private fun row(
    provider: String,
    name: String,
    window: String?,
    percent: Int?,
    reset: String?,
    rank: Int,
    group: Int,
    status: QuotaProviderStatus = QuotaProviderStatus.Ok
) = WidgetQuotaBarRow(
    key = "$provider:$window",
    providerId = provider,
    providerName = name,
    windowLabel = window,
    status = status,
    availableFraction = percent?.let { it / 100f },
    availablePercent = percent,
    resetText = reset,
    freshnessText = "2 分钟前",
    rank = rank,
    groupOrder = group
)

private val okRows = listOf(
    row("codex", "Codex", "每周", 72, "2 天 3 小时后重置", rank = 0, group = 0),
    row("claude", "Claude", "5 小时", 28, "49 分钟后重置", rank = 1, group = 2),
    row("antigravity", "Antigravity", "5 小时", 12, "1 小时 5 分钟后重置", rank = 2, group = 4),
    row("codex", "Codex", "5 小时", 96, "3 小时 12 分钟后重置", rank = 3, group = 1),
    row("claude", "Claude", "每周", 57, "6 小时 29 分钟后重置", rank = 4, group = 3),
    row("antigravity", "Antigravity", "每周", 81, "4 天后重置", rank = 5, group = 5)
)

private val mixedRows = listOf(
    row("codex", "Codex", "每周", 72, "2 天 3 小时后重置", rank = 0, group = 0),
    row("claude", "Claude", "5 小时", 40, null, rank = 1, group = 1, status = QuotaProviderStatus.Stale),
    row("antigravity", "Antigravity", null, null, null, rank = 2, group = 2, status = QuotaProviderStatus.AuthRequired)
)

private val routing = WidgetRoutingSummary(
    userId = "u1",
    state = WidgetRoutingState.Ok,
    capturedAtEpochMs = CAPTURED,
    snapshotAgeMs = 3_000,
    latestAgent = "Claude Code",
    latestTarget = "anthropic/sonnet",
    latestAgeMs = 3 * 60_000L
)

@Composable
private fun QuotaBarsFixture(
    width: Int,
    height: Int,
    night: Boolean,
    rows: List<WidgetQuotaBarRow> = okRows,
    showRouting: Boolean = false,
    routingSummary: WidgetRoutingSummary? = routing
) {
    val scale = LocalDensity.current.fontScale
    val palette = WidgetColors(night = night)
    val plan = widgetQuotaBarsLayout(width.toFloat(), height.toFloat(), scale, rows, showRouting)
    fun accent(row: WidgetQuotaBarRow): Color = when (row.status) {
        QuotaProviderStatus.Ok -> when (widgetAvailabilityBand(row.availableFraction ?: 0f)) {
            WidgetThresholdBand.Danger -> palette.dangerColor
            WidgetThresholdBand.Warn -> palette.amberColor
            WidgetThresholdBand.Normal -> palette.blueColor
        }
        QuotaProviderStatus.Stale, QuotaProviderStatus.AuthRequired -> palette.amberColor
        QuotaProviderStatus.Error -> palette.dangerColor
        QuotaProviderStatus.Unsupported -> palette.faintColor
    }
    fun valueColor(row: WidgetQuotaBarRow): Color = when (row.status) {
        QuotaProviderStatus.Ok -> palette.textColor
        QuotaProviderStatus.Stale, QuotaProviderStatus.AuthRequired -> palette.amberColor
        QuotaProviderStatus.Error -> palette.dangerColor
        QuotaProviderStatus.Unsupported -> palette.faintColor
    }
    Box(
        Modifier.fillMaxSize().background(palette.backgroundColor, RoundedCornerShape(20.dp))
            .padding(horizontal = if (width < 180) 8.dp else 10.dp, vertical = if (height < 82) 4.dp else 8.dp)
    ) {
        if (!plan.sufficient) {
            Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("尺寸不足", color = palette.textColor, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Text("请放大以显示额度条", color = palette.mutedColor, fontSize = 11.sp)
            }
            return@Box
        }
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().height((WidgetQuotaBarsMetrics.HEADER_DP * scale.coerceAtLeast(1f)).dp),
                verticalAlignment = Alignment.CenterVertically) {
                val title = formatHiddenQuotaWindows(plan.hiddenCount)?.let { "订阅额度 · $it" } ?: "订阅额度"
                Text(title, color = palette.mutedColor, fontSize = 11.sp, fontWeight = FontWeight.Medium,
                    maxLines = 1, modifier = Modifier.weight(1f))
                if (plan.showUsage) {
                    Text("今日 12.4M · ¥38.62", color = palette.textColor, fontSize = 11.sp, fontWeight = FontWeight.Bold,
                        maxLines = 1)
                }
            }
            plan.visible.forEach { row ->
                Column(Modifier.fillMaxWidth().height(plan.rowHeightDp.dp), verticalArrangement = Arrangement.Center) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(widgetQuotaBarTitle(row, pinnedProvider = false), color = palette.textColor, fontSize = 12.sp,
                            fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f))
                        row.resetText?.takeIf { plan.showReset }?.let { reset ->
                            Text(reset, color = palette.mutedColor, fontSize = 11.sp, maxLines = 1)
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(widgetQuotaBarValueText(row), color = valueColor(row), fontSize = 12.sp,
                            fontWeight = FontWeight.Bold, maxLines = 1)
                    }
                    Spacer(Modifier.height(4.dp))
                    Box(Modifier.fillMaxWidth().height(4.dp).background(palette.trackColor, RoundedCornerShape(2.dp))) {
                        row.availableFraction?.let { fraction ->
                            Box(Modifier.fillMaxWidth(fraction).fillMaxHeight().background(accent(row), RoundedCornerShape(2.dp)))
                        }
                    }
                }
            }
            if (plan.showRouting) {
                Spacer(Modifier.weight(1f))
                val line = widgetRoutingLine(routingSummary, CAPTURED)
                val dot = when (line.tone) {
                    WidgetRoutingTone.Ok -> palette.blueColor
                    WidgetRoutingTone.Failed -> palette.dangerColor
                    WidgetRoutingTone.Warning -> palette.amberColor
                    WidgetRoutingTone.Neutral -> palette.faintColor
                }
                Row(Modifier.fillMaxWidth().height((WidgetQuotaBarsMetrics.ROUTING_DP * scale.coerceAtLeast(1f)).dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).background(dot, RoundedCornerShape(4.dp)))
                    Spacer(Modifier.width(8.dp))
                    Text(line.text, color = if (line.tone == WidgetRoutingTone.Warning) palette.amberColor else palette.mutedColor,
                        fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@PreviewTest
@Preview(name = "QuotaBars Dark", device = "spec:width=280dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun QuotaBarsDarkScreenshot() { QuotaBarsFixture(280, 200, night = true, showRouting = true) }

@PreviewTest
@Preview(name = "QuotaBars Light", device = "spec:width=280dp,height=200dp,dpi=160", fontScale = 1.0f)
@Composable
fun QuotaBarsLightScreenshot() { QuotaBarsFixture(280, 200, night = false, showRouting = true) }

@PreviewTest
@Preview(name = "QuotaBars Mixed", device = "spec:width=280dp,height=140dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun QuotaBarsMixedScreenshot() { QuotaBarsFixture(280, 140, night = true, rows = mixedRows) }

@PreviewTest
@Preview(name = "QuotaBars Short", device = "spec:width=280dp,height=100dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun QuotaBarsShortScreenshot() { QuotaBarsFixture(280, 100, night = true, showRouting = true) }

@PreviewTest
@Preview(name = "QuotaBars Narrow", device = "spec:width=190dp,height=200dp,dpi=160", fontScale = 1.0f)
@Composable
fun QuotaBarsNarrowScreenshot() { QuotaBarsFixture(190, 200, night = false) }

@PreviewTest
@Preview(name = "QuotaBars Font200", device = "spec:width=280dp,height=200dp,dpi=160", fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun QuotaBarsFont200Screenshot() { QuotaBarsFixture(280, 200, night = true, showRouting = true) }

@PreviewTest
@Preview(name = "QuotaBars RoutingOff", device = "spec:width=280dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun QuotaBarsRoutingOffScreenshot() {
    QuotaBarsFixture(280, 200, night = true, showRouting = true,
        routingSummary = WidgetRoutingSummary("u1", WidgetRoutingState.NoSnapshot, CAPTURED))
}
