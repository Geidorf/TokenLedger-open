//! Local backup and migration (contract `local-backup-v1`).
//!
//! One passphrase-sealed file carries what a user set up and recorded on a
//! computer: the scanned ledger, the gateway's request accounting, settings,
//! budgets, gateway providers and routing groups, the price table and quota
//! alert choices. It is sealed like the external gateway's sync files
//! (PBKDF2-HMAC-SHA256 + AES-256-GCM, `peer_sync::backup`), under its own
//! format name so neither app mistakes one for the other.
//!
//! - No secret goes into a backup: provider API keys, the gateway's local
//!   token, WebDAV and cloud credentials stay in this computer's keychain. A
//!   restored provider that needs a key says so.
//! - Restoring always previews first and merges: ledger rows by the scanner's
//!   `unique_key`, gateway rows by their accounting identity, providers,
//!   routing groups and budget rules by id. Rows already here always win;
//!   for setup items the user picks which side wins.
//! - Before anything is written, the current data is copied to a local
//!   snapshot folder, so a restore can be undone by hand.

pub mod auto;
pub mod health;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Local, Utc};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app_paths::AppContext;
use crate::budget::{self, BudgetRule, BudgetSettings};
use crate::gateway::{
    accounting, AuthMode, Gateway, LedgerRecord, ProviderRecord, RoutingGroup, SetProviderKeyInput,
};
use crate::peer_sync::backup as seal;
use crate::quota::alerts::{self, QuotaAlertSettings};
use crate::settings::{self, AppSettings};
use crate::{cache, db};

/// The sealed envelope's `format`.
pub const FORMAT: &str = "tokenledger-backup";
/// File name extension of a backup.
pub const EXTENSION: &str = "tlbackup";
const KIND: &str = "tokenledger-backup-bundle";
const SCHEMA: u32 = 1;
/// PBKDF2 rounds for files this build seals.
pub const ITERATIONS: u32 = 600_000;
const MAX_SEALED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_PLAIN_BYTES: u64 = 1024 * 1024 * 1024;
pub const MIN_PASSPHRASE_CHARS: usize = 8;
const MAX_PASSPHRASE_BYTES: usize = 1024;
const SNAPSHOT_DIR: &str = "backups";
const SNAPSHOT_PREFIX: &str = "pre-restore-";
const SNAPSHOTS_KEPT: usize = 3;
const LEDGER_TABLE: &str = "token_logs";
/// Where the scanner keeps each cumulative source's baseline and reset
/// generation; without it a restored ledger would re-derive both from the rows
/// and reuse dedupe keys after the next reset.
const CUMULATIVE_TABLE: &str = "scan_cumulative_state";
/// Config files copied into a pre-restore snapshot, relative to the app dir.
const SNAPSHOT_FILES: [&str; 7] = [
    "app_settings.json",
    "budget_settings.json",
    "quota_alert_settings.json",
    "prices.json",
    "prices.overrides-state.json",
    "gateway/providers-v1.json",
    "gateway/routing-v1.json",
];

/// Serialises exports, restores and repairs: two of them at once would
/// snapshot or seal a half-written state.
static BUSY: Mutex<()> = Mutex::new(());

pub(crate) fn busy_lock() -> std::sync::MutexGuard<'static, ()> {
    BUSY.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The scanned ledger as columns and rows, so a newer schema's extra columns
/// travel along and an older build simply leaves them out.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerTable {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

/// The source computer's gateway history boundary
/// (`accounting::Coverage`), so a restore keeps protecting hours it may lack.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GatewayCoverage {
    pub complete_from_utc: Option<String>,
    pub import_pending: bool,
}

/// The decrypted content of a backup.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Bundle {
    pub kind: String,
    pub schema: u32,
    /// UTC RFC 3339.
    pub created: String,
    pub app_version: String,
    /// The machine id the ledger rows of this computer carry.
    pub machine: String,
    pub ledger: LedgerTable,
    /// The scanner's cumulative-source state, restored with the ledger.
    pub scan_cumulative: LedgerTable,
    pub gateway_requests: Vec<LedgerRecord>,
    /// How complete the gateway's history was on the source computer. `None`
    /// (a bundle without it) is treated as unknown before `created`.
    pub gateway_coverage: Option<GatewayCoverage>,
    pub settings: Option<Value>,
    pub budgets: Option<BudgetSettings>,
    pub providers: Vec<ProviderRecord>,
    pub routing_groups: Vec<RoutingGroup>,
    /// The effective price table as the price editor shows it.
    pub prices: Option<Value>,
    pub quota_alerts: Option<QuotaAlertSettings>,
}

fn sql_to_json(value: SqlValue) -> Value {
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(number) => Value::from(number),
        SqlValue::Real(number) => serde_json::Number::from_f64(number)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        SqlValue::Text(text) => Value::String(text),
        // The ledger has no blob columns; one added later is not carried.
        SqlValue::Blob(_) => Value::Null,
    }
}

fn json_to_sql(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        Value::Number(number) => number
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| number.as_f64().map(SqlValue::Real))
            .unwrap_or(SqlValue::Null),
        Value::String(text) => SqlValue::Text(text.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

pub(crate) fn table_columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(columns)
}

