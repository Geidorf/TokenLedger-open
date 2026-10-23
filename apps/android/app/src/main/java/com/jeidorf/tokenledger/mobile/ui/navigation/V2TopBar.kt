package com.jeidorf.tokenledger.mobile.ui.navigation

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableFloatState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jeidorf.tokenledger.mobile.DashboardEntity
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerMotion
import com.jeidorf.tokenledger.mobile.dashboardTitleAccessibilityDescription
import com.jeidorf.tokenledger.mobile.dashboardTitleMaxLines
import com.jeidorf.tokenledger.mobile.entityKindLabel
import com.jeidorf.tokenledger.mobile.ledgerMotionEnabled
import com.jeidorf.tokenledger.mobile.ledgerTween
import com.jeidorf.tokenledger.mobile.toolChartSlot
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerStroke
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_ACTION
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_TEXT
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_TOUCH_TARGET
import com.jeidorf.tokenledger.mobile.ui.foundation.pressScale

/**
 * 顶栏标题（§4.1）：设置页固定「设置」；专属看板用实体自己的名字；其余就是一级分区自己的名字
 * （重构方案 v2：「用量」不再随所选范围改名，范围由页内的范围控件呈现）。抽成纯函数单独测。
 */
internal fun v2TopBarTitle(
    showSettings: Boolean,
    entityMode: Boolean,
    destination: MobileDestination,
    entityLabel: String
): String = when {
    showSettings -> "设置"
    entityMode -> entityLabel
    else -> destination.label
}

/**
 * 顶栏副标题（§4.1，用户决定 V-Q3「筛选入口并入顶栏副标题」）：设置页与额度页没有可筛选的
 * 查询，传空串表示不渲染第二行（与旧版 `V2QueryContext` 只在 `destination != Quota` 时出现的
 * 口径一致，见契约「Android 洞察共用范围栏…」）；专属看板是「来源类别 · 名称 · 查询摘要」
 * 面包屑（简化版，不追溯是从复盘哪个页签点进来的——那需要新增导航来源状态，超出导航壳范围，
 * 见任务日志「建议写入 SSOT 的文字」）；其余目的地就是查询摘要本身。
 */
internal fun v2TopBarSubtitle(
    showSettings: Boolean,
    entityMode: Boolean,
    destination: MobileDestination,
    entityKind: String?,
    entityLabel: String,
    querySummary: String
): String = when {
    showSettings -> ""
    entityMode -> {
        val kindPrefix = entityKind?.let { "${entityKindLabel(it)} · " }.orEmpty()
        "$kindPrefix$entityLabel · $querySummary"
    }
    destination == MobileDestination.Routing -> ""
    destination == MobileDestination.Quota -> ""
    else -> querySummary
}

/**
 * 专属看板标题前身份色点的图表槽位（§4.1、§3.8）：工具取 [toolChartSlot] 的主槽位（两端同一张表），
 * 模型与其余来源统一 `chart-1`（§4.7「模型统一 chart-1」）。
 */
internal fun v2EntityIdentitySlot(kind: String?, name: String): Int =
    if (kind.equals(DashboardEntity.TOOL, ignoreCase = true)) toolChartSlot(name) else 1

/** 专属看板标题前的身份色点（§4.1：10dp）。 */
private val V2_TOP_BAR_IDENTITY_DOT = 10.dp

/**
 * 顶栏「内容滚到下方」的判定（§4.1），给列表不在导航壳文件里的两页（专属看板、设置）用：挂在内容
 * 外层的 nestedScroll 上，累计子级实际消耗的纵向滚动量（与 M3 pinnedScrollBehavior 同一口径），
 * 在顶部继续下拉时清零；不消耗任何滚动。今日、复盘、额度、展示直接看自己的 LazyListState，
 * 见 [v2ScrolledUnder]。
 */
internal class V2ScrollUnderConnection(private val offset: MutableFloatState) : NestedScrollConnection {
    val scrolledUnder: Boolean get() = offset.floatValue < -0.5f

    override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
        offset.floatValue = if (consumed.y == 0f && available.y > 0f) 0f else offset.floatValue + consumed.y
        return Offset.Zero
    }
}

/** 列表内容是否已离开顶部（§4.1：顶栏切 `chrome` 底并出现 1dp `divider` 的条件）。 */
internal fun LazyListState.v2ScrolledUnder(): Boolean =
    firstVisibleItemIndex > 0 || firstVisibleItemScrollOffset > 0

