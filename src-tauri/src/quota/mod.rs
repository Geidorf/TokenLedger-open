//! Quota provider envelopes and the opt-in Codex local observation adapter.
//!
//! The Codex adapter is intentionally narrow: it only reads bounded tails of
//! `sessions/**/*.jsonl`, byte-filters for `rate_limits` before deserializing,
//! and retains only the normalized quota fields. It never returns or logs a
//! session path, raw JSON, prompts, responses, or account credentials.

use chrono::{DateTime, SecondsFormat, Utc};
use portable_pty::{native_pty_system, CommandBuilder as PtyCommandBuilder, PtySize};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::cmp::{min, Ordering};
use std::collections::{BTreeMap, BinaryHeap, HashMap};
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod antigravity;
use antigravity::{
    antigravity_authorization_required, antigravity_envelope, antigravity_error_code,
    antigravity_failure_user_message, clear_antigravity_probe_cache,
};

pub(crate) const CODEX_PROVIDER_ID: &str = "openai-codex-local";
pub(crate) const CLAUDE_PROVIDER_ID: &str = "anthropic-claude-consumer";
pub(crate) const ANTIGRAVITY_PROVIDER_ID: &str = "google-antigravity-consumer";
const STALE_AFTER_SECONDS: i64 = 15 * 60;
const MAX_FUTURE_CLOCK_SKEW_SECONDS: i64 = 5 * 60;
const RECENT_RESULT_REUSE: Duration = Duration::from_secs(5);
const LAST_GOOD_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const APP_SERVER_TIMEOUT: Duration = Duration::from_secs(3);
const APP_SERVER_READER_JOIN_TIMEOUT: Duration = Duration::from_millis(250);
const APP_SERVER_TERMINATION_TIMEOUT: Duration = Duration::from_millis(250);
const APP_SERVER_MAX_LINE_BYTES: usize = 512 * 1024;
const APP_SERVER_MAX_MESSAGES: usize = 64;
const APP_SERVER_MAX_BUCKETS: usize = 32;
const APP_SERVER_MAX_WINDOWS: usize = 32;
const CLAUDE_STATUSLINE_FILE: &str = "claude_statusline_quota.json";
const CLAUDE_NATIVE_CLI_TIMEOUT: Duration = Duration::from_secs(24);
const CLAUDE_NATIVE_TOTAL_TIMEOUT: Duration = Duration::from_secs(44);
const CLAUDE_NATIVE_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);
const CLAUDE_NATIVE_STARTUP_GRACE: Duration = Duration::from_secs(2);
const CLAUDE_NATIVE_CLI_SETTLE: Duration = Duration::from_millis(900);
const CLAUDE_NATIVE_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const CLAUDE_NATIVE_MAX_WINDOWS: usize = 16;
const CLAUDE_PROBE_SETTINGS_MAX_BYTES: usize = 16 * 1024;
const CLAUDE_FALLBACK_CLI_TOTAL_TIMEOUT: Duration = Duration::from_secs(24);
const CLAUDE_FALLBACK_CLI_TIMEOUT: Duration = Duration::from_secs(20);
const CLAUDE_FALLBACK_CLI_READER_JOIN_TIMEOUT: Duration = Duration::from_millis(250);
const CLAUDE_FALLBACK_CLI_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const CLAUDE_FALLBACK_CLI_MAX_WINDOWS: usize = 16;
const CODEX_LAST_GOOD_FILE: &str = "quota_lkg_codex.json";
const CLAUDE_LAST_GOOD_FILE: &str = "quota_lkg_claude.json";
const ANTIGRAVITY_LAST_GOOD_FILE: &str = "quota_lkg_antigravity.json";
const MAX_CLAUDE_INPUT_BYTES: usize = 32 * 1024;
const MAX_CLAUDE_SNAPSHOT_BYTES: usize = 16 * 1024;
const MAX_PERSISTED_ENVELOPE_BYTES: usize = 64 * 1024;
const CODEX_MAX_WINDOW_MINUTES: u64 = 8 * 24 * 60;
const CODEX_MAX_RESET_SECONDS: i64 = 8 * 24 * 60 * 60;
const CLAUDE_FIVE_HOUR_MAX_RESET_SECONDS: i64 = 8 * 60 * 60;
const CLAUDE_SEVEN_DAY_MAX_RESET_SECONDS: i64 = 8 * 24 * 60 * 60;
static ATOMIC_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);
static QUOTA_PERSISTENCE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CLAUDE_NATIVE_PROBE_STATE: OnceLock<Mutex<ClaudeNativeProbeState>> = OnceLock::new();

#[derive(Clone, Copy)]
struct ScanLimits {
    max_session_files: usize,
    max_directory_entries: usize,
    max_directory_depth: usize,
    max_file_tail_bytes: usize,
    max_line_bytes: usize,
    max_total_read_bytes: usize,
    max_filtered_lines: usize,
    max_scan_duration: Duration,
}

const DEFAULT_SCAN_LIMITS: ScanLimits = ScanLimits {
    max_session_files: 64,
    max_directory_entries: 4_096,
    max_directory_depth: 8,
    max_file_tail_bytes: 256 * 1024,
    // The total bound covers every retained file tail. Directory, time, line,
    // and byte limits still fail closed; max_session_files is a bounded newest
    // file selection after complete directory enumeration.
    max_total_read_bytes: 64 * 256 * 1024,
    max_line_bytes: 64 * 1024,
    max_filtered_lines: 512,
    max_scan_duration: Duration::from_millis(750),
};

pub mod types;
pub use types::*;
pub mod alerts;
pub mod balance;
pub mod claude_setup;
pub mod custom;
pub mod detect;

/// Return all first-release consumer quota providers.
///
/// The authorization gate is read only from the persisted Rust settings
/// state. The IPC caller cannot bypass it with an invoke argument.
#[tauri::command]
pub async fn get_quota_providers(
    app_state: tauri::State<'_, Arc<crate::app_paths::AppContext>>,
) -> Result<Vec<QuotaProviderEnvelope>, String> {
    Ok(get_quota_providers_impl(app_state.inner().as_ref()).await)
}

/// Retry quota reads after an explicit user action. Automatic refreshes use
/// the non-retrying command so a locked system credential store cannot keep
/// reopening authorization prompts.
#[tauri::command]
pub async fn retry_quota_providers(
    app_state: tauri::State<'_, Arc<crate::app_paths::AppContext>>,
) -> Result<Vec<QuotaProviderEnvelope>, String> {
    Ok(get_quota_providers_impl_with_retry(app_state.inner().as_ref()).await)
}

/// Return only local quota observations without resolving the cloud session.
///
/// The dashboard uses this projection during cold start so a local-only view
/// never needs to unlock the cloud Keychain entry. The settings/cloud flow
/// explicitly calls `get_quota_providers` when remote cached snapshots are
/// useful and the user has entered that surface.
#[tauri::command]
pub async fn get_local_quota_providers(
    app_state: tauri::State<'_, Arc<crate::app_paths::AppContext>>,
) -> Result<Vec<QuotaProviderEnvelope>, String> {
    Ok(get_local_quota_providers_impl(app_state.inner().as_ref()).await)
}

#[tauri::command]
pub async fn retry_local_quota_providers(
    app_state: tauri::State<'_, Arc<crate::app_paths::AppContext>>,
) -> Result<Vec<QuotaProviderEnvelope>, String> {
    Ok(get_local_quota_providers_impl_with_retry(app_state.inner().as_ref()).await)
}

pub(crate) async fn get_quota_providers_impl(
    app: &crate::app_paths::AppContext,
) -> Vec<QuotaProviderEnvelope> {
    get_quota_providers_impl_with_retry_flag(app, false).await
}

async fn get_quota_providers_impl_with_retry(
    app: &crate::app_paths::AppContext,
) -> Vec<QuotaProviderEnvelope> {
    get_quota_providers_impl_with_retry_flag(app, true).await
}

async fn get_quota_providers_impl_with_retry_flag(
    app: &crate::app_paths::AppContext,
    retry_keyring_read: bool,
) -> Vec<QuotaProviderEnvelope> {
    let local = get_local_quota_providers_impl_with_retry_flag(app, retry_keyring_read).await;
    #[cfg(not(test))]
    {
        let merged = crate::quota_sync::merge_remote_providers_for_display(app, local);
        alerts::check_quota_alerts(app, &merged);
        merged
    }
    #[cfg(test)]
    {
        local
    }
}

/// Produce local observations from persisted authorization only. The sync
/// producer calls this path so a cloud snapshot can never be echoed back as a
/// fresh device observation.
pub(crate) async fn get_local_quota_providers_impl(
    app: &crate::app_paths::AppContext,
) -> Vec<QuotaProviderEnvelope> {
    get_local_quota_providers_impl_with_retry_flag(app, false).await
}

pub(crate) async fn get_local_quota_providers_impl_with_retry(
    app: &crate::app_paths::AppContext,
) -> Vec<QuotaProviderEnvelope> {
    get_local_quota_providers_impl_with_retry_flag(app, true).await
}

pub(crate) async fn get_local_quota_providers_impl_with_retry_flag(
    app: &crate::app_paths::AppContext,
    retry_keyring_read: bool,
) -> Vec<QuotaProviderEnvelope> {
    // Disk settings are authoritative across concurrently running app
    // processes. A stale process-local State must never recreate snapshots
    // after another process has revoked authorization.
    let settings = crate::settings::load_settings(app);
    let (
        codex_enabled,
        claude_statusline_enabled,
        claude_experimental_enabled,
        antigravity_local_enabled,
        antigravity_fallback_cli_enabled,
        custom_endpoints,
    ) = (
        settings.quota_codex_local_enabled,
        settings.quota_claude_statusline_enabled,
        settings.quota_claude_codexbar_enabled,
        settings.quota_antigravity_local_enabled,
        settings.quota_antigravity_codexbar_enabled,
        settings.quota_custom_endpoints,
    );
    let mut providers = provider_envelopes(
        codex_enabled,
        claude_statusline_enabled,
        claude_experimental_enabled,
        antigravity_local_enabled,
        antigravity_fallback_cli_enabled,
        app.app_data_dir().to_path_buf(),
    )
    .await;
    custom::remove_disabled_last_good(app.app_data_dir(), &custom_endpoints);
    providers
        .extend(custom::collect_custom_providers(app, &custom_endpoints, retry_keyring_read).await);
    providers.extend(balance::collect_balance_providers(app, retry_keyring_read).await);
    let current = crate::settings::load_settings(app);
    let (
        current_codex_enabled,
        current_claude_statusline_enabled,
        current_claude_experimental_enabled,
        current_antigravity_local_enabled,
        current_antigravity_fallback_cli_enabled,
    ) = (
        current.quota_codex_local_enabled,
        current.quota_claude_statusline_enabled,
        current.quota_claude_codexbar_enabled,
        current.quota_antigravity_local_enabled,
        current.quota_antigravity_codexbar_enabled,
    );
    enforce_current_authorization(
        app.app_data_dir(),
        current_codex_enabled,
        current_claude_statusline_enabled,
        current_claude_experimental_enabled,
        current_antigravity_local_enabled,
        current_antigravity_fallback_cli_enabled,
        &mut providers,
    );
    providers.retain(|provider| {
        custom::config_id_from_provider_id(&provider.provider_id).is_none()
            || custom::is_enabled_provider(&provider.provider_id, &current.quota_custom_endpoints)
    });
    if providers
        .iter()
        .any(|provider| balance::is_balance_provider_id(&provider.provider_id))
    {
        let enabled_balances = balance::enabled_provider_ids(app.app_data_dir());
        providers.retain(|provider| {
            !balance::is_balance_provider_id(&provider.provider_id)
                || enabled_balances.contains(&provider.provider_id)
        });
    }
    alerts::check_quota_alerts(app, &providers);
    // 托盘数字的最紧额度缓存；`tests/quota_parser.rs` 单独编译本模块，那里没有托盘。
    #[cfg(not(test))]
    crate::tray_panel::record_local_quota(&providers);
    providers
}

async fn provider_envelopes(
    codex_enabled: bool,
    claude_statusline_enabled: bool,
    claude_experimental_enabled: bool,
    antigravity_local_enabled: bool,
    antigravity_fallback_cli_enabled: bool,
    app_data_dir: PathBuf,
) -> Vec<QuotaProviderEnvelope> {
    clear_disabled_provider_data(
        &app_data_dir,
        codex_enabled,
        claude_statusline_enabled,
        claude_experimental_enabled,
        antigravity_local_enabled,
        antigravity_fallback_cli_enabled,
    );
    let codex = if !codex_enabled {
        codex_authorization_required()
    } else if let Some(root) = configured_codex_home() {
        let fallback_root = root.clone();
        let app_data_for_worker = app_data_dir.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            let envelope = quota_coordinator().refresh_root(root);
            finalize_with_persisted_last_good(
                &app_data_for_worker,
                CODEX_LAST_GOOD_FILE,
                CODEX_PROVIDER_ID,
                envelope,
                Utc::now(),
            )
        })
        .await
        {
            Ok(envelope) => envelope,
            Err(_) => {
                let now = Utc::now();
                let envelope = quota_coordinator().failure_for_root(
                    &fallback_root,
                    ScanFailure::ProviderWorkerFailed,
                    now,
                );
                finalize_with_persisted_last_good(
                    &app_data_dir,
                    CODEX_LAST_GOOD_FILE,
                    CODEX_PROVIDER_ID,
                    envelope,
                    now,
                )
            }
        }
    } else {
        codex_error("source_not_found")
    };

    let claude = if !claude_statusline_enabled && !claude_experimental_enabled {
        claude_authorization_required()
    } else {
        let fetched_at = Utc::now();
        let envelope = if claude_experimental_enabled {
            let app_data_for_worker = app_data_dir.clone();
            let enhanced = match tauri::async_runtime::spawn_blocking(move || {
                claude_native_envelope(&app_data_for_worker, fetched_at)
            })
            .await
            {
                Ok(envelope) => envelope,
                Err(_) => claude_native_error(ClaudeNativeFailure::UsageUnavailable),
            };
            let mut sources = vec![enhanced.clone()];
            if claude_statusline_enabled {
                sources.push(claude_envelope_from_app_data(&app_data_dir, fetched_at));
            }
            merge_claude_provider_envelopes(&sources).unwrap_or(enhanced)
        } else {
            claude_envelope_from_app_data(&app_data_dir, fetched_at)
        };
        finalize_with_persisted_last_good(
            &app_data_dir,
            CLAUDE_LAST_GOOD_FILE,
            CLAUDE_PROVIDER_ID,
            envelope,
            fetched_at,
        )
    };

    let antigravity = if !antigravity_local_enabled {
        antigravity_authorization_required()
    } else {
        let fetched_at = Utc::now();
        let envelope =
            antigravity_envelope(&app_data_dir, fetched_at, antigravity_fallback_cli_enabled).await;
        finalize_with_persisted_last_good(
            &app_data_dir,
            ANTIGRAVITY_LAST_GOOD_FILE,
            ANTIGRAVITY_PROVIDER_ID,
            envelope,
            fetched_at,
        )
    };

    vec![codex, claude, antigravity]
}

pub(crate) fn clear_codex_local_cache() {
    quota_coordinator().clear();
}

fn persistence_guard() -> MutexGuard<'static, ()> {
    match QUOTA_PERSISTENCE_LOCK.get_or_init(|| Mutex::new(())).lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub(crate) fn clear_disabled_provider_data(
    app_data_dir: &Path,
    codex_enabled: bool,
    claude_statusline_enabled: bool,
    claude_experimental_enabled: bool,
    antigravity_local_enabled: bool,
    antigravity_fallback_cli_enabled: bool,
) {
    let _persistence = persistence_guard();
    if !codex_enabled {
        clear_codex_local_cache();
        remove_persisted_snapshot(app_data_dir, CODEX_LAST_GOOD_FILE);
    }
    if !claude_statusline_enabled {
        remove_persisted_snapshot(app_data_dir, CLAUDE_STATUSLINE_FILE);
    }
    if !claude_experimental_enabled {
        clear_claude_native_probe_cache();
    }
    if !claude_statusline_enabled && !claude_experimental_enabled {
        remove_persisted_snapshot(app_data_dir, CLAUDE_LAST_GOOD_FILE);
    }
    if !antigravity_local_enabled {
        clear_antigravity_probe_cache();
        remove_persisted_snapshot(app_data_dir, ANTIGRAVITY_LAST_GOOD_FILE);
    } else if !antigravity_fallback_cli_enabled {
        // The built-in probe remains enabled; only cached bridge-derived
        // results are discarded by starting the next refresh from scratch.
        clear_antigravity_probe_cache();
    }
}

fn enforce_current_authorization(
    app_data_dir: &Path,
    codex_enabled: bool,
    claude_statusline_enabled: bool,
    claude_experimental_enabled: bool,
    antigravity_local_enabled: bool,
    antigravity_fallback_cli_enabled: bool,
    providers: &mut [QuotaProviderEnvelope],
) {
    clear_disabled_provider_data(
        app_data_dir,
        codex_enabled,
        claude_statusline_enabled,
        claude_experimental_enabled,
        antigravity_local_enabled,
        antigravity_fallback_cli_enabled,
    );
    if !codex_enabled {
        if let Some(codex) = providers
            .iter_mut()
            .find(|provider| provider.provider_id == CODEX_PROVIDER_ID)
        {
            *codex = codex_authorization_required();
        }
    }
    if !claude_statusline_enabled && !claude_experimental_enabled {
        if let Some(claude) = providers
            .iter_mut()
            .find(|provider| provider.provider_id == CLAUDE_PROVIDER_ID)
        {
            *claude = claude_authorization_required();
        }
    }
    if !antigravity_local_enabled {
        if let Some(antigravity) = providers
            .iter_mut()
            .find(|provider| provider.provider_id == ANTIGRAVITY_PROVIDER_ID)
        {
            *antigravity = antigravity_authorization_required();
        }
    }
}

fn configured_codex_home() -> Option<PathBuf> {
    env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CodexLaunchPlan {
    program: PathBuf,
    prefix_args: Vec<OsString>,
    child_path: OsString,
}

fn resolve_codex_launch_plans() -> Vec<CodexLaunchPlan> {
    let explicit = env::var_os("TOKENLEDGER_CODEX_BIN");
    let search_path = env::var_os("PATH");
    let fallbacks = codex_executable_fallbacks();
    resolve_codex_launch_plans_from(explicit.as_deref(), search_path.as_deref(), &fallbacks)
}

// Only `#[cfg(unix)]` tests call this (Unix shell-script fake executables);
// on other test platforms it has no caller at all, which `--all-targets`
// reports as dead code (T10.203). Scoping the cfg to match its real callers
// removes the false positive without touching product code or the lint.
#[cfg(all(test, unix))]
fn resolve_codex_launch_plan_from(
    explicit: Option<&OsStr>,
    search_path: Option<&OsStr>,
    fallbacks: &[PathBuf],
) -> Option<CodexLaunchPlan> {
    resolve_codex_launch_plans_from(explicit, search_path, fallbacks)
        .into_iter()
        .next()
}

fn resolve_codex_launch_plans_from(
    explicit: Option<&OsStr>,
    search_path: Option<&OsStr>,
    fallbacks: &[PathBuf],
) -> Vec<CodexLaunchPlan> {
    if let Some(explicit) = explicit {
        let candidate = Path::new(explicit);
        if candidate.is_absolute() {
            if let Some(plan) = codex_launch_plan_for_candidate(candidate, search_path) {
                // An explicit executable is an authorization boundary, not a
                // hint. Never launch a different local installation when it
                // resolves successfully but fails at runtime.
                return vec![plan];
            }
        }
    }

    let mut plans = Vec::new();
    if let Some(search_path) = search_path {
        for directory in env::split_paths(search_path).filter(|directory| directory.is_absolute()) {
            for name in codex_executable_names() {
                if let Some(plan) =
                    codex_launch_plan_for_candidate(&directory.join(name), Some(search_path))
                {
                    push_unique_codex_launch_plan(&mut plans, plan);
                }
            }
            #[cfg(windows)]
            if let Some(plan) = codex_launch_plan_from_npm_prefix(&directory, Some(search_path)) {
                push_unique_codex_launch_plan(&mut plans, plan);
            }
        }
    }

    for candidate in fallbacks {
        if let Some(plan) = codex_launch_plan_for_candidate(candidate, search_path) {
            push_unique_codex_launch_plan(&mut plans, plan);
        }
    }
    plans
}

fn push_unique_codex_launch_plan(plans: &mut Vec<CodexLaunchPlan>, plan: CodexLaunchPlan) {
    if !plans.iter().any(|known| known == &plan) {
        plans.push(plan);
    }
}

fn codex_launch_plan_for_candidate(
    candidate: &Path,
    search_path: Option<&OsStr>,
) -> Option<CodexLaunchPlan> {
    #[cfg(windows)]
    if candidate
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
    {
        return codex_launch_plan_from_npm_prefix(candidate.parent()?, search_path);
    }
    let program = canonical_executable(candidate)?;
    if looks_like_node_script(&program) {
        if let Some(native) = resolve_packaged_codex_native(&program) {
            return direct_codex_launch_plan(native, candidate);
        }
        let node = resolve_absolute_node(candidate, search_path)?;
        return Some(CodexLaunchPlan {
            child_path: trusted_child_path(&node, candidate)?,
            program: node,
            prefix_args: vec![program.into_os_string()],
        });
    }
    direct_codex_launch_plan(program, candidate)
}

#[cfg(windows)]
fn codex_launch_plan_from_npm_prefix(
    prefix: &Path,
    search_path: Option<&OsStr>,
) -> Option<CodexLaunchPlan> {
    let script = prefix
        .join("node_modules")
        .join("@openai")
        .join("codex")
        .join("bin")
        .join("codex.js");
    codex_launch_plan_for_candidate(&script, search_path)
}

fn direct_codex_launch_plan(program: PathBuf, origin: &Path) -> Option<CodexLaunchPlan> {
    Some(CodexLaunchPlan {
        child_path: trusted_child_path(&program, origin)?,
        program,
        prefix_args: Vec::new(),
    })
}

fn looks_like_node_script(path: &Path) -> bool {
    if path
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| matches!(extension, "js" | "mjs" | "cjs"))
    {
        return true;
    }
    let Ok(file) = File::open(path) else {
        return false;
    };
    let mut prefix = Vec::new();
    if file.take(512).read_to_end(&mut prefix).is_err() {
        return false;
    }
    prefix.starts_with(b"#!")
        && (contains_bytes(&prefix, b"/env node") || contains_bytes(&prefix, b"/node"))
}

fn resolve_packaged_codex_native(script: &Path) -> Option<PathBuf> {
    let (package, triple) = codex_native_package_layout()?;
    let package_root = script.parent()?.parent()?;
    let executable_name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let package_relative = Path::new("vendor")
        .join(triple)
        .join("bin")
        .join(executable_name);
    let mut candidates = vec![
        package_root
            .join("node_modules")
            .join("@openai")
            .join(package)
            .join(&package_relative),
        package_root.join(&package_relative),
    ];
    if let Some(scope_root) = package_root.parent() {
        candidates.push(scope_root.join(package).join(&package_relative));
    }
    candidates
        .iter()
        .find_map(|candidate| canonical_executable(candidate))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn codex_native_package_layout() -> Option<(&'static str, &'static str)> {
    Some(("codex-darwin-arm64", "aarch64-apple-darwin"))
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn codex_native_package_layout() -> Option<(&'static str, &'static str)> {
    Some(("codex-darwin-x64", "x86_64-apple-darwin"))
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn codex_native_package_layout() -> Option<(&'static str, &'static str)> {
    Some(("codex-linux-arm64", "aarch64-unknown-linux-musl"))
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn codex_native_package_layout() -> Option<(&'static str, &'static str)> {
    Some(("codex-linux-x64", "x86_64-unknown-linux-musl"))
}

#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
fn codex_native_package_layout() -> Option<(&'static str, &'static str)> {
    Some(("codex-win32-arm64", "aarch64-pc-windows-msvc"))
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn codex_native_package_layout() -> Option<(&'static str, &'static str)> {
    Some(("codex-win32-x64", "x86_64-pc-windows-msvc"))
}

#[cfg(not(any(
    all(
        target_os = "macos",
        any(target_arch = "aarch64", target_arch = "x86_64")
    ),
    all(
        target_os = "linux",
        any(target_arch = "aarch64", target_arch = "x86_64")
    ),
    all(
        target_os = "windows",
        any(target_arch = "aarch64", target_arch = "x86_64")
    )
)))]
fn codex_native_package_layout() -> Option<(&'static str, &'static str)> {
    None
}

fn resolve_absolute_node(origin: &Path, search_path: Option<&OsStr>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(parent) = origin.parent() {
        candidates.push(parent.join(if cfg!(windows) { "node.exe" } else { "node" }));
    }
    if let Some(search_path) = search_path {
        candidates.extend(
            env::split_paths(search_path)
                .filter(|directory| directory.is_absolute())
                .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" })),
        );
    }
    #[cfg(not(windows))]
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ]);
    candidates
        .iter()
        .find_map(|candidate| canonical_executable(candidate))
}

fn trusted_child_path(program: &Path, origin: &Path) -> Option<OsString> {
    let mut directories = Vec::new();
    for directory in [program.parent(), origin.parent()].into_iter().flatten() {
        if directory.is_absolute() && !directories.iter().any(|known| known == directory) {
            directories.push(directory.to_path_buf());
        }
    }
    #[cfg(unix)]
    for directory in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        let directory = PathBuf::from(directory);
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    #[cfg(windows)]
    if let Some(system_root) = env::var_os("SystemRoot").map(PathBuf::from) {
        if system_root.is_absolute() {
            directories.push(system_root.join("System32"));
        }
    }
    env::join_paths(directories).ok()
}

fn canonical_executable(candidate: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(candidate).ok()?;
    let metadata = fs::metadata(&canonical).ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(canonical)
}

#[cfg(windows)]
fn codex_executable_names() -> &'static [&'static str] {
    // Batch launchers require cmd.exe quoting and do not provide a reliable
    // process-tree root. Prefer a real executable or resolve the npm package's
    // bundled native binary from its installation prefix.
    &["codex.exe"]
}

#[cfg(not(windows))]
fn codex_executable_names() -> &'static [&'static str] {
    &["codex"]
}

fn codex_executable_fallbacks() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(not(windows))]
    {
        candidates.extend([
            PathBuf::from("/usr/local/bin/codex"),
            PathBuf::from("/opt/homebrew/bin/codex"),
            PathBuf::from("/usr/bin/codex"),
            PathBuf::from("/opt/local/bin/codex"),
        ]);
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(".local/bin/codex"));
            candidates.push(home.join(".npm-global/bin/codex"));
        }
    }
    #[cfg(windows)]
    if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
        if app_data.is_absolute() {
            let npm_prefix = app_data.join("npm");
            candidates.push(npm_prefix.join("codex.exe"));
            candidates.push(npm_prefix.join("codex.cmd"));
            candidates.push(
                npm_prefix
                    .join("node_modules")
                    .join("@openai")
                    .join("codex")
                    .join("bin")
                    .join("codex.js"),
            );
        }
    }
    candidates
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AppServerFailure {
    Unavailable,
    Timeout,
    AuthRequired,
    SchemaUnsupported,
}

impl AppServerFailure {
    fn into_scan_failure(self) -> ScanFailure {
        match self {
            Self::Unavailable => ScanFailure::AppServerUnavailable,
            Self::Timeout => ScanFailure::AppServerTimeout,
            Self::AuthRequired => ScanFailure::AppServerAuthRequired,
            Self::SchemaUnsupported => ScanFailure::SourceSchemaUnsupported,
        }
    }
}

#[derive(Debug)]
struct AppServerObservation {
    buckets: Vec<AppServerBucket>,
}

#[derive(Debug)]
struct AppServerBucket {
    id: String,
    plan_type: Option<String>,
    primary: Option<NormalizedWindow>,
    secondary: Option<NormalizedWindow>,
    credits: Option<NormalizedCredits>,
}

#[derive(Clone, Debug)]
struct NormalizedCredits {
    remaining: Option<f64>,
    unlimited: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAppServerRateLimitsResponse {
    #[serde(default)]
    rate_limits: Option<RawAppServerBucket>,
    #[serde(default)]
    rate_limits_by_limit_id: Option<BTreeMap<String, RawAppServerBucket>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAppServerBucket {
    #[serde(default)]
    plan_type: Option<String>,
    #[serde(default)]
    primary: Option<RawAppServerWindow>,
    #[serde(default)]
    secondary: Option<RawAppServerWindow>,
    #[serde(default)]
    credits: Option<RawAppServerCredits>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAppServerWindow {
    used_percent: f64,
    #[serde(default)]
    window_duration_mins: Option<i64>,
    #[serde(default)]
    resets_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAppServerCredits {
    #[serde(default)]
    balance: Option<String>,
    has_credits: bool,
    unlimited: bool,
}

fn app_server_initialize_message() -> Value {
    serde_json::json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": {
                "name": "tokenledger",
                "title": "TokenLedger",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {}
        }
    })
}

fn app_server_initialized_message() -> Value {
    serde_json::json!({ "method": "initialized" })
}

fn app_server_rate_limits_message() -> Value {
    serde_json::json!({
        "id": 2,
        "method": "account/rateLimits/read",
        "params": null
    })
}

fn write_protocol_message(stdin: &mut impl Write, message: &Value) -> Result<(), AppServerFailure> {
    serde_json::to_writer(&mut *stdin, message).map_err(|_| AppServerFailure::Unavailable)?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|_| AppServerFailure::Unavailable)
}

