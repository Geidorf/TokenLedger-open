package com.jeidorf.tokenledger.mobile

import android.content.res.Configuration
import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import java.time.Instant

/**
 * A deliberately small visual matrix: the accepted target, two fixed-top-bar refresh states,
 * canonical week/month comparisons, two phone width boundaries, one large-text configuration, one
 * low-color appearance, and one tablet navigation-rail host. It avoids a width x theme x font-scale
 * cross product while covering the highest-risk layout branches with the same production fixture.
 */
@PreviewTest
@Preview(
    name = "Ledger Snapshot 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF080A0F
)
@Composable
fun LedgerDashboard390Screenshot() {
    LedgerDashboardPreviewHost(LedgerAppearance.Dark)
}

@PreviewTest
@Preview(
    name = "Long source identities 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardLongSourceIdentitiesScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerLongSourceIdentitySnapshotFixture()
    )
}

@PreviewTest
@Preview(
    name = "Long source identities overview 390x1280",
    device = "spec:width=390dp,height=1280dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardLongSourceIdentitiesOverviewScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerLongSourceIdentitySnapshotFixture()
    )
}

@PreviewTest
@Preview(
    name = "Long source identities large text 390x1280",
    device = "spec:width=390dp,height=1280dp,dpi=160",
    fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardLongSourceIdentitiesLargeTextScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerLongSourceIdentitySnapshotFixture(),
        destination = MobileDestination.Usage,
        insightPane = InsightPane.Sources
    )
}

@PreviewTest
@Preview(
    name = "Long quota summary identity 390x1920",
    device = "spec:width=390dp,height=1920dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardLongQuotaSummaryIdentity390Screenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerLongQuotaSummaryIdentitySnapshotFixture()
    )
}

private fun ledgerLongSourceIdentitySnapshotFixture(): DashboardUiState {
    val base = ledgerSnapshotFixture()
    val stats = requireNotNull(base.data)
    val longToolName = "openai-codex-local-production"
    val longModelName = "gpt-5.6-preview-ultra-long-context"
    val codex = requireNotNull(stats.tools["codex"])
    val longTool = codex.copy(
        name = longToolName,
        models = mapOf(longModelName to codex.effectiveTokens)
    )
    val tools = stats.tools.toMutableMap().apply {
        remove("codex")
        put(longToolName, longTool)
    }
    val gpt = requireNotNull(stats.models["gpt-5"])
    val longModel = gpt.copy(name = longModelName)
    val models = stats.models.toMutableMap().apply {
        remove("gpt-5")
        put(longModelName, longModel)
    }
    val history = stats.history.mapIndexed { index, item ->
        if (index == 0) {
            item.copy(
                tool = longToolName,
                model = longModelName,
                machineId = "MacBook-Pro-remote-build-agent"
            )
        } else {
            item
        }
    }
    return base.copy(
        data = stats.copy(
            tools = tools,
            models = models,
            history = history,
            detailsPage = stats.detailsPage?.copy(items = history)
        )
    )
}

@PreviewTest
@Preview(
    name = "Long detail identities 390x1280",
    device = "spec:width=390dp,height=1280dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardLongDetailIdentitiesScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerLongDetailIdentitySnapshotFixture(),
        destination = MobileDestination.Usage,
        insightPane = InsightPane.Details
    )
}

@PreviewTest
@Preview(
    name = "Long detail identities large text 390x1280",
    device = "spec:width=390dp,height=1280dp,dpi=160",
    fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardLongDetailIdentitiesLargeTextScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerLongDetailIdentitySnapshotFixture(),
        destination = MobileDestination.Usage,
        insightPane = InsightPane.Details
    )
}

@PreviewTest
@Preview(
    name = "Long entity machine identities 390x1600",
    device = "spec:width=390dp,height=1600dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardLongEntityMachineIdentitiesScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerLongEntityMachineIdentitySnapshotFixture()
    )
}

@PreviewTest
@Preview(
    name = "Ambient console long quota identities 1194x834",
    device = "spec:width=1194dp,height=834dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayAmbientConsoleLongQuotaIdentitiesScreenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Console,
        state = ledgerLongQuotaIdentitySnapshotFixture().copy(lowPowerDisplayVisible = true)
    )
}

@PreviewTest
@Preview(
    name = "Ambient console long quote source 1194x834",
    device = "spec:width=1194dp,height=834dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayAmbientConsoleLongQuoteSourceScreenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Console,
        state = ledgerLongQuoteSourceSnapshotFixture().copy(lowPowerDisplayVisible = true)
    )
}

