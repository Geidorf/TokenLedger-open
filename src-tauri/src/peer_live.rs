//! A readable source of the peer's live routing state (contract `peer-live-v1`),
//! for the desktop routing animation and, through sync, the Android wallpaper.
//!
//! The peer's local gateway answers `GET /v1/peer/concurrency` with every
//! request it is working on: agent, model and provider once routed, and the
//! phase (`slot`, `rpm`, `upstream`). The read asks no vendor, isn't counted,
//! needs no key from this machine and may be polled every second. TokenLedger
//! reads it only on loopback, keeps no copy, and drops session ids.
//!
//! The routes just finished come from the tail of the peer's own
//! `usage.jsonl`, one line per attempt, grouped by `route_id`, so a fallback
//! from one provider to the next can be drawn. Only provider, outcome and
//! status are kept: no error text, account, key or session.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The peer's default gateway address (`gateway.DefaultAddr`).
pub const DEFAULT_PORT: u16 = 3425;
const PATH: &str = crate::peer_wire::LIVE_PATH;
const MAX_ACTIVE: usize = 256;
const MAX_RECENT: usize = 32;
/// The tail of `usage.jsonl` read for recent routes.
const TAIL_BYTES: u64 = 128 * 1024;

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawConcurrency {
    object: String,
    requests: i64,
    waiting: i64,
    tools: i64,
    active: Vec<RawActive>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawActive {
    id: i64,
    agent: String,
    model: String,
    provider: String,
    started: String,
    ms: i64,
    phase: String,
}

/// One request in flight at peer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveRequest {
    pub id: i64,
    pub agent: String,
    /// Empty until routing has decided.
    pub model: String,
    pub provider: String,
    pub started: String,
    pub ms: i64,
    /// `slot`, `rpm`, `upstream`, or empty when the peer doesn't know.
    pub phase: String,
}

/// One attempt of a finished route.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteAttempt {
    pub provider: String,
    /// `ok`, `failed`, or `rejected` (refused before reaching the vendor).
    pub outcome: &'static str,
    /// The HTTP status of a failed attempt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

/// A route the peer finished lately, its attempts in order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRoute {
    pub id: String,
    pub agent: String,
    pub model: String,
    /// When its last attempt ended (RFC 3339).
    pub ended: String,
    pub attempts: Vec<RouteAttempt>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshot {
    /// The peer answered on the port asked.
    pub reachable: bool,
    pub port: u16,
    pub requests: i64,
    pub waiting: i64,
    pub tools: i64,
    pub active: Vec<LiveRequest>,
    /// Up to 32 routes just finished, newest first; read even while the
    /// gateway is down.
    pub recent: Vec<RecentRoute>,
}

