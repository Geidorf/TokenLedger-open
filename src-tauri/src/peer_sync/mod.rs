//! WebDAV sync compatible with the peer (contract `peer-sync-v1`).
//!
//! The peer keeps a computer's setup in one passphrase-sealed backup on a
//! WebDAV folder (`<address>/<its folder>/<its backup file>`, see `peer_wire`). TokenLedger reads
//! that same file with the same passphrase, so a user who syncs the peer can
//! bring its providers, API keys included, into TokenLedger's gateway.
//!
//! - The WebDAV password and the sync passphrase live in the OS keychain
//!   only; the address and user name in `peer-sync-v1.json`. None of them,
//!   nor any provider key, is logged, cached on disk, sent to Supabase or
//!   returned to the page.
//! - Keys go from the decrypted bundle straight into the gateway's keychain
//!   entries (`provider:<id>`), and only for providers the user picked.
//! - Only the server is read: TokenLedger never writes the peer's backup, so
//!   the peer on any computer keeps its setup exactly as it was.
//! - Subscription sign-ins are not in a peer backup and are never read
//!   (ADR-004).

pub mod backup;
pub mod dav;
pub mod shared;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::app_paths::AppContext;
use crate::gateway::{
    valid_id, validate_provider, AuthMode, Gateway, ProviderRecord, SecretStore,
    SetProviderKeyInput, WireApi,
};

const CONFIG_FILE: &str = "peer-sync-v1.json";
const PASSWORD_ACCOUNT: &str = "peer-sync:webdav-password";
const PASSPHRASE_ACCOUNT: &str = "peer-sync:passphrase";
const MAX_MODELS: usize = 512;

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub url: String,
    #[serde(default)]
    pub user: String,
    /// The peer ids of the computers whose shared usage is counted here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shared_computers: Vec<String>,
}

/// What the page sees of the setup: never a secret.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigView {
    pub url: String,
    pub user: String,
    pub has_password: bool,
    pub has_passphrase: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConfigInput {
    pub url: String,
    #[serde(default)]
    pub user: String,
    /// `None` keeps the saved one; `Some("")` removes it.
    pub password: Option<String>,
    pub passphrase: Option<String>,
}

fn config_path(app_dir: &Path) -> PathBuf {
    app_dir.join(CONFIG_FILE)
}

pub fn load_config(app_dir: &Path) -> Result<Option<SyncConfig>, String> {
    match fs::read(config_path(app_dir)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "外部网关同步设置已损坏，请重新填写。".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取外部网关同步设置失败：{error}")),
    }
}

pub fn view(app_dir: &Path, secrets: &dyn SecretStore) -> Result<SyncConfigView, String> {
    let config = load_config(app_dir)?.unwrap_or_default();
    Ok(SyncConfigView {
        url: config.url,
        user: config.user,
        has_password: secrets.get(PASSWORD_ACCOUNT)?.is_some(),
        has_passphrase: secrets.get(PASSPHRASE_ACCOUNT)?.is_some(),
    })
}

fn put_secret(secrets: &dyn SecretStore, account: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        None => Ok(()),
        Some("") => secrets.delete(account),
        Some(value) => {
            if value.len() > 4096 || value.chars().any(|ch| ch == '\0') {
                return Err("密码过长或含有无效字符。".to_string());
            }
            secrets.set(account, value)
        }
    }
}

pub fn save_config(
    app_dir: &Path,
    secrets: &dyn SecretStore,
    input: SaveConfigInput,
) -> Result<SyncConfigView, String> {
    let url = input.url.trim();
    if !url.is_empty() {
        dav::parse_base(url)?;
    }
    let user = input.user.trim();
    if user.len() > 256 {
        return Err("用户名过长。".to_string());
    }
    put_secret(secrets, PASSWORD_ACCOUNT, input.password.as_deref())?;
    put_secret(secrets, PASSPHRASE_ACCOUNT, input.passphrase.as_deref())?;
    let config = SyncConfig {
        url: url.to_string(),
        user: user.to_string(),
        shared_computers: load_config(app_dir)
            .ok()
            .flatten()
            .map(|config| config.shared_computers)
            .unwrap_or_default(),
    };
    write_config(app_dir, &config)?;
    view(app_dir, secrets)
}

fn write_config(app_dir: &Path, config: &SyncConfig) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    fs::create_dir_all(app_dir).map_err(|error| error.to_string())?;
    let path = config_path(app_dir);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body)
        .and_then(|_| fs::rename(&tmp, &path))
        .map_err(|error| format!("保存外部网关同步设置失败：{error}"))
}

