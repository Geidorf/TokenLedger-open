//! Optional active health probe (T10.302), off by default. When on, each
//! enabled provider gets one `GET …/models` on a timer, with the key the user
//! already stored for that provider. The model list is a documented public
//! endpoint of both OpenAI-compatible and Anthropic APIs and costs no
//! tokens. Results stay in memory and only feed the health report; they are
//! never written to the usage ledger.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Url;
use serde::{Deserialize, Serialize};

use super::anthropic;
use super::store::{write_json_atomic, AuthMode, ProviderRecord, WireApi};

const STORE_FILE: &str = "health-probe-v1.json";
pub const MIN_INTERVAL_MINS: u32 = 5;
pub const MAX_INTERVAL_MINS: u32 = 120;
const DEFAULT_INTERVAL_MINS: u32 = 15;
/// Probes kept per provider, newest first.
pub const KEEP: usize = 12;
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const ERROR_CHARS: usize = 160;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSettings {
    pub enabled: bool,
    pub interval_mins: u32,
}

impl Default for ProbeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_mins: DEFAULT_INTERVAL_MINS,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    schema_version: u8,
    #[serde(flatten)]
    settings: ProbeSettings,
}

/// One probe. `code` uses the routing trace table; `probe_unsupported`
/// means the provider has no model list, which says nothing about health.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ts: String,
    pub ok: bool,
    pub status: Option<u16>,
    pub latency_ms: u64,
    pub code: &'static str,
    pub error: Option<String>,
}

impl ProbeResult {
    /// A failure that counts against the provider.
    pub fn failed(&self) -> bool {
        !self.ok && self.code != "probe_unsupported"
    }
}

