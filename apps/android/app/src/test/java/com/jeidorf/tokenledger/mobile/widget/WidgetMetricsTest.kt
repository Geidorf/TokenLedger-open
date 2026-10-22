package com.jeidorf.tokenledger.mobile.widget

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 内容预算和实际绘制曾经各写一份断点与内边距（T10.118d 复盘）。这些用例锁住
 * 「两侧同源」这件事本身：改了内边距，预算必须跟着变，不允许再次出现静默错位。
 */
class WidgetMetricsTest {
    @Test fun innerSizeIsExactlyOuterSizeMinusRenderedPadding() {
        for (width in listOf(110f, 179.9f, 180f, 200f, 325f)) {
            for (height in listOf(58f, 81.9f, 82f, 92f, 212f)) {
                assertEquals(
                    "宽 $width 的内容宽度必须等于外框减两侧实际内边距",
                    width - 2f * WidgetMetrics.horizontalPadding(width.dp).value,
                    WidgetMetrics.innerWidthDp(width),
                    0.0001f
                )
                assertEquals(
                    "高 $height 的内容高度必须等于外框减上下实际内边距",
                    height - 2f * WidgetMetrics.verticalPadding(height.dp).value,
                    WidgetMetrics.innerHeightDp(height),
                    0.0001f
                )
            }
        }
    }

    @Test fun breakpointsAreHalfOpenAndShareOneSource() {
        assertTrue(WidgetMetrics.isNarrow(179.99f))
        assertFalse(WidgetMetrics.isNarrow(WidgetMetrics.NARROW_WIDTH_DP))
        assertTrue(WidgetMetrics.isShort(81.99f))
        assertFalse(WidgetMetrics.isShort(WidgetMetrics.SHORT_HEIGHT_DP))
        // Dp 重载与 Float 重载必须给出同一答案，避免调用点二选一时行为分叉。
        assertEquals(WidgetMetrics.isNarrow(150f), WidgetMetrics.isNarrow(150.dp))
        assertEquals(WidgetMetrics.isShort(70f), WidgetMetrics.isShort(70.dp))
    }

    @Test fun paddingKeepsHistoricalValuesSoDeviceEvidenceStaysValid() {
        // T10.118d 的 N2301 三轮真机结论绑定在这组数值上；抽常量不得顺手改数。
        assertEquals(8f, WidgetMetrics.horizontalPaddingDp(150f), 0.0001f)
        assertEquals(10f, WidgetMetrics.horizontalPaddingDp(200f), 0.0001f)
        assertEquals(5f, WidgetMetrics.verticalPaddingDp(70f), 0.0001f)
        assertEquals(7f, WidgetMetrics.verticalPaddingDp(100f), 0.0001f)
        assertEquals(16f, 2f * WidgetMetrics.horizontalPaddingDp(150f), 0.0001f)
        assertEquals(20f, 2f * WidgetMetrics.horizontalPaddingDp(200f), 0.0001f)
        assertEquals(10f, 2f * WidgetMetrics.verticalPaddingDp(70f), 0.0001f)
        assertEquals(14f, 2f * WidgetMetrics.verticalPaddingDp(100f), 0.0001f)
    }
}
