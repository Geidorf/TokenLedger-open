//! Publishes the live routing scene to the cloud for the Android live
//! wallpaper (docs/contracts/routing-snapshot-v1.md).
//!
//! The snapshot is built from the same two sources as the desktop stage: the
//! gateway's redacted routing feed and the external local gateway's live
//! snapshot. Neither carries sessions, error text, keys or token counts; the
//! builder below only copies agent names, `provider/model` targets, outcomes,
//! status codes and times, and hashes every request id before it leaves.
//!
//! Off by default (`routing_publish_enabled`). Turning it off deletes this
//! device's row; signing out stops publishing.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::app_paths::AppContext;
use crate::gateway::{Gateway, RoutingFeed};
use crate::peer_live::LiveSnapshot;
use crate::settings::AppSettings;

const TICK: Duration = Duration::from_secs(5);
const HEARTBEAT: Duration = Duration::from_secs(60);
const SIGNED_OUT_RETRY: Duration = Duration::from_secs(30);
const NOT_DEPLOYED_RETRY: Duration = Duration::from_secs(300);
const MAX_BACKOFF: Duration = Duration::from_secs(300);
const MAX_FLOWS: usize = 24;
const MAX_HOPS: usize = 8;
const MAX_SNAPSHOT_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024;
/// Present while a snapshot may sit in the cloud, so a clear can resume after a restart.
const CLEAR_MARKER: &str = "routing-publish-clear-pending";
const FLOW_WINDOW_SECS: i64 = 600;
const FEED_LIMIT: usize = 30;
const UNKNOWN_AGENT: &str = "Agent";
const GROUP_PREFIX: &str = "group/";

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutingPublishStatus {
    /// `off` | `signed-out` | `not-deployed` | `ok` | `error` | `starting`
    pub state: &'static str,
    pub last_published_at: Option<String>,
    pub flows: usize,
    pub error: Option<String>,
}

fn status_cell() -> &'static Mutex<RoutingPublishStatus> {
    static STATUS: OnceLock<Mutex<RoutingPublishStatus>> = OnceLock::new();
    STATUS.get_or_init(|| {
        Mutex::new(RoutingPublishStatus {
            state: "off",
            ..Default::default()
        })
    })
}

fn set_status(update: impl FnOnce(&mut RoutingPublishStatus)) {
    let mut guard = status_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    update(&mut guard);
}

/// What the settings page shows next to the switch.
#[tauri::command]
pub fn routing_publish_status(
    window: tauri::WebviewWindow,
) -> Result<RoutingPublishStatus, String> {
    if window.label() != "main" {
        return Err("实时路由同步状态只允许主窗口读取。".to_string());
    }
    Ok(status_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone())
}

fn hex_prefix(input: &str, chars: usize) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(chars);
    for byte in digest.iter() {
        if out.len() >= chars {
            break;
        }
        out.push_str(&format!("{byte:02x}"));
    }
    out.truncate(chars);
    out
}

/// Contract §3.1: the machine name only leaves this computer hashed.
pub fn device_id(user_id: &str, machine: &str) -> String {
    hex_prefix(
        &format!("tokenledger-routing-device-v1\n{user_id}\n{machine}"),
        32,
    )
}

/// Contract §3.2.
fn flow_id(device: &str, source: &str, raw: &str) -> String {
    hex_prefix(
        &format!("tokenledger-routing-flow-v1\n{device}\n{source}\n{raw}"),
        16,
    )
}

fn clip(value: &str, max: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    trimmed.chars().take(max).collect()
}

