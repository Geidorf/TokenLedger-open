package com.jeidorf.tokenledger.mobile

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.ui.controls.V2GlobalRangeControl
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Segment
import com.jeidorf.tokenledger.mobile.ui.foundation.V2SegmentedToggle
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.v2WithFontSize
import com.jeidorf.tokenledger.mobile.ui.navigation.MobileDestination
import com.jeidorf.tokenledger.mobile.ui.navigation.V2NavigationBar
import com.jeidorf.tokenledger.mobile.ui.navigation.V2NavigationRail
import com.jeidorf.tokenledger.mobile.ui.navigation.V2TopBar

private fun allNodes(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::allNodes)

private fun texts(node: SemanticsNode): List<String> =
    node.config.getOrElse(SemanticsProperties.Text) { emptyList() }.map { it.text } + node.children.flatMap(::texts)

private fun <T> SemanticsNode.prop(key: SemanticsPropertyKey<T>): T? = if (config.contains(key)) config[key] else null

private fun SemanticsNode.ownTexts(): List<String> = prop(SemanticsProperties.Text).orEmpty().map { it.text }

/** R-40 的对照文案：五段，其中一段沿用 design D9「Token 消耗」——已在生产代码里因窄格被截成
 * 「Token …」的真实案例（契约「Android 分段控件按最宽文案定宽，调用点不写死」的 136dp 场景同源），
 * 这里直接拿来在 320dp × 200% 下驱动共享的 [V2SegmentedToggle]，不经过完整看板，缩小失败半径。 */
private enum class R40Option(val label: String) {
    A("今日"), B("本周"), C("本月"), D("今年"), E("Token 消耗")
}

/**
 * R-40（root 决定，T10.208；R-67 修复 P1-1）：320dp × 200% 下五段分段控件的文字一个都不能丢，
 * 轨道随折行长高。检查量的是**真正画出来的排版**，不是语义文本（旧检查读 `V2SegmentLabel` 手写的
 * 语义文本，永远通过）：每段摆上去的那份文字的 [TextLayoutResult]——排出的字符数等于原文、
 * 没有省略号、没有溢出自己的文字框——再比它与所在段、段与轨道的实际尺寸，字不许被裁。
 */
@Composable
private fun R40TrackGrowthFixture(fontScaleLabel: String) {
    val palette = v2Palette(LedgerAppearance.Dark)
    var selected by remember { mutableStateOf(R40Option.E) }
    val root = LocalView.current as ViewRootForTest
    val px = LocalDensity.current.density
    val layouts = remember { mutableMapOf<String, TextLayoutResult>() }
    // 旁证：`caption` 下「Token」一个词本身多宽（200% 时它比五等分的格子还宽，只能在词内折开）。
    val measurer = rememberTextMeasurer()
    val word = measurer.measure("Token", LedgerType.label.v2WithFontSize(LedgerFont.caption)).size.width
    Box(
        Modifier
            .fillMaxSize()
            .background(palette.tokens.page)
            .padding(12.dp)
            .onGloballyPositioned {
                val nodes = allNodes(root.semanticsOwner.rootSemanticsNode)
                val track = nodes.single { it.config.contains(SemanticsProperties.SelectableGroup) }
                check(layouts.keys == R40Option.entries.map { it.label }.toSet()) { "排版观察口没收齐：${layouts.keys}" }
                R40Option.entries.forEach { option ->
                    val layout = layouts.getValue(option.label)
                    val segment = nodes.single { n ->
                        n.prop(SemanticsProperties.ContentDescription) == listOf(option.label) &&
                            n.config.contains(SemanticsProperties.Selected)
                    }
                    val laidOut = layout.getLineEnd(layout.lineCount - 1)
                    check(laidOut == option.label.length) {
                        "R-40 $fontScaleLabel：「${option.label}」只排出前 $laidOut 个字符（${layout.lineCount} 行）"
                    }
                    check(!layout.hasVisualOverflow) {
                        "R-40 $fontScaleLabel：「${option.label}」溢出文字框（宽 ${layout.didOverflowWidth}、高 ${layout.didOverflowHeight}）"
                    }
                    check((0 until layout.lineCount).none { layout.isLineEllipsized(it) }) {
                        "R-40 $fontScaleLabel：「${option.label}」出现省略号"
                    }
                    // 胶囊在段内上下各内缩 4dp：文字块要落在胶囊里，描边才不压字。
                    val pillHeight = segment.size.height - 2 * 4 * px
                    check(layout.size.width <= segment.size.width && layout.size.height <= pillHeight + .5f) {
                        "R-40 $fontScaleLabel：「${option.label}」文字 ${layout.size} 超出所在段 ${segment.size} 的胶囊区，字被裁或压线"
                    }
                    check(segment.size.height <= track.size.height) {
                        "R-40 $fontScaleLabel：段高 ${segment.size.height} 超出轨道 ${track.size.height}，轨道没跟着长高"
                    }
                    println(
                        "R40_LAYOUT|$fontScaleLabel|${option.label}|lines=${layout.lineCount}|" +
                            "text=${layout.size}|segment=${segment.size}|track=${track.size}"
                    )
                }
                check(layouts.values.any { it.lineCount >= 2 }) { "R-40 $fontScaleLabel：没有一段折行，夹具失去对抗性" }
                println("R40_WORD|$fontScaleLabel|Token|width=$word")
            }
    ) {
        V2SegmentedToggle(
            palette = palette,
            options = R40Option.entries.map { V2Segment(it, it.label) },
            selected = selected,
            onSelect = { selected = it },
            columns = R40Option.entries.size,
            onLabelLayout = { label, result -> layouts[label] = result }
        )
    }
}

