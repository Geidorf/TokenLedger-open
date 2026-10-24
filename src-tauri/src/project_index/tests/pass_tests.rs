//! O1 (consent gate), O2 (enable, backfill, incremental, disable purge, late
//! writers), D1 (ledger untouched), P1 at the storage and status level, the
//! scan hook, and the review fixes (purge retry, startup and incremental
//! scheduling, failure handling). Passes run synchronously with fixture
//! sources.

use super::{assert_no_canary, jsonl, write_file, Scratch};
use crate::project_index::git_probe::NoGitProbe;
use crate::project_index::label::{HostEnv, HostStyle, ProjectKind, Resolution};
use crate::project_index::sources::SourceRoots;
use crate::project_index::store::{self, BackfillStatus, IndexState, SessionProject};
use crate::project_index::{
    effective_kind, effective_resolver_version, notify_scan_persisted, rebuild_impl, run_pass,
    run_pass_guarded, set_impl, slots, status_impl, PassDeps, PassKind, PassOutcome, RunningGuard,
    GIT_PROBE_ENABLED, PROJECT_DIMENSION_CONSENT_VERSION, RESOLVER_VERSION, RETRY_AFTER_DAYS,
};
use rusqlite::params;
use serde_json::json;
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

const CODEX_UUID: &str = "0199a0b1-c2d3-7e4f-8a9b-0c1d2e3f4a5b";

struct Fixture {
    scratch: Scratch,
    db: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let scratch = Scratch::new(tag);
        let app = scratch.join("app");
        fs::create_dir_all(&app).expect("app dir");
        let db = app.join("tokenboard.db");
        crate::db::init_test_db(&db).expect("init test db");
        let fixture = Self { scratch, db };
        fixture.write_sources();
        fixture.seed_ledger();
        fixture
    }

    fn home(&self) -> PathBuf {
        self.scratch.join("home")
    }

    fn write_sources(&self) {
        let home = self.home();
        write_file(
            &home.join(".claude/projects/-work-ProjLabelAlpha/sess-alpha.jsonl"),
            jsonl(&[
                json!({"type": "user", "message": {"content": "CANARY_PROMPT_TEXT"},
                       "gitBranch": "CANARY_GIT_BRANCH", "cwd": "/work/ProjLabelAlpha"}),
                json!({"type": "assistant", "message": {"content": "CANARY_REPLY_TEXT"}}),
            ]),
        );
        write_file(
            &home.join(".claude/projects/-home-tester/sess-home.jsonl"),
            jsonl(&[json!({"cwd": "/home/tester", "summary": "CANARY_SESSION_TITLE"})]),
        );
        write_file(
            &home.join(format!(
                ".codex/sessions/2026/09/24/rollout-2026-09-24T10-00-00-{CODEX_UUID}.jsonl"
            )),
            jsonl(&[json!({"type": "session_meta",
                           "payload": {"cwd": "/work/ProjLabelCodex",
                                       "git": {"repository_url": "CANARY_GIT_REMOTE"}}})]),
        );
        let opencode = home.join(".local/share/opencode/opencode.db");
        fs::create_dir_all(opencode.parent().expect("parent")).expect("opencode dir");
        let conn = rusqlite::Connection::open(&opencode).expect("opencode db");
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
             INSERT INTO session VALUES ('ses_oc', '/work/ProjLabelOc', 'CANARY_SESSION_TITLE');
             INSERT INTO message VALUES ('m1', 'ses_oc', 1,
                 '{\"role\":\"assistant\",\"path\":{\"cwd\":\"/work/ProjLabelOc/pkg\",\"root\":\"/work/ProjLabelOc\"},\"text\":\"CANARY_REPLY_TEXT\"}');",
        )
        .expect("seed opencode");
    }

    fn seed_ledger(&self) {
        for (tool, session, key) in [
            ("claude", "sess-alpha", "claude_a1"),
            ("claude", "sess-alpha", "claude_a2"),
            ("claude", "sess-home", "claude_h1"),
            ("codex", CODEX_UUID, "codex_v2_1"),
            ("opencode", "ses_oc", "opencode_m1"),
            ("antigravity", "ag-1", "antigravity_1"),
            ("claude", "sess-gone", "claude_gone"),
            ("claude", "unknown_session", "claude_unknown"),
            ("claude", "  ", "claude_blank"),
        ] {
            self.insert_log(tool, session, key);
        }
    }

    fn insert_log(&self, tool: &str, session: &str, key: &str) {
        let conn = crate::db::get_connection(&self.db).expect("open ledger");
        conn.execute(
            "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens,
                 cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id,
                 sync_status)
             VALUES (?1, 'model-x', 10, 5, 0, 0, '2026-09-24 10:00:00', ?2, ?3, NULL, 'machine', 0)",
            params![tool, session, key],
        )
        .expect("insert ledger row");
    }

    fn roots(&self) -> SourceRoots {
        SourceRoots::under(&self.home())
    }

    fn run(&self, kind: PassKind) -> PassOutcome {
        self.run_with(kind, &|| false, &|_, _| {})
    }

    fn run_with(
        &self,
        kind: PassKind,
        cancelled: &dyn Fn() -> bool,
        progress: &dyn Fn(i64, i64),
    ) -> PassOutcome {
        let roots = || self.roots();
        let deps = PassDeps {
            roots: &roots,
            host: &test_host,
            git: &NoGitProbe,
            cancelled,
            progress,
        };
        run_pass(&self.db, kind, &deps).expect("pass")
    }

    fn enable(&self) {
        set_impl(&self.db, true, Some(PROJECT_DIMENSION_CONSENT_VERSION)).expect("enable");
    }

    fn project(
        &self,
        tool: &str,
        session: &str,
    ) -> Option<crate::project_index::label::ProjectRef> {
        let conn = store::open(&self.db).expect("open");
        store::project_of(&conn, tool, session).expect("query project")
    }

    fn row_count(&self) -> i64 {
        let conn = store::open(&self.db).expect("open");
        conn.query_row("SELECT COUNT(*) FROM local_session_projects", [], |row| {
            row.get(0)
        })
        .expect("count")
    }

    /// Every stored value of both tables as text.
    fn dump_index(&self) -> String {
        let conn = store::open(&self.db).expect("open");
        let mut out = String::new();
        for table in ["local_session_projects", "local_project_index_state"] {
            let mut statement = conn
                .prepare(&format!("SELECT * FROM {table}"))
                .expect("prepare dump");
            let columns = statement.column_count();
            let mut rows = statement.query([]).expect("query dump");
            while let Some(row) = rows.next().expect("row") {
                for index in 0..columns {
                    let value: rusqlite::types::Value = row.get(index).expect("value");
                    out.push_str(&format!("{value:?}|"));
                }
                out.push('\n');
            }
        }
        out
    }
}

