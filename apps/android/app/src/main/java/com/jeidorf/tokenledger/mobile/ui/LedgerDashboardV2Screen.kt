package com.jeidorf.tokenledger.mobile.ui

import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudSync
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.updateAll
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.jeidorf.tokenledger.mobile.AmbientMode
import com.jeidorf.tokenledger.mobile.CalendarHeatmapUiState
import com.jeidorf.tokenledger.mobile.ContributionMode
import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.DashboardLayoutMode
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.DashboardSection
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.InsightCalendarAxis
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerEasing
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerMotion
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.LocalSetDashboardCurrency
import com.jeidorf.tokenledger.mobile.LocalToggleCostMask
import com.jeidorf.tokenledger.mobile.PrivacyStore
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.ReportMetricMode
import com.jeidorf.tokenledger.mobile.SharePosterSheet
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.buildInsightCalendarAxis
import com.jeidorf.tokenledger.mobile.dashboardContentBottomPaddingDp
import com.jeidorf.tokenledger.mobile.dashboardLayoutMode
import com.jeidorf.tokenledger.mobile.dashboardQuerySummary
import com.jeidorf.tokenledger.mobile.entityKindLabel
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ledgerTween
import com.jeidorf.tokenledger.mobile.ui.routing.rememberRoutingFeed
import com.jeidorf.tokenledger.mobile.ui.routing.v2RoutingItems
import com.jeidorf.tokenledger.mobile.ui.calendar.V2DayReviewSummary
import com.jeidorf.tokenledger.mobile.ui.calendar.V2InsightCalendarCard
import com.jeidorf.tokenledger.mobile.ui.controls.V2CustomRangeDialog
import com.jeidorf.tokenledger.mobile.ui.controls.V2FilterSheet
import com.jeidorf.tokenledger.mobile.ui.controls.V2FilterSheetContent
import com.jeidorf.tokenledger.mobile.ui.controls.V2GlobalRangeControl
import com.jeidorf.tokenledger.mobile.ui.controls.V2InsightStrip
import com.jeidorf.tokenledger.mobile.ui.details.V2DetailListHeader
import com.jeidorf.tokenledger.mobile.ui.details.V2DetailRow
import com.jeidorf.tokenledger.mobile.ui.details.V2DetailSearch
import com.jeidorf.tokenledger.mobile.ui.details.detailListSummary
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2FullState
import com.jeidorf.tokenledger.mobile.ui.foundation.V2LoadingState
import com.jeidorf.tokenledger.mobile.ui.foundation.V2RetainedDataHolder
import com.jeidorf.tokenledger.mobile.ui.foundation.dashboardDataForFrame
import com.jeidorf.tokenledger.mobile.ui.foundation.v2DashboardTopStatusText
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import com.jeidorf.tokenledger.mobile.ui.hero.V2HeroCard
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane
import com.jeidorf.tokenledger.mobile.ui.navigation.MobileDestination
import com.jeidorf.tokenledger.mobile.ui.navigation.V2NavigationBar
import com.jeidorf.tokenledger.mobile.ui.navigation.V2NavigationRail
import com.jeidorf.tokenledger.mobile.ui.navigation.V2NavigationSelection
import com.jeidorf.tokenledger.mobile.ui.navigation.V2ScrollUnderConnection
import com.jeidorf.tokenledger.mobile.ui.navigation.V2TopBar
import com.jeidorf.tokenledger.mobile.ui.navigation.v2EntityIdentitySlot
import com.jeidorf.tokenledger.mobile.ui.navigation.v2ScrolledUnder
import com.jeidorf.tokenledger.mobile.ui.navigation.v2TopBarSubtitle
import com.jeidorf.tokenledger.mobile.ui.navigation.v2TopBarTitle
import com.jeidorf.tokenledger.mobile.ui.navigation.dashboardSection
import com.jeidorf.tokenledger.mobile.ui.quota.TODAY_QUOTA_LIMIT
import com.jeidorf.tokenledger.mobile.ui.quota.TODAY_SOURCE_LIMIT
import com.jeidorf.tokenledger.mobile.ui.quota.V2QuotaSummaryCard
import com.jeidorf.tokenledger.mobile.ui.quota.v2QuotaItems
import com.jeidorf.tokenledger.mobile.ui.settings.V2SettingsPage
import com.jeidorf.tokenledger.mobile.ui.me.V2MeActions
import com.jeidorf.tokenledger.mobile.ui.me.V2MePage
import com.jeidorf.tokenledger.mobile.ui.me.v2MeItems
import com.jeidorf.tokenledger.mobile.ui.onboarding.LocalOpenFirstRunGuide
import com.jeidorf.tokenledger.mobile.ui.onboarding.V2EmptyAction
import com.jeidorf.tokenledger.mobile.ui.onboarding.V2EmptyState
import com.jeidorf.tokenledger.mobile.ui.onboarding.V2FirstRunGuide
import com.jeidorf.tokenledger.mobile.ui.onboarding.V2OnboardingStore
import com.jeidorf.tokenledger.mobile.ui.onboarding.V2OnboardingVisibility
import com.jeidorf.tokenledger.mobile.ui.onboarding.v2DesktopData
import com.jeidorf.tokenledger.mobile.ui.onboarding.v2HasDesktopData
import com.jeidorf.tokenledger.mobile.ui.onboarding.v2ShouldAutoOpenGuide
import com.jeidorf.tokenledger.mobile.ui.sources.V2EntityContent
import com.jeidorf.tokenledger.mobile.ui.sources.V2PaginationErrorCard
import com.jeidorf.tokenledger.mobile.ui.split.V2UsageSplitCard
import com.jeidorf.tokenledger.mobile.ui.sources.V2ToolDistributionCard
import com.jeidorf.tokenledger.mobile.ui.trend.V2TrendInsightCard
import com.jeidorf.tokenledger.mobile.widget.TokenLedgerWidget
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
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
    initialMePage: V2MePage = V2MePage.Root,
    initialGuideVisible: Boolean = false
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val palette = remember(appearance) { v2Palette(appearance) }
    var costMasked by remember { mutableStateOf(PrivacyStore.isCostMaskEnabled(context)) }
    DisposableEffect(context) {
        val dispose = PrivacyStore.observeCostMask(context) { costMasked = it }
        onDispose(dispose)
    }
    val entityMode = state.section == DashboardSection.Entity
    var destination by rememberSaveable { mutableStateOf(initialDestination) }
    var insightPane by rememberSaveable { mutableStateOf(initialInsightPane) }
    var showSettings by rememberSaveable { mutableStateOf(initialSettingsVisible) }
    var showSharePoster by rememberSaveable { mutableStateOf(false) }
    var filterSheet by remember { mutableStateOf<V2FilterSheet?>(null) }
    var showCustomRangeDialog by rememberSaveable { mutableStateOf(false) }
    var destinationScrolledUnder by remember { mutableStateOf(false) }
    val dataRetentionKey = (state.entity?.let { "${it.kind}:${it.id}" } ?: "dashboard-root") +
        if (state.dayReviewReturn != null) ":day:${state.query.start}" else ":global"
    val retainedHolder = remember(dataRetentionKey) { V2RetainedDataHolder() }
    if (state.visibleData != null) {
        retainedHolder.value = state.visibleData
    } else if (!state.dashboardLoading) {
        retainedHolder.value = null
    }
    val displayedData = dashboardDataForFrame(
        visibleData = state.visibleData,
        retainedData = retainedHolder.value,
        dashboardLoading = state.dashboardLoading
    )
    var dayReviewOriginPane by rememberSaveable { mutableStateOf(InsightPane.Calendar) }
    var dayReviewOpen by rememberSaveable { mutableStateOf(state.dayReviewReturn != null) }
    val returnFromDayReview = {
        dayReviewOpen = false
        onReturnFromDay()
        val selection = V2NavigationSelection(destination, insightPane).openInsight(dayReviewOriginPane)
        destination = selection.destination
        insightPane = selection.insightPane
    }
    val currentDayReturn by rememberUpdatedState(returnFromDayReview)
    val dayBackCallback = remember {
        object : OnBackPressedCallback(false) {
            override fun handleOnBackPressed() {
                isEnabled = false
                currentDayReturn()
            }
        }
    }
    val backDispatcher = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(backDispatcher, lifecycleOwner) {
        backDispatcher?.addCallback(lifecycleOwner, dayBackCallback)
        onDispose { dayBackCallback.remove() }
    }
    SideEffect {
        dayBackCallback.isEnabled = !showSettings && (dayReviewOpen || state.dayReviewReturn != null)
    }
    val openDayReview: (String) -> Unit = { date ->
        val origin = insightPane
        if (onOpenDay(date)) {
            if (!dayReviewOpen) dayReviewOriginPane = origin
            dayReviewOpen = true
            dayBackCallback.isEnabled = true
            val selection = V2NavigationSelection(destination, insightPane).openInsight(InsightPane.Details)
            destination = selection.destination
            insightPane = selection.insightPane
        }
    }

    val openTrendDay: (String, InsightPane) -> Unit = { bucket, target ->
        if (onOpenTrendBucket(bucket, target.dashboardSection())) {
            if (!dayReviewOpen) dayReviewOriginPane = InsightPane.Trend
            dayReviewOpen = true
            dayBackCallback.isEnabled = true
            destination = MobileDestination.Usage
            insightPane = target
        }
    }

    BackHandler(enabled = showSettings || entityMode) {
        when {
            showSettings -> showSettings = false
            else -> onBack()
        }
    }

    fun selectDestination(next: MobileDestination) {
        if (dayReviewOpen || state.dayReviewReturn != null) {
            dayReviewOpen = false
            onReturnFromDay()
            insightPane = dayReviewOriginPane
        }
        destination = next
        showSettings = false
        next.dashboardSection(insightPane)?.let(onSectionChange)
    }

    fun selectInsight(next: InsightPane) {
        if ((dayReviewOpen || state.dayReviewReturn != null) && next != InsightPane.Details) {
            dayReviewOpen = false
            onReturnFromDay()
        }
        val selection = V2NavigationSelection(destination, insightPane).openInsight(next)
        destination = selection.destination
        insightPane = selection.insightPane
        onSectionChange(next.dashboardSection())
    }

    var preferredCurrency by rememberSaveable { mutableStateOf(PrivacyStore.getPreferredCurrency(context)) }

    // 首次启动引导：从没见过、且云端一次桌面数据都没有时自动打开（与桌面端「账本为空才弹」一致）。
    var showGuide by rememberSaveable { mutableStateOf(initialGuideVisible) }
    val inspection = LocalInspectionMode.current
    val desktopData = v2DesktopData(state, displayedData)
    LaunchedEffect(desktopData, inspection) {
        if (!inspection && v2ShouldAutoOpenGuide(V2OnboardingStore.read(context), desktopData)) showGuide = true
    }
    val closeGuide: (Boolean) -> Unit = { completed ->
        V2OnboardingStore.write(
            context,
            if (completed) V2OnboardingVisibility.Completed else V2OnboardingVisibility.Dismissed
        )
        showGuide = false
    }

    CompositionLocalProvider(
        LocalCostMaskEnabled provides costMasked,
        LocalToggleCostMask provides {
            costMasked = PrivacyStore.toggleCostMaskEnabled(context)
            scope.launch { runCatching { TokenLedgerWidget().updateAll(context.applicationContext) } }
        },
        LocalDashboardCurrency provides preferredCurrency,
        LocalSetDashboardCurrency provides { unit ->
            preferredCurrency = unit
            PrivacyStore.setPreferredCurrency(context, unit)
        },
        LocalOpenFirstRunGuide provides { showGuide = true }
    ) {
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxSize()
                .background(palette.background)
        ) {
            val fontScale = LocalDensity.current.fontScale
            val layoutMode = dashboardLayoutMode(maxWidth.value.toInt(), fontScale)
            val wide = maxWidth >= 600.dp && layoutMode == DashboardLayoutMode.Standard
            val contentBottomPadding = dashboardContentBottomPaddingDp(maxWidth.value.toInt(), fontScale).dp
            val navWidth = if (wide && !showSettings && !entityMode) 76.dp else 0.dp
            Scaffold(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(start = navWidth),
                containerColor = palette.background,
                bottomBar = {
                    if (!wide && !showSettings && !entityMode) {
                        V2NavigationBar(
                            palette = palette,
                            selected = destination,
                            onSelect = ::selectDestination
                        )
                    }
                }
            ) { padding ->
                // §4.1 顶栏 scroll-under：今日/复盘/额度/展示由 V2DestinationContent 按当前页的 LazyListState
                // 报告；专属看板与设置页的列表在各自文件里，用 nestedScroll 累计实际滚动量（进出这两页时清零）。
                val pageScrollKey = when {
                    showSettings -> "settings"
                    entityMode -> "entity:$dataRetentionKey"
                    else -> "destinations"
                }
                val pageScrollOffset = rememberSaveable(pageScrollKey) { mutableFloatStateOf(0f) }
                val pageScroll = remember(pageScrollOffset) { V2ScrollUnderConnection(pageScrollOffset) }
                val pageScrolledUnder by remember(pageScroll) { derivedStateOf { pageScroll.scrolledUnder } }
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .nestedScroll(pageScroll)
                ) {
                    // 专属看板标题/面包屑：优先用看板自带的 EntityDescriptor（有 label），
                    // 数据还没到时退回查询里的 DashboardEntity（只有 kind/id，没有 label）。
                    val entityDescriptor = displayedData?.entityDashboard?.entity
                    val entityKind = entityDescriptor?.kind ?: state.entity?.kind
                    val entityLabel = entityDescriptor?.label ?: state.entity?.id ?: "来源下钻"
                    val querySummary = dashboardQuerySummary(state.query)
                    V2TopBar(
                        palette = palette,
                        title = v2TopBarTitle(
                            showSettings, entityMode, destination, entityLabel
                        ),
                        subtitle = v2TopBarSubtitle(
                            showSettings, entityMode, destination, entityKind, entityLabel, querySummary
                        ),
                        compact = layoutMode == DashboardLayoutMode.Compact,
                        loading = state.dashboardLoading,
                        statusText = v2DashboardTopStatusText(state, displayedData),
                        showRefreshProgress = state.dashboardLoading && displayedData != null,
                        showBack = showSettings || entityMode,
                        onBack = { if (showSettings) showSettings = false else onBack() },
                        onRefresh = onRefresh,
                        onSettings = { showSettings = true },
                        // 额度页只有刷新与设置（design §4.1「额度页只有刷新与设置」），不像其余
                        // 目的地那样带分享；旧版这里没按 destination 分支，额度页其实也在分享，
                        // 顺手把这处也修了。
                        // 「我的」是设置与展示入口，没有可分享的统计画面（重构 R5）。
                        onShare = displayedData
                            ?.takeIf { destination == MobileDestination.Usage }
                            ?.let { { showSharePoster = true } },
                        filtersActive = state.hasActiveFilters,
                        onOpenFilters = { filterSheet = V2FilterSheet.All },
                        identityColor = if (entityMode) {
                            palette.tokens.chartSlot(v2EntityIdentitySlot(entityKind, entityLabel))
                        } else {
                            null
                        },
                        scrolledUnder = if (showSettings || entityMode) pageScrolledUnder else destinationScrolledUnder
                    )
                    when {
                        showSettings -> V2SettingsPage(
                            palette = palette,
                            state = state,
                            appearance = appearance,
                            forceLandscape = forceLandscape,
                            wide = wide,
                            onAppearanceChange = onAppearanceChange,
                            onForceLandscapeChange = onForceLandscapeChange,
                            onOpenLowPowerDisplay = onOpenLowPowerDisplay,
                            onSignOut = onSignOut
                        )
                        entityMode -> V2EntityContent(
                            palette = palette,
                            state = state,
                            displayedStats = displayedData,
                            wide = wide,
                            tokenDisplayMode = tokenDisplayMode,
                            onTokenDisplayModeChange = onTokenDisplayModeChange,
                            onFilter = { filterSheet = V2FilterSheet.All },
                            onOpenModel = onOpenModel,
                            onLoadMore = onLoadMore,
                            onRefresh = onRefresh,
                            onSearchChange = onSearchChange
                        )
                        else -> V2DestinationContent(
                            palette = palette,
                            destination = destination,
                            insightPane = insightPane,
                            appearance = appearance,
                            ambientMode = ambientMode,
                            tokenDisplayMode = tokenDisplayMode,
                            state = state,
                            displayedStats = displayedData,
                            wide = wide,
                            contentBottomPadding = contentBottomPadding,
                            onRangeChange = onRangeChange,
                            onFilter = { filterSheet = V2FilterSheet.All },
                            onOpenInsights = ::selectInsight,
                            onInsightPaneChange = ::selectInsight,
                            onOpenQuota = { selectDestination(MobileDestination.Quota) },
                            onAmbientModeChange = onAmbientModeChange,
                            onTokenDisplayModeChange = onTokenDisplayModeChange,
                            onOpenLowPowerDisplay = onOpenLowPowerDisplay,
                            onOpenTool = onOpenTool,
                            onToolFilterChange = onToolChange,
                            onOpenModel = onOpenModel,
                            onSearchChange = onSearchChange,
                            onLoadMore = onLoadMore,
                            onRefresh = onRefresh,
                            onClearFilters = onClearFilters,
                            onRequestCustomRange = { showCustomRangeDialog = true },
                            onOpenDay = openDayReview,
                            onReturnFromDay = returnFromDayReview,
                            onOpenTrendDay = openTrendDay,
                            onScrolledUnderChange = { destinationScrolledUnder = it },
                            initialMePage = initialMePage,
                            meActions = V2MeActions(
                                forceLandscape = forceLandscape,
                                onAppearanceChange = onAppearanceChange,
                                onForceLandscapeChange = onForceLandscapeChange,
                                onSignOut = onSignOut
                            )
                        )
                    }
                }
            }
            if (wide && !showSettings && !entityMode) {
                V2NavigationRail(
                    palette = palette,
                    selected = destination,
                    onSelect = ::selectDestination,
                    modifier = Modifier.align(Alignment.CenterStart)
                )
            }
            if (showGuide) {
                // 后注册的返回回调先拿到返回键：引导盖在看板上时，返回只关引导。
                BackHandler { closeGuide(false) }
                V2FirstRunGuide(
                    palette = palette,
                    state = state,
                    stats = displayedData,
                    onRefresh = onRefresh,
                    onClose = closeGuide
                )
            }
        }

        if (filterSheet != null) {
            ModalBottomSheet(
                onDismissRequest = { filterSheet = null },
                containerColor = palette.raised,
                contentColor = palette.text
            ) {
                V2FilterSheetContent(
                    palette = palette,
                    state = state,
                    displayedStats = displayedData,
                    onMachineChange = onMachineChange,
                    onToolChange = onToolChange,
                    onModelChange = onModelChange,
                    onClearFilters = onClearFilters,
                    onDone = { filterSheet = null }
                )
            }
        }
        if (showSharePoster) {
            SharePosterSheet(
                stats = displayedData,
                range = state.query.range,
                appearance = appearance,
                onRangeChange = onRangeChange,
                onDismiss = { showSharePoster = false }
            )
        }
        if (showCustomRangeDialog) {
            V2CustomRangeDialog(
                palette = palette,
                query = state.query,
                onDismiss = { showCustomRangeDialog = false },
                onApply = { start, end ->
                    showCustomRangeDialog = false
                    onCustomRangeChange(start, end)
                }
            )
        }
    }
}

