
> 本文引用的 docs/task-logs/…、docs/BACKLOG.md 等路径是内部溯源标记，指向维护方私有仓库中未随本仓库发布的任务证据与待办，不是可点击的相对链接。发布范围说明见 [../internal-collaboration-materials.md](../internal-collaboration-materials.md)。

# Android 全屏摆件多模式方案 v1

> **实施状态（2026-10-17 按代码核对）**：已实现。五档摆件模式见 `AmbientMode.kt`（T6.5）；下文“草案”字样是当时的状态。

> 状态：方案草案，待协调员确认后实施。依据：2026-07-25 摆件现状清点（`LowPowerDisplayScreen.kt` 233 行 + `FullScreenWidgetV2` 单入口双分支）。
> 原则：摆件模式只改**信息编排与渲染策略**，不改统计口径、不改 Stats v2 查询契约、不隐式切换主题。沿用 REQ-ANDROID-04 已确立的"主题与摆件样式是两个独立偏好"。
> 关联：REQ-ANDROID-02/04（需修订）、ADR-005、ADR-014、NFR-01/04、`docs/archive/audits/recent-changes-20260725.md` §D1。
> 修订：2026-07-25 依真机反馈修订 D4、§4.4、V3/V7 与 §八，见文末《八、v1.1 修订：真机反馈》。

---

## 一、现状诊断

### 1.1 实际只有一个布局

`FullScreenWidgetV2`（`LedgerDashboardV2Ui.kt:3573-3644`）的全部分支：

```
maxWidth >= 600.dp ─┬─ 是 → V2LandscapeWidgetContent（横屏融合稿）
                    └─ 否 → LazyColumn { V2WidgetPreview + 一行策略说明文本 }
```

竖屏走的 `V2WidgetPreview`（`:2357-2439`）是一张固定结构的卡：品牌行 → 巨型 Token → 趋势曲线 → 成本/请求/缓存三格 → 12 周热力图 → 两个额度胶囊。顺序、构成、密度全部写死，`WidgetPresentation` 无法改变其中任何一项。

### 1.2 墨水屏模式与常规模式的真实差异

逐项清点 `WidgetPresentation.EInk` 相对 `Polished` 实际改变了什么：

| 位置 | 差异 | 性质 |
|---|---|---|
| `:3546-3552` | 横屏下"额度簇"和"日签"左右对调 | 位置互换，信息量不变 |
| `:2368` | 边框 1dp → 2dp | 描边粗细 |
| `:2370` | 圆角 24dp → 5dp | 形状 |
| `:2403` | 多画一条 `HorizontalDivider` | 分隔线 |
| `:2396` | 副标题文案 "数据变化时更新" → "15 分钟刷新" | 仅文案，无对应刷新实现差异 |
| `:2446-2456` | 额度胶囊底色改白 + 黑描边 | 配色 |

结论：**没有一项改变信息编排**。而颜色部分本来就由 `LedgerAppearance.EInk` 的 palette 负责（`:252-268`），不属于摆件模式。所以在 E-ink 主题下切换两个摆件模式，用户看到的差别接近于零——这与 REQ-ANDROID-04 "墨水屏摆件采用信息优先的布局与低刷新策略"的要求不符，是实现缺口而非设计意图。

### 1.3 另外两个约束

- `:2396` 承诺的"15 分钟刷新"在代码里没有对应实现。真实刷新策略在 `resolveLowPowerPolicy`（`LowPowerDisplayScreen.kt:47-64`）里，它只产出 `compactDetails` 和 `visibleQuotaWindowLimit` 两个开关，`allowBackgroundRefresh` 恒为 `false`，刷新节奏由 T6.2k 的 ViewModel 层统一管理（统计 5 分钟 / 额度 15 分钟），与摆件模式无关。文案是空头支票。
- 模式选择器 `V2WidgetModeStrip`（`:2295-2327`）是一个 `Row { entries.forEach { TextButton(weight(1f)) } }`。两个条目刚好，五个条目在 320dp 宽屏 + 200% 字体下必然裁切。扩容前必须先换控件。

