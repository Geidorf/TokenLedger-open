package com.jeidorf.tokenledger.mobile.widget

import android.content.res.Configuration
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus

/** 主机视觉夹具：复用生产尺寸预算、数值与状态文案。不是实际 Launcher 验收。 */
@Composable
private fun LauncherFixture(mode: WidgetMode, width: Int, height: Int, night: Boolean = true,
    masked: Boolean = false, status: QuotaProviderStatus = QuotaProviderStatus.Ok,
    empty: WidgetState? = null, freshness: String = "2分钟前", realRingFixture: Boolean = false) {
    val scale = LocalDensity.current.fontScale
    // 取真身的色值，不再手抄一份——手抄那份已经漂移过（error 曾是 #D93025，
    // 而挂件实际画的是 #B3261E），于是这些图验的是夹具自己的颜色，不是这个 App 的。
    val palette = WidgetColors(night = night)
    val ink = palette.textColor
    val muted = palette.mutedColor
    val track = palette.trackArgb.let { Color(it) }
    val accent = when(status) {
        QuotaProviderStatus.Stale, QuotaProviderStatus.AuthRequired -> palette.amberColor
        QuotaProviderStatus.Error -> palette.dangerColor
        else -> palette.blueColor
    }
    val providers = listOf("Codex", "Claude", "Antigravity", "公司额度").mapIndexed { index, name ->
        val fraction = if (realRingFixture) listOf(.45f, .18f, .04f, .63f)[index] else .57f
        val label = if (realRingFixture) (if (index == 0) "每周" else if(index == 3) "每日" else "5 小时")
            else if(index == 0) "周额度" else "5小时"
        WidgetQuotaProvider(name.lowercase(), name, status,
            WidgetQuotaWindow(label, fraction, if(realRingFixture) listOf("45%", "18%", "4%", "63%")[index] else "57%"),
            null, null, "2分钟前", status == QuotaProviderStatus.Stale,
            hiddenWindowCount = if(realRingFixture && index == 0) 1 else 0)
    }
    val usage = WidgetUsage(WidgetRange.Month, 987_600_000, 128640.34, 123, freshness, null)
    val cost = formatCny(usage.costCny, masked)
    @Composable fun Label(text: String, size: Int = 11, color: Color = ink, bold: Boolean = false, lines: Int = 1) {
        Text(text, color = color, fontSize = size.sp, lineHeight = (size * 1.2f).sp,
            fontWeight = if(bold) FontWeight.Bold else FontWeight.Normal, maxLines = lines,
            onTextLayout = { if(realRingFixture) check(!it.hasVisualOverflow) { "Ring text overflow: $text" } })
    }
    @Composable fun Message(title: String, subtitle: String) {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally) {
            if (shouldUseCompactWidgetMessage(height.toFloat(), scale)) {
                Text("$title · $subtitle", color = ink, fontSize = 11.sp, maxLines = 2)
            } else {
                Label(title, 15, bold = true)
                Spacer(Modifier.height(4.dp))
                Text(subtitle, color = muted, fontSize = 11.sp, maxLines = 2)
            }
        }
    }
    Column(Modifier.fillMaxSize().background(palette.backgroundColor,
        RoundedCornerShape(20.dp)).padding(horizontal = if(width < 180) 8.dp else 10.dp,
        vertical = if(height < 82) 5.dp else 7.dp)) {
        if (empty != null) {
            if(empty == WidgetState.NeedLogin) Message("! 需要登录", "打开 TokenLedger 完成登录")
            else Message("— 暂无数据", "打开应用同步")
        } else when(mode) {
            WidgetMode.MultiRing -> {
                val plan = widgetRingLayout(width.toFloat(), height.toFloat(), scale, providers.size)
                if(plan.visibleCount == 0) {
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally) {
                        Label("尺寸不足")
                        Label("请放大", color = muted)
                    }
                } else if(plan.compactOverflow) {
                    val provider = providers.first()
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally) {
                        Label(provider.name + if(providers.size > 1) " · +${providers.size - 1}" else "", bold = true)
                        Spacer(Modifier.height(2.dp))
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center,
                            verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(plan.diameterDp.dp), contentAlignment = Alignment.Center) {
                                Canvas(Modifier.fillMaxSize()) {
                                    val stroke = size.width / 12f
                                    val origin = androidx.compose.ui.geometry.Offset(stroke / 2f, stroke / 2f)
                                    val bounds = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke)
                                    drawArc(track, -90f, 360f, false, topLeft = origin, size = bounds,
                                        style = Stroke(stroke, cap = StrokeCap.Round))
                                    val sweep = when(status) {
                                        QuotaProviderStatus.Ok, QuotaProviderStatus.Stale -> 360f * requireNotNull(provider.primary).availableFraction!!
                                        QuotaProviderStatus.Error -> 360f
                                        else -> 0f
                                    }
                                    if(sweep > 0) drawArc(accent, -90f, sweep, false, topLeft = origin, size = bounds,
                                        style = Stroke(stroke, cap = StrokeCap.Round))
                                }
                                Label(if(status == QuotaProviderStatus.Ok || status == QuotaProviderStatus.Stale)
                                    requireNotNull(provider.primary).availableText else "—",
                                    if(plan.diameterDp >= 56) 17 else 14, if(status == QuotaProviderStatus.Ok) ink else accent, true)
                            }
                            Spacer(Modifier.width(6.dp))
                            Column() {
                                Label(widgetQuotaCaption(provider), color = if(status == QuotaProviderStatus.Ok) muted else accent, lines = 2)
                                Label("${widgetQuotaStatusSymbol(provider)} ${statusLabel(status)}", color = accent)
                            }
                        }
                    }
                } else {
                    Row(Modifier.weight(1f).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        providers.take(plan.visibleCount).forEach { provider ->
                            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                                Box(Modifier.size(plan.diameterDp.dp), contentAlignment = Alignment.Center) {
                                    Canvas(Modifier.fillMaxSize()) {
                                        val stroke = size.width / 12f
                                        if (plan.compactOverflow) {
                                            // 与生产位图一致，完整笔画包含在40dp尺寸内。
                                            val inset = stroke / 2f
                                            val origin = androidx.compose.ui.geometry.Offset(inset, inset)
                                            val bounds = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke)
                                            drawArc(track, -90f, 360f, false, topLeft = origin, size = bounds, style = Stroke(stroke, cap = StrokeCap.Round))
                                            val sweep = when(status) {
                                                QuotaProviderStatus.Ok, QuotaProviderStatus.Stale -> 360f * requireNotNull(provider.primary).availableFraction!!
                                                QuotaProviderStatus.Error -> 360f
                                                else -> 0f
                                            }
                                            if (sweep > 0) drawArc(accent, -90f, sweep, false, topLeft = origin, size = bounds, style = Stroke(stroke, cap = StrokeCap.Round))
                                        } else {
                                        drawArc(track, -90f, 360f, false, style = Stroke(stroke, cap = StrokeCap.Round))
                                        if(status == QuotaProviderStatus.Ok || status == QuotaProviderStatus.Stale)
                                            drawArc(accent, -90f, 360f * requireNotNull(provider.primary).availableFraction!!, false, style = Stroke(stroke, cap = StrokeCap.Round))
                                        else if(status == QuotaProviderStatus.Error) drawArc(accent, -90f, 360f, false, style = Stroke(stroke, cap = StrokeCap.Round))
                                        }
                                    }
                                    Label(if(status == QuotaProviderStatus.Ok || status == QuotaProviderStatus.Stale) requireNotNull(provider.primary).availableText else "—",
                                        if(plan.diameterDp >= 56) 17 else 14,
                                        if(status == QuotaProviderStatus.Ok) ink else accent, true)
                                }
                                Label(provider.name + if(plan.compactOverflow && providers.size > plan.visibleCount)
                                    " · +${providers.size - plan.visibleCount}" else "", bold = true)
                                Label(widgetQuotaCaption(provider), color = if(status == QuotaProviderStatus.Ok) muted else accent)
                                Label("${widgetQuotaStatusSymbol(provider)} ${statusLabel(status)}", color = accent)
                            }
                        }
                    }
                    val hidden = providers.size - plan.visibleCount
                    if(hidden > 0 && !plan.compactOverflow) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { Label("+$hidden 来源", color = muted) }
                }
            }
            WidgetMode.SingleUsage -> {
                when(widgetUsageLayout(width.toFloat(), height.toFloat(), scale)) {
                    WidgetUsageLayout.PrimaryOnly -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
                        Label("本月 987.6M", if(width < 180) 15 else 17, bold = true)
                    }
                    WidgetUsageLayout.Split -> Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) { Label("本月有效 Token", 9, muted); Label("987.6M", 21, bold = true) }
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f), horizontalAlignment = Alignment.End) {
                            Label("预估费用", 8, muted); Label(cost, 11, bold = true); Label("更新于 $freshness", 8, muted)
                        }
                    }
                    WidgetUsageLayout.Stacked -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Label("本月有效 Token", 9, muted); Label("987.6M", 17, bold = true)
                        }
                        Spacer(Modifier.height(2.dp))
                        Label("预估费用 $cost", 10, bold = true)
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) { Label("更新于 $freshness", 8, muted) }
                    }
                }
            }
            WidgetMode.BarUsage -> {
                val plan = widgetComboLayout(width.toFloat(), height.toFloat(), scale, providers.size)
                if(!plan.sufficient) Message("尺寸不足", "请放大以同时显示消耗与额度")
                else {
                    Column(Modifier.fillMaxWidth().height(plan.usageHeightDp.dp), verticalArrangement = Arrangement.Center) {
                        if(plan.stackedUsage) {
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                Box(Modifier.weight(1f)) { Label("本月有效 Token", 9, muted) }
                                Label("987.6M", 17, bold = true)
                            }
                            Label("预估 $cost", 12, muted)
                        }
                        else Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) { Label("本月有效 Token", 11, muted); Label("987.6M", 22, bold = true) }
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f), horizontalAlignment = Alignment.End) { Label("预估费用", 11, muted); Label(cost, 15, bold = true) }
                        }
                    }
                    Spacer(Modifier.height(5.dp))
                    Box(Modifier.fillMaxWidth().height(1.dp).background(track))
                    Spacer(Modifier.height(6.dp))
                    providers.take(plan.visibleCount).forEachIndexed { index, provider ->
                        Column(Modifier.fillMaxWidth().height(plan.quotaRowHeightDp.dp)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Label("${widgetQuotaStatusSymbol(provider)} ${provider.name}", bold = true)
                                Label(widgetQuotaValue(provider), color = accent, bold = true)
                            }
                            Label(widgetQuotaCaption(provider) +
                                if(index == plan.visibleCount-1 && providers.size > plan.visibleCount) " · +${providers.size-plan.visibleCount} 来源" else "", color = muted)
                            Spacer(Modifier.height(2.dp))
                            Box(Modifier.fillMaxWidth().height(4.dp).background(track)) {
                                if(status == QuotaProviderStatus.Ok || status == QuotaProviderStatus.Stale)
                                    Box(Modifier.fillMaxWidth(.57f).fillMaxHeight().background(accent))
                            }
                        }
                    }
                }
            }
            WidgetMode.MultiBar -> Unit // 旧 MultiBar 的既有 WidgetDesign gallery 保留并单独校验。
        }
    }
}

