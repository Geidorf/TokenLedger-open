package com.jeidorf.tokenledger.mobile.ui.me

import com.jeidorf.tokenledger.mobile.DashboardSessionState
import com.jeidorf.tokenledger.mobile.DashboardUiState
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** 「我的」一级页里的页面：根列表，以及从「待机屏 / 墨水屏」进入的摆件预览子页。 */
internal enum class V2MePage { Root, Standby }

/** 账号卡要显示的内容。名字取邮箱 @ 前一段，头像取它的第一个字。 */
internal data class V2MeAccount(
    val title: String,
    val initial: String,
    val status: String,
    val signedIn: Boolean
)

internal fun v2MeAccount(state: DashboardUiState): V2MeAccount {
    val machineCount = state.visibleData?.machines?.size ?: 0
    return when (val session = state.sessionState) {
        is DashboardSessionState.Authenticated -> {
            val email = session.session.email.trim()
            val name = email.substringBefore('@').ifBlank { email }.ifBlank { "已登录" }
            V2MeAccount(
                title = name,
                initial = name.first().uppercase(),
                status = if (machineCount > 0) "已登录 · $machineCount 台设备" else "已登录",
                signedIn = true
            )
        }
        is DashboardSessionState.Expired -> V2MeAccount("会话已过期", "!", session.message, signedIn = false)
        DashboardSessionState.Restoring -> V2MeAccount("正在恢复登录", "…", "稍候", signedIn = false)
        DashboardSessionState.SignedOut -> V2MeAccount("未登录", "?", "登录后读取桌面端同步的数据", signedIn = false)
    }
}

/** 同步行的状态色：正常、离线快照、没有数据。只用来挑圆点颜色，文字自己说清。 */
internal enum class V2MeSyncTone { Ok, Stale, Missing }

internal data class V2MeSync(val summary: String, val tone: V2MeSyncTone)

/**
 * 云端同步行的副文字。手机只读云端，「同步」说的是最后一次从云端拿到数据是什么时候，
 * 不替顶栏改口：离线时照实说在看哪一刻的快照。
 */
internal fun v2MeSync(state: DashboardUiState, now: Instant, zone: ZoneId = ZoneId.systemDefault()): V2MeSync {
    val updated = state.lastUpdatedEpochMillis?.let(Instant::ofEpochMilli)
    return when {
        state.visibleData == null && state.dashboardLoading -> V2MeSync("正在读取", V2MeSyncTone.Missing)
        // 没有缓存可显示的失败（离线、服务端出错）要照实说，不能说成桌面端还没同步。
        state.visibleData == null && state.userVisibleError != null ->
            V2MeSync("同步失败 · ${state.userVisibleError}", V2MeSyncTone.Stale)
        state.visibleData == null -> V2MeSync("还没有同步数据", V2MeSyncTone.Missing)
        state.showingCachedData || state.error != null ->
            V2MeSync("离线 · 显示${updated?.let { " " + v2MeAgo(it, now, zone) } ?: "缓存"}的数据", V2MeSyncTone.Stale)
        updated == null -> V2MeSync("已连接", V2MeSyncTone.Ok)
        else -> V2MeSync("已同步 · ${v2MeAgo(updated, now, zone)}", V2MeSyncTone.Ok)
    }
}

/** 「刚刚 / 5 分钟前 / 3 小时前」，超过一天给日期时间。 */
internal fun v2MeAgo(at: Instant, now: Instant, zone: ZoneId = ZoneId.systemDefault()): String {
    val seconds = now.epochSecond - at.epochSecond
    return when {
        seconds < 60 -> "刚刚"
        seconds < 3600 -> "${seconds / 60} 分钟前"
        seconds < 86_400 -> "${seconds / 3600} 小时前"
        else -> DateTimeFormatter.ofPattern("M-d HH:mm").withZone(zone).format(at)
    }
}

/** 锁屏动态壁纸入口的三种情况：本 App 还没带壁纸服务、带了但没在用、正在用。 */
internal enum class V2MeWallpaperState { Unavailable, Available, Active }

internal fun v2MeWallpaperMeta(state: V2MeWallpaperState): String = when (state) {
    V2MeWallpaperState.Unavailable -> "网关动画 · 即将推出"
    V2MeWallpaperState.Available -> "网关动画 · 省电时降帧"
    V2MeWallpaperState.Active -> "使用中 · 省电时降帧"
}

internal fun v2MeWallpaperValue(state: V2MeWallpaperState): String = when (state) {
    V2MeWallpaperState.Unavailable -> "准备中"
    V2MeWallpaperState.Available -> "设置"
    V2MeWallpaperState.Active -> "已开启"
}

/** 小组件行右侧：放了几个就写几个，没放就提示去添加。 */
internal fun v2MeWidgetValue(placed: Int): String = if (placed > 0) "$placed 个" else "添加"
