package com.jeidorf.tokenledger.mobile

import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import org.json.JSONArray
import org.json.JSONObject

internal const val QUOTA_TRANSPORT_VERSION = 2

/** Read-only transport that may carry `unit='currency'`; cache keys and epochs stay on v2. */
internal const val QUOTA_CURRENCY_TRANSPORT_VERSION = 3

internal fun quotaSnapshotFitsCacheKey(keyVersion: Int, snapshotVersion: Int): Boolean =
    keyVersion == QUOTA_TRANSPORT_VERSION &&
        (snapshotVersion == QUOTA_TRANSPORT_VERSION || snapshotVersion == QUOTA_CURRENCY_TRANSPORT_VERSION)

private const val MAX_PROVIDERS = 8
private const val MAX_WINDOWS_PER_PROVIDER = 16
private const val MAX_PROVIDER_JSON_BYTES = 65_536
internal const val QUOTA_TRANSPORT_MAX_BYTES = 128 * 1_024
private const val MAX_STRING_BYTES = 512
private const val MAX_STABLE_ID_BYTES = 128
private const val MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991L

private val GENERIC_QUOTA_WINDOW_LABELS = setOf(
    "primary", "primary window", "secondary", "secondary window", "tertiary", "tertiary window",
    "5-hour", "5-hour window", "5 hour", "5 hour window",
    "7-day", "7-day window", "7 day", "7 day window", "weekly", "weekly window",
    "credits", "credits balance", "included credits",
    "5 小时窗口", "7 天窗口", "周窗口", "主要窗口", "次要窗口", "附加窗口"
)

/**
 * 「<时长>窗口」这类原始标签是构造出来的，不该逐个列举。
 *
 * 上面那张表漏了「30 天窗口」，于是 30 天那档在额度页显示成
 * **「30 天窗口 · 30 天额度」**——同一件事说两遍，而兄弟行是「5 小时额度」「每周额度」。
 * 补一条进表里只能挡住 30，下一个 90 天、14 天照样漏；这是模式，不是枚举。
 */
private val DURATION_WINDOW_LABEL = Regex(
    """^\d+\s*(?:分钟|小时|天|周|个?月)窗口$|^\d+\s*[-\s]?(?:minute|hour|day|week|month)s?\s+window$"""
)

private fun String.isGenericQuotaWindowLabel(): Boolean =
    this in GENERIC_QUOTA_WINDOW_LABELS || DURATION_WINDOW_LABEL.matches(this)

enum class QuotaScope(val wireValue: String) {
    ConsumerSubscription("consumer-subscription"),
    ApiOrganization("api-organization"),
    ManualBudget("manual-budget");

    companion object {
        fun parse(value: String): QuotaScope = entries.firstOrNull { it.wireValue == value }
            ?: throw QuotaContractException("quota_scope_invalid")
    }
}

enum class QuotaSource(val wireValue: String) {
    OfficialApi("official-api"),
    LocalAuthorized("local-authorized"),
    Manual("manual");

    companion object {
        fun parse(value: String): QuotaSource = entries.firstOrNull { it.wireValue == value }
            ?: throw QuotaContractException("quota_source_invalid")
    }
}

enum class QuotaMode(val wireValue: String) {
    Automatic("automatic"),
    Manual("manual"),
    Unsupported("unsupported");

    companion object {
        fun parse(value: String): QuotaMode = entries.firstOrNull { it.wireValue == value }
            ?: throw QuotaContractException("quota_mode_invalid")
    }
}

enum class QuotaCapability(val wireValue: String) {
    Stable("stable"),
    PlanDependent("plan-dependent"),
    Experimental("experimental"),
    Manual("manual"),
    Unsupported("unsupported");

    companion object {
        fun parse(value: String): QuotaCapability = entries.firstOrNull { it.wireValue == value }
            ?: throw QuotaContractException("quota_capability_invalid")
    }
}

enum class QuotaProviderStatus(val wireValue: String) {
    Ok("ok"),
    Stale("stale"),
    Unsupported("unsupported"),
    AuthRequired("auth-required"),
    Error("error");

    companion object {
        fun parse(value: String): QuotaProviderStatus = entries.firstOrNull {
            it.wireValue == value
        } ?: throw QuotaContractException("quota_provider_status_invalid")
    }
}

enum class QuotaWindowStatus(val wireValue: String) {
    Ok("ok"),
    Stale("stale"),
    AuthRequired("auth-required"),
    Error("error");

    companion object {
        fun parse(value: String): QuotaWindowStatus = entries.firstOrNull {
            it.wireValue == value
        } ?: throw QuotaContractException("quota_window_status_invalid")
    }
}

enum class QuotaUnit(val wireValue: String) {
    Percent("percent"),
    Requests("requests"),
    Tokens("tokens"),
    Usd("usd"),
    Credits("credits"),
    Currency("currency");

    companion object {
        fun parse(value: String): QuotaUnit = entries.firstOrNull { it.wireValue == value }
            ?: throw QuotaContractException("quota_unit_invalid")

        fun isKnown(value: String): Boolean = entries.any { it.wireValue == value }
    }
}

private val ISO_4217_ALPHA = Regex("^[A-Z]{3}$")

