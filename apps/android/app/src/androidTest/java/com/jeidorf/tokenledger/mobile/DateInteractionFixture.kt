package com.jeidorf.tokenledger.mobile

import android.graphics.Bitmap
import android.os.Bundle
import android.os.SystemClock
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.printToString
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.time.ZoneId
import org.json.JSONArray
import org.json.JSONObject
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.unit.Density
import androidx.lifecycle.viewModelScope
import java.io.IOException
import java.time.Instant
import java.time.LocalDate
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel

internal object DateInteractionFixture {
    const val TIMEZONE = "Asia/Shanghai"
    const val CUTOFF_DATE = "2026-07-15"
    const val EARLY_DATE = "2026-01-15"
    const val RECENT_DATE = "2026-07-12"
    const val FUTURE_DATE = "2026-07-16"
    const val GLOBAL_TOKENS = 900L
    const val EARLY_DAY_TOKENS = 111L
    const val RECENT_DAY_TOKENS = 222L
    val FIXED_NOW_MILLIS: Long = Instant.parse("2026-07-15T04:00:00Z").toEpochMilli()

    val session = MobileSession(
        accessToken = "fixture-access",
        refreshToken = "fixture-refresh",
        userId = "fixture-user",
        email = "fixture@example.invalid",
        expiresAtEpochSeconds = 4_102_444_800L
    )

    /**
     * A reusable static host for bounds tests. This is the real production screen; only the
     * environment and event callbacks are supplied by the test.
     */
    @Composable
    fun RealDateScreen(
        state: DashboardUiState,
        appearance: LedgerAppearance = LedgerAppearance.Light,
        fontScale: Float? = null,
        onRangeChange: (RangeKey) -> Unit = {},
        onMachineChange: (String) -> Unit = {},
        onToolChange: (String?) -> Unit = {},
        onModelChange: (String?) -> Unit = {},
        onSearchChange: (String?) -> Unit = {},
        onClearFilters: () -> Unit = {},
        onSectionChange: (DashboardSection) -> Unit = {},
        onContributionModeChange: (ContributionMode) -> Unit = {},
        onOpenTool: (String) -> Unit = {},
        onOpenModel: (String) -> Unit = {},
        onCustomRangeChange: (String, String) -> Unit = { _, _ -> },
        onOpenDay: (String) -> Boolean = { false },
        onReturnFromDay: () -> Unit = {},
        onBack: () -> Unit = {},
        onRefresh: () -> Unit = {},
        initialDestination: MobileDestination = MobileDestination.Usage,
        initialInsightPane: InsightPane = InsightPane.Calendar
    ) {
        val density = LocalDensity.current
        val testDensity = fontScale?.let { Density(density.density, it) } ?: density
        CompositionLocalProvider(LocalDensity provides testDensity) {
            TokenLedgerTheme(appearance) {
                ProvideLedgerPalette(appearance) {
                    LedgerDashboardV2Screen(
                        state = state,
                        appearance = appearance,
                        forceLandscape = false,
                        tokenDisplayMode = TokenDisplayMode.Effective,
                        ambientMode = AmbientMode.Glance,
                        onForceLandscapeChange = {},
                        onTokenDisplayModeChange = {},
                        onAmbientModeChange = {},
                        onRangeChange = onRangeChange,
                        onMachineChange = onMachineChange,
                        onToolChange = onToolChange,
                        onModelChange = onModelChange,
                        onSearchChange = onSearchChange,
                        onClearFilters = onClearFilters,
                        onSectionChange = onSectionChange,
                        onContributionModeChange = onContributionModeChange,
                        onOpenTool = onOpenTool,
                        onOpenModel = onOpenModel,
                        onBack = onBack,
                        onLoadMore = {},
                        onAppearanceChange = {},
                        onOpenLowPowerDisplay = {},
                        onRefresh = onRefresh,
                        onSignOut = {},
                        onCustomRangeChange = onCustomRangeChange,
                        onOpenDay = onOpenDay,
                        onReturnFromDay = onReturnFromDay,
                        initialDestination = initialDestination,
                        initialInsightPane = initialInsightPane
                    )
                }
            }
        }
    }

