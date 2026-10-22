//! One-click Claude Code status line setup (T10.282, ADR-018 U-105/U-106).
//!
//! Only the top-level `statusLine` of the user-level `settings.json` is
//! rewritten; every other key keeps its value and position. The writer follows
//! the gateway Agent writer: masked preview, version check, backup manifest,
//! atomic replace and restore. A status line that is not ours is moved into a
//! private chain file so `--claude-statusline` can keep running it.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::gateway::{atomic_write, line_diff, version};

pub const HELPER_FLAG: &str = "--claude-statusline";
const STATUS_LINE_KEY: &str = "statusLine";
const MAX_SETTINGS_BYTES: usize = 256 * 1024;
const MAX_MANIFEST_BYTES: usize = 16 * 1024;
const BACKUP_DIR: &str = "quota-claude-backup-v1";
const BACKUP_FILE: &str = "settings.json.bak";
const MANIFEST_FILE: &str = "manifest.json";
const CHAIN_FILE: &str = "claude-statusline-chain-v1.json";
const MAX_CHAIN_FILE_BYTES: usize = 64 * 1024;
pub const CHAIN_TIMEOUT: Duration = Duration::from_secs(2);
pub const CHAIN_OUTPUT_LIMIT: usize = 4 * 1024;
pub const MAX_CHAIN_INPUT_BYTES: usize = 256 * 1024;

const STALE_PREVIEW: &str = "Claude Code 配置在预览后被修改过，未做改动，请重新预览。";
const CHANGED_DURING_WRITE: &str = "Claude Code 配置刚被其他程序修改，未做改动，请重新预览。";
pub const RESTORE_NEEDS_FORCE: &str =
    "Claude Code 的 statusLine 在接入后又被修改过，恢复会丢掉这项修改；确认后请选择强制恢复。";

static SETUP_LOCK: Mutex<()> = Mutex::new(());

fn setup_lock() -> MutexGuard<'static, ()> {
    SETUP_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatuslineBackup {
    pub created_at: String,
    pub original_existed: bool,
    pub restorable_without_force: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatuslinePreview {
    pub settings_path: String,
    pub file_exists: bool,
    pub changed: bool,
    /// An existing status line that is not ours will keep running after ours.
    pub keeps_original: bool,
    pub before_version: String,
    pub diff: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatuslineApplyResult {
    pub changed: bool,
    pub version: String,
    pub backup_created: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatuslineRestoreResult {
    pub removed: bool,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u8,
    path: String,
    original_existed: bool,
    original_version: String,
    applied_version: String,
    created_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChainConfig {
    schema_version: u8,
    status_line: Value,
}

struct Plan {
    raw: Option<Vec<u8>>,
    before_version: String,
    existing: Option<Value>,
    next: Value,
    rendered: Vec<u8>,
    changed: bool,
    keeps_original: bool,
}

pub fn is_helper_command(command: &str) -> bool {
    command.contains(HELPER_FLAG)
}

fn points_to_helper(status_line: &Value) -> bool {
    status_line
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(is_helper_command)
}

fn read_settings(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取 Claude Code 配置失败：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Claude Code 配置是符号链接或不是普通文件，为安全起见不改动。".to_string());
    }
    if metadata.len() > MAX_SETTINGS_BYTES as u64 {
        return Err("Claude Code 配置超过 256KB，为安全起见不改动。".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("读取 Claude Code 配置失败：{error}"))?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err("Claude Code 配置超过 256KB，为安全起见不改动。".to_string());
    }
    Ok(Some(bytes))
}

fn parse_settings(bytes: &[u8]) -> Result<Map<String, Value>, String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| "Claude Code 配置不是 UTF-8 文本。".to_string())?;
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err("Claude Code 配置顶层不是 JSON 对象，未做改动。".to_string()),
        Err(_) => Err(
            "Claude Code 配置不是标准 JSON（可能含注释或尾逗号），为安全起见未做改动。".to_string(),
        ),
    }
}

fn serialize(map: &Map<String, Value>) -> Vec<u8> {
    let mut text = serde_json::to_string_pretty(map).unwrap_or_else(|_| "{}".to_string());
    text.push('\n');
    text.into_bytes()
}

