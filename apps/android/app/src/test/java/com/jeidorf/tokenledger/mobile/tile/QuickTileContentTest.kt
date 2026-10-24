package com.jeidorf.tokenledger.mobile.tile

import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.widget.WidgetQuota
import com.jeidorf.tokenledger.mobile.widget.WidgetQuotaBarRow
import com.jeidorf.tokenledger.mobile.widget.WidgetRange
import com.jeidorf.tokenledger.mobile.widget.WidgetState
import com.jeidorf.tokenledger.mobile.widget.WidgetUsage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 快捷设置磁贴：挑最紧窗口、可用口径、历史与费用回退、隐藏费用与读屏。 */
class QuickTileContentTest {
    private fun row(
        provider: String,
        window: String?,
        percent: Int?,
        rank: Int,
        status: QuotaProviderStatus = QuotaProviderStatus.Ok,
        reset: String? = null,
        substitute: Boolean = false
    ) = WidgetQuotaBarRow(
        key = "$provider:$window", providerId = provider.lowercase(), providerName = provider, windowLabel = window,
        status = status, availableFraction = percent?.let { it / 100f }, availablePercent = percent,
        resetText = reset, freshnessText = "2 分钟前", rank = rank, groupOrder = rank, roleSubstitute = substitute
    )

    private fun usage(cost: Double?, range: WidgetRange = WidgetRange.Today) =
        WidgetUsage(range, effectiveTokens = 1_000, costCny = cost, requests = 3, freshnessText = "刚刚", tokenDelta = null)

    private fun ready(rows: List<WidgetQuotaBarRow>, usage: WidgetUsage? = usage(12.5)) =
        WidgetState.Ready(quota = WidgetQuota(providers = emptyList(), rows = rows), usage = usage)

    @Test
    fun showsTheTightestAvailableWindowAndTodaysCost() {
        val content = quickTileContent(
            ready(listOf(
                row("Codex", "每周", 72, rank = 0),
                row("Claude 订阅额度", "5 小时", 12, rank = 1, reset = "49 分钟后重置"),
                row("Antigravity", "5 小时", 40, rank = 2)
            )),
            costMasked = false
        )
        assertEquals("可用 12%", content.label)
        assertEquals("Claude 5 小时 · 今日 ¥12.50", content.subtitle)
        assertTrue(content.active)
        assertEquals("Claude 5 小时，可用 12%（额度告急），49 分钟后重置，今日预估费用 ¥12.50", content.stateDescription)
    }

    @Test
    fun tiesGoToTheHigherPriorityWindowAndErrorsAreSkipped() {
        val rows = listOf(
            row("Codex", "5 小时", 30, rank = 3),
            row("Claude", "每周", 30, rank = 1),
            row("Antigravity", null, null, rank = 4, status = QuotaProviderStatus.Error)
        )
        assertEquals("Claude", tightestQuotaRow(rows)?.providerName)
    }

    @Test
    fun substituteWindowIsLabelledInText() {
        val content = quickTileContent(ready(listOf(row("Codex", "5 小时", 50, 0, substitute = true))), costMasked = false)
        assertEquals("Codex 替代·5 小时 · 今日 ¥12.50", content.subtitle)
    }

    @Test
    fun staleWindowsAreHistoricalAndNotActive() {
        val content = quickTileContent(
            ready(listOf(row("Claude", "5 小时", 40, 0, status = QuotaProviderStatus.Stale)), usage = null),
            costMasked = false
        )
        assertEquals("历史 40%", content.label)
        assertEquals("Claude 5 小时 · 待刷新", content.subtitle)
        assertFalse(content.active)
    }

    @Test
    fun fallsBackToTodaysCostThenToNoData() {
        val costOnly = quickTileContent(ready(emptyList()), costMasked = false)
        assertEquals("今日 ¥12.50", costOnly.label)
        assertEquals("额度未同步", costOnly.subtitle)
        // 用量缓存不是「今日」时不冒充今日费用。
        val weekOnly = quickTileContent(ready(emptyList(), usage(99.0, WidgetRange.Week)), costMasked = false)
        assertEquals("暂无数据", weekOnly.subtitle)
        assertFalse(weekOnly.active)
        assertEquals("暂无数据", quickTileContent(WidgetState.NoData, costMasked = false).subtitle)
        val signedOut = quickTileContent(WidgetState.NeedLogin, costMasked = false)
        assertEquals("未登录", signedOut.subtitle)
        assertFalse(signedOut.active)
    }

    @Test
    fun unknownCostIsSaidNotZeroed() {
        val content = quickTileContent(ready(emptyList(), usage(null)), costMasked = false)
        assertEquals("今日 不可得", content.label)
    }

    @Test
    fun maskedCostNeverLeaks() {
        val content = quickTileContent(ready(listOf(row("Codex", "每周", 72, 0))), costMasked = true)
        assertEquals("Codex 每周 · 今日 ¥***.*", content.subtitle)
        assertTrue(content.stateDescription.endsWith("今日预估费用已隐藏"))
        assertFalse(content.stateDescription.contains("12.50"))
    }

    @Test
    fun withoutSubtitleTheLabelCarriesTheSource() {
        val content = quickTileContent(ready(listOf(row("Codex", "每周", 72, 0))), costMasked = false, supportsSubtitle = false)
        assertEquals("Codex 每周 可用 72%", content.label)
        assertNull(content.subtitle)
    }

    @Test
    fun kickIsThrottledButSurvivesClockGoingBack() {
        assertTrue(quickTileKickDue(0L, 1_000_000L))
        assertFalse(quickTileKickDue(1_000_000L, 1_000_000L + 60_000L))
        assertTrue(quickTileKickDue(1_000_000L, 1_000_000L + QuickTileStore.KICK_INTERVAL_MS))
        assertTrue(quickTileKickDue(5_000_000L, 1_000_000L))
    }

    @Test
    fun refreshRangesAddTodayForTheQuickTile() {
        val week = setOf(RangeKey.Week)
        assertEquals(week, widgetRefreshRanges(week, tileAdded = false))
        assertEquals(week + RangeKey.Today, widgetRefreshRanges(week, tileAdded = true))
        assertEquals(setOf(RangeKey.Today), widgetRefreshRanges(emptySet(), tileAdded = false))
    }
}
