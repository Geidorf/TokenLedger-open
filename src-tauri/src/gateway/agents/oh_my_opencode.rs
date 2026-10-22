//! oh-my-opencode (T10.295): the OpenCode plugin reads the `[opencode]` block
//! of the user's `~/.omo/omo.jsonc` (`omo.json` when only that exists) and
//! resolves each sub-Agent's `agents.<name>.model` and each task category's
//! `categories.<name>.model` (T10.297) through OpenCode's own providers.
//! Those `model` keys point at the `tokenledger` provider the
//! OpenCode writer adds, so no address or token is written here and only these
//! keys belong to the gateway. The main agents (Sisyphus, Prometheus, …) run
//! on the model picked in OpenCode, and `multimodal-looker` needs a vision
//! model, so they are left alone. OmO Native ignores `[opencode]`.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::gateway::agent_config::{
    jsonc, lookup, lookup_str, object_at, AgentSpec, AgentTarget, Docs, FileSpec, KeyPaths, Render,
    PROVIDER_ID,
};

const BLOCK: &str = "[opencode]";
/// Built-in sub-Agents of the OpenCode edition (`BuiltinAgentNameSchema`).
pub const SUB_AGENTS: [&str; 6] = [
    "oracle",
    "librarian",
    "explore",
    "metis",
    "momus",
    "sisyphus-junior",
];

/// Built-in task categories of the OpenCode edition (`DEFAULT_CATEGORIES`).
pub const CATEGORIES: [&str; 9] = [
    "visual-engineering",
    "artistry",
    "ultrabrain",
    "deep-low",
    "deep-high",
    "quick",
    "unspecified-low",
    "unspecified-high",
    "writing",
];

const GROUPS: [(&str, &[&str]); 2] = [("agents", &SUB_AGENTS), ("categories", &CATEGORIES)];

pub const MANAGED: KeyPaths = &[
    &[BLOCK, "agents", SUB_AGENTS[0], "model"],
    &[BLOCK, "agents", SUB_AGENTS[1], "model"],
    &[BLOCK, "agents", SUB_AGENTS[2], "model"],
    &[BLOCK, "agents", SUB_AGENTS[3], "model"],
    &[BLOCK, "agents", SUB_AGENTS[4], "model"],
    &[BLOCK, "agents", SUB_AGENTS[5], "model"],
    &[BLOCK, "categories", CATEGORIES[0], "model"],
    &[BLOCK, "categories", CATEGORIES[1], "model"],
    &[BLOCK, "categories", CATEGORIES[2], "model"],
    &[BLOCK, "categories", CATEGORIES[3], "model"],
    &[BLOCK, "categories", CATEGORIES[4], "model"],
    &[BLOCK, "categories", CATEGORIES[5], "model"],
    &[BLOCK, "categories", CATEGORIES[6], "model"],
    &[BLOCK, "categories", CATEGORIES[7], "model"],
    &[BLOCK, "categories", CATEGORIES[8], "model"],
];

const OPENCODE_MAX_BYTES: u64 = 256 * 1024;

/// `omo.jsonc`, or `omo.json` when only that one exists (OmO's own rule).
pub fn config_path(omo_dir: &Path) -> PathBuf {
    let jsonc = omo_dir.join("omo.jsonc");
    let json = omo_dir.join("omo.json");
    if !jsonc.exists() && json.exists() {
        json
    } else {
        jsonc
    }
}

pub fn spec(omo_dir: &Path, opencode_dir: &Path) -> AgentSpec {
    let opencode = opencode_dir.join("opencode.json");
    AgentSpec {
        id: "oh-my-opencode",
        name: "oh-my-opencode",
        files: vec![FileSpec {
            path: config_path(omo_dir),
            render: Render::Json(render),
        }],
        current_model: |docs| {
            models(docs)
                .into_iter()
                .flatten()
                .next()
                .map(str::to_string)
        },
        points_to_gateway: |docs, _| {
            models(docs)
                .iter()
                .all(|model| model.is_some_and(|model| model.starts_with("tokenledger/")))
        },
        warnings: Box::new(move |docs: &Docs| warnings(docs, &opencode)),
    }
}

fn models(docs: &Docs) -> Vec<Option<&str>> {
    let doc = docs[0].as_ref();
    GROUPS
        .iter()
        .flat_map(|(group, names)| names.iter().map(move |name| (*group, *name)))
        .map(|(group, name)| doc.and_then(|doc| lookup_str(doc, &[BLOCK, group, name, "model"])))
        .collect()
}

fn render(doc: &mut Map<String, Value>, target: &AgentTarget<'_>) -> Result<(), String> {
    let model = format!("{PROVIDER_ID}/{}", target.model);
    let block = object_at(doc, BLOCK)?;
    for (group, names) in GROUPS {
        let group = object_at(block, group)?;
        for name in names {
            object_at(group, name)?.insert("model".into(), Value::from(model.as_str()));
        }
    }
    Ok(())
}

