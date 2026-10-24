package com.jeidorf.tokenledger.mobile

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionAuthorityTest {
    private val now = 1_000_000L
    private val old = session("A", "refresh-a", now)
    private val rotated = session("A", "refresh-a2", now + 3600)

    @Test
    fun logoutDuringDelayedRefreshCannotRestoreSessionAfterRestart() = runTest {
        val storage = MemoryStorage()
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val authority = SessionAuthority(storage, {
            entered.complete(Unit)
            release.await()
            rotated
        }, { now })
        assertTrue(authority.activate(old, authority.generation()))
        val lease = authority.lease(old)
        val request = async { runCatching { authority.ensureFresh(lease) } }
        entered.await()
        authority.revokeNow()
        release.complete(Unit)

        assertTrue(request.await().exceptionOrNull() is SessionRevokedException)
        assertNull(storage.snapshot().session)
        assertFalse(authority.persistIfCurrent(rotated))
        assertNull(SessionAuthority(storage, { error("unexpected refresh") }, { now }).restore())
    }

    @Test
    fun accountSwitchWinsOverOldRefreshAndLatePersist() = runTest {
        val storage = MemoryStorage()
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val authority = SessionAuthority(storage, {
            entered.complete(Unit)
            release.await()
            rotated
        }, { now })
        assertTrue(authority.activate(old, authority.generation()))
        val lease = authority.lease(old)
        val request = async { runCatching { authority.ensureFresh(lease) } }
        entered.await()
        authority.revokeNow()
        val userB = session("B", "refresh-b", now + 3600)
        assertTrue(authority.activate(userB, authority.generation()))
        release.complete(Unit)

        assertTrue(request.await().exceptionOrNull() is SessionRevokedException)
        assertFalse(authority.persistIfCurrent(rotated))
        assertEquals(userB, SessionAuthority(storage, { error("unexpected refresh") }, { now }).restore())
    }

    @Test
    fun appAndWidgetRequestsShareOneRefreshTokenConsumption() = runTest {
        val storage = MemoryStorage()
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var refreshCalls = 0
        val authority = SessionAuthority(storage, { token ->
            assertEquals(old.refreshToken, token)
            refreshCalls++
            entered.complete(Unit)
            release.await()
            rotated
        }, { now })
        assertTrue(authority.activate(old, authority.generation()))
        val appLease = authority.lease(old)
        val widgetLease = authority.lease(old)
        val app = async { authority.ensureFresh(appLease) }
        entered.await()
        val widget = async { authority.ensureFresh(widgetLease) }
        runCurrent()
        release.complete(Unit)

        assertEquals(rotated, app.await())
        assertEquals(rotated, widget.await())
        assertEquals(1, refreshCalls)
        assertEquals(rotated, storage.snapshot().session)
        assertEquals(rotated, authority.lease(old).session)
    }

    @Test
    fun failedSynchronousCommitCannotBeReportedAsSuccessfulRotation() = runTest {
        val storage = MemoryStorage()
        val authority = SessionAuthority(storage, { rotated }, { now })
        assertTrue(authority.activate(old, authority.generation()))
        storage.failReplace = true
        val result = runCatching { authority.ensureFresh(authority.lease(old)) }
        assertTrue(result.exceptionOrNull() is IllegalStateException)
        assertEquals(rotated, storage.unsafeMemory().session)
        assertEquals(old, storage.restart().snapshot().session)
        assertTrue(runCatching { authority.restore() }.exceptionOrNull() is IllegalStateException)
    }

    @Test
    fun revokeNowHandsBackTheCommittedSessionForServerLogout() {
        val storage = MemoryStorage()
        val authority = SessionAuthority(storage, { error("unexpected refresh") }, { now })
        assertTrue(authority.activate(old, authority.generation()))
        assertEquals(old, authority.revokeNow())
        assertNull(authority.restore())
        assertNull(authority.revokeNow())
    }

    @Test
    fun failedTombstoneCommitRemainsVisibleToCaller() {
        val storage = MemoryStorage()
        val authority = SessionAuthority(storage, { error("unexpected refresh") }, { now })
        assertTrue(authority.activate(old, authority.generation()))
        storage.failRevoke = true
        assertTrue(runCatching { authority.revokeNow() }.exceptionOrNull() is IllegalStateException)
        assertNull(storage.unsafeMemory().session)
        assertEquals(old, storage.restart().snapshot().session)
        assertTrue(runCatching { authority.restore() }.exceptionOrNull() is IllegalStateException)
        storage.failRevoke = false
        authority.revokeNow()
        assertNull(storage.restart().snapshot().session)
    }

    @Test
    fun failedActivationCommitCannotBeMistakenForDurableSignIn() {
        val storage = MemoryStorage()
        val authority = SessionAuthority(storage, { error("unexpected refresh") }, { now })
        storage.failActivate = true
        assertTrue(runCatching { authority.activate(old, authority.generation()) }.exceptionOrNull() is IllegalStateException)
        assertEquals(old, storage.unsafeMemory().session)
        assertNull(storage.restart().snapshot().session)
        assertTrue(runCatching { authority.restore() }.exceptionOrNull() is IllegalStateException)
    }

    @Test
    fun delayedLoginActivationCannotPassLogoutTombstone() = runTest {
        val storage = MemoryStorage()
        val authority = SessionAuthority(storage, { error("unexpected refresh") }, { now })
        val expectedGeneration = authority.generation()
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val delayedLogin = async {
            entered.complete(Unit)
            release.await() // Represents the IO dispatch after the UI generation check.
            authority.activate(old, expectedGeneration)
        }
        entered.await()
        authority.revokeNow()
        release.complete(Unit)

        assertFalse(delayedLogin.await())
        assertNull(SessionAuthority(storage, { error("unexpected refresh") }, { now }).restore())
    }

    @Test
    fun delayedLoginActivationCannotReplaceSwitchedAccount() = runTest {
        val storage = MemoryStorage()
        val authority = SessionAuthority(storage, { error("unexpected refresh") }, { now })
        assertTrue(authority.activate(old, authority.generation()))
        val expectedGeneration = authority.generation()
        val release = CompletableDeferred<Unit>()
        val delayedLogin = async {
            release.await()
            authority.activate(session("A", "late-sign-in", now + 3600), expectedGeneration)
        }
        authority.revokeNow()
        val userB = session("B", "refresh-b", now + 3600)
        assertTrue(authority.activate(userB, authority.generation()))
        release.complete(Unit)

        assertFalse(delayedLogin.await())
        assertEquals(userB, SessionAuthority(storage, { error("unexpected refresh") }, { now }).restore())
    }

    private class MemoryStorage(
        private var disk: SessionSnapshot = SessionSnapshot(0, null)
    ) : SessionPersistence {
        private var value = disk
        private var poisoned = false
        var failActivate = false
        var failReplace = false
        var failRevoke = false

        fun unsafeMemory(): SessionSnapshot = synchronized(this) { value }

        fun restart(): MemoryStorage = synchronized(this) { MemoryStorage(disk) }

        override fun generation(): Long = synchronized(this) {
            check(!poisoned)
            value.generation
        }

        override fun snapshot(): SessionSnapshot = synchronized(this) {
            check(!poisoned)
            value
        }

        override fun activate(expectedGeneration: Long, session: MobileSession): Boolean = synchronized(this) {
            check(!poisoned)
            if (value.generation != expectedGeneration) return@synchronized false
            value = SessionSnapshot(value.generation + 1, session)
            if (failActivate) {
                poisoned = true
                error("commit failed after memory update")
            }
            disk = value
            true
        }

        override fun revoke(): SessionSnapshot = synchronized(this) {
            value = SessionSnapshot(value.generation + 1, null)
            if (failRevoke) {
                poisoned = true
                error("commit failed after memory update")
            }
            disk = value
            poisoned = false
            value
        }

        override fun writeIfCurrent(expected: SessionSnapshot, write: () -> Unit): Boolean = synchronized(this) {
            check(!poisoned)
            if (value.generation != expected.generation || value.session == null ||
                value.session?.userId != expected.session?.userId) return@synchronized false
            write()
            true
        }

        override fun replace(expected: SessionSnapshot, session: MobileSession): Boolean = synchronized(this) {
            check(!poisoned)
            if (value != expected) return@synchronized false
            value = expected.copy(session = session)
            if (failReplace) {
                poisoned = true
                error("commit failed after memory update")
            }
            disk = value
            true
        }
    }

    private fun session(user: String, token: String, expiry: Long) = MobileSession(
        accessToken = "access-$token",
        refreshToken = token,
        userId = user,
        email = "$user@example.invalid",
        expiresAtEpochSeconds = expiry
    )
}
