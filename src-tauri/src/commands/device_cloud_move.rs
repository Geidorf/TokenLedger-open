//! Moves this computer's cloud rows from the hostname old versions uploaded
//! them under to the device id (`crate::device_identity`).
//!
//! Runs at the start of every sync, before anything is uploaded: the upload
//! aggregates under the device id, so rows still under the hostname would be
//! counted twice. Every row is copied with its values as they are, including
//! hours the local ledger no longer has, and only then are the copied
//! originals deleted (fenced by id and `updated_at`, so a row written or
//! updated under the hostname meanwhile waits for the next sync instead of
//! being lost). A failure in between
//! leaves both; the retry copies again and then deletes. Where the device id
//! already has a row under the copy's key, the newer of the two is kept. Once moved, a sync costs one empty read per old id.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, FixedOffset, Utc};
use serde_json::Value;

use super::{gateway_cloud, supabase_api_error, CloudConfig, CloudSession, CloudSessionUseLease};
use crate::app_paths::AppContext;
use crate::{cache, db, device_identity};

const PAGE_SIZE: usize = 500;

/// Columns the server fills in; the copy gets its own.
const SERVER_COLUMNS: [&str; 3] = ["id", "created_at", "updated_at"];

/// The copy of one cloud row under the device id.
pub(super) fn moved_row(row: &Value, legacy: &str, device_id: &str) -> Option<Value> {
    let mut copy = row.as_object()?.clone();
    for column in SERVER_COLUMNS {
        copy.remove(column);
    }
    let key = copy.get("unique_key")?.as_str()?;
    let key = device_identity::moved_unique_key(key, legacy, device_id);
    copy.insert("unique_key".into(), Value::String(key));
    copy.insert("machine_id".into(), Value::String(device_id.to_string()));
    Some(Value::Object(copy))
}

/// The latest `updated_at` among copied rows. Rows changed after they were
/// read carry a later one, so a delete fenced by it keeps them.
pub(super) fn newest_update(rows: &[Value]) -> Option<DateTime<FixedOffset>> {
    rows.iter().filter_map(updated_at).max()
}

fn updated_at(row: &Value) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(row.get("updated_at")?.as_str()?).ok()
}

/// Whether the copy of `source` is written over the row already under its
/// new key (last written at `existing`). The newer one wins: a row this
/// computer uploaded from its own ledger since the switch is kept, while a
/// copy an earlier, interrupted move made is replaced when an old client
/// has updated the source since.
pub(super) fn copy_wins(source: &Value, existing: Option<DateTime<FixedOffset>>) -> bool {
    match existing {
        None => true,
        Some(existing) => updated_at(source).is_some_and(|source| source > existing),
    }
}

const LOOKUP_SIZE: usize = 100;