/**
 * 顶栏（§4.1）：标题 + 副标题两行，取消旧版「TOKENLEDGER」大写眉题占位。64dp 起，内容左 16、右 4；
 * [showBack]（专属看板、设置）时左侧是返回箭头（替代品牌块，品牌块本身不在 R-67 范围），右侧不放图标。
 * [identityColor] 非空时标题前加 10dp 身份色点（专属看板）。[scrolledUnder] 时底色由 `page` 切为
 * `chrome` 并出现底部 1dp `divider`（`FAST`）。
 *
 * **副标题就是筛选入口**（用户决定 V-Q3）：[subtitle] 非空时渲染在标题下方，末尾跟 16dp
 * 下拉箭头，[filtersActive] 时箭头前再加 6dp `primary` 圆点；标题与副标题整块（≥48dp 高）
 * 可点，回调 [onOpenFilters]（design：「整块…点按打开筛选面板」）。[subtitle] 传空串表示
 * 这一屏没有可筛选的查询（额度页、设置页——与旧版 `V2QueryContext` 只在
 * `destination != Quota` 时出现的口径一致），此时不渲染第二行，顶栏退回单行标题。
 *
 * [statusText] 的稳定状态（出错/离线/过期/兼容模式）显示在固定高度状态槽，不再顶替副标题
 * （R-67 修复 P1-2）。短暂刷新由顶栏底边进度条表达，状态槽保持空白；正常、刷新与稳定状态
 * 都不改变顶栏高度，筛选入口、条件摘要、圆点与箭头也一直保留。
 *
 * [compact]（调用方传 `DashboardLayoutMode.Compact`，即宽度 < 360dp 或字体 ≥ 150%，
 * `dashboardLayoutMode`，design §6.2「纵排模式」）时副标题独立成整行、可换行不截断，这一行就是
 * 唯一的筛选入口（≥48dp 高，R-67 修复 P2-2；标题此时只是标题）；否则副标题与标题一起收在与图标
 * 按钮同一行的窄列里，一行省略号兜底（不含省略号的完整文字仍在无障碍描述里）。
 */
@Composable
internal fun V2TopBar(
    palette: MobileV2Palette,
    title: String,
    subtitle: String,
    compact: Boolean,
    loading: Boolean,
    statusText: String?,
    showRefreshProgress: Boolean,
    showBack: Boolean,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onSettings: () -> Unit,
    onShare: (() -> Unit)? = null,
    filtersActive: Boolean = false,
    onOpenFilters: (() -> Unit)? = null,
    identityColor: Color? = null,
    scrolledUnder: Boolean = false
) {
    val titleMaxLines = dashboardTitleMaxLines(LocalDensity.current.fontScale)
    val statusSlotHeight = with(LocalDensity.current) { 16.sp.toDp() }
    val showSubtitle = subtitle.isNotBlank()
    // R-67 修复 P1-2：状态文字不再参与这个判断——任何状态下筛选入口都在。
    val subtitleIsFilterEntry = showSubtitle && onOpenFilters != null
    val subtitleMaxLines = if (compact) Int.MAX_VALUE else 1
    val motion = ledgerMotionEnabled(palette.isEInk)
    val chromeColor by animateColorAsState(
        targetValue = if (scrolledUnder) palette.tokens.chrome else palette.background,
        animationSpec = ledgerTween(LedgerMotion.FAST_MILLIS, motion),
        label = "topBarChrome"
    )
    val dividerAlpha by animateFloatAsState(
        targetValue = if (scrolledUnder) 1f else 0f,
        animationSpec = ledgerTween(LedgerMotion.FAST_MILLIS, motion),
        label = "topBarDivider"
    )
    // 唯一的筛选点按：常规模式挂在标题块上，纵排模式挂在独立的副标题行上（R-67 修复 P2-2）。
    val openFilters = if (subtitleIsFilterEntry) {
        Modifier.clickable(role = Role.Button, onClickLabel = "打开筛选", onClick = { onOpenFilters?.invoke() })
    } else {
        Modifier
    }

    val titleContent: @Composable () -> Unit = {
        Row(verticalAlignment = Alignment.CenterVertically) {
            identityColor?.let { color ->
                Box(Modifier.size(V2_TOP_BAR_IDENTITY_DOT).clip(CircleShape).background(color))
                Spacer(Modifier.width(8.dp))
            }
            Text(
                title,
                color = palette.text,
                fontSize = LedgerFont.title,
                lineHeight = if (compact) 28.sp else 30.sp,
                fontWeight = FontWeight.Normal,
                maxLines = titleMaxLines,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false).semantics {
                    heading()
                    contentDescription = dashboardTitleAccessibilityDescription(title)
                }
            )
        }
    }
    val subtitleContent: @Composable (Modifier) -> Unit = { modifier ->
        Row(modifier, verticalAlignment = Alignment.CenterVertically) {
            Text(
                subtitle,
                color = palette.faint,
                fontSize = LedgerFont.caption,
                lineHeight = 14.sp,
                fontWeight = FontWeight.Medium,
                letterSpacing = 0.2.sp,
                maxLines = subtitleMaxLines,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false)
            )
            if (subtitleIsFilterEntry) {
                Spacer(Modifier.width(2.dp))
                if (filtersActive) {
                    Box(Modifier.size(6.dp).clip(CircleShape).background(palette.blue))
                    Spacer(Modifier.width(4.dp))
                }
                Icon(
                    Icons.Default.ExpandMore,
                    contentDescription = null,
                    tint = palette.faint,
                    modifier = Modifier.size(V2_ICON_TEXT)
                )
            }
        }
    }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .drawBehind {
                drawRect(chromeColor)
                if (dividerAlpha > 0f) {
                    val stroke = LedgerStroke.hairline.toPx()
                    drawRect(
                        palette.divider.copy(alpha = palette.divider.alpha * dividerAlpha),
                        topLeft = Offset(0f, size.height - stroke),
                        size = Size(size.width, stroke)
                    )
                }
            }
    ) {
        Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 8.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .padding(start = if (showBack) 4.dp else 16.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (showBack) {
                    V2RoundIconButton(palette, Icons.AutoMirrored.Filled.ArrowBack, "返回上一级", onBack)
                }
                Column(
                    Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp)
                        .then(if (compact) Modifier else openFilters),
                    verticalArrangement = Arrangement.Center
                ) {
                    titleContent()
                    if (!compact && showSubtitle) subtitleContent(Modifier.fillMaxWidth())
                }
                if (!showBack) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        onShare?.let {
                            V2RoundIconButton(palette, Icons.Default.Share, "分享数据战报", it)
                            Spacer(Modifier.width(4.dp))
                        }
                        V2RoundIconButton(
                            palette,
                            Icons.Default.Refresh,
                            if (loading) "正在刷新" else "刷新数据",
                            onRefresh,
                            enabled = !loading
                        )
                        Spacer(Modifier.width(4.dp))
                        V2RoundIconButton(palette, Icons.Default.Settings, "打开设置", onSettings)
                    }
                }
            }
            if (compact && showSubtitle) {
                subtitleContent(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .then(openFilters)
                        .padding(horizontal = 16.dp)
                )
            }
            // 固定槽避免 normal ↔ loading ↔ offline/error 切换改变顶栏测量高度。
            // 刷新状态由底边进度条的 live region 朗读，槽内不重复显示「正在刷新数据」。
            val stableStatus = statusText.takeUnless { loading }
            val statusSemantics = if (stableStatus == null) {
                Modifier.clearAndSetSemantics { }
            } else {
                Modifier.semantics {
                    contentDescription = stableStatus
                    liveRegion = LiveRegionMode.Assertive
                }
            }
            Text(
                stableStatus ?: "\u00A0",
                color = if (stableStatus == null) Color.Transparent else palette.amber,
                fontSize = LedgerFont.caption,
                lineHeight = 14.sp,
                fontWeight = FontWeight.Medium,
                letterSpacing = 0.2.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(statusSlotHeight)
                    .padding(horizontal = 16.dp)
                    .then(statusSemantics)
            )
        }
        if (showRefreshProgress) {
            LinearProgressIndicator(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(3.dp)
                    .semantics {
                        contentDescription = statusText ?: "正在刷新数据"
                        liveRegion = LiveRegionMode.Polite
                    },
                color = palette.blue,
                trackColor = palette.raised
            )
        }
    }
}

