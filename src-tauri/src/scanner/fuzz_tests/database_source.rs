use super::{ledger_after, persist, totals, Scan, Shape, Target, TempDir, Totals};
use crate::scanner::checkpoints::SourceCursorMap;
use crate::scanner::goose::scan_goose_db;
use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const COLUMNS: [&str; 10] = [
    "id",
    "session_id",
    "created_timestamp",
    "model",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "cost",
    "cost_source",
];

fn seed() -> Vec<Value> {
    vec![json!([
        {"id":1,"session_id":"ledger-fixture","created_timestamp":1760000000,
         "model":"fixture-model","input_tokens":100,"output_tokens":20,
         "cache_read_tokens":40,"cache_write_tokens":10,
         "cost":0.125,"cost_source":"provider_reported"},
        {"id":2,"session_id":"ledger-fixture","created_timestamp":1760000060,
         "model":"fixture-model","input_tokens":150,"output_tokens":30,
         "cache_read_tokens":60,"cache_write_tokens":15,
         "cost":0.4,"cost_source":"estimated"},
        {"id":3,"session_id":"ledger-fixture","created_timestamp":1760000120,
         "model":"fixture-model","input_tokens":10,"output_tokens":5,
         "cache_read_tokens":20,"cache_write_tokens":0,
         "cost":null,"cost_source":null}
    ])]
}

fn source_path(root: &Path) -> PathBuf {
    root.join("sessions").join("sessions.db")
}

fn sql_value(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(value) => SqlValue::Integer(i64::from(*value)),
        Value::Number(value) => value
            .as_i64()
            .map(SqlValue::Integer)
            .unwrap_or_else(|| SqlValue::Real(value.as_f64().expect("JSON number"))),
        Value::String(value) => SqlValue::Text(value.clone()),
        Value::Array(_) | Value::Object(_) => {
            SqlValue::Blob(serde_json::to_vec(value).expect("serialize synthetic cell"))
        }
    }
}

fn write_database(root: &Path, bytes: &[u8]) {
    let path = source_path(root);
    fs::create_dir_all(path.parent().unwrap()).expect("create synthetic database directory");
    let Ok(Value::Array(rows)) = serde_json::from_slice::<Value>(bytes) else {
        fs::write(path, bytes).expect("write malformed database fixture");
        return;
    };
    let conn = Connection::open(path).expect("create synthetic database");
    // Keep mutated SQL types intact for the production decoder.
    conn.execute_batch(
        "CREATE TABLE usage_ledger (
            id, session_id, created_timestamp, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost, cost_source)",
    )
    .expect("create synthetic ledger");
    let mut insert = conn
        .prepare("INSERT INTO usage_ledger VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)")
        .expect("prepare synthetic row");
    for row in rows {
        let values = COLUMNS.map(|column| sql_value(&row[column]));
        insert
            .execute(params_from_iter(values))
            .expect("insert synthetic row");
    }
}

fn scan_database(root: &Path) -> Scan {
    let mut scan = Scan::default();
    scan_goose_db(
        &source_path(root),
        &mut scan.logs,
        &SourceCursorMap::new(),
        &mut Vec::new(),
    );
    scan
}

pub(super) fn target() -> Target {
    Target {
        name: "local-usage-db",
        shape: Shape::Document,
        seed,
        write: write_database,
        scan: scan_database,
        stable_ids: true,
        order_free: true,
    }
}

fn expected_totals() -> Totals {
    Totals {
        rows: 3,
        input: 135,
        output: 55,
        cached: 145,
    }
}

#[test]
fn database_seed_preserves_net_input_cache_split_and_rescan_totals() {
    let bytes = serde_json::to_vec(&seed()[0]).unwrap();
    assert_eq!(ledger_after(&target(), &bytes).unwrap(), expected_totals());

    let source = TempDir::new("database_seed");
    write_database(&source.0, &bytes);
    let scan = scan_database(&source.0);
    assert_eq!(scan.logs.len(), 3);
    assert_eq!(
        scan.logs
            .iter()
            .map(|row| row.cache_write_tokens)
            .collect::<Vec<_>>(),
        vec![10, 15, 0]
    );
    assert_eq!(scan.logs[0].cost_usd, Some(0.125));
    assert_eq!(scan.logs[1].cost_usd, None);
    let ledger = source.0.join("ledger.db");
    crate::db::init_test_db(&ledger).unwrap();
    persist(&ledger, scan).unwrap();
    let writes: i64 = crate::db::get_connection(&ledger)
        .unwrap()
        .query_row(
            "SELECT SUM(cache_write_tokens) FROM token_logs",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(writes, 25);
}

#[test]
fn repeated_and_reordered_database_rows_keep_the_same_ledger() {
    let rows = seed()[0].as_array().unwrap().clone();
    let mut repeated = rows.clone();
    repeated.extend(rows.iter().cloned());
    repeated.reverse();
    assert_eq!(
        ledger_after(&target(), &serde_json::to_vec(&repeated).unwrap()).unwrap(),
        expected_totals()
    );
}

#[test]
fn bad_database_column_types_leave_the_failed_row_for_repair() {
    for invalid in [json!("invalid-counter"), json!(12.5), json!([1, 2])] {
        let source = TempDir::new("database_repair");
        let mut rows = seed().remove(0);
        rows[1]["output_tokens"] = invalid;
        write_database(&source.0, &serde_json::to_vec(&rows).unwrap());

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        assert_eq!(
            scan_goose_db(
                &source_path(&source.0),
                &mut logs,
                &SourceCursorMap::new(),
                &mut pending,
            ),
            1
        );
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].cursor_primary, "1");
        let cursors: SourceCursorMap = pending
            .drain(..)
            .map(|cursor| {
                (
                    (cursor.source_kind.clone(), cursor.source_path.clone()),
                    cursor,
                )
            })
            .collect();
        Connection::open(source_path(&source.0))
            .unwrap()
            .execute("UPDATE usage_ledger SET output_tokens=30 WHERE id=2", [])
            .unwrap();
        assert_eq!(
            scan_goose_db(&source_path(&source.0), &mut logs, &cursors, &mut pending,),
            2
        );
        assert_eq!(pending[0].cursor_primary, "3");
        let ledger = source.0.join("ledger.db");
        crate::db::init_test_db(&ledger).unwrap();
        persist(
            &ledger,
            Scan {
                logs,
                ..Scan::default()
            },
        )
        .unwrap();
        assert_eq!(totals(&ledger).unwrap(), expected_totals());
    }
}

#[test]
fn corrupt_database_files_do_not_panic_or_advance_a_cursor() {
    let valid = TempDir::new("database_truncation");
    write_database(&valid.0, &serde_json::to_vec(&seed()[0]).unwrap());
    let mut truncated = fs::read(source_path(&valid.0)).unwrap();
    truncated.truncate(truncated.len() / 2);
    for bytes in [
        Vec::new(),
        vec![0u8; 64],
        b"malformed source".to_vec(),
        truncated,
    ] {
        let source = TempDir::new("database_corrupt");
        let path = source_path(&source.0);
        super::write_file(&path, &bytes);
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        assert_eq!(
            scan_goose_db(&path, &mut logs, &SourceCursorMap::new(), &mut pending),
            0
        );
        assert!(logs.is_empty());
        assert!(pending.is_empty());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}
