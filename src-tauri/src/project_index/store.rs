//! Persistence of the project index (schema v13 tables).
//!
//! Every write that stores project data runs in an IMMEDIATE transaction that
//! first re-checks the state row: the feature must still be enabled with a
//! current consent and the pass's generation must still be current. A pass
//! that raced a disable or a rebuild therefore cannot write anything. Purges
//! run with `secure_delete` and are followed by a WAL truncation, so deleted
//! names do not linger in free pages or the write-ahead log.

use super::label::{ProjectRef, Resolution};
use super::PROJECT_DIMENSION_CONSENT_VERSION;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::path::Path;
use std::time::Duration;

/// `last_failure` after a purge whose WAL truncation was blocked by readers.
/// Name-free. It survives enabling, rebuilds and pass bookkeeping (review
/// P3-c), and is cleared only once a later truncation succeeds (next scan,
/// status read, enable or disable; see [`retry_pending_purge`]).
pub(crate) const PURGE_PENDING: &str = "purge_pending";

const WAL_TRUNCATE_ATTEMPTS: usize = 5;
const WAL_TRUNCATE_RETRY_DELAY: Duration = Duration::from_millis(50);
/// Short waits while truncating: a blocked purge is finished later instead of
/// holding up the caller.
const WAL_TRUNCATE_BUSY_TIMEOUT: Duration = Duration::from_millis(50);
/// Same as `db::get_connection`.
const CONNECTION_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackfillStatus {
    Idle,
    Running,
    Done,
    Cancelled,
    Failed,
}

impl BackfillStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "running" => Self::Running,
            "done" => Self::Done,
            "cancelled" => Self::Cancelled,
            "failed" => Self::Failed,
            _ => Self::Idle,
        }
    }
}

/// The single state row. It never holds a project name or a path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct IndexState {
    pub(crate) enabled: bool,
    pub(crate) consent_version: i64,
    pub(crate) generation: i64,
    pub(crate) backfill_status: BackfillStatus,
    pub(crate) backfill_total: i64,
    pub(crate) backfill_done: i64,
    /// Highest `token_logs.id` covered by a completed pass.
    pub(crate) indexed_through_id: i64,
    /// Effective resolver version of the last completed full pass.
    pub(crate) resolver_version: i64,
    pub(crate) last_failure: Option<String>,
}

impl Default for IndexState {
    fn default() -> Self {
        Self {
            enabled: false,
            consent_version: 0,
            generation: 0,
            backfill_status: BackfillStatus::Idle,
            backfill_total: 0,
            backfill_done: 0,
            indexed_through_id: 0,
            resolver_version: 0,
            last_failure: None,
        }
    }
}

impl IndexState {
    /// Collection may run: enabled with the current consent version. A lower
    /// consent version pauses collection and hides data (spec §3.1 step 5).
    pub(crate) fn collecting(&self) -> bool {
        self.enabled && self.consent_version >= PROJECT_DIMENSION_CONSENT_VERSION
    }
}

/// Opens the ledger for project-index work. `secure_delete` makes SQLite
/// overwrite deleted content instead of leaving it in free pages.
pub(crate) fn open(db_path: &Path) -> rusqlite::Result<Connection> {
    let conn = crate::db::get_connection(db_path)?;
    conn.pragma_update(None, "secure_delete", "ON")?;
    Ok(conn)
}

pub(crate) fn load_state(conn: &Connection) -> rusqlite::Result<IndexState> {
    let state = conn
        .query_row(
            "SELECT enabled, consent_version, generation, backfill_status, backfill_total,
                    backfill_done, indexed_through_id, resolver_version, last_failure
             FROM local_project_index_state WHERE id = 1",
            [],
            |row| {
                Ok(IndexState {
                    enabled: row.get::<_, i64>(0)? == 1,
                    consent_version: row.get(1)?,
                    generation: row.get(2)?,
                    backfill_status: BackfillStatus::parse(&row.get::<_, String>(3)?),
                    backfill_total: row.get(4)?,
                    backfill_done: row.get(5)?,
                    indexed_through_id: row.get(6)?,
                    resolver_version: row.get(7)?,
                    last_failure: row.get(8)?,
                })
            },
        )
        .optional()?;
    Ok(state.unwrap_or_default())
}

