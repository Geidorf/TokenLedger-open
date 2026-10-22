package com.jeidorf.tokenledger.mobile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Rect
import android.graphics.Shader
import android.graphics.Typeface
import androidx.core.content.res.ResourcesCompat
import androidx.core.graphics.PathParser
import java.io.ByteArrayOutputStream
import kotlin.math.floor

/**
 * 缓存净节省的金额写法（root R-36 P3-2，方案 §3.1；T10.154 A21）：走应用共用的金额格式
 * [formatCurrencyAmount]——千分位、两位小数、不带 ≈；0 < v < ¥0.01 写「<¥0.01」（不会四舍五入成
 * 自相矛盾的「¥0.00」）。呈现门槛已确保这里的净值恒为正。此前这里是不带千分位的 `¥%.2f`。
 *
 * 顶层函数，不是 `SharePosterRenderer` 的成员：Kotlin `object` 的所有非 `lazy` 属性会在对象
 * 第一次被访问时一起初始化，而 `SharePosterRenderer.paint` 在那一刻会真的构造一个
 * `android.graphics.Paint`；离线 JVM 单测用的桩 `android.jar` 没有对应的原生实现，哪怕只是
 * 调用这个和 Paint 无关的纯格式化函数，只要它是该 object 的成员，就会连带触发 `paint` 的
 * 初始化并抛 `UnsatisfiedLinkError`（已实测复现）。放在顶层可以绕开这个初始化，让 JVM 单测
 * 直接验证格式规则。
 */
internal fun formatNetSavedCny(value: Double): String = formatCurrencyAmount(value, CurrencyUnit.CNY)

/** 极简信号光带下段两段直立字的排位：两段首字的顶边、逐字步长与字号（设计坐标）。 */
internal data class SignalLowerRibbonLayout(
    val outputTop: Float,
    val cacheTop: Float,
    val advance: Float,
    val size: Float
)

/**
 * 极简信号光带下段「输出」「缓存」两段直立字怎么排（T10.207）。
 *
 * 两段都放得进原槽位（输出首字顶边 1116、缓存 1302，步长 28、字号 26）时照旧不动。Token 按桌面规则
 * 写成 K 一位小数以后，常见的「输出360.0K」「缓存248.4K」各有 8 个字，照原槽位画会两段相叠、缓存段
 * 越过光带末端压到事实行的分隔线上。放不下时两段同比收紧：输出仍从 1116 起，隔一个空格位再接缓存；
 * 步长取让最后一字底边不越过 1490（事实行分隔线上沿 1495 之上）的最大整数，最多 28，字号 = 步长 − 2。
 * 两段永不相叠，也不越出光带。纯几何、不碰 Paint，放在顶层便于 JVM 单测（理由同 [formatNetSavedCny]）。
 */
internal fun signalLowerRibbonLayout(outputGlyphs: Int, cacheGlyphs: Int): SignalLowerRibbonLayout {
    val top = 1116f
    val slotCacheTop = 1302f
    val bottomLimit = 1490f
    val slotAdvance = 28f
    val slotSize = 26f
    val spacing = slotAdvance - slotSize
    val output = outputGlyphs.coerceAtLeast(1)
    val cache = cacheGlyphs.coerceAtLeast(1)
    val outputBottom = top + (output - 1) * slotAdvance + slotSize
    val cacheBottom = slotCacheTop + (cache - 1) * slotAdvance + slotSize
    if (outputBottom + 20f <= slotCacheTop && cacheBottom <= bottomLimit) {
        return SignalLowerRibbonLayout(top, slotCacheTop, slotAdvance, slotSize)
    }
    // 输出 n1 格 + 空 1 格 + 缓存 n2 格：最后一字底边 = top + (n1 + n2 + 1) × 步长 − spacing。
    val advance = minOf(slotAdvance, floor((bottomLimit - top + spacing) / (output + cache + 1)))
    return SignalLowerRibbonLayout(top, top + (output + 1) * advance, advance, advance - spacing)
}

/** 直立竖排实际画出的字数：与 `uprightVerticalText` 一样跳过空白。 */
internal fun uprightGlyphCount(value: String): Int = value.count { !it.isWhitespace() }

/** 小时桶只保留一次时间标签，避免把 `11:00` 同时画进卡片的两个文字轨道。 */
internal fun isPosterHourPoint(point: SharePoint): Boolean =
    point.weekdayLabel == null && point.dateLabel.contains(':')

/** 回执卡在小时桶中不重复日期标签；按天桶仍保留星期与日期两层信息。 */
internal fun receiptPointLabels(point: SharePoint): Pair<String, String?> =
    if (isPosterHourPoint(point)) point.dateLabel to null else (point.weekdayLabel ?: point.dateLabel) to point.dateLabel

/** 数据海报只展示最近七个桶；曲线、日期和星期必须使用同一组桶。 */
internal fun scorecardTrendPoints(points: List<SharePoint>): List<SharePoint> = points.takeLast(7)

/** 数据海报趋势点和标签共用的横坐标，留出首尾居中标签的安全边距。 */
internal fun scorecardTrendXPositions(
    count: Int,
    left: Float = 84f,
    right: Float = 996f
): List<Float> {
    if (count <= 0) return emptyList()
    if (count == 1) return listOf((left + right) / 2f)
    return List(count) { index -> left + (right - left) * index / (count - 1f) }
}

internal object SharePosterRenderer {
    const val POSTER_WIDTH = SHARE_POSTER_WIDTH
    const val POSTER_HEIGHT = SHARE_POSTER_HEIGHT
    const val PREVIEW_WIDTH = SHARE_POSTER_PREVIEW_WIDTH
    const val PREVIEW_HEIGHT = SHARE_POSTER_PREVIEW_HEIGHT