fn test_host() -> HostEnv {
    HostEnv::from_dirs(
        HostStyle::Posix,
        false,
        &["/home/tester".to_string()],
        &["/tmp".to_string()],
        &["/home/tester/.config".to_string()],
    )
}

/// Runs a pass whose source locator and host lookup panic when touched:
/// proves the pass read nothing (collection off, or no work to do).
fn panicking_deps_run(db: &Path, kind: PassKind) -> PassOutcome {
    let roots = || -> SourceRoots { panic!("sources must not be located") };
    let host = || -> HostEnv { panic!("the host must not be inspected") };
    let deps = PassDeps {
        roots: &roots,
        host: &host,
        git: &NoGitProbe,
        cancelled: &|| false,
        progress: &|_, _| {},
    };
    run_pass(db, kind, &deps).expect("pass")
}

#[test]
fn o1_nothing_is_read_or_stored_while_disabled() {
    let fixture = Fixture::new("pass_o1");
    for kind in [PassKind::Full, PassKind::Incremental] {
        assert_eq!(
            panicking_deps_run(&fixture.db, kind),
            PassOutcome::NotCollecting
        );
    }
    notify_scan_persisted(&fixture.db, true);
    assert!(
        slots().get(&fixture.db).is_none(),
        "the scan hook must not schedule work while disabled"
    );
    assert_eq!(fixture.row_count(), 0);
    let status = status_impl(&fixture.db).expect("status");
    assert_eq!(status.state, "disabled");
    assert!(!status.enabled);

    // Stored consent below the current version pauses collection.
    let conn = store::open(&fixture.db).expect("open");
    conn.execute(
        "INSERT INTO local_project_index_state (id, enabled, consent_version, generation)
         VALUES (1, 1, ?1, 1)",
        params![PROJECT_DIMENSION_CONSENT_VERSION - 1],
    )
    .expect("old consent");
    drop(conn);
    assert_eq!(
        panicking_deps_run(&fixture.db, PassKind::Full),
        PassOutcome::NotCollecting
    );
    notify_scan_persisted(&fixture.db, true);
    assert!(slots().get(&fixture.db).is_none());
    assert_eq!(
        status_impl(&fixture.db).expect("status").state,
        "consent_required"
    );
}

