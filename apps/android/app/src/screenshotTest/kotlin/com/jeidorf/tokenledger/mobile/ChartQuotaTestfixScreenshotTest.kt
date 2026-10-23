package com.jeidorf.tokenledger.mobile

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import java.time.Instant
import androidx.compose.ui.semantics.SemanticsActions

/** 夹具里的「现在」。窗口重置写在 2026-09-08T08:00+08:00，这里取它前 4 小时。 */
private val FIXED_NOW: Instant = Instant.parse("2026-09-08T00:00:00Z").minusSeconds(4 * 3600)

/** 每张图都是同一真实320×640视口中的一个状态，不借长画布获得触点通过。 */
@Composable
private fun ControlStateFixture(state: ChartQuotaControlState) {
    val density = LocalDensity.current
    val scale = density.fontScale
    val root = LocalView.current as ViewRootForTest
    Box(Modifier.fillMaxSize().onGloballyPositioned {
        val nodes = allNodes(root.semanticsOwner.rootSemanticsNode)
        val selectors = listOf("Token 消耗视图", "预估费用视图", "人民币币种", "美元币种",
            "趋势", "来源", "日历", "请求", if(state == ChartQuotaControlState.Loading) "读取中…" else "重新读取")
        selectors.forEachIndexed { index, label ->
            val node = nodes.single { node ->
                node.config.contains(SemanticsActions.OnClick) &&
                    (node.config.getOrElse(SemanticsProperties.ContentDescription) { emptyList() }.contains(label) ||
                        node.config.getOrElse(SemanticsProperties.Text) { emptyList() }.any { it.text == label })
            }
            val b = node.boundsInRoot
            check(b.width >= 48 * density.density - .5f && b.height >= 48 * density.density - .5f) { "$label $b" }
            check(b.left >= 0 && b.top >= 0 && b.right <= 320 * density.density && b.bottom <= 640 * density.density) { "$label outside viewport: $b" }
            println("C_R2_ROOT|${state.name}|$scale|$index|${b.left},${b.top},${b.width},${b.height}")
        }
    }) {
        V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Controls, chartQuotaStats(), controlState = state,
            onControlBounds = { key, bounds -> println("C_R2_BOUNDS|${state.name}|$scale|$key|${bounds.joinToString(",")}") })
    }
}

private fun allNodes(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::allNodes)

private fun descriptions(node: SemanticsNode): List<String> =
    node.config.getOrElse(SemanticsProperties.ContentDescription) { emptyList() } + node.children.flatMap(::descriptions)

private fun texts(node: SemanticsNode): List<String> =
    node.config.getOrElse(SemanticsProperties.Text) { emptyList() }.map { it.text } + node.children.flatMap(::texts)

