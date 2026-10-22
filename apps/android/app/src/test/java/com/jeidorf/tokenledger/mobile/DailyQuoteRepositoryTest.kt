package com.jeidorf.tokenledger.mobile

import java.time.LocalDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class DailyQuoteRepositoryTest {
    @Test
    fun `same date uses one remote request and persisted quote`() = runTest {
        val date = LocalDate.of(2026, 7, 17)
        val store = MemoryDailyQuoteStore()
        var requests = 0
        val online = DailyQuote("行到水穷处，坐看云起时。", "王维 · 《终南别业》", DailyQuoteOrigin.Hitokoto)
        val repository = DailyQuoteRepository(
            store = store,
            remote = DailyQuoteRemoteSource {
                requests += 1
                online
            },
            dispatcher = Dispatchers.Unconfined
        )

        val values = listOf(
            async { repository.quoteFor(date) },
            async { repository.quoteFor(date) }
        ).awaitAll()

        assertEquals(listOf(online, online), values)
        assertEquals(1, requests)
        assertEquals(online, store.load(date))
    }

    @Test
    fun `network failure is cached as deterministic local fallback for the day`() = runTest {
        val date = LocalDate.of(2026, 7, 17)
        val store = MemoryDailyQuoteStore()
        var requests = 0
        val repository = DailyQuoteRepository(
            store = store,
            remote = DailyQuoteRemoteSource {
                requests += 1
                error("offline")
            },
            dispatcher = Dispatchers.Unconfined
        )

        val first = repository.quoteFor(date)
        val second = repository.quoteFor(date)

        assertEquals(dailyQuoteFor(date), first)
        assertEquals(first, second)
        assertEquals(1, requests)
    }

    @Test
    fun `next date makes exactly one new request`() = runTest {
        val firstDate = LocalDate.of(2026, 7, 17)
        val store = MemoryDailyQuoteStore()
        var requests = 0
        val repository = DailyQuoteRepository(
            store = store,
            remote = DailyQuoteRemoteSource {
                requests += 1
                DailyQuote("日日行，不怕千万里。", "金缨", DailyQuoteOrigin.Hitokoto)
            },
            dispatcher = Dispatchers.Unconfined
        )

        repository.quoteFor(firstDate)
        repository.quoteFor(firstDate.plusDays(1))

        assertEquals(2, requests)
    }
}

private class MemoryDailyQuoteStore : DailyQuoteStore {
    private var entry: Pair<LocalDate, DailyQuote>? = null

    override fun load(date: LocalDate): DailyQuote? = entry
        ?.takeIf { it.first == date }
        ?.second

    override fun save(date: LocalDate, quote: DailyQuote): Boolean {
        entry = date to quote
        return true
    }
}
