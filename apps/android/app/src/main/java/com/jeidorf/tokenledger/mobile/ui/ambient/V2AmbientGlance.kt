package com.jeidorf.tokenledger.mobile.ui.ambient

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.coerceIn
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jeidorf.tokenledger.mobile.AmbientFont
import com.jeidorf.tokenledger.mobile.AmbientRenderProfile
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ambientRhythmSeries
import com.jeidorf.tokenledger.mobile.comparisonKindPresentation
import com.jeidorf.tokenledger.mobile.deltaPresentation
import com.jeidorf.tokenledger.mobile.displayedTokenCount
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.tokenModeToggle
import com.jeidorf.tokenledger.mobile.v2FormatTokens
import kotlin.math.max
import kotlin.math.min

/**
 * D1 一瞥：一个数字、一个涨跌、一条无坐标轴的走势线。
 *
 * 字号由可用尺寸反推而不是写死——这一档的验收标准是"3 米外可读"，写死的 sp 在
 * 平板与手机上会得到完全不同的物理字高。
 */
@Composable
internal fun V2AmbientGlance(
    palette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    profile: AmbientRenderProfile,
    onTokenDisplayModeChange: ((TokenDisplayMode) -> Unit)?
) {
    val tokens = displayedTokenCount(
        tokenDisplayMode,
        stats.summary.effectiveTokens,
        stats.summary.cachedTokens
    )
    val heroLabel = v2FormatTokens(tokens)
    val delta = deltaPresentation(stats.comparison?.delta?.tokens)
    val directionalDelta = ambientDirectionalDelta(delta)
    val series = remember(stats) { ambientRhythmSeries(stats.comparison, stats.trends) }
    val density = LocalDensity.current
    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .then(
                if (onTokenDisplayModeChange != null) {
                    Modifier.tokenModeToggle(tokenDisplayMode, onTokenDisplayModeChange)
                } else {
                    Modifier
                }
            )
            .semantics {
                contentDescription =
                    "一瞥模式。${state.query.range.label}${tokenDisplayMode.label} Token $heroLabel，$directionalDelta"
            }
    ) {
        val widthBudget = maxWidth.value / max(heroLabel.length, 3) * 1.68f
        val heightBudget = maxHeight.value * 0.42f
        val heroDp = min(widthBudget, heightBudget).coerceIn(56f, 240f)
        val heroSp = (heroDp / density.fontScale).sp
        Column(
            Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                "${state.query.range.label} · ${tokenDisplayMode.label} TOKEN · 更新 ${ambientUpdatedTime(state)}",
                color = palette.faint,
                fontSize = (heroDp * 0.085f).coerceIn(10f, 18f).sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 3.sp
            )
            Spacer(Modifier.height(12.dp))
            Text(
                heroLabel,
                color = palette.text,
                fontSize = heroSp,
                lineHeight = heroSp,
                fontWeight = FontWeight.Bold,
                letterSpacing = (-heroDp * 0.05f).sp,
                fontFamily = if (profile.useMonospaceNumerals) FontFamily.Monospace else FontFamily.Default,
                maxLines = 1
            )
            Spacer(Modifier.height(14.dp))
            Text(
                directionalDelta,
                color = palette.deltaColor(delta.tone),
                fontSize = (heroDp * 0.14f).coerceIn(14f, 34f).sp,
                fontWeight = FontWeight.Bold
            )
            Text(
                comparisonKindPresentation(stats.comparison?.window?.kind).heroBaselineLabel,
                color = palette.faint,
                fontSize = (heroDp * 0.075f).coerceIn(9f, 15f).sp
            )
            if (series.hasData) {
                Spacer(Modifier.height(26.dp))
                V2AmbientRhythmChart(
                    palette = palette,
                    series = series,
                    profile = profile,
                    modifier = Modifier
                        .fillMaxWidth(0.72f)
                        .height((this@BoxWithConstraints.maxHeight.value * 0.13f).coerceIn(36f, 96f).dp),
                    showPrevious = false,
                    fillArea = false
                )
            }
        }
        Text(
            ambientCadenceLabel(profile),
            color = palette.faint,
            fontSize = AmbientFont.small,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 6.dp)
        )
    }
}
