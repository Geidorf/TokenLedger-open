package com.jeidorf.tokenledger.mobile

import android.content.Context
import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.regex.Pattern

/**
 * 主看板字号档位，8 个 role，取值与 T10.79 立的设计先行面
 * `src/prototypes/android-dashboard-prototype.css` 的 `--type-*` **逐个对齐**。
 *
 * 收敛之前这份 Compose UI 有 32 个互不相干的字号（8…56sp）：同一层级的文字在不同
 * 卡片里差 1–2sp（14/15、16/17、20/21/22 都是同一角色的三种写法），8/9/10sp 又低于
 * 正文可读下限。原型早就把档位定完了，只是一直没落到 Compose 上；
 * `tests/frontend-contracts.test.mjs` 现在同时钉住两边，防止再次跑偏。
 * T10.173 §3.7（T10.177 落地）把 subtitle / title / headline 由 17 / 21 / 28 改为 16 / 20 / 24，
 * 向 M3 与桌面常用档靠拢；原型 CSS 同步改值。
 *
 * 只定字号，不定 `fontFamily`：`res/font` 里的 Noto Sans SC 是给分享海报做的字形子集
 * （每份 ~124KB，完整 CJK 要 8MB 以上），拿来当全局字体会让子集外的字——模型名、
 * 搜索词、供应商名——渲染成豆腐块，那比字体不统一严重得多。
 * 行高、字重与字距见 [LedgerType]。
 */
internal object LedgerFont {
    /** 图例、时间戳、次要标签、图表刻度。**可交互与正文的字号下限**。 */
    val caption: TextUnit = 11.sp
    /** 行内标签、说明文本、表格单元。 */
    val label: TextUnit = 12.sp
    /** 正文、卡片副标题、行内数值。 */
    val body: TextUnit = 14.sp
    /** 卡片标题、行尾数值。 */
    val subtitle: TextUnit = 16.sp
    /** 顶栏与面板标题。 */
    val title: TextUnit = 20.sp
    /** 费用副数、额度页百分比。 */
    val headline: TextUnit = 24.sp
    /** 次级头条数字。 */
    val displaySmall: TextUnit = 32.sp
    /** 独占整行的头条数字（实体页 / 主看板 Token 总量）。 */
    val display: TextUnit = 40.sp
}

/**
 * 息屏与挂件预览的字号档位。这是一套**独立**的排版系统，刻意不与主看板共用：
 * 息屏要在一臂之外可读（大数字配宽字距的小标签），挂件预览则是整块等比缩小的缩略图，
 * 套主看板的 11sp 下限会撑破预览框。改这一档不影响主看板，反之亦然。
 */
internal object AmbientFont {
    /** 缩略图角标、版权行。 */
    val micro: TextUnit = 8.sp
    /** 缩略图正文、息屏次要标签。 */
    val small: TextUnit = 9.sp
    /** 息屏正文。 */
    val body: TextUnit = 10.sp
    /** 息屏强调正文。 */
    val bodyLarge: TextUnit = 11.sp
    /** 息屏行内标签与数值注脚。 */
    val label: TextUnit = 13.sp
    /** 息屏小节标题。 */
    val title: TextUnit = 15.sp
    /** 息屏分区标题。 */
    val titleLarge: TextUnit = 17.sp
    /** 息屏三级数值。 */
    val headline: TextUnit = 20.sp
    /** 息屏二级数值、每日一句。 */
    val numeral: TextUnit = 24.sp
    /** 息屏主数值。 */
    val display: TextUnit = 38.sp
    /** 息屏头条数值（Glance / Ledger 档）。 */
    val displayLarge: TextUnit = 46.sp
    /** 单指标铺满整屏时的数值（Pulse 档）。 */
    val hero: TextUnit = 56.sp
}

/**
 * 让数字等宽对齐的 OpenType 特性。
 *
 * **不要用 [androidx.compose.ui.text.font.FontFamily.Monospace] 来对齐数字**：
 * Android 的等宽族没有 CJK 字形，只要同一段里有汉字，汉字就会逐字回落到系统默认
 * 字体，同一行里出现两种字面。tnum 只要求等宽数字，字体族不变，中英文混排照常。
 * 纯 ASCII / 纯数字的息屏排版仍可以有意选用等宽族。
 */
internal const val TABULAR_NUMERALS = "tnum"