---

## 二、设计轴：信息密度分档

五个模式排在一条**单调递增的信息密度轴**上，用户只需回答一个问题："我想在这块屏上看到多少东西。"每一档同时绑定一套渲染画风（`AmbientRenderProfile`），因此在 E-ink 与彩色主题下都是五种真正不同的东西，而不是五套配色。

```
密度 ─────────────────────────────────────────────────────►
  D1 一瞥        D2 节奏        D3 全息        D4 额度墙      D5 墨水日报
 Glance         Pulse         Console        QuotaWall      Ledger
 1 个数字       + 24h 曲线     + 热力图/额度   额度为主体      全文本表格
 3 米可读       2 米可读       1 米可读       1 米可读       近距离阅读
```

D4 不是"比 D3 更多"，而是同等密度下**换一个主语**——把额度而非消耗放在第一视线。放在 D3 之后是因为它的元素数量与 D3 相当。D5 是密度最高档，同时是 E-ink 的默认档。

### 2.1 模式与主题的关系（不变量）

REQ-ANDROID-04 已规定摆件样式不得隐式切换主题，本方案保持该约束，并补充一条：**每个模式必须在 Dark / Light / E-ink 三种主题下都可用且都好看**，不允许出现"某模式只有 E-ink 能用"。D5 在 E-ink 下是默认推荐档，但在 Dark 下同样是一个合法的等宽文本日报。

首次进入时的默认档：

| 设备信号 | 默认摆件档 | 默认主题 |
|---|---|---|
| 识别为墨水屏（Build / feature / 刷新率组合，沿用 `DisplayCapabilities.kt` 既有逻辑） | D5 墨水日报 | E-ink |
| 常规手机/平板 | D3 全息（等价于今天的行为，保证升级用户无感） | 跟随现状 |

已有 `widget_presentation` 偏好的用户：`polished → D3`、`eink → D5`，在 `WidgetPresentation.fromStored` 里做一次性映射，旧值继续可读（兼容层，退出条件：两个版本后移除映射分支）。

---

## 三、五个模式规格

数据全部来自现有 `DashboardUiState`（`summary` / `comparison` / `trends` / `heatmap` / `quota` / `dailyQuote`），**不新增 RPC、不新增字段**。

### D1 · 一瞥 Glance

**用途**：把旧手机立在书架上，走过时扫一眼。3 米外可读。

**内容**（竖屏，自上而下）：

1. 顶部极小行：范围标签 + 最后更新时刻（8sp，faint）。
2. 主体：今日有效 Token 巨型数字，字号按容器短边动态计算，目标占屏高 28–34%，`fit_font` 收敛不裁切。
3. 数字下方一行：与上一周期的变化（箭头 + 百分比），色彩仅作强化，方向必须同时由 `↑ / ↓ / →` 字形表达（E-ink 与色盲可用）。
4. 底部：整宽极简 sparkline，只有今日一条线，无坐标轴、无网格、无标注，高度占屏高 12%。

**不显示**：成本、请求、缓存、热力图、额度、日签。

**横屏**：数字与 sparkline 左右分栏（6:4），其余不变。

**触点**：整屏仍是"有效 / 全部"切换触点（沿用 `tokenModeToggle`），TalkBack 暴露 Switch 状态。

**摘要文案**（TalkBack）：`今日有效 Token 1.2M，较上一周期上升 14%`。

---

### D2 · 节奏 Pulse

**用途**：关心"我今天什么时候在烧 token"。这是**唯一以 24 小时时间轴为主体**的摆件档。

**内容**：

