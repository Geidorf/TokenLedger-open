//! Points file-configured Agents at the local gateway (T10.269, T10.291),
//! following the Codex writer (T10.265): every file is backed up before the
//! first write, rewritten atomically after a version check, previewed as a
//! masked diff and restorable. Unrelated keys are kept; only the gateway
//! address and the local token are written, never a provider key. Files may be
//! JSON, TOML (edited with toml_edit, comments kept) or block-style YAML
//! (edited line by line, comments kept). JSON with comments or trailing
//! commas is patched in place (T10.292), never stripped; what cannot be
//! located safely is refused.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use toml_edit::{Document, Item, Table};

use super::agents::yaml::YamlDoc;
use super::codex_config::{line_diff, version};

#[path = "agent_config/jsonc.rs"]
pub(crate) mod jsonc;
#[path = "agent_config/preview.rs"]
pub(crate) mod preview;
#[path = "agent_config/transaction.rs"]
pub(crate) mod transaction;
use transaction::Change;

pub const PROVIDER_ID: &str = "tokenledger";
pub const PROVIDER_NAME: &str = "TokenLedger 网关";
const MAX_CONFIG_BYTES: usize = 256 * 1024;
const BACKUP_ROOT: &str = "agent-backup-v1";
const MANIFEST_FILE: &str = "manifest.json";

pub struct AgentTarget<'a> {
    pub base_url: &'a str,
    pub token: &'a str,
    /// Gateway model name: `provider/model` or `group/<id>`.
    pub model: &'a str,
}

type Warnings = Box<dyn Fn(&Docs) -> Vec<String> + Send + Sync>;

/// How a file is parsed and edited.
pub enum Render {
    Json(fn(&mut Map<String, Value>, &AgentTarget<'_>) -> Result<(), String>),
    Toml(fn(&mut Document, &AgentTarget<'_>) -> Result<(), String>),
    Yaml(fn(&mut YamlDoc, &AgentTarget<'_>) -> Result<(), String>),
}

pub struct FileSpec {
    pub path: PathBuf,
    pub render: Render,
}

/// Parsed file contents as JSON objects whatever the format, `None` when the
/// file does not exist.
pub type Docs = [Option<Map<String, Value>>];

pub struct AgentSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub files: Vec<FileSpec>,
    pub current_model: fn(&Docs) -> Option<String>,
    pub points_to_gateway: fn(&Docs, &str) -> bool,
    /// Notes shown with inspect/preview, e.g. a sibling file that overrides ours.
    pub warnings: Warnings,
}

/// Key paths inside each file, e.g. `["env", "ANTHROPIC_BASE_URL"]`.
pub type KeyPaths = &'static [&'static [&'static str]];

pub struct AgentConfig {
    spec: AgentSpec,
    backup_dir: PathBuf,
    /// Set for files the user shares with other tools: preview shows only
    /// these keys, ownership is judged by them alone, and restore puts back
    /// their original values while keeping every other key as it is now.
    managed: Option<KeyPaths>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBackupView {
    pub created_at: String,
    pub original_existed: bool,
    pub restorable_without_force: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInspection {
    pub agent: String,
    pub config_path: String,
    pub exists: bool,
    pub version: String,
    pub points_to_gateway: bool,
    pub model: Option<String>,
    pub backup: Option<AgentBackupView>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreview {
    pub config_path: String,
    pub changed: bool,
    pub before_version: String,
    pub diff: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApplyResult {
    pub config_path: String,
    pub changed: bool,
    pub version: String,
    pub backup_created: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRestoreResult {
    pub config_path: String,
    pub removed: bool,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileManifest {
    path: String,
    original_existed: bool,
    original_version: String,
    applied_version: String,
    /// Hash of the managed keys as written; only kept for managed Agents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    applied_managed: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u8,
    agent: String,
    files: Vec<FileManifest>,
    created_at: String,
}

/// Rendered bytes and documents, one per file.
type Rendered = (Vec<Vec<u8>>, Vec<Map<String, Value>>);

struct Snapshot {
    raw: Vec<Option<Vec<u8>>>,
    docs: Vec<Option<Map<String, Value>>>,
}

impl Snapshot {
    fn versions(&self) -> Vec<String> {
        self.raw
            .iter()
            .map(|bytes| version(bytes.as_deref()))
            .collect()
    }
}

fn combined(versions: &[String]) -> String {
    if versions.len() == 1 {
        return versions[0].clone();
    }
    version(Some(versions.join("\n").as_bytes()))
}

fn read_file(path: &Path, name: &str) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取 {name} 配置失败：{error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "{name} 配置是符号链接或不是普通文件，为安全起见不改动。"
        ));
    }
    if metadata.len() > MAX_CONFIG_BYTES as u64 {
        return Err(format!("{name} 配置超过 256KB，为安全起见不改动。"));
    }
    let bytes = fs::read(path).map_err(|error| format!("读取 {name} 配置失败：{error}"))?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(format!("{name} 配置超过 256KB，为安全起见不改动。"));
    }
    Ok(Some(bytes))
}

/// A dotenv file (`.env`, `foo.env`) is read as `KEY → string` and rewritten
/// line by line, so comments, blank lines and other keys stay as they were.
fn is_env(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == ".env" || name.ends_with(".env"))
}

/// `(key, value, has export prefix)` of a `KEY=value` line.
fn env_assignment(line: &str) -> Option<(&str, String, bool)> {
    let trimmed = line.trim_start();
    if trimmed.starts_with('#') {
        return None;
    }
    let (exported, rest) = match trimmed.strip_prefix("export ") {
        Some(rest) => (true, rest),
        None => (false, trimmed),
    };
    let (key, value) = rest.split_once('=')?;
    let key = key.trim();
    if key.is_empty() || key.contains(char::is_whitespace) {
        return None;
    }
    let value = value.trim();
    let quoted = ['"', '\'', '`'].into_iter().find_map(|quote| {
        let inner = value.strip_prefix(quote)?;
        inner.find(quote).map(|end| inner[..end].to_string())
    });
    let value = quoted.unwrap_or_else(|| {
        let bare = value.find(" #").map_or(value, |index| &value[..index]);
        bare.trim().to_string()
    });
    Some((key, value, exported))
}

fn parse_env(text: &str) -> Map<String, Value> {
    text.lines()
        .filter_map(env_assignment)
        .map(|(key, value, _)| (key.to_string(), Value::from(value)))
        .collect()
}

fn env_line(key: &str, value: &Value, exported: bool) -> String {
    let value = value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string());
    let plain = !value.is_empty()
        && !value
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '#' | '"' | '\'' | '`' | '\\'));
    let value = if plain {
        value
    } else {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    };
    format!("{}{key}={value}", if exported { "export " } else { "" })
}

fn serialize_env(original: Option<&[u8]>, doc: &Map<String, Value>) -> Vec<u8> {
    let original = original.map(String::from_utf8_lossy).unwrap_or_default();
    let mut written = std::collections::HashSet::new();
    let mut lines = Vec::new();
    for line in original.lines() {
        let Some((key, value, exported)) = env_assignment(line) else {
            lines.push(line.to_string());
            continue;
        };
        written.insert(key.to_string());
        match doc.get(key) {
            Some(next) if next.as_str() == Some(value.as_str()) => lines.push(line.to_string()),
            Some(next) => lines.push(env_line(key, next, exported)),
            None => {}
        }
    }
    for (key, value) in doc {
        if !written.contains(key) {
            lines.push(env_line(key, value, false));
        }
    }
    let mut text = lines.join("\n");
    text.push('\n');
    text.into_bytes()
}

fn text<'a>(bytes: &'a [u8], path: &Path, name: &str) -> Result<&'a str, String> {
    std::str::from_utf8(bytes)
        .map_err(|_| format!("{name} 配置不是 UTF-8 文本：{}", path.display()))
}

fn parse_toml(text: &str, path: &Path, name: &str) -> Result<Document, String> {
    text.parse::<Document>()
        .map_err(|_| format!("{name} 配置不是有效的 TOML，未做改动：{}", path.display()))
}

fn parse_yaml(text: &str, path: &Path, name: &str) -> Result<YamlDoc, String> {
    YamlDoc::parse(text).map_err(|_| {
        format!(
            "{name} 配置里有本工具不能安全改写的 YAML，未做改动：{}",
            path.display()
        )
    })
}

fn toml_value(value: &toml_edit::Value) -> Value {
    use toml_edit::Value as T;
    match value {
        T::String(text) => Value::from(text.value().as_str()),
        T::Integer(number) => Value::from(*number.value()),
        T::Float(number) => Value::from(*number.value()),
        T::Boolean(flag) => Value::from(*flag.value()),
        T::Datetime(time) => Value::from(time.value().to_string()),
        T::Array(items) => Value::Array(items.iter().map(toml_value).collect()),
        T::InlineTable(table) => Value::Object(
            table
                .iter()
                .map(|(key, value)| (key.to_string(), toml_value(value)))
                .collect(),
        ),
    }
}

fn toml_table(table: &Table) -> Map<String, Value> {
    table
        .iter()
        .map(|(key, item)| (key.to_string(), toml_item(item)))
        .collect()
}

fn toml_item(item: &Item) -> Value {
    match item {
        Item::None => Value::Null,
        Item::Value(value) => toml_value(value),
        Item::Table(table) => Value::Object(toml_table(table)),
        Item::ArrayOfTables(tables) => Value::Array(
            tables
                .iter()
                .map(|table| Value::Object(toml_table(table)))
                .collect(),
        ),
    }
}

/// `parent[key]` as a standard `[table]`, created when missing; errors on an
/// inline table or another type rather than reformatting it.
pub fn toml_child<'a>(parent: &'a mut Table, key: &str) -> Result<&'a mut Table, String> {
    if parent.get(key).is_none() {
        let mut table = Table::new();
        table.set_implicit(true);
        parent.insert(key, Item::Table(table));
    }
    parent
        .get_mut(key)
        .and_then(Item::as_table_mut)
        .ok_or_else(|| format!("配置里的「{key}」不是标准表格写法，为安全起见未做改动。"))
}

