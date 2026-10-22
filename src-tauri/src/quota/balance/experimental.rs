//! Experimental coding-plan usage sources (ADR-018 U-109).
//!
//! Each source is off by default and can only be enabled after the user has
//! accepted the current risk notice; consent is stored with its version and
//! a version bump invalidates it. Until consent is current no keychain read
//! and no request happen. The key is the gateway's own `provider:<id>` entry
//! for a provider on the vendor's fixed host; OAuth, session credentials, and
//! cookies are never read. Results are local only: sync does not upload them.

use std::collections::HashSet;
use std::path::Path;

use chrono::{DateTime, Utc};
use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::app_paths::AppContext;
use crate::gateway::{self, KeyringSecrets, ProviderRecord};

use super::plan_vendors::{plan_endpoint_for_base_url, PlanEndpoint, PlanVendor, PlanWindow};
use super::{
    gateway_dir, plan_error, rate_limit_file_name, read_key_with_failure_cache, request_plan,
    KeyRead, PlanTarget, RequestPlan,
};
use crate::quota::{
    atomic_write_private, format_timestamp, persist_last_good, persistence_guard,
    read_bounded_private_file, remove_persisted_snapshot, sanitize_stable_window_id,
    stale_from_last_good, valid_persisted_timestamp, PersistedEnvelope, QuotaCapability, QuotaMode,
    QuotaProviderEnvelope, QuotaScope, QuotaSource, QuotaStatus, QuotaUnit, QuotaWindowSnapshot,
    QuotaWindowStatus, SnapshotFailure, LAST_GOOD_RETENTION, MAX_FUTURE_CLOCK_SKEW_SECONDS,
    MAX_PERSISTED_ENVELOPE_BYTES,
};