data class QuotaWindowSnapshot(
    val providerId: String,
    val windowId: String,
    val windowLabel: String,
    val scope: QuotaScope,
    val source: QuotaSource,
    val status: QuotaWindowStatus,
    val used: Double?,
    val limit: Double?,
    val remaining: Double?,
    val unit: QuotaUnit,
    val windowMinutes: Int?,
    val resetsAt: String?,
    val observedAt: String,
    val fetchedAt: String,
    val staleAfterSeconds: Int,
    val reasonCode: String?,
    /** ISO 4217 alphabetic code; present exactly when [unit] is [QuotaUnit.Currency]. */
    val currency: String? = null
) {
    val stableKey: String
        get() = "${providerId}:${scope.wireValue}:$windowId"

    val observedInstant: Instant
        get() = QuotaSnapshotJson.parseTimestamp(observedAt)

    val resetInstant: Instant?
        get() = resetsAt?.let(QuotaSnapshotJson::parseTimestamp)
}

data class QuotaProviderEnvelope(
    val schemaVersion: Int,
    val providerId: String,
    val displayName: String,
    val scope: QuotaScope,
    val mode: QuotaMode,
    val capability: QuotaCapability,
    val status: QuotaProviderStatus,
    val windows: List<QuotaWindowSnapshot>,
    val reasonCode: String?
) {
    val stableKey: String
        get() = "${providerId}:${scope.wireValue}"
}

data class QuotaProviderState(
    val providerId: String,
    val scope: QuotaScope,
    val generation: Long,
    val deleted: Boolean,
    val sourceObservedAt: String?,
    val receivedAt: String
) {
    val stableKey: String
        get() = "${providerId}:${scope.wireValue}"
}

/** 已知来源 ID 的规范名（同一工具的不同采集方式归到一个名字）；未知 ID 返回 null。 */
internal fun quotaProviderCanonicalName(providerId: String): String? = when (providerId) {
    "openai-codex-local", "codex-app-server" -> "Codex"
    "anthropic-claude-consumer", "claude-code" -> "Claude"
    "google-antigravity-consumer" -> "Antigravity"
    else -> null
}

internal fun QuotaProviderEnvelope.localizedDisplayName(): String {
    if (scope == QuotaScope.ManualBudget || providerId == "manual-budget") return "手动预算"
    val canonicalName = quotaProviderCanonicalName(providerId) ?: return displayName
    val raw = displayName.trim()
    val normalized = raw.lowercase(Locale.ROOT).replace(Regex("\\s+"), " ")
    val technicalNames = when (canonicalName) {
        "Codex" -> setOf("codex", "codex account usage", "codex local usage")
        "Claude" -> setOf("claude", "claude consumer usage", "claude code")
        else -> setOf("antigravity", "antigravity consumer usage")
    }
    if (normalized in technicalNames) return "$canonicalName 订阅额度"

    // 只移除确实等于当前 Provider 的技术前缀。其后的团队、账号或套餐名是用户用来
    // 区分多个授权来源的有效信息，不能像旧实现那样一律覆盖成通用产品名。
    val afterCanonicalName = raw
        .takeIf { it.startsWith(canonicalName, ignoreCase = true) }
        ?.drop(canonicalName.length)
    val suffix = afterCanonicalName
        ?.takeIf { remainder ->
            remainder.isEmpty() ||
                remainder.first().isWhitespace() ||
                remainder.first() in setOf('·', ':', '-', '—')
        }
        ?.trimStart(' ', '·', ':', '-', '—')
        ?.takeIf(String::isNotBlank)
    return when {
        suffix == null -> raw
        suffix.lowercase(Locale.ROOT) in setOf("account usage", "local usage", "consumer usage") ->
            "$canonicalName 订阅额度"
        else -> "$canonicalName · $suffix"
    }
}

internal fun QuotaProviderStatus.localizedLabel(): String = when (this) {
    QuotaProviderStatus.Ok -> "来源已同步"
    QuotaProviderStatus.Stale -> "历史数据"
    QuotaProviderStatus.Unsupported -> "当前不支持"
    QuotaProviderStatus.AuthRequired -> "需要授权"
    QuotaProviderStatus.Error -> "暂时不可用"
}

internal fun QuotaWindowStatus.localizedLabel(): String = when (this) {
    QuotaWindowStatus.Ok -> "数据新鲜"
    QuotaWindowStatus.Stale -> "历史数据"
    QuotaWindowStatus.AuthRequired -> "需要授权"
    QuotaWindowStatus.Error -> "暂时不可用"
}