@PreviewTest
@Preview(
    name = "Ambient ledger long quota identities 1194x834",
    device = "spec:width=1194dp,height=834dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayAmbientLedgerLongQuotaIdentitiesScreenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Ledger,
        state = ledgerLongQuotaIdentitySnapshotFixture().copy(lowPowerDisplayVisible = true)
    )
}

@PreviewTest
@Preview(
    name = "Ambient ledger long quote source 1194x834",
    device = "spec:width=1194dp,height=834dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayAmbientLedgerLongQuoteSourceScreenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Ledger,
        state = ledgerLongQuoteSourceSnapshotFixture().copy(lowPowerDisplayVisible = true)
    )
}

@PreviewTest
@Preview(
    name = "Ambient quota wall long identities 1194x834",
    device = "spec:width=1194dp,height=834dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayAmbientQuotaWallLongIdentitiesScreenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.QuotaWall,
        state = ledgerLongQuotaIdentitySnapshotFixture().copy(lowPowerDisplayVisible = true)
    )
}

private fun ledgerLongDetailIdentitySnapshotFixture(): DashboardUiState {
    val base = ledgerSnapshotFixture(section = DashboardSection.Details)
    val stats = requireNotNull(base.data)
    val history = stats.history.mapIndexed { index, item ->
        if (index == 0) {
            item.copy(
                tool = "openai-codex-local-production",
                model = "gpt-5.6-preview-ultra-long-context",
                machineId = "MacBook-Pro-remote-build-agent-production"
            )
        } else {
            item
        }
    }
    val detailsPage = requireNotNull(stats.detailsPage).copy(items = history)
    return base.copy(
        data = stats.copy(history = history, detailsPage = detailsPage),
        section = DashboardSection.Details
    )
}

private fun ledgerLongEntityMachineIdentitySnapshotFixture(): DashboardUiState {
    val base = ledgerEntitySnapshotFixture()
    val stats = requireNotNull(base.data)
    val entity = requireNotNull(stats.entityDashboard)
    val machines = entity.composition.machines.mapIndexed { index, machine ->
        machine.copy(
            value = if (index == 0) {
                "MacBook-Pro-remote-build-agent-production"
            } else {
                "Windows-Workstation-build-farm-production"
            }
        )
    }
    return base.copy(
        data = stats.copy(
            entityDashboard = entity.copy(
                composition = entity.composition.copy(machines = machines)
            )
        )
    )
}

private fun ledgerLongQuotaIdentitySnapshotFixture(): DashboardUiState {
    val base = ledgerFreshQuotaSnapshotFixture()
    val quota = base.quota as QuotaUiState.Available
    val providers = quota.snapshot.providers.mapIndexed { index, provider ->
        if (index == 0) {
            provider.copy(displayName = "Codex · enterprise-production-shared-account")
        } else {
            provider
        }
    }
    return base.copy(
        quota = quota.copy(snapshot = quota.snapshot.copy(providers = providers))
    )
}

private fun ledgerLongQuotaSummaryIdentitySnapshotFixture(): DashboardUiState {
    val base = ledgerFreshQuotaSnapshotFixture()
    val quota = base.quota as QuotaUiState.Available
    val provider = quota.snapshot.providers.first().copy(
        providerId = "custom-team-openapi-long-name",
        displayName = "Custom Team OpenAPI · enterprise-production-shared-account"
    )
    return base.copy(
        quota = quota.copy(snapshot = quota.snapshot.copy(providers = listOf(provider)))
    )
}

private fun ledgerLongQuoteSourceSnapshotFixture(): DashboardUiState {
    val base = ledgerSnapshotFixture()
    val quote = requireNotNull(base.dailyQuote)
    return base.copy(
        dailyQuote = quote.copy(
            quote = quote.quote.copy(
                source = "Codex · enterprise-production-shared-account · 《超长上下文评测手册》"
            )
        )
    )
}

@PreviewTest
@Preview(
    name = "Share poster picker 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun SharePosterPicker390Screenshot() {
    val stats = requireNotNull(ledgerSnapshotFixture(range = RangeKey.Week).data)
    SharePosterPreviewHost(
        summary = buildShareSummary(
            stats = stats,
            range = RangeKey.Week,
            costMasked = false,
            generatedAt = Instant.parse("2026-07-15T04:41:00Z")
        ),
        appearance = LedgerAppearance.Dark
    )
}

@PreviewTest
@Preview(
    name = "Achievement poster picker 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun ShareAchievementPoster390Screenshot() {
    SharePosterPreviewHost(
        summary = screenshotShareSummary(),
        appearance = LedgerAppearance.Dark,
        initialLayout = ShareLayoutKey.Achievement
    )
}

