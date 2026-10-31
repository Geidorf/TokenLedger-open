use super::checkpoints::*;
use super::claude::*;
use super::codex::*;
use super::helpers::*;
use super::other_tools::*;
use super::reasonix::*;
use super::runner::*;
use super::types::*;
use chrono::{Local, TimeZone};
use rusqlite::{Connection, OpenFlags, Result};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use walkdir::WalkDir;

#[cfg(test)]
mod scanner_singleflight_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::thread;

    #[test]
    fn concurrent_callers_share_one_scan_result() {
        let key = std::env::temp_dir().join(format!(
            "tokenledger-singleflight-{}-{}.db",
            std::process::id(),
            Local::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let starts = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let leader_key = key.clone();
        let leader_starts = Arc::clone(&starts);
        let leader = thread::spawn(move || {
            run_scan_singleflight_with(&leader_key, || {
                leader_starts.fetch_add(1, Ordering::SeqCst);
                started_tx.send(()).expect("signal leader start");
                release_rx.recv().expect("release leader");
                Ok(ScanOutcome {
                    inserted: 7,
                    discovered_models: vec!["shared-model".to_string()],
                    ..ScanOutcome::default()
                })
            })
        });

        started_rx.recv().expect("leader started");
        let flight = {
            let active = active_scan_flights()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Arc::clone(active.get(&key).expect("active scan flight"))
        };

        let follower_key = key.clone();
        let follower_starts = Arc::clone(&starts);
        let follower = thread::spawn(move || {
            run_scan_singleflight_with(&follower_key, || {
                follower_starts.fetch_add(1, Ordering::SeqCst);
                Ok(ScanOutcome {
                    inserted: 99,
                    discovered_models: vec!["duplicate".to_string()],
                    ..ScanOutcome::default()
                })
            })
        });

        let follower_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while Arc::strong_count(&flight) < 4 && std::time::Instant::now() < follower_deadline {
            thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(
            Arc::strong_count(&flight) >= 4,
            "follower did not join the active flight"
        );
        release_tx.send(()).expect("release scan");

        let (leader_result, leader_ran) = leader.join().expect("leader join");
        let (follower_result, follower_ran) = follower.join().expect("follower join");
        let leader_result = leader_result.expect("leader result");
        let follower_result = follower_result.expect("follower result");

        assert!(leader_ran);
        assert!(!follower_ran);
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(leader_result.inserted, 7);
        assert_eq!(follower_result.inserted, 7);
        assert_eq!(follower_result.discovered_models, vec!["shared-model"]);
    }
}

#[cfg(test)]
mod scanner_model_discovery_tests {
    use super::*;

    fn log(tool: &str, model: &str, unique_key: &str) -> LogRecord {
        LogRecord {
            tool: tool.to_string(),
            model: model.to_string(),
            input_tokens: 1,
            output_tokens: 1,
            cached_tokens: 0,
            cache_write_tokens: 0,
            timestamp: "2026-07-10 10:00:00".to_string(),
            session_id: "session".to_string(),
            unique_key: unique_key.to_string(),
            cost_usd: None,
            cumulative: false,
        }
    }

    #[test]
    fn filters_modes_placeholders_and_malformed_model_values() {
        assert_eq!(
            model_discovery_key(" GPT-6.0-Preview "),
            Some("gpt-6.0-preview".to_string())
        );
        assert_eq!(model_discovery_key("auto"), None);
        assert_eq!(model_discovery_key("auto-pro"), None);
        assert_eq!(model_discovery_key("computer-auto"), None);
        assert_eq!(model_discovery_key("codex-agent"), None);
        assert_eq!(model_discovery_key("not a model id"), None);
        assert_eq!(model_discovery_key(&"x".repeat(97)), None);
    }

    #[test]
    fn records_each_tool_model_pair_once_and_reports_new_model_once() {
        let mut conn = Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(
            "CREATE TABLE discovered_models (
                tool TEXT NOT NULL,
                model_key TEXT NOT NULL,
                model TEXT NOT NULL,
                first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (tool, model_key)
            );",
        )
        .expect("create discovery table");
        let logs = vec![
            log("codex", "GPT-6.0-Preview", "1"),
            log("codex", "gpt-6.0-preview", "2"),
            log("trae", "gpt-6.0-preview", "3"),
            log("workbuddy", "auto", "4"),
        ];

        let tx = conn.transaction().expect("start transaction");
        let first = record_discovered_models(&tx, &logs).expect("record discoveries");
        tx.commit().expect("commit discoveries");
        assert_eq!(first, vec!["gpt-6.0-preview"]);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM discovered_models", [], |row| {
                row.get(0)
            })
            .expect("count discoveries");
        assert_eq!(count, 2, "the same model may be observed by two tools");

        let tx = conn.transaction().expect("start repeat transaction");
        let repeated = record_discovered_models(&tx, &logs).expect("repeat discoveries");
        tx.commit().expect("commit repeat");
        assert!(repeated.is_empty());
    }
}

#[cfg(test)]
mod scanner_codex_tests {
    use super::*;
    use std::fs::{self, File, OpenOptions};
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    const ROOT_ID: &str = "00000000-0000-4000-8000-000000000001";
    const PARENT_ID: &str = "00000000-0000-4000-8000-000000000002";
    const CHILD_ID: &str = "00000000-0000-4000-8000-000000000003";
    const OTHER_ID: &str = "00000000-0000-4000-8000-000000000004";

