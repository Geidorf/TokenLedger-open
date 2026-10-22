package com.jeidorf.tokenledger.mobile.widget

import android.content.Context
import com.jeidorf.tokenledger.mobile.DashboardAuthExpiredException
import com.jeidorf.tokenledger.mobile.DashboardCache
import com.jeidorf.tokenledger.mobile.DashboardCacheKey
import com.jeidorf.tokenledger.mobile.DashboardCachedSnapshot
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.DashboardRepository
import com.jeidorf.tokenledger.mobile.DashboardRequestIdentity
import com.jeidorf.tokenledger.mobile.SessionPersistence
import com.jeidorf.tokenledger.mobile.SessionSnapshot
import com.jeidorf.tokenledger.mobile.SessionStore
import com.jeidorf.tokenledger.mobile.SessionWriteGuard
import com.jeidorf.tokenledger.mobile.SessionRevokedException
import com.jeidorf.tokenledger.mobile.QuotaDataSource
import com.jeidorf.tokenledger.mobile.DashboardDataSource
import com.jeidorf.tokenledger.mobile.QuotaCache
import com.jeidorf.tokenledger.mobile.QuotaCacheKey
import com.jeidorf.tokenledger.mobile.QuotaCacheWriteIdentity
import com.jeidorf.tokenledger.mobile.QuotaCachedSnapshot
import com.jeidorf.tokenledger.mobile.QuotaSnapshotStore
import com.jeidorf.tokenledger.mobile.QuotaTransportSnapshot
import com.jeidorf.tokenledger.mobile.QuotaRepository
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.SupabaseHttpException
import java.io.IOException
import java.util.TimeZone
import java.util.UUID
import kotlinx.coroutines.CancellationException

/**
 * 后台刷新写入器（T8.3）。复用既有仓库层拉取，并把结果写回加密 last-known-good 缓存，
 * 供小组件下次渲染读取。**不新建网络层**。
 *
 * 会话安全（关键设计决策）：Supabase 刷新令牌为一次性轮换令牌。为避免与应用主进程争用、
 * 令老令牌失效，Worker 仅在**访问令牌仍有充裕余量**（> 现在 + [ACCESS_TOKEN_MARGIN_SECONDS]）
 * 时才拉取；若服务端撤销导致内部刷新，仓库层会与前台共用单飞协调并先落盘。
 * 二次 401（[DashboardAuthExpiredException]）直接放弃、交由应用前台重登。
 *
 * 缓存写入身份：
 *  - 额度缓存使用小组件专属 writerId（持久化于 prefs）+ 网络前捕获的单调 requestId。
 *    两条缓存最终提交都在持久会话撤销锁内复验 generation 与 owner；令牌轮换不改变代次。
 *  - 用量缓存复用进程级 [DashboardRequestIdentity]（同进程共享 writerId），以 `nextId()` 保证
 *    与应用写入按 requestId 有序。
 */
internal object WidgetRefreshWriter {
    private const val WRITER_PREFS = "tokenledger_widget_writer"
    private const val KEY_WRITER_ID = "writerId"
    private const val KEY_REQUEST_ID = "requestId"

    /** 访问令牌需高于此余量才在后台拉取，规避刷新令牌轮换争用。 */
    const val ACCESS_TOKEN_MARGIN_SECONDS = 300L

    /** @return 是否发生**瞬时**失败（网络/5xx/限流），供 Worker 决定退避重试。 */
    suspend fun refresh(context: Context, lease: SessionSnapshot): Boolean {
        val appContext = context.applicationContext
        return refresh(
            lease = lease,
            persistence = SessionStore(appContext),
            quotaRepository = QuotaRepository(),
            repository = DashboardRepository(appContext),
            quotaCache = QuotaCache(appContext),
            cache = DashboardCache(appContext),
            ranges = WidgetConfigStore.activeRanges(appContext).ifEmpty { setOf(RangeKey.Today) },
            quotaIdentity = nextQuotaWriteIdentity(appContext, lease.generation),
            timezoneId = TimeZone.getDefault().id.ifBlank { "UTC" }
        )
    }

    /** The production fetch-to-cache chain; injectable sources allow controlled race verification. */
    internal suspend fun refresh(
        lease: SessionSnapshot,
        persistence: SessionPersistence,
        quotaRepository: QuotaDataSource,
        repository: DashboardDataSource,
        quotaCache: QuotaCache,
        cache: DashboardCache,
        ranges: Set<RangeKey>,
        quotaIdentity: QuotaCacheWriteIdentity,
        timezoneId: String,
        nowMillis: () -> Long = System::currentTimeMillis
    ): Boolean {
        val session = lease.session ?: return false
        val guard = SessionWriteGuard(persistence, lease)
        var transientFailure = false
        try {
            guard.commit { }
            val snapshot = quotaRepository.fetchQuotaSnapshots(session)
            quotaCache.saveForSession(
                QuotaCacheKey(session.userId),
                QuotaCachedSnapshot(snapshot, nowMillis()),
                quotaIdentity.copy(sessionGeneration = lease.generation,
                    epoch = snapshot.epoch, revision = snapshot.revision),
                guard
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: SessionRevokedException) {
            return false
        } catch (error: Throwable) {
            if (isTransient(error)) transientFailure = true
        }

        var currentSession = session
        for (range in ranges) {
            try {
                guard.commit { }
                val query = DashboardQuery(range = range)
                val requestId = DashboardRequestIdentity.nextId()
                val (freshSession, stats) = repository.fetchStats(currentSession, query, entity = null)
                currentSession = freshSession
                cache.saveForSession(
                    DashboardCacheKey.from(session.userId, query, timezoneId, entity = null),
                    DashboardCachedSnapshot(stats = stats, savedAtEpochMillis = nowMillis()),
                    requestId,
                    guard
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: SessionRevokedException) {
                return false
            } catch (expired: DashboardAuthExpiredException) {
                transientFailure = false
                break
            } catch (error: Throwable) {
                if (isTransient(error)) transientFailure = true
            }
        }
        return transientFailure
    }

    /** 空投影也持久化版本水位；save 的原子版本裁决防止迟到空值清除较新额度。 */
    internal suspend fun persistQuotaSnapshot(
        cache: QuotaSnapshotStore,
        key: QuotaCacheKey,
        snapshot: QuotaTransportSnapshot,
        receivedAtEpochMillis: Long,
        identity: QuotaCacheWriteIdentity
    ) {
        cache.save(key, QuotaCachedSnapshot(snapshot, receivedAtEpochMillis), identity)
    }

    private fun nextQuotaWriteIdentity(
        context: Context,
        generation: Long
    ): QuotaCacheWriteIdentity = synchronized(this) {
        val prefs = context.getSharedPreferences(WRITER_PREFS, Context.MODE_PRIVATE)
        val writerId = prefs.getString(KEY_WRITER_ID, null) ?: ("widget-" + UUID.randomUUID())
        val previous = prefs.getLong(KEY_REQUEST_ID, 0L)
        check(previous < Long.MAX_VALUE) { "小组件请求序号已耗尽" }
        val requestId = previous + 1L
        check(prefs.edit().putString(KEY_WRITER_ID, writerId)
            .putLong(KEY_REQUEST_ID, requestId).commit()) { "小组件请求身份未可靠落盘" }
        QuotaCacheWriteIdentity(writerId, requestId, generation, 0L, 0L)
    }

    private fun isTransient(error: Throwable): Boolean = when (error) {
        is IOException -> true
        is SupabaseHttpException -> error.status == 408 || error.status == 429 || error.status >= 500
        else -> false
    }
}
