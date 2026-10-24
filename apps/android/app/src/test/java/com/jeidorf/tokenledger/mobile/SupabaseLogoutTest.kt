package com.jeidorf.tokenledger.mobile

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SupabaseLogoutTest {
    private data class Seen(val method: String, val pathAndQuery: String, val bearer: String?, val apikey: String?, val body: String)

    private val seen = Collections.synchronizedList(mutableListOf<Seen>())
    private var respond: (Seen) -> Pair<Int, String> = { 204 to "" }
    // android.jar has no JDK HTTP server, so a minimal one-request-per-connection loop stands in.
    private val server = ServerSocket(0, 8, InetAddress.getLoopbackAddress())
    private val worker = thread(isDaemon = true) {
        while (!server.isClosed) {
            val socket = try { server.accept() } catch (_: Exception) { break }
            socket.use(::handle)
        }
    }
    private val gateway = SupabaseGateway("http://127.0.0.1:${server.localPort}", "sb_publishable_test")
    private val session = MobileSession(
        accessToken = "access-1",
        refreshToken = "refresh-1",
        userId = "user-a",
        email = "a@example.com",
        expiresAtEpochSeconds = 1_750_000_000L
    )

    @After
    fun tearDown() {
        server.close()
        worker.join(1_000)
    }

    private fun handle(socket: Socket) {
        val input = BufferedInputStream(socket.getInputStream())
        val requestLine = readLine(input)
        val headers = generateSequence { readLine(input).takeIf(String::isNotEmpty) }
            .map { it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim() }
            .toMap()
        val length = headers["content-length"]?.toInt() ?: 0
        val body = ByteArray(length).also { var read = 0; while (read < length) read += input.read(it, read, length - read) }
        val request = Seen(
            method = requestLine.substringBefore(' '),
            pathAndQuery = requestLine.substringAfter(' ').substringBefore(' '),
            bearer = headers["authorization"],
            apikey = headers["apikey"],
            body = body.toString(Charsets.UTF_8)
        )
        seen += request
        val (status, responseBody) = respond(request)
        val bytes = responseBody.toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 $status X\r\nContent-Type: application/json\r\n" +
            (if (status == 204) "" else "Content-Length: ${bytes.size}\r\n") +
            "Connection: close\r\n\r\n"
        socket.getOutputStream().apply {
            write(head.toByteArray(Charsets.US_ASCII))
            if (status != 204) write(bytes)
            flush()
        }
    }

    private fun readLine(input: InputStream): String {
        val line = ByteArrayOutputStream()
        while (true) {
            val next = input.read()
            if (next == -1 || next == '\n'.code) break
            if (next != '\r'.code) line.write(next)
        }
        return line.toString(Charsets.US_ASCII.name())
    }

    @Test
    fun logoutEndsOnlyThisDeviceSessionWithTheAccessToken() = runBlocking {
        gateway.revokeSession(session)

        assertEquals(1, seen.size)
        val call = seen.single()
        assertEquals("POST", call.method)
        // Global scope would also sign the desktop out; only this device's session may end.
        assertEquals("/auth/v1/logout?scope=local", call.pathAndQuery)
        assertEquals("Bearer access-1", call.bearer)
        assertEquals("sb_publishable_test", call.apikey)
    }

    @Test
    fun expiredAccessTokenIsRefreshedOnceThenLoggedOut() = runBlocking {
        respond = { call ->
            when {
                call.pathAndQuery.startsWith("/auth/v1/token") ->
                    200 to """{"access_token":"access-2","refresh_token":"refresh-2","expires_in":3600,"user":{"id":"user-a"}}"""
                call.bearer == "Bearer access-1" -> 401 to """{"code":"bad_jwt","msg":"token is expired"}"""
                else -> 204 to ""
            }
        }

        gateway.revokeSession(session)

        assertEquals(
            listOf(
                "/auth/v1/logout?scope=local",
                "/auth/v1/token?grant_type=refresh_token",
                "/auth/v1/logout?scope=local"
            ),
            seen.map { it.pathAndQuery }
        )
        assertEquals("""{"refresh_token":"refresh-1"}""", seen[1].body)
        assertEquals("Bearer access-2", seen[2].bearer)
    }

    @Test
    fun serverErrorsSurfaceToTheCallerWithoutRetry() {
        respond = { 500 to """{"msg":"unavailable"}""" }

        val error = assertThrows(SupabaseHttpException::class.java) {
            runBlocking { gateway.revokeSession(session) }
        }

        assertEquals(500, error.status)
        assertEquals(1, seen.size)
    }

    @Test
    fun revokedRefreshTokenSurfacesAsAuthError() {
        respond = { call ->
            if (call.pathAndQuery.startsWith("/auth/v1/token")) {
                400 to """{"code":"refresh_token_not_found","msg":"Invalid Refresh Token"}"""
            } else {
                401 to """{"code":"bad_jwt","msg":"token is expired"}"""
            }
        }

        val error = assertThrows(SupabaseHttpException::class.java) {
            runBlocking { gateway.revokeSession(session) }
        }

        assertEquals(400, error.status)
        assertEquals(2, seen.size)
    }
}
