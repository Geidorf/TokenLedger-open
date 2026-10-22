package com.jeidorf.tokenledger.mobile.ui.charts

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.ReportMetricMode
import com.jeidorf.tokenledger.mobile.SmoothCurvePoint
import com.jeidorf.tokenledger.mobile.TrendPoint
import com.jeidorf.tokenledger.mobile.UsageComparison
import com.jeidorf.tokenledger.mobile.addSmoothCurve
import com.jeidorf.tokenledger.mobile.formatInteger
import com.jeidorf.tokenledger.mobile.formatScrubAccessibilityDescription
import com.jeidorf.tokenledger.mobile.formatScrubBucketLabel
import com.jeidorf.tokenledger.mobile.formatTrendAnchorLabel
import com.jeidorf.tokenledger.mobile.metricSeriesValues
import com.jeidorf.tokenledger.mobile.paddedChartMaximum
import com.jeidorf.tokenledger.mobile.scrubIndexForPosition
import com.jeidorf.tokenledger.mobile.scrubReadout
import com.jeidorf.tokenledger.mobile.shouldAnchorTooltipToRight
import com.jeidorf.tokenledger.mobile.trendAvailabilityMessage
import com.jeidorf.tokenledger.mobile.trendSeriesBuckets
import com.jeidorf.tokenledger.mobile.trendTableValue
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatPercent
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane
import com.jeidorf.tokenledger.mobile.ui.trend.sharedTrendSlotCount
import com.jeidorf.tokenledger.mobile.ui.trend.trendChartPoints
import com.jeidorf.tokenledger.mobile.v2FormatNumber
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import kotlin.math.max

