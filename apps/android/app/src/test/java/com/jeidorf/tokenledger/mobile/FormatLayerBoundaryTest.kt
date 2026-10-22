package com.jeidorf.tokenledger.mobile

import com.jeidorf.tokenledger.mobile.widget.formatCny
import com.jeidorf.tokenledger.mobile.widget.formatDeltaPercent
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import com.jeidorf.tokenledger.mobile.widget.formatCompactTokens as widgetCompactTokens
import com.jeidorf.tokenledger.mobile.widget.formatCompactNumber as widgetCompactNumber
import com.jeidorf.tokenledger.mobile.widget.widgetRemainingQuotaText as widgetRemainingQuota

/**
 * T10.207（T10.172 C1，并入 T10.154 A3）：应用、摆件、小组件与海报共用一个格式层。
 *
 * 任务书列的边界值逐条钉在这里：999,499、999,500、999,999、负值、<0.01、NaN（额度的 49.5、50.4、
 * 79.5、80.4、99.6 见 [QuotaWindowConsistencyTest]）。Token 用例直接读桌面与托盘共用的黄金用例
 * `fixtures/token-format-v1/cases.json`，不再内联副本（T10.207 评审 P3-4；T10.204 改舍入后三端同一份）；
 * 金额用例仍逐字内联 `fixtures/estimated-usd-format-v1/cases.json`，Android 金额按 T10.154 §4.1 不带 ≈。
 */
class FormatLayerBoundaryTest {

    // region Token（A-Q1：K 一位、M 与 B 两位，先舍入再选单位）

    /**
     * token-format-v1 的全部整数用例，从仓库根目录的文件读（从当前目录逐级向上找，Gradle 与离线检查都能找到）；
     * `null → —` 一条只有能读到 null 的调用方才有，Long 入参没有这种状态。
     */
    private val desktopTokenCases: List<Pair<Long, String>> by lazy {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }
            .take(8)
            .map { File(it, "fixtures/token-format-v1/cases.json") }
            .firstOrNull { it.isFile }
            ?: error("找不到 fixtures/token-format-v1/cases.json（当前目录 ${File("").absolutePath}）")
        Regex(""""input":\s*(-?\d+)\s*,\s*"expected":\s*"([^"]*)"""")
            .findAll(file.readText(Charsets.UTF_8))
            .map { it.groupValues[1].toLong() to it.groupValues[2] }
            .toList()
    }

    @Test
    fun appAndPosterTokensMatchTheDesktopGoldenCasesVerbatim() {
        // 文件里的整数用例一条不少（含 T10.204 的居中值 1,150、1,005,000 与负数 -1,150）。
        assertTrue("黄金用例条数 ${desktopTokenCases.size}", desktopTokenCases.size >= 30)
        assertTrue(desktopTokenCases.containsAll(listOf(1_150L to "1.2K", 1_005_000L to "1.01M", -1_150L to "-1.2K")))
        for ((input, expected) in desktopTokenCases) {
            assertEquals("应用 $input", expected, v2FormatTokens(input))
            assertEquals("海报 $input", expected, formatCompactTokens(input))
        }
    }

    @Test
    fun theOldThousandKBoundaryIsGoneEverywhere() {
        // 旧应用与海报：999,500 → `%.0fK` → 「1000K」；旧小组件：999,950 → 「1000.0K」。
        listOf(999_500L, 999_950L, 999_999L).forEach { value ->
            listOf(v2FormatTokens(value), formatCompactTokens(value), widgetCompactTokens(value)).forEach { text ->
                assertEquals("$value → $text", false, text.startsWith("1000") && text.endsWith("K"))
            }
        }
        assertEquals("999.5K", v2FormatTokens(999_499L))
        assertEquals("999.5K", v2FormatTokens(999_500L))
        assertEquals("1.00M", v2FormatTokens(999_999L))
    }

    @Test
    fun widgetKeepsOneDecimalButCarriesLikeTheApp() {
        // REQ-WIDGET-03：小组件 M、B 也只留一位，进位规则与应用相同。
        assertEquals("999.5K", widgetCompactTokens(999_499L))
        assertEquals("999.5K", widgetCompactTokens(999_500L))
        assertEquals("1.0M", widgetCompactTokens(999_950L))
        assertEquals("1.0M", widgetCompactTokens(999_999L))
        assertEquals("1.1M", widgetCompactTokens(1_125_000L))
        assertEquals("1.0B", widgetCompactTokens(999_950_000L))
        assertEquals("-1.0M", widgetCompactTokens(-999_999L))
        assertEquals("999", widgetCompactTokens(999L))
    }

    @Test
    fun widgetRemainingQuotaAmountCarriesLikeTheApp() {
        // 小组件额度绝对量「剩 N」：不足 10,000 写整数；旧版 999,950 写「1000.0K」、999,950,000 写「1000.0M」。
        assertEquals("9999", widgetCompactNumber(9_999L))
        assertEquals("10.0K", widgetCompactNumber(10_000L))
        assertEquals("999.9K", widgetCompactNumber(999_949L))
        assertEquals("1.0M", widgetCompactNumber(999_950L))
        assertEquals("1.0M", widgetCompactNumber(999_999L))
        assertEquals("999.9M", widgetCompactNumber(999_949_999L))
        assertEquals("1.0B", widgetCompactNumber(999_950_000L))
    }