/// Sets a value, keeping the comments and spacing around an existing one.
pub fn toml_set(table: &mut Table, key: &str, value: impl Into<toml_edit::Value>) {
    let mut value = value.into();
    if let Some(existing) = table.get_mut(key).and_then(Item::as_value_mut) {
        *value.decor_mut() = existing.decor().clone();
        *existing = value;
    } else {
        table.insert(key, Item::Value(value));
    }
}

fn parse(
    bytes: &[u8],
    path: &Path,
    name: &str,
    render: &Render,
) -> Result<Map<String, Value>, String> {
    let text = text(bytes, path, name)?;
    match render {
        Render::Toml(_) => return Ok(toml_table(parse_toml(text, path, name)?.as_table())),
        Render::Yaml(_) => {
            return parse_yaml(text, path, name)?
                .to_map()
                .map_err(|_| format!("{name} YAML 配置结构无法安全读取，未做改动。"))
        }
        Render::Json(_) => {}
    }
    if is_env(path) {
        return Ok(parse_env(text));
    }
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(format!(
            "{name} 配置顶层不是 JSON 对象，未做改动：{}",
            path.display()
        )),
        Err(_) => jsonc::parse(text).ok_or_else(|| {
            format!(
                "{name} 配置不是有效的 JSON 或 JSONC 对象，为安全起见未做改动：{}",
                path.display()
            )
        }),
    }
}

/// JSONC files (comments or trailing commas) are patched in place so the
/// comments survive; standard JSON keeps the plain rewrite.
fn render_jsonc(
    raw: Option<&[u8]>,
    doc: &Map<String, Value>,
    path: &Path,
    name: &str,
) -> Option<Result<Vec<u8>, String>> {
    let text = std::str::from_utf8(raw?).ok()?;
    if text.trim().is_empty() || serde_json::from_str::<Value>(text).is_ok() {
        return None;
    }
    Some(
        jsonc::patch(text, doc)
            .map(String::into_bytes)
            .map_err(|_| {
                format!(
                    "{name} 配置含注释或尾逗号且无法安全定位改动，为安全起见未做改动：{}",
                    path.display()
                )
            }),
    )
}

fn serialize(map: &Map<String, Value>) -> Vec<u8> {
    let mut text = serde_json::to_string_pretty(map).unwrap_or_else(|_| "{}".to_string());
    text.push('\n');
    text.into_bytes()
}

/// `parent[key]` as an object, created when missing; errors on another type.
pub fn object_at<'a>(
    parent: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    let entry = parent
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    entry
        .as_object_mut()
        .ok_or_else(|| format!("配置里的「{key}」不是对象，为安全起见未做改动。"))
}

/// `parent[key]` as an array, created when missing; errors on another type.
pub fn array_at<'a>(
    parent: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Vec<Value>, String> {
    let entry = parent
        .entry(key.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    entry
        .as_array_mut()
        .ok_or_else(|| format!("配置里的「{key}」不是数组，为安全起见未做改动。"))
}

/// Read-only path lookup through nested objects.
pub fn lookup<'a>(map: &'a Map<String, Value>, path: &[&str]) -> Option<&'a Value> {
    let (first, rest) = path.split_first()?;
    let mut value = map.get(*first)?;
    for key in rest {
        value = value.as_object()?.get(*key)?;
    }
    Some(value)
}

pub fn lookup_str<'a>(map: &'a Map<String, Value>, path: &[&str]) -> Option<&'a str> {
    lookup(map, path).and_then(Value::as_str)
}

/// The managed keys of one file as a flat object, `null` where absent.
fn managed_values(paths: KeyPaths, doc: Option<&Map<String, Value>>) -> Map<String, Value> {
    paths
        .iter()
        .map(|path| {
            let value = doc
                .and_then(|doc| lookup(doc, path))
                .cloned()
                .unwrap_or(Value::Null);
            (path.join("."), value)
        })
        .collect()
}

fn managed_version(paths: KeyPaths, doc: Option<&Map<String, Value>>) -> String {
    let values = serde_json::to_vec(&managed_values(paths, doc)).unwrap_or_default();
    version(Some(&values))
}

