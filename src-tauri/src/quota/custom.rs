//! User-configured company OpenAPI quota providers.
//!
//! Endpoint metadata is stored in private app settings. API keys are kept in
//! the operating-system credential store and are never serialized into
//! settings, envelopes, logs, cloud snapshots, or Android payloads.

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use reqwest::header::{ACCEPT, RETRY_AFTER};
use reqwest::{redirect, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::app_paths::AppContext;
use crate::settings::{self, CustomQuotaEndpointConfig};

use super::{
    atomic_write_private, finalize_with_persisted_last_good, format_timestamp, persistence_guard,
    read_bounded_private_file, remove_persisted_snapshot, QuotaCapability, QuotaMode,
    QuotaProviderEnvelope, QuotaScope, QuotaSource, QuotaStatus, QuotaUnit, QuotaWindowSnapshot,
    QuotaWindowStatus,
};

pub(crate) const PROVIDER_PREFIX: &str = "company-openapi-";
const KEYRING_SERVICE: &str = "com.jeidorf.tokenledger.custom-quota";
const KEYRING_ACCOUNT_PREFIX: &str = "api-key:";
const BOUND_KEY_PREFIX: &str = "tokenledger-custom-quota-key:v1:";
const BOUND_KEY_MARKER: &str = "tokenledger-custom-quota-key";
const DEFAULT_QUOTA_PATH: &str = "/v1/me/quota";
const MAX_ENDPOINTS: usize = 5;
const MAX_DISPLAY_NAME_BYTES: usize = 80;
const MAX_URL_BYTES: usize = 2_048;
const MAX_API_KEY_BYTES: usize = 8 * 1_024;
const MAX_RESPONSE_BYTES: usize = 256 * 1_024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const STALE_AFTER_SECONDS: u64 = 5 * 60;
const RATE_LIMIT_STATE_SCHEMA_VERSION: u8 = 1;
const MAX_RATE_LIMIT_STATE_BYTES: usize = 1_024;
const DEFAULT_RATE_LIMIT_BACKOFF_SECONDS: u64 = 60;
const MAX_EXPONENTIAL_BACKOFF_SECONDS: u64 = 60 * 60;
const MAX_RETRY_AFTER_SECONDS: u64 = 24 * 60 * 60;
static KEYRING_READ_FAILURES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static ENDPOINT_MUTATIONS: OnceLock<Mutex<()>> = OnceLock::new();

// Two independently configured live endpoints returned the same
// type-only HTTP 200 shape. T10.22b freezes only the CNY cost/limit fields
// needed for percentages; balance, expiry, status flags, and the upstream
// aggregate ratio remain outside the normalized quota contract.
const RESPONSE_SCHEMA_VERIFIED: bool = true;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomQuotaEndpointView {
    pub id: String,
    pub provider_id: String,
    pub display_name: String,
    pub url: String,
    pub enabled: bool,
    pub has_api_key: Option<bool>,
    pub schema_verified: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RateLimitState {
    schema_version: u8,
    retry_at: String,
    consecutive_limits: u8,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BoundApiKey {
    marker: String,
    version: u8,
    origin: String,
    key: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpsertCustomQuotaEndpointInput {
    #[serde(default)]
    pub id: Option<String>,
    pub display_name: String,
    pub url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

impl std::fmt::Debug for UpsertCustomQuotaEndpointInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpsertCustomQuotaEndpointInput")
            .field("id", &self.id)
            .field("display_name", &self.display_name)
            .field("url", &self.url)
            .field("api_key", &crate::redact::hidden_opt(&self.api_key))
            .field("enabled", &self.enabled)
            .finish()
    }
}

fn default_enabled() -> bool {
    true
}

pub(crate) fn provider_id(config_id: &str) -> String {
    format!("{PROVIDER_PREFIX}{config_id}")
}

pub(crate) fn config_id_from_provider_id(value: &str) -> Option<&str> {
    let id = value.strip_prefix(PROVIDER_PREFIX)?;
    valid_config_id(id).then_some(id)
}

fn valid_config_id(value: &str) -> bool {
    (8..=32).contains(&value.len())
        && value
            .chars()
            .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
}

fn generate_config_id(name: &str, url: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    hasher.update([0]);
    hasher.update(url.as_bytes());
    hasher.update([0]);
    hasher.update(now.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    let digest = hasher.finalize();
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_display_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_DISPLAY_NAME_BYTES
        || value.chars().any(char::is_control)
    {
        return Err("公司额度名称必须为 1 到 80 字节的可见文本。".to_string());
    }
    Ok(value.to_string())
}

fn normalize_endpoint_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_URL_BYTES {
        return Err("额度接口地址为空或过长。".to_string());
    }
    let mut url = Url::parse(value).map_err(|_| "额度接口地址不是有效 URL。".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("额度接口地址不能包含用户名或密码。".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("额度接口地址不能包含 query 或 fragment，API key 也不会写入 URL。".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "额度接口地址缺少主机名。".to_string())?;
    let loopback_http = url.scheme() == "http"
        && (host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .map(|address| address.is_loopback())
                .unwrap_or(false));
    if url.scheme() != "https" && !loopback_http {
        return Err("额度接口必须使用 HTTPS；仅本机 localhost 调试允许 HTTP。".to_string());
    }
    if url.path().is_empty() || url.path() == "/" {
        url.set_path(DEFAULT_QUOTA_PATH);
    }
    Ok(url.to_string())
}

fn validate_api_key(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_API_KEY_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err("API key 为空、过长，或包含首尾空白/控制字符。".to_string());
    }
    Ok(())
}

fn endpoint_origin(url: &str) -> Option<String> {
    let url = Url::parse(url).ok()?;
    let host = url.host()?;
    let port = url.port_or_known_default()?;
    Some(format!("{}|{host}|{port}", url.scheme()))
}

fn encode_bound_key(url: &str, key: &str) -> Result<String, String> {
    validate_api_key(key)?;
    let origin = endpoint_origin(url).ok_or_else(|| "额度接口来源无效。".to_string())?;
    let value = BoundApiKey {
        marker: BOUND_KEY_MARKER.to_string(),
        version: 1,
        origin,
        key: key.to_string(),
    };
    serde_json::to_string(&value)
        .map(|json| format!("{BOUND_KEY_PREFIX}{json}"))
        .map_err(|_| "无法编码公司额度凭据。".to_string())
}

fn decode_bound_key(raw: &str, url: &str) -> Option<String> {
    let value: BoundApiKey = serde_json::from_str(raw.strip_prefix(BOUND_KEY_PREFIX)?).ok()?;
    if value.marker != BOUND_KEY_MARKER
        || value.version != 1
        || Some(value.origin.as_str()) != endpoint_origin(url).as_deref()
        || validate_api_key(&value.key).is_err()
    {
        return None;
    }
    Some(value.key)
}

fn credential_entry(id: &str) -> Result<keyring::Entry, String> {
    if !valid_config_id(id) {
        return Err("公司额度配置 ID 无效。".to_string());
    }
    keyring::Entry::new(KEYRING_SERVICE, &format!("{KEYRING_ACCOUNT_PREFIX}{id}"))
        .map_err(|_| "无法访问系统安全存储。".to_string())
}

fn load_api_key(id: &str) -> Result<Option<String>, String> {
    match credential_entry(id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取系统安全存储中的公司 API key。".to_string()),
    }
}

fn keyring_read_failures() -> &'static Mutex<HashMap<String, String>> {
    KEYRING_READ_FAILURES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn clear_keyring_read_failure(id: &str) {
    let mut failures = keyring_read_failures()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    failures.remove(id);
}

fn load_api_key_with_failure_cache<F>(
    id: &str,
    retry: bool,
    read: F,
) -> Result<Option<String>, String>
where
    F: FnOnce() -> Result<Option<String>, String>,
{
    let mut failures = keyring_read_failures()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !retry {
        if let Some(error) = failures.get(id) {
            return Err(error.clone());
        }
    } else {
        failures.remove(id);
    }

    // Keep the short keyring call inside the lock so concurrent refreshes for
    // one endpoint cannot race into multiple authorization prompts.
    let result = read();
    match &result {
        Ok(_) => {
            failures.remove(id);
        }
        Err(error) => {
            failures.insert(id.to_string(), error.clone());
        }
    }
    result
}

fn load_api_key_for_read(id: &str, retry: bool) -> Result<Option<String>, String> {
    load_api_key_with_failure_cache(id, retry, || load_api_key(id))
}

fn store_api_key(id: &str, raw: &str) -> Result<(), String> {
    credential_entry(id)?
        .set_password(raw)
        .map_err(|_| "无法把公司 API key 写入系统安全存储。".to_string())?;
    clear_keyring_read_failure(id);
    Ok(())
}

fn delete_api_key(id: &str) -> Result<(), String> {
    match credential_entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法从系统安全存储删除公司 API key。".to_string()),
    }?;
    clear_keyring_read_failure(id);
    Ok(())
}

fn view_for(config: &CustomQuotaEndpointConfig) -> Result<CustomQuotaEndpointView, String> {
    Ok(CustomQuotaEndpointView {
        id: config.id.clone(),
        provider_id: provider_id(&config.id),
        display_name: config.display_name.clone(),
        url: config.url.clone(),
        enabled: config.enabled,
        // Listing settings must not read the secret. Presence metadata alone
        // cannot establish that a key is bound to this origin after restart.
        // Pre-binding metadata cannot prove that an old plaintext key matches
        // this origin. Keep listing read-only and report that as unchecked.
        has_api_key: config
            .api_key_configured
            .and_then(|present| (!present).then_some(false)),
        schema_verified: RESPONSE_SCHEMA_VERIFIED,
    })
}

fn list_views(app: &AppContext) -> Result<Vec<CustomQuotaEndpointView>, String> {
    settings::load_settings_result(app)?
        .quota_custom_endpoints
        .iter()
        .map(view_for)
        .collect()
}

#[tauri::command]
pub fn list_custom_quota_endpoints(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
) -> Result<Vec<CustomQuotaEndpointView>, String> {
    list_views(app_state.inner().as_ref())
}

#[tauri::command]
pub fn upsert_custom_quota_endpoint(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
    input: UpsertCustomQuotaEndpointInput,
) -> Result<Vec<CustomQuotaEndpointView>, String> {
    upsert_custom_quota_endpoint_impl(app_state.inner().as_ref(), input)
}

fn endpoint_requires_api_key(existing: bool, enabled: bool) -> bool {
    !existing || enabled
}

fn lock_endpoint_mutations() -> MutexGuard<'static, ()> {
    ENDPOINT_MUTATIONS
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn same_endpoint_origin(previous: &str, next: &str) -> bool {
    endpoint_origin(previous).is_some_and(|origin| Some(origin) == endpoint_origin(next))
}

fn restore_previous_key(
    credentials: &mut impl CustomQuotaCredentialStore,
    id: &str,
    previous_raw: Option<&str>,
) -> Result<(), String> {
    match previous_raw {
        Some(raw) => credentials.store(id, raw),
        None => credentials.delete(id),
    }
}

trait CustomQuotaCredentialStore {
    fn load(&mut self, id: &str) -> Result<Option<String>, String>;
    fn store(&mut self, id: &str, key: &str) -> Result<(), String>;
    fn delete(&mut self, id: &str) -> Result<(), String>;
}

struct SystemCredentialStore;

impl CustomQuotaCredentialStore for SystemCredentialStore {
    fn load(&mut self, id: &str) -> Result<Option<String>, String> {
        load_api_key_for_read(id, true)
    }

    fn store(&mut self, id: &str, key: &str) -> Result<(), String> {
        store_api_key(id, key)
    }

    fn delete(&mut self, id: &str) -> Result<(), String> {
        delete_api_key(id)
    }
}

fn upsert_custom_quota_endpoint_impl(
    app: &AppContext,
    input: UpsertCustomQuotaEndpointInput,
) -> Result<Vec<CustomQuotaEndpointView>, String> {
    upsert_custom_quota_endpoint_with_store(app, input, &mut SystemCredentialStore)
}

fn upsert_custom_quota_endpoint_with_store(
    app: &AppContext,
    input: UpsertCustomQuotaEndpointInput,
    credentials: &mut impl CustomQuotaCredentialStore,
) -> Result<Vec<CustomQuotaEndpointView>, String> {
    upsert_custom_quota_endpoint_with_store_and_save(app, input, credentials, |app, endpoints| {
        settings::replace_custom_quota_endpoints(app, endpoints).map(|_| ())
    })
}

fn upsert_custom_quota_endpoint_with_store_and_save(
    app: &AppContext,
    input: UpsertCustomQuotaEndpointInput,
    credentials: &mut impl CustomQuotaCredentialStore,
    save: impl FnOnce(&AppContext, Vec<CustomQuotaEndpointConfig>) -> Result<(), String>,
) -> Result<Vec<CustomQuotaEndpointView>, String> {
    // Keep the metadata read, credential mutation, and metadata write together
    // so two requests in this process cannot bind one ID's key to the other's origin.
    let _mutation = lock_endpoint_mutations();
    let display_name = validate_display_name(&input.display_name)?;
    let url = normalize_endpoint_url(&input.url)?;
    let mut endpoints = settings::load_settings_result(app)?.quota_custom_endpoints;
    let existing_index = input
        .id
        .as_deref()
        .map(|id| {
            if !valid_config_id(id) {
                return Err("公司额度配置 ID 无效。".to_string());
            }
            endpoints
                .iter()
                .position(|config| config.id == id)
                .ok_or_else(|| "要更新的公司额度配置不存在。".to_string())
        })
        .transpose()?;
    if existing_index.is_none() && endpoints.len() >= MAX_ENDPOINTS {
        return Err("最多可配置 5 个公司额度接口。".to_string());
    }
    let id = existing_index
        .map(|index| endpoints[index].id.clone())
        .unwrap_or_else(|| generate_config_id(&display_name, &url));
    if endpoints.iter().any(|config| config.id == id) && existing_index.is_none() {
        return Err("无法生成唯一的公司额度配置 ID，请重试。".to_string());
    }

    let replacement_key = input.api_key.as_deref();
    let key_will_change = replacement_key.is_some();
    let requires_key = endpoint_requires_api_key(existing_index.is_some(), input.enabled);
    let origin_changed =
        existing_index.is_some_and(|index| !same_endpoint_origin(&endpoints[index].url, &url));
    let previous_config = existing_index.map(|index| endpoints[index].clone());
    if origin_changed && input.enabled && replacement_key.is_none() {
        return Err("额度接口来源已变更，请为新来源重新提供 API key。".to_string());
    }
    let discard_old_key = origin_changed && replacement_key.is_none();
    let mut api_key_configured =
        existing_index.and_then(|index| endpoints[index].api_key_configured);
    let previous_raw = if key_will_change || discard_old_key || requires_key {
        credentials.load(&id)?
    } else {
        None
    };
    let previous_key = previous_raw.as_deref().and_then(|raw| {
        let previous_url = existing_index.map(|index| endpoints[index].url.as_str())?;
        decode_bound_key(raw, previous_url)
    });
    if requires_key && replacement_key.is_none() && previous_key.is_none() {
        return Err("公司额度旧凭据未绑定当前接口来源；请重新输入 API key。".to_string());
    }
    if let Some(api_key) = replacement_key {
        credentials.store(&id, &encode_bound_key(&url, api_key)?)?;
        api_key_configured = Some(true);
    } else if discard_old_key {
        credentials.delete(&id)?;
        api_key_configured = Some(false);
    } else if previous_key.is_some() {
        api_key_configured = Some(true);
    }
    let confirmed_key = key_will_change || (!discard_old_key && previous_key.is_some());

    let config = CustomQuotaEndpointConfig {
        id: id.clone(),
        display_name,
        url,
        enabled: input.enabled,
        api_key_configured,
    };
    let saved_config = config.clone();
    if let Some(index) = existing_index {
        endpoints[index] = config;
    } else {
        endpoints.push(config);
    }
    if let Err(error) = save(app, endpoints) {
        if (key_will_change || discard_old_key)
            && restore_previous_key(credentials, &id, previous_raw.as_deref()).is_err()
        {
            return Err("保存公司额度配置失败，且旧凭据无法恢复；请重新输入 API key。".to_string());
        }
        return Err(error);
    }
    if !input.enabled || origin_changed {
        if let Some(previous) = &previous_config {
            remove_endpoint_snapshots(app.app_data_dir(), previous);
        }
        remove_endpoint_snapshots(app.app_data_dir(), &saved_config);
    }
    let mut views = list_views(app)?;
    if confirmed_key {
        if let Some(view) = views.iter_mut().find(|view| view.id == id) {
            view.has_api_key = Some(true);
        }
    }
    Ok(views)
}

#[tauri::command]
pub fn delete_custom_quota_endpoint(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
    id: String,
) -> Result<Vec<CustomQuotaEndpointView>, String> {
    delete_custom_quota_endpoint_impl(app_state.inner().as_ref(), &id)
}

fn delete_custom_quota_endpoint_impl(
    app: &AppContext,
    id: &str,
) -> Result<Vec<CustomQuotaEndpointView>, String> {
    let _mutation = lock_endpoint_mutations();
    if !valid_config_id(id) {
        return Err("公司额度配置 ID 无效。".to_string());
    }
    let mut endpoints = settings::load_settings_result(app)?.quota_custom_endpoints;
    let index = endpoints
        .iter()
        .position(|config| config.id == id)
        .ok_or_else(|| "要删除的公司额度配置不存在。".to_string())?;
    let previous_key = load_api_key_for_read(id, true)?;
    delete_api_key(id)?;
    let removed_config = endpoints.remove(index);
    if let Err(error) = settings::replace_custom_quota_endpoints(app, endpoints) {
        if restore_previous_key(&mut SystemCredentialStore, id, previous_key.as_deref()).is_err() {
            return Err("删除公司额度配置失败，且旧凭据无法恢复；请重新输入 API key。".to_string());
        }
        return Err(error);
    }
    remove_endpoint_snapshots(app.app_data_dir(), &removed_config);
    list_views(app)
}

fn source_file_suffix(config: &CustomQuotaEndpointConfig) -> String {
    let source = endpoint_origin(&config.url).unwrap_or_else(|| config.url.clone());
    let digest = Sha256::digest(source.as_bytes());
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn last_good_file_name(config: &CustomQuotaEndpointConfig) -> String {
    format!(
        "quota_lkg_custom_{}_{}.json",
        config.id,
        source_file_suffix(config)
    )
}

fn rate_limit_file_name(config: &CustomQuotaEndpointConfig) -> String {
    format!(
        "quota_rate_custom_{}_{}.json",
        config.id,
        source_file_suffix(config)
    )
}

fn remove_endpoint_snapshots(app_data_dir: &Path, config: &CustomQuotaEndpointConfig) {
    remove_persisted_snapshot(app_data_dir, &last_good_file_name(config));
    remove_persisted_snapshot(app_data_dir, &rate_limit_file_name(config));
    remove_legacy_endpoint_snapshots(app_data_dir, &config.id);
}

fn remove_legacy_endpoint_snapshots(app_data_dir: &Path, id: &str) {
    // Older builds used ID-only names; they cannot prove the source identity.
    remove_persisted_snapshot(app_data_dir, &format!("quota_lkg_custom_{id}.json"));
    remove_persisted_snapshot(app_data_dir, &format!("quota_rate_custom_{id}.json"));
}

fn load_rate_limit_state_unlocked(
    app_data_dir: &Path,
    config: &CustomQuotaEndpointConfig,
    now: DateTime<Utc>,
) -> Option<(RateLimitState, DateTime<Utc>)> {
    let file_name = rate_limit_file_name(config);
    let bytes =
        read_bounded_private_file(app_data_dir, &file_name, MAX_RATE_LIMIT_STATE_BYTES).ok()?;
    let state = match serde_json::from_slice::<RateLimitState>(&bytes) {
        Ok(state) => state,
        Err(_) => {
            remove_persisted_snapshot(app_data_dir, &file_name);
            return None;
        }
    };
    let retry_at = match DateTime::parse_from_rfc3339(&state.retry_at) {
        Ok(value) => value.with_timezone(&Utc),
        Err(_) => {
            remove_persisted_snapshot(app_data_dir, &file_name);
            return None;
        }
    };
    let latest_allowed = now + chrono::Duration::seconds(MAX_RETRY_AFTER_SECONDS as i64);
    let earliest_allowed = now - chrono::Duration::days(30);
    if state.schema_version != RATE_LIMIT_STATE_SCHEMA_VERSION
        || state.consecutive_limits == 0
        || retry_at > latest_allowed
        || retry_at < earliest_allowed
    {
        remove_persisted_snapshot(app_data_dir, &file_name);
        return None;
    }
    Some((state, retry_at))
}

fn rate_limit_is_active(
    app_data_dir: &Path,
    config: &CustomQuotaEndpointConfig,
    now: DateTime<Utc>,
) -> bool {
    let _persistence = persistence_guard();
    load_rate_limit_state_unlocked(app_data_dir, config, now)
        .is_some_and(|(_, retry_at)| retry_at > now)
}

fn retry_after_seconds(value: Option<&str>, now: DateTime<Utc>) -> Option<u64> {
    let value = value?.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.min(MAX_RETRY_AFTER_SECONDS));
    }
    let retry_at = DateTime::parse_from_rfc2822(value)
        .ok()?
        .with_timezone(&Utc);
    let seconds = retry_at.signed_duration_since(now).num_seconds();
    (seconds > 0).then_some((seconds as u64).min(MAX_RETRY_AFTER_SECONDS))
}

fn register_rate_limit(
    app_data_dir: &Path,
    config: &CustomQuotaEndpointConfig,
    retry_after: Option<&str>,
    now: DateTime<Utc>,
) {
    let _persistence = persistence_guard();
    let consecutive = load_rate_limit_state_unlocked(app_data_dir, config, now)
        .map(|(state, _)| state.consecutive_limits.saturating_add(1))
        .unwrap_or(1)
        .min(16);
    let exponent = u32::from(consecutive.saturating_sub(1).min(6));
    let exponential = DEFAULT_RATE_LIMIT_BACKOFF_SECONDS
        .saturating_mul(1_u64 << exponent)
        .min(MAX_EXPONENTIAL_BACKOFF_SECONDS);
    let delay = exponential
        .max(retry_after_seconds(retry_after, now).unwrap_or(0))
        .min(MAX_RETRY_AFTER_SECONDS);
    let state = RateLimitState {
        schema_version: RATE_LIMIT_STATE_SCHEMA_VERSION,
        retry_at: format_timestamp(now + chrono::Duration::seconds(delay as i64)),
        consecutive_limits: consecutive,
    };
    if let Ok(bytes) = serde_json::to_vec(&state) {
        if bytes.len() <= MAX_RATE_LIMIT_STATE_BYTES {
            let _ = atomic_write_private(app_data_dir, &rate_limit_file_name(config), &bytes);
        }
    }
}

fn clear_rate_limit(app_data_dir: &Path, config: &CustomQuotaEndpointConfig) {
    let _persistence = persistence_guard();
    remove_persisted_snapshot(app_data_dir, &rate_limit_file_name(config));
}

fn error_envelope(
    config: &CustomQuotaEndpointConfig,
    status: QuotaStatus,
    reason: &str,
) -> QuotaProviderEnvelope {
    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: provider_id(&config.id),
        display_name: config.display_name.clone(),
        scope: QuotaScope::ApiOrganization,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::PlanDependent,
        status,
        windows: Vec::new(),
        reason_code: Some(reason.to_string()),
        action: None,
    }
}

fn value_at<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(root, |value, key| value.get(*key))
}