internal fun QuotaWindowSnapshot.localizedWindowLabel(providerName: String? = null): String {
    val kind = stableWindowKind()
    val semanticLabel = when {
        isCreditsWindow() -> "额外用量余额"
        windowMinutes != null -> localizedQuotaDuration(windowMinutes)
        kind == "five-hour" -> "5 小时额度"
        kind == "seven-day" || kind == "weekly" -> "每周额度"
        kind == "primary" -> "主要额度窗口"
        kind == "secondary" -> "次要额度窗口"
        kind == "tertiary" -> "附加额度窗口"
        else -> return windowLabel
    }
    val rawPrefix = windowLabel.substringBeforeLast('·', missingDelimiterValue = "")
        .trim()
        .takeIf(String::isNotEmpty)
    if (rawPrefix != null) {
        val meaningfulPrefix = rawPrefix.meaningfulWindowPrefix(providerName, providerId)
        return meaningfulPrefix?.let { "$it · $semanticLabel" } ?: semanticLabel
    }
    val normalizedRawLabel = windowLabel.trim().lowercase(Locale.ROOT).replace(Regex("\\s+"), " ")
    return if (normalizedRawLabel == semanticLabel.lowercase(Locale.ROOT) || normalizedRawLabel.isGenericQuotaWindowLabel()) {
        semanticLabel
    } else {
        "${windowLabel.trim()} · $semanticLabel"
    }
}

internal fun QuotaWindowSnapshot.localizedCompactWindowLabel(providerName: String? = null): String {
    val kind = stableWindowKind()
    val semanticLabel = when {
        isCreditsWindow() -> "额度余额"
        windowMinutes == 7 * 24 * 60 -> "每周"
        windowMinutes != null -> localizedQuotaDuration(windowMinutes).removeSuffix("额度").trim()
        kind == "five-hour" -> "5 小时"
        kind == "seven-day" || kind == "weekly" -> "每周"
        kind == "primary" -> "主要额度"
        kind == "secondary" -> "次要额度"
        kind == "tertiary" -> "附加额度"
        else -> localizedWindowLabel(providerName).take(20)
    }
    val prefix = windowLabel.substringBeforeLast('·', missingDelimiterValue = "")
        .trim()
        .takeIf(String::isNotEmpty)
        ?.meaningfulWindowPrefix(providerName, providerId)
    return if (prefix != null) {
        "$prefix · $semanticLabel"
    } else {
        semanticLabel
    }
}

private fun String.meaningfulWindowPrefix(providerName: String?, providerId: String): String? {
    val parts = split('·').map(String::trim).filter(String::isNotEmpty).toMutableList()
    if (parts.firstOrNull()?.isCurrentProviderPrefix(providerName, providerId) == true) {
        parts.removeAt(0)
    }
    val candidate = parts.joinToString(" · ").trim()
    if (candidate.isEmpty()) return null
    val normalized = candidate.lowercase(Locale.ROOT).replace(Regex("\\s+"), " ")
    return candidate.takeUnless { normalized.isGenericQuotaWindowLabel() }
}

private fun String.isCurrentProviderPrefix(providerName: String?, providerId: String): Boolean {
    fun normalized(value: String): String = value
        .trim()
        .lowercase(Locale.ROOT)
        .removeSuffix("订阅额度")
        .removeSuffix("额度")
        .trim()
    val canonical = when (providerId) {
        "openai-codex-local", "codex-app-server" -> "codex"
        "anthropic-claude-consumer", "claude-code" -> "claude"
        "google-antigravity-consumer" -> "antigravity"
        else -> null
    }
    val currentNames = buildSet {
        canonical?.let(::add)
        providerName?.let { add(normalized(it).substringBefore('·').trim()) }
    }
    return normalized(this) in currentNames
}

private fun QuotaWindowSnapshot.isCreditsWindow(): Boolean {
    val kind = stableWindowKind()
    return unit == QuotaUnit.Credits || reasonCode == "credits_unlimited" || kind.contains("credits")
}

private fun QuotaWindowSnapshot.stableWindowKind(): String = windowId
    .substringAfterLast(':')
    .removePrefix("codexbar-")
    .lowercase(Locale.ROOT)

private fun localizedQuotaDuration(minutes: Int): String = when {
    minutes == 7 * 24 * 60 -> "每周额度"
    minutes == 24 * 60 -> "每日额度"
    minutes % (24 * 60) == 0 -> "${minutes / (24 * 60)} 天额度"
    minutes % 60 == 0 -> "${minutes / 60} 小时额度"
    else -> "$minutes 分钟额度"
}

data class QuotaTransportSnapshot(
    val transportVersion: Int,
    val epoch: Long,
    val revision: Long,
    val generatedAt: String,
    val providers: List<QuotaProviderEnvelope>,
    val providerStates: List<QuotaProviderState> = providers.map { provider ->
        QuotaProviderState(
            providerId = provider.providerId,
            scope = provider.scope,
            generation = 0L,
            deleted = false,
            sourceObservedAt = provider.windows
                .maxOfOrNull { QuotaSnapshotJson.parseTimestamp(it.observedAt) }
                ?.toString(),
            receivedAt = generatedAt
        )
    }
) {
    val generatedInstant: Instant
        get() = QuotaSnapshotJson.parseTimestamp(generatedAt)
}

internal enum class QuotaParseMode {
    OrdinaryReader,
    SyncedTransport
}

internal class QuotaContractException(
    val reasonCode: String,
    cause: Throwable? = null
) : IllegalArgumentException("Invalid quota snapshot: $reasonCode", cause)

internal sealed interface QuotaDisplayValue {
    data class Progress(
        val used: Double,
        val limit: Double,
        val remaining: Double?,
        val unit: QuotaUnit,
        val fraction: Float,
        val currency: String? = null
    ) : QuotaDisplayValue

