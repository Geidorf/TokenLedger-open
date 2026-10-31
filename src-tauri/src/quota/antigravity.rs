use super::{
    canonical_executable, capture_codexbar_provider_output, format_timestamp,
    resolve_codexbar_executables, sanitize_codexbar_identifier, sanitize_codexbar_label,
    valid_codex_reset_time, CachedEnvelope, QuotaAction, QuotaActionKind, QuotaCapability,
    QuotaMode, QuotaProviderEnvelope, QuotaScope, QuotaSource, QuotaStatus, QuotaUnit,
    QuotaWindowSnapshot, QuotaWindowStatus, ANTIGRAVITY_PROVIDER_ID, CODEX_MAX_WINDOW_MINUTES,
    LAST_GOOD_RETENTION, MAX_FUTURE_CLOCK_SKEW_SECONDS, RECENT_RESULT_REUSE, STALE_AFTER_SECONDS,
};
use chrono::{DateTime, Utc};
use portable_pty::{native_pty_system, CommandBuilder as PtyCommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
#[cfg(windows)]
use std::env;
#[cfg(target_os = "linux")]
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const LOCAL_TOTAL_TIMEOUT: Duration = Duration::from_secs(20);
const LOCAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const LOCAL_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const LOCAL_MAX_PROCESSES: usize = 16;
const LOCAL_MAX_PORTS: usize = 16;
const LOCAL_MAX_WINDOWS: usize = 16;
const PROCESS_LIST_TIMEOUT: Duration = Duration::from_secs(4);
const PORT_LIST_TIMEOUT: Duration = Duration::from_secs(3);
const AGY_STARTUP_POLL: Duration = Duration::from_millis(200);
const FALLBACK_CLI_TOTAL_TIMEOUT: Duration = Duration::from_secs(12);
const FALLBACK_CLI_TIMEOUT: Duration = Duration::from_secs(10);

const QUOTA_SUMMARY_PATH: &str =
    "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const USER_STATUS_PATH: &str = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const COMMAND_MODEL_CONFIG_PATH: &str =
    "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs";

static PROBE_STATE: OnceLock<Mutex<AntigravityProbeState>> = OnceLock::new();

#[derive(Default)]
struct AntigravityProbeState {
    recent: HashMap<PathBuf, CachedEnvelope>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AntigravityFailure {
    AuthorizationRequired,
    SourceNotFound,
    PortUnavailable,
    Timeout,
    ResponseInvalid,
    BridgeUnavailable,
    BridgeTimeout,
    BridgeResponseInvalid,
}

impl AntigravityFailure {
    fn reason_code(self) -> &'static str {
        match self {
            Self::AuthorizationRequired => "antigravity_native_authorization_required",
            Self::SourceNotFound => "antigravity_native_source_not_found",
            Self::PortUnavailable => "antigravity_native_port_unavailable",
            Self::Timeout => "antigravity_native_timeout",
            Self::ResponseInvalid => "antigravity_native_response_invalid",
            Self::BridgeUnavailable => "antigravity_codexbar_unavailable",
            Self::BridgeTimeout => "antigravity_codexbar_timeout",
            Self::BridgeResponseInvalid => "antigravity_codexbar_response_invalid",
        }
    }

    fn priority(self) -> u8 {
        match self {
            Self::AuthorizationRequired => 8,
            Self::ResponseInvalid => 7,
            Self::BridgeResponseInvalid => 6,
            Self::Timeout => 5,
            Self::BridgeTimeout => 4,
            Self::PortUnavailable => 3,
            Self::SourceNotFound => 2,
            Self::BridgeUnavailable => 1,
        }
    }
}

fn prefer_failure(
    current: AntigravityFailure,
    candidate: AntigravityFailure,
) -> AntigravityFailure {
    if candidate.priority() > current.priority() {
        candidate
    } else {
        current
    }
}

fn lock_probe_state() -> MutexGuard<'static, AntigravityProbeState> {
    match PROBE_STATE
        .get_or_init(|| Mutex::new(AntigravityProbeState::default()))
        .lock()
    {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub(super) fn clear_antigravity_probe_cache() {
    lock_probe_state().recent.clear();
}

pub(super) async fn antigravity_envelope(
    app_data_dir: &Path,
    fetched_at: DateTime<Utc>,
    codexbar_fallback_enabled: bool,
) -> QuotaProviderEnvelope {
    let cache_key = app_data_dir.to_path_buf();
    if let Some(cached) = lock_probe_state()
        .recent
        .get(&cache_key)
        .filter(|cached| cached.stored_at.elapsed() <= RECENT_RESULT_REUSE)
        .map(|cached| cached.envelope.clone())
    {
        return cached;
    }

    let native_result = fetch_native_envelope(fetched_at).await;
    let result = match native_result {
        Ok(envelope) => Ok(envelope),
        Err(native_failure) if codexbar_fallback_enabled => {
            let app_data_dir = app_data_dir.to_path_buf();
            let bridge = tauri::async_runtime::spawn_blocking(move || {
                fetch_codexbar_envelope(&app_data_dir, fetched_at)
            })
            .await
            .unwrap_or(Err(AntigravityFailure::BridgeUnavailable));
            match bridge {
                Ok(envelope) => Ok(envelope),
                Err(AntigravityFailure::BridgeUnavailable) => Err(native_failure),
                Err(bridge_failure) => Err(prefer_failure(native_failure, bridge_failure)),
            }
        }
        Err(native_failure) => Err(native_failure),
    };

    let envelope = result.unwrap_or_else(antigravity_error);
    let mut state = lock_probe_state();
    if matches!(envelope.status, QuotaStatus::Ok | QuotaStatus::Stale) {
        state.recent.insert(
            cache_key,
            CachedEnvelope {
                envelope: envelope.clone(),
                stored_at: Instant::now(),
            },
        );
    } else {
        state.recent.remove(app_data_dir);
    }
    envelope
}

pub(super) fn antigravity_authorization_required() -> QuotaProviderEnvelope {
    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: ANTIGRAVITY_PROVIDER_ID.to_string(),
        display_name: "Antigravity".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::Experimental,
        status: QuotaStatus::AuthRequired,
        windows: Vec::new(),
        reason_code: Some("antigravity_local_authorization_required".to_string()),
        action: Some(QuotaAction {
            kind: QuotaActionKind::OpenSettings,
            label_key: "quota.action.enableAntigravityLocal".to_string(),
            value: "antigravity-local".to_string(),
        }),
    }
}

pub(super) fn antigravity_error_code(reason_code: &str) -> QuotaProviderEnvelope {
    let failure = match reason_code {
        "antigravity_native_authorization_required" => AntigravityFailure::AuthorizationRequired,
        "antigravity_native_source_not_found" => AntigravityFailure::SourceNotFound,
        "antigravity_native_port_unavailable" => AntigravityFailure::PortUnavailable,
        "antigravity_native_timeout" => AntigravityFailure::Timeout,
        "antigravity_codexbar_unavailable" => AntigravityFailure::BridgeUnavailable,
        "antigravity_codexbar_timeout" => AntigravityFailure::BridgeTimeout,
        "antigravity_codexbar_response_invalid" => AntigravityFailure::BridgeResponseInvalid,
        _ => AntigravityFailure::ResponseInvalid,
    };
    antigravity_error(failure)
}

fn antigravity_error(failure: AntigravityFailure) -> QuotaProviderEnvelope {
    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: ANTIGRAVITY_PROVIDER_ID.to_string(),
        display_name: "Antigravity".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::Experimental,
        status: if failure == AntigravityFailure::AuthorizationRequired {
            QuotaStatus::AuthRequired
        } else {
            QuotaStatus::Error
        },
        windows: Vec::new(),
        reason_code: Some(failure.reason_code().to_string()),
        action: Some(QuotaAction {
            kind: QuotaActionKind::OpenSettings,
            label_key: "quota.action.reviewAntigravityLocal".to_string(),
            value: "antigravity-local".to_string(),
        }),
    }
}