fn agent_name(value: Option<&str>) -> String {
    match value.map(str::trim) {
        Some(name) if !name.is_empty() => clip(name, 64),
        _ => UNKNOWN_AGENT.to_string(),
    }
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

fn stamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn hop_outcome(outcome: &str) -> &'static str {
    match outcome {
        "ok" => "ok",
        "rejected" => "rejected",
        "skipped" => "skipped",
        _ => "failed",
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Hop {
    target: String,
    outcome: &'static str,
    status: Option<u16>,
}

#[derive(Clone, Debug, PartialEq)]
struct Flow {
    id: String,
    source: &'static str,
    agent: String,
    via: String,
    phase: &'static str,
    at: DateTime<Utc>,
    waiting_on: Option<&'static str>,
    hops: Vec<Hop>,
}

impl Flow {
    fn to_json(&self) -> Value {
        let mut hops: Vec<Hop> = self.hops.clone();
        if hops.len() > MAX_HOPS {
            // Keep the first attempts and the one that ended the request.
            let last = hops.pop().expect("non-empty");
            hops.truncate(MAX_HOPS - 1);
            hops.push(last);
        }
        let hops: Vec<Value> = hops
            .iter()
            .map(|hop| {
                let mut value = json!({ "target": hop.target, "outcome": hop.outcome });
                if let Some(status) = hop.status.filter(|code| (100..=599).contains(code)) {
                    value["status"] = json!(status);
                }
                value
            })
            .collect();
        let mut value = json!({
            "id": self.id,
            "source": self.source,
            "agent": self.agent,
            "via": self.via,
            "phase": self.phase,
            "at": stamp(self.at),
            "hops": hops,
        });
        if let Some(waiting) = self.waiting_on {
            value["waitingOn"] = json!(waiting);
        }
        value
    }
}

fn hop(target: &str, outcome: &'static str, status: Option<u16>) -> Option<Hop> {
    let target = clip(target, 128);
    (!target.is_empty()).then_some(Hop {
        target,
        outcome,
        status,
    })
}

fn flows_from_gateway(feed: &RoutingFeed, device: &str) -> Vec<Flow> {
    let mut agent_by_request: HashMap<&str, &str> = HashMap::new();
    for record in &feed.requests {
        let key = record
            .logical_request_id
            .as_deref()
            .unwrap_or(&record.request_id);
        if let Some(agent) = record.agent.as_deref() {
            agent_by_request.entry(key).or_insert(agent);
        }
    }
    let mut flows = Vec::new();
    for decision in &feed.decisions {
        let Some(at) = parse_time(&decision.ts) else {
            continue;
        };
        let hops: Vec<Hop> = decision
            .attempts
            .iter()
            .filter_map(|attempt| {
                hop(
                    &attempt.member,
                    hop_outcome(attempt.outcome),
                    attempt.status,
                )
            })
            .collect();
        let answered = decision.chosen.is_some() && hops.iter().any(|hop| hop.outcome == "ok");
        flows.push(Flow {
            id: flow_id(device, "tokenledger", &decision.request_id),
            source: "tokenledger",
            agent: agent_name(agent_by_request.get(decision.request_id.as_str()).copied()),
            via: clip(&format!("{GROUP_PREFIX}{}", decision.group), 128),
            // A 2xx means the answer started, not that it finished (design doc).
            phase: if answered { "routed" } else { "failed" },
            at,
            waiting_on: None,
            hops,
        });
    }
    // Direct requests reach the ledger only once they finish; group requests
    // are already covered by their decision.
    for record in feed.requests.iter().filter(|record| record.group.is_none()) {
        let Some(at) = parse_time(&record.ts) else {
            continue;
        };
        let target = format!("{}/{}", record.provider, record.upstream_model);
        let status = (record.status != 0).then_some(record.status);
        flows.push(Flow {
            id: flow_id(device, "tokenledger", &record.request_id),
            source: "tokenledger",
            agent: agent_name(record.agent.as_deref()),
            via: clip(&record.requested_model, 128),
            phase: if record.ok { "done" } else { "failed" },
            at,
            waiting_on: None,
            hops: hop(&target, if record.ok { "ok" } else { "failed" }, status)
                .into_iter()
                .collect(),
        });
    }
    flows
}

fn via_or_external(model: &str) -> String {
    let model = clip(model, 128);
    if model.is_empty() {
        "外部网关".to_string()
    } else {
        model
    }
}

fn flows_from_external(live: &LiveSnapshot, device: &str, now: DateTime<Utc>) -> Vec<Flow> {
    let active: Vec<_> = if live.reachable {
        live.active.iter().collect()
    } else {
        Vec::new()
    };
    let active_ids: HashSet<String> = active
        .iter()
        .map(|request| request.id.to_string())
        .collect();
    let mut flows = Vec::new();
    for route in live
        .recent
        .iter()
        .filter(|route| !active_ids.contains(&route.id))
    {
        let Some(at) = parse_time(&route.ended) else {
            continue;
        };
        let hops: Vec<Hop> = route
            .attempts
            .iter()
            .filter_map(|attempt| {
                let target = if route.model.trim().is_empty() {
                    attempt.provider.clone()
                } else {
                    format!("{}/{}", attempt.provider, route.model)
                };
                hop(&target, hop_outcome(attempt.outcome), attempt.status)
            })
            .collect();
        let ok = hops.iter().any(|hop| hop.outcome == "ok");
        flows.push(Flow {
            id: flow_id(device, "external", &route.id),
            source: "external",
            agent: agent_name(Some(&route.agent)),
            via: via_or_external(&route.model),
            phase: if ok { "done" } else { "failed" },
            at,
            waiting_on: None,
            hops,
        });
    }
    for request in active {
        let at = parse_time(&request.started)
            .unwrap_or_else(|| now - chrono::Duration::milliseconds(request.ms.max(0)));
        let target = if request.provider.trim().is_empty() {
            String::new()
        } else if request.model.trim().is_empty() {
            request.provider.clone()
        } else {
            format!("{}/{}", request.provider, request.model)
        };
        flows.push(Flow {
            id: flow_id(device, "external", &request.id.to_string()),
            source: "external",
            agent: agent_name(Some(&request.agent)),
            via: via_or_external(&request.model),
            phase: "inflight",
            at,
            waiting_on: match request.phase.as_str() {
                "slot" => Some("slot"),
                "rpm" => Some("rpm"),
                "upstream" => Some("upstream"),
                _ => None,
            },
            hops: hop(&target, "pending", None).into_iter().collect(),
        });
    }
    flows
}

/// The gateway read: its feed, or why it could not be read.
pub type FeedRead = Result<RoutingFeed, String>;

/// Builds the contract §3 snapshot. Pure, so the redaction rules are testable.
pub fn build_snapshot(
    device: &str,
    feed: &FeedRead,
    external: Option<&LiveSnapshot>,
    now: DateTime<Utc>,
) -> Value {
    let mut sources = Vec::new();
    let mut flows = Vec::new();
    match feed {
        Ok(feed) => {
            sources.push(if feed.running {
                json!({ "id": "tokenledger", "reachable": true })
            } else {
                json!({ "id": "tokenledger", "reachable": false, "note": "网关未运行" })
            });
            flows.extend(flows_from_gateway(feed, device));
        }
        // The read error can name local paths; the note says only what failed.
        Err(_) => sources.push(
            json!({ "id": "tokenledger", "reachable": false, "note": "读取网关路由记录失败" }),
        ),
    }
    if let Some(live) = external {
        // Users without an external gateway should not see it reported as stopped.
        if live.reachable || !live.recent.is_empty() {
            sources.push(if live.reachable {
                json!({ "id": "external", "reachable": true })
            } else {
                json!({ "id": "external", "reachable": false, "note": "外部网关未运行" })
            });
            flows.extend(flows_from_external(live, device, now));
        }
    }

    let oldest = now - chrono::Duration::seconds(FLOW_WINDOW_SECS);
    flows.retain(|flow| flow.phase == "inflight" || flow.at >= oldest);
    flows.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.id.cmp(&b.id)));
    let mut seen = HashSet::new();
    flows.retain(|flow| seen.insert(flow.id.clone()));
    flows.truncate(MAX_FLOWS);

    let mut snapshot = json!({
        "v": 1,
        "generatedAt": stamp(now),
        "sources": sources,
        "flows": flows.iter().map(Flow::to_json).collect::<Vec<_>>(),
    });
    // Long labels can still exceed the server's limit: drop the oldest flows.
    while server_text_len(&snapshot) > MAX_SNAPSHOT_BYTES {
        let Some(list) = snapshot["flows"].as_array_mut() else {
            break;
        };
        if list.pop().is_none() {
            break;
        }
    }
    snapshot
}

