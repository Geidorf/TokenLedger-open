package com.jeidorf.tokenledger.mobile.ui.sources

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jeidorf.tokenledger.mobile.CompositionEntry
import com.jeidorf.tokenledger.mobile.DashboardEntity
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.EntityDashboard
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.LocalToggleCostMask
import com.jeidorf.tokenledger.mobile.LogHistoryItem
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.buildInsightCalendarAxis
import com.jeidorf.tokenledger.mobile.costMaskAccessibilityDescription
import com.jeidorf.tokenledger.mobile.costMaskActionLabel
import com.jeidorf.tokenledger.mobile.costMaskStateDescription
import com.jeidorf.tokenledger.mobile.detailGranularityLabel
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.entityKindLabel
import com.jeidorf.tokenledger.mobile.formatInteger
import com.jeidorf.tokenledger.mobile.formatSharePercent
import com.jeidorf.tokenledger.mobile.isLandscapeOrCompactHeight
import com.jeidorf.tokenledger.mobile.ui.adaptive.V2AdaptivePanes
import com.jeidorf.tokenledger.mobile.ui.adaptive.V2PaneArrangement
import com.jeidorf.tokenledger.mobile.ui.calendar.V2HeatmapCard
import com.jeidorf.tokenledger.mobile.ui.charts.V2LineLegend
import com.jeidorf.tokenledger.mobile.ui.charts.V2TrendChart
import com.jeidorf.tokenledger.mobile.ui.controls.V2TokenModeToggle
import com.jeidorf.tokenledger.mobile.ui.details.V2DetailRow
import com.jeidorf.tokenledger.mobile.ui.details.displayedHistoryTokenCount
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2FullState
import com.jeidorf.tokenledger.mobile.ui.foundation.V2LoadingState
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_TEXT
import com.jeidorf.tokenledger.mobile.ui.foundation.v2ComparisonLabel
import com.jeidorf.tokenledger.mobile.ui.foundation.v2DataBarBackground
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney
import com.jeidorf.tokenledger.mobile.ui.foundation.v2ShortDateTime
import com.jeidorf.tokenledger.mobile.ui.hero.V2KpiGrid
import com.jeidorf.tokenledger.mobile.ui.hero.V2MetricDivider
import com.jeidorf.tokenledger.mobile.ui.hero.V2MiniMetric
import com.jeidorf.tokenledger.mobile.ui.navigation.v2ScrolledUnder
import com.jeidorf.tokenledger.mobile.ui.quota.V2QuotaStateCard
import com.jeidorf.tokenledger.mobile.ui.trend.normalizedDataBarFraction
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens

/** 费用占比与其余占比同一写法（[formatSharePercent]，四舍五入到整数）。 */
internal fun modelCostShareLabel(costMasked: Boolean, sharePercent: Double?): String = when {
    costMasked -> "占比已隐藏"
    sharePercent != null && sharePercent.isFinite() -> formatSharePercent(sharePercent)
    else -> "占比不可得"
}

