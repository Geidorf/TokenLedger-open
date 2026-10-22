//! Opt-in, local-only project dimension (T10.155 spec, user decision D5②).
//!
//! Off by default. Only after the user enables it does TokenLedger read each
//! session's working directory — from the header or metadata field the spec
//! names, in the same tool data the scanners read — and store nothing but the
//! derived last-level folder name (or a fixed group such as “home”) per
//! `(tool, session_id)` in two local tables (schema v13). Full paths exist
//! only in memory during one pass (the per-source lookup indexes are dropped
//! when it ends) and are never stored or logged. A home directory, anything
//! above it and the account name never become a project name. Disabling
//! stops all reading and purges every stored name. Nothing here is synced,
//! exported or logged with a path.
//!
//! Layout: [`label`] derives names (pure), [`git_probe`] is the optional
//! `.git` locator (off, see [`GIT_PROBE_ENABLED`]), [`json_probe`] reads
//! whitelisted JSON fields, [`sources`] finds each session's directory,
//! [`store`] persists under a generation guard; this file orchestrates passes
//! and exposes the Tauri commands.

pub(crate) mod behavior_view;
mod git_probe;
mod json_probe;
mod label;
mod sources;
mod store;
#[cfg(test)]
mod tests;

use crate::app_paths::AppContext;
use git_probe::{FsGitProbe, GitProbe, NoGitProbe};
use label::{derive_project, HostEnv, ProjectRef, Resolution, ResolverInput};
use serde::Serialize;
use sources::{Lookup, SourceContext, SourceFamily, SourceRoots};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use store::{BackfillStatus, IndexState, SessionPair, SessionProject};
use tauri::Emitter;

/// Consent version of the settings copy the user confirms (spec §3.1 step 5).
/// Raise it when the read scope grows; stored consent below it pauses
/// collection until the user confirms again.
pub(crate) const PROJECT_DIMENSION_CONSENT_VERSION: i64 = 1;

/// Open user question Q2: the git probe looks at where `.git` is and reads at
/// most a `.git` file and `commondir` (4 KiB each). Until the user accepts
/// it, this single switch keeps it off and only the string rules apply.
pub(crate) const GIT_PROBE_ENABLED: bool = false;

/// Raise when extraction or derivation rules change; rows written under an
/// older version are recomputed by the next full pass. Version 2: the
/// T10.165 P3 privacy round changed the name rules (root decision R-33).
pub(crate) const RESOLVER_VERSION: i64 = 2;

/// Sessions per committed batch (spec §4.2 step 3).
const BATCH_SIZE: usize = 200;

/// Retryable outcomes (`source_missing`, `source_unreadable`,
/// `field_missing`) are retried by a startup pass at most this often; a
/// session with new ledger rows, a rebuild or a rule change retries at once.
pub(crate) const RETRY_AFTER_DAYS: i64 = 7;

const EVENT_PROGRESS: &str = "project-index-progress";
const EVENT_UPDATED: &str = "project-index-updated";

/// Resolver version as stored: rule version and git-probe switch together,
/// so flipping the switch recomputes every row.
pub(crate) fn effective_resolver_version() -> i64 {
    RESOLVER_VERSION * 2 + i64::from(GIT_PROBE_ENABLED)
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

/// Pass kinds, cheapest first; concurrent requests merge to the largest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum PassKind {
    /// After a scan persisted rows: sessions with ledger rows above the
    /// watermark that have no index row, a retryable outcome (the session is
    /// active again) or an outdated rule version.
    Incremental,
    /// First scan after the process starts (review P2-4): orphan cleanup in
    /// small batches, sessions without any index row (also below the
    /// watermark), retryable outcomes last tried [`RETRY_AFTER_DAYS`] ago or
    /// earlier, and the incremental work. Current rows are never redone.
    Startup,
    /// Every session: orphan cleanup, rows of an older generation or rule
    /// version, and every retryable outcome (enable, rebuild, rule or switch
    /// change, an unfinished backfill, or retrying a failed one at start).
    Full,
}

/// Everything a pass touches outside the ledger, injected so tests can prove
/// what is (not) read.
pub(crate) struct PassDeps<'a> {
    pub(crate) roots: &'a dyn Fn() -> SourceRoots,
    pub(crate) host: &'a dyn Fn() -> HostEnv,
    pub(crate) git: &'a dyn GitProbe,
    pub(crate) cancelled: &'a dyn Fn() -> bool,
    pub(crate) progress: &'a dyn Fn(i64, i64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PassOutcome {
    /// Collection is off (or consent is outdated): nothing was read.
    NotCollecting,
    /// The generation changed underneath (disable or rebuild); nothing
    /// further was written.
    Stale,
    Cancelled,
    Completed {
        resolved: usize,
        skipped: usize,
    },
}

