#![cfg(windows)]

//! Windows 当前用户登录自启。
//!
//! 只操作 HKCU 的 Run 与 StartupApproved\Run。测试使用内存后端，
//! 不读写真实登录启动项。

use std::io;
use std::path::Path;

use winreg::enums::{
    HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_BINARY, REG_DWORD, REG_DWORD_BIG_ENDIAN,
    REG_EXPAND_SZ, REG_FULL_RESOURCE_DESCRIPTOR, REG_LINK, REG_MULTI_SZ, REG_NONE, REG_QWORD,
    REG_RESOURCE_LIST, REG_RESOURCE_REQUIREMENTS_LIST, REG_SZ,
};
use winreg::{RegKey, RegValue};

const VALUE_NAME: &str = "com.jeidorf.tokenledger";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const MAX_COMMAND_UNITS: usize = 260;
const APPROVAL_LENGTH: usize = 12;

#[derive(Clone, PartialEq, Eq)]
#[cfg_attr(test, derive(Debug))]
pub(super) struct Snapshot {
    run: Option<Value>,
    approved: Option<Value>,
}

#[derive(Clone, PartialEq, Eq)]
#[cfg_attr(test, derive(Debug))]
struct Value {
    vtype: u32,
    bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Slot {
    Run,
    Approved,
}

impl Slot {
    fn label(self) -> &'static str {
        match self {
            Self::Run => "启动项",
            Self::Approved => "启动项状态",
        }
    }
}

pub(super) fn snapshot() -> Result<Snapshot, String> {
    snapshot_with(&RegistryStore::user())
}

pub(super) fn restore(snapshot: &Snapshot) -> Result<(), String> {
    restore_with(&RegistryStore::user(), snapshot)
}

pub(super) fn enabled() -> Result<bool, String> {
    let store = RegistryStore::user();
    let Some(run) = store.read(Slot::Run)? else {
        return Ok(false);
    };
    let executable = std::env::current_exe()
        .map_err(|_| "无法确定程序位置，无法判断登录启动状态。".to_string())?;
    enabled_from_run(&store, &run, &executable)
}

pub(super) fn set_enabled(enabled: bool) -> Result<(), String> {
    let store = RegistryStore::user();
    if !enabled {
        return set_enabled_with(&store, false, None);
    }
    let executable =
        std::env::current_exe().map_err(|_| "无法确定程序位置，未修改登录启动项。".to_string())?;
    set_enabled_with(&store, true, Some(&executable))
}

fn snapshot_with<B: Backend>(store: &B) -> Result<Snapshot, String> {
    Ok(Snapshot {
        run: store.read(Slot::Run)?,
        approved: store.read(Slot::Approved)?,
    })
}

fn restore_with<B: Backend>(store: &B, snapshot: &Snapshot) -> Result<(), String> {
    let run = restore_value(store, Slot::Run, snapshot.run.as_ref());
    let approved = restore_value(store, Slot::Approved, snapshot.approved.as_ref());
    match (run, approved) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(run_error), Err(approved_error)) => Err(format!("{run_error}；{approved_error}")),
    }
}

#[cfg(test)]
fn enabled_with<B: Backend>(store: &B, current_executable: &Path) -> Result<bool, String> {
    let Some(run) = store.read(Slot::Run)? else {
        return Ok(false);
    };
    enabled_from_run(store, &run, current_executable)
}

fn enabled_from_run<B: Backend>(
    store: &B,
    run: &Value,
    current_executable: &Path,
) -> Result<bool, String> {
    if run.vtype == vtype::EXPAND_SZ {
        return Err("启动项使用环境变量路径，无法确认是否启用。".to_string());
    }
    if run.vtype != vtype::SZ {
        return Err("启动项格式未知，无法判断是否启用。".to_string());
    }
    let registered = run_executable(&run.bytes)?;
    let enabled = match store.read(Slot::Approved)? {
        None => true,
        Some(value) => approval_state(&value)?,
    };
    if !enabled {
        return Ok(false);
    }
    if !same_executable_path(&registered, current_executable)? {
        return Err("登录启动项指向其他程序位置，请按当前位置重新启用。".to_string());
    }
    Ok(true)
}

const UNKNOWN_LOCATION: &str = "登录启动项指向无法确认的程序位置，请按当前位置重新启用。";

