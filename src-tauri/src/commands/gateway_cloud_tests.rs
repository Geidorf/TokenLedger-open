use super::*;
use crate::app_paths::AppContext;
use chrono::{Local, TimeZone, Utc};
use rusqlite::params;
use std::sync::atomic::{AtomicUsize, Ordering};

const HOUR: &str = "2026-10-04 10:00:00";

fn scan(id: i64, model: &str, input: i64, output: i64) -> HourRow {
    HourRow {
        timestamp: "2026-10-01 10:00:00".to_string(),
        id,
        sync_revision: 0,
        tool: "codex".into(),
        model: model.into(),
        input_tokens: input,
        output_tokens: output,
        cached_tokens: 100,
        cache_write_tokens: 0,
        cache_write_known: None,
        cost_usd: Some(0.5),
        machine_id: "mac".into(),
        pending: true,
        gateway: false,
        superseded: false,
    }
}

fn gateway(id: i64, input: i64, output: i64) -> HourRow {
    HourRow {
        timestamp: "2026-10-01 10:00:00".to_string(),
        id,
        sync_revision: 0,
        tool: "codex".into(),
        model: "gpt-5.5".into(),
        input_tokens: input,
        output_tokens: output,
        cached_tokens: 100,
        cache_write_tokens: 0,
        cache_write_known: None,
        cost_usd: None,
        machine_id: "mac".into(),
        pending: false,
        gateway: true,
        superseded: false,
    }
}

fn cost(row: &HourRow) -> f64 {
    row.cost_usd.unwrap_or(0.25)
}

fn one_hour(rows: Vec<HourRow>) -> BTreeMap<String, Vec<HourRow>> {
    BTreeMap::from([(HOUR.to_string(), rows)])
}

#[test]
fn merged_hour_replaces_superseded_scan_and_deletes_its_key() {
    let mut duplicate = scan(1, "openai/gpt-5.5", 200, 80);
    duplicate.superseded = true;
    let kept = scan(2, "gpt-5.5", 10, 5);
    let hours = one_hour(vec![duplicate, kept, gateway(-7, 200, 80)]);

    let plan = plan(&hours, &CloudState::default(), "user-a", "mac", &cost);

    assert_eq!(plan.hours, BTreeSet::from([HOUR.to_string()]));
    assert_eq!(plan.upserts.len(), 1);
    let merged = &plan.upserts[0];
    assert_eq!(merged.unique_key(), format!("agg_mac_codex_gpt-5.5_{HOUR}"));
    assert_eq!((merged.input_tokens, merged.output_tokens), (210, 85));
    assert_eq!(merged.cached_tokens, 200, "cache stays its own column");
    assert_eq!((merged.requests, merged.gateway_requests), (2, 1));
    assert!((merged.cost_usd - 0.75).abs() < 1e-9);
    assert_eq!(
        plan.deletes,
        vec![format!("agg_mac_codex_openai/gpt-5.5_{HOUR}")],
        "the scan-only aggregate of the superseded model must leave the cloud"
    );
    assert_eq!(plan.mark_ids, vec![(1, 0), (2, 0)]);
    let payload = merged.payload("user-a");
    assert_eq!(payload["session_id"], "agg");
    assert_eq!(payload["gateway_requests"], 1);
    assert_eq!(payload["timestamp"], HOUR);
}

#[test]
fn unchanged_hour_is_not_resent_and_changes_are() {
    let mut synced = scan(2, "gpt-5.5", 10, 5);
    synced.pending = false;
    let hours = one_hour(vec![synced.clone(), gateway(-7, 200, 80)]);
    let first = plan(&hours, &CloudState::default(), "user-a", "mac", &cost);
    assert!(first.has_work(), "an hour never uploaded is sent once");

    let again = plan(&hours, &first.next_state, "user-a", "mac", &cost);
    assert!(!again.has_work(), "same merged hour, nothing pending");
    assert_eq!(again.next_state, first.next_state);

    let cheaper = plan(&hours, &first.next_state, "user-a", "mac", &|_| 99.0);
    assert!(
        !cheaper.has_work(),
        "a price change alone does not re-upload"
    );

    let grown = one_hour(vec![synced, gateway(-7, 200, 80), gateway(-8, 1, 1)]);
    let next = plan(&grown, &first.next_state, "user-a", "mac", &cost);
    assert_eq!(next.upserts.len(), 1);
    assert_eq!(next.upserts[0].gateway_requests, 2);
    assert!(next.deletes.is_empty());
}

