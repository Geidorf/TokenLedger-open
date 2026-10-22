package com.jeidorf.tokenledger.mobile

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class DashboardCacheKey(
    val userId: String,
    val range: RangeKey,
    val machine: String,
    val timezoneId: String,
    val start: String? = null,
    val end: String? = null,
    val tool: String? = null,
    val model: String? = null,
    val machines: List<String> = DashboardQueryContract.legacyMachineValues(machine),
    val tools: List<String> = DashboardQueryContract.legacyOptionalValues("tools", tool),
    val models: List<String> = DashboardQueryContract.legacyOptionalValues("models", model),
    val search: String? = null,
    val tokenMode: String = EFFECTIVE_TOKEN_MODE,
    val entity: DashboardEntity? = null
) {
    fun canonicalValue(): String {
        val normalizedQuery = DashboardQueryContract.normalize(
            DashboardQuery(
                range = range,
                start = start,
                end = end,
                machines = machines,
                tools = tools,
                models = models,
                search = search,
                tokenMode = tokenMode
            )
        )
        val normalizedEntity = entity?.let(DashboardQueryContract::normalizeEntity)
        DashboardQueryContract.canonical(normalizedQuery, timezoneId, normalizedEntity)
        return buildList {
            add(CACHE_SCHEMA_VERSION.toString())
            add(userId)
            add(range.rpcValue)
            add(normalizedQuery.start.orEmpty())
            add(normalizedQuery.end.orEmpty())
            add(timezoneId.ifBlank { "UTC" })
            add(normalizedQuery.tokenMode)
            add(normalizedQuery.search.orEmpty())
            add(normalizedQuery.machines.size.toString())
            addAll(normalizedQuery.machines)
            add(normalizedQuery.tools.size.toString())
            addAll(normalizedQuery.tools)
            add(normalizedQuery.models.size.toString())
            addAll(normalizedQuery.models)
            add(normalizedEntity?.kind.orEmpty())
            add(normalizedEntity?.id.orEmpty())
        }.joinToString("|") { value -> "${value.length}:$value" }
    }

    companion object {
        fun from(
            userId: String,
            query: DashboardQuery,
            timezoneId: String,
            entity: DashboardEntity?
        ): DashboardCacheKey {
            val normalized = DashboardQueryContract.normalize(query)
            val normalizedEntity = entity?.let(DashboardQueryContract::normalizeEntity)
            DashboardQueryContract.canonical(normalized, timezoneId, normalizedEntity)
            return DashboardCacheKey(
                userId = userId,
                range = normalized.range,
                start = normalized.start,
                end = normalized.end,
                machine = normalized.machine,
                timezoneId = timezoneId,
                tool = normalized.tool,
                model = normalized.model,
                machines = normalized.machines,
                tools = normalized.tools,
                models = normalized.models,
                search = normalized.search,
                tokenMode = normalized.tokenMode,
                entity = normalizedEntity
            )
        }
    }
}

internal data class DashboardCachedSnapshot(
    val stats: StatsData,
    val savedAtEpochMillis: Long
)

internal data class DashboardCacheWriteMetadata(
    val writerId: String,
    val requestId: Long
)

internal fun shouldCommitCacheWrite(
    existing: DashboardCacheWriteMetadata?,
    incoming: DashboardCacheWriteMetadata
): Boolean = existing == null ||
    existing.writerId != incoming.writerId ||
    incoming.requestId > existing.requestId

internal interface DashboardSnapshotStore {
    suspend fun load(key: DashboardCacheKey): DashboardCachedSnapshot?

    suspend fun save(
        key: DashboardCacheKey,
        snapshot: DashboardCachedSnapshot,
        requestId: Long
    )

    suspend fun clearUser(userId: String)
}

/**
 * Encrypted last-known-good dashboard storage.
 *
 * Query identifiers are SHA-256 hashed before they become preference keys, and each payload is
 * protected with an Android Keystore AES-GCM key plus the hashed key as associated data. This
 * keeps user IDs, machine names, usage history, and cost data out of plaintext preferences.
 */
