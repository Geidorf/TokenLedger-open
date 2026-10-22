use super::*;

fn dashboard_fixture(name: &str) -> Value {
    let raw = match name {
        "legacy-v1.json" => {
            include_str!("../../../fixtures/dashboard-stats-v2/legacy-v1.json")
        }
        "complete-v2.json" => {
            include_str!("../../../fixtures/dashboard-stats-v2/complete-v2.json")
        }
        "missing-optionals-v2.json" => {
            include_str!("../../../fixtures/dashboard-stats-v2/missing-optionals-v2.json")
        }
        "unknown-fields-v2.json" => {
            include_str!("../../../fixtures/dashboard-stats-v2/unknown-fields-v2.json")
        }
        "unknown-cost-cache-provenance-v2.json" => {
            include_str!(
                "../../../fixtures/dashboard-stats-v2/unknown-cost-cache-provenance-v2.json"
            )
        }
        "daily-costs-v2.json" => {
            include_str!("../../../fixtures/dashboard-stats-v2/daily-costs-v2.json")
        }
        "daily-costs-unavailable-v2.json" => {
            include_str!("../../../fixtures/dashboard-stats-v2/daily-costs-unavailable-v2.json")
        }
        _ => panic!("unknown dashboard fixture: {name}"),
    };
    serde_json::from_str(raw).expect("shared dashboard fixture must be valid JSON")
}

fn has_valid_stats_v1_core(value: &Value) -> bool {
    let Some(root) = value.as_object() else {
        return false;
    };
    let Some(summary) = root.get("summary").and_then(Value::as_object) else {
        return false;
    };
    let required_summary = [
        "totalTokens",
        "inputTokens",
        "outputTokens",
        "cachedTokens",
        "totalCost",
        "totalRequests",
        "avgTokensPerReq",
    ];
    required_summary.iter().all(|field| {
        summary
            .get(*field)
            .and_then(Value::as_f64)
            .is_some_and(|number| number.is_finite() && number >= 0.0)
    }) && root.get("tools").is_some_and(Value::is_object)
        && root.get("models").is_some_and(Value::is_object)
        && root.get("trends").is_some_and(Value::is_array)
        && root.get("heatmap").is_some_and(Value::is_object)
        && root.get("history").is_some_and(Value::is_array)
}

fn details_query() -> UsageDetailsQuery {
    UsageDetailsQuery {
        scope: Some("cloud".to_string()),
        range: "week".to_string(),
        timezone: "Asia/Shanghai".to_string(),
        machines: None,
        machine: Some("all_cloud".to_string()),
        tools: None,
        tool: Some("codex".to_string()),
        models: None,
        model: Some("".to_string()),
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
        cursor: Some(format!("v1.{}.9", encode_hex(b"2026-07-15 10:00:00"))),
        limit: Some(1_000),
    }
}

fn entity_query(tool: Option<&str>, model: Option<&str>) -> EntityDashboardQuery {
    EntityDashboardQuery {
        scope: Some("cloud".to_string()),
        entity: None,
        range: "month".to_string(),
        timezone: "America/New_York".to_string(),
        machines: None,
        machine: Some("mac".to_string()),
        tools: None,
        tool: tool.map(str::to_string),
        models: None,
        model: model.map(str::to_string),
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    }
}

fn local_stat_row(id: i64, timestamp: &str, input: i64, output: i64, cost: f64) -> StatRow {
    StatRow {
        id,
        tool: "codex".to_string(),
        model: "gpt-5".to_string(),
        input_tokens: input,
        output_tokens: output,
        cached_tokens: 5,
        cache_write_tokens: 1,
        cache_write_known: None,
        usage_provenance: None,
        timestamp: timestamp.to_string(),
        session_id: format!("session-{id}"),
        cost_usd: Some(cost),
        machine_id: "mac".to_string(),
    }
}