/// Ours keeps the original object's other fields (e.g. `padding`) in place.
fn render_status_line(existing: Option<&Value>, command: &str) -> Result<Value, String> {
    match existing {
        None => {
            let mut object = Map::new();
            object.insert("type".to_string(), Value::from("command"));
            object.insert("command".to_string(), Value::from(command));
            Ok(Value::Object(object))
        }
        Some(Value::Object(object)) => {
            let mut object = object.clone();
            object.insert("type".to_string(), Value::from("command"));
            object.insert("command".to_string(), Value::from(command));
            Ok(Value::Object(object))
        }
        Some(_) => {
            Err("Claude Code 配置里的 statusLine 不是对象，为安全起见未做改动。".to_string())
        }
    }
}

fn plan(settings: &Path, command: &str) -> Result<Plan, String> {
    let raw = read_settings(settings)?;
    let mut doc = match raw.as_deref() {
        Some(bytes) => parse_settings(bytes)?,
        None => Map::new(),
    };
    let existing = doc
        .get(STATUS_LINE_KEY)
        .filter(|value| !value.is_null())
        .cloned();
    let next = render_status_line(existing.as_ref(), command)?;
    let changed = existing.as_ref() != Some(&next);
    let keeps_original = existing
        .as_ref()
        .is_some_and(|value| !points_to_helper(value));
    doc.insert(STATUS_LINE_KEY.to_string(), next.clone());
    let rendered = serialize(&doc);
    if rendered.len() > MAX_SETTINGS_BYTES {
        return Err("写入后的 Claude Code 配置超过 256KB，未做改动。".to_string());
    }
    Ok(Plan {
        before_version: version(raw.as_deref()),
        raw,
        existing,
        next,
        rendered,
        changed,
        keeps_original,
    })
}

fn mask_home(text: &str, home: Option<&Path>) -> String {
    let Some(home) = home.map(|home| home.to_string_lossy().into_owned()) else {
        return text.to_string();
    };
    if home.len() < 2 {
        return text.to_string();
    }
    let escaped = serde_json::to_string(&home)
        .map(|quoted| quoted[1..quoted.len() - 1].to_string())
        .unwrap_or_else(|_| home.clone());
    text.replace(&escaped, "~").replace(&home, "~")
}

fn status_line_block(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return "{}".to_string();
    };
    let mut object = Map::new();
    object.insert(STATUS_LINE_KEY.to_string(), value.clone());
    serde_json::to_string_pretty(&Value::Object(object)).unwrap_or_default()
}

/// The diff covers only `statusLine`, so other settings (which may hold
/// tokens in `env`) never reach the screen.
pub fn preview(
    settings: &Path,
    command: &str,
    home: Option<&Path>,
) -> Result<ClaudeStatuslinePreview, String> {
    let plan = plan(settings, command)?;
    let diff = if plan.changed {
        line_diff(
            &mask_home(&status_line_block(plan.existing.as_ref()), home),
            &mask_home(&status_line_block(Some(&plan.next)), home),
        )
    } else {
        String::new()
    };
    Ok(ClaudeStatuslinePreview {
        settings_path: mask_home(&settings.display().to_string(), home),
        file_exists: plan.raw.is_some(),
        changed: plan.changed,
        keeps_original: plan.keeps_original,
        before_version: plan.before_version,
        diff,
    })
}

fn unchanged_since(path: &Path, expected: String) -> impl FnOnce() -> Result<(), String> + '_ {
    move || {
        if version(read_settings(path)?.as_deref()) == expected {
            Ok(())
        } else {
            Err(CHANGED_DURING_WRITE.to_string())
        }
    }
}

fn backup_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(BACKUP_DIR)
}

fn load_manifest(app_data_dir: &Path, settings: &Path) -> Option<Manifest> {
    let path = backup_dir(app_data_dir).join(MANIFEST_FILE);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES as u64 {
        return None;
    }
    let text = fs::read_to_string(&path).ok()?;
    serde_json::from_str::<Manifest>(&text)
        .ok()
        .filter(|manifest| {
            manifest.schema_version == 1 && manifest.path == settings.display().to_string()
        })
}

