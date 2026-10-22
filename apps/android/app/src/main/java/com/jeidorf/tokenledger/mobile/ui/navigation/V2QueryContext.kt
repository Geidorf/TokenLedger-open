package com.jeidorf.tokenledger.mobile.ui.navigation

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.dashboardQuerySummary
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE

@Composable
internal fun V2QueryContext(
    palette: MobileV2Palette,
    query: DashboardQuery,
    onClear: () -> Unit,
    onFilter: () -> Unit
) {
    var expanded by rememberSaveable(query) { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp).heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            dashboardQuerySummary(query),
            color = palette.muted,
            fontSize = LedgerFont.caption,
            maxLines = if (expanded) Int.MAX_VALUE else 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .heightIn(min = 48.dp)
                .wrapContentHeight()
                .clickable(
                    role = Role.Button,
                    onClickLabel = if (expanded) "收起查询条件" else "展开完整查询条件"
                ) { expanded = !expanded }
                .semantics {
                    contentDescription = dashboardQuerySummary(query)
                    liveRegion = LiveRegionMode.Polite
                }
        )
        IconButton(onClick = onFilter) {
            Icon(Icons.Default.FilterList, "调整查询筛选", tint = palette.blue)
        }
        if (query.hasFilters) {
            IconButton(onClick = onClear) {
                Icon(Icons.Default.Close, "清除搜索和来源筛选", tint = palette.muted)
            }
        }
    }
}

@Composable
internal fun V2FilterButton(
    palette: MobileV2Palette,
    query: DashboardQuery,
    onClick: () -> Unit
) {
    val label = when {
        query.machines.size == 1 -> query.machines.single()
        query.machines.size > 1 -> "${query.machines.size} 台设备"
        else -> "全部设备"
    }
    val sourceFilterCount = query.tools.size + query.models.size
    val accessibilityDescription = buildString {
        append("筛选，$label")
        if (sourceFilterCount > 0) append("，$sourceFilterCount 个来源筛选")
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(13.dp))
            .background(palette.surface)
            .clickable(
                role = Role.Button,
                onClickLabel = "打开筛选",
                onClick = onClick
            )
            .semantics(mergeDescendants = true) {
                contentDescription = accessibilityDescription
            }
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(Icons.Default.FilterList, contentDescription = null, tint = palette.text, modifier = Modifier.size(V2_ICON_INLINE))
        Spacer(Modifier.width(8.dp))
        Text(label, color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        if (sourceFilterCount > 0) {
            Text("$sourceFilterCount 个来源筛选", color = palette.faint, fontSize = LedgerFont.caption)
            Spacer(Modifier.width(8.dp))
        }
        Text("筛选", color = palette.blue, fontSize = LedgerFont.caption)
    }
}
