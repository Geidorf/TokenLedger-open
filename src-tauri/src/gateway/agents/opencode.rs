//! OpenCode: `opencode.json` in `$XDG_CONFIG_HOME/opencode` (or
//! `~/.config/opencode`) gets a `provider.tokenledger` entry using the
//! OpenAI-compatible AI SDK package, and `model` becomes
//! `tokenledger/<gateway model>`. OpenCode splits the reference at the first
//! `/`, so `group/<id>` and `provider/model` reach the gateway unchanged.

use std::path::Path;

use serde_json::{Map, Value};

use crate::gateway::agent_config::{
    lookup_str, object_at, AgentSpec, AgentTarget, Docs, FileSpec, Render, PROVIDER_ID,
    PROVIDER_NAME,
};

const NPM_PACKAGE: &str = "@ai-sdk/openai-compatible";

pub fn spec(config_dir: &Path) -> AgentSpec {
    let jsonc = config_dir.join("opencode.jsonc");
    AgentSpec {
        id: "opencode",
        name: "OpenCode",
        files: vec![FileSpec {
            path: config_dir.join("opencode.json"),
            render: Render::Json(render),
        }],
        current_model: |docs| model(docs).map(str::to_string),
        points_to_gateway: |docs, base_url| {
            let Some(doc) = docs[0].as_ref() else {
                return false;
            };
            lookup_str(doc, &["provider", PROVIDER_ID, "options", "baseURL"]) == Some(base_url)
                && model(docs).is_some_and(|model| model.starts_with("tokenledger/"))
        },
        warnings: Box::new(move |_: &Docs| {
            let mut warnings = Vec::new();
            if jsonc.exists() {
                warnings.push(format!(
                    "检测到 {}：OpenCode 会合并读取它，若其中也设置了 model 或 tokenledger 供应商，可能覆盖这次写入。",
                    jsonc.display()
                ));
            }
            if std::env::var_os("OPENCODE_CONFIG").is_some() {
                warnings.push(
                    "环境变量 OPENCODE_CONFIG 指向了另一份配置，OpenCode 启动时会叠加读取它。"
                        .to_string(),
                );
            }
            warnings
        }),
    }
}

fn model(docs: &Docs) -> Option<&str> {
    docs[0].as_ref().and_then(|doc| lookup_str(doc, &["model"]))
}

fn render(doc: &mut Map<String, Value>, target: &AgentTarget<'_>) -> Result<(), String> {
    let provider = object_at(object_at(doc, "provider")?, PROVIDER_ID)?;
    provider.insert("npm".into(), Value::from(NPM_PACKAGE));
    provider.insert("name".into(), Value::from(PROVIDER_NAME));
    let options = object_at(provider, "options")?;
    options.insert("baseURL".into(), Value::from(target.base_url));
    options.insert("apiKey".into(), Value::from(target.token));
    let models = object_at(provider, "models")?;
    object_at(models, target.model)?.insert("name".into(), Value::from(target.model));
    doc.insert(
        "model".into(),
        Value::from(format!("{PROVIDER_ID}/{}", target.model)),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::gateway::agent_config::test_support::*;
    use crate::gateway::agent_config::AgentConfig;

    #[test]
    fn writes_provider_and_model_and_keeps_other_providers() {
        let dir = temp_dir("opencode");
        let config_dir = dir.join("opencode");
        fs::create_dir_all(&config_dir).unwrap();
        let path = config_dir.join("opencode.json");
        let original = br#"{"$schema":"https://opencode.ai/config.json","theme":"tokyonight","model":"anthropic/claude-sonnet-4-5","provider":{"anthropic":{"options":{"apiKey":"sk-ant"}}}}"#;
        fs::write(&path, original).unwrap();
        let config = AgentConfig::new(spec(&config_dir), &dir.join("gateway"));

        let before = config.inspect(BASE).unwrap();
        assert!(!before.points_to_gateway);
        assert_eq!(before.model.as_deref(), Some("anthropic/claude-sonnet-4-5"));
        config.apply(&target("group/coding"), None).unwrap();

        let written = read_json(&path);
        assert_eq!(
            lookup_str(&written, &["model"]),
            Some("tokenledger/group/coding")
        );
        assert_eq!(lookup_str(&written, &["theme"]), Some("tokyonight"));
        assert_eq!(
            lookup_str(&written, &["provider", "anthropic", "options", "apiKey"]),
            Some("sk-ant")
        );
        for (path, value) in [
            (&["provider", PROVIDER_ID, "npm"][..], NPM_PACKAGE),
            (&["provider", PROVIDER_ID, "options", "baseURL"][..], BASE),
            (&["provider", PROVIDER_ID, "options", "apiKey"][..], TOKEN),
            (
                &["provider", PROVIDER_ID, "models", "group/coding", "name"][..],
                "group/coding",
            ),
        ] {
            assert_eq!(lookup_str(&written, path), Some(value), "{path:?}");
        }
        assert!(config.inspect(BASE).unwrap().points_to_gateway);
        let order: Vec<_> = written.keys().map(String::as_str).collect();
        assert_eq!(order, ["$schema", "theme", "model", "provider"]);
        let providers: Vec<_> = written["provider"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(providers, ["anthropic", PROVIDER_ID]);

        config.restore(false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn warns_about_a_sibling_jsonc() {
        let dir = temp_dir("opencode-jsonc");
        fs::write(dir.join("opencode.jsonc"), b"{}").unwrap();
        let config = AgentConfig::new(spec(&dir), &dir.join("gateway"));
        let preview = config.preview(&target("deepseek/deepseek-chat")).unwrap();
        assert!(preview
            .warnings
            .iter()
            .any(|w| w.contains("opencode.jsonc")));
        assert!(preview.diff.contains("tokenledger/deepseek/deepseek-chat"));
        assert!(!preview.diff.contains(TOKEN));
        let _ = fs::remove_dir_all(dir);
    }
}