    fun createHarness(
        rule: ComposeContentTestRule,
        appearance: LedgerAppearance = LedgerAppearance.Light,
        fontScale: Float? = null,
        cache: FakeCache = FakeCache(),
        initialDestination: MobileDestination = MobileDestination.Usage,
        initialInsightPane: InsightPane = InsightPane.Calendar,
        diagnosticTestId: String? = null
    ): Harness {
        val source = FakeDataSource()
        val viewModel = DashboardViewModel(
            repository = source,
            cache = cache,
            dailyQuoteRepository = FixedDailyQuoteSource,
            timeProvider = FixedTimeProvider,
            automaticRefreshEnabled = false,
            quotaFreshnessSchedulingEnabled = false
        )
        val initialSection = when (initialDestination) {
            MobileDestination.Usage -> initialInsightPane.dashboardSection()
            MobileDestination.Routing, MobileDestination.Quota, MobileDestination.Me -> DashboardSection.Overview
        }
        val diagnostics = diagnosticTestId?.let { DateInteractionDiagnostics(rule, viewModel, source, it) }
        val harness = Harness(rule, viewModel, source, cache, initialSection, diagnostics)
        rule.setContent {
            val state by viewModel.uiState.collectAsState()
            RealDateScreen(
                state = state,
                appearance = appearance,
                fontScale = fontScale,
                onRangeChange = viewModel::selectRange,
                onMachineChange = viewModel::selectMachine,
                onToolChange = viewModel::selectTool,
                onModelChange = viewModel::selectModel,
                onSearchChange = viewModel::setSearch,
                onClearFilters = viewModel::clearFilters,
                onSectionChange = viewModel::selectSection,
                onContributionModeChange = viewModel::selectContributionMode,
                onOpenTool = viewModel::openTool,
                onOpenModel = viewModel::openModel,
                onCustomRangeChange = viewModel::selectCustomRange,
                onOpenDay = { date -> harness.openDay(date) },
                onReturnFromDay = viewModel::returnFromDayDetails,
                onBack = viewModel::navigateBack,
                onRefresh = viewModel::refresh,
                initialDestination = initialDestination,
                initialInsightPane = initialInsightPane
            )
        }
        return harness
    }

    fun stats(
        query: DashboardQuery,
        tokens: Long = if (query.range == RangeKey.Custom) {
            when (query.start) {
                EARLY_DATE -> EARLY_DAY_TOKENS
                RECENT_DATE -> RECENT_DAY_TOKENS
                else -> 1L
            }
        } else GLOBAL_TOKENS
    ): StatsData = StatsData(
        summary = Summary(
            totalTokens = tokens + 37L,
            inputTokens = tokens,
            cachedTokens = 37L,
            totalRequests = 3L
        ),
        tools = emptyMap(),
        models = emptyMap(),
        trends = emptyList(),
        heatmap = mapOf(EARLY_DATE to EARLY_DAY_TOKENS, RECENT_DATE to RECENT_DAY_TOKENS),
        history = emptyList(),
        machines = listOf("fixture-machine"),
        meta = StatsMeta(
            generatedAt = "${CUTOFF_DATE}T12:00:00+08:00",
            lastRefreshedAt = "${CUTOFF_DATE}T11:59:00+08:00",
            timezone = TIMEZONE,
            range = query.range.rpcValue,
            machine = query.machine,
            stale = false,
            contractVersion = 2,
            query = StatsQueryEcho(
                range = query.range.rpcValue,
                timezone = TIMEZONE,
                machines = query.machines,
                tools = query.tools,
                models = query.models,
                search = query.search,
                start = query.start,
                end = query.end,
                tokenMode = query.tokenMode
            )
        ),
        capabilities = DashboardCapabilities(details = true, multiFilterSearch = true)
    )

    fun globalState(
        query: DashboardQuery = DashboardQuery(range = RangeKey.Year),
        loadingMode: DashboardLoadingMode = DashboardLoadingMode.Idle,
        showingCachedData: Boolean = false,
        lastUpdatedEpochMillis: Long = FIXED_NOW_MILLIS
    ): DashboardUiState = DashboardUiState(
        configured = true,
        sessionState = DashboardSessionState.Authenticated(session),
        query = query,
        data = stats(query).takeUnless { showingCachedData },
        cachedData = stats(query).takeIf { showingCachedData },
        loadingMode = loadingMode,
        lastUpdatedEpochMillis = lastUpdatedEpochMillis,
        showingCachedData = showingCachedData,
        section = DashboardSection.Trends
    )