/**
 * 文字样式（T10.173 §3.7）：只引用 [LedgerFont] 的尺寸档，再定行高、字重、字距与等宽数字。
 *
 * - 数字样式 `num*` 一律 600 + `tnum`；大数收紧字距。数字不换行，长度 ≥9 / ≥11 个字符各降一档，
 *   由调用方按格式化结果选择。
 * - 多行中文正文行高 ≥1.5 倍（[body] 14/22）；中文不加字距，只有 [caption] / [labelS] 略放宽。
 * - 行高居中且不裁首末行（`Trim.None`）：单行文字的盒高就是行高，徽标 24dp = 16 行高 + 2×4 内边距。
 */
internal object LedgerType {
    /** 今日主数、专属看板主数。 */
    val numXL: TextStyle = ledgerTextStyle(fontSize = LedgerFont.display, lineHeight = 44.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.02).em, tabular = true)
    /** 复盘趋势主数、年历总量。 */
    val numL: TextStyle = ledgerTextStyle(fontSize = LedgerFont.displaySmall, lineHeight = 36.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.02).em, tabular = true)
    /** 费用副数、额度页百分比、专属看板构成格。 */
    val numM: TextStyle = ledgerTextStyle(fontSize = LedgerFont.headline, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.01).em, tabular = true)
    /** 行尾数值、次级指标。 */
    val numS: TextStyle = ledgerTextStyle(fontSize = LedgerFont.subtitle, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, tabular = true)
    /** 顶栏标题、面板标题。 */
    val titleL: TextStyle = ledgerTextStyle(fontSize = LedgerFont.title, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.01).em)
    /** 卡片标题。 */
    val titleM: TextStyle = ledgerTextStyle(fontSize = LedgerFont.subtitle, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold)
    /** 卡内小节标题。 */
    val titleS: TextStyle = ledgerTextStyle(fontSize = LedgerFont.body, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold)
    /** 对话框正文、登录页。 */
    val bodyL: TextStyle = ledgerTextStyle(fontSize = LedgerFont.subtitle, lineHeight = 24.sp, fontWeight = FontWeight.Normal)
    /** 正文、说明段落。 */
    val body: TextStyle = ledgerTextStyle(fontSize = LedgerFont.body, lineHeight = 22.sp, fontWeight = FontWeight.Normal)
    /** 按钮、分段、行标题。 */
    val label: TextStyle = ledgerTextStyle(fontSize = LedgerFont.body, lineHeight = 20.sp, fontWeight = FontWeight.Medium)
    /** 导航标签、芯片、徽标。 */
    val labelS: TextStyle = ledgerTextStyle(fontSize = LedgerFont.label, lineHeight = 16.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.01.em)
    /** 行说明、时间、副行。 */
    val meta: TextStyle = ledgerTextStyle(fontSize = LedgerFont.label, lineHeight = 18.sp, fontWeight = FontWeight.Normal)
    /** 坐标刻度、图例、分组眉题；**可交互与正文的硬下限**。 */
    val caption: TextStyle = ledgerTextStyle(fontSize = LedgerFont.caption, lineHeight = 16.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.02.em)
}

private val LedgerLineHeightStyle = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.None
)

private fun ledgerTextStyle(
    fontSize: TextUnit,
    lineHeight: TextUnit,
    fontWeight: FontWeight,
    letterSpacing: TextUnit = 0.em,
    tabular: Boolean = false
): TextStyle = TextStyle(
    fontSize = fontSize,
    lineHeight = lineHeight,
    fontWeight = fontWeight,
    letterSpacing = letterSpacing,
    fontFeatureSettings = if (tabular) TABULAR_NUMERALS else null,
    lineHeightStyle = LedgerLineHeightStyle
)

/**
 * 动效时长（T10.173 §3.9，与桌面动效原语一一对应）。改造前整份 8000 行 UI 只有一个
 * 箭头旋转动画，模式切换、展开收起、进度条与数据条全是硬跳。`FAST / STANDARD / EMPHASIZED`
 * 保留名字、改为 160 / 260 / 420，其余为 T10.177 新增；配 [ledgerTween] 与 [LedgerEasing] 使用。
 *
 * 墨水屏与「关闭动画」的系统设置都会把时长与延迟压到 0：墨水屏每一帧重绘都是可见的残影，
 * 补间动画在上面不是好看不好看的问题，是必须没有。无限循环（[LIVE_MILLIS]、[SPIN_MILLIS]）
 * 在关闭时不启动，改为静态文字状态。
 */