fn number_at(root: &Value, paths: &[&[&str]]) -> Result<Option<f64>, ()> {
    let mut selected = None;
    let mut saw_null = false;
    for path in paths {
        let Some(value) = value_at(root, path) else {
            continue;
        };
        let number = match value {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => text.parse::<f64>().ok(),
            Value::Null => {
                saw_null = true;
                continue;
            }
            _ => None,
        }
        .ok_or(())?;
        if !number.is_finite() || number < 0.0 {
            return Err(());
        }
        if saw_null || selected.is_some_and(|current: f64| (current - number).abs() > 0.000_001) {
            return Err(());
        }
        selected = Some(number);
    }
    if saw_null && selected.is_some() {
        return Err(());
    }
    Ok(selected)
}

fn observed_at(root: &Value, fetched_at: DateTime<Utc>) -> String {
    for path in [
        &["observed_at"][..],
        &["observedAt"][..],
        &["generated_at"][..],
        &["generatedAt"][..],
        &["timestamp"][..],
    ] {
        let Some(text) = value_at(root, path).and_then(Value::as_str) else {
            continue;
        };
        let Ok(parsed) = DateTime::parse_from_rfc3339(text) else {
            continue;
        };
        let parsed = parsed.with_timezone(&Utc);
        if parsed <= fetched_at + chrono::Duration::minutes(5) {
            return format_timestamp(parsed);
        }
    }
    format_timestamp(fetched_at)
}

