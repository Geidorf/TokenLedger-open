package com.jeidorf.tokenledger.mobile

import android.graphics.Bitmap
import android.os.Bundle
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Surface
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.jeidorf.tokenledger.mobile.ui.hero.V2HeroCostToggle
import com.jeidorf.tokenledger.mobile.ui.charts.V2TrendChart
import com.jeidorf.tokenledger.mobile.ui.controls.V2CustomRangeDialog
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import com.jeidorf.tokenledger.mobile.ui.quota.V2ProviderCard
import java.io.File
import java.time.Instant
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * T10.218c: 只挂载生产绘制器/组件的设备回归入口。
 *
 * 它不写 QA 会话、缓存或小组件实例；输出仅写入 instrumentation target 的 files/evidence/T10.218。
 */
class VisualReviewNativeTest {
    @get:Rule val compose = createComposeRule()
    @Test
    fun scorecardLongHeroAndIndividualOneThreeSevenNinePointExportsUseProductionRenderer() {
        requireQaTarget()
        val summary = ShareSummary(
            range = RangeKey.Week,
            title = "我的 AI 协作周报",
            periodLabel = "7月1日—7月9日",
            effectiveTokens = 999_500_000L,
            inputTokens = 700_000_000L,
            outputTokens = 299_500_000L,
            cachedTokens = 0L,
            totalRequests = 4_321L,
            deltaPercent = 12.7,
            activeDays = 7,
            longestStreakDays = 9,
            peakLabel = "7月9日",
            peakTokens = 200_000_000L,
            cacheReusePercent = null,
            costCny = null,
            netSavedCostCny = null,
            topTool = "codex",
            topModel = "gpt-5",
            points = listOf(
                SharePoint("2026-07-01", "7/1", "周三", 80_000_000L, 1),
                SharePoint("2026-07-02", "7/2", "周四", 90_000_000L, 1),
                SharePoint("2026-07-03", "7/3", "周五", 100_000_000L, 1),
                SharePoint("2026-07-04", "7/4", "周六", 120_000_000L, 1),
                SharePoint("2026-07-05", "7/5", "周日", 140_000_000L, 1),
                SharePoint("2026-07-06", "7/6", "周一", 160_000_000L, 1),
                SharePoint("2026-07-07", "7/7", "周二", 180_000_000L, 1),
                SharePoint("2026-07-08", "7/8", "周三", 190_000_000L, 1),
                SharePoint("2026-07-09", "7/9", "周四", 200_000_000L, 1)
            ),
            highlight = "连续协作 9 天",
            dataSourceLabel = "匿名 QA 夹具",
            generatedDateLabel = "2026.07.09",
            includesEstimates = false,
            stale = false,
            costMasked = false
        )
        listOf(1, 3, 7, 9).forEach { pointCount ->
            val visiblePoints = summary.points.takeLast(pointCount)
            val bitmap = SharePosterRenderer.render(targetContext, summary.copy(points = visiblePoints), ShareLayoutKey.Scorecard)
            assertEquals(1080, bitmap.width)
            assertEquals(1920, bitmap.height)
            assertTrue("999.5M 蓝色主数值存在且不越过右侧安全边", blueInkRightEdge(bitmap, 260, 540) in 800..1024)
            scorecardTrendXPositions(minOf(pointCount, 7)).forEachIndexed { index, x ->
                assertHasVisibleInk(bitmap, (x - 50).toInt(), 1280, (x + 50).toInt(), 1375, "date-$pointCount-$index")
            }
            File(evidenceDirectory(), "scorecard-long-999_5m-$pointCount-points.png")
                .writeBytes(SharePosterRenderer.encodePng(bitmap))
        }
        writeMetadata("scorecard-long", JSONObject().put("fontScale", "canvas-fixed").put("pointCounts", "1,3,7,9"))
    }

    @Test
    fun longProviderNameAtFontScaleTwoIsFullyLaidOutInProductionCard() {
        requireQaTarget()
        val providerName = "团队共享 OpenAPI 额度 · 北美研发账号"
        val quota = quota(providerName)
        compose.setContent {
            val system = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(system.density, 2f)) {
                TokenLedgerTheme(LedgerAppearance.Light) {
                    Box(Modifier.fillMaxSize().padding(top = 32.dp).testTag("visual-review-provider")) {
                        V2ProviderCard(v2Palette(LedgerAppearance.Light), quota.snapshot.providers.single(), quota)
                    }
                }
            }
        }
        compose.waitForIdle()
        val nodes = compose.onAllNodesWithText(providerName, useUnmergedTree = true).fetchSemanticsNodes()
        assertEquals("长 Provider 名必须作为一个完整 Text 节点出现", 1, nodes.size)
        val container = compose.onNodeWithTag("visual-review-provider", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val text = nodes.single().boundsInRoot
        assertTrue("Provider 左侧越界: $text / $container", text.left >= container.left)
        assertTrue("Provider 右侧裁切: $text / $container", text.right <= container.right)
        val layout = textLayouts(compose.onNodeWithText(providerName, useUnmergedTree = true)).single()
        assertTrue("Provider 名字不得产生视觉溢出", !layout.hasVisualOverflow)
        assertEquals("Provider 名字末字符必须参与布局", providerName.lastIndex, layout.getLineEnd(layout.lineCount - 1, visibleEnd = true) - 1)
        saveFrame("provider-long-font200", 2f)
    }

