package com.jeidorf.tokenledger.mobile.ui.calendar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.DatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.jeidorf.tokenledger.mobile.InsightCalendarAxis
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.controls.ChineseDatePickerLocale
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale
import kotlin.math.roundToInt

/**
 * 查看某一天的日期选择弹层（T10.177 P3-13 收尾，T10.209 范围 5）。
 *
 * 不再用 M3 [androidx.compose.material3.DatePickerDialog] 包一层——那个容器把宽度定死
 * `requiredWidth(360.dp)`（M3 1.3），320dp 屏上整个弹层左右各约 20dp 出窗。这里改用不限制平台宽度的
 * 裸 [Dialog]（`usePlatformDefaultWidth = false`）+ 自画 [Surface]（popover 底色、20dp 圆角，DESIGN §4.12）。
 *
 * R-69 P2-1 更正：单日 [DatePicker] 的星期头与日期网格本身按 [DATE_PICKER_GRID_WIDTH]（左右各 12dp +
 * 7×48dp）排，直接收窄到 296dp 时周日整列落在画面外、点不到。所以可用宽度不足时，[DatePicker] 仍按
 * 360dp 排版，再用 [scaleDownToFitWidth] 整体等比缩小：7 列都在画面里、都点得到（缩放同样作用于点击
 * 命中），代价是 320dp 屏上日格约 40dp。够宽（≥376dp 窗口）时不缩放，与原来逐像素相同。
 */
@Composable
@OptIn(ExperimentalMaterial3Api::class)
internal fun V2SingleDayDialog(
    palette: MobileV2Palette,
    axis: InsightCalendarAxis,
    initialDate: String?,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit
) {
    val start = axis.selectableStart ?: return
    val end = axis.selectableEnd ?: return
    val initial = initialDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
        ?.takeIf(axis::isDateSelectable) ?: end
    val utc = ZoneId.of("UTC")
    val allowedDates = remember(axis) {
        object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                axis.isDateSelectable(Instant.ofEpochMilli(utcTimeMillis).atZone(utc).toLocalDate())
            override fun isSelectableYear(year: Int): Boolean = year in start.year..end.year
        }
    }
    val picker = remember(initial, start, end, allowedDates) {
        DatePickerState(
            initialSelectedDateMillis = initial.atStartOfDay(utc).toInstant().toEpochMilli(),
            yearRange = start.year..end.year,
            selectableDates = allowedDates,
            locale = Locale.SIMPLIFIED_CHINESE
        )
    }
    val date = picker.selectedDateMillis?.let { Instant.ofEpochMilli(it).atZone(utc).toLocalDate() }
    Dialog(
            onDismissRequest = onDismiss,
            properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        // DatePicker 读取 Dialog composition 内的 LocalConfiguration 创建 CalendarModel。
        ChineseDatePickerLocale {
            Surface(
            modifier = Modifier
                .padding(horizontal = LedgerSpace.sm)
                .widthIn(max = DATE_PICKER_GRID_WIDTH),
            shape = RoundedCornerShape(LedgerRadius.xl),
            color = palette.tokens.popover,
            contentColor = palette.text
            ) {
                Column {
                DatePicker(
                    state = picker,
                    modifier = Modifier.scaleDownToFitWidth(DATE_PICKER_GRID_WIDTH),
                    title = { Text("查看某一天", modifier = Modifier.padding(16.dp).semantics { heading() }) },
                    headline = {
                        // 这个槽默认取 titleLarge（英文月份名 + 年份），320dp × 200% 字号下一行放不下、
                        // 旧的 maxLines = 1 会把年份整段裁掉（本任务 P3-13 新增截图才发现，同类根因见
                        // T10.177 评审 P1-1 对 V2CustomRangeDialog 的修法）。显式用 titleM + ISO 日期，允许折行。
                        Text(
                            date?.toString() ?: "未选择",
                            modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp),
                            style = LedgerType.titleM
                        )
                    },
                    showModeToggle = true,
                    colors = DatePickerDefaults.colors(containerColor = Color.Transparent)
                )
                    Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = LedgerSpace.sm, vertical = LedgerSpace.xs),
                    horizontalArrangement = Arrangement.End
                    ) {
                        TextButton(onClick = onDismiss) { Text("取消", color = palette.blue) }
                        TextButton(
                            enabled = date?.let(axis::isDateSelectable) == true,
                            onClick = { date?.let { onSelect(it.toString()) } }
                        ) { Text("查看当天", color = palette.blue) }
                    }
                }
        }
        }
    }
}

/** M3 单日 [DatePicker] 的星期头与日期网格需要的宽度：左右各 12dp 边距 + 7 列 × 48dp。 */
private val DATE_PICKER_GRID_WIDTH = 360.dp

/**
 * 可用宽度不足 [naturalWidth] 时，按 [naturalWidth] 测量、排版，再整体等比缩小到可用宽度
 * （左上角为原点，高度同比缩小）；可用宽度足够时原样测量，不缩放（R-69 P2-1）。
 * 缩放用 placeWithLayer 的图层变换：点击命中与读屏边界都随图层一起缩放，缩小后的日期照样点得到。
 */
private fun Modifier.scaleDownToFitWidth(naturalWidth: Dp): Modifier = layout { measurable, constraints ->
    val natural = naturalWidth.roundToPx()
    if (!constraints.hasBoundedWidth || constraints.maxWidth >= natural) {
        val placeable = measurable.measure(constraints)
        layout(placeable.width, placeable.height) { placeable.place(0, 0) }
    } else {
        val scale = constraints.maxWidth.toFloat() / natural
        val maxHeight = if (constraints.hasBoundedHeight) (constraints.maxHeight / scale).toInt() else Constraints.Infinity
        val placeable = measurable.measure(Constraints(minWidth = natural, maxWidth = natural, maxHeight = maxHeight))
        val height = (placeable.height * scale).roundToInt().coerceIn(constraints.minHeight, constraints.maxHeight)
        layout(constraints.maxWidth, height) {
            placeable.placeWithLayer(0, 0) {
                scaleX = scale
                scaleY = scale
                transformOrigin = TransformOrigin(0f, 0f)
            }
        }
    }
}
