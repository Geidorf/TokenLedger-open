//! Local model gateway (T10.263): one OpenAI-compatible endpoint on
//! 127.0.0.1 that routes `provider_id/model` to the configured upstream,
//! converts Responses requests for Chat-only providers, and keeps a usage
//! ledger. Agents only ever see the local token, never a provider key.

mod agent_config;
mod agents;
mod anthropic;
mod codex_config;
mod convert;
mod gemini;
mod ledger;
mod legacy_restore;
mod policy;
mod routing;
mod server;
mod store;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};

pub use agent_config::{AgentApplyResult, AgentInspection, AgentPreview, AgentRestoreResult};
use agent_config::{AgentConfig, AgentTarget};
use codex_config::CodexTarget;
pub(crate) use codex_config::{atomic_write, line_diff, version};
pub use codex_config::{
    CodexApplyResult, CodexConfig, CodexInspection, CodexPreview, CodexRestoreResult,
};
pub(crate) use ledger::accounting;
use ledger::Ledger;
pub use ledger::LedgerRecord;
use routing::Router;
#[cfg(test)]
pub(crate) use routing::{MemberTrace, RouteAttempt as RouteDecisionAttempt};
pub use routing::{CoolingMember, RouteDecision, RoutingGroup};
#[cfg(test)]
pub use store::MemorySecrets;
use store::{ensure_local_token, provider_account, ProviderStore};
pub(crate) use store::{load_providers_readonly, read_provider_key};
pub use store::{
    valid_id, validate_provider, AuthMode, KeyringSecrets, ProviderRecord, SecretStore, WireApi,
};

pub const DEFAULT_PORT: u16 = 3462;
const MAX_KEY_LENGTH: usize = 4096;

pub struct Shared {
    providers: RwLock<Vec<ProviderRecord>>,
    secrets: Arc<dyn SecretStore>,
    ledger: Ledger,
    router: Router,
}

enum RunState {
    Stopped,
    Running { port: u16, token_hint: String },
    Failed(String),
}

struct ListenerRun {
    task: tauri::async_runtime::JoinHandle<()>,
    gate: Arc<AtomicBool>,
    listener: Arc<server::ListenerOwner>,
}

pub struct Gateway {
    shared: Arc<Shared>,
    dir: PathBuf,
    store: ProviderStore,
    port: u16,
    state: Mutex<RunState>,
    load_error: Option<String>,
    /// 模型接入总开关（U-112）；为假时不监听。启动时由 lib.rs 按设置写入。
    enabled: AtomicBool,
    /// Taken and aborted under the `state` lock.
    listener: Mutex<Option<ListenerRun>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub running: bool,
    pub port: u16,
    pub base_url: Option<String>,
    pub token_hint: Option<String>,
    pub error: Option<String>,
    pub provider_count: usize,
    pub enabled_count: usize,
}

