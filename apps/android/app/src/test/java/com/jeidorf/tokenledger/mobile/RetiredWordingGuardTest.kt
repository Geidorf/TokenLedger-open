package com.jeidorf.tokenledger.mobile

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Android 旧叫法守卫（T10.207，T10.154 §1「不再使用的叫法」与 §6.3 末段留给 A3 的 Android 部分）。
 *
 * `main` 源集的 Kotlin 字符串字面量（含模板的静态片段、模板表达式里嵌套的字符串、原始字符串）与
 * `res/values` 各目录下 `strings.xml` 的文字不得再出现已退役的叫法。注释与标识符不是界面文字，不检查。
 * 规则与桌面 `src/utils/costNaming.guard.test.ts` 同一张表，另加 Android 自己退役过的「隐身」与
 * 「次请求」（记录数是账本行数，T10.156 IA v2、GLB-02）。
 */
class RetiredWordingGuardTest {
    private data class Rule(val pattern: Regex, val use: String)

    private val rules = listOf(
        Rule(Regex("成本"), "预估费用 / 费用（预估成本、估算成本、预估总成本、预计成本、花费成本、成本占比等都已退役）"),
        Rule(Regex("花费"), "预估费用（花费金额、花费成本已退役）"),
        Rule(Regex("预估金额"), "预估费用"),
        Rule(
            Regex("金额(?:视角|趋势|分布|占比|不可得|已隐藏|隐身|变化|排序)|隐藏金额|消耗金额|模型金额|按金额|用量与金额"),
            "费用趋势、模型费用分布、费用占比、不可得、费用已隐藏、隐藏费用、按费用排序、用量与费用"
        ),
        Rule(Regex("""^\s*金额\s*$"""), "费用（「金额」不再作标签）"),
        Rule(Regex("(?<!预估)支出"), "费用（「支出」只留给 B 期的「预估支出」）"),
        Rule(Regex("估算节省|预估节省|节省金额"), "缓存净节省"),
        Rule(Regex("写入费用"), "缓存写入溢价"),
        Rule(Regex("""/1k\b"""), "单位费用 ¥x/百万 Token"),
        Rule(Regex("""回本率|性价比|\bROI\b|划算"""), "回本倍数（B 期）"),
        Rule(Regex("实时汇率"), "换算汇率"),
        Rule(Regex("隐身"), "隐藏费用 / 费用已隐藏（成本隐身、隐身预估成本已退役）"),
        Rule(Regex("(?<!逐)次请求|请求次数|请求数"), "N 条记录 / 记录数（记录数是账本行数，不是请求次数）")
    )

    /**
     * 暂不归本任务改的命中（文件相对 `com/jeidorf/tokenledger/mobile/`，值为命中的词）。
     * 不校验「条目已失效」：并行任务先合入改掉后，这里只是多了一条无害的豁免，由 root 顺手删。
     */
    private val tolerated = mapOf(
        // QuotaUnit.Requests：供应商按请求计的额度单位，本来就是请求次数，不是账本记录数。
        "LedgerUiLogic.kt" to setOf("次请求")
    )

    private data class Hit(val file: String, val text: String, val term: String, val rule: Int)

    private fun hits(file: String, texts: List<String>): List<Hit> = texts.flatMap { text ->
        rules.mapIndexedNotNull { index, rule ->
            rule.pattern.find(text)?.let { Hit(file, text.trim(), it.value, index) }
        }
    }

    @Test
    fun `守卫本身：注释不算，字面量、模板片段、嵌套与原始字符串都算`() {
        val fake = listOf(
            "// 注释里提到预估成本不算",
            "/* 成本 /* 嵌套注释 */ 花费 */",
            "/** KDoc 里的「金额已隐藏」也不算 */",
            "val label = \"预估费用\"",
            "val a = \"今日成本\"",
            "val b = \"\${label}金额视角 · \$count 次请求\"",
            "val c = listOf(\"金额\", \"逐次请求\", \"预估支出 ≈¥42\", '\"', \"缓存净节省\", \"\${if (x) \"含缓存\" else \"有效\"}\")",
            "val d = \"\"\"隐身模式 \${\"花费\"}\"\"\"",
            "val e = \"转义 \\\"预估成本\\\" 不漏\"",
            "fun `名字里的成本`() = \"反引号标识符不是界面文字\""
        ).joinToString("\n")
        val found = hits("fake.kt", KotlinStringLiterals.of(fake)).map { it.text to it.rule }
        assertEquals(
            listOf(
                "今日成本" to 0,
                "金额视角 ·" to 3,
                "次请求" to 12,
                "金额" to 4,
                "隐身模式" to 11,
                "花费" to 1,
                "转义 \"预估成本\" 不漏" to 0
            ),
            found
        )
        // 字面量本身一个不漏（含嵌套在模板表达式里的两段）。
        assertTrue(KotlinStringLiterals.of(fake).containsAll(listOf("预估费用", "逐次请求", "含缓存", "有效", "缓存净节省")))
        // strings.xml：只看文字节点，XML 注释不算。
        assertEquals(
            listOf("预估成本 ¥1"),
            xmlTexts("<resources><!-- 预估成本 --><string name=\"a\">预估成本 ¥1</string></resources>")
        )
    }

