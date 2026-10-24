//! Alert webhooks: forwards the desktop reminders (budget, quota window,
//! usage anomaly, period report) to chat robots or a generic JSON hook.
//!
//! Nothing here decides when to alert. Each reminder module keeps its own
//! dedup and hourly cap and calls [`forward`] for every notification it has
//! just shown, so a webhook receives exactly the system notifications, plus
//! a per-endpoint safety cap. Off by default: the master switch is off and
//! there are no endpoints.
//!
//! Addresses carry the robot's token, so the address and the signing secret
//! live only in the OS credential store; the settings file keeps the
//! platform, name, switches and the host for display. Messages carry no
//! cost figures unless the endpoint opted in.

mod payload;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Utc};
use reqwest::redirect;
use serde::{Deserialize, Serialize};

use crate::app_paths::AppContext;
pub use payload::WebhookPlatform;
use payload::{MessageText, PreparedRequest};

const SETTINGS_FILE: &str = "alert_webhook_settings.json";
const STATE_FILE: &str = "alert_webhook_state.json";
const MAX_SETTINGS_BYTES: usize = 16 * 1024;
const MAX_STATE_BYTES: usize = 16 * 1024;
const MAX_CREDENTIAL_BYTES: usize = 4 * 1024;
pub(crate) const MAX_ENDPOINTS: usize = 8;
const MAX_NAME_CHARS: usize = 32;
const MAX_ID_CHARS: usize = 40;
/// Safety net on top of the reminders' own caps (each at most a few an
/// hour): a misconfigured source can never flood a group.
const ENDPOINT_HOURLY_LIMIT: usize = 12;
const TEST_INTERVAL_SECONDS: i64 = 5;
const REQUEST_TIMEOUT: StdDuration = StdDuration::from_secs(10);
const CONNECT_TIMEOUT: StdDuration = StdDuration::from_secs(5);
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
const KEYRING_SERVICE: &str = "com.jeidorf.tokenledger.alert-webhook";
const KEYRING_ACCOUNT_PREFIX: &str = "webhook:";

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
static STATE_LOCK: Mutex<()> = Mutex::new(());
static SENT: OnceLock<Mutex<HashMap<String, Vec<DateTime<Utc>>>>> = OnceLock::new();
static LAST_TEST: OnceLock<Mutex<HashMap<String, DateTime<Utc>>>> = OnceLock::new();
static KEYRING_STORE: OnceLock<KeyringStore> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AlertKind {
    Budget,
    Quota,
    Anomaly,
    PeriodReport,
}

impl AlertKind {
    pub(crate) const ALL: [AlertKind; 4] = [
        AlertKind::Budget,
        AlertKind::Quota,
        AlertKind::Anomaly,
        AlertKind::PeriodReport,
    ];

