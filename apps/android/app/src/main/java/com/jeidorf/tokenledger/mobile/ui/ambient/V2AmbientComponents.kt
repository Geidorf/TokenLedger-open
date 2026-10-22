package com.jeidorf.tokenledger.mobile.ui.ambient

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.coerceAtLeast
import androidx.compose.ui.unit.coerceIn
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jeidorf.tokenledger.mobile.AmbientFont
import com.jeidorf.tokenledger.mobile.AmbientRenderProfile
import com.jeidorf.tokenledger.mobile.AmbientRhythmSeries
import com.jeidorf.tokenledger.mobile.AmbientViewportPolicy
import com.jeidorf.tokenledger.mobile.ChartStyle
import com.jeidorf.tokenledger.mobile.DailyQuoteSnapshot
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.DeltaPresentation
import com.jeidorf.tokenledger.mobile.DeltaTone
import com.jeidorf.tokenledger.mobile.FillPolicy
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.LocalLedgerNow
import com.jeidorf.tokenledger.mobile.LowPowerPolicy
import com.jeidorf.tokenledger.mobile.MINUS_SIGN
import com.jeidorf.tokenledger.mobile.ProgressStyle
import com.jeidorf.tokenledger.mobile.QuotaProviderEnvelope
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.QuotaUiState
import com.jeidorf.tokenledger.mobile.QuotaWindowSnapshot
import com.jeidorf.tokenledger.mobile.RefreshCadence
import com.jeidorf.tokenledger.mobile.SmoothCurvePoint
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TABULAR_NUMERALS
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.addSmoothCurve
import com.jeidorf.tokenledger.mobile.comparisonKindPresentation
import com.jeidorf.tokenledger.mobile.dailyQuoteFor
import com.jeidorf.tokenledger.mobile.deltaPresentation
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.drawableProgressWindows
import com.jeidorf.tokenledger.mobile.effectiveQuotaProgressPresentation
import com.jeidorf.tokenledger.mobile.groupedQuotaWindowsForDisplay
import com.jeidorf.tokenledger.mobile.localizedCompactWindowLabel
import com.jeidorf.tokenledger.mobile.localizedDisplayName
import com.jeidorf.tokenledger.mobile.localizedLabel
import com.jeidorf.tokenledger.mobile.orderedQuotaProvidersForDisplay
import com.jeidorf.tokenledger.mobile.paddedChartMaximum
import com.jeidorf.tokenledger.mobile.quotaAvailableAccessibilityLabel
import com.jeidorf.tokenledger.mobile.quotaProgressWindowsForDisplay
import com.jeidorf.tokenledger.mobile.quotaWindowAccessibilityDescription
import com.jeidorf.tokenledger.mobile.rankedQuotaWindowsForDisplay
import com.jeidorf.tokenledger.mobile.ui.charts.V2HeatmapChart
import com.jeidorf.tokenledger.mobile.ui.charts.V2LineLegend
import com.jeidorf.tokenledger.mobile.ui.charts.V2TrendChart
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.tokenModeToggle
import com.jeidorf.tokenledger.mobile.ui.foundation.v2CacheHit
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatPercent
import com.jeidorf.tokenledger.mobile.ui.foundation.v2QuotaReason
import com.jeidorf.tokenledger.mobile.ui.foundation.v2ResetLabel
import com.jeidorf.tokenledger.mobile.ui.foundation.v2ShortDateTime
import com.jeidorf.tokenledger.mobile.ui.hero.V2MetricDivider
import com.jeidorf.tokenledger.mobile.ui.hero.V2MiniMetric
import com.jeidorf.tokenledger.mobile.ui.quota.v2QuotaStatusColor
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

/** 涨跌语义 -> 颜色。E-ink 调色板里 green/amber 本身已是灰阶，无需特判。 */
internal fun MobileV2Palette.deltaColor(tone: DeltaTone): Color = when (tone) {
    DeltaTone.Positive -> green
    DeltaTone.Warning -> amber
    DeltaTone.Neutral -> muted
}

internal fun ambientCadenceLabel(profile: AmbientRenderProfile): String =
    when (profile.refreshCadence) {
        RefreshCadence.OnDataChange -> "数据变化时更新"
        RefreshCadence.AlignedQuarterHour -> "对齐整点 15 分钟刷新"
    }

internal fun ambientDirectionalDelta(delta: DeltaPresentation): String = when {
    delta.label.startsWith("+") || delta.label == "本期新增" -> "↑ ${delta.label}"
    // 共用的变化率格式用 U+2212 作负号（R-11）；旧的 ASCII 连字符一并认。
    delta.label.startsWith(MINUS_SIGN) || delta.label.startsWith("-") -> "↓ ${delta.label}"
    else -> "→ ${delta.label}"
}

internal fun ambientUpdatedTime(state: DashboardUiState): String =
    state.lastUpdatedEpochMillis?.let { epochMillis ->
        Instant.ofEpochMilli(epochMillis)
            .atZone(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofPattern("HH:mm"))
    } ?: "待同步"

