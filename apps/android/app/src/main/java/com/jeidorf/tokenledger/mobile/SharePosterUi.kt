package com.jeidorf.tokenledger.mobile

import android.content.ActivityNotFoundException
import android.content.Intent
import android.view.View
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerPalettes
import com.jeidorf.tokenledger.mobile.widget.TokenLedgerWidget
import androidx.glance.appwidget.updateAll
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private data class ShareSheetColors(
    val backdrop: Color,
    val surface: Color,
    val raised: Color,
    val selected: Color,
    val text: Color,
    val muted: Color,
    val divider: Color,
    val accent: Color,
    val danger: Color,
    val primaryFill: Color,
    val onPrimaryFill: Color
)

private data class HostSafeBounds(val widthPx: Int, val heightPx: Int)

/**
 * Compose Dialog has its own window. On API 36 it may report zero local safe insets while its
 * decor still extends through the gesture area. Use the hosting activity view's actual root size
 * and system-bar/cutout insets to give the preview a stable, screen-safe content rectangle.
 */
private fun hostSafeBounds(view: View): HostSafeBounds? {
    val root = view.rootView ?: return null
    if (root.width <= 0 || root.height <= 0) return null
    val insets = ViewCompat.getRootWindowInsets(view)
        ?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        ?: return null
    val width = root.width - insets.left - insets.right
    val height = root.height - insets.top - insets.bottom
    return HostSafeBounds(width, height).takeIf { it.widthPx > 0 && it.heightPx > 0 }
}

/**
 * 分享面板的预览色板，只从 `LedgerTokens` 派生（T10.173 §3.1，T10.177）。墨水屏外观沿用浅色一套，
 * 与改造前一致。`selected` 是选中底（`primaryContainerSolid`），上面画 `accent` / `text`；
 * `accent` 取 `primary`（文字与图形用色）。主按钮用 `primaryFill` / `onPrimaryFill`（深 4.81、浅 5.73）：
 * 此前白字压在 `primary` 上，深色只有 2.66:1（root 决定 R-19）。海报本体的艺术色在 `SharePosterRenderer`，不在此列。
 */