/// Fixed reason codes for pass failures (spec §3.8).
const CODE_DATABASE: &str = "database_error";
const CODE_INTERNAL: &str = "internal_error";

pub(crate) fn run_pass(
    db_path: &Path,
    requested: PassKind,
    deps: &PassDeps<'_>,
) -> Result<PassOutcome, &'static str> {
    let mut conn = store::open(db_path).map_err(|_| CODE_DATABASE)?;
    let state = store::load_state(&conn).map_err(|_| CODE_DATABASE)?;
    if !state.collecting() {
        return Ok(PassOutcome::NotCollecting);
    }
    let resolver_version = effective_resolver_version();
    let kind = effective_kind(&state, requested, resolver_version);
    let result = run_pass_inner(&mut conn, &state, kind, resolver_version, deps);
    if result.is_err() && kind == PassKind::Full {
        let _ = store::update_progress(
            &mut conn,
            state.generation,
            BackfillStatus::Failed,
            0,
            0,
            None,
            Some(CODE_DATABASE),
        );
    }
    result
}

/// The pass that actually runs for a request (review P2-4, P3-3):
/// - an unfinished full pass (`running`) resumes as a full pass;
/// - after a failed full pass only a startup or full request retries it, so
///   a persistent error costs one attempt per start, not one per scan;
///   incremental requests keep indexing new sessions meanwhile;
/// - a rule or git-probe switch change upgrades to a full pass.
pub(crate) fn effective_kind(
    state: &IndexState,
    requested: PassKind,
    resolver_version: i64,
) -> PassKind {
    match state.backfill_status {
        BackfillStatus::Running => PassKind::Full,
        BackfillStatus::Failed if requested == PassKind::Incremental => PassKind::Incremental,
        BackfillStatus::Failed => PassKind::Full,
        _ if state.resolver_version != resolver_version => PassKind::Full,
        _ => requested,
    }
}

/// One session to resolve.
struct WorkItem {
    tool: String,
    session_id: String,
    family: SourceFamily,
}

impl From<SessionPair> for WorkItem {
    fn from(pair: SessionPair) -> Self {
        Self {
            family: SourceFamily::from_unique_key(&pair.min_unique_key),
            tool: pair.tool,
            session_id: pair.session_id,
        }
    }
}

