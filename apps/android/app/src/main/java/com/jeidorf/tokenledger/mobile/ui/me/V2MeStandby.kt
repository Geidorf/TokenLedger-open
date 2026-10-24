package com.jeidorf.tokenledger.mobile.ui.me

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.jeidorf.tokenledger.mobile.AmbientMode
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.resolveRenderProfile
import com.jeidorf.tokenledger.mobile.ui.ambient.V2AmbientModePreviewCard
import com.jeidorf.tokenledger.mobile.ui.ambient.V2EInkPreviewToggle
import com.jeidorf.tokenledger.mobile.ui.ambient.ambientCadenceLabel
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_CONTROL_HEIGHT
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_TEXT

/**
 * 「我的 › 待机屏 / 墨水屏」子页：预览舞台、进入全屏、显示模式、屏幕四块，与「我的」一级页同一套
 * 发丝线行卡片与字距加宽的眉题。
 *
 * 模式从一条挤在一起的五段条改成单选行：每档的说明直接写在行里，不用再点开才知道差别；
 * 外观是墨水屏设备的总开关，放在「屏幕」组里给一个就近入口，和偏好组里那一行是同一个设置。
 */
internal fun LazyListScope.v2MeStandbyItems(
    palette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    appearance: LedgerAppearance,
    ambientMode: AmbientMode,
    tokenDisplayMode: TokenDisplayMode,
    actions: V2MeActions,
    onAmbientModeChange: (AmbientMode) -> Unit,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit,
    onOpenLowPowerDisplay: () -> Unit
) {
    item(key = "me-standby-stage", contentType = "preview") {
        V2MeStandbyStage(palette, state, stats, appearance, ambientMode, tokenDisplayMode, onTokenDisplayModeChange)
    }
    item(key = "me-standby-launch", contentType = "action") {
        V2MeStandbyLaunchButton(palette, onOpenLowPowerDisplay)
    }
    item(key = "me-standby-modes-label", contentType = "eyebrow") { V2MeEyebrow(palette, "显示模式") }
    item(key = "me-standby-modes", contentType = "group") {
        V2MeStandbyModeGroup(palette, appearance, ambientMode, onAmbientModeChange)
    }
    item(key = "me-standby-screen-label", contentType = "eyebrow") { V2MeEyebrow(palette, "屏幕") }
    item(key = "me-standby-screen", contentType = "group") {
        V2MeStandbyScreenGroup(palette, appearance, ambientMode, actions)
    }
}

@Composable
private fun V2MeStandbyStage(
    palette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData,
    appearance: LedgerAppearance,
    mode: AmbientMode,
    tokenDisplayMode: TokenDisplayMode,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit
) {
    // 外观已是墨水屏时默认就看墨水屏画法；切换只换预览，不动应用外观。
    var einkPreview by rememberSaveable(appearance) { mutableStateOf(appearance == LedgerAppearance.EInk) }
    val largeText = LocalDensity.current.fontScale >= 1.5f
    Column(verticalArrangement = Arrangement.spacedBy(LedgerSpace.sm)) {
        val title: @Composable () -> Unit = {
            Column {
                Text(
                    "预览",
                    color = palette.muted,
                    style = LedgerType.caption.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.08.em)
                )
                Text(mode.label, color = palette.text, style = LedgerType.titleL, modifier = Modifier.semantics { heading() })
            }
        }
        // 大字号下标题与两段切换排不进一行，切换另起一行，不挤掉模式名。
        if (largeText) {
            title()
            V2EInkPreviewToggle(palette, einkPreview, { einkPreview = it })
        } else {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
                Box(Modifier.weight(1f)) { title() }
                V2EInkPreviewToggle(palette, einkPreview, { einkPreview = it })
            }
        }
        V2AmbientModePreviewCard(
            outerPalette = palette,
            state = state,
            stats = stats,
            appearance = appearance,
            mode = mode,
            einkPreview = einkPreview,
            tokenDisplayMode = tokenDisplayMode,
            onTokenDisplayModeChange = onTokenDisplayModeChange
        )
        Text(
            if (einkPreview) mode.einkSummary else mode.summary,
            color = palette.muted,
            style = LedgerType.meta,
            modifier = Modifier.padding(horizontal = 2.dp)
        )
    }
}

