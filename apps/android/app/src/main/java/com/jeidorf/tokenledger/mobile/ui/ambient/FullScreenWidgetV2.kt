package com.jeidorf.tokenledger.mobile.ui.ambient

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.AmbientMode
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LowPowerPolicy
import com.jeidorf.tokenledger.mobile.PrivacyStore
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.dashboardQuerySummary
import com.jeidorf.tokenledger.mobile.resolveAmbientViewport
import com.jeidorf.tokenledger.mobile.resolveRenderProfile
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette

@Composable
internal fun FullScreenWidgetV2(
    state: DashboardUiState,
    appearance: LedgerAppearance,
    tokenDisplayMode: TokenDisplayMode,
    mode: AmbientMode,
    policy: LowPowerPolicy,
    onTokenDisplayModeChange: ((TokenDisplayMode) -> Unit)? = null
) {
    val palette = remember(appearance) { v2Palette(appearance) }
    val profile = remember(mode, appearance) { resolveRenderProfile(mode, appearance) }
    val stats = state.visibleData
    val systemDensity = LocalDensity.current
    val ambientDensity = Density(
        density = systemDensity.density,
        fontScale = systemDensity.fontScale
    )
    CompositionLocalProvider(
        LocalDensity provides ambientDensity,
        LocalCostMaskEnabled provides PrivacyStore.isCostMaskEnabled(LocalContext.current)
    ) {
        BoxWithConstraints(Modifier.fillMaxSize().background(palette.background)) {
            val viewport = remember(maxWidth, maxHeight) {
                resolveAmbientViewport(maxWidth.value, maxHeight.value)
            }
            Column(
                Modifier
                    .fillMaxSize()
                    .padding(
                        horizontal = viewport.horizontalPaddingDp.dp,
                        vertical = viewport.verticalPaddingDp.dp
                    )
            ) {
                Text(
                    dashboardQuerySummary(state.query),
                    color = palette.muted,
                    fontSize = LedgerFont.caption,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 8.dp)
                        .semantics { liveRegion = LiveRegionMode.Polite }
                )
                if (stats == null) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("等待可验证的看板快照", color = palette.muted)
                    }
                } else {
                    when (mode) {
                        AmbientMode.Glance -> V2AmbientGlance(
                            palette, state, stats, tokenDisplayMode, profile, onTokenDisplayModeChange
                        )
                        AmbientMode.Pulse -> V2AmbientPulse(
                            palette, state, stats, tokenDisplayMode, profile, onTokenDisplayModeChange
                        )
                        AmbientMode.Console -> V2AmbientConsole(
                            palette, state, stats, tokenDisplayMode, profile, policy, viewport,
                            onTokenDisplayModeChange
                        )
                        AmbientMode.QuotaWall -> V2AmbientQuotaWall(
                            palette, state, profile, policy, viewport
                        )
                        AmbientMode.Ledger -> V2AmbientLedger(
                            palette, state, stats, tokenDisplayMode, profile, policy, viewport,
                            onTokenDisplayModeChange
                        )
                    }
                }
            }
        }
    }
}
