package com.jeidorf.tokenledger.mobile.ui.onboarding

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSize
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE
import com.jeidorf.tokenledger.mobile.ui.foundation.pressScale

/** 空状态卡上的一个按钮。 */
internal class V2EmptyAction(val label: String, val enabled: Boolean = true, val onClick: () -> Unit)

/**
 * 各页「没有数据」时的卡：说清缺的是什么、去哪补，再给下一步按钮。和桌面端空状态同一个写法：
 * 图标块 + 标题 + 一两句说明 + 主按钮（可选次按钮）。
 *
 * 主按钮缺省是「查看接入步骤」——只有外壳提供了 [LocalOpenFirstRunGuide] 才画。
 */
@Composable
internal fun V2EmptyState(
    palette: MobileV2Palette,
    icon: ImageVector,
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    primary: V2EmptyAction? = LocalOpenFirstRunGuide.current?.let { V2EmptyAction("查看接入步骤", onClick = it) },
    secondary: V2EmptyAction? = null
) {
    V2Card(palette, modifier = modifier) {
        V2EmptyIconTile(palette, icon)
        Spacer(Modifier.height(LedgerSpace.md))
        Text(title, style = LedgerType.titleM, color = palette.text, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(LedgerSpace.xs))
        Text(
            body,
            style = LedgerType.body,
            color = palette.muted,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
        )
        if (primary != null || secondary != null) {
            Spacer(Modifier.height(LedgerSpace.lg))
            Column(verticalArrangement = Arrangement.spacedBy(LedgerSpace.sm)) {
                primary?.let { V2EmptyPrimaryButton(palette, it) }
                secondary?.let { V2EmptySecondaryButton(palette, it) }
            }
        }
    }
}

@Composable
internal fun V2EmptyIconTile(palette: MobileV2Palette, icon: ImageVector) {
    val shape = RoundedCornerShape(LedgerRadius.lg)
    Box(
        Modifier
            .size(40.dp)
            .clip(shape)
            .then(
                if (palette.isEInk) Modifier.border(LedgerStroke.hairline, palette.text, shape)
                else Modifier.background(palette.blueSoft)
            ),
        contentAlignment = Alignment.Center
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = if (palette.isEInk) palette.text else palette.blue,
            modifier = Modifier.size(V2_ICON_INLINE)
        )
    }
}

@Composable
internal fun V2EmptyPrimaryButton(palette: MobileV2Palette, action: V2EmptyAction, modifier: Modifier = Modifier) {
    val tokens = palette.tokens
    val interaction = remember { MutableInteractionSource() }
    Button(
        onClick = action.onClick,
        enabled = action.enabled,
        interactionSource = interaction,
        shape = RoundedCornerShape(LedgerRadius.md),
        colors = ButtonDefaults.buttonColors(containerColor = tokens.primaryFill, contentColor = tokens.onPrimaryFill),
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = LedgerSize.button)
            .pressScale(interaction, ledgerMotionEnabled(palette.isEInk))
    ) {
        Text(action.label, style = LedgerType.label)
    }
}

@Composable
internal fun V2EmptySecondaryButton(palette: MobileV2Palette, action: V2EmptyAction, modifier: Modifier = Modifier) {
    OutlinedButton(
        onClick = action.onClick,
        enabled = action.enabled,
        shape = RoundedCornerShape(LedgerRadius.md),
        border = BorderStroke(LedgerStroke.hairline, palette.outline),
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = LedgerSize.button)
    ) {
        Text(action.label, style = LedgerType.label, color = palette.text)
    }
}

/** 一行小字提示，空状态卡外的补充（例如「随时可以重新打开」）。 */
@Composable
internal fun V2EmptyFootnote(palette: MobileV2Palette, text: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
        Text(text, style = LedgerType.meta, color = palette.muted)
    }
}
