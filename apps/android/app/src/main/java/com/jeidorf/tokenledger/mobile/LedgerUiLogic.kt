package com.jeidorf.tokenledger.mobile

import androidx.compose.ui.graphics.Path
import java.time.Instant
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.atan2
import kotlin.math.roundToInt
import kotlin.math.sqrt

enum class LedgerAppearance(val storedValue: String, val label: String) {
    Dark("dark", "深色"),
    Light("light", "浅色"),
    EInk("eink", "E-ink");

    companion object {
        fun fromStored(
            value: String?,
            fallback: LedgerAppearance = Dark
        ): LedgerAppearance = entries.firstOrNull {
            it.storedValue == value
        } ?: fallback
    }
}

internal enum class TokenDisplayMode(val storedValue: String, val label: String) {
    Effective("effective", "有效"),
    // A-Q8（T10.172 Q8）：范围里已有「全部」，Token 口径的这一档改叫「含缓存」，与桌面「概览含缓存」
    // 一致。storedValue 不变，已存的偏好照常读回。
    All("all", "含缓存");

    companion object {
        fun fromStored(value: String?): TokenDisplayMode = entries.firstOrNull {
            it.storedValue == value
        } ?: Effective
    }
}

/** 「含缓存」是展示口径：有效 Token 加缓存，不会被写回 Stats v2 的 query.tokenMode。 */
internal fun displayedTokenCount(
    mode: TokenDisplayMode,
    effectiveTokens: Long,
    cachedTokens: Long
): Long = when (mode) {
    TokenDisplayMode.Effective -> effectiveTokens
    TokenDisplayMode.All -> effectiveTokens + cachedTokens
}

// 隐藏费用开关的三句读屏文案（T10.154 §4.11、A02）：动作名、整体描述与状态只在这里写一次。
internal fun costMaskAccessibilityDescription(masked: Boolean): String =
    if (masked) "预估费用已隐藏，双击显示" else "预估费用已显示，双击隐藏"

internal fun costMaskStateDescription(masked: Boolean): String =
    if (masked) "已隐藏" else "已显示"

internal fun costMaskActionLabel(masked: Boolean): String =
    if (masked) "显示预估费用" else "隐藏预估费用"

/**
 * 读不到、非有限或为负的金额，以及读不到的变化率，一律写「不可得」，绝不画成 0
 * （GLB-01、T10.154 §2.8；桌面 `COST_UNAVAILABLE`）。
 */
internal const val VALUE_UNAVAILABLE = "不可得"

/** 费用不可得时读屏念全称（T10.154 §4.1 末行）。 */
internal const val COST_UNAVAILABLE_SPOKEN = "预估费用不可得"

/** 差值与变化率的负号统一用 U+2212，与桌面 `formatSignedUsd`、`formatChangePercent` 相同。 */
internal const val MINUS_SIGN = "−"

enum class CurrencyUnit(
    val symbol: String,
    val code: String,
    val label: String
) {
    USD("$", "USD", "美元"),
    CNY("¥", "CNY", "人民币");

    /**
     * 美元金额换算到本币种。美元金额非有限、人民币汇率非有限或不为正、或乘积溢出时返回 null
     * （不可得）；此前一律返回 0.0，未知就被画成了 ¥0.00（T10.154 A03）。负数照常换算，
     * 由格式化那一层决定：单个金额为负是不可得，差值为负带 −。
     */
    fun convertFromUsd(
        usdAmount: Double,
        exchangeRate: Double = BuildConfig.TOKENLEDGER_CNY_EXCHANGE_RATE
    ): Double? {
        if (!usdAmount.isFinite()) return null
        val converted = when (this) {
            USD -> usdAmount
            CNY -> if (exchangeRate.isFinite() && exchangeRate > 0.0) usdAmount * exchangeRate else return null
        }
        return converted.takeIf { it.isFinite() }
    }

    /** 汇总精度的金额（§4.1 Android 行）；隐藏费用时只给掩码，读不到写「不可得」。 */
    fun format(
        usdAmount: Double?,
        exchangeRate: Double = BuildConfig.TOKENLEDGER_CNY_EXCHANGE_RATE,
        masked: Boolean = false
    ): String = formatCostForDisplay(usdAmount, exchangeRate, masked, this)

    fun formatCompact(
        usdAmount: Double,
        exchangeRate: Double = BuildConfig.TOKENLEDGER_CNY_EXCHANGE_RATE,
        masked: Boolean = false
    ): String {
        if (masked) return "${symbol}***"
        val converted = convertFromUsd(usdAmount, exchangeRate) ?: return VALUE_UNAVAILABLE
        return formatCompactMonetaryAmount(converted, this)
    }

    companion object {
        val DEFAULT: CurrencyUnit = CNY

        fun fromStored(value: String?, fallback: CurrencyUnit = DEFAULT): CurrencyUnit =
            entries.firstOrNull {
                it.name.equals(value, ignoreCase = true) ||
                it.code.equals(value, ignoreCase = true) ||
                it.label.equals(value, ignoreCase = true)
            } ?: fallback
    }
}

internal fun formatCompactMonetaryAmount(value: Double, unit: CurrencyUnit): String {
    if (!value.isFinite() || value <= 0.0) return "${unit.symbol}0"

    val symbol = unit.symbol
    return when (unit) {
        CurrencyUnit.USD -> when {
            value >= 1_000_000_000.0 -> "${symbol}${trimTrailingZeros(String.format(Locale.US, "%.1f", value / 1_000_000_000.0))}B"
            value >= 1_000_000.0 -> "${symbol}${trimTrailingZeros(String.format(Locale.US, "%.1f", value / 1_000_000.0))}M"
            value >= 1_000.0 -> "${symbol}${trimTrailingZeros(String.format(Locale.US, "%.1f", value / 1_000.0))}K"
            value >= 100.0 -> "${symbol}${String.format(Locale.US, "%.0f", value)}"
            value >= 10.0 -> "${symbol}${trimTrailingZeros(String.format(Locale.US, "%.1f", value))}"
            else -> "${symbol}${trimTrailingZeros(String.format(Locale.US, "%.2f", value))}"
        }
        CurrencyUnit.CNY -> when {
            value >= 100_000_000.0 -> "${symbol}${trimTrailingZeros(String.format(Locale.US, "%.1f", value / 100_000_000.0))}亿"
            value >= 10_000.0 -> "${symbol}${trimTrailingZeros(String.format(Locale.US, "%.1f", value / 10_000.0))}W"
            value >= 1_000.0 -> "${symbol}${trimTrailingZeros(String.format(Locale.US, "%.1f", value / 1_000.0))}K"
            value >= 100.0 -> "${symbol}${String.format(Locale.US, "%.0f", value)}"
            value >= 10.0 -> "${symbol}${trimTrailingZeros(String.format(Locale.US, "%.1f", value))}"
            else -> "${symbol}${trimTrailingZeros(String.format(Locale.US, "%.2f", value))}"
        }
    }
}

private fun trimTrailingZeros(formatted: String): String {
    if (!formatted.contains('.')) return formatted
    return formatted.trimEnd('0').trimEnd('.')
}

/** 金额精度（T10.154 §4.1）：汇总两位；明细单条记录不足 1 个币种单位时保留 4 位。 */
internal enum class CostPrecision { Summary, Record }

/** 可以当作已知费用展示的值：有限且不为负（桌面 `isKnownCost`）。 */
internal fun isKnownCost(value: Double?): Boolean = value != null && value.isFinite() && value >= 0.0

/**
 * 应用、摆件、小组件与海报共用的**唯一**金额写法（T10.154 §4.1 Android 行，T10.207）：
 * `¥` 或 `$`、千分位、两位小数、不带 ≈；0 < v < 0.01 写 `<¥0.01`；已知为 0（含 −0）写
 * `¥0.00`；读不到、非有限或为负写「不可得」。明细单条记录（[CostPrecision.Record]）
 * 不足 1 时保留 4 位，0 < v < 0.00005 写 `<¥0.0001`。
 *
 * [amount] 已经换算成 [currency]，阈值按显示币种判断。舍入与桌面 `Intl.NumberFormat` 相同：
 * `String.format` 的 `%f` 在最短十进制串上四舍五入（1.005 写 1.01、999.995 写 1,000.00）。
 */
internal fun formatCurrencyAmount(
    amount: Double?,
    currency: CurrencyUnit,
    precision: CostPrecision = CostPrecision.Summary
): String {
    if (!isKnownCost(amount)) return VALUE_UNAVAILABLE
    val value = amount!!
    val symbol = currency.symbol
    if (value == 0.0) return "${symbol}0.00"
    if (precision == CostPrecision.Record && value < 1.0) {
        return if (value < 0.00005) "<${symbol}0.0001" else String.format(Locale.US, "%s%.4f", symbol, value)
    }
    if (value < 0.01) return "<${symbol}0.01"
    return String.format(Locale.US, "%s%,.2f", symbol, value)
}

/**
 * 金额差值（§4.1「差值」行）：带正负号、不带 ≈，负号 U+2212（`+¥3.20`、`−¥1.05`）；
 * 0 < |v| < 0.01 写 `+<¥0.01` / `−<¥0.01`；0 写 `¥0.00`；读不到或非有限写「不可得」。
 */
internal fun formatSignedCurrencyAmount(amount: Double?, currency: CurrencyUnit): String {
    if (amount == null || !amount.isFinite()) return VALUE_UNAVAILABLE
    if (amount == 0.0) return "${currency.symbol}0.00"
    return (if (amount > 0.0) "+" else MINUS_SIGN) + formatCurrencyAmount(kotlin.math.abs(amount), currency)
}

/** 美元金额 → 本币种文案；看板、趋势、来源、明细、摆件都经过这里（[formatCurrencyAmount]）。 */
internal fun formatCostForDisplay(
    value: Double?,
    exchangeRate: Double = BuildConfig.TOKENLEDGER_CNY_EXCHANGE_RATE,
    masked: Boolean = false,
    currency: CurrencyUnit = CurrencyUnit.CNY,
    precision: CostPrecision = CostPrecision.Summary
): String {
    if (masked) return "${currency.symbol}***.*"
    return formatCurrencyAmount(value?.let { currency.convertFromUsd(it, exchangeRate) }, currency, precision)
}

