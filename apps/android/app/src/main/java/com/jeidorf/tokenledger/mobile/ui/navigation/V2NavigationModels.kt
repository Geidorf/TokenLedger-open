package com.jeidorf.tokenledger.mobile.ui.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ShowChart
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Insights
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.TableRows
import androidx.compose.material.icons.filled.Widgets
import androidx.compose.ui.graphics.vector.ImageVector
import com.jeidorf.tokenledger.mobile.DashboardSection

internal enum class MobileDestination(val label: String, val icon: ImageVector) {
    Overview("今日", Icons.Default.Dashboard),
    Insights("复盘", Icons.Default.Insights),
    Quota("额度", Icons.Default.Speed),
    Widget("展示", Icons.Default.Widgets)
}

internal enum class InsightPane(val label: String, val icon: ImageVector) {
    Trend("趋势", Icons.AutoMirrored.Filled.ShowChart),
    Sources("来源", Icons.Default.BarChart),
    Calendar("日历", Icons.Default.CalendarMonth),
    Details("明细", Icons.Default.TableRows)
}

internal enum class TodayReviewAction(val label: String, val targetPane: InsightPane?) {
    ExplainChange("查看趋势", InsightPane.Trend)
}

internal data class V2NavigationSelection(
    val destination: MobileDestination,
    val insightPane: InsightPane
) {
    fun openInsight(next: InsightPane): V2NavigationSelection = copy(
        destination = MobileDestination.Insights,
        insightPane = next
    )

}

internal fun InsightPane.dashboardSection(): DashboardSection = when (this) {
    InsightPane.Trend, InsightPane.Calendar -> DashboardSection.Trends
    InsightPane.Sources -> DashboardSection.Contributions
    InsightPane.Details -> DashboardSection.Details
}

internal fun MobileDestination.dashboardSection(insightPane: InsightPane): DashboardSection? = when (this) {
    MobileDestination.Overview -> DashboardSection.Overview
    MobileDestination.Insights -> insightPane.dashboardSection()
    MobileDestination.Quota, MobileDestination.Widget -> null
}