@Composable
internal fun V2EntityContent(
    palette: MobileV2Palette,
    state: DashboardUiState,
    displayedStats: StatsData?,
    arrangement: V2PaneArrangement,
    tokenDisplayMode: TokenDisplayMode,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit,
    onFilter: () -> Unit,
    onOpenModel: (String) -> Unit,
    onLoadMore: () -> Unit,
    onRefresh: () -> Unit,
    onSearchChange: ((String?) -> Unit)? = null,
    onScrolledUnderChange: (Boolean) -> Unit = {}
) {
    val stats = displayedStats
    val entity = stats?.entityDashboard
    val split = arrangement == V2PaneArrangement.Split
    // 两个列表的状态放在布局分支外：切到单栏再切回双栏时，主栏仍从原位置继续。
    val primaryListState = rememberLazyListState()
    val secondaryListState = rememberLazyListState()
    val reportScrolledUnder by rememberUpdatedState(onScrolledUnderChange)
    LaunchedEffect(primaryListState, stats, entity) {
        if (stats == null || entity == null || !stats.capabilities.entityDashboard) {
            reportScrolledUnder(false)
            return@LaunchedEffect
        }
        // 顶栏只跟随主栏；副栏滚动不参与同一状态，避免两列表累计成一次位移。
        snapshotFlow { primaryListState.v2ScrolledUnder() }.collect { reportScrolledUnder(it) }
    }
    when {
        stats == null && state.dashboardLoading -> V2LoadingState(
            palette = palette,
            showingCachedData = state.showingCachedData
        )
        stats == null -> V2FullState(
            palette = palette,
            title = "无法读取来源看板",
            body = state.userVisibleError ?: "当前来源暂时没有可用数据。",
            action = "重试",
            onAction = onRefresh
        )
        !stats.capabilities.entityDashboard || entity == null -> V2FullState(
            palette = palette,
            title = "来源下钻暂不可用",
            body = "当前云端尚未返回 V2 来源看板能力，概览统计不会受影响。",
            action = "重试",
            onAction = onRefresh
        )
        else -> {
            fun LazyListScope.primaryItems() {
                item(key = "entity-hero", contentType = "hero") {
                    V2EntityHeroCard(
                        palette = palette,
                        entity = entity,
                        stats = stats,
                        tokenDisplayMode = tokenDisplayMode,
                        onTokenDisplayModeChange = onTokenDisplayModeChange
                    )
                }
                item(key = "entity-kpis", contentType = "metrics") {
                    // KPI 看左栏实际可用宽度，不拿整窗宽度强行排成四列。
                    BoxWithConstraints(Modifier.fillMaxWidth()) {
                        V2KpiGrid(palette, stats, tokenDisplayMode, wide = maxWidth >= 560.dp)
                    }
                }
                item(key = "entity-context", contentType = "context") {
                    V2EntityContextCard(palette, entity, tokenDisplayMode)
                }
                if (entity.entity.kind == DashboardEntity.TOOL && entity.composition.models.isNotEmpty()) {
                    item(key = "entity-models-heading", contentType = "heading") {
                        V2PlainSectionHeader(palette, "模型组成", "点击模型继续下钻")
                    }
                    item(key = "entity-models", contentType = "sources") {
                        V2EntityModelsCard(palette, entity, tokenDisplayMode, onOpenModel)
                    }
                }
            }

            fun LazyListScope.secondaryItems() {
                item(key = "entity-calendar-heading", contentType = "heading") {
                    V2PlainSectionHeader(palette, "活跃日历", "近12周历史参照 · 保留来源筛选")
                }
                item(key = "entity-calendar", contentType = "chart") {
                    V2HeatmapCard(palette, buildInsightCalendarAxis(stats.copy(heatmap = entity.heatmap), state.query), compact = true, onClick = null)
                }
                item(key = "entity-details-heading", contentType = "heading") {
                    V2PlainSectionHeader(
                        palette,
                        "最近明细",
                        "${detailGranularityLabel(entity.historyPage.granularity, entity.historyPage.items)} · 显示实际桶时间"
                    )
                }
                items(
                    items = entity.historyPage.items,
                    key = { "entity-detail-${it.timestamp}|${it.id}" },
                    contentType = { "detail" }
                ) { detail ->
                    V2DetailRow(
                        palette,
                        detail,
                        tokenDisplayMode,
                        granularity = entity.historyPage.granularity,
                        onFilterSession = onSearchChange?.let { fn -> { fn(it) } }
                    )
                }
                when {
                    state.showingCachedData && entity.historyPage.hasMore -> item(
                        key = "entity-pagination-offline",
                        contentType = "status"
                    ) {
                        V2QuotaStateCard(palette, "离线快照", "恢复联网并刷新后可继续加载来源明细。")
                    }
                    entity.historyPage.hasMore && state.paginationError == null -> item(key = "entity-pagination", contentType = "action") {
                        OutlinedButton(
                            onClick = onLoadMore,
                            enabled = !state.loadingMore && !state.dashboardLoading,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                            border = BorderStroke(1.dp, palette.divider)
                        ) {
                            Text(if (state.loadingMore) "载入中…" else "加载更多", color = palette.text)
                        }
                    }
                }
                state.paginationError?.let { error ->
                    item(key = "entity-pagination-error", contentType = "status") {
                        V2PaginationErrorCard(
                            palette = palette,
                            error = error,
                            loading = state.loadingMore,
                            onRetry = onLoadMore
                        )
                    }
                }
            }

            V2AdaptivePanes(
                arrangement = arrangement,
                primary = { paneModifier ->
                    LazyColumn(
                        modifier = if (split) paneModifier.testTag("wide-entity-primary") else paneModifier,
                        state = primaryListState,
                        contentPadding = PaddingValues(start = 14.dp, end = 14.dp, bottom = 24.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        primaryItems()
                        // 单栏保持原有纵向顺序；双栏时日历和明细归右栏。
                        if (!split) secondaryItems()
                    }
                },
                secondary = if (split) {
                    @Composable { paneModifier: Modifier ->
                        LazyColumn(
                            modifier = paneModifier.testTag("wide-entity-secondary"),
                            state = secondaryListState,
                            contentPadding = PaddingValues(start = 14.dp, end = 14.dp, bottom = 24.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp)
                        ) {
                            secondaryItems()
                        }
                    }
                } else {
                    null
                }
            )
        }
    }
}

@Composable
internal fun V2PaginationErrorCard(
    palette: MobileV2Palette,
    error: String,
    loading: Boolean,
    onRetry: () -> Unit
) {
    V2Card(palette) {
        Text(
            "加载更多失败",
            color = palette.text,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.semantics { heading() }
        )
        Text(
            error,
            color = palette.danger,
            fontSize = LedgerFont.label,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive }
        )
        OutlinedButton(
            onClick = onRetry,
            enabled = !loading,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            border = BorderStroke(1.dp, palette.divider)
        ) {
            Text(if (loading) "载入中…" else "重试加载更多", color = palette.text)
        }
    }
}

