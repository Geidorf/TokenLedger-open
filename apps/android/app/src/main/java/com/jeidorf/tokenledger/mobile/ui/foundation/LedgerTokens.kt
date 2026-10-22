package com.jeidorf.tokenledger.mobile.ui.foundation

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerAppearance

/**
 * Android 视觉的**唯一色源**（T10.173 §3.1–§3.3、§3.8，T10.177 落地）。
 *
 * 此前同一套色在六处各抄一份：M3 配色、`SnapshotPalette`、`v2Palette`、小组件 `WidgetColors`
 * （圆环位图的危险色又是另一套）、海报预览色板、`res/values` 与 `values-night` 的 `colors.xml`——改一处漏五处，
 * 截图测试验的是副本。现在只有这里写色值：`v2Palette` 的旧字段、M3 `ColorScheme`、
 * `WidgetColors` 与海报预览色板都从 [LedgerPalettes] 派生；XML 由 JVM 测试比对。
 *
 * 角色而不是颜色：
 * - `divider` 是装饰发丝线（约 1.2:1），只能出现在边界已由底色差、间距或标题表达的地方；
 * - `outline` 是功能边界（输入框、复选框、未知值虚线槽、焦点），对四档表面都 ≥3:1；
 * - 数字、费用、变化值一律 `text` / `muted`，不染色；状态色只表状态，图表只用 `chart`。
 *
 * 墨水屏没有色相、没有半透明：状态色与强调色都是纯黑，分隔与边框是纯黑，
 * 灰阶只剩 `raised`、热力 5 级与网格这几档。
 */
@Immutable
internal data class LedgerColors(
    val appearance: LedgerAppearance,
    // —— 表面：外壳 → 页面 → 卡片 → 浮层（§3.3 四档纵深）——
    val chrome: Color,
    val page: Color,
    val card: Color,
    val raised: Color,
    /** 分段滑动胶囊的底，只放在 [raised] 轨道上用；配 [onSelected]。 */
    val selected: Color,
    val onSelected: Color,
    val popover: Color,
    // —— 文字三档 ——
    val text: Color,
    val muted: Color,
    val faint: Color,
    // —— 线 ——
    val divider: Color,
    val outline: Color,
    // —— 强调 ——
    val primary: Color,
    /** M3 `onPrimary`：画在 [primary] 上的字与图标。 */
    val onPrimary: Color,
    val primaryFill: Color,
    val onPrimaryFill: Color,
    /** 选中底（筛选芯片、导航胶囊的纯色回退）。深浅色是压在卡片上的半透明色。 */
    val primaryContainer: Color,
    /** [primaryContainer] 压在卡片上的纯色版，给只接受纯色的 M3 槽位用。 */
    val primaryContainerSolid: Color,
    val onPrimaryContainer: Color,
    val accent: Color,
    val onAccent: Color,
    // —— 品牌：只做身份（品牌块、导航选中胶囊、主卡光晕），不画数据 ——
    val brand1: Color,
    val brand2: Color,
    val brandSoftStart: Color,
    val brandSoftEnd: Color,
    /** 页面顶部环境光（§3.3 L0）：左上 / 右上两团径向光。 */
    val ambientStart: Color,
    val ambientEnd: Color,
    // —— 状态：图形色 / 小字色 / 徽标底 ——
    val success: Color,
    val successText: Color,
    val warning: Color,
    val warningText: Color,
    val danger: Color,
    val dangerText: Color,
    val successSoft: Color,
    val warningSoft: Color,
    val dangerSoft: Color,
    // —— 纵深（§3.3）——
    val cardBorder: Color,
    /** 深色卡片顶部 1dp 内高光；浅色与墨水屏为透明。 */
    val cardHighlight: Color,
    val popoverBorder: Color,
    /** 阴影色；深色卡片不投影（看不见），墨水屏没有阴影。 */
    val shadow: Color,
    /** 分段滑动胶囊下沿的 1dp 短阴影（§4.3，只有浅色有）。 */
    val pillShadow: Color,
    // —— 图表（§3.8，与桌面 `--chart-1…8` 同序同值）——
    val chart: List<Color>,
    val chartGrid: Color,
    val chartAxis: Color,
    /**
     * 同一视图第 9 名起的工具画的「其他」中性色（root 决定 R-8 d、R-16）：与桌面 T10.178 的
     * `TOOL_COLOR_OTHER_*`（即 `--color-text-muted`）同值，深 `#A5ACB9`、浅 `#586273`；
     * 墨水屏取网格灰 `#8C8C8C`（系列一律纯黑，「其他」要与之分得开）。
     */
    val chartOther: Color,
    /** 热力 5 级：0 级（已知为 0）→ 4 级（最高分位）。深浅色的 1–4 级由 chart-1 派生（[ledgerHeatRamp]）。 */
    val heat: List<Color>,
    // —— 只给 M3 `ColorScheme` 用的槽位（§3.2）——
    val tertiary: Color,
    val onTertiary: Color,
    val onError: Color,
    val errorContainer: Color,
    val onErrorContainer: Color,
    val surfaceContainerLowest: Color,
    val surfaceContainerLow: Color,
    val surfaceContainerHigh: Color,
    val surfaceContainerHighest: Color,
    val surfaceDim: Color,
    val surfaceBright: Color,
    val inverseSurface: Color,
    val inverseOnSurface: Color,
    val inversePrimary: Color,
    val scrim: Color
) {
    init {
        require(chart.size == LEDGER_CHART_SLOTS) { "chart 必须正好 $LEDGER_CHART_SLOTS 个槽位" }
        require(heat.size == LEDGER_HEAT_LEVELS) { "heat 必须正好 $LEDGER_HEAT_LEVELS 级" }
    }

    val isEInk: Boolean get() = appearance == LedgerAppearance.EInk
    val isDark: Boolean get() = appearance == LedgerAppearance.Dark

    /**
     * 额度三档的图形色（用户决定 V-Q1，2026-09-25）：充足 = [primary]（蓝，与桌面、小组件一致，
     * 推翻 T10.131 的绿色），偏紧 = [warning]，告急 = [danger]。档位词另用 `*Text`。
     * 这里只定义到令牌与原子层，额度界面由 A4 接入。
     */
    val quotaHealthy: Color get() = primary
    val quotaWarning: Color get() = warning
    val quotaCritical: Color get() = danger

    /**
     * 图表第 [slot] 号系列色，`slot` 取 1…8（即桌面 `--chart-N` 的 N）；[LEDGER_CHART_SLOT_OTHER]
     * 取 [chartOther]；其余越界值按 8 取模。
     */
    fun chartSlot(slot: Int): Color =
        if (slot == LEDGER_CHART_SLOT_OTHER) chartOther else chart[Math.floorMod(slot - 1, LEDGER_CHART_SLOTS)]
}