fn run_executable(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() < 4 || !bytes.len().is_multiple_of(2) {
        return Err("启动项格式未知，无法判断是否启用。".to_string());
    }
    let words = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    let Some((&0, text)) = words.split_last() else {
        return Err("启动项格式未知，无法判断是否启用。".to_string());
    };
    if text.contains(&0) {
        return Err("启动项格式未知，无法判断是否启用。".to_string());
    }
    let Ok(command) = String::from_utf16(text) else {
        return Err("启动项格式未知，无法判断是否启用。".to_string());
    };
    let command = command.trim_matches(|ch: char| ch == ' ' || ch == '\t');
    if command.is_empty()
        || command
            .chars()
            .any(|ch| ch == '\n' || ch == '\r' || ch == '\0')
    {
        return Err("启动项格式未知，无法判断是否启用。".to_string());
    }
    let executable = if let Some(rest) = command.strip_prefix('"') {
        let Some(end) = rest.find('"') else {
            return Err("启动项格式未知，无法判断是否启用。".to_string());
        };
        let executable = &rest[..end];
        let suffix = &rest[end + 1..];
        // 引号后的首个字符必须是空白或参数分隔，不能把紧接的垃圾字符当作命令。
        if suffix
            .chars()
            .next()
            .is_some_and(|ch| ch != ' ' && ch != '\t')
        {
            return Err("启动项格式未知，无法判断是否启用。".to_string());
        }
        executable
    } else {
        command.split_whitespace().next().unwrap_or_default()
    };
    if executable.is_empty()
        || executable.chars().any(|ch| ch.is_control() || ch == '"')
        || !Path::new(executable).is_absolute()
    {
        return Err("启动项格式未知，无法判断是否启用。".to_string());
    }
    Ok(executable.to_string())
}

fn same_executable_path(registered: &str, current: &Path) -> Result<bool, String> {
    let current = current
        .to_str()
        .ok_or_else(|| UNKNOWN_LOCATION.to_string())?;
    let registered = normalize_windows_path(registered)?;
    let current = normalize_windows_path(current)?;
    Ok(registered.eq_ignore_ascii_case(&current))
}

fn normalize_windows_path(path: &str) -> Result<String, String> {
    let path = path.replace('/', "\\");
    let path = if let Some(rest) = path.strip_prefix("\\\\?\\") {
        resolve_extended_path(rest)?
    } else if let Some(rest) = path.strip_prefix("\\??\\") {
        resolve_extended_path(rest)?
    } else if path.starts_with("\\\\.\\") {
        return Err(UNKNOWN_LOCATION.to_string());
    } else {
        path
    };

    if path.is_empty() || path.ends_with('\\') || path.chars().any(|ch| ch.is_control()) {
        return Err(UNKNOWN_LOCATION.to_string());
    }
    if path
        .split('\\')
        .any(|component| component == "." || component == "..")
    {
        return Err(UNKNOWN_LOCATION.to_string());
    }
    let mut normalized = String::with_capacity(path.len());
    for ch in path.chars() {
        // UNC 路径保留开头的两个分隔符，其余连续分隔符合并。
        if ch == '\\' && normalized.ends_with('\\') && normalized.len() != 1 {
            continue;
        }
        normalized.push(ch);
    }
    if !is_absolute_windows_path(&normalized) {
        return Err(UNKNOWN_LOCATION.to_string());
    }
    Ok(normalized)
}

fn resolve_extended_path(rest: &str) -> Result<String, String> {
    if is_windows_drive_path(rest) {
        return Ok(rest.to_string());
    }
    if let Some(unc) = rest.strip_prefix("UNC\\") {
        if !unc.is_empty() {
            return Ok(format!("\\\\{unc}"));
        }
    }
    Err(UNKNOWN_LOCATION.to_string())
}

fn is_windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\'
}

fn is_absolute_windows_path(path: &str) -> bool {
    is_windows_drive_path(path)
        || path
            .strip_prefix("\\\\")
            .is_some_and(|rest| !rest.is_empty() && rest.contains('\\'))
}

fn set_enabled_with<B: Backend>(
    store: &B,
    enabled: bool,
    executable: Option<&Path>,
) -> Result<(), String> {
    if !enabled {
        store.delete(Slot::Approved)?;
        store.delete(Slot::Run)?;
        return Ok(());
    }

    let executable =
        executable.ok_or_else(|| "无法确定程序位置，未修改登录启动项。".to_string())?;
    let command = command_line(executable)?;
    store.write(
        Slot::Run,
        Value {
            vtype: vtype::SZ,
            bytes: utf16_bytes(&command),
        },
    )?;
    store.write(Slot::Approved, enabled_approval())
}