/// Turns collection on (or re-confirms a newer consent). Returns the new
/// state; a no-op when already collecting under the same consent.
pub(crate) fn enable(conn: &mut Connection, consent_version: i64) -> rusqlite::Result<IndexState> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = load_state(&tx)?;
    if current.enabled && current.consent_version == consent_version {
        tx.commit()?;
        return Ok(current);
    }
    if !current.enabled {
        // Normally already empty (disable purges); defensive for restored
        // databases so a fresh consent never inherits old names.
        tx.execute("DELETE FROM local_session_projects", [])?;
    }
    // A pending purge marker is kept: the old names may still sit in WAL
    // frames until a later truncation succeeds (review P3-c).
    tx.execute(
        "INSERT INTO local_project_index_state
            (id, enabled, consent_version, generation, backfill_status, backfill_total,
             backfill_done, indexed_through_id, resolver_version, last_failure)
         VALUES (1, 1, ?1, 1, 'running', 0, 0, 0, 0, NULL)
         ON CONFLICT(id) DO UPDATE SET
            enabled = 1,
            consent_version = excluded.consent_version,
            generation = generation + 1,
            backfill_status = 'running',
            backfill_total = 0,
            backfill_done = 0,
            indexed_through_id = 0,
            resolver_version = 0,
            last_failure = CASE WHEN last_failure = ?2 THEN last_failure END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        params![consent_version, PURGE_PENDING],
    )?;
    let state = load_state(&tx)?;
    tx.commit()?;
    Ok(state)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PurgeOutcome {
    pub(crate) removed_sessions: usize,
    /// The write-ahead log was checkpointed and truncated after the delete.
    pub(crate) wal_truncated: bool,
}

/// Turns collection off and deletes every stored project name in one
/// transaction; then truncates the WAL. The state row keeps only
/// `enabled = 0` and a bumped generation so late writers are rejected. When
/// readers block the truncation, the state row is marked [`PURGE_PENDING`]
/// and [`retry_pending_purge`] finishes the job later.
pub(crate) fn disable_and_purge(conn: &mut Connection) -> rusqlite::Result<PurgeOutcome> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let removed_sessions = tx.execute("DELETE FROM local_session_projects", [])?;
    tx.execute(
        "INSERT INTO local_project_index_state (id, enabled, generation)
         VALUES (1, 0, 1)
         ON CONFLICT(id) DO UPDATE SET
            enabled = 0,
            consent_version = 0,
            generation = generation + 1,
            backfill_status = 'idle',
            backfill_total = 0,
            backfill_done = 0,
            indexed_through_id = 0,
            resolver_version = 0,
            last_failure = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        [],
    )?;
    tx.commit()?;
    let wal_truncated = truncate_wal(conn);
    if !wal_truncated {
        conn.execute(
            "UPDATE local_project_index_state SET last_failure = ?1
             WHERE id = 1 AND enabled = 0",
            params![PURGE_PENDING],
        )?;
    }
    Ok(PurgeOutcome {
        removed_sessions,
        wal_truncated,
    })
}

/// Finishes a purge whose WAL truncation was blocked (review P2-1), also
/// after the index was enabled again (review P3-c).
/// `Some(true)`: truncated and the marker cleared; `Some(false)`: still
/// blocked, the marker stays for the next attempt; `None`: nothing pending.
pub(crate) fn retry_pending_purge(conn: &Connection) -> rusqlite::Result<Option<bool>> {
    let state = load_state(conn)?;
    if state.last_failure.as_deref() != Some(PURGE_PENDING) {
        return Ok(None);
    }
    if !truncate_wal(conn) {
        return Ok(Some(false));
    }
    conn.execute(
        "UPDATE local_project_index_state SET last_failure = NULL
         WHERE id = 1 AND last_failure = ?1",
        params![PURGE_PENDING],
    )?;
    // The marker update is name-free; truncate once more so the log is left
    // empty when nothing else is writing.
    let _ = truncate_wal(conn);
    Ok(Some(true))
}

