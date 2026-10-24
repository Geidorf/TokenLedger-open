package com.jeidorf.tokenledger.mobile.wallpaper

/**
 * 省电帧率：只有真有东西在动时才逐帧重画。
 *
 * - 光点在跑（新出现的流正在播放）：30 fps，光点要顺。
 * - 只有在途请求（虚线流动、网关脉冲）：12 fps，虚线 0.7 秒一周期，低帧率看起来仍连贯。
 * - 只剩停留中的点亮连线：不逐帧，等停留结束那一刻再画一次。
 * - 不可见、减少动态效果、省电模式、或什么都没有：不排帧，只在数据变化时画一次。
 *   省电模式要单独看：系统的省电策略默认不关动画时长，`ValueAnimator.areAnimatorsEnabled()`
 *   在省电模式下仍是 true。
 */
internal object FramePacer {
    const val PLAYING_FRAME_MS = 33L
    const val INFLIGHT_FRAME_MS = 83L

    data class Activity(
        val visible: Boolean,
        val reduceMotion: Boolean,
        val powerSave: Boolean = false,
        val playing: Boolean,
        val inflight: Boolean,
        /** 最近一条点亮连线熄灭还要多久；没有就是 null。 */
        val nextLingerEndMs: Long?,
    )

    /** 下一帧离现在多久；null 表示不用再排帧。 */
    fun nextFrameDelay(activity: Activity): Long? {
        if (!activity.visible) return null
        if (!activity.reduceMotion && !activity.powerSave) {
            if (activity.playing) return PLAYING_FRAME_MS
            if (activity.inflight) return INFLIGHT_FRAME_MS
        }
        return activity.nextLingerEndMs?.coerceAtLeast(0L)?.plus(1L)
    }
}
