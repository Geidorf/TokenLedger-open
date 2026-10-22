package com.jeidorf.tokenledger.mobile.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * T10.208（A1 导航壳）：顶栏标题跟随范围（design 关闭决定 #5）、副标题并入筛选入口
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
                showSettings = true, entityMode = false, destination = MobileDestination.Overview,
                entityLabel = "codex", rangeLabel = "本周"
            )
        )
        // 设置优先于专属看板：两者理论上不会同时为真，但优先级必须钉死，不能悄悄倒过来。
        assertEquals(
            "设置",
            v2TopBarTitle(
                showSettings = true, entityMode = true, destination = MobileDestination.Insights,
                entityLabel = "codex", rangeLabel = "本周"
            )
        )
    }

    @Test
    fun entityModeTitleUsesEntityLabelNotDestinationOrRange() {
        assertEquals(
            "codex",
            v2TopBarTitle(
                showSettings = false, entityMode = true, destination = MobileDestination.Insights,
                entityLabel = "codex", rangeLabel = "本周"
            )
        )
    }

    @Test
    fun overviewTitleFollowsSelectedRangeInsteadOfDestinationLabel() {
        // design 关闭决定 #5：导航项仍叫「今日」，但顶栏标题跟着所选范围走。
        assertEquals(
            "本周",
            v2TopBarTitle(
                showSettings = false, entityMode = false, destination = MobileDestination.Overview,
                entityLabel = "", rangeLabel = "本周"
            )
        )
        assertEquals(
            "今日",
            v2TopBarTitle(
                showSettings = false, entityMode = false, destination = MobileDestination.Overview,
                entityLabel = "", rangeLabel = "今日"
            )
        )
    }

    @Test
    fun otherDestinationsKeepTheirOwnLabelRegardlessOfRange() {
        // 只有「今日」目的地跟范围；复盘/额度/展示三个目的地不跟——它们的页面内容
        // 本来就有自己的范围/页签展示方式，标题不需要（也不应该）跟着全局范围变。
        assertEquals(
            "复盘",
            v2TopBarTitle(
                showSettings = false, entityMode = false, destination = MobileDestination.Insights,
                entityLabel = "", rangeLabel = "本月"
            )
        )
        assertEquals(
            "额度",
            v2TopBarTitle(
                showSettings = false, entityMode = false, destination = MobileDestination.Quota,
                entityLabel = "", rangeLabel = "本月"
            )
        )
        assertEquals(
            "展示",
            v2TopBarTitle(
                showSettings = false, entityMode = false, destination = MobileDestination.Widget,
                entityLabel = "", rangeLabel = "本月"
            )
        )
    }

    @Test
    fun settingsSubtitleIsBlankSoTopBarFallsBackToOneLine() {
        assertEquals(
            "",
            v2TopBarSubtitle(
                showSettings = true, entityMode = false, destination = MobileDestination.Overview,
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
    fun nonQuotaDestinationSubtitleIsQuerySummary() {
        for (destination in listOf(MobileDestination.Overview, MobileDestination.Insights, MobileDestination.Widget)) {
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
                showSettings = false, entityMode = true, destination = MobileDestination.Insights,
                entityKind = "tool", entityLabel = "codex", querySummary = "今日 · 全部设备"
            )
        )
        assertEquals(
            "模型 · gpt-5 · 本周 · 全部设备",
            v2TopBarSubtitle(
                showSettings = false, entityMode = true, destination = MobileDestination.Insights,
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
                showSettings = false, entityMode = true, destination = MobileDestination.Insights,
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
