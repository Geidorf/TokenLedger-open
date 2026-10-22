package com.jeidorf.tokenledger.mobile.widget

import android.content.res.Configuration
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.TextUnit
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.appwidget.cornerRadius
import androidx.glance.unit.ColorProvider
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerColors
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerPalettes

/**
 * 小组件双色板（T8.2）。T10.177 起**不再有自己的色值**：深浅两套直接取 `LedgerTokens`
 * 的 [LedgerPalettes.Dark] / [LedgerPalettes.Light]（T10.173 §3.1、§4.14），与应用同一色源；
 * 此前这里是一份手抄副本，与应用有 5 个角色分叉，圆环位图的危险色又是第三套。
 * 容器 = `card`，内块 = `raised`；圆环与进度条的轨道 = `surfaceContainerHighest`（root 决定 R-17：`raised`
 * 叠在 `card` 上深色只有 1.08:1，空环几乎隐形；改取这个现成角色后深 1.34、浅 1.25，不新增色值）。
 * 状态角色取小字档（`*Text`），圆环、进度条与文字同用这一档，
 * 充足 = `primary`（蓝，V-Q1）。浅色偏紧因此是 `warningText #8A4B00`，比 §4.9 的图形色 `warning #A15C07`
 * 更深；小组件额度呈现按 §4.9 分开图形色与文字色属 A9（呈现代码在 `TokenLedgerWidget.kt`）。
 *
 * 深浅色跟随系统：本阶段用**渲染期读取系统 uiMode**（[rememberWidgetColors]）配合稳定的
 * 固定色 [ColorProvider]，而非 day/night 版 ColorProvider ——后者在 Glance 各版本间从
 * `androidx.glance.unit` 迁到 `androidx.glance.color`，包路径不稳定，保守起见不依赖。
 * 系统切换深浅色时 AppWidgetHost 会触发一次更新，Glance 随之重绘取新色。
 */
internal class WidgetColors(val night: Boolean) {
    // 每个角色只取一次色：ColorProvider 与位图用的 Int 都从下面的 *Color 派生，
    // 预览与截图夹具也从这里取。此前预览和截图测试各自手抄了一份，改了真身它们不会跟——
    // 截图测试因此在验它自己抄的颜色，真身回归照样绿。
    private val tokens: LedgerColors = if (night) LedgerPalettes.Dark else LedgerPalettes.Light

    val backgroundColor: Color = tokens.card
    val surfaceColor: Color = tokens.raised
    val textColor: Color = tokens.text
    val mutedColor: Color = tokens.muted
    val faintColor: Color = tokens.faint
    val dividerColor: Color = tokens.divider
    val blueColor: Color = tokens.primary
    val trackColor: Color = tokens.surfaceContainerHighest
    val greenColor: Color = tokens.successText
    val amberColor: Color = tokens.warningText
    val amberTrackColor: Color = tokens.warningSoft
    val dangerColor: Color = tokens.dangerText

    val background: ColorProvider = ColorProvider(backgroundColor)
    val surface: ColorProvider = ColorProvider(surfaceColor)
    val text: ColorProvider = ColorProvider(textColor)
    val muted: ColorProvider = ColorProvider(mutedColor)
    val faint: ColorProvider = ColorProvider(faintColor)
    val divider: ColorProvider = ColorProvider(dividerColor)
    val blue: ColorProvider = ColorProvider(blueColor)
    val track: ColorProvider = ColorProvider(trackColor)
    val green: ColorProvider = ColorProvider(greenColor)
    val amber: ColorProvider = ColorProvider(amberColor)
    val amberTrack: ColorProvider = ColorProvider(amberTrackColor)
    val danger: ColorProvider = ColorProvider(dangerColor)

    // 圆环位图只收 Int：取同一个 *Color 的 toArgb()，不再另写一套（旧危险色 #FF625A / #D93025），
    // 于是同一状态的圆环与进度条（ColorProvider）必然同色。
    val backgroundArgb: Int = backgroundColor.toArgb()
    val trackArgb: Int = trackColor.toArgb()
    val blueArgb: Int = blueColor.toArgb()
    val amberArgb: Int = amberColor.toArgb()
    val dangerArgb: Int = dangerColor.toArgb()
}

/** 默认回退为深色（应用默认外观即深色），仅在未提供时兜底。 */
internal val LocalWidgetColors = staticCompositionLocalOf { WidgetColors(night = true) }
internal val LocalWidgetFontCompensation = staticCompositionLocalOf { 1f }

@Composable
internal fun rememberWidgetColors(theme: WidgetThemeMode): WidgetColors {
    val context = LocalContext.current
    val systemNight = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
        Configuration.UI_MODE_NIGHT_YES
    val night = when (theme) {
        WidgetThemeMode.System -> systemNight
        WidgetThemeMode.Light -> false
        WidgetThemeMode.Dark -> true
    }
    return remember(theme, systemNight) { WidgetColors(night) }
}

/**
 * 不抵消系统字体倍率。紧凑尺寸通过内容重排与 +N 摘要降密度，而不是把 200% 字体
 * 逆向压回 100% 后声称兼容大字体。
 */
@Suppress("UNUSED_PARAMETER")
internal fun widgetFontCompensation(fontScale: Float, maxRenderedScale: Float = 1.2f): Float = 1f

@Composable
internal fun TextUnit.forWidgetFontScale(): TextUnit = this * LocalWidgetFontCompensation.current

/** 圆角与应用卡片一致；API<31 也可正常裁剪。 */
internal val WIDGET_CORNER: Dp = 20.dp

@Composable
internal fun GlanceModifier.widgetContainerCorner(): GlanceModifier =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        this.cornerRadius(android.R.dimen.system_app_widget_background_radius)
    } else {
        this.cornerRadius(WIDGET_CORNER)
    }

@Composable
internal fun GlanceModifier.widgetInnerCorner(): GlanceModifier =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        this.cornerRadius(android.R.dimen.system_app_widget_inner_radius)
    } else {
        this.cornerRadius(12.dp)
    }

/**
 * 可用额度阈值配色：<20% 危险红、<50% 警示橙、其余主色蓝（严格小于，D4/T10.152）。
 * 分界判定下沉到纯函数 [widgetAvailabilityBand]（WidgetCycling.kt），此处只做「档 → 颜色」映射。
 */
internal fun widgetProgressColor(colors: WidgetColors, availableFraction: Float): ColorProvider =
    when (widgetAvailabilityBand(availableFraction)) {
        WidgetThresholdBand.Danger -> colors.danger
        WidgetThresholdBand.Warn -> colors.amber
        WidgetThresholdBand.Normal -> colors.blue
    }

internal fun widgetProgressArgb(colors: WidgetColors, availableFraction: Float): Int =
    when (widgetAvailabilityBand(availableFraction)) {
        WidgetThresholdBand.Danger -> colors.dangerArgb
        WidgetThresholdBand.Warn -> colors.amberArgb
        WidgetThresholdBand.Normal -> colors.blueArgb
    }
