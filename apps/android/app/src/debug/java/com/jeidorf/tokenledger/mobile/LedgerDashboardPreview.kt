package com.jeidorf.tokenledger.mobile

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.tooling.preview.Preview
import com.jeidorf.tokenledger.mobile.ui.me.V2MePage
import java.time.Instant
import java.time.LocalDate
import kotlin.math.roundToLong

/**
 * 所有预览共用的固定"此刻"。
 *
 * 额度的新鲜/过期、重置倒计时全部由 `now` 裁决，预览若读墙上时钟，同一份夹具就会随日历
 * 漂移：`ledgerFreshQuotaSnapshotFixture()` 的时间戳都是从 2026-07-28 那个时刻推出来的，
 * 用真实时钟渲染，名叫「Quota fresh」的参考图上四个窗口全写着「重置 已到期」，
 * 而按夹具自带时钟断言的 JVM 用例照样绿——图与单测各说各话，且重出一次参考图就把
 * 漂移固化进去，门禁再也不会为此变红。
 *
 * 取值必须晚于所有夹具的 observedAt，否则会出现"观测时间在未来"的荒唐状态。
 */
internal val LEDGER_PREVIEW_NOW: Instant = Instant.parse("2026-07-28T04:00:00Z")

/**
 * Design-QA-only fixture. It is compiled only in debug builds and is never reachable from the
 * production application path. Values mirror the accepted 390x844 visual target so Android
 * Studio can capture an implementation screenshot without forging runtime account data.
 */
@Preview(
    name = "Ledger Snapshot 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF080A0F
)
@Composable
internal fun LedgerDashboard390Preview() {
    LedgerDashboardPreviewHost(LedgerAppearance.Dark)
}

/**
 * Shared host for screenshot-test configurations. Usage and quota values are deterministic,
 * anonymous synthetic evidence and are never reachable from the production route.
 */
@Composable
internal fun LedgerDashboardPreviewHost(
    appearance: LedgerAppearance,
    state: DashboardUiState = ledgerSnapshotFixture(),
    destination: MobileDestination = MobileDestination.Usage,
    insightPane: InsightPane = InsightPane.Overview,
    ambientMode: AmbientMode = AmbientMode.Console,
    tokenDisplayMode: TokenDisplayMode = TokenDisplayMode.Effective,
    forceLandscape: Boolean = false,
    settingsVisible: Boolean = false,
    mePage: V2MePage = V2MePage.Root
) {
    TokenLedgerTheme(appearance) {
        ProvideLedgerPalette(appearance) {
            // 预览统一钉一个"此刻"：额度的新鲜/过期与重置倒计时全由 now 裁决，
            // 读墙上时钟会让同一份夹具随日历漂移（见 [LEDGER_PREVIEW_NOW]）。
            CompositionLocalProvider(LocalLedgerNow provides { LEDGER_PREVIEW_NOW }) {
                LedgerDashboardV2Screen(
                    state = state.copy(calendarHeatmap = state.visibleData?.let { data ->
                        val axis = buildInsightCalendarAxis(data, state.query)
                        if (!axis.isTrusted || axis.selectableStart == null || axis.selectableEnd == null) {
                            CalendarHeatmapUiState.Unavailable(state.query, axis.unavailableReason ?: "预览日历不可得")
                        } else CalendarHeatmapUiState.Available(data.heatmap, state.query, state.query,
                            axis.timezone.orEmpty(), data.meta?.generatedAt, axis.selectableStart.toString(),
                            axis.selectableEnd.toString(), false)
                    } ?: CalendarHeatmapUiState.Idle),
                    appearance = appearance,
                    forceLandscape = forceLandscape,
                    tokenDisplayMode = tokenDisplayMode,
                    ambientMode = ambientMode,
                    onForceLandscapeChange = {},
                    onTokenDisplayModeChange = {},
                    onAmbientModeChange = {},
                    onRangeChange = {},
                    onMachineChange = {},
                    onToolChange = {},
                    onModelChange = {},
                    onClearFilters = {},
                    onSectionChange = {},
                    onContributionModeChange = {},
                    onOpenTool = {},
                    onOpenModel = {},
                    onBack = {},
                    onLoadMore = {},
                    onAppearanceChange = {},
                    onOpenLowPowerDisplay = {},
                    onRefresh = {},
                    onSignOut = {},
                    initialDestination = destination,
                    initialInsightPane = insightPane,
                    initialSettingsVisible = settingsVisible,
                    initialMePage = mePage
                )
            }
        }
    }
}

