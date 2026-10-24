use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) const MAX_FILTER_ITEMS: usize = 32;
pub(crate) const MAX_FILTER_BYTES: usize = 256;
pub(crate) const MAX_CURSOR_BYTES: usize = 512;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntitySelectorInput {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EntityKind {
    Tool,
    Model,
}

impl EntityKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Tool => "tool",
            Self::Model => "model",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NormalizedEntitySelector {
    pub kind: EntityKind,
    pub id: String,
}

impl NormalizedEntitySelector {
    pub(crate) fn from_input(input: EntitySelectorInput) -> Result<Self, String> {
        let kind = ascii_trim(&input.kind);
        let kind = match kind {
            "tool" => EntityKind::Tool,
            "model" => EntityKind::Model,
            _ => return Err("invalid-entity-kind: expected tool or model".to_string()),
        };
        let id = normalize_scalar("entity.id", input.id)?
            .ok_or_else(|| "empty-item: entity.id must not be empty".to_string())?;
        Ok(Self { kind, id })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CanonicalFilters {
    pub machines: Vec<String>,
    pub tools: Vec<String>,
    pub models: Vec<String>,
    pub search: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn normalize_filters(
    machines: Option<Vec<String>>,
    machine: Option<String>,
    tools: Option<Vec<String>>,
    tool: Option<String>,
    models: Option<Vec<String>>,
    model: Option<String>,
    search: Option<String>,
) -> Result<CanonicalFilters, String> {
    Ok(CanonicalFilters {
        machines: normalize_dimension("machines", machines, machine, true)?,
        tools: normalize_dimension("tools", tools, tool, false)?,
        models: normalize_dimension("models", models, model, false)?,
        search: normalize_search(search)?,
    })
}

pub(crate) fn ascii_trim(value: &str) -> &str {
    value.trim_matches(|character| {
        matches!(character, '\u{0009}' | '\u{000a}' | '\u{000d}' | '\u{0020}')
    })
}

fn normalize_scalar(name: &str, value: String) -> Result<Option<String>, String> {
    let value = ascii_trim(&value);
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_FILTER_BYTES {
        return Err(format!(
            "item-too-long: {name} exceeds {MAX_FILTER_BYTES} UTF-8 bytes"
        ));
    }
    Ok(Some(value.to_string()))
}

fn normalize_singular(
    name: &str,
    value: Option<String>,
    legacy_machine_sentinel: bool,
) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(value) = normalize_scalar(name, value)? else {
        return Ok(Vec::new());
    };
    if legacy_machine_sentinel && matches!(value.as_str(), "all" | "all_cloud") {
        return Ok(Vec::new());
    }
    Ok(vec![value])
}

fn normalize_plural(
    name: &str,
    values: Vec<String>,
    reject_machine_sentinel: bool,
) -> Result<Vec<String>, String> {
    if values.len() > MAX_FILTER_ITEMS {
        return Err(format!(
            "too-many-items: {name} exceeds {MAX_FILTER_ITEMS} items"
        ));
    }
    let mut normalized = Vec::with_capacity(values.len());
    for (index, value) in values.into_iter().enumerate() {
        let Some(value) = normalize_scalar(&format!("{name}[{index}]"), value)? else {
            return Err(format!(
                "empty-item: {name}[{index}] is empty after ASCII trim"
            ));
        };
        if reject_machine_sentinel && matches!(value.as_str(), "all" | "all_cloud") {
            return Err(format!(
                "illegal-machine-sentinel: {name}[{index}] must not use {value}"
            ));
        }
        normalized.push(value);
    }
    normalized.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    normalized.dedup();
    Ok(normalized)
}

fn normalize_dimension(
    name: &str,
    plural: Option<Vec<String>>,
    singular: Option<String>,
    machine: bool,
) -> Result<Vec<String>, String> {
    let singular_present = singular.is_some();
    let singular = normalize_singular(name, singular, machine)?;
    let Some(plural) = plural else {
        return Ok(singular);
    };
    let plural = normalize_plural(name, plural, machine)?;
    if singular_present && plural != singular {
        return Err(format!(
            "singular-plural-conflict: {name} aliases normalize differently"
        ));
    }
    Ok(plural)
}

/// 明细的账号筛选（契约 §2.7 的供应商 ID），规则与工具、模型筛选相同。
pub(crate) fn normalize_providers(values: Option<Vec<String>>) -> Result<Vec<String>, String> {
    normalize_dimension("providers", values, None, false)
}

pub(crate) fn normalize_search(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = ascii_trim(&value);
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_FILTER_BYTES {
        return Err(format!(
            "search-too-long: search exceeds {MAX_FILTER_BYTES} UTF-8 bytes"
        ));
    }
    Ok(Some(value.to_string()))
}

#[allow(dead_code)]
pub(crate) fn literal_search_matches<'a>(
    search: &str,
    candidates: impl IntoIterator<Item = &'a str>,
) -> bool {
    if search.is_ascii() {
        let search = search.to_ascii_lowercase();
        candidates
            .into_iter()
            .any(|candidate| candidate.to_ascii_lowercase().contains(&search))
    } else {
        candidates
            .into_iter()
            .any(|candidate| candidate.contains(search))
    }
}

/// Persistent stats cache keys hash this, so object keys are sorted first:
/// `serde_json` preserves insertion order and the digest must not depend on it.
pub(crate) fn fingerprint_json(value: &Value) -> String {
    let encoded =
        serde_json::to_vec(&sorted_keys(value)).expect("canonical query JSON must serialize");
    let mut hasher = Sha256::new();
    hasher.update(encoded);
    format!("{:x}", hasher.finalize())
}

fn sorted_keys(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by_key(|(key, _)| *key);
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key.clone(), sorted_keys(value)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted_keys).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::fingerprint_json;
    use serde_json::json;

    #[test]
    fn fingerprint_ignores_key_insertion_order() {
        let shuffled = json!({"b": {"z": null, "c": [{"e": 2, "d": 1}]}, "a": 1});
        let sorted = json!({"a": 1, "b": {"c": [{"d": 1, "e": 2}], "z": null}});
        // SHA-256 of the sorted compact encoding `{"a":1,"b":{"c":[{"d":1,"e":2}],"z":null}}`,
        // the bytes produced before `preserve_order`, so existing cache keys stay valid.
        let expected = "f5abe53cdf556504b8e8d74260808d46c621e44737c9bf6dd130fc0a98abfd53";
        assert_eq!(fingerprint_json(&shuffled), expected);
        assert_eq!(fingerprint_json(&sorted), expected);
    }
}
