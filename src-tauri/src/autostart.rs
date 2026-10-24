//! 开机自动启动。目前只在 Linux 上由应用自己实现：按 XDG Autostart 规范在
//! `$XDG_CONFIG_HOME/autostart`（缺省 `~/.config/autostart`）放一个 `.desktop`
//! 文件，GNOME、KDE、Xfce 等桌面登录时都会读它，不需要新依赖。Windows 与
//! macOS 仍显示「应用内暂不支持」，这里对它们是空操作。

use std::path::{Path, PathBuf};

/// 写进 autostart 目录的文件名；与应用 ID 一致，不会碰到用户自己的条目。
const DESKTOP_FILE_NAME: &str = "com.jeidorf.tokenledger.desktop";

/// 本平台能否在应用内切换开机自动启动。
pub fn supported() -> bool {
    cfg!(target_os = "linux")
}

/// 按设置写入或删除 autostart 条目。不支持的平台什么也不做。
pub fn apply(enabled: bool) -> Result<(), String> {
    if !supported() {
        return Ok(());
    }
    let Some(dir) = autostart_dir() else {
        return Err("找不到用户配置目录（HOME 未设置）。".to_string());
    };
    if enabled {
        let exec = launch_target()?;
        write_entry(&dir, &exec)
    } else {
        remove_entry(&dir)
    }
}

/// 启动时调用：开着就重写一遍，让 Exec 跟上 AppImage 被挪动后的新位置；
/// 关着就清掉可能残留的旧条目。
pub fn sync_on_launch(enabled: bool) {
    if let Err(error) = apply(enabled) {
        log::warn!("autostart sync failed: {error}");
    }
}

fn autostart_dir() -> Option<PathBuf> {
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .map(|home| home.join(".config"))
        })?;
    Some(config_home.join("autostart"))
}

/// 登录时要启动的可执行文件。AppImage 运行时 `current_exe` 指向临时挂载点，
/// 下次登录就不存在了，必须用运行时给出的 `$APPIMAGE`（镜像文件本身）。
fn launch_target() -> Result<PathBuf, String> {
    if let Some(appimage) = std::env::var_os("APPIMAGE").map(PathBuf::from) {
        if appimage.is_absolute() {
            return Ok(appimage);
        }
    }
    std::env::current_exe().map_err(|error| format!("无法确定程序位置：{error}"))
}

fn write_entry(dir: &Path, exec: &Path) -> Result<(), String> {
    let contents = desktop_entry(exec)?;
    std::fs::create_dir_all(dir).map_err(|error| format!("无法创建自启动目录：{error}"))?;
    let path = dir.join(DESKTOP_FILE_NAME);
    let temp = dir.join(format!(".{DESKTOP_FILE_NAME}.tmp"));
    std::fs::write(&temp, contents).map_err(|error| format!("无法写入自启动条目：{error}"))?;
    std::fs::rename(&temp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("无法写入自启动条目：{error}")
    })
}

fn remove_entry(dir: &Path) -> Result<(), String> {
    match std::fs::remove_file(dir.join(DESKTOP_FILE_NAME)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法删除自启动条目：{error}")),
    }
}

fn desktop_entry(exec: &Path) -> Result<String, String> {
    Ok(format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=TokenLedger\n\
         Comment=AI token usage ledger\n\
         Exec={}\n\
         Icon=tokenledger\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n",
        quote_exec(exec)?
    ))
}

/// 按 Desktop Entry 规范给 Exec 的程序路径加引号：双引号里 `"`、`` ` ``、
/// `$`、`\` 要转义，`%` 是字段码前缀要写成 `%%`。
fn quote_exec(exec: &Path) -> Result<String, String> {
    let raw = exec
        .to_str()
        .ok_or_else(|| "程序路径不是 UTF-8，无法写进自启动条目。".to_string())?;
    if raw.contains(['\n', '\r']) {
        return Err("程序路径含换行，无法写进自启动条目。".to_string());
    }
    let mut quoted = String::with_capacity(raw.len() + 2);
    quoted.push('"');
    for ch in raw.chars() {
        match ch {
            '"' | '`' | '$' | '\\' => {
                quoted.push('\\');
                quoted.push(ch);
            }
            '%' => quoted.push_str("%%"),
            _ => quoted.push(ch),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_is_quoted_and_escaped() {
        assert_eq!(
            quote_exec(Path::new("/opt/Token Ledger/app")).unwrap(),
            "\"/opt/Token Ledger/app\""
        );
        assert_eq!(
            quote_exec(Path::new("/tmp/a\"b$c`d\\e%f")).unwrap(),
            "\"/tmp/a\\\"b\\$c\\`d\\\\e%%f\""
        );
        assert!(quote_exec(Path::new("/tmp/a\nb")).is_err());
    }

    #[test]
    fn entry_is_written_replaced_and_removed() {
        let dir =
            std::env::temp_dir().join(format!("tokenledger-autostart-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        write_entry(&dir, Path::new("/usr/bin/tokenledger")).unwrap();
        let path = dir.join(DESKTOP_FILE_NAME);
        let first = std::fs::read_to_string(&path).unwrap();
        assert!(first.starts_with("[Desktop Entry]\n"));
        assert!(first.contains("\nExec=\"/usr/bin/tokenledger\"\n"));
        assert!(first.contains("\nType=Application\n"));

        write_entry(&dir, Path::new("/home/u/Apps/TokenLedger.AppImage")).unwrap();
        let second = std::fs::read_to_string(&path).unwrap();
        assert!(second.contains("\nExec=\"/home/u/Apps/TokenLedger.AppImage\"\n"));
        assert!(!dir.join(format!(".{DESKTOP_FILE_NAME}.tmp")).exists());

        remove_entry(&dir).unwrap();
        assert!(!path.exists());
        // 已经没有条目时再删一次也算成功。
        remove_entry(&dir).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
