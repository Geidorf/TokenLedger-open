package com.jeidorf.tokenledger.mobile.ui.hero

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Share
import kotlin.math.max

@Composable
internal fun V2SectionHeader(palette: MobileV2Palette, title: String, action: String, onAction: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, color = palette.text, fontSize = LedgerFont.subtitle, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
        TextButton(onClick = onAction, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(action, color = palette.blue, fontSize = LedgerFont.caption)
            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = palette.blue, modifier = Modifier.size(V2_ICON_INLINE))
        }
    }
}

@Composable
internal fun V2CompositionCard(
    palette: MobileV2Palette,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode
) {
    val summary = stats.summary
    val total = max(displayedTokenCount(tokenDisplayMode, summary.effectiveTokens, summary.cachedTokens), 1L)
    val segments = buildList {
        add(Triple(summary.inputTokens, palette.blue, "输入"))
        add(Triple(summary.outputTokens, palette.green, "输出"))
        if (tokenDisplayMode == TokenDisplayMode.All) add(Triple(summary.cachedTokens, palette.amber, "缓存"))
    }
    V2Card(palette) {
        Text(if (tokenDisplayMode == TokenDisplayMode.All) "输入 / 输出 / 缓存" else "输入 / 输出", color = palette.text, fontWeight = FontWeight.SemiBold, fontSize = LedgerFont.body)
        Text(
            if (tokenDisplayMode == TokenDisplayMode.All) "全量包含缓存 · 统计口径守恒" else "有效 Token 口径 · 缓存单列",
            color = palette.faint,
            fontSize = LedgerFont.caption
        )
        Spacer(Modifier.height(14.dp))
        val activeSegments = segments.filter { it.first > 0L }
        if (activeSegments.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(10.dp)
                    .semantics {
                        contentDescription = "${tokenDisplayMode.label} Token 构成，" + segments.joinToString("，") { (value, _, label) -> "$label ${v2Share(value, total)}" }
                    },
                horizontalArrangement = Arrangement.spacedBy(2.dp)
            ) {
                activeSegments.forEach { (value, color, _) ->
                    Box(
                        Modifier
                            .weight(value.toFloat())
                            .fillMaxHeight()
                            .clip(RoundedCornerShape(999.dp))
                            .background(color)
                    )
                }
            }
        } else {
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(10.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(if (palette.isEInk) palette.raised else palette.surfaceContainerHigh)
            )
        }
        if (segments.all { it.first == 0L }) Text("暂无 Token 构成", color = palette.muted, fontSize = LedgerFont.label)
        Spacer(Modifier.height(10.dp))
        Row {
            segments.forEach { (value, color, label) ->
                V2LegendDot(color, "$label ${v2Share(value, total)}", palette, Modifier.weight(1f))
            }
        }
    }
}

@Composable
internal fun V2LegendDot(color: Color, text: String, palette: MobileV2Palette, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(6.dp))
        Text(text, color = palette.muted, fontSize = LedgerFont.caption)
    }
}
