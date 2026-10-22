//! Oh My Pi: `models.yml` in the agent directory (`$PI_CODING_AGENT_DIR`, else
//! `~/.omp/agent`) gets an `openai-completions` provider named `tokenledger`,
//! written as one flow mapping so other providers' lines stay untouched, and
//! `config.yml` sets `modelRoles.default` to `tokenledger/<gateway model>`
//! (Oh My Pi splits the selector at the first `/`).

use std::path::Path;

use serde_json::json;

use crate::gateway::agent_config::{
    lookup_str, AgentSpec, AgentTarget, Docs, FileSpec, Render, PROVIDER_ID,
};
use crate::gateway::agents::yaml::{render as yaml, YamlDoc};

const CONTEXT_WINDOW: u64 = 128_000;
const MAX_TOKENS: u64 = 8_192;

pub fn spec(agent_dir: &Path) -> AgentSpec {
    AgentSpec {
        id: "omp",
        name: "Oh My Pi",
        files: vec![
            FileSpec {
                path: agent_dir.join("models.yml"),
                render: Render::Yaml(render_models),
            },
            FileSpec {
                path: agent_dir.join("config.yml"),
                render: Render::Yaml(render_config),
            },
        ],
        current_model: |docs| default_role(docs).map(str::to_string),
        points_to_gateway: |docs, base_url| {
            let provider = docs[0]
                .as_ref()
                .and_then(|doc| lookup_str(doc, &["providers", PROVIDER_ID, "baseUrl"]));
            provider == Some(base_url)
                && default_role(docs)
                    .is_some_and(|role| role.starts_with(&format!("{PROVIDER_ID}/")))
        },
        warnings: Box::new(|_: &Docs| {
            vec![
                "使用命名 profile 启动时 Oh My Pi 读取的是该 profile 的目录，不是这里。"
                    .to_string(),
            ]
        }),
    }
}

fn default_role(docs: &Docs) -> Option<&str> {
    docs[1]
        .as_ref()
        .and_then(|doc| lookup_str(doc, &["modelRoles", "default"]))
}

fn render_models(doc: &mut YamlDoc, target: &AgentTarget<'_>) -> Result<(), String> {
    let provider = json!({
        "baseUrl": target.base_url,
        "api": "openai-completions",
        "apiKey": target.token,
        "models": [{
            "id": target.model,
            "name": target.model,
            "contextWindow": CONTEXT_WINDOW,
            "maxTokens": MAX_TOKENS,
        }],
    });
    doc.set(&["providers", PROVIDER_ID], &yaml(&provider))
}

fn render_config(doc: &mut YamlDoc, target: &AgentTarget<'_>) -> Result<(), String> {
    let selector = format!("{PROVIDER_ID}/{}", target.model);
    doc.set(&["modelRoles", "default"], &yaml(&selector.into()))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::gateway::agent_config::test_support::*;
    use crate::gateway::agent_config::AgentConfig;

    #[test]
    fn writes_provider_and_default_role_and_restores_both() {
        let dir = temp_dir("omp");
        let models = dir.join("models.yml");
        let original = "providers:\n  spark:\n    baseUrl: http://192.168.10.223:8000/v1\n    api: openai-completions\n    apiKey: dummy\n    models:\n      - id: minimax-m3\n        name: MiniMax M3\n";
        fs::write(&models, original).unwrap();
        let config = AgentConfig::new(spec(&dir), &dir.join("gateway"));
        assert!(!config.inspect(BASE).unwrap().points_to_gateway);

        let preview = config.preview(&target("deepseek/deepseek-chat")).unwrap();
        assert!(!preview.diff.contains(TOKEN));
        config
            .apply(
                &target("deepseek/deepseek-chat"),
                Some(&preview.before_version),
            )
            .unwrap();
        let written = fs::read_to_string(&models).unwrap();
        assert!(written.starts_with(original));
        assert!(written.ends_with(&format!(
            "  tokenledger: {{\"baseUrl\": \"{BASE}\", \"api\": \"openai-completions\", \"apiKey\": \"{TOKEN}\", \"models\": [{{\"id\": \"deepseek/deepseek-chat\", \"name\": \"deepseek/deepseek-chat\", \"contextWindow\": 128000, \"maxTokens\": 8192}}]}}\n"
        )));
        assert_eq!(
            fs::read_to_string(dir.join("config.yml")).unwrap(),
            "modelRoles:\n  default: \"tokenledger/deepseek/deepseek-chat\"\n"
        );
        let after = config.inspect(BASE).unwrap();
        assert!(after.points_to_gateway);
        assert_eq!(
            after.model.as_deref(),
            Some("tokenledger/deepseek/deepseek-chat")
        );

        config.apply(&target("group/coding"), None).unwrap();
        assert!(fs::read_to_string(&models)
            .unwrap()
            .contains("\"id\": \"group/coding\""));

        let restored = config.restore(false).unwrap();
        assert!(restored.removed);
        assert_eq!(fs::read_to_string(&models).unwrap(), original);
        assert!(!dir.join("config.yml").exists());
        let _ = fs::remove_dir_all(dir);
    }
}
