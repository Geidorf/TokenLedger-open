package com.jeidorf.tokenledger.mobile.ui.navigation

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette

/**
 * 平板 / 横屏侧轨（§4.2、§7.13）：容器改 `chrome`，右侧补 1dp `divider` 发丝线（design：
 * 「容器 chrome，右侧 1dp divider」；旧版容器一直是 `palette.surface`、也没有这条线）。
 *
 * 选中态指示器颜色的取舍与 [V2NavigationBar] 同一份说明：design 要「一个胶囊滑过去」，
 * M3 `NavigationRailItemDefaults` 做不到，走 design 自己写的退路——保留标准
 * [NavigationRailItem]（读屏树、`切换到 $label` 动作名不变，契约「Android dashboard top actions
 * and navigation expose explicit TalkBack actions」钉的是这一段），只换成本应用的令牌颜色。
 */
@Composable
internal fun V2NavigationRail(
    palette: MobileV2Palette,
    selected: MobileDestination,
    onSelect: (MobileDestination) -> Unit,
    modifier: Modifier = Modifier
) {
    val tokens = palette.tokens
    val dividerColor = tokens.divider
    NavigationRail(
        modifier = modifier
            .width(76.dp)
            .fillMaxHeight()
            .drawBehind {
                val strokeWidth = LedgerStroke.hairline.toPx()
                drawLine(
                    color = dividerColor,
                    start = Offset(size.width - strokeWidth / 2f, 0f),
                    end = Offset(size.width - strokeWidth / 2f, size.height),
                    strokeWidth = strokeWidth
                )
            },
        containerColor = tokens.chrome
    ) {
        Spacer(Modifier.height(10.dp))
        MobileDestination.entries.forEach { destination ->
            NavigationRailItem(
                selected = selected == destination,
                onClick = { onSelect(destination) },
                modifier = Modifier.semantics {
                    onClick("切换到${destination.label}", null)
                },
                icon = { Icon(destination.icon, contentDescription = destination.label) },
                label = { Text(destination.label, fontSize = LedgerFont.caption) },
                alwaysShowLabel = true,
                colors = NavigationRailItemDefaults.colors(
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
