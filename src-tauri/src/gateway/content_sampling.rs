use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::{DateTime, Utc};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305};
use serde::{Deserialize, Serialize};

use super::content_capture::CapturedContent;
use super::store::{SecretReadError, SecretStore};

const KEY_ACCOUNT: &str = "content-sampling-key";
const STATE_FILE: &str = "sampling-state-v1.json";
pub(crate) const SAMPLE_DIRECTORY: &str = "samples-v1";
const MAGIC: &[u8; 8] = b"TLSMP001";
const HEADER_BYTES: usize = 28;
const MAX_SAMPLES: usize = 200;
const MAX_DISK_BYTES: u64 = 50 * 1024 * 1024;
const MAX_PLAINTEXT: usize = 256 * 1024;
const MAX_SAMPLE_BYTES: usize = MAX_PLAINTEXT + HEADER_BYTES + 16;
pub(super) const CONTENT_BUDGET: usize = (MAX_PLAINTEXT - 2048) / 2;
const RETENTION_SECONDS: i64 = 7 * 24 * 60 * 60;
const STORE_ERROR: &str = "内容采样存储不可用，已停止采样。";
const KEY_ERROR: &str = "内容采样密钥不可用，已停止采样并清理样本。";
const KEY_UNAVAILABLE: &str =
    "暂时无法读取系统钥匙串；已暂停内容采样和样本读取，未因此清理样本。请恢复钥匙串访问后重试。";
const KEY_CREATE_ERROR: &str = "未能创建或验证内容采样密钥，未开启采样。";
const READ_ERROR: &str = "此内容样本不可用或已损坏。";
const READ_RETRY: &str = "暂时无法读取此内容样本，请重试。";
const CLEANUP_ERROR: &str = "内容样本清理尚未完成，请重试删除。";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SamplingMode {
    #[default]
    Off,
    Next,
    Filter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SamplingActivity {
    Off,
    Paused,
    Active,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SamplingInput {
    pub mode: SamplingMode,
    pub count: Option<u32>,
    pub agent: Option<String>,
    pub group: Option<String>,
    #[serde(default)]
    pub failures_only: bool,
    pub duration_hours: Option<u32>,
    #[serde(default)]
    pub confirmed: bool,
    pub delete_existing: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplingStatus {
    pub mode: SamplingMode,
    pub paused: bool,
    pub pending: bool,
    pub remaining: Option<u32>,
    pub expires_at: Option<String>,
    pub agent: Option<String>,
    pub group: Option<String>,
    pub failures_only: bool,
    pub sample_ids: Vec<String>,
    pub stored_count: usize,
    pub stored_bytes: u64,
    pub error: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentSample {
    pub id: String,
    pub created_at: String,
    pub status: u16,
    pub stream: bool,
    pub truncated: bool,
    pub request: String,
    pub response: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    mode: SamplingMode,
    remaining: Option<u32>,
    expires_at: Option<i64>,
    agent: Option<String>,
    group: Option<String>,
    failures_only: bool,
}

struct Inner {
    configuration: Configuration,
    // The Arc identity revokes old tickets without releasing their global slots.
    generation: Arc<AtomicUsize>,
    key_paused: bool,
    error: Option<String>,
}

impl Inner {
    fn revoke_tickets(&mut self) {
        self.generation = Arc::new(AtomicUsize::new(0));
    }

    fn has_pending_ticket(&self) -> bool {
        self.generation.load(Ordering::SeqCst) != 0
    }
}

pub(super) struct SampleTicket {
    slot: PendingSample,
    id: String,
    created_at: i64,
    stream: bool,
    failures_only: bool,
    request: CapturedContent,
}

pub(super) struct PendingSample {
    slots: Arc<AtomicUsize>,
    generation: Arc<AtomicUsize>,
    active: bool,
}

impl Drop for PendingSample {
    fn drop(&mut self) {
        if self.active {
            self.generation.fetch_sub(1, Ordering::SeqCst);
        }
        self.slots.fetch_sub(1, Ordering::SeqCst);
    }
}

struct SampleFile {
    id: String,
    path: PathBuf,
    created_at: Option<i64>,
    cleanup_failed: bool,
    bytes: u64,
}

enum SampleReadError {
    Missing,
    Unsafe,
    Invalid,
    Unavailable,
}

#[repr(u8)]
enum SamplePresence {
    Unknown,
    Empty,
    Present,
}

impl From<io::Error> for SampleReadError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::Missing,
            _ => Self::Unavailable,
        }
    }
}

#[cfg(test)]
type SampleWriter = fn(&Path, &[u8]) -> Result<(), String>;

pub(super) struct ContentSampling {
    directory: PathBuf,
    state_file: PathBuf,
    secrets: Arc<dyn SecretStore>,
    inner: Mutex<Inner>,
    pending: Arc<AtomicUsize>,
    ready: AtomicBool,
    skipped: AtomicBool,
    activity_hint: AtomicU8,
    sample_presence: AtomicU8,
    #[cfg(test)]
    sample_writer: Option<SampleWriter>,
}

fn timestamp(seconds: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp(seconds, 0).map(|time| time.to_rfc3339())
}

fn safe_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn decode_key(value: &str) -> Option<Vec<u8>> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let hex = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(hex, 16).ok()
        })
        .collect()
}

