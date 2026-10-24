use super::*;
use crate::gateway::{MemorySecrets, SecretStore, WireApi};
use rusqlite::params;
use std::sync::atomic::{AtomicUsize, Ordering};

/// The lowest count a sealed file may name; keeps debug-build tests quick.
const FAST: u32 = 100_000;
const PASSPHRASE: &str = "correct horse battery";

static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Computer {
    root: PathBuf,
    app: AppContext,
    gateway: Gateway,
}

impl Computer {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "tokenledger_local_backup_{}_{}_{name}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&root);
        let app = AppContext::for_test(root.join("app"));
        db::init_test_db(&db::get_db_path(&app)).unwrap();
        let gateway = Gateway::new(
            &app.app_data_dir().join("gateway"),
            Arc::new(MemorySecrets::default()),
            0,
        );
        Self { root, app, gateway }
    }

    fn conn(&self) -> Connection {
        db::get_connection(&db::get_db_path(&self.app)).unwrap()
    }

    fn insert(&self, key: &str, input: i64) {
        self.conn()
            .execute(
                "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens,
                     cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, sync_status)
                 VALUES ('claude', 'claude-sonnet-5', ?1, 10, 0, 0, '2026-10-20 10:00:00', 's1', ?2, 0.5, ?3, 1)",
                params![input, key, crate::commands::local_machine_id(&self.app)],
            )
            .unwrap();
    }

    fn rows(&self) -> i64 {
        self.conn()
            .query_row("SELECT COUNT(*) FROM token_logs", [], |row| row.get(0))
            .unwrap()
    }

    fn input_of(&self, key: &str) -> i64 {
        self.conn()
            .query_row(
                "SELECT input_tokens FROM token_logs WHERE unique_key = ?1",
                [key],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn export(&self) -> Bundle {
        collect(&self.app, &self.gateway).unwrap()
    }
}

impl Drop for Computer {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn provider(id: &str, base_url: &str) -> ProviderRecord {
    ProviderRecord {
        id: id.to_string(),
        name: format!("{id} name"),
        base_url: base_url.to_string(),
        wire: WireApi::Chat,
        auth_mode: AuthMode::Key,
        models: vec!["model-a".to_string()],
        enabled: true,
    }
}

fn group(id: &str, members: &[&str]) -> RoutingGroup {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "strategy": "failover",
        "members": members,
    }))
    .unwrap()
}

fn budget_rule(id: &str, limit: f64) -> BudgetRule {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "period": "day",
        "metric": "cost",
        "scopeKind": "all",
        "limit": limit,
    }))
    .unwrap()
}

fn request(id: &str, input: u64) -> LedgerRecord {
    LedgerRecord {
        ts: "2026-10-20T02:00:00Z".to_string(),
        request_id: id.to_string(),
        logical_request_id: Some(format!("logical-{id}")),
        agent: Some("codex".to_string()),
        session: Some("s1".to_string()),
        endpoint: "/v1/chat/completions".to_string(),
        provider: "p1".to_string(),
        requested_model: "p1/model-a".to_string(),
        upstream_model: "model-a".to_string(),
        wire: "chat".to_string(),
        stream: false,
        status: 200,
        ok: true,
        input,
        output: 5,
        cache_read: 0,
        cache_write: 0,
        latency_ms: 120,
        first_token_ms: None,
        error: None,
        group: None,
        member: None,
        context: None,
    }
}

fn everything() -> Sections {
    Sections {
        ledger: true,
        gateway_requests: true,
        settings: true,
        budgets: true,
        providers: true,
        routing_groups: true,
        prices: true,
        quota_alerts: true,
    }
}

fn sealed_roundtrip(bundle: &Bundle) -> Bundle {
    let sealed = seal_bundle(bundle, PASSPHRASE, FAST).unwrap();
    open_bundle(&sealed, PASSPHRASE).unwrap()
}

#[test]
fn a_backup_carries_no_secret() {
    let old = Computer::new("old");
    old.gateway
        .upsert_provider(provider("p1", "https://api.example.com/v1"))
        .unwrap();
    old.gateway
        .set_provider_key(SetProviderKeyInput {
            id: "p1".to_string(),
            key: "sk-secret-value-1234".to_string(),
        })
        .unwrap();
    let sealed = seal_bundle(&old.export(), PASSPHRASE, FAST).unwrap();
    let plain = String::from_utf8_lossy(&sealed).to_string();
    assert!(!plain.contains("sk-secret"));
    let bundle = open_bundle(&sealed, PASSPHRASE).unwrap();
    let json = serde_json::to_string(&bundle).unwrap();
    assert!(!json.contains("sk-secret-value-1234"));
    assert_eq!(bundle.providers.len(), 1);
}

