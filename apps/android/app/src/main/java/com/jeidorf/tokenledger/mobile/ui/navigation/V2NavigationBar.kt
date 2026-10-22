package com.jeidorf.tokenledger.mobile.ui.navigation

import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.dashboardNavigationBarHeightDp
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette

/**
 * 底部导航（§4.2）：容器改 `chrome`（design：「容器 chrome，顶部 1dp divider」；旧版一直是
 * `palette.surface`，即 `card`）。
 *
 * design 原文要「64×32 指示胶囊填 brandSoft 横向渐变…一个胶囊滑过去」，但 M3
 * `NavigationBarItemDefaults` 的指示器只吃纯色、且每项各自淡入做不到「一个胶囊在项间滑过去」；
 * design 自己紧接着写了退路——「做不到时回退为 M3 纯色 primaryContainer 指示器」。这里走的就是
 * 这条退路：继续用标准 [NavigationBarItem]（读屏树、TalkBack 焦点顺序、`切换到 $label` 动作名都不变
 * ——契约「Android dashboard top actions and navigation expose explicit TalkBack actions」钉的就是
 * 这一段），只把指示器与文字/图标颜色换成本应用自己的令牌（[MobileV2Palette.selected] 就是
 * `tokens.primaryContainerSolid`）。自绘滑动胶囊、选中态图标换实心变体等更贴合原文的做法留给
 * 有余量的后续任务（见任务日志「建议写入 SSOT 的文字」），不在本轮必做项里。
 */
@Composable
internal fun V2NavigationBar(
    palette: MobileV2Palette,
    selected: MobileDestination,
    onSelect: (MobileDestination) -> Unit
) {
    NavigationBar(
        modifier = Modifier.heightIn(
            min = 80.dp,
            max = dashboardNavigationBarHeightDp(LocalDensity.current.fontScale).dp
        ),
        containerColor = palette.tokens.chrome,
        tonalElevation = 0.dp
    ) {
        MobileDestination.entries.forEach { destination ->
            NavigationBarItem(
                selected = selected == destination,
                onClick = { onSelect(destination) },
                modifier = Modifier.semantics {
                    onClick("切换到${destination.label}", null)
                },
                icon = { Icon(destination.icon, contentDescription = destination.label) },
                label = { Text(destination.label, fontSize = LedgerFont.caption) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = palette.blue,
                    selectedTextColor = palette.text,
                    indicatorColor = palette.selected,
                    unselectedIconColor = palette.faint,
                    unselectedTextColor = palette.faint
                )
            )
        }
    }
}
