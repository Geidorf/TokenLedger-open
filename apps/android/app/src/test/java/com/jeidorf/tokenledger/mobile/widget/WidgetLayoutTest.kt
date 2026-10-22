package com.jeidorf.tokenledger.mobile.widget

import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import org.junit.Assert.*
import org.junit.Test

class WidgetLayoutTest {
    private fun provider(id: String) = WidgetQuotaProvider(id, id, QuotaProviderStatus.Ok,
        WidgetQuotaWindow("周额度", .57f, "57%"), null, null, "2分钟前", false)

    @Test fun ringBudgetUsesActualSizeAndPreservesHiddenSources() {
        assertEquals(3, widgetRingLayout(400f, 200f, 1f, 5).visibleCount)
        assertEquals(2, widgetRingLayout(200f, 200f, 1f, 5).visibleCount)
        assertEquals(1, widgetRingLayout(320f, 200f, 2f, 5).visibleCount)
        assertEquals(0, widgetRingLayout(150f, 58f, 2f, 5).visibleCount)
        val all = (1..5).map { provider("p$it") }
        assertEquals(all, widgetLayoutProviders(all, null))
        assertEquals(listOf(all[4]), widgetLayoutProviders(all, "p5"))
        assertEquals(all.take(3), selectWidgetProviders(all, null)) // 旧 MultiBar 保留
    }

    @Test fun compactRingAcceptsHostOptionRangesAndFractionalHeights() {
        // 输入覆盖XML范围和100附近取整，并非把UIAutomator外框当作LocalSize。
        for (width in listOf(110f, 149.9f, 150f, 179.9f, 180f, 187.9f, 188f, 200f, 240f, 320f)) {
            for (height in listOf(80f, 90f, 99f, 99.5f, 99.99f, 100f, 100.01f, 110f)) {
                val plan = widgetRingLayout(width, height, 1f, 4)
                assertTrue("$width x $height has no complete ring", plan.visibleCount >= 1)
                assertTrue(plan.diameterDp >= 40f)
            }
        }
    }

    @Test fun compactRingReducesColumnsWithoutRepeatingOverflow() {
        for (width in listOf(188f, 200f, 320f, 400f)) {
            val plan = widgetRingLayout(width, 99f, 1f, 4)
            assertEquals(1, plan.visibleCount)
            assertTrue(plan.compactOverflow)
        }
        assertEquals(0, widgetRingLayout(110f, 100f, 2f, 4).visibleCount)
        assertEquals(0, widgetRingLayout(180f, 100f, 2f, 4).visibleCount)
        assertEquals(0, widgetRingLayout(110f, 60f, 1f, 4).visibleCount)
        assertEquals(0, widgetRingLayout(110f, 100f, 1f, 0).visibleCount)
    }

    @Test fun regularRingHierarchyDoesNotChange() {
        assertEquals(WidgetRingLayout(2, 72f), widgetRingLayout(200f, 200f, 1f, 4))
        assertEquals(WidgetRingLayout(1, 66f), widgetRingLayout(320f, 200f, 2f, 4))
        assertEquals(WidgetRingLayout(3, 72f), widgetRingLayout(400f, 200f, 1f, 4))
    }

    @Test fun comboKeepsBothPurposesOrExplicitlyRejectsTheSize() {
        val regular = widgetComboLayout(400f, 200f, 1f, 3)
        assertTrue(regular.sufficient)
        assertFalse(regular.stackedUsage)
        assertEquals(3, regular.visibleCount)
        for (scale in listOf(1f, 1.5f, 2f)) {
            val narrow = widgetComboLayout(320f, 240f, scale, 3)
            assertTrue(narrow.sufficient)
            assertTrue(narrow.visibleCount >= 1)
            assertTrue(narrow.usageHeightDp > 0)
        }
        assertFalse(widgetComboLayout(320f, 80f, 2f, 3).sufficient)
        assertFalse(widgetComboLayout(140f, 240f, 2f, 3).sufficient)
    }

    @Test fun completeCostAndPeriodRemainAccessibleWhenVisuallyReduced() {
        val usage = WidgetUsage(WidgetRange.Month, 987_600_000, 128640.34, 1, "2分钟前", null)
        val state = WidgetState.Ready(null, usage)
        for (mode in listOf(WidgetMode.SingleUsage, WidgetMode.BarUsage)) {
            val normal = widgetLayoutDescription(state, WidgetConfig(mode), false)
            assertTrue(normal.contains("¥128,640.34"))
            assertTrue(normal.contains("本月"))
            assertTrue(normal.contains("2分钟前"))
            val masked = widgetLayoutDescription(state, WidgetConfig(mode), true)
            assertTrue(masked.contains("¥***.*"))
            assertFalse(masked.contains("128"))
        }
    }

    @Test fun statusAndWindowMeaningNeverDependOnColorOrTransportOrder() {
        val p = provider("codex").copy(hiddenWindowCount = 2, primaryIsRoleSubstitute = true)
        assertTrue(widgetQuotaCaption(p).contains("替代"))
        assertTrue(widgetQuotaCaption(p).contains("+2"))
        assertEquals("可用 57%", widgetQuotaValue(p))
        for (status in listOf(QuotaProviderStatus.Error, QuotaProviderStatus.AuthRequired)) {
            val error = p.copy(status = status)
            assertFalse(widgetQuotaValue(error).contains("57"))
            assertFalse(providerAccessibilityDescription(error).contains("57"))
            assertTrue(widgetQuotaStatusSymbol(error) != "●")
        }
        assertEquals("历史 57%", widgetQuotaValue(p.copy(status = QuotaProviderStatus.Stale)))
    }
}
