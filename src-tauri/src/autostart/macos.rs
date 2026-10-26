//! macOS 当前用户登录自启。
//!
//! macOS 13+ 使用 `SMAppService.mainAppService`；旧系统使用当前用户的
//! LaunchAgent。测试只覆盖纯解析与隔离文件动作，不写真实登录启动项。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use objc::{sel, sel_impl};

const LABEL: &str = "com.jeidorf.tokenledger";
const PLIST_NAME: &str = "com.jeidorf.tokenledger.plist";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_COMMAND_OUTPUT: usize = 64 * 1024;

#[link(name = "ServiceManagement", kind = "framework")]
extern "C" {}

pub(super) struct Snapshot {
    state: Registration,
}

enum Registration {
    Native {
        status: isize,
    },
    Legacy {
        path: PathBuf,
        bytes: Option<Vec<u8>>,
        override_state: OverrideState,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OverrideState {
    None,
    Disabled,
    Enabled,
}

pub(super) fn snapshot() -> Result<Snapshot, String> {
    let state = match native_service()? {
        Some(service) => Registration::Native {
            status: service_status(&service)?,
        },
        None => {
            let path = entry_path()?;
            let bytes = super::read_entry_file(&path)?;
            let output = run_checked(
                "/bin/launchctl",
                &["print-disabled", &format!("gui/{}", current_uid()?)],
            )?;
            let output = String::from_utf8(output.stdout)
                .map_err(|_| "系统启动项覆盖信息格式未知。".to_string())?;
            let override_state = parse_print_disabled(&output)?;
            Registration::Legacy {
                path,
                bytes,
                override_state,
            }
        }
    };
    Ok(Snapshot { state })
}

pub(super) fn restore(snapshot: &Snapshot) -> Result<(), String> {
    match &snapshot.state {
        Registration::Native { status } => restore_native(*status),
        Registration::Legacy {
            path,
            bytes,
            override_state,
        } => restore_legacy(path, bytes.as_deref(), *override_state),
    }
}

pub(super) fn enabled() -> Result<bool, String> {
    match native_service()? {
        Some(service) => {
            let status = service_status(&service)?;
            native_enabled(status)
        }
        None => enabled_legacy(),
    }
}

pub(super) fn set_enabled(enabled: bool) -> Result<(), String> {
    match native_service()? {
        Some(service) if enabled => enable_native(&service),
        Some(service) => disable_native(&service),
        None if enabled => enable_legacy(),
        None => disable_legacy(),
    }
}

fn native_enabled(status: isize) -> Result<bool, String> {
    match status {
        0 | 2 => Ok(false),
        1 => Ok(true),
        3 => Err("系统后台项目状态未知，无法判断登录启动是否启用。".to_string()),
        _ => Err("系统后台项目返回未知状态，无法判断登录启动是否启用。".to_string()),
    }
}

fn enable_native(service: &ReferenceService) -> Result<(), String> {
    match service_status(service)? {
        1 => Ok(()),
        0 => {
            register_native(service)?;
            check_native_status(service, 1)
        }
        2 => Err(
            "系统已阻止本应用的登录启动，请在“系统设置 > 通用 > 登录项与扩展”中允许。".to_string(),
        ),
        3 => Err("系统后台项目登记不可用，无法开启登录启动。".to_string()),
        _ => Err("系统后台项目返回未知状态，无法开启登录启动。".to_string()),
    }
}

fn disable_native(service: &ReferenceService) -> Result<(), String> {
    match service_status(service)? {
        0 => Ok(()),
        1 | 2 => {
            unregister_native(service)?;
            check_native_status(service, 0)
        }
        3 => Err("系统后台项目登记不可用，无法关闭登录启动。".to_string()),
        _ => Err("系统后台项目返回未知状态，无法关闭登录启动。".to_string()),
    }
}

fn restore_native(original: isize) -> Result<(), String> {
    let Some(service) = native_service()? else {
        return Err("系统后台项目接口已不可用，无法恢复原登录启动状态。".to_string());
    };
    let current = service_status(&service)?;
    if current == original {
        return Ok(());
    }
    match (original, current) {
        (0, 1 | 2) => {
            unregister_native(&service)?;
            check_native_status(&service, 0)
        }
        (1, 0) => {
            register_native(&service)?;
            check_native_status(&service, 1)
        }
        (2, _) => Err(
            "系统授权状态无法精确恢复，请在“系统设置 > 通用 > 登录项与扩展”中检查。".to_string(),
        ),
        _ => Err("系统后台项目当前状态与原登记不一致，无法精确恢复。".to_string()),
    }
}

fn enable_legacy() -> Result<(), String> {
    let path = entry_path()?;
    super::read_entry_file(&path)?;
    let override_state = parse_print_disabled(&print_disabled()?)?;
    super::replace_entry_file(&path, Some(plist_bytes()?.as_slice()))?;
    if override_state == OverrideState::Disabled {
        set_legacy_override(true)?;
    }
    Ok(())
}

fn disable_legacy() -> Result<(), String> {
    let path = entry_path()?;
    super::replace_entry_file(&path, None)
}

fn enabled_legacy() -> Result<bool, String> {
    let path = entry_path()?;
    let Some(bytes) = super::read_entry_file(&path)? else {
        return Ok(false);
    };
    let entry = parse_plist(&bytes)?;
    legacy_entry_enabled(&entry, parse_print_disabled(&print_disabled()?)?)
}

fn legacy_entry_enabled(
    entry: &plist::Dictionary,
    override_state: OverrideState,
) -> Result<bool, String> {
    let disabled = match entry.get("Disabled") {
        None => false,
        Some(plist::Value::Boolean(disabled)) => *disabled,
        Some(_) => return Err("登录启动条目的禁用状态格式未知。".to_string()),
    };
    Ok(match override_state {
        OverrideState::None => !disabled,
        OverrideState::Enabled => true,
        OverrideState::Disabled => false,
    })
}

fn restore_legacy(
    path: &Path,
    bytes: Option<&[u8]>,
    original_override: OverrideState,
) -> Result<(), String> {
    restore_legacy_with(
        || super::replace_entry_file(path, bytes),
        || {
            let current_override = parse_print_disabled(&print_disabled()?)?;
            if let Some(enabled) = restore_override_action(original_override, current_override)? {
                set_legacy_override(enabled)?;
                confirm_legacy_override(original_override)?;
            }
            Ok(())
        },
    )
}

fn restore_legacy_with(
    restore_file: impl FnOnce() -> Result<(), String>,
    restore_override: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let file_result = restore_file();
    // 文件和系统覆盖独立恢复，前一路失败不能阻止后一路回滚。
    let override_result = restore_override();
    match (file_result, override_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(format!("登录启动文件恢复失败：{error}")),
        (Ok(()), Err(error)) => Err(format!("系统禁用覆盖恢复失败：{error}")),
        (Err(file_error), Err(override_error)) => Err(format!(
            "登录启动文件恢复失败：{file_error}；系统禁用覆盖恢复失败：{override_error}"
        )),
    }
}

fn restore_override_action(
    original: OverrideState,
    current: OverrideState,
) -> Result<Option<bool>, String> {
    if original == current {
        return Ok(None);
    }
    match (original, current) {
        (OverrideState::Enabled, OverrideState::Disabled) => Ok(Some(true)),
        (OverrideState::Disabled, OverrideState::Enabled) => Ok(Some(false)),
        (OverrideState::None, _) => Err("原本没有覆盖，无法精确移除后来写入的覆盖。".to_string()),
        _ => Err("无法精确恢复系统禁用覆盖。".to_string()),
    }
}

fn confirm_legacy_override(expected: OverrideState) -> Result<(), String> {
    if parse_print_disabled(&print_disabled()?)? == expected {
        return Ok(());
    }
    Err("系统未接受登录启动覆盖恢复。".to_string())
}

fn set_legacy_override(enabled: bool) -> Result<(), String> {
    let target = format!("gui/{}/{LABEL}", current_uid()?);
    run_checked(
        "/bin/launchctl",
        &[if enabled { "enable" } else { "disable" }, &target],
    )?;
    Ok(())
}

fn print_disabled() -> Result<String, String> {
    let uid = current_uid()?;
    let output = run_checked("/bin/launchctl", &["print-disabled", &format!("gui/{uid}")])?;
    String::from_utf8(output.stdout).map_err(|_| "系统启动项覆盖信息格式未知。".to_string())
}

fn parse_print_disabled(output: &str) -> Result<OverrideState, String> {
    let mut in_block = false;
    let mut saw_close = false;
    let mut found = None;
    for line in output.lines() {
        let line = line.trim();
        if !in_block {
            if line == "disabled = {"
                || line == "disabled services = {"
                || line == "disabled_services = {"
            {
                in_block = true;
            }
            continue;
        }
        if line == "}" {
            saw_close = true;
            in_block = false;
            continue;
        }
        if line.is_empty() {
            continue;
        }
        let Some(value) = line.strip_prefix('"') else {
            return Err("系统启动项覆盖信息格式未知。".to_string());
        };
        let Some(end_quote) = value.find('"') else {
            return Err("系统启动项覆盖信息格式未知。".to_string());
        };
        let (key, rest) = value.split_at(end_quote);
        let rest = rest[1..].trim();
        let Some(value) = rest
            .strip_prefix("=>")
            .or_else(|| rest.strip_prefix('='))
            .map(str::trim)
        else {
            return Err("系统启动项覆盖信息格式未知。".to_string());
        };
        let value = value.trim_end_matches([',', ';']).trim();
        let state = match value {
            "true" => OverrideState::Disabled,
            "false" => OverrideState::Enabled,
            _ => return Err("系统启动项覆盖信息格式未知。".to_string()),
        };
        if key != LABEL {
            continue;
        }
        if found.replace(state).is_some() {
            return Err("系统启动项覆盖信息存在冲突。".to_string());
        }
    }
    if !saw_close || in_block {
        return Err("系统启动项覆盖信息格式未知。".to_string());
    }
    Ok(found.unwrap_or(OverrideState::None))
}

fn current_uid() -> Result<u32, String> {
    let output = run_checked("/usr/bin/id", &["-u"])?;
    let text = String::from_utf8(output.stdout)
        .map_err(|_| "无法确定当前用户，未修改登录启动项。".to_string())?;
    text.trim()
        .parse::<u32>()
        .map_err(|_| "无法确定当前用户，未修改登录启动项。".to_string())
}

struct CommandOutput {
    stdout: Vec<u8>,
}

fn run_checked(program: &str, args: &[&str]) -> Result<CommandOutput, String> {
    let output = run_bounded(program, args)?;
    if !output.success {
        return Err("系统启动项命令执行失败。".to_string());
    }
    Ok(CommandOutput {
        stdout: output.stdout,
    })
}

struct BoundedOutput {
    success: bool,
    stdout: Vec<u8>,
}

fn run_bounded(program: &str, args: &[&str]) -> Result<BoundedOutput, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "系统启动项命令无法启动。".to_string())?;
    let stdout = child.stdout.take();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let reader = stdout.map(|stdout| {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut bytes = Vec::new();
            let result = stdout
                .take((MAX_COMMAND_OUTPUT + 1) as u64)
                .read_to_end(&mut bytes)
                .map(|_| bytes);
            let _ = sender.send(result);
        })
    });
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("系统启动项命令执行超时或失败。".to_string());
            }
        }
    };
    let stdout = match receiver.recv_timeout(Duration::from_millis(200)) {
        Ok(Ok(bytes)) if bytes.len() <= MAX_COMMAND_OUTPUT => bytes,
        _ => return Err("系统启动项命令输出不可用。".to_string()),
    };
    if let Some(reader) = reader {
        let _ = reader.join();
    }
    Ok(BoundedOutput { success, stdout })
}