@Composable
internal fun V2RoundIconButton(
    palette: MobileV2Palette,
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    enabled: Boolean = true
) {
    val interactionSource = remember { MutableInteractionSource() }
    val motion = ledgerMotionEnabled(palette.isEInk)
    val background by animateColorAsState(
        targetValue = Color.Transparent,
        animationSpec = ledgerTween(LedgerMotion.STANDARD_MILLIS, motion),
        label = "iconButtonBackground"
    )
    IconButton(
        onClick = onClick,
        enabled = enabled,
        interactionSource = interactionSource,
        modifier = Modifier
            .size(48.dp)
            .semantics { onClick(label, null) }
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .pressScale(interactionSource, motion)
                .clip(CircleShape)
                .background(background),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                icon,
                contentDescription = label,
                tint = if (enabled) palette.text else palette.faint,
                modifier = Modifier.size(V2_ICON_ACTION)
            )
        }
    }
}

/**
 * 卡片内的图标动作：48dp 触达区、24dp 视觉尺寸，无底色。
 */
@Composable
internal fun V2IconAction(
    palette: MobileV2Palette,
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    tint: Color = palette.blue
) {
    val interactionSource = remember { MutableInteractionSource() }
    val motion = ledgerMotionEnabled(palette.isEInk)
    IconButton(
        onClick = onClick,
        enabled = enabled,
        interactionSource = interactionSource,
        modifier = Modifier.size(V2_TOUCH_TARGET).semantics { onClick(contentDescription, null) }
    ) {
        Icon(
            icon,
            contentDescription = contentDescription,
            tint = if (enabled) tint else palette.faint,
            modifier = Modifier.size(V2_ICON_ACTION).pressScale(interactionSource, motion)
        )
    }
}
