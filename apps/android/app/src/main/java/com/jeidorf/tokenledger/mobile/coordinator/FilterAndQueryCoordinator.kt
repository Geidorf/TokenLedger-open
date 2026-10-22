package com.jeidorf.tokenledger.mobile.coordinator

import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.DashboardQueryContract
import com.jeidorf.tokenledger.mobile.DashboardQueryContractException
import com.jeidorf.tokenledger.mobile.DashboardUiError
import com.jeidorf.tokenledger.mobile.RangeKey
import java.util.Locale
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

internal enum class FilterDimension { Machine, Tool, Model }

internal fun DashboardQuery.withFilters(
    machines: List<String> = this.machines,
    tools: List<String> = this.tools,
    models: List<String> = this.models,
    search: String? = this.search,
    compatibilityToolSelector: String? = this.compatibilityToolSelector,
    compatibilityModelSelector: String? = this.compatibilityModelSelector
): DashboardQuery = DashboardQuery(
    range = range,
    machines = machines,
    tools = tools,
    models = models,
    search = search,
    tokenMode = tokenMode,
    compatibilityToolSelector = compatibilityToolSelector,
    compatibilityModelSelector = compatibilityModelSelector
)

internal fun List<String>.toggle(value: String): List<String> =
    if (value in this) filterNot { it == value } else this + value

internal class FilterAndQueryCoordinator(
    initialQuery: DashboardQuery = DashboardQuery(),
    private val onQueryChanged: (DashboardQuery) -> Unit = {},
    private val onError: (DashboardUiError) -> Unit = {}
) {
    private val _query = MutableStateFlow(initialQuery)
    val queryState: StateFlow<DashboardQuery> = _query.asStateFlow()

    /** 会话边界只重置事实源，不启动旧会话请求。 */
    fun reset() {
        _query.value = DashboardQuery()
    }

    fun currentQuery(): DashboardQuery = _query.value

    fun setQueryDirectly(query: DashboardQuery) {
        _query.value = query
    }

    fun selectRange(range: RangeKey, hasSession: Boolean) {
        if (!hasSession) return
        val current = _query.value
        if (current.range == range || range == RangeKey.Custom) return
        updateQuery(current.copy(range = range, start = null, end = null))
    }

    fun selectCustomRange(start: String, end: String, hasSession: Boolean): DashboardQuery? {
        if (!hasSession) return null
        val current = _query.value
        val query = customRangeQueryOrReport(current, start, end) ?: return null
        if (current == query) return null
        updateQuery(query)
        return query
    }

    fun customRangeQueryOrReport(
        sourceQuery: DashboardQuery,
        start: String,
        end: String
    ): DashboardQuery? = try {
        DashboardQueryContract.normalize(
            sourceQuery.copy(range = RangeKey.Custom, start = start, end = end)
        )
    } catch (error: DashboardQueryContractException) {
        onError(DashboardUiError.Unexpected(error.message ?: "自定义日期范围无效"))
        null
    }

    fun selectMachine(machine: String, hasSession: Boolean) {
        if (!hasSession) return
        val normalized = DashboardQueryContract.legacyMachineValues(machine)
        val current = _query.value
        if (current.machines == normalized) return
        updateQuery(current.withFilters(machines = normalized))
    }

    fun toggleMachine(machine: String, hasSession: Boolean) {
        toggleFilterValue(FilterDimension.Machine, machine, hasSession)
    }

    fun selectTool(tool: String?, hasSession: Boolean) {
        if (!hasSession) return
        val normalized = DashboardQueryContract.legacyOptionalValues("tools", tool)
        val current = _query.value
        if (current.tools == normalized) return
        updateQuery(current.withFilters(tools = normalized))
    }

    fun toggleTool(tool: String, hasSession: Boolean) {
        toggleFilterValue(FilterDimension.Tool, tool, hasSession)
    }

    fun selectModel(model: String?, hasSession: Boolean) {
        if (!hasSession) return
        val normalized = DashboardQueryContract.legacyOptionalValues("models", model)
        val current = _query.value
        if (current.models == normalized) return
        updateQuery(current.withFilters(models = normalized))
    }

    fun toggleModel(model: String, hasSession: Boolean) {
        toggleFilterValue(FilterDimension.Model, model, hasSession)
    }

    fun setSearch(search: String?, hasSession: Boolean) {
        if (!hasSession) return
        val normalized = try {
            DashboardQueryContract.normalizeSearch(search)
        } catch (error: DashboardQueryContractException) {
            onError(DashboardUiError.Unexpected(error.message ?: "搜索条件无效"))
            return
        }
        val current = _query.value
        if (current.search == normalized) return
        updateQuery(current.withFilters(search = normalized))
    }

    fun clearFilters(hasSession: Boolean) {
        val current = _query.value
        if (!hasSession || !current.hasFilters) return
        updateQuery(
            current.withFilters(
                machines = emptyList(),
                tools = emptyList(),
                models = emptyList(),
                search = null
            )
        )
    }

    fun updateQuery(query: DashboardQuery) {
        val normalized = try {
            DashboardQueryContract.normalize(query)
        } catch (error: DashboardQueryContractException) {
            onError(DashboardUiError.Unexpected(error.message ?: "筛选条件无效"))
            return
        }
        _query.value = normalized
        onQueryChanged(normalized)
    }

    private fun toggleFilterValue(dimension: FilterDimension, rawValue: String, hasSession: Boolean) {
        if (!hasSession) return
        val value = try {
            DashboardQueryContract.normalizeItem(dimension.name.lowercase(Locale.ROOT), rawValue)
        } catch (error: DashboardQueryContractException) {
            onError(DashboardUiError.Unexpected(error.message ?: "筛选条件无效"))
            return
        }
        val current = _query.value
        val query = when (dimension) {
            FilterDimension.Machine -> current.withFilters(
                machines = current.queryMachinesToggle(value)
            )
            FilterDimension.Tool -> current.withFilters(
                tools = current.tools.toggle(value),
                compatibilityToolSelector = null
            )
            FilterDimension.Model -> current.withFilters(
                models = current.models.toggle(value),
                compatibilityModelSelector = null
            )
        }
        updateQuery(query)
    }

    private fun DashboardQuery.queryMachinesToggle(value: String): List<String> =
        machines.toggle(value)
}
