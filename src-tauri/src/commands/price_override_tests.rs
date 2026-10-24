//! Price override file (T10.171): the override file keeps only what the user
//! changed, an older file is migrated once on the first load, and bundled
//! price updates reach every model the user never edited.

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// One tool per fallback family of `tool_fallback_price_key`.
const FALLBACK_FAMILIES: [(&str, &str); 10] = [
    ("claude", "claude-unknown"),
    ("codex", "codex-agent"),
    ("antigravity", "gemini-3.5-flash-agent"),
    ("trae", "minimax-model"),
    ("reasonix", "reasonix-agent"),
    ("deepseek", "deepseek"),
    ("kimi", "kimi-k2.6"),
    ("grok", "grok-4.3"),
    ("gemini", "gemini-3.5-flash"),
    ("pi", "default"),
];

fn test_app(label: &str) -> AppContext {
    let path = std::env::temp_dir().join(format!(
        "tokenledger_price_overrides_{label}_{}_{}",
        std::process::id(),
        TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    let app = AppContext::for_test(path);
    db::init_db(&db::get_db_path(&app)).expect("initialize price override test db");
    app
}

fn discover(app: &AppContext, tool: &str, model: &str) {
    let conn = Connection::open(db::get_db_path(app)).expect("open price override test db");
    conn.execute(
        "INSERT INTO discovered_models (tool, model_key, model) VALUES (?1, ?2, ?3)",
        params![tool, model, model],
    )
    .expect("insert discovered model");
}

fn discovered(tool: &str, model: &str) -> DiscoveredModelPrice {
    DiscoveredModelPrice {
        tool: tool.to_string(),
        model_key: model.to_string(),
        model: model.to_string(),
        tools: vec![tool.to_string()],
        first_seen_at: "2026-09-01 10:00:00".to_string(),
        last_seen_at: "2026-09-20 10:00:00".to_string(),
    }
}

/// A synced Claude record whose estimated cost a price change would clear.
fn insert_synced_estimate(app: &AppContext, cost: f64) -> Connection {
    let conn = Connection::open(db::get_db_path(app)).expect("open test db");
    conn.execute(
        "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, timestamp,
                                 session_id, unique_key, cost_usd, sync_status)
         VALUES ('claude', 'claude-sonnet-5', 1000000, 1000000, '2026-09-01 10:00:00',
                 's1', 'k1', ?1, 1)",
        params![cost],
    )
    .expect("insert synced row");
    conn
}

fn stored_cost(conn: &Connection) -> (Option<f64>, i64) {
    conn.query_row(
        "SELECT cost_usd, sync_status FROM token_logs WHERE unique_key = 'k1'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .expect("read row")
}

/// What the settings page sends back for a table `get_prices` returned. Both
/// the response and the request travel as JSON text: serde_json prints the
/// table, the page parses and re-serialises it, and Tauri parses it with
/// serde_json, which without `float_roundtrip` reads a 17-digit estimate
/// such as `0.028999999999999998` back as `0.029` (review P1-1). JavaScript
/// has one number type, so a bundled `3.0` comes back as `3`.
fn as_sent_by_editor(value: &Value) -> Value {
    let text = serde_json::to_string(value).expect("serialize for the editor");
    integral_numbers_as_integers(&serde_json::from_str(&text).expect("parse the editor's table"))
}

fn integral_numbers_as_integers(value: &Value) -> Value {
    match value {
        Value::Number(number) => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() < 1.0e15 => json!(float as i64),
            _ => value.clone(),
        },
        Value::Array(items) => {
            Value::Array(items.iter().map(integral_numbers_as_integers).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), integral_numbers_as_integers(value)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

/// The visual editor (`PricingSection.updatePriceField`): set one field and
/// turn a "待核价" row into a user edit.
fn edit_in_visual_editor(table: &mut Value, model: &str, field: &str, value: f64) {
    let entry = table
        .get_mut(model)
        .and_then(Value::as_object_mut)
        .expect("edited model is in the table");
    entry.insert(field.to_string(), as_sent_by_editor(&json!(value)));
    if let Some(Value::Object(meta)) = entry.get_mut("_meta") {
        if meta.get("status").and_then(Value::as_str) == Some("auto_discovered") {
            meta.insert("status".to_string(), json!("user_edited"));
            meta.insert("price_source".to_string(), json!("user_override"));
        }
    }
}

/// `useSettings.importModelsDevPrice`: input and output from models.dev; the
/// cache prices from models.dev when it has them (`cache`), otherwise the
/// row's current (fallback) values, listed in `estimated_fields`. Older
/// versions also removed `fallback_key` from `_meta`.
fn import_from_models_dev(
    table: &mut Value,
    model: &str,
    input: f64,
    output: f64,
    cache: Option<(f64, f64)>,
    keep_fallback_key: bool,
) {
    let current = table
        .get(model)
        .and_then(Value::as_object)
        .cloned()
        .expect("imported model is in the table");
    let mut meta = current
        .get("_meta")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if !keep_fallback_key {
        meta.remove("fallback_key");
    }
    meta.insert("status".to_string(), json!("models_dev_imported"));
    meta.insert("price_source".to_string(), json!("models.dev"));
    meta.insert("provider_id".to_string(), json!("example-provider"));
    meta.insert("provider_name".to_string(), json!("Example Provider"));
    let mut next = current;
    next.insert("input".to_string(), as_sent_by_editor(&json!(input)));
    next.insert("output".to_string(), as_sent_by_editor(&json!(output)));
    match cache {
        Some((cache_input, cache_write)) => {
            next.insert(
                "cache_input".to_string(),
                as_sent_by_editor(&json!(cache_input)),
            );
            next.insert(
                "cache_write".to_string(),
                as_sent_by_editor(&json!(cache_write)),
            );
            meta.insert("estimated_fields".to_string(), json!([]));
        }
        None => {
            meta.insert(
                "estimated_fields".to_string(),
                json!(["cache_input", "cache_write"]),
            );
        }
    }
    next.insert("_meta".to_string(), Value::Object(meta));
    table[model] = Value::Object(next);
}

/// The save path before T10.171: a structural diff of the editor's whole
/// table against the bundled table, with serde_json equality (`3` != `3.0`).
fn legacy_whole_table_save(bundled: &Value, edited: &Value) -> Option<Value> {
    if bundled == edited {
        return None;
    }
    match (bundled, edited) {
        (Value::Object(bundled), Value::Object(edited)) => {
            let mut diff = Map::new();
            for (key, value) in edited {
                match bundled.get(key) {
                    Some(base) => {
                        if let Some(child) = legacy_whole_table_save(base, value) {
                            diff.insert(key.clone(), child);
                        }
                    }
                    None => {
                        diff.insert(key.clone(), value.clone());
                    }
                }
            }
            (!diff.is_empty()).then_some(Value::Object(diff))
        }
        (_, value) => Some(value.clone()),
    }
}

fn rates(entry: &Value) -> Vec<Option<f64>> {
    PRICE_RATE_FIELDS
        .iter()
        .map(|field| entry.get(*field).and_then(Value::as_f64))
        .collect()
}

/// The rate fields an override row holds, without `_meta`.
fn rate_fields(entry: &Value) -> Value {
    Value::Object(
        entry
            .as_object()
            .expect("override row is an object")
            .iter()
            .filter(|(field, _)| PRICE_RATE_FIELDS.contains(&field.as_str()))
            .map(|(field, value)| (field.clone(), value.clone()))
            .collect(),
    )
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("expected a JSON object, got {other}"),
    }
}

fn override_file(app: &AppContext) -> Option<Value> {
    let content = fs::read_to_string(app.app_data_dir().join(PRICE_OVERRIDES_FILE)).ok()?;
    Some(serde_json::from_str(&content).expect("override file is JSON"))
}

fn override_bytes(app: &AppContext) -> Vec<u8> {
    fs::read(app.app_data_dir().join(PRICE_OVERRIDES_FILE)).expect("read override file")
}

fn backups(app: &AppContext) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = fs::read_dir(app.app_data_dir())
        .expect("list app dir")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("prices.legacy-backup-"))
        })
        .collect();
    found.sort();
    found
}

fn write_override_file(app: &AppContext, content: &Value) -> Vec<u8> {
    let bytes = serde_json::to_string_pretty(content)
        .expect("serialize override file")
        .into_bytes();
    fs::write(app.app_data_dir().join(PRICE_OVERRIDES_FILE), &bytes).expect("write override file");
    bytes
}

/// The bundled table as it was before T10.168 for the models this suite
/// needs: Sonnet 5 at 3/15, o3 before its price cut, Grok 4.3 with the 0.0
/// cache placeholder, Opus 5.5 not yet bundled and Sonnet 4.2 still listed.
fn bundled_before_price_audit() -> Value {
    let mut table = default_prices();
    // Tables before schema 2 had no `history` or `tiers`.
    for entry in table
        .as_object_mut()
        .expect("bundled prices are an object")
        .values_mut()
    {
        if let Some(entry) = entry.as_object_mut() {
            entry.remove("history");
            entry.remove("tiers");
        }
    }
    table["claude-sonnet-5"] =
        json!({ "input": 3.0, "output": 15.0, "cache_input": 0.3, "cache_write": 3.75 });
    table["o3"] = json!({ "input": 10.0, "output": 40.0, "cache_input": 0.5, "cache_write": 2.0 });
    table["grok-4.3"] = json!({ "input": 1.25, "output": 2.5, "cache_input": 0.0 });
    table["claude-sonnet-4-2"] = json!({ "input": 3.0, "output": 15.0 });
    table
        .as_object_mut()
        .expect("bundled prices are an object")
        .remove("claude-opus-5-5");
    table
}

fn pending_models() -> Vec<DiscoveredModelPrice> {
    vec![
        discovered("claude", "claude-opus-5-5"),
        discovered("codex", "future-model-x"),
        discovered("codex", "future-model-y"),
        discovered("codex", "future-model-z"),
    ]
}