1. 顶行：Token 大数（约 D1 的 55% 字号）+ 变化徽标。
2. 主体（占屏高 45%）：24 小时节奏图。
   - 今日实线曲线，截断在当前时刻，末端画当前点。
   - 昨日为半透明填充面积 + 细虚线轮廓（与 Windows 锁屏方案保持同一视觉语言，见 `windows-lockscreen-rhythm-v1.md`）。
   - x 轴每 6 小时一个刻度（00 / 06 / 12 / 18），当前时刻画一条竖向指示线。
   - y 轴不画数值，只在峰值点标一次数值。
3. 底部一行三格：成本 / 请求 / 缓存命中。

**数据来源**：`stats.comparison`。`docs/contracts/dashboard-stats-v2.md:63` 与 `supabase/schema.sql:561` 确认 range=today 时 `window.bucket == "hour"`，`current.series` 与 `previous.series` 均为小时桶，昨日曲线不需要任何新接口。

**边界**：range ≠ today 时 24 小时轴无意义。此时 D2 降级为"当前范围的分桶节奏图"，标题随 `window.bucket` 改为"按日节奏 / 按月节奏"，昨日线改为"上一周期"线。不得在非 today 范围下硬画 24 小时轴。

**不显示**：热力图、额度、日签。

---

### D3 · 全息 Console

**用途**：等价于今天 `V2WidgetPreview` 的信息量，作为升级用户的无感默认。

**内容**：D1 的大数 + D2 的节奏图（压缩到屏高 26%）+ 三格指标 + 12 周热力图 + 额度胶囊（数量由 `visibleQuotaWindowLimit` 决定）。

**相对现状的唯一改动**：额度胶囊必须显示溢出指示（对应审计 A2）。若某 Provider 还有未展示的 Progress 窗口，胶囊右上角显示 `+N`，TalkBack 念出完整窗口数与被省略的窗口语义。

**横屏**：沿用现有 `V2LandscapeWidgetContent` 融合稿，含日签与 `Jeidorf` 字标（REQ-ANDROID-04 明文要求，不得删除）。

---

### D4 · 额度墙 QuotaWall

**用途**：主语从"我用了多少"换成"我还能用多少"。适合订阅额度紧张时长期挂着。

> **v1.1 修订（真机反馈）**：原设计把"所有 Provider 的所有窗口分组罗列"当作这一档的卖点，
> 真机上的结果是一屏密密麻麻的细条——信息全在，但**隔着房间一个都读不出来**，与"摆件"
> 的前提相悖。改为大号半环仪表盘网格。下文为修订后的规格；被替换的"不截断"承诺移交 D5。

**内容**：

1. 顶栏单行：`已显示 N/M 个窗口 · 另有 K 个未显示`。截断必须写在版面上，不能靠用户自己数。
2. 主体：**大号半环仪表盘网格**，横屏 3×2、竖屏 2×2，不滚动。每格只放三样东西：
   - 来源名 + 窗口标签（如 `Codex · 周`）。
   - 巨号**可用**百分比（不是已用，与 ADR-014 口径一致），半环 220° 开口向下。
   - 重置倒计时。除此之外什么都不放。
   - 窗口挑选走 `rankedQuotaWindowsForDisplay()`：各 Provider 的主窗口先占位（Codex 取周限额、
     Claude/Antigravity 取 5 小时窗口），再补次要窗口。**不得**直接 `flatMap(drawableProgressWindows())`
     ——那是按时长升序排的，`take(N)` 会先命中 Codex 的 5 小时窗口，与概览卡自相矛盾。
   - Credits 余额、`unlimited`、`上限未知` 不占仪表盘格位，**不画伪进度**（REQ-QUOTA-03 明文）；
     这些 Provider 在网格下方以名字 + 原因列出。
3. 底部：各来源 `observedAt` 的最旧值 + 新鲜度状态。stale / error / unsupported 必须显式可见，不得因"摆件要简洁"而隐藏（REQ-ANDROID-03）。

