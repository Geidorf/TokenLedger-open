package com.jeidorf.tokenledger.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.system.measureTimeMillis

/**
 * Milestone 2 Remediation Adversarial Challenge & Stress Tests.
 *
 * Thoroughly stress-tests:
 * 1. filterModelsForTool against adversarial scenarios:
 *    - Tool with empty models map (must not leak fallback)
 *    - Tool with models not present in allModels (must not leak fallback)
 *    - Partial model overlap (must return only matching models, in allModels order)
 *    - allModels empty with null and non-null tool
 *    - Null selectedTool (must return visible fallback)
 *    - Large model list (1000 models) correctness & performance benchmark (< 16ms)
 *    - Unusual model names (whitespace, unicode, special chars, case sensitivity)
 * 2. Regex date/time matchers (TREND_DATE_REGEX, TREND_MONTH_REGEX, TREND_ISO_REGEX, SCRUB_HOUR_REGEX):
 *    - Direct inspection of private regex constants via reflection
 *    - Edge years: 0000 and 9999
 *    - Invalid months and days (e.g. month 00, 99, 13)
 *    - Extra whitespace (leading, trailing, internal)
 *    - Hours 00..23 wrap-around (23:00 -> 00:00) and out-of-range hours (24:00, 99:00)
 *    - ReDoS / catastrophic backtracking immunity with long pathological inputs
 */
class LedgerM2RemediationChallengeTest {

    // =========================================================================
    // Reflection Helper for Private Regex Constants in LedgerUiLogicKt
    // =========================================================================

    private fun getPrivateRegex(fieldName: String): Regex {
        val clazz = Class.forName("com.jeidorf.tokenledger.mobile.LedgerUiLogicKt")
        val field = clazz.getDeclaredField(fieldName)
        field.isAccessible = true
        val obj = field.get(null)
        assertNotNull("Field $fieldName should not be null", obj)
        return obj as Regex
    }

    private fun createModel(name: String, total: Long = 100L, requests: Long = 1L): ModelStat =
        ModelStat(
            name = name,
            total = total,
            requests = requests,
            input = total / 2,
            output = total - total / 2,
            cached = 0L,
            cost = 0.002
        )

    private fun createTool(name: String, models: Map<String, Long> = emptyMap()): ToolStat =
        ToolStat(
            name = name,
            input = 100L,
            output = 100L,
            cached = 0L,
            total = 200L,
            cost = 0.005,
            requests = 2L,
            models = models
        )

    // =========================================================================
    // 1. filterModelsForTool Adversarial Challenge Tests
    // =========================================================================

    @Test
    fun filterModelsForTool_toolWithEmptyModelsMap_returnsEmptyListWithoutFallbackLeak() {
        val allModels = listOf(
            createModel("gpt-4o", total = 1000),
            createModel("claude-3-5-sonnet", total = 800),
            createModel("deepseek-chat", total = 500)
        )
        val fallback = listOf(allModels[0], allModels[1])

        // Tool with explicitly empty models map
        val toolWithEmptyModels = createTool("empty-tool", models = emptyMap())

        val result = filterModelsForTool(
            allModels = allModels,
            visibleModelsFallback = fallback,
            selectedTool = toolWithEmptyModels
        )

        // Must return empty list, NOT leaking foreign models from fallback
        assertTrue("Expected empty list when tool has empty models map", result.isEmpty())
        assertFalse("Must NOT leak fallback models", result.contains(allModels[0]))
    }

    @Test
    fun filterModelsForTool_toolWithModelsNotPresentInAllModels_returnsEmptyListWithoutFallbackLeak() {
        val allModels = listOf(
            createModel("gpt-4o", total = 1000),
            createModel("claude-3-5-sonnet", total = 800)
        )
        val fallback = allModels

        // Tool has models that do not exist anywhere in allModels
        val toolWithAlienModels = createTool(
            "alien-tool",
            models = mapOf(
                "phantom-model-alpha" to 500L,
                "phantom-model-beta" to 300L
            )
        )

        val result = filterModelsForTool(
            allModels = allModels,
            visibleModelsFallback = fallback,
            selectedTool = toolWithAlienModels
        )

        assertTrue("Expected empty list when tool models are not present in allModels", result.isEmpty())
        assertFalse("Must not leak fallback models", result.any { it.name == "gpt-4o" })
    }