/// Returns how many cloud rows were moved for the signed-in account.
pub(super) async fn move_legacy_cloud_rows(
    app: &AppContext,
    db_path: &Path,
    config: &CloudConfig,
    session: &CloudSession,
    session_lease: &CloudSessionUseLease,
) -> Result<usize, String> {
    let device_id = device_identity::for_db(db_path)?;
    let pending = {
        let conn = db::get_connection(db_path).map_err(|e| e.to_string())?;
        device_identity::legacy_machine_ids(&conn, &device_id).map_err(|e| e.to_string())?
    };
    if pending.is_empty() {
        return Ok(0);
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Cloud sync client unavailable: {e}"))?;
    let mut moved = 0;
    for legacy in pending {
        moved += move_one(
            app,
            &client,
            config,
            session,
            session_lease,
            &legacy,
            &device_id,
        )
        .await?;
        session_lease.commit_if_current(app, || {
            let state = gateway_cloud::load_state(db_path);
            if let Some(next) =
                gateway_cloud::move_state(&state, &session.user_id, &legacy, &device_id)
            {
                gateway_cloud::save_state(db_path, &next)?;
            }
            Ok(())
        })?;
    }
    if moved > 0 {
        log::info!("moved {moved} cloud rows to this computer's device id");
        session_lease.commit_if_current(app, || {
            cache::invalidate_cloud(db_path);
            Ok(())
        })?;
    }
    Ok(moved)
}

async fn move_one(
    app: &AppContext,
    client: &reqwest::Client,
    config: &CloudConfig,
    session: &CloudSession,
    session_lease: &CloudSessionUseLease,
    legacy: &str,
    device_id: &str,
) -> Result<usize, String> {
    let url = format!("{}/rest/v1/token_logs", config.supabase_url);
    let owner = format!("eq.{}", session.user_id);
    let machine = format!("eq.{legacy}");
    let mut after: i64 = 0;
    let mut moved = 0;
    // An old client can still update a copied row under the hostname (same
    // id, newer `updated_at`); such a row is not deleted and moves next sync.
    let mut fence: Option<DateTime<FixedOffset>> = None;
    loop {
        session_lease.ensure_current(app)?;
        let res = client
            .get(&url)
            .query(&[
                ("select", "*".to_string()),
                ("user_id", owner.clone()),
                ("machine_id", machine.clone()),
                ("id", format!("gt.{after}")),
                ("order", "id.asc".to_string()),
                ("limit", PAGE_SIZE.to_string()),
            ])
            .header("apikey", &config.supabase_key)
            .header("Authorization", format!("Bearer {}", session.access_token))
            .send()
            .await
            .map_err(|e| format!("Cloud sync failed: {e}"))?;
        session_lease.ensure_current(app)?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(supabase_api_error(status, body));
        }
        let rows: Vec<Value> = res
            .json()
            .await
            .map_err(|e| format!("Cloud sync failed: {e}"))?;
        let Some(last_id) = rows
            .last()
            .and_then(|row| row.get("id"))
            .and_then(Value::as_i64)
        else {
            break;
        };
        after = last_id;
        fence = fence.max(newest_update(&rows));
        let copies: Vec<Value> = rows
            .iter()
            .filter_map(|row| moved_row(row, legacy, device_id))
            .collect();
        if copies.len() != rows.len() {
            return Err("云端数据格式无法识别，设备 ID 迁移已停止，请稍后重试。".to_string());
        }
        // Rows under a renamed key may already exist under the device id.
        let renamed: Vec<String> = rows
            .iter()
            .zip(&copies)
            .filter(|(row, copy)| row.get("unique_key") != copy.get("unique_key"))
            .filter_map(|(_, copy)| Some(copy.get("unique_key")?.as_str()?.to_string()))
            .collect();
        let mut existing: HashMap<String, DateTime<FixedOffset>> = HashMap::new();
        for keys in renamed.chunks(LOOKUP_SIZE) {
            session_lease.ensure_current(app)?;
            let res = client
                .get(&url)
                .query(&[
                    ("select", "unique_key,updated_at".to_string()),
                    ("user_id", owner.clone()),
                    ("unique_key", gateway_cloud::postgrest_in_filter(keys)),
                ])
                .header("apikey", &config.supabase_key)
                .header("Authorization", format!("Bearer {}", session.access_token))
                .send()
                .await
                .map_err(|e| format!("Cloud sync failed: {e}"))?;
            session_lease.ensure_current(app)?;
            if !res.status().is_success() {
                let status = res.status();
                let body = res.text().await.unwrap_or_default();
                return Err(supabase_api_error(status, body));
            }
            let found: Vec<Value> = res
                .json()
                .await
                .map_err(|e| format!("Cloud sync failed: {e}"))?;
            for row in found {
                if let Some(key) = row.get("unique_key").and_then(Value::as_str) {
                    // An unreadable `updated_at` counts as old.
                    let at = updated_at(&row).unwrap_or(DateTime::<Utc>::MIN_UTC.fixed_offset());
                    existing.insert(key.to_string(), at);
                }
            }
        }
        let writes: Vec<Value> = rows
            .iter()
            .zip(copies)
            .filter(|(row, copy)| {
                let key = copy.get("unique_key").and_then(Value::as_str);
                copy_wins(row, key.and_then(|key| existing.get(key)).copied())
            })
            .map(|(_, copy)| copy)
            .collect();
        if !writes.is_empty() {
            session_lease.ensure_current(app)?;
            let res = client
                .post(format!("{url}?on_conflict=user_id,unique_key"))
                .header("apikey", &config.supabase_key)
                .header("Authorization", format!("Bearer {}", session.access_token))
                .header("Content-Type", "application/json")
                .header("Prefer", "resolution=merge-duplicates,return=minimal")
                .json(&writes)
                .send()
                .await
                .map_err(|e| format!("Cloud sync failed: {e}"))?;
            session_lease.ensure_current(app)?;
            if !res.status().is_success() {
                let status = res.status();
                let body = res.text().await.unwrap_or_default();
                return Err(supabase_api_error(status, body));
            }
        }
        moved += rows.len();
        if rows.len() < PAGE_SIZE {
            break;
        }
    }
    if moved == 0 {
        return Ok(0);
    }
    let mut filter = vec![
        ("user_id", owner),
        ("machine_id", machine),
        ("id", format!("lte.{after}")),
    ];
    if let Some(fence) = fence {
        filter.push(("updated_at", format!("lte.{}", fence.to_rfc3339())));
    }
    session_lease.ensure_current(app)?;
    let res = client
        .delete(&url)
        .query(&filter)
        .header("apikey", &config.supabase_key)
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("Prefer", "return=minimal")
        .send()
        .await
        .map_err(|e| format!("Cloud sync failed: {e}"))?;
    session_lease.ensure_current(app)?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(supabase_api_error(status, body));
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn copy_moves_aggregate_keys_and_drops_server_columns() {
        let row = json!({
            "id": 7, "created_at": "x", "updated_at": "y",
            "user_id": "u", "tool": "codex", "model": "m",
            "unique_key": "agg_MY-PC_codex_m_2026-10-01 10:00:00",
            "machine_id": "MY-PC", "requests": 3, "gateway_requests": null
        });
        let copy = moved_row(&row, "MY-PC", "tl-0123456789abcdef").unwrap();
        assert_eq!(
            copy,
            json!({
                "user_id": "u", "tool": "codex", "model": "m",
                "unique_key": "agg_tl-0123456789abcdef_codex_m_2026-10-01 10:00:00",
                "machine_id": "tl-0123456789abcdef", "requests": 3, "gateway_requests": null
            })
        );
    }

    #[test]
    fn the_newer_row_wins_when_the_device_id_already_has_the_hour() {
        let at = |text: &str| Some(DateTime::parse_from_rfc3339(text).unwrap());
        let source = json!({ "updated_at": "2026-10-24T10:00:00+00:00" });
        assert!(copy_wins(&source, None), "a free key is copied");
        assert!(
            !copy_wins(&source, at("2026-10-24T11:00:00+00:00")),
            "this computer's later upload is kept"
        );
        assert!(
            copy_wins(&source, at("2026-10-24T09:00:00+00:00")),
            "an earlier copy is refreshed when the source changed since"
        );
        assert!(!copy_wins(&json!({}), at("2026-10-24T09:00:00+00:00")));
    }

    #[test]
    fn gateway_state_follows_only_its_own_account_and_machine() {
        let mut state = gateway_cloud::CloudState {
            version: 1,
            user_id: "u".into(),
            machine_id: "MY-PC".into(),
            ..Default::default()
        };
        state.hours.insert(
            "2026-10-01 10:00:00".into(),
            gateway_cloud::HourState {
                fingerprint: "f".into(),
                keys: vec!["agg_MY-PC_codex_m_2026-10-01 10:00:00".into()],
                key_machine: None,
            },
        );
        let moved = gateway_cloud::move_state(&state, "u", "MY-PC", "tl-0123456789abcdef")
            .expect("moved state");
        assert_eq!(moved.machine_id, "tl-0123456789abcdef");
        assert_eq!(
            moved.hours["2026-10-01 10:00:00"].keys,
            vec!["agg_tl-0123456789abcdef_codex_m_2026-10-01 10:00:00".to_string()]
        );
        assert_eq!(
            moved.hours["2026-10-01 10:00:00"].key_machine.as_deref(),
            Some("MY-PC")
        );
        assert!(
            gateway_cloud::move_state(&state, "other", "MY-PC", "tl-0123456789abcdef").is_none()
        );
        assert!(gateway_cloud::move_state(&moved, "u", "MY-PC", "tl-0123456789abcdef").is_none());
    }

    #[test]
    fn the_delete_fence_is_the_newest_copied_update() {
        let rows = vec![
            json!({"id": 1, "updated_at": "2026-10-24T11:00:00.5+00:00"}),
            json!({"id": 2, "updated_at": "2026-10-24T19:00:01+08:00"}),
            json!({"id": 3}),
        ];
        assert_eq!(
            newest_update(&rows).map(|fence| fence.to_rfc3339()),
            Some("2026-10-24T19:00:01+08:00".to_string())
        );
        assert_eq!(newest_update(&[json!({"id": 1})]), None);
    }

    #[test]
    fn copy_keeps_keys_that_do_not_name_the_machine() {
        let row = json!({"id": 1, "unique_key": "raw-session-key", "machine_id": "MY-PC"});
        let copy = moved_row(&row, "MY-PC", "tl-0123456789abcdef").unwrap();
        assert_eq!(copy["unique_key"], "raw-session-key");
        assert_eq!(copy["machine_id"], "tl-0123456789abcdef");
        assert!(moved_row(&json!({"id": 1}), "MY-PC", "tl-0123456789abcdef").is_none());
    }
}
