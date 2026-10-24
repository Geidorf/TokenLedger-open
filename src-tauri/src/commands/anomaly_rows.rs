//! Rows read for usage-anomaly detection (`crate::usage_anomaly`).
//!
//! Same source as the local overview: the merged ledger view (gateway rows
//! win over the scanned copy of the same request), every machine, the
//! overview's per-row cost estimate. Only the window the detector needs is
//! read, without the comparison period a Stats v2 query would add.

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};

use super::{
    behavior_session_id, db, gateway_overlay, load_prices, query_bounds, read_local_rows_filtered,
    rows_in_timezone, BehaviorPricer, LocalStatsQuery, NormalizedStatsQuery,
};
use crate::app_paths::AppContext;
use crate::usage_anomaly::{GatewayOutcome, UsageRow};

/// Local rows from `start` (local calendar day, inclusive) through `now`.
pub(crate) fn local_usage_rows(
    app: &AppContext,
    start: NaiveDate,
    now: DateTime<Local>,
) -> Result<Vec<UsageRow>, String> {
    let query = NormalizedStatsQuery::from_query(LocalStatsQuery {
        range: "custom".to_string(),
        timezone: "local".to_string(),
        machines: None,
        machine: None,
        tools: None,
        tool: None,
        models: None,
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
        start: Some(start.format("%Y-%m-%d").to_string()),
        end: Some(now.date_naive().format("%Y-%m-%d").to_string()),
    })?;
    let zoned_now = now.with_timezone(&query.tz);
    let bounds = query_bounds(query.range, zoned_now)?;
    let db_path = db::get_db_path(app);
    db::init_db(&db_path).map_err(|error| error.to_string())?;
    let rows = rows_in_timezone(
        &read_local_rows_filtered(
            &db_path,
            &query,
            bounds.current_start.as_ref(),
            &bounds.current_end,
            None,
        )?,
        query.tz,
    )?;
    let prices = load_prices(app);
    let mut pricer = BehaviorPricer::new(&prices);
    Ok(rows
        .iter()
        .filter_map(|row| {
            let at = NaiveDateTime::parse_from_str(&row.timestamp, "%Y-%m-%d %H:%M:%S").ok()?;
            Some(UsageRow {
                tool: row.tool.clone(),
                model: row.model.clone(),
                at,
                session_id: behavior_session_id(&row.session_id).map(str::to_string),
                input: row.input_tokens.max(0),
                output: row.output_tokens.max(0),
                cache_read: row.cache_split_is_proven().then(|| row.cache_read_tokens()),
                cost: pricer.row_cost(row),
            })
        })
        .collect())
}

/// This computer's gateway attempts (successful or not, from the gateway's
/// diagnostic lines) that ended at or after `since` (local time). `None` when there is no gateway ledger at all, so the check is
/// reported as not applicable instead of "0% errors".
pub(crate) fn local_gateway_outcomes(
    app: &AppContext,
    since: NaiveDateTime,
) -> Result<Option<Vec<GatewayOutcome>>, String> {
    let db_path = db::get_db_path(app);
    if !gateway_overlay::accounting_present(&db_path) {
        return Ok(None);
    }
    let since = Local
        .from_local_datetime(&since)
        .earliest()
        .map(|at| at.with_timezone(&Utc))
        .unwrap_or_default();
    let outcomes =
        crate::gateway::attempt_outcomes_since(&gateway_overlay::gateway_dir(&db_path), since)?;
    Ok(Some(
        outcomes
            .into_iter()
            .map(|(ended, ok)| GatewayOutcome {
                at: ended.with_timezone(&Local).naive_local(),
                ok,
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn test_app() -> AppContext {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_anomaly_rows_{}_{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&path);
        let app = AppContext::for_test(path);
        db::init_db(&db::get_db_path(&app)).expect("initialize test database");
        app
    }

    fn insert(app: &AppContext, key: &str, at: NaiveDateTime, session: &str, cost: Option<f64>) {
        let conn = db::get_connection(&db::get_db_path(app)).expect("open test database");
        conn.execute(
            "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, sync_status) VALUES ('claude', 'model-a', 100, 50, 30, 10, ?1, ?2, ?3, ?4, 'machine', 0)",
            rusqlite::params![at.format("%Y-%m-%d %H:%M:%S").to_string(), session, key, cost],
        )
        .expect("insert test log");
    }

    #[test]
    fn reads_only_the_window_with_cache_reads_and_real_sessions() {
        let app = test_app();
        let now = Local::now();
        let today = now.date_naive();
        let start = today - Duration::days(20);
        let inside = start.and_hms_opt(12, 0, 0).unwrap();
        insert(
            &app,
            "before",
            inside - Duration::days(1),
            "s-old",
            Some(1.0),
        );
        insert(&app, "inside", inside, "s-1", Some(0.25));
        insert(
            &app,
            "anonymous",
            inside + Duration::hours(1),
            "",
            Some(0.5),
        );

        let rows = local_usage_rows(&app, start, now).unwrap();
        assert_eq!(rows.len(), 2);
        let row = rows.iter().find(|row| row.session_id.is_some()).unwrap();
        assert_eq!(row.session_id.as_deref(), Some("s-1"));
        assert_eq!((row.input, row.output, row.cache_read), (100, 50, Some(20)));
        assert_eq!(row.cost, Some(0.25));
        assert_eq!(row.at, inside);
        assert!(rows.iter().any(|row| row.session_id.is_none()));
    }

    #[test]
    fn no_gateway_means_not_applicable() {
        let app = test_app();
        let since = Local::now().naive_local() - Duration::days(8);
        assert_eq!(local_gateway_outcomes(&app, since).unwrap(), None);
    }
}
