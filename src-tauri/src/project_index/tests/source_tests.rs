//! S1–S17: per-source working-directory extraction on synthetic fixtures,
//! plus P1 canaries (content, titles, branches and remotes are never read).

use super::{assert_no_canary, jsonl, write_file, Scratch};
use crate::project_index::label::Resolution;
use crate::project_index::sources::{Lookup, SourceContext, SourceFamily, SourceRoots, Workdir};
use rusqlite::Connection;
use serde_json::json;

fn found(cwd: &str) -> Lookup {
    Lookup::Found(Workdir {
        cwd: cwd.to_string(),
        repo_root: None,
        default_workspace: false,
    })
}

fn found_with_root(cwd: &str, root: &str) -> Lookup {
    Lookup::Found(Workdir {
        cwd: cwd.to_string(),
        repo_root: Some(root.to_string()),
        default_workspace: false,
    })
}

fn unresolved(resolution: Resolution) -> Lookup {
    Lookup::Unresolved(resolution)
}

/// Looks sessions up through one shared context, like a pass does, and
/// checks that no result carries a canary.
struct Probe {
    roots: SourceRoots,
}

impl Probe {
    fn new(home: &Scratch) -> Self {
        Self {
            roots: SourceRoots::under(home.path()),
        }
    }

    fn lookup(&self, family: SourceFamily, session_id: &str) -> Lookup {
        let never = || false;
        let mut context = SourceContext::new(&self.roots, &never);
        let result = context.lookup(family, session_id);
        assert_no_canary(&format!("{result:?}"));
        result
    }
}

fn sqlite(path: &std::path::Path, sql: &str) {
    std::fs::create_dir_all(path.parent().expect("db parent")).expect("db dir");
    let conn = Connection::open(path).expect("create fixture db");
    conn.execute_batch(sql).expect("seed fixture db");
}

#[test]
fn family_is_decided_by_unique_key_prefix() {
    for (key, family) in [
        ("claude_msg_1", SourceFamily::Claude),
        ("codex_v2_abc", SourceFamily::Codex),
        ("codex_legacy", SourceFamily::Codex),
        ("opencode_x", SourceFamily::OpenCode),
        ("kilo_x", SourceFamily::Kilo),
        ("mavis_s_1", SourceFamily::MiniMax),
        ("workbuddy_project_x", SourceFamily::WorkBuddyProject),
        ("workbuddy_agent_x", SourceFamily::WorkBuddyAgent),
        ("qclaw_jsonl_x", SourceFamily::Qclaw),
        ("hermes_x", SourceFamily::Hermes),
        ("reasonix_x", SourceFamily::Reasonix),
        ("deepseekgui_t_1", SourceFamily::DeepSeekGui),
        ("dsh_x", SourceFamily::Dsh),
        ("grok_x", SourceFamily::Grok),
        ("gemini_cli_x", SourceFamily::Gemini),
        ("zcode_x", SourceFamily::Zcode),
        ("kimi_x", SourceFamily::Kimi),
        ("kimi_v2_x", SourceFamily::Kimi),
        ("kimidesktop_x", SourceFamily::KimiDesktop),
        ("kimidesktop_v2_x", SourceFamily::KimiDesktop),
        ("pi_x", SourceFamily::Pi),
        ("antigravity_x", SourceFamily::Antigravity),
        ("marvis_tencent_x", SourceFamily::MarvisTencent),
        ("trae_x", SourceFamily::Trae),
        ("tencent_marvis_x", SourceFamily::Unknown),
        ("", SourceFamily::Unknown),
    ] {
        assert_eq!(SourceFamily::from_unique_key(key), family, "{key}");
    }
}

#[test]
fn unsupported_families_never_touch_sources() {
    let home = Scratch::new("src_unsupported");
    // Roots that would panic if walked do not exist here; the families below
    // must answer before any lookup.
    let probe = Probe::new(&home);
    for key in [
        "antigravity_1",
        "marvis_tencent_1",
        "trae_1",
        "workbuddy_1",
        "tencent_marvis_1",
    ] {
        assert_eq!(
            probe.lookup(SourceFamily::from_unique_key(key), "s"),
            unresolved(Resolution::UnsupportedSource)
        );
    }
}

