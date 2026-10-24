# 外部网关 WebDAV 同步契约 v1

状态：本机实现（桌面端），待平台验收。拥有者：外部网关数据与 WebDAV 同步线程。

TokenLedger 读取外部网关（一款开源的本地 AI 网关）放在 WebDAV 上的同步文件，格式与外部网关完全一致，同一个同步密码两边都能打开。用来把外部网关的供应商（含 API key）带进 TokenLedger 网关。Supabase 仍是 TokenLedger 的主云通道，本契约不改变它。

## 1. 服务器布局

与外部网关的同步布局相同：

| 路径 | 内容 | v1 |
|---|---|---|
| `<地址>/<文件夹>/<备份文件>` | 整份设置的加密备份（备份格式） | 只读（不写回，§7） |
| `<地址>/<文件夹>/usage/<电脑ID>-<日期>.<用量扩展名>` | 各电脑共享的逐日用量（数据格式，内容为 gzip 后的 `SharedDay`） | 读用户勾选的电脑（§6） |
| `<地址>/<文件夹>/usage/<电脑ID>.<额度扩展名>` | 各电脑的额度历史（数据格式） | 不读 |

`<地址>` 去掉末尾的 `/`，按外部网关的 `dav.url` 拼接。读取时带 `Accept-Encoding: identity`，与外部网关相同。HTTP 404 视为“还没有同步文件”；401、403、429/503 分别提示账号密码错误、无权访问、服务器限流。地址里不得包含账号、查询参数或片段。http:// 地址只在本机、局域网私有地址或 `.local` 主机上发送账号密码，其余必须用 https://。下载按实际收到的字节计数，超过 32 MB 即中止（不依赖 Content-Length）。

## 2. 加密格式

文件是 JSON 信封，字节字段为标准 base64（与 Go `encoding/json` 编码 `[]byte` 相同）：

```json
{ "format": "<备份格式名>", "version": 1, "kdf": "pbkdf2-sha256", "iterations": 600000,
  "salt": "<16 字节>", "nonce": "<12 字节>", "data": "<密文+标签>" }
```

- 密钥：`PBKDF2-HMAC-SHA256(passphrase, salt, iterations, 32 字节)`。
- 加密：AES-256-GCM；附加认证数据为 `"{format}/{version}/{kdf}/{iterations}/{salt 的小写十六进制}"`，信封字段被改动会导致解密失败。
- 读取规则与外部网关的 `backup.Open` 一致：可带 UTF-8 BOM；`version ≠ 1` 或 `kdf` 不同视为更新版本的文件；`iterations` 不在 10 万到 1000 万之间、`nonce` 不是 12 字节或 `salt` 短于 16 字节视为损坏；以 `{"format":"<格式>"` 开头但解析不了视为被截断；其余非 JSON 内容视为“不是同步文件”（例如服务器返回的登录页）。
- 备份格式用缩进 JSON 写，数据格式用紧凑 JSON 写。
- 文件夹名、备份文件名、两个格式名和本机接口路径必须与外部网关逐字一致，只在 `src-tauri/src/peer_wire.rs` 里拼出，文档与注释中不写明文。测试样本中的格式名写成占位符 `@FORMAT@`，测试时再替换。
- 兼容性测试用 Go 标准库按外部网关的写法生成真实样本（`fixtures/peer/`，生成程序为 `generate.go.txt`）。

## 3. 备份内容中读取的部分

明文是外部网关的 `Bundle`。v1 只读 `version`、`created`、`app`、`keys`、`providersKeys` 和 `providers[]`。

- 是否带 key：`providersKeys`（bundle v2 按部分记）存在时以它为准，否则用整体的 `keys`。
- 每个供应商读 `id`、`name`、`key`、`keys[]`（`key`、`off`）、`chat`、`responses`、`anthropic`、`gemini`、`decide`、`baseAPI`、`models`、`off`，其余字段忽略。
- 设置、档案、Agent、资料库、网关 key、插件等其他部分 v1 不读取。

## 4. 映射到 TokenLedger 供应商

| TokenLedger 字段 | 取值 |
|---|---|
| `id` | 外部网关的 `id` 转小写，非 `[a-z0-9]` 字符换成 `-`，合并连续的 `-`，截到 32 位；为空时用 `peer-provider`，为 `group` 时用 `peer-group`；同一备份内重复时追加 `-2`、`-3`… |
| `name` | `name` 截到 64 个字符，为空时用 `id` |
| `wire` / `baseUrl` | `baseAPI` 是 `chat`、`responses`、`anthropic` 之一且对应地址非空时用它；否则依次取第一个非空的 `chat`、`responses`、`anthropic`。外部网关的 chat/responses 地址以 `/v1` 结尾，anthropic 地址是根路径，与 TokenLedger 网关的约定相同 |
| `models` | `models` 去空白、去重，剔除含空白或超过 128 字符的项，最多 512 个 |
| `enabled` | `!off` |
| `authMode` | `key` |
| API key | `key`；为空时取 `keys[]` 中第一个未停用的 `key`。只有备份带 key 时才写入 |