fn entry_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "找不到当前用户的登录启动目录。".to_string())?;
    Ok(home.join("Library/LaunchAgents").join(PLIST_NAME))
}

fn parse_plist(bytes: &[u8]) -> Result<plist::Dictionary, String> {
    let value = plist::Value::from_reader(std::io::Cursor::new(bytes))
        .map_err(|_| "登录启动条目格式未知。".to_string())?;
    let dictionary = value
        .as_dictionary()
        .ok_or_else(|| "登录启动条目格式未知。".to_string())?
        .clone();
    if dictionary.get("Label").and_then(plist::Value::as_string) != Some(LABEL)
        || dictionary
            .get("RunAtLoad")
            .and_then(plist::Value::as_boolean)
            != Some(true)
        || dictionary
            .get("KeepAlive")
            .and_then(plist::Value::as_boolean)
            != Some(false)
        || dictionary
            .get("ProgramArguments")
            .and_then(plist::Value::as_array)
            .is_none_or(|arguments| arguments.len() != 1)
        || dictionary
            .get("ProgramArguments")
            .and_then(plist::Value::as_array)
            .and_then(|arguments| arguments.first())
            .and_then(plist::Value::as_string)
            .is_none_or(|executable| {
                executable.is_empty()
                    || !executable.starts_with('/')
                    || executable.contains(['\0', '\n', '\r'])
            })
    {
        return Err("登录启动条目不是本应用的有效登记。".to_string());
    }
    Ok(dictionary)
}