/** Display-only projection: hidden costs never reach visible or accessibility strings. */
internal data class DailyAmountLabel(val text: String, val accessibility: String)

internal fun dailyAmountLabel(
    amountUsd: Double?,
    masked: Boolean,
    currency: CurrencyUnit = CurrencyUnit.CNY,
    exchangeRate: Double = BuildConfig.TOKENLEDGER_CNY_EXCHANGE_RATE
): DailyAmountLabel {
    if (masked) return DailyAmountLabel("${currency.symbol}***.*", "预估费用已隐藏")
    val unavailable = DailyAmountLabel(VALUE_UNAVAILABLE, COST_UNAVAILABLE_SPOKEN)
    // 单日费用的 0 按不可得处理：旧 RPC 用 0 表示「没有算」，这是数据口径（T10.118b），不是格式。
    if (amountUsd == null || !amountUsd.isFinite() || amountUsd <= 0.0) return unavailable
    val amount = currency.convertFromUsd(amountUsd, exchangeRate)?.takeIf { it > 0.0 } ?: return unavailable
    val unit = if (currency == CurrencyUnit.CNY) "元" else "美元"
    val text = formatCurrencyAmount(amount, currency)
    if (amount < 0.01) return DailyAmountLabel(text, "预估费用不足0.01$unit")
    return DailyAmountLabel(text, "预估费用${text.removePrefix(currency.symbol)}$unit")
}

internal data class RecentDailyActivityRow(
    val date: String,
    val effectiveTokens: Long,
    val tokenLabel: String,
    val amount: DailyAmountLabel,
    val fraction: Float
)

/** Reuse the current response and calendar coverage; never infer costs from history or totals. */
internal fun recentDailyActivityRows(
    stats: StatsData,
    query: DashboardQuery,
    masked: Boolean,
    currency: CurrencyUnit = CurrencyUnit.CNY,
    exchangeRate: Double = BuildConfig.TOKENLEDGER_CNY_EXCHANGE_RATE
): List<RecentDailyActivityRow> {
    val axis = buildInsightCalendarAxis(stats, query)
    if (!axis.isTrusted) return emptyList()
    val active = axis.cells.asSequence().filter { it.selectable && it.inQueryRange && it.tokens > 0L }
        .sortedByDescending { it.date }.take(10).toList()
    val maximum = active.maxOfOrNull { it.tokens } ?: 0L
    val echo = stats.meta?.query
    val matchesQuery = !stats.legacyRpc && stats.meta?.entity == null && echo != null && runCatching {
        DashboardQueryContract.canonical(echo) ==
            DashboardQueryContract.canonical(query, requireNotNull(axis.timezone))
    }.getOrDefault(false)
    val costs = stats.dailyCosts?.takeIf {
        matchesQuery && it.coverage.state == DailyCostsCoverageState.Complete &&
            it.coverage.timezone == axis.timezone
    }
    return active.map { cell ->
        val date = cell.date.toString()
        val day = costs?.let { bundle ->
            bundle.days.singleOrNull { it.date == date }?.takeIf {
                date <= bundle.coverage.end && (bundle.coverage.start == null || date >= bundle.coverage.start)
            }
        }
        val amount = day?.takeIf {
            it.status == DailyCostStatus.RecordedEstimate && it.reason == null
        }?.amountUsd
        RecentDailyActivityRow(date, cell.tokens, formatInteger(cell.tokens),
            dailyAmountLabel(amount, masked, currency, exchangeRate),
            normalizedDataBarFraction(cell.tokens, maximum))
    }
}

/**
 * Details are a contract-level concept, but raw values such as `hour` and `request` are not
 * user-facing copy. Keep the label aligned with the desktop dashboard and make unknown future
 * values safe instead of leaking protocol text into the Chinese UI.
 */
internal fun detailGranularityLabel(granularity: String, items: List<LogHistoryItem>): String = when {
    granularity.equals("hour", ignoreCase = true) -> "云端小时聚合"
    items.any { it.requests > 1 } -> "日志聚合"
    granularity.equals("request", ignoreCase = true) -> "逐次请求"
    else -> "聚合明细"
}

/** Protocol entity kinds are stable transport values, not copy for the Chinese UI. */
internal fun entityKindLabel(kind: String): String = when (kind.lowercase(Locale.ROOT)) {
    "tool" -> "工具"
    "model" -> "模型"
    else -> "来源"
}

private val US_INTEGER_FORMAT: ThreadLocal<NumberFormat> = ThreadLocal.withInitial {
    NumberFormat.getIntegerInstance(Locale.US)
}

/** Formats an integer value with US grouping separators (e.g. 2,206) in a thread-safe manner without per-call allocations. */
internal fun formatInteger(value: Long): String =
    checkNotNull(US_INTEGER_FORMAT.get()).format(value)

private class TokenUnit(base: Long, val suffix: String, val digits: Int) {
    val base: java.math.BigDecimal = java.math.BigDecimal.valueOf(base)
}

/** DESIGN §4.4 与桌面 `formatTokens`：K 一位、M 与 B 两位（A-Q1）。 */
private val APP_TOKEN_UNITS =
    listOf(TokenUnit(1_000L, "K", 1), TokenUnit(1_000_000L, "M", 2), TokenUnit(1_000_000_000L, "B", 2))

/** 小组件 M、B 也只留一位（REQ-WIDGET-03），进位规则与应用相同。 */
private val WIDGET_TOKEN_UNITS =
    listOf(TokenUnit(1_000L, "K", 1), TokenUnit(1_000_000L, "M", 1), TokenUnit(1_000_000_000L, "B", 1))

/** JS `Number.prototype.toFixed`：对二进制精确值舍入，恰好居中取较大者（输入非负）。 */
private fun toFixedHalfUp(value: Double, digits: Int): String =
    java.math.BigDecimal(value).setScale(digits, java.math.RoundingMode.HALF_UP).toPlainString()

/**
 * Token 量级缩写的唯一实现（T10.207），应用、摆件、海报与小组件共用，与桌面
 * `src/utils/format.ts` 的 `formatTokens` 和托盘 `widget_window::format_tokens` 逐字相同
 * （`fixtures/token-format-v1/cases.json`，`FormatLayerBoundaryTest` 直接读这份文件）：
 * 绝对值不足 1,000 写千分位整数；按绝对值选单位，先按该单位的小数位舍入，舍入后达到 1000
 * 就进位到下一单位（999,999 写 `1.00M`，不再是旧版的 `1000K`）；B 是最高单位；负数前加 `-`。
 * 小数位按显示值（十进制）四舍五入、半数远离 0，与桌面同规则（T10.204）：用 `BigDecimal`
 * 对整数精确相除，1,150 写 `1.2K`、1,005,000 写 `1.01M`，不受 1.15 的二进制值 1.1499… 影响。
 * [widget] 为 true 时 M、B 也只留一位小数（REQ-WIDGET-03）。
 */
internal fun formatTokenMagnitude(value: Long, widget: Boolean = false): String {
    val magnitude = java.math.BigDecimal.valueOf(value).abs()
    val units = if (widget) WIDGET_TOKEN_UNITS else APP_TOKEN_UNITS
    var unit = units.indexOfLast { magnitude >= it.base }
    if (unit < 0) return formatInteger(value)
    var text = roundTokenUnit(magnitude, units[unit])
    if (text.toDouble() >= 1_000.0 && unit < units.lastIndex) {
        unit += 1
        text = roundTokenUnit(magnitude, units[unit])
    }
    return "${if (value < 0L) "-" else ""}$text${units[unit].suffix}"
}

/** `magnitude ÷ unit.base` 保留 `unit.digits` 位，十进制半数远离 0（输入非负，HALF_UP 即远离 0）。 */
private fun roundTokenUnit(magnitude: java.math.BigDecimal, unit: TokenUnit): String =
    magnitude.divide(unit.base, unit.digits, java.math.RoundingMode.HALF_UP).toPlainString()

/** 应用与海报的 Token 写法（A-Q1）：见 [formatTokenMagnitude]。 */
internal fun v2FormatTokens(value: Long): String = formatTokenMagnitude(value)

internal fun v2FormatNumber(value: Long): String = formatInteger(value)

/**
 * Token 差值：正数 `+`、负数 `−`（U+2212）加缩写，与桌面 `describeMetricChange` 的
 * `signed(absolute, formatTokens)` 相同；0 不带符号。
 */
internal fun formatSignedTokens(value: Long): String = when {
    value > 0L -> "+${formatTokenMagnitude(value)}"
    value < 0L -> "$MINUS_SIGN${formatTokenMagnitude(value).removePrefix("-")}"
    else -> formatTokenMagnitude(0L)
}

/** 整数差值（记录数等）：`+348`、`−12`，千分位；0 不带符号。 */
internal fun formatSignedInteger(value: Long): String = when {
    value > 0L -> "+${formatInteger(value)}"
    value < 0L -> "$MINUS_SIGN${formatInteger(value).removePrefix("-")}"
    else -> formatInteger(0L)
}

/**
 * 变化率的唯一写法（root 决定 R-11，与桌面 `MetricsGrid.formatChangePercent` 同式）：
 * |x| ≥ 10 取整（`Math.round`），否则一位小数（`toFixed(1)`）；正数带 `+`，负数带 `−`
 * （U+2212）；舍入后为 0 的写 `0.0%`，不带符号（不把 0.04% 说成「上涨」）；非有限写「不可得」。
 * 与桌面一样，9.96 写 `+10.0%`（先按原值判断 ≥ 10，再舍入）。
 */
internal fun formatChangePercent(percent: Double): String {
    if (!percent.isFinite()) return VALUE_UNAVAILABLE
    val magnitude = kotlin.math.abs(percent)
    val text = if (magnitude >= 10.0) Math.round(magnitude).toString() else toFixedHalfUp(magnitude, 1)
    if (text.toDouble() == 0.0) return "0.0%"
    return "${if (percent > 0.0) "+" else MINUS_SIGN}$text%"
}

/** 小组件的变化率一律取整（R-11 允许），符号规则同 [formatChangePercent]；舍入后为 0 写 `0%`。 */
internal fun formatWidgetChangePercent(percent: Double): String {
    if (!percent.isFinite()) return VALUE_UNAVAILABLE
    val rounded = Math.round(kotlin.math.abs(percent))
    if (rounded == 0L) return "0%"
    return "${if (percent > 0.0) "+" else MINUS_SIGN}$rounded%"
}