@Composable
internal fun LedgerDashboardFilterSheetPreviewHost(
    appearance: LedgerAppearance,
    state: DashboardUiState = ledgerRefreshingSnapshotFixture(),
    displayedStats: StatsData? = state.visibleData
) {
    TokenLedgerTheme(appearance) {
        ProvideLedgerPalette(appearance) {
            V2FilterSheetPreviewContent(
                appearance = appearance,
                state = state,
                displayedStats = displayedStats
            )
        }
    }
}

internal fun ledgerSnapshotFixture(
    range: RangeKey = RangeKey.Today,
    section: DashboardSection = DashboardSection.Overview
): DashboardUiState {
    val summary = ledgerSnapshotSummary()
    val comparison = ledgerSnapshotComparison(range, summary)
    val heatmap = ledgerHeatmapFixture()
    val history = ledgerHistoryFixture()
    val tools = listOf(
        ToolStat(
            name = "codex",
            input = 470_000,
            output = 180_400,
            cached = 130_000,
            total = 650_400,
            cost = 9.5,
            requests = 1_640,
            cacheRead = 114_000,
            cacheWrite = 16_000,
            models = mapOf("gpt-5" to 650_400)
        ),
        ToolStat(
            name = "claude",
            input = 211_000,
            output = 80_100,
            cached = 62_000,
            total = 291_100,
            cost = 4.2,
            requests = 780,
            cacheRead = 54_000,
            cacheWrite = 8_000,
            models = mapOf("claude-opus-4" to 291_100)
        ),
        ToolStat(
            name = "minimax",
            input = 128_000,
            output = 48_700,
            cached = 32_000,
            total = 176_700,
            cost = 2.1,
            requests = 420,
            cacheRead = 28_000,
            cacheWrite = 4_000,
            models = mapOf("MiniMax-M2" to 176_700)
        ),
        ToolStat(
            name = "opencode",
            input = 111_000,
            output = 50_800,
            cached = 24_400,
            total = 161_800,
            cost = 2.597,
            requests = 287,
            cacheRead = 20_400,
            cacheWrite = 4_000,
            models = mapOf("qwen3-coder" to 161_800)
        )
    ).associateBy { it.name }
    val models = listOf(
        ModelStat(
            name = "gpt-5",
            total = 650_400,
            requests = 1_640,
            input = 470_000,
            output = 180_400,
            cached = 130_000,
            cost = 9.5
        ),
        ModelStat(
            name = "claude-opus-4",
            total = 291_100,
            requests = 780,
            input = 211_000,
            output = 80_100,
            cached = 62_000,
            cost = 4.2
        ),
        ModelStat(
            name = "MiniMax-M2",
            total = 176_700,
            requests = 420,
            input = 128_000,
            output = 48_700,
            cached = 32_000,
            cost = 2.1
        ),
        ModelStat(
            name = "qwen3-coder",
            total = 161_800,
            requests = 287,
            input = 111_000,
            output = 50_800,
            cached = 24_400,
            cost = 2.597
        )
    ).associateBy { it.name }
    val stats = StatsData(
        summary = summary,
        tools = tools,
        models = models,
        trends = if (comparison == null) {
            heatmap.entries.sortedBy { it.key }.takeLast(20).map { entry ->
                TrendPoint(entry.key, mapOf("all" to entry.value))
            }
        } else {
            emptyList()
        },
        heatmap = heatmap,
        history = history,
        machines = listOf("MacBook-Pro", "Windows-Workstation"),
        meta = StatsMeta(
            generatedAt = "2026-07-15T12:41:00+08:00",
            lastRefreshedAt = "2026-07-15T12:41:00+08:00",
            timezone = "Asia/Shanghai",
            range = range.rpcValue,
            machine = null,
            stale = false,
            contractVersion = 2,
            query = StatsQueryEcho(range = range.rpcValue, timezone = "Asia/Shanghai")
        ),
        comparison = comparison,
        detailsPage = UsageDetailsPage(
            items = history,
            nextCursor = null,
            hasMore = false,
            totalCount = 24,
            filteredSummary = summary,
            availableFilters = AvailableFilters(
                tools = tools.values.map { FilterOption(it.name, it.requests) },
                models = models.values.map { FilterOption(it.name, it.requests) },
                machines = listOf(FilterOption("MacBook-Pro", 2_100), FilterOption("Windows-Workstation", 1_027))
            )
        ),
        capabilities = DashboardCapabilities(
            comparison = comparison != null,
            details = true,
            entityDashboard = true
        )
    )
    return DashboardUiState(
        configured = true,
        sessionState = DashboardSessionState.Authenticated(
            MobileSession("preview", "preview", "preview-user", "preview@local", Long.MAX_VALUE)
        ),
        query = DashboardQuery(range = range),
        data = stats,
        loadingMode = DashboardLoadingMode.Idle,
        lastUpdatedEpochMillis = 1_752_556_860_000L,
        section = section,
        quota = ledgerQuotaFixture(),
        dailyQuote = DailyQuoteSnapshot(
            date = LocalDate.of(2026, 7, 17),
            quote = DailyQuote("锲而不舍，金石可镂。", "《荀子》")
        )
    )
}

