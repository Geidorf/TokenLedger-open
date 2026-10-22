package com.jeidorf.tokenledger.mobile.ui.controls

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.FilterOption
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_CONTROL_HEIGHT
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_TEXT
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette

internal enum class V2FilterSheet { All }

@Composable
internal fun V2FilterSheetContent(
    palette: MobileV2Palette,
    state: DashboardUiState,
    displayedStats: StatsData?,
    onMachineChange: (String) -> Unit,
    onToolChange: (String?) -> Unit,
    onModelChange: (String?) -> Unit,
    onClearFilters: () -> Unit,
    onDone: () -> Unit
) {
    val options = v2FilterOptions(displayedStats, state.query)
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            "筛选看板",
            color = palette.text,
            fontSize = LedgerFont.title,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.semantics { heading() }
        )
        Text("对趋势、明细、日历与下钻同时生效", color = palette.muted, fontSize = LedgerFont.caption)
        V2ChoiceSection(
            palette,
            "设备",
            options.machines,
            state.query.machines.toSet(),
            onSelect = { value -> onMachineChange(value) },
            allValue = DashboardQuery.ALL_MACHINES
        )
        V2ChoiceSection(
            palette,
            "工具",
            options.tools,
            state.query.tools.toSet(),
            onSelect = { onToolChange(it) }
        )
        V2ChoiceSection(
            palette,
            "模型",
            options.models,
            state.query.models.toSet(),
            onSelect = { onModelChange(it) }
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(
                onClick = onClearFilters,
                modifier = Modifier.weight(1f).heightIn(min = V2_CONTROL_HEIGHT),
                border = BorderStroke(1.dp, palette.divider)
            ) { Text("清除", color = palette.text) }
            Button(
                onClick = onDone,
                modifier = Modifier.weight(1f).heightIn(min = V2_CONTROL_HEIGHT),
                colors = ButtonDefaults.buttonColors(containerColor = palette.blue, contentColor = palette.onBlue)
            ) { Text("完成") }
        }
    }
}

@Composable
internal fun V2FilterSheetPreviewContent(
    appearance: LedgerAppearance,
    state: DashboardUiState,
    displayedStats: StatsData? = state.visibleData
) {
    val palette = remember(appearance) { v2Palette(appearance) }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.background.copy(alpha = 0.55f)),
        contentAlignment = Alignment.BottomCenter
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
            color = palette.raised,
            contentColor = palette.text
        ) {
            V2FilterSheetContent(
                palette = palette,
                state = state,
                displayedStats = displayedStats,
                onMachineChange = {},
                onToolChange = {},
                onModelChange = {},
                onClearFilters = {},
                onDone = {}
            )
        }
    }
}

internal data class V2FilterOptions(
    val machines: List<Pair<String, String>>,
    val tools: List<Pair<String, String>>,
    val models: List<Pair<String, String>>
)

internal fun v2FilterOptions(stats: StatsData?, query: DashboardQuery = DashboardQuery()): V2FilterOptions {
    val facets = stats?.detailsPage?.availableFilters
    fun options(facet: List<FilterOption>?, fallback: Collection<String>, selected: List<String>) =
        (facet.orEmpty().map { it.value } + fallback + selected).distinct().sorted().map { it to it }
    return V2FilterOptions(
        machines = listOf(DashboardQuery.ALL_MACHINES to "全部设备") +
            options(facets?.machines, stats?.machines.orEmpty(), query.machines),
        tools = options(facets?.tools, stats?.tools?.keys.orEmpty(), query.tools),
        models = options(facets?.models, stats?.models?.keys.orEmpty(), query.models)
    )
}

@Composable
internal fun V2ChoiceSection(
    palette: MobileV2Palette,
    title: String,
    options: List<Pair<String, String>>,
    selected: Set<String>,
    onSelect: (String) -> Unit,
    allValue: String? = null
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            title,
            color = palette.text,
            fontWeight = FontWeight.SemiBold,
            fontSize = LedgerFont.label,
            modifier = Modifier.weight(1f).semantics { heading() }
        )
        if (options.size > 2) {
            Text("横向查看更多", color = palette.muted, fontSize = LedgerFont.caption)
            Icon(
                Icons.Default.ChevronRight,
                contentDescription = null,
                tint = palette.muted,
                modifier = Modifier.size(V2_ICON_TEXT)
            )
        }
    }
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.take(32).forEach { (value, label) ->
            val active = if (value == allValue) selected.isEmpty() else value in selected
            FilterChip(
                selected = active,
                onClick = { onSelect(value) },
                label = {
                    Text(
                        label,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                },
                modifier = Modifier.heightIn(min = 48.dp).widthIn(max = 180.dp)
            )
        }
    }
}
