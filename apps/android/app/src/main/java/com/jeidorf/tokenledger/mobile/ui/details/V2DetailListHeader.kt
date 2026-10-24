package com.jeidorf.tokenledger.mobile.ui.details

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.UsageDetailsPage
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.v2CacheHit
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens

internal data class DetailListSummary(val totals: String, val cacheReuse: String?)

/**
 * 请求列表上方的一行合计（重构 R2，对齐参考设计）：左边「N 条记录 · X 有效 Token」，右边缓存复用率。
 * 数字取自明细接口按当前筛选与搜索回传的 `filteredSummary`，和下面列出的行是同一口径；
 * 没有明细页（旧端只回 history）时不显示，避免拿全局汇总冒充筛选后的合计。
 */
internal fun detailListSummary(page: UsageDetailsPage?, mode: TokenDisplayMode): DetailListSummary? {
    page ?: return null
    val summary = page.filteredSummary
    val tokens = displayedTokenCount(mode, summary.effectiveTokens, summary.cachedTokens)
    val totals = "${v2FormatNumber(summary.totalRequests)} 条记录 · ${v2FormatTokens(tokens)} ${mode.label} Token"
    val rate = v2CacheHit(summary).takeUnless { it == "—" || it == "不可得" }
    return DetailListSummary(totals, rate?.let { "缓存复用 $it" })
}

@Composable
internal fun V2DetailListHeader(palette: MobileV2Palette, summary: DetailListSummary) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = LedgerSpace.xs)
            .semantics(mergeDescendants = true) { },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LedgerSpace.sm)
    ) {
        Text(
            summary.totals,
            color = palette.muted,
            style = LedgerType.meta,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f)
        )
        summary.cacheReuse?.let {
            Text(it, color = palette.faint, style = LedgerType.meta, maxLines = 1)
        }
    }
}
