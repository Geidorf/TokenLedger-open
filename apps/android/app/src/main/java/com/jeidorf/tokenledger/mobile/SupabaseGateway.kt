package com.jeidorf.tokenledger.mobile

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

class SupabaseGateway(
    supabaseUrl: String,
    private val publishableKey: String
) {
    private val baseUrl = supabaseUrl.trim().trimEnd('/')

    suspend fun signIn(email: String, password: String): MobileSession = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("email", email)
            .put("password", password)
        parseSession(
            request(
                path = "/auth/v1/token?grant_type=password",
                method = "POST",
                body = body
            )
        )
    }

    suspend fun refresh(refreshToken: String): MobileSession = withContext(Dispatchers.IO) {
        val body = JSONObject().put("refresh_token", refreshToken)
        parseSession(
            request(
                path = "/auth/v1/token?grant_type=refresh_token",
                method = "POST",
                body = body
            )
        )
    }

    /**
     * Ends this device's server session so its refresh token can no longer be exchanged.
     * `scope=local` leaves the user's other devices signed in. An expired access token is
     * swapped for a fresh one first; the rotated token is never persisted and dies with the logout.
     */
    suspend fun revokeSession(session: MobileSession) = withContext(Dispatchers.IO) {
        try {
            logout(session.accessToken)
        } catch (error: SupabaseHttpException) {
            if (error.status != 401 && error.status != 403) throw error
            logout(parseSession(
                request(
                    path = "/auth/v1/token?grant_type=refresh_token",
                    method = "POST",
                    body = JSONObject().put("refresh_token", session.refreshToken)
                )
            ).accessToken)
        }
    }

    private fun logout(accessToken: String) {
        request(
            path = "/auth/v1/logout?scope=local",
            method = "POST",
            bearerToken = accessToken,
            maxResponseBytes = SUPABASE_ERROR_MAX_RESPONSE_BYTES
        )
    }

    /**
     * Reads the owner-scoped desktop projection. Quota deliberately stays outside Stats v2 and
     * this method never refreshes or persists a session; DashboardViewModel supplies a committed
     * access token so quota failure cannot take down the usage dashboard.
     */
    suspend fun fetchQuotaSnapshots(session: MobileSession): QuotaTransportSnapshot =
        withContext(Dispatchers.IO) {
            val read = { function: String ->
                request(
                    path = "/rest/v1/rpc/$function",
                    method = "POST",
                    bearerToken = session.accessToken,
                    body = JSONObject(),
                    maxResponseBytes = QUOTA_RPC_MAX_RESPONSE_BYTES
                )
            }
            val raw = try {
                read(QUOTA_READ_V3_FUNCTION)
            } catch (error: SupabaseHttpException) {
                if (!error.isMissingRpcSignature(QUOTA_READ_V3_FUNCTION)) throw error
                read(QUOTA_READ_V2_FUNCTION)
            }
            QuotaSnapshotJson.parseTransport(raw)
        }

    /**
     * 实时路由快照（契约 docs/contracts/routing-snapshot-v1.md）：只读，原样返回 JSON，由
     * `routing` 包解析与合并。路由页和锁屏动态壁纸共用；不刷新、不持久化会话。
     */
    suspend fun fetchRoutingSnapshots(session: MobileSession): String = withContext(Dispatchers.IO) {
        request(
            path = "/rest/v1/rpc/$ROUTING_SNAPSHOTS_READ_FUNCTION",
            method = "POST",
            bearerToken = session.accessToken,
            body = JSONObject(),
            maxResponseBytes = ROUTING_SNAPSHOTS_MAX_RESPONSE_BYTES
        )
    }

    /**
     * 云端活动节律（契约 docs/contracts/activity-rhythm-cloud-v1.md）：只读，原样返回 JSON，由
     * `rhythm` 包解析。所有者由云端取 auth.uid()，不传 p_user。
     */
    internal suspend fun fetchActivityRhythm(session: MobileSession, query: CanonicalDashboardQuery): String =
        withContext(Dispatchers.IO) {
            request(
                path = "/rest/v1/rpc/$ACTIVITY_RHYTHM_READ_FUNCTION",
                method = "POST",
                bearerToken = session.accessToken,
                body = JSONObject().put("p_query", query.toJson()),
                maxResponseBytes = ACTIVITY_RHYTHM_MAX_RESPONSE_BYTES
            )
        }

    suspend fun fetchBudgetSnapshots(session: MobileSession): String = withContext(Dispatchers.IO) {
        request(
            path = "/rest/v1/rpc/$BUDGET_SNAPSHOTS_READ_FUNCTION",
            method = "POST",
            bearerToken = session.accessToken,
            body = JSONObject(),
            maxResponseBytes = BUDGET_SNAPSHOTS_MAX_RESPONSE_BYTES
        )
    }

    suspend fun fetchDashboardStats(
        session: MobileSession,
        range: RangeKey,
        machine: String,
        timezone: String
    ): StatsData = fetchDashboardStats(
        session = session,
        query = DashboardQuery(range = range, machine = machine),
        timezone = timezone,
        entity = null
    )

    suspend fun fetchDashboardStats(
        session: MobileSession,
        query: DashboardQuery,
        timezone: String
    ): StatsData = fetchDashboardStats(session, query, timezone, entity = null)

    suspend fun fetchDashboardStats(
        session: MobileSession,
        query: DashboardQuery,
        timezone: String,
        entity: DashboardEntity?
    ): StatsData = withContext(Dispatchers.IO) {
        val normalizedEntity = entity?.let(DashboardQueryContract::normalizeEntity)
        val canonicalQuery = DashboardQueryContract.canonical(query, timezone, normalizedEntity)
        if (normalizedEntity != null) {
            return@withContext fetchEntityDashboardStats(
                session = session,
                query = canonicalQuery,
                entity = normalizedEntity
            )
        }

        val bundle = coroutineScope {
            val base = async { fetchBaseDashboardStats(session, canonicalQuery) }
            val comparison = async {
                fetchQueryRpcWithFallback(
                    session = session,
                    query = canonicalQuery,
                    v2Function = "get_usage_comparison_v2",
                    v1Function = "get_usage_comparison_v1",
                    allowNullV2Envelope = true,
                    fallbackAllowed = canonicalQuery.canFallbackComparison(),
                    legacyPayload = createLegacyQueryPayload(session.userId, canonicalQuery)
                )
            }
            val details = async {
                fetchQueryRpcWithFallback(
                    session = session,
                    query = canonicalQuery,
                    v2Function = "get_usage_details_v2",
                    v1Function = "get_usage_details_v1",
                    fallbackAllowed = canonicalQuery.canFallbackDetails(),
                    legacyPayload = createLegacyDetailsPayload(
                        userId = session.userId,
                        query = canonicalQuery,
                        cursor = null
                    ),
                    v2Payload = createV2DetailsPayload(
                        userId = session.userId,
                        query = canonicalQuery,
                        cursor = null
                    )
                )
            }
            DashboardRpcBundle(
                base = base.await(),
                comparison = comparison.await(),
                details = details.await()
            )
        }
        val baseStats = bundle.base.stats
        val comparisonResult = bundle.comparison
        val detailsResult = bundle.details

        if (canonicalQuery.hasFilters && !detailsResult.available) {
            throw DashboardCapabilityException(
                "当前云端无法对完整明细应用该筛选，请先部署多选/搜索查询契约"
            )
        }

        val comparison = comparisonResult.raw?.let(StatsJson::parseComparison)
        val details = detailsResult.raw?.let(StatsJson::parseDetailsPage)

        baseStats.copy(
            history = details?.items ?: baseStats.history,
            machines = details?.availableFilters?.machines?.map { it.value }
                ?.ifEmpty { baseStats.machines } ?: baseStats.machines,
            comparison = comparison ?: baseStats.comparison,
            detailsPage = details ?: baseStats.detailsPage,
            capabilities = DashboardCapabilities(
                comparison = comparisonResult.available || baseStats.capabilities.comparison,
                details = detailsResult.available || baseStats.capabilities.details,
                entityDashboard = baseStats.capabilities.entityDashboard,
                multiFilterSearch = baseStats.capabilities.multiFilterSearch &&
                    bundle.base.usedV2 && comparisonResult.usedV2 && detailsResult.usedV2
            )
        )
    }

    suspend fun fetchUsageDetails(
        session: MobileSession,
        query: DashboardQuery,
        timezone: String,
        cursor: String
    ): UsageDetailsPage = fetchUsageDetails(session, query, entity = null, timezone, cursor)

    suspend fun fetchUsageDetails(
        session: MobileSession,
        query: DashboardQuery,
        entity: DashboardEntity?,
        timezone: String,
        cursor: String
    ): UsageDetailsPage = withContext(Dispatchers.IO) {
        val normalizedEntity = entity?.let(DashboardQueryContract::normalizeEntity)
        val canonicalQuery = DashboardQueryContract.canonical(query, timezone, normalizedEntity)
        if (normalizedEntity != null) {
            val response = fetchEntityRpc(
                session = session,
                query = canonicalQuery,
                entity = normalizedEntity,
                cursor = cursor,
                allowLegacyFallback = false
            ).raw ?: throw DashboardCapabilityException("当前云端不支持实体明细继续分页")
            val dashboard = StatsJson.parseEntityDashboard(response)
            requireEntityIdentity(dashboard.entity, normalizedEntity)
            return@withContext dashboard.historyPage
        }

        val result = fetchQueryRpcWithFallback(
            session = session,
            query = canonicalQuery,
            v2Function = "get_usage_details_v2",
            v1Function = "get_usage_details_v1",
            fallbackAllowed = canonicalQuery.canFallbackDetails(),
            legacyPayload = createLegacyDetailsPayload(session.userId, canonicalQuery, cursor),
            v2Payload = createV2DetailsPayload(session.userId, canonicalQuery, cursor)
        )
        val response = result.raw
            ?: throw DashboardCapabilityException("当前云端不支持详情分页")
        StatsJson.parseDetailsPage(response)
    }

    private fun fetchBaseDashboardStats(
        session: MobileSession,
        query: CanonicalDashboardQuery
    ): BaseRpcResult {
        val response = try {
            request(
                path = "/rest/v1/rpc/get_dashboard_stats_v2",
                method = "POST",
                bearerToken = session.accessToken,
                body = createV2RpcPayload(session.userId, query)
            )
        } catch (error: SupabaseHttpException) {
            if (query.range == RangeKey.Custom.rpcValue && error.isLegacyCustomRangeRejection()) {
                throw DashboardCapabilityException("云端尚未支持自定义日期范围")
            }
            if (!error.isMissingRpcSignature("get_dashboard_stats_v2")) throw error
            if (query.range == RangeKey.Custom.rpcValue) {
                throw DashboardCapabilityException("云端尚未支持自定义日期范围")
            }
            if (!query.canFallbackMainDashboard()) {
                throw DashboardCapabilityException(
                    "当前云端主看板无法无损表达该多选/搜索查询"
                )
            }
            return fetchLegacyBaseDashboardStats(session, query)
        }
        DashboardQueryContract.requireResponseEcho(response, query)
        return BaseRpcResult(
            stats = StatsJson.parse(response).copy(legacyRpc = false),
            usedV2 = true
        )
    }

    private fun fetchLegacyBaseDashboardStats(
        session: MobileSession,
        query: CanonicalDashboardQuery
    ): BaseRpcResult {
        val response = try {
            request(
                path = "/rest/v1/rpc/get_dashboard_stats",
                method = "POST",
                bearerToken = session.accessToken,
                body = createStatsPayload(
                    userId = session.userId,
                    range = query.range,
                    machine = query.machines.singleOrNull(),
                    timezone = query.timezone,
                    includeTimezone = true
                )
            )
        } catch (error: SupabaseHttpException) {
            if (!error.isMissingRpcSignature("get_dashboard_stats")) throw error
            // The oldest three-argument RPC has no timezone and therefore retains its UTC warning.
            val raw = request(
                path = "/rest/v1/rpc/get_dashboard_stats",
                method = "POST",
                bearerToken = session.accessToken,
                body = createStatsPayload(
                    userId = session.userId,
                    range = query.range,
                    machine = query.machines.singleOrNull(),
                    timezone = query.timezone,
                    includeTimezone = false
                )
            )
            return BaseRpcResult(
                stats = StatsJson.parse(raw).copy(legacyRpc = true),
                usedV2 = false
            )
        }
        return BaseRpcResult(
            stats = StatsJson.parse(response).copy(legacyRpc = false),
            usedV2 = false
        )
    }

    private fun fetchQueryRpcWithFallback(
        session: MobileSession,
        query: CanonicalDashboardQuery,
        v2Function: String,
        v1Function: String,
        allowNullV2Envelope: Boolean = false,
        fallbackAllowed: Boolean,
        legacyPayload: JSONObject,
        v2Payload: JSONObject = createV2RpcPayload(session.userId, query)
    ): OptionalRpc {
        val v2Raw = try {
            request(
                path = "/rest/v1/rpc/$v2Function",
                method = "POST",
                bearerToken = session.accessToken,
                body = v2Payload
            )
        } catch (error: SupabaseHttpException) {
            if (query.range == RangeKey.Custom.rpcValue && error.isLegacyCustomRangeRejection()) {
                throw DashboardCapabilityException("云端尚未支持自定义日期范围")
            }
            if (!error.isMissingRpcSignature(v2Function)) throw error
            if (!fallbackAllowed) {
                if (query.range == RangeKey.Custom.rpcValue) {
                    throw DashboardCapabilityException("云端尚未支持自定义日期范围")
                }
                throw DashboardCapabilityException(
                    "当前云端 $v2Function 无法无损降级该多选/搜索查询"
                )
            }
            val legacyRaw = try {
                request(
                    path = "/rest/v1/rpc/$v1Function",
                    method = "POST",
                    bearerToken = session.accessToken,
                    body = legacyPayload
                )
            } catch (legacyError: SupabaseHttpException) {
                if (!legacyError.isMissingRpcSignature(v1Function)) throw legacyError
                return OptionalRpc(available = false, raw = null, usedV2 = false)
            }
            val normalizedLegacyRaw = legacyRaw.takeUnless { it.isBlank() || it.trim() == "null" }
            return OptionalRpc(
                available = normalizedLegacyRaw != null,
                raw = normalizedLegacyRaw,
                usedV2 = false
            )
        }
        val normalizedV2Raw = normalizeRpcObjectEnvelope(
            functionName = v2Function,
            raw = v2Raw,
            allowNullEnvelope = allowNullV2Envelope
        )
        if (normalizedV2Raw == null) {
            return OptionalRpc(available = false, raw = null, usedV2 = true)
        }
        DashboardQueryContract.requireResponseEcho(normalizedV2Raw, query)
        return OptionalRpc(available = true, raw = normalizedV2Raw, usedV2 = true)
    }

    private fun fetchEntityRpc(
        session: MobileSession,
        query: CanonicalDashboardQuery,
        entity: DashboardEntity,
        cursor: String?,
        allowLegacyFallback: Boolean
    ): OptionalRpc {
        val v2Function = "get_usage_entity_dashboard_v2"
        val response = try {
            request(
                path = "/rest/v1/rpc/$v2Function",
                method = "POST",
                bearerToken = session.accessToken,
                body = createV2EntityPayload(session.userId, query, entity, cursor)
            )
        } catch (error: SupabaseHttpException) {
            if (query.range == RangeKey.Custom.rpcValue && error.isLegacyCustomRangeRejection()) {
                throw DashboardCapabilityException("云端尚未支持自定义日期范围")
            }
            if (!error.isMissingRpcSignature(v2Function)) throw error
            if (!allowLegacyFallback || !query.canFallbackEntity(entity)) {
                if (query.range == RangeKey.Custom.rpcValue) {
                    throw DashboardCapabilityException("云端尚未支持自定义日期范围")
                }
                throw DashboardCapabilityException(
                    "当前云端实体看板无法无损表达该查询或继续分页"
                )
            }
            val legacyFunction = "get_usage_entity_dashboard_v1"
            val legacyRaw = try {
                request(
                    path = "/rest/v1/rpc/$legacyFunction",
                    method = "POST",
                    bearerToken = session.accessToken,
                    body = createLegacyEntityPayload(session.userId, query, entity)
                )
            } catch (legacyError: SupabaseHttpException) {
                if (!legacyError.isMissingRpcSignature(legacyFunction)) throw legacyError
                throw DashboardCapabilityException("当前云端未部署实体看板 RPC")
            }
            return OptionalRpc(available = true, raw = legacyRaw, usedV2 = false)
        }
        normalizeRpcObjectEnvelope(v2Function, response, allowNullEnvelope = false)
        DashboardQueryContract.requireResponseEcho(response, query, entity)
        return OptionalRpc(available = true, raw = response, usedV2 = true)
    }

    private fun fetchEntityDashboardStats(
        session: MobileSession,
        query: CanonicalDashboardQuery,
        entity: DashboardEntity
    ): StatsData {
        val result = fetchEntityRpc(
            session = session,
            query = query,
            entity = entity,
            cursor = null,
            allowLegacyFallback = true
        )
        val raw = result.raw ?: throw DashboardCapabilityException("实体看板响应为空")
        val parsed = StatsJson.parseEntityDashboard(raw)
        requireEntityIdentity(parsed.entity, entity)
        val historyPage = if (result.usedV2) {
            parsed.historyPage
        } else {
            // The v1 entity endpoint has no cursor input, so it must not advertise fake pagination.
            parsed.historyPage.copy(nextCursor = null, hasMore = false)
        }
        val dashboard = parsed.copy(historyPage = historyPage)
        val comparisonSeries = dashboard.comparison?.current?.series.orEmpty().map { point ->
            TrendPoint(
                date = point.bucket,
                values = mapOf("filtered" to point.tokens),
                requests = point.requests
            )
        }
        val sourceMeta = StatsJson.parseMeta(raw)
        val serverClaimsFullQueryChain = JSONObject(raw)
            .optJSONObject("meta")
            ?.optJSONObject("capabilities")
            ?.optBoolean("multiFilterSearch", false) == true
        val meta = (sourceMeta ?: StatsMeta(
            generatedAt = null,
            lastRefreshedAt = null,
            timezone = query.timezone,
            range = query.range,
            machine = query.machines.singleOrNull(),
            stale = false,
            contractVersion = if (result.usedV2) 2 else 1
        )).copy(
            query = query.toStatsQueryEcho(),
            entity = entity
        )
        return StatsData(
            summary = dashboard.summary,
            tools = dashboard.composition.tools.associate { it.value to it.toToolStat() },
            models = dashboard.composition.models.associate { it.value to it.toModelStat() },
            trends = comparisonSeries,
            heatmap = dashboard.heatmap,
            history = historyPage.items,
            machines = dashboard.composition.machines.map { it.value },
            meta = meta,
            comparison = dashboard.comparison,
            detailsPage = historyPage,
            entityDashboard = dashboard,
            capabilities = DashboardCapabilities(
                comparison = dashboard.comparison != null,
                details = result.usedV2,
                entityDashboard = true,
                multiFilterSearch = result.usedV2 && serverClaimsFullQueryChain
            )
        )
    }

    private fun requireEntityIdentity(actual: EntityDescriptor, expected: DashboardEntity) {
        val actualEntity = DashboardQueryContract.normalizeEntity(
            DashboardEntity(kind = actual.kind, id = actual.id)
        )
        if (actualEntity != expected) {
            throw DashboardQueryContractException("entity response identity does not match request")
        }
    }

    fun createStatsPayload(
        userId: String,
        range: String,
        machine: String?,
        timezone: String,
        includeTimezone: Boolean = true
    ): JSONObject {
        val normalizedMachine = machine?.takeIf { it.isNotBlank() && it != "all_cloud" }
        val payload = JSONObject()
            .put("p_user", userId)
            .put("p_range", range.ifBlank { "today" })
            .put("p_machine", normalizedMachine ?: JSONObject.NULL)
        if (includeTimezone) {
            payload.put("p_timezone", timezone.ifBlank { "UTC" })
        }
        return payload
    }

    fun createV2QueryPayload(
        userId: String,
        query: DashboardQuery,
        timezone: String
    ): JSONObject {
        val canonical = DashboardQueryContract.canonical(query, timezone)
        if (!canonical.canFallbackComparison()) {
            throw DashboardCapabilityException("legacy payload cannot represent this canonical query")
        }
        return createLegacyQueryPayload(userId, canonical)
    }

    fun createDetailsPayload(
        userId: String,
        query: DashboardQuery,
        timezone: String,
        cursor: String?,
        limit: Int = DETAILS_PAGE_SIZE
    ): JSONObject = createV2QueryPayload(userId, query, timezone)
        .putNullable("p_cursor", cursor?.takeIf(String::isNotBlank))
        .put("p_limit", limit.coerceIn(1, 100))

    fun createCanonicalQueryPayload(
        query: DashboardQuery,
        timezone: String,
        entity: DashboardEntity? = null
    ): JSONObject = DashboardQueryContract.canonical(query, timezone, entity).toJson()

    fun createDashboardV2Payload(
        userId: String,
        query: DashboardQuery,
        timezone: String
    ): JSONObject = createV2RpcPayload(
        userId,
        DashboardQueryContract.canonical(query, timezone)
    )

    fun createEntityV2Payload(
        userId: String,
        query: DashboardQuery,
        timezone: String,
        entity: DashboardEntity,
        cursor: String? = null,
        limit: Int = DETAILS_PAGE_SIZE
    ): JSONObject {
        val normalizedEntity = DashboardQueryContract.normalizeEntity(entity)
        return createV2EntityPayload(
            userId = userId,
            query = DashboardQueryContract.canonical(query, timezone, normalizedEntity),
            entity = normalizedEntity,
            cursor = cursor,
            limit = limit
        )
    }

    private fun createV2RpcPayload(
        userId: String,
        query: CanonicalDashboardQuery
    ): JSONObject = JSONObject()
        .put("p_user", userId)
        .put("p_query", query.toJson())

    private fun createV2DetailsPayload(
        userId: String,
        query: CanonicalDashboardQuery,
        cursor: String?,
        limit: Int = DETAILS_PAGE_SIZE
    ): JSONObject = createV2RpcPayload(userId, query)
        .putNullable("p_cursor", cursor?.takeIf(String::isNotBlank))
        .put("p_limit", limit.coerceIn(1, 100))

    private fun createV2EntityPayload(
        userId: String,
        query: CanonicalDashboardQuery,
        entity: DashboardEntity,
        cursor: String?,
        limit: Int = DETAILS_PAGE_SIZE
    ): JSONObject = createV2RpcPayload(userId, query)
        .put("p_entity", entity.toJson())
        .putNullable("p_cursor", cursor?.takeIf(String::isNotBlank))
        .put("p_limit", limit.coerceIn(1, 100))

    private fun createLegacyQueryPayload(
        userId: String,
        query: CanonicalDashboardQuery
    ): JSONObject = JSONObject()
        .put("p_user", userId)
        .put("p_range", query.range)
        .putNullable("p_machine", query.machines.singleOrNull())
        .putNullable("p_tool", query.tools.singleOrNull())
        .putNullable("p_model", query.models.singleOrNull())
        .put("p_timezone", query.timezone)

    private fun createLegacyDetailsPayload(
        userId: String,
        query: CanonicalDashboardQuery,
        cursor: String?,
        limit: Int = DETAILS_PAGE_SIZE
    ): JSONObject = createLegacyQueryPayload(userId, query)
        .putNullable("p_cursor", cursor?.takeIf(String::isNotBlank))
        .put("p_limit", limit.coerceIn(1, 100))

    private fun createLegacyEntityPayload(
        userId: String,
        query: CanonicalDashboardQuery,
        entity: DashboardEntity
    ): JSONObject {
        val tool = if (entity.kind == DashboardEntity.TOOL) entity.id else query.tools.singleOrNull()
        val model = entity.id.takeIf { entity.kind == DashboardEntity.MODEL }
        return JSONObject()
            .put("p_user", userId)
            .put("p_range", query.range)
            .putNullable("p_machine", query.machines.singleOrNull())
            .putNullable("p_tool", tool)
            .putNullable("p_model", model)
            .put("p_timezone", query.timezone)
    }

    private fun parseSession(raw: String): MobileSession {
        val root = JSONObject(raw)
        val user = root.optJSONObject("user") ?: JSONObject()
        val expiresIn = root.longValue("expires_in").takeIf { it > 0 } ?: 3600L
        return MobileSession(
            accessToken = root.optString("access_token"),
            refreshToken = root.optString("refresh_token"),
            userId = user.optString("id"),
            email = user.optString("email"),
            expiresAtEpochSeconds = epochSeconds() + expiresIn
        )
    }

    private fun request(
        path: String,
        method: String,
        bearerToken: String? = null,
        body: JSONObject? = null,
        maxResponseBytes: Int? = null
    ): String {
        require(baseUrl.isNotBlank()) { "Supabase URL is missing" }
        require(publishableKey.isNotBlank()) { "Supabase publishable key is missing" }

        val connection = (URL("$baseUrl$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 30_000
            setRequestProperty("apikey", publishableKey)
            setRequestProperty("Accept", "application/json")
            bearerToken?.let { setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
        }

        if (body != null) {
            connection.outputStream.use { stream ->
                stream.write(body.toString().toByteArray(Charsets.UTF_8))
            }
        }

        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val responseLimit = if (status in 200..299) {
            maxResponseBytes
        } else {
            maxResponseBytes?.coerceAtMost(SUPABASE_ERROR_MAX_RESPONSE_BYTES)
                ?: SUPABASE_ERROR_MAX_RESPONSE_BYTES
        }
        val response = try {
            stream?.use { input ->
                if (responseLimit == null) {
                    input.bufferedReader(Charsets.UTF_8).use { it.readText() }
                } else {
                    readUtf8ResponseBounded(input, responseLimit)
                }
            }.orEmpty()
        } catch (error: SupabaseResponseTooLargeException) {
            if (status !in 200..299) {
                throw SupabaseHttpException(
                    status = status,
                    code = null,
                    detail = "response_body_too_large",
                    displayMessage = "Supabase request failed ($status): response body too large"
                )
            }
            throw error
        } finally {
            connection.disconnect()
        }

        if (status !in 200..299) {
            throw readSupabaseError(status, response)
        }

        return response
    }

    private fun readSupabaseError(status: Int, response: String): SupabaseHttpException {
        val parsed = runCatching { JSONObject(response) }.getOrNull()
        val code = parsed?.optNullableString("code")
        val message = parsed?.optNullableString("msg")
            ?: parsed?.optNullableString("message")
            ?: parsed?.optNullableString("error_description")
            ?: parsed?.optNullableString("hint")
            ?: response.takeIf { it.isNotBlank() }
            ?: "HTTP $status"
        return SupabaseHttpException(
            status = status,
            code = code,
            detail = response,
            displayMessage = "Supabase request failed ($status): $message"
        )
    }
}

private data class OptionalRpc(
    val available: Boolean,
    val raw: String?,
    val usedV2: Boolean
)

private data class BaseRpcResult(
    val stats: StatsData,
    val usedV2: Boolean
)

private data class DashboardRpcBundle(
    val base: BaseRpcResult,
    val comparison: OptionalRpc,
    val details: OptionalRpc
)

class DashboardCapabilityException(message: String) : IllegalStateException(message)

/**
 * PostgREST serializes a SQL NULL result as the literal JSON `null`. Comparison RPCs use that
 * value intentionally for ranges without a meaningful automatic baseline (year/all); every
 * object-shaped Stats v2 response still rejects blank or null envelopes.
 */
internal fun normalizeRpcObjectEnvelope(
    functionName: String,
    raw: String,
    allowNullEnvelope: Boolean
): String? {
    val normalized = raw.trim()
    if (normalized == "null" && allowNullEnvelope) return null
    if (normalized.isEmpty() || normalized == "null") {
        throw DashboardQueryContractException("$functionName returned an empty v2 envelope")
    }
    return raw
}

private fun JSONObject.putNullable(key: String, value: String?): JSONObject =
    put(key, value ?: JSONObject.NULL)

private fun CanonicalDashboardQuery.canFallbackMainDashboard(): Boolean =
    range != RangeKey.Custom.rpcValue &&
        machines.size <= 1 && tools.isEmpty() && models.isEmpty() && search == null

private fun CanonicalDashboardQuery.canFallbackComparison(): Boolean =
    range != RangeKey.Custom.rpcValue &&
        machines.size <= 1 && tools.size <= 1 && models.size <= 1 && search == null

private fun CanonicalDashboardQuery.canFallbackDetails(): Boolean = canFallbackComparison()

private fun CanonicalDashboardQuery.canFallbackEntity(entity: DashboardEntity): Boolean = when (entity.kind) {
    DashboardEntity.MODEL -> range != RangeKey.Custom.rpcValue &&
        machines.size <= 1 && tools.size <= 1 && models.isEmpty() && search == null
    DashboardEntity.TOOL -> range != RangeKey.Custom.rpcValue &&
        machines.size <= 1 && tools.isEmpty() && models.isEmpty() && search == null
    else -> false
}

private fun CanonicalDashboardQuery.toStatsQueryEcho(): StatsQueryEcho = StatsQueryEcho(
    range = range,
    timezone = timezone,
    machine = machines.singleOrNull(),
    tool = tools.singleOrNull(),
    model = models.singleOrNull(),
    tokenMode = tokenMode,
    machines = machines,
    tools = tools,
    models = models,
    search = search,
    start = start,
    end = end
)

private fun CompositionEntry.provenCacheSplit(): Pair<Long, Long>? {
    val read = cacheReadTokens ?: return null
    val write = cacheWriteTokens ?: return null
    if (cachedTokens < 0L || read < 0L || write < 0L) return null
    val total = runCatching { Math.addExact(read, write) }.getOrNull() ?: return null
    return if (total == cachedTokens) read to write else null
}

private fun CompositionEntry.toToolStat(): ToolStat {
    val split = provenCacheSplit()
    return ToolStat(
        name = value,
        input = inputTokens,
        output = outputTokens,
        cached = cachedTokens,
        total = tokens,
        cost = cost ?: 0.0,
        requests = requests,
        cacheRead = split?.first,
        cacheWrite = split?.second
    )
}

internal fun CompositionEntry.toModelStat(): ModelStat {
    val split = provenCacheSplit()
    return ModelStat(
        name = value,
        total = tokens,
        requests = requests,
        input = inputTokens,
        output = outputTokens,
        cached = cachedTokens,
        cost = cost,
        cacheRead = split?.first,
        cacheWrite = split?.second
    )
}

private const val DETAILS_PAGE_SIZE = 20
private const val QUOTA_RPC_MAX_RESPONSE_BYTES = 128 * 1_024
internal const val QUOTA_READ_V3_FUNCTION = "get_quota_snapshots_v3"
internal const val QUOTA_READ_V2_FUNCTION = "get_quota_snapshots_v2"
/** 契约 routing-snapshot-v1：最多 8 份快照，每份不超过 16 KB，再留出外层与转义的余量。 */
private const val ROUTING_SNAPSHOTS_MAX_RESPONSE_BYTES = 256 * 1_024
internal const val ROUTING_SNAPSHOTS_READ_FUNCTION = "get_routing_snapshots_v1"
// 两年按小时分桶再加按日 × 模型，留足余量；超出按读取失败处理。
private const val ACTIVITY_RHYTHM_MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024
internal const val ACTIVITY_RHYTHM_READ_FUNCTION = "get_activity_rhythm_v1"
internal const val BUDGET_SNAPSHOTS_READ_FUNCTION = "get_budget_snapshots_v1"
private const val BUDGET_SNAPSHOTS_MAX_RESPONSE_BYTES = 128 * 1_024
private const val SUPABASE_ERROR_MAX_RESPONSE_BYTES = 128 * 1_024

internal class SupabaseResponseTooLargeException(maxBytes: Int) :
    IllegalStateException("Supabase response exceeded $maxBytes bytes")

internal fun readUtf8ResponseBounded(input: InputStream, maxBytes: Int): String {
    require(maxBytes > 0) { "maxBytes must be positive" }
    val output = ByteArrayOutputStream(minOf(maxBytes, 8 * 1_024))
    val buffer = ByteArray(8 * 1_024)
    var total = 0
    while (true) {
        if (Thread.currentThread().isInterrupted) {
            throw InterruptedException("Network response read interrupted")
        }
        val count = input.read(buffer)
        if (count < 0) break
        if (count == 0) continue
        if (total > maxBytes - count) {
            throw SupabaseResponseTooLargeException(maxBytes)
        }
        output.write(buffer, 0, count)
        total += count
    }
    return output.toString(Charsets.UTF_8.name())
}

class SupabaseHttpException(
    val status: Int,
    val code: String?,
    val detail: String,
    displayMessage: String
) : IllegalStateException(displayMessage)

fun SupabaseHttpException.isMissingRpcSignature(functionName: String): Boolean =
    status == 404 &&
        (
            code == "PGRST202" ||
                detail.contains("Could not find the function", ignoreCase = true) ||
                detail.contains("schema cache", ignoreCase = true)
            ) &&
        detail.contains(functionName, ignoreCase = true)

internal fun SupabaseHttpException.isLegacyCustomRangeRejection(): Boolean =
    status == 400 &&
        code == "22023" &&
        detail.contains("query-v2:", ignoreCase = true) &&
        detail.contains("invalid range custom", ignoreCase = true)

fun epochSeconds(): Long = System.currentTimeMillis() / 1000L
