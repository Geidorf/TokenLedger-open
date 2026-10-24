package com.jeidorf.tokenledger.mobile.ui.onboarding

import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.Summary
import com.jeidorf.tokenledger.mobile.ui.me.V2MeWallpaperState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class V2OnboardingModelsTest {
    private val fresh = V2OnboardingFacts(
        signedIn = true,
        desktopData = false,
        machineCount = 0,
        wallpaper = V2MeWallpaperState.Available,
        placedWidgets = 0,
        canPinWidget = true
    )

    private fun step(facts: V2OnboardingFacts, id: V2OnboardingStepId) = v2OnboardingSteps(facts).single { it.id == id }

    @Test
    fun freshAccountOnlyHasLoginDone() {
        val steps = v2OnboardingSteps(fresh)
        assertEquals(
            listOf(V2OnboardingStepId.Account, V2OnboardingStepId.DesktopSync, V2OnboardingStepId.Wallpaper, V2OnboardingStepId.Widget),
            steps.map { it.id }
        )
        assertEquals(1, steps.doneCount())
        assertEquals(V2OnboardingAction.Recheck, step(fresh, V2OnboardingStepId.DesktopSync).action)
        assertEquals(V2OnboardingAction.SetWallpaper, step(fresh, V2OnboardingStepId.Wallpaper).action)
        assertEquals(V2OnboardingAction.AddWidget, step(fresh, V2OnboardingStepId.Widget).action)
    }

    @Test
    fun desktopStepPointsAtTheDesktopCloudSyncSetting() {
        val desktop = step(fresh, V2OnboardingStepId.DesktopSync)
        assertEquals(V2OnboardingStatus.Todo, desktop.status)
        assertTrue(desktop.detail.contains("设置 › 云端同步"))
        assertEquals(V2OnboardingStatus.Unknown, step(fresh.copy(desktopData = null), V2OnboardingStepId.DesktopSync).status)
        val synced = step(fresh.copy(desktopData = true, machineCount = 2), V2OnboardingStepId.DesktopSync)
        assertEquals(V2OnboardingStatus.Done, synced.status)
        assertEquals("已收到 2 台设备的用量。", synced.detail)
        assertNull(synced.action)
    }

    @Test
    fun wallpaperFollowsTheSystemState() {
        assertEquals(
            V2OnboardingStatus.Blocked,
            step(fresh.copy(wallpaper = V2MeWallpaperState.Unavailable), V2OnboardingStepId.Wallpaper).status
        )
        val active = step(fresh.copy(wallpaper = V2MeWallpaperState.Active), V2OnboardingStepId.Wallpaper)
        assertEquals(V2OnboardingStatus.Done, active.status)
        assertNull(active.action)
        // 壁纸只是显示端，桌面还得打开路由同步，说明里要讲清去哪开。
        assertTrue(step(fresh, V2OnboardingStepId.Wallpaper).detail.contains("把实时路由同步到手机"))
    }

    @Test
    fun widgetWithoutPinSupportExplainsTheLauncherPath() {
        val manual = step(fresh.copy(canPinWidget = false), V2OnboardingStepId.Widget)
        assertEquals(V2OnboardingStatus.Todo, manual.status)
        assertNull(manual.action)
        assertTrue(manual.detail.contains("长按"))
        assertEquals(V2OnboardingStatus.Done, step(fresh.copy(placedWidgets = 3), V2OnboardingStepId.Widget).status)
    }

    @Test
    fun allDoneCountsFour() {
        val done = fresh.copy(desktopData = true, wallpaper = V2MeWallpaperState.Active, placedWidgets = 1)
        assertEquals(4, v2OnboardingSteps(done).doneCount())
    }

    @Test
    fun noStepPromisesKeysOrDirectWebDav() {
        val text = v2OnboardingSteps(fresh).joinToString { it.detail }
        assertTrue(text.contains("不保存服务商密钥"))
        assertTrue(text.contains("不直连 WebDAV"))
    }

    @Test
    fun guideOpensOnItsOwnOnlyOnAFreshAccountThatNeverSawIt() {
        assertTrue(v2ShouldAutoOpenGuide(null, desktopData = false))
        assertFalse(v2ShouldAutoOpenGuide(null, desktopData = true))
        assertFalse(v2ShouldAutoOpenGuide(null, desktopData = null))
        assertFalse(v2ShouldAutoOpenGuide(V2OnboardingVisibility.Dismissed, desktopData = false))
        assertFalse(v2ShouldAutoOpenGuide(V2OnboardingVisibility.Completed, desktopData = false))
    }

    @Test
    fun newAccountZeroStatsCountAsNoDesktopData() {
        val empty = StatsData(
            summary = Summary(),
            tools = emptyMap(),
            models = emptyMap(),
            trends = emptyList(),
            heatmap = emptyMap(),
            history = emptyList(),
            machines = emptyList(),
            meta = null
        )
        assertNull(v2HasDesktopData(null, filtered = false))
        assertEquals(false, v2HasDesktopData(empty, filtered = false))
        // 带筛选时只是筛空了，不当成新账户。
        assertEquals(true, v2HasDesktopData(empty, filtered = true))
        assertEquals(true, v2HasDesktopData(empty.copy(machines = listOf("mac-a")), filtered = false))
        assertEquals(true, v2HasDesktopData(empty.copy(summary = Summary(totalRequests = 3)), filtered = false))
    }
}
