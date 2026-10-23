package com.jeidorf.tokenledger.mobile.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * T10.208（A1 导航壳）→ 重构方案 v2：顶栏标题即分区名、副标题并入筛选入口
 * （用户决定 V-Q3）两条分支逻辑，从 `LedgerDashboardV2Screen` 的顶栏调用点抽成
 * [v2TopBarTitle] / [v2TopBarSubtitle] 两个纯函数单独测，避免以后再改标题/副标题时
 * 把两件不同的事（导航项文字 vs 页面标题）混在一起改。
 */
class V2TopBarPresentationTest {

    @Test
    fun settingsTitleIsFixedRegardlessOfDestinationOrEntityMode() {
        assertEquals(
            "设置",
            v2TopBarTitle(
                showSettings = true, entityMode = false, destination = MobileDestination.Usage,
                entityLabel = "codex"
            )
        )
        // 设置优先于专属看板：两者理论上不会同时为真，但优先级必须钉死，不能悄悄倒过来。
        assertEquals(
            "设置",
            v2TopBarTitle(
                showSettings = true, entityMode = true, destination = MobileDestination.Usage,
                entityLabel = "codex"
            )
        )
    }

    @Test
    fun entityModeTitleUsesEntityLabelNotDestinationOrRange() {
        assertEquals(
            "codex",
            v2TopBarTitle(
                showSettings = false, entityMode = true, destination = MobileDestination.Usage,
                entityLabel = "codex"
            )
        )
    }

    @Test
    fun destinationTitleIsItsOwnLabel() {
        // 重构方案 v2：顶栏标题就是分区名（用量/路由/额度/我的），范围由页内范围栏展示，不再进标题。
        for ((destination, label) in listOf(
            MobileDestination.Usage to "用量",
            MobileDestination.Routing to "路由",
            MobileDestination.Quota to "额度",
            MobileDestination.Me to "我的"
        )) {
            assertEquals(
                label,
                v2TopBarTitle(
                    showSettings = false, entityMode = false, destination = destination,
                    entityLabel = ""
                )
            )
        }
    }

    @Test
    fun settingsSubtitleIsBlankSoTopBarFallsBackToOneLine() {
        assertEquals(
            "",
            v2TopBarSubtitle(
                showSettings = true, entityMode = false, destination = MobileDestination.Usage,
                entityKind = null, entityLabel = "", querySummary = "今日 · 全部设备"
            )
        )
    }

    @Test
    fun quotaSubtitleIsBlankMatchingOldV2QueryContextVisibilityRule() {
        // 与旧版 V2QueryContext 只在 destination != Quota 时出现的口径一致：额度页没有
        // 可筛选的查询摘要，不能因为「并进顶栏」就顺带让额度页也长出摘要来。
        assertEquals(
            "",
            v2TopBarSubtitle(
                showSettings = false, entityMode = false, destination = MobileDestination.Quota,
                entityKind = null, entityLabel = "", querySummary = "今日 · 全部设备"
            )
        )
    }

    @Test
    fun routingSubtitleIsBlankBecauseRoutingHasNoUsageQuery() {
        assertEquals(
            "",
            v2TopBarSubtitle(
                showSettings = false, entityMode = false, destination = MobileDestination.Routing,
                entityKind = null, entityLabel = "", querySummary = "今日 · 全部设备"
            )
        )
    }

    @Test
    fun usageAndMeSubtitleIsQuerySummary() {
        for (destination in listOf(MobileDestination.Usage, MobileDestination.Me)) {
            assertEquals(
                "今日 · 全部设备",
                v2TopBarSubtitle(
                    showSettings = false, entityMode = false, destination = destination,
                    entityKind = null, entityLabel = "", querySummary = "今日 · 全部设备"
                )
            )
        }
    }

    @Test
    fun entitySubtitleIsBreadcrumbOfKindLabelAndQuerySummary() {
        assertEquals(
            "工具 · codex · 今日 · 全部设备",
            v2TopBarSubtitle(
                showSettings = false, entityMode = true, destination = MobileDestination.Usage,
                entityKind = "tool", entityLabel = "codex", querySummary = "今日 · 全部设备"
            )
        )
        assertEquals(
            "模型 · gpt-5 · 本周 · 全部设备",
            v2TopBarSubtitle(
                showSettings = false, entityMode = true, destination = MobileDestination.Usage,
                entityKind = "model", entityLabel = "gpt-5", querySummary = "本周 · 全部设备"
            )
        )
    }

    @Test
    fun entitySubtitleDropsKindPrefixWhenKindUnknown() {
        // 数据还没到、查询里的 DashboardEntity 也拿不到 kind 时（理论上不该发生，但类型上
        // entityKind 就是可空的），面包屑退化成「名称 · 查询摘要」，不能崩、也不能印出
        // "null · "这种半成品前缀。
        assertEquals(
            "来源下钻 · 今日 · 全部设备",
            v2TopBarSubtitle(
                showSettings = false, entityMode = true, destination = MobileDestination.Usage,
                entityKind = null, entityLabel = "来源下钻", querySummary = "今日 · 全部设备"
            )
        )
    }

    @Test
    fun entityModeTakesPriorityOverQuotaBlankRule() {
        // entityMode 分支必须排在「destination == Quota -> 空」前面：下钻页在导航模型里
        // 不会真的是 Quota 目的地，但两条分支的判断顺序仍然要显式钉住，不能因为顺序调换
        // 而让专属看板的面包屑消失。
        assertEquals(
            "工具 · codex · 今日 · 全部设备",
            v2TopBarSubtitle(
                showSettings = false, entityMode = true, destination = MobileDestination.Quota,
                entityKind = "tool", entityLabel = "codex", querySummary = "今日 · 全部设备"
            )
        )
    }

    @Test
    fun entityIdentityDotUsesTheToolSlotForToolsAndChartOneOtherwise() {
        // R-67（§4.1 专属看板标题前 10dp 身份色点）：工具取两端同一张槽位表的主槽位，模型与其余来源统一 chart-1。
        assertEquals(2, v2EntityIdentitySlot("tool", "codex"))
        assertEquals(6, v2EntityIdentitySlot("TOOL", "Claude"))
        assertEquals(1, v2EntityIdentitySlot("model", "gpt-5"))
        assertEquals(1, v2EntityIdentitySlot(null, "codex"))
    }
}