    @Test
    fun customRangeDialogNormalDatesApplyWithoutRemovedTimezoneHint() {
        requireQaTarget()
        var applied: Pair<String, String>? = null
        compose.setContent {
            TokenLedgerTheme(LedgerAppearance.Light) {
                V2CustomRangeDialog(v2Palette(LedgerAppearance.Light), DashboardQuery(RangeKey.Custom, start = "2026-07-03", end = "2026-07-09"), {}, { start, end -> applied = start to end })
            }
        }
        compose.onAllNodesWithText("查询结果以响应标明的时区为准。", substring = true, useUnmergedTree = true)
            .fetchSemanticsNodes().let { assertTrue("已删除的技术提示不得回归", it.isEmpty()) }
        compose.onNodeWithText("应用", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        assertEquals("2026-07-03" to "2026-07-09", applied)
        saveFrame("custom-range-normal", 1f)
    }

    @Test
    fun entityTrendAxisAtFontScaleTwoHasVisibleUnclippedTextLayouts() {
        requireQaTarget()
        val fallback = listOf(
            TrendPoint("00:00", mapOf("entity" to 100L), 1),
            TrendPoint("06:00", mapOf("entity" to 200L), 1),
            TrendPoint("12:00", mapOf("entity" to 300L), 1)
        )
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                TokenLedgerTheme(LedgerAppearance.Light) {
                    Box(Modifier.padding(top = 32.dp)) {
                        V2TrendChart(v2Palette(LedgerAppearance.Light), null, fallback, Modifier.fillMaxWidth().height(142.dp), compact = false)
                    }
                }
            }
        }
        compose.waitForIdle()
        saveFrame("entity-trend-axis-font200", 2f)
        val labels = fallback.map { formatTrendAnchorLabel(it.date) }.distinct()
        labels.forEach { label ->
            val node = compose.onNodeWithText(label, useUnmergedTree = true)
            val layout = textLayouts(node).single()
            val bounds = node.fetchSemanticsNode().boundsInRoot
            assertTrue("X 轴 $label 实际显示高度必须容纳字形", bounds.height + 1f >= layout.size.height)
            writeMetadata("axis-" + label.replace(":", ""), JSONObject().put("size", layout.size.toString()).put("bounds", bounds.toString()).put("lineHeight", layout.layoutInput.style.lineHeight.toString()).put("lineBottom", layout.getLineBottom(0)).put("overflowHeight", layout.didOverflowHeight).put("overflowWidth", layout.didOverflowWidth).put("paragraphWidth", layout.multiParagraph.width).put("lineRight", layout.getLineRight(0)))
            assertTrue("X 轴 $label 高度不得溢出", !layout.didOverflowHeight)
            assertTrue("X 轴 $label 完整行宽不得超出容器（允许 1px 整数取整）", layout.getLineRight(0) <= layout.size.width + 1f)
            assertTrue("X 轴 $label 必须有实际行高", layout.size.height > 0)
            node.assertIsDisplayed()
        }
        saveFrame("entity-trend-axis-font200", 2f)
    }

    @Test
    fun narrowHeroCostAtFontScaleTwoKeepsCompleteAmountAndToggle() {
        requireQaTarget()
        var toggled = false
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(
                LocalDensity provides Density(density.density, 2f),
                LocalDashboardCurrency provides CurrencyUnit.CNY,
                LocalToggleCostMask provides { toggled = true }
            ) {
                TokenLedgerTheme(LedgerAppearance.Dark) {
                    Surface(color = v2Palette(LedgerAppearance.Dark).background) {
                        Box(Modifier.width(284.dp).padding(12.dp)) {
                            V2HeroCostToggle(v2Palette(LedgerAppearance.Dark), 128_640.34 / BuildConfig.TOKENLEDGER_CNY_EXCHANGE_RATE, stacked = true)
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
        val amount = compose.onNodeWithText("¥128,640.34", useUnmergedTree = true)
        val label = compose.onNodeWithText("预估费用", useUnmergedTree = true)
        val layout = textLayouts(amount).single()
        assertTrue("金额完整行宽必须落在可见区域内", layout.getLineRight(0) <= layout.size.width + 1f)
        assertTrue("金额不得截断或省略", !layout.didOverflowHeight && !layout.isLineEllipsized(0))
        assertEquals("完整金额末位必须参与布局", "¥128,640.34".length, layout.getLineEnd(0, visibleEnd = true))
        assertTrue("金额应排在标签下方", amount.fetchSemanticsNode().boundsInRoot.top >= label.fetchSemanticsNode().boundsInRoot.bottom)
        amount.assertIsDisplayed()
        amount.performClick()
        compose.runOnIdle { assertTrue("费用隐身开关仍可操作", toggled) }
        saveFrame("hero-cost-320-font200", 2f)
    }

    private fun quota(displayName: String): QuotaUiState.Available {
        val providerId = "fixture-team-plan"
        val window = QuotaWindowSnapshot(
            providerId = providerId, windowId = "five-hour", windowLabel = "5 小时窗口",
            scope = QuotaScope.ConsumerSubscription, source = QuotaSource.LocalAuthorized,
            status = QuotaWindowStatus.Ok, used = 27.5, limit = 100.0, remaining = 72.5,
            unit = QuotaUnit.Percent, windowMinutes = 300, resetsAt = "2026-09-08T08:00:00+08:00",
            observedAt = "2026-09-07T09:59:50+08:00", fetchedAt = "2026-09-07T09:59:55+08:00",
            staleAfterSeconds = 60, reasonCode = null
        )
        return QuotaUiState.Available(
            snapshot = QuotaTransportSnapshot(2, 1, 1, "2026-09-07T10:00:03+08:00", listOf(
                QuotaProviderEnvelope(1, providerId, displayName, QuotaScope.ConsumerSubscription,
                    QuotaMode.Automatic, QuotaCapability.Stable, QuotaProviderStatus.Ok, listOf(window), null)
            )),
            showingCachedData = false, savedAtEpochMillis = 0,
            evaluatedAtEpochMillis = Instant.parse("2026-09-07T02:00:00Z").toEpochMilli()
        )
    }

    private fun assertHasVisibleInk(bitmap: Bitmap, left: Int, top: Int, right: Int, bottom: Int, label: String) {
        var visible = false
        loop@ for (y in top until bottom step 4) for (x in left until right step 4) {
            val color = bitmap.getPixel(x, y)
            if ((color ushr 16 and 0xff) > 80 || (color ushr 8 and 0xff) > 85 || (color and 0xff) > 110) {
                visible = true
                break@loop
            }
        }
        assertTrue("$label 应在导出 PNG 的审计区域中留下可见像素", visible)
    }

    private fun saveFrame(name: String, fontScale: Float) {
        compose.waitForIdle()
        // 测试宿主的系统合成截图在 API 36 可能是黑帧；组件证据使用实际 Compose 像素。
        // 主 Activity 与 Launcher 全帧另由 ADB 截取，不把组件截图冒充整机画面。
        val root = if (name.startsWith("custom-range")) compose.onNode(isDialog()) else compose.onRoot()
        File(evidenceDirectory(), "$name-compose.png").outputStream().use {
            check(root.captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it))
        }
        writeMetadata(name, JSONObject().put("fontScale", fontScale).put("capture", "device-compose-root"))
    }

    private fun textLayouts(node: SemanticsNodeInteraction): List<TextLayoutResult> {
        val results = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> action(results) }
        return results
    }

    private fun blueInkRightEdge(bitmap: Bitmap, top: Int, bottom: Int): Int {
        var right = 0
        for (y in top until bottom) for (x in 0 until bitmap.width) {
            val color = bitmap.getPixel(x, y)
            if ((color and 0xff) > 150 && (color and 0xff) > (color ushr 16 and 0xff) + 30) right = maxOf(right, x)
        }
        return right
    }

    private fun requireQaTarget() {
        check(targetContext.packageName.endsWith(".qa")) { "visual review fixtures may run only in QA package" }
    }

    private val targetContext get() = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
    private fun evidenceDirectory(): File = File(targetContext.filesDir, "evidence/T10.218").apply { mkdirs() }
    private fun writeMetadata(name: String, data: JSONObject) {
        data.put("fixture", true).put("package", targetContext.packageName)
        File(evidenceDirectory(), "$name.json").writeText(data.toString(2))
        InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply { putString("stream", "T10.218c $name $data\n") })
    }
}