/// Remembers which computers' shared usage is counted; ids that aren't a
/// peer computer id are dropped.
pub fn save_shared_selection(app_dir: &Path, ids: &[String]) -> Result<Vec<String>, String> {
    let mut config = load_config(app_dir)?.unwrap_or_default();
    let mut picked: Vec<String> = ids
        .iter()
        .map(|id| id.trim().to_ascii_lowercase())
        .filter(|id| !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
        .collect();
    picked.sort();
    picked.dedup();
    config.shared_computers = picked.clone();
    write_config(app_dir, &config)?;
    Ok(picked)
}

/// The saved computers' selection, empty when there's no setup.
pub fn shared_selection(app_dir: &Path) -> Vec<String> {
    load_config(app_dir)
        .ok()
        .flatten()
        .map(|config| config.shared_computers)
        .unwrap_or_default()
}

/// Forgets the setup and its keychain entries.
pub fn clear_config(app_dir: &Path, secrets: &dyn SecretStore) -> Result<(), String> {
    secrets.delete(PASSWORD_ACCOUNT)?;
    secrets.delete(PASSPHRASE_ACCOUNT)?;
    match fs::remove_file(config_path(app_dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除外部网关同步设置失败：{error}")),
    }
}

/// The parts of a peer backup bundle TokenLedger reads.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct PeerBundle {
    pub version: i64,
    pub created: String,
    pub app: String,
    /// Whole-backup credential policy (bundle v1); v2 may say it per part.
    pub keys: bool,
    #[serde(rename = "providersKeys")]
    pub providers_keys: Option<bool>,
    pub providers: Vec<PeerProvider>,
}

impl PeerBundle {
    pub fn carries_keys(&self) -> bool {
        self.providers_keys.unwrap_or(self.keys)
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct PeerKey {
    pub key: String,
    pub off: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct PeerProvider {
    pub id: String,
    pub name: String,
    pub key: String,
    pub keys: Vec<PeerKey>,
    pub chat: String,
    pub responses: String,
    pub anthropic: String,
    pub gemini: String,
    pub decide: String,
    #[serde(rename = "baseAPI")]
    pub base_api: String,
    pub models: Vec<String>,
    pub off: bool,
}

impl PeerProvider {
    /// The key in use, else the first saved one that is on.
    fn api_key(&self) -> Option<&str> {
        std::iter::once(self.key.as_str())
            .chain(
                self.keys
                    .iter()
                    .filter(|key| !key.off)
                    .map(|key| key.key.as_str()),
            )
            .map(str::trim)
            .find(|key| !key.is_empty())
    }

    /// The protocol and base URL TokenLedger's gateway would call: the API
    /// the user picked in the peer when it is one TokenLedger speaks, else the
    /// first of chat, responses, anthropic that has a URL.
    fn endpoint(&self) -> Option<(WireApi, &str)> {
        let pick = |api: &str| match api {
            "chat" => Some((WireApi::Chat, self.chat.trim())),
            "responses" => Some((WireApi::Responses, self.responses.trim())),
            "anthropic" => Some((WireApi::Anthropic, self.anthropic.trim())),
            _ => None,
        };
        pick(self.base_api.trim())
            .into_iter()
            .chain(
                ["chat", "responses", "anthropic"]
                    .into_iter()
                    .filter_map(pick),
            )
            .find(|(_, url)| !url.is_empty())
    }
}

/// One peer provider as it would come into TokenLedger.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub peer_id: String,
    /// The TokenLedger provider id it gets.
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub wire: Option<WireApi>,
    pub models: usize,
    pub has_key: bool,
    pub enabled: bool,
    /// A TokenLedger provider with this id exists and would be replaced.
    pub exists: bool,
    /// Why it can't be brought in; `None` when it can.
    pub unsupported: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub created: String,
    pub app: String,
    pub carries_keys: bool,
    pub providers: Vec<Candidate>,
    /// SHA-256 of the sealed backup this preview read, hex; importing hands
    /// it back so a server can't swap the backup between the two reads.
    pub digest: String,
}

/// The peer ids are free-form; TokenLedger's are 1–32 of `[a-z0-9-]`.
fn tokenledger_id(peer_id: &str) -> String {
    let mut id: String = peer_id
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
                ch
            } else {
                '-'
            }
        })
        .collect();
    id = id.trim_matches('-').to_string();
    while id.contains("--") {
        id = id.replace("--", "-");
    }
    id.truncate(32);
    let id = id.trim_end_matches('-').to_string();
    if id.is_empty() || id == "group" {
        format!("peer-{}", if id.is_empty() { "provider" } else { "group" })
    } else {
        id
    }
}

