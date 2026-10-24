//! 价格表在线更新（价格表 schema 2）。
//!
//! 应用内置一份价格表（`prices.json` + `prices.meta.json`）。在线更新从本仓库 `main`
//! 分支读取同样两份文件，校验通过、修订号比内置的新时缓存到应用数据目录的
//! `prices.feed.json`，之后作为「默认价」使用；用户覆盖仍叠加在它上面，优先级最高。
//!
//! - 自动检查默认开启，每 24 小时最多一次（启动后约 1 分钟首查）；可在设置页关闭或手动检查。
//! - 离线、请求失败或内容不合格时不改动现有缓存：有可用缓存就继续用，没有就用内置表。
//! - 缓存的修订号不比内置新（例如升级后内置表追上了），直接用内置表。
//! - 只下载价格表，不上传任何数据；请求只带应用版本号作为 User-Agent。
//! - 更新不重算、不改写已存金额：调价写在条目的 `history` 里，历史记录仍按当时的价格计
//!   （见 `price_schedule` 与 MODEL_PRICING.md「价格变动与历史记录」）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    default_prices, lock_price_overrides, price_schedule, PRICE_OVERRIDES_FILE, PRICE_RATE_FIELDS,
};
use crate::app_paths::AppContext;
use crate::{cache, db};

const FEED_PRICES_URL: &str =
    "https://raw.githubusercontent.com/Geidorf/TokenLedger-open/main/src-tauri/prices.json";
const FEED_META_URL: &str =
    "https://raw.githubusercontent.com/Geidorf/TokenLedger-open/main/src-tauri/prices.meta.json";
const BUNDLED_META_JSON: &str = include_str!("../../prices.meta.json");

const FEED_FILE: &str = "prices.feed.json";
const FEED_STATE_FILE: &str = "prices.feed-state.json";
/// 应用能读懂的价格表格式。在线表的 schema 更高时不接受，等应用升级。
pub(super) const SUPPORTED_SCHEMA: u64 = 2;
const CHECK_INTERVAL_SECONDS: i64 = 24 * 60 * 60;
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
const SCHEDULER_TICK: Duration = Duration::from_secs(60 * 60);
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_MODELS: usize = 4000;
const MAX_MODEL_KEY_CHARS: usize = 96;

/// 价格表的版本信息（`prices.meta.json`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct TableMeta {
    pub schema: u64,
    /// 每次改动价格表加 1；在线表只有修订号更大时才替代内置表。
    pub revision: u64,
    /// 最近一次对照官方价格页核验的日期（YYYY-MM-DD）。
    pub verified_at: String,
    /// 这一修订发布的日期（YYYY-MM-DD）。
    #[serde(default)]
    pub updated_at: Option<String>,
    /// 同一修订 `prices.json` 原始字节的 SHA-256（小写十六进制）。两份文件分开下载，
    /// CDN 缓存可能给出新 meta 配旧表，摘要不符就不采用。
    #[serde(default)]
    pub prices_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedFeed {
    meta: TableMeta,
    prices: Value,
    fetched_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct FeedState {
    #[serde(default = "default_true")]
    auto_update: bool,
    #[serde(default)]
    last_checked_at: Option<DateTime<Utc>>,
    #[serde(default)]
    last_error: Option<String>,
}

fn default_true() -> bool {
    true
}

/// 设置页与「预估费用」说明里显示的价格表来源。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceTableStatus {
    /// `bundled`（应用内置）或 `online`（在线更新）。
    pub source: &'static str,
    pub revision: u64,
    pub verified_at: String,
    pub updated_at: Option<String>,
    pub bundled_revision: u64,
    pub bundled_verified_at: String,
    /// 在线表下载到本机的时间；用内置表时为空。
    pub fetched_at: Option<String>,
    pub last_checked_at: Option<String>,
    pub last_error: Option<String>,
    pub auto_update: bool,
    /// 自定义了价格的型号数（覆盖文件里写了单价的条目）。
    pub override_models: usize,
}

