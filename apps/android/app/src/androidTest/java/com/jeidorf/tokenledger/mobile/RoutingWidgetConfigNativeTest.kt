package com.jeidorf.tokenledger.mobile

import android.Manifest
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.jeidorf.tokenledger.mobile.widget.RoutingLiveWidgetReceiver
import com.jeidorf.tokenledger.mobile.widget.WidgetConfig
import com.jeidorf.tokenledger.mobile.widget.WidgetConfigStore
import com.jeidorf.tokenledger.mobile.widget.WidgetConfigureActivity
import com.jeidorf.tokenledger.mobile.widget.WidgetMode
import com.jeidorf.tokenledger.mobile.widget.WidgetRange
import com.jeidorf.tokenledger.mobile.widget.WidgetThemeMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.Rule
import org.junit.runner.RunWith

/** 路由配置只改当前实例主题；取消不落盘，删除不污染相邻实例。 */
@RunWith(AndroidJUnit4::class)
class RoutingWidgetConfigNativeTest {
    @get:Rule val compose = createEmptyComposeRule()

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext

    @Test
    fun themePersistsPerInstanceAndPreservesOtherFields() {
        val first = TEST_ID_BASE + 1
        val second = TEST_ID_BASE + 2
        try {
            val original = WidgetConfig(
                mode = WidgetMode.BarUsage,
                providerId = "provider-a",
                range = WidgetRange.Week,
                theme = WidgetThemeMode.System,
                showRouting = true
            )
            WidgetConfigStore.save(context, first, original)
            WidgetConfigStore.save(context, second, original.copy(theme = WidgetThemeMode.Light))

            WidgetConfigStore.save(context, first, original.copy(theme = WidgetThemeMode.Dark))

            val firstSaved = WidgetConfigStore.load(context, first)
            assertEquals(WidgetThemeMode.Dark, firstSaved.theme)
            assertEquals(original.copy(theme = WidgetThemeMode.Dark), firstSaved)
            assertEquals(WidgetThemeMode.Light, WidgetConfigStore.load(context, second).theme)
        } finally {
            WidgetConfigStore.remove(context, first)
            WidgetConfigStore.remove(context, second)
        }
    }

    @Test
    fun deletingOneInstanceKeepsOtherThemes() {
        val host = AppWidgetHost(context, TEST_HOST_ID)
        val deleted = host.allocateAppWidgetId()
        val kept = host.allocateAppWidgetId()
        try {
            val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
            automation.adoptShellPermissionIdentity(Manifest.permission.BIND_APPWIDGET)
            try {
                val manager = AppWidgetManager.getInstance(context)
                val provider = ComponentName(context, RoutingLiveWidgetReceiver::class.java)
                assertTrue(manager.bindAppWidgetIdIfAllowed(deleted, provider))
                assertTrue(manager.bindAppWidgetIdIfAllowed(kept, provider))
            } finally {
                automation.dropShellPermissionIdentity()
            }
            WidgetConfigStore.save(context, deleted, WidgetConfig(theme = WidgetThemeMode.Dark))
            WidgetConfigStore.save(context, kept, WidgetConfig(theme = WidgetThemeMode.Light))

            // 由系统投递删除广播，为 Glance 的异步清理提供真实 PendingResult。
            host.deleteAppWidgetId(deleted)
            compose.waitUntil(timeoutMillis = 5_000) {
                WidgetConfigStore.load(context, deleted).theme == WidgetThemeMode.System
            }

            assertEquals(WidgetThemeMode.System, WidgetConfigStore.load(context, deleted).theme)
            assertEquals(WidgetThemeMode.Light, WidgetConfigStore.load(context, kept).theme)
        } finally {
            host.deleteAppWidgetId(deleted)
            host.deleteAppWidgetId(kept)
            WidgetConfigStore.remove(context, deleted)
            WidgetConfigStore.remove(context, kept)
        }
    }