@PreviewTest
@Preview(
    name = "Journal poster picker 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun ShareJournalPoster390Screenshot() {
    SharePosterPreviewHost(
        summary = screenshotShareSummary(),
        appearance = LedgerAppearance.Dark,
        initialLayout = ShareLayoutKey.Journal
    )
}

@PreviewTest
@Preview(
    name = "Receipt poster picker 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun ShareReceiptPoster390Screenshot() {
    SharePosterPreviewHost(
        summary = screenshotShareSummary(),
        appearance = LedgerAppearance.Dark,
        initialLayout = ShareLayoutKey.Receipt
    )
}

@PreviewTest
@Preview(
    name = "Signal poster picker 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun ShareSignalPoster390Screenshot() {
    SharePosterPreviewHost(
        summary = screenshotShareSummary(),
        appearance = LedgerAppearance.Dark,
        initialLayout = ShareLayoutKey.Signal
    )
}

/**
 * Export-scale evidence: these are not a scaled picker thumbnail. Each Preview asks the production
 * renderer for the same 1080×1920 bitmap delivered to FileProvider, then captures it 1:1.
 */
@PreviewTest
@Preview(name = "Share scorecard export 1080x1920", device = "spec:width=1080dp,height=1920dp,dpi=160")
@Composable
fun ShareScorecardExport1080Screenshot() = FullSharePosterExport(ShareLayoutKey.Scorecard)

@PreviewTest
@Preview(name = "Share scorecard long hero export 1080x1920", device = "spec:width=1080dp,height=1920dp,dpi=160")
@Composable
fun ShareScorecardLongHeroExport1080Screenshot() = FullSharePosterExport(
    layout = ShareLayoutKey.Scorecard,
    summary = screenshotShareSummary().copy(effectiveTokens = 999_500_000L)
)

@PreviewTest
@Preview(name = "Share journal export 1080x1920", device = "spec:width=1080dp,height=1920dp,dpi=160")
@Composable
fun ShareJournalExport1080Screenshot() = FullSharePosterExport(ShareLayoutKey.Journal)

@PreviewTest
@Preview(name = "Share achievement export 1080x1920", device = "spec:width=1080dp,height=1920dp,dpi=160")
@Composable
fun ShareAchievementExport1080Screenshot() = FullSharePosterExport(ShareLayoutKey.Achievement)

@PreviewTest
@Preview(name = "Share receipt export 1080x1920", device = "spec:width=1080dp,height=1920dp,dpi=160")
@Composable
fun ShareReceiptExport1080Screenshot() = FullSharePosterExport(ShareLayoutKey.Receipt)

@PreviewTest
@Preview(name = "Share receipt long hero export 1080x1920", device = "spec:width=1080dp,height=1920dp,dpi=160")
@Composable
fun ShareReceiptLongHeroExport1080Screenshot() = FullSharePosterExport(
    layout = ShareLayoutKey.Receipt,
    summary = screenshotShareSummary().copy(effectiveTokens = 999_500_000L)
)

@PreviewTest
@Preview(name = "Share receipt long row export 1080x1920", device = "spec:width=1080dp,height=1920dp,dpi=160")
@Composable
fun ShareReceiptLongRowExport1080Screenshot() = FullSharePosterExport(
    layout = ShareLayoutKey.Receipt,
    summary = screenshotShareSummary().copy(topModel = "gpt-5.6-preview-ultra")
)

@PreviewTest
@Preview(name = "Share signal export 1080x1920", device = "spec:width=1080dp,height=1920dp,dpi=160")
@Composable
fun ShareSignalExport1080Screenshot() = FullSharePosterExport(ShareLayoutKey.Signal)

@Composable
private fun FullSharePosterExport(layout: ShareLayoutKey, summary: ShareSummary = screenshotShareSummary()) {
    val context = LocalContext.current
    val bitmap = remember(layout, summary) {
        SharePosterRenderer.render(context, summary, layout)
    }
    Image(
        bitmap = bitmap.asImageBitmap(),
        contentDescription = null,
        contentScale = ContentScale.FillBounds,
        modifier = Modifier.fillMaxSize()
    )
}

@PreviewTest
@Preview(
    name = "Share poster light 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFF5F5F8
)
@Composable
fun SharePosterLight390Screenshot() {
    SharePosterPreviewHost(
        summary = screenshotShareSummary(),
        appearance = LedgerAppearance.Light,
        initialLayout = ShareLayoutKey.Receipt
    )
}

@PreviewTest
@Preview(
    name = "Share poster large text 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun SharePosterFontScale200Screenshot() {
    SharePosterPreviewHost(
        summary = screenshotShareSummary(),
        appearance = LedgerAppearance.Dark,
        initialLayout = ShareLayoutKey.Scorecard
    )
}

