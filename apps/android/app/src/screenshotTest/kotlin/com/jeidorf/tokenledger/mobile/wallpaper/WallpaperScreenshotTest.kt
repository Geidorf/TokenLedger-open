package com.jeidorf.tokenledger.mobile.wallpaper

import android.content.res.Configuration
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.routing.RoutingReadFailure
import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshots

// 锁屏动态壁纸：把 WallpaperModel 吃进固定快照后吐出的一帧交给 RoutingWallpaperRenderer，
// 画在与锁屏同尺寸的画布上。时间全部钉死（服务器时间与 elapsedRealtime 都由这里给），
// 不读墙上时钟、不发网络请求。名字与数字都是演示数据。

private const val SERVER_NOW = "2026-10-24T07:00:06Z"
private const val ACCOUNT = "preview-account"

private fun envelope(receivedAt: String, flows: String) = """
{"serverTime":"$SERVER_NOW","snapshots":[{"device":"0123456789abcdef0123456789abcdef","receivedAt":"$receivedAt",
 "snapshot":{"v":1,"generatedAt":"$receivedAt","sources":[{"id":"tokenledger","reachable":true},{"id":"external","reachable":true}],"flows":$flows}}]}
""".trimIndent()

/** 一条先 429 再改道成功的请求：播放时光点在第一跳回弹，停留时失败那条是危险色虚线。 */
private val FAILOVER_FLOW = """
 {"id":"00000000000000c1","source":"tokenledger","agent":"codex","via":"group/long-context","phase":"routed","at":"2026-10-24T07:00:04Z","hops":[{"target":"moonshot/kimi-k2","outcome":"failed","status":429},{"target":"zhipu/glm-4.6","outcome":"ok"}]}
""".trim()

private val LIVE_FLOWS = """
[
 {"id":"00000000000000c2","source":"external","agent":"claude-code","via":"group/long-context","phase":"inflight","at":"2026-10-24T07:00:01Z","waitingOn":"upstream","hops":[{"target":"deepseek/deepseek-chat","outcome":"pending"}]},
 $FAILOVER_FLOW,
 {"id":"00000000000000c3","source":"tokenledger","agent":"gemini","via":"group/long-context","phase":"done","at":"2026-10-24T06:59:31Z","hops":[{"target":"anthropic/claude-sonnet-4-5","outcome":"ok"}]},
 {"id":"00000000000000c4","source":"tokenledger","agent":"codex","via":"gpt-5","phase":"failed","at":"2026-10-24T06:58:12Z","hops":[{"target":"openai/gpt-5","outcome":"failed","status":503}]}
]
""".trimIndent()

internal enum class WallpaperPreviewKind { Playing, Lit, Offline, NoSnapshot, SignedOut, NotDeployed }

/** 按场景喂给壁纸状态机，返回要画的一帧与「此刻」。 */
private fun previewFrame(kind: WallpaperPreviewKind): Pair<WallpaperFrame, Long> {
    val model = WallpaperModel()
    fun ok(json: String) = WallpaperRead.Ok(RoutingSnapshots.parse(json), readAtElapsedMs = 0L, account = ACCOUNT)
    return when (kind) {
        WallpaperPreviewKind.Playing -> {
            model.accept(ok(envelope("2026-10-24T07:00:05Z", "[$FAILOVER_FLOW]")), 0L)
            // 第二段（网关 → 第一个成员）走到一半：光点在失败的那一跳上。
            val now = WallpaperTimeline.SEGMENT_MS + WallpaperTimeline.GAP_MS + WallpaperTimeline.SEGMENT_MS / 2
            model.frame(now, reduceMotion = false) to now
        }
        WallpaperPreviewKind.Lit -> {
            // 关闭动画时不跑光点，所有可播的流直接按结果点亮；在途请求照常画虚线。
            model.accept(ok(envelope("2026-10-24T07:00:03Z", LIVE_FLOWS)), 0L)
            model.frame(0L, reduceMotion = true) to 0L
        }
        WallpaperPreviewKind.Offline -> {
            model.accept(ok(envelope("2026-10-24T06:53:00Z", "[$FAILOVER_FLOW]".replace("07:00:04", "06:52:40"))), 0L)
            model.frame(0L, reduceMotion = false) to 0L
        }
        WallpaperPreviewKind.NoSnapshot -> {
            model.accept(ok("""{"serverTime":"$SERVER_NOW","snapshots":[]}"""), 0L)
            model.frame(0L, reduceMotion = false) to 0L
        }
        WallpaperPreviewKind.SignedOut -> {
            model.accept(WallpaperRead.SignedOut, 0L)
            model.frame(0L, reduceMotion = false) to 0L
        }
        WallpaperPreviewKind.NotDeployed -> {
            model.accept(WallpaperRead.Failed(RoutingReadFailure.NotDeployed, ACCOUNT), 0L)
            model.frame(0L, reduceMotion = false) to 0L
        }
    }
}

@Composable
private fun Wallpaper(kind: WallpaperPreviewKind, dark: Boolean = true) {
    val density = LocalDensity.current.density
    val renderer = remember(density, dark) { RoutingWallpaperRenderer(density).apply { setDark(dark) } }
    val (frame, now) = remember(kind) { previewFrame(kind) }
    Canvas(Modifier.fillMaxSize()) {
        drawIntoCanvas { renderer.draw(it.nativeCanvas, frame, now) }
    }
}

@PreviewTest
@Preview(name = "Wallpaper playing failover", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun WallpaperPlayingScreenshot() = Wallpaper(WallpaperPreviewKind.Playing)

@PreviewTest
@Preview(name = "Wallpaper lit reduced motion", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun WallpaperLitScreenshot() = Wallpaper(WallpaperPreviewKind.Lit)

@PreviewTest
@Preview(name = "Wallpaper lit light", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true, backgroundColor = 0xFFF4F5F7)
@Composable
fun WallpaperLitLightScreenshot() = Wallpaper(WallpaperPreviewKind.Lit, dark = false)

@PreviewTest
@Preview(name = "Wallpaper lit 320", device = "spec:width=320dp,height=720dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun WallpaperLitNarrowScreenshot() = Wallpaper(WallpaperPreviewKind.Lit)

@PreviewTest
@Preview(name = "Wallpaper desktop offline", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun WallpaperOfflineScreenshot() = Wallpaper(WallpaperPreviewKind.Offline)

@PreviewTest
@Preview(name = "Wallpaper no snapshot", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun WallpaperNoSnapshotScreenshot() = Wallpaper(WallpaperPreviewKind.NoSnapshot)

@PreviewTest
@Preview(name = "Wallpaper signed out", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun WallpaperSignedOutScreenshot() = Wallpaper(WallpaperPreviewKind.SignedOut)

@PreviewTest
@Preview(name = "Wallpaper not deployed", device = "spec:width=390dp,height=844dp,dpi=160", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true, backgroundColor = 0xFF08090C)
@Composable
fun WallpaperNotDeployedScreenshot() = Wallpaper(WallpaperPreviewKind.NotDeployed)
