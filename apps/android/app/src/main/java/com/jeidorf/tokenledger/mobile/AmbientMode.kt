package com.jeidorf.tokenledger.mobile

/**
 * 全屏摆件的信息密度分档与渲染策略。
 *
 * 这个文件刻意不依赖 Compose 或 Android：摆件"该显示什么、该怎么画"是纯决策，
 * 必须能在 JVM 单元测试里穷举验证，而不是只能靠 golden 截图事后确认。
 * 尺寸用 `Float`（dp 数值）而不是 `Dp`，同样是为了让这层保持无依赖。
 *
 * 设计依据：`docs/design/android-ambient-modes-v1.md`。
 */

/**
 * 摆件可以呈现的信息元素。存在的意义是让"五个模式确实不一样"成为一条可断言的性质
 * （验收 V2），而不是靠人眼比对截图。
 */
internal enum class AmbientElement {
    /** 报头：字标 + 日期 + 范围 + 生成时刻。 */
    Masthead,

    /** 巨型有效 Token 数字。 */
    HeroTokens,

    /** 同期涨跌徽标（箭头 + 百分比）。 */
    DeltaBadge,

    /** 无坐标轴的极简走势线。 */
    Sparkline,

    /** 带昨日对比的 24 小时节奏图。 */
    RhythmChart,

    /** 成本 / 请求 / 缓存三格。 */
    MetricTriple,

    /** 本期 vs 上期的逐项数值表。 */
    ComparisonTable,

    /** 12 周活跃度热力图。 */
    Heatmap,

    /** 精简额度胶囊，数量受 `visibleQuotaWindowLimit` 限制。 */
    QuotaCapsules,

    /** 完整额度墙：所有 Provider 的所有可绘制窗口，不截断。 */
    QuotaBoard,

    /**
     * 大号半环仪表盘网格：一格一个额度窗口，除百分比与重置时刻外什么都不放。
     *
     * 与 [QuotaBoard] 的取舍方向相反：QuotaBoard 追求"一个都不漏"，代价是每行只能
     * 压成一条细进度条；QuotaGaugeGrid 追求"隔着房间也读得出还剩多少"，代价是接受
     * 截断（截断必须写在版面上）。两者都保留，因为回答的不是同一个问题。
     */
    QuotaGaugeGrid,

    /** 各来源观测时间与 stale/error 状态。 */
    FreshnessFooter,

    /** 今日一句。 */
    DailyQuote
}

/**
 * 五档摆件模式，排在一条信息密度递增轴上。
 *
 * [density] 是给设置页排序与无障碍摘要用的粗粒度分级，不是唯一键——`QuotaWall`
 * 与 `Console` 元素数量相当，故同为 3，二者的差别是"主语"而不是"多少"。
 */
