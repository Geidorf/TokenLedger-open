package com.jeidorf.tokenledger.mobile.widget

import android.content.Context

/**
 * 额度条路由行的 last-known 摘要（[WidgetRoutingSummary]）。只存「谁的请求、发往哪个供应商/模型、多久之前」，
 * 不存设备名与任何凭据；按账号绑定，读取时账号不符就当没有。后台刷新写、小组件渲染读。
 */
internal object WidgetRoutingStore {
    private const val PREFS_NAME = "tokenledger_widget_routing"
    private const val KEY_SUMMARY = "summary"

    fun load(context: Context, userId: String): WidgetRoutingSummary? =
        runCatching {
            context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(KEY_SUMMARY, null)
        }.getOrNull()
            ?.let(::decodeWidgetRoutingSummary)
            ?.takeIf { it.userId == userId }

    /** 同步落盘：调用方在会话写入锁内调用，锁内必须写完。 */
    fun save(context: Context, summary: WidgetRoutingSummary) {
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SUMMARY, encodeWidgetRoutingSummary(summary))
            .commit()
    }

    fun clear(context: Context) {
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_SUMMARY)
            .apply()
    }
}