pub(super) fn bundled_meta() -> TableMeta {
    serde_json::from_str(BUNDLED_META_JSON).expect("bundled prices.meta.json is valid")
}

/// 校验一张完整价格表（内置表与在线表同一规则）。
pub(super) fn validate_table(prices: &Value) -> Result<(), String> {
    let Some(models) = prices.as_object() else {
        return Err("价格表必须是 JSON 对象".to_string());
    };
    if models.is_empty() || models.len() > MAX_MODELS {
        return Err(format!("价格表型号数必须在 1 到 {MAX_MODELS} 之间"));
    }
    if !models.contains_key("default") {
        return Err("价格表缺少 default 兜底条目".to_string());
    }
    for (model, entry) in models {
        if model.trim().is_empty() || model.chars().count() > MAX_MODEL_KEY_CHARS {
            return Err(format!("型号键无效：{model}"));
        }
        if entry.get("_meta").is_some() {
            return Err(format!("{model}: 默认价格表不能带 _meta"));
        }
        if entry.get("input").and_then(Value::as_f64).is_none()
            || entry.get("output").and_then(Value::as_f64).is_none()
        {
            return Err(format!("{model}: 缺少输入或输出单价"));
        }
        price_schedule::validate_entry(model, entry)?;
    }
    Ok(())
}

fn validate_meta(meta: &TableMeta) -> Result<(), String> {
    if meta.schema == 0 || meta.schema > SUPPORTED_SCHEMA {
        return Err(format!(
            "在线价格表格式为 {}，本版本只支持到 {SUPPORTED_SCHEMA}，请升级应用",
            meta.schema
        ));
    }
    let date_ok = |date: &str| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok();
    if !date_ok(&meta.verified_at) || meta.updated_at.as_deref().is_some_and(|d| !date_ok(d)) {
        return Err("在线价格表的日期格式无效".to_string());
    }
    let digest_ok = meta.prices_sha256.as_deref().is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    });
    if !digest_ok {
        return Err("在线价格表的版本信息缺少 prices_sha256".to_string());
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let mut temp = PathBuf::from(path);
    temp.set_extension("json.tmp");
    fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    let renamed = fs::rename(&temp, path).map_err(|error| error.to_string());
    // 本进程写的文件可能与上次读取同一修改时间、同一长度，直接作废缓存。
    *USABLE_FEED_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    renamed
}

fn read_state(app_dir: &Path) -> FeedState {
    read_json(&app_dir.join(FEED_STATE_FILE)).unwrap_or(FeedState {
        auto_update: true,
        ..FeedState::default()
    })
}

/// 缓存文件的身份：路径、修改时间与长度。三者都没变就沿用上次读取与校验的结果。
type FeedFileKey = (PathBuf, Option<std::time::SystemTime>, u64);

/// `usable_feed` 的进程内缓存：每次统计都会加载价格，不必每次重读、重校验最大 2 MB 的表。
static USABLE_FEED_CACHE: Mutex<Option<(FeedFileKey, Option<CachedFeed>)>> = Mutex::new(None);

/// 状态文件的读改写都在这把锁里做：检查结束写回时不会盖掉用户刚改的自动更新开关。
static FEED_STATE_LOCK: Mutex<()> = Mutex::new(());

fn lock_feed_state() -> std::sync::MutexGuard<'static, ()> {
    FEED_STATE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 可用的在线表：格式受支持、内容校验通过，且修订号比内置表新。
fn usable_feed(app_dir: &Path, bundled: &TableMeta) -> Option<CachedFeed> {
    let path = app_dir.join(FEED_FILE);
    let metadata = fs::metadata(&path).ok()?;
    let key = (path.clone(), metadata.modified().ok(), metadata.len());
    let mut cache = USABLE_FEED_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let checked = match cache.as_ref() {
        Some((cached_key, feed)) if *cached_key == key && key.1.is_some() => feed.clone(),
        _ => {
            let feed = read_json::<CachedFeed>(&path).filter(|feed| {
                validate_meta(&feed.meta).is_ok() && validate_table(&feed.prices).is_ok()
            });
            *cache = Some((key, feed.clone()));
            feed
        }
    };
    checked.filter(|feed| feed.meta.revision > bundled.revision)
}

