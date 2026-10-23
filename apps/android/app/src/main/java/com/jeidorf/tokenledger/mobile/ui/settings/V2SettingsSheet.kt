package com.jeidorf.tokenledger.mobile.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_CONTROL_HEIGHT
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius

@Composable
internal fun V2SettingsPage(
    palette: MobileV2Palette,
    state: DashboardUiState,
    appearance: LedgerAppearance,
    forceLandscape: Boolean,
    wide: Boolean,
    onAppearanceChange: (LedgerAppearance) -> Unit,
    onForceLandscapeChange: (Boolean) -> Unit,
    onOpenLowPowerDisplay: () -> Unit,
    onSignOut: () -> Unit
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 14.dp, end = 14.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("移动看板偏好", color = palette.text, fontSize = LedgerFont.subtitle, fontWeight = FontWeight.SemiBold)
            }
        }
        item {
            if (wide) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    V2OrientationSettings(palette, forceLandscape, onForceLandscapeChange, Modifier.weight(1f))
                    V2AppearanceSettings(palette, appearance, onAppearanceChange, Modifier.weight(1f))
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    V2OrientationSettings(palette, forceLandscape, onForceLandscapeChange)
                    V2AppearanceSettings(palette, appearance, onAppearanceChange)
                }
            }
        }
        item {
            if (wide) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    V2DataSettings(palette, state, Modifier.weight(1f))
                    V2WidgetSettings(palette, onOpenLowPowerDisplay, Modifier.weight(1f))
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    V2DataSettings(palette, state)
                    V2WidgetSettings(palette, onOpenLowPowerDisplay)
                }
            }
        }
        item {
            OutlinedButton(
                onClick = onSignOut,
                modifier = Modifier.fillMaxWidth().heightIn(min = V2_CONTROL_HEIGHT),
                border = BorderStroke(1.dp, palette.divider),
                shape = RoundedCornerShape(LedgerRadius.xl)
            ) {
                Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null, tint = palette.danger)
                Spacer(Modifier.width(8.dp))
                Text("退出登录", color = palette.danger)
            }
        }
    }
}
