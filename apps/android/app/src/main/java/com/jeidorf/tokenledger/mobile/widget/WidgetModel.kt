package com.jeidorf.tokenledger.mobile.widget

import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.QuotaDisplayValue
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.QuotaWindowStatus
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.formatCurrencyAmount
import com.jeidorf.tokenledger.mobile.formatTokenMagnitude
import com.jeidorf.tokenledger.mobile.formatWidgetChangePercent
import com.jeidorf.tokenledger.mobile.quotaAvailablePercent
import kotlin.math.roundToLong

/**
 * 小组件呈现模式。前四项是当前公开 Provider 的固定样式；[MultiBar] 仅用于读取旧实例，
 * 不再出现在新增/重新配置流程中。
 */
internal enum class WidgetMode(val storageValue: String, val label: String, val description: String) {
    MultiRing("multi_ring", "额度圆环", "Codex、Claude、Antigravity 并列，适合 4×2"),
    SingleUsage("single_usage", "单行消耗", "有效 Token、预估费用与数据时间，适合 4×1"),
    BarUsage("bar_usage", "额度与消耗", "额度横条 + 有效 Token 与预估费用，适合 4×2"),
    QuotaBars("quota_bars", "额度条", "每个额度窗口一行：可用百分比与重置倒计时，可附实时路由，适合 4×3"),
    MultiBar("multi_bar", "旧版额度横条", "仅为已有桌面实例保留的兼容样式");

    companion object {
        fun fromStorage(value: String?): WidgetMode = when (value) {
            "multi_ring", "quota" -> MultiRing
            "single_usage", "usage" -> SingleUsage
            "multi_bar" -> MultiBar
            "bar_usage", "combo" -> BarUsage
            "quota_bars" -> QuotaBars
            else -> BarUsage
        }
    }
}

/** 每个桌面实例独立选择主题，不改变应用内主题。 */
internal enum class WidgetThemeMode(val storageValue: String, val label: String, val description: String) {
    System("system", "跟随系统", "随设备深浅色模式自动切换"),
    Light("light", "明亮", "始终使用高亮浅色卡片"),
    Dark("dark", "黑暗", "始终使用低眩光深色卡片");

    companion object {
        fun fromStorage(value: String?): WidgetThemeMode =
            entries.firstOrNull { it.storageValue == value } ?: System
    }
}

/** 用量统计范围（今日/本周/本月），映射到既有 [RangeKey]。 */
internal enum class WidgetRange(
    val storageValue: String,
    val rangeKey: RangeKey,
    val label: String
) {
    Today("today", RangeKey.Today, "今日"),
    Week("week", RangeKey.Week, "本周"),
    Month("month", RangeKey.Month, "本月");

    companion object {
        fun fromStorage(value: String?): WidgetRange =
            entries.firstOrNull { it.storageValue == value } ?: Today
    }
}

/**
 * 单个小组件实例的持久化配置（T8.2 骨架，写入 T8.5 完成）。
 * [providerId] 为 null 表示"跟随第一个可用 provider"。
 */
internal data class WidgetConfig(
    val mode: WidgetMode = WidgetMode.BarUsage,
    val providerId: String? = null,
    val range: WidgetRange = WidgetRange.Today,
    val theme: WidgetThemeMode = WidgetThemeMode.System,
    /** 仅 [WidgetMode.QuotaBars] 使用：底部附一行最近的网关路由（数据经云端中转，默认关）。 */
    val showRouting: Boolean = false
)

/**
 * 小组件渲染状态。诚实额度原则（REQ-WIDGET-02）：任何缺失/校验失败一律落到
 * [NeedLogin]/[NoData] 或以 stale/error 徽标如实呈现，绝不补 0 或伪装满额。
 */
internal sealed interface WidgetState {
    data object NeedLogin : WidgetState

    data object NoData : WidgetState

    data class Ready(
        val quota: WidgetQuota?,
        val usage: WidgetUsage?,
        /** 只有开了「显示实时路由」的额度条实例才读取；其余为 null。 */
        val routing: WidgetRoutingSummary? = null
    ) : WidgetState
}

internal data class WidgetQuota(
    val providers: List<WidgetQuotaProvider>,
    /** 额度条用：每个可绘制窗口一行（外加没有窗口的待处理来源），见 [WidgetQuotaBarRow]。 */
    val rows: List<WidgetQuotaBarRow> = emptyList()
)

internal data class WidgetQuotaProvider(
    val id: String,
    val name: String,
    /** 生效后的状态（Ok 但窗口已过期时降级为 Stale）。 */
    val status: QuotaProviderStatus,
    val primary: WidgetQuotaWindow?,
    val secondary: WidgetQuotaWindow?,
    /** 最近一次未来重置的倒计时文案，例如 "3h12m 后重置"；无未来重置时为 null。 */
    val resetText: String?,
    /** 该 Provider 最新来源观测时间，而不是云端投影生成时间。 */
    val freshnessText: String,
    val stale: Boolean,
    /**
     * primary/secondary 之外还剩多少个可绘制窗口。Antigravity 常有 4 个窗口而小组件只放得下 2 个，
     * 剩余数量必须能显式呈现（“+N”），不得静默截断。
     */
    val hiddenWindowCount: Int = 0,
    /**
     * primary 是否**不是**该 Provider 偏好的角色（Codex 偏好周额度、其余偏好 5 小时）。
     * 为 true 说明想要的窗口这次没拿到，卡片上那个百分比讲的不是用户以为的那件事，
     * 必须把窗口标签显示出来，且不得再被 compact 版面省略。
     */
    val primaryIsRoleSubstitute: Boolean = false
)

