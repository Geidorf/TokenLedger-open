use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app_paths::AppContext;

const MODELS_DEV_URL: &str = "https://models.dev/api.json";
const CACHE_FILE: &str = "models-dev-catalog.json";
const CACHE_TTL_SECONDS: i64 = 24 * 60 * 60;
const MAX_RESPONSE_BYTES: usize = 12 * 1024 * 1024;
const MAX_CANDIDATES: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CatalogCache {
    fetched_at: i64,
    providers: HashMap<String, Provider>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Provider {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    models: HashMap<String, Model>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Model {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    last_updated: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    cost: Option<ModelCost>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelCost {
    #[serde(default)]
    input: Option<f64>,
    #[serde(default)]
    output: Option<f64>,
    #[serde(default)]
    cache_read: Option<f64>,
    #[serde(default)]
    cache_write: Option<f64>,
    #[serde(default)]
    tiers: Vec<Value>,
    #[serde(default)]
    context_over_200k: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelsDevCandidate {
    provider_id: String,
    provider_name: String,
    model_id: String,
    model_name: String,
    input: Option<f64>,
    output: Option<f64>,
    cache_input: Option<f64>,
    cache_write: Option<f64>,
    last_updated: Option<String>,
    status: Option<String>,
    has_tiered_pricing: bool,
    importable: bool,
    match_reason: String,
    #[serde(skip_serializing)]
    score: u16,
    #[serde(skip_serializing)]
    provider_hint_match: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelsDevSearchResponse {
    query: String,
    candidates: Vec<ModelsDevCandidate>,
    fetched_at: String,
    cache_status: String,
    warning: Option<String>,
}

#[tauri::command]
pub(crate) async fn search_models_dev_prices(
    state: tauri::State<'_, Arc<AppContext>>,
    model: String,
    tools: Vec<String>,
    force_refresh: Option<bool>,
) -> Result<ModelsDevSearchResponse, String> {
    let query = model.trim();
    if query.is_empty() {
        return Err("待核价模型 ID 不能为空".to_string());
    }

    let cache_path = state.app_data_dir().join(CACHE_FILE);
    let (catalog, cache_status, warning) =
        load_catalog(&cache_path, force_refresh.unwrap_or(false)).await?;
    let candidates = search_catalog(&catalog.providers, query, &tools);

    Ok(ModelsDevSearchResponse {
        query: query.to_string(),
        candidates,
        fetched_at: format_timestamp(catalog.fetched_at),
        cache_status,
        warning,
    })
}

async fn load_catalog(
    cache_path: &Path,
    force_refresh: bool,
) -> Result<(CatalogCache, String, Option<String>), String> {
    let cached = read_cache(cache_path).ok();
    let now = Utc::now().timestamp();
    if !force_refresh {
        if let Some(catalog) = cached.as_ref() {
            if now.saturating_sub(catalog.fetched_at) < CACHE_TTL_SECONDS {
                return Ok((catalog.clone(), "fresh".to_string(), None));
            }
        }
    }

    match fetch_catalog().await {
        Ok(catalog) => {
            if let Err(error) = write_cache(cache_path, &catalog) {
                log::warn!("models.dev catalog cache write failed: {error}");
            }
            Ok((catalog, "refreshed".to_string(), None))
        }
        Err(error) => {
            if let Some(catalog) = cached {
                Ok((
                    catalog,
                    "stale".to_string(),
                    Some(format!("models.dev 刷新失败，正在使用本地缓存：{error}")),
                ))
            } else {
                Err(format!(
                    "无法获取 models.dev 模型目录，且本地没有可用缓存：{error}"
                ))
            }
        }
    }
}

async fn fetch_catalog() -> Result<CatalogCache, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("TokenLedger/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("创建网络客户端失败：{error}"))?;
    let response = client
        .get(MODELS_DEV_URL)
        .send()
        .await
        .map_err(|error| format!("网络请求失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("接口返回 HTTP {status}"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("接口响应超过允许大小".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取响应失败：{error}"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("接口响应超过允许大小".to_string());
    }
    let providers = serde_json::from_slice::<HashMap<String, Provider>>(&bytes)
        .map_err(|error| format!("目录 JSON 无法解析：{error}"))?;
    if providers.is_empty() {
        return Err("目录中没有供应商数据".to_string());
    }
    Ok(CatalogCache {
        fetched_at: Utc::now().timestamp(),
        providers,
    })
}

fn read_cache(path: &Path) -> Result<CatalogCache, String> {
    let content = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&content).map_err(|error| error.to_string())
}

fn write_cache(path: &Path, catalog: &CatalogCache) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_vec(catalog).map_err(|error| error.to_string())?;
    let temp_path = temporary_cache_path(path);
    fs::write(&temp_path, content).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temp_path, path).map_err(|error| error.to_string())
}

fn temporary_cache_path(path: &Path) -> PathBuf {
    let mut temp = path.to_path_buf();
    temp.set_extension("json.tmp");
    temp
}

fn format_timestamp(timestamp: i64) -> String {
    DateTime::from_timestamp(timestamp, 0)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339()
}

fn search_catalog(
    providers: &HashMap<String, Provider>,
    query: &str,
    tools: &[String],
) -> Vec<ModelsDevCandidate> {
    let query = normalize(query);
    let query_without_provider = without_provider_prefix(&query);
    let provider_hints = tools
        .iter()
        .filter_map(|tool| provider_hint(tool))
        .collect::<Vec<_>>();
    let mut candidates = Vec::new();

    for (provider_key, provider) in providers {
        let provider_id = if provider.id.trim().is_empty() {
            provider_key.as_str()
        } else {
            provider.id.as_str()
        };
        let provider_hint_match = provider_hints
            .iter()
            .any(|hint| provider_id.eq_ignore_ascii_case(hint));
        for (model_key, model) in &provider.models {
            let model_id = if model.id.trim().is_empty() {
                model_key.as_str()
            } else {
                model.id.as_str()
            };
            let Some((score, match_reason)) = match_score(
                &query,
                query_without_provider,
                model_key,
                model_id,
                &model.name,
            ) else {
                continue;
            };
            let cost = model.cost.as_ref();
            let input = cost.and_then(|value| valid_price(value.input));
            let output = cost.and_then(|value| valid_price(value.output));
            let cache_input = cost.and_then(|value| valid_price(value.cache_read));
            let cache_write = cost.and_then(|value| valid_price(value.cache_write));
            candidates.push(ModelsDevCandidate {
                provider_id: provider_id.to_string(),
                provider_name: if provider.name.trim().is_empty() {
                    provider_id.to_string()
                } else {
                    provider.name.clone()
                },
                model_id: model_id.to_string(),
                model_name: if model.name.trim().is_empty() {
                    model_id.to_string()
                } else {
                    model.name.clone()
                },
                input,
                output,
                cache_input,
                cache_write,
                last_updated: model.last_updated.clone(),
                status: model.status.clone(),
                has_tiered_pricing: cost.is_some_and(|value| {
                    !value.tiers.is_empty() || value.context_over_200k.is_some()
                }),
                importable: input.is_some() && output.is_some(),
                match_reason,
                score,
                provider_hint_match,
            });
        }
    }

    candidates.sort_by(compare_candidates);
    candidates.truncate(MAX_CANDIDATES);
    candidates
}

fn valid_price(value: Option<f64>) -> Option<f64> {
    value.filter(|price| price.is_finite() && *price >= 0.0)
}

fn compare_candidates(left: &ModelsDevCandidate, right: &ModelsDevCandidate) -> Ordering {
    right
        .score
        .cmp(&left.score)
        .then_with(|| right.provider_hint_match.cmp(&left.provider_hint_match))
        .then_with(|| right.importable.cmp(&left.importable))
        .then_with(|| left.provider_name.cmp(&right.provider_name))
        .then_with(|| left.model_id.cmp(&right.model_id))
}

fn match_score(
    query: &str,
    query_without_provider: &str,
    model_key: &str,
    model_id: &str,
    model_name: &str,
) -> Option<(u16, String)> {
    let key = normalize(model_key);
    let id = normalize(model_id);
    let name = normalize(model_name);
    let id_without_provider = without_provider_prefix(&id);
    let key_without_provider = without_provider_prefix(&key);

    if query == id || query == key {
        return Some((100, "模型 ID 完全一致".to_string()));
    }
    if query_without_provider == id_without_provider
        || query_without_provider == key_without_provider
    {
        return Some((95, "去除供应商前缀后完全一致".to_string()));
    }
    if id.contains(query) || key.contains(query) || query.contains(&id) || query.contains(&key) {
        return Some((75, "模型 ID 包含匹配".to_string()));
    }
    if !query_without_provider.is_empty()
        && (id.contains(query_without_provider)
            || key.contains(query_without_provider)
            || query_without_provider.contains(id_without_provider)
            || query_without_provider.contains(key_without_provider))
    {
        return Some((70, "模型族匹配".to_string()));
    }
    let tokens = search_tokens(query_without_provider);
    if !tokens.is_empty()
        && tokens
            .iter()
            .all(|token| id.contains(token) || key.contains(token) || name.contains(token))
    {
        return Some((55, "关键词匹配".to_string()));
    }
    if name.contains(query) || query.contains(&name) {
        return Some((45, "模型名称匹配".to_string()));
    }
    None
}

fn normalize(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace('_', "-")
}

fn without_provider_prefix(value: &str) -> &str {
    value.rsplit_once('/').map_or(value, |(_, model)| model)
}

fn search_tokens(value: &str) -> Vec<&str> {
    value
        .split(['-', '/', ':'])
        .filter(|token| token.len() >= 2)
        .collect()
}

fn provider_hint(tool: &str) -> Option<&'static str> {
    match tool.trim().to_ascii_lowercase().as_str() {
        "claude" => Some("anthropic"),
        "codex" => Some("openai"),
        "antigravity" => Some("google"),
        "deepseek" => Some("deepseek"),
        "minimax" | "marvis" => Some("minimax"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> HashMap<String, Provider> {
        serde_json::from_value(serde_json::json!({
            "openai": {
                "id": "openai",
                "name": "OpenAI",
                "models": {
                    "gpt-4.1": {
                        "id": "gpt-4.1",
                        "name": "GPT-4.1",
                        "last_updated": "2025-04-14",
                        "cost": { "input": 2.0, "output": 8.0, "cache_read": 0.5 }
                    }
                }
            },
            "gateway": {
                "id": "gateway",
                "name": "Gateway",
                "models": {
                    "openai/gpt-4.1": {
                        "id": "openai/gpt-4.1",
                        "name": "GPT-4.1",
                        "cost": {
                            "input": 2.2,
                            "output": 8.8,
                            "cache_read": 0.6,
                            "cache_write": 2.4,
                            "tiers": [{ "input": 4.0 }]
                        }
                    },
                    "no-price": { "id": "no-price", "name": "No Price" }
                }
            }
        }))
        .expect("parse test catalog")
    }

    #[test]
    fn exact_match_and_tool_provider_are_ranked_first() {
        let candidates = search_catalog(&catalog(), "gpt-4.1", &["codex".to_string()]);
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].provider_id, "openai");
        assert_eq!(candidates[0].match_reason, "模型 ID 完全一致");
        assert_eq!(candidates[1].match_reason, "去除供应商前缀后完全一致");
    }

    #[test]
    fn missing_cache_price_stays_missing_and_tiers_are_reported() {
        let candidates = search_catalog(&catalog(), "openai/gpt-4.1", &[]);
        let official = candidates
            .iter()
            .find(|candidate| candidate.provider_id == "openai")
            .expect("official candidate");
        assert_eq!(official.input, Some(2.0));
        assert_eq!(official.cache_input, Some(0.5));
        assert_eq!(official.cache_write, None);
        assert!(official.importable);

        let gateway = candidates
            .iter()
            .find(|candidate| candidate.provider_id == "gateway")
            .expect("gateway candidate");
        assert!(gateway.has_tiered_pricing);
    }

    #[test]
    fn models_without_input_and_output_are_not_importable() {
        let candidates = search_catalog(&catalog(), "no-price", &[]);
        assert_eq!(candidates.len(), 1);
        assert!(!candidates[0].importable);
    }

    #[test]
    fn cache_round_trip_preserves_catalog() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_models_dev_cache_{}_{}.json",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let cache = CatalogCache {
            fetched_at: 123,
            providers: catalog(),
        };
        write_cache(&path, &cache).expect("write cache");
        let loaded = read_cache(&path).expect("read cache");
        assert_eq!(loaded.fetched_at, 123);
        assert_eq!(loaded.providers.len(), 2);
        let _ = fs::remove_file(path);
    }
}
