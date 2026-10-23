package com.jeidorf.tokenledger.mobile

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.jeidorf.tokenledger.mobile.ui.LedgerDashboardV2Screen as ModularLedgerDashboardV2Screen
import com.jeidorf.tokenledger.mobile.ui.ambient.FullScreenWidgetV2 as ModularFullScreenWidgetV2
import com.jeidorf.tokenledger.mobile.ui.charts.ChartQuotaControlState as ModularChartQuotaControlState
import com.jeidorf.tokenledger.mobile.ui.charts.ChartQuotaPreviewSurface as ModularChartQuotaPreviewSurface
import com.jeidorf.tokenledger.mobile.ui.charts.HeatmapCellSelection as ModularHeatmapCellSelection
import com.jeidorf.tokenledger.mobile.ui.charts.V2ChartQuotaPreviewContent as ModularV2ChartQuotaPreviewContent
import com.jeidorf.tokenledger.mobile.ui.charts.V2DailyCostsPreviewContent as ModularV2DailyCostsPreviewContent
import com.jeidorf.tokenledger.mobile.ui.controls.V2CustomRangeDialogPreviewContent as ModularV2CustomRangeDialogPreviewContent
import com.jeidorf.tokenledger.mobile.ui.controls.V2FilterSheetPreviewContent as ModularV2FilterSheetPreviewContent
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette as ModularMobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.me.V2MePage
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane as ModularInsightPane
import com.jeidorf.tokenledger.mobile.ui.navigation.MobileDestination as ModularMobileDestination
import com.jeidorf.tokenledger.mobile.ui.navigation.TodayReviewAction as ModularTodayReviewAction
import com.jeidorf.tokenledger.mobile.ui.navigation.V2NavigationSelection as ModularV2NavigationSelection
import com.jeidorf.tokenledger.mobile.ui.navigation.dashboardSection as modularDashboardSection
import com.jeidorf.tokenledger.mobile.ui.quota.QuotaDisplayGroup as ModularQuotaDisplayGroup
import com.jeidorf.tokenledger.mobile.ui.quota.QuotaProviderGroups as ModularQuotaProviderGroups
import com.jeidorf.tokenledger.mobile.ui.sources.ModelMetricMode as ModularModelMetricMode
import com.jeidorf.tokenledger.mobile.ui.sources.V2ModelDistributionPreviewContent as ModularV2ModelDistributionPreviewContent
import com.jeidorf.tokenledger.mobile.ui.calendar.V2InsightCalendarPreviewContent as ModularV2InsightCalendarPreviewContent
import com.jeidorf.tokenledger.mobile.ui.trend.TrendDataBarFractions as ModularTrendDataBarFractions
import java.time.Instant

/**
 * 100% backward-compatible facade for LedgerDashboardV2Ui.
 * Implementation has been modularized into domain packages under `com.jeidorf.tokenledger.mobile.ui.*`.
 */

internal class V2RetainedDataHolder(var value: StatsData? = null)

internal typealias MobileV2Palette = ModularMobileV2Palette
internal typealias ChartQuotaPreviewSurface = ModularChartQuotaPreviewSurface
internal typealias ChartQuotaControlState = ModularChartQuotaControlState
internal typealias MobileDestination = ModularMobileDestination
internal typealias InsightPane = ModularInsightPane
internal typealias TodayReviewAction = ModularTodayReviewAction
internal typealias V2NavigationSelection = ModularV2NavigationSelection
internal typealias QuotaDisplayGroup = ModularQuotaDisplayGroup
internal typealias QuotaProviderGroups = ModularQuotaProviderGroups
internal typealias ModelMetricMode = ModularModelMetricMode
internal typealias HeatmapCellSelection = ModularHeatmapCellSelection
internal typealias TrendDataBarFractions = ModularTrendDataBarFractions
internal typealias V2FilterOptions = com.jeidorf.tokenledger.mobile.ui.controls.V2FilterOptions

internal const val TODAY_SOURCE_LIMIT = com.jeidorf.tokenledger.mobile.ui.quota.TODAY_SOURCE_LIMIT
internal const val TODAY_QUOTA_LIMIT = com.jeidorf.tokenledger.mobile.ui.quota.TODAY_QUOTA_LIMIT
internal const val QUOTA_HISTORY_DEFAULT_EXPANDED = com.jeidorf.tokenledger.mobile.ui.quota.QUOTA_HISTORY_DEFAULT_EXPANDED