fn save_backup(
    app_data_dir: &Path,
    settings: &Path,
    plan: &Plan,
    applied_version: &str,
) -> Result<bool, String> {
    let dir = backup_dir(app_data_dir);
    // Keep the earliest pre-TokenLedger file while the current one is still
    // ours; any outside edit since then becomes the new restore point.
    let (manifest, created) = match load_manifest(app_data_dir, settings) {
        Some(manifest) if manifest.applied_version == plan.before_version => (
            Manifest {
                applied_version: applied_version.to_string(),
                ..manifest
            },
            false,
        ),
        _ => {
            let backup = dir.join(BACKUP_FILE);
            match plan.raw.as_deref() {
                Some(bytes) => atomic_write(&backup, bytes, || Ok(()))
                    .map_err(|error| format!("备份 Claude Code 配置失败：{error}"))?,
                None => {
                    let _ = fs::remove_file(&backup);
                }
            }
            (
                Manifest {
                    schema_version: 1,
                    path: settings.display().to_string(),
                    original_existed: plan.raw.is_some(),
                    original_version: plan.before_version.clone(),
                    applied_version: applied_version.to_string(),
                    created_at: chrono::Utc::now().to_rfc3339(),
                },
                true,
            )
        }
    };
    let body = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    atomic_write(&dir.join(MANIFEST_FILE), &body, || Ok(()))
        .map_err(|error| format!("保存 Claude Code 配置备份记录失败：{error}"))?;
    Ok(created)
}

fn write_chain(app_data_dir: &Path, status_line: &Value) -> Result<(), String> {
    let chain = ChainConfig {
        schema_version: 1,
        status_line: status_line.clone(),
    };
    let body = serde_json::to_vec(&chain).map_err(|error| error.to_string())?;
    if body.len() > MAX_CHAIN_FILE_BYTES {
        return Err("原有 status line 配置过大，未做改动。".to_string());
    }
    super::write_private_app_data_file(app_data_dir, CHAIN_FILE, &body)
        .map_err(|_| "保存原有 status line 失败，未做改动。".to_string())
}

fn remove_chain(app_data_dir: &Path) -> Result<(), String> {
    super::remove_private_app_data_file_checked(app_data_dir, CHAIN_FILE)
        .map_err(|_| "清理旧的 status line 记录失败，未做改动。".to_string())
}

pub fn chain_present(app_data_dir: &Path) -> bool {
    chained_command(app_data_dir).is_some()
}

/// The user's original status line command, never one pointing back at us.
pub fn chained_command(app_data_dir: &Path) -> Option<String> {
    let bytes = super::read_private_app_data_file(app_data_dir, CHAIN_FILE, MAX_CHAIN_FILE_BYTES)
        .ok()??;
    let chain = serde_json::from_slice::<ChainConfig>(&bytes).ok()?;
    if chain.schema_version != 1 {
        return None;
    }
    chain
        .status_line
        .get("command")
        .and_then(Value::as_str)
        .filter(|command| !command.trim().is_empty() && !is_helper_command(command))
        .map(str::to_string)
}

pub fn apply(
    settings: &Path,
    app_data_dir: &Path,
    command: &str,
    expected_version: &str,
) -> Result<ClaudeStatuslineApplyResult, String> {
    let _lock = setup_lock();
    let plan = plan(settings, command)?;
    if plan.before_version != expected_version {
        return Err(STALE_PREVIEW.to_string());
    }
    if !plan.changed {
        return Ok(ClaudeStatuslineApplyResult {
            changed: false,
            version: plan.before_version,
            backup_created: false,
        });
    }
    match plan.existing.as_ref() {
        Some(existing) if plan.keeps_original => write_chain(app_data_dir, existing)?,
        None => remove_chain(app_data_dir)?,
        Some(_) => {}
    }
    let applied_version = version(Some(&plan.rendered));
    let backup_created = save_backup(app_data_dir, settings, &plan, &applied_version)?;
    atomic_write(
        settings,
        &plan.rendered,
        unchanged_since(settings, plan.before_version.clone()),
    )?;
    Ok(ClaudeStatuslineApplyResult {
        changed: true,
        version: applied_version,
        backup_created,
    })
}

