
> 本文引用的 docs/task-logs/…、docs/BACKLOG.md 等路径是内部溯源标记，指向维护方私有仓库中未随本仓库发布的任务证据与待办，不是可点击的相对链接。发布范围说明见 [../internal-collaboration-materials.md](../internal-collaboration-materials.md)。

# 项目 / 工作目录维度方案 v1（T10.155，用户决定 D5②）

> **实施状态（2026-10-17 按代码核对）**：已实现，默认关闭。实现见 `src-tauri/src/project_index/` 与设置页 `ProjectDimensionCard`（T10.165、T10.182）。

> 状态：方案草案，待 root 复核、用户确认后另行派实现任务。本文不改代码、不改契约、不改单写文档；需要写入 SSOT 的文字见任务日志「建议写入 SSOT 的文字」。
> 依据：用户决定 D5②（2026-09-24 11:15，记录于 T10.150 根日志「用户决定」）；报表审计 N12 与 §5.2；`docs/contracts/behavior-analysis-local-v1.md` 第 38 行「会话 ID 仅是来源标识，不推断项目」；DESIGN §1、§4.8（T10.146/T10.149）、§4.9（`session_analysis`）；README「扫描工具 Token 口径基准」。
> 代码基线：`main@3a504c8f`。文中 `文件:行号` 均指该基线。
> 证据：扫描器代码与测试 fixture；2026-09-24 在本机（Windows）对各来源样本做的只读结构探针（只输出键名、值类别和计数，见附录 A）；公开文档本次未联网复核，实施时按工具版本复核。macOS 未探测。

---

## 0. 结论

1. **可行，但覆盖有限，而且要明说。**
   - 能力表按日志格式列出 22 个来源，其中 18 个能取得会话的工作目录。ReasoniX 的部分会话要靠同目录推断，Gemini CLI 要靠项目目录里的标记文件。
   - Antigravity、腾讯 Marvis、Trae、WorkBuddy Agent 日志、Qclaw 的 Hermes 响应库不提供工作目录。
   - 本机账本按有效 Token 计：61.4% 来自能取得工作目录的来源；扣除 Claude、Codex 已被清理的会话日志（合计 0.6%），可归属上限约 60.8%。
   - 其余 38.6% 来自不提供工作目录的来源：Antigravity 32.5%、腾讯 Marvis 5.4%、未知键前缀 0.7%。
   - 因此“未归属”必须作为一等行显示，不能让项目排行看起来像全量。
2. **只存“项目名”，不存路径、不存哈希。** 项目名 = 会话启动目录所在 git 仓库的主工作树目录名（worktree 归并到主仓库）；不在仓库里时取启动目录的末级名。主目录、磁盘根目录、临时目录和工具托管目录只记固定分组，不记名字（主目录的末级名就是系统用户名）。
3. **新建独立的“项目索引”，扫描器和去重键不动。** 开启后按会话读取来源文件头或来源库的单个字段，回填全部历史会话。本机实测回填只读约 121 MB（Claude 766 个文件 0.48 s，Codex 2,919 个文件 3.2 s）；重扫全部 Token 需要读约 19.4 GiB。之后每轮扫描只解析新出现的会话。
4. **只在本机。** 项目数据只放在两张新的本机表里。云同步只读取 `RAW_SYNC_LOGS_SQL` 列出的列，按 `AggKey{tool, model, hour_bucket, machine_id}` 聚合后写入固定载荷（`session_id` 恒为 `"agg"`），看不到项目表。新增回归测试把这三处和 CSV 导出一起锁住。
5. **关闭就停止读取，并清除已存数据。** 关闭时在一个事务里删除两张表的数据（`secure_delete` 覆写），并截断 WAL。
6. **契约只增字段。** 本机行为契约新增 `meta.projectDimension`、`projects[]`、`unattributed`、`sessions[].project`，以及可选请求参数 `projects`；把“不推断项目”改写为“不从会话 ID 推断；项目只来自用户开启后的本机索引”。Stats v2、会话逐轮契约、额度契约和 Supabase 都不改。

## 1. 约束与范围

### 1.1 硬约束（来自 D5② 与项目规则）

| # | 约束 | 本方案的落实 |
|---|---|---|
| C1 | 默认关闭，由用户主动开启 | `project_dimension_enabled` 默认 `false`，只能通过专用命令加授权版本开启（§3.1） |
| C2 | 只保存末级目录名或哈希，不存完整路径 | 只存项目名或固定分组；完整路径只在内存里停留到算出项目名为止（§2.4、§3.3） |
| C3 | 不同步云端 | 本机表不进同步查询、聚合键、载荷，也不进 Supabase schema；有回归测试（§3.5） |
| C4 | 设置里说明读取了什么、没读取什么 | 设置卡片常显“会读取”“不会读取”“关闭时”三段（§3.2） |
| C5 | 有效 Token = 输入 + 输出，缓存单列 | 项目只是分组维度，不改任何数值口径 |
| C6 | 未知不显示、不存为 0（GLB-01） | “未归属”按原因单列 Token 与记录数；未开启时不返回项目字段，前端不得把缺失当作 0 |
| C7 | 不从内容推断 | 不解析提示词、回复、工具参数、会话标题，也不解析会话 ID |

### 1.2 不在 v1 范围

- 云端、Android、总览 KPI、专属看板、分享海报、HTML 简报、CSV 导出、托盘挂件、壁纸。
- 按记录归属：同一会话中途换仓库的少数情况仍整段归入启动目录（§2.3）。
- 远程仓库地址、分支名、提交号；Antigravity 等工具的内容推断。
- 明细页按项目筛选：明细走 Stats v2 游标契约，加项目会把维度带进跨端契约，放到 v2 再议。

## 2. 各来源能力

### 2.1 读法

- “来源族”按 `unique_key` 前缀区分，不按 `tool` 列，原因有三：
  - MiniMax 的 `mavis_*` 行的 `tool` 可能是 `minimax`、`marvis`、`opencode` 或 `kilo`；
  - Hermes 的 `state.db` 与 Qclaw 的 Hermes 响应库都写 `hermes_{id}` 和 `tool = hermes`；
  - `workbuddy_*` 来自两种日志。
- Hermes 的两个库，解析时先按会话 ID 查 Hermes `state.db`，查不到再判断是否属于 Qclaw 响应库（该库以 `response_id` 作会话 ID，不提供目录）。
- 未知或旧的键前缀一律按“来源不支持”处理。本机有 919 行 `tool = marvis`、键前缀为 `tencent_marvis_` 的记录，现行与历史扫描器代码都不生成这个前缀，来源未查明。
- “本机观测”一栏只写键名是否存在、值的类别和计数，不写任何值。
- 可靠性分三档。**高**：显式字段，本机样本基本全覆盖。**中**：字段只覆盖部分会话，需要推断或兜底。**无**：来源不提供。

### 2.2 能力总表

