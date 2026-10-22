package com.jeidorf.tokenledger.mobile

import android.graphics.Bitmap
import android.os.Bundle
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/** 原生节点成对测量。字号只在独立测试 composition 注入，不修改系统设置。 */
@RunWith(Parameterized::class)
class LedgerSelectionBoundsTest(private val appearance: LedgerAppearance, private val fontScale: Float) {
    @get:Rule val rule = createComposeRule()
    private var harness: Harness? = null

    companion object {
        @JvmStatic @Parameterized.Parameters(name = "{0}-font{1}")
        fun configurations(): List<Array<Any>> = listOf(
            arrayOf(LedgerAppearance.Light, 1f), arrayOf(LedgerAppearance.Dark, 1f),
            arrayOf(LedgerAppearance.Light, 2f), arrayOf(LedgerAppearance.Dark, 2f)
        )
    }

    @After fun dispose() { harness?.close() }

    private fun mount(destination: MobileDestination, pane: InsightPane = InsightPane.Trend): Harness =
        DateInteractionFixture.createHarness(rule, appearance, fontScale,
            initialDestination = destination, initialInsightPane = pane).also {
            harness = it
            it.awaitReady()
        }

    private fun choice(label: String) = rule.onNode(hasText(label) and hasClickAction())
    private fun described(label: String) = rule.onNodeWithContentDescription(label)
    private fun rangeNodes(): Map<String, SemanticsNodeInteraction> = buildMap {
        RangeKey.entries.filter { it != RangeKey.Custom }.forEach { put(it.name, choice(it.label)) }
        put("Custom", described("选择自定义日期范围"))
    }
    private fun paneNodes() = InsightPane.entries.associate { it.name to choice(it.label) }
    private fun metricNodes() = ReportMetricMode.entries.associate { it.name to described("${it.label}视图") }
    private fun currencyNodes() = CurrencyUnit.entries.associate { it.name to described("${it.label}币种") }
    private fun boxes(nodes: Map<String, SemanticsNodeInteraction>): Map<String, Rect> = nodes.mapValues { (_, node) ->
        node.assertIsDisplayed().fetchSemanticsNode().boundsInRoot
    }
    private fun stable(before: Map<String, Rect>, after: Map<String, Rect>) {
        assertEquals(before.keys, after.keys)
        before.forEach { (name, old) ->
            val next = after.getValue(name)
            listOf(old.left to next.left, old.top to next.top, old.right to next.right, old.bottom to next.bottom)
                .forEachIndexed { axis, (a, b) -> assertEquals("$name axis $axis, $appearance/$fontScale", a, b, 0.5f) }
        }
    }
    private fun touchTargets(nodes: Map<String, SemanticsNodeInteraction>) {
        val bounds = boxes(nodes)
        val min = with(rule.density) { 48f * density }
        bounds.forEach { (name, rect) ->
            assertTrue("$name width ${rect.width} < $min", rect.width >= min - 0.5f)
            assertTrue("$name height ${rect.height} < $min", rect.height >= min - 0.5f)
        }
        bounds.entries.toList().forEachIndexed { i, a ->
            bounds.entries.toList().drop(i + 1).forEach { b ->
                assertTrue("${a.key} overlaps ${b.key}", !a.value.overlaps(b.value))
            }
        }
    }
    private fun record(name: String, values: Map<String, Rect>) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val id = "$name-${appearance.name}-font$fontScale"
        val output = File(instrumentation.targetContext.filesDir, "t10-118q").apply { mkdirs() }
        val data = JSONObject().put("case", id).put("fixture", true)
            .put("fontScale", fontScale).put("appearance", appearance.name)
            .put("boundsPx", JSONObject().apply { values.forEach { (key, rect) ->
                put(key, JSONArray(listOf(rect.left, rect.top, rect.right, rect.bottom)))
            } })
        File(output, "$id.json").writeText(data.toString(2))
        File(output, "$id.png").outputStream().use {
            check(rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it))
        }
        instrumentation.sendStatus(0, Bundle().apply { putString("stream", "T10.118q $data\n") })
    }

    @Test fun dateChoicesAndRefreshDisabledKeepBounds() {
        val host = mount(MobileDestination.Overview)
        val controls = rangeNodes()
        choice(RangeKey.Today.label).assertIsSelected()
        controls.values.forEach { it.assertIsEnabled() }
        touchTargets(controls)
        val before = boxes(controls) + ("refresh" to described("刷新数据").fetchSemanticsNode().boundsInRoot) +
            ("settingsAnchor" to described("打开设置").fetchSemanticsNode().boundsInRoot)
        record("date-idle", before)
        val pending = host.source.holdNext({ it.range == RangeKey.Week })
        choice(RangeKey.Week.label).performClick()
        rule.waitUntil(5_000) { pending.request != null }
        choice(RangeKey.Week.label).assertIsSelected()
        choice(RangeKey.Today.label).assertIsNotSelected()
        described("正在刷新").assertIsNotEnabled()
        controls.values.forEach { it.assertIsEnabled() }
        val loading = boxes(controls) + ("refresh" to described("正在刷新").fetchSemanticsNode().boundsInRoot) +
            ("settingsAnchor" to described("打开设置").fetchSemanticsNode().boundsInRoot)
        record("date-selected-loading", loading)
        stable(before, loading)
        pending.succeed(DateInteractionFixture.GLOBAL_TOKENS)
        host.awaitReady()
        val after = boxes(controls) + ("refresh" to described("刷新数据").assertIsEnabled().fetchSemanticsNode().boundsInRoot) +
            ("settingsAnchor" to described("打开设置").fetchSemanticsNode().boundsInRoot)
        stable(before, after)
        record("date-selected-idle", after)
    }

    @Test fun insightPaneSelectionKeepsStripAndRangeAnchor() {
        mount(MobileDestination.Insights)
        val controls = paneNodes()
        touchTargets(controls)
        val before = boxes(controls)
        val anchor = rule.onNode(hasText("当前范围：", substring = true)).fetchSemanticsNode().boundsInRoot
        record("pane-trend", before + ("rangeAnchor" to anchor))
        listOf(InsightPane.Sources, InsightPane.Calendar, InsightPane.Details, InsightPane.Trend).forEach { pane ->
            choice(pane.label).performClick().assertIsSelected()
            controls.filterKeys { it != pane.name }.values.forEach { it.assertIsNotSelected() }
            stable(before, boxes(controls))
            val nextAnchor = rule.onNode(hasText("当前范围：", substring = true)).fetchSemanticsNode().boundsInRoot
            stable(mapOf("rangeAnchor" to anchor), mapOf("rangeAnchor" to nextAnchor))
            record("pane-${pane.name}", boxes(controls) + ("rangeAnchor" to nextAnchor))
        }
    }

    // 图表和图例提示与切换器同属一个已组合的趋势卡。大字号时允许它们位于屏外，
    // 读取真实未裁剪布局坐标，不能拿屏幕裁剪后的零尺寸或每步滚动重新定位冒充稳定。
    private fun unclippedBox(node: SemanticsNodeInteraction): Rect {
        val bounds = node.getUnclippedBoundsInRoot()
        val density = rule.density.density
        return Rect(bounds.left.value * density, bounds.top.value * density,
            bounds.right.value * density, bounds.bottom.value * density).also {
            assertTrue("Anchor must retain a non-empty composed layout", it.width > 0f && it.height > 0f)
        }
    }

    private fun metricFrame(): Map<String, Rect> = boxes(metricNodes()) + mapOf(
        "headingAnchor" to unclippedBox(rule.onNodeWithText("同期趋势")),
        "chartAnchor" to unclippedBox(rule.onNode(hasContentDescription("平滑 ", substring = true))),
        "legendHintAnchor" to unclippedBox(rule.onNodeWithText("滑动查看时段明细", useUnmergedTree = true)),
        "viewportAnchor" to rule.onRoot().fetchSemanticsNode().boundsInRoot
    )

    private fun verticalScrollAxisValue(): Float = rule.onNode(
        SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange)
    ).fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()

    @Test fun metricAndCurrencySelectionKeepControlsAndDownstreamLayout() {
        mount(MobileDestination.Insights)
        val metrics = metricNodes()
        touchTargets(metrics)
        val before = metricFrame()
        val initialScroll = verticalScrollAxisValue()
        fun assertFrame(): Map<String, Rect> = metricFrame().also {
            stable(before, it)
            assertEquals("Selection must not reposition the viewport or scroll container",
                initialScroll, verticalScrollAxisValue(), 0.0001f)
        }
        // 整段状态序列不调用 performScrollTo；按钮、上游标题、下游图表/图例和视口一起比较。
        described("Token 消耗视图").assertIsSelected()
        record("metric-tokens", before)
        described("预估费用视图").performClick().assertIsSelected()
        described("Token 消耗视图").assertIsNotSelected()
        val currencies = currencyNodes()
        touchTargets(currencies)
        val currencyBefore = boxes(currencies)
        record("metric-cost", assertFrame() + currencyBefore)
        CurrencyUnit.entries.forEach { currency ->
            described("${currency.label}币种").performClick().assertIsSelected()
            currencies.filterKeys { it != currency.name }.values.forEach { it.assertIsNotSelected() }
            stable(currencyBefore, boxes(currencies))
            record("currency-${currency.name}", assertFrame() + boxes(currencies))
        }
        described("Token 消耗视图").performClick().assertIsSelected()
        described("预估费用视图").assertIsNotSelected()
        currencies.values.forEach { it.assertDoesNotExist() }
        record("metric-tokens-restored", assertFrame())
    }
}
