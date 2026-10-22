package com.jeidorf.tokenledger.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * T10.130：额度条的颜色此前是 `if (status == Ok) blue else amber`——那说的是
 * 「这个来源能不能读到数」，不是「还剩多少」，于是 3% 剩余和 95% 剩余同样画成蓝色，
 * 「快用完了」在界面上没有任何视觉权重。
 *
 * T10.152（D4）：阈值统一为剩余 <20% 告急、<50% 偏紧（严格小于），与桌面
 * `src/utils/quotaOverview.ts` 的 `quotaLevel`、Android 小组件 `widgetAvailabilityBand`
 * （WidgetCycling.kt）三端一致；档位文案同步桌面挂件 `QUOTA_STATE_LABELS`
 * （充足/偏紧/告急）。此前本档位与 T10.79 原型 `AndroidDashboardPrototype.tsx` 的
 * `quotaSeverity`（15/40）逐字一致，`tests/frontend-contracts.test.mjs` 分别钉住
 * 两侧；本次只统一了 Kotlin 这一侧（含本文件与该测试文件里对 LedgerUiLogic.kt 的
 * 正则断言），原型与它自己的断言仍是旧值，不在本任务范围（见 T10.152 任务日志）。
 */
class QuotaSeverityTest {
    @Test
    fun thresholdsMatchTheUnifiedThreeSurfaceScale() {
        assertEquals(QuotaSeverity.Healthy, quotaSeverity(100.0))
        assertEquals(QuotaSeverity.Healthy, quotaSeverity(72.0))
        assertEquals(QuotaSeverity.Healthy, quotaSeverity(50.0))
        assertEquals(QuotaSeverity.Warning, quotaSeverity(49.0))
        assertEquals(QuotaSeverity.Warning, quotaSeverity(20.0))
        assertEquals(QuotaSeverity.Critical, quotaSeverity(19.0))
        assertEquals(QuotaSeverity.Critical, quotaSeverity(0.0))
    }

    /** 边界落在档位的下沿：50 属于充足，20 属于偏紧。写清楚免得后来人改成 <=。 */
    @Test
    fun boundariesBelongToTheHigherTier() {
        assertEquals(QuotaSeverity.Healthy, quotaSeverity(50.0))
        assertEquals(QuotaSeverity.Warning, quotaSeverity(49.9))
        assertEquals(QuotaSeverity.Warning, quotaSeverity(20.0))
        assertEquals(QuotaSeverity.Critical, quotaSeverity(19.9))
    }

    /** 0/100 与略微越界（负值/超过 100）的极端输入不应落错档位。 */
    @Test
    fun extremeInputsStayInBounds() {
        assertEquals(QuotaSeverity.Critical, quotaSeverity(0.0))
        assertEquals(QuotaSeverity.Healthy, quotaSeverity(100.0))
        assertEquals(QuotaSeverity.Critical, quotaSeverity(-20.0))
        assertEquals(QuotaSeverity.Healthy, quotaSeverity(120.0))
    }

    @Test
    fun fractionEntryPointClampsAndAgrees() {
        assertEquals(QuotaSeverity.Healthy, quotaSeverityForFraction(1f))
        assertEquals(QuotaSeverity.Healthy, quotaSeverityForFraction(2f))
        assertEquals(QuotaSeverity.Healthy, quotaSeverityForFraction(0.5f))
        assertEquals(QuotaSeverity.Warning, quotaSeverityForFraction(0.49f))
        assertEquals(QuotaSeverity.Warning, quotaSeverityForFraction(0.2f))
        assertEquals(QuotaSeverity.Critical, quotaSeverityForFraction(0.19f))
        assertEquals(QuotaSeverity.Critical, quotaSeverityForFraction(0f))
        assertEquals(QuotaSeverity.Critical, quotaSeverityForFraction(-1f))
    }