fn restore_value<B: Backend>(store: &B, slot: Slot, value: Option<&Value>) -> Result<(), String> {
    match value {
        Some(value) => store.write(slot, value.clone()),
        None => store.delete(slot),
    }
}

fn approval_state(value: &Value) -> Result<bool, String> {
    if value.vtype != vtype::BINARY {
        return Err("启动项状态格式未知，无法判断是否启用。".to_string());
    }
    if value.bytes.len() != APPROVAL_LENGTH {
        return Err("启动项状态长度未知，无法判断是否启用。".to_string());
    }
    let mut status = [0; 4];
    status.copy_from_slice(&value.bytes[..4]);
    match u32::from_le_bytes(status) {
        2 | 6 => Ok(true),
        3 | 7 => Ok(false),
        _ => Err("启动项状态未知，无法判断是否启用。".to_string()),
    }
}

fn enabled_approval() -> Value {
    let mut bytes = vec![0; APPROVAL_LENGTH];
    bytes[..4].copy_from_slice(&2u32.to_le_bytes());
    Value {
        vtype: vtype::BINARY,
        bytes,
    }
}

fn command_line(executable: &Path) -> Result<String, String> {
    if !executable.is_absolute() {
        return Err("程序路径不是绝对路径，未修改登录启动项。".to_string());
    }
    let raw = executable
        .to_str()
        .ok_or_else(|| "程序路径含无法识别的字符，未修改登录启动项。".to_string())?;
    if raw.is_empty()
        || raw
            .chars()
            .any(|ch| ch == '\0' || ch == '\n' || ch == '\r' || ch == '"')
    {
        return Err("程序路径含不安全字符，未修改登录启动项。".to_string());
    }
    if raw.encode_utf16().count().saturating_add(2) > MAX_COMMAND_UNITS {
        return Err("程序路径过长，未修改登录启动项。".to_string());
    }
    Ok(format!("\"{raw}\""))
}

fn utf16_bytes(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect()
}

trait Backend {
    fn read(&self, slot: Slot) -> Result<Option<Value>, String>;
    fn write(&self, slot: Slot, value: Value) -> Result<(), String>;
    fn delete(&self, slot: Slot) -> Result<(), String>;
}

struct RegistryStore {
    root: RegKey,
    run: String,
    approved: String,
}

impl RegistryStore {
    fn user() -> Self {
        Self {
            root: RegKey::predef(HKEY_CURRENT_USER),
            run: RUN_KEY.to_string(),
            approved: APPROVED_KEY.to_string(),
        }
    }

    fn path(&self, slot: Slot) -> &str {
        match slot {
            Slot::Run => &self.run,
            Slot::Approved => &self.approved,
        }
    }
}

impl Backend for RegistryStore {
    fn read(&self, slot: Slot) -> Result<Option<Value>, String> {
        let action = format!("读取{}", slot.label());
        let key = match self.root.open_subkey_with_flags(self.path(slot), KEY_READ) {
            Ok(key) => key,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(registry_error(&action, &error)),
        };
        match key.get_raw_value(VALUE_NAME) {
            Ok(value) => Ok(Some(Value {
                vtype: value.vtype as u32,
                bytes: value.bytes,
            })),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(registry_error(&action, &error)),
        }
    }

    fn write(&self, slot: Slot, value: Value) -> Result<(), String> {
        let action = format!("写入{}", slot.label());
        let (key, _) = self
            .root
            .create_subkey_with_flags(self.path(slot), KEY_READ | KEY_WRITE)
            .map_err(|error| registry_error(&action, &error))?;
        key.set_raw_value(
            VALUE_NAME,
            &RegValue {
                vtype: to_reg_type(value.vtype)?,
                bytes: value.bytes,
            },
        )
        .map_err(|error| registry_error(&action, &error))
    }

    fn delete(&self, slot: Slot) -> Result<(), String> {
        let action = format!("移除{}", slot.label());
        let key = match self
            .root
            .open_subkey_with_flags(self.path(slot), KEY_READ | KEY_WRITE)
        {
            Ok(key) => key,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(registry_error(&action, &error)),
        };
        match key.delete_value(VALUE_NAME) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(registry_error(&action, &error)),
        }
    }
}

