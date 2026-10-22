package com.jeidorf.tokenledger.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle
import java.time.temporal.ChronoUnit

internal const val DASHBOARD_QUERY_ITEM_LIMIT = 32
internal const val DASHBOARD_QUERY_UTF8_LIMIT = 256
internal const val EFFECTIVE_TOKEN_MODE = "effective"

internal class DashboardQueryContractException(message: String) :
    IllegalArgumentException(message)

data class DashboardEntity(
    val kind: String,
    val id: String
) {
    companion object {
        const val TOOL = "tool"
        const val MODEL = "model"
    }
}

internal data class CanonicalDashboardQuery(
    val range: String,
    val start: String?,
    val end: String?,
    val timezone: String,
    val machines: List<String>,
    val tools: List<String>,
    val models: List<String>,
    val search: String?,
    val tokenMode: String
) {
    val hasFilters: Boolean
        get() = machines.isNotEmpty() || tools.isNotEmpty() || models.isNotEmpty() || search != null

    fun toJson(): JSONObject = JSONObject()
        .put("range", range)
        .put("timezone", timezone)
        .put("machines", machines.toJsonArray())
        .put("tools", tools.toJsonArray())
        .put("models", models.toJsonArray())
        .putNullable("search", search)
        .put("tokenMode", tokenMode)
        .apply {
            if (range == RangeKey.Custom.rpcValue) {
                put("start", start)
                put("end", end)
            }
        }
}

internal object DashboardQueryContract {
    fun normalize(query: DashboardQuery): DashboardQuery {
        val bounds = normalizeBounds(query.range, query.start, query.end)
        return query.copy(
        start = bounds.first,
        end = bounds.second,
        machines = normalizeValues("machines", query.machines, rejectMachineSentinels = true),
        tools = normalizeValues("tools", query.tools),
        models = normalizeValues("models", query.models),
        search = normalizeSearch(query.search),
        tokenMode = normalizeTokenMode(query.tokenMode)
        )
    }

    fun canonical(
        query: DashboardQuery,
        timezone: String,
        entity: DashboardEntity? = null
    ): CanonicalDashboardQuery {
        val normalizedQuery = normalize(query)
        val normalizedEntity = entity?.let(::normalizeEntity)
        if (normalizedEntity?.kind == DashboardEntity.TOOL && normalizedQuery.tools.isNotEmpty()) {
            throw DashboardQueryContractException("tool entity requires an empty tools query")
        }
        if (normalizedEntity?.kind == DashboardEntity.MODEL && normalizedQuery.models.isNotEmpty()) {
            throw DashboardQueryContractException("model entity requires an empty models query")
        }
        return CanonicalDashboardQuery(
            range = normalizedQuery.range.rpcValue,
            start = normalizedQuery.start,
            end = normalizedQuery.end,
            timezone = timezone.ifBlank { "UTC" },
            machines = normalizedQuery.machines,
            tools = normalizedQuery.tools,
            models = normalizedQuery.models,
            search = normalizedQuery.search,
            tokenMode = normalizedQuery.tokenMode
        )
    }

    fun normalizeEntity(entity: DashboardEntity): DashboardEntity {
        if (entity.kind != DashboardEntity.TOOL && entity.kind != DashboardEntity.MODEL) {
            throw DashboardQueryContractException("entity.kind must be tool or model")
        }
        return entity.copy(id = normalizeItem("entity.id", entity.id))
    }

    fun readEcho(obj: JSONObject): StatsQueryEcho {
        val range = obj.requiredString("range")
        val timezone = obj.requiredString("timezone")
        val tokenMode = normalizeTokenMode(obj.requiredString("tokenMode"))
        val machines = readDimension(obj, "machines", "machine", machine = true)
        val tools = readDimension(obj, "tools", "tool")
        val models = readDimension(obj, "models", "model")
        val search = if (!obj.has("search") || obj.isNull("search")) {
            null
        } else {
            normalizeSearch(obj.requiredString("search"))
        }
        val start = obj.optionalString("start")
        val end = obj.optionalString("end")
        val bounds = normalizeBounds(
            RangeKey.entries.firstOrNull { it.rpcValue == range }
                ?: throw DashboardQueryContractException("unsupported range: $range"),
            start,
            end
        )
        return StatsQueryEcho(
            range = range,
            timezone = timezone,
            machine = compatibilityEcho(machines),
            tool = compatibilityEcho(tools),
            model = compatibilityEcho(models),
            tokenMode = tokenMode,
            machines = machines,
            tools = tools,
            models = models,
            search = search,
            start = bounds.first,
            end = bounds.second
        )
    }

