//! Points Codex CLI at the local gateway by editing `$CODEX_HOME/config.toml`
//! in place (T10.265). The editing approach is salvaged from PR #36
//! `file_edit.rs`: toml_edit keeps comments and unrelated keys, symlinks and
//! oversized files are refused, and every write is version-checked and atomic.
//! The pre-gateway file is kept in the app data dir so it can be restored.
//! Only the local gateway token is written; provider keys never leave the
//! keychain.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::agent_config::transaction::{self, Change};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use toml_edit::{Document, Item, Table};

pub const PROVIDER_ID: &str = "tokenledger";
const PROVIDER_NAME: &str = "TokenLedger 网关";
const MAX_CONFIG_BYTES: usize = 256 * 1024;
const BACKUP_DIR: &str = "codex-backup-v1";
const BACKUP_FILE: &str = "config.toml";
const MANIFEST_FILE: &str = "manifest.json";
const MISSING: &str = "missing";
const DIFF_CONTEXT: usize = 2;
const MAX_DIFF_LINES: usize = 4000;

pub struct CodexTarget<'a> {
    pub base_url: &'a str,
    pub token: &'a str,
    pub model: &'a str,
}

pub struct CodexConfig {
    path: PathBuf,
    backup_dir: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexBackupView {
    pub created_at: String,
    pub original_existed: bool,
    /// The file still matches what TokenLedger wrote, so restoring loses nothing.
    pub restorable_without_force: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexInspection {
    pub config_path: String,
    pub exists: bool,
    pub version: String,
    pub points_to_gateway: bool,
    pub model_provider: Option<String>,
    pub model: Option<String>,
    pub active_profile: Option<String>,
    pub backup: Option<CodexBackupView>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPreview {
    pub config_path: String,
    pub changed: bool,
    pub before_version: String,
    /// Line diff with the local token masked; empty when nothing changes.
    pub diff: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexApplyResult {
    pub config_path: String,
    pub changed: bool,
    pub version: String,
    pub backup_created: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRestoreResult {
    pub config_path: String,
    /// The original had no config.toml, so the file was removed.
    pub removed: bool,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u8,
    config_path: String,
    original_existed: bool,
    original_version: String,
    applied_version: String,
    created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    applied_owned: Option<String>,
}

pub(crate) fn version(bytes: Option<&[u8]>) -> String {
    match bytes {
        Some(bytes) => Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        None => MISSING.to_string(),
    }
}

fn parse(bytes: &[u8]) -> Result<Document, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Codex 配置不是 UTF-8 文本。".to_string())?;
    text.parse::<Document>()
        .map_err(|_| "Codex 配置不是有效的 TOML，未做改动。".to_string())
}

fn str_at<'a>(table: &'a Table, key: &str) -> Option<&'a str> {
    table.get(key).and_then(Item::as_str)
}

/// Replaces a string value, keeping the comments and spacing around it.
fn set_str(table: &mut Table, key: &str, value: &str) {
    if let Some(existing) = table.get_mut(key).and_then(Item::as_value_mut) {
        let decor = existing.decor().clone();
        *existing = toml_edit::Value::from(value);
        *existing.decor_mut() = decor;
    } else {
        table.insert(key, toml_edit::value(value));
    }
}

fn child_table<'a>(
    parent: &'a mut Table,
    key: &str,
    implicit: bool,
) -> Result<&'a mut Table, String> {
    if parent.get(key).is_none() {
        let mut table = Table::new();
        table.set_implicit(implicit);
        parent.insert(key, Item::Table(table));
    }
    parent
        .get_mut(key)
        .and_then(Item::as_table_mut)
        .ok_or_else(|| format!("Codex 配置里的「{key}」不是标准表格写法，为安全起见未做改动。"))
}

fn provider_table(document: &Document) -> Option<&Table> {
    document
        .get("model_providers")
        .and_then(Item::as_table)
        .and_then(|providers| providers.get(PROVIDER_ID))
        .and_then(Item::as_table)
}

fn render(before: &[u8], target: &CodexTarget<'_>) -> Result<Vec<u8>, String> {
    let mut document = parse(before)?;
    let root = document.as_table_mut();
    set_str(root, "model_provider", PROVIDER_ID);
    set_str(root, "model", target.model);
    let providers = child_table(root, "model_providers", true)?;
    let provider = child_table(providers, PROVIDER_ID, false)?;
    set_str(provider, "name", PROVIDER_NAME);
    set_str(provider, "base_url", target.base_url);
    set_str(provider, "wire_api", "responses");
    set_str(provider, "experimental_bearer_token", target.token);
    provider.remove("env_key");
    let rendered = document.to_string().into_bytes();
    if rendered.len() > MAX_CONFIG_BYTES {
        return Err("写入后的 Codex 配置超过 256KB，未做改动。".to_string());
    }
    parse(&rendered)?;
    Ok(rendered)
}