internal fun ledgerRefreshingSnapshotFixture(
    range: RangeKey = RangeKey.Week,
    section: DashboardSection = DashboardSection.Overview
): DashboardUiState {
    val current = ledgerSnapshotFixture(range = range, section = section)
    return current.copy(
        data = null,
        cachedData = current.data,
        loadingMode = DashboardLoadingMode.Refreshing,
        showingCachedData = true
    )
}

/**
 * 有汇总、无时间序列的快照。
 *
 * 断网读本机快照时真实会到的一种状态：总量、成本、请求次数都在，
 * `comparison.current.series` 与 `trends` 却是空的（`metricSeriesValues` 与
 * `ambientRhythmSeries` 都是"comparison 非空就用它的 series，哪怕是空表"）。
 * 概览与洞察在这种状态下会写「当前范围暂无 Token 趋势」，摆件此前什么都不说。
 */
internal fun ledgerNoSeriesSnapshotFixture(): DashboardUiState {
    val base = ledgerSnapshotFixture()
    val stats = requireNotNull(base.data)
    val comparison = stats.comparison
    return base.copy(
        data = stats.copy(
            trends = emptyList(),
            comparison = comparison?.copy(
                current = comparison.current.copy(series = emptyList()),
                previous = comparison.previous.copy(series = emptyList())
            )
        )
    )
}

