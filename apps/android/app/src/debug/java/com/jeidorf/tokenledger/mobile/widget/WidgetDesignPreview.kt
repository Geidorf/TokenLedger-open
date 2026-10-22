package com.jeidorf.tokenledger.mobile.widget

import android.content.res.Configuration
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * T8.8 主机视觉回归夹具。它不进入生产路由；组件比例、文案、数值格式与语义色对应
 * Glance 生产实现，供 screenshot test 在无 Launcher 主机时锁定 Ledger Rings 视觉基线。
 */
@Preview(
    name = "Ledger Rings Dark 430x720",
    device = "spec:width=430dp,height=720dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
internal fun LedgerRingsDarkPreview() {
    WidgetDesignGallery(night = true)
}

@Preview(
    name = "Ledger Rings Light 430x720",
    device = "spec:width=430dp,height=720dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_NO,
    showBackground = true,
    backgroundColor = 0xFFF4F4F7
)
@Composable
internal fun LedgerRingsLightPreview() {
    WidgetDesignGallery(night = false)
}

@Preview(
    name = "Ledger Rings States 430x220",
    device = "spec:width=430dp,height=220dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = true,
    backgroundColor = 0xFF08090C
)
@Composable
internal fun LedgerRingsStatesPreview() {
    val p = previewPalette(night = true)
    Row(
        modifier = Modifier.fillMaxSize().background(p.background).padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        PreviewStateRing(Modifier.weight(1f), p, p.blue, "57%", "正常")
        PreviewStateRing(Modifier.weight(1f), p, p.amber, "57%", "来源待刷新")
        PreviewStateRing(Modifier.weight(1f), p, Color(0xFFFF625A), "—", "不可用")
    }
}

/**
 * Launcher 选择器使用的 4×1 单行消耗真实渲染夹具。尺寸、文案、格式化函数与
 * [TokenLedgerWidget] 的 SingleUsage 分支保持一致；截图产物同时作为 previewImage。
 */
@Preview(
    name = "Single Usage Picker 320x80",
    device = "spec:width=320dp,height=80dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = false
)
@Composable
internal fun SingleUsagePickerPreview() {
    val p = previewPalette(night = true)
    PreviewSingleUsageCard(
        modifier = Modifier.fillMaxSize(),
        p = p
    )
}

/**
 * Large-font fixtures mirror the Glance reflow decisions while remaining renderable by the
 * host-side screenshot runner, which cannot host a Launcher/AppWidget session.
 */
@Preview(
    name = "Single Usage 200 percent 320x80",
    device = "spec:width=320dp,height=80dp,dpi=160",
    fontScale = 2f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = false
)
@Composable
internal fun SingleUsageLargeTextPreview() {
    val p = previewPalette(night = true)
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(p.surface, RoundedCornerShape(16.dp))
            .padding(horizontal = 10.dp, vertical = 5.dp),
        contentAlignment = Alignment.CenterStart
    ) {
        Text(
            "今日 ${formatCompactTokens(987_600_000L)}",
            style = previewTextStyle(p.text, 17, FontWeight.Bold),
            maxLines = 1
        )
    }
}

@Preview(
    name = "Login 200 percent 320x80",
    device = "spec:width=320dp,height=80dp,dpi=160",
    fontScale = 2f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = false
)
@Composable
internal fun LoginLargeTextPreview() {
    PreviewCompactStateCard("需要登录 · 打开 TokenLedger 完成登录")
}

@Preview(
    name = "Empty 200 percent 320x80",
    device = "spec:width=320dp,height=80dp,dpi=160",
    fontScale = 2f,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = false
)
@Composable
internal fun EmptyLargeTextPreview() {
    PreviewCompactStateCard("暂无数据 · 打开应用同步")
}

@Preview(
    name = "Ring Picker 200x200",
    device = "spec:width=200dp,height=200dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = false
)
@Composable
internal fun RingPickerPreview() {
    val p = previewPalette(night = true)
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(p.surface, RoundedCornerShape(20.dp))
            .padding(12.dp)
    ) {
        Text("TokenLedger", style = previewTextStyle(p.text, 11, FontWeight.Bold))
        Spacer(Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxSize(),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            PreviewCompactRing(
                modifier = Modifier.weight(1f),
                p = p,
                name = "Codex",
                percent = 0.75f,
                value = "75%",
                status = "5 小时"
            )
            PreviewCompactRing(
                modifier = Modifier.weight(1f),
                p = p,
                name = "Claude",
                percent = 0.63f,
                value = "63%",
                status = "5 小时"
            )
            Text("+1", style = previewTextStyle(p.faint, 9, FontWeight.Bold))
        }
    }
}

