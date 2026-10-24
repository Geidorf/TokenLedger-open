//! The names the peer gateway app uses on disk and on the wire. They are its
//! protocol, so they must match it exactly; they are put together here and
//! nowhere else.

use std::path::PathBuf;

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

/// Its config folder: under `$XDG_CONFIG_HOME` when that is an absolute
/// path, otherwise under `~/.config` on every platform, as it finds it.
pub fn config_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let xdg = PathBuf::from(xdg);
        if xdg.is_absolute() {
            return Some(xdg.join(app!()));
        }
    }
    dirs::home_dir().map(|home| home.join(".config").join(app!()))
}