internal fun ledgerEntitySnapshotFixture(): DashboardUiState {
    val base = ledgerSnapshotFixture(section = DashboardSection.Entity)
    val stats = requireNotNull(base.data)
    val tool = requireNotNull(stats.tools["codex"])
    val summary = Summary(
        totalTokens = tool.total + tool.cached,
        inputTokens = tool.input,
        outputTokens = tool.output,
        cachedTokens = tool.cached,
        cacheReadTokens = tool.cacheRead ?: 0L,
        cacheWriteTokens = tool.cacheWrite ?: 0L,
        totalCost = tool.cost,
        totalRequests = tool.requests,
        avgTokensPerReq = tool.effectiveTokens / tool.requests.coerceAtLeast(1L)
    )
    val historyPage = requireNotNull(stats.detailsPage).copy(
        items = stats.history.filter { it.tool == "codex" },
        totalCount = 12,
        filteredSummary = summary
    )
    val entity = EntityDashboard(
        entity = EntityDescriptor(kind = DashboardEntity.TOOL, tool = "codex", model = null),
        summary = summary,
        comparison = stats.comparison,
        composition = EntityComposition(
            models = listOf(
                CompositionEntry(
                    value = "gpt-5",
                    tokens = tool.effectiveTokens,
                    inputTokens = tool.input,
                    outputTokens = tool.output,
                    cachedTokens = tool.cached,
                    cacheWriteTokens = tool.cacheWrite,
                    requests = tool.requests,
                    cost = tool.cost
                )
            ),
            machines = listOf(
                CompositionEntry("MacBook-Pro", 510_200, requests = 1_240),
                CompositionEntry("Windows-Workstation", 140_200, requests = 400)
            )
        ),
        heatmap = stats.heatmap,
        peak = EntityPeak("2026-07-15 13:00:00", 142_000, 86, 1.92),
        activity = EntityActivity(38, "2026-05-19 08:00:00", "2026-07-15 12:00:00"),
        historyPage = historyPage
    )
    return base.copy(
        query = base.query.copy(compatibilityToolSelector = "codex"),
        data = stats.copy(
            summary = summary,
            history = historyPage.items,
            detailsPage = historyPage,
            entityDashboard = entity,
            capabilities = stats.capabilities.copy(entityDashboard = true)
        ),
        entity = DashboardEntity(DashboardEntity.TOOL, "codex"),
        navigationStack = listOf(
            DashboardNavigationSnapshot(
                query = DashboardQuery(),
                section = DashboardSection.Contributions,
                contributionMode = ContributionMode.Tools
            )
        )
    )
}

internal fun ledgerPaginationErrorSnapshotFixture(): DashboardUiState {
    val base = ledgerSnapshotFixture(section = DashboardSection.Details)
    val stats = requireNotNull(base.data)
    val detailsPage = requireNotNull(stats.detailsPage).copy(
        items = stats.history.take(2),
        nextCursor = "retry-cursor",
        hasMore = true,
        totalCount = 24
    )
    return base.copy(
        data = stats.copy(
            history = detailsPage.items,
            detailsPage = detailsPage
        ),
        paginationError = "网络暂时不可用，请重试。"
    )
}

internal fun ledgerStaleQuotaSnapshotFixture(): DashboardUiState {
    val base = ledgerSnapshotFixture()
    val quota = base.quota as QuotaUiState.Available
    return base.copy(
        quota = quota.copy(
            snapshot = quota.snapshot.copy(
                providers = quota.snapshot.providers.mapIndexed { index, provider ->
                    if (index == 0) {
                        provider.copy(
                            status = QuotaProviderStatus.Stale,
                            reasonCode = "observation_stale"
                        )
                    } else {
                        provider
                    }
                }
            )
        )
    )
}

/**
 * Screenshot tests use a deterministic synthetic clock. Every fresh timestamp is derived from
 * that clock instead of from a calendar literal, so the fixture proves freshness without becoming
 * stale as the real test date advances.
 */
internal fun ledgerFreshQuotaSnapshotFixture(): DashboardUiState {
    val base = ledgerSnapshotFixture()
    val quota = base.quota as QuotaUiState.Available
    val now = LEDGER_PREVIEW_NOW
    val observedAt = now.minusSeconds(60).toString()
    return base.copy(
        quota = quota.copy(
            snapshot = quota.snapshot.copy(
                generatedAt = now.minusSeconds(30).toString(),
                providers = quota.snapshot.providers.map { provider ->
                    provider.copy(
                        status = QuotaProviderStatus.Ok,
                        reasonCode = null,
                        windows = provider.windows.map { window ->
                            window.copy(
                                status = QuotaWindowStatus.Ok,
                                observedAt = observedAt,
                                fetchedAt = observedAt,
                                resetsAt = now.plusSeconds(
                                    if (window.windowMinutes == 300) 2 * 3_600L else 4 * 86_400L
                                ).toString(),
                                staleAfterSeconds = 300,
                                reasonCode = null
                            )
                        }
                    )
                }
            ),
            showingCachedData = false,
            savedAtEpochMillis = now.toEpochMilli(),
            evaluatedAtEpochMillis = now.toEpochMilli(),
            warning = null
        )
    )
}