    @Test
    fun filterModelsForTool_toolWithPartialOverlap_returnsOnlyMatchingModelsPreservingOrder() {
        val allModels = listOf(
            createModel("rank-1-gpt-4o", total = 10000),
            createModel("rank-2-claude-3-5-sonnet", total = 5000),
            createModel("rank-3-gemini-1.5-pro", total = 3000),
            createModel("rank-4-deepseek-chat", total = 2000),
            createModel("rank-5-qwen-max", total = 1000),
            createModel("rank-6-claude-3-haiku", total = 500),
            createModel("rank-7-mistral-large", total = 200),
            createModel("rank-8-llama-3-70b", total = 100)
        )
        // Fallback is top 2
        val fallback = allModels.take(2)

        // Tool uses rank 2, rank 6, plus an unknown model
        val tool = createTool(
            "cursor",
            models = mapOf(
                "rank-6-claude-3-haiku" to 500L,
                "rank-2-claude-3-5-sonnet" to 5000L,
                "untracked-model-xyz" to 999L
            )
        )

        val result = filterModelsForTool(
            allModels = allModels,
            visibleModelsFallback = fallback,
            selectedTool = tool
        )

        // Result should include rank 2 and rank 6 (even though rank 6 is outside top 2 fallback),
        // but exclude untracked-model-xyz, and preserve allModels order (rank 2 then rank 6)
        assertEquals(2, result.size)
        assertEquals("rank-2-claude-3-5-sonnet", result[0].name)
        assertEquals("rank-6-claude-3-haiku", result[1].name)
    }

    @Test
    fun filterModelsForTool_allModelsEmpty_whenToolNull_returnsFallback() {
        val allModels = emptyList<ModelStat>()
        val fallback = listOf(createModel("cached-top-model", total = 50))

        val result = filterModelsForTool(
            allModels = allModels,
            visibleModelsFallback = fallback,
            selectedTool = null
        )

        assertSame("When selectedTool is null, returns fallback directly", fallback, result)
        assertEquals(1, result.size)
        assertEquals("cached-top-model", result[0].name)
    }

    @Test
    fun filterModelsForTool_allModelsEmpty_whenToolNotNull_returnsEmpty() {
        val allModels = emptyList<ModelStat>()
        val fallback = listOf(createModel("cached-top-model", total = 50))
        val tool = createTool("some-tool", models = mapOf("model-a" to 10L))

        val result = filterModelsForTool(
            allModels = allModels,
            visibleModelsFallback = fallback,
            selectedTool = tool
        )

        assertTrue("When allModels is empty and tool is selected, result must be empty", result.isEmpty())
    }

    @Test
    fun filterModelsForTool_nullSelectedTool_returnsFallbackDirectly() {
        val allModels = listOf(
            createModel("model-1"),
            createModel("model-2"),
            createModel("model-3")
        )
        val fallback = listOf(allModels[0])

        val result = filterModelsForTool(
            allModels = allModels,
            visibleModelsFallback = fallback,
            selectedTool = null
        )

        assertSame(fallback, result)
        assertEquals(1, result.size)
        assertEquals("model-1", result[0].name)
    }

    @Test
    fun filterModelsForTool_largeModelList_1000Models_filtersCorrectlyAndPreservesOrder() {
        // Generate 1000 models
        val allModels = (0 until 1000).map { i ->
            createModel(name = String.format("model-%04d", i), total = (100000 - i).toLong())
        }
        val fallback = allModels.take(8)

        // Select 100 models: every 10th model (model-0000, model-0010, ..., model-0990)
        val toolModelMap = (0 until 1000 step 10).associate { i ->
            String.format("model-%04d", i) to (1000L + i)
        }
        val tool = createTool("massive-tool", models = toolModelMap)

        val result = filterModelsForTool(
            allModels = allModels,
            visibleModelsFallback = fallback,
            selectedTool = tool
        )

        assertEquals(100, result.size)
        // Verify order is preserved from allModels
        for (j in 0 until 100) {
            val expectedName = String.format("model-%04d", j * 10)
            assertEquals(expectedName, result[j].name)
        }
    }