@Composable
internal fun V2EntityHeroCard(
    palette: MobileV2Palette,
    entity: EntityDashboard,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit
) {
    val summary = entity.summary
    val displayedTokens = displayedTokenCount(tokenDisplayMode, summary.effectiveTokens, summary.cachedTokens)
    V2Card(
        palette = palette,
        contentPadding = PaddingValues(16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(entityKindLabel(entity.entity.kind), color = palette.blue, fontSize = LedgerFont.caption, fontWeight = FontWeight.Bold)
                Text("${tokenDisplayMode.label} Token", color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold)
            }
            V2TokenModeToggle(palette, tokenDisplayMode, onTokenDisplayModeChange)
        }
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                v2FormatTokens(displayedTokens),
                color = palette.text,
                fontSize = LedgerFont.display,
                lineHeight = 40.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = (-1.1).sp
            )
            Spacer(Modifier.weight(1f))
            val context = LocalContext.current
            val isCostMasked = LocalCostMaskEnabled.current
            val onToggleCostMask = LocalToggleCostMask.current
            val currency = LocalDashboardCurrency.current
            Column(
                horizontalAlignment = Alignment.End,
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .widthIn(min = 48.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .toggleable(
                        value = isCostMasked,
                        role = Role.Switch,
                        onValueChange = { onToggleCostMask() }
                    )
                    .semantics {
                        contentDescription = costMaskAccessibilityDescription(isCostMasked)
                        stateDescription = costMaskStateDescription(isCostMasked)
                        onClick(costMaskActionLabel(isCostMasked), null)
                    }
                    .padding(horizontal = 4.dp, vertical = 2.dp)
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("预估费用", color = palette.faint, fontSize = LedgerFont.caption)
                    Spacer(Modifier.width(4.dp))
                    Icon(
                        if (isCostMasked) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                        contentDescription = null,
                        tint = palette.faint,
                        modifier = Modifier.size(V2_ICON_TEXT)
                    )
                }
                Text(v2FormatMoney(context, summary.totalCost, isCostMasked, currency), color = palette.text, fontSize = LedgerFont.subtitle, fontWeight = FontWeight.SemiBold)
            }
        }
        Text(v2ComparisonLabel(entity.comparison), color = palette.faint, fontSize = LedgerFont.caption)
        Spacer(Modifier.height(6.dp))
        val isCompactHeight = isLandscapeOrCompactHeight(LocalConfiguration.current.screenHeightDp)
        V2TrendChart(
            palette = palette,
            comparison = entity.comparison,
            fallback = stats.trends,
            modifier = Modifier.fillMaxWidth().height(if (isCompactHeight) 100.dp else 142.dp),
            compact = false
        )
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            V2LineLegend(palette.blue, false, "当前周期 · 有效", palette)
            if (entity.comparison != null) V2LineLegend(palette.muted, true, "上一周期 · 有效", palette)
        }
    }
}