#[test]
fn o2_enable_backfill_incremental_disable_purge_and_reenable() {
    let fixture = Fixture::new("pass_o2");
    let status =
        set_impl(&fixture.db, true, Some(PROJECT_DIMENSION_CONSENT_VERSION)).expect("enable");
    assert_eq!(status.state, "indexing");
    assert_eq!(
        slots().get(&fixture.db).and_then(|slot| slot.pending),
        Some(PassKind::Full),
        "enabling schedules a full backfill"
    );

    let progress = RefCell::new(Vec::new());
    let outcome = fixture.run_with(PassKind::Full, &|| false, &|done, total| {
        progress.borrow_mut().push((done, total))
    });
    assert_eq!(
        outcome,
        PassOutcome::Completed {
            resolved: 6,
            skipped: 0
        }
    );
    assert_eq!(progress.borrow().first(), Some(&(0, 6)));
    assert_eq!(progress.borrow().last(), Some(&(6, 6)));

    let alpha = fixture.project("claude", "sess-alpha").expect("alpha");
    assert_eq!(alpha.label.as_deref(), Some("ProjLabelAlpha"));
    assert_eq!(alpha.resolution, Resolution::Folder);
    let home = fixture.project("claude", "sess-home").expect("home");
    assert_eq!(home.kind, ProjectKind::Home);
    assert_eq!(home.label, None);
    let codex = fixture.project("codex", CODEX_UUID).expect("codex");
    assert_eq!(codex.label.as_deref(), Some("ProjLabelCodex"));
    let opencode = fixture.project("opencode", "ses_oc").expect("opencode");
    assert_eq!(opencode.label.as_deref(), Some("ProjLabelOc"));
    assert_eq!(opencode.resolution, Resolution::SourceGitRoot);
    let antigravity = fixture.project("antigravity", "ag-1").expect("antigravity");
    assert_eq!(antigravity.kind, ProjectKind::Unresolved);
    assert_eq!(antigravity.resolution, Resolution::UnsupportedSource);
    let gone = fixture.project("claude", "sess-gone").expect("gone");
    assert_eq!(gone.resolution, Resolution::SourceMissing);
    // Rows without a real session id are never indexed.
    assert!(fixture.project("claude", "unknown_session").is_none());
    assert!(fixture.project("claude", "  ").is_none());

    let status = status_impl(&fixture.db).expect("status");
    assert_eq!(status.state, "ready");
    assert_eq!(status.indexed_sessions, 6);
    assert_eq!(status.named_projects, 3);
    assert_eq!(status.unresolved_sessions, 2);

    // A second full pass only retries the retryable outcome.
    assert_eq!(
        fixture.run(PassKind::Full),
        PassOutcome::Completed {
            resolved: 1,
            skipped: 5
        }
    );

    // Incremental: only sessions added after the watermark.
    write_file(
        &fixture
            .home()
            .join(".claude/projects/-work-ProjLabelBeta/sess-beta.jsonl"),
        jsonl(&[json!({"cwd": "/work/ProjLabelBeta"})]),
    );
    fixture.insert_log("claude", "sess-beta", "claude_b1");
    fixture.insert_log("claude", "sess-alpha", "claude_a3");
    assert_eq!(
        fixture.run(PassKind::Incremental),
        PassOutcome::Completed {
            resolved: 1,
            skipped: 1
        }
    );
    assert_eq!(
        fixture
            .project("claude", "sess-beta")
            .and_then(|project| project.label),
        Some("ProjLabelBeta".to_string())
    );
    assert_eq!(
        fixture.run(PassKind::Incremental),
        PassOutcome::Completed {
            resolved: 0,
            skipped: 0
        }
    );

    // Disable: stop and purge every stored name, then truncate the WAL.
    let status = set_impl(&fixture.db, false, None).expect("disable");
    assert_eq!(status.state, "disabled");
    let purge = status.purge.expect("purge report");
    assert_eq!(purge.removed_sessions, 7);
    assert!(purge.wal_truncated);
    assert_eq!(fixture.row_count(), 0);
    let dump = fixture.dump_index();
    assert!(
        !dump.contains("ProjLabel") && !dump.contains("projlabel"),
        "{dump}"
    );
    let wal = PathBuf::from(format!("{}-wal", fixture.db.display()));
    assert_eq!(fs::metadata(&wal).map(|meta| meta.len()).unwrap_or(0), 0);
    let bytes = fs::read(&fixture.db).expect("read db file");
    for needle in [
        "ProjLabelAlpha",
        "projlabelalpha",
        "ProjLabelCodex",
        "ProjLabelBeta",
    ] {
        assert!(
            !bytes
                .windows(needle.len())
                .any(|window| window == needle.as_bytes()),
            "{needle} survived the purge in the database file"
        );
    }
    assert_eq!(
        panicking_deps_run(&fixture.db, PassKind::Full),
        PassOutcome::NotCollecting
    );

    // Re-enabling starts from an empty index.
    fixture.enable();
    assert_eq!(fixture.row_count(), 0);
    assert_eq!(
        fixture.run(PassKind::Full),
        PassOutcome::Completed {
            resolved: 7,
            skipped: 0
        }
    );
}

#[test]
fn o2_late_writes_after_disable_or_rebuild_are_discarded() {
    let fixture = Fixture::new("pass_late");
    fixture.enable();
    // Disable lands after the pass planned its work but before it writes.
    let outcome = fixture.run_with(PassKind::Full, &|| false, &|done, _| {
        if done == 0 {
            set_impl(&fixture.db, false, None).expect("disable mid-pass");
        }
    });
    assert_eq!(outcome, PassOutcome::Stale);
    assert_eq!(fixture.row_count(), 0);
    assert!(!status_impl(&fixture.db).expect("status").enabled);

    // A rebuild mid-pass supersedes the old pass; the next pass completes.
    fixture.enable();
    let outcome = fixture.run_with(PassKind::Full, &|| false, &|done, _| {
        if done == 0 {
            rebuild_impl(&fixture.db).expect("rebuild mid-pass");
        }
    });
    assert_eq!(outcome, PassOutcome::Stale);
    assert_eq!(fixture.row_count(), 0);
    assert!(matches!(
        fixture.run(PassKind::Full),
        PassOutcome::Completed { resolved: 6, .. }
    ));

    // The storage guard itself: a stale generation never writes.
    let mut conn = store::open(&fixture.db).expect("open");
    let current = store::load_state(&conn).expect("state").generation;
    let row = SessionProject {
        tool: "claude".to_string(),
        session_id: "late".to_string(),
        source_family: "claude",
        project: crate::project_index::label::ProjectRef::named("Late", Resolution::Folder)
            .expect("named"),
    };
    assert!(!store::write_batch(
        &mut conn,
        current - 1,
        effective_resolver_version(),
        std::slice::from_ref(&row)
    )
    .expect("stale write"));
    assert!(store::write_batch(
        &mut conn,
        current,
        effective_resolver_version(),
        std::slice::from_ref(&row)
    )
    .expect("current write"));
    // Cancellation stops a pass without writing further.
    drop(conn);
    assert_eq!(
        fixture.run_with(PassKind::Full, &|| true, &|_, _| {}),
        PassOutcome::Cancelled
    );
}