#[test]
fn restore_merges_rows_by_unique_key_and_adds_setup() {
    let old = Computer::new("old");
    old.insert("k1", 100);
    old.insert("k2", 200);
    old.insert("k3", 300);
    old.gateway
        .upsert_provider(provider("p1", "https://api.example.com/v1"))
        .unwrap();
    old.gateway
        .upsert_routing_group(group("coding", &["p1/model-a"]))
        .unwrap();
    budget::save_settings(
        old.app.app_data_dir(),
        &BudgetSettings {
            sync_to_phone: false,
            notify: true,
            rules: vec![budget_rule("daily", 5.0)],
        },
    )
    .unwrap();
    accounting::import(
        old.gateway.dir(),
        &[request("r1", 50), request("r2", 60)],
        None,
    )
    .unwrap();
    let mut bundle = sealed_roundtrip(&old.export());

    let new = Computer::new("new");
    // The same computer after a reinstall that kept its device id.
    bundle.machine = crate::commands::local_machine_id(&new.app);
    // The new computer already scanned one of the same calls, differently.
    new.insert("k2", 999);
    accounting::import(new.gateway.dir(), &[request("r2", 60)], None).unwrap();

    let plan = preview(&new.app, &new.gateway, &bundle, "d".into()).unwrap();
    assert_eq!(
        (plan.ledger.total, plan.ledger.new, plan.ledger.known),
        (3, 2, 1)
    );
    assert_eq!(plan.gateway_requests.new, 1);
    assert_eq!(plan.providers[0].status, ItemStatus::New);
    assert_eq!(plan.providers_without_key, vec!["p1".to_string()]);
    assert_eq!(plan.routing_groups[0].status, ItemStatus::New);
    assert_eq!(plan.budgets[0].status, ItemStatus::New);

    let result = apply(
        &new.app,
        &new.gateway,
        &bundle,
        &everything(),
        Conflict::KeepLocal,
    )
    .unwrap();
    assert_eq!(result.ledger_added, 2);
    assert_eq!(result.gateway_added, 1);
    assert_eq!(result.providers_added, 1);
    assert_eq!(result.providers_need_key, vec!["p1".to_string()]);
    assert_eq!(result.groups_added, 1);
    assert_eq!(result.budgets_added, 1);
    assert!(Path::new(&result.snapshot).join("tokenboard.db").is_file());
    assert_eq!(new.rows(), 3);
    // A row this computer already had always wins.
    assert_eq!(new.input_of("k2"), 999);
    assert_eq!(new.gateway.list_routing_groups().len(), 1);
    assert_eq!(budget::load_settings(new.app.app_data_dir()).rules.len(), 1);

    // Restoring the same backup again adds nothing.
    let again = apply(
        &new.app,
        &new.gateway,
        &bundle,
        &everything(),
        Conflict::KeepLocal,
    )
    .unwrap();
    assert_eq!((again.ledger_added, again.gateway_added), (0, 0));
    assert_eq!((again.providers_added, again.providers_replaced), (0, 0));
    assert_eq!(new.rows(), 3);
    let after = preview(&new.app, &new.gateway, &bundle, "d".into()).unwrap();
    assert_eq!(after.ledger.new, 0);
    assert_eq!(after.providers[0].status, ItemStatus::Same);
}

#[test]
fn conflicts_keep_local_unless_the_backup_should_win() {
    let old = Computer::new("old");
    old.gateway
        .upsert_provider(provider("p1", "https://other.example.org/v1"))
        .unwrap();
    budget::save_settings(
        old.app.app_data_dir(),
        &BudgetSettings {
            sync_to_phone: false,
            notify: false,
            rules: vec![budget_rule("daily", 9.0)],
        },
    )
    .unwrap();
    let bundle = old.export();

    let new = Computer::new("new");
    new.gateway
        .upsert_provider(provider("p1", "https://api.example.com/v1"))
        .unwrap();
    new.gateway
        .set_provider_key(SetProviderKeyInput {
            id: "p1".to_string(),
            key: "sk-local-key-5678".to_string(),
        })
        .unwrap();
    budget::save_settings(
        new.app.app_data_dir(),
        &BudgetSettings {
            sync_to_phone: false,
            notify: true,
            rules: vec![budget_rule("daily", 3.0)],
        },
    )
    .unwrap();

    let kept = apply(
        &new.app,
        &new.gateway,
        &bundle,
        &everything(),
        Conflict::KeepLocal,
    )
    .unwrap();
    assert_eq!((kept.providers_replaced, kept.budgets_replaced), (0, 0));
    assert_eq!(
        budget::load_settings(new.app.app_data_dir()).rules[0].limit,
        3.0
    );

    let replaced = apply(
        &new.app,
        &new.gateway,
        &bundle,
        &everything(),
        Conflict::UseBackup,
    )
    .unwrap();
    assert_eq!(
        (replaced.providers_replaced, replaced.budgets_replaced),
        (1, 1)
    );
    assert_eq!(
        budget::load_settings(new.app.app_data_dir()).rules[0].limit,
        9.0
    );
    let views = new.gateway.list_providers().unwrap();
    assert_eq!(views[0].record.base_url, "https://other.example.org/v1");
    // The local key was for another host and does not follow the address.
    assert!(!views[0].has_key);
    assert_eq!(replaced.providers_need_key, vec!["p1".to_string()]);
}

