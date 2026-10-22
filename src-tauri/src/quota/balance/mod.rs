//! Vendor balance providers (ADR-018 U-108).
//!
//! Keys are the gateway's own `provider:<id>` keychain entries, read only and
//! never copied. Requests go to a fixed documented URL per vendor, or for a
//! relay to a user-configured URL on the relay's own origin. Only the amount
//! and currency leave this module; keys, URLs, and raw responses never enter
//! envelopes, LKG files, logs, or error strings.
//!
//! The experimental branch (ADR-018 U-109) reuses the same keys, request
//! gate, and limits for undocumented coding-plan usage endpoints; it never
//! sends a request before the user has accepted the current risk notice.

pub mod experimental;
mod plan_vendors;
mod vendors;

use std::collections::HashSet;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::header::{ACCEPT, RETRY_AFTER};
use reqwest::{redirect, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app_paths::AppContext;
use crate::gateway::{self, KeyringSecrets, ProviderRecord};

pub use vendors::BalanceVendor;
use vendors::{
    parse_relay_response, parse_vendor_response, validate_value_path, vendor_endpoint_for_base_url,
    vendor_url_allowed, BalanceAmount, VendorEndpoint,
};

use super::{
    atomic_write_private, finalize_with_persisted_last_good, format_timestamp, persistence_guard,
    read_bounded_private_file, remove_persisted_snapshot, valid_currency_code, QuotaCapability,
    QuotaMode, QuotaProviderEnvelope, QuotaScope, QuotaSource, QuotaStatus, QuotaUnit,
    QuotaWindowSnapshot, QuotaWindowStatus,
};

pub(crate) const PROVIDER_PREFIX: &str = "balance-";
const RELAY_PROVIDER_PREFIX: &str = "balance-relay-";
const CONFIG_FILE: &str = "quota_balance_sources_v1.json";
const CONFIG_SCHEMA_VERSION: u8 = 1;
const MAX_CONFIG_BYTES: usize = 64 * 1024;
const MAX_SOURCES: usize = 64;
const MAX_URL_BYTES: usize = 2_048;
const MAX_API_KEY_BYTES: usize = 8 * 1_024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const STALE_AFTER_SECONDS: u64 = 60 * 60;
const RATE_LIMIT_STATE_SCHEMA_VERSION: u8 = 1;
const MAX_RATE_LIMIT_STATE_BYTES: usize = 1_024;
const DEFAULT_RATE_LIMIT_BACKOFF_SECONDS: u64 = 60;
const MAX_EXPONENTIAL_BACKOFF_SECONDS: u64 = 60 * 60;
const MAX_RETRY_AFTER_SECONDS: u64 = 24 * 60 * 60;
static KEYRING_READ_FAILURES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayBalanceConfig {
    pub balance_url: String,
    pub value_path: String,
    pub currency: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BalanceSourceConfig {
    gateway_provider_id: String,
    enabled: bool,
    #[serde(default)]
    relay: Option<RelayBalanceConfig>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigFile {
    schema_version: u8,
    sources: Vec<BalanceSourceConfig>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceSourceView {
    pub gateway_provider_id: String,
    pub gateway_provider_name: String,
    pub host: String,
    pub vendor: BalanceVendor,
    pub provider_id: String,
    pub enabled: bool,
    pub relay: Option<RelayBalanceConfig>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBalanceSourceInput {
    pub gateway_provider_id: String,
    pub enabled: bool,
    #[serde(default)]
    pub relay: Option<RelayBalanceConfig>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RateLimitState {
    schema_version: u8,
    retry_at: String,
    consecutive_limits: u8,
}

/// What one enabled source will request; `request_url_allowed` re-checks the
/// URL against the vendor allowlist or relay origin right before sending.
#[derive(Clone, Debug)]
struct RequestPlan {
    provider_id: String,
    display_name: String,
    scope: QuotaScope,
    capability: QuotaCapability,
    url: Url,
    target: PlanTarget,
}

#[derive(Clone, Debug)]
enum PlanTarget {
    Vendor(VendorEndpoint),
    Relay {
        origin: Url,
        value_path: String,
        currency: String,
    },
    Experimental(plan_vendors::PlanEndpoint),
}

pub(crate) fn is_balance_provider_id(provider_id: &str) -> bool {
    provider_id
        .strip_prefix(PROVIDER_PREFIX)
        .is_some_and(|rest| !rest.is_empty())
}

fn vendor_provider_id(vendor: BalanceVendor) -> String {
    format!("{PROVIDER_PREFIX}{}", vendor.slug())
}

fn relay_provider_id(gateway_provider_id: &str) -> String {
    format!("{RELAY_PROVIDER_PREFIX}{gateway_provider_id}")
}

fn provider_id_for(record: &ProviderRecord) -> (BalanceVendor, String) {
    match vendor_endpoint_for_base_url(&record.base_url) {
        Some(endpoint) => (endpoint.vendor, vendor_provider_id(endpoint.vendor)),
        None => (BalanceVendor::Relay, relay_provider_id(&record.id)),
    }
}

fn file_slug(provider_id: &str) -> &str {
    provider_id
        .strip_prefix(PROVIDER_PREFIX)
        .unwrap_or(provider_id)
}

fn last_good_file_name(provider_id: &str) -> String {
    format!("quota_lkg_balance_{}.json", file_slug(provider_id))
}

fn rate_limit_file_name(provider_id: &str) -> String {
    format!("quota_rate_balance_{}.json", file_slug(provider_id))
}

fn gateway_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("gateway")
}

fn load_config(app_data_dir: &Path) -> Result<Vec<BalanceSourceConfig>, String> {
    let bytes = match read_bounded_private_file(app_data_dir, CONFIG_FILE, MAX_CONFIG_BYTES) {
        Ok(bytes) => bytes,
        Err(super::SnapshotFailure::Missing) => return Ok(Vec::new()),
        Err(_) => return Err("无法安全读取余额来源配置。".to_string()),
    };
    let file: ConfigFile =
        serde_json::from_slice(&bytes).map_err(|_| "余额来源配置已损坏。".to_string())?;
    if file.schema_version != CONFIG_SCHEMA_VERSION || file.sources.len() > MAX_SOURCES {
        return Err("余额来源配置版本不受支持。".to_string());
    }
    Ok(file.sources)
}

fn save_config(app_data_dir: &Path, sources: Vec<BalanceSourceConfig>) -> Result<(), String> {
    let bytes = serde_json::to_vec(&ConfigFile {
        schema_version: CONFIG_SCHEMA_VERSION,
        sources,
    })
    .map_err(|_| "无法保存余额来源配置。".to_string())?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err("余额来源配置过大。".to_string());
    }
    atomic_write_private(app_data_dir, CONFIG_FILE, &bytes)
        .map_err(|_| "无法安全保存余额来源配置。".to_string())
}

fn is_loopback_http(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        })
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str().map(str::to_ascii_lowercase)
            == right.host_str().map(str::to_ascii_lowercase)
        && left.port_or_known_default() == right.port_or_known_default()
}

/// Validates a relay balance URL against the relay provider's own base URL.
fn normalize_relay_config(
    record: &ProviderRecord,
    relay: &RelayBalanceConfig,
) -> Result<RelayBalanceConfig, String> {
    let raw = relay.balance_url.trim();
    if raw.is_empty() || raw.len() > MAX_URL_BYTES {
        return Err("余额地址为空或过长。".to_string());
    }
    let url = Url::parse(raw).map_err(|_| "余额地址不是有效 URL。".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("余额地址不能包含用户名或密码。".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("余额地址不能包含 query 或 fragment，API key 也不会写入 URL。".to_string());
    }
    if url.scheme() != "https" && !is_loopback_http(&url) {
        return Err("余额地址必须使用 HTTPS；仅本机 localhost 调试允许 HTTP。".to_string());
    }
    let origin =
        Url::parse(&record.base_url).map_err(|_| "中转供应商的接口地址无效。".to_string())?;
    if !same_origin(&url, &origin) {
        return Err(
            "余额地址必须与该中转供应商的接口地址同源（协议、域名与端口一致）。".to_string(),
        );
    }
    let value_path = relay.value_path.trim();
    if !validate_value_path(value_path) {
        return Err(
            "取值路径只能是用点分隔的字段名或数组下标，例如 data.balance，最多 8 段。".to_string(),
        );
    }
    let currency = relay.currency.trim();
    if !valid_currency_code(currency) {
        return Err("币种必须是三个大写字母的 ISO 4217 代码，例如 CNY、USD。".to_string());
    }
    Ok(RelayBalanceConfig {
        balance_url: url.to_string(),
        value_path: value_path.to_string(),
        currency: currency.to_string(),
    })
}

fn view_for(record: &ProviderRecord, config: Option<&BalanceSourceConfig>) -> BalanceSourceView {
    let (vendor, provider_id) = provider_id_for(record);
    BalanceSourceView {
        gateway_provider_id: record.id.clone(),
        gateway_provider_name: record.name.clone(),
        host: Url::parse(&record.base_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_default(),
        vendor,
        provider_id,
        enabled: config.is_some_and(|config| config.enabled),
        relay: if vendor == BalanceVendor::Relay {
            config.and_then(|config| config.relay.clone())
        } else {
            None
        },
    }
}

fn list_views_at(app_data_dir: &Path) -> Result<Vec<BalanceSourceView>, String> {
    let records = gateway::load_providers_readonly(&gateway_dir(app_data_dir))?;
    let configs = load_config(app_data_dir)?;
    Ok(records
        .iter()
        .map(|record| {
            let config = configs
                .iter()
                .find(|config| config.gateway_provider_id == record.id);
            view_for(record, config)
        })
        .collect())
}

pub fn list_quota_balance_sources_impl(app: &AppContext) -> Result<Vec<BalanceSourceView>, String> {
    list_views_at(app.app_data_dir())
}

pub fn set_quota_balance_source_impl(
    app: &AppContext,
    input: SetBalanceSourceInput,
) -> Result<Vec<BalanceSourceView>, String> {
    set_source_at(app.app_data_dir(), input)
}

fn set_source_at(
    app_data_dir: &Path,
    input: SetBalanceSourceInput,
) -> Result<Vec<BalanceSourceView>, String> {
    let records = gateway::load_providers_readonly(&gateway_dir(app_data_dir))?;
    let record = records
        .iter()
        .find(|record| record.id == input.gateway_provider_id)
        .ok_or_else(|| "要开启余额的供应商不存在，请先在「供应商」页添加。".to_string())?;
    let (vendor, provider_id) = provider_id_for(record);
    let mut configs = load_config(app_data_dir)?;
    let existing = configs
        .iter()
        .position(|config| config.gateway_provider_id == record.id);

    let relay = if vendor == BalanceVendor::Relay {
        match input.relay.as_ref() {
            Some(relay) => Some(normalize_relay_config(record, relay)?),
            None => existing.and_then(|index| configs[index].relay.clone()),
        }
    } else {
        None
    };
    if input.enabled {
        if vendor == BalanceVendor::Relay && relay.is_none() {
            return Err("中转余额需要先填写同源余额地址、取值路径和币种。".to_string());
        }
        if vendor != BalanceVendor::Relay {
            let duplicate = configs
                .iter()
                .filter(|config| config.enabled)
                .any(|config| {
                    config.gateway_provider_id != record.id
                        && records
                            .iter()
                            .find(|other| other.id == config.gateway_provider_id)
                            .is_some_and(|other| provider_id_for(other).1 == provider_id)
                });
            if duplicate {
                return Err(format!(
                    "{} 已在另一个供应商上开启，同一家只能开启一个。",
                    vendor.display_name()
                ));
            }
        }
    }
    let config = BalanceSourceConfig {
        gateway_provider_id: record.id.clone(),
        enabled: input.enabled,
        relay,
    };
    match existing {
        Some(index) => configs[index] = config,
        None => {
            if configs.len() >= MAX_SOURCES {
                return Err("余额来源过多。".to_string());
            }
            configs.push(config);
        }
    }
    // Drop entries whose gateway provider no longer exists.
    configs.retain(|config| {
        records
            .iter()
            .any(|record| record.id == config.gateway_provider_id)
    });
    save_config(app_data_dir, configs)?;
    if !input.enabled {
        let _persistence = persistence_guard();
        remove_persisted_snapshot(app_data_dir, &last_good_file_name(&provider_id));
        remove_persisted_snapshot(app_data_dir, &rate_limit_file_name(&provider_id));
    }
    list_views_at(app_data_dir)
}

/// Provider IDs that are currently enabled; used to drop results whose
/// authorization was revoked while a read was in flight.
pub(crate) fn enabled_provider_ids(app_data_dir: &Path) -> HashSet<String> {
    let (Ok(records), Ok(configs)) = (
        gateway::load_providers_readonly(&gateway_dir(app_data_dir)),
        load_config(app_data_dir),
    ) else {
        return HashSet::new();
    };
    configs
        .iter()
        .filter(|config| config.enabled)
        .filter_map(|config| {
            records
                .iter()
                .find(|record| record.id == config.gateway_provider_id)
                .map(|record| provider_id_for(record).1)
        })
        .collect()
}

fn plan_for(record: &ProviderRecord, config: &BalanceSourceConfig) -> Option<RequestPlan> {
    if let Some(endpoint) = vendor_endpoint_for_base_url(&record.base_url) {
        return Some(RequestPlan {
            provider_id: vendor_provider_id(endpoint.vendor),
            display_name: endpoint.vendor.display_name().to_string(),
            scope: QuotaScope::ApiOrganization,
            capability: QuotaCapability::Stable,
            url: Url::parse(endpoint.url).ok()?,
            target: PlanTarget::Vendor(endpoint),
        });
    }
    let relay = normalize_relay_config(record, config.relay.as_ref()?).ok()?;
    let name: String = record.name.trim().chars().take(48).collect();
    Some(RequestPlan {
        provider_id: relay_provider_id(&record.id),
        display_name: format!("{name} 余额"),
        scope: QuotaScope::ApiOrganization,
        capability: QuotaCapability::PlanDependent,
        url: Url::parse(&relay.balance_url).ok()?,
        target: PlanTarget::Relay {
            origin: Url::parse(&record.base_url).ok()?,
            value_path: relay.value_path,
            currency: relay.currency,
        },
    })
}

/// Final gate before any bytes leave the process.
fn request_url_allowed(plan: &RequestPlan, allow_loopback_vendor: bool) -> bool {
    let url = &plan.url;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    match &plan.target {
        PlanTarget::Vendor(_) => {
            vendor_url_allowed(url) || (allow_loopback_vendor && is_loopback_http(url))
        }
        PlanTarget::Relay { origin, .. } => {
            same_origin(url, origin) && (url.scheme() == "https" || is_loopback_http(url))
        }
        PlanTarget::Experimental(_) => {
            plan_vendors::plan_url_allowed(url) || (allow_loopback_vendor && is_loopback_http(url))
        }
    }
}

fn envelope(
    plan: &RequestPlan,
    status: QuotaStatus,
    reason: Option<&str>,
    windows: Vec<QuotaWindowSnapshot>,
) -> QuotaProviderEnvelope {
    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: plan.provider_id.clone(),
        display_name: plan.display_name.clone(),
        scope: plan.scope,
        mode: QuotaMode::Automatic,
        capability: plan.capability,
        status,
        windows,
        reason_code: reason.map(str::to_string),
        action: None,
    }
}

fn plan_error(plan: &RequestPlan, status: QuotaStatus, reason: &str) -> QuotaProviderEnvelope {
    envelope(plan, status, Some(reason), Vec::new())
}

fn balance_windows(
    provider_id: &str,
    amounts: Vec<BalanceAmount>,
    fetched_at: DateTime<Utc>,
) -> Vec<QuotaWindowSnapshot> {
    let timestamp = format_timestamp(fetched_at);
    amounts
        .into_iter()
        .map(|amount| QuotaWindowSnapshot {
            provider_id: provider_id.to_string(),
            window_id: format!("balance-{}", amount.currency.to_ascii_lowercase()),
            window_label: format!("余额（{}）", amount.currency),
            account_label: None,
            scope: QuotaScope::ApiOrganization,
            source: QuotaSource::OfficialApi,
            status: QuotaWindowStatus::Ok,
            used: None,
            limit: None,
            remaining: Some(amount.remaining),
            unit: QuotaUnit::Currency,
            currency: Some(amount.currency),
            window_minutes: None,
            resets_at: None,
            observed_at: timestamp.clone(),
            fetched_at: timestamp.clone(),
            stale_after_seconds: STALE_AFTER_SECONDS,
            reason_code: None,
        })
        .collect()
}

fn parse_plan_response(
    plan: &RequestPlan,
    root: &Value,
    fetched_at: DateTime<Utc>,
) -> QuotaProviderEnvelope {
    let amounts = match &plan.target {
        PlanTarget::Vendor(endpoint) => parse_vendor_response(endpoint, root),
        PlanTarget::Relay {
            value_path,
            currency,
            ..
        } => parse_relay_response(root, value_path, currency),
        PlanTarget::Experimental(endpoint) => {
            return match plan_vendors::parse_plan_response(endpoint.vendor, root, fetched_at) {
                Ok(windows) => envelope(
                    plan,
                    QuotaStatus::Ok,
                    None,
                    experimental::plan_windows(&plan.provider_id, windows, fetched_at),
                ),
                Err(()) => plan_error(plan, QuotaStatus::Error, "source_schema_unsupported"),
            };
        }
    };
    match amounts {
        Ok(amounts) if !amounts.is_empty() => envelope(
            plan,
            QuotaStatus::Ok,
            None,
            balance_windows(&plan.provider_id, amounts, fetched_at),
        ),
        _ => plan_error(plan, QuotaStatus::Error, "balance_unavailable"),
    }
}

fn load_rate_limit_state_unlocked(
    app_data_dir: &Path,
    provider_id: &str,
    now: DateTime<Utc>,
) -> Option<(RateLimitState, DateTime<Utc>)> {
    let file_name = rate_limit_file_name(provider_id);
    let bytes =
        read_bounded_private_file(app_data_dir, &file_name, MAX_RATE_LIMIT_STATE_BYTES).ok()?;
    let parsed = serde_json::from_slice::<RateLimitState>(&bytes)
        .ok()
        .and_then(|state| {
            let retry_at = DateTime::parse_from_rfc3339(&state.retry_at)
                .ok()?
                .with_timezone(&Utc);
            let valid = state.schema_version == RATE_LIMIT_STATE_SCHEMA_VERSION
                && state.consecutive_limits > 0
                && retry_at <= now + chrono::Duration::seconds(MAX_RETRY_AFTER_SECONDS as i64)
                && retry_at >= now - chrono::Duration::days(30);
            valid.then_some((state, retry_at))
        });
    if parsed.is_none() {
        remove_persisted_snapshot(app_data_dir, &file_name);
    }
    parsed
}

fn rate_limit_is_active(app_data_dir: &Path, provider_id: &str, now: DateTime<Utc>) -> bool {
    let _persistence = persistence_guard();
    load_rate_limit_state_unlocked(app_data_dir, provider_id, now)
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
    provider_id: &str,
    retry_after: Option<&str>,
    now: DateTime<Utc>,
) {
    let _persistence = persistence_guard();
    let consecutive = load_rate_limit_state_unlocked(app_data_dir, provider_id, now)
        .map(|(state, _)| state.consecutive_limits.saturating_add(1))
        .unwrap_or(1)
        .min(16);
    let exponent = u32::from(consecutive.saturating_sub(1).min(6));
    let delay = DEFAULT_RATE_LIMIT_BACKOFF_SECONDS
        .saturating_mul(1_u64 << exponent)
        .min(MAX_EXPONENTIAL_BACKOFF_SECONDS)
        .max(retry_after_seconds(retry_after, now).unwrap_or(0))
        .min(MAX_RETRY_AFTER_SECONDS);
    let state = RateLimitState {
        schema_version: RATE_LIMIT_STATE_SCHEMA_VERSION,
        retry_at: format_timestamp(now + chrono::Duration::seconds(delay as i64)),
        consecutive_limits: consecutive,
    };
    if let Ok(bytes) = serde_json::to_vec(&state) {
        if bytes.len() <= MAX_RATE_LIMIT_STATE_BYTES {
            let _ = atomic_write_private(app_data_dir, &rate_limit_file_name(provider_id), &bytes);
        }
    }
}

fn clear_rate_limit(app_data_dir: &Path, provider_id: &str) {
    let _persistence = persistence_guard();
    remove_persisted_snapshot(app_data_dir, &rate_limit_file_name(provider_id));
}

async fn request_plan(
    app_data_dir: &Path,
    plan: &RequestPlan,
    api_key: &str,
    allow_loopback_vendor: bool,
) -> QuotaProviderEnvelope {
    let now = Utc::now();
    if !request_url_allowed(plan, allow_loopback_vendor) {
        return plan_error(plan, QuotaStatus::Error, "source_schema_unsupported");
    }
    if rate_limit_is_active(app_data_dir, &plan.provider_id, now) {
        return plan_error(plan, QuotaStatus::Error, "rate_limited");
    }
    let Ok(client) = reqwest::Client::builder()
        .redirect(redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
    else {
        return plan_error(plan, QuotaStatus::Error, "upstream_unavailable");
    };
    let Ok(mut response) = client
        .get(plan.url.clone())
        .header(ACCEPT, "application/json")
        .bearer_auth(api_key)
        .send()
        .await
    else {
        return plan_error(plan, QuotaStatus::Error, "upstream_unavailable");
    };
    let status = response.status();
    if status == StatusCode::TOO_MANY_REQUESTS {
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok());
        register_rate_limit(app_data_dir, &plan.provider_id, retry_after, Utc::now());
        return plan_error(plan, QuotaStatus::Error, "rate_limited");
    }
    clear_rate_limit(app_data_dir, &plan.provider_id);
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return plan_error(plan, QuotaStatus::AuthRequired, "api_key_required");
        }
        status if status.is_server_error() => {
            return plan_error(plan, QuotaStatus::Error, "upstream_unavailable");
        }
        status if !status.is_success() => {
            return plan_error(plan, QuotaStatus::Error, "source_temporarily_unavailable");
        }
        _ => {}
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return plan_error(plan, QuotaStatus::Error, "source_schema_unsupported");
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                    return plan_error(plan, QuotaStatus::Error, "source_schema_unsupported");
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return plan_error(plan, QuotaStatus::Error, "upstream_unavailable"),
        }
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return plan_error(plan, QuotaStatus::Error, "source_schema_unsupported");
    };
    parse_plan_response(plan, &value, now)
}