@Composable
internal fun V2LandscapeDailyQuote(
    palette: MobileV2Palette,
    snapshot: DailyQuoteSnapshot?,
    modifier: Modifier
) {
    val today = snapshot?.date ?: LocalDate.now()
    val quote = snapshot?.quote ?: remember(today) { dailyQuoteFor(today) }
    val dateLabel = remember(today) {
        today.format(DateTimeFormatter.ofPattern("M月d日 EEEE", Locale.SIMPLIFIED_CHINESE))
    }
    Column(
        modifier = modifier
            .padding(horizontal = 22.dp, vertical = 8.dp)
            .semantics { contentDescription = "今日一句：${quote.text}，${quote.source}" },
        verticalArrangement = Arrangement.Center
    ) {
        Text(dateLabel, color = palette.faint, fontSize = AmbientFont.small, fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp)
        Spacer(Modifier.height(16.dp))
        Text(
            quote.text,
            color = palette.text,
            fontSize = AmbientFont.numeral,
            lineHeight = 31.sp,
            fontWeight = FontWeight.Medium,
        )
        Spacer(Modifier.height(14.dp))
        Text(
            "— ${quote.source}",
            color = palette.muted,
            fontSize = AmbientFont.body,
            lineHeight = 12.sp,
            letterSpacing = 0.6.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
internal fun V2AmbientTokenBlock(
    palette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    onTokenDisplayModeChange: ((TokenDisplayMode) -> Unit)?,
    modifier: Modifier
) {
    val displayedTokens = displayedTokenCount(
        tokenDisplayMode,
        stats.summary.effectiveTokens,
        stats.summary.cachedTokens
    )
    val displayedTokenLabel = v2FormatTokens(displayedTokens)
    val density = LocalDensity.current
    val preferredTokenSize = when (displayedTokenLabel.length) {
        in 0..5 -> 172f
        6 -> 120f
        7 -> 100f
        else -> 88f
    }
    val delta = v2FormatPercent(stats.comparison?.delta?.tokens?.percent)
    BoxWithConstraints(
        modifier = modifier
            .then(
                if (onTokenDisplayModeChange != null) {
                    Modifier.tokenModeToggle(tokenDisplayMode, onTokenDisplayModeChange)
                } else {
                    Modifier
                }
            )
            .semantics {
                contentDescription = "${state.query.range.label}${tokenDisplayMode.label} Token，${v2FormatTokens(displayedTokens)}，同期 $delta"
            }
    ) {
        val reservedHeight = 54f
        val tokenSize = min(
            preferredTokenSize,
            (maxHeight.value - reservedHeight).coerceAtLeast(54f)
        )
        val tokenFontSize = (tokenSize / density.fontScale).sp
        val tokenLineHeight = ((tokenSize + 2f) / density.fontScale).sp
        val tokenLetterSpacing = (-tokenSize * 0.07f / density.fontScale).sp
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
            Text(
                "TOKENLEDGER",
                color = palette.faint,
                fontSize = AmbientFont.small,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.6.sp
            )
            Spacer(Modifier.height(12.dp))
            Text(
                displayedTokenLabel,
                color = palette.text,
                fontSize = tokenFontSize,
                lineHeight = tokenLineHeight,
                fontWeight = FontWeight.Bold,
                letterSpacing = tokenLetterSpacing,
                maxLines = 1
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "${state.query.range.label} · ${tokenDisplayMode.label} Token",
                    color = palette.muted,
                    fontSize = AmbientFont.bodyLarge,
                    letterSpacing = 0.6.sp
                )
                Spacer(Modifier.width(16.dp))
                Text(delta, color = palette.blue, fontSize = AmbientFont.label, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(4.dp))
                Text("同期", color = palette.faint, fontSize = AmbientFont.small)
            }
        }
    }
}

/**
 * 单个额度窗口的 220° 半环仪表盘。
 *
 * [emphasized] 为 true 时（额度墙档）放开字号上限并加厚描边。
 */
@Composable
internal fun V2AmbientQuotaRing(
    palette: MobileV2Palette,
    provider: QuotaProviderEnvelope,
    window: QuotaWindowSnapshot,
    forceStale: Boolean,
    profile: AmbientRenderProfile,
    modifier: Modifier,
    emphasized: Boolean = false
) {
    val dithered = profile.progressStyle == ProgressStyle.DitheredRing
    val now = LocalLedgerNow.current()
    val presentation = effectiveQuotaProgressPresentation(provider, window, now, forceStale)
    val providerName = provider.localizedDisplayName()
    val remainingFraction = presentation.availableFraction
    val status = presentation.status
    val statusText = status.localizedLabel()
    val valueText = presentation.availablePercent?.let { "$it%" } ?: statusText
    val accent = if (status == QuotaProviderStatus.Ok) {
        palette.blue
    } else {
        v2QuotaStatusColor(palette, status)
    }
    val displayName = remember(providerName, emphasized) {
        when {
            emphasized -> providerName
            providerName.contains("claude", ignoreCase = true) -> "Claude"
            providerName.contains("codex", ignoreCase = true) -> "Codex"
            else -> providerName.substringBefore(' ').take(12)
        }
    }
    val compactWindowLabel = remember(
        providerName,
        window.windowId,
        window.windowLabel,
        window.windowMinutes
    ) {
        window.localizedCompactWindowLabel(providerName)
    }
    BoxWithConstraints(
        modifier = modifier.semantics {
            contentDescription = quotaWindowAccessibilityDescription(
                providerName = providerName,
                windowLabel = compactWindowLabel,
                statusLabel = statusText,
                valueLabel = presentation.availablePercent?.let(::quotaAvailableAccessibilityLabel),
                resetLabel = v2ResetLabel(window.resetsAt),
                observedLabel = v2ShortDateTime(window.observedAt)
            )
        }
    ) {
        val gaugeSize = minOf(maxHeight * 0.68f, maxWidth * 0.78f).coerceAtLeast(1.dp)
        val labelTextSize = (gaugeSize.value * 0.095f)
            .coerceIn(7f, if (emphasized) 14f else 9f).sp
        val percentTextSize = (gaugeSize.value * 0.25f)
            .coerceIn(18f, if (emphasized) 56f else 28f).sp
        val statusValueTextSize = (gaugeSize.value * 0.14f)
            .coerceIn(10f, if (emphasized) 24f else 15f).sp
        val detailTextSize = (gaugeSize.value * 0.085f)
            .coerceIn(7f, if (emphasized) 12f else 9f).sp
        val verticalGap = (gaugeSize * 0.035f).coerceIn(2.dp, 5.dp)
        Column(
            modifier = Modifier
                .fillMaxSize()
                .align(Alignment.Center),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Text(
                "$displayName · $compactWindowLabel",
                color = palette.muted,
                fontSize = labelTextSize,
                lineHeight = (labelTextSize.value * 1.15f).sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(0.92f)
            )
            Spacer(Modifier.height(verticalGap))
            Box(
                Modifier.size(gaugeSize),
                contentAlignment = Alignment.Center
            ) {
                Spacer(
                    modifier = Modifier
                        .fillMaxSize()
                        .drawWithCache {
                            val minDimension = size.minDimension.coerceAtLeast(1f)
                            val strokeWidth = minDimension * if (dithered) 0.085f else 0.055f
                            val cap = if (dithered) StrokeCap.Butt else StrokeCap.Round
                            val dashEffect = if (dithered) {
                                PathEffect.dashPathEffect(floatArrayOf(strokeWidth * 1.1f, strokeWidth * 1.45f))
                            } else null
                            val trackStroke = Stroke(
                                width = strokeWidth,
                                cap = cap,
                                pathEffect = dashEffect
                            )
                            val progressStroke = Stroke(
                                width = strokeWidth,
                                cap = cap
                            )
                            val inset = minDimension * 0.09f
                            val diameter = (minDimension - inset * 2f).coerceAtLeast(1f)
                            val arcSize = Size(diameter, diameter)
                            val topLeft = Offset((size.width - diameter) / 2f, (size.height - diameter) / 2f)
                            val trackColor = if (palette.isEInk) palette.faint else palette.divider

                            onDrawBehind {
                                drawArc(
                                    color = trackColor,
                                    startAngle = 70f,
                                    sweepAngle = 220f,
                                    useCenter = false,
                                    topLeft = topLeft,
                                    size = arcSize,
                                    style = trackStroke
                                )
                                remainingFraction?.let { safeFraction ->
                                    drawArc(
                                        color = accent,
                                        startAngle = 70f,
                                        sweepAngle = 220f * safeFraction,
                                        useCenter = false,
                                        topLeft = topLeft,
                                        size = arcSize,
                                        style = progressStroke
                                    )
                                }
                            }
                        }
                )
                Text(
                    valueText,
                    color = accent,
                    fontSize = if (remainingFraction == null) statusValueTextSize else percentTextSize,
                    lineHeight = if (remainingFraction == null) statusValueTextSize else percentTextSize,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.align(Alignment.Center)
                )
                Text(
                    when {
                        status == QuotaProviderStatus.Ok -> "可用"
                        status == QuotaProviderStatus.Stale -> "历史数据"
                        else -> "状态"
                    },
                    color = if (status == QuotaProviderStatus.Ok) palette.muted else accent,
                    fontSize = detailTextSize,
                    lineHeight = detailTextSize,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = gaugeSize * 0.16f)
                )
            }
            Spacer(Modifier.height(verticalGap))
            Text(
                when (status) {
                    QuotaProviderStatus.Ok -> v2ResetLabel(window.resetsAt)
                    QuotaProviderStatus.Stale ->
                        "历史数据 · 更新于 ${v2ShortDateTime(window.observedAt)}"
                    else -> "$statusText · 更新于 ${v2ShortDateTime(window.observedAt)}"
                },
                color = if (status == QuotaProviderStatus.Ok) palette.faint else accent,
                fontSize = detailTextSize,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

@Composable
internal fun V2AmbientQuotaCluster(
    palette: MobileV2Palette,
    state: DashboardUiState,
    profile: AmbientRenderProfile,
    policy: LowPowerPolicy,
    modifier: Modifier
) {
    val quota = state.quota as? QuotaUiState.Available
    val providers = quota?.snapshot?.providers.orEmpty()
    val allWindows = quotaProgressWindowsForDisplay(providers, Int.MAX_VALUE)
    val windows = allWindows.take(policy.visibleQuotaWindowLimit.coerceIn(0, 2))
    val hiddenWindows = allWindows.size - windows.size
    Column(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (hiddenWindows > 0) "额度 · 另有 $hiddenWindows 个来源" else "额度",
                color = palette.faint,
                fontSize = AmbientFont.micro,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.8.sp
            )
            Spacer(Modifier.weight(1f))
        }
        Spacer(Modifier.height(8.dp))
        if (windows.isEmpty()) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
                Text("额度待同步", color = palette.muted, fontSize = AmbientFont.title)
                Spacer(Modifier.height(6.dp))
                Text("未同步不代表 0%", color = palette.faint, fontSize = AmbientFont.small)
            }
        } else if (profile.progressStyle == ProgressStyle.Ring ||
            profile.progressStyle == ProgressStyle.DitheredRing
        ) {
            Row(
                Modifier.fillMaxWidth().weight(1f),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                windows.forEach { (provider, window) ->
                    V2AmbientQuotaRing(
                        palette = palette,
                        provider = provider,
                        window = window,
                        forceStale = quota?.showingCachedData == true,
                        profile = profile,
                        modifier = Modifier.fillMaxHeight().weight(1f)
                    )
                }
            }
        } else {
            Column(
                Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                windows.forEach { (provider, window) ->
                    V2AmbientQuotaRow(
                        palette = palette,
                        provider = provider,
                        window = window,
                        forceStale = quota?.showingCachedData == true,
                        profile = profile,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }
    }
}

@Composable
internal fun V2AmbientFooter(
    palette: MobileV2Palette,
    stats: StatsData,
    modifier: Modifier
) {
    val costMasked = LocalCostMaskEnabled.current
    val currency = LocalDashboardCurrency.current
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(0.95f), verticalAlignment = Alignment.CenterVertically) {
            V2MiniMetric("输入", v2FormatTokens(stats.summary.inputTokens), palette, Modifier.weight(1f))
            V2MiniMetric("输出", v2FormatTokens(stats.summary.outputTokens), palette, Modifier.weight(1f))
            V2MiniMetric("费用", v2FormatMoney(LocalContext.current, stats.summary.totalCost, costMasked, currency), palette, Modifier.weight(1f))
        }
        Column(Modifier.weight(1.12f).padding(horizontal = 24.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("12 周活跃度", color = palette.faint, fontSize = AmbientFont.micro, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
                Spacer(Modifier.weight(1f))
            }
            Spacer(Modifier.height(8.dp))
            V2HeatmapChart(palette, stats.heatmap, Modifier.fillMaxWidth().height(66.dp), weeks = 12)
        }
        Text(
            "JEIDORF",
            color = palette.blue,
            style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS),
            fontWeight = FontWeight.Bold,
            fontSize = AmbientFont.label,
            letterSpacing = 3.6.sp,
            modifier = Modifier
                .width(146.dp)
                .semantics { contentDescription = "Jeidorf 签名字标" }
        )
    }
}

@Composable
internal fun V2LandscapeWidgetContent(
    palette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    profile: AmbientRenderProfile,
    tokenDisplayMode: TokenDisplayMode,
    policy: LowPowerPolicy,
    viewport: AmbientViewportPolicy,
    onTokenDisplayModeChange: ((TokenDisplayMode) -> Unit)?
) {
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().weight(viewport.consoleTopWeight),
            verticalAlignment = Alignment.Top
        ) {
            V2AmbientTokenBlock(
                palette,
                state,
                stats,
                tokenDisplayMode,
                onTokenDisplayModeChange,
                Modifier.weight(5f).fillMaxHeight()
            )
            V2LandscapeDailyQuote(palette, state.dailyQuote, Modifier.weight(4f).fillMaxHeight())
            V2AmbientQuotaCluster(palette, state, profile, policy, Modifier.weight(3f).fillMaxHeight())
        }
        Column(Modifier.fillMaxWidth().weight(viewport.consoleChartWeight)) {
            V2TrendChart(
                palette,
                stats.comparison,
                stats.trends,
                Modifier.fillMaxWidth().weight(1f),
                compact = true,
                normalizeRange = true
            )
            Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                V2LineLegend(palette.blue, false, "当前周期", palette)
                V2LineLegend(palette.muted, true, "上一周期", palette)
            }
        }
        V2AmbientFooter(palette, stats, Modifier.fillMaxWidth().weight(viewport.consoleFooterWeight))
    }
}