#[test]
fn settings_keep_what_belongs_to_this_computer() {
    let old = Computer::new("old");
    let mut settings = AppSettings {
        scan_interval_secs: 1800,
        autostart_enabled: true,
        model_access_enabled: true,
        quota_claude_enabled: true,
        ..AppSettings::default()
    };
    settings.codex_extra_dirs = vec!["~/work/codex-home".to_string()];
    settings::save_settings_file(&old.app, &settings).unwrap();
    let bundle = old.export();

    let new = Computer::new("new");
    let mut local = AppSettings {
        scan_interval_secs: 900,
        autostart_enabled: false,
        model_access_enabled: false,
        ..AppSettings::default()
    };
    local.desktop_widget_position = Some((10, 20));
    settings::save_settings_file(&new.app, &local).unwrap();

    let plan = preview(&new.app, &new.gateway, &bundle, "d".into()).unwrap();
    assert_eq!(plan.settings, Some(ItemStatus::Differs));
    let sections = Sections {
        settings: true,
        ..Sections::default()
    };
    let result = apply(
        &new.app,
        &new.gateway,
        &bundle,
        &sections,
        Conflict::KeepLocal,
    )
    .unwrap();
    assert!(result.settings_restored && result.restart_suggested);
    let restored = settings::load_settings_result(&new.app).unwrap();
    assert_eq!(restored.scan_interval_secs, 1800);
    assert_eq!(
        restored.codex_extra_dirs,
        vec!["~/work/codex-home".to_string()]
    );
    assert!(!restored.autostart_enabled);
    assert!(!restored.model_access_enabled);
    assert!(!restored.quota_claude_enabled);
    assert_eq!(restored.desktop_widget_position, Some((10, 20)));
}

#[test]
fn only_the_picked_sections_are_restored() {
    let old = Computer::new("old");
    old.insert("k1", 1);
    old.gateway
        .upsert_provider(provider("p1", "https://api.example.com/v1"))
        .unwrap();
    let bundle = old.export();
    let new = Computer::new("new");
    let sections = Sections {
        providers: true,
        ..Sections::default()
    };
    let result = apply(
        &new.app,
        &new.gateway,
        &bundle,
        &sections,
        Conflict::KeepLocal,
    )
    .unwrap();
    assert_eq!(result.ledger_added, 0);
    assert_eq!(new.rows(), 0);
    assert_eq!(new.gateway.list_providers().unwrap().len(), 1);
}

#[test]
fn bad_passphrases_and_foreign_files_are_refused() {
    let old = Computer::new("old");
    let sealed = seal_bundle(&old.export(), PASSPHRASE, FAST).unwrap();
    assert_eq!(
        open_bundle(&sealed, "wrong passphrase").unwrap_err(),
        "备份密码不对，或文件已被改动。"
    );
    assert!(seal_bundle(&old.export(), "short", FAST).is_err());
    assert_eq!(
        open_bundle(b"id,tool\n1,claude\n", PASSPHRASE).unwrap_err(),
        "这个文件不是 TokenLedger 备份。"
    );
    // The external gateway's own backups share the envelope, not the format.
    let foreign = seal::seal(b"{}", PASSPHRASE, seal::BACKUP_FORMAT, FAST).unwrap();
    assert_eq!(
        open_bundle(&foreign, PASSPHRASE).unwrap_err(),
        "这个文件不是 TokenLedger 备份。"
    );
    let mut tampered = String::from_utf8(sealed).unwrap();
    tampered = tampered.replace("\"iterations\":100000", "\"iterations\":100001");
    assert!(open_bundle(tampered.as_bytes(), PASSPHRASE).is_err());
}

#[test]
fn a_newer_backup_schema_is_refused() {
    let old = Computer::new("old");
    let mut bundle = old.export();
    bundle.schema = SCHEMA + 1;
    let sealed = seal_bundle(&bundle, PASSPHRASE, FAST).unwrap();
    assert!(open_bundle(&sealed, PASSPHRASE)
        .unwrap_err()
        .contains("更新版本"));
}

#[test]
fn exports_are_listed_newest_first_and_auto_backups_pruned() {
    let old = Computer::new("old");
    let dir = old.root.join("backups");
    let first = export_to(
        &old.app,
        &old.gateway,
        &dir,
        "TokenLedger-",
        PASSPHRASE,
        FAST,
    )
    .unwrap();
    assert!(first.path.ends_with(".tlbackup"));
    for index in 0..4 {
        fs::write(
            dir.join(format!(
                "{}20261001-00000{index}.{EXTENSION}",
                auto::computer_prefix(&old.app)
            )),
            b"x",
        )
        .unwrap();
    }
    assert_eq!(auto::prune(&dir, &auto::computer_prefix(&old.app), 2), 2);
    let names: Vec<String> = list_files(&dir)
        .unwrap()
        .into_iter()
        .map(|file| file.name)
        .collect();
    assert_eq!(names.len(), 3);
    assert!(names.iter().any(|name| name.ends_with("000003.tlbackup")));
    assert!(!names.iter().any(|name| name.ends_with("000000.tlbackup")));
    // A manual export is never pruned.
    assert!(Path::new(&first.path).exists());
}

