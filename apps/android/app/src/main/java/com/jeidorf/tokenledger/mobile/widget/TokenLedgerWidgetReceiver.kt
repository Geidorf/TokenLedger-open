package com.jeidorf.tokenledger.mobile.widget

import android.content.Context
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

/**
 * 小组件 [android.appwidget.AppWidgetProvider] 入口家族（T8.2）。
 * 针对系统桌面小组件选择器分别提供预设组件：
 *  - 默认/通用：[TokenLedgerWidgetReceiver]
 *  - 环形额度卡 (2×2)：[TokenLedgerRingWidgetReceiver]
 *  - 条形额度卡 (4×1)：[TokenLedgerBarWidgetReceiver]
 *  - 综合看板卡 (4×2)：[TokenLedgerComboWidgetReceiver]
 */
internal open class BaseTokenLedgerWidgetReceiver(
    private val mode: WidgetMode,
    private val fixedMode: Boolean
) : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget
        get() = TokenLedgerWidget(mode, fixedMode)

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        runCatching { WidgetScheduler.ensurePeriodicRefresh(context) }
        runCatching { WidgetScheduler.enqueueOneTimeRefresh(context) }
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: android.appwidget.AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        if (fixedMode) {
            appWidgetIds.forEach { WidgetConfigStore.lockMode(context, it, mode) }
        }
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        runCatching { WidgetScheduler.ensurePeriodicRefresh(context) }
        runCatching { WidgetScheduler.enqueueOneTimeRefresh(context) }
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        appWidgetIds.forEach { WidgetConfigStore.remove(context, it) }
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        runCatching {
            if (shouldCancelWidgetRefresh(WidgetConfigStore.installedWidgetIds(context).size)) {
                WidgetScheduler.cancelPeriodicRefresh(context)
            }
        }
    }
}

/** 已发布过的通用 Receiver：从选择器隐藏，但继续承接旧 Launcher 实例与旧 mode。 */
internal class TokenLedgerWidgetReceiver :
    BaseTokenLedgerWidgetReceiver(WidgetMode.BarUsage, fixedMode = false)

internal class TokenLedgerRingWidgetReceiver :
    BaseTokenLedgerWidgetReceiver(WidgetMode.MultiRing, fixedMode = true)

internal class TokenLedgerBarWidgetReceiver :
    BaseTokenLedgerWidgetReceiver(WidgetMode.SingleUsage, fixedMode = true)

internal class TokenLedgerComboWidgetReceiver :
    BaseTokenLedgerWidgetReceiver(WidgetMode.BarUsage, fixedMode = true)