pub(super) fn antigravity_failure_user_message(reason_code: &str) -> &'static str {
    match reason_code {
        "antigravity_native_authorization_required" => {
            "Antigravity 本地服务拒绝访问，请先在 Antigravity 中完成登录"
        }
        "antigravity_native_source_not_found" => {
            "未发现正在运行的 Antigravity App、IDE 或 agy 本地服务"
        }
        "antigravity_native_port_unavailable" => "未发现 Antigravity 本地额度服务端口",
        "antigravity_native_timeout" => "Antigravity 本地额度读取超时",
        "antigravity_codexbar_unavailable" => "内置读取失败，且未找到可用的 CodexBar CLI 兜底",
        "antigravity_codexbar_timeout" => "CodexBar 的 Antigravity 额度读取超时",
        "antigravity_codexbar_response_invalid" => "CodexBar 未返回可验证的 Antigravity 本地额度",
        _ => "Antigravity 本地服务未返回可验证的额度窗口",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum ProcessKind {
    App,
    Cli,
    Ide,
}

#[derive(Clone, PartialEq, Eq)]
struct ProcessInfo {
    pid: u32,
    kind: ProcessKind,
    csrf_token: Option<String>,
    extension_port: Option<u16>,
    extension_csrf_token: Option<String>,
}

impl std::fmt::Debug for ProcessInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessInfo")
            .field("pid", &self.pid)
            .field("kind", &self.kind)
            .field("csrf_token", &crate::redact::hidden_opt(&self.csrf_token))
            .field("extension_port", &self.extension_port)
            .field(
                "extension_csrf_token",
                &crate::redact::hidden_opt(&self.extension_csrf_token),
            )
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct LocalEndpoint {
    scheme: &'static str,
    port: u16,
    csrf_token: Option<String>,
}

impl std::fmt::Debug for LocalEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalEndpoint")
            .field("scheme", &self.scheme)
            .field("port", &self.port)
            .field("csrf_token", &crate::redact::hidden_opt(&self.csrf_token))
            .finish()
    }
}

fn build_local_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        // Only literal 127.0.0.1 URLs reach this client. Never allow a local
        // server to redirect the relaxed certificate policy elsewhere.
        .danger_accept_invalid_certs(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(LOCAL_REQUEST_TIMEOUT)
        .timeout(LOCAL_REQUEST_TIMEOUT)
        .build()
}

async fn fetch_native_envelope(
    fetched_at: DateTime<Utc>,
) -> Result<QuotaProviderEnvelope, AntigravityFailure> {
    let deadline = Instant::now()
        .checked_add(LOCAL_TOTAL_TIMEOUT)
        .ok_or(AntigravityFailure::Timeout)?;
    let client = build_local_client().map_err(|_| AntigravityFailure::ResponseInvalid)?;

    let mut best_failure = AntigravityFailure::SourceNotFound;
    let mut best_envelope: Option<QuotaProviderEnvelope> = None;
    let process_infos = match tauri::async_runtime::spawn_blocking(discover_processes).await {
        Ok(Ok(processes)) => processes,
        Ok(Err(failure)) => {
            best_failure = prefer_failure(best_failure, failure);
            Vec::new()
        }
        Err(_) => Vec::new(),
    };
    for process in process_infos.into_iter().take(LOCAL_MAX_PROCESSES) {
        if Instant::now() >= deadline {
            return best_envelope.ok_or(AntigravityFailure::Timeout);
        }
        let pid = process.pid;
        let ports = match tauri::async_runtime::spawn_blocking(move || listening_ports(pid)).await {
            Ok(Ok(ports)) => ports,
            Ok(Err(failure)) => {
                best_failure = prefer_failure(best_failure, failure);
                continue;
            }
            Err(_) => {
                best_failure = prefer_failure(best_failure, AntigravityFailure::PortUnavailable);
                continue;
            }
        };
        let endpoints = endpoints_for_process(&process, &ports);
        if endpoints.is_empty() {
            best_failure = prefer_failure(best_failure, AntigravityFailure::PortUnavailable);
            continue;
        }
        match fetch_from_endpoints(&client, &endpoints, fetched_at, deadline).await {
            Ok(envelope) => {
                let replace = best_envelope
                    .as_ref()
                    .is_none_or(|current| envelope.windows.len() > current.windows.len());
                if replace {
                    best_envelope = Some(envelope);
                }
            }
            Err(failure) => best_failure = prefer_failure(best_failure, failure),
        }
    }
    if let Some(envelope) = best_envelope {
        return Ok(envelope);
    }

    match fetch_from_spawned_agy(&client, fetched_at, deadline).await {
        Ok(envelope) => Ok(envelope),
        Err(failure) => Err(prefer_failure(best_failure, failure)),
    }
}

struct ManagedAgyProcess {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Option<Box<dyn MasterPty + Send>>,
    reader: Option<thread::JoinHandle<()>>,
}

impl ManagedAgyProcess {
    fn launch(binary: &Path) -> Result<(Self, u32), AntigravityFailure> {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 50,
                cols: 160,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| AntigravityFailure::SourceNotFound)?;
        let mut command = PtyCommandBuilder::new(binary);
        if let Some(home) = dirs::home_dir() {
            command.cwd(home.as_os_str());
        }
        command.env("TERM", "xterm-256color");
        command.env("NO_COLOR", "1");
        let child = pty
            .slave
            .spawn_command(command)
            .map_err(|_| AntigravityFailure::SourceNotFound)?;
        drop(pty.slave);
        let pid = child
            .process_id()
            .ok_or(AntigravityFailure::SourceNotFound)?;
        let mut reader = pty
            .master
            .try_clone_reader()
            .map_err(|_| AntigravityFailure::SourceNotFound)?;
        // The TUI is deliberately not parsed. Draining prevents the PTY from
        // back-pressuring agy while all quota data comes from localhost RPC.
        let reader = thread::spawn(move || {
            let mut discarded = [0_u8; 4096];
            while reader.read(&mut discarded).is_ok_and(|read| read > 0) {}
        });
        Ok((
            Self {
                child,
                master: Some(pty.master),
                reader: Some(reader),
            },
            pid,
        ))
    }

    fn has_exited(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_some()
    }
}

impl Drop for ManagedAgyProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.master.take();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

