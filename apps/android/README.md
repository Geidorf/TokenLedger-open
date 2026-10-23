# TokenLedger Android

本目录是 TokenLedger 的原生 Android 只读看板。首版用于移动端验收：邮箱密码登录 Supabase，读取云端 RPC 聚合结果，默认展示“今日”视图。

## 构建配置

构建基线固定为 JDK 17、Gradle Wrapper 8.13、Android API 36；不要依赖每台机器各自安装的全局 Gradle。依赖与插件版本统一写在 `gradle/libs.versions.toml`，升级只改这一处；升级 Compose BOM 会改变截图像素，需要在 macOS 金图主机上重新生成截图基线。

1. 安装 JDK 17 与 Android SDK Platform 36，并设置 `JAVA_HOME`。
2. 复制 `local.properties.sample` 为 `local.properties`，至少设置 `sdk.dir`。
3. 云端联调或交付安装包必须填写 `TOKENLEDGER_SUPABASE_URL` 和 publishable key；测试、类型检查与空配置调试编译不需要提交这些值。
4. 在仓库根目录构建已配置、可登录云端的 debug 安装包：

```powershell
npm run android:build:debug
```

也可以在本目录直接执行 macOS/Linux Wrapper：

```bash
./gradlew --no-daemon packageConfiguredDebug
```

Windows 使用：

```powershell
.\gradlew.bat --no-daemon packageConfiguredDebug
```

Android 的 `versionName` 会自动读取根目录 `package.json` 的版本号；`versionCode` 由版本号计算生成。`packageConfiguredDebug` 会先验证 HTTPS URL、公开 publishable key，并拒绝 `sb_secret_`；验证通过后才会额外复制一个带版本号的 APK 到仓库根目录 `release/`，例如：

```text
release/TokenLedger_Android_1.1.3_debug.apk
```

原始 Gradle 产物仍位于 `app/build/outputs/apk/debug/`。普通 `assembleDebug` 仍用于空配置编译和测试，但不会再自动生成 `release/` 下容易被误当作可交付包的版本化 APK。

### Release 与签名

发布链路刻意区分“压缩门禁”和“可分发候选”。以下命令在仓库根目录执行：

```bash
# 只验证 R8 / resource shrink，产物明确不签名，不可分发
node scripts/run-android-gradle.mjs :app:assembleRelease

# 构建可分发候选；缺配置会在构建阶段失败
node scripts/run-android-gradle.mjs :app:assembleSignedRelease
```

`signedRelease` 需要以下配置，可放在 CI 环境变量或未提交的 `local.properties`：

```text
TOKENLEDGER_ANDROID_KEYSTORE_PATH=/absolute/path/to/release.keystore
TOKENLEDGER_ANDROID_KEYSTORE_PASSWORD=...
TOKENLEDGER_ANDROID_KEY_ALIAS=...
TOKENLEDGER_ANDROID_KEY_PASSWORD=...
TOKENLEDGER_SUPABASE_URL=https://...
TOKENLEDGER_SUPABASE_PUBLISHABLE_KEY=...
```

keystore 必须真实可读，Supabase URL 必须为 HTTPS，publishable key 不能为空。项目绝不会用 debug key 兜底正式签名；缺失任一签名或公共运行配置时，`assembleSignedRelease` 会 fail-fast。普通 `assembleRelease` 生成的 `app-release-unsigned.apk` 仅是 R8/resource-shrink 证据，不是发布 APK。正式发布还必须执行 `apksigner verify`、真机安装/覆盖升级与版本回退检查。

## 数据流

- 登录：Supabase Auth 邮箱密码登录。
- 会话：使用 Android Keystore 生成的 AES-GCM 密钥加密后保存在本机。
- 基础看板：调用 `rpc/get_dashboard_stats`，参数为 `p_user`、`p_range`、`p_machine`、`p_timezone`。
- v2 看板：并行调用 `get_usage_comparison_v1` 与 `get_usage_details_v1`；进入工具/模型下钻时调用 `get_usage_entity_dashboard_v1`。全部请求沿用登录用户 Bearer token，客户端不持有 service role。
- 默认范围：首次进入固定为 `today`，用户可切换本周、本月、今年和总计。
- 刷新策略：APK 只读云端聚合数据，不调用 `request_refresh()`。
- 兼容策略：如果线上 Supabase 还没有部署带 `p_timezone` 的基础 RPC，APK 会自动回退到旧版 3 参数 RPC。v2 RPC 缺失会被记录为 capability unavailable：同期、筛选、分页或来源下钻不会伪装成空数据；工具/模型筛选无法可靠执行时会明确要求升级云端契约。

## 导航与视图结构

主内容按 `docs/design/android-ledger-snapshot-v1.png` 落地 Ledger Snapshot：