fn run_pass_inner(
    conn: &mut rusqlite::Connection,
    state: &IndexState,
    kind: PassKind,
    resolver_version: i64,
    deps: &PassDeps<'_>,
) -> Result<PassOutcome, &'static str> {
    let db = |_: rusqlite::Error| CODE_DATABASE;
    let generation = state.generation;
    let through_id = store::max_log_id(conn).map_err(db)?;

    // Orphans: read without holding the write lock, then delete in small
    // guarded batches so scans are never kept waiting (review P2-4).
    if kind != PassKind::Incremental {
        let orphans = store::orphan_keys(conn).map_err(db)?;
        for chunk in orphans.chunks(BATCH_SIZE) {
            if (deps.cancelled)() {
                return Ok(PassOutcome::Cancelled);
            }
            if store::delete_sessions(conn, generation, chunk)
                .map_err(db)?
                .is_none()
            {
                return Ok(PassOutcome::Stale);
            }
        }
    }

    let Some((work, skipped)) = plan_work(conn, state, kind, resolver_version, through_id, deps)?
    else {
        return Ok(PassOutcome::Cancelled);
    };

    let total = work.len() as i64;
    if !work.is_empty() && kind == PassKind::Full {
        let current = store::update_progress(
            conn,
            generation,
            BackfillStatus::Running,
            0,
            total,
            None,
            None,
        )
        .map_err(db)?;
        if !current {
            return Ok(PassOutcome::Stale);
        }
        (deps.progress)(0, total);
    }

    let mut resolved = 0usize;
    if !work.is_empty() {
        // Source locations and host facts are looked up only when there is
        // something to resolve.
        let roots = (deps.roots)();
        let host = (deps.host)();
        let mut context = SourceContext::new(&roots, deps.cancelled);
        let mut batch: Vec<SessionProject> = Vec::with_capacity(BATCH_SIZE);
        for item in &work {
            if (deps.cancelled)() {
                return Ok(PassOutcome::Cancelled);
            }
            let project =
                resolve_session(&mut context, item.family, &item.session_id, &host, deps.git);
            batch.push(SessionProject {
                tool: item.tool.clone(),
                session_id: item.session_id.clone(),
                source_family: item.family.as_str(),
                project,
            });
            if batch.len() >= BATCH_SIZE {
                if !store::write_batch(conn, generation, resolver_version, &batch).map_err(db)? {
                    return Ok(PassOutcome::Stale);
                }
                resolved += batch.len();
                batch.clear();
                if kind == PassKind::Full {
                    let current = store::update_progress(
                        conn,
                        generation,
                        BackfillStatus::Running,
                        resolved as i64,
                        total,
                        None,
                        None,
                    )
                    .map_err(db)?;
                    if !current {
                        return Ok(PassOutcome::Stale);
                    }
                    (deps.progress)(resolved as i64, total);
                }
            }
        }
        if !batch.is_empty() {
            if !store::write_batch(conn, generation, resolver_version, &batch).map_err(db)? {
                return Ok(PassOutcome::Stale);
            }
            resolved += batch.len();
        }
    }

    let finished = match kind {
        PassKind::Full => store::update_progress(
            conn,
            generation,
            BackfillStatus::Done,
            resolved as i64,
            total,
            Some((through_id, resolver_version)),
            None,
        ),
        // Only a completed full pass certifies the rule version: keep the
        // stored one, status and failure code; just move the watermark.
        PassKind::Incremental | PassKind::Startup => store::update_progress(
            conn,
            generation,
            state.backfill_status,
            state.backfill_done,
            state.backfill_total,
            Some((through_id, state.resolver_version)),
            // A pending purge marker is kept by the store itself; passing a
            // stale copy could restore a marker a retry already cleared.
            state
                .last_failure
                .as_deref()
                .filter(|code| *code != store::PURGE_PENDING),
        ),
    }
    .map_err(db)?;
    if !finished {
        return Ok(PassOutcome::Stale);
    }
    if kind == PassKind::Full && total > 0 {
        (deps.progress)(resolved as i64, total);
    }
    Ok(PassOutcome::Completed { resolved, skipped })
}

/// Decides which sessions a pass resolves; `None` when cancelled. Reads
/// only: no write lock is held while planning.
fn plan_work(
    conn: &rusqlite::Connection,
    state: &IndexState,
    kind: PassKind,
    resolver_version: i64,
    through_id: i64,
    deps: &PassDeps<'_>,
) -> Result<Option<(Vec<WorkItem>, usize)>, &'static str> {
    let db = |_: rusqlite::Error| CODE_DATABASE;
    let after_id = match kind {
        PassKind::Full => 0,
        PassKind::Incremental | PassKind::Startup => state.indexed_through_id,
    };
    let pairs = if after_id < through_id {
        store::session_pairs(conn, after_id, through_id).map_err(db)?
    } else {
        Vec::new()
    };
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut work: Vec<WorkItem> = Vec::new();
    let mut skipped = 0usize;
    for pair in pairs {
        if (deps.cancelled)() {
            return Ok(None);
        }
        let existing = store::existing_row(conn, &pair.tool, &pair.session_id).map_err(db)?;
        let needs_work = match existing {
            None => true,
            Some(row) => {
                row.resolver_version != resolver_version
                    || (kind == PassKind::Full && row.generation < state.generation)
                    || row.resolution.is_none_or(Resolution::is_retryable)
            }
        };
        if needs_work {
            seen.insert((pair.tool.clone(), pair.session_id.clone()));
            work.push(pair.into());
        } else {
            skipped += 1;
        }
    }
    if kind == PassKind::Startup {
        for pair in store::unindexed_pairs(conn, after_id).map_err(db)? {
            if seen.insert((pair.tool.clone(), pair.session_id.clone())) {
                work.push(pair.into());
            }
        }
        for row in store::stale_retryable(conn, RETRY_AFTER_DAYS).map_err(db)? {
            let Some(family) = SourceFamily::parse(&row.source_family) else {
                continue;
            };
            if seen.insert((row.tool.clone(), row.session_id.clone())) {
                work.push(WorkItem {
                    tool: row.tool,
                    session_id: row.session_id,
                    family,
                });
            }
        }
    }
    Ok(Some((work, skipped)))
}