@Composable
internal fun V2LedgerRule(palette: MobileV2Palette, thick: Boolean = false) {
    HorizontalDivider(
        color = if (palette.isEInk) Color.Black else palette.divider,
        thickness = if (thick) 2.dp else 1.dp
    )
}

@Composable
internal fun V2LedgerSectionTitle(palette: MobileV2Palette, title: String) {
    Text(
        title,
        color = palette.muted,
        fontSize = AmbientFont.body,
        fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace,
        letterSpacing = 2.sp,
        modifier = Modifier.semantics { heading() }
    )
}

@Composable
internal fun V2AmbientMetricTriple(
    palette: MobileV2Palette,
    stats: StatsData,
    profile: AmbientRenderProfile,
    modifier: Modifier = Modifier
) {
    val costMasked = LocalCostMaskEnabled.current
    val currency = LocalDashboardCurrency.current
    val shape = RoundedCornerShape(profile.cornerRadiusDp.dp)
    Row(
        modifier
            .clip(shape)
            .then(
                if (profile.fillPolicy == FillPolicy.Outline) {
                    Modifier.border(profile.strokeWidthDp.dp, palette.divider, shape)
                } else {
                    Modifier.background(palette.surface)
                }
            )
            .padding(vertical = 10.dp, horizontal = 6.dp)
    ) {
        V2MiniMetric("费用", v2FormatMoney(LocalContext.current, stats.summary.totalCost, costMasked, currency), palette, Modifier.weight(1f))
        V2MetricDivider(palette)
        V2MiniMetric("记录数", v2FormatNumber(stats.summary.totalRequests), palette, Modifier.weight(1f))
        V2MetricDivider(palette)
        V2MiniMetric("缓存复用率", v2CacheHit(stats.summary), palette, Modifier.weight(1f))
    }
}