fn quoted(columns: &[String]) -> String {
    columns
        .iter()
        .map(|column| format!("\"{}\"", column.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(",")
}

fn read_table(conn: &Connection, table: &str) -> Result<LedgerTable, String> {
    let columns: Vec<String> = table_columns(conn, table)
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|column| column != "id")
        .collect();
    if columns.is_empty() {
        return Ok(LedgerTable::default());
    }
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM {table} ORDER BY rowid",
            quoted(&columns)
        ))
        .map_err(|error| error.to_string())?;
    let width = columns.len();
    let rows = stmt
        .query_map([], |row| {
            (0..width)
                .map(|index| row.get::<_, SqlValue>(index).map(sql_to_json))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("读取账本失败：{error}"))?;
    Ok(LedgerTable { columns, rows })
}

/// Both tables from one read snapshot: a scan committing in between would
/// otherwise pair older rows with a newer baseline, and the tokens between
/// them would never be recorded after a restore.
fn read_ledger(db_path: &Path) -> Result<(LedgerTable, LedgerTable), String> {
    let mut conn = db::get_connection(db_path).map_err(|error| error.to_string())?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let tables = (
        read_table(&tx, LEDGER_TABLE)?,
        read_table(&tx, CUMULATIVE_TABLE)?,
    );
    tx.commit().map_err(|error| error.to_string())?;
    Ok(tables)
}

/// Everything a backup of this computer holds right now.
pub fn collect(app: &AppContext, gateway: &Gateway) -> Result<Bundle, String> {
    let db_path = db::get_db_path(app);
    let settings = settings::load_settings_result(app)?;
    let (ledger, scan_cumulative) = read_ledger(&db_path)?;
    Ok(Bundle {
        kind: KIND.to_string(),
        schema: SCHEMA,
        created: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        machine: crate::commands::local_machine_id(),
        ledger,
        scan_cumulative,
        gateway_requests: accounting::read_all(gateway.dir())?,
        gateway_coverage: Some(
            accounting::coverage_of(gateway.dir())?
                .map(|coverage| GatewayCoverage {
                    complete_from_utc: coverage.complete_from_utc,
                    import_pending: coverage.import_pending,
                })
                .unwrap_or_default(),
        ),
        settings: Some(serde_json::to_value(settings).map_err(|error| error.to_string())?),
        budgets: Some(budget::load_settings(app.app_data_dir())),
        providers: gateway
            .list_providers()?
            .into_iter()
            .map(|view| view.record)
            .collect(),
        routing_groups: gateway.list_routing_groups(),
        prices: crate::commands::get_prices_impl(app).ok(),
        quota_alerts: Some(alerts::load_settings(app.app_data_dir())),
    })
}

pub(crate) fn check_passphrase(passphrase: &str) -> Result<(), String> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(format!("备份密码至少 {MIN_PASSPHRASE_CHARS} 个字符。"));
    }
    if passphrase.len() > MAX_PASSPHRASE_BYTES || passphrase.contains('\0') {
        return Err("备份密码过长或含有无效字符。".to_string());
    }
    Ok(())
}

/// Refuses a backup this build could not open again, before anything is
/// written or an older automatic backup is pruned.
pub(crate) fn check_sizes(
    plain: usize,
    sealed: usize,
    max_plain: u64,
    max_sealed: u64,
) -> Result<(), String> {
    if plain as u64 > max_plain || sealed as u64 > max_sealed {
        return Err(format!(
            "备份内容超过 {} MiB，这个版本无法再恢复它，已停止导出。",
            max_plain.min(max_sealed) / (1024 * 1024)
        ));
    }
    Ok(())
}

/// Seals `bundle`: compact JSON, zstd, then the envelope.
pub fn seal_bundle(bundle: &Bundle, passphrase: &str, iterations: u32) -> Result<Vec<u8>, String> {
    check_passphrase(passphrase)?;
    let json = serde_json::to_vec(bundle).map_err(|error| error.to_string())?;
    check_sizes(json.len(), 0, MAX_PLAIN_BYTES, MAX_SEALED_BYTES)?;
    let packed = zstd::encode_all(json.as_slice(), 3).map_err(|error| error.to_string())?;
    let sealed = seal::seal(&packed, passphrase, FORMAT, iterations)?;
    check_sizes(json.len(), sealed.len(), MAX_PLAIN_BYTES, MAX_SEALED_BYTES)?;
    Ok(sealed)
}

fn open_error(error: seal::OpenError) -> String {
    match error {
        seal::OpenError::NotSealed => "这个文件不是 TokenLedger 备份。".to_string(),
        seal::OpenError::Corrupt => "备份文件已损坏或不完整。".to_string(),
        seal::OpenError::Newer => "这个备份由更新版本的 TokenLedger 生成，请先升级。".to_string(),
        seal::OpenError::Passphrase => "备份密码不对，或文件已被改动。".to_string(),
        seal::OpenError::TooManyKeys => "备份文件的加密参数无效。".to_string(),
    }
}

/// Opens a sealed backup; the bundle must be one this build understands.
pub fn open_bundle(sealed: &[u8], passphrase: &str) -> Result<Bundle, String> {
    let packed = seal::open(sealed, passphrase, FORMAT).map_err(open_error)?;
    let mut json = Vec::new();
    zstd::stream::read::Decoder::new(packed.as_slice())
        .map_err(|_| "备份文件已损坏或不完整。".to_string())?
        .take(MAX_PLAIN_BYTES + 1)
        .read_to_end(&mut json)
        .map_err(|_| "备份文件已损坏或不完整。".to_string())?;
    if json.len() as u64 > MAX_PLAIN_BYTES {
        return Err("备份内容过大。".to_string());
    }
    let bundle: Bundle =
        serde_json::from_slice(&json).map_err(|_| "备份的内容无法识别。".to_string())?;
    if bundle.kind != KIND {
        return Err("备份的内容无法识别。".to_string());
    }
    if bundle.schema > SCHEMA {
        return Err("这个备份由更新版本的 TokenLedger 生成，请先升级。".to_string());
    }
    Ok(bundle)
}

