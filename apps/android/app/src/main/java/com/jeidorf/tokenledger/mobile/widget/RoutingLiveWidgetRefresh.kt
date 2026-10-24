package com.jeidorf.tokenledger.mobile.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.WorkerParameters
import com.jeidorf.tokenledger.mobile.SessionStore
import com.jeidorf.tokenledger.mobile.routing.RoutingRepository
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException

/**
 * 实时路由小组件的 last-known 一帧（[RoutingLiveSnapshot]）。只存节点名、最近 3 条调用与年龄，
 * 不存设备名与任何凭据；按账号绑定，读取时账号不符就当没有。
 */
internal object RoutingLiveStore {
    private const val PREFS_NAME = "tokenledger_widget_routing_live"
    private const val KEY_SNAPSHOT = "snapshot"

    fun load(context: Context, userId: String): RoutingLiveSnapshot? =
        runCatching {
            context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(KEY_SNAPSHOT, null)
        }.getOrNull()
            ?.let(::decodeRoutingLiveSnapshot)
            ?.takeIf { it.userId == userId }

    /** 同步落盘：调用方在会话写入锁内调用，锁内必须写完。 */
    fun save(context: Context, snapshot: RoutingLiveSnapshot) {
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SNAPSHOT, encodeRoutingLiveSnapshot(snapshot))
            .commit()
    }
}

internal object RoutingLiveWidgets {
    fun installedIds(context: Context): IntArray {
        val appContext = context.applicationContext
        return runCatching {
            AppWidgetManager.getInstance(appContext)
                .getAppWidgetIds(ComponentName(appContext, RoutingLiveWidgetReceiver::class.java))
        }.getOrNull() ?: IntArray(0)
    }

    fun installed(context: Context): Boolean = installedIds(context).isNotEmpty()

    /** 重绘全部实时路由小组件；失败静默。 */
    suspend fun redraw(context: Context) {
        try {
            RoutingLiveWidget().updateAll(context.applicationContext)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
        }
    }
}

/**
 * 近实时读取链：桌面在线时 3 分钟（有调用）或 10 分钟（空闲）单独读一次路由快照，只读这一份、
 * 不连带额度与用量。桌面离线、没开同步、需重新登录时链停下，交回 30 分钟的共用周期刷新，
 * 那一轮读到桌面又在线时再接上（[kick]）。系统省电（Doze）会把间隔再拉长，卡片按真实年龄写「N 分钟前」。
 */
internal object RoutingLiveScheduler {
    private const val WORK_NAME = "token_ledger_routing_live_refresh"

    /** 立刻读一次（添加小组件时）；已有排队的就不重复。 */
    fun enqueueNow(context: Context) = enqueue(context, 0L, ExistingWorkPolicy.KEEP)

    /** 共用周期刷新读到桌面在线时接上链；已有排队的就不动它。 */
    fun kick(context: Context, delayMs: Long) = enqueue(context, delayMs, ExistingWorkPolicy.KEEP)

    /** 由链上的 Worker 自己排下一次：接在当前这次后面，不取消正在跑的自己。 */
    fun scheduleNext(context: Context, delayMs: Long) = enqueue(context, delayMs, ExistingWorkPolicy.APPEND_OR_REPLACE)

    fun cancel(context: Context) {
        WorkManager.getInstance(context.applicationContext).cancelUniqueWork(WORK_NAME)
    }

    private fun enqueue(context: Context, delayMs: Long, policy: ExistingWorkPolicy) {
        val request = OneTimeWorkRequestBuilder<RoutingLiveRefreshWorker>()
            .setInitialDelay(delayMs.coerceAtLeast(0L), TimeUnit.MILLISECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(WORK_NAME, policy, request)
    }
}

/**
 * 链上的一次读取。会话规则与 [WidgetRefreshWorker] 相同：访问令牌余量不足时不在后台读
 * （刷新令牌一次性轮换，不和前台抢），这时链停下，等应用前台续期后的周期刷新再接上。
 */
internal class RoutingLiveRefreshWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val context = applicationContext
        if (!RoutingLiveWidgets.installed(context)) return Result.success()
        val store = SessionStore(context)
        val lease = runCatching { store.snapshot() }.getOrNull()
        val session = lease?.session
        if (session == null) {
            RoutingLiveWidgets.redraw(context)
            return Result.success()
        }
        val nowSeconds = System.currentTimeMillis() / 1000L
        if (session.expiresAtEpochSeconds <= nowSeconds + WidgetRefreshWriter.ACCESS_TOKEN_MARGIN_SECONDS) {
            RoutingLiveWidgets.redraw(context)
            return Result.success()
        }
        try {
            WidgetRefreshWriter.refreshRouting(
                lease = lease,
                persistence = store,
                source = RoutingRepository(),
                save = { summary -> WidgetRoutingStore.save(context, summary) },
                saveLive = { snapshot -> RoutingLiveStore.save(context, snapshot) }
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // 读失败保留上一帧；下一次由周期刷新兜底。
        }
        RoutingLiveWidgets.redraw(context)
        if (runCatching { WidgetConfigStore.quotaRoutingRequested(context) }.getOrDefault(false)) {
            runCatching { TokenLedgerWidget().updateAll(context) }
        }
        routingLiveNextDelayMs(RoutingLiveStore.load(context, session.userId))?.let { delay ->
            runCatching { RoutingLiveScheduler.scheduleNext(context, delay) }
        }
        return Result.success()
    }
}