    internal object FixedTimeProvider : DashboardTimeProvider {
        override fun nowEpochMillis(): Long = FIXED_NOW_MILLIS
        override fun currentDate(): LocalDate = LocalDate.parse(CUTOFF_DATE)
        override fun timezoneId(): String = TIMEZONE
        override fun millisUntilNextMidnight(): Long = 43_200_000L
    }

    private object FixedDailyQuoteSource : DailyQuoteDataSource {
        override suspend fun quoteFor(date: LocalDate): DailyQuote = dailyQuoteFor(date)
    }
}

internal class Harness(
    private val rule: ComposeContentTestRule,
    val viewModel: DashboardViewModel,
    val source: FakeDataSource,
    val cache: FakeCache,
    private val initialSection: DashboardSection,
    private val diagnostics: DateInteractionDiagnostics? = null
) {
    @Volatile
    var openDayOverride: ((String) -> Boolean)? = null
    private var initialSectionApplied = false

    fun openDay(date: String): Boolean {
        val overrideCallback = openDayOverride
        return observeOpenDay("ui-callback", date, overrideCallback != null) {
            overrideCallback?.invoke(date) ?: openDayDetailsObserved(date, "ui")
        }
    }

    fun openDayDetailsObserved(date: String, route: String): Boolean =
        observeOpenDay("vm-$route", date, openDayOverride != null) { viewModel.openDayDetails(date) }

    private fun observeOpenDay(stage: String, date: String, overridden: Boolean, action: () -> Boolean): Boolean {
        diagnostics?.record("$stage-enter") {
            JSONObject().put("date", date).put("overrideEnabled", overridden)
        }
        try {
            val accepted = action()
            diagnostics?.record("$stage-return") {
                JSONObject().put("date", date).put("overrideEnabled", overridden).put("accepted", accepted)
            }
            return accepted
        } catch (failure: Throwable) {
            diagnostics?.record("$stage-throw") {
                JSONObject().put("date", date).put("exceptionType", failure.javaClass.name)
                    .put("exceptionMessage", failure.message ?: JSONObject.NULL)
            }
            throw failure
        }
    }

    fun observedClick(node: SemanticsNodeInteraction, date: String, attempt: String, scrollFirst: Boolean) {
        diagnostics?.beginAttempt(attempt, date, node)
        try {
            if (scrollFirst) node.performScrollTo()
            diagnostics?.captureFrame("before-click")
            node.performClick()
            diagnostics?.record("click-return")
        } catch (failure: Throwable) {
            diagnostics?.failureFrame("action-failed", failure)
            throw failure
        }
    }

    fun awaitReady() {
        rule.waitUntil(5_000) {
            viewModel.uiState.value.loadingMode == DashboardLoadingMode.Idle &&
                viewModel.uiState.value.visibleData != null
        }
        if (!initialSectionApplied) {
            rule.runOnIdle { viewModel.selectSection(initialSection) }
            initialSectionApplied = true
        }
    }

    fun selectYearAndAwait() {
        rule.runOnIdle { viewModel.selectRange(RangeKey.Year) }
        awaitReady()
    }

    fun awaitQuery(range: RangeKey, start: String? = null) {
        diagnostics?.record("await-query-enter") {
            JSONObject().put("expectedRange", range.name).put("expectedStart", start ?: JSONObject.NULL)
        }
        try {
            rule.waitUntil(5_000) {
                val state = viewModel.uiState.value
                state.query.range == range && state.query.start == start
            }
            diagnostics?.record("await-query-success")
        } catch (failure: Throwable) {
            diagnostics?.failureFrame("await-query-failed", failure)
            throw failure
        }
    }

    fun close() {
        try {
            diagnostics?.record("teardown")
        } finally {
            viewModel.viewModelScope.cancel()
        }
    }
}

