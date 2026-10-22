package com.jeidorf.tokenledger.mobile

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal data class QuotaCacheKey(
    val userId: String,
    val transportVersion: Int = QUOTA_TRANSPORT_VERSION
) {
    init {
        require(userId.isNotBlank())
        require(transportVersion > 0)
    }

    fun canonicalValue(): String = "$transportVersion:${userId.length}:$userId"
}

internal data class QuotaCachedSnapshot(
    val snapshot: QuotaTransportSnapshot,
    val savedAtEpochMillis: Long
)

internal data class QuotaCacheWriteIdentity(
    val writerId: String,
    val requestId: Long,
    val sessionGeneration: Long,
    val epoch: Long,
    val revision: Long
)

internal interface QuotaSnapshotStore {
    suspend fun load(key: QuotaCacheKey, nowEpochMillis: Long): DecodedQuotaCache?

    suspend fun save(
        key: QuotaCacheKey,
        snapshot: QuotaCachedSnapshot,
        identity: QuotaCacheWriteIdentity
    )

    suspend fun invalidate(key: QuotaCacheKey, identity: QuotaCacheWriteIdentity)
}

internal object NoopQuotaSnapshotStore : QuotaSnapshotStore {
    override suspend fun load(key: QuotaCacheKey, nowEpochMillis: Long): DecodedQuotaCache? = null

    override suspend fun save(
        key: QuotaCacheKey,
        snapshot: QuotaCachedSnapshot,
        identity: QuotaCacheWriteIdentity
    ) = Unit

    override suspend fun invalidate(key: QuotaCacheKey, identity: QuotaCacheWriteIdentity) = Unit
}

internal interface QuotaCacheCipher {
    fun encrypt(preferenceKey: String, plaintext: String): String

    fun decrypt(preferenceKey: String, encrypted: String): String
}

internal enum class QuotaCacheOperation { Save, Invalidate }

internal enum class QuotaCacheOperationPhase { BeforeLock, AfterIdentityCheck }

internal fun interface QuotaCacheOperationObserver {
    suspend fun onPhase(
        operation: QuotaCacheOperation,
        phase: QuotaCacheOperationPhase,
        key: QuotaCacheKey
    )
}

/** Every QuotaCache instance in this process shares one lock per owner-bound cache key. */
internal object ProcessQuotaCacheOperationLocks {
    private val locks = ConcurrentHashMap<String, Mutex>()

    fun mutexFor(key: QuotaCacheKey): Mutex = locks.computeIfAbsent(lockIdentity(key)) { Mutex() }

    private fun lockIdentity(key: QuotaCacheKey): String = MessageDigest.getInstance("SHA-256")
        .digest(key.canonicalValue().toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
}

/** Encrypted, owner-bound last-known-good quota snapshot. */
internal class QuotaCache internal constructor(
    private val prefs: SharedPreferences,
    private val cipher: QuotaCacheCipher,
    private val operationObserver: QuotaCacheOperationObserver? = null
) : QuotaSnapshotStore {
    constructor(context: Context) : this(
        prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE),
        cipher = AndroidQuotaCacheCipher
    )

    override suspend fun load(
        key: QuotaCacheKey,
        nowEpochMillis: Long
    ): DecodedQuotaCache? = withContext(Dispatchers.IO) {
        ProcessQuotaCacheOperationLocks.mutexFor(key).withLock {
            val preferenceKey = entryKey(key)
            val encrypted = prefs.getString(preferenceKey, null) ?: return@withLock null
            val decoded = runCatching {
                QuotaCacheJson.decode(
                    cipher.decrypt(preferenceKey, encrypted),
                    key,
                    nowEpochMillis
                )
            }.getOrNull()
            val readable = decoded?.takeIf {
                shouldCommitQuotaWrite(
                    existing = null,
                    tombstone = readTombstone(key),
                    incoming = it.metadata
                )
            }
            if (readable == null) prefs.edit().remove(preferenceKey).commit()
            readable
        }
    }

    override suspend fun save(
        key: QuotaCacheKey,
        snapshot: QuotaCachedSnapshot,
        identity: QuotaCacheWriteIdentity
    ) = saveForSession(key, snapshot, identity, null)

