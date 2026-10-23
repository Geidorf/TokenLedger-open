# magpie 用量导入契约 v1

状态：本机实现（桌面端），待平台验收。拥有者：magpie 数据与 WebDAV 同步线程。

本契约规定 TokenLedger 如何读取 [magpie](https://github.com/yetone/magpie)（开源本地 AI 网关，MIT）在本机记下的逐次调用用量，并入本机统计与云端小时聚合。它沿用 `dashboard-stats-v2` §2.5 的网关记录映射与去重规则，只补充导入来源特有的部分；有效 Token、缓存读写与成本口径不变。

## 1. 读取范围

- 位置：magpie 配置目录下的 `usage.jsonl`。配置目录为 `$XDG_CONFIG_HOME/magpie`（仅当该变量是绝对路径），否则在所有平台上都是 `~/.config/magpie`，与 magpie 的 `appdir.Config` 一致。便携版 magpie 的目录不在此处，暂不支持。
- 只读：不写、不移动、不加锁 magpie 的任何文件。
- 不打开 magpie 的其他文件：`providers.json`、`logins.json`、`settings.json`、`sync.json`、备份与同步缓存都不在导入范围内。订阅登录与凭据共享仍按 ADR-004 排除。
- 触发：用户在设置页「数据与帮助 → 从 magpie 导入」点击「一键导入」或「重新导入」。不在后台自动读取。

## 2. 行的取舍

`usage.jsonl` 每行是 magpie 的一条 `usage.Record`。逐行解析，单行最长 256 KiB：

| 情况 | 处理 |
|---|---|
| 不是 JSON、`t` 不是 RFC 3339、任一 Token 为负 | 跳过，计入 `invalid` |
| `computer` 非空（magpie 同步带来的其他电脑的调用） | 跳过，计入 `otherComputer`；由那台电脑自己的 TokenLedger 统计 |
| `rejected = true`，或 `provider` 为空且 `status ≥ 400`（magpie 的 `IsRejected`） | 跳过，计入 `rejected` |
| `in + out + cache_read + cache_write = 0` | 跳过，计入 `zeroTokens`（与 §2.5「计入条件」一致） |
| 与已读行身份相同 | 跳过，计入 `repeated` |
| 其余 | 导入 |

`source = "reported"` 的行（应用自报、未经 magpie 网关的调用）照常导入，靠下文去重避免与本机日志重复。

## 3. 保存的字段

导入结果保存在应用数据目录 `imports/magpie-usage-v1.jsonl`，每行一个调用，只含：

| 字段 | 来源 |
|---|---|
| `key` | 身份：对 `t`（UTC 规范化）、`route_id`、`rid`、`agent`、`provider`、模型与四个 Token 数做 FNV-1a 64 位哈希。`rid` 只参与哈希，不保存 |
| `t` | `t`，规范为 UTC RFC 3339 |
| `agent`、`provider` | 原样（去首尾空白） |
| `model` | `model`；为空时取 `served`；再为空时取 `req` 去掉首个 `前缀/` |
| `in`、`out`、`cache_read`、`cache_write` | 原样。magpie 的 `in` 已不含缓存读写，与网关记录口径相同 |
| `ms` | `ms`（负数按 0） |
| `session` | `session`，为空时不写 |

主机、key 名与指纹、订阅账号、调用方 key、错误信息、请求与响应 ID、端点和内容一律不保存。再次导入整体替换此文件；「移除导入」删除此文件与 `imports/magpie-import-v1.json`（上次导入的统计摘要）。

## 4. 并入统计

每个导入调用按 §2.5「维度映射」转成一行，差异如下：

- `tool`：`agent` 转小写后按 §2.5 映射（magpie 的 Claude Code 记为 `claude`）；`agent` 为空时为 `magpie`。
- `session_id`：`session`；为空时为合成值 `magpie:<key>`，不参与规则 A。
- 时间区间：`[t − ms, t]`，窗口 `W = 5 秒`，与网关记录相同。
- 行 ID：对 `magpie:<key>` 做与网关行相同的负数 FNV-1a，不与扫描行或网关行冲突。
- 明细 `source = "imported-magpie"`，另带 `provider`；`usageProvenance = reported`。读者对未知 `source` 按未知来源显示（§2.5），旧版本不会丢行。

去重顺序：

1. **与 TokenLedger 网关重复**：同一请求同时经过 TokenLedger 网关与 magpie 时，以 TokenLedger 网关记录为准。把导入行当作“扫描行”，用 §2.5 规则 A、B 与网关行比较，被取代的导入行不计入。
2. **与本机日志重复**：剩余导入行与网关行一起按规则 A、B 取代扫描行。
3. **不按猜测合并**：规则 B 下，若一条导入行在窗口内有两条及以上同指纹、未被取代的扫描行，该导入行**暂不计入**（`held`），这些扫描行保留。指纹相同，因此合计不变，只是不把导入行的供应商归属强加到某一条日志上。网关行仍按 §2.5 取距离最小者。

规则只在本机执行，结果是派生的：扫描入库的原始行不改不删；导入文件或扫描数据变化后整体重算。导入文件存在但无法解析时统计明确失败（提示重新导入），不静默退回纯扫描口径。

## 5. 云端

导入行与网关行一样参与 §2.5「云端合并上传」：受影响小时在桌面合并去重后按同一 `unique_key` 格式上传小时聚合，`gateway_requests` 计入导入行条数。云端只收到小时聚合，不收到会话 ID、`key`、`provider` 或任何 magpie 字段，Supabase 表与 RPC 不变。

- **撤回**：上次按合并口径上传过的小时（记在云同步状态里）每次同步都重新计算，即使其中的导入行已不存在（移除导入、重新导入后变少、或改为 `held`）。重算后不再含网关或导入行、也没有被取代扫描行的小时，按纯扫描口径重传、删除多余的旧键，并从状态中移除，交回普通扫描聚合；一条行都不剩的小时只删旧键。这样云端不会留下永久多算的小时。
- **状态位置**：没有 TokenLedger 网关账本时，云同步状态写在 `imports/cloud-sync-v1.json`，不写进 `gateway/`：网关目录里的状态文件是 §2.5 判定「旧网关历史可能不完整」的证据，只因导入就写入会让此前所有小时被误判为待核对。之后启用网关时改写回 `gateway/cloud-sync-v1.json`，读取时先网关路径、后导入路径。

## 6. 导入报告

`magpie_import_run` 返回并保存：

```json
{
  "importedAt": "2026-10-20T08:00:00Z",
  "counts": { "lines": 1280, "imported": 1204, "invalid": 0, "zeroTokens": 70, "rejected": 6, "otherComputer": 0, "repeated": 0 },
  "earliest": "2026-08-01T02:10:00+00:00",
  "latest": "2026-10-20T07:58:00+00:00",
  "duplicateOfGateway": 0,
  "matchedScans": 812,
  "held": 3
}
```

`matchedScans` 与 `held` 只计导入行对扫描行的作用，是导入当时的快照。`magpie_import_status` 只报告 magpie 目录与 `usage.jsonl` 是否存在、大小与修改时间，以及上次导入的报告。

## 7. 变更记录

- 2026-10-23：v1。`dashboard-stats-v2` §2.5 的 `source` 取值由其拥有者补登（PR #10）。
- 2026-10-23：评审修正，补充 §5 撤回与状态位置。