    @Test
    fun widgetRemainingQuotaTextNeverTurnsUnknownIntoZero() {
        // T10.207 评审 P2-1（GLB-01）：剩余量缺失时写「—」，不拿已用量顶替、不写「剩 0」。
        assertEquals("—", widgetRemainingQuota(null))
        assertEquals("—", widgetRemainingQuota(Double.NaN))
        assertEquals("—", widgetRemainingQuota(Double.POSITIVE_INFINITY))
        assertEquals("剩 0", widgetRemainingQuota(0.0))
        assertEquals("剩 9999", widgetRemainingQuota(9_999.4))
        assertEquals("剩 1.0M", widgetRemainingQuota(999_950.0))
    }

    @Test
    fun signedTokenAndCountDeltasUseTheTrueMinusSign() {
        assertEquals("+1.5K", formatSignedTokens(1_500L))
        assertEquals("−1.5K", formatSignedTokens(-1_500L))
        assertEquals("−1.00M", formatSignedTokens(-999_999L))
        assertEquals("0", formatSignedTokens(0L))
        assertEquals("+1,234", formatSignedInteger(1_234L))
        assertEquals("−12", formatSignedInteger(-12L))
        assertEquals("0", formatSignedInteger(0L))
    }

    // endregion

    // region 金额（T10.154 §4.1 Android 行：千分位、两位、不带 ≈；<0.01；不可得；已知 0）

    /** estimated-usd-format-v1 的全部用例；Android 不带 ≈，其余逐字相同。null 表示读不到。 */
    private val desktopUsdCases = listOf(
        null to "不可得", "NaN" to "不可得", "Infinity" to "不可得", "-Infinity" to "不可得",
        "-0.5" to "不可得", "-1e-9" to "不可得",
        "0" to "≈$0.00", "-0" to "≈$0.00",
        "5e-324" to "<$0.01", "1e-9" to "<$0.01", "0.004" to "<$0.01", "0.005" to "<$0.01", "0.00999" to "<$0.01",
        "0.01" to "≈$0.01", "0.015" to "≈$0.02", "0.125" to "≈$0.13", "1" to "≈$1.00",
        "1.004999" to "≈$1.00", "1.005" to "≈$1.01", "2.675" to "≈$2.68", "12.345" to "≈$12.35",
        "999.994" to "≈$999.99", "999.995" to "≈$1,000.00", "1234.5" to "≈$1,234.50", "1422.78" to "≈$1,422.78",
        "1e6" to "≈$1,000,000.00", "999999.995" to "≈$1,000,000.00", "123456789.123" to "≈$123,456,789.12",
        "1e21" to "≈$1,000,000,000,000,000,000,000.00"
    )

    @Test
    fun moneyMatchesTheDesktopGoldenCasesWithoutTheApproxSign() {
        for ((input, expected) in desktopUsdCases) {
            val value = input?.toDouble()
            assertEquals("USD $input", expected.replace("≈", ""), formatCurrencyAmount(value, CurrencyUnit.USD))
        }
    }

    @Test
    fun knownZeroAndUnknownAreDistinguishableOnEverySurface() {
        // 应用与摆件（formatCostForDisplay / v2FormatMoney）、小组件（formatCny）、海报（formatNetSavedCny）同一个出口。
        assertEquals("¥0.00", formatCostForDisplay(0.0, exchangeRate = 7.2))
        assertEquals("¥0.00", formatCostForDisplay(-0.0, exchangeRate = 7.2))
        assertEquals("不可得", formatCostForDisplay(null, exchangeRate = 7.2))
        assertEquals("不可得", formatCostForDisplay(Double.NaN, exchangeRate = 7.2))
        assertEquals("不可得", formatCostForDisplay(-1.0, exchangeRate = 7.2))
        assertEquals("不可得", formatCostForDisplay(1.0, exchangeRate = Double.NaN))
        assertEquals("¥0.00", formatCny(0.0))
        assertEquals("不可得", formatCny(null))
        assertEquals("不可得", formatCny(Double.NaN))
        assertEquals("不可得", formatNetSavedCny(Double.NaN))
        assertEquals("不可得", CurrencyUnit.CNY.format(null))
    }

    @Test
    fun sameAmountReadsTheSameOnAppWidgetAndPoster() {
        // 0.001 美元 × 7.2 = ¥0.0072：三处都写 <¥0.01；1,786.7 美元 × 7.2 = ¥12,864.24：三处都带千分位。
        assertEquals("<¥0.01", formatCostForDisplay(0.001, exchangeRate = 7.2))
        assertEquals("<¥0.01", formatCny(0.001 * 7.2))
        assertEquals("<¥0.01", formatNetSavedCny(0.001 * 7.2))
        val usd = 1_786.7
        val app = formatCostForDisplay(usd, exchangeRate = 7.2)
        assertEquals("¥12,864.24", app)
        assertEquals(app, formatCny(CurrencyUnit.CNY.convertFromUsd(usd, 7.2)))
        assertEquals(app, formatNetSavedCny(usd * 7.2))
    }

