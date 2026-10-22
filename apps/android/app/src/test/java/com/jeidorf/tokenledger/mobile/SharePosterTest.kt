package com.jeidorf.tokenledger.mobile

import android.content.ActivityNotFoundException
import android.content.Intent
import java.io.File
import java.nio.file.Files
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SharePosterTest {
    private val generatedAt = Instant.parse("2026-07-15T04:41:00Z")

    private fun sourceFile(path: String): File =
        listOf(File(path), File("app", path), File("apps/android/app", path)).firstOrNull { it.isFile }
            ?: error("找不到 $path（当前目录 ${File(".").absolutePath}）")

    @Test
    fun layoutKeysStayStableAndEachLayoutKeepsADifferentStructure() {
        assertEquals(
            listOf("scorecard", "journal", "achievement", "receipt", "signal"),
            ShareLayoutKey.entries.map { it.stableKey }
        )
        val signatures = ShareLayoutKey.entries.map(::shareLayoutSignature)
        assertEquals(ShareLayoutKey.entries.size, signatures.distinct().size)
        assertTrue(signatures.all { it.size >= 4 })
        assertEquals(1080, SHARE_POSTER_WIDTH)
        assertEquals(1920, SHARE_POSTER_HEIGHT)
        assertEquals(
            SHARE_POSTER_WIDTH * 16,
            SHARE_POSTER_HEIGHT * 9
        )
    }

    @Test
    fun posterContractsKeepBrandFootersUprightSignalLabelsAndLongHeroFormatting() {
        val signatures = ShareLayoutKey.entries.associateWith(::shareLayoutSignature)

        assertTrue(signatures.values.all { "footer-brand" in it })
        assertTrue("lucide-metric-icons" in requireNotNull(signatures[ShareLayoutKey.Scorecard]))
        assertTrue("upright-vertical-input-output" in requireNotNull(signatures[ShareLayoutKey.Signal]))
        assertEquals("999.50M", formatCompactTokens(999_500_000L))
        assertEquals("1.00B", formatCompactTokens(999_999_999L))
    }

    @Test
    fun posterBrandUsesSharedVectorPathWithoutLauncherBitmapLoading() {
        val source = sourceFile("src/main/java/com/jeidorf/tokenledger/mobile/SharePosterRenderer.kt").readText()

        assertTrue(source.contains("PathParser.createPathFromPathData(TokenLedgerBrand.PATH_DATA)"))
        assertTrue(source.contains("TokenLedgerBrand.STROKE_WIDTH"))
        assertTrue(source.contains("size / TokenLedgerBrand.SIZE"))
        assertFalse(source.contains("BitmapFactory"))
        assertFalse(source.contains("R.mipmap.ic_launcher"))
        assertFalse(source.contains("val logo: Bitmap"))
        assertFalse(source.contains("accentColor"))
    }

    @Test
    fun hourlyPosterPointsUseOneTimeLabelPerCard() {
        val hourly = SharePoint("11:00", "11:00", null, 1L, 1L)
        val daily = SharePoint("2026-07-15", "7/15", "周二", 1L, 1L)

        assertTrue(isPosterHourPoint(hourly))
        assertFalse(isPosterHourPoint(daily))
        assertEquals("11:00" to null, receiptPointLabels(hourly))
        assertEquals("周二" to "7/15", receiptPointLabels(daily))
    }

    @Test
    fun scorecardTrendUsesOneBoundedPointGroupAndXMappingForLabels() {
        fun point(index: Int) = SharePoint(
            bucket = "2026-07-${index.toString().padStart(2, '0')}",
            dateLabel = "7/$index",
            weekdayLabel = "周一",
            tokens = index.toLong(),
            requests = 1L
        )

        listOf(1, 3, 7, 9).forEach { sourceCount ->
            val visible = scorecardTrendPoints((1..sourceCount).map(::point))
            val xs = scorecardTrendXPositions(visible.size)
            assertEquals(minOf(sourceCount, 7), visible.size)
            assertEquals(visible.size, xs.size)
            assertTrue(xs.all { it in 84f..996f })
            if (visible.size == 1) {
                assertEquals(540f, xs.single(), 0.001f)
            } else {
                assertEquals(84f, xs.first(), 0.001f)
                assertEquals(996f, xs.last(), 0.001f)
                assertTrue(xs.zipWithNext().all { (left, right) -> left < right })
            }
            if (sourceCount > 7) assertEquals("2026-07-03", visible.first().bucket)
        }
    }

    @Test
    fun summaryUsesEffectiveTokensAndOnlyShowsProvenComparison() {
        listOf(RangeKey.Today, RangeKey.Week, RangeKey.Month).forEach { range ->
            val stats = requireNotNull(ledgerSnapshotFixture(range).data)
            val result = buildShareSummary(stats, range, costMasked = false, generatedAt)

            assertEquals(stats.summary.inputTokens + stats.summary.outputTokens, result.effectiveTokens)
            assertEquals(stats.comparison?.delta?.tokens?.percent, result.deltaPercent)
            assertEquals(stats.summary.totalRequests, result.totalRequests)
            assertTrue(result.points.isNotEmpty())
        }

        listOf(RangeKey.Year, RangeKey.All).forEach { range ->
            val stats = requireNotNull(ledgerSnapshotFixture(range).data)
            val result = buildShareSummary(stats, range, costMasked = false, generatedAt)
            assertNull(result.deltaPercent)
        }
    }

    @Test
    fun weeklyActivityPrefersTheWindowSeriesOverAnOutOfSyncHeatmap() {
        val stats = requireNotNull(ledgerSnapshotFixture(RangeKey.Week).data)

        // The fixture deliberately keeps the broad calendar independent from the comparison
        // window: the comparison has three active days while the heatmap has only two. A share
        // summary must follow the already-filtered window series instead of erasing one day.
        val result = buildShareSummary(stats, RangeKey.Week, costMasked = false, generatedAt)

        assertEquals(3, result.activeDays)
        assertEquals(3, result.longestStreakDays)
        assertEquals(450_000L, result.peakTokens)
    }

    @Test
    fun aSnapshotCannotBeRelabeledAsAnotherShareRange() {
        val week = requireNotNull(ledgerSnapshotFixture(RangeKey.Week).data)
        assertTrue(week.matchesShareRange(RangeKey.Week))
        assertFalse(week.matchesShareRange(RangeKey.Month))
        assertFalse(week.copy(meta = null).matchesShareRange(RangeKey.Week))
    }

    @Test
    fun sharePeriodSelectorOnlyOffersRangesThatNeedNoDateBounds() {
        assertEquals(
            listOf(RangeKey.Today, RangeKey.Week, RangeKey.Month, RangeKey.Year, RangeKey.All),
            SHARE_PERIOD_RANGES
        )
        assertFalse(RangeKey.Custom in SHARE_PERIOD_RANGES)
    }

    @Test
    fun customShareRequiresTheLoadedSnapshotToEchoCompleteDateBounds() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Today).data)
        val meta = requireNotNull(source.meta)
        val custom = source.copy(
            meta = meta.copy(
                range = "custom",
                query = (meta.query ?: StatsQueryEcho()).copy(
                    range = "custom",
                    timezone = "Asia/Shanghai",
                    start = "2026-07-14",
                    end = "2026-07-14"
                )
            )
        )

        assertTrue(custom.matchesShareRange(RangeKey.Custom))
        assertFalse(
            custom.copy(meta = custom.meta?.copy(query = custom.meta.query?.copy(start = null)))
                .matchesShareRange(RangeKey.Custom)
        )
        assertFalse(
            custom.copy(meta = custom.meta?.copy(query = custom.meta.query?.copy(end = "2026-07-13")))
                .matchesShareRange(RangeKey.Custom)
        )
    }

    @Test
    fun historicalCustomDayKeepsTheFullHourlySeries() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Today).data)
        val meta = requireNotNull(source.meta)
        val comparison = requireNotNull(source.comparison)
        val custom = source.copy(
            meta = meta.copy(
                range = "custom",
                query = (meta.query ?: StatsQueryEcho()).copy(
                    range = "custom",
                    timezone = "Asia/Shanghai",
                    start = "2026-07-14",
                    end = "2026-07-14"
                )
            ),
            comparison = comparison.copy(
                window = comparison.window.copy(
                    kind = "periodOverPeriod",
                    currentStart = "2026-07-14T00:00:00",
                    currentEnd = "2026-07-14T23:59:59"
                ),
                current = comparison.current.copy(
                    series = listOf(
                        ComparisonSeriesPoint("22:00", 10, 1, 0.0),
                        ComparisonSeriesPoint("23:00", 20, 1, 0.0)
                    )
                )
            )
        )

        val summary = buildShareSummary(custom, RangeKey.Custom, costMasked = false, generatedAt)

        assertEquals(listOf("22:00", "23:00"), summary.points.map { it.bucket })
        assertFalse(summary.points.last().inProgress)
        assertEquals("2026年7月14日—2026年7月14日", summary.periodLabel)
    }

    @Test
    fun allRangeUsesMilestoneCopyAndPrivacyProjectionHidesMoney() {
        val stats = requireNotNull(ledgerSnapshotFixture(RangeKey.All).data)
        val publicSummary = buildShareSummary(stats, RangeKey.All, costMasked = false, generatedAt)
        val maskedSummary = buildShareSummary(stats, RangeKey.All, costMasked = true, generatedAt)

        assertEquals("AI 协作里程碑", maskedSummary.title)
        assertTrue(publicSummary.costCny != null)
        assertNull(maskedSummary.costCny)
        assertNull(maskedSummary.netSavedCostCny)
        assertTrue(maskedSummary.costMasked)
    }

    /** 一份内部一致的 cacheSavings：writePremiumUsd 按 net = read − premium 反推，始终非负。 */
    private fun cacheSavingsFixture(
        netSavedUsd: Double,
        fallbackPricedReadTokens: Long = 0,
        fallbackPricedWriteTokens: Long = 0
    ): CacheSavings {
        val readSavedUsd = maxOf(netSavedUsd, 0.0) + 1.0
        return CacheSavings(
            readSavedUsd = readSavedUsd,
            writePremiumUsd = readSavedUsd - netSavedUsd,
            netSavedUsd = netSavedUsd,
            fallbackPricedReadTokens = fallbackPricedReadTokens,
            fallbackPricedWriteTokens = fallbackPricedWriteTokens,
            priceBasis = CacheSavingsPriceBasis.LocalPrices
        )
    }

    private fun StatsData.withDeclaredCacheSavings(summary: Summary): StatsData = copy(
        summary = summary,
        capabilities = capabilities.copy(cacheSavings = true)
    )

    @Test
    fun positiveNetCacheSavingsIsShownAsTheNetSavedCost() {
        // root 2026-09-25 18:50 决定 / 用户决定 Q3、Q7：海报只画「缓存净节省」，且要求 > 0。
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Month).data)
        val stats = source.withDeclaredCacheSavings(source.summary.copy(cacheSavings = cacheSavingsFixture(3.5)))

        val result = buildShareSummary(stats, RangeKey.Month, costMasked = false, generatedAt, cnyExchangeRate = 7.2)

        assertEquals(3.5 * 7.2, requireNotNull(result.netSavedCostCny), 1e-9)
    }

    @Test
    fun negativeNetCacheSavingsIsNeverShown() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Month).data)
        val stats = source.withDeclaredCacheSavings(source.summary.copy(cacheSavings = cacheSavingsFixture(-1.2)))

        val result = buildShareSummary(stats, RangeKey.Month, costMasked = false, generatedAt, cnyExchangeRate = 7.2)

        assertNull(result.netSavedCostCny)
    }

    @Test
    fun grossCacheSavedIsNeverDrawnWhenTheNetObjectIsAbsent() {
        // 证明「从不画毛值」：旧的 cacheSavedUsd（毛值）即便 > 0，只要新的 cacheSavings
        // 对象不存在（不可得，或者是云端 B 期上线前的 Android 响应本身就没有这个字段），
        // 海报也必须不显示——不能用毛值退回充数、也不能把「不可得」显示成任何数字。
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Month).data)
        val stats = source.withDeclaredCacheSavings(
            source.summary.copy(cacheSavedUsd = 42.0, cacheSavings = null)
        )

        val result = buildShareSummary(stats, RangeKey.Month, costMasked = false, generatedAt, cnyExchangeRate = 7.2)

        assertNull(result.netSavedCostCny)
    }

    @Test
    fun maskedCostsHideNetCacheSavingsEvenWhenPositive() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Month).data)
        val stats = source.withDeclaredCacheSavings(source.summary.copy(cacheSavings = cacheSavingsFixture(3.5)))

        val result = buildShareSummary(stats, RangeKey.Month, costMasked = true, generatedAt, cnyExchangeRate = 7.2)

        assertNull(result.netSavedCostCny)
    }

    @Test
    fun exactlyZeroNetCacheSavingsIsNeverShown() {
        // root R-36 P3-4：用户决定 Q3 是「净值 > 0 才上图」，已知的 0（无折扣无溢价）不算
        // 「有节省」，必须和负值一样不显示——独立评审的故障注入（> 0.0 改 >= 0.0）证明了
        // 这条边界此前没有测试锁住。
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Month).data)
        val stats = source.withDeclaredCacheSavings(source.summary.copy(cacheSavings = cacheSavingsFixture(0.0)))

        val result = buildShareSummary(stats, RangeKey.Month, costMasked = false, generatedAt, cnyExchangeRate = 7.2)

        assertNull(result.netSavedCostCny)
    }

    @Test
    fun netCacheSavingsWithFallbackPricedReadTokensIsNeverShown() {
        // root R-36 P3-5：用户决定 Q4 要求给含兜底单价的净节省标注「含兜底单价」，但海报的
        // 三格事实位没有空间画这行标注；与其画一个未标注来源的数字，不如整体不画、退回
        // 「记录数」补位。这里覆盖兜底计数落在读取侧的情形。
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Month).data)
        val stats = source.withDeclaredCacheSavings(
            source.summary.copy(
                cacheSavings = cacheSavingsFixture(3.5, fallbackPricedReadTokens = 1)
            )
        )

        val result = buildShareSummary(stats, RangeKey.Month, costMasked = false, generatedAt, cnyExchangeRate = 7.2)

        assertNull(result.netSavedCostCny)
    }

    @Test
    fun netCacheSavingsWithFallbackPricedWriteTokensIsNeverShown() {
        // 同上，覆盖兜底计数落在写入侧的情形——两侧互不代替，OR 条件任一为真都要不画。
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Month).data)
        val stats = source.withDeclaredCacheSavings(
            source.summary.copy(
                cacheSavings = cacheSavingsFixture(3.5, fallbackPricedWriteTokens = 1)
            )
        )

        val result = buildShareSummary(stats, RangeKey.Month, costMasked = false, generatedAt, cnyExchangeRate = 7.2)

        assertNull(result.netSavedCostCny)
    }

    @Test
    fun tinyPositiveNetSavingsRendersAsLessThanOneCentInsteadOfRoundingToZero() {
        // root R-36 P3-2（方案 §3.1）：0 < 净值 < ¥0.01 一律显示「<¥0.01」，不能四舍五入成
        // 「¥0.00」（说「节省」却是 0，自相矛盾）。0.004 四舍五入本会到 ¥0.00，0.009 四舍五入
        // 本会到 ¥0.01——两个方向的边界都必须落在「<¥0.01」，不是只修其中一个。
        // formatNetSavedCny 是顶层函数（不是 SharePosterRenderer 的成员）：见其 KDoc——
        // object 成员在离线 JVM 单测的桩 android.jar 下一碰就连带初始化 Paint 并崩溃。
        assertEquals("<¥0.01", formatNetSavedCny(0.004))
        assertEquals("<¥0.01", formatNetSavedCny(0.009))
    }

    @Test
    fun cacheSavingsObjectWithoutDeclaredCapabilityIsNotConsumed() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Month).data)
        val objectOnly = source.copy(
            summary = source.summary.copy(cacheSavings = cacheSavingsFixture(3.5)),
            capabilities = source.capabilities.copy(cacheSavings = false)
        )

        val result = buildShareSummary(objectOnly, RangeKey.Month, costMasked = false, generatedAt, cnyExchangeRate = 7.2)

        assertNull(result.netSavedCostCny)
    }

    @Test
    fun netSavingsAtOrAboveOneCentRoundsNormally() {
        assertEquals("¥0.01", formatNetSavedCny(0.01))
        assertEquals("¥1.23", formatNetSavedCny(1.234))
        // T10.154 A21：与应用同一个金额格式，带千分位（此前 `¥%.2f` 写成 ¥12345.68）。
        assertEquals("¥12,345.68", formatNetSavedCny(12_345.678))
    }

    @Test
    fun posterNumbersShareTheAppFormatLayer() {
        // A-Q1：海报与应用同一套 Token 写法，先舍入再选单位，不再出现 `1000K`（此前 `%.0fK`）。
        assertEquals("999.5K", formatCompactTokens(999_499L))
        assertEquals("999.5K", formatCompactTokens(999_500L))
        assertEquals("1.00M", formatCompactTokens(999_999L))
        assertEquals("45.0K", formatCompactTokens(45_000L))
        // R-11：变化率与应用同一写法；读不到的变化率整项省略，不画「不可得」也不画 0。
        assertEquals("+8.3%", formatShareDelta(8.34))
        assertEquals("−12%", formatShareDelta(-12.34))
        assertEquals("−5.0%", formatShareDelta(-5.0))
        assertNull(formatShareDelta(null))
        assertNull(formatShareDelta(Double.NaN))
    }

    @Test
    fun signalLowerRibbonKeepsTheOriginalSlotsWhenBothRunsFit() {
        // 短标签（不足 1K 的值）仍用原槽位：输出 1116、缓存 1302，步长 28、字号 26。
        val slots = SignalLowerRibbonLayout(outputTop = 1116f, cacheTop = 1302f, advance = 28f, size = 26f)
        assertEquals(slots, signalLowerRibbonLayout(6, 6))
        assertEquals(slots, signalLowerRibbonLayout(uprightGlyphCount("输出999"), uprightGlyphCount("缓存12")))
    }

    @Test
    fun signalLowerRibbonRunsNeverOverlapOrRunIntoTheFacts() {
        // T10.207：K 一位小数后「输出360.0K」「缓存248.4K」各 8 个字，照原槽位画会两段相叠、缓存段越过光带
        // 末端（1510）压到事实行分隔线（1495 起）。任意长度都要：两段不相叠、最后一字底边不过 1490。
        val outputRun = "输出${formatCompactTokens(360_000L)}"
        val cacheRun = "缓存${formatCompactTokens(248_400L)}"
        assertEquals("输出360.0K", outputRun)
        assertEquals("缓存248.4K", cacheRun)
        assertEquals(
            SignalLowerRibbonLayout(outputTop = 1116f, cacheTop = 1314f, advance = 22f, size = 20f),
            signalLowerRibbonLayout(uprightGlyphCount(outputRun), uprightGlyphCount(cacheRun))
        )
        for (output in 1..12) {
            for (cache in 1..12) {
                val layout = signalLowerRibbonLayout(output, cache)
                val outputBottom = layout.outputTop + (output - 1) * layout.advance + layout.size
                val cacheBottom = layout.cacheTop + (cache - 1) * layout.advance + layout.size
                val case = "输出 $output 字、缓存 $cache 字：$layout"
                assertTrue(case, layout.outputTop == 1116f)
                assertTrue(case, outputBottom < layout.cacheTop)
                // 现实长度（每段不超过 9 个字，即不到 1,000B）至少留出原设计的 20 空白。
                if (output <= 9 && cache <= 9) assertTrue(case, outputBottom + 20f <= layout.cacheTop)
                assertTrue(case, cacheBottom <= 1490f)
                assertTrue(case, layout.size <= 26f && layout.advance - layout.size == 2f)
            }
        }
        // 现实里最长的一对（两段都是 9 个字，如「缓存123.45M」）字号也不小于 17。
        assertTrue(signalLowerRibbonLayout(9, 9).size >= 17f)
    }

    @Test
    fun missingBreakdownsStayUnavailableInsteadOfBeingInvented() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Month).data)
        val legacy = source.copy(
            summary = source.summary.copy(
                cachedTokens = 123_456,
                cacheReadTokens = 0,
                cacheWriteTokens = 0
            ),
            comparison = null,
            trends = emptyList(),
            heatmap = emptyMap()
        )
        val result = buildShareSummary(legacy, RangeKey.Month, costMasked = false, generatedAt)

        assertNull(result.deltaPercent)
        assertNull(result.activeDays)
        assertNull(result.longestStreakDays)
        assertNull(result.peakLabel)
        assertNull(result.cacheReusePercent)
        assertTrue(result.points.isEmpty())
    }

    @Test
    fun losAngelesSourceCutoffWinsAcrossTheUtcMonthBoundary() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Today).data)
        val comparison = requireNotNull(source.comparison).copy(
            window = source.comparison.window.copy(
                timezone = "America/Los_Angeles",
                currentEnd = "2026-09-01T00:30:00Z"
            ),
            current = source.comparison.current.copy(
                series = listOf(
                    ComparisonSeriesPoint("16:00", 10, 1, 0.0),
                    ComparisonSeriesPoint("18:00", 999, 1, 0.0)
                )
            )
        )
        val stats = source.copy(
            meta = source.meta?.copy(
                generatedAt = "2026-09-02T12:00:00Z",
                timezone = "America/Los_Angeles",
                range = "today",
                query = source.meta?.query?.copy(
                    range = "today",
                    timezone = "America/Los_Angeles"
                )
            ),
            comparison = comparison
        )

        val result = buildShareSummary(stats, RangeKey.Today, costMasked = false, generatedAt)

        assertEquals("2026.07.14", result.generatedDateLabel)
        assertEquals("2026年8月31日", result.periodLabel)
        assertEquals(listOf("16:00"), result.points.map { it.bucket })
        assertEquals(10L, result.peakTokens)
    }

    @Test
    fun futureTrendAndHeatmapBucketsNeverEnterShareInsights() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.All).data)
        val stats = source.copy(
            summary = source.summary.copy(inputTokens = 10, outputTokens = 0),
            meta = source.meta?.copy(
                generatedAt = "2026-09-01T12:00:00Z",
                timezone = "UTC",
                range = "all",
                query = (source.meta?.query ?: StatsQueryEcho()).copy(range = "all", timezone = "UTC")
            ),
            comparison = null,
            trends = listOf(
                TrendPoint("2026-09-01", mapOf("codex" to 10L), 1),
                TrendPoint("2026-09-02", mapOf("codex" to 999L), 1)
            ),
            heatmap = mapOf("2026-09-01" to 10L, "2026-09-02" to 999L)
        )

        val result = buildShareSummary(stats, RangeKey.All, costMasked = false, generatedAt)

        assertEquals(listOf("2026-09-01"), result.points.map { it.bucket })
        assertEquals(1, result.activeDays)
        assertEquals(10L, result.peakTokens)
        assertEquals("2026.07.15", result.generatedDateLabel)
    }

    @Test
    fun timezoneConflictsDegradeAllTimeInsights() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Today).data)
        val matchingMeta = requireNotNull(source.meta).copy(
            generatedAt = "2026-09-01T12:00:00Z",
            timezone = "America/Los_Angeles",
            range = "today",
            query = (source.meta?.query ?: StatsQueryEcho()).copy(
                range = "today",
                timezone = "America/Los_Angeles"
            )
        )
        val queryConflict = source.copy(
            meta = matchingMeta.copy(query = matchingMeta.query?.copy(timezone = "UTC")),
            comparison = null
        )
        val sourceComparison = requireNotNull(source.comparison)
        val windowConflict = source.copy(
            meta = matchingMeta,
            comparison = sourceComparison.copy(
                window = sourceComparison.window.copy(
                    timezone = "UTC",
                    currentEnd = "2026-09-01T12:00:00Z"
                )
            )
        )
        val invalidIanaZone = source.copy(
            meta = matchingMeta.copy(
                timezone = "Mars/Olympus",
                query = matchingMeta.query?.copy(timezone = "Mars/Olympus")
            ),
            comparison = null
        )

        listOf(queryConflict, windowConflict, invalidIanaZone).forEach { stats ->
            val result = buildShareSummary(stats, RangeKey.Today, costMasked = false, generatedAt)
            assertNull(result.activeDays)
            assertNull(result.longestStreakDays)
            assertNull(result.peakTokens)
            assertNull(result.deltaPercent)
            assertTrue(result.points.isEmpty())
            assertEquals("2026.07.15", result.generatedDateLabel)
        }
    }

    @Test
    fun todayOnlyAcceptsHourBucketsAndMarksTheCurrentHourInProgress() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Today).data)
        val comparison = requireNotNull(source.comparison).copy(
            window = source.comparison.window.copy(
                timezone = "UTC",
                currentEnd = "2026-09-01T16:30:00Z"
            ),
            current = source.comparison.current.copy(
                series = listOf(
                    ComparisonSeriesPoint("15:30", 999, 1, 0.0),
                    ComparisonSeriesPoint("16:00", 20, 1, 0.0),
                    ComparisonSeriesPoint("17:00", 999, 1, 0.0)
                )
            )
        )
        val stats = source.copy(
            summary = source.summary.copy(inputTokens = 20, outputTokens = 0),
            meta = source.meta?.copy(
                timezone = "UTC",
                range = "today",
                query = (source.meta?.query ?: StatsQueryEcho()).copy(range = "today", timezone = "UTC")
            ),
            comparison = comparison
        )

        val result = buildShareSummary(stats, RangeKey.Today, costMasked = false, generatedAt)

        assertEquals(listOf("16:00"), result.points.map { it.bucket })
        assertTrue(result.points.single().inProgress)
        assertEquals("16:00（进行中）", result.peakLabel)
    }

    @Test
    fun yearBucketsRejectInvalidMonths() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Year).data)
        val stats = source.copy(
            meta = source.meta?.copy(
                generatedAt = "2026-09-01T12:00:00Z",
                timezone = "UTC",
                range = "year",
                query = (source.meta?.query ?: StatsQueryEcho()).copy(range = "year", timezone = "UTC")
            ),
            comparison = null,
            trends = listOf(
                TrendPoint("2026-00", mapOf("codex" to 999L), 1),
                TrendPoint("2026-09", mapOf("codex" to 10L), 1),
                TrendPoint("2026-13", mapOf("codex" to 999L), 1)
            )
        )

        val result = buildShareSummary(stats, RangeKey.Year, costMasked = false, generatedAt)

        assertEquals(listOf("2026-09"), result.points.map { it.bucket })
    }

    @Test
    fun dstGapAndFoldCivilCutoffsDegradeInsteadOfBeingSilentlyShifted() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Today).data)
        val baseMeta = requireNotNull(source.meta).copy(
            generatedAt = null,
            timezone = "America/Los_Angeles",
            range = "today",
            query = (source.meta?.query ?: StatsQueryEcho()).copy(
                range = "today",
                timezone = "America/Los_Angeles"
            )
        )
        val sourceComparison = requireNotNull(source.comparison)

        listOf("2026-03-08T02:30:00", "2026-11-01T01:30:00").forEach { civilCutoff ->
            val stats = source.copy(
                meta = baseMeta,
                comparison = sourceComparison.copy(
                    window = sourceComparison.window.copy(
                        timezone = "America/Los_Angeles",
                        currentEnd = civilCutoff
                    )
                )
            )
            val result = buildShareSummary(stats, RangeKey.Today, costMasked = false, generatedAt)
            assertTrue(result.points.isEmpty())
            assertNull(result.peakTokens)
            assertNull(result.activeDays)
        }
    }

    @Test
    fun overflowingTrendBucketsAreDroppedWithoutWrappingNegative() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.All).data)
        val stats = source.copy(
            meta = source.meta?.copy(
                generatedAt = "2026-09-01T12:00:00Z",
                timezone = "UTC",
                range = "all",
                query = (source.meta?.query ?: StatsQueryEcho()).copy(range = "all", timezone = "UTC")
            ),
            comparison = null,
            trends = listOf(
                TrendPoint("2026-08-31", mapOf("codex" to Long.MAX_VALUE, "claude" to 1L), 2),
                TrendPoint("2026-09-01", mapOf("codex" to 10L), 1)
            )
        )

        val result = buildShareSummary(stats, RangeKey.All, costMasked = false, generatedAt)

        assertEquals(listOf("2026-09-01"), result.points.map { it.bucket })
    }

    @Test
    fun todayPeakNeverFallsBackToCrossDayHeatmap() {
        val source = requireNotNull(ledgerSnapshotFixture(RangeKey.Today).data)
        val stats = source.copy(
            summary = source.summary.copy(inputTokens = 999, outputTokens = 0),
            meta = source.meta?.copy(
                generatedAt = "2026-09-01T12:00:00Z",
                timezone = "UTC",
                range = "today",
                query = (source.meta?.query ?: StatsQueryEcho()).copy(range = "today", timezone = "UTC")
            ),
            comparison = null,
            trends = emptyList(),
            heatmap = mapOf("2026-08-31" to 9_999L, "2026-09-01" to 999L)
        )

        val result = buildShareSummary(stats, RangeKey.Today, costMasked = false, generatedAt)

        assertTrue(result.points.isEmpty())
        assertNull(result.peakLabel)
        assertNull(result.peakTokens)
    }

    @Test
    fun imageShareSpecRequiresContentUriPngAndReadGrant() {
        val longCaption = "x".repeat(300)
        val spec = SharePosterFileStore.intentSpec(
            contentUri = "content://com.jeidorf.tokenledger.mobile.fileprovider/share_posters/poster.png",
            extraText = longCaption
        )

        assertEquals(Intent.ACTION_SEND, spec.action)
        assertEquals("image/png", spec.mimeType)
        assertTrue(spec.contentUri.startsWith("content://"))
        assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, spec.flags)
        assertEquals(240, spec.extraText?.length)
        assertFalse(spec.mimeType.startsWith("text/"))
        assertFalse(spec.contentUri.startsWith("file://"))
        assertThrows(IllegalArgumentException::class.java) {
            SharePosterFileStore.intentSpec("file:///tmp/poster.png", null)
        }
    }

    @Test
    fun shareFailuresKeepTheRecoveryActionSpecific() {
        assertEquals(
            "暂时没有可用的分享应用，请安装或启用一个支持图片分享的应用后重试。",
            sharePosterFailureMessage(ActivityNotFoundException())
        )
        assertEquals(
            "系统暂时拒绝了图片分享授权，请返回后重试。",
            sharePosterFailureMessage(SecurityException())
        )
        assertEquals(
            "图片生成失败，请保留当前选择后重试。",
            sharePosterFailureMessage(IllegalStateException())
        )
    }

    @Test
    fun exportDimensionsPreferThePhysicalPanelOverTheRuntimeOverride() {
        assertEquals(
            1440 to 3200,
            resolveShareExportDimensions(
                runtimeWidth = 1080,
                runtimeHeight = 2400,
                physicalWidth = 1440,
                physicalHeight = 3200
            )
        )
    }

    @Test
    fun exportDimensionsFollowTheCurrentOrientation() {
        assertEquals(
            3200 to 1440,
            resolveShareExportDimensions(
                runtimeWidth = 2400,
                runtimeHeight = 1080,
                physicalWidth = 1440,
                physicalHeight = 3200
            )
        )
    }

    @Test
    fun exportDimensionsPreserveTheScreenAspectWhileMeetingTheMinimumQuality() {
        assertEquals(
            1080 to 2400,
            resolveShareExportDimensions(runtimeWidth = 720, runtimeHeight = 1600)
        )
        assertEquals(
            SHARE_POSTER_WIDTH to SHARE_POSTER_HEIGHT,
            resolveShareExportDimensions(runtimeWidth = 0, runtimeHeight = 0)
        )
        assertEquals(
            2160 to 4800,
            resolveShareExportDimensions(runtimeWidth = 2160, runtimeHeight = 4800)
        )
        assertEquals("9:20", shareExportAspectLabel(1080, 2400))
        assertEquals("16:9", shareExportAspectLabel(3200, 1800))
    }

    @Test
    fun posterCleanupOnlyRemovesExpiredOrOverflowPngFiles() {
        val directory = Files.createTempDirectory("tokenledger-share-test").toFile()
        try {
            val now = 2 * SharePosterFileStore.MAX_FILE_AGE_MILLIS
            val protected = createPoster(directory, "protected.png", now)
            val expired = createPoster(directory, "expired.png", 0L)
            val unrelated = File(directory, "keep.txt").apply { writeText("private cache") }
            repeat(SharePosterFileStore.MAX_RETAINED_FILES + 2) { index ->
                createPoster(directory, "recent-$index.png", now - index - 1L)
            }

            SharePosterFileStore.cleanup(directory, now, protected)

            assertTrue(protected.exists())
            assertFalse(expired.exists())
            assertTrue(unrelated.exists())
            assertTrue(directory.listFiles().orEmpty().count { it.extension == "png" } <= SharePosterFileStore.MAX_RETAINED_FILES + 1)
        } finally {
            directory.deleteRecursively()
        }
    }

    private fun createPoster(directory: File, name: String, modifiedAt: Long): File =
        File(directory, name).apply {
            writeBytes(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47))
            assertTrue(setLastModified(modifiedAt))
        }
}
