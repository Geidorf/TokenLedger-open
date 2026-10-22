//! MiniMax Code (`mcode`): `config.yaml` in its data directory gets a
//! `custom_provider.tokenledger` entry (`openai-completions`, which sends the
//! local token as `Authorization: Bearer`), and `defaultModel` becomes
//! `custom_provider:tokenledger/<gateway model>`. MiniMax Code splits the
//! reference at the first `/`, so `group/<id>` and `provider/model` reach the
//! gateway unchanged. `minimax_api` is reserved for the official endpoint and
//! is left alone.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::gateway::agent_config::{
    lookup_str, AgentSpec, AgentTarget, Docs, FileSpec, KeyPaths, Render, PROVIDER_ID,
    PROVIDER_NAME,
};
use crate::gateway::agents::yaml::{render as yaml, YamlDoc};

const API_FORMAT: &str = "openai-completions";
const MODEL_PREFIX: &str = "custom_provider:tokenledger/";

/// MiniMax Code rewrites `config.yaml` itself while running, so restore only
/// puts these back and keeps whatever else it changed.
pub const MANAGED: KeyPaths = &[&["custom_provider", PROVIDER_ID], &["defaultModel"]];

/// `~/.minimax` on every platform. MiniMax Code moves a legacy `~/.mavis`
/// into it on start only while `~/.minimax` is missing; creating it first
/// would make it back up and hide the old settings instead.
pub fn data_dir(home: &Path) -> Result<PathBuf, String> {
    let dir = home.join(".minimax");
    if !dir.exists() && home.join(".mavis").exists() {
        return Err(
            "MiniMax Code 还在用旧的 ~/.mavis 数据目录，请先运行一次 mcode 让它迁移到 ~/.minimax，再来接入。"
                .to_string(),
        );
    }
    Ok(dir)
}

pub fn spec(data_dir: &Path) -> AgentSpec {
    AgentSpec {
        id: "minimax-code",
        name: "MiniMax Code",
        files: vec![FileSpec {
            path: data_dir.join("config.yaml"),
            render: Render::Yaml(render),
        }],
        current_model: |docs| {
            let model = default_model(docs)?;
            Some(
                model
                    .strip_prefix(MODEL_PREFIX)
                    .unwrap_or(model)
                    .to_string(),
            )
        },
        points_to_gateway: |docs, base_url| {
            let Some(doc) = docs[0].as_ref() else {
                return false;
            };
            lookup_str(doc, &["custom_provider", PROVIDER_ID, "options", "baseURL"])
                == Some(base_url)
                && default_model(docs).is_some_and(|model| model.starts_with(MODEL_PREFIX))
        },
        warnings: Box::new(|docs: &Docs| warnings(docs[0].as_ref())),
    }
}

fn default_model(docs: &Docs) -> Option<&str> {
    docs[0]
        .as_ref()
        .and_then(|doc| lookup_str(doc, &["defaultModel"]))
}

fn warnings(doc: Option<&Map<String, Value>>) -> Vec<String> {
    let mut warnings = vec![
        "请先退出 MiniMax Code（含桌面应用）再写入，它运行时可能用内存里的旧配置覆盖这次改动；重新打开后生效。".to_string(),
        "手机端消息或标题生成等辅助请求可能仍走内置的 minimax_api，不经过网关（MiniMax Code issue #126）。".to_string(),
    ];
    let light = doc.and_then(|doc| lookup_str(doc, &["defaultLightModel"]));
    if light.is_some_and(|model| !model.starts_with(MODEL_PREFIX)) {
        warnings.push(
            "配置里的 defaultLightModel 指向别的模型，标题生成等辅助任务会继续用它。".to_string(),
        );
    }
    if std::env::var_os("MINIMAX_DATA_DIR").is_none()
        && std::env::var_os("MAVIS_DATA_DIR").is_some()
    {
        warnings.push("正在按环境变量 MAVIS_DATA_DIR 定位配置目录。".to_string());
    }
    warnings
}