fn to_reg_type(raw_type: u32) -> Result<winreg::enums::RegType, String> {
    match raw_type {
        vtype::NONE => Ok(REG_NONE),
        vtype::SZ => Ok(REG_SZ),
        vtype::EXPAND_SZ => Ok(REG_EXPAND_SZ),
        vtype::BINARY => Ok(REG_BINARY),
        vtype::DWORD => Ok(REG_DWORD),
        vtype::DWORD_BIG_ENDIAN => Ok(REG_DWORD_BIG_ENDIAN),
        vtype::LINK => Ok(REG_LINK),
        vtype::MULTI_SZ => Ok(REG_MULTI_SZ),
        vtype::RESOURCE_LIST => Ok(REG_RESOURCE_LIST),
        vtype::FULL_RESOURCE_DESCRIPTOR => Ok(REG_FULL_RESOURCE_DESCRIPTOR),
        vtype::RESOURCE_REQUIREMENTS_LIST => Ok(REG_RESOURCE_REQUIREMENTS_LIST),
        vtype::QWORD => Ok(REG_QWORD),
        _ => Err("启动项原值类型未知，无法恢复。".to_string()),
    }
}

fn registry_error(action: &str, error: &io::Error) -> String {
    match error.kind() {
        io::ErrorKind::PermissionDenied => format!("{action}失败：没有权限。"),
        io::ErrorKind::NotFound => format!("{action}失败：目标不存在。"),
        io::ErrorKind::InvalidData => format!("{action}失败：数据格式不受支持。"),
        _ => format!("{action}失败：系统拒绝该操作。"),
    }
}

mod vtype {
    pub(super) const NONE: u32 = 0;
    pub(super) const SZ: u32 = 1;
    pub(super) const EXPAND_SZ: u32 = 2;
    pub(super) const BINARY: u32 = 3;
    pub(super) const DWORD: u32 = 4;
    pub(super) const DWORD_BIG_ENDIAN: u32 = 5;
    pub(super) const LINK: u32 = 6;
    pub(super) const MULTI_SZ: u32 = 7;
    pub(super) const RESOURCE_LIST: u32 = 8;
    pub(super) const FULL_RESOURCE_DESCRIPTOR: u32 = 9;
    pub(super) const RESOURCE_REQUIREMENTS_LIST: u32 = 10;
    pub(super) const QWORD: u32 = 11;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::PathBuf;

    #[derive(Default)]
    struct FakeState {
        run: Option<Value>,
        approved: Option<Value>,
        fail_read: bool,
        fail_run_write: bool,
        fail_approved_write: bool,
    }

    #[derive(Default)]
    struct FakeStore {
        state: RefCell<FakeState>,
    }

    impl FakeStore {
        fn with_values(run: Option<Value>, approved: Option<Value>) -> Self {
            Self {
                state: RefCell::new(FakeState {
                    run,
                    approved,
                    fail_read: false,
                    fail_run_write: false,
                    fail_approved_write: false,
                }),
            }
        }

        fn failing_read() -> Self {
            Self {
                state: RefCell::new(FakeState {
                    fail_read: true,
                    ..FakeState::default()
                }),
            }
        }

        fn values(&self) -> (Option<Value>, Option<Value>) {
            let state = self.state.borrow();
            (state.run.clone(), state.approved.clone())
        }
    }

    impl Backend for FakeStore {
        fn read(&self, slot: Slot) -> Result<Option<Value>, String> {
            let state = self.state.borrow();
            if state.fail_read {
                return Err("读取启动项失败：模拟错误。".to_string());
            }
            Ok(match slot {
                Slot::Run => state.run.clone(),
                Slot::Approved => state.approved.clone(),
            })
        }

        fn write(&self, slot: Slot, value: Value) -> Result<(), String> {
            let mut state = self.state.borrow_mut();
            if slot == Slot::Run && state.fail_run_write {
                return Err("写入启动项失败：模拟错误。".to_string());
            }
            if slot == Slot::Approved && state.fail_approved_write {
                return Err("写入启动项状态失败：模拟错误。".to_string());
            }
            match slot {
                Slot::Run => state.run = Some(value),
                Slot::Approved => state.approved = Some(value),
            }
            Ok(())
        }

