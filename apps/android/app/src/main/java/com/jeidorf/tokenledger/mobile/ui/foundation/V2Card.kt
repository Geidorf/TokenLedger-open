package com.jeidorf.tokenledger.mobile.ui.foundation

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp

/**
 * 标准卡（§4.4）：`card` 底、圆角 16（墨水屏 8）、内边距 16，纵深见 [ledgerCardDepth]。
 *
 * 不再用 M3 `Card`：它的 `tonalElevation` 会在卡片色恰好等于 `colorScheme.surface` 时叠一层
 * `surfaceTint`（深色下偏蓝），阴影在深色下又看不见。这里用不抬升的 `Surface` 承载语义
 * （遍历分组、挡住穿透的触摸）与内容色，底、边、影全部交给 [ledgerCardDepth]。
 */
@Composable
internal fun V2Card(
    palette: MobileV2Palette,
    modifier: Modifier = Modifier,
    cornerRadius: Dp = if (palette.isEInk) LedgerRadius.einkCard else LedgerRadius.lg,
    contentPadding: PaddingValues = PaddingValues(LedgerSpace.lg),
    content: @Composable ColumnScope.() -> Unit
) {
    val shape = RoundedCornerShape(cornerRadius)
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .ledgerCardDepth(palette.tokens, shape),
        shape = shape,
        color = Color.Transparent,
        contentColor = palette.text
    ) {
        Column(Modifier.fillMaxWidth().padding(contentPadding), content = content)
    }
}
