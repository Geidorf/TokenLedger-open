use super::*;
use crate::commands::{
    default_prices, get_prices_impl, load_saved_prices_locked, reset_prices_impl, save_prices_impl,
};
use serde_json::json;
use std::path::PathBuf;
struct TestDir(PathBuf);
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn ledger() -> (TestDir, AppContext, PathBuf) {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = TestDir(std::env::temp_dir().join(format!(
        "tokenledger-price-recovery-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    )));
    let app = AppContext::for_test(dir.0.clone());
    let path = db::get_db_path(&app);
    db::init_test_db(&path).unwrap();
    let conn = db::get_connection(&path).unwrap();
    conn.execute_batch("INSERT INTO token_logs(tool,model,input_tokens,output_tokens,timestamp,session_id,unique_key,machine_id,cost_usd,sync_status,cloud_user_id)
        VALUES('claude','claude-sonnet-4',1000000,1000000,'2026-10-05 10:00:00','s','estimate','anonymous',1.0,1,'anonymous-user'),
        ('hermes','reported',10,1,'2026-10-05 10:00:00','s2','reported','anonymous',9.0,1,'anonymous-user');
        INSERT INTO local_stats_cache(scope,range_key,device_filter,data_json,updated_at) VALUES('local','all','','{}',0);").unwrap();
    (dir, app, path)
}
fn edited_prices() -> serde_json::Value {
    let mut prices = default_prices();
    prices["claude-sonnet-4"]["input"] = json!(11.25);
    prices
}
fn state(path: &Path) -> (Option<f64>, i64, i64) {
    db::get_connection(path)
        .unwrap()
        .query_row(
            "SELECT cost_usd,sync_status,sync_revision FROM token_logs WHERE unique_key='estimate'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
}
fn fail_reprice(path: &Path) {
    db::get_connection(path).unwrap().execute_batch("CREATE TRIGGER fail_reprice BEFORE UPDATE OF cost_usd ON token_logs WHEN OLD.tool='claude' BEGIN SELECT RAISE(ABORT,'anonymous injected failure'); END;").unwrap();
}
fn allow_reprice(path: &Path) {
    db::get_connection(path)
        .unwrap()
        .execute_batch("DROP TRIGGER fail_reprice")
        .unwrap();
}

#[test]
fn saved_file_db_failure_clears_cache_and_same_price_retry_recovers() {
    let (_dir, app, path) = ledger();
    fail_reprice(&path);
    let result = save_prices_impl(&app, edited_prices()).unwrap();
    assert_eq!(result["saved"], true);
    assert_eq!(result["repricing_pending"], true);
    assert!(result["warning"].as_str().unwrap().contains("价格已保存"));
    assert_eq!(
        load_saved_prices_locked(&app).0["claude-sonnet-4"]["input"],
        11.25
    );
    assert_eq!(state(&path).0, Some(1.0));
    assert!(app.app_data_dir().join(INTENT_FILE).exists());
    let conn = db::get_connection(&path).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM local_stats_cache", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    // Failure rolls back the completion receipt with the estimate update.
    assert!(conn
        .prepare("SELECT * FROM price_repricing_receipts")
        .is_err());
    allow_reprice(&path);
    let retry = save_prices_impl(&app, edited_prices()).unwrap();
    assert_eq!(retry["repricing_pending"], false);
    assert_eq!(retry["repriced"], 1);
    assert!(retry["warning"].is_null());
    assert_eq!(state(&path).0, None);
    assert_eq!(state(&path).1, 0);
    assert!(!app.app_data_dir().join(INTENT_FILE).exists());
    assert_eq!(
        conn.query_row(
            "SELECT cost_usd FROM token_logs WHERE unique_key='reported'",
            [],
            |r| r.get::<_, f64>(0)
        )
        .unwrap(),
        9.0
    );
}

#[test]
fn restart_price_load_recovers_and_new_edit_cannot_erase_pending_intent() {
    let (_dir, app, path) = ledger();
    fail_reprice(&path);
    save_prices_impl(&app, edited_prices()).unwrap();
    let old_intent = fs::read(app.app_data_dir().join(INTENT_FILE)).unwrap();
    let old_file = fs::read(app.app_data_dir().join(PRICE_OVERRIDES_FILE)).unwrap();
    let mut other = edited_prices();
    other["claude-sonnet-4"]["input"] = json!(15.0);
    assert!(save_prices_impl(&app, other).is_err());
    assert_eq!(
        fs::read(app.app_data_dir().join(INTENT_FILE)).unwrap(),
        old_intent
    );
    assert_eq!(
        fs::read(app.app_data_dir().join(PRICE_OVERRIDES_FILE)).unwrap(),
        old_file
    );
    allow_reprice(&path);
    let reopened = AppContext::for_test(app.app_data_dir().to_path_buf());
    let prices = get_prices_impl(&reopened).unwrap();
    assert_eq!(prices["claude-sonnet-4"]["input"], 11.25);
    assert_eq!(state(&path).0, None);
    assert!(!app.app_data_dir().join(INTENT_FILE).exists());
}

#[test]
fn prepared_but_failed_price_write_does_not_reprice_or_restore_external_edit() {
    let (_dir, app, path) = ledger();
    let target = b"{\"claude-sonnet-4\":{\"input\":11.25}}";
    let intent = prepare(app.app_data_dir(), Some(target)).unwrap();
    // An actual interrupted staged price write leaves the prepared intent
    // but never installs the new bytes.
    let io = crate::commands::PriceFilePersist {
        interrupt_after: Some(2),
        rename: crate::commands::replace_price_file,
    };
    assert!(crate::commands::persist_price_bytes(
        &app.app_data_dir().join(PRICE_OVERRIDES_FILE),
        target,
        &io
    )
    .is_err());
    assert!(!matches_current(app.app_data_dir(), &intent).unwrap());
    let recovery = recover(&app);
    assert!(!recovery.pending);
    assert_eq!(recovery.repriced, 0);
    assert_eq!(state(&path).0, Some(1.0));
    prepare(app.app_data_dir(), Some(target)).unwrap();
    let external = b"{\"claude-sonnet-4\":{\"input\":25}}";
    write_price_file(&app.app_data_dir().join(PRICE_OVERRIDES_FILE), external).unwrap();
    let recovery = recover(&app);
    assert_eq!(recovery.repriced, 0);
    assert!(recovery.warning.unwrap().contains("后续修改"));
    assert_eq!(
        fs::read(app.app_data_dir().join(PRICE_OVERRIDES_FILE)).unwrap(),
        external
    );
    assert_eq!(state(&path).0, Some(1.0));
}

#[test]
fn reset_absent_file_intent_recovers_after_database_failure() {
    let (_dir, app, path) = ledger();
    save_prices_impl(&app, edited_prices()).unwrap();
    db::get_connection(&path)
        .unwrap()
        .execute(
            "UPDATE token_logs SET cost_usd=2.0,sync_status=1 WHERE unique_key='estimate'",
            [],
        )
        .unwrap();
    fail_reprice(&path);
    let reset = reset_prices_impl(&app).unwrap();
    assert_eq!(reset["saved"], true);
    assert_eq!(reset["repricing_pending"], true);
    assert!(!app.app_data_dir().join(PRICE_OVERRIDES_FILE).exists());
    assert_eq!(state(&path).0, Some(2.0));
    allow_reprice(&path);
    let retry = reset_prices_impl(&app).unwrap();
    assert_eq!(retry["repricing_pending"], false);
    assert_eq!(retry["repriced"], 1);
    assert_eq!(state(&path).0, None);
}

#[test]
fn failed_intent_cleanup_retries_only_cleanup_without_revising_rows() {
    let (_dir, app, path) = ledger();
    let bytes = b"{\"claude-sonnet-4\":{\"input\":11.25}}";
    prepare(app.app_data_dir(), Some(bytes)).unwrap();
    write_price_file(&app.app_data_dir().join(PRICE_OVERRIDES_FILE), bytes).unwrap();
    let fail = |_: &Path| Err("anonymous cleanup failure".to_string());
    let first = recover_with_cleanup(&app, &fail);
    assert_eq!(first.repriced, 1);
    assert!(!first.pending);
    assert!(first.warning.unwrap().contains("仅重试清理"));
    let revision = state(&path).2;
    // Even newly inserted rows must not be swept by an already-completed intent.
    db::get_connection(&path).unwrap().execute("INSERT INTO token_logs(tool,model,input_tokens,output_tokens,timestamp,session_id,unique_key,cost_usd) VALUES('claude','new',1,1,'2026-10-05 11:00:00','new','new',8.0)",[]).unwrap();
    let second = recover_with_cleanup(&app, &fail);
    assert_eq!(second.repriced, 0);
    assert_eq!(state(&path).2, revision);
    let third = recover(&app);
    assert_eq!(third.repriced, 0);
    assert!(!app.app_data_dir().join(INTENT_FILE).exists());
    assert_eq!(
        db::get_connection(&path)
            .unwrap()
            .query_row(
                "SELECT cost_usd FROM token_logs WHERE unique_key='new'",
                [],
                |r| r.get::<_, f64>(0)
            )
            .unwrap(),
        8.0
    );
}

#[test]
fn pending_same_numeric_prices_do_not_require_identical_json_serialization() {
    let (_dir, app, path) = ledger();
    fail_reprice(&path);
    let mut prices = edited_prices();
    prices["claude-sonnet-4"]["input"] = json!(12.0);
    assert_eq!(
        save_prices_impl(&app, prices.clone()).unwrap()["repricing_pending"],
        true
    );
    let before = fs::read(app.app_data_dir().join(PRICE_OVERRIDES_FILE)).unwrap();
    prices["claude-sonnet-4"]["input"] = json!(12);
    let retry = save_prices_impl(&app, prices).unwrap();
    assert_eq!(retry["saved"], true);
    assert_eq!(retry["repricing_pending"], true);
    assert_eq!(
        fs::read(app.app_data_dir().join(PRICE_OVERRIDES_FILE)).unwrap(),
        before
    );
    assert_eq!(state(&path).0, Some(1.0));
}
