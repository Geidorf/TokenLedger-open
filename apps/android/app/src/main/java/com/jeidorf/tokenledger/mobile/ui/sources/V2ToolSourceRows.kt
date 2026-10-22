package com.jeidorf.tokenledger.mobile.ui.sources

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerMotion
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ToolStat
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.formatInteger
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ledgerTween
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE
import com.jeidorf.tokenledger.mobile.ui.foundation.v2DataBarBackground
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Share
import com.jeidorf.tokenledger.mobile.ui.trend.normalizedDataBarFraction
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import kotlin.math.max

@Composable
internal fun V2ToolSourceRows(
    palette: MobileV2Palette,
    tools: List<ToolStat>,
    colors: List<Color>,
    tokenDisplayMode: TokenDisplayMode,
    displayedTokens: Long,
    toolMaximum: Long,
    onOpenTool: (String) -> Unit,
    modifier: Modifier = Modifier,
    selectedIndex: Int? = null,
    onSelectTool: ((Int?) -> Unit)? = null
) {
    val currency = LocalDashboardCurrency.current
    val isCostMasked = LocalCostMaskEnabled.current
    val context = LocalContext.current

    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        tools.forEachIndexed { index, tool ->
            val toolTokens = displayedTokenCount(tokenDisplayMode, tool.effectiveTokens, tool.cached)
            val costLabel = v2FormatMoney(context, tool.cost, isCostMasked, currency)
            val isSelected = selectedIndex == index
            val rowModifier = if (selectedIndex != null && isSelected) {
                Modifier
                    .fillMaxWidth()
                    .background(palette.raised, RoundedCornerShape(8.dp))
                    .border(1.dp, colors[index % colors.size], RoundedCornerShape(8.dp))
            } else {
                Modifier.fillMaxWidth()
            }
            Box(modifier = rowModifier) {
                V2SourceRow(
                    palette = palette,
                    color = colors[index % colors.size],
                    label = tool.name,
                    value = v2FormatTokens(toolTokens),
                    note = v2Share(toolTokens, max(displayedTokens, 1L)),
                    barFraction = normalizedDataBarFraction(toolTokens, toolMaximum),
                    secondaryValue = costLabel,
                    onClick = {
                        if (onSelectTool != null) {
                            onSelectTool(if (isSelected) null else index)
                        } else {
                            onOpenTool(tool.name)
                        }
                    },
                    actionLabelOverride = if (onSelectTool != null) {
                        if (isSelected) "取消筛选工具 ${tool.name}" else "筛选工具 ${tool.name}"
                    } else null,
                    selectionState = if (onSelectTool != null) isSelected else null,
                    accessibilityValue = "${formatInteger(toolTokens)} ${tokenDisplayMode.label} Token"
                )
            }
        }
    }
}

@Composable
internal fun V2SourceRow(
    palette: MobileV2Palette,
    color: Color,
    label: String,
    value: String,
    note: String,
    barFraction: Float,
    onClick: () -> Unit,
    isExpanded: Boolean? = null,
    secondaryValue: String? = null,
    actionLabelOverride: String? = null,
    selectionState: Boolean? = null,
    accessibilityValue: String = value,
    accessibilityNote: String = note
) {
    val actionLabel = actionLabelOverride ?: if (isExpanded != null) {
        if (isExpanded) "收起明细" else "展开明细"
    } else {
        "打开 $label 专属看板"
    }
    BoxWithConstraints(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .v2DataBarBackground(palette, color, barFraction)
            .clickable(role = Role.Button, onClickLabel = actionLabel, onClick = onClick)
            .semantics(mergeDescendants = true) {
                val secDesc = if (secondaryValue != null) "，$secondaryValue" else ""
                contentDescription = "$label，$accessibilityValue$secDesc，$accessibilityNote；$actionLabel"
                selectionState?.let { selected = it }
            }
            .padding(start = 4.dp, end = 4.dp, top = 8.dp, bottom = 10.dp)
    ) {
        val stacked = maxWidth < 280.dp || LocalDensity.current.fontScale > 1.3f
        val chevron: @Composable () -> Unit = {
            if (isExpanded != null) {
                val rotation by animateFloatAsState(
                    targetValue = if (isExpanded) 90f else 0f,
                    animationSpec = ledgerTween(LedgerMotion.STANDARD_MILLIS, ledgerMotionEnabled(palette.isEInk)),
                    label = "chevronRotation"
                )
                Icon(
                    Icons.Default.ChevronRight,
                    contentDescription = null,
                    tint = if (isExpanded) palette.blue else palette.faint,
                    modifier = Modifier
                        .size(16.dp)
                        .rotate(rotation)
                )
            } else {
                Icon(Icons.Default.ChevronRight, contentDescription = null, tint = palette.faint, modifier = Modifier.size(V2_ICON_INLINE))
            }
        }
        Row(verticalAlignment = Alignment.Top) {
            Box(Modifier.padding(top = 6.dp).size(8.dp).clip(CircleShape).background(color))
            Spacer(Modifier.width(8.dp))
            if (stacked) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        label,
                        color = palette.text,
                        fontSize = LedgerFont.body,
                        fontWeight = FontWeight.Medium,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        note,
                        color = palette.faint,
                        fontSize = LedgerFont.caption,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(value, color = palette.text, fontSize = LedgerFont.body, fontWeight = FontWeight.SemiBold)
                            if (secondaryValue != null) {
                                Text(secondaryValue, color = palette.amber, fontSize = LedgerFont.caption, fontWeight = FontWeight.Normal)
                            }
                        }
                        chevron()
                    }
                }
            } else {
                Column(Modifier.weight(1f)) {
                    Text(label, color = palette.text, fontSize = LedgerFont.label, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(note, color = palette.faint, fontSize = LedgerFont.caption, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(value, color = palette.text, fontSize = LedgerFont.label, fontWeight = FontWeight.SemiBold)
                    if (secondaryValue != null) {
                        Text(secondaryValue, color = palette.amber, fontSize = LedgerFont.caption, fontWeight = FontWeight.Normal)
                    }
                }
                chevron()
            }
        }
    }
}