@PreviewTest
@Preview(name = "Launcher RingDarkOk", device = "spec:width=400dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherRingDarkOkScreenshot() { LauncherFixture(WidgetMode.MultiRing, 400, 200,
    night = true, masked = false, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher RingDarkStale", device = "spec:width=400dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherRingDarkStaleScreenshot() { LauncherFixture(WidgetMode.MultiRing, 400, 200,
    night = true, masked = false, status = QuotaProviderStatus.Stale) }

@PreviewTest
@Preview(name = "Launcher RingDarkError", device = "spec:width=400dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherRingDarkErrorScreenshot() { LauncherFixture(WidgetMode.MultiRing, 400, 200,
    night = true, masked = false, status = QuotaProviderStatus.Error) }

@PreviewTest
@Preview(name = "Launcher RingLightOk", device = "spec:width=400dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherRingLightOkScreenshot() { LauncherFixture(WidgetMode.MultiRing, 400, 200,
    night = false, masked = false, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher RingLightStale", device = "spec:width=400dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherRingLightStaleScreenshot() { LauncherFixture(WidgetMode.MultiRing, 400, 200,
    night = false, masked = false, status = QuotaProviderStatus.Stale) }

@PreviewTest
@Preview(name = "Launcher RingLightError", device = "spec:width=400dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherRingLightErrorScreenshot() { LauncherFixture(WidgetMode.MultiRing, 400, 200,
    night = false, masked = false, status = QuotaProviderStatus.Error) }

