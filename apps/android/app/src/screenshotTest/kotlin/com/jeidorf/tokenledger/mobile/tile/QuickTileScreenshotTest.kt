package com.jeidorf.tokenledger.mobile.tile

import android.content.res.Configuration
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.android.tools.screenshot.PreviewTest
import com.jeidorf.tokenledger.mobile.QuotaProviderStatus
import com.jeidorf.tokenledger.mobile.R
import com.jeidorf.tokenledger.mobile.ui.foundation.LedgerPalettes
import com.jeidorf.tokenledger.mobile.widget.WidgetQuota
import com.jeidorf.tokenledger.mobile.widget.WidgetQuotaBarRow
import com.jeidorf.tokenledger.mobile.widget.WidgetRange
import com.jeidorf.tokenledger.mobile.widget.WidgetState
import com.jeidorf.tokenledger.mobile.widget.WidgetUsage

/**
 * 快捷设置磁贴的主机视觉夹具：磁贴由系统通知栏绘制，这里只按 [quickTileContent] 的真实输出
 * 画一个近似的磁贴外形（图标 + 主行 + 副行，点亮/未激活两种底色），用来核对文字口径与截断。
 * 不是通知栏实拍，各厂商系统的磁贴外观不同。
 */
private fun row(provider: String, window: String, percent: Int, rank: Int, status: QuotaProviderStatus = QuotaProviderStatus.Ok) =
    WidgetQuotaBarRow(
        key = "$provider:$window", providerId = provider.lowercase(), providerName = provider, windowLabel = window,
        status = status, availableFraction = percent / 100f, availablePercent = percent, resetText = "49 分钟后重置",
        freshnessText = "2 分钟前", rank = rank, groupOrder = rank
    )

private val today = WidgetUsage(WidgetRange.Today, 12_400_000, 38.62, 120, "刚刚", null)

private val cases: List<Pair<String, QuickTileContent>> = listOf(
    "最紧额度" to quickTileContent(
        WidgetState.Ready(WidgetQuota(emptyList(), listOf(row("Codex", "每周", 72, 0), row("Claude", "5 小时", 12, 1))), today),
        costMasked = false
    ),
    "隐藏费用" to quickTileContent(
        WidgetState.Ready(WidgetQuota(emptyList(), listOf(row("Codex", "每周", 72, 0))), today),
        costMasked = true
    ),
    "历史数据" to quickTileContent(
        WidgetState.Ready(WidgetQuota(emptyList(), listOf(row("Claude", "5 小时", 40, 0, QuotaProviderStatus.Stale))), null),
        costMasked = false
    ),
    "只有费用" to quickTileContent(WidgetState.Ready(WidgetQuota(emptyList(), emptyList()), today), costMasked = false),
    "未登录" to quickTileContent(WidgetState.NeedLogin, costMasked = false)
)

@Composable
private fun QuickTileGallery(night: Boolean) {
    val p = if (night) LedgerPalettes.Dark else LedgerPalettes.Light
    Column(
        Modifier.fillMaxSize().background(p.page).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        cases.forEach { (name, content) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.width(180.dp).height(64.dp)
                        .background(if (content.active) p.primaryFill else p.raised, RoundedCornerShape(32.dp))
                        .padding(horizontal = 14.dp),
                    contentAlignment = Alignment.CenterStart
                ) {
                    val fg = if (content.active) p.onPrimaryFill else p.text
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Image(painterResource(R.drawable.ic_quick_tile), contentDescription = null,
                            colorFilter = ColorFilter.tint(fg), modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text(content.label, color = fg, fontSize = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1,
                                overflow = TextOverflow.Ellipsis)
                            content.subtitle?.let {
                                Text(it, color = fg, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
                Spacer(Modifier.width(10.dp))
                Text(name, color = p.muted, fontSize = 11.sp)
            }
        }
    }
}

@PreviewTest
@Preview(name = "QuickTile Dark", device = "spec:width=280dp,height=400dp,dpi=320", fontScale = 1.0f,
    uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
fun QuickTileDarkScreenshot() { QuickTileGallery(night = true) }

@PreviewTest
@Preview(name = "QuickTile Light", device = "spec:width=280dp,height=400dp,dpi=320", fontScale = 1.0f)
@Composable
fun QuickTileLightScreenshot() { QuickTileGallery(night = false) }