#[test]
fn state_of_another_user_or_machine_is_ignored() {
    let hours = one_hour(vec![gateway(-7, 200, 80)]);
    let first = plan(&hours, &CloudState::default(), "user-a", "mac", &cost);
    assert!(plan(&hours, &first.next_state, "user-b", "mac", &cost).has_work());
    assert!(plan(&hours, &first.next_state, "user-a", "pc", &cost).has_work());
}

#[test]
fn hour_without_merged_rows_only_deletes() {
    let mut duplicate = scan(1, "gpt-5.5", 200, 80);
    duplicate.superseded = true;
    let plan = plan(
        &one_hour(vec![duplicate]),
        &CloudState::default(),
        "user-a",
        "mac",
        &cost,
    );
    assert!(plan.upserts.is_empty());
    assert_eq!(plan.deletes, vec![format!("agg_mac_codex_gpt-5.5_{HOUR}")]);
    assert_eq!(plan.mark_ids, vec![(1, 0)]);
    assert!(plan.next_state.hours[HOUR].keys.is_empty());
}

#[test]
fn postgrest_filter_quotes_every_key() {
    let keys = vec!["agg_a,b".to_string(), "agg_\"q\"\\".to_string()];
    assert_eq!(
        postgrest_in_filter(&keys),
        r#"in.("agg_a,b","agg_\"q\"\\")"#
    );
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn test_app() -> (AppContext, PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "tokenledger_gw_cloud_{}_{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    let app = AppContext::for_test(path.clone());
    db::init_db(&db::get_db_path(&app)).expect("init test db");
    (app, path)
}

fn insert_scan(db_path: &Path, key: &str, session: &str, at: &str, synced_for: Option<&str>) {
    let conn = db::get_connection(db_path).unwrap();
    conn.execute(
        "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens,
             cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id,
             sync_status, cloud_user_id)
         VALUES ('codex', 'gpt-5.5', 200, 80, 0, 0, ?1, ?2, ?3, 0.1, '', ?4, ?5)",
        params![
            at,
            session,
            key,
            i64::from(synced_for.is_some()),
            synced_for
        ],
    )
    .unwrap();
}