#[test]
fn shared_dashboard_fixtures_preserve_v1_v2_and_additive_compatibility() {
    let legacy = dashboard_fixture("legacy-v1.json");
    assert!(has_valid_stats_v1_core(&legacy));
    assert!(legacy.get("meta").is_none());
    assert_eq!(legacy["summary"]["totalTokens"], json!(10));

    let complete = dashboard_fixture("complete-v2.json");
    assert!(has_valid_stats_v1_core(&complete));
    assert_eq!(complete["meta"]["contractVersion"], json!(2));
    assert_eq!(
        complete["meta"]["capabilities"]["detailPagination"],
        json!(true)
    );
    assert_eq!(complete["historyPage"]["totalCount"], json!(3));
    assert_eq!(
        complete["comparison"]["window"]["kind"],
        json!("dayOverDay")
    );
    assert_eq!(
        complete["comparison"]["current"]["series"]
            .as_array()
            .expect("dense current comparison series")
            .len(),
        11
    );
    assert_eq!(
        complete["machineDistribution"][0],
        json!({
            "value": "macbook-pro",
            "tokens": 1200,
            "inputTokens": 900,
            "outputTokens": 300,
            "cachedTokens": 200,
            "cacheWriteTokens": 50,
            "requests": 3,
            "cost": 0.42
        })
    );

    let missing = dashboard_fixture("missing-optionals-v2.json");
    assert!(has_valid_stats_v1_core(&missing));
    assert!(missing.get("comparison").is_none());
    assert!(missing.get("historyPage").is_none());
    assert!(missing.get("machineDistribution").is_none());
    assert!(missing["meta"]["capabilities"]
        .as_object()
        .expect("capabilities object")
        .is_empty());

    let unknown = dashboard_fixture("unknown-fields-v2.json");
    assert!(has_valid_stats_v1_core(&unknown));
    assert_eq!(unknown["futureTopLevelEnvelope"]["schema"], json!(3));
    assert_eq!(
        unknown["meta"]["capabilities"]["futureCapability"],
        json!(true)
    );

    let provenance = dashboard_fixture("unknown-cost-cache-provenance-v2.json");
    assert!(has_valid_stats_v1_core(&provenance));
    assert_eq!(provenance["models"]["known-free"]["cost"], json!(0));
    assert!(provenance["models"]["unknown-cost-combined-cache"]
        .as_object()
        .expect("unknown cost model")
        .get("cost")
        .is_none());
    assert_eq!(
        provenance["models"]["explicit-split"]["cacheRead"],
        json!(80)
    );
    assert_eq!(
        provenance["models"]["explicit-split"]["cacheWrite"],
        json!(20)
    );
    assert_ne!(
        provenance["models"]["inconsistent-cache-split"]["cached"]
            .as_i64()
            .expect("combined cache"),
        provenance["models"]["inconsistent-cache-split"]["cacheRead"]
            .as_i64()
            .unwrap()
            + provenance["models"]["inconsistent-cache-split"]["cacheWrite"]
                .as_i64()
                .unwrap()
    );

    assert!(!has_valid_stats_v1_core(&json!({
        "summary": { "totalTokens": 3, "inputTokens": 1, "outputTokens": 2 },
        "tools": {}, "models": {}, "trends": [], "heatmap": {}, "history": []
    })));
}

#[test]
fn scope_defaults_to_local_and_rejects_unknown_values() {
    assert_eq!(StatsScope::parse(None).unwrap(), StatsScope::Local);
    assert_eq!(StatsScope::parse(Some("")).unwrap(), StatsScope::Local);
    assert_eq!(StatsScope::parse(Some("CLOUD")).unwrap(), StatsScope::Cloud);
    assert!(StatsScope::parse(Some("hybrid")).is_err());
}

#[test]
fn cloud_payloads_are_normalized_and_never_include_credentials() {
    let request = normalize_details_request(&details_query()).expect("normalize detail query");
    assert_eq!(request.limit, 100);
    assert!(request.query.machines.is_empty());
    assert!(request.query.models.is_empty());
    let details = details_v2_rpc_payload("user-123", &request);
    assert_eq!(
        details,
        json!({
            "p_user": "user-123",
            "p_query": {
                "range": "week",
                "timezone": "Asia/Shanghai",
                "machines": [],
                "tools": ["codex"],
                "models": [],
                "search": Value::Null,
                "tokenMode": "effective"
            },
            "p_cursor": request.cursor,
            "p_limit": 100
        })
    );

    let entity = normalize_entity_query(&entity_query(Some("codex"), Some("gpt-5")))
        .expect("normalize entity query");
    assert_eq!(
        entity_v2_rpc_payload("user-123", &entity),
        json!({
            "p_user": "user-123",
            "p_query": {
                "range": "month",
                "timezone": "America/New_York",
                "machines": ["mac"],
                "tools": ["codex"],
                "models": [],
                "search": Value::Null,
                "tokenMode": "effective"
            },
            "p_entity": { "kind": "model", "id": "gpt-5" },
            "p_cursor": Value::Null,
            "p_limit": 20
        })
    );
    let comparison = query_v2_rpc_payload("user-123", &entity.query);
    assert_eq!(comparison["p_query"]["tools"], json!(["codex"]));

    let modern = dashboard_legacy_rpc_payload("user-123", &entity.query, true);
    let legacy = dashboard_legacy_rpc_payload("user-123", &entity.query, false);
    assert_eq!(modern["p_timezone"], json!("America/New_York"));
    assert!(legacy.get("p_timezone").is_none());
    let serialized = serde_json::to_string(&(details, modern, legacy)).unwrap();
    assert!(!serialized.contains("access_token"));
    assert!(!serialized.contains("refresh_token"));
}