pub struct Prober {
    path: PathBuf,
    settings: Mutex<ProbeSettings>,
    results: Mutex<HashMap<String, VecDeque<ProbeResult>>>,
    last_round: Mutex<Option<Instant>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Prober {
    pub fn new(dir: &Path) -> Self {
        let path = dir.join(STORE_FILE);
        let settings = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<StoreFile>(&bytes).ok())
            .map(|file| clamp(file.settings))
            .unwrap_or_default();
        Self {
            path,
            settings: Mutex::new(settings),
            results: Mutex::new(HashMap::new()),
            last_round: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> ProbeSettings {
        *lock(&self.settings)
    }

    pub fn set(&self, next: ProbeSettings) -> Result<ProbeSettings, String> {
        let next = clamp(next);
        let body = serde_json::to_vec_pretty(&StoreFile {
            schema_version: 1,
            settings: next,
        })
        .map_err(|error| error.to_string())?;
        write_json_atomic(&self.path, &body)?;
        *lock(&self.settings) = next;
        if !next.enabled {
            lock(&self.results).clear();
        }
        Ok(next)
    }

    /// Newest first, per provider id.
    pub fn results(&self) -> HashMap<String, Vec<ProbeResult>> {
        lock(&self.results)
            .iter()
            .map(|(id, list)| (id.clone(), list.iter().cloned().collect()))
            .collect()
    }

    pub fn record(&self, provider: &str, result: ProbeResult) {
        let mut map = lock(&self.results);
        let list = map.entry(provider.to_string()).or_default();
        list.push_front(result);
        list.truncate(KEEP);
    }

    /// Drops results of providers that are gone or disabled.
    pub fn retain(&self, ids: &[String]) {
        lock(&self.results).retain(|id, _| ids.contains(id));
    }

    /// True when a timed round is due now; marks it started.
    pub fn due(&self) -> bool {
        let settings = self.settings();
        if !settings.enabled {
            return false;
        }
        let mut last = lock(&self.last_round);
        let every = Duration::from_secs(u64::from(settings.interval_mins) * 60);
        if last.is_some_and(|at| at.elapsed() < every) {
            return false;
        }
        *last = Some(Instant::now());
        true
    }
}

fn clamp(settings: ProbeSettings) -> ProbeSettings {
    ProbeSettings {
        enabled: settings.enabled,
        interval_mins: settings
            .interval_mins
            .clamp(MIN_INTERVAL_MINS, MAX_INTERVAL_MINS),
    }
}

/// The documented model-list endpoint next to the provider's API.
pub fn models_url(provider: &ProviderRecord) -> Result<Url, String> {
    let text = match provider.wire {
        WireApi::Anthropic => {
            let messages = anthropic::messages_url(&provider.base_url);
            format!("{}/models", messages.trim_end_matches("/messages"))
        }
        WireApi::Chat | WireApi::Responses => {
            format!("{}/models", provider.base_url.trim_end_matches('/'))
        }
    };
    Url::parse(&text).map_err(|_| "供应商接口地址无效。".to_string())
}

/// Trace code for a probe reply status.
pub fn status_code(status: u16) -> &'static str {
    match status {
        200..=299 => "answered",
        401 | 403 => "auth_failed",
        402 => "quota_exhausted",
        429 => "rate_limited",
        404 | 405 | 501 => "probe_unsupported",
        500..=599 => "upstream_failed",
        _ => "upstream_rejected",
    }
}

fn clip(text: &str) -> String {
    text.chars().take(ERROR_CHARS).collect()
}

/// Probes one provider. `key` is `None` only for `AuthMode::None`.
pub async fn probe(
    provider: &ProviderRecord,
    key: Option<&str>,
    client_for: impl std::future::Future<Output = Result<reqwest::Client, String>>,
    url: Url,
) -> ProbeResult {
    let started = Instant::now();
    let ts = chrono::Utc::now().to_rfc3339();
    let done = |status: Option<u16>, code: &'static str, error: Option<String>| ProbeResult {
        ts: ts.clone(),
        ok: code == "answered",
        status,
        latency_ms: started.elapsed().as_millis() as u64,
        code,
        error: error.map(|text| clip(&text)),
    };
    let client = match client_for.await {
        Ok(client) => client,
        Err(error) => return done(None, "connect_failed", Some(error)),
    };
    let mut request = client.get(url);
    if provider.wire == WireApi::Anthropic {
        request = request.header("anthropic-version", anthropic::DEFAULT_VERSION);
        if let (AuthMode::Key, Some(key)) = (provider.auth_mode, key) {
            request = request.header("x-api-key", key);
        }
    } else if let (AuthMode::Key, Some(key)) = (provider.auth_mode, key) {
        request = request.bearer_auth(key);
    }
    match tokio::time::timeout(PROBE_TIMEOUT, request.send()).await {
        Err(_) => done(None, "connect_failed", Some("探活等待超过 20 秒。".into())),
        Ok(Err(error)) => done(
            None,
            "connect_failed",
            Some(format!("连接上游失败：{}", error.without_url())),
        ),
        Ok(Ok(response)) => {
            let status = response.status().as_u16();
            let code = status_code(status);
            let error = (code != "answered").then(|| format!("上游返回 {status}"));
            done(Some(status), code, error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(base: &str, wire: WireApi) -> ProviderRecord {
        ProviderRecord {
            id: "p".into(),
            name: "P".into(),
            base_url: base.into(),
            wire,
            auth_mode: AuthMode::Key,
            models: vec!["m".into()],
            enabled: true,
        }
    }

    #[test]
    fn model_list_sits_next_to_the_api() {
        let url = |base, wire| models_url(&provider(base, wire)).unwrap().to_string();
        assert_eq!(
            url("https://api.example.com/v1/", WireApi::Chat),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            url("https://api.example.com/v1", WireApi::Responses),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            url("https://api.example.com", WireApi::Anthropic),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            url("https://relay.example.com/anthropic/v1", WireApi::Anthropic),
            "https://relay.example.com/anthropic/v1/models"
        );
        assert!(models_url(&provider("not a url", WireApi::Chat)).is_err());
    }

    #[test]
    fn statuses_map_to_trace_codes() {
        assert_eq!(status_code(200), "answered");
        assert_eq!(status_code(401), "auth_failed");
        assert_eq!(status_code(402), "quota_exhausted");
        assert_eq!(status_code(429), "rate_limited");
        assert_eq!(status_code(404), "probe_unsupported");
        assert_eq!(status_code(503), "upstream_failed");
        assert_eq!(status_code(400), "upstream_rejected");
    }

    #[test]
    fn settings_default_off_clamp_and_persist() {
        let dir = std::env::temp_dir().join(format!("tl-gw-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let prober = Prober::new(&dir);
        assert_eq!(
            prober.settings(),
            ProbeSettings {
                enabled: false,
                interval_mins: 15
            }
        );
        assert!(!prober.due());
        let saved = prober
            .set(ProbeSettings {
                enabled: true,
                interval_mins: 1,
            })
            .unwrap();
        assert_eq!(saved.interval_mins, MIN_INTERVAL_MINS);
        assert!(prober.due());
        assert!(!prober.due(), "a round just started");
        assert_eq!(Prober::new(&dir).settings(), saved);

        let result = |ok| ProbeResult {
            ts: "t".into(),
            ok,
            status: Some(200),
            latency_ms: 1,
            code: "answered",
            error: None,
        };
        for _ in 0..(KEEP + 3) {
            prober.record("a", result(true));
        }
        prober.record("b", result(true));
        assert_eq!(prober.results()["a"].len(), KEEP);
        prober.retain(&["a".to_string()]);
        assert!(!prober.results().contains_key("b"));
        prober
            .set(ProbeSettings {
                enabled: false,
                interval_mins: 30,
            })
            .unwrap();
        assert!(prober.results().is_empty(), "turning off forgets results");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsupported_is_not_a_failure() {
        let mut result = ProbeResult {
            ts: "t".into(),
            ok: false,
            status: Some(404),
            latency_ms: 1,
            code: "probe_unsupported",
            error: None,
        };
        assert!(!result.failed());
        result.code = "auth_failed";
        assert!(result.failed());
    }
}
