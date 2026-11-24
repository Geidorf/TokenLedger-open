use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use chrono::{DateTime, Utc};
use rusqlite::Connection;

const FILE: &str = "query-ledger-v1.sqlite3";
const VERSION: i64 = 1;
const STALE_MINUTES: i64 = 15;
const UNAVAILABLE: &str = "没有可安全读取的统计快照。请启动桌面端并刷新用量后重试。";
static WRITER: Mutex<()> = Mutex::new(());

pub(crate) fn writer() -> MutexGuard<'static, ()> {
    WRITER.lock().unwrap_or_else(|error| error.into_inner())
}

pub(crate) fn invalidate(dir: &Path) -> Result<(), String> {
    if !dir.try_exists().map_err(|error| error.to_string())? {
        return Ok(());
    }
    crate::quota::remove_private_app_data_file_checked(dir, FILE)
}

pub(crate) fn publish(
    dir: &Path,
    conn: &Connection,
    overlay: bool,
    captured_at: DateTime<Utc>,
    install_overlay: impl FnOnce(&Connection) -> rusqlite::Result<()>,
) -> Result<(), String> {
    let (target, root) = crate::quota::private_app_data_path(dir, FILE)?;
    let mut nonce = [0_u8; 8];
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    let temp = root.join(format!(".{FILE}.{:016x}.tmp", u64::from_ne_bytes(nonce)));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&temp).map_err(|error| error.to_string())?;
    let result = (|| -> Result<(), String> {
        let path = temp.to_str().ok_or("统计快照路径无法编码。")?;
        conn.execute("ATTACH DATABASE ?1 AS query_out", [path])
            .map_err(|error| error.to_string())?;
        let result = (|| -> rusqlite::Result<()> {
            conn.execute_batch(
                "PRAGMA query_out.journal_mode = DELETE;
                 PRAGMA query_out.synchronous = FULL;",
            )?;
            let tx = conn.unchecked_transaction()?;
            install_overlay(&tx)?;
            tx.execute_batch(
                "
                 CREATE TABLE query_out.snapshot_info(version INTEGER NOT NULL, captured_at TEXT NOT NULL, gateway INTEGER NOT NULL);
                 CREATE TABLE query_out.token_logs AS
                   SELECT id,tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,timestamp,
                          session_id,unique_key,cost_usd,machine_id,sync_status,cloud_user_id,synced_at,
                          cache_write_known,usage_provenance FROM main.token_logs;
                 CREATE INDEX query_out.query_timestamp ON token_logs(timestamp);
                 CREATE TABLE query_out.discovered_models AS
                   SELECT tool,model_key,model,first_seen_at,last_seen_at FROM main.discovered_models;",
            )?;
            if overlay {
                tx.execute_batch(
                    "CREATE TABLE query_out.gateway_rows AS
                        SELECT id,tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,
                               timestamp,session_id,cost_usd,machine_id,provider,context FROM temp.gw_rows;
                     CREATE TABLE query_out.gateway_superseded AS SELECT id FROM temp.gw_superseded;",
                )?;
            }
            tx.execute(
                "INSERT INTO query_out.snapshot_info VALUES (?1, ?2, ?3)",
                rusqlite::params![VERSION, captured_at.to_rfc3339(), overlay],
            )?;
            tx.commit()
        })();
        // Close this connection before publishing. It holds the attached file open on Windows.
        result.map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = conn.execute_batch("DETACH DATABASE query_out");
        let _ = fs::remove_file(&temp);
        return result;
    }
    let result = (|| {
        conn.execute_batch("DETACH DATABASE query_out")
            .map_err(|error| error.to_string())?;
        OpenOptions::new()
            .write(true)
            .open(&temp)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())?;
        replace_snapshot(&temp, &target)?;
        #[cfg(unix)]
        fs::File::open(&root)
            .and_then(|dir| dir.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(not(windows))]
fn replace_snapshot(source: &Path, target: &Path) -> Result<(), String> {
    crate::quota::replace_private_app_data_file(source, target)
}

#[cfg(windows)]
fn replace_snapshot(source_path: &Path, target: &Path) -> Result<(), String> {
    use std::ffi::c_void;
    use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle};

    #[repr(C)]
    struct RenameInfo {
        flags: u32,
        root: *mut c_void,
        name_bytes: u32,
        name: [u16; 1],
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetFileInformationByHandle(
            handle: *mut c_void,
            class: u32,
            info: *const c_void,
            size: u32,
        ) -> i32;
    }

    const DELETE_ACCESS: u32 = 0x10000;
    const FILE_RENAME_INFO_EX: u32 = 22;
    const REPLACE_EXISTING: u32 = 1;
    const POSIX_RENAME: u32 = 2;
    let source = OpenOptions::new()
        .access_mode(DELETE_ACCESS)
        .open(source_path)
        .map_err(|error| error.to_string())?;
    let name: Vec<u16> = target.as_os_str().encode_wide().collect();
    let name_offset = std::mem::offset_of!(RenameInfo, name);
    let bytes = std::mem::size_of_val(name.as_slice());
    let size = name_offset + bytes;
    let mut buffer = vec![0_u64; size.div_ceil(size_of::<u64>())];
    // The allocation has native alignment, a zeroed RootDirectory and space
    // for the UTF-16 path. The API borrows it only during this call.
    let result = unsafe {
        let info = buffer.as_mut_ptr().cast::<RenameInfo>();
        (*info).flags = REPLACE_EXISTING | POSIX_RENAME;
        (*info).name_bytes = bytes as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*info).name).cast::<u16>(),
            name.len(),
        );
        SetFileInformationByHandle(
            source.as_raw_handle().cast(),
            FILE_RENAME_INFO_EX,
            info.cast(),
            size as u32,
        )
    };
    if result != 0 {
        return Ok(());
    }
    drop(source);
    crate::quota::replace_private_app_data_file(source_path, target)
}