internal enum class AmbientMode(
    val storedValue: String,
    val label: String,
    /** 设置页 chip 里的一行说明，同时作为 TalkBack 的 stateDescription 素材。 */
    val summary: String,
    /**
     * 这一档在 1bit 墨水屏上会变成什么样。
     *
     * 每一档都有墨水屏形态——墨水屏是介质约束，不是第六个模式。之所以要单独写一行，
     * 是因为用户实际反馈"墨水屏效果只有墨水日报那一档能看到"：策略层早就逐档解析了，
     * 但界面从来没把它说出来，也没给出预览入口。
     */
    val einkSummary: String,
    val density: Int,
    val elements: Set<AmbientElement>
) {
    Glance(
        storedValue = "glance",
        label = "一瞥",
        summary = "只看一个数字 · 3 米可读",
        einkSummary = "墨水屏：等宽巨号数字 + 阶梯走势，无灰阶填充",
        density = 1,
        elements = setOf(
            AmbientElement.HeroTokens,
            AmbientElement.DeltaBadge,
            AmbientElement.Sparkline
        )
    ),
    Pulse(
        storedValue = "pulse",
        label = "节奏",
        summary = "24 小时曲线 + 昨日对比",
        einkSummary = "墨水屏：曲线转阶梯柱，昨日线用网点抖动区分",
        density = 2,
        elements = setOf(
            AmbientElement.HeroTokens,
            AmbientElement.DeltaBadge,
            AmbientElement.RhythmChart,
            AmbientElement.MetricTriple
        )
    ),
    Console(
        storedValue = "console",
        label = "全息",
        summary = "曲线、热力与额度俱全",
        einkSummary = "墨水屏：热力格改网点密度，额度环退化为粗条",
        density = 3,
        elements = setOf(
            AmbientElement.HeroTokens,
            AmbientElement.DeltaBadge,
            AmbientElement.RhythmChart,
            AmbientElement.MetricTriple,
            AmbientElement.Heatmap,
            AmbientElement.QuotaCapsules,
            AmbientElement.DailyQuote
        )
    ),
    QuotaWall(
        storedValue = "quota",
        label = "额度墙",
        summary = "大号半环仪表盘 · 只看还剩多少",
        einkSummary = "墨水屏：半环保留，改粗描边 + 虚线轨道",
        density = 3,
        elements = setOf(
            AmbientElement.QuotaGaugeGrid,
            AmbientElement.FreshnessFooter
        )
    ),
    Ledger(
        storedValue = "ledger",
        label = "墨水日报",
        summary = "等宽排版全文本 · 报纸式编排",
        einkSummary = "墨水屏：这一档本就是为 1bit 设计，彩屏上也是报纸",
        density = 5,
        elements = setOf(
            AmbientElement.Masthead,
            AmbientElement.HeroTokens,
            AmbientElement.MetricTriple,
            AmbientElement.ComparisonTable,
            AmbientElement.RhythmChart,
            AmbientElement.QuotaBoard,
            AmbientElement.Heatmap,
            AmbientElement.FreshnessFooter,
            AmbientElement.DailyQuote
        )
    );

    /** 该档是否需要读取额度数据。用来决定要不要为它计算额度窗口。 */
    val showsQuota: Boolean
        get() = QUOTA_ELEMENTS.any { it in elements }

    companion object {
        /** 需要额度数据的元素。新增额度类元素时只改这里，不改每个调用点。 */
        private val QUOTA_ELEMENTS = setOf(
            AmbientElement.QuotaCapsules,
            AmbientElement.QuotaBoard,
            AmbientElement.QuotaGaugeGrid
        )

        /**
         * `widget_presentation` 旧值兼容层。`WidgetPresentation` 枚举本身已删除，只有它
         * 写进 SharedPreferences 的字符串还留在升级用户的设备上。
         *
         * `polished` 是升级用户的原有观感，映射到 Console 保证升级无感；`eink` 映射到
         * 墨水日报。退出条件：两个版本后删除本映射（见
         * `docs/design/android-ambient-modes-v1.md` §4.1）。
         */
        private val legacyPresentationValues = mapOf(
            "polished" to Console,
            "eink" to Ledger
        )

        fun fromStored(value: String?, fallback: AmbientMode = Console): AmbientMode =
            entries.firstOrNull { it.storedValue == value }
                ?: legacyPresentationValues[value]
                ?: fallback

        /** 设置页与 chip 组的展示顺序：先按密度，再按声明顺序打破并列。 */
        fun orderedForDisplay(): List<AmbientMode> = entries.sortedWith(
            compareBy<AmbientMode> { it.density }.thenBy { it.ordinal }
        )
    }
}

/**
 * 首次进入时的默认档。墨水屏设备直接落到墨水日报；常规设备落到 Console，
 * 与升级前的 `polished` 观感一致。
 */
internal fun defaultAmbientMode(isEInkDisplay: Boolean): AmbientMode =
    if (isEInkDisplay) AmbientMode.Ledger else AmbientMode.Console

/**
 * 全屏摆件的二维视口分档。
 *
 * 只用宽度判断“横屏”会把 960×633dp 的手势导航设备和 998×701dp 的墨水屏设备塞进
 * 同一套比例：前者底部被裁切，后者又浪费垂直空间。这里同时考虑宽高，并把布局比例
 * 保持为纯数据，便于单测覆盖真实设备视口。
 */
internal enum class AmbientViewportKind {
    Portrait,
    LandscapeShallow,
    LandscapeCompact,
    LandscapeRegular
}

internal data class AmbientViewportPolicy(
    val kind: AmbientViewportKind,
    val landscape: Boolean,
    val horizontalPaddingDp: Float,
    val verticalPaddingDp: Float,
    val consoleTopWeight: Float,
    val consoleChartWeight: Float,
    val consoleFooterWeight: Float,
    val ledgerFooterHeightDp: Float
)