internal object LedgerMotion {
    /** 离散对象（按钮、卡片、分段、图标按钮）按压缩到 [PRESSED_SCALE]；列表行保留水波纹，不缩放。 */
    const val PRESS_MILLIS = 90
    /** 颜色类状态：选中文字色、Switch、芯片。 */
    const val FAST_MILLIS = 160
    /** 菜单、读数气泡：淡入并从 97% 放大，原点在触点。 */
    const val POP_MILLIS = 180
    /** 用户主动改变查询或档位后的条宽、数字、重排；**后台刷新立即完成，不动**。 */
    const val UPDATE_MILLIS = 240
    /** 对话框从 98% 落定（[LedgerEasing.EaseOutExpo]）。 */
    const val STANDARD_MILLIS = 260
    /** 分段胶囊与导航胶囊的偏移与宽度（[LedgerEasing.EaseOutExpo]）；首帧直接落位不滑。 */
    const val INDICATOR_MILLIS = 360
    /** 切一级页、切复盘页签：新页淡入并上移 [ENTER_OFFSET]（[LedgerEasing.EaseOutExpo]）。 */
    const val EMPHASIZED_MILLIS = 420
    /** 数据条、额度条挂载时从起点生长（[LedgerEasing.EaseOutExpo]）。 */
    const val GROW_MILLIS = 420
    /** 首次进入的卡片逐项错开；骨架屏不逐卡延迟。 */
    const val STAGGER_MILLIS = 40
    const val STAGGER_MAX_ITEMS = 4
    /** 曲线首次揭示（裁剪矩形由左向右，[LedgerEasing.EaseOutCubic]）。 */
    const val CHART_REVEAL_MILLIS = 700
    /** 用户切换指标或范围后的曲线形变（[LedgerEasing.EaseOutCubic]）。 */
    const val CHART_UPDATE_MILLIS = 450
    /** 同步中的状态点呼吸环，循环；空闲时静止。 */
    const val LIVE_MILLIS = 1800
    /** 刷新图标旋转，循环、线性，只在刷新进行中。 */
    const val SPIN_MILLIS = 900
    /** 按压缩放的终点（桌面 `.tl-press`）。 */
    const val PRESSED_SCALE = 0.97f
    /** [EMPHASIZED_MILLIS] 页面揭示时的上移距离。 */
    val ENTER_OFFSET: Dp = 10.dp
}

/** §3.9 的三条曲线；数据相关的元素不用回弹（阻尼比 < 1 的弹簧只留给底部面板这类系统手势）。 */
internal object LedgerEasing {
    /** 状态、按压、弹出、数据更新。 */
    val EaseOutQuart: Easing = CubicBezierEasing(0.25f, 1f, 0.5f, 1f)
    /** 落定、指示器、入场、生长。 */
    val EaseOutExpo: Easing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)
    /** 图表揭示与形变。 */
    val EaseOutCubic: Easing = CubicBezierEasing(0.33f, 1f, 0.68f, 1f)
}

/**
 * 统一的补间：`enabled = false` 时时长**与延迟**都退化成 0，动画照样"跑"，只是一帧到位，
 * 因此调用方不需要为墨水屏和无障碍设置各写一条分支。错开与延迟必须写成 `delayMillis`，
 * 不要用协程 `delay()`：`tween` 会随开发者选项的动画倍率缩放，手写的等待不会。
 */
internal fun <T> ledgerTween(
    durationMillis: Int,
    enabled: Boolean = true,
    delayMillis: Int = 0,
    easing: Easing = LedgerEasing.EaseOutQuart
): FiniteAnimationSpec<T> =
    tween(
        durationMillis = if (enabled) durationMillis else 0,
        delayMillis = if (enabled) delayMillis else 0,
        easing = easing
    )

/** 当前外观与系统设置是否允许播放补间动画。 */
@Composable
internal fun ledgerMotionEnabled(isEInk: Boolean): Boolean = !isEInk && systemAnimationsEnabled()

/**
 * 「现在」的注入点，默认就是系统时钟。
 *
 * 只有一个理由需要它：额度重置写的是相对时间（`重置 4 小时后`），而截图夹具钉死的是
 * 绝对时间戳。两者一相减，同一份夹具在不同时刻渲染出不同的字——参考图每过一小时就
 * 自己变红一次。2026-09-08 实测 `重置 4 小时后` → `3 小时后`，三张图无缘无故失败。
 * 会自己变红的门禁不是门禁：它只会教人闭着眼睛去 update 参考图。
 */