internal fun v2Palette(appearance: LedgerAppearance): MobileV2Palette =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette(appearance)

internal fun v2FilterOptions(
    stats: StatsData?,
    query: DashboardQuery = DashboardQuery()
): V2FilterOptions =
    com.jeidorf.tokenledger.mobile.ui.controls.v2FilterOptions(stats, query)

internal fun groupQuotaProviders(
    providers: List<QuotaProviderEnvelope>,
    now: Instant,
    showingCachedData: Boolean = false
): QuotaProviderGroups =
    com.jeidorf.tokenledger.mobile.ui.quota.groupQuotaProviders(providers, now, showingCachedData)

internal fun quotaDisplayGroup(
    provider: QuotaProviderEnvelope,
    now: Instant,
    showingCachedData: Boolean = false
): QuotaDisplayGroup =
    com.jeidorf.tokenledger.mobile.ui.quota.quotaDisplayGroup(provider, now, showingCachedData)

internal fun latestQuotaObservedAt(providers: List<QuotaProviderEnvelope>): String? =
    com.jeidorf.tokenledger.mobile.ui.quota.latestQuotaObservedAt(providers)

internal fun v2QuotaRemainingFraction(progress: QuotaDisplayValue.Progress): Float =
    com.jeidorf.tokenledger.mobile.ui.quota.v2QuotaRemainingFraction(progress)

internal fun normalizedDataBarFraction(value: Long, sharedMaximum: Long): Float =
    com.jeidorf.tokenledger.mobile.ui.trend.normalizedDataBarFraction(value, sharedMaximum)

internal fun normalizedDataBarFraction(value: Double, sharedMaximum: Double): Float =
    com.jeidorf.tokenledger.mobile.ui.trend.normalizedDataBarFraction(value, sharedMaximum)

internal fun trendDataBarFractions(
    currentTokens: Long,
    previousTokens: Long,
    sharedMaximum: Long
): TrendDataBarFractions =
    com.jeidorf.tokenledger.mobile.ui.trend.trendDataBarFractions(currentTokens, previousTokens, sharedMaximum)

internal fun trendDataBarFractions(
    currentCost: Double,
    previousCost: Double,
    sharedMaximum: Double
): TrendDataBarFractions =
    com.jeidorf.tokenledger.mobile.ui.trend.trendDataBarFractions(currentCost, previousCost, sharedMaximum)

internal fun sharedTrendSlotCount(currentSize: Int, previousSize: Int): Int =
    com.jeidorf.tokenledger.mobile.ui.trend.sharedTrendSlotCount(currentSize, previousSize)

internal fun trendChartX(index: Int, slotCount: Int, left: Float, right: Float): Float =
    com.jeidorf.tokenledger.mobile.ui.trend.trendChartX(index, slotCount, left, right)

internal fun trendChartPoints(
    values: List<Float>,
    slotCount: Int,
    left: Float,
    right: Float,
    top: Float,
    bottom: Float,
    minimum: Float,
    maximum: Float
): List<SmoothCurvePoint> =
    com.jeidorf.tokenledger.mobile.ui.trend.trendChartPoints(
        values, slotCount, left, right, top, bottom, minimum, maximum
    )

internal fun displayedHistoryTokenCount(
    tokenDisplayMode: TokenDisplayMode,
    item: LogHistoryItem
): Long =
    com.jeidorf.tokenledger.mobile.ui.details.displayedHistoryTokenCount(tokenDisplayMode, item)

internal fun modelCostShareLabel(
    costMasked: Boolean,
    sharePercent: Double?
): String =
    com.jeidorf.tokenledger.mobile.ui.sources.modelCostShareLabel(costMasked, sharePercent)

internal fun dashboardDataForFrame(
    visibleData: StatsData?,
    retainedData: StatsData?,
    dashboardLoading: Boolean
): StatsData? =
    com.jeidorf.tokenledger.mobile.ui.foundation.dashboardDataForFrame(visibleData, retainedData, dashboardLoading)

internal fun v2DashboardTopStatusText(
    state: DashboardUiState,
    displayedStats: StatsData? = state.visibleData
): String? =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2DashboardTopStatusText(state, displayedStats)

internal fun v2FormatMoney(
    context: Context,
    amount: Double,
    costMasked: Boolean = PrivacyStore.isCostMaskEnabled(context),
    currency: CurrencyUnit = CurrencyUnit.CNY
): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney(context, amount, costMasked, currency)

