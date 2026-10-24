package com.jeidorf.tokenledger.mobile.widget

import com.jeidorf.tokenledger.mobile.QuotaDisplayValue
import com.jeidorf.tokenledger.mobile.QuotaProviderEnvelope
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.QuotaWindowSnapshot
import com.jeidorf.tokenledger.mobile.QuotaWindowStatus
import com.jeidorf.tokenledger.mobile.displayValue
import com.jeidorf.tokenledger.mobile.effectiveStatus
import com.jeidorf.tokenledger.mobile.groupedQuotaWindowsForDisplay
import com.jeidorf.tokenledger.mobile.localizedCompactWindowLabel
import com.jeidorf.tokenledger.mobile.localizedDisplayName
import com.jeidorf.tokenledger.mobile.orderedQuotaProvidersForDisplay
import com.jeidorf.tokenledger.mobile.primaryWindowIsRoleSubstitute
import com.jeidorf.tokenledger.mobile.quotaAvailableAccessibilityLabel
import com.jeidorf.tokenledger.mobile.quotaAvailablePercent
import com.jeidorf.tokenledger.mobile.rankedQuotaWindowsForDisplay
import com.jeidorf.tokenledger.mobile.selectPrimaryDisplayWindow
import java.time.Instant
import kotlin.math.floor

/**
 * 额度条小组件（[WidgetMode.QuotaBars]）的纯逻辑：一个额度窗口一行，左边是来源与窗口，
 * 右边是重置倒计时与可用百分比，下面一条细进度条。不 import Android/Glance，便于 JVM 单测。
 *
 * 数值口径与其他小组件相同（REQ-WIDGET-02）：可用 = 100 − round(已用)，条长与档位跟着显示的整数走。
 */
internal data class WidgetQuotaBarRow(
    /** 契约稳定键 `providerId + scope + windowId`；待处理来源行用 `providerId`。 */
    val key: String,
    val providerId: String,
    val providerName: String,
    /** 窗口短名，例如「5 小时」「每周」；没有窗口的待处理来源行为 null。 */
    val windowLabel: String?,
    /** 这一行的状态：来源的错误/授权态优先，其次是窗口自己的时效。 */
    val status: QuotaProviderStatus,
    /** 可用比例 0..1，已量化到显示的整数百分比；不能画条时为 null。 */
    val availableFraction: Float?,
    /** 可用整数百分比；不能给数时为 null。 */
    val availablePercent: Int?,
    /** 例如「49 分钟后重置」；没有未来的重置时间时为 null，不臆测。 */
    val resetText: String?,
    /** 这个窗口自己的观测时间换成的「N 分钟前」。 */
    val freshnessText: String,
    /** 截断时的优先级：先每个来源的主窗口，再次窗口，再其余（与其他受限表面同序）。 */
    val rank: Int,
    /** 展示顺序：同一来源的窗口挨在一起（与完整额度页同序）。 */
    val groupOrder: Int,
    /** 来源偏好的窗口这次没拿到、这一行是替代窗口时为 true，须写「替代」字样。 */
    val roleSubstitute: Boolean = false
)

/** 这一行的数值文字。改口径只改这里。 */
internal fun widgetQuotaBarValueText(row: WidgetQuotaBarRow): String = when (row.status) {
    QuotaProviderStatus.Ok -> row.availablePercent?.let { "可用 $it%" } ?: "不可用"
    QuotaProviderStatus.Stale -> row.availablePercent?.let { "历史 $it%" } ?: "历史数据"
    else -> statusLabel(row.status)
}

/** 行标题：全部来源时写「来源 · 窗口」，钉住单一来源时只写窗口（来源在卡头）。 */
internal fun widgetQuotaBarTitle(row: WidgetQuotaBarRow, pinnedProvider: Boolean): String {
    val window = row.windowLabel?.let { formatWidgetWindowLabel(it, row.roleSubstitute) }
    val provider = widgetShortProviderName(row.providerName)
    return when {
        window == null -> provider
        pinnedProvider -> window
        else -> "$provider · $window"
    }
}

/** 读屏一行念完：来源、窗口、可用百分比与档位、重置、观测时间。颜色只是第二编码。 */
internal fun widgetQuotaBarAccessibility(row: WidgetQuotaBarRow): String = buildList {
    add(listOfNotNull(row.providerName, row.windowLabel?.let { formatWidgetWindowLabel(it, row.roleSubstitute) })
        .joinToString(" "))
    when {
        row.status == QuotaProviderStatus.Ok && row.availablePercent != null ->
            add(quotaAvailableAccessibilityLabel(row.availablePercent))
        row.status == QuotaProviderStatus.Stale && row.availablePercent != null ->
            add("历史数据，可用 ${row.availablePercent}%")
        else -> add(statusLabel(row.status))
    }
    add(row.resetText ?: "重置时间不可用")
    add("更新于${row.freshnessText}")
}.joinToString("，")