- 紧凑窗口使用底部 4 个 Material 3 入口；可用宽度达到 600dp 时切换为同一组 **快照、明细、工具、设置** NavigationRail，实体下钻页不重复显示主导航。趋势由快照 Hero 的“查看趋势与数据表”进入。
- **快照**：真实有效 Token 主数字、成本/请求/缓存拆分、当前与上一周期同进度双序列、额度不可用说明、设备上下文以及工具/模型主要贡献。
- **明细**：v2 小时聚合记录、总数、筛选上下文和 keyset 分页；不是逐请求明细，界面会明确标注粒度。
- **工具**：工具/模型切换排行；点击进入来源专属看板，并保留范围、设备和父级来源上下文。工具内可继续进入模型，返回逐级恢复原筛选。
- **设置**：显示统计口径、系统减少动态效果状态与 v2 capability。
- 高频筛选包含范围、设备、工具和模型。筛选选项来自 v2 `availableFilters`；清除筛选始终可达。
- 系统 Back 只在实体下钻栈非空时由应用消费并逐级恢复父上下文；根页交还 Android 系统。真机仍需分别验证手势/三键导航、筛选 sheet 优先关闭与快速连续 Back。

## 视觉与平板适配

- 默认目标视觉为深色 OLED：`#080A0F` 背景、`#11141B/#171B25` 表面、`#5B6CFF/#8B6CFF` 主辅色；不使用渐变或伪造品牌资产，图标来自 Material Icons。设置页可持久切换同骨架的 Light 与高对比 E-ink；E-ink 仅用黑白/灰阶并禁用动态效果。
- 320–430dp 使用同一响应式单列骨架；小于 360dp 或字体缩放达到 150% 时，Hero 指标自动从三列重排。600dp 及以上使用 NavigationRail 释放纵向空间。所有主要点击目标至少 48dp，文本容器不使用固定高度。
- 趋势 Canvas 提供完整 `contentDescription`，另有可访问数据表；工具、筛选、刷新、返回等控件都有语义标签。
- 页面不依赖装饰动画；系统动画缩放为 0 时保持静态呈现。后续若增加动画，必须继续使用同一系统 reduced-motion 开关。
- 当前 T4.2 不为 Android 伪造额度百分比。没有官方 API、用户授权来源或手工配置时，额度卡固定显示“不可用”。

## 常见问题

### 登录报 `Could not find the function public.get_dashboard_stats(...)`

说明线上 Supabase 尚未部署新版 RPC，或 SQL 执行后 PostgREST schema cache 尚未刷新。处理方式：

1. 在 Supabase SQL Editor 执行 `supabase/schema.sql` 或最新迁移文件。
2. 等待 Supabase Data API 刷新 schema cache，必要时重启项目或重新执行迁移。
3. 重新打开 APK 并刷新看板。

### 过 0 点后「今日」仍显示昨日数据

该问题有两层成因，对应两层修复：

1. **云端旧版 RPC 按 UTC 解析日界**：若线上还是 3 参签名的 `get_dashboard_stats`（无 `p_timezone`），APK 会自动回退调用旧版，此时"今日"按 UTC 日期解析——东八区 0:00–8:00 之间 UTC 仍是昨天，返回的就是昨日全量数据。APK 检测到回退时会在看板顶部显示黄色提示；修复方式是在 Supabase 重新执行 `supabase/schema.sql`（新版 RPC 以 `p_timezone` + `now() at time zone` 解析日界，客户端写入的 `timestamp` 本身就是本地时间字符串，两侧口径一致）。
2. **客户端不会自行翻天**：进程驻留后台时 UI 持续渲染最后一次拉取的数据。现已修复：回到前台（`ON_START`）自动刷新（日期已翻天立即拉取，否则 60 秒节流），且应用保持前台（含摆件常显）时在本地 0 点整自动重载。

另注意：无设备筛选时汇总读取的是物化视图，需要桌面端触发 `request_refresh()` 后才包含最新写入；视图待刷新期间 APK 会显示"云端汇总正在等待刷新"提示（`meta.stale`），这与日界问题无关。

### 同期趋势显示「同期不可用」

同期双序列来自 `get_usage_comparison_v1`。`year` 与 `all` 按契约没有等长对照窗口，成功响应也可以是 `null`，界面会诚实显示“不适用/不可用”；这不等于上一周期为 0。若 `today/week/month` 也不可用，请部署 `20260714162044_tokenledger_stats_v2_details_comparison.sql` 并等待 PostgREST schema cache 刷新。

## 验证

```powershell
npm run android:verify
node scripts/run-android-gradle.mjs :app:validateDebugScreenshotTest
```

`android:verify` 顺序执行单测、Android lint 与 debug assemble；单测覆盖统计 DTO、状态竞态、离线缓存、RPC payload、导航宽度分界与实体 Back 策略。`validateDebugScreenshotTest` 使用官方 Compose Preview Screenshot Testing，在主机上验证 320×720 dark、390×844 dark、430×932 light、390×844 字体 200%、390×844 E-ink、840×900 NavigationRail，以及 390×844 的周环比和月环比，共八份 golden，不需要模拟器。

只有在产品/设计复核确认视觉变化是有意行为后，才可运行 `node scripts/run-android-gradle.mjs :app:updateDebugScreenshotTest` 更新 golden，并必须把设计源与新实现放入同一比较输入留下证据。当前组合证据位于 `docs/task-logs/T4.2/evidence/android-visual-matrix/`。主机截图不等于真机视觉、触控、TalkBack、edge-to-edge、导航或 GPU/热性能验收，设备矩阵仍按 `docs/PROJECT.md` 执行。