@Preview(
    name = "Combo Picker 400x200",
    device = "spec:width=400dp,height=200dp,dpi=160",
    uiMode = Configuration.UI_MODE_NIGHT_YES,
    showBackground = false
)
@Composable
internal fun ComboPickerPreview() {
    val p = previewPalette(night = true)
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(p.surface, RoundedCornerShape(20.dp))
            .padding(12.dp)
    ) {
        Text("TokenLedger", style = previewTextStyle(p.text, 11, FontWeight.Bold))
        Spacer(Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxSize(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.Center
            ) {
                Text("剩余额度", style = previewTextStyle(p.muted, 9, FontWeight.Normal))
                Spacer(Modifier.height(5.dp))
                PreviewBarRowItem(p, "Codex · 5 小时", 0.75f, "75%")
                Spacer(Modifier.height(6.dp))
                PreviewBarRowItem(p, "Claude · 5 小时", 0.63f, "63%")
                Spacer(Modifier.height(6.dp))
                PreviewBarRowItem(p, "Antigravity", 0.42f, "42%")
            }
            Spacer(Modifier.width(12.dp))
            Box(Modifier.width(1.dp).fillMaxHeight().background(p.divider))
            Spacer(Modifier.width(12.dp))
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.Center
            ) {
                Text("今日有效 Token", style = previewTextStyle(p.muted, 9, FontWeight.Normal))
                Text(
                    formatCompactTokens(987_600_000L),
                    style = previewTextStyle(p.text, 22, FontWeight.Bold)
                )
                Spacer(Modifier.height(7.dp))
                Box(Modifier.fillMaxWidth().height(1.dp).background(p.divider))
                Spacer(Modifier.height(7.dp))
                Text("预估成本", style = previewTextStyle(p.muted, 9, FontWeight.Normal))
                Text(
                    formatCny(128_640.34),
                    style = previewTextStyle(p.text, 14, FontWeight.Bold)
                )
                Text("更新于 8 分钟前", style = previewTextStyle(p.faint, 8, FontWeight.Normal))
            }
        }
    }
}

private data class PreviewPalette(
    val background: Color,
    val surface: Color,
    val text: Color,
    val muted: Color,
    val faint: Color,
    val divider: Color,
    val blue: Color,
    val track: Color,
    val amber: Color
)

private fun previewPalette(night: Boolean): PreviewPalette {
    // 只从唯一色源取。此前这里手抄了一整份，muted / faint 一直停在对比度整改前的旧值，
    // 于是"设计预览"展示的是一套已经不存在的配色。
    val colors = WidgetColors(night = night)
    return PreviewPalette(
        background = colors.backgroundColor,
        // 挂件在 RemoteViews / Canvas 上另有一组不透明底色（backgroundArgb / trackArgb），
        // 预览的 surface 与 track 对应的就是它们，不是 surfaceColor / trackColor。
        surface = Color(colors.backgroundArgb),
        text = colors.textColor,
        muted = colors.mutedColor,
        faint = colors.faintColor,
        divider = colors.dividerColor,
        blue = colors.blueColor,
        track = Color(colors.trackArgb),
        amber = colors.amberColor
    )
}

