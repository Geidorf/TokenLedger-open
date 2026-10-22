use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    bridge: LegacyRestore,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn fixture(schema: i64, state: &str, manages_model: bool) -> Fixture {
    let root = std::env::temp_dir().join(format!(
        "tl-legacy-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let home = root.join("codex");
    fs::create_dir_all(&home).unwrap();
    let data = root.join("data");
    fs::create_dir_all(&data).unwrap();
    let data = fs::canonicalize(data).unwrap();
    let home = fs::canonicalize(home).unwrap();
    let path = home.join("config.toml");
    fs::write(&path,"# preserve\nmodel_provider = 'new'\nmodel = 'new-model'\n[model_providers.new]\nsecret = 'dummy-never-in-dto'\n").unwrap();
    let c = Connection::open(data.join("api_profiles_v1.sqlite3")).unwrap();
    c.execute_batch(&format!("PRAGMA application_id={APPLICATION_ID}; PRAGMA user_version={schema}; CREATE TABLE api_profile_meta(singleton INTEGER,schema_version INTEGER); INSERT INTO api_profile_meta VALUES(1,{schema}); CREATE TABLE api_profiles(profile_id TEXT); INSERT INTO api_profiles VALUES('p');")).unwrap();
    if schema == 2 {
        c.execute_batch("CREATE TABLE codex_provider_switch_receipt(singleton INTEGER,operation_id TEXT,state TEXT,before_provider_present INTEGER,before_provider TEXT,before_model_present INTEGER,before_model TEXT,target_provider TEXT,manage_model INTEGER,target_model TEXT,codex_home TEXT,config_file_path TEXT,updated_at TEXT)").unwrap();
        c.execute("INSERT INTO codex_provider_switch_receipt VALUES(1,'receipt',?1,0,NULL,1,'old-model','new',?2,?3,?4,?5,'old')",params![state,i64::from(manages_model),manages_model.then_some("new-model"),home.to_str(),path.to_str()]).unwrap();
    }
    Fixture {
        root,
        bridge: LegacyRestore::new(&data, path),
    }
}
fn input(f: &Fixture, keep: bool) -> RestoreInput {
    let v = f.bridge.inspect().unwrap();
    RestoreInput {
        receipt_id: v.receipt_id.unwrap(),
        expected_version: v.config_version.unwrap(),
        keep_current: keep,
    }
}
#[test]
fn v1_profile_only_is_read_only() {
    let f = fixture(1, "active", true);
    let db = f.bridge.data.join("api_profiles_v1.sqlite3");
    let before = fs::read(&db).unwrap();
    let v = f.bridge.inspect().unwrap();
    assert_eq!(v.state, "none");
    assert_eq!(v.profile_count, 1);
    assert_eq!(before, fs::read(db).unwrap());
}
#[test]
fn v2_restore_preserves_unowned_values_and_missing_key() {
    let f = fixture(2, "active", true);
    let v = f.bridge.restore(input(&f, false)).unwrap();
    assert_eq!(v.state, "restored");
    let body = fs::read_to_string(&f.bridge.config).unwrap();
    assert!(body.contains("# preserve"));
    assert!(body.contains("dummy-never-in-dto"));
    assert!(!body.contains("model_provider ="));
    assert!(body.contains("old-model"));
    assert!(!serde_json::to_string(&v)
        .unwrap()
        .contains("dummy-never-in-dto"));
}
#[test]
fn unmanaged_model_is_preserved() {
    let f = fixture(2, "active", false);
    f.bridge.restore(input(&f, false)).unwrap();
    assert!(fs::read_to_string(&f.bridge.config)
        .unwrap()
        .contains("new-model"));
}
#[test]
fn pending_and_indeterminate_are_reconciled_not_guessed() {
    for state in ["pending", "indeterminate"] {
        let f = fixture(2, state, true);
        assert!(f.bridge.inspect().unwrap().can_restore);
        f.bridge.restore(input(&f, false)).unwrap();
        assert_eq!(f.bridge.inspect().unwrap().state, "restored");
    }
}
#[test]
fn post_write_crash_can_seal_by_explicit_retry() {
    let f = fixture(2, "indeterminate", true);
    fs::write(&f.bridge.config, "model = 'old-model'\n# after crash\n").unwrap();
    let before = fs::read(&f.bridge.config).unwrap();
    f.bridge.restore(input(&f, false)).unwrap();
    assert_eq!(before, fs::read(&f.bridge.config).unwrap());
}
#[test]
fn drift_blocks_restore_and_keep_is_truthful() {
    let f = fixture(2, "active", true);
    fs::write(
        &f.bridge.config,
        "model_provider='external'\nmodel='external'\n",
    )
    .unwrap();
    assert!(!f.bridge.inspect().unwrap().can_restore);
    assert!(f.bridge.restore(input(&f, false)).is_err());
    let before = fs::read(&f.bridge.config).unwrap();
    assert_eq!(f.bridge.restore(input(&f, true)).unwrap().state, "kept");
    assert_eq!(before, fs::read(&f.bridge.config).unwrap());
    let c = f.bridge.registry(false).unwrap().unwrap();
    assert_eq!(LegacyRestore::receipt(&c).unwrap().unwrap().state, "active");
}
#[test]
fn stale_confirmation_and_wrong_home_fail_closed() {
    let f = fixture(2, "active", true);
    let stale = input(&f, false);
    fs::write(
        &f.bridge.config,
        "model_provider='new'\nmodel='new-model'\n# changed\n",
    )
    .unwrap();
    assert!(f.bridge.restore(stale).is_err());
    let c = f.bridge.registry(true).unwrap().unwrap();
    c.execute(
        "UPDATE codex_provider_switch_receipt SET codex_home='/other'",
        [],
    )
    .unwrap();
    assert!(!f.bridge.inspect().unwrap().can_restore);
    assert!(f
        .bridge
        .restore(RestoreInput {
            receipt_id: "receipt".into(),
            expected_version: "unused".into(),
            keep_current: false
        })
        .is_err());
}
#[test]
fn kept_receipt_rejects_another_windows_old_confirmation() {
    let f = fixture(2, "active", true);
    let stale_restore = input(&f, false);
    let stale_keep = input(&f, true);
    let before = fs::read(&f.bridge.config).unwrap();
    assert_eq!(f.bridge.restore(input(&f, true)).unwrap().state, "kept");
    assert!(f.bridge.restore(stale_restore).is_err());
    assert!(f.bridge.restore(stale_keep).is_err());
    assert_eq!(before, fs::read(&f.bridge.config).unwrap());
    assert_eq!(f.bridge.inspect().unwrap().state, "kept");
}
#[test]
fn database_failure_keeps_recoverable_receipt() {
    let f = fixture(2, "active", true);
    let c = f.bridge.registry(true).unwrap().unwrap();
    c.execute_batch("CREATE TRIGGER reject_update BEFORE UPDATE ON codex_provider_switch_receipt BEGIN SELECT RAISE(FAIL,'fault'); END;").unwrap();
    assert!(f.bridge.restore(input(&f, false)).is_err());
    assert!(f.bridge.inspect().unwrap().can_restore);
    c.execute_batch("DROP TRIGGER reject_update").unwrap();
    assert_eq!(
        f.bridge.restore(input(&f, false)).unwrap().state,
        "restored"
    );
}
#[test]
fn foreign_future_and_linked_files_rejected() {
    let f = fixture(2, "active", true);
    let c = f.bridge.registry(true).unwrap().unwrap();
    c.pragma_update(None, "user_version", 3).unwrap();
    assert!(f.bridge.inspect().is_err());
    #[cfg(unix)]
    {
        c.pragma_update(None, "user_version", 2).unwrap();
        let link = f.root.join("alias");
        std::os::unix::fs::symlink(&f.bridge.config, &link).unwrap();
        let b = LegacyRestore::new(&f.bridge.data, link);
        assert!(!b.inspect().unwrap().can_restore);
    }
}