    fn key(self) -> &'static str {
        match self {
            Self::Budget => "budget",
            Self::Quota => "quota",
            Self::Anomaly => "anomaly",
            Self::PeriodReport => "periodReport",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Budget => "预算提醒",
            Self::Quota => "额度提醒",
            Self::Anomaly => "用量异常",
            Self::PeriodReport => "用量报告",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookEndpoint {
    pub id: String,
    pub platform: WebhookPlatform,
    pub name: String,
    pub enabled: bool,
    pub kinds: Vec<AlertKind>,
    /// Append estimated cost figures (budget used / limit, cost spikes).
    #[serde(default)]
    pub include_cost: bool,
    /// Host of the stored address, for display only.
    #[serde(default)]
    pub url_hint: String,
    #[serde(default)]
    pub has_secret: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertWebhookSettings {
    pub enabled: bool,
    pub endpoints: Vec<WebhookEndpoint>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryResult {
    pub at: DateTime<Utc>,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub test: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryState {
    #[serde(default)]
    results: HashMap<String, DeliveryResult>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointView {
    #[serde(flatten)]
    pub endpoint: WebhookEndpoint,
    pub last_result: Option<DeliveryResult>,
}

/// Whether each source reminder is switched on: a webhook only receives
/// what the reminder itself shows.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSwitches {
    pub budget: bool,
    pub quota: bool,
    pub anomaly: bool,
    pub period_report: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertWebhookView {
    pub enabled: bool,
    pub endpoints: Vec<EndpointView>,
    pub sources: SourceSwitches,
    pub max_endpoints: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointInput {
    #[serde(default)]
    pub id: Option<String>,
    pub platform: WebhookPlatform,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub kinds: Vec<AlertKind>,
    #[serde(default)]
    pub include_cost: bool,
    /// Absent keeps the stored address.
    #[serde(default)]
    pub url: Option<String>,
    /// Absent keeps the stored secret (when the address host is unchanged).
    #[serde(default)]
    pub secret: Option<String>,
    #[serde(default)]
    pub clear_secret: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StoredCredential {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

impl std::fmt::Debug for StoredCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredCredential")
            .field("url", &payload::url_hint(&self.url))
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// Seam over the OS credential store so tests never touch the keychain.
pub(crate) trait CredentialStore: Send + Sync {
    fn load(&self, id: &str) -> Result<Option<StoredCredential>, String>;
    fn save(&self, id: &str, credential: &StoredCredential) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}

/// Keychain-backed store with a process cache, so an unsigned build does
/// not ask for keychain access on every alert.
#[derive(Default)]
struct KeyringStore {
    cache: Mutex<HashMap<String, StoredCredential>>,
}

fn keyring_entry(id: &str) -> Result<keyring::Entry, String> {
    if !valid_id(id) {
        return Err("Webhook 配置 ID 无效。".to_string());
    }
    keyring::Entry::new(KEYRING_SERVICE, &format!("{KEYRING_ACCOUNT_PREFIX}{id}"))
        .map_err(|_| "无法访问系统钥匙串。".to_string())
}

impl CredentialStore for KeyringStore {
    fn load(&self, id: &str) -> Result<Option<StoredCredential>, String> {
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(credential) = cache.get(id) {
            return Ok(Some(credential.clone()));
        }
        let raw = match keyring_entry(id)?.get_password() {
            Ok(raw) => raw,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(_) => return Err("无法读取系统钥匙串里的 Webhook 地址。".to_string()),
        };
        if raw.len() > MAX_CREDENTIAL_BYTES {
            return Err("钥匙串里的 Webhook 记录无效，请重新填写地址。".to_string());
        }
        let credential: StoredCredential = serde_json::from_str(&raw)
            .map_err(|_| "钥匙串里的 Webhook 记录无效，请重新填写地址。".to_string())?;
        cache.insert(id.to_string(), credential.clone());
        Ok(Some(credential))
    }

    fn save(&self, id: &str, credential: &StoredCredential) -> Result<(), String> {
        let raw = serde_json::to_string(credential).map_err(|error| error.to_string())?;
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.remove(id);
        keyring_entry(id)?
            .set_password(&raw)
            .map_err(|_| "无法写入系统钥匙串。".to_string())?;
        cache.insert(id.to_string(), credential.clone());
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.remove(id);
        match keyring_entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("无法从系统钥匙串删除 Webhook 地址。".to_string()),
        }
    }
}

fn keyring_store() -> &'static KeyringStore {
    KEYRING_STORE.get_or_init(KeyringStore::default)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_CHARS
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn new_id() -> String {
    let mut raw = [0_u8; 8];
    let _ = getrandom::fill(&mut raw);
    let hex: String = raw.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("wh-{hex}")
}

fn sanitize_kinds(kinds: &[AlertKind]) -> Vec<AlertKind> {
    AlertKind::ALL
        .into_iter()
        .filter(|kind| kinds.contains(kind))
        .collect()
}

fn sanitize_name(name: &str, platform: WebhookPlatform) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .take(MAX_NAME_CHARS)
        .collect();
    if cleaned.trim().is_empty() {
        default_name(platform).to_string()
    } else {
        cleaned.trim().to_string()
    }
}

fn default_name(platform: WebhookPlatform) -> &'static str {
    match platform {
        WebhookPlatform::Feishu => "飞书群",
        WebhookPlatform::Dingtalk => "钉钉群",
        WebhookPlatform::Wecom => "企业微信群",
        WebhookPlatform::Slack => "Slack",
        WebhookPlatform::Discord => "Discord",
        WebhookPlatform::Generic => "Webhook",
    }
}

/// Endpoints are parsed one by one: a row another build cannot read is
/// dropped without losing the rest.
pub(crate) fn load_settings(app_data_dir: &Path) -> AlertWebhookSettings {
    let Some(value) =
        crate::quota::read_private_app_data_file(app_data_dir, SETTINGS_FILE, MAX_SETTINGS_BYTES)
            .ok()
            .flatten()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return AlertWebhookSettings::default();
    };
    let mut endpoints: Vec<WebhookEndpoint> = value
        .get("endpoints")
        .and_then(serde_json::Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    // A kind added by a newer build is skipped, not fatal.
                    let mut row = row.clone();
                    if let Some(kinds) = row
                        .get_mut("kinds")
                        .and_then(serde_json::Value::as_array_mut)
                    {
                        kinds.retain(|kind| {
                            serde_json::from_value::<AlertKind>(kind.clone()).is_ok()
                        });
                    }
                    serde_json::from_value::<WebhookEndpoint>(row).ok()
                })
                .filter(|endpoint| valid_id(&endpoint.id))
                .collect()
        })
        .unwrap_or_default();
    endpoints.truncate(MAX_ENDPOINTS);
    for endpoint in &mut endpoints {
        endpoint.kinds = sanitize_kinds(&endpoint.kinds);
        endpoint.name = sanitize_name(&endpoint.name, endpoint.platform);
        endpoint.has_secret &= endpoint.platform.supports_secret();
    }
    AlertWebhookSettings {
        enabled: value
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        endpoints,
    }
}

fn save_settings(app_data_dir: &Path, settings: &AlertWebhookSettings) -> Result<(), String> {
    let bytes = serde_json::to_vec(settings).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err("Webhook 设置过大。".to_string());
    }
    crate::quota::write_private_app_data_file(app_data_dir, SETTINGS_FILE, &bytes)
}

fn load_state(app_data_dir: &Path) -> DeliveryState {
    crate::quota::read_private_app_data_file(app_data_dir, STATE_FILE, MAX_STATE_BYTES)
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn record_result(app_data_dir: &Path, id: &str, result: DeliveryResult) {
    let _guard = STATE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let settings = load_settings(app_data_dir);
    let mut state = load_state(app_data_dir);
    state.results.retain(|key, _| {
        settings
            .endpoints
            .iter()
            .any(|endpoint| &endpoint.id == key)
    });
    if settings.endpoints.iter().any(|endpoint| endpoint.id == id) {
        state.results.insert(id.to_string(), result);
    }
    match serde_json::to_vec(&state) {
        Ok(bytes) => {
            if let Err(error) =
                crate::quota::write_private_app_data_file(app_data_dir, STATE_FILE, &bytes)
            {
                log::warn!("alert webhook state not saved: {error}");
            }
        }
        Err(error) => log::warn!("alert webhook state not serialized: {error}"),
    }
}

fn source_switches(app_data_dir: &Path) -> SourceSwitches {
    SourceSwitches {
        budget: crate::budget::load_settings(app_data_dir).notify,
        quota: crate::quota::alerts::load_settings(app_data_dir).enabled,
        anomaly: crate::usage_anomaly::load_settings(app_data_dir).notify,
        period_report: None,
    }
}

fn view(app_data_dir: &Path) -> AlertWebhookView {
    let settings = load_settings(app_data_dir);
    let mut state = load_state(app_data_dir);
    AlertWebhookView {
        enabled: settings.enabled,
        endpoints: settings
            .endpoints
            .into_iter()
            .map(|endpoint| {
                let last_result = state.results.remove(&endpoint.id);
                EndpointView {
                    endpoint,
                    last_result,
                }
            })
            .collect(),
        sources: source_switches(app_data_dir),
        max_endpoints: MAX_ENDPOINTS,
    }
}

/// Applies one add or edit. The credential is written before the settings,
/// and a new endpoint's credential is removed again if the settings write
/// fails, so the keychain never keeps an address the settings forgot.
pub(crate) fn upsert_endpoint(
    app_data_dir: &Path,
    store: &dyn CredentialStore,
    input: EndpointInput,
) -> Result<WebhookEndpoint, String> {
    let _guard = SETTINGS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut settings = load_settings(app_data_dir);
    let existing = match input.id.as_deref() {
        Some(id) => Some(
            settings
                .endpoints
                .iter()
                .position(|endpoint| endpoint.id == id)
                .ok_or_else(|| "这个 Webhook 已被删除，请刷新后重试。".to_string())?,
        ),
        None => None,
    };
    if existing.is_none() && settings.endpoints.len() >= MAX_ENDPOINTS {
        return Err(format!("最多添加 {MAX_ENDPOINTS} 个 Webhook。"));
    }
    let id = input.id.clone().unwrap_or_else(new_id);
    let previous = existing.map(|index| settings.endpoints[index].clone());
    let stored = match &previous {
        Some(_) => store.load(&id)?,
        None => None,
    };
    let platform_changed = previous
        .as_ref()
        .is_some_and(|previous| previous.platform != input.platform);

    let url = match input
        .url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
    {
        Some(url) => payload::normalize_url(input.platform, url)?,
        None if platform_changed => return Err("换了平台，请重新填写 Webhook 地址。".to_string()),
        None => stored
            .as_ref()
            .map(|stored| stored.url.clone())
            .ok_or_else(|| "请填写 Webhook 地址。".to_string())?,
    };
    let same_host = stored
        .as_ref()
        .is_some_and(|stored| payload::url_hint(&stored.url) == payload::url_hint(&url));
    let secret = if !input.platform.supports_secret() || input.clear_secret {
        None
    } else if let Some(secret) = input.secret.as_deref().filter(|secret| !secret.is_empty()) {
        payload::validate_secret(secret)?;
        Some(secret.to_string())
    } else if same_host && !platform_changed {
        // A secret only follows its own host: pointing an endpoint elsewhere
        // never keeps signing with the old robot's key.
        stored.as_ref().and_then(|stored| stored.secret.clone())
    } else {
        None
    };

    let endpoint = WebhookEndpoint {
        id: id.clone(),
        platform: input.platform,
        name: sanitize_name(&input.name, input.platform),
        enabled: input.enabled,
        kinds: sanitize_kinds(&input.kinds),
        include_cost: input.include_cost,
        url_hint: payload::url_hint(&url),
        has_secret: secret.is_some(),
    };
    let credential = StoredCredential { url, secret };
    if stored.as_ref() != Some(&credential) {
        store.save(&id, &credential)?;
    }
    match existing {
        Some(index) => settings.endpoints[index] = endpoint.clone(),
        None => settings.endpoints.push(endpoint.clone()),
    }
    if let Err(error) = save_settings(app_data_dir, &settings) {
        if previous.is_none() {
            let _ = store.delete(&id);
        } else if let Some(stored) = &stored {
            let _ = store.save(&id, stored);
        }
        return Err(error);
    }
    Ok(endpoint)
}

pub(crate) fn remove_endpoint(
    app_data_dir: &Path,
    store: &dyn CredentialStore,
    id: &str,
) -> Result<(), String> {
    let _guard = SETTINGS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut settings = load_settings(app_data_dir);
    let before = settings.endpoints.len();
    settings.endpoints.retain(|endpoint| endpoint.id != id);
    if settings.endpoints.len() != before {
        save_settings(app_data_dir, &settings)?;
    }
    // Delete the credential even when the row was already gone, so a half
    // finished earlier delete does not leave the address behind.
    store.delete(id)
}

fn set_enabled(app_data_dir: &Path, enabled: bool) -> Result<(), String> {
    let _guard = SETTINGS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut settings = load_settings(app_data_dir);
    settings.enabled = enabled;
    save_settings(app_data_dir, &settings)
}

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

/// One message an endpoint should receive now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlannedDelivery {
    pub endpoint: WebhookEndpoint,
    pub message: MessageText,
}

/// Picks the endpoints that take this kind and are under their hourly cap,
/// and records the send against the cap. Cost text is dropped for
/// endpoints that did not opt in.
pub(crate) fn plan_deliveries(
    settings: &AlertWebhookSettings,
    sent: &mut HashMap<String, Vec<DateTime<Utc>>>,
    kind: AlertKind,
    title: &str,
    body: &str,
    cost: Option<&str>,
    now: DateTime<Utc>,
) -> Vec<PlannedDelivery> {
    sent.retain(|id, times| {
        times.retain(|at| (now - *at) < Duration::hours(1) && *at <= now);
        !times.is_empty() && settings.endpoints.iter().any(|endpoint| &endpoint.id == id)
    });
    if !settings.enabled {
        return Vec::new();
    }
    let mut planned = Vec::new();
    for endpoint in &settings.endpoints {
        if !endpoint.enabled || !endpoint.kinds.contains(&kind) {
            continue;
        }
        let times = sent.entry(endpoint.id.clone()).or_default();
        if times.len() >= ENDPOINT_HOURLY_LIMIT {
            log::info!("alert webhook {} skipped: hourly cap reached", endpoint.id);
            continue;
        }
        times.push(now);
        planned.push(PlannedDelivery {
            endpoint: endpoint.clone(),
            message: MessageText {
                kind_key: kind.key(),
                kind_label: kind.label(),
                title: title.to_string(),
                body: body.to_string(),
                cost: cost.filter(|_| endpoint.include_cost).map(str::to_string),
            },
        });
    }
    planned
}

/// Called by each reminder right after it showed a system notification.
/// Returns at once; delivery runs on the async runtime. A missing settings
/// file (the default, and every unit test of the reminder modules) is a
/// no-op.
pub(crate) fn forward(
    app_data_dir: &Path,
    kind: AlertKind,
    title: &str,
    body: &str,
    cost: Option<&str>,
) {
    let settings = load_settings(app_data_dir);
    if !settings.enabled || settings.endpoints.is_empty() {
        return;
    }
    let planned = {
        let mut sent = SENT
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        plan_deliveries(&settings, &mut sent, kind, title, body, cost, Utc::now())
    };
    if planned.is_empty() {
        return;
    }
    let app_data_dir = app_data_dir.to_path_buf();
    tauri::async_runtime::spawn(async move {
        for delivery in planned {
            let id = delivery.endpoint.id.clone();
            let result = deliver(keyring_store(), &delivery.endpoint, &delivery.message).await;
            if let Err(error) = &result {
                log::warn!("alert webhook {id} failed: {error}");
            }
            let dir = app_data_dir.clone();
            let outcome = DeliveryResult {
                at: Utc::now(),
                ok: result.is_ok(),
                error: result.err(),
                test: false,
            };
            let _ = tauri::async_runtime::spawn_blocking(move || record_result(&dir, &id, outcome))
                .await;
        }
    });
}

async fn deliver(
    store: &'static dyn CredentialStore,
    endpoint: &WebhookEndpoint,
    message: &MessageText,
) -> Result<(), String> {
    let id = endpoint.id.clone();
    let credential = tauri::async_runtime::spawn_blocking(move || store.load(&id))
        .await
        .map_err(|_| "读取钥匙串失败。".to_string())??
        .ok_or_else(|| "钥匙串里找不到这个 Webhook 的地址，请重新填写。".to_string())?;
    let request = payload::build_request(
        endpoint.platform,
        &credential.url,
        credential.secret.as_deref(),
        message,
        Utc::now().timestamp_millis(),
    )?;
    send(endpoint.platform, &request).await
}

pub(crate) async fn send(
    platform: WebhookPlatform,
    request: &PreparedRequest,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .redirect(redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| "无法创建网络连接。".to_string())?;
    let mut builder = client.post(&request.url).body(request.body.clone());
    for (name, value) in &request.headers {
        builder = builder.header(*name, value);
    }
    // reqwest errors print the full address, which carries the robot token.
    let response = builder
        .send()
        .await
        .map_err(|error| describe_error(&error))?;
    let status = response.status().as_u16();
    let body = read_capped(response).await;
    payload::check_response(platform, status, &body)
}

fn describe_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "连接超时。".to_string()
    } else if error.is_connect() {
        "连不上平台服务器，检查网络或代理。".to_string()
    } else {
        "发送失败，网络请求出错。".to_string()
    }
}

