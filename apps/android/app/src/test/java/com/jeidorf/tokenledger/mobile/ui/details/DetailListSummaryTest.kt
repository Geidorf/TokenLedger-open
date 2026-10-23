package com.jeidorf.tokenledger.mobile.ui.details

import com.jeidorf.tokenledger.mobile.AvailableFilters
import com.jeidorf.tokenledger.mobile.Summary
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.UsageDetailsPage
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 请求列表上方的合计行：口径跟随筛选后的 filteredSummary 与当前 Token 口径，缓存拆分不可证明时不写复用率。 */
class DetailListSummaryTest {

    private fun page(summary: Summary) = UsageDetailsPage(
        items = emptyList(),
        nextCursor = null,
        hasMore = false,
        totalCount = 0,
        filteredSummary = summary,
        availableFilters = AvailableFilters()
    )

    private val split = Summary(
        inputTokens = 200_000,
        outputTokens = 50_000,
        cachedTokens = 800_000,
        cacheReadTokens = 800_000,
        cacheWriteTokens = 0,
        totalRequests = 412
    )

    @Test
    fun noDetailsPageMeansNoHeader() {
        assertNull(detailListSummary(null, TokenDisplayMode.Effective))
    }

    @Test
    fun effectiveModeCountsInputPlusOutput() {
        val result = detailListSummary(page(split), TokenDisplayMode.Effective)!!
        assertEquals("412 条记录 · ${v2FormatTokens(250_000)} 有效 Token", result.totals)
        assertEquals("缓存复用 80%", result.cacheReuse)
    }

    @Test
    fun allModeAddsCachedTokens() {
        val result = detailListSummary(page(split), TokenDisplayMode.All)!!
        assertEquals("412 条记录 · ${v2FormatTokens(1_050_000)} 含缓存 Token", result.totals)
    }

    @Test
    fun unknownCacheSplitOmitsReuseRate() {
        val result = detailListSummary(
            page(Summary(inputTokens = 10, outputTokens = 5, cachedTokens = 30, totalRequests = 3)),
            TokenDisplayMode.Effective
        )!!
        assertNull(result.cacheReuse)
    }
}
