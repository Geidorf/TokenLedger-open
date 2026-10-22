package com.jeidorf.tokenledger.mobile.ui.charts

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette

@Composable
internal fun V2HeatmapLegend(
    palette: MobileV2Palette,
    modifier: Modifier = Modifier,
    highlightLabel: String? = null
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (highlightLabel != null) {
            Box(
                Modifier
                    .size(width = 12.dp, height = 8.dp)
                    .border(1.dp, palette.blue.copy(alpha = 0.85f), RoundedCornerShape(3.dp))
            )
            Spacer(Modifier.width(4.dp))
            Text(highlightLabel, color = palette.muted, fontSize = LedgerFont.caption, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.weight(1f))
        }
        Text("少", color = palette.muted, fontSize = LedgerFont.caption)
        Spacer(Modifier.width(4.dp))
        val blocks = listOf(
            palette.raised,
            if (palette.isEInk) Color(0xFFCCCCCC) else palette.blue.copy(alpha = 0.35f),
            if (palette.isEInk) Color(0xFF888888) else palette.blue.copy(alpha = 0.65f),
            if (palette.isEInk) Color.Black else palette.blue
        )
        blocks.forEach { color ->
            Box(
                modifier = Modifier
                    .padding(horizontal = 2.dp)
                    .size(width = 12.dp, height = 8.dp)
                    .background(color, RoundedCornerShape(3.dp))
                    .then(if (palette.isEInk) Modifier.border(0.5.dp, Color.Black, RoundedCornerShape(3.dp)) else Modifier)
            )
        }
        Spacer(Modifier.width(4.dp))
        Text("多", color = palette.muted, fontSize = LedgerFont.caption)
    }
}

@Composable
internal fun V2LineLegend(color: Color, dashed: Boolean, text: String, palette: MobileV2Palette) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Spacer(
            modifier = Modifier
                .width(24.dp)
                .height(8.dp)
                .drawWithCache {
                    val strokeWidth = 1.5.dp.toPx()
                    val pathEffect = if (dashed) {
                        PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))
                    } else null
                    val y = size.height / 2f
                    val start = Offset(0f, y)
                    val end = Offset(size.width, y)
                    onDrawBehind {
                        drawLine(
                            color = color,
                            start = start,
                            end = end,
                            strokeWidth = strokeWidth,
                            pathEffect = pathEffect
                        )
                    }
                }
        )
        Spacer(Modifier.width(4.dp))
        Text(text, color = palette.muted, fontSize = LedgerFont.caption)
    }
}