    @Synchronized
    fun render(
        context: Context,
        summary: ShareSummary,
        layout: ShareLayoutKey,
        width: Int = POSTER_WIDTH,
        height: Int = POSTER_HEIGHT
    ): Bitmap {
        require(width > 0 && height > 0) { "Poster dimensions must be positive" }
        currentTypography = typographyFor(context.applicationContext)
        resetPaint()
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val scale = minOf(width / POSTER_WIDTH.toFloat(), height / POSTER_HEIGHT.toFloat())
        val offsetX = (width - POSTER_WIDTH * scale) / 2f
        val offsetY = (height - POSTER_HEIGHT * scale) / 2f

        // Pre-fill full bounds if canvas aspect ratio differs from 9:16
        when (layout) {
            ShareLayoutKey.Scorecard -> {
                val bg = LinearGradient(0f, 0f, width.toFloat(), height.toFloat(), Color.rgb(6, 9, 17), Color.rgb(15, 23, 42), Shader.TileMode.CLAMP)
                paint.shader = bg
                canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
                paint.shader = null
            }
            ShareLayoutKey.Journal -> {
                paint.color = Color.rgb(251, 249, 244)
                canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
            }
            ShareLayoutKey.Achievement -> {
                val bg = LinearGradient(0f, 0f, width.toFloat(), height.toFloat(), Color.rgb(7, 10, 16), Color.rgb(15, 23, 42), Shader.TileMode.CLAMP)
                paint.shader = bg
                canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
                paint.shader = null
            }
            ShareLayoutKey.Receipt -> {
                paint.color = Color.rgb(248, 250, 252)
                canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
            }
            ShareLayoutKey.Signal -> {
                val bg = LinearGradient(0f, 0f, width.toFloat(), height.toFloat(), Color.rgb(6, 8, 24), Color.rgb(5, 7, 20), Shader.TileMode.CLAMP)
                paint.shader = bg
                canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
                paint.shader = null
            }
        }

        canvas.save()
        canvas.translate(offsetX, offsetY)
        canvas.scale(scale, scale)
        when (layout) {
            ShareLayoutKey.Scorecard -> drawScorecard(canvas, summary)
            ShareLayoutKey.Journal -> drawJournal(canvas, summary)
            ShareLayoutKey.Achievement -> drawAchievement(canvas, summary)
            ShareLayoutKey.Receipt -> drawReceipt(canvas, summary)
            ShareLayoutKey.Signal -> drawSignal(canvas, summary)
        }
        canvas.restore()
        return bitmap
    }

    private data class SharePosterTypography(
        val sans400: Typeface,
        val sans500: Typeface,
        val sans700: Typeface,
        val sans900: Typeface,
        val hero: Typeface,
        val wenKai: Typeface,
        val zhiMang: Typeface,
        val pixel: Typeface,
    )

    @Volatile
    private var cachedTypography: SharePosterTypography? = null

    private lateinit var currentTypography: SharePosterTypography

    private val fonts: SharePosterTypography
        get() = currentTypography

    private fun typographyFor(context: Context): SharePosterTypography {
        cachedTypography?.let { return it }
        return synchronized(this) {
            cachedTypography ?: SharePosterTypography(
                sans400 = requireNotNull(ResourcesCompat.getFont(context, R.font.noto_sans_sc_400)),
                sans500 = requireNotNull(ResourcesCompat.getFont(context, R.font.noto_sans_sc_500)),
                sans700 = requireNotNull(ResourcesCompat.getFont(context, R.font.noto_sans_sc_700)),
                sans900 = requireNotNull(ResourcesCompat.getFont(context, R.font.noto_sans_sc_900)),
                hero = requireNotNull(ResourcesCompat.getFont(context, R.font.roboto_condensed_900)),
                wenKai = requireNotNull(ResourcesCompat.getFont(context, R.font.lxgw_wenkai_regular)),
                zhiMang = requireNotNull(ResourcesCompat.getFont(context, R.font.zhi_mang_xing_regular)),
                pixel = requireNotNull(ResourcesCompat.getFont(context, R.font.fusion_pixel_12_proportional))
            ).also { cachedTypography = it }
        }
    }

