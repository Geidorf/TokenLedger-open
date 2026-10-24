# 1. Install

[← Contents](README.md) · Next: [First-run guide →](02-first-run.md)

## Supported platforms

| Platform | Package | Notes |
| --- | --- | --- |
| Windows 10/11 x64 | `TokenLedger_Windows_<version>_x64-unsigned-setup.exe` (recommended) or `…-unsigned.msi` | Main window, tray, desktop wallpaper, lock-screen wallpaper, desktop widget |
| macOS (Apple silicon) | `TokenLedger_macOS_<version>_arm64-unsigned.dmg` or the matching `.zip` | Main window, menu bar, desktop wallpaper (partial), desktop widget; no lock-screen wallpaper |
| Android 8.0+ | APK | Read-only dashboard fed by cloud sync, see [chapter 6](06-cloud-mobile.md) |
| Linux | No package | Can be built from source; not officially supported |

Packages are on the GitHub [Releases](https://github.com/Geidorf/TokenLedger-open/releases) page. The desktop installers are currently **not code-signed**, so the operating system stops them the first time. Follow the steps below to allow the app. You only need to do this once.

> Why unsigned: code-signing certificates and Apple notarization need paid accounts, so unsigned packages are offered until signing is set up. Being unsigned does not change what the app does, but only download it from this repository's Releases. When the release notes list SHA-256 hashes, check the file before installing (Windows: `certutil -hashfile <file> SHA256`; macOS: `shasum -a 256 <file>`).

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

## Upgrade and uninstall

- **Upgrade**: install the new package over the old one. Your local ledger, settings and keychain secrets are kept.
- **Uninstall**: on Windows use Settings › Apps; on macOS move `tokenledger.app` to the Bin. Uninstalling does not delete the data folder. To remove everything, also delete:

| Platform | Data folder |
| --- | --- |
| Windows | `%APPDATA%\com.jeidorf.tokenledger` |
| macOS | `~/Library/Application Support/com.jeidorf.tokenledger` |

If you used cloud sync, sign out in **Settings › Cloud account** first. Uninstalling does not delete data that is already in the cloud.

## Build from source

You need Node.js 22+ and Rust 1.96+. See the repository [README](../../../README.md) and [CONTRIBUTING.md](../../../CONTRIBUTING.md).