@Composable
internal fun V2AmbientRhythmChart(
    palette: MobileV2Palette,
    series: AmbientRhythmSeries,
    profile: AmbientRenderProfile,
    modifier: Modifier,
    showPrevious: Boolean,
    fillArea: Boolean,
    showCurrentMarker: Boolean = false,
    emptyMessage: String? = null
) {
    val previous = if (showPrevious) series.previous else emptyList()
    val peak = remember(series, showPrevious) {
        ((series.current + previous).maxOrNull() ?: 0f).coerceAtLeast(0f)
    }
    val maximum = remember(series, showPrevious) {
        paddedChartMaximum(series.current + previous)
    }
    val description = remember(series, previous, peak) {
        buildString {
            append(series.title)
            append("，本期 ${series.current.size} 个数据点")
            if (previous.isNotEmpty()) append("，${series.previousLabel} ${previous.size} 个数据点")
            append("，峰值 ${v2FormatTokens(peak.toLong())}")
        }
    }
    val stepped = profile.chartStyle == ChartStyle.SteppedBar
    Box(
        modifier = modifier
            .semantics { contentDescription = description }
            .drawWithCache {
                if (series.current.isEmpty()) {
                    onDrawBehind { }
                } else {
                    val top = 4.dp.toPx()
                    val bottom = size.height - 4.dp.toPx()
                    val left = 0f
                    val right = size.width
                    val span = series.axisSpan.coerceAtLeast(1).toFloat()
                    fun points(values: List<Float>): List<SmoothCurvePoint> =
                        values.mapIndexed { index, value ->
                            SmoothCurvePoint(
                                x = left + (right - left) * (index / span).coerceIn(0f, 1f),
                                y = bottom - (bottom - top) * (value / maximum).coerceIn(0f, 1f)
                            )
                        }
                    val currentPoints = points(series.current)
                    val previousPoints = previous.takeIf { it.isNotEmpty() }?.let(::points)
                    val currentStroke = Stroke(width = profile.strokeWidthDp.dp.toPx(), cap = StrokeCap.Round)
                    val previousStroke = Stroke(
                        width = (profile.strokeWidthDp * 0.7f).coerceAtLeast(1f).dp.toPx(),
                        pathEffect = PathEffect.dashPathEffect(
                            floatArrayOf(6.dp.toPx(), 5.dp.toPx())
                        ),
                        cap = StrokeCap.Butt
                    )
                    val barWidth = ((right - left) / (span + 1f)).coerceAtLeast(1f)
                    val currentPath = if (stepped) null else Path().apply {
                        currentPoints.firstOrNull()?.let { first ->
                            moveTo(first.x, first.y)
                            addSmoothCurve(currentPoints, minY = top, maxY = bottom)
                        }
                    }
                    val previousPath = if (stepped || previousPoints == null) null else Path().apply {
                        previousPoints.firstOrNull()?.let { first ->
                            moveTo(first.x, first.y)
                            addSmoothCurve(previousPoints, minY = top, maxY = bottom)
                        }
                    }
                    val areaPath = if (stepped || !fillArea || currentPoints.isEmpty()) {
                        null
                    } else {
                        Path().apply {
                            val first = currentPoints.first()
                            moveTo(first.x, bottom)
                            lineTo(first.x, first.y)
                            addSmoothCurve(currentPoints, minY = top, maxY = bottom)
                            lineTo(currentPoints.last().x, bottom)
                            close()
                        }
                    }
                    val areaBrush = Brush.verticalGradient(
                        listOf(palette.blue.copy(alpha = 0.24f), Color.Transparent)
                    )
                    onDrawBehind {
                        drawLine(palette.divider, Offset(left, bottom), Offset(right, bottom), 1f)
                        if (showCurrentMarker && series.isHourly) {
                            currentPoints.lastOrNull()?.let { current ->
                                drawLine(
                                    color = palette.faint.copy(alpha = 0.72f),
                                    start = Offset(current.x, top),
                                    end = Offset(current.x, bottom),
                                    strokeWidth = 1.dp.toPx(),
                                    pathEffect = PathEffect.dashPathEffect(
                                        floatArrayOf(4.dp.toPx(), 4.dp.toPx())
                                    )
                                )
                            }
                        }
                        if (stepped) {
                            previousPoints?.forEach { p ->
                                drawRect(
                                    color = palette.muted,
                                    topLeft = Offset(p.x - barWidth / 2f, p.y),
                                    size = Size(barWidth, (bottom - p.y).coerceAtLeast(0f)),
                                    style = Stroke(width = 1.dp.toPx())
                                )
                            }
                            currentPoints.forEach { p ->
                                drawRect(
                                    color = palette.text,
                                    topLeft = Offset(p.x - barWidth * 0.3f, p.y),
                                    size = Size(barWidth * 0.6f, (bottom - p.y).coerceAtLeast(0f))
                                )
                            }
                        } else {
                            previousPath?.let { drawPath(it, color = palette.muted, style = previousStroke) }
                            areaPath?.let { drawPath(it, brush = areaBrush) }
                            currentPath?.let { drawPath(it, color = palette.blue, style = currentStroke) }
                        }
                        if (showCurrentMarker && series.isHourly) {
                            currentPoints.lastOrNull()?.let { current ->
                                drawCircle(
                                    color = palette.blue,
                                    radius = 3.dp.toPx(),
                                    center = Offset(current.x, current.y)
                                )
                            }
                        }
                    }
                }
            }
    ) {
        if (emptyMessage != null && series.current.isEmpty()) {
            Text(
                emptyMessage,
                color = palette.muted,
                fontSize = AmbientFont.label,
                modifier = Modifier.align(Alignment.Center).padding(8.dp)
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun V2AmbientQuotaBoard(
    palette: MobileV2Palette,
    state: DashboardUiState,
    profile: AmbientRenderProfile,
    limit: Int,
    columns: Int,
    modifier: Modifier = Modifier
) {
    val quota = state.quota
    if (quota !is QuotaUiState.Available) {
        val message = when (quota) {
            is QuotaUiState.Unsynced -> quota.message
            is QuotaUiState.Unavailable -> quota.message
            else -> "额度加载中"
        }
        Column(modifier) {
            Text(message, color = palette.text, fontSize = AmbientFont.label)
            Text("未同步不代表 0%", color = palette.faint, fontSize = AmbientFont.body)
        }
        return
    }
    val providers = remember(quota.snapshot) {
        quota.snapshot.providers.orderedQuotaProvidersForDisplay()
    }
    val entries = remember(quota.snapshot, limit) {
        if (limit == Int.MAX_VALUE) {
            quota.snapshot.providers.groupedQuotaWindowsForDisplay()
        } else {
            quota.snapshot.providers.rankedQuotaWindowsForDisplay()
        }
    }
    val budget = if (limit <= 0) 0 else limit
    val shown = entries.take(budget)
    val hidden = entries.size - shown.size
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (entries.isEmpty()) {
            Text("暂无可绘制的额度窗口", color = palette.text, fontSize = AmbientFont.label)
            Text("未同步不代表 0%", color = palette.faint, fontSize = AmbientFont.body)
        } else {
            FlowRow(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                maxItemsInEachRow = columns.coerceAtLeast(1)
            ) {
                val fraction = if (columns >= 2) 0.485f else 1f
                shown.forEach { (provider, window) ->
                    V2AmbientQuotaRow(
                        palette = palette,
                        provider = provider,
                        window = window,
                        forceStale = quota.showingCachedData,
                        profile = profile,
                        modifier = Modifier.fillMaxWidth(fraction)
                    )
                }
            }
        }
        if (hidden > 0) {
            Text("另有 $hidden 个窗口未显示", color = palette.muted, fontSize = AmbientFont.body)
        }
        providers.filter { it.drawableProgressWindows().isEmpty() }.forEach { provider ->
            Text(
                "${provider.localizedDisplayName()} · ${v2QuotaReason(provider.reasonCode, provider.scope)}",
                color = palette.faint,
                fontSize = AmbientFont.body
            )
        }
    }
}

@Composable
internal fun V2AmbientQuotaRow(
    palette: MobileV2Palette,
    provider: QuotaProviderEnvelope,
    window: QuotaWindowSnapshot,
    forceStale: Boolean,
    profile: AmbientRenderProfile,
    modifier: Modifier = Modifier
) {
    val presentation = effectiveQuotaProgressPresentation(
        provider = provider,
        window = window,
        now = LocalLedgerNow.current(),
        forceStale = forceStale
    )
    val providerName = provider.localizedDisplayName()
    val status = presentation.status
    val statusText = status.localizedLabel()
    val remainingFraction = presentation.availableFraction
    val valueText = presentation.availablePercent?.let { "$it%" } ?: statusText
    val accent = if (status == QuotaProviderStatus.Ok) {
        palette.blue
    } else {
        v2QuotaStatusColor(palette, status)
    }
    val windowLabel = remember(
        providerName,
        window.windowId,
        window.windowLabel,
        window.windowMinutes
    ) {
        window.localizedCompactWindowLabel(providerName)
    }
    val shape = RoundedCornerShape(profile.cornerRadiusDp.dp)
    val mono = if (profile.useMonospaceNumerals) FontFamily.Monospace else FontFamily.Default
    Column(
        modifier
            .clip(shape)
            .then(
                if (profile.fillPolicy == FillPolicy.Outline) {
                    Modifier.border(profile.strokeWidthDp.dp, palette.divider, shape)
                } else {
                    Modifier.background(palette.surface)
                }
            )
            .padding(10.dp)
            .semantics {
                contentDescription = quotaWindowAccessibilityDescription(
                    providerName = providerName,
                    windowLabel = windowLabel,
                    statusLabel = statusText,
                    valueLabel = presentation.availablePercent?.let(::quotaAvailableAccessibilityLabel),
                    resetLabel = v2ResetLabel(window.resetsAt),
                    observedLabel = v2ShortDateTime(window.observedAt)
                )
            },
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "$providerName · $windowLabel",
                color = palette.text,
                fontSize = AmbientFont.bodyLarge,
                fontFamily = mono,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            Text(
                valueText,
                color = if (status == QuotaProviderStatus.Ok) palette.text else accent,
                fontSize = AmbientFont.title,
                fontWeight = FontWeight.Bold,
                fontFamily = mono
            )
        }
        if (remainingFraction != null) {
            V2AmbientProgressTrack(
                palette = palette,
                fraction = remainingFraction,
                accent = accent,
                profile = profile,
                modifier = Modifier.fillMaxWidth()
            )
        }
        Text(
            when (status) {
                QuotaProviderStatus.Ok -> v2ResetLabel(window.resetsAt)
                QuotaProviderStatus.Stale ->
                    "历史数据 · 更新于 ${v2ShortDateTime(window.observedAt)}"
                else -> "$statusText · 更新于 ${v2ShortDateTime(window.observedAt)}"
            },
            color = if (status == QuotaProviderStatus.Ok) palette.faint else accent,
            fontSize = AmbientFont.small,
            style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS)
        )
    }
}

@Composable
internal fun V2AmbientProgressTrack(
    palette: MobileV2Palette,
    fraction: Float,
    accent: Color,
    profile: AmbientRenderProfile,
    modifier: Modifier = Modifier
) {
    val safe = fraction.coerceIn(0f, 1f)
    if (profile.progressStyle == ProgressStyle.CharTrack) {
        val cells = 16
        val filled = Math.round(safe * cells).coerceIn(0, cells)
        Text(
            "[" + "█".repeat(filled) + "░".repeat(cells - filled) + "]",
            color = palette.text,
            fontSize = AmbientFont.bodyLarge,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            modifier = modifier
        )
        return
    }
    LinearProgressIndicator(
        progress = { safe },
        modifier = modifier
            .height(if (palette.isEInk) 6.dp else 5.dp)
            .clip(RoundedCornerShape(999.dp)),
        color = accent,
        trackColor = if (palette.isEInk) Color(0xFFE0E0E0) else palette.raised
    )
}

@Composable
internal fun V2AmbientComparisonTable(
    palette: MobileV2Palette,
    stats: StatsData,
    modifier: Modifier = Modifier
) {
    val comparison = stats.comparison
    if (comparison == null) {
        Text("同期数据不可用", color = palette.muted, fontSize = AmbientFont.bodyLarge, modifier = modifier)
        return
    }
    val context = LocalContext.current
    val costMasked = LocalCostMaskEnabled.current
    val currency = LocalDashboardCurrency.current
    val presentation = comparisonKindPresentation(comparison.window.kind)
    val rows = listOf(
        Triple(
            "有效 Token",
            v2FormatTokens(comparison.current.summary.effectiveTokens) to
                v2FormatTokens(comparison.previous.summary.effectiveTokens),
            deltaPresentation(comparison.delta.tokens)
        ),
        Triple(
            "费用",
            v2FormatMoney(context, comparison.current.summary.totalCost, costMasked, currency) to
                v2FormatMoney(context, comparison.previous.summary.totalCost, costMasked, currency),
            deltaPresentation(comparison.delta.cost)
        ),
        Triple(
            "记录数",
            v2FormatNumber(comparison.current.summary.totalRequests) to
                v2FormatNumber(comparison.previous.summary.totalRequests),
            deltaPresentation(comparison.delta.requests)
        )
    )
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row {
            Text(
                presentation.windowLabel,
                color = palette.faint,
                fontSize = AmbientFont.small,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.weight(1.2f)
            )
            Text(
                "本期",
                color = palette.faint,
                fontSize = AmbientFont.small,
                style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS),
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f)
            )
            Text(
                "上期",
                color = palette.faint,
                fontSize = AmbientFont.small,
                style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS),
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f)
            )
            Text(
                "Δ",
                color = palette.faint,
                fontSize = AmbientFont.small,
                fontFamily = FontFamily.Monospace,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(0.9f)
            )
        }
        rows.forEach { (label, values, delta) ->
            Row(
                Modifier.semantics {
                    contentDescription = "$label，本期 ${values.first}，上期 ${values.second}，${delta.label}"
                }
            ) {
                Text(
                    label,
                    color = palette.muted,
                    fontSize = AmbientFont.bodyLarge,
                    style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS),
                    modifier = Modifier.weight(1.2f)
                )
                Text(
                    values.first,
                    color = palette.text,
                    fontSize = AmbientFont.bodyLarge,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.End,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    values.second,
                    color = palette.muted,
                    fontSize = AmbientFont.bodyLarge,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.End,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    delta.label,
                    color = palette.deltaColor(delta.tone),
                    fontSize = AmbientFont.bodyLarge,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.End,
                    maxLines = 1,
                    modifier = Modifier.weight(0.9f)
                )
            }
        }
    }
}

