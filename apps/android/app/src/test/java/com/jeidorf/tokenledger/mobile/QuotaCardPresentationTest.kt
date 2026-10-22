package com.jeidorf.tokenledger.mobile

import java.io.File
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class QuotaCardPresentationTest {
    private val now = Instant.parse("2026-09-07T02:00:00Z")
    private fun provider(): QuotaProviderEnvelope {
        val raw = QuotaSnapshotJson.parseFixtureProviders(File("../../../fixtures/quota-provider-v1/complete-v1.json").readText(), QuotaParseMode.OrdinaryReader).first()
        val fresh = raw.windows.first().copy(status = QuotaWindowStatus.Ok, windowId = "fresh", observedAt = "2026-09-07T01:59:50Z", fetchedAt = "2026-09-07T01:59:55Z", resetsAt = "2026-09-08T00:00:00Z", staleAfterSeconds = 60, reasonCode = null)
        val old = fresh.copy(windowId = "old", observedAt = "2026-09-06T01:00:00Z", fetchedAt = "2026-09-06T01:00:05Z")
        return raw.copy(status = QuotaProviderStatus.Ok, reasonCode = null, windows = listOf(fresh, old))
    }

    @Test fun mixedAgeOnlyDisclosesPartialHistoryWithoutChangingContractStatus() {
        val provider = provider()
        val actual = quotaCardPresentation(provider, now, false)
        assertEquals(QuotaProviderStatus.Stale, provider.effectiveStatus(now))
        assertEquals(QuotaProviderStatus.Stale, actual.status)
        assertEquals("部分历史", actual.headline)
        assertEquals(listOf(QuotaWindowStatus.Ok, QuotaWindowStatus.Stale), actual.windows.map { it.status })
        assertEquals(provider.windows, actual.windows.map { it.window })
        assertTrue(actual.windows.all { it.value != null })
        // A later transport/read does not renew the old window.
        val reread = provider.copy(windows = provider.windows.map { it.copy(fetchedAt = now.toString()) })
        assertEquals(QuotaWindowStatus.Stale, quotaCardPresentation(reread, now, false).windows.last().status)
    }

    @Test fun explicitProviderFailureAndAuthOverrideEveryWindowAndValue() {
        for (status in listOf(QuotaProviderStatus.Error, QuotaProviderStatus.AuthRequired, QuotaProviderStatus.Unsupported)) {
            val actual = quotaCardPresentation(provider().copy(status = status), now, false)
            assertEquals(status.localizedLabel(), actual.headline)
            assertTrue(actual.windows.all { it.value == null })
            assertTrue(actual.windows.none { it.status == QuotaWindowStatus.Ok })
        }
    }

    @Test fun explicitStaleAndCachedSnapshotRemainHistorical() {
        val explicit = quotaCardPresentation(provider().copy(status = QuotaProviderStatus.Stale, reasonCode = "upstream_unavailable"), now, false)
        assertEquals("历史数据", explicit.headline)
        assertTrue(explicit.windows.all { it.status == QuotaWindowStatus.Stale })
        val cached = quotaCardPresentation(provider(), now, true)
        assertEquals("本机历史快照", cached.headline)
        assertTrue(cached.windows.all { it.status == QuotaWindowStatus.Stale })
    }

    @Test fun allFreshAllOldAndWindowFailureKeepCorrectPriority() {
        val p = provider()
        assertEquals("已更新", quotaCardPresentation(p.copy(windows = listOf(p.windows.first())), now, false).headline)
        assertEquals("历史数据", quotaCardPresentation(p.copy(windows = listOf(p.windows.last())), now, false).headline)
        val error = p.copy(windows = listOf(p.windows.first(), p.windows.last().copy(status = QuotaWindowStatus.Error)))
        assertTrue(quotaCardPresentation(error, now, false).windows.all { it.value == null })
        val reset = p.copy(windows = listOf(p.windows.first().copy(resetsAt = "2026-09-07T01:59:59Z")))
        assertEquals("历史数据", quotaCardPresentation(reset, now, false).headline)
    }

    @Test fun detailTimesRetainDateSecondsAndTimezoneAndNeverEchoInvalidInput() {
        assertEquals("2026-09-07 10:00:03 +08:00", quotaFullTimestamp("2026-09-07T10:00:03+08:00"))
        assertEquals("2026-09-07 02:00:00 +00:00", quotaCacheTimestamp(now.toEpochMilli()))
        assertEquals("未知", quotaCacheTimestamp(0))
        assertEquals("未知", quotaFullTimestamp(null))
        assertEquals("未知", quotaFullTimestamp("/Users/private/token-secret"))
    }

    @Test fun amountsKeepDirectionAndUnknownLimitNeverBecomesZero() {
        // A-Q2：百分比额度一律整数，可用 = 100 − round(已用)（与桌面 readQuotaWindow 相同）。
        assertEquals("可用 72%", quotaValueLabel(QuotaDisplayValue.Progress(27.5, 100.0, 72.5, QuotaUnit.Percent, .275f)))
        assertEquals("已用 17 次请求", quotaValueLabel(QuotaDisplayValue.Absolute(17.0, null, null, QuotaUnit.Requests)))
        assertEquals("可用 2.5 Credits", quotaValueLabel(QuotaDisplayValue.Absolute(null, null, 2.5, QuotaUnit.Credits)))
        assertEquals("上限 100 Token", quotaValueLabel(QuotaDisplayValue.Absolute(null, 100.0, null, QuotaUnit.Tokens)))
        assertEquals("无限 Credits", quotaValueLabel(QuotaDisplayValue.UnlimitedCredits))
        assertNull(quotaValueLabel(null))
        assertEquals("额度数值未知", quotaValueLabel(QuotaDisplayValue.Absolute(null, null, null, QuotaUnit.Credits)))
    }

    @Test fun amountsAreRoundedToTheUnitSoFloatErrorNeverReachesTheCard() {
        // remaining 往往是 limit - used 的浮点差。100.0 - 99.9 在 IEEE-754 下是
        // 0.09999999999999432，曾经原样显示成「可用 0.09999999999999432%」。T10.207 起百分比额度
        // 只从 used 取整（A-Q2），remaining 的浮点差根本进不了卡片。
        assertEquals("可用 0%", quotaValueLabel(QuotaDisplayValue.Progress(99.9, 100.0, 100.0 - 99.9, QuotaUnit.Percent, .999f)))
        assertEquals("可用 33%", quotaValueLabel(QuotaDisplayValue.Progress(66.6, 100.0, 100.0 - 66.6, QuotaUnit.Percent, .666f)))
        // remaining 缺省时同样按 used 取整。
        assertEquals("可用 0%", quotaValueLabel(QuotaDisplayValue.Progress(99.9, 100.0, null, QuotaUnit.Percent, .999f)))
        // Token / 请求数是整数口径；美元保留两位；Credits 保留一位。
        assertEquals("可用 12 Token", quotaValueLabel(QuotaDisplayValue.Absolute(null, null, 12.4, QuotaUnit.Tokens)))
        assertEquals("可用 13 次请求", quotaValueLabel(QuotaDisplayValue.Absolute(null, null, 12.5, QuotaUnit.Requests)))
        assertEquals("可用 3.5 美元", quotaValueLabel(QuotaDisplayValue.Absolute(null, null, 3.499999, QuotaUnit.Usd)))
        assertEquals("可用 3.46 美元", quotaValueLabel(QuotaDisplayValue.Absolute(null, null, 3.4551, QuotaUnit.Usd)))
        assertEquals("可用 2.5 Credits", quotaValueLabel(QuotaDisplayValue.Absolute(null, null, 2.4999, QuotaUnit.Credits)))
    }

    @Test fun recoveryGuidanceNeverCreatesPhoneAuthorizationOrImmediateRateLimitPromise() {
        val limited = quotaRecoveryGuidance(provider().copy(reasonCode = "rate_limited"))
        assertTrue(limited.contains("等待"))
        assertTrue(limited.contains("桌面端"))
        assertFalse(limited.contains("立即"))
        val unknown = quotaRecoveryGuidance(provider().copy(reasonCode = "secret-private-path"))
        assertFalse(unknown.contains("secret"))
        assertTrue(unknown.contains("桌面端"))
    }
}
