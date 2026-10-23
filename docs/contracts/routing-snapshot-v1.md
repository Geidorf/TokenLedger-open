# 实时路由快照云端中转契约 v1

状态：实施中（2026-10-24 起）。拥有者：Android 锁屏动态壁纸线程（claude@77）。评审：B 级。

桌面端把网关路由的实时场景（`docs/design/routing-animation-v1.md` 的场景结构）压成一份很小的快照，经 Supabase 中转给 Android 动态壁纸。延迟按「秒到分钟」设计，不追求逐帧同步：壁纸收到新记录后在本地按设计文档的时序播放。

## 1. 不做的事

- **不造假**：快照里每一条流都对应桌面上一条真实记录。没有快照、快照过期或桌面关闭发布时，壁纸显示空态并说明原因，不播放示意动画。
- **不传敏感内容**：不含会话 ID、请求或回复内容、错误正文、决策说明、账号名、邮箱、密钥、Token 数、主机名、本机路径或端口。请求 ID 只以加盐哈希出现（§3.2）。
- **不长期保存**：每台设备只保留最新一份快照，新快照整份覆盖旧快照；超过 1 天没有更新的行在任一次发布时删除；桌面关闭发布时立即删除本机那一行。
- **不改 Stats 口径**：快照与 `token_logs`、额度快照无关，不参与任何统计。

## 2. 传输

| 项 | 取值 |
| --- | --- |
| 表 | `private.routing_snapshots`，主键 `(user_id, device)`，不在暴露的 schema 中，客户端没有任何表权限，只能经下面三个 RPC 访问 |
| 写 | `public.publish_routing_snapshot_v1(p_device text, p_snapshot jsonb) → jsonb` |
| 读 | `public.get_routing_snapshots_v1() → jsonb` |
| 删 | `public.clear_routing_snapshot_v1(p_device text) → jsonb` |
| 身份 | 三个 RPC 都是 `security definer`，只认 `auth.uid()`；匿名调用报 `routing_snapshot_identity_required`（42501） |

### 2.1 发布

- `p_device`：16～64 位小写十六进制，由桌面端按 §3.1 生成，不含主机名。
- 拒绝（errcode 22023，消息 `routing_snapshot_<原因>`）：
  - `invalid_payload`：不符合 §3 的结构或长度限制；`generatedAt` 比服务器时钟快 5 分钟以上；`p_device` 格式不对。
  - `payload_too_large`：`p_snapshot::text` 超过 16384 字节。
  - `capacity_exceeded`：该用户已有 8 台设备的快照（先删除超过 1 天的旧行再计数），且这次是新设备。
- 同一设备的旧快照（`generatedAt` 早于已存快照）不覆盖新快照，返回 `{"stored": false}`；否则返回 `{"stored": true, "receivedAt": "<服务器时间>"}`。

### 2.2 读取

返回 `{"serverTime": "<服务器时间>", "snapshots": [ … ]}`，按 `receivedAt` 新在前，只含 15 分钟内收到的行，最多 8 条。每条：

```json
{ "device": "<p_device>", "receivedAt": "<服务器收到时间>", "snapshot": { …§3 原样… } }
```

客户端用 `serverTime − receivedAt` 判断快照新鲜度，不依赖手机与桌面的时钟一致。

### 2.3 删除

删除当前用户该设备的那一行，返回 `{"deleted": true|false}`。设备格式不对时报 `invalid_payload`。

## 3. 快照格式

```json
{
  "v": 1,
  "generatedAt": "2026-10-24T07:00:00.000Z",
  "sources": [ { "id": "tokenledger", "reachable": true }, { "id": "external", "reachable": false, "note": "外部网关未运行" } ],
  "flows": [
    {
      "id": "9f2c4e1a7b3d5f60",
      "source": "tokenledger",
      "agent": "codex",
      "via": "group/coding",
      "phase": "routed",
      "at": "2026-10-24T06:59:58.120Z",
      "hops": [
        { "target": "openai/gpt-5", "outcome": "failed", "status": 429 },
        { "target": "deepseek/deepseek-chat", "outcome": "ok" }
      ]
    }
  ]
}
```

| 字段 | 规则 |
| --- | --- |
| `v` | 固定 `1`。字段含义变化时升 v2 并新增 RPC，不改 v1 |
| `generatedAt` | 桌面生成快照的时间（RFC 3339，UTC） |
| `sources[]` | 0～2 项；`id` 为 `tokenledger` 或 `external`，各至多一次；`reachable` 布尔；`note` 可选，≤ 64 个字符 |
| `flows[]` | 0～24 项，新在前；只放 `at` 在 10 分钟内的流，在途流（`inflight`）不受此限 |
| `flows[].id` | 16 位小写十六进制（§3.2），同一请求在前后快照中相同，壁纸据此判断「新出现的流」 |
| `flows[].source` | `tokenledger` 或 `external` |
| `flows[].agent` | ≤ 64 个字符；取不到写 `Agent` |
| `flows[].via` | ≤ 128 个字符：`group/<组 ID>` 或直连请求的模型名 |
| `flows[].phase` | `inflight`、`routed`、`done`、`failed`，含义同设计文档 |
| `flows[].at` | RFC 3339；在途流为开始时间 |
| `flows[].waitingOn` | 可选，仅在途流：`slot`、`rpm`、`upstream` |
| `flows[].hops[]` | 0～8 项，按尝试顺序；`target` ≤ 128 个字符（`供应商/模型`）；`outcome` 为 `ok`、`failed`、`rejected`、`skipped`、`pending`；`status` 可选，100～599 的整数 |

服务器只校验结构、取值集合与长度；未列出的键一律拒绝，便于以后用 v2 扩展时不被旧服务器静默吞掉。

### 3.1 设备标识

`device = hex(SHA-256("tokenledger-routing-device-v1\n" + user_id + "\n" + 本机标识))` 的前 32 位。本机标识与上传 `token_logs` 时用的设备名相同，但只以哈希形式离开本机；换账号会得到不同的 `device`。

### 3.2 流标识

`id = hex(SHA-256("tokenledger-routing-flow-v1\n" + device + "\n" + 来源 + "\n" + 原始请求 ID))` 的前 16 位。原始请求 ID 是网关本地生成的随机 ID 或外部网关的序号，不离开本机。

## 4. 发布节奏（桌面端）

- 只在用户于设置里打开「把实时路由同步到手机」并已登录云同步时发布；默认关闭。关闭时调用 `clear_routing_snapshot_v1` 删除本机那一行。
- 后台每 5 秒构建一次快照；与上次发布的内容（去掉 `generatedAt` 后）相同就不发，但至少每 60 秒发一次心跳，让手机知道桌面仍在线。
- 连续失败时按 5 秒、10 秒……退避到最长 5 分钟，成功后复位。退出登录、换账号时停止发布。

## 5. 读取节奏（Android 壁纸）

- 只在壁纸可见（`onVisibilityChanged(true)`）时每 5 秒读一次；不可见时不读、不画。
- 合并所有设备的快照：`flows` 按 `id` 去重后按 `at` 新在前，`sources` 每台设备分别显示。
- 快照 `serverTime − receivedAt` 超过 90 秒显示「桌面已离线 N 分钟」并停止播放；没有任何快照显示「在桌面端打开同步」。
- 一条流第一次出现在快照里时才播放一次，记录时间早于 10 分钟的不播放；说明里写「N 秒前」，不把延迟后的回放说成实时。

## 6. 变更记录

- 2026-10-24：v1。
