//! Publishes only hourly aggregates, under the device that made the calls.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde_json::{json, Value};

use super::gateway_cloud::Aggregate;
use super::{estimate_cost_at, peer_shared, CloudConfig, CloudSession, CloudSessionUseLease};
use crate::{app_paths::AppContext, peer_sync};

const RPC: &str = "sync_shared_usage_v1";
const BATCH: usize = 250;

fn valid_source(source: &str) -> bool {
    !source.is_empty()
        && source.len() <= 64
        && source
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn aggregates(
    calls: &[peer_shared::SharedCall],
    local_source: Option<&str>,
    prices: &Value,
) -> BTreeMap<String, Vec<Aggregate>> {
    let mut seen = BTreeSet::new();
    let mut groups = BTreeMap::new();
    for call in calls {
        if Some(call.computer.as_str()) == local_source
            || !valid_source(&call.computer)
            || chrono::NaiveDateTime::parse_from_str(&call.source_hour, "%Y-%m-%d %H:%M:%S")
                .ok()
                .is_none_or(|time| {
                    use chrono::Timelike;
                    time.minute() != 0 || time.second() != 0
                })
            || !seen.insert((call.computer.as_str(), call.key.as_str()))
        {
            continue;
        }
        let agent = call.agent.to_ascii_lowercase();
        let tool = super::gateway_overlay::tool_for_agent(Some(&agent));
        let entry = groups
            .entry((&call.computer, tool.clone(), &call.model, &call.source_hour))
            .or_insert_with(|| Aggregate {
                tool: tool.clone(),
                model: call.model.clone(),
                hour: call.source_hour.clone(),
                machine_id: peer_shared::machine_id(&call.computer),
                input_tokens: 0,
                output_tokens: 0,
                cached_tokens: 0,
                cache_write_tokens: 0,
                cache_write_known: true,
                requests: 0,
                gateway_requests: 0,
                cost_usd: 0.0,
            });
        entry.input_tokens = entry.input_tokens.saturating_add(call.input);
        entry.output_tokens = entry.output_tokens.saturating_add(call.out);
        entry.cached_tokens = entry
            .cached_tokens
            .saturating_add(call.cache_read)
            .saturating_add(call.cache_write);
        entry.cache_write_tokens = entry.cache_write_tokens.saturating_add(call.cache_write);
        entry.requests += 1;
        entry.gateway_requests += 1;
        entry.cost_usd += estimate_cost_at(
            prices,
            &tool,
            &call.model,
            &call.source_hour,
            call.input,
            call.out,
            call.cache_read,
            call.cache_write,
        );
    }
    let mut by_source: BTreeMap<String, Vec<Aggregate>> = BTreeMap::new();
    for ((source, ..), aggregate) in groups {
        by_source.entry(source.clone()).or_default().push(aggregate);
    }
    by_source
}

fn payload(row: &Aggregate) -> Value {
    json!({
        "tool": row.tool, "model": row.model, "timestamp": row.hour,
        "input_tokens": row.input_tokens, "output_tokens": row.output_tokens,
        "cached_tokens": row.cached_tokens, "cache_write_tokens": row.cache_write_tokens,
        "cost_usd": row.cost_usd, "requests": row.requests,
    })
}

#[derive(Default)]
pub(super) struct Outcome {
    pub changed: usize,
    pub warning: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_follow_source_time_and_count_each_call_once_per_computer() {
        let parse = |source, hour, rid| {
            peer_shared::parse_call(
                source,
                &json!({
                    "t": hour, "rid": rid, "agent": "claude-code", "model": "example",
                    "in": 12, "out": 3, "cache_read": 7, "cache_write": 2,
                    "session": "private", "provider": "private"
                }),
            )
            .unwrap()
        };
        let first = parse("ab", "2026-11-18T04:27:00+05:30", "one");
        let second = parse("ab", "2026-11-18T04:59:00+05:30", "two");
        let self_call = parse("cd", "2026-11-18T04:27:00+05:30", "one");
        let mut legacy = parse("ef", "2026-11-18T04:27:00+00:00", "one");
        legacy.source_hour.clear();
        let grouped = aggregates(
            &[first.clone(), first, second, self_call, legacy],
            Some("cd"),
            &json!({}),
        );
        assert_eq!(grouped.len(), 1);
        let rows = &grouped["ab"];
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.hour, "2026-11-18 04:00:00");
        assert_eq!(row.machine_id, "peer:ab");
        assert_eq!(row.tool, "claude");
        assert_eq!(
            (
                row.input_tokens,
                row.output_tokens,
                row.cached_tokens,
                row.cache_write_tokens,
                row.requests
            ),
            (24, 6, 18, 4, 2)
        );
        let wire = payload(row);
        for field in ["session_id", "provider", "rid", "user_id", "key"] {
            assert!(wire.get(field).is_none());
        }
    }
}

