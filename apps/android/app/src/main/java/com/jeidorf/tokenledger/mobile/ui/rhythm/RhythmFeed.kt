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
 * 只在「会话」子页可见时读；查询（范围、筛选）或账号变了就重读。换查询时先清空旧结果，
 * 不把上一个范围的节律当成这个范围的。
 */
@Composable
internal fun rememberRhythmFeed(
    session: MobileSession?,
    query: DashboardQuery,
    active: Boolean,
    source: ActivityRhythmSource = remember { ActivityRhythmRepository() }
): RhythmFeed {
    LocalRhythmFeedOverride.current?.let { return it }
    val userId = session?.userId
    var attempt by remember { mutableIntStateOf(0) }
    var feed by remember(userId, query) { mutableStateOf(RhythmFeed(signedIn = session != null)) }
    LaunchedEffect(active, userId, query, attempt) {
        if (!active || session == null) return@LaunchedEffect
        feed = RhythmFeed(signedIn = true)
        feed = try {
            val canonical = DashboardQueryContract.canonical(query, ZoneId.systemDefault().id.ifBlank { "UTC" })
            RhythmFeed(signedIn = true, rhythm = source.fetch(session, canonical))
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (error: Throwable) {
            RhythmFeed(signedIn = true, failure = RhythmReadFailure.classify(error))
        }
    }
    return feed.copy(retry = { attempt++ })
}
