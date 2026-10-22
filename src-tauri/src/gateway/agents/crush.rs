//! Crush: the global `crush.json` gets an `openai-compat` provider named
//! `tokenledger`, and `models.large` points at it. The chosen gateway model is
//! added to the provider's model list (replacing an entry with the same id).

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::gateway::agent_config::{
    array_at, lookup_str, object_at, AgentSpec, AgentTarget, Docs, FileSpec, Render, PROVIDER_ID,
    PROVIDER_NAME,
};

const CONTEXT_WINDOW: u64 = 128_000;
const MAX_TOKENS: u64 = 8_192;

pub fn spec(config_dir: &Path) -> AgentSpec {
    AgentSpec {
        id: "crush",
        name: "Crush",
        files: vec![FileSpec {
            path: config_dir.join("crush.json"),
            render: Render::Json(render),
        }],
        current_model: |docs| {
            docs[0]
                .as_ref()
                .and_then(|doc| lookup_str(doc, &["models", "large", "model"]))
                .map(str::to_string)
        },
        points_to_gateway: |docs, base_url| {
            let Some(doc) = docs[0].as_ref() else {
                return false;
            };
            lookup_str(doc, &["providers", PROVIDER_ID, "base_url"]) == Some(base_url)
                && lookup_str(doc, &["models", "large", "provider"]) == Some(PROVIDER_ID)
        },
        warnings: Box::new(|_: &Docs| {
            let mut warnings = Vec::new();
            if std::env::var_os("CRUSH_GLOBAL_CONFIG").is_some() {
                warnings.push(
                    "环境变量 CRUSH_GLOBAL_CONFIG 指向了另一处全局配置，Crush 可能不读这份文件。"
                        .to_string(),
                );
            }
            warnings.push(
                "项目目录里的 crush.json / .crush.json 优先级更高，会覆盖这里的设置。".to_string(),
            );
            warnings
        }),
    }
}

fn render(doc: &mut Map<String, Value>, target: &AgentTarget<'_>) -> Result<(), String> {
    let provider = object_at(object_at(doc, "providers")?, PROVIDER_ID)?;
    provider.insert("name".into(), Value::from(PROVIDER_NAME));
    provider.insert("type".into(), Value::from("openai-compat"));
    provider.insert("base_url".into(), Value::from(target.base_url));
    provider.insert("api_key".into(), Value::from(target.token));
    let models = array_at(provider, "models")?;
    models.retain(|model| model.get("id").and_then(Value::as_str) != Some(target.model));
    models.push(json!({
        "id": target.model,
        "name": target.model,
        "context_window": CONTEXT_WINDOW,
        "default_max_tokens": MAX_TOKENS,
    }));
    let large = object_at(object_at(doc, "models")?, "large")?;
    large.insert("provider".into(), Value::from(PROVIDER_ID));
    large.insert("model".into(), Value::from(target.model));
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::gateway::agent_config::test_support::*;
    use crate::gateway::agent_config::AgentConfig;

    #[test]
    fn writes_provider_and_large_model_and_keeps_the_rest() {
        let dir = temp_dir("crush");
        let path = dir.join("crush.json");
        let original = br#"{"options":{"debug":true},"models":{"small":{"provider":"openai","model":"gpt-4o-mini"},"large":{"provider":"openai","model":"gpt-4o"}},"providers":{"tokenledger":{"models":[{"id":"group/coding","name":"old"},{"id":"keep/me","name":"keep"}]}}}"#;
        fs::write(&path, original).unwrap();
        let config = AgentConfig::new(spec(&dir), &dir.join("gateway"));
        assert_eq!(
            config.inspect(BASE).unwrap().model.as_deref(),
            Some("gpt-4o")
        );

        config.apply(&target("group/coding"), None).unwrap();
        let written = read_json(&path);
        assert_eq!(
            lookup_str(&written, &["models", "small", "model"]),
            Some("gpt-4o-mini")
        );
        assert_eq!(
            lookup_str(&written, &["models", "large", "provider"]),
            Some(PROVIDER_ID)
        );
        assert_eq!(
            written["options"]["debug"],
            Value::Bool(true),
            "unrelated options survive"
        );
        let provider = &written["providers"][PROVIDER_ID];
        assert_eq!(provider["type"], "openai-compat");
        assert_eq!(provider["base_url"], BASE);
        assert_eq!(provider["api_key"], TOKEN);
        let ids: Vec<_> = provider["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| model["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["keep/me", "group/coding"]);
        assert!(config.inspect(BASE).unwrap().points_to_gateway);

        config.restore(false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_a_non_array_model_list() {
        let dir = temp_dir("crush-bad");
        let path = dir.join("crush.json");
        fs::write(&path, br#"{"providers":{"tokenledger":{"models":{}}}}"#).unwrap();
        let config = AgentConfig::new(spec(&dir), &dir.join("gateway"));
        assert!(config
            .preview(&target("a/b"))
            .unwrap_err()
            .contains("不是数组"));
        let _ = fs::remove_dir_all(dir);
    }
}