        fn delete(&self, slot: Slot) -> Result<(), String> {
            let mut state = self.state.borrow_mut();
            match slot {
                Slot::Run => state.run = None,
                Slot::Approved => state.approved = None,
            }
            Ok(())
        }
    }

    fn text(value: &str) -> Value {
        Value {
            vtype: vtype::SZ,
            bytes: utf16_bytes(value),
        }
    }

    fn approval(status: u32) -> Value {
        let mut bytes = vec![0xAA; APPROVAL_LENGTH];
        bytes[..4].copy_from_slice(&status.to_le_bytes());
        Value {
            vtype: vtype::BINARY,
            bytes,
        }
    }

    fn raw_text(text: &str) -> Value {
        Value {
            vtype: vtype::SZ,
            bytes: utf16_bytes(text),
        }
    }

    fn current(path: &str) -> PathBuf {
        PathBuf::from(path)
    }

    #[test]
    fn command_line_quotes_spaces_and_unicode_without_arguments() {
        let path = PathBuf::from(r"C:\Users\测试 用户\Token Ledger\tokenledger.exe");
        assert_eq!(
            command_line(&path).unwrap(),
            r#""C:\Users\测试 用户\Token Ledger\tokenledger.exe""#
        );
    }

    #[test]
    fn command_line_rejects_unsafe_relative_and_oversized_paths() {
        assert!(command_line(Path::new("relative.exe")).is_err());
        assert!(command_line(Path::new("C:\\a\"b.exe")).is_err());
        assert!(command_line(Path::new("C:\\a\nb.exe")).is_err());
        assert!(command_line(Path::new("C:\\a\rb.exe")).is_err());
        assert!(command_line(Path::new("C:\\a\0b.exe")).is_err());
        let long = format!("C:\\{}", "a".repeat(MAX_COMMAND_UNITS));
        assert!(command_line(Path::new(&long)).is_err());
    }

