package com.jeidorf.tokenledger.mobile

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.geometry.Rect
import android.view.KeyEvent
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.ui.semantics.getOrNull
import java.time.LocalDate
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
        val harness = harness("a04")
        harness.awaitReady()
        harness.selectYearAndAwait()
        val globalQuery = harness.viewModel.uiState.value.query

        compose.onNodeWithText("按日复盘").performScrollTo()
        val cells = compose.onAllNodes(calendarCellMatcher, useUnmergedTree = true)
            .fetchSemanticsNodes()
        assertEquals(196, cells.size)
        assertEquals(
            cells.size,
            cells.map { requireNotNull(it.config.getOrNull(SemanticsProperties.ContentDescription)).single() }
                .toSet().size
        )
        cells.forEach { assertTrue(it.config.contains(SemanticsActions.OnClick)) }
        val minimumCellPx = 48f * compose.density.density
        var representative = LocalDate.parse("2026-01-01")
        while (!representative.isAfter(LocalDate.parse(DateInteractionFixture.CUTOFF_DATE))) {
            val target = dayNode(representative.toString()).performScrollTo().fetchSemanticsNode()
            assertTrue("visible date width must be at least 48dp", target.boundsInRoot.width >= minimumCellPx - 0.5f)
            assertTrue("visible date height must be at least 48dp", target.boundsInRoot.height >= minimumCellPx - 0.5f)
            val visible = compose.onAllNodes(calendarCellMatcher, useUnmergedTree = true)
                .fetchSemanticsNodes()
                .filter { it.boundsInRoot.width >= minimumCellPx - 0.5f && it.boundsInRoot.height >= minimumCellPx - 0.5f }
            visible.forEachIndexed { index, cell ->
                visible.drop(index + 1).forEach { other ->
                    assertFalse("visible calendar click targets must not overlap", overlaps(cell.boundsInRoot, other.boundsInRoot))
                }
            }
            representative = representative.plusWeeks(1)
        }
        assertTrue(compose.onAllNodes(hasContentDescription("2025-12-31", substring = true)).fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodes(hasContentDescription(DateInteractionFixture.FUTURE_DATE, substring = true)).fetchSemanticsNodes().isEmpty())

        // A real ViewModel rejection is returned to the production screen's Boolean navigation gate.
        // The tapped node itself remains a valid calendar cell; the substituted future date is how the
        // fixture deterministically exercises the false branch without copying production eligibility.
        harness.openDayOverride = {
            harness.openDayDetailsObserved(DateInteractionFixture.FUTURE_DATE, "forced-future")
        }
        harness.observedClick(
            dayNode(DateInteractionFixture.RECENT_DATE), DateInteractionFixture.RECENT_DATE,
            "forced-future", scrollFirst = true
        )
        compose.waitForIdle()

        assertEquals(globalQuery, harness.viewModel.uiState.value.query)
        assertEquals(DashboardSection.Trends, harness.viewModel.uiState.value.section)
        assertNull(harness.viewModel.uiState.value.dayReviewReturn)
        compose.onNodeWithText("按日复盘").assertIsDisplayed()

        harness.openDayOverride = null
        harness.observedClick(
            dayNode(DateInteractionFixture.RECENT_DATE), DateInteractionFixture.RECENT_DATE,
            "normal-recent", scrollFirst = false
        )
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.RECENT_DATE)
        compose.onNodeWithText("${DateInteractionFixture.RECENT_DATE} 当天复盘").assertIsDisplayed()
        assertEquals(
            DateInteractionFixture.RECENT_DAY_TOKENS,
            harness.viewModel.uiState.value.visibleData?.summary?.effectiveTokens
        )
    }

    @Test
    fun a05_returnPreservesManuallyScrolledCalendarWeek() {
        val harness = harness()
        harness.awaitReady()
        harness.selectYearAndAwait()
        val globalQuery = harness.viewModel.uiState.value.query

        val openedCell = scrollCalendarToRecentWeeks()
        val cellBefore = openedCell.fetchSemanticsNode().boundsInRoot

        openedCell.performClick()
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.RECENT_DATE)
        compose.onNodeWithText("返回日历").performScrollTo().performClick()
        harness.awaitQuery(RangeKey.Year)
        harness.awaitReady()

        assertEquals(globalQuery, harness.viewModel.uiState.value.query)
        assertEquals(DashboardSection.Trends, harness.viewModel.uiState.value.section)
        assertNull(harness.viewModel.uiState.value.dayReviewReturn)
        val restoredCell = dayNode(DateInteractionFixture.RECENT_DATE).assertIsDisplayed().assertIsFocused()
        assertRectStable(cellBefore, restoredCell.fetchSemanticsNode().boundsInRoot, "restored date cell")
    }

    @Test
    fun a05_paneSwitchPreservesManuallyScrolledCalendarWeek() {
        val harness = harness()
        harness.awaitReady()
        harness.selectYearAndAwait()

        val scrolledCell = scrollCalendarToRecentWeeks()
        val cellBefore = scrolledCell.fetchSemanticsNode().boundsInRoot

        // Leaving Calendar and entering it again must not replay the default-position effect.
        compose.onNode(hasText("趋势") and hasClickAction()).performClick()
        compose.onNode(hasText("日历") and hasClickAction()).performClick()
        val cellAfter = dayNode(DateInteractionFixture.RECENT_DATE).fetchSemanticsNode().boundsInRoot
        assertRectStable(cellBefore, cellAfter, "pane-switch date cell")
    }

    @Test
    fun a05_newGlobalRangeStillAutoPositionsCalendarAtItsHighlightedWeek() {
        val harness = harness()
        harness.awaitReady()
        harness.selectYearAndAwait()
        scrollCalendarToRecentWeeks()

        compose.runOnIdle { harness.viewModel.selectRange(RangeKey.Month) }
        harness.awaitQuery(RangeKey.Month)
        harness.awaitReady()

        // The July range is positioned with its preceding week (6/22) at the left edge, rather
        // than inheriting the manually scrolled Year position.
        val monthAnchor = compose.onNodeWithText("6/22").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("new global range must use its default calendar anchor", monthAnchor.left >= 20f)
    }

    @Test
    fun a06_systemBackIsSingleLevelExitAndRestoresGlobalCellFocus() {
        val harness = harness("a06-system-back")
        harness.awaitReady()
        harness.selectYearAndAwait()
        val globalQuery = harness.viewModel.uiState.value.query

        harness.observedClick(
            dayNode(DateInteractionFixture.RECENT_DATE), DateInteractionFixture.RECENT_DATE,
            "normal-recent", scrollFirst = true
        )
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.RECENT_DATE)
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        harness.awaitQuery(RangeKey.Year)
        harness.awaitReady()

        assertEquals(globalQuery, harness.viewModel.uiState.value.query)
        assertEquals(DashboardSection.Trends, harness.viewModel.uiState.value.section)
        assertNull(harness.viewModel.uiState.value.dayReviewReturn)
        dayNode(DateInteractionFixture.RECENT_DATE).assertIsDisplayed().assertIsFocused()
    }

    @Test
    fun a06_primaryNavigationExitRestoresCalendarPaneQueryScrollAndFocus() {
        val harness = harness()
        harness.awaitReady()
        harness.selectYearAndAwait()
        val globalQuery = harness.viewModel.uiState.value.query
        val openedCell = dayNode(DateInteractionFixture.EARLY_DATE).performScrollTo()
        val cellBefore = openedCell.fetchSemanticsNode().boundsInRoot
        val weekBefore = compose.onNodeWithText("1/12").fetchSemanticsNode().boundsInRoot
        openedCell.performClick()
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.EARLY_DATE)

        compose.onNode(hasText("概览") and hasClickAction()).performClick()
        harness.awaitQuery(RangeKey.Year)
        compose.onNode(hasText("洞察") and hasClickAction()).performClick()
        harness.awaitReady()

        assertEquals(globalQuery, harness.viewModel.uiState.value.query)
        assertEquals(DashboardSection.Trends, harness.viewModel.uiState.value.section)
        assertNull(harness.viewModel.uiState.value.dayReviewReturn)
        val restoredCell = dayNode(DateInteractionFixture.EARLY_DATE).assertIsDisplayed().assertIsFocused()
        assertRectStable(cellBefore, restoredCell.fetchSemanticsNode().boundsInRoot, "navigation date cell")
        assertRectStable(weekBefore, compose.onNodeWithText("1/12").fetchSemanticsNode().boundsInRoot, "navigation week anchor")
    }

    @Test
    fun a07_noCacheReturnKeepsGlobalProvenanceOnDelayAndFailureAndLateDayCannotWin() {
        val harness = harness("a07")
        harness.awaitReady()
        harness.selectYearAndAwait()
        val global = harness.viewModel.uiState.value

        harness.observedClick(
            dayNode(DateInteractionFixture.RECENT_DATE), DateInteractionFixture.RECENT_DATE,
            "normal-recent", scrollFirst = true
        )
        harness.awaitQuery(RangeKey.Custom, DateInteractionFixture.RECENT_DATE)
        harness.cache.clear()
        val delayedReturn = harness.source.holdNext(
            matches = { it.range == RangeKey.Year }
        )
        compose.onNodeWithText("返回日历").performScrollTo().performClick()
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

    private fun dayNode(date: String) = compose.onNode(
        hasContentDescription(date, substring = true)
    )

    private fun scrollCalendarToRecentWeeks() =
        // This performs the calendar's real horizontal ScrollTo semantics action, which is also
        // available to accessibility services. It leaves the latest selectable week in view.
        dayNode(DateInteractionFixture.RECENT_DATE).performScrollTo().assertIsDisplayed()

    private fun harness(diagnosticTestId: String? = null): Harness = DateInteractionFixture.createHarness(
        compose, diagnosticTestId = diagnosticTestId
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
        val calendarCellMatcher = SemanticsMatcher("selectable YYYY-MM-DD calendar cell") { node ->
            val description = node.config.getOrNull(SemanticsProperties.ContentDescription)
                ?.singleOrNull()
                .orEmpty()
            description.matches(Regex("^\\d{4}-\\d{2}-\\d{2}，有效 Token .+，查看当天复盘$"))
        }
    }
}