/** Optional fixture-only tracing. Callback records never synchronize with or traverse Compose. */
internal class DateInteractionDiagnostics(
    private val rule: ComposeContentTestRule,
    private val viewModel: DashboardViewModel,
    private val source: FakeDataSource,
    private val testId: String
) {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val output = File(instrumentation.targetContext.filesDir, "t10-118q")
    private val prefix = "date-diag-$testId-${SystemClock.elapsedRealtimeNanos()}"
    private var sequence = 0
    private var artifactSequence = 0
    private var attemptNumber = 0
    @Volatile private var attempt = "setup"
    @Volatile private var incomplete = false
    private var target: SemanticsNodeInteraction? = null
    private var targetDate: String? = null

    init {
        require(testId.matches(Regex("[a-z0-9-]+")))
        record("created")
    }

    fun beginAttempt(label: String, date: String, node: SemanticsNodeInteraction) {
        attempt = "${++attemptNumber}-$label"
        target = node
        targetDate = date
        record("attempt-enter") { JSONObject().put("requestedDate", date) }
    }

    // Each event is closed before returning, including the records immediately around the VM call.
    // Failures go to the instrumentation stream and the next event; they never replace test errors.
    @Synchronized
    fun record(stage: String, details: () -> JSONObject = { JSONObject() }) {
        val seq = ++sequence
        try {
            val event = JSONObject().put("testId", testId).put("attempt", attempt).put("seq", seq)
                .put("stage", stage).put("fixture", true).put("diagnosticsIncomplete", incomplete)
                .put("elapsedRealtimeNanos", SystemClock.elapsedRealtimeNanos())
                .put("thread", Thread.currentThread().name).put("clocks", clocks())
                .put("state", state()).put("details", details())
            check(output.isDirectory || output.mkdirs()) { "diagnostic directory unavailable" }
            File(output, "$prefix-events.jsonl").appendText("$event\n")
            emit("T10.118q diagnostic $testId $attempt $seq $stage $prefix-events.jsonl incomplete=$incomplete\n")
        } catch (failure: Throwable) {
            incomplete = true
            emit("T10.118q diagnostic-incomplete $testId $attempt $seq $stage ${failure.javaClass.name}\n")
        }
    }

    private fun emit(message: String) {
        // Auxiliary status only; no class/test/count fields that could masquerade as a test result.
        try {
            instrumentation.sendStatus(0, Bundle().apply { putString("stream", message) })
        } catch (_: Throwable) {
            incomplete = true
        }
    }

    fun failureFrame(stage: String, failure: Throwable) {
        record(stage) {
            JSONObject().put("exceptionType", failure.javaClass.name)
                .put("exceptionMessage", failure.message ?: JSONObject.NULL)
        }
        captureFrame("$stage-final")
    }

    // Only the test thread calls this, once before a click and best-effort after a failed action/wait.
    fun captureFrame(stage: String) {
        record("$stage-enter")
        try {
            val node = requireNotNull(target)
            val matches = rule.onAllNodes(hasContentDescription(requireNotNull(targetDate), substring = true))
                .fetchSemanticsNodes()
            val root = rule.onRoot().fetchSemanticsNode()
            val full = if (matches.size == 1) node.getUnclippedBoundsInRoot() else null
            val density = rule.density.density
            val geometry = JSONObject().put("requestedDate", targetDate).put("matchCount", matches.size)
                .put("density", density).put("fontScale", rule.density.fontScale)
                .put("viewport", nodeJson(root)).put("matches", JSONArray(matches.map(::nodeJson)))
                .put("targetUnclippedDp", full?.let {
                    JSONArray(listOf(it.left.value, it.top.value, it.right.value, it.bottom.value))
                } ?: JSONObject.NULL)
                .put("targetUnclippedPx", full?.let {
                    JSONArray(listOf(it.left.value * density, it.top.value * density,
                        it.right.value * density, it.bottom.value * density))
                } ?: JSONObject.NULL)
                .put("ancestors", JSONArray(matches.map { match ->
                    JSONObject().put("targetId", match.id).put("chain", JSONArray(
                        generateSequence(match.parent) { it.parent }.map(::nodeJson).toList()
                    ))
                }))
            record("$stage-geometry") { geometry }
        } catch (failure: Throwable) {
            incomplete = true
            record("$stage-geometry-incomplete") {
                JSONObject().put("exceptionType", failure.javaClass.name)
            }
        }
        saveArtifact(stage, "tree.txt") { file ->
            file.writeText(rule.onRoot(useUnmergedTree = true).printToString(maxDepth = Int.MAX_VALUE))
        }
        saveArtifact(stage, "frame.png") { file ->
            file.outputStream().use { stream ->
                check(rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, stream))
            }
        }
    }

    private fun saveArtifact(stage: String, suffix: String, write: (File) -> Unit) {
        val name = "$prefix-$attempt-${++artifactSequence}-$stage-$suffix"
        val pending = File(output, "$name.pending")
        val destination = File(output, name)
        var ownsPending = false
        try {
            check(output.isDirectory || output.mkdirs()) { "diagnostic directory unavailable" }
            check(!destination.exists() && pending.createNewFile()) { "diagnostic filename collision" }
            ownsPending = true
            write(pending)
            check(pending.renameTo(destination)) { "diagnostic artifact publication failed" }
            record("$stage-artifact") { JSONObject().put("path", "t10-118q/$name") }
        } catch (failure: Throwable) {
            incomplete = true
            val pendingRetained = ownsPending && runCatching { pending.exists() && !pending.delete() }.getOrDefault(true)
            record("$stage-artifact-incomplete") {
                JSONObject().put("intendedName", name).put("exceptionType", failure.javaClass.name)
                    .put("pendingRetained", pendingRetained)
            }
        }
    }

    private fun nodeJson(node: SemanticsNode): JSONObject = JSONObject()
        .put("id", node.id).put("boundsInRootPx", rect(node.boundsInRoot))
        .put("semantics", node.config.toString())
        .put("hasOnClick", node.config.contains(SemanticsActions.OnClick))
        .put("onClickLabel", node.config.getOrNull(SemanticsActions.OnClick)?.label ?: JSONObject.NULL)
        .put("disabled", node.config.contains(SemanticsProperties.Disabled))
        .put("horizontalScroll", node.config.getOrNull(SemanticsProperties.HorizontalScrollAxisRange)?.let {
            JSONObject().put("value", it.value()).put("maxValue", it.maxValue()).put("reverseScrolling", it.reverseScrolling)
        } ?: JSONObject.NULL)
        .put("verticalScroll", node.config.getOrNull(SemanticsProperties.VerticalScrollAxisRange)?.let {
            JSONObject().put("value", it.value()).put("maxValue", it.maxValue()).put("reverseScrolling", it.reverseScrolling)
        } ?: JSONObject.NULL)

    private fun rect(value: Rect): JSONArray = JSONArray(listOf(value.left, value.top, value.right, value.bottom))

    private fun clocks(): JSONObject = JSONObject()
        .put("fixtureEpochMillis", DateInteractionFixture.FixedTimeProvider.nowEpochMillis())
        .put("fixtureDate", DateInteractionFixture.FixedTimeProvider.currentDate().toString())
        .put("fixtureTimezone", DateInteractionFixture.FixedTimeProvider.timezoneId())
        .put("deviceEpochMillis", System.currentTimeMillis())
        .put("deviceDate", LocalDate.now().toString()).put("deviceTimezone", ZoneId.systemDefault().id)

    private fun query(value: DashboardQuery): JSONObject = JSONObject()
        .put("range", value.range.name).put("start", value.start ?: JSONObject.NULL)
        .put("end", value.end ?: JSONObject.NULL).put("machines", JSONArray(value.machines))
        .put("tools", JSONArray(value.tools)).put("models", JSONArray(value.models))
        .put("search", value.search ?: JSONObject.NULL).put("tokenMode", value.tokenMode)

    private fun state(): JSONObject {
        val state = viewModel.uiState.value
        val meta = state.visibleData?.meta
        return JSONObject().put("query", query(state.query)).put("entity", state.entity?.toString() ?: JSONObject.NULL)
            .put("section", state.section.name).put("loadingMode", state.loadingMode.name)
            .put("errorType", state.error?.javaClass?.name ?: JSONObject.NULL)
            .put("errorMessage", state.error?.message ?: JSONObject.NULL)
            .put("dayReviewReturnPresent", state.dayReviewReturn != null)
            .put("dayReviewReturnQuery", state.dayReviewReturn?.query?.let(::query) ?: JSONObject.NULL)
            .put("sessionPresent", state.session != null).put("visibleDataPresent", state.visibleData != null)
            .put("sourceGeneratedAt", meta?.generatedAt ?: JSONObject.NULL)
            .put("sourceLastRefreshedAt", meta?.lastRefreshedAt ?: JSONObject.NULL)
            .put("sourceTimezone", meta?.timezone ?: JSONObject.NULL)
            .put("sourceQueryEcho", meta?.query?.toString() ?: JSONObject.NULL)
            .put("repositoryRequests", JSONArray(source.requestSnapshot().map(::query)))
    }
}