    @Test
    fun cancelReturnsAppWidgetIdWithoutChangingCurrentOrOtherInstance() {
        val host = AppWidgetHost(context, TEST_HOST_ID)
        val current = host.allocateAppWidgetId()
        val other = host.allocateAppWidgetId()
        var scenario: ActivityScenario<WidgetConfigureActivity>? = null
        try {
            bindRoutingWidgets(current, other)
            val currentConfig = WidgetConfig(
                providerId = "provider-a",
                range = WidgetRange.Week,
                theme = WidgetThemeMode.Light,
                showRouting = true
            )
            val otherConfig = WidgetConfig(theme = WidgetThemeMode.Dark)
            WidgetConfigStore.save(context, current, currentConfig)
            WidgetConfigStore.save(context, other, otherConfig)

            scenario = launchConfigure(current)
            compose.onNodeWithText(context.getString(R.string.routing_widget_config_theme_dark)).performClick()
            compose.onNodeWithText(context.getString(R.string.routing_widget_config_cancel)).performClick()

            val result = scenario.getResult()
            assertEquals(android.app.Activity.RESULT_CANCELED, result.resultCode)
            assertEquals(
                current,
                result.resultData.getIntExtra(
                    AppWidgetManager.EXTRA_APPWIDGET_ID,
                    AppWidgetManager.INVALID_APPWIDGET_ID
                )
            )
            assertEquals(currentConfig, WidgetConfigStore.load(context, current))
            assertEquals(otherConfig, WidgetConfigStore.load(context, other))
        } finally {
            scenario?.close()
            host.deleteAppWidgetId(current)
            host.deleteAppWidgetId(other)
            WidgetConfigStore.remove(context, current)
            WidgetConfigStore.remove(context, other)
        }
    }

    @Test
    fun saveReturnsCurrentIdAndThemeWithoutChangingOtherInstance() {
        val host = AppWidgetHost(context, TEST_HOST_ID)
        val current = host.allocateAppWidgetId()
        val other = host.allocateAppWidgetId()
        var scenario: ActivityScenario<WidgetConfigureActivity>? = null
        try {
            bindRoutingWidgets(current, other)
            val original = WidgetConfig(
                providerId = "provider-a",
                range = WidgetRange.Week,
                theme = WidgetThemeMode.System,
                showRouting = true
            )
            val otherConfig = WidgetConfig(theme = WidgetThemeMode.Light)
            WidgetConfigStore.save(context, current, original)
            WidgetConfigStore.save(context, other, otherConfig)

            scenario = launchConfigure(current)
            compose.onNodeWithText(context.getString(R.string.routing_widget_config_theme_dark)).performClick()
            compose.onNodeWithText(context.getString(R.string.routing_widget_config_save)).performClick()

            val result = scenario.getResult()
            assertEquals(android.app.Activity.RESULT_OK, result.resultCode)
            assertEquals(
                current,
                result.resultData.getIntExtra(
                    AppWidgetManager.EXTRA_APPWIDGET_ID,
                    AppWidgetManager.INVALID_APPWIDGET_ID
                )
            )
            assertEquals(
                original.copy(theme = WidgetThemeMode.Dark),
                WidgetConfigStore.load(context, current)
            )
            assertEquals(otherConfig, WidgetConfigStore.load(context, other))
        } finally {
            scenario?.close()
            host.deleteAppWidgetId(current)
            host.deleteAppWidgetId(other)
            WidgetConfigStore.remove(context, current)
            WidgetConfigStore.remove(context, other)
        }
    }

    private fun bindRoutingWidgets(vararg appWidgetIds: Int) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.adoptShellPermissionIdentity(Manifest.permission.BIND_APPWIDGET)
        try {
            val manager = AppWidgetManager.getInstance(context)
            val provider = ComponentName(context, RoutingLiveWidgetReceiver::class.java)
            appWidgetIds.forEach { id ->
                assertTrue(manager.bindAppWidgetIdIfAllowed(id, provider))
            }
        } finally {
            automation.dropShellPermissionIdentity()
        }
    }

    private fun launchConfigure(appWidgetId: Int): ActivityScenario<WidgetConfigureActivity> {
        val intent = Intent(context, WidgetConfigureActivity::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        return ActivityScenario.launchActivityForResult(intent)
    }

    private companion object {
        const val TEST_ID_BASE = -122_000
        const val TEST_HOST_ID = 122
    }
}
