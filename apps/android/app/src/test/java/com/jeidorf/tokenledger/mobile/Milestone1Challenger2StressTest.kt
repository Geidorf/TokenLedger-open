package com.jeidorf.tokenledger.mobile

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.SaverScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Constructor
import java.lang.reflect.Method
import java.util.Random

class Milestone1Challenger2StressTest {

    // =========================================================================
    // Challenge 1: V2RetainedDataHolder & Cross-Entity Retention Isolation
    // =========================================================================

    private fun getHolderClass(): Class<*> {
        return Class.forName("com.jeidorf.tokenledger.mobile.V2RetainedDataHolder")
    }

    private fun createHolderInstance(): Any {
        val clazz = getHolderClass()
        val constructor: Constructor<*> = clazz.getDeclaredConstructor()
        constructor.isAccessible = true
        return constructor.newInstance()
    }

    private fun getHolderValue(holder: Any): StatsData? {
        val method: Method = getHolderClass().getDeclaredMethod("getValue")
        method.isAccessible = true
        return method.invoke(holder) as? StatsData
    }

    private fun setHolderValue(holder: Any, value: StatsData?) {
        val method: Method = getHolderClass().getDeclaredMethod("setValue", StatsData::class.java)
        method.isAccessible = true
        method.invoke(holder, value)
    }

    private fun createDummyStats(entityKind: String?, entityId: String?): StatsData {
        val base = requireNotNull(ledgerSnapshotFixture().visibleData)
        val entityDesc = if (entityKind != null && entityId != null) {
            DashboardEntity(kind = entityKind, id = entityId)
        } else null

        val meta = checkNotNull(base.meta)

        return base.copy(
            meta = meta.copy(
                entity = entityDesc,
                machine = entityId ?: "all"
            ),
            summary = Summary(
                inputTokens = (entityId?.hashCode()?.toLong() ?: 1000L).coerceAtLeast(100L),
                outputTokens = 500L
            )
        )
    }

    @Test
    fun testV2RetainedDataHolderDirectReflection() {
        val holder = createHolderInstance()
        assertNull("Initial holder value must be null", getHolderValue(holder))

        val dummyData = createDummyStats("tool", "codex")
        setHolderValue(holder, dummyData)
        assertEquals("Holder must store assigned StatsData", dummyData, getHolderValue(holder))

        setHolderValue(holder, null)
        assertNull("Holder value can be reset to null", getHolderValue(holder))
    }

    @Test
    fun testDataRetentionKeyGeneration() {
        fun computeRetentionKey(entity: DashboardEntity?): String {
            return entity?.let { "${it.kind}:${it.id}" } ?: "dashboard-root"
        }

        assertEquals("dashboard-root", computeRetentionKey(null))
        assertEquals("tool:codex", computeRetentionKey(DashboardEntity("tool", "codex")))
        assertEquals("tool:claude", computeRetentionKey(DashboardEntity("tool", "claude")))
        assertEquals("model:gpt-5", computeRetentionKey(DashboardEntity("model", "gpt-5")))
        assertEquals("model:claude-opus-4", computeRetentionKey(DashboardEntity("model", "claude-opus-4")))

        assertNotEquals(
            computeRetentionKey(DashboardEntity("tool", "codex")),
            computeRetentionKey(DashboardEntity("tool", "claude"))
        )
        assertNotEquals(
            computeRetentionKey(DashboardEntity("tool", "gpt-5")),
            computeRetentionKey(DashboardEntity("model", "gpt-5"))
        )
    }

    /**
     * Simulates the exact state transitions of Compose slot-table memory when switching entities:
     * val dataRetentionKey = state.entity?.let { "${it.kind}:${it.id}" } ?: "dashboard-root"
     * val retainedHolder = remember(dataRetentionKey) { V2RetainedDataHolder() }
     * if (state.visibleData != null) retainedHolder.value = state.visibleData
     * else if (!state.dashboardLoading) retainedHolder.value = null
     */
    private class SimulatedComposeRetentionSlot {
        var currentKey: String? = null
        var currentHolder: Any? = null

        fun renderFrame(
            entity: DashboardEntity?,
            visibleData: StatsData?,
            dashboardLoading: Boolean
        ): StatsData? {
            val key = entity?.let { "${it.kind}:${it.id}" } ?: "dashboard-root"
            if (currentKey != key || currentHolder == null) {
                currentKey = key
                val clazz = Class.forName("com.jeidorf.tokenledger.mobile.V2RetainedDataHolder")
                val ctor = clazz.getDeclaredConstructor().apply { isAccessible = true }
                currentHolder = ctor.newInstance()
            }

            val holder = currentHolder!!
            val getMethod = holder.javaClass.getDeclaredMethod("getValue").apply { isAccessible = true }
            val setMethod = holder.javaClass.getDeclaredMethod("setValue", StatsData::class.java).apply { isAccessible = true }

            if (visibleData != null) {
                setMethod.invoke(holder, visibleData)
            } else if (!dashboardLoading) {
                setMethod.invoke(holder, null)
            }

            val retained = getMethod.invoke(holder) as? StatsData
            return dashboardDataForFrame(
                visibleData = visibleData,
                retainedData = retained,
                dashboardLoading = dashboardLoading
            )
        }
    }