    /**
     * T10.207（A-Q2）：档位跟着**显示的整数**走，与桌面 `readQuotaWindow` 相同——可用 =
     * 100 − round(已用)。剩余 0.499 显示「可用 50%」，就属于充足；此前按未取整的 49.9 判成
     * 偏紧，数字说 50% 颜色却是偏紧。Float 的表示误差（0.495f 实为 0.49500000476…）先
     * 吸收到 5 位小数再取整，否则已用 50.5 会被算成 50.4999995 而少进一位。
     */
    @Test
    fun fractionBandFollowsTheDisplayedIntegerLikeDesktop() {
        assertEquals(QuotaSeverity.Healthy, quotaSeverityForFraction(0.499f)) // 已用 50.1 → 可用 50
        assertEquals(QuotaSeverity.Healthy, quotaSeverityForFraction(0.505f)) // 已用 49.5 → 可用 50
        assertEquals(QuotaSeverity.Warning, quotaSeverityForFraction(0.495f)) // 已用 50.5 → 可用 49
        assertEquals(QuotaSeverity.Warning, quotaSeverityForFraction(0.199f)) // 已用 80.1 → 可用 20
        assertEquals(QuotaSeverity.Warning, quotaSeverityForFraction(0.205f)) // 已用 79.5 → 可用 20
        assertEquals(QuotaSeverity.Critical, quotaSeverityForFraction(0.195f)) // 已用 80.5 → 可用 19
        assertEquals(QuotaSeverity.Critical, quotaSeverityForFraction(0.004f)) // 已用 99.6 → 可用 0
    }

    /**
     * `<`/`>` 对 NaN 的 IEEE 754 比较恒为 false，所以 `NaN` 穿过两个 `<` 分支都不
     * 成立，此前落到 `else -> Healthy`——把「未知」折算成了「充足」。T10.152 曾
     * 把这当作既有行为锁定；T10.170 与桌面 `quotaOverview.ts` 的 `quotaLevel`
     * （`!Number.isFinite(remainingPercent)` 判 critical）对齐，非有限值现在单列
     * 第一分支判 Critical，不再 fail-open（GLB-01：未知不得看起来安全）。
     * ±Infinity 同属非有限值，一并覆盖。
     */
    @Test
    fun nonFiniteInputsFailClosedToCriticalMatchingDesktop() {
        assertEquals(QuotaSeverity.Critical, quotaSeverity(Double.NaN))
        assertEquals(QuotaSeverity.Critical, quotaSeverity(Double.POSITIVE_INFINITY))
        assertEquals(QuotaSeverity.Critical, quotaSeverity(Double.NEGATIVE_INFINITY))
    }

    /**
     * `quotaSeverityForFraction` 在委托 [quotaSeverity] 之前先 `coerceIn(0f, 1f)`：
     * NaN 穿过 `coerceIn` 同样恒不成立、原样放行，最终靠 `quotaSeverity` 的非
     * 有限值分支兜底；但 `+Infinity` 会被 `coerceIn` 钳到 `1f`（100% 健康），
     * 根本到不了那个分支——如果本函数不在钳位前先挡，「未知」会被误判成
     * 「满额健康」。T10.170 在 `coerceIn` 之前显式挡住全部非有限值。
     */
    @Test
    fun fractionEntryPointFailsClosedForNonFiniteEvenThoughCoerceInWouldHideInfinity() {
        assertEquals(QuotaSeverity.Critical, quotaSeverityForFraction(Float.NaN))
        assertEquals(QuotaSeverity.Critical, quotaSeverityForFraction(Float.POSITIVE_INFINITY))
        assertEquals(QuotaSeverity.Critical, quotaSeverityForFraction(Float.NEGATIVE_INFINITY))
    }

    /** 档位名会被读屏念出来——颜色不是唯一线索，改名等于改无障碍文案。 */
    @Test
    fun labelsAreSpokenSoColourIsNeverTheOnlyCue() {
        assertEquals("额度充足", QuotaSeverity.Healthy.label)
        assertEquals("额度偏紧", QuotaSeverity.Warning.label)
        assertEquals("额度告急", QuotaSeverity.Critical.label)
    }
}