@PreviewTest
@Preview(name = "Launcher RingFont150", device = "spec:width=320dp,height=200dp,dpi=160", fontScale = 1.5f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherRingFont150Screenshot() { LauncherFixture(WidgetMode.MultiRing, 320, 200,
    night = true, masked = false, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher RingFont200", device = "spec:width=320dp,height=200dp,dpi=160", fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherRingFont200Screenshot() { LauncherFixture(WidgetMode.MultiRing, 320, 200,
    night = true, masked = false, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher UsageDarkOk", device = "spec:width=400dp,height=80dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherUsageDarkOkScreenshot() { LauncherFixture(WidgetMode.SingleUsage, 400, 80,
    night = true, masked = false, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher UsageDarkQuotaStale", device = "spec:width=400dp,height=80dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherUsageDarkQuotaStaleScreenshot() { LauncherFixture(WidgetMode.SingleUsage, 400, 80,
    night = true, masked = false, status = QuotaProviderStatus.Stale) }

@PreviewTest
@Preview(name = "Launcher UsageDarkQuotaError", device = "spec:width=400dp,height=80dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherUsageDarkQuotaErrorScreenshot() { LauncherFixture(WidgetMode.SingleUsage, 400, 80,
    night = true, masked = false, status = QuotaProviderStatus.Error) }

@PreviewTest
@Preview(name = "Launcher UsageLightOk", device = "spec:width=400dp,height=80dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherUsageLightOkScreenshot() { LauncherFixture(WidgetMode.SingleUsage, 400, 80,
    night = false, masked = false, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher UsageLightQuotaStale", device = "spec:width=400dp,height=80dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherUsageLightQuotaStaleScreenshot() { LauncherFixture(WidgetMode.SingleUsage, 400, 80,
    night = false, masked = false, status = QuotaProviderStatus.Stale) }

@PreviewTest
@Preview(name = "Launcher UsageLightQuotaError", device = "spec:width=400dp,height=80dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherUsageLightQuotaErrorScreenshot() { LauncherFixture(WidgetMode.SingleUsage, 400, 80,
    night = false, masked = false, status = QuotaProviderStatus.Error) }

@PreviewTest
@Preview(name = "Launcher UsageFont150", device = "spec:width=320dp,height=80dp,dpi=160", fontScale = 1.5f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherUsageFont150Screenshot() { LauncherFixture(WidgetMode.SingleUsage, 320, 80,
    night = true, masked = false, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher UsageFont200", device = "spec:width=320dp,height=80dp,dpi=160", fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherUsageFont200Screenshot() { LauncherFixture(WidgetMode.SingleUsage, 320, 80,
    night = true, masked = false, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher ComboDarkOk", device = "spec:width=400dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherComboDarkOkScreenshot() { LauncherFixture(WidgetMode.BarUsage, 400, 200,
    night = true, masked = false, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher ComboDarkStale", device = "spec:width=400dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherComboDarkStaleScreenshot() { LauncherFixture(WidgetMode.BarUsage, 400, 200,
    night = true, masked = false, status = QuotaProviderStatus.Stale) }

@PreviewTest
@Preview(name = "Launcher ComboDarkError", device = "spec:width=400dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherComboDarkErrorScreenshot() { LauncherFixture(WidgetMode.BarUsage, 400, 200,
    night = true, masked = false, status = QuotaProviderStatus.Error) }

@PreviewTest
@Preview(name = "Launcher ComboLightOk", device = "spec:width=400dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherComboLightOkScreenshot() { LauncherFixture(WidgetMode.BarUsage, 400, 200,
    night = false, masked = false, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher ComboLightStale", device = "spec:width=400dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherComboLightStaleScreenshot() { LauncherFixture(WidgetMode.BarUsage, 400, 200,
    night = false, masked = false, status = QuotaProviderStatus.Stale) }

@PreviewTest
@Preview(name = "Launcher ComboLightError", device = "spec:width=400dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherComboLightErrorScreenshot() { LauncherFixture(WidgetMode.BarUsage, 400, 200,
    night = false, masked = false, status = QuotaProviderStatus.Error) }

@PreviewTest
@Preview(name = "Launcher ComboFont150", device = "spec:width=320dp,height=200dp,dpi=160", fontScale = 1.5f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherComboFont150Screenshot() { LauncherFixture(WidgetMode.BarUsage, 320, 200,
    night = true, masked = false, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher ComboFont200", device = "spec:width=320dp,height=200dp,dpi=160", fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherComboFont200Screenshot() { LauncherFixture(WidgetMode.BarUsage, 320, 200,
    night = true, masked = false, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher UsageMasked", device = "spec:width=320dp,height=80dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherUsageMaskedScreenshot() { LauncherFixture(WidgetMode.SingleUsage, 320, 80,
    night = false, masked = true, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher ComboMasked", device = "spec:width=320dp,height=200dp,dpi=160", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherComboMaskedScreenshot() { LauncherFixture(WidgetMode.BarUsage, 320, 200,
    night = false, masked = true, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher RingAuthDark", device = "spec:width=320dp,height=200dp,dpi=160", fontScale = 1.5f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherRingAuthDarkScreenshot() { LauncherFixture(WidgetMode.MultiRing, 320, 200,
    night = true, masked = false, status = QuotaProviderStatus.AuthRequired) }

@PreviewTest
@Preview(name = "Launcher RingAuthLight", device = "spec:width=320dp,height=200dp,dpi=160", fontScale = 1.5f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherRingAuthLightScreenshot() { LauncherFixture(WidgetMode.MultiRing, 320, 200,
    night = false, masked = false, status = QuotaProviderStatus.AuthRequired) }

@PreviewTest
@Preview(name = "Launcher ComboAuthDark", device = "spec:width=320dp,height=200dp,dpi=160", fontScale = 1.5f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherComboAuthDarkScreenshot() { LauncherFixture(WidgetMode.BarUsage, 320, 200,
    night = true, masked = false, status = QuotaProviderStatus.AuthRequired) }

@PreviewTest
@Preview(name = "Launcher ComboAuthLight", device = "spec:width=320dp,height=200dp,dpi=160", fontScale = 1.5f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherComboAuthLightScreenshot() { LauncherFixture(WidgetMode.BarUsage, 320, 200,
    night = false, masked = false, status = QuotaProviderStatus.AuthRequired) }

@PreviewTest
@Preview(name = "Launcher NeedLoginDark", device = "spec:width=320dp,height=80dp,dpi=160", fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherNeedLoginDarkScreenshot() { LauncherFixture(WidgetMode.SingleUsage, 320, 80,
    night = true, masked = false, status = QuotaProviderStatus.Ok, empty = WidgetState.NeedLogin) }

@PreviewTest
@Preview(name = "Launcher NeedLoginLight", device = "spec:width=320dp,height=80dp,dpi=160", fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherNeedLoginLightScreenshot() { LauncherFixture(WidgetMode.SingleUsage, 320, 80,
    night = false, masked = false, status = QuotaProviderStatus.Ok, empty = WidgetState.NeedLogin) }

@PreviewTest
@Preview(name = "Launcher NoDataDark", device = "spec:width=320dp,height=80dp,dpi=160", fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherNoDataDarkScreenshot() { LauncherFixture(WidgetMode.SingleUsage, 320, 80,
    night = true, masked = false, status = QuotaProviderStatus.Ok, empty = WidgetState.NoData) }

@PreviewTest
@Preview(name = "Launcher NoDataLight", device = "spec:width=320dp,height=80dp,dpi=160", fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherNoDataLightScreenshot() { LauncherFixture(WidgetMode.SingleUsage, 320, 80,
    night = false, masked = false, status = QuotaProviderStatus.Ok, empty = WidgetState.NoData) }

@PreviewTest
@Preview(name = "Launcher ComboInsufficient", device = "spec:width=320dp,height=80dp,dpi=160", fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherComboInsufficientScreenshot() { LauncherFixture(WidgetMode.BarUsage, 320, 80,
    night = true, masked = false, status = QuotaProviderStatus.Ok) }


@PreviewTest
@Preview(name = "Launcher Usage320", device = "spec:width=320dp,height=80dp,dpi=160", fontScale = 1.0f)
@Composable
fun LauncherUsage320Screenshot() { LauncherFixture(WidgetMode.SingleUsage, 320, 80) }

@PreviewTest
@Preview(name = "Launcher Combo320", device = "spec:width=320dp,height=200dp,dpi=160", fontScale = 1.0f)
@Composable
fun LauncherCombo320Screenshot() { LauncherFixture(WidgetMode.BarUsage, 320, 200) }

@PreviewTest
@Preview(name = "Launcher Ring200", device = "spec:width=200dp,height=200dp,dpi=160", fontScale = 1.0f)
@Composable
fun LauncherRing200Screenshot() { LauncherFixture(WidgetMode.MultiRing, 200, 200) }

@PreviewTest
@Preview(name = "Launcher UsageStacked200", device = "spec:width=320dp,height=120dp,dpi=160", fontScale = 2.0f)
@Composable
fun LauncherUsageStacked200Screenshot() { LauncherFixture(WidgetMode.SingleUsage, 320, 120) }

@PreviewTest
@Preview(name = "Launcher UsageHistoryDark", device = "spec:width=320dp,height=80dp,dpi=160")
@Composable
fun LauncherUsageHistoryDarkScreenshot() { LauncherFixture(WidgetMode.SingleUsage, 320, 80,
    night = true, freshness = "2天前") }

@PreviewTest
@Preview(name = "Launcher UsageHistoryLight", device = "spec:width=320dp,height=80dp,dpi=160")
@Composable
fun LauncherUsageHistoryLightScreenshot() { LauncherFixture(WidgetMode.SingleUsage, 320, 80,
    night = false, freshness = "2天前") }

@PreviewTest
@Preview(name = "Launcher RingDefault150DarkOk", device = "spec:width=150dp,height=100dp,dpi=160", fontScale = 1f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherRingDefault150DarkOkScreenshot() { LauncherFixture(WidgetMode.MultiRing, 150, 100,
    realRingFixture = true, night = true, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher RingDefault150DarkStale", device = "spec:width=150dp,height=100dp,dpi=160", fontScale = 1f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherRingDefault150DarkStaleScreenshot() { LauncherFixture(WidgetMode.MultiRing, 150, 100,
    realRingFixture = true, night = true, status = QuotaProviderStatus.Stale) }

@PreviewTest
@Preview(name = "Launcher RingDefault150DarkError", device = "spec:width=150dp,height=100dp,dpi=160", fontScale = 1f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherRingDefault150DarkErrorScreenshot() { LauncherFixture(WidgetMode.MultiRing, 150, 100,
    realRingFixture = true, night = true, status = QuotaProviderStatus.Error) }

@PreviewTest
@Preview(name = "Launcher RingDefault150DarkAuthRequired", device = "spec:width=150dp,height=100dp,dpi=160", fontScale = 1f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherRingDefault150DarkAuthRequiredScreenshot() { LauncherFixture(WidgetMode.MultiRing, 150, 100,
    realRingFixture = true, night = true, status = QuotaProviderStatus.AuthRequired) }

@PreviewTest
@Preview(name = "Launcher RingDefault150DarkFont200", device = "spec:width=150dp,height=100dp,dpi=160", fontScale = 2f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LauncherRingDefault150DarkFont200Screenshot() { LauncherFixture(WidgetMode.MultiRing, 150, 100, night = true, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingDefault150LightOk", device = "spec:width=150dp,height=100dp,dpi=160", fontScale = 1f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherRingDefault150LightOkScreenshot() { LauncherFixture(WidgetMode.MultiRing, 150, 100,
    realRingFixture = true, night = false, status = QuotaProviderStatus.Ok) }

@PreviewTest
@Preview(name = "Launcher RingDefault150LightStale", device = "spec:width=150dp,height=100dp,dpi=160", fontScale = 1f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherRingDefault150LightStaleScreenshot() { LauncherFixture(WidgetMode.MultiRing, 150, 100,
    realRingFixture = true, night = false, status = QuotaProviderStatus.Stale) }

@PreviewTest
@Preview(name = "Launcher RingDefault150LightError", device = "spec:width=150dp,height=100dp,dpi=160", fontScale = 1f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherRingDefault150LightErrorScreenshot() { LauncherFixture(WidgetMode.MultiRing, 150, 100,
    realRingFixture = true, night = false, status = QuotaProviderStatus.Error) }

@PreviewTest
@Preview(name = "Launcher RingDefault150LightAuthRequired", device = "spec:width=150dp,height=100dp,dpi=160", fontScale = 1f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherRingDefault150LightAuthRequiredScreenshot() { LauncherFixture(WidgetMode.MultiRing, 150, 100,
    realRingFixture = true, night = false, status = QuotaProviderStatus.AuthRequired) }

@PreviewTest
@Preview(name = "Launcher RingDefault150LightFont200", device = "spec:width=150dp,height=100dp,dpi=160", fontScale = 2f,
    uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
fun LauncherRingDefault150LightFont200Screenshot() { LauncherFixture(WidgetMode.MultiRing, 150, 100, night = false, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal110x100Dark", device = "spec:width=110dp,height=100dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal110x100DarkScreenshot() { LauncherFixture(WidgetMode.MultiRing, 110, 100, night = true, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal110x100Light", device = "spec:width=110dp,height=100dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal110x100LightScreenshot() { LauncherFixture(WidgetMode.MultiRing, 110, 100, night = false, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal150x99Dark", device = "spec:width=150dp,height=99dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal150x99DarkScreenshot() { LauncherFixture(WidgetMode.MultiRing, 150, 99, night = true, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal150x99Light", device = "spec:width=150dp,height=99dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal150x99LightScreenshot() { LauncherFixture(WidgetMode.MultiRing, 150, 99, night = false, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal180x100Dark", device = "spec:width=180dp,height=100dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal180x100DarkScreenshot() { LauncherFixture(WidgetMode.MultiRing, 180, 100, night = true, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal180x100Light", device = "spec:width=180dp,height=100dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal180x100LightScreenshot() { LauncherFixture(WidgetMode.MultiRing, 180, 100, night = false, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal188x99Dark", device = "spec:width=188dp,height=99dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal188x99DarkScreenshot() { LauncherFixture(WidgetMode.MultiRing, 188, 99, night = true, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal188x99Light", device = "spec:width=188dp,height=99dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal188x99LightScreenshot() { LauncherFixture(WidgetMode.MultiRing, 188, 99, night = false, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal200x99Dark", device = "spec:width=200dp,height=99dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal200x99DarkScreenshot() { LauncherFixture(WidgetMode.MultiRing, 200, 99, night = true, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal200x99Light", device = "spec:width=200dp,height=99dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal200x99LightScreenshot() { LauncherFixture(WidgetMode.MultiRing, 200, 99, night = false, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal240x80Dark", device = "spec:width=240dp,height=80dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal240x80DarkScreenshot() { LauncherFixture(WidgetMode.MultiRing, 240, 80, night = true, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal240x80Light", device = "spec:width=240dp,height=80dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal240x80LightScreenshot() { LauncherFixture(WidgetMode.MultiRing, 240, 80, night = false, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal320x99Dark", device = "spec:width=320dp,height=99dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal320x99DarkScreenshot() { LauncherFixture(WidgetMode.MultiRing, 320, 99, night = true, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal320x99Light", device = "spec:width=320dp,height=99dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocal320x99LightScreenshot() { LauncherFixture(WidgetMode.MultiRing, 320, 99, night = false, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal110x100DarkFont200", device = "spec:width=110dp,height=100dp,dpi=160", fontScale = 2f)
@Composable
fun LauncherRingLocal110x100DarkFont200Screenshot() { LauncherFixture(WidgetMode.MultiRing, 110, 100, night = true, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal110x100LightFont200", device = "spec:width=110dp,height=100dp,dpi=160", fontScale = 2f)
@Composable
fun LauncherRingLocal110x100LightFont200Screenshot() { LauncherFixture(WidgetMode.MultiRing, 110, 100, night = false, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal180x100DarkFont200", device = "spec:width=180dp,height=100dp,dpi=160", fontScale = 2f)
@Composable
fun LauncherRingLocal180x100DarkFont200Screenshot() { LauncherFixture(WidgetMode.MultiRing, 180, 100, night = true, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal180x100LightFont200", device = "spec:width=180dp,height=100dp,dpi=160", fontScale = 2f)
@Composable
fun LauncherRingLocal180x100LightFont200Screenshot() { LauncherFixture(WidgetMode.MultiRing, 180, 100, night = false, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal200x90DarkFont200", device = "spec:width=200dp,height=90dp,dpi=160", fontScale = 2f)
@Composable
fun LauncherRingLocal200x90DarkFont200Screenshot() { LauncherFixture(WidgetMode.MultiRing, 200, 90, night = true, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal200x90LightFont200", device = "spec:width=200dp,height=90dp,dpi=160", fontScale = 2f)
@Composable
fun LauncherRingLocal200x90LightFont200Screenshot() { LauncherFixture(WidgetMode.MultiRing, 200, 90, night = false, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal200x120DarkFont150", device = "spec:width=200dp,height=120dp,dpi=160", fontScale = 1.5f)
@Composable
fun LauncherRingLocal200x120DarkFont150Screenshot() { LauncherFixture(WidgetMode.MultiRing, 200, 120, night = true, realRingFixture = true) }

@PreviewTest
@Preview(name = "Launcher RingLocal200x120LightFont150", device = "spec:width=200dp,height=120dp,dpi=160", fontScale = 1.5f)
@Composable
fun LauncherRingLocal200x120LightFont150Screenshot() { LauncherFixture(WidgetMode.MultiRing, 200, 120, night = false, realRingFixture = true) }

/** 合成接缝回归：options预算宽240dp，实际父容器150dp；不是N2301实测尺寸。 */
@PreviewTest
@Preview(name = "Launcher RingLocalOption240Parent150Dark", device = "spec:width=150dp,height=90dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocalOption240Parent150DarkScreenshot() {
    LauncherFixture(WidgetMode.MultiRing, 240, 90, night = true, realRingFixture = true)
}

/** 合成接缝回归：options预算宽240dp，实际父容器150dp；不是N2301实测尺寸。 */
@PreviewTest
@Preview(name = "Launcher RingLocalOption240Parent150Light", device = "spec:width=150dp,height=90dp,dpi=160", fontScale = 1f)
@Composable
fun LauncherRingLocalOption240Parent150LightScreenshot() {
    LauncherFixture(WidgetMode.MultiRing, 240, 90, night = false, realRingFixture = true)
}