#[test]
fn scheduled_backup_needs_a_passphrase_and_records_its_run() {
    let old = Computer::new("old");
    let secrets = MemorySecrets::default();
    let dir = old.root.join("auto");
    let input = |enabled: bool, passphrase: Option<&str>| auto::SaveAutoInput {
        enabled,
        dir: dir.to_string_lossy().to_string(),
        interval_hours: 24,
        keep: 3,
        passphrase: passphrase.map(str::to_string),
    };
    assert!(auto::save(&old.app, &secrets, input(true, None)).is_err());
    let view = auto::save(&old.app, &secrets, input(true, Some(PASSPHRASE))).unwrap();
    assert!(view.has_passphrase && view.config.enabled);
    assert_eq!(
        secrets.get(PASSPHRASE_ACCOUNT).unwrap().as_deref(),
        Some(PASSPHRASE)
    );

    let path = auto::run_now(&old.app, &old.gateway, &secrets, FAST).unwrap();
    assert!(path.contains(&auto::computer_prefix(&old.app)));
    let config = auto::load(&old.app);
    assert_eq!(config.last_file.as_deref(), Some(path.as_str()));
    assert!(config.last_error.is_none());
    // Not due again until the interval has passed.
    auto::run_if_due(&old.app, &old.gateway, &secrets);
    assert_eq!(list_files(&dir).unwrap().len(), 1);
}

fn corrupt_middle_pages(path: &Path) {
    let mut bytes = fs::read(path).unwrap();
    let page = 4096;
    let pages = bytes.len() / page;
    assert!(pages > 6, "need a database with several pages");
    for index in (pages / 2)..(pages / 2 + 2) {
        for byte in &mut bytes[index * page..(index + 1) * page] {
            *byte = 0xAB;
        }
    }
    fs::write(path, bytes).unwrap();
}

#[test]
fn a_damaged_ledger_is_rebuilt_from_readable_rows() {
    let pc = Computer::new("pc");
    let conn = pc.conn();
    for index in 0..3000 {
        conn.execute(
            "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens,
                 cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, sync_status)
             VALUES ('claude', 'claude-sonnet-5', ?1, 10, 0, 0, '2026-10-20 10:00:00', 's1', ?2, 0.5, 'pc', 1)",
            params![index, format!("unique-key-with-some-length-{index:08}")],
        )
        .unwrap();
    }
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    drop(conn);
    let db_path = db::get_db_path(&pc.app);
    corrupt_middle_pages(&db_path);

    let gateway_dir = pc.gateway.dir().to_path_buf();
    let report = health::check(&pc.app, &gateway_dir);
    assert!(!report.ok && !report.ledger.problems.is_empty());

    let outcome = health::repair(&pc.app, &gateway_dir).unwrap();
    if outcome.fixed {
        // Only index pages were hit; REINDEX was enough.
        return;
    }
    assert!(outcome.restart_required && outcome.report.repair_pending);
    health::run_pending(&pc.app, &db_path);
    let after = health::check(&pc.app, &gateway_dir);
    assert!(after.ledger.ok, "{:?}", after.ledger.problems);
    assert!(!after.repair_pending);
    let notice = after.last_repair.unwrap();
    assert!(
        notice.rows_recovered > 1000 && notice.rows_recovered <= 3000,
        "{notice:?} {:?}",
        report.ledger.problems
    );
    assert!(Path::new(&notice.damaged_copy).exists());
    assert_eq!(pc.rows(), notice.rows_recovered);
}

#[test]
fn a_ledger_that_does_not_open_is_rebuilt_at_start() {
    let pc = Computer::new("pc");
    let db_path = db::get_db_path(&pc.app);
    fs::write(&db_path, vec![0x5Au8; 64 * 1024]).unwrap();
    let error = db::init_test_db(&db_path).unwrap_err();
    assert!(health::is_corruption(&error));
    // Startup only schedules it; the primary instance rebuilds in setup.
    health::schedule_rebuild(&pc.app, true).unwrap();
    assert!(db::init_test_db(&db_path).is_err());
    health::run_pending(&pc.app, &db_path);
    db::init_test_db(&db_path).unwrap();
    assert_eq!(pc.rows(), 0);
    let notice = health::last_repair(&pc.app).unwrap();
    assert!(notice.automatic);
}

/// Overwrites the rightmost leaf page of `table`, the one `max(rowid)` reads.
fn corrupt_rightmost_leaf(path: &Path, table: &str) {
    let conn = Connection::open(path).unwrap();
    let page_size: usize = conn
        .query_row("PRAGMA page_size", [], |row| row.get::<_, i64>(0))
        .unwrap() as usize;
    let mut page: usize = conn
        .query_row(
            "SELECT rootpage FROM sqlite_master WHERE name = ?1",
            [table],
            |row| row.get::<_, i64>(0),
        )
        .unwrap() as usize;
    drop(conn);
    let mut bytes = fs::read(path).unwrap();
    loop {
        let start = (page - 1) * page_size + if page == 1 { 100 } else { 0 };
        match bytes[start] {
            0x05 => {
                page =
                    u32::from_be_bytes(bytes[start + 8..start + 12].try_into().unwrap()) as usize;
            }
            0x0D => break,
            other => panic!("unexpected page type {other:#x}"),
        }
    }
    for byte in &mut bytes[(page - 1) * page_size..page * page_size] {
        *byte = 0xAB;
    }
    fs::write(path, bytes).unwrap();
}

