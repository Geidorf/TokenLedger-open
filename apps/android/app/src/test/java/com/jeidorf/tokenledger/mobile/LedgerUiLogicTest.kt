package com.jeidorf.tokenledger.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.TimeZone

class LedgerUiLogicTest {
    private fun <T> withDefaultTimeZone(id: String, block: () -> T): T =
        synchronized(TimeZone::class.java) {
            val previous = TimeZone.getDefault()
            try {
                TimeZone.setDefault(TimeZone.getTimeZone(id))
                block()
            } finally {
                TimeZone.setDefault(previous)
            }
        }

    @Test
    fun appearanceStorageIsStableAndUnknownValuesFallBackToAcceptedDarkTarget() {
        assertEquals(LedgerAppearance.Light, LedgerAppearance.fromStored("light"))
        assertEquals(LedgerAppearance.EInk, LedgerAppearance.fromStored("eink"))
        assertEquals(LedgerAppearance.Dark, LedgerAppearance.fromStored("future-theme"))
        assertEquals(LedgerAppearance.Dark, LedgerAppearance.fromStored(null))
        assertEquals(
            LedgerAppearance.EInk,
            LedgerAppearance.fromStored(null, fallback = LedgerAppearance.EInk)
        )
    }

    @Test
    fun ambientModeIsPersistedOnItsOwnAxisWithoutTouchingTheAppearancePreference() {
        assertEquals(AmbientMode.Ledger, AmbientMode.fromStored("ledger"))
        assertEquals(AmbientMode.Glance, AmbientMode.fromStored("glance"))
        assertEquals(
            AmbientMode.Ledger,
            AmbientMode.fromStored(null, fallback = AmbientMode.Ledger)
        )
        // 两条轴共用字符串 "eink" 却必须解析到各自的枚举：模式轴上它是旧的 widget_presentation
        // 兼容值（墨水日报），主题轴上它是墨水屏配色。任何一边串到另一边都是回归。
        assertEquals(AmbientMode.Ledger, AmbientMode.fromStored("eink"))
        assertEquals(LedgerAppearance.EInk, LedgerAppearance.fromStored("eink"))
    }

    @Test
    fun einkDetectionUsesExplicitBuildOrFeatureSignalsWithoutTrustingLowRefreshAlone() {
        assertTrue(
            isLikelyEInkDisplay(
                AndroidDisplayIdentity(
                    buildSignals = listOf("MiDuoKanReaderPro", "MiReaderPro"),
                    featureNames = emptySet(),
                    refreshRateHz = 16f
                )
            )
        )
        assertTrue(
            isLikelyEInkDisplay(
                AndroidDisplayIdentity(
                    buildSignals = listOf("generic tablet"),
                    featureNames = setOf("vendor.hardware.display.eink"),
                    refreshRateHz = 60f
                )
            )
        )
        assertFalse(
            isLikelyEInkDisplay(
                AndroidDisplayIdentity(
                    buildSignals = listOf("Pixel Tablet"),
                    featureNames = emptySet(),
                    refreshRateHz = 20f
                )
            )
        )
    }

    @Test
    fun tokenDisplayModeIsAStablePresentationPreference() {
        assertEquals(TokenDisplayMode.All, TokenDisplayMode.fromStored("all"))
        assertEquals(TokenDisplayMode.Effective, TokenDisplayMode.fromStored("future-mode"))
        assertEquals(720L, displayedTokenCount(TokenDisplayMode.Effective, 720L, 280L))
        assertEquals(1_000L, displayedTokenCount(TokenDisplayMode.All, 720L, 280L))
    }

    @Test
    fun costMaskAccessibilityNamesExposeTheCurrentStateAndNextAction() {
        // T10.154 §4.11、A02：「隐藏费用 / 显示费用」，读屏「预估费用已隐藏，双击显示」。
        assertEquals("预估费用已显示，双击隐藏", costMaskAccessibilityDescription(masked = false))
        assertEquals("已显示", costMaskStateDescription(masked = false))
        assertEquals("隐藏预估费用", costMaskActionLabel(masked = false))
        assertEquals("预估费用已隐藏，双击显示", costMaskAccessibilityDescription(masked = true))
        assertEquals("已隐藏", costMaskStateDescription(masked = true))
        assertEquals("显示预估费用", costMaskActionLabel(masked = true))
    }

    @Test
    fun costDisplayUsesOneMaskedRepresentationAcrossEverySurface() {
        assertEquals("¥***.*", formatCostForDisplay(128.64, exchangeRate = 7.2, masked = true))
        assertEquals("¥926.21", formatCostForDisplay(128.64, exchangeRate = 7.2, masked = false))
    }

    @Test
    fun detailGranularityUsesLocalizedContractCopyWithoutLeakingRawValues() {
        val aggregated = LogHistoryItem(
            id = 1,
            tool = "codex",
            model = "gpt-5",
            inputTokens = 8,
            outputTokens = 2,
            cachedTokens = 0,
            cost = 0.1,
            timestamp = "2026-08-22 10:00:00",
            sessionId = "hour:10",
            machineId = "macbook",
            requests = 4
        )

        assertEquals("云端小时聚合", detailGranularityLabel("hour", listOf(aggregated)))
        assertEquals("日志聚合", detailGranularityLabel("request", listOf(aggregated)))
        assertEquals("逐次请求", detailGranularityLabel("request", emptyList()))
        assertEquals("聚合明细", detailGranularityLabel("future", emptyList()))
    }

    @Test
    fun entityKindUsesLocalizedCopyWithoutExposingTransportEnum() {
        assertEquals("工具", entityKindLabel("tool"))
        assertEquals("模型", entityKindLabel("MODEL"))
        assertEquals("来源", entityKindLabel("future-kind"))
    }

    @Test
    fun aggregatedDetailRowsExposeRequestVolumeButLegacyMissingValuesStayQuiet() {
        // 记录数是账本行数（T10.156 IA v2），不再叫「N 次请求」。
        assertEquals("2,206 条记录", detailRequestCountLabel(2_206))
        assertEquals("738 条记录", detailRequestCountLabel(738))
        assertEquals(null, detailRequestCountLabel(0))
        assertEquals(null, detailRequestCountLabel(-1))
    }

    @Test
    fun dashboardLoadingAccessibilityDistinguishesInitialLoadFromSnapshotRefresh() {
        assertEquals("正在加载看板", dashboardLoadingAccessibilityDescription(showingCachedData = false))
        assertEquals(
            "正在刷新看板，当前仍显示上一次可验证快照",
            dashboardLoadingAccessibilityDescription(showingCachedData = true)
        )
    }

    @Test
    fun dashboardStatusGetsAnExtraLineAtLargeTextWithoutChangingNormalDensity() {
        assertEquals(1, dashboardStatusMaxLines(fontScale = 1f))
        assertEquals(2, dashboardStatusMaxLines(fontScale = 1.5f))
        assertEquals(2, dashboardStatusMaxLines(fontScale = 2f))
    }

    @Test
    fun dashboardTitleGetsAnExtraLineAtLargeTextWithoutGrowingUnbounded() {
        assertEquals(1, dashboardTitleMaxLines(fontScale = 1f))
        assertEquals(2, dashboardTitleMaxLines(fontScale = 1.5f))
        assertEquals(2, dashboardTitleMaxLines(fontScale = 2f))
    }

    @Test
    fun visuallyEllipsizedDashboardTitlesKeepTheirFullAccessibilityIdentity() {
        val title = "openai-codex-local · gpt-5.6-preview-long-identity"

        assertEquals(title, dashboardTitleAccessibilityDescription(title))
    }

    @Test
    fun sharePeriodSelectorWrapsBeforeNarrowOrLargeTextHidesMilestoneRange() {
        assertTrue(shouldWrapSharePeriodSelector(widthDp = 320, fontScale = 1f))
        assertFalse(shouldWrapSharePeriodSelector(widthDp = 390, fontScale = 1f))
        assertTrue(shouldWrapSharePeriodSelector(widthDp = 390, fontScale = 2f))
        assertFalse(shouldWrapSharePeriodSelector(widthDp = 430, fontScale = 1f))
    }

    @Test
    fun quotaRecoveryActionIsPresentOnlyForStatesThatNeedUserRecovery() {
        assertEquals(null, quotaRecoveryActionLabel(QuotaUiState.Loading))
        assertEquals(null, quotaRecoveryActionLabel(ledgerSnapshotFixture().quota))
        assertEquals(
            "重新读取额度",
            quotaRecoveryActionLabel(QuotaUiState.Unsynced())
        )
        assertEquals(
            "重新读取额度",
            quotaRecoveryActionLabel(QuotaUiState.Unavailable("网络不可用"))
        )
        assertEquals(
            "正在读取额度…",
            quotaRecoveryActionLabel(
                QuotaUiState.Unavailable("网络不可用"),
                refreshing = true
            )
        )
        assertEquals(
            null,
            quotaRecoveryActionLabel(QuotaUiState.Loading, refreshing = true)
        )
    }

    @Test
    fun largeFontDashboardKeepsEnoughScrollTailBelowBottomNavigation() {
        assertEquals(96, dashboardNavigationBarHeightDp(1f))
        assertEquals(112, dashboardNavigationBarHeightDp(1.5f))
        assertEquals(128, dashboardContentBottomPaddingDp(390, 2f))
        assertEquals(128, dashboardContentBottomPaddingDp(320, 1.5f))
        assertEquals(88, dashboardContentBottomPaddingDp(390, 1f))
        assertEquals(24, dashboardContentBottomPaddingDp(844, 1f))
    }

    @Test
    fun largeTextStacksHeroValuesBeforeCostCanWrap() {
        assertFalse(shouldStackDashboardHeroValues(1f))
        assertTrue(shouldStackDashboardHeroValues(1.5f))
        assertTrue(shouldStackDashboardHeroValues(2f))
    }

    @Test
    fun androidQuotaProvidersUseProductPriorityWithoutMutatingTransportOrder() {
        val providers = quotaFixtureProviders()
        val codex = providers.first { it.providerId == "openai-codex-local" }
        val claude = providers.first { it.providerId == "anthropic-claude-consumer" }
        val antigravity = providers.first { it.providerId == "google-antigravity-consumer" }
        val manual = providers.first { it.scope == QuotaScope.ManualBudget }
        val emptyFutureProvider = manual.copy(
            providerId = "future-provider",
            displayName = "Future Provider",
            windows = emptyList()
        )
        val failedFutureProvider = emptyFutureProvider.copy(
            providerId = "failed-provider",
            displayName = "Failed Provider",
            status = QuotaProviderStatus.Error,
            reasonCode = "source_temporarily_unavailable"
        )
        val authorizationRequiredProvider = emptyFutureProvider.copy(
            providerId = "authorization-required-provider",
            displayName = "Authorization Required Provider",
            status = QuotaProviderStatus.AuthRequired,
            reasonCode = "local_authorization_required"
        )
        val transportOrder = listOf(
            manual,
            antigravity,
            emptyFutureProvider,
            failedFutureProvider,
            authorizationRequiredProvider,
            claude,
            codex
        )

        assertEquals(
            listOf(
                "openai-codex-local",
                "anthropic-claude-consumer",
                "google-antigravity-consumer",
                manual.providerId,
                "failed-provider",
                "authorization-required-provider"
            ),
            transportOrder.orderedQuotaProvidersForDisplay().map(QuotaProviderEnvelope::providerId)
        )
        assertEquals(manual.providerId, transportOrder.first().providerId)
        assertEquals(
            listOf(
                "openai-codex-local",
                "anthropic-claude-consumer",
                "google-antigravity-consumer",
                manual.providerId,
                "future-provider",
                "failed-provider",
                "authorization-required-provider"
            ),
            transportOrder.orderedQuotaProvidersForFullDisplay().map(QuotaProviderEnvelope::providerId)
        )
        assertEquals(
            listOf(
                "openai-codex-local",
                "anthropic-claude-consumer",
                "google-antigravity-consumer",
                manual.providerId
            ),
            transportOrder.orderedQuotaProvidersWithWindowsForFullDisplay()
                .map(QuotaProviderEnvelope::providerId)
        )
        assertEquals(
            listOf("future-provider", "failed-provider", "authorization-required-provider"),
            transportOrder.orderedQuotaProvidersPendingDisplay()
                .map(QuotaProviderEnvelope::providerId)
        )
    }

