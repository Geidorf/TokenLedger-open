use super::*;
use crate::commands::{mark_uploaded_revisions, RAW_SYNC_LOGS_SQL};
use crate::db;
use std::path::PathBuf;
struct TestDir(PathBuf);
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn ledger() -> (TestDir, PathBuf, Connection, i64) {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = TestDir(std::env::temp_dir().join(format!(
        "tokenledger-dirty-bucket-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    )));
    std::fs::create_dir(&dir.0).unwrap();
    let path = dir.0.join("anonymous.db");
    db::init_test_db(&path).unwrap();
    let conn = db::get_connection(&path).unwrap();
    conn.execute("INSERT INTO token_logs(tool,model,input_tokens,output_tokens,timestamp,session_id,unique_key,machine_id,cost_usd)
        VALUES('claude','A',100,10,'2026-10-05 10:00:00','s','source','machine',1.0)",[]).unwrap();
    let id = conn.last_insert_rowid();
    (dir, path, conn, id)
}
fn revision(conn: &Connection, id: i64) -> i64 {
    conn.query_row(
        "SELECT sync_revision FROM token_logs WHERE id=?1",
        [id],
        |r| r.get(0),
    )
    .unwrap()
}
fn dirty(conn: &Connection) -> DirtySnapshot {
    dirty_snapshot(conn, "user-a", "machine", &HashSet::new()).unwrap()
}
fn bucket(model: &str, hour: &str) -> Bucket {
    Bucket {
        tool: "claude".into(),
        model: model.into(),
        hour_bucket: hour.into(),
        machine_id: "machine".into(),
    }
}

#[test]
fn first_upload_in_flight_move_reopen_and_stale_receipt_preserve_old_identity() {
    let (_dir, path, conn, id) = ledger();
    let old = revision(&conn, id);
    let tx = conn.unchecked_transaction().unwrap();
    remember_sending(&tx, "user-a", "machine", [id]).unwrap();
    tx.commit().unwrap();
    conn.execute(
        "UPDATE token_logs SET model='B',timestamp='2026-10-05 11:00:00' WHERE id=?1",
        [id],
    )
    .unwrap();
    assert_eq!(
        mark_uploaded_revisions(&conn, "user-a", "stale", &[(id, old)]).unwrap(),
        0
    );
    drop(conn);
    let conn = db::get_connection(&path).unwrap();
    let event = dirty(&conn);
    assert!(event.buckets.contains(&bucket("A", "2026-10-05 10:00:00")));
    let mut payloads = Vec::new();
    let mut deletes = Vec::new();
    repair_payloads(
        &event,
        &BTreeMap::new(),
        false,
        "user-a",
        &mut payloads,
        &mut deletes,
        &|_| 1.0,
    );
    assert_eq!(
        deletes,
        vec![bucket("A", "2026-10-05 10:00:00").unique_key()]
    );
    // A failed cloud call does not acknowledge anything.
    assert_eq!(dirty(&conn).ids, event.ids);
    assert!(dirty_snapshot(&conn, "user-b", "machine", &HashSet::new())
        .unwrap()
        .ids
        .is_empty());
}

#[test]
fn old_bucket_upload_recomputes_remaining_synced_members() {
    let (_dir, _path, conn, id) = ledger();
    mark_uploaded_revisions(&conn, "user-a", "old", &[(id, revision(&conn, id))]).unwrap();
    conn.execute("INSERT INTO token_logs(tool,model,input_tokens,output_tokens,timestamp,session_id,unique_key,machine_id,cost_usd,sync_status,cloud_user_id)
        VALUES('claude','A',20,2,'2026-10-05 10:30:00','other','other','machine',0.2,1,'user-a')",[]).unwrap();
    conn.execute("UPDATE token_logs SET model='B' WHERE id=?1", [id])
        .unwrap();
    let rows: Vec<(String, i64, i64)> = conn
        .prepare(RAW_SYNC_LOGS_SQL)
        .unwrap()
        .query_map(params!["user-a", "machine"], |r| {
            Ok((r.get(2)?, r.get(3)?, r.get(10)?))
        })
        .unwrap()
        .collect::<Result<_>>()
        .unwrap();
    assert!(rows.iter().any(|r| r.0 == "A" && r.1 == 20));
    assert!(dirty(&conn)
        .buckets
        .contains(&bucket("A", "2026-10-05 10:00:00")));
}

#[test]
fn chained_moves_delete_recreate_and_ack_never_clear_new_events() {
    let (_dir, _path, conn, id) = ledger();
    remember_sending(&conn, "user-a", "machine", [id]).unwrap();
    conn.execute("UPDATE token_logs SET model='B'", []).unwrap();
    let first = dirty(&conn);
    remember_sending(&conn, "user-a", "machine", [id]).unwrap();
    conn.execute("UPDATE token_logs SET model='C'", []).unwrap();
    acknowledge_dirty(&conn, "user-a", &first.ids).unwrap();
    let second = dirty(&conn);
    assert!(second.buckets.contains(&bucket("B", "2026-10-05 10:00:00")));
    assert!(second.ids.iter().all(|id| *id > *first.ids.last().unwrap()));
    conn.execute("DELETE FROM token_logs WHERE id=?1", [id])
        .unwrap();
    conn.execute("INSERT INTO token_logs(tool,model,input_tokens,output_tokens,timestamp,session_id,unique_key,machine_id)
        VALUES('claude','A',7,1,'2026-10-05 10:00:00','s','source','machine')",[]).unwrap();
    acknowledge_dirty(&conn, "user-a", &second.ids).unwrap();
    let final_events = dirty(&conn);
    assert!(!final_events.ids.is_empty());
    let key = bucket("A", "2026-10-05 10:00:00").unique_key();
    let mut logs = vec![serde_json::json!({"unique_key":key})];
    let mut deletes = vec![key.clone()];
    repair_payloads(
        &final_events,
        &BTreeMap::new(),
        false,
        "user-a",
        &mut logs,
        &mut deletes,
        &|_| 0.0,
    );
    assert!(
        !deletes.contains(&key),
        "recreated live bucket must survive"
    );
    let tx = conn.unchecked_transaction().unwrap();
    acknowledge_dirty(&tx, "user-a", &final_events.ids).unwrap();
    drop(tx);
    assert_eq!(
        dirty(&conn).ids,
        final_events.ids,
        "local receipt rollback preserves events"
    );
}

#[test]
fn gateway_members_are_preserved_and_mixed_snapshot_is_rejected() {
    let (_dir, _path, conn, id) = ledger();
    let mut row = gateway_cloud::HourRow {
        id,
        sync_revision: revision(&conn, id),
        tool: "claude".into(),
        model: "A".into(),
        input_tokens: 100,
        output_tokens: 10,
        cached_tokens: 0,
        cache_write_tokens: 0,
        cache_write_known: None,
        cost_usd: Some(1.0),
        machine_id: "machine".into(),
        pending: false,
        gateway: false,
        superseded: false,
    };
    let mut gateway = row.clone();
    gateway.gateway = true;
    gateway.id = 0;
    gateway.input_tokens = 50;
    gateway.cost_usd = Some(2.0);
    let hours = BTreeMap::from([("2026-10-05 10:00:00".into(), vec![row.clone(), gateway])]);
    assert!(gateway_snapshot_matches(&conn, &hours).unwrap());
    let event = DirtySnapshot {
        ids: vec![],
        buckets: HashSet::from([bucket("A", "2026-10-05 10:00:00")]),
    };
    let mut logs = Vec::new();
    let mut deletes = vec![event.buckets.iter().next().unwrap().unique_key()];
    repair_payloads(
        &event,
        &hours,
        false,
        "user-a",
        &mut logs,
        &mut deletes,
        &|r| r.cost_usd.unwrap(),
    );
    assert!(deletes.is_empty());
    assert_eq!(logs[0]["input_tokens"], 150);
    assert_eq!(logs[0]["gateway_requests"], 1);
    assert_eq!(logs[0]["cost_usd"], 3.0);
    conn.execute("UPDATE token_logs SET output_tokens=20", [])
        .unwrap();
    assert!(!gateway_snapshot_matches(&conn, &hours).unwrap());
    row.sync_revision = revision(&conn, id);
    let fresh = BTreeMap::from([("2026-10-05 10:00:00".into(), vec![row])]);
    assert!(gateway_snapshot_matches(&conn, &fresh).unwrap());
    conn.execute("INSERT INTO token_logs(tool,model,input_tokens,output_tokens,timestamp,session_id,unique_key,machine_id)
        VALUES('claude','A',7,1,'2026-10-05 10:00:00','s2','new','machine')",[]).unwrap();
    assert!(!gateway_snapshot_matches(&conn, &fresh).unwrap());
}

#[test]
fn antigravity_ordinary_upload_projection_includes_all_members_and_nulls_unknown_bucket() {
    let (_dir, _path, conn, id) = ledger();
    conn.execute("UPDATE token_logs SET tool='antigravity',cached_tokens=0,cache_write_tokens=0,usage_provenance='reported',cache_write_known=0,sync_status=0 WHERE id=?1",[id]).unwrap();
    conn.execute("INSERT INTO token_logs(tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,timestamp,session_id,unique_key,machine_id,usage_provenance,cache_write_known,sync_status,cloud_user_id) VALUES('antigravity','A',10,2,20,5,'2026-10-05 10:00:00','s2','source2','machine','reported',1,1,'user-a')",[]).unwrap();
    let mut stmt = conn.prepare(RAW_SYNC_LOGS_SQL).unwrap();
    let members = stmt
        .query_map(params!["user-a", "machine"], |r| {
            Ok((r.get::<_, i64>(6)?, r.get::<_, Option<bool>>(13)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>>>()
        .unwrap();
    assert_eq!(members.len(), 2);
    assert_eq!(crate::commands::scan_cache_write_projection(members), None);
    assert_eq!(
        crate::commands::scan_cache_write_projection([(0, Some(true)), (5, Some(true))]),
        Some(5)
    );
    assert_eq!(
        crate::commands::scan_cache_write_projection([(0, None)]),
        Some(0)
    );
}

#[test]
fn antigravity_selected_label_move_repairs_old_bucket_with_null_write_and_deletes_empty() {
    let (_dir, _path, conn, id) = ledger();
    conn.execute("UPDATE token_logs SET tool='antigravity',usage_provenance='reported',cache_write_known=0,sync_status=0 WHERE id=?1",[id]).unwrap();
    remember_sending(&conn, "user-a", "machine", [id]).unwrap();
    let previous = revision(&conn, id);
    conn.execute(
        "UPDATE token_logs SET model='B',timestamp='2026-10-05 11:00:00',sync_status=0 WHERE id=?1",
        [id],
    )
    .unwrap();
    let event = dirty(&conn);
    let old = Bucket {
        tool: "antigravity".into(),
        ..bucket("A", "2026-10-05 10:00:00")
    };
    assert!(event.buckets.contains(&old));
    assert_eq!(
        mark_uploaded_revisions(&conn, "user-a", "stale", &[(id, previous)]).unwrap(),
        0
    );
    let mut payloads = Vec::new();
    let mut deletes = Vec::new();
    repair_payloads(
        &event,
        &BTreeMap::new(),
        false,
        "user-a",
        &mut payloads,
        &mut deletes,
        &|_| 1.0,
    );
    assert_eq!(deletes, vec![old.unique_key()]);
    let remaining = gateway_cloud::HourRow {
        id: 99,
        sync_revision: 0,
        tool: "antigravity".into(),
        model: "A".into(),
        input_tokens: 1,
        output_tokens: 1,
        cached_tokens: 0,
        cache_write_tokens: 0,
        cache_write_known: Some(false),
        cost_usd: None,
        machine_id: "machine".into(),
        pending: true,
        gateway: false,
        superseded: false,
    };
    let hours = BTreeMap::from([("2026-10-05 10:00:00".into(), vec![remaining])]);
    payloads.clear();
    deletes.clear();
    repair_payloads(
        &event,
        &hours,
        false,
        "user-a",
        &mut payloads,
        &mut deletes,
        &|_| 1.0,
    );
    assert!(deletes.is_empty());
    assert!(payloads[0]["cache_write_tokens"].is_null());
    assert_eq!(payloads[0]["unique_key"], old.unique_key());
}
