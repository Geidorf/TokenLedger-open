package com.jeidorf.tokenledger.mobile.ui.navigation

import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerVectorTemplateInk

/**
 * 一级导航的线性图标（重构方案 v2，对齐参考设计的导航图标）：20×20 视口、1.7 线宽、圆头圆角，
 * 只有描边没有填充。颜色由 [androidx.compose.material3.Icon] 的 tint 决定，这里的模板墨色只是占位。
 */
internal object LedgerNavIcons {
    val Usage: ImageVector = strokeIcon("Usage", "M4 16V9M8 16V5M12 16v-5M16 16V7")
    val Routing: ImageVector = strokeIcon(
        "Routing",
        "M3 10h5l4-5h5M8 10l4 5h5M14.5 3l2.5 2-2.5 2M14.5 13l2.5 2-2.5 2"
    )
    val Quota: ImageVector = strokeIcon("Quota", "M3.5 13.5a6.5 6.5 0 1 1 13 0M10 13.5l3-4")
    val Me: ImageVector = strokeIcon(
        "Me",
        "M13 7a3 3 0 1 1-6 0a3 3 0 1 1 6 0M4 16.5c1-3 3.3-4.5 6-4.5s5 1.5 6 4.5"
    )

    private fun strokeIcon(name: String, pathData: String): ImageVector =
        ImageVector.Builder(
            name = "LedgerNav.$name",
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 20f,
            viewportHeight = 20f
        ).addPath(
            pathData = addPathNodes(pathData),
            stroke = SolidColor(LedgerVectorTemplateInk),
            strokeLineWidth = 1.7f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round
        ).build()
}