private fun shareSheetColors(appearance: LedgerAppearance): ShareSheetColors {
    val tokens = if (appearance == LedgerAppearance.Dark) LedgerPalettes.Dark else LedgerPalettes.Light
    return ShareSheetColors(
        backdrop = tokens.page,
        surface = tokens.card,
        raised = tokens.raised,
        selected = tokens.primaryContainerSolid,
        text = tokens.text,
        muted = tokens.muted,
        divider = tokens.divider,
        accent = tokens.primary,
        danger = tokens.dangerText,
        primaryFill = tokens.primaryFill,
        onPrimaryFill = tokens.onPrimaryFill
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SharePosterSheet(
    stats: StatsData?,
    range: RangeKey,
    appearance: LedgerAppearance,
    onRangeChange: (RangeKey) -> Unit,
    onDismiss: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var costMasked by remember { mutableStateOf(PrivacyStore.isCostMaskEnabled(context)) }
    var generating by remember { mutableStateOf(false) }
    var generationError by remember { mutableStateOf<String?>(null) }
    // Never relabel a retained/legacy snapshot as a newly selected period. A missing range proof
    // degrades to the loading state until a response tied to this query arrives.
    val statsMatchRange = stats?.matchesShareRange(range) == true
    val summary = remember(stats, range, costMasked, statsMatchRange) {
        stats?.takeIf { statsMatchRange }?.let {
            buildShareSummary(it, range, costMasked, generatedAt = Instant.now())
        }
    }
    val colors = remember(appearance) { shareSheetColors(appearance) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = colors.backdrop,
        contentColor = colors.text
    ) {
        SharePosterPanel(
            summary = summary,
            selectedRange = range,
            appearance = appearance,
            costMasked = costMasked,
            generating = generating,
            generationError = generationError,
            onRangeChange = {
                generationError = null
                onRangeChange(it)
            },
            onCostMaskedChange = { next ->
                costMasked = next
                PrivacyStore.setCostMaskEnabled(context, next)
                scope.launch { runCatching { TokenLedgerWidget().updateAll(context.applicationContext) } }
            },
            onShare = { selectedSummary, layout ->
                if (!generating) {
                    scope.launch {
                        generating = true
                        generationError = null
                        runCatching {
                            withContext(Dispatchers.IO) {
                                SharePosterFileStore.createSharePayload(context, selectedSummary, layout)
                            }
                        }.onSuccess { payload ->
                            try {
                                context.startActivity(Intent.createChooser(payload.intent, "分享 TokenLedger 周期总结"))
                            } catch (error: ActivityNotFoundException) {
                                generationError = sharePosterFailureMessage(error)
                            } catch (error: SecurityException) {
                                generationError = sharePosterFailureMessage(error)
                            }
                        }.onFailure { error ->
                            generationError = sharePosterFailureMessage(error)
                        }
                        generating = false
                    }
                }
            }
        )
    }
}

@Composable
internal fun SharePosterPanel(
    summary: ShareSummary?,
    selectedRange: RangeKey,
    appearance: LedgerAppearance,
    costMasked: Boolean,
    generating: Boolean,
    generationError: String?,
    initialLayout: ShareLayoutKey = ShareLayoutKey.Scorecard,
    onRangeChange: (RangeKey) -> Unit,
    onCostMaskedChange: (Boolean) -> Unit,
    onShare: (ShareSummary, ShareLayoutKey) -> Unit
) {
    val context = LocalContext.current
    val largeText = LocalDensity.current.fontScale >= 1.5f
    val colors = remember(appearance) { shareSheetColors(appearance) }
    var selectedLayoutKey by rememberSaveable(initialLayout.stableKey) {
        mutableStateOf(initialLayout.stableKey)
    }
    var fullscreenLayoutKey by rememberSaveable { mutableStateOf<String?>(null) }
    val selectedLayout = ShareLayoutKey.entries.firstOrNull { it.stableKey == selectedLayoutKey }
        ?: ShareLayoutKey.Scorecard
    val previews = remember(summary) {
        summary?.let { value ->
            ShareLayoutKey.entries.associateWith { layout ->
                SharePosterRenderer.render(
                    context = context,
                    summary = value,
                    layout = layout,
                    width = SharePosterRenderer.PREVIEW_WIDTH,
                    height = SharePosterRenderer.PREVIEW_HEIGHT
                )
            }
        }.orEmpty()
    }
    DisposableEffect(previews) {
        onDispose { previews.values.forEach { bitmap -> bitmap.recycle() } }
    }
    val exportDimensions = remember(context) {
        SharePosterFileStore.targetExportDimensions(context)
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = 790.dp)
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .padding(top = if (largeText) 12.dp else 0.dp)
                .padding(bottom = if (summary == null) 24.dp else 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
        if (largeText) {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(
                    "生成周期总结",
                    color = colors.text,
                    fontSize = LedgerFont.title,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.semantics { heading() }
                )
                Text("按屏幕比例生成高清海报。", color = colors.muted, fontSize = LedgerFont.label)
                Surface(
                    shape = RoundedCornerShape(999.dp),
                    color = colors.raised
                ) {
                    Text(
                        "高清 ${exportDimensions.first} × ${exportDimensions.second}（${shareExportAspectLabel(exportDimensions.first, exportDimensions.second)}）",
                        color = colors.muted,
                        fontSize = LedgerFont.caption,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                    )
                }
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "生成周期总结",
                        color = colors.text,
                        fontSize = LedgerFont.title,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.semantics { heading() }
                    )
                    Text("按屏幕比例生成高清海报。", color = colors.muted, fontSize = LedgerFont.label)
                }
                Surface(
                    shape = RoundedCornerShape(999.dp),
                    color = colors.raised
                ) {
                    Text(
                        "高清 ${exportDimensions.first} × ${exportDimensions.second}（${shareExportAspectLabel(exportDimensions.first, exportDimensions.second)}）",
                        color = colors.muted,
                        fontSize = LedgerFont.caption,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                    )
                }
            }
        }

        SharePeriodSelector(colors, selectedRange, onRangeChange)

        if (summary == null) {
            Box(
                Modifier.fillMaxWidth().height(330.dp),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    CircularProgressIndicator(color = colors.accent)
                    Text("正在读取${selectedRange.label}数据…", color = colors.muted)
                }
            }
        } else {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center
            ) {
                Surface(
                    shape = RoundedCornerShape(18.dp),
                    color = colors.raised,
                    shadowElevation = 4.dp,
                    modifier = Modifier
                        .width(184.dp)
                        .clickable(
                            role = Role.Button,
                            onClickLabel = "打开全屏大图预览"
                        ) { fullscreenLayoutKey = selectedLayout.stableKey }
                        .semantics {
                            contentDescription = "${selectedLayout.label}海报预览，点击查看可缩放大图"
                        }
                ) {
                    previews[selectedLayout]?.let { bitmap ->
                        Image(
                            bitmap = bitmap.asImageBitmap(),
                            contentDescription = "${selectedLayout.label}完整 9 比 16 预览",
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }
            }
            Text(
                "点击海报查看大图，可双指缩放和拖动",
                color = colors.muted,
                fontSize = LedgerFont.caption,
                modifier = Modifier.align(Alignment.CenterHorizontally)
            )

            Text(
                "选择布局",
                color = colors.text,
                fontSize = LedgerFont.body,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.semantics { heading() }
            )
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                ShareLayoutKey.entries.forEach { layout ->
                    val selected = selectedLayout == layout
                    Column(
                        modifier = Modifier
                            .width(112.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .background(if (selected) colors.selected else colors.surface)
                            .then(
                                if (selected) Modifier.border(1.5.dp, colors.accent, RoundedCornerShape(12.dp))
                                else Modifier
                            )
                            .selectable(
                                selected = selected,
                                role = Role.RadioButton,
                                onClick = { selectedLayoutKey = layout.stableKey }
                            )
                            .semantics(mergeDescendants = true) {
                                this.selected = selected
                                role = Role.RadioButton
                                stateDescription = if (selected) "已选择" else "未选择"
                                contentDescription = "${layout.label}，${layout.description}"
                            }
                            .padding(8.dp)
                    ) {
                        previews[layout]?.let { bitmap ->
                            Image(
                                bitmap = bitmap.asImageBitmap(),
                                contentDescription = null,
                                contentScale = ContentScale.Fit,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(8.dp))
                            )
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(layout.label, color = colors.text, fontSize = LedgerFont.caption, fontWeight = FontWeight.SemiBold, maxLines = 1)
                        Text(layout.description, color = colors.muted, fontSize = LedgerFont.caption, lineHeight = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }

            HorizontalDivider(color = colors.divider)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .semantics(mergeDescendants = true) {
                        stateDescription = if (costMasked) "费用已隐藏" else "费用可显示"
                    },
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    imageVector = if (costMasked) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                    contentDescription = null,
                    tint = colors.muted
                )
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text("隐藏费用", color = colors.text, fontWeight = FontWeight.SemiBold, fontSize = LedgerFont.body)
                    Text(
                        if (costMasked) "海报不会接收费用数据" else "海报可显示可证明的费用（如缓存净节省）",
                        color = colors.muted,
                        fontSize = LedgerFont.caption
                    )
                }
                Switch(checked = costMasked, onCheckedChange = onCostMaskedChange)
            }

        }
        }

        if (summary != null) {
            Surface(
                color = colors.backdrop,
                tonalElevation = 3.dp,
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .navigationBarsPadding()
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    HorizontalDivider(color = colors.divider)
                    generationError?.let { error ->
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = colors.danger.copy(alpha = 0.12f)
                        ) {
                            Text(
                                error,
                                color = colors.danger,
                                fontSize = LedgerFont.caption,
                                modifier = Modifier
                                    .padding(12.dp)
                                    .semantics { liveRegion = LiveRegionMode.Assertive }
                            )
                        }
                    }
                    Button(
                        onClick = { onShare(summary, selectedLayout) },
                        enabled = !generating,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                        // 生成中按钮不可点，但转圈与「正在生成」是进度而不是禁用态，照样用主按钮的一对色。
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.primaryFill,
                            contentColor = colors.onPrimaryFill,
                            disabledContainerColor = colors.primaryFill,
                            disabledContentColor = colors.onPrimaryFill
                        ),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        if (generating) {
                            CircularProgressIndicator(color = colors.onPrimaryFill, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("正在生成 PNG…")
                        } else {
                            Icon(Icons.Default.Image, contentDescription = null)
                            Spacer(Modifier.width(8.dp))
                            Text(if (generationError == null) "生成图片并分享" else "重试生成图片", fontWeight = FontWeight.SemiBold)
                        }
                    }
                    Text(
                        "通过系统分享面板发送 image/png；不包含邮箱、设备 ID、会话 ID 或 API 地址。",
                        color = colors.muted,
                        fontSize = LedgerFont.caption,
                        lineHeight = 13.sp
                    )
                }
            }
        }
    }

    fullscreenLayoutKey
        ?.let { stableKey -> ShareLayoutKey.entries.firstOrNull { it.stableKey == stableKey } }
        ?.let { layout ->
            summary?.let { value ->
                SharePosterFullscreenPreview(
                    summary = value,
                    layout = layout,
                    onDismiss = { fullscreenLayoutKey = null }
                )
            }
        }
}