/// A user of an older version: edits Sonnet 4.6 and one pending model,
/// imports another pending model from models.dev and saves. The old save
/// wrote every integral bundled price and every pending row as well.
pub(super) fn override_file_from_old_version() -> Value {
    let old_bundled = bundled_before_price_audit();
    let mut editor = as_sent_by_editor(&merge_discovered_prices(
        old_bundled.clone(),
        &pending_models(),
    ));
    edit_in_visual_editor(&mut editor, "claude-sonnet-4-6", "input", 2.8);
    edit_in_visual_editor(&mut editor, "future-model-x", "input", 0.9);
    import_from_models_dev(&mut editor, "future-model-y", 0.4, 1.6, None, false);
    legacy_whole_table_save(&old_bundled, &editor).expect("the old save writes a file")
}

#[test]
fn numbers_compare_by_value_not_by_json_type() {
    assert!(price_values_equal(&json!(3), &json!(3.0)));
    assert!(price_values_equal(
        &json!({ "a": [1, 2.5] }),
        &json!({ "a": [1.0, 2.5] })
    ));
    assert!(!price_values_equal(&json!(3), &json!(3.5)));
    assert!(!price_values_equal(
        &json!({ "a": 1 }),
        &json!({ "a": 1, "b": 2 })
    ));
    // serde_json itself tells them apart, which is how the old save pinned
    // every integral bundled price.
    assert_ne!(json!(3), json!(3.0));
}

#[test]
fn numbers_compare_up_to_the_last_bits() {
    // The estimate and what serde_json reads back from its printed form.
    assert!(price_numbers_equal(0.29 * 0.1, 0.029));
    assert!(price_numbers_equal(0.17 * 1.25, 0.2125));
    assert!(price_values_equal(&json!(0.29 * 0.1), &json!(0.029)));
    assert!(price_number_in(&[0.15, 0.029], 0.29 * 0.1));
    // Prices a user could tell apart stay apart.
    assert!(!price_numbers_equal(0.029, 0.0291));
    assert!(!price_numbers_equal(0.000001, 0.000002));
    assert!(!price_numbers_equal(0.0, 1e-9));
    assert!(price_numbers_equal(0.0, 0.0));
    // Neighbours in the sixth significant digit, the finest step a price
    // carries (9.99999 and 10, 0.123456 and 0.123457: relative gaps 1e-6
    // and 8.1e-6), and even in the seventh (1.234561 and 1.234562: 8.1e-7)
    // stay apart too: a tolerance widened anywhere near that would merge two
    // real prices and drop one on save or migration (review P2-a).
    assert!(!price_numbers_equal(1.234561, 1.234562));
    assert!(!price_numbers_equal(9.99999, 10.0));
    assert!(!price_numbers_equal(0.123456, 0.123457));
}

#[test]
fn old_whole_table_save_pinned_bundled_prices_and_pending_rows() {
    let legacy = override_file_from_old_version();

    assert_eq!(
        legacy["claude-sonnet-5"],
        json!({ "input": 3, "output": 15 })
    );
    assert_eq!(legacy["default"], json!({ "input": 1, "output": 3 }));
    assert_eq!(legacy["grok-4.3"]["cache_input"], json!(0));
    assert_eq!(
        legacy["claude-opus-5-5"]["_meta"]["status"],
        json!("auto_discovered")
    );
    // Without the migration those pins would keep the corrected models at
    // their old prices after the upgrade.
    let unmigrated = merge_discovered_prices(
        merge_price_overrides(&default_prices(), &legacy),
        &pending_models(),
    );
    assert_eq!(unmigrated["claude-sonnet-5"]["input"], json!(3));
    assert_eq!(unmigrated["claude-opus-5-5"]["output"], json!(15));
}

#[test]
fn legacy_traits_are_found_in_old_files_and_never_in_this_format() {
    let bundled = default_prices();
    let legacy = override_file_from_old_version();
    let legacy = legacy.as_object().expect("object");
    assert!(has_legacy_override_traits(&bundled, legacy));
    let migrated = migrate_legacy_price_overrides(&bundled, legacy);
    assert!(!has_legacy_override_traits(&bundled, &migrated));

    for (trait_name, file) in [
        (
            "a 待核价 row",
            json!({ "future-model-z": { "input": 1.5, "_meta": { "status": "auto_discovered" } } }),
        ),
        (
            "a bundled model at today's bundled price",
            json!({ "default": { "input": 1 } }),
        ),
        (
            "a dropped model holding only its old prices",
            json!({ "claude-sonnet-4-2": { "input": 3, "output": 15 } }),
        ),
    ] {
        assert!(
            has_legacy_override_traits(&bundled, file.as_object().expect("object")),
            "{trait_name}"
        );
    }

    // What this format writes has none, even with a price older bundled
    // tables had.
    let previous = apply_price_overrides(&bundled, &Map::new());
    let mut editor = as_sent_by_editor(&merge_discovered_prices(
        previous.clone(),
        &pending_models(),
    ));
    edit_in_visual_editor(&mut editor, "claude-sonnet-5", "input", 3.0);
    edit_in_visual_editor(&mut editor, "future-model-x", "input", 0.9);
    import_from_models_dev(&mut editor, "future-model-y", 0.4, 1.6, None, true);
    let overrides = price_overrides_from_edit(&bundled, &previous, &editor).expect("overrides");
    assert_eq!(overrides.len(), 3);
    assert!(!has_legacy_override_traits(&bundled, &overrides));
}

#[test]
fn migration_keeps_user_edits_and_drops_byproducts() {
    let bundled = default_prices();
    let legacy = override_file_from_old_version();

    let migrated = migrate_legacy_price_overrides(&bundled, legacy.as_object().expect("object"));

    let mut models: Vec<&str> = migrated.keys().map(String::as_str).collect();
    models.sort_unstable();
    assert_eq!(
        models,
        ["claude-sonnet-4-6", "future-model-x", "future-model-y"]
    );
    assert_eq!(migrated["claude-sonnet-4-6"], json!({ "input": 2.8 }));
    let edited = migrated["future-model-x"].as_object().expect("object");
    assert_eq!(edited.get("input"), Some(&json!(0.9)));
    assert!(PRICE_RATE_FIELDS[1..]
        .iter()
        .all(|field| !edited.contains_key(*field)));
    assert_eq!(edited["_meta"]["status"], json!("user_edited"));
    assert_eq!(edited["_meta"]["fallback_key"], json!("codex-agent"));
    let imported = migrated["future-model-y"].as_object().expect("object");
    assert_eq!(imported.get("input"), Some(&json!(0.4)));
    assert_eq!(imported.get("output"), Some(&json!(1.6)));
    assert!(!imported.contains_key("cache_input") && !imported.contains_key("cache_write"));
    assert_eq!(imported["_meta"]["status"], json!("models_dev_imported"));
    // The old import dropped the fallback key; it is derived from the tools.
    assert_eq!(imported["_meta"]["fallback_key"], json!("codex-agent"));
}

#[test]
fn after_migration_untouched_models_follow_the_bundled_table() {
    let bundled = default_prices();
    let legacy = override_file_from_old_version();
    let migrated = migrate_legacy_price_overrides(&bundled, legacy.as_object().expect("object"));
    let effective = merge_discovered_prices(
        apply_price_overrides(&bundled, &migrated),
        &pending_models(),
    );

    for (model, entry) in bundled.as_object().expect("object") {
        if model == "claude-sonnet-4-6" {
            continue;
        }
        assert_eq!(rates(&effective[model]), rates(entry), "{model}");
        assert!(effective[model].get("_meta").is_none(), "{model}");
    }
    // Corrected by T10.168 and never edited: the new bundled prices apply.
    assert_eq!(
        rates(&effective["claude-sonnet-5"]),
        [Some(2.0), Some(10.0), Some(0.2), Some(2.5)]
    );
    assert_eq!(effective["o3"]["input"], json!(2.0));
    assert_eq!(effective["grok-4.3"]["cache_input"], json!(0.2));
    // Was "待核价" when the old version saved; now bundled.
    assert_eq!(
        rates(&effective["claude-opus-5-5"]),
        [Some(4.0), Some(20.0), Some(0.2), Some(5.0)]
    );
    // The user's edits survive; the fields they did not edit follow.
    assert_eq!(
        rates(&effective["claude-sonnet-4-6"]),
        [Some(2.8), Some(15.0), Some(0.3), Some(3.75)]
    );
    let fallback = discovered_fallback_rates(&bundled, "codex-agent");
    let expected_x = [
        Some(0.9),
        fallback["output"].as_f64(),
        fallback["cache_input"].as_f64(),
        fallback["cache_write"].as_f64(),
    ];
    assert_eq!(rates(&effective["future-model-x"]), expected_x);
    assert_eq!(
        effective["future-model-x"]["_meta"]["status"],
        json!("user_edited")
    );
    let expected_y = [
        Some(0.4),
        Some(1.6),
        fallback["cache_input"].as_f64(),
        fallback["cache_write"].as_f64(),
    ];
    assert_eq!(rates(&effective["future-model-y"]), expected_y);
    // Never touched: still "待核价", estimated from the fallback.
    assert_eq!(
        effective["future-model-z"]["_meta"]["status"],
        json!("auto_discovered")
    );
}

#[test]
fn migrating_twice_changes_nothing() {
    let bundled = default_prices();
    let legacy = override_file_from_old_version();
    let once = migrate_legacy_price_overrides(&bundled, legacy.as_object().expect("object"));
    let twice = migrate_legacy_price_overrides(&bundled, &once);
    assert_eq!(twice, once);
}

