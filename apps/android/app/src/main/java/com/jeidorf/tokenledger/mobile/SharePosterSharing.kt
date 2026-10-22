package com.jeidorf.tokenledger.mobile

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.net.Uri
import android.view.Display
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import kotlin.math.roundToInt

internal data class PosterShareIntentSpec(
    val action: String,
    val mimeType: String,
    val contentUri: String,
    val flags: Int,
    val extraText: String?
)

internal data class PosterSharePayload(
    val file: File,
    val uri: Uri,
    val intent: Intent
)

internal fun sharePosterFailureMessage(error: Throwable): String = when (error) {
    is ActivityNotFoundException ->
        "暂时没有可用的分享应用，请安装或启用一个支持图片分享的应用后重试。"
    is SecurityException ->
        "系统暂时拒绝了图片分享授权，请返回后重试。"
    else ->
        "图片生成失败，请保留当前选择后重试。"
}

internal fun resolveShareExportDimensions(
    runtimeWidth: Int,
    runtimeHeight: Int,
    physicalWidth: Int? = null,
    physicalHeight: Int? = null
): Pair<Int, Int> {
    fun validSize(width: Int?, height: Int?): Pair<Int, Int>? =
        if (width != null && height != null && width > 0 && height > 0) width to height else null

    val runtime = validSize(runtimeWidth, runtimeHeight)
    val physical = validSize(physicalWidth, physicalHeight)
    val candidate = listOfNotNull(runtime, physical)
        .maxByOrNull { (width, height) -> width.toLong() * height.toLong() }
        ?: (SharePosterRenderer.POSTER_WIDTH to SharePosterRenderer.POSTER_HEIGHT)

    val landscape = runtime?.let { (width, height) -> width > height }
        ?: (candidate.first > candidate.second)
    val shortSide = minOf(candidate.first, candidate.second)
    val longSide = maxOf(candidate.first, candidate.second)
    val oriented = if (landscape) longSide to shortSide else shortSide to longSide
    val minimumWidth = if (landscape) SharePosterRenderer.POSTER_HEIGHT else SharePosterRenderer.POSTER_WIDTH
    val minimumHeight = if (landscape) SharePosterRenderer.POSTER_WIDTH else SharePosterRenderer.POSTER_HEIGHT
    val scale = maxOf(
        1f,
        minimumWidth / oriented.first.toFloat(),
        minimumHeight / oriented.second.toFloat()
    )
    return (oriented.first * scale).roundToInt() to (oriented.second * scale).roundToInt()
}

/** 实际导出比例，用于让面板说明与设备物理像素输出一致。 */
internal fun shareExportAspectLabel(width: Int, height: Int): String {
    require(width > 0 && height > 0) { "Poster dimensions must be positive" }
    fun gcd(left: Int, right: Int): Int {
        var a = left
        var b = right
        while (b != 0) {
            val remainder = a % b
            a = b
            b = remainder
        }
        return a
    }
    val divisor = gcd(width, height)
    return "${width / divisor}:${height / divisor}"
}

internal object SharePosterFileStore {
    const val RELATIVE_CACHE_DIRECTORY = "share-posters"
    const val MIME_TYPE = "image/png"
    const val MAX_RETAINED_FILES = 8
    const val MAX_FILE_AGE_MILLIS = 24L * 60L * 60L * 1_000L

    fun targetExportDimensions(context: Context): Pair<Int, Int> {
        val metrics = context.resources.displayMetrics
        val display = context.getSystemService(DisplayManager::class.java)
            ?.getDisplay(Display.DEFAULT_DISPLAY)
        val physicalMode = display?.supportedModes
            ?.maxByOrNull { mode -> mode.physicalWidth.toLong() * mode.physicalHeight.toLong() }
            ?: display?.mode
        return resolveShareExportDimensions(
            runtimeWidth = metrics.widthPixels,
            runtimeHeight = metrics.heightPixels,
            physicalWidth = physicalMode?.physicalWidth,
            physicalHeight = physicalMode?.physicalHeight
        )
    }

    fun createSharePayload(
        context: Context,
        summary: ShareSummary,
        layout: ShareLayoutKey,
        nowMillis: Long = System.currentTimeMillis()
    ): PosterSharePayload {
        val directory = File(context.cacheDir, RELATIVE_CACHE_DIRECTORY)
        check(directory.exists() || directory.mkdirs()) { "Unable to create private poster cache" }
        cleanup(directory, nowMillis)
        val safeName = "tokenledger-${summary.range.rpcValue}-${layout.stableKey}-$nowMillis.png"
        val finalFile = File(directory, safeName)
        val temporaryFile = File(directory, ".$safeName.tmp")
        val (exportWidth, exportHeight) = targetExportDimensions(context)
        val bitmap = SharePosterRenderer.render(context, summary, layout, width = exportWidth, height = exportHeight)
        try {
            FileOutputStream(temporaryFile).use { output ->
                check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output)) {
                    "Unable to encode share poster"
                }
                output.fd.sync()
            }
            check(temporaryFile.renameTo(finalFile)) { "Unable to finalize share poster" }
        } finally {
            bitmap.recycle()
            if (temporaryFile.exists()) temporaryFile.delete()
        }
        check(finalFile.isFile && finalFile.length() > 0L) { "Share poster file is empty" }
        cleanup(directory, nowMillis, protectedFile = finalFile)
        val authority = "${context.packageName}.fileprovider"
        val uri = FileProvider.getUriForFile(context, authority, finalFile)
        val intent = buildPosterShareIntent(uri, summary.shareCaption)
        return PosterSharePayload(finalFile, uri, intent)
    }

    fun intentSpec(contentUri: String, extraText: String?): PosterShareIntentSpec {
        require(contentUri.startsWith("content://")) { "Only content:// share URIs are allowed" }
        return PosterShareIntentSpec(
            action = Intent.ACTION_SEND,
            mimeType = MIME_TYPE,
            contentUri = contentUri,
            flags = Intent.FLAG_GRANT_READ_URI_PERMISSION,
            extraText = extraText?.take(240)?.takeIf(String::isNotBlank)
        )
    }

    fun buildPosterShareIntent(uri: Uri, extraText: String?): Intent {
        val spec = intentSpec(uri.toString(), extraText)
        return Intent(spec.action).apply {
            type = spec.mimeType
            putExtra(Intent.EXTRA_STREAM, uri)
            spec.extraText?.let { putExtra(Intent.EXTRA_TEXT, it) }
            clipData = ClipData.newRawUri("TokenLedger 周期总结", uri)
            addFlags(spec.flags)
        }
    }

    internal fun cleanup(directory: File, nowMillis: Long, protectedFile: File? = null) {
        val files = directory.listFiles()
            .orEmpty()
            .filter { it.isFile && it.extension.equals("png", ignoreCase = true) }
            .sortedByDescending(File::lastModified)
        files.forEachIndexed { index, file ->
            if (file == protectedFile) return@forEachIndexed
            val expired = nowMillis - file.lastModified() > MAX_FILE_AGE_MILLIS
            val overBudget = index >= MAX_RETAINED_FILES
            if (expired || overBudget) file.delete()
        }
    }
}
