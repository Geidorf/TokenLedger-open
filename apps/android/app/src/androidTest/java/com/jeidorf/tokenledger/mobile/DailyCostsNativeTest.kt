package com.jeidorf.tokenledger.mobile

import android.graphics.Bitmap
import android.os.Bundle
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * T10.118b 的 N2301 原生验收：直接渲染生产日金额卡，并让所有金额继续经过
 * StatsData/dailyCosts 与 recentDailyActivityRows 的同一投影。
 */
class DailyCostsNativeTest {
    @get:Rule
    val compose = createComposeRule()

    private val query = DashboardQuery(range = RangeKey.Month)

    @Test
    fun normalDateTokensAndRenminbiAmountAreDisplayed() {
        mount(fixture(amountUsd = 1.2))

        val nodes = linkedMapOf(
            "date" to text("2026-07-15"),
            "tokens" to text("有效 Token 1,234,567"),
            "amount" to described("预估费用8.64元")
        )
        nodes.values.forEach { it.assertIsDisplayed() }
        record("normal", nodes, injectedFontScale = 1f)
    }

    @Test
    fun positiveSmallAmountUsesLessThanOneCentInsteadOfZero() {
        mount(fixture(amountUsd = 0.001))

        val amount = described("预估费用不足0.01元").assertIsDisplayed()
        compose.onNodeWithContentDescription("预估费用0.00元", useUnmergedTree = true)
            .assertDoesNotExist()
        val semantics = semanticsDumps()
        assertFalse(semantics.first.contains("¥0.00"))
        assertFalse(semantics.second.contains("¥0.00"))
        record("small-positive", mapOf("amount" to amount), injectedFontScale = 1f)
    }

    @Test
    fun unavailableProjectionCoversMissingPartialLegacyAndQueryMismatch() {
        val currentStats = mutableStateOf(fixture(dailyCostsMode = DailyCostsMode.Missing))
        val currentQuery = mutableStateOf(query)
        compose.setContent {
            val systemDensity = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(systemDensity.density, 1f)) {
                Box(Modifier.fillMaxSize().testTagCompat(CONTAINER_TAG)) {
                    V2DailyCostsPreviewContent(
                        LedgerAppearance.Light,
                        currentStats.value,
                        currentQuery.value
                    )
                }
            }
        }