@Composable
private fun WidgetDesignGallery(night: Boolean) {
    val p = previewPalette(night)
    Column(
        modifier = Modifier.fillMaxSize().background(p.background).padding(horizontal = 20.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(13.dp)
    ) {
        Text("TOKENLEDGER", color = p.faint, fontSize = 10.sp, letterSpacing = 2.sp)
        Text("桌面卡片", color = p.text, fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text("样式由每个 Launcher 实例单独配置", color = p.muted, fontSize = 11.sp)

        Text("01  额度圆环 · 三家订阅一眼扫完", color = p.muted, fontSize = 12.sp)
        PreviewCard(Modifier.fillMaxWidth().height(132.dp), p) {
            PreviewMultiRing(p)
        }

        Text("02  额度横条 · 适合窄而长的 4×1", color = p.muted, fontSize = 12.sp)
        PreviewCard(Modifier.fillMaxWidth().height(110.dp), p) {
            PreviewMultiBar(p)
        }

        Text("03  额度与消耗 · 额度是上下文，消耗是主角", color = p.muted, fontSize = 12.sp)
        PreviewCard(Modifier.fillMaxWidth().height(142.dp), p) {
            PreviewBarUsageCombo(p)
        }
    }
}

@Composable
private fun PreviewSingleUsageCard(
    modifier: Modifier,
    p: PreviewPalette
) {
    Row(
        modifier = modifier
            .background(p.surface, RoundedCornerShape(16.dp))
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text("今日有效 Token", style = previewTextStyle(p.muted, 9, FontWeight.Normal))
            Text(
                formatCompactTokens(987_600_000L),
                style = previewTextStyle(p.text, 21, FontWeight.Bold)
            )
        }
        Spacer(Modifier.width(12.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text("预估成本", style = previewTextStyle(p.muted, 8, FontWeight.Normal))
            Text(
                formatCny(128_640.34),
                style = previewTextStyle(p.text, 11, FontWeight.Bold)
            )
            Text("更新于 8 分钟前", style = previewTextStyle(p.faint, 8, FontWeight.Normal))
        }
    }
}

@Composable
private fun PreviewCompactStateCard(text: String) {
    val p = previewPalette(night = true)
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(p.surface, RoundedCornerShape(16.dp))
            .padding(horizontal = 8.dp, vertical = 5.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text,
            style = previewTextStyle(p.text, 11, FontWeight.Bold).copy(
                textAlign = TextAlign.Center
            ),
            maxLines = 2
        )
    }
}

@Composable
private fun PreviewCompactRing(
    modifier: Modifier,
    p: PreviewPalette,
    name: String,
    percent: Float,
    value: String,
    status: String
) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(Modifier.size(52.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                val stroke = 6.dp.toPx()
                drawCircle(
                    color = p.track,
                    radius = size.minDimension / 2 - stroke / 2,
                    style = Stroke(stroke)
                )
                drawArc(
                    color = p.blue,
                    startAngle = -90f,
                    sweepAngle = 360f * percent,
                    useCenter = false,
                    topLeft = Offset(stroke / 2, stroke / 2),
                    size = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke),
                    style = Stroke(stroke, cap = StrokeCap.Round)
                )
            }
            Text(value, style = previewTextStyle(p.text, 13, FontWeight.Bold))
        }
        Spacer(Modifier.height(4.dp))
        Text(name, style = previewTextStyle(p.text, 9, FontWeight.Bold))
        Text(status, style = previewTextStyle(p.muted, 8, FontWeight.Normal))
    }
}

@Composable
private fun PreviewCard(modifier: Modifier, p: PreviewPalette, content: @Composable () -> Unit) {
    Box(
        modifier = modifier
            .background(p.surface, RoundedCornerShape(20.dp))
            .border(1.dp, p.divider, RoundedCornerShape(20.dp))
            .padding(14.dp),
        contentAlignment = Alignment.Center
    ) { content() }
}

@Composable
private fun PreviewStateRing(
    modifier: Modifier,
    p: PreviewPalette,
    ringColor: Color,
    value: String,
    status: String
) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(86.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                val stroke = 8.dp.toPx()
                drawCircle(p.track, radius = size.minDimension / 2 - stroke / 2, style = Stroke(stroke))
                drawArc(
                    color = ringColor,
                    startAngle = -90f,
                    sweepAngle = if (value == "—") 310f else 205f,
                    useCenter = false,
                    topLeft = Offset(stroke / 2, stroke / 2),
                    size = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke),
                    style = Stroke(stroke, cap = StrokeCap.Round)
                )
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(value, style = previewTextStyle(p.text, 23, FontWeight.Bold))
                Text(if (value == "—") "不可用" else "可用", style = previewTextStyle(p.muted, 8, FontWeight.Normal))
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(status, style = previewTextStyle(if (status == "正常") p.muted else ringColor, 10, FontWeight.Bold))
    }
}

@Composable
private fun PreviewMultiRing(p: PreviewPalette) {
    Row(
        modifier = Modifier.fillMaxSize(),
        horizontalArrangement = Arrangement.SpaceAround,
        verticalAlignment = Alignment.CenterVertically
    ) {
        PreviewSingleRingItem(p, name = "Codex", percent = 0.75f, percentText = "75%", label = "5 小时额度")
        PreviewSingleRingItem(p, name = "Claude", percent = 0.63f, percentText = "63%", label = "5 小时额度")
        PreviewSingleRingItem(p, name = "Antigravity", percent = 0.42f, percentText = "42%", label = "主要额度")
    }
}

