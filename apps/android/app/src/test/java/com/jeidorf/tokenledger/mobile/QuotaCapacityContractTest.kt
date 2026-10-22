package com.jeidorf.tokenledger.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class QuotaCapacityContractTest {
    private val fixture = JSONObject(checkNotNull(
        javaClass.classLoader?.getResource("quota-provider-v1/transport-capacity-v1.json")
    ).readText())
    private val key = QuotaCacheKey("capacity-anonymous-user")
    private val identity = QuotaCacheWriteIdentity("capacity-writer", 1, 1, 7, 12)

    @Test
    fun sharedCapacityCasesKeepEveryTombstoneAndRejectTheNinthActiveState() {
        val cases = fixture.getJSONArray("cases")
        assertEquals(20, cases.length())
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val name = case.getString("name")
            val raw = case.getJSONObject("response").toString()
            if (!case.getBoolean("accepted")) {
                assertThrows(name, QuotaContractException::class.java) {
                    QuotaSnapshotJson.parseTransport(raw)
                }
                continue
            }
            val snapshot = QuotaSnapshotJson.parseTransport(raw)
            assertEquals(name, case.getInt("expectedProviderCount"), snapshot.providers.size)
            assertEquals(name, case.getInt("expectedStateCount"), snapshot.providerStates.size)
            assertEquals(name, case.getInt("expectedActiveCount"), snapshot.providerStates.count { !it.deleted })
            assertEquals(name, snapshot, QuotaSnapshotJson.parseTransport(QuotaSnapshotJson.encodeTransport(snapshot)))
            val cached = QuotaCachedSnapshot(snapshot, 1_750_000_000_000L)
            val encoded = QuotaCacheJson.encode(key, cached, identity)
            val decoded = QuotaCacheJson.decode(encoded, key, 1_750_000_000_001L)
            assertEquals(name, cached, decoded?.snapshot)
            assertEquals(name, snapshot.providerStates, decoded?.snapshot?.snapshot?.providerStates)
        }
    }

    @Test
    fun transportBudgetCountsWholeUtf8ResponseBeforeParsing() {
        val raw = fixture.getJSONArray("cases").getJSONObject(0).getJSONObject("response").toString()
        val boundary = raw + " ".repeat(QUOTA_TRANSPORT_MAX_BYTES - raw.toByteArray(Charsets.UTF_8).size)
        assertEquals(QUOTA_TRANSPORT_MAX_BYTES, boundary.toByteArray(Charsets.UTF_8).size)
        assertTrue(QuotaSnapshotJson.parseTransport(boundary).providerStates.size > 8)
        assertThrows(QuotaContractException::class.java) { QuotaSnapshotJson.parseTransport(boundary + " ") }
        // An invalid oversized JSON still gets the budget error before JSON parsing.
        val error = assertThrows(QuotaContractException::class.java) {
            QuotaSnapshotJson.parseTransport("中".repeat(QUOTA_TRANSPORT_MAX_BYTES / 3 + 1))
        }
        assertEquals("transport_payload_too_large", error.reasonCode)
    }

    @Test
    fun nearLimitSnapshotFitsTheCacheWithoutChargingWrapperAgainstTransportBudget() {
        val snapshot = QuotaSnapshotJson.parseTransport(
            fixture.getJSONArray("cases").getJSONObject(0).getJSONObject("response").toString()
        )
        val tombstone = snapshot.providerStates.first { it.deleted }
        val one = tombstone.copy(providerId = "deleted-0000-" + "x".repeat(115))
        val baseBytes = QuotaSnapshotJson.encodeTransport(snapshot).toByteArray(Charsets.UTF_8).size
        val oneBytes = QuotaSnapshotJson.encodeTransport(snapshot.copy(
            providerStates = snapshot.providerStates + one
        )).toByteArray(Charsets.UTF_8).size - baseBytes
        val count = (QUOTA_TRANSPORT_MAX_BYTES - baseBytes) / oneBytes
        val large = snapshot.copy(providerStates = snapshot.providerStates + (0 until count).map {
            tombstone.copy(providerId = "deleted-%04d-".format(it) + "x".repeat(115))
        })
        val transportBytes = QuotaSnapshotJson.encodeTransport(large).toByteArray(Charsets.UTF_8).size
        assertTrue(transportBytes > QUOTA_TRANSPORT_MAX_BYTES - 1_024)
        val cached = QuotaCachedSnapshot(large, 1_750_000_000_000L)
        val raw = QuotaCacheJson.encode(key, cached, identity)
        assertTrue(raw.toByteArray(Charsets.UTF_8).size <= QuotaCacheJson.MAX_CACHE_JSON_BYTES)
        assertEquals(cached, QuotaCacheJson.decode(raw, key, 1_750_000_000_001L)?.snapshot)
        val tooLarge = large.copy(providerStates = large.providerStates + one.copy(providerId = "overflow-" + "x".repeat(119)))
        assertThrows(QuotaContractException::class.java) { QuotaSnapshotJson.encodeTransport(tooLarge) }
    }

    @Test
    fun cacheWrapperBudgetAppliesBeforeEveryJsonReadAndWrite() {
        val snapshot = QuotaSnapshotJson.parseTransport(
            fixture.getJSONArray("cases").getJSONObject(0).getJSONObject("response").toString()
        )
        val cached = QuotaCachedSnapshot(snapshot, 1_750_000_000_000L)
        val raw = QuotaCacheJson.encode(key, cached, identity)
        val boundary = raw + " ".repeat(QuotaCacheJson.MAX_CACHE_JSON_BYTES - raw.toByteArray(Charsets.UTF_8).size)
        assertEquals(cached, QuotaCacheJson.decode(boundary, key, 1_750_000_000_001L)?.snapshot)
        assertEquals(identity, QuotaCacheJson.metadata(boundary))
        assertNull(QuotaCacheJson.decode(boundary + " ", key, 1_750_000_000_001L))
        assertNull(QuotaCacheJson.metadata(boundary + " "))
        assertNull(QuotaCacheJson.decodeTombstone(boundary + " ", key))
        assertThrows(IllegalArgumentException::class.java) {
            QuotaCacheJson.encode(key.copy(userId = "x".repeat(QuotaCacheJson.MAX_CACHE_JSON_BYTES)), cached, identity)
        }
        assertThrows(IllegalArgumentException::class.java) {
            QuotaCacheJson.encodeTombstone(key.copy(userId = "x".repeat(QuotaCacheJson.MAX_CACHE_JSON_BYTES)), identity)
        }
    }
}
