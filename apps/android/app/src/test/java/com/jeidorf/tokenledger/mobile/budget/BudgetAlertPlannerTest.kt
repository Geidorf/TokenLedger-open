package com.jeidorf.tokenledger.mobile.budget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BudgetAlertPlannerTest {
    private val device = "a".repeat(32)
    private val now = 1_800_000_000_000L

    private fun body(vararg budgets: String, receivedAt: String = "2026-10-24T07:00:00Z") = """
        {"serverTime":"2026-10-24T07:10:00Z","snapshots":[
          {"device":"$device","receivedAt":"$receivedAt","snapshot":{"v":1,"generatedAt":"2026-10-24T07:00:00Z","budgets":[${budgets.joinToString(",")}]}}
        ]}
    """.trimIndent()

    private fun budget(id: String, level: String, percent: Int, label: String = "Codex", start: String = "2026-10-01") =
        """{"id":"$id","label":"$label","period":"month","metric":"cost","periodStart":"$start","percent":$percent,"level":"$level"}"""

    @Test
    fun parsesSnapshotsAndDropsOnlyTheBadBudget() {
        val parsed = BudgetSnapshots.parse(
            body(
                budget("9f2c4e1a7b3d5f60", "warn", 85),
                budget("not-hex", "warn", 85),
                """{"id":"0123456789abcdef","label":"x","period":"year","metric":"cost","periodStart":"2026-10-01","percent":1,"level":"ok"}""",
                budget("fedcba9876543210", "over", 112, label = "全部用量"),
            )
        )
        assertEquals(1, parsed.size)
        assertEquals(600L, parsed[0].ageSeconds)
        assertEquals(listOf("9f2c4e1a7b3d5f60", "fedcba9876543210"), parsed[0].budgets.map { it.id })
        assertEquals(BudgetPeriod.Month, parsed[0].budgets[0].period)
    }

    @Test(expected = BudgetSnapshotFormatException::class)
    fun rejectsABodyWithoutServerTime() {
        BudgetSnapshots.parse("""{"snapshots":[]}""")
    }

    @Test
    fun notifiesOverFirstOnceAndMarksTheWarningTier() {
        val snapshots = BudgetSnapshots.parse(
            body(budget("1111111111111111", "warn", 85), budget("2222222222222222", "over", 120, label = "gpt-5"))
        )
        val first = BudgetAlertPlanner.plan(snapshots, emptyMap(), now, prime = false)
        assertEquals(listOf("gpt-5 已超出预算", "Codex 预算已用 85%"), first.notifications.map { it.title })
        assertEquals("本月费用预算已用 120%", first.notifications[0].body)
        assertTrue(first.ledger.keys.any { it.endsWith("2222222222222222|2026-10-01|warn") })

        val again = BudgetAlertPlanner.plan(snapshots, first.ledger, now + 60_000, prime = false)
        assertTrue(again.notifications.isEmpty())

        // 同一预算从接近升到超出：只推超出一次。
        val climbed = BudgetSnapshots.parse(body(budget("1111111111111111", "over", 101)))
        val third = BudgetAlertPlanner.plan(climbed, again.ledger, now + 120_000, prime = false)
        assertEquals(listOf("Codex 已超出预算"), third.notifications.map { it.title })

        // 下个周期重新计数。
        val nextMonth = BudgetSnapshots.parse(body(budget("1111111111111111", "warn", 81, start = "2026-11-01")))
        assertEquals(1, BudgetAlertPlanner.plan(nextMonth, third.ledger, now + 180_000, prime = false).notifications.size)
    }

    @Test
    fun primingRecordsWithoutPostingAndStaleSnapshotsStayQuiet() {
        val snapshots = BudgetSnapshots.parse(body(budget("1111111111111111", "warn", 85)))
        val primed = BudgetAlertPlanner.plan(snapshots, emptyMap(), now, prime = true)
        assertTrue(primed.notifications.isEmpty())
        assertTrue(BudgetAlertPlanner.plan(snapshots, primed.ledger, now, prime = false).notifications.isEmpty())

        val stale = BudgetSnapshots.parse(body(budget("3333333333333333", "over", 150), receivedAt = "2026-10-23T18:00:00Z"))
        val plan = BudgetAlertPlanner.plan(stale, emptyMap(), now, prime = false)
        assertTrue(plan.notifications.isEmpty())
        assertFalse(plan.ledger.keys.any { it.contains("3333333333333333") })
    }

    @Test
    fun capsEachReadAndKeepsTheRestForLater() {
        val ids = (1..5).map { it.toString().repeat(16) }
        val snapshots = BudgetSnapshots.parse(body(*ids.mapIndexed { i, id -> budget(id, "warn", 80 + i) }.toTypedArray()))
        val first = BudgetAlertPlanner.plan(snapshots, emptyMap(), now, prime = false)
        assertEquals(BudgetAlertPlanner.MAX_PER_READ, first.notifications.size)
        assertEquals("Codex 预算已用 84%", first.notifications[0].title)
        val second = BudgetAlertPlanner.plan(snapshots, first.ledger, now + 1_000, prime = false)
        assertEquals(2, second.notifications.size)
    }

    @Test
    fun ledgerRoundTripsAndExpires() {
        val ledger = mapOf("a|b|2026-10-01|warn" to now, "old|b|2026-08-01|warn" to now - 50L * 24 * 60 * 60 * 1000)
        assertEquals(ledger, BudgetAlertPlanner.decodeLedger(BudgetAlertPlanner.encodeLedger(ledger)))
        assertEquals(emptyMap<String, Long>(), BudgetAlertPlanner.decodeLedger("not json"))
        val plan = BudgetAlertPlanner.plan(emptyList(), ledger, now, prime = false)
        assertEquals(setOf("a|b|2026-10-01|warn"), plan.ledger.keys)
    }

    @Test
    fun trimmingNeverDropsBudgetsThatAreStillNearOrOver() {
        val ids = (0 until 32).map { "%016x".format(it + 1) }
        val snapshots = BudgetSnapshots.parse(body(*ids.map { budget(it, "over", 120) }.toTypedArray()))
        val primed = BudgetAlertPlanner.plan(snapshots, emptyMap(), now - 1_000, prime = true)
        // 更新、但已不在快照里的历史记录多到超过上限。
        val history = (0 until 1_100).associate { "old|$it|2026-10-01|warn" to now }
        val again = BudgetAlertPlanner.plan(snapshots, primed.ledger + history, now, prime = false)
        assertTrue(again.notifications.isEmpty())
        assertTrue(again.ledger.size <= 1_024)
        assertTrue(primed.ledger.keys.all { it in again.ledger })
    }
}
