package com.jeidorf.tokenledger.mobile.coordinator

import com.jeidorf.tokenledger.mobile.DashboardDataSource
import com.jeidorf.tokenledger.mobile.DashboardSessionState
import com.jeidorf.tokenledger.mobile.MobileSession
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.StatsData
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionLogoutRevokeTest {
    private val uiSession = MobileSession(
        accessToken = "ui-access",
        refreshToken = "ui-refresh",
        userId = "user-a",
        email = "a@example.com",
        expiresAtEpochSeconds = 1_750_000_000L
    )
    private val committedSession = uiSession.copy(accessToken = "rotated-access", refreshToken = "rotated-refresh")

    private class FakeSource : DashboardDataSource {
        override val isConfigured: Boolean = true
        var committed: MobileSession? = null
        var revokeRemote: suspend (MobileSession) -> Unit = {}
        val remoteRevoked = mutableListOf<MobileSession>()
        var clearCount = 0

        override fun revokeSessionNow(): MobileSession? = committed.also { committed = null }

        override suspend fun revokeRemoteSession(session: MobileSession) {
            remoteRevoked += session
            revokeRemote(session)
        }

        override suspend fun clearSession() {
            clearCount++
        }

        override suspend fun restoreSession(): MobileSession? = null
        override suspend fun signIn(email: String, password: String): MobileSession = error("unused")
        override suspend fun persistSession(session: MobileSession) = Unit
        override suspend fun fetchStats(
            session: MobileSession,
            range: RangeKey,
            machine: String
        ): Pair<MobileSession, StatsData> = error("unused")
    }

    @Test
    fun signOutRevokesTheCommittedServerSession() = runTest {
        val source = FakeSource().apply { committed = committedSession }
        val coordinator = SessionCoordinator(source, this)
        coordinator.setSessionState(DashboardSessionState.Authenticated(uiSession))
        var cleanedUser: String? = null

        coordinator.signOut { cleanedUser = it }
        runCurrent()

        assertEquals(listOf(committedSession), source.remoteRevoked)
        assertEquals("user-a", cleanedUser)
        assertEquals(1, source.clearCount)
        assertEquals(DashboardSessionState.SignedOut, coordinator.sessionState.value)
    }

    @Test
    fun signOutFallsBackToTheUiSessionWhenNothingIsCommitted() = runTest {
        val source = FakeSource()
        val coordinator = SessionCoordinator(source, this)
        coordinator.setSessionState(DashboardSessionState.Authenticated(uiSession))

        coordinator.signOut {}
        runCurrent()

        assertEquals(listOf(uiSession), source.remoteRevoked)
    }

    @Test
    fun remoteFailureDoesNotUndoOrDelayLocalSignOut() = runTest {
        val gate = CompletableDeferred<Unit>()
        val source = FakeSource().apply {
            committed = committedSession
            revokeRemote = {
                gate.await()
                throw IOException("offline")
            }
        }
        val coordinator = SessionCoordinator(source, this)
        coordinator.setSessionState(DashboardSessionState.Authenticated(uiSession))
        var cleanupCalls = 0

        coordinator.signOut { cleanupCalls++ }
        // Local state is final before the server call has even answered.
        assertEquals(DashboardSessionState.SignedOut, coordinator.sessionState.value)
        assertEquals(1, cleanupCalls)
        runCurrent()
        assertEquals(1, source.clearCount)

        gate.complete(Unit)
        runCurrent()

        assertEquals(1, source.remoteRevoked.size)
        assertEquals(DashboardSessionState.SignedOut, coordinator.sessionState.value)
    }

    @Test
    fun signOutWithoutAnySessionSkipsTheServerCall() = runTest {
        val source = FakeSource()
        val coordinator = SessionCoordinator(source, this)
        coordinator.setSessionState(DashboardSessionState.SignedOut)

        coordinator.signOut {}
        runCurrent()

        assertTrue(source.remoteRevoked.isEmpty())
        assertEquals(1, source.clearCount)
    }

    @Test
    fun expiredSessionClearsLocallyWithoutCallingTheServer() = runTest {
        val source = FakeSource().apply { committed = committedSession }
        val coordinator = SessionCoordinator(source, this)
        coordinator.setSessionState(DashboardSessionState.Authenticated(uiSession))

        coordinator.handleAuthExpired("user-a") {}
        runCurrent()

        assertTrue(source.remoteRevoked.isEmpty())
        assertEquals(1, source.clearCount)
    }
}