#[test]
fn s1_claude_first_cwd_after_content() {
    let home = Scratch::new("src_claude");
    write_file(
        &home.join(".claude/projects/-work-alpha/sess-claude-1.jsonl"),
        // Raw lines keep the real key order: `cwd` comes after the content.
        concat!(
            r#"{"type":"summary","summary":"CANARY_SESSION_TITLE"}"#,
            "\n",
            r#"{"type":"user","message":{"role":"user","content":"CANARY_PROMPT_TEXT"},"#,
            r#""gitBranch":"CANARY_GIT_BRANCH","cwd":"/work/alpha"}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":[{"text":"CANARY_REPLY_TEXT"}]},"#,
            r#""cwd":"/work/alpha/sub"}"#,
            "\n",
        ),
    );
    // A malformed first line is skipped like the scanner does.
    write_file(
        &home.join(".claude/projects/-work-beta/sess-claude-2.jsonl"),
        format!("{{\"broken\": \n{}", jsonl(&[json!({"cwd": "/work/beta"})])),
    );
    // No cwd within the line budget.
    let mut lines: Vec<serde_json::Value> = (0..70)
        .map(|index| json!({"type": "user", "message": format!("CANARY_PROMPT_TEXT {index}")}))
        .collect();
    lines.push(json!({"cwd": "/work/too-late"}));
    write_file(
        &home.join(".claude/projects/-work-gamma/sess-claude-3.jsonl"),
        jsonl(&lines),
    );
    // Sub-agent logs are sessions of their own (file stem).
    write_file(
        &home.join(".claude/projects/-work-alpha/sess-claude-1/subagents/agent-a1.jsonl"),
        jsonl(&[json!({"cwd": "/work/alpha/agent"})]),
    );
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::Claude, "sess-claude-1"),
        found("/work/alpha")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Claude, "sess-claude-2"),
        found("/work/beta")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Claude, "sess-claude-3"),
        unresolved(Resolution::FieldMissing)
    );
    assert_eq!(
        probe.lookup(SourceFamily::Claude, "agent-a1"),
        found("/work/alpha/agent")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Claude, "cleaned-up"),
        unresolved(Resolution::SourceMissing)
    );
}

#[test]
fn s2_codex_first_session_meta_only() {
    let home = Scratch::new("src_codex");
    let uuid = "0199a0b1-c2d3-7e4f-8a9b-0c1d2e3f4a5b";
    write_file(
        &home.join(format!(
            ".codex/sessions/2026/09/24/rollout-2026-09-24T10-00-00-{uuid}.jsonl"
        )),
        jsonl(&[
            json!({"timestamp": "2026-09-24T02:00:00Z", "type": "session_meta",
                   "payload": {"id": uuid, "cwd": "/work/codex",
                               "instructions": "CANARY_SYSTEM_PROMPT",
                               "git": {"branch": "CANARY_GIT_BRANCH",
                                       "repository_url": "CANARY_GIT_REMOTE"}}}),
            json!({"type": "response_item", "payload": {"content": "CANARY_REPLY_TEXT"}}),
            // A fork replays its parent's metadata later in the file.
            json!({"type": "session_meta", "payload": {"id": "parent", "cwd": "/work/parent"}}),
        ]),
    );
    let other = "0199a0b1-0000-7e4f-8a9b-0c1d2e3f4a5b";
    write_file(
        &home.join(format!(
            ".codex/sessions/2026/09/24/rollout-2026-09-24T11-00-00-{other}.jsonl"
        )),
        jsonl(&[json!({"type": "turn_context", "payload": {"cwd": "/work/not-a-header"}})]),
    );
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::Codex, uuid),
        found("/work/codex")
    );
    // Legacy rows use the rollout stem, which ends with the same UUID.
    assert_eq!(
        probe.lookup(SourceFamily::Codex, &format!("2026-09-24T10-00-00-{uuid}")),
        found("/work/codex")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Codex, &uuid.to_uppercase()),
        found("/work/codex")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Codex, other),
        unresolved(Resolution::FieldMissing)
    );
    assert_eq!(
        probe.lookup(SourceFamily::Codex, "not-a-uuid"),
        unresolved(Resolution::SourceMissing)
    );
}

