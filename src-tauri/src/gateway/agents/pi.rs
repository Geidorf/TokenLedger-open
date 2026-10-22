//! Pi coding agent: `models.json` in `$PI_CODING_AGENT_DIR` (or
//! `~/.pi/agent`) gets an `openai-completions` provider named `tokenledger`,
//! and `settings.json` selects it as the default provider and model. Costs are
//! zero here because TokenLedger prices requests itself.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::gateway::agent_config::{
    array_at, lookup_str, object_at, AgentSpec, AgentTarget, Docs, FileSpec, Render, PROVIDER_ID,
};

const CONTEXT_WINDOW: u64 = 128_000;
const MAX_TOKENS: u64 = 8_192;

pub fn spec(agent_dir: &Path) -> AgentSpec {
    AgentSpec {
        id: "pi",
        name: "Pi",
        files: vec![
            FileSpec {
                path: agent_dir.join("models.json"),
                render: Render::Json(render_models),
            },
            FileSpec {
                path: agent_dir.join("settings.json"),
                render: Render::Json(render_settings),
            },
        ],
        current_model: |docs| {
            docs[1]
                .as_ref()
                .and_then(|doc| lookup_str(doc, &["defaultModel"]))
                .map(str::to_string)
        },
        points_to_gateway: |docs, base_url| {
            let models = docs[0]
                .as_ref()
                .and_then(|doc| lookup_str(doc, &["providers", PROVIDER_ID, "baseUrl"]));
            let selected = docs[1]
                .as_ref()
                .and_then(|doc| lookup_str(doc, &["defaultProvider"]));
            models == Some(base_url) && selected == Some(PROVIDER_ID)
        },
        warnings: Box::new(|_: &Docs| Vec::new()),
    }
}

fn render_models(doc: &mut Map<String, Value>, target: &AgentTarget<'_>) -> Result<(), String> {
    let provider = object_at(object_at(doc, "providers")?, PROVIDER_ID)?;
    provider.insert("baseUrl".into(), Value::from(target.base_url));
    provider.insert("api".into(), Value::from("openai-completions"));
    provider.insert("apiKey".into(), Value::from(target.token));
    let models = array_at(provider, "models")?;
    models.retain(|model| model.get("id").and_then(Value::as_str) != Some(target.model));
    models.push(json!({
        "id": target.model,
        "name": target.model,
        "reasoning": false,
        "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": CONTEXT_WINDOW,
        "maxTokens": MAX_TOKENS,
    }));
    Ok(())
}

fn render_settings(doc: &mut Map<String, Value>, target: &AgentTarget<'_>) -> Result<(), String> {
    doc.insert("defaultProvider".into(), Value::from(PROVIDER_ID));
    doc.insert("defaultModel".into(), Value::from(target.model));
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::gateway::agent_config::test_support::*;
    use crate::gateway::agent_config::AgentConfig;

    #[test]
    fn writes_both_files_and_restores_each() {
        let dir = temp_dir("pi");
        let settings = dir.join("settings.json");
        let original =
            br#"{"theme":"dark","defaultProvider":"anthropic","defaultModel":"claude-sonnet-4-5"}"#;
        fs::write(&settings, original).unwrap();
        let config = AgentConfig::new(spec(&dir), &dir.join("gateway"));
        assert_eq!(
            config.inspect(BASE).unwrap().model.as_deref(),
            Some("claude-sonnet-4-5")
        );

        let preview = config.preview(&target("deepseek/deepseek-chat")).unwrap();
        assert!(preview.diff.contains("models.json"));
        assert!(preview.diff.contains("settings.json"));
        assert!(!preview.diff.contains(TOKEN));
        config
            .apply(
                &target("deepseek/deepseek-chat"),
                Some(&preview.before_version),
            )
            .unwrap();

        let models = read_json(&dir.join("models.json"));
        let provider = &models["providers"][PROVIDER_ID];
        assert_eq!(provider["baseUrl"], BASE);
        assert_eq!(provider["api"], "openai-completions");
        assert_eq!(provider["apiKey"], TOKEN);
        assert_eq!(provider["models"][0]["id"], "deepseek/deepseek-chat");
        let written = read_json(&settings);
        assert_eq!(written["theme"], "dark");
        assert_eq!(written["defaultProvider"], PROVIDER_ID);
        assert_eq!(written["defaultModel"], "deepseek/deepseek-chat");
        assert!(config.inspect(BASE).unwrap().points_to_gateway);

        let restored = config.restore(false).unwrap();
        assert!(restored.removed, "models.json did not exist before");
        assert!(!dir.join("models.json").exists());
        assert_eq!(fs::read(&settings).unwrap(), original);
        let _ = fs::remove_dir_all(dir);
    }
}
