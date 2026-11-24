//! 多个进程同时扫描同一个数据目录（命令行与桌面端后台扫描并发的情形）：
//! 扫描器的单飞锁只在进程内，这里用真实的 `tokenledger-cli` 子进程证明跨进程
//! 并发扫描不会重复计数，入库总数与单独扫描一次相同。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const CLI: &str = env!("CARGO_BIN_EXE_tokenledger-cli");
const MESSAGES: usize = 300;
const PARALLEL: usize = 4;

fn temp_root(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "tokenledger_cli_scan_{label}_{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

/// 一个只含 Claude 会话日志的家目录：每条助手消息一个独立的消息 ID。
fn fixture_home(root: &Path) -> PathBuf {
    let home = root.join("home");
    let sessions = home.join(".claude/projects/fixture-project");
    fs::create_dir_all(&sessions).unwrap();
    let mut text = String::new();
    for index in 0..MESSAGES {
        text.push_str(&format!(
            r#"{{"type":"assistant","uuid":"a{index}","requestId":"r{index}","sessionId":"s1","timestamp":"2026-09-04T00:{:02}:{:02}Z","message":{{"id":"m{index}","model":"claude-fixture","content":[],"usage":{{"input_tokens":5,"output_tokens":{index},"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#,
            index / 60,
            index % 60
        ));
        text.push('\n');
    }
    fs::write(sessions.join("s1.jsonl"), text).unwrap();
    home
}

fn cli(home: &Path, data: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(CLI);
    command
        .args(args)
        .env("TOKENLEDGER_APPDATA", data)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("APPDATA", home.join("AppData/Roaming"))
        .env("LOCALAPPDATA", home.join("AppData/Local"))
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env_remove("CODEX_HOME")
        .env_remove("CLAUDE_CONFIG_DIR");
    command
}

fn json(output: &Output) -> serde_json::Value {
    assert!(
        output.status.success(),
        "cli failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("cli prints JSON")
}

fn exported_ids(home: &Path, data: &Path) -> Vec<String> {
    let output = cli(home, data, &["export", "--format", "json"])
        .output()
        .unwrap();
    let mut keys: Vec<String> = json(&output)
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["unique_key"].as_str().unwrap().to_string())
        .collect();
    keys.sort();
    keys
}

fn publish_fixture_snapshot(data: &Path) {
    let source = rusqlite::Connection::open(data.join("tokenboard.db")).unwrap();
    let path = data.join("query-ledger-v1.sqlite3");
    source
        .execute("VACUUM INTO ?1", [path.to_str().unwrap()])
        .unwrap();
    let snapshot = rusqlite::Connection::open(&path).unwrap();
    snapshot.execute_batch("PRAGMA journal_mode=DELETE; CREATE TABLE snapshot_info(version INTEGER, captured_at TEXT, gateway INTEGER);").unwrap();
    snapshot
        .execute(
            "INSERT INTO snapshot_info VALUES (1, ?1, 0)",
            [chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}

#[test]
fn concurrent_scans_from_separate_processes_count_each_record_once() {
    let root = temp_root("concurrent");
    let home = fixture_home(&root);

    // 基线：单独扫描一次。
    let baseline_data = root.join("baseline");
    let baseline = json(
        &cli(&home, &baseline_data, &["scan", "--json"])
            .output()
            .unwrap(),
    );
    publish_fixture_snapshot(&baseline_data);
    let baseline_keys = exported_ids(&home, &baseline_data);
    assert_eq!(
        baseline["inserted"].as_u64(),
        Some(baseline_keys.len() as u64)
    );
    assert!(
        baseline_keys.len() >= MESSAGES / 2,
        "fixture should be scanned"
    );

    // 同一个数据目录，几个进程同时扫。账本先由一个进程建好（桌面端首次启动就会建），
    // 与实际并发场景一致：两个进程同时首次建库不在本测试范围内。
    let shared_data = root.join("shared");
    let empty_home = root.join("empty-home");
    fs::create_dir(&empty_home).unwrap();
    json(
        &cli(&empty_home, &shared_data, &["scan", "--json"])
            .output()
            .unwrap(),
    );
    let children: Vec<_> = (0..PARALLEL)
        .map(|_| {
            cli(&home, &shared_data, &["scan", "--json"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    let inserted: u64 = children
        .into_iter()
        .map(|child| {
            json(&child.wait_with_output().unwrap())["inserted"]
                .as_u64()
                .unwrap()
        })
        .sum();

    publish_fixture_snapshot(&shared_data);
    let shared_keys = exported_ids(&home, &shared_data);
    assert_eq!(shared_keys, baseline_keys);
    assert_eq!(inserted, baseline_keys.len() as u64);

    // 再扫一次没有新增。
    let again = json(
        &cli(&home, &shared_data, &["scan", "--json"])
            .output()
            .unwrap(),
    );
    assert_eq!(again["inserted"].as_u64(), Some(0));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn query_commands_with_no_ledger_do_not_create_the_app_data_directory() {
    for (label, args) in [
        ("usage", vec!["usage", "--json"]),
        ("quota", vec!["quota", "--json"]),
        ("status", vec!["status", "--no-quota", "--json"]),
    ] {
        let root = temp_root(&format!("query_no_ledger_{label}"));
        let home = root.join("home");
        let data = root.join("data");
        let output = cli(&home, &data, &args).output().unwrap();
        if label == "quota" {
            let value = json(&output);
            assert!(value["providers"].as_array().unwrap().is_empty());
            assert!(value["message"].as_str().unwrap().contains("启动桌面端"));
        } else {
            assert!(
                !output.status.success(),
                "{label} should explain missing ledger"
            );
        }
        assert!(!data.exists(), "{label} created app data directory");
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn queries_use_the_snapshot_without_opening_the_closed_ledger() {
    let root = temp_root("closed_wal");
    let home = fixture_home(&root);
    let data = root.join("data");
    json(&cli(&home, &data, &["scan", "--json"]).output().unwrap());
    let ledger = data.join("tokenboard.db");
    let conn = rusqlite::Connection::open(&ledger).unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(conn);
    for file in ["tokenboard.db-wal", "tokenboard.db-shm"] {
        match fs::remove_file(data.join(file)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("remove synthetic {file}: {error}"),
        }
    }
    assert_eq!(&fs::read(&ledger).unwrap()[18..20], &[2, 2]);
    let missing = cli(&home, &data, &["usage", "--json"]).output().unwrap();
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("启动桌面端"));
    publish_fixture_snapshot(&data);
    let before = directory_bytes(&data);
    let result = cli(&home, &data, &["usage", "all", "--json"])
        .output()
        .unwrap();
    assert_eq!(json(&result)["summary"]["inputTokens"], MESSAGES * 5);
    assert!(json(&result)["snapshot"]["capturedAt"].is_string());
    assert_eq!(exported_ids(&home, &data).len(), MESSAGES);
    assert_eq!(directory_bytes(&data), before);
    fs::remove_dir_all(root).unwrap();
}

fn directory_bytes(dir: &Path) -> std::collections::BTreeMap<std::ffi::OsString, Vec<u8>> {
    fs::read_dir(dir)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (entry.file_name(), fs::read(entry.path()).unwrap())
        })
        .collect()
}

#[test]
fn export_with_no_ledger_does_not_create_the_app_data_directory() {
    let root = temp_root("export_no_ledger");
    let data = root.join("data");
    let output = cli(&root, &data, &["export", "--format", "json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("启动桌面端"));
    assert!(!data.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn mcp_handshake_does_not_create_the_app_data_directory() {
    use std::io::Write;
    use std::process::Stdio;

    let root = temp_root("mcp_handshake");
    let home = root.join("home");
    let data = root.join("data");
    let mut child = cli(&home, &data, &["mcp"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {}}
        })
    )
    .unwrap();
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(json(&output)["result"]["serverInfo"].is_object());
    assert!(!data.exists());
    fs::remove_dir_all(root).unwrap();
}
