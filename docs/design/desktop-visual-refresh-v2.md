
> 本文引用的 docs/task-logs/…、docs/BACKLOG.md 等路径是内部溯源标记，指向维护方私有仓库中未随本仓库发布的任务证据与待办，不是可点击的相对链接。发布范围说明见 [../internal-collaboration-materials.md](../internal-collaboration-materials.md)。

# 桌面视觉与动效焕新 v2（T10.150）

> **实施状态（2026-10-17 按代码核对）**：已实现并合入 main（T10.150）。

- 适用：桌面 React 看板（Tauri WebView2 / WKWebView，浏览器 fixture），深色、浅色、Auto，系统高对比度与 reduced-motion。
- 不适用：Android、分享海报画布（`shareCardRenderer.ts`）、HTML 简报（`reportExport.ts`）的版式。
- 状态：已实现并按区提交（2026-09-24），待用户看过改前改后截图再合入；事实源仍是 [DESIGN §4.4](../DESIGN.md#44-视觉系统主题与浮层)，本文件给出本轮的具体取值与组件规格。
- 来源：2026-09-24 用户反馈“界面太丑，缺乏现代审美的设计和动效”；改前截图与诊断见 `docs/task-logs/T10.150/`。

## 1. 改前诊断

1. **处处加粗，层级失效**：导航、按钮、分段选项、标签、表格工具名几乎都是 600–750。Windows 中文 UI 字体只有 Regular/Bold，≥600 一律渲染成粗体，于是整屏同样“喊”。
2. **框中套框**：顶栏 5 组分段控件各有边框底色；趋势卡里再套一条带边框的小指标条；专属看板卡片→小卡片→趋势卡→小指标条四层嵌套；侧栏动作也是带框按钮。
3. **平、灰、无纵深**：深色是 macOS 旧窗口灰 #1c1c1e，页面与卡片几乎同色，无阴影层级、无环境光；浅色是灰底白卡，同样扁平。
4. **颜色不表达语义**：明细表把成本染黄、缓存染绿、工具名染蓝；工具卡用彩色左边框；图表默认饱和色、方角柱、单日数据画成一整块大柱。
5. **动效零散**：只有 KPI 入场与数字补间；切页、分段切换、浮层、按压都没有反馈。

## 2. 设计原则

1. **层级靠字号与色阶，不靠字重。** 正文 400；标签、导航、按钮、分段选项 500（中文在 Windows 上即 Regular）；标题、KPI 数值与关键数字 600。除页面 H1 与数字外不使用 650/700/750。
2. **少一层框。** 卡片内部的分组用 `--color-bg-subtle` 填充或细分隔线，不再画带边框的小卡片；分段控件是一条无边框的浅色轨道。
3. **四档纵深。** 窗口/侧栏 `--color-bg-app` → 页面 `--color-bg-page`（叠加 `--color-ambient` 环境光）→ 卡片 `--color-bg-panel` + 1px `--color-border` + `--shadow-card` → 浮起层 `--color-bg-popover` + `--shadow-float`/`--shadow-modal`。
4. **颜色只说意思。** 品牌渐变 `--color-brand-gradient` 只用于身份：Logo、导航选中指示、主 KPI 点缀、主按钮。数据用 `--chart-1…8`。成功/警告/危险只表达状态。数字默认主文字色。
5. **动效只解释状态变化。** 挂载时播放一次（切页、打开浮层、加载完成），数据刷新不重播；悬停/按压给即时反馈；选中态滑动过去而不是跳过去；`prefers-reduced-motion` 下全部关闭。

## 3. 令牌（`src/styles/tokens.css`）

| 类别 | 深色 | 浅色 | 用途 |
|---|---|---|---|
| `--color-bg-app` | #0a0c10 | #eceef2 | 窗口与侧栏底 |
| `--color-bg-page` | #0d0f13 | #f4f5f7 | 内容区底 |
| `--color-bg-panel` | #15181e | #ffffff | 卡片 |
| `--color-bg-elevated` | #1b1f26 | rgba(15,23,42,.03) | 卡内浮起块、次级按钮 |
| `--color-bg-popover` | #1d2129 | #ffffff | 菜单、弹层、tooltip |
| 文字 primary/secondary/tertiary | #f2f4f7 / #c3c8d2 / #9aa2b0 | #0f1729 / #3b4556 / #5d6778 | 卡片上约 16/10.6/6.9 与 17.9/9.7/5.7 : 1 |
| `--color-primary` | #6b9dff | #1f5fd6 | 选中、焦点、当前期 |
| `--color-primary-fill` | #2f6be6 | #1f5fd6 | 主按钮底（白字 ≥4.5:1） |
| `--color-brand-gradient` | #5b8cff→#8b6cff | #3b6ff5→#7c5cf0 | 身份点缀 |
| `--chart-1…8` | 蓝/紫/青/琥珀/玫红/绿/天蓝/橙 | 同色相加深 | 图表系列 |
| `--chart-grid` / `--chart-axis` | 6% 白 / #8f97a5 | 7% 墨 / #5d6778 | 网格与坐标 |
| 阴影 | `--shadow-card` `--shadow-card-hover` `--shadow-float` `--shadow-modal` `--shadow-primary` | 同名 | 深色偏“内高光+长投影”，浅色偏“短而柔” |
| 圆角 | card 16 · button 10 · chip 10 · input 8 · modal 20 · md 10 | | 卡片内控件比卡片小一档 |
| 字号 | 11 caption · 12 meta · 13 `--font-size-md` 正文小 · 14 正文 · 15 `--font-size-title` 卡片标题 · 20–22 页标题 · 30 KPI | | |
| 动效 | press 90ms · hover 160ms · indicator 360ms · enter 420ms · stagger 40ms；`--ease-out-expo` `--ease-out-quart` | | |

## 4. 动效原语（`src/styles/motion.css`、`src/hooks/useSegmentedIndicator.ts`）

- `tl-enter-up`：切页时页面根淡入上移 10px（`.app-content > *`，一次）。
- `tl-enter-scale`：弹窗、抽屉从 98% 淡入落定；`tl-enter-fade`：遮罩。
- `tl-pop-in`：菜单、弹层从触发器方向淡入下落 4px。
- `tl-grow-x`：进度条、数据条从起点生长（需 `transform-origin`）。
- `tl-pulse-ring` / `.tl-live-dot`：扫描、同步进行中的状态点呼吸；空闲时静止。
- `tl-spin` / `.tl-spin`：进行中的刷新图标（既有 `.animate-spin` 契约保留）。
- `.tl-press`：按压缩放到 97%。
- **滑动选中指示**：分段控件或导航容器加 `tl-seg` 类，并挂 `useSegmentedIndicator()` 的回调 ref；选中项自身背景改透明，由 `::before` 胶囊滑到选中项（360ms、ease-out-expo）。首帧不滑动；可用 `--seg-bg`、`--seg-shadow`、`--seg-radius` 按控件定制。DOM 与读屏树不变。
- 禁止：`@starting-style`、CSS anchor positioning、View Transitions API（WKWebView 目标为 Safari 15）；带数据的元素不用回弹曲线；刷新重播入场；骨架屏逐卡延迟。

## 5. 组件规格

### 5.1 侧栏
- 底色 `--color-bg-sidebar`（接近窗口色），右侧 1px 细线。品牌：32px 渐变圆角方块 Logo + 名称 15/600 + 副标题 12 tertiary。
- 导航行 44px、圆角 10、14/500、图标 18px tertiary；悬停 `--color-bg-hover-soft`；选中：`--color-primary-soft-bg` 胶囊（由滑动指示承担）+ 主文字色 + 图标 primary + 左侧 3px 渐变指示条。
- 分组标签 11/500 tertiary、字距 0.04em。快捷动作（战报、壁纸）改为与导航同构的次级行，不再是带框按钮。
- 底部状态卡：圆角 12、`--color-bg-subtle`；状态点在扫描/同步时 `tl-live-dot`；扫描/同步为紧凑次级按钮。

### 5.2 顶栏
- 半透明 `--color-bg-header` + 模糊，底部细线；标题与状态行降为次要信息（13/600 + 11 tertiary）。
- 分段控件：无边框轨道 `--color-bg-subtle`、圆角 10、内边距 3、选项 13/500 secondary，选中项主文字色 + 滑动胶囊（深色 `--color-bg-elevated-2`，浅色 #fff + `--shadow-sm`）。可点选项最小 44px（DESIGN §4.4、GLB-03）；轨道内缩 3px，胶囊用 `--seg-inset-x/y` 对齐。
- 战报、主题：幽灵按钮（图标 + 文字），悬停出底色。

### 5.3 按钮
- 主：`--color-primary-fill` 底白字，悬停 `--color-primary-fill-hover` + `--shadow-primary`；次：`--color-bg-elevated` 底 + 1px `--color-border`；幽灵：透明，悬停 `--color-bg-hover-mid`。圆角 10、500 字重、`tl-press` 按压、160ms 颜色过渡。

### 5.4 KPI 与卡片
- 卡片：圆角 16、1px `--color-border`、`--shadow-card`、内边距 18–20。卡片标题 15/600，副标题 12–13 tertiary；标题图标放 28px 圆角 8 的色调底块里。
- KPI：图标块（主 KPI 用品牌软渐变底 + primary 图标；其余中性底 + tertiary 图标）、标签 13/500 secondary、数值 30/600 等宽数字字距 -0.02em、说明 12 tertiary。主 KPI 卡叠一层 `--color-brand-gradient-soft` 顶部光晕。可点击的卡片才有悬停抬升（边框变强 + `--shadow-card-hover`，不位移）。
- 卡内小指标条：去掉外框与格子边框，用细分隔线；变化值用语义软底胶囊。

### 5.5 图表（`src/utils/chartTheme.ts` 单一来源）
- 系列色取 `--chart-*`；坐标文字 11px `--chart-axis`；网格虚线 `--chart-grid`；不画坐标轴线。
- 柱：顶部圆角 [6,6,2,2]、`barMaxWidth` 36、自上而下的同色渐变；线：2.25px、平滑、面积自 22% 渐隐到 0；hover 强调共享阴影。
- tooltip：`--color-bg-popover` 底、1px 边、圆角 12、`--shadow-float`、等宽数字，`pointer-events:none`。
- 动画：首次 700ms cubicOut、更新 450ms；`reduceMotion` 每次调用实时读取。

### 5.6 浮层
- 菜单/弹层：`--color-bg-popover`、圆角 12、`--shadow-float`、`tl-pop-in` 180ms。
- 弹窗：遮罩 `--color-bg-scrim` + 6px 模糊淡入；对话框圆角 20、`--shadow-modal`、`tl-enter-scale` 260ms。Portal 到 body 与 z-index 次序不变。
- Toast：圆角 12、`--shadow-toast`，保持在顶栏下方的文档流中。

### 5.7 明细表与设置
- 表头透明 + 底部细线，12/500 tertiary；行 44px、悬停 `--color-bg-hover-soft`、行分隔 `--color-border-row`。数字右对齐主文字色；成本不染黄、缓存不染绿；工具名 = 8px 色点 + 500 字重主文字色。
- 设置：分组卡同 5.4；行标题 14/500、说明 12–13 tertiary；开关、输入与按钮最小 44px。

## 6. 不可破坏的约束

对比度（正文 ≥4.5:1、工具色 ≥3:1，两套主题）；`prefers-reduced-motion` 末尾全局块在 `forced-colors` 块之后并清零 delay；全局 focus-visible 2px 主色描边；系统高对比度映射；浮层 Portal 到 body 且 `confirm-overlay 1020 > modal-overlay 1000 > sidebar 2`；KPI 数值 `nowrap` 与分级缩字；KPI 说明行可换行不截断；长标识两行截断 + `title`；44px 触控目标；骨架屏无逐卡延迟与悬停；首次渲染不从 0 补间；图表 `outerBounds` 而非 `containLabel`、双轴从 0 起、云端基线缺失画空不画 0；标题区拖动命中规则（新增交互元素需可识别或带 `data-window-drag-block`）；图表包体预算。