    internal suspend fun saveForSession(
        key: QuotaCacheKey,
        snapshot: QuotaCachedSnapshot,
        identity: QuotaCacheWriteIdentity,
        sessionGuard: SessionWriteGuard?
    ) {
        requireIdentity(identity)
        require(quotaSnapshotFitsCacheKey(key.transportVersion, snapshot.snapshot.transportVersion))
        require(snapshot.snapshot.epoch == identity.epoch)
        require(snapshot.snapshot.revision == identity.revision)
        withContext(Dispatchers.IO) {
            operationObserver?.onPhase(
                QuotaCacheOperation.Save,
                QuotaCacheOperationPhase.BeforeLock,
                key
            )
            ProcessQuotaCacheOperationLocks.mutexFor(key).withLock {
                val tombstone = readTombstone(key)
                val preferenceKey = entryKey(key)
                val existing = readEntryMetadata(key)
                if (!shouldCommitQuotaWrite(existing, tombstone, identity)) return@withLock
                operationObserver?.onPhase(
                    QuotaCacheOperation.Save,
                    QuotaCacheOperationPhase.AfterIdentityCheck,
                    key
                )

                val plaintext = QuotaCacheJson.encode(key, snapshot, identity)
                val encrypted = cipher.encrypt(preferenceKey, plaintext)
                val commit = {
                    check(prefs.edit().putString(preferenceKey, encrypted).commit()) {
                        "额度缓存未可靠落盘"
                    }
                    Unit
                }
                if (sessionGuard == null) commit() else sessionGuard.commit(commit)
            }
        }
    }

    override suspend fun invalidate(key: QuotaCacheKey, identity: QuotaCacheWriteIdentity) {
        requireIdentity(identity)
        withContext(Dispatchers.IO) {
            operationObserver?.onPhase(
                QuotaCacheOperation.Invalidate,
                QuotaCacheOperationPhase.BeforeLock,
                key
            )
            ProcessQuotaCacheOperationLocks.mutexFor(key).withLock {
                val existing = readEntryMetadata(key)
                val tombstone = readTombstone(key)
                if (!shouldCommitQuotaInvalidation(existing, tombstone, identity)) {
                    return@withLock
                }
                operationObserver?.onPhase(
                    QuotaCacheOperation.Invalidate,
                    QuotaCacheOperationPhase.AfterIdentityCheck,
                    key
                )
                val tombstoneKey = tombstoneKey(key)
                val tombstoneRaw = QuotaCacheJson.encodeTombstone(key, identity)
                prefs.edit()
                    .remove(entryKey(key))
                    .putString(tombstoneKey, cipher.encrypt(tombstoneKey, tombstoneRaw))
                    .commit()
            }
        }
    }

    private fun readEntryMetadata(key: QuotaCacheKey): QuotaCacheWriteIdentity? {
        val preferenceKey = entryKey(key)
        val encrypted = prefs.getString(preferenceKey, null) ?: return null
        return runCatching {
            QuotaCacheJson.metadata(cipher.decrypt(preferenceKey, encrypted))
        }.getOrNull()
    }

    private fun readTombstone(key: QuotaCacheKey): QuotaCacheWriteIdentity? {
        val preferenceKey = tombstoneKey(key)
        val encrypted = prefs.getString(preferenceKey, null) ?: return null
        return runCatching {
            QuotaCacheJson.decodeTombstone(cipher.decrypt(preferenceKey, encrypted), key)
        }.getOrElse {
            prefs.edit().remove(preferenceKey).commit()
            null
        }
    }

    private fun entryKey(key: QuotaCacheKey): String = ENTRY_PREFIX + digest(key.canonicalValue())

    private fun tombstoneKey(key: QuotaCacheKey): String =
        TOMBSTONE_PREFIX + digest(key.canonicalValue())

    private fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private fun requireIdentity(identity: QuotaCacheWriteIdentity) {
        require(identity.writerId.isNotBlank())
        require(identity.requestId > 0L)
        require(identity.sessionGeneration >= 0L)
        require(identity.epoch >= 0L)
        require(identity.revision >= 0L)
    }