/// Puts `path` back to `value`, removing it when `None`. Parents emptied by a
/// removal are dropped unless `original` had them.
fn reset_path(
    doc: &mut Map<String, Value>,
    path: &[&str],
    value: Option<Value>,
    original: Option<&Map<String, Value>>,
    depth: usize,
) -> Result<(), String> {
    let Some((key, rest)) = path[depth..].split_first() else {
        return Ok(());
    };
    if rest.is_empty() {
        match value {
            Some(value) => {
                doc.insert(key.to_string(), value);
            }
            None => {
                doc.remove(*key);
            }
        }
        return Ok(());
    }
    if value.is_none() && !doc.get(*key).is_some_and(Value::is_object) {
        return Ok(());
    }
    let child = object_at(doc, key)?;
    reset_path(child, path, value, original, depth + 1)?;
    let keep = !child.is_empty()
        || original
            .and_then(|original| lookup(original, &path[..=depth]))
            .is_some();
    if !keep {
        doc.remove(*key);
    }
    Ok(())
}

impl AgentConfig {
    pub fn new(spec: AgentSpec, gateway_dir: &Path) -> Self {
        let backup_dir = gateway_dir.join(BACKUP_ROOT).join(spec.id);
        Self {
            spec,
            backup_dir,
            managed: None,
        }
    }

    pub fn managed_keys(mut self, paths: KeyPaths) -> Self {
        self.managed = Some(paths);
        self
    }

    /// Whether the file still holds what the gateway wrote.
    fn is_ours(
        &self,
        entry: &FileManifest,
        current: &str,
        doc: Option<&Map<String, Value>>,
    ) -> bool {
        match self.managed {
            Some(paths) => match entry.applied_managed.as_deref() {
                Some(expected) => expected == managed_version(paths, doc),
                None => entry.applied_version == current,
            },
            None => entry.applied_version == current,
        }
    }

    fn all_ours(&self, manifest: &Manifest, snapshot: &Snapshot, versions: &[String]) -> bool {
        manifest
            .files
            .iter()
            .zip(versions)
            .zip(&snapshot.docs)
            .all(|((entry, current), doc)| self.is_ours(entry, current, doc.as_ref()))
    }

    fn display_path(&self) -> String {
        self.spec
            .files
            .iter()
            .map(|file| file.path.display().to_string())
            .collect::<Vec<_>>()
            .join("、")
    }

    fn snapshot(&self) -> Result<Snapshot, String> {
        let mut raw = Vec::new();
        let mut docs = Vec::new();
        for file in &self.spec.files {
            let bytes = read_file(&file.path, self.spec.name)?;
            let doc = match bytes.as_deref() {
                Some(bytes) => Some(parse(bytes, &file.path, self.spec.name, &file.render)?),
                None => None,
            };
            raw.push(bytes);
            docs.push(doc);
        }
        Ok(Snapshot { raw, docs })
    }

    fn render(&self, snapshot: &Snapshot, target: &AgentTarget<'_>) -> Result<Rendered, String> {
        let mut out = Vec::new();
        let mut docs = Vec::new();
        for ((file, doc), raw) in self
            .spec
            .files
            .iter()
            .zip(&snapshot.docs)
            .zip(&snapshot.raw)
        {
            let name = self.spec.name;
            let source = match raw.as_deref() {
                Some(bytes) => text(bytes, &file.path, name)?,
                None => "",
            };
            // Managed keys exist for JSON and YAML files, so TOML hands back
            // an empty document.
            let (bytes, doc) = match &file.render {
                Render::Json(render) => {
                    let mut doc = doc.clone().unwrap_or_default();
                    render(&mut doc, target)?;
                    let bytes = if is_env(&file.path) {
                        serialize_env(raw.as_deref(), &doc)
                    } else {
                        match render_jsonc(raw.as_deref(), &doc, &file.path, name) {
                            Some(patched) => patched?,
                            None => serialize(&doc),
                        }
                    };
                    (bytes, doc)
                }
                Render::Toml(render) => {
                    let mut doc = parse_toml(source, &file.path, name)?;
                    render(&mut doc, target)?;
                    (doc.to_string().into_bytes(), Map::new())
                }
                Render::Yaml(render) => {
                    let mut doc = parse_yaml(source, &file.path, name)?;
                    render(&mut doc, target)?;
                    let map = doc
                        .to_map()
                        .map_err(|_| format!("写入后的 {name} 配置无法安全读回，未做改动。"))?;
                    (doc.serialize().into_bytes(), map)
                }
            };
            if bytes.len() > MAX_CONFIG_BYTES {
                return Err(format!(
                    "写入后的 {} 配置超过 256KB，未做改动。",
                    self.spec.name
                ));
            }
            out.push(bytes);
            docs.push(doc);
        }
        Ok((out, docs))
    }

    fn load_manifest(&self) -> Option<Manifest> {
        let text = fs::read_to_string(self.backup_dir.join(MANIFEST_FILE)).ok()?;
        serde_json::from_str::<Manifest>(&text)
            .ok()
            .filter(|manifest| {
                manifest.schema_version == 1
                    && manifest.agent == self.spec.id
                    && manifest.files.len() == self.spec.files.len()
                    && manifest
                        .files
                        .iter()
                        .zip(&self.spec.files)
                        .all(|(entry, file)| entry.path == file.path.display().to_string())
            })
    }

    fn backup_path(&self, index: usize) -> PathBuf {
        self.backup_dir.join(format!("{index}.bak"))
    }

    fn transaction_paths(&self) -> Vec<PathBuf> {
        let mut paths: Vec<_> = self
            .spec
            .files
            .iter()
            .map(|file| file.path.clone())
            .collect();
        paths.extend((0..self.spec.files.len()).map(|i| self.backup_path(i)));
        paths.push(self.backup_dir.join(MANIFEST_FILE));
        paths
    }

    fn recover(&self) -> Result<(), String> {
        transaction::recover(&self.backup_dir, &self.transaction_paths())?;
        let manifest_path = self.backup_dir.join(MANIFEST_FILE);
        let present = transaction::read(&manifest_path)?.is_some();
        let manifest = self.load_manifest();
        if present && manifest.is_none() {
            return Err("配置备份记录损坏或目标不匹配，已保留备份，未覆盖配置。".into());
        }
        for i in 0..self.spec.files.len() {
            let backup = transaction::read(&self.backup_path(i))?;
            match &manifest {
                Some(manifest) if manifest.files[i].original_existed => {
                    if version(backup.as_deref()) != manifest.files[i].original_version {
                        return Err("配置备份缺失或已损坏，已保留现有文件，未覆盖配置。".into());
                    }
                }
                _ if backup.is_some() => {
                    return Err("发现未关联的配置备份，已保留备份，未覆盖配置。".into())
                }
                _ => (),
            }
        }
        Ok(())
    }

    fn changes(&self, before: &[Option<Vec<u8>>], after: &[Option<Vec<u8>>]) -> Vec<Change> {
        self.spec
            .files
            .iter()
            .enumerate()
            .map(|(i, file)| Change::new(file.path.clone(), before[i].clone(), after[i].clone()))
            .collect()
    }

    fn restore_transaction(
        &self,
        snapshot: &Snapshot,
        plans: &[Option<Vec<u8>>],
    ) -> Result<(), String> {
        let mut changes = self.changes(&snapshot.raw, plans);
        for index in 0..self.spec.files.len() {
            let path = self.backup_path(index);
            changes.push(Change::new(path.clone(), transaction::read(&path)?, None));
        }
        let path = self.backup_dir.join(MANIFEST_FILE);
        changes.push(Change::new(path.clone(), transaction::read(&path)?, None));
        transaction::execute(&self.backup_dir, changes)
    }

