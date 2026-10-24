//! Uploads three per-day usage dimensions (sessions, gateway accounts, average
//! context composition) for the Android read-only views
//! (docs/contracts/usage-dimensions-cloud-v1.md).
//!
//! Every number comes from the same local functions the desktop views use: the
//! Stats v2 snapshot (`providers`, `contextComposition`) and the behaviour analysis
//! (`sessions`), queried one local day at a time for this machine only. Only sizes,
//! counts and the whitelisted account names leave this computer; session IDs are
//! replaced by an HMAC keyed with a secret that never leaves the OS keychain.
//!
//! Each dimension has its own switch, off by default. Turning one off deletes that
//! dimension's cloud rows (`clear_usage_dimension_v1`) and stops uploading it; a
//! marker file per dimension lets that clear resume after a restart. Uploads ride
//! the existing cloud sync cycle (a nudge after each background sync) and never
//! touch `token_logs` sync.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{Local, NaiveDate, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::app_paths::AppContext;
use crate::commands::LocalStatsQuery;
use crate::gateway::SecretStore;
use crate::settings::AppSettings;

const TICK: Duration = Duration::from_secs(5);
const SIGNED_OUT_RETRY: Duration = Duration::from_secs(30);
/// Contract §5: a missing RPC is retried after five minutes.
const NOT_DEPLOYED_RETRY: Duration = Duration::from_secs(300);
const MAX_BACKOFF: Duration = Duration::from_secs(300);
const MAX_RESPONSE_BYTES: usize = 8 * 1024;
const RPC_TIMEOUT: Duration = Duration::from_secs(30);

/// Days kept in the cloud (contract §1) and backfilled on first enable.
pub const WINDOW_DAYS: i64 = 90;
/// One day of margin under the server's `UTC date − 90` floor: a batch with a single
/// day out of range is rejected as a whole.
const OLDEST_SAFE_UTC_OFFSET: i64 = WINDOW_DAYS - 1;
/// Chunk limits, well inside contract §3.1 (92 dates per dimension, 10000 rows,
/// 2 MiB of `jsonb::text`).
const MAX_DATES_PER_CALL: usize = 31;
const MAX_ROWS_PER_CALL: usize = 2000;
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
const _: () = assert!(
    MAX_DATES_PER_CALL <= 92 && MAX_ROWS_PER_CALL <= 10_000 && MAX_PAYLOAD_BYTES <= 2 * 1024 * 1024
);
/// Contract §3.1: at most 500 session rows per day.
const MAX_SESSION_ROWS_PER_DAY: usize = 500;
const MAX_LABEL_CHARS: usize = 128;

const STATE_FILE: &str = "usage-dimensions-publish-v1.json";
const SESSION_SECRET_ACCOUNT: &str = "usage-dimensions-session-key-v1";

/// Contract §2.1, `other` excluded (it is the catch-all).
pub const PROVIDER_WHITELIST: &[&str] = &[
    "anthropic",
    "ark",
    "deepseek",
    "gemini",
    "glm",
    "groq",
    "kimi",
    "lmstudio",
    "mistral",
    "ollama",
    "openai",
    "openrouter",
    "qwen",
    "siliconflow",
    "xai",
];
pub const OTHER_PROVIDER: &str = "other";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Dimension {
    Sessions,
    Providers,
    Context,
}

impl Dimension {
    pub const ALL: [Dimension; 3] = [
        Dimension::Sessions,
        Dimension::Providers,
        Dimension::Context,
    ];

    /// The payload key and the `clear_usage_dimension_v1` argument.
    pub fn as_str(self) -> &'static str {
        match self {
            Dimension::Sessions => "sessions",
            Dimension::Providers => "providers",
            Dimension::Context => "context",
        }
    }

    fn index(self) -> usize {
        match self {
            Dimension::Sessions => 0,
            Dimension::Providers => 1,
            Dimension::Context => 2,
        }
    }

    fn marker_file(self) -> String {
        format!("usage-dimension-{}-clear-pending", self.as_str())
    }
}

/// Which switches are on, indexed by [`Dimension::index`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mask([bool; 3]);

impl Mask {
    pub fn from_settings(settings: &AppSettings) -> Self {
        Mask([
            settings.usage_dimension_sessions_enabled,
            settings.usage_dimension_providers_enabled,
            settings.usage_dimension_context_enabled,
        ])
    }

    pub fn has(self, dimension: Dimension) -> bool {
        self.0[dimension.index()]
    }

    fn any(self) -> bool {
        self.0.iter().any(|on| *on)
    }

    fn enabled(self) -> impl Iterator<Item = Dimension> {
        Dimension::ALL.into_iter().filter(move |d| self.has(*d))
    }

    /// True when every dimension on in `self` is still on in `now`.
    fn still_covered_by(self, now: Mask) -> bool {
        self.enabled().all(|d| now.has(d))
    }
}

// ---------------------------------------------------------------------------
// Status for the settings page

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DimensionStatus {
    /// `off` | `signed-out` | `not-deployed` | `ok` | `error` | `starting`
    pub state: &'static str,
    pub last_uploaded_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageDimensionsStatus {
    pub sessions: DimensionStatus,
    pub providers: DimensionStatus,
    pub context: DimensionStatus,
}

impl UsageDimensionsStatus {
    fn get_mut(&mut self, dimension: Dimension) -> &mut DimensionStatus {
        match dimension {
            Dimension::Sessions => &mut self.sessions,
            Dimension::Providers => &mut self.providers,
            Dimension::Context => &mut self.context,
        }
    }
}

fn off_status() -> DimensionStatus {
    DimensionStatus {
        state: "off",
        ..Default::default()
    }
}

fn status_cell() -> &'static Mutex<UsageDimensionsStatus> {
    static STATUS: OnceLock<Mutex<UsageDimensionsStatus>> = OnceLock::new();
    STATUS.get_or_init(|| {
        Mutex::new(UsageDimensionsStatus {
            sessions: off_status(),
            providers: off_status(),
            context: off_status(),
        })
    })
}

fn set_status(dimension: Dimension, update: impl FnOnce(&mut DimensionStatus)) {
    let mut guard = status_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    update(guard.get_mut(dimension));
}

fn set_status_for(mask: Mask, update: impl Fn(&mut DimensionStatus)) {
    for dimension in mask.enabled() {
        set_status(dimension, &update);
    }
}

/// What the settings page shows next to the three switches.
#[tauri::command]
pub fn usage_dimensions_publish_status(
    window: tauri::WebviewWindow,
) -> Result<UsageDimensionsStatus, String> {
    if window.label() != "main" {
        return Err("用量维度同步状态只允许主窗口读取。".to_string());
    }
    Ok(status_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone())
}

// ---------------------------------------------------------------------------
// Sync-cycle hook

static SYNC_NUDGE: AtomicBool = AtomicBool::new(false);

/// Called after each background cloud sync: the next pass re-sends today, yesterday
/// and changed days. Only sets a flag, so `token_logs` sync never waits on this.
pub fn nudge_after_cloud_sync() {
    SYNC_NUDGE.store(true, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// Pure mapping (contract §2.1, §2.2, §3.1)

/// Contract §2.1: trim, lowercase, exact whitelist match; everything else is `other`.
pub fn provider_bucket(raw: &str) -> &'static str {
    let name = raw.trim().to_lowercase();
    PROVIDER_WHITELIST
        .iter()
        .find(|allowed| **allowed == name)
        .copied()
        .unwrap_or(OTHER_PROVIDER)
}

/// Contract §2.2: the first 16 bytes of `HMAC-SHA256(secret, tool + "\n" + id)`, hex.
pub fn session_key(secret: &[u8; 32], tool: &str, session_id: &str) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret);
    let tag = ring::hmac::sign(&key, format!("{tool}\n{session_id}").as_bytes());
    tag.as_ref()[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Local wall clock `YYYY-MM-DD HH:MM[:SS]` (or with `T`) → `HH:MM`.
pub fn hh_mm(timestamp: &str) -> Option<String> {
    let time = timestamp.trim().get(11..16)?;
    let bytes = time.as_bytes();
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    if bytes[2] != b':' || !digits(0..2) || !digits(3..5) {
        return None;
    }
    let hour: u8 = time[..2].parse().ok()?;
    let minute: u8 = time[3..].parse().ok()?;
    (hour < 24 && minute < 60).then(|| time.to_string())
}

fn clip(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn count(value: &Value) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|f| f as i64))
        .unwrap_or(0)
        .max(0)
}