@Composable
internal fun V2AmbientFreshnessFooter(
    palette: MobileV2Palette,
    state: DashboardUiState,
    profile: AmbientRenderProfile,
    modifier: Modifier = Modifier
) {
    val quota = state.quota as? QuotaUiState.Available
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            "数据新鲜度",
            color = palette.faint,
            fontSize = AmbientFont.small,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.6.sp,
            style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS)
        )
        Text(
            "看板 · ${v2ShortDateTime(
                state.lastUpdatedEpochMillis?.let {
                    Instant.ofEpochMilli(it).toString()
                }
            )}${if (state.showingCachedData) " · 本地缓存" else ""}",
            color = palette.muted,
            fontSize = AmbientFont.body,
            style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS)
        )
        if (quota == null) {
            Text("额度 · 未同步（不代表 0%）", color = palette.muted, fontSize = AmbientFont.body)
        } else {
            quota.snapshot.providers.orderedQuotaProvidersForDisplay().forEach { provider ->
                val observedAt = provider.windows.minOfOrNull { it.observedAt }
                Text(
                    "${provider.localizedDisplayName()} · ${provider.status.localizedLabel()} · ${v2ShortDateTime(observedAt)}",
                    color = palette.muted,
                    fontSize = AmbientFont.body,
                    style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
            if (quota.showingCachedData) {
                Text("额度来自本地缓存", color = palette.faint, fontSize = AmbientFont.small)
            }
        }
    }
}

