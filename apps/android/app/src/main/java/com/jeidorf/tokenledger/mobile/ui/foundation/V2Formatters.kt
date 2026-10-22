package com.jeidorf.tokenledger.mobile.ui.foundation

import android.content.Context
import com.jeidorf.tokenledger.mobile.BuildConfig
import com.jeidorf.tokenledger.mobile.CostPrecision
import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.ModelStat
import com.jeidorf.tokenledger.mobile.PrivacyStore
import com.jeidorf.tokenledger.mobile.QuotaCapability
import com.jeidorf.tokenledger.mobile.QuotaDisplayValue
import com.jeidorf.tokenledger.mobile.QuotaProviderEnvelope
import com.jeidorf.tokenledger.mobile.QuotaScope
import com.jeidorf.tokenledger.mobile.QuotaUnit
import com.jeidorf.tokenledger.mobile.Summary
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.UsageComparison
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.formatChangePercent
import com.jeidorf.tokenledger.mobile.formatCostForDisplay
import com.jeidorf.tokenledger.mobile.formatCurrencyAmount
import com.jeidorf.tokenledger.mobile.formatQuotaCurrencyAmount
import com.jeidorf.tokenledger.mobile.formatSharePercent
import com.jeidorf.tokenledger.mobile.formatSignedCurrencyAmount
import com.jeidorf.tokenledger.mobile.formatSignedInteger
import com.jeidorf.tokenledger.mobile.formatSignedTokens
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** 美元金额 → 本币种文案（[formatCostForDisplay]）；读不到写「不可得」，明细单条记录用 [CostPrecision.Record]。 */
internal fun v2FormatMoney(
    context: Context,
    value: Double?,
    masked: Boolean = PrivacyStore.isCostMaskEnabled(context),
    currency: CurrencyUnit = CurrencyUnit.CNY,
    precision: CostPrecision = CostPrecision.Summary
): String = formatCostForDisplay(value, BuildConfig.TOKENLEDGER_CNY_EXCHANGE_RATE, masked, currency, precision)

/** 变化率（[formatChangePercent]）；没有百分比时写「基线缺失」（比较语义由 C2 统一）。 */
internal fun v2FormatPercent(value: Double?): String = value?.let(::formatChangePercent) ?: "基线缺失"

internal fun v2Share(value: Long, total: Long): String = if (total <= 0) "—" else formatSharePercent(value * 100.0 / total)

internal fun v2CacheHit(summary: Summary): String {
    val read = summary.cacheReadTokens
    val write = summary.cacheWriteTokens
    if (!summary.cacheSplitKnown || read < 0L || write < 0L ||
        runCatching { Math.addExact(read, write) }.getOrNull() != summary.cachedTokens
    ) {
        return "—"
    }
    val denominator = runCatching { Math.addExact(summary.inputTokens, read) }
        .getOrNull()
        ?: return "—"
    return if (denominator <= 0L) "—" else formatSharePercent(read * 100.0 / denominator)
}

/** Token 差值：`+1.5K`、`−2.30M`（U+2212）；读不到写「—」（与桌面 `formatTokens` 的未知写法相同）。 */
internal fun v2SignedTokens(value: Double?): String =
    value?.takeIf { it.isFinite() }?.let { formatSignedTokens(it.toLong()) } ?: "—"

/** 整数差值：`+348`、`−12`（U+2212）；读不到写「—」。 */
internal fun v2SignedNumber(value: Double?): String =
    value?.takeIf { it.isFinite() }?.let { formatSignedInteger(it.toLong()) } ?: "—"

/** 金额差值：`+¥3.20`、`−¥1.05`、`+<¥0.01`；隐藏费用时只给掩码；读不到写「不可得」。 */
internal fun v2SignedMoney(
    context: Context,
    value: Double?,
    masked: Boolean = PrivacyStore.isCostMaskEnabled(context),
    currency: CurrencyUnit = CurrencyUnit.CNY
): String = if (masked) "${currency.symbol}***.*"
    else formatSignedCurrencyAmount(value?.let { currency.convertFromUsd(it, BuildConfig.TOKENLEDGER_CNY_EXCHANGE_RATE) }, currency)

// 有效 Token 恒等于 输入+输出，不回退到 model.total（与桌面/Rust/Supabase 口径一致）。
internal fun v2ModelEffectiveTokens(model: ModelStat): Long = model.effectiveTokens

internal fun v2ModelTokens(model: ModelStat, tokenDisplayMode: TokenDisplayMode): Long = displayedTokenCount(
    tokenDisplayMode,
    v2ModelEffectiveTokens(model),
    model.cached
)

