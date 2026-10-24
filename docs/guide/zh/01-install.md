# 1. 安装

[← 目录](README.md) · 下一章：[首次启动引导 →](02-first-run.md)

## 支持的平台

| 平台 | 安装包 | 说明 |
| --- | --- | --- |
| Windows 10/11 x64 | `TokenLedger_Windows_<版本>_x64-unsigned-setup.exe`（推荐）或 `…-unsigned.msi` | 主界面、托盘、桌面壁纸、锁屏壁纸、桌面小组件 |
| macOS（Apple 芯片） | `TokenLedger_macOS_<版本>_arm64-unsigned.dmg` 或同名 `.zip` | 主界面、菜单栏、桌面壁纸（部分）、桌面小组件；不支持锁屏壁纸 |
| Android 8.0+ | APK | 只读看板，数据来自云端同步，见[第 6 章](06-cloud-mobile.md) |
| Linux | 无安装包 | 可从源码构建，不在公开支持范围内 |

安装包在 GitHub 的 [Releases](https://github.com/Geidorf/TokenLedger-open/releases) 页面。目前的桌面安装包**没有代码签名**，所以第一次打开时系统会拦一下，按下面的步骤放行即可。放行只需要做一次。

> 为什么没签名：代码签名证书与 Apple 公证需要付费账号，签名链路就绪前先提供未签名包。未签名不影响功能，但请只从本仓库的 Releases 下载。发行说明附有 SHA-256 时，可以先核对再安装（Windows：`certutil -hashfile <文件> SHA256`；macOS：`shasum -a 256 <文件>`）。

## Windows

1. 下载 `…-unsigned-setup.exe`。浏览器提示「不常下载」时，选「保留」。
2. 双击运行，出现蓝色的「Windows 已保护你的电脑」（SmartScreen）：
   1. 点 **更多信息**；
   2. 确认应用名是 `tokenledger`，点 **仍要运行**。
3. 按安装向导完成安装。安装后开始菜单里出现 `tokenledger`。

用 `.msi` 安装时，SmartScreen 的放行步骤相同。公司电脑若由管理员禁止运行未签名程序，请联系管理员，或改用源码构建。

TokenLedger 的界面依赖系统自带的 Microsoft Edge WebView2。Windows 11 和更新过的 Windows 10 已经内置；安装程序检测到缺失时会自动下载安装。

## macOS

1. 下载 `…-unsigned.dmg`，双击打开，把 `tokenledger` 拖进「应用程序」。
2. 第一次从「应用程序」打开时，系统会提示无法验证开发者，点 **完成**（或「取消」），先不要移到废纸篓。
3. 打开 **系统设置 › 隐私与安全性**，滚到「安全性」一节，找到「已阻止 tokenledger 以保护你的 Mac」，点 **仍要打开**，输入本机密码确认。
4. 再次打开 `tokenledger`，在弹窗里点 **打开**。

较早的 macOS 版本也可以在「应用程序」里按住 Control 点 `tokenledger`，选「打开」。

熟悉终端的话，也可以去掉下载隔离标记后直接打开：

```bash
xattr -dr com.apple.quarantine /Applications/tokenledger.app
```

应用目前显示为小写的 `tokenledger`，这是已知现象，不影响使用。

## 升级与卸载

- **升级**：下载新版安装包直接覆盖安装。本机账本、设置与钥匙串里的密钥都会保留。
- **卸载前**：如果有 Agent 接入了模型网关，先在「Agent」页逐个恢复，或关闭「设置 › 模型接入」时选「恢复原配置并关闭」。原配置的备份存在 TokenLedger 的数据目录里，删掉数据目录后就无法恢复，Agent 会一直指向已经不存在的本机网关。
- **卸载**：Windows 在「设置 › 应用」里卸载；macOS 把 `tokenledger.app` 移到废纸篓。卸载不会删除数据目录，彻底清除还需要手动删掉：

| 平台 | 数据目录 |
| --- | --- |
| Windows | `%APPDATA%\com.jeidorf.tokenledger` |
| macOS | `~/Library/Application Support/com.jeidorf.tokenledger` |

如果开过云端同步，建议卸载前先在「设置 › 云端账户」退出登录。云端已有的数据不会因为卸载而删除。

## 从源码构建

需要 Node.js 22+ 与 Rust 1.96+，步骤见仓库 [README](../../../README.md#从源码构建) 与 [CONTRIBUTING.md](../../../CONTRIBUTING.md)。