internal class FakeDataSource : DashboardDataSource {
    override val isConfigured: Boolean = true
    private val lock = Any()
    private val held = mutableListOf<HeldRequest>()
    val requests = mutableListOf<DashboardQuery>()

    fun requestSnapshot(): List<DashboardQuery> = synchronized(lock) { requests.toList() }

    fun holdNext(
        matches: (DashboardQuery) -> Boolean,
        ignoreCancellation: Boolean = false
    ): HeldRequest = HeldRequest(matches, ignoreCancellation).also {
        synchronized(lock) { held += it }
    }

    override suspend fun restoreSession(): MobileSession = DateInteractionFixture.session
    override suspend fun signIn(email: String, password: String): MobileSession = DateInteractionFixture.session
    override suspend fun persistSession(session: MobileSession) = Unit
    override suspend fun clearSession() = Unit

    override suspend fun fetchStats(
        session: MobileSession,
        range: RangeKey,
        machine: String
    ): Pair<MobileSession, StatsData> = fetchStats(session, DashboardQuery(range = range, machine = machine), null)

    override suspend fun fetchStats(
        session: MobileSession,
        query: DashboardQuery,
        entity: DashboardEntity?
    ): Pair<MobileSession, StatsData> {
        val pending = synchronized(lock) {
            requests += query
            held.firstOrNull { it.request == null && it.matches(query) }?.also { it.request = query }
        }
        if (pending != null) {
            return if (pending.ignoreCancellation) pending.result.awaitIgnoringCancellation() else pending.result.await()
        }
        return session to DateInteractionFixture.stats(query)
    }