@Composable
internal fun V2AmbientQuotaFreshnessLine(
    palette: MobileV2Palette,
    state: DashboardUiState,
    profile: AmbientRenderProfile,
    modifier: Modifier = Modifier
) {
    val quota = state.quota as? QuotaUiState.Available
    val summary = quota?.snapshot?.providers
        ?.orderedQuotaProvidersForDisplay()
        ?.joinToString(" · ") { provider ->
            val name = provider.localizedDisplayName().substringBefore(' ')
            val observedAt = provider.windows.maxOfOrNull { it.observedAt }
            "$name ${v2ShortDateTime(observedAt)}"
        }
        ?: "额度待同步"
    Text(
        "更新 · $summary",
        color = palette.muted,
        fontSize = AmbientFont.small,
        style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS),
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
    )
}

@Composable
internal fun V2AmbientQuotaBarCard(
    palette: MobileV2Palette,
    provider: QuotaProviderEnvelope,
    window: QuotaWindowSnapshot,
    forceStale: Boolean,
    profile: AmbientRenderProfile,
    modifier: Modifier
) {
    val presentation = effectiveQuotaProgressPresentation(
        provider = provider,
        window = window,
        now = LocalLedgerNow.current(),
        forceStale = forceStale
    )
    val providerName = provider.localizedDisplayName()
    val status = presentation.status
    val statusText = status.localizedLabel()
    val remainingFraction = presentation.availableFraction
    val valueText = presentation.availablePercent?.let { "$it%" } ?: statusText
    val accent = if (status == QuotaProviderStatus.Ok) {
        palette.blue
    } else {
        v2QuotaStatusColor(palette, status)
    }
    val label = "${providerName.substringBefore(' ')} · ${window.localizedCompactWindowLabel(providerName)}"
    Column(
        modifier
            .clip(RoundedCornerShape(profile.cornerRadiusDp.dp))
            .background(palette.surface)
            .border(profile.strokeWidthDp.dp, palette.divider, RoundedCornerShape(profile.cornerRadiusDp.dp))
            .padding(16.dp)
            .semantics {
                contentDescription = quotaWindowAccessibilityDescription(
                    providerName = providerName,
                    windowLabel = window.localizedCompactWindowLabel(providerName),
                    statusLabel = statusText,
                    valueLabel = presentation.availablePercent?.let(::quotaAvailableAccessibilityLabel),
                    resetLabel = v2ResetLabel(window.resetsAt),
                    observedLabel = v2ShortDateTime(window.observedAt)
                )
            },
        verticalArrangement = Arrangement.Center
    ) {
        Text(label, color = palette.muted, fontSize = AmbientFont.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(8.dp))
        Text(
            valueText,
            color = accent,
            fontSize = if (remainingFraction == null) AmbientFont.numeral else AmbientFont.display,
            lineHeight = if (remainingFraction == null) 28.sp else 42.sp,
            fontWeight = FontWeight.Bold
        )
        if (remainingFraction != null) {
            Spacer(Modifier.height(12.dp))
            LinearProgressIndicator(
                progress = { remainingFraction },
                modifier = Modifier.fillMaxWidth().height(12.dp).clip(RoundedCornerShape(999.dp)),
                color = accent,
                trackColor = palette.raised
            )
        }
        Spacer(Modifier.height(8.dp))
        Text(
            when (status) {
                QuotaProviderStatus.Ok -> v2ResetLabel(window.resetsAt)
                QuotaProviderStatus.Stale ->
                    "历史数据 · 更新于 ${v2ShortDateTime(window.observedAt)}"
                else -> "$statusText · 更新于 ${v2ShortDateTime(window.observedAt)}"
            },
            color = if (status == QuotaProviderStatus.Ok) palette.faint else accent,
            fontSize = AmbientFont.body,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
internal fun V2JeidorfWordmark(
    palette: MobileV2Palette,
    compact: Boolean = false
) {
    val shape = RoundedCornerShape(topStart = 2.dp, topEnd = 9.dp, bottomEnd = 2.dp, bottomStart = 9.dp)
    val accent = if (palette.isEInk) palette.text else palette.blue
    Box(
        modifier = Modifier
            .clip(shape)
            .background(Color.Transparent)
            .border(if (palette.isEInk) 1.5.dp else 0.75.dp, accent, shape)
            .padding(horizontal = if (compact) 8.dp else 10.dp, vertical = if (compact) 3.dp else 5.dp)
            .semantics { contentDescription = "Jeidorf 签名字标" },
        contentAlignment = Alignment.Center
    ) {
        Text(
            "JEIDORF",
            color = accent,
            style = TextStyle(fontFeatureSettings = TABULAR_NUMERALS),
            fontWeight = FontWeight.Bold,
            fontSize = if (compact) AmbientFont.small else AmbientFont.body,
            letterSpacing = if (compact) 1.2.sp else 1.8.sp
        )
    }
}