#[test]
fn cloud_endpoint_matrix_only_allows_lossless_legacy_fallbacks() {
    assert_eq!(RPC_DASHBOARD_STATS_V2, "get_dashboard_stats_v2");
    assert_eq!(RPC_USAGE_COMPARISON_V2, "get_usage_comparison_v2");
    assert_eq!(RPC_USAGE_DETAILS_V2, "get_usage_details_v2");
    assert_eq!(RPC_ENTITY_DASHBOARD_V2, "get_usage_entity_dashboard_v2");

    let multi = NormalizedStatsQuery::from_query(LocalStatsQuery {
        range: "month".to_string(),
        timezone: "UTC".to_string(),
        machines: Some(vec!["mac".into(), "windows".into()]),
        machine: None,
        tools: Some(vec!["claude".into(), "codex".into()]),
        tool: None,
        models: Some(vec!["gpt-5".into()]),
        model: None,
        search: Some("session".to_string()),
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    })
    .unwrap();
    assert!(!multi.legacy_dashboard_representable());
    assert!(!multi.legacy_filter_representable());
    let payload = query_v2_rpc_payload("user-123", &multi);
    let mut keys = payload
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(keys, vec!["p_query".to_string(), "p_user".to_string()]);

    let comparison_only = NormalizedStatsQuery::from_query(LocalStatsQuery {
        range: "week".to_string(),
        timezone: "UTC".to_string(),
        machines: Some(vec!["mac".into()]),
        machine: None,
        tools: Some(vec!["codex".into()]),
        tool: None,
        models: Some(vec!["gpt-5".into()]),
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    })
    .unwrap();
    assert!(!comparison_only.legacy_dashboard_representable());
    assert!(comparison_only.legacy_filter_representable());

    let model_entity = normalize_entity_query(&EntityDashboardQuery {
        scope: Some("cloud".to_string()),
        entity: Some(EntitySelectorInput {
            kind: "model".to_string(),
            id: "gpt-5".to_string(),
        }),
        range: "month".to_string(),
        timezone: "UTC".to_string(),
        machines: Some(vec!["mac".into()]),
        machine: None,
        tools: Some(vec!["codex".into()]),
        tool: None,
        models: Some(vec![]),
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    })
    .unwrap();
    assert!(model_entity.legacy_representable());

    let mut searched_model_entity = model_entity.clone();
    searched_model_entity.query.search = Some("session".to_string());
    assert!(!searched_model_entity.legacy_representable());

    let tool_with_model_context = normalize_entity_query(&EntityDashboardQuery {
        scope: Some("cloud".to_string()),
        entity: Some(EntitySelectorInput {
            kind: "tool".to_string(),
            id: "codex".to_string(),
        }),
        range: "month".to_string(),
        timezone: "UTC".to_string(),
        machines: None,
        machine: None,
        tools: Some(vec![]),
        tool: None,
        models: Some(vec!["gpt-5".into()]),
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    })
    .unwrap();
    assert!(!tool_with_model_context.legacy_representable());
    assert!(is_legacy_detail_cursor("v1.32303236.7"));
    assert!(!is_legacy_detail_cursor("v2.fingerprint.32303236.7"));
}

