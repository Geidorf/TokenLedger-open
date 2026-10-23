# TokenLedger · 智能体工作守则

TokenLedger 是跨平台 AI Token 消耗账本：桌面端负责本地扫描、聚合、同步与壁纸，Android 端负责只读云端看板。项目采用**契约驱动统计、平台原生呈现、证据驱动验收**。

本文件面向在本仓库工作的智能体与自动化工具，列出必须遵守的硬性约束。人手协作流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开工必读（顺序固定）

1. 读 `docs/REQUIREMENTS.md`（功能语义与验收标准）、`docs/DESIGN.md`（技术设计与跨端约束）。
2. 读 `docs/PROJECT.md` §1.2 权威来源矩阵，先定位你要改的事实归哪个文件；再读 §3.2 状态枚举。
3. 统计/RPC 任务必须读 `docs/contracts/dashboard-stats-v2.md`，额度任务必须读 `docs/contracts/quota-provider-v1.md`。
4. 涉及额度来源时必须读 `docs/design/quota-source-compliance.md` 与 `docs/integrations/quota-provider-capabilities.md`。

## 铁律

- **统计口径不可漂移**：有效 Token = 输入 + 输出；缓存读写单列，不得再次并入有效 Token。扫描字段、去重键和估算工具以 README 与 Rust scanner 为准。
- **同一契约跨端一致**：React、Rust、Supabase、Android 的 `StatsData` 必须共同演进；任何字段新增都要兼容旧云端并补契约测试。
- **外部额度不走私有接口**：不得抓取或逆向 ChatGPT/Codex、Claude 等消费者产品的未公开内部接口；只使用官方文档支持的 API、用户显式授权的本地来源或手工配置。
- **竞品信息脱敏**：提交信息、PR 与 Issue、代码注释、日志、文档、分支名、标识符与文件名里不得出现参照或对标产品的名称、仓库与作者；一律用中性描述（见 [docs/COLLABORATION.md](docs/COLLABORATION.md) 第 9 节）。
- **共享文件单写**：`docs/PROJECT.md`、`docs/REQUIREMENTS.md`、`docs/DESIGN.md`、`docs/contracts/**`、Supabase 迁移编号、lockfile 与版本文件，由维护者或派单明确指定的唯一拥有者维护。
- **保护并行改动**：禁止 `git add .`、`git add -A`、`git reset --hard`、`git clean`、`git checkout -- <file>`；只精确暂存自己拥有的文件。
- **提交日志使用中文**：所有新提交（含合并提交）的主题必须包含中文；技术名、任务 ID 和路径可保留原文。每个 worktree 先执行 `git config core.hooksPath .githooks`。历史提交不得为统一语言而改写 SHA。
- **不在构建时隐式发版**：开发验证不得意外修改版本文件。版本提升是显式发布步骤，并与更新日志、安装包和跨端版本一致性一起完成。
- **文档闭环**：用户可感知行为、数据契约、平台限制或运维方式变化，必须同步更新对应事实源。
- **诚实验收**：集成状态与验证状态分别记录，取值只来自 `docs/PROJECT.md` §3.2 的闭合枚举。编译通过不等于端到端完成；只缺真实平台或外部服务时用「待平台验收」态，不得提前标完成。
- **证据可寻址**：截图不进 Git，日志里记 SHA-256 与外部存放位置；安装包与跨机器 bundle 记录完整 SHA-256、来源提交与环境。
- **搜索限定范围**：禁止以文件系统根为起点的递归搜索，搜索必须限定目录。
- **前台有界命令**：可能超过 60 秒的命令显式带超时并前台收结果；超时、被杀或未返回时如实上报为「未覆盖」，不得静默跳过或宣称完成。

## 提交与分支

- 分支名 `<智能体>-<工位代号>/i<Issue 号>-<slug>`，例如 `minimax-w1/i12-webdav-import`；云端 Claude 线程沿用平台指定的 `claude/project-thread-<短码>`。
- 提交主题用中文动作与范围，例如 `统计：增加上一周期曲线（REQ-COMP-01）`；可用 `npm run check:commits` 检查待交接提交。提交信息末尾加 `Agent: <工位名>`。
- PR 标题就是 squash 后进 `main` 的提交主题，同样必须含中文（CI 校验）。
- worktree 建议放在仓库外，避免共享构建产物与本地配置。
- 一个任务同时只有一个实现者；并行时按路径分配，不共享输出目录、端口、数据库或模拟器。
- 交接只经仓库：任务、认领、问询与结论都在 Issue 与 PR 里，PR 正文「交接」一节写清现状与下一步（本仓库不发布任务日志，发布范围见 `docs/internal-collaboration-materials.md`）。下一个接手的智能体不依赖上一方的对话上下文。