/// SHA-256 of a sealed file, lowercase hex.
pub fn digest(sealed: &[u8]) -> String {
    crate::peer_sync::backup_digest(sealed)
}

pub(crate) fn read_sealed(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|_| "找不到这个备份文件。".to_string())?;
    if !metadata.is_file() {
        return Err("找不到这个备份文件。".to_string());
    }
    if metadata.len() > MAX_SEALED_BYTES {
        return Err("备份文件过大。".to_string());
    }
    fs::read(path).map_err(|error| format!("读取备份文件失败：{error}"))
}

/// Writes `bytes` next to `path` and renames it into place, owner-only.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension(format!("{EXTENSION}.tmp"));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = options
        .open(&tmp)
        .and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .and_then(|_| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|error| format!("写入备份文件失败：{error}"))
}

/// Where backups go unless the user picks a folder.
pub fn default_dir(app: &AppContext) -> PathBuf {
    dirs::document_dir()
        .map(|dir| dir.join("TokenLedger Backups"))
        .unwrap_or_else(|| app.app_data_dir().join(SNAPSHOT_DIR).join("exports"))
}

/// The folder the user typed, which must be absolute.
pub(crate) fn backup_dir(raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    let path = PathBuf::from(raw);
    if raw.is_empty() || !path.is_absolute() || raw.contains('\0') {
        return Err("请填写备份文件夹的完整路径。".to_string());
    }
    Ok(path)
}

pub(crate) fn file_name(prefix: &str, at: DateTime<Local>) -> String {
    format!("{prefix}{}.{EXTENSION}", at.format("%Y%m%d-%H%M%S"))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub bytes: u64,
    pub ledger_rows: usize,
    pub gateway_requests: usize,
    pub providers: usize,
    pub routing_groups: usize,
}

