# 1. Install

[← Contents](README.md) · Next: [First-run guide →](02-first-run.md)

## Supported platforms

| Platform | Package | Notes |
| --- | --- | --- |
| Windows 10/11 x64 | `TokenLedger_Windows_<version>_x64-unsigned-setup.exe` (recommended) or `…-unsigned.msi` | Main window, tray, desktop wallpaper, lock-screen wallpaper, desktop widget |
| macOS (Apple silicon) | `TokenLedger_macOS_<version>_arm64-unsigned.dmg` or the matching `.zip` | Main window, menu bar, desktop wallpaper (partial), desktop widget; no lock-screen wallpaper |
| Android 8.0+ | APK | Read-only dashboard fed by cloud sync, see [chapter 6](06-cloud-mobile.md) |
| Linux x64 | `TokenLedger_Linux_<version>_x86_64-unsigned.AppImage`, `…_amd64-unsigned.deb` or `…_x86_64-unsigned.rpm` | Preview, not officially supported: main window, tray, start at login; no wallpaper |

Packages are on the GitHub [Releases](https://github.com/Geidorf/TokenLedger-open/releases) page. The desktop installers are currently **not code-signed**, so the operating system stops them the first time. Follow the steps below to allow the app. You only need to do this once.

> Why unsigned: code-signing certificates and Apple notarization need paid accounts, so unsigned packages are offered until signing is set up. Being unsigned does not change what the app does, but only download it from this repository's Releases. When the release notes list SHA-256 hashes, check the file before installing (Windows: `certutil -hashfile <file> SHA256`; macOS: `shasum -a 256 <file>`; Linux: `sha256sum <file>`).

## Windows

1. Download `…-unsigned-setup.exe`. If the browser says the file isn't commonly downloaded, choose **Keep**.
2. Double-click it. A blue "Windows protected your PC" (SmartScreen) dialog appears:
   1. Click **More info**;
   2. Check that the app name is `tokenledger`, then click **Run anyway**.
3. Finish the setup wizard. `tokenledger` appears in the Start menu.

The `.msi` package needs the same SmartScreen step. If your administrator blocks unsigned programs on a work computer, ask them, or build from source.

TokenLedger's interface uses Microsoft Edge WebView2, which ships with Windows 11 and up-to-date Windows 10. If it is missing, the installer downloads it.

## macOS

1. Download `…-unsigned.dmg`, open it and drag `tokenledger` into Applications.
2. Open it from Applications. macOS says it cannot verify the developer. Click **Done** (or Cancel). Do not move it to the Bin.
3. Open **System Settings › Privacy & Security**, scroll to the Security section, find "tokenledger was blocked to protect your Mac", click **Open Anyway** and confirm with your password.
4. Open `tokenledger` again and click **Open** in the dialog.

On older macOS versions you can also Control-click `tokenledger` in Applications and choose **Open**.

If you are comfortable with Terminal, you can remove the download quarantine flag instead:

```bash
xattr -dr com.apple.quarantine /Applications/tokenledger.app
```

The app currently shows up as lowercase `tokenledger`. This is known and harmless.

## Linux

There are three unsigned Linux packages. Pick one:

| Package | For | Install |
| --- | --- | --- |
| `TokenLedger_Linux_<version>_amd64-unsigned.deb` | Ubuntu 22.04+, Debian 12+ and derivatives | `sudo apt install ./TokenLedger_Linux_<version>_amd64-unsigned.deb` |
| `TokenLedger_Linux_<version>_x86_64-unsigned.rpm` | Fedora, openSUSE and other RPM distributions | `sudo dnf install ./TokenLedger_Linux_<version>_x86_64-unsigned.rpm` |
| `TokenLedger_Linux_<version>_x86_64-unsigned.AppImage` | Any x86_64 distribution with glibc 2.35+, no install | `chmod +x` the file, then double-click it or run it from a terminal |

To check a file, run `sha256sum <file>` and compare it with the SHA-256 in the release notes.

- The deb and rpm pull in their dependencies (WebKitGTK 4.1, GTK 3, the tray library). Afterwards `tokenledger` is in your app menu and on your `PATH`. The `tokenledger-cli` command-line tool is installed next to it in `/usr/bin`.
- The AppImage brings its own libraries and writes nothing to system folders. If it complains about FUSE (`dlopen(): error loading libfuse.so.2`), install `libfuse2` (`libfuse2t64` on Ubuntu 24.04), or start it with `--appimage-extract-and-run`.
- **Tray**: TokenLedger uses a StatusNotifier (AppIndicator) tray icon. KDE, Xfce, Cinnamon and most other desktops show it out of the box; on GNOME you need the "AppIndicator and KStatusNotifierItem Support" extension (Ubuntu enables it by default). Clicking the icon does not open the tray widget on Linux. Open the icon's menu instead and choose 显示窗口 (show window) or 显示 / 隐藏托盘挂件 (show / hide tray widget). Without a tray, leave **Start minimized to tray** off. If the main window is hidden, run `tokenledger` again and it comes back.
- **Start at login**: turn it on in **Settings › Scan & startup (扫描与启动)**. TokenLedger writes `~/.config/autostart/com.jeidorf.tokenledger.desktop`. For the AppImage the entry points at the AppImage file itself. If you move the file, open the app once and the entry is updated.
- **Secrets**: your cloud sign-in and provider API keys are stored in the system Secret Service (GNOME Keyring, KWallet and similar), so they survive logout and reboot. On a desktop without a Secret Service, saving a key fails with an error; install and unlock a keyring service such as `gnome-keyring` first.
- **Scan locations**: TokenLedger honours `XDG_CONFIG_HOME` and `XDG_DATA_HOME` and falls back to `~/.config` and `~/.local/share`. Agent folders such as `~/.claude` and `~/.codex` are the same as on other platforms.

## Upgrade and uninstall

- **Upgrade**: install the new package over the old one. Your local ledger, settings and keychain secrets are kept.
- **Before uninstalling**: if any agent is connected to the model gateway, restore it on the Agents page, or choose "Restore original configs and turn off" when turning off **Settings › Model access**. The backups of the original configs live in TokenLedger's data folder; once that folder is deleted they are gone and the agent keeps pointing at a local gateway that no longer exists.
- **Uninstall**: on Windows use Settings › Apps; on macOS move `tokenledger.app` to the Bin; on Linux run `sudo apt remove tokenledger` (deb) or `sudo dnf remove tokenledger` (rpm), or delete the AppImage. Uninstalling does not delete the data folder. To remove everything, also delete:

| Platform | Data folder |
| --- | --- |
| Windows | `%APPDATA%\com.jeidorf.tokenledger` |
| macOS | `~/Library/Application Support/com.jeidorf.tokenledger` |
| Linux | `~/.local/share/com.jeidorf.tokenledger` (under `XDG_DATA_HOME` when that is set) |

If you used cloud sync, sign out in **Settings › Cloud account** first. Uninstalling does not delete data that is already in the cloud.

## Build from source

You need Node.js 22+ and Rust 1.96+. See the repository [README](../../../README.md) and [CONTRIBUTING.md](../../../CONTRIBUTING.md).