fn record_for(provider: &PeerProvider, id: &str) -> Result<ProviderRecord, String> {
    let (wire, base_url) = provider.endpoint().ok_or_else(|| {
        if !provider.gemini.trim().is_empty() {
            "只提供 Gemini 原生接口，TokenLedger 网关暂不支持。".to_string()
        } else if !provider.decide.trim().is_empty() {
            "是决策接口，不是对话供应商。".to_string()
        } else {
            "没有接口地址（多为订阅登录，不在同步范围内）。".to_string()
        }
    })?;
    let name: String = provider.name.trim().chars().take(64).collect();
    let mut models: Vec<String> = Vec::new();
    for model in &provider.models {
        let model = model.trim();
        if !model.is_empty()
            && model.len() <= 128
            && !model.chars().any(char::is_whitespace)
            && !models.iter().any(|seen| seen == model)
        {
            models.push(model.to_string());
        }
        if models.len() == MAX_MODELS {
            break;
        }
    }
    let record = ProviderRecord {
        id: id.to_string(),
        name: if name.is_empty() {
            id.to_string()
        } else {
            name
        },
        base_url: base_url.to_string(),
        wire,
        auth_mode: AuthMode::Key,
        models,
        enabled: !provider.off,
    };
    validate_provider(&record)?;
    Ok(record)
}

/// What the bundle's providers would become, against `existing` ids.
pub fn preview(bundle: &PeerBundle, existing: &BTreeSet<String>) -> Preview {
    let mut taken = BTreeSet::new();
    let providers = bundle
        .providers
        .iter()
        .map(|provider| {
            let base = tokenledger_id(&provider.id);
            let mut id = base.clone();
            let mut n = 2;
            while taken.contains(&id) {
                let suffix = format!("-{n}");
                id = format!("{}{suffix}", &base[..base.len().min(32 - suffix.len())]);
                n += 1;
            }
            taken.insert(id.clone());
            let record = record_for(provider, &id);
            Candidate {
                peer_id: provider.id.clone(),
                exists: existing.contains(&id),
                name: provider.name.trim().to_string(),
                base_url: record
                    .as_ref()
                    .map(|r| r.base_url.clone())
                    .unwrap_or_default(),
                wire: record.as_ref().ok().map(|r| r.wire),
                models: record.as_ref().map_or(0, |r| r.models.len()),
                has_key: bundle.carries_keys() && provider.api_key().is_some(),
                enabled: !provider.off,
                unsupported: record.err(),
                id,
            }
        })
        .collect();
    Preview {
        created: bundle.created.clone(),
        app: bundle.app.clone(),
        carries_keys: bundle.carries_keys(),
        providers,
        digest: String::new(),
    }
}

pub fn parse_bundle(plain: &[u8]) -> Result<PeerBundle, String> {
    serde_json::from_slice(plain).map_err(|_| "外部网关备份的内容无法识别。".to_string())
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: Vec<String>,
    pub keys_saved: usize,
    /// Existing keys removed because the import moved their provider to
    /// another scheme, host or port.
    pub keys_cleared: usize,
    pub skipped: Vec<String>,
}

pub(crate) fn same_origin(left: &str, right: &str) -> bool {
    let origin = |url: &str| {
        reqwest::Url::parse(url.trim()).ok().map(|url| {
            (
                url.scheme().to_string(),
                url.host_str().map(str::to_ascii_lowercase),
                url.port_or_known_default(),
            )
        })
    };
    matches!((origin(left), origin(right)), (Some(a), Some(b)) if a == b)
}

/// Brings the picked the peer providers (by the peer id) into the gateway; keys
/// go to the keychain. A provider without a key keeps any key TokenLedger
/// already has for it, unless the import moves it to another origin.
pub fn apply(
    gateway: &Gateway,
    bundle: &PeerBundle,
    picked: &BTreeSet<String>,
) -> Result<ImportResult, String> {
    let before: BTreeMap<String, ProviderRecord> = gateway
        .list_providers()?
        .into_iter()
        .map(|view| (view.record.id.clone(), view.record))
        .collect();
    let existing: BTreeSet<String> = before.keys().cloned().collect();
    let plan = preview(bundle, &existing);
    let mut result = ImportResult::default();
    for (candidate, provider) in plan.providers.iter().zip(&bundle.providers) {
        if !picked.contains(&candidate.peer_id) {
            continue;
        }
        if candidate.unsupported.is_some() || !valid_id(&candidate.id) {
            result.skipped.push(candidate.peer_id.clone());
            continue;
        }
        let record = record_for(provider, &candidate.id)?;
        gateway.upsert_provider(record.clone())?;
        if let Some(key) = provider.api_key().filter(|_| bundle.carries_keys()) {
            if let Err(error) = gateway.set_provider_key(SetProviderKeyInput {
                id: candidate.id.clone(),
                key: key.to_string(),
            }) {
                // No provider left behind without the key it came with.
                let _ = match before.get(&candidate.id) {
                    Some(previous) => gateway.upsert_provider(previous.clone()),
                    None => gateway.delete_provider(&candidate.id),
                };
                return Err(error);
            }
            result.keys_saved += 1;
        } else if before
            .get(&candidate.id)
            .is_some_and(|previous| !same_origin(&previous.base_url, &record.base_url))
        {
            // The kept key was set for the old host; it must not follow an
            // imported address to a host it was never meant for.
            gateway.set_provider_key(SetProviderKeyInput {
                id: candidate.id.clone(),
                key: String::new(),
            })?;
            result.keys_cleared += 1;
        }
        result.imported.push(candidate.id.clone());
    }
    Ok(result)
}

