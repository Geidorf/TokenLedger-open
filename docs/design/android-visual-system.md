
> 本文引用的 docs/task-logs/…、docs/BACKLOG.md 等路径是内部溯源标记，指向维护方私有仓库中未随本仓库发布的任务证据与待办，不是可点击的相对链接。发布范围说明见 [../internal-collaboration-materials.md](../internal-collaboration-materials.md)。

# Android 视觉与动效系统（T10.79 规格）

> **实施状态（2026-10-17 按代码核对）**：部分被取代。与 `android-visual-refresh-v2.md` 冲突的条目以后者为准；Compose 翻译任务 T10.80 仍受阻。

> 本文是 Compose 侧的翻译规格，不是当前实现状态。当前实现状态以源码与 `docs/DESIGN.md`、`docs/contracts/**` 为准（任务台账在维护方私有仓库，本仓库不发布）。
>
> 规范先在 `src/prototypes/**` 的 Web 原型上定死并逐项验证（本机 Gradle 不可用，
> Compose 侧改不动也验不了），本文把验证过的结论翻译成 Compose 常量与做法。
> 原型里的 CSS 自定义属性与本文表格一一对应，改原型即改规范。

## 0. 为什么要有这份规格

2026-08-23 实测：

| 指标 | 实测值 |
|---|---|
| 全 App 动效 API 使用 | **1 处** `animateFloatAsState`；`AnimatedVisibility`/`AnimatedContent`/`Crossfade`/`animateContentSize` 全部 0 次 |
| `LedgerDashboardV2Ui.kt` 的 `fontSize` 取值 | **18 种**（8–56sp） |
| 低于 M3 下限 11sp 的 `fontSize` 用量 | **121 处**（9sp 用了 67 次） |
| `MaterialTheme` 在主 UI 文件的引用 | **0 次**（6610 行完全绕开 M3 主题，手搓 `MobileV2Palette`） |
| 间距取值 | 1/2/3/5/7/9/11/13dp 混用，无 4dp 栅格 |

问题不是"不够好看"。字号没有下限，直接影响可读；动效全无，用户点了筛选后画面
整块换掉，**无法确认是自己那一下起了作用还是后台刷新恰好撞上**——这是可用性问题，
不是装饰问题。

## 1. 字阶

8 个 role 取代 20 种散值。**11sp 是可交互界面的硬下限**（对应 M3 `labelSmall`）。

| Token | 尺寸 | 用途 | 取代原有 |
|---|---:|---|---|
| `display` | 40sp | 概览主数字 | 38, 40 |
| `displaySm` | 32sp | 次级主数字、摆件主值 | 33, 34, 35 |
| `headline` | 28sp | 页面大标题 | 28 |
| `title` | 21sp | 卡片主标题、弹层标题 | 20, 21, 22 |
| `subtitle` | 17sp | 分区标题 | 16, 17, 18 |
| `body` | 14sp | 正文 | 14, 15 |
| `label` | 12sp | 标签、按钮文字 | 12, 13 |
| `caption` | 11sp | 说明、单位、时间戳 | **7, 8, 9, 10, 11** |

**摆件/全屏日报例外**：那是"远看的板子"，整块画布会被缩放，文字也不是触控目标，
允许更小。这是**显式例外**，不是把下限偷偷放宽：

| Token | 尺寸 |
|---|---:|
| `ambientDisplay` | 40sp |
| `ambientTitle` | 17sp |
| `ambientBody` | 12sp |
| `ambientLabel` | 10sp |
| `ambientCaption` | 9sp |

### Compose 落法

新增 `MobileV2Type` 对象承载这 13 个常量，`MobileV2Palette` 旁边并列；不引入
`MaterialTheme.typography` 是有意的——现有 6610 行全部走 palette 参数传递，半途
切主题系统的风险远大于收益，等 T10.78 拆分巨石文件时再评估。