    /// Startup integration may call this without parsing unrelated configs.
    pub(crate) fn recover_pending(&self) -> Result<(), String> {
        let _lock = transaction::lock();
        if transaction::pending(&self.backup_dir)? {
            transaction::recover(&self.backup_dir, &self.transaction_paths())?;
        }
        Ok(())
    }

    pub fn inspect(&self, base_url: &str) -> Result<AgentInspection, String> {
        let _lock = transaction::lock();
        self.recover()?;
        let snapshot = self.snapshot()?;
        let versions = snapshot.versions();
        let backup = self.load_manifest().map(|manifest| AgentBackupView {
            restorable_without_force: self.all_ours(&manifest, &snapshot, &versions),
            original_existed: manifest.files.iter().any(|entry| entry.original_existed),
            created_at: manifest.created_at,
        });
        Ok(AgentInspection {
            agent: self.spec.id.to_string(),
            config_path: self.display_path(),
            exists: snapshot.raw.iter().any(Option::is_some),
            version: combined(&versions),
            points_to_gateway: (self.spec.points_to_gateway)(&snapshot.docs, base_url),
            model: (self.spec.current_model)(&snapshot.docs),
            backup,
            warnings: (self.spec.warnings)(&snapshot.docs),
        })
    }

    pub fn preview(&self, target: &AgentTarget<'_>) -> Result<AgentPreview, String> {
        let _lock = transaction::lock();
        self.recover()?;
        let snapshot = self.snapshot()?;
        let (rendered, _) = self.render(&snapshot, target)?;
        let mut diff = Vec::new();
        let mut changed = false;
        for (index, file) in self.spec.files.iter().enumerate() {
            let before = snapshot.raw[index].as_deref();
            let after = &rendered[index];
            if before == Some(after.as_slice()) {
                continue;
            }
            changed = true;
            let before_doc = snapshot.docs[index].as_ref();
            let after_doc = parse(after, &file.path, self.spec.name, &file.render)?;
            let (before_text, after_text) =
                preview::projection(before_doc, &after_doc, target.token, is_env(&file.path));
            diff.push(format!("--- {}", file.path.display()));
            diff.push(line_diff(&before_text, &after_text));
        }
        Ok(AgentPreview {
            config_path: self.display_path(),
            changed,
            before_version: combined(&snapshot.versions()),
            diff: diff.join("\n"),
            warnings: (self.spec.warnings)(&snapshot.docs),
        })
    }

    pub fn apply(
        &self,
        target: &AgentTarget<'_>,
        expected_version: Option<&str>,
    ) -> Result<AgentApplyResult, String> {
        let _lock = transaction::lock();
        self.recover()?;
        let snapshot = self.snapshot()?;
        let versions = snapshot.versions();
        if expected_version.is_some_and(|expected| expected != combined(&versions)) {
            return Err(format!(
                "{} 配置在预览后被修改过，请重新预览。",
                self.spec.name
            ));
        }
        let (rendered, rendered_docs) = self.render(&snapshot, target)?;
        let applied: Vec<String> = rendered.iter().map(|bytes| version(Some(bytes))).collect();
        let applied_managed: Vec<Option<String>> = rendered_docs
            .iter()
            .map(|doc| self.managed.map(|paths| managed_version(paths, Some(doc))))
            .collect();
        if snapshot
            .raw
            .iter()
            .zip(&rendered)
            .all(|(before, after)| before.as_deref() == Some(after.as_slice()))
        {
            return Ok(AgentApplyResult {
                config_path: self.display_path(),
                changed: false,
                version: combined(&applied),
                backup_created: false,
            });
        }
        // Never replace an active lease's first restore point.
        let mut changes = self.changes(
            &snapshot.raw,
            &rendered.iter().cloned().map(Some).collect::<Vec<_>>(),
        );
        let (manifest, backup_created) = match self.load_manifest() {
            Some(manifest) if self.all_ours(&manifest, &snapshot, &versions) => {
                let files = manifest
                    .files
                    .into_iter()
                    .zip(applied.iter().zip(&applied_managed))
                    .map(|(entry, (applied, managed))| FileManifest {
                        applied_version: applied.clone(),
                        applied_managed: managed.clone(),
                        ..entry
                    })
                    .collect();
                (Manifest { files, ..manifest }, false)
            }
            Some(_) => {
                return Err(format!(
                    "{} 配置恢复租约与当前配置冲突，已保留首次备份；请先恢复或处理外部修改。",
                    self.spec.name
                ))
            }
            None => {
                let mut files = Vec::new();
                for (index, file) in self.spec.files.iter().enumerate() {
                    let backup = self.backup_path(index);
                    changes.push(Change::new(
                        backup.clone(),
                        transaction::read(&backup)?,
                        snapshot.raw[index].clone(),
                    ));
                    files.push(FileManifest {
                        path: file.path.display().to_string(),
                        original_existed: snapshot.raw[index].is_some(),
                        original_version: versions[index].clone(),
                        applied_version: applied[index].clone(),
                        applied_managed: applied_managed[index].clone(),
                    });
                }
                let manifest = Manifest {
                    schema_version: 1,
                    agent: self.spec.id.to_string(),
                    files,
                    created_at: chrono::Utc::now().to_rfc3339(),
                };
                (manifest, true)
            }
        };
        let body = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
        let path = self.backup_dir.join(MANIFEST_FILE);
        changes.push(Change::new(
            path.clone(),
            transaction::read(&path)?,
            Some(body),
        ));
        transaction::execute(&self.backup_dir, changes)?;
        Ok(AgentApplyResult {
            config_path: self.display_path(),
            changed: true,
            version: combined(&applied),
            backup_created,
        })
    }

    pub fn restore(&self, force: bool) -> Result<AgentRestoreResult, String> {
        let _lock = transaction::lock();
        self.recover()?;
        let manifest = self
            .load_manifest()
            .ok_or_else(|| format!("没有可恢复的 {} 配置备份。", self.spec.name))?;
        let snapshot = self.snapshot()?;
        let versions = snapshot.versions();
        if !self.all_ours(&manifest, &snapshot, &versions) && !force {
            return Err(match self.managed {
                Some(_) => format!(
                    "{} 配置里由网关写入的项在接入后又被修改过，恢复会覆盖这些修改；确认后请选择强制恢复。",
                    self.spec.name
                ),
                None => format!(
                    "{} 配置在接入网关后又被修改过，恢复会丢掉这些修改；确认后请选择强制恢复。",
                    self.spec.name
                ),
            });
        }
        let mut backups = Vec::new();
        for (index, entry) in manifest.files.iter().enumerate() {
            if entry.original_existed {
                let bytes = fs::read(self.backup_path(index))
                    .map_err(|error| format!("读取 {} 配置备份失败：{error}", self.spec.name))?;
                if version(Some(&bytes)) != entry.original_version {
                    return Err(format!("{} 配置备份已损坏，未做改动。", self.spec.name));
                }
                backups.push(Some(bytes));
            } else {
                backups.push(None);
            }
        }
        if let Some(paths) = self.managed {
            return self.restore_managed(paths, &manifest, &snapshot, &versions, &backups);
        }
        let removed = backups
            .iter()
            .zip(&snapshot.raw)
            .any(|(after, before)| after.is_none() && before.is_some());
        self.restore_transaction(&snapshot, &backups)?;
        let originals: Vec<String> = manifest
            .files
            .iter()
            .map(|entry| entry.original_version.clone())
            .collect();
        Ok(AgentRestoreResult {
            config_path: self.display_path(),
            removed,
            version: combined(&originals),
        })
    }

