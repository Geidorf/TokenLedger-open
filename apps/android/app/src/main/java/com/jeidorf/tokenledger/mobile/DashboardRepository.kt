package com.jeidorf.tokenledger.mobile

import android.content.Context
import java.util.TimeZone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

interface DashboardDataSource {
    val isConfigured: Boolean

    suspend fun restoreSession(): MobileSession?

    suspend fun signIn(email: String, password: String): MobileSession

    suspend fun persistSession(session: MobileSession)

    fun sessionPersistenceGeneration(): Long = 0L

    suspend fun activateSession(session: MobileSession, expectedGeneration: Long) = persistSession(session)

    fun revokeSessionNow() = Unit

    suspend fun clearSession()

    suspend fun fetchStats(
        session: MobileSession,
        range: RangeKey,
        machine: String
    ): Pair<MobileSession, StatsData>

    suspend fun fetchStats(
        session: MobileSession,
        query: DashboardQuery
    ): Pair<MobileSession, StatsData> = fetchStats(session, query.range, query.machine)

    suspend fun fetchStats(
        session: MobileSession,
        query: DashboardQuery,
        entity: DashboardEntity?
    ): Pair<MobileSession, StatsData> = fetchStats(session, query)

    suspend fun fetchNextDetails(
        session: MobileSession,
        query: DashboardQuery,
        cursor: String
    ): Pair<MobileSession, UsageDetailsPage> = throw DashboardCapabilityException(
        "当前数据源不支持详情分页"
    )

    suspend fun fetchNextDetails(
        session: MobileSession,
        query: DashboardQuery,
        entity: DashboardEntity?,
        cursor: String
    ): Pair<MobileSession, UsageDetailsPage> = fetchNextDetails(session, query, cursor)
}

class DashboardRepository(context: Context) : DashboardDataSource {
    private val appContext = context.applicationContext
    private val gateway: SupabaseGateway by lazy {
        SupabaseGateway(
            supabaseUrl = BuildConfig.TOKENLEDGER_SUPABASE_URL,
            publishableKey = BuildConfig.TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY
        )
    }
    private val sessionAuthority: SessionAuthority by lazy {
        synchronized(AUTHORITY_LOCK) {
            sharedAuthority ?: SessionAuthority(SessionStore(appContext), ::refreshToken).also {
                sharedAuthority = it
            }
        }
    }

    override val isConfigured: Boolean
        get() = BuildConfig.TOKENLEDGER_SUPABASE_URL.isNotBlank() &&
            BuildConfig.TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY.isNotBlank()

    // Restore is deliberately local-only. An expired access token can still identify the
    // encrypted last-known-good snapshot while offline; fetchStats performs the actual refresh.
    override suspend fun restoreSession(): MobileSession? = withContext(Dispatchers.IO) {
        sessionAuthority.restore()
    }

    // Password sign-in does not write local storage; SessionCoordinator activates it after its
    // UI generation check. Only that explicit activation can create a new account session.
    override suspend fun signIn(email: String, password: String): MobileSession =
        gateway.signIn(email.trim(), password)

    override suspend fun persistSession(session: MobileSession) = withContext(Dispatchers.IO) {
        sessionAuthority.persistIfCurrent(session)
        Unit
    }

    override fun sessionPersistenceGeneration(): Long = sessionAuthority.generation()

    override suspend fun activateSession(session: MobileSession, expectedGeneration: Long) = withContext(Dispatchers.IO) {
        if (!sessionAuthority.activate(session, expectedGeneration)) throw SessionRevokedException()
    }

    override fun revokeSessionNow() { sessionAuthority.revokeNow() }

    override suspend fun clearSession() {
        withContext(Dispatchers.IO) {
            if (sessionAuthority.restore() != null) sessionAuthority.revokeNow()
        }
    }

    override suspend fun fetchStats(
        session: MobileSession,
        range: RangeKey,
        machine: String
    ): Pair<MobileSession, StatsData> = fetchStats(
        session,
        DashboardQuery(range = range, machine = machine)
    )

    override suspend fun fetchStats(
        session: MobileSession,
        query: DashboardQuery
    ): Pair<MobileSession, StatsData> = fetchStats(session, query, entity = null)