internal const val LEDGER_CHART_SLOTS = 8
/** 不占系列色的「其他」槽（同一视图第 9 名起，R-8 d）。 */
internal const val LEDGER_CHART_SLOT_OTHER = 0
internal const val LEDGER_HEAT_LEVELS = 5

/**
 * 深浅色的热力 5 级（§3.8）：0 级 = `raised`（已知为 0），1–3 级 = chart-1 叠 [alphas]，4 级 = chart-1 本色。
 * 只从 chart-1 派生，重调图表色时热力跟着走，不会停在旧色相（T10.177 评审 P3-11）。
 */
private fun ledgerHeatRamp(level0: Color, peak: Color, vararg alphas: Int): List<Color> =
    listOf(level0) + alphas.map { peak.copy(alpha = it / 255f) } + peak

internal object LedgerPalettes {
    /**
     * 图表 8 色，槽位 1…8 即桌面 `--chart-1…8`（§3.8）。2026-09-25 用户就 U-4 选定方案 B「均衡」：
     * 深浅两套各 28 对在 T10.161 的色弱门槛上全部过线（CIEDE2000，Machado 2009 严重度 1.0：
     * deutan ≥5.8、protan ≥5.4、tritan ≥3.3），浅色 8 色在页面底上也 ≥3:1。桌面改成同值由另一任务做。
     * 热力色阶与 M3 `tertiary` 都从这两张表派生，不再各抄一份。
     */
    private val DarkChart: List<Color> = listOf(
        Color(0xFF6B9DFF), Color(0xFF907ADC), Color(0xFF2DD4BF), Color(0xFFFBBF24),
        Color(0xFFFB7185), Color(0xFF3FE480), Color(0xFF3DBDF7), Color(0xFFFB923C)
    )
    private val LightChart: List<Color> = listOf(
        Color(0xFF2F6BE6), Color(0xFF8972FE), Color(0xFF0D9488), Color(0xFFD57501),
        Color(0xFFD41340), Color(0xFF16A34A), Color(0xFF1D85C3), Color(0xFFD34C04)
    )