/// `PRAGMA wal_checkpoint(TRUNCATE)`, retried briefly while readers hold old
/// frames.
pub(crate) fn truncate_wal(conn: &Connection) -> bool {
    let _ = conn.busy_timeout(WAL_TRUNCATE_BUSY_TIMEOUT);
    let mut truncated = false;
    for attempt in 0..WAL_TRUNCATE_ATTEMPTS {
        let busy = conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(1);
        if busy == 0 {
            truncated = true;
            break;
        }
        if attempt + 1 < WAL_TRUNCATE_ATTEMPTS {
            std::thread::sleep(WAL_TRUNCATE_RETRY_DELAY);
        }
    }
    let _ = conn.busy_timeout(CONNECTION_BUSY_TIMEOUT);
    truncated
}

/// Starts a rebuild: bumps the generation so every existing row is stale and
/// recomputed by the next full pass. Names stay visible until replaced.
pub(crate) fn begin_rebuild(conn: &mut Connection) -> rusqlite::Result<Option<IndexState>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = load_state(&tx)?;
    if !current.collecting() {
        tx.commit()?;
        return Ok(None);
    }
    tx.execute(
        "UPDATE local_project_index_state SET
            generation = generation + 1,
            backfill_status = 'running',
            backfill_total = 0,
            backfill_done = 0,
            indexed_through_id = 0,
            last_failure = CASE WHEN last_failure = ?1 THEN last_failure END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = 1",
        params![PURGE_PENDING],
    )?;
    let state = load_state(&tx)?;
    tx.commit()?;
    Ok(Some(state))
}

/// Guarded update of pass bookkeeping. Returns `false` (and changes nothing)
/// when the pass is stale. A pending purge marker is never overwritten; only
/// [`retry_pending_purge`] and a new purge change it.
pub(crate) fn update_progress(
    conn: &mut Connection,
    generation: i64,
    status: BackfillStatus,
    done: i64,
    total: i64,
    completed: Option<(i64, i64)>,
    failure: Option<&str>,
) -> rusqlite::Result<bool> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !pass_is_current(&tx, generation)? {
        return Ok(false);
    }
    tx.execute(
        "UPDATE local_project_index_state SET
            backfill_status = ?1,
            backfill_done = ?2,
            backfill_total = ?3,
            last_failure = CASE WHEN last_failure = ?5 THEN last_failure ELSE ?4 END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = 1",
        params![status.as_str(), done, total, failure, PURGE_PENDING],
    )?;
    if let Some((through_id, resolver_version)) = completed {
        tx.execute(
            "UPDATE local_project_index_state
             SET indexed_through_id = ?1, resolver_version = ?2
             WHERE id = 1",
            params![through_id, resolver_version],
        )?;
    }
    tx.commit()?;
    Ok(true)
}

fn pass_is_current(conn: &Connection, generation: i64) -> rusqlite::Result<bool> {
    let state = load_state(conn)?;
    Ok(state.collecting() && state.generation == generation)
}

/// One session's outcome, ready to persist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionProject {
    pub(crate) tool: String,
    pub(crate) session_id: String,
    pub(crate) source_family: &'static str,
    pub(crate) project: ProjectRef,
}

/// Writes a batch under the generation guard; `false` means the pass is
/// stale and nothing was written.
///
/// A retryable failure never replaces a project that was determined under the
/// same resolver version (the log may simply have been cleaned up since); the
/// row is only re-stamped. Under a different resolver version the old name is
/// dropped, because a rule change may be a privacy fix.
pub(crate) fn write_batch(
    conn: &mut Connection,
    generation: i64,
    resolver_version: i64,
    rows: &[SessionProject],
) -> rusqlite::Result<bool> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !pass_is_current(&tx, generation)? {
        return Ok(false);
    }
    {
        let mut keep = tx.prepare_cached(
            "UPDATE local_session_projects
             SET generation = ?3
             WHERE tool = ?1 AND session_id = ?2
               AND resolver_version = ?4
               AND project_kind <> 'unresolved'",
        )?;
        let mut upsert = tx.prepare_cached(
            "INSERT INTO local_session_projects
                (tool, session_id, source_family, project_kind, project_key, project_label,
                 resolution, generation, resolver_version, resolved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(tool, session_id) DO UPDATE SET
                source_family = excluded.source_family,
                project_kind = excluded.project_kind,
                project_key = excluded.project_key,
                project_label = excluded.project_label,
                resolution = excluded.resolution,
                generation = excluded.generation,
                resolver_version = excluded.resolver_version,
                resolved_at = excluded.resolved_at",
        )?;
        for row in rows {
            if row.project.resolution.is_retryable()
                && keep.execute(params![
                    row.tool,
                    row.session_id,
                    generation,
                    resolver_version
                ])? > 0
            {
                continue;
            }
            upsert.execute(params![
                row.tool,
                row.session_id,
                row.source_family,
                row.project.kind.as_str(),
                row.project.key,
                row.project.label,
                row.project.resolution.as_str(),
                generation,
                resolver_version,
            ])?;
        }
    }
    tx.commit()?;
    Ok(true)
}