/// OpenCode's `provider.tokenledger` block, if `opencode.json` has one.
fn opencode_provider(path: &Path) -> Option<Map<String, Value>> {
    if fs::metadata(path).ok()?.len() > OPENCODE_MAX_BYTES {
        return None;
    }
    let doc = jsonc::parse(&fs::read_to_string(path).ok()?)?;
    lookup(&doc, &["provider", PROVIDER_ID])?
        .as_object()
        .cloned()
}

fn warnings(docs: &Docs, opencode: &Path) -> Vec<String> {
    let mut out = Vec::new();
    match opencode_provider(opencode) {
        None => out.push(format!(
            "oh-my-opencode 的子 Agent 经由 OpenCode 里名为 {PROVIDER_ID} 的供应商访问网关，但 {} 里还没有它：请先在上方接入 OpenCode。",
            opencode.display()
        )),
        Some(provider) => {
            let mut missing: Vec<&str> = models(docs)
                .into_iter()
                .flatten()
                .filter_map(|model| model.strip_prefix("tokenledger/"))
                .filter(|model| lookup(&provider, &["models", model]).is_none())
                .collect();
            missing.dedup();
            for model in missing {
                out.push(format!(
                    "子 Agent 与任务类别用的模型 {model} 不在 OpenCode 的 {PROVIDER_ID} 供应商里，OpenCode 会找不到它：在 OpenCode 接入里选一次这个模型即可登记。"
                ));
            }
        }
    }
    if let Some(doc) = docs[0].as_ref() {
        let chained: Vec<&str> = GROUPS
            .iter()
            .flat_map(|(group, names)| names.iter().map(move |name| (*group, *name)))
            .filter(|(group, name)| lookup(doc, &[BLOCK, group, name, "models"]).is_some())
            .map(|(_, name)| name)
            .collect();
        if !chained.is_empty() {
            out.push(format!(
                "{} 设置了 models 模型链，可能先于这里写入的 model 生效。",
                chained.join("、")
            ));
        }
    }
    if ["OMO_PROFILE", "OCX_PROFILE"]
        .iter()
        .any(|var| std::env::var_os(var).is_some_and(|value| !value.is_empty()))
    {
        out.push(
            "检测到 OMO_PROFILE 或 OCX_PROFILE：所选配置档 profiles.<名字> 里的 [opencode] 设置会覆盖这里。"
                .to_string(),
        );
    }
    out.push(
        "只改子 Agent（oracle、librarian、explore、metis、momus、sisyphus-junior）与内置任务类别（quick、writing、ultrabrain 等 9 个）的模型；主会话沿用 OpenCode 的模型，multimodal-looker 需要识图模型，保持原样。项目目录里的 .omo/omo.jsonc 优先级更高。"
            .to_string(),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::agent_config::test_support::*;
    use crate::gateway::agent_config::AgentConfig;

    const OMO: &str = "{\n  \"$schema\": \"https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/omo.schema.json\",\n  // shared by every harness\n  \"[native]\": { \"model_profile\": \"daily-normal\" },\n  \"[opencode]\": {\n    \"agents\": {\n      // research agents: cheap fast models are fine\n      \"librarian\": { \"model\": \"google/gemini-3.6-flash\" },\n      \"oracle\": { \"model\": \"openai/gpt-5.6-sol\", \"reasoning\": \"high\" }, // consult\n      \"sisyphus\": { \"model\": \"kimi-for-coding/kimi-k3\" },\n    },\n    /* concurrency */\n    \"tmux\": { \"enabled\": false },\n  },\n}\n";

    fn setup(name: &str) -> (PathBuf, AgentConfig) {
        let dir = temp_dir(name);
        let omo = dir.join(".omo");
        let opencode = dir.join("opencode");
        fs::create_dir_all(&omo).unwrap();
        fs::create_dir_all(&opencode).unwrap();
        let config =
            AgentConfig::new(spec(&omo, &opencode), &dir.join("gateway")).managed_keys(MANAGED);
        (dir, config)
    }

    fn connect_opencode(dir: &Path, models: &[&str]) {
        let models: Map<String, Value> = models
            .iter()
            .map(|model| (model.to_string(), serde_json::json!({ "name": model })))
            .collect();
        let doc = serde_json::json!({
            "provider": { PROVIDER_ID: { "options": { "baseURL": BASE }, "models": models } }
        });
        fs::write(dir.join("opencode/opencode.json"), doc.to_string()).unwrap();
    }

    #[test]
    fn creates_omo_jsonc_with_sub_agent_models_only() {
        let (dir, config) = setup("omo-new");
        let path = dir.join(".omo/omo.jsonc");
        let inspection = config.inspect(BASE).unwrap();
        assert!(!inspection.exists);
        assert!(!inspection.points_to_gateway);
        assert!(inspection.warnings[0].contains("请先在上方接入 OpenCode"));

        connect_opencode(&dir, &["group/coding"]);
        let preview = config.preview(&target("group/coding")).unwrap();
        assert!(preview.changed);
        assert!(!preview.warnings[0].contains("请先在上方接入 OpenCode"));
        config
            .apply(&target("group/coding"), Some(&preview.before_version))
            .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains(TOKEN));
        assert!(!text.contains(BASE));
        let written = read_json(&path);
        for name in SUB_AGENTS {
            assert_eq!(
                lookup_str(&written, &[BLOCK, "agents", name, "model"]),
                Some("tokenledger/group/coding"),
                "{name}"
            );
        }
        let agents = lookup(&written, &[BLOCK, "agents"]).unwrap();
        assert_eq!(agents.as_object().unwrap().len(), SUB_AGENTS.len());
        for name in CATEGORIES {
            assert_eq!(
                lookup_str(&written, &[BLOCK, "categories", name, "model"]),
                Some("tokenledger/group/coding"),
                "{name}"
            );
        }
        let inspection = config.inspect(BASE).unwrap();
        assert!(inspection.points_to_gateway);
        assert_eq!(
            inspection.model.as_deref(),
            Some("tokenledger/group/coding")
        );
        assert!(inspection.backup.unwrap().restorable_without_force);

        config.restore(false).unwrap();
        assert!(!path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn patches_commented_omo_jsonc_in_place_and_restores_it() {
        let (dir, config) = setup("omo-jsonc");
        let path = dir.join(".omo/omo.jsonc");
        fs::write(&path, OMO).unwrap();
        connect_opencode(&dir, &["deepseek/deepseek-chat"]);
        let inspection = config.inspect(BASE).unwrap();
        assert!(!inspection.points_to_gateway);
        assert_eq!(inspection.model.as_deref(), Some("openai/gpt-5.6-sol"));

        config
            .apply(&target("deepseek/deepseek-chat"), None)
            .unwrap();
        let written = fs::read_to_string(&path).unwrap();
        for kept in [
            "// shared by every harness\n  \"[native]\": { \"model_profile\": \"daily-normal\" },",
            "// research agents: cheap fast models are fine\n      \"librarian\": { \"model\": \"tokenledger/deepseek/deepseek-chat\" },",
            "\"oracle\": { \"model\": \"tokenledger/deepseek/deepseek-chat\", \"reasoning\": \"high\" }, // consult\n",
            "\"sisyphus\": { \"model\": \"kimi-for-coding/kimi-k3\" },",
            "/* concurrency */\n    \"tmux\": { \"enabled\": false },",
        ] {
            assert!(written.contains(kept), "missing {kept:?} in\n{written}");
        }
        let inspection = config.inspect(BASE).unwrap();
        assert!(inspection.points_to_gateway);
        assert!(
            !inspection
                .warnings
                .iter()
                .any(|w| w.contains("不在 OpenCode")),
            "{:?}",
            inspection.warnings
        );

        config.restore(false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), OMO);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_judges_only_model_keys_and_never_strips_comments() {
        let (dir, config) = setup("omo-edit");
        let path = dir.join(".omo/omo.jsonc");
        fs::write(&path, OMO).unwrap();
        config.apply(&target("a/b"), None).unwrap();
        let applied = fs::read_to_string(&path).unwrap();
        let inspection = config.inspect(BASE).unwrap();
        assert!(inspection.warnings[0].contains("请先在上方接入 OpenCode"));

        // Outside the model keys: still ours, and the restore removes only
        // the added agents in place, keeping that edit and the comments.
        let edited = applied.replace("\"enabled\": false", "\"enabled\": true");
        fs::write(&path, &edited).unwrap();
        assert!(config.inspect(BASE).unwrap().points_to_gateway);
        assert!(
            config
                .inspect(BASE)
                .unwrap()
                .backup
                .unwrap()
                .restorable_without_force
        );
        config.restore(false).unwrap();
        let restored = fs::read_to_string(&path).unwrap();
        assert_eq!(
            restored,
            OMO.replace("\"enabled\": false", "\"enabled\": true")
        );
        config.apply(&target("a/b"), None).unwrap();

        // A model key changed by hand needs a forced restore.
        let edited = applied.replace(
            "\"oracle\": { \"model\": \"tokenledger/a/b\"",
            "\"oracle\": { \"model\": \"openai/gpt-5.6-sol\"",
        );
        assert_ne!(edited, applied);
        fs::write(&path, &edited).unwrap();
        assert!(!config.inspect(BASE).unwrap().points_to_gateway);
        assert!(config.restore(false).unwrap_err().contains("强制恢复"));
        config.restore(true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), OMO);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn warns_about_models_missing_from_opencode_and_prefers_existing_omo_json() {
        let (dir, config) = setup("omo-warn");
        connect_opencode(&dir, &["group/coding"]);
        config.apply(&target("a/b"), None).unwrap();
        let warnings = config.inspect(BASE).unwrap().warnings;
        assert!(warnings[0].contains("a/b"), "{warnings:?}");

        let omo = dir.join(".omo");
        fs::remove_file(omo.join("omo.jsonc")).unwrap();
        assert_eq!(config_path(&omo), omo.join("omo.jsonc"));
        fs::write(omo.join("omo.json"), "{}").unwrap();
        assert_eq!(config_path(&omo), omo.join("omo.json"));
        let _ = fs::remove_dir_all(dir);
    }
}