/// Seals a backup of this computer into `dir` under `prefix<time>.tlbackup`.
pub fn export_to(
    app: &AppContext,
    gateway: &Gateway,
    dir: &Path,
    prefix: &str,
    passphrase: &str,
    iterations: u32,
) -> Result<ExportResult, String> {
    check_passphrase(passphrase)?;
    let _guard = busy_lock();
    let bundle = collect(app, gateway)?;
    let sealed = seal_bundle(&bundle, passphrase, iterations)?;
    fs::create_dir_all(dir).map_err(|error| format!("创建备份文件夹失败：{error}"))?;
    let mut path = dir.join(file_name(prefix, Local::now()));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!(
            "{}-{n}.{EXTENSION}",
            file_name(prefix, Local::now()).trim_end_matches(&format!(".{EXTENSION}"))
        ));
        n += 1;
    }
    write_private(&path, &sealed)?;
    Ok(ExportResult {
        path: path.to_string_lossy().to_string(),
        bytes: sealed.len() as u64,
        ledger_rows: bundle.ledger.rows.len(),
        gateway_requests: bundle.gateway_requests.len(),
        providers: bundle.providers.len(),
        routing_groups: bundle.routing_groups.len(),
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    /// Local RFC 3339 modification time.
    pub modified: String,
}

/// Backups in `dir`, newest first.
pub fn list_files(dir: &Path) -> Result<Vec<BackupFile>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取备份文件夹失败：{error}")),
    };
    let mut files: Vec<(std::time::SystemTime, BackupFile)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some(EXTENSION) {
                return None;
            }
            let metadata = entry.metadata().ok().filter(|meta| meta.is_file())?;
            let modified = metadata.modified().ok()?;
            Some((
                modified,
                BackupFile {
                    path: path.to_string_lossy().to_string(),
                    name: entry.file_name().to_string_lossy().to_string(),
                    bytes: metadata.len(),
                    modified: DateTime::<Local>::from(modified)
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
                },
            ))
        })
        .collect();
    files.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    Ok(files.into_iter().map(|(_, file)| file).collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    /// Not on this computer.
    New,
    /// The same here.
    Same,
    /// On this computer with other content.
    Differs,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDiff {
    pub id: String,
    pub name: String,
    pub status: ItemStatus,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowCounts {
    pub total: usize,
    /// Rows this computer does not have yet.
    pub new: usize,
    /// Rows already here (the same `unique_key` or accounting identity).
    pub known: usize,
    pub first: Option<String>,
    pub last: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// SHA-256 of the sealed file read; restoring hands it back so a file
    /// swapped after the preview is refused.
    pub digest: String,
    pub created: String,
    pub app_version: String,
    pub machine: String,
    pub same_machine: bool,
    pub ledger: RowCounts,
    /// Gateway requests only restore onto the computer that made them: the
    /// cloud counts them under this computer's id, so another computer's
    /// requests would be uploaded a second time as its own.
    pub gateway_requests_restorable: bool,
    pub gateway_requests: RowCounts,
    pub providers: Vec<ItemDiff>,
    /// Providers the backup would add or change that have no API key here.
    pub providers_without_key: Vec<String>,
    pub routing_groups: Vec<ItemDiff>,
    pub budgets: Vec<ItemDiff>,
    pub settings: Option<ItemStatus>,
    pub prices: Option<ItemStatus>,
    pub quota_alerts: Option<ItemStatus>,
}

fn status_of<T: PartialEq>(local: Option<&T>, incoming: &T) -> ItemStatus {
    match local {
        None => ItemStatus::New,
        Some(local) if local == incoming => ItemStatus::Same,
        Some(_) => ItemStatus::Differs,
    }
}

fn unique_key_index(columns: &[String]) -> Result<usize, String> {
    columns
        .iter()
        .position(|column| column == "unique_key")
        .ok_or_else(|| "备份里的账本缺少去重键。".to_string())
}

fn ledger_counts(db_path: &Path, table: &LedgerTable) -> Result<RowCounts, String> {
    let mut counts = RowCounts {
        total: table.rows.len(),
        ..RowCounts::default()
    };
    if table.rows.is_empty() {
        return Ok(counts);
    }
    let key = unique_key_index(&table.columns)?;
    let conn = db::get_connection(db_path).map_err(|error| error.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT 1 FROM {LEDGER_TABLE} WHERE unique_key = ?1"
        ))
        .map_err(|error| error.to_string())?;
    for row in &table.rows {
        let Some(Value::String(unique_key)) = row.get(key) else {
            continue;
        };
        if stmt
            .exists([unique_key])
            .map_err(|error| error.to_string())?
        {
            counts.known += 1;
        }
    }
    counts.new = counts.total - counts.known;
    if let Some(at) = table
        .columns
        .iter()
        .position(|column| column == "timestamp")
    {
        let times = table
            .rows
            .iter()
            .filter_map(|row| row.get(at).and_then(Value::as_str));
        counts.first = times.clone().min().map(str::to_string);
        counts.last = times.max().map(str::to_string);
    }
    Ok(counts)
}

fn gateway_counts(gateway: &Gateway, records: &[LedgerRecord]) -> Result<RowCounts, String> {
    let known = accounting::count_known(gateway.dir(), records)?;
    Ok(RowCounts {
        total: records.len(),
        new: records.len().saturating_sub(known),
        known,
        first: records.iter().map(|record| record.ts.clone()).min(),
        last: records.iter().map(|record| record.ts.clone()).max(),
    })
}

fn settings_status(app: &AppContext, incoming: &Value) -> Result<ItemStatus, String> {
    let current = settings::load_settings_result(app)?;
    let incoming: AppSettings = serde_json::from_value(incoming.clone())
        .map_err(|_| "备份里的设置无法识别。".to_string())?;
    let restored = settings::restored_settings(&current, incoming);
    let same = serde_json::to_value(&restored).ok() == serde_json::to_value(&current).ok();
    Ok(if same {
        ItemStatus::Same
    } else {
        ItemStatus::Differs
    })
}

fn provider_needs_key(gateway: &Gateway, record: &ProviderRecord) -> Result<bool, String> {
    if record.auth_mode == AuthMode::None {
        return Ok(false);
    }
    Ok(!gateway
        .list_providers()?
        .iter()
        .any(|view| view.record.id == record.id && view.has_key))
}

fn same_machine(bundle: &Bundle) -> bool {
    !bundle.machine.is_empty() && bundle.machine == crate::commands::local_machine_id()
}

/// What restoring `bundle` here would do, item by item.
pub fn preview(
    app: &AppContext,
    gateway: &Gateway,
    bundle: &Bundle,
    digest: String,
) -> Result<Preview, String> {
    let db_path = db::get_db_path(app);
    let local_providers: BTreeMap<String, ProviderRecord> = gateway
        .list_providers()?
        .into_iter()
        .map(|view| (view.record.id.clone(), view.record))
        .collect();
    let local_groups: BTreeMap<String, RoutingGroup> = gateway
        .list_routing_groups()
        .into_iter()
        .map(|group| (group.id.clone(), group))
        .collect();
    let local_budgets: BTreeMap<String, BudgetRule> = budget::load_settings(app.app_data_dir())
        .rules
        .into_iter()
        .map(|rule| (rule.id.clone(), rule))
        .collect();
    let providers: Vec<ItemDiff> = bundle
        .providers
        .iter()
        .map(|record| ItemDiff {
            id: record.id.clone(),
            name: record.name.clone(),
            status: status_of(local_providers.get(&record.id), record),
        })
        .collect();
    let mut providers_without_key = Vec::new();
    for (record, diff) in bundle.providers.iter().zip(&providers) {
        if diff.status != ItemStatus::Same && provider_needs_key(gateway, record)? {
            providers_without_key.push(record.id.clone());
        }
    }
    let current_prices = crate::commands::get_prices_impl(app).ok();
    let prices = bundle.prices.as_ref().map(|prices| {
        if current_prices.as_ref() == Some(prices) {
            ItemStatus::Same
        } else {
            ItemStatus::Differs
        }
    });
    Ok(Preview {
        digest,
        created: bundle.created.clone(),
        app_version: bundle.app_version.clone(),
        machine: bundle.machine.clone(),
        same_machine: same_machine(bundle),
        ledger: ledger_counts(&db_path, &bundle.ledger)?,
        gateway_requests_restorable: same_machine(bundle),
        gateway_requests: gateway_counts(gateway, &bundle.gateway_requests)?,
        providers,
        providers_without_key,
        routing_groups: bundle
            .routing_groups
            .iter()
            .map(|group| ItemDiff {
                id: group.id.clone(),
                name: group.name.clone(),
                status: status_of(local_groups.get(&group.id), group),
            })
            .collect(),
        budgets: bundle
            .budgets
            .iter()
            .flat_map(|budgets| budgets.rules.iter())
            .map(|rule| ItemDiff {
                id: rule.id.clone(),
                name: rule.id.clone(),
                status: status_of(local_budgets.get(&rule.id), rule),
            })
            .collect(),
        settings: bundle
            .settings
            .as_ref()
            .map(|incoming| settings_status(app, incoming))
            .transpose()?,
        prices,
        quota_alerts: bundle.quota_alerts.as_ref().map(|incoming| {
            let incoming = incoming.clone().sanitized();
            if alerts::load_settings(app.app_data_dir()) == incoming {
                ItemStatus::Same
            } else {
                ItemStatus::Differs
            }
        }),
    })
}

/// Which parts of a backup to restore.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Sections {
    pub ledger: bool,
    pub gateway_requests: bool,
    pub settings: bool,
    pub budgets: bool,
    pub providers: bool,
    pub routing_groups: bool,
    pub prices: bool,
    pub quota_alerts: bool,
}

