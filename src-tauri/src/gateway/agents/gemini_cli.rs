//! Gemini CLI (T10.290): `settings.json` switches auth to an API key and
//! picks the gateway model; `.env` next to it holds `GOOGLE_GEMINI_BASE_URL`
//! (the gateway root, Gemini's SDK appends `/v1beta/...`) and
//! `GEMINI_API_KEY` (the local gateway token). Google sign-in credentials are
//! never read or reused.

use std::path::Path;

use serde_json::{Map, Value};

use crate::gateway::agent_config::{
    lookup_str, object_at, AgentSpec, AgentTarget, Docs, FileSpec, Render,
};

const AUTH_TYPE: &str = "gemini-api-key";
const BASE_URL_VAR: &str = "GOOGLE_GEMINI_BASE_URL";
const API_KEY_VAR: &str = "GEMINI_API_KEY";

/// The gateway serves Gemini routes at its root, not under `/v1`.
fn gemini_base(base_url: &str) -> &str {
    let trimmed = base_url.trim_end_matches('/');
    trimmed.strip_suffix("/v1").unwrap_or(trimmed)
}

pub fn spec(config_dir: &Path) -> AgentSpec {
    AgentSpec {
        id: "gemini-cli",
        name: "Gemini CLI",
        files: vec![
            FileSpec {
                path: config_dir.join("settings.json"),
                render: Render::Json(render_settings),
            },
            FileSpec {
                path: config_dir.join(".env"),
                render: Render::Json(render_env),
            },
        ],
        current_model: |docs| {
            docs[0]
                .as_ref()
                .and_then(|doc| lookup_str(doc, &["model", "name"]))
                .map(str::to_string)
        },
        points_to_gateway: |docs, base_url| {
            let auth = docs[0]
                .as_ref()
                .and_then(|doc| lookup_str(doc, &["security", "auth", "selectedType"]));
            let base = docs[1]
                .as_ref()
                .and_then(|doc| lookup_str(doc, &[BASE_URL_VAR]));
            auth == Some(AUTH_TYPE) && base == Some(gemini_base(base_url))
        },
        warnings: Box::new(|_: &Docs| {
            let mut warnings = vec![
                "Gemini CLI 只在受信任的文件夹里读取这份 .env；在未受信任的文件夹里不会走网关。"
                    .to_string(),
                "项目目录（或其上级）里的 .gemini/.env、.env 会先被读到，届时不再读这份文件。"
                    .to_string(),
            ];
            let exported: Vec<&str> = [BASE_URL_VAR, API_KEY_VAR]
                .into_iter()
                .filter(|var| std::env::var_os(var).is_some())
                .collect();
            if !exported.is_empty() {
                warnings.push(format!(
                    "当前环境已导出 {}，它们优先于 .env，请在 shell 配置里去掉。",
                    exported.join("、")
                ));
            }
            warnings
        }),
    }
}

fn render_settings(doc: &mut Map<String, Value>, target: &AgentTarget<'_>) -> Result<(), String> {
    let auth = object_at(object_at(doc, "security")?, "auth")?;
    auth.insert("selectedType".into(), Value::from(AUTH_TYPE));
    object_at(doc, "model")?.insert("name".into(), Value::from(target.model));
    Ok(())
}

fn render_env(doc: &mut Map<String, Value>, target: &AgentTarget<'_>) -> Result<(), String> {
    doc.insert(
        BASE_URL_VAR.into(),
        Value::from(gemini_base(target.base_url)),
    );
    doc.insert(API_KEY_VAR.into(), Value::from(target.token));
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::gateway::agent_config::test_support::*;
    use crate::gateway::agent_config::AgentConfig;

    #[test]
    fn writes_auth_model_and_env_and_keeps_the_rest() {
        let dir = temp_dir("gemini-cli");
        let settings = dir.join("settings.json");
        let env = dir.join(".env");
        let original_settings = br#"{"ui":{"theme":"Dracula"},"security":{"auth":{"selectedType":"oauth-personal"},"folderTrust":{"enabled":true}},"model":{"name":"gemini-2.5-pro","maxSessionTurns":10}}"#;
        let original_env = "# mine\nexport OTHER=1\nGEMINI_API_KEY=\"AIza-old\"\n\nGOOGLE_CLOUD_PROJECT=p # note\n";
        fs::write(&settings, original_settings).unwrap();
        fs::write(&env, original_env).unwrap();
        let config = AgentConfig::new(spec(&dir), &dir.join("gateway"));
        let before = config.inspect(BASE).unwrap();
        assert_eq!(before.model.as_deref(), Some("gemini-2.5-pro"));
        assert!(!before.points_to_gateway);

        let preview = config.preview(&target("deepseek/deepseek-chat")).unwrap();
        assert!(!preview.diff.contains(TOKEN));
        assert!(preview.diff.contains("GEMINI_API_KEY=tl-…abcd"));
        config
            .apply(
                &target("deepseek/deepseek-chat"),
                Some(&preview.before_version),
            )
            .unwrap();

        let written = read_json(&settings);
        assert_eq!(
            lookup_str(&written, &["security", "auth", "selectedType"]),
            Some(AUTH_TYPE)
        );
        assert_eq!(written["security"]["folderTrust"]["enabled"], true);
        assert_eq!(written["ui"]["theme"], "Dracula");
        assert_eq!(written["model"]["maxSessionTurns"], 10);
        assert_eq!(
            lookup_str(&written, &["model", "name"]),
            Some("deepseek/deepseek-chat")
        );
        let env_text = fs::read_to_string(&env).unwrap();
        assert_eq!(
            env_text,
            format!(
                "# mine\nexport OTHER=1\nGEMINI_API_KEY={TOKEN}\n\nGOOGLE_CLOUD_PROJECT=p # note\nGOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3462\n"
            )
        );
        assert!(!env_text.contains("sk-"));
        let after = config.inspect(BASE).unwrap();
        assert!(after.points_to_gateway);
        assert_eq!(after.model.as_deref(), Some("deepseek/deepseek-chat"));

        config.restore(false).unwrap();
        assert_eq!(fs::read(&settings).unwrap(), original_settings);
        assert_eq!(fs::read_to_string(&env).unwrap(), original_env);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_files_are_created_and_removed() {
        let dir = temp_dir("gemini-cli-new");
        let config = AgentConfig::new(spec(&dir.join(".gemini")), &dir.join("gateway"));
        config.apply(&target("group/coding"), None).unwrap();
        let env_text = fs::read_to_string(dir.join(".gemini/.env")).unwrap();
        assert_eq!(
            env_text,
            format!("GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3462\nGEMINI_API_KEY={TOKEN}\n")
        );
        assert!(config.restore(false).unwrap().removed);
        assert!(!dir.join(".gemini/.env").exists());
        assert!(!dir.join(".gemini/settings.json").exists());
        let _ = fs::remove_dir_all(dir);
    }
}
