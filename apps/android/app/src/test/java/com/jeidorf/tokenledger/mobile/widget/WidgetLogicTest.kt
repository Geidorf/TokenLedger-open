package com.jeidorf.tokenledger.mobile.widget

import com.jeidorf.tokenledger.mobile.Summary
import com.jeidorf.tokenledger.mobile.QuotaDisplayValue
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.QuotaScope
import com.jeidorf.tokenledger.mobile.QuotaSource
import com.jeidorf.tokenledger.mobile.QuotaUnit
import com.jeidorf.tokenledger.mobile.QuotaWindowSnapshot
import com.jeidorf.tokenledger.mobile.QuotaWindowStatus
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 小组件纯逻辑单测（T8.7）。仅覆盖脱离 Android 框架的纯函数（切换循环、阈值分档、
 * 渲染态裁决、格式化边界、四端口径恒等）。Context/加密缓存/Glance 渲染相关逻辑不在此测，
 * 由真机验收覆盖。组织方式对照 StatsJsonTest。
 */
class WidgetLogicTest {

    // region 模式持久化

    @Test
    fun modeFromStorageMapsLegacyAndNewKeys() {
        assertEquals(WidgetMode.MultiRing, WidgetMode.fromStorage("multi_ring"))
        assertEquals(WidgetMode.MultiRing, WidgetMode.fromStorage("quota"))
        assertEquals(WidgetMode.MultiBar, WidgetMode.fromStorage("multi_bar"))
        assertEquals(WidgetMode.SingleUsage, WidgetMode.fromStorage("usage"))
        assertEquals(WidgetMode.SingleUsage, WidgetMode.fromStorage("single_usage"))
        assertEquals(WidgetMode.BarUsage, WidgetMode.fromStorage("bar_usage"))
        assertEquals(WidgetMode.BarUsage, WidgetMode.fromStorage("combo"))
        assertEquals(WidgetMode.BarUsage, WidgetMode.fromStorage(null))
    }

    @Test
    fun publicProvidersHaveFixedModesWhileLegacyProviderRetainsCompatibilityChoices() {
        assertEquals(
            listOf(WidgetMode.MultiRing, WidgetMode.SingleUsage, WidgetMode.BarUsage),
            publicWidgetModes()
        )
        assertEquals(
            WidgetMode.MultiRing,
            providerLockedWidgetMode("com.jeidorf.tokenledger.mobile.widget.TokenLedgerRingWidgetReceiver")
        )
        assertEquals(
            WidgetMode.SingleUsage,
            providerLockedWidgetMode("com.jeidorf.tokenledger.mobile.widget.TokenLedgerBarWidgetReceiver")
        )
        assertEquals(
            WidgetMode.BarUsage,
            providerLockedWidgetMode("com.jeidorf.tokenledger.mobile.widget.TokenLedgerComboWidgetReceiver")
        )
        assertEquals(null, providerLockedWidgetMode("com.jeidorf.tokenledger.mobile.widget.TokenLedgerWidgetReceiver"))
        assertEquals(
            listOf(WidgetMode.MultiRing, WidgetMode.SingleUsage, WidgetMode.BarUsage, WidgetMode.MultiBar),
            configurableWidgetModes(WidgetMode.MultiBar)
        )
        assertEquals(publicWidgetModes(), configurableWidgetModes(WidgetMode.SingleUsage))
    }

    @Test
    fun sharedRefreshStopsOnlyAfterEveryProviderInstanceIsGone() {
        assertTrue(shouldCancelWidgetRefresh(0))
        assertTrue(!shouldCancelWidgetRefresh(1))
        assertTrue(!shouldCancelWidgetRefresh(4))
    }

    // endregion

    // region 范围循环

    @Test
    fun rangeCyclesTodayWeekMonth() {
        assertEquals(WidgetRange.Week, nextWidgetRange(WidgetRange.Today))
        assertEquals(WidgetRange.Month, nextWidgetRange(WidgetRange.Week))
        assertEquals(WidgetRange.Today, nextWidgetRange(WidgetRange.Month))
    }

    // endregion

    // region 来源选择

    private fun provider(id: String) = WidgetQuotaProvider(
        id = id,
        name = id,
        status = QuotaProviderStatus.Ok,
        primary = null,
        secondary = null,
        resetText = null,
        freshnessText = "刚刚",
        stale = false
    )