**与 D5 的取舍是相反方向**：D5 的 `QuotaBoard` 追求"一个都不漏"，代价是每行压成一条细进度条；
D4 追求"隔着房间也读得出还剩多少"，代价是接受版面上限。两档都保留，因为回答的不是同一个问题。
**审计 A2（Antigravity 四窗口不得静默截断）的兑现处因此从 D4 移到 D5**；D4 的截断是显式的。

**E-ink**：这一档的主语就是环，降级成条等于取消这一档。因此 E-ink 下不走通用的 Ring→Bar 降级，
改用 `ProgressStyle.DitheredRing`——粗描边（短边 8.5%）+ 虚线轨道 + `StrokeCap.Butt`。
圆头端帽会让弧超出真实百分比半个笔宽，1bit 下这点误差肉眼可见，故必须平头。

**降级**：额度全部不可用时，显示"暂无可绘制的额度窗口 · 未同步不代表 0%"并提示可切到 D3，不留空白屏。

**不显示**：热力图、日签、趋势曲线、巨型 Token 数字。最后一项是 v1.1 新增的排除项——
这一档若再放 Token 数字，主语就又回到"我用了多少"，与 D3 重复。

---

### D5 · 墨水日报 Ledger

**用途**：E-ink 设备默认档。以"一份印出来的日报"为隐喻——无填充色块、无渐变、无圆角卡片，只有排版、分隔线和等宽数字。

**内容**（单栏，报纸式）：

1. 报头：`TOKENLEDGER` 字标 + 本地日期 + 范围标签 + 生成时刻，一条 2dp 实线收底。
2. 「今日」小节：有效 Token / 全部 Token / 成本 / 请求，四行 `标签 …… 数值` 结构，数值右对齐到同一制表位，等宽字体。
3. 「对比」小节：本期 vs 上期的四项数值与差额，同样右对齐。
4. 「节奏」小节：24 小时数据以**阶梯柱**表达（不是曲线）。E-ink 上柱形边界比曲线抗残影得多。昨日用同位置的空心细框柱叠加。
5. 「额度」小节：每个窗口一行 `Provider · 窗口 · 可用 xx% · 重置 hh:mm`，进度用 20 格字符轨道 `[████████░░░░░░░░░░░░]` 表达，不用色彩。
6. 「热力」小节：12 周活跃度用 5 档**网点抖动纹理**（dither），而非灰阶填充——直接满足 REQ-ANDROID-04 "热力图不能只靠颜色表达强度"，且在 1bit 屏上是唯一可靠的做法。
7. 报脚：今日一句 + `Jeidorf` 字标。

**刷新策略**：这是唯一有独立刷新语义的档。对齐到整点的 15 分钟边界（:00/:15/:30/:45）而不是"进入后每 15 分钟"，让多台设备的重绘时刻可预测；每次重绘前走一次全屏反色消影（复用 `LowPowerDisplayScreen.kt:78-113` 已有的 `showRefreshFlash` 机制）。数据仍由 ViewModel 的 single-flight / latest-wins 提供，摆件层不发起后台请求（NFR-01）。

---

## 四、需要引入的抽象

### 4.1 `AmbientMode`（取代 `WidgetPresentation`）

```kotlin
internal enum class AmbientMode(
    val storedValue: String,
    val label: String,
    val density: Int          // 1..5，供无障碍摘要与设置页排序
) {
    Glance("glance", "一瞥", 1),
    Pulse("pulse", "节奏", 2),
    Console("console", "全息", 3),
    QuotaWall("quota", "额度墙", 3),
    Ledger("ledger", "墨水日报", 5);

    companion object {
        fun fromStored(value: String?, fallback: AmbientMode): AmbientMode =
            entries.firstOrNull { it.storedValue == value }
                ?: legacyMap(value)          // polished→Console, eink→Ledger（兼容层）
                ?: fallback
    }
}
```

`WidgetPresentation` 保留为 `@Deprecated` 类型别名一个版本周期，退出条件写进 TASKS。

### 4.2 `AmbientRenderProfile`（模式 × 主题的渲染策略）