#[test]
fn cloud_v2_echo_validation_rejects_missing_mismatched_and_cross_entity_data() {
    let details = normalize_details_request(&details_query()).unwrap();
    let canonical = json!({
        "meta": {
            "query": details.query.echo_json(),
            "capabilities": { "multiFilterSearch": true }
        }
    });
    validate_cloud_v2_echo(&canonical, &details.query, None).unwrap();
    let mut dashboard_tree = canonical.clone();
    dashboard_tree["historyPage"] = canonical.clone();
    validate_cloud_v2_echoes(&dashboard_tree, &details.query, None, &["historyPage"]).unwrap();
    dashboard_tree["historyPage"]["meta"]["query"]["search"] = json!("stale-child");
    assert!(
        validate_cloud_v2_echoes(&dashboard_tree, &details.query, None, &["historyPage"])
            .unwrap_err()
            .contains("does not match")
    );

    let legacy_singular = json!({
        "meta": {
            "query": {
                "range": "week",
                "timezone": "Asia/Shanghai",
                "machine": Value::Null,
                "tool": "codex",
                "model": Value::Null,
                "tokenMode": "effective"
            }
        }
    });
    validate_cloud_v2_echo(&legacy_singular, &details.query, None)
        .expect("old singular-only v2 echo remains readable");

    assert!(
        validate_cloud_v2_echo(&json!({ "meta": {} }), &details.query, None)
            .unwrap_err()
            .contains("missing")
    );

    let mut mismatched = canonical.clone();
    mismatched["meta"]["query"]["search"] = json!("another-session");
    assert!(validate_cloud_v2_echo(&mismatched, &details.query, None)
        .unwrap_err()
        .contains("does not match"));

    let mut conflicting = canonical.clone();
    conflicting["meta"]["query"]["tools"] = json!(["claude"]);
    conflicting["meta"]["query"]["tool"] = json!("codex");
    assert!(validate_cloud_v2_echo(&conflicting, &details.query, None)
        .unwrap_err()
        .contains("malformed"));

    let entity = normalize_entity_query(&entity_query(Some("codex"), Some("gpt-5"))).unwrap();
    let mut entity_response = json!({
        "meta": {
            "query": entity.query.echo_json(),
            "entity": entity_json(&entity.entity)
        }
    });
    validate_cloud_v2_echo(&entity_response, &entity.query, Some(&entity.entity)).unwrap();
    entity_response["meta"]["entity"]["id"] = json!("gpt-5-mini");
    assert!(
        validate_cloud_v2_echo(&entity_response, &entity.query, Some(&entity.entity))
            .unwrap_err()
            .contains("does not match")
    );
    assert!(validate_cloud_v2_echo(
        &json!({
            "meta": {
                "query": details.query.echo_json(),
                "entity": { "kind": "tool", "id": "codex" }
            }
        }),
        &details.query,
        None,
    )
    .unwrap_err()
    .contains("unexpectedly"));
}

#[test]
fn cloud_bridge_preserves_optional_daily_costs_and_legacy_absence() {
    let query = NormalizedStatsQuery::from_query(LocalStatsQuery {
        range: "month".to_string(),
        timezone: "Asia/Shanghai".to_string(),
        machines: None,
        machine: None,
        tools: None,
        tool: None,
        models: None,
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    })
    .unwrap();
    for name in ["daily-costs-v2.json", "daily-costs-unavailable-v2.json"] {
        let source = dashboard_fixture(name);
        assert!(has_valid_stats_v1_core(&source));
        let expected = source["dailyCosts"].clone();
        let marked = mark_cloud_v2_response(source.clone(), &query, None, true).unwrap();
        let merged = merge_cloud_dashboard(source, None, true, true, true, &query).unwrap();
        assert_eq!(marked["dailyCosts"], expected);
        assert_eq!(merged["dailyCosts"], expected);
        let persisted: Value = serde_json::from_str(&merged.to_string()).unwrap();
        assert_eq!(persisted["dailyCosts"], expected);
        assert_eq!(persisted["meta"]["query"]["range"], json!("month"));
    }
    for name in ["legacy-v1.json", "missing-optionals-v2.json"] {
        let merged =
            merge_cloud_dashboard(dashboard_fixture(name), None, false, false, false, &query)
                .unwrap();
        assert!(merged.get("dailyCosts").is_none());
    }
}

