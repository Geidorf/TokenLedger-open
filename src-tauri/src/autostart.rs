//! 当前用户的登录启动登记与可回滚的设置操作。

use serde::Serialize;
use std::sync::Mutex;

#[cfg(any(target_os = "linux", test))]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

static OPERATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
pub struct Status {
    pub supported: bool,
    pub enabled: Option<bool>,
    pub error: Option<String>,
}

pub fn supported() -> bool {
    cfg!(any(windows, target_os = "macos", target_os = "linux"))
}

pub fn status() -> Status {
    let result = OPERATION_LOCK
        .lock()
        .map_err(|_| "无法读取登录启动状态，请重试。".to_string())
        .and_then(|_guard| platform::enabled());
    match result {
        Ok(enabled) => Status {
            supported: supported(),
            enabled: supported().then_some(enabled),
            error: None,
        },
        Err(error) => Status {
            supported: supported(),
            enabled: None,
            error: Some(error),
        },
    }
}

pub fn change_with_persistence<T>(
    enabled: bool,
    persist: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = OPERATION_LOCK
        .lock()
        .map_err(|_| "登录启动操作暂不可用，请重试。".to_string())?;
    transact(&SystemBackend, enabled, persist)
}

trait Backend {
    type Snapshot;
    fn snapshot(&self) -> Result<Self::Snapshot, String>;
    fn enabled(&self) -> Result<bool, String>;
    fn set_enabled(&self, enabled: bool) -> Result<(), String>;
    fn restore(&self, snapshot: &Self::Snapshot) -> Result<(), String>;
}

struct SystemBackend;

impl Backend for SystemBackend {
    type Snapshot = platform::Snapshot;
    fn snapshot(&self) -> Result<Self::Snapshot, String> {
        platform::snapshot()
    }
    fn enabled(&self) -> Result<bool, String> {
        platform::enabled()
    }
    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        platform::set_enabled(enabled)
    }
    fn restore(&self, snapshot: &Self::Snapshot) -> Result<(), String> {
        platform::restore(snapshot)
    }
}

fn transact<B: Backend, T>(
    backend: &B,
    enabled: bool,
    persist: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let snapshot = backend.snapshot()?;
    let result = (|| {
        backend.set_enabled(enabled)?;
        if backend.enabled()? != enabled {
            return Err("系统未接受登录启动设置，请检查系统启动项权限。".to_string());
        }
        persist()
    })();
    match result {
        Ok(value) => Ok(value),
        Err(error) => match backend.restore(&snapshot) {
            Ok(()) => Err(format!("{error} 已恢复原登录启动登记。")),
            Err(_) => Err(format!(
                "{error} 恢复原登录启动登记也失败，请在系统设置中核对后重试。"
            )),
        },
    }
}

