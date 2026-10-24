use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::{DateTime, Utc};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305};
use serde::{Deserialize, Serialize};

use super::content_capture::CapturedContent;
use super::store::SecretStore;

const KEY_ACCOUNT: &str = "content-sampling-key";
const STATE_FILE: &str = "sampling-state-v1.json";
pub(crate) const SAMPLE_DIRECTORY: &str = "samples-v1";
const MAGIC: &[u8; 8] = b"TLSMP001";
const HEADER_BYTES: usize = 28;
const MAX_SAMPLES: usize = 200;
const MAX_DISK_BYTES: u64 = 50 * 1024 * 1024;
const MAX_PLAINTEXT: usize = 256 * 1024;
pub(super) const CONTENT_BUDGET: usize = (MAX_PLAINTEXT - 2048) / 2;
const RETENTION_SECONDS: i64 = 7 * 24 * 60 * 60;
const STORE_ERROR: &str = "内容采样存储不可用，已停止采样。";
const KEY_ERROR: &str = "内容采样密钥不可用，已停止采样并清理样本。";
const READ_ERROR: &str = "此内容样本不可用或已损坏。";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SamplingMode {
    #[default]
    Off,
    Next,
    Filter,
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
    generation: u64,
    error: Option<String>,
}

pub(super) struct SampleTicket {
    _slot: PendingSample,
    generation: u64,
    id: String,
    created_at: i64,
    stream: bool,
    failures_only: bool,
    request: CapturedContent,
}

pub(super) struct PendingSample(Arc<AtomicUsize>, u64);

impl Drop for PendingSample {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct SampleFile {
    id: String,
    path: PathBuf,
    created_at: i64,
    bytes: u64,
}

pub(super) struct ContentSampling {
    directory: PathBuf,
    state_file: PathBuf,
    secrets: Arc<dyn SecretStore>,
    inner: Mutex<Inner>,
    pending: Arc<AtomicUsize>,
    ready: AtomicBool,
    skipped: AtomicBool,
    active_hint: AtomicBool,
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

fn regular_file(path: &Path, maximum: u64) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| READ_ERROR.to_string())?;
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > maximum {
        return Err(READ_ERROR.to_string());
    }
    Ok(metadata)
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
        let state_file = gateway_directory.join(STATE_FILE);
        let (configuration, error) = if !state_file.exists() {
            (Configuration::default(), None)
        } else {
            let loaded = regular_file(&state_file, 4096)
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
            directory: gateway_directory.join(SAMPLE_DIRECTORY),
            state_file,
            secrets,
            inner: Mutex::new(Inner {
                configuration,
                generation: 0,
                error,
            }),
            pending: Arc::new(AtomicUsize::new(0)),
            ready: AtomicBool::new(false),
            skipped: AtomicBool::new(false),
            active_hint: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| {
            let mut state = poisoned.into_inner();
            state.configuration = Configuration::default();
            state.generation = state.generation.wrapping_add(1);
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
            inner.generation = inner.generation.wrapping_add(1);
            inner.error = Some(STORE_ERROR.to_string());
            self.ready.store(false, Ordering::SeqCst);
            return Err(STORE_ERROR.to_string());
        }
        Ok(())
    }

    fn files(&self) -> Result<Vec<SampleFile>, String> {
        if !self.directory.exists() {
            return Ok(Vec::new());
        }
        self.ensure_directory()?;
        let mut files = Vec::new();
        for entry in fs::read_dir(&self.directory).map_err(|_| STORE_ERROR.to_string())? {
            let entry = entry.map_err(|_| STORE_ERROR.to_string())?;
            let filename = entry.file_name().to_string_lossy().into_owned();
            if temporary_sample_id(&filename).is_some() {
                fs::remove_file(entry.path()).map_err(|_| STORE_ERROR.to_string())?;
                continue;
            }
            let Some(id) = filename.strip_suffix(".bin").filter(|id| safe_id(id)) else {
                continue;
            };
            let path = entry.path();
            let metadata = regular_file(&path, (MAX_PLAINTEXT + HEADER_BYTES + 16) as u64)?;
            let mut header = [0u8; HEADER_BYTES];
            let valid = fs::File::open(&path)
                .and_then(|mut file| file.read_exact(&mut header))
                .is_ok()
                && &header[..8] == MAGIC;
            if !valid {
                fs::remove_file(path).map_err(|_| STORE_ERROR.to_string())?;
                continue;
            }
            let created_at = i64::from_be_bytes(header[8..16].try_into().unwrap_or_default());
            files.push(SampleFile {
                id: id.to_string(),
                path,
                created_at,
                bytes: metadata.len(),
            });
        }
        files.sort_by_key(|file| (file.created_at, file.id.clone()));
        Ok(files)
    }

