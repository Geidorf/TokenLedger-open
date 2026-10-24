//! Log locations of the Cindy desktop app.
//!
//! Cindy runs its agents with app-private homes under Electron's `userData`
//! directory, so their logs never reach `~/.codex` or `~/.pi`:
//!
//! - Codex: `<userData>/codex-home` (the default `CODEX_HOME`) and one home per
//!   signed-in account at `<userData>/codex-accounts/<owner>/<provider>`.
//! - Pi: `<userData>/pi-agent-home/sessions`.
//!
//! `userData` is `<appData>/<name>`, where `appData` is `%APPDATA%` on
//! Windows, `~/Library/Application Support` on macOS and `$XDG_CONFIG_HOME`
//! (or `~/.config`) on Linux. The name depends on the release channel. Claude
//! Code sessions use the default `~/.claude` and need nothing extra here.
//!
//! Cindy copies rollouts it imports from another Codex home, so the same
//! thread can exist in several places. The Codex scan indexes rollouts by
//! thread id and the Pi scan keys records by entry id, so copies are counted
//! once.

use std::fs;
use std::path::{Path, PathBuf};

/// `userData` directory names: the CN build, the global build and the name
/// used before the rename.
const CINDY_USER_DATA_DIR_NAMES: &[&str] = &["Cindy", "CindyGlobal", "xdt-maker"];
const CINDY_CODEX_ACCOUNTS_DIR: &str = "codex-accounts";

fn app_data_dirs_for_home(home: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let env_dir = |name: &str| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    if cfg!(target_os = "windows") {
        dirs.extend(env_dir("APPDATA"));
        dirs.push(home.join("AppData").join("Roaming"));
    } else if cfg!(target_os = "macos") {
        dirs.push(home.join("Library").join("Application Support"));
    } else {
        dirs.extend(env_dir("XDG_CONFIG_HOME"));
        dirs.push(home.join(".config"));
    }
    dirs.dedup();
    dirs
}

/// Candidate Cindy `userData` directories. Missing ones are skipped by the
/// scans, so this does no I/O.
pub(crate) fn cindy_user_data_dirs_in(home: &Path) -> Vec<PathBuf> {
    app_data_dirs_for_home(home)
        .into_iter()
        .flat_map(|app_data| {
            CINDY_USER_DATA_DIR_NAMES
                .iter()
                .map(move |name| app_data.join(name))
        })
        .collect()
}

fn child_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    dirs.sort();
    dirs
}

/// Codex session roots of every Cindy install under `home`.
pub(crate) fn cindy_codex_roots_in(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for user_data in cindy_user_data_dirs_in(home) {
        roots.extend(super::codex::codex_home_session_roots(
            &user_data.join("codex-home"),
        ));
        for owner in child_dirs(&user_data.join(CINDY_CODEX_ACCOUNTS_DIR)) {
            for account_home in child_dirs(&owner) {
                roots.extend(super::codex::codex_home_session_roots(&account_home));
            }
        }
    }
    roots
}

/// Pi session roots of every Cindy install under `home`.
pub(crate) fn cindy_pi_roots_in(home: &Path) -> Vec<PathBuf> {
    cindy_user_data_dirs_in(home)
        .into_iter()
        .map(|user_data| user_data.join("pi-agent-home").join("sessions"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_release_channel_and_agent_root_is_offered() {
        let home = std::env::temp_dir().join("tokenledger_cindy_paths_fixture");
        let dirs = cindy_user_data_dirs_in(&home)
            .into_iter()
            .filter(|dir| dir.starts_with(&home))
            .collect::<Vec<_>>();
        for name in CINDY_USER_DATA_DIR_NAMES {
            assert!(
                dirs.iter()
                    .any(|dir| dir.starts_with(&home) && dir.ends_with(name)),
                "{name} must be derived from the home directory: {dirs:?}"
            );
        }
        let pi_roots = cindy_pi_roots_in(&home)
            .into_iter()
            .filter(|root| root.starts_with(&home))
            .collect::<Vec<_>>();
        assert!(pi_roots
            .iter()
            .any(|root| root.ends_with(Path::new("Cindy/pi-agent-home/sessions"))));
        // Account homes are only listed when they exist.
        assert!(cindy_codex_roots_in(&home)
            .into_iter()
            .filter(|root| root.starts_with(&home))
            .all(|root| !root.to_string_lossy().contains(CINDY_CODEX_ACCOUNTS_DIR)));
    }
}
