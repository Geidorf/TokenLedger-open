package com.jeidorf.tokenledger.mobile.tile

import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.quotaAvailableAccessibilityLabel
import com.jeidorf.tokenledger.mobile.widget.WidgetQuotaBarRow
import com.jeidorf.tokenledger.mobile.widget.WidgetState
import com.jeidorf.tokenledger.mobile.widget.WidgetUsage
import com.jeidorf.tokenledger.mobile.widget.formatCny
import com.jeidorf.tokenledger.mobile.widget.formatWidgetWindowLabel
import com.jeidorf.tokenledger.mobile.widget.widgetShortProviderName

/**
 * 快捷设置磁贴（[LedgerQuickTileService]）显示什么。纯逻辑，便于 JVM 单测。
 *
 * 口径与额度条小组件相同（REQ-WIDGET-02）：写「可用 N%」，N = 100 − round(已用)；挑「最紧」的那个
 * 窗口 = 当前可用百分比最小的正常窗口，平手按额度条的截断优先级（主窗口在前）。没有正常窗口时退到
 * 历史窗口并写「历史」，再没有就写今日预估费用；都没有就如实写「暂无数据」，不补 0。
 * 数据只读应用与后台刷新写下的本地缓存（来自云端），磁贴自己不联网、不碰任何密钥。
 */
internal data class QuickTileContent(
    /** 磁贴主行。 */
    val label: String,
    /** 磁贴副行（Android 10 起才显示）；不支持副行时主行已经把来源带上。 */
    val subtitle: String?,
    /** 有一个能说清的数时点亮，否则显示为未激活。 */
    val active: Boolean,
    /** 读屏的状态描述（Android 11 起）。 */
    val stateDescription: String
)

internal fun quickTileContent(
    state: WidgetState,
    costMasked: Boolean,
    supportsSubtitle: Boolean = true,
    /** 本地今天零点；给出时，零点前写入缓存的「今日」费用不再当作今天的数（跨天后手机离线或令牌过期）。 */
    todayStartEpochMs: Long? = null
): QuickTileContent {
    val ready = when (state) {
        WidgetState.NeedLogin -> return QuickTileContent(
            label = "TokenLedger",
            subtitle = "未登录",
            active = false,
            stateDescription = "未登录，点按打开 TokenLedger 登录"
        )
        WidgetState.NoData -> return noData()
        is WidgetState.Ready -> state
    }
    val usage = ready.usage?.takeIf {
        it.range == com.jeidorf.tokenledger.mobile.widget.WidgetRange.Today && isCurrentDay(it, todayStartEpochMs)
    }
    val cost = usage?.let { "今日 ${formatCny(it.costCny, costMasked)}" }
    val tightest = tightestQuotaRow(ready.quota?.rows.orEmpty())
    if (tightest != null) {
        val percent = tightest.availablePercent ?: return noData()
        val stale = tightest.status == QuotaProviderStatus.Stale
        val value = if (stale) "历史 $percent%" else "可用 $percent%"
        val source = quickTileSourceName(tightest)
        val sub = listOfNotNull(source, if (stale) "待刷新" else null, cost).joinToString(" · ")
        val spoken = buildList {
            add(source)
            add(if (stale) "历史数据，可用 $percent%" else quotaAvailableAccessibilityLabel(percent))
            tightest.resetText?.let(::add)
            usage?.let { add(costSpoken(it, costMasked)) }
        }.joinToString("，")
        return if (supportsSubtitle) {
            QuickTileContent(value, sub, active = !stale, stateDescription = spoken)
        } else {
            QuickTileContent("$source $value", null, active = !stale, stateDescription = spoken)
        }
    }
    if (usage != null && cost != null) {
        return QuickTileContent(
            label = cost,
            subtitle = if (supportsSubtitle) "额度未同步" else null,
            active = true,
            stateDescription = costSpoken(usage, costMasked) + "，额度未同步"
        )
    }
    return noData()
}

/** 最紧的窗口：先正常窗口里可用最少的，没有再看历史窗口；平手按额度条的截断优先级。 */
internal fun tightestQuotaRow(rows: List<WidgetQuotaBarRow>): WidgetQuotaBarRow? {
    val order = compareBy<WidgetQuotaBarRow>({ it.availablePercent }, { it.rank })
    return rows.filter { it.status == QuotaProviderStatus.Ok && it.availablePercent != null }.minWithOrNull(order)
        ?: rows.filter { it.status == QuotaProviderStatus.Stale && it.availablePercent != null }.minWithOrNull(order)
}

/** 「Claude 5 小时」「Codex 替代·每周」。 */
internal fun quickTileSourceName(row: WidgetQuotaBarRow): String = listOfNotNull(
    widgetShortProviderName(row.providerName),
    row.windowLabel?.let { formatWidgetWindowLabel(it, row.roleSubstitute) }
).joinToString(" ")

private fun isCurrentDay(usage: WidgetUsage, todayStartEpochMs: Long?): Boolean {
    if (todayStartEpochMs == null) return true
    val savedAt = usage.savedAtEpochMillis ?: return false
    return savedAt >= todayStartEpochMs
}

private fun costSpoken(usage: WidgetUsage, costMasked: Boolean): String =
    if (costMasked) "今日预估费用已隐藏" else "今日预估费用 ${formatCny(usage.costCny)}"

private fun noData() = QuickTileContent(
    label = "TokenLedger",
    subtitle = "暂无数据",
    active = false,
    stateDescription = "暂无数据，点按打开 TokenLedger 同步"
)

/** 后台要预取的统计范围：各小组件实例的范围；磁贴写「今日」费用，加进通知栏后就带上今日。 */
internal fun widgetRefreshRanges(active: Set<RangeKey>, tileAdded: Boolean): Set<RangeKey> {
    val ranges = if (tileAdded) active + RangeKey.Today else active
    return ranges.ifEmpty { setOf(RangeKey.Today) }
}
