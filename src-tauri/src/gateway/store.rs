//! Provider metadata (a JSON file in the app data dir) and secrets (the OS
//! keychain). Keys are written here and read by the gateway process and,
//! read-only, by the quota balance collector (same `provider:<id>` entry, never
//! copied); no command ever returns one.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use reqwest::Url;
use serde::{Deserialize, Serialize};

const STORE_FILE: &str = "providers-v1.json";
const STORE_SCHEMA_VERSION: u8 = 1;
const KEYRING_SERVICE: &str = "com.jeidorf.tokenledger.gateway";
pub const LOCAL_TOKEN_ACCOUNT: &str = "local-token";
const MAX_PROVIDERS: usize = 64;
const MAX_MODELS: usize = 512;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WireApi {
    Responses,
    Chat,
    /// Anthropic Messages (`/v1/messages`), official or a compatible endpoint.
    Anthropic,
}

impl WireApi {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::Chat => "chat",
            Self::Anthropic => "anthropic",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    #[default]
    Key,
    None,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRecord {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub wire: WireApi,
    #[serde(default)]
    pub auth_mode: AuthMode,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    schema_version: u8,
    providers: Vec<ProviderRecord>,
}

pub struct ProviderStore {
    path: PathBuf,
}

impl ProviderStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join(STORE_FILE),
        }
    }

    pub fn load(&self) -> Result<Vec<ProviderRecord>, String> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("读取网关供应商列表失败：{error}")),
        };
        let file: StoreFile = serde_json::from_str(&text)
            .map_err(|error| format!("网关供应商列表已损坏：{error}"))?;
        if file.schema_version != STORE_SCHEMA_VERSION {
            return Err(format!(
                "网关供应商列表版本 {} 不受支持。",
                file.schema_version
            ));
        }
        Ok(file.providers)
    }

    pub fn save(&self, providers: &[ProviderRecord]) -> Result<(), String> {
        let body = serde_json::to_vec_pretty(&StoreFile {
            schema_version: STORE_SCHEMA_VERSION,
            providers: providers.to_vec(),
        })
        .map_err(|error| error.to_string())?;
        write_json_atomic(&self.path, &body)
            .map_err(|error| format!("写入网关供应商列表失败：{error}"))
    }
}

pub fn write_json_atomic(path: &Path, body: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("创建网关目录失败：{error}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&tmp).map_err(|error| error.to_string())?;
    file.write_all(body)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

/// Provider and routing-group IDs: 1–32 lowercase letters, digits or `-`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub fn provider_account(id: &str) -> String {
    format!("provider:{id}")
}

/// Provider list for read-only consumers outside the gateway (quota balance).
pub fn load_providers_readonly(gateway_dir: &Path) -> Result<Vec<ProviderRecord>, String> {
    ProviderStore::new(gateway_dir).load()
}

/// Reads the gateway's own `provider:<id>` entry without writing or copying it.
pub fn read_provider_key(secrets: &dyn SecretStore, id: &str) -> Result<Option<String>, String> {
    if !valid_id(id) {
        return Err("供应商 ID 无效。".to_string());
    }
    secrets.get(&provider_account(id))
}

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

pub struct KeyringSecrets;

impl KeyringSecrets {
    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|error| format!("无法打开系统钥匙串：{error}"))
    }
}

impl SecretStore for KeyringSecrets {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("读取系统钥匙串失败：{error}")),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        Self::entry(account)?
            .set_password(value)
            .map_err(|error| format!("写入系统钥匙串失败：{error}"))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("删除系统钥匙串条目失败：{error}")),
        }
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct MemorySecrets(std::sync::Mutex<std::collections::HashMap<String, String>>);

#[cfg(test)]
impl SecretStore for MemorySecrets {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .insert(account.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

pub fn ensure_local_token(secrets: &dyn SecretStore) -> Result<String, String> {
    if let Some(token) = secrets.get(LOCAL_TOKEN_ACCOUNT)? {
        if token.starts_with("tl-") && token.len() >= 35 {
            return Ok(token);
        }
    }
    let mut raw = [0u8; 24];
    getrandom::fill(&mut raw).map_err(|error| format!("生成本地 token 失败：{error}"))?;
    let token = format!(
        "tl-{}",
        raw.iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    secrets.set(LOCAL_TOKEN_ACCOUNT, &token)?;
    Ok(token)
}

pub fn validate_auth_mode(record: &ProviderRecord) -> Result<(), String> {
    if record.auth_mode == AuthMode::None {
        let url =
            Url::parse(&record.base_url).map_err(|_| "接口地址不是有效的 URL。".to_string())?;
        // Literal addresses only; localhost/DNS aliases cannot widen this exemption.
        if !matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "::1")) {
            return Err("免密模式只允许本机地址 127.0.0.1 或 ::1。".into());
        }
    }
    Ok(())
}

pub fn validate_provider(record: &ProviderRecord) -> Result<(), String> {
    validate_auth_mode(record)?;
    if !valid_id(&record.id) {
        return Err("供应商 ID 只能用 1–32 个小写字母、数字或连字符。".to_string());
    }
    if record.id == "group" {
        return Err("供应商 ID「group」留给路由组使用。".to_string());
    }
    let name = record.name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err("供应商名称需要 1–64 个字符。".to_string());
    }
    let url = Url::parse(&record.base_url).map_err(|_| "接口地址不是有效的 URL。".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("接口地址只支持 http 或 https。".to_string());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("接口地址不能包含账号、查询参数或片段。".to_string());
    }
    if url.host_str().is_none() {
        return Err("接口地址缺少主机名。".to_string());
    }
    if record.models.len() > MAX_MODELS {
        return Err(format!("每个供应商最多 {MAX_MODELS} 个模型。"));
    }
    for model in &record.models {
        if model.is_empty() || model.len() > 128 || model.chars().any(char::is_whitespace) {
            return Err(format!("模型名「{model}」无效。"));
        }
    }
    Ok(())
}

pub fn upsert(providers: &mut Vec<ProviderRecord>, record: ProviderRecord) -> Result<(), String> {
    validate_provider(&record)?;
    if let Some(existing) = providers.iter_mut().find(|item| item.id == record.id) {
        *existing = record;
        return Ok(());
    }
    if providers.len() >= MAX_PROVIDERS {
        return Err(format!("最多添加 {MAX_PROVIDERS} 个供应商。"));
    }
    providers.push(record);
    Ok(())
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    #[test]
    fn auth_mode_defaults_roundtrips_and_restricts_none() {
        let legacy = serde_json::json!({"id":"local","name":"Local","baseUrl":"http://127.0.0.1:11434/v1","wire":"chat"});
        let mut record: ProviderRecord = serde_json::from_value(legacy).unwrap();
        assert_eq!(record.auth_mode, AuthMode::Key);
        record.auth_mode = AuthMode::None;
        for url in ["http://127.0.0.1:11434/v1", "http://[::1]:1234/v1"] {
            record.base_url = url.into();
            validate_provider(&record).unwrap();
        }
        let roundtrip: ProviderRecord =
            serde_json::from_value(serde_json::to_value(&record).unwrap()).unwrap();
        assert_eq!(record, roundtrip);
        for url in [
            "http://localhost:1234/v1",
            "http://127.0.0.2/v1",
            "http://192.168.1.1/v1",
            "https://remote.example/v1",
        ] {
            record.base_url = url.into();
            assert!(validate_provider(&record).is_err(), "{url}");
        }
    }
}
