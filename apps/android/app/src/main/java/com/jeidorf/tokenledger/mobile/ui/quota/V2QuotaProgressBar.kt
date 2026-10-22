package com.jeidorf.tokenledger.mobile.ui.quota

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.border
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

/**
 * 额度剩余量的三档配色。**颜色只表达还剩多少**，供应商身份交给行首的圆点与名字，
 * 一个视觉通道一种语义。墨水屏没有色相可用，critical 改成给轨道描边。
 */
internal fun v2SeverityColor(palette: MobileV2Palette, severity: QuotaSeverity): Color = when {
    palette.isEInk -> palette.text
    severity == QuotaSeverity.Critical -> palette.danger
    severity == QuotaSeverity.Warning -> palette.amber
    else -> palette.green
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
    historical: Boolean = false
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
