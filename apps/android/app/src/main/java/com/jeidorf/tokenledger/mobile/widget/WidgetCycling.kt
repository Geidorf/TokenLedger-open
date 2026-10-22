package com.jeidorf.tokenledger.mobile.widget

import com.jeidorf.tokenledger.mobile.QuotaWindowSnapshot

/**
 * 小组件配置选择与阈值的**纯逻辑**（T8.5/T8.7）。此文件刻意不 import 任何 Android/Glance/Compose 类型，
 * 以便在纯 JVM 单测中直接覆盖（对照 StatsJsonTest 的组织方式）。ActionCallback 只做 IO + 调度，
 * 决策一律下沉到这里的纯函数，保证「就地重绘不开应用」的每一步都可被锁定。
 */

/** 用量范围循环（迭代计划 §切换方式-3）：今日 → 本周 → 本月 → 回到今日。 */
internal fun nextWidgetRange(current: WidgetRange): WidgetRange {
    val order = listOf(WidgetRange.Today, WidgetRange.Week, WidgetRange.Month)
    val index = order.indexOf(current)
    if (index < 0) return order.first()
    return order[(index + 1) % order.size]
}

/** 当前小组件选择器只公开三种互不重叠的产品形态。 */
internal fun publicWidgetModes(): List<WidgetMode> =
    listOf(WidgetMode.MultiRing, WidgetMode.SingleUsage, WidgetMode.BarUsage)

/**
 * 旧通用 Provider 允许保留已存的 [WidgetMode.MultiBar]；其余配置只展示公开三态，
 * 防止用户把新版固定 Provider 重新配置成另一张卡。
 */
internal fun configurableWidgetModes(current: WidgetMode): List<WidgetMode> =
    publicWidgetModes() + listOfNotNull(WidgetMode.MultiBar.takeIf { current == WidgetMode.MultiBar })

/** 根据 Provider 组件锁定公开卡片类型；旧 TokenLedgerWidgetReceiver 返回 null。 */
internal fun providerLockedWidgetMode(providerClassName: String?): WidgetMode? = when {
    providerClassName?.endsWith(".TokenLedgerRingWidgetReceiver") == true -> WidgetMode.MultiRing
    providerClassName?.endsWith(".TokenLedgerBarWidgetReceiver") == true -> WidgetMode.SingleUsage
    providerClassName?.endsWith(".TokenLedgerComboWidgetReceiver") == true -> WidgetMode.BarUsage
    else -> null
}

/** 只有全部 Provider 实例都已移除时，才允许取消共享周期任务。 */
internal fun shouldCancelWidgetRefresh(installedInstanceCount: Int): Boolean =
    installedInstanceCount <= 0

/**
 * 大字体或窄组件优先保证一个完整的“来源 + 状态 + 数值”语义单元，剩余来源用 +N 告知；
 * 不通过逆向缩放系统字体把三列硬塞回去。
 */
internal fun visibleWidgetProviderCount(
    providerCount: Int,
    widthDp: Float,
    heightDp: Float,
    fontScale: Float
): Int = when {
    providerCount <= 0 -> 0
    fontScale >= 1.8f || WidgetMetrics.isNarrow(widthDp) -> 1
    fontScale >= 1.4f || widthDp < 236f || heightDp < 96f -> minOf(providerCount, 2)
    else -> minOf(providerCount, 3)
}

/**
 * 单行消耗在大字体下按可用高度重排。窄条无法同时容纳两组双行指标时只保留主 Token，
 * 但完整成本与更新时间仍保留在整卡 TalkBack 描述中；高度足够时改为上下两条轨道。
 */
internal enum class WidgetUsageLayout { Split, Stacked, PrimaryOnly }

internal fun widgetUsageLayout(
    widthDp: Float,
    heightDp: Float,
    fontScale: Float
): WidgetUsageLayout = when {
    WidgetMetrics.isShort(heightDp) && (fontScale >= 1.4f || WidgetMetrics.isNarrow(widthDp)) ->
        WidgetUsageLayout.PrimaryOnly
    fontScale >= 1.4f || widthDp < 210f ->
        WidgetUsageLayout.Stacked
    else -> WidgetUsageLayout.Split
}

/** 登录/空态在短组件或大字体下合并成可换行的一段，避免固定两层文本互相裁切。 */
internal fun shouldUseCompactWidgetMessage(heightDp: Float, fontScale: Float): Boolean =
    WidgetMetrics.isShort(heightDp) || fontScale >= 1.4f

