package com.jeidorf.tokenledger.mobile.ui.me

import com.jeidorf.tokenledger.mobile.DashboardSessionState
import com.jeidorf.tokenledger.mobile.DashboardUiError
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.MobileSession
import java.time.Instant
import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class V2MeModelsTest {
    private val now = Instant.parse("2026-09-07T04:00:00Z")
    private val signedIn = DashboardUiState(
        configured = true,
        sessionState = DashboardSessionState.Authenticated(
            MobileSession("a", "r", "u", "jamie.doe@example.com", Long.MAX_VALUE)
        )
    )

    @Test
    fun accountUsesEmailLocalPartAndItsInitial() {
        val account = v2MeAccount(signedIn)
        assertEquals("jamie.doe", account.title)
        assertEquals("J", account.initial)
        assertEquals("已登录", account.status)
        assertTrue(account.signedIn)
    }

    @Test
    fun signedOutAndExpiredAccountsSayWhatIsWrong() {
        assertFalse(v2MeAccount(signedIn.copy(sessionState = DashboardSessionState.SignedOut)).signedIn)
        val expired = v2MeAccount(signedIn.copy(sessionState = DashboardSessionState.Expired()))
        assertEquals("会话已过期", expired.title)
        assertEquals("会话已过期，请重新登录", expired.status)
    }

    @Test
    fun syncWithoutDataIsMissingNotOk() {
        assertEquals(V2MeSyncTone.Missing, v2MeSync(signedIn, now).tone)
        assertEquals("还没有同步数据", v2MeSync(signedIn, now).summary)
    }

    @Test
    fun failedFirstSyncSaysWhyInsteadOfNoData() {
        val failed = signedIn.copy(error = DashboardUiError.Network("网络不可用"))
        assertEquals(V2MeSync("同步失败 · 网络不可用", V2MeSyncTone.Stale), v2MeSync(failed, now))
    }

    @Test
    fun agoBucketsMinutesHoursThenDate() {
        assertEquals("刚刚", v2MeAgo(now.minusSeconds(30), now))
        assertEquals("5 分钟前", v2MeAgo(now.minusSeconds(5 * 60), now))
        assertEquals("3 小时前", v2MeAgo(now.minusSeconds(3 * 3600), now))
        assertEquals("9-5 04:00", v2MeAgo(now.minusSeconds(2 * 86_400), now, ZoneOffset.UTC))
    }

    @Test
    fun wallpaperEntryIsHonestBeforeTheServiceShips() {
        assertEquals("准备中", v2MeWallpaperValue(V2MeWallpaperState.Unavailable))
        assertEquals("网关动画 · 即将推出", v2MeWallpaperMeta(V2MeWallpaperState.Unavailable))
        assertEquals("设置", v2MeWallpaperValue(V2MeWallpaperState.Available))
        assertEquals("网关动画 · 省电时降帧", v2MeWallpaperMeta(V2MeWallpaperState.Available))
        assertEquals("已开启", v2MeWallpaperValue(V2MeWallpaperState.Active))
        assertEquals("使用中 · 省电时降帧", v2MeWallpaperMeta(V2MeWallpaperState.Active))
    }

    @Test
    fun widgetValueCountsPlacedInstances() {
        assertEquals("添加", v2MeWidgetValue(0))
        assertEquals("3 个", v2MeWidgetValue(3))
    }
}