/// 仅刷新仍有效的既有 Linux 条目，不按历史偏好重新登记。
pub fn sync_on_launch(saved_enabled: bool) {
    #[cfg(target_os = "linux")]
    if saved_enabled {
        let result = OPERATION_LOCK
            .lock()
            .map_err(|_| "登录启动状态暂不可用。".to_string())
            .and_then(|_guard| linux::refresh_existing());
        if let Err(error) = result {
            log::warn!("登录启动位置更新失败：{error}");
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = saved_enabled;
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn entry_location(path: &std::path::Path) -> Result<(&std::path::Path, &str), String> {
    path.parent()
        .zip(path.file_name().and_then(|name| name.to_str()))
        .ok_or_else(|| "无法定位本应用的登录启动条目。".to_string())
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn read_entry_file(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    let (directory, name) = entry_location(path)?;
    crate::quota::read_private_app_data_file(directory, name, 64 * 1024)
        .map_err(|_| "无法读取登录启动条目，请检查文件权限与格式。".to_string())
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn replace_entry_file(path: &std::path::Path, bytes: Option<&[u8]>) -> Result<(), String> {
    let (directory, name) = entry_location(path)?;
    // 删除前也检查，避免把非普通文件或符号链接当作本应用登记。
    let existing = read_entry_file(path)?;
    if bytes.is_none() && existing.is_none() {
        return Ok(());
    }
    match bytes {
        Some(bytes) => crate::quota::write_private_app_data_file(directory, name, bytes),
        None => crate::quota::remove_private_app_data_file_checked(directory, name),
    }
    .map_err(|_| "无法更新登录启动条目，请检查文件权限。".to_string())
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod platform {
    pub struct Snapshot;
    pub fn snapshot() -> Result<Snapshot, String> {
        Err("此平台暂不支持应用内登录启动。".to_string())
    }
    pub fn enabled() -> Result<bool, String> {
        Ok(false)
    }
    pub fn set_enabled(_: bool) -> Result<(), String> {
        Err("此平台暂不支持应用内登录启动。".to_string())
    }
    pub fn restore(_: &Snapshot) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Clone, Debug, PartialEq)]
    struct Registration {
        enabled: bool,
        original_bytes: Vec<u8>,
    }

    struct Fake {
        state: RefCell<Registration>,
        fail_snapshot: bool,
        fail_apply: bool,
        fail_readback: bool,
        ignore_apply: bool,
        fail_restore: bool,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                state: RefCell::new(Registration {
                    enabled: false,
                    original_bytes: vec![8, 0, 13, 7],
                }),
                fail_snapshot: false,
                fail_apply: false,
                fail_readback: false,
                ignore_apply: false,
                fail_restore: false,
            }
        }
    }

    impl Backend for Fake {
        type Snapshot = Registration;
        fn snapshot(&self) -> Result<Registration, String> {
            if self.fail_snapshot {
                Err("无法读取登记".into())
            } else {
                Ok(self.state.borrow().clone())
            }
        }
        fn enabled(&self) -> Result<bool, String> {
            if self.fail_readback {
                Err("无法回读登记".into())
            } else {
                Ok(self.state.borrow().enabled)
            }
        }
        fn set_enabled(&self, enabled: bool) -> Result<(), String> {
            if !self.ignore_apply {
                *self.state.borrow_mut() = Registration {
                    enabled,
                    original_bytes: vec![2],
                };
            }
            if self.fail_apply {
                Err("登记失败".into())
            } else {
                Ok(())
            }
        }
        fn restore(&self, snapshot: &Registration) -> Result<(), String> {
            if self.fail_restore {
                Err("回滚失败".into())
            } else {
                *self.state.borrow_mut() = snapshot.clone();
                Ok(())
            }
        }
    }

    #[test]
    fn successful_toggle_persists_only_after_system_readback() {
        let backend = Fake::new();
        let result = transact(&backend, true, || {
            assert!(backend.state.borrow().enabled);
            Ok(42)
        });
        assert_eq!(result.unwrap(), 42);
        transact(&backend, false, || Ok(())).unwrap();
        assert!(!backend.state.borrow().enabled);
    }

    #[test]
    fn failed_settings_save_restores_the_full_registration() {
        let backend = Fake::new();
        let original = backend.state.borrow().clone();
        let error = transact(&backend, true, || Err::<(), _>("保存设置失败".into())).unwrap_err();
        assert!(error.contains("已恢复"));
        assert_eq!(*backend.state.borrow(), original);
    }

    #[test]
    fn registration_and_readback_failures_never_persist_preferences() {
        for failure in 0..4 {
            let mut backend = Fake::new();
            backend.fail_snapshot = failure == 0;
            backend.fail_apply = failure == 1;
            backend.fail_readback = failure == 2;
            backend.ignore_apply = failure == 3;
            let original = backend.state.borrow().clone();
            let persist = || -> Result<(), String> { panic!("系统失败后不得保存偏好") };
            assert!(transact(&backend, true, persist).is_err());
            assert_eq!(*backend.state.borrow(), original);
        }
    }

    #[test]
    fn failed_rollback_is_reported_instead_of_claiming_recovery() {
        let mut backend = Fake::new();
        backend.fail_restore = true;
        let error = transact(&backend, true, || Err::<(), _>("保存设置失败".into())).unwrap_err();
        assert!(error.contains("恢复原登录启动登记也失败"));
        assert!(!error.contains("已恢复"));
    }
}