internal fun statusLabel(status: com.jeidorf.tokenledger.mobile.QuotaProviderStatus): String =
    when (status) {
        com.jeidorf.tokenledger.mobile.QuotaProviderStatus.Ok -> "可用"
        com.jeidorf.tokenledger.mobile.QuotaProviderStatus.Stale -> "历史数据"
        com.jeidorf.tokenledger.mobile.QuotaProviderStatus.AuthRequired -> "需授权"
        com.jeidorf.tokenledger.mobile.QuotaProviderStatus.Error -> "不可用"
        com.jeidorf.tokenledger.mobile.QuotaProviderStatus.Unsupported -> "不支持"
    }

/** TalkBack 的一个额度单元同时包含来源、周期、状态、合法数值、重置与更新时间。 */
internal fun providerAccessibilityDescription(provider: WidgetQuotaProvider): String {
    val window = provider.primary
    val mayExposeValue = provider.status == com.jeidorf.tokenledger.mobile.QuotaProviderStatus.Ok ||
        provider.status == com.jeidorf.tokenledger.mobile.QuotaProviderStatus.Stale
    val value = if (window != null && mayExposeValue) {
        "，${window.availableText}可用"
    } else {
        ""
    }
    val reset = provider.resetText ?: "重置时间不可用"
    return "${provider.name}，${window?.label ?: "额度周期"}，${statusLabel(provider.status)}" +
        "$value，$reset，更新于${provider.freshnessText}"
}

/** 默认展示稳定排序后的前三个来源；配置了单一来源时只保留该来源。 */
internal fun selectWidgetProviders(
    providers: List<WidgetQuotaProvider>,
    providerId: String?
): List<WidgetQuotaProvider> {
    val selected = providerId?.let { id -> providers.firstOrNull { it.id == id } }
    return selected?.let(::listOf) ?: providers.take(3)
}

/**
 * 组件所示更新时间必须属于所示 primary 窗口，不能借同 Provider 另一窗口的较新时间
 * 给当前百分比“续鲜”。缺失或解析失败时诚实显示“时间未知”，不猜其他窗口或当前时刻。
 */
internal fun primaryWindowFreshnessText(
    primary: QuotaWindowSnapshot?,
    nowMillis: Long
): String {
    if (primary == null) return "时间未知"
    val observedAtMillis = runCatching {
        primary.observedInstant.toEpochMilli()
    }.getOrNull() ?: return "时间未知"
    return formatRelativeTime(nowMillis - observedAtMillis)
}

/**
 * 可用额度阈值分档：剩余 <20% 告急（Danger）、<50% 偏紧（Warn），其余正常（Normal），
 * 严格小于。小组件展示的是「可用」而非「已用」，因此阈值方向不能沿用消耗比例。
 *
 * 阈值统一自 D4（T10.152）：与桌面 `src/utils/quotaOverview.ts` 的 `quotaLevel`、
 * Android 应用 `LedgerUiLogic.kt` 的 `quotaSeverity` 三端一致。此前小组件单独用
 * ≤5%/≤20%（比应用的 15/40 更严格），两把尺各说各话；现在统一成一把尺，
 * 三处绑定该分档的位置（本函数、`WidgetTheme.kt` 的颜色映射、
 * `ui/ambient/V2WidgetPreviewCard.kt` 的 `V2WidgetQuotaPill` 预览换算）
 * 不必再分别记账。
 *
 * T10.170：`<` 对 NaN 的 IEEE 754 比较恒为 false，非有限值（NaN、±Infinity）此前
 * 会穿过下面两个 `<` 分支落到 `else -> Normal`——把「未知」显示成「正常」，与
 * 桌面 `quotaLevel` 的 fail-closed 口径不一致，也违反 GLB-01（未知不得看起来
 * 安全）。现在非有限值单列第一个分支判 Danger；原有的 `< 0.20f`/`< 0.50f` 两个
 * 分支未改。
 */
internal enum class WidgetThresholdBand { Normal, Warn, Danger }

internal fun widgetAvailabilityBand(availableFraction: Float): WidgetThresholdBand = when {
    !availableFraction.isFinite() -> WidgetThresholdBand.Danger
    availableFraction < 0.20f -> WidgetThresholdBand.Danger
    availableFraction < 0.50f -> WidgetThresholdBand.Warn
    else -> WidgetThresholdBand.Normal
}

/**
 * 渲染态裁决（诚实额度原则，REQ-WIDGET-02）：无会话 → NeedLogin；有会话但额度/用量缓存皆空 → NoData；
 * 任一有数据 → Ready。抽成纯函数以便脱离 Context/加密缓存做单测；[WidgetStateRepository] 复用它。
 */
internal fun resolveWidgetState(
    hasSession: Boolean,
    quota: WidgetQuota?,
    usage: WidgetUsage?
): WidgetState = when {
    !hasSession -> WidgetState.NeedLogin
    quota == null && usage == null -> WidgetState.NoData
    else -> WidgetState.Ready(quota = quota, usage = usage)
}
