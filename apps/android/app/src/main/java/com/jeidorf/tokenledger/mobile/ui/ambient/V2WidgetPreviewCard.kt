package com.jeidorf.tokenledger.mobile.ui.ambient

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jeidorf.tokenledger.mobile.AmbientElement
import com.jeidorf.tokenledger.mobile.AmbientFont
import com.jeidorf.tokenledger.mobile.AmbientMode
import com.jeidorf.tokenledger.mobile.AmbientRenderProfile
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.FillPolicy
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.LocalLedgerNow
import com.jeidorf.tokenledger.mobile.QuotaDisplayValue
import com.jeidorf.tokenledger.mobile.QuotaProviderEnvelope
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.QuotaSeverity
import com.jeidorf.tokenledger.mobile.QuotaUiState
import com.jeidorf.tokenledger.mobile.QuotaWindowSnapshot
import com.jeidorf.tokenledger.mobile.ReportMetricMode
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ambientPreviewElements
import com.jeidorf.tokenledger.mobile.ambientRhythmSeries
import com.jeidorf.tokenledger.mobile.displayValue
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.effectiveStatus
import com.jeidorf.tokenledger.mobile.localizedCompactWindowLabel
import com.jeidorf.tokenledger.mobile.localizedDisplayName
import com.jeidorf.tokenledger.mobile.localizedLabel
import com.jeidorf.tokenledger.mobile.quotaAvailablePercent
import com.jeidorf.tokenledger.mobile.quotaProgressWindowsForDisplay
import com.jeidorf.tokenledger.mobile.quotaWindowAccessibilityDescription
import com.jeidorf.tokenledger.mobile.rankedQuotaWindowsForDisplay
import com.jeidorf.tokenledger.mobile.resolveRenderProfile
import com.jeidorf.tokenledger.mobile.trendAvailabilityMessage
import com.jeidorf.tokenledger.mobile.ui.charts.V2HeatmapChart
import com.jeidorf.tokenledger.mobile.ui.charts.V2TrendChart
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Segment
import com.jeidorf.tokenledger.mobile.ui.foundation.V2SegmentedToggle
import com.jeidorf.tokenledger.mobile.ui.foundation.tokenModeToggle
import com.jeidorf.tokenledger.mobile.ui.foundation.v2CacheHit
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatPercent
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.v2ResetLabel
import com.jeidorf.tokenledger.mobile.ui.foundation.v2ShortDateTime
import com.jeidorf.tokenledger.mobile.ui.hero.V2MetricDivider
import com.jeidorf.tokenledger.mobile.ui.hero.V2MiniMetric
import com.jeidorf.tokenledger.mobile.ui.quota.v2QuotaStatusColor
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import com.jeidorf.tokenledger.mobile.widget.WidgetThresholdBand
import com.jeidorf.tokenledger.mobile.widget.widgetAvailabilityBand
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * 待机屏子页的缩略画面：只画「屏幕」本身，模式名、说明与彩屏 / 墨水屏切换由子页的标题行负责。
 * [einkPreview] 由调用方持有，切换后说明文字与画面一起变。
 */
