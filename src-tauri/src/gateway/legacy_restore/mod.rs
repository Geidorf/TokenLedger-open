//! Restore-only bridge for the retired API Profile database. Never creates a
//! profile, chooses a new provider, runs a CLI, or reads a credential store.
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use toml_edit::Document;

use super::codex_config::{atomic_write, version};

static GUARD: Mutex<()> = Mutex::new(());
const APPLICATION_ID: i64 = 0x544c_4150;
const MAX_FILE: u64 = 256 * 1024;

#[derive(Clone, Debug, PartialEq)]
struct Receipt {
    id: String,
    state: String,
    before_provider: Option<String>,
    before_model: Option<String>,
    target_provider: String,
    target_model: Option<String>,
    manages_model: bool,
    home: PathBuf,
    config: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub profile_count: usize,
    pub receipt_id: Option<String>,
    pub state: String,
    pub config_version: Option<String>,
    pub can_restore: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreInput {
    pub receipt_id: String,
    pub expected_version: String,
    /// Explicitly acknowledge the current configuration without editing it.
    pub keep_current: bool,
}

pub struct LegacyRestore {
    data: PathBuf,
    config: PathBuf,
}

fn safe_file(path: &Path, max: u64) -> Result<bool, String> {
    let m = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("无法检查旧版恢复文件，请确认目录权限。".into()),
    };
    if !m.is_file() || m.file_type().is_symlink() || m.len() > max {
        return Err("旧版恢复文件不是安全的普通文件或超过大小限制。".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if m.nlink() != 1 {
            return Err("旧版恢复文件有多个硬链接，未做改动。".into());
        }
    }
    Ok(true)
}

fn bounded(value: Option<String>) -> Result<Option<String>, String> {
    if value
        .as_ref()
        .is_some_and(|v| v.is_empty() || v.len() > 512 || v.chars().any(char::is_control))
    {
        return Err("旧版恢复凭据的选择键无效。".into());
    }
    Ok(value)
}

fn read_config(path: &Path) -> Result<(Vec<u8>, Document), String> {
    if !safe_file(path, MAX_FILE)? {
        return Err("当前 Codex 配置不存在，无法安全恢复旧选择。".into());
    }
    let bytes = fs::read(path).map_err(|_| "无法读取当前 Codex 配置。".to_string())?;
    if bytes.len() > MAX_FILE as usize {
        return Err("当前 Codex 配置超过大小限制。".into());
    }
    let text =
        std::str::from_utf8(&bytes).map_err(|_| "当前 Codex 配置不是 UTF-8。".to_string())?;
    // Never return parser diagnostics containing configuration content.
    let doc = text
        .parse::<Document>()
        .map_err(|_| "当前 Codex 配置格式无效。".to_string())?;
    Ok((bytes, doc))
}

fn root_value(doc: &Document, key: &str) -> Result<Option<String>, String> {
    match doc.get(key) {
        None => Ok(None),
        Some(item) => item
            .as_str()
            .map(|v| Some(v.to_string()))
            .ok_or_else(|| "当前 Codex 选择键不是字符串。".into()),
    }
}

fn matches(doc: &Document, r: &Receipt, before: bool) -> Result<bool, String> {
    let provider = if before {
        r.before_provider.clone()
    } else {
        Some(r.target_provider.clone())
    };
    let model = if before {
        r.before_model.clone()
    } else {
        r.target_model.clone()
    };
    Ok(root_value(doc, "model_provider")? == provider
        && (!r.manages_model || root_value(doc, "model")? == model))
}

impl LegacyRestore {
    pub fn new(data: &Path, config: PathBuf) -> Self {
        Self {
            data: data.into(),
            config,
        }
    }

    pub fn discover(data: &Path) -> Result<Self, String> {
        let home = match std::env::var_os("CODEX_HOME") {
            Some(p) => PathBuf::from(p),
            None => dirs::home_dir()
                .ok_or_else(|| "无法确定 Codex 配置目录。".to_string())?
                .join(".codex"),
        };
        if !home.is_absolute() {
            return Err("CODEX_HOME 必须是绝对路径。".into());
        }
        Ok(Self::new(data, home.join("config.toml")))
    }