    private companion object {
        const val PREFS_NAME = "tokenledger_quota_cache"
        const val ENTRY_PREFIX = "snapshot_"
        const val TOMBSTONE_PREFIX = "tombstone_"
    }
}

private object AndroidQuotaCacheCipher : QuotaCacheCipher {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "tokenledger_quota_cache_key"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128
    private val keyLock = Any()

    override fun encrypt(preferenceKey: String, plaintext: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
        cipher.updateAAD(preferenceKey.toByteArray(Charsets.UTF_8))
        val payload = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + "." +
            Base64.encodeToString(payload, Base64.NO_WRAP)
    }

    override fun decrypt(preferenceKey: String, encrypted: String): String {
        val parts = encrypted.split('.', limit = 2)
        require(parts.size == 2) { "Invalid quota cache envelope" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            getOrCreateSecretKey(),
            GCMParameterSpec(GCM_TAG_BITS, Base64.decode(parts[0], Base64.NO_WRAP))
        )
        cipher.updateAAD(preferenceKey.toByteArray(Charsets.UTF_8))
        return String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
    }

    private fun getOrCreateSecretKey(): SecretKey = synchronized(keyLock) {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return@synchronized existing.secretKey

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        generator.generateKey()
    }
}

internal data class DecodedQuotaCache(
    val snapshot: QuotaCachedSnapshot,
    val metadata: QuotaCacheWriteIdentity
)

internal object QuotaCacheJson {
    private const val CACHE_SCHEMA_VERSION = 2
    // The transport payload stays at 128 KiB; its owner/session wrapper has a
    // separate fixed 8 KiB allowance. Check plaintext before parsing, not ciphertext.
    internal const val MAX_CACHE_JSON_BYTES = QUOTA_TRANSPORT_MAX_BYTES + 8 * 1_024

    private fun fitsBudget(raw: String): Boolean =
        raw.toByteArray(Charsets.UTF_8).size <= MAX_CACHE_JSON_BYTES

    fun encode(
        key: QuotaCacheKey,
        snapshot: QuotaCachedSnapshot,
        identity: QuotaCacheWriteIdentity
    ): String = metadataRoot(key, identity)
        .put("savedAtEpochMillis", snapshot.savedAtEpochMillis)
        .put("snapshot", JSONObject(QuotaSnapshotJson.encodeTransport(snapshot.snapshot)))
        .toString()
        .also { require(fitsBudget(it)) { "Quota cache exceeds plaintext budget" } }

    fun decode(
        raw: String,
        expectedKey: QuotaCacheKey,
        nowEpochMillis: Long
    ): DecodedQuotaCache? {
        if (!fitsBudget(raw)) return null
        val root = JSONObject(raw)
        if (!matchesKey(root, expectedKey)) return null
        val savedAt = root.opt("savedAtEpochMillis") as? Number ?: return null
        val savedAtMillis = savedAt.toLong()
        if (
            savedAt.toDouble() != savedAtMillis.toDouble() || savedAtMillis <= 0L
        ) {
            return null
        }
        val snapshotObject = root.optJSONObject("snapshot") ?: return null
        val snapshot = QuotaSnapshotJson.parseTransport(snapshotObject.toString())
        val metadata = metadata(raw) ?: return null
        if (
            !quotaSnapshotFitsCacheKey(expectedKey.transportVersion, snapshot.transportVersion) ||
            snapshot.epoch != metadata.epoch || snapshot.revision != metadata.revision
        ) {
            return null
        }
        return DecodedQuotaCache(QuotaCachedSnapshot(snapshot, savedAtMillis), metadata)
    }

    fun metadata(raw: String): QuotaCacheWriteIdentity? {
        if (!fitsBudget(raw)) return null
        val root = JSONObject(raw)
        val writerId = root.optString("writerId").takeIf(String::isNotBlank) ?: return null
        val requestId = root.integer("requestId") ?: return null
        val generation = root.integer("sessionGeneration") ?: return null
        val epoch = root.integer("epoch") ?: return null
        val revision = root.integer("revision") ?: return null
        if (requestId <= 0L || generation < 0L || epoch < 0L || revision < 0L) return null
        return QuotaCacheWriteIdentity(writerId, requestId, generation, epoch, revision)
    }

