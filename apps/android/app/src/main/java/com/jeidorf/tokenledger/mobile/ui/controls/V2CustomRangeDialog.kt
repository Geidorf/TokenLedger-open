package com.jeidorf.tokenledger.mobile.ui.controls

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DateRangePicker
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.DateRangePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.TokenLedgerTheme
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import android.content.res.Configuration
import java.util.Locale

/**
 * 看板文案固定为中文，日期控件也须采用同一应用语言，而不是随设备英文 locale 漂移。
 * 只覆盖 M3 日期控件所读的 Context/Configuration，不改系统语言、时区或查询日期。
 */
@Composable
internal fun ChineseDatePickerLocale(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val chineseConfiguration = remember(configuration) {
        Configuration(configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) }
    }
    val chineseContext = remember(context, chineseConfiguration) {
        context.createConfigurationContext(chineseConfiguration)
    }
    CompositionLocalProvider(
        LocalContext provides chineseContext,
        LocalConfiguration provides chineseConfiguration,
        content = content
    )
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
internal fun V2CustomRangeDialog(
    palette: MobileV2Palette,
    query: DashboardQuery,
    onDismiss: () -> Unit,
    onApply: (String, String) -> Unit
) {
    val today = remember { LocalDate.now() }
    val initialStart = remember(query.start) { runCatching { LocalDate.parse(query.start) }.getOrNull() ?: today }
    val initialEnd = remember(query.end) { runCatching { LocalDate.parse(query.end) }.getOrNull() ?: initialStart }
    val pickerState = remember(initialStart, initialEnd) {
        DateRangePickerState(
            initialSelectedStartDateMillis = initialStart.atStartOfDay(ZoneId.of("UTC")).toInstant().toEpochMilli(),
            initialSelectedEndDateMillis = initialEnd.atStartOfDay(ZoneId.of("UTC")).toInstant().toEpochMilli(),
            locale = Locale.SIMPLIFIED_CHINESE
        )
    }
    val startDate = pickerState.selectedStartDateMillis?.let {
            Instant.ofEpochMilli(it).atZone(ZoneId.of("UTC")).toLocalDate()
    }
    val endDate = pickerState.selectedEndDateMillis?.let {
            Instant.ofEpochMilli(it).atZone(ZoneId.of("UTC")).toLocalDate()
    }
    val error = remember(startDate, endDate, today) {
            when {
                startDate == null || endDate == null -> "请选择开始和结束日期"
                startDate > endDate -> "开始日期不能晚于结束日期"
                startDate.plusDays(730) < endDate -> "时间范围最长为 731 天"
                startDate > today -> "开始日期不能晚于今天"
                else -> null
            }
    }
    DatePickerDialog(
            onDismissRequest = onDismiss,
            confirmButton = {
                TextButton(
                    enabled = error == null,
                    onClick = { onApply(startDate.toString(), endDate.toString()) },
                    modifier = Modifier.heightIn(min = 48.dp)
                ) { Text("应用") }
            },
            dismissButton = {
                TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("取消") }
            }
    ) {
        // M3 在 DateRangePicker 组合时从 Dialog 自己的 LocalConfiguration 创建
        // CalendarModel；外层 provider 无法穿过该 Dialog 的 composition 根节点。
        ChineseDatePickerLocale {
            Column {
                DateRangePicker(
                    state = pickerState,
                // 左右留 24dp（M3 单日期对话框标题与标题栏的默认内缩）：M3 把对话框容器定死 360dp 宽，
                // 320dp 屏上左右各有 20dp 落在窗口外，留 16dp 时首字会被切掉一截（T10.177 修复轮 320dp × 200% 核对）。
                title = { Text("选择时间范围", modifier = Modifier.padding(horizontal = 24.dp, vertical = 16.dp)) },
                headline = {
                    // 这个槽默认取 titleLarge（20sp），大字体下「开始：2026-06-01」一行放不下，旧的 maxLines = 1
                    // 会在「：」后断行、把日期整段裁掉（T10.177 评审 P1-1）。显式用 titleM，并允许折行。
                    Column(Modifier.padding(horizontal = 24.dp, vertical = 4.dp)) {
                        Text("开始：${startDate?.toString() ?: "未选择"}", style = LedgerType.titleM)
                        Text("结束：${endDate?.toString() ?: "未选择"}", style = LedgerType.titleM)
                    }
                },
                showModeToggle = true,
                modifier = Modifier.weight(1f)
            )
                val guidance = error ?: if (endDate != null && endDate > today) "结束日期超过今天时，当前窗口会截到现在。" else null
                guidance?.let { message ->
                    Text(
                        message,
                        color = if (error == null) Color.Unspecified else palette.danger,
                        fontSize = LedgerFont.label,
                        modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp).semantics {
                            if (error != null) liveRegion = LiveRegionMode.Polite
                        }
                    )
                }
        }
        }
    }
}

@Composable
internal fun V2CustomRangeDialogPreviewContent(appearance: LedgerAppearance) {
    TokenLedgerTheme(appearance) {
        V2CustomRangeDialog(
            palette = v2Palette(appearance),
            query = DashboardQuery(
                range = RangeKey.Custom,
                start = "2026-06-01",
                end = "2026-07-15"
            ),
            onDismiss = {},
            onApply = { _, _ -> }
        )
    }
}