#[test]
fn rebuild_recomputes_but_keeps_names_whose_logs_were_cleaned_up() {
    let fixture = Fixture::new("pass_rebuild");
    fixture.enable();
    assert!(matches!(
        fixture.run(PassKind::Full),
        PassOutcome::Completed { resolved: 6, .. }
    ));
    // The tool cleaned up this log after it was indexed.
    fs::remove_file(
        fixture
            .home()
            .join(".claude/projects/-work-ProjLabelAlpha/sess-alpha.jsonl"),
    )
    .expect("remove log");
    let status = rebuild_impl(&fixture.db).expect("rebuild");
    assert_eq!(status.state, "indexing");
    // Names stay visible while the rebuild runs.
    assert_eq!(fixture.row_count(), 6);
    assert!(matches!(
        fixture.run(PassKind::Full),
        PassOutcome::Completed { resolved: 6, .. }
    ));
    let alpha = fixture.project("claude", "sess-alpha").expect("alpha");
    assert_eq!(alpha.label.as_deref(), Some("ProjLabelAlpha"));
    assert_eq!(status_impl(&fixture.db).expect("status").state, "ready");
}

#[test]
fn resolver_upgrade_drops_names_it_can_no_longer_verify() {
    let fixture = Fixture::new("pass_upgrade");
    fixture.enable();
    fixture.run(PassKind::Full);
    fs::remove_file(
        fixture
            .home()
            .join(".claude/projects/-work-ProjLabelAlpha/sess-alpha.jsonl"),
    )
    .expect("remove log");
    // An index written by resolver version 1, before the T10.165 P3 name
    // rules: stored as `1 * 2 + git probe switch` (root decision R-33).
    let version_one = 2 + i64::from(GIT_PROBE_ENABLED);
    let conn = store::open(&fixture.db).expect("open");
    conn.execute(
        "UPDATE local_session_projects SET resolver_version = ?1",
        params![version_one],
    )
    .expect("age rows");
    conn.execute(
        "UPDATE local_project_index_state SET resolver_version = ?1",
        params![version_one],
    )
    .expect("age state");
    drop(conn);
    // An incremental request is upgraded to a full pass by the version check.
    assert!(matches!(
        fixture.run(PassKind::Incremental),
        PassOutcome::Completed { resolved: 6, .. }
    ));
    let alpha = fixture.project("claude", "sess-alpha").expect("alpha");
    assert_eq!(alpha.kind, ProjectKind::Unresolved);
    assert_eq!(alpha.resolution, Resolution::SourceMissing);
    // Every version-1 row was recomputed, and the pass certified the new rules.
    let conn = store::open(&fixture.db).expect("open");
    let current = effective_resolver_version();
    let outdated: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_session_projects WHERE resolver_version <> ?1",
            params![current],
            |row| row.get(0),
        )
        .expect("count outdated rows");
    assert_eq!(outdated, 0);
    assert_eq!(
        store::load_state(&conn).expect("state").resolver_version,
        current
    );
    assert_eq!(RESOLVER_VERSION, 2);
}

#[test]
fn orphans_are_collected_by_the_next_full_pass() {
    let fixture = Fixture::new("pass_orphans");
    fixture.enable();
    fixture.run(PassKind::Full);
    // Like “clean old data” deleting every row of a session.
    let conn = store::open(&fixture.db).expect("open");
    conn.execute("DELETE FROM token_logs WHERE session_id = 'sess-alpha'", [])
        .expect("delete ledger rows");
    drop(conn);
    assert!(fixture.project("claude", "sess-alpha").is_some());
    fixture.run(PassKind::Full);
    assert!(fixture.project("claude", "sess-alpha").is_none());
    assert_eq!(fixture.row_count(), 5);
}

#[test]
fn p1_stored_rows_status_and_errors_hold_no_content_or_paths() {
    let fixture = Fixture::new("pass_p1");
    fixture.enable();
    fixture.run(PassKind::Full);
    let dump = fixture.dump_index();
    assert_no_canary(&dump);
    for fragment in ["/work", "/home/tester", "\\\\", "opencode.db", ".jsonl"] {
        assert!(!dump.contains(fragment), "{fragment} stored: {dump}");
    }
    let status = serde_json::to_string(&status_impl(&fixture.db).expect("status")).expect("json");
    assert_no_canary(&status);
    assert!(!status.contains('/') && !status.contains('\\'), "{status}");

    assert_eq!(
        set_impl(
            &fixture.db,
            true,
            Some(PROJECT_DIMENSION_CONSENT_VERSION + 1)
        )
        .unwrap_err(),
        "consent_version_mismatch"
    );
    assert_eq!(
        set_impl(&fixture.db, true, None).unwrap_err(),
        "consent_version_mismatch"
    );
    set_impl(&fixture.db, false, None).expect("disable");
    assert_eq!(
        rebuild_impl(&fixture.db).unwrap_err(),
        "project_dimension_disabled"
    );
}