fn keyring_read_failures() -> &'static Mutex<HashSet<String>> {
    KEYRING_READ_FAILURES.get_or_init(|| Mutex::new(HashSet::new()))
}

enum KeyRead {
    Present(String),
    Missing,
    Unavailable,
}

/// A failed keychain read is remembered until an explicit retry so automatic
/// refreshes cannot keep reopening authorization prompts.
fn read_key_with_failure_cache<F>(gateway_provider_id: &str, retry: bool, read: F) -> KeyRead
where
    F: FnOnce() -> Result<Option<String>, String>,
{
    let mut failures = keyring_read_failures()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if retry {
        failures.remove(gateway_provider_id);
    } else if failures.contains(gateway_provider_id) {
        return KeyRead::Unavailable;
    }
    match read() {
        Ok(Some(key))
            if !key.is_empty()
                && key.len() <= MAX_API_KEY_BYTES
                && key.trim() == key
                && !key.chars().any(char::is_control) =>
        {
            failures.remove(gateway_provider_id);
            KeyRead::Present(key)
        }
        Ok(_) => {
            failures.remove(gateway_provider_id);
            KeyRead::Missing
        }
        Err(_) => {
            failures.insert(gateway_provider_id.to_string());
            KeyRead::Unavailable
        }
    }
}