/** 占比（构成占比、费用占比、缓存复用率等）：四舍五入到整数百分比，与桌面 `Math.round` 同式。 */
internal fun formatSharePercent(percent: Double): String =
    if (!percent.isFinite()) VALUE_UNAVAILABLE else "${Math.round(percent)}%"

/**
 * 明细行的记录数（T10.156 IA v2：记录数是账本行数，云端一行是一小时的聚合，不是一次请求）。
 * 旧行为 0 表示来源没给，不显示。
 */
internal fun detailRequestCountLabel(requests: Long): String? =
    requests.takeIf { it > 0 }?.let { "${formatInteger(it)} 条记录" }

/**
 * Loading copy is kept in one place so the visual spinner and the accessibility tree announce
 * the same state. A retained snapshot is not an empty loading screen: it is a refresh over a
 * still-trustworthy frame and must be described as such.
 */
internal fun dashboardLoadingAccessibilityDescription(showingCachedData: Boolean): String =
    if (showingCachedData) {
        "正在刷新看板，当前仍显示上一次可验证快照"
    } else {
        "正在加载看板"
    }

/** Large text needs one extra line for freshness/error status before compact actions begin. */
internal fun dashboardStatusMaxLines(fontScale: Float): Int =
    if (fontScale >= 1.5f) 2 else 1

/**
 * Entity and settings titles are user/source supplied strings. Keep them bounded at normal size,
 * while allowing one additional line at large text so the title remains readable without pushing
 * the fixed top-bar actions off the usable row.
 */
internal fun dashboardTitleMaxLines(fontScale: Float): Int =
    if (fontScale >= 1.5f) 2 else 1

/**
 * Top-bar titles can be visually shortened at large text, but source/model identities must remain
 * available as one complete accessibility value instead of exposing the rendered ellipsis.
 */
internal fun dashboardTitleAccessibilityDescription(title: String): String = title.trim()

/**
 * Quota failures need a recovery action next to the explanation. Loading is intentionally
 * passive, while an empty or unavailable snapshot can be retried without making the user hunt
 * for the global top-bar refresh action.
 */
internal fun quotaRecoveryActionLabel(
    quota: QuotaUiState,
    refreshing: Boolean = false
): String? = when {
    quota is QuotaUiState.Unsynced || quota is QuotaUiState.Unavailable ->
        if (refreshing) "正在读取额度…" else "重新读取额度"
    else -> null
}

/**
 * 额度剩余量的严重度档位。阈值统一为剩余 <20% 告急、<50% 偏紧（D4，T10.152），
 * 与桌面 `src/utils/quotaOverview.ts` 的 `quotaLevel`、Android 小组件
 * `widgetAvailabilityBand`（WidgetCycling.kt）三端一致；档位文案同步桌面挂件
 * `src/components/WidgetView.tsx` 的 `QUOTA_STATE_LABELS`（充足/偏紧/告急）。
 * 此前本档位取 T10.79 原型 `src/prototypes/AndroidDashboardPrototype.tsx` 的
 * `quotaSeverity`（15/40，Critical 标签为"额度即将耗尽"）；该原型与
 * `tests/frontend-contracts.test.mjs` 对应断言尚未同步到新阈值/新标签，
 * 不是本任务改动范围（见 T10.152 任务日志）。
 */
internal enum class QuotaSeverity(val label: String) {
    Healthy("额度充足"),
    Warning("额度偏紧"),
    Critical("额度告急")
}

/**
 * 按**剩余百分比**分档，不看供应商状态。
 *
 * 进度条此前的颜色是 `if (status == Ok) blue else amber`——那表达的是「这个来源
 * 能不能读到数」，不是「还剩多少」，于是 3% 剩余和 95% 剩余同样画成蓝色，
 * 「快用完了」在界面上没有任何视觉权重。T10.79 的设计面早就改成按剩余量分档，
 * T10.152 把三端（桌面、Android 应用、Android 小组件）阈值统一为 20/50，
 * 严格小于。
 *
 * 颜色不是唯一线索：百分比文字同色，读屏描述另外念出档位名。
 *
 * T10.170：`<` 对 NaN 的 IEEE 754 比较恒为 false，非有限值（NaN、±Infinity）此前
 * 会穿过下面两个 `<` 分支落到 `else -> Healthy`——把「未知」显示成「安全」，与
 * 桌面 `src/utils/quotaOverview.ts` 的 `quotaLevel`
 * （`!Number.isFinite(remainingPercent)` 判 critical）口径不一致，也违反
 * GLB-01（未知不得看起来安全）。现在非有限值单列第一个分支判 Critical，与桌面
 * 同口径 fail-closed；原有的 `< 20.0`/`< 50.0` 两个分支未改。
 */
internal fun quotaSeverity(remainingPercent: Double): QuotaSeverity = when {
    !remainingPercent.isFinite() -> QuotaSeverity.Critical
    remainingPercent < 20.0 -> QuotaSeverity.Critical
    remainingPercent < 50.0 -> QuotaSeverity.Warning
    else -> QuotaSeverity.Healthy
}

/**
 * 额度可用百分比的唯一取整（A-Q2，T10.207）：可用 = 100 − round(已用)，钳到 0..100，与桌面
 * `src/utils/quotaOverview.ts` 的 `readQuotaWindow` 同式（`Math.round` 半数向上：已用 49.5 → 可用 50，
 * 已用 80.4 → 可用 20，已用 99.6 → 可用 0）。已用非有限时读不到，返回 null。
 *
 * 今日卡、额度页、摆件、小组件与读屏都从这里取数，并按这个**显示出来的整数**分档
 * （[quotaSeverityForAvailablePercent]），于是同一窗口在哪里都是同一个数、同一个档。
 */
internal fun quotaAvailablePercentForUsed(usedPercent: Double): Int? =
    if (!usedPercent.isFinite()) null
    else (100L - Math.round(usedPercent)).coerceIn(0L, 100L).toInt()

/** 进度型额度值 → 可用整数百分比：百分比窗口取 used；其余窗口按 used ÷ limit 折成百分比后同式取整。 */
internal fun quotaAvailablePercent(value: QuotaDisplayValue.Progress): Int? = when {
    value.unit == QuotaUnit.Percent -> quotaAvailablePercentForUsed(value.used)
    value.limit.isFinite() && value.limit > 0.0 -> quotaAvailablePercentForUsed(value.used / value.limit * 100.0)
    else -> null
}

/** 按显示的整数分档（D4：< 20 告急、< 50 偏紧，严格小于），与桌面 `quotaLevel(reading.remaining)` 相同。 */
internal fun quotaSeverityForAvailablePercent(availablePercent: Int): QuotaSeverity =
    quotaSeverity(availablePercent.toDouble())

/** 读屏的额度数值：今日卡、额度页、摆件与挂件预览念同一句「可用 N%（额度偏紧）」。 */
internal fun quotaAvailableAccessibilityLabel(availablePercent: Int): String =
    "可用 $availablePercent%（${quotaSeverityForAvailablePercent(availablePercent).label}）"

/**
 * 便于 0..1 的剩余比例直接分档；档位跟**显示的整数**走（A-Q2），不再按未取整的比例。
 *
 * 剩余比例是 Float，换回已用百分比时带着约 ±3e-6 的误差，恰好落在 k.5 上的已用值（49.5、79.5）
 * 会因此舍向两边。所以先把已用百分比吸附到 5 位小数再取整：来源给出的已用值最多 5 位小数时，
 * 结果与 [quotaAvailablePercent] 和桌面逐一相同。能拿到 [QuotaDisplayValue.Progress] 的调用方
 * 应直接用 [quotaAvailablePercent] 与 [quotaSeverityForAvailablePercent]。
 *
 * T10.170：`coerceIn` 对 NaN 的比较恒为 false，而 `+Infinity` 会被钳到 1f（满额健康），所以在
 * 钳位之前先挡住全部非有限值（NaN、±Infinity），直接判 Critical。
 */
internal fun quotaSeverityForFraction(remainingFraction: Float): QuotaSeverity {
    if (!remainingFraction.isFinite()) return QuotaSeverity.Critical
    val usedPercent = (1.0 - remainingFraction.coerceIn(0f, 1f).toDouble()) * 100.0
    val snapped = Math.round(usedPercent * 100_000.0) / 100_000.0
    val available = quotaAvailablePercentForUsed(snapped) ?: return QuotaSeverity.Critical
    return quotaSeverityForAvailablePercent(available)
}

/**
 * Quota transport arrays deliberately carry no display semantics. Android applies one stable
 * presentation priority and keeps unknown/future providers in their original relative order.
 */
internal fun List<QuotaProviderEnvelope>.orderedQuotaProvidersForDisplay(): List<QuotaProviderEnvelope> =
    withIndex()
        .filter { (_, provider) ->
            provider.windows.isNotEmpty() || provider.status != QuotaProviderStatus.Ok
        }
        .sortedWith(
            compareBy<IndexedValue<QuotaProviderEnvelope>>(
                { (_, provider) -> quotaProviderDisplayPriority(provider.providerId) },
                IndexedValue<QuotaProviderEnvelope>::index
            )
        )
        .map(IndexedValue<QuotaProviderEnvelope>::value)

/** 完整额度页还要展示无窗口的 error/auth-required/unsupported Provider，不能被概览筛选吞掉。 */
internal fun List<QuotaProviderEnvelope>.orderedQuotaProvidersForFullDisplay(): List<QuotaProviderEnvelope> =
    withIndex()
        .sortedWith(
            compareBy<IndexedValue<QuotaProviderEnvelope>>(
                { (_, provider) -> quotaProviderDisplayPriority(provider.providerId) },
                IndexedValue<QuotaProviderEnvelope>::index
            )
        )
        .map(IndexedValue<QuotaProviderEnvelope>::value)

/** 完整额度页将有窗口来源与待处理来源分组，但组内仍复用同一稳定 Provider 顺序。 */
internal fun List<QuotaProviderEnvelope>.orderedQuotaProvidersWithWindowsForFullDisplay(): List<QuotaProviderEnvelope> =
    orderedQuotaProvidersForFullDisplay().filter { it.windows.isNotEmpty() }

