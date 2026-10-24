package com.jeidorf.tokenledger.mobile.budget

import org.json.JSONArray
import org.json.JSONObject
import java.time.OffsetDateTime

/**
 * 预算状态快照（契约 docs/contracts/budget-snapshot-v1.md）的 Android 侧：解析
 * `get_budget_snapshots_v1` 的返回体，决定这一次要推哪些本地通知。预算由桌面按已经发生的
 * 用量算好，手机原样显示百分比，不计算、不外推，也拿不到金额。只有纯 Kotlin，便于单测。
 */

enum class BudgetLevel(val wire: String) {
    Ok("ok"), Warn("warn"), Over("over");

    companion object {
        fun fromWire(value: String): BudgetLevel? = entries.firstOrNull { it.wire == value }
    }
}

enum class BudgetPeriod(val wire: String, val label: String) {
    Day("day", "今日"), Week("week", "本周"), Month("month", "本月");

    companion object {
        fun fromWire(value: String): BudgetPeriod? = entries.firstOrNull { it.wire == value }
    }
}

enum class BudgetMetric(val wire: String, val label: String) {
    Cost("cost", "费用"), Tokens("tokens", "Token");

    companion object {
        fun fromWire(value: String): BudgetMetric? = entries.firstOrNull { it.wire == value }
    }
}

data class BudgetItem(
    val device: String,
    val id: String,
    val label: String,
    val period: BudgetPeriod,
    val metric: BudgetMetric,
    val periodStart: String,
    val percent: Int,
    val level: BudgetLevel,
) {
    /** 契约 §5 的去重键：每条预算每个周期每一档只推一次。 */
    fun key(level: BudgetLevel = this.level): String = "$device|$id|$periodStart|${level.wire}"
}

data class BudgetDeviceSnapshot(
    val device: String,
    /** 服务器时钟下快照的年龄（serverTime − receivedAt），不依赖手机与桌面时钟一致。 */
    val ageSeconds: Long,
    val budgets: List<BudgetItem>,
)

class BudgetSnapshotFormatException(message: String) : IllegalArgumentException(message)

object BudgetSnapshots {
    private val DEVICE = Regex("^[0-9a-f]{16,64}$")
    private val BUDGET_ID = Regex("^[0-9a-f]{16}$")
    private val DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")

    /**
     * 整体结构不对时抛 [BudgetSnapshotFormatException]；单条预算不合契约只丢这一条，
     * 不让一行坏数据挡住其他提醒。
     */
    fun parse(body: String): List<BudgetDeviceSnapshot> {
        val root = runCatching { JSONObject(body) }.getOrNull()
            ?: throw BudgetSnapshotFormatException("not an object")
        val serverTime = parseTime(root.optString("serverTime"))
            ?: throw BudgetSnapshotFormatException("serverTime")
        val rows = root.optJSONArray("snapshots") ?: throw BudgetSnapshotFormatException("snapshots")
        return (0 until rows.length()).mapNotNull { index ->
            val row = rows.optJSONObject(index) ?: return@mapNotNull null
            val device = row.optString("device").takeIf { DEVICE.matches(it) } ?: return@mapNotNull null
            val received = parseTime(row.optString("receivedAt")) ?: return@mapNotNull null
            val snapshot = row.optJSONObject("snapshot") ?: return@mapNotNull null
            if (snapshot.optInt("v", -1) != 1) return@mapNotNull null
            val budgets = snapshot.optJSONArray("budgets") ?: JSONArray()
            BudgetDeviceSnapshot(
                device = device,
                ageSeconds = serverTime.toEpochSecond() - received.toEpochSecond(),
                budgets = (0 until budgets.length()).mapNotNull { parseBudget(device, budgets.optJSONObject(it)) },
            )
        }
    }

    private fun parseBudget(device: String, value: JSONObject?): BudgetItem? {
        value ?: return null
        val id = value.optString("id").takeIf { BUDGET_ID.matches(it) } ?: return null
        val label = value.optString("label").trim().takeIf { it.isNotEmpty() && it.length <= 32 } ?: return null
        val period = BudgetPeriod.fromWire(value.optString("period")) ?: return null
        val metric = BudgetMetric.fromWire(value.optString("metric")) ?: return null
        val periodStart = value.optString("periodStart").takeIf { DATE.matches(it) } ?: return null
        val rawPercent = value.opt("percent") as? Number ?: return null
        val percent = rawPercent.toLong().takeIf { it in 0..99_999 && rawPercent.toDouble() == it.toDouble() } ?: return null
        val level = BudgetLevel.fromWire(value.optString("level")) ?: return null
        return BudgetItem(device, id, label, period, metric, periodStart, percent.toInt(), level)
    }

