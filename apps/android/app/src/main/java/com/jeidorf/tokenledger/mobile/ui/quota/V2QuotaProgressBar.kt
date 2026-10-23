package com.jeidorf.tokenledger.mobile.ui.quota

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.border
import com.jeidorf.tokenledger.mobile.ui.foundation.v2QuotaBandColor
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerMotion
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.QuotaSeverity
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ledgerTween
import com.jeidorf.tokenledger.mobile.quotaFullTimestamp
import com.jeidorf.tokenledger.mobile.quotaSeverityForFraction
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime

/**
 * 额度剩余量的三档配色。**颜色只表达还剩多少**，供应商身份交给行首的圆点与名字，
 * 一个视觉通道一种语义。墨水屏没有色相可用，critical 改成给轨道描边。
 */
internal fun v2SeverityColor(palette: MobileV2Palette, severity: QuotaSeverity): Color = when {
    palette.isEInk -> palette.text
    // 重构 R3：接入用户决定 V-Q1 的三档图形色——充足 = primary、偏紧 = warning、告急 = danger。
    else -> v2QuotaBandColor(palette.tokens, severity)
}

/**
 * 额度进度条。此前是 `if (status == Ok) blue else amber`——那说的是「这个来源能不能
 * 读到数」，不是「还剩多少」，于是 3% 与 95% 同样画成蓝色。现在按剩余量分档。
 */
@Composable
internal fun V2QuotaProgressBar(
    palette: MobileV2Palette,
    fraction: Float,
    degraded: Boolean,
    height: Dp = 6.dp,
    /** 历史读数仍按档位着色，填充降到 45%，表示「不是现在」。默认关，额度页不改。 */
    historical: Boolean = false,
    /**
     * 匀速线（重构 R3，对齐参考设计）：按时间匀速用完时此刻「应剩」的比例，画成一条 2dp 竖线。
     * 条短于它就是用快了。为 null（窗口长度或重置时间未知、历史读数）时不画。
     */
    pace: Float? = null
) {
    val motion = ledgerMotionEnabled(palette.isEInk)
    val severity = quotaSeverityForFraction(fraction)
    val animated by animateFloatAsState(
        targetValue = fraction.coerceIn(0f, 1f),
        animationSpec = ledgerTween(LedgerMotion.EMPHASIZED_MILLIS, motion),
        label = "quotaProgress"
    )
    // 数据不可信时把整条压成"幽灵"态。这里不能直接用 palette.muted：它是**文字**色，
    // 为了正文对比度被调得很深（浅色 #4E5158），当条身填充反而比正常态更重，
    // 看上去像被强调而不是被划掉——截图里就是这个样子。压到半透明才读得出"存疑"。
    val severityColor = if (historical) {
        v2SeverityColor(palette, severity).copy(alpha = 0.45f)
    } else v2SeverityColor(palette, severity)
    val target = if (degraded && !historical) palette.muted.copy(alpha = 0.45f) else severityColor
    val barColor by animateColorAsState(
        targetValue = target,
        animationSpec = ledgerTween(LedgerMotion.STANDARD_MILLIS, motion),
        label = "quotaProgressColor"
    )
    val shape = RoundedCornerShape(999.dp)
    val paceColor = palette.text
    Box(
        Modifier
            .fillMaxWidth()
            .height(if (pace != null) maxOf(height, QUOTA_PACE_MARKER_HEIGHT) else height)
            .drawWithContent {
                drawContent()
                if (pace != null) {
                    val markerWidth = QUOTA_PACE_MARKER_WIDTH.toPx()
                    val x = (size.width * pace.coerceIn(0f, 1f) - markerWidth / 2f).coerceIn(0f, size.width - markerWidth)
                    drawRoundRect(
                        color = paceColor,
                        topLeft = Offset(x, 0f),
                        size = Size(markerWidth, size.height),
                        cornerRadius = CornerRadius(markerWidth / 2f)
                    )
                }
            },
        contentAlignment = Alignment.Center
    ) {
        LinearProgressIndicator(
            progress = { animated },
            modifier = Modifier
                .fillMaxWidth()
                .height(height)
                .clip(shape)
                // 见底的最后一档不能只靠色相：墨水屏没有色相，色觉障碍也读不出红。
                .then(
                    if (severity == QuotaSeverity.Critical && !degraded && !historical) {
                        Modifier.border(1.dp, v2SeverityColor(palette, severity), shape)
                    } else Modifier
                ),
            color = barColor,
            trackColor = if (palette.isEInk) palette.raised else if (degraded) palette.surfaceContainerHigh else target.copy(alpha = 0.16f),
            strokeCap = StrokeCap.Round
        )
    }
}