## 多工位并行

多台电脑、多个智能体与订阅账号同时开发时，**以 [docs/COLLABORATION.md](docs/COLLABORATION.md) 为准**。要点：

- **工位名** = `智能体@代号`（如 `claude@v2`、`minimax@w1`）。代号是两位的不透明短码，云端线程取分支短码的最后两位，重复时取三位；不用机器名或用户名。
- **署名**：评论、Issue 与 PR 正文第一行可见文字以 `[工位名]` 开头；没有前缀的视为维护者本人。
- **领任务**：只领带 `可开工`、没有 `进行中`/`阻塞` 的 `任务` Issue；评论 `[工位名] 开工：分支 xxx`，约 1 分钟后重读，最早的一条赢。
- **不碰别人的分支和 PR**；接手先在 Issue 评论 `接手申请`。
- **租约**：3 小时内要有推送，之后每 3 小时推送或更新工位表心跳；停下时去掉 `进行中` 并说明。
- **并行上限**：每个工位名下未合并的 PR 最多 2 个（1 个 draft + 1 个等合并）。
- **合并**：A 级 CI 绿自动 squash；B 级另需他人评审；C 级另需负责人批准。拿不准开 `问询` Issue，非阻塞按推荐继续，阻塞就转做别的。

## 最低验证门禁

开发中只跑与改动相关的测试；CI 全绿是合并门槛，不等于验收；下列全量门禁由验收工位在本机对集成结果跑，只缺真机时任务 Issue 标 `待平台验收`，跑完回填结果（见 [docs/COLLABORATION.md](docs/COLLABORATION.md) 第 7 节）。按改动范围选择，不能用较小门禁冒充全量门禁：

```bash
npm run check:docs
npm run check
npm run typecheck
npx vite build
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/run-android-gradle.mjs testDebugUnitTest lintDebug assembleDebug
node scripts/run-android-gradle.mjs :app:validateDebugScreenshotTest
git diff --check
```

- React 交互：补自动化测试，并在 1200×800、1280×860 至少各做一次浏览器走查。
- macOS 窗口：实测聚焦/失焦、标题区交互控件、双击、拖动、全屏与多显示器。
- Windows：实测 125%/150% 缩放、半屏 Snap、WebView2 与托盘行为。
- Android：覆盖 320–430dp、390×844、字体 1.0/1.5/2.0、浅色/深色、手势/三键导航、TalkBack；发布物还需 release 签名/R8 门禁。
- Supabase：执行迁移/测试 SQL、验证 RLS/RPC 权限、旧签名兼容与 `EXPLAIN`；客户端不得持有 service role。

## 本机速查

- 桌面开发：`npm run dev`
- 协作文档门禁：`npm run check:docs`（纯 Node 只读，无工具链依赖，改任何文档后都该跑）
- 中文提交主题批量检查：`npm run check:commits`
- 可重复全量门禁：`npm run check`（完成后会验证已跟踪文件未变化）
- 前端类型检查：`npm run typecheck`
- 前端静态构建：`npx vite build`
- Rust 测试：`cargo test --manifest-path src-tauri/Cargo.toml`
- Android 门禁：`npm run android:verify`
- Android 390×844 截图回归：`node scripts/run-android-gradle.mjs :app:validateDebugScreenshotTest`
- 版本一致性：`npm run version:check`
- 显式发布升版：`npm run release:bump`（仅发布协调员执行）

## 云端环境速查

- 云端界面用 Vite，不要用 `npm run dev`。`npm run dev` 会拉起原生 Tauri 窗口；没有可用桌面会话的机器上用 `npx vite --host 0.0.0.0 --port 1420`。浏览器里没有 Tauri 时，`src/main.tsx` 会装上开发 mock，总览、明细和设置可以在 `http://127.0.0.1:1420/` 走查。
- Rust 固定 **1.96.0**（含 rustfmt、clippy），与 `.github/workflows/ci.yml` 一致。Linux 编译 Tauri 需要 WebKitGTK 4.1 开发包（`libwebkit2gtk-4.1-dev` 等）。
- `cargo test` / `cargo clippy` 前先 `mkdir -p dist`。`tauri::generate_context!` 会检查 `frontendDist`（`../dist`）目录存在。
- Android 模拟器、Supabase 本地栈和正式签名不在轻量环境里。发布门禁仍在具备 Docker 与 Android SDK 的机器上按仓库脚本执行。