/// `None` when unknown: null, missing or not a finite non-negative number.
fn cost(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
}

/// The machine's day of sessions from the local behaviour analysis.
pub fn session_day(date: &str, behavior: &Value, secret: &[u8; 32]) -> Value {
    let mut rows = Vec::new();
    let mut dropped = false;
    for session in behavior["sessions"].as_array().into_iter().flatten() {
        let id = session["id"].as_str().unwrap_or("").trim();
        let tool = clip(session["tool"].as_str().unwrap_or(""), MAX_LABEL_CHARS);
        let requests = count(&session["requests"]);
        let (Some(first_at), Some(last_at)) = (
            session["firstAt"].as_str().and_then(hh_mm),
            session["lastAt"].as_str().and_then(hh_mm),
        ) else {
            dropped = true;
            continue;
        };
        if id.is_empty() || id == "unknown_session" || tool.is_empty() || requests < 1 {
            dropped = true;
            continue;
        }
        let (first_at, last_at) = if first_at <= last_at {
            (first_at, last_at)
        } else {
            (last_at, first_at)
        };
        let top_model = session["topModel"]
            .as_str()
            .map(|model| clip(model, MAX_LABEL_CHARS))
            .filter(|model| !model.is_empty());
        rows.push(json!({
            "key": session_key(secret, &tool, id),
            "tool": tool,
            "tokens": count(&session["tokens"]),
            "requests": requests,
            "cost": cost(&session["cost"]),
            "firstAt": first_at,
            "lastAt": last_at,
            "topModel": top_model,
        }));
    }
    if rows.len() > MAX_SESSION_ROWS_PER_DAY {
        rows.sort_by(|a, b| count(&b["tokens"]).cmp(&count(&a["tokens"])));
        rows.truncate(MAX_SESSION_ROWS_PER_DAY);
        dropped = true;
    }
    let truncated = dropped || behavior["meta"]["sessionsTruncated"].as_bool() == Some(true);
    json!({ "date": date, "truncated": truncated, "rows": rows })
}

#[derive(Default)]
struct ProviderSum {
    input: i64,
    output: i64,
    cached: i64,
    cache_write: i64,
    requests: i64,
    cost: Option<f64>,
}

/// The machine's day of gateway accounts from the local Stats v2 `providers` object,
/// mapped onto the whitelist with everything else merged into `other`.
pub fn provider_day(date: &str, stats: &Value) -> Value {
    let mut sums: BTreeMap<&'static str, ProviderSum> = BTreeMap::new();
    if let Some(providers) = stats["providers"].as_object() {
        for (name, entry) in providers {
            let bucket = provider_bucket(entry["name"].as_str().unwrap_or(name));
            let first = !sums.contains_key(bucket);
            let sum = sums.entry(bucket).or_default();
            if first {
                sum.cost = Some(0.0);
            }
            sum.input += count(&entry["input"]);
            sum.output += count(&entry["output"]);
            sum.cached += count(&entry["cached"]);
            sum.cache_write += count(&entry["cacheWrite"]);
            sum.requests += count(&entry["requests"]);
            sum.cost = match (sum.cost, cost(&entry["cost"])) {
                (Some(total), Some(part)) => Some(total + part),
                _ => None,
            };
        }
    }
    let mut rows: Vec<Value> = sums
        .into_iter()
        .filter(|(_, sum)| sum.requests >= 1)
        .map(|(provider, sum)| {
            json!({
                "provider": provider,
                "input": sum.input,
                "output": sum.output,
                "cached": sum.cached,
                "cacheWrite": sum.cache_write,
                "requests": sum.requests,
                "cost": sum.cost.map(|cost| (cost * 1e6).round() / 1e6),
            })
        })
        .collect();
    // `other` last, the rest by name.
    rows.sort_by_key(|row| row["provider"] == OTHER_PROVIDER);
    json!({ "date": date, "rows": rows })
}

/// The machine's day of context composition, `row: null` when the day has none.
pub fn context_day(date: &str, stats: &Value) -> Value {
    let composition = &stats["contextComposition"];
    let row = composition
        .as_object()
        .filter(|_| count(&composition["requests"]) >= 1)
        .map(|_| {
            let mut row = Map::new();
            for field in [
                "requests",
                "promptTokens",
                "systemBytes",
                "toolsBytes",
                "historyBytes",
                "toolResultsBytes",
                "attachmentsBytes",
                "messages",
                "toolResults",
                "attachments",
            ] {
                row.insert(field.to_string(), json!(count(&composition[field])));
            }
            Value::Object(row)
        });
    json!({ "date": date, "row": row })
}

/// Rows a day entry adds toward the per-call row limit.
fn entry_rows(entry: &Value) -> usize {
    match entry.get("rows") {
        Some(rows) => rows.as_array().map_or(0, Vec::len),
        None => usize::from(!entry["row"].is_null()),
    }
}

/// One local day's entries for the dimensions being sent that day.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DayParts {
    pub date: String,
    /// Indexed by [`Dimension::index`].
    pub entries: [Option<Value>; 3],
}

/// One RPC call: its payload and the (dimension, date) pairs it stores.
#[derive(Clone, Debug, PartialEq)]
pub struct Chunk {
    pub payload: Value,
    pub covers: Vec<(Dimension, String)>,
}

fn payload_of(machine: &str, days: &[&DayParts]) -> Value {
    let mut payload = Map::new();
    payload.insert("v".to_string(), json!(1));
    payload.insert("machine".to_string(), json!(machine));
    for dimension in Dimension::ALL {
        let entries: Vec<&Value> = days
            .iter()
            .filter_map(|day| day.entries[dimension.index()].as_ref())
            .collect();
        if !entries.is_empty() {
            payload.insert(dimension.as_str().to_string(), json!({ "days": entries }));
        }
    }
    Value::Object(payload)
}

/// Packs whole days into calls that stay inside the chunk limits. A dimension with no
/// entries in a call is omitted from it, so the server leaves it untouched.
pub fn build_chunks(machine: &str, days: &[DayParts]) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut current: Vec<&DayParts> = Vec::new();
    let mut rows = 0;
    let flush = |current: &mut Vec<&DayParts>, chunks: &mut Vec<Chunk>| {
        if current.is_empty() {
            return;
        }
        let covers = current
            .iter()
            .flat_map(|day| {
                Dimension::ALL
                    .into_iter()
                    .filter(|d| day.entries[d.index()].is_some())
                    .map(|d| (d, day.date.clone()))
            })
            .collect();
        chunks.push(Chunk {
            payload: payload_of(machine, current),
            covers,
        });
        current.clear();
    };
    for day in days
        .iter()
        .filter(|day| day.entries.iter().any(Option::is_some))
    {
        let day_rows: usize = day.entries.iter().flatten().map(entry_rows).sum();
        let fits = current.len() < MAX_DATES_PER_CALL && rows + day_rows <= MAX_ROWS_PER_CALL && {
            let mut trial = current.clone();
            trial.push(day);
            server_text_len(&payload_of(machine, &trial)) <= MAX_PAYLOAD_BYTES
        };
        if !fits {
            flush(&mut current, &mut chunks);
            rows = 0;
        }
        current.push(day);
        rows += day_rows;
    }
    flush(&mut current, &mut chunks);
    chunks
}