/**
 * 额度都还"读得到"（`status = Ok`），但剩余量跨过挂件那把尺的三档。
 *
 * 挂件预览胶囊按 `widgetAvailabilityBand`（<20% 危 / <50% 警 / 其余正常，严格小于，
 * D4/T10.152）上色，而此前**没有任何一张参考图能拍到 Ok 这一支**——所有夹具的
 * 观测时间都早得让 `effectiveStatus` 判成 Stale，于是三档颜色一档也没被拍下来过。
 * 剩余量按 `rankedQuotaWindowsForDisplay` 的确定序落在 3% / 35% / 65% / 90% 上，
 * 分别代表告急、偏紧与两个正常样本。
 */
internal fun ledgerWidgetBandQuotaSnapshotFixture(): DashboardUiState {
    val base = ledgerFreshQuotaSnapshotFixture()
    val quota = base.quota as QuotaUiState.Available
    val remainders = listOf(3.0, 35.0, 65.0, 90.0)
    var index = 0
    return base.copy(
        quota = quota.copy(
            snapshot = quota.snapshot.copy(
                providers = quota.snapshot.providers.map { provider ->
                    provider.copy(
                        windows = provider.windows.map { window ->
                            val remaining = remainders[index % remainders.size]
                            index += 1
                            window.copy(remaining = remaining, used = 100.0 - remaining)
                        }
                    )
                }
            )
        )
    )
}

internal fun ledgerErrorQuotaSnapshotFixture(): DashboardUiState =
    ledgerQuotaProviderStateFixture(
        status = QuotaProviderStatus.Error,
        reasonCode = "source_temporarily_unavailable"
    )

internal fun ledgerUnavailableQuotaSnapshotFixture(): DashboardUiState =
    ledgerSnapshotFixture().copy(
        quota = QuotaUiState.Unavailable("网络不可用，额度同步暂时不可用。")
    )

internal fun ledgerUnavailableQuotaRefreshingSnapshotFixture(): DashboardUiState =
    ledgerUnavailableQuotaSnapshotFixture().copy(
        loadingMode = DashboardLoadingMode.Refreshing
    )

internal fun ledgerLoginRequiredQuotaSnapshotFixture(): DashboardUiState =
    ledgerQuotaProviderStateFixture(
        status = QuotaProviderStatus.AuthRequired,
        reasonCode = "local_authorization_required"
    )

internal fun ledgerEmptyQuotaSnapshotFixture(): DashboardUiState {
    val base = ledgerFreshQuotaSnapshotFixture()
    val quota = base.quota as QuotaUiState.Available
    return base.copy(
        quota = quota.copy(snapshot = quota.snapshot.copy(providers = emptyList()))
    )
}

private fun ledgerQuotaProviderStateFixture(
    status: QuotaProviderStatus,
    reasonCode: String
): DashboardUiState {
    val base = ledgerFreshQuotaSnapshotFixture()
    val quota = base.quota as QuotaUiState.Available
    val provider = quota.snapshot.providers.first().copy(
        status = status,
        windows = emptyList(),
        reasonCode = reasonCode
    )
    return base.copy(
        quota = quota.copy(snapshot = quota.snapshot.copy(providers = listOf(provider)))
    )
}

private fun ledgerHeatmapFixture(): Map<String, Long> = (0 until 84).associate { index ->
    val date = java.time.LocalDate.of(2026, 7, 15).minusDays((83 - index).toLong())
    val tokens = if (index % 9 == 0) 0L else ((index * 73L + index % 5 * 41L) % 1_900L + 80L) * 1_000L
    date.toString() to tokens
}