    fn registry(&self, write: bool) -> Result<Option<Connection>, String> {
        let path = self.data.join("api_profiles_v1.sqlite3");
        if !safe_file(&path, 2 * 1024 * 1024)? {
            return Ok(None);
        }
        let flags = if write {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        };
        let c = Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_NOFOLLOW)
            .map_err(|_| "无法打开旧版恢复数据库。".to_string())?;
        c.busy_timeout(std::time::Duration::from_millis(1500))
            .map_err(|_| "无法设置旧版恢复锁。".to_string())?;
        let app: i64 = c
            .query_row("PRAGMA application_id", [], |r| r.get(0))
            .map_err(|_| "旧数据库身份无效。".to_string())?;
        let schema: i64 = c
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|_| "旧数据库版本无效。".to_string())?;
        let meta: i64 = c
            .query_row(
                "SELECT schema_version FROM api_profile_meta WHERE singleton=1",
                [],
                |r| r.get(0),
            )
            .map_err(|_| "旧数据库元数据无效。".to_string())?;
        if app != APPLICATION_ID || !(1..=2).contains(&schema) || schema != meta {
            return Err("旧数据库来自其他应用或版本不受支持，未做改动。".into());
        }
        Ok(Some(c))
    }

    fn receipt(c: &Connection) -> Result<Option<Receipt>, String> {
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_provider_switch_receipt')", [], |r| r.get(0)).map_err(|_| "无法检查旧恢复表。".to_string())?;
        if !exists {
            return Ok(None);
        }
        let r = c.query_row("SELECT operation_id,state,before_provider_present,before_provider,before_model_present,before_model,target_provider,manage_model,target_model,codex_home,config_file_path FROM codex_provider_switch_receipt WHERE singleton=1", [], |row| {
            Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,i64>(2)?, row.get::<_,Option<String>>(3)?, row.get::<_,i64>(4)?, row.get::<_,Option<String>>(5)?, row.get::<_,String>(6)?, row.get::<_,i64>(7)?, row.get::<_,Option<String>>(8)?, row.get::<_,String>(9)?, row.get::<_,String>(10)?))
        }).optional().map_err(|_| "无法读取旧恢复凭据。".to_string())?;
        r.map(|r| {
            if r.0.is_empty()
                || r.0.len() > 128
                || !matches!(
                    r.1.as_str(),
                    "pending" | "active" | "indeterminate" | "restored"
                )
                || !matches!(r.2, 0 | 1)
                || !matches!(r.4, 0 | 1)
                || !matches!(r.7, 0 | 1)
                || (r.2 == 0) != r.3.is_none()
                || (r.4 == 0) != r.5.is_none()
                || (r.7 == 0) != r.8.is_none()
            {
                return Err("旧恢复凭据格式无效。".into());
            }
            Ok(Receipt {
                id: r.0,
                state: r.1,
                before_provider: bounded(r.3)?,
                before_model: bounded(r.5)?,
                target_provider: bounded(Some(r.6))?.unwrap(),
                manages_model: r.7 == 1,
                target_model: bounded(r.8)?,
                home: PathBuf::from(r.9),
                config: PathBuf::from(r.10),
            })
        })
        .transpose()
    }

    fn identity(&self, r: &Receipt) -> Result<(), String> {
        let parent = self
            .config
            .parent()
            .ok_or_else(|| "配置目录无效。".to_string())?;
        let home = fs::canonicalize(parent).map_err(|_| "当前 Codex 目录不可读取。".to_string())?;
        if !r.home.is_absolute()
            || !r.config.is_absolute()
            || r.home != home
            || r.config != home.join("config.toml")
        {
            return Err("旧凭据对应另一处 Codex 配置，未做改动。".into());
        }
        Ok(())
    }

    fn view(&self, c: &Connection) -> Result<Inspection, String> {
        let count: i64 = c
            .query_row("SELECT count(*) FROM api_profiles", [], |r| r.get(0))
            .map_err(|_| "无法读取旧配置数量。".to_string())?;
        if !(0..=16).contains(&count) {
            return Err("旧配置数量超出支持范围。".into());
        }
        let mut v = Inspection {
            profile_count: count as usize,
            receipt_id: None,
            state: "none".into(),
            config_version: None,
            can_restore: false,
            reason: None,
        };
        if let Some(r) = Self::receipt(c)? {
            v.receipt_id = Some(r.id.clone());
            v.state = r.state.clone();
            let resolutions: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='tokenledger_legacy_resolution')",[],|r|r.get(0)).map_err(|_| "无法读取旧凭据封存状态。".to_string())?;
            if resolutions {
                let action: Option<String> = c
                    .query_row(
                        "SELECT action FROM tokenledger_legacy_resolution WHERE receipt_id=?1",
                        [&r.id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|_| "无法读取旧凭据封存状态。".to_string())?;
                if action.as_deref() == Some("kept") {
                    v.state = "kept".into();
                    return Ok(v);
                }
            }
            if r.state == "restored" {
                return Ok(v);
            }
            match self.identity(&r).and_then(|_| read_config(&self.config)) {
                Ok((bytes, doc)) => {
                    v.config_version = Some(version(Some(&bytes)));
                    v.can_restore = matches(&doc, &r, false)? || matches(&doc, &r, true)?;
                    if !v.can_restore {
                        v.reason = Some(
                            "选择键已被外部改动；不会覆盖。可保留当前配置，或先自行对账。".into(),
                        );
                    }
                }
                Err(e) => v.reason = Some(e),
            }
        }
        Ok(v)
    }

    pub fn inspect(&self) -> Result<Inspection, String> {
        let _g = GUARD
            .lock()
            .map_err(|_| "旧版恢复操作正在处理中。".to_string())?;
        match self.registry(false)? {
            Some(c) => self.view(&c),
            None => Ok(Inspection {
                profile_count: 0,
                receipt_id: None,
                state: "none".into(),
                config_version: None,
                can_restore: false,
                reason: None,
            }),
        }
    }

    pub fn restore(&self, input: RestoreInput) -> Result<Inspection, String> {
        let _g = GUARD
            .lock()
            .map_err(|_| "旧版恢复操作正在处理中。".to_string())?;
        // Cooperate with retired processes using their original lease database.
        let lease_path = self.data.join("codex_provider_switch_lease_v1.sqlite3");
        let lease = if safe_file(&lease_path, 2 * 1024 * 1024)? {
            let c = Connection::open_with_flags(
                lease_path,
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
            )
            .map_err(|_| "无法锁定旧恢复租约。".to_string())?;
            c.busy_timeout(std::time::Duration::from_millis(1500))
                .map_err(|_| "无法锁定旧恢复租约。".to_string())?;
            c.execute_batch("BEGIN EXCLUSIVE")
                .map_err(|_| "旧版配置操作仍在运行，请稍后重试。".to_string())?;
            Some(c)
        } else {
            None
        };
        let c = self
            .registry(true)?
            .ok_or_else(|| "旧数据库已不存在。".to_string())?;
        c.execute_batch("PRAGMA synchronous=FULL; BEGIN EXCLUSIVE")
            .map_err(|_| "旧恢复数据库正在使用。".to_string())?;
        let r = Self::receipt(&c)?.ok_or_else(|| "旧恢复凭据已不存在。".to_string())?;
        if r.id != input.receipt_id || r.state == "restored" {
            return Err("旧恢复凭据已变化，请刷新。".into());
        }
        // A previous keep decision leaves the retired receipt intact. Check
        // its seal under the same exclusive transaction before touching files,
        // so a confirmation from another window cannot undo that decision.
        let has_resolution: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='tokenledger_legacy_resolution')", [], |row| row.get(0))
            .map_err(|_| "无法读取旧凭据封存状态。".to_string())?;
        if has_resolution {
            let resolved: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM tokenledger_legacy_resolution WHERE receipt_id=?1)", [&r.id], |row| row.get(0))
                .map_err(|_| "无法读取旧凭据封存状态。".to_string())?;
            if resolved {
                return Err("旧凭据已封存，请刷新；当前配置未改动。".into());
            }
        }
        self.identity(&r)?;
        let (bytes, mut doc) = read_config(&self.config)?;
        if version(Some(&bytes)) != input.expected_version {
            return Err("Codex 配置已变化，请刷新后再确认。".into());
        }
        if !input.keep_current {
            if !matches(&doc, &r, false)? && !matches(&doc, &r, true)? {
                return Err("当前选择键与旧凭据不符，未做改动。".into());
            }
            if !matches(&doc, &r, true)? {
                for (key, value) in [
                    ("model_provider", r.before_provider.as_deref()),
                    ("model", r.before_model.as_deref()),
                ] {
                    if key == "model" && !r.manages_model {
                        continue;
                    }
                    match value {
                        Some(v) => {
                            if let Some(old) =
                                doc.get_mut(key).and_then(toml_edit::Item::as_value_mut)
                            {
                                let decor = old.decor().clone();
                                *old = toml_edit::Value::from(v);
                                *old.decor_mut() = decor;
                            } else {
                                doc[key] = toml_edit::value(v);
                            }
                        }
                        None => {
                            let key_prefix = doc
                                .as_table()
                                .key_decor(key)
                                .and_then(|d| d.prefix())
                                .and_then(|s| s.as_str())
                                .unwrap_or("")
                                .to_string();
                            if let Some(old) = doc.as_table_mut().remove(key) {
                                if let Some(v) = old.as_value() {
                                    let prefix =
                                        v.decor().prefix().and_then(|s| s.as_str()).unwrap_or("");
                                    let suffix =
                                        v.decor().suffix().and_then(|s| s.as_str()).unwrap_or("");
                                    let comments = [key_prefix.as_str(), prefix, suffix]
                                        .into_iter()
                                        .filter(|s| s.contains('#'))
                                        .collect::<Vec<_>>()
                                        .join("\n");
                                    if !comments.is_empty() {
                                        let trailing =
                                            doc.trailing().as_str().unwrap_or("").to_string();
                                        doc.set_trailing(format!("{trailing}\n{comments}\n"));
                                    }
                                }
                            }
                        }
                    }
                }
            }
            let after = doc.to_string().into_bytes();
            if after != bytes {
                atomic_write(&self.config, &after, || {
                    let (current, _) = read_config(&self.config)?;
                    self.identity(&r)?;
                    if current != bytes {
                        return Err("写入前配置发生变化，未做改动。".into());
                    }
                    Ok(())
                })?;
            }
            // A crash/DB failure here leaves the old receipt intact. inspect
            // recognizes exact before roots, and explicit retry only seals it.
            let (_, after_doc) = read_config(&self.config)?;
            if !matches(&after_doc, &r, true)? {
                return Err("恢复结果无法确认，凭据保留，请刷新对账。".into());
            }
        }
        if input.keep_current {
            c.execute_batch("CREATE TABLE IF NOT EXISTS tokenledger_legacy_resolution(receipt_id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action='kept'))").map_err(|_| "无法封存旧凭据。".to_string())?;
            c.execute(
                "INSERT INTO tokenledger_legacy_resolution(receipt_id,action) VALUES(?1,'kept')",
                [&r.id],
            )
            .map_err(|_| "旧凭据已处理，请刷新。".to_string())?;
        } else {
            let changed=c.execute("UPDATE codex_provider_switch_receipt SET state='restored',updated_at=?1 WHERE singleton=1 AND operation_id=?2 AND state=?3",params![chrono::Utc::now().to_rfc3339(),r.id,r.state]).map_err(|_| "配置已处理，但旧凭据未封存，请刷新后重试。".to_string())?;
            if changed != 1 {
                return Err("旧凭据已变化，配置结果需要对账。".into());
            }
        }
        c.execute_batch("COMMIT")
            .map_err(|_| "旧凭据封存尚未确认，请刷新。".to_string())?;
        drop(lease);
        self.view(&c)
    }
}

#[cfg(test)]
mod tests;