    @Test
    fun providerSelectionDefaultsToStableTopThree() {
        val providers = listOf(provider("codex"), provider("claude"), provider("antigravity"), provider("other"))
        assertEquals(listOf("codex", "claude", "antigravity"), selectWidgetProviders(providers, null).map { it.id })
    }

    @Test
    fun providerSelectionCanPinOneVisibleSourceWithoutCycling() {
        val companyProviderId = "company-openapi-0123456789abcdef01234567"
        val providers = listOf(
            provider("codex"),
            provider("claude"),
            provider("antigravity"),
            provider(companyProviderId)
        )
        assertEquals(listOf("claude"), selectWidgetProviders(providers, "claude").map { it.id })
        assertEquals(
            listOf(companyProviderId),
            selectWidgetProviders(providers, companyProviderId).map { it.id }
        )
        assertEquals(providers.take(3), selectWidgetProviders(providers, "missing"))
    }

    // endregion

    // region 可用额度阈值分档（20% / 50% 分界，严格小于，D4/T10.152 三端统一）

    @Test
    fun thresholdBandBoundaries() {
        assertEquals(WidgetThresholdBand.Danger, widgetAvailabilityBand(0f))
        assertEquals(WidgetThresholdBand.Danger, widgetAvailabilityBand(0.199f))
        // 边界落在档位的下沿：0.20 属于偏紧，0.50 属于正常；写清楚免得后来人改成 <=。
        assertEquals(WidgetThresholdBand.Warn, widgetAvailabilityBand(0.20f))
        assertEquals(WidgetThresholdBand.Warn, widgetAvailabilityBand(0.499f))
        assertEquals(WidgetThresholdBand.Normal, widgetAvailabilityBand(0.50f))
        assertEquals(WidgetThresholdBand.Normal, widgetAvailabilityBand(1.0f))
    }

    /** 0/100% 是最常见的真实取值，两端都不应落错档位。 */
    @Test
    fun thresholdBandExtremes() {
        assertEquals(WidgetThresholdBand.Danger, widgetAvailabilityBand(0f))
        assertEquals(WidgetThresholdBand.Normal, widgetAvailabilityBand(1f))
    }

    /**
     * 负值与超过 100% 的可用比例不应落错档位：都只应比正常边界更极端，不应翻转。
     * T10.152 评审曾指出这两端此前未被覆盖。
     */
    @Test
    fun thresholdBandOutOfRangeFractionsStayInBounds() {
        assertEquals(WidgetThresholdBand.Danger, widgetAvailabilityBand(-1f))
        assertEquals(WidgetThresholdBand.Normal, widgetAvailabilityBand(2f))
    }

    /**
     * `<` 对 NaN 的 IEEE 754 比较恒为 false，所以两个分支都不成立，此前落到
     * `else -> Normal`——把「未知」折算成了「正常」。T10.152 曾把这当作既有行为
     * 锁定；T10.170 与桌面 `quotaOverview.ts` 的 `quotaLevel`
     * （`!Number.isFinite(remainingPercent)` 判 critical）及 [QuotaSeverityTest]
     * 的同一改动对齐，非有限值现在单列第一分支判 Danger，不再 fail-open
     * （GLB-01：未知不得看起来安全）。±Infinity 同属非有限值，一并覆盖：两个
     * 方向都不会被误判为「正常」。
     */
    @Test
    fun nonFiniteFractionsFailClosedToDangerMatchingDesktop() {
        assertEquals(WidgetThresholdBand.Danger, widgetAvailabilityBand(Float.NaN))
        assertEquals(WidgetThresholdBand.Danger, widgetAvailabilityBand(Float.POSITIVE_INFINITY))
        assertEquals(WidgetThresholdBand.Danger, widgetAvailabilityBand(Float.NEGATIVE_INFINITY))
    }

    // endregion

    // region 渲染态裁决

    private val sampleQuota = WidgetQuota(providers = emptyList())
    private val sampleUsage = WidgetUsage(
        range = WidgetRange.Today,
        effectiveTokens = 1L,
        costCny = 0.0,
        requests = 0L,
        freshnessText = "",
        tokenDelta = null
    )