/// What a pass needs to know about an existing row to decide whether to
/// resolve the session again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ExistingRow {
    pub(crate) resolution: Option<Resolution>,
    pub(crate) generation: i64,
    pub(crate) resolver_version: i64,
}

pub(crate) fn existing_row(
    conn: &Connection,
    tool: &str,
    session_id: &str,
) -> rusqlite::Result<Option<ExistingRow>> {
    let mut statement = conn.prepare_cached(
        "SELECT resolution, generation, resolver_version
         FROM local_session_projects WHERE tool = ?1 AND session_id = ?2",
    )?;
    statement
        .query_row(params![tool, session_id], |row| {
            Ok(ExistingRow {
                resolution: Resolution::parse(&row.get::<_, String>(0)?),
                generation: row.get(1)?,
                resolver_version: row.get(2)?,
            })
        })
        .optional()
}

/// Keys of rows whose sessions no longer exist in the ledger (spec §4.4).
/// A plain read, so the scanner keeps writing meanwhile (review P2-4).
pub(crate) fn orphan_keys(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut statement = conn.prepare(
        "SELECT tool, session_id FROM local_session_projects
         WHERE (tool, session_id) NOT IN (SELECT tool, session_id FROM token_logs)",
    )?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

/// Deletes the given sessions' rows in one short transaction under the
/// generation guard; `None` when the pass is stale. Deleting is always safe:
/// a session that reappeared meanwhile is simply indexed again.
pub(crate) fn delete_sessions(
    conn: &mut Connection,
    generation: i64,
    keys: &[(String, String)],
) -> rusqlite::Result<Option<usize>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !pass_is_current(&tx, generation)? {
        return Ok(None);
    }
    let mut removed = 0usize;
    {
        let mut delete = tx.prepare_cached(
            "DELETE FROM local_session_projects WHERE tool = ?1 AND session_id = ?2",
        )?;
        for (tool, session_id) in keys {
            removed += delete.execute(params![tool, session_id])?;
        }
    }
    tx.commit()?;
    Ok(Some(removed))
}

pub(crate) fn max_log_id(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COALESCE(MAX(id), 0) FROM token_logs", [], |row| {
        row.get(0)
    })
}

/// One `(tool, session_id)` pair with the smallest unique key of its rows,
/// whose prefix decides the source family (spec §4.2 step 1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionPair {
    pub(crate) tool: String,
    pub(crate) session_id: String,
    pub(crate) min_unique_key: String,
}

/// Sessions with rows in `(after_id, through_id]`. Rows without a real
/// session id are skipped with the behavior analysis' rule (empty, blank or
/// `unknown_session`).
pub(crate) fn session_pairs(
    conn: &Connection,
    after_id: i64,
    through_id: i64,
) -> rusqlite::Result<Vec<SessionPair>> {
    let mut statement = conn.prepare(
        "SELECT tool, session_id, MIN(unique_key)
         FROM token_logs
         WHERE id > ?1 AND id <= ?2
         GROUP BY tool, session_id",
    )?;
    let rows = statement.query_map(params![after_id, through_id], |row| {
        Ok(SessionPair {
            tool: row.get(0)?,
            session_id: row.get(1)?,
            min_unique_key: row.get(2)?,
        })
    })?;
    let mut pairs = Vec::new();
    for pair in rows {
        let pair = pair?;
        if has_session_id(&pair.session_id) {
            pairs.push(pair);
        }
    }
    Ok(pairs)
}