fn opencode_schema(with_time: bool) -> String {
    let message = if with_time {
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);"
    } else {
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);"
    };
    format!(
        "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT);
         {message}"
    )
}

#[test]
fn s3_opencode_prefers_first_assistant_path() {
    let home = Scratch::new("src_opencode");
    sqlite(
        &home.join(".local/share/opencode/opencode.db"),
        &format!(
            "{}
             INSERT INTO session VALUES ('ses_git', 'p1', '/work/oc', 'CANARY_SESSION_TITLE');
             INSERT INTO message VALUES ('m1', 'ses_git', 1, 1, '{{\"role\":\"user\",\"content\":\"CANARY_PROMPT_TEXT\"}}');
             INSERT INTO message VALUES ('m2', 'ses_git', 2, 2, '{{\"role\":\"assistant\",\"path\":{{\"cwd\":\"/work/oc/pkg\",\"root\":\"/work/oc\"}},\"text\":\"CANARY_REPLY_TEXT\"}}');
             INSERT INTO message VALUES ('m3', 'ses_git', 3, 3, '{{\"role\":\"assistant\",\"path\":{{\"cwd\":\"/work/later\",\"root\":\"/\"}}}}');
             INSERT INTO session VALUES ('ses_global', 'global', '/work/global-dir', 't');
             INSERT INTO message VALUES ('m4', 'ses_global', 1, 1, '{{\"role\":\"user\"}}');
             INSERT INTO message VALUES ('m5', 'ses_global', 2, 2, 'not json at all');
             INSERT INTO session VALUES ('ses_empty', 'global', NULL, 't');",
            opencode_schema(true)
        ),
    );
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::OpenCode, "ses_git"),
        found_with_root("/work/oc/pkg", "/work/oc")
    );
    assert_eq!(
        probe.lookup(SourceFamily::OpenCode, "ses_global"),
        found("/work/global-dir")
    );
    assert_eq!(
        probe.lookup(SourceFamily::OpenCode, "ses_empty"),
        unresolved(Resolution::FieldMissing)
    );
    assert_eq!(
        probe.lookup(SourceFamily::OpenCode, "ses_unknown"),
        unresolved(Resolution::SourceMissing)
    );
    // Kilo's database is absent in this fixture.
    assert_eq!(
        probe.lookup(SourceFamily::Kilo, "ses_git"),
        unresolved(Resolution::SourceMissing)
    );
}

#[test]
fn s4_kilo_without_time_columns_orders_by_id() {
    let home = Scratch::new("src_kilo");
    sqlite(
        &home.join(".local/share/kilo/kilo.db"),
        &format!(
            "{}
             INSERT INTO session VALUES ('k1', 'p', '/work/kilo', 't');
             INSERT INTO message VALUES ('a1', 'k1', '{{\"role\":\"assistant\",\"path\":{{\"cwd\":\"/work/kilo\",\"root\":\"/work/kilo\"}}}}');
             INSERT INTO message VALUES ('a2', 'k1', '{{\"role\":\"assistant\",\"path\":{{\"cwd\":\"/work/kilo/b\"}}}}');",
            opencode_schema(false)
        ),
    );
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::Kilo, "k1"),
        found_with_root("/work/kilo", "/work/kilo")
    );
}

#[test]
fn s5_minimax_v2_before_legacy_and_default_workspace_flag() {
    let home = Scratch::new("src_minimax");
    sqlite(
        &home.join(".minimax/v2/sqlite/runtime-state.sqlite"),
        "CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, workspace_dir TEXT,
             project_workspace_dir TEXT, is_default_workspace INTEGER, title TEXT);
         INSERT INTO local_runtime_sessions VALUES ('mm-proj', '/work/mm-ws', '/work/mm', 0, 'CANARY_SESSION_TITLE');
         INSERT INTO local_runtime_sessions VALUES ('mm-default', '/srv/minimax/default', NULL, 1, 't');
         INSERT INTO local_runtime_sessions VALUES ('mm-empty', '', NULL, 0, 't');",
    );
    sqlite(
        &home.join(".minimax/sqlite.db"),
        "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_dir TEXT, title TEXT);
         INSERT INTO sessions VALUES ('mm-legacy', '/work/legacy', 'CANARY_SESSION_TITLE');
         INSERT INTO sessions VALUES ('mm-null', NULL, 't');
         INSERT INTO sessions VALUES ('mm-proj', '/work/should-not-win', 't');",
    );
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::MiniMax, "mm-proj"),
        found("/work/mm")
    );
    assert_eq!(
        probe.lookup(SourceFamily::MiniMax, "mm-default"),
        Lookup::Found(Workdir {
            cwd: "/srv/minimax/default".to_string(),
            repo_root: None,
            default_workspace: true,
        })
    );
    assert_eq!(
        probe.lookup(SourceFamily::MiniMax, "mm-empty"),
        unresolved(Resolution::FieldMissing)
    );
    assert_eq!(
        probe.lookup(SourceFamily::MiniMax, "mm-legacy"),
        found("/work/legacy")
    );
    assert_eq!(
        probe.lookup(SourceFamily::MiniMax, "mm-null"),
        unresolved(Resolution::FieldMissing)
    );
    assert_eq!(
        probe.lookup(SourceFamily::MiniMax, "mm-none"),
        unresolved(Resolution::SourceMissing)
    );
}