/// Read-only routing view for the live routing stage in the widget windows.
/// Carries only what the stage draws: no session ids, error bodies, decision
/// details, token counts or endpoints.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingFeed {
    pub running: bool,
    pub decisions: Vec<RoutingFeedDecision>,
    pub requests: Vec<RoutingFeedRequest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingFeedDecision {
    pub ts: String,
    pub request_id: String,
    pub group: String,
    pub chosen: Option<String>,
    pub attempts: Vec<RoutingFeedAttempt>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingFeedAttempt {
    pub member: String,
    pub outcome: &'static str,
    pub status: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingFeedRequest {
    pub ts: String,
    pub request_id: String,
    pub logical_request_id: Option<String>,
    pub agent: Option<String>,
    pub provider: String,
    pub requested_model: String,
    pub upstream_model: String,
    pub group: Option<String>,
    pub status: u16,
    pub ok: bool,
}

impl From<RouteDecision> for RoutingFeedDecision {
    fn from(decision: RouteDecision) -> Self {
        Self {
            ts: decision.ts,
            request_id: decision.request_id,
            group: decision.group,
            chosen: decision.chosen,
            attempts: decision
                .attempts
                .into_iter()
                .map(|attempt| RoutingFeedAttempt {
                    member: attempt.member,
                    outcome: attempt.outcome,
                    status: attempt.status,
                })
                .collect(),
        }
    }
}

impl From<LedgerRecord> for RoutingFeedRequest {
    fn from(record: LedgerRecord) -> Self {
        Self {
            ts: record.ts,
            request_id: record.request_id,
            logical_request_id: record.logical_request_id,
            agent: record.agent,
            provider: record.provider,
            requested_model: record.requested_model,
            upstream_model: record.upstream_model,
            group: record.group,
            status: record.status,
            ok: record.ok,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    #[serde(flatten)]
    pub record: ProviderRecord,
    pub has_key: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProviderKeyInput {
    pub id: String,
    pub key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexApplyInput {
    pub model: String,
    /// `beforeVersion` from the preview; a mismatch means the file changed.
    pub expected_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApplyInput {
    pub agent: String,
    pub model: String,
    /// `beforeVersion` from the preview; a mismatch means a file changed.
    pub expected_version: Option<String>,
}

impl Gateway {
    pub fn new(dir: &Path, secrets: Arc<dyn SecretStore>, port: u16) -> Self {
        let store = ProviderStore::new(dir);
        let (providers, load_error) = match store.load() {
            Ok(providers) => (providers, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        let router = Router::new(dir);
        let load_error = load_error.or_else(|| router.load_error.clone());
        Self {
            shared: Arc::new(Shared {
                providers: RwLock::new(providers),
                secrets,
                ledger: Ledger::new(dir),
                router,
            }),
            dir: dir.to_path_buf(),
            store,
            port,
            state: Mutex::new(RunState::Stopped),
            load_error,
            enabled: AtomicBool::new(true),
            listener: Mutex::new(None),
        }
    }

    /// Turning the switch off stops listening at once; turning it on starts
    /// under the usual rule (at least one enabled provider).
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        if enabled {
            self.start_if_needed();
        } else {
            self.stop();
        }
    }

    fn stop(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(run) = self
            .listener
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            run.gate.store(false, Ordering::SeqCst);
            run.listener.close();
            run.task.abort();
        }
        *state = RunState::Stopped;
    }

    /// 升级迁移用（U-112）：有启用的供应商，或 Codex / 任一 Agent 留有未恢复的网关
    /// 备份清单。只看本应用的数据目录，不读 Agent 自己的配置文件。
    pub fn was_in_use(&self) -> bool {
        let manifest = "manifest.json";
        self.providers().iter().any(|provider| provider.enabled)
            || self.dir.join("codex-backup-v1").join(manifest).is_file()
            || std::fs::read_dir(self.dir.join("agent-backup-v1")).is_ok_and(|entries| {
                entries
                    .flatten()
                    .any(|entry| entry.path().join(manifest).is_file())
            })
    }

    fn providers(&self) -> Vec<ProviderRecord> {
        self.shared
            .providers
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Recover only application-owned pending journals. With no journal this
    /// never discovers or opens an Agent's configuration.
    pub fn recover_pending_configs(&self) -> Result<(), String> {
        use agent_config::transaction;
        if transaction::pending(&self.dir.join("codex-backup-v1"))? {
            CodexConfig::discover(&self.dir)?.recover_pending()?;
        }
        for agent in [
            "opencode",
            "crush",
            "gemini-cli",
            "pi",
            "kimi-cli",
            "hermes",
            "goose",
            "omp",
            "zed",
            "claude-code",
            "oh-my-opencode",
            "minimax-code",
        ] {
            if transaction::pending(&self.dir.join("agent-backup-v1").join(agent))? {
                self.agent_config(agent)?.recover_pending()?;
            }
        }
        Ok(())
    }

    /// Starts listening once at least one provider is enabled; a no-op when
    /// already running or when model access is switched off.
    pub fn start_if_needed(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !self.enabled.load(Ordering::SeqCst)
            || matches!(*state, RunState::Running { .. })
            || !self.providers().iter().any(|provider| provider.enabled)
        {
            return;
        }
        if let Err(error) = self.recover_pending_configs() {
            *state = RunState::Failed(format!("未完成的配置事务需要处理：{error}"));
            return;
        }
        let token = match ensure_local_token(self.shared.secrets.as_ref()) {
            Ok(token) => token,
            Err(error) => {
                *state = RunState::Failed(error);
                return;
            }
        };
        let listener = match std::net::TcpListener::bind(("127.0.0.1", self.port))
            .and_then(|listener| listener.set_nonblocking(true).map(|_| listener))
        {
            Ok(listener) => listener,
            Err(error) => {
                *state = RunState::Failed(format!("无法监听 127.0.0.1:{}：{error}", self.port));
                return;
            }
        };
        let port = listener
            .local_addr()
            .map(|addr| addr.port())
            .unwrap_or(self.port);
        let shared = self.shared.clone();
        let token_hint = format!("tl-…{}", &token[token.len() - 4..]);
        let token: Arc<str> = Arc::from(token);
        let gate = Arc::new(AtomicBool::new(true));
        let serving_gate = gate.clone();
        let listener = Arc::new(server::ListenerOwner::from_std(listener));
        let serving_listener = listener.clone();
        let task = tauri::async_runtime::spawn(async move {
            server::serve_owned(serving_listener, shared, token, serving_gate).await;
        });
        *self
            .listener
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(ListenerRun {
            task,
            gate,
            listener,
        });
        *state = RunState::Running { port, token_hint };
    }

    pub fn status(&self) -> GatewayStatus {
        let providers = self.providers();
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (running, port, token_hint, error) = match &*state {
            RunState::Running { port, token_hint } => (true, *port, Some(token_hint.clone()), None),
            RunState::Failed(error) => (false, self.port, None, Some(error.clone())),
            RunState::Stopped => (false, self.port, None, self.load_error.clone()),
        };
        GatewayStatus {
            running,
            port,
            base_url: running.then(|| format!("http://127.0.0.1:{port}/v1")),
            token_hint,
            error,
            provider_count: providers.len(),
            enabled_count: providers.iter().filter(|provider| provider.enabled).count(),
        }
    }

    pub fn list_providers(&self) -> Result<Vec<ProviderView>, String> {
        self.providers()
            .into_iter()
            .map(|record| {
                let has_key = self
                    .shared
                    .secrets
                    .get(&provider_account(&record.id))?
                    .is_some();
                Ok(ProviderView { record, has_key })
            })
            .collect()
    }

    pub fn upsert_provider(&self, record: ProviderRecord) -> Result<Vec<ProviderView>, String> {
        {
            let mut providers = self
                .shared
                .providers
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut next = providers.clone();
            store::upsert(&mut next, record)?;
            self.store.save(&next)?;
            *providers = next;
        }
        self.start_if_needed();
        self.list_providers()
    }

    pub fn set_provider_key(&self, input: SetProviderKeyInput) -> Result<(), String> {
        if !self
            .providers()
            .iter()
            .any(|provider| provider.id == input.id)
        {
            return Err("找不到这个供应商。".to_string());
        }
        let key = input.key.trim();
        let account = provider_account(&input.id);
        if key.is_empty() {
            return self.shared.secrets.delete(&account);
        }
        if key.len() > MAX_KEY_LENGTH
            || key
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
        {
            return Err("API key 格式无效。".to_string());
        }
        self.shared.secrets.set(&account, key)
    }

    pub fn delete_provider(&self, id: &str) -> Result<Vec<ProviderView>, String> {
        {
            let mut providers = self
                .shared
                .providers
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let next: Vec<ProviderRecord> = providers
                .iter()
                .filter(|provider| provider.id != id)
                .cloned()
                .collect();
            if next.len() == providers.len() {
                return Err("找不到这个供应商。".to_string());
            }
            self.store.save(&next)?;
            *providers = next;
        }
        self.shared.secrets.delete(&provider_account(id))?;
        self.list_providers()
    }

    pub fn recent_requests(&self, limit: usize) -> Result<Vec<LedgerRecord>, String> {
        self.shared.ledger.recent(limit.clamp(1, 500))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn local_base_url(&self) -> String {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let port = match &*state {
            RunState::Running { port, .. } => *port,
            _ => self.port,
        };
        format!("http://127.0.0.1:{port}/v1")
    }

    /// For writing Agent configs and the main-window-only reveal command.
    fn local_token(&self) -> Result<String, String> {
        ensure_local_token(self.shared.secrets.as_ref())
    }

    /// Errors when the model cannot be served; returns soft warnings otherwise.
    fn check_agent_model(&self, model: &str) -> Result<Vec<String>, String> {
        if let Some(group_id) = model.strip_prefix(routing::GROUP_PREFIX) {
            return match self.shared.router.enabled_group(group_id) {
                Some(_) => Ok(Vec::new()),
                None => Err(format!("没有启用的路由组「{group_id}」。")),
            };
        }
        let (provider_id, upstream_model) = model
            .split_once('/')
            .filter(|(id, rest)| !id.is_empty() && !rest.is_empty())
            .ok_or_else(|| format!("模型名「{model}」需要写成 供应商ID/模型。"))?;
        if model.len() > 160 || model.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(format!("模型名「{model}」无效。"));
        }
        let providers = self.providers();
        let provider = providers
            .iter()
            .find(|provider| provider.id == provider_id && provider.enabled)
            .ok_or_else(|| format!("没有启用的供应商「{provider_id}」。"))?;
        let mut warnings = Vec::new();
        if !provider.models.is_empty() && !provider.models.iter().any(|m| m == upstream_model) {
            warnings.push(format!(
                "供应商「{}」的模型列表里没有「{upstream_model}」，请确认上游支持它。",
                provider.name
            ));
        }
        Ok(warnings)
    }

    /// Refuses a direct model whose provider cannot speak the Agent's protocol;
    /// group members are checked per request instead.
    fn check_agent_wire(&self, agent: &str, model: &str) -> Result<(), String> {
        if model.starts_with(routing::GROUP_PREFIX) {
            return Ok(());
        }
        let Some((provider_id, _)) = model.split_once('/') else {
            return Ok(());
        };
        let Some(provider) = self
            .providers()
            .into_iter()
            .find(|provider| provider.id == provider_id)
        else {
            return Ok(());
        };
        match (agent == "claude-code", provider.wire) {
            (true, WireApi::Responses) => Err(format!(
                "Claude Code 走 Anthropic 接口，供应商「{}」只提供 Responses，请改选 Chat 或 Anthropic 协议的供应商。",
                provider.name
            )),
            (false, WireApi::Anthropic) => Err(format!(
                "供应商「{}」只提供 Anthropic 接口，目前只能给 Claude Code 使用。",
                provider.name
            )),
            _ => Ok(()),
        }
    }

    pub fn codex_inspect(&self, codex: &CodexConfig) -> Result<CodexInspection, String> {
        codex.inspect(&self.local_base_url())
    }

    pub fn codex_preview(&self, codex: &CodexConfig, model: &str) -> Result<CodexPreview, String> {
        let warnings = self.check_agent_model(model)?;
        self.check_agent_wire("codex", model)?;
        let token = self.local_token()?;
        let base_url = self.local_base_url();
        let mut preview = codex.preview(&CodexTarget {
            base_url: &base_url,
            token: &token,
            model,
        })?;
        preview.warnings.extend(warnings);
        Ok(preview)
    }

    pub fn codex_apply(
        &self,
        codex: &CodexConfig,
        input: CodexApplyInput,
    ) -> Result<CodexApplyResult, String> {
        self.check_agent_model(&input.model)?;
        self.check_agent_wire("codex", &input.model)?;
        let token = self.local_token()?;
        let base_url = self.local_base_url();
        let result = codex.apply(
            &CodexTarget {
                base_url: &base_url,
                token: &token,
                model: &input.model,
            },
            input.expected_version.as_deref(),
        )?;
        self.start_if_needed();
        Ok(result)
    }

    pub fn codex_restore(
        &self,
        codex: &CodexConfig,
        force: bool,
    ) -> Result<CodexRestoreResult, String> {
        codex.restore(force)
    }

    fn agent_config(&self, agent: &str) -> Result<AgentConfig, String> {
        agents::discover(agent, &self.dir)
    }

    pub fn agent_inspect(&self, agent: &str) -> Result<AgentInspection, String> {
        self.agent_config(agent)?.inspect(&self.local_base_url())
    }

    pub fn agent_preview(&self, agent: &str, model: &str) -> Result<AgentPreview, String> {
        let config = self.agent_config(agent)?;
        let warnings = self.check_agent_model(model)?;
        self.check_agent_wire(agent, model)?;
        let token = self.local_token()?;
        let base_url = self.local_base_url();
        let mut preview = config.preview(&AgentTarget {
            base_url: &base_url,
            token: &token,
            model,
        })?;
        preview.warnings.extend(warnings);
        Ok(preview)
    }

    pub fn agent_apply(&self, input: AgentApplyInput) -> Result<AgentApplyResult, String> {
        let config = self.agent_config(&input.agent)?;
        self.check_agent_model(&input.model)?;
        self.check_agent_wire(&input.agent, &input.model)?;
        let token = self.local_token()?;
        let base_url = self.local_base_url();
        let result = config.apply(
            &AgentTarget {
                base_url: &base_url,
                token: &token,
                model: &input.model,
            },
            input.expected_version.as_deref(),
        )?;
        self.start_if_needed();
        Ok(result)
    }

    pub fn agent_restore(&self, agent: &str, force: bool) -> Result<AgentRestoreResult, String> {
        self.agent_config(agent)?.restore(force)
    }

    pub fn list_routing_groups(&self) -> Vec<RoutingGroup> {
        self.shared.router.groups()
    }

    pub fn upsert_routing_group(&self, group: RoutingGroup) -> Result<Vec<RoutingGroup>, String> {
        let provider_ids: Vec<String> = self.providers().into_iter().map(|p| p.id).collect();
        self.shared.router.upsert(group, &provider_ids)
    }

    pub fn delete_routing_group(&self, id: &str) -> Result<Vec<RoutingGroup>, String> {
        self.shared.router.delete(id)
    }

    pub fn routing_cooldowns(&self) -> Vec<CoolingMember> {
        self.shared.router.cooling()
    }

    pub fn recent_route_decisions(&self, limit: usize) -> Vec<RouteDecision> {
        self.shared.router.recent(limit.clamp(1, 200))
    }

    /// The live routing stage's view: recent decisions plus the ledger's tail
    /// (agent names and direct requests). Nothing is read while stopped.
    pub fn routing_feed(&self, limit: usize) -> Result<RoutingFeed, String> {
        let limit = limit.clamp(1, 100);
        if !self.status().running {
            return Ok(RoutingFeed {
                running: false,
                decisions: Vec::new(),
                requests: Vec::new(),
            });
        }
        let decisions = self.recent_route_decisions(limit);
        let requests = self.shared.ledger.recent_tail(limit)?;
        Ok(RoutingFeed {
            running: true,
            decisions: decisions.into_iter().map(Into::into).collect(),
            requests: requests.into_iter().map(Into::into).collect(),
        })
    }
}

fn ensure_main_label(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("网关设置只允许主窗口调用。".to_string())
    }
}

fn ensure_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    ensure_main_label(window.label())
}

/// The routing feed is the one gateway read the widget windows may make.
fn ensure_routing_feed_label(label: &str) -> Result<(), String> {
    match label {
        "main"
        | crate::widget_window::WIDGET_LABEL
        | crate::widget_window::DESKTOP_WIDGET_LABEL => Ok(()),
        _ => Err("实时路由只允许主窗口与挂件读取。".to_string()),
    }
}

/// The full local token, only for an explicit 「复制」 click in the main
/// window. Never logged or cached; every other command returns the tail only.
fn reveal_local_token(label: &str, gateway: &Gateway) -> Result<String, String> {
    ensure_main_label(label)?;
    gateway.local_token()
}

#[tauri::command]
pub fn gateway_reveal_local_token(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
) -> Result<String, String> {
    reveal_local_token(window.label(), &gateway)
}

/// 模型接入总开关（U-112）：先落盘，再按新值启停网关。不改任何 Agent 配置。
#[tauri::command]
pub fn gateway_set_model_access(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<crate::app_paths::AppContext>>,
    settings_state: tauri::State<'_, Arc<Mutex<crate::settings::AppSettings>>>,
    gateway: tauri::State<'_, Arc<Gateway>>,
    enabled: bool,
) -> Result<crate::settings::AppSettings, String> {
    ensure_main(&window)?;
    let settings = crate::settings::update_model_access_enabled(&app, enabled)?;
    settings_state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .model_access_enabled = settings.model_access_enabled;
    gateway.set_enabled(settings.model_access_enabled);
    Ok(settings)
}

#[tauri::command]
pub fn gateway_status(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
) -> Result<GatewayStatus, String> {
    ensure_main(&window)?;
    Ok(gateway.status())
}

#[tauri::command]
pub fn gateway_list_providers(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
) -> Result<Vec<ProviderView>, String> {
    ensure_main(&window)?;
    gateway.list_providers()
}

#[tauri::command]
pub fn gateway_upsert_provider(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    provider: ProviderRecord,
) -> Result<Vec<ProviderView>, String> {
    ensure_main(&window)?;
    gateway.upsert_provider(provider)
}

#[tauri::command]
pub fn gateway_set_provider_key(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    input: SetProviderKeyInput,
) -> Result<(), String> {
    ensure_main(&window)?;
    gateway.set_provider_key(input)
}

#[tauri::command]
pub fn gateway_delete_provider(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    id: String,
) -> Result<Vec<ProviderView>, String> {
    ensure_main(&window)?;
    gateway.delete_provider(&id)
}

#[tauri::command]
pub fn gateway_recent_requests(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    limit: Option<usize>,
) -> Result<Vec<LedgerRecord>, String> {
    ensure_main(&window)?;
    gateway.recent_requests(limit.unwrap_or(100))
}

#[tauri::command]
pub fn gateway_codex_inspect(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
) -> Result<CodexInspection, String> {
    ensure_main(&window)?;
    gateway.codex_inspect(&CodexConfig::discover(gateway.dir())?)
}

#[tauri::command]
pub fn gateway_legacy_inspect(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<crate::app_paths::AppContext>>,
) -> Result<legacy_restore::Inspection, String> {
    ensure_main(&window)?;
    legacy_restore::LegacyRestore::discover(app.app_data_dir())?.inspect()
}

#[tauri::command]
pub fn gateway_legacy_restore(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<crate::app_paths::AppContext>>,
    input: legacy_restore::RestoreInput,
) -> Result<legacy_restore::Inspection, String> {
    ensure_main(&window)?;
    legacy_restore::LegacyRestore::discover(app.app_data_dir())?.restore(input)
}

#[tauri::command]
pub fn gateway_codex_preview(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    model: String,
) -> Result<CodexPreview, String> {
    ensure_main(&window)?;
    gateway.codex_preview(&CodexConfig::discover(gateway.dir())?, &model)
}

#[tauri::command]
pub fn gateway_codex_apply(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    input: CodexApplyInput,
) -> Result<CodexApplyResult, String> {
    ensure_main(&window)?;
    gateway.codex_apply(&CodexConfig::discover(gateway.dir())?, input)
}

#[tauri::command]
pub fn gateway_codex_restore(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    force: Option<bool>,
) -> Result<CodexRestoreResult, String> {
    ensure_main(&window)?;
    gateway.codex_restore(
        &CodexConfig::discover(gateway.dir())?,
        force.unwrap_or(false),
    )
}

#[tauri::command]
pub fn gateway_agent_inspect(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    agent: String,
) -> Result<AgentInspection, String> {
    ensure_main(&window)?;
    gateway.agent_inspect(&agent)
}

#[tauri::command]
pub fn gateway_agent_preview(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    agent: String,
    model: String,
) -> Result<AgentPreview, String> {
    ensure_main(&window)?;
    gateway.agent_preview(&agent, &model)
}

#[tauri::command]
pub fn gateway_agent_apply(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    input: AgentApplyInput,
) -> Result<AgentApplyResult, String> {
    ensure_main(&window)?;
    gateway.agent_apply(input)
}

#[tauri::command]
pub fn gateway_agent_restore(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    agent: String,
    force: Option<bool>,
) -> Result<AgentRestoreResult, String> {
    ensure_main(&window)?;
    gateway.agent_restore(&agent, force.unwrap_or(false))
}

#[tauri::command]
pub fn gateway_list_routing_groups(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
) -> Result<Vec<RoutingGroup>, String> {
    ensure_main(&window)?;
    Ok(gateway.list_routing_groups())
}

#[tauri::command]
pub fn gateway_upsert_routing_group(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    group: RoutingGroup,
) -> Result<Vec<RoutingGroup>, String> {
    ensure_main(&window)?;
    gateway.upsert_routing_group(group)
}

#[tauri::command]
pub fn gateway_delete_routing_group(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    id: String,
) -> Result<Vec<RoutingGroup>, String> {
    ensure_main(&window)?;
    gateway.delete_routing_group(&id)
}

#[tauri::command]
pub fn gateway_recent_route_decisions(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    limit: Option<usize>,
) -> Result<Vec<RouteDecision>, String> {
    ensure_main(&window)?;
    Ok(gateway.recent_route_decisions(limit.unwrap_or(50)))
}

/// Group members currently cooling down after failures; main window only.
#[tauri::command]
pub fn gateway_routing_cooldowns(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
) -> Result<Vec<CoolingMember>, String> {
    ensure_main(&window)?;
    Ok(gateway.routing_cooldowns())
}

/// Redacted live routing view for the main window and both widget windows.
#[tauri::command]
pub fn gateway_routing_feed(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    limit: Option<usize>,
) -> Result<RoutingFeed, String> {
    ensure_routing_feed_label(window.label())?;
    gateway.routing_feed(limit.unwrap_or(30))
}

/// The external local gateway's live state for the same windows as the
/// routing feed. Fixed to its default port so a widget can't probe other
/// loopback ports; the snapshot already carries no session, error text or key.
#[tauri::command]
pub async fn gateway_external_feed(
    window: tauri::WebviewWindow,
) -> Result<crate::peer_live::LiveSnapshot, String> {
    ensure_routing_feed_label(window.label())?;
    crate::peer_live::read_snapshot(crate::peer_live::DEFAULT_PORT).await
}

#[cfg(test)]
mod tests {
    use super::store::{MemorySecrets, WireApi, LOCAL_TOKEN_ACCOUNT};
    use super::*;
    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper::service::service_fn;
    use serde_json::{json, Value};
    use std::convert::Infallible;

    #[derive(Default)]
    struct Seen {
        body: Mutex<Option<Value>>,
        auth: Mutex<Option<String>>,
        api_key: Mutex<Option<String>>,
        anthropic_version: Mutex<Option<String>>,
    }

    async fn spawn_upstream(seen: Arc<Seen>) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let seen = seen.clone();
                tokio::spawn(async move {
                    let service = service_fn(
                        move |request: hyper::Request<hyper::body::Incoming>| {
                            let seen = seen.clone();
                            async move {
                                let path = request.uri().path().to_string();
                                *seen.auth.lock().unwrap() = request
                                    .headers()
                                    .get("authorization")
                                    .and_then(|value| value.to_str().ok())
                                    .map(str::to_string);
                                let header = |name: &str| {
                                    request
                                        .headers()
                                        .get(name)
                                        .and_then(|value| value.to_str().ok())
                                        .map(str::to_string)
                                };
                                *seen.api_key.lock().unwrap() = header("x-api-key");
                                *seen.anthropic_version.lock().unwrap() =
                                    header("anthropic-version");
                                let body = request.into_body().collect().await.unwrap().to_bytes();
                                let body: Value = serde_json::from_slice(&body).unwrap();
                                let stream = body["stream"] == true;
                                *seen.body.lock().unwrap() = Some(body);
                                let reply = match (path.as_str(), stream) {
                                ("/v1/responses", _) => json!({"id": "resp_up", "object": "response", "status": "completed", "output": [],
                                    "usage": {"input_tokens": 30, "output_tokens": 3, "input_tokens_details": {"cached_tokens": 20}}}).to_string(),
                                ("/v1/chat/completions", false) => json!({"choices": [{"finish_reason": "stop", "message": {"content": "hi"}}],
                                    "usage": {"prompt_tokens": 12, "completion_tokens": 2, "prompt_cache_hit_tokens": 8}}).to_string(),
                                ("/v1/messages", false) => json!({"id": "msg_up", "type": "message", "role": "assistant",
                                    "content": [{"type": "text", "text": "hi"}], "stop_reason": "end_turn",
                                    "usage": {"input_tokens": 7, "output_tokens": 2, "cache_read_input_tokens": 500, "cache_creation_input_tokens": 60}}).to_string(),
                                ("/v1/messages", true) => [
                                    ("message_start", json!({"type": "message_start", "message": {"id": "msg_up", "usage":
                                        {"input_tokens": 9, "output_tokens": 1, "cache_read_input_tokens": 700, "cache_creation_input_tokens": 0}}})),
                                    ("content_block_delta", json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "yo"}})),
                                    ("message_delta", json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 15}})),
                                    ("message_stop", json!({"type": "message_stop"})),
                                ]
                                .iter()
                                .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
                                .collect(),
                                _ => [
                                    json!({"choices": [{"delta": {"content": "he"}}]}),
                                    json!({"choices": [{"delta": {"content": "llo"}, "finish_reason": "stop"}]}),
                                    json!({"choices": [], "usage": {"prompt_tokens": 40, "completion_tokens": 4, "prompt_tokens_details": {"cached_tokens": 32}}}),
                                ]
                                .iter()
                                .map(|chunk| format!("data: {chunk}\n\n"))
                                .chain(std::iter::once("data: [DONE]\n\n".to_string()))
                                .collect(),
                            };
                                Ok::<_, Infallible>(hyper::Response::new(Full::new(Bytes::from(
                                    reply,
                                ))))
                            }
                        },
                    );
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        port
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tl-gateway-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn provider(id: &str, port: u16, wire: WireApi) -> ProviderRecord {
        ProviderRecord {
            id: id.into(),
            name: id.into(),
            base_url: format!("http://127.0.0.1:{port}/v1"),
            wire,
            auth_mode: store::AuthMode::Key,
            models: vec!["m1".into()],
            enabled: true,
        }
    }

    struct Harness {
        gateway: Gateway,
        secrets: Arc<MemorySecrets>,
        seen: Arc<Seen>,
        base: String,
        token: String,
        dir: std::path::PathBuf,
    }

    #[test]
    fn startup_recovery_skips_configs_without_journals() {
        let dir = temp_dir("startup-no-journal");
        std::fs::create_dir_all(&dir).unwrap();
        let gateway = Gateway::new(&dir, Arc::new(MemorySecrets::default()), 0);
        gateway.recover_pending_configs().unwrap();
        assert!(!dir.join("codex-backup-v1").exists());
        assert!(!dir.join("agent-backup-v1").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn damaged_pending_journal_prevents_listener_start() {
        let dir = temp_dir("startup-damaged-journal");
        let backup = dir.join("codex-backup-v1");
        std::fs::create_dir_all(&backup).unwrap();
        let journal = backup.join("transaction-v1.json");
        std::fs::write(&journal, b"invalid journal").unwrap();
        let secrets = Arc::new(MemorySecrets::default());
        let gateway = Gateway::new(&dir, secrets.clone(), 0);
        *gateway.shared.providers.write().unwrap() = vec![provider("chat", 1, WireApi::Chat)];
        gateway.start_if_needed();
        let status = gateway.status();
        assert!(!status.running);
        assert!(status.error.unwrap().contains("配置事务"));
        assert_eq!(std::fs::read(journal).unwrap(), b"invalid journal");
        assert_eq!(secrets.get(LOCAL_TOKEN_ACCOUNT).unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn harness(name: &str) -> Harness {
        let dir = temp_dir(name);
        let seen = Arc::new(Seen::default());
        let upstream_port = tauri::async_runtime::block_on(spawn_upstream(seen.clone()));
        let secrets = Arc::new(MemorySecrets::default());
        let gateway = Gateway::new(&dir, secrets.clone(), 0);
        gateway
            .upsert_provider(provider("resp", upstream_port, WireApi::Responses))
            .unwrap();
        gateway
            .upsert_provider(provider("chat", upstream_port, WireApi::Chat))
            .unwrap();
        for id in ["resp", "chat"] {
            gateway
                .set_provider_key(SetProviderKeyInput {
                    id: id.into(),
                    key: format!("sk-{id}"),
                })
                .unwrap();
        }
        let status = gateway.status();
        assert!(status.running, "{status:?}");
        let token = secrets.get(LOCAL_TOKEN_ACCOUNT).unwrap().unwrap();
        Harness {
            base: status.base_url.unwrap(),
            gateway,
            secrets,
            seen,
            token,
            dir,
        }
    }

    async fn post(harness: &Harness, path: &str, body: Value, token: &str) -> (u16, String) {
        let response = reqwest::Client::new()
            .post(format!("{}{path}", harness.base))
            .bearer_auth(token)
            .header("user-agent", "codex_cli_rs/0.50.0")
            .json(&body)
            .send()
            .await
            .unwrap();
        (response.status().as_u16(), response.text().await.unwrap())
    }

    #[test]
    fn gateway_end_to_end() {
        let h = harness("e2e");
        tauri::async_runtime::block_on(async {
            let (status, _) = post(
                &h,
                "/responses",
                json!({"model": "resp/m1", "input": "hi"}),
                "wrong",
            )
            .await;
            assert_eq!(status, 401);

            let (status, body) = post(
                &h,
                "/responses",
                json!({"model": "resp/m1", "input": "hi"}),
                &h.token,
            )
            .await;
            assert_eq!(status, 200, "{body}");
            assert_eq!(h.seen.body.lock().unwrap().as_ref().unwrap()["model"], "m1");
            assert_eq!(
                h.seen.auth.lock().unwrap().as_deref(),
                Some("Bearer sk-resp")
            );

            let (status, body) = post(
                &h,
                "/responses",
                json!({"model": "chat/m1", "input": "hi"}),
                &h.token,
            )
            .await;
            assert_eq!(status, 200, "{body}");
            let response: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(response["output"][0]["content"][0]["text"], "hi");
            assert_eq!(
                h.seen.body.lock().unwrap().as_ref().unwrap()["messages"][0]["role"],
                "user"
            );

            let (status, body) = post(
                &h,
                "/responses",
                json!({"model": "chat/m1", "input": "hi", "stream": true}),
                &h.token,
            )
            .await;
            assert_eq!(status, 200);
            assert!(body.contains("event: response.output_text.delta"));
            assert!(body.contains("\"text\":\"hello\""));
            assert!(
                body.trim_end().ends_with('}'),
                "stream should end with response.completed"
            );

            let (status, _) = post(
                &h,
                "/chat/completions",
                json!({"model": "resp/m1", "messages": []}),
                &h.token,
            )
            .await;
            assert_eq!(status, 400);
            let (status, _) = post(
                &h,
                "/responses",
                json!({"model": "nobody/m1", "input": "hi"}),
                &h.token,
            )
            .await;
            assert_eq!(status, 404);

            let models: Value = reqwest::Client::new()
                .get(format!("{}/models", h.base))
                .bearer_auth(&h.token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(models["data"].as_array().unwrap().len(), 2);
        });

        let mut records = Vec::new();
        for _ in 0..50 {
            records = h.gateway.recent_requests(10).unwrap();
            if records.len() == 4 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(records.len(), 4);
        let find = |provider: &str, stream: bool, ok: bool| {
            records
                .iter()
                .find(|record| {
                    record.provider == provider && record.stream == stream && record.ok == ok
                })
                .unwrap_or_else(|| {
                    panic!("missing {provider} stream={stream} ok={ok}: {records:?}")
                })
        };
        let streamed = find("chat", true, true);
        assert_eq!(
            (streamed.input, streamed.output, streamed.cache_read),
            (8, 4, 32)
        );
        assert_eq!(streamed.agent.as_deref(), Some("codex"));
        let whole_chat = find("chat", false, true);
        assert_eq!((whole_chat.input, whole_chat.cache_read), (4, 8));
        let passthrough = find("resp", false, true);
        assert_eq!(
            (
                passthrough.input,
                passthrough.output,
                passthrough.cache_read
            ),
            (10, 3, 20)
        );
        assert_eq!(find("resp", false, false).status, 400);
        let _ = std::fs::remove_dir_all(&h.dir);
    }

    #[test]
    fn anthropic_messages_end_to_end() {
        let h = harness("messages");
        let upstream_port = h
            .gateway
            .providers()
            .into_iter()
            .find(|provider| provider.id == "chat")
            .map(|provider| provider.base_url)
            .unwrap();
        let mut anth = provider("anth", 0, WireApi::Anthropic);
        anth.base_url = upstream_port;
        h.gateway.upsert_provider(anth).unwrap();
        h.gateway
            .set_provider_key(SetProviderKeyInput {
                id: "anth".into(),
                key: "sk-anth".into(),
            })
            .unwrap();
        let send = |body: Value, beta: bool| {
            let mut request = reqwest::Client::new()
                .post(format!("{}/messages", h.base))
                .header("x-api-key", &h.token)
                .header("user-agent", "claude-cli/2.0.0 (external, cli)")
                .header("anthropic-version", "2023-06-01");
            if beta {
                request = request.header("anthropic-beta", "prompt-caching-2024-07-31");
            }
            async move {
                let response = request.json(&body).send().await.unwrap();
                (response.status().as_u16(), response.text().await.unwrap())
            }
        };
        let message = |model: &str, stream: bool| {
            json!({"model": model, "max_tokens": 64, "stream": stream,
                "system": [{"type": "text", "text": "sys", "cache_control": {"type": "ephemeral"}}],
                "messages": [{"role": "user", "content": "hi"}]})
        };
        let chat_message = |stream: bool| {
            let mut request = message("chat/m1", stream);
            request["system"][0]
                .as_object_mut()
                .unwrap()
                .remove("cache_control");
            request
        };
        tauri::async_runtime::block_on(async {
            let (status, body) = send(message("anth/m1", false), true).await;
            assert_eq!(status, 200, "{body}");
            let sent = h.seen.body.lock().unwrap().clone().unwrap();
            assert_eq!(sent["model"], "m1");
            assert_eq!(sent["system"][0]["cache_control"]["type"], "ephemeral");
            assert_eq!(h.seen.api_key.lock().unwrap().as_deref(), Some("sk-anth"));
            assert_eq!(h.seen.auth.lock().unwrap().as_deref(), None);
            assert_eq!(
                h.seen.anthropic_version.lock().unwrap().as_deref(),
                Some("2023-06-01")
            );

            let (status, body) = send(message("anth/m1", true), false).await;
            assert_eq!(status, 200);
            assert!(body.contains("event: message_stop"), "{body}");

            // Cache semantics require native Anthropic; refuse instead of
            // silently stripping the marker, and do not contact the upstream.
            let before = h.seen.body.lock().unwrap().clone();
            let (status, body) = send(message("chat/m1", false), false).await;
            assert_eq!(status, 400, "{body}");
            assert!(body.contains("cache_control"));
            assert_eq!(*h.seen.body.lock().unwrap(), before);

            let (status, body) = send(chat_message(false), false).await;
            assert_eq!(status, 200, "{body}");
            let reply: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(reply["type"], "message");
            assert_eq!(reply["content"][0]["text"], "hi");
            assert_eq!(reply["usage"]["input_tokens"], 4);
            let sent = h.seen.body.lock().unwrap().clone().unwrap();
            assert_eq!(
                sent["messages"][0],
                json!({"role": "system", "content": "sys"})
            );
            assert_eq!(
                h.seen.auth.lock().unwrap().as_deref(),
                Some("Bearer sk-chat")
            );

            let (status, body) = send(chat_message(true), false).await;
            assert_eq!(status, 200);
            assert!(body.contains("event: message_start"));
            assert!(body.contains("\"text\":\"he\""));
            assert!(body.contains("event: message_stop"));

            let (status, body) = send(message("resp/m1", false), false).await;
            assert_eq!(status, 400, "{body}");
            assert!(body.contains("\"type\":\"error\""));

            let count: Value = reqwest::Client::new()
                .post(format!("{}/messages/count_tokens", h.base))
                .header("x-api-key", &h.token)
                .json(&message("anth/m1", false))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(count["input_tokens"].as_u64().unwrap() >= 1);
        });

        let mut records = Vec::new();
        for _ in 0..50 {
            records = h.gateway.recent_requests(10).unwrap();
            if records.len() == 6 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(records.len(), 6, "{records:?}");
        let find = |provider: &str, stream: bool| {
            records
                .iter()
                .find(|record| record.provider == provider && record.stream == stream && record.ok)
                .unwrap_or_else(|| panic!("missing {provider} stream={stream}: {records:?}"))
        };
        let whole = find("anth", false);
        assert_eq!(
            (
                whole.input,
                whole.output,
                whole.cache_read,
                whole.cache_write
            ),
            (7, 2, 500, 60)
        );
        assert_eq!(whole.agent.as_deref(), Some("claude-code"));
        let streamed = find("anth", true);
        assert_eq!(
            (streamed.input, streamed.output, streamed.cache_read),
            (9, 15, 700)
        );
        let converted = find("chat", true);
        assert_eq!(
            (converted.input, converted.output, converted.cache_read),
            (8, 4, 32)
        );

        assert!(h
            .gateway
            .check_agent_wire("claude-code", "resp/m1")
            .is_err());
        assert!(h.gateway.check_agent_wire("claude-code", "chat/m1").is_ok());
        assert!(h.gateway.check_agent_wire("claude-code", "anth/m1").is_ok());
        assert!(h.gateway.check_agent_wire("codex", "anth/m1").is_err());
        assert!(h.gateway.check_agent_wire("opencode", "group/any").is_ok());
        let _ = std::fs::remove_dir_all(&h.dir);
    }

    #[test]
    fn foreign_host_header_is_rejected() {
        let h = harness("host");
        let status = tauri::async_runtime::block_on(async {
            reqwest::Client::new()
                .get(format!("{}/models", h.base))
                .header("host", "evil.example:3462")
                .bearer_auth(&h.token)
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        });
        assert_eq!(status, 403);
        let _ = std::fs::remove_dir_all(&h.dir);
    }

    #[test]
    fn gemini_endpoints_convert_to_chat() {
        let h = harness("gemini");
        let root = h.base.trim_end_matches("/v1").to_string();
        let ask = json!({"contents": [{"role": "user", "parts": [{"text": "hi"}]}]});
        let client = reqwest::Client::new();
        let call = |path: &str, auth: Option<(&'static str, String)>| {
            let mut request = client
                .post(format!("{root}{path}"))
                .header(
                    "user-agent",
                    "GeminiCLI/0.62.0/chat/m1 (darwin; arm64; terminal)",
                )
                .json(&ask);
            if let Some((name, value)) = auth {
                request = request.header(name, value);
            }
            request.send()
        };
        tauri::async_runtime::block_on(async {
            let denied = call("/v1beta/models/chat/m1:generateContent", None)
                .await
                .unwrap();
            assert_eq!(denied.status().as_u16(), 401);
            let error: Value = denied.json().await.unwrap();
            assert_eq!(error["error"]["status"], "UNAUTHENTICATED");

            let unprefixed = call(
                "/v1beta/models/gemini-2.5-flash-lite:generateContent",
                Some(("x-goog-api-key", h.token.clone())),
            )
            .await
            .unwrap();
            assert_eq!(unprefixed.status().as_u16(), 400);

            let whole = call(
                "/v1beta/models/chat/m1:generateContent",
                Some(("x-goog-api-key", h.token.clone())),
            )
            .await
            .unwrap();
            assert_eq!(whole.status().as_u16(), 200);
            let reply: Value = whole.json().await.unwrap();
            assert_eq!(reply["candidates"][0]["content"]["parts"][0]["text"], "hi");
            assert_eq!(reply["usageMetadata"]["cachedContentTokenCount"], 8);
            let sent = h.seen.body.lock().unwrap().clone().unwrap();
            assert_eq!(sent["model"], "m1");
            assert_eq!(sent["messages"][0]["content"], "hi");

            let helper = call(
                "/v1beta/models/gemini-2.5-flash-lite:generateContent",
                Some(("x-goog-api-key", h.token.clone())),
            )
            .await
            .unwrap();
            assert_eq!(
                helper.status().as_u16(),
                400,
                "bare model must never reuse another client's last model"
            );

            let path = format!(
                "/v1beta/models/chat/m1:streamGenerateContent?alt=sse&key={}",
                h.token
            );
            let streamed = call(&path, None).await.unwrap().text().await.unwrap();
            assert!(streamed.contains("\"text\":\"he\""), "{streamed}");
            assert!(streamed.contains("\"finishReason\":\"STOP\""));

            let counted: Value = call(
                "/v1beta/models/chat/m1:countTokens",
                Some(("x-goog-api-key", h.token.clone())),
            )
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
            assert_eq!(counted["totalTokens"], 1);

            let missing = call(
                "/v1beta/models/nobody/m1:generateContent",
                Some(("x-goog-api-key", h.token.clone())),
            )
            .await
            .unwrap();
            assert_eq!(missing.status().as_u16(), 404);
            let error: Value = missing.json().await.unwrap();
            assert_eq!(error["error"]["status"], "NOT_FOUND");

            let models: Value = client
                .get(format!("{root}/v1beta/models"))
                .header("x-goog-api-key", &h.token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(models["models"][0]["name"], "models/resp/m1");
        });

        let mut records = Vec::new();
        for _ in 0..50 {
            records = h.gateway.recent_requests(10).unwrap();
            if records.len() == 2 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(records.len(), 2, "{records:?}");
        assert!(records.iter().all(|record| record.endpoint == "gemini"));
        assert!(records
            .iter()
            .all(|record| record.agent.as_deref() == Some("gemini-cli")));
        let streamed = records.iter().find(|record| record.stream).unwrap();
        assert_eq!(
            (streamed.input, streamed.output, streamed.cache_read),
            (8, 4, 32)
        );
        let _ = std::fs::remove_dir_all(&h.dir);
    }

    #[test]
    fn provider_keys_stay_out_of_views_and_files() {
        let h = harness("keys");
        let views = h.gateway.list_providers().unwrap();
        assert!(views.iter().all(|view| view.has_key));
        let serialized = serde_json::to_string(&views).unwrap();
        assert!(!serialized.contains("sk-resp"));
        let file = std::fs::read_to_string(h.dir.join("providers-v1.json")).unwrap();
        assert!(!file.contains("sk-"));

        h.gateway.delete_provider("resp").unwrap();
        assert!(h.secrets.get("provider:resp").unwrap().is_none());
        let reloaded = Gateway::new(&h.dir, h.secrets.clone(), 0);
        assert_eq!(reloaded.providers().len(), 1);
        let _ = std::fs::remove_dir_all(&h.dir);
    }

    #[test]
    fn codex_config_gets_local_token_and_never_provider_key() {
        let h = harness("codex");
        let codex = CodexConfig::new(h.dir.join("codex-home/config.toml"), &h.dir);
        assert!(h.gateway.codex_preview(&codex, "nobody/m1").is_err());
        assert!(h.gateway.codex_preview(&codex, "no-slash").is_err());
        let preview = h.gateway.codex_preview(&codex, "resp/other").unwrap();
        assert_eq!(
            preview.warnings.len(),
            1,
            "model missing from provider list"
        );
        assert!(!preview.diff.contains(&h.token));

        h.gateway
            .codex_apply(
                &codex,
                CodexApplyInput {
                    model: "resp/m1".into(),
                    expected_version: Some(preview.before_version),
                },
            )
            .unwrap();
        let written = std::fs::read_to_string(h.dir.join("codex-home/config.toml")).unwrap();
        assert!(written.contains(&h.token));
        assert!(written.contains(&format!("base_url = \"{}\"", h.base)));
        assert!(!written.contains("sk-"));
        let inspection = h.gateway.codex_inspect(&codex).unwrap();
        assert!(inspection.points_to_gateway);
        assert!(!serde_json::to_string(&inspection)
            .unwrap()
            .contains(&h.token));

        h.gateway.codex_restore(&codex, false).unwrap();
        assert!(!h.dir.join("codex-home/config.toml").exists());
        let _ = std::fs::remove_dir_all(&h.dir);
    }

    #[derive(Clone, Copy)]
    enum Behave {
        Ok,
        Status(u16),
        /// 200 SSE that drops the connection after the first event.
        Truncated,
    }

    async fn spawn_scripted(behave: Behave, hits: Arc<std::sync::atomic::AtomicUsize>) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let hits = hits.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0u8; 8192];
                    loop {
                        let read = stream.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..read]);
                        let text = String::from_utf8_lossy(&request).to_string();
                        if let Some(end) = text.find("\r\n\r\n") {
                            let length = text[..end]
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                                })
                                .unwrap_or(0);
                            if request.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let reply = match behave {
                        Behave::Ok => {
                            let body = json!({"id": "resp_ok", "object": "response", "status": "completed", "output": [],
                                "usage": {"input_tokens": 5, "output_tokens": 2}})
                            .to_string();
                            format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
                        }
                        Behave::Status(code) => {
                            let body = r#"{"error":{"message":"scripted"}}"#;
                            format!("HTTP/1.1 {code} Scripted\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
                        }
                        Behave::Truncated => {
                            let event = "data: {\"type\":\"response.created\"}\n\n";
                            format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{event}\r\n", event.len())
                        }
                    };
                    let _ = stream.write_all(reply.as_bytes()).await;
                    let _ = stream.flush().await;
                });
            }
        });
        port
    }

    struct RouteHarness {
        gateway: Gateway,
        base: String,
        token: String,
        dir: std::path::PathBuf,
        hits: std::collections::HashMap<String, Arc<std::sync::atomic::AtomicUsize>>,
    }

    impl RouteHarness {
        fn hits(&self, id: &str) -> usize {
            self.hits[id].load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    /// `None` is a closed port, so connecting fails.
    fn route_harness(name: &str, specs: &[(&str, Option<Behave>)]) -> RouteHarness {
        let dir = temp_dir(name);
        let secrets = Arc::new(MemorySecrets::default());
        let gateway = Gateway::new(&dir, secrets.clone(), 0);
        let mut hits = std::collections::HashMap::new();
        for (id, behave) in specs {
            let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let port = match behave {
                Some(behave) => {
                    tauri::async_runtime::block_on(spawn_scripted(*behave, counter.clone()))
                }
                None => std::net::TcpListener::bind("127.0.0.1:0")
                    .unwrap()
                    .local_addr()
                    .unwrap()
                    .port(),
            };
            gateway
                .upsert_provider(provider(id, port, WireApi::Responses))
                .unwrap();
            gateway
                .set_provider_key(SetProviderKeyInput {
                    id: id.to_string(),
                    key: format!("sk-{id}"),
                })
                .unwrap();
            hits.insert(id.to_string(), counter);
        }
        let status = gateway.status();
        RouteHarness {
            base: status.base_url.unwrap(),
            token: secrets.get(LOCAL_TOKEN_ACCOUNT).unwrap().unwrap(),
            gateway,
            dir,
            hits,
        }
    }

    fn routing_group(id: &str, strategy: routing::Strategy, members: &[&str]) -> RoutingGroup {
        RoutingGroup {
            id: id.into(),
            name: id.into(),
            strategy,
            members: members.iter().map(|m| m.to_string()).collect(),
            manual_member: None,
            rules: Vec::new(),
            weights: Default::default(),
            session_ttl_secs: 600,
            enabled: true,
        }
    }

    async fn send(h: &RouteHarness, body: Value, session: Option<&str>) -> (u16, String) {
        let mut request = reqwest::Client::new()
            .post(format!("{}/responses", h.base))
            .bearer_auth(&h.token)
            .header("user-agent", "codex_cli_rs/0.160.0")
            .json(&body);
        if let Some(session) = session {
            request = request.header("session_id", session);
        }
        let response = request.send().await.unwrap();
        (response.status().as_u16(), response.text().await.unwrap())
    }

    fn wait_for_records(gateway: &Gateway, count: usize) -> Vec<LedgerRecord> {
        let mut records = Vec::new();
        for _ in 0..100 {
            records = gateway.recent_requests(100).unwrap();
            if records.len() >= count {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        records
    }

    #[test]
    fn routing_group_fails_over_only_before_a_reply_starts() {
        let h = route_harness(
            "route-failover",
            &[
                ("down", None),
                ("busy", Some(Behave::Status(429))),
                ("broken", Some(Behave::Status(503))),
                ("bad", Some(Behave::Status(400))),
                ("trunc", Some(Behave::Truncated)),
                ("ok", Some(Behave::Ok)),
            ],
        );
        use routing::Strategy::Failover;
        for group in [
            routing_group("g", Failover, &["down/m1", "busy/m1", "broken/m1", "ok/m1"]),
            routing_group("h", Failover, &["bad/m1", "ok/m1"]),
            routing_group("t", Failover, &["trunc/m1", "ok/m1"]),
        ] {
            h.gateway.upsert_routing_group(group).unwrap();
        }
        tauri::async_runtime::block_on(async {
            let (status, body) = send(&h, json!({"model": "group/g", "input": "hi"}), None).await;
            assert_eq!(status, 200, "{body}");
            assert_eq!((h.hits("busy"), h.hits("broken"), h.hits("ok")), (1, 1, 1));

            let (status, _) = send(&h, json!({"model": "group/h", "input": "hi"}), None).await;
            assert_eq!(status, 400, "plain 4xx is not retried");
            assert_eq!(h.hits("ok"), 1);

            let (status, body) = send(
                &h,
                json!({"model": "group/t", "input": "hi", "stream": true}),
                None,
            )
            .await;
            assert_eq!(status, 200);
            assert!(body.contains("response.created"));
            assert_eq!(h.hits("trunc"), 1);
            assert_eq!(h.hits("ok"), 1, "a started stream is never switched");

            let models: Value = reqwest::Client::new()
                .get(format!("{}/models", h.base))
                .bearer_auth(&h.token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let ids: Vec<&str> = models["data"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|model| model["id"].as_str())
                .collect();
            assert!(ids.contains(&"group/g") && ids.contains(&"group/t"));
        });

        let decisions = h.gateway.recent_route_decisions(10);
        let failover = decisions.iter().find(|d| d.group == "g").unwrap();
        assert_eq!(failover.chosen.as_deref(), Some("ok/m1"));
        assert_eq!(
            failover
                .attempts
                .iter()
                .map(|a| (a.outcome, a.status))
                .collect::<Vec<_>>(),
            vec![
                ("failed", None),
                ("failed", Some(429)),
                ("failed", Some(503)),
                ("ok", Some(200))
            ]
        );
        let rejected = decisions.iter().find(|d| d.group == "h").unwrap();
        assert_eq!(rejected.chosen, None);
        assert_eq!(rejected.attempts.len(), 1);

        let records = wait_for_records(&h.gateway, 7);
        let served = records.iter().find(|r| r.provider == "ok" && r.ok).unwrap();
        assert_eq!(served.group.as_deref(), Some("g"));
        assert_eq!(served.member.as_deref(), Some("ok/m1"));
        assert_eq!(served.requested_model, "group/g");
        assert_eq!((served.input, served.output), (5, 2));
        assert!(records
            .iter()
            .any(|r| r.provider == "busy" && r.status == 429 && !r.ok));
        let _ = std::fs::remove_dir_all(&h.dir);
    }

    #[test]
    fn routing_group_keeps_sessions_and_applies_rules() {
        let h = route_harness(
            "route-affinity",
            &[("a", Some(Behave::Ok)), ("b", Some(Behave::Ok))],
        );
        let mut group = routing_group("mix", routing::Strategy::Rotate, &["a/m1", "b/m1"]);
        group.rules.push(routing::RoutingRule {
            condition: routing::RuleCondition::HasImage,
            member: "b/m1".into(),
        });
        h.gateway.upsert_routing_group(group).unwrap();
        tauri::async_runtime::block_on(async {
            for _ in 0..3 {
                let (status, _) =
                    send(&h, json!({"model": "group/mix", "input": "hi"}), Some("s1")).await;
                assert_eq!(status, 200);
            }
            assert!(
                (h.hits("a"), h.hits("b")) == (3, 0) || (h.hits("a"), h.hits("b")) == (0, 3),
                "one session stays on one member"
            );
            let before = (h.hits("a"), h.hits("b"));
            send(&h, json!({"model": "group/mix", "input": "x"}), None).await;
            send(&h, json!({"model": "group/mix", "input": "y"}), None).await;
            assert_eq!(
                (h.hits("a") - before.0, h.hits("b") - before.1),
                (1, 1),
                "rotation"
            );
            let before = (h.hits("a"), h.hits("b"));
            for _ in 0..3 {
                let body =
                    json!({"model": "group/mix", "input": "hi", "prompt_cache_key": "conv-7"});
                assert_eq!(send(&h, body, None).await.0, 200);
            }
            let moved = (h.hits("a") - before.0, h.hits("b") - before.1);
            assert!(
                moved == (3, 0) || moved == (0, 3),
                "a body cache key pins without a session header"
            );
            let image = json!({"model": "group/mix", "input": [{"role": "user", "content": [
                {"type": "input_image", "image_url": "data:image/png;base64,AAAA"}]}]});
            let b_before = h.hits("b");
            send(&h, image, Some("s1")).await;
            assert_eq!(h.hits("b"), b_before + 1, "image rule beats affinity");
        });
        let latest = &h.gateway.recent_route_decisions(1)[0];
        assert_eq!(
            (latest.reason, latest.detail.as_str()),
            ("rule", "含图片输入")
        );
        let codex = CodexConfig::new(h.dir.join("codex-home/config.toml"), &h.dir);
        assert!(h.gateway.codex_preview(&codex, "group/mix").is_ok());
        assert!(h.gateway.codex_preview(&codex, "group/none").is_err());
        let _ = std::fs::remove_dir_all(&h.dir);
    }

    #[test]
    fn invalid_providers_and_keys_are_rejected() {
        let dir = temp_dir("invalid");
        let gateway = Gateway::new(&dir, Arc::new(MemorySecrets::default()), 0);
        let mut bad = provider("Bad_ID", 1, WireApi::Chat);
        assert!(gateway.upsert_provider(bad.clone()).is_err());
        bad.id = "ok".into();
        bad.base_url = "https://user:pw@example.com/v1".into();
        assert!(gateway.upsert_provider(bad).is_err());
        assert!(gateway
            .set_provider_key(SetProviderKeyInput {
                id: "missing".into(),
                key: "sk-x".into()
            })
            .is_err());
        assert!(
            !gateway.status().running,
            "no enabled provider means no listener"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn switched_off_gateway_never_listens_and_stopping_frees_the_port() {
        let dir = temp_dir("switch");
        let gateway = Gateway::new(&dir, Arc::new(MemorySecrets::default()), 0);
        gateway.set_enabled(false);
        gateway
            .upsert_provider(provider("a", 1, WireApi::Chat))
            .unwrap();
        gateway.start_if_needed();
        assert!(!gateway.status().running, "switched off: no listener");

        gateway.set_enabled(true);
        let status = gateway.status();
        assert!(status.running, "{status:?}");
        let port = status.port;
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_err());

        gateway.set_enabled(false);
        let status = gateway.status();
        assert!(!status.running && status.base_url.is_none());
        let mut freed = false;
        for _ in 0..100 {
            if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
                freed = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(freed, "port {port} is released after switching off");
        gateway
            .upsert_provider(provider("b", 1, WireApi::Chat))
            .unwrap();
        assert!(
            !gateway.status().running,
            "provider edits do not restart it"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn previous_use_counts_enabled_providers_and_unrestored_agent_backups() {
        let h = harness("in-use");
        assert!(h.gateway.was_in_use());

        let dir = temp_dir("in-use-agent");
        let gateway = Gateway::new(&dir, Arc::new(MemorySecrets::default()), 0);
        let mut disabled = provider("off", 1, WireApi::Chat);
        disabled.enabled = false;
        gateway.upsert_provider(disabled).unwrap();
        assert!(
            !gateway.was_in_use(),
            "a disabled provider alone is not use"
        );

        let codex = CodexConfig::new(h.dir.join("codex-home/config.toml"), &h.dir);
        h.gateway
            .upsert_provider(ProviderRecord {
                enabled: false,
                ..provider("resp", 1, WireApi::Responses)
            })
            .unwrap();
        h.gateway
            .upsert_provider(ProviderRecord {
                enabled: false,
                ..provider("chat", 1, WireApi::Chat)
            })
            .unwrap();
        assert!(!h.gateway.was_in_use());
        h.gateway
            .upsert_provider(provider("resp", 1, WireApi::Responses))
            .unwrap();
        h.gateway
            .codex_apply(
                &codex,
                CodexApplyInput {
                    model: "resp/m1".into(),
                    expected_version: None,
                },
            )
            .unwrap();
        h.gateway
            .upsert_provider(ProviderRecord {
                enabled: false,
                ..provider("resp", 1, WireApi::Responses)
            })
            .unwrap();
        assert!(h.gateway.was_in_use(), "Codex still points at the gateway");
        h.gateway.codex_restore(&codex, false).unwrap();
        assert!(!h.gateway.was_in_use());

        std::fs::create_dir_all(dir.join("agent-backup-v1/opencode")).unwrap();
        assert!(!gateway.was_in_use());
        std::fs::write(dir.join("agent-backup-v1/opencode/manifest.json"), "{}").unwrap();
        assert!(gateway.was_in_use());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&h.dir);
    }

    #[test]
    fn reveal_local_token_is_main_window_only_and_stable() {
        let dir = temp_dir("reveal");
        let secrets = Arc::new(MemorySecrets::default());
        let gateway = Gateway::new(&dir, secrets.clone(), 0);

        for label in ["widget", "wallpaper", "Main", ""] {
            assert_eq!(
                reveal_local_token(label, &gateway).unwrap_err(),
                "网关设置只允许主窗口调用。"
            );
        }
        assert!(
            secrets.get(LOCAL_TOKEN_ACCOUNT).unwrap().is_none(),
            "a rejected caller must not even mint the token"
        );

        let token = reveal_local_token("main", &gateway).unwrap();
        assert!(token.starts_with("tl-") && token.len() >= 35);
        assert_eq!(
            secrets.get(LOCAL_TOKEN_ACCOUNT).unwrap().as_deref(),
            Some(token.as_str())
        );
        assert_eq!(reveal_local_token("main", &gateway).unwrap(), token);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn routing_feed_is_readable_by_main_and_widgets_only() {
        for label in ["main", "widget", "desktop-widget"] {
            assert!(ensure_routing_feed_label(label).is_ok(), "{label}");
        }
        for label in ["wallpaper", "Main", "widget-evil", ""] {
            assert!(ensure_routing_feed_label(label).is_err(), "{label}");
        }
    }

    #[test]
    fn routing_feed_drops_sessions_errors_and_details() {
        let decision = RouteDecision {
            ts: "2026-10-23T00:00:00Z".into(),
            request_id: "r1".into(),
            group: "coding".into(),
            session: Some("session-secret".into()),
            reason: "failover",
            detail: "detail-secret".into(),
            chosen: Some("b/m".into()),
            attempts: vec![routing::RouteAttempt {
                member: "a/m".into(),
                outcome: "failed",
                status: Some(429),
                error: Some("error-secret".into()),
            }],
            trace: vec![routing::MemberTrace {
                member: "a/m".into(),
                rank: Some(0),
                verdict: "failed",
                reasons: vec!["strategy_first", "rate_limited"],
                detail: Some("detail-secret".into()),
            }],
        };
        let record = LedgerRecord {
            ts: "2026-10-23T00:00:01Z".into(),
            request_id: "att-1".into(),
            logical_request_id: Some("r1".into()),
            agent: Some("codex".into()),
            session: Some("session-secret".into()),
            endpoint: "endpoint-secret".into(),
            provider: "b".into(),
            requested_model: "group/coding".into(),
            upstream_model: "m".into(),
            wire: "responses".into(),
            stream: true,
            status: 200,
            ok: true,
            input: 1,
            output: 1,
            cache_read: 0,
            cache_write: 0,
            latency_ms: 5,
            error: Some("error-secret".into()),
            group: Some("coding".into()),
            member: Some("b/m".into()),
        };
        let feed = RoutingFeed {
            running: true,
            decisions: vec![decision.into()],
            requests: vec![record.into()],
        };
        let json = serde_json::to_string(&feed).unwrap();
        assert!(!json.contains("secret"), "{json}");
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["decisions"][0]["attempts"][0]["status"], 429);
        assert_eq!(value["decisions"][0]["chosen"], "b/m");
        assert_eq!(value["requests"][0]["logicalRequestId"], "r1");
        assert_eq!(value["requests"][0]["agent"], "codex");
    }
}
