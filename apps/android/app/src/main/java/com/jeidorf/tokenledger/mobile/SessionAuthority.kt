package com.jeidorf.tokenledger.mobile

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal data class SessionSnapshot(val generation: Long, val session: MobileSession?)

/** Short, synchronous storage operations; implementations must compare and write atomically. */
internal interface SessionPersistence {
    fun generation(): Long
    fun snapshot(): SessionSnapshot
    fun activate(expectedGeneration: Long, session: MobileSession): Boolean
    fun revoke(): SessionSnapshot
    fun replace(expected: SessionSnapshot, session: MobileSession): Boolean
    /** Check the durable lifecycle and commit without releasing the revocation lock. */
    fun writeIfCurrent(expected: SessionSnapshot, write: () -> Unit): Boolean
}

internal class SessionWriteGuard(
    private val persistence: SessionPersistence,
    private val expected: SessionSnapshot
) {
    fun commit(write: () -> Unit) {
        if (!persistence.writeIfCurrent(expected, write)) throw SessionRevokedException()
    }
}

internal class SessionRevokedException : IllegalStateException("登录状态已变更")

/** Shared by all repositories in the app process, including WorkManager widget requests. */
internal class SessionAuthority(
    private val persistence: SessionPersistence,
    private val refresh: suspend (String) -> MobileSession,
    private val nowEpochSeconds: () -> Long = { System.currentTimeMillis() / 1000L }
) {
    private val refreshMutex = Mutex()
    private val knownSessions = LinkedHashMap<MobileSession, Long>()

    fun restore(): MobileSession? = persistence.snapshot().session

    fun generation(): Long = persistence.generation()

    fun activate(session: MobileSession, expectedGeneration: Long): Boolean {
        if (!persistence.activate(expectedGeneration, session)) return false
        synchronized(knownSessions) { knownSessions.clear() }
        return true
    }

    /** Called synchronously at the start of logout/expiry, before any suspended cleanup. */
    fun revokeNow() {
        persistence.revoke()
        synchronized(knownSessions) { knownSessions.clear() }
    }

    // Fetch paths already persist a rotation before returning. A later caller may only confirm
    // that exact committed session; it cannot create a session after a tombstone or account switch.
    fun persistIfCurrent(session: MobileSession): Boolean = persistence.snapshot().session == session

    fun lease(session: MobileSession): SessionSnapshot {
        val snapshot = persistence.snapshot()
        val recognized = snapshot.session == session || synchronized(knownSessions) {
            knownSessions[session] == snapshot.generation && snapshot.session?.userId == session.userId
        }
        if (!recognized) throw SessionRevokedException()
        synchronized(knownSessions) { remember(session, snapshot.generation) }
        return snapshot
    }

    fun requireCurrent(lease: SessionSnapshot) {
        if (persistence.snapshot().generation != lease.generation) throw SessionRevokedException()
    }

    suspend fun ensureFresh(lease: SessionSnapshot): MobileSession {
        val session = lease.session ?: throw SessionRevokedException()
        requireCurrent(lease)
        if (session.expiresAtEpochSeconds > nowEpochSeconds() + SessionRefreshPolicy.ACCESS_TOKEN_FRESH_MARGIN_SECONDS) {
            return session
        }
        return rotate(lease, session)
    }

    suspend fun rotate(lease: SessionSnapshot, requested: MobileSession): MobileSession =
        refreshMutex.withLock {
            val current = persistence.snapshot()
            if (current.generation != lease.generation || current.session?.userId != requested.userId) {
                throw SessionRevokedException()
            }
            if (SessionRefreshPolicy.shouldReusePersisted(requested, current.session, nowEpochSeconds())) {
                return@withLock current.session!!
            }
            // A queued caller must rotate the latest committed token, never spend the old one.
            val token = current.session?.refreshToken ?: throw SessionRevokedException()
            withContext(NonCancellable) {
                val refreshed = refresh(token)
                if (refreshed.userId != requested.userId || !persistence.replace(current, refreshed)) {
                    throw SessionRevokedException()
                }
                synchronized(knownSessions) {
                    remember(requested, lease.generation)
                    remember(refreshed, lease.generation)
                }
                refreshed
            }
        }

    private fun remember(session: MobileSession, generation: Long) {
        knownSessions[session] = generation
        if (knownSessions.size > 8) knownSessions.remove(knownSessions.keys.first())
    }
}
