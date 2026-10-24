package com.jeidorf.tokenledger.mobile.coordinator

import com.jeidorf.tokenledger.mobile.DashboardDataSource
import com.jeidorf.tokenledger.mobile.DashboardRequestIdentity
import com.jeidorf.tokenledger.mobile.DashboardSessionState
import com.jeidorf.tokenledger.mobile.DashboardUiError
import com.jeidorf.tokenledger.mobile.MobileSession
import java.util.concurrent.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal class SessionCoordinator(
    private val repository: DashboardDataSource,
    private val coroutineScope: CoroutineScope
) {
    val sessionMutationMutex = Mutex()

    private val _sessionState = MutableStateFlow<DashboardSessionState>(
        if (repository.isConfigured) DashboardSessionState.Restoring else DashboardSessionState.SignedOut
    )
    val sessionState: StateFlow<DashboardSessionState> = _sessionState.asStateFlow()

    var sessionGeneration: Long = DashboardRequestIdentity.nextSessionGeneration()
        private set

    private var restoreJob: Job? = null
    private var signInJob: Job? = null
    private var sessionClearJob: Job? = null

    val isConfigured: Boolean
        get() = repository.isConfigured

    fun currentSession(): MobileSession? =
        (_sessionState.value as? DashboardSessionState.Authenticated)?.session

    fun setSessionState(state: DashboardSessionState) {
        _sessionState.value = state
    }

    fun advanceSessionGeneration(): Long {
        sessionGeneration = DashboardRequestIdentity.nextSessionGeneration()
        return sessionGeneration
    }

    fun restoreSession(
        onSuccess: (MobileSession) -> Unit,
        onError: (DashboardUiError) -> Unit,
        onSignedOut: () -> Unit
    ) {
        val restoreGeneration = sessionGeneration
        restoreJob = coroutineScope.launch {
            val session = try {
                repository.restoreSession()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (sessionGeneration == restoreGeneration) {
                    _sessionState.value = DashboardSessionState.SignedOut
                    onError(
                        DashboardUiError.Unexpected(
                            error.message?.takeIf(String::isNotBlank) ?: "无法恢复登录状态"
                        )
                    )
                }
                return@launch
            }

            if (sessionGeneration != restoreGeneration) return@launch
            if (session == null) {
                _sessionState.value = DashboardSessionState.SignedOut
                onSignedOut()
                return@launch
            }

            advanceSessionGeneration()
            _sessionState.value = DashboardSessionState.Authenticated(session)
            onSuccess(session)
        }
    }

    fun signIn(
        email: String,
        password: String,
        attemptGeneration: Long,
        sessionClearBarrier: Job,
        barriers: List<Job?>,
        onSuccess: (MobileSession) -> Unit,
        onError: (DashboardUiError) -> Unit
    ) {
        // Capture before either remote sign-in or the IO activation can suspend. A later logout
        // or account switch advances the persistent generation and makes activation fail its CAS.
        val expectedPersistenceGeneration = repository.sessionPersistenceGeneration()
        restoreJob?.cancel()
        signInJob?.cancel()
        _sessionState.value = DashboardSessionState.SignedOut

        signInJob = coroutineScope.launch {
            sessionClearBarrier.join()
            barriers.forEach { it?.join() }
            val session = try {
                repository.signIn(email, password)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (sessionGeneration == attemptGeneration) {
                    _sessionState.value = DashboardSessionState.SignedOut
                    onError(
                        DashboardUiError.Unexpected(
                            error.message?.takeIf(String::isNotBlank) ?: "登录失败"
                        )
                    )
                }
                return@launch
            }

            if (sessionGeneration != attemptGeneration) return@launch
            val persisted = try {
                activateSessionIfCurrent(session, attemptGeneration, expectedPersistenceGeneration)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (sessionGeneration == attemptGeneration) {
                    _sessionState.value = DashboardSessionState.SignedOut
                    onError(
                        DashboardUiError.Unexpected(
                            error.message?.takeIf(String::isNotBlank) ?: "无法保存登录状态"
                        )
                    )
                }
                return@launch
            }
            if (!persisted) return@launch
            _sessionState.value = DashboardSessionState.Authenticated(session)
            onSuccess(session)
        }
    }

    fun signOut(
        onSignOutCleanup: (userId: String?) -> Unit
    ) {
        val uiSession = currentSession()
        // The committed session is preferred: a background refresh may have rotated past the UI copy.
        val revoked = revokeAndEnqueueClear() ?: uiSession
        revoked?.let(::launchRemoteRevoke)
        val userId = uiSession?.userId
        advanceSessionGeneration()
        restoreJob?.cancel()
        signInJob?.cancel()
        _sessionState.value = DashboardSessionState.SignedOut
        onSignOutCleanup(userId)
    }

    fun handleAuthExpired(
        userId: String,
        onExpiredCleanup: (userId: String) -> Unit
    ) {
        enqueueSessionClear()
        advanceSessionGeneration()
        _sessionState.value = DashboardSessionState.Expired()
        onExpiredCleanup(userId)
    }

    fun enqueueSessionClear(): Job {
        revokeAndEnqueueClear()
        return checkNotNull(sessionClearJob)
    }

    private fun revokeAndEnqueueClear(): MobileSession? {
        // Persist the tombstone before returning to the caller or suspending on an older mutation.
        val revoked = repository.revokeSessionNow()
        val previous = sessionClearJob
        sessionClearJob = coroutineScope.launch {
            previous?.join()
            sessionMutationMutex.withLock {
                repository.clearSession()
            }
        }
        return revoked
    }

    // Local sign-out is already final; the server call only stops the old refresh token from
    // being exchanged later. It never touches local state and its failure is not shown.
    private fun launchRemoteRevoke(session: MobileSession) {
        coroutineScope.launch {
            try {
                repository.revokeRemoteSession(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                // Offline or already expired: nothing more to do on this device.
            }
        }
    }

    suspend fun persistSessionIfCurrent(
        session: MobileSession,
        expectedGeneration: Long
    ): Boolean = sessionMutationMutex.withLock {
        if (sessionGeneration != expectedGeneration) return@withLock false
        repository.persistSession(session)
        sessionGeneration == expectedGeneration
    }

    private suspend fun activateSessionIfCurrent(
        session: MobileSession,
        expectedGeneration: Long,
        expectedPersistenceGeneration: Long
    ): Boolean = sessionMutationMutex.withLock {
        if (sessionGeneration != expectedGeneration) return@withLock false
        repository.activateSession(session, expectedPersistenceGeneration)
        sessionGeneration == expectedGeneration
    }

    suspend fun persistSessionIfCurrent(
        session: MobileSession,
        isCurrentPredicate: () -> Boolean
    ): Boolean = sessionMutationMutex.withLock {
        if (!isCurrentPredicate()) return@withLock false
        repository.persistSession(session)
        isCurrentPredicate()
    }

    fun cancelActiveAuthJobs() {
        restoreJob?.cancel()
        signInJob?.cancel()
    }
}
