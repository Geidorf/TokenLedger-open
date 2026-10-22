package com.jeidorf.tokenledger.mobile

import com.jeidorf.tokenledger.mobile.widget.WidgetQuotaProvider
import com.jeidorf.tokenledger.mobile.widget.WidgetThresholdBand
import com.jeidorf.tokenledger.mobile.widget.providerAccessibilityDescription
import com.jeidorf.tokenledger.mobile.widget.widgetAvailabilityBand
import com.jeidorf.tokenledger.mobile.widget.widgetProgressQuotaWindow
import com.jeidorf.tokenledger.mobile.widget.widgetQuotaValue
import java.io.File
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 同一额度窗口四处同数（T10.207 / T10.172 C1，A-Q2）。
 *
 * 同一个百分比窗口分别喂给今日卡、额度页、摆件、小组件（含应用内预览）与读屏：数字都是
 * 「100 − round(已用)」的整数，档位都按这个整数分（< 20 告急、< 50 偏紧，严格小于），并与桌面
 * `src/utils/quotaOverview.ts` 的 `readQuotaWindow` + `quotaLevel` 逐例相等。
 *
 * 此前四处四种取整：今日卡截断（剩 19.6% 写「19% 可用」）、额度页一位小数（「可用 19.6%」）、
 * 小组件四舍五入写「20%」却按 19.6% 的比例画成告急红，桌面写「20%」。
 */
class QuotaWindowConsistencyTest {
    private val now = Instant.parse("2026-09-26T04:00:00Z")

    private data class Case(val used: Double, val available: Int, val severity: QuotaSeverity)

    /** 边界取自任务书：49.5 / 50.4 / 79.5 / 80.4 / 99.6，另补两侧与两端。 */
    private val cases = listOf(
        Case(0.0, 100, QuotaSeverity.Healthy),
        Case(0.4, 100, QuotaSeverity.Healthy),
        Case(0.5, 99, QuotaSeverity.Healthy),
        Case(12.34567, 88, QuotaSeverity.Healthy),
        Case(27.5, 72, QuotaSeverity.Healthy),
        Case(43.0, 57, QuotaSeverity.Healthy),
        Case(49.5, 50, QuotaSeverity.Healthy),
        Case(50.4, 50, QuotaSeverity.Healthy),
        Case(50.5, 49, QuotaSeverity.Warning),
        Case(79.5, 20, QuotaSeverity.Warning),
        Case(80.4, 20, QuotaSeverity.Warning),
        Case(80.5, 19, QuotaSeverity.Critical),
        Case(99.4, 1, QuotaSeverity.Critical),
        Case(99.6, 0, QuotaSeverity.Critical),
        Case(100.0, 0, QuotaSeverity.Critical)
    )

    /** 桌面 `readQuotaWindow`：`Math.max(0, Math.min(100, 100 - Math.round(values.used)))`。 */
    private fun desktopRemaining(used: Double): Int =
        maxOf(0L, minOf(100L, 100L - Math.round(used))).toInt()

    /** 桌面 `quotaLevel`：非有限或 < 20 → critical，< 50 → warn，其余 ok。 */
    private fun desktopLevel(remaining: Int): QuotaSeverity = when {
        remaining < 20 -> QuotaSeverity.Critical
        remaining < 50 -> QuotaSeverity.Warning
        else -> QuotaSeverity.Healthy
    }

    private fun window(used: Double, withRemaining: Boolean) = QuotaWindowSnapshot(
        providerId = "openai-codex-local",
        windowId = "codex:secondary",
        windowLabel = "7 天窗口",
        scope = QuotaScope.ConsumerSubscription,
        source = QuotaSource.LocalAuthorized,
        status = QuotaWindowStatus.Ok,
        used = used,
        limit = 100.0,
        remaining = if (withRemaining) 100.0 - used else null,
        unit = QuotaUnit.Percent,
        windowMinutes = 10_080,
        resetsAt = "2026-09-28T00:00:00Z",
        observedAt = "2026-09-26T03:59:00Z",
        fetchedAt = "2026-09-26T03:59:30Z",
        staleAfterSeconds = 3_600,
        reasonCode = null
    )

