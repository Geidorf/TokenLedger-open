package com.jeidorf.tokenledger.mobile.ui.quota

import com.jeidorf.tokenledger.mobile.QuotaCapability
import com.jeidorf.tokenledger.mobile.QuotaScope
import com.jeidorf.tokenledger.mobile.QuotaSource
import com.jeidorf.tokenledger.mobile.QuotaUnit
import com.jeidorf.tokenledger.mobile.QuotaWindowSnapshot
import com.jeidorf.tokenledger.mobile.QuotaWindowStatus
import java.time.Duration
import java.time.OffsetDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 与桌面 quotaPace 同规则（docs/design/forecast-and-pace-v1.md §3）：速度锚定观测时刻，资格不满足不预测。 */
class QuotaForecastTest {

    private fun window(
        minutes: Int,
        resetsAt: OffsetDateTime,
        observedAt: OffsetDateTime,
        staleAfterSeconds: Int = 86_400
    ) = QuotaWindowSnapshot(
        providerId = "openai-codex-local",
        windowId = "weekly",
        windowLabel = "每周",
        scope = QuotaScope.ConsumerSubscription,
        source = QuotaSource.OfficialApi,
        status = QuotaWindowStatus.Ok,
        used = null,
        limit = null,
        remaining = null,
        unit = QuotaUnit.Percent,
        windowMinutes = minutes,
        resetsAt = resetsAt.toString(),
        observedAt = observedAt.toString(),
        fetchedAt = observedAt.toString(),
        staleAfterSeconds = staleAfterSeconds,
        reasonCode = null
    )

    // 规格 §3.3 示例：每周窗口已过 96.5 小时、已用 64%，照此速度约 54.3 小时后用完，早于 71.5 小时后的重置。
    private val weeklyReset = OffsetDateTime.parse("2026-07-18T08:00:00+08:00")
    private val weeklyObserved = OffsetDateTime.parse("2026-07-15T08:30:00+08:00")
    private val weekly = window(10_080, weeklyReset, weeklyObserved)

    @Test
    fun specExampleProjectsAboutSeventeenHoursEarly() {
        val now = weeklyObserved.plusMinutes(1).toInstant()
        assertEquals(1_033L, quotaForecastShortfallMinutes(weekly, QuotaCapability.Stable, 0.64, now))
    }

    @Test
    fun rateIsAnchoredToObservationNotRenderTime() {
        val later = weeklyObserved.plusHours(10).toInstant()
        assertEquals(1_033L, quotaForecastShortfallMinutes(weekly, QuotaCapability.PlanDependent, 0.64, later))
    }

    @Test
    fun experimentalProviderIsNotForecast() {
        val now = weeklyObserved.plusMinutes(1).toInstant()
        assertNull(quotaForecastShortfallMinutes(weekly, QuotaCapability.Experimental, 0.64, now))
    }

    @Test
    fun staleObservationIsNotForecast() {
        val stale = window(10_080, weeklyReset, weeklyObserved, staleAfterSeconds = 600)
        assertNull(quotaForecastShortfallMinutes(stale, QuotaCapability.Stable, 0.64, weeklyObserved.plusMinutes(11).toInstant()))
    }

    @Test
    fun dayPrecisionResetIsNotForecast() {
        // reset 恰为观测加整 3 天，像「Resets in 3 days」换算来的：精度一天超过每周窗口的 5%。
        val observed = weeklyReset.minusDays(3)
        val coarse = window(10_080, weeklyReset, observed)
        assertNull(quotaForecastShortfallMinutes(coarse, QuotaCapability.Stable, 0.9, observed.plusMinutes(1).toInstant()))
    }

    @Test
    fun tooEarlyOnPaceOrExhaustedIsNotForecast() {
        val reset = OffsetDateTime.parse("2026-09-07T12:00:00+08:00")
        val start = reset.minus(Duration.ofMinutes(300))
        // 5 小时窗口只过了 20 分钟（不足 10%）。
        val early = window(300, reset, start.plusMinutes(20).plusSeconds(7))
        assertNull(quotaForecastShortfallMinutes(early, QuotaCapability.Stable, 0.5, start.plusMinutes(21).toInstant()))
        // 过了 70% 只用 30%：重置时也用不完。
        val calm = window(300, reset, start.plusMinutes(210).plusSeconds(7))
        val now = start.plusMinutes(211).toInstant()
        assertNull(quotaForecastShortfallMinutes(calm, QuotaCapability.Stable, 0.3, now))
        assertNull(quotaForecastShortfallMinutes(calm, QuotaCapability.Stable, 1.0, now))
    }

    @Test
    fun fiveHourWindowPastHalfwayProjectsShortfall() {
        val reset = OffsetDateTime.parse("2026-09-07T12:00:00+08:00")
        val observed = reset.minusMinutes(120).minusSeconds(7)
        // 已过 180 分钟零 7 秒、已用 80%：剩下 20% 约 45 分钟用完，比重置早约 75 分钟。
        val busy = window(300, reset, observed)
        assertEquals(75L, quotaForecastShortfallMinutes(busy, QuotaCapability.Stable, 0.8, observed.plusMinutes(1).toInstant()))
    }
}