/// Other keys (e.g. the gateway's `env.ANTHROPIC_*`) may change after we
/// write, so only our `statusLine` decides whether a restore is clean.
fn status_line_is_ours(raw: Option<&[u8]>) -> bool {
    raw.and_then(|bytes| parse_settings(bytes).ok())
        .and_then(|doc| doc.get(STATUS_LINE_KEY).cloned())
        .is_some_and(|value| points_to_helper(&value))
}

pub fn backup(settings: &Path, app_data_dir: &Path) -> Option<ClaudeStatuslineBackup> {
    let manifest = load_manifest(app_data_dir, settings)?;
    let raw = read_settings(settings).ok()?;
    Some(ClaudeStatuslineBackup {
        restorable_without_force: status_line_is_ours(raw.as_deref()),
        original_existed: manifest.original_existed,
        created_at: manifest.created_at,
    })
}

pub fn restore(
    settings: &Path,
    app_data_dir: &Path,
    force: bool,
) -> Result<ClaudeStatuslineRestoreResult, String> {
    let _lock = setup_lock();
    let manifest = load_manifest(app_data_dir, settings)
        .ok_or_else(|| "没有可恢复的 Claude Code 配置备份。".to_string())?;
    let raw = read_settings(settings)?;
    let current = version(raw.as_deref());
    if !status_line_is_ours(raw.as_deref()) && !force {
        return Err(RESTORE_NEEDS_FORCE.to_string());
    }
    let dir = backup_dir(app_data_dir);
    let original = if manifest.original_existed {
        let bytes = fs::read(dir.join(BACKUP_FILE))
            .map_err(|error| format!("读取 Claude Code 配置备份失败：{error}"))?;
        if version(Some(&bytes)) != manifest.original_version {
            return Err("Claude Code 配置备份已损坏，未做改动。".to_string());
        }
        Some(bytes)
    } else {
        None
    };
    let removed = if current == manifest.applied_version {
        // Untouched since our write: hand back the exact original bytes.
        match &original {
            Some(bytes) => {
                atomic_write(settings, bytes, unchanged_since(settings, current))?;
                false
            }
            None => remove_settings(settings)?,
        }
    } else {
        // Edited since (e.g. the gateway's Claude Code env): swap back only
        // `statusLine` and keep every other key as it is now.
        let mut doc = match raw.as_deref() {
            Some(bytes) => parse_settings(bytes)?,
            None => Map::new(),
        };
        let original_line = match original.as_deref() {
            Some(bytes) => parse_settings(bytes)?
                .get(STATUS_LINE_KEY)
                .filter(|value| !value.is_null())
                .cloned(),
            None => None,
        };
        match original_line {
            Some(line) => {
                doc.insert(STATUS_LINE_KEY.to_string(), line);
            }
            None => {
                doc.remove(STATUS_LINE_KEY);
            }
        }
        if original.is_none() && doc.is_empty() {
            remove_settings(settings)?
        } else {
            atomic_write(
                settings,
                &serialize(&doc),
                unchanged_since(settings, current),
            )?;
            false
        }
    };
    let _ = fs::remove_file(dir.join(BACKUP_FILE));
    let _ = fs::remove_file(dir.join(MANIFEST_FILE));
    let _ = remove_chain(app_data_dir);
    Ok(ClaudeStatuslineRestoreResult {
        removed,
        version: manifest.original_version,
    })
}

fn remove_settings(settings: &Path) -> Result<bool, String> {
    match fs::remove_file(settings) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("删除 Claude Code 配置失败：{error}")),
    }
}

/// Hands the command to the platform shell the same way Claude Code does.
fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        let mut process = Command::new(shell);
        process.raw_arg(format!("/d /s /c \"{command}\""));
        process.creation_flags(CREATE_NO_WINDOW);
        process
    }
    #[cfg(not(windows))]
    {
        let mut process = Command::new("/bin/sh");
        process.arg("-c").arg(command);
        process
    }
}

fn complete_utf8(mut bytes: Vec<u8>) -> Vec<u8> {
    if let Err(error) = std::str::from_utf8(&bytes) {
        if error.error_len().is_none() {
            bytes.truncate(error.valid_up_to());
        }
    }
    bytes
}