#[test]
fn state_row_constraints_keep_free_text_out() {
    let fixture = Fixture::new("pass_constraints");
    fixture.enable();
    let mut conn = store::open(&fixture.db).expect("open");
    let generation = store::load_state(&conn).expect("state").generation;
    // Failure details are reason codes, never messages or paths.
    assert!(store::update_progress(
        &mut conn,
        generation,
        BackfillStatus::Failed,
        0,
        0,
        None,
        Some("C:\\Users\\someone\\db")
    )
    .is_err());
    assert!(store::update_progress(
        &mut conn,
        generation,
        BackfillStatus::Failed,
        0,
        0,
        None,
        Some("database_error")
    )
    .expect("code accepted"));
    // Labels with separators and named rows without labels are rejected.
    for (kind, key, label) in [
        ("named", "n:a/b", Some("a/b")),
        ("named", "n:a\\b", Some("a\\b")),
        ("named", "n:x", None),
        ("home", "@home", Some("alice")),
        ("home", "n:alice", None),
    ] {
        let result = conn.execute(
            "INSERT INTO local_session_projects
                (tool, session_id, source_family, project_kind, project_key, project_label,
                 resolution, generation, resolver_version)
             VALUES ('t', 's', 'claude', ?1, ?2, ?3, 'folder', 1, 1)",
            params![kind, key, label],
        );
        assert!(result.is_err(), "{kind} {key} {label:?} must be rejected");
    }
}

#[test]
fn d1_ledger_rows_checkpoints_and_cursors_are_unchanged() {
    let enabled = Fixture::new("pass_d1_on");
    let disabled = Fixture::new("pass_d1_off");
    // The index is on and populated before the scan persists, so the scan
    // hook runs its enabled branch (review P3-7).
    enabled.enable();
    assert!(matches!(
        enabled.run(PassKind::Full),
        PassOutcome::Completed { resolved: 6, .. }
    ));
    if let Some(slot) = slots().get_mut(&enabled.db) {
        slot.pending = None;
    }
    let checkpoint = crate::db::ScanCheckpoint {
        source_kind: "claude-jsonl-v2".to_string(),
        source_path: "/fixture/claude/sess.jsonl".to_string(),
        source_identity: "fixture:1".to_string(),
        size_bytes: 10,
        modified_ns: 1,
        processed_offset: 10,
    };
    let records = vec![crate::scanner::types::LogRecord {
        tool: "claude".to_string(),
        model: "claude-x".to_string(),
        input_tokens: 3,
        output_tokens: 4,
        cached_tokens: 5,
        cache_write_tokens: 6,
        timestamp: "2026-09-24 11:00:00".to_string(),
        session_id: "sess-alpha".to_string(),
        unique_key: "claude_d1".to_string(),
        cost_usd: Some(0.5),
        cumulative: false,
    }];
    for fixture in [&enabled, &disabled] {
        crate::scanner::runner::persist_scan_batch(
            &fixture.db,
            records.clone(),
            vec![checkpoint.clone()],
            Vec::new(),
            None,
        )
        .expect("persist batch");
        // `run_scan` calls the hook right after the batch committed.
        notify_scan_persisted(&fixture.db, true);
    }
    // The hook asked for an incremental pass only where the index is on.
    assert_eq!(
        slots().get(&enabled.db).and_then(|slot| slot.pending),
        Some(PassKind::Incremental)
    );
    assert_eq!(
        slots().get(&disabled.db).and_then(|slot| slot.pending),
        None
    );
    // Each fixture folder has its own random device id; compare the rest.
    let snapshot = |db: &std::path::Path| -> Vec<String> {
        let device = crate::device_identity::for_db(db).expect("fixture device id");
        ledger_snapshot(db)
            .into_iter()
            .map(|row| row.replace(&device, "<device>"))
            .collect()
    };
    let before = ledger_snapshot(&enabled.db);
    assert_eq!(
        snapshot(&enabled.db),
        snapshot(&disabled.db),
        "the scan wrote the same ledger with the index on and off"
    );
    assert_eq!(
        enabled.run(PassKind::Incremental),
        PassOutcome::Completed {
            resolved: 0,
            skipped: 1
        }
    );
    enabled.run(PassKind::Startup);
    enabled.run(PassKind::Full);
    assert!(enabled.row_count() > 0);
    let after = ledger_snapshot(&enabled.db);
    assert_eq!(before, after, "the index must never write the ledger");
    assert_eq!(snapshot(&enabled.db), snapshot(&disabled.db));
}

fn ledger_snapshot(db: &Path) -> Vec<String> {
    let conn = crate::db::get_connection(db).expect("open");
    let mut out = Vec::new();
    for sql in [
        "SELECT id, tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
                timestamp, session_id, unique_key, cost_usd, machine_id, sync_status,
                cloud_user_id, synced_at
         FROM token_logs ORDER BY id",
        "SELECT source_kind, source_path, source_identity, size_bytes, modified_ns,
                processed_offset
         FROM scan_checkpoints ORDER BY source_kind, source_path",
        "SELECT * FROM scan_source_cursors ORDER BY 1, 2",
    ] {
        let mut statement = conn.prepare(sql).expect("prepare snapshot");
        let columns = statement.column_count();
        let mut rows = statement.query([]).expect("query snapshot");
        while let Some(row) = rows.next().expect("row") {
            let values: Vec<String> = (0..columns)
                .map(|index| {
                    format!(
                        "{:?}",
                        row.get::<_, rusqlite::types::Value>(index).expect("value")
                    )
                })
                .collect();
            out.push(values.join("|"));
        }
        out.push("--".to_string());
    }
    out
}

