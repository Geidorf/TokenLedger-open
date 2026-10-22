package com.jeidorf.tokenledger.mobile.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import com.jeidorf.tokenledger.mobile.RangeKey

/**
 * 每实例配置存储（T8.2 骨架）。跟随项目现有存储风格使用 [android.content.SharedPreferences]，
 * 按 appWidgetId 键控（参考 QuotaCache/DashboardCache 的 prefs 命名）。写入路径在 T8.5
 * （配置 Activity + 组件内切换）完成，本阶段仅提供默认值读取与批量枚举。
 */
internal object WidgetConfigStore {
    private const val PREFS_NAME = "tokenledger_widget_config"
    private const val KEY_MODE = "mode_"
    private const val KEY_PROVIDER = "provider_"
    private const val KEY_RANGE = "range_"
    private const val KEY_THEME = "theme_"

    fun load(context: Context, appWidgetId: Int, defaultMode: WidgetMode = WidgetMode.BarUsage): WidgetConfig {
        val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val storedMode = prefs.getString(KEY_MODE + appWidgetId, null)
        val mode = if (storedMode != null) WidgetMode.fromStorage(storedMode) else defaultMode
        return WidgetConfig(
            mode = mode,
            providerId = prefs.getString(KEY_PROVIDER + appWidgetId, null)?.takeIf(String::isNotBlank),
            range = WidgetRange.fromStorage(prefs.getString(KEY_RANGE + appWidgetId, null)),
            theme = WidgetThemeMode.fromStorage(prefs.getString(KEY_THEME + appWidgetId, null))
        )
    }

    fun save(context: Context, appWidgetId: Int, config: WidgetConfig) {
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_MODE + appWidgetId, config.mode.storageValue)
            .putString(KEY_PROVIDER + appWidgetId, config.providerId)
            .putString(KEY_RANGE + appWidgetId, config.range.storageValue)
            .putString(KEY_THEME + appWidgetId, config.theme.storageValue)
            .apply()
    }

    /** 升级后把公开 Provider 的类型纠正为组件声明值，同时保留来源/范围/主题。 */
    fun lockMode(context: Context, appWidgetId: Int, mode: WidgetMode) {
        val current = load(context, appWidgetId, defaultMode = mode)
        if (current.mode != mode) save(context, appWidgetId, current.copy(mode = mode))
    }

    fun remove(context: Context, appWidgetId: Int) {
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_MODE + appWidgetId)
            .remove(KEY_PROVIDER + appWidgetId)
            .remove(KEY_RANGE + appWidgetId)
            .remove(KEY_THEME + appWidgetId)
            .apply()
    }

    /** 已安装实例配置涉及的统计范围集合，供后台刷新 Worker 按需预取。 */
    fun activeRanges(context: Context): Set<RangeKey> {
        val appContext = context.applicationContext
        val ids = installedWidgetIds(appContext)
        if (ids.isEmpty()) return emptySet()
        return ids.map { load(appContext, it).range.rangeKey }.toSet()
    }

    fun installedWidgetIds(context: Context): IntArray {
        val appContext = context.applicationContext
        val manager = AppWidgetManager.getInstance(appContext)
        val receivers = listOf(
            TokenLedgerWidgetReceiver::class.java,
            TokenLedgerRingWidgetReceiver::class.java,
            TokenLedgerBarWidgetReceiver::class.java,
            TokenLedgerComboWidgetReceiver::class.java
        )
        return receivers.flatMap { receiver ->
            val component = ComponentName(appContext, receiver)
            runCatching { manager.getAppWidgetIds(component).toList() }.getOrDefault(emptyList())
        }.toIntArray()
    }
}
