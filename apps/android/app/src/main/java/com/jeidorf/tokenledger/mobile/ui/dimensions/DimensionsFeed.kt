package com.jeidorf.tokenledger.mobile.ui.dimensions

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.DashboardQueryContract
import com.jeidorf.tokenledger.mobile.MobileSession
import com.jeidorf.tokenledger.mobile.dimensions.DimensionsReadFailure
import com.jeidorf.tokenledger.mobile.dimensions.UsageDimensions
import com.jeidorf.tokenledger.mobile.dimensions.UsageDimensionsRepository
import com.jeidorf.tokenledger.mobile.dimensions.UsageDimensionsSource
import com.jeidorf.tokenledger.mobile.ui.rhythm.cloudFeedRequestKey
import kotlinx.coroutines.CancellationException

/** 云端用量维度（会话、账号、Context 构成）；[dimensions] 与 [failure] 互斥，都为空表示正在读。 */
internal data class DimensionsFeed(
    val signedIn: Boolean,
    val dimensions: UsageDimensions? = null,
    val failure: DimensionsReadFailure? = null,
    val retry: () -> Unit = {}
) {
    val loading: Boolean get() = signedIn && dimensions == null && failure == null
}

/** 截图与预览注入固定的用量维度，不发网络请求。 */
internal val LocalDimensionsFeedOverride = staticCompositionLocalOf<DimensionsFeed?> { null }

/**
 * 只在用到它的子页可见时读；查询（范围、筛选）或账号变了就重读。换查询时先清空旧结果，
 * 不把上一个范围的结果当成这个范围的。
 */
@Composable
internal fun rememberDimensionsFeed(
    session: MobileSession?,
    query: DashboardQuery,
    active: Boolean,
    refreshKey: Any? = null,
    source: UsageDimensionsSource = remember { UsageDimensionsRepository() }
): DimensionsFeed {
    LocalDimensionsFeedOverride.current?.let { return it }
    val userId = session?.userId
    var attempt by remember { mutableIntStateOf(0) }
    var feed by remember(userId, query) { mutableStateOf(DimensionsFeed(signedIn = session != null)) }
    // 与节律同一把请求键：看板刷新、跨日、换时区都会重读。
    val key = cloudFeedRequestKey(userId, query, refreshKey, attempt)
    LaunchedEffect(active, key) {
        if (!active || session == null) return@LaunchedEffect
        feed = DimensionsFeed(signedIn = true)
        feed = try {
            val canonical = DashboardQueryContract.canonical(query, key.timezone)
            DimensionsFeed(signedIn = true, dimensions = source.fetch(session, canonical))
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (error: Throwable) {
            DimensionsFeed(signedIn = true, failure = DimensionsReadFailure.classify(error))
        }
    }
    return feed.copy(retry = { attempt++ })
}