/// A client for the saved server and the saved passphrase.
fn connect(app_dir: &Path, secrets: &dyn SecretStore) -> Result<(dav::DavClient, String), String> {
    let config = load_config(app_dir)?
        .filter(|config| !config.url.is_empty())
        .ok_or_else(|| "请先填写 WebDAV 地址。".to_string())?;
    let passphrase = secrets
        .get(PASSPHRASE_ACCOUNT)?
        .ok_or_else(|| "请先填写外部网关的同步密码。".to_string())?;
    let password = secrets.get(PASSWORD_ACCOUNT)?.unwrap_or_default();
    let client = dav::DavClient::new(&config.url, &config.user, &password)?;
    Ok((client, passphrase))
}

/// The shared usage on the saved server.
pub fn shared_source(
    app_dir: &Path,
    secrets: &dyn SecretStore,
) -> Result<shared::SharedSource, String> {
    let (client, passphrase) = connect(app_dir, secrets)?;
    Ok(shared::SharedSource::new(client, passphrase))
}

/// SHA-256 of a sealed backup, lowercase hex.
pub fn backup_digest(sealed: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, sealed)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Whether the backup read for importing is the one the user previewed.
pub fn check_digest(previewed: &str, fetched: &str) -> Result<(), String> {
    if previewed.eq_ignore_ascii_case(fetched) {
        Ok(())
    } else {
        Err("服务器上的备份在预览之后变了，请重新读取备份再导入。".to_string())
    }
}

/// Reads and opens the server's backup with the saved setup, with the
/// sealed file's digest.
async fn fetch_bundle(
    app_dir: &Path,
    secrets: &dyn SecretStore,
) -> Result<(PeerBundle, String), String> {
    let (client, passphrase) = connect(app_dir, secrets)?;
    let sealed = client
        .get_backup()
        .await?
        .ok_or_else(|| "这个 WebDAV 文件夹里还没有外部网关的同步文件。".to_string())?;
    let digest = backup_digest(&sealed);
    let plain = tauri::async_runtime::spawn_blocking(move || {
        backup::open(&sealed, &passphrase, backup::BACKUP_FORMAT)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.message().to_string())?;
    Ok((parse_bundle(&plain)?, digest))
}

pub(crate) fn ensure_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("外部网关同步只允许主窗口调用。".to_string())
    }
}

pub(crate) fn secrets() -> crate::gateway::KeyringSecrets {
    crate::gateway::KeyringSecrets
}

#[tauri::command]
pub fn peer_sync_get_config(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<AppContext>>,
) -> Result<SyncConfigView, String> {
    ensure_main(&window)?;
    view(app.app_data_dir(), &secrets())
}

#[tauri::command]
pub fn peer_sync_save_config(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<AppContext>>,
    input: SaveConfigInput,
) -> Result<SyncConfigView, String> {
    ensure_main(&window)?;
    save_config(app.app_data_dir(), &secrets(), input)
}

#[tauri::command]
pub fn peer_sync_clear_config(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<AppContext>>,
) -> Result<(), String> {
    ensure_main(&window)?;
    clear_config(app.app_data_dir(), &secrets())
}

/// Reads the peer's backup from the server and lists what it would bring in.
#[tauri::command]
pub async fn peer_sync_preview(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<AppContext>>,
    gateway: tauri::State<'_, Arc<Gateway>>,
) -> Result<Preview, String> {
    ensure_main(&window)?;
    let (bundle, digest) = fetch_bundle(app.app_data_dir(), &secrets()).await?;
    let existing = gateway
        .list_providers()?
        .into_iter()
        .map(|view| view.record.id)
        .collect();
    Ok(Preview {
        digest,
        ..preview(&bundle, &existing)
    })
}

/// Reads the backup again and brings in the picked providers, if it is
/// still the one previewed (`digest`).
#[tauri::command]
pub async fn peer_sync_import_providers(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<AppContext>>,
    gateway: tauri::State<'_, Arc<Gateway>>,
    peer_ids: Vec<String>,
    digest: String,
) -> Result<ImportResult, String> {
    ensure_main(&window)?;
    let (bundle, fetched) = fetch_bundle(app.app_data_dir(), &secrets()).await?;
    check_digest(&digest, &fetched)?;
    let picked: BTreeSet<String> = peer_ids.into_iter().collect();
    apply(&gateway, &bundle, &picked)
}

#[cfg(test)]
mod tests;