| 来源族（前缀） | 工作目录字段与位置 | 粒度 | 本机观测（结构） | 可靠性 | 项目名推导 | 缺口 |
|---|---|---|---|---|---|---|
| Claude Code（`claude_`） | 每行 JSONL 顶层 `cwd`；目录 `~/.claude/projects/<编码后的启动目录>/<会话>.jsonl` | 每条记录 | 抽样 40 个文件，首个 `cwd` 都与编码目录名一致；其中 21 个含 2–9 个不同 `cwd`，抽查的 25 个额外值全是首个 `cwd` 的子目录；全量文件头读取 765/766 取到 `cwd` | 高 | 取首个 `cwd`，按 §2.4 做 git 与 worktree 归并 | Claude Code 会清理旧会话：本机账本 1,100 个 Claude 会话中只有 778 个仍有日志文件（含 Cowork 与子代理）。已清理的会话占 Claude 有效 Token 的 26.8%（全部的 0.5%），只能标“无法确定”。编码目录名把分隔符替换成 `-`，无法还原，不作为项目名来源 |
| Claude 桌面版 Cowork（`claude_`，`local-agent-mode-sessions`） | 同上 `cwd` | 每条记录 | 抽样 20 个文件：18 个有 `cwd`，全部位于应用数据目录内；2 个没有 | 高 | 归入“托管会话” | 取不到用户实际挂载的文件夹 |
| Codex（`codex_v2_`，旧 `codex_`） | 首个 `session_meta.payload.cwd`；`turn_context.payload.cwd` 每轮一份；另有 `payload.git.*`、`workspace_roots` | 每会话（每轮也有） | 2,919/2,919 个 rollout 有 `cwd`；30/30 个文件每轮 `cwd` 与会话头一致；`git.repository_url` 存在但不读 | 高 | 取首个 `session_meta.cwd`；fork 与子代理在文件后部重放的父级 `session_meta` 一律忽略，与扫描器规则一致 | Multica 任务目录在 TTL（默认 14 天）后被删除，git 探测不到时退回字符串规则或“托管会话” |
| OpenCode（`opencode_`） | 助手消息 `message.data.path.{cwd, root}`；`session.directory`；`project.worktree`、`project.vcs` | 每条消息（抽查 15 个会话，会话内都只有一个值） | 190 个会话中 186 个有助手消息 `path.cwd`。**git 项目**的 44 个会话：首条助手消息 `path.cwd` 都等于 `session.directory`，且目录都在 git 仓库内。**全局（非 git）项目**的 146 个会话：`session.directory` 只有 9 个不同值，首条消息 `path.cwd` 有 53 个；两者相等 68 个、不相关 71 个、消息目录是会话目录的子目录 3 个、无助手消息 4 个。不相关的 71 个中，26 个的 `path.cwd` 在 git 仓库内而 `session.directory` 不在，17 个的 `path.cwd` 已被删除 | 高 | 取首条助手消息的 `path.cwd`，缺失时退回 `session.directory`。`path.root` 在 git 项目中等于仓库根，可直接作为仓库根；在全局项目中为 `/`，不使用 | 全局项目的 `session.directory` 粒度粗，像启动目录，不作为首选；原因未在 OpenCode 源码中确认（R10） |
| Kilo（`kilo_`） | 与 OpenCode 相同 | 同上 | 3 个会话都属于 git 项目，目录都在 `project.worktree` 内；1 个有助手消息 `path.cwd` 且等于 `session.directory`，2 个没有 | 高 | 同 OpenCode | 样本少 |
| Antigravity（`antigravity_`） | 无。transcript 行只有 `content/created_at/error/source/status/step_index/thinking/tool_calls/truncated_fields/type` | — | 未发现目录字段 | 无 | 未归属（来源不支持） | 只能从内容或工具参数推断，违反 C7。IDE 自身状态库属于未公开格式，v1 不碰 |
| MiniMax Code v2 / 旧库（`mavis_`） | v2：`local_runtime_sessions.{workspace_dir, project_workspace_dir, is_default_workspace}`，按 `session_id` 关联 `local_runtime_token_usage`；旧库：`sessions.workspace_dir` | 每会话 | v2：113/113 个会话有 `workspace_dir`，3,449/3,449 条用量行能关联。其中 45 个是默认工作区，分布在 35 个不同目录（36 个会话在用户目录、9 个在 `~/.minimax`）。非默认的 68 个会话 `workspace_dir = project_workspace_dir`；`project_workspace_dir` 为空的 10 个都属于默认工作区。旧库：137/164 个会话有目录，8,186/8,872 行能关联 | 高（v2）/中（旧库） | 非默认取 `project_workspace_dir`，缺失时取 `workspace_dir`；`is_default_workspace = 1` 归入“托管会话” | 旧库有 27 个会话无目录；前缀无法区分 v2 与旧库，先查 v2，再查旧库 |
| 腾讯 Marvis（`marvis_tencent_`） | 无。`conversations.metadata` 与 `llm_token_usage.metadata` 样本为空 | — | 无目录列 | 无 | 未归属（来源不支持） | — |
| WorkBuddy 项目日志（`workbuddy_project_`） | 每行 JSONL 顶层 `cwd` | 每条记录（每文件不变） | 27/30 个文件只有 1 个 `cwd`，其余 3 个没有；`projects/` 下的目录名不是由 `cwd` 派生 | 高 | 取首个 `cwd` | 无 `cwd` 的文件标“无法确定” |
| WorkBuddy Agent 日志（`workbuddy_`，其余） | 无（正则解析文本日志） | — | — | 无 | 未归属（来源不支持） | 仅在没有项目日志时兜底扫描，占比可忽略 |
| Qclaw JSONL（`qclaw_jsonl_`） | 第 1 行会话头 `cwd`（Pi 格式） | 每会话 | 20/20 个文件第 1 行有 `cwd` | 高 | 取会话头 `cwd` | — |
| Hermes（`hermes_`，tool = `hermes`） | `state.db` 的 `sessions.cwd`、`sessions.git_repo_root` | 每会话 | 9/11 个会话有 `cwd`；`git_repo_root` 0/11（`source = tui`）；同表的 `title`、`system_prompt`、`display_name`、`git_branch` 等列不读 | 高 | `git_repo_root` 存在时作为仓库根，否则取 `cwd` | 同前缀的 Qclaw Hermes 响应库以 `response_id` 为会话、没有目录，记为“来源不支持” |
| ReasoniX（`reasonix_`） | 新版 `projects/<编码后的工作区>/sessions/<id>.jsonl.meta` 的 `workspace_root`；经典 `sessions/<id>.meta.json` 的 `workspace` | 每会话 | 新版 2/10 个 meta 有 `workspace_root`；经典 5/5 有 `workspace`；`projects/` 下是编码目录名 | 中 | 取本会话字段；缺失时用同一 `projects/<编码目录>/` 下任一兄弟会话的 `workspace_root`，前提是把它编码后与目录名完全一致 | 整个目录没有任何会话带字段时标“无法确定”；恢复分叉按根会话 ID 查找（`reasonix_root_session_id`） |
| Trae（`trae_`） | 无。stdout 文本日志的用量行不含工作区 | — | 6 个样本日志中没有任何一行提及 cwd 或 workspace | 无 | 未归属（来源不支持） | — |
| DeepSeek GUI（`deepseekgui_`） | `threads/<threadId>/metadata.jsonl` 的 `thread.workspace` | 每会话（线程） | 抽样 20 个线程，92 行 `thread.workspace` 都是绝对路径；`thread` 另有 `title` 等键，不读；events 行没有目录字段 | 高 | 取 `thread.workspace` | — |
| DeepSeek 官方 DSH（`dsh_`） | zstd 流第一条 `type = session` 事件的 `cwd`；上级目录 `--<编码>--` | 每会话 | 2/2 样本会话头有 `cwd`，与扫描器 fixture 一致 | 高 | 取会话头 `cwd`，只解压到第一行 | — |
| Grok CLI（`grok_`） | `sessions/<URL 编码的 cwd>/<uuid>/summary.json` 的 `info.cwd`、`git_root_dir` | 每会话（`sid`） | 20/20 有 `info.cwd` 与 `git_root_dir`；`git_remotes`、`head_branch`、`generated_title`、`session_summary` 存在但不读 | 高 | `git_root_dir` 作为仓库根；缺失时取 `info.cwd` | — |
| Gemini CLI（`gemini_cli_`） | 会话头 `projectHash`；`~/.gemini/tmp/<项目短名>/.project_root`；`~/.gemini/projects.json` | 每个项目目录 | 10/11 个 tmp 目录有 `.project_root`（绝对路径），10/11 个目录名出现在 `projects.json` 中；会话头 `projectHash` 为 64 位十六进制，但与 `.project_root` 内容的 SHA-256 不相等（0/8） | 高（有标记）/无（旧哈希目录） | 会话文件所在 tmp 目录的 `.project_root` | 不依赖 `projectHash`；没有标记的旧目录标“无法确定” |
| Zcode（`zcode_`） | `session.directory`（与 `session.path` 相同）；消息里也有 `path.{cwd, root}` | 每会话 | 228/228 个会话有目录；1,254/1,254 条 `model_usage` 能关联到有目录的会话；抽样 520 条消息的 `path.root` 都等于 `session.directory`，其中 50 条的 `path.cwd` 是它的子目录 | 高 | 取 `session.directory` | — |
| Kimi Code（`kimi_`、`kimi_v2_`） | `sessions/<工作区目录>/<会话>/state.json` 的 `workDir`（部分文件另有 `cwd`）；`session_index.jsonl` 的 `{sessionId, sessionDir, workDir}`；`workspaces.json` 的 `{root, name}` | 每会话 | `session_index.jsonl` 40/40 行有 `workDir`；抽样 20 个 `state.json`，15 个有 `workDir`；另一批 40 个中 8 个带 `cwd` 键（2 个与 `workDir` 相同）；`workspaces.json` 的 8 个工作区键都形如 `wd_<文件夹名>_<哈希>`，都含根目录末级名；`state.json` 的 `title`、`lastPrompt` 不读 | 高 | 依次取 `state.json.workDir`、索引行 `workDir`、`state.json.cwd`，最后取所属工作区的 `root` | — |
| Kimi Desktop（`kimidesktop_*`） | 同 Kimi Code | 每会话 | 抽样 20 个 `state.json`，都有 `workDir`；49 个样本都没有 `cwd` 键；索引 49/49；7 个工作区键中 6 个含根目录末级名 | 高 | 同上 | — |
| Pi（`pi_`，含 Multica `pi-sessions`） | 第 1 行会话头 `cwd`；默认目录 `--<编码后的 cwd>--` | 每会话 | 2/2 样本有 `cwd`；本机无 Multica Pi 样本 | 高 | 取会话头 `cwd` | Multica 任务目录可能已被回收，按“托管会话”或字符串规则处理 |

