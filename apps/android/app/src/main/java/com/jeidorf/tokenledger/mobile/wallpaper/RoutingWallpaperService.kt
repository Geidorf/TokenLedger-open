package com.jeidorf.tokenledger.mobile.wallpaper

import android.animation.ValueAnimator
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.service.wallpaper.WallpaperService
import android.view.SurfaceHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 锁屏（与桌面）动态壁纸：近实时显示电脑端网关的路由动画，数据经云端中转
 * （docs/contracts/routing-snapshot-v1.md）。
 *
 * 省电：
 * - 只在壁纸可见时每 [POLL_MS] 读一次云端；不可见时不读、不画。
 * - 只有光点在跑或有在途请求时才逐帧重画（[FramePacer]），其余时间画一次就停。
 * - 系统关闭动画（减少动态效果）或开着省电模式时只显示点亮状态与说明，不逐帧重画。
 */
class RoutingWallpaperService : WallpaperService() {
    override fun onCreateEngine(): Engine = RoutingEngine()

    private inner class RoutingEngine : Engine() {
        private val handler = Handler(Looper.getMainLooper())
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        private val model = WallpaperModel()
        private val reader by lazy { WallpaperReader(applicationContext) }
        private val renderer = RoutingWallpaperRenderer(resources.displayMetrics.density)
        private var pollJob: Job? = null
        private var visible = false
        private val powerManager by lazy { getSystemService(PowerManager::class.java) }
        /** 省电模式；可见时与每次读云端时刷新，不在逐帧里查。 */
        private var powerSave = false
        private val drawRunnable = Runnable { drawFrame() }

        override fun onCreate(surfaceHolder: SurfaceHolder) {
            super.onCreate(surfaceHolder)
            setTouchEventsEnabled(false)
            applyTheme()
        }

        override fun onVisibilityChanged(visible: Boolean) {
            this.visible = visible
            if (visible) {
                applyTheme()
                refreshPowerSave()
                startPolling()
                drawFrame()
            } else {
                stopPolling()
                handler.removeCallbacks(drawRunnable)
            }
        }

        override fun onSurfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
            super.onSurfaceChanged(holder, format, width, height)
            drawFrame()
        }

        override fun onSurfaceDestroyed(holder: SurfaceHolder) {
            visible = false
            stopPolling()
            handler.removeCallbacks(drawRunnable)
            super.onSurfaceDestroyed(holder)
        }

        override fun onDestroy() {
            handler.removeCallbacks(drawRunnable)
            scope.cancel()
            super.onDestroy()
        }

        private fun applyTheme() {
            val night = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
            // 锁屏多半是深色；只有系统明确是浅色模式时才用浅色。
            renderer.setDark(night != Configuration.UI_MODE_NIGHT_NO)
        }

        private fun startPolling() {
            if (pollJob?.isActive == true) return
            pollJob = scope.launch {
                while (isActive) {
                    val read = withContext(Dispatchers.IO) { reader.read() }
                    model.accept(read, SystemClock.elapsedRealtime())
                    refreshPowerSave()
                    drawFrame()
                    delay(POLL_MS)
                }
            }
        }

        private fun refreshPowerSave() {
            powerSave = powerManager?.isPowerSaveMode == true
        }

        private fun stopPolling() {
            pollJob?.cancel()
            pollJob = null
        }

        private fun drawFrame() {
            handler.removeCallbacks(drawRunnable)
            if (!visible) return
            val now = SystemClock.elapsedRealtime()
            val reduceMotion = !ValueAnimator.areAnimatorsEnabled() || powerSave
            val frame = model.frame(now, reduceMotion)
            val holder = surfaceHolder
            val canvas = try {
                holder.lockCanvas()
            } catch (_: IllegalStateException) {
                null
            } ?: return
            try {
                renderer.draw(canvas, frame, now)
            } finally {
                runCatching { holder.unlockCanvasAndPost(canvas) }
            }
            val next = FramePacer.nextFrameDelay(
                FramePacer.Activity(
                    visible = visible,
                    reduceMotion = reduceMotion,
                    powerSave = powerSave,
                    playing = frame.playing,
                    inflight = frame.inflight,
                    nextLingerEndMs = frame.nextLingerEndMs,
                )
            )
            if (next != null) handler.postDelayed(drawRunnable, next)
        }
    }

    private companion object {
        /** 契约 §5：可见时每 5 秒读一次。 */
        const val POLL_MS = 5_000L
    }
}