@Composable
@OptIn(ExperimentalLayoutApi::class)
internal fun V2TrendChart(
    palette: MobileV2Palette,
    comparison: UsageComparison?,
    fallback: List<TrendPoint>,
    modifier: Modifier,
    compact: Boolean,
    normalizeRange: Boolean = false,
    metricMode: ReportMetricMode = ReportMetricMode.Tokens,
    isCostMasked: Boolean = false,
    currency: CurrencyUnit = CurrencyUnit.CNY,
    interactive: Boolean = false,
    honestEmptyState: Boolean = false,
    onOpenBucket: ((String, InsightPane) -> Unit)? = null
) {
    val externalAnchors = honestEmptyState && (LocalDensity.current.fontScale >= 1.5f || LocalConfiguration.current.screenWidthDp < 360)
    val numericAxisWidth = if (externalAnchors) 88.dp else if (metricMode == ReportMetricMode.Cost) (80f * LocalDensity.current.fontScale).dp else (48f * LocalDensity.current.fontScale).dp
    // 坐标文字跟随系统字号放大；18dp 固定槽在 200% 时会裁掉字形下沿。
    val horizontalAxisHeight = (18f * LocalDensity.current.fontScale).dp
    val chartBottomInset = if (externalAnchors) 8.dp else horizontalAxisHeight + 4.dp
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    var scrubIndex by remember(comparison, fallback, metricMode) { mutableStateOf<Int?>(null) }
    var isScrubOnLeftHalf by remember { mutableStateOf(false) }

    val chartData = remember(comparison, fallback, metricMode) {
        metricSeriesValues(comparison, fallback, metricMode)
    }
    val current = chartData.first
    val previous = chartData.second
    val emptyMessage = trendAvailabilityMessage(comparison, fallback, metricMode)
    val slotCount = sharedTrendSlotCount(current.size, previous.size)
    val axisLabels = remember(comparison, fallback, honestEmptyState) {
        if (honestEmptyState && comparison != null) (0 until max(comparison.current.series.size, comparison.previous.series.size)).map {
            comparison.current.series.getOrNull(it)?.bucket ?: comparison.previous.series[it].bucket
        } else trendSeriesBuckets(comparison, fallback)
    }
    val maximum = remember(current, previous, normalizeRange) {
        paddedChartMaximum(
            current + previous,
            headroomFraction = if (normalizeRange) 0.14f else 0.12f
        )
    }
    val minimum = 0f

    val activeColor = remember(palette, metricMode) {
        if (palette.isEInk) palette.blue
        else if (metricMode == ReportMetricMode.Cost) palette.amber
        else palette.blue
    }

    val readout = remember(comparison, fallback, scrubIndex, honestEmptyState, metricMode) {
        scrubIndex?.let { index -> scrubReadout(comparison, fallback, index, honestEmptyState, metricMode) }
    }

    val description = remember(comparison, fallback, current, previous, metricMode, readout, isCostMasked, currency, honestEmptyState) {
        if (readout != null) {
            formatScrubAccessibilityDescription(readout, metricMode, isCostMasked = isCostMasked, currency = currency)
        } else if (honestEmptyState) {
            val peak = comparison?.current?.series?.maxByOrNull {
                if (metricMode == ReportMetricMode.Tokens) it.tokens.toDouble() else it.cost
            }
            val fallbackPeak = if (comparison == null && metricMode == ReportMetricMode.Tokens)
                fallback.maxByOrNull { it.values.filterKeys { key -> !key.startsWith("__") }.values.sum() } else null
            listOfNotNull(emptyMessage,
                peak?.let { "当前峰值时段 ${it.bucket}，${trendTableValue(it, metricMode, currency, isCostMasked)}，${formatInteger(it.requests)} 条记录" },
                fallbackPeak?.let { "当前峰值时段 ${it.date}，有效 Token ${formatInteger(it.values.filterKeys { key -> !key.startsWith("__") }.values.sum())}，${formatInteger(it.requests)} 条记录" }
            ).joinToString("；")
        } else {
            buildString {
                append("平滑 ${metricMode.label} 曲线图，当前期 ")
                append(current.size)
                append(" 个数据点")
                if (previous.isNotEmpty()) append("，上一期 ${previous.size} 个数据点")
                current.maxOrNull()?.let {
                    val formatted = if (metricMode == ReportMetricMode.Tokens) {
                        v2FormatTokens(it.toLong())
                    } else {
                        v2FormatMoney(context, it.toDouble(), isCostMasked, currency)
                    }
                    append("，当前峰值 $formatted")
                }
            }
        }
    }

    val gestureModifier = if (interactive && current.isNotEmpty()) {
        Modifier.pointerInput(current.size, slotCount, compact) {
            awaitEachGesture {
                try {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val horizontalInset = if (compact) 0f else 8.dp.toPx()
                    val rightInset = if (compact) 0f else (numericAxisWidth + 4.dp).toPx()
                    isScrubOnLeftHalf = shouldAnchorTooltipToRight(down.position.x, size.width.toFloat())
                    val initialIndex = scrubIndexForPosition(
                        down.position.x,
                        size.width.toFloat(),
                        slotCount,
                        horizontalInset,
                        rightInset + horizontalInset
                    )
                    if (initialIndex != scrubIndex) {
                        scrubIndex = initialIndex
                        runCatching { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove) }
                    }

                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull() ?: break
                        if (change.pressed) {
                            isScrubOnLeftHalf = shouldAnchorTooltipToRight(change.position.x, size.width.toFloat())
                            val newIndex = scrubIndexForPosition(
                                change.position.x,
                                size.width.toFloat(),
                                slotCount,
                                horizontalInset,
                                rightInset + horizontalInset
                            )
                            if (newIndex != scrubIndex) {
                                scrubIndex = newIndex
                                runCatching { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove) }
                            }
                            change.consume()
                        } else {
                            break
                        }
                    }
                } finally {
                    // 保留点击读数，便于抬手后阅读。下一次点击更新所选时段。
                }
            }
        }
    } else Modifier

    Column(Modifier.fillMaxWidth()) {
        Box(modifier = modifier) {
            Box(
                modifier = Modifier.matchParentSize()
                    .then(gestureModifier)
                    .semantics {
                        contentDescription = description
                        if (readout != null) {
                            liveRegion = LiveRegionMode.Assertive
                        }
                    }
                    .drawWithCache {
                        if (current.isEmpty()) {
                            onDrawBehind { }
                        } else {
                            val horizontalInset = if (compact) 0f else 8.dp.toPx()
                            val left = horizontalInset
                            val right = size.width - horizontalInset - if (compact) 0f else (numericAxisWidth + 4.dp).toPx()
                            val top = 8.dp.toPx()
                            val bottom = size.height - (if (!compact) chartBottomInset.toPx() else 8.dp.toPx())
                            fun chartPoints(values: List<Float>): List<SmoothCurvePoint> = trendChartPoints(values, slotCount, left, right, top, bottom, minimum, maximum)
                            val currentPoints = chartPoints(current)
                            val currentPath = Path().apply {
                                currentPoints.firstOrNull()?.let { first ->
                                    moveTo(first.x, first.y)
                                    addSmoothCurve(currentPoints, minY = top, maxY = bottom)
                                }
                            }
                            val previousPoints = previous.takeIf { it.isNotEmpty() }?.let(::chartPoints).orEmpty()
                            val previousPath = if (previousPoints.isNotEmpty()) {
                                Path().apply {
                                    previousPoints.firstOrNull()?.let { first ->
                                        moveTo(first.x, first.y)
                                        addSmoothCurve(previousPoints, minY = top, maxY = bottom)
                                    }
                                }
                            } else null
                            val areaPath = if (palette.isEInk || currentPoints.isEmpty()) null else Path().apply {
                                val first = currentPoints.first()
                                moveTo(first.x, bottom)
                                lineTo(first.x, first.y)
                                addSmoothCurve(currentPoints, minY = top, maxY = bottom)
                                lineTo(currentPoints.last().x, bottom)
                                close()
                            }
                            val areaBrush = Brush.verticalGradient(
                                colorStops = arrayOf(
                                    0.0f to activeColor.copy(alpha = if (palette.isEInk) 0f else 0.22f),
                                    0.5f to activeColor.copy(alpha = if (palette.isEInk) 0f else 0.08f),
                                    0.85f to activeColor.copy(alpha = if (palette.isEInk) 0f else 0.02f),
                                    1.0f to Color.Transparent
                                ),
                                startY = top,
                                endY = bottom
                            )
                            val gridStroke = Stroke(
                                width = 1.dp.toPx(),
                                pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 4.dp.toPx())),
                                cap = StrokeCap.Round
                            )
                            val gridColor = if (palette.isEInk) palette.divider else palette.outlineVariant
                            val previousStroke = Stroke(
                                width = 1.4.dp.toPx(),
                                pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 5.dp.toPx())),
                                cap = StrokeCap.Round
                            )
                            val currentStroke = Stroke(
                                width = if (compact) 2.4.dp.toPx() else 2.7.dp.toPx(),
                                cap = StrokeCap.Round
                            )
                            val scrubDashStroke = Stroke(
                                width = 1.2.dp.toPx(),
                                pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 4.dp.toPx())),
                                cap = StrokeCap.Round
                            )
                            val scrubLineColor = if (palette.isEInk) palette.divider else activeColor.copy(alpha = 0.5f)
                            val prevOuterRadius = 4.dp.toPx()
                            val prevInnerRadius = 2.8.dp.toPx()
                            val scrubHaloRadius = 12.dp.toPx()
                            val scrubOuterRadius = 6.5.dp.toPx()
                            val scrubSpacerRadius = 4.5.dp.toPx()
                            val scrubInnerRadius = 2.dp.toPx()

                            onDrawBehind {
                                if (!compact) {
                                    repeat(3) { index ->
                                        val y = top + (bottom - top) * index / 2f
                                        drawLine(
                                            color = gridColor,
                                            start = Offset(left, y),
                                            end = Offset(right, y),
                                            strokeWidth = gridStroke.width,
                                            pathEffect = gridStroke.pathEffect,
                                            cap = gridStroke.cap
                                        )
                                    }
                                }
                                previousPath?.let { drawPath(it, color = palette.muted, style = previousStroke) }
                                areaPath?.let { drawPath(it, brush = areaBrush) }
                                drawPath(currentPath, color = activeColor, style = currentStroke)

                                val activeScrubIdx = scrubIndex
                                if (activeScrubIdx != null && activeScrubIdx in currentPoints.indices) {
                                    val scrubPt = currentPoints[activeScrubIdx]
                                    drawLine(
                                        color = scrubLineColor,
                                        start = Offset(scrubPt.x, top),
                                        end = Offset(scrubPt.x, bottom),
                                        strokeWidth = scrubDashStroke.width,
                                        pathEffect = scrubDashStroke.pathEffect,
                                        cap = scrubDashStroke.cap
                                    )
                                    if (activeScrubIdx in previousPoints.indices) {
                                        val prevPt = previousPoints[activeScrubIdx]
                                        drawCircle(
                                            color = palette.surface,
                                            radius = prevOuterRadius,
                                            center = Offset(prevPt.x, prevPt.y)
                                        )
                                        drawCircle(
                                            color = palette.muted,
                                            radius = prevInnerRadius,
                                            center = Offset(prevPt.x, prevPt.y)
                                        )
                                    }
                                    if (!palette.isEInk) {
                                        drawCircle(
                                            color = activeColor.copy(alpha = 0.25f),
                                            radius = scrubHaloRadius,
                                            center = Offset(scrubPt.x, scrubPt.y)
                                        )
                                    }
                                    drawCircle(
                                        color = activeColor,
                                        radius = scrubOuterRadius,
                                        center = Offset(scrubPt.x, scrubPt.y)
                                    )
                                    drawCircle(
                                        color = palette.surface,
                                        radius = scrubSpacerRadius,
                                        center = Offset(scrubPt.x, scrubPt.y)
                                    )
                                    drawCircle(
                                        color = if (palette.isEInk) Color.Black else Color.White,
                                        radius = scrubInnerRadius,
                                        center = Offset(scrubPt.x, scrubPt.y)
                                    )
                                }
                            }
                        }
                    }
            ) {
                if (emptyMessage != null && current.isEmpty()) {
                    Text(
                        emptyMessage,
                        color = palette.muted,
                        fontSize = LedgerFont.label,
                        modifier = Modifier.align(Alignment.Center).padding(8.dp)
                    )
                }
                if (!compact && current.isNotEmpty()) {
                    Column(
                        Modifier
                            .align(Alignment.TopEnd)
                            .fillMaxHeight()
                            .width(numericAxisWidth)
                            .padding(top = 6.dp, bottom = chartBottomInset),
                        verticalArrangement = Arrangement.SpaceBetween,
                        horizontalAlignment = Alignment.End
                    ) {
                        val maxLabel = if (metricMode == ReportMetricMode.Tokens) {
                            v2FormatTokens(maximum.toLong())
                        } else {
                            v2FormatMoney(context, maximum.toDouble(), isCostMasked, currency)
                        }
                        Text(maxLabel, color = palette.faint, fontSize = LedgerFont.caption, maxLines = 1, softWrap = false)
                        val middleLabel = if (metricMode == ReportMetricMode.Tokens) v2FormatTokens((maximum / 2).toLong()) else v2FormatMoney(context, (maximum / 2).toDouble(), isCostMasked, currency)
                        Text(middleLabel, color = palette.faint, fontSize = LedgerFont.caption, maxLines = 1)
                        Text("0", color = palette.faint, fontSize = LedgerFont.caption)
                    }

                    if (!externalAnchors && current.isNotEmpty() && axisLabels.isNotEmpty()) {
                        val startAnchor = axisLabels.firstOrNull()?.let(::formatTrendAnchorLabel).orEmpty()
                        val endAnchor = if (axisLabels.size > 1) axisLabels.last().let(::formatTrendAnchorLabel) else ""
                        val midAnchor = if (axisLabels.size > 2) axisLabels[axisLabels.size / 2].let(::formatTrendAnchorLabel) else ""

                        Box(
                            modifier = Modifier
                                .align(Alignment.BottomStart)
                                .fillMaxWidth()
                                .height(horizontalAxisHeight)
                                .padding(start = 8.dp, end = numericAxisWidth + 12.dp)
                        ) {
                            if (startAnchor.isNotEmpty()) {
                                Text(
                                    text = startAnchor,
                                    color = palette.muted,
                                    fontSize = LedgerFont.caption,
                                    modifier = Modifier.align(Alignment.CenterStart)
                                )
                            }
                            if (midAnchor.isNotEmpty()) {
                                Text(
                                    text = midAnchor,
                                    color = palette.muted,
                                    fontSize = LedgerFont.caption,
                                    modifier = Modifier.align(Alignment.Center)
                                )
                            }
                            if (endAnchor.isNotEmpty()) {
                                Text(
                                    text = endAnchor,
                                    color = palette.muted,
                                    fontSize = LedgerFont.caption,
                                    modifier = Modifier.align(Alignment.CenterEnd)
                                )
                            }
                        }
                    }
                }
            }

            if (interactive && readout != null) {
                Surface(
                    modifier = Modifier
                        .padding(
                            start = if (compact) 6.dp else 10.dp,
                            top = 6.dp,
                            end = if (compact) 6.dp else (numericAxisWidth + 8.dp)
                        )
                        .align(if (isScrubOnLeftHalf) Alignment.TopEnd else Alignment.TopStart),
                    shape = RoundedCornerShape(10.dp),
                    color = if (palette.isEInk) palette.surface else palette.surfaceContainerHigh.copy(alpha = 0.94f),
                    border = if (palette.isEInk) BorderStroke(1.dp, palette.text) else null,
                    shadowElevation = if (palette.isEInk) 0.dp else 3.dp
                ) {
                    Column(
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp)
                    ) {
                        if (onOpenBucket != null) {
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text("整天数据", color = palette.muted, fontSize = LedgerFont.caption)
                                TextButton(
                                    onClick = { onOpenBucket(readout.bucket, InsightPane.Sources) },
                                    contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp)
                                ) { Text("来源", fontSize = LedgerFont.caption) }
                                TextButton(
                                    onClick = { onOpenBucket(readout.bucket, InsightPane.Details) },
                                    contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp)
                                ) { Text("明细", fontSize = LedgerFont.caption) }
                            }
                        }
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Text(
                                formatScrubBucketLabel(readout.bucket),
                                color = palette.text,
                                fontSize = LedgerFont.caption,
                                fontWeight = FontWeight.Bold
                            )
                            val deltaPct = if (metricMode == ReportMetricMode.Tokens) readout.tokenDeltaPercent else readout.costDeltaPercent
                            if (deltaPct != null) {
                                val deltaColor = if (deltaPct >= 0) palette.amber else palette.green
                                Text(
                                    "较上期 ${v2FormatPercent(deltaPct)}",
                                    color = deltaColor,
                                    fontSize = LedgerFont.caption,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                            Text(
                                "${v2FormatNumber(readout.requests)} 条记录",
                                color = palette.muted,
                                fontSize = LedgerFont.caption
                            )
                        }
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            val tokenLabel = "有效: ${v2FormatTokens(readout.tokens)}"
                            val costLabel = readout.cost?.let { "费用: ${v2FormatMoney(context, it, isCostMasked, currency)}" }
                            val primaryLabel = if (metricMode == ReportMetricMode.Tokens) tokenLabel else costLabel
                            val secondaryLabel = if (metricMode == ReportMetricMode.Tokens) costLabel else tokenLabel
                            if (primaryLabel != null) {
                                Text(
                                    primaryLabel,
                                    color = activeColor,
                                    fontSize = LedgerFont.caption,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                            if (secondaryLabel != null) {
                                Text(
                                    secondaryLabel,
                                    color = palette.muted,
                                    fontSize = LedgerFont.caption
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
