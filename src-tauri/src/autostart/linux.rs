use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

const DESKTOP_FILE_NAME: &str = "com.jeidorf.tokenledger.desktop";

pub(super) struct Snapshot {
    path: PathBuf,
    bytes: Option<Vec<u8>>,
}

pub(super) fn snapshot() -> Result<Snapshot, String> {
    snapshot_at(entry_path()?)
}

fn snapshot_at(path: PathBuf) -> Result<Snapshot, String> {
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
    set_enabled_at(&entry_path()?, enabled, launch_target)
}

/// 关闭时不解析程序位置，避免定位失败挡住删除登记。
fn set_enabled_at(
    path: &Path,
    enabled: bool,
    target: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<(), String> {
    if enabled {
        super::replace_entry_file(path, Some(desktop_entry(&target()?)?.as_bytes()))
    } else {
        super::replace_entry_file(path, None)
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
    entry_path_from(
        std::env::var_os("XDG_CONFIG_HOME"),
        std::env::var_os("HOME"),
    )
}

fn entry_path_from(
    config_home: Option<OsString>,
    home: Option<OsString>,
) -> Result<PathBuf, String> {
    config_home
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            home.map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .map(|home| home.join(".config"))
        })
        .map(|directory| directory.join("autostart").join(DESKTOP_FILE_NAME))
        .ok_or_else(|| "找不到当前用户的登录启动目录。".to_string())
}

fn launch_target() -> Result<PathBuf, String> {
    launch_target_from(std::env::var_os("APPIMAGE"), std::env::current_exe)
}

