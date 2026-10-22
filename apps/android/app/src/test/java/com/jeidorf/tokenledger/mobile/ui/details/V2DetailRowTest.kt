package com.jeidorf.tokenledger.mobile.ui.details

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * T10.175：云端明细按小时聚合上传，`session_id` 固定为 `"agg"`（T10.172 P1-3），
 * 会话 ID 与「按此会话过滤」对这类行没有意义。覆盖标题改名、云端行不出现会话过滤、
 * 以及行点击的 TalkBack 提示写清会打开什么；本机若存在非 `"hour"` 粒度的真实会话，
 * 三者都应保持改动前的会话详情行为。
 */
class V2DetailRowTest {

    @Test
    fun cloudHourlyGranularityRenamesDialogToHourlyAggregateRecord() {
        assertEquals("小时聚合记录", v2DetailDialogTitle("hour"))
        // 详情 v2 RPC 与旧三参回退大小写可能不同，判断需要不区分大小写。
        assertEquals("小时聚合记录", v2DetailDialogTitle("HOUR"))
    }

    @Test
    fun nonCloudGranularityKeepsOriginalSessionDialogTitle() {
        assertEquals("会话详情", v2DetailDialogTitle("request"))
        assertEquals("会话详情", v2DetailDialogTitle(""))
    }

    @Test
    fun cloudHourlyGranularityReplacesSessionIdWithAggregateNotice() {
        assertEquals("云端按小时聚合，不含单次会话", v2DetailAggregateNotice("hour"))
    }

    @Test
    fun nonCloudGranularityHasNoAggregateNoticeSoSessionIdStillShows() {
        assertNull(v2DetailAggregateNotice("request"))
    }

    @Test
    fun cloudHourlyGranularityNeverShowsSessionFilterEvenWithHandlerAndSessionId() {
        assertFalse(v2DetailShowSessionFilter(granularity = "hour", sessionId = "agg", hasFilterHandler = true))
        // 聚合行有时会话 ID 非空（真实历史数据），仍然不该出现过滤入口。
        assertFalse(v2DetailShowSessionFilter(granularity = "hour", sessionId = "not-blank", hasFilterHandler = true))
    }

    @Test
    fun nonCloudGranularityKeepsSessionFilterWhenHandlerAndSessionIdPresent() {
        assertTrue(v2DetailShowSessionFilter(granularity = "request", sessionId = "real-session", hasFilterHandler = true))
    }

    @Test
    fun nonCloudGranularityStillRequiresHandlerAndNonBlankSessionId() {
        assertFalse(v2DetailShowSessionFilter(granularity = "request", sessionId = "real-session", hasFilterHandler = false))
        assertFalse(v2DetailShowSessionFilter(granularity = "request", sessionId = "", hasFilterHandler = true))
    }

    @Test
    fun rowClickAccessibilityLabelStatesHourlyAggregateRecordForCloudRows() {
        assertEquals("打开小时聚合记录", v2DetailRowClickLabel("hour"))
    }

    @Test
    fun rowClickAccessibilityLabelStatesSessionDetailForNonCloudRows() {
        assertEquals("打开会话详情", v2DetailRowClickLabel("request"))
    }
}