/// Looks up one session's directory and reduces it to a project at once; the
/// raw path is dropped before this returns.
fn resolve_session(
    context: &mut SourceContext<'_>,
    family: SourceFamily,
    session_id: &str,
    host: &HostEnv,
    git: &dyn GitProbe,
) -> ProjectRef {
    match context.lookup(family, session_id) {
        Lookup::Found(workdir) => derive_project(
            &ResolverInput {
                cwd: &workdir.cwd,
                repo_root: workdir.repo_root.as_deref(),
                default_workspace: workdir.default_workspace,
            },
            host,
            git,
        ),
        Lookup::Unresolved(resolution) => ProjectRef::unresolved(resolution),
    }
}

// ---------------------------------------------------------------------------
// Background worker
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Slot {
    running: bool,
    pending: Option<PassKind>,
    /// A startup or full pass was already requested in this process (first
    /// scan after start, or enable/rebuild); later scans ask for incremental
    /// passes only.
    startup_requested: bool,
    /// Bumped by disable and rebuild; a pass started under an older epoch
    /// stops at its next check.
    epoch: u64,
}

fn slots() -> MutexGuard<'static, HashMap<PathBuf, Slot>> {
    static SLOTS: OnceLock<Mutex<HashMap<PathBuf, Slot>>> = OnceLock::new();
    SLOTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn current_epoch(db_path: &Path) -> u64 {
    slots().get(db_path).map(|slot| slot.epoch).unwrap_or(0)
}

fn cancel_running_pass(db_path: &Path) {
    let mut slots = slots();
    let slot = slots.entry(db_path.to_path_buf()).or_default();
    slot.epoch = slot.epoch.wrapping_add(1);
    slot.pending = None;
}

fn request_pass(db_path: &Path, kind: PassKind) {
    {
        let mut slots = slots();
        let slot = slots.entry(db_path.to_path_buf()).or_default();
        if kind >= PassKind::Startup {
            slot.startup_requested = true;
        }
        slot.pending = Some(slot.pending.map_or(kind, |pending| pending.max(kind)));
        // Unit tests drive passes explicitly with fixture sources; the real
        // worker would look at this machine's tool data.
        if slot.running || cfg!(test) {
            return;
        }
        slot.running = true;
    }
    let path = db_path.to_path_buf();
    let spawned = std::thread::Builder::new()
        .name("project-index".to_string())
        .spawn(move || worker_loop(path));
    if spawned.is_err() {
        log::warn!("project index worker could not start");
        if let Some(slot) = slots().get_mut(db_path) {
            slot.running = false;
        }
    }
}

/// Clears `running` if the worker thread unwinds anyway, so the next request
/// starts a new worker instead of leaving the index silently stopped.
struct RunningGuard(PathBuf);

impl Drop for RunningGuard {
    fn drop(&mut self) {
        if std::thread::panicking() {
            if let Some(slot) = slots().get_mut(&self.0) {
                slot.running = false;
            }
        }
    }
}

/// [`run_pass`] behind an unwind barrier (review P2-2): a panic inside a
/// pass marks the index `failed` with `internal_error` instead of stopping
/// the worker and leaving the state at “indexing”.
pub(crate) fn run_pass_guarded(
    db_path: &Path,
    kind: PassKind,
    deps: &PassDeps<'_>,
) -> Result<PassOutcome, &'static str> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_pass(db_path, kind, deps)
    })) {
        Ok(result) => result,
        Err(_) => {
            mark_failed(db_path, CODE_INTERNAL);
            Err(CODE_INTERNAL)
        }
    }
}

fn mark_failed(db_path: &Path, code: &'static str) {
    let Ok(mut conn) = store::open(db_path) else {
        return;
    };
    let Ok(state) = store::load_state(&conn) else {
        return;
    };
    if state.collecting() {
        let _ = store::update_progress(
            &mut conn,
            state.generation,
            BackfillStatus::Failed,
            state.backfill_done,
            state.backfill_total,
            None,
            Some(code),
        );
    }
}