internal fun resolveAmbientViewport(widthDp: Float, heightDp: Float): AmbientViewportPolicy {
    val landscape = widthDp >= 600f && widthDp > heightDp
    if (!landscape) {
        return AmbientViewportPolicy(
            kind = AmbientViewportKind.Portrait,
            landscape = false,
            horizontalPaddingDp = 14f,
            verticalPaddingDp = 8f,
            consoleTopWeight = 0.55f,
            consoleChartWeight = 0.27f,
            consoleFooterWeight = 0.18f,
            ledgerFooterHeightDp = 0f
        )
    }
    return when {
        heightDp < 480f -> AmbientViewportPolicy(
            kind = AmbientViewportKind.LandscapeShallow,
            landscape = true,
            horizontalPaddingDp = 28f,
            verticalPaddingDp = 12f,
            consoleTopWeight = 0.43f,
            consoleChartWeight = 0.34f,
            consoleFooterWeight = 0.23f,
            ledgerFooterHeightDp = 86f
        )

        heightDp < 660f -> AmbientViewportPolicy(
            kind = AmbientViewportKind.LandscapeCompact,
            landscape = true,
            horizontalPaddingDp = 36f,
            verticalPaddingDp = 18f,
            consoleTopWeight = 0.45f,
            consoleChartWeight = 0.32f,
            consoleFooterWeight = 0.23f,
            ledgerFooterHeightDp = 98f
        )

        else -> AmbientViewportPolicy(
            kind = AmbientViewportKind.LandscapeRegular,
            landscape = true,
            horizontalPaddingDp = 44f,
            verticalPaddingDp = 24f,
            consoleTopWeight = 0.46f,
            consoleChartWeight = 0.31f,
            consoleFooterWeight = 0.23f,
            ledgerFooterHeightDp = 112f
        )
    }
}

/**
 * 额度墙最多两行。四个窗口必须排成 2×2，不能沿用固定三列变成视觉失衡的 3+1。
 */
internal fun ambientQuotaWallColumns(visibleCount: Int, landscape: Boolean): Int {
    val count = visibleCount.coerceAtLeast(0)
    if (count <= 1) return 1
    if (!landscape) return 2
    return when (count) {
        2, 4 -> 2
        else -> 3
    }
}

internal enum class QuotaWallVisual { Ring, Bar }

internal fun QuotaWallVisual.next(): QuotaWallVisual = when (this) {
    QuotaWallVisual.Ring -> QuotaWallVisual.Bar
    QuotaWallVisual.Bar -> QuotaWallVisual.Ring
}

internal data class AmbientPixelShift(val xDp: Int, val yDp: Int)

/**
 * 常规彩屏的低频像素位移序列。位移小于全屏安全边距，不做持续动画，只让长期驻留的
 * 高亮边缘每分钟换一组像素；墨水屏、省电、过热或系统关闭动画时由策略层完全禁用。
 */
internal fun ambientPixelShift(step: Int): AmbientPixelShift {
    val sequence = listOf(
        AmbientPixelShift(0, 0),
        AmbientPixelShift(6, 0),
        AmbientPixelShift(6, 4),
        AmbientPixelShift(0, 4),
        AmbientPixelShift(-6, 4),
        AmbientPixelShift(-6, 0),
        AmbientPixelShift(-6, -4),
        AmbientPixelShift(0, -4),
        AmbientPixelShift(6, -4)
    )
    return sequence[Math.floorMod(step, sequence.size)]
}

/**
 * 设置页预览卡要画哪些区块，按 [AmbientElement] 声明顺序返回。
 *
 * 预览卡此前是一张与模式无关的固定版面：切换五档 chip，下面的卡纹丝不动。那不是
 * 预览，是装饰。这里把"预览画什么"下沉成纯函数，于是"切换模式预览必须跟着变"
 * 变成一条可以在 JVM 单测里断言的性质，而不是只能靠肉眼看截图。
 *
 * 卡片高度有限，因此对全屏元素集做两处收缩，且两处都必须在卡上写明原因：
 * - [AmbientElement.ComparisonTable] 与 [AmbientElement.Heatmap] 在墨水日报档同时
 *   出现会把卡片撑到两屏高，预览只保留对比表（它是这一档的骨架）。
 * - [AmbientElement.QuotaBoard] 在预览里按 2 个窗口截断，多出的数量显式写出来。
 */
internal fun ambientPreviewElements(mode: AmbientMode): List<AmbientElement> {
    val dropped = if (mode == AmbientMode.Ledger) setOf(AmbientElement.Heatmap) else emptySet()
    return AmbientElement.entries.filter { it in mode.elements && it !in dropped }
}

