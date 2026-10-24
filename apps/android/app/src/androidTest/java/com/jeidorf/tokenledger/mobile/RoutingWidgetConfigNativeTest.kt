package com.jeidorf.tokenledger.mobile

import android.Manifest
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.jeidorf.tokenledger.mobile.widget.RoutingWidgetConfigureScreen
import com.jeidorf.tokenledger.mobile.widget.RoutingLiveWidgetReceiver
import com.jeidorf.tokenledger.mobile.widget.WidgetConfig
import com.jeidorf.tokenledger.mobile.widget.WidgetConfigStore
import com.jeidorf.tokenledger.mobile.widget.WidgetMode
import com.jeidorf.tokenledger.mobile.widget.WidgetRange
import com.jeidorf.tokenledger.mobile.widget.WidgetThemeMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.Rule
import org.junit.runner.RunWith

/** 路由配置只改当前实例主题；取消不落盘，删除不污染相邻实例。 */
@RunWith(AndroidJUnit4::class)
class RoutingWidgetConfigNativeTest {
    @get:Rule val compose = createComposeRule()

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
    fun cancelLeavesStoredThemeUnchangedAndMissingConfigDefaultsToSystem() {
        val id = TEST_ID_BASE + 5
        try {
            WidgetConfigStore.remove(context, id)
            assertEquals(WidgetThemeMode.System, WidgetConfigStore.load(context, id).theme)

            val stored = WidgetConfig(theme = WidgetThemeMode.Light)
            WidgetConfigStore.save(context, id, stored)
            var cancelled = false
            var confirmed: WidgetThemeMode? = null
            compose.setContent {
                TokenLedgerTheme(LedgerAppearance.Dark) {
                    RoutingWidgetConfigureScreen(
                        initialTheme = WidgetThemeMode.Light,
                        onConfirm = { confirmed = it },
                        onCancel = { cancelled = true }
                    )
                }
            }
            compose.onNodeWithText(context.getString(R.string.routing_widget_config_theme_dark)).performClick()
            compose.onNodeWithText(context.getString(R.string.routing_widget_config_cancel)).performClick()
            compose.waitForIdle()

            assertTrue(cancelled)
            assertNull(confirmed)
            assertEquals(stored, WidgetConfigStore.load(context, id))
        } finally {
            WidgetConfigStore.remove(context, id)
        }
    }

    @Test
    fun saveReturnsSelectedTheme() {
        var cancelled = false
        var confirmed: WidgetThemeMode? = null
        compose.setContent {
            TokenLedgerTheme(LedgerAppearance.Dark) {
                RoutingWidgetConfigureScreen(
                    initialTheme = WidgetThemeMode.System,
                    onConfirm = { confirmed = it },
                    onCancel = { cancelled = true }
                )
            }
        }
        compose.onNodeWithText(context.getString(R.string.routing_widget_config_theme_dark)).performClick()
        compose.onNodeWithText(context.getString(R.string.routing_widget_config_save)).performClick()
        compose.waitForIdle()

        assertEquals(WidgetThemeMode.Dark, confirmed)
        assertTrue(!cancelled)
    }

    private companion object {
        const val TEST_ID_BASE = -122_000
        const val TEST_HOST_ID = 122
    }
}