/// 用户覆盖之下的「默认价」：可用的在线表，否则内置表。
pub(super) fn effective_defaults(app_dir: &Path) -> Value {
    usable_feed(app_dir, &bundled_meta())
        .map(|feed| feed.prices)
        .unwrap_or_else(default_prices)
}

fn override_models(app_dir: &Path) -> usize {
    read_json::<Value>(&app_dir.join(PRICE_OVERRIDES_FILE))
        .and_then(|value| value.as_object().cloned())
        .map(|models| {
            models
                .values()
                .filter(|entry| {
                    PRICE_RATE_FIELDS
                        .iter()
                        .any(|field| entry.get(*field).is_some())
                })
                .count()
        })
        .unwrap_or(0)
}

pub(super) fn status(app_dir: &Path) -> PriceTableStatus {
    let bundled = bundled_meta();
    let state = read_state(app_dir);
    let feed = usable_feed(app_dir, &bundled);
    let (source, meta, fetched_at) = match &feed {
        Some(feed) => (
            "online",
            feed.meta.clone(),
            Some(feed.fetched_at.to_rfc3339()),
        ),
        None => ("bundled", bundled.clone(), None),
    };
    PriceTableStatus {
        source,
        revision: meta.revision,
        verified_at: meta.verified_at,
        updated_at: meta.updated_at,
        bundled_revision: bundled.revision,
        bundled_verified_at: bundled.verified_at,
        fetched_at,
        last_checked_at: state.last_checked_at.map(|at| at.to_rfc3339()),
        last_error: state.last_error,
        auto_update: state.auto_update,
        override_models: override_models(app_dir),
    }
}

/// 下载结果放进本机缓存的决定。拆出来以便不联网测试。
#[derive(Debug, PartialEq)]
enum FeedDecision {
    /// 修订号更新：写入缓存。
    Store,
    /// 不比现在用的新：什么都不改。
    UpToDate,
}

/// 核对下载到的一对文件。返回决定与解析后的表。
fn decide(
    current_revision: u64,
    meta: &TableMeta,
    prices_bytes: &[u8],
) -> Result<(FeedDecision, Value), String> {
    validate_meta(meta)?;
    if meta.prices_sha256.as_deref() != Some(sha256_hex(prices_bytes).as_str()) {
        return Err(
            "在线价格表与版本信息的摘要不一致（可能是 CDN 缓存未同步），这次不采用".to_string(),
        );
    }
    let prices: Value = serde_json::from_slice(prices_bytes)
        .map_err(|error| format!("在线价格表无法解析：{error}"))?;
    validate_table(&prices)?;
    let decision = if meta.revision > current_revision {
        FeedDecision::Store
    } else {
        FeedDecision::UpToDate
    };
    Ok((decision, prices))
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("网络请求失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("服务器返回 HTTP {status}"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("响应超过允许大小".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取响应失败：{error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("响应超过允许大小".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn fetch_feed() -> Result<(TableMeta, Vec<u8>), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("TokenLedger/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("创建网络客户端失败：{error}"))?;
    let meta: TableMeta = serde_json::from_slice(&fetch_bytes(&client, FEED_META_URL).await?)
        .map_err(|error| format!("在线价格表版本信息无法解析：{error}"))?;
    let prices = fetch_bytes(&client, FEED_PRICES_URL).await?;
    Ok((meta, prices))
}