#[test]
fn s6_workbuddy_project_logs_by_session_id_or_stem() {
    let home = Scratch::new("src_workbuddy");
    write_file(
        &home.join(".workbuddy/projects/proj-a/wb-file-1.jsonl"),
        concat!(
            r#"{"id":"1","timestamp":"t","type":"message","role":"user","#,
            r#""content":"CANARY_PROMPT_TEXT","providerData":{"x":"CANARY_REPLY_TEXT"},"#,
            r#""sessionId":"wb-session-1","cwd":"/work/wb"}"#,
            "\n",
        ),
    );
    write_file(
        &home.join(".workbuddy/projects/proj-b/wb-file-2.jsonl"),
        jsonl(&[json!({"id": "1", "content": "CANARY_PROMPT_TEXT", "sessionId": "wb-session-2"})]),
    );
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::WorkBuddyProject, "wb-session-1"),
        found("/work/wb")
    );
    assert_eq!(
        probe.lookup(SourceFamily::WorkBuddyProject, "wb-file-1"),
        found("/work/wb")
    );
    assert_eq!(
        probe.lookup(SourceFamily::WorkBuddyProject, "wb-session-2"),
        unresolved(Resolution::FieldMissing)
    );
}

#[test]
fn s7_qclaw_and_s16_pi_session_headers() {
    let home = Scratch::new("src_pi");
    write_file(
        &home.join(".qclaw/agents/agent-1/sessions/qc-1.jsonl"),
        jsonl(&[
            json!({"type": "session", "version": 3, "id": "qc-header", "timestamp": "t", "cwd": "/work/qc"}),
            json!({"type": "message", "message": {"content": "CANARY_PROMPT_TEXT"}}),
        ]),
    );
    write_file(
        &home.join(".pi/agent/sessions/--work-pi--/2026-09-24T10-00-00-000Z_file.jsonl"),
        jsonl(&[
            json!({"type": "session", "version": 3, "id": "pi-header-1", "timestamp": "t", "cwd": "/work/pi"}),
            json!({"type": "message", "message": {"content": "CANARY_REPLY_TEXT"}}),
        ]),
    );
    write_file(
        &home.join(".pi/agent/sessions/--work-pi--/pi-stem-only.jsonl"),
        jsonl(&[json!({"type": "session", "cwd": "/work/pi-stem"})]),
    );
    write_file(
        &home.join(".pi/agent/sessions/--work-pi--/not-a-session.jsonl"),
        jsonl(&[json!({"type": "message", "id": "x", "cwd": "/work/nope"})]),
    );
    let probe = Probe::new(&home);
    assert_eq!(probe.lookup(SourceFamily::Qclaw, "qc-1"), found("/work/qc"));
    assert_eq!(
        probe.lookup(SourceFamily::Pi, "pi-header-1"),
        found("/work/pi")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Pi, "pi-stem-only"),
        found("/work/pi-stem")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Pi, "x"),
        unresolved(Resolution::SourceMissing)
    );
}