    private fun provider(window: QuotaWindowSnapshot) = QuotaProviderEnvelope(
        schemaVersion = 1,
        providerId = "openai-codex-local",
        displayName = "Codex",
        scope = QuotaScope.ConsumerSubscription,
        mode = QuotaMode.Automatic,
        capability = QuotaCapability.Stable,
        status = QuotaProviderStatus.Ok,
        windows = listOf(window),
        reasonCode = null
    )

    private fun bandSeverity(band: WidgetThresholdBand): QuotaSeverity = when (band) {
        WidgetThresholdBand.Danger -> QuotaSeverity.Critical
        WidgetThresholdBand.Warn -> QuotaSeverity.Warning
        WidgetThresholdBand.Normal -> QuotaSeverity.Healthy
    }

    @Test
    fun `同一额度窗口四处同数`() {
        for (case in cases) for (withRemaining in listOf(true, false)) {
            val tag = "已用 ${case.used}（remaining ${if (withRemaining) "给出" else "缺省"}）"
            val snapshot = window(case.used, withRemaining)
            val envelope = provider(snapshot)
            val progress = snapshot.displayValue() as QuotaDisplayValue.Progress
            val n = case.available
            val spoken = "可用 $n%（${case.severity.label}）"

            // 桌面 readQuotaWindow + quotaLevel：本表的口径来源。
            assertEquals("$tag 桌面数字", n, desktopRemaining(case.used))
            assertEquals("$tag 桌面档位", case.severity, desktopLevel(desktopRemaining(case.used)))

            // 今日卡（V2QuotaSummaryCard）：「N% 可用」+ 按整数分档 + 读屏；进度条（V2QuotaProgressBar）按比例分档。
            val today = quotaAvailablePercent(progress)
            assertEquals("$tag 今日卡数字", n, today)
            assertEquals("$tag 今日卡档位", case.severity, quotaSeverityForAvailablePercent(today!!))
            assertEquals("$tag 今日卡读屏", spoken, quotaAvailableAccessibilityLabel(today))
            assertEquals(
                "$tag 今日卡进度条档位",
                case.severity,
                quotaSeverityForFraction(v2QuotaRemainingFraction(progress))
            )

            // 额度页（V2ProviderCard / V2ProviderWindowRow）：quotaCardPresentation → quotaValueLabel；
            // 档位 quotaSeverityForFraction(v2QuotaRemainingFraction)；读屏「label（档位）」。
            val page = quotaCardPresentation(envelope, now, cached = false).windows.single()
            val pageValue = page.value as QuotaDisplayValue.Progress
            val pageLabel = quotaValueLabel(pageValue)
            val pageSeverity = quotaSeverityForFraction(v2QuotaRemainingFraction(pageValue))
            assertEquals("$tag 额度页数字", "可用 $n%", pageLabel)
            assertEquals("$tag 额度页档位", case.severity, pageSeverity)
            assertEquals("$tag 额度页读屏", spoken, "$pageLabel（${pageSeverity.label}）")

            // 摆件（V2AmbientQuotaRing 等三处）：effectiveQuotaProgressPresentation.availablePercent。
            val ambient = effectiveQuotaProgressPresentation(envelope, snapshot, now, forceStale = false)
            assertEquals("$tag 摆件数字", n, ambient.availablePercent)
            assertEquals("$tag 摆件读屏", spoken, quotaAvailableAccessibilityLabel(ambient.availablePercent!!))

            // 小组件（Glance）：WidgetStateRepository.mapWindow → widgetProgressQuotaWindow；环/条/档位按量化后的比例。
            val widgetWindow = widgetProgressQuotaWindow(snapshot.windowLabel, progress, QuotaWindowStatus.Ok)
            assertEquals("$tag 小组件数字", "$n%", widgetWindow.availableText)
            assertEquals("$tag 小组件比例", n / 100f, widgetWindow.availableFraction!!, 0f)
            assertEquals(
                "$tag 小组件档位",
                case.severity,
                bandSeverity(widgetAvailabilityBand(widgetWindow.availableFraction!!))
            )
            val widgetProvider = WidgetQuotaProvider(
                id = envelope.providerId,
                name = "Codex",
                status = QuotaProviderStatus.Ok,
                primary = widgetWindow,
                secondary = null,
                resetText = null,
                freshnessText = "刚刚",
                stale = false
            )
            assertEquals("$tag 小组件行值", "可用 $n%", widgetQuotaValue(widgetProvider))
            assertTrue(
                "$tag 小组件读屏须念同一个数",
                providerAccessibilityDescription(widgetProvider).contains("，$n%可用")
            )

            // 应用内挂件预览（V2WidgetQuotaPill）：同一个整数折回比例，再走 widgetAvailabilityBand。
            val pill = quotaAvailablePercent(progress)!!
            val pillSeverity = bandSeverity(widgetAvailabilityBand(pill / 100f))
            assertEquals("$tag 预览数字", n, pill)
            assertEquals("$tag 预览档位", case.severity, pillSeverity)
            assertEquals("$tag 预览读屏", spoken, "可用 $pill%（${pillSeverity.label}）")
        }
    }

