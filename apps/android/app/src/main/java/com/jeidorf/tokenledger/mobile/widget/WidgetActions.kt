package com.jeidorf.tokenledger.mobile.widget

import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.CancellationException

/**
 * 小组件轻量 ActionCallback（T8.5b）。全部走
 * `actionRunCallback<XxxAction>(actionParametersOf(...))`，就地重绘、不打开应用；
 * 参数只携带原始类型（Boolean），glanceId 由 Glance 注入以定位当前实例。
 *
 * 范围决策调用 WidgetCycling.kt 的纯函数，回写 [WidgetConfigStore] 后 [updateAll] 重绘
 * （复用上一阶段已验证的 updateAll 扩展；它按各实例自有配置逐一重渲染，语义正确）。
 * 任何异常静默吞掉，绝不让点击导致小组件崩溃或回灌成应用错误。
 */

private suspend fun GlanceId.appWidgetIdOrNull(context: Context): Int? =
    runCatching { GlanceAppWidgetManager(context).getAppWidgetId(this) }.getOrNull()

private suspend fun redraw(context: Context) {
    runCatching { TokenLedgerWidget().updateAll(context.applicationContext) }
}

/** 兼容旧用量卡 PendingIntent：今日→本周→本月循环；新范围可能未缓存，顺带触发一次拉取。 */
internal class CycleRangeAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters
    ) {
        try {
            val appWidgetId = glanceId.appWidgetIdOrNull(context) ?: return
            val config = WidgetConfigStore.load(context, appWidgetId)
            val next = nextWidgetRange(config.range)
            if (next != config.range) {
                WidgetConfigStore.save(context, appWidgetId, config.copy(range = next))
                // 新范围大概率无缓存：如实先显示「用量未同步」，后台拉取回来后 Worker 会再 updateAll。
                runCatching { WidgetScheduler.enqueueOneTimeRefresh(context) }
            }
            redraw(context)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
        }
    }
}

/** ⟳ 按钮 → 单次 expedited 刷新（降级策略见 WidgetScheduler.enqueueOneTimeRefresh）。 */
internal class ManualRefreshAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters
    ) {
        try {
            runCatching { WidgetScheduler.enqueueOneTimeRefresh(context) }
            // 立刻重绘一次，让时效角标随「刚触发」如实更新；真正的新数据由 Worker 完成后再推。
            redraw(context)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
        }
    }
}

/** 切换成本脱敏状态（敏感数据隐私保护）。 */
internal class ToggleCostPrivacyAction : ActionCallback {
    override suspend fun onAction(
        context: Context,
        glanceId: GlanceId,
        parameters: ActionParameters
    ) {
        try {
            com.jeidorf.tokenledger.mobile.PrivacyStore.toggleCostMaskEnabled(context)
            redraw(context)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
        }
    }
}
