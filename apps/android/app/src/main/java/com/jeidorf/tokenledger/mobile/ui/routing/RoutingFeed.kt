package com.jeidorf.tokenledger.mobile.ui.routing

import android.os.SystemClock
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.jeidorf.tokenledger.mobile.MobileSession
import com.jeidorf.tokenledger.mobile.routing.RoutingReadFailure
import com.jeidorf.tokenledger.mobile.routing.RoutingRepository
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshotSource
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshotsResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** 路由页读到的快照，以及读的时刻（用来把服务器时间往前推，不依赖手机时钟）。 */
internal data class RoutingFeed(
    val signedIn: Boolean,
    val result: RoutingSnapshotsResult? = null,
    /** 读到 [result] 时的 `SystemClock.elapsedRealtime()`。 */
    val fetchedAtElapsedMs: Long = 0L,
    val failure: RoutingReadFailure? = null,
    /** 截图与预览用：固定的服务器时间，不随时钟走。 */
    val fixedNowServerMs: Long? = null
) {
    val loading: Boolean get() = signedIn && result == null && failure == null
}

/** 截图与预览注入固定的快照，不发网络请求。 */
internal val LocalRoutingFeedOverride = staticCompositionLocalOf<RoutingFeed?> { null }

/** 快照每 5 秒读一次（契约 §5）；云端没部署读取函数时放慢到 1 分钟，免得空转。 */
private const val POLL_MS = 5_000L
private const val POLL_NOT_DEPLOYED_MS = 60_000L

/**
 * 只在路由页可见、应用在前台时轮询。换账号时清空旧结果；读失败保留上一份结果，
 * 由页面按「多久之前」如实显示，不把旧快照当新的。
 */
@Composable
internal fun rememberRoutingFeed(
    session: MobileSession?,
    active: Boolean,
    source: RoutingSnapshotSource = remember { RoutingRepository() }
): RoutingFeed {
    LocalRoutingFeedOverride.current?.let { return it }
    val userId = session?.userId
    var feed by remember(userId) { mutableStateOf(RoutingFeed(signedIn = session != null)) }
    val currentSession by rememberUpdatedState(session)
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(active, userId, lifecycleOwner) {
        if (!active || userId == null) return@LaunchedEffect
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                val current = currentSession ?: break
                feed = try {
                    val result = source.fetch(current)
                    feed.copy(signedIn = true, result = result, fetchedAtElapsedMs = SystemClock.elapsedRealtime(), failure = null)
                } catch (cancel: CancellationException) {
                    throw cancel
                } catch (error: Throwable) {
                    feed.copy(signedIn = true, failure = RoutingReadFailure.classify(error))
                }
                delay(if (feed.failure == RoutingReadFailure.NotDeployed) POLL_NOT_DEPLOYED_MS else POLL_MS)
            }
        }
    }
    return feed
}

/** 手机此刻对应的服务器时间；页面可见时每秒走一次，让「N 秒前」与离线判断跟上。 */
@Composable
internal fun rememberRoutingServerNow(feed: RoutingFeed): Long {
    feed.fixedNowServerMs?.let { return it }
    val result = feed.result ?: return 0L
    var elapsed by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(feed.fetchedAtElapsedMs) {
        while (true) {
            elapsed = SystemClock.elapsedRealtime()
            delay(1_000L)
        }
    }
    return result.serverTimeMs + (elapsed - feed.fetchedAtElapsedMs).coerceAtLeast(0L)
}