    /// Writes the managed keys' pre-gateway values over the current file and
    /// leaves everything else untouched. A file the gateway created is
    /// removed once nothing else is left in it.
    fn restore_managed(
        &self,
        paths: KeyPaths,
        manifest: &Manifest,
        snapshot: &Snapshot,
        versions: &[String],
        backups: &[Option<Vec<u8>>],
    ) -> Result<AgentRestoreResult, String> {
        let mut plans = Vec::new();
        for (index, file) in self.spec.files.iter().enumerate() {
            let original = match backups[index].as_deref() {
                Some(bytes) => Some(parse(bytes, &file.path, self.spec.name, &file.render)?),
                None => None,
            };
            let mut doc = snapshot.docs[index].clone().unwrap_or_default();
            for path in paths {
                let value = original
                    .as_ref()
                    .and_then(|original| lookup(original, path))
                    .cloned();
                reset_path(&mut doc, path, value, original.as_ref(), 0)?;
            }
            let bytes = if doc.is_empty()
                && (!manifest.files[index].original_existed || snapshot.raw[index].is_none())
            {
                None
            } else if let Render::Yaml(_) = file.render {
                // The YAML reader drops list items and block scalars, so only
                // an untouched file goes back byte for byte.
                if backups[index].is_some()
                    && versions[index] == manifest.files[index].applied_version
                {
                    backups[index].clone()
                } else {
                    Some(self.restore_yaml(
                        paths,
                        index,
                        snapshot.raw[index].as_deref(),
                        backups[index].as_deref(),
                        original.as_ref(),
                    )?)
                }
            } else if original.as_ref() == Some(&doc) && backups[index].is_some() {
                // Nothing else changed since the backup: put it back byte for
                // byte, comments and formatting included.
                backups[index].clone()
            } else {
                match render_jsonc(
                    snapshot.raw[index].as_deref(),
                    &doc,
                    &file.path,
                    self.spec.name,
                ) {
                    Some(patched) => Some(patched?),
                    None => Some(serialize(&doc)),
                }
            };
            plans.push(bytes);
        }
        let removed = plans
            .iter()
            .zip(&snapshot.raw)
            .any(|(after, before)| after.is_none() && before.is_some());
        let written: Vec<_> = plans
            .iter()
            .map(|bytes| version(bytes.as_deref()))
            .collect();
        self.restore_transaction(snapshot, &plans)?;
        Ok(AgentRestoreResult {
            config_path: self.display_path(),
            removed,
            version: combined(&written),
        })
    }

    /// Copies each managed key's lines from the backup over the current YAML,
    /// or removes the key (and parents the gateway added that are now empty)
    /// when the backup lacks it; every other line stays as it is now.
    fn restore_yaml(
        &self,
        paths: KeyPaths,
        index: usize,
        current: Option<&[u8]>,
        backup: Option<&[u8]>,
        original: Option<&Map<String, Value>>,
    ) -> Result<Vec<u8>, String> {
        let file = &self.spec.files[index];
        let name = self.spec.name;
        let load = |bytes: &[u8]| parse_yaml(text(bytes, &file.path, name)?, &file.path, name);
        let mut doc = load(current.unwrap_or_default())?;
        let source = backup.map(load).transpose()?;
        let refused = |reason: String| format!("恢复 {name} 配置时{reason}");
        for path in paths {
            let entry = match &source {
                Some(source) => source.entry(path).map_err(refused)?,
                None => None,
            };
            match entry {
                Some(lines) => doc.put(path, &lines).map_err(refused)?,
                None => {
                    doc.remove(path).map_err(refused)?;
                    for depth in (1..path.len()).rev() {
                        let parent = &path[..depth];
                        if original
                            .and_then(|original| lookup(original, parent))
                            .is_some()
                        {
                            break;
                        }
                        doc.remove_if_empty(parent).map_err(refused)?;
                    }
                }
            }
        }
        Ok(doc.serialize().into_bytes())
    }
}

#[cfg(test)]
pub(super) mod test_support {
    use super::*;

    pub const TOKEN: &str = "tl-0123456789abcdef0123456789abcdef0123456789abcd";
    pub const BASE: &str = "http://127.0.0.1:3462/v1";