#[cfg(all(test, windows))]
#[test]
fn replace_during_read_keeps_each_generation_consistent() {
    use std::os::windows::fs::OpenOptionsExt;

    let root =
        std::env::temp_dir().join(format!("tokenledger-query-replace-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let target = root.join("query.sqlite3");
    let next = root.join("query-next.sqlite3");
    fs::write(&target, b"old").unwrap();
    fs::write(&next, b"new").unwrap();
    let mut current = OpenOptions::new()
        .read(true)
        .share_mode(1 | 4)
        .open(&target)
        .unwrap();
    replace_snapshot(&next, &target).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"new");
    let mut bytes = Vec::new();
    current.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"old");
    drop(current);
    fs::remove_file(target).unwrap();
    fs::remove_dir(root).unwrap();
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Freshness {
    captured_at: DateTime<Utc>,
    pub(crate) stale: bool,
}

impl Freshness {
    pub(crate) fn text(&self) -> String {
        let captured = self
            .captured_at
            .with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M:%S %:z");
        if self.stale {
            format!("统计快照 {captured}，已超过 {STALE_MINUTES} 分钟。请启动桌面端刷新用量。")
        } else {
            format!("统计快照 {captured}")
        }
    }
}

pub(crate) fn open(dir: &Path) -> Result<(Connection, Freshness, bool), String> {
    open_checked(dir).map_err(|_| UNAVAILABLE.to_string())
}

fn open_checked(dir: &Path) -> Result<(Connection, Freshness, bool), Box<dyn std::error::Error>> {
    let (path, _) = crate::quota::private_app_data_path(dir, FILE)?;
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file() {
        return Err(UNAVAILABLE.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(UNAVAILABLE.into());
        }
    }
    let conn = open_database(&path)?;
    conn.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;")?;
    let (version, captured_at, gateway): (i64, String, bool) = conn.query_row(
        "SELECT version,captured_at,gateway FROM snapshot_info",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let captured_at = captured_at.parse::<DateTime<Utc>>()?;
    let now = Utc::now();
    if version != VERSION || captured_at > now + chrono::Duration::minutes(5) {
        return Err(UNAVAILABLE.into());
    }
    let stale = now - captured_at >= chrono::Duration::minutes(STALE_MINUTES);
    Ok((conn, Freshness { captured_at, stale }, gateway))
}

fn check_header(mut read: impl Read) -> Result<(), Box<dyn std::error::Error>> {
    let mut header = [0u8; 20];
    read.read_exact(&mut header)?;
    if &header[..16] != b"SQLite format 3\0" || header[18..20] != [1, 1] {
        return Err(UNAVAILABLE.into());
    }
    Ok(())
}

#[cfg(windows)]
fn open_database(path: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    use std::io::{Seek, SeekFrom};
    use std::os::windows::fs::OpenOptionsExt;

    // The native SQLite Windows VFS doesn't share deletes. Load the published
    // generation through a handle that allows concurrent replacement/removal.
    const SHARE_READ_AND_DELETE: u32 = 1 | 4;
    const OPEN_REPARSE_POINT: u32 = 0x00200000;
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(SHARE_READ_AND_DELETE)
        .custom_flags(OPEN_REPARSE_POINT)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(UNAVAILABLE.into());
    }
    check_header(&mut file)?;
    let size = usize::try_from(file.metadata()?.len())?;
    file.seek(SeekFrom::Start(0))?;
    let mut conn = Connection::open_in_memory()?;
    conn.deserialize_read_exact(rusqlite::MAIN_DB, file, size, true)?;
    Ok(conn)
}

#[cfg(not(windows))]
fn open_database(path: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    use rusqlite::OpenFlags;

    check_header(fs::File::open(path)?)?;
    let url = reqwest::Url::from_file_path(&path).map_err(|()| UNAVAILABLE)?;
    let location = if url.has_host() {
        format!("file://{}", &url.as_str()[5..])
    } else {
        url.to_string()
    };
    // The desktop atomically replaces the file and never edits a published copy.
    let conn = Connection::open_with_flags(
        format!("{location}?mode=ro&immutable=1"),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    Ok(conn)
}