    override suspend fun fetchNextDetails(
        session: MobileSession,
        query: DashboardQuery,
        entity: DashboardEntity?,
        cursor: String
    ): Pair<MobileSession, UsageDetailsPage> = throw DashboardCapabilityException("fixture has no next page")

    internal class HeldRequest(
        val matches: (DashboardQuery) -> Boolean,
        val ignoreCancellation: Boolean
    ) {
        @Volatile var request: DashboardQuery? = null
        val result = CompletableDeferred<Pair<MobileSession, StatsData>>()

        fun succeed(tokens: Long) {
            val query = requireNotNull(request) { "request has not started" }
            result.complete(DateInteractionFixture.session to DateInteractionFixture.stats(query, tokens))
        }

        fun fail(message: String = "fixture network unavailable") {
            result.completeExceptionally(IOException(message))
        }
    }
}

internal class FakeCache : DashboardSnapshotStore {
    private val snapshots = mutableMapOf<String, DashboardCachedSnapshot>()

    override suspend fun load(key: DashboardCacheKey): DashboardCachedSnapshot? =
        synchronized(snapshots) { snapshots[key.canonicalValue()] }

    override suspend fun save(key: DashboardCacheKey, snapshot: DashboardCachedSnapshot, requestId: Long) {
        synchronized(snapshots) { snapshots[key.canonicalValue()] = snapshot }
    }

    override suspend fun clearUser(userId: String) {
        synchronized(snapshots) { snapshots.clear() }
    }

    fun clear() = synchronized(snapshots) { snapshots.clear() }
}

@OptIn(ExperimentalCoroutinesApi::class)
private suspend fun <T> CompletableDeferred<T>.awaitIgnoringCancellation(): T =
    suspendCoroutine { continuation ->
        invokeOnCompletion { continuation.resumeWith(runCatching { getCompleted() }) }
    }
