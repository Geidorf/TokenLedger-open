package com.jeidorf.tokenledger.mobile

import com.jeidorf.tokenledger.mobile.ui.foundation.LEDGER_CHART_SLOTS
import com.jeidorf.tokenledger.mobile.ui.foundation.LEDGER_CHART_SLOT_OTHER

internal fun dashboardQuerySummary(query: DashboardQuery): String = buildList {
    add(dashboardRangeLabel(query))
    add(if (query.machines.isEmpty()) "全部设备" else "设备：${query.machines.joinToString("、")}")
    if (query.tools.isNotEmpty()) add("工具：${query.tools.joinToString("、")}")
    if (query.models.isNotEmpty()) add("模型：${query.models.joinToString("、")}")
    query.search?.takeIf { it.isNotBlank() }?.let { add("搜索：$it") }
}.joinToString(" · ")

/**
 * 旧的四色工具索引（0…3），只为 A5 `V2SourcesSection` 保留。
 * A2 `V2ToolDistributionCard` 已改用 [assignToolChartSlots]；A5 迁完后删除。
 * 四色循环在六个工具时两两撞色（T10.173 D3），新代码不要再用。
 */
internal fun stableToolColorIndex(name: String): Int = when (name.lowercase(java.util.Locale.ROOT)) {
    "codex" -> 0
    "antigravity" -> 1
    "marvis" -> 2
    "claude", "claude-code", "claude code" -> 3
    else -> Math.floorMod(name.lowercase(java.util.Locale.ROOT).hashCode(), 4)
}

/**
 * 工具身份 → 图表槽位 1…8（T10.173 §3.8，用户决定 V-Q6：桌面 `colorForTool` 用同一张表）。
 * 槽位 N 对应 [com.jeidorf.tokenledger.mobile.ui.foundation.LedgerColors.chartSlot] 的第 N 色，
 * 即桌面 `--chart-N`。表里只放本名；别名先经 [TOOL_ALIASES] 归到本名再查表（root 决定 R-8 b）。
 */
private val TOOL_CHART_SLOTS: Map<String, Int> = mapOf(
    "antigravity" to 1, "gemini" to 1,
    "codex" to 2, "marvis" to 2, "hermes" to 2,
    "pi" to 3,
    "opencode" to 4, "workbuddy" to 4,
    "reasonix" to 5, "deepseek" to 5, "grok" to 5,
    "claude" to 6, "qclaw" to 6,
    "kilo" to 7, "kimi" to 7, "trae" to 7,
    "minimax" to 8, "zcode" to 8
)

/**
 * 同一产品的别名（R-8 b，两端逐字相同，以桌面 T10.178 的别名表为准）。旧 Android 表把
 * `claude-code` / `claude code` 也算作 claude，桌面没有这两条，按 R-8 不再保留：这两个名字
 * 现在按哈希落槽（4 / 5），要不要进两端共同的别名表由 root 定。
 */
private val TOOL_ALIASES: Map<String, String> = mapOf(
    "deepseekgui" to "deepseek",
    "dsh" to "deepseek",
    "kimidesktop" to "kimi",
    "mavis" to "marvis"
)

/**
 * 规范化工具名（R-8 a）：按桌面 `name.trim()` 的字符集去首尾空白、按 `Locale.ROOT` 小写，再把别名归到本名。
 * 不用 Kotlin 的 `trim()`：它多去 U+001C–U+001F、却不去 U+FEFF，与 JS 恰好相反，带这些字符的名字
 * 两端会落到不同的槽（T10.177 评审 P3-6）。
 */
private fun canonicalToolName(name: String): String {
    val key = name.trim(::isEcmaScriptTrimmable).lowercase(java.util.Locale.ROOT)
    return TOOL_ALIASES[key] ?: key
}

/**
 * ECMAScript `String.prototype.trim` 去掉的字符：WhiteSpace（TAB、VT、FF、ZWNBSP 与 Zs 类空格）加
 * LineTerminator（LF、CR、LS、PS）。Zs 逐个列出而不查 JVM 的字符类别：不同 JDK 的 Unicode 版本对
 * U+180E 归类不同，列死才与桌面在任何环境下同集。
 */
private fun isEcmaScriptTrimmable(c: Char): Boolean = when (c) {
    '\u0009', '\u000A', '\u000B', '\u000C', '\u000D', '\uFEFF', '\u2028', '\u2029',
    '\u0020', '\u00A0', '\u1680', '\u202F', '\u205F', '\u3000' -> true
    in '\u2000'..'\u200A' -> true
    else -> false
}

/**
 * 工具的主槽位（1…8），排名与同屏其他工具都不影响它。未登记的工具按规范化名字的
 * FNV-1a 32 位哈希（逐个 UTF-16 码元，与桌面 `charCodeAt` 一致）对 8 取模落槽（R-8 a），
 * 同一个名字在两端、任何视图、任何一次运行都落在同一槽。
 */
internal fun toolChartSlot(name: String): Int {
    val key = canonicalToolName(name)
    return TOOL_CHART_SLOTS[key] ?: hashToolChartSlot(key)
}

private fun hashToolChartSlot(key: String): Int {
    var hash = 0x811c9dc5.toInt()
    for (unit in key) {
        hash = hash xor unit.code
        hash *= 0x01000193
    }
    return Integer.remainderUnsigned(hash, LEDGER_CHART_SLOTS) + 1
}

/**
 * 同一视图里并列的几个工具按排名（下标 0 = 第一名）分槽（R-8 c、d）：撞槽时排名靠后的顺延到
 * 下一个空槽（8 之后回到 1），可复现；前 8 名互不同色。第 9 名起一律返回
 * [LEDGER_CHART_SLOT_OTHER]，画「其他」中性色，能分组的视图把它们并成一组「其他」。
 */
internal fun assignToolChartSlots(namesInRankOrder: List<String>): List<Int> {
    val used = mutableSetOf<Int>()
    return namesInRankOrder.mapIndexed { rank, name ->
        if (rank >= LEDGER_CHART_SLOTS) {
            LEDGER_CHART_SLOT_OTHER
        } else {
            var slot = toolChartSlot(name)
            // 前 8 名最多占 7 个槽，所以一定还有空槽，循环必然结束。
            while (slot in used) {
                slot = if (slot >= LEDGER_CHART_SLOTS) 1 else slot + 1
            }
            used += slot
            slot
        }
    }
}

/** 只描述完整且同口径数据的结构，不推断效率或性价比。 */
internal fun sourceCostStructureLabel(
    name: String, cost: Double?, totalCost: Double, effectiveTokens: Long,
    totalEffectiveTokens: Long, masked: Boolean, complete: Boolean
): String? {
    if (masked || !complete || cost == null || !cost.isFinite() || cost < 0 ||
        !totalCost.isFinite() || totalCost <= 0 || cost > totalCost + 0.000001 ||
        effectiveTokens < 0 || totalEffectiveTokens <= 0 || effectiveTokens > totalEffectiveTokens) return null
    return String.format(java.util.Locale.US, "%s：预估费用占比 %.1f%%，有效 Token 占比 %.1f%%", name,
        cost / totalCost * 100, effectiveTokens.toDouble() / totalEffectiveTokens * 100)
}
