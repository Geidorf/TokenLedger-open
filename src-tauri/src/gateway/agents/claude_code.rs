//! Claude Code (T10.289): the user-level `settings.json` gets the gateway in
//! its `env` block. Claude Code appends `/v1/messages` itself, so the base URL
//! is written without `/v1`. The file is shared with the status line setup and
//! the user's own settings, so only the `env.ANTHROPIC_*` keys below belong to
//! the gateway; restore puts back just those.

use std::path::Path;

use serde_json::{Map, Value};

use crate::gateway::agent_config::{
    lookup, lookup_str, object_at, AgentSpec, AgentTarget, Docs, FileSpec, KeyPaths, Render,
};

const BASE_URL: &str = "ANTHROPIC_BASE_URL";
const AUTH_TOKEN: &str = "ANTHROPIC_AUTH_TOKEN";
const MODEL: &str = "ANTHROPIC_MODEL";
/// Claude Code asks for these by alias (`/model opus`, background Haiku
/// calls); the gateway only knows `provider/model`, so all point at one model.
const MODEL_ALIASES: [&str; 4] = [
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
];

pub const MANAGED: KeyPaths = &[
    &["env", BASE_URL],
    &["env", AUTH_TOKEN],
    &["env", MODEL],
    &["env", MODEL_ALIASES[0]],
    &["env", MODEL_ALIASES[1]],
    &["env", MODEL_ALIASES[2]],
    &["env", MODEL_ALIASES[3]],
];

/// `http://127.0.0.1:<port>/v1` → `http://127.0.0.1:<port>`.
pub fn anthropic_base(base_url: &str) -> &str {
    let base = base_url.trim_end_matches('/');
    base.strip_suffix("/v1").unwrap_or(base)
}

pub fn spec(config_dir: &Path) -> AgentSpec {
    AgentSpec {
        id: "claude-code",
        name: "Claude Code",
        files: vec![FileSpec {
            path: config_dir.join("settings.json"),
            render: Render::Json(render),
        }],
        current_model: |docs| {
            docs[0]
                .as_ref()
                .and_then(|doc| lookup_str(doc, &["env", MODEL]))
                .map(str::to_string)
        },
        points_to_gateway: |docs, base_url| {
            docs[0]
                .as_ref()
                .and_then(|doc| lookup_str(doc, &["env", BASE_URL]))
                .map(|url| url.trim_end_matches('/'))
                == Some(anthropic_base(base_url))
        },
        warnings: Box::new(warnings),
    }
}

fn render(doc: &mut Map<String, Value>, target: &AgentTarget<'_>) -> Result<(), String> {
    let env = object_at(doc, "env")?;
    env.insert(
        BASE_URL.into(),
        Value::from(anthropic_base(target.base_url)),
    );
    env.insert(AUTH_TOKEN.into(), Value::from(target.token));
    env.insert(MODEL.into(), Value::from(target.model));
    for alias in MODEL_ALIASES {
        env.insert(alias.into(), Value::from(target.model));
    }
    Ok(())
}