无法导入、在预览中说明原因的情况：只有 `gemini`（TokenLedger 网关暂不支持 Gemini 原生接口），只有 `decide`（决策接口），没有任何接口地址（多为订阅登录），以及地址不符合 TokenLedger 供应商校验。

## 5. 流程与安全

1. 用户在设置页填写 WebDAV 地址、用户名、WebDAV 密码与外部网关同步密码。地址与用户名存 `app_data/peer-sync-v1.json`；两个密码只存系统钥匙串（服务 `com.jeidorf.tokenledger.gateway`，条目 `peer-sync:webdav-password`、`peer-sync:passphrase`）。页面只能看到“已保存”与否。
2. 「读取外部网关备份」：下载、解密，返回每个供应商的映射预览（`id`、名称、协议、地址、模型数、是否带 key、是否会覆盖同 ID 的现有供应商、不支持的原因），**不含任何 key**。
3. 「导入选中的供应商」：重新下载解密，对选中的供应商 upsert 到网关供应商列表，key 直接写入网关的钥匙串条目 `provider:<id>`。备份不带 key 时保留 TokenLedger 已有的 key；但若导入把已有供应商的地址换到另一个协议、主机或端口（按 scheme、小写主机名与端口比较），旧 key 一并清除，结果里的 `keysCleared` 计数，设置页提示用户重新填写。某个 key 写入钥匙串失败时，该供应商恢复为导入前的样子（新建的则移除），并报告错误。
4. 解密后的明文只在内存中处理。key、密码、同步密码不落盘、不写日志、不进缓存、不上传 Supabase、不写进仓库。
5. 订阅登录（Claude、Codex 等账号）不在外部网关备份中，也不读取外部网关本机的 `logins.json`、`sync.json` 或任何代理凭据（ADR-004/017）。
6. 只读：不改动服务器上的任何文件。
7. WebDAV 请求不跟随重定向：服务器返回 3xx 时按 HTTP 错误报告，用户需填写最终地址。

## 6. 共享用量

外部网关在每台电脑上把当天的调用写成 `usage/<电脑ID>-<YYYY-MM-DD>.<用量扩展名>`，服务器上保留最近 90 天。电脑 ID 是十六进制串。

- 列出：对 `usage/` 发 `PROPFIND`（`Depth: 1`），只认直接子文件；href 可以是完整 URL 或路径，按百分号编码解码。404/409/410 视为“还没有共享用量”。文件名不符合 `<十六进制ID>-<日期><扩展名>` 的、早于 90 天的、晚于本机今天 +1 天的一律跳过；同一台电脑同一天只取一个文件。
- 本机排除：外部网关在本机配置目录里的电脑 ID 文件（`{"id": …}`）指明本机自己的那份，它已由本机用量导入覆盖，不再读取。
- 设备归属：默认一台都不统计。用户在设置页按电脑勾选，勾选结果（只有电脑 ID）存在 `peer-sync-v1.json` 的 `sharedComputers`。若那台电脑也运行 TokenLedger，它的调用已由那台电脑自己上报，界面要求只勾选没有安装 TokenLedger 的电脑。
- 解密：每个文件用数据格式与同一同步密码打开，同一 salt 的密钥只派生一次；解开后 gunzip（解压后上限 256 MB，单个文件下载上限 64 MB），解析 `SharedDay{computer, name, calls[]}`。`computer` 与文件名不一致视为损坏。`name` 是那台电脑的主机名，只用于界面显示。
- 每条调用的计入规则与本机用量导入相同：时间无法解析、被拒绝（`rejected`，或无供应商且状态 ≥ 400）、四类 token 全为 0 或有负数的不计；身份键是时间、`route_id`、`rid`、agent、供应商、模型与四类 token 的 FNV-1a。只保留计数字段（时间、agent、供应商、模型、四类 token、耗时、会话）。
- 本机保存：`imports/peer-shared-v1.jsonl`（每次同步整体替换）与 `imports/peer-shared-v1.json`（同步时间与每台电脑的天数、调用数）。删除或停止统计时两者一并删除。
- 统计：这些行以 `source = shared-peer` 加入统计视图，机器 ID 为 `peer:<电脑ID>`。它们是另一台电脑的调用，不参与本机扫描记录的去重（规则 A、B 都跳过），也绝不上传 Supabase。
- 命令（仅主窗口）：`peer_sync_shared_list`、`peer_sync_shared_pull(ids)`、`peer_sync_shared_clear`。

## 7. 后续（未实现）

- 写回供应商：用户 2026-10-23 决定不做。
- 额度历史：`usage/<电脑ID>.<额度扩展名>` 暂不读取。

## 8. 变更记录

- 2026-10-23：v1，只读备份并导入供应商。
- 2026-10-23：http 明文地址限制、流式限长、key 写入失败回滚（#14 评审建议）。
- 2026-10-23：共享用量（§6），按电脑勾选，默认不统计，不上传云端。
- 2026-10-24：导入换主机时清除旧 key（§5.3）、不跟随重定向（§5.7）、共享用量跳过未来日期并按天去重（§6）。