#[test]
fn migration_drops_fallback_estimates_older_versions_showed() {
    // Saved while cache writes were estimated at 125% of the fallback input
    // for every tool (before T10.93) and Grok 4.3 had no cache read price (10%
    // of input). The user changed one field per row; the rest is what the
    // editor showed then, which today's fallback no longer gives.
    let codex_input = 1.5_f64;
    let grok_input = 1.25_f64;
    let legacy = object(json!({
        "future-model-x": {
            "input": 0.9, "output": 2,
            "cache_input": codex_input * 0.1, "cache_write": codex_input * 1.25,
            "_meta": { "status": "user_edited", "fallback_key": "codex-agent", "tools": ["codex"] }
        },
        "grok-next": {
            "input": 2, "output": 2.5,
            "cache_input": grok_input * 0.1, "cache_write": grok_input,
            "_meta": { "status": "user_edited", "fallback_key": "grok-4.3", "tools": ["grok"] }
        },
        // The cache read price the user typed stays.
        "future-model-w": {
            "input": codex_input, "output": 2,
            "cache_input": 0.05, "cache_write": codex_input * 1.25,
            "_meta": { "status": "user_edited", "fallback_key": "codex-agent", "tools": ["codex"] }
        }
    }));
    let bundled = default_prices();
    assert_ne!(
        discovered_fallback_rates(&bundled, "codex-agent")["cache_write"],
        json!(codex_input * 1.25)
    );
    assert_ne!(
        discovered_fallback_rates(&bundled, "grok-4.3")["cache_input"],
        json!(grok_input * 0.1)
    );

    let migrated = migrate_legacy_price_overrides(&bundled, &legacy);

    assert_eq!(
        rate_fields(&migrated["future-model-x"]),
        json!({ "input": 0.9 })
    );
    assert_eq!(rate_fields(&migrated["grok-next"]), json!({ "input": 2 }));
    assert_eq!(
        rate_fields(&migrated["future-model-w"]),
        json!({ "cache_input": 0.05 })
    );
    assert_eq!(
        migrate_legacy_price_overrides(&bundled, &migrated),
        migrated
    );
}

#[test]
fn migration_matches_fallback_estimates_read_back_from_json_text() {
    // Rows an older version saved with the estimates its editor showed, in
    // the form serde_json prints them. Read back without `float_roundtrip`,
    // `0.028999999999999998` (0.29 * 0.1) and `0.21250000000000002`
    // (0.17 * 1.25) come out a bit off the estimates they stand for.
    let legacy: Value = serde_json::from_str(
        r#"{
            "future-trae-probe": {
                "input": 0.5, "output": 1.17,
                "cache_input": 0.028999999999999998, "cache_write": 0.3625,
                "_meta": { "status": "user_edited", "fallback_key": "minimax-model", "tools": ["trae"] }
            },
            "future-reasonix-probe": {
                "input": 0.2, "output": 1,
                "cache_input": 0.017, "cache_write": 0.21250000000000002,
                "_meta": { "status": "user_edited", "fallback_key": "reasonix-agent", "tools": ["reasonix"] }
            }
        }"#,
    )
    .expect("legacy rows");

    let migrated =
        migrate_legacy_price_overrides(&default_prices(), legacy.as_object().expect("object"));

    assert_eq!(
        rate_fields(&migrated["future-trae-probe"]),
        json!({ "input": 0.5 })
    );
    assert_eq!(
        rate_fields(&migrated["future-reasonix-probe"]),
        json!({ "input": 0.2 })
    );
}

#[test]
fn migration_keeps_imported_prices_and_drops_estimated_ones() {
    let bundled = default_prices();
    let legacy = object(json!({
        // Imported at exactly the claude-unknown estimate; models.dev had no
        // cache prices, so those were the estimate as well.
        "claude-nova-1": {
            "input": 3, "output": 15, "cache_input": 0.3, "cache_write": 3.75,
            "_meta": {
                "status": "models_dev_imported", "tools": ["claude"],
                "provider_name": "Example Provider",
                "estimated_fields": ["cache_input", "cache_write"]
            }
        },
        // Every price from models.dev, two of them equal to the estimate.
        "future-codex-nova": {
            "input": 1.5, "output": 2, "cache_input": 0.1, "cache_write": 1.5,
            "_meta": { "status": "models_dev_imported", "tools": ["codex"], "estimated_fields": [] }
        },
        // Without `estimated_fields` (not written by the import feature) the
        // fields are told apart by comparing them with the estimate.
        "future-codex-hand": {
            "input": 0.7, "output": 2, "cache_input": 0.15000000000000002, "cache_write": 1.5,
            "_meta": { "status": "models_dev_imported", "tools": ["codex"] }
        },
        // Imported without cache prices, then the cache read price typed in
        // the visual editor, which keeps the import's status and list: the
        // typed price is the user's, the untouched cache write the estimate.
        "future-codex-typed": {
            "input": 0.9, "output": 3.6, "cache_input": 0.12, "cache_write": 1.5,
            "_meta": {
                "status": "models_dev_imported", "tools": ["codex"],
                "estimated_fields": ["cache_input", "cache_write"]
            }
        }
    }));

    let migrated = migrate_legacy_price_overrides(&bundled, &legacy);

    assert_eq!(
        rate_fields(&migrated["claude-nova-1"]),
        json!({ "input": 3, "output": 15 })
    );
    let nova = &migrated["claude-nova-1"]["_meta"];
    assert_eq!(nova["status"], json!("models_dev_imported"));
    assert_eq!(nova["provider_name"], json!("Example Provider"));
    assert_eq!(nova["fallback_key"], json!("claude-unknown"));
    assert_eq!(
        rate_fields(&migrated["future-codex-nova"]),
        json!({ "input": 1.5, "output": 2, "cache_input": 0.1, "cache_write": 1.5 })
    );
    assert_eq!(
        rate_fields(&migrated["future-codex-hand"]),
        json!({ "input": 0.7 })
    );
    assert_eq!(
        rate_fields(&migrated["future-codex-typed"]),
        json!({ "input": 0.9, "output": 3.6, "cache_input": 0.12 })
    );
    assert_eq!(
        migrate_legacy_price_overrides(&bundled, &migrated),
        migrated
    );
    // Loaded, the import keeps its source and the estimate fills the rest.
    let effective = apply_price_overrides(&bundled, &migrated);
    assert_eq!(
        rates(&effective["claude-nova-1"]),
        [Some(3.0), Some(15.0), Some(0.3), Some(3.75)]
    );
}

#[test]
fn migration_keeps_values_no_release_ever_had() {
    let legacy = object(json!({
        // Pinned by an old save: a price every release had.
        "default": { "input": 1, "output": 3 },
        // Released before 0.056 became the bundled price: a leftover.
        "qwen3.6-plus": { "cache_input": 0.11 },
        // Only ever between two releases (work in progress on T10.168), so no
        // older version can have written them: the user's own.
        "qwen3.7-plus": { "cache_input": 0.028 },
        "qwen3.6-flash": { "cache_input": 0.017 },
        // A misspelt key that never shipped.
        "minimax/mimimax-m2.7": { "input": 0.29, "output": 1.17 }
    }));

    let migrated = migrate_legacy_price_overrides(&default_prices(), &legacy);

    assert_eq!(
        Value::Object(migrated),
        json!({
            "qwen3.7-plus": { "cache_input": 0.028 },
            "qwen3.6-flash": { "cache_input": 0.017 },
            "minimax/mimimax-m2.7": { "input": 0.29, "output": 1.17 }
        })
    );
}

#[test]
fn migration_boundaries_are_explicit() {
    let bundled = default_prices();
    let legacy = object(json!({
        // The user typed today's bundled price: nothing to keep, it follows
        // the bundled table from now on.
        "claude-sonnet-4-5": { "input": 3, "output": 15 },
        // The user typed a price a released bundled table had (the old
        // Sonnet 5 docs): treated as a leftover, the corrected price applies.
        "claude-sonnet-5": { "input": 3, "output": 15 },
        // Mixed: only the value no released bundled table had is kept.
        "gpt-4.1": { "input": 1.9, "output": 8 },
        // A model the user added themselves.
        "my-local-model": { "input": 0.5, "output": 1.5 },
        // Removed from the bundled table: the pin an old save left goes, a
        // value of the user's own stays.
        "claude-sonnet-4-2": { "input": 3, "output": 15 },
        "mimo-v2-flash": { "input": 0.12, "output": 0.3 },
        // Imported from models.dev before the model was bundled; the imported
        // prices equal the bundled ones now and the cache prices were the
        // estimate, so nothing is left.
        "claude-opus-5": {
            "input": 5, "output": 25, "cache_input": 0.3, "cache_write": 3.75,
            "_meta": {
                "status": "models_dev_imported", "tools": ["claude"],
                "estimated_fields": ["cache_input", "cache_write"]
            }
        },
        // Not an object: left alone.
        "odd": 5
    }));

    let migrated = migrate_legacy_price_overrides(&bundled, &legacy);

    assert_eq!(
        Value::Object(migrated),
        json!({
            "gpt-4.1": { "input": 1.9 },
            "my-local-model": { "input": 0.5, "output": 1.5 },
            "mimo-v2-flash": { "input": 0.12, "output": 0.3 },
            "odd": 5
        })
    );
}

