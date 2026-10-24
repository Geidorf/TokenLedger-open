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
    json(
        &cli(&home, &shared_data, &["usage", "--json"])
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
