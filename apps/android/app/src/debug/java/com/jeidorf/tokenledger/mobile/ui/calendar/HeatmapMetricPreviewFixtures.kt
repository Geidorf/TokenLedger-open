package com.jeidorf.tokenledger.mobile.ui.calendar

import com.jeidorf.tokenledger.mobile.RangeKey
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.ledgerSnapshotFixture

/**
 * 日历指标切换的截图夹具：在通用快照上补 §2.6 的逐日记录数与费用（按 Token 量换算，
 * 只为看色阶与文案）；[withCost] 为 false 时模拟云端因某天缺估价而整项省略费用。
 */
internal fun heatmapMetricPreviewStats(withCost: Boolean = true): StatsData? {
    val stats = ledgerSnapshotFixture(range = RangeKey.Month).visibleData ?: return null
    return stats.copy(
        heatmapRequests = stats.heatmap.mapValues { (_, tokens) -> if (tokens > 0L) maxOf(1L, tokens / 4_000L) else 0L },
        heatmapCost = if (withCost) stats.heatmap.mapValues { (_, tokens) -> tokens * 0.000_003 } else null
    )
}
