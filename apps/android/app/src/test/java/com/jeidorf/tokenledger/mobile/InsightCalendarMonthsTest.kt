package com.jeidorf.tokenledger.mobile

import androidx.compose.ui.graphics.compositeOver
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette
import java.time.LocalDate
import java.time.YearMonth
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InsightCalendarMonthsTest {
    @Test
    fun todaySelectionStillProducesEveryCoveredMonth() {
        val axis = coveredAxis(
            start = date("2026-01-01"),
            end = date("2026-07-15"),
            highlighted = date("2026-07-15")
        )

        val months = insightCalendarMonths(axis)

        assertEquals(
            listOf("2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"),
            months.map { it.yearMonth.toString() }
        )
        assertEquals(1, months.flatMap { it.cells }.filterNotNull().count { it.inQueryRange })
    }

    @Test
    fun monthGridStartsOnMondayAndAlwaysHasFortyTwoSlots() {
        val month = insightCalendarMonths(
            coveredAxis(date("2026-03-01"), date("2026-03-31"))
        ).single()

        assertEquals(YearMonth.of(2026, 3), month.yearMonth)
        assertEquals(42, month.cells.size)
        assertEquals(6, month.cells.indexOfFirst { it?.date == date("2026-03-01") })
        assertTrue(month.cells.take(6).all { it == null })
    }

    @Test
    fun leapFebruaryKeepsTwentyNineTrustedDays() {
        val month = insightCalendarMonths(
            coveredAxis(date("2024-02-01"), date("2024-02-29"))
        ).single()

        assertEquals(29, month.cells.filterNotNull().size)
        assertEquals(date("2024-02-29"), month.cells.filterNotNull().last().date)
    }

    @Test
    fun coverageAcrossYearBoundaryProducesOrderedNaturalMonths() {
        val months = insightCalendarMonths(
            coveredAxis(date("2025-12-20"), date("2026-01-10"))
        )

        assertEquals(listOf(YearMonth.of(2025, 12), YearMonth.of(2026, 1)), months.map { it.yearMonth })

        // 12 月是首月，轴的 selectableStart 是 12-20：12 月 1-19 日仍是真实的 12 月日子，只是落在
        // 轴覆盖范围之前，合成为 OutsideHeatmapCoverage（非 null）——和"月末落在 cutoff 之后合成
        // Future"对称（见 trailingDaysPastCutoffWithinTheSameMonthBecomeFutureNotNull）：网格占位式
        // 的 null 只留给真正跨月的填充格（11 月那几天），不该用来表示"本月但不可信"。
        val december = months.first()
        val dec1Index = december.cells.indexOfFirst { it?.date == date("2025-12-01") }
        assertTrue(dec1Index >= 0)
        assertTrue(december.cells.take(dec1Index).all { it == null })
        assertEquals(date("2025-12-01"), december.cells.filterNotNull().first().date)
        val dec19 = december.cells.first { it?.date == date("2025-12-19") }
        assertEquals(false, dec19?.selectable)
        assertEquals(InsightCalendarCellAvailability.OutsideHeatmapCoverage, dec19?.availability)
        val dec20 = december.cells.first { it?.date == date("2025-12-20") }
        assertEquals(true, dec20?.selectable)

        // cutoff 是 2026-01-10：1 月 11-31 日已经不可信，但仍属于同一自然月，
        // 应当合成为 Future 补位格而不是网格占位式的 null（见下一条测试）。
        assertEquals(
            date("2026-01-10"),
            months.last().cells.filterNotNull().last(InsightCalendarCell::selectable).date
        )
        assertEquals(date("2026-01-31"), months.last().cells.filterNotNull().last().date)
    }

    @Test
    fun trailingDaysPastCutoffWithinTheSameMonthBecomeFutureNotNull() {
        // 回归 T10.209 修复前的退化：本月末尾在 cutoff 之后的日子曾经和"不属于本月"的网格占位
        // 一样被塌缩成 null，界面因此画不出"未来"这个非颜色线索。
        val axis = coveredAxis(start = date("2026-09-01"), end = date("2026-09-10"))
        val month = insightCalendarMonths(axis).single()

        val sept11 = month.cells.first { it?.date == date("2026-09-11") }
        assertEquals(false, sept11?.selectable)
        assertEquals(InsightCalendarCellAvailability.Future, sept11?.availability)
        assertEquals(true, sept11?.isFuture)
        assertEquals(null, sept11?.knownTokens)

        // 本月之前那几天（8 月的网格占位，与 "monthGridStartsOnMondayAndAlwaysHasFortyTwoSlots" 同一算法）
        // 依旧是纯 null，不应被误判为 Future：占位格数量 = 周一开头网格里 9 月 1 日之前的偏移量。
        val firstDayIndex = month.cells.indexOfFirst { it?.date == date("2026-09-01") }
        assertTrue(firstDayIndex > 0)
        assertTrue(month.cells.take(firstDayIndex).all { it == null })
    }

    @Test
    fun untrustedOrMissingCoverageReturnsNoMonths() {
        assertTrue(
            insightCalendarMonths(
                InsightCalendarAxis(
                    cells = emptyList(),
                    timezone = "Asia/Shanghai",
                    cutoffDate = null,
                    unavailableReason = "响应未提供可信截止时间"
                )
            ).isEmpty()
        )
        assertTrue(
            insightCalendarMonths(
                InsightCalendarAxis(emptyList(), "Asia/Shanghai", date("2026-07-15"))
            ).isEmpty()
        )
    }

    // ---------------------------------------------------------------------------------
    // 五级分位量化（T10.173 §3.8，T10.209 范围 1）。
    // ---------------------------------------------------------------------------------

    @Test
    fun emptyWindowHasNoThresholdsAndEverythingIsLevelZero() {
        assertEquals(null, heatLevelThresholds(emptyList()))
        // 空窗口（没有任何非零已知日）：已知为 0 的日子仍然是 0 级，不是"无级别"。
        assertEquals(0, heatLevel(0L, null))
    }

    @Test
    fun allEqualNonZeroValuesCollapseToLevelOne() {
        // 全年非零日全部同值：三个分位重合，级联比较的第一档（不超过 p25）先命中，统一给 1 级，
        // 不会因为"并列"就抬到更高档——这是分位定义的自然结果，不是遗漏。
        val thresholds = heatLevelThresholds(List(12) { 500L })
        assertEquals(HeatLevelThresholds(500L, 500L, 500L), thresholds)
        repeat(12) { assertEquals(1, heatLevel(500L, thresholds)) }
    }

    @Test
    fun fiveLevelsCoverKnownZeroAndFourQuantileBands() {
        // 10 个非零日，取值 10..100（步长 10）：p25/p50/p75 用「四舍五入取最近秩」的百分位法确定，
        // index = round(q * (n-1))：p25 -> round(2.25)=2 -> 30；p50 -> round(4.5)=5 -> 60；
        // p75 -> round(6.75)=7 -> 80。
        val values = (1..10).map { it * 10L }
        val thresholds = heatLevelThresholds(values)!!
        assertEquals(HeatLevelThresholds(p25 = 30L, p50 = 60L, p75 = 80L), thresholds)

        assertEquals(0, heatLevel(0L, thresholds))
        assertEquals(0, heatLevel(-5L, thresholds)) // 不应出现的负数也不崩，稳妥归零级
        assertEquals(1, heatLevel(10L, thresholds))
        assertEquals(1, heatLevel(30L, thresholds)) // 恰好落在 p25 上，仍属 1 级（<=）
        assertEquals(2, heatLevel(31L, thresholds))
        assertEquals(2, heatLevel(60L, thresholds)) // 恰好落在 p50 上，仍属 2 级
        assertEquals(3, heatLevel(61L, thresholds))
        assertEquals(3, heatLevel(80L, thresholds)) // 恰好落在 p75 上，仍属 3 级
        assertEquals(4, heatLevel(81L, thresholds))
        assertEquals(4, heatLevel(100_000L, thresholds))
    }

    @Test
    fun knownNonZeroTokensExcludesUnknownAndZeroDays() {
        val cells = listOf(
            InsightCalendarCell(date("2026-01-01"), 40L, InsightCalendarCellAvailability.Covered),
            InsightCalendarCell(date("2026-01-02"), 0L, InsightCalendarCellAvailability.Covered),
            InsightCalendarCell(date("2026-01-03"), 999L, InsightCalendarCellAvailability.Future),
            InsightCalendarCell(date("2026-01-04"), 999L, InsightCalendarCellAvailability.OutsideHeatmapCoverage),
            null
        )
        assertEquals(listOf(40L), knownNonZeroTokens(cells))
    }

    @Test
    fun monthPanelLevelsUseTheAxisWideScale() {
        // R-69 FI-3：一月是小数（1..31），二月是大数（1 日为 0，其余每天 ×100）。按整条 axis 分位（年度小格
        // 那把尺子），二月落在 0/3/4 级；月面板若改按单月重算，二月会被摊到 1–4 级，丢了阈值则全是 1 级——都会红。
        val january = (1..31).map { day ->
            InsightCalendarCell(LocalDate.of(2026, 1, day), day.toLong(), InsightCalendarCellAvailability.Covered)
        }
        val february = (1..28).map { day ->
            InsightCalendarCell(LocalDate.of(2026, 2, day), if (day == 1) 0L else day * 100L, InsightCalendarCellAvailability.Covered)
        }
        val axis = InsightCalendarAxis(
            cells = january + february,
            timezone = "Asia/Shanghai",
            cutoffDate = date("2026-02-28"),
            selectableStart = date("2026-01-01"),
            selectableEnd = date("2026-02-28")
        )
        // 58 个非零日按「四舍五入取最近秩」：p25 -> round(14.25)=14 -> 15；p50 -> round(28.5)=29 -> 30；
        // p75 -> round(42.75)=43 -> 二月 14 日的 1400。
        val yearGridThresholds = heatLevelThresholds(knownNonZeroTokens(axis.cells))
        assertEquals(HeatLevelThresholds(p25 = 15L, p50 = 30L, p75 = 1_400L), yearGridThresholds)

        val february2026 = monthPanelDays(axis, YearMonth.of(2026, 2)).filterNotNull()
        assertEquals(28, february2026.size)
        february2026.forEach { day ->
            assertEquals(day.cell.date.toString(), heatLevel(day.cell.knownTokens!!, yearGridThresholds), day.level)
        }
        assertEquals(listOf(0) + List(13) { 3 } + List(14) { 4 }, february2026.map { it.level })
    }

    @Test
    fun monthPanelLeavesUnknownDaysWithoutALevel() {
        // GLB-01：覆盖外与未来不经过色阶（level = null），不会被画成 0 级。
        val days = monthPanelDays(julyAxis(), YearMonth.of(2026, 7)).filterNotNull()
        assertEquals(31, days.size)
        assertEquals(List(4) { null }, days.take(4).map { it.level })
        assertEquals(List(7) { null }, days.takeLast(7).map { it.level })
        assertTrue(days.subList(4, 24).all { it.level != null })
    }

    @Test
    fun monthPanelDayNumbersReachTextContrastOnEveryLevel() {
        // R-69 P1-2：月面板底色是 popover；1–3 级是带透明度的 chart-1，按 alpha 合成到底色上才是用户看到的颜色。
        // 三套主题、五级格子上的日期数字都要 ≥4.5:1；未来日的数字（faint）直接画在面板底色上，也一并核对。
        listOf(LedgerAppearance.Dark, LedgerAppearance.Light, LedgerAppearance.EInk).forEach { appearance ->
            val tokens = v2Palette(appearance).tokens
            tokens.heat.indices.forEach { level ->
                val shown = tokens.heat[level].compositeOver(tokens.popover)
                assertEquals("$appearance $level 级合成后应为不透明色", 1f, shown.alpha)
                val ratio = wcagContrastRatio(monthPanelDayLabelColor(tokens, level), shown)
                assertTrue("$appearance $level 级日期数字只有 ${"%.2f".format(ratio)}:1", ratio >= 4.5)
            }
            val future = wcagContrastRatio(tokens.faint, tokens.popover)
            assertTrue("$appearance 未来日数字只有 ${"%.2f".format(future)}:1", future >= 4.5)
        }
    }

    // ---------------------------------------------------------------------------------
    // TalkBack 摘要（T10.173 §6.1，T10.172 C9，T10.209 范围 4）。
    // ---------------------------------------------------------------------------------

    @Test
    fun monthSummaryReportsTotalActiveDaysAndPeakDay() {
        val axis = coveredAxis(date("2026-07-01"), date("2026-07-31"))
        val month = insightCalendarMonths(axis).single()
        val summary = monthAccessibilitySummary(month.yearMonth, month.cells)
        // coveredAxis 按 dayOfMonth 赋值 token 数（1..31），合计是等差数列求和，最高必然是月末一天；
        // 不传 highlighted 时整月都在当前查询范围内（R-69 P2-3：查询范围在月摘要里说出来）。
        val total = (1..31).sum().toLong()
        assertEquals(
            "7月：合计 ${v2FormatTokens(total)}，活跃 31 天，最高 31 日；当前查询 1 日至 31 日。双击选择日期",
            summary
        )
    }

    @Test
    fun monthSummaryNamesQueryRangeAndOutsideCoverageDays() {
        // R-69 P2-3（方案 §6.1）：7 月 1–4 日覆盖外、25–31 日未来、13–19 日为当前查询。
        val month = insightCalendarMonths(julyAxis()).single()
        val total = (5..24).filterNot { it in JULY_ZERO_DAYS }.sumOf { it * 1_000L }
        assertEquals(
            "7月：合计 ${v2FormatTokens(total)}，活跃 17 天，最高 24 日；当前查询 13 日至 19 日；1 日至 4 日未查询。双击选择日期",
            monthAccessibilitySummary(month.yearMonth, month.cells)
        )
    }

    @Test
    fun monthSummaryReadsEachRunAndSingleDays() {
        // 连续段读成「a 日至 b 日」，单日读成「a 日」，多段用顿号；没有覆盖外的日子就不提「未查询」。
        val cells = (1..10).map { day ->
            InsightCalendarCell(
                date = LocalDate.of(2026, 3, day),
                tokens = 0L,
                availability = InsightCalendarCellAvailability.Covered,
                inQueryRange = day == 2 || day in 5..7
            )
        }
        assertEquals(
            "3月：合计 0，活跃 0 天；当前查询 2 日、5 日至 7 日。双击选择日期",
            monthAccessibilitySummary(YearMonth.of(2026, 3), cells)
        )
    }

    @Test
    fun monthSummaryWithNoActiveDaysOmitsPeakPhrase() {
        val allZero = List(30) { index ->
            InsightCalendarCell(
                date = LocalDate.of(2026, 4, index + 1),
                tokens = 0L,
                availability = InsightCalendarCellAvailability.Covered,
                inQueryRange = false
            )
        }
        val summary = monthAccessibilitySummary(YearMonth.of(2026, 4), allZero)
        assertEquals("4月：合计 0，活跃 0 天。双击选择日期", summary)
    }

    @Test
    fun monthSummaryWithNoTrustedCellsDoesNotFabricateNumbers() {
        val summary = monthAccessibilitySummary(YearMonth.of(2026, 12), List(42) { null })
        assertEquals("12月：尚无可信数据。双击选择日期", summary)
    }

    @Test
    fun dayLabelPicksExactlyOneOfFourStates() {
        val known = InsightCalendarCell(date("2026-05-10"), 1_500_000L, InsightCalendarCellAvailability.Covered)
        val zero = InsightCalendarCell(date("2026-05-11"), 0L, InsightCalendarCellAvailability.Covered)
        val future = InsightCalendarCell(date("2026-05-12"), 0L, InsightCalendarCellAvailability.Future)
        val outside = InsightCalendarCell(date("2026-05-13"), 0L, InsightCalendarCellAvailability.OutsideHeatmapCoverage)

        assertEquals("5月10日，${v2FormatTokens(1_500_000L)}", dayAccessibilityLabel(known))
        assertEquals("5月11日，无消耗", dayAccessibilityLabel(zero))
        assertEquals("5月12日，未来", dayAccessibilityLabel(future))
        assertEquals("5月13日，未查询", dayAccessibilityLabel(outside))
    }

    private fun coveredAxis(
        start: LocalDate,
        end: LocalDate,
        highlighted: LocalDate? = null
    ): InsightCalendarAxis {
        val cells = generateSequence(start) { current ->
            current.plusDays(1).takeIf { it <= end }
        }.map { current ->
            InsightCalendarCell(
                date = current,
                tokens = current.dayOfMonth.toLong(),
                availability = InsightCalendarCellAvailability.Covered,
                inQueryRange = current == highlighted || highlighted == null
            )
        }.toList()
        return InsightCalendarAxis(
            cells = cells,
            timezone = "Asia/Shanghai",
            cutoffDate = end,
            selectableStart = start,
            selectableEnd = end
        )
    }

    /** 2026 年 7 月：可信 5–24 日（6、12、20 日为 0，其余 = 日 × 1000），1–4 日覆盖外，25–31 日未来，13–19 日为当前查询。 */
    private fun julyAxis(): InsightCalendarAxis {
        val start = date("2026-07-05")
        val end = date("2026-07-24")
        val cells = generateSequence(start) { current -> current.plusDays(1).takeIf { it <= end } }.map { current ->
            InsightCalendarCell(
                date = current,
                tokens = if (current.dayOfMonth in JULY_ZERO_DAYS) 0L else current.dayOfMonth * 1_000L,
                availability = InsightCalendarCellAvailability.Covered,
                inQueryRange = current.dayOfMonth in 13..19
            )
        }.toList()
        return InsightCalendarAxis(
            cells = cells,
            timezone = "Asia/Shanghai",
            cutoffDate = end,
            selectableStart = start,
            selectableEnd = end
        )
    }

    private fun date(value: String): LocalDate = LocalDate.parse(value)

    private companion object {
        val JULY_ZERO_DAYS = setOf(6, 12, 20)
    }
}
