//! Goose: a declarative custom provider `custom_providers/tokenledger.json`
//! (OpenAI engine, `requires_auth: false`, the local token sent as an
//! `Authorization` header) plus `active_provider` and
//! `providers.tokenledger.model` in `config.yaml`. Goose keeps provider keys
//! in the system keychain; going through a header leaves the keychain alone.
//! Legacy flat `GOOSE_PROVIDER`/`GOOSE_MODEL` keys are updated when present.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::gateway::agent_config::{
    array_at, lookup_str, object_at, AgentSpec, AgentTarget, Docs, FileSpec, Render, PROVIDER_ID,
    PROVIDER_NAME,
};
use crate::gateway::agents::yaml::{render as yaml, YamlDoc};

const CONTEXT_LIMIT: u64 = 128_000;

pub fn spec(config_dir: &Path) -> AgentSpec {
    AgentSpec {
        id: "goose",
        name: "Goose",
        files: vec![
            FileSpec {
                path: config_dir
                    .join("custom_providers")
                    .join(format!("{PROVIDER_ID}.json")),
                render: Render::Json(render_provider),
            },
            FileSpec {
                path: config_dir.join("config.yaml"),
                render: Render::Yaml(render_config),
            },
        ],
        current_model: |docs| {
            let doc = docs[1].as_ref()?;
            let active = active_provider(doc)?;
            lookup_str(doc, &["providers", active, "model"])
                .or_else(|| lookup_str(doc, &["GOOSE_MODEL"]))
                .map(str::to_string)
        },
        points_to_gateway: |docs, base_url| {
            let provider = docs[0]
                .as_ref()
                .and_then(|doc| lookup_str(doc, &["base_url"]));
            let active = docs[1].as_ref().and_then(active_provider);
            provider == Some(base_url) && active == Some(PROVIDER_ID)
        },
        warnings: Box::new(|_: &Docs| {
            let mut warnings = Vec::new();
            for var in ["GOOSE_PROVIDER", "GOOSE_MODEL"] {
                if std::env::var_os(var).is_some() {
                    warnings.push(format!(
                        "环境变量 {var} 已设置，会覆盖配置文件里的供应商或模型。"
                    ));
                }
            }
            warnings
        }),
    }
}

fn active_provider(doc: &Map<String, Value>) -> Option<&str> {
    lookup_str(doc, &["active_provider"]).or_else(|| lookup_str(doc, &["GOOSE_PROVIDER"]))
}

fn render_provider(doc: &mut Map<String, Value>, target: &AgentTarget<'_>) -> Result<(), String> {
    doc.insert("name".into(), Value::from(PROVIDER_ID));
    doc.insert("engine".into(), Value::from("openai"));
    doc.insert("display_name".into(), Value::from(PROVIDER_NAME));
    doc.insert("api_key_env".into(), Value::from(""));
    doc.insert("base_url".into(), Value::from(target.base_url));
    let models = array_at(doc, "models")?;
    models.retain(|model| model.get("name").and_then(Value::as_str) != Some(target.model));
    models.push(json!({ "name": target.model, "context_limit": CONTEXT_LIMIT }));
    object_at(doc, "headers")?.insert(
        "Authorization".into(),
        Value::from(format!("Bearer {}", target.token)),
    );
    doc.insert("supports_streaming".into(), Value::Bool(true));
    doc.insert("requires_auth".into(), Value::Bool(false));
    Ok(())
}

fn render_config(doc: &mut YamlDoc, target: &AgentTarget<'_>) -> Result<(), String> {
    let current = doc.to_map()?;
    let provider = yaml(&Value::from(PROVIDER_ID));
    let model = yaml(&Value::from(target.model));
    doc.set(&["active_provider"], &provider)?;
    doc.set(&["providers", PROVIDER_ID, "enabled"], "true")?;
    doc.set(&["providers", PROVIDER_ID, "model"], &model)?;
    doc.set(&["providers", PROVIDER_ID, "configured"], "true")?;
    if current.contains_key("GOOSE_PROVIDER") {
        doc.set(&["GOOSE_PROVIDER"], &provider)?;
    }
    if current.contains_key("GOOSE_MODEL") {
        doc.set(&["GOOSE_MODEL"], &model)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::gateway::agent_config::test_support::*;
    use crate::gateway::agent_config::AgentConfig;

    #[test]
    fn writes_custom_provider_and_selection_without_the_keychain() {
        let dir = temp_dir("goose");
        let config_path = dir.join("config.yaml");
        let original = "# goose\nactive_provider: anthropic\nproviders:\n  anthropic:\n    enabled: true\n    model: claude-sonnet-4-5\n    configured: true\nGOOSE_MODEL: claude-sonnet-4-5\nextensions:\n  developer:\n    enabled: true\n";
        fs::write(&config_path, original).unwrap();
        let config = AgentConfig::new(spec(&dir), &dir.join("gateway"));
        assert_eq!(
            config.inspect(BASE).unwrap().model.as_deref(),
            Some("claude-sonnet-4-5")
        );

        let preview = config.preview(&target("group/coding")).unwrap();
        assert!(!preview.diff.contains(TOKEN));
        assert!(preview.diff.contains("tokenledger.json"));
        config
            .apply(&target("group/coding"), Some(&preview.before_version))
            .unwrap();

        let provider = read_json(&dir.join("custom_providers/tokenledger.json"));
        assert_eq!(provider["engine"], "openai");
        assert_eq!(provider["base_url"], BASE);
        assert_eq!(provider["requires_auth"], false);
        assert_eq!(provider["api_key_env"], "");
        assert_eq!(
            provider["headers"]["Authorization"],
            format!("Bearer {TOKEN}")
        );
        assert_eq!(provider["models"][0]["name"], "group/coding");

        assert_eq!(
            fs::read_to_string(&config_path).unwrap(),
            "# goose\nactive_provider: \"tokenledger\"\nproviders:\n  anthropic:\n    enabled: true\n    model: claude-sonnet-4-5\n    configured: true\n  tokenledger:\n    enabled: true\n    model: \"group/coding\"\n    configured: true\nGOOSE_MODEL: \"group/coding\"\nextensions:\n  developer:\n    enabled: true\n"
        );
        let after = config.inspect(BASE).unwrap();
        assert!(after.points_to_gateway);
        assert_eq!(after.model.as_deref(), Some("group/coding"));

        let restored = config.restore(false).unwrap();
        assert!(restored.removed);
        assert!(!dir.join("custom_providers/tokenledger.json").exists());
        assert_eq!(fs::read_to_string(&config_path).unwrap(), original);
        let _ = fs::remove_dir_all(dir);
    }
}