@PreviewTest
@Preview(
    name = "R40 track growth font100 baseline",
    device = "spec:width=320dp,height=200dp,dpi=160",
    fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true
)
@Composable
fun V2SegmentedToggleR40Font100Screenshot() {
    R40TrackGrowthFixture("font100")
}

@PreviewTest
@Preview(
    name = "R40 track growth font200 wraps without loss",
    device = "spec:width=320dp,height=260dp,dpi=160",
    fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true
)
@Composable
fun V2SegmentedToggleR40Font200Screenshot() {
    R40TrackGrowthFixture("font200")
}

/**
 * §4.3「永远一行」（R-67 修复 P1-3、P2-1、P2-3、P2-6）：范围轨道按内容取宽、每项至少 48dp，放不下时整条
 * 横向滚动，选中项在**第一帧**就滚到 28dp 渐隐之外、胶囊就画在它身上；「自定义」紧跟轨道右侧 8dp。
 * 选「总计」（轨道最右侧那一项）。检查读的是真实布局：滚动轴的位置与上限、各项与视口的实际边界。
 * [expectScroll] 为真时要求轨道真的溢出并且已经滚动（320dp：五项 × 48dp 放不下），为假时要求不溢出（430dp）。
 */
@Composable
private fun RangeControlFixture(name: String, query: DashboardQuery, expectScroll: Boolean) {
    val palette = v2Palette(LedgerAppearance.Light)
    val root = LocalView.current as ViewRootForTest
    val density = LocalDensity.current
    Box(
        Modifier
            .fillMaxSize()
            .background(palette.tokens.page)
            .padding(12.dp)
            .onGloballyPositioned {
                val px = density.density
                val nodes = allNodes(root.semanticsOwner.rootSemanticsNode)
                val track = nodes.single { it.config.contains(SemanticsProperties.HorizontalScrollAxisRange) }
                val axis = track.config[SemanticsProperties.HorizontalScrollAxisRange]
                val scroll = axis.value()
                val max = axis.maxValue()
                val viewport = track.boundsInRoot
                val labels = RangeKey.entries.filter { it != RangeKey.Custom }.map { it.label }
                val options = nodes.filter { n ->
                    n.prop(SemanticsProperties.Role) == Role.RadioButton && n.ownTexts().singleOrNull() in labels
                }
                check(options.size == labels.size) { "$name：范围项应为 ${labels.size} 个，实际 ${options.map { it.ownTexts() }}" }
                options.forEach { option ->
                    check(option.size.width >= 48 * px - .5f) { "$name：「${option.ownTexts()}」触达宽度 ${option.size.width}px < 48dp" }
                }
                if (expectScroll) {
                    check(max > 0f && scroll > 0f) { "$name：应当溢出并已滚入选中项，实际 scroll=$scroll max=$max" }
                } else {
                    check(max == 0f) { "$name：不该溢出，实际 max=$max" }
                }
                val selected = options.single { it.prop(SemanticsProperties.Selected) == true }
                check(selected.ownTexts() == listOf(query.range.label)) { "$name：选中项不对 ${selected.ownTexts()}" }
                val fade = 28 * px
                val start = selected.positionInRoot.x
                val end = start + selected.size.width
                val minStart = viewport.left + if (scroll > 0f) fade else 0f
                val maxEnd = viewport.right - if (scroll < max) fade else 0f
                check(start >= minStart - .5f && end <= maxEnd + .5f) {
                    "$name：选中项 [$start, $end] 没落在渐隐之外的可见区 [$minStart, $maxEnd]（scroll=$scroll max=$max）"
                }
                val custom = nodes.single { it.prop(SemanticsProperties.ContentDescription) == listOf("自定义") }
                val gap = custom.boundsInRoot.left - viewport.right
                check(kotlin.math.abs(gap - 8 * px) <= 1f) { "$name：自定义按钮离轨道 ${gap}px，应紧跟 8dp" }
                println("RANGE_LAYOUT|$name|scroll=$scroll|max=$max|viewport=$viewport|selected=[$start,$end]|customGap=$gap")
            }
    ) {
        V2GlobalRangeControl(
            palette = palette,
            query = query,
            onSelect = {},
            onRequestCustomRange = {}
        )
    }
}