struct PercentWindowSpec<'a> {
    id: &'a str,
    label: &'a str,
    window_minutes: Option<u64>,
    used_paths: &'a [&'a [&'a str]],
    limit_paths: &'a [&'a [&'a str]],
}

fn percent_window(
    root: &Value,
    provider: &str,
    observed_at: &str,
    fetched_at: &str,
    spec: PercentWindowSpec<'_>,
) -> Result<Option<QuotaWindowSnapshot>, ()> {
    let used = number_at(root, spec.used_paths)?;
    let limit = number_at(root, spec.limit_paths)?;
    let (Some(used), Some(limit)) = (used, limit) else {
        return if used.is_none() && limit.is_none() {
            Ok(None)
        } else {
            Err(())
        };
    };
    if limit <= 0.0 || used > limit {
        return Err(());
    }
    let used_percent = used / limit * 100.0;
    Ok(Some(QuotaWindowSnapshot {
        provider_id: provider.to_string(),
        window_id: spec.id.to_string(),
        window_label: spec.label.to_string(),
        account_label: None,
        scope: QuotaScope::ApiOrganization,
        source: QuotaSource::OfficialApi,
        status: QuotaWindowStatus::Ok,
        used: Some(used_percent),
        limit: Some(100.0),
        remaining: Some(100.0 - used_percent),
        unit: QuotaUnit::Percent,
        currency: None,
        window_minutes: spec.window_minutes,
        resets_at: None,
        observed_at: observed_at.to_string(),
        fetched_at: fetched_at.to_string(),
        stale_after_seconds: STALE_AFTER_SECONDS,
        reason_code: None,
    }))
}

fn parse_quota_response(
    config: &CustomQuotaEndpointConfig,
    root: &Value,
    fetched_at: DateTime<Utc>,
) -> Result<QuotaProviderEnvelope, ()> {
    let root = root
        .get("data")
        .filter(|value| value.is_object())
        .unwrap_or(root);
    if !root.is_object() {
        return Err(());
    }
    let provider = provider_id(&config.id);
    let observed_at = observed_at(root, fetched_at);
    let fetched_at = format_timestamp(fetched_at);
    let mut windows = Vec::new();

    let specs = [
        PercentWindowSpec {
            id: "key-daily",
            label: "API Key 今日限额",
            window_minutes: Some(1_440),
            used_paths: &[&["key_day_cost_cny"]],
            limit_paths: &[&["key_daily_limit_effective_cny"]],
        },
        PercentWindowSpec {
            id: "user-daily",
            label: "用户今日限额",
            window_minutes: Some(1_440),
            used_paths: &[&["user_quota", "day_cost_cny"]],
            limit_paths: &[&["user_quota", "day_limit_cny"]],
        },
        PercentWindowSpec {
            id: "user-monthly",
            label: "用户本月限额",
            window_minutes: None,
            used_paths: &[&["user_quota", "month_cost_cny"]],
            limit_paths: &[&["user_quota", "month_limit_cny"]],
        },
    ];
    for spec in specs {
        if let Some(window) = percent_window(root, &provider, &observed_at, &fetched_at, spec)? {
            windows.push(window);
        }
    }
    if windows.is_empty() {
        return Err(());
    }
    Ok(QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: provider,
        display_name: config.display_name.clone(),
        scope: QuotaScope::ApiOrganization,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::PlanDependent,
        status: QuotaStatus::Ok,
        windows,
        reason_code: None,
        action: None,
    })
}