fn remove_source_files(app_data_dir: &Path, provider_id: &str) {
    let _persistence = persistence_guard();
    remove_persisted_snapshot(app_data_dir, &last_good_file_name(provider_id));
    remove_persisted_snapshot(app_data_dir, &rate_limit_file_name(provider_id));
}

pub(crate) async fn collect_balance_providers(
    app: &AppContext,
    retry_keyring_read: bool,
) -> Vec<QuotaProviderEnvelope> {
    let mut providers = collect_vendor_balances(app, retry_keyring_read).await;
    providers.extend(experimental::collect_plan_providers(app, retry_keyring_read).await);
    providers
}

async fn collect_vendor_balances(
    app: &AppContext,
    retry_keyring_read: bool,
) -> Vec<QuotaProviderEnvelope> {
    let app_data_dir = app.app_data_dir().to_path_buf();
    let Ok(configs) = load_config(&app_data_dir) else {
        return Vec::new();
    };
    if configs.iter().all(|config| !config.enabled) {
        return Vec::new();
    }
    let records = gateway::load_providers_readonly(&gateway_dir(&app_data_dir)).unwrap_or_default();
    let mut tasks = Vec::new();
    for config in configs.iter() {
        let record = records
            .iter()
            .find(|record| record.id == config.gateway_provider_id);
        if !config.enabled {
            if let Some(record) = record {
                remove_source_files(&app_data_dir, &provider_id_for(record).1);
            }
            continue;
        }
        let Some(record) = record else {
            continue;
        };
        let Some(plan) = plan_for(record, config) else {
            continue;
        };
        let key = read_key_with_failure_cache(&record.id, retry_keyring_read, || {
            gateway::read_provider_key(&KeyringSecrets, &record.id)
        });
        let dir = app_data_dir.clone();
        let task_plan = plan.clone();
        tasks.push((
            plan,
            tauri::async_runtime::spawn(async move {
                match key {
                    KeyRead::Present(key) => request_plan(&dir, &task_plan, &key, false).await,
                    KeyRead::Missing => {
                        plan_error(&task_plan, QuotaStatus::AuthRequired, "api_key_required")
                    }
                    KeyRead::Unavailable => {
                        plan_error(&task_plan, QuotaStatus::Error, "secure_storage_unavailable")
                    }
                }
            }),
        ));
    }
    let mut providers = Vec::with_capacity(tasks.len());
    let mut seen = HashSet::new();
    for (plan, task) in tasks {
        let result = task
            .await
            .unwrap_or_else(|_| plan_error(&plan, QuotaStatus::Error, "provider_worker_failed"));
        let mut finalized = finalize_with_persisted_last_good(
            &app_data_dir,
            &last_good_file_name(&plan.provider_id),
            &plan.provider_id,
            result,
            Utc::now(),
        );
        finalized.action = None;
        if seen.insert(plan.provider_id.clone()) {
            providers.push(finalized);
        }
    }
    providers
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "tokenledger-balance-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn record(id: &str, base_url: &str) -> ProviderRecord {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": format!("{id} 名称"),
            "baseUrl": base_url,
            "wire": "chat",
        }))
        .expect("provider record")
    }

    fn write_gateway(dir: &Path, records: &[ProviderRecord]) {
        let body = serde_json::json!({"schemaVersion": 1, "providers": records});
        let gateway = gateway_dir(dir);
        fs::create_dir_all(&gateway).unwrap();
        fs::write(gateway.join("providers-v1.json"), body.to_string()).unwrap();
    }

    fn relay_plan(base: &str, path: &str) -> RequestPlan {
        let record = record("relay", base);
        let config = BalanceSourceConfig {
            gateway_provider_id: "relay".into(),
            enabled: true,
            relay: Some(RelayBalanceConfig {
                balance_url: format!("{base}{path}"),
                value_path: "data.balance".into(),
                currency: "CNY".into(),
            }),
        };
        plan_for(&record, &config).expect("relay plan")
    }

    /// Serves one canned HTTP response and returns the raw request text.
    fn serve_once(response: String) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buffer = vec![0_u8; 8 * 1024];
            let read = stream.read(&mut buffer).unwrap_or(0);
            let _ = stream.write_all(response.as_bytes());
            String::from_utf8_lossy(&buffer[..read]).to_string()
        });
        (format!("http://{address}"), handle)
    }

    fn ok_json(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    #[test]
    fn provider_ids_follow_the_contract_and_stay_bounded() {
        assert_eq!(
            provider_id_for(&record("kimi", "https://api.moonshot.cn/v1")).1,
            "balance-moonshot"
        );
        assert_eq!(
            provider_id_for(&record("ds", "https://api.deepseek.com/v1")).1,
            "balance-deepseek"
        );
        assert_eq!(
            provider_id_for(&record("or", "https://openrouter.ai/api/v1")).1,
            "balance-openrouter"
        );
        assert_eq!(
            provider_id_for(&record("sf", "https://api.siliconflow.cn/v1")).1,
            "balance-siliconflow"
        );
        let relay = provider_id_for(&record("my-relay", "https://relay.example.com/v1"));
        assert_eq!(
            relay,
            (BalanceVendor::Relay, "balance-relay-my-relay".to_string())
        );
        assert!(is_balance_provider_id("balance-relay-my-relay"));
        assert!(!is_balance_provider_id("balance-"));
        assert!(!is_balance_provider_id("company-openapi-abc"));
        assert!(last_good_file_name(&"x".repeat(40)).len() <= 96);
    }

    #[test]
    fn relay_balance_url_must_share_the_relay_origin() {
        let relay = record("relay", "https://relay.example.com/v1");
        let config = |url: &str| RelayBalanceConfig {
            balance_url: url.into(),
            value_path: "data.balance".into(),
            currency: "CNY".into(),
        };
        assert!(
            normalize_relay_config(&relay, &config("https://relay.example.com/api/user/self"))
                .is_ok()
        );
        for bad in [
            "https://other.example.com/api/user/self",
            "https://relay.example.com:8443/api/user/self",
            "http://relay.example.com/api/user/self",
            "https://user:pw@relay.example.com/api/user/self",
            "https://relay.example.com/api/user/self?key=sk-x",
            "https://relay.example.com/api/user/self#frag",
            "not a url",
        ] {
            assert!(
                normalize_relay_config(&relay, &config(bad)).is_err(),
                "{bad}"
            );
        }
        let mut lower = config("https://relay.example.com/b");
        lower.currency = "cny".into();
        assert!(normalize_relay_config(&relay, &lower).is_err());
        let mut path = config("https://relay.example.com/b");
        path.value_path = "data[0]".into();
        assert!(normalize_relay_config(&relay, &path).is_err());
    }

    #[test]
    fn final_gate_blocks_off_allowlist_vendor_urls_and_cross_origin_relays() {
        let vendor = plan_for(
            &record("ds", "https://api.deepseek.com/v1"),
            &BalanceSourceConfig {
                gateway_provider_id: "ds".into(),
                enabled: true,
                relay: None,
            },
        )
        .unwrap();
        assert_eq!(vendor.url.as_str(), "https://api.deepseek.com/user/balance");
        assert!(request_url_allowed(&vendor, false));
        let mut tampered = vendor.clone();
        tampered.url = Url::parse("https://evil.example/user/balance").unwrap();
        assert!(!request_url_allowed(&tampered, false));
        tampered.url = Url::parse("http://127.0.0.1:9/user/balance").unwrap();
        assert!(!request_url_allowed(&tampered, false));

        let mut relay = relay_plan("https://relay.example.com", "/api/balance");
        assert!(request_url_allowed(&relay, false));
        relay.url = Url::parse("https://elsewhere.example/api/balance").unwrap();
        assert!(!request_url_allowed(&relay, false));
    }

    #[test]
    fn settings_reuse_gateway_providers_and_require_explicit_relay_config() {
        let dir = temporary_dir("config");
        write_gateway(
            &dir,
            &[
                record("kimi", "https://api.moonshot.cn/v1"),
                record("kimi-intl", "https://api.moonshot.ai/v1"),
                record("relay", "https://relay.example.com/v1"),
            ],
        );
        let views = list_views_at(&dir).unwrap();
        assert_eq!(views.len(), 3);
        assert!(views.iter().all(|view| !view.enabled));

        let views = set_source_at(
            &dir,
            SetBalanceSourceInput {
                gateway_provider_id: "kimi".into(),
                enabled: true,
                relay: None,
            },
        )
        .unwrap();
        assert!(
            views
                .iter()
                .find(|v| v.gateway_provider_id == "kimi")
                .unwrap()
                .enabled
        );
        let duplicate = set_source_at(
            &dir,
            SetBalanceSourceInput {
                gateway_provider_id: "kimi-intl".into(),
                enabled: true,
                relay: None,
            },
        );
        assert!(duplicate.is_err());

        assert!(set_source_at(
            &dir,
            SetBalanceSourceInput {
                gateway_provider_id: "relay".into(),
                enabled: true,
                relay: None,
            }
        )
        .is_err());
        let views = set_source_at(
            &dir,
            SetBalanceSourceInput {
                gateway_provider_id: "relay".into(),
                enabled: true,
                relay: Some(RelayBalanceConfig {
                    balance_url: "https://relay.example.com/api/user/balance".into(),
                    value_path: "data.balance".into(),
                    currency: "USD".into(),
                }),
            },
        )
        .unwrap();
        let relay = views
            .iter()
            .find(|v| v.gateway_provider_id == "relay")
            .unwrap();
        assert!(relay.enabled);
        assert_eq!(relay.provider_id, "balance-relay-relay");
        assert!(set_source_at(
            &dir,
            SetBalanceSourceInput {
                gateway_provider_id: "missing".into(),
                enabled: true,
                relay: None,
            }
        )
        .is_err());
        assert_eq!(
            enabled_provider_ids(&dir),
            HashSet::from([
                "balance-moonshot".to_string(),
                "balance-relay-relay".to_string()
            ])
        );

        let stored = fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
        assert!(!stored.contains("sk-"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn keychain_failures_are_cached_until_explicit_retry() {
        let id = format!("balance-cache-{}", std::process::id());
        assert!(matches!(
            read_key_with_failure_cache(&id, false, || Err("locked".into())),
            KeyRead::Unavailable
        ));
        assert!(matches!(
            read_key_with_failure_cache(&id, false, || panic!("must not reread")),
            KeyRead::Unavailable
        ));
        assert!(matches!(
            read_key_with_failure_cache(&id, true, || Ok(Some("sk-ok".into()))),
            KeyRead::Present(key) if key == "sk-ok"
        ));
        assert!(matches!(
            read_key_with_failure_cache(&id, false, || Ok(None)),
            KeyRead::Missing
        ));
    }

    #[test]
    fn http_path_sends_bearer_only_and_returns_amount_without_secrets() {
        let (base, server) = serve_once(ok_json(
            r#"{"data":{"balance":"12.34","email":"x@example.com","token":"sk-upstream-raw"}}"#,
        ));
        let plan = relay_plan(&base, "/api/balance");
        let dir = temporary_dir("http");
        let envelope =
            tauri::async_runtime::block_on(request_plan(&dir, &plan, "sk-test-only", false));
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /api/balance HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-test-only"));
        assert_eq!(envelope.status, QuotaStatus::Ok);
        assert_eq!(envelope.windows.len(), 1);
        let window = &envelope.windows[0];
        assert_eq!(window.window_id, "balance-cny");
        assert_eq!(window.unit, QuotaUnit::Currency);
        assert_eq!(window.currency.as_deref(), Some("CNY"));
        assert_eq!(window.remaining, Some(12.34));
        assert_eq!((window.used, window.limit), (None, None));
        assert_eq!(envelope.capability, QuotaCapability::PlanDependent);
        let wire = serde_json::to_string(&envelope).unwrap();
        for leaked in ["sk-test-only", "sk-upstream-raw", "x@example.com", &base] {
            assert!(!wire.contains(leaked), "{leaked}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn vendor_parser_runs_over_http_when_loopback_is_explicitly_allowed() {
        let (base, server) = serve_once(ok_json(
            r#"{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00"},{"currency":"USD","total_balance":"5.00"}]}"#,
        ));
        let mut plan = plan_for(
            &record("ds", "https://api.deepseek.com/v1"),
            &BalanceSourceConfig {
                gateway_provider_id: "ds".into(),
                enabled: true,
                relay: None,
            },
        )
        .unwrap();
        plan.url = Url::parse(&format!("{base}/user/balance")).unwrap();
        let dir = temporary_dir("vendor");
        let blocked = tauri::async_runtime::block_on(request_plan(&dir, &plan, "sk-t", false));
        assert_eq!(
            blocked.reason_code.as_deref(),
            Some("source_schema_unsupported")
        );
        let envelope = tauri::async_runtime::block_on(request_plan(&dir, &plan, "sk-t", true));
        server.join().unwrap();
        assert_eq!(envelope.status, QuotaStatus::Ok);
        let ids: Vec<_> = envelope
            .windows
            .iter()
            .map(|w| w.window_id.as_str())
            .collect();
        assert_eq!(ids, ["balance-cny", "balance-usd"]);
        assert_eq!(envelope.capability, QuotaCapability::Stable);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn redirects_are_not_followed() {
        let target = TcpListener::bind("127.0.0.1:0").expect("bind target");
        let target_address = target.local_addr().unwrap();
        let (base, server) = serve_once(format!(
            "HTTP/1.1 302 Found\r\nLocation: http://{target_address}/api/balance\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        ));
        let plan = relay_plan(&base, "/api/balance");
        let dir = temporary_dir("redirect");
        let envelope = tauri::async_runtime::block_on(request_plan(&dir, &plan, "sk-t", false));
        server.join().unwrap();
        assert_eq!(envelope.status, QuotaStatus::Error);
        assert_eq!(
            envelope.reason_code.as_deref(),
            Some("source_temporarily_unavailable")
        );
        target.set_nonblocking(true).unwrap();
        assert!(
            target.accept().is_err(),
            "redirect target must never be contacted"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn responses_over_256_kib_fail_closed() {
        let body = format!(
            r#"{{"data":{{"balance":1,"pad":"{}"}}}}"#,
            "x".repeat(MAX_RESPONSE_BYTES)
        );
        let (base, server) = serve_once(ok_json(&body));
        let plan = relay_plan(&base, "/api/balance");
        let dir = temporary_dir("large");
        let envelope = tauri::async_runtime::block_on(request_plan(&dir, &plan, "sk-t", false));
        let _ = server.join();
        assert_eq!(
            envelope.reason_code.as_deref(),
            Some("source_schema_unsupported")
        );
        assert!(envelope.windows.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rate_limits_back_off_without_another_request() {
        let (base, server) = serve_once(
            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
        );
        let plan = relay_plan(&base, "/api/balance");
        let dir = temporary_dir("429");
        let first = tauri::async_runtime::block_on(request_plan(&dir, &plan, "sk-t", false));
        server.join().unwrap();
        assert_eq!(first.reason_code.as_deref(), Some("rate_limited"));
        // No listener is running now; a second request would fail as upstream_unavailable.
        let second = tauri::async_runtime::block_on(request_plan(&dir, &plan, "sk-t", false));
        assert_eq!(second.reason_code.as_deref(), Some("rate_limited"));
        let now = Utc::now();
        assert!(rate_limit_is_active(
            &dir,
            &plan.provider_id,
            now + chrono::Duration::seconds(110)
        ));
        assert!(!rate_limit_is_active(
            &dir,
            &plan.provider_id,
            now + chrono::Duration::seconds(130)
        ));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejected_keys_and_unverifiable_amounts_map_to_registered_reasons() {
        let (base, server) = serve_once(
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
        );
        let plan = relay_plan(&base, "/api/balance");
        let dir = temporary_dir("auth");
        let denied = tauri::async_runtime::block_on(request_plan(&dir, &plan, "sk-t", false));
        server.join().unwrap();
        assert_eq!(denied.status, QuotaStatus::AuthRequired);
        assert_eq!(denied.reason_code.as_deref(), Some("api_key_required"));

        let (base, server) = serve_once(ok_json(r#"{"data":{"balance":"-3"}}"#));
        let plan = relay_plan(&base, "/api/balance");
        let invalid = tauri::async_runtime::block_on(request_plan(&dir, &plan, "sk-t", false));
        server.join().unwrap();
        assert_eq!(invalid.status, QuotaStatus::Error);
        assert_eq!(invalid.reason_code.as_deref(), Some("balance_unavailable"));
        assert!(invalid.windows.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    const FIXTURE: &str = include_str!("../../../../fixtures/quota-provider-v1/balance-v1.json");

    #[test]
    fn shared_fixture_samples_and_envelopes_match_the_producer() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        for sample in fixture["upstreamSamples"].as_array().unwrap() {
            let host = sample["host"].as_str().unwrap();
            let endpoint = vendors::VENDOR_ENDPOINTS
                .iter()
                .find(|endpoint| endpoint.host == host)
                .unwrap();
            let parsed = parse_vendor_response(endpoint, &sample["response"]);
            match sample["amounts"].as_array() {
                None => assert!(parsed.is_err(), "{host} sample must fail closed"),
                Some(expected) => {
                    let parsed = parsed.unwrap();
                    assert_eq!(parsed.len(), expected.len(), "{host}");
                    for (amount, expected) in parsed.iter().zip(expected) {
                        assert_eq!(amount.currency, expected["currency"].as_str().unwrap());
                        assert!(
                            (amount.remaining - expected["remaining"].as_f64().unwrap()).abs()
                                < 1e-9
                        );
                    }
                }
            }
        }
        let now = DateTime::parse_from_rfc3339("2026-10-04T12:30:00+08:00")
            .unwrap()
            .with_timezone(&Utc);
        for item in fixture["providers"].as_array().unwrap() {
            let envelope: QuotaProviderEnvelope =
                serde_json::from_value(item["envelope"].clone()).unwrap();
            assert!(is_balance_provider_id(&envelope.provider_id));
            assert!(envelope.action.is_none());
            if matches!(envelope.status, QuotaStatus::Ok | QuotaStatus::Stale) {
                assert!(
                    super::super::validate_persisted_envelope(
                        &envelope,
                        &envelope.provider_id,
                        now
                    ),
                    "{} must be a valid persisted balance envelope",
                    envelope.provider_id
                );
            } else {
                assert!(envelope.windows.is_empty());
                assert!(matches!(
                    envelope.reason_code.as_deref(),
                    Some("balance_unavailable" | "api_key_required")
                ));
            }
        }
    }

    #[test]
    fn failures_keep_the_last_good_balance_as_stale() {
        let dir = temporary_dir("lkg");
        let plan = relay_plan("https://relay.example.com", "/api/balance");
        let ok = parse_plan_response(
            &plan,
            &serde_json::json!({"data": {"balance": 8}}),
            Utc::now(),
        );
        let file = last_good_file_name(&plan.provider_id);
        let stored =
            finalize_with_persisted_last_good(&dir, &file, &plan.provider_id, ok, Utc::now());
        assert_eq!(stored.status, QuotaStatus::Ok);
        let failed = plan_error(&plan, QuotaStatus::Error, "balance_unavailable");
        let stale =
            finalize_with_persisted_last_good(&dir, &file, &plan.provider_id, failed, Utc::now());
        assert_eq!(stale.status, QuotaStatus::Stale);
        assert_eq!(stale.reason_code.as_deref(), Some("balance_unavailable"));
        assert_eq!(stale.windows[0].remaining, Some(8.0));
        assert_eq!(stale.windows[0].currency.as_deref(), Some("CNY"));
        assert!(stale.action.is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