@Composable
internal fun V2EntityContextCard(
    palette: MobileV2Palette,
    entity: EntityDashboard,
    tokenDisplayMode: TokenDisplayMode
) {
    val visibleMachines = entity.composition.machines.take(4)
    val machineMaximum = visibleMachines.mapNotNull { v2CompositionTokens(it, tokenDisplayMode) }.maxOrNull() ?: 0L
    V2Card(palette) {
        Text("关键上下文", color = palette.text, fontWeight = FontWeight.SemiBold, fontSize = LedgerFont.body)
        Spacer(Modifier.height(8.dp))
        Row {
            V2MiniMetric("活跃日", "${entity.activity.activeDays} 天", palette, Modifier.weight(1f))
            V2MetricDivider(palette)
            V2MiniMetric("峰值", v2FormatTokens(entity.peak.tokens), palette, Modifier.weight(1f))
            V2MetricDivider(palette)
            V2MiniMetric("设备", v2FormatNumber(entity.composition.machines.size.toLong()), palette, Modifier.weight(1f))
        }
        V2EntityContextRow(palette, "峰值时间", entity.peak.bucket?.let(::v2ShortDateTime) ?: "—")
        V2EntityContextRow(palette, "首次记录", v2ShortDateTime(entity.activity.firstSeenAt))
        V2EntityContextRow(palette, "最近记录", v2ShortDateTime(entity.activity.lastSeenAt))
        visibleMachines.forEach { machine ->
            val machineTokens = v2CompositionTokens(machine, tokenDisplayMode)
            V2EntityMachineRow(
                palette = palette,
                label = "设备 · ${machine.value}",
                value = machineTokens?.let(::v2FormatTokens) ?: "不可得",
                fraction = machineTokens?.let { normalizedDataBarFraction(it, machineMaximum) } ?: 0f
            )
        }
    }
}

@Composable
internal fun V2EntityContextRow(palette: MobileV2Palette, label: String, value: String) {
    HorizontalDivider(color = palette.divider)
    Row(Modifier.fillMaxWidth().heightIn(min = 42.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = palette.muted, fontSize = LedgerFont.caption, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(value, color = palette.text, fontSize = LedgerFont.caption, fontWeight = FontWeight.Medium)
    }
}

@Composable
internal fun V2EntityMachineRow(
    palette: MobileV2Palette,
    label: String,
    value: String,
    fraction: Float
) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 42.dp)
            .v2DataBarBackground(palette, palette.green, fraction)
            .semantics(mergeDescendants = true) {
                contentDescription = "$label，$value"
            }
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            label,
            color = palette.muted,
            fontSize = LedgerFont.caption,
            modifier = Modifier.weight(1f),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
        Text(value, color = palette.text, fontSize = LedgerFont.caption, fontWeight = FontWeight.Medium)
    }
}

@Composable
internal fun V2EntityModelsCard(
    palette: MobileV2Palette,
    entity: EntityDashboard,
    tokenDisplayMode: TokenDisplayMode,
    onOpenModel: (String) -> Unit
) {
    val visibleModels = entity.composition.models.take(8)
    val modelMaximum = visibleModels.mapNotNull { v2CompositionTokens(it, tokenDisplayMode) }.maxOrNull() ?: 0L
    V2Card(palette) {
        Spacer(Modifier.height(6.dp))
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            visibleModels.forEach { model ->
                val modelTokens = v2CompositionTokens(model, tokenDisplayMode)
                V2SourceRow(
                    palette = palette,
                    color = palette.violet,
                    label = model.value,
                    value = modelTokens?.let(::v2FormatTokens) ?: "不可得",
                    note = "${v2FormatNumber(model.requests)} 条记录",
                    barFraction = modelTokens?.let { normalizedDataBarFraction(it, modelMaximum) } ?: 0f,
                    onClick = { onOpenModel(model.value) },
                    accessibilityValue = modelTokens?.let { "${formatInteger(it)} ${tokenDisplayMode.label} Token" } ?: "Token 不可得",
                    accessibilityNote = "${formatInteger(model.requests)} 条记录"
                )
            }
        }
    }
}

@Composable
internal fun V2PlainSectionHeader(palette: MobileV2Palette, title: String, subtitle: String) {
    Column(Modifier.fillMaxWidth().padding(top = 4.dp)) {
        Text(title, color = palette.text, fontSize = LedgerFont.subtitle, fontWeight = FontWeight.Medium, modifier = Modifier.semantics { heading() })
        Text(subtitle, color = palette.faint, fontSize = LedgerFont.caption)
    }
}

internal fun v2CompositionTokens(entry: CompositionEntry, mode: TokenDisplayMode): Long? {
    // 有效 Token 恒等于 输入+输出，不回退到 entry.tokens（与桌面/Rust/Supabase 口径一致）。
    return entry.effectiveTokens?.let { displayedTokenCount(mode, it, entry.cachedTokens) }
}