/// 检查一次在线更新。`force` 为假时，距上次检查不足 24 小时或已关闭自动更新就跳过。
/// 第二项为真表示默认价换成了新下载的表，调用方要通知前端重新读取价格表。
/// 写入已通过校验的在线表。与读取、保存价格同一把锁：保存价格时前后两次读到的默认价必须一致。
/// 手动检查与定时检查可能同时下载，所以在锁里再看一次已装的修订号，旧的不覆盖新的。
fn install(
    app_dir: &Path,
    bundled: &TableMeta,
    meta: TableMeta,
    prices: Value,
    now: DateTime<Utc>,
) -> Result<FeedDecision, String> {
    let _guard = lock_price_overrides();
    let installed =
        usable_feed(app_dir, bundled).map_or(bundled.revision, |feed| feed.meta.revision);
    if meta.revision <= installed {
        return Ok(FeedDecision::UpToDate);
    }
    let feed = CachedFeed {
        meta,
        prices,
        fetched_at: now,
    };
    write_json_atomically(&app_dir.join(FEED_FILE), &feed)
        .map_err(|error| format!("在线价格表没能写入本机：{error}"))?;
    Ok(FeedDecision::Store)
}

pub(super) async fn check_for_update(app: &AppContext, force: bool) -> (PriceTableStatus, bool) {
    let app_dir = app.app_data_dir();
    let state = read_state(app_dir);
    let now = Utc::now();
    let due = state
        .last_checked_at
        .is_none_or(|last| now.signed_duration_since(last).num_seconds() >= CHECK_INTERVAL_SECONDS);
    if !force && (!state.auto_update || !due) {
        return (status(app_dir), false);
    }
    let fetched = fetch_feed().await;
    let bundled = bundled_meta();
    let current_revision =
        usable_feed(app_dir, &bundled).map_or(bundled.revision, |feed| feed.meta.revision);
    let outcome = fetched.and_then(|(meta, prices_bytes)| {
        let (decision, prices) = decide(current_revision, &meta, &prices_bytes)?;
        if decision != FeedDecision::Store {
            return Ok(decision);
        }
        install(app_dir, &bundled, meta, prices, now)
    });
    let state_guard = lock_feed_state();
    let mut next = read_state(app_dir);
    next.last_checked_at = Some(now);
    next.last_error = outcome.as_ref().err().cloned();
    if let Err(error) = write_json_atomically(&app_dir.join(FEED_STATE_FILE), &next) {
        log::warn!("price table feed state was not saved: {error}");
    }
    drop(state_guard);
    let updated = matches!(outcome, Ok(FeedDecision::Store));
    match outcome {
        Ok(FeedDecision::Store) => {
            log::info!("price table updated online");
            cache::invalidate_all(&db::get_db_path(app));
        }
        Ok(FeedDecision::UpToDate) => {}
        Err(error) => log::warn!("price table update check failed: {error}"),
    }
    (status(app_dir), updated)
}

/// 编辑器载入价格表时的修订号与现在不同：保存会把旧默认价当成用户改动写进覆盖文件，
/// 所以拒绝，请用户先重新读取。没带修订号（旧前端）时不检查。
pub(super) fn ensure_editor_revision(
    app_dir: &Path,
    editor_revision: Option<u64>,
) -> Result<(), String> {
    let current = status(app_dir).revision;
    match editor_revision {
        Some(revision) if revision != current => Err(format!(
            "价格表已更新到第 {current} 版，编辑框里还是第 {revision} 版的价格。为了不把旧价当成你的自定义价格保存，这次没有保存；请先复制需要保留的修改，点「重新读取」后再改。"
        )),
        _ => Ok(()),
    }
}

pub(super) fn set_auto_update(app_dir: &Path, enabled: bool) -> Result<PriceTableStatus, String> {
    let guard = lock_feed_state();
    let mut state = read_state(app_dir);
    state.auto_update = enabled;
    write_json_atomically(&app_dir.join(FEED_STATE_FILE), &state)?;
    drop(guard);
    Ok(status(app_dir))
}

