package com.jeidorf.tokenledger.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * T7.7：会话刷新单飞与"刷新即落盘不覆盖更新会话"两个纯判定的单测。
 * 仅覆盖脱离 Android 框架的纯函数（[SessionRefreshPolicy]）。
 */
class SessionRefreshPolicyTest {

    private val now = 1_000_000L

    private fun session(
        userId: String = "user-1",
        refreshToken: String = "refresh-0",
        expiresAtEpochSeconds: Long = now + 3600L
    ) = MobileSession(
        accessToken = "access",
        refreshToken = refreshToken,
        userId = userId,
        email = "user@example.com",
        expiresAtEpochSeconds = expiresAtEpochSeconds
    )

    // ---- shouldReusePersisted：单飞复用 ----

    @Test
    fun reusesPersistedWhenPeerRotatedToAFreshToken() {
        val requested = session(refreshToken = "refresh-0")
        val persisted = session(refreshToken = "refresh-1", expiresAtEpochSeconds = now + 3600L)
        assertTrue(SessionRefreshPolicy.shouldReusePersisted(requested, persisted, now))
    }

    @Test
    fun doesNotReuseWhenNoSessionPersisted() {
        assertFalse(SessionRefreshPolicy.shouldReusePersisted(session(), null, now))
    }

    @Test
    fun doesNotReuseWhenRefreshTokenUnchanged() {
        // 无人轮换（同一刷新令牌）：必须真正刷新，避免 401 撤销场景陷入复用死循环。
        val same = session(refreshToken = "refresh-0")
        assertFalse(
            SessionRefreshPolicy.shouldReusePersisted(same, same.copy(accessToken = "x"), now)
        )
    }

    @Test
    fun doesNotReuseWhenPersistedAccessTokenIsNotFresh() {
        val requested = session(refreshToken = "refresh-0")
        // 令牌虽已轮换，但访问令牌只剩 30 秒（< 60 秒提前量）→ 仍需刷新。
        val persisted = session(refreshToken = "refresh-1", expiresAtEpochSeconds = now + 30L)
        assertFalse(SessionRefreshPolicy.shouldReusePersisted(requested, persisted, now))
    }

    @Test
    fun doesNotReuseAcrossDifferentUsers() {
        val requested = session(userId = "user-1", refreshToken = "refresh-0")
        val persisted = session(userId = "user-2", refreshToken = "refresh-1")
        assertFalse(SessionRefreshPolicy.shouldReusePersisted(requested, persisted, now))
    }

    // ---- isNewer：刷新落盘不覆盖更新会话 ----

    @Test
    fun isNewerWhenNoExistingSession() {
        assertTrue(SessionRefreshPolicy.isNewer(session(), null))
    }

    @Test
    fun isNewerWhenSwitchingUser() {
        val candidate = session(userId = "user-2")
        val existing = session(userId = "user-1", expiresAtEpochSeconds = Long.MAX_VALUE)
        assertTrue(SessionRefreshPolicy.isNewer(candidate, existing))
    }

    @Test
    fun isNewerWhenCandidateExpiresLaterOrEqual() {
        val existing = session(expiresAtEpochSeconds = now + 100L)
        assertTrue(SessionRefreshPolicy.isNewer(session(expiresAtEpochSeconds = now + 200L), existing))
        assertTrue(SessionRefreshPolicy.isNewer(session(expiresAtEpochSeconds = now + 100L), existing))
    }

    @Test
    fun isNotNewerWhenCandidateWouldOverwriteAFresherSession() {
        val existing = session(expiresAtEpochSeconds = now + 500L)
        assertFalse(SessionRefreshPolicy.isNewer(session(expiresAtEpochSeconds = now + 100L), existing))
    }
}