    fun canonical(echo: StatsQueryEcho): CanonicalDashboardQuery {
        val range = echo.range ?: throw DashboardQueryContractException("query echo is missing range")
        val timezone = echo.timezone
            ?: throw DashboardQueryContractException("query echo is missing timezone")
        return CanonicalDashboardQuery(
            range = range,
            start = echo.start,
            end = echo.end,
            timezone = timezone,
            machines = normalizeValues("machines", echo.machines, rejectMachineSentinels = true),
            tools = normalizeValues("tools", echo.tools),
            models = normalizeValues("models", echo.models),
            search = normalizeSearch(echo.search),
            tokenMode = normalizeTokenMode(echo.tokenMode ?: EFFECTIVE_TOKEN_MODE)
        )
    }

    fun requireResponseEcho(
        raw: String,
        expectedQuery: CanonicalDashboardQuery,
        expectedEntity: DashboardEntity? = null
    ) {
        val root = JSONObject(raw)
        val meta = root.optJSONObject("meta")
            ?: throw DashboardQueryContractException("v2 response is missing meta")
        val queryObject = meta.optJSONObject("query")
            ?: throw DashboardQueryContractException("v2 response is missing meta.query")
        val echoedQuery = canonical(readEcho(queryObject))
        if (echoedQuery != expectedQuery) {
            throw DashboardQueryContractException("v2 response query echo does not match request")
        }

        val echoedEntity = if (!meta.has("entity") || meta.isNull("entity")) {
            null
        } else {
            val entityObject = meta.optJSONObject("entity")
                ?: throw DashboardQueryContractException("meta.entity must be an object")
            normalizeEntity(
                DashboardEntity(
                    kind = entityObject.requiredString("kind"),
                    id = entityObject.requiredString("id")
                )
            )
        }
        val normalizedExpectedEntity = expectedEntity?.let(::normalizeEntity)
        if (echoedEntity != normalizedExpectedEntity) {
            throw DashboardQueryContractException("v2 response entity echo does not match request")
        }
    }

    fun normalizeValues(
        dimension: String,
        values: List<String>,
        rejectMachineSentinels: Boolean = false
    ): List<String> {
        if (values.size > DASHBOARD_QUERY_ITEM_LIMIT) {
            throw DashboardQueryContractException("$dimension exceeds $DASHBOARD_QUERY_ITEM_LIMIT items")
        }
        val normalized = values.mapIndexed { index, value ->
            normalizeItem("$dimension[$index]", value).also {
                if (rejectMachineSentinels && it in LEGACY_MACHINE_SENTINELS) {
                    throw DashboardQueryContractException("$dimension contains a legacy sentinel")
                }
            }
        }
        return normalized.distinct().sortedWith(UNSIGNED_UTF8_COMPARATOR)
    }

    fun normalizeSearch(value: String?): String? {
        val normalized = value?.asciiTrim()?.takeIf(String::isNotEmpty) ?: return null
        if (normalized.toByteArray(Charsets.UTF_8).size > DASHBOARD_QUERY_UTF8_LIMIT) {
            throw DashboardQueryContractException("search exceeds $DASHBOARD_QUERY_UTF8_LIMIT UTF-8 bytes")
        }
        return normalized
    }

    fun normalizeItem(field: String, value: String): String {
        val normalized = value.asciiTrim()
        if (normalized.isEmpty()) {
            throw DashboardQueryContractException("$field is empty after ASCII trim")
        }
        if (normalized.toByteArray(Charsets.UTF_8).size > DASHBOARD_QUERY_UTF8_LIMIT) {
            throw DashboardQueryContractException("$field exceeds $DASHBOARD_QUERY_UTF8_LIMIT UTF-8 bytes")
        }
        return normalized
    }

    internal fun normalizeBounds(
        range: RangeKey,
        start: String?,
        end: String?,
        today: LocalDate = LocalDate.now()
    ): Pair<String?, String?> {
        if (range != RangeKey.Custom) return null to null
        val normalizedStart = parseLocalDate("start", start)
        val normalizedEnd = parseLocalDate("end", end)
        if (normalizedStart.isAfter(normalizedEnd)) {
            throw DashboardQueryContractException("start must be on or before end")
        }
        if (normalizedStart.isAfter(today)) {
            throw DashboardQueryContractException("start must not be after today")
        }
        if (ChronoUnit.DAYS.between(normalizedStart, normalizedEnd) + 1 > 731) {
            throw DashboardQueryContractException("custom range exceeds 731 days")
        }
        return normalizedStart.toString() to normalizedEnd.toString()
    }