@Composable
internal fun V2DestinationContent(
    palette: MobileV2Palette,
    destination: MobileDestination,
    insightPane: InsightPane,
    appearance: LedgerAppearance,
    ambientMode: AmbientMode,
    tokenDisplayMode: TokenDisplayMode,
    state: DashboardUiState,
    displayedStats: StatsData?,
    wide: Boolean,
    contentBottomPadding: Dp,
    onRangeChange: (RangeKey) -> Unit,
    onFilter: () -> Unit,
    onOpenInsights: (InsightPane) -> Unit,
    onInsightPaneChange: (InsightPane) -> Unit,
    onOpenQuota: () -> Unit,
    onAmbientModeChange: (AmbientMode) -> Unit,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit,
    onOpenLowPowerDisplay: () -> Unit,
    onOpenTool: (String) -> Unit,
    onToolFilterChange: (String?) -> Unit,
    onOpenModel: (String) -> Unit,
    onSearchChange: (String?) -> Unit,
    onLoadMore: () -> Unit,
    onRefresh: () -> Unit,
    onClearFilters: () -> Unit,
    onRequestCustomRange: () -> Unit,
    onOpenDay: (String) -> Unit,
    onReturnFromDay: () -> Unit,
    onOpenTrendDay: (String, InsightPane) -> Unit,
    onScrolledUnderChange: (Boolean) -> Unit = {},
    initialMePage: V2MePage = V2MePage.Root,
    meActions: V2MeActions = V2MeActions()
) {
    var trendMetric by rememberSaveable { mutableStateOf(ReportMetricMode.Tokens) }
    val trendCurrency = LocalDashboardCurrency.current
    val setTrendCurrency = LocalSetDashboardCurrency.current
    val calendarAxis = remember(state.calendarHeatmap) { buildInsightCalendarAxis(state.calendarHeatmap) }
    val calendarGlobalQuery = state.dayReviewReturn?.query ?: state.query
    var calendarOpenedDate by rememberSaveable(calendarGlobalQuery) { mutableStateOf<String?>(null) }
    val overviewListState = rememberSaveable(saver = LazyListState.Saver, key = "v2_scroll_overview") { LazyListState() }
    val quotaListState = rememberSaveable(saver = LazyListState.Saver, key = "v2_scroll_quota") { LazyListState() }
    val widgetListState = rememberSaveable(saver = LazyListState.Saver, key = "v2_scroll_widget") { LazyListState() }
    val routingListState = rememberSaveable(saver = LazyListState.Saver, key = "v2_scroll_routing") { LazyListState() }
    // 路由页只在可见时轮询云端路由快照（routing-snapshot-v1），不影响用量统计的读取。
    val routingFeed = rememberRoutingFeed(state.session, active = destination == MobileDestination.Routing)
    val meStandbyListState = rememberSaveable(saver = LazyListState.Saver, key = "v2_scroll_me_standby") { LazyListState() }
    var mePage by rememberSaveable { mutableStateOf(initialMePage) }
    BackHandler(enabled = destination == MobileDestination.Me && mePage != V2MePage.Root) { mePage = V2MePage.Root }

    val trendListState = rememberSaveable(saver = LazyListState.Saver, key = "v2_scroll_insight_trend") { LazyListState() }
    val sourcesListState = rememberSaveable(saver = LazyListState.Saver, key = "v2_scroll_insight_sources") { LazyListState() }
    val calendarListState = rememberSaveable(saver = LazyListState.Saver, key = "v2_scroll_insight_calendar") { LazyListState() }
    val detailsListState = rememberSaveable(saver = LazyListState.Saver, key = "v2_scroll_insight_details") { LazyListState() }

    fun listStateFor(dest: MobileDestination, pane: InsightPane): LazyListState = when (dest) {
        MobileDestination.Usage -> when (pane) {
            InsightPane.Overview -> overviewListState
            InsightPane.Trend -> trendListState
            InsightPane.Sources -> sourcesListState
            InsightPane.Calendar -> calendarListState
            InsightPane.Details -> detailsListState
        }
        MobileDestination.Routing -> routingListState
        MobileDestination.Quota -> quotaListState
        MobileDestination.Me -> if (mePage == V2MePage.Root) widgetListState else meStandbyListState
    }
    val revealMotion = ledgerMotionEnabled(palette.isEInk)
    val revealDensity = LocalDensity.current

    // §4.1 顶栏 scroll-under：当前页（目的地 × 洞察页签）的列表是否已离开顶部，只在翻转时报告；
    // 没有数据、显示的是状态壳时列表不在屏上，一律算在顶部。
    val activeListState = listStateFor(destination, insightPane)
    // 路由页与「我的」不依赖用量统计：统计还没到或读取失败时它们照常显示自己的内容。
    val routingIndependent = destination == MobileDestination.Routing || destination == MobileDestination.Me
    val listShown = displayedStats != null || routingIndependent
    val reportScrolledUnder by rememberUpdatedState(onScrolledUnderChange)
    LaunchedEffect(activeListState, listShown) {
        snapshotFlow { listShown && activeListState.v2ScrolledUnder() }.collect { reportScrolledUnder(it) }
    }

    val stats = displayedStats
    when {
        stats == null && !routingIndependent && state.dashboardLoading -> V2DestinationStateShell(
            palette, destination, insightPane, state.query, state.dayReviewReturn != null,
            onRangeChange, onRequestCustomRange, onInsightPaneChange, onReturnFromDay
        ) { V2LoadingState(palette = palette, showingCachedData = state.showingCachedData) }
        stats == null && !routingIndependent && state.error != null -> V2DestinationStateShell(
            palette, destination, insightPane, state.query, state.dayReviewReturn != null,
            onRangeChange, onRequestCustomRange, onInsightPaneChange, onReturnFromDay
        ) {
            V2FullState(palette, "看板暂时不可用", state.userVisibleError.orEmpty(), "重试", onRefresh)
        }
        stats == null && !routingIndependent -> V2DestinationStateShell(
            palette, destination, insightPane, state.query, state.dayReviewReturn != null,
            onRangeChange, onRequestCustomRange, onInsightPaneChange, onReturnFromDay
        ) {
            if (state.hasActiveFilters) {
                V2FullState(palette, "没有匹配的消耗记录", "当前筛选没有匹配记录。", "清除筛选", onClearFilters)
            } else {
                Box(Modifier.fillMaxSize().padding(14.dp)) {
                    V2NoDesktopDataState(palette, destination == MobileDestination.Quota, onRefresh, state.dashboardLoading)
                }
            }
        }
        else -> AnimatedContent(
            targetState = destination to insightPane,
            modifier = Modifier.fillMaxSize(),
            transitionSpec = {
                // design §5「只在挂载时揭示一次」+「EMPHASIZED（enter）420ms，位移 10dp…
                // 切一级页、切复盘页签：新页淡入并上移 10dp，旧页 90ms 淡出」：目的地或洞察页签
                // 任一变化都换一把新的 targetState、这棵 LazyColumn 真的重新「挂载」；仅数据刷新时
                // destination/insightPane 不变，AnimatedContent 不重触发，原地更新数据、不播放揭示。
                val enter = fadeIn(
                    ledgerTween(LedgerMotion.EMPHASIZED_MILLIS, revealMotion, easing = LedgerEasing.EaseOutExpo)
                ) + slideInVertically(
                    ledgerTween(LedgerMotion.EMPHASIZED_MILLIS, revealMotion, easing = LedgerEasing.EaseOutExpo)
                ) { with(revealDensity) { LedgerMotion.ENTER_OFFSET.roundToPx() } }
                // 90ms 没有单独命名的 LedgerMotion 常量：字面量出自 design §5 同一条 EMPHASIZED
                // 规则里「旧页 90ms 淡出」那半句，和 ENTER_OFFSET/EMPHASIZED_MILLIS 同一处出处，
                // 不是另起的数字。
                val exit = fadeOut(ledgerTween(90, revealMotion))
                enter togetherWith exit
            },
            label = "destinationReveal"
        ) { (targetDestination, targetPane) ->
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                state = listStateFor(targetDestination, targetPane),
                contentPadding = PaddingValues(start = 14.dp, end = 14.dp, bottom = contentBottomPadding),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                val meItems: () -> Unit = {
                    v2MeItems(
                        palette, mePage, { mePage = it }, state, stats, appearance, ambientMode,
                        tokenDisplayMode, meActions, onAmbientModeChange, onTokenDisplayModeChange,
                        onOpenLowPowerDisplay, onRefresh
                    )
                }
                if (stats == null) {
                    // 只有路由页与「我的」会在没有统计时走到这里；切页过渡里旧页也可能短暂落在这一支。
                    when (targetDestination) {
                        MobileDestination.Routing -> v2RoutingItems(palette, routingFeed)
                        MobileDestination.Me -> meItems()
                        else -> Unit
                    }
                    return@LazyColumn
                }
                when (targetDestination) {
                    MobileDestination.Usage -> if (targetPane == InsightPane.Overview) v2OverviewItems(
                        palette,
                        state,
                        stats,
                        tokenDisplayMode,
                        onRangeChange,
                        onTokenDisplayModeChange,
                        onFilter,
                        onOpenInsights,
                        onOpenQuota,
                        onOpenTool,
                        onRequestCustomRange,
                        onRefresh
                    ) else v2InsightsItems(
                        palette,
                        state,
                        stats,
                        targetPane,
                        wide,
                        tokenDisplayMode,
                        onInsightPaneChange,
                        onTokenDisplayModeChange,
                        onOpenTool,
                        onOpenModel,
                        onToolFilterChange,
                        onSearchChange,
                        onLoadMore,
                        { date -> calendarOpenedDate = date; onOpenDay(date) },
                        onReturnFromDay,
                        calendarOpenedDate,
                        trendMetric, trendCurrency,
                        { trendMetric = it }, setTrendCurrency, onOpenTrendDay, calendarAxis,
                        onRefresh
                    )
                    MobileDestination.Routing -> v2RoutingItems(palette, routingFeed)
                    MobileDestination.Quota -> v2QuotaItems(
                        palette = palette,
                        quota = state.quota,
                        onRefresh = onRefresh,
                        dashboardLoading = state.dashboardLoading
                    )
                    MobileDestination.Me -> meItems()
                }
            }
        }
    }
}

