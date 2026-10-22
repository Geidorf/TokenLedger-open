//! Kimi CLI: `config.toml` in `$KIMI_SHARE_DIR` (or `~/.kimi`) gets an
//! `openai_legacy` (Chat Completions) provider named `tokenledger` and a model
//! entry `tokenledger/<gateway model>` that `default_model` selects. toml_edit
//! keeps the user's comments and other providers.

use std::path::Path;

use toml_edit::Document;

use crate::gateway::agent_config::{
    lookup_str, toml_child, toml_set, AgentSpec, AgentTarget, Docs, FileSpec, Render, PROVIDER_ID,
};

const CONTEXT_WINDOW: i64 = 128_000;

pub fn spec(share_dir: &Path) -> AgentSpec {
    AgentSpec {
        id: "kimi-cli",
        name: "Kimi CLI",
        files: vec![FileSpec {
            path: share_dir.join("config.toml"),
            render: Render::Toml(render),
        }],
        current_model: |docs| default_model(docs).map(str::to_string),
        points_to_gateway: |docs, base_url| {
            let (Some(doc), Some(selected)) = (docs[0].as_ref(), default_model(docs)) else {
                return false;
            };
            lookup_str(doc, &["providers", PROVIDER_ID, "base_url"]) == Some(base_url)
                && lookup_str(doc, &["models", selected, "provider"]) == Some(PROVIDER_ID)
        },
        warnings: Box::new(|_: &Docs| {
            vec!["用 --config-file 或 --config 启动 Kimi CLI 时不会读取这份配置。".to_string()]
        }),
    }
}

fn default_model(docs: &Docs) -> Option<&str> {
    docs[0]
        .as_ref()
        .and_then(|doc| lookup_str(doc, &["default_model"]))
}

fn render(doc: &mut Document, target: &AgentTarget<'_>) -> Result<(), String> {
    let root = doc.as_table_mut();
    let provider = toml_child(toml_child(root, "providers")?, PROVIDER_ID)?;
    toml_set(provider, "type", "openai_legacy");
    toml_set(provider, "base_url", target.base_url);
    toml_set(provider, "api_key", target.token);
    let key = format!("{PROVIDER_ID}/{}", target.model);
    let model = toml_child(toml_child(root, "models")?, &key)?;
    toml_set(model, "provider", PROVIDER_ID);
    toml_set(model, "model", target.model);
    toml_set(model, "max_context_size", CONTEXT_WINDOW);
    toml_set(root, "default_model", key.as_str());
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::gateway::agent_config::test_support::*;
    use crate::gateway::agent_config::AgentConfig;

    #[test]
    fn writes_provider_model_and_default_and_keeps_comments() {
        let dir = temp_dir("kimi");
        let path = dir.join("config.toml");
        let original = "# my kimi\ndefault_model = \"kimi-for-coding\" # main\ntheme = \"dark\"\n\n[providers.kimi-for-coding]\ntype = \"kimi\"\nbase_url = \"https://api.kimi.com/coding/v1\"\napi_key = \"sk-kimi\"\n\n[models.kimi-for-coding]\nprovider = \"kimi-for-coding\"\nmodel = \"kimi-for-coding\"\nmax_context_size = 262144\n";
        fs::write(&path, original).unwrap();
        let config = AgentConfig::new(spec(&dir), &dir.join("gateway"));
        let before = config.inspect(BASE).unwrap();
        assert_eq!(before.model.as_deref(), Some("kimi-for-coding"));
        assert!(!before.points_to_gateway);

        let preview = config.preview(&target("deepseek/deepseek-chat")).unwrap();
        assert!(!preview.diff.contains(TOKEN));
        config
            .apply(
                &target("deepseek/deepseek-chat"),
                Some(&preview.before_version),
            )
            .unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.starts_with(
            "# my kimi\ndefault_model = \"tokenledger/deepseek/deepseek-chat\" # main\n"
        ));
        assert!(written.contains("api_key = \"sk-kimi\""));
        assert!(written.contains("[providers.tokenledger]\ntype = \"openai_legacy\""));
        assert!(written.contains(&format!("base_url = \"{BASE}\"")));
        assert!(written.contains(&format!("api_key = \"{TOKEN}\"")));
        assert!(written.contains("[models.\"tokenledger/deepseek/deepseek-chat\"]\nprovider = \"tokenledger\"\nmodel = \"deepseek/deepseek-chat\"\nmax_context_size = 128000\n"));
        let after = config.inspect(BASE).unwrap();
        assert!(after.points_to_gateway);
        assert_eq!(
            after.model.as_deref(),
            Some("tokenledger/deepseek/deepseek-chat")
        );

        config.restore(false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_an_inline_provider_table() {
        let dir = temp_dir("kimi-inline");
        fs::write(
            dir.join("config.toml"),
            "providers = { tokenledger = {} }\n",
        )
        .unwrap();
        let config = AgentConfig::new(spec(&dir), &dir.join("gateway"));
        assert!(config
            .preview(&target("a/b"))
            .unwrap_err()
            .contains("不是标准表格"));
        let _ = fs::remove_dir_all(dir);
    }
}
