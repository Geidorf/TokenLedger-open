package com.jeidorf.tokenledger.mobile.ui.navigation

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerMotion
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ledgerTween
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE

/** 悬浮导航胶囊的外圆角与选中胶囊圆角（重构方案 v2：容器 16、选中项 11，同心差 5 = 内边距）。 */
private val DockRadius = 16.dp
private val DockItemRadius = 11.dp
private val DockPadding = 5.dp

/**
 * 底部导航（重构方案 v2）：对齐参考设计顶部导航的分段胶囊，改成悬浮在页面上方的一整条胶囊——
 * 容器是卡片色加 1dp 发丝边，选中项填一块实底胶囊，图标与文字由弱色变正文色。
 *
 * 不再用 M3 [androidx.compose.material3.NavigationBar]：它的指示器做不出整条胶囊。每一项仍是
 * 带 `切换到 $label` 动作名的单选项（契约「Android dashboard top actions and navigation expose
 * explicit TalkBack actions」），48dp 以上命中区；墨水屏没有阴影，选中项靠 `selected` 实底区分。
 */
@Composable
internal fun V2NavigationBar(
    palette: MobileV2Palette,
    selected: MobileDestination,
    onSelect: (MobileDestination) -> Unit
) {
    val tokens = palette.tokens
    val shape = RoundedCornerShape(DockRadius)
    Box(
        Modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.navigationBars)
            .padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 12.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .then(if (tokens.isEInk) Modifier else Modifier.shadow(12.dp, shape, clip = false))
                .clip(shape)
                .background(tokens.card)
                .border(if (tokens.isEInk) LedgerStroke.einkCard else LedgerStroke.hairline, tokens.divider, shape)
                .padding(DockPadding),
            horizontalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            MobileDestination.entries.forEach { destination ->
                V2DockItem(
                    palette = palette,
                    destination = destination,
                    isSelected = selected == destination,
                    onClick = { onSelect(destination) },
                    modifier = Modifier.semantics {
                        onClick("切换到${destination.label}", null)
                    }
                )
            }
        }
    }
}

/** 选中胶囊的底色：深色取最高一档容器、浅色取 raised，墨水屏走 selected（纯黑反白之外的实底）。 */
internal fun v2DockSelectedFill(palette: MobileV2Palette): Color {
    val tokens = palette.tokens
    return when {
        tokens.isEInk -> tokens.selected
        tokens.isDark -> tokens.surfaceContainerHighest
        else -> tokens.raised
    }
}

@Composable
private fun RowScope.V2DockItem(
    palette: MobileV2Palette,
    destination: MobileDestination,
    isSelected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier
) {
    val tokens = palette.tokens
    val motion = ledgerMotionEnabled(tokens.isEInk)
    val fill by animateColorAsState(
        if (isSelected) v2DockSelectedFill(palette) else Color.Transparent,
        animationSpec = ledgerTween(LedgerMotion.FAST_MILLIS, motion),
        label = "dockFill"
    )
    val content by animateColorAsState(
        when {
            isSelected && tokens.isEInk -> tokens.onSelected
            isSelected -> tokens.text
            else -> tokens.muted
        },
        animationSpec = ledgerTween(LedgerMotion.FAST_MILLIS, motion),
        label = "dockContent"
    )
    Column(
        modifier = modifier
            .weight(1f)
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(DockItemRadius))
            .background(fill)
            .semantics { selected = isSelected }
            .clickable(role = Role.Tab, onClick = onClick)
            .padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        Icon(destination.icon, contentDescription = null, tint = content, modifier = Modifier.size(V2_ICON_INLINE))
        Text(
            destination.label,
            color = content,
            fontSize = LedgerFont.caption,
            fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
            textAlign = TextAlign.Center,
            maxLines = 1
        )
    }
}