@Composable
internal fun V2DestinationStateShell(
    palette: MobileV2Palette,
    destination: MobileDestination,
    insightPane: InsightPane,
    query: DashboardQuery,
    dayReviewActive: Boolean,
    onRangeChange: (RangeKey) -> Unit,
    onRequestCustomRange: () -> Unit,
    onInsightPaneChange: (InsightPane) -> Unit,
    onReturnFromDay: () -> Unit,
    content: @Composable () -> Unit
) {
    Column(Modifier.fillMaxSize()) {
        when (destination) {
            MobileDestination.Usage -> Box(Modifier.fillMaxWidth().padding(horizontal = 14.dp)) {
                Column {
                    V2InsightStrip(palette, insightPane, onInsightPaneChange)
                    if (insightPane == InsightPane.Overview) {
                        V2GlobalRangeControl(palette, query, onRangeChange, onRequestCustomRange)
                    }
                    if (dayReviewActive) {
                        TextButton(
                            onClick = onReturnFromDay,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                        ) { Text("返回原查询与复盘") }
                    }
                }
            }
            MobileDestination.Routing, MobileDestination.Quota, MobileDestination.Me -> Unit
        }
        Box(Modifier.fillMaxWidth().weight(1f)) { content() }
    }
}

internal fun LazyListScope.v2OverviewItems(
    palette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    onRangeChange: (RangeKey) -> Unit,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit,
    onFilter: () -> Unit,
    onOpenInsights: (InsightPane) -> Unit,
    onOpenQuota: () -> Unit,
    onOpenTool: (String) -> Unit,
    onRequestCustomRange: () -> Unit,
    onRefresh: () -> Unit = {}
) {
    item(key = "overview-tabs", contentType = "controls") {
        V2InsightStrip(palette, InsightPane.Overview, onOpenInsights)
    }
    item(key = "overview-range", contentType = "controls") {
        V2GlobalRangeControl(palette, state.query, onRangeChange, onRequestCustomRange)
    }
    // 新账户：云端还没有任何桌面数据，全零的英雄卡说明不了什么，换成接入说明。
    if (v2HasDesktopData(stats, state.hasActiveFilters) == false) {
        item(key = "overview-no-desktop", contentType = "status") {
            V2NoDesktopDataState(palette, quota = false, onRefresh = onRefresh, refreshing = state.dashboardLoading)
        }
        return
    }

    item(key = "overview-hero", contentType = "hero") {
        V2HeroCard(palette, stats, tokenDisplayMode, onTokenDisplayModeChange, onOpenInsights)
    }
    item(key = "overview-tools", contentType = "chart") {
        V2ToolDistributionCard(
            palette = palette,
            stats = stats,
            tokenDisplayMode = tokenDisplayMode,
            onOpenTool = onOpenTool,
            onOpenRemainder = { onOpenInsights(InsightPane.Sources) },
            limit = TODAY_SOURCE_LIMIT,
            title = "主要来源"
        )
    }
    // 重构 R2：额度有了自己的一级分区，概览只在来源之后留一张摘要卡作入口，主区与参考设计同序。
    item(key = "overview-quota", contentType = "quota") {
        V2QuotaSummaryCard(palette, state.quota, onOpenQuota, limit = TODAY_QUOTA_LIMIT)
    }
}