/// Runs the original command with the same stdin. Returns its stdout (at most
/// `limit` bytes); empty on spawn failure or timeout. stderr is discarded.
pub fn run_chained_command(
    command: &str,
    input: &[u8],
    timeout: Duration,
    limit: usize,
) -> Vec<u8> {
    let Ok(mut child) = shell_command(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Vec::new();
    };
    if let Some(mut stdin) = child.stdin.take() {
        let input = input.to_vec();
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let kept = Arc::new(Mutex::new(Vec::new()));
    let (done_tx, done_rx) = mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        let kept = Arc::clone(&kept);
        thread::spawn(move || {
            let mut chunk = [0u8; 1024];
            loop {
                match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let mut kept = kept.lock().unwrap_or_else(|p| p.into_inner());
                        let room = limit.saturating_sub(kept.len());
                        kept.extend_from_slice(&chunk[..read.min(room)]);
                    }
                }
            }
            let _ = done_tx.send(());
        });
    }
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Vec::new();
            }
        }
    }
    let grace = deadline
        .saturating_duration_since(Instant::now())
        .max(Duration::from_millis(50));
    let _ = done_rx.recv_timeout(grace);
    let bytes = kept.lock().unwrap_or_else(|p| p.into_inner()).clone();
    complete_utf8(bytes)
}