async fn fetch_from_spawned_agy(
    client: &reqwest::Client,
    fetched_at: DateTime<Utc>,
    deadline: Instant,
) -> Result<QuotaProviderEnvelope, AntigravityFailure> {
    let candidates = resolve_agy_executables();
    if candidates.is_empty() {
        return Err(AntigravityFailure::SourceNotFound);
    }
    let mut best_failure = AntigravityFailure::SourceNotFound;
    for candidate in candidates {
        if Instant::now() >= deadline {
            return Err(prefer_failure(best_failure, AntigravityFailure::Timeout));
        }
        let (mut process, pid) = match ManagedAgyProcess::launch(&candidate) {
            Ok(value) => value,
            Err(failure) => {
                best_failure = prefer_failure(best_failure, failure);
                continue;
            }
        };
        loop {
            if Instant::now() >= deadline {
                best_failure = prefer_failure(best_failure, AntigravityFailure::Timeout);
                break;
            }
            if process.has_exited() {
                best_failure = prefer_failure(best_failure, AntigravityFailure::ResponseInvalid);
                break;
            }
            let ports = tauri::async_runtime::spawn_blocking(move || listening_ports(pid)).await;
            if let Ok(Ok(ports)) = ports {
                let process_info = ProcessInfo {
                    pid,
                    kind: ProcessKind::Cli,
                    csrf_token: None,
                    extension_port: None,
                    extension_csrf_token: None,
                };
                let endpoints = endpoints_for_process(&process_info, &ports);
                match fetch_from_endpoints(client, &endpoints, fetched_at, deadline).await {
                    Ok(envelope) => return Ok(envelope),
                    Err(failure) => best_failure = prefer_failure(best_failure, failure),
                }
            }
            tokio::time::sleep(AGY_STARTUP_POLL).await;
        }
    }
    Err(best_failure)
}

pub(super) fn resolve_agy_executables() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for key in ["TOKENLEDGER_ANTIGRAVITY_CLI_BIN", "ANTIGRAVITY_CLI_PATH"] {
        if let Some(path) = std::env::var_os(key).map(PathBuf::from) {
            if path.is_absolute() {
                candidates.push(path);
            }
        }
    }
    if let Some(search_path) = std::env::var_os("PATH") {
        #[cfg(windows)]
        let executable = "agy.exe";
        #[cfg(not(windows))]
        let executable = "agy";
        candidates.extend(
            std::env::split_paths(&search_path)
                .filter(|directory| directory.is_absolute())
                .map(|directory| directory.join(executable)),
        );
    }
    if let Some(home) = dirs::home_dir() {
        #[cfg(windows)]
        candidates.push(home.join(".local/bin/agy.exe"));
        #[cfg(not(windows))]
        candidates.push(home.join(".local/bin/agy"));
    }
    #[cfg(not(windows))]
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/agy"),
        PathBuf::from("/usr/local/bin/agy"),
    ]);
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        candidates.extend([
            local_app_data.join("Programs/Antigravity/agy.exe"),
            local_app_data.join("Antigravity/bin/agy.exe"),
        ]);
    }

    let mut resolved = Vec::new();
    for candidate in candidates {
        let Some(candidate) = canonical_executable(&candidate) else {
            continue;
        };
        if !resolved.contains(&candidate) {
            resolved.push(candidate);
        }
    }
    resolved
}

async fn fetch_from_endpoints(
    client: &reqwest::Client,
    endpoints: &[LocalEndpoint],
    fetched_at: DateTime<Utc>,
    deadline: Instant,
) -> Result<QuotaProviderEnvelope, AntigravityFailure> {
    let mut best_failure = AntigravityFailure::ResponseInvalid;
    for endpoint in endpoints {
        if Instant::now() >= deadline {
            return Err(AntigravityFailure::Timeout);
        }
        match post_local_json(
            client,
            endpoint,
            QUOTA_SUMMARY_PATH,
            &json!({"forceRefresh": true}),
        )
        .await
        {
            Ok(value) => match parse_quota_summary(&value, fetched_at) {
                Ok(envelope) => return Ok(envelope),
                Err(failure) => best_failure = prefer_failure(best_failure, failure),
            },
            Err(failure) => best_failure = prefer_failure(best_failure, failure),
        }
        let metadata = json!({
            "metadata": {
                "ideName": "antigravity",
                "extensionName": "antigravity",
                "ideVersion": "unknown",
                "locale": "en"
            }
        });
        match post_local_json(client, endpoint, USER_STATUS_PATH, &metadata).await {
            Ok(value) => match parse_legacy_models(&value, fetched_at) {
                Ok(envelope) => return Ok(envelope),
                Err(failure) => best_failure = prefer_failure(best_failure, failure),
            },
            Err(failure) => best_failure = prefer_failure(best_failure, failure),
        }
        match post_local_json(client, endpoint, COMMAND_MODEL_CONFIG_PATH, &metadata).await {
            Ok(value) => match parse_legacy_models(&value, fetched_at) {
                Ok(envelope) => return Ok(envelope),
                Err(failure) => best_failure = prefer_failure(best_failure, failure),
            },
            Err(failure) => best_failure = prefer_failure(best_failure, failure),
        }
    }
    Err(best_failure)
}

async fn post_local_json(
    client: &reqwest::Client,
    endpoint: &LocalEndpoint,
    path: &str,
    body: &Value,
) -> Result<Value, AntigravityFailure> {
    if !matches!(endpoint.scheme, "https" | "http") || !(1..=u16::MAX).contains(&endpoint.port) {
        return Err(AntigravityFailure::ResponseInvalid);
    }
    let url = format!("{}://127.0.0.1:{}{}", endpoint.scheme, endpoint.port, path);
    let mut request = client
        .post(url)
        .header("Connect-Protocol-Version", "1")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(body);
    if let Some(token) = endpoint
        .csrf_token
        .as_deref()
        .filter(|token| !token.is_empty())
    {
        request = request.header("X-Codeium-Csrf-Token", token);
    }
    let mut response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            AntigravityFailure::Timeout
        } else {
            AntigravityFailure::ResponseInvalid
        }
    })?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(AntigravityFailure::AuthorizationRequired);
    }
    if !response.status().is_success() {
        return Err(AntigravityFailure::ResponseInvalid);
    }
    if response
        .content_length()
        .is_some_and(|length| length > LOCAL_MAX_OUTPUT_BYTES as u64)
    {
        return Err(AntigravityFailure::ResponseInvalid);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AntigravityFailure::ResponseInvalid)?
    {
        if bytes
            .len()
            .checked_add(chunk.len())
            .is_none_or(|length| length > LOCAL_MAX_OUTPUT_BYTES)
        {
            return Err(AntigravityFailure::ResponseInvalid);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| AntigravityFailure::ResponseInvalid)
}