    @Test
    fun `扫描范围是真实的 main 源集，且读得到新叫法`() {
        val sources = mainKotlinSources()
        assertTrue("main 源集文件数 ${sources.size}", sources.size > 80)
        val ledger = KotlinStringLiterals.of(sources.getValue("LedgerUiLogic.kt"))
        listOf("含缓存", "预估费用已隐藏，双击显示", "隐藏预估费用", "不可得", "预估费用不可得", "当前范围暂无费用趋势")
            .forEach { assertTrue("LedgerUiLogic.kt 应含「$it」", it in ledger) }
        assertTrue(
            "strings.xml 应含预估费用",
            stringResources().values.flatten().any { it.contains("预估费用") }
        )
        // A-Q8：Token 口径的「全部」改叫「含缓存」；存储值不变，已存偏好照常读回。
        assertEquals("含缓存", TokenDisplayMode.All.label)
        assertEquals(TokenDisplayMode.All, TokenDisplayMode.fromStored("all"))
    }

    @Test
    fun `Android main 源集的界面文字里没有旧叫法`() {
        val found = mainKotlinSources().flatMap { (file, source) -> hits(file, KotlinStringLiterals.of(source)) } +
            stringResources().flatMap { (file, texts) -> hits(file, texts) }
        val offending = found
            .filterNot { hit -> tolerated[hit.file]?.contains(hit.term) == true }
            .map { "${it.file}：「${it.text}」→ 改用 ${rules[it.rule].use}" }
        assertEquals(emptyList<String>(), offending)
    }

    // ---- 源码读取 ----

    private fun moduleDir(path: String): File =
        listOf(File(path), File("app", path), File("apps/android/app", path)).firstOrNull { it.exists() }
            ?: error("找不到 $path（当前目录 ${File(".").absolutePath}）")

    /** `src/main/java` 下全部 .kt，键为相对 `com/jeidorf/tokenledger/mobile/` 的路径。 */
    private fun mainKotlinSources(): Map<String, String> {
        val root = moduleDir("src/main/java/com/jeidorf/tokenledger/mobile")
        return root.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .associate { it.relativeTo(root).invariantSeparatorsPath to it.readText(Charsets.UTF_8) }
    }

    private fun stringResources(): Map<String, List<String>> {
        val res = moduleDir("src/main/res")
        return res.listFiles().orEmpty()
            .filter { it.isDirectory && it.name.startsWith("values") }
            .mapNotNull { dir -> File(dir, "strings.xml").takeIf(File::isFile)?.let { dir.name to it } }
            .associate { (dirName, file) -> "res/$dirName/strings.xml" to xmlTexts(file.readText(Charsets.UTF_8)) }
    }

    private fun xmlTexts(xml: String): List<String> =
        Regex(">([^<]+)<").findAll(xml.replace(Regex("<!--[\\s\\S]*?-->"), ""))
            .map { it.groupValues[1] }
            .filter { it.isNotBlank() }
            .toList()
}

/**
 * Kotlin 源码里的字符串字面量（静态片段）。跳过行注释、可嵌套的块注释、字符字面量与反引号标识符；
 * `$name` 与 `${…}` 把字符串切成片段，模板表达式里的字符串照样收集。只为守卫测试服务，不求覆盖全部语法。
 */
internal class KotlinStringLiterals private constructor(private val s: String) {
    private val out = mutableListOf<String>()
    private var i = 0

    companion object {
        fun of(source: String): List<String> = KotlinStringLiterals(source).also { it.code(untilBrace = false) }.out
    }

    private fun code(untilBrace: Boolean) {
        var depth = 0
        while (i < s.length) {
            val c = s[i]
            when {
                s.startsWith("//", i) -> { while (i < s.length && s[i] != '\n') i++ }
                s.startsWith("/*", i) -> blockComment()
                s.startsWith("\"\"\"", i) -> { i += 3; string(raw = true) }
                c == '"' -> { i++; string(raw = false) }
                c == '\'' -> charLiteral()
                c == '`' -> { i++; while (i < s.length && s[i] != '`') i++; i++ }
                c == '{' -> { depth++; i++ }
                c == '}' -> {
                    i++
                    if (untilBrace && depth == 0) return
                    depth--
                }
                else -> i++
            }
        }
    }

    private fun blockComment() {
        var depth = 0
        while (i < s.length) {
            when {
                s.startsWith("/*", i) -> { depth++; i += 2 }
                s.startsWith("*/", i) -> { depth--; i += 2; if (depth == 0) return }
                else -> i++
            }
        }
    }

    private fun charLiteral() {
        i++
        while (i < s.length && s[i] != '\'') {
            if (s[i] == '\\') i++
            i++
        }
        i++
    }

    private fun string(raw: Boolean) {
        val buf = StringBuilder()
        fun flush() {
            if (buf.isNotEmpty()) out += buf.toString()
            buf.clear()
        }
        while (i < s.length) {
            val c = s[i]
            when {
                raw && s.startsWith("\"\"\"", i) -> {
                    var run = 0
                    while (i + run < s.length && s[i + run] == '"') run++
                    repeat(run - 3) { buf.append('"') }
                    i += run
                    flush()
                    return
                }
                !raw && c == '"' -> { i++; flush(); return }
                !raw && c == '\\' && i + 1 < s.length -> {
                    val next = s[i + 1]
                    if (next == 'u' && i + 5 < s.length) {
                        buf.append(s.substring(i + 2, i + 6).toInt(16).toChar())
                        i += 6
                    } else {
                        buf.append(
                            when (next) {
                                'n' -> '\n'
                                't' -> '\t'
                                'r' -> '\r'
                                'b' -> '\b'
                                else -> next
                            }
                        )
                        i += 2
                    }
                }
                c == '$' && s.startsWith("\${", i) -> {
                    flush()
                    i += 2
                    code(untilBrace = true)
                }
                c == '$' && i + 1 < s.length && (s[i + 1].isLetter() || s[i + 1] == '_') -> {
                    flush()
                    i++
                    while (i < s.length && (s[i].isLetterOrDigit() || s[i] == '_')) i++
                }
                else -> { buf.append(c); i++ }
            }
        }
        flush()
    }
}