/**
 * 节奏图的两条序列与它们共用的横轴。
 *
 * [axisSpan] 是横轴的**格数**（24 小时轴为 23），刻意与 `current.size` 解耦：
 * 今日只走到当前小时，序列比昨日短，但两条线必须落在同一套 x 坐标上才可比。
 * 若改用 `current.size - 1` 做分母，今日曲线会被拉伸铺满整幅图，看起来像"今天
 * 一整天都在用"——这与 Windows 锁屏侧 `monotone_curve_points(axis_span)` 是同一个坑。
 */
internal data class AmbientRhythmSeries(
    val current: List<Float>,
    val previous: List<Float>,
    val axisSpan: Int,
    val isHourly: Boolean,
    val title: String,
    val previousLabel: String
) {
    val hasData: Boolean get() = current.any { it > 0f } || previous.any { it > 0f }
}

/**
 * 从 Stats v2 的 comparison 取节奏序列。**不新增 RPC、不新增字段。**
 *
 * `window.bucket == "hour"` 才是真正的 24 小时轴（契约
 * `dashboard-stats-v2.md`：range=today 时按小时分桶）。其它分桶下硬画 24 小时刻度
 * 会是纯粹的谎言，因此标题与对比线名称都随分桶改写。
 */
internal fun ambientRhythmSeries(
    comparison: UsageComparison?,
    fallback: List<TrendPoint>
): AmbientRhythmSeries {
    val current = comparison?.current?.series?.map { it.tokens.toFloat() }
        ?: fallback.map { point ->
            point.values.filterKeys { !it.startsWith("__") }.values.sum().toFloat()
        }
    val previous = comparison?.previous?.series?.map { it.tokens.toFloat() }.orEmpty()
    val bucket = comparison?.window?.bucket?.lowercase()
    val hourly = bucket == "hour"
    return AmbientRhythmSeries(
        current = current,
        previous = previous,
        // 小时分桶固定 24 格，即使今日只回了 8 个桶也不能把轴压成 8 格。
        axisSpan = if (hourly) 23 else (maxOf(current.size, previous.size) - 1).coerceAtLeast(1),
        isHourly = hourly,
        title = when (bucket) {
            "hour" -> "24 小时节奏"
            "day" -> "按日节奏"
            "week" -> "按周节奏"
            "month" -> "按月节奏"
            else -> "节奏"
        },
        previousLabel = if (hourly) "昨日" else "上一周期"
    )
}

/** 面积/色块的填充方式。 */
internal enum class FillPolicy {
    /** 实心填充，彩色屏幕默认。 */
    Solid,

    /** 只描边不填充，报纸式排版用。 */
    Outline,

    /** 网点抖动纹理。1bit 墨水屏上表达强度的唯一可靠手段（REQ-ANDROID-04）。 */
    Dither
}

/** 时间序列的画法。 */
internal enum class ChartStyle { SmoothArea, SmoothLine, SteppedBar }

/** 进度的画法。 */
internal enum class ProgressStyle {
    /** 细描边半环，彩屏用。 */
    Ring,

    /**
     * 粗描边半环 + 虚线轨道，墨水屏专用。
     *
     * 存在的理由是 [AmbientMode.QuotaWall] 的主语就是环：把它降级成条，这一档在墨水屏
     * 上就和其它档没有区别了。细环在 1bit 下确实不可读，但那是**描边太细**的问题，
     * 不是环的问题——加粗到 8% 直径、轨道改虚线之后，边界落点是确定的。
     * 其它档的环仍然降级为 [Bar]：它们的环只是附属指示器，不值得为它牺牲版面。
     */
    DitheredRing,

    Bar,

    /** `[████████░░░░]` 字符轨道，不依赖任何色彩。 */
    CharTrack
}

/** 重绘节奏。 */
internal enum class RefreshCadence {
    /** 数据变化时重绘。 */
    OnDataChange,

    /**
     * 对齐到整点的 :00/:15/:30/:45。对齐而不是"进入后每 15 分钟"，
     * 是为了让多台设备的重绘时刻可预测。
     */
    AlignedQuarterHour
}

/**
 * 模式 × 主题解析出的渲染策略。
 *
 * 这是"E-ink 摆件和常规摆件没差异"这个缺陷的正面修复：以前两者的差别只发生在
 * palette 层（边框粗细、圆角、一条分隔线），信息编排完全相同。把渲染策略提升为
 * 显式对象后，"墨水屏不许用实心填充和环形进度"就变成一条可以单测的断言。
 */