@PreviewTest
@Preview(
    name = "Range control 430dp all-selected no-scroll-needed",
    device = "spec:width=430dp,height=120dp,dpi=160",
    showBackground = true
)
@Composable
fun V2GlobalRangeControl430Screenshot() {
    RangeControlFixture("430", DashboardQuery(range = RangeKey.All), expectScroll = false)
}

@PreviewTest
@Preview(
    name = "Range control 320dp all-selected scrolls with edge fade",
    device = "spec:width=320dp,height=120dp,dpi=160",
    showBackground = true
)
@Composable
fun V2GlobalRangeControl320ScrolledScreenshot() {
    RangeControlFixture("320", DashboardQuery(range = RangeKey.All), expectScroll = true)
}

/**
 * §4.2 底部导航 / 侧轨：容器改 `chrome`，选中指示改用 `tokens.primaryContainerSolid`
 * （design 原文要滑动胶囊，M3 做不到时的退路，见 V2NavigationBar/V2NavigationRail 的 KDoc）。
 * 一张竖屏导航条、一张 ≥600dp 侧轨，读屏动作名与命中区仍按契约「Android dashboard top actions
 * and navigation expose explicit TalkBack actions」逐一核对。
 */
@Composable
private fun NavigationBarFixture() {
    val palette = v2Palette(LedgerAppearance.Dark)
    val root = LocalView.current as ViewRootForTest
    // LocalDensity.current 是 @Composable 读取，只能在组合阶段取；onGloballyPositioned 的回调
    // 在布局阶段执行、不是组合上下文，必须先在外面把值捕获好，再从回调里读这个捕获的值。
    val density = LocalDensity.current
    Box(Modifier.fillMaxSize().onGloballyPositioned {
        val nodes = allNodes(root.semanticsOwner.rootSemanticsNode)
        MobileDestination.entries.forEach { destination ->
            val node = nodes.single { n ->
                n.config.getOrElse(SemanticsProperties.ContentDescription) { emptyList() }.contains(destination.label) ||
                    n.config.getOrElse(SemanticsProperties.Text) { emptyList() }.any { it.text == destination.label }
            }
            val b = node.boundsInRoot
            check(b.height >= 48 * density.density - .5f) { "${destination.label} nav item below 48dp: $b" }
            println("NAV_BAR|${destination.name}|${b.left},${b.top},${b.width},${b.height}")
        }
    }) {
        V2NavigationBar(palette = palette, selected = MobileDestination.Overview, onSelect = {})
    }
}