    fun encodeTombstone(key: QuotaCacheKey, identity: QuotaCacheWriteIdentity): String =
        metadataRoot(key, identity).put("tombstone", true).toString()
            .also { require(fitsBudget(it)) { "Quota cache exceeds plaintext budget" } }

    fun decodeTombstone(raw: String, expectedKey: QuotaCacheKey): QuotaCacheWriteIdentity? {
        if (!fitsBudget(raw)) return null
        val root = JSONObject(raw)
        if (!matchesKey(root, expectedKey) || !root.optBoolean("tombstone", false)) return null
        return metadata(raw)
    }

    private fun metadataRoot(
        key: QuotaCacheKey,
        identity: QuotaCacheWriteIdentity
    ): JSONObject = JSONObject()
        .put("cacheSchemaVersion", CACHE_SCHEMA_VERSION)
        .put("userId", key.userId)
        .put("transportVersion", key.transportVersion)
        .put("writerId", identity.writerId)
        .put("requestId", identity.requestId)
        .put("sessionGeneration", identity.sessionGeneration)
        .put("epoch", identity.epoch)
        .put("revision", identity.revision)

    private fun matchesKey(root: JSONObject, expectedKey: QuotaCacheKey): Boolean =
        root.optInt("cacheSchemaVersion") == CACHE_SCHEMA_VERSION &&
            root.optString("userId") == expectedKey.userId &&
            root.optInt("transportVersion") == expectedKey.transportVersion
}

private fun JSONObject.integer(key: String): Long? {
    val number = opt(key) as? Number ?: return null
    val doubleValue = number.toDouble()
    val longValue = number.toLong()
    return longValue.takeIf { doubleValue.isFinite() && doubleValue == longValue.toDouble() }
}

internal fun shouldCommitQuotaWrite(
    existing: QuotaCacheWriteIdentity?,
    tombstone: QuotaCacheWriteIdentity?,
    incoming: QuotaCacheWriteIdentity
): Boolean {
    if (tombstone != null && tombstone.writerId == incoming.writerId && (
            tombstone.sessionGeneration > incoming.sessionGeneration ||
                (tombstone.sessionGeneration == incoming.sessionGeneration &&
                    tombstone.requestId >= incoming.requestId)
            )
    ) {
        return false
    }
    if (existing == null) return true
    return incoming.isNewerThan(existing)
}

internal fun shouldCommitQuotaInvalidation(
    existing: QuotaCacheWriteIdentity?,
    tombstone: QuotaCacheWriteIdentity?,
    incoming: QuotaCacheWriteIdentity
): Boolean = (existing == null || incoming.isLifecycleAtLeast(existing)) &&
    (tombstone == null || incoming.isLifecycleAtLeast(tombstone))

internal fun isQuotaCacheReadable(
    metadata: QuotaCacheWriteIdentity,
    writerId: String,
    requestId: Long,
    sessionGeneration: Long
): Boolean {
    if (metadata.writerId != writerId) return true
    return metadata.sessionGeneration == sessionGeneration && metadata.requestId < requestId
}

private fun QuotaCacheWriteIdentity.isNewerThan(existing: QuotaCacheWriteIdentity): Boolean {
    if (writerId == existing.writerId && sessionGeneration < existing.sessionGeneration) {
        return false
    }
    if (epoch != existing.epoch) return epoch > existing.epoch
    if (revision != existing.revision) return revision > existing.revision
    if (writerId != existing.writerId) return true
    if (sessionGeneration != existing.sessionGeneration) {
        return sessionGeneration > existing.sessionGeneration
    }
    return requestId > existing.requestId
}

private fun QuotaCacheWriteIdentity.isLifecycleAtLeast(existing: QuotaCacheWriteIdentity): Boolean {
    if (writerId != existing.writerId) return true
    if (sessionGeneration != existing.sessionGeneration) {
        return sessionGeneration > existing.sessionGeneration
    }
    return requestId >= existing.requestId
}