        val scenarios = listOf(
            "missing" to fixture(dailyCostsMode = DailyCostsMode.Missing),
            "partial" to fixture(dailyCostsMode = DailyCostsMode.Partial),
            "legacy" to fixture(dailyCostsMode = DailyCostsMode.Complete).copy(legacyRpc = true),
            "query-mismatch" to fixture(dailyCostsMode = DailyCostsMode.Complete)
        )
        scenarios.forEach { (name, stats) ->
            compose.runOnIdle {
                currentStats.value = stats
                currentQuery.value = if (name == "query-mismatch") {
                    query.copy(tools = listOf("codex"))
                } else {
                    query
                }
            }
            compose.waitForIdle()
            val unavailable = described("预估费用不可得").assertIsDisplayed()
            compose.onNodeWithContentDescription("预估费用8.64元", useUnmergedTree = true)
                .assertDoesNotExist()
            record(name, mapOf("amount" to unavailable), injectedFontScale = 1f)
        }
    }

    @Test
    fun maskedAmountRemovesOriginalValueFromMergedAndUnmergedSemantics() {
        mount(fixture(amountUsd = 1.2), masked = true)

        val masked = described("预估费用已隐藏").assertIsDisplayed()
        val (merged, unmerged) = semanticsDumps()
        listOf(merged, unmerged).forEach { tree ->
            assertTrue(tree.contains("预估费用已隐藏"))
            assertFalse(tree.contains("预估费用8.64元"))
            assertFalse(tree.contains("¥8.64"))
        }
        record("masked", mapOf("amount" to masked), injectedFontScale = 1f)
    }

    @Test
    fun narrow320DpAtFontScaleTwoKeepsAllFieldsInsideWithoutOverlap() {
        mount(fixture(amountUsd = 1.2), widthDp = 320, fontScale = 2f)

        val container = compose.onNodeWithTag(CONTAINER_TAG, useUnmergedTree = true)
            .assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertEquals(
            "受约束测试容器必须等价于320dp，不代表设备物理宽度",
            320f * compose.density.density,
            container.width,
            0.5f
        )
        val nodes = linkedMapOf(
            "date" to text("2026-07-15"),
            "tokens" to text("有效 Token 1,234,567"),
            "amount" to described("预估费用8.64元")
        )
        val bounds = nodes.mapValues { (_, node) ->
            node.assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        }
        bounds.forEach { (name, rect) ->
            assertTrue("$name left ${rect.left} < ${container.left}", rect.left >= container.left - 0.5f)
            assertTrue("$name top ${rect.top} < ${container.top}", rect.top >= container.top - 0.5f)
            assertTrue("$name right ${rect.right} > ${container.right}", rect.right <= container.right + 0.5f)
            assertTrue("$name bottom ${rect.bottom} > ${container.bottom}", rect.bottom <= container.bottom + 0.5f)
            assertTrue("$name must retain non-empty bounds", rect.width > 0f && rect.height > 0f)
        }
        bounds.entries.toList().forEachIndexed { index, entry ->
            bounds.entries.toList().drop(index + 1).forEach { other ->
                assertFalse("${entry.key} overlaps ${other.key}", entry.value.overlaps(other.value))
            }
        }
        record(
            "narrow-320-font2",
            nodes,
            extraBounds = mapOf("container" to container),
            injectedFontScale = 2f,
            constrainedContainerWidthDp = 320
        )
    }

    @Test
    fun productionCardShowsDisclaimerExactlyOnce() {
        mount(fixture(amountUsd = 1.2))

        val disclaimer = "按已有记录汇总，未逐笔核价"
        val matches = compose.onAllNodesWithText(disclaimer, useUnmergedTree = true)
            .fetchSemanticsNodes()
        assertEquals(1, matches.size)
        compose.onNodeWithText(disclaimer, useUnmergedTree = true).assertIsDisplayed()
        record(
            "single-disclaimer",
            mapOf("disclaimer" to text(disclaimer)),
            injectedFontScale = 1f
        )
    }

    private fun mount(
        stats: StatsData,
        masked: Boolean = false,
        widthDp: Int? = null,
        fontScale: Float = 1f
    ) {
        compose.setContent {
            val systemDensity = LocalDensity.current
            CompositionLocalProvider(
                LocalDensity provides Density(systemDensity.density, fontScale)
            ) {
                val modifier = if (widthDp == null) {
                    Modifier.fillMaxSize()
                } else {
                    Modifier.width(widthDp.dp).height(520.dp)
                }
                Box(modifier.testTagCompat(CONTAINER_TAG)) {
                    V2DailyCostsPreviewContent(
                        LedgerAppearance.Light,
                        stats,
                        query,
                        masked = masked
                    )
                }
            }
        }
    }

    private fun fixture(
        amountUsd: Double? = 1.2,
        dailyCostsMode: DailyCostsMode = DailyCostsMode.Complete
    ): StatsData {
        val dailyCosts = when (dailyCostsMode) {
            DailyCostsMode.Missing -> null
            DailyCostsMode.Complete -> DailyCosts(
                coverage = DailyCostsCoverage(
                    start = "2026-07-01",
                    end = "2026-07-15",
                    timezone = "Asia/Shanghai",
                    state = DailyCostsCoverageState.Complete
                ),
                days = listOf(
                    DailyCostDay(
                        date = "2026-07-15",
                        amountUsd = amountUsd,
                        status = DailyCostStatus.RecordedEstimate
                    )
                )
            )
            DailyCostsMode.Partial -> DailyCosts(
                coverage = DailyCostsCoverage(
                    start = "2026-07-01",
                    end = "2026-07-15",
                    timezone = "Asia/Shanghai",
                    state = DailyCostsCoverageState.Partial
                ),
                days = listOf(
                    DailyCostDay(
                        date = "2026-07-15",
                        amountUsd = null,
                        status = DailyCostStatus.Unavailable,
                        reason = DailyCostUnavailableReason.IncompleteCoverage
                    )
                )
            )
        }
        return StatsData(
            summary = Summary(inputTokens = 1_000_000, outputTokens = 234_567),
            tools = emptyMap(),
            models = emptyMap(),
            trends = emptyList(),
            heatmap = mapOf("2026-07-15" to 1_234_567L),
            history = emptyList(),
            machines = emptyList(),
            meta = StatsMeta(
                generatedAt = "2026-07-15T09:30:00+08:00",
                lastRefreshedAt = null,
                timezone = "Asia/Shanghai",
                range = "month",
                machine = null,
                stale = false,
                contractVersion = 2,
                query = StatsQueryEcho(
                    range = "month",
                    timezone = "Asia/Shanghai",
                    tokenMode = "effective"
                )
            ),
            dailyCosts = dailyCosts
        )
    }

    private fun text(value: String): SemanticsNodeInteraction =
        compose.onNodeWithText(value, useUnmergedTree = true)

    private fun described(value: String): SemanticsNodeInteraction =
        compose.onNodeWithContentDescription(value, useUnmergedTree = true)

    private fun semanticsDumps(): Pair<String, String> =
        compose.onRoot(useUnmergedTree = false).printToString() to
            compose.onRoot(useUnmergedTree = true).printToString()

    private fun record(
        caseName: String,
        nodes: Map<String, SemanticsNodeInteraction>,
        extraBounds: Map<String, Rect> = emptyMap(),
        injectedFontScale: Float,
        constrainedContainerWidthDp: Int? = null
    ) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val output = File(instrumentation.targetContext.filesDir, OUTPUT_DIRECTORY).apply { mkdirs() }
        val bounds = JSONObject().apply {
            nodes.forEach { (name, node) ->
                put(name, node.fetchSemanticsNode().boundsInRoot.toJson())
            }
            extraBounds.forEach { (name, rect) -> put(name, rect.toJson()) }
        }
        val (merged, unmerged) = semanticsDumps()
        val data = JSONObject()
            .put("case", caseName)
            .put("fixture", true)
            .put("deviceRendering", true)
            .put("density", compose.density.density)
            .put("injectedFontScale", injectedFontScale)
            .put("containerKind", if (constrainedContainerWidthDp == null) "device-root" else "dp-constrained-test-container")
            .put("constrainedContainerWidthDp", constrainedContainerWidthDp ?: JSONObject.NULL)
            .put("boundsPx", bounds)
            .put("mergedSemantics", merged)
            .put("unmergedSemantics", unmerged)
        File(output, "$caseName.json").writeText(data.toString(2))
        File(output, "$caseName.png").outputStream().use {
            check(
                compose.onRoot().captureToImage().asAndroidBitmap()
                    .compress(Bitmap.CompressFormat.PNG, 100, it)
            )
        }
        instrumentation.sendStatus(0, Bundle().apply {
            putString("stream", "T10.118b $caseName ${bounds}\n")
        })
    }

    private fun Rect.toJson(): JSONArray = JSONArray(
        listOf(left.toDouble(), top.toDouble(), right.toDouble(), bottom.toDouble())
    )

    private fun Modifier.testTagCompat(tag: String): Modifier = testTag(tag)

    private enum class DailyCostsMode { Complete, Missing, Partial }

    private companion object {
        const val CONTAINER_TAG = "daily-costs-container"
        const val OUTPUT_DIRECTORY = "t10-118b/daily-page-r1"
    }
}