fn render(doc: &mut YamlDoc, target: &AgentTarget<'_>) -> Result<(), String> {
    let provider = |key: &'static str| ["custom_provider", PROVIDER_ID, key];
    doc.set(&provider("name"), &yaml(&Value::from(PROVIDER_NAME)))?;
    doc.set(&provider("kind"), &yaml(&Value::from("custom")))?;
    doc.set(&provider("enabled"), "true")?;
    doc.set(&provider("api"), &yaml(&Value::from(API_FORMAT)))?;
    let option = |key: &'static str| ["custom_provider", PROVIDER_ID, "options", key];
    doc.set(&option("baseURL"), &yaml(&Value::from(target.base_url)))?;
    doc.set(&option("apiKey"), &yaml(&Value::from(target.token)))?;
    doc.set(&option("authMode"), &yaml(&Value::from("api-key")))?;
    doc.set(
        &[
            "custom_provider",
            PROVIDER_ID,
            "models",
            target.model,
            "name",
        ],
        &yaml(&Value::from(target.model)),
    )?;
    doc.set(
        &["defaultModel"],
        &yaml(&Value::from(format!("{MODEL_PREFIX}{}", target.model))),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::gateway::agent_config::test_support::*;
    use crate::gateway::agent_config::AgentConfig;

    fn config(data: &Path, dir: &Path) -> AgentConfig {
        AgentConfig::new(spec(data), &dir.join("gateway")).managed_keys(MANAGED)
    }

    #[test]
    fn creates_the_config_when_missing() {
        let dir = temp_dir("minimax-code-new");
        let data = dir.join(".minimax");
        let path = data.join("config.yaml");
        let config = config(&data, &dir);
        let before = config.inspect(BASE).unwrap();
        assert!(!before.exists);
        assert!(!before.points_to_gateway);

        let preview = config.preview(&target("group/coding")).unwrap();
        assert!(!preview.diff.contains(TOKEN));
        assert!(preview.warnings.iter().any(|w| w.contains("#126")));
        config
            .apply(&target("group/coding"), Some(&preview.before_version))
            .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!("custom_provider:\n  tokenledger:\n    name: \"{PROVIDER_NAME}\"\n    kind: \"custom\"\n    enabled: true\n    api: \"openai-completions\"\n    options:\n      baseURL: \"{BASE}\"\n      apiKey: \"{TOKEN}\"\n      authMode: \"api-key\"\n    models:\n      group/coding:\n        name: \"group/coding\"\ndefaultModel: \"custom_provider:tokenledger/group/coding\"\n")
        );
        let after = config.inspect(BASE).unwrap();
        assert!(after.points_to_gateway);
        assert_eq!(after.model.as_deref(), Some("group/coding"));

        let restored = config.restore(false).unwrap();
        assert!(restored.removed);
        assert!(!path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn merges_into_an_existing_config_and_restores_it() {
        let dir = temp_dir("minimax-code-merge");
        let path = dir.join("config.yaml");
        let original = "minimaxModelSource: minimax_api_key\nminimax_api:\n  apiKey: sk-official\ncustom_provider:\n  relay:\n    kind: custom\n    enabled: true\n    api: openai-completions\n    options:\n      apiKey: sk-relay\n      baseURL: https://relay.example.com/v1\n      authMode: api-key\n    models:\n      MiniMax-M2: {}\ndefaultModel: custom_provider:relay/MiniMax-M2\ndefaultLightModel: minimax/MiniMax-M2.5\ntui:\n  statusLine:\n    - model\n";
        fs::write(&path, original).unwrap();
        let config = config(&dir, &dir);
        let before = config.inspect(BASE).unwrap();
        assert!(!before.points_to_gateway);
        assert_eq!(
            before.model.as_deref(),
            Some("custom_provider:relay/MiniMax-M2")
        );

        let preview = config.preview(&target("deepseek/deepseek-chat")).unwrap();
        assert!(preview
            .warnings
            .iter()
            .any(|w| w.contains("defaultLightModel")));
        config
            .apply(&target("deepseek/deepseek-chat"), None)
            .unwrap();
        config.apply(&target("group/coding"), None).unwrap();

        let written = fs::read_to_string(&path).unwrap();
        assert!(written.starts_with("minimaxModelSource: minimax_api_key\nminimax_api:\n  apiKey: sk-official\ncustom_provider:\n  relay:\n"));
        assert!(written.contains("      MiniMax-M2: {}\n  tokenledger:\n"));
        assert!(written.contains("defaultModel: \"custom_provider:tokenledger/group/coding\"\ndefaultLightModel: minimax/MiniMax-M2.5\ntui:\n  statusLine:\n    - model\n"));
        let doc = YamlDoc::parse(&written).unwrap().to_map().unwrap();
        for (key, value) in [
            (
                &["custom_provider", "relay", "options", "apiKey"][..],
                "sk-relay",
            ),
            (&["minimax_api", "apiKey"][..], "sk-official"),
            (&["custom_provider", PROVIDER_ID, "api"][..], API_FORMAT),
            (
                &["custom_provider", PROVIDER_ID, "options", "baseURL"][..],
                BASE,
            ),
            (
                &["custom_provider", PROVIDER_ID, "options", "apiKey"][..],
                TOKEN,
            ),
            (
                &[
                    "custom_provider",
                    PROVIDER_ID,
                    "models",
                    "deepseek/deepseek-chat",
                    "name",
                ][..],
                "deepseek/deepseek-chat",
            ),
            (
                &[
                    "custom_provider",
                    PROVIDER_ID,
                    "models",
                    "group/coding",
                    "name",
                ][..],
                "group/coding",
            ),
        ] {
            assert_eq!(lookup_str(&doc, key), Some(value), "{key:?}");
        }
        let after = config.inspect(BASE).unwrap();
        assert!(after.points_to_gateway);
        assert_eq!(after.model.as_deref(), Some("group/coding"));
        assert!(
            !config
                .inspect("http://127.0.0.1:9999/v1")
                .unwrap()
                .points_to_gateway
        );

        config.restore(false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let _ = fs::remove_dir_all(dir);
    }

    const ORIGINAL: &str = "# mcode settings\ncustom_provider:\n  relay:\n    kind: custom\n    options:\n      baseURL: https://relay.example.com/v1\ndefaultModel: custom_provider:relay/MiniMax-M2 # main\ndefaultLightModel: minimax/MiniMax-M2.5\ntui:\n  statusLine:\n    - model\n";

    /// What MiniMax Code might do while running: change other keys, add list
    /// items and re-quote the gateway's values without changing them.
    fn rewrite_other_keys(path: &Path) {
        let written = fs::read_to_string(path)
            .unwrap()
            .replace("MiniMax-M2.5", "MiniMax-M2.7")
            .replace("    - model\n", "    - model\n    - cost\n")
            .replace("kind: \"custom\"", "kind: custom");
        fs::write(path, format!("{written}theme: dark\n")).unwrap();
    }

    #[test]
    fn restore_keeps_outside_edits_and_puts_back_only_gateway_keys() {
        let dir = temp_dir("minimax-code-managed");
        let path = dir.join("config.yaml");
        fs::write(&path, ORIGINAL).unwrap();
        let config = config(&dir, &dir);
        config.apply(&target("group/coding"), None).unwrap();
        rewrite_other_keys(&path);

        let inspection = config.inspect(BASE).unwrap();
        assert!(inspection.points_to_gateway);
        assert!(inspection.backup.unwrap().restorable_without_force);
        config.restore(false).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            ORIGINAL
                .replace("MiniMax-M2.5", "MiniMax-M2.7")
                .replace("    - model\n", "    - model\n    - cost\n")
                + "theme: dark\n"
        );
        assert!(config.inspect(BASE).unwrap().backup.is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn edited_gateway_keys_need_a_forced_restore() {
        let dir = temp_dir("minimax-code-conflict");
        let path = dir.join("config.yaml");
        fs::write(&path, ORIGINAL).unwrap();
        let config = config(&dir, &dir);
        config.apply(&target("group/coding"), None).unwrap();
        rewrite_other_keys(&path);
        let edited = fs::read_to_string(&path)
            .unwrap()
            .replace("tokenledger/group/coding\"", "tokenledger/group/fast\"");
        fs::write(&path, edited).unwrap();

        let error = config.restore(false).unwrap_err();
        assert!(error.contains("强制恢复"), "{error}");
        assert!(
            !config
                .inspect(BASE)
                .unwrap()
                .backup
                .unwrap()
                .restorable_without_force
        );
        config.restore(true).unwrap();
        let restored = fs::read_to_string(&path).unwrap();
        assert!(restored.contains("defaultModel: custom_provider:relay/MiniMax-M2 # main\n"));
        assert!(restored.contains("MiniMax-M2.7") && restored.ends_with("theme: dark\n"));
        assert!(!restored.contains(PROVIDER_ID) && !restored.contains(TOKEN));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_created_config_is_removed_or_left_with_only_outside_keys() {
        let dir = temp_dir("minimax-code-created");
        let path = dir.join("config.yaml");
        let config = config(&dir, &dir);
        config.apply(&target("group/coding"), None).unwrap();
        let requoted = fs::read_to_string(&path)
            .unwrap()
            .replace(&format!("baseURL: \"{BASE}\""), &format!("baseURL: {BASE}"))
            .replace("kind: \"custom\"", "kind: custom");
        fs::write(&path, requoted).unwrap();
        assert!(config.restore(false).unwrap().removed);
        assert!(!path.exists());

        config.apply(&target("group/coding"), None).unwrap();
        rewrite_other_keys(&path);
        let restored = config.restore(false).unwrap();
        assert!(!restored.removed);
        assert_eq!(fs::read_to_string(&path).unwrap(), "theme: dark\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn waits_for_the_legacy_data_dir_migration() {
        let home = temp_dir("minimax-code-home");
        assert_eq!(data_dir(&home).unwrap(), home.join(".minimax"));
        fs::create_dir_all(home.join(".mavis")).unwrap();
        assert!(data_dir(&home).unwrap_err().contains("~/.mavis"));
        fs::create_dir_all(home.join(".minimax")).unwrap();
        assert_eq!(data_dir(&home).unwrap(), home.join(".minimax"));
        let _ = fs::remove_dir_all(home);
    }
}
