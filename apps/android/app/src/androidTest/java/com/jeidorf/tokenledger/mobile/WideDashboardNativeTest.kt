package com.jeidorf.tokenledger.mobile

import android.content.res.Configuration
import android.graphics.Bitmap
import android.view.KeyEvent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.jeidorf.tokenledger.mobile.rhythm.ActivityRhythm
import com.jeidorf.tokenledger.mobile.rhythm.RhythmDayHour
import com.jeidorf.tokenledger.mobile.rhythm.RhythmModelHour
import com.jeidorf.tokenledger.mobile.rhythm.RhythmSummary
import com.jeidorf.tokenledger.mobile.rhythm.RhythmTool
import com.jeidorf.tokenledger.mobile.ui.navigation.InsightPane
import com.jeidorf.tokenledger.mobile.ui.navigation.MobileDestination
import com.jeidorf.tokenledger.mobile.ui.rhythm.LocalRhythmFeedOverride
import com.jeidorf.tokenledger.mobile.ui.rhythm.RhythmFeed
import java.io.File
import java.time.LocalDate
import kotlin.math.roundToInt
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** 使用生产页面和匿名夹具验证布局、滚动与回调；截图仅保存在测试应用私有目录。 */
class WideDashboardNativeTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var window: TestWindow
    private val trendHeading = hasText("趋势") and
        SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)
    private val verticalList = SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange)

    @Test
    fun mediumSettingsStackCards() {
        mount(800.dp, 800.dp) { screen(ledgerSnapshotFixture(), settings = true) }
        val orientation = textBounds("强制横屏")
        val appearance = textBounds("显示模式")
        assertTrue("800dp 的设置卡片必须纵排", appearance.top > orientation.bottom)
        assertCenteredSingleColumn()
        save("settings-800-single")
    }

    @Test
    fun phoneLandscapeSettingsKeepTwoColumnsAndReachableSignOut() {
        var signOutCalls = 0
        mount(844.dp, 390.dp) { screen(ledgerSnapshotFixture(), settings = true, onSignOut = { signOutCalls++ }) }
        val orientation = textBounds("强制横屏")
        val appearance = textBounds("显示模式")
        assertTrue("两张卡片位于同一行", orientation.top < appearance.bottom && appearance.top < orientation.bottom)
        assertTrue("外观卡在方向卡右侧", appearance.left > orientation.right)
        save("settings-844-landscape")
        compose.onNodeWithTag("wide-settings-content").performScrollToNode(hasText("退出登录"))
        compose.onNodeWithText("退出登录").assertIsDisplayed().performClick()
        assertEquals(1, signOutCalls)
        save("settings-844-signout")
    }

    @Test
    fun largeFontSettingsUseCenteredSingleColumn() {
        mount(1280.dp, 800.dp, 1.5f) { screen(ledgerSnapshotFixture(), settings = true) }
        assertTrue("大字号卡片纵排", textBounds("显示模式").top > textBounds("强制横屏").bottom)
        assertCenteredSingleColumn()
        save("settings-1280-font150")
    }

    @Test
    fun expandedSessionsKeepTrendCompanionAfterSettingsReturn() {
        val state = ledgerSnapshotFixture(section = DashboardSection.Trends)
        mount(1280.dp, 800.dp) { screen(state, pane = InsightPane.Sessions) }
        val rhythm = textBounds("活动节律")
        val trend = compose.onNode(trendHeading, useUnmergedTree = true).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("趋势伴随栏在会话右侧", trend.left > rhythm.right)
        save("sessions-1280-companion")
        val primary = compose.onAllNodes(verticalList)[0]
        primary.performScrollToIndex(2)
        val before = scrollPosition(primary)
        assertTrue("会话主栏必须已经滚动", before > 0f)
        compose.onNodeWithContentDescription("打开设置").performClick()
        compose.onNodeWithText("移动看板偏好").assertIsDisplayed()
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
        val restored = compose.onAllNodes(verticalList)[0]
        assertEquals("设置返回后仍保留会话阅读位置", before, scrollPosition(restored), 0.001f)
        restored.performScrollToIndex(0)
        compose.onNodeWithText("活动节律").assertIsDisplayed()
        compose.onNode(trendHeading, useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun compactSessionsDoNotRenderCompanionHeading() {
        mount(390.dp, 844.dp) { screen(ledgerSnapshotFixture(section = DashboardSection.Trends), pane = InsightPane.Sessions) }
        compose.onNodeWithText("活动节律").assertIsDisplayed()
        compose.onNode(trendHeading, useUnmergedTree = true).assertDoesNotExist()
        save("sessions-390-single")
    }

    @Test
    fun largeFontSessionsKeepSingleContentFrame() {
        mount(1280.dp, 800.dp, 2f) { screen(ledgerSnapshotFixture(section = DashboardSection.Trends), pane = InsightPane.Sessions) }
        compose.onNode(trendHeading, useUnmergedTree = true).assertDoesNotExist()
        assertCenteredSingleColumn()
        save("sessions-1280-font200")
    }

    @Test
    fun expandedEntityKeepsSummaryAndHistoryInSeparatePanes() {
        mount(1280.dp, 800.dp) { screen(ledgerEntitySnapshotFixture(), appearance = LedgerAppearance.Dark) }
        val primary = compose.onNodeWithTag("wide-entity-primary").fetchSemanticsNode().boundsInRoot
        val secondary = compose.onNodeWithTag("wide-entity-secondary").fetchSemanticsNode().boundsInRoot
        assertTrue("主副栏具有可见宽度", primary.width > 0f && secondary.width > 0f)
        assertTrue("两栏不得重叠", primary.right <= secondary.left + 1f)
        compose.onNodeWithText("活跃日历").assertIsDisplayed()
        save("entity-1280-dark-two-pane")
        compose.onNodeWithTag("wide-entity-secondary").performScrollToIndex(2)
        compose.onNodeWithText("最近明细").assertIsDisplayed()
    }

    @Test
    fun compactEntityRetainsCalendarAndHistory() {
        mount(390.dp, 844.dp) { screen(ledgerEntitySnapshotFixture()) }
        compose.onNodeWithTag("wide-entity-secondary").assertDoesNotExist()
        compose.onNode(verticalList).performScrollToIndex(5)
        compose.onNodeWithText("活跃日历").assertIsDisplayed()
        compose.onNode(verticalList).performScrollToIndex(7)
        compose.onNodeWithText("最近明细").assertIsDisplayed()
        save("entity-390-history")
    }

    @Test
    fun secondaryPaginationDoesNotMovePrimaryReadingPosition() {
        var loadMoreCalls = 0
        val state = paginationFixture()
        mount(1280.dp, 800.dp) { screen(state, onLoadMore = { loadMoreCalls++ }) }
        val primary = compose.onNodeWithTag("wide-entity-primary")
        primary.performScrollToIndex(2)
        val before = scrollPosition(primary)
        assertTrue("主栏必须已经滚动", before > 0f)
        val count = requireNotNull(state.data?.entityDashboard).historyPage.items.size
        compose.onNodeWithTag("wide-entity-secondary").performScrollToIndex(count + 3)
        compose.onNodeWithText("加载更多").assertIsDisplayed().performClick()
        compose.waitForIdle()
        assertEquals(1, loadMoreCalls)
        assertEquals("右栏分页不得改变主栏滚动位置", before, scrollPosition(primary), 0.001f)
        save("entity-independent-pagination")
    }

    @Test
    fun entityModeSwitchPreservesPrimaryScroll() {
        mount(1280.dp, 800.dp) { screen(ledgerEntitySnapshotFixture()) }
        val primary = compose.onNodeWithTag("wide-entity-primary")
        primary.performScrollToIndex(2)
        val before = scrollPosition(primary)
        compose.runOnIdle { window.width = 800.dp }
        compose.onNodeWithTag("wide-entity-secondary").assertDoesNotExist()
        assertCenteredSingleColumn()
        compose.runOnIdle { window.width = 1280.dp }
        compose.onNodeWithTag("wide-entity-secondary").assertIsDisplayed()
        assertEquals("恢复双栏后仍保留主栏阅读位置", before, scrollPosition(primary), 0.001f)
    }

    @Test
    fun entityModelReturnPreservesBothReadingPositions() {
        val parent = paginationFixture()
        val stats = requireNotNull(parent.data)
        val entity = requireNotNull(stats.entityDashboard)
        val model = entity.composition.models.first().value
        var visibleState by mutableStateOf(parent)
        mount(1280.dp, 800.dp) {
            screen(
                visibleState,
                onOpenModel = { value ->
                    visibleState = parent.copy(
                        query = parent.query.copy(compatibilityModelSelector = value),
                        entity = DashboardEntity(DashboardEntity.MODEL, value),
                        data = stats.copy(entityDashboard = entity.copy(
                            entity = EntityDescriptor(kind = DashboardEntity.MODEL, tool = null, model = value)
                        ))
                    )
                },
                onBack = { visibleState = parent }
            )
        }
        val primary = compose.onNodeWithTag("wide-entity-primary")
        val secondary = compose.onNodeWithTag("wide-entity-secondary")
        primary.performScrollToIndex(4)
        secondary.performScrollToIndex(6)
        val primaryBefore = scrollPosition(primary)
        val secondaryBefore = scrollPosition(secondary)
        assertTrue("两栏必须都已经滚动", primaryBefore > 0f && secondaryBefore > 0f)
        compose.onNode(hasText(model) and hasClickAction()).performClick()
        compose.waitForIdle()
        assertEquals(model, visibleState.entity?.id)
        assertEquals("新模型看板应从头开始阅读", 0f, scrollPosition(primary), 0.001f)
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
        assertEquals(parent.query, visibleState.query)
        assertEquals("模型返回后保留主栏阅读位置", primaryBefore, scrollPosition(primary), 0.001f)
        assertEquals("模型返回后保留副栏阅读位置", secondaryBefore, scrollPosition(secondary), 0.001f)
    }

    @Test
    fun entityModelAndBackActionsKeepTheirBindings() {
        val state = ledgerEntitySnapshotFixture()
        val query = state.query
        val model = requireNotNull(state.data?.entityDashboard).composition.models.first().value
        var openedModel: String? = null
        var backs = 0
        mount(1280.dp, 800.dp) {
            screen(state, onOpenModel = { openedModel = it }, onBack = { backs++ })
        }
        compose.onNodeWithTag("wide-entity-primary").performScrollToIndex(4)
        compose.onNode(hasText(model) and hasClickAction()).performClick()
        assertEquals(model, openedModel)
        compose.onNodeWithContentDescription("返回上一级").performClick()
        assertEquals(1, backs)
        assertEquals(query, state.query)
    }

    private class TestWindow(width: Dp, val height: Dp, val fontScale: Float) {
        var width by mutableStateOf(width)
    }

    private fun mount(width: Dp, height: Dp, fontScale: Float = 1f, content: @Composable () -> Unit) {
        window = TestWindow(width, height, fontScale)
        compose.setContent {
            val system = LocalDensity.current
            val configuration = Configuration(LocalConfiguration.current).apply {
                screenWidthDp = window.width.value.roundToInt()
                screenHeightDp = window.height.value.roundToInt()
                smallestScreenWidthDp = minOf(screenWidthDp, screenHeightDp)
                this.fontScale = window.fontScale
                orientation = if (screenWidthDp > screenHeightDp) {
                    Configuration.ORIENTATION_LANDSCAPE
                } else {
                    Configuration.ORIENTATION_PORTRAIT
                }
            }
            CompositionLocalProvider(
                LocalConfiguration provides configuration,
                LocalDensity provides Density(system.density, window.fontScale),
                LocalInspectionMode provides true,
                LocalLedgerNow provides { LEDGER_PREVIEW_NOW }
            ) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopStart) {
                    Box(Modifier.requiredSize(window.width, window.height).testTag("wide-test-window")) { content() }
                }
            }
        }
        compose.waitForIdle()
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val viewport = compose.onNodeWithTag("wide-test-window").fetchSemanticsNode().boundsInRoot
        assertTrue("测试窗口必须在真实视口内", viewport.left >= root.left && viewport.top >= root.top && viewport.right <= root.right + 1f && viewport.bottom <= root.bottom + 1f)
    }

    @Composable
    private fun screen(
        state: DashboardUiState,
        settings: Boolean = false,
        pane: InsightPane = InsightPane.Overview,
        appearance: LedgerAppearance = LedgerAppearance.Light,
        onLoadMore: () -> Unit = {},
        onOpenModel: (String) -> Unit = {},
        onSignOut: () -> Unit = {},
        onBack: () -> Unit = {}
    ) {
        TokenLedgerTheme(appearance) {
            ProvideLedgerPalette(appearance) {
                CompositionLocalProvider(LocalRhythmFeedOverride provides RhythmFeed(signedIn = true, rhythm = rhythmFixture())) {
                    LedgerDashboardV2Screen(
                        state = state,
                        appearance = appearance,
                        forceLandscape = false,
                        tokenDisplayMode = TokenDisplayMode.Effective,
                        ambientMode = AmbientMode.Glance,
                        onForceLandscapeChange = {},
                        onTokenDisplayModeChange = {},
                        onAmbientModeChange = {},
                        onRangeChange = {},
                        onMachineChange = {},
                        onToolChange = {},
                        onModelChange = {},
                        onSearchChange = {},
                        onClearFilters = {},
                        onSectionChange = {},
                        onContributionModeChange = {},
                        onOpenTool = {},
                        onOpenModel = onOpenModel,
                        onBack = onBack,
                        onLoadMore = onLoadMore,
                        onAppearanceChange = {},
                        onOpenLowPowerDisplay = {},
                        onRefresh = {},
                        onSignOut = onSignOut,
                        initialDestination = MobileDestination.Usage,
                        initialInsightPane = pane,
                        initialSettingsVisible = settings
                    )
                }
            }
        }
    }

    private fun paginationFixture(): DashboardUiState {
        val base = ledgerEntitySnapshotFixture()
        val data = requireNotNull(base.data)
        val entity = requireNotNull(data.entityDashboard)
        val seed = entity.historyPage.items.first()
        val page = entity.historyPage.copy(
            items = List(24) { index -> seed.copy(id = 1_000L + index) },
            nextCursor = "fixture-next",
            hasMore = true,
            totalCount = 25
        )
        return base.copy(data = data.copy(history = page.items, detailsPage = page, entityDashboard = entity.copy(historyPage = page)))
    }

    private fun rhythmFixture(): ActivityRhythm {
        val date = LocalDate.of(2026, 7, 15)
        return ActivityRhythm(
            start = date, end = date, timezone = "Asia/Shanghai", rangeTruncated = false,
            summary = RhythmSummary(130_000, 12, 20_000, 1, 1, 1),
            tools = listOf(RhythmTool("fixture-tool", 130_000, 12)),
            dayHours = listOf(RhythmDayHour(date, 9, 40_000, 4), RhythmDayHour(date, 10, 90_000, 8)),
            modelHours = listOf(RhythmModelHour(9, "fixture-model", 40_000, 4), RhythmModelHour(10, "fixture-model", 90_000, 8))
        )
    }

    private fun textBounds(text: String): Rect =
        compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot

    private fun scrollPosition(node: SemanticsNodeInteraction): Float =
        node.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()

    private fun assertCenteredSingleColumn() {
        val lists = compose.onAllNodes(verticalList).fetchSemanticsNodes()
        assertEquals("只有一个纵向内容列表", 1, lists.size)
        val content = lists.single().boundsInRoot
        val viewport = compose.onNodeWithTag("wide-test-window").fetchSemanticsNode().boundsInRoot
        assertTrue("单栏内容必须限宽", content.width <= 720f * compose.density.density + 1f)
        assertEquals("单栏内容必须居中", viewport.center.x, content.center.x, 1f)
    }

    private fun save(name: String) {
        compose.waitForIdle()
        val node = compose.onNodeWithTag("wide-test-window")
        val bounds = node.fetchSemanticsNode().boundsInRoot
        val directory = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "evidence/wide-pages").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use {
            node.captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        File(directory, "$name.json").writeText(JSONObject()
            .put("fixture", true).put("widthPx", bounds.width).put("heightPx", bounds.height)
            .put("fontScale", window.fontScale).toString(2))
    }
}