fn worker_loop(db_path: PathBuf) {
    crate::lower_background_thread_priority();
    let _running = RunningGuard(db_path.clone());
    loop {
        let (kind, epoch) = {
            let mut slots = slots();
            let slot = slots.entry(db_path.clone()).or_default();
            match slot.pending.take() {
                Some(kind) => (kind, slot.epoch),
                None => {
                    slot.running = false;
                    return;
                }
            }
        };
        let cancelled = || current_epoch(&db_path) != epoch;
        let fs_probe;
        let git: &dyn GitProbe = if GIT_PROBE_ENABLED {
            fs_probe = FsGitProbe::new();
            &fs_probe
        } else {
            &NoGitProbe
        };
        let progress = |done: i64, total: i64| emit_progress(done, total);
        let deps = PassDeps {
            roots: &SourceRoots::detect,
            host: &HostEnv::detect,
            git,
            cancelled: &cancelled,
            progress: &progress,
        };
        match run_pass_guarded(&db_path, kind, &deps) {
            Ok(PassOutcome::Completed { resolved, skipped }) => {
                log::info!("project index pass done: resolved {resolved}, unchanged {skipped}");
                // Startup and full passes may also have removed orphans.
                if resolved > 0 || kind >= PassKind::Startup {
                    emit_updated(&db_path);
                }
            }
            Ok(PassOutcome::NotCollecting) => {}
            Ok(PassOutcome::Stale) | Ok(PassOutcome::Cancelled) => {
                log::debug!("project index pass superseded");
            }
            Err(code) => {
                log::warn!("project index pass failed: {code}");
                emit_updated(&db_path);
            }
        }
    }
}