async fn read_capped(mut response: reqwest::Response) -> String {
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        let room = MAX_RESPONSE_BYTES.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if bytes.len() >= MAX_RESPONSE_BYTES {
            break;
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn test_message() -> MessageText {
    MessageText {
        kind_key: "test",
        kind_label: "测试",
        title: "Webhook 已接通".to_string(),
        body: "收到这条消息，说明 TokenLedger 的提醒可以推送到这里了。".to_string(),
        cost: None,
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_alert_webhooks(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
) -> Result<AlertWebhookView, String> {
    let app = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || view(app.app_data_dir()))
        .await
        .map_err(|error| format!("get_alert_webhooks task panicked: {error}"))
}

#[tauri::command]
pub async fn set_alert_webhooks_enabled(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
    enabled: bool,
) -> Result<AlertWebhookView, String> {
    let app = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        set_enabled(app.app_data_dir(), enabled)?;
        Ok(view(app.app_data_dir()))
    })
    .await
    .map_err(|error| format!("set_alert_webhooks_enabled task panicked: {error}"))?
}

#[tauri::command]
pub async fn save_alert_webhook(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
    input: EndpointInput,
) -> Result<AlertWebhookView, String> {
    let app = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        upsert_endpoint(app.app_data_dir(), keyring_store(), input)?;
        Ok(view(app.app_data_dir()))
    })
    .await
    .map_err(|error| format!("save_alert_webhook task panicked: {error}"))?
}