@Composable
private fun NavigationRailFixture() {
    val palette = v2Palette(LedgerAppearance.Light)
    Box(Modifier.fillMaxSize().background(palette.tokens.page)) {
        V2NavigationRail(palette = palette, selected = MobileDestination.Insights, onSelect = {})
    }
}

@PreviewTest
@Preview(
    name = "Navigation bar chrome container 390dp",
    device = "spec:width=390dp,height=100dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true
)
@Composable
fun V2NavigationBarChromeScreenshot() {
    NavigationBarFixture()
}

@PreviewTest
@Preview(
    name = "Navigation rail chrome container tablet landscape",
    device = "spec:width=800dp,height=390dp,dpi=160",
    showBackground = true
)
@Composable
fun V2NavigationRailChromeTabletLandscapeScreenshot() {
    Column(Modifier.fillMaxWidth()) {
        NavigationRailFixture()
    }
}

/**
 * §4.1 顶栏（R-67 修复 P1-2、P2-2）：任何状态下**恰好一个**「打开筛选」站点，至少 48dp 高，合并节点里
 * 读得到筛选条件摘要；状态文字另起一行、自成一个带 liveRegion 的节点，不顶替副标题。
 * 常规模式下这个站点就是标题块：还留着 `heading()`，标题排在副标题前面（`Modifier.clickable` 默认
 * `mergeDescendants = true`，标题与副标题合进同一个节点，比的是它 `Text` 列表里的先后，这就是
 * TalkBack 的朗读顺序）。纵排模式下站点是独立的副标题行，标题自己是一个 heading 节点。
 */
@Composable
private fun TopBarFixture(
    name: String,
    subtitle: String,
    compact: Boolean,
    statusText: String?,
    filtersActive: Boolean,
    scrolledUnder: Boolean = false
) {
    val palette = v2Palette(LedgerAppearance.Light)
    val root = LocalView.current as ViewRootForTest
    val density = LocalDensity.current
    Box(Modifier.fillMaxSize().background(palette.tokens.page).onGloballyPositioned {
        val nodes = allNodes(root.semanticsOwner.rootSemanticsNode)
        val filters = nodes.filter { node ->
            node.config.contains(SemanticsActions.OnClick) && node.config[SemanticsActions.OnClick].label == "打开筛选"
        }
        check(filters.size == 1) { "$name：「打开筛选」应恰好一个站点，实际 ${filters.size} 个" }
        val filter = filters.single()
        check(filter.size.height >= 48 * density.density - .5f) { "$name：筛选入口高 ${filter.size.height}px < 48dp" }
        val filterTexts = texts(filter)
        check(filterTexts.any { it == subtitle }) { "$name：筛选入口里读不到条件摘要：$filterTexts" }
        if (compact) {
            check(!filter.config.contains(SemanticsProperties.Heading)) { "$name：纵排模式下标题不该并进筛选入口" }
            check(nodes.any { it.config.contains(SemanticsProperties.Heading) && "今日" in it.ownTexts() }) {
                "$name：纵排模式下标题丢了 heading() 语义"
            }
        } else {
            check(filter.config.contains(SemanticsProperties.Heading)) { "$name：标题与筛选入口合并后丢了 heading() 语义" }
            val titleIndex = filterTexts.indexOfFirst { it == "今日" }
            val subtitleIndex = filterTexts.indexOfFirst { it == subtitle }
            check(titleIndex in 0 until subtitleIndex) { "$name：读屏顺序不对，实际 $filterTexts" }
        }
        if (statusText != null) {
            val status = nodes.singleOrNull { it.ownTexts() == listOf(statusText) }
            check(status != null && status != filter && status.config.contains(SemanticsProperties.LiveRegion)) {
                "$name：状态文字应自成一个带 liveRegion 的节点、不并进筛选入口"
            }
        }
        println("TOPBAR|$name|filter=${filter.size}|texts=$filterTexts")
    }) {
        V2TopBar(
            palette = palette,
            title = "今日",
            subtitle = subtitle,
            compact = compact,
            loading = false,
            statusText = statusText,
            showRefreshProgress = false,
            showBack = false,
            onBack = {},
            onRefresh = {},
            onSettings = {},
            onShare = {},
            filtersActive = filtersActive,
            onOpenFilters = {},
            scrolledUnder = scrolledUnder
        )
    }
}