const OWNED_ROOT: &[&str] = &["model_provider", "model"];
const OWNED_PROVIDER: &[&str] = &[
    "name",
    "base_url",
    "wire_api",
    "experimental_bearer_token",
    "env_key",
];

fn owned_version(document: &Document) -> String {
    let values: Vec<_> = OWNED_ROOT
        .iter()
        .map(|key| document.get(key).map(Item::to_string))
        .chain(OWNED_PROVIDER.iter().map(|key| {
            provider_table(document)
                .and_then(|table| table.get(key))
                .map(Item::to_string)
        }))
        .collect();
    version(Some(
        &serde_json::to_vec(&values).expect("string projection"),
    ))
}

fn is_owned(manifest: &Manifest, current: &str, document: &Document) -> bool {
    manifest
        .applied_owned
        .as_ref()
        .map_or(manifest.applied_version == current, |expected| {
            *expected == owned_version(document)
        })
}

fn restore_owned(current: &[u8], original: Option<&[u8]>) -> Result<Option<Vec<u8>>, String> {
    let mut document = parse(current)?;
    let source = parse(original.unwrap_or_default())?;
    for key in OWNED_ROOT {
        match source.get(key) {
            Some(value) => {
                document.as_table_mut().insert(key, value.clone());
                if let Some(decor) = source.as_table().key_decor(key) {
                    *document
                        .as_table_mut()
                        .key_decor_mut(key)
                        .expect("inserted key") = decor.clone();
                }
            }
            None => {
                document.as_table_mut().remove(key);
            }
        }
    }
    let providers = child_table(document.as_table_mut(), "model_providers", true)?;
    let provider = child_table(providers, PROVIDER_ID, false)?;
    for key in OWNED_PROVIDER {
        match provider_table(&source).and_then(|table| table.get(key)) {
            Some(value) => {
                provider.insert(key, value.clone());
            }
            None => {
                provider.remove(key);
            }
        }
    }
    if provider.is_empty() && provider_table(&source).is_none() {
        providers.remove(PROVIDER_ID);
    }
    if providers.is_empty() && source.get("model_providers").is_none() {
        document.as_table_mut().remove("model_providers");
    }
    if document.as_table().is_empty() && original.is_none() {
        Ok(None)
    } else {
        let rendered = document.to_string();
        if let Some(original) = original {
            if rendered.trim_end() == std::str::from_utf8(original).unwrap_or_default().trim_end() {
                return Ok(Some(original.to_vec()));
            }
        }
        Ok(Some(rendered.into_bytes()))
    }
}

fn points_to_gateway(document: &Document, base_url: &str) -> bool {
    str_at(document.as_table(), "model_provider") == Some(PROVIDER_ID)
        && provider_table(document).and_then(|table| str_at(table, "base_url")) == Some(base_url)
}

fn profile_warnings(document: &Document) -> (Option<String>, Vec<String>) {
    let Some(profile) = str_at(document.as_table(), "profile").map(str::to_string) else {
        return (None, Vec::new());
    };
    let overrides = document
        .get("profiles")
        .and_then(|profiles| profiles.get(&profile))
        .and_then(Item::as_table_like)
        .is_some_and(|table| table.contains_key("model_provider") || table.contains_key("model"));
    let warning = if overrides {
        format!("当前启用的 profile「{profile}」自带 model_provider 或 model，会覆盖顶层设置，Codex 可能不会走网关。")
    } else {
        format!("当前启用了 profile「{profile}」，请确认它没有覆盖模型设置。")
    };
    (Some(profile), vec![warning])
}

pub(super) fn mask(text: &str, token: &str) -> String {
    if token.is_empty() {
        return text.to_string();
    }
    let suffix: String = token
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let replacement = if token.chars().count() >= 8 {
        format!("tl-…{suffix}")
    } else {
        "[已隐藏]".into()
    };
    text.replace(token, &replacement)
}

