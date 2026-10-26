use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const DESKTOP_FILE_NAME: &str = "com.jeidorf.tokenledger.desktop";

pub(super) struct Snapshot {
    path: PathBuf,
    bytes: Option<Vec<u8>>,
}

pub(super) fn snapshot() -> Result<Snapshot, String> {
    let path = entry_path()?;
    let bytes = super::read_entry_file(&path)?;
    Ok(Snapshot { path, bytes })
}

pub(super) fn restore(snapshot: &Snapshot) -> Result<(), String> {
    super::replace_entry_file(&snapshot.path, snapshot.bytes.as_deref())
}

pub(super) fn enabled() -> Result<bool, String> {
    enabled_at(&entry_path()?)
}

pub(super) fn set_enabled(enabled: bool) -> Result<(), String> {
    let path = entry_path()?;
    if enabled {
        super::replace_entry_file(&path, Some(desktop_entry(&launch_target()?)?.as_bytes()))
    } else {
        super::replace_entry_file(&path, None)
    }
}

pub(super) fn refresh_existing() -> Result<(), String> {
    refresh_at(&entry_path()?, &launch_target()?)
}

fn refresh_at(path: &Path, executable: &Path) -> Result<(), String> {
    let Some(bytes) = super::read_entry_file(path)? else {
        return Ok(());
    };
    let text = std::str::from_utf8(&bytes).map_err(|_| invalid_entry())?;
    if !entry_enabled(text)? {
        return Ok(());
    }
    let mut in_entry = false;
    let mut updated = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_entry = trimmed == "[Desktop Entry]";
        }
        if in_entry
            && trimmed
                .split_once('=')
                .is_some_and(|(key, _)| key.trim() == "Exec")
        {
            updated.push_str(&format!("Exec={}\n", quote_exec(executable)?));
        } else {
            updated.push_str(line);
            updated.push('\n');
        }
    }
    if updated.as_bytes() != bytes {
        super::replace_entry_file(path, Some(updated.as_bytes()))?;
    }
    Ok(())
}

fn enabled_at(path: &Path) -> Result<bool, String> {
    match super::read_entry_file(path)? {
        None => Ok(false),
        Some(bytes) => entry_enabled(std::str::from_utf8(&bytes).map_err(|_| invalid_entry())?),
    }
}

fn invalid_entry() -> String {
    "登录启动条目格式未知，请在系统启动设置中检查。".to_string()
}

fn entry_enabled(text: &str) -> Result<bool, String> {
    let mut values = BTreeMap::new();
    let mut in_entry = false;
    let mut seen_entry = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            if in_entry && seen_entry {
                return Err(invalid_entry());
            }
            seen_entry |= in_entry;
            continue;
        }
        if in_entry {
            let (key, value) = line.split_once('=').ok_or_else(invalid_entry)?;
            if values.insert(key.trim(), value.trim()).is_some() {
                return Err(invalid_entry());
            }
        }
    }
    if values.get("Type") != Some(&"Application")
        || values.get("Exec").is_none_or(|value| value.is_empty())
    {
        return Err(invalid_entry());
    }
    let boolean = |key, fallback| match values.get(key) {
        None => Ok(fallback),
        Some(&"true") => Ok(true),
        Some(&"false") => Ok(false),
        _ => Err(invalid_entry()),
    };
    if boolean("Hidden", false)? || !boolean("X-GNOME-Autostart-enabled", true)? {
        return Ok(false);
    }
    // 用户添加的桌面筛选和可执行条件不能被当作无条件启动登记。
    if ["OnlyShowIn", "NotShowIn", "TryExec"]
        .iter()
        .any(|key| values.contains_key(key))
    {
        return Err("登录启动条目含系统条件，请在系统启动设置中检查。".to_string());
    }
    Ok(true)
}

fn entry_path() -> Result<PathBuf, String> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .map(|home| home.join(".config"))
        })
        .map(|directory| directory.join("autostart").join(DESKTOP_FILE_NAME))
        .ok_or_else(|| "找不到当前用户的登录启动目录。".to_string())
}