#[test]
fn s8_hermes_state_and_qclaw_response_store_are_told_apart() {
    let home = Scratch::new("src_hermes");
    sqlite(
        &home.join("hermes/state.db"),
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT, git_repo_root TEXT,
             git_branch TEXT, title TEXT, system_prompt TEXT);
         INSERT INTO sessions VALUES ('h-1', 'tui', '/work/hermes/sub', '/work/hermes',
             'CANARY_GIT_BRANCH', 'CANARY_SESSION_TITLE', 'CANARY_SYSTEM_PROMPT');
         INSERT INTO sessions VALUES ('h-2', 'tui', NULL, NULL, 'b', 't', 's');
         INSERT INTO sessions VALUES ('h-3', 'tui', '  ', '/work/hermes-root', 'b', 't', 's');",
    );
    sqlite(
        &home.join(".qclaw-hermes/response_store.db"),
        "CREATE TABLE responses (response_id TEXT PRIMARY KEY, data TEXT, accessed_at TEXT);
         INSERT INTO responses VALUES ('resp-1', '{\"output\":\"CANARY_REPLY_TEXT\"}', 't');",
    );
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::Hermes, "h-1"),
        found_with_root("/work/hermes/sub", "/work/hermes")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Hermes, "h-2"),
        unresolved(Resolution::FieldMissing)
    );
    assert_eq!(
        probe.lookup(SourceFamily::Hermes, "h-3"),
        found_with_root("/work/hermes-root", "/work/hermes-root")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Hermes, "resp-1"),
        unresolved(Resolution::UnsupportedSource)
    );
    assert_eq!(
        probe.lookup(SourceFamily::Hermes, "nobody"),
        unresolved(Resolution::SourceMissing)
    );
}

#[test]
fn s9_reasonix_own_fields_forks_and_verified_sibling_inference() {
    let home = Scratch::new("src_reasonix");
    write_file(
        &home.join(".reasonix/sessions/rx-classic.meta.json"),
        json!({"workspace": "/work/rx", "title": "CANARY_SESSION_TITLE"}).to_string(),
    );
    write_file(
        &home.join(".reasonix/sessions/rx-classic-0123456789ab-recovery-1f.meta.json"),
        json!({"workspace": "/work/rx-fork"}).to_string(),
    );
    let project = ".reasonix/projects/-work-rx-new/sessions";
    write_file(
        &home.join(format!("{project}/rx-a.jsonl.telemetry.json")),
        "{}",
    );
    write_file(
        &home.join(format!("{project}/rx-a.jsonl.meta")),
        json!({"workspace_root": "/work/rx-new", "goal": "CANARY_PROMPT_TEXT"}).to_string(),
    );
    write_file(
        &home.join(format!("{project}/rx-b.jsonl.telemetry.json")),
        "{}",
    );
    let mismatch = ".reasonix/projects/-mismatch-/sessions";
    write_file(
        &home.join(format!("{mismatch}/rx-c.jsonl.telemetry.json")),
        "{}",
    );
    write_file(
        &home.join(format!("{mismatch}/rx-d.jsonl.telemetry.json")),
        "{}",
    );
    write_file(
        &home.join(format!("{mismatch}/rx-d.jsonl.meta")),
        json!({"workspace_root": "/work/other"}).to_string(),
    );
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::Reasonix, "rx-classic"),
        found("/work/rx")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Reasonix, "rx-a"),
        found("/work/rx-new")
    );
    // No own field: borrowed from a sibling whose encoding matches the dir.
    assert_eq!(
        probe.lookup(SourceFamily::Reasonix, "rx-b"),
        found("/work/rx-new")
    );
    // The sibling's encoding does not reproduce the dir name: no guess.
    assert_eq!(
        probe.lookup(SourceFamily::Reasonix, "rx-c"),
        unresolved(Resolution::FieldMissing)
    );
    assert_eq!(
        probe.lookup(SourceFamily::Reasonix, "rx-d"),
        found("/work/other")
    );
}