/// Which side wins for a provider, routing group or budget rule that exists
/// on both. Ledger rows already here always win.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Conflict {
    #[default]
    KeepLocal,
    UseBackup,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    /// The pre-restore snapshot folder.
    pub snapshot: String,
    pub ledger_added: usize,
    pub gateway_added: usize,
    pub providers_added: usize,
    pub providers_replaced: usize,
    /// Restored providers that need their API key entered on this computer.
    pub providers_need_key: Vec<String>,
    pub groups_added: usize,
    pub groups_replaced: usize,
    /// Groups the gateway refused, with the reason.
    pub groups_skipped: Vec<String>,
    pub budgets_added: usize,
    pub budgets_replaced: usize,
    pub settings_restored: bool,
    pub prices_restored: bool,
    pub quota_alerts_restored: bool,
    /// Settings were written; some only take effect after a restart.
    pub restart_suggested: bool,
}

/// Creates `dir` (and missing parents) readable by this user only.
fn private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

fn vacuum_into(source: &Path, target: &Path) -> Result<(), String> {
    // VACUUM INTO accepts an empty file; creating it first keeps the copy
    // owner-only instead of following the umask.
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(target).map_err(|error| error.to_string())?;
    let conn = Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Copies the data a restore may change into
/// `<app dir>/backups/pre-restore-<time>/` and keeps the newest few.
pub fn snapshot(app: &AppContext, gateway_dir: &Path) -> Result<PathBuf, String> {
    let root = app.app_data_dir().join(SNAPSHOT_DIR);
    let dir = root.join(format!(
        "{SNAPSHOT_PREFIX}{}",
        Local::now().format("%Y%m%d-%H%M%S-%3f")
    ));
    private_dir(&root)
        .and_then(|_| private_dir(&dir.join("gateway")))
        .map_err(|error| format!("创建恢复前快照失败：{error}"))?;
    let db_path = db::get_db_path(app);
    if db_path.exists() {
        vacuum_into(&db_path, &dir.join("tokenboard.db"))
            .map_err(|error| format!("保存恢复前的账本快照失败：{error}"))?;
    }
    let accounting_file = gateway_dir.join(accounting::FILE);
    if accounting_file.exists() {
        vacuum_into(
            &accounting_file,
            &dir.join("gateway").join(accounting::FILE),
        )
        .map_err(|error| format!("保存恢复前的网关记账快照失败：{error}"))?;
    }
    for name in SNAPSHOT_FILES {
        let source = match name.strip_prefix("gateway/") {
            Some(rest) => gateway_dir.join(rest),
            None => app.app_data_dir().join(name),
        };
        if source.is_file() {
            fs::copy(&source, dir.join(name))
                .map_err(|error| format!("保存恢复前快照失败：{error}"))?;
        }
    }
    prune_snapshots(&root);
    Ok(dir)
}

fn prune_snapshots(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with(SNAPSHOT_PREFIX))
        .collect();
    names.sort();
    let excess = names.len().saturating_sub(SNAPSHOTS_KEPT);
    for name in names.into_iter().take(excess) {
        let _ = fs::remove_dir_all(root.join(name));
    }
}

fn import_ledger(db_path: &Path, table: &LedgerTable) -> Result<usize, String> {
    if table.rows.is_empty() {
        return Ok(0);
    }
    unique_key_index(&table.columns)?;
    let mut conn = db::get_connection(db_path).map_err(|error| error.to_string())?;
    let local: BTreeSet<String> = table_columns(&conn, LEDGER_TABLE)
        .map_err(|error| error.to_string())?
        .into_iter()
        .collect();
    // Columns this build does not have are dropped; `id` is never carried.
    let picked: Vec<(usize, String)> = table
        .columns
        .iter()
        .enumerate()
        .filter(|(_, column)| column.as_str() != "id" && local.contains(column.as_str()))
        .map(|(index, column)| (index, column.clone()))
        .collect();
    let names: Vec<String> = picked.iter().map(|(_, name)| name.clone()).collect();
    let placeholders = vec!["?"; names.len()].join(",");
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut added = 0;
    {
        let mut stmt = tx
            .prepare(&format!(
                "INSERT OR IGNORE INTO {LEDGER_TABLE} ({}) VALUES ({placeholders})",
                quoted(&names)
            ))
            .map_err(|error| error.to_string())?;
        for row in &table.rows {
            let values: Vec<SqlValue> = picked
                .iter()
                .map(|(index, _)| row.get(*index).map_or(SqlValue::Null, json_to_sql))
                .collect();
            match stmt.execute(params_from_iter(values)) {
                Ok(changed) => added += changed,
                // A row the schema rejects (a NOT NULL column missing from an
                // older backup) is skipped; the rest still comes in.
                Err(rusqlite::Error::SqliteFailure(error, _))
                    if error.code == rusqlite::ErrorCode::ConstraintViolation => {}
                Err(error) => return Err(format!("写入账本失败：{error}")),
            }
        }
    }
    tx.commit()
        .map_err(|error| format!("写入账本失败：{error}"))?;
    Ok(added)
}