    @Test
    fun filterModelsForTool_largeModelList_1000Models_performanceBenchmark() {
        val allModels = (0 until 1000).map { i ->
            createModel(name = "model-$i", total = 1000L)
        }
        val fallback = allModels.take(8)
        val toolModels = (200 until 350).associate { i -> "model-$i" to 100L }
        val tool = createTool("perf-tool", models = toolModels)

        // Warm up JVM
        repeat(50) {
            filterModelsForTool(allModels, fallback, tool)
        }

        // Benchmark 1000 filtering iterations
        val iterations = 1000
        val elapsedMs = measureTimeMillis {
            repeat(iterations) {
                val res = filterModelsForTool(allModels, fallback, tool)
                assertEquals(150, res.size)
            }
        }

        // 1000 iterations over 1000 items should comfortably take < 500ms (< 0.5ms per filter pass, well within 16ms frame budget)
        assertTrue(
            "1000 iterations should take < 500ms, actual: ${elapsedMs}ms",
            elapsedMs < 500
        )
    }

    @Test
    fun filterModelsForTool_specialCharactersAndCaseSensitivity() {
        val allModels = listOf(
            createModel("gpt-4o"),
            createModel("GPT-4O"), // Different case
            createModel("openai/chatgpt-4o-latest"),
            createModel("deepseek-ai/DeepSeek-V3"),
            createModel("模型-中文-01"),
            createModel("🤖/robot-agent"),
            createModel("") // empty name
        )
        val fallback = emptyList<ModelStat>()

        // Tool with exact case-sensitive match
        val toolLowercase = createTool("lower", models = mapOf("gpt-4o" to 10L))
        val resultLower = filterModelsForTool(allModels, fallback, toolLowercase)
        assertEquals(1, resultLower.size)
        assertEquals("gpt-4o", resultLower[0].name)

        // Tool with uppercase match
        val toolUppercase = createTool("upper", models = mapOf("GPT-4O" to 20L))
        val resultUpper = filterModelsForTool(allModels, fallback, toolUppercase)
        assertEquals(1, resultUpper.size)
        assertEquals("GPT-4O", resultUpper[0].name)

        // Tool with unicode and emojis
        val toolUnicode = createTool(
            "unicode",
            models = mapOf(
                "模型-中文-01" to 50L,
                "🤖/robot-agent" to 60L
            )
        )
        val resultUnicode = filterModelsForTool(allModels, fallback, toolUnicode)
        assertEquals(2, resultUnicode.size)
        assertEquals("模型-中文-01", resultUnicode[0].name)
        assertEquals("🤖/robot-agent", resultUnicode[1].name)
    }

    // =========================================================================
    // 2. Regex Date/Time Matchers Adversarial Challenge Tests
    // =========================================================================

    @Test
    fun regexConstants_existViaReflectionAndMatchExpectedPatterns() {
        val scrubHourRegex = getPrivateRegex("SCRUB_HOUR_REGEX")
        val trendDateRegex = getPrivateRegex("TREND_DATE_REGEX")
        val trendMonthRegex = getPrivateRegex("TREND_MONTH_REGEX")
        val trendIsoRegex = getPrivateRegex("TREND_ISO_REGEX")

        assertEquals("^\\d{1,2}:00$", scrubHourRegex.pattern)
        assertEquals("^\\d{4}-\\d{2}-\\d{2}$", trendDateRegex.pattern)
        assertEquals("^\\d{4}-\\d{2}$", trendMonthRegex.pattern)
        assertEquals("^\\d{4}-(\\d{2}-\\d{2})[T ](\\d{2}:\\d{2})", trendIsoRegex.pattern)
    }

    // --- TREND_DATE_REGEX & formatTrendAnchorLabel ---

