package com.jeidorf.tokenledger.mobile

import android.content.Context
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal interface DailyQuoteDataSource {
    suspend fun quoteFor(date: LocalDate): DailyQuote
}

internal object LocalDailyQuoteDataSource : DailyQuoteDataSource {
    override suspend fun quoteFor(date: LocalDate): DailyQuote = dailyQuoteFor(date)
}

internal interface DailyQuoteStore {
    fun load(date: LocalDate): DailyQuote?

    fun save(date: LocalDate, quote: DailyQuote): Boolean
}

internal fun interface DailyQuoteRemoteSource {
    fun fetch(): DailyQuote
}

internal class DailyQuoteRepository(
    private val store: DailyQuoteStore,
    private val remote: DailyQuoteRemoteSource,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO
) : DailyQuoteDataSource {
    constructor(context: Context) : this(
        store = SharedPreferencesDailyQuoteStore(context.applicationContext),
        remote = HitokotoDailyQuoteRemoteSource()
    )

    private val mutex = Mutex()

    override suspend fun quoteFor(date: LocalDate): DailyQuote = mutex.withLock {
        withContext(dispatcher) {
            store.load(date)?.let { return@withContext it }
            val quote = runCatching(remote::fetch)
                .getOrNull()
                ?: dailyQuoteFor(date)
            store.save(date, quote)
            quote
        }
    }
}

private class SharedPreferencesDailyQuoteStore(context: Context) : DailyQuoteStore {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun load(date: LocalDate): DailyQuote? {
        if (preferences.getString(KEY_DATE, null) != date.toString()) return null
        return validateCachedDailyQuote(
            text = preferences.getString(KEY_TEXT, null),
            source = preferences.getString(KEY_SOURCE, null),
            origin = preferences.getString(KEY_ORIGIN, null)
        )
    }

    override fun save(date: LocalDate, quote: DailyQuote): Boolean = preferences.edit()
        .putString(KEY_DATE, date.toString())
        .putString(KEY_TEXT, quote.text)
        .putString(KEY_SOURCE, quote.source)
        .putString(KEY_ORIGIN, quote.origin.storedValue)
        .commit()

    private companion object {
        const val PREFERENCES_NAME = "tokenledger_daily_quote"
        const val KEY_DATE = "date"
        const val KEY_TEXT = "text"
        const val KEY_SOURCE = "source"
        const val KEY_ORIGIN = "origin"
    }
}

private class HitokotoDailyQuoteRemoteSource : DailyQuoteRemoteSource {
    override fun fetch(): DailyQuote {
        val connection = (URL(ENDPOINT).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = NETWORK_TIMEOUT_MS
            readTimeout = NETWORK_TIMEOUT_MS
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "TokenLedger/${BuildConfig.TOKENLEDGER_APP_VERSION}")
        }
        return try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                throw IOException("Daily quote service returned ${connection.responseCode}")
            }
            if (connection.contentLengthLong > MAX_RESPONSE_BYTES) {
                throw IOException("Daily quote response exceeded the size limit")
            }
            val bytes = connection.inputStream.use { it.readBounded(MAX_RESPONSE_BYTES) }
            parseHitokotoDailyQuote(bytes.toString(Charsets.UTF_8))
                ?: throw IOException("Daily quote response was invalid")
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val ENDPOINT = "https://v1.hitokoto.cn/?c=d&c=i&c=k&encode=json&charset=utf-8&min_length=8&max_length=34"
        const val NETWORK_TIMEOUT_MS = 5_000
        const val MAX_RESPONSE_BYTES = 16 * 1_024
    }
}

private fun InputStream.readBounded(maxBytes: Int): ByteArray {
    val output = ByteArrayOutputStream(minOf(maxBytes, 2 * 1_024))
    val buffer = ByteArray(2 * 1_024)
    var total = 0
    while (true) {
        val count = read(buffer)
        if (count < 0) break
        total += count
        if (total > maxBytes) throw IOException("Daily quote response exceeded the size limit")
        output.write(buffer, 0, count)
    }
    return output.toByteArray()
}
