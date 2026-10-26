package com.jeidorf.tokenledger.mobile.dimensions

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.LedgerAppearance
import com.jeidorf.tokenledger.mobile.LocalCostMaskEnabled
import com.jeidorf.tokenledger.mobile.ProvideLedgerPalette
import com.jeidorf.tokenledger.mobile.TokenLedgerTheme
import com.jeidorf.tokenledger.mobile.ui.dimensions.DimensionsPreviewKind
import com.jeidorf.tokenledger.mobile.ui.dimensions.dimensionsPreviewFeed
import com.jeidorf.tokenledger.mobile.ui.dimensions.v2DimensionItems
import com.jeidorf.tokenledger.mobile.ui.foundation.v2Palette

private fun dimensionNodes(node: SemanticsNode): List<SemanticsNode> =
    listOf(node) + node.children.flatMap(::dimensionNodes)

private fun textFits(layout: TextLayoutResult): Boolean {
    if (layout.lineCount == 0) return layout.layoutInput.text.isEmpty()
    if (layout.getLineEnd(layout.lineCount - 1) != layout.layoutInput.text.length) return false
    // 语义测量中的段落宽度可能包含未使用的空间，逐行检查实际文字边界与完整字符。
    return (0 until layout.lineCount).all { line ->
        !layout.isLineEllipsized(line) &&
            layout.getLineLeft(line) >= -0.5f &&
            layout.getLineRight(line) <= layout.size.width + 0.5f &&
            layout.getLineBottom(line) <= layout.size.height + 0.5f
    }
}

@Composable
private fun DimensionsCards(masked: Boolean) {
    val appearance = LedgerAppearance.Light
    val palette = v2Palette(appearance)
    val root = LocalView.current as ViewRootForTest
    val original = dimensionsPreviewFeed(DimensionsPreviewKind.Live)
    val dimensions = checkNotNull(original.dimensions)
    val sessions = (dimensions.sessions as DimensionPart.Ok).value
    val feed = original.copy(
        dimensions = dimensions.copy(sessions = DimensionPart.Ok(sessions.copy(rows = sessions.rows.take(2))))
    )
    TokenLedgerTheme(appearance) {
        ProvideLedgerPalette(appearance) {
            CompositionLocalProvider(LocalCostMaskEnabled provides masked) {
                Box(Modifier.fillMaxSize().background(palette.background).onGloballyPositioned { coordinates ->
                    val nodes = dimensionNodes(root.semanticsOwner.unmergedRootSemanticsNode)
                    val texts = nodes.flatMap { node ->
                        node.config.getOrElse(SemanticsProperties.Text) { emptyList() }.map { it.text }
                    }
                    check(listOf("会话排行", "账号用量", "平均 Context 构成", "费用不可得").all { it in texts }) {
                        "用量维度预览没有显示全部卡片或未知费用状态"
                    }
                    val rows = nodes.filter { node ->
                        val description = node.config.getOrElse(SemanticsProperties.ContentDescription) { emptyList() }.singleOrNull()
                        description?.contains(" 账号，") == true || description?.contains(" 会话，") == true
                    }
                    check(rows.size == 5) { "应显示两条会话与三条账号记录，实际 ${rows.size}" }
                    rows.forEach { row ->
                        check(row.boundsInRoot.left >= 0 && row.boundsInRoot.right <= coordinates.size.width + 1) {
                            "账号行超出预览宽度"
                        }
                        var measured = 0
                        dimensionNodes(row).forEach { node ->
                            val results = mutableListOf<TextLayoutResult>()
                            if (node.config.contains(SemanticsActions.GetTextLayoutResult)) {
                                node.config[SemanticsActions.GetTextLayoutResult].action?.invoke(results)
                            }
                            measured += results.size
                            check(results.all(::textFits)) {
                                results.filterNot(::textFits).joinToString { layout ->
                                    "用量文字溢出：${layout.layoutInput.text.text}；尺寸 ${layout.size}，" +
                                        "排出 ${layout.getLineEnd(layout.lineCount - 1)} 字符，" +
                                        "末行边界 ${layout.getLineRight(layout.lineCount - 1)}x${layout.getLineBottom(layout.lineCount - 1)}"
                                }
                            }
                        }
                        check(measured > 0) { "未取得用量行的实际文字排版" }
                        val description = row.config[SemanticsProperties.ContentDescription].joinToString()
                        if (masked) {
                            check(!Regex("[¥$]\\s*\\d").containsMatchIn(description)) { "隐藏费用泄露到读屏文案" }
                        }
                    }
                    if (masked) {
                        check(texts.none { Regex("[¥$]\\s*\\d").containsMatchIn(it) }) { "隐藏费用仍显示金额" }
                    }
                }) {
                    LazyColumn(
                        Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(12.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        v2DimensionItems(palette, feed)
                    }
                }
            }
        }
    }
}

@PreviewTest
@Preview(name = "Usage dimensions live 390", device = "spec:width=390dp,height=2000dp,dpi=160", locale = "zh-rCN")
@Composable
fun UsageDimensionsLive390Screenshot() {
    DimensionsCards(masked = false)
}

@PreviewTest
@Preview(name = "Usage dimensions narrow 320 font2", device = "spec:width=320dp,height=3200dp,dpi=160", fontScale = 2f, locale = "zh-rCN")
@Composable
fun UsageDimensionsNarrowLargeTextScreenshot() {
    DimensionsCards(masked = true)
}