internal fun LazyListScope.v2InsightsItems(
    palette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    pane: InsightPane,
    wide: Boolean,
    tokenDisplayMode: TokenDisplayMode,
    onPaneChange: (InsightPane) -> Unit,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit,
    onOpenTool: (String) -> Unit,
    onOpenModel: (String) -> Unit,
    onToolFilterChange: (String?) -> Unit,
    onSearchChange: (String?) -> Unit,
    onLoadMore: () -> Unit,
    onOpenDay: (String) -> Unit,
    onReturnFromDay: () -> Unit,
    calendarOpenedDate: String?,
    trendMetric: ReportMetricMode,
    trendCurrency: CurrencyUnit,
    onTrendMetricChange: (ReportMetricMode) -> Unit,
    onTrendCurrencyChange: (CurrencyUnit) -> Unit,
    onOpenTrendDay: (String, InsightPane) -> Unit,
    calendarAxis: InsightCalendarAxis,
    onRefresh: () -> Unit = {}
) {
    item(key = "insights-tabs", contentType = "controls") { V2InsightStrip(palette, pane, onPaneChange) }
    if (pane != InsightPane.Overview && v2HasDesktopData(stats, state.hasActiveFilters) == false) {
        item(key = "insights-no-desktop", contentType = "status") {
            V2NoDesktopDataState(palette, quota = false, onRefresh = onRefresh, refreshing = state.dashboardLoading)
        }
        return
    }
    when (pane) {
        // 概览由 v2OverviewItems 渲染，调用方不会以概览进入这里。
        InsightPane.Overview -> Unit
        InsightPane.Trend -> {
            item(key = "insights-trend", contentType = "chart") {
                V2TrendInsightCard(
                    palette, stats, tokenDisplayMode, onTokenDisplayModeChange,
                    trendMetric, trendCurrency, onTrendMetricChange, onTrendCurrencyChange,
                    !state.dashboardLoading, includeDetails = true, onOpenBucket = onOpenTrendDay
                )
            }
        }
        InsightPane.Sources -> {
            if (state.dayReviewReturn != null) item(key = "source-day-return", contentType = "context") {
                TextButton(onClick = onReturnFromDay) { Text("返回原查询与复盘") }
            }
            item(key = "insights-sources", contentType = "sources") {
                V2UsageSplitCard(
                    palette, stats, tokenDisplayMode,
                    machineFiltered = state.query.machines.isNotEmpty(),
                    onOpenTool = onOpenTool,
                    onOpenModel = onOpenModel
                )
            }
        }
        InsightPane.Calendar -> {
            item(key = "insights-calendar-chart", contentType = "chart") {
                V2InsightCalendarCard(
                    palette, stats, onOpenDay, state.query, calendarOpenedDate,
                    globalAxis = calendarAxis,
                    calendarNotice = (state.calendarHeatmap as? CalendarHeatmapUiState.Available)?.let {
                        it.warning ?: if (it.showingCachedData) "当前显示缓存日历" else null
                    }
                )
            }
        }
        InsightPane.Details -> {
            if (state.dayReviewReturn != null && state.query.range == RangeKey.Custom && state.query.start == state.query.end) {
                item(key = "insights-day-summary", contentType = "context") {
                    V2DayReviewSummary(palette, state.query.start.orEmpty(), stats, onReturnFromDay)
                }
                item(key = "insights-day-trend", contentType = "chart") {
                    V2TrendInsightCard(
                        palette, stats, tokenDisplayMode, onTokenDisplayModeChange,
                        trendMetric, trendCurrency, onTrendMetricChange, onTrendCurrencyChange,
                        !state.dashboardLoading
                    )
                }
            }
            item(key = "insights-detail-search", contentType = "controls") {
                V2DetailSearch(palette, state.query.search, onSearchChange)
            }
            val details = stats.detailsPage?.items ?: stats.history
            val listSummary = detailListSummary(stats.detailsPage, tokenDisplayMode)
            if (details.isNotEmpty() && listSummary != null) {
                item(key = "insights-detail-summary", contentType = "context") {
                    V2DetailListHeader(palette, listSummary)
                }
            }
            if (details.isEmpty()) {
                item(key = "insights-detail-empty", contentType = "status") {
                    val narrowed = !state.query.search.isNullOrBlank() ||
                        state.query.machines.isNotEmpty() ||
                        state.query.tools.isNotEmpty() ||
                        state.query.models.isNotEmpty()
                    V2Card(palette) {
                        Text(
                            if (narrowed) "没有匹配明细" else "当前范围没有明细",
                            color = palette.text, fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            if (narrowed) "调整筛选或搜索词后再试。" else "换一个时间范围再看。",
                            color = palette.muted, fontSize = LedgerFont.label
                        )
                    }
                }
            } else {
                items(details, key = { "${it.timestamp}|${it.id}" }, contentType = { "detail" }) { detail ->
                    V2DetailRow(
                        palette,
                        detail,
                        tokenDisplayMode,
                        granularity = stats.detailsPage?.granularity ?: "hour",
                        onFilterSession = { onSearchChange(it) }
                    )
                }
                if (stats.detailsPage?.hasMore == true && state.paginationError == null) {
                    item(key = "insights-detail-more", contentType = "action") {
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
                    item(key = "insights-detail-error", contentType = "status") {
                        V2PaginationErrorCard(
                            palette = palette,
                            error = error,
                            loading = state.loadingMore,
                            onRetry = onLoadMore
                        )
                    }
                }
            }
        }
    }
}

/**
 * 云端还没有任何桌面数据时用量各页（与额度页的整页兜底）显示的卡：说清手机的数据从哪来、
 * 去桌面哪里打开，再给「查看接入步骤」与「刷新」。
 */
@Composable
internal fun V2NoDesktopDataState(
    palette: MobileV2Palette,
    quota: Boolean,
    onRefresh: () -> Unit,
    refreshing: Boolean
) {
    V2EmptyState(
        palette = palette,
        icon = Icons.Default.CloudSync,
        title = "还没有收到桌面端的数据",
        body = if (quota) {
            "额度来自桌面端读取的订阅窗口。在电脑上用同一个账户开启「设置 › 云端同步」后，这里会显示各窗口的剩余额度。"
        } else {
            "手机显示的是桌面端同步到云端的用量。在电脑上打开 TokenLedger，到「设置 › 云端同步」" +
                "登录同一个账户并完成首次同步，这里几分钟内就会出现数据。"
        },
        secondary = V2EmptyAction(if (refreshing) "刷新中…" else "刷新", enabled = !refreshing, onClick = onRefresh)
    )
}