这是解决"E-ink 与常规模式没差异"的核心。当前差异只发生在 palette 层，必须提升为显式的渲染策略对象：

```kotlin
internal data class AmbientRenderProfile(
    val fillPolicy: FillPolicy,        // Solid | Outline | Dither
    val chartStyle: ChartStyle,        // SmoothArea | SmoothLine | SteppedBar
    val cornerRadius: Dp,
    val strokeWidth: Dp,
    val useMonospaceNumerals: Boolean,
    val progressStyle: ProgressStyle,  // Ring | Bar | CharTrack
    val refreshCadence: RefreshCadence,// OnDataChange | AlignedQuarterHour
    val ghostBusting: Boolean          // 重绘前全屏反色
)

internal fun resolveRenderProfile(mode: AmbientMode, appearance: LedgerAppearance): AmbientRenderProfile
```

约束：`resolveRenderProfile` 是纯函数，必须有单元测试覆盖 5 × 3 = 15 个组合，断言 E-ink 主题下 `fillPolicy != Solid` 且 `progressStyle != Ring`（环形在 1bit 屏上抗锯齿极差）。

### 4.3 `resolveLowPowerPolicy` 的调整

现状（`LowPowerDisplayScreen.kt:47-64`）把 `appearance == EInk` 混进了 `constrained` 判定，导致"选了 E-ink 主题"就被当成"设备受限"。应拆开：

- **设备约束轴**：`powerSaveMode || thermalStatus >= MODERATE || !systemAnimationsEnabled` → 只影响 `compactDetails` 与 `visibleQuotaWindowLimit`。
- **模式意图轴**：`AmbientMode` → 决定布局与 `AmbientRenderProfile`。

主题不再参与任一轴的判定，只决定 palette 与 `resolveRenderProfile` 的第二个入参。这同时修掉一个现存的怪异行为：常规手机上选 E-ink 主题会莫名把额度窗口从 4 个砍到 2 个。

### 4.4 模式选择器控件更换

`V2WidgetModeStrip` 的等宽 Row 换成**两行 FlowRow 的 M3 FilterChip**，每个 chip 内含模式名 + 一行密度说明（如"一瞥 · 只看一个数字"）。5 个条目在 320dp / 200% 字体下必须换行而非裁切，最小触控目标 48dp（REQ-ANDROID-04）。chip 保持 `Role.RadioButton` 与 `stateDescription` 语义。

设置页在 chip 组下方增加一个**实时预览缩略图**（复用摆件本身的 Composable，缩放渲染），避免用户必须逐个进入全屏才知道差别。

> **v1.1 修订（真机反馈）**：初版实现把这句话落成了一张**只吃 `AmbientRenderProfile`、不吃 `AmbientMode`**
> 的固定卡片。而深浅色下五档的 profile 差别极小，于是切 chip 时预览纹丝不动——那不是预览，是装饰。
>
> 修订后的规格：
> - 预览卡按纯函数 `ambientPreviewElements(mode)` 返回的区块列表**逐块渲染**，复用全屏摆件的
>   同一批 Composable。"切档必然换内容"因此是一条可在 JVM 上穷举断言的性质，而不是靠人眼比对截图。
>   唯一的例外是热力图：缩略尺寸下它挤成一团黑，D5 的预览显式剔除。
> - 卡内右上角加一个**墨水屏预览开关**。此前墨水屏形态只有把全局外观切成 E-ink 才看得到，
>   而多数用户不会为了预览去改全局外观——结果是"五档各自的墨水屏效果"事实上不可见。
>   开关只改这张卡的 `resolveRenderProfile` 入参，不动全局外观偏好。全局已是 E-ink 时，
>   关掉开关落到 Dark 作为彩色对照，保证开关两个状态都有东西可看。
> - `AmbientMode` 因此新增必填的 `einkSummary`，与 `summary` 并列。墨水屏是**介质约束**，
>   不是第六个模式，所以它是每一档的一个属性，而不是一档。

