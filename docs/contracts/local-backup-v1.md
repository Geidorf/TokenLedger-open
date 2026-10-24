# 本机备份与迁移契约 v1

状态：本机实现（桌面端），待平台验收。拥有者：本机数据备份与迁移线程。

把一台电脑上记下的用量与设好的东西导出成一个加密文件，在另一台电脑（或重装后的同一台）上预览、去重合并恢复；可选定期自动备份到本地文件夹；数据库损坏时自检与修复。Supabase 云同步与外部网关 WebDAV 同步（`peer-sync-v1`）不受影响，本契约不改变它们。代码在 `src-tauri/src/local_backup/`。

## 1. 文件

- 扩展名 `.tlbackup`。手动导出命名 `TokenLedger-<本地时间 YYYYMMDD-HHMMSS>.tlbackup`，自动备份命名 `TokenLedger-auto-<同上>.tlbackup`；重名时追加 `-2`、`-3`。
- 写入先写同目录临时文件再改名；Unix 上权限 0600。
- 单个文件读取上限 1 GiB，解压后明文上限 1 GiB（流式解压时就截断，不先整个解开），超出即拒绝。

## 2. 加密

信封与 `peer-sync-v1` §2 完全相同（PBKDF2-HMAC-SHA256 + AES-256-GCM，信封字段作附加认证数据，`version = 1`、`kdf = "pbkdf2-sha256"`，`iterations` 在 10 万到 200 万之间），只是 `format` 为 `tokenledger-backup`，两边的文件互不认作对方的。

- 本版本写入 60 万轮；紧凑 JSON 信封。
- `data` 解密后是 zstd 压缩的 UTF-8 JSON（§3）。
- 备份密码由用户输入，至少 8 个字符、至多 1024 字节、不含 NUL。手动导出与恢复的密码不保存；自动备份的密码只存系统钥匙串（账户 `local-backup:passphrase`），页面只看到“已保存”与否。
- 密码不对或信封被改动报“备份密码不对，或文件已被改动”；不是本格式的文件（含外部网关的备份、CSV）报“不是 TokenLedger 备份”。

## 3. 明文结构

```json
{ "kind": "tokenledger-backup-bundle", "schema": 1, "created": "<UTC RFC 3339>",
  "appVersion": "2.0.0", "machine": "<本机 machine_id>",
  "ledger": { "columns": ["tool", "model", "…"], "rows": [["claude", "…"]] },
  "gatewayRequests": [<网关 LedgerRecord>],
  "settings": <AppSettings>, "budgets": <BudgetSettings>,
  "providers": [<ProviderRecord>], "routingGroups": [<RoutingGroup>],
  "prices": <价格编辑器看到的生效价格表>, "quotaAlerts": <QuotaAlertSettings> }
```

- `kind` 不符视为无法识别；`schema` 大于本版本支持的值视为“更新版本生成”，要求先升级。缺少的字段按空处理，旧版本备份可以少字段。
- `ledger` 是 `token_logs` 除 `id` 外的全部列，按 `id` 顺序；列随行一起走，所以新版本多出的列旧版本恢复时直接丢弃，旧备份缺的列用本机默认值。BLOB 列不携带。
- `gatewayRequests` 是网关记账库（`usage-accounting-v1.sqlite3`）的全部计费行，含 Context 构成；诊断用的轮转 JSONL 不带。
- 不进备份：任何密钥（供应商 API key、网关本地令牌、云端登录、WebDAV 与同步密码、额度端点 key）；可重建的缓存（统计缓存、项目索引、价格目录缓存）；扫描游标与检查点；云同步状态文件；外部来源导入的原始文件；额度最近一次读数。

## 4. 预览与恢复

恢复固定两步：先预览，再按用户勾选的部分恢复。预览返回读到的密文 SHA-256，恢复时交回；文件在两次读取之间被换掉则拒绝恢复。