@Composable
private fun SemanticFixture(kind: String) {
    val root = LocalView.current as ViewRootForTest
    val stats = when(kind) {
        "trend" -> nativeChartStats(current = listOf(point("2026-09-07 01:00:00", 17, .2)),
            previous = listOf(point("2026-09-06 01:00:00", 13, .1), point("2026-09-06 02:00:00", 19, .3)))
        "empty" -> nativeChartStats(current = emptyList())
        "missing" -> nativeChartStats(previous = emptyList())
        "zero" -> nativeChartStats(zeroTools = setOf("opencode"))
        "allzero" -> nativeChartStats(allZero = true)
        "notools" -> nativeChartStats(noTools = true)
        else -> nativeChartStats()
    }
    Box(Modifier.fillMaxSize().onGloballyPositioned {
        val semantics = root.semanticsOwner.rootSemanticsNode
        val all = descriptions(semantics)
        val text = texts(semantics)
        val unmergedText = texts(root.semanticsOwner.unmergedRootSemanticsNode)
        val unmergedDescriptions = descriptions(root.semanticsOwner.unmergedRootSemanticsNode)
        println("C_R2_BEFORE|$kind|$all|$text")
        when(kind) {
            "trend" -> check(all.filter { it.startsWith("本期时段 ") } == listOf(
                "本期时段 2026-09-07 01:00:00，$0.20；上期时段 2026-09-06 01:00:00，$0.10",
                "本期时段 不可得，不可得；上期时段 2026-09-06 02:00:00，$0.30")) { all.toString() }
            "error" -> {
                check(text.contains("Codex 订阅额度"))
                check(text.contains("额度来源暂不可用")) { text.toString() }
                check(text.contains("按桌面端额度页提示处理来源，完成刷新与同步后重新读取。"))
                val windows = all.filter { it.contains("更新于 ") }
                check(windows.size == 2 && windows.all { it.contains("暂时不可用") && !it.contains("72%") }) { all.toString() }
            }
            "mixed" -> {
                val windows = all.filter { it.contains("更新于 ") }
                check(windows.size == 2) { all.toString() }
                val fresh = windows.single { it.contains("，5 小时额度，") }
                val old = windows.single { it.contains("，每周额度，") }
                // A-Q2：额度一律整数，可用 = 100 − round(已用 27.5) = 72。
                check(fresh.startsWith("Codex 订阅额度，") && fresh.contains("数据新鲜") && fresh.contains("可用 72%") &&
                    fresh.contains("更新于 2026-09-07 09:59:50 +08:00")) { all.toString() }
                check(old.startsWith("Codex 订阅额度，") && old.contains("历史数据") && old.contains("可用 72%") &&
                    old.contains("更新于 2026-09-06 09:00:00 +08:00")) { all.toString() }
            }
            "normal" -> {
                check(text.contains("预估费用") && text.contains("本期") && text.contains("上期"))
                check(all.contains("当前峰值时段 2026-09-07 01:00:00，$12.34，3 条记录"))
                // 0 < v < 0.01 写 `<$0.01`（T10.154 §4.1），不再四舍五入成 $0.01 或 $0.00。
                check(all.filter { it.startsWith("本期时段 ") } == listOf(
                    "本期时段 2026-09-07 01:00:00，$12.34；上期时段 2026-09-06 01:00:00，$6.78",
                    "本期时段 2026-09-07 02:00:00，<$0.01；上期时段 2026-09-06 02:00:00，<$0.01",
                    "本期时段 不可得，不可得；上期时段 2026-09-06 03:00:00，$1.20")) { all.toString() }
            }
            "empty" -> check(text.any { it.contains("当前范围暂无费用趋势") })
            "missing" -> check(text.any { it.contains("上一周期数据不可得") })
            "sources" -> {
                // 来源排行直接展示完整工具集，不再用环图余项表达被隐藏的工具。
                stats.tools.values.forEach { tool ->
                    check(all.any { it.startsWith("${tool.name}，${formatInteger(tool.effectiveTokens)} 有效 Token") && it.contains("打开 ${tool.name} 专属看板") }) { all.toString() }
                }
                check(all.none { it.contains("来源构成") })
                check(text.none { it.contains("未显示") })
            }
            "zero" -> {
                check(all.any { it.startsWith("codex，60,000 有效 Token，30%") })
                check(!unmergedText.contains("opencode"))
            }
            "allzero" -> {
                check(unmergedText.any { it.contains("暂无 Token 构成") })
                check(all.filter { it.contains("有效 Token") }.all { it.contains("，0 有效 Token") })
            }
            "notools" -> {
                check(unmergedText.contains("暂无工具来源")) { unmergedText.toString() }
                check(unmergedText.none { it.contains("未显示") }) { unmergedText.toString() }
            }
            "tools" -> listOf("codex", "claude", "gemini", "cursor").forEach { name -> check(unmergedText.any { it.contains(name) }) }
            "models" -> listOf("gpt-5-long-context", "claude-sonnet", "gemini-pro").forEach { check(unmergedText.contains(it)) }
            "masked" -> {
                check(unmergedText.any { it.contains("***") })
                check((text + unmergedText + all + unmergedDescriptions).none { it.contains("12.34") || it.contains("6.78") })
            }
            "details" -> {
                listOf("重置 4 小时后",
                    "查看诊断信息").forEach { expected -> check(unmergedText.any { it.contains(expected) }) { "$expected / $unmergedText" } }
                // 精简后的详情把完整时间集中到诊断展开，窗口读屏仍保留观测时间。
                check(all.any { it.startsWith("Codex 订阅额度，") && it.contains("09:59") }) { all.toString() }
                check(unmergedText.none { it.contains("抓取／读取") || it.contains("本机缓存") })
                check(all.contains("Codex 订阅额度 详情"))
                check((text + unmergedText + all + unmergedDescriptions).none { it.contains("/Users/private") || it.contains("token-secret") })
            }
        }
        println("C_R2_SEMANTICS|$kind|$all")
    }) {
        val surface = when(kind) {
            "trend" -> ChartQuotaPreviewSurface.TrendTable
            "normal", "empty", "missing" -> ChartQuotaPreviewSurface.Trend
            "sources" -> ChartQuotaPreviewSurface.Sources
            "zero", "tools" -> ChartQuotaPreviewSurface.OverviewTools
            "allzero", "notools" -> ChartQuotaPreviewSurface.Composition
            "models", "masked" -> ChartQuotaPreviewSurface.ModelRanking
            else -> ChartQuotaPreviewSurface.Quota
        }
        // 额度重置写的是相对时间，夹具写的是绝对时间戳——不把「现在」钉死，同一份夹具
        // 每过一小时就渲染出不同的字（实测 `重置 4 小时后` → `3 小时后`），参考图会自己变红。
        CompositionLocalProvider(LocalLedgerNow provides { FIXED_NOW }) {
            V2ChartQuotaPreviewContent(surface, stats,
                metric = if(kind in listOf("trend", "normal", "empty", "missing", "masked")) ReportMetricMode.Cost else ReportMetricMode.Tokens,
                masked = kind == "masked", details = kind == "details",
                quota = if(surface == ChartQuotaPreviewSurface.Quota) nativeQuotaAvailable(when(kind) {
                    "error" -> QuotaKind.Error; "mixed" -> QuotaKind.Mixed; else -> QuotaKind.Details
                }) else null)
        }
    }
}