fn temporary_sample_id(filename: &str) -> Option<&str> {
    let (id, suffix) = filename
        .strip_prefix('.')?
        .split_once(".bin.tokenledger-")?;
    let suffix = suffix.strip_suffix(".tmp")?;
    (safe_id(id)
        && suffix.len() == 12
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
    .then_some(id)
}

fn sample_id(filename: &str) -> Option<&str> {
    filename.strip_suffix(".bin").filter(|id| safe_id(id))
}

fn initial_sample_presence(entries: io::Result<fs::ReadDir>) -> SamplePresence {
    let entries = match entries {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return SamplePresence::Empty,
        Err(_) => return SamplePresence::Unknown,
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return SamplePresence::Unknown;
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if sample_id(&name).is_some() || temporary_sample_id(&name).is_some() {
            return SamplePresence::Present;
        }
    }
    SamplePresence::Empty
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn regular_file(path: &Path, maximum: u64) -> Result<fs::Metadata, SampleReadError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err(SampleReadError::Unsafe);
    }
    if metadata.len() > maximum {
        return Err(SampleReadError::Invalid);
    }
    Ok(metadata)
}

fn remove_sample(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(CLEANUP_ERROR.to_string()),
    }
}

fn truncate(text: &mut String, maximum: usize) {
    let mut end = maximum.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
}

impl ContentSampling {
    pub(super) fn new(gateway_directory: &Path, secrets: Arc<dyn SecretStore>) -> Self {
        Self::new_with_listing(gateway_directory, secrets, |directory| {
            fs::read_dir(directory)
        })
    }

    fn new_with_listing(
        gateway_directory: &Path,
        secrets: Arc<dyn SecretStore>,
        list: impl FnOnce(&Path) -> io::Result<fs::ReadDir>,
    ) -> Self {
        let directory = gateway_directory.join(SAMPLE_DIRECTORY);
        let sample_presence = initial_sample_presence(list(&directory));
        let state_file = gateway_directory.join(STATE_FILE);
        let (configuration, error) = if !state_file.exists() {
            (Configuration::default(), None)
        } else {
            let loaded = regular_file(&state_file, 4096)
                .map_err(|_| STORE_ERROR.to_string())
                .and_then(|_| fs::read(&state_file).map_err(|_| STORE_ERROR.to_string()))
                .and_then(|bytes| {
                    serde_json::from_slice::<Configuration>(&bytes)
                        .map_err(|_| STORE_ERROR.to_string())
                });
            match loaded {
                Ok(configuration) if Self::valid_configuration(&configuration) => {
                    (configuration, None)
                }
                _ => (Configuration::default(), Some(STORE_ERROR.to_string())),
            }
        };
        Self {
            directory,
            state_file,
            secrets,
            inner: Mutex::new(Inner {
                configuration,
                generation: Arc::new(AtomicUsize::new(0)),
                key_paused: false,
                error,
            }),
            pending: Arc::new(AtomicUsize::new(0)),
            ready: AtomicBool::new(false),
            skipped: AtomicBool::new(false),
            activity_hint: AtomicU8::new(SamplingActivity::Off as u8),
            sample_presence: AtomicU8::new(sample_presence as u8),
            #[cfg(test)]
            sample_writer: None,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| {
            let mut state = poisoned.into_inner();
            state.configuration = Configuration::default();
            state.revoke_tickets();
            state.error = Some(STORE_ERROR.to_string());
            state
        })
    }

    fn valid_configuration(configuration: &Configuration) -> bool {
        let valid_filter = |value: &Option<String>| {
            value.as_ref().is_none_or(|value| {
                !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
            })
        };
        valid_filter(&configuration.agent)
            && valid_filter(&configuration.group)
            && match configuration.mode {
                SamplingMode::Off => true,
                SamplingMode::Next => configuration
                    .remaining
                    .is_some_and(|remaining| (1..=MAX_SAMPLES as u32).contains(&remaining)),
                SamplingMode::Filter => {
                    configuration.expires_at.is_some()
                        && (configuration.agent.is_some()
                            || configuration.group.is_some()
                            || configuration.failures_only)
                }
            }
    }

