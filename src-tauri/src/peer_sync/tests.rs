use super::*;
use crate::gateway::MemorySecrets;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Sealed by Go's standard library exactly as the peer's `backup.Seal` and
/// `SealData` do; `fixtures/peer/generate.go.txt` makes them again.
const GO_BACKUP_FILE: &str = include_str!("../../../fixtures/peer/bundle.sealed");
const GO_DATA_FILE: &str = include_str!("../../../fixtures/peer/data.sealed");

/// The fixtures hold a placeholder for the peer's format name.
fn sealed(file: &str, format: &str) -> Vec<u8> {
    file.replace("@FORMAT@", format).into_bytes()
}

fn go_backup() -> Vec<u8> {
    sealed(GO_BACKUP_FILE, backup::BACKUP_FORMAT)
}

fn go_data() -> Vec<u8> {
    sealed(GO_DATA_FILE, backup::DATA_FORMAT)
}
const PASSPHRASE: &str = "correct horse";

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn temp_dir() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "tokenledger_peer_sync_{}_{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

fn go_bundle() -> PeerBundle {
    let plain = backup::open(&go_backup(), PASSPHRASE, backup::BACKUP_FORMAT).unwrap();
    parse_bundle(&plain).unwrap()
}

#[test]
fn opens_files_sealed_by_peer() {
    let bundle = go_bundle();
    assert_eq!(bundle.version, 2);
    assert!(bundle.carries_keys());
    assert_eq!(bundle.providers.len(), 4);
    assert_eq!(
        backup::open(&go_data(), PASSPHRASE, backup::DATA_FORMAT).unwrap(),
        b"hello peer"
    );
}

#[test]
fn wrong_passphrase_format_and_damage_are_told_apart() {
    assert_eq!(
        backup::open(&go_backup(), "wrong", backup::BACKUP_FORMAT),
        Err(backup::OpenError::Passphrase)
    );
    assert_eq!(
        backup::open(&go_data(), PASSPHRASE, backup::BACKUP_FORMAT),
        Err(backup::OpenError::NotSealed)
    );
    assert_eq!(
        backup::open(b"<html>sign in</html>", PASSPHRASE, backup::BACKUP_FORMAT),
        Err(backup::OpenError::NotSealed)
    );
    let whole = go_backup();
    let cut = &whole[..whole.len() / 2];
    assert_eq!(
        backup::open(cut, PASSPHRASE, backup::BACKUP_FORMAT),
        Err(backup::OpenError::Corrupt)
    );
    let mut value: serde_json::Value = serde_json::from_slice(&go_backup()).unwrap();
    value["iterations"] = serde_json::json!(600_001);
    assert_eq!(
        backup::open(
            &serde_json::to_vec(&value).unwrap(),
            PASSPHRASE,
            backup::BACKUP_FORMAT
        ),
        Err(backup::OpenError::Passphrase),
        "the envelope is authenticated"
    );
    value["version"] = serde_json::json!(2);
    assert_eq!(
        backup::open(
            &serde_json::to_vec(&value).unwrap(),
            PASSPHRASE,
            backup::BACKUP_FORMAT
        ),
        Err(backup::OpenError::Newer)
    );
    let mut bom = b"\xef\xbb\xbf".to_vec();
    bom.extend_from_slice(&go_data());
    assert!(backup::open(&bom, PASSPHRASE, backup::DATA_FORMAT).is_ok());
}

#[test]
fn sealed_here_opens_with_peers_rules() {
    let sealed = backup::seal(b"{\"version\":2}", "p", backup::BACKUP_FORMAT, 100_000).unwrap();
    let text = String::from_utf8(sealed.clone()).unwrap();
    assert!(text.starts_with(&format!("{{\n  \"format\": \"{}\"", backup::BACKUP_FORMAT)));
    assert_eq!(
        backup::open(&sealed, "p", backup::BACKUP_FORMAT).unwrap(),
        b"{\"version\":2}"
    );
    assert!(backup::seal(b"x", "", backup::DATA_FORMAT, 100_000).is_err());
}

