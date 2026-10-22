//! Owner-scoped cross-device synchronization for validated quota snapshots.
//!
//! This module is deliberately separate from Stats v2. The renderer can only
//! enable/disable or request a refresh; it can never provide the Provider
//! payload. Rust reads locally authorized Providers, copies an allow-listed
//! projection, validates it, and sends per-Provider latest-wins entries through
//! the v2 RPCs. Cloud snapshots are cached owner-bound and merged only for
//! display; they are never echoed back as local observations.

use crate::app_paths::AppContext;
use crate::commands;
use crate::quota::{
    self, QuotaCapability, QuotaMode, QuotaProviderEnvelope, QuotaScope, QuotaSource, QuotaStatus,
    QuotaUnit, QuotaWindowStatus,
};
use crate::settings::{self, AppSettings};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

/// Epoch/generation stream shared by every transport. Binding, delete and
/// global clear always use the v2 functions (contract §6.1).
const TRANSPORT_VERSION: u8 = 2;
/// Read/write transport that additionally carries `unit='currency'`. Clouds
/// without it answer PGRST202/404 and the client falls back to v2.
const CURRENCY_TRANSPORT_VERSION: u8 = 3;
const BINDING_SCHEMA_VERSION: u8 = 2;
const BINDING_FILE: &str = "quota_sync_binding_v2.json";
const MAX_BINDING_BYTES: usize = 8 * 1024;
const REMOTE_CACHE_SCHEMA_VERSION: u8 = 2;
const REMOTE_CACHE_FILE: &str = "quota_remote_cache_v2.json";
const MAX_REMOTE_CACHE_BYTES: usize = 128 * 1024;
const REMOTE_CLEAR_PENDING_FILE: &str = "quota_remote_clear_pending_v1.json";
const REMOTE_CLEAR_PENDING_LOCK_FILE: &str = "quota_remote_clear_pending_v1.lock.sqlite3";
const REMOTE_CLEAR_PENDING_SCHEMA_VERSION: u8 = 1;
const MAX_REMOTE_CLEAR_PENDING_BYTES: usize = 32 * 1024;
const MAX_REMOTE_CLEAR_PENDING_ENTRIES: usize = 64;
const MAX_REMOTE_CLEAR_INTENT_ID_BYTES: usize = 128;
const REMOTE_CLEAR_PENDING_TTL_HOURS: i64 = 25;
const REMOTE_CLEAR_PENDING_LOCK_TIMEOUT_MILLIS: u64 = 2_000;
const LOCAL_STOP_FILE: &str = "quota_local_stop_v1.json";
const LOCAL_STATE_LOCK_FILE: &str = "quota_local_state.lock.sqlite3";
const LOCAL_STATE_LOCK_TIMEOUT_MILLIS: u64 = 2_000;
const LOCAL_STOP_SCHEMA_VERSION: u8 = 1;
const MAX_LOCAL_STOP_BYTES: usize = 1024;
const PRODUCER_MAX_BYTES: usize = 60 * 1024;
const MAX_RPC_RESPONSE_BYTES: usize = 128 * 1024;
const MAX_CLEAR_METADATA_BYTES: usize = 1024;
const MAX_ERROR_RESPONSE_BYTES: usize = 8 * 1024;
const MAX_PROVIDERS: usize = 8;
const MAX_WINDOWS_PER_PROVIDER: usize = 16;
const MAX_STRING_BYTES: usize = 512;
const MAX_STABLE_ID_BYTES: usize = 128;
const MAX_TIMELINE_INTEGER: u64 = i32::MAX as u64;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const REMOTE_CLEAR_INCOMPLETE: &str = "quota_sync_remote_clear_incomplete";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuotaSyncState {
    Disabled,
    Active,
    Syncing,
    Paused,
    AuthRequired,
    Unavailable,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSyncStatus {
    pub enabled: bool,
    pub state: QuotaSyncState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuotaSyncBinding {
    schema_version: u8,
    transport_version: u8,
    supabase_origin: String,
    user_id: String,
    epoch: u64,
    revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_synced_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncedQuotaWindow {
    provider_id: String,
    window_id: String,
    window_label: String,
    scope: QuotaScope,
    source: QuotaSource,
    status: QuotaWindowStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    used: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remaining: Option<f64>,
    unit: QuotaUnit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    window_minutes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resets_at: Option<String>,
    observed_at: String,
    fetched_at: String,
    stale_after_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncedQuotaProvider {
    schema_version: u8,
    provider_id: String,
    display_name: String,
    scope: QuotaScope,
    mode: QuotaMode,
    capability: QuotaCapability,
    status: QuotaStatus,
    windows: Vec<SyncedQuotaWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuotaProviderState {
    provider_id: String,
    scope: QuotaScope,
    generation: u64,
    deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_observed_at: Option<String>,
    received_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteQuotaCache {
    schema_version: u8,
    transport_version: u8,
    supabase_origin: String,
    user_id: String,
    epoch: u64,
    revision: u64,
    generated_at: String,
    providers: Vec<SyncedQuotaProvider>,
    provider_states: Vec<QuotaProviderState>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuotaUpsertEntry {
    generation: u64,
    envelope: SyncedQuotaProvider,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetQuotaSnapshotsResponse {
    status: String,
    transport_version: u8,
    epoch: u64,
    revision: u64,
    generated_at: String,
    providers: Vec<SyncedQuotaProvider>,
    provider_states: Vec<QuotaProviderState>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClearQuotaMetadata {
    status: String,
    transport_version: u8,
    epoch: u64,
    revision: u64,
    generated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpsertQuotaSnapshotsResponse {
    status: String,
    transport_version: u8,
    epoch: u64,
    revision: u64,
    upserted_provider_count: usize,
    ignored_provider_count: usize,
    generated_at: String,
    providers: Vec<SyncedQuotaProvider>,
    provider_states: Vec<QuotaProviderState>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClearQuotaSnapshotsResponse {
    status: String,
    transport_version: u8,
    epoch: u64,
    revision: u64,
    cleared_provider_count: usize,
    generated_at: String,
    providers: Vec<SyncedQuotaProvider>,
    provider_states: Vec<QuotaProviderState>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteQuotaProviderResponse {
    status: String,
    transport_version: u8,
    epoch: u64,
    revision: u64,
    generated_at: String,
    providers: Vec<SyncedQuotaProvider>,
    provider_states: Vec<QuotaProviderState>,
    deleted_provider_id: String,
    deleted_scope: QuotaScope,
    provider_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PostgrestErrorBody {
    code: String,
    message: String,
    details: Option<Value>,
    hint: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct CloudIdentity {
    origin: String,
    user_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteClearPendingEntry {
    supabase_origin: String,
    user_id: String,
    #[serde(default)]
    intent_id: String,
    pending_since: String,
    expires_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteClearPendingStore {
    schema_version: u8,
    entries: Vec<RemoteClearPendingEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalStopStore {
    schema_version: u8,
    active: bool,
}

struct QuotaRpcSessionFence {
    app: AppContext,
    lease: commands::CloudSessionUseLease,
}

struct QuotaRpcContext {
    identity: CloudIdentity,
    supabase_key: String,
    access_token: String,
    client: reqwest::Client,
    session_fence: Option<QuotaRpcSessionFence>,
    #[cfg(test)]
    test_session_generation: Option<(Arc<AtomicU64>, u64)>,
    #[cfg(test)]
    before_clear_authorization: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BoundedReadError {
    Transport,
    TooLarge,
}

fn append_bounded(buffer: &mut Vec<u8>, chunk: &[u8], cap: usize) -> Result<(), BoundedReadError> {
    if chunk.len() > cap.saturating_sub(buffer.len()) {
        return Err(BoundedReadError::TooLarge);
    }
    buffer.extend_from_slice(chunk);
    Ok(())
}

fn content_length_exceeds_cap(content_length: Option<u64>, cap: usize) -> bool {
    content_length.is_some_and(|length| length > cap as u64)
}

async fn read_response_bounded(
    mut response: reqwest::Response,
    cap: usize,
) -> Result<Vec<u8>, BoundedReadError> {
    if content_length_exceeds_cap(response.content_length(), cap) {
        return Err(BoundedReadError::TooLarge);
    }
    let mut body =
        Vec::with_capacity(response.content_length().unwrap_or(0).min(cap as u64) as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| BoundedReadError::Transport)?
    {
        append_bounded(&mut body, &chunk, cap)?;
    }
    Ok(body)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuotaRpcError {
    AuthRequired,
    ServiceRoleRejected,
    MissingRpc,
    UnsupportedTransport,
    InvalidEpoch,
    StaleEpoch,
    InvalidProviderGeneration,
    StaleProviderGeneration,
    Superseded,
    InvalidPayload,
    InvalidProviderCount,
    CapacityExceeded,
    PayloadTooLarge,
    RateLimited,
    Http(u16),
    Transport,
    InvalidResponse,
    ClearOutcomeUnknown,
    ClearOutcomeUnknownLocalStopIncomplete,
    ClearLocalStopIncomplete,
    ClearDispatchStopIncomplete,
    ClearRejectedDeviceStopped,
}

impl QuotaRpcError {
    fn reason_code(self) -> &'static str {
        match self {
            Self::AuthRequired => "quota_sync_auth_required",
            Self::ServiceRoleRejected => "quota_sync_service_role_rejected",
            Self::MissingRpc => "quota_sync_rpc_unavailable",
            Self::UnsupportedTransport => "quota_sync_unsupported_transport",
            Self::InvalidEpoch => "quota_sync_invalid_epoch",
            Self::StaleEpoch => "quota_sync_stale_epoch",
            Self::InvalidProviderGeneration => "quota_sync_invalid_provider_generation",
            Self::StaleProviderGeneration => "quota_sync_stale_provider_generation",
            Self::Superseded => "quota_sync_superseded",
            Self::InvalidPayload => "quota_sync_invalid_payload",
            Self::InvalidProviderCount => "quota_sync_invalid_provider_count",
            Self::CapacityExceeded => "quota_sync_capacity_exceeded",
            Self::PayloadTooLarge => "quota_sync_payload_too_large",
            Self::RateLimited => "quota_sync_rate_limited",
            Self::Http(_) => "quota_sync_http_error",
            Self::Transport => "quota_sync_transport_error",
            Self::InvalidResponse => "quota_sync_invalid_response",
            Self::ClearOutcomeUnknown => "quota_sync_clear_outcome_unknown",
            Self::ClearOutcomeUnknownLocalStopIncomplete => {
                "quota_sync_clear_outcome_unknown_local_stop_incomplete"
            }
            Self::ClearLocalStopIncomplete => "quota_sync_clear_local_stop_incomplete",
            Self::ClearDispatchStopIncomplete => "quota_sync_clear_dispatch_stop_incomplete",
            Self::ClearRejectedDeviceStopped => "quota_sync_clear_rejected_device_stopped",
        }
    }

    fn safe_message(self) -> String {
        match self {
            Self::AuthRequired => "请先登录云端账户。".to_string(),
            Self::ServiceRoleRejected => "额度同步只接受 Supabase publishable key。".to_string(),
            Self::MissingRpc => "云端额度同步能力尚未部署。".to_string(),
            Self::StaleEpoch => "云端额度授权已变化，请重新显式启用同步。".to_string(),
            Self::StaleProviderGeneration => {
                "云端 Provider 已被另一台设备更新，请刷新后重试。".to_string()
            }
            Self::Superseded => "额度同步请求已被更新的本地状态取代。".to_string(),
            Self::InvalidProviderCount => {
                "跨设备额度同步最多支持 8 个活跃来源；请在额度设置中关闭部分本机来源后重试。"
                    .to_string()
            }
            Self::CapacityExceeded => "本次同步会使云端活跃额度来源超过 8 个上限，新增来源未同步；关闭本机来源不会删除云端历史。如需删除全部云端快照，请在设置中明确确认该操作。".to_string(),
            Self::ClearOutcomeUnknown => "quota_sync_clear_outcome_unknown: 云端清空结果尚未确认，可能已经完成；请检查云端状态后再决定是否重试，不会自动再次清空。".to_string(),
            Self::ClearOutcomeUnknownLocalStopIncomplete => "quota_sync_clear_outcome_unknown_local_stop_incomplete: 云端清空结果尚未确认，本机停止同步也未完整落盘；当前进程保持安全封锁，请先重试关闭同步，不会自动再次清空云端。".to_string(),
            Self::ClearLocalStopIncomplete => "quota_sync_clear_local_stop_incomplete: 云端额度已确认清空，但本机停止同步尚未完成；本机保持安全封锁，请重试关闭同步。".to_string(),
            Self::ClearDispatchStopIncomplete => "quota_sync_clear_dispatch_stop_incomplete: 本机安全停止尚未完整落盘，云端清空尚未发送；当前进程保持封锁，请先重试关闭同步。".to_string(),
            Self::ClearRejectedDeviceStopped => "quota_sync_clear_rejected_device_stopped: 云端未确认本次清空请求，本机已安全停止同步；请检查云端状态，需继续同步时重新显式启用，不会自动再次清空。".to_string(),
            Self::PayloadTooLarge => "额度快照超过安全传输上限。".to_string(),
            Self::RateLimited => "云端额度同步请求过于频繁，请稍后重试。".to_string(),
            Self::Http(status) => format!("云端额度同步失败（HTTP {status}）。"),
            Self::Transport => "暂时无法连接云端额度同步服务。".to_string(),
            Self::UnsupportedTransport
            | Self::InvalidEpoch
            | Self::InvalidProviderGeneration
            | Self::InvalidPayload
            | Self::InvalidResponse => "云端额度同步响应不符合安全契约。".to_string(),
        }
    }
}

impl QuotaRpcSessionFence {
    fn ensure_current(&self) -> Result<(), QuotaRpcError> {
        self.lease
            .ensure_current(&self.app)
            .map_err(|_| QuotaRpcError::Superseded)
    }

    fn commit_if_current<T>(
        &self,
        mutation: impl FnOnce() -> Result<T, QuotaRpcError>,
    ) -> Result<T, QuotaRpcError> {
        let mut result = None;
        self.lease
            .commit_if_current(&self.app, || {
                result = Some(mutation());
                Ok(())
            })
            .map_err(|_| QuotaRpcError::Superseded)?;
        result.unwrap_or(Err(QuotaRpcError::InvalidResponse))
    }
}

impl QuotaRpcContext {
    fn ensure_session_current(&self) -> Result<(), QuotaRpcError> {
        #[cfg(test)]
        if self
            .test_session_generation
            .as_ref()
            .is_some_and(|(generation, captured)| generation.load(Ordering::SeqCst) != *captured)
        {
            return Err(QuotaRpcError::Superseded);
        }
        self.session_fence
            .as_ref()
            .map_or(Ok(()), QuotaRpcSessionFence::ensure_current)
    }

    fn commit_if_session_current<T>(
        &self,
        mutation: impl FnOnce() -> Result<T, QuotaRpcError>,
    ) -> Result<T, QuotaRpcError> {
        self.ensure_session_current()?;
        match self.session_fence.as_ref() {
            Some(fence) => fence.commit_if_current(mutation),
            None => mutation(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OperationClaim {
    generation: u64,
    request_id: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ReauthorizationFailure {
    error: QuotaRpcError,
    rollback_failed: bool,
}

impl From<QuotaRpcError> for ReauthorizationFailure {
    fn from(error: QuotaRpcError) -> Self {
        Self {
            error,
            rollback_failed: false,
        }
    }
}

#[derive(Default)]
struct CoordinatorState {
    generation: u64,
    next_request_id: u64,
    in_flight: Option<u64>,
    last_reason_code: Option<String>,
    sync_blocked: bool,
    remote_clear_pending: HashMap<CloudIdentity, i64>,
}

#[derive(Default)]
struct QuotaSyncCoordinator {
    state: Mutex<CoordinatorState>,
}

impl QuotaSyncCoordinator {
    fn lock(&self) -> MutexGuard<'_, CoordinatorState> {
        match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn begin(&self) -> Option<OperationClaim> {
        let mut state = self.lock();
        if state.in_flight.is_some() {
            return None;
        }
        state.next_request_id = state.next_request_id.wrapping_add(1).max(1);
        let claim = OperationClaim {
            generation: state.generation,
            request_id: state.next_request_id,
        };
        state.in_flight = Some(claim.request_id);
        state.last_reason_code = None;
        Some(claim)
    }

    fn begin_sync(&self) -> (Option<OperationClaim>, bool) {
        let mut state = self.lock();
        if state.sync_blocked {
            return (None, true);
        }
        if state.in_flight.is_some() {
            return (None, false);
        }
        state.next_request_id = state.next_request_id.wrapping_add(1).max(1);
        let claim = OperationClaim {
            generation: state.generation,
            request_id: state.next_request_id,
        };
        state.in_flight = Some(claim.request_id);
        state.last_reason_code = None;
        (Some(claim), false)
    }

    fn begin_tombstone<T>(
        &self,
        reason_code: &str,
        mutation: impl FnOnce() -> T,
    ) -> (OperationClaim, T) {
        let mut state = self.lock();
        state.generation = state.generation.wrapping_add(1);
        state.next_request_id = state.next_request_id.wrapping_add(1).max(1);
        let claim = OperationClaim {
            generation: state.generation,
            request_id: state.next_request_id,
        };
        state.in_flight = Some(claim.request_id);
        state.last_reason_code = Some(reason_code.to_string());
        state.sync_blocked = true;
        let result = mutation();
        (claim, result)
    }

    fn is_current(&self, claim: OperationClaim) -> bool {
        let state = self.lock();
        state.generation == claim.generation && state.in_flight == Some(claim.request_id)
    }

    fn finish(&self, claim: OperationClaim, reason_code: Option<&str>) {
        let mut state = self.lock();
        if state.generation == claim.generation && state.in_flight == Some(claim.request_id) {
            state.in_flight = None;
            state.last_reason_code = reason_code.map(str::to_string);
        }
    }

    fn commit_current<T>(
        &self,
        claim: OperationClaim,
        mutation: impl FnOnce() -> Result<T, QuotaRpcError>,
    ) -> Result<T, QuotaRpcError> {
        let mut state = self.lock();
        if state.generation != claim.generation || state.in_flight != Some(claim.request_id) {
            return Err(QuotaRpcError::Superseded);
        }
        let result = mutation();
        state.in_flight = None;
        state.last_reason_code = result
            .as_ref()
            .err()
            .map(|error| error.reason_code().to_string());
        result
    }

    #[cfg(test)]
    fn finish_tombstone<T>(
        &self,
        app: &AppContext,
        claim: OperationClaim,
        identity: Option<&CloudIdentity>,
        remote_cleanup_pending: bool,
        now: DateTime<Utc>,
        mutation: impl FnOnce() -> (T, bool, bool),
    ) -> Result<T, QuotaRpcError> {
        let mut state = self.lock();
        if state.generation != claim.generation || state.in_flight != Some(claim.request_id) {
            return Err(QuotaRpcError::Superseded);
        }
        let (result, allow_sync, local_cleanup_pending) = mutation();
        let cleanup_pending = remote_cleanup_pending || local_cleanup_pending;
        state.in_flight = None;
        state.sync_blocked = cleanup_pending || !allow_sync;
        state.last_reason_code = cleanup_pending.then(|| REMOTE_CLEAR_INCOMPLETE.to_string());
        let mut durable_store_failed = false;
        if let Some(identity) = identity.and_then(normalize_pending_identity) {
            if remote_cleanup_pending {
                let expires_at = now + ChronoDuration::hours(REMOTE_CLEAR_PENDING_TTL_HOURS);
                state
                    .remote_clear_pending
                    .insert(identity.clone(), expires_at.timestamp());
                durable_store_failed =
                    persist_remote_clear_pending_at(app, &identity, now).is_err();
            } else {
                match remove_remote_clear_pending_at(app, &identity, now) {
                    Ok(()) => {
                        state.remote_clear_pending.remove(&identity);
                    }
                    Err(_) => durable_store_failed = true,
                }
            }
        }
        if durable_store_failed {
            let _ = set_local_stop_active(app, true);
            state.sync_blocked = true;
            state.last_reason_code = Some(REMOTE_CLEAR_INCOMPLETE.to_string());
            return Err(QuotaRpcError::InvalidResponse);
        }
        Ok(result)
    }

    fn finish_device_stop(
        &self,
        claim: OperationClaim,
        cleanup_pending: bool,
        reason_code: &str,
    ) -> Result<(), QuotaRpcError> {
        let mut state = self.lock();
        if state.generation != claim.generation || state.in_flight != Some(claim.request_id) {
            return Err(QuotaRpcError::Superseded);
        }
        state.in_flight = None;
        state.sync_blocked = true;
        state.last_reason_code = Some(
            if cleanup_pending {
                "quota_sync_local_stop_incomplete"
            } else {
                reason_code
            }
            .to_string(),
        );
        Ok(())
    }

    fn commit_clear_stop(
        &self,
        claim: OperationClaim,
        context: &QuotaRpcContext,
        app: &AppContext,
        settings_state: &Arc<Mutex<AppSettings>>,
        outcome_unknown: bool,
    ) -> Result<(), QuotaRpcError> {
        let mut state = self.lock();
        if state.generation != claim.generation || state.in_flight != Some(claim.request_id) {
            return Err(QuotaRpcError::ClearOutcomeUnknown);
        }
        context
            .commit_if_session_current(|| {
                let preparation = prepare_and_apply_stop(
                    app,
                    Some(settings_state),
                    Some(context.identity.clone()),
                    false,
                    Utc::now(),
                );
                state.generation = state.generation.wrapping_add(1);
                state.in_flight = None;
                state.sync_blocked = true;
                let incomplete =
                    preparation.intent_error.is_some() || preparation.local_cleanup_pending;
                state.last_reason_code = match (incomplete, outcome_unknown) {
                    (true, true) => Some(
                        QuotaRpcError::ClearOutcomeUnknownLocalStopIncomplete
                            .reason_code()
                            .to_string(),
                    ),
                    (true, false) => Some(
                        QuotaRpcError::ClearLocalStopIncomplete
                            .reason_code()
                            .to_string(),
                    ),
                    (false, true) => {
                        Some(QuotaRpcError::ClearOutcomeUnknown.reason_code().to_string())
                    }
                    (false, false) => None,
                };
                if incomplete {
                    Err(QuotaRpcError::ClearLocalStopIncomplete)
                } else {
                    Ok(())
                }
            })
            .map_err(|error| {
                if error == QuotaRpcError::Superseded {
                    QuotaRpcError::ClearOutcomeUnknown
                } else {
                    error
                }
            })
    }

    fn authorize_clear_dispatch(
        &self,
        claim: OperationClaim,
        context: &QuotaRpcContext,
        app: &AppContext,
        settings_state: &Arc<Mutex<AppSettings>>,
        sent: &AtomicBool,
    ) -> Result<(), QuotaRpcError> {
        let mut state = self.lock();
        if state.generation != claim.generation || state.in_flight != Some(claim.request_id) {
            return Err(QuotaRpcError::Superseded);
        }
        context.commit_if_session_current(|| {
            let preparation = with_local_state_lock(app, || {
                let binding = load_binding_result(app)
                    .map_err(|_| QuotaRpcError::ClearDispatchStopIncomplete)?;
                if binding
                    .as_ref()
                    .is_some_and(|binding| !binding_matches(binding, &context.identity))
                {
                    return Err(QuotaRpcError::Superseded);
                }
                Ok(prepare_and_apply_stop_unlocked(
                    app,
                    Some(settings_state),
                    Some(context.identity.clone()),
                    false,
                    Utc::now(),
                    || {},
                ))
            });
            let preparation = match preparation {
                Ok(Ok(preparation)) => preparation,
                Ok(Err(QuotaRpcError::Superseded)) => return Err(QuotaRpcError::Superseded),
                _ => {
                    state.sync_blocked = true;
                    return Err(QuotaRpcError::ClearDispatchStopIncomplete);
                }
            };
            // Retain this claim for its receipt, but block every producer before
            // granting dispatch. A crash now cannot rebind and republish.
            state.sync_blocked = true;
            if preparation.intent_error.is_some() || preparation.local_cleanup_pending {
                return Err(QuotaRpcError::ClearDispatchStopIncomplete);
            }
            // This is a dispatch-permission linearization point, not proof of
            // bytes on the wire. Later cancellation cannot revoke permission.
            sent.store(true, Ordering::SeqCst);
            Ok(())
        })
    }

    fn finish_local_tombstone(
        &self,
        app: &AppContext,
        claim: OperationClaim,
        identity: Option<&CloudIdentity>,
        cleanup_pending: bool,
        reason_code: &str,
        now: DateTime<Utc>,
    ) -> Result<(), QuotaRpcError> {
        let mut state = self.lock();
        if state.generation != claim.generation || state.in_flight != Some(claim.request_id) {
            return Err(QuotaRpcError::Superseded);
        }
        state.in_flight = None;
        state.sync_blocked = true;
        state.last_reason_code = Some(
            if cleanup_pending {
                REMOTE_CLEAR_INCOMPLETE
            } else {
                reason_code
            }
            .to_string(),
        );
        if cleanup_pending {
            if let Some(identity) = identity.and_then(normalize_pending_identity) {
                let expires_at = now + ChronoDuration::hours(REMOTE_CLEAR_PENDING_TTL_HOURS);
                state
                    .remote_clear_pending
                    .insert(identity.clone(), expires_at.timestamp());
                if persist_remote_clear_pending_at(app, &identity, now).is_err() {
                    let _ = set_local_stop_active(app, true);
                    return Err(QuotaRpcError::InvalidResponse);
                }
            }
        }
        Ok(())
    }

    #[cfg(test)]
    fn invalidate(&self, reason_code: Option<&str>) {
        let mut state = self.lock();
        state.generation = state.generation.wrapping_add(1);
        state.in_flight = None;
        state.last_reason_code = reason_code.map(str::to_string);
    }

    #[cfg(test)]
    fn record_remote_clear_failure(
        &self,
        app: &AppContext,
        identity: Option<&CloudIdentity>,
        now: DateTime<Utc>,
    ) {
        let mut state = self.lock();
        state.generation = state.generation.wrapping_add(1);
        state.in_flight = None;
        state.last_reason_code = Some(REMOTE_CLEAR_INCOMPLETE.to_string());
        state.sync_blocked = true;
        if let Some(identity) = identity.and_then(normalize_pending_identity) {
            let expires_at = now + ChronoDuration::hours(REMOTE_CLEAR_PENDING_TTL_HOURS);
            state
                .remote_clear_pending
                .insert(identity.clone(), expires_at.timestamp());
            let _ = persist_remote_clear_pending_at(app, &identity, now);
        }
    }

    #[cfg(test)]
    fn resolve_remote_clear(&self, app: &AppContext, identity: &CloudIdentity, now: DateTime<Utc>) {
        let mut state = self.lock();
        state.generation = state.generation.wrapping_add(1);
        state.in_flight = None;
        state.last_reason_code = None;
        let Some(identity) = normalize_pending_identity(identity) else {
            return;
        };
        if remove_remote_clear_pending_at(app, &identity, now).is_ok() {
            state.remote_clear_pending.remove(&identity);
        }
    }

    fn commit_reauthorized<T>(
        &self,
        app: &AppContext,
        claim: OperationClaim,
        identity: &CloudIdentity,
        _now: DateTime<Utc>,
        mutation: impl FnOnce() -> Result<T, ReauthorizationFailure>,
    ) -> Result<T, QuotaRpcError> {
        let mut state = self.lock();
        if state.generation != claim.generation || state.in_flight != Some(claim.request_id) {
            return Err(QuotaRpcError::Superseded);
        }
        match mutation() {
            Ok(value) => {
                state.in_flight = None;
                state.last_reason_code = None;
                state.sync_blocked = false;
                if let Some(identity) = normalize_pending_identity(identity) {
                    // The disk CAS already ran inside the enable local-state
                    // critical section. Never perform a second unconditional
                    // remove here: another process may have written a newer
                    // stop intent after local enable committed.
                    state.remote_clear_pending.remove(&identity);
                }
                Ok(value)
            }
            Err(failure) => {
                state.in_flight = None;
                Self::record_reauthorization_failure(&mut state, app, failure);
                Err(failure.error)
            }
        }
    }

    fn finish_failed_reauthorization(
        &self,
        app: &AppContext,
        settings_state: &Arc<Mutex<AppSettings>>,
        claim: OperationClaim,
        error: QuotaRpcError,
    ) -> Result<(), QuotaRpcError> {
        let mut state = self.lock();
        if state.generation != claim.generation || state.in_flight != Some(claim.request_id) {
            return Err(QuotaRpcError::Superseded);
        }
        // Keep claim validation and rollback atomic against disable and a
        // newer enable; a late failure must never stop the newer binding.
        let failure = rollback_enable_failure(app, settings_state, error);
        state.in_flight = None;
        Self::record_reauthorization_failure(&mut state, app, failure);
        Err(failure.error)
    }

    fn record_reauthorization_failure(
        state: &mut CoordinatorState,
        app: &AppContext,
        failure: ReauthorizationFailure,
    ) {
        if failure.rollback_failed {
            // Retry the durable stop write even though rollback already tried.
            // If storage is unavailable, the runtime block still prevents this
            // process from publishing until an explicit successful reauth.
            let _ = set_local_stop_active(app, true);
            state.sync_blocked = true;
            state.last_reason_code = Some(REMOTE_CLEAR_INCOMPLETE.to_string());
        } else {
            state.last_reason_code = Some(failure.error.reason_code().to_string());
        }
    }

    fn runtime_snapshot(&self) -> (bool, Option<String>) {
        let state = self.lock();
        (state.in_flight.is_some(), state.last_reason_code.clone())
    }

    fn background_sync_is_suppressed(&self) -> bool {
        let state = self.lock();
        state.last_reason_code.as_deref() == Some("quota_sync_auth_required")
    }

    fn sync_is_blocked(&self) -> bool {
        self.lock().sync_blocked
    }

    #[cfg(test)]
    fn has_runtime_remote_clear_pending(&self, now: DateTime<Utc>) -> bool {
        let mut state = self.lock();
        state
            .remote_clear_pending
            .retain(|_, expires_at| *expires_at > now.timestamp());
        !state.remote_clear_pending.is_empty()
    }
}

static QUOTA_SYNC_COORDINATOR: OnceLock<QuotaSyncCoordinator> = OnceLock::new();
static REMOTE_CLEAR_PENDING_STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static LOCAL_STATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static REMOTE_CLEAR_INTENT_COUNTER: AtomicU64 = AtomicU64::new(0);

fn coordinator() -> &'static QuotaSyncCoordinator {
    QUOTA_SYNC_COORDINATOR.get_or_init(QuotaSyncCoordinator::default)
}

/// A failed background session read must not be retried by the scheduler on
/// every five-minute tick. Explicit settings actions call `begin_sync` and
/// clear this marker before retrying, so the user keeps control over the next
/// Keychain prompt.
pub(crate) fn background_sync_is_suppressed() -> bool {
    coordinator().background_sync_is_suppressed()
}

fn remote_clear_pending_store_lock() -> MutexGuard<'static, ()> {
    REMOTE_CLEAR_PENDING_STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn with_remote_clear_pending_cross_process_lock<T>(
    app: &AppContext,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    const LOCK_ERROR: &str = "quota_sync_pending_lock_unavailable";
    const RELEASE_ERROR: &str = "quota_sync_pending_lock_release_failed";

    fs::create_dir_all(app.app_data_dir()).map_err(|_| LOCK_ERROR.to_string())?;
    let lock_path = app.app_data_dir().join(REMOTE_CLEAR_PENDING_LOCK_FILE);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    drop(
        options
            .open(&lock_path)
            .map_err(|_| LOCK_ERROR.to_string())?,
    );

    let metadata = fs::symlink_metadata(&lock_path).map_err(|_| LOCK_ERROR.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(LOCK_ERROR.to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.nlink() != 1 {
            return Err(LOCK_ERROR.to_string());
        }
        fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600))
            .map_err(|_| LOCK_ERROR.to_string())?;
    }

    let connection = Connection::open(&lock_path).map_err(|_| LOCK_ERROR.to_string())?;
    connection
        .busy_timeout(Duration::from_millis(
            REMOTE_CLEAR_PENDING_LOCK_TIMEOUT_MILLIS,
        ))
        .map_err(|_| LOCK_ERROR.to_string())?;
    connection
        .execute_batch(
            "BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS pending_lock (id INTEGER PRIMARY KEY);",
        )
        .map_err(|_| LOCK_ERROR.to_string())?;

    match action() {
        Ok(value) => {
            connection
                .execute_batch("COMMIT")
                .map_err(|_| RELEASE_ERROR.to_string())?;
            Ok(value)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn with_remote_clear_pending_store_lock<T>(
    app: &AppContext,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    // Lock order is coordinator/settings-state (when already held), then this
    // process mutex, then the short cross-process SQLite lock. The action is
    // limited to the pending JSON RMW; it never acquires settings/local-stop
    // locks and never performs network work, so no reverse edge is introduced.
    let _guard = remote_clear_pending_store_lock();
    with_remote_clear_pending_cross_process_lock(app, action)
}

fn local_state_process_lock() -> MutexGuard<'static, ()> {
    LOCAL_STATE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn with_local_state_cross_process_lock<T>(
    app: &AppContext,
    action: impl FnOnce() -> T,
) -> Result<T, String> {
    const LOCK_ERROR: &str = "quota_sync_local_state_lock_unavailable";
    const RELEASE_ERROR: &str = "quota_sync_local_state_lock_release_failed";

    fs::create_dir_all(app.app_data_dir()).map_err(|_| LOCK_ERROR.to_string())?;
    let lock_path = app.app_data_dir().join(LOCAL_STATE_LOCK_FILE);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    drop(
        options
            .open(&lock_path)
            .map_err(|_| LOCK_ERROR.to_string())?,
    );

    let metadata = fs::symlink_metadata(&lock_path).map_err(|_| LOCK_ERROR.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(LOCK_ERROR.to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.nlink() != 1 {
            return Err(LOCK_ERROR.to_string());
        }
        fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600))
            .map_err(|_| LOCK_ERROR.to_string())?;
    }

    let connection = Connection::open(&lock_path).map_err(|_| LOCK_ERROR.to_string())?;
    connection
        .busy_timeout(Duration::from_millis(LOCAL_STATE_LOCK_TIMEOUT_MILLIS))
        .map_err(|_| LOCK_ERROR.to_string())?;
    connection
        .execute_batch(
            "BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS local_state_lock (id INTEGER PRIMARY KEY);",
        )
        .map_err(|_| LOCK_ERROR.to_string())?;

    let value = action();
    connection
        .execute_batch("COMMIT")
        .map_err(|_| RELEASE_ERROR.to_string())?;
    Ok(value)
}

fn with_local_state_lock<T>(app: &AppContext, action: impl FnOnce() -> T) -> Result<T, String> {
    // Global lock order: coordinator/cloud-session lease (when already held),
    // then this local-state process/SQLite lock, then pending/settings locks.
    // Callers must never perform network work while this short transaction is
    // open. Nested local-state calls use the explicit `_unlocked` helpers.
    let _guard = local_state_process_lock();
    with_local_state_cross_process_lock(app, action)
}

fn valid_rfc3339(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok()
}

fn valid_string(value: &str, max_bytes: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.is_empty()) && value.len() <= max_bytes
}

fn next_remote_clear_intent_id() -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let counter = REMOTE_CLEAR_INTENT_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{:x}-{:x}", std::process::id(), timestamp, counter)
}

fn normalize_pending_identity(identity: &CloudIdentity) -> Option<CloudIdentity> {
    if !valid_string(&identity.user_id, MAX_STRING_BYTES, false)
        || identity.user_id.chars().any(char::is_control)
    {
        return None;
    }
    let url = reqwest::Url::parse(&identity.origin).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return None;
    }
    let origin = url.origin().ascii_serialization();
    if !valid_string(&origin, MAX_STRING_BYTES, false) {
        return None;
    }
    Some(CloudIdentity {
        origin,
        user_id: identity.user_id.clone(),
    })
}

fn write_remote_clear_pending_store_unlocked(
    app: &AppContext,
    entries: Vec<RemoteClearPendingEntry>,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(&RemoteClearPendingStore {
        schema_version: REMOTE_CLEAR_PENDING_SCHEMA_VERSION,
        entries,
    })
    .map_err(|_| "quota_sync_pending_invalid".to_string())?;
    if bytes.len() > MAX_REMOTE_CLEAR_PENDING_BYTES {
        return Err("quota_sync_pending_too_large".to_string());
    }
    quota::write_private_app_data_file(app.app_data_dir(), REMOTE_CLEAR_PENDING_FILE, &bytes)
}

fn load_remote_clear_pending_at_unlocked(
    app: &AppContext,
    now: DateTime<Utc>,
) -> Result<Vec<RemoteClearPendingEntry>, String> {
    let bytes = match quota::read_private_app_data_file(
        app.app_data_dir(),
        REMOTE_CLEAR_PENDING_FILE,
        MAX_REMOTE_CLEAR_PENDING_BYTES,
    ) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(Vec::new()),
        Err(_) => return Err("quota_sync_pending_read_failed".to_string()),
    };
    let store = serde_json::from_slice::<RemoteClearPendingStore>(&bytes)
        .map_err(|_| "quota_sync_pending_invalid".to_string())?;
    if store.schema_version != REMOTE_CLEAR_PENDING_SCHEMA_VERSION
        || store.entries.len() > MAX_REMOTE_CLEAR_PENDING_ENTRIES
    {
        return Err("quota_sync_pending_schema_unsupported".to_string());
    }

    let original_len = store.entries.len();
    let mut changed = false;
    let mut by_identity = HashMap::<CloudIdentity, RemoteClearPendingEntry>::new();
    for entry in store.entries {
        let identity = normalize_pending_identity(&CloudIdentity {
            origin: entry.supabase_origin.clone(),
            user_id: entry.user_id.clone(),
        })
        .ok_or_else(|| "quota_sync_pending_identity_invalid".to_string())?;
        let pending_since = DateTime::parse_from_rfc3339(&entry.pending_since)
            .ok()
            .map(|value| value.with_timezone(&Utc))
            .ok_or_else(|| "quota_sync_pending_timestamp_invalid".to_string())?;
        let expires_at = DateTime::parse_from_rfc3339(&entry.expires_at)
            .ok()
            .map(|value| value.with_timezone(&Utc))
            .ok_or_else(|| "quota_sync_pending_timestamp_invalid".to_string())?;
        if !valid_string(&entry.intent_id, MAX_REMOTE_CLEAR_INTENT_ID_BYTES, true)
            || entry.intent_id.chars().any(char::is_control)
        {
            return Err("quota_sync_pending_intent_invalid".to_string());
        }
        if pending_since > now + ChronoDuration::minutes(5)
            || expires_at <= pending_since
            || expires_at > pending_since + ChronoDuration::hours(REMOTE_CLEAR_PENDING_TTL_HOURS)
        {
            return Err("quota_sync_pending_timestamp_invalid".to_string());
        }
        if expires_at <= now {
            changed = true;
            continue;
        }
        let normalized = RemoteClearPendingEntry {
            supabase_origin: identity.origin.clone(),
            user_id: identity.user_id.clone(),
            intent_id: entry.intent_id.clone(),
            pending_since: pending_since.to_rfc3339(),
            expires_at: expires_at.to_rfc3339(),
        };
        if normalized.supabase_origin != entry.supabase_origin
            || normalized.pending_since != entry.pending_since
            || normalized.expires_at != entry.expires_at
        {
            changed = true;
        }
        match by_identity.get(&identity) {
            Some(existing) if existing.expires_at >= normalized.expires_at => {
                changed = true;
            }
            Some(_) => {
                changed = true;
                by_identity.insert(identity, normalized);
            }
            None => {
                by_identity.insert(identity, normalized);
            }
        }
    }
    let mut entries = by_identity.into_values().collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        left.supabase_origin
            .cmp(&right.supabase_origin)
            .then_with(|| left.user_id.cmp(&right.user_id))
    });
    if changed || entries.len() != original_len {
        write_remote_clear_pending_store_unlocked(app, entries.clone())?;
    }
    Ok(entries)
}

#[cfg(test)]
fn load_remote_clear_pending_at(
    app: &AppContext,
    now: DateTime<Utc>,
) -> Result<Vec<RemoteClearPendingEntry>, String> {
    with_remote_clear_pending_store_lock(app, || load_remote_clear_pending_at_unlocked(app, now))
}

fn persist_remote_clear_pending_at_under_local_state(
    app: &AppContext,
    identity: &CloudIdentity,
    now: DateTime<Utc>,
) -> Result<(), String> {
    with_remote_clear_pending_store_lock(app, || {
        let identity = normalize_pending_identity(identity)
            .ok_or_else(|| "quota_sync_pending_identity_invalid".to_string())?;
        let mut entries = load_remote_clear_pending_at_unlocked(app, now)?;
        entries.retain(|entry| {
            entry.supabase_origin != identity.origin || entry.user_id != identity.user_id
        });
        if entries.len() >= MAX_REMOTE_CLEAR_PENDING_ENTRIES {
            return Err("quota_sync_pending_too_many_identities".to_string());
        }
        entries.push(RemoteClearPendingEntry {
            supabase_origin: identity.origin,
            user_id: identity.user_id,
            intent_id: next_remote_clear_intent_id(),
            pending_since: now.to_rfc3339(),
            expires_at: (now + ChronoDuration::hours(REMOTE_CLEAR_PENDING_TTL_HOURS)).to_rfc3339(),
        });
        write_remote_clear_pending_store_unlocked(app, entries)
    })
}

fn persist_remote_clear_pending_at(
    app: &AppContext,
    identity: &CloudIdentity,
    now: DateTime<Utc>,
) -> Result<(), String> {
    with_local_state_lock(app, || {
        persist_remote_clear_pending_at_under_local_state(app, identity, now)
    })
    .and_then(|result| result)
}

#[cfg(test)]
fn remove_remote_clear_pending_at_under_local_state(
    app: &AppContext,
    identity: &CloudIdentity,
    now: DateTime<Utc>,
) -> Result<(), String> {
    with_remote_clear_pending_store_lock(app, || {
        let identity = normalize_pending_identity(identity)
            .ok_or_else(|| "quota_sync_pending_identity_invalid".to_string())?;
        let mut entries = load_remote_clear_pending_at_unlocked(app, now)?;
        entries.retain(|entry| {
            entry.supabase_origin != identity.origin || entry.user_id != identity.user_id
        });
        write_remote_clear_pending_store_unlocked(app, entries)
    })
}

#[cfg(test)]
fn remove_remote_clear_pending_at(
    app: &AppContext,
    identity: &CloudIdentity,
    now: DateTime<Utc>,
) -> Result<(), String> {
    with_local_state_lock(app, || {
        remove_remote_clear_pending_at_under_local_state(app, identity, now)
    })
    .and_then(|result| result)
}

#[cfg(test)]
fn remote_clear_pending_intent_id_under_local_state(
    app: &AppContext,
    identity: &CloudIdentity,
    now: DateTime<Utc>,
) -> Result<Option<String>, String> {
    with_remote_clear_pending_store_lock(app, || {
        let identity = normalize_pending_identity(identity)
            .ok_or_else(|| "quota_sync_pending_identity_invalid".to_string())?;
        Ok(load_remote_clear_pending_at_unlocked(app, now)?
            .into_iter()
            .find(|entry| {
                entry.supabase_origin == identity.origin && entry.user_id == identity.user_id
            })
            .map(|entry| entry.intent_id))
    })
}

#[cfg(test)]
fn remove_remote_clear_pending_if_intent_matches_under_local_state(
    app: &AppContext,
    identity: &CloudIdentity,
    expected_intent_id: Option<&str>,
    now: DateTime<Utc>,
) -> Result<bool, String> {
    let Some(expected_intent_id) = expected_intent_id else {
        return Ok(false);
    };
    with_remote_clear_pending_store_lock(app, || {
        let identity = normalize_pending_identity(identity)
            .ok_or_else(|| "quota_sync_pending_identity_invalid".to_string())?;
        let mut entries = load_remote_clear_pending_at_unlocked(app, now)?;
        let original_len = entries.len();
        entries.retain(|entry| {
            entry.supabase_origin != identity.origin
                || entry.user_id != identity.user_id
                || entry.intent_id != expected_intent_id
        });
        let removed = entries.len() != original_len;
        if removed {
            write_remote_clear_pending_store_unlocked(app, entries)?;
        }
        Ok(removed)
    })
}

#[cfg(test)]
fn has_remote_clear_pending_at(
    app: &AppContext,
    sync_coordinator: &QuotaSyncCoordinator,
    now: DateTime<Utc>,
) -> bool {
    sync_coordinator.has_runtime_remote_clear_pending(now)
        || load_remote_clear_pending_at(app, now)
            .map(|entries| !entries.is_empty())
            .unwrap_or(true)
}

fn write_local_stop_store_unlocked(app: &AppContext, active: bool) -> Result<(), String> {
    let bytes = serde_json::to_vec(&LocalStopStore {
        schema_version: LOCAL_STOP_SCHEMA_VERSION,
        active,
    })
    .map_err(|_| "quota_sync_local_stop_invalid".to_string())?;
    if bytes.len() > MAX_LOCAL_STOP_BYTES {
        return Err("quota_sync_local_stop_too_large".to_string());
    }
    quota::write_private_app_data_file(app.app_data_dir(), LOCAL_STOP_FILE, &bytes)
}

fn load_local_stop_active_unlocked(app: &AppContext) -> Result<bool, String> {
    let bytes = match quota::read_private_app_data_file(
        app.app_data_dir(),
        LOCAL_STOP_FILE,
        MAX_LOCAL_STOP_BYTES,
    ) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(false),
        Err(_) => return Err("quota_sync_local_stop_read_failed".to_string()),
    };
    let store = serde_json::from_slice::<LocalStopStore>(&bytes)
        .map_err(|_| "quota_sync_local_stop_invalid".to_string())?;
    if store.schema_version != LOCAL_STOP_SCHEMA_VERSION {
        return Err("quota_sync_local_stop_schema_unsupported".to_string());
    }
    Ok(store.active)
}

fn set_local_stop_active(app: &AppContext, active: bool) -> Result<(), String> {
    with_local_state_lock(app, || write_local_stop_store_unlocked(app, active))
        .and_then(|result| result)
}

fn has_local_stop_pending(app: &AppContext) -> bool {
    with_local_state_lock(app, || load_local_stop_active_unlocked(app))
        .and_then(|result| result)
        .unwrap_or(true)
}

#[cfg(test)]
fn has_any_cleanup_pending_at(
    app: &AppContext,
    sync_coordinator: &QuotaSyncCoordinator,
    now: DateTime<Utc>,
) -> bool {
    has_local_stop_pending(app) || has_remote_clear_pending_at(app, sync_coordinator, now)
}

fn reason_code_registered(value: &str) -> bool {
    if quota::BALANCE_REASON_CODES.contains(&value) {
        return true;
    }
    matches!(
        value,
        "local_authorization_required"
            | "app_server_unavailable"
            | "app_server_timeout"
            | "app_server_auth_required"
            | "consumer_api_unavailable"
            | "source_not_found"
            | "permission_denied"
            | "secure_storage_unavailable"
            | "source_schema_unsupported"
            | "source_scan_truncated"
            | "source_temporarily_unavailable"
            | "provider_worker_failed"
            | "provider_cache_unavailable"
            | "claude_local_authorization_required"
            | "claude_statusline_snapshot_missing"
            | "claude_statusline_snapshot_invalid"
            | "claude_codexbar_unavailable"
            | "claude_codexbar_timeout"
            | "claude_codexbar_response_invalid"
            | "reset_elapsed"
            | "observation_stale"
            | "credits_unlimited"
            | "admin_key_required"
            | "rate_limited"
            | "upstream_unavailable"
    )
}

/// Local-only failure codes that quota-provider-v1 §4 lets ride on LKG
/// `stale` snapshots. They are not part of the cloud wire enum, and released
/// readers reject unknown codes, so the upload carries the generic
/// `source_temporarily_unavailable` instead; the local display keeps the
/// precise code.
fn local_only_stale_reason(value: &str) -> bool {
    matches!(
        value,
        "claude_native_authorization_required"
            | "claude_native_cli_unavailable"
            | "claude_native_timeout"
            | "claude_native_usage_unavailable"
            | "claude_native_subscription_unavailable"
            | "claude_native_response_invalid"
            | "antigravity_native_authorization_required"
            | "antigravity_native_source_not_found"
            | "antigravity_native_port_unavailable"
            | "antigravity_native_timeout"
            | "antigravity_native_response_invalid"
            | "antigravity_codexbar_unavailable"
            | "antigravity_codexbar_timeout"
            | "antigravity_codexbar_response_invalid"
    )
}

fn cloud_reason_code(reason: &Option<String>) -> Option<String> {
    reason.as_deref().map(|value| {
        if !reason_code_registered(value) && local_only_stale_reason(value) {
            "source_temporarily_unavailable".to_string()
        } else {
            value.to_string()
        }
    })
}

fn approximately_equal(left: f64, right: f64) -> bool {
    let scale = left.abs().max(right.abs()).max(1.0);
    (left - right).abs() <= f64::EPSILON * scale * 16.0
}

fn validate_window_values(window: &SyncedQuotaWindow) -> bool {
    let values = [window.used, window.limit, window.remaining];
    if values
        .iter()
        .flatten()
        .any(|value| !value.is_finite() || *value < 0.0)
    {
        return false;
    }
    if window.reason_code.as_deref() == Some("credits_unlimited") {
        return window.unit == QuotaUnit::Credits
            && window.used.is_none()
            && window.limit.is_none()
            && window.remaining.is_none();
    }
    if window.unit == QuotaUnit::Percent {
        let Some(used) = window.used else {
            return false;
        };
        if used > 100.0 || window.limit.is_some_and(|limit| limit != 100.0) {
            return false;
        }
        return window.remaining.is_none_or(|remaining| {
            remaining <= 100.0 && approximately_equal(remaining, 100.0 - used)
        });
    }
    if window.used.is_none() && window.limit.is_none() && window.remaining.is_none() {
        return false;
    }
    if let (Some(used), Some(limit)) = (window.used, window.limit) {
        if used > limit {
            return false;
        }
    }
    if let (Some(remaining), Some(limit)) = (window.remaining, window.limit) {
        if remaining > limit {
            return false;
        }
    }
    match (window.used, window.limit, window.remaining) {
        (Some(used), Some(limit), Some(remaining)) => approximately_equal(remaining, limit - used),
        _ => true,
    }
}

fn scope_key(scope: QuotaScope) -> &'static str {
    match scope {
        QuotaScope::ConsumerSubscription => "consumer-subscription",
        QuotaScope::ApiOrganization => "api-organization",
        QuotaScope::ManualBudget => "manual-budget",
    }
}

fn supported_transport(transport_version: u8) -> bool {
    transport_version == TRANSPORT_VERSION || transport_version == CURRENCY_TRANSPORT_VERSION
}

fn window_currency_allowed(window: &SyncedQuotaWindow, transport_version: u8) -> bool {
    (window.unit != QuotaUnit::Currency || transport_version >= CURRENCY_TRANSPORT_VERSION)
        && quota::currency_fields_valid(
            window.unit,
            window.currency.as_deref(),
            window.window_minutes,
            window.resets_at.as_deref(),
            window.reason_code.as_deref(),
        )
}

fn provider_has_currency(provider: &SyncedQuotaProvider) -> bool {
    provider
        .windows
        .iter()
        .any(|window| window.unit == QuotaUnit::Currency)
}

/// Contract §6.1: an old cloud cannot accept currency windows, so the whole
/// envelope is withheld from the v2 upload while other Providers still sync.
fn strip_currency_providers(projected: Vec<SyncedQuotaProvider>) -> Vec<SyncedQuotaProvider> {
    projected
        .into_iter()
        .filter(|provider| !provider_has_currency(provider))
        .collect()
}

/// Contract §2.2 rule 5 for v3 readers: a window whose `unit` this build does
/// not recognize is dropped on its own. The envelope survives while it still
/// satisfies the status invariants (an `ok` envelope that lost its only fresh
/// window degrades to `stale`); otherwise it is omitted like an unsynced one.
fn prune_unknown_unit_windows(value: &mut Value) {
    let Some(providers) = value.get_mut("providers").and_then(Value::as_array_mut) else {
        return;
    };
    providers.retain_mut(|provider| {
        let Some(windows) = provider.get_mut("windows").and_then(Value::as_array_mut) else {
            return true;
        };
        let before = windows.len();
        windows.retain(|window| {
            window
                .get("unit")
                .and_then(Value::as_str)
                .is_none_or(|unit| quota::QUOTA_KNOWN_UNITS.contains(&unit))
        });
        if windows.len() == before {
            return true;
        }
        let has_status = |status: &str| {
            windows
                .iter()
                .any(|window| window.get("status").and_then(Value::as_str) == Some(status))
        };
        let (has_ok, has_stale) = (has_status("ok"), has_status("stale"));
        match provider.get("status").and_then(Value::as_str) {
            Some("ok") if has_ok => true,
            Some("ok") | Some("stale") if has_stale => {
                provider["status"] = Value::String("stale".to_string());
                true
            }
            _ => false,
        }
    });
}

fn validate_synced_providers(
    providers: &[SyncedQuotaProvider],
    transport_version: u8,
) -> Result<(), &'static str> {
    if !supported_transport(transport_version) {
        return Err("quota_sync_unsupported_transport");
    }
    if providers.len() > MAX_PROVIDERS {
        return Err("quota_sync_invalid_provider_count");
    }
    let mut provider_keys = HashSet::new();
    let mut window_keys = HashSet::new();
    for provider in providers {
        if provider.schema_version != 1
            || !valid_string(&provider.provider_id, MAX_STABLE_ID_BYTES, false)
            || !valid_string(&provider.display_name, MAX_STRING_BYTES, false)
            || provider.windows.len() > MAX_WINDOWS_PER_PROVIDER
            || provider.reason_code.as_deref().is_some_and(|reason| {
                !valid_string(reason, MAX_STRING_BYTES, false) || !reason_code_registered(reason)
            })
        {
            return Err("quota_sync_invalid_provider");
        }
        let provider_key = format!("{}:{}", provider.provider_id, scope_key(provider.scope));
        if !provider_keys.insert(provider_key) {
            return Err("quota_sync_duplicate_provider");
        }
        if provider.status == QuotaStatus::Unsupported {
            if provider.mode != QuotaMode::Unsupported
                || provider.capability != QuotaCapability::Unsupported
                || !provider.windows.is_empty()
                || provider.reason_code.is_none()
            {
                return Err("quota_sync_invalid_provider_status");
            }
            continue;
        }
        if provider.mode == QuotaMode::Unsupported
            || provider.capability == QuotaCapability::Unsupported
        {
            return Err("quota_sync_invalid_provider_status");
        }
        let manual = provider.mode == QuotaMode::Manual;
        if manual != (provider.capability == QuotaCapability::Manual)
            || manual != (provider.scope == QuotaScope::ManualBudget)
        {
            return Err("quota_sync_invalid_provider_mode");
        }
        if matches!(
            provider.status,
            QuotaStatus::AuthRequired | QuotaStatus::Error
        ) {
            if !provider.windows.is_empty() {
                return Err("quota_sync_invalid_provider_status");
            }
            continue;
        }
        if provider.windows.is_empty() {
            return Err("quota_sync_invalid_provider_status");
        }

        let mut has_ok = false;
        let mut has_stale = false;
        for window in &provider.windows {
            if window.provider_id != provider.provider_id
                || window.scope != provider.scope
                || !valid_string(&window.provider_id, MAX_STABLE_ID_BYTES, false)
                || !valid_string(&window.window_id, MAX_STABLE_ID_BYTES, false)
                || !valid_string(&window.window_label, MAX_STRING_BYTES, false)
                || !valid_string(&window.observed_at, MAX_STRING_BYTES, false)
                || !valid_string(&window.fetched_at, MAX_STRING_BYTES, false)
                || !valid_rfc3339(&window.observed_at)
                || !valid_rfc3339(&window.fetched_at)
                || window.stale_after_seconds == 0
                || window.stale_after_seconds > MAX_TIMELINE_INTEGER
                || window
                    .window_minutes
                    .is_some_and(|minutes| minutes == 0 || minutes > MAX_TIMELINE_INTEGER)
                || window.resets_at.as_deref().is_some_and(|value| {
                    !valid_string(value, MAX_STRING_BYTES, false) || !valid_rfc3339(value)
                })
                || window.reason_code.as_deref().is_some_and(|reason| {
                    !valid_string(reason, MAX_STRING_BYTES, false)
                        || !reason_code_registered(reason)
                })
                || manual != (window.source == QuotaSource::Manual)
                || match provider.scope {
                    QuotaScope::ConsumerSubscription => {
                        window.source != QuotaSource::LocalAuthorized
                    }
                    QuotaScope::ApiOrganization => window.source != QuotaSource::OfficialApi,
                    QuotaScope::ManualBudget => window.source != QuotaSource::Manual,
                }
                || !window_currency_allowed(window, transport_version)
            {
                return Err("quota_sync_invalid_window");
            }
            let window_key = format!(
                "{}:{}:{}",
                window.provider_id,
                scope_key(window.scope),
                window.window_id
            );
            if !window_keys.insert(window_key) {
                return Err("quota_sync_duplicate_window");
            }
            match window.status {
                QuotaWindowStatus::Ok => {
                    has_ok = true;
                    if !validate_window_values(window) {
                        return Err("quota_sync_invalid_window_values");
                    }
                }
                QuotaWindowStatus::Stale => {
                    has_stale = true;
                    if !validate_window_values(window) {
                        return Err("quota_sync_invalid_window_values");
                    }
                }
                QuotaWindowStatus::AuthRequired | QuotaWindowStatus::Error => {
                    if window.used.is_some() || window.limit.is_some() || window.remaining.is_some()
                    {
                        return Err("quota_sync_invalid_window_values");
                    }
                }
            }
        }
        if (provider.status == QuotaStatus::Ok && !has_ok)
            || (provider.status == QuotaStatus::Stale && !has_stale)
        {
            return Err("quota_sync_invalid_provider_status");
        }
    }
    Ok(())
}

fn project_provider(provider: &QuotaProviderEnvelope) -> SyncedQuotaProvider {
    SyncedQuotaProvider {
        schema_version: provider.schema_version,
        provider_id: provider.provider_id.clone(),
        display_name: provider.display_name.clone(),
        scope: provider.scope,
        mode: provider.mode,
        capability: provider.capability,
        status: provider.status,
        windows: provider
            .windows
            .iter()
            .map(|window| SyncedQuotaWindow {
                provider_id: window.provider_id.clone(),
                window_id: window.window_id.clone(),
                window_label: window.window_label.clone(),
                scope: window.scope,
                source: window.source,
                status: window.status,
                used: window.used,
                limit: window.limit,
                remaining: window.remaining,
                unit: window.unit,
                currency: window.currency.clone(),
                window_minutes: window.window_minutes,
                resets_at: window.resets_at.clone(),
                observed_at: window.observed_at.clone(),
                fetched_at: window.fetched_at.clone(),
                stale_after_seconds: window.stale_after_seconds,
                reason_code: cloud_reason_code(&window.reason_code),
            })
            .collect(),
        reason_code: cloud_reason_code(&provider.reason_code),
    }
}

/// `enabled_balances` is the set of vendor balance Provider IDs the user has
/// switched on; enabling a balance source is its sync authorization.
fn provider_is_authorized(
    provider_id: &str,
    settings: &AppSettings,
    enabled_balances: &HashSet<String>,
) -> bool {
    match provider_id {
        quota::CODEX_PROVIDER_ID => settings.quota_codex_local_enabled,
        quota::CLAUDE_PROVIDER_ID => claude_provider_enabled(settings),
        quota::ANTIGRAVITY_PROVIDER_ID => antigravity_provider_enabled(settings),
        _ if quota::balance::is_balance_provider_id(provider_id) => {
            enabled_balances.contains(provider_id)
        }
        _ => quota::custom::is_sync_enabled_provider(provider_id, &settings.quota_custom_endpoints),
    }
}

fn build_projection(
    providers: &[QuotaProviderEnvelope],
    settings: &AppSettings,
    enabled_balances: &HashSet<String>,
    transport_version: u8,
) -> Result<(Vec<SyncedQuotaProvider>, Vec<u8>), String> {
    let projected = providers
        .iter()
        .filter(|provider| {
            provider_is_authorized(&provider.provider_id, settings, enabled_balances)
        })
        .filter(|provider| {
            matches!(provider.status, QuotaStatus::Ok | QuotaStatus::Stale)
                && !provider.windows.is_empty()
        })
        .map(project_provider)
        .collect::<Vec<_>>();
    let projected = if transport_version >= CURRENCY_TRANSPORT_VERSION {
        projected
    } else {
        strip_currency_providers(projected)
    };
    let bytes = encode_projection(&projected, transport_version)?;
    Ok((projected, bytes))
}

fn encode_projection(
    projected: &[SyncedQuotaProvider],
    transport_version: u8,
) -> Result<Vec<u8>, String> {
    validate_synced_providers(projected, transport_version).map_err(str::to_string)?;
    let bytes =
        serde_json::to_vec(&projected).map_err(|_| "quota_sync_invalid_payload".to_string())?;
    if bytes.len() > PRODUCER_MAX_BYTES {
        return Err("quota_sync_payload_too_large".to_string());
    }
    Ok(bytes)
}

fn provider_key(provider_id: &str, scope: QuotaScope) -> String {
    format!("{provider_id}:{}", scope_key(scope))
}

fn provider_source_observed_at(provider: &SyncedQuotaProvider) -> Option<DateTime<Utc>> {
    provider
        .windows
        .iter()
        .filter_map(|window| DateTime::parse_from_rfc3339(&window.observed_at).ok())
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .max()
}

/// v2 responses list exactly one active state per returned envelope. v3
/// readers may have dropped an envelope (or the newest window) that carried
/// an unknown unit, so an active state may lack its envelope and a kept
/// envelope's newest window may predate the state's source time.
fn validate_provider_states(
    providers: &[SyncedQuotaProvider],
    states: &[QuotaProviderState],
    transport_version: u8,
) -> Result<(), QuotaRpcError> {
    let pruned_reader = transport_version >= CURRENCY_TRANSPORT_VERSION;
    let mut state_keys = HashSet::new();
    for state in states {
        if !valid_string(&state.provider_id, MAX_STABLE_ID_BYTES, false)
            || state.generation > MAX_SAFE_INTEGER
            || !valid_rfc3339(&state.received_at)
            || state
                .source_observed_at
                .as_deref()
                .is_some_and(|value| !valid_rfc3339(value))
            || (state.deleted && state.source_observed_at.is_some())
            || (!state.deleted && state.source_observed_at.is_none())
            || !state_keys.insert(provider_key(&state.provider_id, state.scope))
        {
            return Err(QuotaRpcError::InvalidResponse);
        }
    }
    let active_states = states.iter().filter(|state| !state.deleted).count();
    // Tombstones preserve generation and must not consume the active capacity.
    if active_states > MAX_PROVIDERS
        || active_states < providers.len()
        || (!pruned_reader && active_states != providers.len())
    {
        return Err(QuotaRpcError::InvalidResponse);
    }
    for provider in providers {
        if !matches!(provider.status, QuotaStatus::Ok | QuotaStatus::Stale)
            || provider.windows.is_empty()
        {
            return Err(QuotaRpcError::InvalidResponse);
        }
        let key = provider_key(&provider.provider_id, provider.scope);
        let Some(state) = states
            .iter()
            .find(|state| provider_key(&state.provider_id, state.scope) == key)
        else {
            return Err(QuotaRpcError::InvalidResponse);
        };
        let observed =
            provider_source_observed_at(provider).ok_or(QuotaRpcError::InvalidResponse)?;
        let state_observed = state
            .source_observed_at
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|timestamp| timestamp.with_timezone(&Utc))
            .ok_or(QuotaRpcError::InvalidResponse)?;
        let observed_matches = if pruned_reader {
            observed <= state_observed
        } else {
            observed == state_observed
        };
        if state.deleted || !observed_matches {
            return Err(QuotaRpcError::InvalidResponse);
        }
    }
    Ok(())
}

fn build_upsert_entries(
    projected: Vec<SyncedQuotaProvider>,
    states: &[QuotaProviderState],
) -> Result<Vec<QuotaUpsertEntry>, QuotaRpcError> {
    let mut entries = Vec::with_capacity(projected.len());
    for envelope in projected {
        let key = provider_key(&envelope.provider_id, envelope.scope);
        let state = states
            .iter()
            .find(|state| provider_key(&state.provider_id, state.scope) == key);
        let generation = state.map_or(0, |state| state.generation);
        if let Some(tombstone) = state.filter(|state| state.deleted) {
            let observed =
                provider_source_observed_at(&envelope).ok_or(QuotaRpcError::InvalidPayload)?;
            let deleted_at = DateTime::parse_from_rfc3339(&tombstone.received_at)
                .map_err(|_| QuotaRpcError::InvalidResponse)?
                .with_timezone(&Utc);
            // A snapshot captured before an explicit delete is never allowed
            // to resurrect the Provider. A genuinely newer local observation
            // may publish again using the current generation.
            if observed <= deleted_at {
                continue;
            }
        }
        entries.push(QuotaUpsertEntry {
            generation,
            envelope,
        });
    }
    let bytes = serde_json::to_vec(&entries).map_err(|_| QuotaRpcError::InvalidPayload)?;
    if bytes.len() > PRODUCER_MAX_BYTES {
        return Err(QuotaRpcError::PayloadTooLarge);
    }
    Ok(entries)
}

fn validate_binding(binding: &QuotaSyncBinding) -> bool {
    binding.schema_version == BINDING_SCHEMA_VERSION
        && binding.transport_version == TRANSPORT_VERSION
        && valid_string(&binding.supabase_origin, MAX_STRING_BYTES, false)
        && valid_string(&binding.user_id, MAX_STRING_BYTES, false)
        && binding.epoch <= MAX_SAFE_INTEGER
        && binding.revision <= MAX_SAFE_INTEGER
        && binding.last_synced_at.as_deref().is_none_or(valid_rfc3339)
}

fn load_binding_result(app: &AppContext) -> Result<Option<QuotaSyncBinding>, String> {
    let bytes = match quota::read_private_app_data_file(
        app.app_data_dir(),
        BINDING_FILE,
        MAX_BINDING_BYTES,
    ) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(None),
        Err(_) => return Err("quota_sync_binding_read_failed".to_string()),
    };
    let binding = serde_json::from_slice::<QuotaSyncBinding>(&bytes)
        .map_err(|_| "quota_sync_invalid_binding".to_string())?;
    if !validate_binding(&binding) {
        return Err("quota_sync_invalid_binding".to_string());
    }
    Ok(Some(binding))
}

fn load_binding(app: &AppContext) -> Option<QuotaSyncBinding> {
    load_binding_result(app).ok().flatten()
}

fn save_binding(app: &AppContext, binding: &QuotaSyncBinding) -> Result<(), String> {
    if !validate_binding(binding) {
        return Err("quota_sync_invalid_binding".to_string());
    }
    let bytes =
        serde_json::to_vec(binding).map_err(|_| "quota_sync_invalid_binding".to_string())?;
    quota::write_private_app_data_file(app.app_data_dir(), BINDING_FILE, &bytes)
}

fn clear_binding(app: &AppContext) {
    quota::remove_private_app_data_file(app.app_data_dir(), BINDING_FILE);
}

fn clear_binding_checked(app: &AppContext) -> Result<(), String> {
    clear_binding(app);
    match quota::read_private_app_data_file(app.app_data_dir(), BINDING_FILE, MAX_BINDING_BYTES) {
        Ok(None) => Ok(()),
        Ok(Some(_)) | Err(_) => Err("quota_sync_binding_clear_unconfirmed".to_string()),
    }
}

fn validate_remote_cache(cache: &RemoteQuotaCache) -> Result<(), String> {
    if cache.schema_version != REMOTE_CACHE_SCHEMA_VERSION
        || !supported_transport(cache.transport_version)
        || !valid_string(&cache.supabase_origin, MAX_STRING_BYTES, false)
        || !valid_string(&cache.user_id, MAX_STRING_BYTES, false)
        || cache.epoch > MAX_SAFE_INTEGER
        || cache.revision > MAX_SAFE_INTEGER
        || !valid_rfc3339(&cache.generated_at)
    {
        return Err("quota_sync_invalid_remote_cache".to_string());
    }
    validate_synced_providers(&cache.providers, cache.transport_version)
        .map_err(|_| "quota_sync_invalid_remote_cache".to_string())?;
    validate_provider_states(
        &cache.providers,
        &cache.provider_states,
        cache.transport_version,
    )
    .map_err(|_| "quota_sync_invalid_remote_cache".to_string())
}

fn save_remote_cache(app: &AppContext, cache: &RemoteQuotaCache) -> Result<(), String> {
    validate_remote_cache(cache)?;
    let bytes =
        serde_json::to_vec(cache).map_err(|_| "quota_sync_invalid_remote_cache".to_string())?;
    if bytes.len() > MAX_REMOTE_CACHE_BYTES {
        return Err("quota_sync_remote_cache_too_large".to_string());
    }
    quota::write_private_app_data_file(app.app_data_dir(), REMOTE_CACHE_FILE, &bytes)
}

#[cfg(not(test))]
fn load_remote_cache(app: &AppContext) -> Result<Option<RemoteQuotaCache>, String> {
    let bytes = match quota::read_private_app_data_file(
        app.app_data_dir(),
        REMOTE_CACHE_FILE,
        MAX_REMOTE_CACHE_BYTES,
    ) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(None),
        Err(_) => return Err("quota_sync_remote_cache_read_failed".to_string()),
    };
    let cache = serde_json::from_slice::<RemoteQuotaCache>(&bytes)
        .map_err(|_| "quota_sync_invalid_remote_cache".to_string())?;
    validate_remote_cache(&cache)?;
    Ok(Some(cache))
}

fn clear_remote_cache(app: &AppContext) {
    quota::remove_private_app_data_file(app.app_data_dir(), REMOTE_CACHE_FILE);
}

fn remote_cache_from_get(
    identity: &CloudIdentity,
    response: &GetQuotaSnapshotsResponse,
) -> RemoteQuotaCache {
    RemoteQuotaCache {
        schema_version: REMOTE_CACHE_SCHEMA_VERSION,
        transport_version: response.transport_version,
        supabase_origin: identity.origin.clone(),
        user_id: identity.user_id.clone(),
        epoch: response.epoch,
        revision: response.revision,
        generated_at: response.generated_at.clone(),
        providers: response.providers.clone(),
        provider_states: response.provider_states.clone(),
    }
}

fn binding_from_remote(
    identity: &CloudIdentity,
    epoch: u64,
    revision: u64,
    last_synced_at: Option<String>,
) -> QuotaSyncBinding {
    QuotaSyncBinding {
        schema_version: BINDING_SCHEMA_VERSION,
        transport_version: TRANSPORT_VERSION,
        supabase_origin: identity.origin.clone(),
        user_id: identity.user_id.clone(),
        epoch,
        revision,
        last_synced_at,
    }
}

fn remote_cache_from_upsert(
    identity: &CloudIdentity,
    response: &UpsertQuotaSnapshotsResponse,
) -> RemoteQuotaCache {
    RemoteQuotaCache {
        schema_version: REMOTE_CACHE_SCHEMA_VERSION,
        transport_version: response.transport_version,
        supabase_origin: identity.origin.clone(),
        user_id: identity.user_id.clone(),
        epoch: response.epoch,
        revision: response.revision,
        generated_at: response.generated_at.clone(),
        providers: response.providers.clone(),
        provider_states: response.provider_states.clone(),
    }
}

/// The delete RPC answers with the v2 projection, which omits currency
/// envelopes together with their states. When the preceding read used v3,
/// those untouched Providers are carried over so the cache does not briefly
/// forget balances that are still stored in the cloud.
fn remote_cache_from_delete(
    identity: &CloudIdentity,
    response: &DeleteQuotaProviderResponse,
    remote_before: &GetQuotaSnapshotsResponse,
) -> RemoteQuotaCache {
    let mut providers = response.providers.clone();
    let mut provider_states = response.provider_states.clone();
    let transport_version = if remote_before.transport_version >= CURRENCY_TRANSPORT_VERSION {
        let projected_keys = provider_states
            .iter()
            .map(|state| provider_key(&state.provider_id, state.scope))
            .collect::<HashSet<_>>();
        for state in &remote_before.provider_states {
            let key = provider_key(&state.provider_id, state.scope);
            if projected_keys.contains(&key) {
                continue;
            }
            if let Some(provider) = remote_before.providers.iter().find(|provider| {
                provider_key(&provider.provider_id, provider.scope) == key
                    && provider_has_currency(provider)
            }) {
                providers.push(provider.clone());
                provider_states.push(state.clone());
            }
        }
        CURRENCY_TRANSPORT_VERSION
    } else {
        response.transport_version
    };
    RemoteQuotaCache {
        schema_version: REMOTE_CACHE_SCHEMA_VERSION,
        transport_version,
        supabase_origin: identity.origin.clone(),
        user_id: identity.user_id.clone(),
        epoch: response.epoch,
        revision: response.revision,
        generated_at: response.generated_at.clone(),
        providers,
        provider_states,
    }
}

fn synced_provider_into_display(
    provider: &SyncedQuotaProvider,
    now: DateTime<Utc>,
) -> QuotaProviderEnvelope {
    let mut windows = provider
        .windows
        .iter()
        .map(|window| {
            let observed = DateTime::parse_from_rfc3339(&window.observed_at)
                .ok()
                .map(|value| value.with_timezone(&Utc));
            let expired = window.status == QuotaWindowStatus::Ok
                && observed.is_none_or(|value| {
                    value + ChronoDuration::seconds(window.stale_after_seconds as i64) <= now
                });
            quota::QuotaWindowSnapshot {
                provider_id: window.provider_id.clone(),
                window_id: window.window_id.clone(),
                window_label: window.window_label.clone(),
                account_label: None,
                scope: window.scope,
                source: window.source,
                status: if expired {
                    QuotaWindowStatus::Stale
                } else {
                    window.status
                },
                used: window.used,
                limit: window.limit,
                remaining: window.remaining,
                unit: window.unit,
                currency: window.currency.clone(),
                window_minutes: window.window_minutes,
                resets_at: window.resets_at.clone(),
                observed_at: window.observed_at.clone(),
                fetched_at: window.fetched_at.clone(),
                stale_after_seconds: window.stale_after_seconds,
                reason_code: if expired {
                    Some("observation_stale".to_string())
                } else {
                    window.reason_code.clone()
                },
            }
        })
        .collect::<Vec<_>>();
    let has_ok = windows
        .iter()
        .any(|window| window.status == QuotaWindowStatus::Ok);
    let status = if has_ok {
        QuotaStatus::Ok
    } else if windows
        .iter()
        .any(|window| window.status == QuotaWindowStatus::Stale)
    {
        QuotaStatus::Stale
    } else {
        provider.status
    };
    if status == QuotaStatus::Stale {
        for window in &mut windows {
            if window.status == QuotaWindowStatus::Ok {
                window.status = QuotaWindowStatus::Stale;
                window.reason_code = Some("observation_stale".to_string());
            }
        }
    }
    QuotaProviderEnvelope {
        schema_version: provider.schema_version,
        provider_id: provider.provider_id.clone(),
        display_name: provider.display_name.clone(),
        scope: provider.scope,
        mode: provider.mode,
        capability: provider.capability,
        status,
        windows,
        reason_code: if status == QuotaStatus::Stale {
            Some("observation_stale".to_string())
        } else {
            provider.reason_code.clone()
        },
        action: None,
    }
}

fn quota_provider_observed_at(provider: &QuotaProviderEnvelope) -> Option<DateTime<Utc>> {
    provider
        .windows
        .iter()
        .filter_map(|window| DateTime::parse_from_rfc3339(&window.observed_at).ok())
        .map(|value| value.with_timezone(&Utc))
        .max()
}

fn quota_provider_usable(provider: &QuotaProviderEnvelope) -> bool {
    matches!(provider.status, QuotaStatus::Ok | QuotaStatus::Stale) && !provider.windows.is_empty()
}

fn merge_provider_sets(
    mut local: Vec<QuotaProviderEnvelope>,
    remote: Vec<QuotaProviderEnvelope>,
) -> Vec<QuotaProviderEnvelope> {
    for remote in remote {
        let key = provider_key(&remote.provider_id, remote.scope);
        match local
            .iter()
            .position(|provider| provider_key(&provider.provider_id, provider.scope) == key)
        {
            Some(index) => {
                if remote.provider_id == quota::CLAUDE_PROVIDER_ID {
                    if let Some(merged) = quota::merge_claude_provider_envelopes(&[
                        local[index].clone(),
                        remote.clone(),
                    ]) {
                        local[index] = merged;
                        continue;
                    }
                }
                let local_observed = quota_provider_observed_at(&local[index]);
                let remote_observed = quota_provider_observed_at(&remote);
                if !quota_provider_usable(&local[index])
                    || (quota_provider_usable(&remote)
                        && remote_observed.is_some()
                        && remote_observed > local_observed)
                {
                    local[index] = remote;
                }
            }
            None => local.push(remote),
        }
    }
    local
}

fn retain_publishable_local_providers(
    mut local: Vec<QuotaProviderEnvelope>,
    remote: &[QuotaProviderEnvelope],
) -> Vec<QuotaProviderEnvelope> {
    local.retain(|local_provider| {
        if local_provider.provider_id != quota::CLAUDE_PROVIDER_ID {
            return true;
        }
        remote
            .iter()
            .find(|remote_provider| {
                provider_key(&remote_provider.provider_id, remote_provider.scope)
                    == provider_key(&local_provider.provider_id, local_provider.scope)
            })
            .is_none_or(|remote_provider| {
                quota::claude_local_envelope_may_replace_remote(local_provider, remote_provider)
            })
    });
    local
}

#[cfg(not(test))]
pub(crate) fn merge_remote_providers_for_display(
    app: &AppContext,
    local: Vec<QuotaProviderEnvelope>,
) -> Vec<QuotaProviderEnvelope> {
    let settings = settings::load_settings(app);
    if !settings.quota_snapshot_sync_enabled {
        return local;
    }
    let Some(identity) = commands::load_cloud_config_file(app)
        .ok()
        .as_ref()
        .and_then(cloud_identity_from_config)
    else {
        return local;
    };
    let Some(cache) = load_remote_cache(app).ok().flatten().filter(|cache| {
        cache.supabase_origin == identity.origin && cache.user_id == identity.user_id
    }) else {
        return local;
    };
    let now = Utc::now();
    let remote = cache
        .providers
        .iter()
        .map(|provider| synced_provider_into_display(provider, now))
        .map(quota::custom::suppress_unverified_remote_envelope)
        .collect::<Vec<_>>();
    merge_provider_sets(local, remote)
}

fn binding_matches(binding: &QuotaSyncBinding, identity: &CloudIdentity) -> bool {
    binding.transport_version == TRANSPORT_VERSION
        && binding.supabase_origin == identity.origin
        && binding.user_id == identity.user_id
}

fn binding_identity(binding: &QuotaSyncBinding) -> CloudIdentity {
    CloudIdentity {
        origin: binding.supabase_origin.clone(),
        user_id: binding.user_id.clone(),
    }
}

#[cfg(test)]
fn same_cloud_identity(left: &CloudIdentity, right: &CloudIdentity) -> bool {
    normalize_pending_identity(left)
        .is_some_and(|left| normalize_pending_identity(right).is_some_and(|right| left == right))
}

#[derive(Debug)]
struct StopPreparation {
    identity: Option<CloudIdentity>,
    intent_error: Option<String>,
    local_cleanup_pending: bool,
}

#[cfg(not(test))]
fn cloud_identity_from_config(config: &commands::CloudConfig) -> Option<CloudIdentity> {
    let session = config.session.as_ref()?;
    normalize_pending_identity(&CloudIdentity {
        origin: config.supabase_url.clone(),
        user_id: session.user_id.clone(),
    })
}

fn verify_local_stop_and_clear_sentinel_unlocked(app: &AppContext) -> Result<(), String> {
    let settings = settings::load_settings_result(app)?;
    if settings.quota_snapshot_sync_enabled || load_binding_result(app)?.is_some() {
        return Err("quota_sync_local_stop_unconfirmed".to_string());
    }
    write_local_stop_store_unlocked(app, false)
}

fn prepare_and_apply_stop(
    app: &AppContext,
    settings_state: Option<&Arc<Mutex<AppSettings>>>,
    fallback_identity: Option<CloudIdentity>,
    persist_remote_intent: bool,
    now: DateTime<Utc>,
) -> StopPreparation {
    prepare_and_apply_stop_with_observer(
        app,
        settings_state,
        fallback_identity,
        persist_remote_intent,
        now,
        || {},
    )
}

fn prepare_and_apply_stop_with_observer(
    app: &AppContext,
    settings_state: Option<&Arc<Mutex<AppSettings>>>,
    fallback_identity: Option<CloudIdentity>,
    persist_remote_intent: bool,
    now: DateTime<Utc>,
    before_local_mutation: impl FnOnce(),
) -> StopPreparation {
    let fallback_after_lock_failure = fallback_identity.clone();
    match with_local_state_lock(app, || {
        prepare_and_apply_stop_unlocked(
            app,
            settings_state,
            fallback_identity,
            persist_remote_intent,
            now,
            before_local_mutation,
        )
    }) {
        Ok(preparation) => preparation,
        Err(error) => StopPreparation {
            identity: fallback_after_lock_failure,
            intent_error: Some(error),
            local_cleanup_pending: true,
        },
    }
}

fn prepare_and_apply_stop_unlocked(
    app: &AppContext,
    settings_state: Option<&Arc<Mutex<AppSettings>>>,
    fallback_identity: Option<CloudIdentity>,
    persist_remote_intent: bool,
    now: DateTime<Utc>,
    before_local_mutation: impl FnOnce(),
) -> StopPreparation {
    let old_binding = match load_binding_result(app) {
        Ok(binding) => binding,
        Err(error) => {
            let sentinel_error = write_local_stop_store_unlocked(app, true).err();
            return StopPreparation {
                identity: fallback_identity,
                intent_error: Some(sentinel_error.unwrap_or(error)),
                local_cleanup_pending: true,
            };
        }
    };
    let identity = old_binding
        .as_ref()
        .map(binding_identity)
        .or(fallback_identity);

    let mut intent_error = write_local_stop_store_unlocked(app, true).err();
    if intent_error.is_none() && persist_remote_intent {
        if let Some(identity) = identity.as_ref() {
            intent_error =
                persist_remote_clear_pending_at_under_local_state(app, identity, now).err();
        }
    }
    if intent_error.is_some() {
        return StopPreparation {
            identity,
            intent_error,
            local_cleanup_pending: true,
        };
    }

    before_local_mutation();
    let _ = clear_binding_checked(app);
    clear_remote_cache(app);
    let _ = update_sync_setting(app, settings_state, false);
    let local_cleanup_pending = verify_local_stop_and_clear_sentinel_unlocked(app).is_err();
    StopPreparation {
        identity,
        intent_error: None,
        local_cleanup_pending,
    }
}

#[cfg(test)]
fn select_clear_previous_binding(
    stored: Option<QuotaSyncBinding>,
    captured: Option<&QuotaSyncBinding>,
) -> Result<Option<QuotaSyncBinding>, QuotaRpcError> {
    match (stored, captured) {
        (Some(stored), Some(captured)) if stored != *captured => Err(QuotaRpcError::InvalidEpoch),
        (Some(stored), _) => Ok(Some(stored)),
        (None, Some(captured)) => Ok(Some(captured.clone())),
        (None, None) => Ok(None),
    }
}

impl QuotaRpcContext {
    async fn for_app(app: &AppContext) -> Result<Self, QuotaRpcError> {
        let before =
            commands::load_cloud_config_file(app).map_err(|_| QuotaRpcError::AuthRequired)?;
        if commands::is_forbidden_supabase_service_role_key(&before.supabase_key) {
            return Err(QuotaRpcError::ServiceRoleRejected);
        }
        if before.session.is_none() {
            return Err(QuotaRpcError::AuthRequired);
        }
        let (config, lease) = commands::acquire_current_cloud_session(app)
            .await
            .map_err(|_| QuotaRpcError::Transport)?;
        let session = config.session.ok_or(QuotaRpcError::AuthRequired)?;
        if commands::is_forbidden_supabase_service_role_key(&config.supabase_key) {
            return Err(QuotaRpcError::ServiceRoleRejected);
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| QuotaRpcError::Transport)?;
        Ok(Self {
            identity: CloudIdentity {
                origin: config.supabase_url,
                user_id: session.user_id,
            },
            supabase_key: config.supabase_key,
            access_token: session.access_token,
            client,
            session_fence: Some(QuotaRpcSessionFence {
                app: app.clone(),
                lease,
            }),
            #[cfg(test)]
            test_session_generation: None,
            #[cfg(test)]
            before_clear_authorization: None,
        })
    }

    async fn call(&self, function_name: &str, payload: &Value) -> Result<Value, QuotaRpcError> {
        self.call_with_budget(
            function_name,
            payload,
            MAX_RPC_RESPONSE_BYTES,
            || Ok(()),
            None,
        )
        .await
    }

    async fn call_with_budget(
        &self,
        function_name: &str,
        payload: &Value,
        response_budget: usize,
        before_send: impl FnOnce() -> Result<(), QuotaRpcError>,
        sent: Option<&AtomicBool>,
    ) -> Result<Value, QuotaRpcError> {
        self.ensure_session_current()?;
        let request = self
            .client
            .post(format!(
                "{}/rest/v1/rpc/{function_name}",
                self.identity.origin
            ))
            .header("apikey", &self.supabase_key)
            .header("Authorization", format!("Bearer {}", self.access_token))
            .header("Content-Type", "application/json")
            .json(payload);
        let dispatch = request.send();
        self.ensure_session_current()?;
        #[cfg(test)]
        if function_name == "clear_quota_snapshots_v2" {
            if let Some(observer) = &self.before_clear_authorization {
                observer();
            }
        }
        before_send()?;
        if let Some(sent) = sent {
            // Once send starts, a lost response cannot prove that the server
            // did not commit. Destructive callers must preserve that uncertainty.
            debug_assert!(sent.load(Ordering::SeqCst));
        }
        let response = dispatch.await.map_err(|_| QuotaRpcError::Transport)?;
        self.ensure_session_current()?;
        let status = response.status();
        if matches!(status.as_u16(), 401 | 403) {
            return Err(QuotaRpcError::AuthRequired);
        }
        if status.as_u16() == 404 && function_name != "get_quota_snapshot_clear_metadata_v2" {
            return Err(QuotaRpcError::MissingRpc);
        }
        if status.as_u16() == 429 {
            return Err(QuotaRpcError::RateLimited);
        }
        if status.is_success() {
            let bytes = read_response_bounded(response, response_budget)
                .await
                .map_err(|error| match error {
                    BoundedReadError::Transport => QuotaRpcError::Transport,
                    BoundedReadError::TooLarge => QuotaRpcError::InvalidResponse,
                })?;
            self.ensure_session_current()?;
            return serde_json::from_slice(&bytes).map_err(|_| QuotaRpcError::InvalidResponse);
        }
        let bytes = match read_response_bounded(response, MAX_ERROR_RESPONSE_BYTES).await {
            Ok(bytes) => bytes,
            Err(BoundedReadError::Transport) => return Err(QuotaRpcError::Transport),
            Err(BoundedReadError::TooLarge) => return Err(QuotaRpcError::Http(status.as_u16())),
        };
        self.ensure_session_current()?;
        if let Ok(error) = serde_json::from_slice::<PostgrestErrorBody>(&bytes) {
            if error.code == "PGRST202" {
                return Err(QuotaRpcError::MissingRpc);
            }
            if error.details.is_none() && error.hint.is_none() {
                let classified = match (error.code.as_str(), error.message.as_str()) {
                    ("22023", "quota_snapshot_unsupported_transport") => {
                        Some(QuotaRpcError::UnsupportedTransport)
                    }
                    ("22023", "quota_snapshot_invalid_epoch") => Some(QuotaRpcError::InvalidEpoch),
                    ("22023", "quota_snapshot_stale_epoch") => Some(QuotaRpcError::StaleEpoch),
                    ("22023", "quota_snapshot_invalid_provider_generation") => {
                        Some(QuotaRpcError::InvalidProviderGeneration)
                    }
                    ("22023", "quota_snapshot_stale_provider_generation") => {
                        Some(QuotaRpcError::StaleProviderGeneration)
                    }
                    ("22023", "quota_snapshot_invalid_payload") => {
                        Some(QuotaRpcError::InvalidPayload)
                    }
                    ("22023", "quota_snapshot_payload_too_large") => {
                        Some(QuotaRpcError::PayloadTooLarge)
                    }
                    ("22023", "quota_snapshot_capacity_exceeded") => {
                        Some(QuotaRpcError::CapacityExceeded)
                    }
                    ("42501", _) => Some(QuotaRpcError::AuthRequired),
                    _ => None,
                };
                if let Some(error) = classified {
                    return Err(error);
                }
            }
        }
        Err(QuotaRpcError::Http(status.as_u16()))
    }
}

fn validate_transport_header(
    status: &str,
    transport_version: u8,
    expected_transport_version: u8,
    epoch: u64,
    revision: u64,
    generated_at: &str,
) -> Result<(), QuotaRpcError> {
    if status != "ok"
        || transport_version != expected_transport_version
        || epoch > MAX_SAFE_INTEGER
        || revision > MAX_SAFE_INTEGER
        || !valid_rfc3339(generated_at)
    {
        return Err(QuotaRpcError::InvalidResponse);
    }
    Ok(())
}

fn get_function_name(transport_version: u8) -> &'static str {
    if transport_version >= CURRENCY_TRANSPORT_VERSION {
        "get_quota_snapshots_v3"
    } else {
        "get_quota_snapshots_v2"
    }
}

fn upsert_function_name(transport_version: u8) -> &'static str {
    if transport_version >= CURRENCY_TRANSPORT_VERSION {
        "upsert_quota_snapshots_v3"
    } else {
        "upsert_quota_snapshots_v2"
    }
}

/// Reads through v3 first; a cloud that has not deployed it answers with a
/// missing-function error and is read through v2 instead (contract §6.1).
async fn fetch_remote_snapshots(
    context: &QuotaRpcContext,
) -> Result<GetQuotaSnapshotsResponse, QuotaRpcError> {
    match context
        .call(get_function_name(CURRENCY_TRANSPORT_VERSION), &json!({}))
        .await
    {
        Ok(value) => parse_get_response(value, CURRENCY_TRANSPORT_VERSION),
        Err(QuotaRpcError::MissingRpc) => parse_get_response(
            context
                .call(get_function_name(TRANSPORT_VERSION), &json!({}))
                .await?,
            TRANSPORT_VERSION,
        ),
        Err(error) => Err(error),
    }
}

fn parse_get_response(
    mut value: Value,
    expected_transport_version: u8,
) -> Result<GetQuotaSnapshotsResponse, QuotaRpcError> {
    if expected_transport_version >= CURRENCY_TRANSPORT_VERSION {
        prune_unknown_unit_windows(&mut value);
    }
    let response = serde_json::from_value::<GetQuotaSnapshotsResponse>(value)
        .map_err(|_| QuotaRpcError::InvalidResponse)?;
    validate_transport_header(
        &response.status,
        response.transport_version,
        expected_transport_version,
        response.epoch,
        response.revision,
        &response.generated_at,
    )?;
    validate_synced_providers(&response.providers, response.transport_version)
        .map_err(|_| QuotaRpcError::InvalidResponse)?;
    validate_provider_states(
        &response.providers,
        &response.provider_states,
        response.transport_version,
    )?;
    Ok(response)
}

async fn fetch_clear_metadata(
    context: &QuotaRpcContext,
) -> Result<ClearQuotaMetadata, QuotaRpcError> {
    match context
        .call_with_budget(
            "get_quota_snapshot_clear_metadata_v2",
            &json!({}),
            MAX_CLEAR_METADATA_BYTES,
            || Ok(()),
            None,
        )
        .await
    {
        Ok(value) => {
            let metadata: ClearQuotaMetadata =
                serde_json::from_value(value).map_err(|_| QuotaRpcError::InvalidResponse)?;
            validate_transport_header(
                &metadata.status,
                metadata.transport_version,
                TRANSPORT_VERSION,
                metadata.epoch,
                metadata.revision,
                &metadata.generated_at,
            )?;
            if !valid_string(&metadata.generated_at, MAX_STRING_BYTES, false) {
                return Err(QuotaRpcError::InvalidResponse);
            }
            Ok(metadata)
        }
        Err(QuotaRpcError::MissingRpc) => {
            // Older servers remain usable only when their complete snapshot
            // passes the ordinary reader. Never salvage a header from bad data.
            let remote = fetch_remote_snapshots(context).await?;
            Ok(ClearQuotaMetadata {
                status: remote.status,
                transport_version: TRANSPORT_VERSION,
                epoch: remote.epoch,
                revision: remote.revision,
                generated_at: remote.generated_at,
            })
        }
        Err(error) => Err(error),
    }
}

async fn clear_quota_snapshots_with_context(
    app: &AppContext,
    settings_state: &Arc<Mutex<AppSettings>>,
    coordinator: &QuotaSyncCoordinator,
    claim: OperationClaim,
    context: &QuotaRpcContext,
) -> Result<(), QuotaRpcError> {
    let metadata = fetch_clear_metadata(context).await?;
    let previous = load_binding_result(app).map_err(|_| QuotaRpcError::InvalidResponse)?;
    if let Some(previous) = previous {
        if !binding_matches(&previous, &context.identity) {
            return Err(QuotaRpcError::Superseded);
        }
        if metadata.epoch < previous.epoch || metadata.revision < previous.revision {
            return Err(QuotaRpcError::InvalidResponse);
        }
    }
    let current = binding_from_remote(
        &context.identity,
        metadata.epoch,
        metadata.revision,
        Some(metadata.generated_at),
    );
    let sent = AtomicBool::new(false);
    let result = context
        .call_with_budget(
            "clear_quota_snapshots_v2",
            &json!({ "p_transport_version": TRANSPORT_VERSION, "p_epoch": current.epoch }),
            MAX_RPC_RESPONSE_BYTES,
            || coordinator.authorize_clear_dispatch(claim, context, app, settings_state, &sent),
            Some(&sent),
        )
        .await;
    let value = result.map_err(|error| {
        if sent.load(Ordering::SeqCst)
            && matches!(
                error,
                QuotaRpcError::Transport
                    | QuotaRpcError::InvalidResponse
                    | QuotaRpcError::Superseded
                    | QuotaRpcError::Http(_)
            )
        {
            QuotaRpcError::ClearOutcomeUnknown
        } else {
            error
        }
    });
    let response = value.and_then(|value| {
        parse_clear_response(value, Some(&current)).map_err(|_| QuotaRpcError::ClearOutcomeUnknown)
    });
    if let Err(error) = response {
        if error == QuotaRpcError::ClearOutcomeUnknown {
            // Do not let this device immediately republish after a possibly
            // committed clear. Superseded owners never touch the new state.
            if coordinator.commit_clear_stop(claim, context, app, settings_state, true)
                == Err(QuotaRpcError::ClearLocalStopIncomplete)
            {
                return Err(QuotaRpcError::ClearOutcomeUnknownLocalStopIncomplete);
            }
        }
        if sent.load(Ordering::SeqCst) && error != QuotaRpcError::ClearOutcomeUnknown {
            return Err(QuotaRpcError::ClearRejectedDeviceStopped);
        }
        return Err(error);
    }
    coordinator.commit_clear_stop(claim, context, app, settings_state, false)
}

fn parse_upsert_response(
    mut value: Value,
    expected_transport_version: u8,
    expected_epoch: u64,
    previous_revision: u64,
    provider_count: usize,
) -> Result<UpsertQuotaSnapshotsResponse, QuotaRpcError> {
    if expected_transport_version >= CURRENCY_TRANSPORT_VERSION {
        prune_unknown_unit_windows(&mut value);
    }
    let response = serde_json::from_value::<UpsertQuotaSnapshotsResponse>(value)
        .map_err(|_| QuotaRpcError::InvalidResponse)?;
    validate_transport_header(
        &response.status,
        response.transport_version,
        expected_transport_version,
        response.epoch,
        response.revision,
        &response.generated_at,
    )?;
    if response.epoch != expected_epoch
        || response.revision < previous_revision
        || response.upserted_provider_count + response.ignored_provider_count != provider_count
        || response.upserted_provider_count > provider_count
        || response.ignored_provider_count > provider_count
    {
        return Err(QuotaRpcError::InvalidResponse);
    }
    validate_synced_providers(&response.providers, response.transport_version)
        .map_err(|_| QuotaRpcError::InvalidResponse)?;
    validate_provider_states(
        &response.providers,
        &response.provider_states,
        response.transport_version,
    )?;
    Ok(response)
}

fn parse_clear_response(
    value: Value,
    previous: Option<&QuotaSyncBinding>,
) -> Result<ClearQuotaSnapshotsResponse, QuotaRpcError> {
    let response = serde_json::from_value::<ClearQuotaSnapshotsResponse>(value)
        .map_err(|_| QuotaRpcError::InvalidResponse)?;
    validate_transport_header(
        &response.status,
        response.transport_version,
        TRANSPORT_VERSION,
        response.epoch,
        response.revision,
        &response.generated_at,
    )?;
    if let Some(previous) = previous {
        if response.epoch <= previous.epoch || response.revision <= previous.revision {
            return Err(QuotaRpcError::InvalidResponse);
        }
    }
    // A historical server bug could leave more than eight active rows. Explicit
    // clear may acknowledge all of them, but must prove that no active row remains.
    if response.cleared_provider_count > response.provider_states.len()
        || !response.providers.is_empty()
        || response.provider_states.iter().any(|state| !state.deleted)
    {
        return Err(QuotaRpcError::InvalidResponse);
    }
    validate_synced_providers(&response.providers, TRANSPORT_VERSION)
        .map_err(|_| QuotaRpcError::InvalidResponse)?;
    validate_provider_states(
        &response.providers,
        &response.provider_states,
        TRANSPORT_VERSION,
    )?;
    Ok(response)
}

fn parse_delete_response(
    value: Value,
    previous: &QuotaSyncBinding,
    provider_id: &str,
    scope: QuotaScope,
    previous_generation: u64,
) -> Result<DeleteQuotaProviderResponse, QuotaRpcError> {
    let response = serde_json::from_value::<DeleteQuotaProviderResponse>(value)
        .map_err(|_| QuotaRpcError::InvalidResponse)?;
    validate_transport_header(
        &response.status,
        response.transport_version,
        TRANSPORT_VERSION,
        response.epoch,
        response.revision,
        &response.generated_at,
    )?;
    if response.epoch != previous.epoch
        || response.revision <= previous.revision
        || response.deleted_provider_id != provider_id
        || response.deleted_scope != scope
        || response.provider_generation != previous_generation.saturating_add(1)
        || response.provider_generation > MAX_SAFE_INTEGER
    {
        return Err(QuotaRpcError::InvalidResponse);
    }
    validate_synced_providers(&response.providers, TRANSPORT_VERSION)
        .map_err(|_| QuotaRpcError::InvalidResponse)?;
    validate_provider_states(
        &response.providers,
        &response.provider_states,
        TRANSPORT_VERSION,
    )?;
    let deleted_key = provider_key(provider_id, scope);
    if !response.provider_states.iter().any(|state| {
        provider_key(&state.provider_id, state.scope) == deleted_key
            && state.deleted
            && state.generation == response.provider_generation
    }) {
        return Err(QuotaRpcError::InvalidResponse);
    }
    Ok(response)
}

fn update_sync_setting(
    app: &AppContext,
    settings_state: Option<&Arc<Mutex<AppSettings>>>,
    enabled: bool,
) -> Result<AppSettings, String> {
    if let Some(settings_state) = settings_state {
        let mut guard = settings_state
            .lock()
            .map_err(|_| "settings state lock poisoned".to_string())?;
        return match settings::update_quota_snapshot_sync_enabled(app, enabled) {
            Ok(current) => {
                *guard = current.clone();
                Ok(current)
            }
            Err(error) => {
                guard.quota_snapshot_sync_enabled = false;
                Err(error)
            }
        };
    }
    settings::update_quota_snapshot_sync_enabled(app, enabled)
}

fn enable_sync_setting_if_authorized(
    app: &AppContext,
    settings_state: &Arc<Mutex<AppSettings>>,
) -> Result<AppSettings, QuotaRpcError> {
    let mut guard = settings_state
        .lock()
        .map_err(|_| QuotaRpcError::InvalidResponse)?;
    match settings::enable_quota_snapshot_sync(app) {
        Ok(current) => {
            *guard = current.clone();
            Ok(current)
        }
        Err(_) => {
            guard.quota_snapshot_sync_enabled = false;
            Err(QuotaRpcError::InvalidResponse)
        }
    }
}

fn commit_enable_local_state(
    app: &AppContext,
    settings_state: &Arc<Mutex<AppSettings>>,
    binding: &QuotaSyncBinding,
) -> Result<(), QuotaRpcError> {
    commit_enable_local_state_with_observer(app, settings_state, binding, || {})
}

fn commit_enable_local_state_with_observer(
    app: &AppContext,
    settings_state: &Arc<Mutex<AppSettings>>,
    binding: &QuotaSyncBinding,
    before_publishable_write: impl FnOnce(),
) -> Result<(), QuotaRpcError> {
    with_local_state_lock(app, || {
        // The local stop sentinel must exist before either file can describe
        // a publishable state. Remote v1 clear markers are deliberately not
        // consulted: transport v2 never treats enable/disable as deletion.
        write_local_stop_store_unlocked(app, true).map_err(|_| QuotaRpcError::InvalidResponse)?;
        before_publishable_write();
        save_binding(app, binding).map_err(|_| QuotaRpcError::InvalidResponse)?;
        enable_sync_setting_if_authorized(app, settings_state)?;
        // Successful enable clears the durable block only after both
        // publishable files are committed.
        write_local_stop_store_unlocked(app, false).map_err(|_| QuotaRpcError::InvalidResponse)
    })
    .map_err(|_| QuotaRpcError::InvalidResponse)?
}

fn rollback_enable_fail_closed(app: &AppContext, settings_state: &Arc<Mutex<AppSettings>>) -> bool {
    with_local_state_lock(app, || {
        if write_local_stop_store_unlocked(app, true).is_err() {
            return false;
        }
        let binding_failed = clear_binding_checked(app).is_err();
        let settings_failed = update_sync_setting(app, Some(settings_state), false).is_err();
        let verified = !binding_failed
            && !settings_failed
            && verify_local_stop_and_clear_sentinel_unlocked(app).is_ok();
        if !verified {
            let _ = write_local_stop_store_unlocked(app, true);
        }
        verified
    })
    .unwrap_or(false)
}

fn rollback_enable_failure(
    app: &AppContext,
    settings_state: &Arc<Mutex<AppSettings>>,
    error: QuotaRpcError,
) -> ReauthorizationFailure {
    ReauthorizationFailure {
        error,
        rollback_failed: !rollback_enable_fail_closed(app, settings_state),
    }
}

#[cfg(test)]
async fn clear_remote_with_context(
    app: &AppContext,
    context: QuotaRpcContext,
    expected_identity: Option<&CloudIdentity>,
    previous_binding: Option<&QuotaSyncBinding>,
) -> Result<ClearQuotaSnapshotsResponse, QuotaRpcError> {
    if expected_identity.is_some_and(|expected| !same_cloud_identity(expected, &context.identity)) {
        return Err(QuotaRpcError::InvalidEpoch);
    }
    let stored_binding = load_binding_result(app).map_err(|_| QuotaRpcError::InvalidResponse)?;
    if stored_binding
        .as_ref()
        .is_some_and(|binding| !binding_matches(binding, &context.identity))
    {
        return Err(QuotaRpcError::InvalidEpoch);
    }
    if previous_binding.is_some_and(|binding| !binding_matches(binding, &context.identity)) {
        return Err(QuotaRpcError::InvalidEpoch);
    }
    let previous = select_clear_previous_binding(stored_binding, previous_binding)?;
    let value = context
        .call(
            "clear_quota_snapshots_v1",
            &json!({ "p_transport_version": TRANSPORT_VERSION }),
        )
        .await?;
    parse_clear_response(value, previous.as_ref())
}

fn stop_sync_locally_fail_closed(app: &AppContext, reason_code: &str) -> bool {
    let (claim, preparation) = coordinator().begin_tombstone(reason_code, || {
        prepare_and_apply_stop(app, None, None, false, Utc::now())
    });
    let cleanup_pending = preparation.intent_error.is_some() || preparation.local_cleanup_pending;
    let _ = coordinator().finish_local_tombstone(
        app,
        claim,
        preparation.identity.as_ref(),
        cleanup_pending,
        reason_code,
        Utc::now(),
    );
    cleanup_pending
}

pub(crate) fn invalidate_session_locally(app: &AppContext) {
    let _ = stop_sync_locally_fail_closed(app, "quota_sync_auth_required");
}

pub(crate) async fn prepare_for_sign_out_with_config(
    app: &AppContext,
    settings_state: &Arc<Mutex<AppSettings>>,
    _captured_config: Option<&commands::CloudConfig>,
) -> (Option<String>, bool) {
    let (claim, preparation) = coordinator().begin_tombstone("quota_sync_signed_out", || {
        prepare_and_apply_stop(app, Some(settings_state), None, false, Utc::now())
    });
    let cleanup_pending = preparation.intent_error.is_some() || preparation.local_cleanup_pending;
    if coordinator()
        .finish_device_stop(claim, cleanup_pending, "quota_sync_signed_out")
        .is_err()
    {
        return (
            Some("本地额度同步停止状态未能安全保存，请修复本地存储后重试。".to_string()),
            true,
        );
    }
    (
        cleanup_pending
            .then(|| "本地额度同步停止状态未能安全保存，请修复本地存储后重试。".to_string()),
        cleanup_pending,
    )
}

fn provider_authorization_revoked(previous: &AppSettings, current: &AppSettings) -> bool {
    (previous.quota_codex_local_enabled && !current.quota_codex_local_enabled)
        || (claude_provider_enabled(previous) && !claude_provider_enabled(current))
        || (antigravity_provider_enabled(previous) && !antigravity_provider_enabled(current))
}

fn claude_provider_enabled(settings: &AppSettings) -> bool {
    settings.quota_claude_statusline_enabled || settings.quota_claude_codexbar_enabled
}

fn antigravity_provider_enabled(settings: &AppSettings) -> bool {
    settings.quota_antigravity_local_enabled
}

/// Provider authorization is local producer state. Revocation never implies
/// deletion of the durable cloud snapshot.
pub(crate) fn prepare_provider_authorization_change(
    _app: &AppContext,
    previous: &AppSettings,
    current: &AppSettings,
) -> Result<(), String> {
    let _ = provider_authorization_revoked(previous, current);
    Ok(())
}

pub(crate) async fn handle_provider_authorization_change(
    _app: &AppContext,
    _settings_state: &Arc<Mutex<AppSettings>>,
    previous: &AppSettings,
    current: &AppSettings,
) -> (Option<String>, bool) {
    let _ = provider_authorization_revoked(previous, current);
    // Local authorization controls only this device's producer. It does not
    // imply consent to erase another device's durable cloud snapshot.
    (None, false)
}

async fn enable_sync(
    app: &AppContext,
    settings_state: &Arc<Mutex<AppSettings>>,
) -> Result<QuotaSyncStatus, String> {
    let Some(claim) = coordinator().begin() else {
        return Ok(get_quota_snapshot_sync_status_impl(app));
    };
    let result = async {
        let context = QuotaRpcContext::for_app(app).await?;
        let response = fetch_remote_snapshots(&context).await?;
        let identity = context.identity.clone();
        let cache = remote_cache_from_get(&identity, &response);
        let binding = binding_from_remote(&identity, response.epoch, response.revision, None);
        Ok((context, binding, cache))
    }
    .await;
    match result {
        Ok((context, binding, cache)) => {
            let identity = context.identity.clone();
            let commit =
                coordinator().commit_reauthorized(app, claim, &identity, Utc::now(), || {
                    context
                        .commit_if_session_current(|| {
                            save_remote_cache(app, &cache)
                                .map_err(|_| QuotaRpcError::InvalidResponse)?;
                            commit_enable_local_state(app, settings_state, &binding)
                        })
                        .map_err(|error| rollback_enable_failure(app, settings_state, error))
                });
            if let Err(error) = commit {
                if error == QuotaRpcError::Superseded {
                    return Ok(get_quota_snapshot_sync_status_impl(app));
                }
                return Err(error.safe_message());
            }
            match sync_quota_snapshots_impl(app).await {
                Ok(status) => Ok(status),
                Err(_) => Ok(get_quota_snapshot_sync_status_impl(app)),
            }
        }
        Err(error) => {
            let committed_error =
                coordinator().finish_failed_reauthorization(app, settings_state, claim, error);
            if committed_error == Err(QuotaRpcError::Superseded) {
                return Ok(get_quota_snapshot_sync_status_impl(app));
            }
            Err(error.safe_message())
        }
    }
}

async fn disable_sync(
    app: &AppContext,
    settings_state: &Arc<Mutex<AppSettings>>,
) -> Result<QuotaSyncStatus, String> {
    let (claim, preparation) = coordinator().begin_tombstone("quota_sync_disabled", || {
        prepare_and_apply_stop(app, Some(settings_state), None, false, Utc::now())
    });
    let local_cleanup_pending =
        preparation.intent_error.is_some() || preparation.local_cleanup_pending;
    if coordinator()
        .finish_device_stop(claim, local_cleanup_pending, "quota_sync_disabled")
        .is_err()
    {
        return Ok(get_quota_snapshot_sync_status_impl(app));
    }
    Ok(get_quota_snapshot_sync_status_impl(app))
}

#[tauri::command]
pub async fn set_quota_snapshot_sync_enabled(
    app_state: tauri::State<'_, Arc<AppContext>>,
    settings_state: tauri::State<'_, Arc<Mutex<AppSettings>>>,
    enabled: bool,
) -> Result<QuotaSyncStatus, String> {
    if enabled {
        enable_sync(app_state.inner().as_ref(), settings_state.inner()).await
    } else {
        disable_sync(app_state.inner().as_ref(), settings_state.inner()).await
    }
}

pub(crate) async fn sync_quota_snapshots_impl(app: &AppContext) -> Result<QuotaSyncStatus, String> {
    sync_quota_snapshots_impl_with_retry(app, false).await
}

async fn sync_quota_snapshots_impl_with_retry(
    app: &AppContext,
    retry_keyring_read: bool,
) -> Result<QuotaSyncStatus, String> {
    if coordinator().sync_is_blocked() || has_local_stop_pending(app) {
        return Ok(get_quota_snapshot_sync_status_impl(app));
    }
    let initial_settings = settings::load_settings(app);
    if !initial_settings.quota_snapshot_sync_enabled {
        return Ok(get_quota_snapshot_sync_status_impl(app));
    }
    let (claim, blocked) = coordinator().begin_sync();
    let Some(claim) = claim else {
        if blocked {
            return Ok(get_quota_snapshot_sync_status_impl(app));
        }
        let mut status = get_quota_snapshot_sync_status_impl(app);
        if status.reason_code.as_deref() != Some(REMOTE_CLEAR_INCOMPLETE) {
            status.state = QuotaSyncState::Syncing;
        }
        return Ok(status);
    };
    let result = async {
        let context = QuotaRpcContext::for_app(app).await?;
        let previous_binding = load_binding(app)
            .filter(|binding| binding_matches(binding, &context.identity))
            .ok_or(QuotaRpcError::InvalidEpoch)?;
        let remote = fetch_remote_snapshots(&context).await?;
        let transport_version = remote.transport_version;
        if remote.revision < previous_binding.revision {
            return Err(QuotaRpcError::InvalidResponse);
        }
        let mut providers =
            quota::get_local_quota_providers_impl_with_retry_flag(app, retry_keyring_read).await;
        if !coordinator().is_current(claim) {
            return Err(QuotaRpcError::Superseded);
        }
        let current_settings = settings::load_settings(app);
        if !current_settings.quota_snapshot_sync_enabled {
            return Err(QuotaRpcError::Superseded);
        }
        let now = Utc::now();
        let remote_display = remote
            .providers
            .iter()
            .map(|provider| synced_provider_into_display(provider, now))
            .collect::<Vec<_>>();
        providers = retain_publishable_local_providers(providers, &remote_display);
        let enabled_balances = quota::balance::enabled_provider_ids(app.app_data_dir());
        let (projected, _) = build_projection(
            &providers,
            &current_settings,
            &enabled_balances,
            transport_version,
        )
        .map_err(|error| match error.as_str() {
            "quota_sync_payload_too_large" => QuotaRpcError::PayloadTooLarge,
            "quota_sync_invalid_provider_count" => QuotaRpcError::InvalidProviderCount,
            _ => QuotaRpcError::InvalidPayload,
        })?;
        let entries = build_upsert_entries(projected, &remote.provider_states)?;
        let (cache, synced_at) = if entries.is_empty() {
            (
                remote_cache_from_get(&context.identity, &remote),
                remote.generated_at.clone(),
            )
        } else {
            let entries_value =
                serde_json::to_value(&entries).map_err(|_| QuotaRpcError::InvalidPayload)?;
            let value = match context
                .call(
                    upsert_function_name(transport_version),
                    &json!({
                        "p_transport_version": transport_version,
                        "p_epoch": remote.epoch,
                        "p_providers": entries_value,
                    }),
                )
                .await
            {
                Err(QuotaRpcError::StaleEpoch) if !coordinator().is_current(claim) => {
                    return Err(QuotaRpcError::Superseded)
                }
                result => result?,
            };
            let response = parse_upsert_response(
                value,
                transport_version,
                remote.epoch,
                remote.revision,
                entries.len(),
            )?;
            (
                remote_cache_from_upsert(&context.identity, &response),
                response.generated_at.clone(),
            )
        };
        coordinator().commit_current(claim, || {
            context.commit_if_session_current(|| {
                let latest = load_binding(app)
                    .filter(|latest| binding_matches(latest, &context.identity))
                    .ok_or(QuotaRpcError::InvalidEpoch)?;
                let latest_settings = settings::load_settings(app);
                if !latest_settings.quota_snapshot_sync_enabled {
                    return Err(QuotaRpcError::Superseded);
                }
                let next = QuotaSyncBinding {
                    epoch: cache.epoch,
                    revision: latest.revision.max(cache.revision),
                    last_synced_at: Some(synced_at),
                    ..latest
                };
                save_remote_cache(app, &cache).map_err(|_| QuotaRpcError::InvalidResponse)?;
                save_binding(app, &next).map_err(|_| QuotaRpcError::InvalidResponse)?;
                Ok(next)
            })
        })
    }
    .await;
    match result {
        Ok(binding) => {
            if has_local_stop_pending(app) {
                Ok(get_quota_snapshot_sync_status_impl(app))
            } else {
                Ok(QuotaSyncStatus {
                    enabled: true,
                    state: QuotaSyncState::Active,
                    last_synced_at: binding.last_synced_at,
                    reason_code: None,
                })
            }
        }
        Err(QuotaRpcError::StaleEpoch) => {
            coordinator().finish(claim, Some("quota_sync_stale_epoch"));
            Err("云端额度状态刚被另一台设备更新，请重试同步。".to_string())
        }
        Err(QuotaRpcError::InvalidEpoch) => {
            if stop_sync_locally_fail_closed(app, "quota_sync_binding_required") {
                return Ok(get_quota_snapshot_sync_status_impl(app));
            }
            Ok(QuotaSyncStatus {
                enabled: false,
                state: QuotaSyncState::Paused,
                last_synced_at: None,
                reason_code: Some("quota_sync_binding_required".to_string()),
            })
        }
        Err(QuotaRpcError::Superseded) => {
            coordinator().finish(claim, None);
            Ok(get_quota_snapshot_sync_status_impl(app))
        }
        Err(error) => {
            coordinator().finish(claim, Some(error.reason_code()));
            Err(error.safe_message())
        }
    }
}

#[tauri::command]
pub async fn sync_quota_snapshots_now(
    app_state: tauri::State<'_, Arc<AppContext>>,
) -> Result<QuotaSyncStatus, String> {
    sync_quota_snapshots_impl_with_retry(app_state.inner().as_ref(), true).await
}

#[tauri::command]
pub async fn delete_quota_snapshot_provider(
    app_state: tauri::State<'_, Arc<AppContext>>,
    provider_id: String,
    scope: QuotaScope,
) -> Result<QuotaSyncStatus, String> {
    let app = app_state.inner().as_ref();
    if !valid_string(&provider_id, MAX_STABLE_ID_BYTES, false) {
        return Err("Provider 标识不符合额度同步契约。".to_string());
    }
    let Some(claim) = coordinator().begin() else {
        return Ok(get_quota_snapshot_sync_status_impl(app));
    };
    let result = async {
        let context = QuotaRpcContext::for_app(app).await?;
        let remote = fetch_remote_snapshots(&context).await?;
        let key = provider_key(&provider_id, scope);
        let generation = remote
            .provider_states
            .iter()
            .find(|state| provider_key(&state.provider_id, state.scope) == key)
            .map_or(0, |state| state.generation);
        let current = binding_from_remote(
            &context.identity,
            remote.epoch,
            remote.revision,
            Some(remote.generated_at.clone()),
        );
        let value = context
            .call(
                "delete_quota_snapshot_provider_v2",
                &json!({
                    "p_transport_version": TRANSPORT_VERSION,
                    "p_epoch": current.epoch,
                    "p_provider_id": provider_id.clone(),
                    "p_scope": scope_key(scope),
                    "p_generation": generation,
                }),
            )
            .await?;
        let response = parse_delete_response(value, &current, &provider_id, scope, generation)?;
        let cache = remote_cache_from_delete(&context.identity, &response, &remote);
        coordinator().commit_current(claim, || {
            context.commit_if_session_current(|| {
                let mut next = binding_from_remote(
                    &context.identity,
                    response.epoch,
                    response.revision,
                    Some(response.generated_at.clone()),
                );
                if settings::load_settings(app).quota_snapshot_sync_enabled {
                    save_remote_cache(app, &cache).map_err(|_| QuotaRpcError::InvalidResponse)?;
                    save_binding(app, &next).map_err(|_| QuotaRpcError::InvalidResponse)?;
                } else {
                    next.last_synced_at = None;
                }
                Ok(next)
            })
        })
    }
    .await;
    match result {
        Ok(binding) => {
            let mut status = get_quota_snapshot_sync_status_impl(app);
            if status.enabled {
                status.state = QuotaSyncState::Active;
                status.last_synced_at = binding.last_synced_at;
                status.reason_code = None;
            }
            Ok(status)
        }
        Err(error) => {
            coordinator().finish(claim, Some(error.reason_code()));
            Err(error.safe_message())
        }
    }
}

#[tauri::command]
pub async fn clear_quota_snapshots(
    app_state: tauri::State<'_, Arc<AppContext>>,
    settings_state: tauri::State<'_, Arc<Mutex<AppSettings>>>,
) -> Result<QuotaSyncStatus, String> {
    let app = app_state.inner().as_ref();
    let Some(claim) = coordinator().begin() else {
        return Err(
            "quota_sync_clear_busy: 另一项额度操作正在进行，本次清空尚未发送；请稍后重新确认。"
                .to_string(),
        );
    };
    let result = async {
        let context = QuotaRpcContext::for_app(app).await?;
        clear_quota_snapshots_with_context(
            app,
            settings_state.inner(),
            coordinator(),
            claim,
            &context,
        )
        .await
    }
    .await;
    match result {
        Ok(()) => Ok(get_quota_snapshot_sync_status_impl(app)),
        Err(error) => {
            coordinator().finish(claim, Some(error.reason_code()));
            Err(error.safe_message())
        }
    }
}

pub(crate) fn get_quota_snapshot_sync_status_impl(app: &AppContext) -> QuotaSyncStatus {
    let settings = settings::load_settings(app);
    let sync_blocked = coordinator().sync_is_blocked();
    if has_local_stop_pending(app) {
        return QuotaSyncStatus {
            enabled: settings.quota_snapshot_sync_enabled && !sync_blocked,
            state: QuotaSyncState::Error,
            last_synced_at: None,
            reason_code: Some("quota_sync_local_stop_incomplete".to_string()),
        };
    }
    if sync_blocked || !settings.quota_snapshot_sync_enabled {
        let (_, runtime_reason) = coordinator().runtime_snapshot();
        let state = match runtime_reason.as_deref() {
            Some("quota_sync_stale_epoch") => QuotaSyncState::Paused,
            _ => QuotaSyncState::Disabled,
        };
        return QuotaSyncStatus {
            enabled: false,
            state,
            last_synced_at: None,
            reason_code: runtime_reason,
        };
    }
    let config = match commands::load_cloud_config_file(app) {
        Ok(config) => config,
        Err(_) => {
            return QuotaSyncStatus {
                enabled: true,
                state: QuotaSyncState::Unavailable,
                last_synced_at: None,
                reason_code: Some("quota_sync_config_unavailable".to_string()),
            }
        }
    };
    let Some(session) = config.session else {
        return QuotaSyncStatus {
            enabled: true,
            state: QuotaSyncState::AuthRequired,
            last_synced_at: None,
            reason_code: Some("quota_sync_auth_required".to_string()),
        };
    };
    let identity = CloudIdentity {
        origin: config.supabase_url,
        user_id: session.user_id,
    };
    let Some(binding) = load_binding(app).filter(|binding| binding_matches(binding, &identity))
    else {
        return QuotaSyncStatus {
            enabled: true,
            state: QuotaSyncState::Paused,
            last_synced_at: None,
            reason_code: Some("quota_sync_binding_required".to_string()),
        };
    };
    let (in_flight, runtime_reason) = coordinator().runtime_snapshot();
    let state = if in_flight {
        QuotaSyncState::Syncing
    } else if runtime_reason.as_deref() == Some("quota_sync_rpc_unavailable") {
        QuotaSyncState::Unavailable
    } else if runtime_reason.is_some() {
        QuotaSyncState::Error
    } else {
        QuotaSyncState::Active
    };
    QuotaSyncStatus {
        enabled: true,
        state,
        last_synced_at: binding.last_synced_at,
        reason_code: runtime_reason,
    }
}

/// Return scheduler status without resolving the secure cloud session. This
/// error path is intentionally disk/runtime-only: calling the regular status
/// function after a failed Keychain read would immediately ask macOS to read
/// the same entry again.
pub(crate) fn get_background_quota_snapshot_sync_status_impl(app: &AppContext) -> QuotaSyncStatus {
    let settings = settings::load_settings(app);
    let sync_blocked = coordinator().sync_is_blocked();
    let (in_flight, runtime_reason) = coordinator().runtime_snapshot();
    let enabled = settings.quota_snapshot_sync_enabled && !sync_blocked;
    let state = if !enabled {
        QuotaSyncState::Disabled
    } else if in_flight {
        QuotaSyncState::Syncing
    } else {
        match runtime_reason.as_deref() {
            Some("quota_sync_auth_required") => QuotaSyncState::AuthRequired,
            Some("quota_sync_rpc_unavailable") => QuotaSyncState::Unavailable,
            Some(_) => QuotaSyncState::Error,
            None => QuotaSyncState::Active,
        }
    };
    let last_synced_at = load_binding(app).and_then(|binding| binding.last_synced_at);
    QuotaSyncStatus {
        enabled,
        state,
        last_synced_at,
        reason_code: runtime_reason,
    }
}

#[tauri::command]
pub fn get_quota_snapshot_sync_status(
    app_state: tauri::State<'_, Arc<AppContext>>,
) -> QuotaSyncStatus {
    get_quota_snapshot_sync_status_impl(app_state.inner().as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota::QuotaWindowSnapshot;
    use std::fs;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);
    const PENDING_LOCK_WORKER_ROOT: &str = "TOKENLEDGER_PENDING_LOCK_WORKER_ROOT";
    const PENDING_LOCK_WORKER_ROLE: &str = "TOKENLEDGER_PENDING_LOCK_WORKER_ROLE";
    const LOCAL_STATE_WORKER_ROOT: &str = "TOKENLEDGER_LOCAL_STATE_WORKER_ROOT";
    const LOCAL_STATE_WORKER_ROLE: &str = "TOKENLEDGER_LOCAL_STATE_WORKER_ROLE";
    /// Cap on a holder worker's wait for its release marker. It must outlast
    /// the parent's whole check (up to `WORKER_MARKER_TIMEOUT` for the second
    /// worker to start, then 100 ms), so a slow machine can never make the
    /// holder give up, and so drop the lock, while the parent still counts on
    /// it. The marker ends the wait at once, so passing runs never sleep this.
    const WORKER_RELEASE_TIMEOUT: Duration = Duration::from_secs(60);
    /// Cap on the parent's wait for a worker's marker or exit. The wait ends
    /// on the marker, or as soon as the worker that should write it exits.
    const WORKER_MARKER_TIMEOUT: Duration = Duration::from_secs(30);
    /// How long `WorkerProcesses` lets released workers leave on their own
    /// before it kills them.
    const WORKER_EXIT_GRACE: Duration = Duration::from_secs(5);
    const MARKER_POLL_INTERVAL: Duration = Duration::from_millis(10);

    const COMPLETE: &str = include_str!("../../fixtures/quota-provider-v1/complete-v1.json");
    const CUSTOM_OPENAPI: &str =
        include_str!("../../fixtures/quota-provider-v1/custom-openapi-v1.json");
    const STATES: &str = include_str!("../../fixtures/quota-provider-v1/states-v1.json");
    const INVALID: &str = include_str!("../../fixtures/quota-provider-v1/invalid-v1.json");
    const TRANSPORT: &str = include_str!("../../fixtures/quota-provider-v1/transport-v2.json");
    const CURRENCY: &str = include_str!("../../fixtures/quota-provider-v1/currency-v1.json");
    const TRANSPORT_V3: &str = include_str!("../../fixtures/quota-provider-v1/transport-v3.json");
    const BALANCE: &str = include_str!("../../fixtures/quota-provider-v1/balance-v1.json");
    const CAPACITY: &str =
        include_str!("../../fixtures/quota-provider-v1/transport-capacity-v1.json");

    fn test_app() -> (AppContext, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "tokenledger-quota-sync-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        (AppContext::for_test(root.clone()), root)
    }

    fn test_now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-07-15T00:00:00Z")
            .expect("fixed time")
            .with_timezone(&Utc)
    }

    fn test_identity(name: &str) -> CloudIdentity {
        CloudIdentity {
            origin: format!("https://{name}.supabase.co"),
            user_id: format!("user-{name}"),
        }
    }

    fn claude_test_provider(
        prefix: &str,
        short_used: f64,
        weekly_used: f64,
        observed_at: &str,
    ) -> QuotaProviderEnvelope {
        let (short_id, weekly_id) = match prefix {
            "native" => ("native-cli-five-hour", "native-cli-seven-day"),
            "codexbar" => ("codexbar-primary", "codexbar-secondary"),
            _ => panic!("unknown test source"),
        };
        let window = |window_id: &str, label: &str, minutes: u64, used: f64| QuotaWindowSnapshot {
            provider_id: quota::CLAUDE_PROVIDER_ID.to_string(),
            window_id: window_id.to_string(),
            window_label: label.to_string(),
            account_label: None,
            scope: QuotaScope::ConsumerSubscription,
            source: QuotaSource::LocalAuthorized,
            status: QuotaWindowStatus::Ok,
            used: Some(used),
            limit: Some(100.0),
            remaining: Some(100.0 - used),
            unit: QuotaUnit::Percent,
            currency: None,
            window_minutes: Some(minutes),
            resets_at: None,
            observed_at: observed_at.to_string(),
            fetched_at: observed_at.to_string(),
            stale_after_seconds: 900,
            reason_code: None,
        };
        QuotaProviderEnvelope {
            schema_version: 1,
            provider_id: quota::CLAUDE_PROVIDER_ID.to_string(),
            display_name: "Claude consumer usage".to_string(),
            scope: QuotaScope::ConsumerSubscription,
            mode: QuotaMode::Automatic,
            capability: QuotaCapability::Experimental,
            status: QuotaStatus::Ok,
            windows: vec![
                window(short_id, "5-hour", 300, short_used),
                window(weekly_id, "7-day", 10080, weekly_used),
            ],
            reason_code: None,
            action: None,
        }
    }

    /// Waits for a marker file that another process writes. The marker ends
    /// the wait at once; `timeout` only caps a peer that never gets there, and
    /// reaching it fails with the marker's name instead of carrying on as if
    /// the peer had arrived.
    fn wait_for_path(path: &Path, timeout: Duration) {
        let started = Instant::now();
        while !path.exists() {
            assert!(
                started.elapsed() < timeout,
                "marker {} did not appear within {timeout:?} ({})",
                marker_name(path),
                path.display()
            );
            std::thread::sleep(MARKER_POLL_INTERVAL);
        }
    }

    fn marker_name(path: &Path) -> String {
        path.file_name()
            .unwrap_or(path.as_os_str())
            .to_string_lossy()
            .into_owned()
    }

    /// Worker processes started by one cross-process lock test.
    ///
    /// Dropping it, on success or while a failed assertion unwinds, first
    /// writes the release marker so a holder leaves its wait at once, then
    /// reaps every worker and kills any that is still running after
    /// `WORKER_EXIT_GRACE`. A failing test therefore never leaves a worker
    /// waiting out `WORKER_RELEASE_TIMEOUT`. Each worker's stderr goes to
    /// `<root>/<role>.stderr.log`, which failure messages quote.
    struct WorkerProcesses {
        root: std::path::PathBuf,
        release_marker: std::path::PathBuf,
        workers: Vec<(String, std::process::Child)>,
    }

    impl WorkerProcesses {
        fn new(root: &Path, release_marker: &str) -> Self {
            Self {
                root: root.to_path_buf(),
                release_marker: root.join(release_marker),
                workers: Vec::new(),
            }
        }

        fn spawn(&mut self, role: &str, mut command: Command) {
            let stderr = fs::File::create(self.stderr_log(role)).expect("worker stderr log");
            let child = command
                .stdout(Stdio::null())
                .stderr(Stdio::from(stderr))
                .spawn()
                .unwrap_or_else(|error| panic!("spawn worker {role}: {error}"));
            self.workers.push((role.to_string(), child));
        }

        fn stderr_log(&self, role: &str) -> std::path::PathBuf {
            self.root.join(format!("{role}.stderr.log"))
        }

        /// `None` while the worker runs; otherwise whether it succeeded and a
        /// report with its exit status and stderr.
        fn poll(&mut self, role: &str) -> Option<(bool, String)> {
            let (succeeded, status) = match self.worker(role).try_wait() {
                Ok(None) => return None,
                Ok(Some(status)) => (status.success(), status.to_string()),
                Err(error) => (false, format!("an unpollable state ({error})")),
            };
            let stderr = fs::read(self.stderr_log(role))
                .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
                .unwrap_or_default();
            Some((
                succeeded,
                format!("worker {role} ended with {status}; its stderr: {stderr}"),
            ))
        }

        fn worker(&mut self, role: &str) -> &mut std::process::Child {
            self.workers
                .iter_mut()
                .find(|(name, _)| name == role)
                .map(|(_, child)| child)
                .unwrap_or_else(|| panic!("no worker {role}"))
        }

        /// Waits until `marker` exists. Fails at once, with the worker's
        /// report, when the worker that should write it has already exited.
        fn wait_for_marker(&mut self, role: &str, marker: &Path) {
            let started = Instant::now();
            while !marker.exists() {
                if let Some((_, report)) = self.poll(role) {
                    // The worker may have written the marker just before exiting.
                    assert!(
                        marker.exists(),
                        "marker {} never appeared: {report}",
                        marker_name(marker)
                    );
                    return;
                }
                assert!(
                    started.elapsed() < WORKER_MARKER_TIMEOUT,
                    "marker {} did not appear within {WORKER_MARKER_TIMEOUT:?}; worker {role} is still running",
                    marker_name(marker)
                );
                std::thread::sleep(MARKER_POLL_INTERVAL);
            }
        }

        /// Asserts that `entered`, which the second worker writes once it holds
        /// the lock, is still missing while `holder` runs. The marker is read
        /// before the holder is polled, so the lock is blamed only when the
        /// holder was still running afterwards; a holder that already exited
        /// (for example after its own wait timed out) is reported instead.
        fn assert_blocked_by(&mut self, holder: &str, entered: &Path) {
            let entered_early = entered.exists();
            if let Some((_, report)) = self.poll(holder) {
                panic!("{holder} exited before its release marker was written: {report}");
            }
            assert!(
                !entered_early,
                "{} appeared while {holder} still held the lock: the lock did not keep the two processes apart",
                marker_name(entered)
            );
        }

        fn release(&self) {
            fs::write(&self.release_marker, b"release").expect("write release marker");
        }

        /// Waits, with a cap, for a worker to exit and asserts that it succeeded.
        fn wait_success(&mut self, role: &str) {
            let started = Instant::now();
            loop {
                if let Some((succeeded, report)) = self.poll(role) {
                    assert!(succeeded, "{report}");
                    return;
                }
                assert!(
                    started.elapsed() < WORKER_MARKER_TIMEOUT,
                    "worker {role} did not exit within {WORKER_MARKER_TIMEOUT:?}"
                );
                std::thread::sleep(MARKER_POLL_INTERVAL);
            }
        }
    }

    impl Drop for WorkerProcesses {
        fn drop(&mut self) {
            // Must not panic: this also runs while a failed assertion unwinds.
            let _ = fs::write(&self.release_marker, b"release");
            let deadline = Instant::now() + WORKER_EXIT_GRACE;
            for (_, child) in &mut self.workers {
                while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
                    std::thread::sleep(MARKER_POLL_INTERVAL);
                }
                if !matches!(child.try_wait(), Ok(Some(_))) {
                    let _ = child.kill();
                }
                let _ = child.wait();
            }
        }
    }

    #[test]
    fn local_state_cross_process_worker() {
        let Ok(root) = std::env::var(LOCAL_STATE_WORKER_ROOT) else {
            return;
        };
        let role = std::env::var(LOCAL_STATE_WORKER_ROLE).expect("worker role");
        let root = std::path::PathBuf::from(root);
        fs::create_dir_all(&root).expect("worker root");
        fs::write(root.join(format!("{role}.started")), b"started").expect("worker started");
        let app = AppContext::for_test(root.clone());

        match role.as_str() {
            "enable-holder" => {
                with_local_state_lock(&app, || {
                    write_local_stop_store_unlocked(&app, true).expect("enable intent");
                    fs::write(root.join("enable-holder.entered"), b"entered")
                        .expect("holder entered");
                    wait_for_path(&root.join("release-enable"), WORKER_RELEASE_TIMEOUT);
                    write_local_stop_store_unlocked(&app, false).expect("holder release intent");
                })
                .expect("holder local-state lock");
            }
            "stop" => {
                let preparation = prepare_and_apply_stop_with_observer(
                    &app,
                    None,
                    None,
                    false,
                    test_now(),
                    || {
                        fs::write(root.join("stop.entered"), b"entered").expect("stop entered");
                    },
                );
                assert!(preparation.intent_error.is_none());
                assert!(!preparation.local_cleanup_pending);
            }
            "crash-enable" => {
                let identity = test_identity("crash-local-state");
                let _ = with_local_state_lock(&app, || {
                    write_local_stop_store_unlocked(&app, true).expect("crash enable intent");
                    save_binding(&app, &test_binding(&identity, 1)).expect("crash binding");
                    settings::update_quota_snapshot_sync_enabled(&app, true)
                        .expect("crash enabled settings");
                    fs::write(root.join("crash-enable.published"), b"published")
                        .expect("published marker");
                    std::process::exit(0);
                });
                panic!("crash worker unexpectedly returned");
            }
            _ => panic!("unknown worker role"),
        }
    }

    fn local_state_worker_command(executable: &Path, root: &Path, role: &str) -> Command {
        let mut command = Command::new(executable);
        command
            .args([
                "--exact",
                "quota_sync::tests::local_state_cross_process_worker",
                "--nocapture",
            ])
            .env(LOCAL_STATE_WORKER_ROOT, root)
            .env(LOCAL_STATE_WORKER_ROLE, role);
        command
    }

    fn spawn_local_state_worker(executable: &Path, root: &Path, role: &str) -> std::process::Child {
        local_state_worker_command(executable, root, role)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn local-state worker")
    }

    #[test]
    fn stop_cannot_clear_an_enable_intent_held_by_another_process() {
        let (app, root) = test_app();
        fs::create_dir_all(&root).expect("app data");
        let executable = std::env::current_exe().expect("current test executable");
        let mut workers = WorkerProcesses::new(&root, "release-enable");
        workers.spawn(
            "enable-holder",
            local_state_worker_command(&executable, &root, "enable-holder"),
        );
        workers.wait_for_marker("enable-holder", &root.join("enable-holder.entered"));

        workers.spawn(
            "stop",
            local_state_worker_command(&executable, &root, "stop"),
        );
        workers.wait_for_marker("stop", &root.join("stop.started"));
        std::thread::sleep(Duration::from_millis(100));
        workers.assert_blocked_by("enable-holder", &root.join("stop.entered"));
        assert!(load_local_stop_active_unlocked(&app).unwrap());

        workers.release();
        workers.wait_success("enable-holder");
        workers.wait_success("stop");
        assert!(
            root.join("stop.entered").exists(),
            "stop never entered the local-state lock after release-enable"
        );
        assert!(!has_local_stop_pending(&app));
        let lock_metadata = fs::symlink_metadata(root.join(LOCAL_STATE_LOCK_FILE))
            .expect("local-state lock metadata");
        assert!(lock_metadata.is_file());
        assert!(!lock_metadata.file_type().is_symlink());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(lock_metadata.permissions().mode() & 0o777, 0o600);
        }
        drop(workers);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn crashed_enable_keeps_restart_blocked_after_publishable_writes() {
        let (app, root) = test_app();
        let settings = AppSettings {
            quota_codex_local_enabled: true,
            ..AppSettings::default()
        };
        settings::save_settings_file(&app, &settings).expect("initial settings");
        let executable = std::env::current_exe().expect("current test executable");
        let mut worker = spawn_local_state_worker(&executable, &root, "crash-enable");
        assert!(worker.wait().expect("crash worker status").success());
        assert!(root.join("crash-enable.published").exists());

        let identity = test_identity("crash-local-state");
        assert_eq!(
            load_binding_result(&app).unwrap(),
            Some(test_binding(&identity, 1))
        );
        assert!(settings::load_settings(&app).quota_snapshot_sync_enabled);
        assert!(has_local_stop_pending(&app));
        let restarted = QuotaSyncCoordinator::default();
        assert!(has_any_cleanup_pending_at(&app, &restarted, test_now()));

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let status = runtime
            .block_on(sync_quota_snapshots_impl(&app))
            .expect("restart remains locally blocked");
        assert_eq!(status.state, QuotaSyncState::Error);
        assert_eq!(
            status.reason_code.as_deref(),
            Some("quota_sync_local_stop_incomplete")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn v2_enable_does_not_consume_legacy_remote_clear_markers() {
        let (app, root) = test_app();
        let identity = test_identity("pending-cas-race");
        let settings_state = Arc::new(Mutex::new(AppSettings {
            quota_codex_local_enabled: true,
            ..AppSettings::default()
        }));
        settings::save_settings_file(&app, &settings_state.lock().expect("settings"))
            .expect("initial settings");
        persist_remote_clear_pending_at(&app, &identity, Utc::now()).expect("old pending intent");
        commit_enable_local_state(&app, &settings_state, &test_binding(&identity, 1))
            .expect("v2 enable");
        assert_eq!(
            load_remote_clear_pending_at(&app, Utc::now())
                .expect("legacy marker preserved")
                .len(),
            1
        );
        assert!(!has_local_stop_pending(&app));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pending_cross_process_lock_worker() {
        let Ok(root) = std::env::var(PENDING_LOCK_WORKER_ROOT) else {
            return;
        };
        let role = std::env::var(PENDING_LOCK_WORKER_ROLE).expect("worker role");
        let root = std::path::PathBuf::from(root);
        fs::create_dir_all(&root).expect("worker root");
        fs::write(root.join(format!("{role}.started")), b"started").expect("worker started");
        let app = AppContext::for_test(root.clone());
        with_remote_clear_pending_cross_process_lock(&app, || {
            fs::write(root.join(format!("{role}.entered")), b"entered")
                .map_err(|error| error.to_string())?;
            if role == "holder" {
                wait_for_path(&root.join("release"), WORKER_RELEASE_TIMEOUT);
            }
            Ok(())
        })
        .expect("cross-process pending lock");
    }

    fn pending_lock_worker_command(executable: &Path, root: &Path, role: &str) -> Command {
        let mut command = Command::new(executable);
        command
            .args([
                "--exact",
                "quota_sync::tests::pending_cross_process_lock_worker",
                "--nocapture",
            ])
            .env(PENDING_LOCK_WORKER_ROOT, root)
            .env(PENDING_LOCK_WORKER_ROLE, role);
        command
    }

    #[test]
    fn pending_rmw_lock_serializes_distinct_processes() {
        let (app, root) = test_app();
        fs::create_dir_all(&root).expect("app data");
        let executable = std::env::current_exe().expect("current test executable");
        let mut workers = WorkerProcesses::new(&root, "release");
        workers.spawn(
            "holder",
            pending_lock_worker_command(&executable, app.app_data_dir(), "holder"),
        );
        workers.wait_for_marker("holder", &root.join("holder.entered"));
        workers.spawn(
            "waiter",
            pending_lock_worker_command(&executable, app.app_data_dir(), "waiter"),
        );
        workers.wait_for_marker("waiter", &root.join("waiter.started"));
        std::thread::sleep(Duration::from_millis(100));
        workers.assert_blocked_by("holder", &root.join("waiter.entered"));

        workers.release();
        workers.wait_success("holder");
        workers.wait_success("waiter");
        assert!(
            root.join("waiter.entered").exists(),
            "waiter never entered the pending lock after the release"
        );
        drop(workers);
        let _ = fs::remove_dir_all(root);
    }

    struct ClearRecoveryServer {
        origin: String,
        requests: Arc<Mutex<Vec<(String, Value)>>>,
        stop: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    impl ClearRecoveryServer {
        fn new(replies: Vec<(u16, String)>, on_request: impl Fn(usize) + Send + 'static) -> Self {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            listener.set_nonblocking(true).unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let seen = requests.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            let worker = std::thread::spawn(move || {
                let started = Instant::now();
                while !stopped.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(10)
                {
                    let (mut stream, _) = match listener.accept() {
                        Ok(connection) => connection,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(2));
                            continue;
                        }
                        Err(error) => panic!("accept: {error}"),
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let mut buffer = [0; 2048];
                    let header_end = loop {
                        let count = stream.read(&mut buffer).unwrap();
                        assert!(count > 0);
                        bytes.extend_from_slice(&buffer[..count]);
                        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                            break index + 4;
                        }
                    };
                    let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    while bytes.len() < header_end + length {
                        let count = stream.read(&mut buffer).unwrap();
                        assert!(count > 0);
                        bytes.extend_from_slice(&buffer[..count]);
                    }
                    let path = headers
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .to_string();
                    let payload =
                        serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
                    let index = {
                        let mut seen = seen.lock().unwrap();
                        let index = seen.len();
                        seen.push((path, payload));
                        index
                    };
                    on_request(index);
                    if let Some((status, body)) = replies.get(index) {
                        let response = if body.starts_with("@chunked:") {
                            let body = body.strip_prefix("@chunked:").unwrap();
                            format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n", body.len())
                        } else {
                            format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                        };
                        let _ = stream.write_all(response.as_bytes());
                    }
                    // No reply intentionally models a lost destructive response.
                }
            });
            Self {
                origin,
                requests,
                stop,
                worker: Some(worker),
            }
        }

        fn context(&self) -> QuotaRpcContext {
            QuotaRpcContext {
                identity: CloudIdentity {
                    origin: self.origin.clone(),
                    user_id: "recovery-owner".to_string(),
                },
                supabase_key: "sb_publishable_test".to_string(),
                access_token: "synthetic-token".to_string(),
                client: reqwest::Client::builder()
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap(),
                session_fence: None,
                test_session_generation: None,
                before_clear_authorization: None,
            }
        }

        fn paths(&self) -> Vec<String> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .map(|(path, _)| path.clone())
                .collect()
        }
    }

    impl Drop for ClearRecoveryServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Err(error) = self.worker.take().unwrap().join() {
                if !std::thread::panicking() {
                    std::panic::resume_unwind(error);
                }
            }
        }
    }

    fn recovery_metadata() -> Value {
        json!({"status":"ok", "transportVersion":2, "epoch":7, "revision":12,
            "generatedAt":"2026-07-15T08:30:00+08:00"})
    }

    fn recovery_reply(status: u16, value: Value) -> (u16, String) {
        (status, value.to_string())
    }

    fn recovery_state(app: &AppContext, identity: &CloudIdentity) -> Arc<Mutex<AppSettings>> {
        let settings = AppSettings {
            quota_snapshot_sync_enabled: true,
            ..AppSettings::default()
        };
        settings::save_settings_file(app, &settings).unwrap();
        save_binding(app, &test_binding(identity, 12)).unwrap();
        Arc::new(Mutex::new(settings))
    }

    fn recovery_run(future: impl std::future::Future<Output = ()>) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future);
    }

    #[test]
    fn clear_recovery_metadata_bypasses_invalid_envelopes_without_relaxing_get() {
        recovery_run(async {
            let capacity: Value = serde_json::from_str(CAPACITY).unwrap();
            let transport: Value = serde_json::from_str(TRANSPORT).unwrap();
            let overflow = capacity["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|case| case["name"] == "nine-active-v3")
                .unwrap()["response"]
                .clone();
            let mut bad = transport["readResponse"].clone();
            bad["transportVersion"] = json!(3);
            bad["providers"][0]["windows"][0]["observedAt"] = json!("invalid-time");
            let mut future_field = transport["readResponse"].clone();
            future_field["transportVersion"] = json!(3);
            future_field["providers"][0]["futurePrivateField"] = json!("must-not-read");
            for invalid in [overflow, bad, future_field] {
                let clear = capacity["historicalOverflowClearResponse"].clone();
                let mut empty = clear.clone();
                empty
                    .as_object_mut()
                    .unwrap()
                    .remove("clearedProviderCount");
                empty["transportVersion"] = json!(3);
                let server = ClearRecoveryServer::new(
                    vec![
                        recovery_reply(200, invalid),
                        recovery_reply(200, recovery_metadata()),
                        recovery_reply(200, clear),
                        recovery_reply(200, empty),
                    ],
                    |_| {},
                );
                let context = server.context();
                let (app, root) = test_app();
                let settings = recovery_state(&app, &context.identity);
                let coordinator = QuotaSyncCoordinator::default();
                assert!(matches!(
                    fetch_remote_snapshots(&context).await,
                    Err(QuotaRpcError::InvalidResponse)
                ));
                clear_quota_snapshots_with_context(
                    &app,
                    &settings,
                    &coordinator,
                    coordinator.begin().unwrap(),
                    &context,
                )
                .await
                .unwrap();
                assert!(fetch_remote_snapshots(&context)
                    .await
                    .unwrap()
                    .providers
                    .is_empty());
                assert!(!settings.lock().unwrap().quota_snapshot_sync_enabled);
                assert!(load_binding(&app).is_none());
                assert!(coordinator.sync_is_blocked());
                let requests = server.requests.lock().unwrap();
                assert!(requests[1]
                    .0
                    .ends_with("get_quota_snapshot_clear_metadata_v2"));
                assert_eq!(requests[2].1, json!({"p_transport_version":2,"p_epoch":7}));
                drop(requests);
                fs::remove_dir_all(root).unwrap();
            }
        });
    }

    #[test]
    fn clear_recovery_old_server_only_falls_back_to_valid_complete_reads() {
        recovery_run(async {
            let transport: Value = serde_json::from_str(TRANSPORT).unwrap();
            for valid in [true, false] {
                let mut read = transport["readResponse"].clone();
                if !valid {
                    read["providers"][0]["privateField"] = json!(true);
                }
                let server = ClearRecoveryServer::new(
                    vec![
                        recovery_reply(
                            404,
                            json!({"code":"PGRST202","message":"Could not find the function public.get_quota_snapshot_clear_metadata_v2 in the schema cache","details":"Searched for the function public.get_quota_snapshot_clear_metadata_v2 without parameters, but no matches were found in the schema cache.","hint":"Perhaps you meant to call the function public.get_quota_snapshots_v2"}),
                        ),
                        recovery_reply(
                            400,
                            json!({"code":"PGRST202","message":"missing","details":null,"hint":null}),
                        ),
                        recovery_reply(200, read),
                        recovery_reply(200, transport["clearResponse"].clone()),
                    ],
                    |_| {},
                );
                let context = server.context();
                let (app, root) = test_app();
                let settings = recovery_state(&app, &context.identity);
                let coordinator = QuotaSyncCoordinator::default();
                let result = clear_quota_snapshots_with_context(
                    &app,
                    &settings,
                    &coordinator,
                    coordinator.begin().unwrap(),
                    &context,
                )
                .await;
                assert_eq!(result.is_ok(), valid);
                assert_eq!(server.paths().len(), if valid { 4 } else { 3 });
                assert!(!server
                    .paths()
                    .iter()
                    .any(|path| path.ends_with("clear_quota_snapshots_v1")));
                fs::remove_dir_all(root).unwrap();
            }
        });
    }

    #[test]
    fn clear_recovery_invalid_metadata_never_sends_clear_or_falls_back() {
        recovery_run(async {
            let mut unknown = recovery_metadata();
            unknown["providers"] = json!([]);
            let mut backwards = recovery_metadata();
            backwards["revision"] = json!(11);
            let mut bad_epoch = recovery_metadata();
            bad_epoch["epoch"] = json!(7.5);
            let mut bad_time = recovery_metadata();
            bad_time["generatedAt"] = json!("invalid");
            let mut wrong_transport = recovery_metadata();
            wrong_transport["transportVersion"] = json!(3);
            let mut oversize = recovery_metadata();
            oversize["padding"] = json!("x".repeat(MAX_CLEAR_METADATA_BYTES));
            for metadata in [
                unknown,
                backwards,
                bad_epoch,
                bad_time,
                wrong_transport,
                oversize,
            ] {
                let server = ClearRecoveryServer::new(vec![recovery_reply(200, metadata)], |_| {});
                let context = server.context();
                let (app, root) = test_app();
                let settings = recovery_state(&app, &context.identity);
                let coordinator = QuotaSyncCoordinator::default();
                assert_eq!(
                    clear_quota_snapshots_with_context(
                        &app,
                        &settings,
                        &coordinator,
                        coordinator.begin().unwrap(),
                        &context
                    )
                    .await,
                    Err(QuotaRpcError::InvalidResponse)
                );
                assert_eq!(server.paths().len(), 1);
                assert!(settings.lock().unwrap().quota_snapshot_sync_enabled);
                fs::remove_dir_all(root).unwrap();
            }
        });
    }

    #[test]
    fn clear_recovery_claim_cancelled_before_send_emits_no_clear() {
        recovery_run(async {
            let coordinator = Arc::new(QuotaSyncCoordinator::default());
            let cancel = coordinator.clone();
            let server = ClearRecoveryServer::new(
                vec![recovery_reply(200, recovery_metadata())],
                move |_| {
                    cancel.invalidate(Some("cancelled"));
                },
            );
            let context = server.context();
            let (app, root) = test_app();
            let settings = recovery_state(&app, &context.identity);
            assert_eq!(
                clear_quota_snapshots_with_context(
                    &app,
                    &settings,
                    &coordinator,
                    coordinator.begin().unwrap(),
                    &context
                )
                .await,
                Err(QuotaRpcError::Superseded)
            );
            assert_eq!(server.paths().len(), 1);
            assert!(settings.lock().unwrap().quota_snapshot_sync_enabled);
            fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn clear_recovery_inflight_session_switch_never_stops_new_account() {
        recovery_run(async {
            let session = Arc::new(AtomicU64::new(1));
            let switch = session.clone();
            let (app, root) = test_app();
            let app_for_switch = app.clone();
            let settings = Arc::new(Mutex::new(AppSettings {
                quota_snapshot_sync_enabled: true,
                ..Default::default()
            }));
            let settings_for_switch = settings.clone();
            let new_identity = test_identity("new-account");
            let new_binding = test_binding(&new_identity, 40);
            let expected_binding = new_binding.clone();
            let new_cache = b"new-account-cache".to_vec();
            let cache_for_switch = new_cache.clone();
            let transport: Value = serde_json::from_str(TRANSPORT).unwrap();
            let server = ClearRecoveryServer::new(
                vec![
                    recovery_reply(200, recovery_metadata()),
                    recovery_reply(200, transport["clearResponse"].clone()),
                ],
                move |index| {
                    if index == 1 {
                        switch.store(2, Ordering::SeqCst);
                        save_binding(&app_for_switch, &new_binding).unwrap();
                        settings_for_switch
                            .lock()
                            .unwrap()
                            .quota_snapshot_sync_enabled = true;
                        settings::save_settings_file(
                            &app_for_switch,
                            &settings_for_switch.lock().unwrap(),
                        )
                        .unwrap();
                        fs::write(
                            app_for_switch.app_data_dir().join(REMOTE_CACHE_FILE),
                            &cache_for_switch,
                        )
                        .unwrap();
                    }
                },
            );
            let mut context = server.context();
            context.test_session_generation = Some((session, 1));
            save_binding(&app, &test_binding(&context.identity, 12)).unwrap();
            settings::save_settings_file(&app, &settings.lock().unwrap()).unwrap();
            let coordinator = QuotaSyncCoordinator::default();
            assert_eq!(
                clear_quota_snapshots_with_context(
                    &app,
                    &settings,
                    &coordinator,
                    coordinator.begin().unwrap(),
                    &context
                )
                .await,
                Err(QuotaRpcError::ClearOutcomeUnknown)
            );
            assert_eq!(load_binding(&app), Some(expected_binding));
            assert_eq!(fs::read(root.join(REMOTE_CACHE_FILE)).unwrap(), new_cache);
            assert!(settings.lock().unwrap().quota_snapshot_sync_enabled);
            assert_eq!(server.paths().len(), 2);
            fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn clear_recovery_lost_or_invalid_receipt_stops_same_owner_without_retry() {
        recovery_run(async {
            for reply in [
                None,
                Some(json!({"status":"not-confirmed"})),
                Some(json!({"oversize":"x".repeat(MAX_RPC_RESPONSE_BYTES)})),
            ] {
                let mut replies = vec![recovery_reply(200, recovery_metadata())];
                if let Some(reply) = reply {
                    replies.push(recovery_reply(200, reply));
                }
                let server = ClearRecoveryServer::new(replies, |_| {});
                let context = server.context();
                let (app, root) = test_app();
                let settings = recovery_state(&app, &context.identity);
                let coordinator = QuotaSyncCoordinator::default();
                assert_eq!(
                    clear_quota_snapshots_with_context(
                        &app,
                        &settings,
                        &coordinator,
                        coordinator.begin().unwrap(),
                        &context
                    )
                    .await,
                    Err(QuotaRpcError::ClearOutcomeUnknown)
                );
                assert!(coordinator.sync_is_blocked());
                assert_eq!(
                    coordinator.runtime_snapshot().1.as_deref(),
                    Some("quota_sync_clear_outcome_unknown")
                );
                assert!(!settings.lock().unwrap().quota_snapshot_sync_enabled);
                assert!(load_binding(&app).is_none());
                assert_eq!(server.paths().len(), 2);
                fs::remove_dir_all(root).unwrap();
            }
        });
    }

    #[test]
    fn clear_recovery_stale_epoch_and_capacity_errors_are_not_retried() {
        recovery_run(async {
            for message in ["stale_epoch", "capacity_exceeded"] {
                let server = ClearRecoveryServer::new(
                    vec![
                        recovery_reply(200, recovery_metadata()),
                        recovery_reply(
                            400,
                            json!({"code":"22023","message":format!("quota_snapshot_{message}"),
                    "details":null,"hint":null}),
                        ),
                    ],
                    |_| {},
                );
                let context = server.context();
                let (app, root) = test_app();
                let settings = recovery_state(&app, &context.identity);
                let coordinator = QuotaSyncCoordinator::default();
                assert_eq!(
                    clear_quota_snapshots_with_context(
                        &app,
                        &settings,
                        &coordinator,
                        coordinator.begin().unwrap(),
                        &context
                    )
                    .await,
                    Err(QuotaRpcError::ClearRejectedDeviceStopped)
                );
                assert!(!settings.lock().unwrap().quota_snapshot_sync_enabled);
                assert!(load_binding(&app).is_none());

                assert_eq!(server.paths().len(), 2);
                fs::remove_dir_all(root).unwrap();
            }
            assert_eq!(
                QuotaRpcError::CapacityExceeded.reason_code(),
                "quota_sync_capacity_exceeded"
            );
        });
    }

    #[test]
    fn clear_recovery_unknown_and_local_stop_failure_remain_distinct() {
        recovery_run(async {
            let (app, root) = test_app();
            let app_for_failure = app.clone();
            let server = ClearRecoveryServer::new(
                vec![
                    recovery_reply(200, recovery_metadata()),
                    recovery_reply(200, json!({"bad":"receipt"})),
                ],
                move |index| {
                    if index == 1 {
                        fs::remove_file(app_for_failure.app_data_dir().join(LOCAL_STOP_FILE))
                            .unwrap();
                        fs::create_dir(app_for_failure.app_data_dir().join(LOCAL_STOP_FILE))
                            .unwrap();
                    }
                },
            );
            let context = server.context();
            let settings = recovery_state(&app, &context.identity);

            let coordinator = QuotaSyncCoordinator::default();
            assert_eq!(
                clear_quota_snapshots_with_context(
                    &app,
                    &settings,
                    &coordinator,
                    coordinator.begin().unwrap(),
                    &context
                )
                .await,
                Err(QuotaRpcError::ClearOutcomeUnknownLocalStopIncomplete)
            );
            assert!(coordinator.sync_is_blocked());
            assert!(has_local_stop_pending(&app));
            assert_eq!(server.paths().len(), 2);
            fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn clear_recovery_chunked_metadata_budget_and_safe_error_tokens() {
        recovery_run(async {
            let body = format!(
                "@chunked:{}",
                json!({"padding":"x".repeat(MAX_CLEAR_METADATA_BYTES)})
            );
            let server = ClearRecoveryServer::new(vec![(200, body)], |_| {});
            let context = server.context();
            let (app, root) = test_app();
            let settings = recovery_state(&app, &context.identity);
            let coordinator = QuotaSyncCoordinator::default();
            assert_eq!(
                clear_quota_snapshots_with_context(
                    &app,
                    &settings,
                    &coordinator,
                    coordinator.begin().unwrap(),
                    &context
                )
                .await,
                Err(QuotaRpcError::InvalidResponse)
            );
            assert_eq!(server.paths().len(), 1);
            for error in [
                QuotaRpcError::ClearOutcomeUnknown,
                QuotaRpcError::ClearOutcomeUnknownLocalStopIncomplete,
                QuotaRpcError::ClearLocalStopIncomplete,
            ] {
                assert!(error
                    .safe_message()
                    .starts_with(&format!("{}:", error.reason_code())));
            }
            fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn clear_recovery_inflight_claim_cancel_never_stops_superseding_state() {
        recovery_run(async {
            let coordinator = Arc::new(QuotaSyncCoordinator::default());
            let cancel = coordinator.clone();
            let transport: Value = serde_json::from_str(TRANSPORT).unwrap();
            let server = ClearRecoveryServer::new(
                vec![
                    recovery_reply(200, recovery_metadata()),
                    recovery_reply(200, transport["clearResponse"].clone()),
                ],
                move |index| {
                    if index == 1 {
                        cancel.invalidate(Some("new-operation"));
                    }
                },
            );
            let context = server.context();
            let (app, root) = test_app();
            let settings = recovery_state(&app, &context.identity);

            assert_eq!(
                clear_quota_snapshots_with_context(
                    &app,
                    &settings,
                    &coordinator,
                    coordinator.begin().unwrap(),
                    &context
                )
                .await,
                Err(QuotaRpcError::ClearOutcomeUnknown)
            );
            assert!(load_binding(&app).is_none());
            assert!(!settings.lock().unwrap().quota_snapshot_sync_enabled);
            assert_eq!(
                coordinator.runtime_snapshot().1.as_deref(),
                Some("new-operation")
            );
            assert_eq!(server.paths().len(), 2);
            fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn clear_recovery_confirmed_remote_and_failed_local_stop_are_distinct() {
        recovery_run(async {
            let (app, root) = test_app();
            let app_for_failure = app.clone();
            let transport: Value = serde_json::from_str(TRANSPORT).unwrap();
            let server = ClearRecoveryServer::new(
                vec![
                    recovery_reply(200, recovery_metadata()),
                    recovery_reply(200, transport["clearResponse"].clone()),
                ],
                move |index| {
                    if index == 1 {
                        fs::remove_file(app_for_failure.app_data_dir().join(LOCAL_STOP_FILE))
                            .unwrap();
                        fs::create_dir(app_for_failure.app_data_dir().join(LOCAL_STOP_FILE))
                            .unwrap();
                    }
                },
            );
            let context = server.context();
            let settings = recovery_state(&app, &context.identity);

            let coordinator = QuotaSyncCoordinator::default();
            assert_eq!(
                clear_quota_snapshots_with_context(
                    &app,
                    &settings,
                    &coordinator,
                    coordinator.begin().unwrap(),
                    &context
                )
                .await,
                Err(QuotaRpcError::ClearLocalStopIncomplete)
            );
            assert!(coordinator.sync_is_blocked());
            assert!(has_local_stop_pending(&app));
            fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn clear_recovery_session_cancelled_during_metadata_never_sends_clear() {
        recovery_run(async {
            let session = Arc::new(AtomicU64::new(1));
            let revoke = session.clone();
            let server = ClearRecoveryServer::new(
                vec![recovery_reply(200, recovery_metadata())],
                move |_| {
                    revoke.store(2, Ordering::SeqCst);
                },
            );
            let mut context = server.context();
            context.test_session_generation = Some((session, 1));
            let (app, root) = test_app();
            let settings = recovery_state(&app, &context.identity);
            let coordinator = QuotaSyncCoordinator::default();
            assert_eq!(
                clear_quota_snapshots_with_context(
                    &app,
                    &settings,
                    &coordinator,
                    coordinator.begin().unwrap(),
                    &context
                )
                .await,
                Err(QuotaRpcError::Superseded)
            );
            assert_eq!(server.paths().len(), 1);
            assert!(settings.lock().unwrap().quota_snapshot_sync_enabled);
            fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn clear_recovery_last_authorization_window_rechecks_session_and_claim() {
        recovery_run(async {
            for cancel_session in [true, false] {
                let coordinator = Arc::new(QuotaSyncCoordinator::default());
                let session = Arc::new(AtomicU64::new(1));
                let server = ClearRecoveryServer::new(
                    vec![recovery_reply(200, recovery_metadata())],
                    |_| {},
                );
                let mut context = server.context();
                context.test_session_generation = Some((session.clone(), 1));
                let invalidate = coordinator.clone();
                context.before_clear_authorization = Some(Arc::new(move || {
                    if cancel_session {
                        session.store(2, Ordering::SeqCst);
                    } else {
                        invalidate.invalidate(Some("last-window-cancel"));
                    }
                }));
                let (app, root) = test_app();
                let settings = recovery_state(&app, &context.identity);
                let binding = fs::read(root.join(BINDING_FILE)).unwrap();
                assert_eq!(
                    clear_quota_snapshots_with_context(
                        &app,
                        &settings,
                        &coordinator,
                        coordinator.begin().unwrap(),
                        &context
                    )
                    .await,
                    Err(QuotaRpcError::Superseded)
                );
                assert_eq!(server.paths().len(), 1);
                assert_eq!(fs::read(root.join(BINDING_FILE)).unwrap(), binding);
                assert!(settings.lock().unwrap().quota_snapshot_sync_enabled);
                fs::remove_dir_all(root).unwrap();
            }
        });
    }

    #[test]
    fn clear_recovery_stop_failure_before_permission_never_dispatches() {
        recovery_run(async {
            let server =
                ClearRecoveryServer::new(vec![recovery_reply(200, recovery_metadata())], |_| {});
            let context = server.context();
            let (app, root) = test_app();
            let settings = recovery_state(&app, &context.identity);
            fs::create_dir(root.join(LOCAL_STOP_FILE)).unwrap();
            let coordinator = QuotaSyncCoordinator::default();
            assert_eq!(
                clear_quota_snapshots_with_context(
                    &app,
                    &settings,
                    &coordinator,
                    coordinator.begin().unwrap(),
                    &context
                )
                .await,
                Err(QuotaRpcError::ClearDispatchStopIncomplete)
            );
            assert_eq!(server.paths().len(), 1);
            assert!(coordinator.sync_is_blocked());
            assert!(has_local_stop_pending(&app));
            fs::remove_dir_all(root).unwrap();
        });
    }

    #[test]
    fn clear_recovery_metadata_arbitrary_404_never_falls_back() {
        recovery_run(async {
            for body in [
                json!({}),
                json!({"code":"PGRST205","message":"Table not found",
                "details":"No table matches the request", "hint":"Check the endpoint"}),
            ] {
                let server = ClearRecoveryServer::new(vec![recovery_reply(404, body)], |_| {});
                let context = server.context();
                let (app, root) = test_app();
                let settings = recovery_state(&app, &context.identity);
                let coordinator = QuotaSyncCoordinator::default();
                assert_eq!(
                    clear_quota_snapshots_with_context(
                        &app,
                        &settings,
                        &coordinator,
                        coordinator.begin().unwrap(),
                        &context
                    )
                    .await,
                    Err(QuotaRpcError::Http(404))
                );
                assert_eq!(server.paths().len(), 1);
                assert!(settings.lock().unwrap().quota_snapshot_sync_enabled);
                fs::remove_dir_all(root).unwrap();
            }
        });
    }

    #[test]
    fn clear_recovery_capacity_error_remains_actionable_on_ordinary_sync_transport() {
        recovery_run(async {
            let server = ClearRecoveryServer::new(
                vec![recovery_reply(
                    400,
                    json!({"code":"22023","message":"quota_snapshot_capacity_exceeded","details":null,"hint":null}),
                )],
                |_| {},
            );
            assert_eq!(
                server
                    .context()
                    .call("upsert_quota_snapshots_v3", &json!({}))
                    .await,
                Err(QuotaRpcError::CapacityExceeded)
            );
        });
    }

    #[test]
    fn clear_recovery_crash_worker() {
        let Ok(root) = std::env::var("TOKENLEDGER_CLEAR_CRASH_WORKER_ROOT") else {
            return;
        };
        let app = AppContext::for_test(root.into());
        let context = QuotaRpcContext {
            identity: CloudIdentity {
                origin: std::env::var("TOKENLEDGER_CLEAR_CRASH_WORKER_ORIGIN").unwrap(),
                user_id: "recovery-owner".to_string(),
            },
            supabase_key: "sb_publishable_test".to_string(),
            access_token: "fixture-token".to_string(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            session_fence: None,
            test_session_generation: None,
            before_clear_authorization: None,
        };
        let settings = recovery_state(&app, &context.identity);
        let coordinator = QuotaSyncCoordinator::default();
        recovery_run(async {
            let _ = clear_quota_snapshots_with_context(
                &app,
                &settings,
                &coordinator,
                coordinator.begin().unwrap(),
                &context,
            )
            .await;
        });
        panic!("worker must be killed before clear receipt");
    }

    #[test]
    fn clear_recovery_process_crash_after_server_clear_keeps_restart_stopped() {
        let (app, root) = test_app();
        let reached = Arc::new(AtomicBool::new(false));
        let signal = reached.clone();
        let gate = Arc::new(AtomicBool::new(false));
        let release = gate.clone();
        let server = ClearRecoveryServer::new(
            vec![recovery_reply(200, recovery_metadata())],
            move |index| {
                if index == 1 {
                    signal.store(true, Ordering::SeqCst);
                    let started = Instant::now();
                    while !release.load(Ordering::SeqCst)
                        && started.elapsed() < Duration::from_secs(5)
                    {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                }
            },
        );
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("quota_sync::tests::clear_recovery_crash_worker")
            .env("TOKENLEDGER_CLEAR_CRASH_WORKER_ROOT", &root)
            .env("TOKENLEDGER_CLEAR_CRASH_WORKER_ORIGIN", &server.origin)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !reached.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(2));
        }
        if !reached.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            gate.store(true, Ordering::SeqCst);
            panic!("worker did not reach simulated server clear");
        }
        child.kill().unwrap();
        child.wait().unwrap();
        gate.store(true, Ordering::SeqCst);
        let restarted = QuotaSyncCoordinator::default();
        assert!(!settings::load_settings(&app).quota_snapshot_sync_enabled);
        assert!(load_binding(&app).is_none());
        assert!(!root.join(REMOTE_CACHE_FILE).exists());
        assert!(!root.join(REMOTE_CLEAR_PENDING_FILE).exists());
        assert!(!restarted.sync_is_blocked());
        // The ordinary producer checks this persisted setting before get; a
        // fresh process cannot rebind automatically even with a newer epoch.
        assert_eq!(server.paths().len(), 2);
        let settings = Arc::new(Mutex::new(settings::load_settings(&app)));
        let new_binding = QuotaSyncBinding {
            epoch: 8,
            revision: 13,
            ..test_binding(&server.context().identity, 13)
        };
        commit_enable_local_state(&app, &settings, &new_binding).unwrap();
        assert!(settings::load_settings(&app).quota_snapshot_sync_enabled);
        assert_eq!(load_binding(&app), Some(new_binding));
        fs::remove_dir_all(root).unwrap();
    }

    fn test_binding(identity: &CloudIdentity, revision: u64) -> QuotaSyncBinding {
        QuotaSyncBinding {
            schema_version: BINDING_SCHEMA_VERSION,
            transport_version: TRANSPORT_VERSION,
            supabase_origin: identity.origin.clone(),
            user_id: identity.user_id.clone(),
            epoch: 7,
            revision,
            last_synced_at: None,
        }
    }

    #[test]
    fn complete_fixture_projects_all_contract_fields_without_local_only_fields() {
        let fixture: Value = serde_json::from_str(COMPLETE).expect("complete fixture");
        let providers =
            serde_json::from_value::<Vec<QuotaProviderEnvelope>>(fixture["providers"].clone())
                .expect("local providers");
        let settings = AppSettings {
            quota_codex_local_enabled: true,
            quota_claude_statusline_enabled: true,
            quota_antigravity_local_enabled: true,
            ..AppSettings::default()
        };
        let (projected, compact) =
            build_projection(&providers, &settings, &HashSet::new(), TRANSPORT_VERSION)
                .expect("projection");
        assert_eq!(projected.len(), 3);
        assert_eq!(
            projected
                .iter()
                .map(|provider| provider.windows.len())
                .sum::<usize>(),
            9
        );
        let text = String::from_utf8(compact).expect("utf8");
        assert!(!text.contains("accountLabel"));
        assert!(!text.contains("\"action\""));

        let unknown = &providers[3];
        assert!(!provider_is_authorized(
            &unknown.provider_id,
            &settings,
            &HashSet::new()
        ));
    }

    #[test]
    fn verified_custom_openapi_provider_enters_owner_bound_projection() {
        let fixture: Value = serde_json::from_str(CUSTOM_OPENAPI).expect("custom fixture");
        let providers =
            serde_json::from_value::<Vec<QuotaProviderEnvelope>>(fixture["providers"].clone())
                .expect("custom providers");
        let settings = AppSettings {
            quota_custom_endpoints: vec![crate::settings::CustomQuotaEndpointConfig {
                id: "0123456789abcdef01234567".to_string(),
                display_name: "研发账号额度".to_string(),
                url: "https://gateway.example.com/v1/me/quota".to_string(),
                enabled: true,
                api_key_configured: None,
            }],
            ..AppSettings::default()
        };
        let (projected, compact) =
            build_projection(&providers, &settings, &HashSet::new(), TRANSPORT_VERSION)
                .expect("projection");
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].windows.len(), 3);
        let text = String::from_utf8(compact).expect("utf8");
        assert!(!text.contains("apiKey"));
        assert!(!text.contains("gateway.example.com"));
        assert!(text.contains(&providers[0].provider_id));

        let mut disabled = settings;
        disabled.quota_custom_endpoints[0].enabled = false;
        assert!(
            build_projection(&providers, &disabled, &HashSet::new(), TRANSPORT_VERSION)
                .expect("disabled projection")
                .0
                .is_empty()
        );
    }

    #[test]
    fn states_fixture_is_forward_compatible_locally_but_strict_for_sync() {
        let fixture: Value = serde_json::from_str(STATES).expect("states fixture");
        let cases = fixture["envelopeCases"].as_array().expect("cases");
        for case in cases {
            let sync_outcome = case["syncOutcome"].as_str().expect("sync outcome");
            let parsed = serde_json::from_value::<SyncedQuotaProvider>(case["provider"].clone());
            assert_eq!(parsed.is_ok(), sync_outcome == "valid", "{}", case["name"]);
        }
        assert_eq!(fixture["absenceCase"]["outcome"], "unavailable-not-zero");
    }

    #[test]
    fn invalid_fixture_drives_strict_sync_rejections() {
        let fixture: Value = serde_json::from_str(INVALID).expect("invalid fixture");
        for case in fixture["cases"].as_array().expect("cases") {
            let providers =
                serde_json::from_value::<Vec<SyncedQuotaProvider>>(case["providers"].clone());
            let accepted = providers.as_ref().ok().is_some_and(|providers| {
                validate_synced_providers(providers, CURRENCY_TRANSPORT_VERSION).is_ok()
            });
            assert!(!accepted, "{} must fail closed", case["name"]);
        }

        for name in [
            "unsafe-arbitrary-url-action",
            "sync-account-label-disallowed",
        ] {
            let case = fixture["cases"]
                .as_array()
                .expect("cases")
                .iter()
                .find(|case| case["name"] == name)
                .expect("projection case");
            let local =
                serde_json::from_value::<QuotaProviderEnvelope>(case["providers"][0].clone())
                    .expect("valid local envelope");
            let projected = project_provider(&local);
            let text = serde_json::to_string(&projected).expect("projection json");
            assert!(!text.contains("accountLabel"));
            assert!(!text.contains("\"action\""));
        }
    }

    #[test]
    fn transport_fixture_freezes_rpc_keys_and_success_shapes() {
        let fixture: Value = serde_json::from_str(TRANSPORT).expect("transport fixture");
        let request = &fixture["upsertRequest"];
        assert_eq!(request["p_transport_version"], 2);
        assert_eq!(request["p_epoch"], 7);
        let providers = request["p_providers"]
            .as_array()
            .expect("entries")
            .iter()
            .map(|entry| {
                serde_json::from_value::<SyncedQuotaProvider>(entry["envelope"].clone())
                    .expect("strict provider")
            })
            .collect::<Vec<_>>();
        validate_synced_providers(&providers, TRANSPORT_VERSION)
            .expect("valid transport projection");
        let response = parse_get_response(fixture["readResponse"].clone(), TRANSPORT_VERSION)
            .expect("read response");
        assert_eq!(response.epoch, 7);
        assert_eq!(response.revision, 12);
        let clear =
            parse_clear_response(fixture["clearResponse"].clone(), None).expect("clear response");
        assert_eq!(clear.epoch, 8);
        assert_eq!(clear.revision, 13);
        assert_eq!(clear.cleared_provider_count, 1);

        let mut unsafe_integer = fixture["readResponse"].clone();
        unsafe_integer["epoch"] = json!(MAX_SAFE_INTEGER + 1);
        assert!(parse_get_response(unsafe_integer, TRANSPORT_VERSION).is_err());

        let mut orphan_active_state = fixture["readResponse"].clone();
        orphan_active_state["providerStates"]
            .as_array_mut()
            .expect("provider states")
            .push(json!({
                "providerId": "orphan-provider",
                "scope": "consumer-subscription",
                "generation": 0,
                "deleted": false,
                "sourceObservedAt": "2026-07-15T00:31:00Z",
                "receivedAt": "2026-07-15T00:31:01Z"
            }));
        assert!(parse_get_response(orphan_active_state, TRANSPORT_VERSION).is_err());
    }

    #[test]
    fn capacity_fixture_keeps_tombstones_and_enforces_active_states_on_both_transports() {
        let fixture: Value = serde_json::from_str(CAPACITY).expect("capacity fixture");
        let (app, root) = test_app();
        for case in fixture["cases"].as_array().expect("cases") {
            let value = case["response"].clone();
            let version = value["transportVersion"].as_u64().expect("version") as u8;
            let response = parse_get_response(value, version);
            assert_eq!(
                response.is_ok(),
                case["accepted"].as_bool().expect("accepted"),
                "{}",
                case["name"]
            );
            if let Ok(response) = response {
                assert_eq!(
                    response.providers.len() as u64,
                    case["expectedProviderCount"].as_u64().unwrap(),
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    response.provider_states.len() as u64,
                    case["expectedStateCount"].as_u64().unwrap()
                );
                assert_eq!(
                    response
                        .provider_states
                        .iter()
                        .filter(|state| !state.deleted)
                        .count() as u64,
                    case["expectedActiveCount"].as_u64().unwrap()
                );
                let cache = remote_cache_from_get(&test_identity("capacity"), &response);
                save_remote_cache(&app, &cache).expect("cache with tombstones");
                let bytes = quota::read_private_app_data_file(
                    app.app_data_dir(),
                    REMOTE_CACHE_FILE,
                    MAX_REMOTE_CACHE_BYTES,
                )
                .unwrap()
                .unwrap();
                let roundtrip: RemoteQuotaCache = serde_json::from_slice(&bytes).unwrap();
                validate_remote_cache(&roundtrip).expect("valid roundtrip");
                assert_eq!(roundtrip.provider_states, response.provider_states);
            }
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn capacity_fixture_retains_tombstone_generation_and_blocks_old_local_observations() {
        let fixture: Value = serde_json::from_str(CAPACITY).expect("capacity fixture");
        let provider: SyncedQuotaProvider =
            serde_json::from_value(fixture["uploadProvider"].clone()).unwrap();
        let tombstone: QuotaProviderState =
            serde_json::from_value(fixture["uploadTombstone"].clone()).unwrap();
        assert!(
            build_upsert_entries(vec![provider.clone()], std::slice::from_ref(&tombstone))
                .unwrap()
                .is_empty()
        );
        let mut fresh = provider;
        fresh.windows[0].observed_at = "2026-07-15T00:05:01Z".to_string();
        fresh.windows[0].fetched_at = "2026-07-15T00:05:02Z".to_string();
        let entries = build_upsert_entries(vec![fresh], std::slice::from_ref(&tombstone)).unwrap();
        assert_eq!(entries[0].generation, tombstone.generation);
    }

    #[test]
    fn capacity_fixture_clear_confirms_historical_overflow_and_rejects_partial_receipts() {
        let fixture: Value = serde_json::from_str(CAPACITY).unwrap();
        let clear = fixture["historicalOverflowClearResponse"].clone();
        let previous = QuotaSyncBinding {
            epoch: 7,
            ..test_binding(&test_identity("historical-capacity-clear"), 12)
        };
        let response = parse_clear_response(clear.clone(), Some(&previous)).unwrap();
        assert_eq!(response.cleared_provider_count, 9);
        assert_eq!(response.provider_states.len(), 9);
        for field in ["epoch", "revision"] {
            let mut stale = clear.clone();
            stale[field] = if field == "epoch" {
                json!(previous.epoch)
            } else {
                json!(previous.revision)
            };
            assert!(parse_clear_response(stale, Some(&previous)).is_err());
        }
        let mut invalid_count = clear.clone();
        invalid_count["clearedProviderCount"] = json!(10);
        assert!(parse_clear_response(invalid_count, Some(&previous)).is_err());
        let active = fixture["cases"][0]["response"].clone();
        let mut partial = clear.clone();
        partial["providers"] = active["providers"].clone();
        assert!(parse_clear_response(partial, Some(&previous)).is_err());
        let mut active_state = clear;
        active_state["providerStates"][0] = active["providerStates"][0].clone();
        assert!(parse_clear_response(active_state, Some(&previous)).is_err());
    }

    #[test]
    fn capacity_fixture_local_projection_rejects_nine_sources_without_selecting_eight() {
        let fixture: Value = serde_json::from_str(CAPACITY).unwrap();
        let case = fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == "nine-active-v2")
            .unwrap();
        let mut providers: Vec<QuotaProviderEnvelope> =
            serde_json::from_value(case["response"]["providers"].clone()).unwrap();
        let enabled_balances = providers
            .iter_mut()
            .map(|provider| {
                provider.provider_id = format!("balance-{}", provider.provider_id);
                for window in &mut provider.windows {
                    window.provider_id.clone_from(&provider.provider_id);
                }
                provider.provider_id.clone()
            })
            .collect::<HashSet<_>>();
        for version in [TRANSPORT_VERSION, CURRENCY_TRANSPORT_VERSION] {
            assert_eq!(
                build_projection(
                    &providers,
                    &AppSettings::default(),
                    &enabled_balances,
                    version
                ),
                Err("quota_sync_invalid_provider_count".to_string())
            );
        }
        assert_eq!(
            QuotaRpcError::InvalidProviderCount.reason_code(),
            "quota_sync_invalid_provider_count"
        );
        let message = QuotaRpcError::InvalidProviderCount.safe_message();
        assert!(message.contains("8 个活跃来源"));
        assert!(message.contains("关闭部分本机来源后重试"));
    }

    #[test]
    fn capacity_fixture_cache_keeps_the_existing_byte_budget() {
        let fixture: Value = serde_json::from_str(CAPACITY).unwrap();
        let response =
            parse_get_response(fixture["cases"][0]["response"].clone(), TRANSPORT_VERSION).unwrap();
        let mut cache = remote_cache_from_get(&test_identity("capacity-budget"), &response);
        let tombstone: QuotaProviderState =
            serde_json::from_value(fixture["uploadTombstone"].clone()).unwrap();
        for index in 0..1000 {
            let mut state = tombstone.clone();
            state.provider_id = format!("deleted-{index}-{}", "x".repeat(100));
            cache.provider_states.push(state);
        }
        validate_remote_cache(&cache).expect("tombstones do not consume active capacity");
        let (app, root) = test_app();
        assert_eq!(
            save_remote_cache(&app, &cache),
            Err("quota_sync_remote_cache_too_large".to_string())
        );
        assert!(quota::read_private_app_data_file(
            app.app_data_dir(),
            REMOTE_CACHE_FILE,
            MAX_REMOTE_CACHE_BYTES
        )
        .unwrap()
        .is_none());
        let _ = fs::remove_dir_all(root);
    }

    fn fixture_synced_providers(value: &Value) -> Vec<SyncedQuotaProvider> {
        serde_json::from_value::<Vec<SyncedQuotaProvider>>(value.clone()).expect("providers")
    }

    #[test]
    fn currency_fixture_syncs_only_through_transport_v3() {
        let fixture: Value = serde_json::from_str(CURRENCY).expect("currency fixture");
        let providers = fixture_synced_providers(&fixture["validProviders"]);
        validate_synced_providers(&providers, CURRENCY_TRANSPORT_VERSION)
            .expect("currency windows are valid on v3");
        assert_eq!(
            validate_synced_providers(&providers, TRANSPORT_VERSION),
            Err("quota_sync_invalid_window")
        );
        let local =
            serde_json::from_value::<Vec<QuotaProviderEnvelope>>(fixture["validProviders"].clone())
                .expect("local envelopes accept currency");
        for provider in &local {
            let expected = &fixture["expected"][&provider.provider_id]["windows"];
            for window in &provider.windows {
                assert_eq!(window.unit, QuotaUnit::Currency);
                assert_eq!(
                    window.currency.as_deref(),
                    expected[&window.window_id]["currency"].as_str()
                );
                assert_eq!(
                    window.remaining,
                    expected[&window.window_id]["remaining"].as_f64()
                );
            }
        }
        let projected = local.iter().map(project_provider).collect::<Vec<_>>();
        assert_eq!(projected, providers);
        assert!(strip_currency_providers(projected).is_empty());
    }

    #[test]
    fn currency_fixture_invalid_windows_fail_closed_on_every_transport() {
        let fixture: Value = serde_json::from_str(CURRENCY).expect("currency fixture");
        for case in fixture["cases"].as_array().expect("cases") {
            let accepted =
                serde_json::from_value::<Vec<SyncedQuotaProvider>>(case["providers"].clone())
                    .ok()
                    .is_some_and(|providers| {
                        validate_synced_providers(&providers, CURRENCY_TRANSPORT_VERSION).is_ok()
                    });
            assert!(!accepted, "{} must fail closed", case["name"]);
        }
    }

    #[test]
    fn v3_reader_drops_only_windows_with_unknown_units() {
        let fixture: Value = serde_json::from_str(CURRENCY).expect("currency fixture");
        for case in fixture["unknownUnitCases"].as_array().expect("cases") {
            let provider = case["provider"].clone();
            let observed = provider["windows"]
                .as_array()
                .expect("windows")
                .iter()
                .filter_map(|window| window["observedAt"].as_str())
                .filter_map(|value| DateTime::parse_from_rfc3339(value).ok())
                .max()
                .expect("observedAt");
            let response = json!({
                "status": "ok",
                "transportVersion": 3,
                "epoch": 1,
                "revision": 1,
                "generatedAt": "2026-10-04T12:00:00+08:00",
                "providers": [provider.clone()],
                "providerStates": [{
                    "providerId": provider["providerId"],
                    "scope": provider["scope"],
                    "generation": 0,
                    "deleted": false,
                    "sourceObservedAt": observed.to_rfc3339(),
                    "receivedAt": "2026-10-04T12:00:00+08:00"
                }]
            });
            assert!(
                parse_get_response(response.clone(), TRANSPORT_VERSION).is_err(),
                "{}: v2 readers stay strict",
                case["name"]
            );
            let parsed = parse_get_response(response, CURRENCY_TRANSPORT_VERSION)
                .unwrap_or_else(|_| panic!("{} must not fail the whole read", case["name"]));
            let expected = &case["expected"];
            if expected["kept"] == json!(false) {
                assert!(parsed.providers.is_empty(), "{}", case["name"]);
                continue;
            }
            let kept = &parsed.providers[0];
            assert_eq!(
                serde_json::to_value(kept.status).expect("status"),
                expected["status"],
                "{}",
                case["name"]
            );
            let window_ids = kept
                .windows
                .iter()
                .map(|window| window.window_id.as_str())
                .collect::<Vec<_>>();
            assert_eq!(json!(window_ids), expected["windowIds"], "{}", case["name"]);
        }
    }

    #[test]
    fn transport_v3_fixture_freezes_projection_and_rejections() {
        let fixture: Value = serde_json::from_str(TRANSPORT_V3).expect("transport v3 fixture");
        assert_eq!(fixture["functions"]["read"], get_function_name(3));
        assert_eq!(fixture["functions"]["write"], upsert_function_name(3));
        assert_eq!(get_function_name(2), "get_quota_snapshots_v2");
        assert_eq!(upsert_function_name(2), "upsert_quota_snapshots_v2");

        let v3 = parse_get_response(
            fixture["v3ReadResponse"].clone(),
            CURRENCY_TRANSPORT_VERSION,
        )
        .expect("v3 read");
        assert_eq!(v3.providers.len(), 2);
        assert!(v3.providers.iter().any(provider_has_currency));
        let v2 = parse_get_response(fixture["v2ReadResponse"].clone(), TRANSPORT_VERSION)
            .expect("v2 projection read");
        assert_eq!(v2.providers.len(), 1);
        assert!(!v2.providers.iter().any(provider_has_currency));
        assert_eq!(v2.provider_states.len(), 1);
        assert_eq!((v2.epoch, v2.revision), (v3.epoch, v3.revision));

        assert!(
            parse_get_response(fixture["v3ReadResponse"].clone(), TRANSPORT_VERSION).is_err(),
            "a v3 body is never accepted by the v2 parser"
        );
        let mut leaked = fixture["v3ReadResponse"].clone();
        leaked["transportVersion"] = json!(2);
        assert!(
            parse_get_response(leaked, TRANSPORT_VERSION).is_err(),
            "currency in a v2 body fails closed"
        );

        let request = &fixture["v3UpsertRequest"];
        assert_eq!(request["p_transport_version"], 3);
        let entries = request["p_providers"]
            .as_array()
            .expect("entries")
            .iter()
            .map(|entry| entry["envelope"].clone())
            .collect::<Vec<_>>();
        let envelopes = fixture_synced_providers(&json!(entries));
        validate_synced_providers(&envelopes, CURRENCY_TRANSPORT_VERSION).expect("v3 upsert");
        assert!(validate_synced_providers(&envelopes, TRANSPORT_VERSION).is_err());
        assert_eq!(
            fixture["v2UpsertRejected"]["error"]["message"],
            "quota_snapshot_invalid_payload"
        );
    }

    #[test]
    fn new_client_on_legacy_cloud_strips_currency_before_v2_upload() {
        let fixture: Value = serde_json::from_str(TRANSPORT_V3).expect("transport v3 fixture");
        let fallback = &fixture["legacyCloudFallback"];
        assert_eq!(fallback["missingV3Response"]["status"], 404);
        assert_eq!(fallback["missingV3Response"]["body"]["code"], "PGRST202");
        let local = serde_json::from_value::<Vec<QuotaProviderEnvelope>>(
            fallback["localProviders"].clone(),
        )
        .expect("local providers");
        let projected = local.iter().map(project_provider).collect::<Vec<_>>();
        let uploaded = strip_currency_providers(projected.clone());
        let uploaded_ids = uploaded
            .iter()
            .map(|provider| provider.provider_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(json!(uploaded_ids), fallback["expectedV2UploadProviderIds"]);
        let bytes = encode_projection(&uploaded, TRANSPORT_VERSION).expect("v2 upload");
        assert!(!String::from_utf8(bytes).expect("utf8").contains("currency"));
        assert!(encode_projection(&projected, TRANSPORT_VERSION).is_err());
        encode_projection(&projected, CURRENCY_TRANSPORT_VERSION).expect("v3 upload");

        let displayed = merge_provider_sets(local, Vec::new());
        let displayed_ids = displayed
            .iter()
            .map(|provider| provider.provider_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            json!(displayed_ids),
            fallback["expectedLocalDisplayProviderIds"]
        );
    }

    fn balance_fixture_envelopes() -> Vec<QuotaProviderEnvelope> {
        let fixture: Value = serde_json::from_str(BALANCE).expect("balance fixture");
        fixture["providers"]
            .as_array()
            .expect("providers")
            .iter()
            .map(|entry| {
                serde_json::from_value::<QuotaProviderEnvelope>(entry["envelope"].clone())
                    .expect("balance envelope")
            })
            .collect()
    }

    fn projected_ids(projected: &[SyncedQuotaProvider]) -> Vec<&str> {
        projected
            .iter()
            .map(|provider| provider.provider_id.as_str())
            .collect()
    }

    #[test]
    fn enabled_balance_sources_upload_through_v3_and_disabled_ones_stay_local() {
        let providers = balance_fixture_envelopes();
        let settings = AppSettings::default();
        let enabled = HashSet::from([
            "balance-moonshot".to_string(),
            "balance-deepseek".to_string(),
        ]);
        let (projected, compact) =
            build_projection(&providers, &settings, &enabled, CURRENCY_TRANSPORT_VERSION)
                .expect("v3 projection");
        assert_eq!(
            projected_ids(&projected),
            vec!["balance-moonshot", "balance-deepseek"]
        );
        let text = String::from_utf8(compact).expect("utf8");
        assert!(text.contains("\"currency\":\"CNY\""));
        assert!(!text.contains("balance-openrouter"));

        let (none, _) = build_projection(
            &providers,
            &settings,
            &HashSet::new(),
            CURRENCY_TRANSPORT_VERSION,
        )
        .expect("nothing enabled");
        assert!(none.is_empty());
        assert!(!provider_is_authorized(
            "balance-moonshot",
            &settings,
            &HashSet::from(["balance-deepseek".to_string()])
        ));
    }

    #[test]
    fn enabled_balance_sources_are_stripped_when_falling_back_to_legacy_v2_cloud() {
        let complete: Value = serde_json::from_str(COMPLETE).expect("complete fixture");
        let mut providers =
            serde_json::from_value::<Vec<QuotaProviderEnvelope>>(complete["providers"].clone())
                .expect("local providers");
        providers.extend(balance_fixture_envelopes());
        let settings = AppSettings {
            quota_codex_local_enabled: true,
            ..AppSettings::default()
        };
        let enabled = HashSet::from(["balance-deepseek".to_string()]);
        let (legacy, compact) =
            build_projection(&providers, &settings, &enabled, TRANSPORT_VERSION)
                .expect("v2 projection");
        assert_eq!(projected_ids(&legacy), vec![quota::CODEX_PROVIDER_ID]);
        assert!(!String::from_utf8(compact)
            .expect("utf8")
            .contains("currency"));
        let (current, _) =
            build_projection(&providers, &settings, &enabled, CURRENCY_TRANSPORT_VERSION)
                .expect("v3 projection");
        assert_eq!(
            projected_ids(&current),
            vec![quota::CODEX_PROVIDER_ID, "balance-deepseek"]
        );
    }

    #[test]
    fn stale_balance_reasons_are_registered_for_sync() {
        let mut deepseek = balance_fixture_envelopes()
            .into_iter()
            .find(|provider| {
                provider.provider_id == "balance-deepseek" && provider.status == QuotaStatus::Ok
            })
            .expect("deepseek ok envelope");
        deepseek.status = QuotaStatus::Stale;
        let enabled = HashSet::from(["balance-deepseek".to_string()]);
        for reason in quota::BALANCE_REASON_CODES {
            assert!(reason_code_registered(reason), "{reason}");
            let mut stale = deepseek.clone();
            for window in &mut stale.windows {
                window.status = QuotaWindowStatus::Stale;
                window.reason_code = Some(reason.to_string());
            }
            stale.reason_code = Some(reason.to_string());
            let (projected, _) = build_projection(
                &[stale],
                &AppSettings::default(),
                &enabled,
                CURRENCY_TRANSPORT_VERSION,
            )
            .unwrap_or_else(|error| panic!("{reason}: {error}"));
            assert_eq!(projected.len(), 1, "{reason}");
        }
        assert!(!reason_code_registered("experimental_consent_required_x"));
    }

    // quota-provider-v1 §4: these codes ride on LKG `stale` envelopes. They
    // stay off the wire, so older readers keep parsing the cloud snapshot.
    #[test]
    fn native_lkg_stale_reasons_upload_as_generic_code() {
        for reason in [
            "claude_native_authorization_required",
            "claude_native_cli_unavailable",
            "claude_native_timeout",
            "claude_native_usage_unavailable",
            "claude_native_subscription_unavailable",
            "claude_native_response_invalid",
            "antigravity_native_authorization_required",
            "antigravity_native_source_not_found",
            "antigravity_native_port_unavailable",
            "antigravity_native_timeout",
            "antigravity_native_response_invalid",
            "antigravity_codexbar_unavailable",
            "antigravity_codexbar_timeout",
            "antigravity_codexbar_response_invalid",
        ] {
            assert!(!reason_code_registered(reason), "{reason}");
            assert_eq!(
                cloud_reason_code(&Some(reason.to_string())).as_deref(),
                Some("source_temporarily_unavailable"),
                "{reason}"
            );
        }
        assert_eq!(
            cloud_reason_code(&Some("claude_codexbar_timeout".to_string())).as_deref(),
            Some("claude_codexbar_timeout")
        );
        assert_eq!(
            cloud_reason_code(&Some("experimental_consent_required".to_string())).as_deref(),
            Some("experimental_consent_required")
        );
        for unknown in [
            "claude_native_timeout_x",
            "antigravity_native_",
            "antigravity_codexbar_unknown",
        ] {
            assert!(!reason_code_registered(unknown), "{unknown}");
            assert!(!local_only_stale_reason(unknown), "{unknown}");
            assert_eq!(
                cloud_reason_code(&Some(unknown.to_string())).as_deref(),
                Some(unknown),
                "unknown local code must not be rewritten: {unknown}"
            );
        }

        let settings = AppSettings {
            quota_claude_codexbar_enabled: true,
            ..AppSettings::default()
        };
        for reason in [
            "claude_native_timeout",
            "claude_native_authorization_required",
        ] {
            let mut stale = claude_test_provider("native", 40.0, 60.0, "2026-10-17T00:00:00Z");
            stale.status = QuotaStatus::Stale;
            stale.reason_code = Some(reason.to_string());
            for window in &mut stale.windows {
                window.status = QuotaWindowStatus::Stale;
                window.reason_code = Some(reason.to_string());
            }
            let (projected, _) = build_projection(
                &[stale],
                &settings,
                &HashSet::new(),
                CURRENCY_TRANSPORT_VERSION,
            )
            .unwrap_or_else(|error| panic!("{reason}: {error}"));
            assert_eq!(projected.len(), 1, "{reason}");
            assert_eq!(
                projected[0].reason_code.as_deref(),
                Some("source_temporarily_unavailable"),
                "{reason}"
            );
            assert!(projected[0].windows.iter().all(|window| {
                window.reason_code.as_deref() == Some("source_temporarily_unavailable")
            }));
        }

        let unknown = "claude_native_timeout_x";
        let mut illegal_envelope =
            claude_test_provider("native", 40.0, 60.0, "2026-10-17T00:00:00Z");
        illegal_envelope.status = QuotaStatus::Stale;
        illegal_envelope.reason_code = Some(unknown.to_string());
        for window in &mut illegal_envelope.windows {
            window.status = QuotaWindowStatus::Stale;
            window.reason_code = Some("source_temporarily_unavailable".to_string());
        }
        assert_eq!(
            build_projection(
                &[illegal_envelope],
                &settings,
                &HashSet::new(),
                CURRENCY_TRANSPORT_VERSION,
            )
            .unwrap_err(),
            "quota_sync_invalid_provider"
        );

        let mut illegal_window = claude_test_provider("native", 40.0, 60.0, "2026-10-17T00:00:00Z");
        illegal_window.status = QuotaStatus::Stale;
        illegal_window.reason_code = Some("source_temporarily_unavailable".to_string());
        for window in &mut illegal_window.windows {
            window.status = QuotaWindowStatus::Stale;
            window.reason_code = Some(unknown.to_string());
        }
        assert_eq!(
            build_projection(
                &[illegal_window],
                &settings,
                &HashSet::new(),
                CURRENCY_TRANSPORT_VERSION,
            )
            .unwrap_err(),
            "quota_sync_invalid_window"
        );
    }

    #[test]
    fn delete_through_v2_keeps_cached_currency_providers_from_v3_read() {
        let fixture: Value = serde_json::from_str(TRANSPORT_V3).expect("transport v3 fixture");
        let before = parse_get_response(
            fixture["v3ReadResponse"].clone(),
            CURRENCY_TRANSPORT_VERSION,
        )
        .expect("v3 read");
        let delete = serde_json::from_value::<DeleteQuotaProviderResponse>(json!({
            "status": "ok",
            "transportVersion": 2,
            "epoch": 7,
            "revision": 14,
            "generatedAt": "2026-10-04T12:01:00+08:00",
            "providers": [],
            "providerStates": [{
                "providerId": "openai-codex-local",
                "scope": "consumer-subscription",
                "generation": 4,
                "deleted": true,
                "receivedAt": "2026-10-04T12:01:00+08:00"
            }],
            "deletedProviderId": "openai-codex-local",
            "deletedScope": "consumer-subscription",
            "providerGeneration": 4
        }))
        .expect("delete response");
        let identity = test_identity("delete-v3");
        let cache = remote_cache_from_delete(&identity, &delete, &before);
        assert_eq!(cache.transport_version, CURRENCY_TRANSPORT_VERSION);
        assert_eq!(cache.providers.len(), 1);
        assert_eq!(cache.providers[0].provider_id, "balance-deepseek");
        assert_eq!(cache.provider_states.len(), 2);
        validate_remote_cache(&cache).expect("merged cache stays valid");

        let legacy_before =
            parse_get_response(fixture["v2ReadResponse"].clone(), TRANSPORT_VERSION)
                .expect("v2 read");
        let legacy = remote_cache_from_delete(&identity, &delete, &legacy_before);
        assert_eq!(legacy.transport_version, TRANSPORT_VERSION);
        assert!(legacy.providers.is_empty());
    }

    #[test]
    fn display_merge_uses_source_time_and_keeps_arbitrarily_old_cloud_lkg() {
        let fixture: Value = serde_json::from_str(TRANSPORT).expect("transport fixture");
        let synced = serde_json::from_value::<SyncedQuotaProvider>(
            fixture["readResponse"]["providers"][0].clone(),
        )
        .expect("synced provider");
        let remote_old = synced_provider_into_display(
            &synced,
            DateTime::parse_from_rfc3339("2036-07-15T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
        );
        assert_eq!(remote_old.status, QuotaStatus::Stale);
        assert_eq!(remote_old.windows[0].status, QuotaWindowStatus::Stale);

        let local_error = QuotaProviderEnvelope {
            status: QuotaStatus::Error,
            windows: Vec::new(),
            reason_code: Some("source_temporarily_unavailable".to_string()),
            ..remote_old.clone()
        };
        let merged = merge_provider_sets(vec![local_error], vec![remote_old.clone()]);
        assert_eq!(merged, vec![remote_old.clone()]);

        let mut local_tie = remote_old.clone();
        local_tie.windows[0].used = Some(99.0);
        local_tie.windows[0].remaining = Some(1.0);
        let merged = merge_provider_sets(vec![local_tie.clone()], vec![remote_old]);
        assert_eq!(merged, vec![local_tie], "local wins an observedAt tie");
    }

    #[test]
    fn claude_display_and_upload_prefer_fresh_complete_roles_over_stale_source_priority() {
        let local_native = claude_test_provider("native", 0.0, 0.0, "2026-07-15T00:10:00Z");
        let mut remote_codexbar =
            claude_test_provider("codexbar", 0.0, 38.0, "2026-07-15T00:05:00Z");
        remote_codexbar.status = QuotaStatus::Stale;
        for window in &mut remote_codexbar.windows {
            window.status = QuotaWindowStatus::Stale;
            window.reason_code = Some("observation_stale".to_string());
        }

        let merged = merge_provider_sets(vec![local_native.clone()], vec![remote_codexbar.clone()]);
        let weekly = merged[0]
            .windows
            .iter()
            .find(|window| window.window_id == "native-cli-seven-day")
            .expect("fresh local weekly window");
        assert_eq!(weekly.remaining, Some(100.0));
        assert_eq!(weekly.status, QuotaWindowStatus::Ok);

        let publishable =
            retain_publishable_local_providers(vec![local_native], &[remote_codexbar.clone()]);
        assert_eq!(
            publishable.len(),
            1,
            "a fresh complete provider may replace stale data regardless of source priority"
        );

        let mut partial_native = claude_test_provider("native", 0.0, 0.0, "2026-07-15T00:10:00Z");
        partial_native.windows.truncate(1);
        assert!(
            retain_publishable_local_providers(vec![partial_native], &[remote_codexbar.clone()])
                .is_empty(),
            "a partial native provider must not delete the remote weekly role"
        );

        let trusted_local = claude_test_provider("codexbar", 0.0, 38.0, "2026-07-15T00:15:00Z");
        let remote_native = claude_test_provider("native", 0.0, 0.0, "2026-07-15T00:10:00Z");
        assert_eq!(
            retain_publishable_local_providers(vec![trusted_local], &[remote_native]).len(),
            1,
            "a later independently normalized observation can recover cloud sync"
        );
    }

    #[test]
    fn upload_entries_skip_errors_and_pre_delete_observations() {
        let fixture: Value = serde_json::from_str(TRANSPORT).expect("transport fixture");
        let synced = serde_json::from_value::<SyncedQuotaProvider>(
            fixture["readResponse"]["providers"][0].clone(),
        )
        .expect("synced provider");
        let tombstone = QuotaProviderState {
            provider_id: synced.provider_id.clone(),
            scope: synced.scope,
            generation: 4,
            deleted: true,
            source_observed_at: None,
            received_at: "2026-07-15T08:31:00+08:00".to_string(),
        };
        assert!(
            build_upsert_entries(vec![synced.clone()], std::slice::from_ref(&tombstone))
                .expect("entries")
                .is_empty()
        );

        let mut fresh = synced;
        fresh.windows[0].observed_at = "2026-07-15T08:32:00+08:00".to_string();
        fresh.windows[0].fetched_at = "2026-07-15T08:32:01+08:00".to_string();
        let entries = build_upsert_entries(vec![fresh], &[tombstone]).expect("fresh entry");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].generation, 4);
    }

    #[test]
    fn byte_and_count_limits_fail_closed_without_truncation() {
        let fixture: Value = serde_json::from_str(TRANSPORT).expect("transport fixture");
        let mut providers = vec![serde_json::from_value::<SyncedQuotaProvider>(
            fixture["upsertRequest"]["p_providers"][0]["envelope"].clone(),
        )
        .expect("provider")];
        let template = providers[0].clone();
        while providers.len() <= MAX_PROVIDERS {
            let mut provider = template.clone();
            provider.provider_id = format!("provider-{}", providers.len());
            for window in &mut provider.windows {
                window.provider_id.clone_from(&provider.provider_id);
            }
            providers.push(provider);
        }
        assert_eq!(
            validate_synced_providers(&providers, TRANSPORT_VERSION),
            Err("quota_sync_invalid_provider_count")
        );

        let mut oversized = template;
        oversized.display_name = "x".repeat(MAX_STRING_BYTES + 1);
        assert!(validate_synced_providers(&[oversized], TRANSPORT_VERSION).is_err());

        let mut max_batch = Vec::new();
        let base = serde_json::from_value::<SyncedQuotaProvider>(
            fixture["upsertRequest"]["p_providers"][0]["envelope"].clone(),
        )
        .expect("provider");
        for provider_index in 0..MAX_PROVIDERS {
            let mut provider = base.clone();
            provider.provider_id = format!("provider-{provider_index}");
            provider.display_name = "x".repeat(MAX_STRING_BYTES);
            provider.windows.clear();
            for window_index in 0..MAX_WINDOWS_PER_PROVIDER {
                let mut window = base.windows[0].clone();
                window.provider_id.clone_from(&provider.provider_id);
                window.window_id = format!("window-{window_index}");
                window.window_label = "y".repeat(MAX_STRING_BYTES);
                provider.windows.push(window);
            }
            max_batch.push(provider);
        }
        validate_synced_providers(&max_batch, TRANSPORT_VERSION)
            .expect("semantic limits still valid");
        assert_eq!(
            encode_projection(&max_batch, TRANSPORT_VERSION),
            Err("quota_sync_payload_too_large".to_string())
        );

        let mut too_many_windows = max_batch[0].clone();
        let mut extra = too_many_windows.windows[0].clone();
        extra.window_id = "window-extra".to_string();
        too_many_windows.windows.push(extra);
        assert!(validate_synced_providers(&[too_many_windows], TRANSPORT_VERSION).is_err());

        let mut utf8_id = max_batch[0].clone();
        utf8_id.provider_id = "额".repeat(43);
        assert!(utf8_id.provider_id.chars().count() < MAX_STABLE_ID_BYTES);
        assert!(utf8_id.provider_id.len() > MAX_STABLE_ID_BYTES);
        assert!(validate_synced_providers(&[utf8_id], TRANSPORT_VERSION).is_err());
        assert_eq!(PRODUCER_MAX_BYTES, 61_440);
    }

    #[test]
    fn service_role_keys_are_rejected_without_new_dependencies() {
        assert!(commands::is_forbidden_supabase_service_role_key(
            "sb_secret_example"
        ));
        assert!(commands::is_forbidden_supabase_service_role_key(
            "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature"
        ));
        assert!(!commands::is_forbidden_supabase_service_role_key(
            "sb_publishable_example"
        ));
    }

    #[test]
    fn invalid_generation_cannot_finish_a_newer_operation() {
        let coordinator = QuotaSyncCoordinator::default();
        let first = coordinator.begin().expect("first claim");
        coordinator.invalidate(Some("revoked"));
        let second = coordinator.begin().expect("second claim");
        coordinator.finish(first, None);
        assert!(coordinator.is_current(second));
    }

    #[test]
    fn remote_clear_warning_survives_restart_and_is_identity_scoped() {
        let (app, root) = test_app();
        let now = test_now();
        let first = QuotaSyncCoordinator::default();
        let identity_a = test_identity("project-a");
        let identity_b = test_identity("project-b");
        first.record_remote_clear_failure(&app, Some(&identity_a), now);
        first.record_remote_clear_failure(&app, Some(&identity_b), now);
        assert!(has_remote_clear_pending_at(&app, &first, now));

        let persisted = fs::read_to_string(root.join(REMOTE_CLEAR_PENDING_FILE))
            .expect("private pending state");
        assert!(persisted.contains("pendingSince"));
        assert!(persisted.contains("expiresAt"));
        assert!(!persisted.contains("access_token"));
        assert!(!persisted.contains("refresh_token"));

        let restarted = QuotaSyncCoordinator::default();
        assert!(has_remote_clear_pending_at(&app, &restarted, now));
        let claim_b = restarted.begin().expect("B reauthorization claim");
        let old_b_intent = with_local_state_lock(&app, || {
            remote_clear_pending_intent_id_under_local_state(&app, &identity_b, now)
        })
        .expect("B local-state lock")
        .expect("B pending intent");
        with_local_state_lock(&app, || {
            remove_remote_clear_pending_if_intent_matches_under_local_state(
                &app,
                &identity_b,
                old_b_intent.as_deref(),
                now,
            )
        })
        .expect("B local-state cleanup lock")
        .expect("B pending cleanup");
        restarted
            .commit_reauthorized(&app, claim_b, &identity_b, now, || Ok(()))
            .expect("B reauthorization");
        assert!(has_remote_clear_pending_at(&app, &restarted, now));
        let entries_after_b = load_remote_clear_pending_at(&app, now).expect("pending after B");
        assert_eq!(entries_after_b.len(), 1);
        assert_eq!(entries_after_b[0].user_id, identity_a.user_id);

        restarted.record_remote_clear_failure(&app, Some(&identity_b), now);
        restarted.resolve_remote_clear(&app, &identity_a, now);
        assert!(has_remote_clear_pending_at(&app, &restarted, now));
        let entries_after_a_clear =
            load_remote_clear_pending_at(&app, now).expect("pending after A clear");
        assert_eq!(entries_after_a_clear.len(), 1);
        assert_eq!(entries_after_a_clear[0].user_id, identity_b.user_id);
        restarted.resolve_remote_clear(&app, &identity_b, now);
        assert!(!has_remote_clear_pending_at(&app, &restarted, now));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_or_unsupported_pending_store_fails_closed_without_replacement() {
        let (app, root) = test_app();
        fs::create_dir_all(&root).expect("app data");
        let path = root.join(REMOTE_CLEAR_PENDING_FILE);
        let identity = test_identity("corrupt");

        for bytes in [
            b"{not-json".as_slice(),
            br#"{"schemaVersion":2,"entries":[]}"#.as_slice(),
        ] {
            fs::write(&path, bytes).expect("write invalid pending store");
            let restarted = QuotaSyncCoordinator::default();
            assert!(has_remote_clear_pending_at(&app, &restarted, test_now()));
            assert!(load_remote_clear_pending_at(&app, test_now()).is_err());
            assert!(persist_remote_clear_pending_at(&app, &identity, test_now()).is_err());
            assert!(remove_remote_clear_pending_at(&app, &identity, test_now()).is_err());
            assert_eq!(fs::read(&path).expect("invalid store retained"), bytes);
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn clearing_last_pending_identity_atomically_commits_valid_empty_store() {
        let (app, root) = test_app();
        let identity = test_identity("empty-store");
        persist_remote_clear_pending_at(&app, &identity, test_now()).expect("persist pending");
        remove_remote_clear_pending_at(&app, &identity, test_now()).expect("clear pending");

        let path = root.join(REMOTE_CLEAR_PENDING_FILE);
        let bytes = fs::read(&path).expect("empty store remains as committed state");
        let store: RemoteClearPendingStore =
            serde_json::from_slice(&bytes).expect("valid empty store");
        assert_eq!(store.schema_version, REMOTE_CLEAR_PENDING_SCHEMA_VERSION);
        assert!(store.entries.is_empty());
        assert!(load_remote_clear_pending_at(&app, test_now())
            .expect("load empty store")
            .is_empty());
        let lock_metadata =
            fs::symlink_metadata(root.join(REMOTE_CLEAR_PENDING_LOCK_FILE)).expect("lock metadata");
        assert!(lock_metadata.is_file());
        assert!(!lock_metadata.file_type().is_symlink());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(lock_metadata.permissions().mode() & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pending_store_rmw_uses_a_non_reentrant_process_mutex() {
        let guard = remote_clear_pending_store_lock();
        let mutex = REMOTE_CLEAR_PENDING_STORE_LOCK
            .get()
            .expect("pending store mutex initialized");
        assert!(mutex.try_lock().is_err());
        drop(guard);
    }

    #[test]
    fn remote_clear_warning_expires_after_25_hours() {
        let (app, root) = test_app();
        let now = test_now();
        let identity = test_identity("expiry");
        QuotaSyncCoordinator::default().record_remote_clear_failure(&app, Some(&identity), now);
        let restarted = QuotaSyncCoordinator::default();
        assert!(has_remote_clear_pending_at(
            &app,
            &restarted,
            now + ChronoDuration::hours(24)
        ));
        assert!(!has_remote_clear_pending_at(
            &app,
            &restarted,
            now + ChronoDuration::hours(25) + ChronoDuration::seconds(1)
        ));
        let store: RemoteClearPendingStore = serde_json::from_slice(
            &fs::read(root.join(REMOTE_CLEAR_PENDING_FILE)).expect("expired empty store"),
        )
        .expect("valid expired empty store");
        assert!(store.entries.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_stop_failure_remains_blocked_after_remote_ttl_expires() {
        let (app, root) = test_app();
        let now = test_now();
        let identity = test_identity("permanent-local-stop");
        set_local_stop_active(&app, true).expect("persist permanent local stop");
        persist_remote_clear_pending_at(&app, &identity, now).expect("persist remote warning");

        let restarted = QuotaSyncCoordinator::default();
        let after_ttl = now + ChronoDuration::hours(26);
        assert!(!has_remote_clear_pending_at(&app, &restarted, after_ttl));
        assert!(has_local_stop_pending(&app));
        assert!(has_any_cleanup_pending_at(&app, &restarted, after_ttl));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn confirmed_remote_clear_does_not_turn_local_stop_failure_into_ttl_only_state() {
        let (app, root) = test_app();
        let now = test_now();
        let identity = test_identity("local-only-stop");
        set_local_stop_active(&app, true).expect("persist permanent local stop");
        persist_remote_clear_pending_at(&app, &identity, now).expect("persist remote intent");
        let coordinator = QuotaSyncCoordinator::default();
        let (claim, ()) = coordinator.begin_tombstone("local-stop-failed", || ());

        coordinator
            .finish_tombstone(&app, claim, Some(&identity), false, now, || {
                ((), false, true)
            })
            .expect("remote clear completion");

        assert!(load_remote_clear_pending_at(&app, now)
            .expect("load cleared remote marker")
            .is_empty());
        assert!(has_local_stop_pending(&app));
        let (claim, blocked) = coordinator.begin_sync();
        assert!(claim.is_none());
        assert!(blocked);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_pending_marker_removal_keeps_permanent_local_stop() {
        let (app, root) = test_app();
        let identity = test_identity("failed-marker-removal");
        fs::write(root.join(REMOTE_CLEAR_PENDING_FILE), b"{corrupt")
            .expect("corrupt pending store");
        let coordinator = QuotaSyncCoordinator::default();
        let (claim, ()) = coordinator.begin_tombstone("remote-clear-confirmed", || ());

        assert_eq!(
            coordinator.finish_tombstone(&app, claim, Some(&identity), false, test_now(), || (
                (),
                false,
                false
            ),),
            Err(QuotaRpcError::InvalidResponse)
        );
        assert!(has_local_stop_pending(&app));
        let (claim, blocked) = coordinator.begin_sync();
        assert!(claim.is_none());
        assert!(blocked);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stop_intents_are_durable_before_binding_or_settings_mutation() {
        let (app, root) = test_app();
        let now = test_now();
        let identity = test_identity("ordered-stop");
        let managed = Arc::new(Mutex::new(AppSettings {
            quota_codex_local_enabled: true,
            quota_snapshot_sync_enabled: true,
            ..AppSettings::default()
        }));
        settings::save_settings_file(&app, &managed.lock().expect("settings")).unwrap();
        save_binding(&app, &test_binding(&identity, 12)).expect("save binding");
        let mut observed = false;

        let preparation =
            prepare_and_apply_stop_with_observer(&app, Some(&managed), None, true, now, || {
                observed = true;
                assert!(load_local_stop_active_unlocked(&app).unwrap());
                assert!(has_remote_clear_pending_at(
                    &app,
                    &QuotaSyncCoordinator::default(),
                    now
                ));
                assert_eq!(
                    load_binding_result(&app).unwrap(),
                    Some(test_binding(&identity, 12))
                );
                assert!(
                    settings::load_settings_result(&app)
                        .unwrap()
                        .quota_snapshot_sync_enabled
                );
            });
        assert!(observed);
        assert!(preparation.intent_error.is_none());
        assert!(!preparation.local_cleanup_pending);
        assert!(load_binding_result(&app).unwrap().is_none());
        assert!(
            !settings::load_settings_result(&app)
                .unwrap()
                .quota_snapshot_sync_enabled
        );
        assert!(!has_local_stop_pending(&app));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_remote_intent_prevents_local_stop_mutation() {
        let (app, root) = test_app();
        let now = test_now();
        let identity = test_identity("intent-failure");
        let managed = Arc::new(Mutex::new(AppSettings {
            quota_codex_local_enabled: true,
            quota_snapshot_sync_enabled: true,
            ..AppSettings::default()
        }));
        settings::save_settings_file(&app, &managed.lock().expect("settings")).unwrap();
        save_binding(&app, &test_binding(&identity, 12)).expect("save binding");
        fs::write(root.join(REMOTE_CLEAR_PENDING_FILE), b"{corrupt")
            .expect("corrupt pending store");
        let mut local_mutation_started = false;

        let preparation =
            prepare_and_apply_stop_with_observer(&app, Some(&managed), None, true, now, || {
                local_mutation_started = true
            });
        assert!(preparation.intent_error.is_some());
        assert!(!local_mutation_started);
        assert_eq!(
            load_binding_result(&app).unwrap(),
            Some(test_binding(&identity, 12))
        );
        assert!(
            settings::load_settings_result(&app)
                .unwrap()
                .quota_snapshot_sync_enabled
        );
        assert!(has_local_stop_pending(&app));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tombstone_captured_binding_preserves_clear_monotonicity_check() {
        let fixture: Value = serde_json::from_str(TRANSPORT).expect("transport fixture");
        let identity = test_identity("captured-binding");
        let previous = test_binding(&identity, 12);
        let selected = select_clear_previous_binding(None, Some(&previous))
            .expect("captured binding selected after local clear");
        assert_eq!(selected.as_ref(), Some(&previous));

        parse_clear_response(fixture["clearResponse"].clone(), selected.as_ref())
            .expect("newer clear response");
        let mut stale = fixture["clearResponse"].clone();
        stale["epoch"] = json!(previous.epoch);
        stale["revision"] = json!(previous.revision);
        assert!(matches!(
            parse_clear_response(stale, selected.as_ref()),
            Err(QuotaRpcError::InvalidResponse)
        ));
    }

    #[test]
    fn unconfirmed_binding_deletion_is_detected() {
        let (app, root) = test_app();
        fs::create_dir_all(root.join(BINDING_FILE)).expect("blocking binding directory");
        assert_eq!(
            clear_binding_checked(&app),
            Err("quota_sync_binding_clear_unconfirmed".to_string())
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_binding_blocks_stop_mutation_and_clear_transport() {
        let (app, root) = test_app();
        let identity = test_identity("corrupt-binding");
        let binding_path = root.join(BINDING_FILE);
        fs::write(&binding_path, b"{corrupt-binding").expect("corrupt binding");
        let mut mutation_started = false;
        let preparation = prepare_and_apply_stop_with_observer(
            &app,
            None,
            Some(identity.clone()),
            true,
            test_now(),
            || mutation_started = true,
        );
        assert!(preparation.intent_error.is_some());
        assert!(!mutation_started);
        assert_eq!(fs::read(&binding_path).unwrap(), b"{corrupt-binding");
        assert!(has_local_stop_pending(&app));

        let context = QuotaRpcContext {
            identity: identity.clone(),
            supabase_key: "sb_publishable_test".to_string(),
            access_token: "test-access-token".to_string(),
            client: reqwest::Client::builder().build().expect("client"),
            session_fence: None,
            test_session_generation: None,
            before_clear_authorization: None,
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        assert!(matches!(
            runtime.block_on(clear_remote_with_context(
                &app,
                context,
                Some(&identity),
                None
            )),
            Err(QuotaRpcError::InvalidResponse)
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn provider_revocation_preserves_cloud_binding_without_delete_intent() {
        let (app, root) = test_app();
        let identity = test_identity("provider-revoke");
        save_binding(&app, &test_binding(&identity, 12)).expect("save binding");
        let previous = AppSettings {
            quota_codex_local_enabled: true,
            quota_snapshot_sync_enabled: true,
            ..AppSettings::default()
        };
        let current = AppSettings {
            quota_codex_local_enabled: false,
            quota_snapshot_sync_enabled: true,
            ..AppSettings::default()
        };

        prepare_provider_authorization_change(&app, &previous, &current)
            .expect("provider revocation is local-only");
        let restarted = QuotaSyncCoordinator::default();
        assert!(!has_remote_clear_pending_at(&app, &restarted, Utc::now()));
        assert_eq!(load_binding(&app), Some(test_binding(&identity, 12)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_remote_clear_marker_does_not_block_v2_status() {
        let (app, root) = test_app();
        let identity = test_identity("restart-worker");
        let settings = AppSettings {
            quota_codex_local_enabled: true,
            quota_snapshot_sync_enabled: true,
            ..AppSettings::default()
        };
        settings::save_settings_file(&app, &settings).expect("save enabled settings");
        save_binding(&app, &test_binding(&identity, 12)).expect("save binding");
        persist_remote_clear_pending_at(&app, &identity, Utc::now())
            .expect("persist cleanup intent");

        assert!(!has_local_stop_pending(&app));
        assert!(!QuotaSyncCoordinator::default().sync_is_blocked());
        assert_eq!(load_binding(&app), Some(test_binding(&identity, 12)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_settings_write_updates_managed_state_fail_closed() {
        let (app, root) = test_app();
        fs::remove_dir_all(&root).expect("replace app data directory with a file");
        fs::write(&root, b"not-a-directory").expect("block app data directory");
        let managed = Arc::new(Mutex::new(AppSettings {
            quota_snapshot_sync_enabled: true,
            ..AppSettings::default()
        }));

        assert!(update_sync_setting(&app, Some(&managed), false).is_err());
        assert!(
            !managed
                .lock()
                .expect("managed settings")
                .quota_snapshot_sync_enabled
        );
        let _ = fs::remove_file(root);
    }

    #[test]
    fn enable_intent_is_durable_before_publishable_local_state() {
        let (app, root) = test_app();
        let identity = test_identity("enable-intent-order");
        let binding = test_binding(&identity, 1);
        let settings_state = Arc::new(Mutex::new(AppSettings {
            quota_codex_local_enabled: true,
            ..AppSettings::default()
        }));
        settings::save_settings_file(&app, &settings_state.lock().expect("settings")).unwrap();
        let mut observed = false;

        commit_enable_local_state_with_observer(&app, &settings_state, &binding, || {
            observed = true;
            assert!(load_local_stop_active_unlocked(&app).unwrap());
            assert!(load_binding_result(&app).unwrap().is_none());
            assert!(!settings::load_settings(&app).quota_snapshot_sync_enabled);
        })
        .expect("commit enable state");

        assert!(observed);
        assert!(!has_local_stop_pending(&app));
        assert_eq!(load_binding_result(&app).unwrap(), Some(binding));
        assert!(settings::load_settings(&app).quota_snapshot_sync_enabled);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_enable_intent_writes_no_publishable_state() {
        let (app, root) = test_app();
        let identity = test_identity("enable-intent-failure");
        let binding = test_binding(&identity, 1);
        let settings_state = Arc::new(Mutex::new(AppSettings {
            quota_codex_local_enabled: true,
            ..AppSettings::default()
        }));
        settings::save_settings_file(&app, &settings_state.lock().expect("settings")).unwrap();
        fs::create_dir(root.join(LOCAL_STOP_FILE)).expect("block local-stop intent file");

        assert_eq!(
            commit_enable_local_state(&app, &settings_state, &binding),
            Err(QuotaRpcError::InvalidResponse)
        );
        assert!(load_binding_result(&app).unwrap().is_none());
        assert!(!settings::load_settings(&app).quota_snapshot_sync_enabled);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_reauthorization_rollback_blocks_runtime_and_restart() {
        let (app, root) = test_app();
        let identity = test_identity("failed-rollback");
        let settings = AppSettings {
            quota_codex_local_enabled: true,
            quota_snapshot_sync_enabled: true,
            ..AppSettings::default()
        };
        settings::save_settings_file(&app, &settings).expect("persist partial enabled settings");
        save_binding(&app, &test_binding(&identity, 4)).expect("persist partial binding");
        assert!(!has_local_stop_pending(&app));

        let coordinator = QuotaSyncCoordinator::default();
        let claim = coordinator.begin().expect("reauthorization claim");
        assert_eq!(
            coordinator.commit_reauthorized(&app, claim, &identity, test_now(), || {
                Err::<(), _>(ReauthorizationFailure {
                    error: QuotaRpcError::InvalidResponse,
                    rollback_failed: true,
                })
            }),
            Err(QuotaRpcError::InvalidResponse)
        );

        assert!(coordinator.sync_is_blocked());
        assert!(has_local_stop_pending(&app));
        assert!(settings::load_settings(&app).quota_snapshot_sync_enabled);
        assert!(load_binding_result(&app).unwrap().is_some());

        let restarted = QuotaSyncCoordinator::default();
        assert!(has_any_cleanup_pending_at(&app, &restarted, test_now()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_precommit_enable_failure_preserves_newer_enabled_state() {
        let (app, root) = test_app();
        let coordinator = QuotaSyncCoordinator::default();
        let old_identity = test_identity("old-enable");
        let new_identity = test_identity("new-enable");
        let settings_state = Arc::new(Mutex::new(AppSettings {
            quota_codex_local_enabled: true,
            ..AppSettings::default()
        }));
        settings::save_settings_file(&app, &settings_state.lock().expect("settings")).unwrap();
        commit_enable_local_state(&app, &settings_state, &test_binding(&old_identity, 1))
            .expect("initial enabled state");

        let old_claim = coordinator.begin().expect("E1 awaiting remote response");
        let (disable_claim, preparation) = coordinator
            .begin_tombstone("quota_sync_disabled", || {
                prepare_and_apply_stop(&app, Some(&settings_state), None, false, test_now())
            });
        assert!(preparation.intent_error.is_none());
        assert!(!preparation.local_cleanup_pending);
        coordinator
            .finish_device_stop(disable_claim, false, "quota_sync_disabled")
            .expect("disable releases E1");

        let new_claim = coordinator.begin().expect("E2 enable claim");
        let new_binding = test_binding(&new_identity, 2);
        coordinator
            .commit_reauthorized(&app, new_claim, &new_identity, test_now(), || {
                commit_enable_local_state(&app, &settings_state, &new_binding)
                    .map_err(|error| rollback_enable_failure(&app, &settings_state, error))
            })
            .expect("E2 commits its real local state");
        assert_eq!(
            load_binding_result(&app).unwrap(),
            Some(new_binding.clone())
        );
        assert!(settings::load_settings(&app).quota_snapshot_sync_enabled);
        assert!(!has_local_stop_pending(&app));

        let files = [BINDING_FILE, "app_settings.json", LOCAL_STOP_FILE];
        let before: Vec<_> = files
            .iter()
            .map(|file| fs::read(root.join(file)).expect("E2 persisted file"))
            .collect();
        let managed_before =
            serde_json::to_value(&*settings_state.lock().expect("settings")).unwrap();
        let (sync_claim, blocked) = coordinator.begin_sync();
        assert!(!blocked);
        let sync_claim = sync_claim.expect("new enabled state can sync");
        let runtime_before = coordinator.runtime_snapshot();

        assert_eq!(
            coordinator.finish_failed_reauthorization(
                &app,
                &settings_state,
                old_claim,
                QuotaRpcError::Transport,
            ),
            Err(QuotaRpcError::Superseded)
        );

        for (file, bytes) in files.iter().zip(before) {
            assert_eq!(fs::read(root.join(file)).unwrap(), bytes, "changed {file}");
        }
        assert_eq!(
            serde_json::to_value(&*settings_state.lock().expect("settings")).unwrap(),
            managed_before
        );
        assert_eq!(load_binding_result(&app).unwrap(), Some(new_binding));
        assert!(settings::load_settings(&app).quota_snapshot_sync_enabled);
        assert!(!has_local_stop_pending(&app));
        assert!(!coordinator.sync_is_blocked());
        assert_eq!(coordinator.runtime_snapshot(), runtime_before);
        assert!(coordinator.is_current(sync_claim));
        coordinator.finish(sync_claim, None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn current_precommit_enable_failure_stops_local_state() {
        let (app, root) = test_app();
        let coordinator = QuotaSyncCoordinator::default();
        let identity = test_identity("current-enable-failure");
        let settings_state = Arc::new(Mutex::new(AppSettings {
            quota_codex_local_enabled: true,
            ..AppSettings::default()
        }));
        settings::save_settings_file(&app, &settings_state.lock().expect("settings")).unwrap();
        commit_enable_local_state(&app, &settings_state, &test_binding(&identity, 1))
            .expect("initial enabled state");
        let claim = coordinator.begin().expect("current enable claim");

        assert_eq!(
            coordinator.finish_failed_reauthorization(
                &app,
                &settings_state,
                claim,
                QuotaRpcError::AuthRequired,
            ),
            Err(QuotaRpcError::AuthRequired)
        );

        assert!(load_binding_result(&app).unwrap().is_none());
        assert!(!settings::load_settings(&app).quota_snapshot_sync_enabled);
        assert!(
            !settings_state
                .lock()
                .expect("settings")
                .quota_snapshot_sync_enabled
        );
        assert!(!has_local_stop_pending(&app));
        assert_eq!(
            coordinator.runtime_snapshot(),
            (
                false,
                Some(QuotaRpcError::AuthRequired.reason_code().to_string())
            )
        );
        assert!(coordinator.background_sync_is_suppressed());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn precommit_enable_failure_propagates_failed_rollback_block() {
        let (app, root) = test_app();
        let coordinator = QuotaSyncCoordinator::default();
        let settings_state = Arc::new(Mutex::new(AppSettings {
            quota_codex_local_enabled: true,
            quota_snapshot_sync_enabled: true,
            ..AppSettings::default()
        }));
        settings::save_settings_file(&app, &settings_state.lock().expect("settings")).unwrap();
        fs::create_dir(root.join(BINDING_FILE)).expect("prevent binding cleanup");
        let claim = coordinator.begin().expect("enable claim");
        assert_eq!(
            coordinator.finish_failed_reauthorization(
                &app,
                &settings_state,
                claim,
                QuotaRpcError::Transport,
            ),
            Err(QuotaRpcError::Transport)
        );
        assert!(coordinator.sync_is_blocked());
        assert!(has_local_stop_pending(&app));
        assert!(!settings::load_settings(&app).quota_snapshot_sync_enabled);
        assert!(
            !settings_state
                .lock()
                .expect("settings")
                .quota_snapshot_sync_enabled
        );
        assert_eq!(
            coordinator.runtime_snapshot(),
            (false, Some(REMOTE_CLEAR_INCOMPLETE.to_string()))
        );
        assert!(has_any_cleanup_pending_at(
            &app,
            &QuotaSyncCoordinator::default(),
            test_now()
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn remote_clear_warning_is_sticky_across_invalidate_and_failed_enable() {
        let (app, root) = test_app();
        let now = test_now();
        let coordinator = QuotaSyncCoordinator::default();
        let identity = test_identity("sticky");
        coordinator.record_remote_clear_failure(&app, Some(&identity), now);
        coordinator.invalidate(Some("quota_sync_auth_required"));
        let failed_enable = coordinator.begin().expect("failed enable claim");
        coordinator.finish(failed_enable, Some("quota_sync_transport_error"));
        assert!(has_remote_clear_pending_at(&app, &coordinator, now));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn auth_failure_pauses_only_background_retry_until_explicit_sync_attempt() {
        let coordinator = QuotaSyncCoordinator::default();
        assert!(!coordinator.background_sync_is_suppressed());

        let (claim, blocked) = coordinator.begin_sync();
        assert!(!blocked);
        coordinator.finish(
            claim.expect("background attempt claim"),
            Some("quota_sync_auth_required"),
        );
        assert!(coordinator.background_sync_is_suppressed());

        // An explicit settings retry owns the next attempt and clears the
        // background-only marker before it can read the secure session.
        let (claim, blocked) = coordinator.begin_sync();
        assert!(!blocked);
        assert!(claim.is_some());
        assert!(!coordinator.background_sync_is_suppressed());
        coordinator.finish(claim.expect("explicit retry claim"), None);

        let (claim, blocked) = coordinator.begin_sync();
        assert!(!blocked);
        coordinator.finish(
            claim.expect("transport retry claim"),
            Some("quota_sync_transport_error"),
        );
        assert!(!coordinator.background_sync_is_suppressed());
    }

    #[test]
    fn tombstones_prevent_late_enable_and_replace_commits() {
        let (app, root) = test_app();
        let coordinator = QuotaSyncCoordinator::default();
        let identity = test_identity("stale");
        let settings_state = Arc::new(Mutex::new(AppSettings {
            quota_codex_local_enabled: true,
            ..AppSettings::default()
        }));
        settings::save_settings_file(&app, &settings_state.lock().expect("settings")).unwrap();

        let enable_claim = coordinator.begin().expect("enable claim");
        let (sign_out_claim, ()) = coordinator.begin_tombstone("signed_out", || {
            clear_binding(&app);
            update_sync_setting(&app, Some(&settings_state), false).unwrap();
        });
        assert_eq!(
            coordinator.commit_reauthorized(&app, enable_claim, &identity, test_now(), || {
                save_binding(&app, &test_binding(&identity, 1))
                    .map_err(|_| QuotaRpcError::InvalidResponse)?;
                enable_sync_setting_if_authorized(&app, &settings_state)?;
                Ok(())
            }),
            Err(QuotaRpcError::Superseded)
        );
        assert!(load_binding(&app).is_none());
        assert!(!settings::load_settings(&app).quota_snapshot_sync_enabled);
        coordinator
            .finish_tombstone(&app, sign_out_claim, None, false, test_now(), || {
                ((), false, false)
            })
            .expect("finish sign-out tombstone");

        let active_claim = coordinator.begin().expect("fresh enable claim");
        coordinator
            .commit_reauthorized(&app, active_claim, &identity, test_now(), || {
                save_binding(&app, &test_binding(&identity, 1))
                    .map_err(|_| QuotaRpcError::InvalidResponse)?;
                enable_sync_setting_if_authorized(&app, &settings_state)?;
                Ok(())
            })
            .expect("fresh enable commit");

        let (replace_claim, blocked) = coordinator.begin_sync();
        assert!(!blocked);
        let replace_claim = replace_claim.expect("replace claim");
        let (disable_claim, ()) = coordinator.begin_tombstone("disabled", || {
            clear_binding(&app);
            update_sync_setting(&app, Some(&settings_state), false).unwrap();
        });
        assert_eq!(
            coordinator.commit_current(replace_claim, || {
                save_binding(&app, &test_binding(&identity, 2))
                    .map_err(|_| QuotaRpcError::InvalidResponse)?;
                Ok(())
            }),
            Err(QuotaRpcError::Superseded)
        );
        assert!(load_binding(&app).is_none());
        assert!(!settings::load_settings(&app).quota_snapshot_sync_enabled);
        coordinator
            .finish_tombstone(&app, disable_claim, None, true, test_now(), || {
                ((), false, false)
            })
            .expect("finish disable tombstone");
        let (blocked_claim, blocked) = coordinator.begin_sync();
        assert!(blocked_claim.is_none());
        assert!(blocked);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn response_accumulator_rejects_content_past_each_hard_cap() {
        assert!(!content_length_exceeds_cap(
            Some(MAX_RPC_RESPONSE_BYTES as u64),
            MAX_RPC_RESPONSE_BYTES
        ));
        assert!(content_length_exceeds_cap(
            Some(MAX_RPC_RESPONSE_BYTES as u64 + 1),
            MAX_RPC_RESPONSE_BYTES
        ));
        assert!(!content_length_exceeds_cap(None, MAX_RPC_RESPONSE_BYTES));
        let mut success = Vec::new();
        append_bounded(
            &mut success,
            &vec![b'a'; MAX_RPC_RESPONSE_BYTES],
            MAX_RPC_RESPONSE_BYTES,
        )
        .expect("exact success cap");
        assert_eq!(success.len(), MAX_RPC_RESPONSE_BYTES);
        assert_eq!(
            append_bounded(&mut success, b"x", MAX_RPC_RESPONSE_BYTES),
            Err(BoundedReadError::TooLarge)
        );

        let mut error = Vec::new();
        append_bounded(
            &mut error,
            &vec![b'a'; MAX_ERROR_RESPONSE_BYTES - 1],
            MAX_ERROR_RESPONSE_BYTES,
        )
        .expect("first error chunk");
        append_bounded(&mut error, b"x", MAX_ERROR_RESPONSE_BYTES).expect("exact error cap");
        assert_eq!(
            append_bounded(&mut error, b"x", MAX_ERROR_RESPONSE_BYTES),
            Err(BoundedReadError::TooLarge)
        );
    }
}