private fun ledgerHistoryFixture(): List<LogHistoryItem> = listOf(
    LogHistoryItem(101, "codex", "gpt-5", 132_000, 52_000, 44_000, 6_000, 2.84, "2026-07-15T12:42:00+08:00", "session-101", "MacBook-Pro", 18),
    LogHistoryItem(102, "claude", "claude-opus-4", 116_000, 46_000, 38_000, 5_000, 2.37, "2026-07-15T12:18:00+08:00", "session-102", "MacBook-Pro", 15),
    LogHistoryItem(103, "minimax", "MiniMax-M2", 102_000, 45_000, 31_000, 4_000, 1.66, "2026-07-15T11:56:00+08:00", "session-103", "Windows-Workstation", 12),
    LogHistoryItem(104, "opencode", "qwen3-coder", 88_000, 38_000, 24_000, 3_000, 1.22, "2026-07-15T11:31:00+08:00", "session-104", "Windows-Workstation", 10)
)

@Composable
internal fun LowPowerDisplayPreviewHost(
    appearance: LedgerAppearance,
    ambientMode: AmbientMode = AmbientMode.Console,
    tokenDisplayMode: TokenDisplayMode = TokenDisplayMode.Effective,
    state: DashboardUiState = ledgerSnapshotFixture().copy(lowPowerDisplayVisible = true)
) {
    TokenLedgerTheme(appearance) {
        ProvideLedgerPalette(appearance) {
            // 预览统一钉一个"此刻"：额度的新鲜/过期与重置倒计时全由 now 裁决，
            // 读墙上时钟会让同一份夹具随日历漂移（见 [LEDGER_PREVIEW_NOW]）。
            CompositionLocalProvider(LocalLedgerNow provides { LEDGER_PREVIEW_NOW }) {
                LowPowerDisplayScreen(
                    state = state,
                    appearance = appearance,
                    tokenDisplayMode = tokenDisplayMode,
                    ambientMode = ambientMode,
                    policyOverride = resolveLowPowerPolicy(
                        mode = ambientMode,
                        powerSaveMode = false,
                        thermalStatus = 0,
                        systemAnimationsEnabled = true
                    )
                )
            }
        }
    }
}

private fun ledgerQuotaFixture(): QuotaUiState.Available {
    val observedAt = "2026-07-15T12:40:00+08:00"
    val evaluatedAt = java.time.OffsetDateTime.parse("2026-07-15T12:41:00+08:00")
        .toInstant()
        .toEpochMilli()
    fun window(
        providerId: String,
        windowId: String,
        label: String,
        used: Double,
        remaining: Double,
        windowMinutes: Int,
        resetsAt: String
    ) = QuotaWindowSnapshot(
        providerId = providerId,
        windowId = windowId,
        windowLabel = label,
        scope = QuotaScope.ConsumerSubscription,
        source = QuotaSource.LocalAuthorized,
        status = QuotaWindowStatus.Ok,
        used = used,
        limit = 100.0,
        remaining = remaining,
        unit = QuotaUnit.Percent,
        windowMinutes = windowMinutes,
        resetsAt = resetsAt,
        observedAt = observedAt,
        fetchedAt = observedAt,
        staleAfterSeconds = 300,
        reasonCode = null
    )
    fun provider(id: String, displayName: String, windows: List<QuotaWindowSnapshot>) =
        QuotaProviderEnvelope(
            schemaVersion = 1,
            providerId = id,
            displayName = displayName,
            scope = QuotaScope.ConsumerSubscription,
            mode = QuotaMode.Automatic,
            capability = QuotaCapability.PlanDependent,
            status = QuotaProviderStatus.Ok,
            windows = windows,
            reasonCode = null
        )
    val providers = listOf(
        provider(
            id = "claude-code",
            displayName = "Claude",
            windows = listOf(
                window("claude-code", "five-hour", "5 小时窗口", 28.0, 72.0, 300, "2026-07-15T15:00:00+08:00"),
                window("claude-code", "seven-day", "7 天窗口", 48.0, 52.0, 10_080, "2026-07-20T00:00:00+08:00")
            )
        ),
        provider(
            id = "codex-app-server",
            displayName = "Codex",
            windows = listOf(
                window("codex-app-server", "five-hour", "5 小时窗口", 43.0, 57.0, 300, "2026-07-15T15:00:00+08:00"),
                window("codex-app-server", "seven-day", "7 天窗口", 62.0, 38.0, 10_080, "2026-07-20T00:00:00+08:00")
            )
        )
    )
    return QuotaUiState.Available(
        snapshot = QuotaTransportSnapshot(
            transportVersion = QUOTA_TRANSPORT_VERSION,
            epoch = 7,
            revision = 12,
            generatedAt = "2026-07-15T12:40:05+08:00",
            providers = providers
        ),
        showingCachedData = false,
        savedAtEpochMillis = evaluatedAt,
        evaluatedAtEpochMillis = evaluatedAt
    )
}