    val Dark: LedgerColors = LedgerColors(
        appearance = LedgerAppearance.Dark,
        chrome = Color(0xFF0A0C10),
        page = Color(0xFF0D0F13),
        card = Color(0xFF15181E),
        raised = Color(0xFF1B1F26),
        selected = Color(0xFF2A303B),
        onSelected = Color(0xFFF2F4F7),
        popover = Color(0xFF1D2129),
        text = Color(0xFFF2F4F7),
        muted = Color(0xFFC3C8D2),
        faint = Color(0xFF9AA2B0),
        divider = Color(0x12FFFFFF),
        outline = Color(0xFF737B8A),
        primary = Color(0xFF6B9DFF),
        onPrimary = Color(0xFF0A0C10),
        primaryFill = Color(0xFF2F6BE6),
        onPrimaryFill = Color(0xFFFFFFFF),
        primaryContainer = Color(0x245B8CFF),
        primaryContainerSolid = Color(0xFF1F283E),
        onPrimaryContainer = Color(0xFFD6E3FF),
        accent = Color(0xFFA78BFA),
        onAccent = Color(0xFF0A0C10),
        brand1 = Color(0xFF5B8CFF),
        brand2 = Color(0xFF8B6CFF),
        brandSoftStart = Color(0x3D5B8CFF),
        brandSoftEnd = Color(0x2E8B6CFF),
        ambientStart = Color(0x1F5B8CFF),
        ambientEnd = Color(0x148B6CFF),
        success = Color(0xFF4ADE80),
        successText = Color(0xFF4ADE80),
        warning = Color(0xFFFBBF24),
        warningText = Color(0xFFFBBF24),
        danger = Color(0xFFFB7185),
        dangerText = Color(0xFFFB7185),
        successSoft = Color(0x1F4ADE80),
        warningSoft = Color(0x1FFBBF24),
        dangerSoft = Color(0x1FFB7185),
        cardBorder = Color(0x12FFFFFF),
        cardHighlight = Color(0x09FFFFFF),
        popoverBorder = Color(0x0DFFFFFF),
        shadow = Color(0xFF000000),
        pillShadow = Color(0x00000000),
        chart = DarkChart,
        chartGrid = Color(0x0FFFFFFF),
        chartAxis = Color(0xFF8F97A5),
        chartOther = Color(0xFFA5ACB9),
        heat = ledgerHeatRamp(Color(0xFF1B1F26), DarkChart[0], 0x47, 0x80, 0xBD),
        tertiary = DarkChart[2],
        onTertiary = Color(0xFF0A0C10),
        onError = Color(0xFF0A0C10),
        errorContainer = Color(0xFF3A1620),
        onErrorContainer = Color(0xFFFFD9DF),
        surfaceContainerLowest = Color(0xFF0A0C10),
        surfaceContainerLow = Color(0xFF15181E),
        surfaceContainerHigh = Color(0xFF1D2129),
        surfaceContainerHighest = Color(0xFF2A303B),
        surfaceDim = Color(0xFF0A0C10),
        surfaceBright = Color(0xFF2B313D),
        inverseSurface = Color(0xFFE6E9EF),
        inverseOnSurface = Color(0xFF15181E),
        inversePrimary = Color(0xFF1F5FD6),
        scrim = Color(0xA8030509)
    )