internal fun v2FormatPercent(deltaPercent: Double?): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatPercent(deltaPercent)

internal fun v2Share(value: Long, total: Long): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2Share(value, total)

internal fun v2CacheHit(summary: Summary): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2CacheHit(summary)

internal fun v2SignedTokens(value: Double?): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2SignedTokens(value)

internal fun v2SignedNumber(value: Double?): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2SignedNumber(value)

internal fun v2SignedMoney(
    context: Context,
    value: Double?,
    costMasked: Boolean = PrivacyStore.isCostMaskEnabled(context),
    currency: CurrencyUnit = CurrencyUnit.CNY
): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2SignedMoney(context, value, costMasked, currency)

internal fun v2ModelEffectiveTokens(model: ModelStat): Long =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2ModelEffectiveTokens(model)

internal fun v2ModelTokens(model: ModelStat, tokenDisplayMode: TokenDisplayMode): Long =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2ModelTokens(model, tokenDisplayMode)

internal fun v2ComparisonLabel(comparison: UsageComparison?): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2ComparisonLabel(comparison)

internal fun v2ShortDateTime(iso: String?): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2ShortDateTime(iso)

internal fun v2ResetLabel(iso: String?): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2ResetLabel(iso)

internal fun v2Capability(capability: QuotaCapability): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2Capability(capability)

internal fun v2Scope(scope: QuotaScope): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2Scope(scope)

internal fun v2QuotaSource(source: QuotaProviderEnvelope): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2QuotaSource(source)

internal fun v2QuotaReason(reasonCode: String?, scope: QuotaScope? = null): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2QuotaReason(reasonCode, scope)

internal fun v2QuotaAbsolute(value: QuotaDisplayValue.Absolute): String =
    com.jeidorf.tokenledger.mobile.ui.foundation.v2QuotaAbsolute(value)

internal fun v2SeverityColor(palette: MobileV2Palette, severity: QuotaSeverity): Color =
    com.jeidorf.tokenledger.mobile.ui.quota.v2SeverityColor(palette, severity)

internal fun v2QuotaStatusColor(palette: MobileV2Palette, status: QuotaProviderStatus): Color =
    com.jeidorf.tokenledger.mobile.ui.quota.v2QuotaStatusColor(palette, status)

internal fun MobileDestination.dashboardSection(insightPane: InsightPane): DashboardSection? =
    this.modularDashboardSection(insightPane)

internal fun InsightPane.dashboardSection(): DashboardSection =
    this.modularDashboardSection()

@Composable
internal fun V2ModelDistributionPreviewContent(
    appearance: LedgerAppearance,
    stats: StatsData,
    showCost: Boolean,
    currency: CurrencyUnit = CurrencyUnit.CNY,
    costMasked: Boolean = false
) {
    ModularV2ModelDistributionPreviewContent(appearance, stats, showCost, currency, costMasked)
}

@Composable
internal fun V2InsightCalendarPreviewContent(
    appearance: LedgerAppearance,
    stats: StatsData,
    initialSelectedDate: String
) {
    ModularV2InsightCalendarPreviewContent(appearance, stats, initialSelectedDate)
}

@Composable
internal fun V2CustomRangeDialogPreviewContent(appearance: LedgerAppearance) {
    ModularV2CustomRangeDialogPreviewContent(appearance)
}

@Composable
internal fun V2ChartQuotaPreviewContent(
    surface: ChartQuotaPreviewSurface,
    stats: StatsData,
    appearance: LedgerAppearance = LedgerAppearance.Light,
    metric: ReportMetricMode = ReportMetricMode.Tokens,
    currency: CurrencyUnit = CurrencyUnit.USD,
    quota: QuotaUiState.Available? = null,
    details: Boolean = false,
    masked: Boolean = false,
    controlState: ChartQuotaControlState = ChartQuotaControlState.Unselected,
    onControlBounds: ((String, List<Int>) -> Unit)? = null,
    onOpenTrendBucket: ((String, InsightPane) -> Unit)? = null
) {
    ModularV2ChartQuotaPreviewContent(
        surface = surface,
        stats = stats,
        appearance = appearance,
        metric = metric,
        currency = currency,
        quota = quota,
        details = details,
        masked = masked,
        controlState = controlState,
        onControlBounds = onControlBounds,
        onOpenTrendBucket = onOpenTrendBucket
    )
}