#[test]
fn saving_the_loaded_table_unchanged_writes_nothing() {
    let app = test_app("unchanged");
    discover(&app, "codex", "future-model-z");
    let editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));

    let saved = save_prices_impl(&app, editor).expect("save prices");

    assert_eq!(saved["message"], json!("Using bundled default prices."));
    assert_eq!(saved["repriced"], json!(0));
    assert!(override_file(&app).is_none());
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn saving_after_a_trip_through_json_text_keeps_every_pending_row_pending() {
    let app = test_app("json_text");
    for (tool, fallback_key) in FALLBACK_FAMILIES {
        assert_eq!(tool_fallback_price_key(tool), fallback_key);
        discover(&app, tool, &format!("future-{tool}-probe"));
    }
    let conn = insert_synced_estimate(&app, 12.0);
    let loaded = get_prices_impl(&app).expect("load prices");
    for (tool, fallback_key) in FALLBACK_FAMILIES {
        let row = &loaded[format!("future-{tool}-probe").as_str()];
        assert_eq!(row["_meta"]["status"], json!("auto_discovered"), "{tool}");
        assert_eq!(row["_meta"]["fallback_key"], json!(fallback_key), "{tool}");
    }

    // The page sends back exactly what it got, after the trip through JSON
    // text; nothing was edited.
    let saved = save_prices_impl(&app, as_sent_by_editor(&loaded)).expect("save prices");

    assert_eq!(saved["message"], json!("Using bundled default prices."));
    assert_eq!(saved["repriced"], json!(0));
    assert!(override_file(&app).is_none());
    let reloaded = get_prices_impl(&app).expect("reload prices");
    for (tool, _) in FALLBACK_FAMILIES {
        let model = format!("future-{tool}-probe");
        assert_eq!(reloaded[model.as_str()], loaded[model.as_str()], "{model}");
    }
    assert_eq!(stored_cost(&conn), (Some(12.0), 1));
    drop(conn);
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn manual_edits_save_only_the_changed_fields() {
    let app = test_app("manual");
    discover(&app, "codex", "future-model-x");
    discover(&app, "codex", "future-model-z");
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    edit_in_visual_editor(&mut editor, "claude-sonnet-5", "input", 2.25);
    edit_in_visual_editor(&mut editor, "future-model-x", "input", 0.9);

    save_prices_impl(&app, editor).expect("save prices");

    let file = override_file(&app).expect("override file");
    let mut models: Vec<&str> = file
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    models.sort_unstable();
    assert_eq!(models, ["claude-sonnet-5", "future-model-x"]);
    assert_eq!(file["claude-sonnet-5"], json!({ "input": 2.25 }));
    let edited = file["future-model-x"].as_object().expect("object");
    assert_eq!(edited.get("input"), Some(&json!(0.9)));
    assert!(!edited.contains_key("output"));
    assert_eq!(edited["_meta"]["status"], json!("user_edited"));
    assert_eq!(edited["_meta"]["fallback_key"], json!("codex-agent"));
    let bytes = override_bytes(&app);
    assert_eq!(
        recorded_price_overrides_digest(app.app_data_dir()),
        Some(price_overrides_digest(&bytes))
    );

    let prices = get_prices_impl(&app).expect("reload prices");
    assert_eq!(
        rates(&prices["claude-sonnet-5"]),
        [Some(2.25), Some(10.0), Some(0.2), Some(2.5)]
    );
    assert_eq!(prices["future-model-x"]["input"], json!(0.9));
    assert_eq!(prices["future-model-x"]["output"], json!(2.0));
    assert_eq!(
        prices["future-model-z"]["_meta"]["status"],
        json!("auto_discovered")
    );

    // Saving the reloaded table again keeps the same file and reprices nothing.
    let again = save_prices_impl(&app, as_sent_by_editor(&prices)).expect("save again");
    assert_eq!(again["repriced"], json!(0));
    assert_eq!(override_bytes(&app), bytes);
    assert!(backups(&app).is_empty());
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn retyping_the_estimate_keeps_the_row_marked_as_edited() {
    let app = test_app("retyped");
    discover(&app, "codex", "future-model-x");
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    let estimate = editor["future-model-x"]["input"]
        .as_f64()
        .expect("estimated input");
    // The user checks the price and types the same value back.
    edit_in_visual_editor(&mut editor, "future-model-x", "input", estimate);

    let saved = save_prices_impl(&app, editor).expect("save prices");

    assert_eq!(saved["repriced"], json!(0));
    let file = override_file(&app).expect("override file");
    assert_eq!(rate_fields(&file["future-model-x"]), json!({}));
    assert_eq!(
        file["future-model-x"]["_meta"]["status"],
        json!("user_edited")
    );
    assert_eq!(
        file["future-model-x"]["_meta"]["fallback_key"],
        json!("codex-agent")
    );
    let prices = get_prices_impl(&app).expect("reload prices");
    let fallback = Value::Object(discovered_fallback_rates(&default_prices(), "codex-agent"));
    assert_eq!(rates(&prices["future-model-x"]), rates(&fallback));
    assert_eq!(
        prices["future-model-x"]["_meta"]["status"],
        json!("user_edited")
    );
    let bytes = override_bytes(&app);
    save_prices_impl(&app, as_sent_by_editor(&prices)).expect("save again");
    assert_eq!(override_bytes(&app), bytes);
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn bundled_updates_reach_everything_the_user_did_not_edit() {
    let bundled = default_prices();
    let previous = apply_price_overrides(&bundled, &Map::new());
    let mut editor = as_sent_by_editor(&merge_discovered_prices(
        previous.clone(),
        &pending_models(),
    ));
    edit_in_visual_editor(&mut editor, "claude-sonnet-5", "input", 2.25);
    edit_in_visual_editor(&mut editor, "future-model-x", "input", 0.9);
    let overrides = price_overrides_from_edit(&bundled, &previous, &editor).expect("overrides");

    // A later release corrects Sonnet 5's output and adds future-model-x.
    let mut updated = bundled.clone();
    updated["claude-sonnet-5"]["output"] = json!(12.0);
    updated["future-model-x"] =
        json!({ "input": 5.0, "output": 20.0, "cache_input": 0.5, "cache_write": 6.25 });
    updated["claude-opus-4-8"]["input"] = json!(4.5);
    let effective = merge_discovered_prices(
        apply_price_overrides(&updated, &overrides),
        &pending_models(),
    );

    assert_eq!(effective["claude-sonnet-5"]["input"], json!(2.25));
    assert_eq!(effective["claude-sonnet-5"]["output"], json!(12.0));
    assert_eq!(
        rates(&effective["future-model-x"]),
        [Some(0.9), Some(20.0), Some(0.5), Some(6.25)]
    );
    assert_eq!(effective["claude-opus-4-8"]["input"], json!(4.5));
    assert!(effective["claude-opus-4-8"].get("_meta").is_none());
}

#[test]
fn json_edit_that_keeps_the_pending_marker_is_saved_as_a_user_edit() {
    let bundled = default_prices();
    let previous = apply_price_overrides(&bundled, &Map::new());
    let mut editor = as_sent_by_editor(&merge_discovered_prices(
        previous.clone(),
        &pending_models(),
    ));
    // JSON view: the price changes, `_meta` still says auto_discovered.
    editor["future-model-x"]["output"] = json!(7.5);

    let overrides = price_overrides_from_edit(&bundled, &previous, &editor).expect("overrides");

    assert_eq!(overrides.len(), 1);
    assert_eq!(overrides["future-model-x"]["output"], json!(7.5));
    assert!(overrides["future-model-x"].get("input").is_none());
    assert_eq!(
        overrides["future-model-x"]["_meta"]["status"],
        json!("user_edited")
    );
    assert_eq!(
        overrides["future-model-x"]["_meta"]["price_source"],
        json!("user_override")
    );
}

#[test]
fn models_dev_import_saves_the_imported_prices_only() {
    let app = test_app("models_dev");
    discover(&app, "codex", "future-model-y");
    discover(&app, "codex", "future-model-z");
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    import_from_models_dev(&mut editor, "future-model-y", 0.4, 1.6, None, true);

    save_prices_impl(&app, editor).expect("save import");

    let file = override_file(&app).expect("override file");
    assert_eq!(file.as_object().expect("object").len(), 1);
    let imported = file["future-model-y"].as_object().expect("object");
    assert_eq!(imported.get("input"), Some(&json!(0.4)));
    assert_eq!(imported.get("output"), Some(&json!(1.6)));
    assert!(!imported.contains_key("cache_input") && !imported.contains_key("cache_write"));
    assert_eq!(imported["_meta"]["status"], json!("models_dev_imported"));
    assert_eq!(
        imported["_meta"]["provider_name"],
        json!("Example Provider")
    );

    let prices = get_prices_impl(&app).expect("reload prices");
    let fallback = discovered_fallback_rates(&default_prices(), "codex-agent");
    assert_eq!(
        rates(&prices["future-model-y"]),
        [
            Some(0.4),
            Some(1.6),
            fallback["cache_input"].as_f64(),
            fallback["cache_write"].as_f64()
        ]
    );
    assert_eq!(
        prices["future-model-z"]["_meta"]["status"],
        json!("auto_discovered")
    );

    // Once bundled, the imported prices stay and the estimated cache prices
    // give way to the bundled ones.
    let mut updated = default_prices();
    updated["future-model-y"] =
        json!({ "input": 0.5, "output": 2.0, "cache_input": 0.05, "cache_write": 0.5 });
    let effective = apply_price_overrides(&updated, file.as_object().expect("object"));
    assert_eq!(
        rates(&effective["future-model-y"]),
        [Some(0.4), Some(1.6), Some(0.05), Some(0.5)]
    );
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn a_models_dev_import_equal_to_the_estimate_is_saved_as_an_import() {
    let app = test_app("import_equal");
    discover(&app, "claude", "claude-nova-1");
    discover(&app, "codex", "future-codex-nova");
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    assert_eq!(
        rates(&editor["claude-nova-1"]),
        [Some(3.0), Some(15.0), Some(0.3), Some(3.75)]
    );
    // models.dev lists exactly the claude-unknown estimate, cache included;
    // for the other model it has the estimate's input and output only.
    import_from_models_dev(
        &mut editor,
        "claude-nova-1",
        3.0,
        15.0,
        Some((0.3, 3.75)),
        true,
    );
    import_from_models_dev(&mut editor, "future-codex-nova", 1.5, 2.0, None, true);

    save_prices_impl(&app, editor).expect("save import");

    let file = override_file(&app).expect("override file");
    assert_eq!(
        rate_fields(&file["claude-nova-1"]),
        json!({ "input": 3, "output": 15, "cache_input": 0.3, "cache_write": 3.75 })
    );
    assert_eq!(
        rate_fields(&file["future-codex-nova"]),
        json!({ "input": 1.5, "output": 2 })
    );
    let prices = get_prices_impl(&app).expect("reload prices");
    for model in ["claude-nova-1", "future-codex-nova"] {
        let meta = &prices[model]["_meta"];
        assert_eq!(meta["status"], json!("models_dev_imported"), "{model}");
        assert_eq!(meta["provider_name"], json!("Example Provider"), "{model}");
    }
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn changing_a_fallback_price_moves_untouched_pending_models_along() {
    let app = test_app("fallback");
    discover(&app, "codex", "future-model-x");
    discover(&app, "codex", "future-model-z");
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    edit_in_visual_editor(&mut editor, "future-model-x", "input", 0.9);
    edit_in_visual_editor(&mut editor, "codex-agent", "output", 3.0);

    save_prices_impl(&app, editor).expect("save prices");

    let file = override_file(&app).expect("override file");
    assert!(file.get("future-model-z").is_none());
    assert_eq!(file["codex-agent"], json!({ "output": 3 }));
    let prices = get_prices_impl(&app).expect("reload prices");
    assert_eq!(prices["future-model-z"]["output"], json!(3.0));
    assert_eq!(prices["future-model-x"]["output"], json!(3.0));
    assert_eq!(prices["future-model-x"]["input"], json!(0.9));
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn legacy_file_is_migrated_once_and_backed_up() {
    let app = test_app("legacy");
    for model in pending_models() {
        discover(&app, &model.tool, &model.model);
    }
    let legacy = override_file_from_old_version();
    let original = write_override_file(&app, &legacy);

    let prices = get_prices_impl(&app).expect("load and migrate");

    assert_eq!(prices["claude-sonnet-5"]["input"], json!(2.0));
    assert_eq!(prices["claude-sonnet-4-6"]["input"], json!(2.8));
    assert_eq!(prices["future-model-x"]["input"], json!(0.9));
    let expected =
        migrate_legacy_price_overrides(&default_prices(), legacy.as_object().expect("object"));
    assert_eq!(override_file(&app), Some(Value::Object(expected)));
    let saved = backups(&app);
    assert_eq!(saved.len(), 1);
    assert_eq!(fs::read(&saved[0]).expect("read backup"), original);

    // The next loads find the recorded hash and leave the file alone.
    let migrated_bytes = override_bytes(&app);
    assert_eq!(get_prices_impl(&app).expect("load again"), prices);
    assert_eq!(override_bytes(&app), migrated_bytes);
    assert_eq!(backups(&app).len(), 1);
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn legacy_file_without_user_edits_is_removed_but_backed_up() {
    let app = test_app("legacy_empty");
    discover(&app, "claude", "claude-opus-5-5");
    let old_bundled = bundled_before_price_audit();
    let editor = as_sent_by_editor(&merge_discovered_prices(
        old_bundled.clone(),
        &[discovered("claude", "claude-opus-5-5")],
    ));
    let legacy = legacy_whole_table_save(&old_bundled, &editor).expect("old save");
    write_override_file(&app, &legacy);

    let prices = get_prices_impl(&app).expect("load and migrate");

    assert!(override_file(&app).is_none());
    assert_eq!(backups(&app).len(), 1);
    let bundled = default_prices();
    for (model, entry) in bundled.as_object().expect("object") {
        assert_eq!(rates(&prices[model]), rates(entry), "{model}");
    }
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn a_file_in_the_current_format_is_not_migrated_again() {
    let app = test_app("current_format");
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    // 3/15 is a price a released bundled table had for Sonnet 5; typed by
    // the user in this version it is their choice and must stay.
    edit_in_visual_editor(&mut editor, "claude-sonnet-5", "input", 3.0);
    edit_in_visual_editor(&mut editor, "claude-sonnet-5", "output", 15.0);
    save_prices_impl(&app, editor).expect("save prices");

    for _ in 0..2 {
        let prices = get_prices_impl(&app).expect("reload prices");
        assert_eq!(prices["claude-sonnet-5"]["input"], json!(3));
        assert_eq!(prices["claude-sonnet-5"]["output"], json!(15));
    }
    assert!(backups(&app).is_empty());
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn a_current_format_file_without_its_state_record_keeps_every_value() {
    let app = test_app("state_lost");
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    // Prices released bundled tables once had, typed in this version on
    // purpose, and one no bundled table had.
    edit_in_visual_editor(&mut editor, "claude-sonnet-5", "input", 3.0);
    edit_in_visual_editor(&mut editor, "claude-sonnet-5", "output", 15.0);
    edit_in_visual_editor(&mut editor, "qwen3.7-plus", "cache_input", 0.08);
    edit_in_visual_editor(&mut editor, "gpt-4.1", "input", 1.9);
    save_prices_impl(&app, editor).expect("save prices");
    let written = override_bytes(&app);
    // Restored or synced without the state file.
    fs::remove_file(app.app_data_dir().join(PRICE_OVERRIDES_STATE_FILE)).expect("drop state");

    let prices = get_prices_impl(&app).expect("reload prices");

    assert_eq!(prices["claude-sonnet-5"]["input"], json!(3));
    assert_eq!(prices["claude-sonnet-5"]["output"], json!(15));
    assert_eq!(prices["qwen3.7-plus"]["cache_input"], json!(0.08));
    assert_eq!(prices["gpt-4.1"]["input"], json!(1.9));
    assert_eq!(override_bytes(&app), written);
    assert!(backups(&app).is_empty());
    assert_eq!(
        recorded_price_overrides_digest(app.app_data_dir()),
        Some(price_overrides_digest(&written))
    );
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn a_hand_edited_file_without_legacy_traits_is_kept_as_written() {
    let app = test_app("hand_edited_clean");
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    edit_in_visual_editor(&mut editor, "gpt-4.1", "input", 1.9);
    save_prices_impl(&app, editor).expect("save prices");
    let mut file = override_file(&app).expect("override file");
    // Edited by hand: another price, a price a released bundled table had,
    // and a model of the user's own.
    file["gpt-4.1"]["input"] = json!(1.95);
    file["claude-sonnet-5"] = json!({ "input": 3, "output": 15 });
    file["my-local-model"] = json!({ "input": 0.5, "output": 1.5 });
    let written = write_override_file(&app, &file);

    let prices = get_prices_impl(&app).expect("load prices");

    assert_eq!(override_file(&app), Some(file));
    assert!(backups(&app).is_empty());
    assert_eq!(
        recorded_price_overrides_digest(app.app_data_dir()),
        Some(price_overrides_digest(&written))
    );
    assert_eq!(prices["gpt-4.1"]["input"], json!(1.95));
    assert_eq!(prices["claude-sonnet-5"]["input"], json!(3));
    assert_eq!(prices["my-local-model"]["output"], json!(1.5));
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn a_hand_edited_file_with_a_legacy_trait_is_migrated_like_an_old_one() {
    let app = test_app("hand_edited");
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    edit_in_visual_editor(&mut editor, "gpt-4.1", "input", 1.9);
    save_prices_impl(&app, editor).expect("save prices");
    let mut file = override_file(&app).expect("override file");
    // A "待核价" row copied in by hand: only an older version writes those.
    file["future-model-z"] = json!({
        "input": 1.5, "output": 2.0,
        "_meta": { "status": "auto_discovered", "fallback_key": "codex-agent" }
    });
    write_override_file(&app, &file);

    get_prices_impl(&app).expect("load and migrate");

    assert_eq!(
        override_file(&app),
        Some(json!({ "gpt-4.1": { "input": 1.9 } }))
    );
    assert_eq!(backups(&app).len(), 1);
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn a_state_record_that_cannot_be_written_does_not_fail_the_save() {
    let app = test_app("state_unwritable");
    // A directory in its place makes every write of the state record fail.
    fs::create_dir(app.app_data_dir().join(PRICE_OVERRIDES_STATE_FILE)).expect("block state");
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    edit_in_visual_editor(&mut editor, "claude-sonnet-5", "input", 3.0);

    save_prices_impl(&app, editor).expect("the save succeeds");

    for _ in 0..2 {
        let prices = get_prices_impl(&app).expect("reload prices");
        assert_eq!(prices["claude-sonnet-5"]["input"], json!(3));
    }
    assert_eq!(
        override_file(&app),
        Some(json!({ "claude-sonnet-5": { "input": 3 } }))
    );
    assert!(backups(&app).is_empty());
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn malformed_override_files_are_ignored_and_left_alone() {
    let app = test_app("malformed");
    let path = app.app_data_dir().join(PRICE_OVERRIDES_FILE);
    for content in ["{ not json", "[1, 2]"] {
        fs::write(&path, content).expect("write malformed file");
        let prices = get_prices_impl(&app).expect("load prices");
        assert_eq!(prices["claude-sonnet-5"]["input"], json!(2.0));
        assert_eq!(fs::read_to_string(&path).expect("read file"), content);
        assert!(backups(&app).is_empty());
    }
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn a_backup_name_taken_by_other_content_gets_a_suffix() {
    let app = test_app("backup_suffix");
    let original = write_override_file(&app, &override_file_from_old_version());
    let digest = price_overrides_digest(&original);
    let taken = app
        .app_data_dir()
        .join(format!("prices.legacy-backup-{}.json", &digest[..12]));
    // Cut short by an earlier crash.
    fs::write(&taken, b"truncated").expect("write partial backup");

    get_prices_impl(&app).expect("load and migrate");

    assert_eq!(fs::read(&taken).expect("read partial backup"), b"truncated");
    let suffixed = app
        .app_data_dir()
        .join(format!("prices.legacy-backup-{}-2.json", &digest[..12]));
    assert_eq!(fs::read(&suffixed).expect("read backup"), original);
    assert_eq!(backups(&app).len(), 2);
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn reset_removes_overrides_and_keeps_the_migration_backup() {
    let app = test_app("reset");
    discover(&app, "codex", "future-model-x");
    write_override_file(&app, &override_file_from_old_version());
    get_prices_impl(&app).expect("load and migrate");
    assert!(override_file(&app).is_some());

    let reset = reset_prices_impl(&app).expect("reset prices");

    assert!(override_file(&app).is_none());
    assert!(!app.app_data_dir().join(PRICE_OVERRIDES_STATE_FILE).exists());
    assert_eq!(backups(&app).len(), 1);
    assert_eq!(reset["prices"]["claude-sonnet-4-6"]["input"], json!(3.0));
    assert_eq!(
        reset["prices"]["future-model-x"]["_meta"]["status"],
        json!("auto_discovered")
    );
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn a_migration_drops_cached_stats() {
    let app = test_app("stats_cache");
    let db_path = db::get_db_path(&app);
    let key = cache::CacheKey::new("local", "today", "");
    cache::write(&db_path, &key, &json!({ "cost": 1.0 }));
    assert!(cache::read(&db_path, &key).is_some());
    write_override_file(&app, &override_file_from_old_version());

    get_prices_impl(&app).expect("load and migrate");

    assert!(cache::read(&db_path, &key).is_none());
    // Later loads have nothing to migrate and leave the cache alone.
    cache::write(&db_path, &key, &json!({ "cost": 2.0 }));
    get_prices_impl(&app).expect("load again");
    assert_eq!(cache::read(&db_path, &key), Some(json!({ "cost": 2.0 })));
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn migration_leaves_stored_costs_and_sync_state_alone() {
    let app = test_app("frozen_costs");
    let conn = insert_synced_estimate(&app, 18.0);
    write_override_file(&app, &override_file_from_old_version());

    get_prices_impl(&app).expect("load and migrate");

    assert_eq!(stored_cost(&conn), (Some(18.0), 1));
    drop(conn);
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn saving_reprices_only_when_effective_rates_change() {
    let app = test_app("reprice");
    let conn = insert_synced_estimate(&app, 12.0);
    write_override_file(&app, &override_file_from_old_version());
    let loaded = get_prices_impl(&app).expect("load and migrate");

    // The migration changed effective prices; saving what it produced is
    // not a price change.
    let unchanged = save_prices_impl(&app, as_sent_by_editor(&loaded)).expect("save unchanged");
    assert_eq!(unchanged["repriced"], json!(0));
    assert_eq!(stored_cost(&conn).0, Some(12.0));

    let mut editor = as_sent_by_editor(&loaded);
    edit_in_visual_editor(&mut editor, "claude-sonnet-5", "output", 11.0);
    let changed = save_prices_impl(&app, editor).expect("save change");
    assert_eq!(changed["repriced"], json!(1));
    drop(conn);
    let _ = fs::remove_dir_all(app.app_data_dir());
}

// ---- Migration notice for the settings page (T10.189) ----

/// An older version's file with one of each kind of cleared price.
pub(super) fn legacy_file_for_the_notice() -> Value {
    json!({
        // Pinned at today's price by an old save: cleared, the price stays.
        "default": { "input": 1, "output": 3 },
        // The old Sonnet 5 price: cleared, now 2 / 10.
        "claude-sonnet-5": { "input": 3, "output": 15 },
        // The old cache placeholder: cleared, now 0.2.
        "grok-4.3": { "cache_input": 0 },
        // A value of the user's own next to a pin: only the pin goes.
        "gpt-4.1": { "input": 1.9, "output": 8 },
        // A 待核价 row at today's estimate: cleared, the estimate stays.
        "future-model-z": {
            "input": 1.5, "output": 2, "cache_input": 0.15, "cache_write": 1.5,
            "_meta": { "status": "auto_discovered", "fallback_key": "codex-agent", "tools": ["codex"] }
        },
        // Dropped from the bundled table: the pin goes and no price of its
        // own is left, so the rate now depends on the tool.
        "claude-sonnet-4-2": { "input": 3, "output": 15 },
        // The user's own model stays.
        "my-local-model": { "input": 0.5, "output": 1.5 }
    })
}

fn cleared_model(model: &str, fields: &[&str], whole_model: bool) -> PriceMigrationClearedModel {
    PriceMigrationClearedModel {
        model: model.to_string(),
        fields: fields.iter().map(|field| field.to_string()).collect(),
        whole_model,
    }
}

fn price_change(
    model: &str,
    field: &str,
    previous: f64,
    current: Option<f64>,
) -> PriceMigrationChange {
    PriceMigrationChange {
        model: model.to_string(),
        field: field.to_string(),
        previous,
        current,
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .expect("file name")
        .to_string()
}

#[test]
fn a_migration_leaves_a_notice_of_what_it_cleared() {
    let app = test_app("notice");
    let original = write_override_file(&app, &legacy_file_for_the_notice());

    let prices = get_prices_impl(&app).expect("load and migrate");
    let view = get_price_migration_notice_impl(&app)
        .expect("read the notice")
        .expect("a notice");

    assert_eq!(prices["claude-sonnet-5"]["input"], json!(2.0));
    let notice = &view.notice;
    assert_eq!(notice.id, price_overrides_digest(&original));
    let saved = backups(&app);
    assert_eq!(saved.len(), 1);
    assert_eq!(notice.backup_file, file_name(&saved[0]));
    assert_eq!(
        view.backup_dir,
        app.app_data_dir().to_string_lossy().into_owned()
    );
    assert!(DateTime::parse_from_rfc3339(&notice.migrated_at).is_ok());
    assert_eq!(notice.models_cleared, 6);
    assert_eq!(notice.fields_cleared, 12);
    assert_eq!(
        notice.cleared,
        [
            cleared_model("claude-sonnet-4-2", &["input", "output"], true),
            cleared_model("claude-sonnet-5", &["input", "output"], true),
            cleared_model("default", &["input", "output"], true),
            cleared_model(
                "future-model-z",
                &["input", "output", "cache_input", "cache_write"],
                true
            ),
            cleared_model("gpt-4.1", &["output"], false),
            cleared_model("grok-4.3", &["cache_input"], true),
        ]
    );
    // Everything else cleared equals the rate that applies now.
    assert_eq!(
        notice.changed,
        [
            price_change("claude-sonnet-4-2", "input", 3.0, None),
            price_change("claude-sonnet-4-2", "output", 15.0, None),
            price_change("claude-sonnet-5", "input", 3.0, Some(2.0)),
            price_change("claude-sonnet-5", "output", 15.0, Some(10.0)),
            price_change("grok-4.3", "cache_input", 0.0, Some(0.2)),
        ]
    );
    // What the settings page receives (`src/types.ts`).
    let sent = serde_json::to_value(&view).expect("serialize the notice");
    for key in [
        "id",
        "migratedAt",
        "backupFile",
        "backupDir",
        "modelsCleared",
        "fieldsCleared",
        "cleared",
        "changed",
    ] {
        assert!(sent.get(key).is_some(), "{key}");
    }
    assert_eq!(sent["cleared"][4]["wholeModel"], json!(false));
    assert_eq!(sent["changed"][0]["current"], Value::Null);
    assert_eq!(sent["changed"][4]["previous"], json!(0.0));

    // Reading again shows the same notice: nothing migrates twice.
    let again = get_price_migration_notice_impl(&app)
        .expect("read the notice again")
        .expect("still there");
    assert_eq!(again, view);
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn the_notice_names_the_prices_an_old_save_pinned() {
    let app = test_app("notice_old_save");
    write_override_file(&app, &override_file_from_old_version());

    // The notice command runs the pending migration itself.
    let notice = get_price_migration_notice_impl(&app)
        .expect("read the notice")
        .expect("a notice")
        .notice;

    for change in [
        // Corrected by T10.168 after the old save pinned the old price.
        price_change("claude-sonnet-5", "input", 3.0, Some(2.0)),
        price_change("o3", "input", 10.0, Some(2.0)),
        price_change("grok-4.3", "cache_input", 0.0, Some(0.2)),
        // Was "待核价" at the claude-unknown estimate; bundled now.
        price_change("claude-opus-5-5", "input", 3.0, Some(4.0)),
    ] {
        assert!(notice.changed.contains(&change), "{change:?}");
    }
    // Pinned at today's price: cleared, but the price is the same.
    assert!(notice
        .cleared
        .iter()
        .any(|model| model.model == "default" && model.fields == ["input", "output"]));
    assert!(!notice
        .changed
        .iter()
        .any(|change| change.model == "default"));
    // The user's edits were kept, so they are not listed.
    assert!(!notice
        .changed
        .iter()
        .any(|change| change.model == "claude-sonnet-4-6" && change.field == "input"));
    assert_eq!(
        notice.fields_cleared,
        notice
            .cleared
            .iter()
            .map(|model| model.fields.len())
            .sum::<usize>()
    );
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn a_dismissed_notice_stays_dismissed_and_a_new_migration_shows_again() {
    let app = test_app("notice_dismiss");
    let first = write_override_file(&app, &legacy_file_for_the_notice());
    let shown = get_price_migration_notice_impl(&app)
        .expect("read the notice")
        .expect("a notice");

    dismiss_price_migration_notice_impl(&app, &shown.notice.id).expect("dismiss");

    // Gone, also after a reload of the settings page.
    for _ in 0..2 {
        assert_eq!(get_price_migration_notice_impl(&app).expect("read"), None);
    }
    // Dismissing twice is fine.
    dismiss_price_migration_notice_impl(&app, &shown.notice.id).expect("dismiss again");
    // The same file put back is migrated again, the same way: still dismissed.
    fs::write(app.app_data_dir().join(PRICE_OVERRIDES_FILE), &first).expect("put back");
    get_prices_impl(&app).expect("migrate the same file again");
    assert_eq!(get_price_migration_notice_impl(&app).expect("read"), None);
    assert_eq!(backups(&app).len(), 1);

    // Another older file is another migration, shown once more.
    write_override_file(
        &app,
        &json!({ "default": { "input": 1 }, "o3": { "input": 10, "output": 40 } }),
    );
    let next = get_price_migration_notice_impl(&app)
        .expect("read the next notice")
        .expect("a new notice");
    assert_ne!(next.notice.id, shown.notice.id);
    assert_eq!(next.notice.models_cleared, 2);
    assert_eq!(
        next.notice.changed,
        [
            price_change("o3", "input", 10.0, Some(2.0)),
            price_change("o3", "output", 40.0, Some(8.0)),
        ]
    );
    assert_eq!(backups(&app).len(), 2);
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn dismissing_checks_the_id_and_keeps_the_latest_ids() {
    let app = test_app("notice_ids");
    let invalid = [
        String::new(),
        "../prices.json".to_string(),
        "A".repeat(64),
        "0".repeat(63),
    ];
    for id in &invalid {
        assert!(
            dismiss_price_migration_notice_impl(&app, id).is_err(),
            "{id}"
        );
    }
    assert!(!app
        .app_data_dir()
        .join(PRICE_MIGRATION_NOTICE_FILE)
        .exists());

    let ids: Vec<String> = (0..40).map(|index| format!("{index:064x}")).collect();
    for id in &ids {
        dismiss_price_migration_notice_impl(&app, id).expect("dismiss");
    }
    let record = read_price_migration_notice_record(app.app_data_dir());
    assert_eq!(record.dismissed_ids, ids[8..]);
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn a_notice_that_cannot_be_recorded_does_not_fail_the_price_read() {
    let blocked = test_app("notice_blocked");
    // A directory in its place makes every write of the notice fail.
    fs::create_dir(blocked.app_data_dir().join(PRICE_MIGRATION_NOTICE_FILE)).expect("block");
    let original = write_override_file(&blocked, &legacy_file_for_the_notice());
    let reference = test_app("notice_reference");
    write_override_file(&reference, &legacy_file_for_the_notice());

    for _ in 0..2 {
        let prices = get_prices_impl(&blocked).expect("the price read works");
        // The same prices as where the notice could be recorded.
        assert_eq!(prices, get_prices_impl(&reference).expect("load reference"));
    }
    assert_eq!(
        override_file(&blocked),
        override_file(&reference),
        "the migration is saved all the same"
    );
    assert_eq!(backups(&blocked).len(), 1);
    assert_eq!(
        get_price_migration_notice_impl(&blocked).expect("read"),
        None
    );
    assert!(get_price_migration_notice_impl(&reference)
        .expect("read")
        .is_some());
    let id = price_overrides_digest(&original);
    assert!(dismiss_price_migration_notice_impl(&blocked, &id).is_err());
    let _ = fs::remove_dir_all(blocked.app_data_dir());
    let _ = fs::remove_dir_all(reference.app_data_dir());
}

#[test]
fn no_notice_without_a_migration_that_cleared_prices() {
    // No override file.
    let app = test_app("notice_none");
    assert_eq!(get_price_migration_notice_impl(&app).expect("read"), None);
    // A file this version saved, also without its state record.
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    edit_in_visual_editor(&mut editor, "claude-sonnet-5", "input", 3.0);
    save_prices_impl(&app, editor).expect("save prices");
    assert_eq!(get_price_migration_notice_impl(&app).expect("read"), None);
    fs::remove_file(app.app_data_dir().join(PRICE_OVERRIDES_STATE_FILE)).expect("drop state");
    assert_eq!(get_price_migration_notice_impl(&app).expect("read"), None);
    // A malformed file.
    fs::write(app.app_data_dir().join(PRICE_OVERRIDES_FILE), "{ not json").expect("write");
    assert_eq!(get_price_migration_notice_impl(&app).expect("read"), None);
    assert!(!app
        .app_data_dir()
        .join(PRICE_MIGRATION_NOTICE_FILE)
        .exists());
    assert!(backups(&app).is_empty());

    // An old file whose only trait holds no price: migrated and backed up,
    // but no price was cleared, so there is nothing to tell.
    write_override_file(
        &app,
        &json!({ "future-model-z": { "_meta": { "status": "auto_discovered" } } }),
    );
    assert_eq!(get_price_migration_notice_impl(&app).expect("read"), None);
    assert!(override_file(&app).is_none());
    assert_eq!(backups(&app).len(), 1);
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn a_migration_without_a_backup_leaves_no_notice() {
    let app = test_app("notice_no_backup");
    let original = write_override_file(&app, &legacy_file_for_the_notice());
    let digest = price_overrides_digest(&original);
    // A directory in the backup's place: the backup cannot be written.
    fs::create_dir(
        app.app_data_dir()
            .join(format!("prices.legacy-backup-{}.json", &digest[..12])),
    )
    .expect("block the backup");

    let prices = get_prices_impl(&app).expect("the price read works");

    // Priced from the file as it is, which is left as it was, and nothing to
    // point to (T10.189 review P3-3: the cleanup waits for its backup).
    assert_eq!(prices["claude-sonnet-5"]["input"], json!(3));
    assert_eq!(override_bytes(&app), original);
    assert_eq!(get_price_migration_notice_impl(&app).expect("read"), None);
    let _ = fs::remove_dir_all(app.app_data_dir());
}

/// What the app does on its next start: try the migrations this run
/// postponed again.
fn restart(app: &AppContext) {
    super::postponed_price_migrations().retain(|(dir, _)| dir != app.app_data_dir());
}

#[test]
fn a_file_whose_backup_failed_is_priced_as_it_is_and_never_overwritten() {
    // T10.189 review P3-3 (probe P4): the backup could not be written, the
    // prices loaded migrated, and a save then stored them over the original,
    // 582 bytes down to 121, with no copy of the original left anywhere.
    let app = test_app("postponed");
    let legacy = object(legacy_file_for_the_notice());
    let original = write_override_file(&app, &Value::Object(legacy.clone()));
    let digest = price_overrides_digest(&original);
    let blocker = app
        .app_data_dir()
        .join(format!("prices.legacy-backup-{}.json", &digest[..12]));
    fs::create_dir(&blocker).expect("block the backup");
    let as_it_is = merge_discovered_prices(
        apply_price_overrides(&default_prices(), &legacy),
        &load_discovered_model_prices(&app),
    );

    // Read after read: the prices from before the cleanup, the file as it was.
    for _ in 0..2 {
        assert_eq!(
            get_prices_impl(&app).expect("the price read works"),
            as_it_is
        );
    }
    assert_eq!(override_bytes(&app), original);

    // No save or reset overwrites it; the user is told why and what to do.
    let mut editor = as_sent_by_editor(&as_it_is);
    edit_in_visual_editor(&mut editor, "gpt-4.1", "output", 7.5);
    assert_eq!(
        save_prices_impl(&app, editor.clone()).expect_err("the save is refused"),
        PRICE_SAVE_WAITS_FOR_BACKUP
    );
    assert_eq!(
        reset_prices_impl(&app).expect_err("the reset is refused"),
        PRICE_RESET_WAITS_FOR_BACKUP
    );
    assert_eq!(override_bytes(&app), original);
    // Still refused once a backup could be written: the editor holds the
    // prices from before the cleanup, and saving them would store the
    // byproducts of the old version as the user's own.
    fs::remove_dir(&blocker).expect("unblock the backup");
    assert_eq!(
        save_prices_impl(&app, editor).expect_err("the save is refused"),
        PRICE_SAVE_WAITS_FOR_BACKUP
    );
    assert_eq!(override_bytes(&app), original);
    assert!(backups(&app).is_empty());
    assert_eq!(get_price_migration_notice_impl(&app).expect("read"), None);

    // The next start backs the original up first, then cleans it up, and
    // saving works as before.
    restart(&app);
    let migrated = get_prices_impl(&app).expect("the price read works");
    assert_eq!(migrated["claude-sonnet-5"]["input"], json!(2.0));
    assert_eq!(backups(&app).len(), 1);
    assert_eq!(
        fs::read(&backups(&app)[0]).expect("read the backup"),
        original
    );
    assert!(get_price_migration_notice_impl(&app)
        .expect("read")
        .is_some());
    let mut editor = as_sent_by_editor(&migrated);
    edit_in_visual_editor(&mut editor, "gpt-4.1", "output", 7.5);
    save_prices_impl(&app, editor).expect("the save works");
    assert_eq!(
        get_prices_impl(&app).expect("the price read works")["gpt-4.1"]["output"],
        json!(7.5)
    );
    assert_eq!(
        fs::read(&backups(&app)[0]).expect("read the backup"),
        original
    );
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn a_damaged_or_foreign_notice_record_shows_nothing_and_changes_no_price() {
    // T10.189 review P3-2 (probe P1): the record is read as empty, so no
    // notice shows, prices are what they were, and dismissing and a later
    // cleanup still work.
    let source = test_app("notice_record_source");
    write_override_file(&source, &legacy_file_for_the_notice());
    get_prices_impl(&source).expect("migrate");
    let valid: Value = serde_json::from_slice(
        &fs::read(source.app_data_dir().join(PRICE_MIGRATION_NOTICE_FILE)).expect("read record"),
    )
    .expect("parse record");
    let _ = fs::remove_dir_all(source.app_data_dir());
    let bytes = serde_json::to_vec(&valid).expect("serialize");
    let with = |pointer: &str, value: Value| {
        let mut record = valid.clone();
        *record.pointer_mut(pointer).expect("field") = value;
        serde_json::to_vec(&record).expect("serialize")
    };
    let without = |pointer: &str, field: &str| {
        let mut record = valid.clone();
        let parent = record.pointer_mut(pointer).and_then(Value::as_object_mut);
        parent.expect("object").remove(field);
        serde_json::to_vec(&record).expect("serialize")
    };
    let records = [
        ("truncated", bytes[..bytes.len() / 2].to_vec()),
        ("garbage", b"\xff\xfe not json at all".to_vec()),
        ("empty", Vec::new()),
        (
            "array",
            serde_json::to_vec(&json!([valid.clone()])).expect("serialize"),
        ),
        ("null", b"null".to_vec()),
        ("format 2", with("/format", json!(2))),
        ("no format", without("", "format")),
        ("format as text", with("/format", json!("1"))),
        ("negative count", with("/notice/modelsCleared", json!(-6))),
        (
            "fractional count",
            with("/notice/fieldsCleared", json!(12.5)),
        ),
        (
            "dismissedIds not a list",
            with("/dismissedIds", json!("none")),
        ),
        ("no backupFile", without("/notice", "backupFile")),
        ("cleared not a list", with("/notice/cleared", json!({}))),
        (
            "previous as text",
            with("/notice/changed/0/previous", json!("3")),
        ),
    ];

    let app = test_app("notice_record_damaged");
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    edit_in_visual_editor(&mut editor, "claude-sonnet-5", "input", 3.5);
    save_prices_impl(&app, editor).expect("save prices");
    let prices = get_prices_impl(&app).expect("load prices");
    let record_file = app.app_data_dir().join(PRICE_MIGRATION_NOTICE_FILE);
    // The valid record shows, so each case below fails for its own reason.
    fs::write(&record_file, &bytes).expect("write record");
    assert!(get_price_migration_notice_impl(&app)
        .expect("read")
        .is_some());
    for (case, record) in &records {
        fs::write(&record_file, record).expect("write record");
        assert_eq!(
            get_price_migration_notice_impl(&app).expect("read"),
            None,
            "{case}"
        );
        assert_eq!(
            get_prices_impl(&app).expect("load prices"),
            prices,
            "{case}"
        );
    }

    // Dismissing still works and writes a sound record.
    let id = valid["notice"]["id"].as_str().expect("id").to_string();
    dismiss_price_migration_notice_impl(&app, &id).expect("dismiss");
    let record = read_price_migration_notice_record(app.app_data_dir());
    assert_eq!(record.format, PRICE_MIGRATION_NOTICE_FORMAT);
    assert_eq!(record.dismissed_ids, std::slice::from_ref(&id));
    // A later cleanup of another file still shows its notice.
    let later = write_override_file(
        &app,
        &json!({ "gpt-4.1": { "input": 2 }, "claude-sonnet-5": { "input": 3 } }),
    );
    let notice = get_price_migration_notice_impl(&app)
        .expect("read")
        .expect("the later cleanup shows");
    assert_eq!(notice.notice.id, price_overrides_digest(&later));
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn a_rate_that_is_no_number_is_not_counted_as_a_cleared_price() {
    // T10.189 review P3-5 b: 「其余 K 项与现在的价格相同」 counted it.
    let defaults = default_prices();
    let legacy = object(json!({
        "future-model-q": {
            "input": "?", "output": 2, "cache_input": null,
            "_meta": { "status": "auto_discovered", "fallback_key": "codex-agent", "tools": ["codex"] }
        }
    }));
    let migrated = migrate_legacy_price_overrides(&defaults, &legacy);
    assert!(!migrated.contains_key("future-model-q"));

    let notice = price_migration_notice(&defaults, &legacy, &migrated, "id", "backup", "")
        .expect("a price was cleared");

    assert_eq!(
        notice.cleared,
        [cleared_model("future-model-q", &["output"], true)]
    );
    assert_eq!((notice.models_cleared, notice.fields_cleared), (1, 1));
    assert!(notice.changed.len() <= notice.fields_cleared);
}

#[test]
fn a_state_record_failure_is_not_reported_as_an_unsaved_migration() {
    let app = test_app("state_only");
    let dir = app.app_data_dir();
    let legacy = object(legacy_file_for_the_notice());
    let bytes = write_override_file(&app, &Value::Object(legacy.clone()));
    let digest = price_overrides_digest(&bytes);
    fs::create_dir(dir.join(PRICE_OVERRIDES_STATE_FILE)).expect("block state");

    // Nothing to migrate: only the hash record is missing (review P3-c).
    match persist_price_override_migration(dir, &bytes, &digest, &legacy, &legacy) {
        Err(error @ PriceMigrationNotSaved::StateNotRecorded(_)) => {
            assert!(error
                .to_string()
                .starts_with("the state record was not written"));
        }
        other => panic!("expected a state record failure, got {other:?}"),
    }
    assert!(backups(&app).is_empty());

    // A real migration is saved; only its state record is missing.
    let migrated = migrate_legacy_price_overrides(&default_prices(), &legacy);
    let saved = persist_price_override_migration(dir, &bytes, &digest, &legacy, &migrated)
        .expect("the migration is saved");
    assert_eq!(saved, Some(file_name(&backups(&app)[0])));
    fs::remove_dir(dir.join(PRICE_OVERRIDES_STATE_FILE)).expect("unblock state");
    assert_eq!(
        persist_price_override_migration(dir, &bytes, &digest, &legacy, &legacy)
            .expect("records the hash"),
        None
    );
    let _ = fs::remove_dir_all(dir);
}

/// A legal user price file. A torn write of the replacement below does not parse.
const PREVIOUS_PRICE_FILE: &str =
    "{\n  \"claude-sonnet-5\": {\n    \"input\": 3.0,\n    \"output\": 15.0\n  }\n}";

fn price_file_sandbox(label: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "tokenledger_price_atomic_{label}_{}_{}",
        std::process::id(),
        TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("price file sandbox");
    path
}

fn assert_no_price_temps(dir: &std::path::Path) {
    let temps: Vec<_> = fs::read_dir(dir)
        .expect("read sandbox")
        .filter_map(|entry| {
            let name = entry.expect("entry").file_name();
            let name = name.to_string_lossy().into_owned();
            name.ends_with(".tmp").then_some(name)
        })
        .collect();
    assert!(temps.is_empty(), "left temporary price files: {temps:?}");
}

fn assert_previous_price_file_still_readable(path: &std::path::Path) {
    let bytes = fs::read(path).expect("prices.json still present");
    assert_eq!(
        bytes,
        PREVIOUS_PRICE_FILE.as_bytes(),
        "the previous price file was overwritten"
    );
    let parsed: Value = serde_json::from_slice(&bytes).expect("previous prices.json still parses");
    assert_eq!(parsed["claude-sonnet-5"]["input"], json!(3.0));
    assert_eq!(parsed["claude-sonnet-5"]["output"], json!(15.0));
}

fn refuse_price_rename(_from: &std::path::Path, _to: &std::path::Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "simulated rename refusal",
    ))
}

#[test]
fn a_price_file_is_replaced_only_by_a_complete_write() {
    let dir = price_file_sandbox("replace");
    let path = dir.join("prices.json");
    fs::write(&path, PREVIOUS_PRICE_FILE).expect("seed prices.json");
    let next = b"{\n  \"claude-sonnet-5\": {\n    \"input\": 9.0,\n    \"output\": 45.0\n  }\n}";

    write_price_file(&path, next).expect("atomic replace");

    let bytes = fs::read(&path).expect("read prices.json");
    assert_eq!(bytes, next);
    serde_json::from_slice::<Value>(&bytes).expect("replacement still parses");
    assert_no_price_temps(&dir);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn an_interrupted_price_write_leaves_the_previous_file_readable() {
    let dir = price_file_sandbox("interrupt");
    let path = dir.join("prices.json");
    fs::write(&path, PREVIOUS_PRICE_FILE).expect("seed prices.json");
    // A prefix of this payload is not valid JSON. Renaming it would make the
    // next read fail; the interrupted write must not do that.
    let incoming = b"{\"claude-sonnet-5\":{\"input\":9.0,\"output\":45.0}}";

    let error = persist_price_bytes(
        &path,
        incoming,
        &PriceFilePersist {
            interrupt_after: Some(8),
            rename: replace_price_file,
        },
    )
    .expect_err("the write stops before the rename");

    assert!(error.contains("interrupted"), "unexpected error: {error}");
    assert_previous_price_file_still_readable(&path);
    assert_no_price_temps(&dir);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_refused_price_rename_leaves_the_previous_file_readable() {
    let dir = price_file_sandbox("rename");
    let path = dir.join("prices.json");
    fs::write(&path, PREVIOUS_PRICE_FILE).expect("seed prices.json");
    let incoming = b"{\"claude-sonnet-5\":{\"input\":9.0,\"output\":45.0}}";

    let error = persist_price_bytes(
        &path,
        incoming,
        &PriceFilePersist {
            interrupt_after: None,
            rename: refuse_price_rename,
        },
    )
    .expect_err("the rename is refused");

    assert!(
        error.contains("simulated rename refusal"),
        "unexpected error: {error}"
    );
    assert_previous_price_file_still_readable(&path);
    assert_no_price_temps(&dir);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn an_interrupted_price_write_does_not_create_a_partial_file() {
    let dir = price_file_sandbox("absent");
    let path = dir.join("prices.json");

    persist_price_bytes(
        &path,
        b"{\"claude-sonnet-5\":{\"input\":9.0}}",
        &PriceFilePersist {
            interrupt_after: Some(4),
            rename: replace_price_file,
        },
    )
    .expect_err("the write stops before the rename");

    assert!(
        !path.exists(),
        "a partial prices.json was created where none existed"
    );
    assert_no_price_temps(&dir);
    let _ = fs::remove_dir_all(&dir);
}

/// 价格表是高频读文件（每次取价都要读），所以「有读者正开着文件时保存」是常规
/// 路径，不能靠运气。这条用例把读者握在手里不放：写入方必须照常保存成功，而且
/// 读者手里的旧句柄必须还读到替换前那份完整内容——原地覆盖会让它读到新内容或
/// 半截内容。
///
/// 这个握着的句柄就是注入式假 rename 看不见的那一层：旧实现（Windows
/// `MoveFileExW(REPLACE_EXISTING)`）要求目标上所有句柄让出 DELETE，读者不让，
/// 于是保存 100% 失败。
#[test]
fn a_price_save_succeeds_while_a_reader_holds_the_file_open() {
    use std::io::Read;

    let dir = price_file_sandbox("held");
    let path = dir.join("prices.json");

    let table = |marker: u64| {
        let mut models = Map::new();
        for index in 0..2_000u64 {
            let rate = 1_000_000 + marker * 100_000 + index;
            models.insert(
                format!("held-model-{index:05}"),
                json!({
                    "input": rate,
                    "output": rate,
                    "cache_input": rate,
                    "cache_write": rate,
                }),
            );
        }
        serde_json::to_string_pretty(&Value::Object(models)).expect("serialize price table")
    };
    let first = table(0);
    let second = table(1);
    let third = table(2);
    fs::write(&path, &first).expect("seed prices.json");

    // 读者按 `load_saved_prices` 的方式打开价格表，并且在两次保存期间一直开着。
    let mut held = fs::File::open(&path).expect("open prices.json");

    write_price_file(&path, second.as_bytes()).expect("save while a reader holds the file");
    write_price_file(&path, third.as_bytes()).expect("save again while it is still held");

    let mut held_bytes = Vec::new();
    held.read_to_end(&mut held_bytes).expect("read held file");
    assert_eq!(
        String::from_utf8_lossy(&held_bytes),
        first,
        "读者手里的旧文件被原地改写了，它的这一份读取不再自洽"
    );
    drop(held);

    assert_eq!(
        fs::read_to_string(&path).expect("read current prices.json"),
        third,
        "最后一次保存的内容不在盘上"
    );
    assert_no_price_temps(&dir);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_user_schedule_with_an_invalid_multiplier_is_refused() {
    let app = test_app("bad_tier");
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    editor["gpt-6-sol"]["tiers"][0]["multipliers"]["input"] = json!(-2);

    let error = save_prices_impl(&app, editor).expect_err("negative multiplier is refused");

    assert!(
        error.contains("gpt-6-sol.tiers[0].multipliers.input"),
        "{error}"
    );
    assert!(override_file(&app).is_none());
    let _ = fs::remove_dir_all(app.app_data_dir());
}

#[test]
fn an_older_invalid_override_left_alone_does_not_block_other_edits() {
    let app = test_app("old_bad_tier");
    let mut stored = Map::new();
    stored.insert(
        "gpt-6-sol".to_string(),
        json!({"tiers": [{"above_prompt_tokens": 272000, "multipliers": {"input": -2}}]}),
    );
    store_price_overrides(app.app_data_dir(), &stored).expect("store old override");
    let mut editor = as_sent_by_editor(&get_prices_impl(&app).expect("load prices"));
    editor["gpt-5.6-terra"]["input"] = json!(9.5);

    save_prices_impl(&app, editor).expect("saving another model still works");

    let file = override_file(&app).expect("override file");
    assert_eq!(file["gpt-5.6-terra"]["input"], json!(9.5));
    let _ = fs::remove_dir_all(app.app_data_dir());
}