fn read_bounded_line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, AppServerFailure> {
    let mut line = Vec::new();
    loop {
        let buffer = reader
            .fill_buf()
            .map_err(|_| AppServerFailure::Unavailable)?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |index| index + 1);
        if line
            .len()
            .checked_add(take)
            .is_none_or(|length| length > APP_SERVER_MAX_LINE_BYTES)
        {
            return Err(AppServerFailure::SchemaUnsupported);
        }
        line.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if newline.is_some() {
            while matches!(line.last(), Some(b'\n' | b'\r')) {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

struct AppServerReader {
    messages: Option<Receiver<Result<Value, AppServerFailure>>>,
    completed: Receiver<()>,
    handle: Option<thread::JoinHandle<()>>,
}

impl AppServerReader {
    fn messages(&self) -> Result<&Receiver<Result<Value, AppServerFailure>>, AppServerFailure> {
        self.messages.as_ref().ok_or(AppServerFailure::Unavailable)
    }

    fn shutdown(&mut self, timeout: Duration) {
        if self.handle.is_none() {
            self.messages.take();
            return;
        }
        self.messages.take();
        let completed = self.completed.recv_timeout(timeout);
        if matches!(
            completed,
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected)
        ) {
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        } else {
            // A descendant may have escaped the process tree while retaining
            // stdout. Detach rather than block the Tauri command forever.
            self.handle.take();
        }
    }
}

impl Drop for AppServerReader {
    fn drop(&mut self) {
        self.shutdown(APP_SERVER_READER_JOIN_TIMEOUT);
    }
}

fn spawn_app_server_reader(stdout: impl Read + Send + 'static) -> AppServerReader {
    let (sender, receiver) = mpsc::sync_channel(8);
    let (completed_sender, completed) = mpsc::channel();
    let handle = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let message = match read_bounded_line(&mut reader) {
                Ok(Some(line)) if !line.is_empty() => serde_json::from_slice::<Value>(&line)
                    .map_err(|_| AppServerFailure::SchemaUnsupported),
                Ok(Some(_)) => continue,
                Ok(None) => break,
                Err(error) => Err(error),
            };
            if sender.send(message).is_err() {
                break;
            }
        }
        let _ = completed_sender.send(());
    });
    AppServerReader {
        messages: Some(receiver),
        completed,
        handle: Some(handle),
    }
}

fn wait_for_app_server_response(
    receiver: &Receiver<Result<Value, AppServerFailure>>,
    request_id: u64,
    deadline: Instant,
) -> Result<Value, AppServerFailure> {
    for _ in 0..APP_SERVER_MAX_MESSAGES {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(AppServerFailure::Timeout)?;
        let message = receiver
            .recv_timeout(remaining)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => AppServerFailure::Timeout,
                mpsc::RecvTimeoutError::Disconnected => AppServerFailure::Unavailable,
            })??;
        if message.get("id").and_then(Value::as_u64) != Some(request_id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(classify_app_server_error(request_id, error));
        }
        return message
            .get("result")
            .cloned()
            .ok_or(AppServerFailure::SchemaUnsupported);
    }
    Err(AppServerFailure::SchemaUnsupported)
}

fn classify_app_server_error(request_id: u64, error: &Value) -> AppServerFailure {
    if !error.is_object() {
        return AppServerFailure::SchemaUnsupported;
    }
    if request_id == 2 && app_server_error_is_known_auth(error) {
        AppServerFailure::AuthRequired
    } else {
        // Do not inspect or forward free-form server messages. Overload,
        // upstream failure, and unknown protocol errors are not evidence that
        // the user's local Codex authentication was revoked.
        AppServerFailure::Unavailable
    }
}

fn app_server_error_is_known_auth(error: &Value) -> bool {
    if error.get("code").and_then(Value::as_i64) == Some(401) {
        return true;
    }
    let Some(data) = error.get("data") else {
        return false;
    };
    if known_app_server_auth_marker(data) {
        return true;
    }
    let Some(data) = data.as_object() else {
        return false;
    };
    ["code", "reason", "type", "kind"]
        .iter()
        .filter_map(|field| data.get(*field))
        .any(known_app_server_auth_marker)
        || data
            .get("error")
            .and_then(Value::as_object)
            .is_some_and(|nested| {
                ["code", "reason", "type", "kind"]
                    .iter()
                    .filter_map(|field| nested.get(*field))
                    .any(known_app_server_auth_marker)
            })
}

fn known_app_server_auth_marker(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some(
            "auth_required"
                | "authentication_required"
                | "login_required"
                | "not_authenticated"
                | "not_logged_in"
                | "unauthorized"
        )
    )
}

struct ChildGuard {
    child: Option<Child>,
    tree_id: u32,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        let tree_id = child.id();
        Self {
            child: Some(child),
            tree_id,
        }
    }

    fn child_mut(&mut self) -> Result<&mut Child, AppServerFailure> {
        self.child.as_mut().ok_or(AppServerFailure::Unavailable)
    }

    fn terminate(&mut self) {
        if let Some(mut child) = self.child.take() {
            terminate_process_tree(self.tree_id);
            let _ = child.kill();
            if !wait_for_child_exit(&mut child, APP_SERVER_TERMINATION_TIMEOUT) {
                let _ = child.kill();
                let _ = child.try_wait();
            }
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn configure_app_server_command(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now().checked_add(timeout);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Err(_) => return false,
            Ok(None) => {}
        }
        if deadline.is_none_or(|deadline| Instant::now() >= deadline) {
            return false;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(unix)]
fn terminate_process_tree(tree_id: u32) {
    const SIGKILL: i32 = 9;
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    if let Ok(process_group) = i32::try_from(tree_id) {
        // process_group(0) makes the wrapper PID the new group ID, so a
        // negative PID targets the wrapper and every descendant that inherited
        // the group, including npm/node launch shims.
        let _ = unsafe { kill(-process_group, SIGKILL) };
    }
}

#[cfg(windows)]
fn terminate_process_tree(tree_id: u32) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Some(system_root) = env::var_os("SystemRoot") else {
        return;
    };
    let system_root = PathBuf::from(system_root);
    if !system_root.is_absolute() {
        return;
    }
    let taskkill = system_root.join("System32").join("taskkill.exe");
    if !taskkill.is_file() {
        return;
    }
    let process_id = tree_id.to_string();
    let mut command = Command::new(taskkill);
    command
        .args(["/PID", process_id.as_str(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let Ok(mut taskkill) = command.spawn() else {
        return;
    };
    if !wait_for_child_exit(&mut taskkill, APP_SERVER_TERMINATION_TIMEOUT) {
        let _ = taskkill.kill();
        let _ = taskkill.try_wait();
    }
}

// Only `#[cfg(unix)]` tests call this (Unix shell-script fake app-servers);
// see the note on `resolve_codex_launch_plan_from` above (T10.203).
#[cfg(all(test, unix))]
fn query_codex_app_server(
    executable: &OsStr,
    timeout: Duration,
) -> Result<AppServerObservation, AppServerFailure> {
    let plan =
        codex_launch_plan_for_candidate(Path::new(executable), env::var_os("PATH").as_deref())
            .ok_or(AppServerFailure::Unavailable)?;
    query_codex_app_server_with_plan(&plan, timeout)
}

fn query_codex_app_server_with_plan(
    plan: &CodexLaunchPlan,
    timeout: Duration,
) -> Result<AppServerObservation, AppServerFailure> {
    let mut command = Command::new(&plan.program);
    command
        .args(&plan.prefix_args)
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("PATH", &plan.child_path);
    configure_app_server_command(&mut command);
    let child = command.spawn().map_err(|_| AppServerFailure::Unavailable)?;
    let mut child = ChildGuard::new(child);
    let stdout = child
        .child_mut()?
        .stdout
        .take()
        .ok_or(AppServerFailure::Unavailable)?;
    let mut stdin = child
        .child_mut()?
        .stdin
        .take()
        .ok_or(AppServerFailure::Unavailable)?;
    let mut reader = spawn_app_server_reader(stdout);
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(AppServerFailure::Timeout)?;

    let result = (|| {
        write_protocol_message(&mut stdin, &app_server_initialize_message())?;
        let _ = wait_for_app_server_response(reader.messages()?, 1, deadline)?;
        write_protocol_message(&mut stdin, &app_server_initialized_message())?;
        write_protocol_message(&mut stdin, &app_server_rate_limits_message())?;
        wait_for_app_server_response(reader.messages()?, 2, deadline)
    })();

    drop(stdin);
    child.terminate();
    reader.shutdown(APP_SERVER_READER_JOIN_TIMEOUT);
    parse_app_server_observation(result?)
}

fn query_codex_app_server_from_candidates(
    plans: Vec<CodexLaunchPlan>,
    timeout: Duration,
) -> Result<AppServerObservation, AppServerFailure> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(AppServerFailure::Timeout)?;
    let mut best_failure = AppServerFailure::Unavailable;

    for plan in plans {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        if remaining.is_zero() {
            break;
        }
        match query_codex_app_server_with_plan(&plan, remaining) {
            Ok(observation) => return Ok(observation),
            Err(AppServerFailure::AuthRequired) => return Err(AppServerFailure::AuthRequired),
            Err(AppServerFailure::Timeout) => best_failure = AppServerFailure::Timeout,
            Err(AppServerFailure::SchemaUnsupported)
                if best_failure == AppServerFailure::Unavailable =>
            {
                best_failure = AppServerFailure::SchemaUnsupported;
            }
            Err(AppServerFailure::SchemaUnsupported | AppServerFailure::Unavailable) => {}
        }
    }

    Err(best_failure)
}

fn parse_app_server_observation(result: Value) -> Result<AppServerObservation, AppServerFailure> {
    let raw: RawAppServerRateLimitsResponse =
        serde_json::from_value(result).map_err(|_| AppServerFailure::SchemaUnsupported)?;
    let mut buckets = Vec::new();

    if let Some(by_limit_id) = raw
        .rate_limits_by_limit_id
        .filter(|buckets| !buckets.is_empty())
    {
        if by_limit_id.len() > APP_SERVER_MAX_BUCKETS {
            return Err(AppServerFailure::SchemaUnsupported);
        }
        for (id, bucket) in by_limit_id {
            if let Some(bucket) = normalize_app_server_bucket(&id, bucket) {
                buckets.push(bucket);
            }
        }
    } else if let Some(bucket) = raw.rate_limits {
        if let Some(bucket) = normalize_app_server_bucket("default", bucket) {
            buckets.push(bucket);
        }
    }

    if buckets.is_empty() {
        return Err(AppServerFailure::SchemaUnsupported);
    }
    let window_count = buckets.iter().try_fold(0usize, |count, bucket| {
        count.checked_add(
            usize::from(bucket.primary.is_some())
                + usize::from(bucket.secondary.is_some())
                + usize::from(bucket.credits.is_some()),
        )
    });
    if window_count.is_none_or(|count| count > APP_SERVER_MAX_WINDOWS) {
        return Err(AppServerFailure::SchemaUnsupported);
    }
    Ok(AppServerObservation { buckets })
}

fn normalize_app_server_bucket(id: &str, raw: RawAppServerBucket) -> Option<AppServerBucket> {
    let id = sanitize_stable_id(id)?;
    let primary = raw.primary.as_ref().and_then(normalize_app_server_window);
    let secondary = raw.secondary.as_ref().and_then(normalize_app_server_window);
    let credits = raw.credits.as_ref().and_then(normalize_app_server_credits);
    if primary.is_none() && secondary.is_none() && credits.is_none() {
        return None;
    }
    Some(AppServerBucket {
        id,
        plan_type: sanitize_plan_type(raw.plan_type.as_deref()),
        primary,
        secondary,
        credits,
    })
}

fn normalize_app_server_window(raw: &RawAppServerWindow) -> Option<NormalizedWindow> {
    if !raw.used_percent.is_finite() || !(0.0..=100.0).contains(&raw.used_percent) {
        return None;
    }
    Some(NormalizedWindow {
        used_percent: raw.used_percent,
        window_minutes: raw
            .window_duration_mins
            .and_then(|minutes| u64::try_from(minutes).ok())
            .filter(|minutes| (1..=CODEX_MAX_WINDOW_MINUTES).contains(minutes)),
        resets_at: raw.resets_at.and_then(timestamp_from_seconds),
    })
}

fn normalize_app_server_credits(raw: &RawAppServerCredits) -> Option<NormalizedCredits> {
    let remaining = raw.balance.as_deref().and_then(|balance| {
        let balance = balance.parse::<f64>().ok()?;
        (balance.is_finite() && balance >= 0.0).then_some(balance)
    });
    if !raw.has_credits && !raw.unlimited && remaining.is_none() {
        return None;
    }
    Some(NormalizedCredits {
        remaining,
        unlimited: raw.unlimited,
    })
}

fn sanitize_stable_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return None;
    }
    Some(value.to_string())
}

static QUOTA_COORDINATOR: OnceLock<QuotaCoordinator> = OnceLock::new();

fn quota_coordinator() -> &'static QuotaCoordinator {
    QUOTA_COORDINATOR.get_or_init(QuotaCoordinator::default)
}

#[derive(Default)]
struct QuotaCoordinator {
    state: Mutex<CoordinatorState>,
    completed: Condvar,
}

#[derive(Default)]
struct CoordinatorState {
    roots: HashMap<PathBuf, RootCacheState>,
    generation: u64,
}

#[derive(Default)]
struct RootCacheState {
    in_flight: bool,
    recent: Option<CachedEnvelope>,
    last_good: Option<CachedEnvelope>,
}

struct CachedEnvelope {
    envelope: QuotaProviderEnvelope,
    stored_at: Instant,
}

impl QuotaCoordinator {
    fn refresh_root(&self, root: PathBuf) -> QuotaProviderEnvelope {
        let scan_root = root.clone();
        self.refresh_envelope_with(root, move || {
            let app_server = query_codex_app_server_from_candidates(
                resolve_codex_launch_plans(),
                APP_SERVER_TIMEOUT,
            );
            match app_server {
                Ok(observation) => Ok(codex_envelope_from_app_server(observation, Utc::now())),
                Err(app_server_failure) => {
                    let scan_started_at = Utc::now();
                    match scan_latest_rate_limit_event(
                        &scan_root,
                        scan_started_at,
                        DEFAULT_SCAN_LIMITS,
                    ) {
                        Ok(event) => Ok(codex_envelope_from_event(event, Utc::now())),
                        Err(_) => Err(app_server_failure.into_scan_failure()),
                    }
                }
            }
        })
    }

    #[cfg(test)]
    fn refresh_with<F>(&self, root: PathBuf, scan: F) -> QuotaProviderEnvelope
    where
        F: FnOnce() -> Result<NormalizedEvent, ScanFailure>,
    {
        self.refresh_envelope_with(root, move || {
            scan().map(|event| codex_envelope_from_event(event, Utc::now()))
        })
    }

    fn refresh_envelope_with<F>(&self, root: PathBuf, refresh: F) -> QuotaProviderEnvelope
    where
        F: FnOnce() -> Result<QuotaProviderEnvelope, ScanFailure>,
    {
        let claimed_generation;
        let mut state = self.lock_state();
        let request_generation = state.generation;
        loop {
            if state.generation != request_generation {
                return codex_authorization_required();
            }
            let now = Instant::now();
            let root_state = state.roots.entry(root.clone()).or_default();
            if root_state.recent.as_ref().is_some_and(|cached| {
                now.saturating_duration_since(cached.stored_at) <= RECENT_RESULT_REUSE
            }) {
                return root_state
                    .recent
                    .as_ref()
                    .map(|cached| cached.envelope.clone())
                    .unwrap_or_else(|| codex_error("provider_cache_unavailable"));
            }
            root_state.recent = None;

            if !root_state.in_flight {
                root_state.in_flight = true;
                claimed_generation = request_generation;
                break;
            }
            state = self.wait_for_completion(state);
        }
        drop(state);

        let refresh_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(refresh))
            .unwrap_or(Err(ScanFailure::ProviderWorkerFailed));
        let fetched_at = Utc::now();
        let stored_at = Instant::now();

        let mut state = self.lock_state();
        if state.generation != claimed_generation {
            self.completed.notify_all();
            return codex_authorization_required();
        }

        let root_state = state.roots.entry(root).or_default();
        if root_state.last_good.as_ref().is_some_and(|cached| {
            stored_at.saturating_duration_since(cached.stored_at) > LAST_GOOD_RETENTION
        }) {
            root_state.last_good = None;
        }

        let envelope = match refresh_result {
            Ok(envelope) => {
                root_state.last_good = Some(CachedEnvelope {
                    envelope: envelope.clone(),
                    stored_at,
                });
                envelope
            }
            Err(failure) => root_state
                .last_good
                .as_ref()
                .map(|cached| {
                    stale_from_last_good(&cached.envelope, failure.reason_code(), fetched_at)
                })
                .unwrap_or_else(|| codex_error(failure.reason_code())),
        };

        root_state.recent = Some(CachedEnvelope {
            envelope: envelope.clone(),
            stored_at,
        });
        root_state.in_flight = false;
        drop(state);
        self.completed.notify_all();
        envelope
    }

    fn failure_for_root(
        &self,
        root: &Path,
        failure: ScanFailure,
        fetched_at: DateTime<Utc>,
    ) -> QuotaProviderEnvelope {
        let now = Instant::now();
        let state = self.lock_state();
        state
            .roots
            .get(root)
            .and_then(|root_state| root_state.last_good.as_ref())
            .filter(|cached| now.saturating_duration_since(cached.stored_at) <= LAST_GOOD_RETENTION)
            .map(|cached| stale_from_last_good(&cached.envelope, failure.reason_code(), fetched_at))
            .unwrap_or_else(|| codex_error(failure.reason_code()))
    }

    fn clear(&self) {
        let mut state = self.lock_state();
        state.generation = state.generation.wrapping_add(1);
        state.roots.clear();
        drop(state);
        self.completed.notify_all();
    }

    fn lock_state(&self) -> MutexGuard<'_, CoordinatorState> {
        match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn wait_for_completion<'a>(
        &self,
        state: MutexGuard<'a, CoordinatorState>,
    ) -> MutexGuard<'a, CoordinatorState> {
        match self.completed.wait(state) {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

fn stale_from_last_good(
    last_good: &QuotaProviderEnvelope,
    reason_code: &str,
    fetched_at: DateTime<Utc>,
) -> QuotaProviderEnvelope {
    let mut envelope = last_good.clone();
    let fetched_at = format_timestamp(fetched_at);
    envelope.status = QuotaStatus::Stale;
    envelope.reason_code = Some(reason_code.to_string());
    envelope.action = if envelope.provider_id == CLAUDE_PROVIDER_ID {
        if reason_code.starts_with("claude_native_") {
            claude_native_error_code(reason_code).action
        } else if reason_code.starts_with("claude_codexbar_") {
            claude_fallback_cli_error(reason_code).action
        } else {
            claude_error(reason_code).action
        }
    } else if envelope.provider_id == ANTIGRAVITY_PROVIDER_ID {
        antigravity_error_code(reason_code).action
    } else if balance::is_balance_provider_id(&envelope.provider_id) {
        None
    } else {
        codex_error(reason_code).action
    };
    for window in &mut envelope.windows {
        window.status = QuotaWindowStatus::Stale;
        window.fetched_at.clone_from(&fetched_at);
        window.reason_code = Some(reason_code.to_string());
    }
    envelope
}

fn codex_authorization_required() -> QuotaProviderEnvelope {
    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: CODEX_PROVIDER_ID.to_string(),
        display_name: "Codex local usage".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::Stable,
        status: QuotaStatus::AuthRequired,
        windows: Vec::new(),
        reason_code: Some("local_authorization_required".to_string()),
        action: Some(QuotaAction {
            kind: QuotaActionKind::OpenSettings,
            label_key: "quota.action.enableCodexLocal".to_string(),
            value: "codex-local".to_string(),
        }),
    }
}

fn codex_error(reason_code: &str) -> QuotaProviderEnvelope {
    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: CODEX_PROVIDER_ID.to_string(),
        display_name: "Codex local usage".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::Stable,
        status: QuotaStatus::Error,
        windows: Vec::new(),
        reason_code: Some(reason_code.to_string()),
        action: Some(QuotaAction {
            kind: QuotaActionKind::OpenSettings,
            label_key: "quota.action.reviewCodexLocal".to_string(),
            value: "codex-local".to_string(),
        }),
    }
}

#[cfg(test)]
fn claude_unsupported() -> QuotaProviderEnvelope {
    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: CLAUDE_PROVIDER_ID.to_string(),
        display_name: "Claude consumer usage".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Unsupported,
        capability: QuotaCapability::Unsupported,
        status: QuotaStatus::Unsupported,
        windows: Vec::new(),
        reason_code: Some("consumer_api_unavailable".to_string()),
        action: Some(QuotaAction {
            kind: QuotaActionKind::ShowCommand,
            label_key: "quota.action.showClaudeUsage".to_string(),
            value: "/usage".to_string(),
        }),
    }
}

