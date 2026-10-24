package com.jeidorf.tokenledger.mobile.dimensions

import com.jeidorf.tokenledger.mobile.MobileSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DimensionsSessionReaderTest {
    private val dimensions = UsageDimensionsJson.parse("""
        {"meta":{"source":"cloud","start":"2026-10-24","end":"2026-10-24","timezone":"Asia/Shanghai","retentionDays":90,"coverageStart":"2026-07-26"},
         "sessions":{"state":"empty"},"providers":{"state":"empty"},"contextComposition":{"state":"empty"}}
    """.trimIndent())

    private fun session(userId: String = "user-a") =
        MobileSession("access", "refresh", userId, "test@example.com", Long.MAX_VALUE)

    @Test
    fun accountMismatchFailsBeforeNetworkRead() = runTest {
        var rpcCalls = 0
        val reader = DimensionsSessionReader(DimensionsReaderBackend { onAccount, _ ->
            onAccount("user-b")
            rpcCalls++
            dimensions
        })
        val error = runCatching { reader.read("user-a") { dimensions } }.exceptionOrNull()
        assertTrue(error is DimensionsAccountChangedException)
        assertEquals(0, rpcCalls)
    }

    @Test
    fun lateResultAfterCancellationDoesNotReachCommit() = runTest {
        val entered = CompletableDeferred<Unit>()
        val response = CompletableDeferred<UsageDimensions>()
        var committed = false
        val reader = DimensionsSessionReader(DimensionsReaderBackend { onAccount, _ ->
            onAccount("user-a")
            withContext(NonCancellable) {
                entered.complete(Unit)
                response.await()
            }
        })
        val job = launch {
            reader.readForUi("user-a") { dimensions }
            committed = true
        }
        entered.await()
        job.cancel()
        response.complete(dimensions)
        job.join()
        assertFalse(committed)
    }

    @Test
    fun signedOutFailsUiReadWithoutRpc() = runTest {
        var rpcCalls = 0
        val reader = DimensionsSessionReader(DimensionsReaderBackend { _, _ -> null })
        val error = runCatching {
            reader.readForUi("user-a") { rpcCalls++; dimensions }
        }.exceptionOrNull()
        assertTrue(error is DimensionsSignedOutException)
        assertEquals(0, rpcCalls)
    }

    @Test
    fun cancellationPropagatesWithoutConvertingToEmpty() = runTest {
        val reader = DimensionsSessionReader(DimensionsReaderBackend { onAccount, _ ->
            onAccount("user-a")
            throw CancellationException("query changed")
        })
        val error = runCatching { reader.readForUi("user-a") { dimensions } }.exceptionOrNull()
        assertTrue(error is CancellationException)
    }

    @Test
    fun forwardsTheFreshStoredSessionToTheSource() = runTest {
        val fresh = session().copy(accessToken = "fresh-access")
        var received: MobileSession? = null
        val reader = DimensionsSessionReader(DimensionsReaderBackend { onAccount, read ->
            onAccount("user-a")
            read(fresh)
        })
        val result = reader.readForUi("user-a") { current ->
            received = current
            dimensions
        }
        assertTrue(result === dimensions)
        assertEquals(fresh, received)
    }

}