#[test]
fn collect_hours_flags_superseded_scans_and_skips_untouched_hours() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    insert_scan(&db_path, "dup", "s1", "2026-10-04 10:00:09", None);
    insert_scan(
        &db_path,
        "same-hour",
        "other",
        "2026-10-04 10:40:00",
        Some("user-a"),
    );
    insert_scan(&db_path, "elsewhere", "other", "2026-10-04 15:00:00", None);
    let end = Local
        .with_ymd_and_hms(2026, 10, 4, 10, 0, 10)
        .single()
        .unwrap();
    let line = json!({
        "ts": end.with_timezone(&Utc).to_rfc3339(), "requestId": "g1", "agent": "codex",
        "session": "s1", "endpoint": "responses", "provider": "openai",
        "requestedModel": "openai/gpt-5.5", "upstreamModel": "gpt-5.5", "wire": "responses",
        "stream": true, "status": 200, "ok": true, "input": 200, "output": 80,
        "cacheRead": 0, "cacheWrite": 0, "latencyMs": 900, "error": null
    });
    let dir = gateway_overlay::gateway_dir(&db_path);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("usage-v1.jsonl"), format!("{line}\n")).unwrap();

    let hours = collect_hours(&db_path, "user-a", "mac").unwrap();
    assert_eq!(hours.keys().collect::<Vec<_>>(), vec![HOUR]);
    let rows = &hours[HOUR];
    assert_eq!(rows.len(), 3);
    let dup = rows
        .iter()
        .find(|row| row.input_tokens == 200 && !row.gateway && row.superseded);
    assert!(dup.is_some_and(|row| row.pending && row.machine_id == "mac"));
    assert!(rows
        .iter()
        .any(|row| !row.gateway && !row.superseded && !row.pending));
    assert!(rows
        .iter()
        .any(|row| row.gateway && row.id < 0 && row.cost_usd.is_none()));

    let plan = plan(&hours, &load_state(&db_path), "user-a", "mac", &cost);
    assert_eq!(plan.upserts.len(), 1);
    assert_eq!(
        (plan.upserts[0].requests, plan.upserts[0].gateway_requests),
        (2, 1)
    );
    save_state(&db_path, &plan.next_state).unwrap();
    assert_eq!(load_state(&db_path), plan.next_state);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn no_ledger_means_no_hours_and_no_state_file() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    insert_scan(&db_path, "a", "s1", "2026-10-04 10:00:09", None);
    assert!(collect_hours(&db_path, "user-a", "mac").unwrap().is_empty());
    save_state(&db_path, &CloudState::default()).unwrap();
    assert!(!gateway_overlay::gateway_dir(&db_path).exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn dedupe_and_receipt_share_one_snapshot_during_concurrent_correction() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    insert_scan(&db_path, "snapshot-row", "s1", "2026-10-04 10:00:09", None);
    let end = Local
        .with_ymd_and_hms(2026, 10, 4, 10, 0, 10)
        .single()
        .unwrap();
    let line = json!({
        "ts": end.with_timezone(&Utc).to_rfc3339(), "requestId": "snapshot-g1", "agent": "codex",
        "session": null, "endpoint": "responses", "provider": "openai",
        "requestedModel": "gpt-5.5", "upstreamModel": "gpt-5.5", "wire": "responses",
        "stream": true, "status": 200, "ok": true, "input": 200, "output": 80,
        "cacheRead": 0, "cacheWrite": 0, "latencyMs": 900, "error": null
    });
    let dir = gateway_overlay::gateway_dir(&db_path);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("usage-v1.jsonl"), format!("{line}\n")).unwrap();
    // A second WAL writer commits between candidate selection and receipt read.
    let hours = collect_hours_with_scan_hook(&db_path, "user-a", "mac", || {
        db::get_connection(&db_path)
            .unwrap()
            .execute("UPDATE token_logs SET input_tokens = 350", [])
            .unwrap();
    })
    .unwrap();
    let old = hours[HOUR].iter().find(|row| !row.gateway).unwrap();
    assert!(old.superseded);
    assert_eq!((old.input_tokens, old.sync_revision), (200, 0));
    let plan = plan(&hours, &CloudState::default(), "user-a", "mac", &cost);
    let conn = db::get_connection(&db_path).unwrap();
    assert_eq!(
        super::super::mark_uploaded_revisions(&conn, "user-a", "old", &plan.mark_ids).unwrap(),
        0
    );
    let current = collect_hours(&db_path, "user-a", "mac").unwrap();
    let updated = current[HOUR].iter().find(|row| !row.gateway).unwrap();
    assert!(!updated.superseded);
    assert_eq!((updated.input_tokens, updated.sync_revision), (350, 1));
    drop(conn);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn post_backfill_gateway_snapshot_can_be_acknowledged_without_competing_write() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    insert_scan(&db_path, "backfill-row", "s1", "2026-10-04 10:00:09", None);
    let conn = db::get_connection(&db_path).unwrap();
    conn.execute("UPDATE token_logs SET cost_usd = NULL", [])
        .unwrap();
    let end = Local
        .with_ymd_and_hms(2026, 10, 4, 10, 0, 10)
        .single()
        .unwrap();
    let line = json!({
        "ts": end.with_timezone(&Utc).to_rfc3339(), "requestId": "backfill-g1", "agent": "codex",
        "session": "s1", "endpoint": "responses", "provider": "openai",
        "requestedModel": "gpt-5.5", "upstreamModel": "gpt-5.5", "wire": "responses",
        "stream": true, "status": 200, "ok": true, "input": 200, "output": 80,
        "cacheRead": 0, "cacheWrite": 0, "latencyMs": 900, "error": null
    });
    let dir = gateway_overlay::gateway_dir(&db_path);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("usage-v1.jsonl"), format!("{line}\n")).unwrap();
    super::super::backfill_null_costs(&db_path, &json!({})).unwrap();
    let hours = collect_hours(&db_path, "user-a", "mac").unwrap();
    let plan = plan(&hours, &CloudState::default(), "user-a", "mac", &cost);
    assert_eq!(
        super::super::mark_uploaded_revisions(&conn, "user-a", "current", &plan.mark_ids).unwrap(),
        1
    );
    drop(conn);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn permanent_cloud_hour_never_shrinks_when_diagnostic_files_disappear() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let dir = gateway_overlay::gateway_dir(&db_path);
    fs::create_dir_all(&dir).unwrap();
    let end = Local
        .with_ymd_and_hms(2026, 10, 4, 10, 0, 10)
        .single()
        .unwrap();
    let line = json!({
        "ts": end.with_timezone(&Utc).to_rfc3339(), "requestId":"permanent-old",
        "agent":"codex", "session":null, "endpoint":"responses", "provider":"p",
        "requestedModel":"p/m", "upstreamModel":"m", "wire":"responses",
        "stream":true, "status":200, "ok":true, "input":10, "output":2,
        "cacheRead":0, "cacheWrite":0, "latencyMs":10, "error":null
    });
    fs::write(dir.join("usage-v1.jsonl"), format!("{line}\n")).unwrap();
    let first = collect_hours(&db_path, "user-a", "mac").unwrap();
    assert_eq!(
        aggregate_hour(HOUR, &first[HOUR], &cost)[0].input_tokens,
        10
    );
    fs::remove_file(dir.join("usage-v1.jsonl")).unwrap();
    assert_eq!(collect_hours(&db_path, "user-a", "mac").unwrap(), first);
    let mut new: crate::gateway::LedgerRecord = serde_json::from_value(line).unwrap();
    new.request_id = "permanent-new".into();
    new.input = 20;
    crate::gateway::accounting::append(&dir, &new).unwrap();
    let next = collect_hours(&db_path, "user-a", "mac").unwrap();
    assert_eq!(aggregate_hour(HOUR, &next[HOUR], &cost)[0].input_tokens, 30);
    assert!(accounting_coverage(&db_path)
        .unwrap()
        .unwrap()
        .has_incomplete_history());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn filtering_protected_old_hours_preserves_cloud_state_and_new_hours_continue() {
    let old = plan(
        &one_hour(vec![gateway(-1, 10, 2)]),
        &CloudState::default(),
        "user-a",
        "mac",
        &cost,
    );
    let empty = plan(&BTreeMap::new(), &old.next_state, "user-a", "mac", &cost);
    assert!(!empty.has_work());
    assert_eq!(empty.next_state, old.next_state);
    let next_hour = "2026-10-05 11:00:00";
    let future = BTreeMap::from([(next_hour.to_string(), vec![gateway(-2, 20, 3)])]);
    let next = plan(&future, &old.next_state, "user-a", "mac", &cost);
    assert_eq!(next.upserts.len(), 1);
    assert!(next.deletes.is_empty());
    assert_eq!(next.next_state.hours[HOUR], old.next_state.hours[HOUR]);
    assert!(next.next_state.hours.contains_key(next_hour));
}

