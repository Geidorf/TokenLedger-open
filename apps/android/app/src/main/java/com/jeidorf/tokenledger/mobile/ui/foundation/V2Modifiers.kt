package com.jeidorf.tokenledger.mobile.ui.foundation

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import com.jeidorf.tokenledger.mobile.LedgerEasing
import com.jeidorf.tokenledger.mobile.LedgerMotion
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ledgerTween

/**
 * 离散对象（按钮、卡片、分段、图标按钮）的按压反馈：缩到 97%（§3.9 `PRESS`，桌面 `.tl-press`）。
 * 列表行保留 M3 水波纹，不缩放。
 */
@Composable
internal fun Modifier.pressScale(
    interactionSource: InteractionSource,
    motionEnabled: Boolean,
    pressedScale: Float = LedgerMotion.PRESSED_SCALE
): Modifier {
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) pressedScale else 1f,
        animationSpec = ledgerTween(LedgerMotion.PRESS_MILLIS, motionEnabled),
        label = "pressScale"
    )
    return graphicsLayer { scaleX = scale; scaleY = scale }
}

/**
 * §3.3 L1 卡片纵深，一律不用色调抬升：
 * - 深色：1dp `cardBorder`（= divider）边 + 顶部 1dp 白 3.5% 内高光，无投影（深色下阴影看不见）；
 * - 浅色：1dp 墨 6% 边 + 短柔阴影（桌面 `--shadow-card`），阴影色取 `shadow`；
 * - 墨水屏：1.5dp 黑边，无阴影、无高光。
 * 内容裁到 [shape]；底色是 `card`。
 */
internal fun Modifier.ledgerCardDepth(colors: LedgerColors, shape: Shape): Modifier {
    val lifted = if (colors.shadow.alpha > 0f && !colors.isDark) {
        shadow(
            elevation = LedgerElevation.card,
            shape = shape,
            clip = false,
            ambientColor = colors.shadow,
            spotColor = colors.shadow
        )
    } else {
        this
    }
    val stroke = if (colors.isEInk) LedgerStroke.einkCard else LedgerStroke.hairline
    return lifted
        .border(stroke, colors.cardBorder, shape)
        .background(colors.card, shape)
        .clip(shape)
        .then(
            if (colors.cardHighlight.alpha > 0f) {
                Modifier.drawBehind {
                    // 紧贴 1dp 边框内侧的一条高光带；圆角处由外层裁剪自然收口。
                    val band = LedgerStroke.hairline.toPx()
                    drawRect(colors.cardHighlight, topLeft = Offset(0f, band), size = Size(size.width, band))
                }
            } else {
                Modifier
            }
        )
}

@Composable
internal fun Modifier.v2DataBarBackground(
    palette: MobileV2Palette,
    color: Color,
    fraction: Float
): Modifier {
    val animated by animateFloatAsState(
        targetValue = fraction.coerceIn(0f, 1f),
        animationSpec = ledgerTween(
            LedgerMotion.GROW_MILLIS,
            ledgerMotionEnabled(palette.isEInk),
            easing = LedgerEasing.EaseOutExpo
        ),
        label = "dataBar"
    )
    return v2DataBarBackground(palette, color, animated, animate = false)
}

/** [animate] = false 的那一路是真正画条的实现，供已经拿到动画值的调用方使用。 */
internal fun Modifier.v2DataBarBackground(
    palette: MobileV2Palette,
    color: Color,
    fraction: Float,
    @Suppress("UNUSED_PARAMETER") animate: Boolean
): Modifier = clip(RoundedCornerShape(LedgerRadius.sm)).drawWithCache {
    val bounded = fraction.coerceIn(0f, 1f)
    if (bounded <= 0f) {
        onDrawBehind { /* No-op when fraction is zero */ }
    } else {
        val thickness = LedgerStroke.dataBarCompact.toPx()
        val barAlpha = if (palette.isEInk) 0.65f else 0.45f
        val barColor = (if (palette.isEInk) palette.text else color).copy(alpha = barAlpha)
        val topLeft = Offset(0f, (size.height - thickness).coerceAtLeast(0f))
        val barSize = Size(
            width = size.width * bounded,
            height = thickness
        )
        val cornerRadius = CornerRadius(thickness / 2f, thickness / 2f)

        onDrawBehind {
            drawRoundRect(
                color = barColor,
                topLeft = topLeft,
                size = barSize,
                cornerRadius = cornerRadius
            )
        }
    }
}

internal fun nextTokenDisplayMode(current: TokenDisplayMode): TokenDisplayMode = when (current) {
    TokenDisplayMode.Effective -> TokenDisplayMode.All
    TokenDisplayMode.All -> TokenDisplayMode.Effective
}

internal fun Modifier.tokenModeToggle(
    current: TokenDisplayMode,
    onChange: (TokenDisplayMode) -> Unit,
    displayedValue: String? = null
): Modifier {
    val next = nextTokenDisplayMode(current)
    return toggleable(
        value = current == TokenDisplayMode.All,
        role = Role.Switch,
        onValueChange = { showAll ->
            onChange(if (showAll) TokenDisplayMode.All else TokenDisplayMode.Effective)
        }
    ).semantics(mergeDescendants = displayedValue != null) {
        contentDescription = if (displayedValue == null) {
            "${current.label} Token，双击切换为${next.label} Token"
        } else {
            "${current.label} Token $displayedValue，双击切换为${next.label} Token"
        }
        stateDescription = "当前为${current.label} Token"
        onClick("切换为${next.label} Token", null)
    }
}