pub(super) async fn sync(
    app: &AppContext,
    db_path: &Path,
    config: &CloudConfig,
    session: &CloudSession,
    lease: &CloudSessionUseLease,
    device: &str,
) -> Result<Outcome, String> {
    let local = peer_sync::shared::local_computer().filter(|id| valid_source(id));
    let selected: BTreeSet<_> = peer_sync::shared_selection(app.app_data_dir())
        .into_iter()
        .collect();
    let calls: Vec<_> = if selected.is_empty() {
        Vec::new()
    } else {
        peer_shared::read_calls(db_path)?
            .into_iter()
            .filter(|call| selected.contains(&call.computer))
            .collect()
    };
    let mut outcome = Outcome::default();
    if calls.iter().any(|call| call.source_hour.is_empty()) {
        outcome.warning = Some("请重新拉取共享用量，再同步到云端。".into());
    }
    if local.is_none() && calls.is_empty() {
        return Ok(outcome);
    }
    if !crate::device_identity::is_valid(device) {
        return Err("本机设备 ID 不可用，暂时无法同步共享用量。".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| "无法初始化共享用量同步。")?;
    let url = format!("{}/rest/v1/rpc/{RPC}", config.supabase_url);
    let transmit = |body: Value| {
        let req = client
            .post(&url)
            .header("apikey", &config.supabase_key)
            .bearer_auth(&session.access_token)
            .json(&body);
        async move {
            lease.ensure_current(app)?;
            let response = req
                .send()
                .await
                .map_err(|_| "共享用量上传失败，请重试。".to_string())?;
            let status = response.status();
            let body = response
                .text()
                .await
                .map_err(|_| "无法读取共享用量上传回执。".to_string())?;
            lease.ensure_current(app)?;
            if status.is_success() {
                return serde_json::from_str::<i64>(&body)
                    .map(Some)
                    .map_err(|_| "共享用量上传回执无效。".into());
            }
            if super::is_missing_rpc_signature(status, &body, RPC) {
                return Ok(None);
            }
            Err(format!("共享用量上传失败（HTTP {}）。", status.as_u16()))
        }
    };
    if let Some(source) = &local {
        let result = transmit(
            json!({"p_source": source, "p_device": device, "p_rows": [], "p_direct": true}),
        )
        .await?;
        match result {
            Some(count) => outcome.changed += count.max(0) as usize,
            None => {
                if !calls.is_empty() {
                    outcome.warning = Some("共享用量等待云端数据库升级。".into());
                }
                return Ok(outcome);
            }
        }
    }
    let prices = super::load_prices(app);
    for (source, rows) in aggregates(&calls, local.as_deref(), &prices) {
        for batch in rows.chunks(BATCH) {
            let rows: Vec<Value> = batch.iter().map(payload).collect();
            match transmit(
                json!({"p_source": source, "p_device": device, "p_rows": rows, "p_direct": false}),
            )
            .await
            {
                Ok(Some(-1)) => {
                    outcome.warning = Some("部分共享设备由另一台桌面端代传。".into());
                    break;
                }
                Ok(Some(count)) => outcome.changed += count.max(0) as usize,
                Ok(None) => {
                    outcome.warning = Some("共享用量等待云端数据库升级。".into());
                    return Ok(outcome);
                }
                Err(error) => {
                    lease.ensure_current(app)?;
                    outcome.warning = Some(error);
                    return Ok(outcome);
                }
            }
        }
    }
    Ok(outcome)
}