@Composable
internal fun V2AmbientModePreviewCard(
    outerPalette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    appearance: LedgerAppearance,
    mode: AmbientMode,
    einkPreview: Boolean,
    tokenDisplayMode: TokenDisplayMode,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit
) {
    val previewAppearance = when {
        einkPreview -> LedgerAppearance.EInk
        appearance == LedgerAppearance.EInk -> LedgerAppearance.Dark
        else -> appearance
    }
    val palette = remember(previewAppearance) { v2Palette(previewAppearance) }
    val profile = remember(mode, previewAppearance) { resolveRenderProfile(mode, previewAppearance) }
    val elements = remember(mode) { ambientPreviewElements(mode) }
    val rhythmSeries = remember(stats) { ambientRhythmSeries(stats.comparison, stats.trends) }
    val shape = RoundedCornerShape(profile.cornerRadiusDp.dp)
    // 外圈一道发丝线当「屏框」，和页面其余卡片同一套描边；里面才是摆件自己的底色。
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(LedgerRadius.xl + 4.dp))
            .background(outerPalette.raised)
            .border(LedgerStroke.hairline, outerPalette.divider, RoundedCornerShape(LedgerRadius.xl + 4.dp))
            .padding(LedgerSpace.sm)
    ) {
        Card(
            colors = CardDefaults.cardColors(containerColor = palette.surface),
            border = if (palette.isEInk) BorderStroke(profile.strokeWidthDp.dp, palette.divider) else null,
            elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
            shape = shape,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 190.dp)
                .semantics {
                    contentDescription = "${mode.label}摆件预览，" +
                        (if (einkPreview) "墨水屏形态。" else "彩色形态。") +
                        (if (einkPreview) mode.einkSummary else mode.summary)
                }
        ) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                elements.forEach { element -> key(element) {
                    when (element) {
                        AmbientElement.Masthead -> V2AmbientPreviewMasthead(palette, state, profile)
                        AmbientElement.HeroTokens -> V2AmbientPreviewHero(
                            palette, state, stats, profile, mode, tokenDisplayMode, onTokenDisplayModeChange
                        )
                        AmbientElement.DeltaBadge -> Unit
                        AmbientElement.Sparkline -> V2TrendChart(
                            palette, stats.comparison, stats.trends,
                            Modifier.fillMaxWidth().height(54.dp), compact = true, normalizeRange = true
                        )
                        AmbientElement.RhythmChart -> V2AmbientRhythmChart(
                            palette,
                            rhythmSeries,
                            profile,
                            Modifier.fillMaxWidth().height(84.dp),
                            showPrevious = true,
                            fillArea = profile.fillPolicy != FillPolicy.Outline,
                            emptyMessage = trendAvailabilityMessage(
                                stats.comparison, stats.trends, ReportMetricMode.Tokens
                            )
                        )
                        AmbientElement.MetricTriple -> V2AmbientMetricTriple(
                            palette, stats, profile, Modifier.fillMaxWidth()
                        )
                        AmbientElement.ComparisonTable -> V2AmbientComparisonTable(
                            palette, stats, Modifier.fillMaxWidth()
                        )
                        AmbientElement.Heatmap -> V2HeatmapChart(
                            palette, stats.heatmap, Modifier.fillMaxWidth().height(76.dp), weeks = 12
                        )
                        AmbientElement.QuotaCapsules -> V2AmbientPreviewCapsules(palette, state)
                        AmbientElement.QuotaBoard -> V2AmbientQuotaBoard(
                            palette = palette,
                            state = state,
                            profile = profile,
                            limit = 3,
                            columns = 1,
                            modifier = Modifier.fillMaxWidth()
                        )
                        AmbientElement.QuotaGaugeGrid -> V2AmbientPreviewGaugeGrid(palette, state, profile)
                        AmbientElement.FreshnessFooter -> V2AmbientFreshnessFooter(
                            palette, state, profile, Modifier.fillMaxWidth()
                        )
                        AmbientElement.DailyQuote -> V2LandscapeDailyQuote(
                            palette, state.dailyQuote, Modifier.fillMaxWidth()
                        )
                    }
                } }
                Text(
                    if (previewAppearance == LedgerAppearance.EInk) {
                        "缩略预览 · 静态低频刷新"
                    } else {
                        "缩略预览 · 全屏会启用低频像素位移"
                    },
                    color = palette.faint,
                    fontSize = AmbientFont.micro
                )
            }
        }
    }
}

/** 预览介质：彩屏 / 墨水屏两段，只换预览画法，不改应用外观。 */
@Composable
internal fun V2EInkPreviewToggle(
    palette: MobileV2Palette,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier
) {
    V2SegmentedToggle(
        palette = palette,
        options = listOf(
            V2Segment(false, "彩屏", contentDescription = "彩屏预览"),
            V2Segment(true, "墨水屏", contentDescription = "墨水屏预览")
        ),
        selected = checked,
        onSelect = onChange,
        modifier = modifier,
        role = Role.RadioButton
    )
}