private const val FILTERED_SUMMARY = "今日 · 设备：MacBook-Pro · 工具：codex"

@PreviewTest
@Preview(name = "Top bar order no filters", device = "spec:width=390dp,height=140dp,dpi=160", showBackground = true)
@Composable
fun V2TopBarOrderNoFiltersScreenshot() {
    TopBarFixture("noFilters", "今日 · 全部设备", compact = false, statusText = null, filtersActive = false)
}

@PreviewTest
@Preview(name = "Top bar order filters active", device = "spec:width=390dp,height=140dp,dpi=160", showBackground = true)
@Composable
fun V2TopBarOrderFiltersActiveScreenshot() {
    TopBarFixture("filtersActive", FILTERED_SUMMARY, compact = false, statusText = null, filtersActive = true)
}

@PreviewTest
@Preview(
    name = "Top bar offline snapshot keeps filter entry",
    device = "spec:width=390dp,height=160dp,dpi=160",
    showBackground = true
)
@Composable
fun V2TopBarOfflineFiltersScreenshot() {
    TopBarFixture(
        "offline", FILTERED_SUMMARY, compact = false,
        statusText = "离线快照 · 截至 07-15 12:41", filtersActive = true
    )
}

/** 切换范围时依次经过正常、刷新、缓存/错误状态；三者顶栏外框必须同高。 */
@Composable
private fun TopBarHeightStabilityFixture() {
    val palette = v2Palette(LedgerAppearance.Light)
    val root = LocalView.current as ViewRootForTest
    val heights = remember { mutableMapOf<String, Int>() }
    val states = listOf(
        Triple("normal", false, null),
        Triple("refreshing", true, "正在刷新数据"),
        Triple("offline", false, "离线快照 · 截至 07-15 12:41")
    )
    Column(Modifier.fillMaxSize().background(palette.tokens.page)) {
        states.forEach { (name, loading, status) ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .onGloballyPositioned { coordinates ->
                        heights[name] = coordinates.size.height
                        if (heights.size == states.size) {
                            check(heights.values.distinct().size == 1) { "顶栏状态切换改变高度：$heights" }
                            val nodes = allNodes(root.semanticsOwner.rootSemanticsNode)
                            val refresh = nodes.singleOrNull {
                                it.prop(SemanticsProperties.ContentDescription) == listOf("正在刷新数据") &&
                                    it.config.contains(SemanticsProperties.LiveRegion)
                            }
                            check(refresh != null) { "刷新状态缺少礼貌 live region" }
                            val offline = nodes.singleOrNull { it.ownTexts() == listOf("离线快照 · 截至 07-15 12:41") }
                            check(offline != null && offline.config.contains(SemanticsProperties.LiveRegion)) {
                                "缓存状态缺少独立 live region"
                            }
                            println("TOPBAR_HEIGHTS|$heights")
                        }
                    }
            ) {
                V2TopBar(
                    palette = palette,
                    title = "今日",
                    subtitle = "今日 · 全部设备",
                    compact = false,
                    loading = loading,
                    statusText = status,
                    showRefreshProgress = loading,
                    showBack = false,
                    onBack = {},
                    onRefresh = {},
                    onSettings = {},
                    filtersActive = false,
                    onOpenFilters = {}
                )
            }
        }
    }
}

@PreviewTest
@Preview(
    name = "Top bar normal refreshing offline equal height",
    device = "spec:width=390dp,height=320dp,dpi=160",
    showBackground = true
)
@Composable
fun V2TopBarHeightStabilityScreenshot() {
    TopBarHeightStabilityFixture()
}

@PreviewTest
@Preview(
    name = "Top bar compact 320dp font200 one filter target scrolled under",
    device = "spec:width=320dp,height=320dp,dpi=160",
    fontScale = 2.0f,
    showBackground = true
)
@Composable
fun V2TopBarCompactScrolledScreenshot() {
    TopBarFixture(
        "compact", FILTERED_SUMMARY, compact = true,
        statusText = "数据已过期 · 保留可验证快照", filtersActive = true, scrolledUnder = true
    )
}