internal data class AmbientRenderProfile(
    val fillPolicy: FillPolicy,
    val chartStyle: ChartStyle,
    val cornerRadiusDp: Float,
    val strokeWidthDp: Float,
    val useMonospaceNumerals: Boolean,
    val progressStyle: ProgressStyle,
    val refreshCadence: RefreshCadence,
    /** 重绘前是否走一次全屏反色消影。 */
    val ghostBusting: Boolean
)

/**
 * 纯函数：模式决定基础画风，主题只在 E-ink 时施加物理约束。
 *
 * Dark 与 Light 解析出**完全相同**的 profile —— 深浅色只是配色，不是渲染约束。
 * 这条性质由 `AmbientRenderProfileTest` 断言，防止有人再把配色差异塞回策略层。
 */
internal fun resolveRenderProfile(
    mode: AmbientMode,
    appearance: LedgerAppearance
): AmbientRenderProfile {
    val base = when (mode) {
        AmbientMode.Glance -> AmbientRenderProfile(
            fillPolicy = FillPolicy.Solid,
            chartStyle = ChartStyle.SmoothLine,
            cornerRadiusDp = 28f,
            strokeWidthDp = 2.5f,
            useMonospaceNumerals = false,
            progressStyle = ProgressStyle.Bar,
            refreshCadence = RefreshCadence.OnDataChange,
            ghostBusting = false
        )
        AmbientMode.Pulse -> AmbientRenderProfile(
            fillPolicy = FillPolicy.Solid,
            chartStyle = ChartStyle.SmoothArea,
            cornerRadiusDp = 24f,
            strokeWidthDp = 2f,
            useMonospaceNumerals = false,
            progressStyle = ProgressStyle.Bar,
            refreshCadence = RefreshCadence.OnDataChange,
            ghostBusting = false
        )
        AmbientMode.Console -> AmbientRenderProfile(
            fillPolicy = FillPolicy.Solid,
            chartStyle = ChartStyle.SmoothArea,
            cornerRadiusDp = 24f,
            strokeWidthDp = 1f,
            useMonospaceNumerals = false,
            progressStyle = ProgressStyle.Ring,
            refreshCadence = RefreshCadence.OnDataChange,
            ghostBusting = false
        )
        AmbientMode.QuotaWall -> AmbientRenderProfile(
            fillPolicy = FillPolicy.Solid,
            chartStyle = ChartStyle.SmoothLine,
            cornerRadiusDp = 20f,
            strokeWidthDp = 2f,
            useMonospaceNumerals = true,
            progressStyle = ProgressStyle.Ring,
            refreshCadence = RefreshCadence.OnDataChange,
            ghostBusting = false
        )
        AmbientMode.Ledger -> AmbientRenderProfile(
            fillPolicy = FillPolicy.Outline,
            chartStyle = ChartStyle.SteppedBar,
            cornerRadiusDp = 0f,
            strokeWidthDp = 1.5f,
            useMonospaceNumerals = true,
            progressStyle = ProgressStyle.CharTrack,
            refreshCadence = RefreshCadence.AlignedQuarterHour,
            ghostBusting = true
        )
    }
    if (appearance != LedgerAppearance.EInk) return base

    // E-ink 是物理约束，不是配色偏好：抗锯齿差、有残影、灰阶不可靠。
    return base.copy(
        // 实心大色块在 1bit 屏上会退化成一片纯黑，改用网点抖动表达强度。
        fillPolicy = if (base.fillPolicy == FillPolicy.Solid) FillPolicy.Dither else base.fillPolicy,
        // 曲线的斜边在低 DPI 墨水屏上是锯齿，阶梯柱的边界永远是整像素。
        chartStyle = ChartStyle.SteppedBar,
        cornerRadiusDp = base.cornerRadiusDp.coerceAtMost(4f),
        strokeWidthDp = base.strokeWidthDp.coerceAtLeast(2f),
        useMonospaceNumerals = true,
        // 细环全是斜边，1bit 下几乎不可读，默认降级为条。例外是额度墙：那一档的主语
        // 就是环，降级成条等于取消这一档，改用粗描边 + 虚线轨道的 DitheredRing。
        progressStyle = when {
            base.progressStyle != ProgressStyle.Ring -> base.progressStyle
            mode == AmbientMode.QuotaWall -> ProgressStyle.DitheredRing
            else -> ProgressStyle.Bar
        },
        refreshCadence = RefreshCadence.AlignedQuarterHour,
        ghostBusting = true
    )
}
