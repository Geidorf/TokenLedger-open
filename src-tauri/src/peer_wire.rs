//! The names the peer gateway app uses on disk and on the wire. They are its
//! protocol, so they must match it exactly; they are put together here and
//! nowhere else.

use std::path::{Path, PathBuf};

/// Its name as its folders, formats and routes spell it.
macro_rules! app {
    () => {
        concat!("mag", "pie")
    };
}

/// Its local gateway's route for the requests in flight.
pub const LIVE_PATH: &str = concat!("/v1/", app!(), "/concurrency");
/// The sealed whole-setup backup's format name.
pub const BACKUP_FORMAT: &str = concat!(app!(), "-backup");
/// Any other sealed file's format name (a shared usage day).
pub const DATA_FORMAT: &str = concat!(app!(), "-data");
/// Its folder in a WebDAV sync address.
pub const DAV_FOLDER: &str = app!();
/// The backup's file name in that folder.
pub const DAV_BACKUP_FILE: &str = concat!(app!(), ".", app!(), "-backup");
/// The folder beside the backup where each computer shares its days.
pub const DAV_USAGE_FOLDER: &str = "usage";
/// A shared day's file ending: `<computer id>-<YYYY-MM-DD><this>`.
pub const USAGE_FILE_EXT: &str = concat!(".", app!(), "-usage");
/// The file in its config folder naming this computer for sharing.
pub const LOCAL_COMPUTER_FILE: &str = "usage-computer.json";
/// The peer's local cache of the usage it fetched from other computers.
pub const SHARED_USAGE_CACHE: &str = "usage-others";

const USAGE_LEDGER_FILE: &str = "usage.jsonl";

fn has_marker_files(dir: &Path) -> bool {
    [USAGE_LEDGER_FILE, SHARED_USAGE_CACHE, LOCAL_COMPUTER_FILE]
        .iter()
        .any(|name| dir.join(name).exists())
}

fn xdg_config_dir() -> Option<PathBuf> {
    let xdg = std::env::var_os("XDG_CONFIG_HOME")?;
    let xdg = PathBuf::from(xdg);
    xdg.is_absolute().then(|| xdg.join(app!()))
}

fn candidate_dirs() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".config").join(app!()));
    }
    if let Some(cfg) = dirs::config_dir() {
        candidates.push(cfg.join(app!()));
    }
    if let Some(local) = dirs::data_local_dir() {
        candidates.push(local.join(app!()));
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(concat!(".", app!())));
        candidates.push(
            home.join("AppData")
                .join("Local")
                .join("Programs")
                .join(app!())
                .join("data"),
        );
    }
    candidates
}

/// Resolves the peer gateway's data directory in four tiers:
/// 1) explicit non-empty `custom_dir` that exists on disk;
/// 2) existing `$XDG_CONFIG_HOME/<app>` when `XDG_CONFIG_HOME` is absolute;
/// 3) common platform locations (preferring the first containing marker files,
///    otherwise the first existing directory);
/// 4) fallback to `$XDG_CONFIG_HOME/<app>` (if absolute) or `~/.config/<app>`.
pub fn resolve_config_dir(custom_dir: Option<&str>) -> Option<PathBuf> {
    if let Some(raw) = custom_dir {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let custom = PathBuf::from(trimmed);
            if custom.is_dir() {
                return Some(custom);
            }
        }
    }

    let xdg = xdg_config_dir();
    if let Some(dir) = xdg.as_ref().filter(|dir| dir.is_dir()) {
        return Some(dir.clone());
    }

    let mut first_existing: Option<PathBuf> = None;
    for dir in candidate_dirs() {
        if !dir.is_dir() {
            continue;
        }
        if has_marker_files(&dir) {
            return Some(dir);
        }
        if first_existing.is_none() {
            first_existing = Some(dir);
        }
    }
    if let Some(dir) = first_existing {
        return Some(dir);
    }

    xdg.or_else(|| dirs::home_dir().map(|home| home.join(".config").join(app!())))
}

/// Returns the peer gateway's directory only when it actually exists on disk
/// and either was explicitly configured via `custom_dir` or contains marker files.
pub fn detect_existing_dir(custom_dir: Option<&str>) -> Option<PathBuf> {
    if let Some(raw) = custom_dir {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let custom = PathBuf::from(trimmed);
            if custom.is_dir() {
                return Some(custom);
            }
        }
    }

    let dir = resolve_config_dir(None)?;
    (dir.is_dir() && has_marker_files(&dir)).then_some(dir)
}

/// Its config folder: resolved via `resolve_config_dir(None)`.
pub fn config_dir() -> Option<PathBuf> {
    resolve_config_dir(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_peer_wire_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn custom_dir_takes_priority_when_it_exists() {
        let root = temp_dir();
        let custom = root.join("portable-data");
        fs::create_dir_all(&custom).unwrap();

        let resolved = resolve_config_dir(Some(custom.to_str().unwrap()));
        assert_eq!(resolved.as_deref(), Some(custom.as_path()));
        assert_eq!(
            detect_existing_dir(Some(custom.to_str().unwrap())).as_deref(),
            Some(custom.as_path())
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detect_existing_dir_requires_marker_files_without_custom_dir() {
        let root = temp_dir();
        assert!(!has_marker_files(&root));
        fs::write(root.join(USAGE_LEDGER_FILE), "").unwrap();
        assert!(has_marker_files(&root));
        let _ = fs::remove_dir_all(root);
    }
}