/// Size as the server measures it (`octet_length(jsonb::text)`): the compact form plus
/// the space jsonb prints after every `:` and every `,` between items.
fn server_text_len(value: &Value) -> usize {
    fn separators(value: &Value) -> usize {
        match value {
            Value::Array(items) => {
                items.len().saturating_sub(1) + items.iter().map(separators).sum::<usize>()
            }
            Value::Object(map) => {
                map.len() * 2 - usize::from(!map.is_empty())
                    + map.values().map(separators).sum::<usize>()
            }
            _ => 0,
        }
    }
    value.to_string().len() + separators(value)
}

/// The backfill window, newest first: up to 90 local days ending today, never older
/// than the server's retention floor minus a day of margin.
pub fn window_dates(local_today: NaiveDate, utc_today: NaiveDate) -> Vec<NaiveDate> {
    let floor = utc_today - chrono::Duration::days(OLDEST_SAFE_UTC_OFFSET);
    (0..WINDOW_DAYS)
        .map(|back| local_today - chrono::Duration::days(back))
        .filter(|date| *date >= floor)
        .collect()
}

/// Days to send for one dimension: today and yesterday always, and every other day in
/// the window whose local fingerprint differs from the one last stored in the cloud
/// (never-uploaded days with data on first enable, days whose records changed, and
/// days whose records were deleted locally).
pub fn due_dates(
    window: &[NaiveDate],
    current: &BTreeMap<String, String>,
    uploaded: &BTreeMap<String, String>,
) -> Vec<String> {
    window
        .iter()
        .enumerate()
        .filter_map(|(position, date)| {
            let date = date.format("%Y-%m-%d").to_string();
            let changed = current.get(&date) != uploaded.get(&date);
            (position < 2 || changed).then_some(date)
        })
        .collect()
}