    #[test]
    fn missing_run_is_disabled_and_missing_approval_is_enabled() {
        let executable = current(r"C:\TokenLedger.exe");
        assert!(!enabled_with(&FakeStore::default(), &executable).unwrap());
        let store = FakeStore::with_values(Some(text(r#""C:\TokenLedger.exe""#)), None);
        assert!(enabled_with(&store, &executable).unwrap());
    }

    #[test]
    fn moved_executable_is_not_reported_as_enabled() {
        let store = FakeStore::with_values(
            Some(text(r#""C:\Old Place\TokenLedger.exe""#)),
            Some(approval(2)),
        );
        let before = snapshot_with(&store).unwrap();
        let error = enabled_with(&store, &current(r"C:\New Place\TokenLedger.exe")).unwrap_err();
        assert!(error.contains("其他程序位置"));
        assert_eq!(snapshot_with(&store).unwrap(), before);
    }

    #[test]
    fn known_approval_states_are_decoded() {
        let run = Some(text(r#""C:\TokenLedger.exe""#));
        let executable = current(r"C:\TokenLedger.exe");
        for (status, expected) in [(2, true), (6, true), (3, false), (7, false)] {
            let store = FakeStore::with_values(run.clone(), Some(approval(status)));
            assert_eq!(
                enabled_with(&store, &executable).unwrap(),
                expected,
                "status {status}"
            );
        }
    }

    #[test]
    fn unknown_or_badly_sized_approval_is_an_error_not_enabled() {
        let run = Some(text(r#""C:\TokenLedger.exe""#));
        let executable = current(r"C:\TokenLedger.exe");
        for status in [0, 1, 4, 5, 8, 99] {
            let store = FakeStore::with_values(run.clone(), Some(approval(status)));
            assert!(
                enabled_with(&store, &executable).is_err(),
                "status {status}"
            );
        }
        let mut short = approval(2);
        short.bytes.pop();
        let store = FakeStore::with_values(run.clone(), Some(short));
        assert!(enabled_with(&store, &executable).is_err());

        let mut wrong_type = approval(2);
        wrong_type.vtype = vtype::SZ;
        let store = FakeStore::with_values(run, Some(wrong_type));
        assert!(enabled_with(&store, &executable).is_err());
    }

    #[test]
    fn wrong_run_type_and_read_errors_are_not_treated_as_disabled() {
        let wrong_run = Value {
            vtype: vtype::BINARY,
            bytes: vec![1],
        };
        let store = FakeStore::with_values(Some(wrong_run), None);
        assert!(enabled_with(&store, &current(r"C:\TokenLedger.exe")).is_err());

        let store = FakeStore::failing_read();
        assert!(enabled_with(&store, &current(r"C:\TokenLedger.exe")).is_err());
        assert!(snapshot_with(&store).is_err());
    }

    #[test]
    fn run_value_must_contain_a_valid_non_empty_command() {
        let invalid = [
            Value {
                vtype: vtype::SZ,
                bytes: Vec::new(),
            },
            Value {
                vtype: vtype::SZ,
                bytes: vec![0],
            },
            Value {
                vtype: vtype::SZ,
                bytes: utf16_bytes(""),
            },
            Value {
                vtype: vtype::SZ,
                bytes: utf16_bytes("   \t"),
            },
            Value {
                vtype: vtype::SZ,
                bytes: utf16_bytes("\0"),
            },
            Value {
                vtype: vtype::SZ,
                bytes: vec![0x41, 0x00, 0x00, 0x00],
            },
            Value {
                vtype: vtype::SZ,
                bytes: vec![0x00, 0xD8, 0x00, 0x00],
            },
            Value {
                vtype: vtype::SZ,
                bytes: utf16_bytes("\"C:\\program files\\x.exe"),
            },
            Value {
                vtype: vtype::SZ,
                bytes: utf16_bytes("C:\\a\nb.exe"),
            },
            Value {
                vtype: vtype::SZ,
                bytes: utf16_bytes(r#""""#),
            },
            Value {
                vtype: vtype::SZ,
                bytes: utf16_bytes(r#""   ""#),
            },
            Value {
                vtype: vtype::SZ,
                bytes: utf16_bytes(r#""C:\TokenLedger.exe"garbage"#),
            },
        ];
        for value in invalid {
            let store = FakeStore::with_values(Some(value), None);
            assert!(enabled_with(&store, &current(r"C:\TokenLedger.exe")).is_err());
        }

        let valid = [
            (raw_text(r#"C:\TokenLedger.exe"#), r"C:\TokenLedger.exe"),
            (
                raw_text(r#""C:\Program Files\TokenLedger.exe""#),
                r"C:\Program Files\TokenLedger.exe",
            ),
            (
                raw_text(r#""C:\Token Ledger\tokenledger.exe" --minimized"#),
                r"C:\Token Ledger\tokenledger.exe",
            ),
        ];
        for (value, executable) in valid {
            let store = FakeStore::with_values(Some(value), None);
            assert!(enabled_with(&store, Path::new(executable)).unwrap());
        }
    }

    #[test]
    fn equivalent_windows_paths_are_enabled() {
        let cases = [
            (
                r#""C:\Program Files\测试 应用\TokenLedger.exe""#,
                r"c:/program files/测试 应用/tokenledger.exe",
            ),
            (
                r#""\\?\C:\Program Files\测试 应用\TokenLedger.exe""#,
                r#"C:\\Program Files\\测试 应用\\TokenLedger.exe"#,
            ),
            (
                r#""\\?\UNC\server\share\TokenLedger.exe""#,
                r"\\server\share\TokenLedger.exe",
            ),
        ];
        for (registered, executable) in cases {
            let store = FakeStore::with_values(Some(text(registered)), Some(approval(2)));
            assert!(
                enabled_with(&store, Path::new(executable)).unwrap(),
                "{registered}"
            );
        }
    }

    #[test]
    fn device_aliases_and_parent_components_are_not_assumed_equivalent() {
        let registered = text(r#""\\.\C:\TokenLedger.exe""#);
        let store = FakeStore::with_values(Some(registered), Some(approval(2)));
        assert!(enabled_with(&store, Path::new(r"C:\TokenLedger.exe")).is_err());

        let registered = text(r#""C:\Other\..\TokenLedger.exe""#);
        let store = FakeStore::with_values(Some(registered), Some(approval(2)));
        assert!(enabled_with(&store, Path::new(r"C:\TokenLedger.exe")).is_err());

        let registered = text(r#""C:\TokenLedger.exe\""#);
        let store = FakeStore::with_values(Some(registered), Some(approval(2)));
        assert!(enabled_with(&store, Path::new(r"C:\TokenLedger.exe")).is_err());
    }

    #[test]
    fn explicit_reenable_replaces_a_stale_location() {
        let store = FakeStore::with_values(
            Some(text(r#""C:\Old Place\TokenLedger.exe""#)),
            Some(approval(2)),
        );
        let executable = current(r"C:\New Place\TokenLedger.exe");
        assert!(enabled_with(&store, &executable).is_err());

        set_enabled_with(&store, true, Some(&executable)).unwrap();
        assert!(enabled_with(&store, &executable).unwrap());
        assert_eq!(
            store.values().0,
            Some(text(r#""C:\New Place\TokenLedger.exe""#))
        );
    }

    #[test]
    fn disabled_approval_remains_disabled_even_at_a_stale_location() {
        let store = FakeStore::with_values(
            Some(text(r#""C:\Old Place\TokenLedger.exe""#)),
            Some(approval(3)),
        );
        assert!(!enabled_with(&store, &current(r"C:\New Place\TokenLedger.exe")).unwrap());
    }

    #[test]
    fn expand_string_cannot_be_confirmed_as_enabled() {
        let mut value = text(r#""%LOCALAPPDATA%\Token Ledger\tokenledger.exe""#);
        value.vtype = vtype::EXPAND_SZ;
        let store = FakeStore::with_values(Some(value), None);
        assert!(enabled_with(&store, &current(r"C:\TokenLedger.exe")).is_err());
    }

    #[test]
    fn enable_and_disable_only_touch_the_two_application_values() {
        let store = FakeStore::default();
        let executable = PathBuf::from(r"C:\Program Files\Token Ledger\tokenledger.exe");
        set_enabled_with(&store, true, Some(&executable)).unwrap();
        let (run, approved) = store.values();
        assert_eq!(
            run,
            Some(text(r#""C:\Program Files\Token Ledger\tokenledger.exe""#))
        );
        assert_eq!(approved, Some(enabled_approval()));
        assert!(enabled_with(&store, &executable).unwrap());

        set_enabled_with(&store, false, None).unwrap();
        set_enabled_with(&store, false, None).unwrap();
        assert_eq!(store.values(), (None, None));
        assert!(!enabled_with(&store, &executable).unwrap());
    }

    #[test]
    fn snapshot_restores_exact_type_and_bytes_or_missing_values() {
        let original_run = Value {
            vtype: vtype::EXPAND_SZ,
            bytes: vec![0x41, 0x00, 0x42, 0x00, 0x00, 0x00],
        };
        let original_approved = Value {
            vtype: vtype::BINARY,
            bytes: (0..APPROVAL_LENGTH).map(|index| index as u8).collect(),
        };
        let store =
            FakeStore::with_values(Some(original_run.clone()), Some(original_approved.clone()));

        let saved = snapshot_with(&store).unwrap();
        set_enabled_with(
            &store,
            true,
            Some(Path::new(r"C:\New Place\TokenLedger.exe")),
        )
        .unwrap();
        assert_ne!(
            store.values(),
            (Some(original_run.clone()), Some(original_approved.clone()))
        );

        restore_with(&store, &saved).unwrap();
        assert_eq!(
            store.values(),
            (Some(original_run), Some(original_approved))
        );

        restore_with(
            &store,
            &Snapshot {
                run: None,
                approved: None,
            },
        )
        .unwrap();
        assert_eq!(store.values(), (None, None));
        assert_eq!(
            snapshot_with(&store).unwrap(),
            Snapshot {
                run: None,
                approved: None,
            }
        );
    }

    #[test]
    fn partial_restore_still_attempts_the_other_value_and_reports_failure() {
        let store = FakeStore::with_values(Some(text(r#""C:\Original.exe""#)), Some(approval(2)));
        store.state.borrow_mut().fail_run_write = true;
        let saved = Snapshot {
            run: Some(text(r#""C:\Original.exe""#)),
            approved: Some(approval(7)),
        };

        let error = restore_with(&store, &saved).unwrap_err();
        assert!(error.contains("启动项"));
        assert_eq!(store.values().1, Some(approval(7)));

        let store = FakeStore::default();
        {
            let mut state = store.state.borrow_mut();
            state.fail_run_write = true;
            state.fail_approved_write = true;
        }
        let error = restore_with(&store, &saved).unwrap_err();
        assert!(error.contains("启动项"));
        assert!(error.contains("启动项状态"));
        assert!(store.state.borrow().fail_approved_write);
    }
}
