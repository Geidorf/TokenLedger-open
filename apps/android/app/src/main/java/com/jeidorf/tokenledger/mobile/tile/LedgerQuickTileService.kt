package com.jeidorf.tokenledger.mobile.tile

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.jeidorf.tokenledger.mobile.MainActivity
import com.jeidorf.tokenledger.mobile.PrivacyStore
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.widget.WidgetConfigStore
import com.jeidorf.tokenledger.mobile.widget.WidgetScheduler
import com.jeidorf.tokenledger.mobile.widget.WidgetStateRepository
import com.jeidorf.tokenledger.mobile.widget.shouldCancelWidgetRefresh
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * 快捷设置磁贴：下拉通知栏时显示最紧额度的「可用 N%」（或今日预估费用），点按打开 TokenLedger。
 * 内容见 [quickTileContent]。磁贴每次可见时（[onStartListening]）重读本地缓存；缓存由应用与
 * 共用周期刷新写入，磁贴加进通知栏后周期刷新就把它算作使用者。
 */
class LedgerQuickTileService : TileService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var loading: Job? = null

    override fun onTileAdded() {
        super.onTileAdded()
        QuickTileStore.setAdded(this, true)
        runCatching { WidgetScheduler.ensurePeriodicRefresh(this) }
        runCatching { WidgetScheduler.enqueueOneTimeRefresh(this) }
    }

    override fun onTileRemoved() {
        super.onTileRemoved()
        QuickTileStore.setAdded(this, false)
        runCatching {
            if (shouldCancelWidgetRefresh(WidgetConfigStore.backgroundConsumerCount(this))) {
                WidgetScheduler.cancelPeriodicRefresh(this)
            }
        }
    }

    override fun onStartListening() {
        super.onStartListening()
        // 老系统升级上来时磁贴可能早已在通知栏，却没收到过 onTileAdded。
        if (!QuickTileStore.isAdded(this)) {
            QuickTileStore.setAdded(this, true)
            runCatching { WidgetScheduler.ensurePeriodicRefresh(this) }
        }
        if (QuickTileStore.shouldKick(this, System.currentTimeMillis())) {
            runCatching { WidgetScheduler.enqueueOneTimeRefresh(this) }
        }
        loading?.cancel()
        loading = scope.launch {
            val state = runCatching { WidgetStateRepository(applicationContext).load(RangeKey.Today) }.getOrNull()
                ?: return@launch
            val content = quickTileContent(
                state = state,
                costMasked = PrivacyStore.isCostMaskEnabled(applicationContext),
                supportsSubtitle = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q,
                todayStartEpochMs = LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
            )
            render(content)
        }
    }

    override fun onStopListening() {
        loading?.cancel()
        super.onStopListening()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun render(content: QuickTileContent) {
        val tile = qsTile ?: return
        tile.label = content.label
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) tile.subtitle = content.subtitle
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) tile.stateDescription = content.stateDescription
        tile.contentDescription = listOfNotNull(content.label, content.subtitle).joinToString("，")
        tile.state = if (content.active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        if (isLocked) unlockAndRun { openApp() } else openApp()
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    @Suppress("DEPRECATION")
    private fun openApp() {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val pending = PendingIntent.getActivity(
                this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
            startActivityAndCollapse(pending)
        } else {
            startActivityAndCollapse(intent)
        }
    }

    companion object {
        /** 数据变了：请系统在磁贴下次可见前重新回调 [onStartListening]。没加磁贴时什么也不做。 */
        fun requestUpdate(context: Context) {
            if (!QuickTileStore.isAdded(context)) return
            requestListeningState(context, ComponentName(context, LedgerQuickTileService::class.java))
        }
    }
}
