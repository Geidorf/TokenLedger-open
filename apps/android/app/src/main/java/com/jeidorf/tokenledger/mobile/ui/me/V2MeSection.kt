package com.jeidorf.tokenledger.mobile.ui.me

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Monitor
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.filled.Wallpaper
import androidx.compose.material.icons.filled.Widgets
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.jeidorf.tokenledger.mobile.AmbientMode
import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.LocalDashboardCurrency
import com.jeidorf.tokenledger.mobile.LocalLedgerNow
import com.jeidorf.tokenledger.mobile.LocalSetDashboardCurrency
import com.jeidorf.tokenledger.mobile.LocalToggleCostMask
import com.jeidorf.tokenledger.mobile.QuotaUiState
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.TokenDisplayMode
import com.jeidorf.tokenledger.mobile.ui.ambient.v2WidgetItems
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_TEXT
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_TOUCH_TARGET

/** 「我的」页要往外调的动作。偏好类的回调直接改持久化设置，由上层回写状态。 */
internal class V2MeActions(
    val forceLandscape: Boolean = false,
    val onAppearanceChange: (LedgerAppearance) -> Unit = {},
    val onForceLandscapeChange: (Boolean) -> Unit = {},
    val onSignOut: () -> Unit = {}
)

/**
 * 「我的」一级页（重构 R5）：账号、同步、展示、偏好四组，行式卡片 + 字距加宽的小节眉题。
 *
 * 手机端只读云端，不做 WebDAV 与密钥管理；这两行照实写明在桌面端，不放假的开关。
 * 待机屏 / 墨水屏是一层子页，沿用原「展示」页的模式条、预览与全屏入口。
 */
internal fun LazyListScope.v2MeItems(
    palette: MobileV2Palette,
    page: V2MePage,
    onPageChange: (V2MePage) -> Unit,
    state: DashboardUiState,
    stats: StatsData?,
    appearance: LedgerAppearance,
    ambientMode: AmbientMode,
    tokenDisplayMode: TokenDisplayMode,
    actions: V2MeActions,
    onAmbientModeChange: (AmbientMode) -> Unit,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit,
    onOpenLowPowerDisplay: () -> Unit,
    onRefresh: () -> Unit
) {
    when (page) {
        V2MePage.Standby -> {
            item(key = "me-standby-header", contentType = "heading") {
                V2MeSubPageHeader(palette, "待机屏 / 墨水屏") { onPageChange(V2MePage.Root) }
            }
            if (stats != null) {
                v2WidgetItems(
                    palette, state, stats, appearance, ambientMode, tokenDisplayMode,
                    onAmbientModeChange, onTokenDisplayModeChange, onOpenLowPowerDisplay
                )
            } else {
                item(key = "me-standby-empty", contentType = "status") {
                    V2Card(palette) {
                        Text("还没有可展示的数据", color = palette.text, style = LedgerType.titleS)
                        Text(
                            "桌面端同步后，这里可以预览待机屏，并进入全屏摆件。",
                            color = palette.muted,
                            style = LedgerType.meta
                        )
                    }
                }
            }
        }
        V2MePage.Root -> {
            item(key = "me-account", contentType = "account") { V2MeAccountCard(palette, state) }
            item(key = "me-sync-label", contentType = "eyebrow") { V2MeEyebrow(palette, "同步") }
            item(key = "me-sync", contentType = "group") { V2MeSyncCard(palette, state, onRefresh) }
            item(key = "me-display-label", contentType = "eyebrow") { V2MeEyebrow(palette, "展示") }
            item(key = "me-display", contentType = "group") {
                V2MeDisplayCard(palette, appearance, ambientMode) { onPageChange(V2MePage.Standby) }
            }
            item(key = "me-prefs-label", contentType = "eyebrow") { V2MeEyebrow(palette, "偏好") }
            item(key = "me-prefs", contentType = "group") {
                V2MePreferencesCard(palette, appearance, tokenDisplayMode, actions, onTokenDisplayModeChange)
            }
            item(key = "me-data-label", contentType = "eyebrow") { V2MeEyebrow(palette, "数据") }
            item(key = "me-data", contentType = "group") { V2MeDataCard(palette, state) }
            if (state.session != null) {
                item(key = "me-sign-out", contentType = "group") {
                    V2MeGroup(palette) {
                        V2MeRow(palette, title = "退出登录", titleColor = palette.danger, onClick = actions.onSignOut)
                    }
                }
            }
        }
    }
}