/// Size as the server measures it (`octet_length(jsonb::text)`): the compact form plus
/// the space jsonb prints after every `:` and every `,` between items.
fn server_text_len(snapshot: &Value) -> usize {
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
    snapshot.to_string().len() + separators(snapshot)
}

/// The snapshot minus its timestamp: unchanged content is not re-sent before the heartbeat.
fn content_key(snapshot: &Value) -> String {
    let mut copy = snapshot.clone();
    if let Some(object) = copy.as_object_mut() {
        object.remove("generatedAt");
    }
    copy.to_string()
}

#[derive(Debug, PartialEq)]
enum RpcError {
    NotDeployed,
    /// The signed-in account is not the one the request was built for.
    AccountChanged,
    Failed(String),
}

async fn read_bounded(response: reqwest::Response) -> Result<Vec<u8>, RpcError> {
    let mut response = response;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| RpcError::Failed(format!("读取云端回应失败：{error}")))?
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
        .filter(|message| message.starts_with("routing_snapshot_"))
        .map(str::to_string)
        .unwrap_or_else(|| format!("HTTP {status}"));
    RpcError::Failed(message)
}

/// Device and flow IDs are salted with the user, so a request only goes out under the
/// account it was built for.
async fn call_rpc(
    app: &AppContext,
    expected_user: &str,
    function: &str,
    body: Value,
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
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| RpcError::Failed(error.to_string()))?;
    lease.ensure_current(app).map_err(RpcError::Failed)?;
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
        .map_err(|error| RpcError::Failed(format!("连接云端失败：{error}")))?;
    let status = response.status().as_u16();
    let bytes = read_bounded(response).await?;
    lease.ensure_current(app).map_err(RpcError::Failed)?;
    if !(200..300).contains(&status) {
        return Err(classify_failure(status, &bytes));
    }
    Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// The account in the local cloud config, without touching the network. `None` only when