internal class DashboardCache internal constructor(
    private val prefs: SharedPreferences,
    private val testCipher: QuotaCacheCipher? = null
) : DashboardSnapshotStore {
    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    )
    // Every foreground/widget instance operates on the same preferences in this process.
    private val operationMutex get() = OPERATION_MUTEX

    override suspend fun load(key: DashboardCacheKey): DashboardCachedSnapshot? =
        withContext(Dispatchers.IO) {
            operationMutex.withLock {
                val preferenceKey = preferenceKey(key)
                val encrypted = prefs.getString(preferenceKey, null) ?: return@withLock null
                val snapshot = runCatching {
                    DashboardSnapshotJson.decode(decrypt(preferenceKey, encrypted), key)
                }.getOrNull()
                if (snapshot == null) {
                    prefs.edit().remove(preferenceKey).commit()
                }
                snapshot
            }
        }

    override suspend fun save(
        key: DashboardCacheKey,
        snapshot: DashboardCachedSnapshot,
        requestId: Long
    ) = saveForSession(key, snapshot, requestId, null)

    internal suspend fun saveForSession(
        key: DashboardCacheKey,
        snapshot: DashboardCachedSnapshot,
        requestId: Long,
        sessionGuard: SessionWriteGuard?
    ) {
        require(requestId > 0L) { "Dashboard cache requestId must be positive" }
        withContext(Dispatchers.IO) {
            operationMutex.withLock {
                val preferenceKey = preferenceKey(key)
                val incomingMetadata = DashboardCacheWriteMetadata(
                    writerId = DashboardRequestIdentity.writerId,
                    requestId = requestId
                )
                val existingMetadata = prefs.getString(preferenceKey, null)?.let { encrypted ->
                    runCatching {
                        DashboardSnapshotJson.writeMetadata(decrypt(preferenceKey, encrypted))
                    }.getOrNull()
                }
                if (!shouldCommitCacheWrite(existingMetadata, incomingMetadata)) {
                    return@withLock
                }
                val plaintext = DashboardSnapshotJson.encode(key, snapshot, incomingMetadata)
                val encrypted = encrypt(preferenceKey, plaintext)
                val commit = {
                    check(prefs.edit().putString(preferenceKey, encrypted).commit()) {
                        "用量缓存未可靠落盘"
                    }
                    pruneOldEntries()
                }
                if (sessionGuard == null) commit() else sessionGuard.commit(commit)
            }
        }
    }

    override suspend fun clearUser(userId: String) {
        withContext(Dispatchers.IO) {
            operationMutex.withLock {
                val editor = prefs.edit()
                prefs.all.forEach { (preferenceKey, value) ->
                    if (!preferenceKey.startsWith(ENTRY_PREFIX) || value !is String) return@forEach
                    val cachedUserId = runCatching {
                        DashboardSnapshotJson.userId(decrypt(preferenceKey, value))
                    }.getOrNull()
                    if (cachedUserId == null || cachedUserId == userId) {
                        editor.remove(preferenceKey)
                    }
                }
                editor.commit()
            }
        }
    }

    private fun preferenceKey(key: DashboardCacheKey): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(key.canonicalValue().toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        return ENTRY_PREFIX + digest
    }

    private fun encrypt(preferenceKey: String, plaintext: String): String {
        testCipher?.let { return it.encrypt(preferenceKey, plaintext) }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
        cipher.updateAAD(preferenceKey.toByteArray(Charsets.UTF_8))
        val payload = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + "." +
            Base64.encodeToString(payload, Base64.NO_WRAP)
    }

    private fun decrypt(preferenceKey: String, encrypted: String): String {
        testCipher?.let { return it.decrypt(preferenceKey, encrypted) }
        val parts = encrypted.split('.', limit = 2)
        require(parts.size == 2) { "Invalid dashboard cache envelope" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            getOrCreateSecretKey(),
            GCMParameterSpec(GCM_TAG_BITS, Base64.decode(parts[0], Base64.NO_WRAP))
        )
        cipher.updateAAD(preferenceKey.toByteArray(Charsets.UTF_8))
        return String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
    }

    private fun pruneOldEntries() {
        val entries = prefs.all.mapNotNull { (preferenceKey, value) ->
            if (!preferenceKey.startsWith(ENTRY_PREFIX) || value !is String) return@mapNotNull null
            val savedAt = runCatching {
                DashboardSnapshotJson.savedAt(decrypt(preferenceKey, value))
            }.getOrNull()
            preferenceKey to savedAt
        }
        if (entries.size <= MAX_ENTRIES) return

        val editor = prefs.edit()
        entries.sortedBy { it.second ?: Long.MIN_VALUE }
            .take(entries.size - MAX_ENTRIES)
            .forEach { (preferenceKey, _) -> editor.remove(preferenceKey) }
        editor.commit()
    }

    private fun getOrCreateSecretKey(): SecretKey = synchronized(KEY_LOCK) {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return@synchronized existing.secretKey

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build()
        generator.init(spec)
        generator.generateKey()
    }

    private companion object {
        const val PREFS_NAME = "tokenledger_dashboard_cache"
        const val ENTRY_PREFIX = "snapshot_"
        const val MAX_ENTRIES = 24
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "tokenledger_dashboard_cache_key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        val KEY_LOCK = Any()
        val OPERATION_MUTEX = Mutex()
    }
}