#[test]
fn cloud_dashboard_merge_marks_v2_and_legacy_capabilities_truthfully() {
    let query = NormalizedStatsQuery::from_query(LocalStatsQuery {
        range: "month".to_string(),
        timezone: "America/New_York".to_string(),
        machines: Some(vec!["mac".into()]),
        machine: None,
        tools: Some(vec!["codex".into()]),
        tool: None,
        models: None,
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    })
    .unwrap();
    let base = json!({
        "summary": { "totalTokens": 12 },
        "meta": { "generatedAt": "2026-07-15T00:00:00Z" }
    });
    let comparison = json!({
        "window": { "kind": "dayOverDay" },
        "current": { "series": [] },
        "previous": { "series": [] }
    });
    let v2 = merge_cloud_dashboard(
        base.clone(),
        Some(comparison.clone()),
        true,
        true,
        true,
        &query,
    )
    .unwrap();
    assert_eq!(v2["comparison"], comparison);
    assert_eq!(v2["meta"]["contractVersion"], json!(2));
    assert_eq!(v2["meta"]["scope"], json!("cloud"));
    assert_eq!(v2["meta"]["query"]["tool"], json!("codex"));
    assert_eq!(v2["meta"]["capabilities"]["comparison"], json!(true));
    assert_eq!(v2["meta"]["capabilities"]["detailPagination"], json!(true));
    assert_eq!(v2["meta"]["capabilities"]["entityDashboard"], json!(true));

    let no_automatic_baseline =
        merge_cloud_dashboard(base.clone(), Some(Value::Null), true, true, true, &query)
            .expect("year/all v2 response");
    assert_eq!(
        no_automatic_baseline["meta"]["capabilities"]["comparison"],
        json!(false)
    );
    assert_eq!(
        no_automatic_baseline["meta"]["capabilities"]["detailPagination"],
        json!(true)
    );

    let legacy =
        merge_cloud_dashboard(base, None, false, false, false, &query).expect("legacy fallback");
    assert!(legacy.get("comparison").is_none());
    assert!(legacy["meta"].get("contractVersion").is_none());
    assert_eq!(
        legacy["meta"]["capabilities"],
        json!({
            "comparison": false,
            "detailPagination": false,
            "entityDashboard": false,
            "multiFilterSearch": false,
            "quotaSnapshots": false
        })
    );
}

#[test]
fn missing_rpc_detection_and_unavailable_responses_are_stable_and_redacted() {
    let missing_body = r#"{"code":"PGRST202","message":"Could not find the function public.get_usage_details_v1 in the schema cache","hint":"access_token=do-not-echo"}"#;
    assert!(is_missing_rpc_signature(
        reqwest::StatusCode::NOT_FOUND,
        missing_body,
        RPC_USAGE_DETAILS
    ));
    assert!(!is_missing_rpc_signature(
        reqwest::StatusCode::BAD_REQUEST,
        missing_body,
        RPC_USAGE_DETAILS
    ));
    assert!(!is_missing_rpc_signature(
        reqwest::StatusCode::NOT_FOUND,
        missing_body,
        RPC_ENTITY_DASHBOARD
    ));

    let request = normalize_details_request(&details_query()).unwrap();
    let unavailable = cloud_details_unavailable(&request.query, None);
    assert_eq!(unavailable["status"], json!("unavailable"));
    assert!(unavailable["totalCount"].is_null());
    assert!(unavailable["hasMore"].is_null());
    assert_eq!(
        unavailable["meta"]["capabilities"]["detailPagination"],
        json!(false)
    );
    let serialized = serde_json::to_string(&unavailable).unwrap();
    assert!(!serialized.contains("do-not-echo"));
    assert!(!serialized.contains("access_token"));

    let safe_error = supabase_api_error(
        reqwest::StatusCode::BAD_GATEWAY,
        "access_token=secret-value".to_string(),
    );
    assert_eq!(safe_error, "Supabase API request failed (HTTP 502).");
    assert!(!safe_error.contains("secret-value"));
    assert_eq!(
        CloudRpcFailure::new(RPC_USAGE_DETAILS, CloudRpcFailureKind::Http(500)).safe_message(),
        "Cloud RPC request failed (HTTP 500)."
    );
}

#[test]
fn entity_validation_and_unavailable_shape_preserve_known_context_only() {
    let missing_entity = entity_query(None, None);
    assert!(normalize_entity_query(&missing_entity).is_err());

    let normalized = normalize_entity_query(&entity_query(Some("codex"), Some("gpt-5")))
        .expect("valid entity query");
    let unavailable = cloud_entity_unavailable(&normalized);
    assert_eq!(unavailable["status"], json!("unavailable"));
    assert_eq!(unavailable["entity"]["kind"], json!("model"));
    assert_eq!(unavailable["entity"]["tool"], json!("codex"));
    assert_eq!(unavailable["entity"]["model"], json!("gpt-5"));
    assert!(unavailable["summary"].is_null());
    assert!(unavailable["historyPage"]["totalCount"].is_null());
    assert_eq!(
        unavailable["meta"]["query"]["tokenMode"],
        json!("effective")
    );
}