fn codex_envelope_from_app_server(
    observation: AppServerObservation,
    fetched_at: DateTime<Utc>,
) -> QuotaProviderEnvelope {
    let snapshot_at = fetched_at;
    let observed_at = format_timestamp(snapshot_at);
    let fetched_at = observed_at.clone();
    let mut windows = Vec::new();
    for bucket in observation.buckets {
        let prefix = (bucket.id != "default").then_some(bucket.id.as_str());
        if let Some(primary) = bucket.primary {
            windows.push(normalize_app_server_snapshot(
                prefix,
                "primary",
                "Primary",
                primary,
                bucket.plan_type.as_deref(),
                snapshot_at,
                &observed_at,
                &fetched_at,
            ));
        }
        if let Some(secondary) = bucket.secondary {
            windows.push(normalize_app_server_snapshot(
                prefix,
                "secondary",
                "Secondary",
                secondary,
                bucket.plan_type.as_deref(),
                snapshot_at,
                &observed_at,
                &fetched_at,
            ));
        }
        if let Some(credits) = bucket.credits {
            let id = prefix.map_or_else(
                || "credits".to_string(),
                |prefix| format!("{prefix}:credits"),
            );
            let label = prefix.map_or_else(
                || "Credits".to_string(),
                |prefix| format!("{prefix} · Credits"),
            );
            windows.push(QuotaWindowSnapshot {
                provider_id: CODEX_PROVIDER_ID.to_string(),
                window_id: id,
                window_label: label,
                account_label: bucket.plan_type.clone(),
                scope: QuotaScope::ConsumerSubscription,
                source: QuotaSource::LocalAuthorized,
                status: QuotaWindowStatus::Ok,
                used: None,
                limit: None,
                remaining: credits.remaining,
                unit: QuotaUnit::Credits,
                currency: None,
                window_minutes: None,
                resets_at: None,
                observed_at: observed_at.clone(),
                fetched_at: fetched_at.clone(),
                stale_after_seconds: STALE_AFTER_SECONDS as u64,
                reason_code: credits.unlimited.then(|| "credits_unlimited".to_string()),
            });
        }
    }

    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: CODEX_PROVIDER_ID.to_string(),
        display_name: "Codex local usage".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::Stable,
        status: QuotaStatus::Ok,
        windows,
        reason_code: None,
        action: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn normalize_app_server_snapshot(
    prefix: Option<&str>,
    suffix: &str,
    label: &str,
    window: NormalizedWindow,
    plan_type: Option<&str>,
    snapshot_at: DateTime<Utc>,
    observed_at: &str,
    fetched_at: &str,
) -> QuotaWindowSnapshot {
    let window_id =
        prefix.map_or_else(|| suffix.to_string(), |prefix| format!("{prefix}:{suffix}"));
    let window_label =
        prefix.map_or_else(|| label.to_string(), |prefix| format!("{prefix} · {label}"));
    let resets_at = window
        .resets_at
        .filter(|resets_at| valid_codex_reset_time(*resets_at, snapshot_at));
    QuotaWindowSnapshot {
        provider_id: CODEX_PROVIDER_ID.to_string(),
        window_id,
        window_label,
        account_label: plan_type.map(str::to_string),
        scope: QuotaScope::ConsumerSubscription,
        source: QuotaSource::LocalAuthorized,
        status: QuotaWindowStatus::Ok,
        used: Some(window.used_percent),
        limit: Some(100.0),
        remaining: Some(100.0 - window.used_percent),
        unit: QuotaUnit::Percent,
        currency: None,
        window_minutes: window.window_minutes,
        resets_at: resets_at.map(format_timestamp),
        observed_at: observed_at.to_string(),
        fetched_at: fetched_at.to_string(),
        stale_after_seconds: STALE_AFTER_SECONDS as u64,
        reason_code: None,
    }
}

fn codex_envelope_from_event(
    event: NormalizedEvent,
    fetched_at: DateTime<Utc>,
) -> QuotaProviderEnvelope {
    let observation_stale = fetched_at
        .signed_duration_since(event.observed_at)
        .num_seconds()
        > STALE_AFTER_SECONDS;
    let mut any_stale = observation_stale;
    let observed_at = format_timestamp(event.observed_at);
    let fetched_at_text = format_timestamp(fetched_at);

    let mut windows = Vec::with_capacity(3);
    if let Some(primary) = event.primary {
        let stale = observation_stale
            || primary
                .resets_at
                .is_some_and(|resets_at| resets_at <= fetched_at);
        any_stale |= stale;
        windows.push(normalize_snapshot(
            "primary",
            "Primary",
            primary,
            event.plan_type.as_deref(),
            if stale {
                QuotaWindowStatus::Stale
            } else {
                QuotaWindowStatus::Ok
            },
            stale.then_some("observation_stale"),
            &observed_at,
            &fetched_at_text,
        ));
    }
    if let Some(secondary) = event.secondary {
        let stale = observation_stale
            || secondary
                .resets_at
                .is_some_and(|resets_at| resets_at <= fetched_at);
        any_stale |= stale;
        windows.push(normalize_snapshot(
            "secondary",
            "Secondary",
            secondary,
            event.plan_type.as_deref(),
            if stale {
                QuotaWindowStatus::Stale
            } else {
                QuotaWindowStatus::Ok
            },
            stale.then_some("observation_stale"),
            &observed_at,
            &fetched_at_text,
        ));
    }
    if let Some(credits) = event.credits {
        windows.push(QuotaWindowSnapshot {
            provider_id: CODEX_PROVIDER_ID.to_string(),
            window_id: "credits".to_string(),
            window_label: "Credits".to_string(),
            account_label: event.plan_type.clone(),
            scope: QuotaScope::ConsumerSubscription,
            source: QuotaSource::LocalAuthorized,
            status: if observation_stale {
                QuotaWindowStatus::Stale
            } else {
                QuotaWindowStatus::Ok
            },
            used: None,
            limit: None,
            remaining: credits.remaining,
            unit: QuotaUnit::Credits,
            currency: None,
            window_minutes: None,
            resets_at: None,
            observed_at: observed_at.clone(),
            fetched_at: fetched_at_text.clone(),
            stale_after_seconds: STALE_AFTER_SECONDS as u64,
            reason_code: observation_stale
                .then(|| "observation_stale".to_string())
                .or_else(|| credits.unlimited.then(|| "credits_unlimited".to_string())),
        });
    }

    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: CODEX_PROVIDER_ID.to_string(),
        display_name: "Codex local usage".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::Experimental,
        status: if any_stale {
            QuotaStatus::Stale
        } else {
            QuotaStatus::Ok
        },
        windows,
        reason_code: any_stale.then(|| "observation_stale".to_string()),
        action: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn normalize_snapshot(
    window_id: &str,
    window_label: &str,
    window: NormalizedWindow,
    plan_type: Option<&str>,
    status: QuotaWindowStatus,
    reason_code: Option<&str>,
    observed_at: &str,
    fetched_at: &str,
) -> QuotaWindowSnapshot {
    QuotaWindowSnapshot {
        provider_id: CODEX_PROVIDER_ID.to_string(),
        window_id: window_id.to_string(),
        window_label: window_label.to_string(),
        account_label: plan_type.map(str::to_string),
        scope: QuotaScope::ConsumerSubscription,
        source: QuotaSource::LocalAuthorized,
        status,
        used: Some(window.used_percent),
        limit: Some(100.0),
        remaining: Some(100.0 - window.used_percent),
        unit: QuotaUnit::Percent,
        currency: None,
        window_minutes: window.window_minutes,
        resets_at: window.resets_at.map(format_timestamp),
        observed_at: observed_at.to_string(),
        fetched_at: fetched_at.to_string(),
        stale_after_seconds: STALE_AFTER_SECONDS as u64,
        reason_code: reason_code.map(str::to_string),
    }
}

fn format_timestamp(timestamp: DateTime<Utc>) -> String {
    timestamp.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeStatuslineSnapshot {
    schema_version: u8,
    observed_at: String,
    windows: Vec<ClaudeStatuslineWindow>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeStatuslineWindow {
    window_id: String,
    used_percent: f64,
    resets_at: String,
}

#[derive(Deserialize)]
struct RawClaudeStatuslineInput {
    rate_limits: RawClaudeRateLimits,
}

#[derive(Deserialize)]
struct RawClaudeRateLimits {
    #[serde(default)]
    five_hour: Option<RawClaudeWindow>,
    #[serde(default)]
    seven_day: Option<RawClaudeWindow>,
}

#[derive(Deserialize)]
struct RawClaudeWindow {
    used_percentage: f64,
    resets_at: RawTimestamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SnapshotFailure {
    Missing,
    Invalid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FallbackCliFailure {
    Unavailable,
    Timeout,
    ResponseInvalid,
}

impl FallbackCliFailure {
    fn reason_code(self) -> &'static str {
        match self {
            Self::Unavailable => "claude_codexbar_unavailable",
            Self::Timeout => "claude_codexbar_timeout",
            Self::ResponseInvalid => "claude_codexbar_response_invalid",
        }
    }

    fn user_message(self) -> &'static str {
        match self {
            Self::Unavailable => {
                "未找到可执行的 CodexBar CLI，且 Claude 内置 /usage 回退未能返回额度"
            }
            Self::Timeout => "CodexBar Claude 额度读取超时，请稍后重试",
            Self::ResponseInvalid => {
                "CodexBar 未返回可验证的 Claude 消费者额度，请在 CodexBar 中确认 Claude 来源已授权"
            }
        }
    }
}

fn parse_fallback_cli_claude_output(
    bytes: &[u8],
    fetched_at: DateTime<Utc>,
) -> Result<QuotaProviderEnvelope, FallbackCliFailure> {
    if bytes.is_empty() || bytes.len() > CLAUDE_FALLBACK_CLI_MAX_OUTPUT_BYTES {
        return Err(FallbackCliFailure::ResponseInvalid);
    }
    let root: Value =
        serde_json::from_slice(bytes).map_err(|_| FallbackCliFailure::ResponseInvalid)?;
    let payload = match &root {
        Value::Array(items) => items
            .iter()
            .find(|item| item.get("provider").and_then(Value::as_str) == Some("claude")),
        Value::Object(_) if root.get("provider").and_then(Value::as_str) == Some("claude") => {
            Some(&root)
        }
        _ => None,
    }
    .ok_or(FallbackCliFailure::ResponseInvalid)?;
    let source = payload
        .get("source")
        .and_then(Value::as_str)
        .ok_or(FallbackCliFailure::ResponseInvalid)?;
    if !matches!(source, "web" | "oauth" | "claude" | "cli" | "claude-web") {
        // API/Admin output is a different scope and must never be projected as
        // a consumer subscription window by this bridge.
        return Err(FallbackCliFailure::ResponseInvalid);
    }
    let usage = payload
        .get("usage")
        .and_then(Value::as_object)
        .ok_or(FallbackCliFailure::ResponseInvalid)?;
    let observed_at = usage
        .get("updatedAt")
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .ok_or(FallbackCliFailure::ResponseInvalid)?;
    let future_limit = fetched_at
        .checked_add_signed(chrono::Duration::seconds(MAX_FUTURE_CLOCK_SKEW_SECONDS))
        .ok_or(FallbackCliFailure::ResponseInvalid)?;
    if observed_at > future_limit
        || fetched_at.signed_duration_since(observed_at).num_seconds()
            > LAST_GOOD_RETENTION.as_secs() as i64
    {
        return Err(FallbackCliFailure::ResponseInvalid);
    }

    let mut windows = Vec::new();
    for (key, label, default_minutes) in [
        ("primary", "Primary window", Some(5 * 60)),
        ("secondary", "Secondary window", Some(7 * 24 * 60)),
        ("tertiary", "Tertiary window", None),
    ] {
        if let Some(window) = usage.get(key).filter(|value| !value.is_null()) {
            windows.push(normalize_fallback_cli_window(
                &format!("codexbar-{key}"),
                label,
                window,
                default_minutes,
                observed_at,
                fetched_at,
            )?);
        }
    }
    if let Some(extra) = usage.get("extraRateWindows").and_then(Value::as_array) {
        let remaining = CLAUDE_FALLBACK_CLI_MAX_WINDOWS.saturating_sub(windows.len());
        if extra.len() > remaining {
            return Err(FallbackCliFailure::ResponseInvalid);
        }
        for (index, item) in extra.iter().enumerate() {
            let window = item.get("window").unwrap_or(item);
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .and_then(sanitize_fallback_cli_identifier)
                .unwrap_or_else(|| format!("extra-{index}"));
            let label = item
                .get("title")
                .and_then(Value::as_str)
                .and_then(sanitize_fallback_cli_label)
                .unwrap_or_else(|| format!("Additional window {}", index + 1));
            windows.push(normalize_fallback_cli_window(
                &format!("codexbar-{id}"),
                &label,
                window,
                None,
                observed_at,
                fetched_at,
            )?);
        }
    }
    if windows.is_empty() || windows.len() > CLAUDE_FALLBACK_CLI_MAX_WINDOWS {
        return Err(FallbackCliFailure::ResponseInvalid);
    }
    let mut stable_ids = std::collections::HashSet::new();
    if windows
        .iter()
        .any(|window| !stable_ids.insert(window.window_id.as_str()))
    {
        return Err(FallbackCliFailure::ResponseInvalid);
    }
    let observation_stale =
        fetched_at.signed_duration_since(observed_at).num_seconds() > STALE_AFTER_SECONDS;
    if observation_stale {
        for window in &mut windows {
            window.status = QuotaWindowStatus::Stale;
            window.reason_code = Some("observation_stale".to_string());
        }
    }
    let any_stale = windows
        .iter()
        .any(|window| window.status == QuotaWindowStatus::Stale);
    Ok(QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: CLAUDE_PROVIDER_ID.to_string(),
        display_name: "Claude consumer usage".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::Experimental,
        status: if any_stale {
            QuotaStatus::Stale
        } else {
            QuotaStatus::Ok
        },
        windows,
        reason_code: any_stale.then(|| {
            if observation_stale {
                "observation_stale".to_string()
            } else {
                "reset_elapsed".to_string()
            }
        }),
        action: None,
    })
}

fn normalize_fallback_cli_window(
    window_id: &str,
    window_label: &str,
    value: &Value,
    default_minutes: Option<u64>,
    observed_at: DateTime<Utc>,
    fetched_at: DateTime<Utc>,
) -> Result<QuotaWindowSnapshot, FallbackCliFailure> {
    let used = value
        .get("usedPercent")
        .and_then(Value::as_f64)
        .ok_or(FallbackCliFailure::ResponseInvalid)?;
    if !used.is_finite() || !(0.0..=100.0).contains(&used) {
        return Err(FallbackCliFailure::ResponseInvalid);
    }
    let window_minutes = value
        .get("windowMinutes")
        .and_then(Value::as_u64)
        .or(default_minutes)
        .filter(|minutes| (1..=CODEX_MAX_WINDOW_MINUTES).contains(minutes));
    let resets_at = match value.get("resetsAt") {
        Some(Value::String(raw)) => {
            let reset = DateTime::parse_from_rfc3339(raw)
                .map_err(|_| FallbackCliFailure::ResponseInvalid)?
                .with_timezone(&Utc);
            if !valid_codex_reset_time(reset, observed_at) {
                return Err(FallbackCliFailure::ResponseInvalid);
            }
            Some(format_timestamp(reset))
        }
        Some(Value::Null) | None => None,
        _ => return Err(FallbackCliFailure::ResponseInvalid),
    };
    let reset_stale = resets_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|reset| reset.with_timezone(&Utc) <= fetched_at);
    Ok(QuotaWindowSnapshot {
        provider_id: CLAUDE_PROVIDER_ID.to_string(),
        window_id: window_id.to_string(),
        window_label: window_label.to_string(),
        account_label: None,
        scope: QuotaScope::ConsumerSubscription,
        source: QuotaSource::LocalAuthorized,
        status: if reset_stale {
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
        resets_at,
        observed_at: format_timestamp(observed_at),
        fetched_at: format_timestamp(fetched_at),
        stale_after_seconds: STALE_AFTER_SECONDS as u64,
        reason_code: reset_stale.then(|| "reset_elapsed".to_string()),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeCoreWindowRole {
    FiveHour,
    SevenDay,
}

fn claude_core_window_role(window: &QuotaWindowSnapshot) -> Option<ClaudeCoreWindowRole> {
    let id = window.window_id.to_ascii_lowercase();
    match id.as_str() {
        "five-hour" | "native-cli-five-hour" | "codexbar-primary" => {
            Some(ClaudeCoreWindowRole::FiveHour)
        }
        "seven-day" | "native-cli-seven-day" | "codexbar-secondary" => {
            Some(ClaudeCoreWindowRole::SevenDay)
        }
        _ if claude_historical_all_models_week(window) => Some(ClaudeCoreWindowRole::SevenDay),
        _ => None,
    }
}

fn claude_historical_all_models_week(window: &QuotaWindowSnapshot) -> bool {
    if window.window_minutes != Some(7 * 24 * 60)
        || !window
            .window_id
            .to_ascii_lowercase()
            .starts_with("codexbar-")
    {
        return false;
    }
    let identity = format!(
        "{} {}",
        window.window_id.to_ascii_lowercase(),
        window.window_label.to_ascii_lowercase()
    );
    identity.contains("all-model")
        || identity.contains("all model")
        // Older CodexBar payloads emitted the truncated "ll models only".
        || identity.contains("ll-model")
        || identity.contains("ll model")
}

fn normalize_claude_core_window(
    window: &QuotaWindowSnapshot,
    role: ClaudeCoreWindowRole,
) -> QuotaWindowSnapshot {
    let mut normalized = window.clone();
    if role == ClaudeCoreWindowRole::SevenDay && claude_historical_all_models_week(window) {
        normalized.window_id = "codexbar-secondary".to_string();
        normalized.window_label = "Secondary window".to_string();
    }
    normalized
}

fn claude_window_source_priority(window: &QuotaWindowSnapshot) -> u8 {
    match window.window_id.as_str() {
        "five-hour" | "seven-day" => 3,
        id if id.starts_with("codexbar-") => 2,
        id if id.starts_with("native-cli-") => 1,
        _ => 0,
    }
}

fn claude_window_freshness_priority(window: &QuotaWindowSnapshot) -> u8 {
    match window.status {
        QuotaWindowStatus::Ok => 2,
        QuotaWindowStatus::Stale => 1,
        QuotaWindowStatus::AuthRequired | QuotaWindowStatus::Error => 0,
    }
}

fn compare_claude_window_quality(
    left: &QuotaWindowSnapshot,
    right: &QuotaWindowSnapshot,
) -> Ordering {
    let left_usable = matches!(
        left.status,
        QuotaWindowStatus::Ok | QuotaWindowStatus::Stale
    );
    let right_usable = matches!(
        right.status,
        QuotaWindowStatus::Ok | QuotaWindowStatus::Stale
    );
    left_usable
        .cmp(&right_usable)
        .then_with(|| {
            claude_window_freshness_priority(left).cmp(&claude_window_freshness_priority(right))
        })
        .then_with(|| {
            parse_window_timestamp(&left.observed_at)
                .cmp(&parse_window_timestamp(&right.observed_at))
        })
        .then_with(|| {
            claude_window_source_priority(left).cmp(&claude_window_source_priority(right))
        })
        .then_with(|| {
            parse_window_timestamp(&left.fetched_at).cmp(&parse_window_timestamp(&right.fetched_at))
        })
        .then_with(|| right.window_id.cmp(&left.window_id))
}

fn parse_window_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

fn claude_additional_window_key(window: &QuotaWindowSnapshot) -> String {
    let identity = format!(
        "{} {}",
        window.window_id.to_ascii_lowercase(),
        window.window_label.to_ascii_lowercase()
    );
    let model = if identity.contains("sonnet") {
        Some("sonnet")
    } else if identity.contains("opus") {
        Some("opus")
    } else {
        None
    };
    model.map_or_else(
        || format!("id:{}", window.window_id),
        |model| {
            format!(
                "model:{model}:{}",
                window.window_minutes.unwrap_or_default()
            )
        },
    )
}

fn best_claude_core_window<'a>(
    envelopes: impl IntoIterator<Item = &'a QuotaProviderEnvelope>,
    role: ClaudeCoreWindowRole,
) -> Option<&'a QuotaWindowSnapshot> {
    envelopes
        .into_iter()
        .filter(|envelope| {
            envelope.provider_id == CLAUDE_PROVIDER_ID
                && matches!(envelope.status, QuotaStatus::Ok | QuotaStatus::Stale)
        })
        .flat_map(|envelope| envelope.windows.iter())
        .filter(|window| {
            matches!(
                window.status,
                QuotaWindowStatus::Ok | QuotaWindowStatus::Stale
            )
        })
        .filter(|window| claude_core_window_role(window) == Some(role))
        .max_by(|left, right| compare_claude_window_quality(left, right))
}

fn claude_envelope_has_complete_core_roles(envelope: &QuotaProviderEnvelope) -> bool {
    [
        ClaudeCoreWindowRole::FiveHour,
        ClaudeCoreWindowRole::SevenDay,
    ]
    .into_iter()
    .all(|role| best_claude_core_window([envelope], role).is_some())
}

pub(crate) fn merge_claude_provider_envelopes(
    envelopes: &[QuotaProviderEnvelope],
) -> Option<QuotaProviderEnvelope> {
    let usable = envelopes
        .iter()
        .filter(|envelope| {
            envelope.provider_id == CLAUDE_PROVIDER_ID
                && matches!(envelope.status, QuotaStatus::Ok | QuotaStatus::Stale)
                && !envelope.windows.is_empty()
        })
        .collect::<Vec<_>>();
    if usable.is_empty() {
        return None;
    }

    let mut windows = Vec::new();
    for role in [
        ClaudeCoreWindowRole::FiveHour,
        ClaudeCoreWindowRole::SevenDay,
    ] {
        if let Some(window) = best_claude_core_window(usable.iter().copied(), role) {
            windows.push(normalize_claude_core_window(window, role));
        }
    }

    let mut additional = BTreeMap::<String, &QuotaWindowSnapshot>::new();
    for window in usable.iter().flat_map(|envelope| envelope.windows.iter()) {
        if !matches!(
            window.status,
            QuotaWindowStatus::Ok | QuotaWindowStatus::Stale
        ) {
            continue;
        }
        if claude_core_window_role(window).is_some() {
            continue;
        }
        let key = claude_additional_window_key(window);
        match additional.get(&key) {
            Some(current)
                if compare_claude_window_quality(window, current) != Ordering::Greater => {}
            _ => {
                additional.insert(key, window);
            }
        }
    }
    windows.extend(additional.into_values().cloned());
    windows.sort_by(|left, right| {
        let role_rank = |window: &QuotaWindowSnapshot| match claude_core_window_role(window) {
            Some(ClaudeCoreWindowRole::FiveHour) => 0,
            Some(ClaudeCoreWindowRole::SevenDay) => 1,
            None => 2,
        };
        role_rank(left)
            .cmp(&role_rank(right))
            .then_with(|| {
                left.window_minutes
                    .unwrap_or(u64::MAX)
                    .cmp(&right.window_minutes.unwrap_or(u64::MAX))
            })
            .then_with(|| left.window_id.cmp(&right.window_id))
    });
    if windows.is_empty() {
        return None;
    }

    let any_fresh = windows
        .iter()
        .any(|window| window.status == QuotaWindowStatus::Ok);
    let only_statusline = windows
        .iter()
        .all(|window| matches!(window.window_id.as_str(), "five-hour" | "seven-day"));
    Some(QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: CLAUDE_PROVIDER_ID.to_string(),
        display_name: "Claude consumer usage".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: if only_statusline {
            QuotaCapability::PlanDependent
        } else {
            QuotaCapability::Experimental
        },
        status: if any_fresh {
            QuotaStatus::Ok
        } else {
            QuotaStatus::Stale
        },
        windows,
        reason_code: (!any_fresh).then(|| "observation_stale".to_string()),
        action: None,
    })
}

pub(crate) fn claude_local_envelope_may_replace_remote(
    local: &QuotaProviderEnvelope,
    remote: &QuotaProviderEnvelope,
) -> bool {
    [
        ClaudeCoreWindowRole::FiveHour,
        ClaudeCoreWindowRole::SevenDay,
    ]
    .into_iter()
    .all(|role| {
        let remote_window = best_claude_core_window([remote], role);
        let local_window = best_claude_core_window([local], role);
        match (local_window, remote_window) {
            (_, None) => true,
            (None, Some(_)) => false,
            (Some(local_window), Some(remote_window)) => {
                compare_claude_window_quality(local_window, remote_window) != Ordering::Less
            }
        }
    })
}

fn sanitize_fallback_cli_identifier(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character)))
    .then(|| value.to_string())
}

fn sanitize_fallback_cli_label(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()
        && value.chars().count() <= 64
        && value.chars().all(|character| !character.is_control()))
    .then(|| value.to_string())
}

fn resolve_fallback_cli_executables() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(explicit) = env::var_os("TOKENLEDGER_CODEXBAR_BIN") {
        let explicit = PathBuf::from(explicit);
        if explicit.is_absolute() {
            candidates.push(explicit);
        }
    }
    #[cfg(not(windows))]
    if let Some(home) = dirs::home_dir() {
        #[cfg(target_os = "macos")]
        candidates.push(home.join("Applications/CodexBar.app/Contents/Helpers/CodexBarCLI"));
        #[cfg(not(windows))]
        candidates.push(home.join(".local/bin/codexbar"));
    }
    #[cfg(target_os = "macos")]
    candidates.extend([
        PathBuf::from("/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI"),
        PathBuf::from("/opt/homebrew/bin/codexbar"),
        PathBuf::from("/usr/local/bin/codexbar"),
    ]);
    #[cfg(all(unix, not(target_os = "macos")))]
    candidates.extend([
        PathBuf::from("/usr/local/bin/codexbar"),
        PathBuf::from("/usr/bin/codexbar"),
    ]);
    #[cfg(windows)]
    {
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            candidates.extend([
                local_app_data.join("Programs/CodexBar/CodexBarCLI.exe"),
                local_app_data.join("CodexBar/CodexBarCLI.exe"),
            ]);
        }
        if let Some(program_files) = env::var_os("ProgramFiles").map(PathBuf::from) {
            candidates.push(program_files.join("CodexBar/CodexBarCLI.exe"));
        }
    }
    if let Some(search_path) = env::var_os("PATH") {
        let names: &[&str] = if cfg!(windows) {
            &["codexbar.exe", "CodexBarCLI.exe"]
        } else {
            &["codexbar", "CodexBarCLI"]
        };
        for directory in env::split_paths(&search_path).filter(|directory| directory.is_absolute())
        {
            candidates.extend(names.iter().map(|name| directory.join(name)));
        }
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

fn claude_fallback_cli_envelope(
    app_data_dir: &Path,
    fetched_at: DateTime<Utc>,
) -> Result<QuotaProviderEnvelope, FallbackCliFailure> {
    let candidates = resolve_fallback_cli_executables();
    if candidates.is_empty() {
        return Err(FallbackCliFailure::Unavailable);
    }
    let deadline = Instant::now()
        .checked_add(CLAUDE_FALLBACK_CLI_TOTAL_TIMEOUT)
        .ok_or(FallbackCliFailure::Timeout)?;
    let mut best_failure = FallbackCliFailure::Unavailable;
    for candidate in candidates {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(FallbackCliFailure::Timeout)?;
        let bytes = match capture_fallback_cli_claude_output(
            &candidate,
            app_data_dir,
            remaining.min(CLAUDE_FALLBACK_CLI_TIMEOUT),
        ) {
            Ok(bytes) => bytes,
            Err(failure) => {
                best_failure = prefer_fallback_cli_failure(best_failure, failure);
                continue;
            }
        };
        match parse_fallback_cli_claude_output(&bytes, fetched_at) {
            Ok(envelope) => return Ok(envelope),
            Err(failure) => best_failure = prefer_fallback_cli_failure(best_failure, failure),
        }
    }
    Err(best_failure)
}

fn prefer_fallback_cli_failure(
    current: FallbackCliFailure,
    candidate: FallbackCliFailure,
) -> FallbackCliFailure {
    fn priority(failure: FallbackCliFailure) -> u8 {
        match failure {
            FallbackCliFailure::ResponseInvalid => 3,
            FallbackCliFailure::Timeout => 2,
            FallbackCliFailure::Unavailable => 1,
        }
    }
    if priority(candidate) > priority(current) {
        candidate
    } else {
        current
    }
}

fn capture_fallback_cli_claude_output(
    program: &Path,
    app_data_dir: &Path,
    timeout: Duration,
) -> Result<Vec<u8>, FallbackCliFailure> {
    capture_fallback_cli_provider_output(program, app_data_dir, "claude", "auto", timeout)
}

fn capture_fallback_cli_provider_output(
    program: &Path,
    app_data_dir: &Path,
    provider: &str,
    source: &str,
    timeout: Duration,
) -> Result<Vec<u8>, FallbackCliFailure> {
    if !matches!(provider, "claude" | "antigravity") || !matches!(source, "auto" | "cli") {
        return Err(FallbackCliFailure::Unavailable);
    }
    let working_directory =
        secure_app_data_root(app_data_dir, true).map_err(|_| FallbackCliFailure::Unavailable)?;
    let mut command = Command::new(program);
    command
        .args([
            "--provider",
            provider,
            "--source",
            source,
            "--format",
            "json",
            "--no-color",
            "--json-only",
        ])
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("NO_COLOR", "1");
    if provider == "claude" {
        command.args(["--web-timeout", "15"]);
    }
    for (key, _) in env::vars_os() {
        let key_text = key.to_string_lossy();
        if key_text.starts_with("ANTHROPIC_")
            || key_text.starts_with("ANTIGRAVITY_OAUTH_")
            || key_text.starts_with("GOOGLE_APPLICATION_CREDENTIALS")
        {
            command.env_remove(key);
        }
    }
    configure_app_server_command(&mut command);
    let mut child = command
        .spawn()
        .map_err(|_| FallbackCliFailure::Unavailable)?;
    let tree_id = child.id();
    let Some(mut stdout) = child.stdout.take() else {
        terminate_process_tree(tree_id);
        let _ = child.kill();
        let _ = wait_for_child_exit(&mut child, APP_SERVER_TERMINATION_TIMEOUT);
        return Err(FallbackCliFailure::Unavailable);
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = Read::by_ref(&mut stdout)
            .take((CLAUDE_FALLBACK_CLI_MAX_OUTPUT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(FallbackCliFailure::Timeout)?;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                terminate_process_tree(tree_id);
                let _ = child.kill();
                let _ = wait_for_child_exit(&mut child, APP_SERVER_TERMINATION_TIMEOUT);
                let _ = receiver.recv_timeout(CLAUDE_FALLBACK_CLI_READER_JOIN_TIMEOUT);
                if reader.is_finished() {
                    let _ = reader.join();
                }
                return Err(FallbackCliFailure::Timeout);
            }
            Err(_) => {
                terminate_process_tree(tree_id);
                let _ = child.kill();
                let _ = wait_for_child_exit(&mut child, APP_SERVER_TERMINATION_TIMEOUT);
                return Err(FallbackCliFailure::Unavailable);
            }
        }
    };
    let bytes = match receiver.recv_timeout(CLAUDE_FALLBACK_CLI_READER_JOIN_TIMEOUT) {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return Err(FallbackCliFailure::Unavailable),
        Err(_) => {
            terminate_process_tree(tree_id);
            return Err(FallbackCliFailure::Timeout);
        }
    };
    if reader.is_finished() {
        let _ = reader.join();
    }
    if !status.success() || bytes.is_empty() || bytes.len() > CLAUDE_FALLBACK_CLI_MAX_OUTPUT_BYTES {
        return Err(FallbackCliFailure::ResponseInvalid);
    }
    Ok(bytes)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeNativeFailure {
    AuthorizationRequired,
    CliUnavailable,
    Timeout,
    UsageUnavailable,
    SubscriptionUnavailable,
    ResponseInvalid,
}

#[derive(Default)]
struct ClaudeNativeProbeState {
    recent: HashMap<PathBuf, CachedEnvelope>,
}

fn lock_claude_native_probe_state() -> MutexGuard<'static, ClaudeNativeProbeState> {
    match CLAUDE_NATIVE_PROBE_STATE
        .get_or_init(|| Mutex::new(ClaudeNativeProbeState::default()))
        .lock()
    {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn clear_claude_native_probe_cache() {
    lock_claude_native_probe_state().recent.clear();
}

impl ClaudeNativeFailure {
    fn reason_code(self) -> &'static str {
        match self {
            Self::AuthorizationRequired => "claude_native_authorization_required",
            Self::CliUnavailable => "claude_native_cli_unavailable",
            Self::Timeout => "claude_native_timeout",
            Self::UsageUnavailable => "claude_native_usage_unavailable",
            Self::SubscriptionUnavailable => "claude_native_subscription_unavailable",
            Self::ResponseInvalid => "claude_native_response_invalid",
        }
    }

    fn user_message(self) -> &'static str {
        match self {
            Self::AuthorizationRequired => {
                "Claude 本地登录已失效，请在 Claude 桌面版或 Claude Code 中重新登录"
            }
            Self::CliUnavailable => {
                "未找到 Claude 桌面版内置代理或 Claude Code，请先安装并登录 Claude"
            }
            Self::Timeout => "Claude 本地 /usage 读取超时，请稍后重试",
            Self::UsageUnavailable => {
                "Claude Desktop 额度页可能正常，但本机 Claude CLI 的 /usage 通道当前加载失败；请稍后重试或在 Claude Code 中重新登录"
            }
            Self::SubscriptionUnavailable => "当前 Claude 订阅没有返回可量化的 5 小时或每周额度",
            Self::ResponseInvalid => "Claude 本地 /usage 返回了无法验证的额度内容",
        }
    }
}

fn claude_native_envelope(app_data_dir: &Path, fetched_at: DateTime<Utc>) -> QuotaProviderEnvelope {
    let mut state = lock_claude_native_probe_state();
    let now = Instant::now();
    if let Some(cached) = state
        .recent
        .get(app_data_dir)
        .filter(|cached| now.saturating_duration_since(cached.stored_at) <= RECENT_RESULT_REUSE)
    {
        return cached.envelope.clone();
    }
    let probe_deadline = Instant::now().checked_add(CLAUDE_NATIVE_TOTAL_TIMEOUT);
    let native_result = probe_deadline
        .and_then(|deadline| deadline.checked_duration_since(Instant::now()))
        .filter(|remaining| !remaining.is_zero())
        .ok_or(ClaudeNativeFailure::Timeout)
        .and_then(|remaining| {
            capture_claude_cli_usage_from_candidates(
                &resolve_claude_cli_executables(),
                app_data_dir,
                remaining.min(CLAUDE_NATIVE_CLI_TIMEOUT),
            )
        })
        .and_then(|bytes| parse_claude_cli_usage(&bytes, fetched_at));
    let native_complete = native_result
        .as_ref()
        .is_ok_and(claude_envelope_has_complete_core_roles);
    let native_failure = native_result.as_ref().err().copied();
    let mut sources = native_result.into_iter().collect::<Vec<_>>();

    // A non-empty native result is not proof that both canonical roles were
    // captured correctly. Probe the independently normalized bridge whenever
    // native is incomplete, and also when CodexBar is installed so same-role
    // conflicts can be arbitrated instead of silently trusting PTY order.
    let fallback_cli_installed = !resolve_fallback_cli_executables().is_empty();
    let fallback_cli_result = if !native_complete || fallback_cli_installed {
        probe_deadline
            .and_then(|deadline| deadline.checked_duration_since(Instant::now()))
            .filter(|remaining| !remaining.is_zero())
            .ok_or(FallbackCliFailure::Timeout)
            .and_then(|_| claude_fallback_cli_envelope(app_data_dir, fetched_at))
    } else {
        Err(FallbackCliFailure::Unavailable)
    };
    let fallback_cli_failure = fallback_cli_result.as_ref().err().copied();
    sources.extend(fallback_cli_result);

    let envelope = merge_claude_provider_envelopes(&sources).unwrap_or_else(|| {
        match (native_failure, fallback_cli_failure) {
            (Some(native_failure), Some(FallbackCliFailure::Unavailable)) => {
                claude_native_error(native_failure)
            }
            (_, Some(bridge_failure)) => claude_fallback_cli_error(bridge_failure.reason_code()),
            (Some(native_failure), None) => claude_native_error(native_failure),
            (None, _) => claude_native_error(ClaudeNativeFailure::ResponseInvalid),
        }
    });
    if matches!(envelope.status, QuotaStatus::Ok | QuotaStatus::Stale) {
        state.recent.insert(
            app_data_dir.to_path_buf(),
            CachedEnvelope {
                envelope: envelope.clone(),
                stored_at: Instant::now(),
            },
        );
    } else {
        // A manual retry must start a fresh PTY instead of replaying a recent
        // upstream failure from the in-memory cache.
        state.recent.remove(app_data_dir);
    }
    envelope
}

/// `fs::canonicalize` 在 Windows 上返回扩展长度路径前缀，展示前去掉。
const WINDOWS_EXTENDED_PATH_PREFIX: &str = r"\\?\";

/// 设置页要显示「探针实际会用哪些 CLI」，否则用户看到失败也无从判断是没找到
/// CLI 还是找到了但读不出来。
pub(crate) fn claude_cli_candidate_paths() -> Vec<String> {
    resolve_claude_cli_executables()
        .into_iter()
        // Windows 的 canonicalize 会带上 UNC 扩展长度前缀，直接显示给用户很难读。
        .map(|path| {
            let text = path.to_string_lossy().to_string();
            match text.strip_prefix(WINDOWS_EXTENDED_PATH_PREFIX) {
                Some(trimmed) => trimmed.to_string(),
                None => text,
            }
        })
        .collect()
}

fn resolve_claude_cli_executables() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.extend(claude_desktop_cli_candidates(&home));
        #[cfg(not(windows))]
        candidates.extend([
            home.join(".local/bin/claude"),
            home.join(".claude/local/claude"),
        ]);
        #[cfg(windows)]
        candidates.extend([
            home.join(".local/bin/claude.exe"),
            home.join(".local/bin/claude.cmd"),
            home.join(".claude/local/claude.exe"),
            home.join(".claude/local/claude.cmd"),
        ]);
    }
    if let Some(search_path) = env::var_os("PATH") {
        // Windows 上 npm 安装的 Claude Code 只生成 `claude`（sh 脚本）、
        // `claude.cmd` 和 `claude.ps1`，**没有 `claude.exe`**。此前这里只找
        // `claude.exe`，等于把用户 PATH 里那个真正在用的 CLI 整个跳过，只能
        // 落到桌面版内置的旧版本上，`/usage` 输出对不上就报 response_invalid。
        //
        // 顺序即优先级：原生可执行文件不需要再套一层 shell，放最前；.cmd 次之；
        // .ps1 最后（要绕过执行策略，代价最大）。
        let executables: &[&str] = if cfg!(windows) {
            &["claude.exe", "claude.cmd", "claude.bat", "claude.ps1"]
        } else {
            &["claude"]
        };
        for executable in executables {
            candidates.extend(
                env::split_paths(&search_path)
                    .filter(|directory| directory.is_absolute())
                    .map(|directory| directory.join(executable)),
            );
        }
    }
    #[cfg(not(windows))]
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ]);
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

