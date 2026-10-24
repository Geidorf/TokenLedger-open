//! Durable identities of scan aggregates that may already exist remotely.
//! Sending an identity is recorded before network I/O, including first uploads.
use super::gateway_cloud;
use rusqlite::{params, Connection, Result};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct Bucket {
    pub tool: String,
    pub model: String,
    pub hour_bucket: String,
    pub machine_id: String,
}
impl Bucket {
    pub fn unique_key(&self) -> String {
        gateway_cloud::unique_key(&self.machine_id, &self.tool, &self.model, &self.hour_bucket)
    }
}
#[derive(Default)]
pub(super) struct DirtySnapshot {
    pub ids: Vec<i64>,
    pub buckets: HashSet<Bucket>,
}

pub(super) fn dirty_snapshot(
    conn: &Connection,
    user: &str,
    fallback: &str,
    deferred_hours: &HashSet<String>,
) -> Result<DirtySnapshot> {
    let mut statement=conn.prepare("SELECT id,tool,model,hour_bucket,coalesce(nullif(machine_id,''),?2)
        FROM scan_cloud_dirty_buckets WHERE user_id=?1
          AND coalesce(nullif(machine_id,''),?2)=?2
          AND NOT (
            tool='codex' AND coalesce(nullif(machine_id,''),?2)=?2
            AND EXISTS(SELECT 1 FROM pending_cloud_purges WHERE tool='codex' AND machine_id=?2 AND ready=0)) ORDER BY id")?;
    let mut result = DirtySnapshot::default();
    for row in statement.query_map(params![user, fallback], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            Bucket {
                tool: r.get(1)?,
                model: r.get(2)?,
                hour_bucket: r.get(3)?,
                machine_id: r.get(4)?,
            },
        ))
    })? {
        let (id, bucket) = row?;
        if !deferred_hours.contains(&bucket.hour_bucket) {
            result.ids.push(id);
            result.buckets.insert(bucket);
        }
    }
    Ok(result)
}

pub(super) fn remember_sending(
    conn: &Connection,
    user: &str,
    fallback: &str,
    ids: impl IntoIterator<Item = i64>,
) -> Result<()> {
    let mut statement=conn.prepare("INSERT OR IGNORE INTO scan_cloud_sent_identities(user_id,source_key,tool,model,hour_bucket,machine_id)
        SELECT ?1,unique_key,tool,model,substr(timestamp,1,13)||':00:00',coalesce(nullif(machine_id,''),?2)
        FROM token_logs WHERE id=?3
          AND coalesce(nullif(machine_id,''),?2)=?2")?;
    for id in ids {
        statement.execute(params![user, fallback, id])?;
    }
    Ok(())
}

pub(super) fn acknowledge_dirty(conn: &Connection, user: &str, ids: &[i64]) -> Result<()> {
    let mut statement =
        conn.prepare("DELETE FROM scan_cloud_dirty_buckets WHERE user_id=?1 AND id=?2")?;
    for id in ids {
        statement.execute(params![user, id])?;
    }
    // A deleted source no longer needs history after every corresponding old
    // bucket was repaired. Histories with outstanding events remain available.
    conn.execute(
        "DELETE FROM scan_cloud_sent_identities AS h WHERE h.user_id=?1
        AND NOT EXISTS(SELECT 1 FROM token_logs WHERE unique_key=h.source_key)
        AND NOT EXISTS(SELECT 1 FROM scan_cloud_dirty_buckets d WHERE d.user_id=h.user_id
            AND d.tool=h.tool AND d.model=h.model AND d.hour_bucket=h.hour_bucket
            AND d.machine_id=h.machine_id)",
        params![user],
    )?;
    Ok(())
}

/// collect_hours owns a separate WAL snapshot. Refuse a mixed snapshot if a
/// scanner inserted, deleted or revised a member before our write transaction.
pub(super) fn gateway_snapshot_matches(
    conn: &Connection,
    hours: &BTreeMap<String, Vec<gateway_cloud::HourRow>>,
    machine_id: &str,
) -> Result<bool> {
    let mut statement = conn.prepare(
        "SELECT id,sync_revision FROM token_logs
         WHERE substr(timestamp,1,13)||':00:00'=?1
           AND coalesce(nullif(machine_id,''),?2)=?2",
    )?;
    for (hour, rows) in hours {
        let expected: HashMap<i64, i64> = rows
            .iter()
            .filter(|r| !r.gateway)
            .map(|r| (r.id, r.sync_revision))
            .collect();
        let actual = statement
            .query_map(params![hour, machine_id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<Result<HashMap<_, _>>>()?;
        if actual != expected {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Reconcile old keys against the actual payload: a live aggregate wins over
/// any queued delete, and gateway-covered keys always use merged membership.
pub(super) fn repair_payloads(
    dirty: &DirtySnapshot,
    hours: &BTreeMap<String, Vec<gateway_cloud::HourRow>>,
    gateway_deferred: bool,
    user: &str,
    logs: &mut Vec<serde_json::Value>,
    deletes: &mut Vec<String>,
    cost: &dyn Fn(&gateway_cloud::HourRow) -> f64,
) {
    for bucket in &dirty.buckets {
        let unique_key = bucket.unique_key();
        if let Some(rows) = hours.get(&bucket.hour_bucket) {
            if gateway_deferred {
                continue;
            }
            let aggregates = gateway_cloud::aggregate_hour(&bucket.hour_bucket, rows, cost);
            if let Some(aggregate) = aggregates
                .into_iter()
                .find(|a| a.unique_key() == unique_key)
            {
                if !logs.iter().any(|v| {
                    v.get("unique_key").and_then(serde_json::Value::as_str) == Some(&unique_key)
                }) {
                    logs.push(aggregate.payload(user));
                }
                continue;
            }
        }
        if !logs
            .iter()
            .any(|v| v.get("unique_key").and_then(serde_json::Value::as_str) == Some(&unique_key))
        {
            deletes.push(unique_key);
        }
    }
    deletes.sort();
    deletes.dedup();
    deletes.retain(|key| {
        !logs
            .iter()
            .any(|v| v.get("unique_key").and_then(serde_json::Value::as_str) == Some(key))
    });
}

#[cfg(test)]
#[path = "scanner_sync_tests.rs"]
mod tests;