    data class Absolute(
        val used: Double?,
        val limit: Double?,
        val remaining: Double?,
        val unit: QuotaUnit,
        val currency: String? = null
    ) : QuotaDisplayValue

    data object UnlimitedCredits : QuotaDisplayValue
}

internal fun QuotaWindowSnapshot.displayValue(): QuotaDisplayValue? {
    if (status != QuotaWindowStatus.Ok && status != QuotaWindowStatus.Stale) return null
    if (reasonCode == "credits_unlimited") return QuotaDisplayValue.UnlimitedCredits
    if (unit == QuotaUnit.Credits) {
        return QuotaDisplayValue.Absolute(used, limit, remaining, unit)
    }
    if (unit == QuotaUnit.Percent && used != null) {
        val percentLimit = 100.0
        return QuotaDisplayValue.Progress(
            used = used,
            limit = percentLimit,
            remaining = remaining ?: percentLimit - used,
            unit = unit,
            fraction = (used / percentLimit).coerceIn(0.0, 1.0).toFloat()
        )
    }
    if (used != null && limit != null && limit > 0.0) {
        return QuotaDisplayValue.Progress(
            used = used,
            limit = limit,
            remaining = remaining,
            unit = unit,
            fraction = (used / limit).coerceIn(0.0, 1.0).toFloat(),
            currency = currency
        )
    }
    return QuotaDisplayValue.Absolute(used, limit, remaining, unit, currency)
}

internal fun QuotaWindowSnapshot.effectiveStatus(
    now: Instant,
    forceStale: Boolean = false
): QuotaWindowStatus {
    if (status != QuotaWindowStatus.Ok) return status
    val staleAt = runCatching { observedInstant.plusSeconds(staleAfterSeconds.toLong()) }
        .getOrElse { return QuotaWindowStatus.Error }
    val resetPassed = resetInstant?.let { !now.isBefore(it) } == true
    return if (forceStale || !now.isBefore(staleAt) || resetPassed) {
        QuotaWindowStatus.Stale
    } else {
        QuotaWindowStatus.Ok
    }
}

/**
 * Provider 与窗口状态的唯一展示裁决。Provider 的显式错误/授权态优先；Provider 自身为
 * ok 时再使用窗口的时效状态，确保完整额度页、应用内卡片与桌面小组件不会各画一套颜色。
 */
internal fun QuotaProviderEnvelope.effectiveStatus(
    now: Instant,
    forceStale: Boolean = false
): QuotaProviderStatus {
    if (status != QuotaProviderStatus.Ok) return status
    val windowStatuses = windows.map { it.effectiveStatus(now, forceStale) }
    return when {
        QuotaWindowStatus.Error in windowStatuses -> QuotaProviderStatus.Error
        QuotaWindowStatus.AuthRequired in windowStatuses -> QuotaProviderStatus.AuthRequired
        QuotaWindowStatus.Stale in windowStatuses -> QuotaProviderStatus.Stale
        else -> QuotaProviderStatus.Ok
    }
}

internal fun QuotaTransportSnapshot.nextFreshnessDeadline(
    now: Instant
): Instant? = buildList {
    providers.asSequence()
        .flatMap { it.windows.asSequence() }
        .filter { it.status == QuotaWindowStatus.Ok }
        .forEach { window ->
            runCatching { window.observedInstant.plusSeconds(window.staleAfterSeconds.toLong()) }
                .getOrNull()
                ?.takeIf { it.isAfter(now) }
                ?.let(::add)
            window.resetInstant?.takeIf { it.isAfter(now) }?.let(::add)
        }
}.minOrNull()

internal object QuotaSnapshotJson {
    private val providerFields = setOf(
        "schemaVersion", "providerId", "displayName", "scope", "mode", "capability",
        "status", "windows", "reasonCode"
    )
    private val windowFields = setOf(
        "providerId", "windowId", "windowLabel", "scope", "source", "status", "used",
        "limit", "remaining", "unit", "windowMinutes", "resetsAt", "observedAt",
        "fetchedAt", "staleAfterSeconds", "reasonCode", "currency"
    )
    private val transportFields = setOf(
        "status", "transportVersion", "epoch", "revision", "generatedAt", "providers",
        "providerStates"
    )
    private val providerStateFields = setOf(
        "providerId", "scope", "generation", "deleted", "sourceObservedAt", "receivedAt"
    )

