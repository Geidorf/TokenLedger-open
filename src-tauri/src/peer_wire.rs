//! The names the peer gateway app uses on disk and on the wire. They are its
//! protocol, so they must match it exactly; they are put together here and
//! nowhere else.

/// Its name as its folders, formats and routes spell it.
macro_rules! app {
    () => {
        concat!("mag", "pie")
    };
}

/// The sealed whole-setup backup's format name.
pub const BACKUP_FORMAT: &str = concat!(app!(), "-backup");
/// Any other sealed file's format name.
#[allow(dead_code)] // shared usage files are not read yet
pub const DATA_FORMAT: &str = concat!(app!(), "-data");
/// Its folder in a WebDAV sync address.
pub const DAV_FOLDER: &str = app!();
/// The backup's file name in that folder.
pub const DAV_BACKUP_FILE: &str = concat!(app!(), ".", app!(), "-backup");
