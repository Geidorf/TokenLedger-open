package com.jeidorf.tokenledger.mobile.wallpaper

import android.content.Context
import android.os.SystemClock
import com.jeidorf.tokenledger.mobile.DashboardAuthExpiredException
import com.jeidorf.tokenledger.mobile.DashboardRepository
import com.jeidorf.tokenledger.mobile.SessionRevokedException
import com.jeidorf.tokenledger.mobile.routing.RoutingReadFailure
import com.jeidorf.tokenledger.mobile.routing.RoutingRepository
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshotSource
import com.jeidorf.tokenledger.mobile.routing.fetchWithStoredSession
import kotlinx.coroutines.CancellationException

/**
 * 壁纸读快照：用 App 已保存的登录（与看板共用同一个 SessionAuthority，需要时续期），
 * 读 `get_routing_snapshots_v1`。壁纸 Service 不碰会话细节。
 */
internal class WallpaperReader(
    context: Context,
    private val repository: DashboardRepository = DashboardRepository(context),
    private val source: RoutingSnapshotSource = RoutingRepository(),
) {
    suspend fun read(): WallpaperRead {
        if (!repository.isConfigured) return WallpaperRead.NotConfigured
        return try {
            val result = source.fetchWithStoredSession(repository) ?: return WallpaperRead.SignedOut
            WallpaperRead.Ok(result, SystemClock.elapsedRealtime())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: SessionRevokedException) {
            WallpaperRead.SignedOut
        } catch (_: DashboardAuthExpiredException) {
            WallpaperRead.Failed(RoutingReadFailure.Unauthorized)
        } catch (error: Exception) {
            WallpaperRead.Failed(RoutingReadFailure.classify(error))
        }
    }
}