/// Per-day fingerprint of this machine's records: `requests:tokens` from the local
/// Stats v2 heatmap of the whole window.
pub fn fingerprints(stats: &Value) -> BTreeMap<String, String> {
    let tokens = stats["heatmap"].as_object();
    let requests = stats["heatmapRequests"].as_object();
    let mut out = BTreeMap::new();
    let dates: BTreeSet<&String> = tokens
        .into_iter()
        .flat_map(|map| map.keys())
        .chain(requests.into_iter().flat_map(|map| map.keys()))
        .collect();
    for date in dates {
        let t = tokens.and_then(|map| map.get(date)).map_or(0, count);
        let r = requests.and_then(|map| map.get(date)).map_or(0, count);
        if t > 0 || r > 0 {
            out.insert(date.clone(), format!("{r}:{t}"));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Session secret (contract §2.2)

fn parse_secret(hex: &str) -> Option<[u8; 32]> {
    let hex = hex.trim();
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Reads the 32-byte session secret from the keychain, creating it on first use.
pub fn load_or_create_session_secret(store: &dyn SecretStore) -> Result<[u8; 32], String> {
    if let Some(secret) = store
        .get(SESSION_SECRET_ACCOUNT)?
        .as_deref()
        .and_then(parse_secret)
    {
        return Ok(secret);
    }
    let mut secret = [0u8; 32];
    getrandom::fill(&mut secret).map_err(|error| format!("生成会话密钥失败：{error}"))?;
    let hex: String = secret.iter().map(|byte| format!("{byte:02x}")).collect();
    store.set(SESSION_SECRET_ACCOUNT, &hex)?;
    Ok(secret)
}

// ---------------------------------------------------------------------------
// Persistent upload state

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
struct UploadState {
    #[serde(default)]
    user: String,
    #[serde(default)]
    machine: String,
    /// dimension → date → fingerprint stored in the cloud.
    #[serde(default)]
    uploaded: BTreeMap<String, BTreeMap<String, String>>,
}

impl UploadState {
    fn dimension(&self, dimension: Dimension) -> BTreeMap<String, String> {
        self.uploaded
            .get(dimension.as_str())
            .cloned()
            .unwrap_or_default()
    }

    fn forget(&mut self, dimension: Dimension) {
        self.uploaded.remove(dimension.as_str());
    }

    fn record(&mut self, dimension: Dimension, date: &str, fingerprint: Option<&String>) {
        let days = self
            .uploaded
            .entry(dimension.as_str().to_string())
            .or_default();
        match fingerprint {
            Some(fingerprint) => {
                days.insert(date.to_string(), fingerprint.clone());
            }
            None => {
                days.remove(date);
            }
        }
    }

    fn prune(&mut self, oldest: &str) {
        for days in self.uploaded.values_mut() {
            days.retain(|date, _| date.as_str() >= oldest);
        }
    }
}

// ---------------------------------------------------------------------------
// Cloud calls

#[derive(Debug, PartialEq)]
enum RpcError {
    NotDeployed,
    /// The signed-in account is not the one the request was built for.
    AccountChanged,
    /// The switch changed before the request left.
    Cancelled,
    Failed(String),
}

async fn read_bounded(response: reqwest::Response) -> Result<Vec<u8>, RpcError> {
    let mut response = response;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| RpcError::Failed(format!("读取云端回应失败：{}", error.without_url())))?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(RpcError::Failed("云端回应过大".to_string()));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn classify_failure(status: u16, body: &[u8]) -> RpcError {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let code = parsed.get("code").and_then(Value::as_str).unwrap_or("");
    if code == "PGRST202" {
        return RpcError::NotDeployed;
    }
    let message = parsed
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| message.starts_with("usage_dimensions_"))
        .map(str::to_string)
        .unwrap_or_else(|| format!("HTTP {status}"));
    RpcError::Failed(message)
}

async fn call_rpc(
    app: &AppContext,
    expected_user: &str,
    function: &str,
    body: Value,
    still_wanted: &(dyn Fn() -> bool + Send + Sync),
) -> Result<Value, RpcError> {
    let (config, lease) = crate::commands::acquire_current_cloud_session(app)
        .await
        .map_err(RpcError::Failed)?;
    let session = config
        .session
        .as_ref()
        .filter(|session| session.user_id == expected_user)
        .ok_or(RpcError::AccountChanged)?;
    let client = reqwest::Client::builder()
        .timeout(RPC_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| RpcError::Failed(error.to_string()))?;
    lease.ensure_current(app).map_err(RpcError::Failed)?;
    if !still_wanted() {
        return Err(RpcError::Cancelled);
    }
    let response = client
        .post(format!(
            "{}/rest/v1/rpc/{function}",
            config.supabase_url.trim_end_matches('/')
        ))
        .header("apikey", &config.supabase_key)
        .bearer_auth(&session.access_token)
        .json(&body)
        .send()
        .await
        .map_err(|error| RpcError::Failed(format!("连接云端失败：{}", error.without_url())))?;
    let status = response.status().as_u16();
    let bytes = read_bounded(response).await?;
    lease.ensure_current(app).map_err(RpcError::Failed)?;
    if !(200..300).contains(&status) {
        return Err(classify_failure(status, &bytes));
    }
    Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

// ---------------------------------------------------------------------------
// The upload loop

/// One local day of source data; each part only when a dimension needs it.
#[derive(Clone, Debug, Default)]
struct DayData {
    stats: Option<Value>,
    behavior: Option<Value>,
}

/// Everything the loop touches outside itself, so it can be driven by a fake in tests.
trait PublishIo: Sync {
    fn mask(&self) -> Mask;
    /// The account in the local cloud config; `None` only when it cannot be read,
    /// signed out reads as an empty user.
    fn stored_user(&self) -> Option<String>;
    /// The account a clear is still owed to, per dimension.
    fn marker(&self, dimension: Dimension) -> Option<String>;
    fn set_marker(&self, dimension: Dimension, user: Option<&str>);
    fn load_state(&self) -> UploadState;
    fn save_state(&self, state: &UploadState);
    fn session_secret(&self) -> Result<[u8; 32], String>;
    fn take_nudge(&self) -> bool;
    fn nudge_pending(&self) -> bool;
    fn today(&self) -> (NaiveDate, NaiveDate);
    async fn fingerprints(
        &self,
        oldest: &str,
        newest: &str,
    ) -> Result<BTreeMap<String, String>, String>;
    async fn day(&self, date: &str, stats: bool, behavior: bool) -> Result<DayData, String>;
    async fn rpc(
        &self,
        user: &str,
        function: &str,
        body: Value,
        still_wanted: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<Value, RpcError>;
    async fn sleep(&self, duration: Duration);
}

struct AppIo {
    app: Arc<AppContext>,
    settings: Arc<Mutex<AppSettings>>,
    machine: String,
    data_dir: PathBuf,
    secret: Mutex<Option<[u8; 32]>>,
}

fn stats_query(machine: &str, start: &str, end: &str) -> LocalStatsQuery {
    LocalStatsQuery {
        range: "custom".to_string(),
        timezone: "local".to_string(),
        machines: Some(vec![machine.to_string()]),
        machine: None,
        tools: None,
        tool: None,
        models: None,
        model: None,
        search: None,
        token_mode: None,
        start: Some(start.to_string()),
        end: Some(end.to_string()),
    }
}

impl PublishIo for AppIo {
    fn mask(&self) -> Mask {
        self.settings
            .lock()
            .map(|guard| Mask::from_settings(&guard))
            .unwrap_or_default()
    }

    fn stored_user(&self) -> Option<String> {
        let config = crate::commands::load_cloud_config_file(&self.app).ok()?;
        Some(
            config
                .session
                .map(|session| session.user_id)
                .unwrap_or_default(),
        )
    }

    fn marker(&self, dimension: Dimension) -> Option<String> {
        std::fs::read_to_string(self.data_dir.join(dimension.marker_file()))
            .ok()
            .map(|user| user.trim().to_string())
    }

    fn set_marker(&self, dimension: Dimension, user: Option<&str>) {
        let path = self.data_dir.join(dimension.marker_file());
        let _ = match user {
            Some(user) => std::fs::write(path, user.as_bytes()),
            None => std::fs::remove_file(path),
        };
    }

    fn load_state(&self) -> UploadState {
        std::fs::read(self.data_dir.join(STATE_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save_state(&self, state: &UploadState) {
        if let Ok(bytes) = serde_json::to_vec(state) {
            if let Err(error) =
                crate::quota::write_private_app_data_file(&self.data_dir, STATE_FILE, &bytes)
            {
                log::warn!("usage dimensions state could not be saved: {error}");
            }
        }
    }

    fn session_secret(&self) -> Result<[u8; 32], String> {
        let mut cached = self
            .secret
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(secret) = *cached {
            return Ok(secret);
        }
        let secret = load_or_create_session_secret(&crate::gateway::KeyringSecrets)?;
        *cached = Some(secret);
        Ok(secret)
    }

    fn take_nudge(&self) -> bool {
        SYNC_NUDGE.swap(false, Ordering::SeqCst)
    }

    fn nudge_pending(&self) -> bool {
        SYNC_NUDGE.load(Ordering::SeqCst)
    }

    fn today(&self) -> (NaiveDate, NaiveDate) {
        (Local::now().date_naive(), Utc::now().date_naive())
    }

    async fn fingerprints(
        &self,
        oldest: &str,
        newest: &str,
    ) -> Result<BTreeMap<String, String>, String> {
        let app = self.app.clone();
        let query = stats_query(&self.machine, oldest, newest);
        tauri::async_runtime::spawn_blocking(move || {
            crate::commands::get_local_stats_v2_impl_at(&app, query, Local::now())
                .map(|stats| fingerprints(&stats))
        })
        .await
        .map_err(|error| error.to_string())?
    }

    async fn day(&self, date: &str, stats: bool, behavior: bool) -> Result<DayData, String> {
        let app = self.app.clone();
        let machine = self.machine.clone();
        let date = date.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let now = Local::now();
            let stats = stats
                .then(|| {
                    crate::commands::get_local_stats_v2_impl_at(
                        &app,
                        stats_query(&machine, &date, &date),
                        now,
                    )
                })
                .transpose()?;
            let behavior = behavior
                .then(|| {
                    crate::commands::local_behavior_analysis_at(
                        &app,
                        stats_query(&machine, &date, &date),
                        None,
                        now,
                    )
                })
                .transpose()?;
            Ok(DayData { stats, behavior })
        })
        .await
        .map_err(|error| error.to_string())?
    }

    async fn rpc(
        &self,
        user: &str,
        function: &str,
        body: Value,
        still_wanted: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<Value, RpcError> {
        call_rpc(&self.app, user, function, body, still_wanted).await
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// How long to wait, the switches the pass acted on, and whether a sync nudge may cut
/// the wait short (not while backing off: the contract's retry delays hold).
struct Next {
    delay: Duration,
    acted_on: Mask,
    wake_on_nudge: bool,
}

struct Publisher {
    machine: String,
    /// Account a clear is owed to, per dimension; mirrors the marker files.
    markers: [Option<String>; 3],
    state: UploadState,
    last_mask: Mask,
    /// A failed clear is retried at this instant.
    clear_at: Option<Instant>,
    /// A cycle runs at this instant, or on the next nudge when `None`.
    cycle_at: Option<Instant>,
    /// Set while retrying a failure; nudges do not shorten the retry delay.
    failing: bool,
    backoff: Duration,
}

impl Publisher {
    /// Only the marker files and the small state file are read here: people who never
    /// turned a switch on do not touch the session store or the keychain.
    fn new(machine: String, io: &impl PublishIo) -> Self {
        Self {
            machine,
            markers: Dimension::ALL.map(|d| io.marker(d)),
            state: io.load_state(),
            last_mask: Mask::default(),
            clear_at: None,
            cycle_at: None,
            failing: false,
            backoff: TICK,
        }
    }

    fn back_off(&mut self) -> Duration {
        let delay = self.backoff;
        self.backoff = (self.backoff * 2).min(MAX_BACKOFF);
        delay
    }

    fn retry_in(&mut self, delay: Duration) -> Duration {
        self.failing = true;
        self.cycle_at = Some(Instant::now() + delay);
        delay
    }

    fn set_marker(&mut self, io: &impl PublishIo, dimension: Dimension, user: Option<&str>) {
        if self.markers[dimension.index()].as_deref() != user {
            io.set_marker(dimension, user);
            self.markers[dimension.index()] = user.map(str::to_string);
        }
    }

    async fn run(mut self, io: impl PublishIo) {
        let mut next = Next {
            delay: TICK,
            acted_on: io.mask(),
            wake_on_nudge: false,
        };
        loop {
            wait(&io, &next).await;
            next = self.tick(&io).await;
        }
    }

    async fn tick(&mut self, io: &impl PublishIo) -> Next {
        let mask = io.mask();
        // Clears first: a switched-off dimension never uploads again.
        if self.clear_at.is_none_or(|at| Instant::now() >= at) {
            self.clear_at = self
                .clear_disabled(io, mask)
                .await
                .map(|delay| Instant::now() + delay);
        }
        for dimension in Dimension::ALL.into_iter().filter(|d| !mask.has(*d)) {
            set_status(dimension, |status| *status = off_status());
        }
        let gained = mask.enabled().any(|d| !self.last_mask.has(d));
        self.last_mask = mask;
        let idle = |publisher: &Self| Next {
            delay: TICK,
            acted_on: mask,
            wake_on_nudge: !publisher.failing,
        };
        if !mask.any() {
            self.cycle_at = None;
            self.failing = false;
            io.take_nudge();
            return idle(self);
        }
        if gained {
            // A newly enabled dimension starts its backfill right away.
            self.cycle_at = Some(Instant::now());
            self.failing = false;
            self.backoff = TICK;
            set_status_for(mask, |status| {
                if status.state == "off" {
                    status.state = "starting";
                }
            });
        }
        let nudged = io.take_nudge();
        let due = self.cycle_at.is_some_and(|at| Instant::now() >= at) || (nudged && !self.failing);
        if !due {
            return idle(self);
        }
        let delay = self.cycle(io, mask).await;
        Next {
            delay,
            ..idle(self)
        }
    }

    /// Deletes the cloud rows of every switched-off dimension still marked. Returns a
    /// longer wait when a clear has to be retried later.
    async fn clear_disabled(&mut self, io: &impl PublishIo, mask: Mask) -> Option<Duration> {
        let pending: Vec<Dimension> = Dimension::ALL
            .into_iter()
            .filter(|d| !mask.has(*d) && self.markers[d.index()].is_some())
            .collect();
        if pending.is_empty() {
            return None;
        }
        let user = io.stored_user()?;
        let mut wait = None;
        for dimension in pending {
            let owner = self.markers[dimension.index()].clone().unwrap_or_default();
            if user.is_empty() {
                // Signed out: the rows wait for the same account to come back. Reading
                // the local config each tick is cheap, so signing in clears promptly.
                continue;
            }
            if owner != user {
                // Another account now: those rows are not this session's to delete; they
                // expire after 90 days.
                self.set_marker(io, dimension, None);
                continue;
            }
            let switched_back_on = || !io.mask().has(dimension);
            match io
                .rpc(
                    &user,
                    "clear_usage_dimension_v1",
                    json!({ "p_dimension": dimension.as_str() }),
                    &switched_back_on,
                )
                .await
            {
                Ok(_) | Err(RpcError::NotDeployed) => {
                    self.set_marker(io, dimension, None);
                    self.state.forget(dimension);
                    io.save_state(&self.state);
                    self.backoff = TICK;
                }
                Err(RpcError::AccountChanged) => {
                    self.set_marker(io, dimension, None);
                }
                // Turned back on: the next pass re-uploads and overwrites anyway.
                Err(RpcError::Cancelled) => {}
                Err(RpcError::Failed(error)) => {
                    log::warn!("usage dimension clear failed: {error}");
                    wait = Some(self.back_off());
                }
            }
        }
        wait
    }

    /// One upload cycle for every enabled dimension. Returns how long to wait.
    async fn cycle(&mut self, io: &impl PublishIo, mask: Mask) -> Duration {
        self.cycle_at = None;
        let user = match io.stored_user() {
            Some(user) if !user.is_empty() => user,
            Some(_) => {
                set_status_for(mask, |status| {
                    *status = DimensionStatus {
                        state: "signed-out",
                        ..Default::default()
                    }
                });
                // Not a failure: signing in should start the upload promptly.
                self.cycle_at = Some(Instant::now() + SIGNED_OUT_RETRY);
                return SIGNED_OUT_RETRY.min(TICK);
            }
            None => {
                let delay = self.back_off();
                set_status_for(mask, |status| {
                    status.state = "error";
                    status.error = Some("读取云端登录信息失败".to_string());
                });
                return self.retry_in(delay).min(TICK);
            }
        };
        if self.state.user != user || self.state.machine != self.machine {
            self.state = UploadState {
                user: user.clone(),
                machine: self.machine.clone(),
                uploaded: BTreeMap::new(),
            };
        }
        // Marked before anything leaves, so a switch-off after a lost response still
        // clears.
        for dimension in mask.enabled() {
            self.set_marker(io, dimension, Some(&user));
        }

        match self.upload(io, mask, &user).await {
            Ok(()) => {
                self.failing = false;
                self.backoff = TICK;
                let at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
                set_status_for(mask, |status| {
                    *status = DimensionStatus {
                        state: "ok",
                        last_uploaded_at: Some(at.clone()),
                        error: None,
                    }
                });
                TICK
            }
            Err(RpcError::Cancelled) => {
                self.cycle_at = Some(Instant::now());
                Duration::ZERO
            }
            Err(RpcError::AccountChanged) => {
                self.cycle_at = Some(Instant::now() + TICK);
                TICK
            }
            Err(RpcError::NotDeployed) => {
                set_status_for(mask, |status| {
                    status.state = "not-deployed";
                    status.error = None;
                });
                self.retry_in(NOT_DEPLOYED_RETRY).min(TICK)
            }
            Err(RpcError::Failed(error)) => {
                log::warn!("usage dimensions upload failed: {error}");
                let delay = self.back_off();
                set_status_for(mask, |status| {
                    status.state = "error";
                    status.error = Some(error.clone());
                });
                self.retry_in(delay).min(TICK)
            }
        }
    }

    async fn upload(
        &mut self,
        io: &impl PublishIo,
        mask: Mask,
        user: &str,
    ) -> Result<(), RpcError> {
        let (local_today, utc_today) = io.today();
        let window = window_dates(local_today, utc_today);
        let (Some(newest), Some(oldest)) = (window.first(), window.last()) else {
            return Ok(());
        };
        let oldest = oldest.format("%Y-%m-%d").to_string();
        let newest = newest.format("%Y-%m-%d").to_string();
        let current = io
            .fingerprints(&oldest, &newest)
            .await
            .map_err(|_| RpcError::Failed("读取本机统计失败".to_string()))?;
        self.state.prune(&oldest);

        // date → dimensions due that day, newest first.
        let mut due: BTreeMap<String, Mask> = BTreeMap::new();
        for dimension in mask.enabled() {
            for date in due_dates(&window, &current, &self.state.dimension(dimension)) {
                due.entry(date).or_default().0[dimension.index()] = true;
            }
        }
        let secret = if mask.has(Dimension::Sessions) {
            Some(
                io.session_secret()
                    .map_err(|_| RpcError::Failed("读取会话密钥失败".to_string()))?,
            )
        } else {
            None
        };

        let mut days = Vec::with_capacity(due.len());
        for (date, wanted) in due.iter().rev() {
            if !wanted.still_covered_by(io.mask()) {
                return Err(RpcError::Cancelled);
            }
            let data = io
                .day(
                    date,
                    wanted.has(Dimension::Providers) || wanted.has(Dimension::Context),
                    wanted.has(Dimension::Sessions),
                )
                .await
                .map_err(|_| RpcError::Failed("读取本机统计失败".to_string()))?;
            days.push(day_parts(date, *wanted, &data, secret.as_ref()));
        }

        for chunk in build_chunks(&self.machine, &days) {
            let dims = Mask(Dimension::ALL.map(|d| chunk.covers.iter().any(|(c, _)| *c == d)));
            let still_on = || dims.still_covered_by(io.mask());
            let reply = io
                .rpc(
                    user,
                    "sync_usage_dimensions_v1",
                    json!({ "p_payload": chunk.payload }),
                    &still_on,
                )
                .await?;
            if reply.get("stored").is_none() {
                return Err(RpcError::Failed("云端回应格式不符".to_string()));
            }
            for (dimension, date) in &chunk.covers {
                self.state.record(*dimension, date, current.get(date));
            }
            io.save_state(&self.state);
        }
        Ok(())
    }
}

/// Builds one day's entries for the dimensions due that day.
fn day_parts(date: &str, wanted: Mask, data: &DayData, secret: Option<&[u8; 32]>) -> DayParts {
    let empty = Value::Null;
    let stats = data.stats.as_ref().unwrap_or(&empty);
    let mut parts = DayParts {
        date: date.to_string(),
        ..Default::default()
    };
    if wanted.has(Dimension::Sessions) {
        if let (Some(behavior), Some(secret)) = (data.behavior.as_ref(), secret) {
            parts.entries[Dimension::Sessions.index()] = Some(session_day(date, behavior, secret));
        }
    }
    if wanted.has(Dimension::Providers) {
        parts.entries[Dimension::Providers.index()] = Some(provider_day(date, stats));
    }
    if wanted.has(Dimension::Context) {
        parts.entries[Dimension::Context.index()] = Some(context_day(date, stats));
    }
    parts
}

/// Waits in tick-sized slices and stops as soon as the switches differ from what the
/// last pass acted on, or a sync nudge arrives while not backing off.
async fn wait(io: &impl PublishIo, next: &Next) {
    let mut left = next.delay;
    while !left.is_zero()
        && io.mask() == next.acted_on
        && !(next.wake_on_nudge && io.nudge_pending())
    {
        let slice = left.min(TICK);
        io.sleep(slice).await;
        left -= slice;
    }
}

/// Runs for the life of the process. Every tick is cheap while all switches are off.
pub fn start(app: Arc<AppContext>, settings: Arc<Mutex<AppSettings>>) {
    tauri::async_runtime::spawn(async move {
        let machine = clip(&crate::commands::local_machine_id(), MAX_LABEL_CHARS);
        let io = AppIo {
            data_dir: app.app_data_dir().to_path_buf(),
            app,
            settings,
            machine: machine.clone(),
            secret: Mutex::new(None),
        };
        let publisher = Publisher::new(machine, &io);
        publisher.run(io).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    const SECRET: [u8; 32] = [7u8; 32];

    #[test]
    fn providers_map_to_the_whitelist_and_the_rest_merge_into_other() {
        assert_eq!(provider_bucket("  OpenAI "), "openai");
        assert_eq!(provider_bucket("deepseek"), "deepseek");
        assert_eq!(provider_bucket("openai-work"), OTHER_PROVIDER);
        assert_eq!(provider_bucket("someone@example.com"), OTHER_PROVIDER);
        assert_eq!(provider_bucket(""), OTHER_PROVIDER);
        assert_eq!(provider_bucket("other"), OTHER_PROVIDER);

        let stats = json!({ "providers": {
            "OpenAI": { "name": "OpenAI", "input": 400, "output": 50, "cached": 500, "cacheWrite": 0, "requests": 6, "cost": 0.12 },
            "my-proxy": { "name": "my-proxy", "input": 10, "output": 5, "cached": 0, "requests": 1, "cost": 0.5 },
            "Acme Corp": { "name": "Acme Corp", "input": 20, "output": 5, "cached": 1, "cacheWrite": 2, "requests": 2, "cost": 0.25 },
        }});
        let day = provider_day("2026-10-24", &stats);
        let rows = day["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["provider"], "openai");
        assert_eq!(rows[0]["cost"], 0.12);
        assert_eq!(rows[1]["provider"], "other", "other sorts last");
        assert_eq!(rows[1]["input"], 30);
        assert_eq!(rows[1]["output"], 10);
        assert_eq!(rows[1]["cacheWrite"], 2);
        assert_eq!(rows[1]["requests"], 3);
        assert_eq!(rows[1]["cost"], 0.75);
        let text = day.to_string();
        assert!(!text.contains("proxy") && !text.contains("Acme"), "{text}");
    }

    #[test]
    fn a_merged_bucket_with_any_unknown_cost_has_a_null_cost() {
        let stats = json!({ "providers": {
            "a": { "name": "a", "input": 1, "output": 1, "requests": 1, "cost": 0.5 },
            "b": { "name": "b", "input": 1, "output": 1, "requests": 1, "cost": null },
        }});
        let day = provider_day("2026-10-24", &stats);
        assert_eq!(day["rows"][0]["provider"], "other");
        assert!(day["rows"][0]["cost"].is_null());
        assert_eq!(provider_day("2026-10-24", &json!({}))["rows"], json!([]));
    }

    #[test]
    fn session_keys_are_32_hex_stable_and_keyed() {
        let key = session_key(&SECRET, "codex", "sess-1");
        assert_eq!(key.len(), 32);
        assert!(key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_eq!(key, session_key(&SECRET, "codex", "sess-1"));
        assert_ne!(key, session_key(&SECRET, "claude", "sess-1"));
        assert_ne!(key, session_key(&[8u8; 32], "codex", "sess-1"));
        // Known answer: HMAC-SHA256(key = 32 × 0x07, "codex\nsess-1"), first 16 bytes.
        let full = ring::hmac::sign(
            &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &SECRET),
            b"codex\nsess-1",
        );
        let expected: String = full.as_ref()[..16]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(key, expected);
    }

    #[test]
    fn the_secret_is_created_once_and_reused() {
        let store = crate::gateway::MemorySecrets::default();
        let first = load_or_create_session_secret(&store).unwrap();
        let second = load_or_create_session_secret(&store).unwrap();
        assert_eq!(first, second);
        let stored = store.get(SESSION_SECRET_ACCOUNT).unwrap().unwrap();
        assert_eq!(stored.len(), 64);
        assert_eq!(parse_secret(&stored), Some(first));
        store.set(SESSION_SECRET_ACCOUNT, "not-hex").unwrap();
        assert_ne!(load_or_create_session_secret(&store).unwrap(), first);
    }

    #[test]
    fn times_truncate_to_local_minutes() {
        assert_eq!(hh_mm("2026-10-24 08:00:59").as_deref(), Some("08:00"));
        assert_eq!(hh_mm("2026-10-24T23:59:00").as_deref(), Some("23:59"));
        assert_eq!(hh_mm("2026-10-24 11:15").as_deref(), Some("11:15"));
        assert_eq!(hh_mm("2026-10-24"), None);
        assert_eq!(hh_mm("2026-10-24 24:00:00"), None);
        assert_eq!(hh_mm("2026-10-24 ab:cd:00"), None);
        assert_eq!(hh_mm(""), None);
    }

    fn behavior() -> Value {
        json!({
            "meta": { "sessionsTruncated": false },
            "summary": { "sessionCount": 2 },
            "sessions": [
                { "id": "sess-SECRET-1", "tool": "codex", "tokens": 550, "requests": 3, "cost": 0.27,
                  "firstAt": "2026-10-24 08:00:12", "lastAt": "2026-10-24 11:15:40", "topModel": "gpt-5",
                  "project": { "name": "secret-project" } },
                { "id": "sess-2", "tool": "claude", "tokens": 10, "requests": 1, "cost": null,
                  "firstAt": "2026-10-24 09:00:00", "lastAt": "2026-10-24 09:00:00", "topModel": null },
                { "id": "unknown_session", "tool": "claude", "tokens": 10, "requests": 1, "cost": 0.0,
                  "firstAt": "2026-10-24 09:00:00", "lastAt": "2026-10-24 09:00:00", "topModel": null },
            ]
        })
    }

    #[test]
    fn session_rows_carry_only_keys_sizes_and_times() {
        let day = session_day("2026-10-24", &behavior(), &SECRET);
        let rows = day["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0]["key"],
            session_key(&SECRET, "codex", "sess-SECRET-1")
        );
        assert_eq!(rows[0]["firstAt"], "08:00");
        assert_eq!(rows[0]["lastAt"], "11:15");
        assert_eq!(rows[0]["topModel"], "gpt-5");
        assert!(rows[1]["cost"].is_null());
        assert!(rows[1]["topModel"].is_null());
        assert_eq!(
            day["truncated"], true,
            "the placeholder session was dropped"
        );
        let text = day.to_string();
        for leaked in ["SECRET", "sess-", "secret-project", "unknown_session"] {
            assert!(!text.contains(leaked), "{leaked} leaked: {text}");
        }
    }

    #[test]
    fn session_days_cap_at_500_rows_and_keep_the_largest() {
        let sessions: Vec<Value> = (0..600)
            .map(|i| json!({ "id": format!("s{i}"), "tool": "codex", "tokens": i, "requests": 1, "cost": 0.0,
                             "firstAt": "2026-10-24 08:00:00", "lastAt": "2026-10-24 08:01:00" }))
            .collect();
        let behavior = json!({ "meta": { "sessionsTruncated": false }, "sessions": sessions });
        let day = session_day("2026-10-24", &behavior, &SECRET);
        let rows = day["rows"].as_array().unwrap();
        assert_eq!(rows.len(), MAX_SESSION_ROWS_PER_DAY);
        assert_eq!(rows[0]["tokens"], 599);
        assert_eq!(day["truncated"], true);
        let local_truncated = json!({ "meta": { "sessionsTruncated": true }, "sessions": [] });
        assert_eq!(
            session_day("d", &local_truncated, &SECRET)["truncated"],
            true
        );
    }

    #[test]
    fn context_rows_copy_the_composition_or_are_null() {
        let stats = json!({ "contextComposition": {
            "requests": 6, "promptTokens": 900, "systemBytes": 12, "toolsBytes": 3, "historyBytes": 4,
            "toolResultsBytes": 5, "attachmentsBytes": 6, "messages": 7, "toolResults": 8, "attachments": 9
        }});
        let day = context_day("2026-10-24", &stats);
        assert_eq!(day["row"]["requests"], 6);
        assert_eq!(day["row"]["promptTokens"], 900);
        assert_eq!(day["row"]["attachments"], 9);
        assert_eq!(day["row"].as_object().unwrap().len(), 10);
        assert!(context_day("2026-10-24", &json!({}))["row"].is_null());
    }

    fn full_day(date: &str, sessions: usize) -> DayParts {
        let rows: Vec<Value> = (0..sessions)
            .map(|i| json!({ "key": format!("{i:032x}"), "tool": "codex", "tokens": 1, "requests": 1, "cost": 0.1,
                             "firstAt": "08:00", "lastAt": "09:00", "topModel": "gpt-5" }))
            .collect();
        DayParts {
            date: date.to_string(),
            entries: [
                Some(json!({ "date": date, "truncated": false, "rows": rows })),
                Some(json!({ "date": date, "rows": [] })),
                Some(json!({ "date": date, "row": null })),
            ],
        }
    }

    #[test]
    fn chunks_stay_inside_the_contract_limits() {
        let days: Vec<DayParts> = (0..90)
            .map(|i| full_day(&format!("2026-07-{i:02}"), 100))
            .collect();
        let chunks = build_chunks("MacBook-Pro", &days);
        assert!(chunks.len() > 1);
        let mut covered = 0;
        for chunk in &chunks {
            assert!(server_text_len(&chunk.payload) <= MAX_PAYLOAD_BYTES);
            let mut rows = 0;
            for dimension in Dimension::ALL {
                let list = chunk.payload[dimension.as_str()]["days"]
                    .as_array()
                    .unwrap();
                assert!(list.len() <= MAX_DATES_PER_CALL);
                rows += list.iter().map(entry_rows).sum::<usize>();
            }
            assert!(rows <= MAX_ROWS_PER_CALL);
            assert_eq!(chunk.payload["v"], 1);
            assert_eq!(chunk.payload["machine"], "MacBook-Pro");
            covered += chunk.covers.len();
        }
        assert_eq!(covered, 90 * 3, "every day of every dimension is sent once");
    }

    #[test]
    fn disabled_dimensions_are_omitted_from_the_payload() {
        let data = DayData {
            stats: Some(json!({ "providers": {}, "contextComposition": null })),
            behavior: Some(behavior()),
        };
        let wanted = Mask([false, true, false]);
        let parts = day_parts("2026-10-24", wanted, &data, Some(&SECRET));
        let chunks = build_chunks("m", &[parts]);
        assert_eq!(chunks.len(), 1);
        let payload = &chunks[0].payload;
        assert!(payload.get("sessions").is_none());
        assert!(payload.get("context").is_none());
        assert_eq!(payload["providers"]["days"][0]["date"], "2026-10-24");
        assert_eq!(
            chunks[0].covers,
            [(Dimension::Providers, "2026-10-24".to_string())]
        );
        assert!(build_chunks("m", &[DayParts::default()]).is_empty());
    }

    fn date(text: &str) -> NaiveDate {
        NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn the_window_is_90_days_inside_the_server_floor() {
        let window = window_dates(date("2026-10-24"), date("2026-10-24"));
        assert_eq!(window.len(), 90);
        assert_eq!(
            window.last(),
            Some(&date("2026-07-27")),
            "a day above the UTC floor"
        );
        assert_eq!(window[0], date("2026-10-24"));
        let behind = window_dates(date("2026-10-23"), date("2026-10-24"));
        assert_eq!(behind.last(), Some(&date("2026-07-27")));
        let ahead = window_dates(date("2026-10-25"), date("2026-10-24"));
        assert_eq!(ahead.len(), 90);
    }

    #[test]
    fn due_dates_are_today_yesterday_and_changed_days() {
        let window = window_dates(date("2026-10-24"), date("2026-10-24"));
        let mut current = BTreeMap::new();
        current.insert("2026-10-20".to_string(), "3:30".to_string());
        current.insert("2026-10-10".to_string(), "1:10".to_string());
        // First enable: today, yesterday and every day with data.
        assert_eq!(
            due_dates(&window, &current, &BTreeMap::new()),
            ["2026-10-24", "2026-10-23", "2026-10-20", "2026-10-10"]
        );
        let mut uploaded = current.clone();
        uploaded.insert("2026-10-01".to_string(), "9:9".to_string());
        uploaded.insert("2026-10-10".to_string(), "1:5".to_string());
        // Steady state: a changed day and a day deleted locally come back.
        assert_eq!(
            due_dates(&window, &current, &uploaded),
            ["2026-10-24", "2026-10-23", "2026-10-10", "2026-10-01"]
        );
    }

    #[test]
    fn fingerprints_read_the_heatmap() {
        let stats = json!({ "heatmap": { "2026-10-24": 950, "2026-10-23": 0 }, "heatmapRequests": { "2026-10-24": 6, "2026-10-23": 0 } });
        let prints = fingerprints(&stats);
        assert_eq!(prints.len(), 1);
        assert_eq!(prints["2026-10-24"], "6:950");
    }

    #[test]
    fn missing_rpc_is_reported_as_not_deployed() {
        assert_eq!(
            classify_failure(404, br#"{"code":"PGRST202","message":"Could not find"}"#),
            RpcError::NotDeployed
        );
        assert_eq!(
            classify_failure(
                400,
                br#"{"code":"22023","message":"usage_dimensions_provider_not_allowed"}"#
            ),
            RpcError::Failed("usage_dimensions_provider_not_allowed".to_string())
        );
        assert_eq!(
            classify_failure(
                500,
                br#"{"message":"relation private.x at /internal/path"}"#
            ),
            RpcError::Failed("HTTP 500".to_string())
        );
    }

    #[derive(Default)]
    struct FakeIo {
        mask: Mutex<Mask>,
        user: Mutex<Option<String>>,
        markers: Mutex<[Option<String>; 3]>,
        state: Mutex<UploadState>,
        nudge: AtomicBool,
        not_deployed: AtomicBool,
        off_before_send: AtomicBool,
        day_reads: AtomicUsize,
        secret_reads: AtomicUsize,
        sent: Mutex<Vec<(String, Value)>>,
    }

    impl FakeIo {
        fn on(mask: [bool; 3]) -> Self {
            let io = FakeIo::default();
            *io.mask.lock().unwrap() = Mask(mask);
            *io.user.lock().unwrap() = Some("user-1".to_string());
            io
        }

        fn set_mask(&self, mask: [bool; 3]) {
            *self.mask.lock().unwrap() = Mask(mask);
        }

        fn sent(&self) -> Vec<(String, Value)> {
            std::mem::take(&mut self.sent.lock().unwrap())
        }
    }

    impl PublishIo for FakeIo {
        fn mask(&self) -> Mask {
            *self.mask.lock().unwrap()
        }
        fn stored_user(&self) -> Option<String> {
            Some(self.user.lock().unwrap().clone().unwrap_or_default())
        }
        fn marker(&self, dimension: Dimension) -> Option<String> {
            self.markers.lock().unwrap()[dimension.index()].clone()
        }
        fn set_marker(&self, dimension: Dimension, user: Option<&str>) {
            self.markers.lock().unwrap()[dimension.index()] = user.map(str::to_string);
        }
        fn load_state(&self) -> UploadState {
            self.state.lock().unwrap().clone()
        }
        fn save_state(&self, state: &UploadState) {
            *self.state.lock().unwrap() = state.clone();
        }
        fn session_secret(&self) -> Result<[u8; 32], String> {
            self.secret_reads.fetch_add(1, Ordering::SeqCst);
            Ok(SECRET)
        }
        fn take_nudge(&self) -> bool {
            self.nudge.swap(false, Ordering::SeqCst)
        }
        fn nudge_pending(&self) -> bool {
            self.nudge.load(Ordering::SeqCst)
        }
        fn today(&self) -> (NaiveDate, NaiveDate) {
            (date("2026-10-24"), date("2026-10-24"))
        }
        async fn fingerprints(
            &self,
            _oldest: &str,
            _newest: &str,
        ) -> Result<BTreeMap<String, String>, String> {
            let mut prints = BTreeMap::new();
            for day in ["2026-10-24", "2026-10-01", "2026-08-01"] {
                prints.insert(day.to_string(), "1:1".to_string());
            }
            Ok(prints)
        }
        async fn day(
            &self,
            _date: &str,
            _stats: bool,
            behavior_wanted: bool,
        ) -> Result<DayData, String> {
            self.day_reads.fetch_add(1, Ordering::SeqCst);
            Ok(DayData {
                stats: Some(
                    json!({ "providers": { "openai": { "name": "openai", "input": 1, "output": 1, "requests": 1, "cost": 0.1 } } }),
                ),
                behavior: behavior_wanted.then(behavior),
            })
        }
        async fn rpc(
            &self,
            _user: &str,
            function: &str,
            body: Value,
            still_wanted: &(dyn Fn() -> bool + Send + Sync),
        ) -> Result<Value, RpcError> {
            if self.off_before_send.load(Ordering::SeqCst) {
                self.set_mask([false, false, false]);
            }
            if !still_wanted() {
                return Err(RpcError::Cancelled);
            }
            self.sent.lock().unwrap().push((function.to_string(), body));
            if self.not_deployed.load(Ordering::SeqCst) {
                return Err(RpcError::NotDeployed);
            }
            Ok(if function == "clear_usage_dimension_v1" {
                json!({ "deleted": 1 })
            } else {
                json!({ "stored": {}, "purged": 0, "retentionDays": 90 })
            })
        }
        async fn sleep(&self, _duration: Duration) {}
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(future)
    }

    const SYNC: &str = "sync_usage_dimensions_v1";
    const CLEAR: &str = "clear_usage_dimension_v1";

    #[test]
    fn all_off_reads_nothing_and_sends_nothing() {
        let io = FakeIo::default();
        let mut publisher = Publisher::new("m".to_string(), &io);
        block_on(async {
            for _ in 0..3 {
                io.nudge.store(true, Ordering::SeqCst);
                publisher.tick(&io).await;
            }
        });
        assert!(io.sent().is_empty());
        assert_eq!(io.day_reads.load(Ordering::SeqCst), 0);
        assert_eq!(io.secret_reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn first_enable_backfills_then_only_today_and_yesterday_resend() {
        let io = FakeIo::on([false, true, true]);
        let mut publisher = Publisher::new("m".to_string(), &io);
        block_on(publisher.tick(&io));
        let sent = io.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, SYNC);
        let payload = &sent[0].1["p_payload"];
        assert!(payload.get("sessions").is_none());
        let dates: Vec<&str> = payload["providers"]["days"]
            .as_array()
            .unwrap()
            .iter()
            .map(|day| day["date"].as_str().unwrap())
            .collect();
        assert_eq!(
            dates,
            ["2026-10-24", "2026-10-23", "2026-10-01", "2026-08-01"]
        );
        assert_eq!(
            io.secret_reads.load(Ordering::SeqCst),
            0,
            "sessions off: no keychain"
        );
        assert_eq!(io.marker(Dimension::Providers).as_deref(), Some("user-1"));
        assert!(io.marker(Dimension::Sessions).is_none());

        // No nudge: nothing to do.
        block_on(publisher.tick(&io));
        assert!(io.sent().is_empty());
        // The sync cycle nudges: today and yesterday only.
        io.nudge.store(true, Ordering::SeqCst);
        block_on(publisher.tick(&io));
        let sent = io.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].1["p_payload"]["context"]["days"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        // A restart keeps the state: no second backfill.
        let mut restarted = Publisher::new("m".to_string(), &io);
        block_on(restarted.tick(&io));
        let sent = io.sent();
        assert_eq!(
            sent[0].1["p_payload"]["providers"]["days"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn switching_one_off_clears_only_that_dimension() {
        let io = FakeIo::on([true, true, false]);
        let mut publisher = Publisher::new("m".to_string(), &io);
        block_on(publisher.tick(&io));
        io.sent();
        io.set_mask([false, true, false]);
        block_on(publisher.tick(&io));
        let sent = io.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, CLEAR);
        assert_eq!(sent[0].1, json!({ "p_dimension": "sessions" }));
        assert!(io.marker(Dimension::Sessions).is_none());
        assert_eq!(io.marker(Dimension::Providers).as_deref(), Some("user-1"));
        io.nudge.store(true, Ordering::SeqCst);
        block_on(publisher.tick(&io));
        let sent = io.sent();
        assert!(sent
            .iter()
            .all(|(_, body)| body["p_payload"].get("sessions").is_none()));
    }

    #[test]
    fn switching_off_before_the_upload_leaves_cancels_it_and_clears() {
        let io = FakeIo::on([false, false, true]);
        io.off_before_send.store(true, Ordering::SeqCst);
        let mut publisher = Publisher::new("m".to_string(), &io);
        let next = block_on(publisher.tick(&io));
        assert_eq!(next.delay, Duration::ZERO);
        assert!(io.sent().is_empty());
        io.off_before_send.store(false, Ordering::SeqCst);
        block_on(publisher.tick(&io));
        assert_eq!(
            io.sent()
                .iter()
                .map(|(f, _)| f.as_str())
                .collect::<Vec<_>>(),
            [CLEAR]
        );
    }

    #[test]
    fn a_marker_left_from_the_last_run_clears_on_launch_for_the_same_account_only() {
        let io = FakeIo::default();
        *io.user.lock().unwrap() = Some("user-1".to_string());
        io.set_marker(Dimension::Context, Some("user-1"));
        io.set_marker(Dimension::Sessions, Some("someone-else"));
        let mut publisher = Publisher::new("m".to_string(), &io);
        block_on(publisher.tick(&io));
        let sent = io.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].1, json!({ "p_dimension": "context" }));
        assert!(io.marker(Dimension::Context).is_none());
        assert!(io.marker(Dimension::Sessions).is_none());
    }

    #[test]
    fn a_pending_clear_waits_while_signed_out() {
        let io = FakeIo::default();
        io.set_marker(Dimension::Providers, Some("user-1"));
        let mut publisher = Publisher::new("m".to_string(), &io);
        block_on(publisher.tick(&io));
        assert!(io.sent().is_empty());
        assert_eq!(io.marker(Dimension::Providers).as_deref(), Some("user-1"));
        *io.user.lock().unwrap() = Some("user-1".to_string());
        block_on(publisher.tick(&io));
        assert_eq!(io.sent().len(), 1);
    }

    #[test]
    fn not_deployed_waits_five_minutes_even_when_nudged() {
        let io = FakeIo::on([false, true, false]);
        io.not_deployed.store(true, Ordering::SeqCst);
        let mut publisher = Publisher::new("m".to_string(), &io);
        block_on(publisher.tick(&io));
        assert_eq!(io.sent().len(), 1);
        assert!(publisher.failing);
        io.nudge.store(true, Ordering::SeqCst);
        block_on(publisher.tick(&io));
        assert!(
            io.sent().is_empty(),
            "the nudge does not cut the retry delay"
        );
        let at = publisher.cycle_at.unwrap();
        assert!(at > Instant::now() + NOT_DEPLOYED_RETRY - Duration::from_secs(5));
    }

    #[test]
    fn signed_out_uploads_nothing_and_writes_no_marker() {
        let io = FakeIo::on([true, true, true]);
        *io.user.lock().unwrap() = None;
        let mut publisher = Publisher::new("m".to_string(), &io);
        block_on(publisher.tick(&io));
        assert!(io.sent().is_empty());
        assert!(Dimension::ALL.iter().all(|d| io.marker(*d).is_none()));
    }
}
