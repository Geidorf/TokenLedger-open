//! Local cache for `StatsData` JSON payloads.
//!
//! The cache lives in the same SQLite database as the regular `token_logs`
//! table, but in its own `local_stats_cache` table. Stats v2 uses the canonical
//! query fingerprint (plus scope) as the stored identity, while the legacy key
//! constructor remains available for older internal call sites. The value is
//! the raw JSON body returned by either local or cloud aggregation.
//!
//! Why a dedicated table rather than `Arc<Mutex<HashMap<...>>>` in memory?
//!   * It survives an app restart — the first paint after relaunch is just
//!     as fast as a warm in-app navigation.
//!   * Concurrent Tauri commands can each grab their own SQLite connection
//!     without contending on a single global mutex for the cache itself.
//!   * It's small: at ~5 KB per payload and a few active query combinations
//!     the whole table is under 100 KB.
//!
//! TTL: 5 minutes. After that we re-fetch and overwrite. The TTL is short
//! enough that a 1-minute UI poll always sees fresh data within ~6 polls,
//! but long enough that opening the dashboard a few times in a row does
//! not refetch from Supabase.
//!
//! The cache is best-effort. A read or write that fails is logged and
//! returns `None` / silently swallows the error — the caller falls back to
//! the slow path transparently.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde_json::Value;

use crate::db;

/// Cache TTL. The React dashboard polls every 60 s, so 5 minutes is short
/// enough to feel live and long enough to absorb a few quick re-renders.
pub const CACHE_TTL_SECS: i64 = 300;

/// Composite cache key. Stats v2 stores its canonical fingerprint in the
/// existing `device_filter` database column to avoid a cache schema migration.
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct CacheKey {
    pub scope: String,         // "local" | "cloud"
    pub range: String,         // "today" | "week" | "month" | "year" | "all"
    pub device_filter: String, // "all_cloud" | "<machine_id>" | ""
    pub timezone: String,      // IANA timezone, e.g. "Asia/Shanghai"
}

impl CacheKey {
    #[allow(dead_code)]
    pub fn new(scope: &str, range: &str, device_filter: &str) -> Self {
        Self::with_timezone(scope, range, device_filter, "")
    }

    pub fn with_timezone(scope: &str, range: &str, device_filter: &str, timezone: &str) -> Self {
        Self {
            scope: scope.to_string(),
            range: range.to_string(),
            device_filter: device_filter.to_string(),
            timezone: timezone.to_string(),
        }
    }

    /// Canonical Stats v2 queries are keyed by their stable SHA-256 fingerprint.
    /// The fingerprint includes timezone, token mode, every normalized filter,
    /// and literal search text, so no query dimension can reuse another query's
    /// cached response.
    pub fn for_query(scope: &str, range: &str, fingerprint: &str) -> Self {
        Self::with_timezone(scope, range, &format!("query-v2:{fingerprint}"), "")
    }

