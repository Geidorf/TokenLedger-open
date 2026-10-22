package com.jeidorf.tokenledger.mobile

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import java.time.Instant

internal fun chartQuotaStats(kind: String = "normal"): StatsData {
    val base = requireNotNull(ledgerSnapshotFixture().data)
    val comparison = requireNotNull(base.comparison)
    val current = listOf(ComparisonSeriesPoint("2026-07-15 01:00:00", 1234567, 13, 12.34),
        ComparisonSeriesPoint("2026-07-15 02:00:00", 420000, 7, .007))
    val previous = listOf(ComparisonSeriesPoint("2026-07-14 01:00:00", 900123, 10, 6.78),
        ComparisonSeriesPoint("2026-07-14 02:00:00", 230000, 3, .003),
        ComparisonSeriesPoint("2026-07-14 03:00:00", 310000, 5, 1.2))
    val tools = listOf("codex", "claude", "gemini", "cursor", "aider", "opencode").mapIndexed { index, name ->
        val value = if (kind == "zero") 0L else (6 - index) * 10000L
        ToolStat(name, value, 0, 0, value, 0.0, 1)
    }
    return base.copy(summary = base.summary.copy(inputTokens = tools.sumOf { it.input }, outputTokens = 0,
        cachedTokens = 0, totalTokens = tools.sumOf { it.input }), tools = tools.associateBy { it.name },
        models = base.models.entries.take(3).associate { it.key to it.value },
        comparison = comparison.copy(current = comparison.current.copy(series = if (kind == "empty") emptyList() else current),
            previous = comparison.previous.copy(series = if (kind == "missing") emptyList() else previous)))
}

internal fun chartQuotaAvailable(kind: String): QuotaUiState.Available {
    val base = ledgerFreshQuotaSnapshotFixture().quota as QuotaUiState.Available
    val source = base.snapshot.providers.first()
    val first = source.windows.first()
    val windows = listOf(first, first.copy(windowId = "week", windowLabel = "7 天窗口", windowMinutes = 10080))
    val provider = when (kind) {
        "mixed" -> source.copy(windows = listOf(windows.first(), windows.last().copy(observedAt = "2026-07-20T04:00:00Z", fetchedAt = "2026-07-20T04:01:00Z")))
        "error" -> source.copy(status = QuotaProviderStatus.Error, reasonCode = "upstream_unavailable", windows = windows)
        "pending" -> source.copy(status = QuotaProviderStatus.AuthRequired, reasonCode = "local_authorization_required", windows = emptyList())
        "details" -> source.copy(windows = windows.take(1))
        else -> source.copy(windows = windows)
    }
    return base.copy(snapshot = base.snapshot.copy(providers = listOf(provider)))
}

@PreviewTest
@Preview(name = "Trend normal USD 390", device = "spec:width=390dp,height=1300dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaTrendNormalScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Trend, chartQuotaStats(), metric = ReportMetricMode.Cost)
}

@PreviewTest
@Preview(name = "Trend empty current 390", device = "spec:width=390dp,height=1200dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaTrendEmptyScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Trend, chartQuotaStats("empty"), metric = ReportMetricMode.Cost)
}

@PreviewTest
@Preview(name = "Trend missing previous 390", device = "spec:width=390dp,height=1200dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaTrendMissingScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Trend, chartQuotaStats("missing"))
}

@PreviewTest
@Preview(name = "Trend unequal buckets 320 font2", device = "spec:width=320dp,height=1300dp,dpi=160", fontScale = 2.0f)
@Composable
fun ChartQuotaTrendTableLargeScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.TrendTable, chartQuotaStats())
}

@PreviewTest
@Preview(name = "Six source denominator 390", device = "spec:width=390dp,height=1500dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaSixSourcesScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Sources, chartQuotaStats())
}

@PreviewTest
@Preview(name = "Overview six sources 320 font2", device = "spec:width=320dp,height=1500dp,dpi=160", fontScale = 2.0f)
@Composable
fun ChartQuotaOverviewLargeScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.OverviewTools, chartQuotaStats())
}

@PreviewTest
@Preview(name = "Zero composition 390", device = "spec:width=390dp,height=1000dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaZeroCompositionScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Composition, chartQuotaStats("zero"))
}

@PreviewTest
@Preview(name = "Model ranking 320 font2", device = "spec:width=320dp,height=1400dp,dpi=160", fontScale = 2.0f)
@Composable
fun ChartQuotaRankingLargeScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.ModelRanking, chartQuotaStats())
}

@PreviewTest
@Preview(name = "Model cost masked 320", device = "spec:width=320dp,height=1000dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaRankingCostMaskedScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.ModelRanking, chartQuotaStats(), metric = ReportMetricMode.Cost, masked = true)
}

@PreviewTest
@Preview(name = "Quota fresh 390", device = "spec:width=390dp,height=1000dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaQuotaFreshScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Quota, chartQuotaStats(), quota = chartQuotaAvailable("fresh"))
}

@PreviewTest
@Preview(name = "Quota mixed history 390", device = "spec:width=390dp,height=1000dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaQuotaMixedScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Quota, chartQuotaStats(), quota = chartQuotaAvailable("mixed"))
}

@PreviewTest
@Preview(name = "Quota explicit error 390", device = "spec:width=390dp,height=1000dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaQuotaErrorScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Quota, chartQuotaStats(), quota = chartQuotaAvailable("error"))
}

@PreviewTest
@Preview(name = "Quota detail times 320 font2", device = "spec:width=320dp,height=1800dp,dpi=160", fontScale = 2.0f)
@Composable
fun ChartQuotaQuotaDetailsScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Quota, chartQuotaStats(), quota = chartQuotaAvailable("details"), details = true)
}

@PreviewTest
@Preview(name = "Quota pending recovery 390", device = "spec:width=390dp,height=1000dp,dpi=160", fontScale = 1.0f)
@Composable
fun ChartQuotaQuotaPendingScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Quota, chartQuotaStats(), quota = chartQuotaAvailable("pending"))
}

@PreviewTest
@Preview(name = "Trend full 320 font2", device = "spec:width=320dp,height=2100dp,dpi=160", fontScale = 2f)
@Composable
fun ChartQuotaTrendFullLargeScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Trend, chartQuotaStats(), metric = ReportMetricMode.Cost)
}

@PreviewTest
@Preview(name = "Sources dark 390", device = "spec:width=390dp,height=1300dp,dpi=160")
@Composable
fun ChartQuotaSourcesDarkScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Sources, chartQuotaStats(), appearance = LedgerAppearance.Dark)
}

@PreviewTest
@Preview(name = "Quota mixed dark 390", device = "spec:width=390dp,height=844dp,dpi=160")
@Composable
fun ChartQuotaMixedDarkScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.Quota, chartQuotaStats(), appearance = LedgerAppearance.Dark, quota = chartQuotaAvailable("mixed"))
}

@PreviewTest
@Preview(name = "Trend table CNY 320 font2", device = "spec:width=320dp,height=1100dp,dpi=160", fontScale = 2.0f)
@Composable
fun ChartQuotaTrendTableCurrencyLargeScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.TrendTable, chartQuotaStats(),
        metric = ReportMetricMode.Cost, currency = CurrencyUnit.CNY)
}

@PreviewTest
@Preview(name = "Trend table tokens 390 font150", device = "spec:width=390dp,height=1000dp,dpi=160", fontScale = 1.5f)
@Composable
fun ChartQuotaTrendTableTokensMediumScreenshot() {
    V2ChartQuotaPreviewContent(ChartQuotaPreviewSurface.TrendTable, chartQuotaStats())
}