    fn ensure_directory(&self) -> Result<(), String> {
        let parent = self
            .directory
            .parent()
            .ok_or_else(|| STORE_ERROR.to_string())?;
        for directory in [parent, &self.directory] {
            match fs::symlink_metadata(directory) {
                Ok(metadata) if metadata.is_dir() && !is_link(&metadata) => {}
                Ok(_) => return Err(STORE_ERROR.to_string()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir_all(directory).map_err(|_| STORE_ERROR.to_string())?;
                }
                Err(_) => return Err(STORE_ERROR.to_string()),
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| STORE_ERROR.to_string())?;
        }
        Ok(())
    }

    fn persist(&self, inner: &mut Inner) -> Result<(), String> {
        let result = self.ensure_directory().and_then(|()| {
            let bytes =
                serde_json::to_vec(&inner.configuration).map_err(|_| STORE_ERROR.to_string())?;
            super::atomic_write(&self.state_file, &bytes, || Ok(()))
                .map_err(|_| STORE_ERROR.to_string())
        });
        if result.is_err() {
            inner.configuration = Configuration::default();
            inner.revoke_tickets();
            inner.error = Some(STORE_ERROR.to_string());
            self.ready.store(false, Ordering::SeqCst);
            return Err(STORE_ERROR.to_string());
        }
        Ok(())
    }

    fn files(&self) -> Result<Vec<SampleFile>, String> {
        self.files_with(|| fs::read_dir(&self.directory))
    }

    fn files_with(
        &self,
        read_dir: impl FnOnce() -> io::Result<fs::ReadDir>,
    ) -> Result<Vec<SampleFile>, String> {
        let result = self.scan_files(read_dir);
        self.set_sample_presence(match &result {
            Ok(files) if files.is_empty() => SamplePresence::Empty,
            Ok(_) => SamplePresence::Present,
            Err(_) => SamplePresence::Unknown,
        });
        result
    }

    fn scan_files(
        &self,
        read_dir: impl FnOnce() -> io::Result<fs::ReadDir>,
    ) -> Result<Vec<SampleFile>, String> {
        if !self
            .directory
            .try_exists()
            .map_err(|_| READ_RETRY.to_string())?
        {
            return Ok(Vec::new());
        }
        self.ensure_directory()?;
        let mut files = Vec::new();
        for entry in read_dir().map_err(|_| STORE_ERROR.to_string())? {
            let entry = entry.map_err(|_| STORE_ERROR.to_string())?;
            let filename = entry.file_name().to_string_lossy().into_owned();
            if temporary_sample_id(&filename).is_some() {
                remove_sample(&entry.path())?;
                continue;
            }
            let Some(id) = sample_id(&filename) else {
                continue;
            };
            let path = entry.path();
            let mut bytes = MAX_SAMPLE_BYTES as u64;
            let header = regular_file(&path, MAX_SAMPLE_BYTES as u64).and_then(|metadata| {
                bytes = metadata.len();
                if bytes < HEADER_BYTES as u64 {
                    return Err(SampleReadError::Invalid);
                }
                let mut header = [0u8; HEADER_BYTES];
                fs::File::open(&path)?.read_exact(&mut header)?;
                if &header[..8] != MAGIC {
                    return Err(SampleReadError::Invalid);
                }
                Ok(i64::from_be_bytes(
                    header[8..16].try_into().unwrap_or_default(),
                ))
            });
            let created_at = match header {
                Ok(created_at) => Some(created_at),
                Err(SampleReadError::Unavailable) => None,
                Err(SampleReadError::Missing) => continue,
                Err(SampleReadError::Invalid) => {
                    if remove_sample(&path).is_err() {
                        files.push(SampleFile {
                            id: id.to_string(),
                            path,
                            created_at: None,
                            cleanup_failed: true,
                            bytes,
                        });
                    }
                    continue;
                }
                Err(SampleReadError::Unsafe) => return Err(STORE_ERROR.to_string()),
            };
            files.push(SampleFile {
                id: id.to_string(),
                path,
                created_at,
                cleanup_failed: false,
                bytes,
            });
        }
        files.sort_by_key(|file| (file.created_at, file.id.clone()));
        Ok(files)
    }

    fn set_sample_presence(&self, presence: SamplePresence) {
        self.sample_presence.store(presence as u8, Ordering::SeqCst);
    }

