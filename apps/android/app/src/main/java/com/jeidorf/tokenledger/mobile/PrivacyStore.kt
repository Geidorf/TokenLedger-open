package com.jeidorf.tokenledger.mobile

import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf

internal val LocalCostMaskEnabled = staticCompositionLocalOf { false }
internal val LocalToggleCostMask = staticCompositionLocalOf<() -> Unit> { {} }
internal val LocalDashboardCurrency = staticCompositionLocalOf { CurrencyUnit.DEFAULT }
internal val LocalSetDashboardCurrency = staticCompositionLocalOf<(CurrencyUnit) -> Unit> { {} }

/**
 * 「隐藏费用」存储（T8.10；叫法按 T10.154 A23）。全局控制预估费用的脱敏显示状态（¥***.*）。
 * 选项经 SharedPreferences 持久化，主应用与桌面小组件共享这一状态。
 * 这只是显示层遮蔽：不删除、不加密也不阻止本地缓存或已启用的云同步。
 */
internal object PrivacyStore {
    private const val PREFS_NAME = "tokenledger_privacy"
    private const val KEY_COST_MASK = "cost_mask_enabled"
    private const val KEY_CURRENCY = "preferred_currency"

    fun getPreferredCurrency(context: Context): CurrencyUnit {
        val raw = context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_CURRENCY, null)
        return CurrencyUnit.fromStored(raw, fallback = CurrencyUnit.DEFAULT)
    }

    fun setPreferredCurrency(context: Context, currency: CurrencyUnit) {
        context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_CURRENCY, currency.code)
            .apply()
    }

    fun isCostMaskEnabled(context: Context): Boolean {
        return context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getBoolean(KEY_COST_MASK, false)
    }

    fun setCostMaskEnabled(context: Context, enabled: Boolean) {
        context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_COST_MASK, enabled)
            .apply()
    }

    fun toggleCostMaskEnabled(context: Context): Boolean {
        val next = !isCostMaskEnabled(context)
        setCostMaskEnabled(context, next)
        return next
    }

    fun observeCostMask(context: Context, onChanged: (Boolean) -> Unit): () -> Unit {
        val preferences = context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val listener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { shared, key ->
            if (key == KEY_COST_MASK) {
                onChanged(shared.getBoolean(KEY_COST_MASK, false))
            }
        }
        preferences.registerOnSharedPreferenceChangeListener(listener)
        return { preferences.unregisterOnSharedPreferenceChangeListener(listener) }
    }
}
