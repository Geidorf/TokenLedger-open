package com.jeidorf.tokenledger.mobile

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.OffsetDateTime
import java.time.ZoneId

/**
 * A trend point can identify a local calendar day, but the current cloud contract cannot carry
 * an hour-sized range. Keep that boundary explicit: this context only authorizes a day drill.
 */
internal data class TrendDrillContext(
    val date: LocalDate,
    val targetSection: DashboardSection
) {
    companion object {
        fun fromBucket(
            bucket: String,
            originQuery: DashboardQuery,
            referenceDate: LocalDate,
            responseZone: ZoneId,
            targetSection: DashboardSection
        ): TrendDrillContext? {
            val date = parseDatedBucket(bucket, responseZone)
                ?: parseTimeOnlyBucket(bucket)?.let {
                    dateDeterminedBy(originQuery, referenceDate)
                }
                ?: return null
            return TrendDrillContext(date = date, targetSection = targetSection)
        }

        fun dateFromCurrentEnd(value: String?, responseZone: ZoneId): LocalDate? = value?.let {
            parseDatedBucket(it, responseZone)
        }

        fun isWithinCurrentQuery(
            date: LocalDate,
            query: DashboardQuery,
            currentEnd: LocalDate
        ): Boolean {
            if (date.isAfter(currentEnd)) return false
            return when (query.range) {
                RangeKey.Today -> date == currentEnd
                RangeKey.Week -> !date.isBefore(currentEnd.minusDays(currentEnd.dayOfWeek.value - 1L))
                RangeKey.Month -> date.year == currentEnd.year && date.month == currentEnd.month
                RangeKey.Year -> date.year == currentEnd.year
                RangeKey.All -> true
                RangeKey.Custom -> {
                    val start = query.start?.let(::parseDate) ?: return false
                    val end = query.end?.let(::parseDate) ?: return false
                    date in start..minOf(end, currentEnd)
                }
            }
        }

        private fun parseDatedBucket(value: String, responseZone: ZoneId): LocalDate? {
            runCatching { OffsetDateTime.parse(value).atZoneSameInstant(responseZone).toLocalDate() }
                .getOrNull()
                ?.let { return it }
            runCatching { LocalDateTime.parse(value.replaceFirst(' ', 'T')).toLocalDate() }
                .getOrNull()
                ?.let { return it }
            return parseDate(value)
        }

        private fun parseTimeOnlyBucket(value: String): LocalTime? =
            runCatching { LocalTime.parse(value) }.getOrNull()

        private fun dateDeterminedBy(query: DashboardQuery, referenceDate: LocalDate): LocalDate? = when {
            query.range == RangeKey.Today -> referenceDate
            query.range == RangeKey.Custom && query.start == query.end -> query.start?.let(::parseDate)
            else -> null
        }

        private fun parseDate(value: String): LocalDate? = runCatching { LocalDate.parse(value) }.getOrNull()
    }
}