    pub fn target(model: &str) -> AgentTarget<'_> {
        AgentTarget {
            base_url: BASE,
            token: TOKEN,
            model,
        }
    }

    pub fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tl-agent-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub fn read_json(path: &Path) -> Map<String, Value> {
        match serde_json::from_slice::<Value>(&fs::read(path).unwrap()).unwrap() {
            Value::Object(map) => map,
            _ => panic!("not an object"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    fn render_demo(doc: &mut Map<String, Value>, target: &AgentTarget<'_>) -> Result<(), String> {
        let provider = object_at(object_at(doc, "providers")?, PROVIDER_ID)?;
        provider.insert("url".into(), Value::from(target.base_url));
        provider.insert("key".into(), Value::from(target.token));
        doc.insert("model".into(), Value::from(target.model));
        Ok(())
    }

    fn render_second(doc: &mut Map<String, Value>, target: &AgentTarget<'_>) -> Result<(), String> {
        doc.insert("default".into(), Value::from(target.model));
        Ok(())
    }

    fn demo(dir: &Path, two_files: bool) -> AgentConfig {
        let mut files = vec![FileSpec {
            path: dir.join("home/demo.json"),
            render: Render::Json(render_demo),
        }];
        if two_files {
            files.push(FileSpec {
                path: dir.join("home/settings.json"),
                render: Render::Json(render_second),
            });
        }
        AgentConfig::new(
            AgentSpec {
                id: "demo",
                name: "Demo",
                files,
                current_model: |docs| {
                    docs[0]
                        .as_ref()
                        .and_then(|doc| lookup_str(doc, &["model"]))
                        .map(str::to_string)
                },
                points_to_gateway: |docs, base| {
                    docs[0]
                        .as_ref()
                        .and_then(|doc| lookup_str(doc, &["providers", PROVIDER_ID, "url"]))
                        == Some(base)
                },
                warnings: Box::new(|_: &Docs| Vec::new()),
            },
            &dir.join("gateway"),
        )
    }

    #[test]
    fn startup_without_a_journal_does_not_parse_user_config() {
        let (dir, config) = fixture("no-pending-startup");
        fs::write(&config.spec.files[0].path, b"invalid source-secret config").unwrap();
        config.recover_pending().unwrap();
        assert_eq!(
            fs::read(&config.spec.files[0].path).unwrap(),
            b"invalid source-secret config"
        );
        assert!(config.inspect(BASE).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_config_errors_never_echo_source_credentials() {
        fn toml(_: &mut Document, _: &AgentTarget<'_>) -> Result<(), String> {
            Ok(())
        }
        fn yaml(_: &mut YamlDoc, _: &AgentTarget<'_>) -> Result<(), String> {
            Ok(())
        }
        for (i, render, source) in [
            (
                0,
                Render::Json(render_demo),
                "{\"apiKey\":\"source-secret\", broken}",
            ),
            (
                1,
                Render::Toml(toml),
                "apiKey = \"source-secret\"\nmodel = [broken\n",
            ),
            (
                2,
                Render::Yaml(yaml),
                "apiKey: source-secret\n\tmodel: broken\n",
            ),
        ] {
            let dir = temp_dir(&format!("invalid-preview-{i}"));
            let mut config = demo(&dir, false);
            config.spec.files[0].render = render;
            fs::create_dir_all(dir.join("home")).unwrap();
            fs::write(&config.spec.files[0].path, source).unwrap();
            assert!(!config
                .preview(&target("a/b"))
                .unwrap_err()
                .contains("source-secret"));
            assert!(!config.inspect(BASE).unwrap_err().contains("source-secret"));
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn preview_ipc_excludes_other_provider_secrets_in_compact_multiline_and_jsonc() {
        let fixtures = [
            r#"{"model":"old","providers":{"tokenledger":{"key":"owned-old-secret"},"other":{"apiKey":"foreign-secret","nested":{"Token":"nested-secret"}}},"Password":"root-secret"}"#,
            "{\n  \"model\": \"old\",\n  \"providers\": {\"tokenledger\":{\"key\":\"owned-old-secret\"}, \"other\":{\"apiKey\":\"foreign-secret\",\"nested\":{\"Token\":\"nested-secret\"}}},\n  \"Password\":\"root-secret\"\n}",
            "// comment-secret\n{\"model\":\"old\",\"providers\":{\"other\":{\"apiKey\":\"foreign-secret\"}},}",
        ];
        for (i, original) in fixtures.iter().enumerate() {
            let dir = temp_dir(&format!("preview-private-json-{i}"));
            let config = demo(&dir, false);
            fs::create_dir_all(dir.join("home")).unwrap();
            fs::write(&config.spec.files[0].path, original).unwrap();
            let result = config.preview(&target("provider/model")).unwrap();
            let ipc = serde_json::to_string(&result).unwrap();
            for secret in [
                "owned-old-secret",
                "foreign-secret",
                "nested-secret",
                "root-secret",
                "comment-secret",
                TOKEN,
            ] {
                assert!(!ipc.contains(secret), "{i}/{secret}: {ipc}");
            }
            assert!(result.diff.contains("provider/model"));
            assert!(result.diff.contains(BASE));
            assert!(result.diff.contains("providers.tokenledger.key"));
            assert_eq!(
                fs::read_to_string(&config.spec.files[0].path).unwrap(),
                *original
            );
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn preview_ipc_toml_yaml_and_managed_keys_hide_original_credentials() {
        fn toml(doc: &mut Document, target: &AgentTarget<'_>) -> Result<(), String> {
            toml_set(doc.as_table_mut(), "model", target.model);
            toml_set(doc.as_table_mut(), "ApiKey", target.token);
            Ok(())
        }
        fn yaml(doc: &mut YamlDoc, target: &AgentTarget<'_>) -> Result<(), String> {
            doc.set(&["model"], target.model)?;
            doc.set(&["ApiKey"], target.token)
        }
        for (name,render,original) in [
            ("toml",Render::Toml(toml),"model = \"old\" # comment-secret\nApiKey = \"original-secret\"\n[providers.other]\napiKey = \"foreign-secret\"\n[providers.other.nested]\npassword = \"nested-secret\"\n"),
            ("yaml",Render::Yaml(yaml),"# comment-secret\nmodel: old\nApiKey: original-secret\nproviders:\n  other:\n    apiKey: foreign-secret\n    nested:\n      password: nested-secret\n")
        ] {
            let dir = temp_dir(&format!("preview-private-{name}")); let mut config = demo(&dir,false);
            config.spec.files[0].render=render; fs::create_dir_all(dir.join("home")).unwrap();
            fs::write(&config.spec.files[0].path,original).unwrap();
            let result = config.preview(&target("a/b")).unwrap(); let ipc=serde_json::to_string(&result).unwrap();
            for secret in ["comment-secret","original-secret","foreign-secret","nested-secret",TOKEN] { assert!(!ipc.contains(secret),"{name}/{secret}: {ipc}"); }
            assert!(result.diff.contains("model")); assert!(result.diff.contains("ApiKey"));
            if name == "yaml" {
                config=config.managed_keys(&[&["model"], &["ApiKey"]]);
                assert!(!serde_json::to_string(&config.preview(&target("a/b")).unwrap()).unwrap().contains("original-secret"));
            }
            fs::remove_dir_all(dir).unwrap();
        }
    }

    fn state(config: &AgentConfig) -> Vec<Option<Vec<u8>>> {
        config
            .transaction_paths()
            .iter()
            .map(|p| transaction::read(p).unwrap())
            .collect()
    }

    fn fixture(name: &str) -> (PathBuf, AgentConfig) {
        let dir = temp_dir(name);
        let config = demo(&dir, true);
        fs::create_dir_all(dir.join("home")).unwrap();
        fs::write(&config.spec.files[0].path, br#"{"model":"old","keep":1}"#).unwrap();
        fs::write(&config.spec.files[1].path, br#"{"default":"old","keep":2}"#).unwrap();
        (dir, config)
    }

    #[test]
    fn transaction_nth_replace_rolls_back_apply_restore_and_force() {
        for operation in ["apply", "restore", "force", "managed"] {
            for nth in 1..=5 {
                let (dir, mut config) = fixture(&format!("nth-{operation}-{nth}"));
                if operation == "managed" {
                    config = config.managed_keys(&[
                        &["model"],
                        &["default"],
                        &["providers", "tokenledger"],
                    ]);
                }
                if operation != "apply" {
                    config.apply(&target("a/b"), None).unwrap();
                }
                if operation == "force" {
                    fs::write(&config.spec.files[0].path, br#"{"model":"external"}"#).unwrap();
                    assert!(config.restore(false).is_err());
                }
                let before = state(&config);
                transaction::inject(nth, None);
                let result = if operation == "apply" {
                    config.apply(&target("a/b"), None).map(|_| ())
                } else {
                    config.restore(operation == "force").map(|_| ())
                };
                transaction::inject(0, None);
                assert!(result.is_err(), "{operation}/{nth}");
                assert_eq!(state(&config), before, "{operation}/{nth}");
                let inspection = config.inspect(BASE).unwrap();
                if operation == "restore" || operation == "managed" {
                    assert!(inspection.backup.unwrap().restorable_without_force);
                }
                assert!(!config.backup_dir.join("transaction-v1.json").exists());
                fs::remove_dir_all(dir).unwrap();
            }
        }
    }

    #[test]
    fn transaction_crashes_recover_every_phase_without_false_drift() {
        for operation in ["apply", "restore", "force"] {
            for phase in [
                "prepared",
                "staged",
                "written:0",
                "written:1",
                "written:2",
                "written:3",
                "written:4",
                "before-commit",
                "committed",
            ] {
                let (dir, config) =
                    fixture(&format!("crash-{operation}-{}", phase.replace(':', "-")));
                if operation != "apply" {
                    config.apply(&target("a/b"), None).unwrap();
                }
                if operation == "force" {
                    fs::write(&config.spec.files[0].path, br#"{"external":true}"#).unwrap();
                }
                let before = state(&config);
                transaction::inject(0, Some(phase));
                assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if operation == "apply" {
                        config.apply(&target("a/b"), None).unwrap();
                    } else {
                        config.restore(operation == "force").unwrap();
                    }
                }))
                .is_err());
                transaction::inject(0, None);
                let restarted = demo(&dir, true);
                restarted.recover_pending().unwrap();
                let inspection = restarted.inspect(BASE).unwrap();
                if phase == "committed" {
                    if operation == "apply" {
                        assert!(inspection.backup.unwrap().restorable_without_force);
                    } else {
                        assert!(inspection.backup.is_none());
                        assert_eq!(
                            fs::read(&config.spec.files[0].path).unwrap(),
                            br#"{"model":"old","keep":1}"#
                        );
                    }
                } else {
                    assert_eq!(state(&restarted), before, "{operation}/{phase}");
                }
                assert!(!config.backup_dir.join("transaction-v1.json").exists());
                fs::remove_dir_all(dir).unwrap();
            }
        }
    }

    #[test]
    fn transaction_process_crash_child() {
        let Some(dir) = std::env::var_os("TL_CONFIG_TEST_CRASH_DIR") else {
            return;
        };
        let config = demo(Path::new(&dir), true);
        let operation = std::env::var("TL_CONFIG_TEST_CRASH_OPERATION").unwrap();
        transaction::inject_exit(&std::env::var("TL_CONFIG_TEST_CRASH_PHASE").unwrap());
        if operation == "apply" {
            config.apply(&target("a/b"), None).unwrap();
        } else {
            config.restore(operation == "force").unwrap();
        }
        panic!("crash checkpoint was not reached");
    }

    #[test]
    fn hard_process_exit_recovers_apply_restore_and_force() {
        // This module is also included by quota_parser; libtest names omit
        // the crate prefix, so derive the child's path from this test target.
        let child_test = format!(
            "{}::transaction_process_crash_child",
            module_path!().split_once("::").unwrap().1
        );
        for operation in ["apply", "restore", "force"] {
            for phase in [
                "prepared",
                "staged",
                "written:0",
                "written:1",
                "written:2",
                "written:3",
                "written:4",
                "before-commit",
                "committed",
            ] {
                let (dir, config) = fixture(&format!(
                    "hard-crash-{operation}-{}",
                    phase.replace(':', "-")
                ));
                if operation != "apply" {
                    config.apply(&target("a/b"), None).unwrap();
                }
                if operation == "force" {
                    fs::write(&config.spec.files[1].path, br#"{"external":true}"#).unwrap();
                }
                let before = state(&config);
                let result = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", child_test.as_str()])
                    .env("TL_CONFIG_TEST_CRASH_DIR", &dir)
                    .env("TL_CONFIG_TEST_CRASH_OPERATION", operation)
                    .env("TL_CONFIG_TEST_CRASH_PHASE", phase)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .unwrap();
                assert_eq!(result.code(), Some(99), "{operation}/{phase}");
                let restarted = demo(&dir, true);
                restarted.recover_pending().unwrap();
                let inspection = restarted.inspect(BASE).unwrap();
                if phase == "committed" {
                    if operation == "apply" {
                        assert!(inspection.backup.unwrap().restorable_without_force);
                    } else {
                        assert!(inspection.backup.is_none());
                    }
                } else {
                    assert_eq!(state(&restarted), before, "{operation}/{phase}");
                }
                fs::remove_dir_all(dir).unwrap();
            }
        }
    }

    #[test]
    fn legacy_manifest_without_managed_hash_still_restores_untouched_files() {
        let (dir, config) = fixture("legacy-manifest");
        let config =
            config.managed_keys(&[&["model"], &["default"], &["providers", "tokenledger"]]);
        config.apply(&target("a/b"), None).unwrap();
        let path = config.backup_dir.join(MANIFEST_FILE);
        let mut legacy: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for file in legacy["files"].as_array_mut().unwrap() {
            file.as_object_mut().unwrap().remove("appliedManaged");
        }
        fs::write(path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(
            config
                .inspect(BASE)
                .unwrap()
                .backup
                .unwrap()
                .restorable_without_force
        );
        config.restore(false).unwrap();
        assert_eq!(
            fs::read(&config.spec.files[0].path).unwrap(),
            br#"{"model":"old","keep":1}"#
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_or_orphaned_backup_never_gets_replaced_by_apply() {
        for mode in ["manifest", "backup", "orphan"] {
            let (dir, config) = fixture(&format!("invalid-backup-{mode}"));
            config.apply(&target("a/b"), None).unwrap();
            match mode {
                "manifest" => fs::write(config.backup_dir.join(MANIFEST_FILE), b"corrupt").unwrap(),
                "backup" => fs::write(config.backup_path(0), b"corrupt").unwrap(),
                _ => fs::remove_file(config.backup_dir.join(MANIFEST_FILE)).unwrap(),
            }
            let before = state(&config);
            assert!(config.apply(&target("a/c"), None).is_err());
            assert_eq!(state(&config), before);
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn recovery_preserves_external_drift_and_journal() {
        let (dir, config) = fixture("crash-external-drift");
        transaction::inject(0, Some("written:0"));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || config.apply(&target("a/b"), None)
        ))
        .is_err());
        transaction::inject(0, None);
        fs::write(&config.spec.files[0].path, br#"{"external":"keep"}"#).unwrap();
        let before = state(&config);
        assert!(config.inspect(BASE).unwrap_err().contains("外部修改"));
        assert_eq!(state(&config), before);
        assert!(config.backup_dir.join("transaction-v1.json").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    fn keys(map: &Map<String, Value>) -> Vec<&str> {
        map.keys().map(String::as_str).collect()
    }

    #[test]
    fn apply_keeps_the_original_key_order_and_appends_new_keys() {
        let dir = temp_dir("key-order");
        let config = demo(&dir, false);
        let path = dir.join("home/demo.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            br#"{"zeta":1,"model":"old","alpha":{"y":1,"b":2},"providers":{"zz":{},"tokenledger":{"key":"old","extra":true},"aa":{}}}"#,
        )
        .unwrap();

        config
            .apply(&target("deepseek/deepseek-chat"), None)
            .unwrap();
        let written = read_json(&path);
        assert_eq!(keys(&written), ["zeta", "model", "alpha", "providers"]);
        assert_eq!(keys(written["alpha"].as_object().unwrap()), ["y", "b"]);
        let providers = written["providers"].as_object().unwrap();
        assert_eq!(keys(providers), ["zz", "tokenledger", "aa"]);
        assert_eq!(
            keys(providers[PROVIDER_ID].as_object().unwrap()),
            ["key", "extra", "url"]
        );

        config.restore(false).unwrap();
        fs::write(&path, br#"{"zeta":1,"alpha":{}}"#).unwrap();
        config
            .apply(&target("deepseek/deepseek-chat"), None)
            .unwrap();
        assert_eq!(
            keys(&read_json(&path)),
            ["zeta", "alpha", "providers", "model"]
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn apply_keeps_other_keys_masks_token_and_restores_the_original() {
        let dir = temp_dir("roundtrip");
        let config = demo(&dir, false);
        let path = dir.join("home/demo.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = b"{\"theme\":\"dark\",\"providers\":{\"other\":{\"key\":\"sk-provider\"}}}";
        fs::write(&path, original).unwrap();

        let preview = config.preview(&target("deepseek/deepseek-chat")).unwrap();
        assert!(preview.changed);
        assert!(!preview.diff.contains(TOKEN));
        assert!(preview.diff.contains("tl-…abcd"));
        let applied = config
            .apply(
                &target("deepseek/deepseek-chat"),
                Some(&preview.before_version),
            )
            .unwrap();
        assert!(applied.backup_created);

        let written = read_json(&path);
        assert_eq!(lookup_str(&written, &["theme"]), Some("dark"));
        assert_eq!(
            lookup_str(&written, &["providers", "other", "key"]),
            Some("sk-provider")
        );
        assert_eq!(
            lookup_str(&written, &["providers", PROVIDER_ID, "key"]),
            Some(TOKEN)
        );
        let inspection = config.inspect(BASE).unwrap();
        assert!(inspection.points_to_gateway);
        assert_eq!(inspection.model.as_deref(), Some("deepseek/deepseek-chat"));
        assert!(inspection.backup.unwrap().restorable_without_force);

        let again = config.apply(&target("group/coding"), None).unwrap();
        assert!(!again.backup_created, "first backup is kept");
        config.restore(false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(config.inspect(BASE).unwrap().backup.is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn managed_switch_preserves_unrelated_edit_and_first_backup() {
        let dir = temp_dir("managed-lease-first-backup");
        let config = demo(&dir, false).managed_keys(&[&["model"], &["providers", "tokenledger"]]);
        let path = &config.spec.files[0].path;
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = br#"{"model":"official","theme":"dark"}"#;
        fs::write(path, original).unwrap();
        config.apply(&target("a/model"), None).unwrap();
        let mut edited = read_json(path);
        edited.insert("theme".into(), Value::from("light"));
        fs::write(path, serde_json::to_vec(&edited).unwrap()).unwrap();
        assert!(
            !config
                .apply(&target("b/model"), None)
                .unwrap()
                .backup_created
        );
        assert_eq!(fs::read(config.backup_path(0)).unwrap(), original);
        config.restore(false).unwrap();
        let restored = read_json(path);
        assert_eq!(lookup_str(&restored, &["model"]), Some("official"));
        assert_eq!(lookup_str(&restored, &["theme"]), Some("light"));
        assert!(lookup(&restored, &["providers", "tokenledger"]).is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn external_edit_cannot_replace_first_backup() {
        let dir = temp_dir("lease-first-backup");
        let config = demo(&dir, true);
        fs::create_dir_all(config.spec.files[0].path.parent().unwrap()).unwrap();
        let original = br#"{"model":"official"}"#;
        fs::write(&config.spec.files[0].path, original).unwrap();
        config.apply(&target("a/model"), None).unwrap();
        let mut edited = read_json(&config.spec.files[0].path);
        edited.insert("unrelated".into(), Value::Bool(true));
        fs::write(
            &config.spec.files[0].path,
            serde_json::to_vec(&edited).unwrap(),
        )
        .unwrap();
        let before: Vec<_> = config
            .transaction_paths()
            .iter()
            .map(|p| transaction::read(p).unwrap())
            .collect();
        assert!(config
            .apply(&target("b/model"), None)
            .unwrap_err()
            .contains("冲突"));
        let after: Vec<_> = config
            .transaction_paths()
            .iter()
            .map(|p| transaction::read(p).unwrap())
            .collect();
        assert_eq!(before, after);
        assert!(config.restore(false).is_err());
        config.restore(true).unwrap();
        assert_eq!(fs::read(&config.spec.files[0].path).unwrap(), original);
        assert!(!config.spec.files[1].path.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_files_are_created_and_removed_on_restore() {
        let dir = temp_dir("missing");
        let config = demo(&dir, true);
        config.apply(&target("group/coding"), None).unwrap();
        assert_eq!(
            lookup_str(&read_json(&dir.join("home/settings.json")), &["default"]),
            Some("group/coding")
        );
        let restored = config.restore(false).unwrap();
        assert!(restored.removed);
        assert!(!dir.join("home/demo.json").exists());
        assert!(!dir.join("home/settings.json").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn stale_preview_outside_edits_and_comments_are_refused() {
        let dir = temp_dir("refuse");
        let config = demo(&dir, false);
        let path = dir.join("home/demo.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{}").unwrap();
        let preview = config.preview(&target("a/b")).unwrap();
        fs::write(&path, b"{\"x\":1}").unwrap();
        assert!(config
            .apply(&target("a/b"), Some(&preview.before_version))
            .is_err());

        config.apply(&target("a/b"), None).unwrap();
        fs::write(&path, b"{\"edited\":true}").unwrap();
        assert!(config.restore(false).is_err());
        assert!(
            !config
                .inspect(BASE)
                .unwrap()
                .backup
                .unwrap()
                .restorable_without_force
        );
        config.restore(true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"x\":1}");

        fs::write(&path, b"{ \"a\": }").unwrap();
        let error = config.preview(&target("a/b")).unwrap_err();
        assert!(error.contains("不是有效的 JSON"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn jsonc_comments_survive_apply_and_restore() {
        let dir = temp_dir("jsonc");
        let config = demo(&dir, false);
        let path = dir.join("home/demo.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original =
            "// user settings\n{\n  \"theme\": \"dark\", // keep me\n  \"model\": \"old\",\n}\n";
        fs::write(&path, original).unwrap();

        let preview = config.preview(&target("a/b")).unwrap();
        assert!(!preview.diff.contains(TOKEN));
        config
            .apply(&target("a/b"), Some(&preview.before_version))
            .unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.starts_with(
            "// user settings\n{\n  \"theme\": \"dark\", // keep me\n  \"model\": \"a/b\","
        ));
        assert!(written.contains(TOKEN));
        assert!(config.inspect(BASE).unwrap().points_to_gateway);
        config.restore(false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);

        fs::write(&path, "{ \"model\": \"x\", \"model\": \"y\", }").unwrap();
        let error = config.preview(&target("a/b")).unwrap_err();
        assert!(error.contains("无法安全定位"), "{error}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn env_files_are_merged_line_by_line() {
        let text = "# c\nexport A='x y'\nB=1 # n\nB=2\n C = \"q#\" \nbad line\nD=\n";
        let parsed = parse_env(text);
        assert_eq!(parsed["A"], "x y");
        assert_eq!(parsed["B"], "2", "the last duplicate wins");
        assert_eq!(parsed["C"], "q#");
        assert_eq!(parsed["D"], "");
        let mut doc = parsed.clone();
        doc.insert("B".into(), Value::from("3"));
        doc.insert("C".into(), Value::from("has space"));
        doc.remove("D");
        doc.insert("E".into(), Value::from("http://h:1"));
        let written = String::from_utf8(serialize_env(Some(text.as_bytes()), &doc)).unwrap();
        assert_eq!(
            written,
            "# c\nexport A='x y'\nB=3\nB=3\nC=\"has space\"\nbad line\nE=http://h:1\n"
        );
        assert!(is_env(Path::new("/x/.env")) && !is_env(Path::new("/x/settings.json")));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_config_is_refused() {
        let dir = temp_dir("symlink");
        let config = demo(&dir, false);
        fs::create_dir_all(dir.join("home")).unwrap();
        fs::write(dir.join("real.json"), b"{}").unwrap();
        std::os::unix::fs::symlink(dir.join("real.json"), dir.join("home/demo.json")).unwrap();
        assert!(config.inspect(BASE).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