/// Sessions with ledger rows up to `through_id` but no index row at all, for
/// example a session id corrected in place below the watermark. One read of
/// the ledger with a primary-key probe per row; no write lock.
pub(crate) fn unindexed_pairs(
    conn: &Connection,
    through_id: i64,
) -> rusqlite::Result<Vec<SessionPair>> {
    let mut statement = conn.prepare(
        "SELECT t.tool, t.session_id, MIN(t.unique_key)
         FROM token_logs t
         WHERE t.id <= ?1
           AND t.session_id <> 'unknown_session'
           AND TRIM(t.session_id) <> ''
           AND NOT EXISTS (
               SELECT 1 FROM local_session_projects p
               WHERE p.tool = t.tool AND p.session_id = t.session_id)
         GROUP BY t.tool, t.session_id",
    )?;
    let rows = statement.query_map(params![through_id], |row| {
        Ok(SessionPair {
            tool: row.get(0)?,
            session_id: row.get(1)?,
            min_unique_key: row.get(2)?,
        })
    })?;
    let mut pairs = Vec::new();
    for pair in rows {
        let pair = pair?;
        if has_session_id(&pair.session_id) {
            pairs.push(pair);
        }
    }
    Ok(pairs)
}

/// A stored retryable outcome that is due for another attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RetryRow {
    pub(crate) tool: String,
    pub(crate) session_id: String,
    pub(crate) source_family: String,
}

/// Retryable outcomes (`source_missing`, `source_unreadable`,
/// `field_missing`) last attempted at least `older_than_days` ago.
pub(crate) fn stale_retryable(
    conn: &Connection,
    older_than_days: i64,
) -> rusqlite::Result<Vec<RetryRow>> {
    // Fixed internal codes (`[a-z_]`), not user input.
    let retryable = Resolution::ALL
        .iter()
        .filter(|resolution| resolution.is_retryable())
        .map(|resolution| format!("'{}'", resolution.as_str()))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT tool, session_id, source_family FROM local_session_projects
         WHERE resolution IN ({retryable})
           AND resolved_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1)"
    );
    let mut statement = conn.prepare(&sql)?;
    let age = format!("-{older_than_days} days");
    let rows = statement.query_map(params![age], |row| {
        Ok(RetryRow {
            tool: row.get(0)?,
            session_id: row.get(1)?,
            source_family: row.get(2)?,
        })
    })?;
    rows.collect()
}

pub(crate) fn has_session_id(raw: &str) -> bool {
    let trimmed = raw.trim();
    !trimmed.is_empty() && trimmed != "unknown_session"
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct IndexCounts {
    pub(crate) sessions: i64,
    pub(crate) named_projects: i64,
    pub(crate) unresolved_sessions: i64,
}

pub(crate) fn counts(conn: &Connection) -> rusqlite::Result<IndexCounts> {
    conn.query_row(
        "SELECT COUNT(*),
                COUNT(DISTINCT CASE WHEN project_kind = 'named' THEN project_key END),
                COALESCE(SUM(project_kind = 'unresolved'), 0)
         FROM local_session_projects",
        [],
        |row| {
            Ok(IndexCounts {
                sessions: row.get(0)?,
                named_projects: row.get(1)?,
                unresolved_sessions: row.get(2)?,
            })
        },
    )
}

/// Test helper: the stored project of one session.
#[cfg(test)]
pub(crate) fn project_of(
    conn: &Connection,
    tool: &str,
    session_id: &str,
) -> rusqlite::Result<Option<ProjectRef>> {
    use super::label::ProjectKind;
    conn.query_row(
        "SELECT project_kind, project_key, project_label, resolution
         FROM local_session_projects WHERE tool = ?1 AND session_id = ?2",
        params![tool, session_id],
        |row| {
            let kind = match row.get::<_, String>(0)?.as_str() {
                "named" => ProjectKind::Named,
                "home" => ProjectKind::Home,
                "root" => ProjectKind::Root,
                "temp" => ProjectKind::Temp,
                "managed" => ProjectKind::Managed,
                _ => ProjectKind::Unresolved,
            };
            Ok(ProjectRef {
                kind,
                key: row.get(1)?,
                label: row.get(2)?,
                resolution: Resolution::parse(&row.get::<_, String>(3)?)
                    .unwrap_or(Resolution::InvalidPath),
            })
        },
    )
    .optional()
}