    private fun parseLocalDate(field: String, value: String?): LocalDate {
        val raw = value ?: throw DashboardQueryContractException("custom range requires $field")
        if (!DATE_PATTERN.matches(raw)) {
            throw DashboardQueryContractException("$field must use YYYY-MM-DD")
        }
        return try {
            LocalDate.parse(raw, STRICT_DATE_FORMATTER)
        } catch (_: RuntimeException) {
            throw DashboardQueryContractException("$field is not a valid date")
        }
    }

    fun legacyMachineValues(value: String?): List<String> {
        val normalized = value?.asciiTrim()?.takeIf(String::isNotEmpty) ?: return emptyList()
        if (normalized in LEGACY_MACHINE_SENTINELS) return emptyList()
        return normalizeValues("machines", listOf(normalized), rejectMachineSentinels = true)
    }

    fun legacyOptionalValues(dimension: String, value: String?): List<String> {
        val normalized = value?.asciiTrim()?.takeIf(String::isNotEmpty) ?: return emptyList()
        return normalizeValues(dimension, listOf(normalized))
    }

    private fun readDimension(
        obj: JSONObject,
        pluralKey: String,
        singularKey: String,
        machine: Boolean = false
    ): List<String> {
        val pluralPresent = obj.has(pluralKey)
        val plural = if (pluralPresent) {
            val array = obj.opt(pluralKey) as? JSONArray
                ?: throw DashboardQueryContractException("$pluralKey must be an array")
            val values = buildList {
                for (index in 0 until array.length()) {
                    val value = array.opt(index)
                    if (value !is String) {
                        throw DashboardQueryContractException("$pluralKey[$index] must be a string")
                    }
                    add(value)
                }
            }
            normalizeValues(pluralKey, values, rejectMachineSentinels = machine)
        } else {
            null
        }

        val singularPresent = obj.has(singularKey)
        val singularValue = if (!singularPresent || obj.isNull(singularKey)) {
            null
        } else {
            obj.opt(singularKey) as? String
                ?: throw DashboardQueryContractException("$singularKey must be a string or null")
        }
        val singular = if (machine) {
            legacyMachineValues(singularValue)
        } else {
            legacyOptionalValues(pluralKey, singularValue)
        }

        if (plural != null && singularPresent && plural != singular) {
            throw DashboardQueryContractException("$pluralKey/$singularKey response echoes conflict")
        }
        return plural ?: singular
    }

    private fun normalizeTokenMode(value: String): String {
        if (value != EFFECTIVE_TOKEN_MODE) {
            throw DashboardQueryContractException("unsupported tokenMode: $value")
        }
        return value
    }

    private val DATE_PATTERN = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    private val STRICT_DATE_FORMATTER = DateTimeFormatter.ofPattern("uuuu-MM-dd")
        .withResolverStyle(ResolverStyle.STRICT)
}

internal fun DashboardEntity.toJson(): JSONObject = JSONObject()
    .put("kind", kind)
    .put("id", id)

private fun compatibilityEcho(values: List<String>): String? = values.singleOrNull()

private fun List<String>.toJsonArray(): JSONArray = JSONArray().apply {
    forEach(::put)
}

private fun JSONObject.requiredString(key: String): String {
    val value = opt(key)
    if (value !is String) throw DashboardQueryContractException("$key must be a string")
    return value
}

private fun JSONObject.optionalString(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return opt(key) as? String ?: throw DashboardQueryContractException("$key must be a string or null")
}

private fun JSONObject.putNullable(key: String, value: String?): JSONObject =
    put(key, value ?: JSONObject.NULL)

private fun String.asciiTrim(): String = trim { character ->
    character == ' ' || character == '\t' || character == '\n' || character == '\r'
}

private val LEGACY_MACHINE_SENTINELS = setOf("all", "all_cloud")

private val UNSIGNED_UTF8_COMPARATOR = Comparator<String> { left, right ->
    val leftBytes = left.toByteArray(Charsets.UTF_8)
    val rightBytes = right.toByteArray(Charsets.UTF_8)
    val commonLength = minOf(leftBytes.size, rightBytes.size)
    for (index in 0 until commonLength) {
        val comparison = (leftBytes[index].toInt() and 0xff)
            .compareTo(rightBytes[index].toInt() and 0xff)
        if (comparison != 0) return@Comparator comparison
    }
    leftBytes.size.compareTo(rightBytes.size)
}