private fun ledgerSnapshotSummary(): Summary = Summary(
    totalTokens = 1_280_000,
    inputTokens = 920_000,
    outputTokens = 360_000,
    cachedTokens = 248_400,
    cacheReadTokens = 216_400,
    cacheWriteTokens = 32_000,
    totalCost = 18.397,
    totalRequests = 3_127,
    avgTokensPerReq = 409
)

private fun ledgerSnapshotComparison(
    range: RangeKey,
    currentSummary: Summary
): UsageComparison? = when (range) {
    RangeKey.Today -> alignedPreviewComparison(
        currentSummary = currentSummary,
        kind = "dayOverDay",
        bucket = "hour",
        currentStart = "2026-07-15T00:00:00+08:00",
        currentEnd = "2026-07-15T12:41:00+08:00",
        previousStart = "2026-07-14T00:00:00+08:00",
        previousEnd = "2026-07-14T12:41:00+08:00",
        currentBuckets = (0..12).map { "${it.toString().padStart(2, '0')}:00" },
        currentTokens = listOf(
            72_000L, 84_000L, 90_000L, 88_000L, 96_000L,
            102_000L, 98_000L, 110_000L, 106_000L, 104_000L,
            112_000L, 108_000L, 110_000L
        ),
        previousBuckets = (0..12).map { "${it.toString().padStart(2, '0')}:00" },
        previousTokens = listOf(
            65_000L, 72_000L, 78_000L, 76_000L, 84_000L,
            90_000L, 86_000L, 98_000L, 94_000L, 92_000L,
            102_000L, 98_000L, 104_000L
        )
    )

    RangeKey.Week -> alignedPreviewComparison(
        currentSummary = currentSummary,
        kind = "weekOverWeek",
        currentStart = "2026-07-13T00:00:00+08:00",
        currentEnd = "2026-07-15T12:41:00+08:00",
        previousStart = "2026-07-06T00:00:00+08:00",
        previousEnd = "2026-07-08T12:41:00+08:00",
        currentBuckets = listOf("2026-07-13", "2026-07-14", "2026-07-15"),
        currentTokens = listOf(390_000L, 450_000L, 440_000L),
        previousBuckets = listOf("2026-07-06", "2026-07-07", "2026-07-08"),
        previousTokens = listOf(350_000L, 409_000L, 380_000L)
    )

    RangeKey.Month -> alignedPreviewComparison(
        currentSummary = currentSummary,
        kind = "monthOverMonth",
        currentStart = "2026-07-01T00:00:00+08:00",
        currentEnd = "2026-07-15T12:41:00+08:00",
        previousStart = "2026-06-01T00:00:00+08:00",
        previousEnd = "2026-06-15T12:41:00+08:00",
        currentBuckets = (1..15).map { "2026-07-${it.toString().padStart(2, '0')}" },
        currentTokens = listOf(
            70_000L, 74_000L, 78_000L, 82_000L, 86_000L,
            90_000L, 84_000L, 88_000L, 92_000L, 96_000L,
            90_000L, 86_000L, 94_000L, 90_000L, 80_000L
        ),
        previousBuckets = (1..15).map { "2026-06-${it.toString().padStart(2, '0')}" },
        previousTokens = listOf(
            60_000L, 64_000L, 68_000L, 72_000L, 76_000L,
            80_000L, 74_000L, 78_000L, 82_000L, 86_000L,
            80_000L, 76_000L, 84_000L, 80_000L, 79_000L
        )
    )

    RangeKey.Year, RangeKey.All, RangeKey.Custom -> null
}