private fun screenshotShareSummary(): ShareSummary {
    val stats = requireNotNull(ledgerSnapshotFixture(range = RangeKey.Week).data)
    return buildShareSummary(
        stats = stats,
        range = RangeKey.Week,
        costMasked = false,
        generatedAt = Instant.parse("2026-07-15T04:41:00Z")
    )
}

@PreviewTest
@Preview(
    name = "Refreshing snapshot 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFF4F5FA
)
@Composable
fun LedgerDashboardRefreshing390Screenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Light,
        state = ledgerRefreshingSnapshotFixture()
    )
}

@PreviewTest
@Preview(
    name = "Refreshing filter sheet 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFF4F5FA
)
@Composable
fun LedgerDashboardRefreshingFilterSheet390Screenshot() {
    val previous = ledgerSnapshotFixture(range = RangeKey.Week)
    LedgerDashboardFilterSheetPreviewHost(
        appearance = LedgerAppearance.Light,
        state = previous.copy(
            data = null,
            cachedData = null,
            loadingMode = DashboardLoadingMode.InitialLoad
        ),
        displayedStats = previous.visibleData
    )
}

@PreviewTest
@Preview(
    name = "Long filter identities 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardLongFilterIdentities390Screenshot() {
    val state = ledgerLongSourceIdentitySnapshotFixture()
    LedgerDashboardFilterSheetPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = state,
        displayedStats = state.visibleData
    )
}

@PreviewTest
@Preview(
    name = "Refreshing snapshot 320x720",
    device = "spec:width=320dp,height=720dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF080A0F
)
@Composable
fun LedgerDashboardRefreshing320Screenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerRefreshingSnapshotFixture(range = RangeKey.Today)
    )
}

@PreviewTest
@Preview(
    name = "All token mode 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF080A0F
)
@Composable
fun LedgerDashboardAllTokenScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        tokenDisplayMode = TokenDisplayMode.All
    )
}

@PreviewTest
@Preview(
    name = "Week comparison 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF080A0F
)
@Composable
fun LedgerDashboardWeekComparisonScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerSnapshotFixture(range = RangeKey.Week)
    )
}

@PreviewTest
@Preview(
    name = "Month comparison 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF080A0F
)
@Composable
fun LedgerDashboardMonthComparisonScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerSnapshotFixture(range = RangeKey.Month)
    )
}

@PreviewTest
@Preview(
    name = "Year without comparison 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF080A0F
)
@Composable
fun LedgerDashboardYearWithoutComparisonScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerSnapshotFixture(range = RangeKey.Year)
    )
}

@PreviewTest
@Preview(
    name = "Compact dark 320x720",
    device = "spec:width=320dp,height=720dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF080A0F
)
@Composable
fun LedgerDashboard320CompactScreenshot() {
    LedgerDashboardPreviewHost(LedgerAppearance.Dark)
}

@PreviewTest
@Preview(
    name = "Wide light 430x932",
    device = "spec:width=430dp,height=932dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFF4F5FA
)
@Composable
fun LedgerDashboard430LightScreenshot() {
    LedgerDashboardPreviewHost(LedgerAppearance.Light)
}

@PreviewTest
@Preview(
    name = "Large text dark 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF080A0F
)
@Composable
fun LedgerDashboardFontScale200Screenshot() {
    LedgerDashboardPreviewHost(LedgerAppearance.Dark)
}

@PreviewTest
@Preview(
    name = "E-ink 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFFFFFFF
)
@Composable
fun LedgerDashboardEInkScreenshot() {
    LedgerDashboardPreviewHost(LedgerAppearance.EInk)
}

@PreviewTest
@Preview(
    name = "Tablet rail dark 840x900",
    device = "spec:width=840dp,height=900dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF080A0F
)
@Composable
fun LedgerDashboardTabletRailScreenshot() {
    LedgerDashboardPreviewHost(LedgerAppearance.Dark)
}

@PreviewTest
@Preview(
    name = "Landscape overview 844x390",
    device = "spec:width=844dp,height=390dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardLandscapeScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        forceLandscape = true
    )
}

@PreviewTest
@Preview(
    name = "Insights trend 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardInsightsScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        destination = MobileDestination.Usage,
        insightPane = InsightPane.Trend
    )
}

@PreviewTest
@Preview(
    name = "Insights data bars 390x1280",
    device = "spec:width=390dp,height=1280dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Preview(name = "Insights large values 320 font200", device = "spec:width=320dp,height=2200dp,dpi=160", fontScale = 2.0f, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun LedgerDashboardInsightsDataBarsScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        destination = MobileDestination.Usage,
        insightPane = InsightPane.Trend
    )
}