#[test]
fn scan_hook_requests_one_startup_pass_then_incremental_ones() {
    let fixture = Fixture::new("pass_hook");
    fixture.enable();
    // Enabling already requested the full pass; the worker would take it.
    if let Some(slot) = slots().get_mut(&fixture.db) {
        slot.pending = None;
    }
    notify_scan_persisted(&fixture.db, false);
    assert_eq!(slots().get(&fixture.db).and_then(|slot| slot.pending), None);
    notify_scan_persisted(&fixture.db, true);
    assert_eq!(
        slots().get(&fixture.db).and_then(|slot| slot.pending),
        Some(PassKind::Incremental)
    );
    // A fresh process (no slot yet) starts with a startup pass, not a full
    // one (review P2-4); later scans only add incremental work.
    slots().remove(&fixture.db);
    notify_scan_persisted(&fixture.db, false);
    assert_eq!(
        slots().get(&fixture.db).and_then(|slot| slot.pending),
        Some(PassKind::Startup)
    );
    if let Some(slot) = slots().get_mut(&fixture.db) {
        slot.pending = None;
    }
    notify_scan_persisted(&fixture.db, true);
    assert_eq!(
        slots().get(&fixture.db).and_then(|slot| slot.pending),
        Some(PassKind::Incremental)
    );
}

/// Whether a stored label or key of the fixture is still anywhere in the
/// database file or its write-ahead log.
fn names_on_disk(db: &Path) -> bool {
    any_on_disk(
        db,
        &[
            "ProjLabelAlpha",
            "projlabelalpha",
            "ProjLabelCodex",
            "projlabelcodex",
            "ProjLabelOc",
            "projlabeloc",
        ],
    )
}

/// Whether any of `needles` is anywhere in the database file or its WAL.
fn any_on_disk(db: &Path, needles: &[&str]) -> bool {
    let wal = PathBuf::from(format!("{}-wal", db.display()));
    [db.to_path_buf(), wal].iter().any(|file| {
        let bytes = fs::read(file).unwrap_or_default();
        needles.iter().any(|needle| {
            bytes
                .windows(needle.len())
                .any(|window| window == needle.as_bytes())
        })
    })
}

/// A statistics query that keeps reading an old snapshot.
fn begin_reader(reader: &rusqlite::Connection) {
    reader.execute_batch("BEGIN").expect("begin read");
    let _: i64 = reader
        .query_row("SELECT COUNT(*) FROM local_session_projects", [], |row| {
            row.get(0)
        })
        .expect("read snapshot");
}

#[test]
fn p2_a_blocked_wal_truncation_is_retried_until_the_purge_completes() {
    let fixture = Fixture::new("pass_purge_retry");
    fixture.enable();
    fixture.run(PassKind::Full);
    let wal = PathBuf::from(format!("{}-wal", fixture.db.display()));
    let reader = crate::db::get_connection(&fixture.db).expect("reader");

    // Review P2-1: a reader pins the old frames, so the truncation fails.
    begin_reader(&reader);
    let status = set_impl(&fixture.db, false, None).expect("disable");
    let purge = status.purge.expect("purge report");
    assert_eq!(purge.removed_sessions, 6);
    assert!(!purge.wal_truncated);
    assert_eq!(status.state, "disabled");
    assert_eq!(status.last_failure.as_deref(), Some(store::PURGE_PENDING));
    assert_eq!(fixture.row_count(), 0);
    assert!(
        names_on_disk(&fixture.db),
        "the blocked checkpoint leaves old pages behind"
    );

    // Still blocked: the scan hook retries, keeps the marker and schedules
    // nothing (collection stays off).
    notify_scan_persisted(&fixture.db, true);
    assert_eq!(slots().get(&fixture.db).and_then(|slot| slot.pending), None);
    assert_eq!(
        status_impl(&fixture.db)
            .expect("status")
            .last_failure
            .as_deref(),
        Some(store::PURGE_PENDING)
    );

    // The reader finishes; the next scan completes the purge.
    reader.execute_batch("COMMIT").expect("end read");
    notify_scan_persisted(&fixture.db, true);
    let status = status_impl(&fixture.db).expect("status");
    assert_eq!(status.state, "disabled");
    assert_eq!(status.last_failure, None);
    assert_eq!(fs::metadata(&wal).map(|meta| meta.len()).unwrap_or(0), 0);
    assert!(!names_on_disk(&fixture.db));
    assert_eq!(slots().get(&fixture.db).and_then(|slot| slot.pending), None);
    assert_eq!(
        panicking_deps_run(&fixture.db, PassKind::Full),
        PassOutcome::NotCollecting
    );

    // The next disable finishes a blocked purge as well.
    fixture.enable();
    fixture.run(PassKind::Full);
    begin_reader(&reader);
    let status = set_impl(&fixture.db, false, None).expect("disable while read");
    assert!(!status.purge.expect("purge report").wal_truncated);
    reader.execute_batch("COMMIT").expect("end read");
    let status = set_impl(&fixture.db, false, None).expect("disable again");
    let purge = status.purge.expect("purge report");
    assert_eq!(purge.removed_sessions, 0);
    assert!(purge.wal_truncated);
    assert_eq!(status.last_failure, None);
    assert!(!names_on_disk(&fixture.db));
}

