package com.jeidorf.tokenledger.mobile.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.ScreenRotation
import androidx.compose.material.icons.filled.Widgets
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.QuotaUiState
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_ACTION

@Composable
internal fun V2OrientationSettings(
    palette: MobileV2Palette,
    forceLandscape: Boolean,
    onChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier
) {
    V2Card(palette, modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            V2SettingsIcon(palette, Icons.Default.ScreenRotation)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("强制横屏", color = palette.text, fontWeight = FontWeight.SemiBold)
                Text(
                    if (forceLandscape) "传感器横屏" else "跟随系统方向",
                    color = palette.faint,
                    fontSize = LedgerFont.caption
                )
            }
            Switch(checked = forceLandscape, onCheckedChange = onChange)
        }
        // 开关本身与它旁边的状态行已经说清了这是什么；此前下面还挂着一整段两行小字，
        // 开、关各一版。只保留一条界面上看不出来的约束：多窗口下系统说了算。
        if (forceLandscape) {
            Text(
                "多窗口下仍服从系统给的窗口尺寸",
                color = palette.faint,
                fontSize = LedgerFont.caption,
                modifier = Modifier.padding(top = 6.dp)
            )
        }
    }
}

@Composable
internal fun V2AppearanceSettings(
    palette: MobileV2Palette,
    appearance: LedgerAppearance,
    onChange: (LedgerAppearance) -> Unit,
    modifier: Modifier = Modifier
) {
    V2Card(palette, modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            V2SettingsIcon(palette, Icons.Default.Widgets)
            Spacer(Modifier.width(10.dp))
            Column {
                Text("显示模式", color = palette.text, fontWeight = FontWeight.SemiBold)
            }
        }
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            LedgerAppearance.entries.forEach { option ->
                FilterChip(
                    selected = appearance == option,
                    onClick = { onChange(option) },
                    label = { Text(option.label) },
                    modifier = Modifier.heightIn(min = 48.dp)
                )
            }
        }
    }
}

@Composable
internal fun V2DataSettings(palette: MobileV2Palette, state: DashboardUiState, modifier: Modifier = Modifier) {
    V2Card(palette, modifier) {
        Text("数据与契约", color = palette.text, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        V2SettingsValue(palette, "统计口径", "有效 Token = 输入 + 输出")
        V2SettingsValue(palette, "缓存", "读写独立，不重复计入有效 Token")
        // 断网走查时这两行写着「已连接 / 已同步」，而同一个 App 的顶栏正写着
        // 「网络不可用，正在显示 09-07 21:36 的数据」、额度页正写着「本机历史快照」。
        // 设置页不该替另外两屏改口。
        //
        // Stats v2 这行说的本来就不是连接，而是契约版本谈成了哪一档（而且断网时读的是
        // 缓存里那次响应的版本）；额度那行的 Available 只表示"有快照可显示"，
        // 快照是不是历史的，Available 自己就带着答案。
        V2SettingsValue(palette, "Stats v2", if ((state.visibleData?.meta?.contractVersion ?: 1) >= 2) "已启用" else "兼容模式")
        V2SettingsValue(
            palette,
            "额度快照",
            when (val quota = state.quota) {
                is QuotaUiState.Available -> if (quota.showingCachedData) "本机历史快照" else "已同步"
                else -> "未同步"
            }
        )
    }
}

@Composable
internal fun V2WidgetSettings(palette: MobileV2Palette, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    V2Card(palette, modifier) {
        Text("摆件与能耗", color = palette.text, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        V2SettingsValue(palette, "精美摆件", "数据变化时更新")
        V2SettingsValue(palette, "墨水屏", "静态单色 · 15 分钟刷新")
        V2SettingsValue(palette, "系统约束", "尊重省电、热状态与动画倍率")
        TextButton(onClick = onOpen, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text("进入全屏摆件", color = palette.blue)
            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = palette.blue)
        }
    }
}

@Composable
internal fun V2SettingsIcon(palette: MobileV2Palette, icon: ImageVector) {
    Box(Modifier.size(38.dp).clip(RoundedCornerShape(11.dp)).background(palette.raised), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = null, tint = palette.blue, modifier = Modifier.size(V2_ICON_ACTION))
    }
}

@Composable
internal fun V2SettingsValue(palette: MobileV2Palette, label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.Top) {
        Text(label, color = palette.muted, fontSize = LedgerFont.caption, modifier = Modifier.width(82.dp))
        Text(value, color = palette.text, fontSize = LedgerFont.caption, modifier = Modifier.weight(1f), textAlign = TextAlign.End)
    }
    HorizontalDivider(color = palette.divider)
}