fn claude_desktop_cli_candidates(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(windows)]
    let _ = home;
    #[cfg(target_os = "macos")]
    roots.extend([
        home.join("Library/Application Support/Claude/claude-code"),
        home.join("Library/Application Support/Claude-3p/claude-code"),
    ]);
    #[cfg(windows)]
    {
        if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
            roots.extend([
                app_data.join("Claude/claude-code"),
                app_data.join("Claude-3p/claude-code"),
            ]);
        }
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            roots.extend([
                local_app_data.join("Claude/claude-code"),
                local_app_data.join("Claude-3p/claude-code"),
                local_app_data
                    .join("Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/claude-code"),
                local_app_data
                    .join("Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude-3p/claude-code"),
            ]);
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    roots.extend([
        home.join(".config/Claude/claude-code"),
        home.join(".config/Claude-3p/claude-code"),
    ]);

    let mut versioned = Vec::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.take(64).flatten() {
            let name = entry.file_name();
            let key = claude_cli_version_key(&name);
            let base = entry.path();
            #[cfg(target_os = "macos")]
            let candidate = base.join("claude.app/Contents/MacOS/claude");
            #[cfg(windows)]
            let candidate = base.join("claude.exe");
            #[cfg(not(any(target_os = "macos", windows)))]
            let candidate = base.join("claude");
            versioned.push((key, candidate));
        }
    }
    versioned.sort_by_key(|item| std::cmp::Reverse(item.0));
    versioned
        .into_iter()
        .map(|(_, candidate)| candidate)
        .collect()
}

fn claude_cli_version_key(name: &OsStr) -> [u64; 4] {
    let mut key = [0_u64; 4];
    if let Some(name) = name.to_str() {
        for (index, value) in name
            .split(|character: char| !character.is_ascii_digit())
            .filter(|value| !value.is_empty())
            .take(4)
            .enumerate()
        {
            key[index] = value.parse().unwrap_or_default();
        }
    }
    key
}

// Only `#[cfg(unix)]` tests call this (Unix shell-script fake Claude CLI);
// see the note on `resolve_codex_launch_plan_from` above (T10.203).
#[cfg(all(test, unix))]
fn capture_claude_cli_usage(
    program: &Path,
    app_data_dir: &Path,
) -> Result<Vec<u8>, ClaudeNativeFailure> {
    capture_claude_cli_usage_with_timeout(program, app_data_dir, CLAUDE_NATIVE_CLI_TIMEOUT)
}

fn capture_claude_cli_usage_from_candidates(
    candidates: &[PathBuf],
    app_data_dir: &Path,
    total_timeout: Duration,
) -> Result<Vec<u8>, ClaudeNativeFailure> {
    capture_claude_cli_usage_from_candidates_with(candidates, total_timeout, |program, timeout| {
        capture_claude_cli_usage_with_timeout(program, app_data_dir, timeout)
    })
}

fn capture_claude_cli_usage_from_candidates_with<F>(
    candidates: &[PathBuf],
    total_timeout: Duration,
    mut capture: F,
) -> Result<Vec<u8>, ClaudeNativeFailure>
where
    F: FnMut(&Path, Duration) -> Result<Vec<u8>, ClaudeNativeFailure>,
{
    if candidates.is_empty() {
        return Err(ClaudeNativeFailure::CliUnavailable);
    }
    let deadline = Instant::now()
        .checked_add(total_timeout)
        .ok_or(ClaudeNativeFailure::Timeout)?;
    let mut best_failure = ClaudeNativeFailure::CliUnavailable;
    let mut retry_candidates = Vec::new();

    for candidate in candidates {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err(prefer_claude_native_failure(
                best_failure,
                ClaudeNativeFailure::Timeout,
            ));
        };
        match capture(candidate, remaining.min(CLAUDE_NATIVE_ATTEMPT_TIMEOUT)) {
            Ok(output) => return Ok(output),
            Err(failure) => {
                best_failure = prefer_claude_native_failure(best_failure, failure);
                if matches!(
                    failure,
                    ClaudeNativeFailure::Timeout
                        | ClaudeNativeFailure::UsageUnavailable
                        | ClaudeNativeFailure::ResponseInvalid
                ) {
                    retry_candidates.push(candidate);
                }
            }
        }
    }

    // CodexBar retries a startup-looking or unavailable capture from a fresh
    // session. Do the same only after every distinct local Claude candidate
    // has had one chance, and keep the entire recovery sequence time-bounded.
    for candidate in retry_candidates {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        if remaining.is_zero() {
            break;
        }
        match capture(candidate, remaining.min(CLAUDE_NATIVE_ATTEMPT_TIMEOUT)) {
            Ok(output) => return Ok(output),
            Err(failure) => {
                best_failure = prefer_claude_native_failure(best_failure, failure);
            }
        }
    }

    Err(best_failure)
}

fn prefer_claude_native_failure(
    current: ClaudeNativeFailure,
    candidate: ClaudeNativeFailure,
) -> ClaudeNativeFailure {
    fn priority(failure: ClaudeNativeFailure) -> u8 {
        match failure {
            ClaudeNativeFailure::UsageUnavailable => 6,
            ClaudeNativeFailure::AuthorizationRequired => 5,
            ClaudeNativeFailure::SubscriptionUnavailable => 4,
            ClaudeNativeFailure::Timeout => 3,
            ClaudeNativeFailure::ResponseInvalid => 2,
            ClaudeNativeFailure::CliUnavailable => 1,
        }
    }
    if priority(candidate) > priority(current) {
        candidate
    } else {
        current
    }
}

fn prepare_claude_probe_directory(app_data_dir: &Path) -> Result<PathBuf, ClaudeNativeFailure> {
    let probe_dir = app_data_dir.join("ClaudeProbe");
    fs::create_dir_all(&probe_dir).map_err(|_| ClaudeNativeFailure::CliUnavailable)?;
    let probe_metadata =
        fs::symlink_metadata(&probe_dir).map_err(|_| ClaudeNativeFailure::CliUnavailable)?;
    if probe_metadata.file_type().is_symlink() || !probe_metadata.is_dir() {
        return Err(ClaudeNativeFailure::CliUnavailable);
    }
    let claude_dir = probe_dir.join(".claude");
    fs::create_dir_all(&claude_dir).map_err(|_| ClaudeNativeFailure::CliUnavailable)?;
    let claude_metadata =
        fs::symlink_metadata(&claude_dir).map_err(|_| ClaudeNativeFailure::CliUnavailable)?;
    if claude_metadata.file_type().is_symlink() || !claude_metadata.is_dir() {
        return Err(ClaudeNativeFailure::CliUnavailable);
    }
    let settings_path = claude_dir.join("settings.local.json");
    let mut settings = serde_json::Map::new();
    if let Ok(metadata) = fs::symlink_metadata(&settings_path) {
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > CLAUDE_PROBE_SETTINGS_MAX_BYTES as u64
        {
            return Err(ClaudeNativeFailure::CliUnavailable);
        }
        let bytes = fs::read(&settings_path).map_err(|_| ClaudeNativeFailure::CliUnavailable)?;
        if let Ok(Value::Object(existing)) = serde_json::from_slice::<Value>(&bytes) {
            settings = existing;
        }
    }
    settings.insert(
        "disableDeepLinkRegistration".to_string(),
        Value::String("disable".to_string()),
    );
    let bytes = serde_json::to_vec_pretty(&Value::Object(settings))
        .map_err(|_| ClaudeNativeFailure::CliUnavailable)?;
    if bytes.len() > CLAUDE_PROBE_SETTINGS_MAX_BYTES {
        return Err(ClaudeNativeFailure::CliUnavailable);
    }

    let temp_path = claude_dir.join(format!(
        ".settings.local.json.tmp.{}.{}",
        std::process::id(),
        ATOMIC_FILE_COUNTER.fetch_add(1, AtomicOrdering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_result = (|| {
        let mut file = options
            .open(&temp_path)
            .map_err(|_| ClaudeNativeFailure::CliUnavailable)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| ClaudeNativeFailure::CliUnavailable)?;
        drop(file);
        atomic_replace(&temp_path, &settings_path).map_err(|_| ClaudeNativeFailure::CliUnavailable)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result?;
    Ok(probe_dir)
}

/// Windows 批处理与 PowerShell 脚本不能直接 `CreateProcess`，必须由对应解释器
/// 调起；原生可执行文件则直接执行，不额外套一层 shell。
///
/// 拆成独立函数是为了能在不真正拉起 CLI 的情况下对参数拼装做断言——真机探针
/// 本身依赖已登录的 Claude 订阅，进不了常规门禁。
fn claude_pty_launch(program: &Path) -> (PathBuf, Vec<OsString>) {
    #[cfg(windows)]
    {
        let extension = program
            .extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        match extension.as_str() {
            "cmd" | "bat" => {
                let shell = env::var_os("COMSPEC")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("cmd.exe"));
                return (shell, vec![OsString::from("/c"), program.into()]);
            }
            "ps1" => {
                return (
                    PathBuf::from("powershell.exe"),
                    vec![
                        OsString::from("-NoProfile"),
                        OsString::from("-ExecutionPolicy"),
                        OsString::from("Bypass"),
                        OsString::from("-File"),
                        program.into(),
                    ],
                );
            }
            _ => {}
        }
    }
    (program.to_path_buf(), Vec::new())
}

fn claude_pty_command(program: &Path) -> PtyCommandBuilder {
    let (executable, prefix_args) = claude_pty_launch(program);
    let mut command = PtyCommandBuilder::new(executable);
    for argument in prefix_args {
        command.arg(argument);
    }
    command
}

fn capture_claude_cli_usage_with_timeout(
    program: &Path,
    app_data_dir: &Path,
    timeout: Duration,
) -> Result<Vec<u8>, ClaudeNativeFailure> {
    let probe_dir = prepare_claude_probe_directory(app_data_dir)?;

    let pty = native_pty_system()
        .openpty(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|_| ClaudeNativeFailure::CliUnavailable)?;
    let mut command = claude_pty_command(program);
    command.args(["--allowed-tools", ""]);
    command.cwd(probe_dir.as_os_str());
    command.env("TERM", "xterm-256color");
    command.env("NO_COLOR", "1");
    command.env("DISABLE_AUTOUPDATER", "1");
    for (key, _) in env::vars_os() {
        if key.to_string_lossy().starts_with("ANTHROPIC_") {
            command.env_remove(key);
        }
    }
    let mut child = pty
        .slave
        .spawn_command(command)
        .map_err(|_| ClaudeNativeFailure::CliUnavailable)?;
    drop(pty.slave);

    // From here on the child is live: every failure must fall through to the
    // kill/wait/join cleanup below instead of returning early, or the spawned
    // CLI leaks as an orphan (broken-pipe writes are the common trigger).
    let mut reader = match pty.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ClaudeNativeFailure::CliUnavailable);
        }
    };
    let mut writer = match pty.master.take_writer() {
        Ok(writer) => writer,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ClaudeNativeFailure::CliUnavailable);
        }
    };
    let (sender, receiver) = mpsc::channel();
    let reader_handle = thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) if sender.send(buffer[..read].to_vec()).is_err() => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });

    let deadline = Instant::now().checked_add(timeout);
    let mut output = Vec::new();
    let launched_at = Instant::now();
    let mut trust_handled = false;
    let mut usage_sent = false;
    let mut last_enter = Instant::now();
    let mut parsed_at = None;
    let result = match deadline {
        None => Err(ClaudeNativeFailure::Timeout),
        Some(deadline) => loop {
            let remaining = match deadline.checked_duration_since(Instant::now()) {
                Some(remaining) => remaining.min(Duration::from_millis(100)),
                None => break Err(ClaudeNativeFailure::Timeout),
            };
            match receiver.recv_timeout(remaining) {
                Ok(chunk) => {
                    if output
                        .len()
                        .checked_add(chunk.len())
                        .is_none_or(|length| length > CLAUDE_NATIVE_MAX_OUTPUT_BYTES)
                    {
                        break Err(ClaudeNativeFailure::ResponseInvalid);
                    }
                    output.extend_from_slice(&chunk);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if parse_claude_cli_usage(&output, Utc::now()).is_ok() {
                        break Ok(output);
                    }
                    break Err(classify_claude_cli_output(&output));
                }
            }

            let plain = claude_cli_plain_text(&output);
            let lower = plain.to_ascii_lowercase();
            if !trust_handled
                && (lower.contains("quick safety check")
                    || lower.contains("is this a project you created")
                    || lower.contains("yes, i trust this folder"))
            {
                if writer
                    .write_all(b"1\r")
                    .and_then(|_| writer.flush())
                    .is_err()
                {
                    break Err(ClaudeNativeFailure::CliUnavailable);
                }
                trust_handled = true;
                continue;
            }
            if !usage_sent
                && (lower.contains("welcome back")
                    || lower.contains("claude quota waiting")
                    || lower.contains("tips for getting started")
                    || launched_at.elapsed() >= CLAUDE_NATIVE_STARTUP_GRACE)
            {
                if writer
                    .write_all(b"/usage\r")
                    .and_then(|_| writer.flush())
                    .is_err()
                {
                    break Err(ClaudeNativeFailure::CliUnavailable);
                }
                usage_sent = true;
                last_enter = Instant::now();
                continue;
            }
            if lower.contains("failed to load usage data")
                || lower.contains("currently using your subscription")
                || lower.contains("token expired")
                || lower.contains("please run") && lower.contains("login")
            {
                break Err(classify_claude_cli_output(&output));
            }
            if parse_claude_cli_usage(&output, Utc::now()).is_ok() {
                let first_parsed = parsed_at.get_or_insert_with(Instant::now);
                if first_parsed.elapsed() >= CLAUDE_NATIVE_CLI_SETTLE {
                    break Ok(output);
                }
            } else if usage_sent && last_enter.elapsed() >= Duration::from_millis(800) {
                if writer
                    .write_all(b"\r")
                    .and_then(|_| writer.flush())
                    .is_err()
                {
                    break Err(ClaudeNativeFailure::CliUnavailable);
                }
                last_enter = Instant::now();
            }
            match child.try_wait() {
                Ok(Some(_)) => break Err(classify_claude_cli_output(&output)),
                Ok(None) => {}
                Err(_) => break Err(ClaudeNativeFailure::CliUnavailable),
            }
        },
    };

    let _ = child.kill();
    let _ = child.wait();
    drop(writer);
    drop(pty.master);
    let _ = reader_handle.join();
    result
}

fn classify_claude_cli_output(bytes: &[u8]) -> ClaudeNativeFailure {
    let lower = claude_cli_plain_text(bytes).to_ascii_lowercase();
    if lower.contains("token expired")
        || lower.contains("authentication")
        || lower.contains("please run") && lower.contains("login")
    {
        ClaudeNativeFailure::AuthorizationRequired
    } else if lower.contains("currently using your subscription")
        || lower.contains("subscription notice")
    {
        ClaudeNativeFailure::SubscriptionUnavailable
    } else if lower.contains("failed to load usage data")
        || lower.contains("could not load usage data")
    {
        ClaudeNativeFailure::UsageUnavailable
    } else {
        ClaudeNativeFailure::ResponseInvalid
    }
}

fn claude_cli_plain_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut plain = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{1b}' {
            match characters.peek().copied() {
                Some('[') => {
                    characters.next();
                    let mut final_character = None;
                    for control in characters.by_ref() {
                        if ('@'..='~').contains(&control) {
                            final_character = Some(control);
                            break;
                        }
                    }
                    match final_character {
                        Some('C') | Some('G') => plain.push(' '),
                        Some('B') => plain.push('\n'),
                        _ => {}
                    }
                }
                Some(']') => {
                    characters.next();
                    while let Some(control) = characters.next() {
                        if control == '\u{7}' {
                            break;
                        }
                        if control == '\u{1b}' && characters.peek() == Some(&'\\') {
                            characters.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    characters.next();
                }
                None => {}
            }
            continue;
        }
        match character {
            '\r' | '\n' => plain.push('\n'),
            '\u{8}' => {
                plain.pop();
            }
            character if character.is_control() => {}
            character => plain.push(character),
        }
    }
    plain
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_claude_cli_usage(
    bytes: &[u8],
    fetched_at: DateTime<Utc>,
) -> Result<QuotaProviderEnvelope, ClaudeNativeFailure> {
    if bytes.is_empty() || bytes.len() > CLAUDE_NATIVE_MAX_OUTPUT_BYTES {
        return Err(ClaudeNativeFailure::ResponseInvalid);
    }
    let plain = claude_cli_plain_text(bytes);
    let lower = plain.to_ascii_lowercase();
    if lower.contains("failed to load usage data") || lower.contains("could not load usage data") {
        return Err(ClaudeNativeFailure::UsageUnavailable);
    }
    if lower.contains("token expired") || lower.contains("please run") && lower.contains("login") {
        return Err(ClaudeNativeFailure::AuthorizationRequired);
    }

    let mut windows = Vec::new();
    for (labels, id, label, minutes) in [
        (
            &["Current session"][..],
            "native-cli-five-hour",
            "5-hour",
            5 * 60,
        ),
        (
            &["Current week (all models)", "Current week"][..],
            "native-cli-seven-day",
            "7-day",
            7 * 24 * 60,
        ),
        (
            &["Current week (Sonnet only)", "Current week (Sonnet)"][..],
            "native-cli-seven-day-sonnet",
            "Sonnet · weekly",
            7 * 24 * 60,
        ),
        (
            &["Current week (Opus)"][..],
            "native-cli-seven-day-opus",
            "Opus · weekly",
            7 * 24 * 60,
        ),
    ] {
        if let Some((used, reset)) = extract_claude_cli_window(&plain, labels, fetched_at) {
            windows.push(claude_cli_window(
                id, label, used, reset, minutes, fetched_at,
            )?);
        }
    }
    windows.dedup_by(|left, right| left.window_id == right.window_id);
    if windows.is_empty() {
        return if lower.contains("currently using your subscription") {
            Err(ClaudeNativeFailure::SubscriptionUnavailable)
        } else {
            Err(ClaudeNativeFailure::ResponseInvalid)
        };
    }
    if windows.len() > CLAUDE_NATIVE_MAX_WINDOWS {
        return Err(ClaudeNativeFailure::ResponseInvalid);
    }
    Ok(QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: CLAUDE_PROVIDER_ID.to_string(),
        display_name: "Claude consumer usage".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::Experimental,
        status: QuotaStatus::Ok,
        windows,
        reason_code: None,
        action: None,
    })
}

fn extract_claude_cli_window(
    text: &str,
    labels: &[&str],
    fetched_at: DateTime<Utc>,
) -> Option<(f64, Option<String>)> {
    let lines = text.lines().collect::<Vec<_>>();
    let headings = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| claude_cli_heading(line).map(|heading| (index, heading)))
        .collect::<Vec<_>>();
    let wanted = labels
        .iter()
        .filter_map(|label| claude_cli_heading(label))
        .collect::<Vec<_>>();

    // PTY output is an append-only stream of terminal redraws. Start with the
    // newest matching heading, but never scan beyond the next quota heading.
    // If the newest redraw is truncated, fall back to the preceding complete
    // frame instead of borrowing a percentage from the next frame.
    for (heading_index, heading) in headings.iter().rev() {
        if !wanted.contains(heading) {
            continue;
        }
        let section_end = headings
            .iter()
            .find(|(candidate, _)| candidate > heading_index)
            .map_or(lines.len(), |(candidate, _)| *candidate);
        let section = lines[*heading_index..section_end]
            .join("\n")
            .chars()
            .take(800)
            .collect::<String>();
        let Some(percent) = claude_cli_percent_regex().captures(&section) else {
            continue;
        };
        let value = percent.get(1)?.as_str().parse::<f64>().ok()?;
        if !value.is_finite() || !(0.0..=100.0).contains(&value) {
            continue;
        }
        let direction = percent.get(2)?.as_str().to_ascii_lowercase();
        let used = if direction == "left" {
            100.0 - value
        } else {
            value
        };
        return Some((used, claude_cli_relative_reset(&section, fetched_at)));
    }
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeCliHeading {
    FiveHour,
    SevenDay,
    SevenDaySonnet,
    SevenDayOpus,
}

fn claude_cli_heading(text: &str) -> Option<ClaudeCliHeading> {
    let compact = text
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if compact.contains("currentsession") {
        return Some(ClaudeCliHeading::FiveHour);
    }
    if !compact.contains("currentweek") {
        return None;
    }
    if compact.contains("sonnet") {
        Some(ClaudeCliHeading::SevenDaySonnet)
    } else if compact.contains("opus") {
        Some(ClaudeCliHeading::SevenDayOpus)
    } else {
        Some(ClaudeCliHeading::SevenDay)
    }
}

fn claude_cli_percent_regex() -> &'static regex::Regex {
    static PERCENT: OnceLock<regex::Regex> = OnceLock::new();
    PERCENT.get_or_init(|| {
        regex::Regex::new(r"(?i)([0-9]{1,3}(?:\.[0-9]+)?)\s*%\s*(left|used)")
            .expect("fixed Claude CLI percentage regex")
    })
}

fn claude_cli_relative_reset(section: &str, fetched_at: DateTime<Utc>) -> Option<String> {
    static RESET: OnceLock<regex::Regex> = OnceLock::new();
    let captures = RESET
        .get_or_init(|| {
            regex::Regex::new(
                r"(?i)resets?\s+in\s+(?:(\d+)\s*(?:d|day|days))?\s*(?:(\d+)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+)\s*(?:m|min|mins|minute|minutes))?",
            )
            .expect("fixed Claude CLI reset regex")
        })
        .captures(section)?;
    let days = captures
        .get(1)
        .and_then(|value| value.as_str().parse::<i64>().ok())
        .unwrap_or_default();
    let hours = captures
        .get(2)
        .and_then(|value| value.as_str().parse::<i64>().ok())
        .unwrap_or_default();
    let minutes = captures
        .get(3)
        .and_then(|value| value.as_str().parse::<i64>().ok())
        .unwrap_or_default();
    let seconds = days
        .checked_mul(24 * 60 * 60)?
        .checked_add(hours.checked_mul(60 * 60)?)?
        .checked_add(minutes.checked_mul(60)?)?;
    if seconds <= 0 || seconds > CLAUDE_SEVEN_DAY_MAX_RESET_SECONDS {
        return None;
    }
    fetched_at
        .checked_add_signed(chrono::Duration::seconds(seconds))
        .map(format_timestamp)
}

fn claude_cli_window(
    window_id: &str,
    window_label: &str,
    used: f64,
    resets_at: Option<String>,
    window_minutes: u64,
    fetched_at: DateTime<Utc>,
) -> Result<QuotaWindowSnapshot, ClaudeNativeFailure> {
    if !used.is_finite() || !(0.0..=100.0).contains(&used) {
        return Err(ClaudeNativeFailure::ResponseInvalid);
    }
    if resets_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|reset| !valid_codex_reset_time(reset.with_timezone(&Utc), fetched_at))
    {
        return Err(ClaudeNativeFailure::ResponseInvalid);
    }
    Ok(QuotaWindowSnapshot {
        provider_id: CLAUDE_PROVIDER_ID.to_string(),
        window_id: window_id.to_string(),
        window_label: window_label.to_string(),
        account_label: None,
        scope: QuotaScope::ConsumerSubscription,
        source: QuotaSource::LocalAuthorized,
        status: QuotaWindowStatus::Ok,
        used: Some(used),
        limit: Some(100.0),
        remaining: Some(100.0 - used),
        unit: QuotaUnit::Percent,
        currency: None,
        window_minutes: Some(window_minutes),
        resets_at,
        observed_at: format_timestamp(fetched_at),
        fetched_at: format_timestamp(fetched_at),
        stale_after_seconds: STALE_AFTER_SECONDS as u64,
        reason_code: None,
    })
}

#[tauri::command]
pub async fn authorize_claude_native_quota(
    app_state: tauri::State<'_, Arc<crate::app_paths::AppContext>>,
) -> Result<String, String> {
    let app = app_state.inner().as_ref();
    if !crate::settings::load_settings(app).quota_claude_codexbar_enabled {
        return Err("请先开启 Claude 内置额度读取".to_string());
    }
    let now = Utc::now();
    let app_data_dir = app.app_data_dir().to_path_buf();
    let envelope =
        tauri::async_runtime::spawn_blocking(move || claude_native_envelope(&app_data_dir, now))
            .await
            .map_err(|_| "Claude 本地 /usage 读取任务失败".to_string())?;
    if !matches!(envelope.status, QuotaStatus::Ok | QuotaStatus::Stale) {
        let reason_code = envelope.reason_code.as_deref().unwrap_or_default();
        if let Some(failure) = claude_fallback_cli_failure_from_reason(reason_code) {
            return Err(failure.user_message().to_string());
        }
        let failure = claude_native_failure_from_reason(reason_code)
            .unwrap_or(ClaudeNativeFailure::ResponseInvalid);
        return Err(failure.user_message().to_string());
    }
    if !crate::settings::load_settings(app).quota_claude_codexbar_enabled {
        return Err("Claude 内置额度读取已被关闭".to_string());
    }
    let _ = finalize_with_persisted_last_good(
        app.app_data_dir(),
        CLAUDE_LAST_GOOD_FILE,
        CLAUDE_PROVIDER_ID,
        envelope,
        now,
    );
    Ok("Claude 额度读取已启用：内置 /usage 优先，CodexBar 仅在本地读取失败时兜底".to_string())
}

#[tauri::command]
pub async fn authorize_antigravity_quota(
    app_state: tauri::State<'_, Arc<crate::app_paths::AppContext>>,
) -> Result<String, String> {
    let app = app_state.inner().as_ref();
    let settings = crate::settings::load_settings(app);
    if !settings.quota_antigravity_local_enabled {
        return Err("请先开启 Antigravity 本地额度读取".to_string());
    }
    let now = Utc::now();
    let envelope = antigravity_envelope(
        app.app_data_dir(),
        now,
        settings.quota_antigravity_codexbar_enabled,
    )
    .await;
    if !matches!(envelope.status, QuotaStatus::Ok | QuotaStatus::Stale) {
        return Err(antigravity_failure_user_message(
            envelope.reason_code.as_deref().unwrap_or_default(),
        )
        .to_string());
    }
    if !crate::settings::load_settings(app).quota_antigravity_local_enabled {
        return Err("Antigravity 本地额度读取已被关闭".to_string());
    }
    let window_count = envelope.windows.len();
    let _ = finalize_with_persisted_last_good(
        app.app_data_dir(),
        ANTIGRAVITY_LAST_GOOD_FILE,
        ANTIGRAVITY_PROVIDER_ID,
        envelope,
        now,
    );
    Ok(format!(
        "Antigravity 本地额度读取成功，共识别 {window_count} 个额度窗口"
    ))
}

fn claude_fallback_cli_failure_from_reason(reason_code: &str) -> Option<FallbackCliFailure> {
    match reason_code {
        "claude_codexbar_unavailable" => Some(FallbackCliFailure::Unavailable),
        "claude_codexbar_timeout" => Some(FallbackCliFailure::Timeout),
        "claude_codexbar_response_invalid" => Some(FallbackCliFailure::ResponseInvalid),
        _ => None,
    }
}

fn claude_native_failure_from_reason(reason_code: &str) -> Option<ClaudeNativeFailure> {
    match reason_code {
        "claude_native_authorization_required" => Some(ClaudeNativeFailure::AuthorizationRequired),
        "claude_native_cli_unavailable" => Some(ClaudeNativeFailure::CliUnavailable),
        "claude_native_timeout" => Some(ClaudeNativeFailure::Timeout),
        "claude_native_usage_unavailable" => Some(ClaudeNativeFailure::UsageUnavailable),
        "claude_native_subscription_unavailable" => {
            Some(ClaudeNativeFailure::SubscriptionUnavailable)
        }
        "claude_native_response_invalid" => Some(ClaudeNativeFailure::ResponseInvalid),
        _ => None,
    }
}

/// Consume one Claude Code status-line JSON object, retain only the documented
/// rate-limit fields, and atomically replace TokenLedger's normalized snapshot.
/// The returned text is safe to print as the user's status line. When the
/// one-click setup chained an original status line (U-106), that command gets
/// the same stdin after the snapshot is recorded and its stdout is returned.
pub fn run_claude_statusline_helper() -> Result<String, &'static str> {
    let app = crate::app_paths::AppContext::new();
    let mut input = Vec::new();
    let read_ok = io::stdin()
        .take((claude_setup::MAX_CHAIN_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .is_ok();
    claude_statusline_output(app.app_data_dir(), &input, read_ok, |input| {
        record_claude_statusline(&app, input)
    })
}

fn claude_statusline_output(
    app_data_dir: &Path,
    input: &[u8],
    read_ok: bool,
    record: impl FnOnce(&[u8]) -> Result<String, &'static str>,
) -> Result<String, &'static str> {
    let recorded = if read_ok {
        record(input)
    } else {
        Err("claude_statusline_input_unavailable")
    };
    match claude_setup::chained_command(app_data_dir) {
        Some(command) if read_ok && input.len() <= claude_setup::MAX_CHAIN_INPUT_BYTES => {
            Ok(claude_setup::chained_output(&command, input))
        }
        Some(_) => Ok(String::new()),
        None => recorded,
    }
}

