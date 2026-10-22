package com.jeidorf.tokenledger.mobile

internal interface QuotaDataSource {
    suspend fun fetchQuotaSnapshots(session: MobileSession): QuotaTransportSnapshot
}

internal class QuotaRepository : QuotaDataSource {
    private val gateway = SupabaseGateway(
        supabaseUrl = BuildConfig.TOKENLEDGER_SUPABASE_URL,
        publishableKey = BuildConfig.TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY
    )

    override suspend fun fetchQuotaSnapshots(session: MobileSession): QuotaTransportSnapshot =
        gateway.fetchQuotaSnapshots(session)
}

internal object DisabledQuotaDataSource : QuotaDataSource {
    override suspend fun fetchQuotaSnapshots(session: MobileSession): QuotaTransportSnapshot {
        throw QuotaSyncUnavailableException("quota_sync_not_configured")
    }
}

internal class QuotaSyncUnavailableException(
    val reasonCode: String,
    cause: Throwable? = null
) : IllegalStateException("Quota sync unavailable: $reasonCode", cause)