impl LiveSnapshot {
    fn unreachable(port: u16) -> Self {
        Self {
            reachable: false,
            port,
            requests: 0,
            waiting: 0,
            tools: 0,
            active: Vec::new(),
            recent: Vec::new(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawAttempt {
    t: String,
    agent: String,
    provider: String,
    model: String,
    req: String,
    served: String,
    status: i64,
    rejected: bool,
    route_id: i64,
    /// Set on calls the peer's sync brought from another computer.
    computer: String,
}

/// The last few routes in `usage.jsonl` lines (oldest first, as the peer
/// appends them), newest route first.
pub fn recent_routes(lines: &[u8]) -> Vec<RecentRoute> {
    let mut routes: BTreeMap<String, (usize, RecentRoute)> = BTreeMap::new();
    for (index, line) in lines.split(|byte| *byte == b'\n').enumerate() {
        let Ok(raw) = serde_json::from_slice::<RawAttempt>(line) else {
            continue;
        };
        // Only this computer's gateway: a synced call ran elsewhere, and its
        // route id may collide with a local one.
        if raw.t.is_empty() || !raw.computer.trim().is_empty() {
            continue;
        }
        let id = if raw.route_id > 0 {
            raw.route_id.to_string()
        } else {
            format!("line-{index}")
        };
        // Older peer versions mark a local rejection only by leaving the
        // provider empty, as the usage import reads them too.
        let rejected = raw.rejected || (raw.provider.is_empty() && raw.status >= 400);
        let attempt = RouteAttempt {
            provider: clip(&raw.provider, 64),
            outcome: if rejected {
                "rejected"
            } else if (200..300).contains(&raw.status) {
                "ok"
            } else {
                "failed"
            },
            status: (!rejected && !(200..300).contains(&raw.status))
                .then(|| u16::try_from(raw.status).ok())
                .flatten()
                .filter(|status| *status > 0),
        };
        let model = [&raw.served, &raw.model, &raw.req]
            .into_iter()
            .map(|model| model.trim())
            .find(|model| !model.is_empty())
            .unwrap_or_default();
        let entry = routes.entry(id.clone()).or_insert_with(|| {
            (
                index,
                RecentRoute {
                    id,
                    agent: clip(&raw.agent, 64),
                    model: String::new(),
                    ended: String::new(),
                    attempts: Vec::new(),
                },
            )
        });
        entry.0 = index;
        entry.1.model = clip(model, 128);
        entry.1.ended = clip(&raw.t, 40);
        if entry.1.attempts.len() < 16 {
            entry.1.attempts.push(attempt);
        }
    }
    let mut routes: Vec<(usize, RecentRoute)> = routes.into_values().collect();
    routes.sort_by_key(|route| std::cmp::Reverse(route.0));
    routes
        .into_iter()
        .take(MAX_RECENT)
        .map(|(_, route)| route)
        .collect()
}

/// The last whole lines of `path`, at most `TAIL_BYTES` of them.
fn read_tail(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut tail = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut tail)?;
    if start > 0 {
        // The first line is cut: it starts before the tail.
        let cut = tail
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(tail.len(), |at| at + 1);
        tail.drain(..cut);
    }
    Ok(tail)
}

/// Recent routes from the peer's `usage.jsonl`; none when there is no file.
pub fn read_recent() -> Vec<RecentRoute> {
    crate::peer_wire::config_dir()
        .and_then(|dir| read_tail(&dir.join("usage.jsonl")).ok())
        .map(|tail| recent_routes(&tail))
        .unwrap_or_default()
}

fn clip(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

/// Reads the peer's answer; anything that isn't its concurrency object is an error.
pub fn parse(body: &[u8], port: u16) -> Result<LiveSnapshot, String> {
    let raw: RawConcurrency =
        serde_json::from_slice(body).map_err(|_| "外部网关返回的内容无法识别。".to_string())?;
    if raw.object != "concurrency" {
        return Err("这个端口上的服务不是外部网关。".to_string());
    }
    let mut active: Vec<LiveRequest> = raw
        .active
        .into_iter()
        .take(MAX_ACTIVE)
        .map(|item| LiveRequest {
            id: item.id,
            agent: clip(&item.agent, 64),
            model: clip(&item.model, 128),
            provider: clip(&item.provider, 64),
            started: clip(&item.started, 40),
            ms: item.ms.max(0),
            phase: clip(&item.phase, 16),
        })
        .collect();
    active.sort_by(|a, b| b.ms.cmp(&a.ms).then(a.id.cmp(&b.id)));
    Ok(LiveSnapshot {
        reachable: true,
        port,
        requests: raw.requests.max(0),
        waiting: raw.waiting.max(0),
        tools: raw.tools.max(0),
        active,
        recent: Vec::new(),
    })
}

/// One read of the peer's live state: the gateway's in-flight requests and the
/// routes just finished. Reusable by other windows' read-only commands.
pub async fn read_snapshot(port: u16) -> Result<LiveSnapshot, String> {
    let mut live = snapshot(port).await?;
    live.recent = tauri::async_runtime::spawn_blocking(read_recent)
        .await
        .unwrap_or_default();
    Ok(live)
}

/// One read of the peer's in-flight requests on `127.0.0.1:<port>`. A gateway
/// that isn't running reads as unreachable, not as an error.
pub async fn snapshot(port: u16) -> Result<LiveSnapshot, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .no_proxy()
        // Only this computer: never follow a redirect elsewhere.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!("http://127.0.0.1:{port}{PATH}");
    let response = match client.get(url).send().await {
        Ok(response) => response,
        Err(error) if error.is_connect() || error.is_timeout() => {
            return Ok(LiveSnapshot::unreachable(port))
        }
        Err(error) => return Err(format!("读取外部网关实时状态失败：{}", error.without_url())),
    };
    if !response.status().is_success() {
        return Err(format!(
            "外部网关拒绝了实时状态读取（HTTP {}）。",
            response.status().as_u16()
        ));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("读取外部网关实时状态失败：{}", error.without_url()))?;
    parse(&body, port)
}

/// Reads the peer's in-flight requests; `port` defaults to the peer's 3425.
#[tauri::command]
pub async fn peer_live_snapshot(
    window: tauri::WebviewWindow,
    port: Option<u16>,
) -> Result<LiveSnapshot, String> {
    if window.label() != "main" {
        return Err("外部网关实时状态只允许主窗口读取。".to_string());
    }
    let port = port.unwrap_or(DEFAULT_PORT);
    if port == 0 {
        return Err("端口无效。".to_string());
    }
    read_snapshot(port).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    const SAMPLE: &str = r#"{"object":"concurrency","data":{"anthropic@a":{"busy":1,"waiting":1,"limit":1}},
        "requests":2,"waiting":1,"tools":0,"active":[
        {"id":7,"agent":"claude","model":"claude-opus-5-5","provider":"anthropic","session":"secret-session",
         "started":"2026-10-23T13:00:00Z","ms":1200,"phase":"upstream","route":3},
        {"id":8,"agent":"codex","session":"s2","started":"2026-10-23T13:00:01Z","ms":300,"phase":"slot"}]}"#;

    #[test]
    fn parses_in_flight_requests_and_drops_sessions() {
        let snapshot = parse(SAMPLE.as_bytes(), DEFAULT_PORT).unwrap();
        assert!(snapshot.reachable);
        assert_eq!((snapshot.requests, snapshot.waiting), (2, 1));
        assert_eq!(snapshot.active.len(), 2);
        assert_eq!(snapshot.active[0].provider, "anthropic");
        assert_eq!(snapshot.active[1].phase, "slot");
        assert_eq!(snapshot.active[1].model, "", "not routed yet");
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("secret-session"));
    }

    #[test]
    fn recent_routes_group_attempts_and_keep_no_error_text() {
        let lines = concat!(
            r#"{"t":"2026-10-23T13:00:00Z","agent":"codex","provider":"a","model":"m1","status":200,"route_id":0}"#,
            "\n",
            r#"{"t":"2026-10-23T13:00:01Z","agent":"claude","provider":"relay","model":"x","req":"opus","status":529,"err":"secret upstream text","providerAccount":"me@example.com","route_id":9}"#,
            "\n",
            r#"{"t":"2026-10-23T13:00:02Z","agent":"claude","provider":"limited","rejected":true,"route_id":9}"#,
            "\n",
            r#"{"t":"2026-10-23T13:00:03Z","agent":"claude","provider":"anthropic","model":"claude-opus-5-5","served":"claude-opus-5-5","status":200,"route_id":9}"#,
            "\n",
            "not json\n",
        );
        let recent = recent_routes(lines.as_bytes());
        assert_eq!(recent.len(), 2);
        let route = &recent[0];
        assert_eq!(route.id, "9");
        assert_eq!(route.ended, "2026-10-23T13:00:03Z");
        assert_eq!(route.model, "claude-opus-5-5");
        let outcomes: Vec<_> = route
            .attempts
            .iter()
            .map(|attempt| (attempt.provider.as_str(), attempt.outcome, attempt.status))
            .collect();
        assert_eq!(
            outcomes,
            vec![
                ("relay", "failed", Some(529)),
                ("limited", "rejected", None),
                ("anthropic", "ok", None)
            ]
        );
        assert_eq!(recent[1].attempts.len(), 1);
        let json = serde_json::to_string(&recent).unwrap();
        assert!(!json.contains("secret") && !json.contains("example.com"));
    }

    #[test]
    fn calls_from_other_computers_are_left_out() {
        let lines = concat!(
            r#"{"t":"2026-10-23T13:00:00Z","provider":"here","status":200,"route_id":5}"#,
            "\n",
            r#"{"t":"2026-10-23T13:00:01Z","provider":"there","status":200,"route_id":5,"computer":"laptop"}"#,
            "\n",
        );
        let routes = recent_routes(lines.as_bytes());
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].attempts.len(), 1);
        assert_eq!(routes[0].attempts[0].provider, "here");
    }

    #[test]
    fn an_old_rejection_without_a_provider_is_a_rejection() {
        let line = r#"{"t":"2026-10-23T13:00:00Z","status":429}"#;
        let routes = recent_routes(line.as_bytes());
        assert_eq!(routes[0].attempts[0].outcome, "rejected");
        assert_eq!(routes[0].attempts[0].status, None);
    }

    #[test]
    fn the_tail_starts_at_a_whole_line() {
        let dir =
            std::env::temp_dir().join(format!("tokenledger_peer_live_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("usage.jsonl");
        let line = r#"{"t":"2026-10-23T13:00:00Z","provider":"p","status":200}"#;
        let mut body = String::new();
        while body.len() < TAIL_BYTES as usize + 4096 {
            body.push_str(line);
            body.push('\n');
        }
        std::fs::write(&path, &body).unwrap();
        let tail = read_tail(&path).unwrap();
        assert!(tail.starts_with(b"{\"t\""));
        assert!(tail.len() as u64 <= TAIL_BYTES);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn something_else_on_the_port_is_an_error() {
        assert!(parse(br#"{"object":"list","data":[]}"#, 1).is_err());
        assert!(parse(b"<html></html>", 1).is_err());
    }

    fn serve_once(body: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 2048];
                let read = stream.read(&mut request).unwrap_or(0);
                let head = String::from_utf8_lossy(&request[..read]).to_string();
                assert!(head.starts_with(&format!("GET {PATH} ")));
                assert!(!head.to_ascii_lowercase().contains("authorization"));
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        port
    }

    #[test]
    fn reads_a_running_gateway_and_tells_one_that_is_not() {
        let port = serve_once(SAMPLE);
        let live = tauri::async_runtime::block_on(snapshot(port)).unwrap();
        assert!(live.reachable);
        assert_eq!(live.active.len(), 2);

        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let none = tauri::async_runtime::block_on(snapshot(port)).unwrap();
        assert!(!none.reachable);
        assert!(none.active.is_empty());
    }
}