@PreviewTest
@Preview(
    name = "Insights source comparisons 390x1280",
    device = "spec:width=390dp,height=1280dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardInsightsSourcesScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        destination = MobileDestination.Usage,
        insightPane = InsightPane.Sources
    )
}

@PreviewTest
@Preview(
    name = "Insights source comparisons 320x1000",
    device = "spec:width=320dp,height=1000dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardInsightsSourcesCompactScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        destination = MobileDestination.Usage,
        insightPane = InsightPane.Sources
    )
}

@PreviewTest
@Preview(
    name = "Model amount toggle 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardModelAmountToggleScreenshot() {
    val stats = ledgerSnapshotFixture().visibleData ?: return
    V2ModelDistributionPreviewContent(LedgerAppearance.Dark, stats, showCost = true)
}

@PreviewTest
@Preview(
    name = "Model metric toggle large text 390x1000",
    device = "spec:width=390dp,height=1000dp,dpi=160",
    fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardModelMetricToggleLargeTextScreenshot() {
    val stats = ledgerSnapshotFixture().visibleData ?: return
    V2ModelDistributionPreviewContent(LedgerAppearance.Dark, stats, showCost = false)
}

@PreviewTest
@Preview(
    name = "Insights calendar comparisons 390x1280",
    device = "spec:width=390dp,height=1280dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardInsightsCalendarScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        destination = MobileDestination.Usage,
        insightPane = InsightPane.Calendar
    )
}

@PreviewTest
@Preview(
    name = "Insights calendar selected day 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardInsightsCalendarSelectedDayScreenshot() {
    val stats = ledgerSnapshotFixture(range = RangeKey.Month).visibleData ?: return
    V2InsightCalendarPreviewContent(
        appearance = LedgerAppearance.Dark,
        stats = stats,
        initialSelectedDate = "2026-07-14"
    )
}

@PreviewTest
@Preview(
    name = "Calendar day large text 390x1000",
    device = "spec:width=390dp,height=1000dp,dpi=160",
    fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardInsightsCalendarSelectedDayLargeTextScreenshot() {
    val stats = ledgerSnapshotFixture(range = RangeKey.Month).visibleData ?: return
    V2InsightCalendarPreviewContent(
        appearance = LedgerAppearance.Dark,
        stats = stats,
        initialSelectedDate = "2026-07-14"
    )
}

@PreviewTest
@Preview(
    name = "Custom date range dialog large text 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    fontScale = 2.0f,
    locale = "zh-rCN",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardCustomDateRangeDialogLargeTextScreenshot() {
    V2CustomRangeDialogPreviewContent(LedgerAppearance.Dark)
}

@PreviewTest
@Preview(
    name = "Calendar invalid zone 320x844",
    device = "spec:width=320dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardInsightsCalendarUntrustedTimezoneScreenshot() {
    val base = ledgerSnapshotFixture()
    val stats = base.visibleData ?: return
    val state = base.copy(data = stats.copy(meta = stats.meta?.copy(timezone = "Mars/Olympus")))
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = state,
        destination = MobileDestination.Usage,
        insightPane = InsightPane.Calendar
    )
}

@PreviewTest
@Preview(
    name = "Insights pagination error 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardInsightsPaginationErrorScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerPaginationErrorSnapshotFixture(),
        destination = MobileDestination.Usage,
        insightPane = InsightPane.Details
    )
}

@PreviewTest
@Preview(
    name = "Quota 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardQuotaScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerStaleQuotaSnapshotFixture(),
        destination = MobileDestination.Quota
    )
}

@PreviewTest
@Preview(
    name = "Quota fresh 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardQuotaFreshScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerFreshQuotaSnapshotFixture(),
        destination = MobileDestination.Quota
    )
}

@PreviewTest
@Preview(
    name = "Quota long labels large text 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardQuotaLongLabelsLargeTextScreenshot() {
    val base = ledgerFreshQuotaSnapshotFixture()
    val available = base.quota as QuotaUiState.Available
    val providerId = "custom-team-openapi-long-name"
    val longProvider = available.snapshot.providers.first().copy(
        providerId = providerId,
        displayName = "团队共享 OpenAPI 额度 · 北美研发账号",
        windows = available.snapshot.providers.first().windows.mapIndexed { index, window ->
            window.copy(
                providerId = providerId,
                windowId = "rolling-custom-$index",
                windowLabel = if (index == 0) {
                    "团队滚动额度（每日刷新）"
                } else {
                    "项目周期额度（跨区域共享）"
                },
                windowMinutes = null
            )
        }
    )
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = base.copy(
            quota = available.copy(
                snapshot = available.snapshot.copy(providers = listOf(longProvider))
            )
        ),
    destination = MobileDestination.Quota
    )
}