#[test]
fn p2_startup_pass_reads_only_new_unindexed_or_due_sessions() {
    let fixture = Fixture::new("pass_startup");
    fixture.enable();
    assert!(matches!(
        fixture.run(PassKind::Full),
        PassOutcome::Completed { resolved: 6, .. }
    ));
    // Nothing changed: a startup pass touches no source at all.
    assert_eq!(
        panicking_deps_run(&fixture.db, PassKind::Startup),
        PassOutcome::Completed {
            resolved: 0,
            skipped: 0
        }
    );

    // `sess-gone` (source_missing) is due again after the retry interval; a
    // session id corrected in place sits below the watermark; its old id is
    // now an orphan.
    let conn = store::open(&fixture.db).expect("open");
    conn.execute(
        "UPDATE local_session_projects
         SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1)
         WHERE session_id = 'sess-gone'",
        params![format!("-{} days", RETRY_AFTER_DAYS + 1)],
    )
    .expect("age the retryable row");
    conn.execute(
        "UPDATE token_logs SET session_id = 'sess-renamed' WHERE unique_key = 'claude_h1'",
        [],
    )
    .expect("correct a session id");
    drop(conn);
    write_file(
        &fixture
            .home()
            .join(".claude/projects/-work-ProjLabelRenamed/sess-renamed.jsonl"),
        jsonl(&[json!({"cwd": "/work/ProjLabelRenamed"})]),
    );
    // Incremental passes never look below the watermark.
    assert_eq!(
        panicking_deps_run(&fixture.db, PassKind::Incremental),
        PassOutcome::Completed {
            resolved: 0,
            skipped: 0
        }
    );
    assert_eq!(
        fixture.run(PassKind::Startup),
        PassOutcome::Completed {
            resolved: 2,
            skipped: 0
        }
    );
    assert_eq!(
        fixture
            .project("claude", "sess-renamed")
            .and_then(|project| project.label),
        Some("ProjLabelRenamed".to_string())
    );
    assert!(fixture.project("claude", "sess-home").is_none());
    assert_eq!(
        fixture
            .project("claude", "sess-gone")
            .expect("gone")
            .resolution,
        Resolution::SourceMissing
    );
    // The retry was stamped, so the next start reads nothing again.
    assert_eq!(
        panicking_deps_run(&fixture.db, PassKind::Startup),
        PassOutcome::Completed {
            resolved: 0,
            skipped: 0
        }
    );
    assert_eq!(status_impl(&fixture.db).expect("status").state, "ready");
}

#[test]
fn p2_incremental_pass_retries_a_session_that_is_active_again() {
    let fixture = Fixture::new("pass_retry_active");
    fixture.enable();
    fixture.run(PassKind::Full);
    write_file(
        &fixture
            .home()
            .join(".claude/projects/-work-ProjLabelBack/sess-gone.jsonl"),
        jsonl(&[json!({"cwd": "/work/ProjLabelBack"})]),
    );
    // No new ledger rows: nothing is retried before the interval.
    assert_eq!(
        panicking_deps_run(&fixture.db, PassKind::Incremental),
        PassOutcome::Completed {
            resolved: 0,
            skipped: 0
        }
    );
    fixture.insert_log("claude", "sess-gone", "claude_gone_2");
    assert_eq!(
        fixture.run(PassKind::Incremental),
        PassOutcome::Completed {
            resolved: 1,
            skipped: 0
        }
    );
    assert_eq!(
        fixture
            .project("claude", "sess-gone")
            .and_then(|project| project.label),
        Some("ProjLabelBack".to_string())
    );
}

#[test]
fn p3_a_failed_backfill_is_retried_once_per_start_not_per_scan() {
    let fixture = Fixture::new("pass_failed");
    fixture.enable();
    // The first backfill failed: status failed, rule version still unset.
    let conn = store::open(&fixture.db).expect("open");
    conn.execute(
        "UPDATE local_project_index_state
         SET backfill_status = 'failed', last_failure = 'database_error'",
        [],
    )
    .expect("fail the backfill");
    let failed = store::load_state(&conn).expect("state");
    drop(conn);
    let version = effective_resolver_version();
    assert_eq!(failed.resolver_version, 0);
    assert_eq!(
        effective_kind(&failed, PassKind::Incremental, version),
        PassKind::Incremental
    );
    assert_eq!(
        effective_kind(&failed, PassKind::Startup, version),
        PassKind::Full
    );
    let running = IndexState {
        backfill_status: BackfillStatus::Running,
        ..failed.clone()
    };
    assert_eq!(
        effective_kind(&running, PassKind::Incremental, version),
        PassKind::Full
    );
    let old_rules = IndexState {
        backfill_status: BackfillStatus::Done,
        resolver_version: version - 2,
        ..failed.clone()
    };
    assert_eq!(
        effective_kind(&old_rules, PassKind::Startup, version),
        PassKind::Full
    );
    let done = IndexState {
        backfill_status: BackfillStatus::Done,
        resolver_version: version,
        ..failed
    };
    assert_eq!(
        effective_kind(&done, PassKind::Startup, version),
        PassKind::Startup
    );
    assert_eq!(
        effective_kind(&done, PassKind::Incremental, version),
        PassKind::Incremental
    );

    // Scans keep indexing (here: everything, the watermark is still 0) and
    // leave the failure visible; they do not rerun the full pass.
    assert_eq!(
        fixture.run(PassKind::Incremental),
        PassOutcome::Completed {
            resolved: 6,
            skipped: 0
        }
    );
    let status = status_impl(&fixture.db).expect("status");
    assert_eq!(status.state, "failed");
    assert_eq!(status.last_failure.as_deref(), Some("database_error"));
    assert_eq!(
        panicking_deps_run(&fixture.db, PassKind::Incremental),
        PassOutcome::Completed {
            resolved: 0,
            skipped: 0
        }
    );
    // The next start retries in full and recovers.
    assert_eq!(
        fixture.run(PassKind::Startup),
        PassOutcome::Completed {
            resolved: 1,
            skipped: 5
        }
    );
    let status = status_impl(&fixture.db).expect("status");
    assert_eq!(status.state, "ready");
    assert_eq!(status.last_failure, None);
}