private val QUOTA_PACE_MARKER_HEIGHT = 14.dp
private val QUOTA_PACE_MARKER_WIDTH = 2.dp

/**
 * 匀速线位置：窗口还剩多少时间占窗口长度的比例，即匀速用完时此刻应剩的额度比例。
 * 窗口长度、重置时间缺失或解析不出、或已过重置时间时返回 null，不编造。
 */
internal fun quotaPaceRemainingFraction(windowMinutes: Int?, resetsAt: String?, now: Instant): Float? {
    val minutes = windowMinutes?.takeIf { it > 0 } ?: return null
    val reset = resetsAt?.let { raw ->
        runCatching { OffsetDateTime.parse(raw).toInstant() }.getOrNull() ?: runCatching { Instant.parse(raw) }.getOrNull()
    } ?: return null
    val left = Duration.between(now, reset).seconds.toDouble() / 60.0
    // 已过重置时间的读数说明快照还没刷新，这时画在最左端的竖线没有意义，不画。
    if (left <= 0.0) return null
    return (left / minutes).coerceIn(0.0, 1.0).toFloat()
}

/** 匀速线的读屏说法：「按时间匀速应剩 40%，用得偏快」。与条同为四舍五入后的整数百分比比较。 */
internal fun quotaPaceAccessibilityNote(remainingFraction: Float, pace: Float): String {
    val remaining = Math.round(remainingFraction * 100f)
    val expected = Math.round(pace * 100f)
    val verdict = if (remaining < expected) "用得偏快" else "没有超出匀速"
    return "按时间匀速应剩 $expected%，$verdict"
}

/** 「照现在的速度，5 小时额度会比重置早 25 分钟用完。」时长按分钟、小时、天取最粗的一级。 */
internal fun quotaShortfallNote(windowLabel: String, shortfallMinutes: Long): String {
    val duration = when {
        shortfallMinutes < 60L -> "$shortfallMinutes 分钟"
        shortfallMinutes < 60L * 24L -> {
            val rest = shortfallMinutes % 60L
            "${shortfallMinutes / 60L} 小时" + if (rest > 0L) " $rest 分钟" else ""
        }
        else -> "${shortfallMinutes / (60L * 24L)} 天"
    }
    return "照现在的速度，${windowLabel}会比重置早 $duration 用完。"
}

/**
 * 相对重置时间。外层只需要「什么时候回血」这个量级；精确时间戳留在详情抽屉里。
 * 解析不出来时退回原字符串，不编造。
 */
internal fun v2RelativeReset(raw: String?, now: Instant): String {
    val instant = raw?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return quotaFullTimestamp(raw)
    val minutes = Duration.between(now, instant).toMinutes()
    return when {
        minutes < 0L -> "已到期"
        minutes < 60L -> "${minutes} 分钟后"
        minutes < 60L * 24L -> "${minutes / 60L} 小时后"
        else -> "${minutes / (60L * 24L)} 天后"
    }
}

internal fun v2QuotaStatusColor(
    palette: MobileV2Palette,
    status: QuotaProviderStatus
): Color = when (status) {
    QuotaProviderStatus.Ok -> palette.green
    QuotaProviderStatus.Stale, QuotaProviderStatus.AuthRequired -> palette.amber
    QuotaProviderStatus.Error -> palette.danger
    QuotaProviderStatus.Unsupported -> palette.muted
}
