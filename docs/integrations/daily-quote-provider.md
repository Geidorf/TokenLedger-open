# Android 每日金句来源

Android 全屏摆件的“今日一句”优先使用一言（Hitokoto）v1 公开句子接口。该集成不需要 API Key，不持有账户凭据，也不参与 TokenLedger 的登录或统计同步。

## 请求

- 官方说明：<https://developer.hitokoto.cn/sentence/>
- Endpoint：`https://v1.hitokoto.cn/`
- 参数：`c=d&c=i&c=k&encode=json&charset=utf-8&min_length=8&max_length=34`
- 分类：文学、诗词、哲学。
- 超时：连接和读取各 5 秒。
- 响应上限：16 KiB；禁止跟随重定向。
- 使用字段：`hitokoto`、`from`、`from_who`。正文与来源还会在客户端执行非空、空白和长度校验。

## 缓存与失败策略

`DailyQuoteRepository` 以设备本地日期为缓存键，将当天正文、来源与来源类型保存到应用私有 SharedPreferences。同日重复打开摆件只读取缓存；网络失败、非 200、超限或解析失败时选取内置经典语句并同样缓存，因此每个本地自然日最多发起一次在线请求。跨午夜后 ViewModel 重新计算日期并刷新。

## 隐私与安全边界

请求会把设备公网 IP、时间、User-Agent 等常规 HTTP 元数据暴露给一言服务及其基础设施；不发送 TokenLedger 用户 ID、Supabase 会话、设备统计、额度、日志或任何密钥。若用户或网络环境不允许访问该服务，功能保持可用并无提示地回退到内置语句。服务可用性和内容质量由第三方负责，TokenLedger 不将其作为关键数据依赖。