#[test]
fn cloud_detail_success_is_enriched_without_changing_effective_tokens() {
    let request = normalize_details_request(&details_query()).unwrap();
    let response = post_process_cloud_details(
        json!({
            "items": [{
                "id": 1,
                "inputTokens": 10,
                "outputTokens": 4,
                "cachedTokens": 9,
                "cacheWriteTokens": 3
            }],
            "filteredSummary": {
                "totalTokens": 14,
                "cachedTokens": 9
            },
            "meta": {
                "contractVersion": 2,
                "capabilities": { "multiFilterSearch": true }
            }
        }),
        &request.query,
        true,
    )
    .unwrap();
    assert_eq!(response["items"][0]["cacheReadTokens"], json!(6));
    assert_eq!(response["items"][0]["granularity"], json!("hour"));
    assert_eq!(
        response["filteredSummary"]["totalTokens"],
        json!(14),
        "cache volume must not be added to effective tokens"
    );
    assert_eq!(
        response["meta"]["capabilities"]["detailPagination"],
        json!(true)
    );
    assert_eq!(
        response["meta"]["capabilities"]["multiFilterSearch"],
        json!(true)
    );

    let entity_request =
        normalize_entity_query(&entity_query(Some("codex"), Some("gpt-5"))).unwrap();
    let entity = post_process_cloud_entity(
        json!({
            "comparison": { "current": {}, "previous": {} },
            "historyPage": {
                "items": [{ "cachedTokens": 5, "cacheWriteTokens": 2 }]
            },
            "meta": { "capabilities": { "multiFilterSearch": true } }
        }),
        &entity_request,
        true,
    )
    .unwrap();
    assert_eq!(
        entity["historyPage"]["items"][0]["cacheReadTokens"],
        json!(3)
    );
    assert_eq!(entity["meta"]["capabilities"]["comparison"], json!(true));
    assert_eq!(
        entity["meta"]["capabilities"]["multiFilterSearch"],
        json!(true)
    );

    let unadvertised =
        post_process_cloud_details(json!({ "items": [], "meta": {} }), &request.query, true)
            .unwrap();
    assert_eq!(
        unadvertised["meta"]["capabilities"]["multiFilterSearch"],
        json!(false),
        "one v2 endpoint must not advertise the full query chain by itself"
    );
}

