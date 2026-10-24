package com.jeidorf.tokenledger.mobile.ui.onboarding

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.jeidorf.tokenledger.mobile.DashboardUiState
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.StatsData
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerRadius
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerSpace
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_TEXT
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_TOUCH_TARGET
import com.jeidorf.tokenledger.mobile.ui.me.V2MeChoiceDialog
import com.jeidorf.tokenledger.mobile.ui.me.V2MeDivider
import com.jeidorf.tokenledger.mobile.ui.me.V2MeEyebrow
import com.jeidorf.tokenledger.mobile.ui.me.V2MeGroup
import com.jeidorf.tokenledger.mobile.ui.me.V2MeSystemLinks

/** 截图夹具钉死系统事实用；正式运行时为 null，照常读系统。 */
internal val LocalV2DeviceFactsOverride = staticCompositionLocalOf<V2DeviceFacts?> { null }

/** 从系统壁纸页、桌面添加小组件回来时状态会变，每次回到前台重读一次；预览里不碰系统服务。 */
@Composable
internal fun rememberV2DeviceFacts(): V2DeviceFacts {
    LocalV2DeviceFactsOverride.current?.let { return it }
    val context = LocalContext.current
    val inspection = LocalInspectionMode.current
    var facts by remember { mutableStateOf(V2DeviceFacts()) }
    val lifecycleOwner = LocalLifecycleOwner.current
    if (!inspection) {
        LaunchedEffect(lifecycleOwner, context) {
            lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                facts = V2DeviceFacts(
                    wallpaper = V2MeSystemLinks.wallpaperState(context),
                    placedWidgets = V2MeSystemLinks.placedWidgetCount(context),
                    canPinWidget = V2MeSystemLinks.canPinWidget(context)
                )
            }
        }
    }
    return facts
}

/**
 * 首次启动引导（整屏，盖住看板与底栏）。读事实、接系统入口，画面交给 [V2FirstRunGuideContent]。
 * [onClose] 的参数表示四步是否都已完成：完成记 Completed，否则记 Dismissed，之后都不再自动打开。
 */
@Composable
internal fun V2FirstRunGuide(
    palette: MobileV2Palette,
    state: DashboardUiState,
    stats: StatsData?,
    onRefresh: () -> Unit,
    onClose: (completed: Boolean) -> Unit
) {
    val context = LocalContext.current
    val device = rememberV2DeviceFacts()
    val steps = v2OnboardingSteps(v2OnboardingFacts(state, stats, device))
    var showWidgetPicker by rememberSaveable { mutableStateOf(false) }
    V2FirstRunGuideContent(
        palette = palette,
        steps = steps,
        refreshing = state.dashboardLoading,
        onAction = { action ->
            when (action) {
                V2OnboardingAction.Recheck -> onRefresh()
                V2OnboardingAction.SetWallpaper -> V2MeSystemLinks.openWallpaperPicker(context)
                V2OnboardingAction.AddWidget -> showWidgetPicker = true
            }
        },
        onClose = { onClose(steps.all { it.status == V2OnboardingStatus.Done }) }
    )
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

@Composable
internal fun V2FirstRunGuideContent(
    palette: MobileV2Palette,
    steps: List<V2OnboardingStep>,
    refreshing: Boolean,
    onAction: (V2OnboardingAction) -> Unit,
    onClose: () -> Unit
) {
    val done = steps.doneCount()
    val allDone = done == steps.size
    Box(
        Modifier
            .fillMaxSize()
            .background(palette.background)
            .safeDrawingPadding(),
        contentAlignment = Alignment.TopCenter
    ) {
        Column(
            Modifier
                .widthIn(max = 560.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = LedgerSpace.lg, vertical = LedgerSpace.sm),
            verticalArrangement = Arrangement.spacedBy(LedgerSpace.md)
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                V2MeEyebrow(palette, "开始使用 · 已完成 $done/${steps.size}")
                Spacer(Modifier.weight(1f))
                if (!allDone) {
                    TextButton(onClick = onClose, modifier = Modifier.heightIn(min = V2_TOUCH_TARGET)) {
                        Text("稍后再说", style = LedgerType.label, color = palette.muted)
                    }
                }
            }
            Text(
                "把手机接上桌面账本",
                style = LedgerType.titleL,
                color = palette.text,
                modifier = Modifier.semantics { heading() }
            )
            Text(
                "手机读取桌面端同步到云端的用量与路由，不保存服务商密钥，也不直连 WebDAV。" +
                    "做完这四步，锁屏和桌面都能看到实时用量。",
                style = LedgerType.body,
                color = palette.muted
            )
            V2OnboardingProgress(palette, steps)
            V2MeGroup(palette) {
                steps.forEachIndexed { index, step ->
                    if (index > 0) V2MeDivider(palette)
                    V2OnboardingStepRow(palette, index + 1, step, refreshing, onAction)
                }
            }
            V2EmptyPrimaryButton(palette, V2EmptyAction(if (allDone) "完成" else "进入看板", onClick = onClose))
            V2EmptyFootnote(palette, "以后可以在「我的 › 接入步骤」重新打开。")
            Spacer(Modifier.height(LedgerSpace.lg))
        }
    }
}