internal val LocalLedgerNow = staticCompositionLocalOf<() -> Instant> { { Instant.now() } }

/**
 * 旧 `SnapshotPalette` 的提供者。T10.177 起颜色只有 `ui/foundation/LedgerTokens.kt` 一处来源，
 * 这份色板（值早已无人读取）连同 `LocalLedgerPalette` 与 `Ledger*` 访问器一并删除；
 * 这里只保留签名、直接渲染内容，调用点由各视觉任务在自己的文件里顺手删除。
 */
@Composable
internal fun ProvideLedgerPalette(
    @Suppress("UNUSED_PARAMETER") appearance: LedgerAppearance,
    content: @Composable () -> Unit
) {
    content()
}

// Top-level pre-compiled regex singletons
private val TIME_REGEX: Pattern = Pattern.compile("(?:^|[T ])(\\d{1,2}:\\d{2})(?::\\d{2})?")
private val DAY_PROGRESS_REGEX: Pattern = Pattern.compile("(?:^|[T ])(\\d{1,2}):(\\d{2})(?::\\d{2})?")

internal fun shortTime(value: String?): String {
    if (value.isNullOrBlank()) return "当前进度"
    val matcher = TIME_REGEX.matcher(value.trim())
    return if (matcher.find()) matcher.group(1) ?: "当前进度" else "当前进度"
}

internal fun dayProgressFraction(value: String?): Float? {
    if (value.isNullOrBlank()) return null
    val matcher = DAY_PROGRESS_REGEX.matcher(value.trim())
    if (!matcher.find()) return null
    val hour = matcher.group(1)?.toIntOrNull() ?: return null
    val minute = matcher.group(2)?.toIntOrNull() ?: return null
    if (hour !in 0..24 || minute !in 0..59 || (hour == 24 && minute != 0)) return null
    return ((hour * 60 + minute) / (24f * 60f)).coerceIn(0f, 1f)
}

internal fun chartXFractions(
    buckets: List<String>,
    pointCount: Int,
    cutoffFraction: Float?,
    dayWindow: Boolean,
    anchorLastToCutoff: Boolean
): List<Float> {
    if (pointCount <= 0) return emptyList()
    val indexed = if (pointCount == 1) {
        listOf(0.5f)
    } else {
        List(pointCount) { index -> index / (pointCount - 1f) }
    }
    if (!dayWindow) return indexed

    val parsed = List(pointCount) { index -> buckets.getOrNull(index)?.let(::dayProgressFraction) }
    val parsedValues = parsed.filterNotNull()
    val parsedMonotonic = parsedValues.size == pointCount && parsedValues.zipWithNext().all { (left, right) -> left <= right }
    val normalizedCutoff = cutoffFraction?.coerceIn(0f, 1f)
    val result = if (parsedMonotonic) {
        parsedValues
    } else {
        val extent = if (anchorLastToCutoff && normalizedCutoff != null) normalizedCutoff else 1f
        indexed.map { it * extent }
    }
    if (!anchorLastToCutoff || normalizedCutoff == null) return result
    return result.mapIndexed { index, fraction ->
        if (index == result.lastIndex) normalizedCutoff else fraction.coerceAtMost(normalizedCutoff)
    }
}

internal fun formatTimestamp(epochMillis: Long): String = runCatching {
    DateTimeFormatter.ofPattern("MM-dd HH:mm", Locale.SIMPLIFIED_CHINESE)
        .format(Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault()))
}.getOrDefault("未知")

/**
 * 系统「移除动画」/ 开发者选项里的动画倍率是否为 0。
 *
 * 以前用 `remember(context)` 只读一次：用户在系统设置里关掉动画、切回应用后，
 * 这一次会话里补间照放。现在每次 `ON_RESUME` 重读（T10.173 §5 第 7 条），改完回来即生效；
 * 首次组合时直接读当前值，不等生命周期事件。
 */
@Composable
internal fun systemAnimationsEnabled(): Boolean {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var enabled by remember(context) { mutableStateOf(readSystemAnimationsEnabled(context)) }
    DisposableEffect(context, lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                enabled = readSystemAnimationsEnabled(context)
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    return enabled
}

internal fun readSystemAnimationsEnabled(context: Context): Boolean = runCatching {
    Settings.Global.getFloat(
        context.contentResolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        1f
    ) > 0f
}.getOrDefault(true)