    fn temp_root() -> PathBuf {
        let now_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tokenledger_codex_test_{now_nanos}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_json_line(file: &mut File, value: Value) {
        writeln!(file, "{}", serde_json::to_string(&value).unwrap()).unwrap();
    }

    fn rollout_path(root: &Path, thread_id: &str) -> PathBuf {
        root.join(format!("rollout-2026-07-15T00-00-00-{thread_id}.jsonl"))
    }

    fn session_meta(
        thread_id: &str,
        timestamp: &str,
        forked_from: Option<&str>,
        top_level_parent: Option<&str>,
        spawned_from: Option<&str>,
    ) -> Value {
        let source = spawned_from.map_or_else(
            || Value::String("cli".to_string()),
            |parent| {
                serde_json::json!({
                    "subagent": { "thread_spawn": { "parent_thread_id": parent } }
                })
            },
        );
        serde_json::json!({
            "timestamp": timestamp,
            "type": "session_meta",
            "payload": {
                "id": thread_id,
                "forked_from_id": forked_from,
                "parent_thread_id": top_level_parent,
                "source": source,
            }
        })
    }

    fn turn_context(timestamp: &str, model: &str) -> Value {
        serde_json::json!({
            "timestamp": timestamp,
            "type": "turn_context",
            "payload": { "model": model }
        })
    }

    fn token_event(
        timestamp: &str,
        total_input: i64,
        total_cached: i64,
        total_output: i64,
        last_input: i64,
        last_cached: i64,
        last_output: i64,
    ) -> Value {
        serde_json::json!({
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": total_input,
                        "cached_input_tokens": total_cached,
                        "output_tokens": total_output,
                        "total_tokens": total_input + total_output
                    },
                    "last_token_usage": {
                        "input_tokens": last_input,
                        "cached_input_tokens": last_cached,
                        "output_tokens": last_output,
                        "total_tokens": last_input + last_output
                    }
                }
            }
        })
    }

    fn token_event_with(
        timestamp: Option<&str>,
        total: (i64, i64, i64),
        last: Option<(i64, i64, i64)>,
        lane: Option<&str>,
    ) -> Value {
        let mut value = token_event(
            timestamp.unwrap_or("2026-07-15T00:00:00Z"),
            total.0,
            total.1,
            total.2,
            last.map(|usage| usage.0).unwrap_or(0),
            last.map(|usage| usage.1).unwrap_or(0),
            last.map(|usage| usage.2).unwrap_or(0),
        );
        let payload = value["payload"].as_object_mut().unwrap();
        if let Some(lane) = lane {
            payload.insert(
                "rate_limits".to_string(),
                serde_json::json!({ "limit_id": lane }),
            );
        }
        if last.is_none() {
            payload["info"]
                .as_object_mut()
                .unwrap()
                .remove("last_token_usage");
        }
        if timestamp.is_none() {
            value.as_object_mut().unwrap().remove("timestamp");
        }
        value
    }

    fn write_rollout_values(path: &Path, values: &[Value]) {
        let mut file = File::create(path).expect("create rollout fixture");
        for value in values {
            write_json_line(&mut file, value.clone());
        }
        file.sync_all().expect("sync rollout fixture");
    }

    struct CheckpointFixture {
        root: PathBuf,
        db_path: PathBuf,
        rollout: PathBuf,
    }

    impl CheckpointFixture {
        fn new(label: &str) -> Self {
            let root = temp_root().join(label);
            fs::create_dir_all(&root).expect("create checkpoint fixture root");
            let db_path = root.join("tokenboard.db");
            crate::db::init_test_db(&db_path).expect("initialize checkpoint fixture db");
            let rollout = rollout_path(&root, ROOT_ID);
            Self {
                root,
                db_path,
                rollout,
            }
        }

        fn checkpoint(&self) -> crate::db::ScanCheckpoint {
            let fingerprint = source_fingerprint(&self.rollout).expect("fingerprint rollout");
            let conn = crate::db::get_connection(&self.db_path).expect("open fixture db");
            crate::db::load_scan_checkpoints(&conn, CODEX_CHECKPOINT_SOURCE_KIND)
                .expect("load fixture checkpoints")
                .remove(&fingerprint.normalized_path)
                .expect("rollout checkpoint")
        }

        fn row_count(&self) -> i64 {
            let conn = crate::db::get_connection(&self.db_path).expect("open fixture db");
            conn.query_row("SELECT COUNT(*) FROM token_logs", [], |row| row.get(0))
                .expect("count fixture rows")
        }
    }

    impl Drop for CheckpointFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(
                self.root
                    .parent()
                    .expect("checkpoint fixture root has a parent"),
            );
        }
    }

    fn write_rollout(path: &Path, sequence: i64) {
        let mut file = File::create(path).expect("create rollout fixture");
        write_json_line(
            &mut file,
            session_meta(ROOT_ID, "2026-07-15T00:00:00Z", None, None, None),
        );
        write_json_line(
            &mut file,
            turn_context("2026-07-15T00:00:00Z", "gpt-checkpoint"),
        );
        append_token_event_to(&mut file, sequence);
        file.sync_all().expect("sync rollout fixture");
    }

    fn append_token_event(path: &Path, sequence: i64) {
        let mut file = OpenOptions::new()
            .append(true)
            .open(path)
            .expect("open rollout fixture for append");
        append_token_event_to(&mut file, sequence);
        file.sync_all().expect("sync appended rollout fixture");
    }

    fn append_token_event_to(file: &mut File, sequence: i64) {
        write_json_line(
            file,
            token_event(
                &format!("2026-07-15T00:00:{sequence:02}Z"),
                sequence * 1_000,
                sequence * 800,
                sequence * 100,
                1_000,
                800,
                100,
            ),
        );
    }

    fn scan_checkpoint_fixture(
        root: &Path,
        db_path: &Path,
    ) -> Result<(ScanOutcome, CheckpointScanStats)> {
        let conn = crate::db::get_connection(db_path)?;
        let checkpoints = crate::db::load_scan_checkpoints(&conn, CODEX_CHECKPOINT_SOURCE_KIND)?;
        drop(conn);
        let mut batch = scan_codex_roots_checkpointed(&[root.to_path_buf()], &checkpoints, false);
        let stats = batch.stats;
        let outcome = persist_scan_batch(
            db_path,
            std::mem::take(&mut batch.logs),
            std::mem::take(&mut batch.checkpoints),
            Vec::new(),
            None,
        )?;
        Ok((outcome, stats))
    }

    #[test]
    fn checkpoint_skips_unchanged_and_rescans_append() {
        let fixture = CheckpointFixture::new("lifecycle");
        write_rollout(&fixture.rollout, 1);

        let (first, first_stats) =
            scan_checkpoint_fixture(&fixture.root, &fixture.db_path).expect("first scan");
        assert_eq!(first.inserted, 1);
        assert_eq!(first_stats.parsed_files, 1);
        assert_eq!(first_stats.skipped_files, 0);
        let first_checkpoint = fixture.checkpoint();
        assert_eq!(
            first_checkpoint.size_bytes,
            first_checkpoint.processed_offset
        );

        let (unchanged, unchanged_stats) =
            scan_checkpoint_fixture(&fixture.root, &fixture.db_path).expect("unchanged scan");
        assert_eq!(unchanged.inserted, 0);
        assert_eq!(unchanged_stats.parsed_files, 0);
        assert_eq!(unchanged_stats.skipped_files, 1);

        append_token_event(&fixture.rollout, 2);
        let (appended, append_stats) =
            scan_checkpoint_fixture(&fixture.root, &fixture.db_path).expect("append scan");
        assert_eq!(appended.inserted, 1);
        assert_eq!(append_stats.parsed_files, 1);
        assert_eq!(append_stats.parsed_records, 2);
        let append_checkpoint = fixture.checkpoint();
        assert!(append_checkpoint.size_bytes > first_checkpoint.size_bytes);
        assert_eq!(fixture.row_count(), 2);
    }

    #[test]
    fn append_after_index_uses_frozen_prefix_then_catches_up() {
        let fixture = CheckpointFixture::new("frozen-append");
        write_rollout(&fixture.rollout, 1);
        let frozen = source_fingerprint(&fixture.rollout).expect("freeze rollout fingerprint");
        let candidate = CodexSourceCandidate {
            path: fixture.rollout.clone(),
            fingerprint: frozen.clone(),
            checkpoint_current: false,
        };

        append_token_event(&fixture.rollout, 2);
        let grown = source_fingerprint(&fixture.rollout).expect("fingerprint appended rollout");
        assert!(grown.size_bytes > frozen.size_bytes);
        assert_eq!(grown.source_identity, frozen.source_identity);

        let parsed = parse_codex_candidate(&candidate, ROOT_ID, &mut CodexParseCache::new())
            .expect("parse the frozen prefix after an append");
        let frozen_logs = codex_logs_from_rollout(&parsed, 0);
        assert_eq!(
            frozen_logs.len(),
            1,
            "the appended event belongs to the next scan"
        );
        let first = persist_scan_batch(
            &fixture.db_path,
            frozen_logs,
            vec![frozen.checkpoint()],
            Vec::new(),
            None,
        )
        .expect("persist frozen snapshot");
        assert_eq!(first.inserted, 1);
        let frozen_checkpoint = fixture.checkpoint();
        assert_eq!(frozen_checkpoint.size_bytes, frozen.size_bytes);
        assert_eq!(frozen_checkpoint.modified_ns, frozen.modified_ns);

        let (caught_up, stats) =
            scan_checkpoint_fixture(&fixture.root, &fixture.db_path).expect("catch up append");
        assert_eq!(caught_up.inserted, 1);
        assert_eq!(stats.parsed_files, 1);
        assert_eq!(stats.parsed_records, 2);
        assert_eq!(fixture.row_count(), 2);
        let caught_up_checkpoint = fixture.checkpoint();
        assert_eq!(caught_up_checkpoint.size_bytes, grown.size_bytes);
        assert!(caught_up_checkpoint.size_bytes > frozen_checkpoint.size_bytes);
    }

    #[test]
    fn frozen_snapshot_rejects_truncation_replacement_and_same_size_mtime_change() {
        let root = temp_root();
        let path = rollout_path(&root, ROOT_ID);

        write_rollout(&path, 1);
        let frozen = source_fingerprint(&path).expect("freeze rollout before truncation");
        let truncated = CodexSourceCandidate {
            path: path.clone(),
            fingerprint: frozen,
            checkpoint_current: false,
        };
        OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .expect("truncate rollout")
            .sync_all()
            .expect("sync truncated rollout");
        assert!(
            parse_codex_candidate(&truncated, ROOT_ID, &mut CodexParseCache::new()).is_err(),
            "a source shorter than the frozen prefix must fail"
        );

        write_rollout(&path, 1);
        let frozen = source_fingerprint(&path).expect("freeze rollout before replacement");
        let replaced = CodexSourceCandidate {
            path: path.clone(),
            fingerprint: frozen.clone(),
            checkpoint_current: false,
        };
        let replacement_path = root.join("replacement.jsonl");
        write_rollout(&replacement_path, 1);
        fs::remove_file(&path).expect("remove original rollout");
        fs::rename(&replacement_path, &path).expect("replace rollout");
        let replacement = source_fingerprint(&path).expect("fingerprint replacement rollout");
        assert_ne!(replacement.source_identity, frozen.source_identity);
        assert!(
            parse_codex_candidate(&replaced, ROOT_ID, &mut CodexParseCache::new()).is_err(),
            "a replacement at the same path must fail"
        );

        let actual = source_fingerprint(&path).expect("freeze rollout before mtime change");
        let mut stale_mtime = actual.clone();
        stale_mtime.modified_ns = stale_mtime.modified_ns.saturating_sub(1);
        let rewritten = CodexSourceCandidate {
            path: path.clone(),
            fingerprint: stale_mtime,
            checkpoint_current: false,
        };
        assert!(
            parse_codex_candidate(&rewritten, ROOT_ID, &mut CodexParseCache::new()).is_err(),
            "a same-size source with a changed mtime must fail"
        );

        fs::remove_dir_all(root).expect("remove frozen snapshot fixture");
    }

    #[test]
    fn frozen_prefix_must_end_at_a_jsonl_boundary() {
        let root = temp_root();
        let path = rollout_path(&root, ROOT_ID);
        write_rollout(&path, 1);
        let length = fs::metadata(&path).expect("stat rollout").len();
        OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open rollout for partial tail")
            .set_len(length - 1)
            .expect("remove final newline");
        let frozen = source_fingerprint(&path).expect("fingerprint partial rollout");
        let candidate = CodexSourceCandidate {
            path: path.clone(),
            fingerprint: frozen,
            checkpoint_current: false,
        };
        let error = parse_codex_candidate(&candidate, ROOT_ID, &mut CodexParseCache::new())
            .expect_err("a frozen partial JSONL line must fail");
        assert!(error.contains("does not end at a JSONL boundary"));

        fs::remove_dir_all(root).expect("remove partial prefix fixture");
    }

    #[test]
    fn empty_rollout_defers_without_advancing_checkpoint() {
        let root = temp_root();
        let path = rollout_path(&root, ROOT_ID);
        File::create(&path)
            .expect("create empty rollout")
            .sync_all()
            .expect("sync empty rollout");

        let batch =
            scan_codex_roots_checkpointed(std::slice::from_ref(&root), &HashMap::new(), false);
        assert!(!batch.complete);
        assert_eq!(batch.stats.failed_files, 1);
        assert!(batch.logs.is_empty());
        assert!(batch.checkpoints.is_empty());

        fs::remove_dir_all(root).expect("remove empty rollout fixture");
    }

    #[test]
    fn rebuild_requires_an_active_sessions_root_but_normal_scan_allows_missing_roots() {
        let root = temp_root();
        let missing_primary = root.join("sessions");
        let archived = root.join("archived_sessions");
        fs::create_dir_all(&archived).expect("create optional archive root");
        write_rollout(&rollout_path(&archived, ROOT_ID), 1);
        let roots = vec![missing_primary.clone(), archived];

        let normal = scan_codex_roots_checkpointed(&roots, &HashMap::new(), false);
        assert!(
            normal.complete,
            "archive-only normal scans remain supported"
        );
        assert_eq!(normal.logs.len(), 1);

        let rebuild = scan_codex_roots_for_rebuild(&roots, &HashMap::new());
        assert!(!rebuild.complete);
        assert_eq!(rebuild.stats.failed_files, 1);
        assert!(rebuild.logs.is_empty());
        assert!(rebuild.checkpoints.is_empty());

        let no_sources = scan_codex_roots_checkpointed(
            &[root.join("absent-sessions"), root.join("absent-archive")],
            &HashMap::new(),
            false,
        );
        assert!(no_sources.complete);
        assert!(no_sources.logs.is_empty());
        assert!(no_sources.checkpoints.is_empty());

        fs::remove_dir_all(root).expect("remove missing primary fixture");
    }

    #[test]
    fn rebuild_accepts_multica_sessions_when_global_sessions_are_missing() {
        let home = temp_root();
        let global_sessions = home.join(".codex").join("sessions");
        let global_archive = home.join(".codex").join("archived_sessions");
        let multica_sessions =
            multica_task_home(&home, "workspace-id", "task-only").join("sessions");
        fs::create_dir_all(&multica_sessions).expect("create Multica sessions root");
        write_rollout(&rollout_path(&multica_sessions, ROOT_ID), 1);
        let mut roots = vec![global_sessions, global_archive];
        roots.extend(discover_multica_codex_roots_in(&home));

        let rebuild = scan_codex_roots_for_rebuild(&roots, &HashMap::new());

        assert!(rebuild.complete);
        assert_eq!(rebuild.logs.len(), 1);
        assert_eq!(rebuild.root_session_ids, vec![ROOT_ID.to_string()]);
        fs::remove_dir_all(home).expect("remove Multica-only rebuild fixture");
    }

    #[test]
    fn checkpoint_rejects_mtime_rollback_and_incomplete_cursor() {
        let fixture = CheckpointFixture::new("fingerprint");
        write_rollout(&fixture.rollout, 1);
        let fingerprint = source_fingerprint(&fixture.rollout).expect("fingerprint fixture");
        let mut checkpoint = fingerprint.checkpoint();
        assert!(checkpoint_is_current(&checkpoint, &fingerprint));

        checkpoint.modified_ns = fingerprint.modified_ns.saturating_add(1);
        assert!(
            !checkpoint_is_current(&checkpoint, &fingerprint),
            "an mtime rollback must force a full-file rescan"
        );
        checkpoint.modified_ns = fingerprint.modified_ns;
        checkpoint.processed_offset -= 1;
        assert!(
            !checkpoint_is_current(&checkpoint, &fingerprint),
            "a partial cursor must never be treated as a completed file"
        );
    }

    #[test]
    fn failures_never_advance_checkpoint_and_retry_recovers() {
        let fixture = CheckpointFixture::new("failure");
        write_rollout(&fixture.rollout, 1);
        let conn = crate::db::get_connection(&fixture.db_path).expect("open fixture db");
        let checkpoints = crate::db::load_scan_checkpoints(&conn, CODEX_CHECKPOINT_SOURCE_KIND)
            .expect("load empty checkpoints");
        drop(conn);

        let mut broken = OpenOptions::new()
            .append(true)
            .open(&fixture.rollout)
            .expect("open rollout for corrupt append");
        writeln!(broken, "{{broken-json").unwrap();
        broken.sync_all().unwrap();
        let failed =
            scan_codex_roots_checkpointed(std::slice::from_ref(&fixture.root), &checkpoints, false);
        assert!(!failed.complete);
        assert_eq!(failed.stats.failed_files, 1);
        assert!(failed.logs.is_empty());
        assert!(failed.checkpoints.is_empty());

        write_rollout(&fixture.rollout, 1);
        let mut parsed =
            scan_codex_roots_checkpointed(std::slice::from_ref(&fixture.root), &checkpoints, false);
        assert_eq!(parsed.stats.parsed_files, 1);
        parsed.checkpoints[0].processed_offset = parsed.checkpoints[0].size_bytes + 1;
        assert!(persist_scan_batch(
            &fixture.db_path,
            parsed.logs,
            parsed.checkpoints,
            Vec::new(),
            None,
        )
        .is_err());

        let conn = crate::db::get_connection(&fixture.db_path).expect("reopen fixture db");
        assert!(
            crate::db::load_scan_checkpoints(&conn, CODEX_CHECKPOINT_SOURCE_KIND)
                .expect("load checkpoints after rollback")
                .is_empty()
        );
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM token_logs", [], |row| row.get(0))
            .expect("count rolled back rows");
        assert_eq!(rows, 0);
        drop(conn);

        let (retry, retry_stats) =
            scan_checkpoint_fixture(&fixture.root, &fixture.db_path).expect("retry scan");
        assert_eq!(retry.inserted, 1);
        assert_eq!(retry_stats.parsed_files, 1);
        assert_eq!(fixture.row_count(), 1);
        let _ = fixture.checkpoint();
    }

    #[test]
    fn checkpointed_scan_is_singleflight_and_repeat_is_skipped() {
        let fixture = CheckpointFixture::new("concurrent");
        write_rollout(&fixture.rollout, 1);
        let starts = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let leader_db = fixture.db_path.clone();
        let leader_root = fixture.root.clone();
        let leader_starts = Arc::clone(&starts);
        let leader = thread::spawn(move || {
            run_scan_singleflight_with(&leader_db.clone(), || {
                leader_starts.fetch_add(1, Ordering::SeqCst);
                started_tx.send(()).expect("signal fixture leader");
                release_rx.recv().expect("release fixture leader");
                let (outcome, stats) = scan_checkpoint_fixture(&leader_root, &leader_db)
                    .map_err(|error| error.to_string())?;
                assert_eq!(stats.parsed_files, 1);
                Ok(outcome)
            })
        });

        started_rx.recv().expect("fixture leader started");
        let follower_db = fixture.db_path.clone();
        let follower_root = fixture.root.clone();
        let follower_starts = Arc::clone(&starts);
        let follower = thread::spawn(move || {
            run_scan_singleflight_with(&follower_db.clone(), || {
                follower_starts.fetch_add(1, Ordering::SeqCst);
                scan_checkpoint_fixture(&follower_root, &follower_db)
                    .map(|(outcome, _stats)| outcome)
                    .map_err(|error| error.to_string())
            })
        });

        let flight = {
            let active = active_scan_flights()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Arc::clone(
                active
                    .get(&fixture.db_path)
                    .expect("active fixture scan flight"),
            )
        };
        let follower_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while Arc::strong_count(&flight) < 4 && std::time::Instant::now() < follower_deadline {
            thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(Arc::strong_count(&flight) >= 4, "follower joined flight");
        release_tx.send(()).expect("release fixture scan");

        let (leader_result, leader_ran) = leader.join().expect("join fixture leader");
        let (follower_result, follower_ran) = follower.join().expect("join fixture follower");
        assert!(leader_ran);
        assert!(!follower_ran);
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(leader_result.expect("leader result").inserted, 1);
        assert_eq!(follower_result.expect("follower result").inserted, 1);

        let (repeat, repeat_stats) =
            scan_checkpoint_fixture(&fixture.root, &fixture.db_path).expect("repeat scan");
        assert_eq!(repeat.inserted, 0);
        assert_eq!(repeat_stats.parsed_files, 0);
        assert_eq!(repeat_stats.skipped_files, 1);
        assert_eq!(fixture.row_count(), 1);
    }

    #[test]
    fn reads_current_rollout_cache_shape() {
        let usage = serde_json::json!({
            "input_tokens": 208_415,
            "cached_input_tokens": 198_400,
            "output_tokens": 646,
            "reasoning_output_tokens": 44,
            "total_tokens": 209_061
        });

        let counters = codex_counters_signature(Some(&usage))
            .unwrap()
            .unwrap()
            .usage();
        assert_eq!(counters.cache_read, 198_400);
        assert_eq!(counters.cache_write, 0);
    }

    #[test]
    fn null_or_missing_token_info_is_skipped_but_non_null_invalid_shape_defers() {
        let root = temp_root();
        let path = rollout_path(&root, ROOT_ID);
        write_rollout_values(
            &path,
            &[
                session_meta(ROOT_ID, "2026-07-15T00:00:00Z", None, None, None),
                serde_json::json!({
                    "timestamp": "2026-07-15T00:00:01Z",
                    "type": "event_msg",
                    "payload": { "type": "token_count" }
                }),
                serde_json::json!({
                    "timestamp": "2026-07-15T00:00:02Z",
                    "type": "event_msg",
                    "payload": { "type": "token_count", "info": null }
                }),
                token_event_with(
                    Some("2026-07-15T00:00:03Z"),
                    (500, 300, 50),
                    Some((500, 300, 50)),
                    None,
                ),
            ],
        );
        let accepted =
            scan_codex_roots_checkpointed(std::slice::from_ref(&root), &HashMap::new(), false);
        assert!(accepted.complete);
        assert_eq!(accepted.logs.len(), 1);
        assert!(accepted.deferred_reasons.is_empty());

        write_rollout_values(
            &path,
            &[
                session_meta(ROOT_ID, "2026-07-15T00:00:00Z", None, None, None),
                serde_json::json!({
                    "timestamp": "2026-07-15T00:00:01Z",
                    "type": "event_msg",
                    "payload": { "type": "token_count", "info": "invalid" }
                }),
            ],
        );
        let rejected =
            scan_codex_roots_checkpointed(std::slice::from_ref(&root), &HashMap::new(), false);
        assert!(!rejected.complete);
        assert!(rejected.logs.is_empty());
        assert!(rejected.checkpoints.is_empty());
        assert_eq!(
            rejected
                .deferred_reasons
                .get(&CodexDeferredReason::InvalidUsageShape),
            Some(&1)
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn accepts_gpt_5_6_cache_write_details_when_rollout_exposes_them() {
        let usage = serde_json::json!({
            "input_tokens_details": {
                "cached_tokens": 800_000,
                "cache_write_tokens": 100_000
            }
        });

        let counters = codex_counters_signature(Some(&usage))
            .unwrap()
            .unwrap()
            .usage();
        assert_eq!(counters.cache_read, 800_000);
        assert_eq!(counters.cache_write, 100_000);
    }

    #[test]
    fn normalizes_cached_input_and_dedupes_repeated_snapshots() {
        let root = temp_root();
        let path = rollout_path(&root, ROOT_ID);
        let mut file = File::create(&path).unwrap();

        write_json_line(
            &mut file,
            session_meta(ROOT_ID, "2026-07-10T03:00:00Z", None, None, None),
        );
        write_json_line(
            &mut file,
            turn_context("2026-07-10T03:00:00Z", "gpt-5.6-sol"),
        );
        // Spawned sessions can begin with inherited totals but no last-usage
        // split. This is metadata, not a request.
        write_json_line(
            &mut file,
            token_event("2026-07-10T03:00:00Z", 5_000, 4_500, 100, 0, 0, 0),
        );
        let first = token_event("2026-07-10T03:00:01Z", 1_000, 800, 100, 1_000, 800, 100);
        write_json_line(&mut file, first.clone());
        write_json_line(&mut file, first);
        let second = token_event("2026-07-10T03:00:02Z", 2_200, 1_800, 150, 1_200, 1_000, 50);
        write_json_line(&mut file, second.clone());
        write_json_line(&mut file, second);
        drop(file);

        let mut logs = Vec::new();
        let batch = scan_codex_roots(std::slice::from_ref(&root), &mut logs);
        assert!(batch.complete);
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].model, "gpt-5.6-sol");
        assert_eq!(logs[0].input_tokens, 200);
        assert_eq!(logs[0].cached_tokens, 800);
        assert_eq!(logs[0].output_tokens, 100);
        assert_eq!(logs[1].input_tokens, 200);
        assert_eq!(logs[1].cached_tokens, 1_000);
        assert_eq!(logs[1].output_tokens, 50);
        assert_eq!(logs[0].unique_key, format!("codex_v2_{ROOT_ID}_1"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fork_replay_is_skipped_but_child_usage_is_kept() {
        let root = temp_root();
        let parent_path = rollout_path(&root, PARENT_ID);
        let child_path = rollout_path(&root, CHILD_ID);
        let inherited_a = token_event_with(
            Some("2026-07-15T00:00:01Z"),
            (1_000, 800, 100),
            Some((1_000, 800, 100)),
            Some("lane-a"),
        );
        let parent_only = token_event_with(
            Some("2026-07-15T00:00:02Z"),
            (1_500, 1_000, 150),
            Some((500, 200, 50)),
            Some("lane-b"),
        );
        let inherited_b = token_event_with(
            Some("2026-07-15T00:00:03Z"),
            (2_200, 1_500, 220),
            Some((700, 500, 70)),
            Some("lane-a"),
        );
        write_rollout_values(
            &parent_path,
            &[
                session_meta(PARENT_ID, "2026-07-15T00:00:00Z", None, None, None),
                turn_context("2026-07-15T00:00:00Z", "gpt-parent"),
                inherited_a.clone(),
                parent_only,
                inherited_b.clone(),
                serde_json::json!({
                    "timestamp": "2026-07-15T00:00:05Z",
                    "type": "event_msg",
                    "payload": { "type": "task_complete" }
                }),
            ],
        );
        let child_usage = token_event_with(
            Some("2026-07-15T00:00:06Z"),
            (2_800, 1_900, 300),
            Some((600, 400, 80)),
            Some("lane-a"),
        );
        write_rollout_values(
            &child_path,
            &[
                session_meta(
                    CHILD_ID,
                    "2026-07-15T00:00:05Z",
                    Some(PARENT_ID),
                    Some(PARENT_ID),
                    Some(PARENT_ID),
                ),
                turn_context("2026-07-15T00:00:05Z", "gpt-child"),
                inherited_a,
                inherited_b,
                child_usage,
            ],
        );

        let mut logs = Vec::new();
        let batch = scan_codex_roots(std::slice::from_ref(&root), &mut logs);
        assert!(batch.complete);
        let child_logs = logs
            .iter()
            .filter(|log| log.session_id == CHILD_ID)
            .collect::<Vec<_>>();
        assert_eq!(child_logs.len(), 1);
        assert_eq!(child_logs[0].unique_key, format!("codex_v2_{CHILD_ID}_3"));
        assert_eq!(child_logs[0].input_tokens, 200);
        assert_eq!(child_logs[0].cached_tokens, 400);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parented_rollout_without_replay_keeps_first_usage() {
        let root = temp_root();
        write_rollout_values(
            &rollout_path(&root, PARENT_ID),
            &[
                session_meta(PARENT_ID, "2026-07-15T00:00:00Z", None, None, None),
                token_event_with(
                    Some("2026-07-15T00:00:01Z"),
                    (1_000, 800, 100),
                    Some((1_000, 800, 100)),
                    None,
                ),
                serde_json::json!({
                    "timestamp": "2026-07-15T00:00:05Z",
                    "type": "event_msg",
                    "payload": { "type": "task_complete" }
                }),
            ],
        );
        write_rollout_values(
            &rollout_path(&root, CHILD_ID),
            &[
                session_meta(
                    CHILD_ID,
                    "2026-07-15T00:00:05Z",
                    None,
                    Some(PARENT_ID),
                    None,
                ),
                token_event_with(
                    Some("2026-07-15T00:00:06Z"),
                    (700, 400, 80),
                    Some((700, 400, 80)),
                    None,
                ),
            ],
        );
        let mut logs = Vec::new();
        let batch = scan_codex_roots(std::slice::from_ref(&root), &mut logs);
        assert!(batch.complete);
        assert_eq!(
            logs.iter().filter(|log| log.session_id == CHILD_ID).count(),
            1
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn lane_dedupe_uses_full_total_and_last_signature() {
        let root = temp_root();
        let first = token_event_with(
            Some("2026-07-15T00:00:01Z"),
            (1_000, 800, 100),
            Some((1_000, 800, 100)),
            Some("lane-a"),
        );
        let same_total_different_last = token_event_with(
            Some("2026-07-15T00:00:02Z"),
            (1_000, 800, 100),
            Some((400, 300, 20)),
            Some("lane-a"),
        );
        write_rollout_values(
            &rollout_path(&root, ROOT_ID),
            &[
                session_meta(ROOT_ID, "2026-07-15T00:00:00Z", None, None, None),
                first.clone(),
                first.clone(),
                same_total_different_last,
                first.clone(),
                first,
            ],
        );
        let mut logs = Vec::new();
        let batch = scan_codex_roots(std::slice::from_ref(&root), &mut logs);
        assert!(batch.complete);
        assert_eq!(logs.len(), 3);
        assert_eq!(logs[1].input_tokens, 100);
        assert_eq!(logs[1].cached_tokens, 300);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn adjacent_cross_lane_replay_is_deduped_but_non_adjacent_recurrence_is_kept() {
        let root = temp_root();
        let signature = token_event_with(
            Some("2026-07-15T00:00:01Z"),
            (1_000, 800, 100),
            Some((1_000, 800, 100)),
            Some("lane-a"),
        );
        let mut adjacent_other_lane = signature.clone();
        adjacent_other_lane["payload"]["rate_limits"]["limit_id"] = Value::String("lane-b".into());
        let middle = token_event_with(
            Some("2026-07-15T00:00:02Z"),
            (1_500, 1_100, 140),
            Some((500, 300, 40)),
            Some("lane-b"),
        );
        let mut later_new_lane = signature.clone();
        later_new_lane["payload"]["rate_limits"]["limit_id"] = Value::String("lane-c".into());
        write_rollout_values(
            &rollout_path(&root, ROOT_ID),
            &[
                session_meta(ROOT_ID, "2026-07-15T00:00:00Z", None, None, None),
                signature,
                adjacent_other_lane,
                middle,
                later_new_lane,
            ],
        );
        let mut logs = Vec::new();
        let batch = scan_codex_roots(std::slice::from_ref(&root), &mut logs);
        assert!(batch.complete);
        assert_eq!(
            logs.len(),
            3,
            "only the adjacent cross-lane replay is zeroed"
        );
        assert_eq!(logs[2].cached_tokens, 800);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn archive_only_rollout_is_scanned_and_later_meta_cannot_replace_root() {
        let root = temp_root();
        write_rollout_values(
            &rollout_path(&root, ROOT_ID),
            &[
                session_meta(ROOT_ID, "2026-07-15T00:00:00Z", None, None, None),
                session_meta(
                    OTHER_ID,
                    "2026-07-15T00:00:01Z",
                    Some(PARENT_ID),
                    None,
                    None,
                ),
                token_event_with(
                    Some("2026-07-15T00:00:02Z"),
                    (500, 300, 50),
                    Some((500, 300, 50)),
                    None,
                ),
            ],
        );
        let mut logs = Vec::new();
        let batch = scan_codex_roots(std::slice::from_ref(&root), &mut logs);
        assert!(batch.complete);
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].session_id, ROOT_ID);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn same_uuid_candidates_with_different_event_timestamps_defer() {
        let root = temp_root();
        let active = root.join("sessions");
        let archived = root.join("archived_sessions");
        fs::create_dir_all(&active).expect("create active fixture root");
        fs::create_dir_all(&archived).expect("create archived fixture root");
        let usage = (1_000, 800, 100);
        for (source_root, timestamp) in [
            (&active, "2026-07-15T00:00:01Z"),
            (&archived, "2026-07-15T01:00:01Z"),
        ] {
            write_rollout_values(
                &rollout_path(source_root, ROOT_ID),
                &[
                    session_meta(ROOT_ID, "2026-07-15T00:00:00Z", None, None, None),
                    token_event_with(Some(timestamp), usage, Some(usage), None),
                ],
            );
        }

        let batch = scan_codex_roots_checkpointed(&[active, archived], &HashMap::new(), false);
        assert!(!batch.complete);
        assert!(batch.logs.is_empty());
        assert!(batch.checkpoints.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_timestamp_and_parent_conflict_defer_without_checkpoint() {
        let root = temp_root();
        write_rollout_values(
            &rollout_path(&root, ROOT_ID),
            &[
                session_meta(
                    ROOT_ID,
                    "2026-07-15T00:00:00Z",
                    Some(PARENT_ID),
                    Some(OTHER_ID),
                    None,
                ),
                token_event_with(None, (500, 300, 50), Some((500, 300, 50)), None),
            ],
        );
        let batch =
            scan_codex_roots_checkpointed(std::slice::from_ref(&root), &HashMap::new(), false);
        assert!(!batch.complete);
        assert!(batch.logs.is_empty());
        assert!(batch.checkpoints.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn standalone_billable_event_without_timestamp_is_deferred() {
        let root = temp_root();
        write_rollout_values(
            &rollout_path(&root, ROOT_ID),
            &[
                session_meta(ROOT_ID, "2026-07-15T00:00:00Z", None, None, None),
                token_event_with(None, (500, 300, 50), Some((500, 300, 50)), None),
            ],
        );
        let batch =
            scan_codex_roots_checkpointed(std::slice::from_ref(&root), &HashMap::new(), false);
        assert!(!batch.complete);
        assert!(batch.logs.is_empty());
        assert!(batch.checkpoints.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn total_only_events_use_high_water_fallback() {
        let root = temp_root();
        write_rollout_values(
            &rollout_path(&root, ROOT_ID),
            &[
                session_meta(ROOT_ID, "2026-07-15T00:00:00Z", None, None, None),
                token_event_with(Some("2026-07-15T00:00:01Z"), (1_000, 800, 100), None, None),
                token_event_with(
                    Some("2026-07-15T00:00:02Z"),
                    (1_500, 1_100, 140),
                    None,
                    None,
                ),
            ],
        );
        let mut logs = Vec::new();
        let batch = scan_codex_roots(std::slice::from_ref(&root), &mut logs);
        assert!(batch.complete);
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[1].input_tokens, 200);
        assert_eq!(logs[1].cached_tokens, 300);
        assert_eq!(logs[1].output_tokens, 40);
        let _ = fs::remove_dir_all(root);
    }

    /// Builds a Multica-shaped home: `multica_workspaces_<host>/<workspace>/<task>/codex-home`.
    const MULTICA_HOST_DIR: &str = "multica_workspaces_desktop-api.multica.ai";

    fn multica_task_home(home: &Path, workspace: &str, task: &str) -> PathBuf {
        home.join(MULTICA_HOST_DIR)
            .join(workspace)
            .join(task)
            .join("codex-home")
    }

    #[test]
    fn discovers_multica_task_scoped_codex_homes_in_both_directory_shapes() {
        let home = temp_root();
        // Current daemon layout uses `task-<hex>` names.
        let current = multica_task_home(
            &home,
            "608dca51-1217-4d88-ae77-375428355246",
            "task-e550b24dfba3",
        );
        fs::create_dir_all(current.join("sessions")).unwrap();
        // Older chat-task layout used a bare 8-hex directory name.
        let legacy = multica_task_home(&home, "5ddcee7f-d0b6-49f4-8048-084b579f8fec", "0ce1e6f2");
        fs::create_dir_all(legacy.join("sessions")).unwrap();

        let roots = discover_multica_codex_roots_in(&home);

        assert!(
            roots.contains(&current.join("sessions")),
            "current task-<hex> layout must be discovered: {roots:?}"
        );
        assert!(
            roots.contains(&legacy.join("sessions")),
            "legacy 8-hex chat layout must be discovered: {roots:?}"
        );
        // Both active and archive roots are offered for every discovered home.
        assert!(roots.contains(&current.join("archived_sessions")));

        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn ignores_unrelated_home_directories() {
        let home = temp_root();
        // A `.codex` home is handled by the caller's static roots, not here.
        fs::create_dir_all(home.join(".codex").join("sessions")).unwrap();
        // Any other product that happens to ship a `codex-home` is not ours.
        fs::create_dir_all(
            home.join("some_other_tool")
                .join("task-1")
                .join("codex-home")
                .join("sessions"),
        )
        .unwrap();

        let roots = discover_multica_codex_roots_in(&home);

        assert!(
            roots.is_empty(),
            "only multica_workspaces_* roots may be discovered: {roots:?}"
        );

        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn missing_or_empty_multica_workspace_yields_no_roots() {
        let home = temp_root();
        // Present but containing no prepared task yet.
        fs::create_dir_all(home.join(MULTICA_HOST_DIR)).unwrap();

        assert!(discover_multica_codex_roots_in(&home).is_empty());
        assert!(discover_multica_codex_roots_in(&home.join("does-not-exist")).is_empty());

        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn multica_rollouts_are_scanned_through_the_standard_codex_parser() {
        let home = temp_root();
        let codex_home = multica_task_home(
            &home,
            "608dca51-1217-4d88-ae77-375428355246",
            "task-e550b24dfba3",
        );
        let sessions = codex_home
            .join("sessions")
            .join("2026")
            .join("09")
            .join("12");
        fs::create_dir_all(&sessions).unwrap();
        write_rollout_values(
            &rollout_path(&sessions, ROOT_ID),
            &[
                session_meta(ROOT_ID, "2026-09-12T09:19:00.000Z", None, None, None),
                turn_context("2026-09-12T09:19:01.000Z", "gpt-5.6-sol"),
                token_event(
                    "2026-09-12T09:19:02.000Z",
                    22622,
                    11392,
                    300,
                    22622,
                    11392,
                    300,
                ),
            ],
        );

        let roots = discover_multica_codex_roots_in(&home);
        let batch = scan_codex_roots_checkpointed(&roots, &HashMap::new(), false);

        assert!(batch.complete, "discovered Multica roots must scan cleanly");
        assert_eq!(batch.logs.len(), 1, "one token_count event yields one log");
        let record = &batch.logs[0];
        // 统计口径与直连 Codex 完全一致：`input_tokens` 是扣掉缓存命中后的
        // 新输入，缓存读写单列，不重复并入有效 Token。
        assert_eq!(record.input_tokens, 22622 - 11392);
        assert_eq!(record.output_tokens, 300);
        assert_eq!(record.cached_tokens, 11392);
        assert_eq!(record.input_tokens + record.output_tokens, 11530);
        assert_eq!(record.tool, "codex");
        assert_eq!(record.model, "gpt-5.6-sol");

        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn vanished_multica_task_directory_is_not_a_scan_failure() {
        let home = temp_root();
        let codex_home =
            multica_task_home(&home, "608dca51-1217-4d88-ae77-375428355246", "task-gone");
        fs::create_dir_all(codex_home.join("sessions")).unwrap();
        let roots = discover_multica_codex_roots_in(&home);
        assert!(!roots.is_empty());
        // The daemon garbage-collects finished tasks; the tree can disappear
        // between discovery and the rollout read.
        fs::remove_dir_all(&home).unwrap();

        let batch = scan_codex_roots_checkpointed(&roots, &HashMap::new(), false);

        assert!(
            batch.complete,
            "a task directory removed by the Multica GC is expected, not an error"
        );
        assert!(batch.logs.is_empty());
    }

    /// Real-machine probe: scans the actual Multica task tree on this host.
    ///
    /// Ignored by default because it depends on Multica being installed and on
    /// live task directories that the daemon GC may remove at any time. Run
    /// explicitly with:
    /// `cargo test -- --ignored multica_real_machine_probe --nocapture`
    #[test]
    #[ignore = "requires a real Multica Desktop installation on this machine"]
    fn multica_real_machine_probe() {
        let home = get_home_dir();
        let roots = discover_multica_codex_roots_in(&home);
        let existing: Vec<&PathBuf> = roots.iter().filter(|root| root.is_dir()).collect();
        println!("discovered roots: {}", roots.len());
        println!("existing roots: {}", existing.len());
        for root in &existing {
            println!("  {root:?}");
        }
        if existing.is_empty() {
            println!("no Multica task-scoped Codex home present; nothing to scan");
            return;
        }

        let batch = scan_codex_roots_checkpointed(&roots, &HashMap::new(), false);
        let input: i64 = batch.logs.iter().map(|log| log.input_tokens).sum();
        let output: i64 = batch.logs.iter().map(|log| log.output_tokens).sum();
        let cached: i64 = batch.logs.iter().map(|log| log.cached_tokens).sum();
        println!(
            "complete={} logs={} input={input} output={output} cached={cached} effective={}",
            batch.complete,
            batch.logs.len(),
            input + output
        );
        assert!(
            batch.complete,
            "real Multica roots must scan without deferral"
        );
        assert!(!batch.logs.is_empty(), "real machine has Multica rollouts");
    }

    /// The Cindy `userData` directory derived from the fixture home (the
    /// platform's per-user app data directory plus the CN build's name).
    fn cindy_user_data(home: &Path) -> PathBuf {
        super::super::cindy::cindy_user_data_dirs_in(home)
            .into_iter()
            .find(|dir| dir.starts_with(home) && dir.ends_with("Cindy"))
            .expect("home-derived Cindy userData directory")
    }

    fn sessions_day(root: &Path) -> PathBuf {
        let day = root.join("2026").join("10").join("24");
        fs::create_dir_all(&day).unwrap();
        day
    }

    #[test]
    fn discovers_cindy_default_and_account_codex_homes() {
        let home = temp_root();
        let user_data = cindy_user_data(&home);
        let default_home = user_data.join("codex-home");
        fs::create_dir_all(default_home.join("sessions")).unwrap();
        let account_home = user_data
            .join("codex-accounts")
            .join("0f".repeat(32))
            .join("openai");
        fs::create_dir_all(account_home.join("sessions")).unwrap();

        let roots = discover_codex_log_roots_in(&home);

        assert!(roots.contains(&home.join(".codex").join("sessions")));
        assert!(roots.contains(&default_home.join("sessions")));
        assert!(roots.contains(&default_home.join("archived_sessions")));
        assert!(roots.contains(&account_home.join("sessions")));
        // The global build keeps its own directory next to the CN one.
        assert!(roots
            .iter()
            .any(|root| root.ends_with(Path::new("CindyGlobal/codex-home/sessions"))));
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn cindy_rollouts_take_deltas_and_count_copied_threads_once() {
        let home = temp_root();
        let codex_sessions = sessions_day(&home.join(".codex").join("sessions"));
        let cindy_sessions =
            sessions_day(&cindy_user_data(&home).join("codex-home").join("sessions"));
        let first = token_event_with(
            Some("2026-10-24T01:00:01Z"),
            (1_000, 600, 100),
            Some((1_000, 600, 100)),
            None,
        );
        let second = token_event_with(
            Some("2026-10-24T01:00:02Z"),
            (2_500, 1_600, 180),
            Some((1_500, 1_000, 80)),
            None,
        );
        let header = [
            session_meta(ROOT_ID, "2026-10-24T01:00:00Z", None, None, None),
            turn_context("2026-10-24T01:00:00Z", "gpt-5.5"),
        ];
        // Cindy imported the thread from the default home and continued it,
        // so its copy extends the original rollout.
        let mut original = header.to_vec();
        original.push(first.clone());
        write_rollout_values(&rollout_path(&codex_sessions, ROOT_ID), &original);
        let mut copy = header.to_vec();
        copy.extend([first, second]);
        write_rollout_values(&rollout_path(&cindy_sessions, ROOT_ID), &copy);

        let roots = discover_codex_log_roots_in(&home)
            .into_iter()
            .filter(|root| root.starts_with(&home))
            .collect::<Vec<_>>();
        let batch = scan_codex_roots_checkpointed(&roots, &HashMap::new(), false);

        assert!(batch.complete);
        assert_eq!(batch.logs.len(), 2, "one record per token_count event");
        let input: i64 = batch.logs.iter().map(|log| log.input_tokens).sum();
        let cached: i64 = batch.logs.iter().map(|log| log.cached_tokens).sum();
        let output: i64 = batch.logs.iter().map(|log| log.output_tokens).sum();
        // Sums equal the final cumulative total, not the sum of both copies'
        // totals or of the cumulative snapshots.
        assert_eq!(input + cached, 2_500);
        assert_eq!(cached, 1_600);
        assert_eq!(output, 180);
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn cindy_fork_of_a_default_home_thread_skips_the_replayed_history() {
        let home = temp_root();
        let codex_sessions = sessions_day(&home.join(".codex").join("sessions"));
        let cindy_sessions =
            sessions_day(&cindy_user_data(&home).join("codex-home").join("sessions"));
        let inherited = token_event_with(
            Some("2026-10-24T01:00:01Z"),
            (1_000, 800, 100),
            Some((1_000, 800, 100)),
            None,
        );
        write_rollout_values(
            &rollout_path(&codex_sessions, PARENT_ID),
            &[
                session_meta(PARENT_ID, "2026-10-24T01:00:00Z", None, None, None),
                turn_context("2026-10-24T01:00:00Z", "gpt-5.5"),
                inherited.clone(),
                serde_json::json!({
                    "timestamp": "2026-10-24T01:00:03Z",
                    "type": "event_msg",
                    "payload": { "type": "task_complete" }
                }),
            ],
        );
        write_rollout_values(
            &rollout_path(&cindy_sessions, CHILD_ID),
            &[
                session_meta(
                    CHILD_ID,
                    "2026-10-24T01:00:02Z",
                    Some(PARENT_ID),
                    None,
                    None,
                ),
                turn_context("2026-10-24T01:00:02Z", "gpt-5.5"),
                inherited,
                token_event_with(
                    Some("2026-10-24T01:00:04Z"),
                    (1_600, 1_200, 150),
                    Some((600, 400, 50)),
                    None,
                ),
            ],
        );

        let roots = discover_codex_log_roots_in(&home);
        let batch = scan_codex_roots_checkpointed(&roots, &HashMap::new(), false);

        assert!(batch.complete);
        let child = batch
            .logs
            .iter()
            .filter(|log| log.session_id == CHILD_ID)
            .collect::<Vec<_>>();
        assert_eq!(
            child.len(),
            1,
            "the replayed parent event is not counted again"
        );
        assert_eq!(child[0].input_tokens, 200);
        assert_eq!(child[0].cached_tokens, 400);
        assert_eq!(child[0].output_tokens, 50);
        fs::remove_dir_all(home).ok();
    }

    #[test]
    fn configured_codex_dirs_accept_homes_and_session_dirs() {
        let home = temp_root();
        let codex_home = home.join("custom-codex-home");
        fs::create_dir_all(codex_home.join("sessions")).unwrap();
        let sessions_only = home.join("other").join("sessions");
        fs::create_dir_all(&sessions_only).unwrap();
        let plain = home.join("exported-rollouts");
        fs::create_dir_all(&plain).unwrap();

        let roots = configured_codex_roots(
            &[
                codex_home.to_string_lossy().to_string(),
                sessions_only.to_string_lossy().to_string(),
                "~/exported-rollouts".to_string(),
                "relative/dir".to_string(),
                "%TOKENLEDGER_TEST_UNSET_VARIABLE%/sessions".to_string(),
                "  ".to_string(),
            ],
            &home,
        );

        assert_eq!(
            roots,
            vec![
                codex_home.join("sessions"),
                codex_home.join("archived_sessions"),
                sessions_only,
                plain,
            ]
        );
        fs::remove_dir_all(home).ok();
    }

    /// Real-machine probe: scans the Cindy Codex homes on this host.
    ///
    /// `cargo test -- --ignored cindy_real_machine_probe --nocapture`
    /// Only aggregate counters are printed.
    #[test]
    #[ignore = "requires a real Cindy installation on this machine"]
    fn cindy_real_machine_probe() {
        let roots = super::super::cindy::cindy_codex_roots_in(&get_home_dir());
        let existing: Vec<&PathBuf> = roots.iter().filter(|root| root.is_dir()).collect();
        println!("existing Cindy Codex roots: {}", existing.len());
        if existing.is_empty() {
            println!("no Cindy Codex home present; nothing to scan");
            return;
        }
        let batch = scan_codex_roots_checkpointed(&roots, &HashMap::new(), false);
        let threads: HashSet<&str> = batch
            .logs
            .iter()
            .map(|log| log.session_id.as_str())
            .collect();
        let input: i64 = batch.logs.iter().map(|log| log.input_tokens).sum();
        let cached: i64 = batch.logs.iter().map(|log| log.cached_tokens).sum();
        let output: i64 = batch.logs.iter().map(|log| log.output_tokens).sum();
        println!(
            "complete={} threads={} logs={} input={input} cached={cached} output={output}",
            batch.complete,
            threads.len(),
            batch.logs.len()
        );
    }
}

#[cfg(test)]
mod scanner_claude_tests {
    use super::*;
    use std::fs::{self, File, OpenOptions};
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        static NEXT_TEMP_ROOT: AtomicU64 = AtomicU64::new(0);
        let now_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = NEXT_TEMP_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "tokenledger_claude_test_{}_{}_{}",
            std::process::id(),
            now_nanos,
            sequence
        ));
        fs::create_dir_all(root.join("proj")).unwrap();
        root
    }

    fn write_assistant_line(
        file: &mut File,
        msg_id: &str,
        request_id: &str,
        uuid: &str,
        output_tokens: i64,
    ) {
        let line = serde_json::json!({
            "type": "assistant",
            "uuid": uuid,
            "requestId": request_id,
            "timestamp": "2026-06-13T03:00:00.000Z",
            "message": {
                "id": msg_id,
                "model": "claude-fable-5",
                "usage": {
                    "input_tokens": 5,
                    "output_tokens": output_tokens,
                    "cache_read_input_tokens": 100,
                    "cache_creation_input_tokens": 10
                }
            }
        });
        writeln!(file, "{}", line).unwrap();
    }

    fn scan_fixture(
        roots: &[PathBuf],
        db_path: &Path,
    ) -> Result<(ScanOutcome, CheckpointScanStats)> {
        let conn = crate::db::get_connection(db_path)?;
        let checkpoints = crate::db::load_scan_checkpoints(&conn, CLAUDE_CHECKPOINT_SOURCE_KIND)?;
        drop(conn);
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let stats = scan_claude_roots_checkpointed(roots, &checkpoints, &mut logs, &mut pending);
        let outcome = persist_scan_batch(db_path, logs, pending, Vec::new(), None)?;
        Ok((outcome, stats))
    }

    #[test]
    fn discovers_cli_macos_windows_msix_and_xdg_candidates() {
        let root = temp_root();
        let home = root.join("home");
        let appdata = root.join("roaming");
        let local_appdata = root.join("local");
        let xdg = root.join("xdg");
        let dynamic_package = local_appdata.join("Packages/Claude_preview");
        fs::create_dir_all(&dynamic_package).unwrap();

        let macos = claude_log_candidates_for(ClaudeHostPlatform::Macos, &home, None, None, None);
        assert!(macos.contains(&home.join(".claude/projects")));
        assert!(macos
            .contains(&home.join("Library/Application Support/Claude/local-agent-mode-sessions")));
        assert!(macos.contains(
            &home.join("Library/Application Support/Claude-3p/local-agent-mode-sessions")
        ));

        let windows = claude_log_candidates_for(
            ClaudeHostPlatform::Windows,
            &home,
            Some(&appdata),
            Some(&local_appdata),
            None,
        );
        assert!(windows.contains(&appdata.join("Claude/local-agent-mode-sessions")));
        assert!(windows.contains(&local_appdata.join(
            "Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/local-agent-mode-sessions"
        )));
        assert!(windows.contains(
            &dynamic_package.join("LocalCache/Roaming/Claude-3p/local-agent-mode-sessions")
        ));

        let linux =
            claude_log_candidates_for(ClaudeHostPlatform::Other, &home, None, None, Some(&xdg));
        assert!(linux.contains(&xdg.join("Claude/local-agent-mode-sessions")));

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn dedupes_entries_of_same_message_keeping_final_snapshot() {
        let root = temp_root();
        let mut file = File::create(root.join("proj/session-abc.jsonl")).unwrap();
        // One API response split into three content-block entries: usage is
        // repeated, output_tokens grows from the streaming placeholder (1)
        // to the final value (318).
        write_assistant_line(&mut file, "msg_1", "req_1", "u1", 1);
        write_assistant_line(&mut file, "msg_1", "req_1", "u2", 1);
        write_assistant_line(&mut file, "msg_1", "req_1", "u3", 318);
        // A second, independent API call.
        write_assistant_line(&mut file, "msg_2", "req_2", "u4", 42);
        drop(file);

        let mut logs = Vec::new();
        let count = scan_claude_dir(&root, &mut logs);
        assert_eq!(count, 2);
        assert_eq!(logs.len(), 2);

        let first = logs
            .iter()
            .find(|l| l.unique_key == "claude_msg_1_req_1")
            .expect("msg_1 record");
        assert_eq!(first.output_tokens, 318);
        assert_eq!(first.input_tokens, 5);
        assert_eq!(first.cached_tokens, 110);
        assert_eq!(first.cache_write_tokens, 10);
        assert_eq!(first.model, "claude-fable-5");

        let second = logs
            .iter()
            .find(|l| l.unique_key == "claude_msg_2_req_2")
            .expect("msg_2 record");
        assert_eq!(second.output_tokens, 42);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dedupes_history_entries_copied_across_session_files() {
        let root = temp_root();
        let mut a = File::create(root.join("proj/session-a.jsonl")).unwrap();
        write_assistant_line(&mut a, "msg_1", "req_1", "u1", 200);
        drop(a);
        // Resumed session: the same message is copied into a new file.
        let mut b = File::create(root.join("proj/session-b.jsonl")).unwrap();
        write_assistant_line(&mut b, "msg_1", "req_1", "u1", 200);
        drop(b);

        let mut logs = Vec::new();
        let count = scan_claude_dir(&root, &mut logs);
        assert_eq!(count, 1);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dedupes_across_cli_and_cowork_roots_before_persisting() {
        let root = temp_root();
        let cli_root = root.join("cli");
        let cowork_root = root.join("cowork/deep/sandbox");
        fs::create_dir_all(&cli_root).unwrap();
        fs::create_dir_all(&cowork_root).unwrap();
        let db_path = root.join("tokenboard.db");
        crate::db::init_test_db(&db_path).unwrap();

        let mut cli = File::create(cli_root.join("session-cli.jsonl")).unwrap();
        write_assistant_line(&mut cli, "msg_shared", "", "cli-1", 1);
        drop(cli);
        let mut cowork = File::create(cowork_root.join("agent-cowork.jsonl")).unwrap();
        write_assistant_line(&mut cowork, "msg_shared", "", "cowork-1", 318);
        drop(cowork);

        let (outcome, stats) =
            scan_fixture(&[cli_root.clone(), cowork_root.clone()], &db_path).unwrap();
        assert_eq!(outcome.inserted, 1);
        assert_eq!(stats.parsed_files, 2);
        assert_eq!(stats.parsed_records, 1);
        let conn = crate::db::get_connection(&db_path).unwrap();
        let (rows, output): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(output_tokens) FROM token_logs WHERE unique_key = 'claude_msg_shared'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, output), (1, 318));

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn appended_final_snapshot_updates_row_and_unchanged_file_is_skipped() {
        let root = temp_root();
        let source_root = root.join("cowork");
        fs::create_dir_all(&source_root).unwrap();
        let db_path = root.join("tokenboard.db");
        crate::db::init_test_db(&db_path).unwrap();
        let log_path = source_root.join("agent-stream.jsonl");

        let mut file = File::create(&log_path).unwrap();
        write_assistant_line(&mut file, "msg_stream", "req_stream", "u1", 1);
        drop(file);
        let (first, first_stats) =
            scan_fixture(std::slice::from_ref(&source_root), &db_path).expect("first Claude scan");
        assert_eq!(first.inserted, 1);
        assert_eq!(first_stats.parsed_files, 1);

        let mut file = OpenOptions::new().append(true).open(&log_path).unwrap();
        write_assistant_line(&mut file, "msg_stream", "req_stream", "u2", 318);
        file.sync_all().unwrap();
        drop(file);
        let (updated, updated_stats) = scan_fixture(std::slice::from_ref(&source_root), &db_path)
            .expect("updated Claude scan");
        assert_eq!(
            updated.inserted, 1,
            "the corrected row is a persisted change"
        );
        assert_eq!(updated_stats.parsed_files, 1);
        assert_eq!(updated_stats.parsed_records, 1);

        let conn = crate::db::get_connection(&db_path).unwrap();
        let (rows, output, cache): (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(output_tokens), MAX(cached_tokens) FROM token_logs WHERE unique_key = 'claude_msg_stream_req_stream'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((rows, output, cache), (1, 318, 110));
        drop(conn);

        let (unchanged, unchanged_stats) =
            scan_fixture(std::slice::from_ref(&source_root), &db_path)
                .expect("unchanged Claude scan");
        assert_eq!(unchanged.inserted, 0);
        assert_eq!(unchanged_stats.parsed_files, 0);
        assert_eq!(unchanged_stats.skipped_files, 1);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    #[ignore = "requires an explicit user-local Claude Cowork root"]
    fn scans_opt_in_real_cowork_root() {
        let root = std::env::var_os("TOKENLEDGER_CLAUDE_REAL_ROOT")
            .map(PathBuf::from)
            .expect("set TOKENLEDGER_CLAUDE_REAL_ROOT explicitly");
        let canonical = fs::canonicalize(root).expect("resolve real Cowork root");
        assert!(
            discover_claude_log_roots().contains(&canonical),
            "production discovery must include the explicitly selected Cowork root"
        );
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let stats =
            scan_claude_roots_checkpointed(&[canonical], &HashMap::new(), &mut logs, &mut pending);
        assert!(stats.parsed_files > 0, "real root must contain JSONL files");
        assert!(
            stats.parsed_records > 0,
            "real root must contain usage rows"
        );
        assert_eq!(stats.failed_files, 0);
        println!(
            "real Cowork validation: files={}, deduped_records={}",
            stats.parsed_files, stats.parsed_records
        );
    }
}

#[cfg(test)]
mod scanner_cumulative_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT_DB: AtomicUsize = AtomicUsize::new(0);

    fn temp_db() -> Connection {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_cumulative_test_{}_{}.db",
            std::process::id(),
            NEXT_DB.fetch_add(1, Ordering::SeqCst)
        ));
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE token_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tool TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                cached_tokens INTEGER DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                timestamp TEXT NOT NULL,
                session_id TEXT NOT NULL,
                unique_key TEXT UNIQUE NOT NULL,
                cost_usd REAL,
                machine_id TEXT NOT NULL DEFAULT '',
                sync_status INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE scan_cumulative_state (
                unique_key TEXT PRIMARY KEY,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                cached_tokens INTEGER NOT NULL,
                cache_write_tokens INTEGER NOT NULL,
                cost_usd REAL,
                generation INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT
                    (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            )",
        )
        .unwrap();
        conn
    }

    fn snapshot(input: i64, output: i64, cost: Option<f64>) -> LogRecord {
        LogRecord {
            tool: "hermes".to_string(),
            model: "hermes-model".to_string(),
            input_tokens: input,
            output_tokens: output,
            cached_tokens: 0,
            cache_write_tokens: 0,
            timestamp: "2026-06-13 10:00:00".to_string(),
            session_id: "s1".to_string(),
            unique_key: "hermes_s1".to_string(),
            cost_usd: cost,
            cumulative: true,
        }
    }

    fn totals(conn: &Connection) -> (i64, i64, f64) {
        conn.query_row(
            "SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cost_usd),0.0) FROM token_logs",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    }

    #[test]
    fn growing_snapshot_lands_as_deltas() {
        let mut conn = temp_db();

        // First sighting stores the snapshot verbatim.
        let tx = conn.transaction().unwrap();
        assert!(insert_cumulative_delta(&tx, &snapshot(100, 50, Some(0.5)), "m").unwrap());
        tx.commit().unwrap();
        assert_eq!(totals(&conn), (100, 50, 0.5));

        // Unchanged source: nothing new.
        let tx = conn.transaction().unwrap();
        assert!(!insert_cumulative_delta(&tx, &snapshot(100, 50, Some(0.5)), "m").unwrap());
        tx.commit().unwrap();

        // Grown source: only the delta is added; totals match the source.
        let tx = conn.transaction().unwrap();
        assert!(insert_cumulative_delta(&tx, &snapshot(160, 90, Some(0.8)), "m").unwrap());
        tx.commit().unwrap();
        let (sum_in, sum_out, sum_cost) = totals(&conn);
        assert_eq!((sum_in, sum_out), (160, 90));
        assert!((sum_cost - 0.8).abs() < 1e-9);

        // Shrunk source (DB reset): skipped, totals untouched.
        let tx = conn.transaction().unwrap();
        assert!(!insert_cumulative_delta(&tx, &snapshot(10, 5, None), "m").unwrap());
        tx.commit().unwrap();
        assert_eq!(totals(&conn).0, 160);
        // The reset source reaches totals already used by generation zero.
        let tx = conn.transaction().unwrap();
        assert!(insert_cumulative_delta(&tx, &snapshot(160, 90, None), "m").unwrap());
        tx.commit().unwrap();
        assert_eq!((totals(&conn).0, totals(&conn).1), (310, 175));
        let tx = conn.transaction().unwrap();
        assert!(!insert_cumulative_delta(&tx, &snapshot(160, 90, None), "m").unwrap());
        tx.commit().unwrap();
        assert_eq!((totals(&conn).0, totals(&conn).1), (310, 175));
    }

    #[test]
    fn reset_generation_survives_reopen_and_failed_insert_rolls_back_state() {
        let mut conn = temp_db();
        let path = conn.path().unwrap().to_owned();
        for (input, output) in [(100, 50), (160, 90), (10, 5)] {
            let tx = conn.transaction().unwrap();
            insert_cumulative_delta(&tx, &snapshot(input, output, None), "m").unwrap();
            tx.commit().unwrap();
        }
        drop(conn);
        let mut conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_delta BEFORE INSERT ON token_logs BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
        {
            let tx = conn.transaction().unwrap();
            assert!(insert_cumulative_delta(&tx, &snapshot(160, 90, None), "m").is_err());
            // Dropping the transaction also discards any state advance.
        }
        let state: (i64, i64) = conn
            .query_row(
                "SELECT input_tokens, generation FROM scan_cumulative_state",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, (10, 1));
        conn.execute_batch("DROP TRIGGER fail_delta").unwrap();
        let tx = conn.transaction().unwrap();
        assert!(insert_cumulative_delta(&tx, &snapshot(160, 90, None), "m").unwrap());
        tx.commit().unwrap();
        assert_eq!((totals(&conn).0, totals(&conn).1), (310, 175));
        drop(conn);
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod scanner_scale_gate_tests {
    use super::*;
    use std::collections::HashMap;
    use std::time::Instant;

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct CodexDbGateStats {
        user_version: i64,
        codex_rows: i64,
        input_tokens: i64,
        output_tokens: i64,
        cached_tokens: i64,
        cache_write_tokens: i64,
        v1_keys: i64,
        v2_keys: i64,
        ready_purges: i64,
        staged_purges: i64,
        non_codex_rows: i64,
    }

    fn codex_db_gate_stats(conn: &Connection) -> CodexDbGateStats {
        let user_version = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read schema version from authorized DB copy");
        let (
            codex_rows,
            input_tokens,
            output_tokens,
            cached_tokens,
            cache_write_tokens,
            v1_keys,
            v2_keys,
        ) = conn
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(input_tokens), 0),
                        COALESCE(SUM(output_tokens), 0),
                        COALESCE(SUM(cached_tokens), 0),
                        COALESCE(SUM(cache_write_tokens), 0),
                        COALESCE(SUM(CASE WHEN unique_key NOT LIKE 'codex_v2_%' THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN unique_key LIKE 'codex_v2_%' THEN 1 ELSE 0 END), 0)
                 FROM token_logs WHERE tool = 'codex'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .expect("read Codex totals from authorized DB copy");
        let (ready_purges, staged_purges) = conn
            .query_row(
                "SELECT COALESCE(SUM(CASE WHEN ready = 1 THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN ready = 0 THEN 1 ELSE 0 END), 0)
                 FROM pending_cloud_purges WHERE tool = 'codex'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read Codex purge state from authorized DB copy");
        let non_codex_rows = conn
            .query_row(
                "SELECT COUNT(*) FROM token_logs WHERE tool != 'codex'",
                [],
                |row| row.get(0),
            )
            .expect("count non-Codex rows in authorized DB copy");
        CodexDbGateStats {
            user_version,
            codex_rows,
            input_tokens,
            output_tokens,
            cached_tokens,
            cache_write_tokens,
            v1_keys,
            v2_keys,
            ready_purges,
            staged_purges,
            non_codex_rows,
        }
    }

    fn configured_real_db_path() -> PathBuf {
        const APP_ID: &str = "com.jeidorf.tokenledger";
        if let Some(path) = std::env::var_os("TOKENLEDGER_APPDATA") {
            return PathBuf::from(path).join("tokenboard.db");
        }
        #[cfg(target_os = "windows")]
        {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| dirs::data_dir().unwrap_or_default())
                .join(APP_ID)
                .join("tokenboard.db")
        }
        #[cfg(target_os = "macos")]
        {
            if let Some(home) = std::env::var_os("HOME") {
                return PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join(APP_ID)
                    .join("tokenboard.db");
            }
            dirs::data_dir()
                .unwrap_or_default()
                .join(APP_ID)
                .join("tokenboard.db")
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            dirs::data_dir()
                .unwrap_or_default()
                .join(APP_ID)
                .join("tokenboard.db")
        }
    }

    fn authorized_codex_rebuild_copy_path() -> PathBuf {
        assert_eq!(
            std::env::var("TOKENLEDGER_RUN_REAL_SCAN_GATE").as_deref(),
            Ok("1"),
            "set TOKENLEDGER_RUN_REAL_SCAN_GATE=1 to authorize local source reads"
        );
        let db_path = PathBuf::from(
            std::env::var_os("TOKENLEDGER_CODEX_REBUILD_DB_COPY")
                .expect("set TOKENLEDGER_CODEX_REBUILD_DB_COPY to an absolute database-copy path"),
        );
        assert!(db_path.is_absolute(), "database-copy path must be absolute");
        let link_metadata =
            fs::symlink_metadata(&db_path).expect("authorized database copy must already exist");
        assert!(
            link_metadata.file_type().is_file(),
            "authorized database copy must be a regular file, not a directory or symlink"
        );
        let canonical_copy = fs::canonicalize(&db_path).expect("canonicalize database-copy path");
        let real_db_path = configured_real_db_path();
        if real_db_path.exists() {
            let canonical_real =
                fs::canonicalize(&real_db_path).expect("canonicalize real AppData database path");
            assert_ne!(
                canonical_copy, canonical_real,
                "refusing to run the rebuild gate on the real AppData database"
            );
            let copy_identity = source_fingerprint(&canonical_copy)
                .expect("fingerprint authorized database copy")
                .source_identity;
            let real_identity = source_fingerprint(&canonical_real)
                .expect("fingerprint real AppData database")
                .source_identity;
            assert_ne!(
                copy_identity, real_identity,
                "refusing a hard link to the real AppData database"
            );
        }
        canonical_copy
    }

    fn codex_rebuild_inventory() -> HashSet<String> {
        let codex_home = get_home_dir().join(".codex");
        let mut inventory = HashSet::new();
        for root in [
            codex_home.join("sessions"),
            codex_home.join("archived_sessions"),
        ] {
            if !root.exists() {
                continue;
            }
            for entry in WalkDir::new(root) {
                let entry = entry.expect("walk complete Codex inventory for rebuild gate");
                let path = entry.path();
                if !is_codex_rollout(path) {
                    continue;
                }
                if let Some(legacy_session_id) = codex_legacy_session_id(path) {
                    inventory.insert(legacy_session_id);
                }
                if let Some(root_session_id) = codex_thread_id_from_path(path) {
                    inventory.insert(root_session_id);
                }
            }
        }
        inventory
    }

    fn current_v1_codex_rows(conn: &Connection, machine_id: &str) -> HashMap<String, String> {
        conn.prepare(
            "SELECT unique_key, session_id FROM token_logs
             WHERE tool = 'codex'
               AND unique_key NOT LIKE 'codex_v2_%'
               AND (machine_id = ?1 OR machine_id = '')",
        )
        .expect("prepare v1 Codex row query")
        .query_map([machine_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query v1 Codex rows")
        .collect::<rusqlite::Result<HashMap<_, _>>>()
        .expect("collect v1 Codex rows")
    }

    fn current_codex_purge_state(conn: &Connection, machine_id: &str) -> (i64, i64) {
        conn.query_row(
            "SELECT COALESCE(SUM(CASE WHEN ready = 1 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN ready = 0 THEN 1 ELSE 0 END), 0)
             FROM pending_cloud_purges
             WHERE tool = 'codex' AND machine_id = ?1",
            [machine_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read current-machine Codex purge state")
    }

    #[test]
    #[ignore = "explicit release performance gate"]
    fn provider_keyset_queries_stay_indexed_at_scale() {
        let conn = Connection::open_in_memory().expect("open scale fixture");
        conn.execute_batch(
            "CREATE TABLE numeric_usage (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
             WITH RECURSIVE rows(id) AS (
                 SELECT 1 UNION ALL SELECT id + 1 FROM rows WHERE id < 1000000
             ) INSERT INTO numeric_usage SELECT id, 'usage' FROM rows;
             CREATE TABLE message (
                 id TEXT PRIMARY KEY,
                 time_updated INTEGER NOT NULL,
                 data TEXT NOT NULL
             );
             WITH RECURSIVE rows(id) AS (
                 SELECT 1 UNION ALL SELECT id + 1 FROM rows WHERE id < 100000
             ) INSERT INTO message
               SELECT printf('msg_%012d', id), id, '{\"tokens\":{\"input\":1}}' FROM rows;",
        )
        .expect("seed provider scale fixture");

        let numeric_plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN SELECT id, payload FROM numeric_usage
                 WHERE id > 999990 ORDER BY id",
                [],
                |row| row.get(3),
            )
            .expect("numeric cursor plan");
        let text_plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN SELECT id, time_updated, data FROM message
                 WHERE id > 'msg_000000099488' ORDER BY id",
                [],
                |row| row.get(3),
            )
            .expect("text cursor plan");
        assert!(
            numeric_plan.contains("INTEGER PRIMARY KEY"),
            "{numeric_plan}"
        );
        assert!(
            text_plan.contains("sqlite_autoindex_message_1"),
            "{text_plan}"
        );

        let started = Instant::now();
        for _ in 0..100 {
            let numeric_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM numeric_usage WHERE id > 999990",
                    [],
                    |row| row.get(0),
                )
                .expect("numeric tail count");
            let text_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM message WHERE id > 'msg_000000099488'",
                    [],
                    |row| row.get(0),
                )
                .expect("text tail count");
            assert_eq!(numeric_count, 10);
            assert_eq!(text_count, 512);
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_millis(250),
            "200 indexed tail queries took {elapsed:?}"
        );
        println!(
            "provider cursor scale gate: 1m numeric + 100k text rows, 200 tail queries in {elapsed:?}"
        );
    }

    #[test]
    #[ignore = "reads explicitly authorized local provider sources"]
    fn authorized_real_scan_second_pass_is_bounded() {
        assert_eq!(
            std::env::var("TOKENLEDGER_RUN_REAL_SCAN_GATE").as_deref(),
            Ok("1"),
            "set TOKENLEDGER_RUN_REAL_SCAN_GATE=1 to authorize local source reads"
        );
        let root = std::env::temp_dir().join(format!(
            "tokenledger-real-scan-gate-{}-{}",
            std::process::id(),
            Local::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&root).expect("create real scan gate directory");
        let db_path = root.join("tokenboard.db");
        crate::db::init_test_db(&db_path).expect("initialize real scan gate DB");

        let first_started = Instant::now();
        let first = run_scan(&db_path).expect("first real source scan");
        let first_elapsed = first_started.elapsed();
        let second_started = Instant::now();
        let second = run_scan(&db_path).expect("second real source scan");
        let second_elapsed = second_started.elapsed();

        assert!(
            second_elapsed < Duration::from_secs(5),
            "stable second scan took {second_elapsed:?}"
        );
        println!(
            "real scan gate: first={first_elapsed:?}/{} changes, second={second_elapsed:?}/{} changes",
            first.inserted, second.inserted
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "mutates only an explicitly authorized copy of the local TokenLedger database"]
    fn authorized_codex_rebuild_database_copy_gate() {
        let db_path = authorized_codex_rebuild_copy_path();
        let pre_migration = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .expect("open authorized DB copy read-only before migration");
        let pre_migration_version: i64 = pre_migration
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read pre-migration schema version");
        assert!(
            pre_migration_version <= 9,
            "the rebuild rehearsal accepts only a pre-v9 copy or a resumable v9 rehearsal copy"
        );
        drop(pre_migration);
        let machine_id = hostname::get()
            .expect("read hostname for the Codex rebuild gate")
            .to_string_lossy()
            .trim()
            .to_string();
        assert!(
            !machine_id.is_empty() && machine_id != "unknown_machine",
            "Codex rebuild gate requires a trustworthy hostname"
        );
        let inventory = codex_rebuild_inventory();
        assert!(
            !inventory.is_empty(),
            "Codex rebuild gate requires a non-empty active/archive rollout inventory"
        );

        crate::db::init_db(&db_path).expect("migrate authorized DB copy through schema v9");
        let conn = crate::db::get_connection(&db_path).expect("open migrated DB copy");
        let before = codex_db_gate_stats(&conn);
        if pre_migration_version == 9 {
            assert!(
                before.staged_purges == 1
                    || (before.ready_purges == 1 && before.v1_keys == 0 && before.v2_keys > 0),
                "a v9 rehearsal copy must be staged for rebuild or already rebuilt"
            );
        }
        let before_v1 = current_v1_codex_rows(&conn, &machine_id);
        let covered_before = before_v1
            .iter()
            .filter(|(_, session_id)| inventory.contains(*session_id))
            .map(|(key, session_id)| (key.clone(), session_id.clone()))
            .collect::<HashMap<_, _>>();
        let orphan_before = before_v1
            .iter()
            .filter(|(_, session_id)| !inventory.contains(*session_id))
            .map(|(key, session_id)| (key.clone(), session_id.clone()))
            .collect::<HashMap<_, _>>();
        println!(
            "Codex rebuild DB copy before scan: pre_migration_version={pre_migration_version}, {before:?}, covered_v1={}, orphan_v1={}",
            covered_before.len(),
            orphan_before.len()
        );
        drop(conn);

        let first_started = Instant::now();
        let first = run_scan(&db_path).expect("run first rebuild scan on authorized DB copy");
        let first_elapsed = first_started.elapsed();
        let conn = crate::db::get_connection(&db_path).expect("reopen DB copy after first scan");
        let after_first = codex_db_gate_stats(&conn);
        let after_first_v1 = current_v1_codex_rows(&conn, &machine_id);
        let covered_after_first = after_first_v1
            .iter()
            .filter(|(_, session_id)| inventory.contains(*session_id))
            .collect::<HashMap<_, _>>();
        let orphan_after_first = after_first_v1
            .iter()
            .filter(|(_, session_id)| !inventory.contains(*session_id))
            .map(|(key, session_id)| (key.clone(), session_id.clone()))
            .collect::<HashMap<_, _>>();
        let first_purge_state = current_codex_purge_state(&conn, &machine_id);
        println!(
            "Codex rebuild DB copy after first scan: elapsed={first_elapsed:?}, persisted_changes={}, stats={after_first:?}, covered_v1={}, orphan_v1={}",
            first.inserted,
            covered_after_first.len(),
            orphan_after_first.len()
        );
        assert!(
            !first.codex_rebuild_deferred,
            "the authorized source inventory must complete; deferred_files={}",
            first.codex_rebuild_failed_files
        );
        assert_eq!(after_first.user_version, 9, "schema must finish at v9");
        assert_eq!(
            first_purge_state,
            (1, 0),
            "the current-machine Codex purge must be ready only after the atomic rebuild"
        );
        assert!(
            covered_after_first.is_empty(),
            "all v1 rows covered by the active/archive inventory must be replaced"
        );
        assert_eq!(
            orphan_after_first, orphan_before,
            "v1 rows whose rollout is no longer available must be retained as orphans"
        );
        assert!(
            after_first.non_codex_rows >= before.non_codex_rows,
            "the rebuild must not remove non-Codex rows"
        );
        drop(conn);

        let second_started = Instant::now();
        let second = run_scan(&db_path).expect("run repeat scan on authorized DB copy");
        let second_elapsed = second_started.elapsed();
        let conn = crate::db::get_connection(&db_path).expect("reopen DB copy after repeat scan");
        let after_second = codex_db_gate_stats(&conn);
        let after_second_v1 = current_v1_codex_rows(&conn, &machine_id);
        let second_purge_state = current_codex_purge_state(&conn, &machine_id);
        println!(
            "Codex rebuild DB copy after second scan: elapsed={second_elapsed:?}, persisted_changes={}, stats={after_second:?}, orphan_v1={}",
            second.inserted,
            after_second_v1.len()
        );
        assert!(!second.codex_rebuild_deferred);
        assert_eq!(after_second.user_version, 9);
        assert_eq!(after_second.v1_keys, after_first.v1_keys);
        assert!(after_second.v2_keys >= after_first.v2_keys);
        assert!(after_second.codex_rows >= after_first.codex_rows);
        assert!(after_second.input_tokens >= after_first.input_tokens);
        assert!(after_second.output_tokens >= after_first.output_tokens);
        assert!(after_second.cached_tokens >= after_first.cached_tokens);
        assert!(after_second.cache_write_tokens >= after_first.cache_write_tokens);
        assert_eq!(after_second.ready_purges, after_first.ready_purges);
        assert_eq!(after_second.staged_purges, after_first.staged_purges);
        assert_eq!(
            after_second_v1, orphan_after_first,
            "the repeat scan must retain exactly the same v1 orphan set"
        );
        assert_eq!(second_purge_state, (1, 0));
        assert!(
            after_second.non_codex_rows >= after_first.non_codex_rows,
            "the repeat scan must not remove non-Codex rows"
        );
        assert!(
            second_elapsed < Duration::from_secs(5),
            "bounded append catch-up scan took {second_elapsed:?}"
        );
    }
}

#[cfg(test)]
mod scanner_deepseekgui_tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn create_test_thread() -> (PathBuf, PathBuf) {
        let now_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let test_dir = std::env::temp_dir().join(format!("tokenledger_test_{}", now_nanos));
        let threads_dir = test_dir.join("threads");
        let thread_dir = threads_dir.join("thr_test_session");
        fs::create_dir_all(&thread_dir).unwrap();
        (test_dir, thread_dir)
    }

    fn write_event(file: &mut File, event: Value) {
        writeln!(file, "{}", event).unwrap();
    }

    #[test]
    fn test_scan_deepseekgui_parsing() {
        let (test_dir, thread_dir) = create_test_thread();
        let threads_dir = test_dir.join("threads");

        let events_path = thread_dir.join("events.jsonl");
        let mut file = File::create(&events_path).unwrap();

        let line1 = serde_json::json!({
            "seq": 42,
            "timestamp": "2026-06-09T11:39:18.575Z",
            "threadId": "thr_test_session",
            "kind": "usage",
            "model": "deepseek-v4-pro",
            "usage": {
                "promptTokens": 1000,
                "completionTokens": 200,
                "cacheMissTokens": 700,
                "cacheHitTokens": 300
            }
        });
        write_event(&mut file, line1);

        let line2 = serde_json::json!({
            "seq": 43,
            "timestamp": "2026-06-09T11:40:00.000Z",
            "threadId": "thr_test_session",
            "kind": "not_usage",
            "model": "deepseek-v4-pro"
        });
        write_event(&mut file, line2);

        let mut logs = Vec::new();
        let count = scan_deepseekgui_dir(&threads_dir, &mut logs);

        assert_eq!(count, 1);
        assert_eq!(logs.len(), 1);

        let record = &logs[0];
        assert_eq!(record.tool, "deepseek");
        assert_eq!(record.model, "deepseek-v4-pro");
        assert_eq!(record.input_tokens, 700);
        assert_eq!(record.output_tokens, 200);
        assert_eq!(record.cached_tokens, 300);
        assert_eq!(record.session_id, "thr_test_session");
        assert_eq!(record.unique_key, "deepseekgui_thr_test_session_42");

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn test_scan_deepseekgui_cumulative_usage_becomes_incremental_records() {
        let (test_dir, thread_dir) = create_test_thread();
        let threads_dir = test_dir.join("threads");
        let events_path = thread_dir.join("events.jsonl");
        let mut file = File::create(&events_path).unwrap();

        write_event(
            &mut file,
            serde_json::json!({
                "seq": 10,
                "timestamp": "2026-06-09T11:39:18.575Z",
                "threadId": "thr_test_session",
                "turnId": "turn_cumulative",
                "kind": "usage",
                "model": "deepseek-v4-pro",
                "usage": {
                    "promptTokens": 1000,
                    "completionTokens": 100,
                    "cacheHitTokens": 900,
                    "cacheMissTokens": 100,
                    "totalTokens": 1100
                }
            }),
        );
        write_event(
            &mut file,
            serde_json::json!({
                "seq": 11,
                "timestamp": "2026-06-09T11:39:20.575Z",
                "threadId": "thr_test_session",
                "turnId": "turn_cumulative",
                "kind": "usage",
                "model": "deepseek-v4-pro",
                "usage": {
                    "promptTokens": 1500,
                    "completionTokens": 250,
                    "cacheHitTokens": 1200,
                    "cacheMissTokens": 300,
                    "totalTokens": 1750
                }
            }),
        );

        let mut logs = Vec::new();
        let count = scan_deepseekgui_dir(&threads_dir, &mut logs);

        assert_eq!(count, 2);
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].input_tokens, 100);
        assert_eq!(logs[0].output_tokens, 100);
        assert_eq!(logs[0].cached_tokens, 900);
        assert_eq!(logs[1].input_tokens, 200);
        assert_eq!(logs[1].output_tokens, 150);
        assert_eq!(logs[1].cached_tokens, 300);

        let total_tokens: i64 = logs
            .iter()
            .map(|record| record.input_tokens + record.output_tokens + record.cached_tokens)
            .sum();
        assert_eq!(total_tokens, 1750);
        assert_eq!(logs[1].unique_key, "deepseekgui_thr_test_session_11");

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn test_scan_deepseekgui_derives_cache_miss_when_missing() {
        let (test_dir, thread_dir) = create_test_thread();
        let threads_dir = test_dir.join("threads");
        let events_path = thread_dir.join("events.jsonl");
        let mut file = File::create(&events_path).unwrap();

        write_event(
            &mut file,
            serde_json::json!({
                "seq": 20,
                "timestamp": "2026-06-09T11:39:18.575Z",
                "threadId": "thr_test_session",
                "turnId": "turn_missing_miss",
                "kind": "usage",
                "model": "deepseek-v4-pro",
                "usage": {
                    "promptTokens": 1000,
                    "completionTokens": 200,
                    "cacheHitTokens": 300
                }
            }),
        );

        let mut logs = Vec::new();
        let count = scan_deepseekgui_dir(&threads_dir, &mut logs);

        assert_eq!(count, 1);
        assert_eq!(logs[0].input_tokens, 700);
        assert_eq!(logs[0].output_tokens, 200);
        assert_eq!(logs[0].cached_tokens, 300);

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn test_scan_deepseekgui_missing_turn_id_does_not_delta_across_events() {
        let (test_dir, thread_dir) = create_test_thread();
        let threads_dir = test_dir.join("threads");
        let events_path = thread_dir.join("events.jsonl");
        let mut file = File::create(&events_path).unwrap();

        write_event(
            &mut file,
            serde_json::json!({
                "seq": 30,
                "timestamp": "2026-06-09T11:39:18.575Z",
                "threadId": "thr_test_session",
                "kind": "usage",
                "model": "deepseek-v4-pro",
                "usage": {
                    "promptTokens": 1000,
                    "completionTokens": 100,
                    "cacheHitTokens": 900,
                    "cacheMissTokens": 100
                }
            }),
        );
        write_event(
            &mut file,
            serde_json::json!({
                "seq": 31,
                "timestamp": "2026-06-09T11:39:20.575Z",
                "threadId": "thr_test_session",
                "kind": "usage",
                "model": "deepseek-v4-pro",
                "usage": {
                    "promptTokens": 1500,
                    "completionTokens": 250,
                    "cacheHitTokens": 1200,
                    "cacheMissTokens": 300
                }
            }),
        );

        let mut logs = Vec::new();
        let count = scan_deepseekgui_dir(&threads_dir, &mut logs);

        assert_eq!(count, 2);
        assert_eq!(logs[0].input_tokens, 100);
        assert_eq!(logs[0].output_tokens, 100);
        assert_eq!(logs[0].cached_tokens, 900);
        assert_eq!(logs[1].input_tokens, 300);
        assert_eq!(logs[1].output_tokens, 250);
        assert_eq!(logs[1].cached_tokens, 1200);

        fs::remove_dir_all(&test_dir).ok();
    }

    #[test]
    fn test_scan_deepseekgui_counter_reset_uses_current_snapshot() {
        let (test_dir, thread_dir) = create_test_thread();
        let threads_dir = test_dir.join("threads");
        let events_path = thread_dir.join("events.jsonl");
        let mut file = File::create(&events_path).unwrap();

        write_event(
            &mut file,
            serde_json::json!({
                "seq": 40,
                "timestamp": "2026-06-09T11:39:18.575Z",
                "threadId": "thr_test_session",
                "turnId": "turn_reset",
                "kind": "usage",
                "model": "deepseek-v4-pro",
                "usage": {
                    "promptTokens": 1000,
                    "completionTokens": 100,
                    "cacheHitTokens": 800,
                    "cacheMissTokens": 200
                }
            }),
        );
        write_event(
            &mut file,
            serde_json::json!({
                "seq": 41,
                "timestamp": "2026-06-09T11:39:20.575Z",
                "threadId": "thr_test_session",
                "turnId": "turn_reset",
                "kind": "usage",
                "model": "deepseek-v4-pro",
                "usage": {
                    "promptTokens": 500,
                    "completionTokens": 50,
                    "cacheHitTokens": 400,
                    "cacheMissTokens": 100
                }
            }),
        );

        let mut logs = Vec::new();
        let count = scan_deepseekgui_dir(&threads_dir, &mut logs);

        assert_eq!(count, 2);
        assert_eq!(logs[1].input_tokens, 100);
        assert_eq!(logs[1].output_tokens, 50);
        assert_eq!(logs[1].cached_tokens, 400);

        fs::remove_dir_all(&test_dir).ok();
    }
}

#[cfg(test)]
mod scanner_reasonix_tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        static NEXT_TEMP_ROOT: AtomicU64 = AtomicU64::new(0);
        let now_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = NEXT_TEMP_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "tokenledger_reasonix_test_{}_{}_{}",
            std::process::id(),
            now_nanos,
            sequence
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_json(path: &Path, value: &serde_json::Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
    }

    /// Real-world classic meta snapshot (desktop-202605271533-1, sanitized).
    fn legacy_meta() -> serde_json::Value {
        serde_json::json!({
            "workspace": "/Users/demo/Documents/Projects/sample-workspace",
            "summary": "analysis task",
            "totalCostUsd": 2.2658253900000003,
            "cacheHitTokens": 0,
            "cacheMissTokens": 5134948,
            "totalCompletionTokens": 36923,
            "lastPromptTokens": 111502
        })
    }

    /// Real-world telemetry `usage` snapshot (sanitized).
    fn telemetry_usage() -> serde_json::Value {
        serde_json::json!({
            "version": 2,
            "usage": {
                "promptTokens": 1078239,
                "completionTokens": 25660,
                "totalTokens": 1103899,
                "cacheHitTokens": 1007104,
                "cacheMissTokens": 71135,
                "requestCount": 12,
                "sessionCost": 0.22589363999999992,
                "sessionCurrency": "\u{00a5}",
                "sessionCostUsd": 0.22589363999999992,
                "sources": {
                    "executor": { "promptTokens": 1, "completionTokens": 1 },
                    "planner": { "promptTokens": 1, "completionTokens": 1 }
                }
            }
        })
    }

    fn scan_fixture(root: &Path, logs: &mut Vec<LogRecord>) -> usize {
        let bases = vec![root.join(".reasonix")];
        let roots = reasonix_session_roots(&bases);
        scan_reasonix_from(&roots, &bases, logs)
    }

    #[test]
    fn reasonix_legacy_meta_and_new_telemetry_are_both_scanned() {
        let root = temp_root();
        let sessions = root.join(".reasonix/sessions");
        fs::create_dir_all(&sessions).unwrap();
        write_json(
            &sessions.join("desktop-202605271533-1.meta.json"),
            &legacy_meta(),
        );
        // Zero-token classic meta must be skipped (old imports have no usage).
        write_json(
            &sessions.join("claude-imported-empty.meta.json"),
            &serde_json::json!({ "workspace": "/tmp", "summary": "no usage" }),
        );
        // Newer per-workspace telemetry layout.
        let ws_sessions =
            root.join(".reasonix/projects/-Users-demo-Documents-Projects-Test/sessions");
        fs::create_dir_all(&ws_sessions).unwrap();
        write_json(
            &ws_sessions.join("20260802-141107.449320000-session.jsonl.telemetry.json"),
            &telemetry_usage(),
        );
        // The `.jsonl.meta` sidecar carries the real model and the RFC 3339
        // UTC session start; both must win over config defaults and the
        // session-id stamp.
        write_json(
            &ws_sessions.join("20260802-141107.449320000-session.jsonl.meta"),
            &serde_json::json!({
                "model": "BC_CLAUD/deepseek-v4-flash",
                "created_at": "2026-08-02T14:11:07.449320000Z",
                "workspace_root": "/Users/demo/Documents/Projects/Test",
                "turns": 4
            }),
        );
        // config.json supplies the fallback model.
        write_json(
            &root.join(".reasonix/config.json"),
            &serde_json::json!({ "model": "deepseek-v4-pro" }),
        );

        let mut logs = Vec::new();
        let count = scan_fixture(&root, &mut logs);
        assert_eq!(count, 2, "zero-token meta must be skipped");
        assert_eq!(logs.len(), 2);

        let legacy = logs
            .iter()
            .find(|r| r.session_id == "desktop-202605271533-1")
            .expect("legacy meta scanned");
        assert_eq!(legacy.tool, "reasonix");
        // Classic meta.json files have no `model`/`created_at` sidecar
        // fields, so the config.json default applies and the id stamp is
        // interpreted as UTC and converted to local time.
        assert_eq!(legacy.model, "deepseek-v4-pro");
        assert_eq!(legacy.input_tokens, 5134948);
        assert_eq!(legacy.output_tokens, 36923);
        assert_eq!(legacy.cached_tokens, 0);
        assert_eq!(legacy.cost_usd, Some(2.2658253900000003));
        assert_eq!(legacy.unique_key, "reasonix_desktop-202605271533-1");
        let legacy_utc = chrono::NaiveDate::from_ymd_opt(2026, 5, 27)
            .unwrap()
            .and_hms_opt(15, 33, 0)
            .unwrap();
        assert_eq!(
            legacy.timestamp,
            Local
                .from_utc_datetime(&legacy_utc)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        );
        assert!(legacy.cumulative);

        let telemetry = logs
            .iter()
            .find(|r| r.session_id == "20260802-141107.449320000-session")
            .expect("telemetry scanned");
        assert_eq!(telemetry.input_tokens, 71135);
        assert_eq!(telemetry.output_tokens, 25660);
        assert_eq!(telemetry.cached_tokens, 1007104);
        assert_eq!(telemetry.cost_usd, Some(0.22589363999999992));
        assert_eq!(
            telemetry.unique_key,
            "reasonix_20260802-141107.449320000-session"
        );
        // Sidecar model and created_at (UTC) win over defaults and the
        // session-id stamp (with provider prefix cleaned).
        assert_eq!(telemetry.model, "deepseek-v4-flash");
        let telemetry_utc = chrono::NaiveDate::from_ymd_opt(2026, 8, 2)
            .unwrap()
            .and_hms_opt(14, 11, 7)
            .unwrap();
        assert_eq!(
            telemetry.timestamp,
            Local
                .from_utc_datetime(&telemetry_utc)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reasonix_relay_usage_recovers_prompt_tokens_and_leaves_cost_repriceable() {
        let root = temp_root();
        let ws_sessions = root.join(".reasonix/projects/e--relay/sessions");
        fs::create_dir_all(&ws_sessions).unwrap();
        // Real shape from a relay provider configured without prices: the
        // cache breakdown does not add up to `promptTokens` and the session
        // cost stays at 0 while tokens keep growing.
        write_json(
            &ws_sessions.join("20260803-075127.108092400-session.jsonl.telemetry.json"),
            &serde_json::json!({
                "version": 2,
                "usage": {
                    "promptTokens": 367156,
                    "completionTokens": 7427,
                    "cacheHitTokens": 305024,
                    "cacheMissTokens": 46349,
                    "sessionCostUsd": 0.0
                }
            }),
        );
        write_json(
            &ws_sessions.join("20260803-075127.108092400-session.jsonl.meta"),
            &serde_json::json!({
                "model": "bcnw/deepseek-v4-flash",
                "created_at": "2026-08-03T07:51:27.1086147Z",
                "updated_at": "2026-08-03T09:22:57.2259201Z"
            }),
        );

        let mut logs = Vec::new();
        assert_eq!(scan_fixture(&root, &mut logs), 1);
        let record = &logs[0];
        // 367156 - 305024 = 62132 uncached prompt tokens; `cacheMissTokens`
        // alone would have dropped 15783 of them.
        assert_eq!(record.input_tokens, 62132);
        assert_eq!(record.cached_tokens, 305024);
        assert_eq!(record.output_tokens, 7427);
        assert_eq!(
            record.cost_usd, None,
            "a zero source cost must stay repriceable, not pin the row at $0"
        );
        // `updated_at` is when the session stopped spending; `created_at` can
        // be days earlier.
        let updated_utc = chrono::NaiveDate::from_ymd_opt(2026, 8, 3)
            .unwrap()
            .and_hms_opt(9, 22, 57)
            .unwrap();
        assert_eq!(
            record.timestamp,
            Local
                .from_utc_datetime(&updated_utc)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        );

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reasonix_recovery_forks_collapse_into_one_root_session() {
        let root = temp_root();
        let ws_sessions = root.join(".reasonix/projects/e--forked/sessions");
        fs::create_dir_all(&ws_sessions).unwrap();
        let base = "20260806-033150.212737500-deepseek-deepseek-v4-pro";
        // Each fork's telemetry re-reports its ancestors' counters, so the
        // family total is the deepest fork, not the sum of all three.
        for (id, miss, completion, hit) in [
            (base.to_string(), 120280, 8832, 1193728),
            (
                format!("{base}-recovery-c1d49fa41c445687"),
                144497,
                12672,
                1279744,
            ),
            (
                format!("{base}-7b8579ec21a9-recovery-2fc94e3b0d68012c"),
                490546,
                48159,
                7947776,
            ),
        ] {
            write_json(
                &ws_sessions.join(format!("{id}.jsonl.telemetry.json")),
                &serde_json::json!({
                    "usage": {
                        "cacheMissTokens": miss,
                        "completionTokens": completion,
                        "cacheHitTokens": hit,
                        "sessionCostUsd": 0.5
                    }
                }),
            );
            write_json(
                &ws_sessions.join(format!("{id}.jsonl.meta")),
                &serde_json::json!({
                    "model": "deepseek/deepseek-v4-flash",
                    "created_at": "2026-08-06T03:31:50.2137607Z"
                }),
            );
        }

        let mut logs = Vec::new();
        assert_eq!(scan_fixture(&root, &mut logs), 1, "one row per family");
        let record = &logs[0];
        assert_eq!(record.session_id, base);
        assert_eq!(record.unique_key, format!("reasonix_{base}"));
        assert_eq!(record.input_tokens, 490546);
        assert_eq!(record.output_tokens, 48159);
        assert_eq!(record.cached_tokens, 7947776);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reasonix_root_session_id_strips_recovery_chains() {
        assert_eq!(
            reasonix_root_session_id(
                "20260806-033150.212737500-deepseek-deepseek-v4-pro-7b8579ec21a9-recovery-2fc94e3b0d68012c"
            ),
            "20260806-033150.212737500-deepseek-deepseek-v4-pro"
        );
        assert_eq!(
            reasonix_root_session_id(
                "20260802-075036.841025100-BC_CLAUD-claude-opus-4-8-6f11957dd281-e3476c10f3ff-recovery-42458f4fb1d679ca"
            ),
            "20260802-075036.841025100-BC_CLAUD-claude-opus-4-8"
        );
        assert_eq!(
            reasonix_root_session_id(
                "20260616-021205.767861700-deepseek-v4-flash + planner claude-opus-4-8-recovery-6ab3ab1f0a8b3828"
            ),
            "20260616-021205.767861700-deepseek-v4-flash + planner claude-opus-4-8"
        );
        // Sessions that never crashed keep their id verbatim.
        assert_eq!(
            reasonix_root_session_id("desktop-202605271533-1"),
            "desktop-202605271533-1"
        );
    }

    #[test]
    fn reasonix_default_model_prefers_config_toml() {
        let root = temp_root();
        let base = root.join(".reasonix");
        fs::create_dir_all(&base).unwrap();
        // A stale pre-TOML config.json must not win over the current one.
        write_json(
            &base.join("config.json"),
            &serde_json::json!({ "model": "deepseek-v4-pro" }),
        );
        fs::write(
            base.join("config.toml"),
            concat!(
                "# default_model = \"commented-out\"\n",
                "config_version = 5\n",
                "default_model = \"deepseek/deepseek-v4-flash\"   # session default\n",
                "\n",
                "[[providers]]\n",
                "default_model = \"provider-scoped\"\n",
            ),
        )
        .unwrap();

        assert_eq!(
            reasonix_default_model(std::slice::from_ref(&base)),
            "deepseek-v4-flash"
        );
        assert_eq!(reasonix_toml_default_model("no keys here"), None);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reasonix_cumulative_reset_rebaselines_instead_of_swallowing_tokens() {
        let root = temp_root();
        let db_path = root.join("reasonix-reset.db");
        crate::db::init_db(&db_path).unwrap();
        let sessions = root.join(".reasonix/sessions");
        fs::create_dir_all(&sessions).unwrap();
        let meta_path = sessions.join("desktop-202606011200-1.meta.json");

        let snapshot = |miss: i64, completion: i64| {
            serde_json::json!({
                "cacheHitTokens": 0,
                "cacheMissTokens": miss,
                "totalCompletionTokens": completion
            })
        };
        let scan_once = |logs: &mut Vec<LogRecord>| {
            let count = scan_fixture(&root, logs);
            assert_eq!(count, 1);
        };

        write_json(&meta_path, &snapshot(1000, 100));
        let mut logs = Vec::new();
        scan_once(&mut logs);
        persist_scan_batch(&db_path, logs, Vec::new(), Vec::new(), None).unwrap();

        // The source restarts its counters (session id reuse / repaired
        // state). No row is invented for the shrink itself...
        write_json(&meta_path, &snapshot(200, 20));
        let mut logs = Vec::new();
        scan_once(&mut logs);
        let outcome = persist_scan_batch(&db_path, logs, Vec::new(), Vec::new(), None).unwrap();
        assert_eq!(outcome.inserted, 0, "a shrink must not invent a row");

        // ...but the next real growth is measured from the new baseline
        // instead of being swallowed until it passes the old high-water mark.
        write_json(&meta_path, &snapshot(500, 60));
        let mut logs = Vec::new();
        scan_once(&mut logs);
        let outcome = persist_scan_batch(&db_path, logs, Vec::new(), Vec::new(), None).unwrap();
        assert_eq!(outcome.inserted, 1, "growth after a reset is recorded");

        let conn = crate::db::get_connection(&db_path).unwrap();
        let (sum_in, sum_out): (i64, i64) = conn
            .query_row(
                "SELECT SUM(input_tokens), SUM(output_tokens)
                 FROM token_logs WHERE tool = 'reasonix'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(sum_in, 1300, "1000 before the reset + 300 after");
        assert_eq!(sum_out, 140);

        drop(conn);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reasonix_timestamp_from_session_id_variants() {
        // The id embeds a UTC wall-clock stamp; the parser returns the raw
        // UTC NaiveDateTime and the caller converts to local time.
        let utc = |y, mo, d, h, mi, s| {
            chrono::NaiveDate::from_ymd_opt(y, mo, d)
                .unwrap()
                .and_hms_opt(h, mi, s)
                .unwrap()
        };
        assert_eq!(
            reasonix_timestamp_from_session_id("desktop-202605271533-1"),
            Some(utc(2026, 5, 27, 15, 33, 0))
        );
        assert_eq!(
            reasonix_timestamp_from_session_id("subagent-sub-6-202605271537"),
            Some(utc(2026, 5, 27, 15, 37, 0))
        );
        assert_eq!(
            reasonix_timestamp_from_session_id(
                "20260603-165101.114909000-deepseek-v4-flash + planner deepseek-v4-pro"
            ),
            Some(utc(2026, 6, 3, 16, 51, 1))
        );
        assert_eq!(
            reasonix_timestamp_from_session_id("20260802-141107.449320000-session"),
            Some(utc(2026, 8, 2, 14, 11, 7))
        );
        assert_eq!(
            reasonix_timestamp_from_session_id("claude-imported-without-stamp"),
            None
        );
    }

    #[test]
    fn reasonix_cumulative_delta_persists_increments() {
        let root = temp_root();
        let db_path = root.join("reasonix-test.db");
        crate::db::init_db(&db_path).unwrap();

        let sessions = root.join(".reasonix/sessions");
        fs::create_dir_all(&sessions).unwrap();
        let meta_path = sessions.join("desktop-202606011200-1.meta.json");

        // Snapshot A: first scan writes the full row.
        write_json(
            &meta_path,
            &serde_json::json!({
                "totalCostUsd": 1.0,
                "cacheHitTokens": 50,
                "cacheMissTokens": 1000,
                "totalCompletionTokens": 100
            }),
        );
        let mut logs = Vec::new();
        assert_eq!(scan_fixture(&root, &mut logs), 1);
        let outcome = persist_scan_batch(&db_path, logs, Vec::new(), Vec::new(), None).unwrap();
        assert_eq!(outcome.inserted, 1);

        // Snapshot B: grown in place, only the delta row is stored.
        write_json(
            &meta_path,
            &serde_json::json!({
                "totalCostUsd": 1.5,
                "cacheHitTokens": 200,
                "cacheMissTokens": 1500,
                "totalCompletionTokens": 250
            }),
        );
        let mut logs = Vec::new();
        assert_eq!(scan_fixture(&root, &mut logs), 1);
        let outcome = persist_scan_batch(&db_path, logs, Vec::new(), Vec::new(), None).unwrap();
        assert_eq!(outcome.inserted, 1, "second scan stores only the delta");

        let conn = crate::db::get_connection(&db_path).unwrap();
        let (rows, sum_in, sum_out, sum_cached) = conn
            .query_row(
                "SELECT COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cached_tokens)
                 FROM token_logs WHERE tool = 'reasonix'",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(rows, 2, "full row + one delta row");
        assert_eq!(sum_in, 1500);
        assert_eq!(sum_out, 250);
        assert_eq!(sum_cached, 200);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cleans_custom_proxy_and_provider_prefixes() {
        assert_eq!(
            clean_model_name("minimax-cn-anthropic/MiniMax-M3"),
            "MiniMax-M3"
        );
        assert_eq!(
            clean_model_name("BC_CLAUD/deepseek-v4-flash"),
            "deepseek-v4-flash"
        );
        assert_eq!(
            clean_model_name("openrouter/anthropic/claude-3.5-sonnet"),
            "claude-3.5-sonnet"
        );
        assert_eq!(clean_model_name("models/gemini-1.5-pro"), "gemini-1.5-pro");
        assert_eq!(clean_model_name("gpt-4o"), "gpt-4o");
        assert_eq!(clean_model_name("  proxy/provider/my-model  "), "my-model");
        assert_eq!(clean_model_name(""), "");
    }
}

#[cfg(test)]
mod antigravity_usage_tests {
    use super::*;
    use crate::scanner::antigravity::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    struct Fixture {
        root: PathBuf,
        db: PathBuf,
        roots: Vec<(PathBuf, bool)>,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "tokenledger_antigravity_{}_{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            let db = root.join("isolated.db");
            crate::db::init_test_db(&db).unwrap();
            let roots = vec![(root.join("app"), false), (root.join("cli"), true)];
            Self { root, db, roots }
        }
        fn write(&self, root: usize, session: &str, rows: &[Value]) -> PathBuf {
            let path = self.roots[root]
                .0
                .join(session)
                .join(".system_generated/logs/transcript.jsonl");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let text = rows
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            fs::write(&path, text).unwrap();
            path
        }
        fn batch(&self) -> AntigravityScanBatch {
            let conn = crate::db::get_connection(&self.db).unwrap();
            let checkpoints =
                crate::db::load_scan_checkpoints(&conn, ANTIGRAVITY_CHECKPOINT_SOURCE_KIND)
                    .unwrap();
            scan_antigravity_roots_checkpointed(&self.roots, &checkpoints)
        }
        fn persist(&self, batch: AntigravityScanBatch) -> rusqlite::Result<ScanOutcome> {
            persist_scan_batch_with_antigravity(
                &self.db,
                batch.logs,
                batch.checkpoints,
                Vec::new(),
                None,
                &batch.provenance,
            )
        }
        fn stored(&self) -> (i64, i64, i64, String, bool, i64, i64) {
            let conn = crate::db::get_connection(&self.db).unwrap();
            conn.query_row("SELECT input_tokens,output_tokens,cached_tokens,usage_provenance,cache_write_known,sync_revision,sync_status FROM token_logs WHERE tool='antigravity'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn row(step: i64, input: i64, output: i64, read: i64) -> Value {
        json!({"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","step_index":step,
            "created_at":"2026-10-08T00:00:00Z","input_tokens":input,"output_tokens":output,"cache_read_tokens":read,
            "thinking":"This body is not another token counter.","content":"answer"})
    }
    fn legacy(step: i64) -> Value {
        json!({"source":"MODEL","type":"PLANNER_RESPONSE","step_index":step,
            "created_at":"2026-10-08T00:00:00Z","content":"legacy estimate"})
    }
    fn selection(label: &str) -> Value {
        json!({"source":"USER_EXPLICIT","type":"USER_INPUT","content":format!("<USER_SETTINGS_CHANGE>The user changed setting Model Selection from Auto to {label}.</USER_SETTINGS_CHANGE>")})
    }

    #[test]
    fn antigravity_top_level_usage_keeps_input_and_thinking_and_unknown_writes() {
        let f = Fixture::new();
        f.write(
            1,
            "session-a",
            &[
                selection("Gemini 3.8 Flash (High)"),
                row(1, 5800, 144, 15315),
                row(2, 0, 0, 0),
            ],
        );
        let batch = f.batch();
        assert_eq!(batch.logs.len(), 2);
        let first = &batch.logs[0];
        assert_eq!(
            (first.input_tokens, first.output_tokens, first.cached_tokens),
            (5800, 144, 15315)
        );
        assert_eq!(first.model, "gemini-3-8-flash");
        assert!(batch.provenance.values().all(|p| !p.cache_write_known));
        assert!(model_discovery_key("antigravity-unknown").is_none());
        assert_eq!(f.persist(batch).unwrap().inserted, 2);
        assert!(f.batch().logs.is_empty());
    }

    #[test]
    fn antigravity_partial_or_invalid_usage_never_becomes_an_estimate() {
        let f = Fixture::new();
        let mut invalid = Vec::new();
        for key in ["input_tokens", "output_tokens", "cache_read_tokens"] {
            for value in [
                Value::Null,
                json!(-1),
                json!(1.5),
                json!("1"),
                json!(9_007_199_254_740_992_i64),
            ] {
                let mut r = row(1, 1, 2, 3);
                r[key] = value;
                invalid.push(r);
            }
            let mut r = row(1, 1, 2, 3);
            r.as_object_mut().unwrap().remove(key);
            invalid.push(r);
        }
        let mut running = row(1, 1, 2, 3);
        running["status"] = json!("RUNNING");
        invalid.push(running);
        let mut bad_time = row(1, 1, 2, 3);
        bad_time["created_at"] = json!("bad");
        invalid.push(bad_time);
        let mut bad_step = row(1, 1, 2, 3);
        bad_step["step_index"] = json!("1");
        invalid.push(bad_step);
        let mut new_without_usage = legacy(1);
        new_without_usage["status"] = json!("DONE");
        invalid.push(new_without_usage);
        f.write(0, "session-a", &invalid);
        let batch = f.batch();
        assert!(batch.logs.is_empty());
        assert!(batch.checkpoints.is_empty());
        f.write(1, "session-b", &[legacy(1)]);
        assert!(f.batch().logs.is_empty());
    }

    #[test]
    fn antigravity_dual_roots_prefer_reported_and_conflicts_defer_whole_group() {
        let f = Fixture::new();
        f.write(0, "session-a", &[legacy(1)]);
        f.write(1, "session-a", &[row(1, 3, 2, 0)]);
        let first = f.batch();
        assert_eq!(first.logs.len(), 1);
        assert_eq!(first.logs[0].input_tokens, 3);
        let mut reverse = f.roots.clone();
        reverse.reverse();
        let second = scan_antigravity_roots_checkpointed(&reverse, &HashMap::new());
        assert_eq!(second.logs[0].input_tokens, 3);
        assert_eq!(f.persist(first).unwrap().inserted, 1);
        // The current CLI checkpoint cannot hide its higher-priority row when an App copy changes.
        f.write(0, "session-a", &[legacy(1), legacy(2)]);
        let changed = f.batch();
        assert_eq!(
            changed
                .logs
                .iter()
                .find(|r| r.unique_key.ends_with("_1"))
                .unwrap()
                .input_tokens,
            3
        );
        f.write(0, "session-a", &[row(1, 4, 2, 0)]);
        let conflict = f.batch();
        assert!(conflict.logs.is_empty());
        assert!(conflict.checkpoints.is_empty());
        assert_eq!(f.stored().0, 3);
    }

    #[test]
    fn antigravity_reported_survives_reopen_source_loss_and_accepts_decreases() {
        let f = Fixture::new();
        f.write(1, "session-a", &[row(1, 5800, 144, 15315)]);
        f.persist(f.batch()).unwrap();
        let old = f.stored();
        fs::remove_file(
            f.roots[1]
                .0
                .join("session-a/.system_generated/logs/transcript.jsonl"),
        )
        .unwrap();
        f.write(0, "session-a", &[legacy(1)]);
        assert_eq!(f.persist(f.batch()).unwrap().inserted, 0);
        assert_eq!(f.stored(), old);
        f.write(1, "session-a", &[row(1, 10, 1, 0)]);
        assert_eq!(f.persist(f.batch()).unwrap().inserted, 1);
        let corrected = f.stored();
        assert_eq!(corrected.0, 10);
        assert_eq!(corrected.5, old.5 + 1);
        assert_eq!(f.persist(f.batch()).unwrap().inserted, 0);
        assert_eq!(f.stored(), corrected);
    }

    #[test]
    fn antigravity_bad_tail_keeps_good_rows_but_not_checkpoints_and_retries() {
        let f = Fixture::new();
        let path = f.write(1, "session-a", &[row(1, 3, 2, 0)]);
        let mut text = fs::read_to_string(&path).unwrap();
        text.push_str("{\"source\":");
        fs::write(&path, text).unwrap();
        let first = f.batch();
        assert_eq!(first.logs.len(), 1);
        assert!(first.checkpoints.is_empty());
        f.persist(first).unwrap();
        f.write(1, "session-a", &[row(1, 3, 2, 0), row(2, 4, 3, 0)]);
        assert_eq!(f.persist(f.batch()).unwrap().inserted, 1);
        assert!(f.batch().logs.is_empty());
    }

    #[test]
    fn antigravity_metadata_only_update_revises_once_and_batch_failure_rolls_back() {
        let f = Fixture::new();
        f.write(1, "session-a", &[row(1, 3, 2, 0)]);
        f.persist(f.batch()).unwrap();
        let before = f.stored();
        let mut explicit = row(1, 3, 2, 0);
        explicit["cache_write_tokens"] = json!(0);
        f.write(1, "session-a", &[explicit]);
        assert_eq!(f.persist(f.batch()).unwrap().inserted, 1);
        let known = f.stored();
        assert!(known.4);
        assert_eq!(known.5, before.5 + 1);
        assert_eq!(f.persist(f.batch()).unwrap().inserted, 0);
        f.write(1, "session-a", &[row(1, 1, 1, 0)]);
        let mut batch = f.batch();
        batch.checkpoints[0].processed_offset += 1;
        assert!(f.persist(batch).is_err());
        assert_eq!(f.stored(), known);
        assert_eq!(f.persist(f.batch()).unwrap().inserted, 1);
    }

    #[test]
    fn antigravity_full_files_and_invalid_session_layouts_are_ignored() {
        let f = Fixture::new();
        let path = f.write(1, "session-a", &[row(1, 3, 2, 0)]);
        fs::write(
            path.with_file_name("transcript_full.jsonl"),
            row(1, 999, 999, 999).to_string(),
        )
        .unwrap();
        f.write(1, "unknown_session", &[row(1, 3, 2, 0)]);
        let batch = f.batch();
        assert_eq!(batch.logs.len(), 1);
        // Even a persisted v1 checkpoint must not suppress the v2 group parse.
        let mut v1 = batch.checkpoints[0].clone();
        v1.source_kind = "antigravity-transcript-jsonl-v1".into();
        let legacy_checkpoints = HashMap::from([(v1.source_path.clone(), v1)]);
        assert_eq!(
            scan_antigravity_roots_checkpointed(&f.roots, &legacy_checkpoints)
                .logs
                .len(),
            1
        );
    }

    #[test]
    fn antigravity_selected_model_helper_keeps_decimal_labels() {
        for (label, expected) in [
            ("Gemini 3.8 Flash (High)", "gemini-3-8-flash"),
            ("Claude Sonnet 4.6", "claude-sonnet-4-6"),
            ("Gemini 3.5 Flash", "gemini-3-5-flash"),
        ] {
            let value = selection(label);
            assert_eq!(
                extract_model_from_settings_change(value["content"].as_str().unwrap()).as_deref(),
                Some(expected)
            );
        }
        let f = Fixture::new();
        f.write(
            1,
            "session-a",
            &[
                row(1, 1, 1, 0),
                selection("Claude Sonnet 4.6"),
                row(2, 1, 1, 0),
            ],
        );
        let batch = f.batch();
        assert_eq!(batch.logs[0].model, "antigravity-unknown");
        assert_eq!(batch.logs[1].model, "claude-sonnet-4-6");
    }

    #[test]
    fn antigravity_same_file_reported_snapshot_never_downgrades_and_pure_cache_is_kept() {
        let f = Fixture::new();
        f.write(
            0,
            "session-a",
            &[row(1, 90, 20, 30), row(1, 0, 0, 30), legacy(1)],
        );
        let batch = f.batch();
        assert_eq!(batch.logs.len(), 1);
        assert_eq!(
            (
                batch.logs[0].input_tokens,
                batch.logs[0].output_tokens,
                batch.logs[0].cached_tokens
            ),
            (0, 0, 30)
        );
        assert_eq!(
            batch.provenance["antigravity_session-a_1"].usage,
            AntigravityUsageProvenance::Reported
        );
        assert_eq!(f.persist(batch).unwrap().inserted, 1);
    }

    #[test]
    fn antigravity_identical_copies_and_root_aliases_fold_and_same_size_rewrite_reparses() {
        let f = Fixture::new();
        let path = f.write(1, "session-a", &[row(1, 3, 2, 0)]);
        f.write(0, "session-a", &[row(1, 3, 2, 0)]);
        let mut roots = f.roots.clone();
        roots.push((f.roots[1].0.join("."), true));
        let batch = scan_antigravity_roots_checkpointed(&roots, &HashMap::new());
        assert_eq!(batch.logs.len(), 1);
        assert_eq!(batch.checkpoints.len(), 2);
        f.persist(batch).unwrap();
        fs::remove_file(
            f.roots[0]
                .0
                .join("session-a/.system_generated/logs/transcript.jsonl"),
        )
        .unwrap();
        let before = fs::metadata(&path).unwrap();
        f.write(1, "session-a", &[row(1, 4, 2, 0)]);
        // Explicitly change mtime: no sleeps or host filesystem granularity assumptions.
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(before.modified().unwrap() + Duration::from_secs(2)),
            )
            .unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), before.len());
        assert_eq!(f.persist(f.batch()).unwrap().inserted, 1);
        assert_eq!(f.stored().0, 4);
        assert!(f.batch().logs.is_empty());
    }

    #[test]
    fn antigravity_bad_middle_does_not_hide_later_rows_and_invalid_writes_are_rejected() {
        let f = Fixture::new();
        let path = f.write(1, "session-a", &[row(1, 3, 2, 0)]);
        fs::write(
            &path,
            format!("{}\n{{bad\n{}\n", row(1, 3, 2, 0), row(2, 4, 3, 0)),
        )
        .unwrap();
        let batch = f.batch();
        assert_eq!(batch.logs.len(), 2);
        assert!(batch.checkpoints.is_empty());
        for value in [
            Value::Null,
            json!(-1),
            json!(1.5),
            json!(9_007_199_254_740_991_i64),
        ] {
            let mut invalid = row(1, 1, 2, 1);
            invalid["cache_write_tokens"] = value;
            f.write(1, "session-a", &[invalid]);
            assert!(f.batch().logs.is_empty());
        }
    }

    #[test]
    fn antigravity_v3_rescans_and_corrects_old_estimated_models_once() {
        let f = Fixture::new();
        f.write(0, "session-a", &[selection("Claude Sonnet 4.6"), legacy(1)]);
        f.persist(f.batch()).unwrap();
        {
            let conn = crate::db::get_connection(&f.db).unwrap();
            conn.execute_batch(
                "UPDATE token_logs SET model='gemini-3.5-flash-agent', sync_status=1;
                UPDATE scan_checkpoints SET source_kind='antigravity-transcript-jsonl-v2';",
            )
            .unwrap();
        }
        let before = f.stored();
        let batch = f.batch();
        assert_eq!(
            batch.logs.len(),
            1,
            "v2 checkpoint must not skip model correction"
        );
        assert_eq!(f.persist(batch).unwrap().inserted, 1);
        let corrected = f.stored();
        assert_eq!(corrected.3, "estimated");
        assert_eq!(corrected.5, before.5 + 1);
        assert_eq!(corrected.6, 0);
        let conn = crate::db::get_connection(&f.db).unwrap();
        let model: String = conn
            .query_row("SELECT model FROM token_logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(model, "claude-sonnet-4-6");
        drop(conn);
        assert!(f.batch().logs.is_empty());
        assert_eq!(f.persist(f.batch()).unwrap().inserted, 0);
        assert_eq!(f.stored(), corrected);
    }

    #[test]
    fn antigravity_v3_removes_unproven_legacy_placeholder_model() {
        let f = Fixture::new();
        f.write(0, "session-a", &[legacy(1)]);
        f.persist(f.batch()).unwrap();
        {
            let conn = crate::db::get_connection(&f.db).unwrap();
            conn.execute_batch(
                "UPDATE token_logs SET model='gemini-3.5-flash-agent';
                DELETE FROM scan_checkpoints;",
            )
            .unwrap();
        }
        assert_eq!(f.persist(f.batch()).unwrap().inserted, 1);
        let conn = crate::db::get_connection(&f.db).unwrap();
        let model: String = conn
            .query_row("SELECT model FROM token_logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(model, "antigravity-unknown");
    }

    #[test]
    fn antigravity_legacy_valid_times_and_bad_settings_remain_bounded() {
        let f = Fixture::new();
        let mut rows = Vec::new();
        for (step, value) in [
            json!(1_791_417_600_i64),
            json!("1791417600"),
            json!("2026-10-08 00:00:00"),
        ]
        .into_iter()
        .enumerate()
        {
            let mut r = legacy(step as i64);
            r["created_at"] = value;
            rows.push(r);
        }
        rows.push(json!({"type":"USER_INPUT","content":"</USER_SETTINGS_CHANGE><USER_SETTINGS_CHANGE>Model Selection from Auto to .</USER_SETTINGS_CHANGE>"}));
        rows.push(row(3, 1, 2, 0));
        f.write(0, "session-a", &rows);
        let batch = f.batch();
        assert_eq!(batch.logs.len(), 4);
        assert!(batch.logs.iter().all(|r| r.model == "antigravity-unknown"));
        assert!(scan_antigravity_roots_checkpointed(&[], &HashMap::new())
            .logs
            .is_empty());
    }
}

#[test]
fn scan_lock_excludes_another_holder_until_released() {
    let dir = std::env::temp_dir().join(format!("tokenledger_scan_lock_{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("tokenboard.db");
    let held = lock_scan_across_processes(&db_path).expect("first holder gets the lock");
    // 另开一个句柄，相当于另一个进程：持有期间拿不到。
    let other = fs::OpenOptions::new()
        .write(true)
        .open(db_path.with_extension("scan.lock"))
        .unwrap();
    assert!(other.try_lock().is_err());
    drop(held);
    assert!(other.try_lock().is_ok());
    let _ = fs::remove_dir_all(&dir);
}

#[cfg(test)]
mod scanner_timestamp_tests {
    use super::*;

    /// 期望值按运行机器的本地时区动态算出，多时区 CI 都能通过。
    fn local_from_utc(naive: &str) -> String {
        chrono::NaiveDateTime::parse_from_str(naive, "%Y-%m-%d %H:%M:%S")
            .expect("valid naive datetime")
            .and_utc()
            .with_timezone(&Local)
            .format("%Y-%m-%d %H:%M:%S")
            .to_string()
    }

    #[test]
    fn space_separated_utc_string_converts_to_local() {
        // RFC 3339 要求 `T` 分隔；空格加 `Z` 的串进不了带偏移分支，但它仍是
        // UTC，直接当本地时间会整体偏移时区差、并可能跨日错桶。
        let expected = local_from_utc("2026-04-13 22:30:26");
        assert_eq!(
            parse_timestamp(&Value::String("2026-04-13 22:30:26.211Z".to_string())),
            Some(expected.clone())
        );
        assert_eq!(
            parse_timestamp(&Value::String("2026-04-13 22:30:26Z".to_string())),
            Some(expected)
        );
    }

    #[test]
    fn rfc3339_conversion_is_unchanged() {
        let expected = local_from_utc("2026-04-13 22:30:26");
        for raw in ["2026-04-13T22:30:26.211Z", "2026-04-14T06:30:26.211+08:00"] {
            assert_eq!(
                parse_timestamp(&Value::String(raw.to_string())),
                Some(expected.clone()),
                "{raw}"
            );
        }
    }

    #[test]
    fn string_without_zone_suffix_keeps_local_reading() {
        assert_eq!(
            parse_timestamp(&Value::String("2026-04-13 22:30:26".to_string())),
            Some("2026-04-13 22:30:26".to_string())
        );
    }

    #[test]
    fn unparseable_values_yield_none_instead_of_today() {
        for raw in [
            Value::Null,
            Value::String("not a timestamp".to_string()),
            Value::String("2026-04-13".to_string()),
        ] {
            assert_eq!(parse_timestamp(&raw), None, "{raw}");
        }
    }

    #[test]
    fn corrupt_timestamp_row_is_skipped_instead_of_booked_today() {
        let mut record = serde_json::json!({
            "type": "assistant",
            "uuid": "uuid-1",
            "timestamp": "2026-04-13T25:61:61Z",
            "message": {
                "id": "msg_1",
                "model": "claude-sonnet-4",
                "usage": {"input_tokens": 10, "output_tokens": 2}
            }
        });
        assert!(claude_record_from_value(&record, "session-1", 1).is_none());

        // 同一行只换时间戳就必须重新计入，证明跳过是时间戳驱动的。
        record["timestamp"] = serde_json::json!("2026-04-13T22:30:26.211Z");
        assert!(claude_record_from_value(&record, "session-1", 1).is_some());
    }
}
