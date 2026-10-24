use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tokenledger_device_{name}_{}_{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create test dir");
    dir
}

fn test_db(name: &str) -> (PathBuf, Connection) {
    let path = temp_dir(name).join("tokenboard.db");
    crate::db::init_test_db(&path).expect("initialize test db");
    let conn = Connection::open(&path).expect("open test db");
    (path, conn)
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).expect(sql)
}

#[test]
fn the_id_is_random_kept_and_reveals_nothing_about_the_computer() {
    let dir = temp_dir("create");
    let id = for_data_dir(&dir).expect("create id");
    assert!(is_valid(&id), "{id}");
    assert!(!id.contains(&legacy_machine_id()));
    let stored = fs::read_to_string(dir.join(DEVICE_ID_FILE)).expect("read id file");
    assert_eq!(stored.trim(), id);
    // A second process (no cache) reads the same file.
    assert_eq!(load_or_create(&dir).expect("reload id"), id);
    assert_ne!(load_or_create(&temp_dir("other")).expect("other id"), id);
}

#[test]
fn an_unreadable_id_file_is_replaced() {
    let dir = temp_dir("broken");
    fs::write(dir.join(DEVICE_ID_FILE), "MY-LAPTOP\n").expect("seed broken id");
    let id = load_or_create(&dir).expect("replace id");
    assert!(is_valid(&id));
    assert_eq!(read_valid(&dir.join(DEVICE_ID_FILE)), Some(id));
}

#[test]
fn ids_are_checked_strictly() {
    assert!(is_valid("tl-0123456789abcdef"));
    assert!(!is_valid("tl-0123456789ABCDEF"));
    assert!(!is_valid("tl-0123456789abcde"));
    assert!(!is_valid("MY-LAPTOP"));
    assert!(!is_valid(""));
}

#[test]
fn init_db_stamps_new_ledgers_with_the_device_id() {
    let (path, conn) = test_db("init");
    let id = for_db(&path).expect("device id");
    assert!(is_valid(&id));
    // The sync still checks the cloud for rows under the hostname.
    assert_eq!(
        legacy_machine_ids(&conn, &id).expect("legacy ids"),
        vec![legacy_machine_id()]
    );
}

#[test]
fn local_rows_and_sync_bookkeeping_move_without_being_re_uploaded() {
    let (path, conn) = test_db("migrate");
    let id = for_db(&path).expect("device id");
    conn.execute_batch(
        "INSERT INTO token_logs
            (tool, model, input_tokens, output_tokens, cached_tokens, timestamp,
             session_id, unique_key, cost_usd, machine_id, sync_status, cloud_user_id)
         VALUES
            ('codex', 'm', 10, 1, 0, '2026-10-01 10:05:00', 's1', 'k1', 0.1, 'OLD-PC', 1, 'u'),
            ('codex', 'm', 10, 1, 0, '2026-10-01 10:06:00', 's2', 'k2', 0.1, 'OLD-PC', 0, NULL),
            ('codex', 'm', 10, 1, 0, '2026-10-01 10:07:00', 's3', 'k3', 0.1, 'peer:other', 1, 'u'),
            ('codex', 'm', 10, 1, 0, '2026-10-01 10:08:00', 's4', 'k4', 0.1, '', 1, 'u');
         INSERT INTO scan_cloud_sent_identities
            (user_id, source_key, tool, model, hour_bucket, machine_id)
         VALUES ('u', 'k1', 'codex', 'm', '2026-10-01 10:00:00', 'OLD-PC');
         INSERT INTO scan_cloud_dirty_buckets (user_id, tool, model, hour_bucket, machine_id)
         VALUES ('u', 'codex', 'm', '2026-09-30 09:00:00', 'OLD-PC');
         INSERT INTO pending_cloud_purges (tool, machine_id, ready) VALUES ('codex', 'OLD-PC', 0);",
    )
    .expect("seed legacy rows");
    let revision_before = count(
        &conn,
        "SELECT sync_revision FROM token_logs WHERE unique_key = 'k1'",
    );

    migrate_local(&conn, "OLD-PC", &id).expect("migrate");

    let machine = |key: &str| -> String {
        conn.query_row(
            "SELECT machine_id FROM token_logs WHERE unique_key = ?1",
            [key],
            |row| row.get(0),
        )
        .expect("machine")
    };
    assert_eq!(machine("k1"), id);
    assert_eq!(machine("k2"), id);
    assert_eq!(
        machine("k3"),
        "peer:other",
        "other computers' rows keep their id"
    );
    assert_eq!(
        machine("k4"),
        "",
        "unstamped rows already resolve to this computer"
    );
    assert_eq!(
        count(
            &conn,
            "SELECT sync_status FROM token_logs WHERE unique_key = 'k1'"
        ),
        1,
        "the cloud copy is moved by the sync, so the row is not re-sent"
    );
    assert_eq!(
        count(
            &conn,
            "SELECT sync_revision FROM token_logs WHERE unique_key = 'k1'"
        ),
        revision_before + 1
    );
    assert_eq!(
        count(&conn, "SELECT count(*) FROM scan_cloud_dirty_buckets"),
        1
    );
    let dirty_machine: String = conn
        .query_row(
            "SELECT machine_id FROM scan_cloud_dirty_buckets",
            [],
            |row| row.get(0),
        )
        .expect("dirty machine");
    assert_eq!(dirty_machine, id);
    let sent_machine: String = conn
        .query_row(
            "SELECT machine_id FROM scan_cloud_sent_identities",
            [],
            |row| row.get(0),
        )
        .expect("sent machine");
    assert_eq!(sent_machine, id);
    let purge: (String, i64) = conn
        .query_row(
            "SELECT machine_id, ready FROM pending_cloud_purges WHERE tool = 'codex'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("purge");
    assert_eq!(purge, (id.clone(), 0), "a staged rebuild keeps waiting");
    assert!(crate::db::codex_rebuild_pending(&conn, &id).expect("rebuild gate"));
    assert!(legacy_machine_ids(&conn, &id)
        .expect("legacy ids")
        .contains(&"OLD-PC".to_string()));

    // Once per ledger: rows an old version adds later are not touched again.
    conn.execute(
        "UPDATE token_logs SET machine_id = 'OLD-PC' WHERE unique_key = 'k2'",
        [],
    )
    .expect("reseed");
    migrate_local(&conn, "OLD-PC", &id).expect("second run");
    assert_eq!(machine("k2"), "OLD-PC");
    drop(conn);
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn moved_keys_rename_only_this_machines_aggregates() {
    let id = "tl-0123456789abcdef";
    assert_eq!(
        moved_unique_key("agg_OLD-PC_codex_m_2026-10-01 10:00:00", "OLD-PC", id),
        "agg_tl-0123456789abcdef_codex_m_2026-10-01 10:00:00"
    );
    assert_eq!(
        moved_unique_key("agg_OLD-PC2_codex_m_h", "OLD-PC", id),
        "agg_OLD-PC2_codex_m_h"
    );
    assert_eq!(moved_unique_key("raw-key", "OLD-PC", id), "raw-key");
}