fn record_claude_statusline(
    app: &crate::app_paths::AppContext,
    input: &[u8],
) -> Result<String, &'static str> {
    let settings = crate::settings::load_settings(app);
    if !settings.quota_claude_statusline_enabled {
        clear_disabled_provider_data(
            app.app_data_dir(),
            settings.quota_codex_local_enabled,
            false,
            settings.quota_claude_codexbar_enabled,
            settings.quota_antigravity_local_enabled,
            settings.quota_antigravity_codexbar_enabled,
        );
        return Ok("Claude quota disabled".to_string());
    }
    if input.len() > MAX_CLAUDE_INPUT_BYTES {
        return Err("claude_statusline_input_invalid");
    }
    let display = process_claude_statusline_input(input, app.app_data_dir(), Utc::now())
        .map_err(|_| "claude_statusline_snapshot_not_updated")?;
    let current = crate::settings::load_settings(app);
    if !current.quota_claude_statusline_enabled {
        clear_disabled_provider_data(
            app.app_data_dir(),
            current.quota_codex_local_enabled,
            false,
            current.quota_claude_codexbar_enabled,
            current.quota_antigravity_local_enabled,
            current.quota_antigravity_codexbar_enabled,
        );
        return Ok("Claude quota disabled".to_string());
    }
    Ok(display)
}

fn process_claude_statusline_input(
    input: &[u8],
    app_data_dir: &Path,
    observed_at: DateTime<Utc>,
) -> Result<String, SnapshotFailure> {
    if input.len() > MAX_CLAUDE_INPUT_BYTES {
        return Err(SnapshotFailure::Invalid);
    }
    let snapshot = parse_claude_statusline_input(input, observed_at)?;
    let display = claude_statusline_display(&snapshot);
    let bytes = serde_json::to_vec(&snapshot).map_err(|_| SnapshotFailure::Invalid)?;
    let _persistence = persistence_guard();
    atomic_write_private(app_data_dir, CLAUDE_STATUSLINE_FILE, &bytes)?;
    Ok(display)
}

fn parse_claude_statusline_input(
    input: &[u8],
    observed_at: DateTime<Utc>,
) -> Result<ClaudeStatuslineSnapshot, SnapshotFailure> {
    let raw: RawClaudeStatuslineInput =
        serde_json::from_slice(input).map_err(|_| SnapshotFailure::Invalid)?;
    let mut windows = Vec::with_capacity(2);
    if let Some(window) = raw.rate_limits.five_hour {
        windows.push(normalize_claude_statusline_window(
            "five-hour",
            window,
            observed_at,
            CLAUDE_FIVE_HOUR_MAX_RESET_SECONDS,
        )?);
    }
    if let Some(window) = raw.rate_limits.seven_day {
        windows.push(normalize_claude_statusline_window(
            "seven-day",
            window,
            observed_at,
            CLAUDE_SEVEN_DAY_MAX_RESET_SECONDS,
        )?);
    }
    if windows.is_empty() {
        return Err(SnapshotFailure::Invalid);
    }
    Ok(ClaudeStatuslineSnapshot {
        schema_version: 1,
        observed_at: format_timestamp(observed_at),
        windows,
    })
}

fn normalize_claude_statusline_window(
    window_id: &str,
    raw: RawClaudeWindow,
    observed_at: DateTime<Utc>,
    max_reset_seconds: i64,
) -> Result<ClaudeStatuslineWindow, SnapshotFailure> {
    if !raw.used_percentage.is_finite() || !(0.0..=100.0).contains(&raw.used_percentage) {
        return Err(SnapshotFailure::Invalid);
    }
    let resets_at = parse_timestamp(&raw.resets_at).ok_or(SnapshotFailure::Invalid)?;
    let earliest = observed_at
        .checked_sub_signed(chrono::Duration::seconds(MAX_FUTURE_CLOCK_SKEW_SECONDS))
        .ok_or(SnapshotFailure::Invalid)?;
    let latest = observed_at
        .checked_add_signed(chrono::Duration::seconds(max_reset_seconds))
        .ok_or(SnapshotFailure::Invalid)?;
    if resets_at < earliest || resets_at > latest {
        return Err(SnapshotFailure::Invalid);
    }
    Ok(ClaudeStatuslineWindow {
        window_id: window_id.to_string(),
        used_percent: raw.used_percentage,
        resets_at: format_timestamp(resets_at),
    })
}

fn claude_statusline_display(snapshot: &ClaudeStatuslineSnapshot) -> String {
    let parts = snapshot
        .windows
        .iter()
        .map(|window| {
            let label = if window.window_id == "five-hour" {
                "5h"
            } else {
                "7d"
            };
            format!("{label} {:.0}%", window.used_percent)
        })
        .collect::<Vec<_>>();
    format!("Claude {}", parts.join(" · "))
}

fn claude_authorization_required() -> QuotaProviderEnvelope {
    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: CLAUDE_PROVIDER_ID.to_string(),
        display_name: "Claude consumer usage".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::PlanDependent,
        status: QuotaStatus::AuthRequired,
        windows: Vec::new(),
        reason_code: Some("claude_local_authorization_required".to_string()),
        action: Some(QuotaAction {
            kind: QuotaActionKind::OpenSettings,
            label_key: "quota.action.enableClaudeLocal".to_string(),
            value: "claude-local".to_string(),
        }),
    }
}

fn claude_fallback_cli_error(reason_code: &str) -> QuotaProviderEnvelope {
    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: CLAUDE_PROVIDER_ID.to_string(),
        display_name: "Claude consumer usage".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::Experimental,
        status: QuotaStatus::Error,
        windows: Vec::new(),
        reason_code: Some(reason_code.to_string()),
        action: Some(QuotaAction {
            kind: QuotaActionKind::OpenSettings,
            label_key: "quota.action.reviewClaudeCodexBar".to_string(),
            value: "claude-local".to_string(),
        }),
    }
}

fn claude_native_error(failure: ClaudeNativeFailure) -> QuotaProviderEnvelope {
    claude_native_error_code(failure.reason_code())
}

fn claude_native_error_code(reason_code: &str) -> QuotaProviderEnvelope {
    let auth_required = reason_code == "claude_native_authorization_required";
    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: CLAUDE_PROVIDER_ID.to_string(),
        display_name: "Claude consumer usage".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::Experimental,
        status: if auth_required {
            QuotaStatus::AuthRequired
        } else {
            QuotaStatus::Error
        },
        windows: Vec::new(),
        reason_code: Some(reason_code.to_string()),
        action: Some(QuotaAction {
            kind: QuotaActionKind::OpenSettings,
            label_key: "quota.action.reviewClaudeNative".to_string(),
            value: "claude-local".to_string(),
        }),
    }
}

fn claude_error(reason_code: &str) -> QuotaProviderEnvelope {
    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: CLAUDE_PROVIDER_ID.to_string(),
        display_name: "Claude consumer usage".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::PlanDependent,
        status: QuotaStatus::Error,
        windows: Vec::new(),
        reason_code: Some(reason_code.to_string()),
        action: Some(QuotaAction {
            kind: QuotaActionKind::OpenSettings,
            label_key: "quota.action.reviewClaudeStatusline".to_string(),
            value: "claude-statusline".to_string(),
        }),
    }
}

fn claude_envelope_from_app_data(
    app_data_dir: &Path,
    fetched_at: DateTime<Utc>,
) -> QuotaProviderEnvelope {
    match read_claude_statusline_snapshot(app_data_dir, fetched_at) {
        Ok(snapshot) => claude_envelope_from_snapshot(snapshot, fetched_at),
        Err(SnapshotFailure::Missing) => claude_error("claude_statusline_snapshot_missing"),
        Err(SnapshotFailure::Invalid) => claude_error("claude_statusline_snapshot_invalid"),
    }
}

fn read_claude_statusline_snapshot(
    app_data_dir: &Path,
    now: DateTime<Utc>,
) -> Result<ClaudeStatuslineSnapshot, SnapshotFailure> {
    let bytes = read_bounded_private_file(
        app_data_dir,
        CLAUDE_STATUSLINE_FILE,
        MAX_CLAUDE_SNAPSHOT_BYTES,
    )?;
    let snapshot: ClaudeStatuslineSnapshot =
        serde_json::from_slice(&bytes).map_err(|_| SnapshotFailure::Invalid)?;
    if snapshot.schema_version != 1 || snapshot.windows.is_empty() || snapshot.windows.len() > 2 {
        return Err(SnapshotFailure::Invalid);
    }
    let observed_at = DateTime::parse_from_rfc3339(&snapshot.observed_at)
        .map_err(|_| SnapshotFailure::Invalid)?
        .with_timezone(&Utc);
    let future_limit = now
        .checked_add_signed(chrono::Duration::seconds(MAX_FUTURE_CLOCK_SKEW_SECONDS))
        .ok_or(SnapshotFailure::Invalid)?;
    if observed_at > future_limit
        || now.signed_duration_since(observed_at).num_seconds()
            > LAST_GOOD_RETENTION.as_secs() as i64
    {
        return Err(SnapshotFailure::Invalid);
    }
    let mut seen = std::collections::HashSet::new();
    for window in &snapshot.windows {
        if !matches!(window.window_id.as_str(), "five-hour" | "seven-day")
            || !seen.insert(window.window_id.as_str())
            || !window.used_percent.is_finite()
            || !(0.0..=100.0).contains(&window.used_percent)
        {
            return Err(SnapshotFailure::Invalid);
        }
        let reset = DateTime::parse_from_rfc3339(&window.resets_at)
            .map_err(|_| SnapshotFailure::Invalid)?
            .with_timezone(&Utc);
        let max_seconds = if window.window_id == "five-hour" {
            CLAUDE_FIVE_HOUR_MAX_RESET_SECONDS
        } else {
            CLAUDE_SEVEN_DAY_MAX_RESET_SECONDS
        };
        let latest_reset = observed_at
            .checked_add_signed(chrono::Duration::seconds(max_seconds))
            .ok_or(SnapshotFailure::Invalid)?;
        let earliest_reset = observed_at
            .checked_sub_signed(chrono::Duration::seconds(MAX_FUTURE_CLOCK_SKEW_SECONDS))
            .ok_or(SnapshotFailure::Invalid)?;
        if reset < earliest_reset || reset > latest_reset {
            return Err(SnapshotFailure::Invalid);
        }
    }
    Ok(snapshot)
}

fn claude_envelope_from_snapshot(
    snapshot: ClaudeStatuslineSnapshot,
    fetched_at: DateTime<Utc>,
) -> QuotaProviderEnvelope {
    let observed_at = DateTime::parse_from_rfc3339(&snapshot.observed_at)
        .expect("validated Claude snapshot timestamp")
        .with_timezone(&Utc);
    let observation_stale =
        fetched_at.signed_duration_since(observed_at).num_seconds() > STALE_AFTER_SECONDS;
    let fetched_at_text = format_timestamp(fetched_at);
    let mut any_stale = observation_stale;
    let windows = snapshot
        .windows
        .into_iter()
        .map(|window| {
            let reset_stale = DateTime::parse_from_rfc3339(&window.resets_at)
                .map(|reset| reset.with_timezone(&Utc) <= fetched_at)
                .unwrap_or(true);
            let stale = observation_stale || reset_stale;
            any_stale |= stale;
            QuotaWindowSnapshot {
                provider_id: CLAUDE_PROVIDER_ID.to_string(),
                window_id: window.window_id.clone(),
                window_label: if window.window_id == "five-hour" {
                    "5-hour".to_string()
                } else {
                    "7-day".to_string()
                },
                account_label: None,
                scope: QuotaScope::ConsumerSubscription,
                source: QuotaSource::LocalAuthorized,
                status: if stale {
                    QuotaWindowStatus::Stale
                } else {
                    QuotaWindowStatus::Ok
                },
                used: Some(window.used_percent),
                limit: Some(100.0),
                remaining: Some(100.0 - window.used_percent),
                unit: QuotaUnit::Percent,
                currency: None,
                window_minutes: Some(if window.window_id == "five-hour" {
                    5 * 60
                } else {
                    7 * 24 * 60
                }),
                resets_at: Some(window.resets_at),
                observed_at: snapshot.observed_at.clone(),
                fetched_at: fetched_at_text.clone(),
                stale_after_seconds: STALE_AFTER_SECONDS as u64,
                reason_code: stale.then(|| "observation_stale".to_string()),
            }
        })
        .collect();
    QuotaProviderEnvelope {
        schema_version: 1,
        provider_id: CLAUDE_PROVIDER_ID.to_string(),
        display_name: "Claude consumer usage".to_string(),
        scope: QuotaScope::ConsumerSubscription,
        mode: QuotaMode::Automatic,
        capability: QuotaCapability::PlanDependent,
        status: if any_stale {
            QuotaStatus::Stale
        } else {
            QuotaStatus::Ok
        },
        windows,
        reason_code: any_stale.then(|| "observation_stale".to_string()),
        action: None,
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedEnvelope {
    schema_version: u8,
    stored_at: String,
    envelope: QuotaProviderEnvelope,
}

fn finalize_with_persisted_last_good(
    app_data_dir: &Path,
    file_name: &str,
    provider_id: &str,
    envelope: QuotaProviderEnvelope,
    now: DateTime<Utc>,
) -> QuotaProviderEnvelope {
    let _persistence = persistence_guard();
    if is_direct_source_observation(&envelope) {
        let _ = persist_last_good(app_data_dir, file_name, &envelope, now);
        return envelope;
    }
    if !envelope.windows.is_empty() {
        return envelope;
    }
    let reason_code = envelope
        .reason_code
        .as_deref()
        .unwrap_or("source_temporarily_unavailable");
    read_persisted_last_good(app_data_dir, file_name, provider_id, now)
        .map(|last_good| stale_from_last_good(&last_good, reason_code, now))
        .unwrap_or(envelope)
}

fn is_direct_source_observation(envelope: &QuotaProviderEnvelope) -> bool {
    !envelope.windows.is_empty() && envelope.status == QuotaStatus::Ok
}

fn persist_last_good(
    app_data_dir: &Path,
    file_name: &str,
    envelope: &QuotaProviderEnvelope,
    now: DateTime<Utc>,
) -> Result<(), SnapshotFailure> {
    let mut envelope = envelope.clone();
    envelope.action = None;
    let persisted = PersistedEnvelope {
        schema_version: 1,
        stored_at: format_timestamp(now),
        envelope,
    };
    let bytes = serde_json::to_vec(&persisted).map_err(|_| SnapshotFailure::Invalid)?;
    if bytes.len() > MAX_PERSISTED_ENVELOPE_BYTES {
        return Err(SnapshotFailure::Invalid);
    }
    atomic_write_private(app_data_dir, file_name, &bytes)
}

fn read_persisted_last_good(
    app_data_dir: &Path,
    file_name: &str,
    provider_id: &str,
    now: DateTime<Utc>,
) -> Result<QuotaProviderEnvelope, SnapshotFailure> {
    let bytes = read_bounded_private_file(app_data_dir, file_name, MAX_PERSISTED_ENVELOPE_BYTES)?;
    let persisted: PersistedEnvelope =
        serde_json::from_slice(&bytes).map_err(|_| SnapshotFailure::Invalid)?;
    if persisted.schema_version != 1 {
        return Err(SnapshotFailure::Invalid);
    }
    let stored_at = DateTime::parse_from_rfc3339(&persisted.stored_at)
        .map_err(|_| SnapshotFailure::Invalid)?
        .with_timezone(&Utc);
    let future_limit = now
        .checked_add_signed(chrono::Duration::seconds(MAX_FUTURE_CLOCK_SKEW_SECONDS))
        .ok_or(SnapshotFailure::Invalid)?;
    if stored_at > future_limit
        || now.signed_duration_since(stored_at).num_seconds() > LAST_GOOD_RETENTION.as_secs() as i64
        || !validate_persisted_envelope(&persisted.envelope, provider_id, now)
    {
        return Err(SnapshotFailure::Invalid);
    }
    Ok(persisted.envelope)
}

fn validate_persisted_envelope(
    envelope: &QuotaProviderEnvelope,
    provider_id: &str,
    now: DateTime<Utc>,
) -> bool {
    let is_api_organization = custom::config_id_from_provider_id(provider_id).is_some()
        || balance::is_balance_provider_id(provider_id);
    let expected_scope = if is_api_organization {
        QuotaScope::ApiOrganization
    } else {
        QuotaScope::ConsumerSubscription
    };
    let expected_source = if is_api_organization {
        QuotaSource::OfficialApi
    } else {
        QuotaSource::LocalAuthorized
    };
    if envelope.schema_version != 1
        || envelope.provider_id != provider_id
        || envelope.scope != expected_scope
        || envelope.mode != QuotaMode::Automatic
        || envelope.windows.is_empty()
        || envelope.windows.len() > 32
        || envelope.action.is_some()
        || !matches!(envelope.status, QuotaStatus::Ok | QuotaStatus::Stale)
    {
        return false;
    }
    envelope.windows.iter().all(|window| {
        window.provider_id == provider_id
            && window.scope == expected_scope
            && window.source == expected_source
            && sanitize_stable_window_id(&window.window_id)
            && window.window_label.len() <= 128
            && window
                .account_label
                .as_deref()
                .is_none_or(|label| sanitize_plan_type(Some(label)).as_deref() == Some(label))
            && valid_optional_number(window.used)
            && valid_optional_number(window.limit)
            && valid_optional_number(window.remaining)
            && currency_fields_valid(
                window.unit,
                window.currency.as_deref(),
                window.window_minutes,
                window.resets_at.as_deref(),
                window.reason_code.as_deref(),
            )
            && (window.unit != QuotaUnit::Percent
                || matches!(
                    (window.used, window.limit, window.remaining),
                    (Some(used), Some(limit), Some(remaining))
                        if (0.0..=100.0).contains(&used)
                            && (limit - 100.0).abs() < f64::EPSILON
                            && (remaining - (100.0 - used)).abs() < 0.000_001
                ))
            && valid_persisted_timestamp(&window.observed_at, now, MAX_FUTURE_CLOCK_SKEW_SECONDS)
            && valid_persisted_timestamp(&window.fetched_at, now, MAX_FUTURE_CLOCK_SKEW_SECONDS)
            && window.resets_at.as_deref().is_none_or(|timestamp| {
                valid_persisted_timestamp(timestamp, now, CLAUDE_SEVEN_DAY_MAX_RESET_SECONDS)
            })
            && window.stale_after_seconds > 0
            && window.stale_after_seconds <= LAST_GOOD_RETENTION.as_secs()
    })
}

fn sanitize_stable_window_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_:.".contains(character))
}

fn valid_optional_number(value: Option<f64>) -> bool {
    value.is_none_or(|value| value.is_finite() && value >= 0.0)
}

fn valid_persisted_timestamp(value: &str, now: DateTime<Utc>, max_future_seconds: i64) -> bool {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| {
            let timestamp = timestamp.with_timezone(&Utc);
            timestamp
                <= now
                    .checked_add_signed(chrono::Duration::seconds(max_future_seconds))
                    .unwrap_or(now)
                && now.signed_duration_since(timestamp).num_seconds()
                    <= LAST_GOOD_RETENTION.as_secs() as i64
        })
        .unwrap_or(false)
}

fn secure_app_data_root(app_data_dir: &Path, create: bool) -> Result<PathBuf, SnapshotFailure> {
    if create {
        fs::create_dir_all(app_data_dir).map_err(|_| SnapshotFailure::Invalid)?;
    }
    let metadata = fs::symlink_metadata(app_data_dir).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            SnapshotFailure::Missing
        } else {
            SnapshotFailure::Invalid
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(SnapshotFailure::Invalid);
    }
    fs::canonicalize(app_data_dir).map_err(|_| SnapshotFailure::Invalid)
}

fn secure_snapshot_path(
    app_data_dir: &Path,
    file_name: &str,
    create_root: bool,
) -> Result<(PathBuf, PathBuf), SnapshotFailure> {
    if file_name.is_empty()
        || file_name.len() > 96
        || !file_name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return Err(SnapshotFailure::Invalid);
    }
    let root = secure_app_data_root(app_data_dir, create_root)?;
    Ok((root.join(file_name), root))
}

fn read_bounded_private_file(
    app_data_dir: &Path,
    file_name: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, SnapshotFailure> {
    let (path, root) = secure_snapshot_path(app_data_dir, file_name, false)?;
    let before = fs::symlink_metadata(&path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            SnapshotFailure::Missing
        } else {
            SnapshotFailure::Invalid
        }
    })?;
    if before.file_type().is_symlink() || !before.is_file() || before.len() > max_bytes as u64 {
        return Err(SnapshotFailure::Invalid);
    }
    let canonical = fs::canonicalize(&path).map_err(|_| SnapshotFailure::Invalid)?;
    if canonical.parent() != Some(root.as_path()) {
        return Err(SnapshotFailure::Invalid);
    }
    let mut file = File::open(&path).map_err(|_| SnapshotFailure::Invalid)?;
    let opened = file.metadata().map_err(|_| SnapshotFailure::Invalid)?;
    if !same_object_identity(&before, &opened) {
        return Err(SnapshotFailure::Invalid);
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    Read::by_ref(&mut file)
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| SnapshotFailure::Invalid)?;
    let after = file.metadata().map_err(|_| SnapshotFailure::Invalid)?;
    let path_after = fs::symlink_metadata(&path).map_err(|_| SnapshotFailure::Invalid)?;
    if bytes.len() > max_bytes
        || !same_object_identity(&opened, &after)
        || !same_object_identity(&after, &path_after)
    {
        return Err(SnapshotFailure::Invalid);
    }
    Ok(bytes)
}

fn atomic_write_private(
    app_data_dir: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<(), SnapshotFailure> {
    let (target, root) = secure_snapshot_path(app_data_dir, file_name, true)?;
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(SnapshotFailure::Invalid);
        }
    }

    let mut temp = None;
    let mut file = None;
    for _ in 0..8 {
        let counter = ATOMIC_FILE_COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
        let candidate = root.join(format!(
            ".{file_name}.tmp.{}.{}",
            std::process::id(),
            counter
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(opened) => {
                temp = Some(candidate);
                file = Some(opened);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(SnapshotFailure::Invalid),
        }
    }
    let temp = temp.ok_or(SnapshotFailure::Invalid)?;
    let result = (|| {
        let mut file = file.ok_or(SnapshotFailure::Invalid)?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| SnapshotFailure::Invalid)?;
        drop(file);
        atomic_replace(&temp, &target)?;
        #[cfg(unix)]
        File::open(&root)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| SnapshotFailure::Invalid)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub(crate) fn write_private_app_data_file(
    app_data_dir: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    atomic_write_private(app_data_dir, file_name, bytes)
        .map_err(|_| "Unable to save app settings safely.".to_string())
}

pub(crate) fn read_private_app_data_file(
    app_data_dir: &Path,
    file_name: &str,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, String> {
    match read_bounded_private_file(app_data_dir, file_name, max_bytes) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(SnapshotFailure::Missing) => Ok(None),
        Err(_) => Err("Unable to read private app data safely.".to_string()),
    }
}

pub(crate) fn remove_private_app_data_file(app_data_dir: &Path, file_name: &str) {
    remove_persisted_snapshot(app_data_dir, file_name);
}

/// Same removal, but reports failure instead of swallowing it.
///
/// Best-effort deletion is fine for caches that will simply be rebuilt. It is
/// not fine for a file that *gates* behaviour: the Keychain failure marker
/// suppresses every background read until it is deleted, so a silent failure
/// leaves the user pressing a retry button that can never work, with nothing
/// on screen to explain why.
pub(crate) fn remove_private_app_data_file_checked(
    app_data_dir: &Path,
    file_name: &str,
) -> Result<(), String> {
    let (path, _) = secure_snapshot_path(app_data_dir, file_name, false)
        .map_err(|_| "Unable to resolve private app data path safely.".to_string())?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
            fs::remove_file(&path).map_err(|error| error.to_string())
        }
        // Nothing to remove is the desired end state, not a failure.
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), SnapshotFailure> {
    fs::rename(source, target).map_err(|_| SnapshotFailure::Invalid)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), SnapshotFailure> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    (replaced != 0)
        .then_some(())
        .ok_or(SnapshotFailure::Invalid)
}

fn remove_persisted_snapshot(app_data_dir: &Path, file_name: &str) {
    let Ok((path, _)) = secure_snapshot_path(app_data_dir, file_name, false) else {
        return;
    };
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.is_file() || metadata.file_type().is_symlink() {
            let _ = fs::remove_file(path);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScanFailure {
    AppServerUnavailable,
    AppServerTimeout,
    AppServerAuthRequired,
    SourceNotFound,
    PermissionDenied,
    SourceSchemaUnsupported,
    SourceScanTruncated,
    SourceTemporarilyUnavailable,
    ProviderWorkerFailed,
}

impl ScanFailure {
    fn reason_code(&self) -> &'static str {
        match self {
            Self::AppServerUnavailable => "app_server_unavailable",
            Self::AppServerTimeout => "app_server_timeout",
            Self::AppServerAuthRequired => "app_server_auth_required",
            Self::SourceNotFound => "source_not_found",
            Self::PermissionDenied => "permission_denied",
            Self::SourceSchemaUnsupported => "source_schema_unsupported",
            Self::SourceScanTruncated => "source_scan_truncated",
            Self::SourceTemporarilyUnavailable => "source_temporarily_unavailable",
            Self::ProviderWorkerFailed => "provider_worker_failed",
        }
    }
}

fn root_io_failure(error: &io::Error) -> ScanFailure {
    if error.kind() == io::ErrorKind::PermissionDenied {
        ScanFailure::PermissionDenied
    } else {
        ScanFailure::SourceNotFound
    }
}

fn runtime_io_failure(error: &io::Error) -> ScanFailure {
    if error.kind() == io::ErrorKind::PermissionDenied {
        ScanFailure::PermissionDenied
    } else {
        ScanFailure::SourceTemporarilyUnavailable
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
    length: u64,
    modified: SystemTime,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl FileIdentity {
    fn from_metadata(metadata: &Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;

        Self {
            length: metadata.len(),
            modified: metadata.modified().unwrap_or(UNIX_EPOCH),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        }
    }
}

fn same_object_identity(left: &Metadata, right: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(not(unix))]
    {
        left.file_type() == right.file_type()
            && left.len() == right.len()
            && left.modified().ok() == right.modified().ok()
    }
}

#[derive(Debug, Eq, PartialEq)]
struct SessionFile {
    path: PathBuf,
    canonical_path: PathBuf,
    identity: FileIdentity,
    modified: SystemTime,
}

impl Ord for SessionFile {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reverse the desired newest-first ordering so BinaryHeap::pop removes
        // the oldest retained candidate when the bounded heap overflows.
        other
            .modified
            .cmp(&self.modified)
            .then_with(|| other.canonical_path.cmp(&self.canonical_path))
    }
}

impl PartialOrd for SessionFile {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Eq, PartialEq)]
struct DirectoryCandidate {
    path: PathBuf,
    depth: usize,
    modified: SystemTime,
}

impl Ord for DirectoryCandidate {
    fn cmp(&self, other: &Self) -> Ordering {
        self.modified
            .cmp(&other.modified)
            .then_with(|| self.path.cmp(&other.path))
    }
}

impl PartialOrd for DirectoryCandidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn canonical_sessions_root(root: &Path) -> Result<PathBuf, ScanFailure> {
    let root = fs::canonicalize(root).map_err(|error| root_io_failure(&error))?;
    let root_metadata = fs::metadata(&root).map_err(|error| root_io_failure(&error))?;
    if !root_metadata.is_dir() {
        return Err(ScanFailure::SourceNotFound);
    }

    let sessions_path = root.join("sessions");
    let sessions_link_metadata =
        fs::symlink_metadata(&sessions_path).map_err(|error| root_io_failure(&error))?;
    if sessions_link_metadata.file_type().is_symlink() || !sessions_link_metadata.is_dir() {
        return Err(ScanFailure::SourceNotFound);
    }

    let sessions = fs::canonicalize(&sessions_path).map_err(|error| root_io_failure(&error))?;
    if !sessions.starts_with(&root) {
        return Err(ScanFailure::SourceNotFound);
    }
    let canonical_metadata =
        fs::symlink_metadata(&sessions).map_err(|error| root_io_failure(&error))?;
    if canonical_metadata.file_type().is_symlink()
        || !canonical_metadata.is_dir()
        || !same_object_identity(&sessions_link_metadata, &canonical_metadata)
    {
        return Err(ScanFailure::SourceNotFound);
    }
    Ok(sessions)
}

fn checked_directory_entries(
    directory: &Path,
    sessions_root: &Path,
) -> Result<fs::ReadDir, ScanFailure> {
    let before = fs::symlink_metadata(directory).map_err(|error| runtime_io_failure(&error))?;
    if before.file_type().is_symlink() || !before.is_dir() {
        return Err(ScanFailure::SourceTemporarilyUnavailable);
    }
    let canonical = fs::canonicalize(directory).map_err(|error| runtime_io_failure(&error))?;
    if canonical != directory || !canonical.starts_with(sessions_root) {
        return Err(ScanFailure::SourceTemporarilyUnavailable);
    }

    let entries = fs::read_dir(directory).map_err(|error| runtime_io_failure(&error))?;

    let after = fs::symlink_metadata(directory).map_err(|error| runtime_io_failure(&error))?;
    let canonical_after =
        fs::canonicalize(directory).map_err(|error| runtime_io_failure(&error))?;
    if after.file_type().is_symlink()
        || !after.is_dir()
        || !same_object_identity(&before, &after)
        || canonical_after != canonical
        || !canonical_after.starts_with(sessions_root)
    {
        return Err(ScanFailure::SourceTemporarilyUnavailable);
    }
    Ok(entries)
}

