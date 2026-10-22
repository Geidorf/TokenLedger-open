//! Zed (T10.292): the user `settings.json` (JSONC) gets an OpenAI-compatible
//! provider `language_models.openai_compatible.tokenledger` and
//! `agent.default_model` points at it. Zed never reads API keys from
//! settings.json (keys live in the system keychain or `<ID>_API_KEY`), so no
//! token is written here; the user pastes the local token into Zed or sets
//! `TOKENLEDGER_API_KEY`.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::gateway::agent_config::{
    array_at, lookup_str, object_at, AgentSpec, AgentTarget, Docs, FileSpec, Render, PROVIDER_ID,
};

const MAX_TOKENS: u64 = 128_000;
pub const API_KEY_ENV: &str = "TOKENLEDGER_API_KEY";

pub fn spec(config_dir: &Path) -> AgentSpec {
    AgentSpec {
        id: "zed",
        name: "Zed",
        files: vec![FileSpec {
            path: config_dir.join("settings.json"),
            render: Render::Json(render),
        }],
        current_model: |docs| {
            docs[0]
                .as_ref()
                .and_then(|doc| lookup_str(doc, &["agent", "default_model", "model"]))
                .map(str::to_string)
        },
        points_to_gateway: |docs, base_url| {
            let Some(doc) = docs[0].as_ref() else {
                return false;
            };
            lookup_str(
                doc,
                &[
                    "language_models",
                    "openai_compatible",
                    PROVIDER_ID,
                    "api_url",
                ],
            ) == Some(base_url)
                && lookup_str(doc, &["agent", "default_model", "provider"]) == Some(PROVIDER_ID)
        },
        warnings: Box::new(|_: &Docs| {
            vec![
                format!(
                    "Zed 不从 settings.json 读密钥：在 Zed 的 Agent 设置 → LLM Providers → {PROVIDER_ID} 粘贴本地网关 token（由 Zed 存入系统钥匙串），或在启动 Zed 的环境里设置 {API_KEY_ENV}。"
                ),
                "项目目录里的 .zed/settings.json 优先级更高，会覆盖这里的设置。".to_string(),
            ]
        }),
    }
}

fn render(doc: &mut Map<String, Value>, target: &AgentTarget<'_>) -> Result<(), String> {
    let compatible = object_at(object_at(doc, "language_models")?, "openai_compatible")?;
    let provider = object_at(compatible, PROVIDER_ID)?;
    provider.insert("api_url".into(), Value::from(target.base_url));
    let models = array_at(provider, "available_models")?;
    models.retain(|model| model.get("name").and_then(Value::as_str) != Some(target.model));
    models.push(json!({
        "name": target.model,
        "display_name": target.model,
        "max_tokens": MAX_TOKENS,
    }));
    let default_model = object_at(object_at(doc, "agent")?, "default_model")?;
    default_model.insert("provider".into(), Value::from(PROVIDER_ID));
    default_model.insert("model".into(), Value::from(target.model));
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::gateway::agent_config::test_support::*;
    use crate::gateway::agent_config::AgentConfig;

    const SETTINGS: &str = "// Zed settings\n//\n// For information on how to configure Zed, see the Zed\n// documentation: https://zed.dev/docs/configuring-zed\n{\n  \"theme\": {\n    \"mode\": \"system\",\n    \"light\": \"One Light\",\n    \"dark\": \"One Dark\", // night\n  },\n  \"agent\": {\n    \"default_model\": {\n      \"provider\": \"anthropic\",\n      \"model\": \"claude-sonnet-4\",\n    },\n  },\n  /* fonts */\n  \"buffer_font_size\": 15,\n}\n";

    #[test]
    fn patches_jsonc_settings_keeps_comments_and_never_writes_the_token() {
        let dir = temp_dir("zed");
        let path = dir.join("settings.json");
        fs::write(&path, SETTINGS).unwrap();
        let config = AgentConfig::new(spec(&dir), &dir.join("gateway"));
        let inspection = config.inspect(BASE).unwrap();
        assert_eq!(inspection.model.as_deref(), Some("claude-sonnet-4"));
        assert!(!inspection.points_to_gateway);
        assert!(inspection.warnings[0].contains(API_KEY_ENV));

        let preview = config.preview(&target("group/coding")).unwrap();
        assert!(preview.changed);
        config
            .apply(&target("group/coding"), Some(&preview.before_version))
            .unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(!written.contains(TOKEN));
        for kept in [
            "// Zed settings\n//\n// For information",
            "\"dark\": \"One Dark\", // night\n",
            "/* fonts */\n  \"buffer_font_size\": 15,\n",
            "\"provider\": \"tokenledger\",\n      \"model\": \"group/coding\",\n",
        ] {
            assert!(written.contains(kept), "missing {kept:?} in\n{written}");
        }
        assert!(written.contains(
            "  \"buffer_font_size\": 15,\n  \"language_models\": {\n    \"openai_compatible\": {\n      \"tokenledger\": {\n        \"api_url\": \"http://127.0.0.1:3462/v1\","
        ));
        let inspection = config.inspect(BASE).unwrap();
        assert!(inspection.points_to_gateway);
        assert_eq!(inspection.model.as_deref(), Some("group/coding"));

        config
            .apply(&target("deepseek/deepseek-chat"), None)
            .unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("\"name\": \"group/coding\""));
        assert!(written.contains("\"name\": \"deepseek/deepseek-chat\""));

        config.restore(false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), SETTINGS);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn creates_settings_and_refuses_unsafe_structures() {
        let dir = temp_dir("zed-new");
        let config = AgentConfig::new(spec(&dir), &dir.join("gateway"));
        config.apply(&target("a/b"), None).unwrap();
        let written = read_json(&dir.join("settings.json"));
        assert_eq!(
            lookup_str(&written, &["agent", "default_model", "provider"]),
            Some(PROVIDER_ID)
        );
        config.restore(false).unwrap();
        assert!(!dir.join("settings.json").exists());

        let path = dir.join("settings.json");
        fs::write(&path, "{ // c\n \"agent\": { \"default_model\": \"x\" } }").unwrap();
        assert!(config
            .preview(&target("a/b"))
            .unwrap_err()
            .contains("不是对象"));

        let commented = "{ // c\n \"agent\": { \"default_model\": { \"provider\": \"zed.dev\" /* hosted */, \"model\": \"m\" } },\n \"agent\": {} }";
        fs::write(&path, commented).unwrap();
        let error = config.preview(&target("a/b")).unwrap_err();
        assert!(error.contains("无法安全定位"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), commented);
        let _ = fs::remove_dir_all(dir);
    }
}