```kotlin
internal object MobileV2Type {
    val display = 40.sp
    val displaySm = 32.sp
    val headline = 28.sp
    val title = 21.sp
    val subtitle = 17.sp
    val body = 14.sp
    val label = 12.sp
    val caption = 11.sp   // 可交互界面下限，不得再低

    val ambientDisplay = 40.sp
    val ambientTitle = 17.sp
    val ambientBody = 12.sp
    val ambientLabel = 10.sp
    val ambientCaption = 9.sp
}
```

**迁移影响**：121 处字号会变大，Compose golden 必然变化。逐张核对是有意变化后
再更新（ADR-007），不得批量接受。原型上按同一映射迁移后实测**横向溢出 0**，
但 Compose 的换行与省略行为不同，200% 字体档需要重点复核。

## 2. 间距

4dp 栅格：`2 / 4 / 8 / 12 / 16 / 20 / 24 / 32`。`2dp` 仅用于同一语义组内的贴合
（标签与其数值），不作为卡片间距。

现有 1/3/5/7/9/11/13dp 一律就近归并到栅格值。

## 3. 动效

三档时长对应三类事件，不逐处拍脑袋：

| Token | 时长 | 缓动 | 用于 |
|---|---:|---|---|
| `fast` | 120ms | standard | 手指直接因果：按下、开关、分档选中 |
| `base` | 220ms | decelerate（入场）/ standard（状态） | 内容进出：卡片入场、展开收起、数字换口径 |
| `slow` | 360ms | decelerate | 整屏或长距离位移：筛选弹层、页面切换 |

缓动曲线：

- standard `cubic-bezier(.2, 0, 0, 1)` → Compose `CubicBezierEasing(0.2f, 0f, 0f, 1f)`
- decelerate `cubic-bezier(0, 0, 0, 1)` → `CubicBezierEasing(0f, 0f, 0f, 1f)`
- accelerate `cubic-bezier(.3, 0, 1, 1)` → `CubicBezierEasing(0.3f, 0f, 1f, 1f)`

### 必须有动效的位置（按"因果需要被看见"排序）

| # | 位置 | 现状 | 目标 | Compose 做法 |
|---|---|---|---|---|
| 1 | 卡片入场（切页 / 切范围） | 瞬间替换 | 淡入 + 上移 8dp，前 4 张各延迟 30ms | `AnimatedVisibility(enter = fadeIn() + slideInVertically())`，或 `LazyColumn` item 上 `animateItem()` |
| 2 | 主数字换口径 | 直接跳数字 | 旧值淡出、新值淡入并上移 4dp | `AnimatedContent(targetState = displayedTokens)` |
| 3 | 来源行展开收起 | 瞬间撑开 | 高度补间 | `Modifier.animateContentSize(tween(220, easing = standard))` |
| 4 | 筛选弹层 | 直接出现 | 底稿淡入 + 面板上滑，同时结束 | `ModalBottomSheet` 默认动效即可，禁止 `animationSpec = snap()` |
| 5 | 分档选中（范围 / 洞察 tab） | 颜色瞬变 | 底色与文字色 220ms 过渡 | `animateColorAsState` |
| 6 | 按下反馈 | 无 | 120ms 缩放/底色 | `Modifier.clickable` 的 `indication` + `animateFloatAsState` |
| 7 | 额度条数据变化 | 宽度瞬变 | 宽度 360ms 补间 | `animateFloatAsState(targetValue = remaining)` |
| 8 | 加载 → 有数据 | 骨架直接替换 | 交叉淡入 | `Crossfade(targetState = uiState)` |

### 无障碍

**必须尊重系统的"移除动画"设置**。原型里 `prefers-reduced-motion` 此前只关了
`transition`，`@keyframes` 照跑——对前庭敏感用户等于没关，已修为同时关闭两者。

Compose 侧对应：读 `Settings.Global.ANIMATOR_DURATION_SCALE`，为 0 时所有上表动效
退化为 `snap()`。**不是"缩短时长"，是直接不做补间。**

