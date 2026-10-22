use super::{
    reader::{read_candidate, Budget, Snapshot},
    types::*,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use walkdir::WalkDir;

pub(super) fn record(db_path: &Path, id: i64) -> Result<Record, Failure> {
    if id <= 0 {
        return Err("invalid_request");
    }
    // Never create/migrate a database as a side effect of a detail read.
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "source_unreadable")?;
    conn.busy_timeout(Duration::from_millis(200))
        .map_err(|_| "source_unreadable")?;
    conn.query_row(
        "SELECT id, tool, session_id, unique_key FROM token_logs WHERE id = ?1",
        [id],
        |row| {
            Ok(Record {
                id: row.get(0)?,
                tool: row.get(1)?,
                session_id: row.get(2)?,
                unique_key: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|_| "source_unreadable")?
    .ok_or("record_not_found")
}

#[derive(Debug, Clone)]
pub(super) struct Candidate {
    pub path: PathBuf,
    pub roots: Vec<PathBuf>,
    pub fingerprint: crate::scanner::checkpoints::SourceFingerprint,
}

pub(super) fn canonical_candidate(path: &Path, roots: &[PathBuf]) -> Result<Candidate, Failure> {
    let meta = fs::symlink_metadata(path).map_err(|_| "source_missing")?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("source_unreadable");
    }
    let canonical = fs::canonicalize(path).map_err(|_| "source_unreadable")?;
    if !roots
        .iter()
        .any(|root| canonical.starts_with(root) && canonical != *root)
    {
        return Err("source_unreadable");
    }
    let fingerprint = crate::scanner::checkpoints::source_fingerprint(&canonical)
        .map_err(|_| "source_unreadable")?;
    if Path::new(&fingerprint.normalized_path) != canonical
        || !roots
            .iter()
            .any(|r| Path::new(&fingerprint.normalized_path).starts_with(r))
    {
        return Err("source_changed");
    }
    Ok(Candidate {
        path: canonical,
        roots: roots.to_vec(),
        fingerprint,
    })
}

fn matches_session(path: &Path, record: &Record) -> bool {
    if record.tool == "claude" {
        path.extension().is_some_and(|e| e == "jsonl")
            && path.file_stem().and_then(|s| s.to_str()) == Some(record.session_id.as_str())
    } else {
        crate::scanner::codex::is_codex_rollout(path)
            && crate::scanner::codex::codex_thread_id_from_path(path).as_deref()
                == Some(record.session_id.as_str())
    }
}

pub(super) fn candidates(
    record: &Record,
    roots: &[PathBuf],
    budget: &Budget,
) -> Result<Vec<Candidate>, Failure> {
    if record.tool != "claude" && record.tool != "codex" {
        return Err("unsupported_source");
    }
    if record.session_id.is_empty()
        || record.session_id.len() > 256
        || record.session_id == "unknown_session"
    {
        return Err("insufficient_turn_metadata");
    }
    let roots: Vec<_> = roots
        .iter()
        .filter_map(|p| fs::canonicalize(p).ok())
        .collect();
    let mut paths = BTreeSet::new();
    let mut candidates = Vec::new();
    let mut visited = 0;
    for root in &roots {
        for entry in WalkDir::new(root).follow_links(false).max_depth(20) {
            budget.check()?;
            visited += 1;
            if visited > 20_000 {
                return Err("limit_exceeded");
            }
            let entry = entry.map_err(|_| "source_unreadable")?;
            if !entry.file_type().is_file() || !matches_session(entry.path(), record) {
                continue;
            }
            let candidate = canonical_candidate(entry.path(), &roots)?;
            if paths.insert(candidate.path.clone()) {
                candidates.push(candidate);
            }
            if paths.len() > 16 {
                return Err("limit_exceeded");
            }
        }
    }
    if paths.is_empty() {
        return Err("source_missing");
    }
    candidates.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(candidates)
}

pub(super) fn analyze(
    record: &Record,
    roots: &[PathBuf],
    budget: &mut Budget,
) -> Result<Analysis, Failure> {
    let paths = candidates(record, roots, budget)?;
    let mut accepted: Option<(Snapshot, Analysis)> = None;
    let mut last_reason = "record_not_found";
    for path in paths {
        budget.check()?;
        let snapshot = read_candidate(&path, budget)?;
        let result = if record.tool == "claude" {
            super::claude::analyze(record, &snapshot, budget)
        } else {
            super::codex::analyze(record, &snapshot, budget)
        };
        let analysis = match result {
            Ok(result) => result,
            Err("record_not_found") => {
                last_reason = "record_not_found";
                continue;
            }
            Err(reason) => return Err(reason),
        };
        if let Some((previous, _)) = &accepted {
            let common = previous.records.len().min(snapshot.records.len());
            if previous.records[..common] != snapshot.records[..common] {
                return Err("source_ambiguous");
            }
            if previous.records.len() >= snapshot.records.len() {
                continue;
            }
        }
        accepted = Some((snapshot, analysis));
    }
    accepted.map(|(_, result)| result).ok_or(last_reason)
}
