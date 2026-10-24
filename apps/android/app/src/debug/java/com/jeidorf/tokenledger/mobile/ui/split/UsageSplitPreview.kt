package com.jeidorf.tokenledger.mobile.ui.split

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.ProvideLedgerPalette
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.TokenLedgerTheme
import com.jeidorf.tokenledger.mobile.ledgerSnapshotFixture
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette

/** 「用量拆分」卡片截图夹具：同一份演示统计，按维度与指标各取一种状态。 */
@Composable
internal fun UsageSplitPreviewHost(
    appearance: LedgerAppearance,
    dimension: SplitDimension,
    metric: SplitMetric = SplitMetric.Tokens
) {
    val stats = requireNotNull(ledgerSnapshotFixture().data)
    TokenLedgerTheme(appearance) {
        ProvideLedgerPalette(appearance) {
            val palette = v2Palette(appearance)
            Box(Modifier.fillMaxSize().background(palette.background).padding(LedgerSpace.lg)) {
                V2UsageSplitCard(
                    palette = palette,
                    stats = stats,
                    tokenDisplayMode = TokenDisplayMode.Effective,
                    machineFiltered = false,
                    onOpenTool = {},
                    onOpenModel = {},
                    initialDimension = dimension,
                    initialMetric = metric
                )
            }
        }
    }
}