internal fun List<QuotaProviderEnvelope>.orderedQuotaProvidersPendingDisplay(): List<QuotaProviderEnvelope> =
    orderedQuotaProvidersForFullDisplay().filter { it.windows.isEmpty() }

/** 契约常量：短窗口 5 小时、长窗口 7 天。生产者以 `windowMinutes` 标注，消费者不得改写。 */
internal const val SHORT_QUOTA_WINDOW_MINUTES = 300
internal const val LONG_QUOTA_WINDOW_MINUTES = 10080

/**
 * 窗口在展示层的语义角色。契约尚未提供 `windowRole` 字段（见 docs/archive/audits/recent-changes-20260725.md §B2），
 * 因此这里以机器可读的 `windowMinutes` 为第一判据，windowId 文本仅在 windowMinutes 缺失时兜底，
 * 避免上游改文案就静默换掉主窗口。
 */
internal enum class QuotaWindowRole { ShortWindow, LongWindow, Unclassified }

internal fun QuotaWindowSnapshot.displayRole(): QuotaWindowRole {
    when (windowMinutes) {
        SHORT_QUOTA_WINDOW_MINUTES -> return QuotaWindowRole.ShortWindow
        LONG_QUOTA_WINDOW_MINUTES -> return QuotaWindowRole.LongWindow
    }
    val kind = windowId.lowercase(java.util.Locale.ROOT)
    return when {
        kind.contains("five-hour") || kind.contains("5-hour") ||
            kind.contains("session") || kind.contains("primary") -> QuotaWindowRole.ShortWindow
        kind.contains("seven-day") || kind.contains("weekly") ||
            kind.contains("week") || kind.contains("secondary") -> QuotaWindowRole.LongWindow
        else -> QuotaWindowRole.Unclassified
    }
}

/**
 * 契约 `quota-provider-v1.md`：“Provider/window 顺序不承载语义”。任何挑选都必须先落到一个
 * 与 transport 顺序无关的确定性序：先按窗口时长升序，再按 windowId 字典序打破并列。
 */
private val quotaWindowDisplayOrder: Comparator<QuotaWindowSnapshot> =
    compareBy<QuotaWindowSnapshot> { it.windowMinutes ?: Int.MAX_VALUE }
        .thenBy { it.windowId }

/** 可绘制百分比进度的窗口，已按确定性序排列。 */
internal fun QuotaProviderEnvelope.drawableProgressWindows(): List<QuotaWindowSnapshot> = windows
    .filter { it.displayValue() is QuotaDisplayValue.Progress }
    .sortedWith(quotaWindowDisplayOrder)

/** Codex 的瓶颈通常是周限额；其余来源第一视线看 5 小时窗口。 */
private fun QuotaProviderEnvelope.preferredWindowRole(): QuotaWindowRole = when (providerId) {
    "openai-codex-local", "codex-app-server" -> QuotaWindowRole.LongWindow
    else -> QuotaWindowRole.ShortWindow
}

/** 已用比例，非进度窗口按 0 处理（它们本就进不了 [drawableProgressWindows]）。 */
private fun QuotaWindowSnapshot.usedFraction(): Float =
    (displayValue() as? QuotaDisplayValue.Progress)?.fraction ?: 0f

/**
 * 同一角色内部的"瓶颈优先"序：已用比例大的排前面，并列时用 `windowId` 字典序确定性打破。
 *
 * 修复的缺陷（真机截图 2026-07-25）：一个 Provider 常有**多个同档窗口**——Antigravity 按模型
 * 分组，同时存在 `antigravity-claude-and-gpt-models-claude-session` 与
 * `antigravity-gemini-models-gemini-session`，两个都是 300 分钟。旧实现在角色内只按
 * `(windowMinutes, windowId)` 取第一个，等于**按字母序**挑：`claude-and-gpt` 恒定排在
 * `gemini` 前面。用户在 Gemini 上用掉 17%、Claude/GPT 那组一点没动，小组件于是稳定显示
 * "Antigravity 100%"。Codex 多 bucket 时同理（长窗口走 `asReversed()`，取到字母序最后一个）。
 *
 * 唯一没出错的是 Claude——因为它只有一个窗口，字母序无从作恶。这正是这类缺陷的特征：
 * 只在数据有并列项时显形，fixture 里恰好 `claude-session` 的 used 是 0，把 bug 也一起固化了。
 *
 * 一行一个 Provider 的"剩余额度"卡只放得下一个数字，那个数字必须是**会先拦住你的那个**，
 * 而不是碰巧排在前面的那个。
 */
private val quotaBindingWindowOrder: Comparator<QuotaWindowSnapshot> =
    compareByDescending<QuotaWindowSnapshot> { it.usedFraction() }
        .thenBy { it.windowId }

/**
 * 为仪表盘卡片、全屏摆件及桌面小组件规则化选出主要展示窗口：先按 providerId 定角色偏好，
 * 再在该角色内取最吃紧的窗口。挑选只依赖 `windowMinutes`、`windowId`、`used` 与 providerId，
 * 不依赖数组下标，因此同一份数据无论传输顺序如何结果都一致。
 */
internal fun QuotaProviderEnvelope.selectPrimaryDisplayWindow(): QuotaWindowSnapshot? {
    val ordered = drawableProgressWindows()
    if (ordered.isEmpty()) return null
    val preferred = preferredWindowRole()
    // 该角色一个都没有时退回全部窗口——但仍按瓶颈优先，而不是按字母序碰运气。
    val candidates = ordered.filter { it.displayRole() == preferred }.ifEmpty { ordered }
    return candidates.sortedWith(quotaBindingWindowOrder).first()
}

/**
 * 次要窗口取与主要窗口互补的角色（主看周限额就配 5 小时，反之亦然），同样在角色内取最吃紧的
 * 那个。排除用契约稳定键 `providerId + scope + windowId` 而不是数据类结构相等。
 */
internal fun QuotaProviderEnvelope.selectSecondaryDisplayWindow(
    primary: QuotaWindowSnapshot?
): QuotaWindowSnapshot? {
    val primaryKey = primary?.stableKey
    val ordered = drawableProgressWindows().filterNot { it.stableKey == primaryKey }
    if (ordered.isEmpty()) return null
    val complement = if (primary?.displayRole() == QuotaWindowRole.LongWindow) {
        QuotaWindowRole.ShortWindow
    } else {
        QuotaWindowRole.LongWindow
    }
    val candidates = ordered.filter { it.displayRole() == complement }.ifEmpty { ordered }
    return candidates.sortedWith(quotaBindingWindowOrder).first()
}

/**
 * 展示层实际选中的窗口是否**不是**该 Provider 偏好的角色。为 true 时界面必须把窗口标签
 * 显示出来：此时那个百分比讲的不是用户以为的那件事（例如 Codex 只剩 5 小时窗口可画，
 * 卡片上却写着一个与"周额度"无关的 100%）。静默替换是上一版缺陷的根源，不能再犯。
 */
internal fun QuotaProviderEnvelope.primaryWindowIsRoleSubstitute(
    primary: QuotaWindowSnapshot?
): Boolean = primary != null && primary.displayRole() != preferredWindowRole()

/**
 * 已展示 `shown` 个窗口后还剩多少个可绘制窗口。Antigravity 常有 4 个窗口，摆件与小组件只放得下
 * 1～2 个；剩余数量必须显式告知用户（“+N”），不能静默截断。
 */
internal fun QuotaProviderEnvelope.hiddenDrawableWindowCount(shown: Int): Int =
    (drawableProgressWindows().size - shown).coerceAtLeast(0)

/** Providers without a drawable percentage window do not consume one of the limited widget slots. */
internal fun quotaProgressWindowsForDisplay(
    providers: List<QuotaProviderEnvelope>,
    limit: Int
): List<Pair<QuotaProviderEnvelope, QuotaWindowSnapshot>> = providers
    .orderedQuotaProvidersForDisplay()
    .asSequence()
    .mapNotNull { provider ->
        provider.selectPrimaryDisplayWindow()
            ?.let { provider to it }
    }
    .take(limit.coerceAtLeast(0))
    .toList()

/**
 * 摆件、预览与小组件共用的额度窗口展示序：先每个 Provider 的**主窗口**（Codex 取周限额，
 * Claude/Antigravity 取 5 小时窗口），再各自的次要窗口，最后才是剩余窗口。
 *
 * 修复的缺陷：此前这些界面各自写 `flatMap { drawableProgressWindows() }`，而
 * [drawableProgressWindows] 是按窗口时长**升序**排的。于是 `take(2)` 必然先命中 Codex 的
 * 5 小时窗口——与 [selectPrimaryDisplayWindow] 的规则正好相反。同一份数据，概览卡显示
 * Codex 周额度、摆件与预览却显示 Codex 5 小时额度，用户看到的是两套互相矛盾的数字。
 *
 * 挑选只依赖 `providerId`、`windowMinutes`、`windowId`，与 transport 数组下标无关
 * （契约 quota-provider-v1 §"Provider/window 顺序不承载语义"）。去重用稳定键
 * `providerId + scope + windowId`，不用数据类结构相等。
 */
internal fun List<QuotaProviderEnvelope>.rankedQuotaWindowsForDisplay():
    List<Pair<QuotaProviderEnvelope, QuotaWindowSnapshot>> {
    val ordered = orderedQuotaProvidersForDisplay()
    if (ordered.isEmpty()) return emptyList()
    val picked = LinkedHashMap<String, Pair<QuotaProviderEnvelope, QuotaWindowSnapshot>>()
    fun add(provider: QuotaProviderEnvelope, window: QuotaWindowSnapshot?) {
        if (window == null) return
        val key = window.stableKey
        if (!picked.containsKey(key)) picked[key] = provider to window
    }
    // 第一轮横扫所有 Provider 的主窗口：一眼看过去，每个来源各占一格，谁都不缺席。
    val primaries = ordered.map { provider -> provider to provider.selectPrimaryDisplayWindow() }
    primaries.forEach { (provider, window) -> add(provider, window) }
    // 第二轮补次要窗口，仍然是每个 Provider 一个，避免 Antigravity 的 4 个窗口把版面吃光。
    primaries.forEach { (provider, primary) ->
        add(provider, provider.selectSecondaryDisplayWindow(primary))
    }
    // 兜底：剩下的按确定性序补齐，保证"全部窗口"这种场景一个都不漏。
    ordered.forEach { provider ->
        provider.drawableProgressWindows().forEach { window -> add(provider, window) }
    }
    return picked.values.toList()
}