    val Light: LedgerColors = LedgerColors(
        appearance = LedgerAppearance.Light,
        chrome = Color(0xFFECEEF2),
        page = Color(0xFFF4F5F7),
        card = Color(0xFFFFFFFF),
        raised = Color(0xFFEEF0F3),
        selected = Color(0xFFFFFFFF),
        onSelected = Color(0xFF0F1729),
        popover = Color(0xFFFFFFFF),
        text = Color(0xFF0F1729),
        muted = Color(0xFF3B4556),
        faint = Color(0xFF5D6778),
        divider = Color(0x140F172A),
        outline = Color(0xFF7A8392),
        primary = Color(0xFF1F5FD6),
        onPrimary = Color(0xFFFFFFFF),
        primaryFill = Color(0xFF1F5FD6),
        onPrimaryFill = Color(0xFFFFFFFF),
        primaryContainer = Color(0x171F5FD6),
        primaryContainerSolid = Color(0xFFEBF1FB),
        onPrimaryContainer = Color(0xFF123F99),
        accent = Color(0xFF6D4AE0),
        onAccent = Color(0xFFFFFFFF),
        brand1 = Color(0xFF3B6FF5),
        brand2 = Color(0xFF7C5CF0),
        brandSoftStart = Color(0x293B6FF5),
        brandSoftEnd = Color(0x1F7C5CF0),
        ambientStart = Color(0x143B6FF5),
        ambientEnd = Color(0x0F7C5CF0),
        success = Color(0xFF15803D),
        successText = Color(0xFF166534),
        warning = Color(0xFFA15C07),
        warningText = Color(0xFF8A4B00),
        danger = Color(0xFFC81E3C),
        dangerText = Color(0xFFC81E3C),
        successSoft = Color(0x1A15803D),
        warningSoft = Color(0x1AA15C07),
        dangerSoft = Color(0x14C81E3C),
        cardBorder = Color(0x0F0F172A),
        cardHighlight = Color(0x00FFFFFF),
        popoverBorder = Color(0x0F0F172A),
        shadow = Color(0xFF0F172A),
        pillShadow = Color(0x1A0F172A),
        chart = LightChart,
        chartGrid = Color(0x120F172A),
        chartAxis = Color(0xFF5D6778),
        chartOther = Color(0xFF586273),
        heat = ledgerHeatRamp(Color(0xFFEEF0F3), LightChart[0], 0x33, 0x66, 0xA8),
        tertiary = LightChart[2],
        onTertiary = Color(0xFFFFFFFF),
        onError = Color(0xFFFFFFFF),
        errorContainer = Color(0xFFFDE8EC),
        onErrorContainer = Color(0xFF7A0E24),
        surfaceContainerLowest = Color(0xFFFFFFFF),
        surfaceContainerLow = Color(0xFFF7F8FA),
        surfaceContainerHigh = Color(0xFFE9EBEF),
        surfaceContainerHighest = Color(0xFFE3E6EB),
        surfaceDim = Color(0xFFE3E6EB),
        surfaceBright = Color(0xFFFFFFFF),
        inverseSurface = Color(0xFF1D2129),
        inverseOnSurface = Color(0xFFF2F4F7),
        inversePrimary = Color(0xFF6B9DFF),
        scrim = Color(0x470F172A)
    )

    /**
     * 墨水屏：纯黑白加少量灰阶。§3.2 未给出值的三处按「无色相、无半透明」补齐：
     * 反色三槽取黑底白字（选中态一律反白），遮罩取透明（不叠半透明，靠浮层 2dp 黑边区分）。
     */
    val EInk: LedgerColors = LedgerColors(
        appearance = LedgerAppearance.EInk,
        chrome = Color(0xFFFFFFFF),
        page = Color(0xFFFFFFFF),
        card = Color(0xFFFFFFFF),
        raised = Color(0xFFF2F2F2),
        selected = Color(0xFF000000),
        onSelected = Color(0xFFFFFFFF),
        popover = Color(0xFFFFFFFF),
        text = Color(0xFF000000),
        muted = Color(0xFF333333),
        faint = Color(0xFF595959),
        divider = Color(0xFF000000),
        outline = Color(0xFF000000),
        primary = Color(0xFF000000),
        onPrimary = Color(0xFFFFFFFF),
        primaryFill = Color(0xFF000000),
        onPrimaryFill = Color(0xFFFFFFFF),
        primaryContainer = Color(0xFFE6E6E6),
        primaryContainerSolid = Color(0xFFE6E6E6),
        onPrimaryContainer = Color(0xFF000000),
        accent = Color(0xFF000000),
        onAccent = Color(0xFFFFFFFF),
        brand1 = Color(0xFF000000),
        brand2 = Color(0xFF000000),
        brandSoftStart = Color(0xFF000000),
        brandSoftEnd = Color(0xFF000000),
        ambientStart = Color(0x00FFFFFF),
        ambientEnd = Color(0x00FFFFFF),
        success = Color(0xFF000000),
        successText = Color(0xFF000000),
        warning = Color(0xFF000000),
        warningText = Color(0xFF000000),
        danger = Color(0xFF000000),
        dangerText = Color(0xFF000000),
        successSoft = Color(0xFFFFFFFF),
        warningSoft = Color(0xFFFFFFFF),
        dangerSoft = Color(0xFFFFFFFF),
        cardBorder = Color(0xFF000000),
        cardHighlight = Color(0x00FFFFFF),
        popoverBorder = Color(0xFF000000),
        shadow = Color(0x00000000),
        pillShadow = Color(0x00000000),
        chart = List(LEDGER_CHART_SLOTS) { Color(0xFF000000) },
        chartGrid = Color(0xFF8C8C8C),
        chartAxis = Color(0xFF333333),
        chartOther = Color(0xFF8C8C8C),
        heat = listOf(
            Color(0xFFF2F2F2), Color(0xFFC8C8C8), Color(0xFF969696), Color(0xFF5A5A5A), Color(0xFF000000)
        ),
        tertiary = Color(0xFF000000),
        onTertiary = Color(0xFFFFFFFF),
        onError = Color(0xFFFFFFFF),
        errorContainer = Color(0xFFFFFFFF),
        onErrorContainer = Color(0xFF000000),
        surfaceContainerLowest = Color(0xFFFFFFFF),
        surfaceContainerLow = Color(0xFFFFFFFF),
        surfaceContainerHigh = Color(0xFFFFFFFF),
        surfaceContainerHighest = Color(0xFFFFFFFF),
        surfaceDim = Color(0xFFFFFFFF),
        surfaceBright = Color(0xFFFFFFFF),
        inverseSurface = Color(0xFF000000),
        inverseOnSurface = Color(0xFFFFFFFF),
        inversePrimary = Color(0xFFFFFFFF),
        scrim = Color(0x00000000)
    )