    @Test
    fun testRapidEntitySwitchingPreventsDataLeakage() {
        val slot = SimulatedComposeRetentionSlot()

        // 1. Root dashboard loaded
        val rootData = createDummyStats(null, null)
        val frame1 = slot.renderFrame(entity = null, visibleData = rootData, dashboardLoading = false)
        assertEquals(rootData, frame1)

        // 2. Root starts refreshing
        val frame2 = slot.renderFrame(entity = null, visibleData = null, dashboardLoading = true)
        assertEquals("Root frame should be retained while root is loading", rootData, frame2)

        // 3. User immediately clicks into Tool "codex"
        // At this instant, codex has started loading (visibleData = null, loading = true)
        val frame3 = slot.renderFrame(
            entity = DashboardEntity("tool", "codex"),
            visibleData = null,
            dashboardLoading = true
        )
        assertNull("Tool codex must NOT display rootData while loading!", frame3)

        // 4. Tool "codex" completes loading
        val codexData = createDummyStats("tool", "codex")
        val frame4 = slot.renderFrame(
            entity = DashboardEntity("tool", "codex"),
            visibleData = codexData,
            dashboardLoading = false
        )
        assertEquals(codexData, frame4)

        // 5. User immediately switches to Tool "claude" while codex was showing
        val frame5 = slot.renderFrame(
            entity = DashboardEntity("tool", "claude"),
            visibleData = null,
            dashboardLoading = true
        )
        assertNull("Tool claude must NOT display codexData while loading!", frame5)

        // 6. User rapidly switches to Model "gpt-5" before claude even finished loading
        val frame6 = slot.renderFrame(
            entity = DashboardEntity("model", "gpt-5"),
            visibleData = null,
            dashboardLoading = true
        )
        assertNull("Model gpt-5 must NOT display codexData or claudeData!", frame6)

        // 7. Model "gpt-5" completes loading
        val gpt5Data = createDummyStats("model", "gpt-5")
        val frame7 = slot.renderFrame(
            entity = DashboardEntity("model", "gpt-5"),
            visibleData = gpt5Data,
            dashboardLoading = false
        )
        assertEquals(gpt5Data, frame7)

        // 8. User logs out / resets session
        val frame8 = slot.renderFrame(
            entity = null,
            visibleData = null,
            dashboardLoading = false
        )
        assertNull("On logout/reset, displayedData must be null!", frame8)

        // 9. Root reload starts
        val frame9 = slot.renderFrame(
            entity = null,
            visibleData = null,
            dashboardLoading = true
        )
        assertNull("After logout, loading root must not retain stale gpt-5 data!", frame9)
    }

    @Test
    fun testRandomizedEntitySwitchStressHarness() {
        val slot = SimulatedComposeRetentionSlot()
        val random = Random(42)
        val entities = listOf(
            null,
            DashboardEntity("tool", "codex"),
            DashboardEntity("tool", "claude"),
            DashboardEntity("tool", "minimax"),
            DashboardEntity("model", "gpt-5"),
            DashboardEntity("model", "claude-opus-4"),
            DashboardEntity("model", "qwen3-coder")
        )

        var currentEntity: DashboardEntity? = null

        for (i in 0 until 5000) {
            val shouldSwitchEntity = random.nextInt(100) < 30
            if (shouldSwitchEntity) {
                currentEntity = entities[random.nextInt(entities.size)]
            }

            val isLoading = random.nextBoolean()
            val hasVisibleData = random.nextBoolean()

            val visibleData = if (hasVisibleData) {
                createDummyStats(currentEntity?.kind, currentEntity?.id)
            } else null

            val result = slot.renderFrame(
                entity = currentEntity,
                visibleData = visibleData,
                dashboardLoading = isLoading
            )

            if (result != null) {
                // Invariant: Result must correspond strictly to currentEntity
                val expectedEntityId = currentEntity?.id
                val resultEntityId = result.meta?.entity?.id
                assertEquals(
                    "Iteration $i: Data leak detected! Displayed data id '$resultEntityId' does not match current entity '$expectedEntityId'",
                    expectedEntityId,
                    resultEntityId
                )
            } else {
                // When result is null, it must be because visibleData is null AND
                // either loading is false OR retainedData is null
                assertNull(visibleData)
            }
        }
    }