fn with_matching_current_config<R>(
    app: &AppContext,
    config: &CustomQuotaEndpointConfig,
    action: impl FnOnce() -> R,
) -> Option<R> {
    let _mutation = lock_endpoint_mutations();
    let current = settings::load_settings_result(app).ok()?;
    current
        .quota_custom_endpoints
        .iter()
        .any(|saved| saved.id == config.id && saved.enabled && saved.url == config.url)
        .then(action)
}

fn capture_current_key<F>(
    app: &AppContext,
    expected: &CustomQuotaEndpointConfig,
    retry: bool,
    read: &F,
) -> Option<(CustomQuotaEndpointConfig, Result<Option<String>, String>)>
where
    F: Fn(&str, bool) -> Result<Option<String>, String>,
{
    let _mutation = lock_endpoint_mutations();
    let current = settings::load_settings_result(app).ok()?;
    let config = current
        .quota_custom_endpoints
        .into_iter()
        .find(|config| config.id == expected.id && config.enabled)?;
    if !same_endpoint_origin(&expected.url, &config.url) {
        return None;
    }
    let key =
        read(&config.id, retry).map(|raw| raw.and_then(|raw| decode_bound_key(&raw, &config.url)));
    Some((config, key))
}

async fn request_provider(
    app: &AppContext,
    config: &CustomQuotaEndpointConfig,
    api_key: &str,
) -> QuotaProviderEnvelope {
    let now = Utc::now();
    if with_matching_current_config(app, config, || ()).is_none() {
        return error_envelope(config, QuotaStatus::Error, "source_temporarily_unavailable");
    }
    let app_data_dir = app.app_data_dir();
    if rate_limit_is_active(app_data_dir, config, now) {
        return error_envelope(config, QuotaStatus::Error, "rate_limited");
    }
    let client = match reqwest::Client::builder()
        .redirect(redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return error_envelope(config, QuotaStatus::Error, "upstream_unavailable"),
    };
    let response = match client
        .get(&config.url)
        .header(ACCEPT, "application/json")
        .bearer_auth(api_key)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return error_envelope(config, QuotaStatus::Error, "upstream_unavailable"),
    };
    let status = response.status();
    if status == StatusCode::TOO_MANY_REQUESTS {
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok());
        let _ = with_matching_current_config(app, config, || {
            register_rate_limit(app_data_dir, config, retry_after, Utc::now());
        });
        return error_envelope(config, QuotaStatus::Error, "rate_limited");
    }
    let _ = with_matching_current_config(app, config, || clear_rate_limit(app_data_dir, config));
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return error_envelope(config, QuotaStatus::AuthRequired, "api_key_required");
        }
        status if status.is_server_error() => {
            return error_envelope(config, QuotaStatus::Error, "upstream_unavailable");
        }
        status if !status.is_success() => {
            return error_envelope(config, QuotaStatus::Error, "source_temporarily_unavailable");
        }
        _ => {}
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return error_envelope(config, QuotaStatus::Error, "source_schema_unsupported");
    }
    let mut response = response;
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                    return error_envelope(config, QuotaStatus::Error, "source_schema_unsupported");
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return error_envelope(config, QuotaStatus::Error, "upstream_unavailable"),
        }
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return error_envelope(config, QuotaStatus::Error, "source_schema_unsupported");
    };
    parse_quota_response(config, &value, now)
        .unwrap_or_else(|_| error_envelope(config, QuotaStatus::Error, "source_schema_unsupported"))
}