#[test]
fn preview_maps_providers_and_explains_what_cannot_come() {
    let bundle = go_bundle();
    let existing = BTreeSet::from(["deepseek".to_string()]);
    let preview = preview(&bundle, &existing);
    let by_id = |id: &str| {
        preview
            .providers
            .iter()
            .find(|candidate| candidate.peer_id == id)
            .unwrap()
    };
    let deepseek = by_id("deepseek");
    assert_eq!(
        deepseek.wire,
        Some(WireApi::Chat),
        "chat comes before anthropic"
    );
    assert_eq!(deepseek.base_url, "https://api.deepseek.com/v1");
    assert!(deepseek.has_key && deepseek.exists && deepseek.unsupported.is_none());
    let relay = by_id("relay");
    assert_eq!(relay.wire, Some(WireApi::Responses));
    assert!(
        relay.has_key,
        "a saved key counts when the main one is empty"
    );
    assert!(
        by_id("claude").unsupported.is_some(),
        "subscription sign-ins don't sync"
    );
    assert!(
        by_id("gem").unsupported.is_some(),
        "Gemini-native isn't spoken"
    );
    let page = serde_json::to_string(&preview).unwrap();
    assert!(!page.contains("fixture-key"), "keys never reach the page");
}

#[test]
fn ids_are_made_valid_and_unique() {
    assert_eq!(tokenledger_id("My Relay_01"), "my-relay-01");
    assert_eq!(tokenledger_id("群组"), "peer-provider");
    assert_eq!(tokenledger_id("group"), "peer-group");
    assert!(tokenledger_id(&"x".repeat(80)).len() <= 32);
    let bundle = PeerBundle {
        providers: vec![
            PeerProvider {
                id: "A".into(),
                chat: "https://a.example/v1".into(),
                ..Default::default()
            },
            PeerProvider {
                id: "a".into(),
                chat: "https://b.example/v1".into(),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    let ids: Vec<String> = preview(&bundle, &BTreeSet::new())
        .providers
        .into_iter()
        .map(|candidate| candidate.id)
        .collect();
    assert_eq!(ids, vec!["a", "a-2"]);
}

#[test]
fn apply_brings_picked_providers_and_their_keys_into_the_keychain() {
    let dir = temp_dir();
    let secrets = Arc::new(MemorySecrets::default());
    let gateway = Gateway::new(&dir, secrets.clone(), 0);
    let bundle = go_bundle();
    let picked = BTreeSet::from([
        "deepseek".to_string(),
        "relay".to_string(),
        "claude".to_string(),
    ]);
    let result = apply(&gateway, &bundle, &picked).unwrap();
    assert_eq!(result.imported, vec!["deepseek", "relay"]);
    assert_eq!(result.keys_saved, 2);
    assert_eq!(result.skipped, vec!["claude"]);
    assert_eq!(
        secrets.get("provider:relay").unwrap().as_deref(),
        Some("fixture-key-relay")
    );
    let stored = fs::read_to_string(dir.join("providers-v1.json")).unwrap_or_default()
        + &fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| fs::read_to_string(entry.path()).ok())
            .collect::<String>();
    assert!(
        !stored.contains("fixture-key"),
        "keys are never written to disk"
    );
    let views = gateway.list_providers().unwrap();
    assert!(views.iter().all(|view| view.has_key));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_backup_without_keys_keeps_existing_keys() {
    let dir = temp_dir();
    let secrets = Arc::new(MemorySecrets::default());
    let gateway = Gateway::new(&dir, secrets.clone(), 0);
    let mut bundle = go_bundle();
    bundle.keys = false;
    bundle.providers_keys = Some(false);
    secrets.set("provider:deepseek", "already-here").unwrap();
    let result = apply(&gateway, &bundle, &BTreeSet::from(["deepseek".to_string()])).unwrap();
    assert_eq!(result.keys_saved, 0);
    assert_eq!(
        secrets.get("provider:deepseek").unwrap().as_deref(),
        Some("already-here")
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn config_keeps_secrets_in_the_keychain_only() {
    let dir = temp_dir();
    let secrets = MemorySecrets::default();
    let saved = save_config(
        &dir,
        &secrets,
        SaveConfigInput {
            url: "https://dav.example/remote.php/dav/files/me/".into(),
            user: "me".into(),
            password: Some("dav-secret".into()),
            passphrase: Some("sync-secret".into()),
        },
    )
    .unwrap();
    assert_eq!(saved.url, "https://dav.example/remote.php/dav/files/me/");
    assert!(saved.has_password && saved.has_passphrase);
    let file = fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
    assert!(!file.contains("secret"));
    // None keeps a saved secret; "" removes it.
    let kept = save_config(
        &dir,
        &secrets,
        SaveConfigInput {
            url: "https://dav.example/dav".into(),
            user: "me".into(),
            password: None,
            passphrase: Some(String::new()),
        },
    )
    .unwrap();
    assert!(kept.has_password && !kept.has_passphrase);
    assert!(save_config(
        &dir,
        &secrets,
        SaveConfigInput {
            url: "https://me:pw@dav.example/".into(),
            user: String::new(),
            password: None,
            passphrase: None,
        },
    )
    .is_err());
    clear_config(&dir, &secrets).unwrap();
    assert!(!view(&dir, &secrets).unwrap().has_password);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn backup_url_matches_peers_layout() {
    let base = dav::parse_base("https://dav.example/root/").unwrap();
    assert_eq!(
        dav::file_url(&base, &[dav::FOLDER, dav::BACKUP_FILE])
            .unwrap()
            .as_str(),
        format!(
            "https://dav.example/root/{}/{}",
            dav::FOLDER,
            dav::BACKUP_FILE
        )
    );
    let bare = dav::parse_base("https://dav.example").unwrap();
    assert_eq!(
        dav::file_url(&bare, &[dav::FOLDER, dav::BACKUP_FILE])
            .unwrap()
            .as_str(),
        format!("https://dav.example/{}/{}", dav::FOLDER, dav::BACKUP_FILE)
    );
    assert!(dav::parse_base("ftp://dav.example").is_err());
}

/// A keychain that refuses provider keys, as a locked one would.
#[derive(Default)]
struct RefusingKeys(MemorySecrets);

impl SecretStore for RefusingKeys {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        self.0.get(account)
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        if account.starts_with("provider:") {
            return Err("keychain locked".into());
        }
        self.0.set(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.delete(account)
    }
}

#[test]
fn a_key_that_cannot_be_saved_leaves_the_providers_as_they_were() {
    let dir = temp_dir();
    let gateway = Gateway::new(&dir, Arc::new(RefusingKeys::default()), 0);
    let bundle = go_bundle();
    let deepseek = bundle
        .providers
        .iter()
        .find(|provider| provider.id == "deepseek")
        .unwrap();
    let mut previous = record_for(deepseek, "deepseek").unwrap();
    previous.name = "Mine".into();
    gateway.upsert_provider(previous).unwrap();

    let picked = BTreeSet::from(["deepseek".to_string()]);
    assert!(apply(&gateway, &bundle, &picked).is_err());
    let views = gateway.list_providers().unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].record.name, "Mine", "the earlier provider is back");

    let picked = BTreeSet::from(["relay".to_string()]);
    assert!(apply(&gateway, &bundle, &picked).is_err());
    assert!(
        gateway
            .list_providers()
            .unwrap()
            .iter()
            .all(|view| view.record.id != "relay"),
        "a new provider is taken out again"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn credentials_go_over_http_only_on_this_computer_or_the_local_network() {
    let allowed = |address: &str| dav::may_send_credentials(&dav::parse_base(address).unwrap());
    assert!(allowed("https://dav.example/dav"));
    assert!(allowed("http://127.0.0.1:5005/dav"));
    assert!(allowed("http://[::1]:8080/"));
    assert!(allowed("http://192.168.1.20/webdav"));
    assert!(allowed("http://nas.local/"));
    assert!(allowed("http://localhost:8080"));
    assert!(!allowed("http://dav.example/dav"));
    assert!(!allowed("http://8.8.8.8/"));
}

#[test]
fn the_shared_selection_survives_saving_the_setup() {
    let dir = temp_dir();
    let secrets = MemorySecrets::default();
    assert!(shared_selection(&dir).is_empty());
    let picked =
        save_shared_selection(&dir, &["BB".into(), "aa".into(), "bb".into(), "x/y".into()])
            .unwrap();
    assert_eq!(picked, ["aa", "bb"]);
    save_config(
        &dir,
        &secrets,
        SaveConfigInput {
            url: "https://dav.example/dav".into(),
            user: "me".into(),
            password: None,
            passphrase: None,
        },
    )
    .unwrap();
    assert_eq!(shared_selection(&dir), ["aa", "bb"]);
    save_shared_selection(&dir, &[]).unwrap();
    assert!(shared_selection(&dir).is_empty());
    assert!(!fs::read_to_string(dir.join(CONFIG_FILE))
        .unwrap()
        .contains("sharedComputers"));
    let _ = fs::remove_dir_all(dir);
}