#[test]
fn s10_deepseek_gui_thread_workspace() {
    let home = Scratch::new("src_deepseek");
    let metadata = |id: &str, workspace: &str| {
        // `workspace` after the title and turns, as the app writes it.
        format!(
            concat!(
                r#"{{"kind":"thread","version":1,"timestamp":"t","thread":{{"id":"{id}","#,
                r#""title":"CANARY_SESSION_TITLE","turns":[{{"prompt":"CANARY_PROMPT_TEXT"}}],"#,
                r#""workspace":"{workspace}"}}}}"#,
                "\n"
            ),
            id = id,
            workspace = workspace
        )
    };
    write_file(
        &home.join(".deepseekgui/kun/threads/thr-1/metadata.jsonl"),
        metadata("thr-1", "/work/ds"),
    );
    write_file(
        &home.join(".deepseekgui/kun/threads/folder-x/metadata.jsonl"),
        metadata("thr-2", "/work/ds2"),
    );
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::DeepSeekGui, "thr-1"),
        found("/work/ds")
    );
    assert_eq!(
        probe.lookup(SourceFamily::DeepSeekGui, "thr-2"),
        found("/work/ds2")
    );
    assert_eq!(
        probe.lookup(SourceFamily::DeepSeekGui, "folder-x"),
        found("/work/ds2")
    );
    // A ledger id is never joined onto the directory unless it is one plain
    // path component.
    assert_eq!(
        probe.lookup(SourceFamily::DeepSeekGui, "../threads/thr-1"),
        unresolved(Resolution::SourceMissing)
    );
}

#[test]
fn s11_dsh_reads_only_the_first_decompressed_line_of_the_newest_generation() {
    let home = Scratch::new("src_dsh");
    let compress = |lines: &[serde_json::Value]| {
        zstd::stream::encode_all(jsonl(lines).as_bytes(), 0).expect("zstd fixture")
    };
    let dir = home.join(".dsh/sessions/--work-dsh--/sess-dir-1");
    write_file(
        &dir.join("session.v3.jsonl.zstd"),
        compress(&[
            json!({"type": "session", "id": "dsh-1", "cwd": "/work/dsh", "createdAt": "t"}),
            json!({"type": "request/header", "prompt": "CANARY_PROMPT_TEXT"}),
        ]),
    );
    write_file(
        &dir.join("session.jsonl.zstd"),
        compress(&[json!({"type": "session", "id": "dsh-1", "cwd": "/work/dsh-old"})]),
    );
    let probe = Probe::new(&home);
    assert_eq!(probe.lookup(SourceFamily::Dsh, "dsh-1"), found("/work/dsh"));
    assert_eq!(
        probe.lookup(SourceFamily::Dsh, "sess-dir-1"),
        found("/work/dsh")
    );
}

#[test]
fn s12_grok_summary_with_repository_root() {
    let home = Scratch::new("src_grok");
    write_file(
        &home.join(".grok/sessions/%2Fwork%2Fgrok/uuid-g1/summary.json"),
        serde_json::to_string_pretty(&json!({
            "info": {"id": "grok-1", "cwd": "/work/grok/sub"},
            "git_root_dir": "/work/grok",
            "git_remotes": ["CANARY_GIT_REMOTE"],
            "head_branch": "CANARY_GIT_BRANCH",
            "generated_title": "CANARY_SESSION_TITLE",
            "session_summary": "CANARY_REPLY_TEXT"
        }))
        .expect("summary json"),
    );
    write_file(
        &home.join(".grok/sessions/%2Fwork%2Fg2/uuid-g2/summary.json"),
        json!({"id": "grok-2", "info": {"cwd": "/work/g2"}}).to_string(),
    );
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::Grok, "grok-1"),
        found_with_root("/work/grok/sub", "/work/grok")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Grok, "grok-2"),
        found("/work/g2")
    );
}

#[test]
fn s13_gemini_project_root_marker() {
    let home = Scratch::new("src_gemini");
    write_file(
        &home.join(".gemini/tmp/alpha/chats/session-2026.jsonl"),
        jsonl(&[
            json!({"kind": "session", "sessionId": "gem-1", "projectHash": "abc"}),
            json!({"type": "user", "content": "CANARY_PROMPT_TEXT"}),
        ]),
    );
    write_file(
        &home.join(".gemini/tmp/alpha/chats/session-old.json"),
        json!({"messages": [{"content": "CANARY_REPLY_TEXT"}], "sessionId": "gem-old"}).to_string(),
    );
    write_file(
        &home.join(".gemini/tmp/alpha/.project_root"),
        "/work/gemini\n",
    );
    write_file(
        &home.join(".gemini/tmp/beta/chats/session-b.jsonl"),
        jsonl(&[json!({"kind": "session", "sessionId": "gem-b"})]),
    );
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::Gemini, "gem-1"),
        found("/work/gemini")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Gemini, "gem-old"),
        found("/work/gemini")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Gemini, "gem-b"),
        unresolved(Resolution::FieldMissing)
    );
}

