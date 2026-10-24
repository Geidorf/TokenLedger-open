# 提醒推送到群聊与 Webhook（v1）

状态：实施中（2026-10-24 起）。适用平台：桌面端（设置 › 预算提醒 › 推送到群聊与 Webhook）。来源：用户要求把桌面已有的提醒（预算、额度窗口、用量异常、周报月报）同时推送到飞书、钉钉、企业微信、Slack、Discord 和通用 JSON Webhook。

## 不做的事

- **不新增判定**：Webhook 只转发已经弹出的系统通知。什么时候提醒、去重、每小时上限仍由各提醒模块自己决定（`budget.rs`、`quota/alerts.rs`、`usage_anomaly.rs`），这里只在它们调用系统通知之后多发一份。所以某类提醒的系统通知开关关着时，Webhook 也收不到它；设置卡片会点名提示。
- **不进云端、不进同步**：设置只存在本机应用数据目录；不改 `StatsData`、同步格式与 Supabase。
- **不回显地址**：机器人地址本身带令牌，保存后界面只显示域名。
- **不做消息模板与 @提醒**：消息是固定的纯文本，Slack 转义尖括号、Discord 禁用所有提及，标签不会变成 @所有人。

## 存储

| 内容 | 位置 |
| --- | --- |
| 总开关、每个 Webhook 的平台、名称、启用、推送类型、是否带费用、域名、是否已签名 | `alert_webhook_settings.json`（应用数据目录，私有权限，16 KiB 上限，逐条解析） |
| 地址与签名密钥 | 系统钥匙串，服务名 `com.jeidorf.tokenledger.alert-webhook`，账户 `webhook:<id>`，值为 `{url, secret}` |
| 每个 Webhook 最近一次发送结果（时间、成功、错误、是否测试） | `alert_webhook_state.json` |

- 最多 8 个 Webhook。编辑时地址留空表示不改；签名密钥只跟随原域名，换到别的域名或换平台时自动清除，必须重填。
- 钥匙串读取在进程内缓存，未签名安装包不会每条提醒都弹钥匙串授权。删除 Webhook 时先删设置再删钥匙串记录；新增时先写钥匙串，设置写失败就回滚。

## 平台

| 平台 | 地址校验 | 消息体 | 签名 | 成功判定 |
| --- | --- | --- | --- | --- |
| 飞书 | `https://open.feishu.cn` 或 `open.larksuite.com`，路径 `/open-apis/bot/v2/hook/` | `msg_type: text` | 可选：`timestamp` 秒 + `sign = Base64(HMAC-SHA256(key = "timestamp\nsecret", 空消息))` 放进消息体 | HTTP 2xx 且 `code`（旧版 `StatusCode`）为 0 |
| 钉钉 | `https://oapi.dingtalk.com/robot/send`，必须带 `access_token` | `msgtype: text` | 可选：`timestamp` 毫秒 + `sign = Base64(HMAC-SHA256(secret, "timestamp\nsecret"))` 追加到查询串 | `errcode` 为 0 |
| 企业微信 | `https://qyapi.weixin.qq.com/cgi-bin/webhook/send`，必须带 `key` | `msgtype: text` | 无 | `errcode` 为 0 |
| Slack | `https://hooks.slack.com/services/`（或 `/workflows/`、`/triggers/`） | `{text}`，转义 `& < >` | 无 | HTTP 2xx |
| Discord | `https://discord.com/api/webhooks/`（含 discordapp.com、ptb、canary） | `{content, allowed_mentions: {parse: []}}` | 无 | HTTP 2xx |
| 通用 JSON | 任意 HTTPS；HTTP 只允许本机回环地址 | `{source: "tokenledger", version: 1, kind, title, body, text, sentAt, cost?}` | 可选：请求头 `X-TokenLedger-Timestamp`（秒）与 `X-TokenLedger-Signature: sha256=<hex HMAC-SHA256(secret, "timestamp.body")>` | HTTP 2xx |

- 地址不能带用户名密码或 `#` 片段；聊天机器人必须是平台自己的域名和 443 端口，防止手误发到别处。
- 不跟随重定向，连接 5 秒、整体 10 秒超时，回包最多读 16 KiB。网络错误只给「超时」「连不上」这类说明，不回显带令牌的地址。
- 文本统一截到 1800 字（Discord 上限 2000）。`kind` 取值 `budget`、`quota`、`anomaly`、`periodReport`，测试消息为 `test`。

## 消息内容

- 格式：`【TokenLedger · 预算提醒】<通知标题>\n<通知正文>`，与系统通知同一份文字：范围名、周期、百分比、倍数，不含账号、路径、会话 ID 与费用。
- 「消息里带上预估费用」默认关。打开后只有两类消息多一行费用：费用口径的预算（`已用 $42.50 / 上限 $50.00`）与以美元计的异常（费用突增、昂贵会话：`预估费用 $12.35，平时约 $2.00`）。Token 预算、额度窗口、其他异常不带费用。
- 额度窗口提醒、周报月报提醒不带费用。

## 限频

- 来源模块各自的去重与每小时上限不变（额度 4 条/小时、预算 4 条/小时、用量异常 3 条/小时）。
- 每个 Webhook 另有安全上限：滚动 1 小时最多 12 条，超出的直接丢弃并记日志，不排队重发。
- 测试发送不受推送类型和启用开关限制，同一个 Webhook 5 秒内只能测一次。测试结果也记为「最近一次发送」。

## 界面

- 卡片放在「设置 › 预算提醒」最后：总开关（默认关）、已添加的 Webhook 列表（平台 · 域名 · 已签名 · 推送类型 · 带费用 · 最近一次结果；测试发送、启用/停用、编辑、删除）、添加/编辑表单。
- 推送类型对应的系统通知开关关着时，卡片用一行提示列出这些类型。当前版本还没有的提醒类型（周报月报，在对应功能合入前）显示为禁用。
- 文案按 [desktop-i18n-v1](desktop-i18n-v1.md) 走 `webhook.*` 键，组件与 hook 已加入 `FULLY_LOCALIZED`。后端返回的错误说明仍是中文。

## 验证

- Rust：`cargo test --lib alert_webhook`（地址校验、三种签名与独立计算的参考值、各平台消息体、回包判定、开关/类型/费用选择、每小时上限、钥匙串与设置文件分离、密钥只跟随原域名、本机回环服务器收到带签名的 POST、不跟随重定向且错误不含地址）；`budget`、`usage_anomaly` 各补一条费用文本测试。
- 前端：`AlertWebhookCard.test.tsx`；E2E `e2e/alert-webhook.spec.ts`（中文 chromium）。
- 待平台验收：真实飞书、钉钉、企业微信、Slack、Discord 机器人收到消息与加签校验通过；Windows 凭据管理器与 macOS 钥匙串读写。