/// Scan hook (spec §4.2 “增量解析”): called after `persist_scan_batch`
/// committed. Reads only the local state row; when the feature is off it
/// returns without touching any source. Either way it finishes a purge whose
/// WAL truncation was blocked (review P2-1, and after re-enabling P3-c).
/// Never fails the scan.
pub(crate) fn notify_scan_persisted(db_path: &Path, rows_changed: bool) {
    let Ok(conn) = crate::db::get_connection(db_path) else {
        return;
    };
    let Ok(state) = store::load_state(&conn) else {
        return;
    };
    if state.last_failure.as_deref() == Some(store::PURGE_PENDING) {
        let _ = store::retry_pending_purge(&conn);
    }
    if !state.collecting() {
        return;
    }
    drop(conn);
    let kind = {
        let slots = slots();
        match slots.get(db_path) {
            Some(slot) if slot.startup_requested => rows_changed.then_some(PassKind::Incremental),
            _ => Some(PassKind::Startup),
        }
    };
    if let Some(kind) = kind {
        request_pass(db_path, kind);
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

static EVENT_SINK: OnceLock<tauri::AppHandle> = OnceLock::new();

fn install_event_sink(app_handle: &tauri::AppHandle) {
    let _ = EVENT_SINK.set(app_handle.clone());
}

fn emit_progress(done: i64, total: i64) {
    if let Some(app) = EVENT_SINK.get() {
        let _ = app.emit(
            EVENT_PROGRESS,
            serde_json::json!({ "done": done, "total": total }),
        );
    }
}

fn emit_updated(db_path: &Path) {
    if let Some(app) = EVENT_SINK.get() {
        if let Ok(status) = status_impl(db_path) {
            let _ = app.emit(EVENT_UPDATED, status);
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackfillProgress {
    status: &'static str,
    done: i64,
    total: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PurgeReport {
    removed_sessions: usize,
    wal_truncated: bool,
}

/// Counts and codes only: never a project name or a path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectDimensionStatus {
    enabled: bool,
    /// `disabled` | `consent_required` | `indexing` | `ready` | `failed`
    /// (the same words as `meta.projectDimension.state` in the behavior contract)
    state: &'static str,
    consent_version: i64,
    required_consent_version: i64,
    git_probe_enabled: bool,
    backfill: BackfillProgress,
    indexed_sessions: i64,
    named_projects: i64,
    unresolved_sessions: i64,
    last_failure: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    purge: Option<PurgeReport>,
}

fn state_code(state: &IndexState) -> &'static str {
    if !state.enabled {
        "disabled"
    } else if !state.collecting() {
        "consent_required"
    } else {
        match state.backfill_status {
            BackfillStatus::Done => "ready",
            BackfillStatus::Failed => "failed",
            BackfillStatus::Running | BackfillStatus::Cancelled | BackfillStatus::Idle => {
                "indexing"
            }
        }
    }
}

pub(crate) fn status_impl(db_path: &Path) -> Result<ProjectDimensionStatus, String> {
    let conn = store::open(db_path).map_err(|_| CODE_DATABASE.to_string())?;
    // Reading the status also finishes a purge whose WAL truncation was
    // blocked; a no-op otherwise.
    let _ = store::retry_pending_purge(&conn);
    let state = store::load_state(&conn).map_err(|_| CODE_DATABASE.to_string())?;
    let counts = store::counts(&conn).map_err(|_| CODE_DATABASE.to_string())?;
    Ok(ProjectDimensionStatus {
        enabled: state.enabled,
        state: state_code(&state),
        consent_version: state.consent_version,
        required_consent_version: PROJECT_DIMENSION_CONSENT_VERSION,
        git_probe_enabled: GIT_PROBE_ENABLED,
        backfill: BackfillProgress {
            status: state.backfill_status.as_str(),
            done: state.backfill_done,
            total: state.backfill_total,
        },
        indexed_sessions: counts.sessions,
        named_projects: counts.named_projects,
        unresolved_sessions: counts.unresolved_sessions,
        last_failure: state.last_failure,
        purge: None,
    })
}

/// Enable (with the consent version the user confirmed) or disable. Disabling
/// cancels any running pass, deletes every stored project name and truncates
/// the WAL before returning.
pub(crate) fn set_impl(
    db_path: &Path,
    enabled: bool,
    consent_version: Option<i64>,
) -> Result<ProjectDimensionStatus, String> {
    if enabled {
        if consent_version != Some(PROJECT_DIMENSION_CONSENT_VERSION) {
            return Err("consent_version_mismatch".to_string());
        }
        let mut conn = store::open(db_path).map_err(|_| CODE_DATABASE.to_string())?;
        // Best effort: finish an earlier purge before names are stored again.
        // When readers still block it, enabling keeps the marker and the next
        // scan or status read retries (review P3-c).
        let _ = store::retry_pending_purge(&conn);
        let before = store::load_state(&conn).map_err(|_| CODE_DATABASE.to_string())?;
        let after = store::enable(&mut conn, PROJECT_DIMENSION_CONSENT_VERSION)
            .map_err(|_| CODE_DATABASE.to_string())?;
        if after.generation != before.generation {
            cancel_running_pass(db_path);
            request_pass(db_path, PassKind::Full);
        }
        log::info!("project dimension enabled");
        status_impl(db_path)
    } else {
        cancel_running_pass(db_path);
        let mut conn = store::open(db_path).map_err(|_| CODE_DATABASE.to_string())?;
        let purge = store::disable_and_purge(&mut conn).map_err(|_| CODE_DATABASE.to_string())?;
        let removed = purge.removed_sessions;
        let wal_truncated = purge.wal_truncated;
        log::info!(
            "project dimension disabled: purged {removed} sessions, wal truncated {wal_truncated}"
        );
        let mut status = status_impl(db_path)?;
        status.purge = Some(PurgeReport {
            removed_sessions: purge.removed_sessions,
            wal_truncated: purge.wal_truncated,
        });
        Ok(status)
    }
}

/// Recomputes every session with the current rules (for example after a
/// source reappeared). Existing names stay visible until replaced.
pub(crate) fn rebuild_impl(db_path: &Path) -> Result<ProjectDimensionStatus, String> {
    let mut conn = store::open(db_path).map_err(|_| CODE_DATABASE.to_string())?;
    cancel_running_pass(db_path);
    if store::begin_rebuild(&mut conn)
        .map_err(|_| CODE_DATABASE.to_string())?
        .is_none()
    {
        return Err("project_dimension_disabled".to_string());
    }
    request_pass(db_path, PassKind::Full);
    status_impl(db_path)
}

async fn run_blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| "project_index_task_failed".to_string())?
}

#[tauri::command]
pub async fn get_project_dimension_status(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<ProjectDimensionStatus, String> {
    install_event_sink(&app_handle);
    let db_path = crate::db::get_db_path(state.inner());
    run_blocking(move || status_impl(&db_path)).await
}

#[tauri::command]
pub async fn set_project_dimension(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppContext>>,
    enabled: bool,
    consent_version: Option<i64>,
) -> Result<ProjectDimensionStatus, String> {
    install_event_sink(&app_handle);
    let db_path = crate::db::get_db_path(state.inner());
    let status = run_blocking(move || set_impl(&db_path, enabled, consent_version)).await?;
    let _ = app_handle.emit(EVENT_UPDATED, &status);
    Ok(status)
}

#[tauri::command]
pub async fn rebuild_project_index(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<ProjectDimensionStatus, String> {
    install_event_sink(&app_handle);
    let db_path = crate::db::get_db_path(state.inner());
    let status = run_blocking(move || rebuild_impl(&db_path)).await?;
    let _ = app_handle.emit(EVENT_UPDATED, &status);
    Ok(status)
}