fn parse_quota_summary(
    root: &Value,
    fetched_at: DateTime<Utc>,
) -> Result<QuotaProviderEnvelope, AntigravityFailure> {
    validate_response_code(root)?;
    let payload = root
        .get("response")
        .or_else(|| root.get("summary"))
        .filter(|value| value.is_object())
        .unwrap_or(root);
    let groups = payload
        .get("groups")
        .and_then(Value::as_array)
        .ok_or(AntigravityFailure::ResponseInvalid)?;
    let mut windows = Vec::new();
    let mut stable_ids = HashSet::new();
    for (group_index, group) in groups.iter().enumerate() {
        let group_name = group
            .get("displayName")
            .and_then(Value::as_str)
            .and_then(sanitize_codexbar_label)
            .unwrap_or_else(|| format!("Quota {}", group_index + 1));
        let group_slug = safe_slug(&group_name).unwrap_or_else(|| format!("group-{group_index}"));
        let buckets = group
            .get("buckets")
            .and_then(Value::as_array)
            .ok_or(AntigravityFailure::ResponseInvalid)?;
        for bucket in buckets {
            if bucket.get("disabled").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let remaining_fraction = remaining_fraction(bucket)?;
            let Some(remaining_fraction) = remaining_fraction else {
                continue;
            };
            if !remaining_fraction.is_finite() || !(0.0..=1.0).contains(&remaining_fraction) {
                return Err(AntigravityFailure::ResponseInvalid);
            }
            let bucket_id = bucket
                .get("bucketId")
                .and_then(Value::as_str)
                .and_then(sanitize_codexbar_identifier)
                .ok_or(AntigravityFailure::ResponseInvalid)?;
            let window_id = format!("antigravity-{group_slug}-{bucket_id}");
            if !stable_ids.insert(window_id.clone()) {
                return Err(AntigravityFailure::ResponseInvalid);
            }
            if windows.len() >= LOCAL_MAX_WINDOWS {
                return Err(AntigravityFailure::ResponseInvalid);
            }
            let bucket_name = bucket
                .get("displayName")
                .and_then(Value::as_str)
                .and_then(sanitize_codexbar_label)
                .unwrap_or_else(|| bucket_id.clone());
            let used = (100.0 - remaining_fraction * 100.0).clamp(0.0, 100.0);
            let window_minutes = cadence_minutes(&bucket_id, &bucket_name);
            let resets_at = bucket
                .get("resetTime")
                .and_then(Value::as_str)
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.with_timezone(&Utc))
                .filter(|value| valid_codex_reset_time(*value, fetched_at));
            let reset_elapsed = resets_at.is_some_and(|value| value <= fetched_at);
            windows.push(quota_window(
                window_id,
                format!(
                    "{} {}",
                    display_group_name(&group_name),
                    display_bucket_name(&bucket_id, &bucket_name)
                ),
                used,
                window_minutes,
                resets_at,
                fetched_at,
                reset_elapsed,
            ));
        }
    }
    build_envelope(windows)
}

fn remaining_fraction(bucket: &Value) -> Result<Option<f64>, AntigravityFailure> {
    if let Some(value) = bucket.get("remainingFraction") {
        return value
            .as_f64()
            .map(Some)
            .ok_or(AntigravityFailure::ResponseInvalid);
    }
    let Some(remaining) = bucket.get("remaining") else {
        return Ok(None);
    };
    if let Some(value) = remaining.get("remainingFraction") {
        return value
            .as_f64()
            .map(Some)
            .ok_or(AntigravityFailure::ResponseInvalid);
    }
    if remaining.get("case").and_then(Value::as_str) == Some("remainingFraction") {
        return remaining
            .get("value")
            .and_then(Value::as_f64)
            .map(Some)
            .ok_or(AntigravityFailure::ResponseInvalid);
    }
    Ok(None)
}

#[derive(Clone)]
struct LegacyCandidate {
    used: f64,
    reset: Option<DateTime<Utc>>,
}

fn parse_legacy_models(
    root: &Value,
    fetched_at: DateTime<Utc>,
) -> Result<QuotaProviderEnvelope, AntigravityFailure> {
    validate_response_code(root)?;
    let configs = root
        .pointer("/userStatus/cascadeModelConfigData/clientModelConfigs")
        .or_else(|| root.get("clientModelConfigs"))
        .and_then(Value::as_array)
        .ok_or(AntigravityFailure::ResponseInvalid)?;
    if configs.len() > 256 {
        return Err(AntigravityFailure::ResponseInvalid);
    }
    let mut gemini: Option<LegacyCandidate> = None;
    let mut claude_gpt: Option<LegacyCandidate> = None;
    for config in configs {
        let model = config
            .pointer("/modelOrAlias/model")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let label = config.get("label").and_then(Value::as_str).unwrap_or(model);
        let lower = format!("{model} {label}").to_ascii_lowercase();
        if lower.contains("image") || lower.contains("autocomplete") || lower.contains("lite") {
            continue;
        }
        let Some(fraction) = config
            .pointer("/quotaInfo/remainingFraction")
            .and_then(Value::as_f64)
        else {
            continue;
        };
        if !fraction.is_finite() || !(0.0..=1.0).contains(&fraction) {
            return Err(AntigravityFailure::ResponseInvalid);
        }
        let candidate = LegacyCandidate {
            used: (100.0 - fraction * 100.0).clamp(0.0, 100.0),
            reset: config
                .pointer("/quotaInfo/resetTime")
                .and_then(Value::as_str)
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.with_timezone(&Utc))
                .filter(|value| valid_codex_reset_time(*value, fetched_at)),
        };
        let target = if lower.contains("gemini") {
            &mut gemini
        } else if lower.contains("claude") || lower.contains("gpt") {
            &mut claude_gpt
        } else {
            continue;
        };
        if target
            .as_ref()
            .is_none_or(|current| candidate.used > current.used)
        {
            *target = Some(candidate);
        }
    }
    let mut windows = Vec::new();
    if let Some(candidate) = gemini {
        let reset_elapsed = candidate.reset.is_some_and(|value| value <= fetched_at);
        windows.push(quota_window(
            "antigravity-legacy-gemini".to_string(),
            "Gemini".to_string(),
            candidate.used,
            None,
            candidate.reset,
            fetched_at,
            reset_elapsed,
        ));
    }
    if let Some(candidate) = claude_gpt {
        let reset_elapsed = candidate.reset.is_some_and(|value| value <= fetched_at);
        windows.push(quota_window(
            "antigravity-legacy-claude-gpt".to_string(),
            "Claude/GPT".to_string(),
            candidate.used,
            None,
            candidate.reset,
            fetched_at,
            reset_elapsed,
        ));
    }
    build_envelope(windows)
}

fn validate_response_code(root: &Value) -> Result<(), AntigravityFailure> {
    let Some(code) = root.get("code") else {
        return Ok(());
    };
    let valid = code.as_i64() == Some(0)
        || code.as_str().is_some_and(|value| {
            matches!(value.to_ascii_lowercase().as_str(), "0" | "ok" | "success")
        });
    if valid {
        Ok(())
    } else {
        Err(AntigravityFailure::ResponseInvalid)
    }
}

fn build_envelope(
    windows: Vec<QuotaWindowSnapshot>,
) -> Result<QuotaProviderEnvelope, AntigravityFailure> {
    if windows.is_empty() || windows.len() > LOCAL_MAX_WINDOWS {
        return Err(AntigravityFailure::ResponseInvalid);
    }
    let stale = windows
        .iter()
        .any(|window| window.status == QuotaWindowStatus::Stale);
    Ok(QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: ANTIGRAVITY_PROVIDER_ID.to_string(),
        display_name: "Antigravity".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::Experimental,
        status: if stale {
            QuotaStatus::Stale
        } else {
            QuotaStatus::Ok
        },
        windows,
        reason_code: stale.then(|| "reset_elapsed".to_string()),
        action: None,
    })
}

#[allow(clippy::too_many_arguments)]
fn quota_window(
    window_id: String,
    window_label: String,
    used: f64,
    window_minutes: Option<u64>,
    resets_at: Option<DateTime<Utc>>,
    fetched_at: DateTime<Utc>,
    reset_elapsed: bool,
) -> QuotaWindowSnapshot {
    let observed_at = format_timestamp(fetched_at);
    QuotaWindowSnapshot {
        provider_id: ANTIGRAVITY_PROVIDER_ID.to_string(),
        window_id,
        window_label,
        account_label: None,
        scope: QuotaScope::ConsumerSubscription,
        source: QuotaSource::LocalAuthorized,
        status: if reset_elapsed {
            QuotaWindowStatus::Stale
        } else {
            QuotaWindowStatus::Ok
        },
        used: Some(used),
        limit: Some(100.0),
        remaining: Some(100.0 - used),
        unit: QuotaUnit::Percent,
        currency: None,
        window_minutes,
        resets_at: resets_at.map(format_timestamp),
        observed_at: observed_at.clone(),
        fetched_at: observed_at,
        stale_after_seconds: STALE_AFTER_SECONDS as u64,
        reason_code: reset_elapsed.then(|| "reset_elapsed".to_string()),
    }
}

