package com.jeidorf.tokenledger.mobile.ui.rhythm

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
import com.jeidorf.tokenledger.mobile.rhythm.ActivityRhythm
import com.jeidorf.tokenledger.mobile.rhythm.ActivityRhythmRepository
import com.jeidorf.tokenledger.mobile.rhythm.ActivityRhythmSource
import com.jeidorf.tokenledger.mobile.rhythm.RhythmReadFailure
import java.time.ZoneId
import kotlinx.coroutines.CancellationException

/** 「会话」子页读到的活动节律；[rhythm] 与 [failure] 互斥，都为空表示正在读。 */
internal data class RhythmFeed(
    val signedIn: Boolean,
    val rhythm: ActivityRhythm? = null,
    val failure: RhythmReadFailure? = null,
    val retry: () -> Unit = {}
) {
    val loading: Boolean get() = signedIn && rhythm == null && failure == null
}

/** 截图与预览注入固定的节律，不发网络请求。 */
internal val LocalRhythmFeedOverride = staticCompositionLocalOf<RhythmFeed?> { null }

/**
 * 决定何时重读：账号、查询、时区或看板刷新代次（[refreshKey]，每次看板重新取数都会变）任何一个变了就重读，
 * 所以顶部刷新、下拉刷新、跨日与换时区都会让节律跟着更新，不用靠切页。
 */
internal data class CloudFeedRequestKey(
    val userId: String?,
    val query: DashboardQuery,
    val timezone: String,
    val refreshKey: Any?,
    val attempt: Int
)

internal fun cloudFeedRequestKey(
    userId: String?,
    query: DashboardQuery,
    refreshKey: Any?,
    attempt: Int,
    timezone: String = ZoneId.systemDefault().id.ifBlank { "UTC" }
) = CloudFeedRequestKey(userId, query, timezone, refreshKey, attempt)

/**
 * 只在「会话」子页可见时读；[CloudFeedRequestKey] 变了就重读。换查询时先清空旧结果，
 * 不把上一个范围的节律当成这个范围的。
 */
@Composable
internal fun rememberRhythmFeed(
    session: MobileSession?,
    query: DashboardQuery,
    active: Boolean,
    refreshKey: Any? = null,
    source: ActivityRhythmSource = remember { ActivityRhythmRepository() }
): RhythmFeed {
    LocalRhythmFeedOverride.current?.let { return it }
    val userId = session?.userId
    var attempt by remember { mutableIntStateOf(0) }
    var feed by remember(userId, query) { mutableStateOf(RhythmFeed(signedIn = session != null)) }
    val key = cloudFeedRequestKey(userId, query, refreshKey, attempt)
    LaunchedEffect(active, key) {
        if (!active || session == null) return@LaunchedEffect
        feed = RhythmFeed(signedIn = true)
        feed = loadRhythmFeed(session, query, key.timezone, source)
    }
    return feed.copy(retry = { attempt++ })
}

/** 读一次节律；每次调用都真的去取，不缓存（缓存与否只由上面的请求键决定）。 */
internal suspend fun loadRhythmFeed(
    session: MobileSession,
    query: DashboardQuery,
    timezone: String,
    source: ActivityRhythmSource
): RhythmFeed = try {
    val canonical = DashboardQueryContract.canonical(query, timezone)
    RhythmFeed(signedIn = true, rhythm = source.fetch(session, canonical))
} catch (cancel: CancellationException) {
    throw cancel
} catch (error: Throwable) {
    RhythmFeed(signedIn = true, failure = RhythmReadFailure.classify(error))
}
