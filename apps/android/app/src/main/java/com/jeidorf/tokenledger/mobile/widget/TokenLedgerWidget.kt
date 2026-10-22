package com.jeidorf.tokenledger.mobile.widget

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.compose.ui.graphics.toArgb
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.jeidorf.tokenledger.mobile.MainActivity
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus

/**
 * Ledger Rings Android 桌面小组件家族（T8.8）。实例配置决定内容，尺寸只做诚实降级：
 * 环形额度、单行消耗与组合卡不会再因为 4×2/2×2 断点而被静默替换成另一种组件。
 */
internal class TokenLedgerWidget(
    private val defaultMode: WidgetMode = WidgetMode.BarUsage,
    private val fixedMode: Boolean = false
) : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val appWidgetId = runCatching {
            GlanceAppWidgetManager(context).getAppWidgetId(id)
        }.getOrDefault(INVALID_APPWIDGET_ID)
        val config = if (appWidgetId == INVALID_APPWIDGET_ID) {
            WidgetConfig(mode = defaultMode)
        } else {
            WidgetConfigStore.load(context, appWidgetId, defaultMode).let { stored ->
                if (fixedMode) stored.copy(mode = defaultMode) else stored
            }
        }
        val state = WidgetStateRepository(context).load(config.range.rangeKey)
        provideContent { WidgetBody(state, config) }
    }

    private companion object {
        const val INVALID_APPWIDGET_ID = -1
    }
}