#[test]
fn salvage_reads_on_when_the_last_rowid_is_unreadable() {
    // With and without the AUTOINCREMENT record of the highest rowid.
    for forget_sequence in [false, true] {
        let pc = Computer::new("pc");
        let conn = pc.conn();
        for index in 0..3000 {
            conn.execute(
                "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens,
                     cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, sync_status)
                 VALUES ('claude', 'claude-sonnet-5', ?1, 10, 0, 0, '2026-10-20 10:00:00', 's1', ?2, 0.5, 'pc', 1)",
                params![index, format!("unique-key-{index:08}")],
            )
            .unwrap();
        }
        if forget_sequence {
            conn.execute("DELETE FROM sqlite_sequence", []).unwrap();
        }
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
        drop(conn);
        let db_path = db::get_db_path(&pc.app);
        corrupt_rightmost_leaf(&db_path, "token_logs");
        let probe = Connection::open(&db_path).unwrap();
        assert!(probe
            .query_row("SELECT max(rowid) FROM token_logs", [], |row| row
                .get::<_, Option<i64>>(0))
            .is_err());
        drop(probe);

        let target = pc.root.join("salvaged.db");
        let report = health::salvage(&db_path, &target).unwrap();
        assert!(
            report.rows_recovered > 2500 && report.rows_recovered < 3000,
            "{forget_sequence} {report:?}"
        );
    }
}

#[test]
fn a_rebuilt_ledger_queues_no_cloud_purge_the_damaged_one_did_not() {
    let purges = |path: &Path| -> i64 {
        Connection::open(path)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM pending_cloud_purges", [], |row| {
                row.get(0)
            })
            .unwrap()
    };
    let pc = Computer::new("pc");
    pc.insert("synced", 100);
    pc.conn()
        .execute("DELETE FROM pending_cloud_purges", [])
        .unwrap();
    let db_path = db::get_db_path(&pc.app);
    let target = pc.root.join("rebuilt.db");
    health::salvage(&db_path, &target).unwrap();
    assert_eq!(purges(&target), 0);
    let rows: i64 = Connection::open(&target)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM token_logs", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 1);
    // A file that does not open at all leaves an empty ledger, without
    // migration-made purges either.
    let garbage = pc.root.join("garbage.db");
    fs::write(&garbage, b"not a database at all").unwrap();
    let empty = pc.root.join("empty.db");
    health::salvage(&garbage, &empty).unwrap();
    assert_eq!(purges(&empty), 0);
}