    @Test
    fun trendDateRegex_andFormatTrendAnchorLabel_year0000And9999() {
        val dateRegex = getPrivateRegex("TREND_DATE_REGEX")

        // Year 0000 boundary
        assertTrue(dateRegex.matches("0000-01-01"))
        assertTrue(dateRegex.matches("0000-12-31"))
        assertEquals("01-01", formatTrendAnchorLabel("0000-01-01"))
        assertEquals("12-31", formatTrendAnchorLabel("0000-12-31"))

        // Year 9999 boundary
        assertTrue(dateRegex.matches("9999-01-01"))
        assertTrue(dateRegex.matches("9999-12-31"))
        assertEquals("01-01", formatTrendAnchorLabel("9999-01-01"))
        assertEquals("12-31", formatTrendAnchorLabel("9999-12-31"))

        // 3-digit and 5-digit years must NOT match
        assertFalse(dateRegex.matches("999-01-01"))
        assertFalse(dateRegex.matches("10000-01-01"))
        assertEquals("999-01-01", formatTrendAnchorLabel("999-01-01"))
        assertEquals("10000-01-01", formatTrendAnchorLabel("10000-01-01"))
    }

    @Test
    fun trendDateRegex_andFormatTrendAnchorLabel_invalidMonthsAndDays() {
        val dateRegex = getPrivateRegex("TREND_DATE_REGEX")

        // Month 00, Day 00 (syntactically 2 digits, semantically invalid)
        assertTrue(dateRegex.matches("2026-00-00"))
        assertEquals("00-00", formatTrendAnchorLabel("2026-00-00"))

        // Month 99, Day 99
        assertTrue(dateRegex.matches("2026-99-99"))
        assertEquals("99-99", formatTrendAnchorLabel("2026-99-99"))

        // Month 13, Day 32
        assertTrue(dateRegex.matches("2026-13-32"))
        assertEquals("13-32", formatTrendAnchorLabel("2026-13-32"))

        // Single digit month/day (must NOT match)
        assertFalse(dateRegex.matches("2026-1-1"))
        assertFalse(dateRegex.matches("2026-01-1"))
        assertFalse(dateRegex.matches("2026-1-01"))
        assertEquals("2026-1-1", formatTrendAnchorLabel("2026-1-1"))
    }

    @Test
    fun trendDateRegex_andFormatTrendAnchorLabel_extraWhitespace() {
        val dateRegex = getPrivateRegex("TREND_DATE_REGEX")

        // Raw string with whitespace does NOT match raw regex (anchored)
        assertFalse(dateRegex.matches("  2026-09-04  "))
        assertFalse(dateRegex.matches("\t2026-09-04\n"))

        // BUT formatTrendAnchorLabel trims first, so it succeeds cleanly
        assertEquals("09-04", formatTrendAnchorLabel("  2026-09-04  "))
        assertEquals("09-04", formatTrendAnchorLabel("\t\n2026-09-04\r\n"))

        // Internal whitespace must NOT match and must safely fall through
        assertFalse(dateRegex.matches("2026 - 09 - 04"))
        assertFalse(dateRegex.matches("2026- 09-04"))
        assertFalse(dateRegex.matches("2026-09 -04"))
        assertEquals("2026 - 09 - 04", formatTrendAnchorLabel("2026 - 09 - 04"))
        assertEquals("2026- 09-04", formatTrendAnchorLabel("2026- 09-04"))
    }

    // --- TREND_MONTH_REGEX & formatTrendAnchorLabel ---

    @Test
    fun trendMonthRegex_andFormatTrendAnchorLabel_year0000And9999() {
        val monthRegex = getPrivateRegex("TREND_MONTH_REGEX")

        assertTrue(monthRegex.matches("0000-01"))
        assertTrue(monthRegex.matches("0000-12"))
        assertEquals("01", formatTrendAnchorLabel("0000-01"))
        assertEquals("12", formatTrendAnchorLabel("0000-12"))

        assertTrue(monthRegex.matches("9999-01"))
        assertTrue(monthRegex.matches("9999-12"))
        assertEquals("01", formatTrendAnchorLabel("9999-01"))
        assertEquals("12", formatTrendAnchorLabel("9999-12"))

        assertFalse(monthRegex.matches("999-01"))
        assertFalse(monthRegex.matches("10000-01"))
    }