fn cadence_minutes(bucket_id: &str, bucket_name: &str) -> Option<u64> {
    let candidate = format!("{bucket_id} {bucket_name}").to_ascii_lowercase();
    if candidate.contains("weekly") || candidate.contains("week") {
        Some(7 * 24 * 60)
    } else if candidate.contains("session")
        || candidate.contains("5h")
        || candidate.contains("5-hour")
        || candidate.contains("five hour")
    {
        Some(5 * 60)
    } else {
        None
    }
}

fn display_group_name(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if lower.contains("gemini") {
        "Gemini".to_string()
    } else if lower.contains("claude") || lower.contains("gpt") {
        "Claude/GPT".to_string()
    } else {
        value.to_string()
    }
}

fn display_bucket_name(bucket_id: &str, value: &str) -> String {
    match cadence_minutes(bucket_id, value) {
        Some(300) => "5-hour".to_string(),
        Some(10080) => "weekly".to_string(),
        _ => value.to_string(),
    }
}

fn safe_slug(value: &str) -> Option<String> {
    let mut slug = String::new();
    let mut separator = false;
    for character in value.trim().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            separator = false;
        } else if matches!(character, '-' | '_' | '.' | ' ') && !slug.is_empty() && !separator {
            slug.push('-');
            separator = true;
        }
        if slug.len() >= 48 {
            break;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    (!slug.is_empty()).then_some(slug)
}

fn discover_processes() -> Result<Vec<ProcessInfo>, AntigravityFailure> {
    #[cfg(windows)]
    let output = windows_process_list()?;
    #[cfg(not(windows))]
    let output = unix_process_list()?;
    let mut processes = parse_process_list(&output)?;
    processes.sort_by_key(|process| (process.kind, process.pid));
    processes.dedup_by_key(|process| process.pid);
    if processes.is_empty() {
        Err(AntigravityFailure::SourceNotFound)
    } else if processes.len() > LOCAL_MAX_PROCESSES {
        processes.truncate(LOCAL_MAX_PROCESSES);
        Ok(processes)
    } else {
        Ok(processes)
    }
}

#[cfg(not(windows))]
fn unix_process_list() -> Result<String, AntigravityFailure> {
    let binary = ["/bin/ps", "/usr/bin/ps"]
        .iter()
        .map(Path::new)
        .find(|path| path.is_file())
        .ok_or(AntigravityFailure::SourceNotFound)?;
    let mut command = Command::new(binary);
    command.args(["-x", "-o", "pid=,command="]);
    capture_command_stdout(&mut command, PROCESS_LIST_TIMEOUT, LOCAL_MAX_OUTPUT_BYTES)
        .and_then(|bytes| String::from_utf8(bytes).map_err(|_| AntigravityFailure::ResponseInvalid))
}

#[cfg(windows)]
fn windows_process_list() -> Result<String, AntigravityFailure> {
    let system_root = env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or(AntigravityFailure::SourceNotFound)?;
    let powershell = system_root
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if !powershell.is_file() {
        return Err(AntigravityFailure::SourceNotFound);
    }
    let script = "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Get-CimInstance Win32_Process | ForEach-Object { $o=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue; if($o.Sid -eq $sid -and $_.CommandLine){[pscustomobject]@{pid=$_.ProcessId;command=$_.CommandLine}} } | ConvertTo-Json -Compress";
    let mut command = Command::new(powershell);
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ]);
    capture_command_stdout(&mut command, PROCESS_LIST_TIMEOUT, LOCAL_MAX_OUTPUT_BYTES)
        .and_then(|bytes| String::from_utf8(bytes).map_err(|_| AntigravityFailure::ResponseInvalid))
}

fn parse_process_list(output: &str) -> Result<Vec<ProcessInfo>, AntigravityFailure> {
    #[cfg(windows)]
    {
        let value: Value =
            serde_json::from_str(output).map_err(|_| AntigravityFailure::ResponseInvalid)?;
        let items: Vec<&Value> = match &value {
            Value::Array(items) => items.iter().collect(),
            Value::Object(_) => vec![&value],
            Value::Null => Vec::new(),
            _ => return Err(AntigravityFailure::ResponseInvalid),
        };
        Ok(items
            .into_iter()
            .filter_map(|item| {
                let pid = item
                    .get("pid")?
                    .as_u64()
                    .and_then(|value| u32::try_from(value).ok())?;
                let command = item.get("command")?.as_str()?;
                process_from_command(pid, command)
            })
            .collect())
    }
    #[cfg(not(windows))]
    {
        Ok(output
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                let split = line.find(char::is_whitespace)?;
                let pid = line[..split].parse::<u32>().ok()?;
                process_from_command(pid, line[split..].trim())
            })
            .collect())
    }
}

fn process_from_command(pid: u32, command: &str) -> Option<ProcessInfo> {
    let lower = command.to_ascii_lowercase();
    let language_server = lower.contains("language_server") || lower.contains("language-server");
    let ide = lower.contains("antigravity ide")
        || lower.contains("antigravity-ide")
        || lower.contains("extensions/antigravity")
        || lower.contains("extensions\\antigravity");
    let app = language_server
        && (lower.contains("--app_data_dir antigravity")
            || lower.contains("--app_data_dir=antigravity")
            || lower.contains("antigravity.app/")
            || lower.contains("antigravity.app\\"));
    let cli = is_cli_command(&lower);
    let kind = if app && !ide {
        ProcessKind::App
    } else if cli {
        ProcessKind::Cli
    } else if language_server && ide {
        ProcessKind::Ide
    } else {
        return None;
    };
    let csrf_token = extract_flag(command, "--csrf_token");
    if matches!(kind, ProcessKind::App | ProcessKind::Ide) && csrf_token.is_none() {
        return None;
    }
    Some(ProcessInfo {
        pid,
        kind,
        csrf_token,
        extension_port: extract_flag(command, "--extension_server_port")
            .and_then(|value| value.parse::<u16>().ok()),
        extension_csrf_token: extract_flag(command, "--extension_server_csrf_token"),
    })
}

fn is_cli_command(lower: &str) -> bool {
    let program = lower
        .strip_prefix('"')
        .and_then(|value| value.split_once('"').map(|(program, _)| program))
        .or_else(|| lower.split_whitespace().next());
    program.is_some_and(|program| {
        program.rsplit(['/', '\\']).next().is_some_and(|name| {
            matches!(
                name.trim_matches('"'),
                "agy"
                    | "agy.exe"
                    | "antigravity-cli"
                    | "antigravity-cli.exe"
                    | "antigravity_cli"
                    | "antigravity_cli.exe"
            )
        })
    }) || lower.contains("/antigravity-cli/")
        || lower.contains("\\antigravity-cli\\")
}

fn extract_flag(command: &str, flag: &str) -> Option<String> {
    let tokens = command.split_whitespace().collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        if *token == flag {
            return tokens.get(index + 1).map(|value| trim_command_token(value));
        }
        if let Some(value) = token.strip_prefix(&format!("{flag}=")) {
            return Some(trim_command_token(value));
        }
    }
    None
}