fn plist_bytes() -> Result<Vec<u8>, String> {
    let executable = std::env::current_exe().map_err(|_| "无法确定应用位置。".to_string())?;
    plist_bytes_for(&executable)
}

fn plist_bytes_for(executable: &Path) -> Result<Vec<u8>, String> {
    let executable = executable
        .to_str()
        .filter(|path| !path.contains(['\0', '\n', '\r']))
        .ok_or_else(|| "应用位置含不可用于登录启动的字符。".to_string())?;
    let mut dictionary = plist::Dictionary::new();
    dictionary.insert("Label".to_string(), plist::Value::String(LABEL.to_string()));
    dictionary.insert(
        "ProgramArguments".to_string(),
        plist::Value::Array(vec![plist::Value::String(executable.to_string())]),
    );
    dictionary.insert("RunAtLoad".to_string(), plist::Value::Boolean(true));
    dictionary.insert("KeepAlive".to_string(), plist::Value::Boolean(false));
    let mut bytes = Vec::new();
    plist::Value::Dictionary(dictionary)
        .to_writer_xml(&mut bytes)
        .map_err(|_| "无法序列化登录启动条目。".to_string())?;
    Ok(bytes)
}

struct Service {
    object: *mut objc::runtime::Object,
}

impl Service {
    unsafe fn new() -> Option<Self> {
        let class = objc::runtime::Class::get("SMAppService")?;
        let object: *mut objc::runtime::Object = objc::msg_send![class, mainAppService];
        (!object.is_null()).then_some(Self { object })
    }
}

