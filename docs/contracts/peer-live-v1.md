# 外部网关实时路由状态契约 v1

状态：本机数据源已实现（桌面端），路由动画与 Android 壁纸尚未接入。拥有者：外部网关数据与 WebDAV 同步线程。

为桌面路由动画和 Android 动态壁纸提供外部网关（一款开源的本地 AI 网关）“此刻正在处理哪些请求”的只读数据源。

## 1. 来源

- 外部网关本机网关的“在途请求”接口（`GET`，路径见 `peer_wire::LIVE_PATH`，外部网关文档中公开说明）。这是公开、文档化的本机接口：不访问任何供应商，本身不计入用量，可每秒轮询一次；本机访问不需要 key。
- 只连接 `127.0.0.1:<port>`，`port` 默认 3425（外部网关的 `DefaultAddr`），可由调用方传入。不读取外部网关的 `settings.json` 来猜端口，不携带任何凭据，不走系统代理。
- 最近完成的路由：读取外部网关本机 `usage.jsonl` 末尾最多 128 KB（与本地用量导入读取的是同一个文件，只读）。每行是一次尝试，按 `route_id` 归为一条路由（`route_id` 为 0 的行各自成一条）。`computer` 非空的行是外部网关从其他电脑同步来的，不算本机路由，跳过。
- 不读取订阅登录、额度或任何供应商私有接口（ADR-004/017）。

## 2. 命令 `peer_live_snapshot`

仅主窗口可调用。入参 `port?: number`。返回：

```json
{
  "reachable": true,
  "port": 3425,
  "requests": 2,
  "waiting": 1,
  "tools": 0,
  "active": [
    { "id": 7, "agent": "claude", "model": "claude-opus-5-5", "provider": "anthropic",
      "started": "2026-10-23T13:00:00Z", "ms": 1200, "phase": "upstream" }
  ],
  "recent": [
    { "id": "9", "agent": "claude", "model": "claude-opus-5-5", "ended": "2026-10-23T13:00:03Z",
      "attempts": [
        { "provider": "relay", "outcome": "failed", "status": 529 },
        { "provider": "limited", "outcome": "rejected" },
        { "provider": "anthropic", "outcome": "ok" } ] }
  ]
}
```

- `reachable = false`：端口上没有服务，或 1.5 秒内没有响应。此时各计数为 0、`active` 为空。这不算错误，表示外部网关没在运行。
- 端口上的服务返回的不是 `object = "concurrency"`：报错，提示不是外部网关。HTTP 非 2xx（例如外部网关共享在局域网时要求 key）：报错。
- `active` 最多 256 项，按已进行时长降序排列。`model`、`provider` 在路由决定前为空。`phase` 取 `slot`（排队等并发槽）、`rpm`（等每分钟额度）、`upstream`（已发往上游或正在流式返回），外部网关不知道时为空。各字符串会截断长度。
- `recent` 最多 32 条，按最后一次尝试的先后、最新在前；每条最多 16 次尝试：超过时保留前 15 次和最后一次（最终结果总在末尾），中间省略的次数记在 `omitted`（没有省略时不出现）。`outcome` 为 `ok`（HTTP 2xx）、`failed`（其余状态，带 `status`）、`rejected`（外部网关未发往供应商就拒绝，例如限额或并发上限；旧版本没有 `rejected` 字段时，供应商为空且状态码 ≥ 400 也算）。`model` 取实际服务的模型，否则取路由模型或请求的模型。`ended` 是最后一次尝试的时间。外部网关网关没运行时 `recent` 照常读取；没有文件时为空。只保留供应商、结果与状态码，不带错误正文、账号、key 或会话。
- 丢弃外部网关返回的 `session`、`route` 与按 key/账号划分的 `data`：动画不需要，避免把会话 ID 和账号名带出去。

## 3. 复用

Rust 内 `peer_live::read_snapshot(port)` 返回与命令相同的快照，供其他窗口的只读命令（例如小组件的路由场景）复用；主窗口限制只在 `peer_live_snapshot` 命令上。

## 4. 前端

`src/hooks/usePeerLive.ts` 按至少 1 秒的间隔轮询，页面隐藏时暂停，`enabled = false` 时不发请求。停用或换端口时清空旧快照；读取出错时保留上次快照并返回 `stale = true`，调用方不要把它当作当前状态。

## 5. 后续

- 桌面路由动画：组件按 `active` 画出 agent → provider/model 的流转，`phase` 决定动画状态。
- Android 壁纸：手机读不到电脑的本机端口，需要桌面把聚合后的快照（只含计数与 agent/provider/model，不含会话）经 Supabase 推送。上传频率与表结构另立契约，并需要 Supabase 迁移评审。
- 外部网关的单会话路由长轮询接口能拿到单个会话的路由决策与回退过程，适合以后做“这一轮去了哪里”的细节视图。

## 6. 变更记录

- 2026-10-23：v1，本机快照命令与前端轮询 hook。
- 2026-10-23：加入 `recent`（最近完成的路由与回退尝试）和可复用的 `read_snapshot`。
- 2026-10-23：长路由保留最终结果并加 `omitted`；实时接口响应最多读 1 MB；hook 在停用或换端口时清空旧快照，读取出错时保留上次快照并返回 `stale = true`。
