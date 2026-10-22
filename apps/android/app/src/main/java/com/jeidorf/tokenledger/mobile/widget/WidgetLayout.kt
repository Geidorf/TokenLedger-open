package com.jeidorf.tokenledger.mobile.widget

import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import kotlin.math.floor

/** 实际 Launcher 尺寸决定内容预算；旧 MultiBar 保持既有档位。 */
internal data class WidgetRingLayout(val visibleCount: Int, val diameterDp: Float, val compactOverflow: Boolean = false)

internal fun widgetRingLayout(widthDp: Float, heightDp: Float, fontScale: Float, count: Int): WidgetRingLayout {
    if (!widthDp.isFinite() || !heightDp.isFinite() || !fontScale.isFinite() || count <= 0) {
        return WidgetRingLayout(0, 0f)
    }
    val scale = fontScale.coerceAtLeast(1f)
    val contentWidth = (widthDp - 20f).coerceAtLeast(0f)
    val slots = floor(contentWidth / (84f * scale)).toInt().coerceIn(0, 3)
    val visible = minOf(count, slots)
    val footer = if (count > visible) 16f * scale else 0f
    val diameter = minOf(72f, heightDp - 14f - 44f * scale - footer)
    if (visible > 0 && diameter >= maxOf(40f, 30f * scale)) {
        return WidgetRingLayout(visible, diameter)
    }

    // 紧凑卡始终收束为一个来源：标题在上，圆环与周期/状态并排。
    // 内边距由 WidgetMetrics 与 WidgetBody 共用，不再两边各写一份；
    // 不要求宽度原本只有一槽，也不把100dp当断点。
    val innerWidth = WidgetMetrics.innerWidthDp(widthDp)
    val innerHeight = WidgetMetrics.innerHeightDp(heightDp)
    val compactDiameter = 40f * scale
    val bodyHeight = maxOf(compactDiameter, 48f * scale) // 周期最多2行、状态1行
    val fits = innerWidth >= compactDiameter + 6f + 48f * scale &&
        innerHeight >= 16f * scale + 2f + bodyHeight
    return if (fits) WidgetRingLayout(1, compactDiameter, compactOverflow = true)
        else WidgetRingLayout(0, 0f)
}

internal data class WidgetComboLayout(
    val sufficient: Boolean,
    val stackedUsage: Boolean,
    val visibleCount: Int,
    val usageHeightDp: Float,
    val quotaRowHeightDp: Float
)

internal fun widgetComboLayout(widthDp: Float, heightDp: Float, fontScale: Float, count: Int): WidgetComboLayout {
    val scale = fontScale.coerceAtLeast(1f)
    val stacked = widthDp < 280f * scale
    val usageHeight = (if (stacked) 43f else 42f) * scale
    val rowHeight = 37f * scale
    val remaining = heightDp - 14f - usageHeight - 12f
    val slots = floor(remaining / rowHeight).toInt().coerceIn(0, 3)
    val fits = widthDp >= 150f * scale && slots >= 1
    return WidgetComboLayout(fits, stacked, if (fits) minOf(count, slots) else 0, usageHeight, rowHeight)
}

/** 先保留完整来源集再由尺寸裁决，+N 才能覆盖第四个及之后的来源。 */
internal fun widgetLayoutProviders(providers: List<WidgetQuotaProvider>, providerId: String?): List<WidgetQuotaProvider> =
    providerId?.let { id -> providers.firstOrNull { it.id == id } }?.let(::listOf) ?: providers

internal fun widgetUsageDescription(usage: WidgetUsage, masked: Boolean): String =
    "${usage.range.label}有效 Token ${formatCompactTokens(usage.effectiveTokens)}，" +
        "预估费用 ${formatCny(usage.costCny, masked)}，更新于${usage.freshnessText}"

internal fun widgetQuotaCaption(provider: WidgetQuotaProvider): String = buildList {
    add(formatWidgetWindowLabel(provider.primary?.label ?: "额度", provider.primaryIsRoleSubstitute))
    formatHiddenWindowCount(provider.hiddenWindowCount)?.let(::add)
}.joinToString(" · ")

internal fun widgetQuotaValue(provider: WidgetQuotaProvider): String = when (provider.status) {
    QuotaProviderStatus.Ok -> provider.primary?.availableText?.let { "可用 $it" } ?: "不可用"
    QuotaProviderStatus.Stale -> provider.primary?.availableText?.let { "历史 $it" } ?: "历史数据"
    else -> statusLabel(provider.status)
}

internal fun widgetQuotaStatusSymbol(provider: WidgetQuotaProvider): String = when (provider.status) {
    QuotaProviderStatus.Ok -> "●"
    QuotaProviderStatus.Stale -> "◷"
    QuotaProviderStatus.AuthRequired -> "!"
    QuotaProviderStatus.Error -> "×"
    QuotaProviderStatus.Unsupported -> "—"
}

internal fun widgetLayoutDescription(state: WidgetState, config: WidgetConfig, masked: Boolean): String = when (state) {
    WidgetState.NeedLogin -> "TokenLedger，需要登录"
    WidgetState.NoData -> "TokenLedger，暂无数据"
    is WidgetState.Ready -> buildList {
        if (config.mode != WidgetMode.SingleUsage) {
            val providers = widgetLayoutProviders(state.quota?.providers.orEmpty(), config.providerId)
            if (providers.isEmpty()) add("额度未同步")
            providers.forEach { add(providerAccessibilityDescription(it) + "，" + widgetQuotaCaption(it)) }
        }
        if (config.mode == WidgetMode.SingleUsage || config.mode == WidgetMode.BarUsage) {
            add(state.usage?.let { widgetUsageDescription(it, masked) } ?: "用量未同步")
        }
    }.joinToString("；")
}
