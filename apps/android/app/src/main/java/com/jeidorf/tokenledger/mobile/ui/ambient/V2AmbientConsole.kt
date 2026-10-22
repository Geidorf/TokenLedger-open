package com.jeidorf.tokenledger.mobile.ui.ambient

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.AmbientFont
import com.jeidorf.tokenledger.mobile.AmbientRenderProfile
import com.jeidorf.tokenledger.mobile.AmbientViewportPolicy
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.LowPowerPolicy
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette

/**
 * D3 全息：升级前 `polished` 摆件的原样，加上一条显式的刷新节奏说明。
 */
@Composable
internal fun V2AmbientConsole(
    palette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    tokenDisplayMode: TokenDisplayMode,
    profile: AmbientRenderProfile,
    policy: LowPowerPolicy,
    viewport: AmbientViewportPolicy,
    onTokenDisplayModeChange: ((TokenDisplayMode) -> Unit)?
) {
    if (viewport.landscape) {
        V2LandscapeWidgetContent(
            palette,
            state,
            stats,
            profile,
            tokenDisplayMode,
            policy,
            viewport,
            onTokenDisplayModeChange
        )
        return
    }
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center
    ) {
        Box(Modifier.fillMaxWidth()) {
            V2WidgetPreview(
                palette,
                state,
                stats,
                profile,
                policy.visibleQuotaWindowLimit,
                tokenDisplayMode,
                onTokenDisplayModeChange = onTokenDisplayModeChange,
                showWordmark = false,
                showDailyQuote = true
            )
        }
        Spacer(Modifier.height(10.dp))
        Text(
            if (policy.allowMotion) "屏幕常亮 · 低频像素位移" else "屏幕常亮 · 静态绘制",
            color = palette.muted,
            fontSize = AmbientFont.small,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp)
        )
    }
}