    fn clear_files(&self, ids: Option<&[String]>) -> Result<(), String> {
        self.set_sample_presence(SamplePresence::Unknown);
        if !self
            .directory
            .try_exists()
            .map_err(|_| CLEANUP_ERROR.to_string())?
        {
            self.set_sample_presence(SamplePresence::Empty);
            return Ok(());
        }
        self.ensure_directory()?;
        for entry in fs::read_dir(&self.directory).map_err(|_| STORE_ERROR.to_string())? {
            let entry = entry.map_err(|_| STORE_ERROR.to_string())?;
            let filename = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = sample_id(&filename).or_else(|| temporary_sample_id(&filename)) else {
                continue;
            };
            if ids.is_none_or(|ids| ids.iter().any(|wanted| wanted == id)) {
                remove_sample(&entry.path())?;
            }
        }
        if ids.is_none() {
            self.set_sample_presence(SamplePresence::Empty);
        }
        Ok(())
    }

    fn key(&self, create: bool, inner: &mut Inner) -> Result<LessSafeKey, String> {
        let value = match self.secrets.get_classified(KEY_ACCOUNT) {
            Ok(Some(value)) => value,
            Ok(None)
                if create
                    && inner.configuration.mode == SamplingMode::Off
                    && self.files()?.is_empty() =>
            {
                let mut bytes = [0u8; 32];
                getrandom::fill(&mut bytes).map_err(|_| KEY_CREATE_ERROR.to_string())?;
                let value: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
                bytes.fill(0);
                self.secrets
                    .set(KEY_ACCOUNT, &value)
                    .map_err(|_| KEY_CREATE_ERROR.to_string())?;
                match self.secrets.get_classified(KEY_ACCOUNT) {
                    Ok(Some(verified)) if verified == value => value,
                    Err(SecretReadError::Unavailable) => return Err(self.pause_for_key(inner)),
                    _ => return Err(KEY_CREATE_ERROR.to_string()),
                }
            }
            Err(SecretReadError::Unavailable) => return Err(self.pause_for_key(inner)),
            Ok(None) | Err(SecretReadError::InvalidEncoding) => return Err(self.key_lost(inner)),
        };
        let decoded = decode_key(&value);
        let Some(mut decoded) = decoded else {
            return Err(self.key_lost(inner));
        };
        let key = UnboundKey::new(&CHACHA20_POLY1305, &decoded);
        decoded.fill(0);
        let key = key
            .map(LessSafeKey::new)
            .map_err(|_| self.key_lost(inner))?;
        if inner.key_paused {
            inner.key_paused = false;
            if inner.error.as_deref() == Some(KEY_UNAVAILABLE) {
                inner.error = None;
            }
            self.ready.store(true, Ordering::SeqCst);
        }
        Ok(key)
    }

    fn pause_for_key(&self, inner: &mut Inner) -> String {
        self.ready.store(false, Ordering::SeqCst);
        inner.revoke_tickets();
        inner.key_paused = true;
        self.activity_hint.store(
            if inner.configuration.mode == SamplingMode::Off {
                SamplingActivity::Off
            } else {
                SamplingActivity::Paused
            } as u8,
            Ordering::SeqCst,
        );
        inner.error = Some(KEY_UNAVAILABLE.to_string());
        KEY_UNAVAILABLE.to_string()
    }

    fn key_lost(&self, inner: &mut Inner) -> String {
        self.ready.store(false, Ordering::SeqCst);
        inner.key_paused = false;
        inner.configuration = Configuration::default();
        inner.revoke_tickets();
        let cleared = self.clear_files(None).is_ok();
        let persisted = self.persist(inner).is_ok();
        let error = if cleared && persisted {
            KEY_ERROR.to_string()
        } else {
            "内容采样密钥不可用，已停止采样；样本清理尚未完成，请重试删除。".to_string()
        };
        inner.error = Some(error.clone());
        error
    }

    fn maintain(&self, inner: &mut Inner, now: i64) -> Result<Vec<SampleFile>, String> {
        if inner.configuration.mode == SamplingMode::Filter
            && inner
                .configuration
                .expires_at
                .is_none_or(|expires| expires <= now || expires > now + 24 * 3600)
        {
            inner.configuration = Configuration::default();
            inner.revoke_tickets();
            self.persist(inner)?;
        }
        self.retain(self.files()?, now)
    }