    @Test
    fun trendMonthRegex_andFormatTrendAnchorLabel_invalidMonths() {
        val monthRegex = getPrivateRegex("TREND_MONTH_REGEX")

        // 2-digit invalid months
        assertTrue(monthRegex.matches("2026-00"))
        assertTrue(monthRegex.matches("2026-99"))
        assertTrue(monthRegex.matches("2026-13"))
        assertEquals("00", formatTrendAnchorLabel("2026-00"))
        assertEquals("99", formatTrendAnchorLabel("2026-99"))
        assertEquals("13", formatTrendAnchorLabel("2026-13"))

        // 1-digit or 3-digit months do NOT match
        assertFalse(monthRegex.matches("2026-9"))
        assertFalse(monthRegex.matches("2026-123"))
        assertEquals("2026-9", formatTrendAnchorLabel("2026-9"))
    }

    @Test
    fun trendMonthRegex_andFormatTrendAnchorLabel_extraWhitespace() {
        assertEquals("07", formatTrendAnchorLabel("   2026-07   "))
        assertEquals("11", formatTrendAnchorLabel("\n2026-11\t"))
        assertEquals("2026 - 07", formatTrendAnchorLabel("2026 - 07"))
    }

    // --- TREND_ISO_REGEX & formatTrendAnchorLabel ---

    @Test
    fun trendIsoRegex_andFormatTrendAnchorLabel_year0000And9999() {
        val isoRegex = getPrivateRegex("TREND_ISO_REGEX")

        assertTrue(isoRegex.containsMatchIn("0000-01-01T00:00:00Z"))
        assertEquals("01-01 00:00", formatTrendAnchorLabel("0000-01-01T00:00:00Z"))

        assertTrue(isoRegex.containsMatchIn("9999-12-31T23:59:59.999Z"))
        assertEquals("12-31 23:59", formatTrendAnchorLabel("9999-12-31T23:59:59.999Z"))

        // With space separator instead of T
        assertTrue(isoRegex.containsMatchIn("9999-12-31 23:59:59"))
        assertEquals("12-31 23:59", formatTrendAnchorLabel("9999-12-31 23:59:59"))
    }

    @Test
    fun trendIsoRegex_andFormatTrendAnchorLabel_invalidMonthsAndHours() {
        val isoRegex = getPrivateRegex("TREND_ISO_REGEX")

        assertTrue(isoRegex.containsMatchIn("2026-00-00T00:00:00Z"))
        assertEquals("00-00 00:00", formatTrendAnchorLabel("2026-00-00T00:00:00Z"))

        assertTrue(isoRegex.containsMatchIn("2026-99-99T99:99:99Z"))
        assertEquals("99-99 99:99", formatTrendAnchorLabel("2026-99-99T99:99:99Z"))

        // Space separator with invalid hour
        assertTrue(isoRegex.containsMatchIn("2026-13-45 88:77"))
        assertEquals("13-45 88:77", formatTrendAnchorLabel("2026-13-45 88:77"))
    }

    @Test
    fun trendIsoRegex_andFormatTrendAnchorLabel_extraWhitespace() {
        // Leading/trailing whitespace trimmed
        assertEquals("09-04 15:30", formatTrendAnchorLabel("   2026-09-04T15:30:00Z   "))
        assertEquals("09-04 15:30", formatTrendAnchorLabel("\t\n2026-09-04 15:30:00\r\n"))

        // Multiple spaces between date and time (fails single [T ] delimiter)
        assertEquals("2026-09-04   15:30:00", formatTrendAnchorLabel("2026-09-04   15:30:00"))
    }

    // --- SCRUB_HOUR_REGEX & formatScrubBucketLabel ---

    @Test
    fun scrubHourRegex_andFormatScrubBucketLabel_validHours0To23() {
        val hourRegex = getPrivateRegex("SCRUB_HOUR_REGEX")

        // Test single-digit hours: "0:00" through "9:00"
        for (h in 0..9) {
            val single = "$h:00"
            assertTrue("Expected $single to match SCRUB_HOUR_REGEX", hourRegex.matches(single))
            val expectedNext = (h + 1) % 24
            val expected = String.format(java.util.Locale.US, "%02d:00 - %02d:00", h, expectedNext)
            assertEquals(expected, formatScrubBucketLabel(single))
        }

        // Test two-digit hours: "00:00" through "23:00"
        for (h in 0..23) {
            val double = String.format(java.util.Locale.US, "%02d:00", h)
            assertTrue("Expected $double to match SCRUB_HOUR_REGEX", hourRegex.matches(double))
            val expectedNext = (h + 1) % 24
            val expected = String.format(java.util.Locale.US, "%02d:00 - %02d:00", h, expectedNext)
            assertEquals(expected, formatScrubBucketLabel(double))
        }

        // Wrap around at midnight specifically
        assertEquals("23:00 - 00:00", formatScrubBucketLabel("23:00"))
    }