@PreviewTest
@Preview(
    name = "Quota long labels regular 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardQuotaLongLabelsRegularScreenshot() {
    val base = ledgerFreshQuotaSnapshotFixture()
    val available = base.quota as QuotaUiState.Available
    val providerId = "custom-team-openapi-long-name"
    val longProvider = available.snapshot.providers.first().copy(
        providerId = providerId,
        displayName = "团队共享 OpenAPI 额度 · 北美研发账号",
        windows = available.snapshot.providers.first().windows.mapIndexed { index, window ->
            window.copy(
                providerId = providerId,
                windowId = "rolling-custom-$index",
                windowLabel = if (index == 0) {
                    "团队滚动额度（每日刷新）"
                } else {
                    "项目周期额度（跨区域共享）"
                },
                windowMinutes = null
            )
        }
    )
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = base.copy(
            quota = available.copy(
                snapshot = available.snapshot.copy(providers = listOf(longProvider))
            )
        ),
        destination = MobileDestination.Quota
    )
}

@PreviewTest
@Preview(
    name = "Quota pending source 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardQuotaPendingSourceScreenshot() {
    val base = ledgerFreshQuotaSnapshotFixture()
    val available = base.quota as QuotaUiState.Available
    val pending = available.snapshot.providers.first().copy(
        providerId = "google-antigravity-consumer",
        displayName = "Antigravity",
        status = QuotaProviderStatus.AuthRequired,
        windows = emptyList(),
        reasonCode = "local_authorization_required"
    )
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = base.copy(
            quota = available.copy(
                snapshot = available.snapshot.copy(
                    providers = listOf(available.snapshot.providers.first(), pending)
                )
            )
        ),
        destination = MobileDestination.Quota
    )
}

@PreviewTest
@Preview(
    name = "Quota error 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardQuotaErrorScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerErrorQuotaSnapshotFixture(),
        destination = MobileDestination.Quota
    )
}

@PreviewTest
@Preview(
    name = "Quota unavailable recovery 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardQuotaUnavailableRecoveryScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerUnavailableQuotaSnapshotFixture(),
        destination = MobileDestination.Quota
    )
}

@PreviewTest
@Preview(
    name = "Quota recovery refreshing 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardQuotaRecoveryRefreshingScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerUnavailableQuotaRefreshingSnapshotFixture(),
        destination = MobileDestination.Quota
    )
}

@PreviewTest
@Preview(
    name = "Quota empty 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardQuotaEmptyScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerEmptyQuotaSnapshotFixture(),
        destination = MobileDestination.Quota
    )
}

@PreviewTest
@Preview(
    name = "Quota login required 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardQuotaLoginRequiredScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerLoginRequiredQuotaSnapshotFixture(),
        destination = MobileDestination.Quota
    )
}

@PreviewTest
@Preview(
    name = "V2 tool detail 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardV2EntityScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerEntitySnapshotFixture()
    )
}

@PreviewTest
@Preview(
    name = "V2 long entity title large text 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardV2LongEntityTitleLargeTextScreenshot() {
    val base = ledgerEntitySnapshotFixture()
    val stats = requireNotNull(base.data)
    val entityDashboard = requireNotNull(stats.entityDashboard)
    val longId = "openai-codex-local · gpt-5.6-preview-ultra · 工作环境"
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = base.copy(
            entity = DashboardEntity(DashboardEntity.TOOL, longId),
            data = stats.copy(
                entityDashboard = entityDashboard.copy(
                    entity = entityDashboard.entity.copy(id = longId)
                )
            )
        )
    )
}

@PreviewTest
@Preview(
    name = "V2 tool detail comparisons 390x1600",
    device = "spec:width=390dp,height=1600dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardV2EntityComparisonsScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        state = ledgerEntitySnapshotFixture()
    )
}

@PreviewTest
@Preview(
    name = "E-ink widget 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFFFFFFF
)
@Composable
fun LedgerDashboardEInkWidgetScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.EInk,
        destination = MobileDestination.Me,
        ambientMode = AmbientMode.Ledger
    )
}

@PreviewTest
@Preview(
    name = "Widget large text 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    fontScale = 2.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF080A0F
)
@Composable
fun LedgerDashboardWidgetFontScale200Screenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        destination = MobileDestination.Me,
        ambientMode = AmbientMode.Console
    )
}

@PreviewTest
@Preview(
    name = "Landscape settings 844x390",
    device = "spec:width=844dp,height=390dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LedgerDashboardLandscapeSettingsScreenshot() {
    LedgerDashboardPreviewHost(
        appearance = LedgerAppearance.Dark,
        forceLandscape = true,
        settingsVisible = true
    )
}