fn trim_command_token(value: &str) -> String {
    value
        .trim_matches(|character| matches!(character, '"' | '\''))
        .to_string()
}

fn endpoints_for_process(process: &ProcessInfo, ports: &[u16]) -> Vec<LocalEndpoint> {
    let mut endpoints = Vec::new();
    for port in ports.iter().copied().take(LOCAL_MAX_PORTS) {
        endpoints.push(LocalEndpoint {
            scheme: "https",
            port,
            csrf_token: process.csrf_token.clone(),
        });
        #[cfg(target_os = "linux")]
        endpoints.push(LocalEndpoint {
            scheme: "http",
            port,
            csrf_token: process.csrf_token.clone(),
        });
    }
    if let Some(port) = process.extension_port {
        endpoints.push(LocalEndpoint {
            scheme: "http",
            port,
            csrf_token: process
                .extension_csrf_token
                .clone()
                .or_else(|| process.csrf_token.clone()),
        });
    }
    let mut seen = HashSet::new();
    endpoints.retain(|endpoint| seen.insert(endpoint.clone()));
    endpoints
}

fn listening_ports(pid: u32) -> Result<Vec<u16>, AntigravityFailure> {
    #[cfg(windows)]
    let ports = windows_listening_ports(pid)?;
    #[cfg(not(windows))]
    let ports = unix_listening_ports(pid)?;
    if ports.is_empty() || ports.len() > LOCAL_MAX_PORTS {
        Err(AntigravityFailure::PortUnavailable)
    } else {
        Ok(ports)
    }
}

#[cfg(not(windows))]
fn unix_listening_ports(pid: u32) -> Result<Vec<u16>, AntigravityFailure> {
    let lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"]
        .iter()
        .map(Path::new)
        .find(|path| path.is_file());
    if let Some(lsof) = lsof {
        let mut command = Command::new(lsof);
        command.args(["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", &pid.to_string()]);
        let output = capture_command_stdout(&mut command, PORT_LIST_TIMEOUT, 64 * 1024)?;
        return parse_lsof_ports(&String::from_utf8_lossy(&output));
    }
    #[cfg(target_os = "linux")]
    {
        return proc_listening_ports(pid);
    }
    #[allow(unreachable_code)]
    Err(AntigravityFailure::PortUnavailable)
}

#[cfg(any(not(windows), test))]
fn parse_lsof_ports(output: &str) -> Result<Vec<u16>, AntigravityFailure> {
    let mut ports = HashSet::new();
    for line in output.lines().filter(|line| line.contains("(LISTEN)")) {
        let Some(tcp_index) = line.find("TCP ") else {
            continue;
        };
        let endpoint = line[tcp_index + 4..]
            .split_whitespace()
            .next()
            .unwrap_or_default();
        let Some(port) = endpoint
            .rsplit(':')
            .next()
            .and_then(|value| value.parse::<u16>().ok())
        else {
            continue;
        };
        ports.insert(port);
    }
    let mut ports = ports.into_iter().collect::<Vec<_>>();
    ports.sort_unstable();
    if ports.is_empty() {
        Err(AntigravityFailure::PortUnavailable)
    } else {
        Ok(ports)
    }
}

#[cfg(target_os = "linux")]
fn proc_listening_ports(pid: u32) -> Result<Vec<u16>, AntigravityFailure> {
    let process_root = PathBuf::from("/proc").join(pid.to_string());
    let mut socket_inodes = HashSet::new();
    for entry in fs::read_dir(process_root.join("fd"))
        .map_err(|_| AntigravityFailure::PortUnavailable)?
        .flatten()
        .take(4096)
    {
        let Ok(target) = fs::read_link(entry.path()) else {
            continue;
        };
        let target = target.to_string_lossy();
        if let Some(inode) = target
            .strip_prefix("socket:[")
            .and_then(|value| value.strip_suffix(']'))
        {
            socket_inodes.insert(inode.to_string());
        }
    }
    let mut ports = HashSet::new();
    for name in ["tcp", "tcp6"] {
        let Ok(content) = fs::read_to_string(process_root.join("net").join(name)) else {
            continue;
        };
        for line in content.lines().skip(1) {
            let columns = line.split_whitespace().collect::<Vec<_>>();
            if columns.len() <= 9 || columns[3] != "0A" || !socket_inodes.contains(columns[9]) {
                continue;
            }
            if let Some(port) = columns[1]
                .rsplit(':')
                .next()
                .and_then(|value| u16::from_str_radix(value, 16).ok())
            {
                ports.insert(port);
            }
        }
    }
    let mut ports = ports.into_iter().collect::<Vec<_>>();
    ports.sort_unstable();
    if ports.is_empty() {
        Err(AntigravityFailure::PortUnavailable)
    } else {
        Ok(ports)
    }
}

#[cfg(windows)]
fn windows_listening_ports(pid: u32) -> Result<Vec<u16>, AntigravityFailure> {
    let system_root = env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or(AntigravityFailure::PortUnavailable)?;
    let powershell = system_root
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if !powershell.is_file() {
        return Err(AntigravityFailure::PortUnavailable);
    }
    let script = format!(
        "Get-NetTCPConnection -State Listen -OwningProcess {pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort"
    );
    let mut command = Command::new(powershell);
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &script,
    ]);
    let output = capture_command_stdout(&mut command, PORT_LIST_TIMEOUT, 16 * 1024)?;
    let mut ports = String::from_utf8_lossy(&output)
        .lines()
        .filter_map(|line| line.trim().parse::<u16>().ok())
        .collect::<Vec<_>>();
    ports.sort_unstable();
    ports.dedup();
    if ports.is_empty() {
        Err(AntigravityFailure::PortUnavailable)
    } else {
        Ok(ports)
    }
}

fn capture_command_stdout(
    command: &mut Command,
    timeout: Duration,
    max_bytes: usize,
) -> Result<Vec<u8>, AntigravityFailure> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    super::configure_app_server_command(command);
    let mut child = command
        .spawn()
        .map_err(|_| AntigravityFailure::SourceNotFound)?;
    let tree_id = child.id();
    let mut stdout = child
        .stdout
        .take()
        .ok_or(AntigravityFailure::SourceNotFound)?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = Read::by_ref(&mut stdout)
            .take((max_bytes + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(AntigravityFailure::Timeout)?;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                super::terminate_process_tree(tree_id);
                let _ = child.kill();
                let _ = super::wait_for_child_exit(&mut child, Duration::from_millis(250));
                return Err(AntigravityFailure::Timeout);
            }
            Err(_) => return Err(AntigravityFailure::SourceNotFound),
        }
    };
    let bytes = receiver
        .recv_timeout(Duration::from_millis(250))
        .map_err(|_| AntigravityFailure::Timeout)?
        .map_err(|_| AntigravityFailure::ResponseInvalid)?;
    if reader.is_finished() {
        let _ = reader.join();
    }
    if !status.success() || bytes.len() > max_bytes {
        return Err(AntigravityFailure::ResponseInvalid);
    }
    Ok(bytes)
}