    @Test
    fun noSessionResolvesToNeedLogin() {
        assertEquals(
            WidgetState.NeedLogin,
            resolveWidgetState(hasSession = false, quota = sampleQuota, usage = sampleUsage)
        )
    }

    @Test
    fun sessionWithoutAnyCacheResolvesToNoData() {
        assertEquals(
            WidgetState.NoData,
            resolveWidgetState(hasSession = true, quota = null, usage = null)
        )
    }

    @Test
    fun sessionWithEitherCacheResolvesToReady() {
        assertTrue(resolveWidgetState(true, quota = sampleQuota, usage = null) is WidgetState.Ready)
        assertTrue(resolveWidgetState(true, quota = null, usage = sampleUsage) is WidgetState.Ready)
    }

    // endregion

    // region 四端口径恒等：有效 Token = 输入 + 输出（引用现有 Summary 模型）

    @Test
    fun effectiveTokensIsInputPlusOutput() {
        val summary = Summary(totalTokens = 999, inputTokens = 400, outputTokens = 600, cachedTokens = 123)
        assertEquals(1000L, summary.effectiveTokens)
    }

    // endregion

    // region compact 格式化边界

    @Test
    fun compactTokenBoundaries() {
        assertEquals("999", formatCompactTokens(999L))
        assertEquals("1.0K", formatCompactTokens(1_000L))
        assertEquals("1.2M", formatCompactTokens(1_200_000L))
        assertEquals("987.6M", formatCompactTokens(987_600_000L))
        assertEquals("2.1B", formatCompactTokens(2_100_000_000L))
    }

    /** A-Q1：小组件保留一位小数（REQ-WIDGET-03），但与应用一样先舍入再选单位，不再出现 `1000.0K`。 */
    @Test
    fun compactTokensCarryIntoTheNextUnitAfterRounding() {
        assertEquals("999.5K", formatCompactTokens(999_499L))
        assertEquals("999.5K", formatCompactTokens(999_500L))
        assertEquals("1.0M", formatCompactTokens(999_950L))
        assertEquals("1.0M", formatCompactTokens(999_999L))
        assertEquals("1.0B", formatCompactTokens(999_950_000L))
        assertEquals("-1.0M", formatCompactTokens(-999_999L))
    }

    @Test
    fun cnyFormattingKeepsFiveAndSixDigitCostsStable() {
        assertEquals("¥12,345.67", formatCny(12_345.67))
        assertEquals("¥128,640.34", formatCny(128_640.34))
        assertEquals("¥***.*", formatCny(128_640.34, masked = true))
    }

    /** T10.154 A19：挂件与应用同一个金额格式；读不到写「不可得」，已知 0 写 ¥0.00，两者分得开。 */
    @Test
    fun cnyFormattingNeverTurnsUnknownIntoZero() {
        assertEquals("¥0.00", formatCny(0.0))
        assertEquals("<¥0.01", formatCny(0.004))
        assertEquals("不可得", formatCny(null))
        assertEquals("不可得", formatCny(Double.NaN))
        assertEquals("不可得", formatCny(Double.POSITIVE_INFINITY))
        assertEquals("不可得", formatCny(-1.0))
        assertEquals("¥***.*", formatCny(null, masked = true))
    }

    /** R-11：挂件变化率一律取整，负号 U+2212，与应用同一套符号规则。 */
    @Test
    fun widgetDeltaPercentIsRoundedAndSigned() {
        assertEquals("+12%", formatDeltaPercent(12.4))
        assertEquals("−5%", formatDeltaPercent(-4.5))
        assertEquals("0%", formatDeltaPercent(0.4))
        assertEquals("", formatDeltaPercent(null))
    }

    @Test
    fun constrainedQuotaLabelsExposeHiddenAndSubstituteSemanticsAsText() {
        assertEquals(null, formatHiddenWindowCount(0))
        assertEquals(null, formatHiddenWindowCount(-1))
        assertEquals("+2", formatHiddenWindowCount(2))
        assertEquals("每周", formatWidgetWindowLabel("每周", roleSubstitute = false))
        assertEquals("替代·5 小时", formatWidgetWindowLabel("5 小时", roleSubstitute = true))
    }