    @Test
    fun `额度页与进度条的档位逐一跟随显示的整数`() {
        // 剩余比例是 Float，换回已用百分比时带约 ±3e-6 的误差；恰好落在 k.5 的已用值会被误差推过取整分界。
        // 0.00–100.00 每 0.01 一步，按比例分档必须与按显示整数分档一致。
        for (hundredths in 0..10_000) {
            val used = hundredths / 100.0
            val progress = window(used, withRemaining = true).displayValue() as QuotaDisplayValue.Progress
            val shown = quotaAvailablePercent(progress)!!
            assertEquals("已用 $used 的显示数字与桌面", desktopRemaining(used), shown)
            assertEquals(
                "已用 $used：显示 $shown%",
                quotaSeverityForAvailablePercent(shown),
                quotaSeverityForFraction(v2QuotaRemainingFraction(progress))
            )
        }
    }

    @Test
    fun `读不到的额度不画成安全`() {
        assertEquals(null, quotaAvailablePercentForUsed(Double.NaN))
        assertEquals(null, quotaAvailablePercentForUsed(Double.POSITIVE_INFINITY))
        assertEquals(QuotaSeverity.Critical, quotaSeverityForFraction(Float.NaN))
        assertEquals(100, quotaAvailablePercentForUsed(-3.0))
        assertEquals(0, quotaAvailablePercentForUsed(130.0))
    }

    @Test
    fun `各界面都经由共用的额度取整`() {
        val base = "src/main/java/com/jeidorf/tokenledger/mobile"
        // 每组写法任取其一即可：额度页（A4）以后改成直接用 quotaAvailablePercent 分档也算接对。
        val wiring = mapOf(
            "$base/ui/quota/V2QuotaSummaryCard.kt" to listOf(
                listOf("quotaAvailablePercent"),
                listOf("quotaSeverityForAvailablePercent"),
                listOf("quotaAvailableAccessibilityLabel")
            ),
            "$base/ui/quota/V2ProviderCard.kt" to listOf(
                listOf("quotaValueLabel(", "quotaAvailablePercent("),
                listOf("quotaSeverityForFraction(", "quotaSeverityForAvailablePercent(")
            ),
            "$base/ui/ambient/V2AmbientComponents.kt" to listOf(
                listOf("effectiveQuotaProgressPresentation"),
                listOf("presentation.availablePercent"),
                listOf("quotaAvailableAccessibilityLabel")
            ),
            "$base/ui/ambient/V2WidgetPreviewCard.kt" to listOf(
                listOf("quotaAvailablePercent"),
                listOf("widgetAvailabilityBand")
            ),
            "$base/widget/WidgetStateRepository.kt" to listOf(listOf("widgetProgressQuotaWindow("))
        )
        // 此前各处自己取整的写法：比例 × 100 后截断或就地四舍五入。
        val localRounding = Regex("""\*\s*100f?\s*\)\s*\.(toInt|roundToInt)\(\)""")
        for ((path, groups) in wiring) {
            val text = sourceFile(path).readText()
            groups.forEach { anyOf ->
                assertTrue("$path 应调用 ${anyOf.joinToString(" 或 ")}", anyOf.any { text.contains(it) })
            }
            assertFalse("$path 不应自行把比例 ×100 取整", localRounding.containsMatchIn(text))
        }
    }

    private fun sourceFile(path: String): File =
        listOf(File(path), File("app", path), File("apps/android/app", path)).firstOrNull { it.isFile }
            ?: error("找不到 $path（当前目录 ${File(".").absolutePath}）")
}
