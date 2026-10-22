use super::*;
use rusqlite::Connection;

struct TestDir(PathBuf);
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn ledger() -> (TestDir, PathBuf, Connection, i64) {
    static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = TestDir(std::env::temp_dir().join(format!(
        "tokenledger-sync-revision-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )));
    std::fs::create_dir(&dir.0).expect("anonymous database directory");
    let path = dir.0.join("ledger.db");
    db::init_test_db(&path).expect("initialize ledger");
    let conn = db::get_connection(&path).expect("open ledger");
    conn.execute(
        "INSERT INTO token_logs
         (tool, model, input_tokens, output_tokens, timestamp, session_id, unique_key, machine_id)
         VALUES ('claude', 'fixture-model', 100, 1, '2026-10-05 10:00:00', 'fixture', 'fixture', 'fixture-machine')",
        [],
    ).expect("insert anonymous row");
    let id = conn.last_insert_rowid();
    (dir, path, conn, id)
}

fn snapshot(conn: &Connection, id: i64) -> (i64, i64) {
    conn.query_row(
        "SELECT id, sync_revision FROM token_logs WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .expect("read upload revision")
}

#[test]
fn delayed_receipt_cannot_swallow_scanner_repricing_or_explicit_reset() {
    for mutation in [
        "UPDATE token_logs SET output_tokens = 50, sync_status = 0",
        "UPDATE token_logs SET cost_usd = NULL, sync_status = 0",
        "UPDATE token_logs SET sync_status = 0, cloud_user_id = NULL, synced_at = NULL",
        // Old callers that omit the pending flag are fenced by the database too.
        "UPDATE token_logs SET input_tokens = 150",
    ] {
        let (_dir, _path, conn, id) = ledger();
        conn.execute("UPDATE token_logs SET cost_usd = 0.5", [])
            .unwrap();
        let old = snapshot(&conn, id);
        conn.execute(mutation, [])
            .expect("concurrent local correction");
        assert_eq!(
            mark_uploaded_revisions(&conn, "user-a", "old-receipt", &[old]).unwrap(),
            0,
            "{mutation}"
        );
        let status: i64 = conn
            .query_row(
                "SELECT sync_status FROM token_logs WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, 0);
        let fresh = snapshot(&conn, id);
        assert!(fresh.1 > old.1);
        assert_eq!(
            mark_uploaded_revisions(&conn, "user-a", "fresh-receipt", &[fresh]).unwrap(),
            1
        );
        assert_eq!(
            snapshot(&conn, id),
            fresh,
            "ack must not revise business content"
        );
    }
}

#[test]
fn revision_survives_reopen_and_gateway_receipt_uses_its_snapshot() {
    let (_dir, path, conn, id) = ledger();
    let old = snapshot(&conn, id);
    let hours = gateway_cloud::HourRow {
        id,
        sync_revision: old.1,
        tool: "claude".into(),
        model: "fixture-model".into(),
        input_tokens: 100,
        output_tokens: 1,
        cached_tokens: 0,
        cache_write_tokens: 0,
        cache_write_known: None,
        cost_usd: Some(0.5),
        machine_id: "fixture-machine".into(),
        pending: true,
        gateway: false,
        superseded: false,
    };
    let plan = gateway_cloud::plan(
        &std::collections::BTreeMap::from([("2026-10-05 10:00:00".into(), vec![hours])]),
        &gateway_cloud::CloudState::default(),
        "user-a",
        "fixture-machine",
        &|_| 0.5,
    );
    assert_eq!(plan.mark_ids, vec![old]);
    conn.execute("UPDATE token_logs SET output_tokens = 50", [])
        .unwrap();
    drop(conn);
    db::init_test_db(&path).unwrap();
    let conn = db::get_connection(&path).unwrap();
    assert_eq!(
        mark_uploaded_revisions(&conn, "user-a", "old-receipt", &plan.mark_ids).unwrap(),
        0
    );
    assert!(snapshot(&conn, id).1 > old.1);
}

#[test]
fn reset_during_same_value_upload_is_not_lost_and_new_hour_rows_remain_pending() {
    let (_dir, _path, conn, id) = ledger();
    let old = snapshot(&conn, id);
    conn.execute("UPDATE token_logs SET sync_status = 0", [])
        .unwrap();
    assert_eq!(
        mark_uploaded_revisions(&conn, "user-a", "old", &[old]).unwrap(),
        0
    );
    conn.execute(
        "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, timestamp, session_id, unique_key, machine_id)
         VALUES ('claude', 'fixture-model', 20, 10, '2026-10-05 10:30:00', 'second', 'second', 'fixture-machine')", [],
    ).unwrap();
    assert_eq!(
        mark_uploaded_revisions(&conn, "user-a", "new", &[snapshot(&conn, id)]).unwrap(),
        1
    );
    let mut query = conn.prepare(RAW_SYNC_LOGS_SQL).unwrap();
    let values: Vec<i64> = query
        .query_map(params!["user-a", "fixture-machine"], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        values.len(),
        2,
        "next upload includes the whole hour, not only the new row"
    );
}

#[test]
fn recursive_triggers_do_not_recurse_or_double_increment() {
    let (_dir, _path, conn, id) = ledger();
    conn.execute_batch("PRAGMA recursive_triggers = ON")
        .unwrap();
    conn.execute("UPDATE token_logs SET output_tokens = 50", [])
        .unwrap();
    assert_eq!(snapshot(&conn, id).1, 1);
    conn.execute("UPDATE token_logs SET sync_status = 0", [])
        .unwrap();
    assert_eq!(snapshot(&conn, id).1, 2);
    assert_eq!(
        mark_uploaded_revisions(&conn, "user-a", "fresh", &[snapshot(&conn, id)]).unwrap(),
        1
    );
    assert_eq!(snapshot(&conn, id).1, 2);
}

#[test]
fn v13_upgrade_preserves_rows_and_installs_revision_once() {
    let (_dir, path, conn, id) = ledger();
    conn.execute_batch("DROP TRIGGER token_logs_dirty_old_bucket_update; DROP TRIGGER token_logs_dirty_old_bucket_delete; DROP TABLE scan_cloud_sent_identities; DROP TABLE scan_cloud_dirty_buckets; ALTER TABLE scan_cumulative_state DROP COLUMN generation; DROP TRIGGER token_logs_sync_revision; ALTER TABLE token_logs DROP COLUMN sync_revision; PRAGMA user_version = 13;").unwrap();
    drop(conn);
    db::init_test_db(&path).unwrap();
    db::init_test_db(&path).unwrap();
    let conn = db::get_connection(&path).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 16);
    assert_eq!(snapshot(&conn, id).1, 0);
    conn.execute("UPDATE token_logs SET output_tokens = 50", [])
        .unwrap();
    assert_eq!(snapshot(&conn, id).1, 1);
}

#[test]
fn failed_migration_rolls_back_column_and_version() {
    let (_dir, path, conn, _id) = ledger();
    conn.execute_batch("DROP TRIGGER token_logs_dirty_old_bucket_update; DROP TRIGGER token_logs_dirty_old_bucket_delete; DROP TABLE scan_cloud_sent_identities; DROP TABLE scan_cloud_dirty_buckets; ALTER TABLE scan_cumulative_state DROP COLUMN generation; DROP TRIGGER token_logs_sync_revision; ALTER TABLE token_logs DROP COLUMN sync_revision; PRAGMA user_version = 13;
        CREATE TABLE migration_canary (value INTEGER);
        CREATE TRIGGER token_logs_sync_revision AFTER UPDATE ON migration_canary BEGIN SELECT 1; END;").unwrap();
    drop(conn);
    assert!(db::init_test_db(&path).is_err());
    let conn = db::get_connection(&path).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        13
    );
    assert!(conn
        .prepare("SELECT sync_revision FROM token_logs")
        .is_err());
}

#[test]
fn legacy_empty_machine_and_current_machine_upload_one_complete_bucket() {
    for legacy_machine in ["", "fixture-machine"] {
        let (_dir, _path, conn, id) = ledger();
        conn.execute(
            "UPDATE token_logs SET machine_id=?1, output_tokens=10",
            [legacy_machine],
        )
        .unwrap();
        mark_uploaded_revisions(&conn, "user-a", "old", &[snapshot(&conn, id)]).unwrap();
        conn.execute("INSERT INTO token_logs(tool,model,input_tokens,output_tokens,timestamp,session_id,unique_key,machine_id)
            VALUES('claude','fixture-model',20,2,'2026-10-05 10:30:00','new','new','fixture-machine')",[]).unwrap();
        conn.execute("INSERT INTO token_logs(tool,model,input_tokens,output_tokens,timestamp,session_id,unique_key,machine_id)
            VALUES('claude','fixture-model',900,90,'2026-10-05 10:30:00','other','other','other-machine')",[]).unwrap();
        let other_id = conn.last_insert_rowid();
        mark_uploaded_revisions(&conn, "user-a", "old", &[snapshot(&conn, other_id)]).unwrap();
        let rows: Vec<(i64, i64)> = conn
            .prepare(RAW_SYNC_LOGS_SQL)
            .unwrap()
            .query_map(params!["user-a", "fixture-machine"], |r| {
                Ok((r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.iter().fold((0, 0), |a, r| (a.0 + r.0, a.1 + r.1)),
            (120, 12)
        );
    }
}

#[test]
fn antigravity_metadata_only_revision_fences_late_receipt_after_reopen() {
    let (_dir, path, conn, id) = ledger();
    conn.execute("UPDATE token_logs SET tool='antigravity',usage_provenance='reported',cache_write_known=0,sync_status=0 WHERE id=?1",[id]).unwrap();
    let old = snapshot(&conn, id);
    conn.execute(
        "UPDATE token_logs SET cache_write_known=1,sync_status=0 WHERE id=?1",
        [id],
    )
    .unwrap();
    let fresh = snapshot(&conn, id);
    assert_eq!(fresh.1, old.1 + 1);
    drop(conn);
    let conn = db::get_connection(&path).unwrap();
    assert_eq!(
        mark_uploaded_revisions(&conn, "user-a", "stale", &[old]).unwrap(),
        0
    );
    assert_eq!(
        mark_uploaded_revisions(&conn, "user-a", "fresh", &[fresh]).unwrap(),
        1
    );
    assert_eq!(snapshot(&conn, id), fresh);
}