    // =========================================================================
    // Challenge 2: LazyListState Multi-Tab Isolation & Rapid Switching Stress
    // =========================================================================

    @Test
    fun testIndependentLazyListStateTabIsolation() {
        val overviewState = LazyListState(firstVisibleItemIndex = 12, firstVisibleItemScrollOffset = 150)
        val quotaState = LazyListState(firstVisibleItemIndex = 3, firstVisibleItemScrollOffset = 45)
        val widgetState = LazyListState(firstVisibleItemIndex = 0, firstVisibleItemScrollOffset = 0)
        val routingState = LazyListState(firstVisibleItemIndex = 0, firstVisibleItemScrollOffset = 0)
        val trendState = LazyListState(firstVisibleItemIndex = 8, firstVisibleItemScrollOffset = 210)
        val sourcesState = LazyListState(firstVisibleItemIndex = 1, firstVisibleItemScrollOffset = 20)
        val calendarState = LazyListState(firstVisibleItemIndex = 25, firstVisibleItemScrollOffset = 300)
        val detailsState = LazyListState(firstVisibleItemIndex = 50, firstVisibleItemScrollOffset = 500)
        val sessionsState = LazyListState(firstVisibleItemIndex = 0, firstVisibleItemScrollOffset = 0)

        fun resolveState(destination: MobileDestination, pane: InsightPane): LazyListState {
            return when (destination) {
                MobileDestination.Usage -> when (pane) {
                    InsightPane.Overview -> overviewState
                    InsightPane.Trend -> trendState
                    InsightPane.Sources -> sourcesState
                    InsightPane.Calendar -> calendarState
                    InsightPane.Details -> detailsState
                    InsightPane.Sessions -> sessionsState
                }
                MobileDestination.Routing -> routingState
                MobileDestination.Quota -> quotaState
                MobileDestination.Me -> widgetState
            }
        }

        // Test exact initial values
        assertEquals(12, resolveState(MobileDestination.Usage, InsightPane.Overview).firstVisibleItemIndex)
        assertEquals(150, resolveState(MobileDestination.Usage, InsightPane.Overview).firstVisibleItemScrollOffset)

        assertEquals(3, resolveState(MobileDestination.Quota, InsightPane.Trend).firstVisibleItemIndex)
        assertEquals(45, resolveState(MobileDestination.Quota, InsightPane.Trend).firstVisibleItemScrollOffset)

        assertEquals(8, resolveState(MobileDestination.Usage, InsightPane.Trend).firstVisibleItemIndex)
        assertEquals(210, resolveState(MobileDestination.Usage, InsightPane.Trend).firstVisibleItemScrollOffset)

        assertEquals(1, resolveState(MobileDestination.Usage, InsightPane.Sources).firstVisibleItemIndex)
        assertEquals(25, resolveState(MobileDestination.Usage, InsightPane.Calendar).firstVisibleItemIndex)
        assertEquals(50, resolveState(MobileDestination.Usage, InsightPane.Details).firstVisibleItemIndex)

        // Rapid switching loop: Overview -> Quota -> Insights -> Overview 1,000 times
        val destinations = listOf(
            MobileDestination.Usage to InsightPane.Overview,
            MobileDestination.Quota to InsightPane.Trend,
            MobileDestination.Usage to InsightPane.Trend,
            MobileDestination.Usage to InsightPane.Sources,
            MobileDestination.Usage to InsightPane.Calendar,
            MobileDestination.Usage to InsightPane.Details,
            MobileDestination.Me to InsightPane.Trend,
            MobileDestination.Usage to InsightPane.Overview
        )

        for (i in 0 until 1000) {
            for ((dest, pane) in destinations) {
                val state = resolveState(dest, pane)
                assertNotNull("Resolved state must not be null", state)
                assertTrue("Index must be non-negative", state.firstVisibleItemIndex >= 0)
                assertTrue("Offset must be non-negative", state.firstVisibleItemScrollOffset >= 0)
            }
        }

        // Final verification: Overview state is still intact
        val finalOverview = resolveState(MobileDestination.Usage, InsightPane.Overview)
        assertEquals(12, finalOverview.firstVisibleItemIndex)
        assertEquals(150, finalOverview.firstVisibleItemScrollOffset)
    }

    @Test
    fun testLazyListStateSaverPersistence() {
        val scope = object : SaverScope {
            override fun canBeSaved(value: Any): Boolean = true
        }

        val original = LazyListState(firstVisibleItemIndex = 42, firstVisibleItemScrollOffset = 188)
        @Suppress("UNCHECKED_CAST")
        val saver = LazyListState.Saver as Saver<LazyListState, Any>
        val saved = with(saver) { scope.save(original) }
        assertNotNull("Saved state representation must not be null", saved)

        val restored = saver.restore(saved!!)
        assertNotNull("Restored state must not be null", restored)
        assertEquals(42, restored!!.firstVisibleItemIndex)
        assertEquals(188, restored.firstVisibleItemScrollOffset)
    }

