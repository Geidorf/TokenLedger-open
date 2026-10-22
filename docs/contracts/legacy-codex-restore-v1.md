# 旧版 Codex 只恢复桥 v1（T10.300d）

旧 API Profile 管理已退役。本桥只读取旧元数据数量和当前 singleton 选择凭据，不恢复 profile CRUD、probe、凭据管理或 CLI 启动。旧数据库及历史行不删除。

- 主窗口限定命令：`gateway_legacy_inspect`、`gateway_legacy_restore`；小组件、壁纸和远程来源无权限。返回状态 `none | pending | active | indeterminate | restored | kept`，只含数量、凭据ID、配置版本、可恢复性与静态原因，无原配置/密钥。
- 数据库必须为有界普通单硬链接文件、SQLite NOFOLLOW、应用ID `0x544c4150`、user_version/meta相同且为1/2。v1无receipt表可只读展示元数据；foreign/future拒绝，不隐式迁移。
- 当前 Codex home 由绝对 `CODEX_HOME` 或默认用户目录发现；必须与凭据的 canonical home/config.toml 身份一致。配置限定256KiB普通文件，UTF-8/TOML合法。仅根 `model_provider`，及旧凭据manage_model时的根 `model` 可改；供应商表、未知字段与其值不改。
- 用户确认携带receiptId和完整文件expectedVersion；旧跨进程lease存在时获取原EXCLUSIVE锁，再锁旧registry，核对receipt身份/状态及文件版本。写前再次核对路径与字节，原子替换。当前受管根键必须等于目标或完整前像；外部漂移阻断恢复，无强制覆盖入口。
- pending/indeterminate不会自动推断成功。用户显式恢复时，目标匹配则撤销；完整前像已存在则只封存，支持“文件恢复成功但DB更新失败/进程中断”的对账。写入/读回复核失败保留凭据，不盲自动重试。
- 恢复成功后旧receipt标restored；“保留当前”不改配置也不谎称恢复，独立 `tokenledger_legacy_resolution` 记录kept并封存入口。封存后拒绝另一窗口此前取得的恢复或保留确认。profile/historical receipt不改。其他安装或无法读取文件不能封存。
- “恢复后选择网关模型”先执行旧选择恢复，再打开现有Codex选择入口，仍需预览确认新的网关接入；不复制旧凭据，不自动选供应商。现有会话不热切换。
- Agent页和设置「模型接入」分区提供同一恢复卡；总开关关闭时仍可恢复旧选择。旧 `#settings-api-profiles`、`#api-profiles` 书签及同名设置事件重定向至 `#settings-model-access`。

桥使用当前网关的本地原子文件写入机制；旧已废止契约中的app-server生产门不再用于此只恢复操作。它确认的是用户配置文件的选择键，不能证明CLI/项目/托管层的最终有效配置。测试只使用临时SQLite/TOML；真实原生IPC及运行中的Codex须另验。
