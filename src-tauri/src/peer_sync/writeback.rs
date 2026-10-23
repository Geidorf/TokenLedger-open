//! Writing TokenLedger's providers into the peer's backup (contract
//! `peer-sync-v1` §6).
//!
//! The peer syncs its setup in parts and mirrors what the server holds: a
//! provider missing from the file goes from every computer. So the write
//! changes the `providers` list alone, and only by adding or updating the
//! picked providers; every other provider, field and part of the bundle is
//! kept as it was read, unknown ones included. A peer that reads the file
//! next sees its providers part changed on the server and brings it in.
//!
//! API keys never leave this computer: a provider is written without its
//! key, an updated one keeps the key the peer already had, and a new one is
//! given its key in the peer by the user.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};

use super::{preview, PeerBundle};
use crate::gateway::{AuthMode, ProviderRecord, WireApi};

/// A TokenLedger provider as it would go into the peer's backup.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCandidate {
    pub id: String,
    pub name: String,
    /// The the peer provider it updates, or the id it is added under.
    pub peer_id: String,
    /// A peer provider is updated rather than one added.
    pub update: bool,
    /// Why it can't go; `None` when it can.
    pub unsupported: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreview {
    pub providers: Vec<ExportCandidate>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub skipped: Vec<String>,
    /// The server's file as it was, kept beside TokenLedger's data.
    pub saved_as: String,
}

fn wire_field(wire: WireApi) -> &'static str {
    match wire {
        WireApi::Chat => "chat",
        WireApi::Responses => "responses",
        WireApi::Anthropic => "anthropic",
    }
}

/// Which the peer provider each TokenLedger id stands for: the one importing
/// gave that id to, so a provider brought in from the peer goes back to it.
/// Each with whether importing could take it: one it couldn't (a sign-in, a
/// Gemini-native or decision provider) is never written over.
fn peer_ids(bundle: &PeerBundle) -> BTreeMap<String, (String, bool)> {
    preview(bundle, &Default::default())
        .providers
        .into_iter()
        .map(|candidate| {
            let plain = candidate.unsupported.is_none();
            (candidate.id, (candidate.peer_id, plain))
        })
        .collect()
}

/// What writing `providers` would do.
pub fn export_preview(bundle: &PeerBundle, providers: &[ProviderRecord]) -> ExportPreview {
    let ids = peer_ids(bundle);
    let candidates = providers
        .iter()
        .map(|record| {
            let mapped = ids.get(&record.id);
            let taken = match mapped {
                Some((_, plain)) => !plain,
                None => bundle
                    .providers
                    .iter()
                    .any(|provider| provider.id == record.id),
            };
            ExportCandidate {
                id: record.id.clone(),
                name: record.name.clone(),
                peer_id: mapped.map_or_else(|| record.id.clone(), |(id, _)| id.clone()),
                update: mapped.is_some(),
                unsupported: if record.auth_mode != AuthMode::Key {
                    Some("不用 API key 的供应商不写入外部网关。".to_string())
                } else if taken {
                    Some("外部网关里同 ID 的供应商是订阅登录或其他类型，不覆盖。".to_string())
                } else {
                    None
                },
            }
        })
        .collect();
    ExportPreview {
        providers: candidates,
    }
}

fn set_or_remove(entry: &mut Map<String, Value>, field: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            entry.insert(field.to_string(), value);
        }
        None => {
            entry.remove(field);
        }
    }
}

/// Fills one peer provider from a TokenLedger one, leaving the fields
/// TokenLedger doesn't have (accounts, routing, limits…) as they are.
fn fill(entry: &mut Map<String, Value>, record: &ProviderRecord) {
    entry.insert("name".into(), Value::String(record.name.clone()));
    entry.insert(
        wire_field(record.wire).into(),
        Value::String(record.base_url.clone()),
    );
    if record.models.is_empty() {
        entry.remove("models");
    } else {
        entry.insert("models".into(), serde_json::json!(record.models));
        // A pick clears the peer's Select none.
        entry.remove("noModels");
    }
    set_or_remove(entry, "off", (!record.enabled).then_some(Value::Bool(true)));
}

/// A merged backup's plaintext and what changed in it (TokenLedger ids).
pub struct Merged {
    pub body: Vec<u8>,
    pub added: Vec<String>,
    pub updated: Vec<String>,
}

/// The backup's plaintext with `outgoing` added or updated, and which were
/// added and updated (by TokenLedger id). Nothing else in it changes but
/// `created` and `app`, which say who wrote it and when, as the peer's own
/// push does.
pub fn merge(
    plain: &[u8],
    bundle: &PeerBundle,
    outgoing: &[ProviderRecord],
    now: &str,
) -> Result<Merged, String> {
    let mut root: Value =
        serde_json::from_slice(plain).map_err(|_| "外部网关备份的内容无法识别。".to_string())?;
    let object = root
        .as_object_mut()
        .ok_or_else(|| "外部网关备份的内容无法识别。".to_string())?;
    let ids = peer_ids(bundle);
    let mut added = Vec::new();
    let mut updated = Vec::new();
    let mut new_ids = Vec::new();
    {
        let providers = object
            .entry("providers")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| "外部网关备份的供应商列表无法识别。".to_string())?;
        for item in outgoing {
            let id = &item.id;
            let target = match ids.get(id) {
                Some((target, true)) => target.clone(),
                Some((_, false)) => continue,
                None => id.clone(),
            };
            let found = providers.iter_mut().find_map(|provider| {
                provider
                    .as_object_mut()
                    .filter(|entry| entry.get("id").and_then(Value::as_str) == Some(&target))
            });
            match found {
                Some(entry) => {
                    fill(entry, item);
                    updated.push(id.clone());
                }
                None => {
                    let mut entry = Map::new();
                    entry.insert("id".into(), Value::String(target.clone()));
                    entry.insert("key".into(), Value::String(String::new()));
                    entry.insert(
                        "baseAPI".into(),
                        Value::String(wire_field(item.wire).into()),
                    );
                    fill(&mut entry, item);
                    providers.push(Value::Object(entry));
                    added.push(id.clone());
                    new_ids.push(target);
                }
            }
        }
    }
    // When the user arranged the peer's providers, a new one goes last.
    if let Some(order) = object.get_mut("order").and_then(Value::as_array_mut) {
        if !order.is_empty() {
            order.extend(new_ids.into_iter().map(Value::String));
        }
    }
    object.insert("created".into(), Value::String(now.to_string()));
    object.insert("app".into(), Value::String("tokenledger".into()));
    let body = serde_json::to_vec(&root).map_err(|error| error.to_string())?;
    Ok(Merged {
        body,
        added,
        updated,
    })
}
