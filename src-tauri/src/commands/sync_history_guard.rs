//! Incomplete legacy gateway hours must never overwrite a fuller cloud history.
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use rusqlite::Connection;

use super::gateway_cloud;
use crate::gateway::accounting::Coverage;

pub(super) const WARNING: &str = "旧网关历史可能不完整，已保留云端旧记录并暂停这些时段的覆盖与历史清理；其他完整时段按正常条件继续同步。";

pub(super) struct HistoryGuard(Option<Coverage>);

impl HistoryGuard {
    pub fn load(path: &Path) -> Result<Self, String> {
        gateway_cloud::accounting_coverage(path).map(Self)
    }

    pub fn pending(&self) -> bool {
        self.0
            .as_ref()
            .is_some_and(Coverage::has_incomplete_history)
    }

    pub fn allows(&self, hour: &str) -> bool {
        self.0
            .as_ref()
            .is_none_or(|coverage| coverage.hour_is_complete(hour))
    }

    pub fn retain_complete_hours(&self, hours: &mut BTreeMap<String, Vec<gateway_cloud::HourRow>>) {
        hours.retain(|hour, _| self.allows(hour));
    }

    /// Include deleted rows' queued identities, not just rows still in the ledger.
    /// Protect the whole hour so no alternate scan-only path uploads a partial bucket.
    pub fn deferred_hours(&self, conn: &Connection) -> Result<HashSet<String>, String> {
        if !self.pending() {
            return Ok(HashSet::new());
        }
        let mut statement = conn
            .prepare(
                "SELECT DISTINCT substr(timestamp,1,13)||':00:00' FROM token_logs
             UNION SELECT hour_bucket FROM scan_cloud_dirty_buckets",
            )
            .map_err(|error| error.to_string())?;
        let hours = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        Ok(hours
            .into_iter()
            .filter(|hour| !self.allows(hour))
            .collect())
    }

    pub fn warning(&self, other: Option<&str>) -> Option<String> {
        match (self.pending(), other) {
            (true, Some(other)) => Some(format!("{WARNING} {other}")),
            (true, None) => Some(WARNING.into()),
            (false, other) => other.map(str::to_owned),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::scanner_sync;

    fn next_id() -> usize {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn legacy_guard() -> HistoryGuard {
        let dir = std::env::temp_dir().join(format!(
            "tokenledger-history-{}-{}",
            std::process::id(),
            next_id()
        ));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("usage-v1.jsonl"), "").unwrap();
        let coverage = crate::gateway::accounting::initialize(&dir).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
        HistoryGuard(Some(coverage))
    }

    #[test]
    fn incomplete_history_protects_deleted_buckets_and_leaves_future_work_actionable() {
        let guard = legacy_guard();
        let dir = std::env::temp_dir().join(format!(
            "tokenledger-history-db-{}-{}",
            std::process::id(),
            next_id()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("fixture.db");
        crate::db::init_test_db(&path).unwrap();
        let conn = crate::db::get_connection(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO token_logs(tool,model,input_tokens,output_tokens,cached_tokens,timestamp,session_id,unique_key) VALUES
            ('claude','m',1,1,0,'2000-01-01 00:12:00','old','old'),
            ('claude','m',1,1,0,'2999-01-01 00:12:00','new','new');
            INSERT INTO scan_cloud_dirty_buckets(user_id,tool,model,hour_bucket,machine_id) VALUES
            ('user','claude','deleted','2000-01-02 00:00:00','machine'),
            ('user','claude','new','2999-01-01 00:00:00','machine');",
        )
        .unwrap();
        let deferred = guard.deferred_hours(&conn).unwrap();
        assert_eq!(deferred.len(), 2);
        assert!(deferred.contains("2000-01-02 00:00:00"));
        let dirty = scanner_sync::dirty_snapshot(&conn, "user", "machine", &deferred).unwrap();
        assert_eq!(dirty.ids.len(), 1);
        scanner_sync::acknowledge_dirty(&conn, "user", &dirty.ids).unwrap();
        let retained: String = conn
            .query_row("SELECT model FROM scan_cloud_dirty_buckets", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(retained, "deleted");
        let mut hours = BTreeMap::from([
            ("2000-01-01 00:00:00".into(), vec![]),
            ("2999-01-01 00:00:00".into(), vec![]),
        ]);
        guard.retain_complete_hours(&mut hours);
        assert_eq!(hours.len(), 1);
        assert!(hours.contains_key("2999-01-01 00:00:00"));
        assert!(guard.pending(), "whole-tool purges must remain queued");
        assert!(guard
            .warning(Some("refresh failed"))
            .unwrap()
            .contains("refresh failed"));
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scan_only_install_does_not_gain_an_artificial_history_block() {
        let guard = HistoryGuard(None);
        assert!(!guard.pending());
        assert!(guard.allows("2000-01-01 00:00:00"));
        assert_eq!(guard.warning(None), None);
    }
}