/**
 * 全量额度版面按 Provider 连续排列；Provider 内仍保留“主窗口、次窗口、其余窗口”的
 * 确定性顺序。与 [rankedQuotaWindowsForDisplay] 的区别是后者优先让每个 Provider
 * 各露一格，适合截断表面；日报不截断，因此更重要的是让同一软件的窗口待在一起。
 */
internal fun List<QuotaProviderEnvelope>.groupedQuotaWindowsForDisplay():
    List<Pair<QuotaProviderEnvelope, QuotaWindowSnapshot>> =
    orderedQuotaProvidersForDisplay().flatMap { provider ->
        val picked = LinkedHashMap<String, QuotaWindowSnapshot>()
        fun add(window: QuotaWindowSnapshot?) {
            if (window != null && !picked.containsKey(window.stableKey)) {
                picked[window.stableKey] = window
            }
        }
        val primary = provider.selectPrimaryDisplayWindow()
        add(primary)
        add(provider.selectSecondaryDisplayWindow(primary))
        provider.drawableProgressWindows().forEach(::add)
        picked.values.map { provider to it }
    }

/** 纵轴从 0 起，并给真实峰值留出顶部呼吸区，避免峰值顶到边界造成“断崖”错觉。 */
internal fun paddedChartMaximum(
    values: List<Float>,
    headroomFraction: Float = 0.12f
): Float {
    val peak = (values.maxOrNull() ?: 0f).coerceAtLeast(0f)
    if (peak <= 0f) return 1f
    return (peak * (1f + headroomFraction.coerceIn(0f, 0.5f))).coerceAtLeast(1f)
}

private fun quotaProviderDisplayPriority(providerId: String): Int = when (providerId) {
    "openai-codex-local", "codex-app-server" -> 0
    "anthropic-claude-consumer", "claude-code" -> 1
    "google-antigravity-consumer" -> 2
    else -> Int.MAX_VALUE
}

internal data class SmoothCurvePoint(val x: Float, val y: Float)

internal data class SmoothCurveSegment(
    val start: SmoothCurvePoint,
    val control1: SmoothCurvePoint,
    val control2: SmoothCurvePoint,
    val end: SmoothCurvePoint
)

/**
 * Streams Fritsch-Carlson monotone cubic spline segments directly to [consumer] without
 * allocating intermediate [SmoothCurveSegment] or [SmoothCurvePoint] wrapper objects.
 *
 * Hermite derivatives are initialized and constrained via Fritsch-Carlson conditions
 * so that within any monotonic interval, Bézier control points never overshoot adjacent
 * endpoints (zero-overshoot guarantee).
 */
internal inline fun streamMonotoneCubicSegments(
    points: List<SmoothCurvePoint>,
    tension: Float = 1.0f,
    minY: Float = Float.NEGATIVE_INFINITY,
    maxY: Float = Float.POSITIVE_INFINITY,
    consumer: (c1x: Float, c1y: Float, c2x: Float, c2y: Float, endX: Float, endY: Float) -> Unit
) {
    val n = points.size
    if (n < 2) return

    val deltas = FloatArray(n - 1)
    val h = FloatArray(n - 1)
    for (i in 0 until n - 1) {
        val dx = points[i + 1].x - points[i].x
        val dy = points[i + 1].y - points[i].y
        h[i] = dx
        deltas[i] = if (dx > 0f) dy / dx else 0f
    }

    val d = FloatArray(n)
    for (i in 1 until n - 1) {
        val d0 = deltas[i - 1]
        val d1 = deltas[i]
        if (d0 * d1 <= 0f) {
            d[i] = 0f
        } else {
            val h0 = h[i - 1]
            val h1 = h[i]
            val sumH = h0 + h1
            d[i] = if (sumH > 0f) (h1 * d0 + h0 * d1) / sumH else 0f
        }
    }
    d[0] = deltas[0]
    d[n - 1] = deltas[n - 2]

    val t = tension.coerceIn(0f, 1f)
    for (i in 0 until n - 1) {
        val p0 = points[i]
        val p1 = points[i + 1]
        val dx = h[i]
        val delta = deltas[i]

        if (dx <= 0f) {
            val c1y = p0.y.coerceIn(minY, maxY)
            val c2y = p1.y.coerceIn(minY, maxY)
            consumer(p0.x, c1y, p1.x, c2y, p1.x, p1.y)
            continue
        }

        var m0 = d[i]
        var m1 = d[i + 1]

        if (delta == 0f) {
            m0 = 0f
            m1 = 0f
        } else {
            var alpha = m0 / delta
            var beta = m1 / delta
            if (alpha < 0f) {
                alpha = 0f
                m0 = 0f
            }
            if (beta < 0f) {
                beta = 0f
                m1 = 0f
            }
            val sumSq = alpha * alpha + beta * beta
            if (sumSq > 9f) {
                val tau = 3f / kotlin.math.sqrt(sumSq)
                m0 = tau * alpha * delta
                m1 = tau * beta * delta
            }
        }

        val pMin = minOf(p0.y, p1.y)
        val pMax = maxOf(p0.y, p1.y)
        var c1y = (p0.y + (m0 * dx / 3f) * t).coerceIn(pMin, pMax)
        var c2y = (p1.y - (m1 * dx / 3f) * t).coerceIn(pMin, pMax)

        if (minY <= maxY) {
            c1y = c1y.coerceIn(minY, maxY)
            c2y = c2y.coerceIn(minY, maxY)
        }

        val c1x = p0.x + (dx / 3f) * t
        val c2x = p1.x - (dx / 3f) * t

        consumer(c1x, c1y, c2x, c2y, p1.x, p1.y)
    }
}

/**
 * Streams cubic curve control and endpoint coordinates directly to [consumer]
 * without allocating intermediate [SmoothCurveSegment] or [SmoothCurvePoint] wrapper objects.
 * Delegates to [streamMonotoneCubicSegments] to guarantee zero overshoot.
 */
internal inline fun streamSmoothCurveSegments(
    points: List<SmoothCurvePoint>,
    tension: Float = 1.0f,
    minY: Float = Float.NEGATIVE_INFINITY,
    maxY: Float = Float.POSITIVE_INFINITY,
    consumer: (c1x: Float, c1y: Float, c2x: Float, c2y: Float, endX: Float, endY: Float) -> Unit
) {
    streamMonotoneCubicSegments(points, tension, minY, maxY, consumer)
}

/**
 * Appends Fritsch-Carlson monotone cubic Bézier curve segments to this [Path] from [points]
 * without allocating intermediate objects.
 */
internal fun Path.addMonotoneCubicCurve(
    points: List<SmoothCurvePoint>,
    tension: Float = 1.0f,
    minY: Float = Float.NEGATIVE_INFINITY,
    maxY: Float = Float.POSITIVE_INFINITY
) {
    streamMonotoneCubicSegments(points, tension, minY, maxY) { c1x, c1y, c2x, c2y, endX, endY ->
        cubicTo(c1x, c1y, c2x, c2y, endX, endY)
    }
}

/**
 * Directly appends cubic Bézier curve segments to this [Path] from [points]
 * without allocating intermediate objects.
 *
 * Note: The caller should invoke [Path.moveTo] to the initial point before calling this.
 */
internal fun Path.addSmoothCurve(
    points: List<SmoothCurvePoint>,
    tension: Float = 1.0f,
    minY: Float = Float.NEGATIVE_INFINITY,
    maxY: Float = Float.POSITIVE_INFINITY
) {
    addMonotoneCubicCurve(points, tension, minY, maxY)
}

/**
 * Constructs or populates a [Path] with cubic Bézier curves connecting [points].
 */
internal fun buildSmoothCurvePath(
    points: List<SmoothCurvePoint>,
    tension: Float = 1.0f,
    minY: Float = Float.NEGATIVE_INFINITY,
    maxY: Float = Float.POSITIVE_INFINITY,
    destination: Path = Path()
): Path {
    if (points.isEmpty()) return destination
    destination.moveTo(points.first().x, points.first().y)
    destination.addSmoothCurve(points, tension, minY, maxY)
    return destination
}

/**
 * Converts sampled values to a Fritsch-Carlson monotone cubic curve. Control-point Y values
 * are clamped to the chart bounds so a sharp peak cannot make the rendered curve overshoot its data region.
 */
internal fun smoothCurveSegments(
    points: List<SmoothCurvePoint>,
    tension: Float = 1.0f,
    minY: Float = Float.NEGATIVE_INFINITY,
    maxY: Float = Float.POSITIVE_INFINITY
): List<SmoothCurveSegment> {
    if (points.size < 2) return emptyList()
    val result = ArrayList<SmoothCurveSegment>(points.size - 1)
    var index = 0
    streamSmoothCurveSegments(points, tension, minY, maxY) { c1x, c1y, c2x, c2y, endX, endY ->
        result.add(
            SmoothCurveSegment(
                start = points[index],
                control1 = SmoothCurvePoint(c1x, c1y),
                control2 = SmoothCurvePoint(c2x, c2y),
                end = points[index + 1]
            )
        )
        index++
    }
    return result
}

internal enum class DashboardLayoutMode { Compact, Standard }

internal fun dashboardLayoutMode(widthDp: Int, fontScale: Float): DashboardLayoutMode =
    if (widthDp < 360 || fontScale >= 1.5f) DashboardLayoutMode.Compact
    else DashboardLayoutMode.Standard

/** Narrow screens and large text move cost onto a separate row. */
internal fun shouldStackDashboardHeroValues(fontScale: Float, widthDp: Int = Int.MAX_VALUE): Boolean =
    widthDp < 360 || fontScale >= 1.5f

/**
 * The share sheet has one extra-long "里程碑" option. Wrap it before large text turns the final
 * option into an undiscoverable clipped scroll target, while keeping the normal 390dp row compact.
 */
internal fun shouldWrapSharePeriodSelector(widthDp: Int, fontScale: Float): Boolean =
    widthDp < 350 || fontScale >= 1.5f

/** Large system text needs a taller bottom rail so labels do not compete with the icon row. */
internal fun dashboardNavigationBarHeightDp(fontScale: Float): Int =
    if (fontScale >= 1.5f) 112 else 96