internal fun widgetShortProviderName(name: String): String =
    name.replace(" 订阅额度", "").replace(" 额度", "").replace("订阅额度", "").trim()

/**
 * 重置倒计时，写法同截图里的套餐限额：「49 分钟后重置」「6 小时 29 分钟后重置」「2 天 3 小时后重置」。
 * 只用整数分钟；不足 1 分钟写「1 分钟内重置」，不写「0 分钟后」。
 */
internal fun formatQuotaBarReset(untilMillis: Long): String {
    val totalMinutes = untilMillis.coerceAtLeast(0L) / 60_000L
    if (totalMinutes < 1L) return "1 分钟内重置"
    val days = totalMinutes / (24L * 60L)
    val hours = (totalMinutes / 60L) % 24L
    val minutes = totalMinutes % 60L
    return when {
        days > 0L -> if (hours > 0L) "$days 天 $hours 小时后重置" else "$days 天后重置"
        hours > 0L -> if (minutes > 0L) "$hours 小时 $minutes 分钟后重置" else "$hours 小时后重置"
        else -> "$minutes 分钟后重置"
    }
}

/**
 * 额度快照 → 额度条的行。来源顺序与窗口挑选全部复用既有共用函数（[rankedQuotaWindowsForDisplay]、
 * [groupedQuotaWindowsForDisplay]），与 transport 数组下标无关。没有可绘制窗口但处于错误、需授权或
 * 不支持的来源各占一行，只写状态，不画伪造的进度。
 */
internal fun widgetQuotaBarRows(
    providers: List<QuotaProviderEnvelope>,
    now: Instant,
    nowMillis: Long = now.toEpochMilli()
): List<WidgetQuotaBarRow> {
    val ordered = providers.orderedQuotaProvidersForDisplay()
    if (ordered.isEmpty()) return emptyList()
    val ranked = providers.rankedQuotaWindowsForDisplay()
    val rankByKey = ranked.withIndex().associate { (index, pair) -> pair.second.stableKey to index }
    val groupByKey = providers.groupedQuotaWindowsForDisplay().withIndex()
        .associate { (index, pair) -> pair.second.stableKey to index }
    val providerOrder = ordered.withIndex().associate { (index, provider) -> provider.stableKey to index }

    val windowRows = ranked.map { (provider, window) ->
        mapQuotaBarRow(
            provider = provider,
            window = window,
            now = now,
            nowMillis = nowMillis,
            rank = rankByKey.getValue(window.stableKey),
            groupOrder = groupByKey[window.stableKey] ?: Int.MAX_VALUE
        )
    }
    val withWindows = ranked.map { it.first.stableKey }.toSet()
    // 只有积分等不能画条的窗口、但来源本身正常的，不占行；错误、需授权、不支持的来源各占一行如实说明。
    val pendingRows = ordered
        .filter { it.stableKey !in withWindows }
        .map { it to it.effectiveStatus(now) }
        .filter { (_, status) -> status != QuotaProviderStatus.Ok && status != QuotaProviderStatus.Stale }
        .mapIndexed { index, (provider, status) ->
            WidgetQuotaBarRow(
                key = provider.stableKey,
                providerId = provider.providerId,
                providerName = provider.localizedDisplayName(),
                windowLabel = null,
                status = status,
                availableFraction = null,
                availablePercent = null,
                resetText = null,
                freshnessText = "时间未知",
                rank = ranked.size + index,
                // 排在所有窗口行之后，彼此按来源的稳定顺序。
                groupOrder = ranked.size + (providerOrder[provider.stableKey] ?: index)
            )
        }
    return windowRows + pendingRows
}

private fun mapQuotaBarRow(
    provider: QuotaProviderEnvelope,
    window: QuotaWindowSnapshot,
    now: Instant,
    nowMillis: Long,
    rank: Int,
    groupOrder: Int
): WidgetQuotaBarRow {
    val providerName = provider.localizedDisplayName()
    val providerStatus = provider.effectiveStatus(now)
    val windowStatus = window.effectiveStatus(now)
    val status = when {
        providerStatus == QuotaProviderStatus.Error ||
            providerStatus == QuotaProviderStatus.AuthRequired ||
            providerStatus == QuotaProviderStatus.Unsupported -> providerStatus
        windowStatus == QuotaWindowStatus.Error -> QuotaProviderStatus.Error
        windowStatus == QuotaWindowStatus.AuthRequired -> QuotaProviderStatus.AuthRequired
        windowStatus == QuotaWindowStatus.Stale -> QuotaProviderStatus.Stale
        else -> QuotaProviderStatus.Ok
    }
    val percent = (window.displayValue() as? QuotaDisplayValue.Progress)
        ?.let(::quotaAvailablePercent)
        ?.takeIf { status == QuotaProviderStatus.Ok || status == QuotaProviderStatus.Stale }
    val reset = window.resetInstant?.takeIf { it.isAfter(now) }
        ?.let { formatQuotaBarReset(it.toEpochMilli() - now.toEpochMilli()) }
    val primary = provider.selectPrimaryDisplayWindow()
    return WidgetQuotaBarRow(
        key = window.stableKey,
        providerId = provider.providerId,
        providerName = providerName,
        windowLabel = window.localizedCompactWindowLabel(providerName),
        status = status,
        availableFraction = percent?.let { it / 100f },
        availablePercent = percent,
        resetText = reset,
        freshnessText = primaryWindowFreshnessText(window, nowMillis),
        rank = rank,
        groupOrder = groupOrder,
        // 「替代」只标在来源的主窗口上：那一格本该是偏好角色，次窗口本来就是另一角色。
        roleSubstitute = window.stableKey == primary?.stableKey && provider.primaryWindowIsRoleSubstitute(primary)
    )
}