    // =========================================================================
    // Challenge 3: V2DetailRow Layout Measurement & Accessibility Scaling
    // =========================================================================

    @Test
    fun testDetailRowFontScaleThreshold() {
        // Contract: fontScale < 1.5f uses single-pass Row; fontScale >= 1.5f uses FlowRow
        fun shouldUseFlowRow(fontScale: Float): Boolean {
            return fontScale >= 1.5f
        }

        // Standard scales
        assertEquals(false, shouldUseFlowRow(0.85f))
        assertEquals(false, shouldUseFlowRow(1.0f))
        assertEquals(false, shouldUseFlowRow(1.15f))
        assertEquals(false, shouldUseFlowRow(1.30f))
        assertEquals(false, shouldUseFlowRow(1.49f))
        assertEquals(false, shouldUseFlowRow(1.4999f))

        // Large / Accessibility scales
        assertEquals(true, shouldUseFlowRow(1.50f))
        assertEquals(true, shouldUseFlowRow(1.5001f))
        assertEquals(true, shouldUseFlowRow(1.75f))
        assertEquals(true, shouldUseFlowRow(2.0f))
        assertEquals(true, shouldUseFlowRow(2.5f))
        assertEquals(true, shouldUseFlowRow(3.0f))
    }

    @Test
    fun testDetailRequestCountLabelEdgeCases() {
        assertNull("0 requests should produce null label", detailRequestCountLabel(0L))
        assertNull("Negative requests should produce null label", detailRequestCountLabel(-1L))
        assertNull("Negative requests should produce null label", detailRequestCountLabel(-99L))

        assertEquals("1 条记录", detailRequestCountLabel(1L))
        assertEquals("42 条记录", detailRequestCountLabel(42L))
        assertEquals("1,000 条记录", detailRequestCountLabel(1000L))
        assertEquals("1,000,000 条记录", detailRequestCountLabel(1_000_000L))
        assertEquals("2,147,483,647 条记录", detailRequestCountLabel(Int.MAX_VALUE.toLong()))
    }

    @Test
    fun testDisplayedHistoryTokenCountCalculations() {
        val normalDetail = LogHistoryItem(
            id = 100L,
            timestamp = "2026-09-04T12:00:00Z",
            sessionId = "session-1",
            machineId = "MacBook-Pro",
            tool = "codex",
            model = "gpt-5",
            inputTokens = 1200L,
            outputTokens = 800L,
            cachedTokens = 300L,
            cost = 0.05,
            requests = 3L
        )

        // Effective mode: input + output
        assertEquals(2000L, displayedHistoryTokenCount(TokenDisplayMode.Effective, normalDetail))

        // All mode: input + output + cached
        assertEquals(2300L, displayedHistoryTokenCount(TokenDisplayMode.All, normalDetail))

        // Boundary: 0 tokens
        val zeroDetail = normalDetail.copy(inputTokens = 0L, outputTokens = 0L, cachedTokens = 0L)
        assertEquals(0L, displayedHistoryTokenCount(TokenDisplayMode.Effective, zeroDetail))
        assertEquals(0L, displayedHistoryTokenCount(TokenDisplayMode.All, zeroDetail))

        // Boundary: Extremely large token counts
        val largeDetail = normalDetail.copy(
            inputTokens = 1_000_000_000_000L,
            outputTokens = 2_000_000_000_000L,
            cachedTokens = 500_000_000_000L
        )
        assertEquals(3_000_000_000_000L, displayedHistoryTokenCount(TokenDisplayMode.Effective, largeDetail))
        assertEquals(3_500_000_000_000L, displayedHistoryTokenCount(TokenDisplayMode.All, largeDetail))
    }

    @Test
    fun testV2FormatTokensUnderLoad() {
        val tokenValues = listOf(
            0L to "0",
            42L to "42",
            999L to "999",
            1000L to "1.0K",
            123456L to "123.5K",
            1000000L to "1.00M",
            9876543210L to "9.88B"
        )

        for (i in 0 until 10000) {
            for ((num, expected) in tokenValues) {
                assertEquals(expected, v2FormatTokens(num))
            }
        }

        // Also test v2FormatNumber / formatInteger for full US comma formatting
        val numberValues = listOf(
            0L to "0",
            42L to "42",
            999L to "999",
            1000L to "1,000",
            123456L to "123,456",
            1000000L to "1,000,000",
            9876543210L to "9,876,543,210"
        )
        for ((num, expected) in numberValues) {
            assertEquals(expected, v2FormatNumber(num))
        }
    }
}
