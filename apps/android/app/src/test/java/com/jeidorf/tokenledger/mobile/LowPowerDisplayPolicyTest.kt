package com.jeidorf.tokenledger.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LowPowerDisplayPolicyTest {
    @Test
    fun healthyDisplayAllowsLowFrequencyMotionButNeverBackgroundRefresh() {
        val healthy = resolveLowPowerPolicy(AmbientMode.Console, false, 0, true)
        assertTrue(healthy.allowMotion)
        listOf(
            resolveLowPowerPolicy(AmbientMode.Console, true, 0, true),
            resolveLowPowerPolicy(AmbientMode.Console, false, LOW_POWER_THERMAL_MODERATE, true),
            resolveLowPowerPolicy(AmbientMode.Console, false, 0, false)
        ).forEach { policy ->
            assertFalse(policy.allowMotion)
        }
        listOf(
            healthy,
            resolveLowPowerPolicy(AmbientMode.Console, true, 0, true),
            resolveLowPowerPolicy(AmbientMode.Ledger, false, 0, true),
            resolveLowPowerPolicy(AmbientMode.Console, false, LOW_POWER_THERMAL_MODERATE, true),
            resolveLowPowerPolicy(AmbientMode.Console, false, 0, false)
        ).forEach { policy ->
            assertFalse(policy.allowBackgroundRefresh)
            assertTrue(policy.keepScreenOn)
            assertTrue(policy.hideStatusBar)
        }
    }

    @Test
    fun systemConstraintsReduceSecondaryDetails() {
        val normal = resolveLowPowerPolicy(AmbientMode.Console, false, 0, true)
        assertFalse(normal.compactDetails)
        assertEquals(4, normal.visibleQuotaWindowLimit)

        listOf(
            resolveLowPowerPolicy(AmbientMode.Console, true, 0, true),
            resolveLowPowerPolicy(AmbientMode.Console, false, LOW_POWER_THERMAL_MODERATE, true),
            resolveLowPowerPolicy(AmbientMode.Console, false, 0, false)
        ).forEach { policy ->
            assertTrue(policy.compactDetails)
            assertEquals(2, policy.visibleQuotaWindowLimit)
        }
    }

    /**
     * 回归：旧实现把 `appearance == EInk` 当成设备受限信号，于是用户仅仅在一台健康手机上
     * 选了墨水屏**配色**，额度窗口就被从 4 个悄悄砍到 2 个。配色不是约束。
     */
    @Test
    fun choosingTheEInkPaletteOnAHealthyDeviceDoesNotThrottleAnything() {
        val healthy = resolveLowPowerPolicy(
            mode = AmbientMode.Console,
            powerSaveMode = false,
            thermalStatus = 0,
            systemAnimationsEnabled = true
        )
        // 策略函数根本不再接受 appearance 参数，因此"选墨水屏配色"在这一层是不可表达的。
        // 能构造出的唯一 Console + 健康设备结果就是满额度预算。
        assertFalse(healthy.compactDetails)
        assertEquals(4, healthy.visibleQuotaWindowLimit)
    }

    /**
     * 设备受限时可以少画装饰，但**策略层**不得反过来收窄额度预算（审计 A2）。
     *
     * 注意这里断言的是预算，不是最终画了几个。额度墙改成大号半环仪表盘网格后，能画几格
     * 由版面几何决定（横屏 3×2、竖屏 2×2），超出部分在卡上明写"另有 N 个未显示"——这是
     * 版面上限，不是策略静默截断。"一个都不漏"的承诺由墨水日报的 QuotaBoard 兑现。
     */
    @Test
    fun ledgerModeNeverTruncatesWindowsEvenUnderEveryDeviceConstraint() {
        val mode = AmbientMode.Ledger
        listOf(
            resolveLowPowerPolicy(mode, false, 0, true),
            resolveLowPowerPolicy(mode, true, 0, true),
            resolveLowPowerPolicy(mode, false, LOW_POWER_THERMAL_MODERATE, true),
            resolveLowPowerPolicy(mode, true, LOW_POWER_THERMAL_MODERATE, false)
        ).forEach { policy ->
            assertEquals(
                "$mode 必须完整展示所有额度窗口",
                Int.MAX_VALUE,
                policy.visibleQuotaWindowLimit
            )
        }
    }

    @Test
    fun quotaWallAlwaysKeepsOnePrimaryWindowPerProvider() {
        listOf(
            resolveLowPowerPolicy(AmbientMode.QuotaWall, false, 0, true),
            resolveLowPowerPolicy(AmbientMode.QuotaWall, true, 0, true),
            resolveLowPowerPolicy(AmbientMode.QuotaWall, false, LOW_POWER_THERMAL_MODERATE, false)
        ).forEach { policy ->
            assertEquals(Int.MAX_VALUE, policy.visibleQuotaWindowLimit)
        }
    }

    /** 不显示额度的档不该为额度留预算，也不该因此被算成"受限"。 */
    @Test
    fun modesWithoutQuotaAskForNoQuotaBudget() {
        listOf(AmbientMode.Glance, AmbientMode.Pulse).forEach { mode ->
            assertFalse(mode.showsQuota)
            assertEquals(0, resolveLowPowerPolicy(mode, false, 0, true).visibleQuotaWindowLimit)
            assertEquals(0, resolveLowPowerPolicy(mode, true, 0, true).visibleQuotaWindowLimit)
        }
    }

    /** 受限只影响装饰密度，不影响"屏幕常亮"这一摆件的根本前提。 */
    @Test
    fun constraintsCompactDetailsButNeverReleaseTheScreen() {
        AmbientMode.entries.forEach { mode ->
            val constrained = resolveLowPowerPolicy(mode, true, LOW_POWER_THERMAL_MODERATE, false)
            assertTrue("$mode 受限时应压缩次要信息", constrained.compactDetails)
            assertTrue("$mode 摆件必须保持常亮", constrained.keepScreenOn)
        }
    }
}
