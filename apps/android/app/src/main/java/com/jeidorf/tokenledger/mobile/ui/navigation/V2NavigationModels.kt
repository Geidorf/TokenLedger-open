package com.jeidorf.tokenledger.mobile.ui.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ShowChart
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.TableRows
import androidx.compose.ui.graphics.vector.ImageVector
import com.jeidorf.tokenledger.mobile.DashboardSection

/**
 * 一级分区（重构方案 v1/v2，对齐参考设计的窄屏分区）：
 * 用量（概览 · 趋势 · 来源 · 日历 · 请求）、路由（网关动画）、额度、我的（同步与展示）。
 */
internal enum class MobileDestination(val label: String, val icon: ImageVector) {
    Usage("用量", LedgerNavIcons.Usage),
    Routing("路由", LedgerNavIcons.Routing),
    Quota("额度", LedgerNavIcons.Quota),
    Me("我的", LedgerNavIcons.Me)
}

/** 「用量」下的子页；原「今日」成了概览，原「明细」对齐桌面端改叫「请求」。 */
internal enum class InsightPane(val label: String, val icon: ImageVector) {
    Overview("概览", Icons.Default.Dashboard),
    Trend("趋势", Icons.AutoMirrored.Filled.ShowChart),
    Sources("来源", Icons.Default.BarChart),
    Calendar("日历", Icons.Default.CalendarMonth),
    Details("请求", Icons.Default.TableRows)
}

internal enum class TodayReviewAction(val label: String, val targetPane: InsightPane?) {
    ExplainChange("查看趋势", InsightPane.Trend)
}

internal data class V2NavigationSelection(
    val destination: MobileDestination,
    val insightPane: InsightPane
) {
    fun openInsight(next: InsightPane): V2NavigationSelection = copy(
        destination = MobileDestination.Usage,
        insightPane = next
    )

}

internal fun InsightPane.dashboardSection(): DashboardSection = when (this) {
    InsightPane.Overview -> DashboardSection.Overview
    InsightPane.Trend, InsightPane.Calendar -> DashboardSection.Trends
    InsightPane.Sources -> DashboardSection.Contributions
    InsightPane.Details -> DashboardSection.Details
}

internal fun MobileDestination.dashboardSection(insightPane: InsightPane): DashboardSection? = when (this) {
    MobileDestination.Usage -> insightPane.dashboardSection()
    MobileDestination.Routing, MobileDestination.Quota, MobileDestination.Me -> null
}