fn launch_target_from(
    appimage: Option<OsString>,
    current_exe: impl FnOnce() -> std::io::Result<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(appimage) = appimage.map(PathBuf::from) {
        if appimage.is_absolute() {
            return Ok(appimage);
        }
    }
    current_exe().map_err(|_| "无法确定应用位置。".to_string())
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

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    fn target(path: &str) -> impl FnOnce() -> Result<PathBuf, String> + '_ {
        move || Ok(PathBuf::from(path))
    }

    struct FileBackend(PathBuf);

    impl super::super::Backend for FileBackend {
        type Snapshot = Snapshot;
        fn snapshot(&self) -> Result<Snapshot, String> {
            snapshot_at(self.0.clone())
        }
        fn enabled(&self) -> Result<bool, String> {
            enabled_at(&self.0)
        }
        fn set_enabled(&self, enabled: bool) -> Result<(), String> {
            set_enabled_at(&self.0, enabled, target("/opt/Token Ledger/app"))
        }
        fn restore(&self, snapshot: &Snapshot) -> Result<(), String> {
            restore(snapshot)
        }
    }

    #[test]
    fn explicit_enable_writes_a_private_complete_entry_with_quoted_exec() {
        let path = test_path();
        set_enabled_at(&path, true, target("/opt/Token Ledger/a%b$c")).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            desktop_entry(Path::new("/opt/Token Ledger/a%b$c")).unwrap()
        );
        assert!(text.contains("Exec=\"/opt/Token Ledger/a%%b\\\\$c\"\n"));
        assert!(enabled_at(&path).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "登录启动条目不应对其他用户可写或可读");
        }
        cleanup(&path);
    }

    #[test]
    fn explicit_enable_replaces_a_system_disabled_or_user_edited_entry() {
        let path = test_path();
        let disabled = format!(
            "{}Hidden=true\nX-Custom=dropped\n",
            desktop_entry(Path::new("/opt/old")).unwrap()
        );
        super::super::replace_entry_file(&path, Some(disabled.as_bytes())).unwrap();
        assert!(!enabled_at(&path).unwrap());
        set_enabled_at(&path, true, target("/opt/new")).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            desktop_entry(Path::new("/opt/new")).unwrap()
        );
        assert!(enabled_at(&path).unwrap());
        cleanup(&path);
    }

    #[test]
    fn explicit_disable_removes_the_entry_without_resolving_the_executable() {
        let path = test_path();
        set_enabled_at(&path, true, target("/opt/tokenledger")).unwrap();
        let unreachable =
            || -> Result<PathBuf, String> { panic!("关闭时不应解析程序位置") };
        set_enabled_at(&path, false, unreachable).unwrap();
        assert!(!path.exists());
        assert!(!enabled_at(&path).unwrap());
        set_enabled_at(&path, false, unreachable).unwrap();
        assert!(!path.exists());
        cleanup(&path);
    }

    #[test]
    fn unresolvable_or_unsafe_executable_leaves_the_existing_entry_untouched() {
        let path = test_path();
        let original = desktop_entry(Path::new("/opt/old")).unwrap();
        super::super::replace_entry_file(&path, Some(original.as_bytes())).unwrap();
        assert!(set_enabled_at(&path, true, || Err("无法确定应用位置。".into())).is_err());
        assert!(set_enabled_at(&path, true, target("/opt/a\nb")).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        cleanup(&path);
        assert!(set_enabled_at(&path, true, target("/opt/a\rb")).is_err());
        assert!(!path.exists());
        cleanup(&path);
    }

    // 依赖 Unix 符号链接与绝对路径语义，Windows 上的测试构建跳过。
    #[cfg(unix)]
    #[test]
    fn symlinked_entries_are_never_written_through_or_removed() {
        let path = test_path();
        let directory = path.parent().unwrap();
        std::fs::create_dir_all(directory).unwrap();
        let elsewhere = directory.join("elsewhere.desktop");
        std::fs::write(&elsewhere, "keep").unwrap();
        std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
        assert!(enabled_at(&path).is_err());
        assert!(snapshot_at(path.clone()).is_err());
        assert!(set_enabled_at(&path, true, target("/opt/tokenledger")).is_err());
        assert!(set_enabled_at(&path, false, target("/opt/tokenledger")).is_err());
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&elsewhere).unwrap(), "keep");
        cleanup(&path);
    }

    #[test]
    fn failed_preference_save_rolls_back_to_the_exact_prior_entry_state() {
        // 原先没有登记：回滚应删除刚写入的条目。
        let path = test_path();
        let backend = FileBackend(path.clone());
        let error = super::super::transact(&backend, true, || Err::<(), _>("保存设置失败".into()))
            .unwrap_err();
        assert!(error.contains("已恢复"));
        assert!(!path.exists());
        cleanup(&path);

        // 原先是被系统禁用的条目：回滚应逐字节还原，而不是留下新条目或删掉它。
        let path = test_path();
        let backend = FileBackend(path.clone());
        let original = format!(
            "# 用户注释\n{}Hidden=true\n",
            desktop_entry(Path::new("/opt/old")).unwrap()
        )
        .into_bytes();
        super::super::replace_entry_file(&path, Some(&original)).unwrap();
        super::super::transact(&backend, true, || Err::<(), _>("保存设置失败".into())).unwrap_err();
        assert_eq!(std::fs::read(&path).unwrap(), original);

        // 关闭成功后持久化失败：回滚应重新放回原条目。
        set_enabled_at(&path, true, target("/opt/Token Ledger/app")).unwrap();
        let enabled = std::fs::read(&path).unwrap();
        super::super::transact(&backend, false, || Err::<(), _>("保存设置失败".into()))
            .unwrap_err();
        assert_eq!(std::fs::read(&path).unwrap(), enabled);

        // 成功路径：先登记并回读通过，再保存偏好。
        super::super::transact(&backend, false, || {
            assert!(!path.exists());
            Ok(())
        })
        .unwrap();
        super::super::transact(&backend, true, || {
            assert!(enabled_at(&path).unwrap());
            Ok(())
        })
        .unwrap();
        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn entry_path_prefers_absolute_xdg_config_home_and_rejects_relative_roots() {
        let expected = |root: &str| {
            PathBuf::from(root)
                .join("autostart")
                .join(DESKTOP_FILE_NAME)
        };
        assert_eq!(
            entry_path_from(Some("/x/config".into()), Some("/home/u".into())).unwrap(),
            expected("/x/config")
        );
        assert_eq!(
            entry_path_from(Some("relative".into()), Some("/home/u".into())).unwrap(),
            expected("/home/u/.config")
        );
        assert_eq!(
            entry_path_from(None, Some("/home/u".into())).unwrap(),
            expected("/home/u/.config")
        );
        assert!(entry_path_from(Some("relative".into()), Some("also-relative".into())).is_err());
        assert!(entry_path_from(None, None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn launch_target_prefers_an_absolute_appimage_over_the_running_binary() {
        let exe = || Ok(PathBuf::from("/tmp/.mount_x/usr/bin/tokenledger"));
        assert_eq!(
            launch_target_from(Some("/home/u/TokenLedger.AppImage".into()), exe).unwrap(),
            PathBuf::from("/home/u/TokenLedger.AppImage")
        );
        assert_eq!(
            launch_target_from(Some("TokenLedger.AppImage".into()), exe).unwrap(),
            PathBuf::from("/tmp/.mount_x/usr/bin/tokenledger")
        );
        assert_eq!(
            launch_target_from(None, exe).unwrap(),
            PathBuf::from("/tmp/.mount_x/usr/bin/tokenledger")
        );
        assert!(launch_target_from(None, || Err(std::io::Error::other("gone"))).is_err());
    }
}