    fn retain(&self, mut files: Vec<SampleFile>, now: i64) -> Result<Vec<SampleFile>, String> {
        files.sort_by(|a, b| (a.created_at, a.id.as_str()).cmp(&(b.created_at, b.id.as_str())));
        let ages_known = files.iter().all(|file| file.created_at.is_some());
        let mut retained = Vec::new();
        let mut total = 0u64;
        for file in files.into_iter().rev() {
            if file.created_at.is_some_and(|created_at| {
                created_at < now - RETENTION_SECONDS
                    || created_at > now + 60
                    || (ages_known
                        && (retained.len() >= MAX_SAMPLES || total + file.bytes > MAX_DISK_BYTES))
            }) {
                remove_sample(&file.path)?;
            } else {
                total += file.bytes;
                retained.push(file);
            }
        }
        self.set_sample_presence(if retained.is_empty() {
            SamplePresence::Empty
        } else {
            SamplePresence::Present
        });
        Ok(retained)
    }

    fn snapshot(&self, inner: &Inner, files: &[SampleFile]) -> SamplingStatus {
        SamplingStatus {
            mode: inner.configuration.mode,
            paused: inner.key_paused,
            pending: inner.has_pending_ticket(),
            remaining: inner.configuration.remaining,
            expires_at: inner.configuration.expires_at.and_then(timestamp),
            agent: inner.configuration.agent.clone(),
            group: inner.configuration.group.clone(),
            failures_only: inner.configuration.failures_only,
            sample_ids: files.iter().map(|file| file.id.clone()).collect(),
            stored_count: files.len(),
            stored_bytes: files.iter().map(|file| file.bytes).sum(),
            error: if files.iter().any(|file| file.cleanup_failed) {
                Some(CLEANUP_ERROR.to_string())
            } else {
                inner.error.clone()
            },
        }
    }

    fn clear_pause_if_unused(&self, inner: &mut Inner, files: &[SampleFile]) {
        if inner.key_paused && inner.configuration.mode == SamplingMode::Off && files.is_empty() {
            inner.key_paused = false;
            if inner.error.as_deref() == Some(KEY_UNAVAILABLE) {
                inner.error = None;
            }
            self.ready.store(true, Ordering::SeqCst);
        }
    }

    pub(super) fn status(&self) -> SamplingStatus {
        let mut inner = self.lock();
        let mut files = match self.maintain(&mut inner, Utc::now().timestamp()) {
            Ok(files) => files,
            Err(error) => {
                inner.configuration = Configuration::default();
                inner.revoke_tickets();
                let _ = self.persist(&mut inner);
                inner.error = Some(error);
                Vec::new()
            }
        };
        let needs_key = !files.is_empty() || inner.configuration.mode != SamplingMode::Off;
        if needs_key && self.key(false, &mut inner).is_err() {
            if !inner.key_paused {
                files = self.files().unwrap_or(files);
            }
        } else {
            self.clear_pause_if_unused(&mut inner, &files);
            self.ready.store(true, Ordering::SeqCst);
        }
        if inner.error.is_none() && self.skipped.load(Ordering::SeqCst) {
            inner.error = Some("部分请求因采样存储繁忙未采集，请查看已保存条数。".to_string());
        }
        self.snapshot(&inner, &files)
    }

    pub(super) fn configure(&self, input: SamplingInput) -> Result<SamplingStatus, String> {
        let mut inner = self.lock();
        if input.mode == SamplingMode::Off {
            inner.revoke_tickets();
            inner.configuration = Configuration::default();
            self.activity_hint
                .store(SamplingActivity::Off as u8, Ordering::SeqCst);
            self.persist(&mut inner)?;
            if input.delete_existing.unwrap_or(true) && self.clear_files(None).is_err() {
                let error = "已停止采样，样本清理尚未完成，请重试删除。".to_string();
                inner.error = Some(error.clone());
                return Err(error);
            }
        } else {
            if !input.confirmed {
                return Err("开启前请确认请求内容采样的本机保存与隐私说明。".to_string());
            }
            let hours = input.duration_hours.unwrap_or(24);
            let configuration = Configuration {
                mode: input.mode,
                remaining: (input.mode == SamplingMode::Next).then_some(input.count.unwrap_or(20)),
                expires_at: (input.mode == SamplingMode::Filter)
                    .then_some(Utc::now().timestamp() + i64::from(hours) * 3600),
                agent: input.agent.filter(|value| !value.trim().is_empty()),
                group: input.group.filter(|value| !value.trim().is_empty()),
                failures_only: input.failures_only,
            };
            if !Self::valid_configuration(&configuration)
                || (input.mode == SamplingMode::Filter && !(1..=24).contains(&hours))
                || (input.mode == SamplingMode::Next
                    && (configuration.agent.is_some()
                        || configuration.group.is_some()
                        || configuration.failures_only))
            {
                return Err("采样数量、筛选条件或有效时间无效。".to_string());
            }
            self.ensure_directory()?;
            self.key(true, &mut inner)?;
            inner.revoke_tickets();
            inner.configuration = configuration;
            self.persist(&mut inner)?;
        }
        inner.error = inner.key_paused.then(|| KEY_UNAVAILABLE.to_string());
        self.skipped.store(false, Ordering::SeqCst);
        self.ready.store(!inner.key_paused, Ordering::SeqCst);
        let files = self.maintain(&mut inner, Utc::now().timestamp())?;
        self.clear_pause_if_unused(&mut inner, &files);
        Ok(self.snapshot(&inner, &files))
    }