    override suspend fun fetchStats(
        session: MobileSession,
        query: DashboardQuery,
        entity: DashboardEntity?
    ): Pair<MobileSession, StatsData> {
        val lease = sessionAuthority.lease(session)
        var freshSession = sessionAuthority.ensureFresh(lease)
        val timezone = TimeZone.getDefault().id.ifBlank { "UTC" }
        val stats = try {
            requestStats(freshSession, query, entity, timezone)
        } catch (error: SupabaseHttpException) {
            if (error.status != 401) throw error

            // A server-side revocation can invalidate an otherwise unexpired JWT. Refresh once,
            // then classify a second 401 as authentication expiry instead of a generic outage.
            freshSession = refreshSession(lease, freshSession)
            try {
                requestStats(freshSession, query, entity, timezone)
            } catch (retryError: SupabaseHttpException) {
                if (retryError.status == 401) {
                    throw DashboardAuthExpiredException(retryError)
                }
                throw retryError
            }
        }
        sessionAuthority.requireCurrent(lease)
        return freshSession to stats
    }

    override suspend fun fetchNextDetails(
        session: MobileSession,
        query: DashboardQuery,
        cursor: String
    ): Pair<MobileSession, UsageDetailsPage> = fetchNextDetails(
        session,
        query,
        entity = null,
        cursor
    )

    override suspend fun fetchNextDetails(
        session: MobileSession,
        query: DashboardQuery,
        entity: DashboardEntity?,
        cursor: String
    ): Pair<MobileSession, UsageDetailsPage> {
        val lease = sessionAuthority.lease(session)
        var freshSession = sessionAuthority.ensureFresh(lease)
        val timezone = TimeZone.getDefault().id.ifBlank { "UTC" }
        val details = try {
            gateway.fetchUsageDetails(freshSession, query, entity, timezone, cursor)
        } catch (error: SupabaseHttpException) {
            if (error.status != 401) throw error
            freshSession = refreshSession(lease, freshSession)
            try {
                gateway.fetchUsageDetails(freshSession, query, entity, timezone, cursor)
            } catch (retryError: SupabaseHttpException) {
                if (retryError.status == 401) throw DashboardAuthExpiredException(retryError)
                throw retryError
            }
        }
        sessionAuthority.requireCurrent(lease)
        return freshSession to details
    }

    private suspend fun refreshSession(lease: SessionSnapshot, session: MobileSession): MobileSession =
        sessionAuthority.rotate(lease, session)

    private suspend fun refreshToken(token: String): MobileSession = try {
        gateway.refresh(token)
    } catch (error: SupabaseHttpException) {
        if (error.status in 400..403) throw DashboardAuthExpiredException(error)
        throw error
    }

    private suspend fun requestStats(
        session: MobileSession,
        query: DashboardQuery,
        entity: DashboardEntity?,
        timezone: String
    ): StatsData = gateway.fetchDashboardStats(
        session = session,
        query = query,
        timezone = timezone,
        entity = entity
    )

    private companion object {
        val AUTHORITY_LOCK = Any()
        @Volatile var sharedAuthority: SessionAuthority? = null
    }
}

/**
 * 会话刷新单飞判定（纯函数，脱离 Android 框架，便于单测）。T7.7。
 */
internal object SessionRefreshPolicy {
    /** 访问令牌剩余寿命需高于此提前量才视为"仍新鲜"，与 [DashboardRepository] 的 ensureFresh 一致。 */
    const val ACCESS_TOKEN_FRESH_MARGIN_SECONDS = 60L

    /**
     * 单飞：进入刷新临界区后重读最新已持久化会话，若另一个协程刚完成轮换（持久化会话属同一用户、
     * 刷新令牌已不同、且访问令牌仍新鲜），则复用它、跳过再次刷新，避免用已消费的旧刷新令牌二次刷新。
     */
    fun shouldReusePersisted(
        requested: MobileSession,
        persisted: MobileSession?,
        nowEpochSeconds: Long
    ): Boolean {
        if (persisted == null) return false
        if (persisted.userId != requested.userId) return false
        if (persisted.refreshToken == requested.refreshToken) return false
        return persisted.expiresAtEpochSeconds > nowEpochSeconds + ACCESS_TOKEN_FRESH_MARGIN_SECONDS
    }

    /**
     * candidate 是否不旧于 existing：无既有会话、或换了用户则允许写入；否则要求访问令牌到期时间不早于既有。
     * 用于确保刷新落盘绝不用更旧会话覆盖更新会话。
     */
    fun isNewer(candidate: MobileSession, existing: MobileSession?): Boolean {
        if (existing == null) return true
        if (existing.userId != candidate.userId) return true
        return candidate.expiresAtEpochSeconds >= existing.expiresAtEpochSeconds
    }
}
