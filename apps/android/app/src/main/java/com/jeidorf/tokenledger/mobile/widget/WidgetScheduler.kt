package com.jeidorf.tokenledger.mobile.widget

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import java.util.concurrent.TimeUnit

/**
 * WorkManager 周期刷新调度（T8.3）。周期 30 分钟（> 系统下限 15 分钟，兼顾电量）。
 * 网络约束设为"任意"（[NetworkType.NOT_REQUIRED]），使离线时也能重绘时效角标，
 * 在线时由 Worker 自行尝试拉取；失败走指数退避。BootCompleted 不做（保守）——
 * 首次登录后由应用前台入队。
 */
internal object WidgetScheduler {
    private const val UNIQUE_WORK_NAME = "token_ledger_widget_periodic_refresh"
    private const val ONE_TIME_WORK_NAME = "token_ledger_widget_manual_refresh"
    private const val REFRESH_INTERVAL_MINUTES = 30L

    fun ensurePeriodicRefresh(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.NOT_REQUIRED)
            .build()
        val request = PeriodicWorkRequestBuilder<WidgetRefreshWorker>(
            REFRESH_INTERVAL_MINUTES,
            TimeUnit.MINUTES
        )
            .setConstraints(constraints)
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                WorkRequest.MIN_BACKOFF_MILLIS,
                TimeUnit.MILLISECONDS
            )
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
            UNIQUE_WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            request
        )
    }

    fun cancelPeriodicRefresh(context: Context) {
        WorkManager.getInstance(context.applicationContext).cancelUniqueWork(UNIQUE_WORK_NAME)
    }

    /**
     * 手动 ⟳（T8.5b）：单次 expedited 刷新。setExpedited 让系统尽量前台加速，配额耗尽时
     * 降级为普通任务（[OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST]）而非抛错。
     * 复用 [WidgetRefreshWorker]（同一份拉取 + updateAll），KEEP 去抖避免连点堆叠。
     */
    fun enqueueOneTimeRefresh(context: Context) {
        val request = OneTimeWorkRequestBuilder<WidgetRefreshWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                WorkRequest.MIN_BACKOFF_MILLIS,
                TimeUnit.MILLISECONDS
            )
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            ONE_TIME_WORK_NAME,
            ExistingWorkPolicy.KEEP,
            request
        )
    }
}