internal object DashboardSnapshotJson {
    fun encode(
        key: DashboardCacheKey,
        snapshot: DashboardCachedSnapshot,
        writeMetadata: DashboardCacheWriteMetadata
    ): String = JSONObject()
        .put("schemaVersion", CACHE_SCHEMA_VERSION)
        .put("writerId", writeMetadata.writerId)
        .put("requestId", writeMetadata.requestId)
        .put("userId", key.userId)
        .put("range", key.range.rpcValue)
        .putNullable("start", key.start)
        .putNullable("end", key.end)
        .put("machine", key.machine)
        .put("timezoneId", key.timezoneId)
        .putNullable("tool", key.tool)
        .putNullable("model", key.model)
        .put("machines", JSONArray(key.machines))
        .put("tools", JSONArray(key.tools))
        .put("models", JSONArray(key.models))
        .putNullable("search", key.search)
        .put("tokenMode", key.tokenMode)
        .put("entity", key.entity?.toJson() ?: JSONObject.NULL)
        .put("savedAtEpochMillis", snapshot.savedAtEpochMillis)
        .put("stats", statsToJson(snapshot.stats))
        .toString()

    /**
     * 唯一允许读取的旧 schema：T10.184 之前写入，cacheSavedUsd 全部是已知 0（见
     * CACHE_SCHEMA_VERSION 的注释）。比这更旧的 schema 仍然整体拒收（原 v2→v3 先例）。
     */
    private const val LEGACY_CACHE_SCHEMA_VERSION_UNKNOWN_GROSS = 3

    fun decode(raw: String, expectedKey: DashboardCacheKey): DashboardCachedSnapshot? {
        val root = JSONObject(raw)
        val schemaVersion = root.optInt("schemaVersion")
        if (schemaVersion != CACHE_SCHEMA_VERSION &&
            schemaVersion != LEGACY_CACHE_SCHEMA_VERSION_UNKNOWN_GROSS
        ) {
            return null
        }
        if (root.optString("userId") != expectedKey.userId) return null
        if (root.optString("range") != expectedKey.range.rpcValue) return null
        if (root.optNullableString("start") != expectedKey.start) return null
        if (root.optNullableString("end") != expectedKey.end) return null
        if (root.optString("machine") != expectedKey.machine) return null
        if (root.optString("timezoneId") != expectedKey.timezoneId) return null
        // tool/model are legacy single-value echoes. Canonical identity is carried by the plural
        // query dimensions plus entity below; compatibility selectors must not split one cache key.
        if (root.stringArray("machines") != expectedKey.machines) return null
        if (root.stringArray("tools") != expectedKey.tools) return null
        if (root.stringArray("models") != expectedKey.models) return null
        if (root.optNullableString("search") != expectedKey.search) return null
        if (root.optString("tokenMode") != expectedKey.tokenMode) return null
        val storedEntity = if (!root.has("entity") || root.isNull("entity")) {
            null
        } else {
            val entityObject = root.optJSONObject("entity") ?: return null
            runCatching {
                DashboardQueryContract.normalizeEntity(
                    DashboardEntity(
                        kind = entityObject.optString("kind"),
                        id = entityObject.optString("id")
                    )
                )
            }.getOrNull() ?: return null
        }
        if (storedEntity != expectedKey.entity) return null
        val savedAt = root.longValue("savedAtEpochMillis")
        if (savedAt <= 0) return null
        val statsJson = root.optJSONObject("stats") ?: return null
        var stats = StatsJson.parse(statsJson.toString()).copy(
            legacyRpc = statsJson.optBoolean("legacyRpc", false)
        )
        if (schemaVersion == LEGACY_CACHE_SCHEMA_VERSION_UNKNOWN_GROSS) {
            stats = stats.withUnknownLegacyGrossCacheSavings()
        }
        return DashboardCachedSnapshot(stats = stats, savedAtEpochMillis = savedAt)
    }

