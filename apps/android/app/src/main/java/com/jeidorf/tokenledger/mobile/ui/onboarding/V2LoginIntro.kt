package com.jeidorf.tokenledger.mobile.ui.onboarding

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_TEXT

/** 登录页卡片下半部分：登录后还有哪几步，以及手机端不碰哪些东西。和首次启动引导同一套说法。 */
internal val V2_LOGIN_NEXT_STEPS = listOf(
    "在电脑上用同一个账户开启云端同步",
    "把锁屏设成网关路由动画",
    "在桌面放一个用量小组件"
)

@Composable
internal fun V2LoginIntro(palette: MobileV2Palette) {
    Column(verticalArrangement = Arrangement.spacedBy(LedgerSpace.sm)) {
        HorizontalDivider(color = palette.divider, thickness = LedgerStroke.hairline)
        Text(
            "这是第 1 步 · 接下来",
            color = palette.muted,
            style = LedgerType.caption.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.08.em),
            modifier = Modifier.padding(top = LedgerSpace.xs)
        )
        V2_LOGIN_NEXT_STEPS.forEachIndexed { index, text ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(20.dp)
                        .border(LedgerStroke.hairline, palette.divider, CircleShape)
                        .clearAndSetSemantics { },
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        "${index + 2}",
                        color = palette.muted,
                        style = LedgerType.caption.copy(letterSpacing = 0.em)
                    )
                }
                Spacer(Modifier.width(LedgerSpace.sm))
                Text(text, color = palette.text, style = LedgerType.meta)
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = LedgerSpace.xs), verticalAlignment = Alignment.Top) {
            Icon(
                Icons.Default.Lock,
                contentDescription = null,
                tint = palette.muted,
                modifier = Modifier.padding(top = LedgerSpace.hairline).size(V2_ICON_TEXT)
            )
            Spacer(Modifier.width(LedgerSpace.sm))
            Text(
                "手机只读云端汇总，不保存服务商密钥，也不直连 WebDAV。",
                color = palette.muted,
                style = LedgerType.meta
            )
        }
    }
}