@Composable
internal fun V2MeEyebrow(palette: MobileV2Palette, text: String) {
    Text(
        text,
        color = palette.muted,
        style = LedgerType.caption.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.08.em),
        modifier = Modifier
            .padding(start = 2.dp, top = LedgerSpace.xs)
            .semantics { heading() }
    )
}

/** 一组行：发丝线卡片，行与行之间一条发丝线，不再给每行单独描边。 */
@Composable
internal fun V2MeGroup(palette: MobileV2Palette, content: @Composable ColumnScope.() -> Unit) {
    V2Card(palette, cornerRadius = if (palette.isEInk) LedgerRadius.einkCard else LedgerRadius.xl, contentPadding = PaddingValues(0.dp)) {
        content()
    }
}

@Composable
internal fun V2MeDivider(palette: MobileV2Palette) {
    HorizontalDivider(color = palette.divider, thickness = LedgerStroke.hairline)
}

@Composable
internal fun V2MeRow(
    palette: MobileV2Palette,
    title: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    meta: String? = null,
    metaDot: Color? = null,
    value: String? = null,
    titleColor: Color = palette.text,
    chevron: Boolean = false,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null
) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = V2_TOUCH_TARGET + 8.dp)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (icon != null) {
            V2MeIconTile(palette, icon)
            Spacer(Modifier.width(LedgerSpace.md))
        }
        Column(Modifier.weight(1f)) {
            Text(title, color = titleColor, style = LedgerType.label)
            if (meta != null) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                    if (metaDot != null) {
                        Box(Modifier.size(6.dp).clip(CircleShape).background(metaDot).clearAndSetSemantics { })
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(meta, color = palette.muted, style = LedgerType.meta, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        if (value != null) {
            Spacer(Modifier.width(LedgerSpace.sm))
            // 值可能比标题长（数据组的口径说明），让它和标题分一行的宽度，最多折两行。
            Text(
                value,
                color = palette.muted,
                style = LedgerType.meta,
                textAlign = TextAlign.End,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1.2f, fill = false)
            )
        }
        if (trailing != null) {
            Spacer(Modifier.width(LedgerSpace.sm))
            trailing()
        }
        if (chevron) {
            Text(
                "›",
                color = palette.muted,
                style = LedgerType.titleM,
                modifier = Modifier.padding(start = 6.dp).clearAndSetSemantics { }
            )
        }
    }
}

@Composable
private fun V2MeIconTile(palette: MobileV2Palette, icon: ImageVector) {
    val shape = RoundedCornerShape(LedgerRadius.lg)
    Box(
        Modifier
            .size(30.dp)
            .clip(shape)
            .then(
                if (palette.isEInk) Modifier.border(LedgerStroke.hairline, palette.text, shape)
                else Modifier.background(palette.raised)
            ),
        contentAlignment = Alignment.Center
    ) {
        Icon(icon, contentDescription = null, tint = palette.muted, modifier = Modifier.size(V2_ICON_TEXT))
    }
}

@Composable
private fun V2MeSubPageHeader(palette: MobileV2Palette, title: String, onBack: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Box(
            Modifier
                .size(V2_TOUCH_TARGET)
                .clip(CircleShape)
                .clickable(role = Role.Button, onClickLabel = "返回我的", onClick = onBack),
            contentAlignment = Alignment.Center
        ) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回我的", tint = palette.text)
        }
        Text(title, color = palette.text, style = LedgerType.titleM, modifier = Modifier.semantics { heading() })
    }
}

@Composable
private fun V2MeAccountCard(palette: MobileV2Palette, state: DashboardUiState) {
    val account = v2MeAccount(state)
    V2MeGroup(palette) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .then(
                        if (palette.isEInk) Modifier.border(LedgerStroke.hairline, palette.text, CircleShape)
                        else Modifier.background(palette.blueSoft)
                    )
                    .clearAndSetSemantics { },
                contentAlignment = Alignment.Center
            ) {
                Text(account.initial, color = if (palette.isEInk) palette.text else palette.blue, style = LedgerType.titleS)
            }
            Spacer(Modifier.width(LedgerSpace.md))
            Column(Modifier.weight(1f)) {
                Text(
                    account.title,
                    color = palette.text,
                    style = LedgerType.titleS,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                    if (account.signedIn) {
                        Box(Modifier.size(6.dp).clip(CircleShape).background(palette.green).clearAndSetSemantics { })
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(account.status, color = palette.muted, style = LedgerType.meta)
                }
            }
        }
    }
}