fn fetch_codexbar_envelope(
    app_data_dir: &Path,
    fetched_at: DateTime<Utc>,
) -> Result<QuotaProviderEnvelope, AntigravityFailure> {
    let candidates = resolve_codexbar_executables();
    if candidates.is_empty() {
        return Err(AntigravityFailure::BridgeUnavailable);
    }
    let deadline = Instant::now()
        .checked_add(FALLBACK_CLI_TOTAL_TIMEOUT)
        .ok_or(AntigravityFailure::BridgeTimeout)?;
    let mut best_failure = AntigravityFailure::BridgeUnavailable;
    for program in candidates {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(AntigravityFailure::BridgeTimeout)?;
        let bytes = match capture_codexbar_provider_output(
            &program,
            app_data_dir,
            "antigravity",
            "cli",
            remaining.min(FALLBACK_CLI_TIMEOUT),
        ) {
            Ok(bytes) => bytes,
            Err(super::FallbackCliFailure::Unavailable) => {
                best_failure = prefer_failure(best_failure, AntigravityFailure::BridgeUnavailable);
                continue;
            }
            Err(super::FallbackCliFailure::Timeout) => {
                best_failure = prefer_failure(best_failure, AntigravityFailure::BridgeTimeout);
                continue;
            }
            Err(super::FallbackCliFailure::ResponseInvalid) => {
                best_failure =
                    prefer_failure(best_failure, AntigravityFailure::BridgeResponseInvalid);
                continue;
            }
        };
        match parse_codexbar_output(&bytes, fetched_at) {
            Ok(envelope) => return Ok(envelope),
            Err(failure) => best_failure = prefer_failure(best_failure, failure),
        }
    }
    Err(best_failure)
}

fn parse_codexbar_output(
    bytes: &[u8],
    fetched_at: DateTime<Utc>,
) -> Result<QuotaProviderEnvelope, AntigravityFailure> {
    if bytes.is_empty() || bytes.len() > LOCAL_MAX_OUTPUT_BYTES {
        return Err(AntigravityFailure::BridgeResponseInvalid);
    }
    let root: Value =
        serde_json::from_slice(bytes).map_err(|_| AntigravityFailure::BridgeResponseInvalid)?;
    let payload = match &root {
        Value::Array(items) => items
            .iter()
            .find(|item| item.get("provider").and_then(Value::as_str) == Some("antigravity")),
        Value::Object(_) if root.get("provider").and_then(Value::as_str) == Some("antigravity") => {
            Some(&root)
        }
        _ => None,
    }
    .ok_or(AntigravityFailure::BridgeResponseInvalid)?;
    if !matches!(
        payload.get("source").and_then(Value::as_str),
        Some("app" | "cli" | "ide" | "local")
    ) {
        return Err(AntigravityFailure::BridgeResponseInvalid);
    }
    let usage = payload
        .get("usage")
        .and_then(Value::as_object)
        .ok_or(AntigravityFailure::BridgeResponseInvalid)?;
    let observed_at = usage
        .get("updatedAt")
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
        .ok_or(AntigravityFailure::BridgeResponseInvalid)?;
    let future_limit = fetched_at
        .checked_add_signed(chrono::Duration::seconds(MAX_FUTURE_CLOCK_SKEW_SECONDS))
        .ok_or(AntigravityFailure::BridgeResponseInvalid)?;
    if observed_at > future_limit
        || fetched_at.signed_duration_since(observed_at).num_seconds()
            > LAST_GOOD_RETENTION.as_secs() as i64
    {
        return Err(AntigravityFailure::BridgeResponseInvalid);
    }

    let mut windows = Vec::new();
    if let Some(extra) = usage.get("extraRateWindows").and_then(Value::as_array) {
        if extra.len() > LOCAL_MAX_WINDOWS {
            return Err(AntigravityFailure::BridgeResponseInvalid);
        }
        for (index, item) in extra.iter().enumerate() {
            let value = item.get("window").unwrap_or(item);
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .and_then(sanitize_codexbar_identifier)
                .unwrap_or_else(|| format!("extra-{index}"));
            let label = item
                .get("title")
                .and_then(Value::as_str)
                .and_then(sanitize_codexbar_label)
                .unwrap_or_else(|| format!("Antigravity quota {}", index + 1));
            windows.push(normalize_bridge_window(
                format!("codexbar-{id}"),
                label,
                value,
                observed_at,
                fetched_at,
            )?);
        }
    }
    if windows.is_empty() {
        for (key, label, minutes) in [
            ("primary", "Gemini", Some(300)),
            ("secondary", "Claude/GPT", Some(300)),
            ("tertiary", "Additional quota", None),
        ] {
            if let Some(value) = usage.get(key).filter(|value| !value.is_null()) {
                windows.push(normalize_bridge_window_with_minutes(
                    format!("codexbar-{key}"),
                    label.to_string(),
                    value,
                    minutes,
                    observed_at,
                    fetched_at,
                )?);
            }
        }
    }
    let mut ids = HashSet::new();
    if windows.is_empty()
        || windows.len() > LOCAL_MAX_WINDOWS
        || windows
            .iter()
            .any(|window| !ids.insert(window.window_id.clone()))
    {
        return Err(AntigravityFailure::BridgeResponseInvalid);
    }
    build_envelope(windows)
}

fn normalize_bridge_window(
    id: String,
    label: String,
    value: &Value,
    observed_at: DateTime<Utc>,
    fetched_at: DateTime<Utc>,
) -> Result<QuotaWindowSnapshot, AntigravityFailure> {
    let minutes = value
        .get("windowMinutes")
        .and_then(Value::as_u64)
        .filter(|minutes| (1..=CODEX_MAX_WINDOW_MINUTES).contains(minutes));
    normalize_bridge_window_with_minutes(id, label, value, minutes, observed_at, fetched_at)
}

