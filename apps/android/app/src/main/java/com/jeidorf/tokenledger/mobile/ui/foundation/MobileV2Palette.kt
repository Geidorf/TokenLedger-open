package com.jeidorf.tokenledger.mobile.ui.foundation

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerAppearance

/**
 * V2 界面沿用的色板接口。T10.177 起它**不再持有任何色值**：每个旧字段都是 [LedgerColors]
 * 某个角色的兼容别名（T10.173 §3.1「规则」第一条），调用点随 A1–A10 逐步改用 [tokens]。
 *
 * 别名的取舍：
 * - `green / amber / danger` 指向 `*Text`（小字档），`violet` 指向 `accent`：这些字段今天都被当成
 *   文字色用，契约「Android 三套配色的正文色都过 WCAG AA」检查的就是这一档；
 *   浅色图表紫 `chart-2 #8972FE` 在 `raised` 上只有 3.12:1，所以 `violet` 不能指向图表色。
 * - `surfaceContainerHigh` 指向 M3 的同名槽（卡内较深的填充），墨水屏取 `raised`；
 *   **不能**指向 `popover`——浅色 popover 是白色，会在白卡上白上白。
 * - `selected` 指向 `primaryContainerSolid`（选中底）。分段胶囊专用的 `tokens.selected`
 *   浅色是白、墨水屏是黑，都要配 `raised` 轨道或 `onSelected`；而旧调用点一律在上面画 `text`，
 *   轨道也不一定是 `raised`。新分段控件直接用 `tokens.selected / onSelected`。
 */
@Immutable
internal data class MobileV2Palette(
    /** 唯一色源。新代码直接用它。 */
    val tokens: LedgerColors
) {
    val background: Color get() = tokens.page
    val surface: Color get() = tokens.card
    val surfaceContainerLow: Color get() = tokens.surfaceContainerLow
    val surfaceContainer: Color get() = tokens.raised
    val surfaceContainerHigh: Color get() = if (tokens.isEInk) tokens.raised else tokens.surfaceContainerHigh
    val raised: Color get() = tokens.raised
    val selected: Color get() = tokens.primaryContainerSolid
    val text: Color get() = tokens.text
    val muted: Color get() = tokens.muted
    val faint: Color get() = tokens.faint
    /** 装饰发丝线（约 1.2:1）。线条是唯一线索的地方用 [outline]。 */
    val divider: Color get() = tokens.divider
    val outlineVariant: Color get() = tokens.divider
    /** 功能边界（输入框、复选框、未知值虚线槽、焦点），对四档表面 ≥3:1。 */
    val outline: Color get() = tokens.outline
    val blue: Color get() = tokens.primary
    /** [blue] 容器上的文字/图标色（M3 `onPrimary`），三主题对 blue ≥ 4.5:1，见 MobileV2PaletteContrastTest。 */
    val onBlue: Color get() = tokens.onPrimary
    val blueSoft: Color get() = tokens.primaryContainer
    val green: Color get() = tokens.successText
    val amber: Color get() = tokens.warningText
    val violet: Color get() = tokens.accent
    val danger: Color get() = tokens.dangerText
    val isEInk: Boolean get() = tokens.isEInk
}

/** 与说明文字同排的小字形：金额显隐的眼睛、行末的小箭头。 */
internal val V2_ICON_TEXT = LedgerSize.iconText
/** 随正文排版的图标与卡内动作：箭头、行内提示。 */
internal val V2_ICON_INLINE = LedgerSize.iconInline
/** 顶栏与导航的独立图标动作。 */
internal val V2_ICON_ACTION = LedgerSize.iconAction
/** 无障碍触达下限。 */
internal val V2_TOUCH_TARGET = 48.dp
/** 可点控件的最小高度：直接取触达下限 [V2_TOUCH_TARGET]，不再用「可见 40dp + 另补触达区」的写法。 */
internal val V2_CONTROL_HEIGHT = V2_TOUCH_TARGET

/** 分段控件轨道的内边距与分段间距。最小宽度由这两个数推出，别在别处各写一份。 */
internal val V2_SEGMENT_INSET = LedgerSpace.xs
internal val V2_SEGMENT_GAP = LedgerSpace.xs

/**
 * 分段控件放得下 [segments] 个分段所需的最小宽度。
 *
 * 宽度应当由「几个分段 × 触达下限」推出，而不是反过来让分段去迁就一个手写的宽度。
 */
internal fun v2SegmentedToggleWidth(segments: Int): Dp {
    val count = segments.coerceAtLeast(1)
    // 每段再加 1dp 余量：内边距与间距各自要取整成像素，余下的宽度再被均分，
    // 每段最多会被吃掉 1px。真机 density 2.625 上就差这一下——48dp = 126px，
    // 而分段量到 125px；截图预览跑在 density 1.0，取整不掉肉，所以看不出来。1dp 在任何 density 下都 ≥ 1px。
    return (V2_TOUCH_TARGET + 1.dp) * count + V2_SEGMENT_GAP * (count - 1) + V2_SEGMENT_INSET * 2
}

private val DarkV2Palette = MobileV2Palette(LedgerPalettes.Dark)
private val LightV2Palette = MobileV2Palette(LedgerPalettes.Light)
private val EInkV2Palette = MobileV2Palette(LedgerPalettes.EInk)

/** 三套外观各一个共享实例：调用方不 `remember` 也拿到同一个对象，重组时参数比较不会失配。 */
internal fun v2Palette(appearance: LedgerAppearance): MobileV2Palette = when (appearance) {
    LedgerAppearance.Dark -> DarkV2Palette
    LedgerAppearance.Light -> LightV2Palette
    LedgerAppearance.EInk -> EInkV2Palette
}