/// Bump when the risk notice changes; every stored consent then needs renewal.
pub(crate) const RISK_VERSION: u32 = 1;
pub(crate) const CONSENT_REASON: &str = "experimental_consent_required";
const CONFIG_FILE: &str = "quota_experimental_plans_v1.json";
const CONFIG_SCHEMA_VERSION: u8 = 1;
const MAX_CONFIG_BYTES: usize = 8 * 1024;
const STALE_AFTER_SECONDS: u64 = 15 * 60;
const MAX_WINDOWS: usize = 16;
const MAX_WINDOW_MINUTES: u64 = 31 * 24 * 60;
const MAX_RESET_FUTURE_SECONDS: i64 = 32 * 24 * 60 * 60;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanConfig {
    provider_id: String,
    enabled: bool,
    #[serde(default)]
    consented_risk_version: Option<u32>,
    #[serde(default)]
    consented_at: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigFile {
    schema_version: u8,
    plans: Vec<PlanConfig>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentalPlanView {
    pub provider_id: String,
    pub vendor: PlanVendor,
    pub display_name: String,
    pub enabled: bool,
    pub consent_current: bool,
    pub risk_version: u32,
    pub gateway_provider_name: Option<String>,
    pub host: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetExperimentalPlanInput {
    pub provider_id: String,
    pub enabled: bool,
    #[serde(default)]
    pub accept_risk_version: Option<u32>,
}

fn last_good_file_name(vendor: PlanVendor) -> String {
    format!("quota_lkg_plan_{}.json", vendor.file_slug())
}

fn load_config(app_data_dir: &Path) -> Result<Vec<PlanConfig>, String> {
    let bytes = match read_bounded_private_file(app_data_dir, CONFIG_FILE, MAX_CONFIG_BYTES) {
        Ok(bytes) => bytes,
        Err(SnapshotFailure::Missing) => return Ok(Vec::new()),
        Err(_) => return Err("无法安全读取实验来源配置。".to_string()),
    };
    let file: ConfigFile =
        serde_json::from_slice(&bytes).map_err(|_| "实验来源配置已损坏。".to_string())?;
    let mut seen = HashSet::new();
    let valid = file.schema_version == CONFIG_SCHEMA_VERSION
        && file.plans.len() <= PlanVendor::ALL.len()
        && file.plans.iter().all(|plan| {
            PlanVendor::from_provider_id(&plan.provider_id).is_some()
                && seen.insert(plan.provider_id.clone())
        });
    if !valid {
        return Err("实验来源配置版本不受支持。".to_string());
    }
    Ok(file.plans)
}

fn save_config(app_data_dir: &Path, plans: Vec<PlanConfig>) -> Result<(), String> {
    let bytes = serde_json::to_vec(&ConfigFile {
        schema_version: CONFIG_SCHEMA_VERSION,
        plans,
    })
    .map_err(|_| "无法保存实验来源配置。".to_string())?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err("实验来源配置过大。".to_string());
    }
    atomic_write_private(app_data_dir, CONFIG_FILE, &bytes)
        .map_err(|_| "无法安全保存实验来源配置。".to_string())
}

fn consent_current(config: &PlanConfig, risk_version: u32) -> bool {
    config.consented_risk_version == Some(risk_version)
}

/// The first gateway provider on one of the vendor's fixed hosts.
fn matching_provider(
    records: &[ProviderRecord],
    vendor: PlanVendor,
) -> Option<(&ProviderRecord, PlanEndpoint)> {
    records.iter().find_map(|record| {
        plan_endpoint_for_base_url(vendor, &record.base_url).map(|endpoint| (record, endpoint))
    })
}

fn list_views_at(
    app_data_dir: &Path,
    risk_version: u32,
) -> Result<Vec<ExperimentalPlanView>, String> {
    let records = gateway::load_providers_readonly(&gateway_dir(app_data_dir))?;
    let configs = load_config(app_data_dir)?;
    Ok(PlanVendor::ALL
        .into_iter()
        .map(|vendor| {
            let config = configs
                .iter()
                .find(|config| config.provider_id == vendor.provider_id());
            let matched = matching_provider(&records, vendor);
            ExperimentalPlanView {
                provider_id: vendor.provider_id().to_string(),
                vendor,
                display_name: vendor.display_name().to_string(),
                enabled: config.is_some_and(|config| config.enabled),
                consent_current: config.is_some_and(|config| consent_current(config, risk_version)),
                risk_version,
                gateway_provider_name: matched.map(|(record, _)| record.name.clone()),
                host: matched.map(|(_, endpoint)| endpoint.host.to_string()),
            }
        })
        .collect())
}

pub fn list_quota_experimental_plans_impl(
    app: &AppContext,
) -> Result<Vec<ExperimentalPlanView>, String> {
    list_views_at(app.app_data_dir(), RISK_VERSION)
}

pub fn set_quota_experimental_plan_impl(
    app: &AppContext,
    input: SetExperimentalPlanInput,
) -> Result<Vec<ExperimentalPlanView>, String> {
    set_plan_at(app.app_data_dir(), input, RISK_VERSION, Utc::now())
}

fn set_plan_at(
    app_data_dir: &Path,
    input: SetExperimentalPlanInput,
    risk_version: u32,
    now: DateTime<Utc>,
) -> Result<Vec<ExperimentalPlanView>, String> {
    let vendor = PlanVendor::from_provider_id(&input.provider_id)
        .ok_or_else(|| "未知的实验来源。".to_string())?;
    let mut configs = load_config(app_data_dir)?;
    let index = match configs
        .iter()
        .position(|config| config.provider_id == input.provider_id)
    {
        Some(index) => index,
        None => {
            configs.push(PlanConfig {
                provider_id: input.provider_id.clone(),
                enabled: false,
                consented_risk_version: None,
                consented_at: None,
            });
            configs.len() - 1
        }
    };
    if let Some(accepted) = input.accept_risk_version {
        if accepted != risk_version {
            return Err("风险提示已更新，请重新阅读后再确认。".to_string());
        }
        configs[index].consented_risk_version = Some(accepted);
        configs[index].consented_at = Some(format_timestamp(now));
    }
    if input.enabled {
        if !consent_current(&configs[index], risk_version) {
            return Err("开启前需要先确认风险提示。".to_string());
        }
        let records = gateway::load_providers_readonly(&gateway_dir(app_data_dir))?;
        if matching_provider(&records, vendor).is_none() {
            return Err(format!(
                "先在「供应商」页添加 {} 的官方地址并填入 API key。",
                vendor.display_name().trim_end_matches(" 套餐")
            ));
        }
    }
    configs[index].enabled = input.enabled;
    save_config(app_data_dir, configs)?;
    if !input.enabled {
        remove_source_files(app_data_dir, vendor);
    }
    list_views_at(app_data_dir, risk_version)
}

fn remove_source_files(app_data_dir: &Path, vendor: PlanVendor) {
    let _persistence = persistence_guard();
    remove_persisted_snapshot(app_data_dir, &last_good_file_name(vendor));
    remove_persisted_snapshot(app_data_dir, &rate_limit_file_name(vendor.provider_id()));
}

fn base_plan(vendor: PlanVendor, endpoint: Option<PlanEndpoint>) -> RequestPlan {
    let endpoint = endpoint.unwrap_or_else(|| {
        super::plan_vendors::PLAN_ENDPOINTS
            .into_iter()
            .find(|endpoint| endpoint.vendor == vendor)
            .expect("every plan vendor has an endpoint")
    });
    RequestPlan {
        provider_id: vendor.provider_id().to_string(),
        display_name: vendor.display_name().to_string(),
        scope: QuotaScope::ConsumerSubscription,
        capability: QuotaCapability::Experimental,
        url: Url::parse(endpoint.url).expect("fixed plan endpoint URL"),
        target: PlanTarget::Experimental(endpoint),
    }
}

pub(super) fn plan_windows(
    provider_id: &str,
    windows: Vec<PlanWindow>,
    fetched_at: DateTime<Utc>,
) -> Vec<QuotaWindowSnapshot> {
    let timestamp = format_timestamp(fetched_at);
    windows
        .into_iter()
        .map(|window| QuotaWindowSnapshot {
            provider_id: provider_id.to_string(),
            window_id: window.window_id,
            window_label: window.label,
            account_label: None,
            scope: QuotaScope::ConsumerSubscription,
            source: QuotaSource::OfficialApi,
            status: QuotaWindowStatus::Ok,
            used: Some(window.used_percent),
            limit: Some(100.0),
            remaining: Some(100.0 - window.used_percent),
            unit: QuotaUnit::Percent,
            currency: None,
            window_minutes: window.window_minutes,
            resets_at: window.resets_at.map(format_timestamp),
            observed_at: timestamp.clone(),
            fetched_at: timestamp.clone(),
            stale_after_seconds: STALE_AFTER_SECONDS,
            reason_code: None,
        })
        .collect()
}

/// What one configured source does this round. Only `Request` may touch the
/// keychain or the network.
enum PlanStep {
    Envelope(QuotaProviderEnvelope),
    Request {
        plan: RequestPlan,
        gateway_provider_id: String,
    },
}

fn plan_steps(app_data_dir: &Path, risk_version: u32) -> Vec<PlanStep> {
    let Ok(configs) = load_config(app_data_dir) else {
        return Vec::new();
    };
    if configs.iter().all(|config| !config.enabled) {
        for vendor in PlanVendor::ALL {
            remove_source_files(app_data_dir, vendor);
        }
        return Vec::new();
    }
    let records = gateway::load_providers_readonly(&gateway_dir(app_data_dir)).unwrap_or_default();
    let mut steps = Vec::new();
    for vendor in PlanVendor::ALL {
        let Some(config) = configs
            .iter()
            .find(|config| config.provider_id == vendor.provider_id() && config.enabled)
        else {
            remove_source_files(app_data_dir, vendor);
            continue;
        };
        if !consent_current(config, risk_version) {
            steps.push(PlanStep::Envelope(plan_error(
                &base_plan(vendor, None),
                QuotaStatus::AuthRequired,
                CONSENT_REASON,
            )));
            continue;
        }
        match matching_provider(&records, vendor) {
            Some((record, endpoint)) => steps.push(PlanStep::Request {
                plan: base_plan(vendor, Some(endpoint)),
                gateway_provider_id: record.id.clone(),
            }),
            None => steps.push(PlanStep::Envelope(plan_error(
                &base_plan(vendor, None),
                QuotaStatus::AuthRequired,
                "api_key_required",
            ))),
        }
    }
    steps
}

/// Sources that may still publish a result once in-flight reads finish.
fn publishable_ids(app_data_dir: &Path, risk_version: u32) -> (HashSet<String>, HashSet<String>) {
    let configs = load_config(app_data_dir).unwrap_or_default();
    let enabled = configs
        .iter()
        .filter(|config| config.enabled)
        .map(|config| config.provider_id.clone())
        .collect();
    let consented = configs
        .iter()
        .filter(|config| config.enabled && consent_current(config, risk_version))
        .map(|config| config.provider_id.clone())
        .collect();
    (enabled, consented)
}

pub(crate) async fn collect_plan_providers(
    app: &AppContext,
    retry_keyring_read: bool,
) -> Vec<QuotaProviderEnvelope> {
    collect_at(
        app.app_data_dir(),
        RISK_VERSION,
        retry_keyring_read,
        false,
        |id| gateway::read_provider_key(&KeyringSecrets, id),
    )
    .await
}

async fn collect_at<F>(
    app_data_dir: &Path,
    risk_version: u32,
    retry_keyring_read: bool,
    allow_loopback: bool,
    read_key: F,
) -> Vec<QuotaProviderEnvelope>
where
    F: Fn(&str) -> Result<Option<String>, String>,
{
    let mut results = Vec::new();
    let mut tasks = Vec::new();
    for step in plan_steps(app_data_dir, risk_version) {
        match step {
            PlanStep::Envelope(envelope) => results.push(envelope),
            PlanStep::Request {
                plan,
                gateway_provider_id,
            } => {
                let key =
                    read_key_with_failure_cache(&gateway_provider_id, retry_keyring_read, || {
                        read_key(&gateway_provider_id)
                    });
                let dir = app_data_dir.to_path_buf();
                let task_plan = plan.clone();
                tasks.push((
                    plan,
                    tauri::async_runtime::spawn(async move {
                        match key {
                            KeyRead::Present(key) => {
                                request_plan(&dir, &task_plan, &key, allow_loopback).await
                            }
                            KeyRead::Missing => plan_error(
                                &task_plan,
                                QuotaStatus::AuthRequired,
                                "api_key_required",
                            ),
                            KeyRead::Unavailable => plan_error(
                                &task_plan,
                                QuotaStatus::Error,
                                "secure_storage_unavailable",
                            ),
                        }
                    }),
                ));
            }
        }
    }
    for (plan, task) in tasks {
        let result = task
            .await
            .unwrap_or_else(|_| plan_error(&plan, QuotaStatus::Error, "provider_worker_failed"));
        results.push(finalize_with_last_good(app_data_dir, result, Utc::now()));
    }
    let (enabled, consented) = publishable_ids(app_data_dir, risk_version);
    results.retain(|envelope| {
        if envelope.reason_code.as_deref() == Some(CONSENT_REASON) && envelope.windows.is_empty() {
            enabled.contains(&envelope.provider_id)
        } else {
            consented.contains(&envelope.provider_id)
        }
    });
    results
}

fn finalize_with_last_good(
    app_data_dir: &Path,
    envelope: QuotaProviderEnvelope,
    now: DateTime<Utc>,
) -> QuotaProviderEnvelope {
    let Some(vendor) = PlanVendor::from_provider_id(&envelope.provider_id) else {
        return envelope;
    };
    let file_name = last_good_file_name(vendor);
    let _persistence = persistence_guard();
    if envelope.status == QuotaStatus::Ok && !envelope.windows.is_empty() {
        let _ = persist_last_good(app_data_dir, &file_name, &envelope, now);
        return envelope;
    }
    if !envelope.windows.is_empty() {
        return envelope;
    }
    let reason = envelope
        .reason_code
        .as_deref()
        .unwrap_or("source_temporarily_unavailable");
    match read_last_good(app_data_dir, &file_name, &envelope.provider_id, now) {
        Some(last_good) => {
            let mut stale = stale_from_last_good(&last_good, reason, now);
            stale.action = None;
            stale
        }
        None => envelope,
    }
}

fn read_last_good(
    app_data_dir: &Path,
    file_name: &str,
    provider_id: &str,
    now: DateTime<Utc>,
) -> Option<QuotaProviderEnvelope> {
    let bytes =
        read_bounded_private_file(app_data_dir, file_name, MAX_PERSISTED_ENVELOPE_BYTES).ok()?;
    let persisted: PersistedEnvelope = serde_json::from_slice(&bytes).ok()?;
    let stored_at = DateTime::parse_from_rfc3339(&persisted.stored_at)
        .ok()?
        .with_timezone(&Utc);
    let fresh_enough = persisted.schema_version == 1
        && stored_at <= now + chrono::Duration::seconds(MAX_FUTURE_CLOCK_SKEW_SECONDS)
        && now.signed_duration_since(stored_at).num_seconds()
            <= LAST_GOOD_RETENTION.as_secs() as i64;
    (fresh_enough && valid_plan_envelope(&persisted.envelope, provider_id, now))
        .then_some(persisted.envelope)
}

/// LKG gate for plan envelopes: consumer scope, official-api source,
/// experimental capability, and percent windows only.
fn valid_plan_envelope(
    envelope: &QuotaProviderEnvelope,
    provider_id: &str,
    now: DateTime<Utc>,
) -> bool {
    if envelope.schema_version != 1
        || envelope.provider_id != provider_id
        || envelope.scope != QuotaScope::ConsumerSubscription
        || envelope.mode != QuotaMode::Automatic
        || envelope.capability != QuotaCapability::Experimental
        || !matches!(envelope.status, QuotaStatus::Ok | QuotaStatus::Stale)
        || envelope.action.is_some()
        || envelope.windows.is_empty()
        || envelope.windows.len() > MAX_WINDOWS
    {
        return false;
    }
    envelope.windows.iter().all(|window| {
        window.provider_id == provider_id
            && window.scope == QuotaScope::ConsumerSubscription
            && window.source == QuotaSource::OfficialApi
            && window.unit == QuotaUnit::Percent
            && window.currency.is_none()
            && window.account_label.is_none()
            && sanitize_stable_window_id(&window.window_id)
            && !window.window_label.is_empty()
            && window.window_label.len() <= 128
            && matches!(
                (window.used, window.limit, window.remaining),
                (Some(used), Some(limit), Some(remaining))
                    if used.is_finite()
                        && (0.0..=100.0).contains(&used)
                        && (limit - 100.0).abs() < f64::EPSILON
                        && (remaining - (100.0 - used)).abs() < 0.000_001
            )
            && window
                .window_minutes
                .is_none_or(|minutes| (1..=MAX_WINDOW_MINUTES).contains(&minutes))
            && valid_persisted_timestamp(&window.observed_at, now, MAX_FUTURE_CLOCK_SKEW_SECONDS)
            && valid_persisted_timestamp(&window.fetched_at, now, MAX_FUTURE_CLOCK_SKEW_SECONDS)
            && window.resets_at.as_deref().is_none_or(|timestamp| {
                valid_persisted_timestamp(timestamp, now, MAX_RESET_FUTURE_SECONDS)
            })
            && window.stale_after_seconds > 0
            && window.stale_after_seconds <= LAST_GOOD_RETENTION.as_secs()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::Value;

    fn temporary_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "tokenledger-plan-{name}-{}-{nonce}",
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

    fn input(provider_id: &str, enabled: bool, accept: Option<u32>) -> SetExperimentalPlanInput {
        SetExperimentalPlanInput {
            provider_id: provider_id.into(),
            enabled,
            accept_risk_version: accept,
        }
    }

    fn standard_gateway(dir: &Path) {
        write_gateway(
            dir,
            &[
                record("glm", "https://open.bigmodel.cn/api/coding/paas/v4"),
                record("mm", "https://api.minimaxi.com/anthropic"),
                record("kimi", "https://api.kimi.com/coding/v1"),
            ],
        );
    }

    fn panicking_key_reader(_: &str) -> Result<Option<String>, String> {
        panic!("keychain must not be read without current consent")
    }

    #[test]
    fn plans_are_off_by_default_and_listed_with_matching_gateway_hosts() {
        let dir = temporary_dir("list");
        write_gateway(&dir, &[record("glm", "https://api.z.ai/api/anthropic")]);
        let views = list_views_at(&dir, RISK_VERSION).unwrap();
        let ids: Vec<_> = views.iter().map(|view| view.provider_id.as_str()).collect();
        assert_eq!(ids, ["zhipu-glm-plan", "minimax-plan", "kimi-code-plan"]);
        assert!(views
            .iter()
            .all(|view| !view.enabled && !view.consent_current));
        assert_eq!(views[0].host.as_deref(), Some("api.z.ai"));
        assert_eq!(views[0].gateway_provider_name.as_deref(), Some("glm 名称"));
        assert!(views[1].host.is_none() && views[2].host.is_none());
        assert!(tauri::async_runtime::block_on(collect_at(
            &dir,
            RISK_VERSION,
            false,
            false,
            panicking_key_reader
        ))
        .is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn enabling_requires_accepting_the_current_risk_version() {
        let dir = temporary_dir("consent");
        standard_gateway(&dir);
        let now = Utc::now();
        assert!(set_plan_at(&dir, input("zhipu-glm-plan", true, None), 1, now).is_err());
        assert!(set_plan_at(&dir, input("zhipu-glm-plan", true, Some(0)), 1, now).is_err());
        assert!(set_plan_at(&dir, input("unknown-plan", true, Some(1)), 1, now).is_err());
        let views = set_plan_at(&dir, input("zhipu-glm-plan", true, Some(1)), 1, now).unwrap();
        assert!(views[0].enabled && views[0].consent_current);
        let stored: Value =
            serde_json::from_slice(&fs::read(dir.join(CONFIG_FILE)).unwrap()).unwrap();
        assert_eq!(stored["plans"][0]["consentedRiskVersion"], 1);
        assert!(stored["plans"][0]["consentedAt"].is_string());

        // Disabling keeps the versioned consent; re-enabling needs no new prompt.
        set_plan_at(&dir, input("zhipu-glm-plan", false, None), 1, now).unwrap();
        assert!(set_plan_at(&dir, input("zhipu-glm-plan", true, None), 1, now).is_ok());

        // A risk-version bump invalidates consent for listing and enabling.
        let bumped = list_views_at(&dir, 2).unwrap();
        assert!(bumped[0].enabled && !bumped[0].consent_current);
        assert!(set_plan_at(&dir, input("zhipu-glm-plan", true, None), 2, now).is_err());
        assert!(set_plan_at(&dir, input("zhipu-glm-plan", true, Some(1)), 2, now).is_err());
        assert!(set_plan_at(&dir, input("zhipu-glm-plan", true, Some(2)), 2, now).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn enabling_requires_a_gateway_provider_on_the_vendor_host() {
        let dir = temporary_dir("nohost");
        write_gateway(&dir, &[record("relay", "https://relay.example.com/v1")]);
        let error =
            set_plan_at(&dir, input("kimi-code-plan", true, Some(1)), 1, Utc::now()).unwrap_err();
        assert!(error.contains("Kimi Code"), "{error}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_consent_never_reads_the_key_or_sends_a_request() {
        let dir = temporary_dir("noreq");
        standard_gateway(&dir);
        set_plan_at(&dir, input("minimax-plan", true, Some(1)), 1, Utc::now()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let envelopes =
            tauri::async_runtime::block_on(collect_at(&dir, 2, true, true, panicking_key_reader));
        assert_eq!(envelopes.len(), 1);
        let envelope = &envelopes[0];
        assert_eq!(envelope.provider_id, "minimax-plan");
        assert_eq!(envelope.status, QuotaStatus::AuthRequired);
        assert_eq!(envelope.reason_code.as_deref(), Some(CONSENT_REASON));
        assert_eq!(envelope.scope, QuotaScope::ConsumerSubscription);
        assert_eq!(envelope.capability, QuotaCapability::Experimental);
        assert!(envelope.windows.is_empty() && envelope.action.is_none());
        assert!(listener.accept().is_err(), "no request may be sent");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn consented_plan_reads_only_its_own_gateway_key() {
        let dir = temporary_dir("key");
        write_gateway(
            &dir,
            &[
                record("other", "https://relay.example.com/v1"),
                record("kimi", "https://api.kimi.com/coding/v1"),
            ],
        );
        set_plan_at(&dir, input("kimi-code-plan", true, Some(1)), 1, Utc::now()).unwrap();
        let reads = AtomicUsize::new(0);
        let envelopes = tauri::async_runtime::block_on(collect_at(&dir, 1, true, false, |id| {
            reads.fetch_add(1, Ordering::SeqCst);
            assert_eq!(id, "kimi");
            Ok(None)
        }));
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(
            envelopes[0].reason_code.as_deref(),
            Some("api_key_required")
        );
        assert_eq!(envelopes[0].status, QuotaStatus::AuthRequired);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn request_gate_only_allows_fixed_plan_urls() {
        let plan = base_plan(PlanVendor::ZhipuGlm, None);
        assert!(super::super::request_url_allowed(&plan, false));
        for denied in [
            "https://evil.example/api/monitor/usage/quota/limit",
            "https://api.deepseek.com/user/balance",
            "https://open.bigmodel.cn/api/monitor/usage/quota/limit?token=x",
            "http://127.0.0.1:9/api/monitor/usage/quota/limit",
        ] {
            let mut tampered = plan.clone();
            tampered.url = Url::parse(denied).unwrap();
            assert!(
                !super::super::request_url_allowed(&tampered, false),
                "{denied}"
            );
        }
    }

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
    fn http_path_returns_percent_windows_and_keeps_last_good_on_failure() {
        let dir = temporary_dir("http");
        let reset = (Utc::now() + chrono::Duration::hours(2)).timestamp_millis();
        let body = format!(
            r#"{{"code":200,"success":true,"data":{{"limits":[{{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":40,"nextResetTime":{reset}}}],"user":"x@example.com"}}}}"#
        );
        let (base, server) = serve_once(ok_json(&body));
        let mut plan = base_plan(PlanVendor::ZhipuGlm, None);
        plan.url = Url::parse(&format!("{base}/api/monitor/usage/quota/limit")).unwrap();
        let blocked = tauri::async_runtime::block_on(request_plan(&dir, &plan, "sk-plan", false));
        assert_eq!(
            blocked.reason_code.as_deref(),
            Some("source_schema_unsupported")
        );
        let fetched = tauri::async_runtime::block_on(request_plan(&dir, &plan, "sk-plan", true));
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /api/monitor/usage/quota/limit HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-plan"));
        assert!(!request.to_ascii_lowercase().contains("cookie"));
        assert_eq!(fetched.status, QuotaStatus::Ok);
        let window = &fetched.windows[0];
        assert_eq!(
            (window.unit, window.used, window.limit, window.remaining),
            (QuotaUnit::Percent, Some(40.0), Some(100.0), Some(60.0))
        );
        assert_eq!(window.source, QuotaSource::OfficialApi);
        assert_eq!(window.window_minutes, Some(300));
        let wire = serde_json::to_string(&fetched).unwrap();
        for leaked in ["sk-plan", "x@example.com", &base] {
            assert!(!wire.contains(leaked), "{leaked}");
        }

        let now = Utc::now();
        let stored = finalize_with_last_good(&dir, fetched, now);
        assert_eq!(stored.status, QuotaStatus::Ok);
        let failed = plan_error(&plan, QuotaStatus::Error, "upstream_unavailable");
        let stale = finalize_with_last_good(&dir, failed, now);
        assert_eq!(stale.status, QuotaStatus::Stale);
        assert_eq!(stale.reason_code.as_deref(), Some("upstream_unavailable"));
        assert_eq!(stale.windows[0].used, Some(40.0));
        assert!(stale.action.is_none());

        set_plan_at(&dir, input("zhipu-glm-plan", false, None), 1, now).unwrap();
        assert!(!dir.join(last_good_file_name(PlanVendor::ZhipuGlm)).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unparseable_or_out_of_range_responses_fail_closed() {
        let (base, server) = serve_once(ok_json(
            r#"{"base_resp":{"status_code":0},"model_remains":[{"model_name":"MiniMax-M2","current_interval_remaining_percent":150}]}"#,
        ));
        let mut plan = base_plan(PlanVendor::Minimax, None);
        plan.url = Url::parse(&format!("{base}/v1/token_plan/remains")).unwrap();
        let dir = temporary_dir("bad");
        let envelope = tauri::async_runtime::block_on(request_plan(&dir, &plan, "sk", true));
        server.join().unwrap();
        assert_eq!(envelope.status, QuotaStatus::Error);
        assert_eq!(
            envelope.reason_code.as_deref(),
            Some("source_schema_unsupported")
        );
        assert!(envelope.windows.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn last_good_rejects_tampered_envelopes() {
        let now = Utc::now();
        let windows = plan_windows(
            "kimi-code-plan",
            vec![PlanWindow {
                window_id: "kimi:usage".into(),
                label: "套餐总额度".into(),
                used_percent: 30.0,
                window_minutes: None,
                resets_at: None,
            }],
            now,
        );
        let plan = base_plan(PlanVendor::KimiCode, None);
        let good = super::super::envelope(&plan, QuotaStatus::Ok, None, windows);
        assert!(valid_plan_envelope(&good, "kimi-code-plan", now));
        let mut wrong_source = good.clone();
        wrong_source.windows[0].source = QuotaSource::LocalAuthorized;
        let mut wrong_capability = good.clone();
        wrong_capability.capability = QuotaCapability::Stable;
        let mut out_of_range = good.clone();
        out_of_range.windows[0].used = Some(130.0);
        out_of_range.windows[0].remaining = Some(-30.0);
        let mut currency = good.clone();
        currency.windows[0].unit = QuotaUnit::Currency;
        for bad in [wrong_source, wrong_capability, out_of_range, currency] {
            assert!(!valid_plan_envelope(&bad, "kimi-code-plan", now));
        }
        assert!(!valid_plan_envelope(&good, "minimax-plan", now));
    }

    const FIXTURE: &str =
        include_str!("../../../../fixtures/quota-provider-v1/experimental-plans-v1.json");

    #[test]
    fn shared_fixture_samples_and_envelopes_match_the_producer() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let now = DateTime::parse_from_rfc3339(fixture["now"].as_str().unwrap())
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            fixture["riskVersion"].as_u64(),
            Some(u64::from(RISK_VERSION))
        );
        for sample in fixture["upstreamSamples"].as_array().unwrap() {
            let vendor =
                PlanVendor::from_provider_id(sample["providerId"].as_str().unwrap()).unwrap();
            let parsed =
                super::super::plan_vendors::parse_plan_response(vendor, &sample["response"], now);
            let name = sample["name"].as_str().unwrap();
            match sample["windows"].as_array() {
                None => assert!(parsed.is_err(), "{name} must fail closed"),
                Some(expected) => {
                    let parsed = parsed.unwrap_or_else(|_| panic!("{name} must parse"));
                    assert_eq!(parsed.len(), expected.len(), "{name}");
                    for (window, expected) in parsed.iter().zip(expected) {
                        assert_eq!(
                            window.window_id,
                            expected["windowId"].as_str().unwrap(),
                            "{name}"
                        );
                        assert!(
                            (window.used_percent - expected["used"].as_f64().unwrap()).abs() < 1e-9,
                            "{name}"
                        );
                        assert_eq!(
                            window.window_minutes,
                            expected["windowMinutes"].as_u64(),
                            "{name}"
                        );
                        assert_eq!(
                            window.resets_at.map(format_timestamp),
                            expected["resetsAt"].as_str().map(str::to_string),
                            "{name}"
                        );
                    }
                }
            }
        }
        for item in fixture["providers"].as_array().unwrap() {
            let envelope: QuotaProviderEnvelope =
                serde_json::from_value(item["envelope"].clone()).unwrap();
            assert!(PlanVendor::from_provider_id(&envelope.provider_id).is_some());
            assert_eq!(envelope.scope, QuotaScope::ConsumerSubscription);
            assert_eq!(envelope.capability, QuotaCapability::Experimental);
            assert!(envelope.action.is_none());
            if matches!(envelope.status, QuotaStatus::Ok | QuotaStatus::Stale) {
                assert!(
                    valid_plan_envelope(&envelope, &envelope.provider_id, now),
                    "{} must be a valid plan envelope",
                    envelope.provider_id
                );
            } else {
                assert!(envelope.windows.is_empty());
                assert!(matches!(
                    envelope.reason_code.as_deref(),
                    Some(CONSENT_REASON | "api_key_required")
                ));
            }
        }
    }
}
