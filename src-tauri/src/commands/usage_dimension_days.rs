use super::*;
use crate::usage_dimensions_publish::{DayData, MAX_SESSION_ROWS_PER_DAY};
use std::collections::BTreeMap;

pub(crate) fn local_usage_dimension_days(
    app: &AppContext,
    raw_query: LocalStatsQuery,
    include_stats: bool,
    include_sessions: bool,
    now: DateTime<Local>,
) -> Result<BTreeMap<String, DayData>, String> {
    let mut query = NormalizedStatsQuery::from_query(raw_query.clone())?;
    let machine = query
        .single_machine()
        .ok_or_else(|| "用量维度只允许读取本机".to_string())?
        .to_string();
    if crate::device_identity::for_data_dir(app.app_data_dir())? != machine {
        return Err("用量维度只允许读取本机".to_string());
    }
    let zoned_now = now.with_timezone(&query.tz);
    let bounds = query_bounds(query.range, zoned_now)?;
    let db_path = db::get_db_path(app);
    db::init_db(&db_path).map_err(|error| error.to_string())?;
    let signature = gateway_overlay::ledger_signature(&db_path);

    // Historical empty identities belong to this ledger. Filter before grouping,
    // while keeping the same gateway deduplication used by the local dashboard.
    query.machines.clear();
    let conn = gateway_overlay::open_local_stats_connection(&db_path, &machine)?;
    let mut sql = "SELECT id,tool,model,input_tokens,output_tokens,cached_tokens,
        cache_write_tokens,timestamp,session_id,cost_usd,coalesce(machine_id,''),
        cache_write_known,usage_provenance FROM token_logs
        WHERE coalesce(nullif(machine_id,''),?1) = ?1"
        .to_string();
    let mut values = vec![SqlValue::Text(machine.clone())];
    append_stats_filters_with_entity(
        &mut sql,
        &mut values,
        bounds.current_start.as_ref(),
        &bounds.current_end,
        &query,
        None,
    );
    sql.push_str(" ORDER BY timestamp DESC,id DESC");
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let local_rows = statement
        .query_map(params_from_iter(values.iter()), map_stat_row)
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    let rows = rows_in_timezone(&local_rows, query.tz)?;
    let providers = signature
        .as_deref()
        .filter(|_| include_stats)
        .map(|signature| gateway_overlay::row_providers(&db_path, signature))
        .transpose()?;
    let contexts = signature
        .as_deref()
        .filter(|_| include_stats)
        .map(|signature| gateway_overlay::row_contexts(&db_path, signature))
        .transpose()?;
    if gateway_overlay::ledger_signature(&db_path) != signature {
        return Err("用量来源在读取期间变化，请重试".to_string());
    }
    let prices = load_prices(app);
    let mut groups: BTreeMap<String, Vec<StatRow>> = BTreeMap::new();
    for row in rows {
        if let Some(date) = row.timestamp.get(..10) {
            groups.entry(date.to_string()).or_default().push(row);
        }
    }

    groups
        .into_iter()
        .map(|(date, rows)| {
            let mut daily = raw_query.clone();
            daily.start = Some(date.clone());
            daily.end = Some(date.clone());
            let query = NormalizedStatsQuery::from_query(daily)?;
            let bounds = query_bounds(query.range, zoned_now)?;
            let start = bounds.current_start.as_ref().map(DateTime::naive_local);
            let end = bounds.current_end.naive_local();
            let stats = include_stats.then(|| {
                let mut stats = json!({});
                if let Some(providers) = &providers {
                    stats["providers"] =
                        aggregate_provider_split(&rows, providers, &prices, start, end);
                }
                if let Some(contexts) = &contexts {
                    if let Some(composition) =
                        aggregate_context_composition(&rows, contexts, start, end)
                    {
                        stats["contextComposition"] = composition;
                    }
                }
                stats
            });
            let behavior = include_sessions
                .then(|| {
                    let window = BehaviorWindow {
                        start: bounds.current_start,
                        truncated: false,
                    };
                    build_local_behavior_analysis_with_limit::<MAX_SESSION_ROWS_PER_DAY>(
                        rows,
                        &query,
                        &bounds,
                        &window,
                        &prices,
                        zoned_now,
                        &BehaviorProjectScope::Unavailable,
                    )
                })
                .transpose()?;
            Ok((date, DayData { stats, behavior }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daily_source_filters_other_devices_before_gateway_deduplication() {
        let root = std::env::temp_dir().join(format!(
            "tokenledger-dimension-overlay-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let app = AppContext::for_test(root.clone());
        let machine = crate::device_identity::for_data_dir(app.app_data_dir()).unwrap();
        let db_path = db::get_db_path(&app);
        db::init_db(&db_path).unwrap();
        let conn = db::get_connection(&db_path).unwrap();
        for (key, identity, at) in [
            ("foreign", "other-device", "2026-10-20 10:00:00"),
            ("local", machine.as_str(), "2026-10-20 10:00:02"),
        ] {
            conn.execute(
                "INSERT INTO token_logs
                 (tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,
                  timestamp,session_id,unique_key,machine_id,sync_status)
                 VALUES ('test-tool','test-model',200,80,0,0,?1,'scanned-session',?2,?3,0)",
                params![at, key, identity],
            )
            .unwrap();
        }
        drop(conn);
        let at = Local.with_ymd_and_hms(2026, 10, 20, 10, 0, 0).unwrap();
        let gateway = app.app_data_dir().join("gateway");
        std::fs::create_dir_all(&gateway).unwrap();
        std::fs::write(
            gateway.join("usage-v1.jsonl"),
            format!(
                "{}\n",
                json!({
                    "ts": at.with_timezone(&Utc).to_rfc3339(), "requestId": "local-request",
                    "agent": "test-tool", "session": null, "endpoint": "responses",
                    "provider": "openai", "requestedModel": "test-model",
                    "upstreamModel": "test-model", "wire": "responses", "stream": false,
                    "status": 200, "ok": true, "input": 200, "output": 80,
                    "cacheRead": 0, "cacheWrite": 0, "latencyMs": 0, "error": null,
                    "context": {
                        "systemBytes": 100, "toolsBytes": 0, "historyBytes": 0,
                        "toolResultsBytes": 0, "attachmentsBytes": 0,
                        "messages": 1, "toolResults": 0, "attachments": 0
                    }
                })
            ),
        )
        .unwrap();
        let shared = peer_shared::parse_call(
            "other-device",
            &json!({
                "t": at.with_timezone(&Utc).to_rfc3339(), "rid": "foreign-request",
                "agent": "test-tool", "provider": "openai", "model": "test-model",
                "in": 10000, "out": 100, "status": 200, "session": "foreign-session"
            }),
        )
        .unwrap();
        peer_shared::write_store(&db_path, &[shared], vec![]).unwrap();
        let query: LocalStatsQuery = serde_json::from_value(json!({
            "range": "custom", "timezone": "local", "machines": [machine],
            "start": "2026-10-20", "end": "2026-10-20"
        }))
        .unwrap();
        let days = local_usage_dimension_days(&app, query, true, true, at).unwrap();
        let day = &days["2026-10-20"];
        let stats = day.stats.as_ref().unwrap();
        assert_eq!(stats["providers"]["openai"]["total"], 280);
        assert_eq!(stats["providers"]["openai"]["requests"], 1);
        assert_eq!(stats["contextComposition"]["requests"], 1);
        assert_eq!(stats["contextComposition"]["systemBytes"], 100);
        let behavior = day.behavior.as_ref().unwrap();
        assert_eq!(behavior["summary"]["tokens"], 280);
        assert_eq!(behavior["summary"]["requests"], 1);
        assert_eq!(behavior["summary"]["unknownSessionRecords"], 1);
        assert!(behavior["sessions"].as_array().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn daily_source_keeps_legacy_empty_identity_and_excludes_other_devices() {
        let dir = std::env::temp_dir().join(format!(
            "tokenledger-dimension-days-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let app = AppContext::for_test(dir);
        let machine = crate::device_identity::for_data_dir(app.app_data_dir()).unwrap();
        let db_path = db::get_db_path(&app);
        let legacy = Connection::open(&db_path).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE token_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT NOT NULL,
                    model TEXT NOT NULL, input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL, cached_tokens INTEGER DEFAULT 0,
                    cache_write_tokens INTEGER NOT NULL DEFAULT 0, timestamp TEXT NOT NULL,
                    session_id TEXT NOT NULL, unique_key TEXT UNIQUE NOT NULL,
                    cost_usd REAL, machine_id TEXT DEFAULT '',
                    sync_status INTEGER NOT NULL DEFAULT 0, cloud_user_id TEXT, synced_at TEXT
                );",
            )
            .unwrap();
        drop(legacy);
        db::init_db(&db_path).unwrap();
        let conn = db::get_connection(&db_path).unwrap();
        for (key, identity, input) in [
            ("local", Some(machine.as_str()), 10),
            ("legacy", None, 20),
            ("blank", Some(""), 30),
            ("foreign", Some("other-device"), 1000),
        ] {
            conn.execute(
                "INSERT INTO token_logs
                 (tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,
                  timestamp,session_id,unique_key,machine_id,sync_status)
                 VALUES ('test-tool','test-model',?1,5,7,0,'2026-10-20 10:00:00',
                         'same-session',?2,?3,0)",
                params![input, key, identity],
            )
            .unwrap();
        }
        let query = LocalStatsQuery {
            range: "custom".to_string(),
            timezone: "local".to_string(),
            machines: Some(vec![machine]),
            machine: None,
            tools: None,
            tool: None,
            models: None,
            model: None,
            search: None,
            token_mode: Some("effective".to_string()),
            start: Some("2026-10-20".to_string()),
            end: Some("2026-10-24".to_string()),
        };
        let now = Local.with_ymd_and_hms(2026, 10, 24, 12, 0, 0).unwrap();
        let days = local_usage_dimension_days(&app, query.clone(), true, true, now).unwrap();
        assert_eq!(days.len(), 1);
        let sessions = &days["2026-10-20"].behavior.as_ref().unwrap()["sessions"];
        assert_eq!(sessions.as_array().unwrap().len(), 1);
        assert_eq!(sessions[0]["tokens"], 75);
        assert_eq!(sessions[0]["requests"], 3);
        assert_eq!(days["2026-10-20"].stats.as_ref().unwrap(), &json!({}));

        let mut foreign_query = query.clone();
        foreign_query.machines = Some(vec!["other-device".to_string()]);
        assert!(local_usage_dimension_days(&app, foreign_query, true, true, now).is_err());

        for index in 0..500 {
            conn.execute(
                "INSERT INTO token_logs
                 (tool,model,input_tokens,output_tokens,timestamp,session_id,unique_key,machine_id)
                 VALUES ('test-tool','test-model',?1,5,'2026-10-20 10:00:00',?2,?2,?3)",
                params![
                    index + 100,
                    format!("session-{index}"),
                    query.machines.as_ref().unwrap()[0]
                ],
            )
            .unwrap();
        }
        let days = local_usage_dimension_days(&app, query, false, true, now).unwrap();
        let behavior = days["2026-10-20"].behavior.as_ref().unwrap();
        let upload = crate::usage_dimensions_publish::session_day("2026-10-20", behavior, &[7; 32]);
        assert_eq!(upload["rows"].as_array().unwrap().len(), 500);
        assert_eq!(upload["truncated"], true);
        assert_eq!(behavior["summary"]["sessionCount"], 501);
    }
}