---

## 五、验收标准

| # | 项 | 判据 |
|---|---|---|
| V1 | 五个模式在竖屏 320dp / 390dp / 430dp 与横屏均无裁切、无溢出、无空白半屏 | 新增 golden：5 模式 × 3 主题 × 2 方向 = 30 张，或按代表性裁剪到不少于 15 张 |
| V2 | 五个模式两两之间的**信息元素集合**不同 | 单元测试断言每个模式声明的 `elements: Set<AmbientElement>` 互不相等 |
| V3 | E-ink 主题下每个模式的 `AmbientRenderProfile` 都不使用实心填充与细环进度 | `resolveRenderProfile` 15 组合单测。v1.1 例外：D4 走 `DitheredRing`（粗描边 + 虚线轨道），单测正向断言该例外，其余档仍必须为 `Bar` 或 `CharTrack` |
| V4 | 热力图与所有进度在 E-ink 下不依赖颜色表达强度 | 灰度化截图人工复核 + 纹理档位可辨 |
| V5 | 模式切换不改变主题；主题切换不改变模式 | UI 测试：切换任一轴后读回另一轴 SharedPreferences 值不变 |
| V6 | 旧偏好 `polished` / `eink` 升级后分别落到 Console / Ledger | 单测覆盖 `fromStored` 兼容分支 |
| V7 | **D5** 显示全部 Progress 窗口；D3/D4 对被省略窗口有 `N/M` 或 `+N` 指示与 TalkBack 播报 | 用 4 窗口 Antigravity fixture 断言（v1.1：不截断的承诺由 D4 移交 D5） |
| V11 | 设置页预览卡在五档之间**内容真的不同**，且卡内墨水屏开关能预览五档 × 两种介质 | `ambientPreviewElements` 两两不等 + 子集/去重/声明序单测；墨水屏形态由 V3 覆盖 |
| V12 | 摆件、预览、胶囊与小组件挑出的额度窗口**完全一致**：Codex 取周额度，Claude/Antigravity 取 5 小时窗口 | `rankedQuotaWindowsForDisplay()` 单测：前三格与各 Provider 的 `selectPrimaryDisplayWindow()` 逐一相等，且打乱 transport 顺序后逐位不变 |
| V8 | 全部五档屏幕常亮、退出恢复、无持续动画、后台不轮询 | 沿用 T6.2k/T6.2c 既有验收手法 |
| V9 | 200% 字体、TalkBack 顺序、48dp 触控目标 | 真机矩阵（PROJECT §6 Android 行） |
| V10 | 墨水屏真机上 D5 的 15 分钟对齐刷新与消影实际生效 | MiDuoKanReaderPro 或等价设备实机录像证据 |

---

## 六、需要协调员单写的前置修订

本方案触及三处 SSOT，实现者不得自行修改：

1. **`docs/REQUIREMENTS.md` REQ-ANDROID-04**：现文"提供常规看板、精美摆件和墨水屏摆件三种呈现"必须改写为五档密度模型，并写明"摆件模式决定信息编排与渲染策略，主题决定色彩与对比"这条不变量。E-ink 默认档从"墨水屏摆件"改为"墨水日报"。
2. **`docs/PROJECT.md` §7**：追加 ADR-015《Android 全屏摆件采用信息密度分档与显式渲染策略》，说明为何摆件模式不再是"精美/墨水"二元，以及 `AmbientRenderProfile` 为何要与主题解耦。
3. **`docs/TASKS.md`**：登记任务与子任务。建议拆分为 T9.1（抽象与兼容层 + 选择器控件）、T9.2（D1/D2）、T9.3（D3/D4）、T9.4（D5 与 E-ink 渲染策略）、T9.5（golden 与真机矩阵），每个子任务独立 Active Claim，路径所有权按 `LedgerDashboardV2Ui.kt` 拆分需明确避免同文件并行。

---

