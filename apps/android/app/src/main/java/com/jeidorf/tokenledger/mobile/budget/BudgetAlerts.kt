package com.jeidorf.tokenledger.mobile.budget

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.WorkerParameters
import com.jeidorf.tokenledger.mobile.BuildConfig
import com.jeidorf.tokenledger.mobile.DashboardAuthExpiredException
import com.jeidorf.tokenledger.mobile.DashboardRepository
import com.jeidorf.tokenledger.mobile.R
import com.jeidorf.tokenledger.mobile.SessionRevokedException
import com.jeidorf.tokenledger.mobile.SupabaseGateway
import com.jeidorf.tokenledger.mobile.SupabaseHttpException
import com.jeidorf.tokenledger.mobile.BUDGET_SNAPSHOTS_READ_FUNCTION
import com.jeidorf.tokenledger.mobile.isMissingRpcSignature
import kotlinx.coroutines.CancellationException
import java.util.concurrent.TimeUnit

/**
 * 预算提醒本地通知（budget-snapshot-v1 §5）：开关、去重记录、定时读取与发通知。
 * 判断推哪几条在 [BudgetAlertPlanner]，这里只接 Android。
 */
internal class BudgetAlertStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, false)
        set(value) {
            // 每次打开都重新「起算」：当时已经接近或超出的预算只记下、不补发。
            prefs.edit().putBoolean(KEY_ENABLED, value).putBoolean(KEY_PRIME, value).apply()
        }

    /** 去重记录按账号绑定；换账号后从头起算。 */
    fun ledgerFor(account: String): Pair<Map<String, Long>, Boolean> {
        if (prefs.getString(KEY_ACCOUNT, null) != account) return emptyMap<String, Long>() to true
        return BudgetAlertPlanner.decodeLedger(prefs.getString(KEY_LEDGER, null)) to prefs.getBoolean(KEY_PRIME, true)
    }

    fun save(account: String, ledger: Map<String, Long>) {
        prefs.edit()
            .putString(KEY_ACCOUNT, account)
            .putString(KEY_LEDGER, BudgetAlertPlanner.encodeLedger(ledger))
            .putBoolean(KEY_PRIME, false)
            .apply()
    }

    var lastResult: String?
        get() = prefs.getString(KEY_RESULT, null)
        set(value) {
            prefs.edit().putString(KEY_RESULT, value).apply()
        }

    private companion object {
        const val PREFS = "tokenledger_budget_alerts"
        const val KEY_ENABLED = "enabled"
        const val KEY_PRIME = "prime"
        const val KEY_ACCOUNT = "account"
        const val KEY_LEDGER = "ledger"
        const val KEY_RESULT = "last_result"
    }
}

internal object BudgetAlertScheduler {
    private const val PERIODIC = "token_ledger_budget_alerts_periodic"
    private const val ONE_TIME = "token_ledger_budget_alerts_now"
    private const val INTERVAL_MINUTES = 30L

    private val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun sync(context: Context) {
        val manager = WorkManager.getInstance(context.applicationContext)
        if (!BudgetAlertStore(context).enabled) {
            manager.cancelUniqueWork(PERIODIC)
            return
        }
        val request = PeriodicWorkRequestBuilder<BudgetAlertWorker>(INTERVAL_MINUTES, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
            .build()
        manager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** 打开开关或回到前台时读一次，不等下一个周期。 */
    fun runNow(context: Context) {
        if (!BudgetAlertStore(context).enabled) return
        val request = OneTimeWorkRequestBuilder<BudgetAlertWorker>().setConstraints(constraints).build()
        WorkManager.getInstance(context.applicationContext)
            .enqueueUniqueWork(ONE_TIME, ExistingWorkPolicy.REPLACE, request)
    }
}

internal class BudgetAlertWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val context = applicationContext
        val store = BudgetAlertStore(context)
        if (!store.enabled) return Result.success()
        val repository = DashboardRepository(context)
        if (!repository.isConfigured) return Result.success()
        val gateway = SupabaseGateway(
            supabaseUrl = BuildConfig.TOKENLEDGER_SUPABASE_URL,
            publishableKey = BuildConfig.TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY
        )
        var account: String? = null
        val snapshots = try {
            repository.readWithStoredSession({ account = it }) { session ->
                BudgetSnapshots.parse(gateway.fetchBudgetSnapshots(session))
            } ?: return Result.success().also { store.lastResult = RESULT_SIGNED_OUT }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: SessionRevokedException) {
            store.lastResult = RESULT_SIGNED_OUT
            return Result.success()
        } catch (_: DashboardAuthExpiredException) {
            store.lastResult = RESULT_SIGNED_OUT
            return Result.success()
        } catch (error: SupabaseHttpException) {
            if (error.isMissingRpcSignature(BUDGET_SNAPSHOTS_READ_FUNCTION)) {
                store.lastResult = RESULT_NOT_DEPLOYED
                return Result.success()
            }
            store.lastResult = RESULT_FAILED
            return Result.retry()
        } catch (_: BudgetSnapshotFormatException) {
            store.lastResult = RESULT_FAILED
            return Result.success()
        } catch (_: Exception) {
            store.lastResult = RESULT_FAILED
            return Result.retry()
        }
        // 读的过程中关掉了开关：什么也不推。
        if (!store.enabled) return Result.success()
        val owner = checkNotNull(account)
        val (ledger, prime) = store.ledgerFor(owner)
        val plan = BudgetAlertPlanner.plan(snapshots, ledger, System.currentTimeMillis(), prime)
        val posted = BudgetAlertNotifier.post(context, plan.notifications)
        // 没有通知权限时不记为已推，授权后下次读取再推。
        store.save(owner, if (posted || plan.notifications.isEmpty()) plan.ledger else ledger)
        store.lastResult = if (snapshots.isEmpty()) RESULT_NO_DESKTOP else RESULT_OK
        return Result.success()
    }

    companion object {
        const val RESULT_OK = "ok"
        const val RESULT_NO_DESKTOP = "no-desktop"
        const val RESULT_SIGNED_OUT = "signed-out"
        const val RESULT_NOT_DEPLOYED = "not-deployed"
        const val RESULT_FAILED = "failed"
    }
}

internal object BudgetAlertNotifier {
    const val CHANNEL_ID = "budget_alerts"

    fun canPost(context: Context): Boolean =
        (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED) &&
            NotificationManagerCompat.from(context).areNotificationsEnabled()

    /** 返回 false 表示没有通知权限，一条也没发。 */
    fun post(context: Context, notifications: List<BudgetNotification>): Boolean {
        if (notifications.isEmpty()) return true
        if (!canPost(context)) return false
        ensureChannel(context)
        val manager = NotificationManagerCompat.from(context)
        notifications.forEach { item ->
            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher_monochrome)
                .setContentTitle(item.title)
                .setContentText(item.body)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true)
                .setContentIntent(
                    context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
                        android.app.PendingIntent.getActivity(
                            context, 0, it,
                            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT
                        )
                    }
                )
                .build()
            try {
                manager.notify(item.key.hashCode(), notification)
            } catch (_: SecurityException) {
                return false
            }
        }
        return true
    }

    private fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "预算提醒", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "桌面端预算接近或超出上限时提醒"
            }
        )
    }
}
