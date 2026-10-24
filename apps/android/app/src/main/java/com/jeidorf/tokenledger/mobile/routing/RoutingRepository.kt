package com.jeidorf.tokenledger.mobile.routing

import com.jeidorf.tokenledger.mobile.BuildConfig
import com.jeidorf.tokenledger.mobile.DashboardRepository
import com.jeidorf.tokenledger.mobile.MobileSession
import com.jeidorf.tokenledger.mobile.ROUTING_SNAPSHOTS_READ_FUNCTION
import com.jeidorf.tokenledger.mobile.SupabaseGateway
import com.jeidorf.tokenledger.mobile.SupabaseHttpException
import com.jeidorf.tokenledger.mobile.isMissingRpcSignature

/** 读取实时路由快照。路由页与锁屏动态壁纸共用；测试里换成假实现。 */
fun interface RoutingSnapshotSource {
    suspend fun fetch(session: MobileSession): RoutingSnapshotsResult
}

class RoutingRepository(
    private val gateway: SupabaseGateway = SupabaseGateway(
        supabaseUrl = BuildConfig.TOKENLEDGER_SUPABASE_URL,
        publishableKey = BuildConfig.TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY
    )
) : RoutingSnapshotSource {
    override suspend fun fetch(session: MobileSession): RoutingSnapshotsResult =
        RoutingSnapshots.parse(gateway.fetchRoutingSnapshots(session))
}

/**
 * 用 App 已保存的登录读快照：与看板共用同一个 SessionAuthority，访问令牌快到期或被拒（401）时续期一次。
 * 返回 null 表示手机上没有登录。锁屏动态壁纸在后台读取时用它，不依赖用量页先刷新。
 */
suspend fun RoutingSnapshotSource.fetchWithStoredSession(dashboard: DashboardRepository): RoutingSnapshotsResult? =
    dashboard.readWithStoredSession { session -> fetch(session) }

/** 读取失败的原因，决定页面上怎么说。 */
enum class RoutingReadFailure {
    /** 云端还没部署 routing-snapshot-v1 的读取函数。 */
    NotDeployed,
    /** 登录凭据过期或被拒；用量页刷新会续期。 */
    Unauthorized,
    /** 返回体不符合契约。 */
    BadFormat,
    /** 网络或服务暂时不可用。 */
    Unavailable;

    companion object {
        fun classify(error: Throwable): RoutingReadFailure = when {
            error is RoutingSnapshotFormatException -> BadFormat
            error is SupabaseHttpException && error.isMissingRpcSignature(ROUTING_SNAPSHOTS_READ_FUNCTION) -> NotDeployed
            error is SupabaseHttpException && (error.status == 401 || error.status == 403) -> Unauthorized
            else -> Unavailable
        }
    }
}