/** 四段进度条：完成的段填主色，其余发丝线色。 */
@Composable
private fun V2OnboardingProgress(palette: MobileV2Palette, steps: List<V2OnboardingStep>) {
    val description = "已完成 ${steps.doneCount()} 步，共 ${steps.size} 步"
    Row(
        Modifier
            .fillMaxWidth()
            .clearAndSetSemantics { contentDescription = description },
        horizontalArrangement = Arrangement.spacedBy(LedgerSpace.xs)
    ) {
        steps.forEach { step ->
            val filled = step.status == V2OnboardingStatus.Done
            Box(
                Modifier
                    .weight(1f)
                    .height(LedgerSpace.xs)
                    .clip(RoundedCornerShape(LedgerRadius.xs))
                    .background(
                        when {
                            !filled -> palette.divider
                            palette.isEInk -> palette.text
                            else -> palette.blue
                        }
                    )
            )
        }
    }
}

@Composable
private fun V2OnboardingStepRow(
    palette: MobileV2Palette,
    number: Int,
    step: V2OnboardingStep,
    refreshing: Boolean,
    onAction: (V2OnboardingAction) -> Unit
) {
    val statusText = when (step.status) {
        V2OnboardingStatus.Done -> "已完成"
        V2OnboardingStatus.Todo -> "待完成"
        V2OnboardingStatus.Blocked -> "暂不可用"
        V2OnboardingStatus.Unknown -> "读取中"
    }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = LedgerSpace.md + LedgerSpace.hairline, vertical = LedgerSpace.md)
    ) {
        V2OnboardingBadge(palette, number, step.status)
        Spacer(Modifier.width(LedgerSpace.md))
        Column(Modifier.weight(1f)) {
            Row(
                Modifier.semantics(mergeDescendants = true) {
                    heading()
                    stateDescription = statusText
                },
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    step.title,
                    style = LedgerType.label,
                    color = if (step.status == V2OnboardingStatus.Blocked) palette.muted else palette.text,
                    modifier = Modifier.weight(1f, fill = false)
                )
                Spacer(Modifier.width(LedgerSpace.sm))
                Text(
                    statusText,
                    style = LedgerType.caption,
                    color = when (step.status) {
                        V2OnboardingStatus.Done -> palette.green
                        V2OnboardingStatus.Todo -> palette.amber
                        else -> palette.faint
                    },
                    modifier = Modifier.clearAndSetSemantics { }
                )
            }
            Text(
                step.detail,
                style = LedgerType.meta,
                color = palette.muted,
                modifier = Modifier.padding(top = LedgerSpace.hairline)
            )
            val action = step.action
            if (action != null && step.actionLabel != null && step.status == V2OnboardingStatus.Todo) {
                val busy = action == V2OnboardingAction.Recheck && refreshing
                OutlinedButton(
                    onClick = { onAction(action) },
                    enabled = !busy,
                    shape = RoundedCornerShape(LedgerRadius.md),
                    border = BorderStroke(LedgerStroke.hairline, palette.outline),
                    contentPadding = PaddingValues(horizontal = LedgerSpace.lg),
                    modifier = Modifier
                        .padding(top = LedgerSpace.sm)
                        .heightIn(min = V2_TOUCH_TARGET)
                ) {
                    Text(if (busy) "检查中…" else step.actionLabel, style = LedgerType.label, color = palette.text)
                }
            }
        }
    }
}

/** 步骤号圆标：完成是实心对勾，待完成是描边数字，做不了或读取中是淡色数字。 */
@Composable
private fun V2OnboardingBadge(palette: MobileV2Palette, number: Int, status: V2OnboardingStatus) {
    val size = 28.dp
    val modifier = Modifier
        .size(size)
        .clip(CircleShape)
        .clearAndSetSemantics { }
    if (status == V2OnboardingStatus.Done) {
        Box(
            modifier.background(if (palette.isEInk) palette.text else palette.blue),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                Icons.Default.Check,
                contentDescription = null,
                tint = if (palette.isEInk) palette.background else palette.onBlue,
                modifier = Modifier.size(V2_ICON_TEXT)
            )
        }
    } else {
        Box(
            modifier.border(
                LedgerStroke.hairline,
                if (status == V2OnboardingStatus.Todo) palette.outline else palette.divider,
                CircleShape
            ),
            contentAlignment = Alignment.Center
        ) {
            Text(
                "$number",
                style = LedgerType.caption.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.em),
                color = if (status == V2OnboardingStatus.Todo) palette.text else palette.faint
            )
        }
    }
}