@Composable
private fun V2MeSyncCard(palette: MobileV2Palette, state: DashboardUiState, onRefresh: () -> Unit) {
    val sync = v2MeSync(state, LocalLedgerNow.current())
    val dot = when (sync.tone) {
        V2MeSyncTone.Ok -> palette.green
        V2MeSyncTone.Stale -> palette.amber
        V2MeSyncTone.Missing -> palette.faint
    }
    V2MeGroup(palette) {
        V2MeRow(
            palette,
            title = "云端同步",
            icon = Icons.Default.Cloud,
            meta = sync.summary,
            metaDot = dot,
            value = if (state.dashboardLoading) "刷新中" else "刷新",
            onClick = if (state.dashboardLoading) null else onRefresh
        )
        V2MeDivider(palette)
        V2MeRow(
            palette,
            title = "WebDAV 备份",
            icon = Icons.Default.Storage,
            meta = "在桌面端设置；手机经云端读取，不直连 WebDAV",
            value = "桌面端"
        )
        V2MeDivider(palette)
        V2MeRow(
            palette,
            title = "服务商密钥",
            icon = Icons.Default.Key,
            meta = "只保存在桌面端本机安全存储，手机不保存",
            value = "桌面端"
        )
    }
}

@Composable
private fun V2MeDisplayCard(
    palette: MobileV2Palette,
    appearance: LedgerAppearance,
    ambientMode: AmbientMode,
    onOpenStandby: () -> Unit
) {
    val context = LocalContext.current
    val inspection = LocalInspectionMode.current
    var wallpaper by remember { mutableStateOf(V2MeWallpaperState.Unavailable) }
    var placedWidgets by remember { mutableIntStateOf(0) }
    var canPin by remember { mutableStateOf(false) }
    var showWidgetPicker by rememberSaveable { mutableStateOf(false) }
    val lifecycleOwner = LocalLifecycleOwner.current
    if (!inspection) {
        // 从系统壁纸页、桌面添加小组件回来时状态会变，每次回到前台重读一次。
        LaunchedEffect(lifecycleOwner, context) {
            lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                wallpaper = V2MeSystemLinks.wallpaperState(context)
                placedWidgets = V2MeSystemLinks.placedWidgetCount(context)
                canPin = V2MeSystemLinks.canPinWidget(context)
            }
        }
    }
    V2MeGroup(palette) {
        V2MeRow(
            palette,
            title = "锁屏动态壁纸",
            icon = Icons.Default.Wallpaper,
            meta = v2MeWallpaperMeta(wallpaper),
            value = v2MeWallpaperValue(wallpaper),
            chevron = wallpaper != V2MeWallpaperState.Unavailable,
            onClick = if (wallpaper == V2MeWallpaperState.Unavailable) null else {
                { V2MeSystemLinks.openWallpaperPicker(context); Unit }
            }
        )
        V2MeDivider(palette)
        V2MeRow(
            palette,
            title = "桌面小组件",
            icon = Icons.Default.Widgets,
            meta = if (canPin || inspection) "今日用量 · 额度 · 综合看板" else "在桌面长按空白处添加",
            value = v2MeWidgetValue(placedWidgets),
            chevron = canPin,
            onClick = if (canPin) { { showWidgetPicker = true } } else null
        )
        V2MeDivider(palette)
        V2MeRow(
            palette,
            title = "待机屏 / 墨水屏",
            icon = Icons.Default.Monitor,
            meta = if (appearance == LedgerAppearance.EInk) "${ambientMode.label} · 墨水屏低频刷新" else "${ambientMode.label} · 充电时常亮显示",
            chevron = true,
            onClick = onOpenStandby
        )
    }
    if (showWidgetPicker) {
        V2MeChoiceDialog(
            title = "添加桌面小组件",
            options = V2MeSystemLinks.WidgetKind.entries,
            selected = null,
            label = { stringResource(it.labelRes) },
            onDismiss = { showWidgetPicker = false },
            onSelect = { kind ->
                showWidgetPicker = false
                V2MeSystemLinks.requestPinWidget(context, kind)
            }
        )
    }
}

private enum class V2MePreferenceDialog { Appearance, Currency, TokenMode }

