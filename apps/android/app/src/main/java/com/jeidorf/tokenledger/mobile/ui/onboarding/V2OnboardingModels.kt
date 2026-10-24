package com.jeidorf.tokenledger.mobile.ui.onboarding

import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.ui.me.V2MeWallpaperState

/**
 * 首次启动引导的四步，口径与桌面端引导一致：桌面那边是「扫描 / 网关 / 云端同步 / 手机壁纸」，
 * 手机这边接着最后两步往下走——登录同一账户、等桌面完成云端同步、设锁屏壁纸、放桌面小组件。
 *
 * 每一步的状态都从已有事实推出来，不另存进度：登录态、统计里有没有桌面数据、系统当前壁纸、
 * 桌面上放了几个小组件。手机只读云端，不保存服务商密钥，也不直连 WebDAV。
 */
internal enum class V2OnboardingStepId { Account, DesktopSync, Wallpaper, Widget }

/**
 * - [Done]：这一步不用再做。
 * - [Todo]：现在就能做（有没有按钮看 [V2OnboardingStep.action]）。
 * - [Blocked]：本机做不了（例如这个版本没带壁纸服务）。
 * - [Unknown]：事实还没读到，不给按钮。
 */
internal enum class V2OnboardingStatus { Done, Todo, Blocked, Unknown }

/** 步骤按钮做的事，由界面映射到具体回调。 */
internal enum class V2OnboardingAction { Recheck, SetWallpaper, AddWidget }

internal data class V2OnboardingStep(
    val id: V2OnboardingStepId,
    val title: String,
    val status: V2OnboardingStatus,
    val detail: String,
    val action: V2OnboardingAction? = null,
    val actionLabel: String? = null
)

internal data class V2OnboardingFacts(
    val signedIn: Boolean,
    /** 桌面端有没有同步过数据；null 表示统计还没读到。 */
    val desktopData: Boolean?,
    /** 云端看到的设备数，只用来写说明。 */
    val machineCount: Int,
    val wallpaper: V2MeWallpaperState,
    val placedWidgets: Int,
    val canPinWidget: Boolean
)

/**
 * 云端有没有桌面端同步来的数据。新账户的统计照样返回一份全零的结果，所以不能只看是否为 null：
 * 设备表空、请求数为 0 才算「一次都没同步过」。带筛选时可能只是筛空了，不算。
 */
internal fun v2HasDesktopData(stats: StatsData?, filtered: Boolean): Boolean? = when {
    stats == null -> null
    filtered -> true
    else -> stats.machines.isNotEmpty() || stats.summary.totalRequests > 0L || stats.summary.totalTokens > 0L
}

/** 系统那边的事实：壁纸、已放的小组件、桌面能不能应用内固定。每次回到前台重读。 */
internal data class V2DeviceFacts(
    val wallpaper: V2MeWallpaperState = V2MeWallpaperState.Unavailable,
    val placedWidgets: Int = 0,
    val canPinWidget: Boolean = false
)

/** 看板当前这一帧有没有桌面数据。统计没读到、不在读、也没出错，就是云端什么都没有。 */
internal fun v2DesktopData(state: DashboardUiState, stats: StatsData?): Boolean? =
    if (stats == null && !state.dashboardLoading && state.error == null) false
    else v2HasDesktopData(stats, state.hasActiveFilters)

internal fun v2OnboardingFacts(state: DashboardUiState, stats: StatsData?, device: V2DeviceFacts) = V2OnboardingFacts(
    signedIn = state.session != null,
    desktopData = v2DesktopData(state, stats),
    machineCount = stats?.machines?.size ?: 0,
    wallpaper = device.wallpaper,
    placedWidgets = device.placedWidgets,
    canPinWidget = device.canPinWidget
)

internal fun v2OnboardingSteps(facts: V2OnboardingFacts): List<V2OnboardingStep> =
    listOf(accountStep(facts), desktopStep(facts), wallpaperStep(facts), widgetStep(facts))

internal fun List<V2OnboardingStep>.doneCount(): Int = count { it.status == V2OnboardingStatus.Done }

