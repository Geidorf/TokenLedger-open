package com.jeidorf.tokenledger.mobile.coordinator

import com.jeidorf.tokenledger.mobile.CalendarHeatmapUiState
import com.jeidorf.tokenledger.mobile.ContributionMode
import com.jeidorf.tokenledger.mobile.DashboardEntity
import com.jeidorf.tokenledger.mobile.DashboardNavigationSnapshot
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.DashboardQueryContract
import com.jeidorf.tokenledger.mobile.DashboardSection
import com.jeidorf.tokenledger.mobile.DashboardTimeProvider
import com.jeidorf.tokenledger.mobile.DashboardUiError
import com.jeidorf.tokenledger.mobile.InsightCalendarDateEligibility
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TrendDrillContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

internal data class DrillDownState(
    val entity: DashboardEntity? = null,
    val section: DashboardSection = DashboardSection.Overview,
    val contributionMode: ContributionMode = ContributionMode.Tools,
    val navigationStack: List<DashboardNavigationSnapshot> = emptyList(),
    val dayReviewReturn: DashboardNavigationSnapshot? = null
)

internal data class DayReviewSourceSnapshot(
    val stats: StatsData,
    val lastUpdatedEpochMillis: Long?,
    val showingCachedData: Boolean
)

internal class DrillDownCoordinator(
    private val timeProvider: DashboardTimeProvider,
    private val onError: (DashboardUiError) -> Unit = {}
) {
    private val _state = MutableStateFlow(DrillDownState())
    val drillDownState: StateFlow<DrillDownState> = _state.asStateFlow()

    private var dayReviewSourceSnapshot: DayReviewSourceSnapshot? = null

    fun currentState(): DrillDownState = _state.value

    fun currentDayReviewSource(): DayReviewSourceSnapshot? = dayReviewSourceSnapshot

    fun clearDayReviewSource() {
        dayReviewSourceSnapshot = null
    }

    fun selectSection(section: DashboardSection, onRestoreFromDayReview: () -> Unit) {
        if (section == DashboardSection.Entity || _state.value.section == section) return
        if (section != DashboardSection.Details && _state.value.dayReviewReturn != null) {
            onRestoreFromDayReview()
        }
        _state.update { it.copy(section = section) }
    }

    fun selectContributionMode(mode: ContributionMode) {
        _state.update { it.copy(contributionMode = mode) }
    }

    fun openTool(
        tool: String,
        currentQuery: DashboardQuery,
        hasSession: Boolean,
        onNavigate: (DashboardQuery, DashboardEntity, List<DashboardNavigationSnapshot>) -> Unit
    ) {
        openEntity(tool = tool, model = null, currentQuery = currentQuery, hasSession = hasSession, onNavigate = onNavigate)
    }

    fun openModel(
        model: String,
        currentQuery: DashboardQuery,
        hasSession: Boolean,
        onNavigate: (DashboardQuery, DashboardEntity, List<DashboardNavigationSnapshot>) -> Unit
    ) {
        val currentTool = currentQuery.tool.takeIf { _state.value.section == DashboardSection.Entity }
        openEntity(tool = currentTool, model = model, currentQuery = currentQuery, hasSession = hasSession, onNavigate = onNavigate)
    }

    private fun openEntity(
        tool: String?,
        model: String?,
        currentQuery: DashboardQuery,
        hasSession: Boolean,
        onNavigate: (DashboardQuery, DashboardEntity, List<DashboardNavigationSnapshot>) -> Unit
    ) {
        if (!hasSession) return
        val currentEntity = _state.value.entity
        val targetEntity = DashboardQueryContract.normalizeEntity(
            if (model != null) {
                DashboardEntity(DashboardEntity.MODEL, model)
            } else {
                DashboardEntity(DashboardEntity.TOOL, requireNotNull(tool))
            }
        )
        val contextTools = if (
            targetEntity.kind == DashboardEntity.MODEL &&
            currentEntity?.kind == DashboardEntity.TOOL
        ) {
            DashboardQueryContract.normalizeValues(
                "tools",
                currentQuery.tools + currentEntity.id
            )
        } else {
            currentQuery.tools
        }
        val entityQuery = currentQuery.withFilters(
            tools = if (targetEntity.kind == DashboardEntity.TOOL) emptyList() else contextTools,
            models = if (targetEntity.kind == DashboardEntity.MODEL) emptyList() else currentQuery.models,
            compatibilityToolSelector = targetEntity.id.takeIf {
                targetEntity.kind == DashboardEntity.TOOL
            },
            compatibilityModelSelector = targetEntity.id.takeIf {
                targetEntity.kind == DashboardEntity.MODEL
            }
        )
        val snapshot = DashboardNavigationSnapshot(
            query = currentQuery,
            entity = _state.value.entity,
            section = _state.value.section,
            contributionMode = _state.value.contributionMode
        )
        val newStack = _state.value.navigationStack + snapshot
        _state.update {
            it.copy(
                entity = targetEntity,
                section = DashboardSection.Entity,
                navigationStack = newStack
            )
        }
        onNavigate(entityQuery, targetEntity, newStack)
    }

    fun openTrendBucket(
        bucket: String,
        targetSection: DashboardSection,
        currentQuery: DashboardQuery,
        visibleData: StatsData?,
        calendarHeatmap: CalendarHeatmapUiState,
        lastUpdatedEpochMillis: Long?,
        showingCachedData: Boolean,
        hasSession: Boolean,
        customRangeQueryResolver: (DashboardQuery, String, String) -> DashboardQuery?,
        onExecuteDayDrill: (DashboardQuery) -> Unit
    ): Boolean {
        if (!hasSession) return false
        if (targetSection != DashboardSection.Contributions && targetSection != DashboardSection.Details) {
            return false
        }
        val originQuery = _state.value.dayReviewReturn?.query ?: currentQuery
        val responseZone = visibleData?.comparison?.window?.timezone
            ?: visibleData?.entityDashboard?.comparison?.window?.timezone
            ?: visibleData?.meta?.timezone
            ?: timeProvider.timezoneId()
        val zone = runCatching { ZoneId.of(responseZone) }.getOrElse { ZoneId.of("UTC") }
        val referenceDate = Instant.ofEpochMilli(timeProvider.nowEpochMillis()).atZone(zone).toLocalDate()
        val context = TrendDrillContext.fromBucket(
            bucket = bucket,
            originQuery = originQuery,
            referenceDate = referenceDate,
            responseZone = zone,
            targetSection = targetSection
        ) ?: run {
            onError(DashboardUiError.Unexpected("无法从该趋势时段确定可查询的日期"))
            return false
        }
        val currentEnd = visibleData?.comparison?.window?.currentEnd
            ?.let { TrendDrillContext.dateFromCurrentEnd(it, zone) }
            ?: visibleData?.entityDashboard?.comparison?.window?.currentEnd
                ?.let { TrendDrillContext.dateFromCurrentEnd(it, zone) }
            ?: referenceDate
        if (!TrendDrillContext.isWithinCurrentQuery(context.date, originQuery, currentEnd)) {
            onError(DashboardUiError.Unexpected("该趋势日期不在当前可信查询范围内"))
            return false
        }
        return openDayDetails(
            date = context.date.toString(),
            targetSection = context.targetSection,
            trustedTrendDate = true,
            currentQuery = currentQuery,
            visibleData = visibleData,
            calendarHeatmap = calendarHeatmap,
            lastUpdatedEpochMillis = lastUpdatedEpochMillis,
            showingCachedData = showingCachedData,
            hasSession = hasSession,
            customRangeQueryResolver = customRangeQueryResolver,
            onExecuteDayDrill = onExecuteDayDrill
        )
    }

    fun openDayDetails(
        date: String,
        targetSection: DashboardSection,
        trustedTrendDate: Boolean,
        currentQuery: DashboardQuery,
        visibleData: StatsData?,
        calendarHeatmap: CalendarHeatmapUiState,
        lastUpdatedEpochMillis: Long?,
        showingCachedData: Boolean,
        hasSession: Boolean,
        customRangeQueryResolver: (DashboardQuery, String, String) -> DashboardQuery?,
        onExecuteDayDrill: (DashboardQuery) -> Unit
    ): Boolean {
        if (!hasSession) return false
        val snapshot = _state.value.dayReviewReturn ?: DashboardNavigationSnapshot(
            query = currentQuery,
            entity = _state.value.entity,
            section = _state.value.section,
            contributionMode = _state.value.contributionMode
        )
        val selectedDate = runCatching { LocalDate.parse(date) }.getOrNull()
        val calendar = calendarHeatmap as? CalendarHeatmapUiState.Available
        val eligibility = if (
            selectedDate != null &&
            calendar != null &&
            calendar.selectionQuery == snapshot.query
        ) {
            val coverageStart = runCatching { LocalDate.parse(calendar.coverageStart) }.getOrNull()
            val coverageEnd = runCatching { LocalDate.parse(calendar.coverageEnd) }.getOrNull()
            InsightCalendarDateEligibility(
                selectable = coverageStart != null && coverageEnd != null &&
                    selectedDate in coverageStart..coverageEnd,
                unavailableReason = "日期不在当前可信覆盖范围内"
            )
        } else null
        if (selectedDate == null || (!trustedTrendDate && (eligibility == null || !eligibility.selectable))) {
            onError(
                DashboardUiError.Unexpected(
                    eligibility?.unavailableReason ?: "该日期不在当前可信统计范围内"
                )
            )
            return false
        }
        val query = customRangeQueryResolver(snapshot.query, date, date) ?: return false
        if (_state.value.dayReviewReturn == null && visibleData != null) {
            dayReviewSourceSnapshot = DayReviewSourceSnapshot(
                visibleData, lastUpdatedEpochMillis, showingCachedData
            )
        }
        _state.update {
            it.copy(
                entity = snapshot.entity,
                section = targetSection,
                contributionMode = snapshot.contributionMode,
                dayReviewReturn = snapshot
            )
        }
        onExecuteDayDrill(query)
        return true
    }

    fun restoreGlobalQueryFromDayReview(
        onRestore: (DashboardNavigationSnapshot, DayReviewSourceSnapshot?) -> Unit
    ): Boolean {
        val destination = _state.value.dayReviewReturn ?: return false
        val source = dayReviewSourceSnapshot
        dayReviewSourceSnapshot = null
        _state.update {
            it.copy(
                section = destination.section,
                entity = destination.entity,
                contributionMode = destination.contributionMode,
                dayReviewReturn = null
            )
        }
        onRestore(destination, source)
        return true
    }

    fun navigateBack(
        onRestoreFromDayReview: () -> Unit,
        onNavigateBackToSnapshot: (DashboardNavigationSnapshot) -> Unit
    ) {
        if (_state.value.dayReviewReturn != null) {
            onRestoreFromDayReview()
            return
        }
        val destination = _state.value.navigationStack.lastOrNull() ?: return
        val newStack = _state.value.navigationStack.dropLast(1)
        _state.update {
            it.copy(
                entity = destination.entity,
                section = destination.section,
                contributionMode = destination.contributionMode,
                navigationStack = newStack
            )
        }
        onNavigateBackToSnapshot(destination)
    }

    fun resetState() {
        dayReviewSourceSnapshot = null
        _state.value = DrillDownState()
    }
}