    @Test
    fun recordPrecisionKeepsFourDecimalsBelowOneUnit() {
        // §4.1「单条记录」：v < 1 保留 4 位，0 < v < 0.00005 写 <$0.0001；v ≥ 1 两位。
        assertEquals("$0.0012", formatCurrencyAmount(0.0012, CurrencyUnit.USD, CostPrecision.Record))
        assertEquals("<$0.0001", formatCurrencyAmount(0.00004, CurrencyUnit.USD, CostPrecision.Record))
        assertEquals("$0.0001", formatCurrencyAmount(0.00005, CurrencyUnit.USD, CostPrecision.Record))
        assertEquals("$1.25", formatCurrencyAmount(1.25, CurrencyUnit.USD, CostPrecision.Record))
        assertEquals("$0.00", formatCurrencyAmount(0.0, CurrencyUnit.USD, CostPrecision.Record))
        assertEquals("不可得", formatCurrencyAmount(-0.1, CurrencyUnit.USD, CostPrecision.Record))
        assertEquals("¥0.0086", formatCostForDisplay(0.0012, exchangeRate = 7.2, precision = CostPrecision.Record))
    }

    @Test
    fun signedMoneyUsesSignWithoutApproxAndKeepsTheLessThanCentRule() {
        assertEquals("+$3.20", formatSignedCurrencyAmount(3.2, CurrencyUnit.USD))
        assertEquals("−$1.05", formatSignedCurrencyAmount(-1.05, CurrencyUnit.USD))
        assertEquals("+<$0.01", formatSignedCurrencyAmount(0.004, CurrencyUnit.USD))
        assertEquals("−<$0.01", formatSignedCurrencyAmount(-0.004, CurrencyUnit.USD))
        assertEquals("−¥1,234.50", formatSignedCurrencyAmount(-1_234.5, CurrencyUnit.CNY))
        assertEquals("$0.00", formatSignedCurrencyAmount(0.0, CurrencyUnit.USD))
        assertEquals("不可得", formatSignedCurrencyAmount(Double.NaN, CurrencyUnit.USD))
        assertEquals("不可得", formatSignedCurrencyAmount(null, CurrencyUnit.USD))
    }

    // endregion

    // region 百分比（R-11：与桌面 MetricsGrid.formatChangePercent 同式）

    @Test
    fun changePercentMatchesTheDesktopRule() {
        val cases = listOf(
            5.0 to "+5.0%", -5.0 to "−5.0%", 9.94 to "+9.9%", 9.95 to "+9.9%",
            // 与桌面相同：先按原值判断 ≥ 10，再舍入，所以 9.96 写 +10.0%。
            9.96 to "+10.0%", 10.0 to "+10%", 10.5 to "+11%", -10.5 to "−11%", 49.5 to "+50%", 150.0 to "+150%",
            0.05 to "+0.1%", -0.06 to "−0.1%"
        )
        for ((input, expected) in cases) assertEquals("$input", expected, formatChangePercent(input))
    }

    @Test
    fun changePercentRoundedToZeroIsUnsignedAndNonFiniteIsUnavailable() {
        // 舍入后为 0 不带符号（不把 0.04% 说成上涨）；桌面此处由调用方先写「持平」，见任务日志。
        assertEquals("0.0%", formatChangePercent(0.0))
        assertEquals("0.0%", formatChangePercent(0.04))
        assertEquals("0.0%", formatChangePercent(-0.04))
        assertEquals("不可得", formatChangePercent(Double.NaN))
        assertEquals("不可得", formatChangePercent(Double.POSITIVE_INFINITY))
        assertEquals("不可得", formatChangePercent(Double.NEGATIVE_INFINITY))
    }

    @Test
    fun widgetChangePercentIsWholeNumbersWithTheSameSigns() {
        assertEquals("+12%", formatWidgetChangePercent(12.4))
        assertEquals("−5%", formatWidgetChangePercent(-4.5))
        assertEquals("0%", formatWidgetChangePercent(-0.4))
        assertEquals("不可得", formatWidgetChangePercent(Double.NaN))
        assertEquals("+12%", formatDeltaPercent(12.4))
    }

    @Test
    fun sharesRoundToWholePercentOnEverySurface() {
        assertEquals("50%", formatSharePercent(49.5))
        assertEquals("0%", formatSharePercent(0.4))
        assertEquals("33%", formatSharePercent(100.0 / 3))
        assertEquals("不可得", formatSharePercent(Double.NaN))
        assertEquals("50%", modelCostShareLabel(costMasked = false, sharePercent = 49.5))
        assertEquals("占比不可得", modelCostShareLabel(costMasked = false, sharePercent = Double.NaN))
    }

    // endregion
}
