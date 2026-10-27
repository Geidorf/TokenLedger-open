//! Uploads three per-day usage dimensions (sessions, gateway accounts, average
//! context composition) for the Android read-only views
//! (docs/contracts/usage-dimensions-cloud-v1.md).
//!
//! Every number comes from the same local functions the desktop views use: the
//! Stats v2 aggregates (`providers`, `contextComposition`) and the behaviour analysis
//! (`sessions`), grouped by local day for this machine only. Only sizes,
//! counts and the whitelisted account names leave this computer; session IDs are
//! replaced by an HMAC keyed with a secret that never leaves the OS keychain.
//!
//! Each dimension has its own switch, off by default. Turning one off deletes that
//! dimension's cloud rows (`clear_usage_dimension_v1`) and stops uploading it; a
//! marker file per dimension lets that clear resume after a restart. Uploads ride
//! the existing cloud sync cycle (a nudge after each successful sync) and never
//! touch `token_logs` sync.
//!
//! The tray's background-sync pause (`background_sync_paused`) holds every automatic
//! upload: the launch backfill, failure retries and nudges from background syncs. A
//! manual sync still uploads, and pending clears still run (they delete data).

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
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
pub(crate) const MAX_SESSION_ROWS_PER_DAY: usize = 500;
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
    /// `off` | `clearing` | `signed-out` | `not-deployed` | `ok` | `error` | `starting`
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

/// Which kind of cloud sync asked for the next pass; a manual one wins over a
/// background one waiting in the same slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Nudge {
    None = 0,
    Background = 1,
    Manual = 2,
}

impl Nudge {
    fn from_u8(value: u8) -> Self {
        match value {
            2 => Nudge::Manual,
            1 => Nudge::Background,
            _ => Nudge::None,
        }
    }
}

static SYNC_NUDGE: AtomicU8 = AtomicU8::new(Nudge::None as u8);

/// Called after each successful cloud sync: the next pass re-sends today, yesterday
/// and changed days. Only sets a flag, so `token_logs` sync never waits on this.
/// `manual` marks the user's explicit sync, which uploads even while the tray's
/// background sync is paused.
pub fn nudge_after_cloud_sync(manual: bool) {
    record_nudge(&SYNC_NUDGE, manual);
}

