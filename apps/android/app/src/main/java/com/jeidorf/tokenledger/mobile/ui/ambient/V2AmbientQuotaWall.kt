package com.jeidorf.tokenledger.mobile.ui.ambient

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jeidorf.tokenledger.mobile.AmbientFont
import com.jeidorf.tokenledger.mobile.AmbientRenderProfile
import com.jeidorf.tokenledger.mobile.AmbientViewportPolicy
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.LowPowerPolicy
import com.jeidorf.tokenledger.mobile.ProgressStyle
import com.jeidorf.tokenledger.mobile.QuotaUiState
import com.jeidorf.tokenledger.mobile.QuotaWallVisual
import com.jeidorf.tokenledger.mobile.ambientQuotaWallColumns
import com.jeidorf.tokenledger.mobile.drawableProgressWindows
import com.jeidorf.tokenledger.mobile.localizedDisplayName
import com.jeidorf.tokenledger.mobile.next
import com.jeidorf.tokenledger.mobile.orderedQuotaProvidersForDisplay
import com.jeidorf.tokenledger.mobile.quotaProgressWindowsForDisplay
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.v2QuotaReason

/**
 * D4 额度墙：大号半环仪表盘网格。
 */
@Composable
internal fun V2AmbientQuotaWall(
    palette: MobileV2Palette,
    state: DashboardUiState,
    profile: AmbientRenderProfile,
    policy: LowPowerPolicy,
    viewport: AmbientViewportPolicy
) {
    val quota = state.quota as? QuotaUiState.Available
    val providers = quota?.snapshot?.providers.orEmpty()
    val allWindows = quotaProgressWindowsForDisplay(providers, Int.MAX_VALUE)
    var visual by rememberSaveable { mutableStateOf(QuotaWallVisual.Ring) }
    val policyLimit = policy.visibleQuotaWindowLimit.coerceAtLeast(0)
    val budgetedCount = allWindows.size.coerceAtMost(policyLimit)
    val columns = ambientQuotaWallColumns(budgetedCount, viewport.landscape)
    val capacity = columns * 2
    val shown = allWindows.take(policy.visibleQuotaWindowLimit.coerceAtMost(capacity).coerceAtLeast(0))
    val hidden = allWindows.size - shown.size
    val nextVisualLabel = if (visual == QuotaWallVisual.Ring) "条形图" else "环形图"
    val visualProfile = profile.copy(
        progressStyle = when (visual) {
            QuotaWallVisual.Ring -> profile.progressStyle
            QuotaWallVisual.Bar -> ProgressStyle.Bar
        }
    )
    Column(
        Modifier
            .fillMaxSize()
            .clickable(role = Role.Button, onClickLabel = "切换为$nextVisualLabel") { visual = visual.next() }
            .semantics {
                contentDescription = "额度墙，当前为${if (visual == QuotaWallVisual.Ring) "环形图" else "条形图"}"
                stateDescription = "点击切换为$nextVisualLabel"
            },
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "额度墙",
                color = palette.faint,
                fontSize = AmbientFont.small,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.6.sp
            )
            Spacer(Modifier.weight(1f))
            Text(
                if (hidden > 0) {
                    "${shown.size}/${allWindows.size} 个来源 · 点击切换$nextVisualLabel"
                } else {
                    "${allWindows.size} 个来源 · 点击切换$nextVisualLabel"
                },
                color = palette.muted,
                fontSize = AmbientFont.body
            )
        }
        if (shown.isEmpty()) {
            Column(
                Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text("暂无可绘制的额度窗口", color = palette.text, fontSize = AmbientFont.titleLarge)
                Spacer(Modifier.height(6.dp))
                Text("未同步不代表 0%", color = palette.faint, fontSize = AmbientFont.bodyLarge)
            }
        } else {
            Column(
                Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                shown.chunked(columns).forEach { row ->
                    Row(
                        Modifier.fillMaxWidth().weight(1f),
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        val centerOddPortrait = !viewport.landscape && row.size == 1 && columns == 2
                        if (centerOddPortrait) Spacer(Modifier.weight(0.5f))
                        row.forEach { (provider, window) ->
                            if (visual == QuotaWallVisual.Ring) {
                                V2AmbientQuotaRing(
                                    palette = palette,
                                    provider = provider,
                                    window = window,
                                    forceStale = quota?.showingCachedData == true,
                                    profile = visualProfile,
                                    modifier = Modifier.fillMaxHeight().weight(1f),
                                    emphasized = true
                                )
                            } else {
                                V2AmbientQuotaBarCard(
                                    palette = palette,
                                    provider = provider,
                                    window = window,
                                    forceStale = quota?.showingCachedData == true,
                                    profile = visualProfile,
                                    modifier = Modifier.fillMaxHeight().weight(1f)
                                )
                            }
                        }
                        if (centerOddPortrait) {
                            Spacer(Modifier.weight(0.5f))
                        } else {
                            repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }
            }
        }
        (state.quota as? QuotaUiState.Available)?.snapshot?.providers
            ?.orderedQuotaProvidersForDisplay()
            ?.filter { it.drawableProgressWindows().isEmpty() }
            ?.forEach { provider ->
                Text(
                    "${provider.localizedDisplayName()} · ${v2QuotaReason(provider.reasonCode, provider.scope)}",
                    color = palette.faint,
                    fontSize = AmbientFont.body,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        V2AmbientQuotaFreshnessLine(palette, state, profile, Modifier.fillMaxWidth())
    }
}