    fun of(appearance: LedgerAppearance): LedgerColors = when (appearance) {
        LedgerAppearance.Dark -> Dark
        LedgerAppearance.Light -> Light
        LedgerAppearance.EInk -> EInk
    }
}

/**
 * 间距（§3.5–§3.6，契约「Android 排版间距落在 2px 栅格上」的新规则）：4dp 基础栅格，
 * 2dp 半格**只能**经 [hairline] 使用（标签贴数值、图标贴文字、热力格间隙、读数行距）。
 */
internal object LedgerSpace {
    val hairline: Dp = 2.dp
    val xs: Dp = 4.dp
    val sm: Dp = 8.dp
    val md: Dp = 12.dp
    val lg: Dp = 16.dp
    val xl: Dp = 20.dp
    val xxl: Dp = 24.dp
    val xxxl: Dp = 32.dp
}

/** 尺寸（§3.5）。触达下限与旧常量 [V2_TOUCH_TARGET] 同源。 */
internal object LedgerSize {
    val touchTarget: Dp get() = V2_TOUCH_TARGET
    val navigationBar: Dp = 80.dp
    val topBar: Dp = 64.dp
    val segmentTrack: Dp = 48.dp
    val segmentPill: Dp = 40.dp
    val button: Dp = 48.dp
    val chipVisible: Dp = 32.dp
    val statusDot: Dp = 6.dp
    val identityDot: Dp = 8.dp
    /** 贴文字的小图标（金额显隐的眼睛、行末小箭头）。 */
    val iconText: Dp = 16.dp
    /** 行内与卡内动作的图标。 */
    val iconInline: Dp = 20.dp
    /** 顶栏与导航的图标。 */
    val iconAction: Dp = 24.dp
    val brandMark: Dp = 28.dp
    val sourceMark: Dp = 32.dp
    val sourceMarkQuota: Dp = 36.dp
    val dataBar: Dp = 4.dp
    val quotaBarOverview: Dp = 6.dp
    val quotaBarPage: Dp = 8.dp
    val heatCell: Dp = 10.dp
}

/** 厚度（§3.5）：不受栅格约束，但必须用常量，不在调用点写字面量。 */
internal object LedgerStroke {
    val hairline: Dp = 1.dp
    val einkCard: Dp = 1.5.dp
    val focus: Dp = 2.dp
    val popoverEInk: Dp = 2.dp
    val currentSeries: Dp = 2.25.dp
    val previousSeries: Dp = 1.5.dp
    val grid: Dp = 1.dp
    val calendarQuery: Dp = 1.5.dp
    /** 行背景底部的细数据条（旧来源行样式；A5 改为 4dp 的 [LedgerSize.dataBar] 独立条后删除）。 */
    val dataBarCompact: Dp = 2.dp
}

/** 圆角（§3.4）。同心规则：容器半径 − 内边距 = 内部控件半径（轨道 12 − 内缩 4 = 胶囊 8）。 */
internal object LedgerRadius {
    val xs: Dp = 6.dp
    val sm: Dp = 8.dp
    val md: Dp = 12.dp
    val lg: Dp = 16.dp
    val xl: Dp = 20.dp
    /** 墨水屏卡片统一 8（§3.4）。 */
    val einkCard: Dp = 8.dp
}

/** 纵深（§3.3）：浅色卡片的短柔阴影与浮层阴影；一律不用 M3 的色调抬升。 */
internal object LedgerElevation {
    val card: Dp = 2.dp
    val segmentPill: Dp = 1.dp
    val popover: Dp = 8.dp
}