fn record_nudge(slot: &AtomicU8, manual: bool) {
    let nudge = if manual {
        Nudge::Manual
    } else {
        Nudge::Background
    };
    slot.fetch_max(nudge as u8, Ordering::SeqCst);
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

fn stored_counts(payload: &Value) -> Value {
    let mut counts = Map::new();
    for dimension in Dimension::ALL {
        let rows: usize = payload[dimension.as_str()]["days"]
            .as_array()
            .into_iter()
            .flatten()
            .map(entry_rows)
            .sum();
        counts.insert(dimension.as_str().to_string(), json!(rows));
    }
    Value::Object(counts)
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

fn day_fingerprint(day: &DayParts) -> String {
    let bytes = serde_json::to_vec(&day.entries).expect("JSON usage aggregates are serializable");
    ring::digest::digest(&ring::digest::SHA256, &bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
    if let Some(stored) = store.get(SESSION_SECRET_ACCOUNT)? {
        return parse_secret(&stored).ok_or_else(|| "本机会话密钥格式无效".to_string());
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
        .map_err(|_| RpcError::Failed("读取云端回应失败".to_string()))?
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
        .filter(|message| {
            matches!(
                *message,
                "usage_dimensions_invalid_payload"
                    | "usage_dimensions_payload_too_large"
                    | "usage_dimensions_date_out_of_range"
                    | "usage_dimensions_provider_not_allowed"
                    | "usage_dimensions_identity_required"
            )
        })
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
) -> Result<RpcReply<crate::commands::CloudSessionUseLease>, RpcError> {
    let (config, lease) = crate::commands::acquire_current_cloud_session(app)
        .await
        .map_err(|_| RpcError::Failed("读取云端会话失败".to_string()))?;
    let session = config
        .session
        .as_ref()
        .filter(|session| session.user_id == expected_user)
        .ok_or(RpcError::AccountChanged)?;
    let client = reqwest::Client::builder()
        .timeout(RPC_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| RpcError::Failed("创建云端连接失败".to_string()))?;
    lease
        .ensure_current(app)
        .map_err(|_| RpcError::AccountChanged)?;
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
        .map_err(|_| RpcError::Failed("连接云端失败".to_string()))?;
    let status = response.status().as_u16();
    let bytes = read_bounded(response).await?;
    lease
        .ensure_current(app)
        .map_err(|_| RpcError::AccountChanged)?;
    if function != "clear_usage_dimension_v1" && !still_wanted() {
        return Err(RpcError::Cancelled);
    }
    if !(200..300).contains(&status) {
        return Err(classify_failure(status, &bytes));
    }
    Ok(RpcReply {
        value: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        fence: lease,
    })
}

struct RpcReply<Fence> {
    value: Value,
    fence: Fence,
}

// ---------------------------------------------------------------------------
// The upload loop

/// One local day of source data; each part only when a dimension needs it.
#[derive(Clone, Debug, Default)]
pub(crate) struct DayData {
    pub(crate) stats: Option<Value>,
    pub(crate) behavior: Option<Value>,
}

/// Everything the loop touches outside itself, so it can be driven by a fake in tests.
trait PublishIo: Sync {
    type Fence;

    fn mask(&self) -> Mask;
    /// The account in the local cloud config; `None` only when it cannot be read,
    /// signed out reads as an empty user.
    fn stored_user(&self) -> Option<String>;
    /// Accounts a clear is still owed to, per dimension.
    fn owners(&self, dimension: Dimension) -> Result<BTreeSet<String>, String>;
    fn save_owners(&self, dimension: Dimension, owners: &BTreeSet<String>) -> Result<(), String>;
    fn load_state(&self) -> Result<UploadState, String>;
    fn save_state(&self, state: &UploadState) -> Result<(), String>;
    fn session_secret(&self) -> Result<[u8; 32], String>;
    fn take_nudge(&self) -> Nudge;
    fn nudge_pending(&self) -> bool;
    /// The tray's background-sync pause, read fresh each time.
    fn background_paused(&self) -> bool;
    fn today(&self) -> (NaiveDate, NaiveDate);
    fn commit(
        &self,
        fence: &Self::Fence,
        wanted: Option<Mask>,
        mutation: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), RpcError>;
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
    ) -> Result<RpcReply<Self::Fence>, RpcError>;
    async fn sleep(&self, duration: Duration);
}

struct AppIo {
    app: Arc<AppContext>,
    settings: Arc<Mutex<AppSettings>>,
    machine: String,
    data_dir: PathBuf,
    secret: Mutex<Option<[u8; 32]>>,
    days: Mutex<BTreeMap<String, DayData>>,
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

fn parse_marker_owners(text: &str) -> Result<BTreeSet<String>, String> {
    let text = text.trim();
    let owners: BTreeSet<String> = if text.starts_with('[') {
        serde_json::from_str(text).map_err(|_| "读取用量维度清理标记失败".to_string())?
    } else {
        // Accept the single-account marker written by earlier builds.
        BTreeSet::from([text.to_string()])
    };
    if owners.is_empty() || owners.iter().any(|owner| owner.trim().is_empty()) {
        return Err("读取用量维度清理标记失败".to_string());
    }
    Ok(owners)
}

impl PublishIo for AppIo {
    type Fence = crate::commands::CloudSessionUseLease;

    fn commit(
        &self,
        fence: &Self::Fence,
        wanted: Option<Mask>,
        mutation: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), RpcError> {
        fence
            .commit_if_current(&self.app, || {
                let Ok(settings) = self.settings.lock() else {
                    return Ok(Err(RpcError::Failed("读取用量维度设置失败".to_string())));
                };
                if wanted.is_some_and(|mask| !mask.still_covered_by(Mask::from_settings(&settings)))
                {
                    return Ok(Err(RpcError::Cancelled));
                }
                // Keep consent and the original account generation stable through
                // the durable receipt and its visible success state.
                Ok(mutation().map_err(RpcError::Failed))
            })
            .map_err(|_| RpcError::AccountChanged)?
    }

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

    fn owners(&self, dimension: Dimension) -> Result<BTreeSet<String>, String> {
        match std::fs::read_to_string(self.data_dir.join(dimension.marker_file())) {
            Ok(text) => parse_marker_owners(&text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeSet::new()),
            _ => Err("读取用量维度清理标记失败".to_string()),
        }
    }

    fn save_owners(&self, dimension: Dimension, owners: &BTreeSet<String>) -> Result<(), String> {
        let path = self.data_dir.join(dimension.marker_file());
        if owners.is_empty() {
            match std::fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("保存用量维度清理标记失败".to_string()),
            }
        } else {
            let bytes =
                serde_json::to_vec(owners).map_err(|_| "保存用量维度清理标记失败".to_string())?;
            crate::quota::write_private_app_data_file(
                &self.data_dir,
                &dimension.marker_file(),
                &bytes,
            )
        }
        .map_err(|_| "保存用量维度清理标记失败".to_string())
    }

    fn load_state(&self) -> Result<UploadState, String> {
        match std::fs::read(self.data_dir.join(STATE_FILE)) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|_| "读取用量维度同步状态失败".to_string())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(UploadState::default())
            }
            Err(_) => Err("读取用量维度同步状态失败".to_string()),
        }
    }

    fn save_state(&self, state: &UploadState) -> Result<(), String> {
        let bytes =
            serde_json::to_vec(state).map_err(|_| "保存用量维度同步状态失败".to_string())?;
        crate::quota::write_private_app_data_file(&self.data_dir, STATE_FILE, &bytes)
            .map_err(|_| "保存用量维度同步状态失败".to_string())
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

    fn take_nudge(&self) -> Nudge {
        Nudge::from_u8(SYNC_NUDGE.swap(Nudge::None as u8, Ordering::SeqCst))
    }

    fn nudge_pending(&self) -> bool {
        SYNC_NUDGE.load(Ordering::SeqCst) != Nudge::None as u8
    }

    fn background_paused(&self) -> bool {
        crate::settings::background_sync_paused_now(&self.app)
    }

    fn today(&self) -> (NaiveDate, NaiveDate) {
        (Local::now().date_naive(), Utc::now().date_naive())
    }

    async fn fingerprints(
        &self,
        oldest: &str,
        newest: &str,
    ) -> Result<BTreeMap<String, String>, String> {
        let mask = self.mask();
        let secret = mask
            .has(Dimension::Sessions)
            .then(|| self.session_secret())
            .transpose()?;
        let app = self.app.clone();
        let query = stats_query(&self.machine, oldest, newest);
        let days = tauri::async_runtime::spawn_blocking(move || {
            crate::commands::local_usage_dimension_days(
                &app,
                query,
                mask.has(Dimension::Providers) || mask.has(Dimension::Context),
                mask.has(Dimension::Sessions),
                Local::now(),
            )
        })
        .await
        .map_err(|_| "读取本机用量维度失败".to_string())??;
        let prints = days
            .iter()
            .map(|(date, data)| {
                (
                    date.clone(),
                    day_fingerprint(&day_parts(date, mask, data, secret.as_ref())),
                )
            })
            .collect();
        *self
            .days
            .lock()
            .map_err(|_| "读取本机用量维度失败".to_string())? = days;
        Ok(prints)
    }

    async fn day(&self, date: &str, stats: bool, behavior: bool) -> Result<DayData, String> {
        let days = self
            .days
            .lock()
            .map_err(|_| "读取本机用量维度失败".to_string())?;
        let data = days.get(date);
        Ok(DayData {
            stats: stats.then(|| {
                data.and_then(|day| day.stats.clone())
                    .unwrap_or_else(|| json!({}))
            }),
            behavior: behavior.then(|| {
                data.and_then(|day| day.behavior.clone())
                    .unwrap_or_else(|| json!({ "sessions": [] }))
            }),
        })
    }

    async fn rpc(
        &self,
        user: &str,
        function: &str,
        body: Value,
        still_wanted: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<RpcReply<Self::Fence>, RpcError> {
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
    /// Accounts a clear is owed to, per dimension; mirrors the marker files.
    markers: [BTreeSet<String>; 3],
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
    fn new(machine: String, io: &impl PublishIo) -> Result<Self, String> {
        Ok(Self {
            machine,
            markers: [
                io.owners(Dimension::Sessions)?,
                io.owners(Dimension::Providers)?,
                io.owners(Dimension::Context)?,
            ],
            state: io.load_state()?,
            last_mask: Mask::default(),
            clear_at: None,
            cycle_at: None,
            failing: false,
            backoff: TICK,
        })
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

    fn set_marker(
        &mut self,
        io: &impl PublishIo,
        dimension: Dimension,
        user: &str,
        pending: bool,
    ) -> Result<(), String> {
        let mut owners = self.markers[dimension.index()].clone();
        let changed = if pending {
            owners.insert(user.to_string())
        } else {
            owners.remove(user)
        };
        if changed {
            io.save_owners(dimension, &owners)?;
            self.markers[dimension.index()] = owners;
        }
        Ok(())
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
            set_status(dimension, |status| {
                if self.markers[dimension.index()].is_empty() {
                    *status = off_status();
                } else if !matches!(status.state, "error" | "not-deployed" | "signed-out") {
                    *status = DimensionStatus {
                        state: "clearing",
                        ..Default::default()
                    };
                }
            });
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
        let nudge = io.take_nudge();
        let scheduled = self.cycle_at.is_some_and(|at| Instant::now() >= at);
        let manual = nudge == Nudge::Manual && !self.failing;
        let due = scheduled || (nudge != Nudge::None && !self.failing);
        if !due {
            return idle(self);
        }
        // Background sync paused: only a manual sync uploads. A due launch backfill or
        // retry stays scheduled and runs once the pause is lifted; a background nudge
        // is dropped, the next background sync nudges again.
        if !manual && io.background_paused() {
            if self.cycle_at.is_some() {
                set_status_for(mask, |status| {
                    status.state = "paused";
                    status.error = None;
                });
            }
            return idle(self);
        }
        let delay = self.cycle(io, mask, manual).await;
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
            .filter(|d| !mask.has(*d) && !self.markers[d.index()].is_empty())
            .collect();
        if pending.is_empty() {
            return None;
        }
        let user = io.stored_user()?;
        let mut wait = None;
        for dimension in pending {
            if user.is_empty() {
                // Signed out: the rows wait for the same account to come back. Reading
                // the local config each tick is cheap, so signing in clears promptly.
                set_status(dimension, |status| {
                    *status = DimensionStatus {
                        state: "signed-out",
                        ..Default::default()
                    };
                });
                continue;
            }
            if !self.markers[dimension.index()].contains(&user) {
                // Keep the original owner until it can authenticate again.
                set_status(dimension, |status| {
                    *status = DimensionStatus {
                        state: "signed-out",
                        ..Default::default()
                    };
                });
                continue;
            }
            // A lost clear reply may already have deleted the rows. Re-enabling
            // must backfill, including when the clear cannot be confirmed.
            if self.state.user == user || self.state.user.is_empty() {
                self.state.forget(dimension);
                if io.save_state(&self.state).is_err() {
                    wait = Some(self.back_off());
                    set_status(dimension, |status| {
                        status.state = "error";
                        status.error = Some("保存用量维度清理状态失败".to_string());
                    });
                    continue;
                }
            }
            let switched_back_on = || !io.mask().has(dimension);
            set_status(dimension, |status| {
                *status = DimensionStatus {
                    state: "clearing",
                    ..Default::default()
                };
            });
            match io
                .rpc(
                    &user,
                    "clear_usage_dimension_v1",
                    json!({ "p_dimension": dimension.as_str() }),
                    &switched_back_on,
                )
                .await
            {
                Ok(_) if io.stored_user().as_deref() != Some(user.as_str()) => {}
                Ok(reply) if reply.value["deleted"].as_u64().is_some() => {
                    let mut next_state = self.state.clone();
                    next_state.forget(dimension);
                    let saved = io.commit(&reply.fence, None, || {
                        io.save_state(&next_state)?;
                        self.set_marker(io, dimension, &user, false)
                    });
                    if saved.is_ok() {
                        self.state = next_state;
                        self.backoff = TICK;
                    } else {
                        wait = Some(self.back_off());
                        set_status(dimension, |status| {
                            status.state = "error";
                            status.error = Some("保存用量维度清理状态失败".to_string());
                        });
                    }
                }
                Ok(_) => {
                    wait = Some(self.back_off());
                    set_status(dimension, |status| {
                        status.state = "error";
                        status.error = Some("云端清理回应格式不符".to_string());
                    });
                }
                Err(RpcError::NotDeployed) => {
                    wait = Some(NOT_DEPLOYED_RETRY);
                    set_status(dimension, |status| {
                        status.state = "not-deployed";
                        status.error = None;
                    });
                }
                Err(RpcError::AccountChanged) => {}
                // Turned back on: the next pass re-uploads and overwrites anyway.
                Err(RpcError::Cancelled) => {}
                Err(RpcError::Failed(error)) => {
                    log::warn!("usage dimension clear failed: {error}");
                    wait = Some(self.back_off());
                    set_status(dimension, |status| {
                        status.state = "error";
                        status.error = Some("云端清理尚未确认，将重试".to_string());
                    });
                }
            }
        }
        wait
    }

    /// One upload cycle for every enabled dimension. Returns how long to wait.
    async fn cycle(&mut self, io: &impl PublishIo, mask: Mask, manual: bool) -> Duration {
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
            if self.set_marker(io, dimension, &user, true).is_err() {
                set_status_for(mask, |status| {
                    status.state = "error";
                    status.error = Some("保存用量维度清理标记失败".to_string());
                });
                let delay = self.back_off();
                return self.retry_in(delay).min(TICK);
            }
        }

        match self.upload(io, mask, &user, manual).await {
            Ok(()) => {
                self.failing = false;
                self.backoff = TICK;
                TICK
            }
            Err(RpcError::Cancelled) => {
                self.cycle_at = Some(Instant::now());
                Duration::ZERO
            }
            Err(RpcError::AccountChanged) => {
                let state = match io.stored_user() {
                    Some(user) if user.is_empty() => "signed-out",
                    Some(_) => "starting",
                    None => "error",
                };
                set_status_for(mask, |status| {
                    *status = DimensionStatus {
                        state,
                        ..Default::default()
                    }
                });
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
        manual: bool,
    ) -> Result<(), RpcError> {
        // A pause taken mid-pass stops an automatic pass before its next request.
        let allowed = || manual || !io.background_paused();
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
            if !wanted.still_covered_by(io.mask()) || !allowed() {
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

        let chunks = build_chunks(&self.machine, &days);
        let chunk_count = chunks.len();
        for (index, chunk) in chunks.into_iter().enumerate() {
            let dims = Mask(Dimension::ALL.map(|d| chunk.covers.iter().any(|(c, _)| *c == d)));
            let still_on = || dims.still_covered_by(io.mask()) && allowed();
            let expected_counts = stored_counts(&chunk.payload);
            let reply = io
                .rpc(
                    user,
                    "sync_usage_dimensions_v1",
                    json!({ "p_payload": chunk.payload }),
                    &still_on,
                )
                .await?;
            if io.stored_user().as_deref() != Some(user) {
                return Err(RpcError::AccountChanged);
            }
            if !still_on() {
                return Err(RpcError::Cancelled);
            }
            if reply.value["stored"] != expected_counts
                || reply.value["purged"].as_u64().is_none()
                || reply.value["retentionDays"].as_u64() != Some(WINDOW_DAYS as u64)
            {
                return Err(RpcError::Failed("云端回应格式不符".to_string()));
            }
            let mut next_state = self.state.clone();
            for (dimension, date) in &chunk.covers {
                next_state.record(*dimension, date, current.get(date));
            }
            io.commit(&reply.fence, Some(mask), || {
                io.save_state(&next_state)?;
                if index + 1 == chunk_count {
                    let at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
                    set_status_for(mask, |status| {
                        *status = DimensionStatus {
                            state: "ok",
                            last_uploaded_at: Some(at.clone()),
                            error: None,
                        }
                    });
                }
                Ok(())
            })?;
            self.state = next_state;
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
        let machine = match crate::device_identity::for_data_dir(app.app_data_dir()) {
            Ok(machine) => machine,
            Err(_) => {
                set_status_for(Mask([true; 3]), |status| {
                    status.state = "error";
                    status.error = Some("读取本机设备标识失败".to_string());
                });
                return;
            }
        };
        let io = AppIo {
            data_dir: app.app_data_dir().to_path_buf(),
            app,
            settings,
            machine: machine.clone(),
            secret: Mutex::new(None),
            days: Mutex::new(BTreeMap::new()),
        };
        match Publisher::new(machine, &io) {
            Ok(publisher) => publisher.run(io).await,
            Err(_) => set_status_for(Mask([true; 3]), |status| {
                status.state = "error";
                status.error = Some("读取用量维度同步状态失败".to_string());
            }),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize};

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
        assert!(load_or_create_session_secret(&store).is_err());
        assert_eq!(
            store.get(SESSION_SECRET_ACCOUNT).unwrap().as_deref(),
            Some("not-hex")
        );
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
    fn fingerprints_detect_price_and_context_changes_with_identical_token_counts() {
        let mask = Mask([false, true, true]);
        let mut data = DayData {
            stats: Some(json!({
                "providers": { "openai": { "input": 10, "output": 5, "requests": 1, "cost": 0.25 } },
                "contextComposition": { "requests": 1, "promptTokens": 10, "systemBytes": 50 }
            })),
            behavior: None,
        };
        let before = day_fingerprint(&day_parts("2026-10-24", mask, &data, None));
        data.stats.as_mut().unwrap()["providers"]["openai"]["cost"] = json!(0.5);
        let repriced = day_fingerprint(&day_parts("2026-10-24", mask, &data, None));
        assert_ne!(before, repriced);
        data.stats.as_mut().unwrap()["contextComposition"]["systemBytes"] = json!(60);
        let changed_context = day_fingerprint(&day_parts("2026-10-24", mask, &data, None));
        assert_ne!(repriced, changed_context);
        assert_eq!(
            changed_context,
            day_fingerprint(&day_parts("2026-10-24", mask, &data, None))
        );
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
        assert_eq!(
            classify_failure(
                400,
                br#"{"message":"usage_dimensions_invalid_payload: private details"}"#
            ),
            RpcError::Failed("HTTP 400".to_string())
        );
    }

    #[derive(Default)]
    struct FakeIo {
        mask: Mutex<Mask>,
        user: Mutex<Option<String>>,
        markers: Mutex<[BTreeSet<String>; 3]>,
        state: Mutex<UploadState>,
        nudge: AtomicU8,
        paused: AtomicBool,
        pause_before_send: AtomicBool,
        not_deployed: AtomicBool,
        off_before_send: AtomicBool,
        account_change_after_send: AtomicBool,
        invalid_clear_reply: AtomicBool,
        invalid_upload_reply: AtomicBool,
        fail_marker_write: AtomicBool,
        fail_state_write: AtomicBool,
        commit_race: Mutex<Option<CommitRace>>,
        day_reads: AtomicUsize,
        secret_reads: AtomicUsize,
        sent: Mutex<Vec<(String, Value)>>,
    }

    #[derive(Clone, Copy)]
    enum CommitRace {
        SwitchAccount,
        SignOut,
        Disable,
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

        fn marker(&self, dimension: Dimension) -> Result<Option<String>, String> {
            Ok(self.owners(dimension)?.into_iter().next())
        }

        fn set_marker(&self, dimension: Dimension, user: Option<&str>) -> Result<(), String> {
            self.save_owners(dimension, &user.into_iter().map(str::to_string).collect())
        }

        fn nudge(&self, nudge: Nudge) {
            self.nudge.store(nudge as u8, Ordering::SeqCst);
        }

        fn sent(&self) -> Vec<(String, Value)> {
            std::mem::take(&mut self.sent.lock().unwrap())
        }

        fn apply_race_before_state_save(&self) {
            if matches!(
                *self.commit_race.lock().unwrap(),
                Some(CommitRace::SwitchAccount)
            ) {
                *self.user.lock().unwrap() = Some("user-2".to_string());
            }
        }

        fn apply_race_after_state_save(&self) {
            match self.commit_race.lock().unwrap().take() {
                Some(CommitRace::SignOut) => {
                    *self.user.lock().unwrap() = None;
                }
                Some(CommitRace::Disable) => self.set_mask([false; 3]),
                _ => {}
            }
        }
    }

    impl PublishIo for FakeIo {
        type Fence = String;

        fn commit(
            &self,
            fence: &Self::Fence,
            wanted: Option<Mask>,
            mutation: impl FnOnce() -> Result<(), String>,
        ) -> Result<(), RpcError> {
            self.apply_race_before_state_save();
            self.apply_race_after_state_save();
            let user = self.user.lock().unwrap();
            let mask = self.mask.lock().unwrap();
            if user.as_deref() != Some(fence.as_str()) {
                return Err(RpcError::AccountChanged);
            }
            if wanted.is_some_and(|wanted| !wanted.still_covered_by(*mask)) {
                return Err(RpcError::Cancelled);
            }
            mutation().map_err(RpcError::Failed)
        }

        fn mask(&self) -> Mask {
            *self.mask.lock().unwrap()
        }
        fn stored_user(&self) -> Option<String> {
            Some(self.user.lock().unwrap().clone().unwrap_or_default())
        }
        fn owners(&self, dimension: Dimension) -> Result<BTreeSet<String>, String> {
            Ok(self.markers.lock().unwrap()[dimension.index()].clone())
        }
        fn save_owners(
            &self,
            dimension: Dimension,
            owners: &BTreeSet<String>,
        ) -> Result<(), String> {
            if self.fail_marker_write.load(Ordering::SeqCst) {
                return Err("marker write failed".to_string());
            }
            self.markers.lock().unwrap()[dimension.index()] = owners.clone();
            Ok(())
        }
        fn load_state(&self) -> Result<UploadState, String> {
            Ok(self.state.lock().unwrap().clone())
        }
        fn save_state(&self, state: &UploadState) -> Result<(), String> {
            if self.fail_state_write.load(Ordering::SeqCst) {
                return Err("state write failed".to_string());
            }
            self.apply_race_before_state_save();
            *self.state.lock().unwrap() = state.clone();
            self.apply_race_after_state_save();
            Ok(())
        }
        fn session_secret(&self) -> Result<[u8; 32], String> {
            self.secret_reads.fetch_add(1, Ordering::SeqCst);
            Ok(SECRET)
        }
        fn take_nudge(&self) -> Nudge {
            Nudge::from_u8(self.nudge.swap(Nudge::None as u8, Ordering::SeqCst))
        }
        fn nudge_pending(&self) -> bool {
            self.nudge.load(Ordering::SeqCst) != Nudge::None as u8
        }
        fn background_paused(&self) -> bool {
            self.paused.load(Ordering::SeqCst)
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
            user: &str,
            function: &str,
            body: Value,
            still_wanted: &(dyn Fn() -> bool + Send + Sync),
        ) -> Result<RpcReply<Self::Fence>, RpcError> {
            if self.pause_before_send.swap(false, Ordering::SeqCst) {
                self.paused.store(true, Ordering::SeqCst);
            }
            if self.off_before_send.load(Ordering::SeqCst) {
                self.set_mask([false, false, false]);
            }
            if !still_wanted() {
                return Err(RpcError::Cancelled);
            }
            self.sent
                .lock()
                .unwrap()
                .push((function.to_string(), body.clone()));
            if self.account_change_after_send.swap(false, Ordering::SeqCst) {
                *self.user.lock().unwrap() = Some("user-2".to_string());
            }
            if self.not_deployed.load(Ordering::SeqCst) {
                return Err(RpcError::NotDeployed);
            }
            let value = if function == "clear_usage_dimension_v1" {
                if self.invalid_clear_reply.load(Ordering::SeqCst) {
                    json!({})
                } else {
                    json!({ "deleted": 1 })
                }
            } else {
                json!({
                    "stored": if self.invalid_upload_reply.load(Ordering::SeqCst) {
                        json!({})
                    } else {
                        stored_counts(&body["p_payload"])
                    },
                    "purged": 0,
                    "retentionDays": 90
                })
            };
            Ok(RpcReply {
                value,
                fence: user.to_string(),
            })
        }
        async fn sleep(&self, _duration: Duration) {}
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        static PUBLISHER_TEST_LOCK: Mutex<()> = Mutex::new(());
        let _guard = PUBLISHER_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(async {
            for _ in 0..3 {
                io.nudge(Nudge::Background);
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
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
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
        assert_eq!(
            io.marker(Dimension::Providers).unwrap().as_deref(),
            Some("user-1")
        );
        assert!(io.marker(Dimension::Sessions).unwrap().is_none());

        // No nudge: nothing to do.
        block_on(publisher.tick(&io));
        assert!(io.sent().is_empty());
        // The sync cycle nudges: today and yesterday only.
        io.nudge(Nudge::Background);
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
        let mut restarted = Publisher::new("m".to_string(), &io).unwrap();
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
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        io.sent();
        io.set_mask([false, true, false]);
        block_on(publisher.tick(&io));
        let sent = io.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, CLEAR);
        assert_eq!(sent[0].1, json!({ "p_dimension": "sessions" }));
        assert!(io.marker(Dimension::Sessions).unwrap().is_none());
        assert_eq!(
            io.marker(Dimension::Providers).unwrap().as_deref(),
            Some("user-1")
        );
        io.nudge(Nudge::Background);
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
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
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
        io.set_marker(Dimension::Context, Some("user-1")).unwrap();
        io.set_marker(Dimension::Sessions, Some("someone-else"))
            .unwrap();
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        let sent = io.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].1, json!({ "p_dimension": "context" }));
        assert!(io.marker(Dimension::Context).unwrap().is_none());
        assert_eq!(
            io.marker(Dimension::Sessions).unwrap().as_deref(),
            Some("someone-else")
        );
    }

    #[test]
    fn a_pending_clear_waits_while_signed_out() {
        let io = FakeIo::default();
        io.set_marker(Dimension::Providers, Some("user-1")).unwrap();
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        assert!(io.sent().is_empty());
        assert_eq!(
            io.marker(Dimension::Providers).unwrap().as_deref(),
            Some("user-1")
        );
        *io.user.lock().unwrap() = Some("user-1".to_string());
        block_on(publisher.tick(&io));
        assert_eq!(io.sent().len(), 1);
    }

    #[test]
    fn not_deployed_waits_five_minutes_even_when_nudged() {
        let io = FakeIo::on([false, true, false]);
        io.not_deployed.store(true, Ordering::SeqCst);
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        assert_eq!(io.sent().len(), 1);
        assert!(publisher.failing);
        io.nudge(Nudge::Background);
        block_on(publisher.tick(&io));
        assert!(
            io.sent().is_empty(),
            "the nudge does not cut the retry delay"
        );
        let at = publisher.cycle_at.unwrap();
        assert!(at > Instant::now() + NOT_DEPLOYED_RETRY - Duration::from_secs(5));
    }

    /// Call only inside `block_on`: the status is shared with tests running in parallel.
    fn status_state(dimension: Dimension) -> &'static str {
        status_cell().lock().unwrap().get_mut(dimension).state
    }

    fn synced(sent: &[(String, Value)]) -> usize {
        sent.iter().filter(|(function, _)| function == SYNC).count()
    }

    #[test]
    fn a_paused_background_sync_holds_the_launch_backfill_until_resumed() {
        let io = FakeIo::on([false, true, false]);
        io.paused.store(true, Ordering::SeqCst);
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(async {
            for _ in 0..3 {
                publisher.tick(&io).await;
                assert_eq!(status_state(Dimension::Providers), "paused");
            }
            assert!(io.sent().is_empty(), "launch backfill must wait");
            assert_eq!(io.day_reads.load(Ordering::SeqCst), 0);
            assert!(io.marker(Dimension::Providers).unwrap().is_none());

            io.paused.store(false, Ordering::SeqCst);
            publisher.tick(&io).await;
            assert_eq!(status_state(Dimension::Providers), "ok");
            assert_eq!(synced(&io.sent()), 1, "resuming runs the held backfill");
        });
    }

    #[test]
    fn a_paused_background_sync_holds_failure_retries() {
        let io = FakeIo::on([false, true, false]);
        io.invalid_upload_reply.store(true, Ordering::SeqCst);
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(async {
            publisher.tick(&io).await;
            assert_eq!(synced(&io.sent()), 1);
            assert!(publisher.failing);

            io.invalid_upload_reply.store(false, Ordering::SeqCst);
            io.paused.store(true, Ordering::SeqCst);
            publisher.cycle_at = Some(Instant::now());
            publisher.tick(&io).await;
            assert!(
                io.sent().is_empty(),
                "the due retry must wait for the pause"
            );
            assert_eq!(status_state(Dimension::Providers), "paused");

            io.paused.store(false, Ordering::SeqCst);
            publisher.tick(&io).await;
            assert_eq!(synced(&io.sent()), 1);
            assert!(!publisher.failing);
        });
    }

    #[test]
    fn while_paused_only_a_manual_sync_nudge_uploads() {
        let io = FakeIo::on([true, false, true]);
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(async {
            publisher.tick(&io).await;
            assert_eq!(synced(&io.sent()), 1);

            io.paused.store(true, Ordering::SeqCst);
            io.nudge(Nudge::Background);
            publisher.tick(&io).await;
            assert!(io.sent().is_empty());
            assert_eq!(
                status_state(Dimension::Sessions),
                "ok",
                "nothing pending: keep the last upload time"
            );

            io.nudge(Nudge::Manual);
            publisher.tick(&io).await;
            assert_eq!(synced(&io.sent()), 1, "a manual sync still uploads");
        });
    }

    #[test]
    fn a_manual_nudge_outranks_a_waiting_background_one() {
        let slot = AtomicU8::new(Nudge::None as u8);
        record_nudge(&slot, true);
        record_nudge(&slot, false);
        assert_eq!(
            Nudge::from_u8(slot.swap(Nudge::None as u8, Ordering::SeqCst)),
            Nudge::Manual
        );
        record_nudge(&slot, false);
        assert_eq!(
            Nudge::from_u8(slot.swap(Nudge::None as u8, Ordering::SeqCst)),
            Nudge::Background
        );
    }

    #[test]
    fn pausing_mid_pass_stops_an_automatic_upload_before_it_is_sent() {
        let io = FakeIo::on([false, false, true]);
        io.pause_before_send.store(true, Ordering::SeqCst);
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        assert!(io.sent().is_empty());
        block_on(publisher.tick(&io));
        assert!(io.sent().is_empty(), "still paused: the pass stays held");

        io.paused.store(false, Ordering::SeqCst);
        block_on(publisher.tick(&io));
        assert_eq!(synced(&io.sent()), 1);
    }

    #[test]
    fn a_pending_clear_still_runs_while_background_sync_is_paused() {
        let io = FakeIo::default();
        *io.user.lock().unwrap() = Some("user-1".to_string());
        io.paused.store(true, Ordering::SeqCst);
        io.set_marker(Dimension::Context, Some("user-1")).unwrap();
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        let sent = io.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, CLEAR);
        assert!(io.marker(Dimension::Context).unwrap().is_none());
    }

    #[test]
    fn signed_out_uploads_nothing_and_writes_no_marker() {
        let io = FakeIo::on([true, true, true]);
        *io.user.lock().unwrap() = None;
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        assert!(io.sent().is_empty());
        assert!(Dimension::ALL
            .iter()
            .all(|d| io.marker(*d).unwrap().is_none()));
    }

    #[test]
    fn an_account_change_during_upload_cannot_record_the_old_receipt() {
        let io = FakeIo::on([false, true, false]);
        io.account_change_after_send.store(true, Ordering::SeqCst);
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        assert!(publisher.state.uploaded.is_empty());
        assert!(io.load_state().unwrap().uploaded.is_empty());
    }

    #[test]
    fn an_account_change_after_rpc_cannot_commit_the_old_receipt() {
        block_on(async {
            set_status_for(Mask([true; 3]), |status| *status = off_status());
            let io = FakeIo::on([false, true, false]);
            *io.commit_race.lock().unwrap() = Some(CommitRace::SwitchAccount);
            let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
            publisher.tick(&io).await;
            assert!(publisher.state.uploaded.is_empty());
            assert!(io.load_state().unwrap().uploaded.is_empty());
            let state = status_cell().lock().unwrap().providers.state;
            assert_ne!(state, "ok");
        });
    }

    #[test]
    fn sign_out_after_rpc_cannot_publish_an_ok_status() {
        block_on(async {
            set_status_for(Mask([true; 3]), |status| *status = off_status());
            let io = FakeIo::on([false, true, false]);
            *io.commit_race.lock().unwrap() = Some(CommitRace::SignOut);
            let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
            publisher.tick(&io).await;
            let state = status_cell().lock().unwrap().providers.state;
            assert_ne!(state, "ok");
        });
    }

    #[test]
    fn disabling_after_rpc_cannot_publish_an_ok_status() {
        block_on(async {
            set_status_for(Mask([true; 3]), |status| *status = off_status());
            let io = FakeIo::on([false, true, false]);
            *io.commit_race.lock().unwrap() = Some(CommitRace::Disable);
            let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
            publisher.tick(&io).await;
            let state = status_cell().lock().unwrap().providers.state;
            assert_ne!(state, "ok");
        });
    }

    #[test]
    fn a_failed_upload_state_write_keeps_the_receipt_retryable() {
        block_on(async {
            set_status_for(Mask([true; 3]), |status| *status = off_status());
            let io = FakeIo::on([false, true, false]);
            io.fail_state_write.store(true, Ordering::SeqCst);
            let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
            publisher.tick(&io).await;
            assert!(publisher.state.uploaded.is_empty());
            assert!(io.load_state().unwrap().uploaded.is_empty());
            let status = status_cell().lock().unwrap().providers.clone();
            assert_eq!(status.state, "error");
            assert_eq!(status.error.as_deref(), Some("state write failed"));
            assert!(status.last_uploaded_at.is_none());

            io.fail_state_write.store(false, Ordering::SeqCst);
            publisher.cycle_at = Some(Instant::now());
            publisher.tick(&io).await;
            assert!(!publisher.state.uploaded.is_empty());
            assert_eq!(io.load_state().unwrap(), publisher.state);
            let state = status_cell().lock().unwrap().providers.state;
            assert_eq!(state, "ok");
        });
    }

    #[test]
    fn a_malformed_clear_receipt_keeps_the_pending_marker() {
        let io = FakeIo::default();
        *io.user.lock().unwrap() = Some("user-1".to_string());
        io.set_marker(Dimension::Context, Some("user-1")).unwrap();
        io.invalid_clear_reply.store(true, Ordering::SeqCst);
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        assert_eq!(
            io.marker(Dimension::Context).unwrap().as_deref(),
            Some("user-1")
        );
    }

    #[test]
    fn a_failed_marker_write_prevents_any_upload() {
        let io = FakeIo::on([false, true, false]);
        io.fail_marker_write.store(true, Ordering::SeqCst);
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        assert!(io.sent().is_empty());
        assert!(publisher.markers.iter().all(BTreeSet::is_empty));
        assert_eq!(io.day_reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn clear_state_write_failure_keeps_the_durable_retry_marker() {
        let io = FakeIo::on([false, true, false]);
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        io.sent();
        io.set_mask([false; 3]);
        io.fail_state_write.store(true, Ordering::SeqCst);
        block_on(publisher.tick(&io));
        assert!(io.sent().is_empty());
        assert_eq!(
            io.marker(Dimension::Providers).unwrap().as_deref(),
            Some("user-1")
        );
        assert!(publisher.clear_at.is_some());
        io.fail_state_write.store(false, Ordering::SeqCst);
        publisher.clear_at = None;
        block_on(publisher.tick(&io));
        assert!(io.marker(Dimension::Providers).unwrap().is_none());
        assert!(io
            .load_state()
            .unwrap()
            .dimension(Dimension::Providers)
            .is_empty());
    }

    #[test]
    fn switching_accounts_during_clear_keeps_the_original_owner_marker() {
        let io = FakeIo::default();
        *io.user.lock().unwrap() = Some("user-1".to_string());
        io.set_marker(Dimension::Context, Some("user-1")).unwrap();
        io.account_change_after_send.store(true, Ordering::SeqCst);
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        assert_eq!(
            io.marker(Dimension::Context).unwrap().as_deref(),
            Some("user-1")
        );
    }

    #[test]
    fn enabling_after_an_uncertain_clear_backfills_history_again() {
        let io = FakeIo::on([false, true, false]);
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        io.sent();
        io.set_mask([false; 3]);
        io.invalid_clear_reply.store(true, Ordering::SeqCst);
        block_on(publisher.tick(&io));
        io.sent();
        io.set_mask([false, true, false]);
        block_on(publisher.tick(&io));
        let sent = io.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].1["p_payload"]["providers"]["days"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn an_incomplete_upload_receipt_is_not_persisted() {
        let io = FakeIo::on([false, true, false]);
        io.invalid_upload_reply.store(true, Ordering::SeqCst);
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        assert!(publisher.state.uploaded.is_empty());
        assert!(io.load_state().unwrap().uploaded.is_empty());
        assert_eq!(
            io.marker(Dimension::Providers).unwrap().as_deref(),
            Some("user-1")
        );
    }

    #[test]
    fn switching_accounts_preserves_each_accounts_cleanup_across_restarts() {
        let io = FakeIo::on([false, true, false]);
        let mut publisher = Publisher::new("m".to_string(), &io).unwrap();
        block_on(publisher.tick(&io));
        io.sent();
        *io.user.lock().unwrap() = Some("user-2".to_string());
        io.nudge(Nudge::Background);
        block_on(publisher.tick(&io));
        assert_eq!(io.sent().len(), 1);
        assert_eq!(
            io.owners(Dimension::Providers).unwrap(),
            BTreeSet::from(["user-1".to_string(), "user-2".to_string()])
        );
        io.set_mask([false; 3]);
        let mut restarted = Publisher::new("m".to_string(), &io).unwrap();
        block_on(restarted.tick(&io));
        assert_eq!(io.sent()[0].0, CLEAR);
        assert_eq!(
            io.owners(Dimension::Providers).unwrap(),
            BTreeSet::from(["user-1".to_string()])
        );
        *io.user.lock().unwrap() = Some("user-1".to_string());
        block_on(restarted.tick(&io));
        assert_eq!(io.sent()[0].0, CLEAR);
        assert!(io.owners(Dimension::Providers).unwrap().is_empty());
    }

    #[test]
    fn cleanup_markers_accept_legacy_accounts_and_reject_corrupt_sets() {
        assert_eq!(
            parse_marker_owners(" user-1 ").unwrap(),
            BTreeSet::from(["user-1".to_string()])
        );
        assert_eq!(
            parse_marker_owners(r#"["user-1","user-2"]"#).unwrap().len(),
            2
        );
        for text in ["", "[]", r#"[""]"#, r#"["user-1",]"#] {
            assert!(parse_marker_owners(text).is_err());
        }
    }
}
