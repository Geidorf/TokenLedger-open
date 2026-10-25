package com.jeidorf.tokenledger.mobile

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.geometry.Rect
import android.view.KeyEvent
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.ui.semantics.getOrNull
import java.time.LocalDate
import java.time.YearMonth
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Rule
import org.junit.Test

class LedgerDateInteractionTest {
    @get:Rule
    val compose = createComposeRule()

    private var activeHarness: Harness? = null

    @After
    fun closeHarness() {
        activeHarness?.close()
    }

    @Test
    fun a04_validCellOpensDayButFalseCallbackKeepsCalendarPaneAndGlobalQuery() {
        val harness = harness("a04", fontScale = 1f)
        harness.awaitReady()
        harness.selectYearAndAwait()
        val globalQuery = harness.viewModel.uiState.value.query

        assertYearCoverageAndTargets()

        // 用真实 ViewModel 拒绝未来日期，覆盖有效点击后的 Boolean 导航闸门。
        harness.openDayOverride = {
            harness.openDayDetailsObserved(DateInteractionFixture.FUTURE_DATE, "forced-future")
        }
        openMonth(DateInteractionFixture.RECENT_DATE)
        harness.observedClick(
            dayNode(DateInteractionFixture.RECENT_DATE), DateInteractionFixture.RECENT_DATE,
            "forced-future", scrollFirst = true
        )
        compose.waitForIdle()

        assertEquals(globalQuery, harness.viewModel.uiState.value.query)
        assertEquals(DashboardSection.Trends, harness.viewModel.uiState.value.section)
        assertNull(harness.viewModel.uiState.value.dayReviewReturn)
        monthNode(DateInteractionFixture.RECENT_DATE).assertIsDisplayed()

        harness.openDayOverride = null
        openMonth(DateInteractionFixture.RECENT_DATE)
        harness.observedClick(
            dayNode(DateInteractionFixture.RECENT_DATE), DateInteractionFixture.RECENT_DATE,
            "normal-recent", scrollFirst = true
        )
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.RECENT_DATE)
        compose.onNodeWithText("${DateInteractionFixture.RECENT_DATE} 当天复盘").assertIsDisplayed()
        assertEquals(
            DateInteractionFixture.RECENT_DAY_TOKENS,
            harness.viewModel.uiState.value.visibleData?.summary?.effectiveTokens
        )
    }

    @Test
    fun a04_nativePickerReopensLastChosenDay() {
        val harness = harness(fontScale = 1f)
        harness.awaitReady()
        harness.selectYearAndAwait()
        openMonth(DateInteractionFixture.RECENT_DATE)
        dayNode(DateInteractionFixture.RECENT_DATE).performScrollTo().performClick()
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.RECENT_DATE)
        compose.onNodeWithText("返回原视图").performScrollTo().performClick()
        harness.awaitQuery(RangeKey.Year)
        harness.awaitReady()

        val picker = compose.onNode(hasContentDescription("选择日期查看当天复盘") and hasClickAction())
            .performScrollTo().assertIsDisplayed()
        val bounds = picker.fetchSemanticsNode().boundsInRoot
        val minimum = 48f * compose.density.density
        assertTrue(bounds.width >= minimum - 0.5f && bounds.height >= minimum - 0.5f)
        picker.performClick()
        compose.onNodeWithText("查看当天").assertIsDisplayed().performClick()
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.RECENT_DATE)
        assertEquals(DateInteractionFixture.RECENT_DAY_TOKENS, harness.viewModel.uiState.value.visibleData?.summary?.effectiveTokens)
        compose.onNodeWithText("返回原视图").performScrollTo().performClick()
        harness.awaitQuery(RangeKey.Year)
        harness.awaitReady()
        monthNode(DateInteractionFixture.RECENT_DATE).assertIsFocused()
    }

    @Test
    fun a05_returnPreservesManuallyScrolledCalendarMonth() {
        val harness = harness(fontScale = 2f)
        harness.awaitReady()
        harness.selectYearAndAwait()
        val globalQuery = harness.viewModel.uiState.value.query

        val openedMonth = monthNode(DateInteractionFixture.RECENT_DATE).performScrollTo().assertIsDisplayed()
        val monthBefore = openedMonth.fetchSemanticsNode().boundsInRoot

        openedMonth.performClick()
        dayNode(DateInteractionFixture.RECENT_DATE).performScrollTo().performClick()
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.RECENT_DATE)
        compose.onNodeWithText("返回原视图").performScrollTo().performClick()
        harness.awaitQuery(RangeKey.Year)
        harness.awaitReady()

        assertEquals(globalQuery, harness.viewModel.uiState.value.query)
        assertEquals(DashboardSection.Trends, harness.viewModel.uiState.value.section)
        assertNull(harness.viewModel.uiState.value.dayReviewReturn)
        val restoredMonth = monthNode(DateInteractionFixture.RECENT_DATE).assertIsDisplayed().assertIsFocused()
        assertRectStable(monthBefore, restoredMonth.fetchSemanticsNode().boundsInRoot, "restored month")
    }

    @Test
    fun a05_paneSwitchPreservesManuallyScrolledCalendarMonth() {
        val harness = harness(fontScale = 1f)
        harness.awaitReady()
        harness.selectYearAndAwait()

        val january = monthNode(DateInteractionFixture.EARLY_DATE).assertIsDisplayed()
        val initialTop = january.fetchSemanticsNode().boundsInRoot.top
        // 子页签属于同一滚动列表：保留可见点击区，同时制造非零阅读偏移。
        compose.onNode(hasScrollToIndexAction()).performSemanticsAction(SemanticsActions.ScrollBy) {
            it(0f, 24f * compose.density.density)
        }
        compose.waitForIdle()
        val monthBefore = january.assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("calendar must have been manually scrolled", monthBefore.top < initialTop)

        // 切换子页后保留手动阅读位置，不重新定位到年历顶部。
        compose.onNode(hasText("趋势") and hasClickAction()).performClick()
        compose.onNode(hasText("日历") and hasClickAction()).performClick()
        val monthAfter = monthNode(DateInteractionFixture.EARLY_DATE).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertRectStable(monthBefore, monthAfter, "pane-switch month")
    }

    @Test
    fun a05_newGlobalRangeHighlightsMonthWithoutCroppingTrustedYear() {
        val harness = harness()
        harness.awaitReady()
        harness.selectYearAndAwait()
        monthNode(DateInteractionFixture.RECENT_DATE).performScrollTo()

        compose.runOnIdle { harness.viewModel.selectRange(RangeKey.Month) }
        harness.awaitQuery(RangeKey.Month)
        harness.awaitReady()

        val julyDescription = monthNode(DateInteractionFixture.RECENT_DATE)
            .fetchSemanticsNode().config[SemanticsProperties.ContentDescription].single()
        assertTrue(julyDescription.contains("当前查询 1 日至 15 日"))
        val januaryDescription = monthNode(DateInteractionFixture.EARLY_DATE)
            .fetchSemanticsNode().config[SemanticsProperties.ContentDescription].single()
        assertFalse(januaryDescription.contains("当前查询"))
        openMonth(DateInteractionFixture.EARLY_DATE)
        dayNode(DateInteractionFixture.EARLY_DATE).performScrollTo().performClick()
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.EARLY_DATE)
        assertEquals(RangeKey.Month, harness.viewModel.uiState.value.dayReviewReturn?.query?.range)
    }

    @Test
    fun a06_systemBackIsSingleLevelExitAndRestoresMonthFocus() {
        val harness = harness("a06-system-back")
        harness.awaitReady()
        harness.selectYearAndAwait()
        val globalQuery = harness.viewModel.uiState.value.query

        openMonth(DateInteractionFixture.RECENT_DATE)
        harness.observedClick(
            dayNode(DateInteractionFixture.RECENT_DATE), DateInteractionFixture.RECENT_DATE,
            "normal-recent", scrollFirst = true
        )
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.RECENT_DATE)
        compose.onNodeWithText("${DateInteractionFixture.RECENT_DATE} 当天复盘").assertIsDisplayed()
        pressBack()
        harness.awaitQuery(RangeKey.Year)
        harness.awaitReady()

        assertEquals(globalQuery, harness.viewModel.uiState.value.query)
        assertEquals(DashboardSection.Trends, harness.viewModel.uiState.value.section)
        assertNull(harness.viewModel.uiState.value.dayReviewReturn)
        monthNode(DateInteractionFixture.RECENT_DATE).assertIsDisplayed().assertIsFocused()
    }

    @Test
    fun a06_primaryNavigationExitRestoresCalendarPaneQueryScrollAndFocus() {
        val harness = harness(fontScale = 2f)
        harness.awaitReady()
        harness.selectYearAndAwait()
        val globalQuery = harness.viewModel.uiState.value.query
        val openedMonth = monthNode(DateInteractionFixture.RECENT_DATE).performScrollTo()
        val monthBefore = openedMonth.fetchSemanticsNode().boundsInRoot
        openedMonth.performClick()
        dayNode(DateInteractionFixture.RECENT_DATE).performScrollTo().performClick()
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.RECENT_DATE)

        compose.onNode(hasText("额度") and hasClickAction()).performClick()
        harness.awaitQuery(RangeKey.Year)
        compose.onNode(hasText("用量") and hasClickAction()).performClick()
        harness.awaitReady()

        assertEquals(globalQuery, harness.viewModel.uiState.value.query)
        assertEquals(DashboardSection.Trends, harness.viewModel.uiState.value.section)
        assertNull(harness.viewModel.uiState.value.dayReviewReturn)
        val restoredMonth = monthNode(DateInteractionFixture.RECENT_DATE).assertIsDisplayed().assertIsFocused()
        assertRectStable(monthBefore, restoredMonth.fetchSemanticsNode().boundsInRoot, "navigation month")
    }

    @Test
    fun a06_manualReadingAfterDayReturnDoesNotReplayPreviousMonthFocus() {
        val harness = harness(fontScale = 2f)
        harness.awaitReady()
        harness.selectYearAndAwait()
        openMonth(DateInteractionFixture.RECENT_DATE)
        dayNode(DateInteractionFixture.RECENT_DATE).performScrollTo().performClick()
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.RECENT_DATE)
        compose.onNodeWithText("返回原视图").performScrollTo().performClick()
        harness.awaitQuery(RangeKey.Year)
        harness.awaitReady()

        val january = monthNode(DateInteractionFixture.EARLY_DATE).performScrollTo().assertIsDisplayed()
        val monthBefore = january.fetchSemanticsNode().boundsInRoot
        compose.onNode(hasText("额度") and hasClickAction()).performClick()
        compose.onNode(hasText("用量") and hasClickAction()).performClick()
        val restored = monthNode(DateInteractionFixture.EARLY_DATE).assertIsDisplayed()
        assertRectStable(monthBefore, restored.fetchSemanticsNode().boundsInRoot, "new reading position")
    }

    @Test
    fun a07_noCacheReturnKeepsGlobalProvenanceOnDelayAndFailureAndLateDayCannotWin() {
        val harness = harness("a07")
        harness.awaitReady()
        harness.selectYearAndAwait()
        val global = harness.viewModel.uiState.value

        openMonth(DateInteractionFixture.RECENT_DATE)
        harness.observedClick(
            dayNode(DateInteractionFixture.RECENT_DATE), DateInteractionFixture.RECENT_DATE,
            "normal-recent", scrollFirst = true
        )
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.RECENT_DATE)
        harness.cache.clear()
        val delayedReturn = harness.source.holdNext(
            matches = { it.range == RangeKey.Year }
        )
        compose.onNodeWithText("返回原视图").performScrollTo().performClick()
        compose.waitUntil(5_000) { delayedReturn.request != null }

        val whileWaiting = harness.viewModel.uiState.value
        assertEquals(global.query, whileWaiting.query)
        assertSame(global.visibleData, whileWaiting.visibleData)
        assertEquals(global.lastUpdatedEpochMillis, whileWaiting.lastUpdatedEpochMillis)
        assertEquals(global.showingCachedData, whileWaiting.showingCachedData)
        assertEquals(DashboardLoadingMode.Refreshing, whileWaiting.loadingMode)

        delayedReturn.fail()
        compose.waitUntil(5_000) { harness.viewModel.uiState.value.error != null }
        val afterFailure = harness.viewModel.uiState.value
        assertSame(global.visibleData, afterFailure.visibleData)
        assertEquals(global.lastUpdatedEpochMillis, afterFailure.lastUpdatedEpochMillis)
        assertEquals(global.showingCachedData, afterFailure.showingCachedData)
        assertTrue(afterFailure.error?.message?.isNotBlank() == true)

        val oldDay = harness.source.holdNext(
            matches = { it.start == DateInteractionFixture.EARLY_DATE },
            ignoreCancellation = true
        )
        openMonth(DateInteractionFixture.EARLY_DATE)
        dayNode(DateInteractionFixture.EARLY_DATE).performScrollTo().performClick()
        compose.waitUntil(5_000) { oldDay.request != null }
        compose.runOnIdle {
            assertTrue(harness.openDayDetailsObserved(DateInteractionFixture.RECENT_DATE, "direct-vm"))
        }
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.RECENT_DATE)
        compose.waitUntil(5_000) {
            harness.viewModel.uiState.value.visibleData?.summary?.effectiveTokens ==
                DateInteractionFixture.RECENT_DAY_TOKENS
        }
        oldDay.succeed(DateInteractionFixture.EARLY_DAY_TOKENS)
        compose.waitForIdle()

        val latest = harness.viewModel.uiState.value
        assertEquals(DateInteractionFixture.RECENT_DATE, latest.query.start)
        assertEquals(DateInteractionFixture.RECENT_DAY_TOKENS, latest.visibleData?.summary?.effectiveTokens)
        assertFalse(latest.showingCachedData)
        assertNull(latest.error)
    }

    private fun dayNode(date: String) = LocalDate.parse(date).let {
        compose.onNode(descriptionStartsWith("${it.monthValue}月${it.dayOfMonth}日，"))
    }

    private fun monthNode(date: String) = compose.onNode(
        descriptionStartsWith("${LocalDate.parse(date).monthValue}月：") and hasClickAction()
    )

    private fun descriptionStartsWith(prefix: String) = SemanticsMatcher("description starts with $prefix") { node ->
        node.config.getOrNull(SemanticsProperties.ContentDescription)?.singleOrNull()?.startsWith(prefix) == true
    }

    private fun openMonth(date: String) {
        monthNode(date).performScrollTo().performClick()
        compose.onNodeWithText(YearMonth.from(LocalDate.parse(date)).toString()).assertIsDisplayed()
    }

    private fun pressBack() {
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
    }

    private fun assertYearCoverageAndTargets() {
        val cutoff = LocalDate.parse(DateInteractionFixture.CUTOFF_DATE)
        val selectableDates = mutableSetOf<String>()
        val minimumCellPx = 48f * compose.density.density
        for (month in 1..cutoff.monthValue) {
            val yearMonth = YearMonth.of(cutoff.year, month)
            openMonth(yearMonth.atDay(1).toString())
            val cells = compose.onAllNodes(calendarCellMatcher, useUnmergedTree = true).fetchSemanticsNodes()
            assertEquals(yearMonth.lengthOfMonth(), cells.size)
            for (day in 1..yearMonth.lengthOfMonth()) {
                val date = yearMonth.atDay(day)
                val node = dayNode(date.toString()).fetchSemanticsNode()
                if (date <= cutoff) {
                    assertTrue("$date must be selectable", node.config.contains(SemanticsActions.OnClick))
                    assertTrue("date must appear once", selectableDates.add(date.toString()))
                } else {
                    dayNode(date.toString()).assertIsNotEnabled()
                    assertFalse("$date must not have a click action", node.config.contains(SemanticsActions.OnClick))
                }
            }
            // 每周取一个可见日格核对几何；390dp 常规字号下不接受缩小或重叠触点。
            for (day in 1..yearMonth.lengthOfMonth() step 7) {
                val date = yearMonth.atDay(day)
                if (date > cutoff) break
                val target = dayNode(date.toString()).performScrollTo().fetchSemanticsNode()
                assertTrue("visible date width must be at least 48dp", target.boundsInRoot.width >= minimumCellPx - 0.5f)
                assertTrue("visible date height must be at least 48dp", target.boundsInRoot.height >= minimumCellPx - 0.5f)
                val visible = compose.onAllNodes(calendarCellMatcher and hasClickAction(), useUnmergedTree = true)
                    .fetchSemanticsNodes()
                    .filter { it.boundsInRoot.width >= minimumCellPx - 0.5f && it.boundsInRoot.height >= minimumCellPx - 0.5f }
                visible.forEachIndexed { index, cell ->
                    visible.drop(index + 1).forEach { other ->
                        assertFalse("visible calendar click targets must not overlap", overlaps(cell.boundsInRoot, other.boundsInRoot))
                    }
                }
            }
            pressBack()
        }
        assertEquals(196, selectableDates.size)
        assertTrue("coverage starts at the year boundary", selectableDates.contains("2026-01-01"))
        assertTrue("coverage includes the cutoff", selectableDates.contains(DateInteractionFixture.CUTOFF_DATE))
        assertFalse(selectableDates.contains(DateInteractionFixture.FUTURE_DATE))
    }

    private fun harness(diagnosticTestId: String? = null, fontScale: Float? = null): Harness = DateInteractionFixture.createHarness(
        compose, diagnosticTestId = diagnosticTestId, fontScale = fontScale
    ).also {
        activeHarness = it
    }

    private fun overlaps(first: Rect, second: Rect): Boolean =
        first.left < second.right && second.left < first.right &&
            first.top < second.bottom && second.top < first.bottom

    private fun assertRectStable(expected: Rect, actual: Rect, label: String) {
        listOf(
            expected.left to actual.left,
            expected.top to actual.top,
            expected.right to actual.right,
            expected.bottom to actual.bottom
        ).forEachIndexed { axis, (before, after) ->
            assertEquals("$label axis $axis", before, after, 0.5f)
        }
    }

    private companion object {
        val calendarCellMatcher = SemanticsMatcher("month-panel date cell") { node ->
            val description = node.config.getOrNull(SemanticsProperties.ContentDescription)
                ?.singleOrNull()
                .orEmpty()
            description.matches(Regex("^\\d{1,2}月\\d{1,2}日，.+$"))
        }
    }
}