    /**
     * schema 3 缓存的 cacheSavedUsd 一律强制视为不可得（root R-36 P3-1）：把每个
     * summary 位置的毛值清空，其余字段原样保留；cacheSavings 对象在 schema 3 里
     * 从未出现过，不受影响。
     */
    private fun StatsData.withUnknownLegacyGrossCacheSavings(): StatsData {
        fun Summary.unknownGross(): Summary = if (cacheSavedUsd == null) this else copy(cacheSavedUsd = null)
        fun UsageComparison.unknownGross(): UsageComparison = copy(
            current = current.copy(summary = current.summary.unknownGross()),
            previous = previous.copy(summary = previous.summary.unknownGross())
        )
        fun UsageDetailsPage.unknownGross(): UsageDetailsPage = copy(filteredSummary = filteredSummary.unknownGross())
        fun EntityDashboard.unknownGross(): EntityDashboard = copy(
            summary = summary.unknownGross(),
            comparison = comparison?.unknownGross(),
            historyPage = historyPage.unknownGross()
        )
        return copy(
            summary = summary.unknownGross(),
            comparison = comparison?.unknownGross(),
            detailsPage = detailsPage?.unknownGross(),
            entityDashboard = entityDashboard?.unknownGross()
        )
    }

    fun userId(raw: String): String? = JSONObject(raw)
        .optString("userId")
        .takeIf(String::isNotBlank)

    fun savedAt(raw: String): Long? = JSONObject(raw)
        .longValue("savedAtEpochMillis")
        .takeIf { it > 0 }

    fun writeMetadata(raw: String): DashboardCacheWriteMetadata? {
        val root = JSONObject(raw)
        val writerId = root.optString("writerId").takeIf(String::isNotBlank) ?: return null
        val requestId = root.longValue("requestId").takeIf { it > 0 } ?: return null
        return DashboardCacheWriteMetadata(writerId = writerId, requestId = requestId)
    }

    private fun statsToJson(stats: StatsData): JSONObject = JSONObject()
        .put("summary", summaryToJson(stats.summary))
        .put("tools", JSONObject().apply {
            stats.tools.forEach { (key, value) -> put(key, toolToJson(value)) }
        })
        .put("models", JSONObject().apply {
            stats.models.forEach { (key, value) -> put(key, modelToJson(value)) }
        })
        .put("trends", JSONArray().apply {
            stats.trends.forEach { point -> put(trendToJson(point)) }
        })
        .put("heatmap", longMapToJson(stats.heatmap))
        .put("history", JSONArray().apply {
            stats.history.forEach { item -> put(historyToJson(item)) }
        })
        .put("machines", JSONArray().apply {
            stats.machines.forEach { machine -> put(machine) }
        })
        .put(
            "machineDistribution",
            stats.machineDistribution?.let(StatsJson::compositionToJson) ?: JSONObject.NULL
        )
        .put("dailyCosts", stats.dailyCosts?.let(StatsJson::dailyCostsToJson) ?: JSONObject.NULL)
        .put("meta", stats.meta?.let(::metaToJson) ?: JSONObject.NULL)
        .put("legacyRpc", stats.legacyRpc)
        .put("comparison", stats.comparison?.let(StatsJson::comparisonToJson) ?: JSONObject.NULL)
        .put("detailsPage", stats.detailsPage?.let(StatsJson::detailsPageToJson) ?: JSONObject.NULL)
        .put(
            "entityDashboard",
            stats.entityDashboard?.let(StatsJson::entityDashboardToJson) ?: JSONObject.NULL
        )
        .put("capabilities", StatsJson.capabilitiesToJson(stats.capabilities))

    private fun summaryToJson(summary: Summary): JSONObject = JSONObject()
        .put("totalTokens", summary.totalTokens)
        .put("inputTokens", summary.inputTokens)
        .put("outputTokens", summary.outputTokens)
        .put("cachedTokens", summary.cachedTokens)
        .put("totalCost", summary.totalCost)
        .put("totalRequests", summary.totalRequests)
        .put("avgTokensPerReq", summary.avgTokensPerReq)
        .apply {
            // 未知一律不写键，而不是写 JSON null 或 0（修 D2：GLB-01 不可得不得存成 0）。
            summary.cacheSavedUsd?.let { put("cacheSavedUsd", it) }
            if (summary.cacheSplitKnown) {
                put("cacheReadTokens", summary.cacheReadTokens)
                put("cacheWriteTokens", summary.cacheWriteTokens)
                // 与解析侧对称：只有拆分成立时才可能写出 cacheSavings。
                summary.cacheSavings?.let { put("cacheSavings", StatsJson.cacheSavingsToJson(it)) }
            }
        }