#[test]
fn s14_zcode_session_directory_and_lossy_text() {
    let home = Scratch::new("src_zcode");
    sqlite(
        &home.join(".zcode/cli/db/db.sqlite"),
        "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT, title TEXT);
         INSERT INTO session VALUES ('z-1', '/work/zc', '/work/zc', 'CANARY_SESSION_TITLE');
         INSERT INTO session VALUES ('z-bad', CAST(X'2F776F726B2F7A63FF' AS TEXT), NULL, 't');",
    );
    let probe = Probe::new(&home);
    assert_eq!(probe.lookup(SourceFamily::Zcode, "z-1"), found("/work/zc"));
    assert_eq!(
        probe.lookup(SourceFamily::Zcode, "z-bad"),
        found("/work/zc\u{fffd}")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Zcode, "z-none"),
        unresolved(Resolution::SourceMissing)
    );
}

#[test]
fn s15_kimi_fallback_chain() {
    let home = Scratch::new("src_kimi");
    let sessions = ".kimi-code/sessions/wd_alpha_abc123";
    write_file(
        &home.join(format!("{sessions}/session_1/state.json")),
        json!({"workDir": "/work/kimi", "title": "CANARY_SESSION_TITLE",
               "lastPrompt": "CANARY_PROMPT_TEXT"})
        .to_string(),
    );
    write_file(
        &home.join(format!("{sessions}/session_2/state.json")),
        json!({"cwd": "/work/kimi-state-cwd"}).to_string(),
    );
    std::fs::create_dir_all(home.join(format!("{sessions}/session_3/agents/main"))).expect("dir");
    write_file(
        &home.join(format!("{sessions}/session_4/state.json")),
        json!({"cwd": "/work/kimi-cwd-only"}).to_string(),
    );
    write_file(
        &home.join(".kimi-code/session_index.jsonl"),
        jsonl(&[json!({"sessionId": "session_2",
                        "sessionDir": "/x/sessions/wd_alpha_abc123/session_2",
                        "workDir": "/work/kimi-index"})]),
    );
    write_file(
        &home.join(".kimi-code/workspaces.json"),
        json!({"version": 1, "workspaces": {"wd_alpha_abc123": {"root": "/work/kimi-root", "name": "alpha"}},
               "deleted_workspace_ids": []})
        .to_string(),
    );
    write_file(
        &home.join("kimi-desktop/home/sessions/wd_x/conv-abc/state.json"),
        json!({"workDir": "/work/kd"}).to_string(),
    );
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::Kimi, "session_1"),
        found("/work/kimi")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Kimi, "session_2"),
        found("/work/kimi-index")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Kimi, "session_3"),
        found("/work/kimi-root")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Kimi, "session_4"),
        found("/work/kimi-cwd-only")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Kimi, "session_9"),
        unresolved(Resolution::SourceMissing)
    );
    assert_eq!(
        probe.lookup(SourceFamily::KimiDesktop, "conv-abc"),
        found("/work/kd")
    );
    assert_eq!(
        probe.lookup(SourceFamily::KimiDesktop, "session_1"),
        unresolved(Resolution::SourceMissing)
    );
}

#[test]
fn cancelled_context_stops_building_indexes() {
    let home = Scratch::new("src_cancel");
    for index in 0..3 {
        write_file(
            &home.join(format!(".claude/projects/p/s{index}.jsonl")),
            jsonl(&[json!({"cwd": "/work/c"})]),
        );
    }
    let roots = SourceRoots::under(home.path());
    let cancelled = || true;
    let mut context = SourceContext::new(&roots, &cancelled);
    // The walk checks before every file it would read (review P2-4), so a
    // cancelled context reads no header and the session stays unresolved.
    assert_eq!(
        context.lookup(SourceFamily::Claude, "s0"),
        unresolved(Resolution::SourceMissing)
    );
}

