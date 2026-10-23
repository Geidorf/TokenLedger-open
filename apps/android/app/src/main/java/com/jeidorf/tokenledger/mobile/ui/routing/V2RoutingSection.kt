package com.jeidorf.tokenledger.mobile.ui.routing

import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.Text
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.Modifier
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.LedgerType
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2Card

/**
 * 「路由」一级页（重构方案 R1 只搭骨架）：网关动画要读桌面网关的实时路由记录，这份数据要等同步
 * 接入后才有。在那之前这里如实说明缺什么，不画假的流向、不编数字。
 * R4 会在这里换成 Agent → 网关 → 账号的动画场景与最近调用列表。
 */
internal fun LazyListScope.v2RoutingItems(palette: MobileV2Palette) {
    item(key = "routing-heading", contentType = "heading") {
        Text(
            "网关路由",
            color = palette.text,
            style = LedgerType.titleM,
            modifier = Modifier.semantics { heading() }
        )
    }
    item(key = "routing-pending", contentType = "status") {
        V2Card(palette) {
            Text("还没有路由数据", color = palette.text, style = LedgerType.titleM)
            Text(
                "桌面网关的实时路由记录接入同步后，这里会显示每个 Agent 的请求经网关" +
                    "分到哪个账号、哪个账号在应答、哪个在限流休息，以及最近的调用。",
                color = palette.muted,
                fontSize = LedgerFont.label
            )
        }
    }
}
