# Rust 依赖公告处置记录

桌面端 Rust 依赖（`src-tauri/Cargo.lock`）对照 [RustSec 公告库](https://rustsec.org/) 的处置结论。CI 里的 `Rust Dependency Advisories` workflow（`.github/workflows/rust-advisories.yml`）在改依赖的 PR、`main` 合并和每周一定时运行 `cargo audit`：出现漏洞（vulnerability）即失败；unsound 与停止维护提示只打印，处置结论记在本文，不用 `--ignore` 隐藏。

本机复查：

```bash
cargo install cargo-audit --version 0.22.2 --locked
cd src-tauri && cargo audit
```

查某个包是谁带进来的：`cargo tree -i <包名>@<版本> --target all`。

## 当前状态（2026-10-27，cargo-audit 0.22.2，609 个包）

漏洞 0 项。剩余 14 条提示，全部来自上游框架的传递依赖，应用代码不直接使用，也没有同一主版本内的兼容修复版本：

| 公告 | 包 | 类别 | 带入链 | 平台 | 处置 |
|---|---|---|---|---|---|
| RUSTSEC-2024-0429 | glib 0.18.5 | unsound | tauri / wry / tray-icon → gtk 0.18 → glib 0.18 | 仅 Linux | 等上游换 GTK 代际，见下 |
| RUSTSEC-2024-0370 | proc-macro-error 1.0.4 | 停止维护 | glib-macros 0.18（编译期宏） | 仅 Linux 构建 | 随 glib 一起解决 |
| RUSTSEC-2025-0075 / 0080 / 0081 / 0098 / 0100 | unic-* 0.9.0（5 个） | 停止维护 | tauri-utils 2.9 → urlpattern 0.3 | 全平台，编译期与运行时 | 升 Tauri 2.12（urlpattern 0.6 已改用 icu_properties），单独任务 |
| RUSTSEC-2026-0192 | ttf-parser 0.25.1 | 停止维护 | ab_glyph 0.2 → owned_ttf_parser | 全平台 | 只解析固定路径下的系统字体，暂留 |
| RUSTSEC-2026-0370 / 0371 / 0372 | zvariant、zbus_names、zvariant_derive（4.x 与 5.x 各一份） | 停止维护 | tauri-plugin-notification → notify-rust → zbus 5；4.x 一份来自 keyring → secret-service → zbus 4，只在锁文件里，当前特性组合不编译进应用 | 仅 Linux | 已并入 zbus 6，等 notify-rust 跟进（最新 4.18.2 仍要求 zbus ^5） |

### glib 0.18（RUSTSEC-2024-0429）

公告说的是 `VariantStrIter` 的迭代实现把可变出参写在不可变引用后面，新编译器下属于未定义行为；修复在 glib 0.20 起。核查结论：

- Windows 与 macOS 目标的依赖树不含 glib；Linux 上经 gtk 0.18 由 Tauri 运行时、webview、托盘与菜单带入。
- 截至 2026-10-27，最新的 tauri-runtime-wry 2.12.3、wry 0.57.1、tray-icon 0.26.1 仍要求 `gtk ^0.18`，gtk 0.18 又锁定 glib 0.18。单独加 glib 0.20 替换不了这条链，强制跨主版本替换会破坏编译。
- 应用代码不直接使用 glib；锁定版本的 gtk、gdk、gio、webkit2gtk、wry、tao、muda、tray-icon、libappindicator 源码中都没有调用 `VariantStrIter` 或返回它的 `Variant::array_iter_str`，只有 glib 自身定义、导出和测试。
- 这是源码文本证据，不覆盖动态分派或 C 侧回调；上游 Tauri 换到新 GTK 代际后再升级，届时删除本行。

### 已处置

| 日期 | 公告 | 包 | 做法 |
|---|---|---|---|
| 2026-10-27 | RUSTSEC-2026-0391 / 0398 / 0403 / 0410（漏洞），0395–0397 / 0399–0402 / 0404–0406（unsound） | zstd 0.13.3、zstd-safe 7.2.4、zstd-sys 2.0.16 | 升级到 zstd 0.14.3（zstd-safe 8.2.0、zstd-sys 2.1.2）。应用用它解压本机会话日志和读写本地备份，属于直接可达；用到的 `encode_all`、`stream::read::Decoder`、`stream::write::Encoder` 接口不变 |
| 2026-10-27 | RUSTSEC-2024-0436（停止维护） | paste 1.0.15 | `image` 关掉默认格式只留 PNG，去掉 AVIF 编码链（rav1e 等 54 个包）；应用只读写 PNG |

## 处置原则

- 先确认带入链、目标平台和应用是否真的调用到受影响的接口，再决定升级、替换或暂留。
- 只在同一主版本内或上游已兼容的范围升级；不用 `[patch]` 或强制跨主版本替换去消掉公告。
- 停止维护提示不等于已证实的漏洞，跟随上游升级处理，在这里记一行即可。
- 依赖调整属于 B 级（见 [协作约定](COLLABORATION.md)），改完重新跑 `cargo audit` 并更新本文。

Android 依赖扫描另见 [android-dependency-scan.md](android-dependency-scan.md)。