fn native_service() -> Result<Option<ReferenceService>, String> {
    if objc::runtime::Class::get("SMAppService").is_none() {
        return Ok(None);
    }
    Ok(Some(ReferenceService))
}

struct ReferenceService;

impl ReferenceService {
    fn with<R>(&self, action: impl FnOnce(&Service) -> Result<R, String>) -> Result<R, String> {
        objc::rc::autoreleasepool(|| {
            let service =
                unsafe { Service::new() }.ok_or_else(|| "系统后台项目服务不可用。".to_string())?;
            action(&service)
        })
    }
}

fn service_status(service: &ReferenceService) -> Result<isize, String> {
    service.with(|service| unsafe {
        let status: isize = objc::msg_send![service.object, status];
        Ok(status)
    })
}

fn register_native(service: &ReferenceService) -> Result<(), String> {
    call_native(service, true)
}

fn unregister_native(service: &ReferenceService) -> Result<(), String> {
    call_native(service, false)
}

fn call_native(service: &ReferenceService, register: bool) -> Result<(), String> {
    service.with(|service| unsafe {
        let mut error: *mut objc::runtime::Object = std::ptr::null_mut();
        let succeeded: objc::runtime::BOOL = if register {
            objc::msg_send![service.object, registerAndReturnError: &mut error]
        } else {
            objc::msg_send![service.object, unregisterAndReturnError: &mut error]
        };
        if succeeded != objc::runtime::NO {
            Ok(())
        } else {
            Err(if register {
                "系统拒绝登记登录启动，请检查系统设置中的登录项权限。"
            } else {
                "系统拒绝取消登录启动登记，请稍后重试。"
            }
            .to_string())
        }
    })
}

