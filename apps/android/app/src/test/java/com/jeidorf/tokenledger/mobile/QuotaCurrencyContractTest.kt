package com.jeidorf.tokenledger.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class QuotaCurrencyContractTest {
    private val currency = JSONObject(fixture("currency-v1.json"))
    private val transport = JSONObject(fixture("transport-v3.json"))

    @Test
    fun validBalanceWindowsKeepIsoCodeAndOnlyDrawProgressWithSameCurrencyLimit() {
        val raw = JSONObject().put("providers", currency.getJSONArray("validProviders")).toString()
        val expected = currency.getJSONObject("expected")
        for (mode in QuotaParseMode.entries) {
            val providers = QuotaSnapshotJson.parseFixtureProviders(raw, mode)
            assertEquals(expected.length(), providers.size)
            providers.forEach { provider ->
                val expectedWindows = expected.getJSONObject(provider.providerId).getJSONObject("windows")
                assertEquals(expectedWindows.length(), provider.windows.size)
                provider.windows.forEach { window ->
                    val want = expectedWindows.getJSONObject(window.windowId)
                    assertEquals(QuotaUnit.Currency, window.unit)
                    assertEquals(want.getString("currency"), window.currency)
                    assertEquals(want.getDouble("remaining"), window.remaining ?: Double.NaN, 0.0)
                    val display = window.displayValue()
                    assertEquals(
                        "${window.stableKey} progress",
                        want.getBoolean("sameCurrencyLimit"),
                        display is QuotaDisplayValue.Progress
                    )
                    val label = checkNotNull(quotaValueLabel(display))
                    val amount = formatQuotaCurrencyAmount(want.getDouble("remaining"), want.getString("currency"))
                    assertTrue(label, label.contains(amount))
                }
            }
        }
        val windows = QuotaSnapshotJson.parseFixtureProviders(raw, QuotaParseMode.OrdinaryReader)
            .flatMap { it.windows }
        assertEquals("可用 ¥12.50", quotaValueLabel(windows.first { it.windowId == "balance-cny" }.displayValue()))
        assertEquals("可用 7.00 XTS", quotaValueLabel(windows.first { it.currency == "XTS" }.displayValue()))
    }

    @Test
    fun currencyFormattingMatchesDesktopSymbolTable() {
        assertEquals("¥1,234.50", formatQuotaCurrencyAmount(1234.5, "CNY"))
        assertEquals("$5.00", formatQuotaCurrencyAmount(5.0, "USD"))
        assertEquals("€7.00", formatQuotaCurrencyAmount(7.0, "EUR"))
        assertEquals("£0.50", formatQuotaCurrencyAmount(0.5, "GBP"))
        assertEquals("JP¥1,200", formatQuotaCurrencyAmount(1200.0, "JPY"))
        assertEquals("8.00 HKD", formatQuotaCurrencyAmount(8.0, "HKD"))
    }

    @Test
    fun balanceFixtureDisplaysTheSameTextAsDesktop() {
        val providers = JSONObject(fixture("balance-v1.json")).getJSONArray("providers")
        var checked = 0
        for (index in 0 until providers.length()) {
            val entry = providers.getJSONObject(index)
            val envelope = entry.getJSONObject("envelope")
            val display = entry.getJSONArray("display")
            if (display.length() == 0) {
                assertTrue(envelope.getString("status") in setOf("error", "auth-required"))
                continue
            }
            val raw = JSONObject().put("providers", JSONArray().put(envelope)).toString()
            val provider = QuotaSnapshotJson.parseFixtureProviders(raw, QuotaParseMode.OrdinaryReader).single()
            assertEquals(
                envelope.getString("providerId"),
                (0 until display.length()).map { "可用 ${display.getString(it)}" },
                provider.windows.map { quotaValueLabel(it.displayValue()) }
            )
            checked += provider.windows.size
        }
        assertTrue(checked >= 5)
    }

    @Test
    fun balanceUnavailableHasDedicatedCopy() {
        val reason = com.jeidorf.tokenledger.mobile.ui.foundation.v2QuotaReason("balance_unavailable")
        assertEquals("供应商余额接口没有返回可验证的余额或币种", reason)
        val provider = QuotaProviderEnvelope(
            schemaVersion = 1,
            providerId = "balance-deepseek",
            displayName = "DeepSeek 余额",
            scope = QuotaScope.ApiOrganization,
            mode = QuotaMode.Automatic,
            capability = QuotaCapability.Stable,
            status = QuotaProviderStatus.Error,
            windows = emptyList(),
            reasonCode = "balance_unavailable"
        )
        assertTrue(quotaRecoveryGuidance(provider).contains("供应商余额"))
    }

    @Test
    fun invalidCurrencyWindowsFailClosedInEveryParseMode() {
        val cases = currency.getJSONArray("cases")
        assertTrue(cases.length() > 0)
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val raw = JSONObject().put("providers", case.getJSONArray("providers")).toString()
            for (mode in QuotaParseMode.entries) {
                assertThrows("${case.getString("name")} $mode", QuotaContractException::class.java) {
                    QuotaSnapshotJson.parseFixtureProviders(raw, mode)
                }
            }
        }
    }

    @Test
    fun unknownUnitsDropOnlyTheirWindowsAndKeepTheResponse() {
        val cases = currency.getJSONArray("unknownUnitCases")
        val others = currency.getJSONArray("validProviders")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val name = case.getString("name")
            val expected = case.getJSONObject("expected")
            val providersJson = JSONArray(others.toString()).put(case.getJSONObject("provider"))
            val raw = JSONObject().put("providers", providersJson).toString()
            val providers = QuotaSnapshotJson.parseFixtureProviders(raw, QuotaParseMode.OrdinaryReader)
            val target = providers.firstOrNull { it.providerId == case.getJSONObject("provider").getString("providerId") }
            assertEquals(name, others.length() + if (expected.getBoolean("kept")) 1 else 0, providers.size)
            if (!expected.getBoolean("kept")) {
                assertEquals(name, null, target)
                continue
            }
            checkNotNull(target)
            assertEquals(name, expected.getString("status"), target.status.wireValue)
            assertEquals(
                name,
                (0 until expected.getJSONArray("windowIds").length()).map {
                    expected.getJSONArray("windowIds").getString(it)
                },
                target.windows.map { it.windowId }
            )
        }
    }

    @Test
    fun transportV3CarriesCurrencyWhileV2RejectsIt() {
        val v3Response = transport.getJSONObject("v3ReadResponse")
        val v3 = QuotaSnapshotJson.parseTransport(v3Response.toString())
        assertEquals(QUOTA_CURRENCY_TRANSPORT_VERSION, v3.transportVersion)
        assertTrue(v3.providers.any { provider -> provider.windows.any { it.unit == QuotaUnit.Currency } })
        assertEquals(v3, QuotaSnapshotJson.parseTransport(QuotaSnapshotJson.encodeTransport(v3)))
        assertTrue(quotaSnapshotFitsCacheKey(QUOTA_TRANSPORT_VERSION, v3.transportVersion))

        val v2 = QuotaSnapshotJson.parseTransport(transport.getJSONObject("v2ReadResponse").toString())
        assertEquals(QUOTA_TRANSPORT_VERSION, v2.transportVersion)
        assertTrue(v2.providers.none { provider -> provider.windows.any { it.unit == QuotaUnit.Currency } })
        assertEquals(v2.providers.size, v2.providerStates.count { !it.deleted })

        val downgraded = JSONObject(v3Response.toString()).put("transportVersion", QUOTA_TRANSPORT_VERSION)
        assertThrows(QuotaContractException::class.java) {
            QuotaSnapshotJson.parseTransport(downgraded.toString())
        }
        val future = JSONObject(v3Response.toString()).put("transportVersion", 4)
        assertThrows(QuotaContractException::class.java) {
            QuotaSnapshotJson.parseTransport(future.toString())
        }
        assertFalse(quotaSnapshotFitsCacheKey(QUOTA_CURRENCY_TRANSPORT_VERSION, QUOTA_CURRENCY_TRANSPORT_VERSION))
    }

    @Test
    fun transportV3ToleratesStatesWhoseEnvelopeWasDroppedForUnknownUnits() {
        val response = JSONObject(transport.getJSONObject("v3ReadResponse").toString())
        val providers = response.getJSONArray("providers")
        val currencyProvider = (0 until providers.length())
            .map(providers::getJSONObject)
            .first { provider ->
                val windows = provider.getJSONArray("windows")
                (0 until windows.length()).any { windows.getJSONObject(it).getString("unit") == "currency" }
            }
        val windows = currencyProvider.getJSONArray("windows")
        for (index in 0 until windows.length()) {
            windows.getJSONObject(index).put("unit", "gems").remove("currency")
        }
        val parsed = QuotaSnapshotJson.parseTransport(response.toString())
        assertTrue(parsed.providers.none { it.providerId == currencyProvider.getString("providerId") })
        assertEquals(providers.length() - 1, parsed.providers.size)

        val strict = JSONObject(response.toString()).put("transportVersion", QUOTA_TRANSPORT_VERSION)
        assertThrows(QuotaContractException::class.java) {
            QuotaSnapshotJson.parseTransport(strict.toString())
        }
    }

    @Test
    fun missingV3ReadOnLegacyCloudFallsBackWithoutLookingUndeployed() {
        val missing = transport.getJSONObject("legacyCloudFallback").getJSONObject("missingV3Response")
        val body = missing.getJSONObject("body")
        val error = SupabaseHttpException(
            status = missing.getInt("status"),
            code = body.getString("code"),
            detail = body.toString(),
            displayMessage = "Supabase request failed"
        )
        assertTrue(error.isMissingRpcSignature(QUOTA_READ_V3_FUNCTION))
        assertFalse(error.isMissingRpcSignature(QUOTA_READ_V2_FUNCTION))
        assertEquals(transport.getJSONObject("functions").getString("read"), QUOTA_READ_V3_FUNCTION)
    }

    private fun fixture(name: String): String {
        val resource = checkNotNull(javaClass.classLoader?.getResource("quota-provider-v1/$name")) {
            "Missing shared quota fixture: $name"
        }
        return resource.readText()
    }
}