#[test]
fn corrupt_accounting_blocks_cloud_collection_and_fresh_store_has_no_legacy_partial() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    assert!(accounting_coverage(&db_path).unwrap().is_none());
    let dir = gateway_overlay::gateway_dir(&db_path);
    crate::gateway::accounting::initialize(&dir).unwrap();
    assert!(!accounting_coverage(&db_path)
        .unwrap()
        .unwrap()
        .has_incomplete_history());
    fs::write(
        dir.join(crate::gateway::accounting::FILE),
        b"broken database",
    )
    .unwrap();
    assert!(collect_hours(&db_path, "user-a", "mac").is_err());
    assert!(accounting_coverage(&db_path).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn antigravity_unknown_cache_write_survives_hourly_merge_and_fingerprint() {
    let mut unknown = scan(101, "selected-label", 10, 2);
    unknown.tool = "antigravity".into();
    unknown.cached_tokens = 0;
    unknown.cache_write_tokens = 0;
    unknown.cache_write_known = Some(false);
    let mut known = unknown.clone();
    known.id = 102;
    known.cached_tokens = 20;
    known.cache_write_tokens = 5;
    known.cache_write_known = Some(true);
    let mixed = aggregate_hour(HOUR, &[unknown.clone(), known.clone()], &|_| 0.5);
    assert!(mixed[0].payload("user")["cache_write_tokens"].is_null());
    assert_eq!(mixed[0].input_tokens, 20);
    assert_eq!(mixed[0].cached_tokens, 20);
    let before = aggregate_hour(HOUR, &[unknown.clone()], &|_| 0.5);
    unknown.cache_write_known = Some(true);
    let after = aggregate_hour(HOUR, &[unknown], &|_| 0.5);
    assert_ne!(fingerprint(&before), fingerprint(&after));
    assert_eq!(after[0].payload("user")["cache_write_tokens"], 0);
    known.cache_write_known = None;
    assert_eq!(
        aggregate_hour(HOUR, &[known], &|_| 0.5)[0].payload("user")["cache_write_tokens"],
        5
    );
}

#[test]
fn removed_import_hours_are_reuploaded_as_scan_only_and_then_released() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    // A scanned row already synced, and a magpie call it duplicates plus one
    // it doesn't, in another hour.
    insert_scan(&db_path, "dup", "s1", "2026-10-04 10:00:09", Some("user-a"));
    let at = |hour: u32, second: u32| {
        Local
            .with_ymd_and_hms(2026, 10, 4, hour, 0, second)
            .single()
            .unwrap()
            .with_timezone(&Utc)
            .to_rfc3339()
    };
    let magpie_dir = root.join("magpie");
    fs::create_dir_all(&magpie_dir).unwrap();
    let source = magpie_dir.join("usage.jsonl");
    let lines = [
        json!({"t": at(10, 10), "agent": "codex", "provider": "openai", "model": "gpt-5.5",
               "in": 200, "out": 80, "cache_read": 0, "cache_write": 0, "ms": 900,
               "status": 200, "session": "s1"}),
        json!({"t": at(12, 0), "agent": "codex", "provider": "openai", "model": "gpt-5.5",
               "in": 7, "out": 1, "cache_read": 0, "cache_write": 0, "ms": 100, "status": 200}),
    ];
    fs::write(
        &source,
        lines
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>(),
    )
    .unwrap();
    super::super::magpie_import::import_from(&db_path, &source).unwrap();

    let imported = collect_hours(&db_path, "user-a", "mac").unwrap();
    let first = plan(&imported, &load_state(&db_path), "user-a", "mac", &cost);
    assert_eq!(first.next_state.hours.len(), 2);
    save_state(&db_path, &first.next_state).unwrap();
    assert!(
        !gateway_overlay::accounting_present(&db_path),
        "an import-only install must not leave legacy-history evidence for the gateway"
    );
    assert_eq!(load_state(&db_path), first.next_state);
    let noon = "2026-10-04 12:00:00";
    let noon_key = format!("agg_mac_codex_gpt-5.5_{noon}");
    assert!(first.upserts.iter().any(|agg| agg.unique_key() == noon_key));

    super::super::magpie_import::clear(&db_path).unwrap();
    let cleared = collect_hours(&db_path, "user-a", "mac").unwrap();
    assert_eq!(
        cleared.keys().cloned().collect::<BTreeSet<_>>(),
        BTreeSet::from([HOUR.to_string(), noon.to_string()]),
        "hours uploaded with imported rows are recomputed after removal"
    );
    let second = plan(&cleared, &load_state(&db_path), "user-a", "mac", &cost);
    // 10:00 goes back to the scanned row alone; 12:00 had only the import.
    let ten = second
        .upserts
        .iter()
        .find(|agg| agg.hour == HOUR)
        .expect("10:00 is re-uploaded scan-only");
    assert_eq!((ten.requests, ten.gateway_requests), (1, 0));
    assert!(second.deletes.contains(&noon_key));
    assert!(
        second.next_state.hours.is_empty(),
        "scan-only hours are handed back to the plain aggregation"
    );
    save_state(&db_path, &second.next_state).unwrap();
    assert!(collect_hours(&db_path, "user-a", "mac").unwrap().is_empty());
    let _ = fs::remove_dir_all(root);
}