    @Test
    fun scrubHourRegex_andFormatScrubBucketLabel_boundaryAndInvalidHours() {
        val hourRegex = getPrivateRegex("SCRUB_HOUR_REGEX")

        // Hour 24 matches regex ^\d{1,2}:00$, but 24 is NOT in 0..23
        assertTrue(hourRegex.matches("24:00"))
        // formatScrubBucketLabel must gracefully return "24:00" without throwing
        assertEquals("24:00", formatScrubBucketLabel("24:00"))

        // Hour 25, 99 match regex but fail 0..23 range check
        assertTrue(hourRegex.matches("25:00"))
        assertTrue(hourRegex.matches("99:00"))
        assertEquals("25:00", formatScrubBucketLabel("25:00"))
        assertEquals("99:00", formatScrubBucketLabel("99:00"))

        // 3-digit hour does NOT match regex
        assertFalse(hourRegex.matches("100:00"))
        assertEquals("100:00", formatScrubBucketLabel("100:00"))

        // Negative hour does NOT match regex
        assertFalse(hourRegex.matches("-1:00"))
        assertEquals("-1:00", formatScrubBucketLabel("-1:00"))

        // Non-:00 minutes do NOT match regex
        assertFalse(hourRegex.matches("09:30"))
        assertFalse(hourRegex.matches("09:15"))
        assertEquals("09:30", formatScrubBucketLabel("09:30"))
    }

    @Test
    fun scrubHourRegex_andFormatScrubBucketLabel_extraWhitespace() {
        // Leading and trailing whitespace is trimmed
        assertEquals("09:00 - 10:00", formatScrubBucketLabel("  09:00  "))
        assertEquals("23:00 - 00:00", formatScrubBucketLabel("\t23:00\n"))
        assertEquals("00:00 - 01:00", formatScrubBucketLabel(" 0:00 \r"))

        // Internal whitespace fails regex and falls through safely
        assertEquals("09 : 00", formatScrubBucketLabel("09 : 00"))
        assertEquals("9 :00", formatScrubBucketLabel("9 :00"))

        // Non-hour string inputs
        assertEquals("2026-09-04", formatScrubBucketLabel("2026-09-04"))
        assertEquals("custom_bucket", formatScrubBucketLabel("custom_bucket"))
        assertEquals("", formatScrubBucketLabel(""))
        assertEquals("", formatScrubBucketLabel("   "))
    }

    // --- ReDoS Immunity Stress Test ---

    @Test
    fun regexMatchers_reDosImmunityStressTest() {
        val scrubHourRegex = getPrivateRegex("SCRUB_HOUR_REGEX")
        val trendDateRegex = getPrivateRegex("TREND_DATE_REGEX")
        val trendMonthRegex = getPrivateRegex("TREND_MONTH_REGEX")
        val trendIsoRegex = getPrivateRegex("TREND_ISO_REGEX")

        val pathologicalHour = "9".repeat(10000) + ":00"
        val pathologicalDate = "2026-".repeat(2000) + "09-04"
        val pathologicalIso = "2026-09-04T" + "12:".repeat(2000) + "00"

        val elapsedMs = measureTimeMillis {
            assertFalse(scrubHourRegex.matches(pathologicalHour))
            assertFalse(trendDateRegex.matches(pathologicalDate))
            assertFalse(trendMonthRegex.matches(pathologicalDate))
            assertFalse(trendIsoRegex.containsMatchIn("9".repeat(10000)))

            // Check formatters survive pathological inputs instantly
            assertEquals(pathologicalHour, formatScrubBucketLabel(pathologicalHour))
            assertEquals(pathologicalDate, formatTrendAnchorLabel(pathologicalDate))
        }

        assertTrue("Pathological regex matching should execute in < 200ms, actual: ${elapsedMs}ms", elapsedMs < 200)
    }
}