    fun parseTransport(raw: String): QuotaTransportSnapshot {
        if (raw.toByteArray(Charsets.UTF_8).size > QUOTA_TRANSPORT_MAX_BYTES) {
            throw QuotaContractException("transport_payload_too_large")
        }
        val root = try {
            JSONObject(raw)
        } catch (error: Throwable) {
            throw QuotaContractException("transport_json_invalid", error)
        }
        requireExactFields(root, transportFields, "transport_unknown_field")
        if (requiredString(root, "status") != "ok") {
            throw QuotaContractException("transport_status_invalid")
        }
        val version = requiredInteger(
            root,
            "transportVersion",
            QUOTA_TRANSPORT_VERSION.toLong(),
            QUOTA_CURRENCY_TRANSPORT_VERSION.toLong()
        ).toInt()
        val currencyTransport = version == QUOTA_CURRENCY_TRANSPORT_VERSION
        val epoch = requiredInteger(root, "epoch", 0L, MAX_SAFE_JSON_INTEGER)
        val revision = requiredInteger(root, "revision", 0L, MAX_SAFE_JSON_INTEGER)
        val generatedAt = requiredString(root, "generatedAt").also(::parseTimestamp)
        val providersArray = root.optJSONArray("providers")
            ?: throw QuotaContractException("transport_providers_missing")
        if (providersArray.toString().toByteArray(Charsets.UTF_8).size > MAX_PROVIDER_JSON_BYTES) {
            throw QuotaContractException("transport_payload_too_large")
        }
        val providers = parseProviderArray(providersArray, QuotaParseMode.SyncedTransport)
        if (!currencyTransport && providers.any { provider ->
                provider.windows.any { it.unit == QuotaUnit.Currency }
            }
        ) {
            throw QuotaContractException("transport_v2_currency_rejected")
        }
        val statesArray = root.optJSONArray("providerStates")
            ?: throw QuotaContractException("transport_provider_states_missing")
        val states = parseProviderStates(statesArray)
        // v3 readers may drop envelopes or windows carrying units unknown to this build, so a
        // state can outlive its envelope and a pruned envelope may observe earlier than its state.
        val activeStates = states.count { !it.deleted }
        if (if (currencyTransport) activeStates < providers.size else activeStates != providers.size) {
            throw QuotaContractException("transport_provider_state_mismatch")
        }
        val statesByKey = states.associateBy(QuotaProviderState::stableKey)
        providers.forEach { provider ->
            val state = statesByKey[provider.stableKey]
                ?: throw QuotaContractException("transport_provider_state_missing")
            val sourceObservedAt = provider.windows.maxOfOrNull {
                parseTimestamp(it.observedAt)
            }
            val stateObservedAt = state.sourceObservedAt?.let(::parseTimestamp)
            val observedMatches = when {
                sourceObservedAt == null || stateObservedAt == null -> false
                currencyTransport -> !sourceObservedAt.isAfter(stateObservedAt)
                else -> stateObservedAt == sourceObservedAt
            }
            if (state.deleted || !observedMatches) {
                throw QuotaContractException("transport_provider_state_mismatch")
            }
        }
        return QuotaTransportSnapshot(version, epoch, revision, generatedAt, providers, states)
    }

    fun parseFixtureProviders(raw: String, mode: QuotaParseMode): List<QuotaProviderEnvelope> {
        val root = try {
            JSONObject(raw)
        } catch (error: Throwable) {
            throw QuotaContractException("fixture_json_invalid", error)
        }
        val providers = root.optJSONArray("providers")
            ?: throw QuotaContractException("fixture_providers_missing")
        return parseProviderArray(providers, mode)
    }

    fun parseProvider(value: JSONObject, mode: QuotaParseMode): QuotaProviderEnvelope =
        parseProviderObject(value, mode)

    fun encodeTransport(snapshot: QuotaTransportSnapshot): String = JSONObject()
        .put("status", "ok")
        .put("transportVersion", snapshot.transportVersion)
        .put("epoch", snapshot.epoch)
        .put("revision", snapshot.revision)
        .put("generatedAt", snapshot.generatedAt)
        .put("providers", JSONArray().apply {
            snapshot.providers.forEach { put(providerToJson(it)) }
        })
        .put("providerStates", JSONArray().apply {
            snapshot.providerStates.forEach { state ->
                put(JSONObject()
                    .put("providerId", state.providerId)
                    .put("scope", state.scope.wireValue)
                    .put("generation", state.generation)
                    .put("deleted", state.deleted)
                    .putOptional("sourceObservedAt", state.sourceObservedAt)
                    .put("receivedAt", state.receivedAt))
            }
        })
        .toString()
        .also { raw ->
            if (raw.toByteArray(Charsets.UTF_8).size > QUOTA_TRANSPORT_MAX_BYTES) {
                throw QuotaContractException("transport_payload_too_large")
            }
        }

    private fun parseProviderStates(values: JSONArray): List<QuotaProviderState> {
        var activeStates = 0
        val keys = mutableSetOf<String>()
        return buildList {
            for (index in 0 until values.length()) {
                val raw = values.optJSONObject(index)
                    ?: throw QuotaContractException("provider_state_not_object")
                requireExactFields(raw, providerStateFields, "provider_state_unknown_field")
                val providerId = requiredStableId(raw, "providerId")
                val scope = QuotaScope.parse(requiredString(raw, "scope"))
                val generation = requiredInteger(
                    raw, "generation", 0L, MAX_SAFE_JSON_INTEGER
                )
                val deletedValue = raw.opt("deleted")
                if (deletedValue !is Boolean) {
                    throw QuotaContractException("provider_state_deleted_invalid")
                }
                val observedAt = optionalString(raw, "sourceObservedAt")?.also(::parseTimestamp)
                val receivedAt = requiredString(raw, "receivedAt").also(::parseTimestamp)
                if (deletedValue == (observedAt != null)) {
                    throw QuotaContractException("provider_state_shape_invalid")
                }
                val state = QuotaProviderState(
                    providerId, scope, generation, deletedValue, observedAt, receivedAt
                )
                if (!keys.add(state.stableKey)) {
                    throw QuotaContractException("provider_state_stable_key_duplicate")
                }
                // Keep every tombstone: only non-deleted states consume the active capacity.
                if (!state.deleted && ++activeStates > MAX_PROVIDERS) {
                    throw QuotaContractException("provider_state_limit_exceeded")
                }
                add(state)
            }
        }.sortedBy(QuotaProviderState::stableKey)
    }