#[test]
fn cumulative_scan_state_travels_with_the_ledger() {
    let state = |pc: &Computer, key: &str| -> Option<(i64, i64)> {
        pc.conn()
            .query_row(
                "SELECT input_tokens, generation FROM scan_cumulative_state WHERE unique_key = ?1",
                [key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok()
    };
    let put = |pc: &Computer, key: &str, input: i64, generation: i64| {
        pc.conn()
            .execute(
                "INSERT OR REPLACE INTO scan_cumulative_state
                     (unique_key, input_tokens, output_tokens, cached_tokens, cache_write_tokens, cost_usd, generation)
                 VALUES (?1, ?2, 0, 0, 0, NULL, ?3)",
                params![key, input, generation],
            )
            .unwrap();
    };
    let old = Computer::new("old");
    old.insert("k1", 100);
    put(&old, "src-a", 50, 2);
    put(&old, "src-b", 70, 1);
    put(&old, "src-c", 90, 3);
    put(&old, "src-d", 80, 0);
    put(&old, "src-e", 5, 0);
    let bundle = sealed_roundtrip(&old.export());
    assert_eq!(bundle.scan_cumulative.rows.len(), 5);

    let new = Computer::new("new");
    put(&new, "src-b", 10, 4);
    put(&new, "src-c", 20, 1);
    put(&new, "src-d", 30, 0);
    apply(
        &new.app,
        &new.gateway,
        &bundle,
        &everything(),
        Conflict::KeepLocal,
    )
    .unwrap();
    // Missing keys come in; a later generation wins either way.
    assert_eq!(state(&new, "src-a"), Some((50, 2)));
    assert_eq!(state(&new, "src-b"), Some((10, 4)));
    assert_eq!(state(&new, "src-c"), Some((90, 3)));
    // Same generation: the higher baseline wins, whichever side has it.
    assert_eq!(state(&new, "src-d"), Some((80, 0)));
    put(&new, "src-e", 40, 0);
    apply(
        &new.app,
        &new.gateway,
        &bundle,
        &everything(),
        Conflict::KeepLocal,
    )
    .unwrap();
    assert_eq!(state(&new, "src-e"), Some((40, 0)));
}

#[test]
fn gateway_requests_restore_only_onto_the_computer_that_made_them() {
    let old = Computer::new("old");
    accounting::import(old.gateway.dir(), &[request("r1", 50)], None).unwrap();
    let mut bundle = sealed_roundtrip(&old.export());

    let new = Computer::new("new");
    // Another data folder has another device id.
    let plan = preview(&new.app, &new.gateway, &bundle, "d".into()).unwrap();
    assert!(!plan.same_machine);
    bundle.machine = crate::commands::local_machine_id(&new.app);
    let plan = preview(&new.app, &new.gateway, &bundle, "d".into()).unwrap();
    assert!(plan.same_machine && plan.gateway_requests_restorable);
    // A backup made before the device id names the host this ledger was
    // migrated from.
    crate::device_identity::migrate_local(
        &new.conn(),
        "old-host-name",
        &crate::commands::local_machine_id(&new.app),
    )
    .unwrap();
    bundle.machine = "old-host-name".to_string();
    let plan = preview(&new.app, &new.gateway, &bundle, "d".into()).unwrap();
    assert!(plan.same_machine && plan.gateway_requests_restorable);

    bundle.machine = "another-computer".to_string();
    let plan = preview(&new.app, &new.gateway, &bundle, "d".into()).unwrap();
    assert!(!plan.same_machine && !plan.gateway_requests_restorable);
    let result = apply(
        &new.app,
        &new.gateway,
        &bundle,
        &everything(),
        Conflict::KeepLocal,
    )
    .unwrap();
    assert_eq!(result.gateway_added, 0);
    assert!(accounting::read_all(new.gateway.dir()).unwrap().is_empty());
}

#[test]
fn restored_gateway_hours_never_overwrite_cloud_history() {
    let old = Computer::new("old");
    accounting::import(
        old.gateway.dir(),
        &[request("r1", 50)],
        Some("2026-10-21T00:00:00+00:00"),
    )
    .unwrap();
    let mut bundle = sealed_roundtrip(&old.export());
    assert_eq!(
        bundle
            .gateway_coverage
            .as_ref()
            .and_then(|coverage| coverage.complete_from_utc.as_deref()),
        Some("2026-10-21T00:00:00+00:00")
    );
    // Even a source with complete history: the backup is a snapshot, and
    // that computer may have uploaded more for those hours since.
    bundle.gateway_coverage = Some(GatewayCoverage::default());
    bundle.created = "2026-10-22T00:00:00Z".to_string();

    let new = Computer::new("new");
    bundle.machine = crate::commands::local_machine_id(&new.app);
    apply(
        &new.app,
        &new.gateway,
        &bundle,
        &everything(),
        Conflict::KeepLocal,
    )
    .unwrap();
    let coverage = accounting::coverage_of(new.gateway.dir()).unwrap().unwrap();
    assert_eq!(
        coverage.complete_from_utc.as_deref(),
        Some("2026-10-22T00:00:00Z")
    );
    assert!(!coverage.hour_is_complete("2026-10-20 10:00:00"));

    // A later boundary already here is kept.
    bundle.created = "2026-10-21T12:00:00Z".to_string();
    apply(
        &new.app,
        &new.gateway,
        &bundle,
        &everything(),
        Conflict::KeepLocal,
    )
    .unwrap();
    let coverage = accounting::coverage_of(new.gateway.dir()).unwrap().unwrap();
    assert_eq!(
        coverage.complete_from_utc.as_deref(),
        Some("2026-10-22T00:00:00Z")
    );
}

#[test]
fn an_export_this_build_could_not_restore_is_refused() {
    assert!(check_sizes(10, 20, 100, 100).is_ok());
    assert!(check_sizes(101, 0, 100, 1000).is_err());
    assert!(check_sizes(10, 101, 1000, 100).is_err());
}

#[cfg(unix)]
#[test]
fn restore_snapshots_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let pc = Computer::new("pc");
    pc.insert("k1", 1);
    accounting::import(pc.gateway.dir(), &[request("r1", 50)], None).unwrap();
    let dir = snapshot(&pc.app, pc.gateway.dir()).unwrap();
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&dir), 0o700);
    assert_eq!(mode(&dir.join("tokenboard.db")), 0o600);
    assert_eq!(mode(&dir.join("gateway").join(accounting::FILE)), 0o600);
}

#[test]
fn only_changed_prices_travel_and_merge_by_model() {
    let defaults: Value = serde_json::from_str(include_str!("../../prices.json")).unwrap();
    let models: Vec<String> = defaults
        .as_object()
        .unwrap()
        .keys()
        .take(2)
        .cloned()
        .collect();
    let edited = |app: &AppContext, model: &str, input: f64| {
        let mut table = crate::commands::get_prices_impl(app).unwrap();
        table[model]["input"] = serde_json::json!(input);
        crate::commands::save_prices_impl(app, table).unwrap();
    };
    let old = Computer::new("old");
    edited(&old.app, &models[0], 123.0);
    edited(&old.app, &models[1], 7.0);
    let bundle = sealed_roundtrip(&old.export());
    let overrides = bundle.price_overrides.clone().unwrap();
    // Only the two edited models, not the whole bundled table.
    assert_eq!(overrides.len(), 2, "{overrides:?}");

    let new = Computer::new("new");
    edited(&new.app, &models[1], 9.0);
    let plan = preview(&new.app, &new.gateway, &bundle, "d".into()).unwrap();
    assert_eq!(plan.prices, Some(ItemStatus::Differs));
    let result = apply(
        &new.app,
        &new.gateway,
        &bundle,
        &everything(),
        Conflict::KeepLocal,
    )
    .unwrap();
    assert!(result.prices_restored);
    let table = crate::commands::get_prices_impl(&new.app).unwrap();
    assert_eq!(table[&models[0]]["input"], serde_json::json!(123.0));
    assert_eq!(table[&models[1]]["input"], serde_json::json!(9.0));
    assert_eq!(
        crate::commands::price_overrides_for_backup(&new.app).len(),
        2
    );
}

