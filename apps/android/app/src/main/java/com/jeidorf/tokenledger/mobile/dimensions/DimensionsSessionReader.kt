package com.jeidorf.tokenledger.mobile.dimensions

import com.jeidorf.tokenledger.mobile.DashboardRepository
import com.jeidorf.tokenledger.mobile.MobileSession
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** 页面期望账号与持久化会话不一致；旧请求因此失效，不再发起 RPC。 */
internal class DimensionsAccountChangedException : IllegalStateException("usage dimensions account changed")

/** readWithStoredSession 返回 null 表示手机已退出；页面不得再保留旧维度。 */
internal class DimensionsSignedOutException : IllegalStateException("usage dimensions signed out")

/** 未登录时显式结束读取，避免将空结果当作已登录账号的数据。 */
internal suspend fun DimensionsSessionReader.readForUi(
    expectedUserId: String,
    read: suspend (MobileSession) -> UsageDimensions
): UsageDimensions {
    val result = read(expectedUserId, read) ?: throw DimensionsSignedOutException()
    currentCoroutineContext().ensureActive()
    return result
}

/** 与 DashboardRepository.readWithStoredSession 同形的可注入边界。 */
internal fun interface DimensionsReaderBackend {
    suspend fun read(
        onAccount: (String) -> Unit,
        read: suspend (MobileSession) -> UsageDimensions
    ): UsageDimensions?
}

/**
 * 生产环境只转发给现有会话权威；账号校验发生在 onAccount，早于任何 RPC。
 */
internal class DimensionsSessionReader(
    private val backend: DimensionsReaderBackend
) {
    suspend fun read(
        expectedUserId: String,
        read: suspend (MobileSession) -> UsageDimensions
    ): UsageDimensions? = backend.read(
        { storedUserId ->
            if (storedUserId != expectedUserId) throw DimensionsAccountChangedException()
        },
        read
    )
}

internal fun dashboardDimensionsSessionReader(
    dashboard: DashboardRepository
): DimensionsSessionReader = DimensionsSessionReader(
    DimensionsReaderBackend { onAccount, read -> dashboard.readWithStoredSession(onAccount, read) }
)