    pub(super) fn stop_from_tray(&self, report_error: impl FnOnce(String)) {
        if let Err(error) = self.configure(SamplingInput::default()) {
            report_error(error);
        }
    }

    pub(super) fn reserve(&self) -> Option<PendingSample> {
        if !self.ready.load(Ordering::SeqCst) {
            return None;
        }
        let Ok(inner) = self.inner.try_lock() else {
            self.mark_skipped();
            return None;
        };
        if inner.key_paused || inner.configuration.mode == SamplingMode::Off {
            return None;
        }
        if self
            .pending
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                (count < 8).then_some(count + 1)
            })
            .is_err()
        {
            self.mark_skipped();
            return None;
        }
        Some(PendingSample {
            slots: Arc::clone(&self.pending),
            generation: Arc::clone(&inner.generation),
            active: false,
        })
    }

    pub(super) fn mark_skipped(&self) {
        self.skipped.store(true, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(super) fn begin(
        &self,
        id: &str,
        agent: Option<&str>,
        group: Option<&str>,
        stream: bool,
        request: CapturedContent,
    ) -> Option<SampleTicket> {
        self.begin_reserved(self.reserve()?, id, agent, group, stream, request)
    }

    pub(super) fn begin_reserved(
        &self,
        mut slot: PendingSample,
        id: &str,
        agent: Option<&str>,
        group: Option<&str>,
        stream: bool,
        request: CapturedContent,
    ) -> Option<SampleTicket> {
        if !self.ready.load(Ordering::SeqCst) {
            return None;
        }
        let Ok(mut inner) = self.inner.try_lock() else {
            self.skipped.store(true, Ordering::SeqCst);
            return None;
        };
        let now = Utc::now().timestamp();
        let configuration = &inner.configuration;
        if !Arc::ptr_eq(&slot.generation, &inner.generation)
            || !safe_id(id)
            || configuration.mode == SamplingMode::Off
            || configuration
                .expires_at
                .is_some_and(|expires| expires <= now)
            || configuration
                .agent
                .as_deref()
                .is_some_and(|wanted| Some(wanted) != agent)
            || configuration
                .group
                .as_deref()
                .is_some_and(|wanted| Some(wanted) != group)
        {
            return None;
        }
        let failures_only = configuration.failures_only;
        if configuration.mode == SamplingMode::Next {
            let remaining = configuration.remaining?.checked_sub(1)?;
            if remaining == 0 {
                // 限量自动停止仍接纳已预留的请求；手动关闭才撤销整代请求。
                inner.configuration = Configuration::default();
            } else {
                inner.configuration.remaining = Some(remaining);
            }
            if self.persist(&mut inner).is_err() {
                return None;
            }
        }
        slot.active = true;
        slot.generation.fetch_add(1, Ordering::SeqCst);
        Some(SampleTicket {
            slot,
            id: id.to_string(),
            created_at: now,
            stream,
            failures_only,
            request,
        })
    }

    pub(super) fn finish(
        &self,
        ticket: SampleTicket,
        response: CapturedContent,
        status: u16,
        incomplete: bool,
    ) -> Result<(), String> {
        let mut inner = self.lock();
        if !Arc::ptr_eq(&ticket.slot.generation, &inner.generation)
            || (ticket.failures_only && status < 400 && !incomplete && !response.failed)
        {
            return Ok(());
        }
        let now = Utc::now().timestamp();
        let mut files = match self.maintain(&mut inner, now) {
            Ok(files) => files,
            Err(error) => {
                self.stop_for_store_error(&mut inner, &error);
                return Err(error);
            }
        };
        if !Arc::ptr_eq(&ticket.slot.generation, &inner.generation) {
            return Ok(());
        }
        let key = self.key(false, &mut inner)?;
        let result = self
            .write_sample(&files, &key, ticket, response, status, incomplete)
            .and_then(|written| {
                if let Some(file) = written {
                    // Use the same ages for the capacity check and eviction under the sampling lock.
                    files.push(file);
                    self.retain(files, now)?;
                }
                Ok(())
            });
        if let Err(error) = &result {
            self.stop_for_store_error(&mut inner, error);
        }
        result
    }

    fn stop_for_store_error(&self, inner: &mut Inner, error: &str) {
        self.ready.store(false, Ordering::SeqCst);
        inner.configuration = Configuration::default();
        inner.revoke_tickets();
        let _ = self.persist(inner);
        inner.error = Some(error.to_string());
    }

    fn write_sample(
        &self,
        files: &[SampleFile],
        key: &LessSafeKey,
        ticket: SampleTicket,
        response: CapturedContent,
        status: u16,
        incomplete: bool,
    ) -> Result<Option<SampleFile>, String> {
        self.set_sample_presence(SamplePresence::Unknown);
        let mut sample = ContentSample {
            id: ticket.id,
            created_at: timestamp(ticket.created_at).ok_or_else(|| STORE_ERROR.to_string())?,
            status,
            stream: ticket.stream,
            truncated: ticket.request.truncated
                || response.truncated
                || incomplete
                || ticket.request.text.len() > CONTENT_BUDGET
                || response.text.len() > CONTENT_BUDGET,
            request: ticket.request.text,
            response: response.text,
        };
        truncate(&mut sample.request, CONTENT_BUDGET);
        truncate(&mut sample.response, CONTENT_BUDGET);
        let mut plaintext = serde_json::to_vec(&sample).map_err(|_| STORE_ERROR.to_string())?;
        while plaintext.len() > MAX_PLAINTEXT {
            let request_limit = sample.request.len() / 2;
            let response_limit = sample.response.len() / 2;
            truncate(&mut sample.request, request_limit);
            truncate(&mut sample.response, response_limit);
            sample.truncated = true;
            plaintext = serde_json::to_vec(&sample).map_err(|_| STORE_ERROR.to_string())?;
        }
        let sample_bytes = HEADER_BYTES + plaintext.len() + CHACHA20_POLY1305.tag_len();
        if files.iter().any(|file| file.created_at.is_none())
            && (files.len() >= MAX_SAMPLES
                || files.iter().map(|file| file.bytes).sum::<u64>() + sample_bytes as u64
                    > MAX_DISK_BYTES)
        {
            self.mark_skipped();
            return Ok(None);
        }
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).map_err(|_| STORE_ERROR.to_string())?;
        let aad = format!("v1\n{}\n{}", sample.id, ticket.created_at);
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(aad),
            &mut plaintext,
        )
        .map_err(|_| STORE_ERROR.to_string())?;
        let mut bytes = Vec::with_capacity(HEADER_BYTES + plaintext.len());
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&ticket.created_at.to_be_bytes());
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&plaintext);
        let destination = self.directory.join(format!("{}.bin", sample.id));
        if destination.exists() {
            return Err(STORE_ERROR.to_string());
        }
        self.write_sample_file(&destination, &bytes)?;
        self.set_sample_presence(SamplePresence::Present);
        Ok(Some(SampleFile {
            id: sample.id,
            path: destination,
            created_at: Some(ticket.created_at),
            cleanup_failed: false,
            bytes: bytes.len() as u64,
        }))
    }

    fn write_sample_file(&self, destination: &Path, bytes: &[u8]) -> Result<(), String> {
        #[cfg(test)]
        if let Some(write) = self.sample_writer {
            return write(destination, bytes);
        }
        super::atomic_write(destination, bytes, || {
            if destination.exists() {
                Err(STORE_ERROR.to_string())
            } else {
                Ok(())
            }
        })
        .map_err(|_| STORE_ERROR.to_string())
    }

    pub(super) fn read(&self, id: &str) -> Result<ContentSample, String> {
        if !safe_id(id) {
            return Err(READ_ERROR.to_string());
        }
        let mut inner = self.lock();
        let files = self.maintain(&mut inner, Utc::now().timestamp())?;
        let file = files
            .iter()
            .find(|file| file.id == id)
            .ok_or_else(|| READ_ERROR.to_string())?;
        let created_at = file.created_at.ok_or_else(|| {
            if file.cleanup_failed {
                CLEANUP_ERROR
            } else {
                READ_RETRY
            }
            .to_string()
        })?;
        let key = self.key(false, &mut inner)?;
        let result = (|| {
            let metadata = regular_file(&file.path, MAX_SAMPLE_BYTES as u64)?;
            let mut bytes = Vec::new();
            fs::File::open(&file.path)?
                .take((MAX_SAMPLE_BYTES + 1) as u64)
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 != metadata.len() {
                return Err(SampleReadError::Unavailable);
            }
            if bytes.len() < HEADER_BYTES + CHACHA20_POLY1305.tag_len() || &bytes[..8] != MAGIC {
                return Err(SampleReadError::Invalid);
            }
            let nonce: [u8; 12] = bytes[16..HEADER_BYTES]
                .try_into()
                .map_err(|_| SampleReadError::Invalid)?;
            let aad = format!("v1\n{id}\n{created_at}");
            let plaintext = key
                .open_in_place(
                    Nonce::assume_unique_for_key(nonce),
                    Aad::from(aad),
                    &mut bytes[HEADER_BYTES..],
                )
                .map_err(|_| SampleReadError::Invalid)?;
            let sample: ContentSample =
                serde_json::from_slice(plaintext).map_err(|_| SampleReadError::Invalid)?;
            if sample.id != id || Some(&sample.created_at) != timestamp(created_at).as_ref() {
                return Err(SampleReadError::Invalid);
            }
            Ok(sample)
        })();
        match result {
            Ok(sample) => Ok(sample),
            Err(SampleReadError::Unavailable) => Err(READ_RETRY.to_string()),
            Err(SampleReadError::Missing | SampleReadError::Unsafe) => Err(READ_ERROR.to_string()),
            Err(SampleReadError::Invalid) => {
                if let Err(error) = remove_sample(&file.path) {
                    inner.error = Some(error.clone());
                    return Err(error);
                }
                if files.len() == 1 {
                    self.set_sample_presence(SamplePresence::Empty);
                }
                if inner.error.as_deref() == Some(CLEANUP_ERROR) {
                    inner.error = None;
                }
                Err(READ_ERROR.to_string())
            }
        }
    }

    pub(super) fn eligible(&self, agent: Option<&str>, group: Option<&str>) -> bool {
        if !self.ready.load(Ordering::SeqCst) {
            return false;
        }
        let Ok(inner) = self.inner.try_lock() else {
            self.skipped.store(true, Ordering::SeqCst);
            return false;
        };
        let configuration = &inner.configuration;
        !inner.key_paused
            && configuration.mode != SamplingMode::Off
            && configuration
                .expires_at
                .is_none_or(|expires| expires > Utc::now().timestamp())
            && configuration
                .agent
                .as_deref()
                .is_none_or(|wanted| Some(wanted) == agent)
            && configuration
                .group
                .as_deref()
                .is_none_or(|wanted| Some(wanted) == group)
    }

    pub(super) fn activity(&self) -> SamplingActivity {
        let Ok(inner) = self.inner.try_lock() else {
            return match self.activity_hint.load(Ordering::SeqCst) {
                value if value == SamplingActivity::Active as u8 => SamplingActivity::Active,
                value if value == SamplingActivity::Paused as u8 => SamplingActivity::Paused,
                _ => SamplingActivity::Off,
            };
        };
        let activity = if (inner.configuration.mode == SamplingMode::Off
            && !inner.has_pending_ticket())
            || inner
                .configuration
                .expires_at
                .is_some_and(|expires| expires <= Utc::now().timestamp())
        {
            SamplingActivity::Off
        } else if inner.key_paused || !self.ready.load(Ordering::SeqCst) {
            SamplingActivity::Paused
        } else {
            SamplingActivity::Active
        };
        self.activity_hint.store(activity as u8, Ordering::SeqCst);
        activity
    }

    pub(super) fn tray_state(&self) -> (SamplingActivity, bool) {
        let activity = self.activity();
        let can_stop = activity != SamplingActivity::Off
            || self.sample_presence.load(Ordering::SeqCst) != SamplePresence::Empty as u8;
        (activity, can_stop)
    }

    #[cfg(test)]
    pub(super) fn pending_count(&self) -> usize {
        self.pending.load(Ordering::SeqCst)
    }

    pub(super) fn delete(&self, ids: Option<Vec<String>>) -> Result<SamplingStatus, String> {
        if ids
            .as_ref()
            .is_some_and(|ids| ids.len() > MAX_SAMPLES || ids.iter().any(|id| !safe_id(id)))
        {
            return Err("内容样本标识无效。".to_string());
        }
        let mut inner = self.lock();
        // 删除也撤销在途采样，避免清空后旧请求的回执又生成文件。
        inner.revoke_tickets();
        if self.clear_files(ids.as_deref()).is_err() {
            let error = "内容样本删除尚未完成，请重试。".to_string();
            inner.error = Some(error.clone());
            return Err(error);
        }
        inner.error = inner.key_paused.then(|| KEY_UNAVAILABLE.to_string());
        let files = self.maintain(&mut inner, Utc::now().timestamp())?;
        self.clear_pause_if_unused(&mut inner, &files);
        Ok(self.snapshot(&inner, &files))
    }
}

#[cfg(test)]
#[path = "content_sampling_tests.rs"]
mod tests;