fn launch_target() -> Result<PathBuf, String> {
    if let Some(appimage) = std::env::var_os("APPIMAGE").map(PathBuf::from) {
        if appimage.is_absolute() {
            return Ok(appimage);
        }
    }
    std::env::current_exe().map_err(|_| "无法确定应用位置。".to_string())
}

fn desktop_entry(executable: &Path) -> Result<String, String> {
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName=TokenLedger\n\
         Exec={}\nIcon=tokenledger\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        quote_exec(executable)?
    ))
}

fn quote_exec(executable: &Path) -> Result<String, String> {
    let raw = executable.to_str().ok_or_else(invalid_entry)?;
    if raw.contains(['\0', '\n', '\r']) {
        return Err("程序位置含不可用于登录启动的字符。".to_string());
    }
    let mut quoted = String::from("\"");
    for character in raw.chars() {
        match character {
            '"' | '`' | '$' => {
                quoted.push_str("\\\\");
                quoted.push(character);
            }
            '\\' => quoted.push_str("\\\\\\\\"),
            '%' => quoted.push_str("%%"),
            _ => quoted.push(character),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path() -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "tokenledger-startup-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
            .join(DESKTOP_FILE_NAME)
    }

    #[test]
    fn executable_quoting_handles_desktop_string_and_field_expansion() {
        assert_eq!(
            quote_exec(Path::new("/opt/Token Ledger/app")).unwrap(),
            "\"/opt/Token Ledger/app\""
        );
        assert_eq!(
            quote_exec(Path::new("/opt/a\"b$c`d\\e%f")).unwrap(),
            "\"/opt/a\\\\\"b\\\\$c\\\\`d\\\\\\\\e%%f\""
        );
        assert!(quote_exec(Path::new("/opt/a\nb")).is_err());
    }

    #[test]
    fn unknown_entries_are_distinct_from_disabled_entries() {
        let entry = desktop_entry(Path::new("/opt/tokenledger")).unwrap();
        assert!(entry_enabled(&entry).unwrap());
        assert!(!entry_enabled(&format!("{entry}Hidden=true\n")).unwrap());
        assert!(!entry_enabled(&entry.replace("enabled=true", "enabled=false")).unwrap());
        assert!(entry_enabled(&format!("{entry}Hidden=unknown\n")).is_err());
        assert!(entry_enabled("[Desktop Entry]\nType=Application\n").is_err());
        assert!(entry_enabled(&format!("{entry}OnlyShowIn=GNOME;\n")).is_err());
    }

    #[test]
    fn launch_refresh_preserves_system_disable_and_does_not_recreate_missing_entries() {
        let path = test_path();
        refresh_at(&path, Path::new("/opt/new")).unwrap();
        assert!(!path.exists());
        let disabled = format!(
            "{}Hidden=true\n",
            desktop_entry(Path::new("/opt/old")).unwrap()
        );
        super::super::replace_entry_file(&path, Some(disabled.as_bytes())).unwrap();
        refresh_at(&path, Path::new("/opt/new")).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), disabled);
        assert!(!enabled_at(&path).unwrap());
        super::super::replace_entry_file(&path, None).unwrap();
        super::super::replace_entry_file(&path, None).unwrap();
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn launch_refresh_updates_only_the_executable_and_restore_keeps_original_bytes() {
        let path = test_path();
        let bytes = format!(
            "{}X-Custom=preserved\n",
            desktop_entry(Path::new("/opt/old")).unwrap()
        )
        .into_bytes();
        super::super::replace_entry_file(&path, Some(&bytes)).unwrap();
        let snapshot = Snapshot {
            path: path.clone(),
            bytes: Some(bytes.clone()),
        };
        refresh_at(&path, Path::new("/opt/new path")).unwrap();
        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(updated.contains("Exec=\"/opt/new path\""));
        assert!(updated.contains("X-Custom=preserved"));
        restore(&snapshot).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
