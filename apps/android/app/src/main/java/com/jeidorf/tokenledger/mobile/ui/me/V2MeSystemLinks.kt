package com.jeidorf.tokenledger.mobile.ui.me

import android.app.ActivityOptions
import android.app.PendingIntent
import android.app.WallpaperManager
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.service.wallpaper.WallpaperService
import com.jeidorf.tokenledger.mobile.R
import com.jeidorf.tokenledger.mobile.widget.TokenLedgerBarWidgetReceiver
import com.jeidorf.tokenledger.mobile.widget.TokenLedgerComboWidgetReceiver
import com.jeidorf.tokenledger.mobile.widget.TokenLedgerRingWidgetReceiver
import com.jeidorf.tokenledger.mobile.widget.TokenLedgerWidgetReceiver
import com.jeidorf.tokenledger.mobile.widget.WidgetConfigureActivity

/**
 * 「我的」页通往系统的入口：动态壁纸选择器、小组件固定请求。
 *
 * 壁纸服务由壁纸线程另行提供；这里不写死它的类名，而是按 [WallpaperService.SERVICE_INTERFACE]
 * 在本包里找。没找到就是还没上线，入口照实显示「准备中」。
 */
internal object V2MeSystemLinks {
    fun liveWallpaperComponent(context: Context): ComponentName? = runCatching {
        val intent = Intent(WallpaperService.SERVICE_INTERFACE).setPackage(context.packageName)
        context.packageManager.queryIntentServices(intent, PackageManager.GET_META_DATA)
            .firstOrNull()?.serviceInfo?.let { ComponentName(it.packageName, it.name) }
    }.getOrNull()

    fun wallpaperState(context: Context): V2MeWallpaperState {
        val component = liveWallpaperComponent(context) ?: return V2MeWallpaperState.Unavailable
        val active = runCatching {
            WallpaperManager.getInstance(context).wallpaperInfo?.component == component
        }.getOrDefault(false)
        return if (active) V2MeWallpaperState.Active else V2MeWallpaperState.Available
    }

    /** 打开系统的动态壁纸预览页，直接停在本 App 的壁纸上；系统不支持时退回壁纸列表。 */
    fun openWallpaperPicker(context: Context): Boolean {
        val component = liveWallpaperComponent(context) ?: return false
        val direct = Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER)
            .putExtra(WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT, component)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val chooser = Intent(WallpaperManager.ACTION_LIVE_WALLPAPER_CHOOSER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { context.startActivity(direct) }.isSuccess ||
            runCatching { context.startActivity(chooser) }.isSuccess
    }

    /** 选择器里公开的三种小组件，按添加时的形态排序。 */
    enum class WidgetKind(val labelRes: Int, val receiver: Class<*>) {
        Ring(R.string.widget_ring_label, TokenLedgerRingWidgetReceiver::class.java),
        Bar(R.string.widget_bar_label, TokenLedgerBarWidgetReceiver::class.java),
        Combo(R.string.widget_combo_label, TokenLedgerComboWidgetReceiver::class.java)
    }

    /** 桌面上已放置的本 App 小组件数，含升级前留下的旧通用实例。 */
    fun placedWidgetCount(context: Context): Int = runCatching {
        val manager = AppWidgetManager.getInstance(context) ?: return 0
        (WidgetKind.entries.map { it.receiver } + TokenLedgerWidgetReceiver::class.java)
            .sumOf { manager.getAppWidgetIds(ComponentName(context, it)).size }
    }.getOrDefault(0)

    fun canPinWidget(context: Context): Boolean = runCatching {
        AppWidgetManager.getInstance(context)?.isRequestPinAppWidgetSupported == true
    }.getOrDefault(false)

    /**
     * 请桌面固定一个小组件。经这条路添加时桌面不会自己拉起配置页（见 requestPinAppWidget 文档），
     * 所以带上成功回调：系统把新实例的 EXTRA_APPWIDGET_ID 填进回调 Intent，再打开配置页选来源、范围与主题。
     * 回调 Intent 必须可变，系统才能往里填 ID。
     */
    fun requestPinWidget(context: Context, kind: WidgetKind): Boolean = runCatching {
        val manager = AppWidgetManager.getInstance(context) ?: return false
        val configure = Intent(context, WidgetConfigureActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val options = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ActivityOptions.makeBasic()
                .setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                .toBundle()
        } else null
        val callback = PendingIntent.getActivity(context, kind.ordinal, configure, flags, options)
        manager.requestPinAppWidget(ComponentName(context, kind.receiver), null, callback)
    }.getOrDefault(false)
}