    fun parseTimestamp(value: String): Instant {
        requireStringBudget(value, "timestamp_too_long")
        return try {
            OffsetDateTime.parse(value, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant()
        } catch (error: Throwable) {
            throw QuotaContractException("timestamp_invalid", error)
        }
    }

    private fun parseProviderArray(
        providers: JSONArray,
        mode: QuotaParseMode
    ): List<QuotaProviderEnvelope> {
        if (providers.length() > MAX_PROVIDERS) {
            throw QuotaContractException("provider_limit_exceeded")
        }
        val stableKeys = mutableSetOf<Pair<String, QuotaScope>>()
        return buildList {
            for (index in 0 until providers.length()) {
                val raw = providers.optJSONObject(index)
                    ?: throw QuotaContractException("provider_not_object")
                val pruned = pruneUnknownUnitWindows(raw) ?: continue
                val provider = parseProviderObject(pruned, mode)
                if (!stableKeys.add(provider.providerId to provider.scope)) {
                    throw QuotaContractException("provider_stable_key_duplicate")
                }
                add(provider)
            }
        }.sortedBy(QuotaProviderEnvelope::stableKey)
    }

    /**
     * Newer writers may add units this build does not know. Such windows are dropped one by one;
     * the envelope survives only while a known window still backs its status (ok -> stale when
     * only stale windows remain). Returns null when the whole envelope must be dropped.
     */
    private fun pruneUnknownUnitWindows(raw: JSONObject): JSONObject? {
        val windows = raw.optJSONArray("windows") ?: return raw
        val kept = JSONArray()
        for (index in 0 until windows.length()) {
            val window = windows.opt(index)
            val unit = (window as? JSONObject)?.opt("unit")
            if (unit is String && !QuotaUnit.isKnown(unit)) continue
            kept.put(window)
        }
        if (kept.length() == windows.length()) return raw
        if (kept.length() == 0) return null
        fun hasStatus(status: QuotaWindowStatus) = (0 until kept.length()).any {
            kept.optJSONObject(it)?.opt("status") == status.wireValue
        }
        val status = raw.opt("status")
        val nextStatus = when {
            status == QuotaProviderStatus.Ok.wireValue && hasStatus(QuotaWindowStatus.Ok) ->
                QuotaProviderStatus.Ok
            (status == QuotaProviderStatus.Ok.wireValue || status == QuotaProviderStatus.Stale.wireValue) &&
                hasStatus(QuotaWindowStatus.Stale) -> QuotaProviderStatus.Stale
            else -> return null
        }
        return JSONObject(raw.toString())
            .put("status", nextStatus.wireValue)
            .put("windows", kept)
    }

    private fun parseProviderObject(
        raw: JSONObject,
        mode: QuotaParseMode
    ): QuotaProviderEnvelope {
        if (mode == QuotaParseMode.SyncedTransport) {
            requireExactFields(raw, providerFields, "provider_sync_field_rejected")
        }
        val schemaVersion = requiredInteger(raw, "schemaVersion", 1L, 1L).toInt()
        val providerId = requiredStableId(raw, "providerId")
        val displayName = requiredString(raw, "displayName")
        val scope = QuotaScope.parse(requiredString(raw, "scope"))
        val modeValue = QuotaMode.parse(requiredString(raw, "mode"))
        val capability = QuotaCapability.parse(requiredString(raw, "capability"))
        val status = QuotaProviderStatus.parse(requiredString(raw, "status"))
        val reasonCode = optionalString(raw, "reasonCode")
        val windowsArray = raw.optJSONArray("windows")
            ?: throw QuotaContractException("provider_windows_missing")
        if (windowsArray.length() > MAX_WINDOWS_PER_PROVIDER) {
            throw QuotaContractException("window_limit_exceeded")
        }

        if (status == QuotaProviderStatus.Unsupported) {
            if (
                modeValue != QuotaMode.Unsupported ||
                capability != QuotaCapability.Unsupported ||
                reasonCode.isNullOrBlank() ||
                windowsArray.length() != 0
            ) {
                throw QuotaContractException("provider_unsupported_invalid")
            }
        } else if (modeValue == QuotaMode.Unsupported || capability == QuotaCapability.Unsupported) {
            throw QuotaContractException("provider_capability_invalid")
        }

        val isManual = modeValue == QuotaMode.Manual
        if (
            isManual != (capability == QuotaCapability.Manual) ||
            isManual != (scope == QuotaScope.ManualBudget)
        ) {
            throw QuotaContractException("provider_manual_invalid")
        }
        if (
            (status == QuotaProviderStatus.AuthRequired || status == QuotaProviderStatus.Error) &&
            windowsArray.length() != 0
        ) {
            throw QuotaContractException("provider_empty_status_has_windows")
        }

        val windowIds = mutableSetOf<String>()
        val windows = buildList {
            for (index in 0 until windowsArray.length()) {
                val windowRaw = windowsArray.optJSONObject(index)
                    ?: throw QuotaContractException("window_not_object")
                val window = parseWindow(
                    raw = windowRaw,
                    mode = mode,
                    expectedProviderId = providerId,
                    expectedScope = scope,
                    providerManual = isManual
                )
                if (!windowIds.add(window.windowId)) {
                    throw QuotaContractException("window_stable_key_duplicate")
                }
                add(window)
            }
        }.sortedBy(QuotaWindowSnapshot::stableKey)

        when (status) {
            QuotaProviderStatus.Ok -> if (windows.none { it.status == QuotaWindowStatus.Ok }) {
                throw QuotaContractException("provider_ok_without_fresh_window")
            }
            QuotaProviderStatus.Stale -> if (windows.none { it.status == QuotaWindowStatus.Stale }) {
                throw QuotaContractException("provider_stale_without_stale_window")
            }
            QuotaProviderStatus.Unsupported,
            QuotaProviderStatus.AuthRequired,
            QuotaProviderStatus.Error -> Unit
        }
        if (
            (status == QuotaProviderStatus.Ok || status == QuotaProviderStatus.Stale) &&
            windows.isEmpty()
        ) {
            throw QuotaContractException("provider_value_status_empty")
        }
        return QuotaProviderEnvelope(
            schemaVersion,
            providerId,
            displayName,
            scope,
            modeValue,
            capability,
            status,
            windows,
            reasonCode
        )
    }

    private fun parseWindow(
        raw: JSONObject,
        mode: QuotaParseMode,
        expectedProviderId: String,
        expectedScope: QuotaScope,
        providerManual: Boolean
    ): QuotaWindowSnapshot {
        if (mode == QuotaParseMode.SyncedTransport) {
            requireExactFields(raw, windowFields, "window_sync_field_rejected")
        }
        val providerId = requiredStableId(raw, "providerId")
        val windowId = requiredStableId(raw, "windowId")
        val windowLabel = requiredString(raw, "windowLabel")
        val scope = QuotaScope.parse(requiredString(raw, "scope"))
        val source = QuotaSource.parse(requiredString(raw, "source"))
        val status = QuotaWindowStatus.parse(requiredString(raw, "status"))
        val unit = QuotaUnit.parse(requiredString(raw, "unit"))
        val used = optionalFiniteNumber(raw, "used")
        val limit = optionalFiniteNumber(raw, "limit")
        val remaining = optionalFiniteNumber(raw, "remaining")
        val windowMinutes = optionalPositiveInt(raw, "windowMinutes")
        val resetsAt = optionalString(raw, "resetsAt")?.also(::parseTimestamp)
        val observedAt = requiredString(raw, "observedAt").also(::parseTimestamp)
        val fetchedAt = requiredString(raw, "fetchedAt").also(::parseTimestamp)
        val staleAfterSeconds = requiredInteger(
            raw,
            "staleAfterSeconds",
            1L,
            Int.MAX_VALUE.toLong()
        ).toInt()
        val reasonCode = optionalString(raw, "reasonCode")
        val currency = if (raw.has("currency")) requiredString(raw, "currency") else null
        val currencyValid = if (unit == QuotaUnit.Currency) {
            currency != null && ISO_4217_ALPHA.matches(currency) &&
                windowMinutes == null && resetsAt == null && reasonCode != "credits_unlimited"
        } else {
            currency == null
        }
        if (!currencyValid) throw QuotaContractException("currency_window_invalid")

        if (providerId != expectedProviderId || scope != expectedScope) {
            throw QuotaContractException("window_provider_identity_mismatch")
        }
        if (providerManual != (source == QuotaSource.Manual)) {
            throw QuotaContractException("window_source_invalid")
        }
        if (
            mode == QuotaParseMode.SyncedTransport &&
            source != expectedSyncedSource(scope)
        ) {
            throw QuotaContractException("window_scope_source_invalid")
        }
        validateWindowValues(status, unit, used, limit, remaining, reasonCode)
        return QuotaWindowSnapshot(
            providerId,
            windowId,
            windowLabel,
            scope,
            source,
            status,
            used,
            limit,
            remaining,
            unit,
            windowMinutes,
            resetsAt,
            observedAt,
            fetchedAt,
            staleAfterSeconds,
            reasonCode,
            currency
        )
    }

    private fun expectedSyncedSource(scope: QuotaScope): QuotaSource = when (scope) {
        QuotaScope.ConsumerSubscription -> QuotaSource.LocalAuthorized
        QuotaScope.ApiOrganization -> QuotaSource.OfficialApi
        QuotaScope.ManualBudget -> QuotaSource.Manual
    }

    private fun validateWindowValues(
        status: QuotaWindowStatus,
        unit: QuotaUnit,
        used: Double?,
        limit: Double?,
        remaining: Double?,
        reasonCode: String?
    ) {
        if (
            status != QuotaWindowStatus.Ok && status != QuotaWindowStatus.Stale &&
            (used != null || limit != null || remaining != null)
        ) {
            throw QuotaContractException("window_status_values_disallowed")
        }
        if (reasonCode == "credits_unlimited") {
            if (unit != QuotaUnit.Credits || used != null || limit != null || remaining != null) {
                throw QuotaContractException("credits_unlimited_invalid")
            }
            return
        }
        if (unit == QuotaUnit.Percent) {
            if (
                used == null || used > 100.0 ||
                (limit != null && !approximatelyEqual(limit, 100.0)) ||
                (remaining != null && (
                    remaining > 100.0 || !approximatelyEqual(remaining, 100.0 - used)
                ))
            ) {
                throw QuotaContractException("percent_values_invalid")
            }
            return
        }
        if (used == null && limit == null && remaining == null) {
            throw QuotaContractException("absolute_values_missing")
        }
        if (
            (used != null && limit != null && used > limit) ||
            (limit != null && remaining != null && remaining > limit) ||
            (used != null && limit != null && remaining != null &&
                !approximatelyEqual(remaining, limit - used))
        ) {
            throw QuotaContractException("absolute_values_invalid")
        }
    }

    private fun providerToJson(provider: QuotaProviderEnvelope): JSONObject = JSONObject()
        .put("schemaVersion", provider.schemaVersion)
        .put("providerId", provider.providerId)
        .put("displayName", provider.displayName)
        .put("scope", provider.scope.wireValue)
        .put("mode", provider.mode.wireValue)
        .put("capability", provider.capability.wireValue)
        .put("status", provider.status.wireValue)
        .put("windows", JSONArray().apply { provider.windows.forEach { put(windowToJson(it)) } })
        .putOptional("reasonCode", provider.reasonCode)

    private fun windowToJson(window: QuotaWindowSnapshot): JSONObject = JSONObject()
        .put("providerId", window.providerId)
        .put("windowId", window.windowId)
        .put("windowLabel", window.windowLabel)
        .put("scope", window.scope.wireValue)
        .put("source", window.source.wireValue)
        .put("status", window.status.wireValue)
        .putOptional("used", window.used)
        .putOptional("limit", window.limit)
        .putOptional("remaining", window.remaining)
        .put("unit", window.unit.wireValue)
        .putOptional("windowMinutes", window.windowMinutes)
        .putOptional("resetsAt", window.resetsAt)
        .put("observedAt", window.observedAt)
        .put("fetchedAt", window.fetchedAt)
        .put("staleAfterSeconds", window.staleAfterSeconds)
        .putOptional("reasonCode", window.reasonCode)
        .putOptional("currency", window.currency)

    private fun requireExactFields(root: JSONObject, allowed: Set<String>, reason: String) {
        val keys = buildSet {
            val iterator = root.keys()
            while (iterator.hasNext()) add(iterator.next())
        }
        if (!allowed.containsAll(keys)) throw QuotaContractException(reason)
    }

    private fun requiredStableId(root: JSONObject, key: String): String =
        requiredString(root, key).also { value ->
            if (value.toByteArray(Charsets.UTF_8).size > MAX_STABLE_ID_BYTES) {
                throw QuotaContractException("stable_id_too_long")
            }
        }

    private fun requiredString(root: JSONObject, key: String): String {
        val value = root.opt(key)
        if (value !is String || value.isBlank()) throw QuotaContractException("${key}_invalid")
        requireStringBudget(value, "${key}_too_long")
        return value
    }

    private fun optionalString(root: JSONObject, key: String): String? {
        if (!root.has(key) || root.isNull(key)) return null
        return requiredString(root, key)
    }

    private fun requireStringBudget(value: String, reason: String) {
        if (value.toByteArray(Charsets.UTF_8).size > MAX_STRING_BYTES) {
            throw QuotaContractException(reason)
        }
    }

    private fun requiredInteger(
        root: JSONObject,
        key: String,
        minimum: Long,
        maximum: Long
    ): Long {
        val value = root.opt(key) as? Number ?: throw QuotaContractException("${key}_invalid")
        val doubleValue = value.toDouble()
        val longValue = value.toLong()
        if (
            !doubleValue.isFinite() || doubleValue != longValue.toDouble() ||
            longValue !in minimum..maximum
        ) {
            throw QuotaContractException("${key}_invalid")
        }
        return longValue
    }

    private fun optionalPositiveInt(root: JSONObject, key: String): Int? {
        if (!root.has(key) || root.isNull(key)) return null
        return requiredInteger(root, key, 1L, Int.MAX_VALUE.toLong()).toInt()
    }

    private fun optionalFiniteNumber(root: JSONObject, key: String): Double? {
        if (!root.has(key) || root.isNull(key)) return null
        val value = (root.opt(key) as? Number)?.toDouble()
            ?: throw QuotaContractException("${key}_invalid")
        if (!value.isFinite() || value < 0.0) throw QuotaContractException("${key}_invalid")
        return value
    }

    private fun approximatelyEqual(left: Double, right: Double): Boolean {
        val scale = max(1.0, max(abs(left), abs(right)))
        return abs(left - right) <= Math.ulp(1.0) * scale * 16.0
    }

    private fun JSONObject.putOptional(key: String, value: Any?): JSONObject = apply {
        if (value != null) put(key, value)
    }
}
