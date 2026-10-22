package com.jeidorf.tokenledger.mobile

import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Build
import android.view.Display

internal data class AndroidDisplayIdentity(
    val buildSignals: List<String>,
    val featureNames: Set<String>,
    val refreshRateHz: Float?
)

private val explicitEInkTokens = listOf(
    "eink",
    "e-ink",
    "epd",
    "ereader",
    "e-reader",
    "readerpro",
    "mireader",
    "duokan",
    "boox",
    "onyx",
    "paperwhite",
    "remarkable",
    "supernote",
    "inkpalm",
    "inkpad"
)

/**
 * Android does not expose one canonical E-ink capability. Prefer explicit vendor feature/build
 * signals and use a low refresh rate only as supporting evidence for generic "reader" models.
 */
internal fun isLikelyEInkDisplay(identity: AndroidDisplayIdentity): Boolean {
    val buildText = identity.buildSignals.joinToString(" ").lowercase()
    val featureText = identity.featureNames.joinToString(" ").lowercase()
    val hasExplicitSignal = explicitEInkTokens.any { token ->
        token in buildText || token in featureText
    }
    val lowRefreshReader = identity.refreshRateHz
        ?.let { it in 1f..24f }
        ?.and("reader" in buildText)
        ?: false
    return hasExplicitSignal || lowRefreshReader
}

internal fun readAndroidDisplayIdentity(context: Context): AndroidDisplayIdentity {
    val displayManager = context.getSystemService(DisplayManager::class.java)
    val refreshRate = displayManager
        ?.getDisplay(Display.DEFAULT_DISPLAY)
        ?.refreshRate
        ?.takeIf { it.isFinite() && it > 0f }
    return AndroidDisplayIdentity(
        buildSignals = listOf(
            Build.BRAND,
            Build.MANUFACTURER,
            Build.MODEL,
            Build.PRODUCT,
            Build.DEVICE,
            Build.DISPLAY,
            Build.HARDWARE,
            Build.FINGERPRINT
        ),
        featureNames = context.packageManager.systemAvailableFeatures
            .mapNotNull { it.name }
            .toSet(),
        refreshRateHz = refreshRate
    )
}