@Composable
internal fun WidgetBody(
    state: WidgetState,
    config: WidgetConfig,
    costMasked: Boolean = com.jeidorf.tokenledger.mobile.PrivacyStore.isCostMaskEnabled(LocalContext.current)
) {
    val colors = rememberWidgetColors(config.theme)
    val size = LocalSize.current
    val fontScale = LocalContext.current.resources.configuration.fontScale
    val fontCompensation = widgetFontCompensation(
        fontScale = fontScale,
        maxRenderedScale = if (WidgetMetrics.isShort(size.height)) 1f else 1.2f
    )
    val visibleSummary = if (state is WidgetState.Ready) {
        val count = state.displayedProviders(config).size
        when (config.mode) {
            WidgetMode.MultiRing -> widgetRingLayout(size.width.value, size.height.value, fontScale, count)
                .let { if (count > 0 && it.visibleCount == 0) "；尺寸不足，请放大小组件" else
                    if (count > it.visibleCount) "；+${count - it.visibleCount} 来源" else "" }
            WidgetMode.BarUsage -> widgetComboLayout(size.width.value, size.height.value, fontScale, count)
                .let { if (!it.sufficient) "；尺寸不足，请放大以同时显示消耗与额度" else
                    if (count > it.visibleCount) "；+${count - it.visibleCount} 来源" else "" }
            else -> ""
        }
    } else ""
    CompositionLocalProvider(
        LocalWidgetColors provides colors,
        LocalWidgetFontCompensation provides fontCompensation
    ) {
        val root = GlanceModifier
            .fillMaxSize()
            .appWidgetBackground()
            .background(colors.background)
            .widgetContainerCorner()
            .clickable(actionStartActivity<MainActivity>())
            .semantics {
                contentDescription = widgetLayoutDescription(state, config, costMasked) + visibleSummary + "；双击打开 TokenLedger"
            }

        Box(root, contentAlignment = Alignment.Center) {
            when (state) {
                WidgetState.NeedLogin -> CenterMessage("! 需要登录", "打开 TokenLedger 完成登录")
                WidgetState.NoData -> CenterMessage("— 暂无数据", "打开应用同步")
                is WidgetState.Ready -> Box(
                    GlanceModifier.fillMaxSize().padding(
                        horizontal = WidgetMetrics.horizontalPadding(size.width),
                        vertical = WidgetMetrics.verticalPadding(size.height)
                    )
                ) {
                    when (config.mode) {
                        WidgetMode.MultiRing -> MultiRingQuotaCard(
                            state.displayedProviders(config),
                            size,
                            fontScale
                        )
                        WidgetMode.SingleUsage -> SingleUsageCard(state.usage, size, fontScale, costMasked)
                        WidgetMode.MultiBar -> MultiBarQuotaCard(
                            state.displayedProviders(config),
                            size,
                            fontScale
                        )
                        WidgetMode.BarUsage -> BarUsageComboCard(
                            providers = state.displayedProviders(config),
                            usage = state.usage,
                            size = size,
                            fontScale = fontScale,
                            costMasked = costMasked
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun WidgetHeaderRow(title: String = "TokenLedger") {
    val colors = LocalWidgetColors.current
    Row(
        modifier = GlanceModifier.fillMaxWidth().padding(bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        WidgetText(
            title,
            colors.text,
            11.sp,
            FontWeight.Bold,
            modifier = GlanceModifier.defaultWeight()
        )
    }
}

@Composable
private fun MultiRingQuotaCard(
    providers: List<WidgetQuotaProvider>,
    size: DpSize,
    fontScale: Float
) {
    if (providers.isEmpty()) {
        CenterMessage("额度未同步", "打开应用完成一次同步")
        return
    }
    val plan = widgetRingLayout(size.width.value, size.height.value, fontScale, providers.size)
    if (plan.visibleCount == 0) {
        // 不复用通用长提示的额外padding/15sp标题，避免大字窄宿主产生省略号。
        Column(GlanceModifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally,
            verticalAlignment = Alignment.CenterVertically) {
            WidgetText("尺寸不足", LocalWidgetColors.current.text, 11.sp, align = TextAlign.Center)
            WidgetText("请放大", LocalWidgetColors.current.muted, 11.sp, align = TextAlign.Center)
        }
        return
    }
    val visible = providers.take(plan.visibleCount)
    val hidden = providers.size - visible.size
    if (plan.compactOverflow) {
        val provider = visible.single()
        Column(GlanceModifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally,
            verticalAlignment = Alignment.CenterVertically) {
            WidgetText(shortProviderName(provider.name) + if (hidden > 0) " · +$hidden" else "",
                LocalWidgetColors.current.text, 11.sp, FontWeight.Bold, align = TextAlign.Center)
            Spacer(GlanceModifier.height(2.dp))
            // 最终布局服从RemoteViews父容器，不把options中的宽度再写成固定子View宽度。
            Row(GlanceModifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally,
                verticalAlignment = Alignment.CenterVertically) {
                QuotaRingGauge(provider, plan.diameterDp.dp)
                Spacer(GlanceModifier.width(6.dp))
                Column() {
                    WidgetText(widgetQuotaCaption(provider), providerCaptionColor(provider), 11.sp, maxLines = 2)
                    WidgetText("${widgetQuotaStatusSymbol(provider)} ${statusLabel(provider.status)}",
                        providerAccentColor(LocalWidgetColors.current, provider), 11.sp)
                }
            }
        }
        return
    }
    Column(GlanceModifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(GlanceModifier.defaultWeight().fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically) {
            visible.forEach { provider ->
                Column(GlanceModifier.defaultWeight(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalAlignment = Alignment.CenterVertically) {
                    QuotaRingGauge(provider, plan.diameterDp.dp)
                    WidgetText(shortProviderName(provider.name) +
                        if (plan.compactOverflow && hidden > 0) " · +$hidden" else "", LocalWidgetColors.current.text,
                        11.sp, FontWeight.Bold, align = TextAlign.Center)
                    WidgetText(widgetQuotaCaption(provider), providerCaptionColor(provider),
                        11.sp, align = TextAlign.Center)
                    WidgetText("${widgetQuotaStatusSymbol(provider)} ${statusLabel(provider.status)}",
                        providerAccentColor(LocalWidgetColors.current, provider), 11.sp,
                        align = TextAlign.Center)
                }
            }
        }
        if (hidden > 0 && !plan.compactOverflow) WidgetText("+$hidden 来源", LocalWidgetColors.current.muted, 11.sp)
    }
}

@Composable
private fun SingleUsageCard(
    usage: WidgetUsage?,
    size: DpSize,
    fontScale: Float,
    isCostMasked: Boolean
) {
    val colors = LocalWidgetColors.current
    if (usage == null) {
        CenterMessage("用量未同步", "打开应用完成一次同步")
        return
    }
    val description = widgetUsageDescription(usage, isCostMasked)
    val modifier = GlanceModifier.fillMaxSize().semantics { contentDescription = description }
    when (widgetUsageLayout(size.width.value, size.height.value, fontScale)) {
        WidgetUsageLayout.PrimaryOnly -> Row(
            modifier = modifier,
            verticalAlignment = Alignment.CenterVertically
        ) {
            WidgetText(
                "${usage.range.label} ${formatCompactTokens(usage.effectiveTokens)}",
                colors.text,
                if (WidgetMetrics.isNarrow(size.width)) 15.sp else 17.sp,
                FontWeight.Bold,
                modifier = GlanceModifier.defaultWeight()
            )
        }

        WidgetUsageLayout.Stacked -> Column(
            modifier = modifier,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(
                modifier = GlanceModifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                WidgetText(
                    "${usage.range.label}有效 Token",
                    colors.muted,
                    9.sp,
                    modifier = GlanceModifier.defaultWeight()
                )
                WidgetText(
                    formatCompactTokens(usage.effectiveTokens),
                    colors.text,
                    17.sp,
                    FontWeight.Bold,
                    align = TextAlign.End
                )
            }
            Spacer(GlanceModifier.height(2.dp))
            WidgetText(
                "预估费用 ${formatCny(usage.costCny, isCostMasked)}",
                colors.text, 10.sp, FontWeight.Bold,
                modifier = GlanceModifier.fillMaxWidth()
            )
            WidgetText("更新于 ${usage.freshnessText}", colors.muted, 8.sp,
                align = TextAlign.End, modifier = GlanceModifier.fillMaxWidth())
        }

        WidgetUsageLayout.Split -> Row(
            modifier = modifier,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = GlanceModifier.defaultWeight()) {
                WidgetText("${usage.range.label}有效 Token", colors.muted, 9.sp)
                WidgetText(
                    formatCompactTokens(usage.effectiveTokens),
                    colors.text,
                    if (WidgetMetrics.isNarrow(size.width)) 17.sp else 21.sp,
                    FontWeight.Bold
                )
            }
            Spacer(GlanceModifier.width(10.dp))
            Column(modifier = GlanceModifier.defaultWeight(), horizontalAlignment = Alignment.End) {
                WidgetText("预估费用", colors.muted, 8.sp, align = TextAlign.End)
                WidgetText(formatCny(usage.costCny, isCostMasked), colors.text, 11.sp, FontWeight.Bold)
                if (size.width >= 210.dp) {
                    WidgetText("更新于 ${usage.freshnessText}", colors.faint, 8.sp, align = TextAlign.End)
                }
            }
        }
    }
}

@Composable
private fun MultiBarQuotaCard(
    providers: List<WidgetQuotaProvider>,
    size: DpSize,
    fontScale: Float
) {
    if (providers.isEmpty()) {
        CenterMessage("额度未同步", "打开应用完成一次同步")
        return
    }
    val compact = WidgetMetrics.isShort(size.height) || fontScale >= 1.4f
    val visibleProviders = providers.take(
        visibleWidgetProviderCount(
            providerCount = providers.size,
            widthDp = size.width.value,
            heightDp = if (fontScale < 1.4f) 100f else size.height.value,
            fontScale = fontScale
        )
    )
    Column(
        modifier = GlanceModifier.fillMaxSize(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (!compact) {
            WidgetHeaderRow()
        }
        visibleProviders.forEachIndexed { index, provider ->
            if (index > 0) {
                Spacer(GlanceModifier.height(if (compact) 2.dp else 6.dp))
            }
            ProviderBarRow(provider, compact)
        }
        val hiddenCount = providers.size - visibleProviders.size
        if (hiddenCount > 0) {
            Spacer(GlanceModifier.height(2.dp))
            WidgetText("+$hiddenCount 来源", LocalWidgetColors.current.muted, 8.sp)
        }
        providers.firstOrNull { it.status == QuotaProviderStatus.Stale }?.let { stale ->
            Spacer(GlanceModifier.height(2.dp))
            WidgetText(
                "更新于 ${stale.freshnessText}",
                LocalWidgetColors.current.amber,
                8.sp
            )
        }
    }
}

@Composable
private fun ProviderBarRow(provider: WidgetQuotaProvider, compact: Boolean = false) {
    val colors = LocalWidgetColors.current
    val window = provider.primary
    val status = provider.status
    val mayShowValue =
        status == QuotaProviderStatus.Ok || status == QuotaProviderStatus.Stale
    val fraction = window?.availableFraction.takeIf { mayShowValue }
    val progressColor = providerAccentArgb(colors, provider)
    val barBitmap = remember(fraction, status, colors.night) {
        createBarBitmap(
            fraction = fraction ?: 0f,
            trackArgb = colors.trackArgb,
            progressArgb = progressColor
        )
    }

    Column(
        modifier = GlanceModifier
            .fillMaxWidth()
            .semantics { contentDescription = providerAccessibilityDescription(provider) }
    ) {
        Row(
            modifier = GlanceModifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            StatusDot(provider, compact)
            Spacer(GlanceModifier.width(if (compact) 4.dp else 5.dp))
            WidgetText(
                shortProviderName(provider.name),
                colors.text,
                if (compact) 9.sp else 11.sp,
                FontWeight.Bold,
                modifier = GlanceModifier.defaultWeight()
            )
            // 窗口标签常驻。真机截图（2026-07-25）里这一行只有"Codex 100%"，用户无从判断这
            // 100% 说的是周额度还是 5 小时窗口——而当时它说的正是后者。一个不写明窗口的百分比
            // 没有意义，compact 版面也不例外；替换窗口同时显示“替代”文字，不能只靠高亮色。
            if (status == QuotaProviderStatus.Ok && window != null) {
                WidgetText(
                    formatWidgetWindowLabel(window.label, provider.primaryIsRoleSubstitute),
                    if (provider.primaryIsRoleSubstitute) colors.amber else colors.faint,
                    8.sp
                )
                Spacer(GlanceModifier.width(if (compact) 3.dp else 5.dp))
            }
            WidgetText(
                when {
                    status == QuotaProviderStatus.Ok -> window?.availableText ?: "不可用"
                    status == QuotaProviderStatus.Stale ->
                        window?.availableText?.let { "$it 历史" } ?: "历史数据"
                    else -> statusLabel(status)
                },
                if (status == QuotaProviderStatus.Ok) colors.text else providerAccentColor(colors, provider),
                if (compact) 9.sp else 11.sp,
                FontWeight.Bold
            )
            formatHiddenWindowCount(provider.hiddenWindowCount)?.let { hiddenLabel ->
                Spacer(GlanceModifier.width(if (compact) 3.dp else 5.dp))
                WidgetText(hiddenLabel, colors.faint, 8.sp, FontWeight.Medium)
            }
        }
        Spacer(GlanceModifier.height(if (compact) 2.dp else 4.dp))
        Image(
            provider = ImageProvider(barBitmap),
            contentDescription = null,
            modifier = GlanceModifier.fillMaxWidth().height(if (compact) 5.dp else 8.dp),
            contentScale = ContentScale.FillBounds
        )
    }
}

@Composable
private fun BarUsageComboCard(
    providers: List<WidgetQuotaProvider>,
    usage: WidgetUsage?,
    size: DpSize,
    fontScale: Float,
    costMasked: Boolean
) {
    val colors = LocalWidgetColors.current
    val plan = widgetComboLayout(size.width.value, size.height.value, fontScale, providers.size)
    if (!plan.sufficient) {
        CenterMessage("尺寸不足", "请放大以同时显示消耗与额度")
        return
    }
    Column(GlanceModifier.fillMaxSize()) {
        Column(GlanceModifier.fillMaxWidth().height(plan.usageHeightDp.dp),
            verticalAlignment = Alignment.CenterVertically) {
            if (usage == null) {
                WidgetText("— 用量未同步", colors.text, 12.sp, FontWeight.Bold)
            } else if (plan.stackedUsage) {
                Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    WidgetText("${usage.range.label}有效 Token", colors.muted, 9.sp,
                        modifier = GlanceModifier.defaultWeight())
                    WidgetText(formatCompactTokens(usage.effectiveTokens),
                        colors.text, 17.sp, FontWeight.Bold, align = TextAlign.End)
                }
                WidgetText("预估 ${formatCny(usage.costCny, costMasked)}", colors.muted, 12.sp)
            } else {
                Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(GlanceModifier.defaultWeight()) {
                        WidgetText("${usage.range.label}有效 Token", colors.muted, 11.sp)
                        WidgetText(formatCompactTokens(usage.effectiveTokens), colors.text, 22.sp, FontWeight.Bold)
                    }
                    Spacer(GlanceModifier.width(12.dp))
                    Column(GlanceModifier.defaultWeight(), horizontalAlignment = Alignment.End) {
                        WidgetText("预估费用", colors.muted, 11.sp, align = TextAlign.End)
                        WidgetText(formatCny(usage.costCny, costMasked), colors.text, 15.sp, FontWeight.Bold,
                            align = TextAlign.End)
                    }
                }
            }
        }
        Spacer(GlanceModifier.height(4.dp))
        Box(GlanceModifier.fillMaxWidth().height(1.dp).background(colors.divider)) {}
        Spacer(GlanceModifier.height(6.dp))
        if (providers.isEmpty()) {
            WidgetText("— 额度未同步", colors.text, 12.sp, FontWeight.Bold)
        } else {
            val hidden = providers.size - plan.visibleCount
            providers.take(plan.visibleCount).forEachIndexed { index, provider ->
                ComboQuotaRow(provider, plan.quotaRowHeightDp,
                    hiddenSources = if (index == plan.visibleCount - 1) hidden else 0)
            }
        }
    }
}

@Composable
private fun ComboQuotaRow(provider: WidgetQuotaProvider, heightDp: Float, hiddenSources: Int) {
    val colors = LocalWidgetColors.current
    val fraction = provider.primary?.availableFraction.takeIf {
        provider.status == QuotaProviderStatus.Ok || provider.status == QuotaProviderStatus.Stale
    }
    val bitmap = remember(fraction, provider.status, colors.night) {
        createBarBitmap(fraction ?: 0f, colors.trackArgb, providerAccentArgb(colors, provider))
    }
    Column(GlanceModifier.fillMaxWidth().height(heightDp.dp)
        .semantics { contentDescription = providerAccessibilityDescription(provider) + "，" + widgetQuotaCaption(provider) }) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            WidgetText("${widgetQuotaStatusSymbol(provider)} ${shortProviderName(provider.name)}",
                colors.text, 11.sp, FontWeight.Bold, modifier = GlanceModifier.defaultWeight())
            WidgetText(widgetQuotaValue(provider), providerAccentColor(colors, provider), 11.sp, FontWeight.Bold)
        }
        WidgetText(widgetQuotaCaption(provider) +
            (if (hiddenSources > 0) " · +$hiddenSources 来源" else ""), colors.muted, 11.sp)
        Spacer(GlanceModifier.height(2.dp))
        Image(ImageProvider(bitmap), contentDescription = null,
            modifier = GlanceModifier.fillMaxWidth().height(4.dp), contentScale = ContentScale.FillBounds)
    }
}

@Composable
private fun QuotaRingGauge(provider: WidgetQuotaProvider?, diameter: Dp) {
    val colors = LocalWidgetColors.current
    val window = provider?.primary
    val fraction = window?.availableFraction
    val status = provider?.status ?: QuotaProviderStatus.Unsupported
    val ringColor = when (status) {
        QuotaProviderStatus.Stale, QuotaProviderStatus.AuthRequired -> colors.amberArgb
        QuotaProviderStatus.Error -> colors.dangerArgb
        else -> fraction?.let { widgetProgressArgb(colors, it) } ?: colors.faintArgb()
    }
    val bitmap = remember(fraction, status, colors.night) {
        createRingBitmap(
            fraction = when {
                status == QuotaProviderStatus.Ok || status == QuotaProviderStatus.Stale ->
                    fraction ?: 0f
                status == QuotaProviderStatus.Error -> 1f
                else -> 0f
            },
            trackArgb = colors.trackArgb,
            progressArgb = ringColor
        )
    }
    val description = when {
        provider == null -> "额度尚未同步"
        else -> providerAccessibilityDescription(provider)
    }
    Box(
        modifier = GlanceModifier
            .size(diameter)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center
    ) {
        Image(
            provider = ImageProvider(bitmap),
            contentDescription = null,
            modifier = GlanceModifier.fillMaxSize(),
            contentScale = ContentScale.Fit
        )
        WidgetText(
            if (status == QuotaProviderStatus.Ok || status == QuotaProviderStatus.Stale) {
                window?.availableText ?: "—"
            } else {
                "—"
            },
            if (status == QuotaProviderStatus.Ok) colors.text else providerAccentColor(colors, provider),
            if (diameter >= 56.dp) 17.sp else 14.sp,
            FontWeight.Bold,
            align = TextAlign.Center
        )
    }
}

private fun createBarBitmap(fraction: Float, trackArgb: Int, progressArgb: Int): Bitmap {
    val width = 720
    val height = 32
    val radius = 16f
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }
    val rect = RectF(0f, 0f, width.toFloat(), height.toFloat())
    paint.color = trackArgb
    canvas.drawRoundRect(rect, radius, radius, paint)

    if (fraction > 0f) {
        val path = android.graphics.Path().apply {
            addRoundRect(rect, radius, radius, android.graphics.Path.Direction.CW)
        }
        canvas.save()
        canvas.clipPath(path)
        paint.color = progressArgb
        val fillWidth = width * fraction.coerceIn(0f, 1f)
        canvas.drawRect(0f, 0f, fillWidth, height.toFloat(), paint)
        canvas.restore()
    }
    return bitmap
}

private fun createRingBitmap(fraction: Float, trackArgb: Int, progressArgb: Int): Bitmap {
    val side = 384
    val stroke = 32f
    val bitmap = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val bounds = RectF(stroke / 2f, stroke / 2f, side - stroke / 2f, side - stroke / 2f)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = stroke
        strokeCap = Paint.Cap.ROUND
    }
    paint.color = trackArgb
    canvas.drawArc(bounds, -90f, 360f, false, paint)
    if (fraction > 0f) {
        paint.color = progressArgb
        canvas.drawArc(bounds, -90f, 360f * fraction.coerceIn(0f, 1f), false, paint)
    }
    return bitmap
}

@Composable
private fun DeltaBadge(delta: WidgetDelta) {
    val colors = LocalWidgetColors.current
    Box(
        GlanceModifier.cornerRadius(8.dp).background(colors.amberTrack).padding(horizontal = 5.dp, vertical = 3.dp),
        contentAlignment = Alignment.Center
    ) {
        WidgetText(
            formatDeltaArrow(delta.direction) + formatDeltaPercent(delta.percent),
            deltaColor(colors, delta.direction),
            9.sp,
            FontWeight.Bold
        )
    }
}

@Composable
private fun CenterMessage(title: String, subtitle: String) {
    val colors = LocalWidgetColors.current
    val size = LocalSize.current
    val fontScale = LocalContext.current.resources.configuration.fontScale
    if (shouldUseCompactWidgetMessage(size.height.value, fontScale)) {
        Column(
            modifier = GlanceModifier.fillMaxSize().padding(
                horizontal = 8.dp,
                vertical = 5.dp
            ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            WidgetText(
                "$title · $subtitle",
                colors.text,
                if (size.height < 72.dp) 10.sp else 11.sp,
                FontWeight.Bold,
                maxLines = 2,
                align = TextAlign.Center
            )
        }
        return
    }
    Column(
        modifier = GlanceModifier.fillMaxSize().padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        WidgetText(title, colors.text, 15.sp, FontWeight.Bold, align = TextAlign.Center)
        Spacer(GlanceModifier.height(4.dp))
        WidgetText(subtitle, colors.muted, 11.sp, maxLines = 2, align = TextAlign.Center)
    }
}

@Composable
private fun StatusDot(provider: WidgetQuotaProvider, compact: Boolean = false) {
    val colors = LocalWidgetColors.current
    Box(
        GlanceModifier
            .size(if (compact) 6.dp else 7.dp)
            .cornerRadius(4.dp)
            .background(providerAccentColor(colors, provider))
    ) {}
}

@Composable
private fun WidgetText(
    text: String,
    color: ColorProvider,
    fontSize: TextUnit,
    weight: FontWeight = FontWeight.Normal,
    maxLines: Int = 1,
    align: TextAlign = TextAlign.Start,
    modifier: GlanceModifier = GlanceModifier
) {
    Text(
        text = text,
        maxLines = maxLines,
        modifier = modifier,
        style = TextStyle(
            color = color,
            fontSize = fontSize.forWidgetFontScale(),
            fontWeight = weight,
            textAlign = align
        )
    )
}

private fun shortProviderName(name: String): String =
    name.replace(" 订阅额度", "").replace(" 额度", "").replace("订阅额度", "").trim()

private fun WidgetState.Ready.displayedProviders(config: WidgetConfig): List<WidgetQuotaProvider> {
    return if (config.mode == WidgetMode.MultiBar) {
        selectWidgetProviders(quota?.providers.orEmpty(), config.providerId)
    } else widgetLayoutProviders(quota?.providers.orEmpty(), config.providerId)
}

private fun providerCaption(provider: WidgetQuotaProvider): String = when (provider.status) {
    QuotaProviderStatus.Ok -> provider.primary?.label ?: "额度"
    QuotaProviderStatus.Stale -> "历史 · ${provider.freshnessText}"
    else -> statusLabel(provider.status)
}

@Composable
private fun providerCaptionColor(provider: WidgetQuotaProvider): ColorProvider =
    if (provider.status == QuotaProviderStatus.Ok) {
        LocalWidgetColors.current.muted
    } else {
        providerAccentColor(LocalWidgetColors.current, provider)
    }

private fun quotaFooterText(provider: WidgetQuotaProvider): String = when {
    provider.stale -> "历史数据 · 更新于 ${provider.freshnessText}"
    provider.resetText != null -> provider.resetText
    else -> "更新于 ${provider.freshnessText}"
}

private fun providerAccentColor(colors: WidgetColors, provider: WidgetQuotaProvider?): ColorProvider =
    when (provider?.status ?: QuotaProviderStatus.Unsupported) {
        QuotaProviderStatus.Ok -> provider?.primary?.availableFraction?.let { widgetProgressColor(colors, it) }
            ?: colors.faint
        QuotaProviderStatus.Stale, QuotaProviderStatus.AuthRequired -> colors.amber
        QuotaProviderStatus.Error -> colors.danger
        QuotaProviderStatus.Unsupported -> colors.faint
    }

private fun providerAccentArgb(colors: WidgetColors, provider: WidgetQuotaProvider): Int =
    when (provider.status) {
        QuotaProviderStatus.Ok -> provider.primary?.availableFraction?.let { widgetProgressArgb(colors, it) }
            ?: colors.faintArgb()
        QuotaProviderStatus.Stale, QuotaProviderStatus.AuthRequired -> colors.amberArgb
        QuotaProviderStatus.Error -> colors.dangerArgb
        QuotaProviderStatus.Unsupported -> colors.faintArgb()
    }

private fun deltaColor(colors: WidgetColors, direction: String): ColorProvider = when (direction) {
    "down" -> colors.green
    "up" -> colors.amber
    else -> colors.muted
}

// 第三份手抄本也去掉：直接从唯一色源派生，Glance 有几处只收 Int。
private fun WidgetColors.faintArgb(): Int = faintColor.toArgb()