@PreviewTest
@Preview(
    name = "Low power snapshot 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF080A0F
)
@Composable
fun LowPowerDisplay390Screenshot() {
    LowPowerDisplayPreviewHost(LedgerAppearance.Dark)
}

@PreviewTest
@Preview(
    name = "E-ink full-screen widget 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFFFFFFF
)
@Composable
fun LowPowerDisplayEInk390Screenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.EInk,
        ambientMode = AmbientMode.Ledger
    )
}

@PreviewTest
@Preview(
    name = "E-ink theme console mode 998x748",
    device = "spec:width=998dp,height=748dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFFFFFFF
)
@Composable
fun LowPowerDisplayEInkThemeConsoleLandscapeScreenshot() {
    // 配色轴 × 模式轴的交叉证据：E-ink 调色板下即便选了信息最密的 Console，
    // 渲染仍必须走 E-ink 画风（描边/无填充/阶梯柱），而不是被降级成低密度档。
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.EInk,
        ambientMode = AmbientMode.Console
    )
}

@PreviewTest
@Preview(
    name = "Dark theme ledger mode 998x748",
    device = "spec:width=998dp,height=748dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayDarkThemeLedgerLandscapeScreenshot() {
    // 反向交叉证据：深色调色板 + Ledger 模式。版式来自模式，配色来自主题，两者不得互相夺权。
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Ledger
    )
}

@PreviewTest
@Preview(
    name = "Ambient console mode 1194x834",
    device = "spec:width=1194dp,height=834dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayAmbientConsoleLandscapeScreenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Console
    )
}

// D1–D5 每档至少一张 golden：五个模式若渲染出相同像素，说明"分档"只是设置页上的谎言。
@PreviewTest
@Preview(
    name = "Ambient glance mode 1194x834",
    device = "spec:width=1194dp,height=834dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayAmbientGlanceLandscapeScreenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Glance
    )
}

@PreviewTest
@Preview(
    name = "Ambient pulse mode 1194x834",
    device = "spec:width=1194dp,height=834dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayAmbientPulseLandscapeScreenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Pulse
    )
}

@PreviewTest
@Preview(
    name = "Ambient pulse no series 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayAmbientPulseNoSeriesScreenshot() {
    // 断网读本机快照时的真实状态：汇总在、序列空。节奏档整屏就是那张图，图占 weight(1f)，
    // 此前它在这种状态下只在正中横一条 divider 线、一个字都不说——真机上那条假线横跨了
    // 近七成屏幕。这张图钉住的是：不画线、写出"当前范围暂无 Token 趋势"、
    // 并且不留下"本期"图例替不存在的曲线背书。
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Pulse,
        state = ledgerNoSeriesSnapshotFixture().copy(lowPowerDisplayVisible = true)
    )
}

@PreviewTest
@Preview(
    name = "Ambient console widget bands 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayAmbientConsoleWidgetBandsScreenshot() {
    // 全息档竖屏走的是 V2WidgetPreview，那排额度胶囊就是**挂件预览**。
    // 它按挂件那把尺分档（<20% 危 / <50% 警 / 其余正常，严格小于；
    // 分档最早见 T10.133 第五批，阈值由 T10.152/D4 统一为 20/50），
    // 但此前所有夹具都老到被判成 Stale，三档颜色一档也没拍下来过。
    // golden 会随本次阈值调整变化：3%/35% 落 Danger/Warn、65%/90% 落 Normal
    // （旧阈值下是 3% Danger、15% Warn、45%/80% Normal），像素回归按 ADR-007
    // 在 macOS runner 生成与验证。
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Console,
        state = ledgerWidgetBandQuotaSnapshotFixture().copy(lowPowerDisplayVisible = true)
    )
}

@PreviewTest
@Preview(
    name = "Ambient console no series 390x844",
    device = "spec:width=390dp,height=844dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayAmbientConsoleNoSeriesScreenshot() {
    // 同一状态下的全息档：它走的是另一条渲染路径（V2WidgetPreview → V2TrendChart），
    // 空态文案本来就有。放在这里是为了两档并排比对——摆件页的预览卡按 elements 拼版，
    // 全息档的真身却是旧的 V2WidgetPreview，两者本来就不是同一张脸（见打磨记录）。
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Console,
        state = ledgerNoSeriesSnapshotFixture().copy(lowPowerDisplayVisible = true)
    )
}

@PreviewTest
@Preview(
    name = "Ambient quota wall mode 1194x834",
    device = "spec:width=1194dp,height=834dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayAmbientQuotaWallLandscapeScreenshot() {
    // 额度墙的验收点是"一个窗口都不藏"：Antigravity 有 4 个窗口，这张图必须四个都在。
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.QuotaWall
    )
}