@Composable
internal fun V2AmbientPreviewMasthead(
    palette: MobileV2Palette,
    state: DashboardUiState,
    profile: AmbientRenderProfile
) {
    val today = state.dailyQuote?.date ?: LocalDate.now()
    val dateLabel = remember(today) {
        today.format(DateTimeFormatter.ofPattern("M 月 d 日 EEEE", Locale.SIMPLIFIED_CHINESE))
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "TOKENLEDGER 日报",
                color = palette.text,
                fontSize = AmbientFont.label,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.2.sp,
                modifier = Modifier.weight(1f)
            )
            V2JeidorfWordmark(palette, compact = true)
        }
        Text(
            "$dateLabel · ${state.query.range.label} · ${ambientCadenceLabel(profile)}",
            color = palette.muted,
            fontSize = AmbientFont.small,
            fontFamily = FontFamily.Monospace
        )
        V2LedgerRule(palette, thick = true)
    }
}

@Composable
internal fun V2AmbientPreviewHero(
    palette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    profile: AmbientRenderProfile,
    mode: AmbientMode,
    tokenDisplayMode: TokenDisplayMode,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit
) {
    val tokens = displayedTokenCount(
        tokenDisplayMode,
        stats.summary.effectiveTokens,
        stats.summary.cachedTokens
    )
    val heroSize = when (mode) {
        AmbientMode.Glance -> 52.sp
        AmbientMode.Ledger -> 36.sp
        else -> 34.sp
    }
    val mono = if (profile.useMonospaceNumerals) FontFamily.Monospace else FontFamily.Default
    Row(
        Modifier
            .fillMaxWidth()
            .tokenModeToggle(tokenDisplayMode, onTokenDisplayModeChange),
        verticalAlignment = Alignment.Bottom
    ) {
        Text(
            v2FormatTokens(tokens),
            color = palette.text,
            fontSize = heroSize,
            lineHeight = heroSize * 1.1f,
            fontWeight = FontWeight.Bold,
            fontFamily = mono,
            maxLines = 1,
            modifier = Modifier.weight(1f)
        )
        Column(horizontalAlignment = Alignment.End, modifier = Modifier.padding(bottom = 4.dp)) {
            Text(
                v2FormatPercent(stats.comparison?.delta?.tokens?.percent),
                color = palette.text,
                fontSize = AmbientFont.label,
                fontWeight = FontWeight.Bold,
                fontFamily = mono
            )
            Text(
                "${state.query.range.label} · ${tokenDisplayMode.label}",
                color = palette.faint,
                fontSize = AmbientFont.micro
            )
        }
    }
}

@Composable
internal fun V2AmbientPreviewCapsules(palette: MobileV2Palette, state: DashboardUiState) {
    val quota = state.quota as? QuotaUiState.Available
    val providers = quota?.snapshot?.providers.orEmpty()
    val all = quotaProgressWindowsForDisplay(providers, Int.MAX_VALUE)
    val shown = all.take(2)
    if (shown.isEmpty()) {
        Text("额度未同步 · 不代表 0%", color = palette.muted, fontSize = AmbientFont.body)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            shown.forEach { (provider, window) ->
                V2WidgetQuotaPill(
                    palette,
                    provider,
                    window,
                    forceStale = quota?.showingCachedData == true,
                    modifier = Modifier.weight(1f)
                )
            }
            if (shown.size == 1) Spacer(Modifier.weight(1f))
        }
        if (all.size > shown.size) {
            Text("另有 ${all.size - shown.size} 个订阅来源", color = palette.faint, fontSize = AmbientFont.small)
        }
    }
}

@Composable
internal fun V2AmbientPreviewGaugeGrid(
    palette: MobileV2Palette,
    state: DashboardUiState,
    profile: AmbientRenderProfile
) {
    val quota = state.quota as? QuotaUiState.Available
    val providers = quota?.snapshot?.providers.orEmpty()
    val all = quotaProgressWindowsForDisplay(providers, Int.MAX_VALUE)
    val shown = all.take(2)
    if (shown.isEmpty()) {
        Text("暂无可绘制的额度窗口 · 未同步不代表 0%", color = palette.muted, fontSize = AmbientFont.body)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            Modifier.fillMaxWidth().height(132.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            shown.forEach { (provider, window) ->
                V2AmbientQuotaRing(
                    palette = palette,
                    provider = provider,
                    window = window,
                    forceStale = quota?.showingCachedData == true,
                    profile = profile,
                    modifier = Modifier.fillMaxHeight().weight(1f),
                    emphasized = true
                )
            }
            if (shown.size == 1) Spacer(Modifier.weight(1f))
        }
        if (all.size > shown.size) {
            Text("全屏共 ${all.size} 个订阅来源 · 预览只放 2 格", color = palette.faint, fontSize = AmbientFont.small)
        }
    }
}