#[test]
fn restoring_prices_over_an_online_table_keeps_only_the_backed_up_overrides() {
    let bundled: Value = serde_json::from_str(include_str!("../../prices.json")).unwrap();
    let models: Vec<String> = bundled
        .as_object()
        .unwrap()
        .keys()
        .filter(|model| bundled[model.as_str()]["input"].is_number())
        .take(2)
        .cloned()
        .collect();
    let (edited, updated) = (&models[0], &models[1]);
    // The online table moved one model's price away from the bundled one.
    let mut online = bundled.clone();
    let online_input = bundled[updated.as_str()]["input"].as_f64().unwrap() + 1.25;
    online[updated.as_str()]["input"] = serde_json::json!(online_input);

    let old = Computer::new("old");
    crate::commands::install_test_price_feed(&old.app, online.clone());
    let mut table = crate::commands::get_prices_impl(&old.app).unwrap();
    table[edited.as_str()]["input"] = serde_json::json!(321.0);
    crate::commands::save_prices_impl(&old.app, table).unwrap();
    let bundle = sealed_roundtrip(&old.export());
    let overrides = bundle.price_overrides.clone().unwrap();
    assert_eq!(
        overrides.keys().collect::<Vec<_>>(),
        vec![edited],
        "{overrides:?}"
    );

    let new = Computer::new("new");
    crate::commands::install_test_price_feed(&new.app, online);
    let result = apply(
        &new.app,
        &new.gateway,
        &bundle,
        &everything(),
        Conflict::UseBackup,
    )
    .unwrap();
    assert!(result.prices_restored);
    let saved = crate::commands::price_overrides_for_backup(&new.app);
    assert_eq!(saved.keys().collect::<Vec<_>>(), vec![edited], "{saved:?}");
    let table = crate::commands::get_prices_impl(&new.app).unwrap();
    assert_eq!(table[edited.as_str()]["input"], serde_json::json!(321.0));
    assert_eq!(
        table[updated.as_str()]["input"],
        serde_json::json!(online_input)
    );
}

fn put_state(pc: &Computer, key: &str, input: i64, generation: i64) {
    pc.conn()
        .execute(
            "INSERT OR REPLACE INTO scan_cumulative_state
                 (unique_key, input_tokens, output_tokens, cached_tokens, cache_write_tokens, cost_usd, generation)
             VALUES (?1, ?2, 0, 0, 0, NULL, ?3)",
            params![key, input, generation],
        )
        .unwrap();
}

