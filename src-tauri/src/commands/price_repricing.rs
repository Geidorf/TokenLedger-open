//! Recoverable file-to-database commit for scanner price estimates only.
//! No rates or credentials enter the intent: UUID and exact file digests bind it.
use super::{price_overrides_digest, write_price_file, PRICE_OVERRIDES_FILE};
use crate::{app_paths::AppContext, cache, db};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
const INTENT_FILE: &str = "prices.repricing-intent-v1.json";
const RECEIPTS_SQL: &str = "CREATE TABLE IF NOT EXISTS price_repricing_receipts (
    intent_id TEXT PRIMARY KEY, previous_digest TEXT, next_digest TEXT,
    repriced INTEGER NOT NULL CHECK(repriced>=0))";
// Preserve the established scanner-only whitelist. Provider reported costs
// and the gateway ledger never enter this update. opencode/kilo/reasonix/
// hermes/workbuddy/qclaw can carry provider bills; never add them here.
// minimax remains in the existing whitelist: scanners discard its reported
// zero as unavailable and its ledger costs already come from price estimates.
const REPRICE_SQL: &str = "UPDATE token_logs SET cost_usd=NULL,sync_status=0
    WHERE tool IN ('claude','codex','trae','zcode','gemini','antigravity',
      'grok','kimi','kimidesktop','pi','dsh','deepseek','marvis','minimax','qwen','copilot')";

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct Intent {
    version: u32,
    id: String,
    previous_digest: Option<String>,
    next_digest: Option<String>,
}
#[derive(Default, Debug)]
pub(super) struct Recovery {
    pub repriced: usize,
    pub pending: bool,
    pub warning: Option<String>,
}

pub(super) fn file_digest(dir: &Path) -> Result<Option<String>, String> {
    match fs::read(dir.join(PRICE_OVERRIDES_FILE)) {
        Ok(bytes) => Ok(Some(price_overrides_digest(&bytes))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取价格提交状态失败：{e}")),
    }
}
fn uuid_v4() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}
pub(super) fn prepare(dir: &Path, next_bytes: Option<&[u8]>) -> Result<Intent, String> {
    let intent = Intent {
        version: 1,
        id: uuid_v4()?,
        previous_digest: file_digest(dir)?,
        next_digest: next_bytes.map(price_overrides_digest),
    };
    let bytes = serde_json::to_vec(&intent).map_err(|e| e.to_string())?;
    write_price_file(&dir.join(INTENT_FILE), &bytes)?;
    Ok(intent)
}
pub(super) fn matches_current(dir: &Path, intent: &Intent) -> Result<bool, String> {
    Ok(file_digest(dir)? == intent.next_digest)
}
fn read_intent(dir: &Path) -> Result<Option<Intent>, String> {
    let bytes = match fs::read(dir.join(INTENT_FILE)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取价格重算恢复意图失败：{e}")),
    };
    let intent: Intent = serde_json::from_slice(&bytes)
        .map_err(|_| "价格重算恢复意图损坏，请保留文件后联系支持。".to_string())?;
    if intent.version != 1 {
        return Err("价格重算恢复意图版本不受支持。".into());
    }
    Ok(Some(intent))
}
fn remove_intent(dir: &Path) -> Result<(), String> {
    match fs::remove_file(dir.join(INTENT_FILE)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    }
    #[cfg(not(windows))]
    fs::File::open(dir)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn reprice_once(app: &AppContext, intent: &Intent) -> Result<usize, String> {
    let path = db::get_db_path(app);
    db::init_db(&path).map_err(|e| e.to_string())?;
    let mut conn = db::get_connection(&path).map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    tx.execute_batch(RECEIPTS_SQL).map_err(|e| e.to_string())?;
    let receipt: Option<(Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT previous_digest,next_digest FROM price_repricing_receipts WHERE intent_id=?1",
            [&intent.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((previous, next)) = receipt {
        if previous != intent.previous_digest || next != intent.next_digest {
            return Err("价格重算回执与恢复意图不匹配。".into());
        }
        return Ok(0);
    }
    let repriced = tx.execute(REPRICE_SQL, []).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO price_repricing_receipts(intent_id,previous_digest,next_digest,repriced) VALUES(?1,?2,?3,?4)",params![intent.id,intent.previous_digest,intent.next_digest,repriced as i64]).map_err(|e|e.to_string())?;
    // Only the single current intent can still require an older receipt.
    tx.execute(
        "DELETE FROM price_repricing_receipts WHERE intent_id!=?1",
        [&intent.id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(repriced)
}

/// Caller owns PRICE_OVERRIDES_LOCK. No price load is performed here, avoiding
/// lock re-entry and database initialization recursion.
pub(super) fn recover(app: &AppContext) -> Recovery {
    recover_with_cleanup(app, &remove_intent)
}
fn recover_with_cleanup(
    app: &AppContext,
    cleanup: &dyn Fn(&Path) -> Result<(), String>,
) -> Recovery {
    let dir = app.app_data_dir();
    let intent = match read_intent(dir) {
        Ok(Some(i)) => i,
        Ok(None) => return Recovery::default(),
        Err(e) => {
            return Recovery {
                pending: true,
                warning: Some(e),
                ..Recovery::default()
            }
        }
    };
    let current = match file_digest(dir) {
        Ok(d) => d,
        Err(e) => {
            return Recovery {
                pending: true,
                warning: Some(e),
                ..Recovery::default()
            }
        }
    };
    if current != intent.next_digest {
        // Prepared but never installed, or replaced by a later external edit.
        // Never write the earlier price bytes back over the current file.
        let superseded = current != intent.previous_digest;
        let warning = cleanup(dir)
            .err()
            .map(|_| "价格未提交的恢复意图暂时无法清理；统计没有重算。".to_string())
            .or_else(|| {
                superseded.then(|| {
                    "价格文件已被后续修改，已取消旧的重算意图；当前价格文件保持不变。".into()
                })
            });
        return Recovery {
            warning,
            ..Recovery::default()
        };
    }
    // The rates reached disk even if the previous save returned an error.
    // Cache invalidation is separate from repricing so a DB failure cannot
    // keep a successfully saved table hidden behind stale cached statistics.
    cache::invalidate_all(&db::get_db_path(app));
    match reprice_once(app, &intent) {
        Ok(repriced) => Recovery {
            repriced,
            pending: false,
            warning: cleanup(dir).err().map(|_| {
                "价格已保存，统计重算已完成；恢复标记暂时无法清理，下次仅重试清理。".into()
            }),
        },
        Err(e) => {
            log::warn!("scanner price repricing pending: {e}");
            Recovery {
                pending: true,
                warning: Some(
                    "价格已保存，但历史估算费用重算未完成；再次保存相同价格或重启应用会自动重试。"
                        .into(),
                ),
                ..Recovery::default()
            }
        }
    }
}

#[cfg(test)]
#[path = "price_repricing_tests.rs"]
mod tests;