/**
 * The bottom navigation is a real overlay at large font scales on some OEM
 * Compose surfaces. Keep enough scroll tail for the last card to clear it;
 * this is intentionally a content inset, not a visual font compensation.
 */
internal fun dashboardContentBottomPaddingDp(widthDp: Int, fontScale: Float): Int = when {
    fontScale >= 1.5f -> dashboardNavigationBarHeightDp(fontScale) + 16
    widthDp < 600 -> 88
    else -> 24
}

internal enum class DashboardNavigationPlacement { Hidden, BottomBar, Rail }

internal fun dashboardNavigationPlacement(
    widthDp: Int,
    section: DashboardSection
): DashboardNavigationPlacement = when {
    section == DashboardSection.Entity -> DashboardNavigationPlacement.Hidden
    widthDp >= 600 -> DashboardNavigationPlacement.Rail
    else -> DashboardNavigationPlacement.BottomBar
}

/** Orientation locks are disabled in multi-window so the real window remains the layout oracle. */
internal fun shouldLockSensorLandscape(forceLandscape: Boolean, isInMultiWindowMode: Boolean): Boolean =
    forceLandscape && !isInMultiWindowMode

internal fun shouldConsumeDashboardBack(state: DashboardUiState): Boolean =
    state.section == DashboardSection.Entity && state.navigationStack.isNotEmpty()

internal fun quotaWindowAccessibilityDescription(
    providerName: String,
    windowLabel: String,
    statusLabel: String,
    valueLabel: String?,
    resetLabel: String,
    observedLabel: String
): String = buildList {
    add(providerName)
    add(windowLabel)
    add(statusLabel)
    valueLabel?.takeIf(String::isNotBlank)?.let(::add)
    add(resetLabel)
    add("更新于 $observedLabel")
}.joinToString("，")

internal data class QuotaCardWindowPresentation(val window: QuotaWindowSnapshot, val status: QuotaWindowStatus, val value: QuotaDisplayValue?)
internal data class QuotaCardPresentation(val status: QuotaProviderStatus, val headline: String, val windows: List<QuotaCardWindowPresentation>)

/** Page-only disclosure of age aggregation; never changes the Quota v1 verdict or value admission. */
internal fun quotaCardPresentation(provider: QuotaProviderEnvelope, now: Instant, cached: Boolean): QuotaCardPresentation {
    val groupStatus = provider.effectiveStatus(now, cached)
    val ownStatuses = provider.windows.map { it.effectiveStatus(now, cached) }
    val ageOnly = provider.status == QuotaProviderStatus.Ok && provider.windows.all { it.status == QuotaWindowStatus.Ok } &&
        (groupStatus == QuotaProviderStatus.Ok || groupStatus == QuotaProviderStatus.Stale)
    val partialHistory = ageOnly && !cached && QuotaWindowStatus.Ok in ownStatuses && QuotaWindowStatus.Stale in ownStatuses
    val valueAllowed = groupStatus == QuotaProviderStatus.Ok || groupStatus == QuotaProviderStatus.Stale
    val groupWindowStatus = when (groupStatus) {
        QuotaProviderStatus.Ok -> QuotaWindowStatus.Ok
        QuotaProviderStatus.Stale -> QuotaWindowStatus.Stale
        QuotaProviderStatus.AuthRequired -> QuotaWindowStatus.AuthRequired
        else -> QuotaWindowStatus.Error
    }
    return QuotaCardPresentation(groupStatus,
        if (partialHistory) "部分历史" else quotaProviderHeadlineLabel(groupStatus, cached, QuotaWindowStatus.Ok in ownStatuses),
        provider.windows.mapIndexed { index, window ->
            QuotaCardWindowPresentation(window, if (ageOnly) ownStatuses[index] else groupWindowStatus,
                window.displayValue().takeIf { valueAllowed })
        })
}

