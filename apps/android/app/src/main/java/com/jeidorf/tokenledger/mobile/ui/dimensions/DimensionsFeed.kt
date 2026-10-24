package com.jeidorf.tokenledger.mobile.ui.dimensions

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import com.jeidorf.tokenledger.mobile.DashboardQuery
import com.jeidorf.tokenledger.mobile.DashboardQueryContract
import com.jeidorf.tokenledger.mobile.DashboardRepository
import com.jeidorf.tokenledger.mobile.MobileSession
import com.jeidorf.tokenledger.mobile.SessionRevokedException
import com.jeidorf.tokenledger.mobile.SupabaseHttpException
import com.jeidorf.tokenledger.mobile.isLegacyCustomRangeRejection
import com.jeidorf.tokenledger.mobile.dimensions.DimensionsAccountChangedException
import com.jeidorf.tokenledger.mobile.dimensions.DimensionsReadFailure
import com.jeidorf.tokenledger.mobile.dimensions.DimensionsSignedOutException
import com.jeidorf.tokenledger.mobile.dimensions.UsageDimensions
import com.jeidorf.tokenledger.mobile.dimensions.UsageDimensionsRepository
import com.jeidorf.tokenledger.mobile.dimensions.UsageDimensionsSource
import com.jeidorf.tokenledger.mobile.dimensions.dashboardDimensionsSessionReader
import com.jeidorf.tokenledger.mobile.dimensions.readForUi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

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
 * 只在用到它的子页可见时读；查询、刷新代次、时区或账号变了就重读。
 * 换请求身份时先清空旧结果，旧协程由 LaunchedEffect 取消，迟到结果不能写入新范围。
 */
@Composable
internal fun rememberDimensionsFeed(
    session: MobileSession?,
    query: DashboardQuery,
    active: Boolean,
    refreshKey: Any? = null,
    repository: DashboardRepository? = null,
    source: UsageDimensionsSource = remember { UsageDimensionsRepository() }
): DimensionsFeed {
    LocalDimensionsFeedOverride.current?.let { return it }
    val context = LocalContext.current.applicationContext
    val storedRepository = repository ?: remember(context) { DashboardRepository(context) }
    val reader = remember(storedRepository) { dashboardDimensionsSessionReader(storedRepository) }
    val userId = session?.userId
    val timezone = java.time.ZoneId.systemDefault().id.ifBlank { "UTC" }
    var attempt by remember { mutableIntStateOf(0) }
    var feed by remember(session, query, timezone, source, reader) {
        mutableStateOf(DimensionsFeed(signedIn = session != null))
    }
    val key = listOf(session, query, timezone, refreshKey, attempt, source, reader)
    LaunchedEffect(active, key) {
        if (!active || session == null || userId == null) return@LaunchedEffect
        feed = DimensionsFeed(signedIn = true)
        val next = try {
            val canonical = DashboardQueryContract.canonical(query, timezone)
            val dimensions = reader.readForUi(userId) { fresh ->
                source.fetch(fresh, canonical)
            }
            DimensionsFeed(signedIn = true, dimensions = dimensions)
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (error: Throwable) {
            DimensionsFeed(
                signedIn = error !is SessionRevokedException &&
                    error !is DimensionsAccountChangedException &&
                    error !is DimensionsSignedOutException,
                failure = if (error is SupabaseHttpException && error.isLegacyCustomRangeRejection()) {
                    DimensionsReadFailure.NotDeployed
                } else {
                    DimensionsReadFailure.classify(error)
                }
            )
        }
        currentCoroutineContext().ensureActive()
        feed = next
    }
    return feed.copy(retry = { attempt++ })
}