    @Test
    fun quotaProvidersAreGroupedWithoutChangingQuotaV1ValuesOrStableOrder() {
        val now = Instant.parse("2026-07-15T00:40:00Z")
        val codex = quotaFixtureProviders().first { it.providerId == "openai-codex-local" }
        fun windows(remaining: Double, stale: Boolean = false, resetKnown: Boolean = true) =
            codex.windows.mapIndexed { index, window ->
                window.copy(
                    status = QuotaWindowStatus.Ok,
                    used = 100.0 - remaining,
                    limit = 100.0,
                    remaining = remaining,
                    unit = QuotaUnit.Percent,
                    observedAt = now.minusSeconds(if (stale || index == 1) 7_200 else 60).toString(),
                    fetchedAt = now.minusSeconds(30).toString(),
                    staleAfterSeconds = 3_600,
                    resetsAt = if (resetKnown) now.plusSeconds(3_600).toString() else null
                )
            }

        val healthy = codex.copy(providerId = "healthy", windows = windows(80.0).take(1))
        val low = codex.copy(providerId = "low", windows = windows(10.0).take(1))
        val mixed = codex.copy(providerId = "mixed", windows = windows(80.0))
        val history = codex.copy(providerId = "history", windows = windows(80.0, stale = true))
        val unknownReset = codex.copy(providerId = "unknown-reset", windows = windows(80.0, resetKnown = false).take(1))
        val error = codex.copy(
            providerId = "error",
            status = QuotaProviderStatus.Error,
            windows = emptyList(),
            reasonCode = "source_temporarily_unavailable"
        )

        assertEquals(QuotaDisplayGroup.Available, quotaDisplayGroup(healthy, now, showingCachedData = false))
        assertEquals(QuotaDisplayGroup.Attention, quotaDisplayGroup(low, now, showingCachedData = false))
        assertEquals(QuotaDisplayGroup.Attention, quotaDisplayGroup(mixed, now, showingCachedData = false))
        assertEquals(QuotaDisplayGroup.History, quotaDisplayGroup(history, now, showingCachedData = false))
        assertEquals(QuotaDisplayGroup.Available, quotaDisplayGroup(unknownReset, now, showingCachedData = false))
        assertEquals(QuotaDisplayGroup.Attention, quotaDisplayGroup(error, now, showingCachedData = false))

        val grouped = groupQuotaProviders(
            listOf(healthy, low, mixed, history, unknownReset, error),
            now,
            showingCachedData = false
        )
        assertEquals(listOf("low", "mixed", "error"), grouped.attention.map { it.providerId })
        assertEquals(listOf("healthy", "unknown-reset"), grouped.available.map { it.providerId })
        assertEquals(listOf("history"), grouped.history.map { it.providerId })
        assertNull(unknownReset.windows.single().resetsAt)
        assertEquals(10.0, low.windows.single().remaining)
        assertFalse(QUOTA_HISTORY_DEFAULT_EXPANDED)
    }

    @Test
    fun cachedQuotaKeepsLatestRealObservedAtInHistory() {
        val now = Instant.parse("2026-07-15T00:40:00Z")
        val codex = quotaFixtureProviders().first { it.providerId == "openai-codex-local" }
        val older = codex.copy(
            providerId = "older",
            windows = codex.windows.take(1).map { it.copy(observedAt = "2026-07-14T22:00:00Z") }
        )
        val newer = codex.copy(
            providerId = "newer",
            windows = codex.windows.take(1).map { it.copy(observedAt = "2026-07-15T00:10:00Z") }
        )

        assertEquals(QuotaDisplayGroup.History, quotaDisplayGroup(newer, now, showingCachedData = true))
        assertEquals("2026-07-15T00:10:00Z", latestQuotaObservedAt(listOf(older, newer)))
    }

    @Test
    fun quotaTalkBackSummaryIncludesProviderWindowStateValueResetAndUpdate() {
        val description = quotaWindowAccessibilityDescription(
            providerName = "Codex · 工作账号",
            windowLabel = "每周额度",
            statusLabel = "历史数据",
            valueLabel = "42% 可用",
            resetLabel = "2 小时后重置",
            observedLabel = "7月28日 10:30"
        )
        assertEquals(
            "Codex · 工作账号，每周额度，历史数据，42% 可用，2 小时后重置，更新于 7月28日 10:30",
            description
        )

        val error = quotaWindowAccessibilityDescription(
            providerName = "Codex",
            windowLabel = "每周额度",
            statusLabel = "暂时不可用",
            valueLabel = null,
            resetLabel = "重置时间未知",
            observedLabel = "7月28日 10:30"
        )
        assertFalse(error.contains("%"))
    }

    @Test
    fun ambientQuotaProgressKeepsStaleValuesButNeverLeaksErrorPercentages() {
        val provider = quotaFixtureProviders()
            .first { it.providerId == "openai-codex-local" }
        val window = provider.drawableProgressWindows().first()
        val now = java.time.Instant.parse("2026-07-15T00:40:00Z")

        val fresh = effectiveQuotaProgressPresentation(
            provider = provider,
            window = window,
            now = now,
            forceStale = false
        )
        assertEquals(QuotaProviderStatus.Ok, fresh.status)
        assertTrue(fresh.availableFraction != null)
        assertTrue(fresh.availablePercent != null)

        val stale = effectiveQuotaProgressPresentation(
            provider = provider,
            window = window,
            now = now,
            forceStale = true
        )
        assertEquals(QuotaProviderStatus.Stale, stale.status)
        assertEquals(fresh.availablePercent, stale.availablePercent)

        listOf(
            QuotaProviderStatus.Error,
            QuotaProviderStatus.AuthRequired,
            QuotaProviderStatus.Unsupported
        ).forEach { unavailableStatus ->
            val unavailable = effectiveQuotaProgressPresentation(
                provider = provider.copy(status = unavailableStatus),
                window = window,
                now = now,
                forceStale = false
            )
            assertEquals(unavailableStatus, unavailable.status)
            assertEquals(null, unavailable.availableFraction)
            assertEquals(null, unavailable.availablePercent)
        }
    }

    @Test
    fun ambientQuotaProgressUsesTheSelectedWindowsOwnFreshness() {
        val source = quotaFixtureProviders().first { it.providerId == "openai-codex-local" }
        val now = java.time.Instant.parse("2026-07-15T00:40:00Z")
        val fresh = source.drawableProgressWindows().first().copy(
            windowId = "fresh-window",
            status = QuotaWindowStatus.Ok,
            observedAt = now.minusSeconds(60).toString(),
            fetchedAt = now.minusSeconds(60).toString(),
            staleAfterSeconds = 3600,
            resetsAt = now.plusSeconds(3600).toString()
        )
        val stale = fresh.copy(windowId = "stale-window", status = QuotaWindowStatus.Stale)
        val provider = source.copy(status = QuotaProviderStatus.Ok, windows = listOf(fresh, stale))

        assertEquals(
            QuotaProviderStatus.Ok,
            effectiveQuotaProgressPresentation(provider, fresh, now, forceStale = false).status
        )
        assertEquals(
            QuotaProviderStatus.Stale,
            effectiveQuotaProgressPresentation(provider, stale, now, forceStale = false).status
        )
        assertEquals(
            QuotaProviderStatus.Error,
            effectiveQuotaProgressPresentation(
                provider.copy(status = QuotaProviderStatus.Error), fresh, now, forceStale = false
            ).status
        )
    }

    @Test
    fun quotaHeadlineNeverDowngradesExplicitErrorsToAHistoryBadge() {
        assertEquals(
            "暂时不可用",
            quotaProviderHeadlineLabel(
                QuotaProviderStatus.Error,
                showingCachedData = false,
                hasFreshWindow = false
            )
        )
        assertEquals(
            "需要授权",
            quotaProviderHeadlineLabel(
                QuotaProviderStatus.AuthRequired,
                showingCachedData = true,
                hasFreshWindow = false
            )
        )
        assertEquals(
            "历史数据",
            quotaProviderHeadlineLabel(
                QuotaProviderStatus.Stale,
                showingCachedData = false,
                hasFreshWindow = false
            )
        )
        assertEquals(
            "暂无额度数据",
            quotaProviderHeadlineLabel(
                QuotaProviderStatus.Ok,
                showingCachedData = false,
                hasFreshWindow = false
            )
        )
        assertEquals(
            "历史数据 · 更新于 10:30",
            quotaHistoryMetadataLabel(QuotaProviderStatus.Stale, "10:30")
        )
        assertEquals(null, quotaHistoryMetadataLabel(QuotaProviderStatus.Ok, "10:30"))
    }

    @Test
    fun widgetQuotaSlotsSkipMissingProgressAndLetLaterProvidersFill() {
        val providers = quotaFixtureProviders()
        val codex = providers.first { it.providerId == "openai-codex-local" }
        val claude = providers.first { it.providerId == "anthropic-claude-consumer" }
        val antigravity = providers.first { it.providerId == "google-antigravity-consumer" }
        val codexWithoutProgress = codex.copy(
            windows = codex.windows.filterNot { it.displayValue() is QuotaDisplayValue.Progress }
        )

        val selected = quotaProgressWindowsForDisplay(
            providers = listOf(antigravity, claude, codexWithoutProgress),
            limit = 2
        )

        assertEquals(
            listOf("anthropic-claude-consumer", "google-antigravity-consumer"),
            selected.map { (provider) -> provider.providerId }
        )
    }

    @Test
    fun primaryWindowSelectionPrefersWeeklyForCodexAndFiveHourForClaudeAndAntigravity() {
        val providers = quotaFixtureProviders()
        val codex = providers.first { it.providerId == "openai-codex-local" }
        val claude = providers.first { it.providerId == "anthropic-claude-consumer" }
        val antigravity = providers.first { it.providerId == "google-antigravity-consumer" }

        val codexPrimary = codex.selectPrimaryDisplayWindow()
        val claudePrimary = claude.selectPrimaryDisplayWindow()
        val antigravityPrimary = antigravity.selectPrimaryDisplayWindow()

        assertEquals("codex:secondary", codexPrimary?.windowId)
        assertEquals(10080, codexPrimary?.windowMinutes)

        assertEquals("claude:five-hour", claudePrimary?.windowId)
        assertEquals(300, claudePrimary?.windowMinutes)

        assertTrue(antigravityPrimary?.windowId?.endsWith("session") == true)
        assertEquals(300, antigravityPrimary?.windowMinutes)
    }