#[tauri::command]
pub async fn delete_alert_webhook(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
    id: String,
) -> Result<AlertWebhookView, String> {
    if !valid_id(&id) {
        return Err("Webhook 配置 ID 无效。".to_string());
    }
    let app = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        remove_endpoint(app.app_data_dir(), keyring_store(), &id)?;
        Ok(view(app.app_data_dir()))
    })
    .await
    .map_err(|error| format!("delete_alert_webhook task panicked: {error}"))?
}

/// Sends a fixed sample message to one endpoint, whatever its switches, so
/// the address can be checked before turning forwarding on.
#[tauri::command]
pub async fn test_alert_webhook(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
    id: String,
) -> Result<TestResult, String> {
    if !valid_id(&id) {
        return Err("Webhook 配置 ID 无效。".to_string());
    }
    let now = Utc::now();
    {
        let mut last = LAST_TEST
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if last
            .get(&id)
            .is_some_and(|at| (now - *at).num_seconds() < TEST_INTERVAL_SECONDS)
        {
            return Ok(TestResult {
                ok: false,
                error: Some("刚刚测试过，请稍等几秒再试。".to_string()),
            });
        }
        last.insert(id.clone(), now);
    }
    let app = app_state.inner().clone();
    let settings = load_settings(app.app_data_dir());
    let endpoint = settings
        .endpoints
        .into_iter()
        .find(|endpoint| endpoint.id == id)
        .ok_or_else(|| "这个 Webhook 已被删除，请刷新后重试。".to_string())?;
    let result = deliver(keyring_store(), &endpoint, &test_message()).await;
    let outcome = DeliveryResult {
        at: Utc::now(),
        ok: result.is_ok(),
        error: result.clone().err(),
        test: true,
    };
    let dir = app.app_data_dir().to_path_buf();
    let _ = tauri::async_runtime::spawn_blocking(move || record_result(&dir, &id, outcome)).await;
    Ok(TestResult {
        ok: result.is_ok(),
        error: result.err(),
    })
}