## 七、风险与未决

- **`LedgerDashboardV2Ui.kt` 已达 3600+ 行**，再塞五套布局会失控。建议本方案实施的第一步是把摆件相关 Composable 拆到 `ambient/` 包（`AmbientGlance.kt`、`AmbientPulse.kt`…），这是纯搬移，应作为独立提交先行，方便 review 与后续并行。
- **D5 的 dither 纹理在不同 DPI 下可能产生摩尔纹**，需要在真实墨水屏上试过再定网点密度，不能只靠 Layoutlib golden。
- **D2 在 range ≠ today 时的降级文案**需要产品确认：是改标题继续显示，还是直接禁用该档并提示。本方案暂定前者，标 `[?]` 待决策。
- **五档是否过多**：如果真机试用后发现 D1 与 D2 使用率极低，应有勇气合并，而不是为了凑数保留。建议实施后加一个本地计数（不上报），两周后回看。

---

## 八、v1.1 修订：真机反馈（2026-07-25，T6.5）

v1.0 的实现（T6.4-B）在真机 APK 上暴露出三处问题，外加一处窗口挑选缺陷。四条都不是"没做完"，
而是**设计或实现里的隐含假设在真机上不成立**，所以逐条记下根因，避免下一版重犯。

| # | 现象 | 根因 | 修订 |
|---|---|---|---|
| ① | 顶部切换摆件模式，下方示意图纹丝不动 | 预览卡只接收 `AmbientRenderProfile`，从不看 `AmbientMode`；而深浅色下五档 profile 差异极小 | §4.4：预览按 `ambientPreviewElements(mode)` 逐块渲染，复用全屏摆件组件 |
| ② | 墨水屏效果只有 D5 看得到，其余四档无从预览 | 策略层确实逐档解析了 E-ink profile，但 UI 上只有切换**全局外观**一条路径能触发；用户不会为了预览改全局设置 | §4.4：预览卡内加墨水屏开关；`AmbientMode` 新增 `einkSummary` |
| ③ | 额度墙信息过密，隔着房间读不出 | 把"一个窗口都不漏"当成了这一档的卖点，但那是**数据完整性**目标，不是**摆件可读性**目标 | D4 改为大号半环仪表盘网格；不截断的承诺移交 D5 |
| ④ | 小卡片显示的额度取错窗口（Codex 显示 5 小时而非周额度） | 摆件/预览/胶囊直接 `flatMap(drawableProgressWindows())`，绕过了 `selectPrimaryDisplayWindow()`；而前者按窗口时长**升序**排，`take(N)` 必然先命中短窗口 | 新增 `rankedQuotaWindowsForDisplay()`，五处调用点统一改走它 |

### 8.1 ④ 的教训值得单独记

规则本身从一开始就是对的（`preferredWindowRole()`：Codex 取长窗口、其余取短窗口），单测也一直
是绿的。失败的是**规则没有唯一入口**：概览卡走 `quotaProgressWindowsForDisplay()`（正确），
摆件与预览各自手写 `orderedQuotaProvidersForDisplay().flatMap { drawableProgressWindows() }`（错误）。
同一份数据在同一个 APK 里显示出两套互相矛盾的数字，而每一处单独看都"合理"。

因此新增的 `rankedQuotaWindowsForDisplay()` 不只是修一个 bug，它把"额度窗口的展示序"收敛成
一个函数。后续任何新界面要列额度窗口，都应调用它或 `quotaProgressWindowsForDisplay()`，
**不得**再手写 `flatMap`。V12 是这条约束的机器可读形式。

### 8.2 未验证项

本次修订在无 Android SDK / JDK 17 的环境中完成，**零编译、零单测执行、零真机**。
上表所有"修订"列描述的是代码里已经写下的意图，不是已验证的事实。V1（golden）、V4、V9、V10、V11
的真机与截图部分仍待有工具链的机器执行，详见 `docs/task-logs/T6.5/`。
