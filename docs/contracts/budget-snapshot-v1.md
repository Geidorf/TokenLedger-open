# 预算状态云端中转契约 v1

状态：实施中（2026-10-24 起）。拥有者：预算与超支提醒线程（claude@r8）。评审：B 级。

桌面端把各预算当前的已用比例压成一份很小的快照，经 Supabase 中转给 Android；手机读到「接近」或「超出」时推本地通知。预算规则、金额与上限只在桌面本机（`docs/design/budget-alerts-v1.md`），手机不计算预算，也不能改预算。

## 1. 不做的事

- **不传金额**：快照里没有已用金额、上限、规则 ID、范围原始 ID（模型名或网关账号名原样）、设备名、路径或账号信息。范围只以桌面通知用的安全名称出现（§3），百分比取整。
- **不外推**：百分比是桌面按已经发生的用量算出的，手机原样显示，不预测。
- **不长期保存**：每台设备只保留最新一份快照，新快照整份覆盖旧快照；超过 3 天没有更新的行由每小时一次的定时清理删除（任何人发布时也会顺带删除本人的旧行）；桌面关闭「同步到手机」时立即删除本机那一行。
- **不改 Stats 口径**：快照与 `token_logs`、额度快照、路由快照无关，不参与任何统计。

## 2. 传输

| 项 | 取值 |
| --- | --- |
| 表 | `private.budget_snapshots`，主键 `(user_id, device)`，不在暴露的 schema 中，客户端没有任何表权限，只能经下面三个 RPC 访问 |
| 写 | `public.publish_budget_snapshot_v1(p_device text, p_snapshot jsonb) → jsonb` |
| 读 | `public.get_budget_snapshots_v1() → jsonb` |
| 删 | `public.clear_budget_snapshot_v1(p_device text) → jsonb` |
| 身份 | 三个 RPC 都是 `security definer`，只认 `auth.uid()`；匿名调用报 `budget_snapshot_identity_required`（42501） |
| 迁移 | `supabase/migrations/20261024050000_budget_snapshot_sync.sql`，回归 `supabase/tests/budget_snapshot_regression.sql` |

### 2.1 发布

- `p_device`：16～64 位小写十六进制，由桌面端按 §3.1 生成，不含主机名。
- 拒绝（errcode 22023，消息 `budget_snapshot_<原因>`）：
  - `invalid_payload`：不符合 §3 的结构或取值；`generatedAt` 比服务器时钟快 5 分钟以上；`p_device` 格式不对。
  - `payload_too_large`：`p_snapshot::text` 超过 8192 字节。标签按字符限长，32 条四字节字符的标签可能超限，桌面端发布前按服务器的量法裁掉排在最后的预算，保证不触发。
  - `capacity_exceeded`：该用户已有 8 台设备的快照（先删除超过 3 天的旧行再计数），且这次是新设备。
- 同一设备的旧快照（`generatedAt` 早于已存快照）不覆盖新快照，返回 `{"stored": false}`；否则返回 `{"stored": true, "receivedAt": "<服务器时间>"}`。

### 2.2 读取

返回 `{"serverTime": "<服务器时间>", "snapshots": [ … ]}`，按 `receivedAt` 新在前，只含 2 天内收到的行，最多 8 条。每条：

```json
{ "device": "<p_device>", "receivedAt": "<服务器收到时间>", "snapshot": { …§3 原样… } }
```

### 2.3 删除

删除当前用户该设备的那一行，返回 `{"deleted": true|false}`。设备格式不对时报 `invalid_payload`。

## 3. 快照格式

```json
{
  "v": 1,
  "generatedAt": "2026-10-24T07:00:00.000Z",
  "budgets": [
    { "id": "9f2c4e1a7b3d5f60", "label": "Codex", "period": "month", "metric": "cost", "periodStart": "2026-10-01", "percent": 85, "level": "warn" },
    { "id": "0123456789abcdef", "label": "全部用量", "period": "day", "metric": "tokens", "periodStart": "2026-10-24", "percent": 112, "level": "over" }
  ]
}
```

| 字段 | 规则 |
| --- | --- |
| `v` | 固定 `1`。字段含义变化时升 v2 并新增 RPC，不改 v1 |
| `generatedAt` | 桌面生成快照的时间（RFC 3339，UTC） |
| `budgets[]` | 0～32 项，先超出、再接近、再按百分比从高到低；只放启用且读数可得的预算（读数不可得的预算不放，不当成 0%）；空数组表示没有可同步的预算 |
| `budgets[].id` | 16 位小写十六进制（§3.2），同一快照内不重复 |
| `budgets[].label` | 1～32 个字符，不含控制字符与 `/ \ @ : $ ¥ € £ ~`；与桌面系统通知同一名称：Agent 显示名、模型名、账号名，不安全时退回「Agent」「模型」「账号」，全部用量为「全部用量」 |
| `budgets[].period` | `day` 今日 · `week` 本周（周一起） · `month` 本月，桌面本地日历 |
| `budgets[].metric` | `cost` 预估费用 · `tokens` 有效 Token |
| `budgets[].periodStart` | 周期第一天，`YYYY-MM-DD`，桌面本地日期 |
| `budgets[].percent` | 已用比例向下取整，0～99999 的整数 |
| `budgets[].level` | `ok`、`warn`（到达接近比例）、`over`（到达上限） |

服务器只校验结构、取值集合与长度；未列出的键一律拒绝。

### 3.1 设备标识

`device = hex(SHA-256("tokenledger-budget-device-v1\n" + user_id + "\n" + 本机标识))` 的前 32 位。与路由快照的设备标识用不同前缀，两边不能互相关联。

### 3.2 预算标识

`id = hex(SHA-256("tokenledger-budget-rule-v1\n" + device + "\n" + 规则 ID + "\n" + 规则定义))` 的前 16 位。规则定义是周期、口径、范围类型、范围 ID 与上限；改了其中任何一项都得到新 `id`，与桌面「改了就是新预算、重新计数」一致。

## 4. 发布节奏（桌面端）

- 只在用户于「设置 › 预算提醒」打开「同步到手机」并已登录云同步时发布；默认关闭。关闭时调用 `clear_budget_snapshot_v1` 删除本机那一行。
- 每次预算检查（扫描写入、手动刷新、跨日、保存设置，以及有预算时每 5 分钟）后发布；内容（去掉 `generatedAt` 后）没变就不发，但至少每 30 分钟发一次心跳。
- 失败按 1、2、4……分钟退避到最长 30 分钟，成功后复位；云端未部署时每 30 分钟再试。退避期间预算检查不会提前唤醒重试，只有开关被拨动才会。

## 5. 读取与通知（Android）

- 后台定时读取（随系统调度，约每 30 分钟；打开应用时也读一次）。只在用户打开「预算提醒通知」并已登录时读。
- 只处理 `serverTime − receivedAt` 不超过 12 小时的快照；更旧的不推通知（桌面可能已离线，周期也可能已过）。
- 去重键 `device + id + periodStart + level`：每条预算每个周期「接近」与「超出」各推一次；直接看到 `over` 时只推超出并把接近记为已推。第一次打开开关时，把当时已经是接近或超出的预算只记为已推、不补发，避免一次推出一串旧提醒。
- 一次读取最多推 3 条，先超出、再按百分比从高到低；其余记为未推，下次读取再推。
- 通知文案与桌面一致：标题「Codex 预算已用 85%」或「Codex 已超出预算」，正文「本月费用预算已用 85%」，不写金额。

## 6. 变更记录

- 2026-10-24：v1。