@PreviewTest
@Preview(name = "Semantics no tools", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaSemanticsNoToolsScreenshot() { SemanticFixture("notools") }

@PreviewTest
@Preview(name = "Control Unselected font100", device = "spec:width=320dp,height=640dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaControlUnselected100Screenshot() { ControlStateFixture(ChartQuotaControlState.Unselected) }

@PreviewTest
@Preview(name = "Control Selected font100", device = "spec:width=320dp,height=640dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaControlSelected100Screenshot() { ControlStateFixture(ChartQuotaControlState.Selected) }

@PreviewTest
@Preview(name = "Control Disabled font100", device = "spec:width=320dp,height=640dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaControlDisabled100Screenshot() { ControlStateFixture(ChartQuotaControlState.Disabled) }

@PreviewTest
@Preview(name = "Control Loading font100", device = "spec:width=320dp,height=640dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaControlLoading100Screenshot() { ControlStateFixture(ChartQuotaControlState.Loading) }

@PreviewTest
@Preview(name = "Control Unselected font150", device = "spec:width=320dp,height=640dp,dpi=160", fontScale = 1.5f)
@Composable
fun ChartQuotaControlUnselected150Screenshot() { ControlStateFixture(ChartQuotaControlState.Unselected) }

@PreviewTest
@Preview(name = "Control Selected font150", device = "spec:width=320dp,height=640dp,dpi=160", fontScale = 1.5f)
@Composable
fun ChartQuotaControlSelected150Screenshot() { ControlStateFixture(ChartQuotaControlState.Selected) }

@PreviewTest
@Preview(name = "Control Disabled font150", device = "spec:width=320dp,height=640dp,dpi=160", fontScale = 1.5f)
@Composable
fun ChartQuotaControlDisabled150Screenshot() { ControlStateFixture(ChartQuotaControlState.Disabled) }

@PreviewTest
@Preview(name = "Control Loading font150", device = "spec:width=320dp,height=640dp,dpi=160", fontScale = 1.5f)
@Composable
fun ChartQuotaControlLoading150Screenshot() { ControlStateFixture(ChartQuotaControlState.Loading) }

@PreviewTest
@Preview(name = "Control Unselected font200", device = "spec:width=320dp,height=640dp,dpi=160", fontScale = 2.0f)
@Composable
fun ChartQuotaControlUnselected200Screenshot() { ControlStateFixture(ChartQuotaControlState.Unselected) }

@PreviewTest
@Preview(name = "Control Selected font200", device = "spec:width=320dp,height=640dp,dpi=160", fontScale = 2.0f)
@Composable
fun ChartQuotaControlSelected200Screenshot() { ControlStateFixture(ChartQuotaControlState.Selected) }

@PreviewTest
@Preview(name = "Control Disabled font200", device = "spec:width=320dp,height=640dp,dpi=160", fontScale = 2.0f)
@Composable
fun ChartQuotaControlDisabled200Screenshot() { ControlStateFixture(ChartQuotaControlState.Disabled) }

@PreviewTest
@Preview(name = "Control Loading font200", device = "spec:width=320dp,height=640dp,dpi=160", fontScale = 2.0f)
@Composable
fun ChartQuotaControlLoading200Screenshot() { ControlStateFixture(ChartQuotaControlState.Loading) }

@PreviewTest
@Preview(name = "Semantics trend", device = "spec:width=390dp,height=844dp,dpi=160")
@Composable
fun ChartQuotaSemanticsTrendScreenshot() { SemanticFixture("trend") }

@PreviewTest
@Preview(name = "Semantics error", device = "spec:width=390dp,height=844dp,dpi=160")
@Composable
fun ChartQuotaSemanticsErrorScreenshot() { SemanticFixture("error") }

@PreviewTest
@Preview(name = "Semantics mixed", device = "spec:width=390dp,height=844dp,dpi=160")
@Composable
fun ChartQuotaSemanticsMixedScreenshot() { SemanticFixture("mixed") }


private fun nativeChartStats(
    current: List<ComparisonSeriesPoint> = listOf(
        point("2026-09-07 01:00:00", 1_234_567, 12.34),
        point("2026-09-07 02:00:00", 420_000, .007)
    ),
    previous: List<ComparisonSeriesPoint> = listOf(
        point("2026-09-06 01:00:00", 900_123, 6.78),
        point("2026-09-06 02:00:00", 230_000, .003),
        point("2026-09-06 03:00:00", 310_000, 1.2)
    ),
    zeroTools: Set<String> = emptySet(),
    allZero: Boolean = false,
    // 有总量但一个来源都没有——真机上从离线缓存渲染时就是这个状态。
    // 它与 allZero 不同：allZero 是「来源都在，值都是 0」，这里是「压根没有来源」，
    // 于是 donutPresentation 会返回一段占满全圆的「未显示」，而不是空 segments。
    noTools: Boolean = false
): StatsData {
    val names = if (noTools) emptyList() else listOf("codex", "claude", "gemini", "cursor", "aider", "opencode")
    val tools = names.mapIndexed { index, name ->
        val value = if (allZero || name in zeroTools) 0L else (6 - index) * 10_000L
        ToolStat(name, value, 0, 0, value, 0.0, 1)
    }
    val models = listOf(
        ModelStat("gpt-5-long-context", 120_000, 7, input = 100_000, output = 20_000, cached = 9_000, cost = 12.34),
        ModelStat("claude-sonnet", 70_000, 5, input = 60_000, output = 10_000, cached = 4_000, cost = 6.78),
        ModelStat("gemini-pro", 20_000, 2, input = 18_000, output = 2_000, cached = 0, cost = null)
    )
    // 没有来源时总量仍然是已知的（概览大数就是这么来的），这正是这张预览要钉的状态。
    val effective = if (noTools) 987_600_000L else tools.sumOf(ToolStat::effectiveTokens)
    val summary = Summary(
        totalTokens = effective,
        inputTokens = effective,
        outputTokens = 0,
        cachedTokens = 0,
        totalCost = 19.12,
        totalRequests = 15
    )
    return StatsData(
        summary = summary,
        tools = tools.associateBy(ToolStat::name),
        models = models.associateBy(ModelStat::name),
        trends = emptyList(),
        heatmap = emptyMap(),
        history = emptyList(),
        machines = listOf("n2301-fixture"),
        meta = StatsMeta(
            generatedAt = "2026-09-07T10:00:03+08:00",
            lastRefreshedAt = "2026-09-07T10:00:03+08:00",
            timezone = "Asia/Shanghai",
            range = "today",
            machine = null,
            stale = false,
            contractVersion = 2,
            query = StatsQueryEcho(range = "today", timezone = "Asia/Shanghai", tokenMode = "effective")
        ),
        comparison = UsageComparison(
            window = ComparisonWindow(
                kind = "dayOverDay",
                timezone = "Asia/Shanghai",
                bucket = "hour",
                currentStart = "2026-09-07T00:00:00+08:00",
                currentEnd = "2026-09-08T00:00:00+08:00",
                previousStart = "2026-09-06T00:00:00+08:00",
                previousEnd = "2026-09-07T00:00:00+08:00",
                alignedThrough = "2026-09-07T10:00:03+08:00"
            ),
            current = ComparisonPeriod(summary, current),
            previous = ComparisonPeriod(summary.copy(inputTokens = 140_000), previous),
            delta = ComparisonDelta(
                MetricDelta(70_000.0, 50.0, "up"),
                MetricDelta(3.0, 25.0, "up"),
                MetricDelta(5.0, 35.0, "up")
            )
        )
    )
}

private fun point(bucket: String, tokens: Long, cost: Double) = ComparisonSeriesPoint(bucket, tokens, 3, cost)

private enum class QuotaKind { Mixed, Error, Details }

private fun nativeQuotaAvailable(kind: QuotaKind): QuotaUiState.Available {
    val fresh = quotaWindow("five-hour", "5 小时窗口", "2026-09-07T09:59:50+08:00", 300)
    val old = quotaWindow("week", "7 天窗口", "2026-09-06T09:00:00+08:00", 10_080)
    val provider = QuotaProviderEnvelope(
        schemaVersion = 1,
        providerId = "openai-codex-local",
        displayName = "Codex",
        scope = QuotaScope.ConsumerSubscription,
        mode = QuotaMode.Automatic,
        capability = QuotaCapability.Stable,
        status = if (kind == QuotaKind.Error) QuotaProviderStatus.Error else QuotaProviderStatus.Ok,
        windows = if (kind == QuotaKind.Details) listOf(fresh) else listOf(fresh, old),
        reasonCode = if (kind == QuotaKind.Error) "upstream_unavailable" else null
    )
    val snapshot = QuotaTransportSnapshot(
        transportVersion = 2,
        epoch = 7,
        revision = 12,
        generatedAt = "2026-09-07T10:00:03+08:00",
        providers = listOf(provider)
    )
    return QuotaUiState.Available(
        snapshot = snapshot,
        showingCachedData = false,
        savedAtEpochMillis = 0,
        evaluatedAtEpochMillis = Instant.parse("2026-09-07T02:00:00Z").toEpochMilli()
    )
}

private fun quotaWindow(id: String, label: String, observedAt: String, minutes: Int) = QuotaWindowSnapshot(
    providerId = "openai-codex-local",
    windowId = id,
    windowLabel = label,
    scope = QuotaScope.ConsumerSubscription,
    source = QuotaSource.LocalAuthorized,
    status = QuotaWindowStatus.Ok,
    used = 27.5,
    limit = 100.0,
    remaining = 72.5,
    unit = QuotaUnit.Percent,
    windowMinutes = minutes,
    resetsAt = "2026-09-08T08:00:00+08:00",
    observedAt = observedAt,
    fetchedAt = "2026-09-07T09:59:55+08:00",
    staleAfterSeconds = 60,
    reasonCode = null
)


@PreviewTest
@Preview(name = "Semantics normal", device = "spec:width=390dp,height=1300dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaSemanticsNormalScreenshot() { SemanticFixture("normal") }

@PreviewTest
@Preview(name = "Semantics empty", device = "spec:width=390dp,height=1300dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaSemanticsEmptyScreenshot() { SemanticFixture("empty") }

@PreviewTest
@Preview(name = "Semantics missing", device = "spec:width=390dp,height=1300dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaSemanticsMissingScreenshot() { SemanticFixture("missing") }

@PreviewTest
@Preview(name = "Semantics sources", device = "spec:width=390dp,height=1300dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaSemanticsSourcesScreenshot() { SemanticFixture("sources") }

@PreviewTest
@Preview(name = "Semantics zero", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaSemanticsZeroScreenshot() { SemanticFixture("zero") }

@PreviewTest
@Preview(name = "Semantics allzero", device = "spec:width=390dp,height=1300dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaSemanticsAllzeroScreenshot() { SemanticFixture("allzero") }

@PreviewTest
@Preview(name = "Semantics tools", device = "spec:width=320dp,height=1300dp,dpi=160", fontScale = 2.0f)
@Composable
fun ChartQuotaSemanticsToolsScreenshot() { SemanticFixture("tools") }

@PreviewTest
@Preview(name = "Semantics models", device = "spec:width=320dp,height=1300dp,dpi=160", fontScale = 2.0f)
@Composable
fun ChartQuotaSemanticsModelsScreenshot() { SemanticFixture("models") }

@PreviewTest
@Preview(name = "Semantics masked", device = "spec:width=320dp,height=1300dp,dpi=160", fontScale = 2.0f)
@Composable
fun ChartQuotaSemanticsMaskedScreenshot() { SemanticFixture("masked") }

@PreviewTest
@Preview(name = "Semantics details", device = "spec:width=320dp,height=1800dp,dpi=160", fontScale = 2.0f)
@Composable
fun ChartQuotaSemanticsDetailsScreenshot() { SemanticFixture("details") }