    @Test
    fun windowSelectionIsIndependentOfTransportArrayOrder() {
        // 契约 quota-provider-v1.md：“Provider/window 顺序不承载语义”。
        // 同一份数据在任意窗口排列下，主要/次要窗口都必须解析出同一个稳定键。
        quotaFixtureProviders().forEach { provider ->
            val baselinePrimary = provider.selectPrimaryDisplayWindow()
            val baselineSecondary = provider.selectSecondaryDisplayWindow(baselinePrimary)

            listOf(
                provider.windows.reversed(),
                provider.windows.sortedBy { it.windowId },
                provider.windows.sortedByDescending { it.windowMinutes ?: -1 },
                provider.windows.shuffled(kotlin.random.Random(20260725))
            ).forEach { permutation ->
                val permuted = provider.copy(windows = permutation)
                val primary = permuted.selectPrimaryDisplayWindow()
                assertEquals(
                    "primary drifted for ${provider.providerId} under a reordered window array",
                    baselinePrimary?.stableKey,
                    primary?.stableKey
                )
                assertEquals(
                    "secondary drifted for ${provider.providerId} under a reordered window array",
                    baselineSecondary?.stableKey,
                    permuted.selectSecondaryDisplayWindow(primary)?.stableKey
                )
            }
        }
    }

    /**
     * 真机回归（截图 2026-07-25）：小组件稳定显示"Antigravity 100%"，而用户在 Gemini 上已经
     * 用掉 17%。根因是同一档里有**多个并列窗口**，旧实现在角色内按 `(windowMinutes, windowId)`
     * 取第一个，等于按字母序挑——`antigravity-claude-and-gpt-...` 恒定压过
     * `antigravity-gemini-...`。fixture 里 claude 那组的 used 恰好是 0，于是把这个 bug 也固化了。
     *
     * 现在角色内按已用比例降序挑，卡片上那个数字才是"会先拦住你的那个"。
     */
    @Test
    fun withSeveralWindowsInTheSameRoleTheMostConsumedOneWinsNotTheAlphabeticallyFirst() {
        val antigravity = quotaFixtureProviders()
            .first { it.providerId == "google-antigravity-consumer" }

        val sessions = antigravity.drawableProgressWindows()
            .filter { it.displayRole() == QuotaWindowRole.ShortWindow }
        assertEquals("fixture 应保留两个并列的 5 小时窗口", 2, sessions.size)
        assertTrue(
            "字母序第一的 5 小时窗口必须是 used 更小的那个，否则这个回归测不到东西",
            sessions.minByOrNull { it.windowId }?.windowId == "antigravity-claude-and-gpt-models-claude-session"
        )

        val primary = requireNotNull(antigravity.selectPrimaryDisplayWindow())
        assertEquals("antigravity-gemini-models-gemini-session", primary.windowId)
        assertEquals(9.0, requireNotNull(primary.used), 0.001)

        // 次要窗口同理：两个并列的周窗口里取更吃紧的 Gemini，而不是 used=0 的 Claude/GPT。
        val secondary = requireNotNull(antigravity.selectSecondaryDisplayWindow(primary))
        assertEquals("antigravity-gemini-models-gemini-weekly", secondary.windowId)

        // 挑选仍与传输顺序无关。
        listOf(
            antigravity.windows.reversed(),
            antigravity.windows.sortedBy { it.windowId },
            antigravity.windows.shuffled(kotlin.random.Random(20260725))
        ).forEach { permutation ->
            assertEquals(
                primary.stableKey,
                antigravity.copy(windows = permutation).selectPrimaryDisplayWindow()?.stableKey
            )
        }
    }

    /** 并列且 used 完全相同时仍需确定性：用 windowId 字典序兜底，不得依赖数组下标。 */
    @Test
    fun tiedWindowsFallBackToWindowIdSoSelectionStaysDeterministic() {
        val claude = quotaFixtureProviders()
            .first { it.providerId == "anthropic-claude-consumer" }
        val original = claude.windows.first()
        val twin = original.copy(windowId = "aaa-mirror")
        val provider = claude.copy(windows = listOf(original, twin))

        assertEquals("aaa-mirror", provider.selectPrimaryDisplayWindow()?.windowId)
        assertEquals(
            "aaa-mirror",
            provider.copy(windows = listOf(twin, original)).selectPrimaryDisplayWindow()?.windowId
        )
    }

    /**
     * 拿不到偏好角色时可以退而求其次，但**必须说出来**。Codex 只剩 5 小时窗口时，卡片上那个
     * 百分比与"周额度"无关；旧实现静默替换，用户看到的是一个没有出处的 100%。
     */
    @Test
    fun fallingBackToAnotherRoleIsReportedInsteadOfSilentlySubstituted() {
        val codex = quotaFixtureProviders().first { it.providerId == "openai-codex-local" }

        val healthy = codex.selectPrimaryDisplayWindow()
        assertEquals("codex:secondary", healthy?.windowId)
        assertFalse(codex.primaryWindowIsRoleSubstitute(healthy))

        // 周窗口缺席（上游没返回或被生产者判为越界丢弃）。
        val weeklyMissing = codex.copy(windows = codex.windows.filterNot { it.windowId == "codex:secondary" })
        val substitute = requireNotNull(weeklyMissing.selectPrimaryDisplayWindow())
        assertEquals("codex:primary", substitute.windowId)
        assertTrue(
            "退到 5 小时窗口必须被标记出来，界面才有机会显示窗口标签",
            weeklyMissing.primaryWindowIsRoleSubstitute(substitute)
        )
    }

    @Test
    fun antigravityFourWindowsResolveToComplementaryRolesAndReportTheHiddenRemainder() {
        val antigravity = quotaFixtureProviders()
            .first { it.providerId == "google-antigravity-consumer" }

        // 两组 × 两个 bucket = 4 个可绘制窗口，全部是百分比进度。
        assertEquals(4, antigravity.drawableProgressWindows().size)

        val primary = requireNotNull(antigravity.selectPrimaryDisplayWindow())
        val secondary = requireNotNull(antigravity.selectSecondaryDisplayWindow(primary))

        assertEquals(QuotaWindowRole.ShortWindow, primary.displayRole())
        assertEquals(QuotaWindowRole.LongWindow, secondary.displayRole())
        assertTrue(primary.stableKey != secondary.stableKey)

        // 摆件放两个窗口时必须能说出还藏了几个，不能静默截断。
        assertEquals(2, antigravity.hiddenDrawableWindowCount(shown = 2))
        assertEquals(3, antigravity.hiddenDrawableWindowCount(shown = 1))
        assertEquals(0, antigravity.hiddenDrawableWindowCount(shown = 4))
        assertEquals(0, antigravity.hiddenDrawableWindowCount(shown = 9))
    }

    @Test
    fun codexPairsTheWeeklyPrimaryWithTheFiveHourSecondary() {
        val codex = quotaFixtureProviders().first { it.providerId == "openai-codex-local" }

        val primary = requireNotNull(codex.selectPrimaryDisplayWindow())
        val secondary = requireNotNull(codex.selectSecondaryDisplayWindow(primary))

        assertEquals("codex:secondary", primary.windowId)
        assertEquals("codex:primary", secondary.windowId)
        assertEquals(QuotaWindowRole.LongWindow, primary.displayRole())
        assertEquals(QuotaWindowRole.ShortWindow, secondary.displayRole())

        // credits 与 unlimited 不是百分比进度，不参与主/次窗口挑选，也不被伪造成进度条。
        assertTrue(codex.windows.size > codex.drawableProgressWindows().size)
        assertTrue(codex.drawableProgressWindows().none { it.unit == QuotaUnit.Credits })
    }

    @Test
    fun singleWindowProviderHasNoSecondaryAndUsesStableKeyNotStructuralEquality() {
        val claude = quotaFixtureProviders()
            .first { it.providerId == "anthropic-claude-consumer" }
        val primary = requireNotNull(claude.selectPrimaryDisplayWindow())

        assertEquals("claude:five-hour", primary.windowId)
        assertEquals(null, claude.selectSecondaryDisplayWindow(primary))

        // 两个字段完全相同但 windowId 不同的窗口不得被结构相等误判为同一个。
        val twin = primary.copy(windowId = "${primary.windowId}-mirror")
        val withTwin = claude.copy(windows = listOf(twin, primary))
        val twinPrimary = requireNotNull(withTwin.selectPrimaryDisplayWindow())
        val twinSecondary = requireNotNull(withTwin.selectSecondaryDisplayWindow(twinPrimary))
        assertTrue(twinPrimary.stableKey != twinSecondary.stableKey)
    }

    @Test
    fun windowRoleTrustsWindowMinutesBeforeWindowIdText() {
        val base = quotaFixtureProviders()
            .first { it.providerId == "anthropic-claude-consumer" }
            .windows
            .first()

        // windowMinutes 是契约字段，优先级高于 windowId 里的英文词。
        assertEquals(
            QuotaWindowRole.LongWindow,
            base.copy(windowId = "five-hour", windowMinutes = 10080).displayRole()
        )
        assertEquals(
            QuotaWindowRole.ShortWindow,
            base.copy(windowId = "weekly", windowMinutes = 300).displayRole()
        )
        // windowMinutes 缺失时才回落到文本启发式。
        assertEquals(
            QuotaWindowRole.LongWindow,
            base.copy(windowId = "codex:secondary", windowMinutes = null).displayRole()
        )
        assertEquals(
            QuotaWindowRole.ShortWindow,
            base.copy(windowId = "antigravity-gemini-models-gemini-session", windowMinutes = null)
                .displayRole()
        )
        assertEquals(
            QuotaWindowRole.Unclassified,
            base.copy(windowId = "future-window", windowMinutes = null).displayRole()
        )
    }

    /**
     * 真机回归：小卡片/摆件此前显示的是 Codex 的 5 小时窗口，而概览卡显示的是周额度。
     *
     * 根因不是挑选规则错，而是这些界面**根本没走**挑选规则：它们直接
     * `flatMap { drawableProgressWindows() }`，而那是按窗口时长升序排的，于是 `take(2)`
     * 必然先命中 Codex 的 5 小时窗口。这条断言把"前 N 个必须是各家主窗口"钉死。
     */
    @Test
    fun rankedWindowsPutEachProvidersPrimaryFirstSoCodexShowsItsWeeklyQuota() {
        val ranked = quotaFixtureProviders().rankedQuotaWindowsForDisplay()
        val headline = ranked.take(3)

        assertEquals(
            listOf("openai-codex-local", "anthropic-claude-consumer", "google-antigravity-consumer"),
            headline.map { (provider, _) -> provider.providerId }
        )
        assertEquals("codex:secondary", headline[0].second.windowId)
        assertEquals(QuotaWindowRole.LongWindow, headline[0].second.displayRole())
        assertEquals("claude:five-hour", headline[1].second.windowId)
        assertEquals(QuotaWindowRole.ShortWindow, headline[1].second.displayRole())
        assertEquals(QuotaWindowRole.ShortWindow, headline[2].second.displayRole())

        // 头三格与各 Provider 自己的 selectPrimaryDisplayWindow 必须一字不差，否则两套界面又会分叉。
        headline.forEach { (provider, window) ->
            assertEquals(provider.selectPrimaryDisplayWindow()?.stableKey, window.stableKey)
        }
    }

