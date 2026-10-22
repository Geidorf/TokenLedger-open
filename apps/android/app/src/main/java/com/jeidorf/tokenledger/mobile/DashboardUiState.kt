package com.jeidorf.tokenledger.mobile

/** Lifecycle-owned authentication state. Auth expiry is intentionally distinct from a network error. */
sealed interface DashboardSessionState {
    data object Restoring : DashboardSessionState

    data object SignedOut : DashboardSessionState

    data class Authenticated(val session: MobileSession) : DashboardSessionState

    data class Expired(
        val message: String = "会话已过期，请重新登录"
    ) : DashboardSessionState
}

enum class DashboardLoadingMode {
    RestoringSession,
    SigningIn,
    InitialLoad,
    Refreshing,
    Idle
}

enum class DashboardSection {
    Overview,
    Trends,
    Details,
    Contributions,
    Settings,
    Entity
}

enum class ContributionMode { Tools, Models }

data class DashboardNavigationSnapshot(
    val query: DashboardQuery,
    val entity: DashboardEntity? = null,
    val section: DashboardSection,
    val contributionMode: ContributionMode
)

data class DashboardQuery(
    val range: RangeKey = RangeKey.Today,
    val start: String? = null,
    val end: String? = null,
    val machines: List<String> = emptyList(),
    val tools: List<String> = emptyList(),
    val models: List<String> = emptyList(),
    val search: String? = null,
    val tokenMode: String = EFFECTIVE_TOKEN_MODE,
    internal val compatibilityToolSelector: String? = null,
    internal val compatibilityModelSelector: String? = null
) {
    /** Compatibility constructor for old Kotlin callers; new producers use plural fields only. */
    constructor(
        range: RangeKey = RangeKey.Today,
        machine: String,
        tool: String? = null,
        model: String? = null
    ) : this(
        range = range,
        machines = DashboardQueryContract.legacyMachineValues(machine),
        tools = DashboardQueryContract.legacyOptionalValues("tools", tool),
        models = DashboardQueryContract.legacyOptionalValues("models", model)
    )

    val machine: String
        get() = machines.singleOrNull() ?: ALL_MACHINES

    val tool: String?
        get() = compatibilityToolSelector ?: tools.singleOrNull()

    val model: String?
        get() = compatibilityModelSelector ?: models.singleOrNull()

    val hasFilters: Boolean
        get() = machines.isNotEmpty() || tools.isNotEmpty() || models.isNotEmpty() || search != null

    companion object {
        const val ALL_MACHINES = "all_cloud"
    }
}

sealed interface DashboardUiError {
    val message: String

    data class Network(override val message: String) : DashboardUiError

    data class Unexpected(override val message: String) : DashboardUiError
}

sealed interface QuotaUiState {
    data object Loading : QuotaUiState

    data class Unsynced(
        val message: String = "尚未从桌面端同步额度快照"
    ) : QuotaUiState

    data class Available(
        val snapshot: QuotaTransportSnapshot,
        val showingCachedData: Boolean,
        val savedAtEpochMillis: Long,
        val evaluatedAtEpochMillis: Long,
        val refreshing: Boolean = false,
        val warning: String? = null
    ) : QuotaUiState

    data class Unavailable(
        val message: String
    ) : QuotaUiState
}

sealed interface CalendarHeatmapUiState {
    data object Idle : CalendarHeatmapUiState

    data class Loading(
        val query: DashboardQuery,
        val selectionQuery: DashboardQuery
    ) : CalendarHeatmapUiState

    data class Available(
        val heatmap: Map<String, Long>,
        val query: DashboardQuery,
        val selectionQuery: DashboardQuery,
        val timezone: String,
        val generatedAt: String?,
        val coverageStart: String,
        val coverageEnd: String,
        val showingCachedData: Boolean,
        val warning: String? = null
    ) : CalendarHeatmapUiState

    data class Unavailable(
        val query: DashboardQuery,
        val message: String
    ) : CalendarHeatmapUiState
}

data class DashboardUiState(
    val configured: Boolean,
    val sessionState: DashboardSessionState = DashboardSessionState.Restoring,
    val query: DashboardQuery = DashboardQuery(),
    val data: StatsData? = null,
    val cachedData: StatsData? = null,
    val loadingMode: DashboardLoadingMode = DashboardLoadingMode.RestoringSession,
    val error: DashboardUiError? = null,
    val lastUpdatedEpochMillis: Long? = null,
    val showingCachedData: Boolean = false,
    val section: DashboardSection = DashboardSection.Overview,
    val contributionMode: ContributionMode = ContributionMode.Tools,
    val entity: DashboardEntity? = null,
    val navigationStack: List<DashboardNavigationSnapshot> = emptyList(),
    val dayReviewReturn: DashboardNavigationSnapshot? = null,
    val loadingMore: Boolean = false,
    val paginationError: String? = null,
    val calendarHeatmap: CalendarHeatmapUiState = CalendarHeatmapUiState.Idle,
    val quota: QuotaUiState = QuotaUiState.Unsynced(),
    val lowPowerDisplayVisible: Boolean = false,
    val dailyQuote: DailyQuoteSnapshot? = null
) {
    val session: MobileSession?
        get() = (sessionState as? DashboardSessionState.Authenticated)?.session

    val visibleData: StatsData?
        get() = data ?: cachedData

    val dashboardLoading: Boolean
        get() = loadingMode == DashboardLoadingMode.InitialLoad ||
            loadingMode == DashboardLoadingMode.Refreshing

    val loginLoading: Boolean
        get() = loadingMode == DashboardLoadingMode.SigningIn

    val userVisibleError: String?
        get() = when (val currentSession = sessionState) {
            is DashboardSessionState.Expired -> currentSession.message
            else -> error?.message
        }

    val hasActiveFilters: Boolean
        get() = query.hasFilters

    val quotaSnapshot: QuotaTransportSnapshot?
        get() = (quota as? QuotaUiState.Available)?.snapshot
}

class DashboardAuthExpiredException(cause: Throwable? = null) :
    IllegalStateException("Session expired", cause)