    fun encodePng(bitmap: Bitmap): ByteArray = ByteArrayOutputStream().use { output ->
        check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) { "PNG encoding failed" }
        output.toByteArray()
    }

    private fun drawScorecard(canvas: Canvas, summary: ShareSummary) {
        canvas.drawColor(Color.rgb(4, 7, 15))
        textFitTop(canvas, summary.title, 570f, 78f, 92f, 82f, WHITE, fonts.sans900, tracking = 1f)
        textFitTop(canvas, summary.periodLabel, 317f, 78f, 187f, 40f, MUTED, fonts.sans500, tracking = 1f)
        // The value starts at x=56, so its actual available width ends at the matching right inset.
        textFitTop(canvas, formatCompactTokens(summary.effectiveTokens), 968f, 56f, 271f, 339f, BLUE, fonts.hero, tracking = -8f, horizontalScale = 1.145f)
        textTop(canvas, "有效 Token", 78f, 549f, 68f, WHITE, fonts.sans700, tracking = -0.8f)
        formatShareDelta(summary.deltaPercent)?.let {
            textTop(canvas, "较上期", 82f, 625f, 48f, MUTED, fonts.sans500)
            textTop(canvas, it, 255f, 625f, 48f, MINT, fonts.hero, tracking = -0.5f)
        }
        text(canvas, "本期高光", 36f, 82f, 764f, WHITE, fonts.sans700)
        rule(canvas, 240f, 746f, 996f, 746f, Color.rgb(42, 49, 72), 2f)
        val highlights = buildList {
            summary.activeDays?.let { add("活跃" to "$it 天") }
            summary.cacheReusePercent?.let { add("缓存复用率" to "$it%") }
            summary.netSavedCostCny?.let { add("缓存净节省" to formatNetSavedCny(it)) }
            if (size < 3) add("记录数" to formatInteger(summary.totalRequests))
        }.take(3)
        highlights.forEachIndexed { index, (label, value) ->
            val x = 84f + index * 310f
            circle(canvas, x + 40f, 847f, 38f, Color.rgb(20, 27, 43), Color.rgb(70, 88, 143))
            drawScorecardLucideIcon(canvas, index, x + 20f, 827f, 40f, Color.rgb(163, 178, 245))
            text(canvas, label, 31f, x + 96f, 835f, MUTED)
            text(canvas, value, 44f, x + 96f, 874f, if (index == 2) MINT else BLUE, fonts.sans700)
            if (index < highlights.lastIndex) rule(canvas, x + 282f, 797f, x + 282f, 900f, Color.rgb(61, 67, 87), 2f)
        }
        val trendPoints = scorecardTrendPoints(summary.points)
        val trendXs = scorecardTrendXPositions(trendPoints.size)
        drawTrend(canvas, trendPoints, RectF(84f, 940f, 996f, 1260f), BLUE, fill = true, xPositions = trendXs)
        trendPoints.forEachIndexed { index, point ->
            val x = trendXs[index]
            text(canvas, point.dateLabel, 28f, x, 1324f, MUTED, align = Paint.Align.CENTER)
            point.weekdayLabel?.let { text(canvas, it, 28f, x, 1362f, MUTED, align = Paint.Align.CENTER) }
        }
        rule(canvas, 78f, 1384f, 1002f, 1384f, Color.rgb(35, 42, 62), 2f)
        text(canvas, "主力工具", 32f, 82f, 1440f, MUTED, fonts.sans700)
        textFit(canvas, summary.topTool ?: "暂无可证明数据", 390f, 82f, 1505f, 54f, WHITE, fonts.sans700)
        rule(canvas, 535f, 1418f, 535f, 1561f, Color.rgb(51, 57, 76), 2f)
        text(canvas, "主力模型", 32f, 600f, 1440f, MUTED, fonts.sans700)
        textFit(canvas, summary.topModel ?: "暂无可证明数据", 390f, 600f, 1505f, 54f, WHITE, fonts.sans700)
        drawComposition(canvas, summary, RectF(78f, 1645f, 1002f, 1708f), listOf(BLUE, VIOLET, MINT))
        brandFooter(canvas, summary, dark = true, y = 1855f, brandSize = 38f, startOverride = 81f, brandHorizontalScale = 1.013f)
    }

    private fun drawJournal(canvas: Canvas, summary: ShareSummary) {
        canvas.drawColor(PAPER)
        val journalTitle = summary.title
            .replace("周报", "周记")
            .replace("日报", "日记")
            .replace("月报", "月记")
            .replace("年报", "年记")
        textFitTop(canvas, journalTitle, 949f, 70f, 80f, 132f, INK, fonts.sans900, tracking = -2f)
        textFitTop(canvas, summary.periodLabel, 457f, 540f, 232f, 50f, INDIGO, fonts.sans500, Paint.Align.CENTER, tracking = 2f)
        dashedRule(canvas, 72f, 300f, 1008f, 300f, Color.rgb(80, 80, 80), 2f, 7f)
        val active = summary.activeDays?.toString() ?: "—"
        textFitTop(canvas, active, 300f, 192f, 344f, 198f, INDIGO, fonts.hero, tracking = -5f, horizontalScale = 1.19f)
        text(canvas, "个活跃日", 42f, 145f, 535f, INDIGO)
        dashedRule(canvas, 455f, 315f, 455f, 555f, Color.rgb(95, 95, 95), 2f, 8f)
        textFitTop(canvas, formatCompactTokens(summary.effectiveTokens), 451f, 543f, 346f, 188f, INDIGO, fonts.hero, tracking = -5f)
        text(canvas, "有效 Token", 42f, 632f, 535f, INDIGO)
        dashedRule(canvas, 72f, 585f, 1008f, 585f, Color.rgb(80, 80, 80), 2f, 7f)
        textFitTop(canvas, summary.highlight, 640f, 206f, 615f, 78f, INDIGO, fonts.wenKai, tracking = 2f, lineHeight = 1.1f, horizontalScale = 0.678f)
        // The handwritten sentence and its underline share the source's 208×616→881×703 box.
        rule(canvas, 220f, 703f, 881f, 676f, INDIGO, 3f)
        val points = summary.points.takeLast(7)
        val maxTokens = points.maxOfOrNull { it.tokens }?.coerceAtLeast(1L) ?: 1L
        points.forEachIndexed { index, point ->
            val left = 145f + index * 126f
            text(canvas, point.dateLabel, 27f, left + 14f, 778f, INK)
            text(canvas, point.weekdayLabel ?: "", 26f, left + 16f, 814f, INK)
            repeat(10) { row ->
                val ratio = point.tokens.toFloat() / maxTokens
                val intensity = if (row >= (10 - ratio * 10).toInt()) 1f else 0.18f
                roundRect(
                    canvas,
                    RectF(left, 842f + row * 52f, left + 70f, 878f + row * 52f),
                    5f,
                    blend(Color.rgb(59, 63, 219), Color.rgb(218, 218, 251), intensity)
                )
            }
            if (index < points.lastIndex) dashedRule(canvas, left + 94f, 825f, left + 94f, 1370f, Color.rgb(145, 145, 145), 1.5f, 6f)
        }
        dashedRule(canvas, 72f, 1415f, 1008f, 1415f, Color.rgb(80, 80, 80), 2f, 7f)
        val facts = buildList {
            formatShareDelta(summary.deltaPercent)?.let { add("较上期" to it) }
            summary.longestStreakDays?.let { add("最长连续" to "$it 天") }
            summary.netSavedCostCny?.let { add("缓存净节省" to formatNetSavedCny(it)) }
            if (size < 3) add("记录数" to formatInteger(summary.totalRequests))
        }.take(3)
        facts.forEachIndexed { index, (label, value) ->
            val x = 92f + index * 322f
            text(canvas, label, 31f, x + 25f, 1493f, INK)
            text(canvas, value, 44f, x + 8f, 1552f, INDIGO, fonts.sans700)
            if (index < facts.lastIndex) dashedRule(canvas, x + 286f, 1455f, x + 286f, 1595f, Color.rgb(90, 90, 90), 2f, 6f)
        }
        dashedRule(canvas, 72f, 1598f, 1008f, 1598f, Color.rgb(80, 80, 80), 2f, 7f)
        text(canvas, "主力工具", 31f, 299f, 1666f, INK, align = Paint.Align.CENTER)
        textFit(canvas, summary.topTool ?: "—", 280f, 299f, 1723f, 43f, INDIGO, fonts.sans700, Paint.Align.CENTER, centerX = 299f)
        text(canvas, "主力模型", 31f, 724f, 1666f, INK, align = Paint.Align.CENTER)
        textFit(canvas, summary.topModel ?: "—", 300f, 724f, 1723f, 43f, INDIGO, fonts.sans700, Paint.Align.CENTER, centerX = 724f)
        brandFooter(canvas, summary, dark = false, y = 1849f, brandSize = 48f, metadataBelow = true, startOverride = 59f, metadataOffset = 40f, brandHorizontalScale = 0.986f)
    }

    private fun drawAchievement(canvas: Canvas, summary: ShareSummary) {
        canvas.drawColor(Color.rgb(255, 76, 43))
        textFitTop(canvas, summary.title, 728f, 59f, 77f, 86f, INK, fonts.sans900, tracking = -1f, horizontalScale = 1.14f)
        textTop(canvas, summary.periodLabel, 70f, 190f, 42f, INK, fonts.sans500, tracking = 0.5f)
        val streak = summary.longestStreakDays ?: summary.activeDays
        textTop(canvas, "连续", 67f, 281f, 164f, PAPER, fonts.sans900, tracking = -4f, lineHeight = 1.02f)
        textTop(canvas, "协作", 70f, 463f, 164f, PAPER, fonts.sans900, tracking = -4f, lineHeight = 1.02f)
        if (streak == null) textTop(canvas, "记录", 70f, 664f, 164f, INK, fonts.sans900, tracking = -4f)
        val blackPanel = Path().apply {
            moveTo(0f, 940f)
            lineTo(1080f, 330f)
            lineTo(1080f, 1920f)
            lineTo(0f, 1920f)
            close()
        }
        paint.color = INK
        canvas.drawPath(blackPanel, paint)
        val giant = streak?.toString() ?: "·"
        textFitTop(
            canvas, giant, 597f, 1010f, 280f, 1240f, PAPER, fonts.hero,
            Paint.Align.RIGHT, tracking = -20f, lineHeight = 0.95f
        )
        if (streak != null) {
            textTop(canvas, giant, 72f, 664f, 230f, INK, fonts.hero, tracking = -6f)
            // The unit shares the left-side number row. Its visual bounds (185..275, 670..760)
            // stay below “协作” and above the diagonal's orange-side edge at that x range.
            textTop(canvas, "天", 185f, 670f, 90f, INK, fonts.sans900, tracking = -3f)
        }
        textFitTop(canvas, formatCompactTokens(summary.effectiveTokens), 365f, 61f, 1094f, 146f, PAPER, fonts.hero, tracking = -4f)
        textTop(canvas, "有效 Token", 72f, 1230f, 48f, PAPER, fonts.sans700)
        formatShareDelta(summary.deltaPercent)?.let {
            textTop(canvas, "较上期", 72f, 1315f, 36f, PAPER, fonts.sans500)
            textTop(canvas, it, 72f, 1360f, 64f, NEON, fonts.hero, tracking = -1f)
        }
        textTop(canvas, "本期高光", 685f, 1172f, 40f, PAPER, fonts.sans700)
        textFitTop(canvas, summary.peakLabel ?: "仍在积累", 324f, 693f, 1230f, 70f, NEON, fonts.hero, tracking = -3f)
        rule(canvas, 685f, 1330f, 1005f, 1330f, PAPER, 2f)
        textFitTop(canvas, listOfNotNull(summary.topTool, summary.topModel).joinToString(" · ").ifEmpty { "TokenLedger" }, 320f, 685f, 1380f, 36f, PAPER, fonts.sans700)
        val points = summary.points.takeLast(7)
        val cardWidth = 126f
        val cardTop = 1498f
        val cardBottom = 1694f
        val cardLefts = evenlyDistributedCardLefts(points.size, 56f, 1024f, cardWidth, 138f)
        points.forEachIndexed { index, point ->
            val left = cardLefts[index]
            val highlighted = point.tokens == points.maxOfOrNull { it.tokens }
            roundRect(canvas, RectF(left, cardTop, left + cardWidth, cardBottom), 0f, if (highlighted) NEON else PAPER)
            if (isPosterHourPoint(point)) {
                textFitTop(canvas, point.dateLabel, cardWidth - 24f, left + 12f, 1572f, 48f, INK, fonts.hero, tracking = -1f)
            } else {
                text(canvas, point.dateLabel, 25f, left + 20f, 1544f, INK)
                text(canvas, point.weekdayLabel.orEmpty(), 25f, left + 20f, 1582f, INK)
                textFitTop(canvas, point.dateLabel.substringAfter('/'), cardWidth - 40f, left + 28f, 1600f, 62f, if (highlighted) INK else Color.rgb(240, 67, 42), fonts.hero, tracking = -1f)
            }
        }
        brandFooter(canvas, summary, dark = true, y = 1859f, brandSize = 46f, startOverride = 70f, brandHorizontalScale = 1.075f)
    }

    private fun drawReceipt(canvas: Canvas, summary: ShareSummary) {
        canvas.drawColor(PAPER)
        dashedRule(canvas, 38f, 30f, 1042f, 30f, INK, 12f, 22f)
        // The source uses a compressed Latin "AI" next to a black CJK masthead, not one generic run.
        textTop(canvas, "AI", 65f, 95f, 176f, INK, fonts.hero, tracking = -8f, horizontalScale = 1.092f)
        textFitTop(canvas, "协作结算单", 790f, 221f, 95f, 176f, INK, fonts.sans900, tracking = -5f, horizontalScale = 0.934f)
        dashedRule(canvas, 66f, 286f, 1014f, 286f, INK, 3f, 9f)
        textFitTop(canvas, summary.periodLabel, 424f, 72f, 312f, 48f, INK, fonts.sans700, tracking = 1f)
        canvas.save()
        canvas.rotate(-7f, 820f, 340f)
        strokeRoundRect(canvas, RectF(675f, 285f, 1005f, 415f), 8f, RED, 7f)
        textTop(canvas, "已结算", 715f, 310f, 82f, RED, fonts.sans900, tracking = 3f)
        canvas.restore()
        roundRect(canvas, RectF(70f, 385f, 318f, 453f), 0f, INK)
        textTop(canvas, summary.range.label + "总计", 84f, 401f, 48f, PAPER, fonts.sans700)
        // Receipt masthead: lock the audited visual size and use horizontal expansion instead
        // of width-fitting it back down. The visual top accounts for the Condensed glyph bounds.
        // Paint's advance width includes side bearings beyond the visible 941 px hero box; keep
        // that controlled 1000 px advance cap so 1.28M stays at the audited size while longer
        // values (for example 999.50M) still shrink before reaching the poster edge.
        textFitTop(canvas, formatCompactTokens(summary.effectiveTokens), 1000f, 41f, 480f, 394f, INK, fonts.hero, tracking = -10f, horizontalScale = 1.01f)
        textTop(canvas, "有效 Token", 78f, 782f, 56f, INK, fonts.sans700, tracking = -1f)
        rule(canvas, 66f, 850f, 1014f, 850f, INK, 8f)
        val rows = buildList {
            summary.activeDays?.let { add("协作天数" to "$it 天") }
            summary.peakLabel?.let { add("本期峰值" to it) }
            summary.topTool?.let { add("主力工具" to it) }
            summary.topModel?.let { add("主力模型" to it) }
            formatShareDelta(summary.deltaPercent)?.let { add("较上期" to it) }
            add("记录数" to formatInteger(summary.totalRequests))
        }.take(5)
        rows.forEachIndexed { index, (label, value) ->
            val rowTop = 888f + index * 103f
            textTop(canvas, label, 239f, rowTop, 41f, INK, fonts.sans700, horizontalScale = 0.985f)
            textFitTop(canvas, value, 414f, 974f, rowTop, 46f, INK, fonts.pixel, Paint.Align.RIGHT, tracking = 2f)
            dashedRule(canvas, 72f, rowTop + 70f, 1008f, rowTop + 70f, Color.rgb(75, 75, 75), 2f, 7f)
        }
        roundRect(canvas, RectF(78f, 1389f, 1003f, 1428f), 0f, INK)
        val recordLabel = if (summary.range == RangeKey.Week && summary.activeDays == 7) {
            "本期协作打卡"
        } else {
            "本期协作记录"
        }
        text(canvas, recordLabel, 37f, 88f, 1419f, PAPER, fonts.sans700)
        val points = summary.points.takeLast(7)
        val slotWidth = 925f / points.size.coerceAtLeast(1)
        points.forEachIndexed { index, point ->
            val left = 78f + index * slotWidth
            val center = left + slotWidth / 2f
            val active = point.tokens > 0L
            val markerColor = if (index == points.lastIndex) RED else INK
            val markerX = center
            val markerY = 1470f
            if (active) {
                circle(canvas, markerX, markerY, 22f, markerColor)
                paint.color = PAPER
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = 6f
                paint.strokeCap = Paint.Cap.ROUND
                val check = Path().apply {
                    moveTo(markerX - 10f, markerY)
                    lineTo(markerX - 2f, markerY + 8f)
                    lineTo(markerX + 12f, markerY - 10f)
                }
                canvas.drawPath(check, paint)
                paint.style = Paint.Style.FILL
            } else {
                paint.color = markerColor
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = 4f
                canvas.drawCircle(markerX, markerY, 20f, paint)
                paint.style = Paint.Style.FILL
            }
            val (primaryLabel, secondaryLabel) = receiptPointLabels(point)
            text(canvas, primaryLabel, 26f, center, 1512f, if (index == points.lastIndex) RED else INK, align = Paint.Align.CENTER)
            secondaryLabel?.let {
                text(canvas, it, 25f, center, 1558f, if (index == points.lastIndex) RED else INK, align = Paint.Align.CENTER)
            }
            if (index < points.lastIndex) dashedRule(canvas, left + slotWidth, 1436f, left + slotWidth, 1591f, INK, 1.5f, 5f)
        }
        textFitTop(canvas, summary.highlight, 797f, 148f, 1629f, 68f, INK, fonts.zhiMang, tracking = 2f, lineHeight = 1.24f)
        rule(canvas, 220f, 1730f, 860f, 1730f, RED, 5f)
        brandFooter(canvas, summary, dark = false, y = 1825f, brandSize = 65f, metadataBelow = true, startOverride = 59f, metadataOffset = 39f, brandHorizontalScale = 0.895f)
        dashedRule(canvas, 38f, 1890f, 1042f, 1890f, INK, 12f, 22f)
    }

    private fun drawSignal(canvas: Canvas, summary: ShareSummary) {
        paint.shader = LinearGradient(0f, 0f, 1080f, 1920f, Color.rgb(26, 22, 190), Color.rgb(2, 20, 102), Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, 1080f, 1920f, paint)
        paint.shader = null
        textFitTop(canvas, summary.title, 337f, 53f, 58f, 64f, WHITE, fonts.sans900, tracking = -1f, horizontalScale = 1.10f)
        textFitTop(canvas, summary.periodLabel, 326f, 50f, 137f, 42f, WHITE, fonts.sans500, tracking = 1f)
        val ribbon = RectF(505f, 0f, 575f, 1510f)
        paint.shader = LinearGradient(505f, 0f, 575f, 1510f, CYAN, MAGENTA, Shader.TileMode.CLAMP)
        canvas.drawRect(ribbon, paint)
        paint.shader = null
        repeat(8) { index -> rule(canvas, 510f + index * 8f, 0f, 510f + index * 8f, 1510f, Color.argb(80, 255, 255, 255), 1f) }
        uprightVerticalText(canvas, "输入${formatCompactTokens(summary.inputTokens)}", 540f, 170f, 26f, WHITE, fonts.sans700, advance = 28f)
        // Signal's hero is deliberately taller than a conventional width-fit numeral. Fit the
        // final formatted value, including M/B, inside the audited visual box instead of clipping
        // its unit at the poster edge.
        textFitTop(canvas, formatCompactTokens(summary.effectiveTokens), 986f, 47f, 519f, 663f, WHITE, fonts.hero, tracking = -18f, horizontalScale = 0.607f)
        textTop(canvas, "有效 Token", 540f, 1058f, 52f, WHITE, fonts.sans700, Paint.Align.CENTER, tracking = -1f)
        // Keep the lower upright runs separate from both the centered hero label and the facts.
        val outputRun = "输出${formatCompactTokens(summary.outputTokens)}"
        val cacheRun = "缓存${formatCompactTokens(summary.cachedTokens)}"
        val lower = signalLowerRibbonLayout(uprightGlyphCount(outputRun), uprightGlyphCount(cacheRun))
        uprightVerticalText(canvas, outputRun, 540f, lower.outputTop, lower.size, WHITE, fonts.sans700, advance = lower.advance)
        uprightVerticalText(canvas, cacheRun, 540f, lower.cacheTop, lower.size, WHITE, fonts.sans700, advance = lower.advance)
        val facts = buildList<Pair<String, String?>> {
            formatShareDelta(summary.deltaPercent)?.let { add(it to "较上期") }
            summary.activeDays?.let { add("$it 天" to "活跃") }
            summary.cacheReusePercent?.let { add("$it%" to "缓存复用率") }
            // Source's fourth cell is an endpoint signature, not a second caption.
            add(listOfNotNull(summary.topTool, summary.topModel).joinToString("\n").ifEmpty { "TokenLedger" } to null)
        }.take(4)
        facts.forEachIndexed { index, (value, label) ->
            val x = 58f + index * 258f
            textFit(canvas, value, 220f, x, 1548f, 50f, WHITE, fonts.hero, tracking = -1f, lineHeight = 0.95f)
            label?.let { text(canvas, it, 30f, x, 1584f, Color.rgb(195, 205, 255), fonts.sans500) }
            if (index < facts.lastIndex) rule(canvas, x + 220f, 1495f, x + 220f, 1620f, Color.argb(110, 255, 255, 255), 2f)
        }
        rule(canvas, 58f, 1660f, 1022f, 1660f, Color.argb(140, 255, 255, 255), 2f)
        textFit(canvas, "输入 ${formatCompactTokens(summary.inputTokens)} · 输出 ${formatCompactTokens(summary.outputTokens)} · 缓存 ${formatCompactTokens(summary.cachedTokens)}", 518f, 540f, 1711f, 38f, WHITE, align = Paint.Align.CENTER, centerX = 540f)
        brandFooter(canvas, summary, dark = true, y = 1812f, centered = true, brandSize = 57f, startOverride = 336f, brandHorizontalScale = 0.864f)
    }

    /**
     * Lucide 1.17.0 source nodes: CalendarDays, ChartPie and PiggyBank.  Their ISC license is
     * shipped in assets/licenses/share_icons/LUCIDE-ISC.txt.  The paths remain vector paths at
     * every export scale instead of becoming text glyph substitutes.
     */
    private fun drawScorecardLucideIcon(canvas: Canvas, index: Int, x: Float, y: Float, size: Float, color: Int) {
        canvas.save()
        canvas.translate(x, y)
        canvas.scale(size / 24f, size / 24f)
        paint.shader = null
        paint.style = Paint.Style.STROKE
        paint.color = color
        paint.strokeWidth = 1.75f
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeJoin = Paint.Join.ROUND
        when (index) {
            0 -> {
                // calendar-days.mjs: the rect node plus its exact path nodes.
                canvas.drawRoundRect(RectF(3f, 4f, 21f, 22f), 2f, 2f, paint)
                drawLucidePaths(canvas, LUCIDE_CALENDAR_DAYS_PATHS)
            }
            1 -> drawLucidePaths(canvas, LUCIDE_CHART_PIE_PATHS)
            else -> drawLucidePaths(canvas, LUCIDE_PIGGY_BANK_PATHS)
        }
        paint.style = Paint.Style.FILL
        canvas.restore()
    }

    private fun drawLucidePaths(canvas: Canvas, paths: List<String>) {
        paths.forEach { data ->
            val path = requireNotNull(PathParser.createPathFromPathData(data))
            canvas.drawPath(path, paint)
        }
    }

    /** Keeps sparse weekly snapshots centered while retaining the 7-day 138 px cadence. */
    private fun evenlyDistributedCardLefts(count: Int, left: Float, right: Float, cardWidth: Float, sevenDayStep: Float): List<Float> {
        if (count <= 0) return emptyList()
        if (count == 1) return listOf((left + right - cardWidth) / 2f)
        val available = right - left
        val step = if (count >= 7) sevenDayStep else (available - cardWidth) / (count - 1)
        return List(count) { index -> left + index * step }
    }

    private fun drawTrend(
        canvas: Canvas,
        points: List<SharePoint>,
        bounds: RectF,
        color: Int,
        fill: Boolean,
        xPositions: List<Float> = scorecardTrendXPositions(points.size, bounds.left, bounds.right)
    ) {
        rule(canvas, bounds.left, bounds.bottom, bounds.right, bounds.bottom, Color.rgb(65, 69, 84), 2f)
        if (points.isEmpty()) return
        require(xPositions.size == points.size) { "Trend points and x positions must have the same size" }
        val maximum = points.maxOfOrNull { it.tokens }?.coerceAtLeast(1L) ?: 1L
        val path = Path()
        val fillPath = Path()
        points.forEachIndexed { index, point ->
            val x = xPositions[index]
            val y = bounds.bottom - bounds.height() * 0.82f * point.tokens / maximum
            if (index == 0) {
                path.moveTo(x, y)
                fillPath.moveTo(x, bounds.bottom)
                fillPath.lineTo(x, y)
            } else {
                path.lineTo(x, y)
                fillPath.lineTo(x, y)
            }
            dashedRule(canvas, x, y + 14f, x, bounds.bottom, Color.rgb(76, 74, 150), 1.5f, 6f)
            circle(canvas, x, y, if (index == points.lastIndex) 13f else 9f, color)
        }
        if (fill) {
            fillPath.lineTo(bounds.right, bounds.bottom)
            fillPath.close()
            paint.shader = LinearGradient(0f, bounds.top, 0f, bounds.bottom, Color.argb(105, 86, 75, 255), Color.TRANSPARENT, Shader.TileMode.CLAMP)
            canvas.drawPath(fillPath, paint)
            paint.shader = null
        }
        paint.color = color
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 5f
        paint.strokeCap = Paint.Cap.ROUND
        canvas.drawPath(path, paint)
        paint.style = Paint.Style.FILL
    }

    private fun drawComposition(canvas: Canvas, summary: ShareSummary, bounds: RectF, colors: List<Int>) {
        val values = listOf(summary.inputTokens, summary.outputTokens, summary.cachedTokens)
        val total = values.sum().coerceAtLeast(1L)
        var left = bounds.left
        values.forEachIndexed { index, value ->
            val width = bounds.width() * value / total
            val right = if (index == values.lastIndex) bounds.right else left + width
            roundRect(canvas, RectF(left, bounds.top, right, bounds.bottom), 8f, colors[index])
            if (width > 110f) {
                // 占比与应用同一写法（四舍五入到整数，[formatSharePercent]）；此前这里截断取整。
                text(canvas, formatSharePercent(value * 100.0 / total), 31f, left + width / 2f, bounds.centerY() + 11f, WHITE, fonts.sans700, Paint.Align.CENTER)
            }
            left = right + 3f
        }
        val labels = listOf("输入", "输出", "缓存")
        labels.forEachIndexed { index, label ->
            val x = bounds.left + index * 290f
            circle(canvas, x + 8f, bounds.bottom + 58f, 8f, colors[index])
            text(canvas, "$label ${formatCompactTokens(values[index])}", 28f, x + 28f, bounds.bottom + 68f, MUTED)
        }
    }

    private fun drawVectorBrandEmblem(
        canvas: Canvas,
        x: Float,
        y: Float,
        size: Float,
        color: Int
    ) {
        val scale = size / TokenLedgerBrand.SIZE
        val path = brandEmblemPath
        canvas.save()
        canvas.translate(x, y)
        canvas.scale(scale, scale)
        paint.reset()
        paint.isAntiAlias = true
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = TokenLedgerBrand.STROKE_WIDTH
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeJoin = Paint.Join.ROUND
        paint.color = color
        canvas.drawPath(path, paint)
        canvas.restore()
    }

    private val brandEmblemPath: Path by lazy {
        requireNotNull(PathParser.createPathFromPathData(TokenLedgerBrand.PATH_DATA))
    }

    private fun brandFooter(
        canvas: Canvas,
        summary: ShareSummary,
        dark: Boolean,
        y: Float,
        centered: Boolean = false,
        brandSize: Float = 44f,
        metadataBelow: Boolean = false,
        startOverride: Float? = null,
        metadataOffset: Float = 54f,
        brandHorizontalScale: Float = 1f
    ) {
        val foreground = if (dark) WHITE else INK
        val secondary = if (dark) MUTED else Color.rgb(100, 116, 139)
        val start = startOverride ?: if (centered) 332f else 78f
        val logoSize = brandSize + 10f
        val logoTop = y - 36f

        drawVectorBrandEmblem(canvas, start, logoTop, logoSize, foreground)
        text(canvas, "TokenLedger", brandSize, start + logoSize + 18f, y + 5f, foreground, fonts.sans700, tracking = -0.8f, horizontalScale = brandHorizontalScale)
        val boundary = buildList {
            add(summary.dataSourceLabel)
            if (summary.includesEstimates) add("含估算")
            if (summary.costMasked) add("费用已隐藏")
            add("生成于 ${summary.generatedDateLabel}")
        }.joinToString(" · ")
        if (centered) {
            textFit(canvas, boundary, 780f, 150f, y + 55f, 25f, Color.rgb(141, 160, 244), fonts.sans400, Paint.Align.CENTER, centerX = 540f)
        } else if (metadataBelow) {
            textFit(canvas, boundary, 820f, start + logoSize + 18f, y + metadataOffset, 25f, secondary, fonts.sans400)
        } else {
            textFit(canvas, boundary, 500f, 510f, y + 3f, 25f, secondary)
        }
    }

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        isDither = true
        style = Paint.Style.FILL
    }

    /** Every poster is independent of the layout rendered immediately before it. */
    private fun resetPaint() {
        paint.reset()
        paint.isAntiAlias = true
        paint.isDither = true
        paint.alpha = 255
        paint.shader = null
        paint.style = Paint.Style.FILL
        paint.strokeWidth = 1f
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeJoin = Paint.Join.MITER
        paint.strokeMiter = 4f
        paint.pathEffect = null
        paint.textAlign = Paint.Align.LEFT
        paint.typeface = fonts.sans400
        paint.textScaleX = 1f
        paint.textSkewX = 0f
        paint.letterSpacing = 0f
    }

    private fun text(
        canvas: Canvas,
        value: String,
        size: Float,
        x: Float,
        y: Float,
        color: Int,
        typeface: Typeface? = null,
        align: Paint.Align = Paint.Align.LEFT,
        tracking: Float = 0f,
        lineHeight: Float = 1.18f,
        baselineShift: Float = 0f,
        horizontalScale: Float = 1f
    ) {
        val role = ShareTextRole(
            typeface = typeface ?: fonts.sans400,
            size = size,
            tracking = tracking,
            lineHeight = lineHeight,
            baselineShift = baselineShift
        )
        paint.shader = null
        paint.style = Paint.Style.FILL
        paint.color = color
        paint.textSize = role.size
        paint.typeface = role.typeface
        paint.letterSpacing = role.tracking / role.size
        paint.textScaleX = horizontalScale
        paint.textAlign = align
        value.split('\n').forEachIndexed { index, line ->
            canvas.drawText(line, x, y + role.baselineShift + index * role.size * role.lineHeight, paint)
        }
    }

    private fun textFit(
        canvas: Canvas,
        value: String,
        maxWidth: Float,
        x: Float,
        y: Float,
        preferredSize: Float,
        color: Int,
        typeface: Typeface? = null,
        align: Paint.Align = Paint.Align.LEFT,
        centerX: Float? = null,
        tracking: Float = 0f,
        lineHeight: Float = 1.18f,
        baselineShift: Float = 0f,
        horizontalScale: Float = 1f
    ) {
        val resolvedTypeface = typeface ?: fonts.sans400
        paint.typeface = resolvedTypeface
        paint.textSize = preferredSize
        paint.letterSpacing = tracking / preferredSize
        paint.textScaleX = horizontalScale
        val longest = value.split('\n').maxByOrNull { it.length }.orEmpty()
        while (paint.measureText(longest) > maxWidth && paint.textSize > 22f) {
            paint.textSize -= 2f
            paint.letterSpacing = tracking / paint.textSize
        }
        text(
            canvas = canvas,
            value = value,
            size = paint.textSize,
            x = centerX ?: x,
            y = y,
            color = color,
            typeface = resolvedTypeface,
            align = align,
            tracking = tracking,
            lineHeight = lineHeight,
            baselineShift = baselineShift,
            horizontalScale = horizontalScale
        )
    }

    /** Fits with the final font metrics, then converts a design visual-top into Canvas baseline. */
    private fun textFitTop(
        canvas: Canvas,
        value: String,
        maxWidth: Float,
        x: Float,
        top: Float,
        preferredSize: Float,
        color: Int,
        typeface: Typeface,
        align: Paint.Align = Paint.Align.LEFT,
        tracking: Float = 0f,
        lineHeight: Float = 1.18f,
        horizontalScale: Float = 1f
    ) {
        paint.typeface = typeface
        paint.textSize = preferredSize
        paint.textScaleX = horizontalScale
        paint.letterSpacing = tracking / preferredSize
        val longest = value.substringBefore('\n')
        while (paint.measureText(longest) > maxWidth && paint.textSize > 22f) {
            paint.textSize -= 2f
            paint.letterSpacing = tracking / paint.textSize
        }
        val bounds = Rect()
        paint.getTextBounds(longest, 0, longest.length, bounds)
        text(
            canvas = canvas,
            value = value,
            size = paint.textSize,
            x = x,
            y = top - bounds.top,
            color = color,
            typeface = typeface,
            align = align,
            tracking = tracking,
            lineHeight = lineHeight,
            horizontalScale = horizontalScale
        )
    }

    private fun textTop(
        canvas: Canvas,
        value: String,
        x: Float,
        top: Float,
        size: Float,
        color: Int,
        typeface: Typeface,
        align: Paint.Align = Paint.Align.LEFT,
        tracking: Float = 0f,
        lineHeight: Float = 1.18f,
        horizontalScale: Float = 1f
    ) {
        paint.typeface = typeface
        paint.textSize = size
        paint.textScaleX = horizontalScale
        paint.letterSpacing = tracking / size
        val line = value.substringBefore('\n')
        val bounds = Rect()
        paint.getTextBounds(line, 0, line.length, bounds)
        text(
            canvas = canvas,
            value = value,
            size = size,
            x = x,
            y = top - bounds.top,
            color = color,
            typeface = typeface,
            align = align,
            tracking = tracking,
            lineHeight = lineHeight,
            horizontalScale = horizontalScale
        )
    }

    /** Draws upright glyphs down the signal ribbon; it deliberately never rotates a text run. */
    private fun uprightVerticalText(
        canvas: Canvas,
        value: String,
        centerX: Float,
        top: Float,
        size: Float,
        color: Int,
        typeface: Typeface,
        advance: Float
    ) {
        value.filterNot(Char::isWhitespace).forEachIndexed { index, glyph ->
            textTop(canvas, glyph.toString(), centerX, top + index * advance, size, color, typeface, Paint.Align.CENTER)
        }
    }

    private fun rule(canvas: Canvas, x1: Float, y1: Float, x2: Float, y2: Float, color: Int, width: Float) {
        paint.shader = null
        paint.style = Paint.Style.STROKE
        paint.color = color
        paint.strokeWidth = width
        paint.pathEffect = null
        canvas.drawLine(x1, y1, x2, y2, paint)
        paint.style = Paint.Style.FILL
    }

    private fun dashedRule(canvas: Canvas, x1: Float, y1: Float, x2: Float, y2: Float, color: Int, width: Float, gap: Float) {
        paint.shader = null
        paint.style = Paint.Style.STROKE
        paint.color = color
        paint.strokeWidth = width
        paint.pathEffect = DashPathEffect(floatArrayOf(gap, gap), 0f)
        canvas.drawLine(x1, y1, x2, y2, paint)
        paint.pathEffect = null
        paint.style = Paint.Style.FILL
    }

    private fun roundRect(canvas: Canvas, rect: RectF, radius: Float, color: Int) {
        paint.shader = null
        paint.style = Paint.Style.FILL
        paint.color = color
        canvas.drawRoundRect(rect, radius, radius, paint)
    }

    private fun strokeRoundRect(canvas: Canvas, rect: RectF, radius: Float, color: Int, width: Float) {
        paint.shader = null
        paint.style = Paint.Style.STROKE
        paint.color = color
        paint.strokeWidth = width
        canvas.drawRoundRect(rect, radius, radius, paint)
        paint.style = Paint.Style.FILL
    }

    private fun circle(canvas: Canvas, x: Float, y: Float, radius: Float, color: Int, stroke: Int? = null) {
        paint.shader = null
        paint.style = Paint.Style.FILL
        paint.color = color
        canvas.drawCircle(x, y, radius, paint)
        stroke?.let {
            paint.style = Paint.Style.STROKE
            paint.color = it
            paint.strokeWidth = 2f
            canvas.drawCircle(x, y, radius, paint)
            paint.style = Paint.Style.FILL
        }
    }

    private fun blend(foreground: Int, background: Int, fraction: Float): Int {
        val t = fraction.coerceIn(0f, 1f)
        fun channel(a: Int, b: Int) = (a * t + b * (1f - t)).toInt().coerceIn(0, 255)
        return Color.rgb(
            channel(Color.red(foreground), Color.red(background)),
            channel(Color.green(foreground), Color.green(background)),
            channel(Color.blue(foreground), Color.blue(background))
        )
    }

    private const val WHITE = Color.WHITE
    private const val INK = Color.BLACK
    private val PAPER = Color.rgb(247, 243, 233)
    private val MUTED = Color.rgb(166, 169, 184)
    private val BLUE = Color.rgb(66, 91, 255)
    private val INDIGO = Color.rgb(42, 48, 205)
    private val VIOLET = Color.rgb(110, 50, 244)
    private val MINT = Color.rgb(84, 222, 174)
    private val NEON = Color.rgb(207, 255, 33)
    private val RED = Color.rgb(184, 40, 34)
    private val CYAN = Color.rgb(59, 223, 255)
    private val MAGENTA = Color.rgb(212, 50, 255)
    private val LUCIDE_CALENDAR_DAYS_PATHS = listOf(
        "M8 2v4",
        "M16 2v4",
        "M3 10h18",
        "M8 14h.01",
        "M12 14h.01",
        "M16 14h.01",
        "M8 18h.01",
        "M12 18h.01",
        "M16 18h.01"
    )
    private val LUCIDE_CHART_PIE_PATHS = listOf(
        "M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z",
        "M21.21 15.89A10 10 0 1 1 8 2.83"
    )
    private val LUCIDE_PIGGY_BANK_PATHS = listOf(
        "M11 17h3v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3a3.16 3.16 0 0 0 2-2h1a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1h-1a5 5 0 0 0-2-4V3a4 4 0 0 0-3.2 1.6l-.3.4H11a6 6 0 0 0-6 6v1a5 5 0 0 0 2 4v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1z",
        "M16 10h.01",
        "M2 8v1a2 2 0 0 0 2 2h1"
    )
}