#[test]
fn q7_gemini_project_root_uses_only_the_first_line() {
    // Review P3-2: text after the first line never reaches the label.
    let home = Scratch::new("src_gemini_lines");
    for (project, session, marker) in [
        (
            "multi",
            "gem-multi",
            "/work/gemini-multi\nCANARY_SYSTEM_PROMPT second line\n",
        ),
        (
            "crlf",
            "gem-crlf",
            "\u{feff}D:\\work\\gemini-crlf\r\nCANARY_PROMPT_TEXT\r\n",
        ),
        (
            "late",
            "gem-late",
            "\n\n  /work/gemini-late  \nCANARY_REPLY_TEXT",
        ),
        ("blank", "gem-blank", "   \n"),
    ] {
        write_file(
            &home.join(format!(".gemini/tmp/{project}/chats/session-1.jsonl")),
            jsonl(&[json!({"kind": "session", "sessionId": session})]),
        );
        write_file(
            &home.join(format!(".gemini/tmp/{project}/.project_root")),
            marker,
        );
    }
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::Gemini, "gem-multi"),
        found("/work/gemini-multi")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Gemini, "gem-crlf"),
        found("D:\\work\\gemini-crlf")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Gemini, "gem-late"),
        found("/work/gemini-late")
    );
    assert_eq!(
        probe.lookup(SourceFamily::Gemini, "gem-blank"),
        unresolved(Resolution::FieldMissing)
    );
}

#[test]
fn q7_kimi_workspaces_keep_only_string_roots() {
    // Review P2-3 / Q7: `workspaces.json` is read through a whitelist; other
    // fields and non-string roots are skipped without being kept.
    let home = Scratch::new("src_kimi_workspaces");
    let sessions = ".kimi-code/sessions";
    for dir in [
        "wd_alpha_1/session_a",
        "wd_beta_2/session_b",
        "wd_gamma_3/session_c",
    ] {
        std::fs::create_dir_all(home.join(format!("{sessions}/{dir}"))).expect("session dir");
    }
    write_file(
        &home.join(".kimi-code/workspaces.json"),
        json!({
            "workspaces": {
                "wd_alpha_1": {"root": "/work/kimi-alpha", "name": "CANARY_SESSION_TITLE",
                               "history": [{"prompt": "CANARY_PROMPT_TEXT"}]},
                "wd_beta_2": {"root": {"path": "/work/CANARY_SYSTEM_PROMPT"}},
                "wd_gamma_3": {"root": ["/work/CANARY_REPLY_TEXT"]}
            },
            "recent": [{"text": "CANARY_REPLY_TEXT"}]
        })
        .to_string(),
    );
    let probe = Probe::new(&home);
    assert_eq!(
        probe.lookup(SourceFamily::Kimi, "session_a"),
        found("/work/kimi-alpha")
    );
    for session in ["session_b", "session_c"] {
        assert_eq!(
            probe.lookup(SourceFamily::Kimi, session),
            unresolved(Resolution::FieldMissing)
        );
    }
}

#[test]
fn source_family_names_round_trip() {
    let all = [
        SourceFamily::Claude,
        SourceFamily::Codex,
        SourceFamily::OpenCode,
        SourceFamily::Kilo,
        SourceFamily::MiniMax,
        SourceFamily::WorkBuddyProject,
        SourceFamily::Qclaw,
        SourceFamily::Hermes,
        SourceFamily::Reasonix,
        SourceFamily::DeepSeekGui,
        SourceFamily::Dsh,
        SourceFamily::Grok,
        SourceFamily::Gemini,
        SourceFamily::Zcode,
        SourceFamily::Kimi,
        SourceFamily::KimiDesktop,
        SourceFamily::Pi,
        SourceFamily::Antigravity,
        SourceFamily::MarvisTencent,
        SourceFamily::Trae,
        SourceFamily::WorkBuddyAgent,
        SourceFamily::Unknown,
    ];
    for family in all {
        assert_eq!(
            SourceFamily::parse(family.as_str()),
            Some(family),
            "{family:?}"
        );
    }
    // 17 families record a working directory; 5 (with unknown prefixes) do
    // not (review P3-10).
    assert_eq!(
        all.iter().filter(|family| family.is_supported()).count(),
        17
    );
    assert_eq!(SourceFamily::parse("Claude"), None);
    assert_eq!(SourceFamily::parse(""), None);
}