fn collect_session_files(
    sessions_root: &Path,
    limits: ScanLimits,
    started_at: Instant,
) -> Result<Vec<SessionFile>, ScanFailure> {
    let root_metadata =
        fs::symlink_metadata(sessions_root).map_err(|error| runtime_io_failure(&error))?;
    let mut directories = BinaryHeap::new();
    directories.push(DirectoryCandidate {
        path: sessions_root.to_path_buf(),
        depth: 0,
        modified: root_metadata.modified().unwrap_or(UNIX_EPOCH),
    });

    let mut files = BinaryHeap::new();
    let mut entries_seen = 0usize;

    while let Some(directory) = directories.pop() {
        if started_at.elapsed() >= limits.max_scan_duration {
            return Err(ScanFailure::SourceScanTruncated);
        }
        let entries = checked_directory_entries(&directory.path, sessions_root)?;
        for entry in entries {
            if started_at.elapsed() >= limits.max_scan_duration
                || entries_seen >= limits.max_directory_entries
            {
                return Err(ScanFailure::SourceScanTruncated);
            }
            entries_seen += 1;

            let entry = entry.map_err(|error| runtime_io_failure(&error))?;
            let file_type = entry
                .file_type()
                .map_err(|error| runtime_io_failure(&error))?;
            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();
            let before = fs::symlink_metadata(&path).map_err(|error| runtime_io_failure(&error))?;
            if before.file_type().is_symlink() {
                continue;
            }

            if file_type.is_dir() {
                if !before.is_dir() {
                    return Err(ScanFailure::SourceTemporarilyUnavailable);
                }
                if directory.depth >= limits.max_directory_depth {
                    return Err(ScanFailure::SourceScanTruncated);
                }
                let canonical =
                    fs::canonicalize(&path).map_err(|error| runtime_io_failure(&error))?;
                if !canonical.starts_with(sessions_root) {
                    return Err(ScanFailure::SourceTemporarilyUnavailable);
                }
                let after =
                    fs::symlink_metadata(&path).map_err(|error| runtime_io_failure(&error))?;
                let canonical_after =
                    fs::canonicalize(&path).map_err(|error| runtime_io_failure(&error))?;
                if after.file_type().is_symlink()
                    || !after.is_dir()
                    || !same_object_identity(&before, &after)
                    || canonical_after != canonical
                {
                    return Err(ScanFailure::SourceTemporarilyUnavailable);
                }
                directories.push(DirectoryCandidate {
                    path: canonical,
                    depth: directory.depth + 1,
                    modified: after.modified().unwrap_or(UNIX_EPOCH),
                });
                continue;
            }

            if !file_type.is_file()
                || !path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
            {
                continue;
            }
            if !before.is_file() {
                return Err(ScanFailure::SourceTemporarilyUnavailable);
            }

            let canonical = fs::canonicalize(&path).map_err(|error| runtime_io_failure(&error))?;
            if !canonical.starts_with(sessions_root) {
                return Err(ScanFailure::SourceTemporarilyUnavailable);
            }
            let after = fs::symlink_metadata(&path).map_err(|error| runtime_io_failure(&error))?;
            let canonical_after =
                fs::canonicalize(&path).map_err(|error| runtime_io_failure(&error))?;
            if after.file_type().is_symlink()
                || !after.is_file()
                || !same_object_identity(&before, &after)
                || canonical_after != canonical
            {
                return Err(ScanFailure::SourceTemporarilyUnavailable);
            }

            let identity = FileIdentity::from_metadata(&after);
            files.push(SessionFile {
                path,
                canonical_path: canonical,
                modified: identity.modified,
                identity,
            });
            if files.len() > limits.max_session_files {
                files.pop();
            }
        }
    }

    let mut files = files.into_vec();
    files.sort_by(|left, right| {
        right
            .modified
            .cmp(&left.modified)
            .then_with(|| right.canonical_path.cmp(&left.canonical_path))
    });
    Ok(files)
}

struct TailRead {
    bytes: Vec<u8>,
    parse_start: usize,
}

fn validate_session_file(
    session_file: &SessionFile,
    sessions_root: &Path,
) -> Result<Metadata, ScanFailure> {
    let metadata =
        fs::symlink_metadata(&session_file.path).map_err(|error| runtime_io_failure(&error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ScanFailure::SourceTemporarilyUnavailable);
    }
    let canonical =
        fs::canonicalize(&session_file.path).map_err(|error| runtime_io_failure(&error))?;
    if canonical != session_file.canonical_path || !canonical.starts_with(sessions_root) {
        return Err(ScanFailure::SourceTemporarilyUnavailable);
    }
    if FileIdentity::from_metadata(&metadata) != session_file.identity {
        return Err(ScanFailure::SourceTemporarilyUnavailable);
    }
    Ok(metadata)
}

fn read_bounded_tail(
    session_file: &SessionFile,
    sessions_root: &Path,
    limits: ScanLimits,
) -> Result<TailRead, ScanFailure> {
    let before = validate_session_file(session_file, sessions_root)?;
    let mut file = File::open(&session_file.path).map_err(|error| runtime_io_failure(&error))?;
    let opened = file
        .metadata()
        .map_err(|error| runtime_io_failure(&error))?;
    if !same_object_identity(&before, &opened)
        || FileIdentity::from_metadata(&opened) != session_file.identity
    {
        return Err(ScanFailure::SourceTemporarilyUnavailable);
    }
    let after_open = validate_session_file(session_file, sessions_root)?;
    if !same_object_identity(&opened, &after_open) {
        return Err(ScanFailure::SourceTemporarilyUnavailable);
    }

    let file_length = opened.len();
    let read_length = min(file_length, limits.max_file_tail_bytes as u64);
    let offset = file_length.saturating_sub(read_length);
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| runtime_io_failure(&error))?;

    let mut bytes = Vec::with_capacity(read_length as usize);
    Read::by_ref(&mut file)
        .take(read_length)
        .read_to_end(&mut bytes)
        .map_err(|error| runtime_io_failure(&error))?;

    let after_read = file
        .metadata()
        .map_err(|error| runtime_io_failure(&error))?;
    if FileIdentity::from_metadata(&after_read) != session_file.identity {
        return Err(ScanFailure::SourceTemporarilyUnavailable);
    }
    let final_path_metadata = validate_session_file(session_file, sessions_root)?;
    if !same_object_identity(&after_read, &final_path_metadata) {
        return Err(ScanFailure::SourceTemporarilyUnavailable);
    }

    let parse_start = if offset == 0 {
        0
    } else {
        bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |index| index + 1)
    };
    Ok(TailRead { bytes, parse_start })
}

fn scan_latest_rate_limit_event(
    root: &Path,
    scan_started_at: DateTime<Utc>,
    limits: ScanLimits,
) -> Result<NormalizedEvent, ScanFailure> {
    let started_at = Instant::now();
    let sessions_root = canonical_sessions_root(root)?;
    let files = collect_session_files(&sessions_root, limits, started_at)?;
    if files.is_empty() {
        return Err(ScanFailure::SourceNotFound);
    }

    let latest_allowed = scan_started_at
        .checked_add_signed(chrono::Duration::seconds(MAX_FUTURE_CLOCK_SKEW_SECONDS))
        .unwrap_or(scan_started_at);
    let mut total_read = 0usize;
    let mut filtered_lines = 0usize;
    let mut saw_rate_limits = false;
    let mut latest: Option<NormalizedEvent> = None;

    for session_file in files {
        if started_at.elapsed() >= limits.max_scan_duration {
            return Err(ScanFailure::SourceScanTruncated);
        }
        let planned_read = usize::try_from(session_file.identity.length)
            .map(|length| min(length, limits.max_file_tail_bytes))
            .unwrap_or(limits.max_file_tail_bytes);
        if total_read
            .checked_add(planned_read)
            .is_none_or(|total| total > limits.max_total_read_bytes)
        {
            return Err(ScanFailure::SourceScanTruncated);
        }

        let tail = read_bounded_tail(&session_file, &sessions_root, limits)?;
        total_read += tail.bytes.len();

        for line in tail.bytes[tail.parse_start..]
            .split(|byte| *byte == b'\n')
            .rev()
        {
            if started_at.elapsed() >= limits.max_scan_duration {
                return Err(ScanFailure::SourceScanTruncated);
            }
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if line.is_empty()
                || line.len() > limits.max_line_bytes
                || !contains_bytes(line, b"\"rate_limits\"")
            {
                continue;
            }
            if filtered_lines >= limits.max_filtered_lines {
                return Err(ScanFailure::SourceScanTruncated);
            }

            saw_rate_limits = true;
            filtered_lines += 1;
            let Some(event) = parse_rate_limit_event(line, scan_started_at) else {
                continue;
            };
            if event.observed_at > latest_allowed {
                continue;
            }
            if latest
                .as_ref()
                .is_none_or(|current| event.observed_at > current.observed_at)
            {
                latest = Some(event);
            }
        }
    }

    if started_at.elapsed() >= limits.max_scan_duration {
        return Err(ScanFailure::SourceScanTruncated);
    }
    latest.ok_or(if saw_rate_limits {
        ScanFailure::SourceSchemaUnsupported
    } else {
        ScanFailure::SourceNotFound
    })
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

#[derive(Clone, Debug)]
struct NormalizedWindow {
    used_percent: f64,
    window_minutes: Option<u64>,
    resets_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug)]
struct NormalizedEvent {
    observed_at: DateTime<Utc>,
    plan_type: Option<String>,
    primary: Option<NormalizedWindow>,
    secondary: Option<NormalizedWindow>,
    credits: Option<NormalizedCredits>,
}

#[derive(Deserialize)]
struct RawSessionEvent {
    timestamp: Option<RawTimestamp>,
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    plan_type: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_rate_limits")]
    rate_limits: Option<RawRateLimits>,
    #[serde(default, deserialize_with = "deserialize_optional_payload")]
    payload: Option<RawPayload>,
}

#[derive(Deserialize)]
struct RawPayload {
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    plan_type: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_rate_limits")]
    rate_limits: Option<RawRateLimits>,
}

#[derive(Deserialize)]
struct RawRateLimits {
    #[serde(default, deserialize_with = "deserialize_optional_string")]
    plan_type: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_window")]
    primary: Option<RawWindow>,
    #[serde(default, deserialize_with = "deserialize_optional_window")]
    secondary: Option<RawWindow>,
    #[serde(default, deserialize_with = "deserialize_optional_jsonl_credits")]
    credits: Option<RawJsonlCredits>,
}

#[derive(Deserialize)]
struct RawJsonlCredits {
    #[serde(default)]
    balance: Option<RawCreditBalance>,
    #[serde(default)]
    has_credits: Option<bool>,
    #[serde(default)]
    unlimited: Option<bool>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawCreditBalance {
    Text(String),
    Number(f64),
}

#[derive(Deserialize)]
struct RawWindow {
    #[serde(default, deserialize_with = "deserialize_optional_f64")]
    used_percent: Option<f64>,
    #[serde(default, deserialize_with = "deserialize_optional_f64")]
    window_minutes: Option<f64>,
    #[serde(default, deserialize_with = "deserialize_optional_timestamp")]
    resets_at: Option<RawTimestamp>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum RawTimestamp {
    Text(String),
    Signed(i64),
    Unsigned(u64),
    Float(f64),
}

fn deserialize_optional_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(value.as_str().map(str::to_string))
}

fn deserialize_optional_f64<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(value.as_f64())
}

fn deserialize_optional_window<'de, D>(deserializer: D) -> Result<Option<RawWindow>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(None);
    }
    Ok(serde_json::from_value(value).ok())
}

fn deserialize_optional_payload<'de, D>(deserializer: D) -> Result<Option<RawPayload>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

fn deserialize_optional_rate_limits<'de, D>(
    deserializer: D,
) -> Result<Option<RawRateLimits>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

fn deserialize_optional_jsonl_credits<'de, D>(
    deserializer: D,
) -> Result<Option<RawJsonlCredits>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

fn deserialize_optional_timestamp<'de, D>(deserializer: D) -> Result<Option<RawTimestamp>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

fn parse_rate_limit_event(line: &[u8], validation_at: DateTime<Utc>) -> Option<NormalizedEvent> {
    let raw: RawSessionEvent = serde_json::from_slice(line).ok()?;
    let observed_at = parse_timestamp(raw.timestamp.as_ref()?)?;
    let root_plan_type = raw.plan_type.as_deref();
    let payload_plan_type = raw
        .payload
        .as_ref()
        .and_then(|payload| payload.plan_type.as_deref());

    let candidates = [
        raw.rate_limits.as_ref(),
        raw.payload
            .as_ref()
            .and_then(|payload| payload.rate_limits.as_ref()),
    ];
    for limits in candidates.into_iter().flatten() {
        let primary = normalize_window(limits.primary.as_ref(), observed_at, validation_at);
        let secondary = normalize_window(limits.secondary.as_ref(), observed_at, validation_at);
        let credits = limits.credits.as_ref().and_then(normalize_jsonl_credits);
        if primary.is_none() && secondary.is_none() && credits.is_none() {
            continue;
        }
        let plan_type = sanitize_plan_type(
            limits
                .plan_type
                .as_deref()
                .or(payload_plan_type)
                .or(root_plan_type),
        );
        return Some(NormalizedEvent {
            observed_at,
            plan_type,
            primary,
            secondary,
            credits,
        });
    }
    None
}

fn normalize_jsonl_credits(raw: &RawJsonlCredits) -> Option<NormalizedCredits> {
    let remaining = raw.balance.as_ref().and_then(|balance| {
        let balance = match balance {
            RawCreditBalance::Text(value) => value.parse::<f64>().ok()?,
            RawCreditBalance::Number(value) => *value,
        };
        (balance.is_finite() && balance >= 0.0).then_some(balance)
    });
    let unlimited = raw.unlimited.unwrap_or(false);
    if !raw.has_credits.unwrap_or(false) && !unlimited && remaining.is_none() {
        return None;
    }
    Some(NormalizedCredits {
        remaining,
        unlimited,
    })
}

fn normalize_window(
    raw: Option<&RawWindow>,
    observed_at: DateTime<Utc>,
    validation_at: DateTime<Utc>,
) -> Option<NormalizedWindow> {
    let raw = raw?;
    let used_percent = raw.used_percent?;
    if !used_percent.is_finite() || !(0.0..=100.0).contains(&used_percent) {
        return None;
    }
    let window_minutes = match raw.window_minutes {
        Some(minutes) => Some(normalize_window_minutes(minutes)?),
        None => None,
    };
    let resets_at = match raw.resets_at.as_ref() {
        Some(timestamp) => Some(parse_timestamp(timestamp)?),
        None => None,
    };
    if resets_at.is_some_and(|resets_at| {
        !valid_codex_reset_time(resets_at, observed_at)
            || !codex_reset_within_future_bound(resets_at, validation_at)
    }) {
        return None;
    }

    Some(NormalizedWindow {
        used_percent,
        window_minutes,
        resets_at,
    })
}

fn normalize_window_minutes(value: f64) -> Option<u64> {
    if !value.is_finite()
        || value <= 0.0
        || value.fract() != 0.0
        || value > CODEX_MAX_WINDOW_MINUTES as f64
    {
        return None;
    }
    Some(value as u64)
}

fn valid_codex_reset_time(resets_at: DateTime<Utc>, reference_at: DateTime<Utc>) -> bool {
    let earliest =
        reference_at.checked_sub_signed(chrono::Duration::seconds(MAX_FUTURE_CLOCK_SKEW_SECONDS));
    let latest = reference_at.checked_add_signed(chrono::Duration::seconds(
        CODEX_MAX_RESET_SECONDS + MAX_FUTURE_CLOCK_SKEW_SECONDS,
    ));
    earliest.is_some_and(|earliest| resets_at >= earliest)
        && latest.is_some_and(|latest| resets_at <= latest)
}

fn codex_reset_within_future_bound(resets_at: DateTime<Utc>, reference_at: DateTime<Utc>) -> bool {
    reference_at
        .checked_add_signed(chrono::Duration::seconds(
            CODEX_MAX_RESET_SECONDS + MAX_FUTURE_CLOCK_SKEW_SECONDS,
        ))
        .is_some_and(|latest| resets_at <= latest)
}

fn sanitize_plan_type(plan_type: Option<&str>) -> Option<String> {
    let plan_type = plan_type?.trim();
    if plan_type.is_empty()
        || plan_type.len() > 32
        || !plan_type
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    {
        return None;
    }
    Some(plan_type.to_string())
}

fn parse_timestamp(raw: &RawTimestamp) -> Option<DateTime<Utc>> {
    match raw {
        RawTimestamp::Text(value) => DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|timestamp| timestamp.with_timezone(&Utc))
            .or_else(|| value.parse::<i64>().ok().and_then(timestamp_from_seconds)),
        RawTimestamp::Signed(value) => timestamp_from_seconds(*value),
        RawTimestamp::Unsigned(value) => {
            i64::try_from(*value).ok().and_then(timestamp_from_seconds)
        }
        RawTimestamp::Float(value) => {
            if !value.is_finite() || *value < 0.0 || *value > i64::MAX as f64 {
                return None;
            }
            let seconds = value.trunc() as i64;
            let nanos = (value.fract() * 1_000_000_000.0).round() as u32;
            DateTime::<Utc>::from_timestamp(seconds, nanos.min(999_999_999))
        }
    }
}

fn timestamp_from_seconds(seconds: i64) -> Option<DateTime<Utc>> {
    if seconds < 0 {
        return None;
    }
    DateTime::<Utc>::from_timestamp(seconds, 0)
}

#[cfg(test)]
#[allow(dead_code)]
pub fn codex_envelope_from_root_for_test(
    root: &Path,
    fetched_at: DateTime<Utc>,
) -> QuotaProviderEnvelope {
    codex_envelope_from_root_at_for_test(root, fetched_at, fetched_at)
}

#[cfg(test)]
#[allow(dead_code)]
pub fn codex_envelope_from_root_at_for_test(
    root: &Path,
    scan_started_at: DateTime<Utc>,
    fetched_at: DateTime<Utc>,
) -> QuotaProviderEnvelope {
    match scan_latest_rate_limit_event(root, scan_started_at, DEFAULT_SCAN_LIMITS) {
        Ok(event) => codex_envelope_from_event(event, fetched_at),
        Err(failure) => codex_error(failure.reason_code()),
    }
}

#[cfg(test)]
#[allow(dead_code)]
pub fn codex_envelope_with_scan_limits_for_test(
    root: &Path,
    scan_started_at: DateTime<Utc>,
    max_session_files: usize,
    max_directory_entries: usize,
    max_total_read_bytes: usize,
) -> QuotaProviderEnvelope {
    let limits = ScanLimits {
        max_session_files,
        max_directory_entries,
        max_total_read_bytes,
        ..DEFAULT_SCAN_LIMITS
    };
    match scan_latest_rate_limit_event(root, scan_started_at, limits) {
        Ok(event) => codex_envelope_from_event(event, scan_started_at),
        Err(failure) => codex_error(failure.reason_code()),
    }
}

#[cfg(test)]
#[allow(dead_code)]
pub fn disabled_provider_envelopes_for_test() -> Vec<QuotaProviderEnvelope> {
    vec![
        codex_authorization_required(),
        claude_unsupported(),
        antigravity_authorization_required(),
    ]
}

