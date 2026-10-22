package com.jeidorf.tokenledger.mobile

import java.time.LocalDate
import org.json.JSONObject

data class DailyQuote(
    val text: String,
    val source: String,
    val origin: DailyQuoteOrigin = DailyQuoteOrigin.Local
)

enum class DailyQuoteOrigin(val storedValue: String) {
    Local("local"),
    Hitokoto("hitokoto");

    companion object {
        fun fromStored(value: String?): DailyQuoteOrigin =
            entries.firstOrNull { it.storedValue == value } ?: Local
    }
}

data class DailyQuoteSnapshot(
    val date: LocalDate,
    val quote: DailyQuote
)

private val dailyQuotes = listOf(
    DailyQuote("知之者不如好之者，好之者不如乐之者。", "《论语》"),
    DailyQuote("不积跬步，无以至千里。", "《荀子》"),
    DailyQuote("凡事预则立，不预则废。", "《礼记》"),
    DailyQuote("胜人者有力，自胜者强。", "《道德经》"),
    DailyQuote("博观而约取，厚积而薄发。", "苏轼"),
    DailyQuote("纸上得来终觉浅，绝知此事要躬行。", "陆游"),
    DailyQuote("路漫漫其修远兮，吾将上下而求索。", "屈原"),
    DailyQuote("千里之行，始于足下。", "《道德经》"),
    DailyQuote("苟日新，日日新，又日新。", "《礼记·大学》"),
    DailyQuote("欲穷千里目，更上一层楼。", "王之涣"),
    DailyQuote("山重水复疑无路，柳暗花明又一村。", "陆游"),
    DailyQuote("锲而不舍，金石可镂。", "《荀子》")
)

internal fun dailyQuoteFor(date: LocalDate): DailyQuote =
    dailyQuotes[Math.floorMod(date.toEpochDay(), dailyQuotes.size.toLong()).toInt()]

internal fun parseHitokotoDailyQuote(raw: String): DailyQuote? = runCatching {
    val root = JSONObject(raw)
    val text = root.optString("hitokoto")
        .normalizeDailyQuoteField(MAX_DAILY_QUOTE_TEXT_LENGTH)
        ?.takeIf { it.length >= MIN_DAILY_QUOTE_TEXT_LENGTH }
        ?: return@runCatching null
    val work = root.optString("from")
        .normalizeDailyQuoteField(MAX_DAILY_QUOTE_SOURCE_LENGTH)
    val author = root.optString("from_who")
        .normalizeDailyQuoteField(MAX_DAILY_QUOTE_SOURCE_LENGTH)
    val source = buildDailyQuoteSource(author, work)
    DailyQuote(text = text, source = source, origin = DailyQuoteOrigin.Hitokoto)
}.getOrNull()

internal fun validateCachedDailyQuote(
    text: String?,
    source: String?,
    origin: String?
): DailyQuote? {
    val normalizedText = text
        ?.normalizeDailyQuoteField(MAX_DAILY_QUOTE_TEXT_LENGTH)
        ?.takeIf { it.length >= MIN_DAILY_QUOTE_TEXT_LENGTH }
        ?: return null
    val normalizedSource = normalizeCachedDailyQuoteSource(source)
        ?: return null
    return DailyQuote(
        text = normalizedText,
        source = normalizedSource,
        origin = DailyQuoteOrigin.fromStored(origin)
    )
}

/**
 * 旧版本已经可能把 `from_who = null` 合成为 `null · 《作品》` 后写入缓存。
 * 新响应解析拒绝单个占位符还不够，升级时必须逐段清理历史合并值。
 */
private fun normalizeCachedDailyQuoteSource(source: String?): String? =
    source
        ?.normalizeDailyQuoteField(MAX_DAILY_QUOTE_SOURCE_LENGTH)
        ?.replace(
            Regex("^(null|undefined)\\s*·\\s*", RegexOption.IGNORE_CASE),
            ""
        )
        ?.replace(
            Regex("\\s*·\\s*(null|undefined)$", RegexOption.IGNORE_CASE),
            ""
        )
        ?.trim()
        ?.takeIf(String::isNotEmpty)

private fun buildDailyQuoteSource(author: String?, work: String?): String {
    val workLabel = work?.let {
        if (it.startsWith('《') && it.endsWith('》')) it else "《$it》"
    }
    return listOfNotNull(author, workLabel)
        .distinct()
        .joinToString(" · ")
        .ifBlank { "一言" }
}

private fun String.normalizeDailyQuoteField(maxLength: Int): String? {
    val normalized = replace(Regex("\\s+"), " ").trim()
    return normalized.takeIf {
        it.isNotEmpty() &&
            it.length <= maxLength &&
            !it.isDailyQuotePlaceholder()
    }
}

private fun String.isDailyQuotePlaceholder(): Boolean =
    equals("null", ignoreCase = true) || equals("undefined", ignoreCase = true)

internal const val MIN_DAILY_QUOTE_TEXT_LENGTH = 4
internal const val MAX_DAILY_QUOTE_TEXT_LENGTH = 40
internal const val MAX_DAILY_QUOTE_SOURCE_LENGTH = 64