#[test]
fn local_entity_merge_reuses_filtered_stats_and_detail_page() {
    let query = normalize_entity_query(&EntityDashboardQuery {
        scope: Some("local".to_string()),
        entity: None,
        range: "today".to_string(),
        timezone: "Asia/Shanghai".to_string(),
        machines: None,
        machine: Some("mac".to_string()),
        tools: None,
        tool: Some("codex".to_string()),
        models: None,
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    })
    .unwrap();
    let stats = json!({
        "summary": { "totalTokens": 30, "totalRequests": 2 },
        "comparison": {
            "current": { "series": [
                { "bucket": "09:00", "tokens": 10, "requests": 1, "cost": 0.1 },
                { "bucket": "10:00", "tokens": 20, "requests": 1, "cost": 0.2 }
            ] }
        },
        "trends": [
            { "date": "09:00", "codex": 10 },
            { "date": "10:00", "codex": 20 }
        ],
        "tools": {
            "codex": { "total": 30, "input": 20, "output": 10, "cached": 5, "cacheRead": 4, "cacheWrite": 1, "requests": 2, "cost": 0.3 }
        },
        "models": {
            "gpt-5": { "total": 30, "input": 20, "output": 10, "cached": 5, "requests": 2, "cost": 0.3 }
        },
        "heatmap": { "2026-07-14": 0, "2026-07-15": 30 },
        "meta": { "contractVersion": 2, "timezone": "Asia/Shanghai" }
    });
    let details = json!({
        "items": [{ "id": 7 }],
        "totalCount": 2,
        "availableFilters": {
            "machines": [{ "value": "mac", "count": 2 }]
        }
    });
    let now = query
        .query
        .tz
        .with_ymd_and_hms(2026, 7, 15, 10, 30, 0)
        .single()
        .unwrap();
    let bounds = query_bounds(query.query.range, now).unwrap();
    let rows = vec![
        local_stat_row(1, "2026-07-15 09:00:00", 7, 3, 0.1),
        local_stat_row(2, "2026-07-15 10:00:00", 13, 7, 0.2),
    ];
    let metrics = build_local_entity_metrics(
        &rows,
        &bounds,
        &query.query,
        &json!({}),
        json!({ "2026-01-01": 5, "2026-07-15": 30 }),
    );
    let dashboard = build_local_entity_dashboard(stats, details.clone(), &query, metrics).unwrap();

    assert_eq!(dashboard["entity"]["kind"], json!("tool"));
    assert_eq!(dashboard["summary"]["totalTokens"], json!(30));
    assert_eq!(dashboard["composition"]["tools"][0]["tokens"], json!(30));
    assert_eq!(
        dashboard["composition"]["models"][0]["value"],
        json!("gpt-5")
    );
    assert_eq!(
        dashboard["composition"]["machines"][0]["value"],
        json!("mac")
    );
    assert_eq!(dashboard["composition"]["machines"][0]["tokens"], json!(30));
    assert_eq!(
        dashboard["composition"]["machines"][0]["requests"],
        json!(2)
    );
    assert!(
        (dashboard["composition"]["machines"][0]["cost"]
            .as_f64()
            .unwrap()
            - 0.3)
            .abs()
            < 1e-9
    );
    assert_eq!(dashboard["peak"]["bucket"], json!("10:00"));
    assert_eq!(dashboard["peak"]["requests"], json!(1));
    assert_eq!(dashboard["peak"]["cost"], json!(0.2));
    assert_eq!(dashboard["activity"]["activeDays"], json!(1));
    assert_eq!(
        dashboard["activity"]["firstSeenAt"],
        json!("2026-07-15 09:00:00")
    );
    assert_eq!(dashboard["heatmap"]["2026-01-01"], json!(5));
    assert_eq!(dashboard["historyPage"], details);
    assert_eq!(dashboard["meta"]["scope"], json!("local"));
    assert_eq!(
        dashboard["meta"]["capabilities"]["entityDashboard"],
        json!(true)
    );
}

#[test]
fn local_entity_metrics_use_full_range_and_cloud_compatible_shapes() {
    let query = normalize_entity_query(&EntityDashboardQuery {
        scope: Some("local".to_string()),
        entity: None,
        range: "all".to_string(),
        timezone: "UTC".to_string(),
        machines: None,
        machine: None,
        tools: None,
        tool: Some("codex".to_string()),
        models: None,
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    })
    .unwrap();
    let now = query
        .query
        .tz
        .with_ymd_and_hms(2026, 7, 15, 12, 0, 0)
        .single()
        .unwrap();
    let bounds = query_bounds(query.query.range, now).unwrap();
    let rows = vec![
        local_stat_row(1, "2024-02-03 08:00:00", 80, 20, 1.0),
        local_stat_row(2, "2026-07-15 10:00:00", 20, 10, 0.3),
    ];
    let metrics = build_local_entity_metrics(
        &rows,
        &bounds,
        &query.query,
        &json!({}),
        json!({ "2026-07-15": 30 }),
    );

    assert_eq!(metrics.peak["bucket"], json!("2024-02-03"));
    assert_eq!(metrics.peak["tokens"], json!(100));
    assert_eq!(metrics.peak["requests"], json!(1));
    assert_eq!(metrics.peak["cost"], json!(1.0));
    assert_eq!(metrics.composition["machines"][0]["tokens"], json!(130));
    assert_eq!(metrics.composition["machines"][0]["requests"], json!(2));
    assert!((metrics.composition["machines"][0]["cost"].as_f64().unwrap() - 1.3).abs() < 1e-9);
    assert_eq!(metrics.activity["activeDays"], json!(2));
    assert_eq!(
        metrics.activity["firstSeenAt"],
        json!("2024-02-03 08:00:00")
    );
    assert_eq!(metrics.heatmap, json!({ "2026-07-15": 30 }));
}

#[test]
fn bridge_commands_are_registered_with_tauri() {
    let lib_source = include_str!("../lib.rs");
    assert!(lib_source.contains("commands::get_usage_details,"));
    assert!(lib_source.contains("commands::get_entity_dashboard,"));
}