/// A unified-style line diff ("- " removed, "+ " added, "  " context) with
/// hunks separated by "…".
pub(crate) fn line_diff(before: &str, after: &str) -> String {
    let old: Vec<&str> = before.lines().collect();
    let new: Vec<&str> = after.lines().collect();
    let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let (old_mid, new_mid) = (
        &old[prefix..old.len() - suffix],
        &new[prefix..new.len() - suffix],
    );
    let mut ops: Vec<(char, &str)> = old[..prefix].iter().map(|line| (' ', *line)).collect();
    if old_mid.len() * new_mid.len() > MAX_DIFF_LINES * MAX_DIFF_LINES / 4 {
        ops.extend(old_mid.iter().map(|line| ('-', *line)));
        ops.extend(new_mid.iter().map(|line| ('+', *line)));
    } else {
        let mut lcs = vec![vec![0u32; new_mid.len() + 1]; old_mid.len() + 1];
        for i in (0..old_mid.len()).rev() {
            for j in (0..new_mid.len()).rev() {
                lcs[i][j] = if old_mid[i] == new_mid[j] {
                    lcs[i + 1][j + 1] + 1
                } else {
                    lcs[i + 1][j].max(lcs[i][j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < old_mid.len() || j < new_mid.len() {
            if i < old_mid.len() && j < new_mid.len() && old_mid[i] == new_mid[j] {
                ops.push((' ', old_mid[i]));
                i += 1;
                j += 1;
            } else if j < new_mid.len() && (i == old_mid.len() || lcs[i][j + 1] >= lcs[i + 1][j]) {
                ops.push(('+', new_mid[j]));
                j += 1;
            } else {
                ops.push(('-', old_mid[i]));
                i += 1;
            }
        }
    }
    ops.extend(old[old.len() - suffix..].iter().map(|line| (' ', *line)));

    let changed: Vec<usize> = (0..ops.len())
        .filter(|&index| ops[index].0 != ' ')
        .collect();
    let mut out = Vec::new();
    let mut last_shown: Option<usize> = None;
    for (index, (kind, line)) in ops.iter().enumerate() {
        let near = changed
            .iter()
            .any(|&at| index + DIFF_CONTEXT >= at && index <= at + DIFF_CONTEXT);
        if !near {
            continue;
        }
        if last_shown.is_some_and(|last| index > last + 1) {
            out.push("…".to_string());
        }
        out.push(format!("{kind} {line}"));
        last_shown = Some(index);
    }
    out.join("\n")
}

fn read_config(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取 Codex 配置失败：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Codex 配置是符号链接或不是普通文件，为安全起见不改动。".to_string());
    }
    if metadata.len() > MAX_CONFIG_BYTES as u64 {
        return Err("Codex 配置超过 256KB，为安全起见不改动。".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("读取 Codex 配置失败：{error}"))?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err("Codex 配置超过 256KB，为安全起见不改动。".to_string());
    }
    Ok(Some(bytes))
}

fn random_suffix() -> String {
    let mut raw = [0u8; 6];
    let _ = getrandom::fill(&mut raw);
    raw.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn sync_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::File::open(dir)
            .and_then(|handle| handle.sync_all())
            .map_err(|error| format!("同步配置目录失败：{error}"))?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// Persist newly created directory entries as well as their contents.
pub(crate) fn create_dir_durable(dir: &Path) -> Result<(), String> {
    let mut missing = Vec::new();
    let mut cursor = dir;
    while !cursor.exists() {
        missing.push(cursor.to_path_buf());
        cursor = cursor.parent().ok_or("配置目录缺少父路径")?;
    }
    fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    for created in missing.iter().rev() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(created, fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("保护配置目录失败：{e}"))?;
        }
        sync_dir(created)?;
        if let Some(parent) = created.parent() {
            sync_dir(parent)?;
        }
    }
    Ok(())
}

/// Writes through a sibling temp file and renames over the target. `guard`
/// runs right before the rename so callers can detect a concurrent writer.
pub(crate) fn atomic_write(
    path: &Path,
    bytes: &[u8],
    guard: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "配置路径缺少父目录。".to_string())?;
    create_dir_durable(dir)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.tokenledger-{}.tmp", random_suffix()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mode = fs::metadata(path)
            .map(|meta| meta.permissions().mode() & 0o777)
            .unwrap_or(0o600);
        options.mode(mode);
    }
    let result = (|| {
        let mut file = options
            .open(&tmp)
            .map_err(|error| format!("写入临时文件失败：{error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("写入临时文件失败：{error}"))?;
        guard()?;
        fs::rename(&tmp, path).map_err(|error| format!("替换配置文件失败：{error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    } else {
        sync_dir(dir)?;
    }
    result
}

impl CodexConfig {
    pub fn new(path: PathBuf, gateway_dir: &Path) -> Self {
        Self {
            path,
            backup_dir: gateway_dir.join(BACKUP_DIR),
        }
    }

    /// `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`.
    pub fn discover(gateway_dir: &Path) -> Result<Self, String> {
        let home = match std::env::var_os("CODEX_HOME") {
            Some(value) => {
                let home = PathBuf::from(value);
                if !home.is_absolute() {
                    return Err("CODEX_HOME 不是绝对路径，无法确定 Codex 配置位置。".to_string());
                }
                home
            }
            None => dirs::home_dir()
                .ok_or_else(|| "找不到用户主目录。".to_string())?
                .join(".codex"),
        };
        Ok(Self::new(home.join("config.toml"), gateway_dir))
    }

    fn display_path(&self) -> String {
        self.path.display().to_string()
    }

    fn load_manifest(&self) -> Option<Manifest> {
        let text = fs::read_to_string(self.backup_dir.join(MANIFEST_FILE)).ok()?;
        serde_json::from_str::<Manifest>(&text)
            .ok()
            .filter(|manifest| {
                manifest.schema_version == 1 && manifest.config_path == self.display_path()
            })
    }

    fn transaction_paths(&self) -> Vec<PathBuf> {
        vec![
            self.path.clone(),
            self.backup_dir.join(BACKUP_FILE),
            self.backup_dir.join(MANIFEST_FILE),
        ]
    }

    fn recover(&self) -> Result<(), String> {
        transaction::recover(&self.backup_dir, &self.transaction_paths())?;
        let present = transaction::read(&self.backup_dir.join(MANIFEST_FILE))?.is_some();
        let manifest = self.load_manifest();
        if present && manifest.is_none() {
            return Err("Codex 备份记录损坏或目标不匹配，已保留备份。".into());
        }
        let backup = transaction::read(&self.backup_dir.join(BACKUP_FILE))?;
        match manifest {
            Some(m) if m.original_existed => {
                if version(backup.as_deref()) != m.original_version {
                    return Err("Codex 备份缺失或已损坏，已保留现有文件。".into());
                }
            }
            _ if backup.is_some() => return Err("发现未关联的 Codex 配置备份，已保留备份。".into()),
            _ => (),
        }
        Ok(())
    }

    /// Startup integration may call this without parsing unrelated configs.
    pub(crate) fn recover_pending(&self) -> Result<(), String> {
        let _lock = transaction::lock();
        if transaction::pending(&self.backup_dir)? {
            transaction::recover(&self.backup_dir, &self.transaction_paths())?;
        }
        Ok(())
    }

    pub fn inspect(&self, base_url: &str) -> Result<CodexInspection, String> {
        let _lock = transaction::lock();
        self.recover()?;
        let before = read_config(&self.path)?;
        let current = version(before.as_deref());
        let document = parse(before.as_deref().unwrap_or_default())?;
        let (active_profile, warnings) = profile_warnings(&document);
        let backup = self.load_manifest().map(|manifest| CodexBackupView {
            restorable_without_force: is_owned(&manifest, &current, &document),
            created_at: manifest.created_at,
            original_existed: manifest.original_existed,
        });
        Ok(CodexInspection {
            config_path: self.display_path(),
            exists: before.is_some(),
            version: current,
            points_to_gateway: points_to_gateway(&document, base_url),
            model_provider: str_at(document.as_table(), "model_provider").map(str::to_string),
            model: str_at(document.as_table(), "model").map(str::to_string),
            active_profile,
            backup,
            warnings,
        })
    }

    pub fn preview(&self, target: &CodexTarget<'_>) -> Result<CodexPreview, String> {
        let _lock = transaction::lock();
        self.recover()?;
        let before = read_config(&self.path)?;
        let before_bytes = before.as_deref().unwrap_or_default();
        let rendered = render(before_bytes, target)?;
        let changed = before.as_deref() != Some(rendered.as_slice());
        let diff = if changed {
            let owned = |doc: &Document| {
                let mut map = serde_json::Map::new();
                for key in ["model_provider", "model"] {
                    if let Some(value) = doc.get(key).and_then(Item::as_str) {
                        map.insert(key.into(), serde_json::Value::from(value));
                    }
                }
                if let Some(provider) = provider_table(doc) {
                    let fields: serde_json::Map<String, serde_json::Value> = provider
                        .iter()
                        .map(|(key, value)| {
                            (
                                key.to_string(),
                                serde_json::Value::from(
                                    value
                                        .as_str()
                                        .map(str::to_string)
                                        .unwrap_or_else(|| value.to_string()),
                                ),
                            )
                        })
                        .collect();
                    map.insert(
                        "model_providers".into(),
                        serde_json::json!({"tokenledger":fields}),
                    );
                }
                map
            };
            let before_doc = owned(&parse(before_bytes)?);
            let after_doc = owned(&parse(&rendered)?);
            let (old, new) = super::agent_config::preview::projection(
                Some(&before_doc),
                &after_doc,
                target.token,
                false,
            );
            line_diff(&old, &new)
        } else {
            String::new()
        };
        let (_, warnings) = profile_warnings(&parse(&rendered)?);
        Ok(CodexPreview {
            config_path: self.display_path(),
            changed,
            before_version: version(before.as_deref()),
            diff,
            warnings,
        })
    }

    pub fn apply(
        &self,
        target: &CodexTarget<'_>,
        expected_version: Option<&str>,
    ) -> Result<CodexApplyResult, String> {
        let _lock = transaction::lock();
        self.recover()?;
        let before = read_config(&self.path)?;
        let current = version(before.as_deref());
        if expected_version.is_some_and(|expected| expected != current) {
            return Err("Codex 配置在预览后被修改过，请重新预览。".to_string());
        }
        let rendered = render(before.as_deref().unwrap_or_default(), target)?;
        let applied = version(Some(&rendered));
        if before.as_deref() == Some(rendered.as_slice()) {
            return Ok(CodexApplyResult {
                config_path: self.display_path(),
                changed: false,
                version: applied,
                backup_created: false,
            });
        }
        // An existing lease always retains its first pre-gateway restore point.
        let mut changes = vec![Change::new(
            self.path.clone(),
            before.clone(),
            Some(rendered.clone()),
        )];
        let (manifest, backup_created) =
            match self.load_manifest() {
                Some(manifest)
                    if is_owned(
                        &manifest,
                        &current,
                        &parse(before.as_deref().unwrap_or_default())?,
                    ) =>
                {
                    (
                        Manifest {
                            applied_version: applied.clone(),
                            applied_owned: Some(owned_version(&parse(&rendered)?)),
                            ..manifest
                        },
                        false,
                    )
                }
                Some(_) => return Err(
                    "Codex 配置恢复租约与当前配置冲突，已保留首次备份；请先恢复或处理外部修改。"
                        .into(),
                ),
                None => {
                    let backup = self.backup_dir.join(BACKUP_FILE);
                    changes.push(Change::new(
                        backup.clone(),
                        transaction::read(&backup)?,
                        before.clone(),
                    ));
                    (
                        Manifest {
                            applied_owned: Some(owned_version(&parse(&rendered)?)),
                            schema_version: 1,
                            config_path: self.display_path(),
                            original_existed: before.is_some(),
                            original_version: current.clone(),
                            applied_version: applied.clone(),
                            created_at: chrono::Utc::now().to_rfc3339(),
                        },
                        true,
                    )
                }
            };
        let path = self.backup_dir.join(MANIFEST_FILE);
        let body = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        changes.push(Change::new(
            path.clone(),
            transaction::read(&path)?,
            Some(body),
        ));
        transaction::execute(&self.backup_dir, changes)?;
        Ok(CodexApplyResult {
            config_path: self.display_path(),
            changed: true,
            version: applied,
            backup_created,
        })
    }

    pub fn restore(&self, force: bool) -> Result<CodexRestoreResult, String> {
        let _lock = transaction::lock();
        self.recover()?;
        let manifest = self
            .load_manifest()
            .ok_or_else(|| "没有可恢复的 Codex 配置备份。".to_string())?;
        let before = read_config(&self.path)?;
        let current = version(before.as_deref());
        if !force
            && !is_owned(
                &manifest,
                &current,
                &parse(before.as_deref().unwrap_or_default())?,
            )
        {
            return Err(
                "Codex 配置在接入网关后又被修改过，恢复会丢掉这些修改；确认后请选择强制恢复。"
                    .to_string(),
            );
        }
        let restored = if manifest.original_existed {
            let backup = fs::read(self.backup_dir.join(BACKUP_FILE))
                .map_err(|error| format!("读取 Codex 配置备份失败：{error}"))?;
            if version(Some(&backup)) != manifest.original_version {
                return Err("Codex 配置备份已损坏，未做改动。".to_string());
            }
            Some(backup)
        } else {
            None
        };
        let restored = if before.is_some() && manifest.applied_owned.is_some() {
            match restore_owned(before.as_deref().unwrap_or_default(), restored.as_deref()) {
                Ok(merged) => merged,
                // Explicit force authorizes reverting to the validated original
                // when malformed external contents cannot be patched safely.
                Err(_) if force => restored,
                Err(error) => return Err(error),
            }
        } else {
            restored
        };
        // Validate after the explicit-force fallback: a safe merge that exceeds
        // the limit must not fall back by discarding unrelated external edits.
        if let Some(bytes) = restored.as_deref() {
            if bytes.len() > MAX_CONFIG_BYTES {
                return Err("恢复后的 Codex 配置超过 256KB，已保留当前配置和首次备份。".into());
            }
            parse(bytes)?;
        }
        let restored_version = version(restored.as_deref());
        let removed = restored.is_none();
        let mut changes = vec![Change::new(self.path.clone(), before, restored)];
        for name in [BACKUP_FILE, MANIFEST_FILE] {
            let path = self.backup_dir.join(name);
            changes.push(Change::new(path.clone(), transaction::read(&path)?, None));
        }
        transaction::execute(&self.backup_dir, changes)?;
        Ok(CodexRestoreResult {
            config_path: self.display_path(),
            removed,
            version: restored_version,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "tl-0123456789abcdef0123456789abcdef0123456789abcd";
    const BASE: &str = "http://127.0.0.1:3462/v1";

    fn target(model: &str) -> CodexTarget<'_> {
        CodexTarget {
            base_url: BASE,
            token: TOKEN,
            model,
        }
    }

    fn setup(name: &str) -> (PathBuf, CodexConfig) {
        let dir = std::env::temp_dir().join(format!("tl-codex-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let config = CodexConfig::new(dir.join("codex-home/config.toml"), &dir.join("gateway"));
        (dir, config)
    }

    fn state(config: &CodexConfig) -> Vec<Option<Vec<u8>>> {
        config
            .transaction_paths()
            .iter()
            .map(|p| transaction::read(p).unwrap())
            .collect()
    }
    #[test]
    fn codex_faults_keep_config_manifest_and_backup_consistent() {
        for operation in ["apply", "restore", "force"] {
            for nth in 1..=3 {
                let (dir, config) = setup(&format!("fault-{operation}-{nth}"));
                fs::create_dir_all(config.path.parent().unwrap()).unwrap();
                fs::write(&config.path, b"model = \"old\"\n").unwrap();
                if operation != "apply" {
                    config.apply(&target("a/b"), None).unwrap();
                }
                if operation == "force" {
                    fs::write(&config.path, b"model = \"external\"\n").unwrap();
                }
                let before = state(&config);
                transaction::inject(nth, None);
                let result = if operation == "apply" {
                    config.apply(&target("a/b"), None).map(|_| ())
                } else {
                    config.restore(operation == "force").map(|_| ())
                };
                transaction::inject(0, None);
                assert!(result.is_err(), "{operation}/{nth}");
                assert_eq!(state(&config), before);
                config.inspect(BASE).unwrap();
                fs::remove_dir_all(dir).unwrap();
            }
            for phase in [
                "prepared",
                "staged",
                "written:0",
                "written:1",
                "written:2",
                "before-commit",
                "committed",
            ] {
                let (dir, config) =
                    setup(&format!("crash-{operation}-{}", phase.replace(':', "-")));
                fs::create_dir_all(config.path.parent().unwrap()).unwrap();
                fs::write(&config.path, b"model = \"old\"\n").unwrap();
                if operation != "apply" {
                    config.apply(&target("a/b"), None).unwrap();
                }
                if operation == "force" {
                    fs::write(&config.path, b"model = \"external\"\n").unwrap();
                }
                let before = state(&config);
                transaction::inject(0, Some(phase));
                assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if operation == "apply" {
                        config.apply(&target("a/b"), None).unwrap();
                    } else {
                        config.restore(operation == "force").unwrap();
                    }
                }))
                .is_err());
                transaction::inject(0, None);
                let inspection = config.inspect(BASE).unwrap();
                if phase == "committed" {
                    assert_eq!(inspection.backup.is_some(), operation == "apply");
                } else {
                    assert_eq!(state(&config), before);
                }
                fs::remove_dir_all(dir).unwrap();
            }
        }
    }

    #[test]
    fn preview_ipc_uses_owned_fields_and_masks_prior_credentials() {
        let (dir, config) = setup("preview-private");
        fs::create_dir_all(config.path.parent().unwrap()).unwrap();
        let original="# comment-secret\nmodel = \"old\"\n[model_providers.other]\napiKey = \"foreign-secret\"\n[model_providers.tokenledger]\nexperimental_bearer_token = \"prior-local-secret\"\nbase_url = \"http://127.0.0.1:1\"\n";
        fs::write(&config.path, original).unwrap();
        let preview = config.preview(&target("a/b")).unwrap();
        let ipc = serde_json::to_string(&preview).unwrap();
        for secret in [
            "comment-secret",
            "foreign-secret",
            "prior-local-secret",
            TOKEN,
        ] {
            assert!(!ipc.contains(secret), "{secret}: {ipc}");
        }
        assert!(preview.diff.contains("a/b"));
        assert!(preview.diff.contains(BASE));
        assert!(preview.diff.contains("experimental_bearer_token"));
        fs::write(&config.path, "apiKey = \"foreign-secret\"\nmodel = [oops\n").unwrap();
        assert!(!config
            .preview(&target("a/b"))
            .unwrap_err()
            .contains("foreign-secret"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn first_write_creates_config_and_restore_removes_it() {
        let (dir, config) = setup("first");
        let preview = config.preview(&target("openai/gpt-5.5")).unwrap();
        assert!(preview.changed);
        assert_eq!(preview.before_version, MISSING);
        assert!(!preview.diff.contains(TOKEN), "token must be masked");
        assert!(preview.diff.contains("tl-…abcd"));

        let result = config
            .apply(&target("openai/gpt-5.5"), Some(&preview.before_version))
            .unwrap();
        assert!(result.changed && result.backup_created);
        let written = fs::read_to_string(dir.join("codex-home/config.toml")).unwrap();
        let document = parse(written.as_bytes()).unwrap();
        assert_eq!(str_at(document.as_table(), "model"), Some("openai/gpt-5.5"));
        let provider = provider_table(&document).unwrap();
        assert_eq!(str_at(provider, "base_url"), Some(BASE));
        assert_eq!(str_at(provider, "wire_api"), Some("responses"));
        assert_eq!(str_at(provider, "experimental_bearer_token"), Some(TOKEN));
        assert!(config.inspect(BASE).unwrap().points_to_gateway);

        let restored = config.restore(false).unwrap();
        assert!(restored.removed);
        assert!(!dir.join("codex-home/config.toml").exists());
        assert!(config.inspect(BASE).unwrap().backup.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn existing_config_keeps_comments_and_other_keys_and_restores_exactly() {
        let (dir, config) = setup("keep");
        let original = "# my codex\nmodel = \"gpt-5\" # pinned\napproval_policy = \"on-request\"\n\n[model_providers.other]\nname = \"Other\"\nbase_url = \"https://example.com/v1\"\nenv_key = \"OTHER_KEY\"\n\n[mcp_servers.docs]\ncommand = \"docs-mcp\"\n";
        fs::create_dir_all(dir.join("codex-home")).unwrap();
        fs::write(dir.join("codex-home/config.toml"), original).unwrap();

        let preview = config.preview(&target("deepseek/chat")).unwrap();
        assert!(preview.diff.contains("- model = \"gpt-5\""));
        assert!(preview.diff.contains("+ model = \"deepseek/chat\""));
        config.apply(&target("deepseek/chat"), None).unwrap();

        let written = fs::read_to_string(dir.join("codex-home/config.toml")).unwrap();
        assert!(written.starts_with("# my codex\n"));
        assert!(written.contains("model = \"deepseek/chat\""));
        assert!(written.contains("approval_policy = \"on-request\""));
        assert!(written.contains("env_key = \"OTHER_KEY\""));
        assert!(written.contains("[mcp_servers.docs]"));
        assert!(written.contains("[model_providers.tokenledger]"));
        let inspection = config.inspect(BASE).unwrap();
        assert_eq!(inspection.model_provider.as_deref(), Some(PROVIDER_ID));
        assert!(inspection.backup.as_ref().unwrap().original_existed);

        config.restore(false).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("codex-home/config.toml")).unwrap(),
            original
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unrelated_edit_switch_and_restore_keep_first_backup() {
        let (dir, config) = setup("first-restore-point");
        fs::create_dir_all(config.path.parent().unwrap()).unwrap();
        let original = b"model = \"official\"\n";
        fs::write(&config.path, original).unwrap();
        config.apply(&target("a/model"), None).unwrap();
        let mut edited = fs::read_to_string(&config.path).unwrap();
        edited.push_str("\n[tui]\nnotifications = true\n");
        fs::write(&config.path, edited).unwrap();
        assert!(
            !config
                .apply(&target("b/model"), None)
                .unwrap()
                .backup_created
        );
        assert_eq!(
            fs::read(config.backup_dir.join(BACKUP_FILE)).unwrap(),
            original
        );
        let result = config.restore(false).unwrap();
        let restored = fs::read(&config.path).unwrap();
        let doc = parse(&restored).unwrap();
        assert_eq!(doc["model"].as_str(), Some("official"));
        assert_eq!(doc["tui"]["notifications"].as_bool(), Some(true));
        assert!(provider_table(&doc).is_none());
        assert_eq!(result.version, version(Some(&restored)));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn merged_restore_over_limit_preserves_unrelated_edits_and_backup_even_with_force() {
        for force in [false, true] {
            let (dir, config) = setup(&format!("restore-size-{force}"));
            fs::create_dir_all(config.path.parent().unwrap()).unwrap();
            let original = format!("model = \"{}\"\n", "o".repeat(180 * 1024));
            assert!(original.len() < MAX_CONFIG_BYTES);
            fs::write(&config.path, original).unwrap();
            config.apply(&target("a/model"), None).unwrap();
            let mut edited = fs::read_to_string(&config.path).unwrap();
            edited.push_str(&format!(
                "\nexternal_note = \"{}\"\n",
                "u".repeat(100 * 1024)
            ));
            // Append the unrelated key in its current provider table.
            assert!(edited.len() < MAX_CONFIG_BYTES);
            fs::write(&config.path, edited).unwrap();
            let before = state(&config);
            assert!(config.restore(force).unwrap_err().contains("超过 256KB"));
            assert_eq!(state(&config), before);
            assert!(config.inspect(BASE).unwrap().backup.is_some());
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn force_restore_recovers_invalid_toml_and_provider_structure() {
        for (index, edited) in [
            "model = [broken\n",
            "model_providers = \"not-a-table\"\nmodel = \"external\"\n",
        ]
        .iter()
        .enumerate()
        {
            for existed in [false, true] {
                let (dir, config) = setup(&format!("force-malformed-{index}-{existed}"));
                let original = b"# original\nmodel = \"official\"\n";
                if existed {
                    fs::create_dir_all(config.path.parent().unwrap()).unwrap();
                    fs::write(&config.path, original).unwrap();
                }
                config.apply(&target("a/model"), None).unwrap();
                fs::write(&config.path, edited).unwrap();
                let before = state(&config);
                assert!(config.restore(false).is_err());
                assert_eq!(state(&config), before);
                let result = config.restore(true).unwrap();
                assert_eq!(result.removed, !existed);
                assert_eq!(
                    transaction::read(&config.path).unwrap(),
                    existed.then(|| original.to_vec())
                );
                assert!(config.load_manifest().is_none());
                fs::remove_dir_all(dir).unwrap();
            }
        }
    }

    #[test]
    fn provider_unowned_field_survives_switch_and_restore() {
        let (dir, config) = setup("provider-unowned");
        fs::create_dir_all(config.path.parent().unwrap()).unwrap();
        fs::write(&config.path, b"model = \"official\"\n").unwrap();
        config.apply(&target("a/model"), None).unwrap();
        let mut edited = parse(&fs::read(&config.path).unwrap()).unwrap();
        let providers = child_table(edited.as_table_mut(), "model_providers", true).unwrap();
        child_table(providers, PROVIDER_ID, false)
            .unwrap()
            .insert("request_max_retries", toml_edit::value(7));
        fs::write(&config.path, edited.to_string()).unwrap();
        assert!(
            !config
                .apply(&target("b/model"), None)
                .unwrap()
                .backup_created
        );
        config.restore(false).unwrap();
        let restored = parse(&fs::read(&config.path).unwrap()).unwrap();
        assert_eq!(restored["model"].as_str(), Some("official"));
        let provider = provider_table(&restored).unwrap();
        assert_eq!(provider["request_max_retries"].as_integer(), Some(7));
        for key in OWNED_PROVIDER {
            assert!(provider.get(key).is_none());
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn owned_edit_and_legacy_drift_cannot_replace_first_backup() {
        for legacy in [false, true] {
            let (dir, config) = setup(&format!("lease-conflict-{legacy}"));
            fs::create_dir_all(config.path.parent().unwrap()).unwrap();
            let original = b"model = \"official\"\n";
            fs::write(&config.path, original).unwrap();
            config.apply(&target("a/model"), None).unwrap();
            if legacy {
                let mut manifest = config.load_manifest().unwrap();
                manifest.applied_owned = None;
                fs::write(
                    config.backup_dir.join(MANIFEST_FILE),
                    serde_json::to_vec(&manifest).unwrap(),
                )
                .unwrap();
            }
            let edited = fs::read_to_string(&config.path)
                .unwrap()
                .replace("a/model", "external/model");
            fs::write(&config.path, edited).unwrap();
            let before = state(&config);
            assert!(config
                .apply(&target("b/model"), None)
                .unwrap_err()
                .contains("冲突"));
            assert_eq!(state(&config), before);
            assert!(config.restore(false).is_err());
            config.restore(true).unwrap();
            assert_eq!(fs::read(&config.path).unwrap(), original);
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn repeated_apply_is_idempotent_and_keeps_the_first_backup() {
        let (dir, config) = setup("idem");
        let original = "model = \"gpt-5\"\n";
        fs::create_dir_all(dir.join("codex-home")).unwrap();
        fs::write(dir.join("codex-home/config.toml"), original).unwrap();

        assert!(config.apply(&target("a/m1"), None).unwrap().changed);
        let again = config.apply(&target("a/m1"), None).unwrap();
        assert!(!again.changed && !again.backup_created);
        assert!(!config.preview(&target("a/m1")).unwrap().changed);

        let switched = config.apply(&target("b/m2"), None).unwrap();
        assert!(switched.changed && !switched.backup_created);
        config.restore(false).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("codex-home/config.toml")).unwrap(),
            original
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn outside_edits_block_stale_apply_and_unforced_restore() {
        let (dir, config) = setup("guard");
        let path = dir.join("codex-home/config.toml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "model = \"gpt-5\"\n").unwrap();
        let preview = config.preview(&target("a/m1")).unwrap();
        fs::write(&path, "model = \"gpt-5.1\"\n").unwrap();
        assert!(config
            .apply(&target("a/m1"), Some(&preview.before_version))
            .is_err());

        config.apply(&target("a/m1"), None).unwrap();
        let mut edited = fs::read_to_string(&path).unwrap();
        edited = edited.replace("model = \"a/m1\"", "model = \"external\"");
        fs::write(&path, &edited).unwrap();
        assert!(
            !config
                .inspect(BASE)
                .unwrap()
                .backup
                .unwrap()
                .restorable_without_force
        );
        assert!(config.restore(false).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), edited);
        config.restore(true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "model = \"gpt-5.1\"\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsafe_or_invalid_configs_are_refused() {
        let (dir, config) = setup("unsafe");
        let path = dir.join("codex-home/config.toml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "model = [unclosed\n").unwrap();
        assert!(config.apply(&target("a/m1"), None).is_err());
        fs::write(&path, "model_providers = \"oops\"\n").unwrap();
        assert!(config.apply(&target("a/m1"), None).is_err());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "model_providers = \"oops\"\n"
        );
        #[cfg(unix)]
        {
            fs::remove_file(&path).unwrap();
            fs::write(dir.join("real.toml"), "model = \"x\"\n").unwrap();
            std::os::unix::fs::symlink(dir.join("real.toml"), &path).unwrap();
            assert!(config.apply(&target("a/m1"), None).is_err());
        }
        assert!(config.restore(false).is_err(), "no backup yet");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn active_profile_override_is_warned() {
        let (dir, config) = setup("profile");
        let path = dir.join("codex-home/config.toml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            "profile = \"work\"\n\n[profiles.work]\nmodel_provider = \"azure\"\n",
        )
        .unwrap();
        let preview = config.preview(&target("a/m1")).unwrap();
        assert_eq!(preview.warnings.len(), 1);
        assert!(preview.warnings[0].contains("work"));
        let _ = fs::remove_dir_all(&dir);
    }
}
