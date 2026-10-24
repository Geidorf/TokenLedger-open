package com.jeidorf.tokenledger.mobile.tile

import android.content.Context

/**
 * 快捷设置磁贴是否已加进通知栏，以及上次因磁贴触发后台刷新的时间。只存这两项，不存任何数据。
 * 共用周期刷新据此判断磁贴还是不是使用者（[com.jeidorf.tokenledger.mobile.widget.WidgetConfigStore.backgroundConsumerCount]）。
 */
internal object QuickTileStore {
    private const val PREFS_NAME = "tokenledger_quick_tile"
    private const val KEY_ADDED = "added"
    private const val KEY_LAST_KICK = "lastKick"

    /** 展开通知栏最多这么久触发一次后台刷新，免得反复下拉把刷新排满。 */
    const val KICK_INTERVAL_MS = 10 * 60_000L

    fun isAdded(context: Context): Boolean = runCatching {
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getBoolean(KEY_ADDED, false)
    }.getOrDefault(false)

    fun setAdded(context: Context, added: Boolean) {
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_ADDED, added)
            .apply()
    }

    /** 距上次触发已超过 [KICK_INTERVAL_MS] 时记下这次并返回 true。 */
    fun shouldKick(context: Context, nowMillis: Long): Boolean {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val last = prefs.getLong(KEY_LAST_KICK, 0L)
        if (!quickTileKickDue(last, nowMillis)) return false
        prefs.edit().putLong(KEY_LAST_KICK, nowMillis).apply()
        return true
    }
}

/** 墙钟回拨（上次时间在未来）也算到期，不让磁贴永远不刷新。 */
internal fun quickTileKickDue(lastKickMillis: Long, nowMillis: Long): Boolean =
    lastKickMillis > nowMillis || nowMillis - lastKickMillis >= QuickTileStore.KICK_INTERVAL_MS
