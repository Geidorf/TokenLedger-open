use super::codex::CODEX_CHECKPOINT_SOURCE_KIND;
use std::collections::HashMap;
use std::fs::{self, Metadata};
// `File` is only touched by the Windows identity-cache branch below; a top-level
// import trips macOS clippy's unused-import deny (the b60f2bd/88ba252 lesson).
#[cfg(windows)]
use std::fs::File;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SourceFingerprint {
    pub(crate) normalized_path: String,
    pub(crate) source_identity: String,
    pub(crate) size_bytes: i64,
    pub(crate) modified_ns: i64,
}

impl SourceFingerprint {
    pub(crate) fn checkpoint_for(&self, source_kind: &str) -> crate::db::ScanCheckpoint {
        crate::db::ScanCheckpoint {
            source_kind: source_kind.to_string(),
            source_path: self.normalized_path.clone(),
            source_identity: self.source_identity.clone(),
            size_bytes: self.size_bytes,
            modified_ns: self.modified_ns,
            // Claude streaming-snapshot dedupe and Codex model attribution both
            // depend on earlier rows, so changed files are reparsed from byte
            // zero. The completed file size is the equivalent processed cursor.
            processed_offset: self.size_bytes,
        }
    }

    pub(crate) fn checkpoint(&self) -> crate::db::ScanCheckpoint {
        self.checkpoint_for(CODEX_CHECKPOINT_SOURCE_KIND)
    }

    pub(crate) fn source_cursor(
        &self,
        source_kind: &str,
        cursor_primary: impl Into<String>,
        cursor_secondary: impl Into<String>,
        parser_version: i64,
    ) -> crate::db::ScanSourceCursor {
        crate::db::ScanSourceCursor {
            source_kind: source_kind.to_string(),
            source_path: self.normalized_path.clone(),
            source_identity: self.source_identity.clone(),
            cursor_primary: cursor_primary.into(),
            cursor_secondary: cursor_secondary.into(),
            size_bytes: self.size_bytes,
            modified_ns: self.modified_ns,
            parser_version,
        }
    }
}

pub(crate) type SourceCursorMap = HashMap<(String, String), crate::db::ScanSourceCursor>;

pub(crate) fn active_source_cursor<'a>(
    cursors: &'a SourceCursorMap,
    fingerprint: &SourceFingerprint,
    source_kind: &str,
    parser_version: i64,
) -> Option<&'a crate::db::ScanSourceCursor> {
    cursors
        .get(&(source_kind.to_string(), fingerprint.normalized_path.clone()))
        .filter(|cursor| {
            cursor.source_identity == fingerprint.source_identity
                && cursor.parser_version == parser_version
        })
}

fn signed_system_time_ns(value: SystemTime) -> std::result::Result<i64, String> {
    let nanos = match value.duration_since(UNIX_EPOCH) {
        Ok(duration) => i128::try_from(duration.as_nanos())
            .map_err(|_| "source mtime is out of range".to_string())?,
        Err(error) => -i128::try_from(error.duration().as_nanos())
            .map_err(|_| "source mtime is out of range".to_string())?,
    };
    i64::try_from(nanos).map_err(|_| "source mtime is out of range".to_string())
}

