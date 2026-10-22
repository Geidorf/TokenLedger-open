package com.jeidorf.tokenledger.mobile.ui.charts

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.donutPresentation
import com.jeidorf.tokenledger.mobile.donutSegmentAtOffset
import com.jeidorf.tokenledger.mobile.formatInteger
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Share
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import kotlin.math.max

@Composable
internal fun V2DonutChart(
    palette: MobileV2Palette,
    values: List<Long>,
    colors: List<Color>,
    centerValue: String,
    centerLabel: String,
    modifier: Modifier,
    total: Long,
    selectedIndex: Int? = null,
    onSliceClick: ((Int?) -> Unit)? = null
) {
    val presentation = remember(values, total) { donutPresentation(values, total) }
    val selected = presentation.selected(selectedIndex)
    val hasBreakdown = presentation.segments.any { it.sourceIndex != null }
    val tapModifier = if (onSliceClick != null && presentation.segments.isNotEmpty()) {
        Modifier.pointerInput(presentation, selectedIndex) {
            detectTapGestures { offset ->
                val tapped = donutSegmentAtOffset(presentation, offset.x, offset.y, size.width.toFloat(), 20.dp.toPx())
                if (tapped != null) onSliceClick(if (selectedIndex == tapped) null else tapped)
            }
        }
    } else Modifier
    val centerText = when {
        !presentation.valid -> "数据不一致"
        !hasBreakdown -> "暂无构成"
        selected != null -> v2FormatTokens(selected.value)
        else -> centerValue
    }
    val labelText = if (selected != null) "已选占比 ${v2Share(selected.value, total)}" else centerLabel
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .then(tapModifier)
                .semantics {
                    contentDescription = when {
                        !presentation.valid -> "来源构成数据不一致"
                        !hasBreakdown -> "暂无来源构成"
                        selected != null -> "已选 ${formatInteger(selected.value)} Token，占全量 ${v2Share(selected.value, total)}"
                        else -> "来源构成，总计 ${formatInteger(total)} Token；" + presentation.segments.joinToString("；") {
                            "${if (it.sourceIndex == null) "未显示" else "来源 ${it.sourceIndex + 1}"} ${formatInteger(it.value)} Token，${v2Share(it.value, total)}"
                        }
                    }
                },
            contentAlignment = Alignment.Center
        ) {
            Box(Modifier.fillMaxSize().drawWithCache {
                val inset = 10.dp.toPx()
                val arcSize = Size((size.width - 2 * inset).coerceAtLeast(0f), (size.height - 2 * inset).coerceAtLeast(0f))
                val trackColor = if (palette.isEInk) palette.divider.copy(alpha = 0.25f) else palette.surfaceContainerHigh
                val trackWidth = 16.dp.toPx()
                onDrawBehind {
                    drawArc(
                        color = trackColor,
                        startAngle = 0f,
                        sweepAngle = 360f,
                        useCenter = false,
                        topLeft = Offset(inset, inset),
                        size = arcSize,
                        style = Stroke(width = trackWidth, cap = StrokeCap.Round)
                    )
                    val hasMultiple = presentation.segments.size > 1
                    val gapDegrees = if (hasMultiple) 6f else 0f
                    presentation.segments.forEach { segment ->
                        val index = segment.sourceIndex
                        val color = if (index == null) palette.divider else if (palette.isEInk) {
                            lerp(Color(0xFF222222), Color(0xFFBBBBBB), index / max(values.size - 1f, 1f))
                        } else colors[index % colors.size]
                        val isSelected = selected != null && index == selectedIndex
                        val strokeWidth = if (isSelected) 20.dp.toPx() else 16.dp.toPx()
                        val sliceColor = if (selected != null && index != selectedIndex) color.copy(alpha = .35f) else color

                        if (hasMultiple) {
                            val start = segment.startDegrees + gapDegrees / 2f
                            val sweep = (segment.sweepDegrees - gapDegrees).coerceAtLeast(0.1f)
                            drawArc(
                                color = sliceColor,
                                startAngle = start,
                                sweepAngle = sweep,
                                useCenter = false,
                                topLeft = Offset(inset, inset),
                                size = arcSize,
                                style = Stroke(width = strokeWidth, cap = StrokeCap.Round)
                            )
                        } else {
                            drawArc(
                                color = sliceColor,
                                startAngle = segment.startDegrees,
                                sweepAngle = segment.sweepDegrees,
                                useCenter = false,
                                topLeft = Offset(inset, inset),
                                size = arcSize,
                                style = Stroke(
                                    width = strokeWidth,
                                    cap = if (segment.sweepDegrees >= 359f) StrokeCap.Butt else StrokeCap.Round
                                )
                            )
                        }
                    }
                }
            })
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(20.dp)) {
                Text(centerText, color = palette.text, fontWeight = FontWeight.SemiBold, fontSize = LedgerFont.body, textAlign = TextAlign.Center)
                Text(labelText, color = palette.faint, fontSize = LedgerFont.caption, textAlign = TextAlign.Center)
            }
        }
        if (hasBreakdown) {
            presentation.segments.firstOrNull { it.sourceIndex == null }?.let {
                Text("未显示 ${v2Share(it.value, total)}", color = palette.faint, fontSize = LedgerFont.caption, textAlign = TextAlign.Center)
            }
        }
    }
}