本机样本还说明一件事：Kimi 的工作区目录名、Claude 与 ReasoniX 的编码目录名，本来就把文件夹名写在来源日志的路径里。TokenLedger 为增量扫描保存的来源文件路径因此已经带有这些信息（§3.9）。

### 2.3 粒度：按会话归属

- 所有“高”档来源都至少能按会话取得目录。按记录取目录的来源（Claude、OpenCode、WorkBuddy）在同一会话内也几乎不变：Codex 30/30 一致，OpenCode 15/15 唯一，WorkBuddy 27/27 唯一；Claude 的额外值抽查 25/25 都是首个目录的子目录，经 §2.4 的 git 根归并后仍是同一项目。
- 决定：**一个会话只归属一个项目，取来源记录的第一个工作目录**（通常是启动目录）。会话中途切到另一个仓库时仍整段归入启动目录，作为已知限制写进设置说明；按记录归属留到 v2。
- 会话键与行为契约保持一致：`(tool, session_id)`。与 T10.151 相同，空值、纯空白和 `unknown_session` 视为“缺少会话 ID”，不建索引，计入“未归属：缺少会话 ID”。

### 2.4 项目名推导

输入是某个会话的绝对工作目录 P（只在内存中），以及来源提供的可选仓库根 R（Grok `git_root_dir`、Hermes `git_repo_root`、OpenCode `path.root`）。按下列顺序取第一个命中的结果：

