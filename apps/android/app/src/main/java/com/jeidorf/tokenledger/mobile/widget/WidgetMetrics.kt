package com.jeidorf.tokenledger.mobile.widget

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Launcher 卡片的尺寸断点与外壳内边距的唯一来源。
 *
 * 内容预算（[widgetRingLayout] 等）和实际绘制（WidgetBody）必须用同一组数字：
 * T10.118d 之前两侧各自写死 `180` / `82` 与 `8/10`、`5/7`，预算按 `16/20`、
 * `10/14` 反推内容区，任一侧改动都会静默错位。这里合并成一处，改断点或内边距
 * 时两侧同时生效。
 */
internal object WidgetMetrics {
    /** 窄卡断点：小于此宽度按 2×n 的窄档排布。 */
    const val NARROW_WIDTH_DP = 180f

    /** 矮卡断点：小于此高度按单行档排布。 */
    const val SHORT_HEIGHT_DP = 82f

    private const val NARROW_HORIZONTAL_PADDING_DP = 8f
    private const val REGULAR_HORIZONTAL_PADDING_DP = 10f
    private const val SHORT_VERTICAL_PADDING_DP = 5f
    private const val REGULAR_VERTICAL_PADDING_DP = 7f

    fun isNarrow(widthDp: Float): Boolean = widthDp < NARROW_WIDTH_DP

    fun isShort(heightDp: Float): Boolean = heightDp < SHORT_HEIGHT_DP

    fun isNarrow(width: Dp): Boolean = isNarrow(width.value)

    fun isShort(height: Dp): Boolean = isShort(height.value)

    /** WidgetBody 单侧水平内边距。 */
    fun horizontalPaddingDp(widthDp: Float): Float =
        if (isNarrow(widthDp)) NARROW_HORIZONTAL_PADDING_DP else REGULAR_HORIZONTAL_PADDING_DP

    /** WidgetBody 单侧垂直内边距。 */
    fun verticalPaddingDp(heightDp: Float): Float =
        if (isShort(heightDp)) SHORT_VERTICAL_PADDING_DP else REGULAR_VERTICAL_PADDING_DP

    fun horizontalPadding(width: Dp): Dp = horizontalPaddingDp(width.value).dp

    fun verticalPadding(height: Dp): Dp = verticalPaddingDp(height.value).dp

    /** 扣掉左右内边距后，内容真正可用的宽度。 */
    fun innerWidthDp(widthDp: Float): Float = widthDp - 2f * horizontalPaddingDp(widthDp)

    /** 扣掉上下内边距后，内容真正可用的高度。 */
    fun innerHeightDp(heightDp: Float): Float = heightDp - 2f * verticalPaddingDp(heightDp)
}
