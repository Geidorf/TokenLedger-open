package com.jeidorf.tokenledger.mobile.widget

import com.jeidorf.tokenledger.mobile.QuotaCapability
import com.jeidorf.tokenledger.mobile.QuotaMode
import com.jeidorf.tokenledger.mobile.QuotaProviderEnvelope
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.QuotaScope
import com.jeidorf.tokenledger.mobile.QuotaSource
import com.jeidorf.tokenledger.mobile.QuotaUnit
import com.jeidorf.tokenledger.mobile.QuotaWindowSnapshot
import com.jeidorf.tokenledger.mobile.QuotaWindowStatus
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 额度条小组件（[WidgetMode.QuotaBars]）的行映射、截断与版面预算。 */
class WidgetQuotaBarsTest {
    private val now: Instant = Instant.parse("2026-10-24T02:00:00Z")

    private fun window(
        providerId: String,
        id: String,
        used: Double,
        minutes: Int?,
        resetInMinutes: Long? = null,
        observedMinutesAgo: Long = 2,
        status: QuotaWindowStatus = QuotaWindowStatus.Ok,
        unit: QuotaUnit = QuotaUnit.Percent
    ) = QuotaWindowSnapshot(
        providerId = providerId,
        windowId = id,
        windowLabel = id,
        scope = QuotaScope.ConsumerSubscription,
        source = QuotaSource.LocalAuthorized,
        status = status,
        used = used,
        limit = 100.0,
        remaining = 100.0 - used,
        unit = unit,
        windowMinutes = minutes,
        resetsAt = resetInMinutes?.let { now.plusSeconds(it * 60).toString() },
        observedAt = now.minusSeconds(observedMinutesAgo * 60).toString(),
        fetchedAt = now.minusSeconds(observedMinutesAgo * 60).toString(),
        staleAfterSeconds = 3_600,
        reasonCode = null
    )

    private fun provider(
        id: String,
        name: String,
        vararg windows: QuotaWindowSnapshot,
        status: QuotaProviderStatus = QuotaProviderStatus.Ok
    ) = QuotaProviderEnvelope(
        schemaVersion = 1,
        providerId = id,
        displayName = name,
        scope = QuotaScope.ConsumerSubscription,
        mode = QuotaMode.Automatic,
        capability = QuotaCapability.Stable,
        status = status,
        windows = windows.toList(),
        reasonCode = null
    )

    private val codex = provider(
        "openai-codex-local", "Codex",
        window("openai-codex-local", "five-hour", used = 4.0, minutes = 300, resetInMinutes = 192),
        window("openai-codex-local", "weekly", used = 28.0, minutes = 10080, resetInMinutes = 3060)
    )
    private val claude = provider(
        "anthropic-claude-consumer", "Claude",
        window("anthropic-claude-consumer", "session", used = 72.0, minutes = 300, resetInMinutes = 49),
        window("anthropic-claude-consumer", "weekly-all", used = 43.0, minutes = 10080, resetInMinutes = 389),
        window("anthropic-claude-consumer", "weekly-opus", used = 0.0, minutes = 10080, resetInMinutes = 389)
    )

    @Test
    fun modeIsPublicAndLockedByItsOwnProvider() {
        assertEquals(WidgetMode.QuotaBars, WidgetMode.fromStorage("quota_bars"))
        assertTrue(WidgetMode.QuotaBars in publicWidgetModes())
        assertEquals(
            WidgetMode.QuotaBars,
            providerLockedWidgetMode("com.jeidorf.tokenledger.mobile.widget.TokenLedgerQuotaWidgetReceiver")
        )
    }

    @Test
    fun resetCountdownMatchesPlanLimitWording() {
        assertEquals("49 分钟后重置", formatQuotaBarReset(49 * 60_000L + 59_000L))
        assertEquals("6 小时 29 分钟后重置", formatQuotaBarReset((6 * 60 + 29) * 60_000L))
        assertEquals("3 小时后重置", formatQuotaBarReset(3 * 60 * 60_000L))
        assertEquals("2 天 3 小时后重置", formatQuotaBarReset((51 * 60 + 10) * 60_000L))
        assertEquals("4 天后重置", formatQuotaBarReset(4 * 24 * 60 * 60_000L))
        assertEquals("1 分钟内重置", formatQuotaBarReset(20_000L))
        assertEquals("1 分钟内重置", formatQuotaBarReset(-5_000L))
    }

    @Test
    fun everyDrawableWindowGetsOneRowWithAvailablePercentAndReset() {
        val rows = widgetQuotaBarRows(listOf(claude, codex), now)
        assertEquals(5, rows.size)
        val session = rows.single { it.key.contains("session") }
        assertEquals(28, session.availablePercent)
        assertEquals(0.28f, session.availableFraction!!, 1e-6f)
        assertEquals("49 分钟后重置", session.resetText)
        assertEquals("可用 28%", widgetQuotaBarValueText(session))
        assertEquals(QuotaProviderStatus.Ok, session.status)
    }