    private fun toolToJson(tool: ToolStat): JSONObject = JSONObject()
        .put("name", tool.name)
        .put("input", tool.input)
        .put("output", tool.output)
        .put("cached", tool.cached)
        .put("total", tool.total)
        .put("cost", tool.cost)
        .put("requests", tool.requests)
        .put("models", longMapToJson(tool.models))
        .put("heatmap", longMapToJson(tool.heatmap))
        .apply {
            tool.cacheRead?.let { put("cacheRead", it) }
            tool.cacheWrite?.let { put("cacheWrite", it) }
        }

    private fun modelToJson(model: ModelStat): JSONObject = JSONObject()
        .put("name", model.name)
        .put("total", model.total)
        .put("requests", model.requests)
        .put("input", model.input)
        .put("output", model.output)
        .put("cached", model.cached)
        .put("heatmap", longMapToJson(model.heatmap))
        .apply {
            model.cost?.let { put("cost", it) }
            model.cacheRead?.let { put("cacheRead", it) }
            model.cacheWrite?.let { put("cacheWrite", it) }
        }

    private fun trendToJson(point: TrendPoint): JSONObject = JSONObject()
        .put("date", point.date)
        .apply {
            point.values.forEach { (key, value) -> put(key, value) }
            put("__requests", point.requests)
        }

    private fun historyToJson(item: LogHistoryItem): JSONObject = JSONObject()
        .put("id", item.id)
        .put("tool", item.tool)
        .put("model", item.model)
        .put("inputTokens", item.inputTokens)
        .put("outputTokens", item.outputTokens)
        .put("cachedTokens", item.cachedTokens)
        .put("cacheWriteTokens", item.cacheWriteTokens)
        .put("cost", item.cost)
        .put("timestamp", item.timestamp)
        .put("sessionId", item.sessionId)
        .put("machineId", item.machineId)
        .put("requests", item.requests)

    private fun metaToJson(meta: StatsMeta): JSONObject = JSONObject()
        .putNullable("generatedAt", meta.generatedAt)
        .putNullable("lastRefreshedAt", meta.lastRefreshedAt)
        .putNullable("timezone", meta.timezone)
        .putNullable("range", meta.range)
        .putNullable("machine", meta.machine)
        .put("stale", meta.stale)
        .put("contractVersion", meta.contractVersion)
        .put("query", meta.query?.let { query ->
            JSONObject()
                .putNullable("range", query.range)
                .putNullable("timezone", query.timezone)
                .put("machines", JSONArray(query.machines))
                .put("tools", JSONArray(query.tools))
                .put("models", JSONArray(query.models))
                .putNullable("search", query.search)
                .putNullable("tokenMode", query.tokenMode)
                .putNullable("start", query.start)
                .putNullable("end", query.end)
                .putCompatibilityEcho("machine", query.machines)
                .putCompatibilityEcho("tool", query.tools)
                .putCompatibilityEcho("model", query.models)
        } ?: JSONObject.NULL)
        .put("entity", meta.entity?.toJson() ?: JSONObject.NULL)

    private fun longMapToJson(values: Map<String, Long>): JSONObject = JSONObject().apply {
        values.forEach { (key, value) -> put(key, value) }
    }

    private fun JSONObject.putNullable(key: String, value: String?): JSONObject =
        put(key, value ?: JSONObject.NULL)

    private fun JSONObject.putCompatibilityEcho(
        key: String,
        values: List<String>
    ): JSONObject = apply {
        if (values.size <= 1) putNullable(key, values.singleOrNull())
    }
}

private fun JSONObject.stringArray(key: String): List<String>? {
    val array = optJSONArray(key) ?: return null
    return buildList {
        for (index in 0 until array.length()) {
            val value = array.opt(index)
            if (value !is String) return null
            add(value)
        }
    }
}

/**
 * schema 4（root R-36 P3-1）：写入端不再有任何路径会把「毛值不可得」存成 0.0——
 * cacheSavedUsd 现在本来就是 Double?，缺失就是 null。schema 3（T10.184 之前写入）
 * 里的 cacheSavedUsd 全部是旧 doubleValue（缺失即 0.0）留下的已知 0，不是验证过的
 * 净节省；schema 3 仍然可读、不失效，只是 DashboardSnapshotJson.decode 读出时把
 * 每个 summary 位置的 cacheSavedUsd 强制视为不可得（见该函数与
 * LEGACY_CACHE_SCHEMA_VERSION_UNKNOWN_GROSS）。
 */
internal const val CACHE_SCHEMA_VERSION = 4