/** 钉住单一来源时只保留它的行；钉住的来源不在快照里时返回空，由卡片直说读不到，不回退成其他来源。 */
internal fun widgetQuotaBarRowsFor(rows: List<WidgetQuotaBarRow>, providerId: String?): List<WidgetQuotaBarRow> =
    if (providerId == null) rows else rows.filter { it.providerId == providerId }

/** 额度条的版面预算。尺寸只决定放几行，放不下的在卡头写「+N 个窗口」，不静默截断。 */
internal data class WidgetQuotaBarsLayout(
    val sufficient: Boolean,
    /** 按展示顺序排好的可见行。 */
    val visible: List<WidgetQuotaBarRow>,
    val hiddenCount: Int,
    /** 宽度够时右侧同时写重置倒计时；窄卡只留百分比，倒计时仍在读屏里。 */
    val showReset: Boolean,
    val showRouting: Boolean,
    val rowHeightDp: Float,
    /**
     * 卡头右侧是否写用量。大字或窄卡时让出位置，保证「+N 个窗口」不被挤掉（用量仍在读屏里）。
     */
    val showUsage: Boolean = true
)

internal object WidgetQuotaBarsMetrics {
    const val HEADER_DP = 20f
    const val ROW_DP = 28f
    const val ROUTING_DP = 20f
    /** 内容宽度不足这个值（× 字号）时不写倒计时。 */
    const val RESET_MIN_WIDTH_DP = 220f
    /** 内容宽度不足这个值（× 字号）时卡头不写用量。 */
    const val USAGE_MIN_WIDTH_DP = 170f
}

internal fun widgetQuotaBarsLayout(
    widthDp: Float,
    heightDp: Float,
    fontScale: Float,
    rows: List<WidgetQuotaBarRow>,
    routingRequested: Boolean
): WidgetQuotaBarsLayout {
    val scale = if (fontScale.isFinite()) fontScale.coerceAtLeast(1f) else 1f
    if (!widthDp.isFinite() || !heightDp.isFinite()) {
        return WidgetQuotaBarsLayout(false, emptyList(), rows.size, false, false, 0f)
    }
    val innerWidth = WidgetMetrics.innerWidthDp(widthDp)
    val innerHeight = WidgetMetrics.innerHeightDp(heightDp)
    val rowHeight = WidgetQuotaBarsMetrics.ROW_DP * scale
    val header = WidgetQuotaBarsMetrics.HEADER_DP * scale
    val routing = WidgetQuotaBarsMetrics.ROUTING_DP * scale

    fun slots(budget: Float): Int = floor(budget / rowHeight).toInt().coerceAtLeast(0)

    // 先保额度：路由行只在至少还能放下一行额度时出现。
    var showRouting = routingRequested
    var available = innerHeight - header - if (showRouting) routing else 0f
    if (showRouting && slots(available) < 1 && rows.isNotEmpty()) {
        showRouting = false
        available = innerHeight - header
    }
    // 放不下的窗口数写在卡头标题后面（「订阅额度 · +3 个窗口」），不额外占一行。
    val count = minOf(rows.size, slots(available))
    val enoughWidth = innerWidth >= 120f * scale
    val sufficient = enoughWidth && (rows.isEmpty() || count >= 1)
    if (!sufficient) return WidgetQuotaBarsLayout(false, emptyList(), rows.size, false, false, rowHeight)
    val visible = rows.sortedBy { it.rank }.take(count).sortedWith(compareBy({ it.groupOrder }, { it.rank }))
    return WidgetQuotaBarsLayout(
        sufficient = true,
        visible = visible,
        hiddenCount = rows.size - visible.size,
        showReset = innerWidth >= WidgetQuotaBarsMetrics.RESET_MIN_WIDTH_DP * scale,
        showRouting = showRouting,
        rowHeightDp = rowHeight,
        showUsage = innerWidth >= WidgetQuotaBarsMetrics.USAGE_MIN_WIDTH_DP * scale
    )
}

internal fun formatHiddenQuotaWindows(count: Int): String? = count.takeIf { it > 0 }?.let { "+$it 个窗口" }
