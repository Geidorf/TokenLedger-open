package com.jeidorf.tokenledger.mobile

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.jeidorf.tokenledger.mobile.widget.TokenLedgerRingWidgetReceiver
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** 仅读取QA宿主options与身份；不刷新、绑定、改配置、写数据或把尺寸放入用户语义。 */
@RunWith(AndroidJUnit4::class)
class RingWidgetOptionsNativeTest {
    @Suppress("DEPRECATION")
    @Test fun recordRingHostOptionsAndIdentity() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext.applicationContext
        assertEquals("com.jeidorf.tokenledger.mobile.qa", context.packageName)
        val manager = AppWidgetManager.getInstance(context)
        val ids = manager.getAppWidgetIds(ComponentName(context, TokenLedgerRingWidgetReceiver::class.java))
        assertEquals("请在默认环形QA实例添加后取证", 1, ids.size)
        val id = ids.single()
        val info = requireNotNull(manager.getAppWidgetInfo(id))
        val options = manager.getAppWidgetOptions(id)
        val glance = GlanceAppWidgetManager(context)
        val sizes = glance.getAppWidgetSizes(glance.getGlanceIdBy(id))
        val metrics = context.resources.displayMetrics
        val raw = JSONObject()
        listOf(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH,
            AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT).forEach { key ->
            raw.put(key, if (options.containsKey(key)) options.getInt(key) else JSONObject.NULL)
        }
        val rawSizes = if (Build.VERSION.SDK_INT >= 31)
            options.getParcelableArrayList<SizeF>(AppWidgetManager.OPTION_APPWIDGET_SIZES) else null
        raw.put("appWidgetSizes", rawSizes?.let { values -> JSONArray().apply {
            values.forEach { put(JSONObject().put("widthDp", it.width).put("heightDp", it.height)) }
        } } ?: JSONObject.NULL)
        val report = JSONObject()
            .put("package", context.packageName)
            .put("version", context.packageManager.getPackageInfo(context.packageName, 0).versionName)
            .put("appWidgetId", id).put("provider", info.provider.flattenToString())
            .put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL).put("api", Build.VERSION.SDK_INT)
            .put("density", metrics.density).put("densityDpi", metrics.densityDpi)
            .put("fontScale", context.resources.configuration.fontScale)
            .put("rawOptions", raw)
            .put("providerInfoPixels", JSONObject().put("minWidth", info.minWidth).put("minHeight", info.minHeight)
                .put("minResizeWidth", info.minResizeWidth).put("minResizeHeight", info.minResizeHeight))
            .put("glanceOptionSizesDp", JSONArray().apply {
                sizes.forEach { put(JSONObject().put("widthDp", it.width.value).put("heightDp", it.height.value)) }
            })
            .put("boundary", "option-derived candidates, not UI pixel bounds or confirmation of the currently selected RemoteViews")
        instrumentation.sendStatus(0, Bundle().apply { putString("stream", "RING_OPTIONS_JSON=$report\n") })
    }
}