@PreviewTest
@Preview(
    name = "Ambient widget compact single quota 844x390",
    device = "spec:width=844dp,height=390dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayAmbientCompactSingleQuotaScreenshot() {
    val base = ledgerSnapshotFixture()
    val quota = base.quota as QuotaUiState.Available
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Console,
        state = base.copy(
            lowPowerDisplayVisible = true,
            quota = quota.copy(
                snapshot = quota.snapshot.copy(
                    providers = quota.snapshot.providers.filter {
                        it.providerId.contains("codex", ignoreCase = true)
                    }
                )
            )
        )
    )
}

// T6.6：来自两台真实连接设备的 Compose 可用视口，不用物理像素尺寸冒充 dp。
@PreviewTest
@Preview(
    name = "OPPO console 960x633",
    device = "spec:width=960dp,height=633dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayOppoConsoleScreenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Console
    )
}

@PreviewTest
@Preview(
    name = "OPPO ledger 960x633",
    device = "spec:width=960dp,height=633dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayOppoLedgerScreenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.Ledger
    )
}

@PreviewTest
@Preview(
    name = "OPPO quota wall 960x633",
    device = "spec:width=960dp,height=633dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
fun LowPowerDisplayOppoQuotaWallScreenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.Dark,
        ambientMode = AmbientMode.QuotaWall
    )
}

@PreviewTest
@Preview(
    name = "E-ink reader console 998x701",
    device = "spec:width=998dp,height=701dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFFFFFFF
)
@Composable
fun LowPowerDisplayEInkReaderConsoleScreenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.EInk,
        ambientMode = AmbientMode.Console
    )
}

@PreviewTest
@Preview(
    name = "E-ink reader ledger 998x701",
    device = "spec:width=998dp,height=701dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFFFFFFF
)
@Composable
fun LowPowerDisplayEInkReaderLedgerScreenshot() {
    LowPowerDisplayPreviewHost(
        appearance = LedgerAppearance.EInk,
        ambientMode = AmbientMode.Ledger
    )
}

// T10.118a: exact date-only matrix; synthetic source with trusted range/timezone echo.
@PreviewTest
@Preview(name = "Date calendar 390 f100 Light", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1.0f, locale = "zh-rCN", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Preview(name = "Date calendar 390 f100 Dark", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1.0f, locale = "zh-rCN", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Date calendar 390 f150 Light", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1.5f, locale = "zh-rCN", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Preview(name = "Date calendar 390 f150 Dark", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 1.5f, locale = "zh-rCN", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Date calendar 390 f200 Light", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 2.0f, locale = "zh-rCN", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Preview(name = "Date calendar 390 f200 Dark", device = "spec:width=390dp,height=844dp,dpi=160", fontScale = 2.0f, locale = "zh-rCN", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Date calendar 320 f200 Light", device = "spec:width=320dp,height=844dp,dpi=160", fontScale = 2.0f, locale = "zh-rCN", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Preview(name = "Date calendar 320 f200 Dark", device = "spec:width=320dp,height=844dp,dpi=160", fontScale = 2.0f, locale = "zh-rCN", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Date calendar 430 f200 Light", device = "spec:width=430dp,height=844dp,dpi=160", fontScale = 2.0f, locale = "zh-rCN", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Preview(name = "Date calendar 430 f200 Dark", device = "spec:width=430dp,height=844dp,dpi=160", fontScale = 2.0f, locale = "zh-rCN", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun T10118DateCalendarMatrixScreenshot() {
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    val stats = ledgerSnapshotFixture(range = RangeKey.Month).visibleData ?: return
    V2InsightCalendarPreviewContent(
        appearance = if (dark) LedgerAppearance.Dark else LedgerAppearance.Light,
        stats = stats,
        initialSelectedDate = "2026-07-14"
    )
}

@PreviewTest
@Preview(name = "Model cost USD 390", device = "spec:width=390dp,height=844dp,dpi=160")
@Composable
fun T10136ModelCurrencyScreenshot() {
    val stats = ledgerSnapshotFixture().visibleData ?: return
    V2ModelDistributionPreviewContent(LedgerAppearance.Light, stats, true, CurrencyUnit.USD)
}

@PreviewTest
@Preview(name = "Model cost masked 320 large text", device = "spec:width=320dp,height=1000dp,dpi=160", fontScale = 2f)
@Composable
fun T10136ModelMaskedScreenshot() {
    val stats = ledgerSnapshotFixture().visibleData ?: return
    V2ModelDistributionPreviewContent(LedgerAppearance.Dark, stats, true, CurrencyUnit.USD, costMasked = true)
}
