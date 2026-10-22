package com.jeidorf.tokenledger.mobile.ui.foundation

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.LocalTonalElevationEnabled
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerType

/**
 * 应用的 Material 3 主题（T10.173 §3.2，T10.177 从 `MainActivity.kt` 移来）。
 *
 * 颜色一律取自 [LedgerPalettes]；`ColorScheme` 用全参构造、**每个槽位显式赋值**——
 * `darkColorScheme()` / `lightColorScheme()` 没写到的槽会回落到 M3 默认紫色系，
 * 日期选择器、Switch、菜单就会冒出第三种颜色（D11 的来源之一）。
 *
 * 本项目不用色调抬升：`surfaceTint` = 页面底，且整棵树关闭 `LocalTonalElevationEnabled`，
 * 纵深只靠 §3.3 的边、内高光与短柔阴影。
 */
@Composable
internal fun LedgerMaterialTheme(
    appearance: LedgerAppearance,
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = ledgerColorScheme(LedgerPalettes.of(appearance)),
        shapes = LedgerShapes,
        typography = LedgerTypography
    ) {
        CompositionLocalProvider(LocalTonalElevationEnabled provides false, content = content)
    }
}

/** §3.2 的逐槽映射。36 个槽位全部显式赋值，JVM 测试逐个核对。 */
internal fun ledgerColorScheme(c: LedgerColors): ColorScheme = ColorScheme(
    primary = c.primary,
    onPrimary = c.onPrimary,
    primaryContainer = c.primaryContainerSolid,
    onPrimaryContainer = c.onPrimaryContainer,
    inversePrimary = c.inversePrimary,
    secondary = c.accent,
    onSecondary = c.onAccent,
    secondaryContainer = c.primaryContainerSolid,
    onSecondaryContainer = c.onPrimaryContainer,
    tertiary = c.tertiary,
    onTertiary = c.onTertiary,
    // §3.2 未列：按「卡内浮起块 + 主文字」补齐，不让它回落到 M3 默认色。
    tertiaryContainer = c.raised,
    onTertiaryContainer = c.text,
    background = c.page,
    onBackground = c.text,
    surface = c.page,
    onSurface = c.text,
    // §3.2 末段：墨水屏所有 surface* 为白，只有 surfaceContainer 是 #F2F2F2。
    surfaceVariant = if (c.isEInk) c.card else c.raised,
    onSurfaceVariant = c.muted,
    surfaceTint = c.page,
    inverseSurface = c.inverseSurface,
    inverseOnSurface = c.inverseOnSurface,
    error = c.danger,
    onError = c.onError,
    errorContainer = c.errorContainer,
    onErrorContainer = c.onErrorContainer,
    outline = c.outline,
    outlineVariant = c.divider,
    scrim = c.scrim,
    surfaceBright = c.surfaceBright,
    surfaceContainer = c.raised,
    surfaceContainerHigh = c.surfaceContainerHigh,
    surfaceContainerHighest = c.surfaceContainerHighest,
    surfaceContainerLow = c.surfaceContainerLow,
    surfaceContainerLowest = c.surfaceContainerLowest,
    surfaceDim = c.surfaceDim
)

/** §3.4：6 / 8 / 12 / 16 / 20。 */
internal val LedgerShapes: Shapes = Shapes(
    extraSmall = RoundedCornerShape(LedgerRadius.xs),
    small = RoundedCornerShape(LedgerRadius.sm),
    medium = RoundedCornerShape(LedgerRadius.md),
    large = RoundedCornerShape(LedgerRadius.lg),
    extraLarge = RoundedCornerShape(LedgerRadius.xl)
)

/**
 * M3 `Typography` 15 槽（§3.7）。字号一律经 [LedgerFont]（13 个槽经 [LedgerType] 间接引用），
 * 不写字面量：留白的槽会回落到 Material 默认的 Roboto 16/14/12sp。
 *
 * `bodyLarge` / `bodyMedium` 是 `Text()` 不写样式时的默认值，A0 **刻意**保持 14 / 12sp、
 * 不带行高（root 2026-09-25 决定）：依赖默认样式的 `Text()` 分属 A1–A10（清单按文件列在 T10.177 日志里，
 * 处数随各任务迁移而变，这里不写死），由各任务在自己的文件里显式改成 [LedgerType]，
 * 最后一个任务再把默认值切到 §3.7 的 16 / 14。注意 M3 组件 slot 里的 `Text()` 取的是 slot 的槽
 * （按钮取 `labelLarge`、日期范围标题取 `titleLarge`、输入框浮起的标签取 `bodySmall`），不是 `bodyLarge`。
 */
internal val LedgerTypography: Typography = Typography(
    displayLarge = LedgerType.numXL,
    displayMedium = LedgerType.numL,
    displaySmall = LedgerType.numM,
    headlineLarge = LedgerType.numM,
    headlineMedium = LedgerType.numM,
    headlineSmall = LedgerType.titleL,
    titleLarge = LedgerType.titleL,
    titleMedium = LedgerType.titleM,
    titleSmall = LedgerType.titleS,
    bodyLarge = TextStyle(fontWeight = FontWeight.Normal, fontSize = LedgerFont.body),
    bodyMedium = TextStyle(fontWeight = FontWeight.Normal, fontSize = LedgerFont.label),
    bodySmall = LedgerType.meta,
    labelLarge = LedgerType.label,
    labelMedium = LedgerType.labelS,
    labelSmall = LedgerType.caption
)