/// Restores the scanner's cumulative-source state: a key this computer lacks
/// is added, and one it has is replaced by a later reset generation, or within
/// the same generation by a higher baseline. Totals only grow within a
/// generation and the restored ledger holds the rows up to the higher one, so
/// the next scan continues from there instead of counting them again or
/// reusing a dedupe key.
fn import_cumulative(db_path: &Path, table: &LedgerTable) -> Result<(), String> {
    if table.rows.is_empty() || !table.columns.iter().any(|column| column == "unique_key") {
        return Ok(());
    }
    let mut conn = db::get_connection(db_path).map_err(|error| error.to_string())?;
    let local: BTreeSet<String> = table_columns(&conn, CUMULATIVE_TABLE)
        .map_err(|error| error.to_string())?
        .into_iter()
        .collect();
    let picked: Vec<(usize, String)> = table
        .columns
        .iter()
        .enumerate()
        .filter(|(_, column)| local.contains(column.as_str()))
        .map(|(index, column)| (index, column.clone()))
        .collect();
    let names: Vec<String> = picked.iter().map(|(_, name)| name.clone()).collect();
    let newer = if names.iter().any(|name| name == "generation") {
        let updates = names
            .iter()
            .filter(|name| name.as_str() != "unique_key")
            .map(|name| format!("\"{name}\"=excluded.\"{name}\""))
            .collect::<Vec<_>>()
            .join(",");
        let totals = [
            "input_tokens",
            "output_tokens",
            "cached_tokens",
            "cache_write_tokens",
        ];
        let same_generation = if totals
            .iter()
            .all(|total| names.iter().any(|name| name == total))
        {
            let sum = |side: &str| {
                totals
                    .iter()
                    .map(|total| format!("{side}.{total}"))
                    .collect::<Vec<_>>()
                    .join("+")
            };
            format!(
                " OR (excluded.generation = {CUMULATIVE_TABLE}.generation AND {} > {})",
                sum("excluded"),
                sum(CUMULATIVE_TABLE)
            )
        } else {
            String::new()
        };
        format!(
            " ON CONFLICT(unique_key) DO UPDATE SET {updates}
              WHERE excluded.generation > {CUMULATIVE_TABLE}.generation{same_generation}"
        )
    } else {
        " ON CONFLICT(unique_key) DO NOTHING".to_string()
    };
    let sql = format!(
        "INSERT INTO {CUMULATIVE_TABLE} ({}) VALUES ({}){newer}",
        quoted(&names),
        vec!["?"; names.len()].join(",")
    );
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    {
        let mut stmt = tx.prepare(&sql).map_err(|error| error.to_string())?;
        for row in &table.rows {
            let values: Vec<SqlValue> = picked
                .iter()
                .map(|(index, _)| row.get(*index).map_or(SqlValue::Null, json_to_sql))
                .collect();
            match stmt.execute(params_from_iter(values)) {
                Ok(_) => {}
                Err(rusqlite::Error::SqliteFailure(error, _))
                    if error.code == rusqlite::ErrorCode::ConstraintViolation => {}
                Err(error) => return Err(format!("写入扫描状态失败：{error}")),
            }
        }
    }
    tx.commit()
        .map_err(|error| format!("写入扫描状态失败：{error}"))
}

fn restore_providers(
    gateway: &Gateway,
    incoming: &[ProviderRecord],
    conflict: Conflict,
    result: &mut ApplyResult,
) -> Result<(), String> {
    let before: BTreeMap<String, ProviderRecord> = gateway
        .list_providers()?
        .into_iter()
        .map(|view| (view.record.id.clone(), view.record))
        .collect();
    for record in incoming {
        let previous = before.get(&record.id);
        match previous {
            Some(previous) if previous == record => continue,
            Some(_) if conflict == Conflict::KeepLocal => continue,
            _ => {}
        }
        if let Some(previous) = previous {
            if !crate::peer_sync::same_origin(&previous.base_url, &record.base_url) {
                // A key set for the old host must not follow the restored
                // address to a host it was never meant for. It goes before
                // the new address is published, so no request in between
                // pairs the two, and a failure leaves the old address.
                gateway.set_provider_key(SetProviderKeyInput {
                    id: record.id.clone(),
                    key: String::new(),
                })?;
            }
        }
        gateway.upsert_provider(record.clone())?;
        if previous.is_some() {
            result.providers_replaced += 1;
        } else {
            result.providers_added += 1;
        }
        if provider_needs_key(gateway, record)? {
            result.providers_need_key.push(record.id.clone());
        }
    }
    Ok(())
}