    @Test
    fun rankedWindowsAreDeduplicatedExhaustiveAndOrderIndependent() {
        val providers = quotaFixtureProviders()
        val ranked = providers.rankedQuotaWindowsForDisplay()
        val allDrawable = providers
            .orderedQuotaProvidersForDisplay()
            .flatMap { it.drawableProgressWindows() }

        // 排序改的是顺序，不是集合：一个可绘制窗口都不能丢，也不能重复。
        assertEquals(allDrawable.map { it.stableKey }.toSet(), ranked.map { it.second.stableKey }.toSet())
        assertEquals(ranked.size, ranked.map { it.second.stableKey }.toSet().size)

        // 契约：transport 顺序不承载语义，打乱后结果必须逐位相同。
        val shuffled = providers
            .map { it.copy(windows = it.windows.shuffled(kotlin.random.Random(20260725))) }
            .shuffled(kotlin.random.Random(725))
            .rankedQuotaWindowsForDisplay()
        assertEquals(ranked.map { it.second.stableKey }, shuffled.map { it.second.stableKey })
    }

    @Test
    fun ledgerWindowsKeepEachProviderTogetherWithoutDroppingWindows() {
        val providers = quotaFixtureProviders()
        val grouped = providers.groupedQuotaWindowsForDisplay()
        val providerRuns = grouped.map { it.first.providerId }.fold(mutableListOf<String>()) { runs, id ->
            if (runs.lastOrNull() != id) runs += id
            runs
        }
        assertEquals(
            providers.orderedQuotaProvidersForDisplay()
                .filter { it.drawableProgressWindows().isNotEmpty() }
                .map { it.providerId },
            providerRuns
        )
        assertEquals(
            providers.rankedQuotaWindowsForDisplay().map { it.second.stableKey }.toSet(),
            grouped.map { it.second.stableKey }.toSet()
        )
        grouped.groupBy { it.first.providerId }.values.forEach { entries ->
            assertEquals(entries.size, entries.map { it.second.stableKey }.toSet().size)
        }
    }

    @Test
    fun chartScaleStartsAtZeroAndLeavesHeadroomAboveTheRealPeak() {
        assertEquals(1f, paddedChartMaximum(emptyList()), 0.0001f)
        assertEquals(1f, paddedChartMaximum(listOf(0f, 0f)), 0.0001f)
        assertEquals(112f, paddedChartMaximum(listOf(20f, 100f)), 0.0001f)
        assertEquals(150f, paddedChartMaximum(listOf(100f), headroomFraction = 9f), 0.0001f)
    }

    @Test
    fun unequalTrendSeriesShareTheLongestTimelineCoordinates() {
        val slots = sharedTrendSlotCount(currentSize = 18, previousSize = 24)
        assertEquals(24, slots)
        // 短侧最后一个桶不能被单独铺到最右边。
        assertEquals(170f, trendChartX(17, slots, 0f, 230f), 0.0001f)
        assertEquals(230f, trendChartX(23, slots, 0f, 230f), 0.0001f)
        assertEquals(24, sharedTrendSlotCount(currentSize = 24, previousSize = 18))
        assertEquals(7, sharedTrendSlotCount(currentSize = 7, previousSize = 7))
        assertEquals(3, sharedTrendSlotCount(currentSize = 3, previousSize = 0))
        assertEquals(0f, trendChartX(0, slotCount = 1, left = 0f, right = 230f), 0.0001f)
        assertEquals(0f, trendChartX(0, slotCount = 0, left = 0f, right = 230f), 0.0001f)
    }

    @Test
    fun unequalTrendSeriesRenderOnOneSharedTimeline() {
        // 直接守 V2TrendChart 的渲染路径（trendChartPoints），而不是只测 helper。
        // 若有人把分母改回 values.size，两条不等长序列会各自拉满全宽：
        // 短侧最后一点会被铺到 right，与长侧最后一点的 x 不等。
        val slots = sharedTrendSlotCount(currentSize = 18, previousSize = 24)
        val layout = { values: List<Float> ->
            trendChartPoints(values, slots, left = 0f, right = 230f, top = 0f, bottom = 100f, minimum = 0f, maximum = 100f)
        }
        val shortSeries = layout(List(18) { 50f })
        val longSeries = layout(List(24) { 50f })

        // 两侧首点重合在最左；短侧末点必须停在共用轴上，不能顶到最右。
        assertEquals(0f, shortSeries.first().x, 0.0001f)
        assertEquals(0f, longSeries.first().x, 0.0001f)
        assertEquals(170f, shortSeries.last().x, 0.0001f)
        assertEquals(230f, longSeries.last().x, 0.0001f)
        assertTrue("短侧末点不能铺到最右", shortSeries.last().x < longSeries.last().x)

        // 同一下标在两条曲线上必须落在同一 x——这是"共用一条时间轴"的真正含义。
        shortSeries.forEachIndexed { index, point ->
            assertEquals(point.x, longSeries[index].x, 0.0001f)
        }
    }

    @Test
    fun smoothCurveUsesCubicSegmentsWithoutOvershootingChartBounds() {
        val points = listOf(
            SmoothCurvePoint(0f, 80f),
            SmoothCurvePoint(10f, 10f),
            SmoothCurvePoint(20f, 90f),
            SmoothCurvePoint(30f, 30f)
        )

        val segments = smoothCurveSegments(points, minY = 8f, maxY = 92f)

        assertEquals(points.size - 1, segments.size)
        assertEquals(points.first(), segments.first().start)
        assertEquals(points.last(), segments.last().end)
        segments.forEach { segment ->
            assertTrue(segment.control1.y in 8f..92f)
            assertTrue(segment.control2.y in 8f..92f)
        }
        assertTrue(segments.any { it.control1.x != it.start.x || it.control2.x != it.end.x })
    }

    @Test
    fun streamSmoothCurveSegmentsMatchesSmoothCurveSegmentsExactly() {
        val points = listOf(
            SmoothCurvePoint(0f, 80f),
            SmoothCurvePoint(10f, 10f),
            SmoothCurvePoint(20f, 90f),
            SmoothCurvePoint(30f, 30f)
        )
        val expectedSegments = smoothCurveSegments(points, minY = 8f, maxY = 92f)
        val actualCoords = mutableListOf<FloatArray>()
        streamSmoothCurveSegments(points, minY = 8f, maxY = 92f) { c1x, c1y, c2x, c2y, endX, endY ->
            actualCoords.add(floatArrayOf(c1x, c1y, c2x, c2y, endX, endY))
        }

        assertEquals(expectedSegments.size, actualCoords.size)
        expectedSegments.forEachIndexed { i, seg ->
            val arr = actualCoords[i]
            assertEquals(seg.control1.x, arr[0], 0.0001f)
            assertEquals(seg.control1.y, arr[1], 0.0001f)
            assertEquals(seg.control2.x, arr[2], 0.0001f)
            assertEquals(seg.control2.y, arr[3], 0.0001f)
            assertEquals(seg.end.x, arr[4], 0.0001f)
            assertEquals(seg.end.y, arr[5], 0.0001f)
        }
    }

    @Test
    fun monotoneCubicSplineGuaranteesStrictMonotonicityAndZeroOvershoot() {
        // Flat plateau followed by extreme spike: zero overshoot guarantee
        val plateauWithSpike = listOf(
            SmoothCurvePoint(0f, 0f),
            SmoothCurvePoint(10f, 0f),
            SmoothCurvePoint(20f, 0f),
            SmoothCurvePoint(30f, 500f),
            SmoothCurvePoint(40f, 500f),
            SmoothCurvePoint(50f, 0f)
        )
        val segments = smoothCurveSegments(plateauWithSpike)
        assertEquals(5, segments.size)

        // Segments 0 and 1 (0 to 0) must remain strictly flat with 0 derivative (no negative dip)
        assertEquals(0f, segments[0].control1.y, 0.0001f)
        assertEquals(0f, segments[0].control2.y, 0.0001f)
        assertEquals(0f, segments[1].control1.y, 0.0001f)
        assertEquals(0f, segments[1].control2.y, 0.0001f)

        // Segment 3 (500 to 500) must remain strictly flat
        assertEquals(500f, segments[3].control1.y, 0.0001f)
        assertEquals(500f, segments[3].control2.y, 0.0001f)

        // In monotonic segments, control point Y must be bounded within interval endpoints (zero overshoot)
        segments.forEach { seg ->
            val minY = kotlin.math.min(seg.start.y, seg.end.y)
            val maxY = kotlin.math.max(seg.start.y, seg.end.y)
            assertTrue("Control1 Y (${seg.control1.y}) outside [$minY, $maxY]", seg.control1.y in minY..maxY)
            assertTrue("Control2 Y (${seg.control2.y}) outside [$minY, $maxY]", seg.control2.y in minY..maxY)
            assertTrue("X monotonicity: ${seg.start.x} <= ${seg.control1.x}", seg.start.x <= seg.control1.x)
            assertTrue("X monotonicity: ${seg.control1.x} <= ${seg.control2.x}", seg.control1.x <= seg.control2.x)
            assertTrue("X monotonicity: ${seg.control2.x} <= ${seg.end.x}", seg.control2.x <= seg.end.x)
        }

        // Direct streamMonotoneCubicSegments test
        val streamedPoints = mutableListOf<FloatArray>()
        streamMonotoneCubicSegments(plateauWithSpike) { c1x, c1y, c2x, c2y, endX, endY ->
            streamedPoints.add(floatArrayOf(c1x, c1y, c2x, c2y, endX, endY))
        }
        assertEquals(segments.size, streamedPoints.size)
        segments.forEachIndexed { i, seg ->
            val actual = streamedPoints[i]
            assertEquals(seg.control1.x, actual[0], 0.0001f)
            assertEquals(seg.control1.y, actual[1], 0.0001f)
            assertEquals(seg.control2.x, actual[2], 0.0001f)
            assertEquals(seg.control2.y, actual[3], 0.0001f)
            assertEquals(seg.end.x, actual[4], 0.0001f)
            assertEquals(seg.end.y, actual[5], 0.0001f)
        }
    }

    @Test
    fun v2FormatTokensHandlesBoundariesCorrectly() {
        assertEquals("2.50B", v2FormatTokens(2_500_000_000L))
        assertEquals("15.40M", v2FormatTokens(15_400_000L))
        // A-Q1：K 与桌面一样留一位小数。
        assertEquals("45.0K", v2FormatTokens(45_000L))
        assertEquals("999", v2FormatTokens(999L))
        assertEquals("0", v2FormatTokens(0L))
    }