@Composable
private fun V2MePreferencesCard(
    palette: MobileV2Palette,
    appearance: LedgerAppearance,
    tokenDisplayMode: TokenDisplayMode,
    actions: V2MeActions,
    onTokenDisplayModeChange: (TokenDisplayMode) -> Unit
) {
    val currency = LocalDashboardCurrency.current
    val setCurrency = LocalSetDashboardCurrency.current
    val costMasked = LocalCostMaskEnabled.current
    val toggleCostMask = LocalToggleCostMask.current
    var dialog by rememberSaveable { mutableStateOf<V2MePreferenceDialog?>(null) }
    V2MeGroup(palette) {
        V2MeRow(palette, title = "外观", value = appearance.label, chevron = true, onClick = { dialog = V2MePreferenceDialog.Appearance })
        V2MeDivider(palette)
        V2MeRow(palette, title = "货币", value = "${currency.code} · ${currency.label}", chevron = true, onClick = { dialog = V2MePreferenceDialog.Currency })
        V2MeDivider(palette)
        V2MeRow(palette, title = "Token 口径", value = tokenDisplayMode.label, chevron = true, onClick = { dialog = V2MePreferenceDialog.TokenMode })
        V2MeDivider(palette)
        V2MeSwitchRow(palette, "隐藏费用", "截图或投屏时把费用换成 ••", costMasked) { toggleCostMask() }
        V2MeDivider(palette)
        V2MeSwitchRow(
            palette,
            "强制横屏",
            if (actions.forceLandscape) "多窗口下仍服从系统给的窗口尺寸" else "跟随系统方向",
            actions.forceLandscape,
            actions.onForceLandscapeChange
        )
    }
    when (dialog) {
        V2MePreferenceDialog.Appearance -> V2MeChoiceDialog(
            "外观", LedgerAppearance.entries, appearance, { it.label },
            onDismiss = { dialog = null },
            onSelect = { dialog = null; actions.onAppearanceChange(it) }
        )
        V2MePreferenceDialog.Currency -> V2MeChoiceDialog(
            "货币", CurrencyUnit.entries, currency, { "${it.code} · ${it.label}" },
            onDismiss = { dialog = null },
            onSelect = { dialog = null; setCurrency(it) }
        )
        V2MePreferenceDialog.TokenMode -> V2MeChoiceDialog(
            "Token 口径", TokenDisplayMode.entries, tokenDisplayMode, {
                if (it == TokenDisplayMode.Effective) "有效（输入 + 输出）" else "含缓存（另计缓存读写）"
            },
            onDismiss = { dialog = null },
            onSelect = { dialog = null; onTokenDisplayModeChange(it) }
        )
        null -> Unit
    }
}

@Composable
private fun V2MeSwitchRow(
    palette: MobileV2Palette,
    title: String,
    meta: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit
) {
    V2MeRow(
        palette,
        title = title,
        meta = meta,
        modifier = Modifier.toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange),
        trailing = { Switch(checked = checked, onCheckedChange = null) }
    )
}

@Composable
private fun V2MeDataCard(palette: MobileV2Palette, state: DashboardUiState) {
    V2MeGroup(palette) {
        V2MeRow(palette, title = "统计口径", value = "有效 Token = 输入 + 输出")
        V2MeDivider(palette)
        V2MeRow(palette, title = "缓存", value = "读写单列，不计入有效 Token")
        V2MeDivider(palette)
        V2MeRow(
            palette,
            title = "Stats v2",
            value = if ((state.visibleData?.meta?.contractVersion ?: 1) >= 2) "已启用" else "兼容模式"
        )
        V2MeDivider(palette)
        V2MeRow(
            palette,
            title = "额度快照",
            value = when (val quota = state.quota) {
                is QuotaUiState.Available -> if (quota.showingCachedData) "本机历史快照" else "已同步"
                else -> "未同步"
            }
        )
    }
}

@Composable
private fun <T> V2MeChoiceDialog(
    title: String,
    options: List<T>,
    selected: T?,
    label: @Composable (T) -> String,
    onDismiss: () -> Unit,
    onSelect: (T) -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                options.forEach { option ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = V2_TOUCH_TARGET)
                            .selectable(selected = option == selected, role = Role.RadioButton, onClick = { onSelect(option) }),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        if (selected != null) {
                            RadioButton(selected = option == selected, onClick = null)
                            Spacer(Modifier.width(LedgerSpace.sm))
                        }
                        Text(label(option), style = LedgerType.body)
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}
