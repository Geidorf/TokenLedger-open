package com.jeidorf.tokenledger.mobile

import android.content.SharedPreferences
import com.jeidorf.tokenledger.mobile.widget.WidgetRefreshWriter
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QuotaCacheTest {
    @Test
    fun strictSnapshotRoundTripsWithOwnerAndRevisionIdentity() {
        val snapshot = transportSnapshot()
        val key = QuotaCacheKey("user-1")
        val identity = identity(requestId = 12, generation = 4, epoch = 7, revision = 12)
        val cached = QuotaCachedSnapshot(snapshot, savedAtEpochMillis = 1_750_000_000_000L)
        val raw = QuotaCacheJson.encode(key, cached, identity)

        val decoded = QuotaCacheJson.decode(raw, key, 1_750_000_001_000L)

        assertEquals(cached, decoded?.snapshot)
        assertEquals(identity, decoded?.metadata)
        assertNull(QuotaCacheJson.decode(raw, key.copy(userId = "user-2"), 1_750_000_001_000L))
        assertNull(QuotaCacheJson.decode(raw, key.copy(transportVersion = 1), 1_750_000_001_000L))
    }

    @Test
    fun cacheRemainsReadableRegardlessOfSnapshotAge() {
        val snapshot = transportSnapshot()
        val key = QuotaCacheKey("user-1")
        val savedAt = 1_750_000_000_000L
        val raw = QuotaCacheJson.encode(
            key,
            QuotaCachedSnapshot(snapshot, savedAt),
            identity(requestId = 12, generation = 4, epoch = 7, revision = 12)
        )

        assertTrue(QuotaCacheJson.decode(raw, key, savedAt + 10L * 365L * 24L * 60L * 60L * 1_000L) != null)
        assertTrue(QuotaCacheJson.decode(raw, key, savedAt - 1) != null)
    }

    @Test
    fun generationTombstonePreventsAResponseFromResurrectingAfterLogout() {
        val old = identity(requestId = 20, generation = 4, epoch = 7, revision = 12)
        val clear = identity(requestId = 21, generation = 5, epoch = 0, revision = 0)
        val nextLogin = identity(requestId = 22, generation = 6, epoch = 8, revision = 13)

        assertFalse(shouldCommitQuotaWrite(existing = null, tombstone = clear, incoming = old))
        assertTrue(shouldCommitQuotaWrite(existing = null, tombstone = clear, incoming = nextLogin))
    }

    @Test
    fun lateInvalidationCannotDeleteANewerGenerationSnapshotOrTombstone() {
        val lateClear = identity(requestId = 20, generation = 4, epoch = 7, revision = 12)
        val newerSnapshot = identity(requestId = 22, generation = 6, epoch = 8, revision = 13)
        val newerClear = identity(requestId = 23, generation = 7, epoch = 0, revision = 0)

        assertFalse(
            shouldCommitQuotaInvalidation(
                existing = newerSnapshot,
                tombstone = null,
                incoming = lateClear
            )
        )
        assertFalse(
            shouldCommitQuotaInvalidation(
                existing = null,
                tombstone = newerClear,
                incoming = lateClear
            )
        )
        assertTrue(
            shouldCommitQuotaInvalidation(
                existing = newerSnapshot,
                tombstone = null,
                incoming = newerClear
            )
        )
    }

    @Test
    fun cacheReadRejectsOldGenerationFromThisProcessButAllowsPreviousProcessLkg() {
        val oldGeneration = identity(requestId = 20, generation = 4, epoch = 7, revision = 12)

        assertFalse(
            isQuotaCacheReadable(
                metadata = oldGeneration,
                writerId = oldGeneration.writerId,
                requestId = 22,
                sessionGeneration = 6
            )
        )
        assertTrue(
            isQuotaCacheReadable(
                metadata = oldGeneration,
                writerId = "next-process",
                requestId = 1,
                sessionGeneration = 1
            )
        )
    }

    @Test
    fun epochAndRevisionCannotMoveBackwardsEvenForANewerRequestId() {
        val existing = identity(requestId = 20, generation = 4, epoch = 8, revision = 13)
        val oldEpoch = identity(requestId = 30, generation = 4, epoch = 7, revision = 99)
        val oldRevision = identity(requestId = 31, generation = 4, epoch = 8, revision = 12)
        val nextRevision = identity(requestId = 32, generation = 4, epoch = 8, revision = 14)

        assertFalse(shouldCommitQuotaWrite(existing, tombstone = null, incoming = oldEpoch))
        assertFalse(shouldCommitQuotaWrite(existing, tombstone = null, incoming = oldRevision))
        assertTrue(shouldCommitQuotaWrite(existing, tombstone = null, incoming = nextRevision))
    }

    @Test
    fun oldGenerationCannotOverwriteNewerLkgEvenWithAHigherServerRevision() {
        val newerGeneration = identity(requestId = 30, generation = 6, epoch = 8, revision = 13)
        val lateOldGeneration = identity(requestId = 31, generation = 5, epoch = 9, revision = 99)

        assertFalse(
            shouldCommitQuotaWrite(
                existing = newerGeneration,
                tombstone = null,
                incoming = lateOldGeneration
            )
        )
    }

    @Test
    fun twoCacheInstancesSerializeIdentityCheckAndCommitForTheSamePreferencesKey() = runTest {
        val preferences = InMemorySharedPreferences()
        val key = QuotaCacheKey("shared-user")
        val oldSnapshot = transportSnapshot()
        val newSnapshot = oldSnapshot.copy(epoch = 8, revision = 13)
        val oldSave = identity(requestId = 10, generation = 4, epoch = 7, revision = 12)
        val lateInvalidation = identity(
            requestId = 20,
            generation = 5,
            epoch = 0,
            revision = 0
        )
        val newSave = identity(requestId = 30, generation = 6, epoch = 8, revision = 13)
        val invalidationChecked = CompletableDeferred<Unit>()
        val releaseInvalidation = CompletableDeferred<Unit>()
        val saveReachedLock = CompletableDeferred<Unit>()
        val cacheA = QuotaCache(
            prefs = preferences,
            cipher = PlaintextQuotaCacheCipher,
            operationObserver = QuotaCacheOperationObserver { operation, phase, observedKey ->
                if (
                    operation == QuotaCacheOperation.Invalidate &&
                    phase == QuotaCacheOperationPhase.AfterIdentityCheck &&
                    observedKey == key
                ) {
                    invalidationChecked.complete(Unit)
                    releaseInvalidation.await()
                }
            }
        )
        val cacheB = QuotaCache(
            prefs = preferences,
            cipher = PlaintextQuotaCacheCipher,
            operationObserver = QuotaCacheOperationObserver { operation, phase, observedKey ->
                if (
                    operation == QuotaCacheOperation.Save &&
                    phase == QuotaCacheOperationPhase.BeforeLock &&
                    observedKey == key
                ) {
                    saveReachedLock.complete(Unit)
                }
            }
        )
        val savedAt = 1_750_000_000_000L
        cacheA.save(key, QuotaCachedSnapshot(oldSnapshot, savedAt), oldSave)

        val invalidateJob = async { cacheA.invalidate(key, lateInvalidation) }
        invalidationChecked.await()
        val processLock = ProcessQuotaCacheOperationLocks.mutexFor(key)
        assertTrue(processLock.isLocked)

        val saveJob = async {
            cacheB.save(key, QuotaCachedSnapshot(newSnapshot, savedAt + 1_000L), newSave)
        }
        saveReachedLock.await()
        assertTrue(processLock.isLocked)
        assertFalse(saveJob.isCompleted)

        releaseInvalidation.complete(Unit)
        invalidateJob.await()
        saveJob.await()

        val restored = cacheA.load(key, savedAt + 2_000L)
        assertEquals(newSave, restored?.metadata)
        assertEquals(newSnapshot, restored?.snapshot?.snapshot)
    }

    @Test
    fun widgetNewerEmptyProjectionRemovesVisibleProvidersAndRetainsVersionWatermark() = runTest {
        val cache = QuotaCache(InMemorySharedPreferences(), PlaintextQuotaCacheCipher)
        val key = QuotaCacheKey("widget-owner")
        val snapshot = transportSnapshot()
        val oldIdentity = identity(1, 0, snapshot.epoch, snapshot.revision)
        cache.save(key, QuotaCachedSnapshot(snapshot, 1_750_000_000_000L), oldIdentity)
        val empty = snapshot.copy(
            epoch = snapshot.epoch + 1,
            revision = snapshot.revision + 1,
            providers = emptyList(),
            providerStates = emptyList()
        )
        WidgetRefreshWriter.persistQuotaSnapshot(
            cache, key, empty, 1_750_000_001_000L,
            oldIdentity.copy(writerId = "widget-writer", requestId = 2,
                epoch = empty.epoch, revision = empty.revision)
        )
        assertTrue(cache.load(key, 1_750_000_002_000L)!!.snapshot.snapshot.providers.isEmpty())
        // A response from another process cannot revive pre-clear values.
        cache.save(key, QuotaCachedSnapshot(snapshot, 1_750_000_003_000L), oldIdentity.copy(requestId = 99))
        assertEquals(empty, cache.load(key, 1_750_000_004_000L)?.snapshot?.snapshot)
    }

    @Test
    fun widgetSameEpochNewerEmptyRevisionSurvivesCacheReopen() = runTest {
        val prefs = InMemorySharedPreferences()
        val cache = QuotaCache(prefs, PlaintextQuotaCacheCipher)
        val key = QuotaCacheKey("widget-restart-owner")
        val snapshot = transportSnapshot()
        val oldIdentity = identity(1, 0, snapshot.epoch, snapshot.revision)
        cache.save(key, QuotaCachedSnapshot(snapshot, 1_750_000_000_000L), oldIdentity)
        val empty = snapshot.copy(revision = snapshot.revision + 1,
            providers = emptyList(), providerStates = emptyList())
        WidgetRefreshWriter.persistQuotaSnapshot(cache, key, empty, 1_750_000_001_000L,
            oldIdentity.copy(writerId = "widget-writer", revision = empty.revision))
        val reopened = QuotaCache(prefs, PlaintextQuotaCacheCipher)
        assertEquals(empty, reopened.load(key, 1_750_000_002_000L)?.snapshot?.snapshot)
    }

    @Test
    fun widgetOlderEmptyProjectionCannotDeleteNewerForegroundSnapshot() = runTest {
        val cache = QuotaCache(InMemorySharedPreferences(), PlaintextQuotaCacheCipher)
        val key = QuotaCacheKey("widget-owner")
        val snapshot = transportSnapshot()
        val freshIdentity = identity(1, 4, snapshot.epoch, snapshot.revision)
        cache.save(key, QuotaCachedSnapshot(snapshot, 1_750_000_000_000L), freshIdentity)
        for (empty in listOf(
            snapshot.copy(epoch = snapshot.epoch - 1, revision = snapshot.revision + 1),
            snapshot.copy(revision = snapshot.revision - 1)
        )) {
            WidgetRefreshWriter.persistQuotaSnapshot(
                cache, key, empty.copy(providers = emptyList(), providerStates = emptyList()),
                1_750_000_001_000L,
                freshIdentity.copy(writerId = "widget-writer", requestId = 99,
                    sessionGeneration = 0, epoch = empty.epoch, revision = empty.revision)
            )
            assertEquals(snapshot, cache.load(key, 1_750_000_002_000L)?.snapshot?.snapshot)
        }
    }

    private fun transportSnapshot(): QuotaTransportSnapshot {
        val root = JSONObject(fixture("transport-v2.json"))
        return QuotaSnapshotJson.parseTransport(root.getJSONObject("readResponse").toString())
    }

    private fun identity(
        requestId: Long,
        generation: Long,
        epoch: Long,
        revision: Long
    ) = QuotaCacheWriteIdentity("test-writer", requestId, generation, epoch, revision)

    private fun fixture(name: String): String {
        val resource = checkNotNull(javaClass.classLoader?.getResource("quota-provider-v1/$name"))
        return resource.readText()
    }

    internal object PlaintextQuotaCacheCipher : QuotaCacheCipher {
        override fun encrypt(preferenceKey: String, plaintext: String): String = plaintext

        override fun decrypt(preferenceKey: String, encrypted: String): String = encrypted
    }

    internal class InMemorySharedPreferences : SharedPreferences {
        var beforeCommit: (() -> Unit)? = null
        var commitResult = true
        private val values = linkedMapOf<String, Any?>()

        override fun getAll(): MutableMap<String, *> = synchronized(values) {
            values.toMutableMap()
        }

        override fun getString(key: String, defaultValue: String?): String? = synchronized(values) {
            values[key] as? String ?: defaultValue
        }

        override fun getStringSet(
            key: String,
            defaultValues: MutableSet<String>?
        ): MutableSet<String>? = synchronized(values) {
            @Suppress("UNCHECKED_CAST")
            ((values[key] as? Set<String>) ?: defaultValues)?.toMutableSet()
        }

        override fun getInt(key: String, defaultValue: Int): Int = synchronized(values) {
            values[key] as? Int ?: defaultValue
        }

        override fun getLong(key: String, defaultValue: Long): Long = synchronized(values) {
            values[key] as? Long ?: defaultValue
        }

        override fun getFloat(key: String, defaultValue: Float): Float = synchronized(values) {
            values[key] as? Float ?: defaultValue
        }

        override fun getBoolean(key: String, defaultValue: Boolean): Boolean =
            synchronized(values) { values[key] as? Boolean ?: defaultValue }

        override fun contains(key: String): Boolean = synchronized(values) { key in values }

        override fun edit(): SharedPreferences.Editor = Editor()

        override fun registerOnSharedPreferenceChangeListener(
            listener: SharedPreferences.OnSharedPreferenceChangeListener
        ) = Unit

        override fun unregisterOnSharedPreferenceChangeListener(
            listener: SharedPreferences.OnSharedPreferenceChangeListener
        ) = Unit

        private inner class Editor : SharedPreferences.Editor {
            private val updates = linkedMapOf<String, Any?>()
            private val removals = linkedSetOf<String>()
            private var clear = false

            override fun putString(key: String, value: String?): SharedPreferences.Editor = apply {
                updates[key] = value
                removals -= key
            }

            override fun putStringSet(
                key: String,
                values: MutableSet<String>?
            ): SharedPreferences.Editor = apply {
                updates[key] = values?.toSet()
                removals -= key
            }

            override fun putInt(key: String, value: Int): SharedPreferences.Editor = apply {
                updates[key] = value
                removals -= key
            }

            override fun putLong(key: String, value: Long): SharedPreferences.Editor = apply {
                updates[key] = value
                removals -= key
            }

            override fun putFloat(key: String, value: Float): SharedPreferences.Editor = apply {
                updates[key] = value
                removals -= key
            }

            override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = apply {
                updates[key] = value
                removals -= key
            }

            override fun remove(key: String): SharedPreferences.Editor = apply {
                updates -= key
                removals += key
            }

            override fun clear(): SharedPreferences.Editor = apply {
                clear = true
                updates.clear()
                removals.clear()
            }

            override fun commit(): Boolean {
                beforeCommit?.invoke()
                synchronized(values) {
                    if (clear) values.clear()
                    removals.forEach(values::remove)
                    updates.forEach { (key, value) ->
                        if (value == null) values.remove(key) else values[key] = value
                    }
                }
                return commitResult
            }

            override fun apply() {
                commit()
            }
        }
    }
}