    @Test
    fun formatIntegerIsThreadSafeUnderConcurrency() {
        val count = 100
        val threads = List(8) { threadId ->
            Thread {
                for (i in 1..count) {
                    val value = (threadId * 1000 + i).toLong()
                    val formatted = formatInteger(value)
                    assertTrue(formatted.isNotEmpty())
                }
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
    }

    private fun quotaFixtureProviders(): List<QuotaProviderEnvelope> {
        val resource = checkNotNull(javaClass.classLoader?.getResource("quota-provider-v1/complete-v1.json"))
        val json = resource.openStream().bufferedReader().use { it.readText() }
        return QuotaSnapshotJson.parseFixtureProviders(json, QuotaParseMode.OrdinaryReader)
    }

    @Test
    fun compactLayoutCovers320DpAndTwoHundredPercentText() {
        assertEquals(DashboardLayoutMode.Compact, dashboardLayoutMode(widthDp = 320, fontScale = 1f))
        assertEquals(DashboardLayoutMode.Compact, dashboardLayoutMode(widthDp = 430, fontScale = 2f))
        assertEquals(DashboardLayoutMode.Standard, dashboardLayoutMode(widthDp = 390, fontScale = 1f))
    }

    @Test
    fun primaryNavigationUsesExactlyOnePlacementAtTheSixHundredDpBoundary() {
        assertEquals(
            DashboardNavigationPlacement.BottomBar,
            dashboardNavigationPlacement(widthDp = 599, section = DashboardSection.Overview)
        )
        assertEquals(
            DashboardNavigationPlacement.Rail,
            dashboardNavigationPlacement(widthDp = 600, section = DashboardSection.Overview)
        )
        assertEquals(
            DashboardNavigationPlacement.Rail,
            dashboardNavigationPlacement(widthDp = 840, section = DashboardSection.Settings)
        )
        assertEquals(
            DashboardNavigationPlacement.Hidden,
            dashboardNavigationPlacement(widthDp = 840, section = DashboardSection.Entity)
        )
    }

    @Test
    fun forcedLandscapeIsOptInAndYieldsToMultiWindow() {
        assertFalse(shouldLockSensorLandscape(forceLandscape = false, isInMultiWindowMode = false))
        assertTrue(shouldLockSensorLandscape(forceLandscape = true, isInMultiWindowMode = false))
        assertFalse(shouldLockSensorLandscape(forceLandscape = true, isInMultiWindowMode = true))
    }

    @Test
    fun rapidInsightSelectionKeepsTheLatestPaneWhilePreservingLegacySectionMapping() {
        assertEquals(listOf("今日", "复盘", "额度", "展示"), MobileDestination.entries.map { it.label })
        assertEquals(listOf("查看趋势"), TodayReviewAction.entries.map { it.label })
        assertEquals(InsightPane.Trend, TodayReviewAction.ExplainChange.targetPane)
        assertEquals(3, TODAY_SOURCE_LIMIT)
        assertEquals(2, TODAY_QUOTA_LIMIT)

        assertEquals(DashboardSection.Overview, MobileDestination.Overview.dashboardSection(InsightPane.Details))
        assertEquals(null, MobileDestination.Quota.dashboardSection(InsightPane.Trend))
        assertEquals(null, MobileDestination.Widget.dashboardSection(InsightPane.Trend))

        var selection = V2NavigationSelection(MobileDestination.Overview, InsightPane.Trend)
        listOf(
            InsightPane.Sources,
            InsightPane.Calendar,
            InsightPane.Details,
            InsightPane.Trend,
            InsightPane.Calendar
        ).forEach { pane ->
            selection = selection.openInsight(pane)
            assertEquals(MobileDestination.Insights, selection.destination)
            assertEquals(pane, selection.insightPane)
            assertEquals(pane.dashboardSection(), selection.destination.dashboardSection(selection.insightPane))
        }

        assertEquals(DashboardSection.Trends, InsightPane.Calendar.dashboardSection())
        assertEquals(DashboardSection.Contributions, InsightPane.Sources.dashboardSection())
        assertEquals(DashboardSection.Details, InsightPane.Details.dashboardSection())
    }

    @Test
    fun dayReviewNavigationAlwaysEntersDetailsAndReturnsToCalendar() {
        val initial = V2NavigationSelection(MobileDestination.Insights, InsightPane.Calendar)
        val reviewing = initial.openInsight(InsightPane.Details)
        assertEquals(MobileDestination.Insights, reviewing.destination)
        assertEquals(InsightPane.Details, reviewing.insightPane)

        val restored = reviewing.openInsight(InsightPane.Calendar)
        assertEquals(MobileDestination.Insights, restored.destination)
        assertEquals(InsightPane.Calendar, restored.insightPane)
    }

    @Test
    fun dashboardRefreshStatusMovesIntoTheFixedTopBarWithoutLosingSnapshotTime() {
        val idle = ledgerSnapshotFixture(range = RangeKey.Week)
        val refreshing = ledgerRefreshingSnapshotFixture()

        assertEquals(null, v2DashboardTopStatusText(idle))
        withDefaultTimeZone("Asia/Shanghai") {
            assertEquals(
                "正在刷新 · 快照截至 07-15 12:41",
                v2DashboardTopStatusText(refreshing)
            )
            assertEquals(
                "离线快照 · 截至 07-15 12:41",
                v2DashboardTopStatusText(refreshing.copy(loadingMode = DashboardLoadingMode.Idle))
            )
        }
    }

    @Test
    fun dashboardRefreshStatusUsesTheRuntimeTimeZoneOutsideScreenshotTests() {
        val refreshing = ledgerRefreshingSnapshotFixture()

        withDefaultTimeZone("UTC") {
            assertEquals(
                "正在刷新 · 快照截至 07-15 04:41",
                v2DashboardTopStatusText(refreshing)
            )
        }
        withDefaultTimeZone("Asia/Shanghai") {
            assertEquals(
                "正在刷新 · 快照截至 07-15 12:41",
                v2DashboardTopStatusText(refreshing)
            )
        }
    }

    @Test
    fun dashboardKeepsTheLastVerifiedFrameOnlyWhileAFilterOrRangeRequestIsLoading() {
        val previous = requireNotNull(ledgerSnapshotFixture().visibleData)

        assertEquals(
            previous,
            dashboardDataForFrame(
                visibleData = null,
                retainedData = previous,
                dashboardLoading = true
            )
        )
        assertEquals(
            "正在刷新数据",
            v2DashboardTopStatusText(
                state = ledgerSnapshotFixture().copy(
                    data = null,
                    cachedData = null,
                    loadingMode = DashboardLoadingMode.InitialLoad
                ),
                displayedStats = previous
            )
        )
        assertEquals(
            null,
            dashboardDataForFrame(
                visibleData = null,
                retainedData = previous,
                dashboardLoading = false
            )
        )
    }

    @Test
    fun filterSheetKeepsAllOptionGroupsFromTheRetainedFrameWhileSelectionLoads() {
        val previous = requireNotNull(ledgerSnapshotFixture().visibleData)
        val displayed = dashboardDataForFrame(
            visibleData = null,
            retainedData = previous,
            dashboardLoading = true
        )
        val options = v2FilterOptions(displayed)

        assertEquals(
            listOf(DashboardQuery.ALL_MACHINES, "MacBook-Pro", "Windows-Workstation"),
            options.machines.map { it.first }
        )
        assertEquals(listOf("claude", "codex", "minimax", "opencode"), options.tools.map { it.first })
        assertEquals(
            listOf("MiniMax-M2", "claude-opus-4", "gpt-5", "qwen3-coder"),
            options.models.map { it.first }
        )
    }

    @Test
    fun trendDataBarsUseOneBoundedScaleForCurrentAndPreviousPeriods() {
        assertEquals(TrendDataBarFractions(0f, 0f), trendDataBarFractions(20L, 10L, 0L))

        val fractions = trendDataBarFractions(
            currentTokens = 75L,
            previousTokens = 25L,
            sharedMaximum = 100L
        )
        assertEquals(0.75f, fractions.current, 0.0001f)
        assertEquals(0.25f, fractions.previous, 0.0001f)

        val bounded = trendDataBarFractions(
            currentTokens = 200L,
            previousTokens = -10L,
            sharedMaximum = 100L
        )
        assertEquals(1f, bounded.current, 0.0001f)
        assertEquals(0f, bounded.previous, 0.0001f)
    }

    @Test
    fun trendDataBarsDoubleUseOneBoundedScaleForCurrentAndPreviousPeriods() {
        assertEquals(TrendDataBarFractions(0f, 0f), trendDataBarFractions(20.0, 10.0, 0.0))
        assertEquals(TrendDataBarFractions(0f, 0f), trendDataBarFractions(20.0, 10.0, -5.0))
        assertEquals(TrendDataBarFractions(0f, 0.1f), trendDataBarFractions(Double.NaN, 10.0, 100.0))
        assertEquals(TrendDataBarFractions(0f, 0f), trendDataBarFractions(Double.NaN, Double.NaN, 100.0))

        val fractions = trendDataBarFractions(
            currentCost = 75.5,
            previousCost = 25.0,
            sharedMaximum = 100.0
        )
        assertEquals(0.755f, fractions.current, 0.0001f)
        assertEquals(0.25f, fractions.previous, 0.0001f)

        val bounded = trendDataBarFractions(
            currentCost = 150.0,
            previousCost = -10.0,
            sharedMaximum = 100.0
        )
        assertEquals(1f, bounded.current, 0.0001f)
        assertEquals(0f, bounded.previous, 0.0001f)
    }

    @Test
    fun rankedDataBarsShareTheSameResponsiveNormalizationRules() {
        assertEquals(0f, normalizedDataBarFraction(80L, 0L), 0.0001f)
        assertEquals(0f, normalizedDataBarFraction(-10L, 100L), 0.0001f)
        assertEquals(0.42f, normalizedDataBarFraction(42L, 100L), 0.0001f)
        assertEquals(1f, normalizedDataBarFraction(125L, 100L), 0.0001f)
    }

    @Test
    fun systemBackIsConsumedOnlyForAnEntityWithARealBackDestination() {
        val root = DashboardUiState(configured = true, section = DashboardSection.Overview)
        val orphanEntity = root.copy(section = DashboardSection.Entity)
        val entity = orphanEntity.copy(
            navigationStack = listOf(
                DashboardNavigationSnapshot(
                    query = DashboardQuery(),
                    section = DashboardSection.Overview,
                    contributionMode = ContributionMode.Tools
                )
            )
        )

        assertFalse(shouldConsumeDashboardBack(root))
        assertFalse(shouldConsumeDashboardBack(entity.copy(section = DashboardSection.Overview)))
        assertFalse(shouldConsumeDashboardBack(orphanEntity))
        assertTrue(shouldConsumeDashboardBack(entity))
    }

    @Test
    fun canonicalComparisonKindsDrivePeriodLabelsAndDayAlignment() {
        val day = comparisonKindPresentation("dayOverDay")
        assertEquals("今日 vs 昨日", day.windowLabel)
        assertEquals("较昨日同期", day.heroBaselineLabel)
        assertTrue(day.alignsToDayClock)

        val week = comparisonKindPresentation("weekOverWeek")
        assertEquals("本周 vs 上周", week.windowLabel)
        assertEquals("较上周同期", week.heroBaselineLabel)
        assertFalse(week.alignsToDayClock)

        val month = comparisonKindPresentation("monthOverMonth")
        assertEquals("本月 vs 上月", month.windowLabel)
        assertEquals("较上月同期", month.heroBaselineLabel)
        assertFalse(month.alignsToDayClock)
    }

    @Test
    fun legacyComparisonKindsRemainReadableWithoutBecomingTheCanonicalFixture() {
        assertEquals(
            comparisonKindPresentation("dayOverDay"),
            comparisonKindPresentation("day")
        )
        assertEquals(
            comparisonKindPresentation("weekOverWeek"),
            comparisonKindPresentation("week")
        )
        assertEquals(
            comparisonKindPresentation("monthOverMonth"),
            comparisonKindPresentation("month")
        )
        assertEquals("较上一周期", comparisonKindPresentation("future-kind").heroBaselineLabel)
    }

    @Test
    fun missingAndZeroBaselineDeltasAreNeverRenderedAsFakePercentages() {
        assertEquals("同期不可用", deltaPresentation(null).label)
        val newUsage = deltaPresentation(MetricDelta(absolute = 100.0, percent = null, direction = "new"))
        assertEquals("本期新增", newUsage.label)
        assertEquals(DeltaTone.Warning, newUsage.tone)
    }

    @Test
    fun lowerUsageUsesPositiveToneWithoutChangingMetricMeaning() {
        val result = deltaPresentation(MetricDelta(absolute = -20.0, percent = -10.0, direction = "down"))
        // R-11：|x| ≥ 10 取整，负号用 U+2212（与桌面 formatChangePercent 相同）。
        assertEquals("−10%", result.label)
        assertEquals(DeltaTone.Positive, result.tone)
    }

    @Test
    fun comparisonProgressExtractsTimeFromRpcAndIsoTimestamps() {
        assertEquals("12:41", shortTime("2026-07-15 12:41:00"))
        assertEquals("22:00", shortTime("2026-07-16 22:00:00"))
        assertEquals("09:07", shortTime("2026-07-15T09:07:30+08:00"))
        assertEquals("8:05", shortTime("8:05"))
        assertEquals("当前进度", shortTime("2026-07-15"))
        assertEquals("当前进度", shortTime(null))
    }

    @Test
    fun dayProgressMapsClockTimeOntoFullDayChart() {
        assertEquals(0f, dayProgressFraction("00:00")!!, 0.0001f)
        assertEquals(0.5f, dayProgressFraction("2026-07-15 12:00:00")!!, 0.0001f)
        assertEquals(1f, dayProgressFraction("2026-07-15T24:00:00")!!, 0.0001f)
        assertEquals(null, dayProgressFraction("24:01"))
        assertEquals(null, dayProgressFraction("not-a-time"))
    }

    @Test
    fun dayChartFractionsStayMonotonicForRpcAndLegacyBuckets() {
        val rpc = chartXFractions(
            buckets = listOf("00:00", "06:00", "12:00"),
            pointCount = 3,
            cutoffFraction = 0.55f,
            dayWindow = true,
            anchorLastToCutoff = true
        )
        assertEquals(listOf(0f, 0.25f, 0.55f), rpc)

        val legacy = chartXFractions(
            buckets = listOf("bucket-a", "bucket-b", "bucket-c", "bucket-d"),
            pointCount = 4,
            cutoffFraction = 0.5f,
            dayWindow = true,
            anchorLastToCutoff = true
        )
        assertEquals(0f, legacy.first(), 0.0001f)
        assertEquals(0.5f, legacy.last(), 0.0001f)
        assertEquals(true, legacy.zipWithNext().all { (left, right) -> left <= right })
    }

    @Test
    fun reportMetricModeStorageAndLabels() {
        assertEquals(ReportMetricMode.Tokens, ReportMetricMode.fromStored("tokens"))
        assertEquals(ReportMetricMode.Cost, ReportMetricMode.fromStored("cost"))
        assertEquals(ReportMetricMode.Tokens, ReportMetricMode.fromStored("unknown-mode"))
        assertEquals(ReportMetricMode.Tokens, ReportMetricMode.fromStored(null))
        assertEquals("Token 消耗", ReportMetricMode.Tokens.label)
        assertEquals("预估费用", ReportMetricMode.Cost.label)
    }

    @Test
    fun metricSeriesValuesExtractsTokensAndCostSeries() {
        val comparison = UsageComparison(
            window = ComparisonWindow(
                kind = "dayOverDay",
                timezone = "Asia/Shanghai",
                bucket = "hour",
                currentStart = "2026-07-15T00:00:00+08:00",
                currentEnd = "2026-07-15T12:00:00+08:00",
                previousStart = "2026-07-14T00:00:00+08:00",
                previousEnd = "2026-07-14T12:00:00+08:00",
                alignedThrough = "2026-07-15T12:00:00+08:00"
            ),
            current = ComparisonPeriod(
                summary = Summary(totalTokens = 1500L, totalCost = 0.45),
                series = listOf(
                    ComparisonSeriesPoint("00:00", tokens = 500L, requests = 2L, cost = 0.15),
                    ComparisonSeriesPoint("01:00", tokens = 1000L, requests = 4L, cost = 0.30)
                )
            ),
            previous = ComparisonPeriod(
                summary = Summary(totalTokens = 800L, totalCost = 0.20),
                series = listOf(
                    ComparisonSeriesPoint("00:00", tokens = 300L, requests = 1L, cost = 0.08),
                    ComparisonSeriesPoint("01:00", tokens = 500L, requests = 2L, cost = 0.12)
                )
            ),
            delta = ComparisonDelta(
                tokens = MetricDelta(700.0, 87.5, "up"),
                requests = MetricDelta(3.0, 100.0, "up"),
                cost = MetricDelta(0.25, 125.0, "up")
            )
        )

        val tokenSeries = metricSeriesValues(comparison, emptyList(), ReportMetricMode.Tokens)
        assertEquals(listOf(500f, 1000f), tokenSeries.first)
        assertEquals(listOf(300f, 500f), tokenSeries.second)

        val costSeries = metricSeriesValues(comparison, emptyList(), ReportMetricMode.Cost)
        assertEquals(listOf(0.15f, 0.30f), costSeries.first)
        assertEquals(listOf(0.08f, 0.12f), costSeries.second)

        // Fallback test when comparison is null
        val fallback = listOf(
            TrendPoint("2026-07-15", mapOf("codex" to 400L, "__requests" to 2L))
        )
        val fallbackTokens = metricSeriesValues(null, fallback, ReportMetricMode.Tokens)
        assertEquals(listOf(400f), fallbackTokens.first)
        assertEquals(emptyList<Float>(), fallbackTokens.second)

        val fallbackCost = metricSeriesValues(null, fallback, ReportMetricMode.Cost)
        assertEquals(emptyList<Float>(), fallbackCost.first)
        assertEquals(emptyList<Float>(), fallbackCost.second)
    }

    @Test
    fun scrubIndexForPositionCalculatesClosestBucket() {
        // 0 points returns null
        assertEquals(null, scrubIndexForPosition(touchX = 50f, widthPx = 300f, pointCount = 0))

        // 1 point always returns 0
        assertEquals(0, scrubIndexForPosition(touchX = 150f, widthPx = 300f, pointCount = 1))

        // 5 points across 0..400px -> indices 0, 1, 2, 3, 4 with boundaries at 0, 100, 200, 300, 400
        assertEquals(0, scrubIndexForPosition(touchX = 0f, widthPx = 400f, pointCount = 5))
        assertEquals(0, scrubIndexForPosition(touchX = 40f, widthPx = 400f, pointCount = 5))
        assertEquals(1, scrubIndexForPosition(touchX = 100f, widthPx = 400f, pointCount = 5))
        assertEquals(2, scrubIndexForPosition(touchX = 200f, widthPx = 400f, pointCount = 5))
        assertEquals(3, scrubIndexForPosition(touchX = 310f, widthPx = 400f, pointCount = 5))
        assertEquals(4, scrubIndexForPosition(touchX = 400f, widthPx = 400f, pointCount = 5))

        // Clamping out-of-bounds touches
        assertEquals(0, scrubIndexForPosition(touchX = -50f, widthPx = 400f, pointCount = 5))
        assertEquals(4, scrubIndexForPosition(touchX = 550f, widthPx = 400f, pointCount = 5))

        // Insets
        assertEquals(0, scrubIndexForPosition(touchX = 10f, widthPx = 420f, pointCount = 5, leftInsetPx = 20f, rightInsetPx = 20f))
        assertEquals(4, scrubIndexForPosition(touchX = 410f, widthPx = 420f, pointCount = 5, leftInsetPx = 20f, rightInsetPx = 20f))
        assertEquals(2, scrubIndexForPosition(touchX = 210f, widthPx = 420f, pointCount = 5, leftInsetPx = 20f, rightInsetPx = 20f))
    }

    @Test
    fun scrubReadoutExtractsPointAndCalculatesDeltas() {
        val comparison = UsageComparison(
            window = ComparisonWindow(
                kind = "dayOverDay",
                timezone = "Asia/Shanghai",
                bucket = "hour",
                currentStart = "2026-07-15T00:00:00+08:00",
                currentEnd = "2026-07-15T12:00:00+08:00",
                previousStart = "2026-07-14T00:00:00+08:00",
                previousEnd = "2026-07-14T12:00:00+08:00",
                alignedThrough = "2026-07-15T12:00:00+08:00"
            ),
            current = ComparisonPeriod(
                summary = Summary(totalTokens = 1500L, totalCost = 0.45),
                series = listOf(
                    ComparisonSeriesPoint("14:00", tokens = 1000L, requests = 5L, cost = 0.25)
                )
            ),
            previous = ComparisonPeriod(
                summary = Summary(totalTokens = 800L, totalCost = 0.20),
                series = listOf(
                    ComparisonSeriesPoint("14:00", tokens = 800L, requests = 4L, cost = 0.20)
                )
            ),
            delta = ComparisonDelta(
                tokens = MetricDelta(200.0, 25.0, "up"),
                requests = MetricDelta(1.0, 25.0, "up"),
                cost = MetricDelta(0.05, 25.0, "up")
            )
        )

        val readout = scrubReadoutForIndex(comparison, 0)
        assertEquals(0, readout?.index)
        assertEquals("14:00", readout?.bucket)
        assertEquals(1000L, readout?.tokens)
        assertEquals(0.25, readout?.cost ?: 0.0, 0.0001)
        assertEquals(5L, readout?.requests)
        assertEquals(800L, readout?.previousTokens)
        assertEquals(0.20, readout?.previousCost ?: 0.0, 0.0001)
        assertEquals(25.0, readout?.tokenDeltaPercent ?: 0.0, 0.0001)
        assertEquals(25.0, readout?.costDeltaPercent ?: 0.0, 0.0001)

        // Out of bounds returns null
        assertEquals(null, scrubReadoutForIndex(comparison, 1))
        assertEquals(null, scrubReadoutForIndex(comparison, -1))
        assertEquals(null, scrubReadoutForIndex(null, 0))
    }

    @Test
    fun scrubReadoutNeverBorrowsAnotherSeriesAndNeverInventsACost() {
        val window = ComparisonWindow(
            kind = "dayOverDay",
            timezone = "Asia/Shanghai",
            bucket = "hour",
            currentStart = "2026-07-15T00:00:00+08:00",
            currentEnd = "2026-07-15T12:00:00+08:00",
            previousStart = "2026-07-14T00:00:00+08:00",
            previousEnd = "2026-07-14T12:00:00+08:00",
            alignedThrough = "2026-07-15T12:00:00+08:00"
        )
        // 当期只走到 14:00，上期多一格 15:00——诚实空态下槽位数取较大值，
        // 于是槽位 1 在当期序列里越界。
        val comparison = UsageComparison(
            window = window,
            current = ComparisonPeriod(
                summary = Summary(totalTokens = 1000L, totalCost = 0.25),
                series = listOf(ComparisonSeriesPoint("14:00", tokens = 1000L, requests = 5L, cost = 0.25))
            ),
            previous = ComparisonPeriod(
                summary = Summary(totalTokens = 1600L, totalCost = 0.40),
                series = listOf(
                    ComparisonSeriesPoint("14:00", tokens = 800L, requests = 4L, cost = 0.20),
                    ComparisonSeriesPoint("15:00", tokens = 800L, requests = 4L, cost = 0.20)
                )
            ),
            delta = ComparisonDelta(
                tokens = MetricDelta(200.0, 25.0, "up"),
                requests = MetricDelta(1.0, 25.0, "up"),
                cost = MetricDelta(0.05, 25.0, "up")
            )
        )
        val fallback = listOf(
            TrendPoint("2026-07-15", mapOf("codex" to 400L, "__requests" to 2L), requests = 2L),
            TrendPoint("2026-07-16", mapOf("codex" to 900L, "__requests" to 3L), requests = 3L)
        )

        assertEquals(1000L, scrubReadout(comparison, fallback, 0, honestEmptyState = true, mode = ReportMetricMode.Tokens)?.tokens)
        // 越界槽位以前会兜底到 fallback[1]，把另一次查询的 900 当成当期读数显示。
        assertNull(scrubReadout(comparison, fallback, 1, honestEmptyState = true, mode = ReportMetricMode.Tokens))

        // 完全没有 comparison 时 fallback 才与图上曲线同源。
        val fromTrends = scrubReadout(null, fallback, 1, honestEmptyState = true, mode = ReportMetricMode.Tokens)
        assertEquals(900L, fromTrends?.tokens)
        assertEquals("2026-07-16", fromTrends?.bucket)
        assertEquals(3L, fromTrends?.requests)
        // stats.trends 没有费用口径；费用必须是 null，不能是 0.0。
        assertNull(fromTrends?.cost)
        assertNull(fromTrends?.previousTokens)

        assertNull(scrubReadout(null, fallback, 1, honestEmptyState = true, mode = ReportMetricMode.Cost))
        assertNull(scrubReadout(null, fallback, 1, honestEmptyState = false, mode = ReportMetricMode.Tokens))
        assertNull(scrubReadout(null, fallback, 9, honestEmptyState = true, mode = ReportMetricMode.Tokens))
        assertNull(scrubReadout(null, emptyList(), 0, honestEmptyState = true, mode = ReportMetricMode.Tokens))

        // 读屏在费用未知时也不能报出一个金额（T10.154 A08：「预估费用不可得」）。
        val spoken = formatScrubAccessibilityDescription(fromTrends!!, ReportMetricMode.Cost, currency = CurrencyUnit.USD)
        assertTrue(spoken.contains("预估费用不可得"))
        assertFalse(spoken.contains("$0.00"))
    }

    @Test
    fun formatScrubBucketLabelHandlesHoursAndDates() {
        assertEquals("14:00 - 15:00", formatScrubBucketLabel("14:00"))
        assertEquals("23:00 - 00:00", formatScrubBucketLabel("23:00"))
        assertEquals("00:00 - 01:00", formatScrubBucketLabel("00:00"))
        assertEquals("09:00 - 10:00", formatScrubBucketLabel("09:00"))
        assertEquals("2026-07-15", formatScrubBucketLabel("2026-07-15"))
        assertEquals("07-15", formatScrubBucketLabel("07-15"))
    }

    @Test
    fun formatScrubAccessibilityDescriptionPresentsClearDetails() {
        val readout = ScrubReadout(
            index = 0,
            bucket = "14:00",
            tokens = 120_000L,
            cost = 0.50,
            requests = 12L,
            previousTokens = 100_000L,
            previousCost = 0.40,
            tokenDeltaPercent = 20.0,
            costDeltaPercent = 25.0
        )

        val tokenDesc = formatScrubAccessibilityDescription(
            readout = readout,
            mode = ReportMetricMode.Tokens,
            exchangeRate = 7.2,
            isCostMasked = false
        )
        assertTrue(tokenDesc.contains("14:00 - 15:00"))
        assertTrue(tokenDesc.contains("有效 Token 120,000"))
        assertTrue(tokenDesc.contains("12 条记录"))

        val costDesc = formatScrubAccessibilityDescription(
            readout = readout,
            mode = ReportMetricMode.Cost,
            exchangeRate = 7.2,
            isCostMasked = false
        )
        assertTrue(costDesc.contains("14:00 - 15:00"))
        assertTrue(costDesc.contains("预估费用 ¥3.60"))
        assertTrue(costDesc.contains("12 条记录"))

        val maskedDesc = formatScrubAccessibilityDescription(
            readout = readout,
            mode = ReportMetricMode.Cost,
            exchangeRate = 7.2,
            isCostMasked = true
        )
        assertTrue(maskedDesc.contains("¥***.*"))
    }

    @Test
    fun formatTrendAnchorLabelFormatsDatesAndHoursNicely() {
        assertEquals("08-23", formatTrendAnchorLabel("2026-08-23"))
        assertEquals("08-23 14:00", formatTrendAnchorLabel("2026-08-23T14:00:00Z"))
        assertEquals("14:00", formatTrendAnchorLabel("14:00"))
        assertEquals("07-15", formatTrendAnchorLabel("07-15"))
        assertEquals("", formatTrendAnchorLabel("   "))
    }

    @Test
    fun trendSeriesBucketsExtractsTimestampsFromTrendPointsOrComparison() {
        val points = listOf(
            TrendPoint(date = "10:00", values = emptyMap()),
            TrendPoint(date = "11:00", values = emptyMap()),
            TrendPoint(date = "12:00", values = emptyMap())
        )
        assertEquals(listOf("10:00", "11:00", "12:00"), trendSeriesBuckets(comparison = null, fallback = points))
        assertEquals(emptyList<String>(), trendSeriesBuckets(comparison = null, fallback = emptyList()))

        val comparison = UsageComparison(
            window = ComparisonWindow(
                kind = "dayOverDay",
                timezone = "Asia/Shanghai",
                bucket = "hour",
                currentStart = "2026-07-15T00:00:00+08:00",
                currentEnd = "2026-07-15T12:00:00+08:00",
                previousStart = "2026-07-14T00:00:00+08:00",
                previousEnd = "2026-07-14T12:00:00+08:00",
                alignedThrough = "2026-07-15T12:00:00+08:00"
            ),
            current = ComparisonPeriod(
                summary = Summary(totalTokens = 1500L, totalCost = 0.45),
                series = listOf(
                    ComparisonSeriesPoint("00:00", tokens = 500L, requests = 2L, cost = 0.15),
                    ComparisonSeriesPoint("01:00", tokens = 1000L, requests = 4L, cost = 0.30)
                )
            ),
            previous = ComparisonPeriod(
                summary = Summary(totalTokens = 1000L, totalCost = 0.30),
                series = emptyList()
            ),
            delta = ComparisonDelta(
                tokens = MetricDelta(500.0, 50.0, "up"),
                requests = MetricDelta(2.0, 50.0, "up"),
                cost = MetricDelta(0.15, 50.0, "up")
            )
        )
        assertEquals(listOf("00:00", "01:00"), trendSeriesBuckets(comparison = comparison, fallback = points))
    }

    @Test
    fun shouldAnchorTooltipToRightAvoidsClippingAtScreenEdges() {
        // chartWidth = 1000f, 50% threshold = 500f
        assertTrue(shouldAnchorTooltipToRight(touchX = 200f, chartWidth = 1000f))
        assertTrue(shouldAnchorTooltipToRight(touchX = 499f, chartWidth = 1000f))
        assertFalse(shouldAnchorTooltipToRight(touchX = 501f, chartWidth = 1000f))
        assertFalse(shouldAnchorTooltipToRight(touchX = 900f, chartWidth = 1000f))
    }

    @Test
    fun heatmapCellAtPositionDetectsTouchedCellAccurately() {
        // width = 200f, height = 70f, columns = 10, rows = 7, gap = 2f
        val cell = heatmapCellAtPosition(
            x = 10f,
            y = 5f,
            widthPx = 200f,
            heightPx = 70f,
            columns = 10,
            rows = 7,
            gapPx = 2f
        )
        assertEquals(0 to 0, cell)

        // Negative coordinates return null
        assertEquals(null, heatmapCellAtPosition(-5f, 10f, 200f, 70f, 10))
        assertEquals(null, heatmapCellAtPosition(10f, -5f, 200f, 70f, 10))

        // Coordinates far beyond valid cells return null
        assertEquals(null, heatmapCellAtPosition(500f, 500f, 200f, 70f, 10))
        // Invalid dimensions return null
        assertEquals(null, heatmapCellAtPosition(10f, 10f, 0f, 70f, 10))
    }

    @Test
    fun donutSliceAtOffsetIdentifiesSliceByAngleAndRadialBounds() {
        val sizePx = 200f // center at (100, 100), outer radius 100
        val values = listOf(50L, 50L) // 2 equal slices of 180° each

        // Inside center hole (dist < outerRadius * 0.2f = 20f) -> null
        assertEquals(null, donutSliceAtOffset(100f, 100f, sizePx, values))

        // Outside outer ring (dist > outerRadius * 1.2f = 120f) -> null
        assertEquals(null, donutSliceAtOffset(250f, 100f, sizePx, values))

        // Right side (150f, 100f): dx=50, dy=0. Angle is 0°, normalized with startAngleOffset -90 is 90° -> slice 0
        assertEquals(0, donutSliceAtOffset(150f, 100f, sizePx, values))

        // Left side (50f, 100f): dx=-50, dy=0. Angle is 180°, normalized with startAngleOffset -90 is 270° -> slice 1
        assertEquals(1, donutSliceAtOffset(50f, 100f, sizePx, values))
    }

    @Test
    fun isLandscapeOrCompactHeightDetectsOrientationsProperly() {
        // Landscape / Compact height (< 500)
        assertTrue(isLandscapeOrCompactHeight(screenHeightDp = 390))
        assertTrue(isLandscapeOrCompactHeight(screenHeightDp = 480))
        // Portrait normal (>= 500)
        assertFalse(isLandscapeOrCompactHeight(screenHeightDp = 844))
        assertFalse(isLandscapeOrCompactHeight(screenHeightDp = 600))
    }

    @Test
    fun filterModelsForTool_whenToolNull_returnsVisibleFallback() {
        val allModels = listOf(
            ModelStat(name = "gpt-4o", total = 1000, requests = 10),
            ModelStat(name = "claude-3-5-sonnet", total = 800, requests = 8)
        )
        val fallback = listOf(allModels[0])
        val result = filterModelsForTool(allModels, fallback, selectedTool = null)
        assertEquals(fallback, result)
    }

    @Test
    fun filterModelsForTool_whenToolSelected_filtersFromAllModels() {
        val allModels = listOf(
            ModelStat(name = "gpt-4o", total = 1000, requests = 10),
            ModelStat(name = "gpt-4o-mini", total = 900, requests = 9),
            ModelStat(name = "claude-3-5-sonnet", total = 800, requests = 8),
            ModelStat(name = "claude-3-haiku", total = 50, requests = 2)
        )
        val fallback = allModels.take(2) // only gpt-4o, gpt-4o-mini in top 2
        val claudeTool = ToolStat(
            name = "claude",
            input = 800,
            output = 50,
            cached = 0,
            total = 850,
            cost = 1.0,
            requests = 10,
            models = mapOf("claude-3-5-sonnet" to 800L, "claude-3-haiku" to 50L)
        )

        // Even though claude-3-haiku is not in fallback (top 2), it MUST be included from allModels
        val result = filterModelsForTool(allModels, fallback, selectedTool = claudeTool)
        assertEquals(2, result.size)
        assertEquals("claude-3-5-sonnet", result[0].name)
        assertEquals("claude-3-haiku", result[1].name)
    }

    @Test
    fun filterModelsForTool_whenToolModelsNotInAllModels_returnsEmptyWithoutFallbackLeak() {
        val allModels = listOf(
            ModelStat(name = "gpt-4o", total = 1000, requests = 10),
            ModelStat(name = "gpt-4o-mini", total = 900, requests = 9)
        )
        val fallback = allModels
        val emptyTool = ToolStat(
            name = "unknown-tool",
            input = 0,
            output = 0,
            cached = 0,
            total = 0,
            cost = 0.0,
            requests = 0,
            models = emptyMap()
        )

        // Must return empty list, NOT leaking foreign models from fallback
        val result = filterModelsForTool(allModels, fallback, selectedTool = emptyTool)
        assertTrue(result.isEmpty())
    }

    @Test
    fun formatTrendAnchorLabel_formatsWithTopLevelRegexes() {
        // Date regex YYYY-MM-DD
        assertEquals("07-14", formatTrendAnchorLabel("2026-07-14"))
        assertEquals("07-14", formatTrendAnchorLabel("  2026-07-14  "))

        // Month regex YYYY-MM
        assertEquals("07", formatTrendAnchorLabel("2026-07"))

        // ISO regex YYYY-MM-DDTHH:MM
        assertEquals("07-14 09:30", formatTrendAnchorLabel("2026-07-14T09:30:00+08:00"))
        assertEquals("07-14 09:30", formatTrendAnchorLabel("2026-07-14 09:30:00"))

        // Fallback for hour or other formats
        assertEquals("09:00", formatTrendAnchorLabel("09:00"))
        assertEquals("custom", formatTrendAnchorLabel("custom"))
    }

    @Test
    fun formatScrubBucketLabel_formatsHourWithTopLevelRegex() {
        assertEquals("00:00 - 01:00", formatScrubBucketLabel("00:00"))
        assertEquals("09:00 - 10:00", formatScrubBucketLabel("09:00"))
        assertEquals("23:00 - 00:00", formatScrubBucketLabel("23:00"))
        assertEquals("2026-07-14", formatScrubBucketLabel("2026-07-14"))
    }

    @Test
    fun currencyUnitStorageIsStableAndFallsBackToCny() {
        assertEquals(CurrencyUnit.USD, CurrencyUnit.fromStored("usd"))
        assertEquals(CurrencyUnit.USD, CurrencyUnit.fromStored("USD"))
        assertEquals(CurrencyUnit.CNY, CurrencyUnit.fromStored("cny"))
        assertEquals(CurrencyUnit.CNY, CurrencyUnit.fromStored("CNY"))
        assertEquals(CurrencyUnit.CNY, CurrencyUnit.fromStored("unknown"))
        assertEquals(CurrencyUnit.CNY, CurrencyUnit.fromStored(null))
        assertEquals(CurrencyUnit.USD, CurrencyUnit.fromStored(null, fallback = CurrencyUnit.USD))
    }

    @Test
    fun currencyUnitSymbolsAndCodes() {
        assertEquals("$", CurrencyUnit.USD.symbol)
        assertEquals("USD", CurrencyUnit.USD.code)
        assertEquals("美元", CurrencyUnit.USD.label)
        assertEquals("¥", CurrencyUnit.CNY.symbol)
        assertEquals("CNY", CurrencyUnit.CNY.code)
        assertEquals("人民币", CurrencyUnit.CNY.label)
    }

    @Test
    fun currencyConversionHandlesUsdAndCnyWithConfigurableRate() {
        assertEquals(100.0, CurrencyUnit.USD.convertFromUsd(100.0, exchangeRate = 7.2)!!, 0.001)
        assertEquals(720.0, CurrencyUnit.CNY.convertFromUsd(100.0, exchangeRate = 7.2)!!, 0.001)
        assertEquals(700.0, CurrencyUnit.CNY.convertFromUsd(100.0, exchangeRate = 7.0)!!, 0.001)
        assertEquals(0.0, CurrencyUnit.USD.convertFromUsd(0.0)!!, 0.001)
        // 汇率写明：离线检查的 BuildConfig 桩把汇率置 0.0（无效汇率 → 不可得），Gradle 下才是 7.2。
        assertEquals(0.0, CurrencyUnit.CNY.convertFromUsd(0.0, exchangeRate = 7.2)!!, 0.001)
        assertEquals(100000.0, CurrencyUnit.CNY.convertFromUsd(100.0, exchangeRate = 1000.0)!!, 0.001)
        // T10.154 A03：读不到就是读不到——非有限金额、无效汇率与溢出返回 null（不可得），不再冒充 0.0。
        assertNull(CurrencyUnit.CNY.convertFromUsd(100.0, exchangeRate = 0.0))
        assertNull(CurrencyUnit.CNY.convertFromUsd(100.0, exchangeRate = -7.2))
        assertNull(CurrencyUnit.CNY.convertFromUsd(100.0, exchangeRate = Double.NaN))
        assertNull(CurrencyUnit.USD.convertFromUsd(Double.NaN))
        assertNull(CurrencyUnit.CNY.convertFromUsd(Double.POSITIVE_INFINITY))
        assertNull(CurrencyUnit.CNY.convertFromUsd(Double.MAX_VALUE, exchangeRate = 7.2))
        // USD 不经汇率，汇率无效不影响美元金额。
        assertEquals(100.0, CurrencyUnit.USD.convertFromUsd(100.0, exchangeRate = 0.0)!!, 0.001)
    }

    @Test
    fun standardCurrencyFormattingFollowsTwoDecimalDigits() {
        assertEquals("$0.00", CurrencyUnit.USD.format(0.0))
        assertEquals("$3.45", CurrencyUnit.USD.format(3.45))
        assertEquals("$128.64", CurrencyUnit.USD.format(128.64))
        assertEquals("$1,234.50", CurrencyUnit.USD.format(1234.5))

        assertEquals("¥0.00", CurrencyUnit.CNY.format(0.0, exchangeRate = 7.2))
        assertEquals("¥720.00", CurrencyUnit.CNY.format(100.0, exchangeRate = 7.2))
        assertEquals("¥926.21", CurrencyUnit.CNY.format(128.64, exchangeRate = 7.2))
    }

    @Test
    fun currencyMaskingProtectsSensitiveAmountsAcrossCurrencies() {
        assertEquals("$***.*", CurrencyUnit.USD.format(128.64, masked = true))
        assertEquals("¥***.*", CurrencyUnit.CNY.format(128.64, exchangeRate = 7.2, masked = true))
        assertEquals("$***.*", CurrencyUnit.USD.format(0.0, masked = true))
        assertEquals("¥***.*", CurrencyUnit.CNY.format(0.0, exchangeRate = 7.2, masked = true))
    }

    @Test
    fun formatCostForDisplayPreservesFullBackwardCompatibility() {
        assertEquals("¥***.*", formatCostForDisplay(128.64, exchangeRate = 7.2, masked = true))
        assertEquals("¥926.21", formatCostForDisplay(128.64, exchangeRate = 7.2, masked = false))
        assertEquals("¥100,000.00", formatCostForDisplay(100.0, exchangeRate = 1000.0, masked = false))
        assertEquals("$100.00", formatCostForDisplay(100.0, currency = CurrencyUnit.USD))
        assertEquals("$***.*", formatCostForDisplay(100.0, masked = true, currency = CurrencyUnit.USD))
    }

    @Test
    fun compactUsdFormattingProducesExpectedKAndMSuffixes() {
        assertEquals("$0", CurrencyUnit.USD.formatCompact(0.0))
        assertEquals("$3.45", CurrencyUnit.USD.formatCompact(3.45))
        assertEquals("$12", CurrencyUnit.USD.formatCompact(12.0))
        assertEquals("$12.5", CurrencyUnit.USD.formatCompact(12.5))
        assertEquals("$120", CurrencyUnit.USD.formatCompact(120.0))
        assertEquals("$1K", CurrencyUnit.USD.formatCompact(1000.0))
        assertEquals("$1.2K", CurrencyUnit.USD.formatCompact(1200.0))
        assertEquals("$15.2K", CurrencyUnit.USD.formatCompact(15200.0))
        assertEquals("$1.5M", CurrencyUnit.USD.formatCompact(1_500_000.0))
        assertEquals("$1.2B", CurrencyUnit.USD.formatCompact(1_200_000_000.0))
        assertEquals("$***", CurrencyUnit.USD.formatCompact(1200.0, masked = true))
    }

    @Test
    fun compactCnyFormattingProducesExpectedKAndWSuffixes() {
        assertEquals("¥0", CurrencyUnit.CNY.formatCompact(0.0, exchangeRate = 7.2))
        assertEquals("¥86.4", CurrencyUnit.CNY.formatCompact(12.0, exchangeRate = 7.2))
        assertEquals("¥864", CurrencyUnit.CNY.formatCompact(120.0, exchangeRate = 7.2))
        assertEquals("¥1K", CurrencyUnit.CNY.formatCompact(1000.0 / 7.2, exchangeRate = 7.2))
        assertEquals("¥1.2K", CurrencyUnit.CNY.formatCompact(1200.0 / 7.2, exchangeRate = 7.2))
        assertEquals("¥1W", CurrencyUnit.CNY.formatCompact(10000.0 / 7.2, exchangeRate = 7.2))
        assertEquals("¥4.5W", CurrencyUnit.CNY.formatCompact(45000.0 / 7.2, exchangeRate = 7.2))
        assertEquals("¥15.2W", CurrencyUnit.CNY.formatCompact(152000.0 / 7.2, exchangeRate = 7.2))
        assertEquals("¥***", CurrencyUnit.CNY.formatCompact(45000.0 / 7.2, exchangeRate = 7.2, masked = true))
    }

    @Test
    fun scrubAccessibilityDescriptionRespectsCurrencyAndMetricMode() {
        val readout = ScrubReadout(
            index = 0,
            bucket = "10:00",
            tokens = 5000,
            cost = 10.0,
            requests = 12,
            previousTokens = null,
            previousCost = null,
            tokenDeltaPercent = null,
            costDeltaPercent = null
        )

        val descUsd = formatScrubAccessibilityDescription(
            readout,
            ReportMetricMode.Cost,
            currency = CurrencyUnit.USD
        )
        assertTrue(descUsd.contains("预估费用 $10.00"))

        val descCny = formatScrubAccessibilityDescription(
            readout,
            ReportMetricMode.Cost,
            exchangeRate = 7.2,
            currency = CurrencyUnit.CNY
        )
        assertTrue(descCny.contains("预估费用 ¥72.00"))

        val descMasked = formatScrubAccessibilityDescription(
            readout,
            ReportMetricMode.Cost,
            isCostMasked = true,
            currency = CurrencyUnit.USD
        )
        assertTrue(descMasked.contains("预估费用 $***.*"))

        val descTokens = formatScrubAccessibilityDescription(
            readout,
            ReportMetricMode.Tokens,
            currency = CurrencyUnit.USD
        )
        assertTrue(descTokens.contains("有效 Token 5,000"))
    }

    @Test
    fun donutSliceAtOffsetDouble_detectsCorrectSlices() {
        val values = listOf(10.0, 20.0, 30.0)
        val sizePx = 200f

        val slice0 = donutSliceAtOffsetDouble(140f, 30f, sizePx, values)
        assertEquals(0, slice0)

        val slice1 = donutSliceAtOffsetDouble(160f, 140f, sizePx, values)
        assertEquals(1, slice1)

        val slice2 = donutSliceAtOffsetDouble(30f, 100f, sizePx, values)
        assertEquals(2, slice2)

        val centerTap = donutSliceAtOffsetDouble(100f, 100f, sizePx, values)
        assertNull(centerTap)

        val outsideTap = donutSliceAtOffsetDouble(300f, 300f, sizePx, values)
        assertNull(outsideTap)
    }


}