fn check_native_status(service: &ReferenceService, expected: isize) -> Result<(), String> {
    if service_status(service)? == expected {
        Ok(())
    } else {
        Err("系统未接受登录启动设置，请检查系统登录项权限。".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_override_takes_precedence_over_plist_disabled() {
        for disabled in [None, Some(false), Some(true)] {
            let bytes = plist_bytes_for(Path::new("/Applications/tokenledger")).unwrap();
            let mut entry = parse_plist(&bytes).unwrap();
            if let Some(disabled) = disabled {
                entry.insert("Disabled".into(), plist::Value::Boolean(disabled));
            }
            for (override_state, expected) in [
                (OverrideState::None, !disabled.unwrap_or(false)),
                (OverrideState::Enabled, true),
                (OverrideState::Disabled, false),
            ] {
                assert_eq!(
                    legacy_entry_enabled(&entry, override_state).unwrap(),
                    expected,
                    "Disabled={disabled:?}, override={override_state:?}"
                );
            }
        }
    }

    #[test]
    fn invalid_plist_disabled_is_an_error_even_with_an_override() {
        let bytes = plist_bytes_for(Path::new("/Applications/tokenledger")).unwrap();
        let mut entry = parse_plist(&bytes).unwrap();
        for invalid in [
            plist::Value::String("false".into()),
            plist::Value::Integer(0.into()),
        ] {
            entry.insert("Disabled".into(), invalid);
            for override_state in [
                OverrideState::None,
                OverrideState::Enabled,
                OverrideState::Disabled,
            ] {
                assert!(legacy_entry_enabled(&entry, override_state).is_err());
            }
        }
    }

    #[test]
    fn legacy_restore_attempts_both_paths_and_keeps_each_error() {
        for file_fails in [false, true] {
            for override_fails in [false, true] {
                let calls = std::cell::RefCell::new(Vec::new());
                let result = restore_legacy_with(
                    || {
                        calls.borrow_mut().push("file");
                        if file_fails {
                            Err("模拟文件错误".to_string())
                        } else {
                            Ok(())
                        }
                    },
                    || {
                        calls.borrow_mut().push("override");
                        if override_fails {
                            Err("模拟覆盖错误".to_string())
                        } else {
                            Ok(())
                        }
                    },
                );
                assert_eq!(*calls.borrow(), ["file", "override"]);
                if file_fails || override_fails {
                    let error = result.unwrap_err();
                    assert_eq!(error.contains("模拟文件错误"), file_fails);
                    assert_eq!(error.contains("模拟覆盖错误"), override_fails);
                } else {
                    result.unwrap();
                }
            }
        }
    }

    #[test]
    fn native_status_distinguishes_disabled_enabled_and_unavailable() {
        assert_eq!(native_enabled(0), Ok(false));
        assert_eq!(native_enabled(1), Ok(true));
        assert_eq!(native_enabled(2), Ok(false));
        assert!(native_enabled(3).is_err());
        for status in [-1, 4, isize::MAX] {
            assert!(native_enabled(status).is_err());
        }
    }

    #[test]
    fn print_disabled_distinguishes_none_false_and_true() {
        let none = r#"disabled = {
    "com.example.other" => true
}"#;
        let disabled = format!("disabled = {{\n    \"{LABEL}\" => true\n}}");
        let enabled = format!("disabled = {{\n    \"{LABEL}\" => false\n}}");
        assert_eq!(parse_print_disabled(none).unwrap(), OverrideState::None);
        assert_eq!(
            parse_print_disabled(&disabled).unwrap(),
            OverrideState::Disabled
        );
        assert_eq!(
            parse_print_disabled(&enabled).unwrap(),
            OverrideState::Enabled
        );
        assert!(
            parse_print_disabled(&format!("disabled = {{\n  \"{LABEL}\" => maybe\n}}")).is_err()
        );
        let disabled_services = format!("disabled services = {{\n  \"{LABEL}\" => true\n}}");
        assert_eq!(
            parse_print_disabled(&disabled_services).unwrap(),
            OverrideState::Disabled
        );
        assert!(
            parse_print_disabled(&format!("disabled services = {{\n  \"{LABEL}\" => true\n"))
                .is_err()
        );
        assert!(parse_print_disabled(&format!(
            "disabled = {{\n  \"{LABEL}\" => true\n  \"{LABEL}\" => false\n}}"
        ))
        .is_err());
        assert!(parse_print_disabled("not a launchctl output").is_err());
    }

    #[test]
    fn plist_validation_checks_exact_label_and_registration_shape() {
        let valid = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{LABEL}</string>
<key>ProgramArguments</key><array><string>/Applications/Token Ledger.app/Contents/MacOS/tokenledger</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
</dict></plist>"#
        );
        assert!(parse_plist(valid.as_bytes()).is_ok());
        assert!(parse_plist(valid.replace(LABEL, "com.example.other").as_bytes()).is_err());
        assert!(parse_plist(valid.replace("<true/>", "<false/>").as_bytes()).is_err());
        let with_argument = valid.replace(
            "<string>/Applications/Token Ledger.app/Contents/MacOS/tokenledger</string>",
            "<string>--flag</string><string>/Applications/Token Ledger.app/Contents/MacOS/tokenledger</string>",
        );
        assert!(parse_plist(with_argument.as_bytes()).is_err());
    }

    #[test]
    fn generated_plist_accepts_spaces_and_unicode_but_rejects_control_paths() {
        let bytes = plist_bytes_for(Path::new(
            "/Applications/Token Ledger 测试.app/Contents/MacOS/tokenledger",
        ))
        .unwrap();
        let dictionary = parse_plist(&bytes).unwrap();
        let arguments = dictionary
            .get("ProgramArguments")
            .and_then(plist::Value::as_array)
            .unwrap();
        assert_eq!(
            arguments[0].as_string(),
            Some("/Applications/Token Ledger 测试.app/Contents/MacOS/tokenledger")
        );
        assert!(plist_bytes_for(Path::new("/Applications/a\nb")).is_err());
        assert!(plist_bytes_for(Path::new("/Applications/a\0b")).is_err());
    }

    #[test]
    fn plist_path_xml_special_characters_roundtrip_without_arguments() {
        let path = "/Applications/<Token>&\"Ledger' 测试.app/Contents/MacOS/tokenledger";
        let bytes = plist_bytes_for(Path::new(path)).unwrap();
        let entry = parse_plist(&bytes).unwrap();
        let arguments = entry
            .get("ProgramArguments")
            .and_then(plist::Value::as_array)
            .unwrap();
        assert_eq!(arguments.len(), 1);
        assert_eq!(arguments[0].as_string(), Some(path));
    }

    #[test]
    fn fake_override_restore_only_changes_known_true_or_false() {
        let mut writes = Vec::new();
        let apply = |original, current, writes: &mut Vec<bool>| {
            if let Some(value) = restore_override_action(original, current)? {
                writes.push(value);
            }
            Ok::<(), String>(())
        };
        apply(OverrideState::Enabled, OverrideState::Disabled, &mut writes).unwrap();
        apply(OverrideState::Disabled, OverrideState::Enabled, &mut writes).unwrap();
        apply(OverrideState::None, OverrideState::None, &mut writes).unwrap();
        apply(OverrideState::Enabled, OverrideState::Enabled, &mut writes).unwrap();
        apply(
            OverrideState::Disabled,
            OverrideState::Disabled,
            &mut writes,
        )
        .unwrap();
        assert_eq!(writes, vec![true, false]);
        assert!(apply(OverrideState::None, OverrideState::Disabled, &mut writes).is_err());
        assert!(apply(OverrideState::None, OverrideState::Enabled, &mut writes).is_err());
        assert!(apply(OverrideState::Enabled, OverrideState::None, &mut writes).is_err());
        assert!(apply(OverrideState::Disabled, OverrideState::None, &mut writes).is_err());
        assert_eq!(writes, vec![true, false]);
    }
}