fn warnings(docs: &Docs) -> Vec<String> {
    let Some(doc) = docs[0].as_ref() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if lookup(doc, &["apiKeyHelper"]).is_some() {
        out.push(
            "settings.json 配置了 apiKeyHelper，它给出的密钥会顶替网关令牌，请求会被网关拒绝；接入前请先移除。"
                .to_string(),
        );
    }
    if lookup(doc, &["env", "ANTHROPIC_API_KEY"]).is_some() {
        out.push(
            "settings.json 的 env 里还有 ANTHROPIC_API_KEY；网关只认本地令牌，建议移除，避免 Claude Code 询问用哪个凭据。"
                .to_string(),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::gateway::agent_config::test_support::*;
    use crate::gateway::agent_config::AgentConfig;

    fn config(dir: &Path) -> AgentConfig {
        AgentConfig::new(spec(&dir.join(".claude")), &dir.join("gateway")).managed_keys(MANAGED)
    }

    fn settings(dir: &Path) -> std::path::PathBuf {
        dir.join(".claude/settings.json")
    }

    #[test]
    fn writes_env_without_v1_and_hides_other_settings_from_preview() {
        let dir = temp_dir("claude-write");
        fs::create_dir_all(dir.join(".claude")).unwrap();
        fs::write(
            settings(&dir),
            br#"{"model":"opus","env":{"DISABLE_TELEMETRY":"1","OTHER_SECRET":"sk-user"},"statusLine":{"type":"command","command":"line.sh"}}"#,
        )
        .unwrap();
        let config = config(&dir);
        assert!(!config.inspect(BASE).unwrap().points_to_gateway);

        let preview = config.preview(&target("deepseek/deepseek-chat")).unwrap();
        assert!(preview.changed);
        assert!(!preview.diff.contains(TOKEN));
        assert!(!preview.diff.contains("sk-user"), "{}", preview.diff);
        assert!(!preview.diff.contains("statusLine"));
        assert!(preview.diff.contains("env.ANTHROPIC_BASE_URL"));
        config
            .apply(
                &target("deepseek/deepseek-chat"),
                Some(&preview.before_version),
            )
            .unwrap();

        let written = read_json(&settings(&dir));
        let env = &written["env"];
        assert_eq!(env[BASE_URL], "http://127.0.0.1:3462");
        assert_eq!(env[AUTH_TOKEN], TOKEN);
        assert_eq!(env[MODEL], "deepseek/deepseek-chat");
        assert_eq!(
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"],
            "deepseek/deepseek-chat"
        );
        assert_eq!(env["DISABLE_TELEMETRY"], "1");
        assert_eq!(written["statusLine"]["command"], "line.sh");
        assert_eq!(written["model"], "opus");
        let inspection = config.inspect(BASE).unwrap();
        assert!(inspection.points_to_gateway);
        assert_eq!(inspection.model.as_deref(), Some("deepseek/deepseek-chat"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_keeps_later_status_line_and_env_edits() {
        let dir = temp_dir("claude-restore");
        fs::create_dir_all(dir.join(".claude")).unwrap();
        fs::write(
            settings(&dir),
            br#"{"env":{"ANTHROPIC_MODEL":"claude-opus-4-1","DISABLE_TELEMETRY":"1"}}"#,
        )
        .unwrap();
        let config = config(&dir);
        config
            .apply(&target("deepseek/deepseek-chat"), None)
            .unwrap();

        // The status line setup and the user edit other keys afterwards.
        let mut edited = read_json(&settings(&dir));
        edited.insert(
            "statusLine".into(),
            serde_json::json!({"type": "command", "command": "tokenledger --claude-statusline"}),
        );
        edited["env"]
            .as_object_mut()
            .unwrap()
            .insert("MY_FLAG".into(), Value::from("on"));
        fs::write(settings(&dir), serde_json::to_vec(&edited).unwrap()).unwrap();
        let backup = config.inspect(BASE).unwrap().backup.unwrap();
        assert!(backup.restorable_without_force);

        // Re-applying keeps the pre-gateway values as the restore point.
        assert!(
            !config
                .apply(&target("group/coding"), None)
                .unwrap()
                .backup_created
        );
        config.restore(false).unwrap();
        let restored = read_json(&settings(&dir));
        assert_eq!(
            restored["statusLine"]["command"],
            "tokenledger --claude-statusline"
        );
        let env = restored["env"].as_object().unwrap();
        assert_eq!(env["MY_FLAG"], "on");
        assert_eq!(env["DISABLE_TELEMETRY"], "1");
        assert_eq!(env[MODEL], "claude-opus-4-1");
        assert!(!env.contains_key(BASE_URL));
        assert!(!env.contains_key(AUTH_TOKEN));
        assert!(!env.contains_key("ANTHROPIC_DEFAULT_HAIKU_MODEL"));
        assert!(config.inspect(BASE).unwrap().backup.is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_after_managed_key_edit_needs_force() {
        let dir = temp_dir("claude-conflict");
        let config = config(&dir);
        config
            .apply(&target("deepseek/deepseek-chat"), None)
            .unwrap();
        let mut edited = read_json(&settings(&dir));
        edited["env"]
            .as_object_mut()
            .unwrap()
            .insert(BASE_URL.into(), Value::from("https://api.example.com"));
        edited.insert("theme".into(), Value::from("dark"));
        fs::write(settings(&dir), serde_json::to_vec(&edited).unwrap()).unwrap();

        assert!(
            !config
                .inspect(BASE)
                .unwrap()
                .backup
                .unwrap()
                .restorable_without_force
        );
        let error = config.restore(false).unwrap_err();
        assert!(error.contains("强制恢复"), "{error}");
        config.restore(true).unwrap();
        // The file did not exist before; only the user's own key is left.
        let restored = read_json(&settings(&dir));
        assert_eq!(restored.keys().collect::<Vec<_>>(), ["theme"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn created_file_is_removed_when_nothing_else_was_added() {
        let dir = temp_dir("claude-created");
        let config = config(&dir);
        config
            .apply(&target("deepseek/deepseek-chat"), None)
            .unwrap();
        assert!(settings(&dir).exists());
        assert!(config.restore(false).unwrap().removed);
        assert!(!settings(&dir).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn warns_about_credentials_that_override_the_gateway_token() {
        let dir = temp_dir("claude-warn");
        fs::create_dir_all(dir.join(".claude")).unwrap();
        fs::write(
            settings(&dir),
            br#"{"apiKeyHelper":"~/bin/key.sh","env":{"ANTHROPIC_API_KEY":"sk-ant"}}"#,
        )
        .unwrap();
        let warnings = config(&dir).inspect(BASE).unwrap().warnings;
        assert_eq!(warnings.len(), 2);
        assert!(warnings[0].contains("apiKeyHelper"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn base_url_drops_only_a_trailing_v1() {
        assert_eq!(
            anthropic_base("http://127.0.0.1:3462/v1"),
            "http://127.0.0.1:3462"
        );
        assert_eq!(
            anthropic_base("http://127.0.0.1:3462/v1/"),
            "http://127.0.0.1:3462"
        );
        assert_eq!(
            anthropic_base("http://127.0.0.1:3462"),
            "http://127.0.0.1:3462"
        );
    }
}