## 4. 图表与报表

### 4.1 趋势图必须有 X 轴

现状 `xAxis.show = false`，图上一个时间刻度都没有，而正下方的结论写着"峰值位于
10:00"——这句话在图上无法定位。

规格：底部留 18dp 刻度行；手机宽度只渲染**首、中、末**三个锚点（12 个刻度在
390dp 上必然糊成一片）；刻度色 `onSurface @ 50%`，字号 `caption`。

原型已按此实现并实测：`xAxis.show = true`、12 个真实刻度 `00:00`…`22:00`、
`grid.bottom = 18`。

### 4.2 单值指标走网格，不要整宽卡片

洞察页现在是三张整宽卡片，每张约 100dp 高只为放一个数字。概览页的同类信息本来
就是 2×2 网格——**同一个 App 不该有两套密度模型**。

原型实测（430dp 宽）：三个指标用 2 列网格总高 **204px**，三张整宽卡片叠起来是
**292.5px + 2 个间隙 ≈ 310px**——省下约 34% 竖向空间，信息一条没少。

### 4.3 额度条颜色只表达"还剩多少"

现状：进度条用厂商色（Codex 蓝 / Claude 橙），而橙色在别处又被用来暗示"历史
数据"。同一个视觉通道扛两种语义必然读错；而且 57% 和 8% 剩余长得一模一样，
"快用完了"没有任何视觉权重。

规格：

| 档位 | 阈值 | 颜色 |
|---|---|---|
| healthy | ≥ 50% | `#65D6B0` |
| warning | 20% ≤ x < 50% | `#FFBD66` |
| critical | < 20% | `#FF8080` |

- 厂商身份改由左侧圆点承担。
- 剩余百分比文字与条形**同色**（同一语义通道必须一致）。
- 颜色不是唯一线索：critical 档额外加 1dp 描边，并在语义树里播报"额度告急"。（阈值与文案自 2026-09-24 起按用户决定 D4 与桌面统一，见 T10.152。）
- 两个厂商头像目前都是"C"，一眼分不出——改用可区分的字母对或图标。

### 4.4 摆件日报的 24 小时柱状图

现状柱子只占框内约 28% 宽度，右侧大片留白；且没有任何时间轴或数值刻度；
12 周活跃度热力图也没有图例。

规格：柱组填满容器宽度；底部补首/中/末三个时间锚点；热力图补"少 → 多"色阶图例
（原型的 `.prototype-heatmap-scale` 已有该模式，直接照搬）。

### 4.5 浅色主题对比度

浅色档下面积渐变几乎不可见、对比虚线是浅灰、顶部圆形按钮是白底浅灰圆（在浅灰
背景上近乎隐形）。

规格：浅色档的图表主线与面积填充各自单列一套颜色，不要从深色档直接取；圆形按钮
在浅色档改用 `surfaceContainerHighest` 级别的底色并保证与背景 ≥ 3:1。

> 此项**无法在当前原型验证**：原型只有深色档。Compose 侧改完需要用浅色 golden
> 逐张核对。

## 5. 翻译顺序建议

1. 字阶（影响最大、最机械，先做完再看 golden 差异）
2. 间距栅格（跟着字阶一起过一遍）
3. 图表 X 轴 + 洞察页密度（两处改完 golden 变化最集中）
4. 额度严重度分级
5. 动效（放最后：它基本不改静态 golden，可以独立验收）
6. 浅色档对比度与摆件柱状图（需要各自的 golden 复核）

动效放最后还有一个实际好处：Compose Preview 截图捕获的是静态帧，第 5 步通常
**不会**让 golden 变化，可以和前四步的 golden 更新解耦。

## 6. 本规格未覆盖

- 真机手感（滚动惯性、过度滚动、触感反馈）——只能真机验收。
- TalkBack 下的动效播报节奏。
- E-ink 档：该档应当**关闭全部补间**（残影），需单独一条分支，本文未展开。
