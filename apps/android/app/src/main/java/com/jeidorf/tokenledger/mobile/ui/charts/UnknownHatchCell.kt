package com.jeidorf.tokenledger.mobile.ui.charts

import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import kotlin.math.max
import kotlin.math.sqrt

private val UNKNOWN_HATCH_SPACING = 2.5.dp
private const val UNKNOWN_HATCH_STROKE_PX = 1f

/** 覆盖外沿用所在卡片/面板的底色；只在圆角内画纹理，细框由调用方随后绘制。 */
internal fun DrawScope.drawUnknownHatchCell(
    topLeft: Offset,
    size: Size,
    cornerRadius: CornerRadius,
    palette: MobileV2Palette
) {
    if (size.width <= 0f || size.height <= 0f) return
    val color = if (palette.isEInk) Color.Black else palette.faint
    val step = max(UNKNOWN_HATCH_SPACING.toPx(), UNKNOWN_HATCH_STROKE_PX * 2f) * sqrt(2f)
    val clip = Path().apply { addRoundRect(RoundRect(Rect(topLeft, size), cornerRadius)) }
    clipPath(clip) {
        var diagonal = 0f
        while (diagonal <= size.width + size.height) {
            drawLine(
                color = color,
                start = Offset(topLeft.x + diagonal, topLeft.y),
                end = Offset(topLeft.x, topLeft.y + diagonal),
                strokeWidth = UNKNOWN_HATCH_STROKE_PX
            )
            diagonal += step
        }
    }
}