internal data class WidgetQuotaWindow(
    val label: String,
    /**
     * 可用分数 0..1；非进度型窗口（绝对值/不限额）为 null。进度型窗口的值已量化到显示的整数
     * 百分比（[widgetProgressQuotaWindow]），环、条与档位跟着显示的数走（A-Q2）。
     */
    val availableFraction: Float?,
    val availableText: String,
    val status: com.jeidorf.tokenledger.mobile.QuotaWindowStatus =
        com.jeidorf.tokenledger.mobile.QuotaWindowStatus.Ok
)

internal data class WidgetUsage(
    val range: WidgetRange,
    val effectiveTokens: Long,
    /** 人民币预估费用；汇总费用或汇率非有限时为 null，挂件写「不可得」而不是 ¥0.00（T10.154 A19）。 */
    val costCny: Double?,
    val requests: Long,
    val freshnessText: String,
    /** 同期涨跌，来自缓存中的 comparison.delta.tokens；缓存不含 comparison 时为 null。 */
    val tokenDelta: WidgetDelta?
)

internal data class WidgetDelta(
    val direction: String,
    val percent: Double?
)

/**
 * 有效 Token 固定为单小数 compact 格式（REQ-WIDGET-03），保证数百 M 时仍不挤压布局。
 * 进位规则与应用共用 [formatTokenMagnitude]：999,950 写 `1.0M`，不再是 `1000.0K`（A-Q1）。
 */
internal fun formatCompactTokens(value: Long): String = formatTokenMagnitude(value, widget = true)

/**
 * 额度绝对量「剩 N」：不足 10,000 写整数；其余按小组件的 [formatTokenMagnitude] 写法（一位小数，
 * 先舍入再选单位），999,950 写 `1.0M`、999,950,000 写 `1.0B`，不再是 `1000.0K` / `1000.0M`（A-Q1）。
 */
internal fun formatCompactNumber(value: Long): String =
    if (value < 10_000L) value.toString() else formatTokenMagnitude(value, widget = true)

/**
 * 额度绝对量窗口的「剩 N」：只用来源给出的剩余量；剩余量缺失或不是有限数时写「—」，
 * 不拿已用量顶替，也不写「剩 0」（GLB-01，T10.207 评审 P2-1）。
 */
internal fun widgetRemainingQuotaText(remaining: Double?): String {
    val value = remaining?.takeIf { it.isFinite() } ?: return "—"
    return "剩 ${formatCompactNumber(value.roundToLong())}"
}

/**
 * 进度型额度 → 挂件窗口（A-Q2）：数字是「100 − round(已用)」的整数（[quotaAvailablePercent]，与今日卡、
 * 额度页、摆件、桌面同式），比例量化成这个整数 ÷ 100，于是环、条与 [widgetAvailabilityBand] 的档位都跟着
 * 显示的数走。此前比例未取整、文字四舍五入：已用 80.4% 时写「20%」却按 19.6% 画成告急红。
 */
internal fun widgetProgressQuotaWindow(
    label: String,
    value: QuotaDisplayValue.Progress,
    status: QuotaWindowStatus
): WidgetQuotaWindow {
    val percent = quotaAvailablePercent(value)
        ?: return WidgetQuotaWindow(label = label, availableFraction = null, availableText = "不可用", status = status)
    return WidgetQuotaWindow(label = label, availableFraction = percent / 100f, availableText = "$percent%", status = status)
}

/**
 * 与 Android 主看板一致使用人民币展示，走共用的金额格式（[formatCurrencyAmount]）：千分位、两位小数，
 * `<¥0.01`；读不到、非有限或为负写「不可得」，不再画成 ¥0.00（T10.154 A19）。
 */
internal fun formatCny(value: Double?, masked: Boolean = false): String =
    if (masked) "¥***.*" else formatCurrencyAmount(value, CurrencyUnit.CNY)

/** 受限版面未展示的额度窗口数；非正数不占用布局。 */
internal fun formatHiddenWindowCount(count: Int): String? =
    count.takeIf { it > 0 }?.let { "+$it" }

/** 角色替换必须有文字语义，不能只依赖琥珀色。 */
internal fun formatWidgetWindowLabel(label: String, roleSubstitute: Boolean): String =
    if (roleSubstitute) "替代·$label" else label

internal fun formatDeltaArrow(direction: String): String = when (direction) {
    "up" -> "↑"
    "down" -> "↓"
    else -> "→"
}

/** 挂件的变化率一律取整（R-11），符号与应用相同：`+12%`、`−5%`（U+2212）、`0%`。 */
internal fun formatDeltaPercent(percent: Double?): String =
    percent?.let(::formatWidgetChangePercent) ?: ""

/** 相对时间角标。 */
internal fun formatRelativeTime(ageMillis: Long): String {
    val age = ageMillis.coerceAtLeast(0L)
    return when {
        age < 60_000L -> "刚刚"
        age < 3_600_000L -> "${age / 60_000L} 分钟前"
        age < 86_400_000L -> "${age / 3_600_000L} 小时前"
        else -> "${age / 86_400_000L} 天前"
    }
}

/** 重置倒计时。仅用整数分/时/天，避免 Duration 实验性 API。 */
internal fun formatResetCountdown(untilMillis: Long): String {
    val totalMinutes = (untilMillis / 60_000L).coerceAtLeast(0L)
    val hours = totalMinutes / 60L
    val minutes = totalMinutes % 60L
    return when {
        hours >= 24L -> "${hours / 24L}天${hours % 24L}h 后重置"
        hours > 0L -> "${hours}h${minutes}m 后重置"
        else -> "${minutes}m 后重置"
    }
}