@Composable
internal fun V2WidgetPreview(
    outerPalette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    profile: AmbientRenderProfile,
    quotaWindowLimit: Int,
    tokenDisplayMode: TokenDisplayMode,
    onTokenDisplayModeChange: ((TokenDisplayMode) -> Unit)? = null,
    showWordmark: Boolean = true,
    showDailyQuote: Boolean = false
) {
    val palette = outerPalette
    val costMasked = LocalCostMaskEnabled.current
    val currency = LocalDashboardCurrency.current
    val newspaperRules = profile.fillPolicy == FillPolicy.Outline || palette.isEInk
    val border = if (palette.isEInk) BorderStroke(1.5.dp, palette.divider) else null
    val displayedTokens = displayedTokenCount(tokenDisplayMode, stats.summary.effectiveTokens, stats.summary.cachedTokens)
    Card(
        colors = CardDefaults.cardColors(containerColor = palette.surface),
        border = border,
        elevation = CardDefaults.cardElevation(defaultElevation = if (palette.isEInk) 0.dp else 1.5.dp),
        shape = RoundedCornerShape(if (palette.isEInk) 6.dp else 24.dp),
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (onTokenDisplayModeChange != null) {
                    Modifier.tokenModeToggle(tokenDisplayMode, onTokenDisplayModeChange)
                } else {
                    Modifier
                }
            )
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("TOKENLEDGER", color = palette.faint, fontSize = AmbientFont.micro, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp)
                    Text("${state.query.range.label}快照", color = palette.text, fontSize = AmbientFont.titleLarge, fontWeight = FontWeight.SemiBold)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        if (onTokenDisplayModeChange != null) "${tokenDisplayMode.label} Token · 点击切换" else "${tokenDisplayMode.label} Token",
                        color = palette.text,
                        fontSize = AmbientFont.small,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(ambientCadenceLabel(profile), color = palette.faint, fontSize = AmbientFont.micro)
                }
                if (showWordmark) {
                    Spacer(Modifier.width(8.dp))
                    V2JeidorfWordmark(palette, compact = true)
                }
            }
            if (newspaperRules) HorizontalDivider(color = palette.divider)
            Row(verticalAlignment = Alignment.Bottom) {
                Text(v2FormatTokens(displayedTokens), color = palette.text, fontSize = AmbientFont.display, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                Text(
                    if (tokenDisplayMode == TokenDisplayMode.All) "有效 ${v2FormatPercent(stats.comparison?.delta?.tokens?.percent)}" else v2FormatPercent(stats.comparison?.delta?.tokens?.percent),
                    color = palette.text,
                    fontSize = AmbientFont.bodyLarge,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(bottom = 6.dp)
                )
            }
            V2TrendChart(palette, stats.comparison, stats.trends, Modifier.fillMaxWidth().height(92.dp), compact = true)
            Row {
                V2MiniMetric("费用", v2FormatMoney(LocalContext.current, stats.summary.totalCost, costMasked, currency), palette, Modifier.weight(1f))
                V2MetricDivider(palette)
                V2MiniMetric("记录数", v2FormatNumber(stats.summary.totalRequests), palette, Modifier.weight(1f))
                V2MetricDivider(palette)
                V2MiniMetric("缓存复用率", v2CacheHit(stats.summary), palette, Modifier.weight(1f))
            }
            V2HeatmapChart(palette, stats.heatmap, Modifier.fillMaxWidth().height(90.dp), weeks = 12)
            if (showDailyQuote) {
                V2LandscapeDailyQuote(palette, state.dailyQuote, Modifier.fillMaxWidth())
            }
            val quota = state.quota as? QuotaUiState.Available
            val pillSlots = quotaWindowLimit.coerceIn(0, 2)
            val allWindows = quota?.snapshot?.providers?.rankedQuotaWindowsForDisplay().orEmpty()
            val windows = allWindows.take(pillSlots)
            val hiddenWindows = allWindows.size - windows.size
            if (windows.isNotEmpty()) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    windows.forEach { (provider, window) ->
                        V2WidgetQuotaPill(
                            palette,
                            provider,
                            window,
                            forceStale = quota?.showingCachedData == true,
                            modifier = Modifier.weight(1f)
                        )
                    }
                    if (windows.size == 1) Spacer(Modifier.weight(1f))
                }
                if (hiddenWindows > 0) {
                    Text("另有 $hiddenWindows 个额度窗口未显示", color = palette.faint, fontSize = AmbientFont.small)
                }
            } else {
                Text("额度未同步 · 不代表 0%", color = palette.muted, fontSize = AmbientFont.body)
            }
        }
    }
}

