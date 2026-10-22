package com.jeidorf.tokenledger.mobile

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest

private fun dailyCostsPageFixture(partial: Boolean = false, missing: Boolean = false): StatsData {
    val base = requireNotNull(ledgerSnapshotFixture().data)
    val days = listOf(
        DailyCostDay("2026-07-12", null, DailyCostStatus.Unavailable, DailyCostUnavailableReason.LegacyZero),
        DailyCostDay("2026-07-13", null, DailyCostStatus.Unavailable, DailyCostUnavailableReason.MissingCost),
        DailyCostDay("2026-07-14", 0.0001, DailyCostStatus.RecordedEstimate),
        DailyCostDay("2026-07-15", 1234.56, DailyCostStatus.RecordedEstimate)
    )
    return base.copy(
        heatmap = mapOf("2026-07-12" to 180L, "2026-07-13" to 32000L,
            "2026-07-14" to 420000L, "2026-07-15" to 1234567L),
        comparison = null,
        meta = StatsMeta("2026-07-15T09:30:00+08:00", null, "Asia/Shanghai", "month", null, false,
            contractVersion = 2,
            query = StatsQueryEcho(range = "month", timezone = "Asia/Shanghai", tokenMode = "effective")),
        dailyCosts = if (missing) null else DailyCosts(
            DailyCostsCoverage("2026-07-01", "2026-07-15", "Asia/Shanghai",
                if (partial) DailyCostsCoverageState.Partial else DailyCostsCoverageState.Complete),
            if (partial) days.map { it.copy(amountUsd = null, status = DailyCostStatus.Unavailable,
                reason = DailyCostUnavailableReason.IncompleteCoverage) } else days)
    )
}

@PreviewTest
@Preview(name = "Daily costs light 390", device = "spec:width=390dp,height=844dp,dpi=160")
@Composable
fun DailyCostsLight390Screenshot() {
    V2DailyCostsPreviewContent(LedgerAppearance.Light, dailyCostsPageFixture(), DashboardQuery(range = RangeKey.Month))
}

@PreviewTest
@Preview(name = "Daily costs dark 390", device = "spec:width=390dp,height=844dp,dpi=160")
@Composable
fun DailyCostsDark390Screenshot() {
    V2DailyCostsPreviewContent(LedgerAppearance.Dark, dailyCostsPageFixture(), DashboardQuery(range = RangeKey.Month))
}

@PreviewTest
@Preview(name = "Daily costs narrow 320 font2", device = "spec:width=320dp,height=1120dp,dpi=160", fontScale = 2f)
@Composable
fun DailyCostsNarrowLargeTextScreenshot() {
    V2DailyCostsPreviewContent(LedgerAppearance.Light, dailyCostsPageFixture(), DashboardQuery(range = RangeKey.Month))
}

@PreviewTest
@Preview(name = "Daily costs masked 390", device = "spec:width=390dp,height=844dp,dpi=160")
@Composable
fun DailyCostsMaskedScreenshot() {
    V2DailyCostsPreviewContent(LedgerAppearance.Dark, dailyCostsPageFixture(), DashboardQuery(range = RangeKey.Month), masked = true)
}

@PreviewTest
@Preview(name = "Daily costs partial 390", device = "spec:width=390dp,height=844dp,dpi=160")
@Composable
fun DailyCostsPartialScreenshot() {
    V2DailyCostsPreviewContent(LedgerAppearance.Light, dailyCostsPageFixture(partial = true), DashboardQuery(range = RangeKey.Month))
}

@PreviewTest
@Preview(name = "Daily costs old response 320", device = "spec:width=320dp,height=844dp,dpi=160")
@Composable
fun DailyCostsMissingScreenshot() {
    V2DailyCostsPreviewContent(LedgerAppearance.Light, dailyCostsPageFixture(missing = true), DashboardQuery(range = RangeKey.Month))
}