fn restore_groups(
    gateway: &Gateway,
    incoming: &[RoutingGroup],
    conflict: Conflict,
    result: &mut ApplyResult,
) {
    let before: BTreeMap<String, RoutingGroup> = gateway
        .list_routing_groups()
        .into_iter()
        .map(|group| (group.id.clone(), group))
        .collect();
    let mut pending: Vec<&RoutingGroup> = incoming
        .iter()
        .filter(|group| match before.get(&group.id) {
            Some(local) if local == *group => false,
            Some(_) => conflict == Conflict::UseBackup,
            None => true,
        })
        .collect();
    // A group may name another group as a member; retry until a pass makes
    // no progress, so the order inside the backup does not matter.
    loop {
        let mut failed = Vec::new();
        let mut errors = Vec::new();
        for group in &pending {
            match gateway.upsert_routing_group((*group).clone()) {
                Ok(_) if before.contains_key(&group.id) => result.groups_replaced += 1,
                Ok(_) => result.groups_added += 1,
                Err(error) => {
                    failed.push(*group);
                    errors.push(format!("{}：{error}", group.id));
                }
            }
        }
        if failed.is_empty() || failed.len() == pending.len() {
            result.groups_skipped = errors;
            break;
        }
        pending = failed;
    }
}

fn restore_budgets(
    app: &AppContext,
    incoming: &BudgetSettings,
    conflict: Conflict,
    result: &mut ApplyResult,
) -> Result<(), String> {
    let mut current = budget::load_settings(app.app_data_dir());
    for rule in &incoming.rules {
        match current.rules.iter_mut().find(|local| local.id == rule.id) {
            Some(local) if local == rule => {}
            Some(local) => {
                if conflict == Conflict::UseBackup {
                    *local = rule.clone();
                    result.budgets_replaced += 1;
                }
            }
            None => {
                current.rules.push(rule.clone());
                result.budgets_added += 1;
            }
        }
    }
    if conflict == Conflict::UseBackup {
        current.notify = incoming.notify;
    } else {
        current.notify |= incoming.notify;
    }
    budget::save_settings(app.app_data_dir(), &current.sanitized())
}

/// Restores the picked `sections` of `bundle`, after a snapshot of what is
/// here now.
pub fn apply(
    app: &AppContext,
    gateway: &Gateway,
    bundle: &Bundle,
    sections: &Sections,
    conflict: Conflict,
) -> Result<ApplyResult, String> {
    let _guard = busy_lock();
    let mut result = ApplyResult {
        snapshot: snapshot(app, gateway.dir())?.to_string_lossy().to_string(),
        ..ApplyResult::default()
    };
    let db_path = db::get_db_path(app);
    if sections.ledger {
        result.ledger_added = import_ledger(&db_path, &bundle.ledger)?;
        import_cumulative(&db_path, &bundle.scan_cumulative)?;
    }
    if sections.gateway_requests && same_machine(bundle) {
        let created = bundle.created.clone();
        let boundary = match &bundle.gateway_coverage {
            Some(coverage) if coverage.import_pending => Some(created),
            Some(coverage) => coverage.complete_from_utc.clone(),
            None => Some(created),
        };
        result.gateway_added =
            accounting::import(gateway.dir(), &bundle.gateway_requests, boundary.as_deref())?;
    }
    // Providers before groups: a group's members must name known providers.
    if sections.providers {
        restore_providers(gateway, &bundle.providers, conflict, &mut result)?;
    }
    if sections.routing_groups {
        restore_groups(gateway, &bundle.routing_groups, conflict, &mut result);
    }
    if sections.budgets {
        if let Some(budgets) = &bundle.budgets {
            restore_budgets(app, budgets, conflict, &mut result)?;
        }
    }
    if sections.settings {
        if let Some(incoming) = &bundle.settings {
            let incoming: AppSettings = serde_json::from_value(incoming.clone())
                .map_err(|_| "备份里的设置无法识别。".to_string())?;
            settings::restore_backup_settings(app, incoming)?;
            result.settings_restored = true;
            result.restart_suggested = true;
        }
    }
    if sections.prices {
        if let Some(prices) = &bundle.prices {
            if crate::commands::get_prices_impl(app).ok().as_ref() != Some(prices) {
                crate::commands::save_prices_impl(app, prices.clone())?;
                result.prices_restored = true;
            }
        }
    }
    if sections.quota_alerts {
        if let Some(incoming) = &bundle.quota_alerts {
            alerts::save_settings(app.app_data_dir(), incoming)?;
            result.quota_alerts_restored = true;
        }
    }
    if result.ledger_added > 0 || result.gateway_added > 0 || result.prices_restored {
        cache::invalidate_all(&db_path);
    }
    Ok(result)
}

// ---- Tauri commands ----

pub(crate) const PASSPHRASE_ACCOUNT: &str = "local-backup:passphrase";

fn secrets() -> crate::gateway::KeyringSecrets {
    crate::gateway::KeyringSecrets
}

fn ensure_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("备份与恢复只允许主窗口调用。".to_string())
    }
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("备份任务异常结束：{error}"))?
}

fn emit_stats_updated(app_handle: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app_handle.emit(
        "stats-updated",
        serde_json::json!({ "source": "local-backup" }),
    );
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub default_dir: String,
    pub auto: auto::AutoView,
    pub repair: Option<health::RepairNotice>,
}