fn normalize_bridge_window_with_minutes(
    id: String,
    label: String,
    value: &Value,
    window_minutes: Option<u64>,
    observed_at: DateTime<Utc>,
    fetched_at: DateTime<Utc>,
) -> Result<QuotaWindowSnapshot, AntigravityFailure> {
    let used = value
        .get("usedPercent")
        .and_then(Value::as_f64)
        .filter(|used| used.is_finite() && (0.0..=100.0).contains(used))
        .ok_or(AntigravityFailure::BridgeResponseInvalid)?;
    let resets_at = match value.get("resetsAt") {
        Some(Value::String(raw)) => {
            let value = DateTime::parse_from_rfc3339(raw)
                .map_err(|_| AntigravityFailure::BridgeResponseInvalid)?
                .with_timezone(&Utc);
            if !valid_codex_reset_time(value, observed_at) {
                return Err(AntigravityFailure::BridgeResponseInvalid);
            }
            Some(value)
        }
        Some(Value::Null) | None => None,
        _ => return Err(AntigravityFailure::BridgeResponseInvalid),
    };
    let stale_observation =
        fetched_at.signed_duration_since(observed_at).num_seconds() > STALE_AFTER_SECONDS;
    let reset_elapsed = resets_at.is_some_and(|value| value <= fetched_at);
    let stale = stale_observation || reset_elapsed;
    Ok(QuotaWindowSnapshot {
        provider_id: ANTIGRAVITY_PROVIDER_ID.to_string(),
        window_id: id,
        window_label: label,
        account_label: None,
        scope: QuotaScope::ConsumerSubscription,
        source: QuotaSource::LocalAuthorized,
        status: if stale {
            QuotaWindowStatus::Stale
        } else {
            QuotaWindowStatus::Ok
        },
        used: Some(used),
        limit: Some(100.0),
        remaining: Some(100.0 - used),
        unit: QuotaUnit::Percent,
        currency: None,
        window_minutes,
        resets_at: resets_at.map(format_timestamp),
        observed_at: format_timestamp(observed_at),
        fetched_at: format_timestamp(fetched_at),
        stale_after_seconds: STALE_AFTER_SECONDS as u64,
        reason_code: stale.then(|| {
            if stale_observation {
                "observation_stale".to_string()
            } else {
                "reset_elapsed".to_string()
            }
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;

    #[cfg(not(windows))]
    #[test]
    fn parses_unix_process_and_requires_app_csrf() {
        let output = r#"
          10 /Applications/Antigravity.app/Contents/Resources/bin/language_server --app_data_dir antigravity --csrf_token secret
          11 /Applications/Antigravity.app/Contents/Resources/bin/language_server --app_data_dir antigravity
          12 /Users/test/.local/bin/agy
        "#;
        let processes = parse_process_list(output).expect("process list");
        assert_eq!(processes.len(), 2);
        assert_eq!(processes[0].pid, 10);
        assert_eq!(processes[0].csrf_token.as_deref(), Some("secret"));
        assert_eq!(processes[1].kind, ProcessKind::Cli);
    }

    #[test]
    fn recognizes_quoted_windows_cli_path_without_using_a_shell_wrapper() {
        let process =
            process_from_command(13, r#""C:\Program Files\Antigravity\agy.exe" --foreground"#)
                .expect("quoted agy path");
        assert_eq!(process.kind, ProcessKind::Cli);
    }

    #[test]
    fn parses_lsof_ports_without_unrelated_sockets() {
        let output = "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nlanguage_ 42 user 6u IPv4 0 0t0 TCP 127.0.0.1:60534 (LISTEN)\nlanguage_ 42 user 7u IPv4 0 0t0 TCP 127.0.0.1:60535 (LISTEN)\n";
        assert_eq!(parse_lsof_ports(output).expect("ports"), vec![60534, 60535]);
    }

    #[test]
    fn parses_quota_summary_into_four_windows_without_identity() {
        let now = DateTime::parse_from_rfc3339("2026-07-17T15:00:43Z")
            .expect("time")
            .with_timezone(&Utc);
        let value = json!({
            "code": 0,
            "response": {
                "groups": [
                    {
                        "displayName": "Gemini Models",
                        "buckets": [
                            {"bucketId": "gemini-session", "displayName": "Session", "remaining": {"remainingFraction": 0.91}, "resetTime": "2026-07-17T19:46:51Z"},
                            {"bucketId": "gemini-weekly", "displayName": "Weekly", "remainingFraction": 0.92, "resetTime": "2026-07-21T09:47:39Z"}
                        ]
                    },
                    {
                        "displayName": "Claude and GPT models",
                        "buckets": [
                            {"bucketId": "claude-session", "displayName": "5-hour", "remainingFraction": 1.0},
                            {"bucketId": "claude-weekly", "displayName": "Weekly", "remainingFraction": 1.0}
                        ]
                    }
                ]
            }
        });
        let envelope = parse_quota_summary(&value, now).expect("summary");
        assert_eq!(envelope.provider_id, ANTIGRAVITY_PROVIDER_ID);
        assert_eq!(envelope.windows.len(), 4);
        assert_eq!(envelope.windows[0].window_minutes, Some(300));
        assert_eq!(envelope.windows[1].window_minutes, Some(10080));
        assert!(envelope
            .windows
            .iter()
            .all(|window| window.account_label.is_none()));
    }

    #[test]
    fn codexbar_parser_prefers_extra_windows_over_duplicate_primary() {
        let now = DateTime::parse_from_rfc3339("2026-07-17T15:00:43Z")
            .expect("time")
            .with_timezone(&Utc);
        let payload = json!({
            "provider": "antigravity",
            "source": "app",
            "usage": {
                "updatedAt": "2026-07-17T15:00:43Z",
                "primary": {"usedPercent": 8.8, "windowMinutes": 300},
                "extraRateWindows": [
                    {"id": "gemini-session", "title": "Gemini 5-hour", "window": {"usedPercent": 8.8, "windowMinutes": 300}},
                    {"id": "gemini-weekly", "title": "Gemini weekly", "window": {"usedPercent": 7.7, "windowMinutes": 10080}}
                ]
            }
        });
        let envelope = parse_codexbar_output(payload.to_string().as_bytes(), now).expect("bridge");
        assert_eq!(envelope.windows.len(), 2);
        assert!(envelope
            .windows
            .iter()
            .all(|window| window.window_id.starts_with("codexbar-")));
    }

    #[test]
    fn rejects_non_local_codexbar_source() {
        let now = Utc::now();
        let payload = json!({
            "provider": "antigravity",
            "source": "oauth",
            "usage": {"updatedAt": format_timestamp(now), "primary": {"usedPercent": 1.0}}
        });
        assert_eq!(
            parse_codexbar_output(payload.to_string().as_bytes(), now),
            Err(AntigravityFailure::BridgeResponseInvalid)
        );
    }

    #[test]
    fn loopback_client_does_not_contact_redirect_destination() {
        let destination = TcpListener::bind("127.0.0.1:0").expect("redirect target");
        destination
            .set_nonblocking(true)
            .expect("nonblocking target");
        let destination_port = destination.local_addr().unwrap().port();
        let source = TcpListener::bind("127.0.0.1:0").expect("fixture source");
        let source_port = source.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = source.accept().expect("source request");
            let mut request = [0_u8; 2048];
            stream.read(&mut request).expect("read source request");
            write!(
                stream,
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{destination_port}/redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .expect("redirect response");
        });
        let endpoint = LocalEndpoint {
            scheme: "http",
            port: source_port,
            csrf_token: None,
        };
        let client = build_local_client().expect("local client");
        let result = tauri::async_runtime::block_on(post_local_json(
            &client,
            &endpoint,
            QUOTA_SUMMARY_PATH,
            &json!({}),
        ));
        server.join().expect("fixture server");
        assert!(
            matches!(destination.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
        assert_eq!(result, Err(AntigravityFailure::ResponseInvalid));
    }

    #[test]
    #[ignore = "requires a signed-in, running Antigravity local service"]
    fn live_native_probe_reads_local_windows_without_codexbar() {
        let envelope = tauri::async_runtime::block_on(fetch_native_envelope(Utc::now()))
            .expect("native Antigravity probe");
        assert_eq!(envelope.provider_id, ANTIGRAVITY_PROVIDER_ID);
        assert_eq!(envelope.status, QuotaStatus::Ok);
        assert!(envelope.windows.len() >= 2);
        assert!(envelope.windows.iter().all(|window| {
            window.source == QuotaSource::LocalAuthorized && window.account_label.is_none()
        }));
    }

    #[test]
    #[ignore = "requires an installed, signed-in agy CLI"]
    fn live_spawned_agy_probe_reads_rpc_and_reaps_its_process() {
        let fetched_at = Utc::now();
        let deadline = Instant::now() + LOCAL_TOTAL_TIMEOUT;
        let client = build_local_client().expect("loopback client");
        let envelope =
            tauri::async_runtime::block_on(fetch_from_spawned_agy(&client, fetched_at, deadline))
                .expect("spawned agy probe");
        assert_eq!(envelope.provider_id, ANTIGRAVITY_PROVIDER_ID);
        assert_eq!(envelope.status, QuotaStatus::Ok);
        assert!(envelope.windows.len() >= 2);
    }
}