/// The chained stdout as one status line text; the caller adds the newline.
pub fn chained_output(command: &str, input: &[u8]) -> String {
    let bytes = run_chained_command(command, input, CHAIN_TIMEOUT, CHAIN_OUTPUT_LIMIT);
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_suffix('\n').unwrap_or(&text);
    text.strip_suffix('\r').unwrap_or(text).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const COMMAND: &str =
        "'/Applications/TokenLedger.app/Contents/MacOS/tokenledger' --claude-statusline";

    struct TempHome {
        root: PathBuf,
    }

    impl TempHome {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!(
                "tl-claude-setup-{label}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(root.join("home/.claude")).unwrap();
            fs::create_dir_all(root.join("appdata")).unwrap();
            Self { root }
        }
        fn home(&self) -> PathBuf {
            self.root.join("home")
        }
        fn settings(&self) -> PathBuf {
            self.home().join(".claude/settings.json")
        }
        fn app(&self) -> PathBuf {
            self.root.join("appdata")
        }
        fn write(&self, text: &str) {
            fs::write(self.settings(), text).unwrap();
        }
        fn read(&self) -> String {
            fs::read_to_string(self.settings()).unwrap()
        }
        fn preview(&self) -> ClaudeStatuslinePreview {
            preview(&self.settings(), COMMAND, Some(&self.home())).unwrap()
        }
        fn apply(&self) -> Result<ClaudeStatuslineApplyResult, String> {
            let version = self.preview().before_version;
            apply(&self.settings(), &self.app(), COMMAND, &version)
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn keys(text: &str) -> Vec<String> {
        match serde_json::from_str::<Value>(text).unwrap() {
            Value::Object(map) => map.keys().cloned().collect(),
            _ => panic!("not an object"),
        }
    }

    #[test]
    fn claude_setup_creates_only_status_line_when_file_is_missing() {
        let home = TempHome::new("missing");
        let preview = home.preview();
        assert!(!preview.file_exists);
        assert!(preview.changed);
        assert!(!preview.keeps_original);
        assert_eq!(preview.before_version, "missing");
        assert!(preview.diff.contains("+ "));
        let result = home.apply().unwrap();
        assert!(result.changed && result.backup_created);
        let value: Value = serde_json::from_str(&home.read()).unwrap();
        assert_eq!(keys(&home.read()), vec!["statusLine"]);
        assert_eq!(value["statusLine"]["type"], "command");
        assert_eq!(value["statusLine"]["command"], COMMAND);
        assert!(!chain_present(&home.app()));
        let backup = backup(&home.settings(), &home.app()).unwrap();
        assert!(!backup.original_existed && backup.restorable_without_force);
    }

    #[test]
    fn claude_setup_keeps_other_keys_and_their_order() {
        let home = TempHome::new("order");
        home.write(
            r#"{"zeta":1,"env":{"ANTHROPIC_AUTH_TOKEN":"sk-secret-value"},"statusLine":{"type":"command","command":"~/bin/line.sh","padding":2},"alpha":[1,2]}"#,
        );
        let preview = home.preview();
        assert!(preview.keeps_original);
        assert!(
            !preview.diff.contains("sk-secret-value"),
            "{}",
            preview.diff
        );
        assert!(!preview.diff.contains("zeta"));
        home.apply().unwrap();
        let text = home.read();
        assert_eq!(keys(&text), vec!["zeta", "env", "statusLine", "alpha"]);
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-secret-value");
        assert_eq!(value["alpha"], serde_json::json!([1, 2]));
        assert_eq!(value["statusLine"]["padding"], 2);
        assert_eq!(value["statusLine"]["command"], COMMAND);
        let status_keys: Vec<_> = value["statusLine"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(status_keys, vec!["type", "command", "padding"]);
    }

    #[test]
    fn claude_setup_moves_other_status_line_into_chain() {
        let home = TempHome::new("chain");
        home.write(r#"{"statusLine":{"type":"command","command":"~/bin/line.sh --short"}}"#);
        home.apply().unwrap();
        assert_eq!(
            chained_command(&home.app()).as_deref(),
            Some("~/bin/line.sh --short")
        );
        // A second apply over our own line keeps the chain and the first backup.
        let again = home.apply().unwrap();
        assert!(!again.changed);
        assert_eq!(
            chained_command(&home.app()).as_deref(),
            Some("~/bin/line.sh --short")
        );
    }

    #[test]
    fn claude_setup_already_pointing_here_is_a_no_op() {
        let home = TempHome::new("ours");
        let body = format!(
            "{{\n  \"statusLine\": {{\n    \"type\": \"command\",\n    \"command\": {}\n  }}\n}}\n",
            serde_json::to_string(COMMAND).unwrap()
        );
        home.write(&body);
        let preview = home.preview();
        assert!(!preview.changed && !preview.keeps_original);
        assert!(preview.diff.is_empty());
        let result = home.apply().unwrap();
        assert!(!result.changed && !result.backup_created);
        assert_eq!(home.read(), body);
        assert!(backup(&home.settings(), &home.app()).is_none());
        assert!(!chain_present(&home.app()));
    }

    #[test]
    fn claude_setup_moved_app_rewrites_command_without_chaining_itself() {
        let home = TempHome::new("moved");
        home.write(r#"{"statusLine":{"type":"command","command":"'/old/tokenledger' --claude-statusline"}}"#);
        let preview = home.preview();
        assert!(preview.changed && !preview.keeps_original);
        home.apply().unwrap();
        assert!(!chain_present(&home.app()));
    }

    #[test]
    fn claude_setup_rejects_write_after_outside_edit() {
        let home = TempHome::new("stale");
        home.write(r#"{"model":"opus"}"#);
        let preview = home.preview();
        home.write(r#"{"model":"sonnet"}"#);
        let error = apply(
            &home.settings(),
            &home.app(),
            COMMAND,
            &preview.before_version,
        )
        .unwrap_err();
        assert!(error.contains("重新预览"), "{error}");
        assert_eq!(home.read(), r#"{"model":"sonnet"}"#);
        assert!(backup(&home.settings(), &home.app()).is_none());
    }

    #[test]
    fn claude_setup_restore_brings_back_the_original_bytes() {
        let home = TempHome::new("restore");
        let original = "{\n    \"statusLine\": {\"type\": \"command\", \"command\": \"echo hi\"},\n    \"model\": \"opus\"\n}\n";
        home.write(original);
        home.apply().unwrap();
        assert!(chain_present(&home.app()));
        let result = restore(&home.settings(), &home.app(), false).unwrap();
        assert!(!result.removed);
        assert_eq!(home.read(), original);
        assert!(!chain_present(&home.app()));
        assert!(backup(&home.settings(), &home.app()).is_none());
    }

    #[test]
    fn claude_setup_restore_removes_a_file_it_created() {
        let home = TempHome::new("restore-missing");
        home.apply().unwrap();
        let result = restore(&home.settings(), &home.app(), false).unwrap();
        assert!(result.removed);
        assert!(!home.settings().exists());
    }

    #[test]
    fn claude_setup_restore_after_status_line_edit_requires_force() {
        let home = TempHome::new("force");
        home.write(r#"{"model":"opus"}"#);
        home.apply().unwrap();
        let mut doc = parse_settings(home.read().as_bytes()).unwrap();
        doc.insert("theme".to_string(), Value::from("dark"));
        doc.insert(
            STATUS_LINE_KEY.to_string(),
            serde_json::json!({"type": "command", "command": "my-line"}),
        );
        let edited = String::from_utf8(serialize(&doc)).unwrap();
        home.write(&edited);
        assert!(
            !backup(&home.settings(), &home.app())
                .unwrap()
                .restorable_without_force
        );
        assert_eq!(
            restore(&home.settings(), &home.app(), false).unwrap_err(),
            RESTORE_NEEDS_FORCE
        );
        assert_eq!(home.read(), edited);
        restore(&home.settings(), &home.app(), true).unwrap();
        let restored = parse_settings(home.read().as_bytes()).unwrap();
        assert_eq!(restored.get("theme"), Some(&Value::from("dark")));
        assert_eq!(restored.get("model"), Some(&Value::from("opus")));
        assert!(restored.get(STATUS_LINE_KEY).is_none());
    }

    #[test]
    fn claude_setup_restore_keeps_keys_written_after_apply() {
        let home = TempHome::new("keep-env");
        home.write(
            r#"{"model":"opus","statusLine":{"type":"command","command":"my-line","padding":1}}"#,
        );
        home.apply().unwrap();
        let mut doc = parse_settings(home.read().as_bytes()).unwrap();
        doc.insert(
            "env".to_string(),
            serde_json::json!({"ANTHROPIC_BASE_URL": "http://127.0.0.1:3462"}),
        );
        home.write(&String::from_utf8(serialize(&doc)).unwrap());
        assert!(
            backup(&home.settings(), &home.app())
                .unwrap()
                .restorable_without_force
        );
        restore(&home.settings(), &home.app(), false).unwrap();
        let restored = parse_settings(home.read().as_bytes()).unwrap();
        assert_eq!(
            restored.get("env"),
            Some(&serde_json::json!({"ANTHROPIC_BASE_URL": "http://127.0.0.1:3462"}))
        );
        assert_eq!(
            restored.get(STATUS_LINE_KEY),
            Some(&serde_json::json!({"type": "command", "command": "my-line", "padding": 1}))
        );
        assert!(!chain_present(&home.app()));
    }

    #[test]
    fn claude_setup_restore_keeps_a_created_file_that_gained_other_keys() {
        let home = TempHome::new("created-keep");
        home.apply().unwrap();
        let mut doc = parse_settings(home.read().as_bytes()).unwrap();
        doc.insert(
            "env".to_string(),
            serde_json::json!({"ANTHROPIC_MODEL": "a/b"}),
        );
        home.write(&String::from_utf8(serialize(&doc)).unwrap());
        let result = restore(&home.settings(), &home.app(), false).unwrap();
        assert!(!result.removed);
        let restored = parse_settings(home.read().as_bytes()).unwrap();
        assert!(restored.get(STATUS_LINE_KEY).is_none());
        assert_eq!(
            restored.get("env"),
            Some(&serde_json::json!({"ANTHROPIC_MODEL": "a/b"}))
        );
    }

    #[test]
    fn claude_setup_outside_edit_after_apply_becomes_the_new_restore_point() {
        let home = TempHome::new("rebackup");
        home.write(r#"{"model":"opus"}"#);
        home.apply().unwrap();
        home.write(r#"{"model":"haiku"}"#);
        let result = home.apply().unwrap();
        assert!(result.backup_created);
        restore(&home.settings(), &home.app(), false).unwrap();
        assert_eq!(home.read(), r#"{"model":"haiku"}"#);
    }

    #[test]
    fn claude_setup_refuses_comments_symlinks_and_non_object_status_line() {
        let home = TempHome::new("refuse");
        home.write("{ // comment\n}");
        assert!(preview(&home.settings(), COMMAND, None)
            .unwrap_err()
            .contains("标准 JSON"));
        home.write(r#"{"statusLine":"echo hi"}"#);
        assert!(preview(&home.settings(), COMMAND, None)
            .unwrap_err()
            .contains("不是对象"));
        #[cfg(unix)]
        {
            let target = home.root.join("real.json");
            fs::write(&target, "{}").unwrap();
            fs::remove_file(home.settings()).unwrap();
            std::os::unix::fs::symlink(&target, home.settings()).unwrap();
            assert!(preview(&home.settings(), COMMAND, None)
                .unwrap_err()
                .contains("符号链接"));
        }
    }

    #[test]
    fn claude_setup_preview_masks_the_home_directory() {
        let home = TempHome::new("mask");
        let command = format!(
            "'{}/bin/tokenledger' --claude-statusline",
            home.home().display()
        );
        let preview = preview(&home.settings(), &command, Some(&home.home())).unwrap();
        let home_text = home.home().display().to_string();
        assert!(!preview.diff.contains(&home_text), "{}", preview.diff);
        assert!(!preview.settings_path.contains(&home_text));
        assert!(preview.diff.contains("~/bin/tokenledger"));
        assert!(preview.settings_path.starts_with('~'));
    }

    #[test]
    fn claude_setup_chain_never_points_back_at_the_helper() {
        let home = TempHome::new("loop");
        let body = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "statusLine": { "type": "command", "command": COMMAND }
        }))
        .unwrap();
        crate::quota::write_private_app_data_file(&home.app(), CHAIN_FILE, &body).unwrap();
        assert!(chained_command(&home.app()).is_none());
    }

    #[cfg(unix)]
    mod chain {
        use super::super::*;

        const INPUT: &[u8] = br#"{"rate_limits":{}}"#;

        #[test]
        fn claude_chain_passes_stdin_and_returns_stdout_verbatim() {
            let out = run_chained_command(
                "cat; printf ' tail'",
                INPUT,
                CHAIN_TIMEOUT,
                CHAIN_OUTPUT_LIMIT,
            );
            assert_eq!(out, [INPUT, b" tail"].concat());
            assert_eq!(chained_output("printf 'line one\\n'", INPUT), "line one");
        }

        #[test]
        fn claude_chain_failure_keeps_only_its_own_stdout() {
            let out = run_chained_command(
                "printf partial; exit 3",
                INPUT,
                CHAIN_TIMEOUT,
                CHAIN_OUTPUT_LIMIT,
            );
            assert_eq!(out, b"partial");
            assert!(
                run_chained_command("exit 1", INPUT, CHAIN_TIMEOUT, CHAIN_OUTPUT_LIMIT).is_empty()
            );
        }

        #[test]
        fn claude_chain_timeout_is_bounded_and_prints_nothing() {
            let started = Instant::now();
            let out = run_chained_command(
                "printf early; exec sleep 5",
                INPUT,
                Duration::from_millis(300),
                CHAIN_OUTPUT_LIMIT,
            );
            assert!(out.is_empty());
            assert!(started.elapsed() < Duration::from_secs(2));
        }

        #[test]
        fn claude_chain_truncates_long_output() {
            let out = run_chained_command(
                "head -c 20000 /dev/zero | tr '\\000' a",
                INPUT,
                CHAIN_TIMEOUT,
                CHAIN_OUTPUT_LIMIT,
            );
            assert_eq!(out.len(), CHAIN_OUTPUT_LIMIT);
            // A multi-byte character cut at the limit is dropped, not mangled.
            let out = run_chained_command("printf 'aé'", INPUT, CHAIN_TIMEOUT, 2);
            assert_eq!(out, b"a");
        }

        #[test]
        fn claude_chain_does_not_echo_stderr() {
            let out = run_chained_command(
                "echo secret >&2; printf ok",
                INPUT,
                CHAIN_TIMEOUT,
                CHAIN_OUTPUT_LIMIT,
            );
            assert_eq!(out, b"ok");
        }
    }
}