@Composable
private fun V2MeStandbyLaunchButton(palette: MobileV2Palette, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().heightIn(min = V2_CONTROL_HEIGHT),
        colors = ButtonDefaults.buttonColors(containerColor = palette.blue, contentColor = palette.onBlue),
        shape = CircleShape
    ) {
        Icon(Icons.Default.Fullscreen, contentDescription = null, modifier = Modifier.size(V2_ICON_INLINE))
        Spacer(Modifier.width(LedgerSpace.sm))
        Text("进入全屏摆件", style = LedgerType.label.copy(fontWeight = FontWeight.SemiBold))
    }
}

@Composable
private fun V2MeStandbyModeGroup(
    palette: MobileV2Palette,
    appearance: LedgerAppearance,
    selected: AmbientMode,
    onSelect: (AmbientMode) -> Unit
) {
    V2MeGroup(palette) {
        Column(Modifier.selectableGroup()) {
            AmbientMode.orderedForDisplay().forEachIndexed { index, mode ->
                if (index > 0) V2MeDivider(palette)
                val isSelected = mode == selected
                V2MeRow(
                    palette,
                    title = mode.label,
                    meta = if (appearance == LedgerAppearance.EInk) mode.einkSummary else mode.summary,
                    modifier = Modifier.selectable(selected = isSelected, role = Role.RadioButton, onClick = { onSelect(mode) }),
                    trailing = { V2MeRadioMark(palette, isSelected) }
                )
            }
        }
    }
}

/** 单选标记：选中是实心圆加对勾，未选是一圈发丝线；墨水屏只用黑白。 */
@Composable
private fun V2MeRadioMark(palette: MobileV2Palette, selected: Boolean) {
    val fill = if (palette.isEInk) palette.text else palette.blue
    Box(
        Modifier
            .size(V2_ICON_INLINE)
            .clip(CircleShape)
            .then(
                if (selected) Modifier.background(fill)
                else Modifier.border(LedgerStroke.hairline, palette.faint, CircleShape)
            )
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center
    ) {
        if (selected) {
            Icon(
                Icons.Default.Check,
                contentDescription = null,
                tint = if (palette.isEInk) palette.surface else palette.onBlue,
                modifier = Modifier.size(V2_ICON_TEXT)
            )
        }
    }
}

@Composable
private fun V2MeStandbyScreenGroup(
    palette: MobileV2Palette,
    appearance: LedgerAppearance,
    mode: AmbientMode,
    actions: V2MeActions
) {
    val profile = resolveRenderProfile(mode, appearance)
    val eink = appearance == LedgerAppearance.EInk
    var pickAppearance by rememberSaveable { mutableStateOf(false) }
    V2MeGroup(palette) {
        V2MeRow(
            palette,
            title = "外观",
            meta = if (eink) "整页黑白静态绘制，适合墨水屏" else "墨水屏设备请选 E-ink",
            value = appearance.label,
            chevron = true,
            onClick = { pickAppearance = true }
        )
        V2MeDivider(palette)
        V2MeRow(palette, title = "刷新", value = ambientCadenceLabel(profile))
        V2MeDivider(palette)
        // 只写全屏真正做的事：反色刷新由硬件识别决定（MainActivity 的 forceEInkRefresh），
        // 不随外观或模式开启，所以这里不按 profile.ghostBusting 许诺消影。
        V2MeRow(
            palette,
            title = "防残影",
            meta = if (eink) "识别为墨水屏的设备，进入或回到全屏时整屏刷新一次" else "省电、过热或关闭动画时停止位移",
            value = if (eink) "静态绘制" else "每分钟像素位移"
        )
        V2MeDivider(palette)
        V2MeRow(palette, title = "常亮", meta = "全屏期间不熄屏，也不在后台刷新", value = "仅全屏时")
    }
    if (pickAppearance) {
        V2MeChoiceDialog(
            "外观", LedgerAppearance.entries, appearance, { it.label },
            onDismiss = { pickAppearance = false },
            onSelect = { pickAppearance = false; actions.onAppearanceChange(it) }
        )
    }
}
