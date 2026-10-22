package com.jeidorf.tokenledger.mobile.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.jeidorf.tokenledger.mobile.SessionStore
import kotlinx.coroutines.CancellationException

/**
 * WorkManager 周期刷新 Worker（T8.3，30 分钟）。未登录时不拉取网络，但只要仍有任一
 * Provider 实例就保留共享任务并重绘“需要登录”引导态。拉取由 [WidgetRefreshWriter]
 * 负责（复用既有仓库层），瞬时失败返回 [Result.retry] 走退避。无论成败都调用
 * [updateAll]，让时效角标/过期态如实随时间刷新。
 */
internal class WidgetRefreshWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val context = applicationContext
        val lease = runCatching { SessionStore(context).snapshot() }.getOrNull()
        val session = lease?.session
        if (session == null) {
            // 已登出仍保留全局任务，让现存实例持续重绘“需要登录”状态；只有所有
            // Provider 都没有实例时才取消，避免某个 Provider 的生命周期误伤其他卡片。
            if (shouldCancelWidgetRefresh(WidgetConfigStore.installedWidgetIds(context).size)) {
                runCatching { WidgetScheduler.cancelPeriodicRefresh(context) }
            }
            runCatching { TokenLedgerWidget().updateAll(context) }
            return Result.success()
        }

        var transientFailure = false
        val nowSeconds = System.currentTimeMillis() / 1000L
        if (session.expiresAtEpochSeconds > nowSeconds + WidgetRefreshWriter.ACCESS_TOKEN_MARGIN_SECONDS) {
            transientFailure = try {
                WidgetRefreshWriter.refresh(context, lease)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                true
            }
        }

        runCatching { TokenLedgerWidget().updateAll(context) }
        return if (transientFailure) Result.retry() else Result.success()
    }
}
