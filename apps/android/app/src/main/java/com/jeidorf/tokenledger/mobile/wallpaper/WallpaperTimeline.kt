package com.jeidorf.tokenledger.mobile.wallpaper

/**
 * 动态壁纸的动画时序，数字与桌面路由舞台一致（docs/design/routing-animation-v1.md「动画时序」）：
 * 光点先跑 Agent→网关，再按尝试顺序依次跑网关→各成员；每段 0.7 秒、间隔 0.25 秒，尝试很多时
 * 整段压缩到 4 秒内；结束后连线按结果点亮 12 秒。
 *
 * 纯函数，不依赖 Android，便于在 JVM 上穷举。
 */
internal object WallpaperTimeline {
    const val SEGMENT_MS = 700L
    const val GAP_MS = 250L
    const val MAX_PLAY_MS = 4_000L
    const val LINGER_MS = 12_000L

    /** 一条流第一次出现在快照里时，只有记录时间在这之内才播放（契约 §5）。 */
    const val PLAYABLE_AGE_MS = 10 * 60_000L

    /** 在途虚线流动一周期。 */
    const val DASH_PERIOD_MS = 700L

    /** 段：index 0 是 Agent→网关，之后第 i 段是网关→第 i 个成员。 */
    data class Segment(val index: Int, val startMs: Long, val durationMs: Long)

    /** 一条流的完整播放计划：段落起止与总时长（不含停留）。 */
    data class Plan(val segments: List<Segment>, val totalMs: Long)

    fun plan(hopCount: Int): Plan {
        val count = 1 + hopCount.coerceAtLeast(0)
        val natural = count * SEGMENT_MS + (count - 1) * GAP_MS
        val scale = if (natural > MAX_PLAY_MS) MAX_PLAY_MS.toDouble() / natural else 1.0
        val segment = (SEGMENT_MS * scale).toLong().coerceAtLeast(1L)
        val gap = (GAP_MS * scale).toLong()
        val segments = (0 until count).map { index -> Segment(index, index * (segment + gap), segment) }
        return Plan(segments, segments.last().let { it.startMs + it.durationMs })
    }

    /** 播放进行到哪一段、这一段走了多少（0..1）；播完返回 null。 */
    data class Cursor(val segment: Int, val progress: Float)

    fun cursor(plan: Plan, elapsedMs: Long): Cursor? {
        if (elapsedMs < 0 || elapsedMs >= plan.totalMs) return null
        for (segment in plan.segments) {
            val end = segment.startMs + segment.durationMs
            if (elapsedMs < segment.startMs) return null // 落在间隔里：光点暂时不画
            if (elapsedMs < end) {
                return Cursor(segment.index, (elapsedMs - segment.startMs).toFloat() / segment.durationMs)
            }
        }
        return null
    }

    /**
     * 失败的一段：光点跑到接近节点（88%）后回弹消失，与桌面一致。返回光点在连线上的位置 0..1。
     */
    fun failedPosition(progress: Float): Float {
        val p = progress.coerceIn(0f, 1f)
        return if (p < 0.8f) p / 0.8f * 0.88f else 0.88f - (p - 0.8f) / 0.2f * 0.18f
    }

    /** 停留结束后连线回到空闲。 */
    fun lit(finishedAtMs: Long, nowMs: Long): Boolean = nowMs - finishedAtMs in 0 until LINGER_MS
}