@Composable
private fun PreviewSingleRingItem(
    p: PreviewPalette,
    name: String,
    percent: Float,
    percentText: String,
    label: String,
    isError: Boolean = false
) {
    val ringColor = if (isError) Color(0xFFFF625A) else p.blue
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(64.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                val stroke = 6.dp.toPx()
                drawCircle(p.track, radius = size.minDimension / 2 - stroke / 2, style = Stroke(stroke))
                drawArc(
                    color = ringColor,
                    startAngle = -90f,
                    sweepAngle = if (isError) 360f else 360f * percent,
                    useCenter = false,
                    topLeft = Offset(stroke / 2, stroke / 2),
                    size = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke),
                    style = Stroke(stroke, cap = StrokeCap.Round)
                )
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(percentText, style = previewTextStyle(if (isError) ringColor else p.text, 15, FontWeight.Bold))
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(name, style = previewTextStyle(p.text, 11, FontWeight.Bold))
        Text(label, style = previewTextStyle(p.muted, 9, FontWeight.Normal))
    }
}

@Composable
private fun PreviewMultiBar(p: PreviewPalette) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.SpaceAround) {
        PreviewBarRowItem(p, "Codex", 0.75f, "75%")
        PreviewBarRowItem(p, "Claude", 0.63f, "63%")
        PreviewBarRowItem(p, "Antigravity", 0.42f, "42%")
    }
}

@Composable
private fun PreviewBarRowItem(
    p: PreviewPalette,
    name: String,
    fraction: Float,
    valueText: String,
    isError: Boolean = false
) {
    val barColor = if (isError) Color(0xFFFF625A) else p.blue
    val displayValue = if (isError) "不可用" else valueText
    val displayFraction = if (isError) 0f else fraction
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(6.dp).background(barColor, RoundedCornerShape(3.dp)))
            Spacer(Modifier.width(6.dp))
            Text(name, style = previewTextStyle(p.text, 11, FontWeight.Bold), modifier = Modifier.weight(1f))
            Text(displayValue, style = previewTextStyle(if (isError) barColor else p.text, 11, FontWeight.Bold))
        }
        Spacer(Modifier.height(3.dp))
        Box(
            Modifier.fillMaxWidth().height(6.dp).background(p.track, RoundedCornerShape(3.dp))
        ) {
            Box(
                Modifier.fillMaxWidth(displayFraction).fillMaxHeight().background(barColor, RoundedCornerShape(3.dp))
            )
        }
    }
}

@Composable
private fun PreviewBarUsageCombo(p: PreviewPalette) {
    Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.SpaceAround) {
            PreviewBarRowItem(p, "Codex", 0.75f, "75%")
            Spacer(Modifier.height(6.dp))
            PreviewBarRowItem(p, "Claude", 0.63f, "63%")
            Spacer(Modifier.height(6.dp))
            PreviewBarRowItem(p, "Antigravity", 0.42f, "42%")
        }
        Spacer(Modifier.width(12.dp))
        Box(Modifier.width(1.dp).fillMaxHeight().background(p.divider))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
            Text("今日 · 有效 Token", style = previewTextStyle(p.muted, 10, FontWeight.Normal))
            Text("987.6M", style = previewTextStyle(p.text, 22, FontWeight.Bold))
            Spacer(Modifier.height(3.dp))
            PreviewDeltaBadge(p)
            Spacer(Modifier.height(6.dp))
            Box(Modifier.fillMaxWidth().height(1.dp).background(p.divider))
            Spacer(Modifier.height(6.dp))
            Text("预计成本", style = previewTextStyle(p.muted, 10, FontWeight.Normal))
            Text("¥128,640.34", style = previewTextStyle(p.text, 14, FontWeight.Bold))
        }
    }
}

private fun previewTextStyle(color: Color, size: Int, weight: FontWeight) = TextStyle(
    color = color,
    fontSize = size.sp,
    fontWeight = weight,
    fontFeatureSettings = "tnum",
    textAlign = TextAlign.Start
)

@Composable
private fun PreviewDeltaBadge(p: PreviewPalette) {
    Box(
        Modifier
            .background(p.amber.copy(alpha = 0.14f), RoundedCornerShape(8.dp))
            .padding(horizontal = 6.dp, vertical = 3.dp)
    ) {
        Text("+12.4%", style = previewTextStyle(p.amber, 10, FontWeight.Bold))
    }
}