/// 后台定时检查：启动后约 1 分钟首查，之后每小时看一次是否到期（24 小时）。默认价换了
/// 新表时发 `prices-updated`，打开着的价格编辑器没有未保存修改就重新读取。
pub fn start_scheduler(app: Arc<AppContext>, handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            if check_for_update(&app, false).await.1 {
                super::emit_app_event(&handle, "prices-updated");
            }
            tokio::time::sleep(SCHEDULER_TICK).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(revision: u64) -> TableMeta {
        TableMeta {
            schema: SUPPORTED_SCHEMA,
            revision,
            verified_at: "2026-10-24".to_string(),
            updated_at: Some("2026-10-24".to_string()),
            prices_sha256: Some(sha256_hex(&table_bytes())),
        }
    }

    fn table_bytes() -> Vec<u8> {
        serde_json::to_vec(&table()).unwrap()
    }

    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn test_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_price_feed_{label}_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn table() -> Value {
        json!({ "default": { "input": 1.0, "output": 3.0 }, "m": { "input": 2.0, "output": 4.0 } })
    }

    fn store(dir: &Path, revision: u64, prices: Value) {
        let feed = CachedFeed {
            meta: meta(revision),
            prices,
            fetched_at: Utc::now(),
        };
        write_json_atomically(&dir.join(FEED_FILE), &feed).unwrap();
    }

    #[test]
    fn the_bundled_table_passes_the_feed_validation() {
        let bundled = bundled_meta();
        assert!(bundled.schema <= SUPPORTED_SCHEMA);
        validate_meta(&bundled).unwrap();
        validate_table(&default_prices()).unwrap();
    }

    #[test]
    fn the_bundled_meta_matches_the_bundled_table() {
        // 改了 prices.json 却没更新 prices.meta.json 时这里失败：在线更新会拒绝这一对文件。
        assert_eq!(
            bundled_meta().prices_sha256.as_deref(),
            Some(sha256_hex(super::super::DEFAULT_PRICES_JSON.as_bytes()).as_str()),
            "prices.meta.json 的 prices_sha256 要等于 prices.json 的 SHA-256，并把 revision 加 1"
        );
    }

    #[test]
    fn only_a_newer_valid_table_is_stored() {
        let bytes = table_bytes();
        assert_eq!(
            decide(2, &meta(3), &bytes).map(|(d, _)| d),
            Ok(FeedDecision::Store)
        );
        assert_eq!(
            decide(3, &meta(3), &bytes).map(|(d, _)| d),
            Ok(FeedDecision::UpToDate)
        );
        let mut future = meta(9);
        future.schema = SUPPORTED_SCHEMA + 1;
        assert!(decide(2, &future, &bytes).is_err());
        let mut undigested = meta(3);
        undigested.prices_sha256 = None;
        assert!(decide(2, &undigested, &bytes).is_err());
        for bad in [
            json!({ "m": { "input": 1.0, "output": 1.0 } }),
            json!({ "default": { "input": -1.0, "output": 1.0 } }),
            json!({ "default": { "input": 1.0, "output": 1.0, "_meta": { "status": "user_edited" } } }),
        ] {
            let bytes = serde_json::to_vec(&bad).unwrap();
            let mut meta = meta(3);
            meta.prices_sha256 = Some(sha256_hex(&bytes));
            assert!(decide(2, &meta, &bytes).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_table_that_does_not_match_the_meta_digest_is_rejected() {
        // 新 meta 配上 CDN 缓存里的旧表：能通过表校验，但摘要不符。
        let stale =
            serde_json::to_vec(&json!({ "default": { "input": 9.0, "output": 9.0 } })).unwrap();
        let error = decide(2, &meta(3), &stale).unwrap_err();
        assert!(error.contains("摘要不一致"), "{error}");
    }

    #[test]
    fn a_cached_table_replaces_the_bundled_one_only_while_it_is_newer() {
        let dir = test_dir("cached");
        let bundled = bundled_meta();
        assert_eq!(
            effective_defaults(dir.as_path()),
            default_prices(),
            "没有缓存时用内置表"
        );
        assert_eq!(status(dir.as_path()).source, "bundled");

        store(dir.as_path(), bundled.revision + 1, table());
        assert_eq!(effective_defaults(dir.as_path()), table());
        let online = status(dir.as_path());
        assert_eq!(online.source, "online");
        assert_eq!(online.revision, bundled.revision + 1);
        assert!(online.fetched_at.is_some());

        // 升级后内置表追上了缓存的修订号：回到内置表。
        store(dir.as_path(), bundled.revision, table());
        assert_eq!(effective_defaults(dir.as_path()), default_prices());
    }

    #[test]
    fn a_corrupt_cache_falls_back_to_the_bundled_table() {
        let dir = test_dir("corrupt");
        store(
            dir.as_path(),
            bundled_meta().revision + 1,
            json!({ "m": { "input": 1.0 } }),
        );
        assert_eq!(effective_defaults(dir.as_path()), default_prices());
        fs::write(dir.as_path().join(FEED_FILE), b"{not json").unwrap();
        assert_eq!(effective_defaults(dir.as_path()), default_prices());
    }

    #[test]
    fn a_save_from_an_editor_loaded_before_an_update_is_refused() {
        let dir = test_dir("editor");
        let bundled = bundled_meta().revision;
        assert!(ensure_editor_revision(dir.as_path(), Some(bundled)).is_ok());
        assert!(ensure_editor_revision(dir.as_path(), None).is_ok());
        store(dir.as_path(), bundled + 1, table());
        let error = ensure_editor_revision(dir.as_path(), Some(bundled)).unwrap_err();
        assert!(error.contains("重新读取"), "{error}");
        assert!(ensure_editor_revision(dir.as_path(), Some(bundled + 1)).is_ok());
    }

    #[test]
    fn the_editor_save_checks_the_revision_before_touching_the_overrides() {
        let dir = test_dir("editor_save");
        let app = crate::AppContext::for_test(dir.clone());
        let bundled = bundled_meta().revision;
        store(dir.as_path(), bundled + 1, table());
        let error =
            super::super::save_prices_for_editor(&app, json!({}), Some(bundled)).unwrap_err();
        assert!(error.contains("重新读取"), "{error}");
        assert!(!dir.join(PRICE_OVERRIDES_FILE).exists());
    }

    #[test]
    fn an_older_download_never_replaces_a_newer_installed_table() {
        let dir = test_dir("install_race");
        let bundled = bundled_meta();
        let newer = bundled.revision + 2;
        store(dir.as_path(), newer, table());
        let outcome = install(
            dir.as_path(),
            &bundled,
            meta(newer - 1),
            table(),
            Utc::now(),
        );
        assert_eq!(outcome, Ok(FeedDecision::UpToDate));
        assert_eq!(status(dir.as_path()).revision, newer);
        let outcome = install(
            dir.as_path(),
            &bundled,
            meta(newer + 1),
            table(),
            Utc::now(),
        );
        assert_eq!(outcome, Ok(FeedDecision::Store));
        assert_eq!(status(dir.as_path()).revision, newer + 1);
    }

    #[test]
    fn auto_update_defaults_on_and_can_be_turned_off() {
        let dir = test_dir("auto");
        assert!(status(dir.as_path()).auto_update);
        assert!(!set_auto_update(dir.as_path(), false).unwrap().auto_update);
        assert!(!status(dir.as_path()).auto_update);
        assert!(set_auto_update(dir.as_path(), true).unwrap().auto_update);
    }

    #[test]
    fn override_models_count_only_entries_with_rates() {
        let dir = test_dir("overrides");
        fs::write(
            dir.as_path().join(PRICE_OVERRIDES_FILE),
            serde_json::to_vec(&json!({
                "a": { "input": 1.0 },
                "b": { "_meta": { "status": "user_edited" } }
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(status(dir.as_path()).override_models, 1);
    }
}
