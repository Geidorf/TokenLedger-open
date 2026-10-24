package com.jeidorf.tokenledger.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane
import com.jeidorf.tokenledger.mobile.ui.navigation.MobileDestination
import com.jeidorf.tokenledger.mobile.ui.routing.LocalRoutingFeedOverride
import com.jeidorf.tokenledger.mobile.ui.routing.RoutingPreviewKind
import com.jeidorf.tokenledger.mobile.ui.routing.routingPreviewFeed

/**
 * 性能探针（只在 QA 构建里有，`-Ptokenledger.qa=true`）：用预览夹具直接画看板，不登录、不联网，
 * 供 android-perf-probe workflow 在模拟器上测首帧、滚动掉帧与路由动画帧率。
 *
 * `--es screen requests`（默认）：「用量 › 请求」，明细扩到 [REQUEST_ROWS] 行，用来测滚动。
 * `--es screen routing`：「路由」页实时夹具，有在途请求，虚线一直在流动，用来测动画帧率。
 */
class PerfProbeActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val screen = intent.getStringExtra(EXTRA_SCREEN) ?: SCREEN_REQUESTS
        setContent {
            when (screen) {
                SCREEN_ROUTING -> CompositionLocalProvider(
                    LocalRoutingFeedOverride provides routingPreviewFeed(RoutingPreviewKind.Live)
                ) {
                    LedgerDashboardPreviewHost(appearance = LedgerAppearance.Dark, destination = MobileDestination.Routing)
                }
                else -> LedgerDashboardPreviewHost(
                    appearance = LedgerAppearance.Dark,
                    state = perfProbeRequestsFixture(),
                    destination = MobileDestination.Usage,
                    insightPane = InsightPane.Details
                )
            }
        }
    }

    private companion object {
        const val EXTRA_SCREEN = "screen"
        const val SCREEN_REQUESTS = "requests"
        const val SCREEN_ROUTING = "routing"
        const val REQUEST_ROWS = 240

        /** 把预览夹具里的 4 条明细按小时往前铺成 [REQUEST_ROWS] 行，键（时间 + ID）各不相同。 */
        fun perfProbeRequestsFixture(): DashboardUiState {
            val base = ledgerSnapshotFixture()
            val stats = requireNotNull(base.data)
            val seed = stats.history
            val start = java.time.OffsetDateTime.parse("2026-07-15T12:42:00+08:00")
            val rows = List(REQUEST_ROWS) { index ->
                seed[index % seed.size].copy(
                    id = 10_000L + index,
                    timestamp = start.minusMinutes(17L * index).toString(),
                    sessionId = "session-${10_000 + index}"
                )
            }
            val page = requireNotNull(stats.detailsPage).copy(items = rows, totalCount = rows.size.toLong())
            return base.copy(data = stats.copy(history = rows, detailsPage = page))
        }
    }
}