private fun alignedPreviewComparison(
    currentSummary: Summary,
    kind: String,
    bucket: String = "day",
    currentStart: String,
    currentEnd: String,
    previousStart: String,
    previousEnd: String,
    currentBuckets: List<String>,
    currentTokens: List<Long>,
    previousBuckets: List<String>,
    previousTokens: List<Long>
): UsageComparison {
    val current = previewComparisonPeriod(
        buckets = currentBuckets,
        tokens = currentTokens,
        summary = currentSummary
    )
    val previous = previewComparisonPeriod(
        buckets = previousBuckets,
        tokens = previousTokens,
        summary = Summary(
            totalTokens = 1_139_000,
            inputTokens = 810_000,
            outputTokens = 329_000,
            cachedTokens = 219_000,
            cacheReadTokens = 190_000,
            cacheWriteTokens = 29_000,
            totalCost = 16.357,
            totalRequests = 2_779,
            avgTokensPerReq = 409
        )
    )
    return UsageComparison(
        window = ComparisonWindow(
            kind = kind,
            timezone = "Asia/Shanghai",
            bucket = bucket,
            currentStart = currentStart,
            currentEnd = currentEnd,
            previousStart = previousStart,
            previousEnd = previousEnd,
            alignedThrough = currentEnd
        ),
        current = current,
        previous = previous,
        delta = ComparisonDelta(
            tokens = previewMetricDelta(
                current.summary.effectiveTokens.toDouble(),
                previous.summary.effectiveTokens.toDouble()
            ),
            requests = previewMetricDelta(
                current.summary.totalRequests.toDouble(),
                previous.summary.totalRequests.toDouble()
            ),
            cost = previewMetricDelta(current.summary.totalCost, previous.summary.totalCost)
        )
    )
}

private fun previewComparisonPeriod(
    buckets: List<String>,
    tokens: List<Long>,
    summary: Summary
): ComparisonPeriod {
    require(buckets.size == tokens.size && tokens.isNotEmpty())
    val totalTokens = tokens.sum()
    require(totalTokens == summary.totalTokens)
    require(totalTokens == summary.effectiveTokens)
    require(summary.cachedTokens == summary.cacheReadTokens + summary.cacheWriteTokens)

    var assignedRequests = 0L
    var assignedCost = 0.0
    val series = tokens.mapIndexed { index, tokenCount ->
        val isLast = index == tokens.lastIndex
        val requests = if (isLast) {
            summary.totalRequests - assignedRequests
        } else {
            (summary.totalRequests.toDouble() * tokenCount / totalTokens)
                .roundToLong()
                .coerceAtMost(summary.totalRequests - assignedRequests)
        }
        val cost = if (isLast) {
            summary.totalCost - assignedCost
        } else {
            summary.totalCost * tokenCount / totalTokens
        }
        assignedRequests += requests
        assignedCost += cost
        ComparisonSeriesPoint(buckets[index], tokenCount, requests, cost)
    }

    return ComparisonPeriod(
        summary = summary,
        series = series
    )
}

private fun previewMetricDelta(current: Double, previous: Double): MetricDelta {
    val absolute = current - previous
    val direction = when {
        previous == 0.0 && current > 0.0 -> "new"
        absolute > 0.0 -> "up"
        absolute < 0.0 -> "down"
        else -> "flat"
    }
    return MetricDelta(
        absolute = absolute,
        percent = if (previous == 0.0) null else absolute / previous * 100.0,
        direction = direction
    )
}