@Composable
internal fun V2DailyCostsPreviewContent(
    appearance: LedgerAppearance,
    stats: StatsData,
    query: DashboardQuery,
    masked: Boolean = false
) {
    ModularV2DailyCostsPreviewContent(
        appearance = appearance,
        stats = stats,
        query = query,
        masked = masked
    )
}

@Composable
internal fun V2FilterSheetPreviewContent(
    appearance: LedgerAppearance,
    state: DashboardUiState,
    displayedStats: StatsData? = state.visibleData
) {
    ModularV2FilterSheetPreviewContent(appearance, state, displayedStats)
}

@Composable
internal fun LedgerDashboardV2Screen(
    state: DashboardUiState,
    appearance: LedgerAppearance,
    forceLandscape: Boolean,
    tokenDisplayMode: TokenDisplayMode,
    ambientMode: AmbientMode,
    onForceLandscapeChange: (Boolean) -> Unit,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit,
    onAmbientModeChange: (AmbientMode) -> Unit,
    onRangeChange: (RangeKey) -> Unit,
    onMachineChange: (String) -> Unit,
    onToolChange: (String?) -> Unit,
    onModelChange: (String?) -> Unit,
    onSearchChange: (String?) -> Unit = {},
    onClearFilters: () -> Unit,
    onSectionChange: (DashboardSection) -> Unit,
    onContributionModeChange: (ContributionMode) -> Unit,
    onOpenTool: (String) -> Unit,
    onOpenModel: (String) -> Unit,
    onBack: () -> Unit,
    onLoadMore: () -> Unit,
    onAppearanceChange: (LedgerAppearance) -> Unit,
    onOpenLowPowerDisplay: () -> Unit,
    onRefresh: () -> Unit,
    onSignOut: () -> Unit,
    onCustomRangeChange: (String, String) -> Unit = { _, _ -> },
    onOpenDay: (String) -> Boolean = { false },
    onOpenTrendBucket: (String, DashboardSection) -> Boolean = { _, _ -> false },
    onReturnFromDay: () -> Unit = {},
    initialDestination: MobileDestination = MobileDestination.Usage,
    initialInsightPane: InsightPane = InsightPane.Overview,
    initialSettingsVisible: Boolean = false,
    initialMePage: V2MePage = V2MePage.Root
) {
    ModularLedgerDashboardV2Screen(
        state = state,
        appearance = appearance,
        forceLandscape = forceLandscape,
        tokenDisplayMode = tokenDisplayMode,
        ambientMode = ambientMode,
        onForceLandscapeChange = onForceLandscapeChange,
        onTokenDisplayModeChange = onTokenDisplayModeChange,
        onAmbientModeChange = onAmbientModeChange,
        onRangeChange = onRangeChange,
        onMachineChange = onMachineChange,
        onToolChange = onToolChange,
        onModelChange = onModelChange,
        onSearchChange = onSearchChange,
        onClearFilters = onClearFilters,
        onSectionChange = onSectionChange,
        onContributionModeChange = onContributionModeChange,
        onOpenTool = onOpenTool,
        onOpenModel = onOpenModel,
        onBack = onBack,
        onLoadMore = onLoadMore,
        onAppearanceChange = onAppearanceChange,
        onOpenLowPowerDisplay = onOpenLowPowerDisplay,
        onRefresh = onRefresh,
        onSignOut = onSignOut,
        onCustomRangeChange = onCustomRangeChange,
        onOpenDay = onOpenDay,
        onOpenTrendBucket = onOpenTrendBucket,
        onReturnFromDay = onReturnFromDay,
        initialDestination = initialDestination,
        initialInsightPane = initialInsightPane,
        initialSettingsVisible = initialSettingsVisible,
        initialMePage = initialMePage
    )
}

@Composable
internal fun FullScreenWidgetV2(
    state: DashboardUiState,
    appearance: LedgerAppearance,
    tokenDisplayMode: TokenDisplayMode,
    mode: AmbientMode,
    policy: LowPowerPolicy,
    onTokenDisplayModeChange: ((TokenDisplayMode) -> Unit)? = null
) {
    ModularFullScreenWidgetV2(
        state = state,
        appearance = appearance,
        tokenDisplayMode = tokenDisplayMode,
        mode = mode,
        policy = policy,
        onTokenDisplayModeChange = onTokenDisplayModeChange
    )
}