    @Test
    fun quotaRingUsesAvailableFractionNotUsedFraction() {
        fun percent(used: Double) = QuotaDisplayValue.Progress(used, 100.0, 100.0 - used, QuotaUnit.Percent, (used / 100.0).toFloat())
        val window = widgetProgressQuotaWindow("周额度", percent(43.0), QuotaWindowStatus.Ok)
        assertEquals(0.57f, window.availableFraction!!, 0.0001f)
        assertEquals("57%", window.availableText)
        // 非百分比窗口按 used ÷ limit 折算；超额钳到 0。
        val requests = QuotaDisplayValue.Progress(110.0, 100.0, null, QuotaUnit.Requests, 1f)
        assertEquals(0f, widgetProgressQuotaWindow("请求", requests, QuotaWindowStatus.Ok).availableFraction!!, 0.0001f)
    }

    /**
     * A-Q2：环、条、文字与档位都跟**显示的整数**走。已用 80.4% 显示「20%」，档位是偏紧；
     * 此前比例按未取整的 19.6% 画、文字却四舍五入成 20%，同一个环数字说偏紧、颜色说告急。
     */
    @Test
    fun quotaRingFractionAndBandFollowTheDisplayedInteger() {
        fun percent(used: Double) = QuotaDisplayValue.Progress(used, 100.0, 100.0 - used, QuotaUnit.Percent, (used / 100.0).toFloat())
        val cases = listOf(
            49.5 to ("50%" to WidgetThresholdBand.Normal),
            50.4 to ("50%" to WidgetThresholdBand.Normal),
            50.5 to ("49%" to WidgetThresholdBand.Warn),
            79.5 to ("20%" to WidgetThresholdBand.Warn),
            80.4 to ("20%" to WidgetThresholdBand.Warn),
            80.5 to ("19%" to WidgetThresholdBand.Danger),
            99.6 to ("0%" to WidgetThresholdBand.Danger)
        )
        for ((used, expected) in cases) {
            val window = widgetProgressQuotaWindow("周额度", percent(used), QuotaWindowStatus.Ok)
            assertEquals("已用 $used", expected.first, window.availableText)
            assertEquals("已用 $used", expected.second, widgetAvailabilityBand(window.availableFraction!!))
        }
    }

    @Test
    fun themeStorageDefaultsToSystemAndRoundTrips() {
        assertEquals(WidgetThemeMode.System, WidgetThemeMode.fromStorage(null))
        assertEquals(WidgetThemeMode.Light, WidgetThemeMode.fromStorage("light"))
        assertEquals(WidgetThemeMode.Dark, WidgetThemeMode.fromStorage("dark"))
    }

    @Test
    fun widgetFontScaleNeverCancelsTheUsersSystemScale() {
        assertEquals(1f, widgetFontCompensation(1f), 0.001f)
        assertEquals(1f, widgetFontCompensation(1.5f), 0.001f)
        assertEquals(1f, widgetFontCompensation(2f), 0.001f)
        assertEquals(1f, widgetFontCompensation(2f, maxRenderedScale = 1f), 0.001f)
    }

    @Test
    fun widgetLargeTextReflowsToFewerCompleteProviderUnits() {
        assertEquals(3, visibleWidgetProviderCount(3, 250f, 110f, 1f))
        assertEquals(2, visibleWidgetProviderCount(3, 250f, 110f, 1.5f))
        assertEquals(1, visibleWidgetProviderCount(3, 250f, 110f, 2f))
        assertEquals(1, visibleWidgetProviderCount(3, 170f, 110f, 1f))
    }

    @Test
    fun usageAndMessageLayoutsReflowAtTwoHundredPercentInsteadOfClipping() {
        assertEquals(WidgetUsageLayout.Split, widgetUsageLayout(250f, 58f, 1f))
        assertEquals(WidgetUsageLayout.PrimaryOnly, widgetUsageLayout(250f, 58f, 2f))
        assertEquals(WidgetUsageLayout.Stacked, widgetUsageLayout(250f, 110f, 2f))
        assertTrue(shouldUseCompactWidgetMessage(58f, 1f))
        assertTrue(shouldUseCompactWidgetMessage(110f, 2f))
        assertTrue(!shouldUseCompactWidgetMessage(110f, 1f))
    }