    fn clear_files(&self, ids: Option<&[String]>) -> Result<(), String> {
        if !self.directory.exists() {
            return Ok(());
        }
        self.ensure_directory()?;
        for entry in fs::read_dir(&self.directory).map_err(|_| STORE_ERROR.to_string())? {
            let entry = entry.map_err(|_| STORE_ERROR.to_string())?;
            let filename = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = filename
                .strip_suffix(".bin")
                .filter(|id| safe_id(id))
                .or_else(|| temporary_sample_id(&filename))
            else {
                continue;
            };
            if ids.is_none_or(|ids| ids.iter().any(|wanted| wanted == id)) {
                fs::remove_file(entry.path()).map_err(|_| STORE_ERROR.to_string())?;
            }
        }
        Ok(())
    }

    fn key(&self, create: bool, inner: &mut Inner) -> Result<LessSafeKey, String> {
        let read = self.secrets.get(KEY_ACCOUNT);
        let value = match read {
            Ok(Some(value)) => value,
            Ok(None) if create && self.files()?.is_empty() => {
                let mut bytes = [0u8; 32];
                getrandom::fill(&mut bytes).map_err(|_| KEY_ERROR.to_string())?;
                let value: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
                bytes.fill(0);
                self.secrets
                    .set(KEY_ACCOUNT, &value)
                    .map_err(|_| KEY_ERROR.to_string())?;
                if self.secrets.get(KEY_ACCOUNT).ok().flatten().as_ref() != Some(&value) {
                    return Err(KEY_ERROR.to_string());
                }
                value
            }
            _ => {
                self.key_lost(inner);
                return Err(inner.error.clone().unwrap_or_else(|| KEY_ERROR.to_string()));
            }
        };
        let decoded: Option<Vec<u8>> = (value.len() == 64)
            .then(|| {
                value
                    .as_bytes()
                    .chunks_exact(2)
                    .map(|pair| {
                        let hex = std::str::from_utf8(pair).ok()?;
                        u8::from_str_radix(hex, 16).ok()
                    })
                    .collect()
            })
            .flatten();
        let Some(mut decoded) = decoded else {
            self.key_lost(inner);
            return Err(KEY_ERROR.to_string());
        };
        let key = UnboundKey::new(&CHACHA20_POLY1305, &decoded);
        decoded.fill(0);
        key.map(LessSafeKey::new).map_err(|_| KEY_ERROR.to_string())
    }

    fn key_lost(&self, inner: &mut Inner) {
        inner.configuration = Configuration::default();
        inner.generation = inner.generation.wrapping_add(1);
        let cleared = self.clear_files(None).is_ok();
        let persisted = self.persist(inner).is_ok();
        inner.error = Some(if cleared && persisted {
            KEY_ERROR.to_string()
        } else {
            "内容采样密钥不可用，已停止采样；样本清理尚未完成，请重试删除。".to_string()
        });
    }

    fn maintain(&self, inner: &mut Inner, now: i64) -> Result<Vec<SampleFile>, String> {
        if inner.configuration.mode == SamplingMode::Filter
            && inner
                .configuration
                .expires_at
                .is_none_or(|expires| expires <= now || expires > now + 24 * 3600)
        {
            inner.configuration = Configuration::default();
            inner.generation = inner.generation.wrapping_add(1);
            self.persist(inner)?;
        }
        let files = self.files()?;
        let mut retained = Vec::new();
        let mut total = 0u64;
        for file in files.into_iter().rev() {
            if file.created_at < now - RETENTION_SECONDS
                || file.created_at > now + 60
                || retained.len() >= MAX_SAMPLES
                || total + file.bytes > MAX_DISK_BYTES
            {
                fs::remove_file(file.path).map_err(|_| STORE_ERROR.to_string())?;
            } else {
                total += file.bytes;
                retained.push(file);
            }
        }
        Ok(retained)
    }

    fn snapshot(&self, inner: &Inner, files: &[SampleFile]) -> SamplingStatus {
        SamplingStatus {
            mode: inner.configuration.mode,
            remaining: inner.configuration.remaining,
            expires_at: inner.configuration.expires_at.and_then(timestamp),
            agent: inner.configuration.agent.clone(),
            group: inner.configuration.group.clone(),
            failures_only: inner.configuration.failures_only,
            sample_ids: files.iter().map(|file| file.id.clone()).collect(),
            stored_count: files.len(),
            stored_bytes: files.iter().map(|file| file.bytes).sum(),
            error: inner.error.clone(),
        }
    }

    pub(super) fn status(&self) -> SamplingStatus {
        let mut inner = self.lock();
        let mut files = match self.maintain(&mut inner, Utc::now().timestamp()) {
            Ok(files) => files,
            Err(_) => {
                inner.configuration = Configuration::default();
                inner.generation = inner.generation.wrapping_add(1);
                inner.error = Some(STORE_ERROR.to_string());
                let _ = self.persist(&mut inner);
                Vec::new()
            }
        };
        if (!files.is_empty() || inner.configuration.mode != SamplingMode::Off)
            && self.key(false, &mut inner).is_err()
        {
            files = self.files().unwrap_or(files);
            self.ready.store(false, Ordering::SeqCst);
        } else {
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
            inner.generation = inner.generation.wrapping_add(1);
            inner.configuration = Configuration::default();
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
            inner.generation = inner.generation.wrapping_add(1);
            inner.configuration = configuration;
            self.persist(&mut inner)?;
        }
        inner.error = None;
        self.skipped.store(false, Ordering::SeqCst);
        self.ready.store(true, Ordering::SeqCst);
        let files = self.maintain(&mut inner, Utc::now().timestamp())?;
        Ok(self.snapshot(&inner, &files))
    }