    private fun parseTime(value: String): OffsetDateTime? = runCatching { OffsetDateTime.parse(value) }.getOrNull()
}

data class BudgetNotification(val key: String, val title: String, val body: String)

data class BudgetAlertPlan(
    val notifications: List<BudgetNotification>,
    /** 去重记录：键 → 记下的时间（毫秒）。 */
    val ledger: Map<String, Long>,
)

object BudgetAlertPlanner {
    /** 超过这个年龄的快照不推通知：桌面可能已离线，周期也可能已过。 */
    const val MAX_AGE_SECONDS = 12L * 60 * 60
    const val MAX_PER_READ = 3
    private const val RETENTION_MILLIS = 40L * 24 * 60 * 60 * 1000
    /** 8 台设备 × 32 条 × 接近/超出两档 = 512，再留同样多给过期周期的记录。 */
    private const val MAX_LEDGER = 1024

    /**
     * [prime] 为 true（刚打开开关、换了账号）时只把当前已接近或超出的预算记为已推，不补发。
     * 被每次上限挡住的提醒不记为已推，下次读取再推。
     */
    fun plan(
        snapshots: List<BudgetDeviceSnapshot>,
        ledger: Map<String, Long>,
        nowMillis: Long,
        prime: Boolean,
    ): BudgetAlertPlan {
        val next = ledger.filterValues { nowMillis - it in 0 until RETENTION_MILLIS }.toMutableMap()
        val candidates = snapshots
            .filter { it.ageSeconds in -300..MAX_AGE_SECONDS }
            .flatMap { it.budgets }
            .filter { it.level != BudgetLevel.Ok && it.key() !in next }
            .distinctBy { it.key() }
            .sortedWith(
                compareByDescending<BudgetItem> { it.level == BudgetLevel.Over }
                    .thenByDescending { it.percent }
                    .thenBy { it.key() }
            )
        val notifications = mutableListOf<BudgetNotification>()
        for (item in candidates) {
            if (!prime && notifications.size >= MAX_PER_READ) break
            next[item.key()] = nowMillis
            // 直接看到超出时，接近那一档同时记为已推。
            if (item.level == BudgetLevel.Over) next.putIfAbsent(item.key(BudgetLevel.Warn), nowMillis)
            if (!prime) notifications += notification(item)
        }
        // 超出上限时先丢不在当前快照里的旧记录；仍在接近或超出的预算一条也不丢，否则下次会重推。
        val trimmed = if (next.size > MAX_LEDGER) {
            val active = activeKeys(snapshots)
            val (kept, rest) = next.entries.partition { it.key in active }
            (kept + rest.sortedByDescending { it.value }.take((MAX_LEDGER - kept.size).coerceAtLeast(0)))
                .associate { it.key to it.value }
        } else {
            next
        }
        return BudgetAlertPlan(notifications, trimmed)
    }

    private fun activeKeys(snapshots: List<BudgetDeviceSnapshot>): Set<String> = snapshots
        .flatMap { it.budgets }
        .filter { it.level != BudgetLevel.Ok }
        .flatMap { listOf(it.key(), it.key(BudgetLevel.Warn)) }
        .toSet()

    /** 与桌面系统通知同一写法，不写金额。 */
    fun notification(item: BudgetItem): BudgetNotification {
        val title = when (item.level) {
            BudgetLevel.Over -> "${item.label} 已超出预算"
            else -> "${item.label} 预算已用 ${item.percent}%"
        }
        val body = "${item.period.label}${item.metric.label}预算已用 ${item.percent}%"
        return BudgetNotification(item.key(), title, body)
    }

    fun encodeLedger(ledger: Map<String, Long>): String =
        JSONObject().apply { ledger.forEach { (key, at) -> put(key, at) } }.toString()

    fun decodeLedger(value: String?): Map<String, Long> {
        val json = value?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return emptyMap()
        return json.keys().asSequence().mapNotNull { key ->
            (json.opt(key) as? Number)?.toLong()?.let { key to it }
        }.toMap()
    }
}