@Composable
private fun SharePosterFullscreenPreview(
    summary: ShareSummary,
    layout: ShareLayoutKey,
    onDismiss: () -> Unit
) {
    val context = LocalContext.current
    val hostView = LocalView.current
    val density = LocalDensity.current
    // Reading configuration re-evaluates the host bounds after an orientation change.
    val configuration = LocalConfiguration.current
    val safeBounds = remember(hostView, configuration.screenWidthDp, configuration.screenHeightDp) {
        hostSafeBounds(hostView)
    }
    val safeWidth = safeBounds?.let { with(density) { it.widthPx.toDp() } }
    val safeHeight = safeBounds?.let { with(density) { it.heightPx.toDp() } }
    val bitmap = remember(context, summary, layout) {
        val (width, height) = SharePosterFileStore.targetExportDimensions(context)
        SharePosterRenderer.render(context, summary, layout, width, height)
    }
    DisposableEffect(bitmap) {
        onDispose { bitmap.recycle() }
    }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    val transformState = rememberTransformableState { zoomChange, panChange, _ ->
        val nextScale = (scale * zoomChange).coerceIn(1f, 5f)
        scale = nextScale
        offset = if (nextScale == 1f) Offset.Zero else offset + panChange
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false
        )
    ) {
        Box(
            modifier = Modifier
                .then(
                    if (safeWidth != null && safeHeight != null) {
                        Modifier.width(safeWidth).height(safeHeight)
                    } else {
                        Modifier.fillMaxSize()
                    }
                )
                .background(Color.Black)
                .semantics {
                    contentDescription = "${layout.label}全屏大图预览，可双指或双击缩放并拖动"
                }
        ) {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 12.dp, vertical = 52.dp)
                    .graphicsLayer(
                        scaleX = scale,
                        scaleY = scale,
                        translationX = offset.x,
                        translationY = offset.y
                    )
                    .pointerInput(Unit) {
                        detectTapGestures(
                            onDoubleTap = {
                                if (scale > 1f) {
                                    scale = 1f
                                    offset = Offset.Zero
                                } else {
                                    scale = 2.5f
                                }
                            }
                        )
                    }
                    .transformable(transformState)
            )
            Surface(
                color = Color.Black.copy(alpha = 0.72f),
                shape = RoundedCornerShape(999.dp),
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(start = 16.dp, top = 18.dp)
            ) {
                Text(
                    "${layout.label} · ${bitmap.width} × ${bitmap.height} · ${String.format(java.util.Locale.US, "%.1f", scale)}×",
                    color = Color.White,
                    fontSize = LedgerFont.caption,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
                )
            }
            IconButton(
                onClick = onDismiss,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(end = 10.dp, top = 8.dp)
                    .semantics { contentDescription = "关闭大图预览" }
            ) {
                Icon(Icons.Default.Close, contentDescription = null, tint = Color.White)
            }
            Text(
                "双指或双击缩放 · 拖动查看细节",
                color = Color.White.copy(alpha = 0.78f),
                fontSize = LedgerFont.caption,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 20.dp)
            )
        }
    }
}

