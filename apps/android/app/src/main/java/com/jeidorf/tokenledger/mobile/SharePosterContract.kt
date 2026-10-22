package com.jeidorf.tokenledger.mobile

import android.graphics.Typeface

internal const val SHARE_POSTER_WIDTH = 1080
internal const val SHARE_POSTER_HEIGHT = 1920
internal const val SHARE_POSTER_PREVIEW_WIDTH = 216
internal const val SHARE_POSTER_PREVIEW_HEIGHT = 384

/**
 * Poster text is intentionally specified in the 1080×1920 coordinate space.  The renderer
 * consumes the same roles for picker thumbnails and exported PNGs, so a device font cannot
 * silently change the share image on a different OEM build.
 */
internal data class ShareTextRole(
    val typeface: Typeface,
    val size: Float,
    val tracking: Float = 0f,
    val lineHeight: Float = 1.18f,
    val baselineShift: Float = 0f
)

/** Pure structural contract: the five selections must never collapse into color-only variants. */
internal fun shareLayoutSignature(layout: ShareLayoutKey): List<String> = when (layout) {
    ShareLayoutKey.Scorecard -> listOf("hero", "lucide-metric-icons", "line-chart", "leaders", "composition", "footer-brand")
    ShareLayoutKey.Journal -> listOf("split-hero", "hand-note", "activity-columns", "three-facts", "leaders", "footer-brand")
    ShareLayoutKey.Achievement -> listOf("giant-streak", "token-panel", "peak-panel", "day-strip", "footer-brand")
    ShareLayoutKey.Receipt -> listOf("receipt-title", "settled-stamp", "hero-total", "ledger-rows", "check-strip", "statement", "footer-brand")
    ShareLayoutKey.Signal -> listOf("signal-ribbon", "giant-hero", "upright-vertical-input-output", "four-facts", "composition-line", "footer-brand")
}
