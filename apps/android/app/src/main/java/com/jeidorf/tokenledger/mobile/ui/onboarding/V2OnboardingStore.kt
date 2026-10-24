package com.jeidorf.tokenledger.mobile.ui.onboarding

import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * 打开首次启动引导。看板外壳提供它；空状态卡里的「查看接入步骤」用它，
 * 没有提供者（单独预览某张卡）时为 null，按钮就不画。
 */
internal val LocalOpenFirstRunGuide = staticCompositionLocalOf<(() -> Unit)?> { null }

/** 引导的去留只存在这台手机上：跳过或完成后不再自动打开。 */
internal object V2OnboardingStore {
    private const val PREFS_NAME = "tokenledger_onboarding"
    private const val KEY_FIRST_RUN = "first_run_v1"

    fun read(context: Context): V2OnboardingVisibility? = runCatching {
        val raw = context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_FIRST_RUN, null)
        V2OnboardingVisibility.entries.firstOrNull { it.name == raw }
    }.getOrNull()

    fun write(context: Context, value: V2OnboardingVisibility) {
        runCatching {
            context.applicationContext
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_FIRST_RUN, value.name)
                .apply()
        }
    }
}