@Composable
private fun SharePeriodSelector(
    colors: ShareSheetColors,
    selectedRange: RangeKey,
    onRangeChange: (RangeKey) -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            "总结周期",
            color = colors.text,
            fontSize = LedgerFont.body,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.semantics { heading() }
        )
        if (selectedRange == RangeKey.Custom) {
            Text(
                "当前海报使用已加载的自定义区间；也可切换为下方预设周期。",
                color = colors.muted,
                fontSize = LedgerFont.label
            )
        }
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val wrapPeriods = shouldWrapSharePeriodSelector(
                widthDp = maxWidth.value.toInt(),
                fontScale = LocalDensity.current.fontScale
            )
            if (wrapPeriods) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SHARE_PERIOD_RANGES.chunked(3).forEach { rowRanges ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            rowRanges.forEach { range ->
                                SharePeriodOption(
                                    colors = colors,
                                    range = range,
                                    selected = selectedRange == range,
                                    onRangeChange = onRangeChange,
                                    modifier = Modifier.weight(1f)
                                )
                            }
                            repeat(3 - rowRanges.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    SHARE_PERIOD_RANGES.forEach { range ->
                        SharePeriodOption(
                            colors = colors,
                            range = range,
                            selected = selectedRange == range,
                            onRangeChange = onRangeChange
                        )
                    }
                }
            }
        }
    }
}