1. **规范化。** 去空白；接受 `C:\`、`C:/`、`\\?\C:\`、UNC、MSYS `/c/...`（仅 Windows 主机）和 POSIX 路径；按字面去掉 `.`、`..` 和尾部分隔符，不做 `canonicalize`。相对路径或空值记为“无法确定”（`invalid_path`）。
2. **固定分组。**（Windows 与 macOS 不区分大小写。）等于用户主目录 → `home`；是盘符根或 `/` → `root`；在系统临时目录内（`%TEMP%`、`/tmp`、`/private/var/folders`）→ `temp`。这些分组不保存名字。
3. **git 探测**（仅当 P 在本机固定卷上且目录存在）。从 P 向上逐级检查 `<dir>/.git`，最多 24 级，到主目录或卷根为止，不越过主目录：
   - `.git` 是目录：仓库根 = `dir`，项目名 = `dir` 的末级名（`git_root`）。
   - `.git` 是文件（最多读 4 KiB，只取 `gitdir:` 行）：指向 `…/.git/worktrees/<名>` 时，再读该目录的 `commondir`（最多 4 KiB）得到公共 git 目录 C。C 的末级名是 `.git` 时，项目名取 C 的上级目录名；否则 C 是裸仓库，项目名取 C 的末级名并去掉 `.git` 后缀（`git_worktree`）。指向 `…/.git/modules/…` 时是子模块，项目名取子模块自己的目录名（`git_submodule`）。
   - 找到的仓库根恰好是主目录（dotfiles 仓库）时，丢弃 git 结果，继续后面的规则。
   - 不读 `.git` 里的其他任何文件（config、HEAD、refs、objects），不执行 git 命令，不经 shell。UNC、WSL、网络盘和不可访问的目录不探测。权限错误直接退到后续规则。
4. **来源给出的仓库根 R**：取 R 的末级名，并对 R 应用第 6 步的 worktree 字符串规则（`source_git_root`）。
5. **托管目录**：P 在应用数据目录（`%APPDATA%`、`%LOCALAPPDATA%`、`~/Library/Application Support`）、`~/multica_workspaces_*`、`~/.multica` 内，或来源标记为默认工作区（MiniMax `is_default_workspace = 1`）→ `managed`。git 探测排在这一步之前，所以托管目录里的真实仓库（例如 Codex 桌面版的 worktree）仍按仓库名归属。
6. **worktree 字符串规则**（目录已删除、无法探测时使用）：
   - 某级祖先目录名以 `-worktrees`、`.worktrees` 或 `_worktrees` 结尾 → 项目名取该目录名去掉后缀，例如 `…/TokenLedger-worktrees/T10.150-visual-refresh` → `TokenLedger`。
   - 路径含 `/.claude/worktrees/<名>` 或 `/.worktrees/<名>` → 项目名取 `.claude` 或 `.worktrees` 的上级目录名。
   - `~/.codex/worktrees/<id>/<仓库>` → 末级名本身就是仓库名，直接使用。
   - 以上命中记为 `worktree_heuristic`。
7. **目录名**：P 的末级名（`folder`）。

**项目名清洗。** 做 NFC 规范化（macOS 文件名可能是 NFD）；去掉控制字符和双向覆盖字符（U+202A–202E、U+2066–2069）；首尾去空白，连续空白合并为一个；按字素截断到 64 个字符并加 `…`；结果为空、`.` 或 `..` 时记为“无法确定”。

**项目键。** 命名项目为 `n:` + 项目名的 Unicode 小写形式；固定分组为 `@home`、`@root`、`@temp`、`@managed`。同一个键下有多种大小写写法时，显示会话数最多的那种，并列时按码点序取第一个。

示例（路径均为虚构）：

| 会话目录 | 条件 | 项目 |
|---|---|---|
| `D:\src\TokenLedger` | 含 `.git` 目录 | `TokenLedger`（git_root） |
| `D:\src\TokenLedger\apps\android` | 上级含 `.git` 目录 | `TokenLedger`（git_root） |
| `D:\src\TokenLedger-worktrees\T10.150-visual-refresh` | `.git` 文件指向 `D:\src\TokenLedger\.git\worktrees\…` | `TokenLedger`（git_worktree） |
| 同上 | 目录已删除 | `TokenLedger`（worktree_heuristic） |
| `D:\src\TokenLedger\.claude\worktrees\fix-x` | 目录已删除 | `TokenLedger`（worktree_heuristic） |
| `~/.codex/worktrees/1a2b/TokenLedger` | linked worktree | `TokenLedger` |
| `C:\Users\<用户>` | 等于主目录 | 主目录 |
| `C:\` | 盘符根 | 磁盘根目录 |
| `%TEMP%\scratch-1` | 临时目录 | 临时目录 |
| `%APPDATA%\Claude\local-agent-mode-sessions\…` | 应用数据目录，非仓库 | 托管会话 |
| `\\nas\share\report-2026` | UNC，不探测 | `report-2026`（folder） |
| `~/notes`，而 `~` 本身是 dotfiles 仓库 | git 结果被丢弃 | `notes`（folder） |

**本机实测：各规则的命中次数**（只统计类别，见附录 A）

| 类别 | Codex 2,919 个 rollout 的会话头 `cwd` | Claude 773 个日志（含子代理）的首个 `cwd` |
|---|---|---|
| 启动目录本身是仓库根 | 2,375（81.4%） | 687 |
| 上级目录是仓库根 | 188（6.4%） | 36 |
| linked worktree，经 `commondir` 归并 | 102（3.5%，都在 `~/.codex/worktrees/<id>/<仓库>` 下） | 5 |
| 目录已删除，由 worktree 字符串规则找回 | 2 | 32（都在 `.claude/worktrees/<名>` 下） |
| 目录已删除，退回目录名 | 21 | 0 |
| 不在仓库内，取目录名 | 196（6.7%） | 2 |
| 应用数据目录（托管会话） | 33 | 0 |
| Multica 目录（托管会话，已回收） | 0 | 2 |
| 主目录 | 2 | 8 |
| 没有 `cwd` | 0 | 1 |

git 探测能把 91.3% 的 Codex 会话和 94.2% 的 Claude 日志归到仓库名。`.claude/worktrees` 字符串规则在 worktree 目录删除后还能再找回 32 个 Claude 日志。`-worktrees` 后缀规则在本机没有命中，仍然保留：AGENTS.md 建议的 worktree 位置就是 `TokenLedger-worktrees/<任务ID>-<简述>`，目录删除后只能靠它归并。

## 3. 隐私模型

### 3.1 开启流程

1. 设置 →「数据与帮助」新增卡片“按项目统计”（§6.2），默认关闭。卡片常显 §3.2 的三段说明。
2. 打开开关时弹出确认框（`role="dialog"`，Escape 与焦点恢复沿用现有约定）。按钮为“开启并建立索引”和“取消”，确认前不读取任何工作目录。
3. 确认后调用专用命令 `set_project_dimension({ enabled: true, consentVersion: 1 })`。命令写入 `AppSettings.project_dimension_enabled = true` 与 `project_dimension_consent_version = 1`，递增索引代次，并在后台开始回填。不走通用 `save_settings`，避免其他设置保存时误开这个开关（与 `set_desktop_widget_enabled` 的做法一致）。
4. 回填期间卡片与行为分析页都显示进度：“正在建立项目索引：已处理 x / y 个会话”。完成后发出 `project-index-updated` 事件，行为分析页静默重取。
5. **授权版本。** `PROJECT_DIMENSION_CONSENT_VERSION = 1`。以后如果读取范围扩大（例如开始读取远程地址或新的数据类别），版本号加一：旧授权自动暂停采集，已存数据不显示，直到用户重新确认或选择关闭并删除。这与壁纸授权代次（GLB-06、DESIGN §4.5、ADR-015）是同一模式。新增一个读取同类字段的来源不需要升版本。`AppSettings::sanitized()` 在授权版本过低时把生效状态视为关闭。

### 3.2 设置文案

以下为可直接使用的定稿文案；视觉由 T10.150 的设置样式决定。

- **标题**：按项目统计
- **开关**：按项目统计本机用量（默认关闭）
- **说明**：开启后，TokenLedger 会读取各 AI 工具日志里记录的工作文件夹，只把文件夹名称（例如“TokenLedger”）保存在这台电脑上，用于在「行为分析」里按项目查看用量。
- **会读取**
  - 支持的工具在会话记录里写下的工作目录，例如 Claude Code、Codex 会话开头的工作目录，OpenCode、Zcode 的会话目录。
  - 这个文件夹及其上级文件夹是否是 git 仓库：只查看 `.git` 在哪里，用来把子文件夹和 worktree 归到同一个仓库名下。
- **不会读取，也不会保存**
  - 不保存完整路径、上级文件夹、盘符或用户名。在主目录、磁盘根目录、临时目录或工具自带的托管目录里运行的会话，分别显示为“主目录”“磁盘根目录”“临时目录”“托管会话”。
  - 不读取对话内容、代码文件、分支名、提交记录或远程仓库地址。
  - 项目名不会离开这台电脑：不参与云同步，也不会出现在 Android、分享海报、HTML 简报和 CSV 导出中。
- **关闭时**：立即停止读取，并删除这台电脑上已保存的全部项目名。重新开启会重新建立索引。
- **已知限制**：Antigravity、Trae、腾讯 Marvis 等工具的日志不记录工作目录，它们的用量显示为“未归属”；不同位置的同名文件夹会合并成一个项目；工具已经清理的旧日志无法再确定项目；一次会话只算入启动时所在的项目。
- **技术细节**（默认折叠）：为了只扫描有变化的日志，TokenLedger 一直在本机数据库记录各个日志文件的位置，部分工具（例如 Claude Code、Kimi）的日志文件夹名本身就包含工作目录的编码。这些记录与本开关无关，只用于增量扫描，从不同步。
- **开启确认框**：标题“开启按项目统计？”，正文为上面“会读取”和“不会读取”两段的精简版，按钮“开启并建立索引”“取消”。
- **关闭确认框**：标题“关闭按项目统计？”，正文“将停止读取工作目录，并删除这台电脑上已保存的 N 个项目名。行为分析将不再显示项目。”，按钮“关闭并删除”“保留开启”。

### 3.3 存储选择：末级目录名还是加盐哈希

| 方案 | 能回答“哪个项目最花钱”吗 | 同名碰撞 | 泄露面 | 复杂度 |
|---|---|---|---|---|
| A. 只存项目名（推荐） | 能，直接可读 | 不同位置的同名文件夹会合并。git 根归并后，常见的 `src`、`frontend` 子目录会并回仓库名，剩下的碰撞主要是同一仓库的多份克隆，用户通常也希望合并 | 只有文件夹名；主目录、临时目录这类会暴露用户名或随机名的路径改记固定分组 | 低：不需要密钥管理，也不需要新依赖 |
| B. 只存加盐哈希 | 不能，界面只能显示“项目 3f2a”；让用户手动命名，等于又把可读名存回来 | 几乎没有（64 位截断） | 盐与数据放在同一个库里时，攻击者可以按“猜上级路径 + 已知项目名”做字典攻击；本机数据库本来就存有来源文件路径（§3.9），额外保护有限 | 中：盐的生成、删除、轮换都要测试 |
| C. 项目名 + 加盐指纹 | 能 | 能区分同名的不同仓库 | 同 B | 中 |

**推荐 A。** 理由：
- D5② 允许“末级目录名或哈希”，这个维度要回答的就是可读的问题，B 无法直接用。
- A 的承诺最容易说清楚，也最容易验证：“只存文件夹名”。
- 在当前威胁模型下，C 的额外隐私收益接近零：数据不出本机，而同一个数据库里已有来源文件路径。
- 同名合并作为已知限制写进设置说明。如果用户反馈误合并，再按 C 增加“区分同名文件夹”选项。

**如果以后采用 B 或 C，盐放在哪里：**
- 开启时用操作系统的安全随机源生成 32 字节盐，存进 `local_project_index_state.salt`（本机数据库），关闭时随数据一起删除。这相当于加密擦除：再次开启会生成新盐，旧哈希无法再关联。
- 不放进 `app_settings.json`：该文件会被单独复制和排查。不放进系统钥匙串：它不是凭据，而且 macOS 会弹出授权提示。
- 用 `HMAC-SHA256(salt, 规范化后的仓库根)`，截断为 64 位。`sha2` 已是现有依赖；如果要引入 `hmac` crate，需要 root 修改 lockfile（单写）。
- 盐不写日志，不导出，不同步。

另有一个与存储无关的显示层选项，建议作为 P2 放进 v1.x：行为分析页的“隐藏项目名”开关，与“成本隐身”同类，把项目名显示成“项目 A / B / C”，方便截图。存储内容不变。

### 3.4 读取边界

- **独立模块。** 新建 `src-tauri/src/project_index/`，不修改扫描器的解析路径，也不扩充 `session_analysis/reader.rs` 的白名单（该白名单有意不含 `cwd`，`reader.rs:47-96`）。
- **白名单反序列化。** 复用 `session_analysis` 的 `IgnoredAny` 投影思路：每个来源只保留自己的少数键，其他值直接跳过，不为提示词分配字符串。白名单键为：`type`、`id`、`sessionId`、`cwd`、`payload.cwd`、`info.{id,cwd}`、`git_root_dir`、`thread.{id,workspace}`、`workDir`、`workspace`、`workspace_root`。
- **SQLite。** 只用原生 SQLite 只读事务，busy timeout 5 秒，与扫描器相同；只写显式列。OpenCode 用 `json_extract(data, '$.path.cwd' | '$.path.root' | '$.role')`，正文不离开 SQLite。
- **读取上限。**
  - Claude：到第一个带 `cwd` 的行为止，最多 64 行或 256 KiB。
  - Codex：只读第一行，最多 1 MiB（本机最大 `session_meta` 行约 50 KB）。
  - DSH：只解压到第一行，最多 256 KiB。
  - `.project_root`、`.git` 文件、`commondir`：每个最多 4 KiB。
  - git 探测：最多 24 级。
- **明确不读的字段。** 以下字段本机样本中确实存在，一律不读，正文也不读：
  - 分支、提交与远程：`gitBranch`、`git.*`、`git_branch`、`git_remotes`、`head_branch`、`head_commit`；
  - 标题与摘要：`title`、`generated_title`、`session_summary`、`display_name`、`topic_title`、`preview`；
  - 提示词与目标：`lastPrompt`、`goal`、`system_prompt`、`origin_json`。
- **不走 Claude status line。** status line 输入虽然带 `cwd` 和 workspace 字段，但既有测试 `quota_claude_helper_persists_only_whitelisted_normalized_fields`（`quota/mod.rs:6161`）要求 status line 快照里不出现 `cwd`，这条保持不变。

### 3.5 只在本机：云同步守卫

同步路径看不到项目数据，靠的是以下四处结构约束。实现时必须保持，并用测试锁住：

1. **两条同步 SQL。**
   - `PENDING_SYNC_WORK_SQL`（`src-tauri/src/commands/mod.rs:10000`）只判断是否存在待同步行。
   - `RAW_SYNC_LOGS_SQL`（`:10018-10035`）只选 `token_logs` 的 12 个显式列，不含 `session_id` 和 `unique_key`。
   - 两条 SQL 除 `token_logs` 外只引用 `pending_cloud_purges`。
2. `sync_to_supabase_impl` 的聚合键 `AggKey { tool, model, hour_bucket, machine_id }`（`:10098-10104`）。
3. 固定载荷 `json!({...})`（`:10207-10222`）：`session_id` 恒为 `"agg"`（`:10217`），发送前还会删掉 `raw_ids`。
4. Supabase `token_logs` 没有项目列；PostgREST 会拒绝未知列。任何为项目新增云端列的迁移都违反 D5②。

新增的回归测试见 §7 的 G1–G3。另外两个会把数据带出本机的入口也要锁住：
- CSV 导出 `export_db_csv_impl`（`:7449`，列清单在 `:7456`）不增加项目列。
- 分享海报与 HTML 简报只接收 `StatsData`（DESIGN §4.7），不得引入行为分析的项目字段。

### 3.6 关闭：停止读取并清除

`set_project_dimension({ enabled: false })` 在返回成功前完成以下步骤：

1. 递增索引代次，使正在进行的回填和增量解析在下一个检查点丢弃结果。所有写入都带代次条件：`WHERE generation = ?`。
2. 在同一个事务里执行 `PRAGMA secure_delete = ON`，然后 `DELETE FROM local_session_projects` 和 `DELETE FROM local_project_index_state`。
3. 事务提交后执行 `PRAGMA wal_checkpoint(TRUNCATE)`，不让旧页留在 WAL 里。
4. 写回 `project_dimension_enabled = false`，发出 `project-index-updated`，行为分析页清空项目筛选并回到关闭态。
5. 已有的“回收空间”操作（VACUUM）仍可用于回收空闲页，但清除本身不依赖它。

关闭后，扫描器与索引都不再读取任何工作目录字段，git 探测也不再运行。

### 3.7 数据出口排除清单

| 出口 | 处理 | 依据 |
|---|---|---|
| 云同步（token_logs 聚合、额度快照同步） | 不含 | §3.5 |
| Stats v2（本机与云端）、Android、云端 RPC | 不含，契约不变 | ADR-002；项目维度只在本机行为契约中 |
| 分享海报、HTML 简报 | 不含 | 只接收 `StatsData` |
| CSV 导出 | 不含 | 列清单固定 |
| 托盘挂件、桌面小组件、壁纸 | 不含 | 都只用 Stats v2 或缓存统计 |
| `local_stats_cache` | 不含 | 行为分析不走该缓存；如果以后加缓存，关闭时必须一并清除 |
| 开发 mock（`src/devMockTauri.ts`） | 只用虚构项目名 | 证据规则 |

### 3.8 日志与错误脱敏

- `project_index` 模块只记录计数、耗时、来源族名称和固定原因码（`source_missing`、`field_missing`、`invalid_path`、`unsupported_source`、`budget_exceeded`、`cancelled`）。不记录路径、项目名、会话 ID 或原始错误文本。
- 既有扫描器的 `log::warn!("{error}")` 会带出来源文件路径，这是现状；新模块不沿用这个写法。
- 返回给前端的错误同样只带原因码。
- 用静态测试锁住：该模块的 `log::*!` 宏只允许字面量，或只插值计数和原因码（§7 G5）。

### 3.9 现有基线：本机数据库已有来源文件路径

`scan_source_cursors.source_path` 与 `scan_checkpoints.source_path`（表定义在 `db.rs:188`、`db.rs:225`）为增量扫描保存规范化后的来源文件绝对路径。其中 Claude 的 `projects/<编码后的 cwd>`、Pi 与 DSH 的 `--<编码>--`、Grok 的 URL 编码目录、ReasoniX 的 `projects/<编码>`、Kimi 的 `wd_<文件夹名>_<哈希>` 都含有工作目录信息。这些数据只在本机、不同步，并且与本开关无关。

因此，本方案承诺的准确表述是：**“项目维度不新增完整路径，不让项目信息离开本机”**，而不是“数据库里没有任何路径信息”。§3.2 的“技术细节”如实说明这一点。是否对检查点路径做哈希化，是独立的隐私改进议题，不在本任务范围内，改动会波及所有检查点的兼容性。

## 4. 数据模型

### 4.1 表结构

在下一个空闲的 `PRAGMA user_version` 中新增两张本机表。撰写时为 v13，编号由 root 在合入时分配（迁移编号单写）。

```sql
CREATE TABLE IF NOT EXISTS local_session_projects (
    tool TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_family TEXT NOT NULL,          -- 由 unique_key 前缀判定，见 §2.2
    project_kind TEXT NOT NULL
        CHECK (project_kind IN ('named','home','root','temp','managed','unresolved')),
    project_key TEXT NOT NULL,            -- 'n:<小写项目名>' | '@home' | '@root' | '@temp' | '@managed' | '@unresolved'
    project_label TEXT,                   -- 仅 named 时非空：清洗后的末级目录名
    resolution TEXT NOT NULL
        CHECK (resolution IN ('git_root','git_worktree','git_submodule','source_git_root',
                              'worktree_heuristic','folder','bucket',
                              'unsupported_source','source_missing','field_missing','invalid_path')),
    generation INTEGER NOT NULL,          -- 写入时的索引代次，关闭/重开后旧写入作废
    resolver_version INTEGER NOT NULL,
    resolved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (tool, session_id),
    CHECK ((project_kind = 'named') = (project_label IS NOT NULL))
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS local_session_projects_key_idx
    ON local_session_projects (project_key);

CREATE TABLE IF NOT EXISTS local_project_index_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL,
    backfill_status TEXT NOT NULL
        CHECK (backfill_status IN ('running','done','cancelled','failed')),
    backfill_total INTEGER NOT NULL DEFAULT 0,
    backfill_done INTEGER NOT NULL DEFAULT 0,
    last_failure TEXT,                    -- 只存 §3.8 的原因码
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

- **一个会话一行**，本机账本约 5,116 行。不支持的来源族也写一行（`unresolved` + `unsupported_source`），这样聚合时只按 `(tool, session_id)` 查表：`StatRow` 没有 `unique_key`，不需要为此扩列。没有行的会话就是“索引中”。
- **不改 `token_logs`**：不加列、不加索引、不改 `unique_key`。行为分析在 Rust 内存中聚合（`build_local_behavior_analysis`，`commands/mod.rs:5208`），查询时一次性把映射表读进 `HashMap<(tool, session_id), ProjectRef>` 即可。不加 `token_logs(tool, session_id)` 索引（T10.105c 实测这类索引在真实账本上各占 12–15 MB）。
- **开关状态放在 `AppSettings`**，与其他授权开关的位置一致；回填进度放在数据库，与写入在同一事务里。
- **迁移本身只建空表**，不做任何数据回填；数据只在用户开启后写入。

### 4.2 回填与增量

**开启后回填全部历史会话，只读文件头，不重扫 Token。**

| 策略 | 需要读多少（本机实测） | 结论 |
|---|---|---|
| 只处理开启后的新记录 | 0 | 否决：历史归属才是这个功能的主要价值，而回填本身很便宜 |
| 让检查点失效并重扫 Token | Claude 766 个文件共 1,099 MiB，Codex 2,919 个文件共 18,746 MiB，合计约 19.4 GiB，还要经过去重与累计状态逻辑 | 否决：代价高，还可能影响去重与累计快照 |
| 按会话读文件头或库字段（推荐） | Claude 13.2 MB / 0.48 s；Codex 108 MB / 3.2 s；OpenCode 190 次查询 / 0.26 s；枚举 5,116 个会话对 / 0.66 s（481,687 行账本） | 采用 |

实测环境：本机 Windows，CPU 被约 12 个并行代理占满，只统计次数、字节和毫秒。

**回填流程：**
1. `SELECT tool, session_id, MIN(unique_key) FROM token_logs GROUP BY tool, session_id`。跳过缺少会话 ID 的记录，用 `MIN(unique_key)` 的前缀判定来源族。
2. 对每个来源族，一次性建立定位索引：遍历该来源的根目录，把会话 ID 映射到文件，或直接按会话 ID 查询来源库。然后按 §3.4 的上限读取字段，并按 §2.4 算出项目名。
3. 每处理 200 个会话提交一次事务（带代次条件），并更新进度，发出 `project-index-progress { done, total }` 事件。
4. 在后台线程、低优先级运行，每个会话之间检查代次，可随时因关闭而中止。
5. 失败不影响扫描和看板，只写入原因码。

**增量解析：**
- 开启状态下，每次 `persist_scan_batch`（`scanner/runner.rs:379`）提交后，取本批日志里新出现的 `(tool, session_id)`（按主键查表判断），在事务之外解析。
- 累计型来源（Hermes、ReasoniX）每轮都会产生增量行，但会话已有映射，直接跳过。
- 增量解析失败不改变扫描结果，也不延迟 `stats-updated`。

**规则升级：** `resolver_version` 提高后，后台用同样的只读方式重新回填。旧的项目名在被替换前继续显示。

### 4.3 去重键不变

- `unique_key` 的所有格式、`INSERT OR IGNORE`、Claude 快照原位修正、OpenCode/Kilo 原位更新、累计增量行、检查点与游标全部不变。项目索引不写 `token_logs`，也不改 `sync_status`。
- 回归测试：同一组 fixture 在开关开启和关闭时，写入的行数、`unique_key` 集合和各行数值完全一致（§7 D1）。

### 4.4 保留与清理

- 映射行随会话存在。会话的全部账本行被删除后，映射行变成孤儿，在以下时点回收：
  - 「清理旧数据」（按日期删除记录）之后；
  - Codex v9 分阶段重建交换（`complete_codex_rebuild_swap`）之后；
  - 以后的按工具清库迁移（类似 v2、v10、v12）之后；
  - 每次回填开始时。
- 回收 SQL 使用行值 `NOT IN`。SQLite 会把子查询物化成一次临时索引，只扫描一遍账本，避免逐行相关子查询：

  ```sql
  DELETE FROM local_session_projects
  WHERE (tool, session_id) NOT IN (SELECT tool, session_id FROM token_logs);
  ```

- 本机账本没有自动过期策略，映射表不另设过期时间。关闭开关就是完整清除（§3.6）。

## 5. 契约：本机行为契约只增字段

契约 `behavior-analysis-local-v1.md` 在 T10.151 期间由该任务唯一持有。T10.151 的范围包括：
- 缺少会话 ID 的处理，已在其工作区写成 v1.1；
- D5① 的会话费用元数据。

本节是在 T10.151 合入后追加的只增提案，暂称“v1.x 项目维度”，版本号由 root 定。

### 5.1 请求

```ts
get_local_behavior_analysis({ query: LocalStatsQuery, projects?: string[] | null })
```

- `projects` 是新增的可选顶层参数。它不放进 `LocalStatsQuery`，因为该类型是 Stats v2 的共享查询形状，项目维度不得进入跨端契约。
- 取值是响应中返回的不透明 `key`。另有保留值 `@unattributed`，表示“全部未归属”。前端不得用项目名拼出键。
- 过滤对所有维度同时生效（summary、tools、sessions、dayHours、modelHours、modelDays、requestSizes 和项目字段本身）。
- 项目维度未开启却传入非空 `projects` 时，返回可读错误码 `project_dimension_disabled`，不静默忽略，避免界面把未过滤的数据当作过滤结果显示。前端在收到关闭事件时会清空筛选。

### 5.2 响应新增字段

```json
{
  "meta": {
    "projectDimension": {
      "state": "ready",
      "indexedSessions": 5023,
      "pendingSessions": 93,
      "filter": ["n:tokenledger"]
    }
  },
  "projects": [
    {
      "key": "n:tokenledger", "label": "TokenLedger", "kind": "named",
      "tokens": 0, "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0,
      "requests": 0, "sessionCount": 0,
      "firstAt": "2026-09-01 09:00:00", "lastAt": "2026-09-23 18:00:00",
      "tools": [{ "id": "Claude", "tokens": 0 }]
    },
    { "key": "@home", "label": null, "kind": "home", "tokens": 0, "requests": 0, "sessionCount": 0 }
  ],
  "projectLimit": 50,
  "projectsTruncated": false,
  "projectsRemainder": null,
  "unattributed": {
    "tokens": 0, "requests": 0, "sessionCount": 0,
    "reasons": [
      { "reason": "unsupported_source", "tokens": 0, "requests": 0, "sessionCount": 0 },
      { "reason": "unresolved", "tokens": 0, "requests": 0, "sessionCount": 0 },
      { "reason": "pending", "tokens": 0, "requests": 0, "sessionCount": 0 },
      { "reason": "missing_session", "tokens": 0, "requests": 0, "sessionCount": 0 }
    ]
  },
  "sessions": [
    { "id": "opaque-session-id", "tool": "Codex", "tokens": 0, "requests": 0,
      "project": { "key": "n:tokenledger", "label": "TokenLedger", "kind": "named" } },
    { "id": "opaque-session-id-2", "tool": "Antigravity", "tokens": 0, "requests": 0,
      "project": null, "projectReason": "unsupported_source" }
  ]
}
```

- **`meta.projectDimension.state`** 取 `disabled | indexing | ready`。
  - 为 `disabled` 时响应只有这一个对象，不含 `projects`、`unattributed` 和 `sessions[].project`。
  - 整个 `meta.projectDimension` 缺失，表示后端不支持项目维度（旧版本）。前端不得把缺失当作关闭或 0。
- **`projects[]`**：
  - 按有效 Token 降序排列，相同时按 `key` 的码点序；最多 `projectLimit = 50` 个。
  - 截断时 `projectsRemainder = { tokens, inputTokens, outputTokens, cachedTokens, requests, sessionCount, projectCount }`，不截断时为 `null`。
  - 固定分组（`home`、`root`、`temp`、`managed`）按实际用量排在同一列表中，`label` 为 `null`，由前端显示本地化名称。
  - `projects[].tools[].id` 与顶层 `tools[].id` 取值相同。
- **`unattributed.reasons`**：
  - `unsupported_source`：来源不提供工作目录。
  - `unresolved`：来源支持，但日志已被清理、字段缺失或路径无效。
  - `pending`：尚未建立索引。
  - `missing_session`：缺少会话 ID，与 v1.1 的 `unknownSession*` 是同一批记录。
  - 为 0 的原因可以省略。
- **费用**：D5① 为会话定义了费用字段后，`projects[]` 与 `unattributed` 按同一套单条记录估价求和，另加 `cost` 与覆盖度字段。“价格未知”的处理与 T10.151 的会话费用完全一致，未知不得记为 0。
- **`sessions[].project` 与 `projectReason`** 只在 `state ≠ disabled` 时出现。`project = null` 时必须带 `projectReason`。

### 5.3 不变量（契约测试）

1. `Σ projects[].tokens + (projectsRemainder?.tokens ?? 0) + unattributed.tokens = summary.tokens`；`requests` 同理。
2. `unattributed.tokens = Σ unattributed.reasons[].tokens`。
3. 同一会话在 `projects` 与 `sessions[].project` 中的键一致。
4. 带 `projects = [K]` 过滤时，`summary.tokens` 等于不带过滤时 `projects[K].tokens`（K 未被截断）。
5. 同一请求中，`state = disabled` 与任何项目字段不能同时出现。

### 5.4 修订“不推断项目”

- 旧（第 38 行）：会话 ID 仅是来源标识，不推断项目。
- 新：会话 ID 仅是来源标识，不从会话 ID、来源文件名或来源目录名推断项目。项目归属只来自用户显式开启“按项目统计”后，本机项目索引为该会话记录的工作目录末级名称（规则见 `docs/design/project-dimension-v1.md`）。未开启时响应只含 `meta.projectDimension.state = "disabled"`，不含任何项目字段。项目数据只在本机，不进入 Stats v2、云同步、Android、分享海报、HTML 简报和 CSV 导出。

### 5.5 不改的契约

| 契约 | 是否改动 | 说明 |
|---|---|---|
| `dashboard-stats-v2.md` | 不改 | 项目不进入跨端契约 |
| `session-analysis-v1.md` | 不改 | 逐轮分析的白名单保持不含 `cwd` |
| `quota-provider-v1.md` | 不改 | 第 171 行（envelope 不携带 cwd、transcript、来源路径等）继续有效 |
| Supabase 迁移 | 不新增 | — |

## 6. 界面落点

### 6.1 行为分析页（仅本机作用域）

1. **范围栏**：在工具筛选旁增加“项目”多选筛选，可搜索，包含“未归属”一项。只在 `ready` 或 `indexing` 状态出现；关闭时整个控件不渲染，不显示禁用态。
2. **项目排行卡**（新）：
   - 横向条，每行显示项目名、有效 Token、占比、会话数、主要工具图标，以及费用（D1 定名“预估费用”，D5① 就绪后）。
   - 固定分组用中性样式。“未归属”行永远排在最后，只要大于 0 就显示，悬停或聚焦时说明原因分布。
   - 占比的分母是 `summary.tokens`，包含未归属。
   - 点击某行即设置项目筛选。
   - 卡片脚注：“按文件夹名归并；一次会话只算入启动时所在的项目。”
3. **构成随时间变化**（审计 §5.2 第 4 项，信息架构以 T10.156 为准）：维度切换增加“项目”，显示前 8 个项目，其余合并为“其他”，再加“未归属”。
4. **会话表**：在“工具”后面增加“项目”列。未归属显示“—”，提示框写明原因；点击项目即筛选。
5. **结论条**：只在 `ready` 状态下，可以引用占比最高的项目，例如“TokenLedger 占 41%，另有 38% 来自不记录工作目录的工具”。未归属占比超过 20% 时，结论条必须同时说明未归属。

### 6.2 设置页

- 位置：「数据与帮助」（`settings-data`）新增卡片“按项目统计”，放在“数据库概览”之后、“数据操作与战报导出”之前。
- 目录搜索词：`items` 增加“按项目统计本机用量”，`keywords` 增加“项目”“工作目录”“隐私”（`src/utils/settingsNavigation.ts`）。
- 选择这个分区的理由：它是本机采集与存储的数据，关闭时需要清除，与导出、清理放在一起。「扫描与启动」只管频率与启动。
- 行为分析页关闭态的入口跳转到 `settings-data`，并定位到该卡片。

### 6.3 状态矩阵

| 状态 | 项目排行卡 | 范围栏筛选 | 会话表“项目”列 | 设置卡片 |
|---|---|---|---|---|
| 后端不支持（字段缺失） | 不渲染 | 不渲染 | 不渲染 | 不渲染 |
| 关闭（默认） | 占位卡：“按项目查看用量（默认关闭）。开启后只在这台电脑保存文件夹名，不上传。”按钮“了解并开启” | 不渲染 | 不渲染 | 开关关闭 |
| 授权版本过低 | 占位卡：“按项目统计的读取范围有更新，需要重新确认” | 不渲染 | 不渲染 | 重新确认卡 |
| 索引中 | 显示部分结果，并标注“正在建立项目索引 x / y，数字会继续变化” | 可用 | 未索引的会话显示“索引中” | 进度行 |
| 就绪 | 正常显示 | 可用 | 正常显示 | 已开启，显示项目数 |
| 就绪，但范围内全部未归属 | 说明“当前范围内的用量来自不记录工作目录的工具（Antigravity、Trae…）”，并列出原因分布 | 可用 | 全部“—” | 同上 |
| 就绪，范围内无数据 | 沿用行为分析页的空数据态 | 可用 | 空 | 同上 |
| 索引失败 | 显示原因码对应的文案，按钮“重试建立索引” | 可用（已有数据） | 已有数据 | 显示错误与重试 |
| 云端作用域 | 不渲染；能力说明横幅加一句“项目维度仅在本机视图可用” | 不渲染 | 不渲染 | — |

所有状态都要满足 GLB-03：键盘可达、44px 触控目标、读屏可读，数据条不单靠颜色表达，未归属行有文字标签。

### 6.4 供 T10.156 引用的术语与约束

T10.156 的 `docs/design/analytics-ia-v2.md` 与本文并行撰写，可直接引用下表术语。

| 术语（界面用语） | 定义 | 备注 |
|---|---|---|
| 项目维度（按项目统计） | 本机可选的分组维度，默认关闭 | 只出现在行为分析页的本机作用域 |
| 项目 | 会话启动目录所在仓库的主工作树目录名；非仓库时取启动目录名 | 同名合并 |
| 固定分组 | 主目录、磁盘根目录、临时目录、托管会话 | 不是具体项目，用中性样式 |
| 未归属 | 无法归到项目的用量，原因有四种：来源不支持、无法确定、索引中、缺少会话 ID | 大于 0 时必须显示 |
| 项目索引 | 开启后在后台建立的会话到项目的映射 | 状态：未开启、索引中、就绪 |
| 项目排行 | 新卡片，横向条 | 占比分母包含未归属 |
| 项目筛选 | 范围栏上的多选筛选 | 取值用响应里的 `key` |

给信息架构的约束：
- 项目维度不上总览、KPI、专属看板、分享或导出，也不进 Stats v2。
- “构成”维度切换只在 `ready` 或 `indexing` 状态出现“项目”选项。
- 结论条引用项目时必须同时说明未归属（超过 20% 时）。
- 项目名可能敏感，界面上不做默认展开的大字标题。

## 7. 测试

| 编号 | 层级 | 内容 |
|---|---|---|
| L1 | Rust 纯函数 | §2.4 全部分支：Windows、POSIX、UNC、MSYS、`\\?\` 前缀、尾部分隔符；主目录、盘符根、临时目录、应用数据；`-worktrees`、`.claude/worktrees`、`~/.codex/worktrees`；NFC/NFD、控制字符、双向字符、64 字截断、空名；键的大小写折叠与显示名选择 |
| L2 | Rust 文件系统 | 在临时目录里手工构造 `.git` 目录、`.git` 文件、`worktrees/<名>/commondir`、裸仓库、子模块、嵌套仓库、主目录 dotfiles 仓库和权限错误；不依赖 git 命令；验证 24 级上限，并验证只读取了 `.git` 与 `commondir` |
| S1–S15 | Rust 来源提取 | 每个“高”“中”档来源一组匿名 fixture，覆盖字段位置、缺字段、坏行、上限、Codex fork 重放的父级 `session_meta` 被忽略、OpenCode 以消息为准、MiniMax 默认工作区归“托管会话”、ReasoniX 兄弟推断与编码核对、Gemini 缺 `.project_root`、Kimi 的多级兜底、Hermes 两个库的区分 |
| P1 | Rust 隐私金丝雀 | 每个 fixture 的正文、标题、分支和远程地址里放入 `CANARY_*` 字符串，断言任何输出、错误和日志中都不出现；完整路径只允许作为函数输入，不得出现在任何返回值里 |
| O1 | Rust 授权门控 | 开关关闭时，扫描与增量流程不调用解析器，也不打开任何附加文件（用计数桩验证）；授权版本过低时视为关闭 |
| O2 | Rust 开启与关闭 | 开启后回填完成，行数与会话数一致；中途关闭时迟到的写入被代次条件丢弃；关闭后两张表为空，`secure_delete` 与 WAL 截断都已执行；重新开启从空开始 |
| D1 | Rust 去重不变 | 同一组 fixture 在开关开启与关闭时，写入的 `token_logs` 行数、`unique_key` 集合和各行数值完全一致；检查点与游标不变 |
| M1 | Rust 迁移 | 从 v12 升级只建空表、不回填；重复初始化幂等；孤儿回收 SQL 在清理旧数据和 Codex 重建交换之后生效 |
| C1 | Rust 契约 | §5.3 的五条不变量；关闭时不含项目字段；`projects` 过滤对所有维度一致生效；关闭时带过滤返回 `project_dimension_disabled`；截断与余量；与 v1.1 的 `missing_session` 口径一致 |
| G1 | Rust 同步守卫 | 在含 `CANARY_PROJECT_LABEL` 的库上生成同步载荷，断言键集合严格等于现有 13 个键（`user_id`、`tool`、`model`、`input_tokens`、`output_tokens`、`cached_tokens`、`cache_write_tokens`、`timestamp`、`session_id`、`unique_key`、`cost_usd`、`machine_id`、`requests`），且序列化结果里没有金丝雀。需要先把载荷构造抽成纯函数 |
| G2 | 静态 | `RAW_SYNC_LOGS_SQL` 与 `PENDING_SYNC_WORK_SQL` 不引用 `local_session_projects` 或 `project` |
| G3 | Rust | CSV 导出表头为固定列清单（T10.196 起 16 列），不含项目列，内容里没有金丝雀 |
| G4 | 前端 | 分享与 HTML 简报的构造函数只接收 `StatsData`；类型或静态断言禁止引入 `BehaviorAnalysis` 的项目字段 |
| G5 | 静态 | `project_index/**` 的 `log::*!` 宏只允许字面量或计数、原因码插值 |
| G6 | 既有 | `quota_claude_helper_persists_only_whitelisted_normalized_fields` 保持通过 |
| F1 | 前端 | §6.3 的每一种状态；筛选与点击行一致；未归属行与原因提示；提示框与表格列的读屏名称；reduced-motion；mock 只用虚构项目名 |
| F2 | 前端 | 设置卡片文案快照、确认框焦点与 Escape、关闭确认后的刷新、目录搜索能搜到“项目” |
| V1 | 真实账本（环境变量门控） | 在 Windows 真实账本上测回填耗时、各来源覆盖率和未归属占比，只记录计数与耗时；macOS 另测 `/Users` 主目录、`/private/var/folders` 临时目录、NFD 文件名和 Claude 桌面版路径 |

## 8. 风险

| 编号 | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 覆盖率低：本机 38.6% 的有效 Token 来自不提供目录的来源（Antigravity 32.5%、腾讯 Marvis 5.4%、未知键前缀 0.7%） | 排行像全量，误导判断 | 未归属是一等行，分母包含未归属；结论条在超过 20% 时必须说明；设置里写明已知限制 |
| R2 | 文件夹名本身敏感（客户名、代号） | 截图外泄 | 默认关闭；不进海报与导出；P2 提供“隐藏项目名”显示开关 |
| R3 | 同名合并 | 两个不同仓库被算成一个 | git 根与 worktree 归并先减少碰撞；写进说明；有反馈再按 §3.3 方案 C 增加选项 |
| R4 | 来源格式漂移 | 字段改名后解析失败 | 按来源设 `resolver_version`；失败时只记“无法确定”，不猜；实施前按工具版本复核公开文档 |
| R5 | 来源清理旧日志 | 历史会话无法确定项目（本机 Claude 1,100 个会话只有 778 个仍有日志，Codex 2,881 个中 2,857 个仍有 rollout） | 标为“无法确定”；说明这是来源的保留策略，不是 TokenLedger 丢数据 |
| R6 | git 探测命中网络盘或权限受限目录，导致卡顿 | 回填变慢 | 只探测本机固定卷；UNC、WSL 与网络盘不探测；每级只做一次 stat，最多 24 级；受总体可取消约束 |
| R7 | 回填与扫描并发写库 | `SQLITE_BUSY` | 使用同一个连接工厂（busy timeout 5 秒）；回填按 200 个会话分批提交；增量解析在扫描事务之外 |
| R8 | 主目录 dotfiles 仓库把所有会话都归到用户名 | 泄露用户名，归属也错 | 仓库根等于主目录时丢弃 git 结果；主目录本身归入固定分组 |
| R9 | 用户误以为关闭后全部路径信息都已清除 | 信任问题 | §3.9 如实说明检查点路径；“技术细节”折叠说明 |
| R10 | OpenCode 全局项目的 `session.directory` 与消息目录不一致（本机 146 个全局会话只有 9 个不同的 `session.directory`） | 归属错误 | 以首条助手消息 `path.cwd` 为准；实现前对照 OpenCode 源码确认字段语义，并在更多机器上复核 |
| R11 | 契约与 T10.151 交叉修改 | 冲突 | 本方案只提出 v1.x 追加，等 T10.151 合入后由 root 写入 |
| R12 | Windows 漫游配置同步 `%APPDATA%` | 本机数据库随漫游配置离开本机 | 这是既有风险，与项目维度无关，不在本任务处理，建议另行评估 |

## 9. 实施拆分

规模：S 不超过半天，M 为 1–2 天，L 为 3 天及以上（按单个实现代理计）。

| 编号 | 内容 | 规模 | 依赖 | 写入范围 |
|---|---|---|---|---|
| PD-0 | root 按任务日志的建议文字更新 REQUIREMENTS（GLB-11）、DESIGN §4.9、PROJECT ADR-016、README 扫描表，以及行为契约 v1.x | S | 本方案确认；T10.151 合入 | 单写文件（root） |
| PD-1 | `project_index/label.rs` 与 `git_probe.rs`，以及 L1、L2 | M | 无 | `src-tauri/src/project_index/**` |
| PD-2 | 迁移 vN 两张表、清除（`secure_delete` 加 WAL 截断）、孤儿回收挂点，以及 M1、O2 的存储部分 | S–M | root 分配迁移编号 | `db.rs`（迁移段）、`project_index/store.rs` |
| PD-3 | 来源提取第一批（文件头类）：Claude、Codex、Pi、Qclaw、DSH、WorkBuddy、Grok、Gemini、Kimi Code、Kimi Desktop、DeepSeek GUI、ReasoniX，以及对应的 S 与 P1 | L | PD-1 | `project_index/sources/**` |
| PD-4 | 来源提取第二批（SQLite 类）：OpenCode、Kilo、Zcode、MiniMax（v2 与旧库）、Hermes | M | PD-1 | 同上 |
| PD-5 | 编排：`set_project_dimension` 命令、`AppSettings` 字段与授权版本、回填线程与进度事件、扫描后增量挂点，以及 O1、O2、D1 | M | PD-2；PD-3 或 PD-4 至少一个来源 | `settings.rs`、`project_index/mod.rs`、`scanner/runner.rs`（仅挂点）、`lib.rs`（命令注册） |
| PD-6 | 行为契约 v1.x 聚合、`projects` 参数、C1，以及 TS 类型与 mock | M | T10.151 合入；PD-2 | `commands/mod.rs`（行为聚合）、`src/types.ts`（仅行为类型）、`src/devMockTauri.ts`（仅行为 mock） |
| PD-7 | 前端：设置卡片与两个确认框；行为页的项目排行、筛选、会话列与各状态，以及 F1、F2 | M–L | T10.150 合入；T10.156 定稿；PD-5、PD-6 | `src/components/settings/**`、行为分析组件、`settingsNavigation.ts` |
| PD-8 | 守卫：先把同步载荷构造抽成纯函数，再补 G1–G5 | S | PD-2 起即可 | `commands/mod.rs`（同步段，只抽函数不改行为）、测试 |
| PD-9 | 真实平台验收：Windows 真实账本 V1 以及 macOS 路径矩阵，证据只记计数与耗时 | S–M | 以上全部 | `docs/task-logs/**` |

推荐顺序：PD-1 → PD-2 → PD-4（SQLite 类最快见效）→ PD-3 → PD-5 → PD-8 → PD-6 → PD-7 → PD-9。PD-0 在方案确认后与实现并行。

## 10. 待决事项

| 编号 | 问题 | 推荐 |
|---|---|---|
| Q1 | 存储选末级目录名还是哈希（§3.3） | 选末级目录名（方案 A） |
| Q2 | 是否接受 git 探测，即读取 `.git` 的位置以及 `.git` 文件和 `commondir` 这两个小文件 | 接受；不接受时退回纯字符串规则，子目录和自定义 worktree 会被拆开 |
| Q3 | 设置入口放在「数据与帮助」还是「扫描与启动」 | 放在「数据与帮助」 |
| Q4 | Antigravity 未归属占比高 | 接受并显式展示；不做内容推断 |
| Q5 | “隐藏项目名”显示开关是否进入 v1 | 放在 P2，v1.x 跟进 |
| Q6 | 迁移编号与契约版本号 | 由 root 在 T10.151 合入后分配 |

## 附录 A：本机结构探针

- **时间与范围**：2026-09-24，本机 Windows，只读访问各来源的默认位置。结构探针每个来源抽 2–40 个样本；覆盖率与回填成本对全量文件或全量账本计数。账本与 OpenCode 这类 SQLite 库用只读连接打开。
- **探针清单**：
  1. 各来源的键名与值类别；
  2. 目录字段覆盖率与会话内一致性；
  3. 字段之间的相等或包含关系；
  4. OpenCode 路径格式类别；
  5. OpenCode 全局项目的目录是否存在、是否在 git 仓库内；
  6. §2.4 各规则的命中类别；
  7. 回填读取成本；
  8. 来源文件体积；
  9. 按来源族的有效 Token 占比；
  10. Claude、Codex 会话日志的留存比例。
- **输出限制**：
  - 只输出键名、值类别（`abs-windows-path`、`hex64`、`url`、`other-string`、`absent` 等）、目录名形态类别、布尔类别、计数、百分比、字节数和毫秒。
  - 键名如果像路径、ID 或超过 40 个字符，一律隐藏。
  - 比较路径只在内存中进行，结果只输出“相等 / 包含 / 不相关”这类类别。
  - 第 2 号探针发现 Kimi 工作区目录名会作为对象键混入输出，已在读取前脱敏替换，之后的探针一律隐藏以 `wd_` 开头的键。
  - 收尾时对落盘的 9 份输出文件检索系统用户名、盘符路径和用户目录片段，命中 0 条；来源体积与 Codex 留存两项只在终端打印计数，未落盘。
  - 没有任何值、提示词、路径或账户信息进入本文件或任务日志。
- **脚本位置**：只存放在会话临时目录，未入库。用到的操作只有 Node `fs`、`node:sqlite` 只读查询和 `zlib.zstdDecompressSync`。git 探测只检查 `.git` 是否存在，只读取 `.git` 文件与 `commondir`（各最多 4 KiB）。
- **未覆盖**：
  - macOS 与 Linux；
  - Multica Pi 会话（本机 0 个样本）；
  - Claude 桌面版的 macOS 路径；
  - 各工具的历史版本格式；
  - OpenCode 全局项目字段语义的源码核对。

## 用户决定（2026-09-24，root 逐条询问）

用户在 2026-09-24 夜间通过提问界面逐条作答，root 记录；与推荐不同的项以 ★ 标出。本节优先于上文的「待确认 / 待决」表述；正文与本节冲突之处，以本节为准，实现任务据此执行，SSOT 文字由 T10.174 统一写入。

- Q1 只存最后一级目录名，不存哈希（同推荐方案 A）。仓库自身的目录名即视为「最后一级目录名」。
- Q2 ★ 暂不做 git 探测，保持默认关闭（本方案推荐接受；T10.165 独立评审建议关闭，用户采纳评审意见）。代价：仓库子目录与自建 worktree 会被拆成不同项目。
- Q3 设置入口放在「数据与帮助」（同推荐）。
- Q4 Antigravity 认不出项目的会话照实显示为「未归属」，不做内容推断（同推荐）。
- Q5 ★ 「隐藏项目名」显示开关**进入首版**（本方案推荐放到 v1.x）。
- Q6 迁移编号与契约版本号由 root 分配；T10.165 使用本机 schema v13。
- 补充（T10.165 评审 Q7）：接受额外读取 Gemini `.project_root`（只读首行）、Kimi `workspaces.json`（只保留字符串根）与 DeepSeek `metadata.jsonl` 三个元数据文件，设置中如实列出读取的文件。
