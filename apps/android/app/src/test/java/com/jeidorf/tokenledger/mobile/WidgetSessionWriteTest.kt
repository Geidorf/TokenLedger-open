package com.jeidorf.tokenledger.mobile

import com.jeidorf.tokenledger.mobile.widget.WidgetRefreshWriter
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Exercises the production writer, both actual caches, and separate SessionStore instances. */
class WidgetSessionWriteTest {
    private enum class Stage { Quota, Usage }
    private enum class Transition { Logout, SameUserLogin, SwitchUser }
    private val session = MobileSession("access-a", "refresh-a", "A", "a@example.invalid", 4_000_000_000L)
    private val now = 1_750_000_000_000L
    private val stats = StatsData(Summary(inputTokens = 12, outputTokens = 8), emptyMap(),
        emptyMap(), emptyList(), emptyMap(), emptyList(), emptyList(), null)
    private val snapshot = QuotaSnapshotJson.parseTransport(JSONObject(
        checkNotNull(javaClass.classLoader?.getResource("quota-provider-v1/transport-v2.json")).readText()
    ).getJSONObject("readResponse").toString())

    @Test fun delayedQuotaCannotWriteAfterLogout() = delayedResponse(Stage.Quota, Transition.Logout)
    @Test fun delayedQuotaCannotWriteAfterSameUserLogin() = delayedResponse(Stage.Quota, Transition.SameUserLogin)
    @Test fun delayedQuotaCannotWriteAfterSwitchUser() = delayedResponse(Stage.Quota, Transition.SwitchUser)
    @Test fun delayedUsageCannotWriteAfterLogout() = delayedResponse(Stage.Usage, Transition.Logout)
    @Test fun delayedUsageCannotWriteAfterSameUserLogin() = delayedResponse(Stage.Usage, Transition.SameUserLogin)
    @Test fun delayedUsageCannotWriteAfterSwitchUser() = delayedResponse(Stage.Usage, Transition.SwitchUser)

    private fun delayedResponse(stage: Stage, transition: Transition) = runBlocking {
        val harness = Harness()
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val pending = async {
            harness.refresh(
                quota = {
                    if (stage == Stage.Quota) { entered.complete(Unit); release.await() }
                    snapshot
                },
                usage = {
                    if (stage == Stage.Usage) { entered.complete(Unit); release.await() }
                    it to stats
                }
            )
        }
        entered.await()
        harness.foreground.revoke()
        harness.clear()
        when (transition) {
            Transition.Logout -> Unit
            Transition.SameUserLogin -> harness.activate(session.copy(refreshToken = "new-login"))
            Transition.SwitchUser -> harness.activate(session.copy(userId = "B", refreshToken = "refresh-b"))
        }
        release.complete(Unit)
        assertFalse(pending.await()) // Revocation is terminal, not a transient network retry.
        harness.assertEmpty()
        if (stage == Stage.Quota) assertEquals(0, harness.usageCalls)
        assertEquals(if (transition == Transition.Logout) null else
            if (transition == Transition.SwitchUser) "B" else "A", harness.foreground.load()?.userId)
        // A re-opened store/cache cannot revive the old request after same-owner reactivation.
        assertEquals(harness.foreground.snapshot(), SessionStore(harness.sessionPrefs, plaintext).snapshot())
    }

    @Test fun quotaRevocationBetweenEncryptionAndCommitIsRejected() = encryptionRace(Stage.Quota)
    @Test fun usageRevocationBetweenEncryptionAndCommitIsRejected() = encryptionRace(Stage.Usage)

    private fun encryptionRace(stage: Stage) = runBlocking {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val cipher = object : QuotaCacheCipher {
            override fun encrypt(preferenceKey: String, plaintext: String): String {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                return plaintext
            }
            override fun decrypt(preferenceKey: String, encrypted: String) = encrypted
        }
        val harness = Harness(quotaCipher = if (stage == Stage.Quota) cipher else plaintext,
            usageCipher = if (stage == Stage.Usage) cipher else plaintext)
        val pending = async(Dispatchers.IO) { harness.refresh() }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        harness.foreground.revoke() // Completes before the writer enters the guarded commit.
        release.countDown()
        assertFalse(pending.await())
        assertTrue("revoked write must never reach persistent cache",
            (if (stage == Stage.Quota) harness.quotaPrefs else harness.usagePrefs).all.isEmpty())
        harness.clear()
        harness.assertEmpty()
    }

    @Test fun quotaCommitAndRevocationShareOneCriticalSection() = commitRace(Stage.Quota)
    @Test fun usageCommitAndRevocationShareOneCriticalSection() = commitRace(Stage.Usage)

    private fun commitRace(stage: Stage) = runBlocking {
        val harness = Harness()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val revokeStarted = CountDownLatch(1)
        val revoked = CountDownLatch(1)
        val prefs = if (stage == Stage.Quota) harness.quotaPrefs else harness.usagePrefs
        prefs.beforeCommit = {
            entered.countDown()
            check(release.await(5, TimeUnit.SECONDS))
        }
        val pending = async(Dispatchers.IO) { harness.refresh() }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        val logout = async(Dispatchers.IO) {
            revokeStarted.countDown()
            harness.foreground.revoke()
            revoked.countDown()
        }
        assertTrue(revokeStarted.await(5, TimeUnit.SECONDS))
        assertFalse("logout must wait until the already authorized commit finishes",
            revoked.await(100, TimeUnit.MILLISECONDS))
        release.countDown()
        logout.await()
        pending.await()
        prefs.beforeCommit = null
        harness.clear()
        harness.assertEmpty()
        assertNull(harness.foreground.load())
    }

