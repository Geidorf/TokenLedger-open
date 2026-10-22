package com.jeidorf.tokenledger.mobile.ui.charts

import android.content.Context
import com.jeidorf.tokenledger.mobile.CurrencyUnit
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatMoney
import com.jeidorf.tokenledger.mobile.ui.foundation.v2FormatPercent
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Share

/**
 * Common formatting helpers for canvas chart renderers, axis labels, and tooltip popups.
 */
internal object ChartFormatters {
    fun formatMoney(context: Context, value: Double, masked: Boolean, currency: CurrencyUnit): String =
        v2FormatMoney(context, value, masked, currency)

    fun formatPercent(value: Double?): String = v2FormatPercent(value)

    fun formatShare(value: Long, total: Long): String = v2Share(value, total)
}