fn family_input(pc: &Computer, source: &str) -> i64 {
    pc.conn()
        .query_row(
            "SELECT COALESCE(SUM(input_tokens), 0) FROM token_logs
              WHERE unique_key = ?1 OR substr(unique_key, 1, length(?1) + 1) = ?1 || '#'",
            [source],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn a_cumulative_source_scanned_on_both_sides_is_not_counted_twice() {
    // The backup saw the source at 100 and then 200; this computer scanned
    // the same source once, at 200.
    let old = Computer::new("old");
    old.insert("src", 100);
    old.insert("src#t200_0_0", 100);
    old.insert("plain", 5);
    put_state(&old, "src", 200, 0);
    let bundle = sealed_roundtrip(&old.export());

    let new = Computer::new("new");
    new.insert("src", 200);
    put_state(&new, "src", 200, 0);
    let plan = preview(&new.app, &new.gateway, &bundle, "d".into()).unwrap();
    assert_eq!((plan.ledger.new, plan.ledger.known), (1, 2));
    let result = apply(
        &new.app,
        &new.gateway,
        &bundle,
        &everything(),
        Conflict::KeepLocal,
    )
    .unwrap();
    assert_eq!(result.ledger_added, 1);
    assert_eq!(family_input(&new, "src"), 200);
    assert_eq!(new.input_of("plain"), 5);
}

#[test]
fn a_rebuild_never_counts_a_cumulative_source_twice() {
    use crate::scanner::{runner::insert_cumulative_delta, types::LogRecord};
    let pc = Computer::new("pc");
    let machine = crate::commands::local_machine_id(&pc.app);
    let scan = |total: i64| {
        let mut conn = pc.conn();
        let tx = conn.transaction().unwrap();
        let log = LogRecord {
            tool: "codex".to_string(),
            model: "gpt-5".to_string(),
            input_tokens: total,
            output_tokens: 0,
            cached_tokens: 0,
            cache_write_tokens: 0,
            timestamp: "2026-10-20 10:00:00".to_string(),
            session_id: "s1".to_string(),
            unique_key: "src".to_string(),
            cost_usd: None,
            cumulative: true,
        };
        insert_cumulative_delta(&tx, &log, &machine).unwrap();
        tx.commit().unwrap();
    };
    for total in [100, 200, 300] {
        scan(total);
    }
    assert_eq!(family_input(&pc, "src"), 300);
    // A rebuild that lost the middle increment keeps the baseline: the lost
    // key depended on the totals at that time, and refilling it under any
    // other key would count it twice wherever it had been uploaded.
    pc.conn()
        .execute(
            "DELETE FROM token_logs WHERE unique_key = 'src#t200_0_0'",
            [],
        )
        .unwrap();
    scan(300);
    scan(300);
    assert_eq!(family_input(&pc, "src"), 200);
    // Later growth is counted once, from the kept baseline.
    scan(350);
    scan(350);
    assert_eq!(family_input(&pc, "src"), 250);
}

#[test]
fn pruning_keeps_the_newest_backup_written_in_the_same_second() {
    let pc = Computer::new("pc");
    let dir = pc.root.join("auto-same-second");
    fs::create_dir_all(&dir).unwrap();
    let prefix = "TokenLedger-auto-0000aaaa-";
    for stamp in [
        "20261024-010000",
        "20261024-010000-2",
        "20261024-010000-10",
        "20261023-235959",
    ] {
        fs::write(dir.join(format!("{prefix}{stamp}.tlbackup")), b"x").unwrap();
    }
    assert_eq!(auto::prune(&dir, prefix, 1), 3);
    assert!(dir
        .join(format!("{prefix}20261024-010000-10.tlbackup"))
        .exists());
}

#[test]
fn pruning_leaves_other_computers_backups_in_a_shared_folder() {
    let pc = Computer::new("pc");
    let dir = pc.root.join("auto-shared");
    fs::create_dir_all(&dir).unwrap();
    let mine = "TokenLedger-auto-0000aaaa-";
    let theirs = "TokenLedger-auto-0000bbbb-";
    for name in [
        format!("{mine}20261024-010000.tlbackup"),
        format!("{mine}20261024-020000.tlbackup"),
        format!("{theirs}20261023-010000.tlbackup"),
    ] {
        fs::write(dir.join(name), b"x").unwrap();
    }
    assert_eq!(auto::prune(&dir, mine, 1), 1);
    assert!(dir.join(format!("{mine}20261024-020000.tlbackup")).exists());
    assert!(dir
        .join(format!("{theirs}20261023-010000.tlbackup"))
        .exists());
}

#[cfg(unix)]
#[test]
fn export_never_writes_through_a_planted_temporary_path() {
    let pc = Computer::new("pc");
    let dir = pc.root.join("planted");
    fs::create_dir_all(&dir).unwrap();
    let victim = pc.root.join("victim.txt");
    fs::write(&victim, b"keep me").unwrap();
    let target = dir.join("out.tlbackup");
    std::os::unix::fs::symlink(&victim, dir.join("out.tlbackup.tmp")).unwrap();
    write_private(&target, b"sealed").unwrap();
    assert_eq!(fs::read(&victim).unwrap(), b"keep me");
    assert_eq!(fs::read(&target).unwrap(), b"sealed");
}

#[test]
fn another_computers_rows_are_restored_and_its_unuploaded_ones_counted() {
    let old = Computer::new("old");
    let row = |key: &str, machine: &str, status: i64, user: Option<&str>| {
        old.conn()
            .execute(
                "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens,
                     cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id,
                     sync_status, cloud_user_id)
                 VALUES ('claude', 'claude-sonnet-5', 10, 1, 0, 0, '2026-10-20 10:00:00', 's1', ?1, 0.1, ?2, ?3, ?4)",
                params![key, machine, status, user],
            )
            .unwrap();
    };
    row("uploaded", "pc-a", 1, Some("user-1"));
    row("pending", "pc-a", 0, None);
    row("never-signed-in", "pc-a", 1, None);
    row("no-machine", "", 1, Some("user-1"));
    let mut bundle = sealed_roundtrip(&old.export());
    bundle.machine = "pc-a".to_string();

    let new = Computer::new("new");
    let plan = preview(&new.app, &new.gateway, &bundle, "d".into()).unwrap();
    assert_eq!(
        (plan.ledger.new, plan.ledger.other_computer_pending),
        (4, 2)
    );
    let result = apply(
        &new.app,
        &new.gateway,
        &bundle,
        &everything(),
        Conflict::KeepLocal,
    )
    .unwrap();
    assert_eq!(result.ledger_added, 4);
    let machine_of = |key: &str| -> Option<String> {
        new.conn()
            .query_row(
                "SELECT machine_id FROM token_logs WHERE unique_key = ?1",
                [key],
                |row| row.get(0),
            )
            .ok()
    };
    assert_eq!(machine_of("uploaded").as_deref(), Some("pc-a"));
    // A row without an id keeps counting under the computer it came from.
    assert_eq!(machine_of("no-machine").as_deref(), Some("pc-a"));
    // Not uploaded yet: restored all the same (a new computer has another
    // id, and without cloud sync nothing was ever uploaded).
    assert_eq!(machine_of("pending").as_deref(), Some("pc-a"));
    assert_eq!(machine_of("never-signed-in").as_deref(), Some("pc-a"));
}