    @Test
    fun freshnessBelongsToTheDisplayedPrimaryWindowNotANewerSecondaryWindow() {
        val now = Instant.parse("2026-07-28T04:00:00Z")
        fun snapshot(id: String, observedAt: Instant) = QuotaWindowSnapshot(
            providerId = "codex",
            windowId = id,
            windowLabel = id,
            scope = QuotaScope.ConsumerSubscription,
            source = QuotaSource.LocalAuthorized,
            status = QuotaWindowStatus.Ok,
            used = 42.0,
            limit = 100.0,
            remaining = 58.0,
            unit = QuotaUnit.Percent,
            windowMinutes = 300,
            resetsAt = null,
            observedAt = observedAt.toString(),
            fetchedAt = observedAt.toString(),
            staleAfterSeconds = 3_600,
            reasonCode = null
        )
        val primary = snapshot("primary", now.minusSeconds(10 * 60))
        val newerSecondary = snapshot("secondary", now.minusSeconds(60))

        assertEquals(
            "10 分钟前",
            primaryWindowFreshnessText(primary, now.toEpochMilli())
        )
        assertEquals(
            "1 分钟前",
            primaryWindowFreshnessText(newerSecondary, now.toEpochMilli())
        )
        assertEquals("时间未知", primaryWindowFreshnessText(null, now.toEpochMilli()))
    }

    @Test
    fun talkBackDescriptionIncludesFullFreshAndStaleSemanticsButNeverErrorPercent() {
        fun accessibleProvider(status: QuotaProviderStatus) = WidgetQuotaProvider(
            id = "codex",
            name = "Codex · 工作账号",
            status = status,
            primary = WidgetQuotaWindow(
                label = "每周",
                availableFraction = if (status == QuotaProviderStatus.Error) null else 0.42f,
                availableText = if (status == QuotaProviderStatus.Error) "不可用" else "42%",
                status = when (status) {
                    QuotaProviderStatus.Stale -> QuotaWindowStatus.Stale
                    QuotaProviderStatus.Error -> QuotaWindowStatus.Error
                    else -> QuotaWindowStatus.Ok
                }
            ),
            secondary = null,
            resetText = "2h 后重置",
            freshnessText = "8 分钟前",
            stale = status == QuotaProviderStatus.Stale
        )

        val fresh = providerAccessibilityDescription(accessibleProvider(QuotaProviderStatus.Ok))
        assertTrue(fresh.contains("Codex · 工作账号"))
        assertTrue(fresh.contains("每周"))
        assertTrue(fresh.contains("42%可用"))
        assertTrue(fresh.contains("2h 后重置"))
        assertTrue(fresh.contains("更新于8 分钟前"))

        val stale = providerAccessibilityDescription(accessibleProvider(QuotaProviderStatus.Stale))
        assertTrue(stale.contains("历史数据"))
        assertTrue(stale.contains("42%可用"))

        val error = providerAccessibilityDescription(accessibleProvider(QuotaProviderStatus.Error))
        assertTrue(error.contains("不可用"))
        assertTrue(!error.contains("42%"))
    }

    // endregion

    // region 相对时间边界（0 / 59m / 1h / 23h59m / 跨天）

    @Test
    fun relativeTimeBoundaries() {
        assertEquals("刚刚", formatRelativeTime(0L))
        assertEquals("59 分钟前", formatRelativeTime(59L * 60_000L))
        assertEquals("1 小时前", formatRelativeTime(60L * 60_000L))
        assertEquals("23 小时前", formatRelativeTime(23L * 3_600_000L + 59L * 60_000L))
        assertEquals("1 天前", formatRelativeTime(24L * 3_600_000L))
    }

    @Test
    fun relativeTimeClampsNegativeToNow() {
        assertEquals("刚刚", formatRelativeTime(-5_000L))
    }

    // endregion

    // region 重置倒计时边界（0 / 59m / 1h / 23h59m / 跨天）

    @Test
    fun resetCountdownBoundaries() {
        assertEquals("0m 后重置", formatResetCountdown(0L))
        assertEquals("59m 后重置", formatResetCountdown(59L * 60_000L))
        assertEquals("1h0m 后重置", formatResetCountdown(60L * 60_000L))
        assertEquals("23h59m 后重置", formatResetCountdown(23L * 3_600_000L + 59L * 60_000L))
        assertEquals("1天0h 后重置", formatResetCountdown(24L * 3_600_000L))
    }

    // endregion
}