// 刻意保留来源自带的偏移量（见 QuotaCardPresentationTest）：这是排障用的抽屉，
// 「来源说它是几点」比「换算到我这里是几点」更有用。外层面向读者的时间一律走
// v2ShortDateTime，那里换算到设备时区并且只到分钟。
//
// 已知代价：[quotaCacheTimestamp] 走 `Instant.toString()`，因此本机缓存写入时间永远
// 显示成 +00:00，和同一抽屉里的 +08:00 并排。要动它就得让这条断言依赖运行机器的时区，
// 而这处至今没有在界面上被看到过（走查时该值是「未知」），故本轮不改。
internal fun quotaFullTimestamp(timestamp: String?): String = timestamp?.let {
    runCatching { java.time.OffsetDateTime.parse(it).format(java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss xxx", Locale.ROOT)) }.getOrNull()
} ?: "未知"

internal fun quotaCacheTimestamp(savedAtEpochMillis: Long): String =
    if (savedAtEpochMillis <= 0L) "未知" else quotaFullTimestamp(runCatching { Instant.ofEpochMilli(savedAtEpochMillis).toString() }.getOrNull())

internal fun quotaRecoveryGuidance(provider: QuotaProviderEnvelope): String = when (provider.reasonCode) {
    "rate_limited" -> "等待限流解除后，在桌面端刷新并同步，再重新读取。"
    "secure_storage_unavailable" -> "在桌面端解锁安全存储并手动刷新额度，完成同步后重新读取。"
    "admin_key_required", "api_key_required" -> "在桌面端完成对应 API 凭据配置并同步，再重新读取。"
    "experimental_consent_required" -> "在桌面端「订阅额度 · 高级」重新确认风险提示后，再重新读取。"
    "claude_statusline_snapshot_missing" -> "在桌面端完成一次 Claude Code 请求并同步，再重新读取。"
    "local_authorization_required", "claude_local_authorization_required", "antigravity_local_authorization_required" ->
        "在桌面端启用并授权此来源，完成同步后重新读取。"
    "app_server_auth_required", "claude_native_authorization_required", "antigravity_native_authorization_required" ->
        "在桌面端登录对应来源并刷新额度，完成同步后重新读取。"
    "observation_stale", "reset_elapsed" -> "在桌面端刷新来源额度并同步，再重新读取。"
    "balance_unavailable" -> "在桌面端刷新供应商余额并同步，再重新读取；仍失败时检查供应商余额接口。"
    else -> if (provider.status == QuotaProviderStatus.Unsupported) "在桌面端查看此来源支持的计划与读取方式。"
        else "按桌面端额度页提示处理来源，完成刷新与同步后重新读取。"
}

internal fun quotaValueLabel(value: QuotaDisplayValue?): String? {
    // remaining 往往是 limit - used 的浮点差，直接 toPlainString 会把 IEEE-754 误差
    // 原样端上界面：used = 99.9 的百分比窗口显示成「可用 0.09999999999999432%」。
    // 先按该单位真正有意义的精度取整，再去掉尾随 0。
    fun number(amount: Double, unit: QuotaUnit): String {
        val scale = when (unit) {
            QuotaUnit.Usd, QuotaUnit.Currency -> 2
            QuotaUnit.Percent, QuotaUnit.Credits -> 1
            QuotaUnit.Tokens, QuotaUnit.Requests -> 0
        }
        return java.math.BigDecimal.valueOf(amount)
            .setScale(scale, java.math.RoundingMode.HALF_UP)
            .stripTrailingZeros()
            .toPlainString()
    }
    fun unit(unit: QuotaUnit) = when (unit) {
        QuotaUnit.Percent -> "%"
        QuotaUnit.Credits -> " Credits"
        QuotaUnit.Tokens -> " Token"
        QuotaUnit.Requests -> " 次请求"
        QuotaUnit.Usd -> " 美元"
        QuotaUnit.Currency -> ""
    }
    fun amount(value: Double, quotaUnit: QuotaUnit, currency: String?) =
        if (quotaUnit == QuotaUnit.Currency) formatQuotaCurrencyAmount(value, currency.orEmpty())
        else "${number(value, quotaUnit)}${unit(quotaUnit)}"
    return when (value) {
        null -> null
        QuotaDisplayValue.UnlimitedCredits -> "无限 Credits"
        is QuotaDisplayValue.Progress -> {
            // 百分比窗口一律整数（A-Q2）：此前这里保留一位小数（「可用 19.6%」），今日卡却截断成
            // 「19% 可用」，桌面是「20%」，同一窗口三个数。
            if (value.unit == QuotaUnit.Percent) quotaAvailablePercent(value)?.let { "可用 $it%" } ?: "额度数值未知"
            else if (value.remaining != null) "可用 ${amount(value.remaining, value.unit, value.currency)}"
            else if (value.unit == QuotaUnit.Currency) "已用 ${amount(value.used, value.unit, value.currency)} / ${amount(value.limit, value.unit, value.currency)}"
            else "已用 ${number(value.used, value.unit)} / ${number(value.limit, value.unit)}${unit(value.unit)}"
        }
        is QuotaDisplayValue.Absolute -> when {
            value.remaining != null -> "可用 ${amount(value.remaining, value.unit, value.currency)}"
            value.used != null -> "已用 ${amount(value.used, value.unit, value.currency)}"
            value.limit != null -> "上限 ${amount(value.limit, value.unit, value.currency)}"
            else -> "额度数值未知"
        }
    }
}

private val QUOTA_CURRENCY_SYMBOLS = mapOf(
    "CNY" to "¥", "USD" to "$", "EUR" to "€", "GBP" to "£", "JPY" to "JP¥"
)

/** quota-provider-v1 §2.2，与桌面 `formatQuotaCurrencyAmount` 同规则：五种常见币种用符号，其余照写 ISO 代码；JPY 取整，其余两位小数，不换汇。 */
internal fun formatQuotaCurrencyAmount(amount: Double, currency: String): String {
    val text = String.format(Locale.US, if (currency == "JPY") "%,.0f" else "%,.2f", amount)
    return QUOTA_CURRENCY_SYMBOLS[currency]?.let { "$it$text" } ?: "$text $currency"
}

internal fun quotaProviderHeadlineLabel(
    status: QuotaProviderStatus,
    showingCachedData: Boolean,
    hasFreshWindow: Boolean
): String = when {
    status == QuotaProviderStatus.Error ||
        status == QuotaProviderStatus.AuthRequired ||
        status == QuotaProviderStatus.Unsupported -> status.localizedLabel()
    showingCachedData -> "本机历史快照"
    status == QuotaProviderStatus.Stale -> "历史数据"
    !hasFreshWindow -> "暂无额度数据"
    else -> "已更新"
}

internal fun quotaHistoryMetadataLabel(
    status: QuotaProviderStatus,
    observedLabel: String
): String? = when (status) {
    QuotaProviderStatus.Ok -> null
    QuotaProviderStatus.Stale -> "历史数据 · 更新于 $observedLabel"
    QuotaProviderStatus.AuthRequired -> "需要授权 · 更新于 $observedLabel"
    QuotaProviderStatus.Error -> "暂时不可用 · 更新于 $observedLabel"
    QuotaProviderStatus.Unsupported -> "当前不支持 · 更新于 $observedLabel"
}

/**
 * 所有百分比型额度视觉组件共用的有效状态裁决。错误、授权与不支持状态不携带百分比，
 * stale 可以保留 LKG 数值，但必须由调用方以琥珀色和历史更新时间呈现。
 */
internal data class EffectiveQuotaProgressPresentation(
    val status: QuotaProviderStatus,
    val availableFraction: Float?,
    val availablePercent: Int?
)

internal fun effectiveQuotaProgressPresentation(
    provider: QuotaProviderEnvelope,
    window: QuotaWindowSnapshot,
    now: Instant,
    forceStale: Boolean
): EffectiveQuotaProgressPresentation {
    val status = when (provider.status) {
        QuotaProviderStatus.Error,
        QuotaProviderStatus.AuthRequired,
        QuotaProviderStatus.Unsupported -> provider.status
        QuotaProviderStatus.Ok -> when (window.effectiveStatus(now, forceStale)) {
            QuotaWindowStatus.Ok -> QuotaProviderStatus.Ok
            QuotaWindowStatus.Stale -> QuotaProviderStatus.Stale
            QuotaWindowStatus.AuthRequired -> QuotaProviderStatus.AuthRequired
            QuotaWindowStatus.Error -> QuotaProviderStatus.Error
        }
        QuotaProviderStatus.Stale -> QuotaProviderStatus.Stale
    }
    val mayShowValue =
        status == QuotaProviderStatus.Ok || status == QuotaProviderStatus.Stale
    val progress = window.displayValue()
        .takeIf { mayShowValue } as? QuotaDisplayValue.Progress
    val fraction = progress?.let { value ->
        when {
            value.remaining != null && value.limit > 0.0 ->
                (value.remaining / value.limit).toFloat()
            value.limit > 0.0 -> (1f - value.fraction)
            else -> null
        }
    }?.coerceIn(0f, 1f)
    return EffectiveQuotaProgressPresentation(
        status = status,
        // 环与条按精确比例画；数字与档位按 A-Q2 的整数（与桌面 QuotaPanel 同样：条宽 100 − used，数字取整）。
        availableFraction = fraction,
        availablePercent = if (fraction != null) progress?.let(::quotaAvailablePercent) else null
    )
}

internal data class ComparisonKindPresentation(
    val windowLabel: String,
    val heroBaselineLabel: String,
    val alignsToDayClock: Boolean
)

/**
 * The StatsData v2 wire contract uses the `*Over*` values. The shorter values were emitted by
 * early Android fixtures and may still exist in an encrypted cache, so keep them readable without
 * letting them remain the production test oracle.
 */
internal fun comparisonKindPresentation(kind: String?): ComparisonKindPresentation = when (kind) {
    "dayOverDay", "day" -> ComparisonKindPresentation(
        windowLabel = "今日 vs 昨日",
        heroBaselineLabel = "较昨日同期",
        alignsToDayClock = true
    )
    "weekOverWeek", "week" -> ComparisonKindPresentation(
        windowLabel = "本周 vs 上周",
        heroBaselineLabel = "较上周同期",
        alignsToDayClock = false
    )
    "monthOverMonth", "month" -> ComparisonKindPresentation(
        windowLabel = "本月 vs 上月",
        heroBaselineLabel = "较上月同期",
        alignsToDayClock = false
    )
    else -> ComparisonKindPresentation(
        windowLabel = "当前 vs 上一周期",
        heroBaselineLabel = "较上一周期",
        alignsToDayClock = false
    )
}

internal enum class DeltaTone { Positive, Warning, Neutral }

internal data class DeltaPresentation(val label: String, val tone: DeltaTone)

internal fun deltaPresentation(delta: MetricDelta?): DeltaPresentation {
    if (delta == null) return DeltaPresentation("同期不可用", DeltaTone.Neutral)
    val label = when {
        delta.direction == "new" -> "本期新增"
        delta.percent == null -> "无可比基数"
        // 数字写法走共用的变化率格式（R-11）；此前这里跟随系统 Locale（德语系统写 +12,5%）。
        else -> formatChangePercent(delta.percent)
    }
    val tone = when (delta.direction) {
        "down" -> DeltaTone.Positive
        "up", "new" -> DeltaTone.Warning
        else -> DeltaTone.Neutral
    }
    return DeltaPresentation(label, tone)
}

internal enum class ReportMetricMode(val storedValue: String, val label: String) {
    Tokens("tokens", "Token 消耗"),
    // T10.154 A04：读屏随之念「预估费用视图」。
    Cost("cost", "预估费用");

    companion object {
        fun fromStored(value: String?): ReportMetricMode = entries.firstOrNull {
            it.storedValue == value
        } ?: Tokens
    }
}

internal typealias MetricDisplayMode = ReportMetricMode

internal data class TrendTableRow(val current: ComparisonSeriesPoint?, val previous: ComparisonSeriesPoint?) {
    val bucket: String get() = current?.bucket ?: previous?.bucket.orEmpty()
}

/** 收起态只取当前期已观测的最近行；展开态继续使用完整的对齐表。 */
internal fun collapsedTrendTableRows(rows: List<TrendTableRow>, limit: Int = 3): List<TrendTableRow> =
    rows.filter { it.current != null }.takeLast(limit.coerceAtLeast(0))

internal fun trendTableRows(stats: StatsData, mode: ReportMetricMode, limit: Int = 8): List<TrendTableRow> {
    val comparison = stats.comparison
    if (comparison == null) {
        if (mode == ReportMetricMode.Cost) return emptyList()
        return stats.trends.takeLast(limit.coerceAtLeast(0)).map { point ->
            TrendTableRow(ComparisonSeriesPoint(point.date,
                point.values.filterKeys { !it.startsWith("__") }.values.sum(), point.requests, 0.0), null)
        }
    }
    val current = comparison.current.series
    val previous = comparison.previous.series
    return (0 until maxOf(current.size, previous.size)).toList().takeLast(limit.coerceAtLeast(0)).map {
        TrendTableRow(current.getOrNull(it), previous.getOrNull(it))
    }
}

internal fun trendAvailabilityMessage(
    comparison: UsageComparison?, fallback: List<TrendPoint>, mode: ReportMetricMode
): String? {
    val (current, previous) = metricSeriesValues(comparison, fallback, mode)
    return when {
        current.isEmpty() -> if (mode == ReportMetricMode.Cost) "当前范围暂无费用趋势" else "当前范围暂无 Token 趋势"
        previous.isEmpty() -> "上一周期数据不可得"
        else -> null
    }
}

internal fun trendTableValue(point: ComparisonSeriesPoint?, mode: ReportMetricMode, currency: CurrencyUnit, masked: Boolean): String =
    when {
        point == null -> "不可得"
        mode == ReportMetricMode.Tokens -> "${formatInteger(point.tokens)} 有效 Token"
        else -> currency.format(point.cost, masked = masked)
    }

internal fun metricSeriesValues(
    comparison: UsageComparison?,
    fallback: List<TrendPoint>,
    mode: ReportMetricMode
): Pair<List<Float>, List<Float>> = when (mode) {
    ReportMetricMode.Tokens -> {
        val current = comparison?.current?.series?.map { it.tokens.toFloat() }
            ?: fallback.map { point -> point.values.filterKeys { !it.startsWith("__") }.values.sum().toFloat() }
        val previous = comparison?.previous?.series?.map { it.tokens.toFloat() }.orEmpty()
        current to previous
    }
    ReportMetricMode.Cost -> {
        val current = comparison?.current?.series?.map { it.cost.toFloat() }
            ?: emptyList()
        val previous = comparison?.previous?.series?.map { it.cost.toFloat() }.orEmpty()
        current to previous
    }
}

internal fun scrubIndexForPosition(
    touchX: Float,
    widthPx: Float,
    pointCount: Int,
    leftInsetPx: Float = 0f,
    rightInsetPx: Float = 0f
): Int? {
    if (pointCount <= 0) return null
    if (pointCount == 1) return 0
    val left = leftInsetPx
    val right = (widthPx - rightInsetPx).coerceAtLeast(left + 1f)
    val clampedX = touchX.coerceIn(left, right)
    val fraction = ((clampedX - left) / (right - left)).coerceIn(0f, 1f)
    return (fraction * (pointCount - 1)).roundToInt().coerceIn(0, pointCount - 1)
}

internal data class ScrubReadout(
    val index: Int,
    val bucket: String,
    val tokens: Long,
    /** 该槽位的预估费用；来源没有费用口径时为 null，不能用 0.0 冒充"这一格花了 0 元"。 */
    val cost: Double?,
    val requests: Long,
    val previousTokens: Long?,
    val previousCost: Double?,
    val tokenDeltaPercent: Double?,
    val costDeltaPercent: Double?
)

internal fun scrubReadoutForIndex(
    comparison: UsageComparison?,
    index: Int
): ScrubReadout? {
    val currentPoints = comparison?.current?.series ?: return null
    val currentPoint = currentPoints.getOrNull(index) ?: return null
    val prevPoint = comparison.previous.series.getOrNull(index)

    val tokenDeltaPercent = if (prevPoint != null && prevPoint.tokens > 0) {
        (currentPoint.tokens - prevPoint.tokens).toDouble() / prevPoint.tokens * 100.0
    } else null

    val costDeltaPercent = if (prevPoint != null && prevPoint.cost > 0.0) {
        (currentPoint.cost - prevPoint.cost) / prevPoint.cost * 100.0
    } else null

    return ScrubReadout(
        index = index,
        bucket = currentPoint.bucket,
        tokens = currentPoint.tokens,
        cost = currentPoint.cost,
        requests = currentPoint.requests,
        previousTokens = prevPoint?.tokens,
        previousCost = prevPoint?.cost,
        tokenDeltaPercent = tokenDeltaPercent,
        costDeltaPercent = costDeltaPercent
    )
}

/**
 * 游标读数的唯一入口：读数只能来自图上正在绘制的那条序列。
 *
 * 曾经的写法是 `scrubReadoutForIndex(comparison, index) ?: fallback[index]`。
 * 诚实空态下槽位数取当期与上期序列的较大值，于是 comparison 存在但当期序列更短时，
 * 越界槽位会掉进 `?:` 的右分支，把 stats.trends（另一次查询、另一套时间桶）里同一
 * 下标的点当成当期读数显示。fallback 只有在完全没有 comparison 时才与图上曲线同源，
 * 因此这里按 comparison 是否存在硬分流，不再用 null 兜底串序列。
 */
internal fun scrubReadout(
    comparison: UsageComparison?,
    fallback: List<TrendPoint>,
    index: Int,
    honestEmptyState: Boolean,
    mode: ReportMetricMode
): ScrubReadout? {
    if (comparison != null) return scrubReadoutForIndex(comparison, index)
    if (!honestEmptyState || mode != ReportMetricMode.Tokens) return null
    val point = fallback.getOrNull(index) ?: return null
    return ScrubReadout(
        index = index,
        bucket = point.date,
        tokens = point.values.filterKeys { !it.startsWith("__") }.values.sum(),
        // stats.trends 只有 Token 与记录数，没有费用口径。此前这里填 0.0，提示卡就会
        // 显示「¥0.00」——一个从未观测到的数字。未知只能是 null。
        cost = null,
        requests = point.requests,
        previousTokens = null,
        previousCost = null,
        tokenDeltaPercent = null,
        costDeltaPercent = null
    )
}

private val SCRUB_HOUR_REGEX = Regex("^\\d{1,2}:00$")
private val TREND_DATE_REGEX = Regex("^\\d{4}-\\d{2}-\\d{2}$")
private val TREND_MONTH_REGEX = Regex("^\\d{4}-\\d{2}$")
private val TREND_ISO_REGEX = Regex("^\\d{4}-(\\d{2}-\\d{2})[T ](\\d{2}:\\d{2})")

internal fun formatScrubBucketLabel(bucket: String): String {
    val trimmed = bucket.trim()
    if (trimmed.matches(SCRUB_HOUR_REGEX)) {
        val hour = trimmed.substringBefore(":").toIntOrNull()
        if (hour != null && hour in 0..23) {
            val nextHour = (hour + 1) % 24
            return String.format(Locale.US, "%02d:00 - %02d:00", hour, nextHour)
        }
    }
    return trimmed
}

internal fun formatScrubAccessibilityDescription(
    readout: ScrubReadout,
    mode: ReportMetricMode,
    exchangeRate: Double = BuildConfig.TOKENLEDGER_CNY_EXCHANGE_RATE,
    isCostMasked: Boolean = false,
    currency: CurrencyUnit = CurrencyUnit.CNY
): String {
    val timeLabel = formatScrubBucketLabel(readout.bucket)
    val mainLabel = when (mode) {
        ReportMetricMode.Tokens -> "有效 Token ${formatInteger(readout.tokens)}"
        // 费用未知时读屏也不能报一个数，否则盲用户得到的是比明眼用户更难发现的假值。
        ReportMetricMode.Cost -> readout.cost?.takeIf(::isKnownCost)?.let { "预估费用 ${currency.format(it, exchangeRate, isCostMasked)}" }
            ?: COST_UNAVAILABLE_SPOKEN
    }
    val reqLabel = "${formatInteger(readout.requests)} 条记录"
    return "$timeLabel，$mainLabel，$reqLabel"
}

internal fun formatTrendAnchorLabel(bucket: String): String {
    val trimmed = bucket.trim()
    if (trimmed.matches(TREND_DATE_REGEX)) {
        return trimmed.substring(5)
    }
    if (trimmed.matches(TREND_MONTH_REGEX)) {
        return trimmed.substring(5)
    }
    val isoMatch = TREND_ISO_REGEX.find(trimmed)
    if (isoMatch != null) {
        return "${isoMatch.groupValues[1]} ${isoMatch.groupValues[2]}"
    }
    return trimmed
}

internal fun filterModelsForTool(
    allModels: List<ModelStat>,
    visibleModelsFallback: List<ModelStat>,
    selectedTool: ToolStat?
): List<ModelStat> {
    if (selectedTool != null) {
        val toolModelNames = selectedTool.models.keys
        return allModels.filter { it.name in toolModelNames }
    }
    return visibleModelsFallback
}

internal fun trendSeriesBuckets(
    comparison: UsageComparison?,
    fallback: List<TrendPoint>
): List<String> {
    if (comparison != null && comparison.current.series.isNotEmpty()) {
        return comparison.current.series.map { it.bucket }
    }
    return fallback.map { it.date }
}

internal fun shouldAnchorTooltipToRight(touchX: Float, chartWidth: Float): Boolean {
    return touchX < chartWidth * 0.5f
}

internal fun heatmapCellAtPosition(
    x: Float,
    y: Float,
    widthPx: Float,
    heightPx: Float,
    columns: Int,
    rows: Int = 7,
    gapPx: Float = 2f
): Pair<Int, Int>? {
    if (columns <= 0 || rows <= 0 || widthPx <= 0f || heightPx <= 0f) return null
    if (x < 0f || y < 0f || x >= widthPx || y >= heightPx) return null
    val cellWidth = ((widthPx - gapPx * (columns - 1)) / columns).coerceAtLeast(1f)
    val cellHeight = ((heightPx - gapPx * (rows - 1)) / rows).coerceAtLeast(1f)
    val col = (x / (cellWidth + gapPx)).toInt()
    val row = (y / (cellHeight + gapPx)).toInt()
    return if (col in 0 until columns && row in 0 until rows) col to row else null
}

internal data class DonutSegment(val sourceIndex: Int?, val value: Long, val startDegrees: Float, val sweepDegrees: Float, val fraction: Double)
internal data class DonutPresentation(val total: Long, val segments: List<DonutSegment>, val valid: Boolean) {
    fun selected(index: Int?): DonutSegment? = index?.let { target -> segments.firstOrNull { it.sourceIndex == target } }
}

/** A single full-response denominator governs arcs, hit testing and selected readings. */
internal fun donutPresentation(values: List<Long>, total: Long): DonutPresentation {
    if (total < 0 || values.any { it < 0 }) return DonutPresentation(total, emptyList(), false)
    var shown = 0L
    for (value in values) {
        if (value > total - shown) return DonutPresentation(total, emptyList(), false)
        shown += value
    }
    if (total == 0L) return DonutPresentation(0, emptyList(), true)
    var start = -90f
    val segments = buildList {
        fun append(index: Int?, value: Long) {
            if (value == 0L) return
            val fraction = value.toDouble() / total.toDouble()
            val sweep = (360.0 * fraction).toFloat()
            add(DonutSegment(index, value, start, sweep, fraction))
            start += sweep
        }
        values.forEachIndexed { index, value -> append(index, value) }
        append(null, total - shown)
    }
    return DonutPresentation(total, segments, true)
}

internal fun donutSegmentAtOffset(presentation: DonutPresentation, x: Float, y: Float, size: Float, ringWidth: Float): Int? {
    if (!presentation.valid || size <= 0f || ringWidth <= 0f) return null
    val dx = x - size / 2f
    val dy = y - size / 2f
    val distance = sqrt(dx * dx + dy * dy)
    if (distance > size / 2f || distance < (size / 2f - ringWidth).coerceAtLeast(0f)) return null
    var angle = Math.toDegrees(atan2(dy.toDouble(), dx.toDouble())).toFloat()
    if (angle < -90f) angle += 360f
    return presentation.segments.firstOrNull { angle >= it.startDegrees && angle < it.startDegrees + it.sweepDegrees }?.sourceIndex
}

internal fun donutSliceAtOffset(
    touchX: Float,
    touchY: Float,
    sizePx: Float,
    values: List<Long>,
    startAngleOffset: Float = -90f
): Int? {
    if (values.isEmpty() || sizePx <= 0f) return null
    val total = values.sum().coerceAtLeast(1L)
    val centerX = sizePx / 2f
    val centerY = sizePx / 2f
    val dx = touchX - centerX
    val dy = touchY - centerY
    val dist = sqrt(dx * dx + dy * dy)
    val outerRadius = sizePx / 2f
    if (dist > outerRadius * 1.2f || dist < outerRadius * 0.2f) return null

    var angle = Math.toDegrees(atan2(dy.toDouble(), dx.toDouble())).toFloat()
    var normalized = (angle - startAngleOffset) % 360f
    if (normalized < 0f) normalized += 360f

    var currentAngle = 0f
    for (i in values.indices) {
        val sweep = 360f * values[i] / total
        if (normalized >= currentAngle && normalized < currentAngle + sweep) {
            return i
        }
        currentAngle += sweep
    }
    return values.lastIndex
}

internal fun donutSliceAtOffsetDouble(
    touchX: Float,
    touchY: Float,
    sizePx: Float,
    values: List<Double>,
    startAngleOffset: Float = -90f
): Int? {
    if (values.isEmpty() || sizePx <= 0f) return null
    val total = values.sum().coerceAtLeast(0.0001)
    val centerX = sizePx / 2f
    val centerY = sizePx / 2f
    val dx = touchX - centerX
    val dy = touchY - centerY
    val dist = sqrt(dx * dx + dy * dy)
    val outerRadius = sizePx / 2f
    if (dist > outerRadius * 1.2f || dist < outerRadius * 0.2f) return null

    var angle = Math.toDegrees(atan2(dy.toDouble(), dx.toDouble())).toFloat()
    var normalized = (angle - startAngleOffset) % 360f
    if (normalized < 0f) normalized += 360f

    var currentAngle = 0f
    for (i in values.indices) {
        val sweep = (360f * values[i] / total).toFloat()
        if (normalized >= currentAngle && normalized < currentAngle + sweep) {
            return i
        }
        currentAngle += sweep
    }
    return values.lastIndex
}

internal fun isLandscapeOrCompactHeight(screenHeightDp: Int): Boolean = screenHeightDp < 500
