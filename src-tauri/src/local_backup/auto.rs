//! Scheduled backups to a local folder (contract `local-backup-v1` §5).
//!
//! The folder, interval and how many to keep live in `local-backup-v1.json`;
//! the passphrase only in the keychain. Off by default. Only files this
//! schedule wrote (`TokenLedger-auto-*.tlbackup`) are ever pruned.

use std::fs;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use chrono::{DateTime, Duration, Local, Utc};
use serde::{Deserialize, Serialize};

use super::{backup_dir, check_passphrase, default_dir, export_to, EXTENSION, PASSPHRASE_ACCOUNT};
use crate::app_paths::AppContext;
use crate::gateway::{Gateway, SecretStore};

const CONFIG_FILE: &str = "local-backup-v1.json";
pub const AUTO_PREFIX: &str = "TokenLedger-auto-";
const INTERVALS: [u32; 3] = [24, 72, 168];
const DEFAULT_INTERVAL: u32 = 24;
const DEFAULT_KEEP: u32 = 7;
const MAX_KEEP: u32 = 60;

/// Serialises writes of the config file: a run records its outcome on the
/// latest settings, never on the copy it read before a long export.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

fn config_lock() -> MutexGuard<'static, ()> {
    CONFIG_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoConfig {
    pub enabled: bool,
    pub dir: String,
    pub interval_hours: u32,
    pub keep: u32,
    pub last_run_at: Option<String>,
    pub last_file: Option<String>,
    pub last_error: Option<String>,
}

impl Default for AutoConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            dir: String::new(),
            interval_hours: DEFAULT_INTERVAL,
            keep: DEFAULT_KEEP,
            last_run_at: None,
            last_file: None,
            last_error: None,
        }
    }
}

impl AutoConfig {
    fn sanitized(mut self) -> Self {
        if !INTERVALS.contains(&self.interval_hours) {
            self.interval_hours = DEFAULT_INTERVAL;
        }
        self.keep = self.keep.clamp(1, MAX_KEEP);
        self
    }
}

/// What the page sees: never the passphrase.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoView {
    #[serde(flatten)]
    pub config: AutoConfig,
    pub has_passphrase: bool,
    /// When the next backup is due, local RFC 3339; `None` while off.
    pub next_due: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAutoInput {
    pub enabled: bool,
    pub dir: String,
    pub interval_hours: u32,
    pub keep: u32,
    /// `None` keeps the saved one; `Some("")` removes it.
    pub passphrase: Option<String>,
}

pub fn load(app: &AppContext) -> AutoConfig {
    fs::read(app.app_data_dir().join(CONFIG_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<AutoConfig>(&bytes).ok())
        .unwrap_or_default()
        .sanitized()
}

fn store(app: &AppContext, config: &AutoConfig) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
    crate::quota::write_private_app_data_file(app.app_data_dir(), CONFIG_FILE, &body)
}

fn due_at(config: &AutoConfig) -> Option<DateTime<Utc>> {
    if !config.enabled {
        return None;
    }
    let last = config
        .last_run_at
        .as_deref()
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .map(|at| at.with_timezone(&Utc));
    // A failed run (a folder on a drive that is not plugged in) is retried
    // within the hour instead of waiting a whole interval.
    let hours = if config.last_error.is_some() {
        1
    } else {
        i64::from(config.interval_hours)
    };
    Some(match last {
        Some(last) => last + Duration::hours(hours),
        None => Utc::now(),
    })
}

pub fn view(app: &AppContext, secrets: &dyn SecretStore) -> Result<AutoView, String> {
    let mut config = load(app);
    if config.dir.is_empty() {
        config.dir = default_dir(app).to_string_lossy().to_string();
    }
    let next_due = due_at(&config).map(|at| {
        at.with_timezone(&Local)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
    });
    Ok(AutoView {
        has_passphrase: secrets.get(PASSPHRASE_ACCOUNT)?.is_some(),
        config,
        next_due,
    })
}

pub fn save(
    app: &AppContext,
    secrets: &dyn SecretStore,
    input: SaveAutoInput,
) -> Result<AutoView, String> {
    let dir = backup_dir(&input.dir)?;
    match input.passphrase.as_deref() {
        None => {}
        Some("") => secrets.delete(PASSPHRASE_ACCOUNT)?,
        Some(passphrase) => {
            check_passphrase(passphrase)?;
            secrets.set(PASSPHRASE_ACCOUNT, passphrase)?;
        }
    }
    if input.enabled && secrets.get(PASSPHRASE_ACCOUNT)?.is_none() {
        return Err("开启自动备份前请先设置备份密码。".to_string());
    }
    let _guard = config_lock();
    let previous = load(app);
    let config = AutoConfig {
        enabled: input.enabled,
        dir: dir.to_string_lossy().to_string(),
        interval_hours: input.interval_hours,
        keep: input.keep,
        ..previous
    }
    .sanitized();
    store(app, &config)?;
    view(app, secrets)
}

/// Removes the oldest scheduled backups beyond `keep`.
pub fn prune(dir: &Path, keep: usize) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().is_file())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with(AUTO_PREFIX) && name.ends_with(&format!(".{EXTENSION}")))
        .collect();
    // The time stamp in the name sorts in time order.
    names.sort();
    let excess = names.len().saturating_sub(keep);
    names
        .into_iter()
        .take(excess)
        .filter(|name| fs::remove_file(dir.join(name)).is_ok())
        .count()
}

/// Backs up now with the saved settings, recording the outcome.
pub fn run_now(
    app: &AppContext,
    gateway: &Gateway,
    secrets: &dyn SecretStore,
    iterations: u32,
) -> Result<String, String> {
    let config = load(app);
    let dir = if config.dir.is_empty() {
        default_dir(app)
    } else {
        backup_dir(&config.dir)?
    };
    let outcome = secrets
        .get(PASSPHRASE_ACCOUNT)
        .and_then(|passphrase| passphrase.ok_or_else(|| "还没有设置自动备份的密码。".to_string()))
        .and_then(|passphrase| export_to(app, gateway, &dir, AUTO_PREFIX, &passphrase, iterations));
    // Settings saved while the export ran win; only the outcome is recorded.
    let _guard = config_lock();
    let mut config = load(app);
    config.last_run_at = Some(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    let result = match outcome {
        Ok(export) => {
            prune(&dir, config.keep as usize);
            config.last_error = None;
            config.last_file = Some(export.path.clone());
            Ok(export.path)
        }
        Err(error) => {
            config.last_error = Some(error.clone());
            Err(error)
        }
    };
    store(app, &config)?;
    result
}

/// Called by the background scheduler: backs up when one is due.
pub fn run_if_due(app: &AppContext, gateway: &Gateway, secrets: &dyn SecretStore) {
    let config = load(app);
    let Some(due) = due_at(&config) else {
        return;
    };
    if Utc::now() < due {
        return;
    }
    match run_now(app, gateway, secrets, super::ITERATIONS) {
        Ok(_) => log::info!("scheduled local backup written"),
        Err(error) => log::warn!("scheduled local backup failed: {error}"),
    }
}