@Composable
internal fun V2WidgetQuotaPill(
    palette: MobileV2Palette,
    provider: QuotaProviderEnvelope,
    window: QuotaWindowSnapshot,
    forceStale: Boolean,
    modifier: Modifier = Modifier
) {
    val now = LocalLedgerNow.current()
    val status = provider.effectiveStatus(now, forceStale)
    val progress = window.displayValue()
        .takeIf {
            status == QuotaProviderStatus.Ok || status == QuotaProviderStatus.Stale
        } as? QuotaDisplayValue.Progress
    // 预览与真身同一把尺（A-Q2）：挂件的比例已量化到显示的整数（widgetProgressQuotaWindow），
    // 这里也用「100 − round(已用)」的整数折回比例，条长、档位与数字三者一致。此前截断取整，
    // 剩余 19.6% 写「19% 可用」，挂件本身却写「20%」。
    val availablePercent = progress?.let(::quotaAvailablePercent)
    val remainingFraction = availablePercent?.let { it / 100f }
    val providerName = provider.localizedDisplayName()
    val statusText = status.localizedLabel()
    val valueText = availablePercent?.let { "$it% 可用" } ?: statusText
    val severity = remainingFraction?.let {
        when (widgetAvailabilityBand(it)) {
            WidgetThresholdBand.Danger -> QuotaSeverity.Critical
            WidgetThresholdBand.Warn -> QuotaSeverity.Warning
            WidgetThresholdBand.Normal -> QuotaSeverity.Healthy
        }
    }
    val cellShape = RoundedCornerShape(if (palette.isEInk) 6.dp else 12.dp)
    Column(
        modifier
            .clip(cellShape)
            .background(if (palette.isEInk) Color.White else palette.surfaceContainer)
            .then(
                if (palette.isEInk) {
                    Modifier.border(1.dp, palette.divider, cellShape)
                } else {
                    Modifier
                }
            )
            .padding(8.dp)
            .semantics {
                contentDescription = quotaWindowAccessibilityDescription(
                    providerName = providerName,
                    windowLabel = window.localizedCompactWindowLabel(providerName),
                    statusLabel = statusText,
                    valueLabel = availablePercent?.let { "可用 $it%" }
                        ?.let { label -> severity?.let { "$label（${it.label}）" } ?: label },
                    resetLabel = v2ResetLabel(window.resetsAt),
                    observedLabel = v2ShortDateTime(window.observedAt)
                )
            },
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                providerName,
                color = palette.text,
                fontSize = AmbientFont.small,
                modifier = Modifier.weight(1f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                valueText,
                color = if (status == QuotaProviderStatus.Ok) palette.text else v2QuotaStatusColor(palette, status),
                fontSize = AmbientFont.label,
                fontWeight = FontWeight.Bold
            )
        }
        if (remainingFraction != null) {
            LinearProgressIndicator(
                progress = { remainingFraction },
                modifier = Modifier.fillMaxWidth().height(if (palette.isEInk) 4.dp else 5.dp).clip(RoundedCornerShape(999.dp)),
                color = if (status == QuotaProviderStatus.Ok) {
                    when (widgetAvailabilityBand(remainingFraction)) {
                        WidgetThresholdBand.Danger -> palette.danger
                        WidgetThresholdBand.Warn -> palette.amber
                        WidgetThresholdBand.Normal -> palette.blue
                    }
                } else {
                    palette.amber
                },
                trackColor = if (palette.isEInk) Color(0xFFE0E0E0) else palette.surface
            )
        }
    }
}
