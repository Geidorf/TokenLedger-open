package com.jeidorf.tokenledger.mobile.ui.foundation

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance

/** WCAG 2.x 对比度：(L亮 + 0.05) / (L暗 + 0.05)；半透明前景先合成到底色上。 */
internal fun contrastRatio(foreground: Color, background: Color): Float {
    val fg = foreground.compositeOver(background).luminance()
    val bg = background.luminance()
    return (maxOf(fg, bg) + 0.05f) / (minOf(fg, bg) + 0.05f)
}

/**
 * 身份色、图表色拿来当小字时用：对比度够 [minimum] 就原样返回；不够就往 [toward]（一般是正文色）
 * 靠，靠到刚好达标为止，色相尽量保留。[toward] 自己都不达标时直接用它。
 */
internal fun readableOn(color: Color, background: Color, toward: Color, minimum: Float = 4.5f): Color {
    if (contrastRatio(color, background) >= minimum) return color
    if (contrastRatio(toward, background) < minimum) return toward
    var low = 0f
    var high = 1f
    repeat(16) {
        val mid = (low + high) / 2f
        if (contrastRatio(lerp(color, toward, mid), background) >= minimum) high = mid else low = mid
    }
    return lerp(color, toward, high)
}