#[cfg(unix)]
fn platform_source_identity(
    _path: &Path,
    metadata: &Metadata,
) -> std::result::Result<String, String> {
    use std::os::unix::fs::MetadataExt;
    Ok(format!("unix:{}:{}", metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
#[repr(C)]
struct WindowsFileTime {
    low_date_time: u32,
    high_date_time: u32,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsByHandleFileInformation {
    file_attributes: u32,
    creation_time: WindowsFileTime,
    last_access_time: WindowsFileTime,
    last_write_time: WindowsFileTime,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "GetFileInformationByHandle"]
    fn get_file_information_by_handle(
        file: *mut std::ffi::c_void,
        information: *mut WindowsByHandleFileInformation,
    ) -> i32;
}

#[cfg(windows)]
fn platform_source_identity(
    path: &Path,
    _metadata: &Metadata,
) -> std::result::Result<String, String> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;

    let file = File::open(path).map_err(|error| {
        format!(
            "failed to open {} for Windows file identity: {error}",
            path.display()
        )
    })?;
    let mut information = MaybeUninit::<WindowsByHandleFileInformation>::uninit();
    let succeeded =
        unsafe { get_file_information_by_handle(file.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return Err(format!(
            "failed to read Windows file identity for {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    let information = unsafe { information.assume_init() };
    let file_index =
        (u64::from(information.file_index_high) << 32) | u64::from(information.file_index_low);
    Ok(format!(
        "windows:{}:{}",
        information.volume_serial_number, file_index
    ))
}

#[cfg(not(any(unix, windows)))]
fn platform_source_identity(
    path: &Path,
    _metadata: &Metadata,
) -> std::result::Result<String, String> {
    Ok(format!("path:{}", path.to_string_lossy()))
}

pub(crate) fn source_fingerprint(path: &Path) -> std::result::Result<SourceFingerprint, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("failed to canonicalize {}: {error}", path.display()))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("failed to read metadata for {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("source is not a regular file: {}", path.display()));
    }
    let size_bytes = i64::try_from(metadata.len())
        .map_err(|_| format!("source is too large: {}", path.display()))?;
    let modified_ns = signed_system_time_ns(
        metadata
            .modified()
            .map_err(|error| format!("failed to read mtime for {}: {error}", path.display()))?,
    )?;
    Ok(SourceFingerprint {
        normalized_path: canonical.to_string_lossy().into_owned(),
        source_identity: platform_source_identity(&canonical, &metadata)?,
        size_bytes,
        modified_ns,
    })
}

/// Reuses an identity that was verified earlier in this process when the
/// cheap path/size/mtime tuple is unchanged. Windows file-index lookup opens
/// a handle and is disproportionately expensive across many archived logs;
/// the durable checkpoint still carries the verified identity across restarts.
pub(crate) fn cached_source_fingerprint(
    path: &Path,
) -> std::result::Result<SourceFingerprint, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, SourceFingerprint>>> = OnceLock::new();
    let cache_key = path.to_string_lossy().into_owned();
    let metadata = fs::metadata(path)
        .map_err(|error| format!("failed to read metadata for {}: {error}", path.display()))?;
    let size_bytes = i64::try_from(metadata.len())
        .map_err(|_| format!("source is too large: {}", path.display()))?;
    let modified_ns = signed_system_time_ns(
        metadata
            .modified()
            .map_err(|error| format!("failed to read mtime for {}: {error}", path.display()))?,
    )?;
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(cached) = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&cache_key)
        .filter(|cached| cached.size_bytes == size_bytes && cached.modified_ns == modified_ns)
        .cloned()
    {
        return Ok(cached);
    }
    let fingerprint = source_fingerprint(path)?;
    cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(cache_key, fingerprint.clone());
    Ok(fingerprint)
}

pub(crate) fn checkpoint_is_current(
    checkpoint: &crate::db::ScanCheckpoint,
    fingerprint: &SourceFingerprint,
) -> bool {
    checkpoint_is_current_for(checkpoint, fingerprint, CODEX_CHECKPOINT_SOURCE_KIND)
}

pub(crate) fn checkpoint_is_current_for(
    checkpoint: &crate::db::ScanCheckpoint,
    fingerprint: &SourceFingerprint,
    source_kind: &str,
) -> bool {
    checkpoint.source_kind == source_kind
        && checkpoint.source_path == fingerprint.normalized_path
        && checkpoint.source_identity == fingerprint.source_identity
        && checkpoint.size_bytes == fingerprint.size_bytes
        && checkpoint.modified_ns == fingerprint.modified_ns
        && checkpoint.processed_offset == fingerprint.size_bytes
}

pub(crate) fn checkpointed_file_before(
    path: &Path,
    source_kind: &str,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
) -> Option<SourceFingerprint> {
    let fingerprint = match cached_source_fingerprint(path) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            log::warn!("{source_kind}: {error}");
            return None;
        }
    };
    if checkpoints
        .get(&fingerprint.normalized_path)
        .is_some_and(|checkpoint| checkpoint_is_current_for(checkpoint, &fingerprint, source_kind))
    {
        return None;
    }
    Some(fingerprint)
}

pub(crate) fn finish_checkpointed_file(
    path: &Path,
    before: SourceFingerprint,
    source_kind: &str,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) {
    match cached_source_fingerprint(path) {
        Ok(after) if after == before => {
            pending_checkpoints.push(after.checkpoint_for(source_kind));
        }
        Ok(_) => log::debug!(
            "{source_kind}: source changed while scanning {}",
            path.display()
        ),
        Err(error) => log::warn!("{source_kind}: {error}"),
    }
}