pub(crate) async fn collect_custom_providers(
    app: &AppContext,
    configs: &[CustomQuotaEndpointConfig],
    retry_keyring_read: bool,
) -> Vec<QuotaProviderEnvelope> {
    collect_custom_providers_with_reader(app, configs, retry_keyring_read, &load_api_key_for_read)
        .await
}

async fn collect_custom_providers_with_reader<F>(
    app: &AppContext,
    configs: &[CustomQuotaEndpointConfig],
    retry_keyring_read: bool,
    read: &F,
) -> Vec<QuotaProviderEnvelope>
where
    F: Fn(&str, bool) -> Result<Option<String>, String>,
{
    let mut tasks = Vec::new();
    for config in configs.iter().filter(|config| config.enabled) {
        remove_legacy_endpoint_snapshots(app.app_data_dir(), &config.id);
        let Some((config, api_key)) = capture_current_key(app, config, retry_keyring_read, read)
        else {
            continue;
        };
        let worker_app = app.clone();
        tasks.push((
            config.clone(),
            tauri::async_runtime::spawn(async move {
                match api_key {
                    Ok(Some(api_key)) => request_provider(&worker_app, &config, &api_key).await,
                    Ok(None) => {
                        error_envelope(&config, QuotaStatus::AuthRequired, "api_key_required")
                    }
                    Err(_) => {
                        error_envelope(&config, QuotaStatus::Error, "secure_storage_unavailable")
                    }
                }
            }),
        ));
    }
    let mut providers = Vec::with_capacity(tasks.len());
    for (config, task) in tasks {
        let envelope = task.await.unwrap_or_else(|_| {
            error_envelope(&config, QuotaStatus::Error, "provider_worker_failed")
        });
        let provider = provider_id(&config.id);
        if let Some(envelope) = with_matching_current_config(app, &config, || {
            if RESPONSE_SCHEMA_VERIFIED {
                finalize_with_persisted_last_good(
                    app.app_data_dir(),
                    &last_good_file_name(&config),
                    &provider,
                    envelope,
                    Utc::now(),
                )
            } else {
                remove_persisted_snapshot(app.app_data_dir(), &last_good_file_name(&config));
                remove_persisted_snapshot(
                    app.app_data_dir(),
                    &format!("quota_lkg_custom_{}.json", config.id),
                );
                envelope
            }
        }) {
            providers.push(envelope);
        }
    }
    providers
}

pub(crate) fn is_enabled_provider(provider: &str, configs: &[CustomQuotaEndpointConfig]) -> bool {
    config_id_from_provider_id(provider).is_some_and(|id| {
        configs
            .iter()
            .any(|config| config.id == id && config.enabled)
    })
}

pub(crate) fn is_sync_enabled_provider(
    provider: &str,
    configs: &[CustomQuotaEndpointConfig],
) -> bool {
    RESPONSE_SCHEMA_VERIFIED && is_enabled_provider(provider, configs)
}

pub(crate) fn suppress_unverified_remote_envelope(
    mut envelope: QuotaProviderEnvelope,
) -> QuotaProviderEnvelope {
    if !RESPONSE_SCHEMA_VERIFIED && config_id_from_provider_id(&envelope.provider_id).is_some() {
        envelope.capability = QuotaCapability::Experimental;
        envelope.status = QuotaStatus::Error;
        envelope.windows.clear();
        envelope.reason_code = Some("source_schema_unsupported".to_string());
        envelope.action = None;
    }
    envelope
}