#[test]
fn p2_a_panicking_pass_marks_the_index_failed_and_frees_the_worker() {
    let fixture = Fixture::new("pass_panic");
    fixture.enable();
    let roots = || -> SourceRoots { panic!("fixture: unexpected failure while locating sources") };
    let deps = PassDeps {
        roots: &roots,
        host: &test_host,
        git: &NoGitProbe,
        cancelled: &|| false,
        progress: &|_, _| {},
    };
    assert_eq!(
        run_pass_guarded(&fixture.db, PassKind::Full, &deps),
        Err("internal_error")
    );
    let status = status_impl(&fixture.db).expect("status");
    assert_eq!(status.state, "failed");
    assert_eq!(status.last_failure.as_deref(), Some("internal_error"));
    assert_eq!(fixture.row_count(), 0);
    // The next start retries in full.
    assert!(matches!(
        fixture.run(PassKind::Startup),
        PassOutcome::Completed { resolved: 6, .. }
    ));
    assert_eq!(status_impl(&fixture.db).expect("status").state, "ready");

    // The worker's guard clears `running` only when its thread unwinds.
    slots().entry(fixture.db.clone()).or_default().running = true;
    drop(RunningGuard(fixture.db.clone()));
    assert!(slots().get(&fixture.db).is_some_and(|slot| slot.running));
    let db = fixture.db.clone();
    let unwound = std::panic::catch_unwind(move || {
        let _guard = RunningGuard(db);
        if std::hint::black_box(true) {
            panic!("fixture: worker panic");
        }
    });
    assert!(unwound.is_err());
    assert!(slots().get(&fixture.db).is_some_and(|slot| !slot.running));
}

#[test]
fn p3c_enabling_keeps_a_pending_purge_until_a_retry_truncates() {
    let fixture = Fixture::new("pass_purge_reenable");
    fixture.enable();
    fixture.run(PassKind::Full);
    let wal = PathBuf::from(format!("{}-wal", fixture.db.display()));
    let alpha = ["ProjLabelAlpha", "projlabelalpha"];
    let reader = crate::db::get_connection(&fixture.db).expect("reader");
    begin_reader(&reader);
    let status = set_impl(&fixture.db, false, None).expect("disable");
    assert!(!status.purge.expect("purge report").wal_truncated);
    // While the index is off, the tool cleans up one session's logs: its
    // name is never collected again, so only the purge can remove it.
    let conn = crate::db::get_connection(&fixture.db).expect("open ledger");
    conn.execute("DELETE FROM token_logs WHERE session_id = 'sess-alpha'", [])
        .expect("clean up a session");
    drop(conn);

    // Review P3-c: enabling again while the reader still blocks the
    // truncation keeps the marker instead of clearing it.
    let status =
        set_impl(&fixture.db, true, Some(PROJECT_DIMENSION_CONSENT_VERSION)).expect("enable again");
    assert!(status.enabled);
    assert_eq!(status.last_failure.as_deref(), Some(store::PURGE_PENDING));
    // Pass bookkeeping and rebuilds keep it as well.
    assert_eq!(
        fixture.run(PassKind::Full),
        PassOutcome::Completed {
            resolved: 5,
            skipped: 0
        }
    );
    let status = status_impl(&fixture.db).expect("status");
    assert_eq!(status.state, "ready");
    assert_eq!(status.last_failure.as_deref(), Some(store::PURGE_PENDING));
    let status = rebuild_impl(&fixture.db).expect("rebuild");
    assert_eq!(status.last_failure.as_deref(), Some(store::PURGE_PENDING));
    // A failing pass keeps it too: the failure shows in the state only.
    let roots = || -> SourceRoots { panic!("fixture: unexpected failure while locating sources") };
    let deps = PassDeps {
        roots: &roots,
        host: &test_host,
        git: &NoGitProbe,
        cancelled: &|| false,
        progress: &|_, _| {},
    };
    assert_eq!(
        run_pass_guarded(&fixture.db, PassKind::Full, &deps),
        Err("internal_error")
    );
    let status = status_impl(&fixture.db).expect("status");
    assert_eq!(status.state, "failed");
    assert_eq!(status.last_failure.as_deref(), Some(store::PURGE_PENDING));
    assert!(matches!(
        fixture.run(PassKind::Full),
        PassOutcome::Completed { resolved: 5, .. }
    ));
    assert!(
        any_on_disk(&fixture.db, &alpha),
        "the blocked purge still leaves the cleaned-up name behind"
    );

    // The reader finishes; the next scan truncates although the index is on.
    reader.execute_batch("COMMIT").expect("end read");
    notify_scan_persisted(&fixture.db, true);
    let status = status_impl(&fixture.db).expect("status");
    assert!(status.enabled);
    assert_eq!(status.state, "ready");
    assert_eq!(status.last_failure, None);
    assert_eq!(fs::metadata(&wal).map(|meta| meta.len()).unwrap_or(0), 0);
    assert!(!any_on_disk(&fixture.db, &alpha));
    assert_eq!(
        fixture
            .project("codex", CODEX_UUID)
            .and_then(|project| project.label),
        Some("ProjLabelCodex".to_string())
    );
}