    fn encoded_device_filter(&self) -> String {
        if self.timezone.is_empty() {
            self.device_filter.clone()
        } else {
            format!("{}\u{1f}{}", self.device_filter, self.timezone)
        }
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Open a fresh SQLite connection on the app DB. Cheap; rusqlite is sync.
fn open(db_path: &std::path::Path) -> SqlResult<Connection> {
    let conn = db::get_connection(db_path)?;
    // Run the cache schema migration defensively. init_db already calls
    // this once on app startup, but the cache module is also useful from
    // unit tests that bypass init_db.
    db::init_local_cache(&conn)?;
    Ok(conn)
}

/// Read a cached payload. Returns `None` on miss, parse error, or expired
/// entry. The caller treats `None` as "fetch fresh and write back".
pub fn read(db_path: &std::path::Path, key: &CacheKey) -> Option<Value> {
    let conn = open(db_path).ok()?;
    let device_filter = key.encoded_device_filter();
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT data_json, updated_at FROM local_stats_cache
             WHERE scope = ?1 AND range_key = ?2 AND device_filter = ?3",
            params![key.scope, key.range, device_filter],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .ok()
        .flatten();

    let (raw, updated_at) = row?;
    if now_secs() - updated_at > CACHE_TTL_SECS {
        return None;
    }
    serde_json::from_str(&raw).ok()
}

/// Write/overwrite a cached payload. Errors are swallowed because the
/// caller will simply see the next read as a miss and refetch.
pub fn write(db_path: &std::path::Path, key: &CacheKey, data: &Value) {
    if let Ok(conn) = open(db_path) {
        let device_filter = key.encoded_device_filter();
        let raw = match serde_json::to_string(data) {
            Ok(s) => s,
            Err(_) => return,
        };
        let updated_at = now_secs();
        let _ = conn.execute(
            "INSERT INTO local_stats_cache (scope, range_key, device_filter, data_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(scope, range_key, device_filter) DO UPDATE SET
                 data_json = excluded.data_json,
                 updated_at = excluded.updated_at",
            params![key.scope, key.range, device_filter, raw, updated_at],
        );
    }
}

/// Invalidate every cached payload. Called from the sync pipeline so the
/// dashboard re-fetches once the cloud views have been refreshed.
///
/// Part of the public cache API; reserved for the next sync pipeline that
/// will wire it to `sync_to_supabase`. Not yet referenced from the call
/// site, hence the allow attribute.
#[allow(dead_code)]
pub fn invalidate_all(db_path: &std::path::Path) {
    if let Ok(conn) = open(db_path) {
        let _ = conn.execute("DELETE FROM local_stats_cache", []);
    }
}

/// Invalidate just the cloud-scope entries. Local stats are unaffected by
/// a Supabase refresh, so we can leave them warm.
pub fn invalidate_cloud(db_path: &std::path::Path) {
    if let Ok(conn) = open(db_path) {
        let _ = conn.execute("DELETE FROM local_stats_cache WHERE scope = 'cloud'", []);
    }
}

/// Read the cache age in seconds for a given key. Useful for debugging
/// "is the cache actually warm" during dev.
///
/// Diagnostic helper — not wired into the dashboard yet, kept available
/// for the settings panel and ad-hoc log lines.
#[allow(dead_code)]
pub fn age_secs(db_path: &std::path::Path, key: &CacheKey) -> Option<i64> {
    let conn = open(db_path).ok()?;
    let device_filter = key.encoded_device_filter();
    let updated_at: i64 = conn
        .query_row(
            "SELECT updated_at FROM local_stats_cache
             WHERE scope = ?1 AND range_key = ?2 AND device_filter = ?3",
            params![key.scope, key.range, device_filter],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()?;
    Some(now_secs() - updated_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_db_path() -> std::path::PathBuf {
        let dir = env::temp_dir();
        let count = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = dir.join(format!(
            "tokenledger_cache_test_{}_{}.db",
            std::process::id(),
            count
        ));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn read_write_roundtrip() {
        let path = temp_db_path();
        let key = CacheKey::new("local", "all", "");

        assert!(read(&path, &key).is_none());
        write(&path, &key, &serde_json::json!({"ok": true}));
        let cached = read(&path, &key).expect("cache hit");
        assert_eq!(cached["ok"], serde_json::json!(true));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn scope_isolation() {
        let path = temp_db_path();
        let local = CacheKey::new("local", "all", "");
        let cloud = CacheKey::new("cloud", "all", "");

        write(&path, &local, &serde_json::json!({"scope": "local"}));
        write(&path, &cloud, &serde_json::json!({"scope": "cloud"}));

        assert_eq!(read(&path, &local).unwrap()["scope"], "local");
        assert_eq!(read(&path, &cloud).unwrap()["scope"], "cloud");

        invalidate_cloud(&path);
        assert!(read(&path, &cloud).is_none());
        assert!(read(&path, &local).is_some());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn timezone_isolation() {
        let path = temp_db_path();
        let utc = CacheKey::with_timezone("cloud", "today", "all_cloud", "UTC");
        let shanghai = CacheKey::with_timezone("cloud", "today", "all_cloud", "Asia/Shanghai");

        write(&path, &utc, &serde_json::json!({"timezone": "UTC"}));
        write(
            &path,
            &shanghai,
            &serde_json::json!({"timezone": "Asia/Shanghai"}),
        );

        assert_eq!(read(&path, &utc).unwrap()["timezone"], "UTC");
        assert_eq!(read(&path, &shanghai).unwrap()["timezone"], "Asia/Shanghai");

        let _ = std::fs::remove_file(&path);
    }
}