| 部分 | 去重 / 合并规则 |
|---|---|
| 用量账本 | 按扫描器的去重键 `unique_key`：`INSERT OR IGNORE`，本机已有的行一律保留，即使数值不同。保留备份里的 `machine_id`、`sync_status`、`cloud_user_id`、`synced_at`，同一云账号下已上传过的行不会重传。 |
| 网关请求记账 | 按记账标识（与网关实时追加的去重身份相同）；本机已有的保留。本版本不计数的行（全零 Token、身份超长）跳过。 |
| 供应商 | 按 id。本机没有的新增；同 id 内容不同时按冲突选项。用备份覆盖且接口地址换了主机时，清掉本机原 key（与 `peer-sync-v1` 相同理由）。恢复后本机没有 key 的供应商列出来让用户补填。 |
| 路由组 | 按 id，先恢复供应商再恢复路由组；组成员引用其他组时多轮重试，网关拒绝的组列出原因，不影响其他组。 |
| 预算 | 按规则 id 合并；通知开关在“保留本机”时取两边的或。 |
| 设置 | 整份恢复，但属于这台电脑的保持本机的值：自启动、系统壁纸写入及其授权、各额度本机读取授权、云端额度同步开关、模型接入总开关、挂件在屏幕上的位置、迁移标记。订阅设置的版本号在本机基础上加一。额度端点只有 id 与地址都和本机相同才保留“已配置 key”标记。部分设置重新打开应用后才完全生效。 |
| 价格表 | 与本机生效价格表不同才写，经价格编辑器同一条保存路径（会按需重算费用）。 |
| 额度提醒 | 整份恢复。 |

冲突选项 `keepLocal`（默认）或 `useBackup`，只作用于供应商、路由组、预算；账本行永远本机优先。

恢复前先把本机当前数据存到 `<应用数据目录>/backups/pre-restore-<时间>/`：账本库与网关记账库用 `VACUUM INTO` 拷贝，加上设置、预算、额度提醒、价格覆盖及其状态、供应商、路由组文件；只保留最近 3 份。恢复后清空本机统计缓存并通知界面刷新。

## 5. 自动备份

- 设置存 `<应用数据目录>/local-backup-v1.json`：`enabled`（默认关）、`dir`（绝对路径，默认“文稿/TokenLedger Backups”）、`intervalHours`（24、72、168 之一）、`keep`（1–60，默认 7）、上次运行时间、文件与错误。
- 开启前必须已有自动备份密码。后台调度每 10 分钟检查一次是否到期；上次失败时 1 小时后重试，不等满一个周期（例如文件夹在未插上的移动硬盘里）。
- 只清理本计划写的 `TokenLedger-auto-*.tlbackup`，按文件名中的时间保留最新的 `keep` 份；手动导出的文件从不删除。

## 6. 数据库自检与修复

- 自检：对账本库与网关记账库各跑 `PRAGMA integrity_check(20)`（只读连接），报告问题原文、文件与 WAL 大小、账本行数。
- 修复第一步：对受损的库执行 `REINDEX`，再检查；只有索引损坏时到此修好，无需重启。
- 仍有损坏时安排重建：写 `db-repair-pending-v1.json`，请用户退出并重新打开应用（不自动重启，以免与单实例检查竞争）。下次启动时、调度器和任何窗口打开账本之前（只在主实例里），把还能读出的行逐段搬进新建的库：`token_logs`、`pending_cloud_purges`、`discovered_models`、`scan_cloud_sent_identities`、`scan_cloud_dirty_buckets`；读不出的范围退回逐行读，跳过读不出的行。原文件连同 WAL/SHM 改名为 `tokenboard.db.damaged-<时间>` 保留。
- 扫描游标、检查点等不搬：重建后扫描从头读各工具日志，坏页上丢失的行能从日志补回，并按 `unique_key` 去重。
- 启动时账本库打开即报“损坏”或“不是数据库”时，不再直接报致命错误，而是自动按上面的方式重建后再打开；其他错误（如被占用）仍按原样报错。
- 每次重建把时间、是否自动、找回行数、读不出的行数、原文件位置写入 `db-repair-v1.json`，设置页显示。
- 网关记账库 v1 只做自检与 `REINDEX`，不做重建。

## 7. 命令

都只允许主窗口调用（`capabilities/main-app.json`）：`local_backup_status`、`local_backup_export`、`local_backup_list`、`local_backup_preview`、`local_backup_apply`、`local_backup_save_auto`、`local_backup_run_auto_now`、`local_backup_db_check`、`local_backup_db_repair`、`local_backup_quit`。导出、恢复、自动备份与修复互斥执行。

## 8. 验收

- 云端：Rust 单测（往返、去重、冲突、设备项保留、密码与格式错误、更新版本拒绝、自动备份与清理、坏页重建、打不开的库启动重建）、组件测试、桌面 E2E（`e2e/local-backup.spec.ts`）。
- 待平台验收：Windows 与 macOS 上真实数据的导出→另一台电脑恢复、钥匙串存取自动备份密码、退出重开后的重建流程。