private fun accountStep(facts: V2OnboardingFacts) = if (facts.signedIn) {
    V2OnboardingStep(
        V2OnboardingStepId.Account, "登录同一个账户", V2OnboardingStatus.Done,
        "已登录。手机只读云端汇总，不保存服务商密钥，也不直连 WebDAV。"
    )
} else {
    V2OnboardingStep(
        V2OnboardingStepId.Account, "登录同一个账户", V2OnboardingStatus.Todo,
        "用电脑上 TokenLedger 云端同步的那个账户登录。"
    )
}

private fun desktopStep(facts: V2OnboardingFacts): V2OnboardingStep {
    val title = "在桌面开启云端同步"
    return when (facts.desktopData) {
        null -> V2OnboardingStep(V2OnboardingStepId.DesktopSync, title, V2OnboardingStatus.Unknown, "正在读取云端数据…")
        true -> V2OnboardingStep(
            V2OnboardingStepId.DesktopSync, title, V2OnboardingStatus.Done,
            if (facts.machineCount > 0) "已收到 ${facts.machineCount} 台设备的用量。" else "已收到桌面端同步的用量。"
        )
        false -> V2OnboardingStep(
            V2OnboardingStepId.DesktopSync, title, V2OnboardingStatus.Todo,
            "在电脑上打开 TokenLedger，到「设置 › 云端同步」登录同一个账户并完成首次同步，" +
                "用量就会出现在这里。",
            V2OnboardingAction.Recheck, "重新检查"
        )
    }
}

private fun wallpaperStep(facts: V2OnboardingFacts): V2OnboardingStep {
    val title = "设置锁屏动态壁纸"
    return when (facts.wallpaper) {
        V2MeWallpaperState.Unavailable -> V2OnboardingStep(
            V2OnboardingStepId.Wallpaper, title, V2OnboardingStatus.Blocked,
            "这个版本还没有带锁屏动态壁纸。"
        )
        V2MeWallpaperState.Active -> V2OnboardingStep(
            V2OnboardingStepId.Wallpaper, title, V2OnboardingStatus.Done,
            "锁屏正在显示网关路由动画。桌面需在「设置 › 桌面挂件」打开「把实时路由同步到手机」。"
        )
        V2MeWallpaperState.Available -> V2OnboardingStep(
            V2OnboardingStepId.Wallpaper, title, V2OnboardingStatus.Todo,
            "锁屏显示网关的近实时路由动画。桌面还要在「设置 › 桌面挂件」打开「把实时路由同步到手机」。",
            V2OnboardingAction.SetWallpaper, "设为壁纸"
        )
    }
}

private fun widgetStep(facts: V2OnboardingFacts): V2OnboardingStep {
    val title = "添加桌面小组件"
    return when {
        facts.placedWidgets > 0 -> V2OnboardingStep(
            V2OnboardingStepId.Widget, title, V2OnboardingStatus.Done,
            "桌面上已有 ${facts.placedWidgets} 个小组件。"
        )
        facts.canPinWidget -> V2OnboardingStep(
            V2OnboardingStepId.Widget, title, V2OnboardingStatus.Todo,
            "今日用量、额度、综合看板，不打开应用也能一眼看到。",
            V2OnboardingAction.AddWidget, "添加"
        )
        else -> V2OnboardingStep(
            V2OnboardingStepId.Widget, title, V2OnboardingStatus.Todo,
            "这台手机的桌面不支持应用内添加：在桌面长按空白处，选「小组件」里的 TokenLedger。"
        )
    }
}

/** 引导在这台手机上的去留。没有记录表示从没出现过。 */
internal enum class V2OnboardingVisibility { Dismissed, Completed }

/**
 * 只在从没见过引导、且云端一次桌面数据都没有时自动打开，和桌面端「本机账本为空才弹」一致：
 * 已经在用的人不会被打断，想看可以从「我的 › 接入步骤」打开。
 */
internal fun v2ShouldAutoOpenGuide(stored: V2OnboardingVisibility?, desktopData: Boolean?): Boolean =
    stored == null && desktopData == false
