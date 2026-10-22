# 版本管理规范

TokenLedger 使用根目录 `package.json` 的 `version` 作为唯一人工维护版本号。所有桌面端、Rust 后端和 Android APK 构建都必须从这个版本号派生。

## 统一版本源

- `package.json`：唯一手动修改入口。
- `package-lock.json`：必须与 `package.json` 保持一致。
- `src-tauri/Cargo.toml`：Rust/Tauri crate 版本必须与根版本一致。
- `src-tauri/tauri.conf.json`：桌面安装包版本必须与根版本一致。
- `src-tauri/tauri.legacy.conf.json`：历史配置仍保持同一版本，避免误用旧配置时产物版本漂移。
- `apps/android/app/build.gradle.kts`：Android `versionName` 自动读取根版本，`versionCode` 由根版本计算。

## 开发检查与构建

执行以下命令检查版本一致性：

```powershell
npm run version:check
```

统一开发门禁使用：

```powershell
npm run check
```

该命令按 `scripts/run-checks.mjs` 的步骤清单依次执行版本一致性、路径长度、ESLint、TypeScript、Vitest 与前端契约测试、发布安全脚本测试、前端生产构建与包体预算、Supabase SQL 回归（本机没有 Docker 时跳过并提示）、Rust 测试、Clippy、rustfmt 和空白错误检查等，具体步骤以该脚本为准，并在结束时核对全部已跟踪文件的内容与权限。检查失败或任何已跟踪文件发生变化时都会返回非零退出码，因此可以在不同机器和智能体之间重复执行。

`npm run build`、`npm run build:debug`、`npm run android:build:debug` 和 `npm run android:verify` 只检查版本一致性，不会修改版本。Android 构建脚本从根版本派生 `versionName`，直接运行 Gradle 也不会改源码版本文件。

## 构建产物命名

- 桌面端：Tauri 安装包使用 `src-tauri/tauri.conf.json` 中的版本号。
- Android：`assembleDebug` 成功后会复制版本化 APK 到 `release/`，命名格式为：

```text
TokenLedger_Android_<version>_debug.apk
```

示例：

```text
TokenLedger_Android_1.1.3_debug.apk
```

`release/` 是本地构建产物目录，不提交到仓库。

## 发版要求

版本提升只能由发布协调员显式执行：

```powershell
npm run release:bump
```

该命令统一提升 patch 版本并同步根 lockfile、Tauri/Rust 配置；直接运行版本脚本会被拒绝。确认版本和发布说明后，再运行：

```powershell
npm run check
npm run android:build:debug
npm run android:verify
```

如果修改了 Supabase schema，还需要同步更新 `supabase/schema.sql` 和 `supabase/migrations/` 下的迁移文件，并在文档中记录 RPC 签名变化。
