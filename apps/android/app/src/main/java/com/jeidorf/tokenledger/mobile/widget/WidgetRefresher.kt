package com.jeidorf.tokenledger.mobile.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.CancellationException

/**
 * 应用内联动入口（T8.3）：应用完成一次额度/统计刷新并写回缓存后，调用此静态入口把
 * last-known-good 主动推送到桌面小组件。改动面最小化——只在 MainActivity 的一处
 * [androidx.compose.runtime.LaunchedEffect] 中按数据时间戳变化触发。
 */
internal object WidgetRefresher {
    /** 在协程上下文中调用（例如 LaunchedEffect）。失败静默，绝不影响应用主流程。 */
    suspend fun notifyDataChanged(context: Context) {
        try {
            TokenLedgerWidget().updateAll(context.applicationContext)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // 小组件推送失败不得回灌成应用错误。
        }
    }
}