pub(crate) fn remove_disabled_last_good(
    app_data_dir: &Path,
    configs: &[CustomQuotaEndpointConfig],
) {
    for config in configs.iter().filter(|config| !config.enabled) {
        remove_endpoint_snapshots(app_data_dir, config);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::thread;

    fn config() -> CustomQuotaEndpointConfig {
        CustomQuotaEndpointConfig {
            id: "0123456789abcdef01234567".to_string(),
            display_name: "公司研发额度".to_string(),
            url: "https://gateway.example.com/v1/me/quota".to_string(),
            enabled: true,
            api_key_configured: None,
        }
    }

    #[test]
    fn listing_endpoint_view_uses_non_secret_metadata_without_keyring_access() {
        let mut configured = config();
        configured.api_key_configured = Some(true);
        let view = view_for(&configured).expect("view should not need keyring access");
        assert_eq!(view.has_api_key, None);

        let unverified = view_for(&config()).expect("legacy view should remain readable");
        assert_eq!(unverified.has_api_key, None);
    }

    #[test]
    fn keyring_failure_cache_requires_explicit_retry() {
        let id = format!("test-keyring-cache-{}", std::process::id());
        clear_keyring_read_failure(&id);

        let first = load_api_key_with_failure_cache(&id, false, || {
            Err("无法读取系统安全存储中的公司 API key。".to_string())
        });
        assert_eq!(
            first,
            Err("无法读取系统安全存储中的公司 API key。".to_string())
        );

        let cached = load_api_key_with_failure_cache(&id, false, || {
            panic!("cached failure must not read the keyring again")
        });
        assert_eq!(cached, first);

        let recovered =
            load_api_key_with_failure_cache(&id, true, || Ok(Some("recovered-key".to_string())));
        assert_eq!(recovered, Ok(Some("recovered-key".to_string())));

        clear_keyring_read_failure(&id);
    }

    fn temporary_app_data(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "tokenledger-custom-quota-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn endpoint_url_defaults_to_the_documented_quota_path_and_rejects_secret_leaks() {
        assert_eq!(
            normalize_endpoint_url("https://gateway.example.com").expect("base URL"),
            "https://gateway.example.com/v1/me/quota"
        );
        assert!(normalize_endpoint_url("http://gateway.example.com/v1/me/quota").is_err());
        assert!(
            normalize_endpoint_url("https://user:pass@gateway.example.com/v1/me/quota").is_err()
        );
        assert!(
            normalize_endpoint_url("https://gateway.example.com/v1/me/quota?key=secret").is_err()
        );
        assert!(normalize_endpoint_url("http://127.0.0.1:39871/v1/me/quota").is_ok());
    }

    #[test]
    fn verified_cny_cost_and_limit_fields_become_three_percent_windows() {
        let value = serde_json::json!({
            "key_name": "redacted",
            "auth_type": "bearer",
            "quota_unlimited": false,
            "quota_remaining_cny": 937.5,
            "daily_limit_cny": null,
            "expires_at": 1_800_000_000,
            "key_day_cost_cny": 12.5,
            "key_daily_limit_effective_cny": 50,
            "user_quota": {
                "day_cost_cny": 20,
                "day_limit_cny": 100,
                "month_cost_cny": 70,
                "month_limit_cny": 200,
                "usage_ratio_pct": 99,
                "near_limit": false,
                "blocked": false,
                "blocked_models": {"expensive": true}
            },
            "secret": "must-not-cross-envelope"
        });
        let envelope = parse_quota_response(
            &config(),
            &value,
            DateTime::parse_from_rfc3339("2026-08-04T16:01:00Z")
                .expect("time")
                .with_timezone(&Utc),
        )
        .expect("quota response");
        assert_eq!(envelope.scope, QuotaScope::ApiOrganization);
        assert_eq!(envelope.capability, QuotaCapability::PlanDependent);
        assert_eq!(envelope.windows.len(), 3);
        assert_eq!(envelope.windows[0].used, Some(25.0));
        assert_eq!(envelope.windows[1].used, Some(20.0));
        assert_eq!(envelope.windows[2].used, Some(35.0));
        let wire = serde_json::to_string(&envelope).expect("wire");
        assert!(!wire.contains("secret"));
        assert!(!wire.contains("quota_remaining_cny"));
        assert!(!wire.contains("usage_ratio_pct"));
        assert!(!wire.contains("blocked_models"));
    }

    #[test]
    fn incomplete_over_limit_or_unknown_payloads_fail_closed() {
        assert!(parse_quota_response(
            &config(),
            &serde_json::json!({"user_quota": {"day_cost_cny": 1}}),
            Utc::now(),
        )
        .is_err());
        assert!(parse_quota_response(
            &config(),
            &serde_json::json!({"user_quota": {"day_cost_cny": 11, "day_limit_cny": 10}}),
            Utc::now(),
        )
        .is_err());
        assert!(
            parse_quota_response(&config(), &serde_json::json!({"balance": 100}), Utc::now())
                .is_err()
        );
        assert_eq!(
            number_at(
                &serde_json::json!({"first": 1, "second": 2}),
                &[&["first"], &["second"]]
            ),
            Err(())
        );
    }

    #[test]
    fn an_existing_endpoint_can_be_disabled_without_reloading_a_missing_key() {
        assert!(endpoint_requires_api_key(false, false));
        assert!(endpoint_requires_api_key(false, true));
        assert!(endpoint_requires_api_key(true, true));
        assert!(!endpoint_requires_api_key(true, false));
    }

    #[derive(Default)]
    struct TestCredentials {
        keys: HashMap<String, String>,
        store_calls: usize,
        fail_store_on: Option<usize>,
    }

    impl CustomQuotaCredentialStore for TestCredentials {
        fn load(&mut self, id: &str) -> Result<Option<String>, String> {
            Ok(self.keys.get(id).cloned())
        }

        fn store(&mut self, id: &str, key: &str) -> Result<(), String> {
            self.store_calls += 1;
            if self.fail_store_on == Some(self.store_calls) {
                return Err("fixture keyring write failure".to_string());
            }
            self.keys.insert(id.to_string(), key.to_string());
            Ok(())
        }

        fn delete(&mut self, id: &str) -> Result<(), String> {
            self.keys.remove(id);
            Ok(())
        }
    }

    fn update_input(
        url: &str,
        enabled: bool,
        api_key: Option<&str>,
    ) -> UpsertCustomQuotaEndpointInput {
        UpsertCustomQuotaEndpointInput {
            id: Some(config().id),
            display_name: "公司研发额度".to_string(),
            url: url.to_string(),
            api_key: api_key.map(str::to_string),
            enabled,
        }
    }

    #[test]
    fn bound_key_requires_exact_origin_and_legacy_json_is_not_a_bound_credential() {
        let url = "https://GATEWAY.EXAMPLE.COM:443/old";
        let encoded = encode_bound_key(url, r#"{"user":"api-key"}"#).expect("bound key");
        assert_eq!(
            decode_bound_key(&encoded, "https://gateway.example.com/new").as_deref(),
            Some(r#"{"user":"api-key"}"#)
        );
        assert_eq!(
            decode_bound_key(&encoded, "https://gateway.example.com:8443/new"),
            None
        );
        assert_eq!(decode_bound_key(r#"{"user":"api-key"}"#, url), None);
        assert_eq!(decode_bound_key("old-test-key", url), None);
        let extra = format!(
            "{BOUND_KEY_PREFIX}{}",
            r#"{"marker":"tokenledger-custom-quota-key","version":1,"origin":"https|gateway.example.com|443","key":"test","extra":true}"#
        );
        assert_eq!(decode_bound_key(&extra, url), None);
    }

    #[test]
    fn legacy_key_requires_reentry_and_listing_does_not_claim_it_is_usable() {
        let app_data_dir = temporary_app_data("legacy-bound-key");
        let app = AppContext::for_test(app_data_dir.clone());
        let mut existing = config();
        existing.api_key_configured = Some(true);
        settings::replace_custom_quota_endpoints(&app, vec![existing]).expect("fixture config");
        let mut credentials = TestCredentials::default();
        credentials
            .keys
            .insert(config().id, "old-test-key".to_string());
        assert_eq!(list_views(&app).unwrap()[0].has_api_key, None);
        let refresh = tauri::async_runtime::block_on(collect_custom_providers_with_reader(
            &app,
            &[config()],
            true,
            &|id, _| Ok(credentials.keys.get(id).cloned()),
        ));
        assert_eq!(refresh[0].status, QuotaStatus::AuthRequired);
        assert_eq!(refresh[0].reason_code.as_deref(), Some("api_key_required"));
        let error = upsert_custom_quota_endpoint_with_store(
            &app,
            update_input(&config().url, true, None),
            &mut credentials,
        )
        .expect_err("legacy key must require reentry");
        assert!(error.contains("重新输入 API key"));
        let saved = upsert_custom_quota_endpoint_with_store(
            &app,
            update_input(&config().url, true, Some("new-test-key")),
            &mut credentials,
        )
        .expect("explicit reentry");
        assert_eq!(saved[0].has_api_key, Some(true));
        assert_eq!(list_views(&app).unwrap()[0].has_api_key, None);
        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn failed_metadata_save_and_failed_key_restore_remain_origin_fail_closed() {
        let app_data_dir = temporary_app_data("failed-rollback");
        let app = AppContext::for_test(app_data_dir.clone());
        settings::replace_custom_quota_endpoints(&app, vec![config()]).expect("fixture config");
        let mut credentials = TestCredentials::default();
        credentials.keys.insert(
            config().id,
            encode_bound_key(&config().url, "old-test-key").unwrap(),
        );
        credentials.fail_store_on = Some(2);
        let error = upsert_custom_quota_endpoint_with_store_and_save(
            &app,
            update_input(
                "https://other.example/v1/me/quota",
                true,
                Some("new-test-key"),
            ),
            &mut credentials,
            |_, _| Err("fixture settings failure".to_string()),
        )
        .expect_err("settings save and rollback both fail");
        assert!(error.contains("无法恢复"));
        assert_eq!(
            settings::load_settings_result(&app)
                .unwrap()
                .quota_custom_endpoints[0]
                .url,
            config().url
        );
        assert_eq!(
            decode_bound_key(credentials.keys.get(&config().id).unwrap(), &config().url),
            None
        );
        assert_eq!(
            decode_bound_key(
                credentials.keys.get(&config().id).unwrap(),
                "https://other.example/v1/me/quota"
            )
            .as_deref(),
            Some("new-test-key")
        );
        let refresh = tauri::async_runtime::block_on(collect_custom_providers_with_reader(
            &app,
            &[config()],
            true,
            &|id, _| Ok(credentials.keys.get(id).cloned()),
        ));
        assert_eq!(refresh[0].status, QuotaStatus::AuthRequired);
        assert_eq!(refresh[0].reason_code.as_deref(), Some("api_key_required"));
        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn collector_skips_stale_origin_before_reading_key_or_contacting_server() {
        let source = TcpListener::bind("127.0.0.1:0").expect("old source");
        source.set_nonblocking(true).expect("nonblocking source");
        let mut old = config();
        old.url = format!("http://{}/v1/me/quota", source.local_addr().unwrap());
        let mut current = old.clone();
        current.url = "http://127.0.0.1:39999/v1/me/quota".to_string();
        let app_data_dir = temporary_app_data("stale-collector");
        let app = AppContext::for_test(app_data_dir.clone());
        settings::replace_custom_quota_endpoints(&app, vec![current]).expect("current config");
        let reads = AtomicUsize::new(0);
        let providers = tauri::async_runtime::block_on(collect_custom_providers_with_reader(
            &app,
            &[old],
            true,
            &|_, _| {
                reads.fetch_add(1, Ordering::SeqCst);
                Ok(Some("fixture-key".to_string()))
            },
        ));
        assert!(providers.is_empty());
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert!(
            matches!(source.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn late_old_origin_429_cannot_write_new_origin_backoff() {
        let source = TcpListener::bind("127.0.0.1:0").expect("old source");
        let mut old = config();
        old.url = format!("http://{}/v1/me/quota", source.local_addr().unwrap());
        let mut current = old.clone();
        current.url = "http://127.0.0.1:39999/v1/me/quota".to_string();
        let app_data_dir = temporary_app_data("late-429");
        let app = AppContext::for_test(app_data_dir.clone());
        settings::replace_custom_quota_endpoints(&app, vec![old.clone()]).expect("old config");
        let (seen_tx, seen_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = source.accept().expect("old request");
            let mut request = [0_u8; 2048];
            stream.read(&mut request).expect("read request");
            seen_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            write!(stream, "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 3600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let worker_app = app.clone();
        let worker_old = old.clone();
        let worker = thread::spawn(move || {
            tauri::async_runtime::block_on(request_provider(
                &worker_app,
                &worker_old,
                "fixture-key",
            ))
        });
        seen_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("request started");
        settings::replace_custom_quota_endpoints(&app, vec![current.clone()]).expect("new config");
        release_tx.send(()).unwrap();
        let _ = worker.join().expect("worker");
        server.join().expect("server");
        assert!(!app_data_dir.join(rate_limit_file_name(&old)).exists());
        assert!(!app_data_dir.join(rate_limit_file_name(&current)).exists());
        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn collected_429_backoff_prevents_a_second_http_request() {
        let source = TcpListener::bind("127.0.0.1:0").expect("fixture source");
        let server_listener = source.try_clone().expect("server listener");
        let mut config = config();
        config.url = format!("http://{}/v1/me/quota", source.local_addr().unwrap());
        let app_data_dir = temporary_app_data("collected-429");
        let app = AppContext::for_test(app_data_dir.clone());
        settings::replace_custom_quota_endpoints(&app, vec![config.clone()])
            .expect("fixture config");
        let server = thread::spawn(move || {
            let (mut stream, _) = server_listener.accept().expect("first request");
            let mut request = [0_u8; 2048];
            stream.read(&mut request).expect("read request");
            write!(stream, "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 3600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let raw = encode_bound_key(&config.url, "fixture-key").unwrap();
        let collect = || {
            tauri::async_runtime::block_on(collect_custom_providers_with_reader(
                &app,
                &[config.clone()],
                true,
                &|_, _| Ok(Some(raw.clone())),
            ))
        };
        let first = collect();
        server.join().expect("fixture server");
        assert_eq!(first[0].reason_code.as_deref(), Some("rate_limited"));
        assert!(app_data_dir.join(rate_limit_file_name(&config)).exists());
        source.set_nonblocking(true).expect("nonblocking source");
        let second = collect();
        assert_eq!(second[0].reason_code.as_deref(), Some("rate_limited"));
        assert!(
            matches!(source.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn late_old_origin_success_cannot_recreate_new_origin_last_good() {
        let source = TcpListener::bind("127.0.0.1:0").expect("old source");
        let mut old = config();
        old.url = format!("http://{}/v1/me/quota", source.local_addr().unwrap());
        let mut current = old.clone();
        current.url = "http://127.0.0.1:39999/v1/me/quota".to_string();
        let app_data_dir = temporary_app_data("late-lkg");
        let app = AppContext::for_test(app_data_dir.clone());
        settings::replace_custom_quota_endpoints(&app, vec![old.clone()]).expect("old config");
        let (seen_tx, seen_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = source.accept().expect("old request");
            let mut request = [0_u8; 2048];
            stream.read(&mut request).expect("read request");
            seen_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let body = r#"{"key_day_cost_cny":1,"key_daily_limit_effective_cny":10}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let worker_app = app.clone();
        let worker_old = old.clone();
        let raw = encode_bound_key(&old.url, "fixture-key").unwrap();
        let worker = thread::spawn(move || {
            tauri::async_runtime::block_on(collect_custom_providers_with_reader(
                &worker_app,
                &[worker_old],
                true,
                &|_, _| Ok(Some(raw.clone())),
            ))
        });
        seen_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("request started");
        settings::replace_custom_quota_endpoints(&app, vec![current.clone()]).expect("new config");
        release_tx.send(()).unwrap();
        assert!(worker.join().expect("worker").is_empty());
        server.join().expect("server");
        assert!(!app_data_dir.join(last_good_file_name(&old)).exists());
        assert!(!app_data_dir.join(last_good_file_name(&current)).exists());
        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn saved_origin_change_requires_new_key_and_disabled_change_removes_old_key() {
        let app_data_dir = temporary_app_data("origin-change");
        let app = AppContext::for_test(app_data_dir.clone());
        settings::replace_custom_quota_endpoints(&app, vec![config()]).expect("fixture config");
        let id = config().id;
        let mut credentials = TestCredentials::default();
        credentials.keys.insert(
            id.clone(),
            encode_bound_key(&config().url, "old-test-key").unwrap(),
        );

        let new_url = "https://other.example/v1/me/quota";
        assert!(upsert_custom_quota_endpoint_with_store(
            &app,
            update_input(new_url, true, None),
            &mut credentials
        )
        .is_err());
        assert_eq!(
            credentials
                .keys
                .get(&id)
                .and_then(|raw| decode_bound_key(raw, &config().url))
                .as_deref(),
            Some("old-test-key")
        );
        assert_eq!(
            settings::load_settings_result(&app)
                .unwrap()
                .quota_custom_endpoints[0]
                .url,
            config().url
        );

        upsert_custom_quota_endpoint_with_store(
            &app,
            update_input(new_url, false, None),
            &mut credentials,
        )
        .expect("disabled origin change");
        assert!(!credentials.keys.contains_key(&id));
        let saved = &settings::load_settings_result(&app)
            .unwrap()
            .quota_custom_endpoints[0];
        assert_eq!(saved.url, new_url);
        assert_eq!(saved.api_key_configured, Some(false));
        assert!(upsert_custom_quota_endpoint_with_store(
            &app,
            update_input(new_url, true, None),
            &mut credentials
        )
        .is_err());
        assert!(!credentials.keys.contains_key(&id));
        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn saved_same_origin_path_change_reuses_key_but_port_change_needs_replacement() {
        assert!(!same_endpoint_origin(
            "http://127.0.0.1:443/old",
            "https://127.0.0.1:443/new"
        ));
        let app_data_dir = temporary_app_data("origin-port");
        let app = AppContext::for_test(app_data_dir.clone());
        settings::replace_custom_quota_endpoints(&app, vec![config()]).expect("fixture config");
        let id = config().id;
        let mut credentials = TestCredentials::default();
        credentials.keys.insert(
            id.clone(),
            encode_bound_key(&config().url, "old-test-key").unwrap(),
        );

        upsert_custom_quota_endpoint_with_store(
            &app,
            update_input("https://GATEWAY.EXAMPLE.COM:443/other/path", true, None),
            &mut credentials,
        )
        .expect("same effective origin");
        assert_eq!(
            credentials
                .keys
                .get(&id)
                .and_then(|raw| decode_bound_key(raw, &config().url))
                .as_deref(),
            Some("old-test-key")
        );
        assert!(upsert_custom_quota_endpoint_with_store(
            &app,
            update_input("https://gateway.example.com:8443/other/path", true, None),
            &mut credentials
        )
        .is_err());
        let stale_snapshot = app_data_dir.join(last_good_file_name(
            &settings::load_settings_result(&app)
                .unwrap()
                .quota_custom_endpoints[0],
        ));
        fs::write(&stale_snapshot, b"fixture-old-origin").expect("fixture snapshot");
        upsert_custom_quota_endpoint_with_store(
            &app,
            update_input(
                "https://gateway.example.com:8443/other/path",
                true,
                Some("new-test-key"),
            ),
            &mut credentials,
        )
        .expect("explicit key for new port");
        assert_eq!(
            credentials
                .keys
                .get(&id)
                .and_then(|raw| decode_bound_key(
                    raw,
                    "https://gateway.example.com:8443/other/path"
                ))
                .as_deref(),
            Some("new-test-key")
        );
        assert!(!stale_snapshot.exists());
        let _ = fs::remove_dir_all(app_data_dir);
    }

    #[test]
    fn retry_after_and_persisted_exponential_backoff_bound_repeated_requests() {
        let now = DateTime::parse_from_rfc3339("2026-08-05T08:00:00Z")
            .expect("time")
            .with_timezone(&Utc);
        assert_eq!(retry_after_seconds(Some("120"), now), Some(120));
        assert_eq!(
            retry_after_seconds(Some("Wed, 05 Aug 2026 08:03:00 GMT"), now),
            Some(180)
        );

        let app_data_dir = temporary_app_data("backoff");
        let config = config();
        register_rate_limit(&app_data_dir, &config, Some("120"), now);
        assert!(rate_limit_is_active(
            &app_data_dir,
            &config,
            now + chrono::Duration::seconds(119)
        ));
        assert!(!rate_limit_is_active(
            &app_data_dir,
            &config,
            now + chrono::Duration::seconds(121)
        ));
        register_rate_limit(
            &app_data_dir,
            &config,
            None,
            now + chrono::Duration::seconds(121),
        );
        assert!(rate_limit_is_active(
            &app_data_dir,
            &config,
            now + chrono::Duration::seconds(240)
        ));
        clear_rate_limit(&app_data_dir, &config);
        assert!(!rate_limit_is_active(&app_data_dir, &config, now));
        let _ = fs::remove_dir(&app_data_dir);
    }

    #[test]
    fn verified_remote_custom_values_remain_visible_and_deletable_by_identity() {
        let envelope = parse_quota_response(
            &config(),
            &serde_json::json!({
                "key_day_cost_cny": 1,
                "key_daily_limit_effective_cny": 10
            }),
            Utc::now(),
        )
        .expect("fixture envelope");
        let provider_id = envelope.provider_id.clone();
        let suppressed = suppress_unverified_remote_envelope(envelope);
        assert_eq!(suppressed.provider_id, provider_id);
        assert_eq!(suppressed.status, QuotaStatus::Ok);
        assert_eq!(suppressed.capability, QuotaCapability::PlanDependent);
        assert_eq!(suppressed.windows.len(), 1);
        assert_eq!(suppressed.reason_code, None);
    }

    #[test]
    fn custom_provider_ids_are_stable_and_bounded() {
        let config = config();
        let provider = provider_id(&config.id);
        assert_eq!(
            config_id_from_provider_id(&provider),
            Some(config.id.as_str())
        );
        assert!(provider.len() <= 128);
        assert!(!is_enabled_provider(
            "company-openapi-invalid:id",
            &[config]
        ));
    }

    #[test]
    fn real_http_path_uses_bearer_auth_and_returns_only_normalized_windows() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
        let address = listener.local_addr().expect("fixture address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut request = vec![0_u8; 8 * 1024];
            let read = stream.read(&mut request).expect("read request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /v1/me/quota HTTP/1.1"));
            assert!(request.contains("\r\nauthorization: Bearer sk-test-only\r\n"));
            assert!(!request.contains("sk-test-only?"));
            let body = serde_json::json!({
                "key_day_cost_cny": 5,
                "key_daily_limit_effective_cny": 20,
                "user_quota": {"day_cost_cny": 1, "day_limit_cny": 10},
                "raw_secret": "never-forward"
            })
            .to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("write response");
        });
        let mut config = config();
        config.url = format!("http://{address}/v1/me/quota");
        let app_data_dir = temporary_app_data("http");
        let app = AppContext::for_test(app_data_dir.clone());
        settings::replace_custom_quota_endpoints(&app, vec![config.clone()])
            .expect("fixture config");
        let envelope =
            tauri::async_runtime::block_on(request_provider(&app, &config, "sk-test-only"));
        server.join().expect("fixture server");

        assert_eq!(envelope.status, QuotaStatus::Ok);
        assert_eq!(envelope.windows.len(), 2);
        let wire = serde_json::to_string(&envelope).expect("wire");
        assert!(!wire.contains("sk-test-only"));
        assert!(!wire.contains("raw_secret"));
        assert!(!wire.contains(&config.url));
        let _ = fs::remove_dir(&app_data_dir);
    }
}