    @Test fun normalRefreshAndTokenRotationKeepBothCachesReadable() = runBlocking {
        val harness = Harness()
        val rotated = session.copy(accessToken = "access-rotated", refreshToken = "refresh-rotated")
        val authority = SessionAuthority(harness.foreground, { rotated })
        assertFalse(harness.refresh(quota = {
            // Same lifecycle, like a simultaneous foreground 401 refresh.
            authority.rotate(harness.lease, session)
            snapshot
        }, usage = { requested ->
            assertEquals(rotated, authority.ensureFresh(authority.lease(requested)))
            rotated to stats
        }))
        assertEquals(rotated, harness.foreground.load())
        assertEquals(snapshot, QuotaCache(harness.quotaPrefs, plaintext)
            .load(harness.quotaKey, now)?.snapshot?.snapshot)
        assertEquals(harness.lease.generation, harness.quotaCache.load(harness.quotaKey, now)?.metadata?.sessionGeneration)
        assertEquals(stats.summary, DashboardCache(harness.usagePrefs, plaintext).load(harness.usageKey)?.stats?.summary)
    }

    @Test fun oldCapturedLeaseIsRejectedBeforeAnyNetworkRequest() = runBlocking {
        val harness = Harness()
        harness.foreground.revoke()
        harness.activate(session) // Delayed Worker retains an old snapshot of the same user.
        assertFalse(harness.refresh(quota = { error("revoked lease must not fetch") }))
        assertEquals(0, harness.usageCalls)
        harness.assertEmpty()
    }

    @Test fun failedDurableLogoutPoisonsOldWritesUntilRevocationIsRetried() = runBlocking {
        val harness = Harness()
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val pending = async {
            harness.refresh(quota = { entered.complete(Unit); release.await(); snapshot })
        }
        entered.await()
        harness.sessionPrefs.commitResult = false
        try {
            assertTrue(runCatching { harness.foreground.revoke() }.exceptionOrNull() is IllegalStateException)
            release.complete(Unit)
            assertFalse(pending.await())
            harness.assertEmpty()
            assertEquals(0, harness.usageCalls)
            assertTrue(runCatching { harness.foreground.snapshot() }.isFailure)
        } finally {
            harness.sessionPrefs.commitResult = true
            harness.foreground.revoke()
        }
    }

    private val plaintext get() = QuotaCacheTest.PlaintextQuotaCacheCipher

    private inner class Harness(
        quotaCipher: QuotaCacheCipher = plaintext,
        usageCipher: QuotaCacheCipher = plaintext
    ) {
        val sessionPrefs = QuotaCacheTest.InMemorySharedPreferences()
        val quotaPrefs = QuotaCacheTest.InMemorySharedPreferences()
        val usagePrefs = QuotaCacheTest.InMemorySharedPreferences()
        val foreground = SessionStore(sessionPrefs, plaintext)
        private val worker = SessionStore(sessionPrefs, plaintext)
        val quotaCache = QuotaCache(quotaPrefs, quotaCipher)
        private val usageCache = DashboardCache(usagePrefs, usageCipher)
        val quotaKey = QuotaCacheKey(session.userId)
        val usageKey = DashboardCacheKey.from(session.userId, DashboardQuery(RangeKey.Today), "UTC", null)
        val lease: SessionSnapshot
        var usageCalls = 0
        init { activate(session); lease = worker.snapshot() }
        fun activate(value: MobileSession) { assertTrue(foreground.activate(foreground.generation(), value)) }

        suspend fun clear() {
            QuotaCache(quotaPrefs, plaintext).invalidate(quotaKey,
                QuotaCacheWriteIdentity("foreground", 100, foreground.generation(), snapshot.epoch, snapshot.revision))
            DashboardCache(usagePrefs, plaintext).clearUser(session.userId)
        }
        suspend fun assertEmpty() {
            assertNull(QuotaCache(quotaPrefs, plaintext).load(quotaKey, now))
            assertNull(DashboardCache(usagePrefs, plaintext).load(usageKey))
        }
        suspend fun refresh(
            quota: suspend (MobileSession) -> QuotaTransportSnapshot = { snapshot },
            usage: suspend (MobileSession) -> Pair<MobileSession, StatsData> = { it to stats }
        ): Boolean = WidgetRefreshWriter.refresh(
            lease, worker,
            object : QuotaDataSource {
                override suspend fun fetchQuotaSnapshots(session: MobileSession) = quota(session)
            },
            object : DashboardDataSource {
                override val isConfigured = true
                override suspend fun restoreSession() = worker.load()
                override suspend fun signIn(email: String, password: String): MobileSession = error("unused")
                override suspend fun persistSession(session: MobileSession) = Unit
                override suspend fun clearSession() = Unit
                override suspend fun fetchStats(session: MobileSession, range: RangeKey, machine: String): Pair<MobileSession, StatsData> {
                    usageCalls++
                    return usage(session)
                }
            }, quotaCache, usageCache, setOf(RangeKey.Today),
            QuotaCacheWriteIdentity("widget", 1, lease.generation, 0, 0), "UTC", { now }
        )
    }
}
