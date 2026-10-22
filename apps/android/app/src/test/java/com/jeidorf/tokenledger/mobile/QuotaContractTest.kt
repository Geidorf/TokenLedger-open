package com.jeidorf.tokenledger.mobile

import java.time.Instant
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class QuotaContractTest {
    @Test
    fun completeFixtureMatchesStableKeysAndDrawableValueKinds() {
        val root = JSONObject(fixture("complete-v1.json"))
        val providers = QuotaSnapshotJson.parseFixtureProviders(
            root.toString(),
            QuotaParseMode.OrdinaryReader
        )
        val expected = root.getJSONObject("expected")
        val windows = providers.flatMap { it.windows }

        assertEquals(expected.getInt("providerCount"), providers.size)
        assertEquals(expected.getInt("windowCount"), windows.size)
        assertEquals(
            expected.stringList("drawableProgressKeys").sorted(),
            windows.filter { it.displayValue() is QuotaDisplayValue.Progress }
                .map(QuotaWindowSnapshot::stableKey)
                .sorted()
        )
        assertEquals(
            expected.stringList("absoluteOnlyKeys"),
            windows.filter { it.displayValue() is QuotaDisplayValue.Absolute }
                .map(QuotaWindowSnapshot::stableKey)
        )
        assertEquals(
            expected.stringList("unlimitedKeys"),
            windows.filter { it.displayValue() == QuotaDisplayValue.UnlimitedCredits }
                .map(QuotaWindowSnapshot::stableKey)
        )
    }

    @Test
    fun quotaPresentationLocalizesKnownMachineLabelsAndPreservesUnknownCustomLabels() {
        val providers = QuotaSnapshotJson.parseFixtureProviders(
            JSONObject(fixture("complete-v1.json")).toString(),
            QuotaParseMode.OrdinaryReader
        )
        val codex = providers.first { it.providerId == "openai-codex-local" }
        val claude = providers.first { it.providerId == "anthropic-claude-consumer" }
        val antigravity = providers.first { it.providerId == "google-antigravity-consumer" }
        val manual = providers.first { it.scope == QuotaScope.ManualBudget }

        assertEquals("Codex 订阅额度", codex.localizedDisplayName())
        assertEquals("Claude 订阅额度", claude.localizedDisplayName())
        assertEquals("Antigravity 订阅额度", antigravity.localizedDisplayName())
        assertEquals("手动预算", manual.localizedDisplayName())
        assertEquals(
            "5 小时额度",
            codex.windows.first { it.windowId == "codex:primary" }.localizedWindowLabel()
        )
        assertEquals(
            "每周额度",
            codex.windows.first { it.windowId == "codex:secondary" }.localizedWindowLabel()
        )
        assertEquals(
            "额外用量余额",
            codex.windows.first { it.windowId == "codex:credits-balance" }.localizedWindowLabel()
        )
        assertEquals("July budget", manual.windows.single().localizedWindowLabel())

        val prefixed = codex.windows.first { it.windowId == "codex:primary" }.copy(
            windowLabel = "codex · Primary"
        )
        assertEquals(
            "5 小时额度",
            prefixed.localizedWindowLabel(codex.localizedDisplayName())
        )
        assertEquals(
            "5 小时",
            prefixed.localizedCompactWindowLabel(codex.localizedDisplayName())
        )
        assertEquals(
            "Sonnet only · 每周额度",
            prefixed.copy(
                windowId = "codexbar-sonnet-weekly",
                windowLabel = "Sonnet only",
                windowMinutes = 10_080
            ).localizedWindowLabel()
        )
        // 「<时长>窗口」是构造出来的通用说法，不该被当成有信息量的前缀拼在语义标签前。
        // 通用标签表里原本只逐个列了 5 小时 / 7 天 / 周，漏掉的 30 天于是在额度页显示成
        // 「30 天窗口 · 30 天额度」——同一件事说两遍，而兄弟行是「5 小时额度」「每周额度」。
        // 逐个补进表里只能挡住 30，90 天、14 天照样漏。
        val thirtyDay = codex.windows.first { it.windowId == "codex:primary" }.copy(
            windowId = "codex:monthly",
            windowLabel = "30 天窗口",
            windowMinutes = 30 * 24 * 60
        )
        assertEquals("30 天额度", thirtyDay.localizedWindowLabel())
        assertEquals("90 天额度", thirtyDay.copy(
            windowLabel = "90 天窗口", windowMinutes = 90 * 24 * 60).localizedWindowLabel())
        assertEquals("30 天额度", thirtyDay.copy(windowLabel = "30-day window").localizedWindowLabel())
        // 真有信息量的前缀仍然保留。
        assertEquals("北美研发账号 · 30 天额度",
            thirtyDay.copy(windowLabel = "北美研发账号 · 30 天窗口").localizedWindowLabel())

        assertEquals("来源已同步", QuotaProviderStatus.Ok.localizedLabel())
        assertEquals("历史数据", QuotaProviderStatus.Stale.localizedLabel())
        assertEquals("需要授权", QuotaProviderStatus.AuthRequired.localizedLabel())

        assertEquals(
            "Codex · 工作账号",
            codex.copy(displayName = "Codex · 工作账号").localizedDisplayName()
        )
        assertEquals(
            "研发团队",
            codex.copy(displayName = "研发团队").localizedDisplayName()
        )
        assertEquals(
            "Codexium Team",
            codex.copy(displayName = "Codexium Team").localizedDisplayName()
        )
        assertEquals(
            "Sonnet only · 每周",
            prefixed.copy(
                windowId = "codexbar-sonnet-weekly",
                windowLabel = "Sonnet only · Weekly",
                windowMinutes = 10_080
            ).localizedCompactWindowLabel(codex.localizedDisplayName())
        )
    }

    @Test
    fun customOpenapiFixtureSurvivesStrictCloudDecodeForAppAmbientAndWidgets() {
        val root = JSONObject(fixture("custom-openapi-v1.json"))
        val providers = QuotaSnapshotJson.parseFixtureProviders(
            root.toString(),
            QuotaParseMode.SyncedTransport
        )
        val provider = providers.single()
        val expected = root.getJSONObject("expected")

        assertEquals(expected.getString("providerId"), provider.providerId)
        assertEquals(QuotaScope.ApiOrganization, provider.scope)
        assertEquals("研发账号额度", provider.localizedDisplayName())
        assertEquals(
            expected.stringList("windowIds"),
            provider.windows.map(QuotaWindowSnapshot::windowId)
        )
        assertTrue(provider.windows.all { it.source == QuotaSource.OfficialApi })
        assertTrue(provider.windows.all { it.displayValue() is QuotaDisplayValue.Progress })
        assertEquals(provider, providers.orderedQuotaProvidersForDisplay().single())
        assertEquals(3, providers.groupedQuotaWindowsForDisplay().size)
    }

    @Test
    fun providerEffectiveStatusUsesTheSameConservativeRuleAcrossFreshStaleAndError() {
        val codex = QuotaSnapshotJson.parseFixtureProviders(
            JSONObject(fixture("complete-v1.json")).toString(),
            QuotaParseMode.OrdinaryReader
        ).first { it.providerId == "openai-codex-local" }

        val freshNow = Instant.parse("2026-07-15T00:40:00Z")
        assertEquals(QuotaProviderStatus.Ok, codex.effectiveStatus(freshNow))

        val staleNow = Instant.parse("2026-07-15T00:50:00Z")
        assertEquals(QuotaProviderStatus.Stale, codex.effectiveStatus(staleNow))
        assertEquals(QuotaProviderStatus.Stale, codex.effectiveStatus(freshNow, forceStale = true))

        val mixed = codex.copy(
            windows = codex.windows.mapIndexed { index, window ->
                if (index == 0) {
                    window.copy(
                        observedAt = "2026-07-15T08:00:00+08:00",
                        fetchedAt = "2026-07-15T08:00:01+08:00"
                    )
                } else {
                    window
                }
            }
        )
        assertEquals(
            "任一窗口陈旧时 Provider 必须保守降级，避免另一张卡仍画成实时蓝色",
            QuotaProviderStatus.Stale,
            mixed.effectiveStatus(freshNow)
        )

        val error = codex.copy(status = QuotaProviderStatus.Error, reasonCode = "source_error")
        assertEquals(QuotaProviderStatus.Error, error.effectiveStatus(freshNow))

        val recovered = codex.copy(
            windows = codex.windows.map { window ->
                window.copy(
                    observedAt = "2026-07-15T08:55:00+08:00",
                    fetchedAt = "2026-07-15T08:55:01+08:00",
                    resetsAt = window.resetsAt?.let { "2026-07-22T08:00:00+08:00" }
                )
            }
        )
        assertEquals(
            QuotaProviderStatus.Ok,
            recovered.effectiveStatus(Instant.parse("2026-07-15T00:56:00Z"))
        )
    }

    @Test
    fun stateFixtureSeparatesForwardCompatibleReaderFromStrictSyncBoundary() {
        val root = JSONObject(fixture("states-v1.json"))
        val cases = root.getJSONArray("envelopeCases")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val provider = case.getJSONObject("provider")
            QuotaSnapshotJson.parseProvider(provider, QuotaParseMode.OrdinaryReader)
            if (case.getString("syncOutcome") == "valid") {
                QuotaSnapshotJson.parseProvider(provider, QuotaParseMode.SyncedTransport)
            } else {
                assertThrows(QuotaContractException::class.java) {
                    QuotaSnapshotJson.parseProvider(provider, QuotaParseMode.SyncedTransport)
                }
            }
        }

        val absence = root.getJSONObject("absenceCase")
        assertEquals("unavailable-not-zero", absence.getString("outcome"))
        assertFalse(absence.getJSONObject("input").has("quota"))
    }

    @Test
    fun everyInvalidFixtureUsesTheProductionValidatorDirectly() {
        val root = JSONObject(fixture("invalid-v1.json"))
        val cases = root.getJSONArray("cases")
        assertEquals(11, cases.length())
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val raw = JSONObject().put("providers", case.getJSONArray("providers")).toString()
            val readerOutcome = case.getString("readerOutcome")
            if (readerOutcome.startsWith("valid")) {
                QuotaSnapshotJson.parseFixtureProviders(raw, QuotaParseMode.OrdinaryReader)
            } else {
                assertThrows("reader ${case.getString("name")}", QuotaContractException::class.java) {
                    QuotaSnapshotJson.parseFixtureProviders(raw, QuotaParseMode.OrdinaryReader)
                }
            }
            assertThrows("sync ${case.getString("name")}", QuotaContractException::class.java) {
                QuotaSnapshotJson.parseFixtureProviders(raw, QuotaParseMode.SyncedTransport)
            }
        }
    }

    @Test
    fun transportFixturePinsExactGetIdentityAndRoundTripsStrictProjection() {
        val root = JSONObject(fixture("transport-v2.json"))
        val response = root.getJSONObject("readResponse")
        val parsed = QuotaSnapshotJson.parseTransport(response.toString())

        assertEquals(QUOTA_TRANSPORT_VERSION, parsed.transportVersion)
        assertEquals(response.getLong("epoch"), parsed.epoch)
        assertEquals(response.getLong("revision"), parsed.revision)
        assertEquals(1, parsed.providers.size)
        assertEquals(2, parsed.providerStates.size)
        assertTrue(parsed.providers.all { provider ->
            provider.windows.all { it.reasonCode != "accountLabel" }
        })
        assertEquals(parsed, QuotaSnapshotJson.parseTransport(QuotaSnapshotJson.encodeTransport(parsed)))

        val unknown = JSONObject(response.toString()).put("futureField", true)
        assertThrows(QuotaContractException::class.java) {
            QuotaSnapshotJson.parseTransport(unknown.toString())
        }

        val orphanActive = JSONObject(response.toString())
        orphanActive.getJSONArray("providerStates").put(
            JSONObject()
                .put("providerId", "orphan-provider")
                .put("scope", "consumer-subscription")
                .put("generation", 0)
                .put("deleted", false)
                .put("sourceObservedAt", "2026-07-15T00:31:00Z")
                .put("receivedAt", "2026-07-15T00:31:01Z")
        )
        assertThrows(QuotaContractException::class.java) {
            QuotaSnapshotJson.parseTransport(orphanActive.toString())
        }
    }

    @Test
    fun strictSyncPinsSourceToScopeWhileOrdinaryReaderStaysForwardCompatible() {
        val root = JSONObject(fixture("transport-v2.json"))
        val consumer = JSONObject(
            root.getJSONObject("readResponse").getJSONArray("providers").getJSONObject(0).toString()
        )
        consumer.getJSONArray("windows").getJSONObject(0).put("source", "official-api")
        QuotaSnapshotJson.parseProvider(consumer, QuotaParseMode.OrdinaryReader)
        assertThrows(QuotaContractException::class.java) {
            QuotaSnapshotJson.parseProvider(consumer, QuotaParseMode.SyncedTransport)
        }

        val apiOrganization = JSONObject(consumer.toString())
            .put("providerId", "openai-api-organization")
            .put("scope", "api-organization")
        apiOrganization.getJSONArray("windows").getJSONObject(0)
            .put("providerId", "openai-api-organization")
            .put("scope", "api-organization")
            .put("source", "local-authorized")
        QuotaSnapshotJson.parseProvider(apiOrganization, QuotaParseMode.OrdinaryReader)
        assertThrows(QuotaContractException::class.java) {
            QuotaSnapshotJson.parseProvider(apiOrganization, QuotaParseMode.SyncedTransport)
        }

        apiOrganization.getJSONArray("windows").getJSONObject(0).put("source", "official-api")
        QuotaSnapshotJson.parseProvider(apiOrganization, QuotaParseMode.SyncedTransport)

        val complete = JSONObject(fixture("complete-v1.json"))
        val manual = complete.getJSONArray("providers").getJSONObject(3)
        QuotaSnapshotJson.parseProvider(manual, QuotaParseMode.SyncedTransport)
    }

    @Test
    fun freshnessUsesObservationAndResetNeverTransportGeneratedAt() {
        val response = JSONObject(fixture("transport-v2.json")).getJSONObject("readResponse")
        val parsed = QuotaSnapshotJson.parseTransport(response.toString())
        val window = parsed.providers.first { it.providerId == "openai-codex-local" }.windows.single()

        assertEquals(
            QuotaWindowStatus.Ok,
            window.effectiveStatus(Instant.parse("2026-07-15T00:40:00Z"))
        )
        assertEquals(
            QuotaWindowStatus.Stale,
            window.effectiveStatus(Instant.parse("2026-07-15T00:45:00Z"))
        )
        assertEquals(
            QuotaWindowStatus.Stale,
            window.effectiveStatus(Instant.parse("2026-07-15T02:00:00Z"))
        )
        assertNull(
            parsed.copy(providers = emptyList()).nextFreshnessDeadline(
                now = Instant.parse("2026-07-15T03:00:00Z")
            )
        )
    }

    @Test
    fun directPercentRemainsDrawableWhenOptionalLimitAndRemainingAreAbsent() {
        val response = JSONObject(fixture("transport-v2.json")).getJSONObject("readResponse")
        val window = QuotaSnapshotJson.parseTransport(response.toString())
            .providers
            .first { it.providerId == "openai-codex-local" }
            .windows
            .single()
            .copy(limit = null, remaining = null)

        val display = window.displayValue() as QuotaDisplayValue.Progress
        assertEquals(100.0, display.limit, 0.0)
        assertEquals(62.0, display.remaining ?: Double.NaN, 0.0)
        assertEquals(0.38f, display.fraction, 0.0001f)
    }

    private fun fixture(name: String): String {
        val resource = checkNotNull(javaClass.classLoader?.getResource("quota-provider-v1/$name")) {
            "Missing shared quota fixture: $name"
        }
        return resource.readText()
    }
}

private fun JSONObject.stringList(key: String): List<String> {
    val array = getJSONArray(key)
    return buildList {
        for (index in 0 until array.length()) add(array.getString(index))
    }
}
