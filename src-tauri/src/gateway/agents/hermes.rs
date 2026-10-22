//! Hermes Agent: the `model:` block of `config.yaml` in `$HERMES_HOME` (or
//! `~/.hermes`) switches to the `custom` OpenAI-compatible provider with the
//! gateway address, the local token and the gateway model as `default`.
//! Hermes also accepts `model:` as the model key, so an existing one is
//! updated too.

use std::path::Path;

use serde_json::Value;

use crate::gateway::agent_config::{
    lookup, lookup_str, AgentSpec, AgentTarget, Docs, FileSpec, Render,
};
use crate::gateway::agents::yaml::{render as yaml, YamlDoc};

pub fn spec(home: &Path) -> AgentSpec {
    AgentSpec {
        id: "hermes",
        name: "Hermes",
        files: vec![FileSpec {
            path: home.join("config.yaml"),
            render: Render::Yaml(render),
        }],
        current_model: |docs| {
            let doc = docs[0].as_ref()?;
            lookup_str(doc, &["model", "default"])
                .or_else(|| lookup_str(doc, &["model", "model"]))
                .or_else(|| lookup_str(doc, &["model"]))
                .map(str::to_string)
        },
        points_to_gateway: |docs, base_url| {
            let Some(doc) = docs[0].as_ref() else {
                return false;
            };
            lookup_str(doc, &["model", "provider"]) == Some("custom")
                && lookup_str(doc, &["model", "base_url"]) == Some(base_url)
        },
        warnings: Box::new(|_: &Docs| {
            vec!["启动时带 --model 或 --provider 参数会临时覆盖这里的设置。".to_string()]
        }),
    }
}

fn render(doc: &mut YamlDoc, target: &AgentTarget<'_>) -> Result<(), String> {
    let has_alias = lookup(&doc.to_map()?, &["model", "model"]).is_some();
    doc.set(&["model", "provider"], &yaml(&Value::from("custom")))?;
    doc.set(&["model", "base_url"], &yaml(&Value::from(target.base_url)))?;
    doc.set(&["model", "api_key"], &yaml(&Value::from(target.token)))?;
    doc.set(&["model", "default"], &yaml(&Value::from(target.model)))?;
    if has_alias {
        doc.set(&["model", "model"], &yaml(&Value::from(target.model)))?;
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
    fn rewrites_the_model_block_and_keeps_everything_else() {
        let dir = temp_dir("hermes");
        let path = dir.join("config.yaml");
        let original = "# Hermes\nmodel:\n  # chosen in setup\n  default: anthropic/claude-opus-4.6\n  provider: auto\n  base_url: https://openrouter.ai/api/v1\n  model: anthropic/claude-opus-4.6\nplugins:\n  enabled:\n    - orca-status\nauxiliary:\n  curator:\n    api_key: \"sk-aux\"\n";
        fs::write(&path, original).unwrap();
        let config = AgentConfig::new(spec(&dir), &dir.join("gateway"));
        assert_eq!(
            config.inspect(BASE).unwrap().model.as_deref(),
            Some("anthropic/claude-opus-4.6")
        );

        let preview = config.preview(&target("group/coding")).unwrap();
        assert!(!preview.diff.contains(TOKEN));
        config
            .apply(&target("group/coding"), Some(&preview.before_version))
            .unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert_eq!(
            written,
            format!("# Hermes\nmodel:\n  # chosen in setup\n  default: \"group/coding\"\n  provider: \"custom\"\n  base_url: \"{BASE}\"\n  model: \"group/coding\"\n  api_key: \"{TOKEN}\"\nplugins:\n  enabled:\n    - orca-status\nauxiliary:\n  curator:\n    api_key: \"sk-aux\"\n")
        );
        assert!(config.inspect(BASE).unwrap().points_to_gateway);

        config.restore(false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn adds_a_model_block_when_missing_and_refuses_a_string_model() {
        let dir = temp_dir("hermes-new");
        let path = dir.join("config.yaml");
        fs::write(&path, "display:\n  tool_progress: all\n").unwrap();
        let config = AgentConfig::new(spec(&dir), &dir.join("gateway"));
        config.apply(&target("a/b"), None).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(
            written.starts_with("display:\n  tool_progress: all\nmodel:\n  provider: \"custom\"\n")
        );

        fs::write(&path, "model: gpt-4o\n").unwrap();
        assert!(config
            .preview(&target("a/b"))
            .unwrap_err()
            .contains("不是块状映射"));
        let _ = fs::remove_dir_all(dir);
    }
}