    @Test
    fun displayGroupsWindowsByProviderWhileTruncationKeepsEveryProviderVisible() {
        val rows = widgetQuotaBarRows(listOf(claude, codex), now)
        // 截断优先级：先每个来源的主窗口（Codex 周、Claude 5 小时），再各自的次窗口。
        val byRank = rows.sortedBy { it.rank }.map { it.providerId }
        assertEquals("openai-codex-local", byRank[0])
        assertEquals("anthropic-claude-consumer", byRank[1])
        // 只放得下两行时两个来源各占一行，并且按来源分组展示。
        val plan = widgetQuotaBarsLayout(260f, 100f, 1f, rows, routingRequested = false)
        assertEquals(2, plan.visible.size)
        assertEquals(listOf("openai-codex-local", "anthropic-claude-consumer"), plan.visible.map { it.providerId })
        assertEquals(3, plan.hiddenCount)
        assertEquals("+3 个窗口", formatHiddenQuotaWindows(plan.hiddenCount))
    }

    @Test
    fun staleWindowKeepsNumberButSaysHistory() {
        val old = provider(
            "anthropic-claude-consumer", "Claude",
            window("anthropic-claude-consumer", "session", used = 40.0, minutes = 300, observedMinutesAgo = 120)
        )
        val row = widgetQuotaBarRows(listOf(old), now).single()
        assertEquals(QuotaProviderStatus.Stale, row.status)
        assertEquals("历史 60%", widgetQuotaBarValueText(row))
        assertNull(row.resetText)
        assertTrue(widgetQuotaBarAccessibility(row).contains("历史数据"))
    }

    @Test
    fun providerErrorShowsStatusWithoutFakeProgress() {
        val broken = provider("openai-codex-local", "Codex", status = QuotaProviderStatus.AuthRequired)
        val rows = widgetQuotaBarRows(listOf(broken, claude), now)
        val pending = rows.single { it.providerId == "openai-codex-local" }
        assertEquals(QuotaProviderStatus.AuthRequired, pending.status)
        assertNull(pending.availableFraction)
        assertEquals("需授权", widgetQuotaBarValueText(pending))
        assertEquals("Codex", widgetQuotaBarTitle(pending, pinnedProvider = false))
        // 待处理来源排在所有窗口行之后，不挤掉能给数的窗口。
        assertEquals(rows.maxOf { it.rank }, pending.rank)
    }

    @Test
    fun creditsOnlyProviderDoesNotTakeARow() {
        val credits = provider(
            "credits-x", "公司额度",
            window("credits-x", "credits", used = 3.0, minutes = null, unit = QuotaUnit.Credits)
        )
        assertTrue(widgetQuotaBarRows(listOf(credits), now).isEmpty())
    }

    @Test
    fun pinnedProviderFiltersRowsAndTitlesDropProviderName() {
        val rows = widgetQuotaBarRows(listOf(claude, codex), now)
        val pinned = widgetQuotaBarRowsFor(rows, "anthropic-claude-consumer")
        assertEquals(3, pinned.size)
        assertTrue(pinned.none { widgetQuotaBarTitle(it, pinnedProvider = true).startsWith("Claude") })
        assertTrue(widgetQuotaBarRowsFor(rows, "missing").isEmpty())
    }

    @Test
    fun layoutDropsRoutingBeforeQuotaAndResetOnNarrowCards() {
        val rows = widgetQuotaBarRows(listOf(claude, codex), now)
        val roomy = widgetQuotaBarsLayout(280f, 200f, 1f, rows, routingRequested = true)
        assertTrue(roomy.showRouting)
        assertTrue(roomy.showReset)
        assertEquals(5, roomy.visible.size)
        // 4×2 下路由与两行额度放不下时，先放额度。
        val short = widgetQuotaBarsLayout(280f, 64f, 1f, rows, routingRequested = true)
        assertTrue(short.sufficient)
        assertFalse(short.showRouting)
        assertEquals(1, short.visible.size)
        assertEquals(4, short.hiddenCount)
        val narrow = widgetQuotaBarsLayout(190f, 200f, 1f, rows, routingRequested = false)
        assertFalse(narrow.showReset)
        val tooSmall = widgetQuotaBarsLayout(100f, 40f, 1f, rows, routingRequested = false)
        assertFalse(tooSmall.sufficient)
    }

    @Test
    fun largeFontShowsFewerRowsInsteadOfShrinkingText() {
        val rows = widgetQuotaBarRows(listOf(claude, codex), now)
        val normal = widgetQuotaBarsLayout(280f, 200f, 1f, rows, routingRequested = false)
        val large = widgetQuotaBarsLayout(280f, 200f, 2f, rows, routingRequested = false)
        assertTrue(large.visible.size < normal.visible.size)
        assertEquals(rows.size - large.visible.size, large.hiddenCount)
    }
}