internal fun v2ComparisonLabel(comparison: UsageComparison?): String = when (comparison?.window?.kind?.lowercase()) {
    "dayoverday", "day_over_day" -> "今日 vs 昨日 · 同进度"
    "weekoverweek", "week_over_week" -> "本周 vs 上周 · 同进度"
    "monthovermonth", "month_over_month" -> "本月 vs 上月 · 同进度"
    "periodoverperiod", "period_over_period" -> "当前 vs 上一周期 · 同进度"
    else -> "当前范围没有自动基线"
}

internal fun v2ShortDateTime(value: String?): String = value?.trim()?.takeIf(String::isNotEmpty)?.let { timestamp ->
    runCatching {
        OffsetDateTime.parse(timestamp)
            .atZoneSameInstant(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofPattern("MM-dd HH:mm"))
    }.getOrElse {
        Regex("^(?:\\d{4}-)?(\\d{2}-\\d{2})[T ](\\d{1,2}:\\d{2})")
            .find(timestamp)
            ?.let { match -> "${match.groupValues[1]} ${match.groupValues[2]}" }
            ?: timestamp
    }
} ?: "未知"

internal fun v2ResetLabel(value: String?): String = value?.let { "重置 ${v2ShortDateTime(it)}" } ?: "重置时间未知"

internal fun v2Capability(capability: QuotaCapability): String = when (capability) {
    QuotaCapability.Stable -> "稳定来源"
    QuotaCapability.PlanDependent -> "计划相关"
    QuotaCapability.Experimental -> "增强来源"
    QuotaCapability.Manual -> "手工配置"
    QuotaCapability.Unsupported -> "不支持"
}

internal fun v2Scope(scope: QuotaScope): String = when (scope) {
    QuotaScope.ConsumerSubscription -> "消费者订阅"
    QuotaScope.ApiOrganization -> "API 组织"
    QuotaScope.ManualBudget -> "手工预算"
}

internal fun v2QuotaSource(provider: QuotaProviderEnvelope): String = when (provider.capability) {
    QuotaCapability.Stable -> "官方或受支持来源 · 桌面端脱敏同步"
    QuotaCapability.Experimental -> "用户授权增强来源 · 可随时撤销"
    QuotaCapability.PlanDependent -> "本地授权来源 · 能力取决于账户计划"
    QuotaCapability.Manual -> "用户手工配置"
    QuotaCapability.Unsupported -> "当前计划或平台没有可用来源"
}

internal fun v2QuotaReason(reason: String?, scope: QuotaScope? = null): String = when (reason) {
    "local_authorization_required", "claude_local_authorization_required" -> "需要在桌面设置中显式授权"
    "admin_key_required", "api_key_required" -> "需要在桌面端配置公司 API key"
    "experimental_consent_required" -> "需要在桌面端确认实验性风险提示"
    "rate_limited" -> "公司额度接口正在限流，请稍后重试"
    "upstream_unavailable" -> "公司额度接口暂时不可用"
    "balance_unavailable" -> "供应商余额接口没有返回可验证的余额或币种"
    "secure_storage_unavailable" -> "系统安全存储暂时无法读取，请在桌面端确认钥匙串已解锁后刷新"
    "source_temporarily_unavailable" -> if (scope == QuotaScope.ApiOrganization) "公司额度接口暂时不可用" else "额度来源暂不可用"
    "source_schema_unsupported" -> if (scope == QuotaScope.ApiOrganization) "公司额度接口响应结构暂不兼容" else "额度来源结构暂不兼容"
    "observation_stale" -> "云端同步正常，来源观测待刷新"
    "reset_elapsed" -> "额度窗口已到重置时间，等待来源提供新值"
    "credits_unlimited" -> "额外用量不限额"
    null -> "当前没有可显示窗口"
    else -> "额度来源暂不可用"
}

internal fun v2QuotaAbsolute(value: QuotaDisplayValue.Absolute): String {
    val amount = value.remaining ?: value.used ?: value.limit ?: return "上限未知"
    return when (value.unit) {
        QuotaUnit.Usd -> formatCurrencyAmount(amount, CurrencyUnit.USD)
        QuotaUnit.Credits -> String.format(Locale.US, "%.1f 额度点", amount)
        QuotaUnit.Tokens -> v2FormatTokens(amount.toLong())
        QuotaUnit.Requests -> v2FormatNumber(amount.toLong())
        QuotaUnit.Percent -> String.format(Locale.US, "%.0f%%", amount)
        QuotaUnit.Currency -> formatQuotaCurrencyAmount(amount, value.currency.orEmpty())
    }
}