#[tauri::command]
pub fn local_backup_status(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<AppContext>>,
) -> Result<Status, String> {
    ensure_main(&window)?;
    Ok(Status {
        default_dir: default_dir(&app).to_string_lossy().to_string(),
        auto: auto::view(&app, &secrets())?,
        repair: health::last_repair(&app),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInput {
    pub dir: String,
    pub passphrase: String,
}

#[tauri::command]
pub async fn local_backup_export(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<AppContext>>,
    gateway: tauri::State<'_, Arc<Gateway>>,
    input: ExportInput,
) -> Result<ExportResult, String> {
    ensure_main(&window)?;
    let dir = backup_dir(&input.dir)?;
    let app = app.inner().clone();
    let gateway = gateway.inner().clone();
    blocking(move || {
        export_to(
            &app,
            &gateway,
            &dir,
            "TokenLedger-",
            &input.passphrase,
            ITERATIONS,
        )
    })
    .await
}

#[tauri::command]
pub fn local_backup_list(
    window: tauri::WebviewWindow,
    dir: String,
) -> Result<Vec<BackupFile>, String> {
    ensure_main(&window)?;
    list_files(&backup_dir(&dir)?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInput {
    pub path: String,
    pub passphrase: String,
}

fn open_path(input: &OpenInput) -> Result<(Bundle, String), String> {
    let path = PathBuf::from(input.path.trim());
    if !path.is_absolute() {
        return Err("请填写备份文件的完整路径。".to_string());
    }
    let sealed = read_sealed(&path)?;
    let digest = digest(&sealed);
    Ok((open_bundle(&sealed, &input.passphrase)?, digest))
}

#[tauri::command]
pub async fn local_backup_preview(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<AppContext>>,
    gateway: tauri::State<'_, Arc<Gateway>>,
    input: OpenInput,
) -> Result<Preview, String> {
    ensure_main(&window)?;
    let app = app.inner().clone();
    let gateway = gateway.inner().clone();
    blocking(move || {
        let (bundle, digest) = open_path(&input)?;
        preview(&app, &gateway, &bundle, digest)
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyInput {
    pub path: String,
    pub passphrase: String,
    pub digest: String,
    pub sections: Sections,
    #[serde(default)]
    pub conflict: Conflict,
}

#[tauri::command]
pub async fn local_backup_apply(
    window: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    app: tauri::State<'_, Arc<AppContext>>,
    gateway: tauri::State<'_, Arc<Gateway>>,
    settings_state: tauri::State<'_, Arc<Mutex<AppSettings>>>,
    input: ApplyInput,
) -> Result<ApplyResult, String> {
    ensure_main(&window)?;
    let app = app.inner().clone();
    let gateway = gateway.inner().clone();
    let state = settings_state.inner().clone();
    let result = blocking(move || {
        let (bundle, digest) = open_path(&OpenInput {
            path: input.path,
            passphrase: input.passphrase,
        })?;
        if !digest.eq_ignore_ascii_case(input.digest.trim()) {
            return Err("备份文件在预览之后变了，请重新预览再恢复。".to_string());
        }
        let result = apply(&app, &gateway, &bundle, &input.sections, input.conflict)?;
        if result.settings_restored {
            if let Ok(restored) = settings::load_settings_result(&app) {
                *state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = restored;
            }
        }
        Ok(result)
    })
    .await?;
    emit_stats_updated(&app_handle);
    if result.settings_restored {
        // Open settings pages reload, so a later edit does not save the
        // pre-restore values back over the restored ones.
        use tauri::Emitter;
        let _ = app_handle.emit(
            "settings-updated",
            serde_json::json!({ "source": "local-backup" }),
        );
    }
    Ok(result)
}

#[tauri::command]
pub fn local_backup_save_auto(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<AppContext>>,
    input: auto::SaveAutoInput,
) -> Result<auto::AutoView, String> {
    ensure_main(&window)?;
    auto::save(&app, &secrets(), input)
}

#[tauri::command]
pub async fn local_backup_run_auto_now(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<AppContext>>,
    gateway: tauri::State<'_, Arc<Gateway>>,
) -> Result<auto::AutoView, String> {
    ensure_main(&window)?;
    let app = app.inner().clone();
    let gateway = gateway.inner().clone();
    blocking(move || {
        auto::run_now(&app, &gateway, &secrets(), ITERATIONS)?;
        auto::view(&app, &secrets())
    })
    .await
}

#[tauri::command]
pub async fn local_backup_db_check(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<AppContext>>,
    gateway: tauri::State<'_, Arc<Gateway>>,
) -> Result<health::HealthReport, String> {
    ensure_main(&window)?;
    let app = app.inner().clone();
    let gateway_dir = gateway.dir().to_path_buf();
    blocking(move || Ok(health::check(&app, &gateway_dir))).await
}

#[tauri::command]
pub async fn local_backup_db_repair(
    window: tauri::WebviewWindow,
    app: tauri::State<'_, Arc<AppContext>>,
    gateway: tauri::State<'_, Arc<Gateway>>,
) -> Result<health::RepairOutcome, String> {
    ensure_main(&window)?;
    let app = app.inner().clone();
    let gateway_dir = gateway.dir().to_path_buf();
    blocking(move || health::repair(&app, &gateway_dir)).await
}

/// Quits the app so a rebuild scheduled for the next start runs, or
/// restored settings take effect everywhere. The user opens it again; a
/// relaunch from here could race the single-instance check.
#[tauri::command]
pub fn local_backup_quit(
    window: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    ensure_main(&window)?;
    app_handle.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests;