/** 分享面板只能直接发起无需额外日期参数的查询。 */
internal val SHARE_PERIOD_RANGES = listOf(
    RangeKey.Today,
    RangeKey.Week,
    RangeKey.Month,
    RangeKey.Year,
    RangeKey.All
)

@Composable
private fun SharePeriodOption(
    colors: ShareSheetColors,
    range: RangeKey,
    selected: Boolean,
    onRangeChange: (RangeKey) -> Unit,
    modifier: Modifier = Modifier
) {
    TextButton(
        onClick = { onRangeChange(range) },
        modifier = modifier
            .heightIn(min = 48.dp)
            .widthIn(min = 66.dp)
            .semantics {
                this.selected = selected
                role = Role.RadioButton
                stateDescription = if (selected) "已选择" else "未选择"
            },
        colors = ButtonDefaults.textButtonColors(
            containerColor = if (selected) colors.selected else colors.surface,
            contentColor = if (selected) colors.accent else colors.muted
        ),
        shape = RoundedCornerShape(11.dp)
    ) {
        Text(
            if (range == RangeKey.All) "里程碑" else range.label,
            fontSize = LedgerFont.label,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal
        )
    }
}

@Composable
internal fun SharePosterPreviewHost(
    summary: ShareSummary,
    appearance: LedgerAppearance = LedgerAppearance.Dark,
    initialLayout: ShareLayoutKey = ShareLayoutKey.Scorecard
) {
    Box(Modifier.fillMaxSize().background(shareSheetColors(appearance).backdrop), contentAlignment = Alignment.BottomCenter) {
        SharePosterPanel(
            summary = summary,
            selectedRange = summary.range,
            appearance = appearance,
            costMasked = summary.costMasked,
            generating = false,
            generationError = null,
            initialLayout = initialLayout,
            onRangeChange = {},
            onCostMaskedChange = {},
            onShare = { _, _ -> }
        )
    }
}