#[cfg(test)]
mod coordinator_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Barrier;

    struct TestAppData {
        path: PathBuf,
    }

    impl TestAppData {
        fn new(label: &str) -> Self {
            let counter = ATOMIC_FILE_COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
            let path = env::temp_dir().join(format!(
                "tokenledger-quota-unit-{label}-{}-{counter}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create quota unit-test appdata");
            Self { path }
        }
    }

    impl Drop for TestAppData {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn synthetic_event(observed_at: DateTime<Utc>, used_percent: f64) -> NormalizedEvent {
        NormalizedEvent {
            observed_at,
            plan_type: Some("test-plan".to_string()),
            primary: Some(NormalizedWindow {
                used_percent,
                window_minutes: Some(300),
                resets_at: None,
            }),
            secondary: None,
            credits: None,
        }
    }

    fn expire_recent(coordinator: &QuotaCoordinator, root: &Path) {
        let mut state = coordinator.lock_state();
        if let Some(root_state) = state.roots.get_mut(root) {
            root_state.recent = None;
        }
    }

    #[test]
    fn concurrent_refreshes_share_one_in_flight_scan_and_recent_result() {
        let coordinator = Arc::new(QuotaCoordinator::default());
        let barrier = Arc::new(Barrier::new(3));
        let scans = Arc::new(AtomicUsize::new(0));
        let root = PathBuf::from("synthetic-single-flight-root");
        let observed_at = Utc::now() - chrono::Duration::minutes(1);

        let mut threads = Vec::new();
        for _ in 0..2 {
            let coordinator = coordinator.clone();
            let barrier = barrier.clone();
            let scans = scans.clone();
            let root = root.clone();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                coordinator.refresh_with(root, || {
                    scans.fetch_add(1, AtomicOrdering::SeqCst);
                    std::thread::sleep(Duration::from_millis(75));
                    Ok(synthetic_event(observed_at, 37.0))
                })
            }));
        }

        barrier.wait();
        let first = threads.remove(0).join().expect("first refresh thread");
        let second = threads.remove(0).join().expect("second refresh thread");
        assert_eq!(scans.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(first, second);

        let reused = coordinator.refresh_with(root, || {
            scans.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(synthetic_event(observed_at, 88.0))
        });
        assert_eq!(scans.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(reused.windows[0].used, Some(37.0));
    }

    #[test]
    fn permission_failure_keeps_root_scoped_last_good_as_stale() {
        let coordinator = QuotaCoordinator::default();
        let root_a = PathBuf::from("synthetic-cache-root-a");
        let root_b = PathBuf::from("synthetic-cache-root-b");
        let observed_at = Utc::now() - chrono::Duration::minutes(1);

        let first =
            coordinator.refresh_with(root_a.clone(), || Ok(synthetic_event(observed_at, 41.0)));
        assert_eq!(first.status, QuotaStatus::Ok);
        expire_recent(&coordinator, &root_a);

        let unrelated = coordinator.refresh_with(root_b, || Err(ScanFailure::PermissionDenied));
        assert_eq!(unrelated.status, QuotaStatus::Error);
        assert!(unrelated.windows.is_empty());

        let fallback =
            coordinator.refresh_with(root_a.clone(), || Err(ScanFailure::PermissionDenied));
        assert_eq!(fallback.status, QuotaStatus::Stale);
        assert_eq!(fallback.windows[0].status, QuotaWindowStatus::Stale);
        assert_eq!(fallback.windows[0].used, Some(41.0));
        assert_eq!(fallback.reason_code.as_deref(), Some("permission_denied"));
        assert_eq!(
            fallback.windows[0].reason_code.as_deref(),
            Some("permission_denied")
        );

        expire_recent(&coordinator, &root_a);
        let temporary = coordinator.refresh_with(root_a.clone(), || {
            Err(ScanFailure::SourceTemporarilyUnavailable)
        });
        assert_eq!(temporary.status, QuotaStatus::Stale);
        assert_eq!(temporary.windows[0].used, Some(41.0));
        assert_eq!(
            temporary.reason_code.as_deref(),
            Some("source_temporarily_unavailable")
        );

        expire_recent(&coordinator, &root_a);
        let truncated = coordinator.refresh_with(root_a, || Err(ScanFailure::SourceScanTruncated));
        assert_eq!(truncated.status, QuotaStatus::Stale);
        assert_eq!(truncated.windows[0].used, Some(41.0));
        assert_eq!(
            truncated.reason_code.as_deref(),
            Some("source_scan_truncated")
        );
    }

    #[test]
    fn fetched_at_is_captured_after_the_scan_finishes() {
        let coordinator = QuotaCoordinator::default();
        let root = PathBuf::from("synthetic-completion-clock-root");
        let scan_completed_at = Arc::new(Mutex::new(None));
        let completed_for_scan = scan_completed_at.clone();
        let observed_at = Utc::now() - chrono::Duration::minutes(1);

        let envelope = coordinator.refresh_with(root, move || {
            std::thread::sleep(Duration::from_millis(10));
            let mut completed = match completed_for_scan.lock() {
                Ok(completed) => completed,
                Err(poisoned) => poisoned.into_inner(),
            };
            *completed = Some(Utc::now());
            Ok(synthetic_event(observed_at, 29.0))
        });

        let completed_at = match scan_completed_at.lock() {
            Ok(completed) => *completed,
            Err(poisoned) => *poisoned.into_inner(),
        }
        .expect("scan completion timestamp");
        let fetched_at = DateTime::parse_from_rfc3339(&envelope.windows[0].fetched_at)
            .expect("fetchedAt timestamp")
            .with_timezone(&Utc);
        assert!(fetched_at.timestamp_millis() >= completed_at.timestamp_millis());
    }

    #[test]
    fn clearing_authorization_removes_all_last_good_snapshots() {
        let coordinator = QuotaCoordinator::default();
        let root = PathBuf::from("synthetic-cleared-cache-root");
        let observed_at = Utc::now() - chrono::Duration::minutes(1);
        let first =
            coordinator.refresh_with(root.clone(), || Ok(synthetic_event(observed_at, 34.0)));
        assert_eq!(first.status, QuotaStatus::Ok);

        coordinator.clear();
        let after_clear =
            coordinator.refresh_with(root, || Err(ScanFailure::SourceTemporarilyUnavailable));
        assert_eq!(after_clear.status, QuotaStatus::Error);
        assert!(after_clear.windows.is_empty());
    }

    #[test]
    fn clearing_authorization_during_refresh_discards_the_result() {
        let coordinator = Arc::new(QuotaCoordinator::default());
        let root = PathBuf::from("synthetic-in-flight-revocation-root");
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let coordinator_for_refresh = coordinator.clone();
        let root_for_refresh = root.clone();
        let observed_at = Utc::now() - chrono::Duration::minutes(1);

        let refresh = std::thread::spawn(move || {
            coordinator_for_refresh.refresh_with(root_for_refresh, || {
                started_tx.send(()).expect("signal refresh start");
                release_rx.recv().expect("release refresh");
                Ok(synthetic_event(observed_at, 52.0))
            })
        });

        started_rx.recv().expect("refresh started");
        coordinator.clear();
        release_tx.send(()).expect("release scanner");
        let discarded = refresh.join().expect("join revoked refresh");
        assert_eq!(discarded.status, QuotaStatus::AuthRequired);
        assert!(discarded.windows.is_empty());

        let after_clear =
            coordinator.refresh_with(root, || Err(ScanFailure::SourceTemporarilyUnavailable));
        assert_eq!(after_clear.status, QuotaStatus::Error);
        assert!(after_clear.windows.is_empty());
    }

    #[test]
    fn permission_denied_has_a_distinct_high_priority_failure() {
        let permission = io::Error::from(io::ErrorKind::PermissionDenied);
        let other = io::Error::from(io::ErrorKind::Other);
        assert_eq!(
            runtime_io_failure(&permission),
            ScanFailure::PermissionDenied
        );
        assert_eq!(
            runtime_io_failure(&other),
            ScanFailure::SourceTemporarilyUnavailable
        );
    }

    #[test]
    fn quota_app_server_requests_use_stable_protocol_without_experimental_opt_in() {
        let initialize = app_server_initialize_message();
        assert_eq!(initialize["method"], "initialize");
        assert_eq!(initialize["params"]["capabilities"], serde_json::json!({}));
        assert!(initialize["params"]["capabilities"]
            .get("experimentalApi")
            .is_none());
        assert_eq!(app_server_initialized_message()["method"], "initialized");
        let rate_limits = app_server_rate_limits_message();
        assert_eq!(rate_limits["method"], "account/rateLimits/read");
        assert!(rate_limits["params"].is_null());
    }

    #[test]
    fn quota_app_server_only_classifies_structured_auth_errors_as_auth_required() {
        assert_eq!(
            classify_app_server_error(
                2,
                &serde_json::json!({
                    "code": -32000,
                    "message": "redacted",
                    "data": { "reason": "auth_required" }
                }),
            ),
            AppServerFailure::AuthRequired
        );
        assert_eq!(
            classify_app_server_error(
                2,
                &serde_json::json!({
                    "code": -32001,
                    "message": "Server overloaded; retry later."
                }),
            ),
            AppServerFailure::Unavailable
        );
        assert_eq!(
            classify_app_server_error(
                2,
                &serde_json::json!({
                    "code": -32603,
                    "message": "auth_required"
                }),
            ),
            AppServerFailure::Unavailable
        );
        assert_eq!(
            classify_app_server_error(2, &Value::Null),
            AppServerFailure::SchemaUnsupported
        );
    }

    #[test]
    fn quota_app_server_prefers_sorted_multi_bucket_data_and_whitelists_fields() {
        let result = serde_json::json!({
            "rateLimits": {
                "planType": "ignored-legacy",
                "primary": { "usedPercent": 99, "windowDurationMins": 300, "resetsAt": 2_000_000_000 }
            },
            "rateLimitsByLimitId": {
                "zeta": {
                    "planType": "test-plan",
                    "secondary": { "usedPercent": 20, "windowDurationMins": 10080, "resetsAt": 2_000_000_200 },
                    "credits": { "balance": "12.5", "hasCredits": true, "unlimited": false },
                    "accessToken": "SENSITIVE_APP_SERVER_TOKEN"
                },
                "alpha": {
                    "planType": "test-plan",
                    "primary": { "usedPercent": 10, "windowDurationMins": 300, "resetsAt": 2_000_000_100 }
                }
            },
            "privateAccount": "SENSITIVE_ACCOUNT"
        });

        let observation = parse_app_server_observation(result).expect("parse app-server result");
        assert_eq!(observation.buckets[0].id, "alpha");
        assert_eq!(observation.buckets[1].id, "zeta");
        let envelope = codex_envelope_from_app_server(
            observation,
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test time"),
        );
        assert_eq!(envelope.capability, QuotaCapability::Stable);
        assert!(envelope
            .windows
            .iter()
            .any(|window| window.window_id == "alpha:primary" && window.used == Some(10.0)));
        assert!(envelope.windows.iter().any(|window| {
            window.window_id == "zeta:credits"
                && window.unit == QuotaUnit::Credits
                && window.remaining == Some(12.5)
                && window.used.is_none()
        }));
        assert!(!envelope
            .windows
            .iter()
            .any(|window| window.used == Some(99.0)));
        let serialized = serde_json::to_string(&envelope).expect("serialize app-server envelope");
        assert!(!serialized.contains("SENSITIVE_APP_SERVER_TOKEN"));
        assert!(!serialized.contains("SENSITIVE_ACCOUNT"));
        assert!(!serialized.contains("ignored-legacy"));
    }

    #[test]
    fn quota_app_server_rejects_oversized_live_bucket_or_window_sets() {
        let mut too_many_buckets = serde_json::Map::new();
        for index in 0..=APP_SERVER_MAX_BUCKETS {
            too_many_buckets.insert(
                format!("bucket-{index:02}"),
                serde_json::json!({
                    "primary": { "usedPercent": 10, "windowDurationMins": 300 }
                }),
            );
        }
        assert_eq!(
            parse_app_server_observation(serde_json::json!({
                "rateLimitsByLimitId": too_many_buckets
            }))
            .expect_err("oversized bucket set must fail"),
            AppServerFailure::SchemaUnsupported
        );

        let mut too_many_windows = serde_json::Map::new();
        for index in 0..17 {
            too_many_windows.insert(
                format!("bucket-{index:02}"),
                serde_json::json!({
                    "primary": { "usedPercent": 10, "windowDurationMins": 300 },
                    "secondary": { "usedPercent": 20, "windowDurationMins": 10080 }
                }),
            );
        }
        assert_eq!(
            parse_app_server_observation(serde_json::json!({
                "rateLimitsByLimitId": too_many_windows
            }))
            .expect_err("oversized live window set must fail"),
            AppServerFailure::SchemaUnsupported
        );
    }

    #[test]
    fn quota_app_server_accepts_backward_compatible_single_bucket() {
        let observation = parse_app_server_observation(serde_json::json!({
            "rateLimits": {
                "planType": "test-plan",
                "primary": { "usedPercent": 31, "windowDurationMins": 300, "resetsAt": 2_000_000_000 }
            },
            "rateLimitsByLimitId": null
        }))
        .expect("parse legacy rateLimits view");
        let envelope = codex_envelope_from_app_server(
            observation,
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test time"),
        );
        assert_eq!(envelope.windows[0].window_id, "primary");
        assert_eq!(envelope.windows[0].used, Some(31.0));
    }

    #[test]
    fn quota_app_server_drops_unreasonable_reset_times_and_window_durations() {
        let now = DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test time");
        let observation = parse_app_server_observation(serde_json::json!({
            "rateLimits": {
                "planType": "test-plan",
                "primary": {
                    "usedPercent": 12,
                    "windowDurationMins": CODEX_MAX_WINDOW_MINUTES + 1,
                    "resetsAt": now.timestamp() - MAX_FUTURE_CLOCK_SKEW_SECONDS - 1
                },
                "secondary": {
                    "usedPercent": 34,
                    "windowDurationMins": 10080,
                    "resetsAt": now.timestamp() + CODEX_MAX_RESET_SECONDS
                        + MAX_FUTURE_CLOCK_SKEW_SECONDS + 1
                }
            }
        }))
        .expect("parse app-server windows with invalid timing metadata");
        let envelope = codex_envelope_from_app_server(observation, now);
        assert_eq!(envelope.windows.len(), 2);
        let primary = envelope
            .windows
            .iter()
            .find(|window| window.window_id == "primary")
            .expect("primary window");
        assert_eq!(primary.window_minutes, None);
        assert_eq!(primary.resets_at, None);
        let secondary = envelope
            .windows
            .iter()
            .find(|window| window.window_id == "secondary")
            .expect("secondary window");
        assert_eq!(secondary.window_minutes, Some(10080));
        assert_eq!(secondary.resets_at, None);
    }

    #[test]
    fn quota_jsonl_fallback_normalizes_credits_without_source_fields() {
        let line = serde_json::json!({
            "timestamp": "2030-03-17T17:46:40Z",
            "payload": {
                "rate_limits": {
                    "plan_type": "test-plan",
                    "primary": { "used_percent": 25, "window_minutes": 300 },
                    "credits": {
                        "balance": "8.75",
                        "has_credits": true,
                        "unlimited": false,
                        "private": "SENSITIVE_JSONL_CREDITS"
                    }
                }
            }
        })
        .to_string();
        let validation_at = DateTime::parse_from_rfc3339("2030-03-17T17:47:00Z")
            .expect("test validation time")
            .with_timezone(&Utc);
        let event =
            parse_rate_limit_event(line.as_bytes(), validation_at).expect("parse JSONL credits");
        let envelope = codex_envelope_from_event(event, validation_at);
        let credits = envelope
            .windows
            .iter()
            .find(|window| window.window_id == "credits")
            .expect("credits window");
        assert_eq!(credits.remaining, Some(8.75));
        assert!(credits.used.is_none());
        assert!(!serde_json::to_string(&envelope)
            .expect("serialize JSONL fallback")
            .contains("SENSITIVE_JSONL_CREDITS"));
    }

    #[test]
    fn quota_jsonl_rejects_unreasonable_timing_and_marks_expired_reset_stale() {
        let directory = TestAppData::new("jsonl-window-timing-bounds");
        let root = directory.path.join("codex-home");
        let sessions = root.join("sessions");
        fs::create_dir_all(&sessions).expect("create JSONL timing sessions directory");
        let observed_at = DateTime::parse_from_rfc3339("2030-03-17T17:50:00Z")
            .expect("test observation time")
            .with_timezone(&Utc);
        let validation_at = observed_at + chrono::Duration::minutes(10);
        let events = [
            serde_json::json!({
                "timestamp": format_timestamp(observed_at),
                "rate_limits": {
                    "primary": {
                        "used_percent": 10,
                        "window_minutes": CODEX_MAX_WINDOW_MINUTES + 1
                    }
                }
            }),
            serde_json::json!({
                "timestamp": format_timestamp(observed_at),
                "rate_limits": {
                    "primary": {
                        "used_percent": 20,
                        "window_minutes": 300,
                        "resets_at": (observed_at + chrono::Duration::days(9)).timestamp()
                    }
                }
            }),
        ];
        let source = events
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(sessions.join("invalid-timing.jsonl"), source)
            .expect("write invalid JSONL timing events");

        let error = scan_latest_rate_limit_event(&root, validation_at, DEFAULT_SCAN_LIMITS)
            .expect_err("invalid timing-only source must fail honestly");
        assert_eq!(error, ScanFailure::SourceSchemaUnsupported);

        let expired = serde_json::json!({
            "timestamp": format_timestamp(observed_at),
            "rate_limits": {
                "primary": {
                    "used_percent": 30,
                    "window_minutes": 300,
                    "resets_at": (observed_at + chrono::Duration::minutes(1)).timestamp()
                }
            }
        })
        .to_string();
        let event = parse_rate_limit_event(expired.as_bytes(), validation_at)
            .expect("expired reset remains a valid historical observation");
        let envelope = codex_envelope_from_event(event, validation_at);
        assert_eq!(envelope.status, QuotaStatus::Stale);
        assert_eq!(envelope.windows[0].status, QuotaWindowStatus::Stale);
        assert_eq!(envelope.reason_code.as_deref(), Some("observation_stale"));
    }

    #[cfg(unix)]
    #[test]
    fn quota_app_server_child_is_terminated_after_a_successful_snapshot() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestAppData::new("app-server-success");
        let script = directory.path.join("fake-codex");
        fs::write(
            &script,
            r#"#!/bin/sh
IFS= read -r initialize
printf '%s\n' '{"id":1,"result":{"userAgent":"test"}}'
IFS= read -r initialized
IFS= read -r request
printf '%s\n' '{"id":2,"result":{"rateLimits":{"planType":"test-plan","primary":{"usedPercent":22,"windowDurationMins":300,"resetsAt":2000000000}},"rateLimitsByLimitId":null}}'
sleep 30
"#,
        )
        .expect("write fake Codex app-server");
        let mut permissions = fs::metadata(&script)
            .expect("script metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script, permissions).expect("make fake Codex executable");

        let timeout = APP_SERVER_TIMEOUT;
        let started = Instant::now();
        let observation = query_codex_app_server(script.as_os_str(), timeout)
            .expect("query fake Codex app-server");
        assert_eq!(observation.buckets.len(), 1);
        assert!(started.elapsed() < timeout);
    }

    #[cfg(unix)]
    #[test]
    fn quota_app_server_kills_wrapper_descendants_that_hold_stdout_open() {
        use std::os::unix::fs::PermissionsExt;

        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }

        let directory = TestAppData::new("app-server-process-tree");
        let script = directory.path.join("fake-codex");
        let marker = directory.path.join("processes.txt");
        let source = format!(
            r#"#!/bin/sh
(
  trap '' HUP TERM
  while :; do :; done
) &
grandchild=$!
printf '%s %s\n' "$$" "$grandchild" > '{}'
IFS= read -r initialize
printf '%s\n' '{{"id":1,"result":{{"userAgent":"test"}}}}'
IFS= read -r initialized
IFS= read -r request
printf '%s\n' '{{"id":2,"result":{{"rateLimits":{{"planType":"test-plan","primary":{{"usedPercent":22,"windowDurationMins":300,"resetsAt":2000000000}}}},"rateLimitsByLimitId":null}}}}'
exit 0
"#,
            marker.display()
        );
        fs::write(&script, source).expect("write process-tree fake Codex");
        let mut permissions = fs::metadata(&script)
            .expect("script metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script, permissions).expect("make process-tree fake executable");

        let timeout = APP_SERVER_TIMEOUT;
        let started = Instant::now();
        let observation = query_codex_app_server(script.as_os_str(), timeout)
            .expect("query process-tree fake Codex");
        assert_eq!(observation.buckets.len(), 1);
        assert!(started.elapsed() < timeout);

        let process_ids = fs::read_to_string(&marker).expect("read fake process IDs");
        let mut process_ids = process_ids
            .split_whitespace()
            .map(|value| value.parse::<i32>().expect("numeric fake process ID"));
        let wrapper = process_ids.next().expect("wrapper PID");
        let grandchild = process_ids.next().expect("grandchild PID");
        let mut grandchild_alive = unsafe { kill(grandchild, 0) == 0 };
        for _ in 0..50 {
            if !grandchild_alive {
                break;
            }
            thread::sleep(Duration::from_millis(10));
            grandchild_alive = unsafe { kill(grandchild, 0) == 0 };
        }
        if grandchild_alive {
            let _ = unsafe { kill(grandchild, 9) };
            let _ = unsafe { kill(-wrapper, 9) };
        }
        assert!(
            !grandchild_alive,
            "app-server grandchild survived tree kill"
        );
    }

    #[cfg(unix)]
    #[test]
    fn quota_app_server_reader_shutdown_is_bounded_with_an_open_writer() {
        use std::os::unix::net::UnixStream;

        let (read_end, write_end) = UnixStream::pair().expect("create reader test pipe");
        let mut reader = spawn_app_server_reader(read_end);
        let started = Instant::now();
        reader.shutdown(Duration::from_millis(25));
        assert!(started.elapsed() < Duration::from_millis(200));
        drop(write_end);
    }

    #[cfg(unix)]
    #[test]
    fn quota_codex_executable_resolution_prefers_explicit_then_path_then_fallback() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestAppData::new("codex-resolution");
        let explicit = directory.path.join("explicit-codex");
        let path_directory = directory.path.join("path-bin");
        let fallback = directory.path.join("fallback-codex");
        fs::create_dir_all(&path_directory).expect("create synthetic PATH directory");
        let path_codex = path_directory.join("codex");
        for executable in [&explicit, &path_codex, &fallback] {
            fs::write(executable, "#!/bin/sh\nexit 0\n").expect("write synthetic executable");
            let mut permissions = fs::metadata(executable)
                .expect("synthetic executable metadata")
                .permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(executable, permissions)
                .expect("set synthetic executable permissions");
        }
        let search_path = env::join_paths([&path_directory]).expect("join synthetic PATH");

        assert_eq!(
            resolve_codex_launch_plan_from(
                Some(explicit.as_os_str()),
                Some(search_path.as_os_str()),
                std::slice::from_ref(&fallback),
            )
            .map(|plan| plan.program),
            fs::canonicalize(&explicit).ok()
        );
        assert_eq!(
            resolve_codex_launch_plan_from(
                Some(OsStr::new("relative-codex")),
                Some(search_path.as_os_str()),
                std::slice::from_ref(&fallback),
            )
            .map(|plan| plan.program),
            fs::canonicalize(&path_codex).ok()
        );
        assert_eq!(
            resolve_codex_launch_plan_from(None, None, std::slice::from_ref(&fallback))
                .map(|plan| plan.program),
            fs::canonicalize(&fallback).ok()
        );

        let plans = resolve_codex_launch_plans_from(
            None,
            Some(search_path.as_os_str()),
            std::slice::from_ref(&fallback),
        );
        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].program, fs::canonicalize(&path_codex).unwrap());
        assert_eq!(plans[1].program, fs::canonicalize(&fallback).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn quota_codex_npm_wrapper_resolves_bundled_native_without_node_on_path() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestAppData::new("codex-npm-native-resolution");
        let package_root = directory.path.join("node_modules/@openai/codex");
        let script = package_root.join("bin/codex.js");
        let (native_package, native_triple) =
            codex_native_package_layout().expect("supported test target");
        let native = package_root
            .join("node_modules/@openai")
            .join(native_package)
            .join("vendor")
            .join(native_triple)
            .join("bin/codex");
        fs::create_dir_all(script.parent().expect("script parent"))
            .expect("create synthetic npm script directory");
        fs::create_dir_all(native.parent().expect("native parent"))
            .expect("create synthetic native directory");
        for (path, source) in [
            (&script, "#!/usr/bin/env node\nprocess.exit(0)\n"),
            (&native, "#!/bin/sh\nexit 0\n"),
        ] {
            fs::write(path, source).expect("write synthetic npm executable");
            let mut permissions = fs::metadata(path)
                .expect("synthetic npm executable metadata")
                .permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(path, permissions)
                .expect("set synthetic npm executable permissions");
        }
        let finder_path = env::join_paths([Path::new("/usr/bin"), Path::new("/bin")])
            .expect("build Finder-like PATH");

        let plan = resolve_codex_launch_plan_from(
            Some(script.as_os_str()),
            Some(finder_path.as_os_str()),
            &[],
        )
        .expect("resolve native Codex launch plan");
        assert_eq!(
            plan.program,
            fs::canonicalize(&native).expect("canonical native")
        );
        assert!(plan.prefix_args.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn quota_app_server_timeout_kills_and_waits_for_the_child() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestAppData::new("app-server-timeout");
        let script = directory.path.join("fake-codex");
        fs::write(&script, "#!/bin/sh\nwhile :; do :; done\n").expect("write timeout fake Codex");
        let mut permissions = fs::metadata(&script)
            .expect("script metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script, permissions).expect("make timeout fake executable");

        let started = Instant::now();
        let error = query_codex_app_server(script.as_os_str(), Duration::from_millis(50))
            .expect_err("fake Codex must time out");
        assert_eq!(error, AppServerFailure::Timeout);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[cfg(unix)]
    #[test]
    fn quota_app_server_skips_a_broken_candidate_before_a_working_installation() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestAppData::new("app-server-candidate-fallback");
        let broken = directory.path.join("broken-codex");
        let working = directory.path.join("working-codex");
        fs::write(&broken, "#!/bin/sh\nexit 1\n").expect("write broken Codex candidate");
        fs::write(
            &working,
            r#"#!/bin/sh
IFS= read -r initialize
printf '%s\n' '{"id":1,"result":{"userAgent":"test"}}'
IFS= read -r initialized
IFS= read -r request
printf '%s\n' '{"id":2,"result":{"rateLimits":{"planType":"test-plan","primary":{"usedPercent":17,"windowDurationMins":300,"resetsAt":2000000000}},"rateLimitsByLimitId":null}}'
"#,
        )
        .expect("write working Codex candidate");
        for executable in [&broken, &working] {
            let mut permissions = fs::metadata(executable)
                .expect("candidate metadata")
                .permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(executable, permissions).expect("make candidate executable");
        }

        let plans = [&broken, &working]
            .into_iter()
            .map(|candidate| {
                codex_launch_plan_for_candidate(candidate, None).expect("candidate launch plan")
            })
            .collect();
        let observation = query_codex_app_server_from_candidates(plans, Duration::from_secs(3))
            .expect("working candidate should recover the probe");
        assert_eq!(observation.buckets.len(), 1);
        assert_eq!(
            observation.buckets[0]
                .primary
                .as_ref()
                .unwrap()
                .used_percent,
            17.0
        );
    }

    #[test]
    fn quota_claude_helper_persists_only_whitelisted_normalized_fields() {
        let directory = TestAppData::new("claude-whitelist");
        let observed_at =
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test observed time");
        let input = serde_json::json!({
            "cwd": "/SENSITIVE/WORKTREE",
            "session_id": "SENSITIVE_SESSION",
            "transcript_path": "/SENSITIVE/TRANSCRIPT",
            "rate_limits": {
                "five_hour": {
                    "used_percentage": 24.0,
                    "resets_at": 1_900_010_000,
                    "private": "SENSITIVE_WINDOW"
                },
                "seven_day": {
                    "used_percentage": 41.0,
                    "resets_at": 1_900_600_000
                }
            }
        });
        let display = process_claude_statusline_input(
            input.to_string().as_bytes(),
            &directory.path,
            observed_at,
        )
        .expect("write normalized Claude snapshot");
        assert_eq!(display, "Claude 5h 24% · 7d 41%");

        let snapshot = fs::read_to_string(directory.path.join(CLAUDE_STATUSLINE_FILE))
            .expect("read normalized Claude snapshot");
        for sensitive in [
            "SENSITIVE/WORKTREE",
            "SENSITIVE_SESSION",
            "SENSITIVE/TRANSCRIPT",
            "SENSITIVE_WINDOW",
            "cwd",
            "session_id",
            "transcript_path",
        ] {
            assert!(!snapshot.contains(sensitive));
        }
        let envelope = claude_envelope_from_app_data(
            &directory.path,
            observed_at + chrono::Duration::minutes(1),
        );
        assert_eq!(envelope.status, QuotaStatus::Ok);
        assert_eq!(envelope.capability, QuotaCapability::PlanDependent);
        assert_eq!(envelope.windows.len(), 2);
        assert_eq!(envelope.windows[0].used, Some(24.0));
    }

    #[test]
    fn quota_codexbar_bridge_accepts_bounded_claude_windows_and_discards_identity() {
        let fetched_at =
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test fetched time");
        let payload = serde_json::json!([{
            "provider": "claude",
            "source": "claude-web",
            "usage": {
                "updatedAt": "2030-03-17T17:46:40Z",
                "accountEmail": "sensitive@example.com",
                "primary": {
                    "usedPercent": 27.5,
                    "windowMinutes": 300,
                    "resetsAt": "2030-03-17T19:46:40Z"
                },
                "secondary": {
                    "usedPercent": 52.0,
                    "windowMinutes": 10080,
                    "resetsAt": "2030-03-20T17:46:40Z"
                },
                "extraRateWindows": [{
                    "id": "sonnet",
                    "title": "Sonnet window",
                    "window": {
                        "usedPercent": 18.0,
                        "windowMinutes": 1440,
                        "resetsAt": "2030-03-18T17:46:40Z"
                    }
                }]
            }
        }]);

        let envelope = parse_fallback_cli_claude_output(payload.to_string().as_bytes(), fetched_at)
            .expect("parse normalized CodexBar Claude output");
        assert_eq!(envelope.status, QuotaStatus::Ok);
        assert_eq!(envelope.capability, QuotaCapability::Experimental);
        assert_eq!(envelope.windows.len(), 3);
        assert_eq!(envelope.windows[0].used, Some(27.5));
        assert_eq!(envelope.windows[2].window_id, "codexbar-sonnet");
        assert!(envelope
            .windows
            .iter()
            .all(|window| window.account_label.is_none()));
        let serialized = serde_json::to_string(&envelope).expect("serialize envelope");
        assert!(!serialized.contains("sensitive@example.com"));
        assert!(!serialized.contains("claude-web"));
    }

    #[test]
    fn quota_codexbar_bridge_rejects_unbounded_or_non_claude_payloads() {
        let fetched_at =
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test fetched time");
        for payload in [
            serde_json::json!([{"provider": "codex", "usage": {}}]),
            serde_json::json!([{
                "provider": "claude",
                "source": "web",
                "usage": {"primary": {"usedPercent": 101, "windowMinutes": 300}}
            }]),
            serde_json::json!([{
                "provider": "claude",
                "source": "api",
                "usage": {
                    "updatedAt": "2030-03-17T17:46:40Z",
                    "primary": {"usedPercent": 10, "windowMinutes": 300}
                }
            }]),
        ] {
            assert_eq!(
                parse_fallback_cli_claude_output(payload.to_string().as_bytes(), fetched_at),
                Err(FallbackCliFailure::ResponseInvalid)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn quota_codexbar_bridge_runs_only_the_fixed_claude_json_command() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestAppData::new("claude-codexbar-command");
        let program = directory.path.join("fake-codexbar");
        fs::write(
            &program,
            concat!(
                "#!/bin/sh\n",
                "expected='--provider claude --source auto --format json --no-color --json-only --web-timeout 15'\n",
                "[ \"$*\" = \"$expected\" ] || exit 9\n",
                "printf '[]'\n",
            ),
        )
        .expect("write fake CodexBar CLI");
        let mut permissions = fs::metadata(&program)
            .expect("fake CodexBar metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&program, permissions).expect("mark fake CodexBar executable");

        let output = capture_fallback_cli_claude_output(
            &program,
            &directory.path,
            CLAUDE_FALLBACK_CLI_TIMEOUT,
        )
        .expect("capture fixed CodexBar command");
        assert_eq!(output, b"[]");
    }

    #[test]
    fn claude_cli_candidates_cover_windows_npm_shims() {
        // npm 在 Windows 上只生成 claude / claude.cmd / claude.ps1，没有 .exe。
        // 此前只找 .exe，等于把用户 PATH 里真正在用的那个 CLI 整个跳过。
        let resolved = resolve_claude_cli_executables();
        let extensions = resolved
            .iter()
            .filter_map(|path| path.extension())
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .collect::<Vec<_>>();
        if cfg!(windows) {
            // 本机可能只装了其中一种，所以只断言「不会因为扩展名被排除」，
            // 而不是断言某个具体文件一定存在。
            assert!(
                resolved.iter().all(|path| path.is_absolute()),
                "候选必须是绝对路径"
            );
            assert!(
                extensions
                    .iter()
                    .all(|ext| matches!(ext.as_str(), "exe" | "cmd" | "bat" | "ps1")),
                "出现了预期之外的候选扩展名：{extensions:?}"
            );
        }
    }

    #[test]
    fn claude_pty_launch_wraps_windows_script_shims_but_not_native_binaries() {
        // 批处理与 PowerShell 脚本不能直接 CreateProcess，必须由解释器调起；
        // 原生可执行文件不该被多套一层 shell。
        let native = if cfg!(windows) {
            PathBuf::from(r"C:\Users\demo\AppData\Local\Claude-3p\claude-code\2.1.219\claude.exe")
        } else {
            PathBuf::from("/usr/local/bin/claude")
        };
        let (program, args) = claude_pty_launch(&native);
        assert_eq!(program, native);
        assert!(args.is_empty(), "原生可执行文件不应被包一层 shell");

        #[cfg(windows)]
        {
            let cmd_shim = PathBuf::from(r"C:\Users\demo\AppData\Roaming\npm\claude.cmd");
            let (program, args) = claude_pty_launch(&cmd_shim);
            assert_eq!(
                program
                    .file_name()
                    .map(|name| name.to_string_lossy().to_ascii_lowercase()),
                Some("cmd.exe".to_string())
            );
            assert_eq!(args, vec![OsString::from("/c"), cmd_shim.into()]);

            let ps_shim = PathBuf::from(r"C:\Users\demo\AppData\Roaming\npm\claude.ps1");
            let (program, args) = claude_pty_launch(&ps_shim);
            assert_eq!(
                program
                    .file_name()
                    .map(|name| name.to_string_lossy().to_ascii_lowercase()),
                Some("powershell.exe".to_string())
            );
            assert!(args.contains(&OsString::from("-NoProfile")));
            assert!(args.contains(&OsString::from("-File")));
            assert_eq!(args.last(), Some(&OsString::from(ps_shim)));
        }
    }

    #[test]
    #[ignore = "requires a logged-in local Claude subscription; prints the raw /usage capture"]
    fn quota_claude_native_real_cli_capture_diagnostic() {
        // 诊断用：把每个候选 CLI 的原始 /usage 输出打出来，用于判断解析失败到底
        // 是「没找到 CLI」还是「输出格式变了」。用 `-- --ignored --nocapture` 跑。
        let directory = TestAppData::new("claude-native-real-capture");
        let candidates = resolve_claude_cli_executables();
        println!("解析到 {} 个 Claude CLI 候选：", candidates.len());
        for candidate in &candidates {
            println!("  {}", candidate.display());
        }
        assert!(!candidates.is_empty(), "本机没有可用的 Claude CLI 候选");

        for candidate in &candidates {
            println!("\n===== {} =====", candidate.display());
            match capture_claude_cli_usage_with_timeout(
                candidate,
                &directory.path,
                CLAUDE_NATIVE_CLI_TIMEOUT,
            ) {
                Ok(bytes) => {
                    let plain = claude_cli_plain_text(&bytes);
                    println!("--- 去掉转义后的输出（前 4000 字符）---");
                    println!("{}", plain.chars().take(4000).collect::<String>());
                    match parse_claude_cli_usage(&bytes, Utc::now()) {
                        Ok(envelope) => {
                            println!("--- 解析成功：{} 个窗口 ---", envelope.windows.len())
                        }
                        Err(failure) => {
                            println!("--- 解析失败：{} ---", failure.reason_code())
                        }
                    }
                }
                Err(failure) => println!("捕获失败：{}", failure.reason_code()),
            }
        }
    }

    #[test]
    #[ignore = "requires an installed, user-authorized CodexBar Claude source"]
    fn quota_codexbar_real_account_bridge_returns_normalized_windows() {
        let directory = TestAppData::new("claude-codexbar-real-account");
        let envelope = claude_fallback_cli_envelope(&directory.path, Utc::now())
            .expect("read real Claude quota through CodexBar");
        assert_eq!(envelope.provider_id, CLAUDE_PROVIDER_ID);
        assert!(matches!(
            envelope.status,
            QuotaStatus::Ok | QuotaStatus::Stale
        ));
        assert!(!envelope.windows.is_empty());
        assert!(envelope.windows.iter().all(|window| {
            window.source == QuotaSource::LocalAuthorized
                && window.account_label.is_none()
                && window
                    .used
                    .is_some_and(|used| (0.0..=100.0).contains(&used))
        }));
    }

    #[test]
    fn quota_claude_native_cli_maps_used_left_and_model_windows() {
        let fetched_at =
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test fetched time");
        let output = concat!(
            "\u{1b}[2CSettings  Status  Config  Usage\r\n",
            "Current\u{1b}[1Csession\r\n",
            "93% left\r\n",
            "Resets in 2h 30m\r\n",
            "Current week (all models)\r\n",
            "40% used\r\n",
            "Resets in 4 days\r\n",
            "Current week (Sonnet only)\r\n",
            "5% used\r\n",
            "Account: SENSITIVE_ACCOUNT_SHOULD_NOT_LEAK\r\n",
        );

        let envelope =
            parse_claude_cli_usage(output.as_bytes(), fetched_at).expect("parse Claude CLI usage");
        assert_eq!(envelope.status, QuotaStatus::Ok);
        assert_eq!(envelope.capability, QuotaCapability::Experimental);
        assert_eq!(envelope.windows.len(), 3);
        assert_eq!(envelope.windows[0].window_id, "native-cli-five-hour");
        assert_eq!(envelope.windows[0].used, Some(7.0));
        assert_eq!(envelope.windows[1].used, Some(40.0));
        assert_eq!(envelope.windows[2].window_label, "Sonnet · weekly");
        assert_eq!(envelope.windows[2].used, Some(5.0));
        assert!(envelope.windows[0].resets_at.is_some());
        let serialized = serde_json::to_string(&envelope).expect("serialize normalized envelope");
        assert!(!serialized.contains("SENSITIVE_ACCOUNT_SHOULD_NOT_LEAK"));
        assert!(!serialized.contains("codexbar"));
    }

    #[test]
    fn quota_claude_native_cli_handles_compact_terminal_spacing() {
        let output = concat!(
            "Current\u{1b}[1Csession\r\n",
            "12.5%\u{1b}[1Cused\r\n",
            "Current\u{1b}[1Cweek\u{1b}[1C(all\u{1b}[1Cmodels)\r\n",
            "79%\u{1b}[1Cleft\r\n",
        );
        let envelope =
            parse_claude_cli_usage(output.as_bytes(), Utc::now()).expect("parse compact TUI");
        assert_eq!(envelope.windows.len(), 2);
        assert_eq!(envelope.windows[0].used, Some(12.5));
        assert_eq!(envelope.windows[1].used, Some(21.0));
    }

    #[test]
    fn quota_claude_native_cli_uses_latest_complete_redraw_sections() {
        let output = concat!(
            "Current session\r\n",
            "93% left\r\n",
            "Current week (all models)\r\n",
            "40% used\r\n",
            "Current session\r\n",
            "100% left\r\n",
            "Current week (all models)\r\n",
            "38% used\r\n",
        );
        let envelope =
            parse_claude_cli_usage(output.as_bytes(), Utc::now()).expect("parse redraws");
        assert_eq!(envelope.windows.len(), 2);
        assert_eq!(envelope.windows[0].used, Some(0.0));
        assert_eq!(envelope.windows[1].used, Some(38.0));
    }

    #[test]
    fn quota_claude_native_cli_truncated_redraw_does_not_borrow_next_window_value() {
        let output = concat!(
            "Current session\r\n",
            "100% left\r\n",
            "Current week (all models)\r\n",
            "38% used\r\n",
            // The next weekly frame is incomplete. The following session
            // percentage must not be associated with that weekly heading.
            "Current week (all models)\r\n",
            "Current session\r\n",
            "100% left\r\n",
        );
        let envelope =
            parse_claude_cli_usage(output.as_bytes(), Utc::now()).expect("parse truncated redraw");
        assert_eq!(envelope.windows.len(), 2);
        assert_eq!(envelope.windows[0].used, Some(0.0));
        assert_eq!(envelope.windows[1].used, Some(38.0));
    }

    #[test]
    fn quota_claude_role_arbitration_prefers_codexbar_week_over_native_hundred_percent() {
        let fetched_at =
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test fetched time");
        let native = parse_claude_cli_usage(
            b"Current session\n100% left\nCurrent week (all models)\n100% left\n",
            fetched_at,
        )
        .expect("native");
        let codexbar = parse_fallback_cli_claude_output(
            serde_json::json!({
                "provider": "claude",
                "source": "web",
                "usage": {
                    "updatedAt": format_timestamp(fetched_at),
                    "primary": { "usedPercent": 0.0, "windowMinutes": 300 },
                    "secondary": { "usedPercent": 38.0, "windowMinutes": 10080 }
                }
            })
            .to_string()
            .as_bytes(),
            fetched_at,
        )
        .expect("codexbar");

        let merged = merge_claude_provider_envelopes(&[native.clone(), codexbar]).expect("merged");
        let weekly = merged
            .windows
            .iter()
            .find(|window| claude_core_window_role(window) == Some(ClaudeCoreWindowRole::SevenDay))
            .expect("weekly");
        assert_eq!(weekly.window_id, "codexbar-secondary");
        assert_eq!(weekly.used, Some(38.0));
        assert_eq!(weekly.remaining, Some(62.0));
    }

    #[test]
    fn quota_claude_role_arbitration_fills_missing_native_week_from_codexbar() {
        let fetched_at =
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test fetched time");
        let native =
            parse_claude_cli_usage(b"Current session\n100% left\n", fetched_at).expect("native");
        assert!(!claude_envelope_has_complete_core_roles(&native));
        let codexbar = parse_fallback_cli_claude_output(
            serde_json::json!({
                "provider": "claude",
                "source": "web",
                "usage": {
                    "updatedAt": format_timestamp(fetched_at),
                    "secondary": { "usedPercent": 38.0, "windowMinutes": 10080 }
                }
            })
            .to_string()
            .as_bytes(),
            fetched_at,
        )
        .expect("codexbar");

        let merged = merge_claude_provider_envelopes(&[native, codexbar]).expect("merged");
        assert!(claude_envelope_has_complete_core_roles(&merged));
        assert_eq!(
            merged
                .windows
                .iter()
                .find(|window| {
                    claude_core_window_role(window) == Some(ClaudeCoreWindowRole::FiveHour)
                })
                .map(|window| window.window_id.as_str()),
            Some("native-cli-five-hour")
        );
        assert_eq!(
            merged
                .windows
                .iter()
                .find(|window| {
                    claude_core_window_role(window) == Some(ClaudeCoreWindowRole::SevenDay)
                })
                .map(|window| window.remaining),
            Some(Some(62.0))
        );
    }

    #[test]
    fn quota_claude_role_arbitration_prefers_statusline_for_each_shared_role() {
        let fetched_at =
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test fetched time");
        let native = parse_claude_cli_usage(
            b"Current session\n100% left\nCurrent week (all models)\n100% left\n",
            fetched_at,
        )
        .expect("native");
        let statusline_snapshot = ClaudeStatuslineSnapshot {
            schema_version: 1,
            observed_at: format_timestamp(fetched_at),
            windows: vec![
                ClaudeStatuslineWindow {
                    window_id: "five-hour".to_string(),
                    used_percent: 1.0,
                    resets_at: format_timestamp(fetched_at + chrono::Duration::hours(1)),
                },
                ClaudeStatuslineWindow {
                    window_id: "seven-day".to_string(),
                    used_percent: 38.0,
                    resets_at: format_timestamp(fetched_at + chrono::Duration::days(1)),
                },
            ],
        };
        let statusline = claude_envelope_from_snapshot(statusline_snapshot, fetched_at);

        let merged =
            merge_claude_provider_envelopes(&[native, statusline]).expect("merged statusline");
        assert_eq!(merged.windows[0].window_id, "five-hour");
        assert_eq!(merged.windows[0].remaining, Some(99.0));
        assert_eq!(merged.windows[1].window_id, "seven-day");
        assert_eq!(merged.windows[1].remaining, Some(62.0));
    }

    #[test]
    fn quota_claude_role_arbitration_prefers_fresh_codexbar_over_stale_statusline() {
        let fetched_at =
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test fetched time");
        let stale_observed_at = fetched_at - chrono::Duration::days(10);
        let statusline_snapshot = ClaudeStatuslineSnapshot {
            schema_version: 1,
            observed_at: format_timestamp(stale_observed_at),
            windows: vec![
                ClaudeStatuslineWindow {
                    window_id: "five-hour".to_string(),
                    used_percent: 2.0,
                    resets_at: format_timestamp(fetched_at + chrono::Duration::hours(1)),
                },
                ClaudeStatuslineWindow {
                    window_id: "seven-day".to_string(),
                    used_percent: 9.0,
                    resets_at: format_timestamp(fetched_at + chrono::Duration::days(1)),
                },
            ],
        };
        let stale_statusline = claude_envelope_from_snapshot(statusline_snapshot, fetched_at);
        assert_eq!(stale_statusline.status, QuotaStatus::Stale);
        let fresh_codexbar = parse_fallback_cli_claude_output(
            serde_json::json!({
                "provider": "claude",
                "source": "web",
                "usage": {
                    "updatedAt": format_timestamp(fetched_at),
                    "primary": { "usedPercent": 0.0, "windowMinutes": 300 },
                    "secondary": { "usedPercent": 38.0, "windowMinutes": 10080 }
                }
            })
            .to_string()
            .as_bytes(),
            fetched_at,
        )
        .expect("fresh codexbar");

        let merged = merge_claude_provider_envelopes(&[stale_statusline, fresh_codexbar])
            .expect("merged fresh observations");
        assert_eq!(merged.windows.len(), 2);
        assert_eq!(merged.windows[0].window_id, "codexbar-primary");
        assert_eq!(merged.windows[0].remaining, Some(100.0));
        assert_eq!(merged.windows[1].window_id, "codexbar-secondary");
        assert_eq!(merged.windows[1].remaining, Some(62.0));
    }

    #[test]
    fn quota_claude_role_arbitration_normalizes_historical_all_models_week() {
        let fetched_at =
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test fetched time");
        let mut codexbar = parse_fallback_cli_claude_output(
            serde_json::json!({
                "provider": "claude",
                "source": "web",
                "usage": {
                    "updatedAt": format_timestamp(fetched_at),
                    "primary": { "usedPercent": 0.0, "windowMinutes": 300 },
                    "secondary": { "usedPercent": 38.0, "windowMinutes": 10080 }
                }
            })
            .to_string()
            .as_bytes(),
            fetched_at,
        )
        .expect("codexbar");
        codexbar.windows[1].window_id = "codexbar-claude-weekly-scoped-ll-models".to_string();
        codexbar.windows[1].window_label = "ll models only".to_string();

        let merged = merge_claude_provider_envelopes(&[codexbar]).expect("merged historical week");
        assert_eq!(merged.windows.len(), 2);
        assert_eq!(merged.windows[1].window_id, "codexbar-secondary");
        assert_eq!(merged.windows[1].window_label, "Secondary window");
        assert_eq!(merged.windows[1].remaining, Some(62.0));
    }

    #[test]
    fn quota_stale_only_observation_does_not_refresh_last_good_timestamp() {
        let fetched_at =
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test fetched time");
        let stale = claude_envelope_from_snapshot(
            ClaudeStatuslineSnapshot {
                schema_version: 1,
                observed_at: format_timestamp(fetched_at - chrono::Duration::days(10)),
                windows: vec![ClaudeStatuslineWindow {
                    window_id: "five-hour".to_string(),
                    used_percent: 2.0,
                    resets_at: format_timestamp(fetched_at + chrono::Duration::hours(1)),
                }],
            },
            fetched_at,
        );
        assert_eq!(stale.status, QuotaStatus::Stale);
        assert!(!is_direct_source_observation(&stale));

        let fresh = parse_fallback_cli_claude_output(
            serde_json::json!({
                "provider": "claude",
                "source": "web",
                "usage": {
                    "updatedAt": format_timestamp(fetched_at),
                    "primary": { "usedPercent": 0.0, "windowMinutes": 300 }
                }
            })
            .to_string()
            .as_bytes(),
            fetched_at,
        )
        .expect("fresh codexbar");
        assert!(is_direct_source_observation(&fresh));
    }

    #[test]
    fn quota_claude_native_tries_every_candidate_before_fresh_retry() {
        let candidates = vec![PathBuf::from("desktop"), PathBuf::from("standalone")];
        let mut calls = Vec::new();
        let output = capture_claude_cli_usage_from_candidates_with(
            &candidates,
            Duration::from_secs(1),
            |candidate, _| {
                calls.push(candidate.to_path_buf());
                if candidate == Path::new("desktop") {
                    Err(ClaudeNativeFailure::UsageUnavailable)
                } else {
                    Ok(b"Current session\n93% left".to_vec())
                }
            },
        )
        .expect("standalone fallback should succeed");

        assert_eq!(output, b"Current session\n93% left");
        assert_eq!(calls, candidates);
    }

    #[test]
    fn quota_claude_native_retries_unavailable_capture_in_fresh_session() {
        let candidates = vec![PathBuf::from("desktop"), PathBuf::from("standalone")];
        let mut calls = Vec::new();
        let output = capture_claude_cli_usage_from_candidates_with(
            &candidates,
            Duration::from_secs(1),
            |candidate, _| {
                calls.push(candidate.to_path_buf());
                if calls.len() <= candidates.len() {
                    Err(ClaudeNativeFailure::UsageUnavailable)
                } else {
                    Ok(b"Current session\n93% left".to_vec())
                }
            },
        )
        .expect("fresh retry should succeed");

        assert_eq!(output, b"Current session\n93% left");
        assert_eq!(
            calls,
            vec![
                candidates[0].clone(),
                candidates[1].clone(),
                candidates[0].clone()
            ]
        );
    }

    #[test]
    fn quota_claude_native_probe_disables_deep_link_registration() {
        let directory = TestAppData::new("claude-native-probe-settings");
        let claude_dir = directory.path.join("ClaudeProbe/.claude");
        fs::create_dir_all(&claude_dir).expect("create probe settings directory");
        fs::write(
            claude_dir.join("settings.local.json"),
            br#"{"preserved":true}"#,
        )
        .expect("write existing probe settings");

        let probe = prepare_claude_probe_directory(&directory.path)
            .expect("prepare isolated Claude probe directory");
        assert_eq!(probe, directory.path.join("ClaudeProbe"));
        let settings: Value = serde_json::from_slice(
            &fs::read(claude_dir.join("settings.local.json")).expect("read probe settings"),
        )
        .expect("parse probe settings");
        assert_eq!(settings["preserved"], Value::Bool(true));
        assert_eq!(settings["disableDeepLinkRegistration"], "disable");
    }

    #[cfg(unix)]
    #[test]
    fn quota_claude_native_probe_rejects_redirected_directory() {
        use std::os::unix::fs::symlink;

        let directory = TestAppData::new("claude-native-probe-symlink");
        let outside = directory.path.join("outside");
        fs::create_dir_all(&outside).expect("create outside directory");
        symlink(&outside, directory.path.join("ClaudeProbe")).expect("redirect probe directory");

        assert_eq!(
            prepare_claude_probe_directory(&directory.path),
            Err(ClaudeNativeFailure::CliUnavailable)
        );
        assert!(!outside.join(".claude/settings.local.json").exists());
    }

    #[test]
    fn quota_claude_native_cli_fails_closed_for_unavailable_or_invalid_usage() {
        assert_eq!(
            parse_claude_cli_usage(b"Error: Failed to load usage data", Utc::now()),
            Err(ClaudeNativeFailure::UsageUnavailable)
        );
        assert_eq!(
            parse_claude_cli_usage(b"Current session\n101% used", Utc::now()),
            Err(ClaudeNativeFailure::ResponseInvalid)
        );
        assert_eq!(
            parse_claude_cli_usage(
                b"You are currently using your subscription for Claude Code usage",
                Utc::now(),
            ),
            Err(ClaudeNativeFailure::SubscriptionUnavailable)
        );
    }

    #[cfg(unix)]
    #[test]
    fn quota_claude_native_pty_sends_usage_after_startup_without_running_codexbar() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestAppData::new("claude-native-pty");
        let program = directory.path.join("fake-claude");
        fs::write(
            &program,
            concat!(
                "#!/bin/sh\n",
                "printf 'Claude ready\\n'\n",
                "IFS= read -r command\n",
                "printf 'Current session\\n93%% left\\nCurrent week (all models)\\n79%% left\\n'\n",
                "sleep 3\n",
            ),
        )
        .expect("write fake Claude CLI");
        let mut permissions = fs::metadata(&program)
            .expect("fake CLI metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&program, permissions).expect("mark fake CLI executable");

        let output = capture_claude_cli_usage(&program, &directory.path)
            .expect("capture fake Claude PTY usage");
        let envelope =
            parse_claude_cli_usage(&output, Utc::now()).expect("parse fake Claude PTY usage");
        assert_eq!(envelope.windows.len(), 2);
        assert_eq!(envelope.windows[0].used, Some(7.0));
        assert_eq!(envelope.windows[1].used, Some(21.0));
    }

    #[test]
    fn quota_codexbar_last_good_failure_keeps_the_codexbar_settings_action() {
        let fetched_at =
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test fetched time");
        let payload = serde_json::json!({
            "provider": "claude",
            "source": "web",
            "usage": {
                "updatedAt": "2030-03-17T17:46:40Z",
                "primary": {
                    "usedPercent": 27.5,
                    "windowMinutes": 300,
                    "resetsAt": "2030-03-17T19:46:40Z"
                }
            }
        });
        let live = parse_fallback_cli_claude_output(payload.to_string().as_bytes(), fetched_at)
            .expect("parse CodexBar Claude output");

        let stale = stale_from_last_good(
            &live,
            "claude_codexbar_timeout",
            fetched_at + chrono::Duration::minutes(1),
        );

        assert_eq!(stale.status, QuotaStatus::Stale);
        assert_eq!(
            stale.action.as_ref().map(|action| action.value.as_str()),
            Some("claude-local")
        );
        assert_eq!(
            stale
                .action
                .as_ref()
                .map(|action| action.label_key.as_str()),
            Some("quota.action.reviewClaudeCodexBar")
        );
    }

    #[test]
    fn quota_claude_invalid_input_does_not_replace_the_last_valid_snapshot() {
        let directory = TestAppData::new("claude-atomic-reject");
        let observed_at =
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test observed time");
        let valid = serde_json::json!({
            "rate_limits": {
                "five_hour": { "used_percentage": 20.0, "resets_at": 1_900_010_000 }
            }
        });
        process_claude_statusline_input(valid.to_string().as_bytes(), &directory.path, observed_at)
            .expect("write valid Claude snapshot");
        let before = fs::read(directory.path.join(CLAUDE_STATUSLINE_FILE))
            .expect("read first Claude snapshot");
        let invalid = serde_json::json!({
            "rate_limits": {
                "five_hour": { "used_percentage": 101.0, "resets_at": 1_900_010_000 }
            },
            "secret": "MUST_NOT_PERSIST"
        });
        assert_eq!(
            process_claude_statusline_input(
                invalid.to_string().as_bytes(),
                &directory.path,
                observed_at,
            ),
            Err(SnapshotFailure::Invalid)
        );
        let after = fs::read(directory.path.join(CLAUDE_STATUSLINE_FILE))
            .expect("read unchanged Claude snapshot");
        assert_eq!(after, before);
        assert!(!String::from_utf8_lossy(&after).contains("MUST_NOT_PERSIST"));
    }

    #[test]
    fn quota_claude_missing_and_stale_snapshots_degrade_honestly() {
        let directory = TestAppData::new("claude-degrade");
        let observed_at =
            DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test observed time");
        let missing = claude_envelope_from_app_data(&directory.path, observed_at);
        assert_eq!(missing.status, QuotaStatus::Error);
        assert_eq!(
            missing.reason_code.as_deref(),
            Some("claude_statusline_snapshot_missing")
        );

        let valid = serde_json::json!({
            "rate_limits": {
                "seven_day": { "used_percentage": 55.0, "resets_at": 1_900_600_000 }
            }
        });
        process_claude_statusline_input(valid.to_string().as_bytes(), &directory.path, observed_at)
            .expect("write stale-test snapshot");
        let stale = claude_envelope_from_app_data(
            &directory.path,
            observed_at + chrono::Duration::minutes(16),
        );
        assert_eq!(stale.status, QuotaStatus::Stale);
        assert_eq!(stale.windows[0].status, QuotaWindowStatus::Stale);
        assert_eq!(stale.reason_code.as_deref(), Some("observation_stale"));
    }

    #[test]
    fn quota_persisted_last_good_recovers_after_restart_without_raw_source() {
        let directory = TestAppData::new("lkg-restart");
        let now = DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test time");
        let observation = parse_app_server_observation(serde_json::json!({
            "rateLimits": {
                "planType": "test-plan",
                "primary": { "usedPercent": 35, "windowDurationMins": 300, "resetsAt": 1_900_010_000 }
            }
        }))
        .expect("parse persisted test observation");
        let live = codex_envelope_from_app_server(observation, now);
        persist_last_good(&directory.path, CODEX_LAST_GOOD_FILE, &live, now)
            .expect("persist normalized LKG");

        let restored = finalize_with_persisted_last_good(
            &directory.path,
            CODEX_LAST_GOOD_FILE,
            CODEX_PROVIDER_ID,
            codex_error("app_server_timeout"),
            now + chrono::Duration::minutes(1),
        );
        assert_eq!(restored.status, QuotaStatus::Stale);
        assert_eq!(restored.capability, QuotaCapability::Stable);
        assert_eq!(restored.windows[0].used, Some(35.0));
        assert_eq!(restored.reason_code.as_deref(), Some("app_server_timeout"));
        let persisted = fs::read_to_string(directory.path.join(CODEX_LAST_GOOD_FILE))
            .expect("read persisted envelope");
        assert!(!persisted.contains("rateLimits"));
        assert!(!persisted.contains("app-server"));
    }

    #[test]
    fn quota_persisted_last_good_rejects_expired_entries_and_disable_removes_them() {
        let directory = TestAppData::new("lkg-expired-disable");
        let now = DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test time");
        let live = codex_envelope_from_event(synthetic_event(now, 45.0), now);
        let expired = PersistedEnvelope {
            schema_version: 1,
            stored_at: format_timestamp(now - chrono::Duration::days(31)),
            envelope: live,
        };
        atomic_write_private(
            &directory.path,
            CODEX_LAST_GOOD_FILE,
            &serde_json::to_vec(&expired).expect("serialize expired LKG"),
        )
        .expect("write expired LKG");
        let unavailable = codex_error("app_server_unavailable");
        let rejected = finalize_with_persisted_last_good(
            &directory.path,
            CODEX_LAST_GOOD_FILE,
            CODEX_PROVIDER_ID,
            unavailable.clone(),
            now,
        );
        assert_eq!(rejected, unavailable);

        persist_last_good(
            &directory.path,
            CODEX_LAST_GOOD_FILE,
            &codex_envelope_from_event(synthetic_event(now, 50.0), now),
            now,
        )
        .expect("replace with active LKG");
        assert!(directory.path.join(CODEX_LAST_GOOD_FILE).is_file());
        remove_persisted_snapshot(&directory.path, CODEX_LAST_GOOD_FILE);
        assert!(!directory.path.join(CODEX_LAST_GOOD_FILE).exists());
    }

    #[test]
    fn quota_session_file_limit_retains_the_newest_files_after_complete_enumeration() {
        let directory = TestAppData::new("newest-session-file-selection");
        let root = directory.path.join("codex-home");
        let sessions = root.join("sessions");
        fs::create_dir_all(&sessions).expect("create synthetic sessions directory");
        for index in 0..65 {
            fs::write(sessions.join(format!("old-{index:02}.jsonl")), b"{}\n")
                .expect("write old synthetic session");
        }
        thread::sleep(Duration::from_millis(25));
        let newest = sessions.join("newest.jsonl");
        fs::write(&newest, b"{}\n").expect("write newest synthetic session");

        let sessions_root = canonical_sessions_root(&root).expect("canonical sessions root");
        // R-55: this test only exercises the bounded newest-file selection
        // (`max_session_files`), not the product's 750 ms scan-duration
        // budget. Under machine load, 66 small files can occasionally take
        // longer than 750 ms to enumerate, which made this test flaky with
        // `SourceScanTruncated` — unrelated to the behavior under test. Use a
        // generous test-only duration so wall-clock load never trips it,
        // while keeping every other limit (including `max_session_files`)
        // identical to `DEFAULT_SCAN_LIMITS`; the product's own 750 ms limit
        // is unchanged.
        let generous_scan_limits = ScanLimits {
            max_scan_duration: Duration::from_secs(30),
            ..DEFAULT_SCAN_LIMITS
        };
        let files = collect_session_files(&sessions_root, generous_scan_limits, Instant::now())
            .expect("select bounded newest session files");
        assert_eq!(files.len(), generous_scan_limits.max_session_files);
        let newest = fs::canonicalize(newest).expect("canonical newest session");
        assert!(files.iter().any(|session| session.canonical_path == newest));
    }

    #[test]
    fn quota_final_authorization_gate_wins_writes_released_after_revocation() {
        let directory = TestAppData::new("revocation-write-race");
        let now = DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("test time");
        let barrier = Arc::new(Barrier::new(3));
        let codex_app_data = directory.path.clone();
        let codex_barrier = barrier.clone();
        let codex_writer = thread::spawn(move || {
            codex_barrier.wait();
            finalize_with_persisted_last_good(
                &codex_app_data,
                CODEX_LAST_GOOD_FILE,
                CODEX_PROVIDER_ID,
                codex_envelope_from_event(synthetic_event(now, 47.0), now),
                now,
            )
        });
        let claude_app_data = directory.path.clone();
        let claude_barrier = barrier.clone();
        let claude_writer = thread::spawn(move || {
            let input = serde_json::json!({
                "rate_limits": {
                    "five_hour": {
                        "used_percentage": 29.0,
                        "resets_at": now.timestamp() + 3_600
                    }
                }
            })
            .to_string();
            claude_barrier.wait();
            process_claude_statusline_input(input.as_bytes(), &claude_app_data, now)
                .expect("write late Claude status-line snapshot");
        });

        // Model the worst interleaving: revocation clears existing state, then
        // already-authorized workers finish their writes before the command's
        // final persisted-settings authorization check.
        clear_disabled_provider_data(&directory.path, false, false, false, false, false);
        barrier.wait();
        let codex = codex_writer.join().expect("join late Codex writer");
        claude_writer.join().expect("join late Claude writer");
        let claude = claude_envelope_from_app_data(&directory.path, now);
        let mut providers = vec![codex, claude];
        enforce_current_authorization(
            &directory.path,
            false,
            false,
            false,
            false,
            false,
            &mut providers,
        );

        assert!(providers
            .iter()
            .all(|provider| provider.status == QuotaStatus::AuthRequired));
        assert!(providers.iter().all(|provider| provider.windows.is_empty()));
        for file_name in [
            CODEX_LAST_GOOD_FILE,
            CLAUDE_STATUSLINE_FILE,
            CLAUDE_LAST_GOOD_FILE,
            ANTIGRAVITY_LAST_GOOD_FILE,
        ] {
            assert!(!directory.path.join(file_name).exists());
        }
    }

    #[test]
    fn disabling_providers_removes_every_normalized_quota_snapshot() {
        let directory = TestAppData::new("disable-all-snapshots");
        for file_name in [
            CODEX_LAST_GOOD_FILE,
            CLAUDE_STATUSLINE_FILE,
            CLAUDE_LAST_GOOD_FILE,
            ANTIGRAVITY_LAST_GOOD_FILE,
        ] {
            atomic_write_private(&directory.path, file_name, b"{}")
                .expect("write disposable snapshot");
        }

        clear_disabled_provider_data(&directory.path, false, false, false, false, false);

        for file_name in [
            CODEX_LAST_GOOD_FILE,
            CLAUDE_STATUSLINE_FILE,
            CLAUDE_LAST_GOOD_FILE,
            ANTIGRAVITY_LAST_GOOD_FILE,
        ] {
            assert!(!directory.path.join(file_name).exists());
        }
    }
}

#[cfg(test)]
mod claude_statusline_chain_tests {
    use super::*;

    struct TempAppData(PathBuf);

    impl TempAppData {
        fn new(label: &str) -> Self {
            let counter = ATOMIC_FILE_COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
            let path = env::temp_dir().join(format!(
                "tokenledger-claude-chain-{label}-{}-{counter}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create chain test appdata");
            Self(path)
        }
    }

    impl Drop for TempAppData {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn input() -> Vec<u8> {
        serde_json::json!({
            "rate_limits": {
                "five_hour": { "used_percentage": 12.0, "resets_at": 1_900_010_000 },
                "seven_day": { "used_percentage": 40.0, "resets_at": 1_900_100_000 }
            }
        })
        .to_string()
        .into_bytes()
    }

    fn record(app_data_dir: &Path) -> impl FnOnce(&[u8]) -> Result<String, &'static str> + '_ {
        move |input| {
            let observed_at = DateTime::<Utc>::from_timestamp(1_900_000_000, 0).expect("time");
            process_claude_statusline_input(input, app_data_dir, observed_at)
                .map_err(|_| "claude_statusline_snapshot_not_updated")
        }
    }

    fn chain(app_data_dir: &Path, command: &str) {
        let body = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "statusLine": { "type": "command", "command": command }
        }))
        .expect("chain body");
        write_private_app_data_file(app_data_dir, "claude-statusline-chain-v1.json", &body)
            .expect("write chain");
    }

    #[test]
    fn claude_helper_without_original_prints_the_short_summary() {
        let app = TempAppData::new("summary");
        let line = claude_statusline_output(&app.0, &input(), true, record(&app.0));
        assert_eq!(line, Ok("Claude 5h 12% · 7d 40%".to_string()));
        assert!(app.0.join(CLAUDE_STATUSLINE_FILE).is_file());
    }

    #[cfg(unix)]
    #[test]
    fn claude_helper_records_snapshot_before_running_the_original() {
        let app = TempAppData::new("chain");
        let marker = app.0.join("seen.txt");
        let snapshot = app.0.join(CLAUDE_STATUSLINE_FILE);
        chain(
            &app.0,
            &format!(
                "test -f '{}' && cat > '{}'; printf 'my line\\n'",
                snapshot.display(),
                marker.display()
            ),
        );
        let line = claude_statusline_output(&app.0, &input(), true, record(&app.0));
        assert_eq!(line, Ok("my line".to_string()));
        assert_eq!(fs::read(&marker).expect("original got stdin"), input());
    }

    #[cfg(unix)]
    #[test]
    fn claude_helper_original_failure_does_not_lose_the_snapshot() {
        let app = TempAppData::new("chain-fail");
        chain(&app.0, "echo boom >&2; exit 7");
        let line = claude_statusline_output(&app.0, &input(), true, record(&app.0));
        assert_eq!(line, Ok(String::new()));
        assert!(app.0.join(CLAUDE_STATUSLINE_FILE).is_file());
    }

    #[test]
    fn claude_helper_with_original_ignores_invalid_quota_input() {
        let app = TempAppData::new("chain-invalid");
        chain(
            &app.0,
            if cfg!(windows) {
                "echo ok"
            } else {
                "printf ok"
            },
        );
        let line = claude_statusline_output(&app.0, b"not json", true, record(&app.0));
        assert_eq!(
            line.map(|text| text.trim().to_string()),
            Ok("ok".to_string())
        );
        assert!(!app.0.join(CLAUDE_STATUSLINE_FILE).exists());
    }
}