    pub(super) fn reserve(&self) -> Option<PendingSample> {
        if !self.ready.load(Ordering::SeqCst) {
            return None;
        }
        let Ok(inner) = self.inner.try_lock() else {
            self.mark_skipped();
            return None;
        };
        if inner.configuration.mode == SamplingMode::Off {
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
        Some(PendingSample(Arc::clone(&self.pending), inner.generation))
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
        slot: PendingSample,
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
        if slot.1 != inner.generation
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
        Some(SampleTicket {
            _slot: slot,
            generation: inner.generation,
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
        let result = self.finish_sample(ticket, response, status, incomplete);
        if let Err(error) = &result {
            self.ready.store(false, Ordering::SeqCst);
            let mut inner = self.lock();
            inner.configuration = Configuration::default();
            inner.generation = inner.generation.wrapping_add(1);
            let _ = self.persist(&mut inner);
            inner.error = Some(error.clone());
        }
        result
    }

    fn finish_sample(
        &self,
        ticket: SampleTicket,
        response: CapturedContent,
        status: u16,
        incomplete: bool,
    ) -> Result<(), String> {
        let mut inner = self.lock();
        if ticket.generation != inner.generation
            || (ticket.failures_only && status < 400 && !incomplete && !response.failed)
        {
            return Ok(());
        }
        let now = Utc::now().timestamp();
        self.maintain(&mut inner, now)?;
        if ticket.generation != inner.generation {
            return Ok(());
        }
        let key = self.key(false, &mut inner)?;
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
        super::atomic_write(&destination, &bytes, || {
            if destination.exists() {
                Err(STORE_ERROR.to_string())
            } else {
                Ok(())
            }
        })
        .map_err(|_| STORE_ERROR.to_string())?;
        self.maintain(&mut inner, now)?;
        Ok(())
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
        let key = self.key(false, &mut inner)?;
        let result = (|| {
            regular_file(&file.path, (MAX_PLAINTEXT + HEADER_BYTES + 16) as u64)?;
            let mut bytes = Vec::new();
            fs::File::open(&file.path)
                .and_then(|file| {
                    file.take((MAX_PLAINTEXT + HEADER_BYTES + 17) as u64)
                        .read_to_end(&mut bytes)
                })
                .map_err(|_| READ_ERROR.to_string())?;
            if bytes.len() > MAX_PLAINTEXT + HEADER_BYTES + 16 {
                return Err(READ_ERROR.to_string());
            }
            if bytes.len() < HEADER_BYTES + CHACHA20_POLY1305.tag_len() {
                return Err(READ_ERROR.to_string());
            }
            let nonce: [u8; 12] = bytes[16..HEADER_BYTES]
                .try_into()
                .map_err(|_| READ_ERROR.to_string())?;
            let aad = format!("v1\n{id}\n{}", file.created_at);
            let plaintext = key
                .open_in_place(
                    Nonce::assume_unique_for_key(nonce),
                    Aad::from(aad),
                    &mut bytes[HEADER_BYTES..],
                )
                .map_err(|_| READ_ERROR.to_string())?;
            let sample: ContentSample =
                serde_json::from_slice(plaintext).map_err(|_| READ_ERROR.to_string())?;
            if sample.id != id || Some(&sample.created_at) != timestamp(file.created_at).as_ref() {
                return Err(READ_ERROR.to_string());
            }
            Ok(sample)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&file.path);
        }
        result
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
        configuration.mode != SamplingMode::Off
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

    pub(super) fn active(&self) -> bool {
        let Ok(inner) = self.inner.try_lock() else {
            return self.active_hint.load(Ordering::SeqCst);
        };
        let active = inner.configuration.mode != SamplingMode::Off
            && inner
                .configuration
                .expires_at
                .is_none_or(|expires| expires > Utc::now().timestamp());
        self.active_hint.store(active, Ordering::SeqCst);
        active
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
        inner.generation = inner.generation.wrapping_add(1);
        if self.clear_files(ids.as_deref()).is_err() {
            let error = "内容样本删除尚未完成，请重试。".to_string();
            inner.error = Some(error.clone());
            return Err(error);
        }
        inner.error = None;
        let files = self.maintain(&mut inner, Utc::now().timestamp())?;
        Ok(self.snapshot(&inner, &files))
    }
}

#[cfg(test)]
#[path = "content_sampling_tests.rs"]
mod tests;