/// the file cannot be read; signed out reads as an empty user.
fn stored_user(app: &AppContext) -> Option<String> {
    let config = crate::commands::load_cloud_config_file(app).ok()?;
    Some(
        config
            .session
            .map(|session| session.user_id)
            .unwrap_or_default(),
    )
}

struct Published {
    user: String,
    device: String,
    key: String,
    at: Instant,
}

fn enabled(settings: &Arc<Mutex<AppSettings>>) -> bool {
    settings
        .lock()
        .map(|guard| guard.routing_publish_enabled)
        .unwrap_or(false)
}

/// Runs for the life of the process. Every tick is cheap when the switch is off.
pub fn start(app: Arc<AppContext>, settings: Arc<Mutex<AppSettings>>, gateway: Arc<Gateway>) {
    tauri::async_runtime::spawn(async move {
        let machine = crate::commands::local_machine_id();
        let mut published: Option<Published> = None;
        // A device row still to delete after the switch went off; kept until the clear lands.
        // The device ID is derived, so a clear left over from before the last exit is retried
        // on launch. Only the marker file is checked first: people who never turned the
        // switch on do not touch the secure session store at startup.
        let marker = app.app_data_dir().join(CLEAR_MARKER);
        let mut pending_clear: Option<Published> = None;
        // The target still has to be derived from the stored account. An unreadable store
        // keeps this set (and the marker on disk) so a later tick tries again.
        let mut recover = marker.exists();
        let mut was_enabled = false;
        let mut backoff = TICK;
        let mut delay = TICK;
        loop {
            tokio::time::sleep(delay).await;
            delay = TICK;

            if !enabled(&settings) {
                // Switching off always targets a clear, even when no publish was confirmed:
                // one may have committed on the server before its response was lost.
                if std::mem::take(&mut was_enabled) {
                    pending_clear = published.take();
                    recover = pending_clear.is_none();
                }
                if recover {
                    match stored_user(&app) {
                        None => {}
                        Some(user) => {
                            recover = false;
                            if !user.is_empty() {
                                pending_clear = Some(Published {
                                    device: device_id(&user, &machine),
                                    user,
                                    key: String::new(),
                                    at: Instant::now(),
                                });
                            }
                        }
                    }
                }
                // Signed out or switched (read locally, so an outage does not count): the row
                // is no longer this session's to delete; reads hide it after 15 minutes and
                // the hourly purge drops it.
                if let Some(previous) = &pending_clear {
                    if stored_user(&app).is_some_and(|user| user != previous.user) {
                        pending_clear = None;
                    }
                }
                if let Some(previous) = &pending_clear {
                    match call_rpc(
                        &app,
                        &previous.user,
                        "clear_routing_snapshot_v1",
                        json!({ "p_device": previous.device }),
                    )
                    .await
                    {
                        Ok(_) | Err(RpcError::NotDeployed | RpcError::AccountChanged) => {
                            pending_clear = None;
                            backoff = TICK;
                        }
                        Err(RpcError::Failed(error)) => {
                            log::warn!("routing snapshot clear failed: {error}");
                            delay = backoff;
                            backoff = (backoff * 2).min(MAX_BACKOFF);
                        }
                    }
                }
                if pending_clear.is_none() && !recover {
                    let _ = std::fs::remove_file(&marker);
                }
                set_status(|status| {
                    *status = RoutingPublishStatus {
                        state: "off",
                        ..Default::default()
                    }
                });
                continue;
            }

            pending_clear = None;
            recover = false;
            if !std::mem::replace(&mut was_enabled, true) {
                let _ = std::fs::write(&marker, b"");
            }
            // Identity comes from the local config: a token refresh failing during an outage
            // surfaces from `call_rpc` as a retryable error and keeps `published`, so a later
            // switch-off still knows which row to delete.
            let user = match stored_user(&app) {
                Some(user) if !user.is_empty() => user,
                Some(_) => {
                    published = None;
                    set_status(|status| {
                        *status = RoutingPublishStatus {
                            state: "signed-out",
                            ..Default::default()
                        }
                    });
                    delay = SIGNED_OUT_RETRY;
                    continue;
                }
                None => {
                    set_status(|status| {
                        status.state = "error";
                        status.error = Some("读取云端登录信息失败".to_string());
                    });
                    delay = backoff;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    continue;
                }
            };
            if published
                .as_ref()
                .is_some_and(|previous| previous.user != user)
            {
                published = None;
            }
            let device = device_id(&user, &machine);

            let feed_gateway = gateway.clone();
            let feed: FeedRead =
                tauri::async_runtime::spawn_blocking(move || feed_gateway.routing_feed(FEED_LIMIT))
                    .await
                    .unwrap_or_else(|error| Err(error.to_string()));
            let external = crate::peer_live::read_snapshot(crate::peer_live::DEFAULT_PORT)
                .await
                .ok();
            let snapshot = build_snapshot(&device, &feed, external.as_ref(), Utc::now());
            let key = content_key(&snapshot);
            if published
                .as_ref()
                .is_some_and(|previous| previous.key == key && previous.at.elapsed() < HEARTBEAT)
            {
                continue;
            }

            let flows = snapshot["flows"].as_array().map_or(0, Vec::len);
            match call_rpc(
                &app,
                &user,
                "publish_routing_snapshot_v1",
                json!({ "p_device": device, "p_snapshot": snapshot }),
            )
            .await
            {
                // The server keeps a newer snapshot when this machine's clock went back.
                Ok(reply) if reply.get("stored") == Some(&Value::Bool(false)) => {
                    set_status(|status| {
                        status.state = "error";
                        status.error =
                            Some("本机时钟早于上次发布的时间，时钟追上后自动恢复".to_string());
                    });
                    delay = backoff;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
                Ok(_) => {
                    published = Some(Published {
                        user,
                        device,
                        key,
                        at: Instant::now(),
                    });
                    backoff = TICK;
                    set_status(|status| {
                        *status = RoutingPublishStatus {
                            state: "ok",
                            last_published_at: Some(stamp(Utc::now())),
                            flows,
                            error: None,
                        }
                    });
                }
                // Built for the previous account: the next tick rebuilds it for this one.
                Err(RpcError::AccountChanged) => {
                    published = None;
                }
                Err(RpcError::NotDeployed) => {
                    set_status(|status| {
                        status.state = "not-deployed";
                        status.error = None;
                    });
                    delay = NOT_DEPLOYED_RETRY;
                }
                Err(RpcError::Failed(error)) => {
                    log::warn!("routing snapshot publish failed: {error}");
                    set_status(|status| {
                        status.state = "error";
                        status.error = Some(error);
                    });
                    delay = backoff;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::{
        LedgerRecord, MemberTrace, RouteDecision, RouteDecisionAttempt, RoutingFeedRequest,
    };
    use crate::peer_live::{LiveRequest, RecentRoute, RouteAttempt as PeerAttempt};

    const DEVICE: &str = "0123456789abcdef0123456789abcdef";

    fn now() -> DateTime<Utc> {
        parse_time("2026-10-24T07:00:00Z").unwrap()
    }

    fn ledger(request_id: &str, ts: &str, group: Option<&str>, ok: bool) -> LedgerRecord {
        LedgerRecord {
            ts: ts.to_string(),
            request_id: request_id.to_string(),
            logical_request_id: None,
            agent: Some("codex".to_string()),
            session: Some("sess-SECRET-1234".to_string()),
            endpoint: "/v1/responses".to_string(),
            provider: "openai".to_string(),
            requested_model: "gpt-5".to_string(),
            upstream_model: "gpt-5".to_string(),
            wire: "responses".to_string(),
            stream: true,
            status: if ok { 200 } else { 429 },
            ok,
            input: 123456,
            output: 7890,
            cache_read: 0,
            cache_write: 0,
            latency_ms: 1200,
            error: Some("quota exceeded for key sk-SECRET-abcdef".to_string()),
            group: group.map(str::to_string),
            member: None,
        }
    }

    fn decision(request_id: &str, ts: &str) -> RouteDecision {
        RouteDecision {
            ts: ts.to_string(),
            request_id: request_id.to_string(),
            group: "coding".to_string(),
            session: Some("someone@example.com".to_string()),
            reason: "failover",
            detail: "member openai/gpt-5 key sk-SECRET-abcdef was rate limited".to_string(),
            chosen: Some("deepseek/deepseek-chat".to_string()),
            attempts: vec![
                RouteDecisionAttempt {
                    member: "openai/gpt-5".to_string(),
                    outcome: "failed",
                    status: Some(429),
                    error: Some("Bearer sk-SECRET-abcdef at /home/someone/.config".to_string()),
                },
                RouteDecisionAttempt {
                    member: "deepseek/deepseek-chat".to_string(),
                    outcome: "ok",
                    status: Some(200),
                    error: None,
                },
            ],
            trace: vec![MemberTrace {
                member: "openai/gpt-5".to_string(),
                rank: Some(0),
                verdict: "failed",
                reasons: vec!["rate_limited"],
                detail: Some("key sk-SECRET-abcdef from /home/someone/.config".to_string()),
            }],
        }
    }

    fn feed() -> RoutingFeed {
        let requests: Vec<RoutingFeedRequest> = vec![
            ledger("req-group", "2026-10-24T06:59:58Z", Some("coding"), true).into(),
            ledger("req-direct", "2026-10-24T06:59:50Z", None, false).into(),
        ];
        RoutingFeed {
            running: true,
            decisions: vec![decision("req-group", "2026-10-24T06:59:55Z").into()],
            requests,
        }
    }

    fn external() -> LiveSnapshot {
        LiveSnapshot {
            reachable: true,
            port: 3425,
            requests: 3,
            waiting: 1,
            tools: 2,
            active: vec![LiveRequest {
                id: 42,
                agent: "claude".to_string(),
                model: "claude-sonnet".to_string(),
                provider: "anthropic".to_string(),
                started: "2026-10-24T06:59:59Z".to_string(),
                ms: 900,
                phase: "rpm".to_string(),
            }],
            recent: vec![RecentRoute {
                id: "7".to_string(),
                agent: String::new(),
                model: "gpt-5".to_string(),
                ended: "2026-10-24T06:58:00Z".to_string(),
                attempts: vec![PeerAttempt {
                    provider: "openai".to_string(),
                    outcome: "ok",
                    status: None,
                }],
                omitted: 0,
            }],
        }
    }

    #[test]
    fn snapshot_carries_no_session_error_key_token_count_or_raw_id() {
        let snapshot = build_snapshot(DEVICE, &Ok(feed()), Some(&external()), now());
        let text = snapshot.to_string();
        for secret in [
            "SECRET",
            "sess-",
            "sk-",
            "Bearer",
            "rate limited",
            "@example.com",
            "/home/",
            ".config",
            "123456",
            "7890",
            "req-group",
            "req-direct",
            "\"42\"",
            "3425",
            "failover",
        ] {
            assert!(!text.contains(secret), "snapshot leaked {secret}: {text}");
        }
        let allowed_flow_keys: HashSet<&str> = [
            "id",
            "source",
            "agent",
            "via",
            "phase",
            "at",
            "waitingOn",
            "hops",
        ]
        .into();
        for flow in snapshot["flows"].as_array().unwrap() {
            for key in flow.as_object().unwrap().keys() {
                assert!(
                    allowed_flow_keys.contains(key.as_str()),
                    "unexpected key {key}"
                );
            }
            for hop in flow["hops"].as_array().unwrap() {
                for key in hop.as_object().unwrap().keys() {
                    assert!(
                        ["target", "outcome", "status"].contains(&key.as_str()),
                        "unexpected hop key {key}"
                    );
                }
            }
        }
        let top: HashSet<&str> = snapshot
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(top, ["v", "generatedAt", "sources", "flows"].into());
    }

    #[test]
    fn a_failed_read_does_not_publish_its_error_text() {
        let snapshot = build_snapshot(
            DEVICE,
            &Err("C:\\Users\\someone\\AppData\\gateway\\ledger.jsonl: access denied".to_string()),
            None,
            now(),
        );
        assert!(!snapshot.to_string().contains("Users"));
        assert_eq!(
            snapshot["sources"],
            json!([{ "id": "tokenledger", "reachable": false, "note": "读取网关路由记录失败" }])
        );
        assert_eq!(snapshot["flows"], json!([]));
    }

    #[test]
    fn flows_follow_the_scene_rules() {
        let snapshot = build_snapshot(DEVICE, &Ok(feed()), Some(&external()), now());
        let flows = snapshot["flows"].as_array().unwrap();
        // Newest first: in-flight external, group decision, direct request, older external route.
        let phases: Vec<&str> = flows
            .iter()
            .map(|flow| flow["phase"].as_str().unwrap())
            .collect();
        assert_eq!(phases, ["inflight", "routed", "failed", "done"]);
        assert_eq!(flows[0]["waitingOn"], "rpm");
        assert_eq!(
            flows[0]["hops"],
            json!([{ "target": "anthropic/claude-sonnet", "outcome": "pending" }])
        );
        assert_eq!(flows[1]["via"], "group/coding");
        assert_eq!(flows[1]["agent"], "codex");
        assert_eq!(
            flows[1]["hops"],
            json!([
                { "target": "openai/gpt-5", "outcome": "failed", "status": 429 },
                { "target": "deepseek/deepseek-chat", "outcome": "ok", "status": 200 }
            ])
        );
        assert_eq!(
            flows[2]["hops"],
            json!([{ "target": "openai/gpt-5", "outcome": "failed", "status": 429 }])
        );
        assert_eq!(flows[3]["agent"], "Agent");
        for flow in flows {
            let id = flow["id"].as_str().unwrap();
            assert_eq!(id.len(), 16);
            assert!(id
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        }
        // Ids are stable across snapshots so the wallpaper plays each flow once.
        let again = build_snapshot(
            DEVICE,
            &Ok(feed()),
            Some(&external()),
            now() + chrono::Duration::seconds(5),
        );
        assert_eq!(again["flows"][1]["id"], flows[1]["id"]);
        assert_eq!(content_key(&again), content_key(&snapshot));
    }

    #[test]
    fn old_flows_are_dropped_but_in_flight_ones_stay() {
        let later = now() + chrono::Duration::minutes(30);
        let snapshot = build_snapshot(DEVICE, &Ok(feed()), Some(&external()), later);
        let phases: Vec<&str> = snapshot["flows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|flow| flow["phase"].as_str().unwrap())
            .collect();
        assert_eq!(phases, ["inflight"]);
    }

    #[test]
    fn an_absent_external_gateway_is_not_reported() {
        let mut live = external();
        live.reachable = false;
        live.active.clear();
        live.recent.clear();
        let snapshot = build_snapshot(
            DEVICE,
            &Ok(RoutingFeed {
                running: false,
                decisions: vec![],
                requests: vec![],
            }),
            Some(&live),
            now(),
        );
        assert_eq!(
            snapshot["sources"],
            json!([{ "id": "tokenledger", "reachable": false, "note": "网关未运行" }])
        );
    }

    #[test]
    fn server_size_counts_the_spaces_jsonb_prints() {
        let value = json!({ "a": [1, 2], "b": { "c": "x,y:z" }, "d": [], "e": {} });
        // As printed by Postgres: {"a": [1, 2], "b": {"c": "x,y:z"}, "d": [], "e": {}}
        assert_eq!(server_text_len(&value), 52);
    }

    #[test]
    fn limits_hold_for_many_and_long_flows() {
        let long = "x".repeat(400);
        let mut live = external();
        live.active.clear();
        live.recent = (0..60)
            .map(|index| RecentRoute {
                id: index.to_string(),
                agent: long.clone(),
                model: long.clone(),
                ended: "2026-10-24T06:59:00Z".to_string(),
                attempts: (0..12)
                    .map(|_| PeerAttempt {
                        provider: long.clone(),
                        outcome: "failed",
                        status: Some(503),
                    })
                    .collect(),
                omitted: 0,
            })
            .collect();
        let snapshot = build_snapshot(DEVICE, &Ok(feed()), Some(&live), now());
        assert!(server_text_len(&snapshot) <= MAX_SNAPSHOT_BYTES);
        let flows = snapshot["flows"].as_array().unwrap();
        assert!(!flows.is_empty() && flows.len() <= MAX_FLOWS);
        for flow in flows {
            assert!(flow["agent"].as_str().unwrap().chars().count() <= 64);
            assert!(flow["via"].as_str().unwrap().chars().count() <= 128);
            assert!(flow["hops"].as_array().unwrap().len() <= MAX_HOPS);
        }
    }

    #[test]
    fn device_ids_hide_the_machine_name_and_differ_per_account() {
        let id = device_id("user-a", "MY-LAPTOP");
        assert_eq!(id.len(), 32);
        assert!(!id.contains("LAPTOP"));
        assert_ne!(id, device_id("user-b", "MY-LAPTOP"));
    }

    #[test]
    fn missing_rpc_is_reported_as_not_deployed() {
        let body = br#"{"code":"PGRST202","message":"Could not find the function public.publish_routing_snapshot_v1"}"#;
        assert_eq!(classify_failure(404, body), RpcError::NotDeployed);
        let body = br#"{"code":"22023","message":"routing_snapshot_payload_too_large"}"#;
        assert_eq!(
            classify_failure(400, body),
            RpcError::Failed("routing_snapshot_payload_too_large".to_string())
        );
        assert_eq!(
            classify_failure(502, b"<html>bad gateway</html>"),
            RpcError::Failed("HTTP 502".to_string())
        );
    }
}
