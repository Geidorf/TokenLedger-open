//! Durable accounting precedes the rotating diagnostic JSON line per request. Input is stored net of cache reads so
//! effective tokens stay input + output; cache reads and writes are separate.
//! Not merged into the dashboard until dashboard-stats-v2 defines how it
//! dedupes against scanned logs (T10.264).

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) mod accounting;

const LEDGER_FILE: &str = "usage-v1.jsonl";
const ROTATE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

fn num(value: &Value, path: &[&str]) -> Option<u64> {
    let mut current = value;
    for key in path {
        current = current.get(key)?;
    }
    current.as_u64()
}

impl Usage {
    /// `usage` of a Responses API reply: input_tokens includes cached tokens.
    pub fn from_responses(usage: &Value) -> Option<Self> {
        let input = num(usage, &["input_tokens"])?;
        let output = num(usage, &["output_tokens"]).unwrap_or(0);
        let cached = num(usage, &["input_tokens_details", "cached_tokens"]).unwrap_or(0);
        Some(Self {
            input: input.saturating_sub(cached),
            output,
            cache_read: cached,
            cache_write: 0,
        })
    }

    /// `usage` of a Chat Completions reply: prompt_tokens includes cached tokens
    /// (`prompt_tokens_details.cached_tokens`, or DeepSeek's `prompt_cache_hit_tokens`).
    pub fn from_chat(usage: &Value) -> Option<Self> {
        let prompt = num(usage, &["prompt_tokens"])?;
        let output = num(usage, &["completion_tokens"]).unwrap_or(0);
        let cached = num(usage, &["prompt_tokens_details", "cached_tokens"])
            .or_else(|| num(usage, &["prompt_cache_hit_tokens"]))
            .unwrap_or(0);
        Some(Self {
            input: prompt.saturating_sub(cached),
            output,
            cache_read: cached,
            cache_write: 0,
        })
    }

    /// `usage` of an Anthropic Messages reply: `input_tokens` already excludes
    /// cache reads and writes, which are reported separately. A streamed reply
    /// splits usage across `message_start` and `message_delta`; fields present
    /// in the later event replace earlier ones.
    pub fn absorb_anthropic(previous: Option<Self>, usage: &Value) -> Option<Self> {
        let fields = [
            num(usage, &["input_tokens"]),
            num(usage, &["output_tokens"]),
            num(usage, &["cache_read_input_tokens"]),
            num(usage, &["cache_creation_input_tokens"]),
        ];
        if fields.iter().all(Option::is_none) {
            return previous;
        }
        let base = previous.unwrap_or_default();
        Some(Self {
            input: fields[0].unwrap_or(base.input),
            output: fields[1].unwrap_or(base.output),
            cache_read: fields[2].unwrap_or(base.cache_read),
            cache_write: fields[3].unwrap_or(base.cache_write),
        })
    }
}

pub const MAX_SSE_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_SSE_EVENT_BYTES: usize = 2 * 1024 * 1024;

/// Split into complete lines without permitting an unterminated line or
/// multi-line event to retain unbounded memory. CRLF counts toward the limits.
#[derive(Default)]
pub struct SseLines {
    buffer: Vec<u8>,
    event_bytes: usize,
}

impl SseLines {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        let mut lines = Vec::new();
        for part in chunk.split_inclusive(|byte| *byte == b'\n') {
            if part.len() > MAX_SSE_LINE_BYTES.saturating_sub(self.buffer.len()) {
                return Err("上游 SSE 单行超过 1MiB。".into());
            }
            if part.len() > MAX_SSE_EVENT_BYTES.saturating_sub(self.event_bytes) {
                return Err("上游 SSE 单事件超过 2MiB。".into());
            }
            self.event_bytes += part.len();
            self.buffer.extend_from_slice(part);
            if part.last() == Some(&b'\n') {
                let text = String::from_utf8_lossy(&self.buffer)
                    .trim_end_matches(['\n', '\r'])
                    .to_string();
                self.buffer.clear();
                if text.is_empty() {
                    self.event_bytes = 0;
                }
                lines.push(text);
            }
        }
        Ok(lines)
    }

    pub fn finish(&mut self) -> Option<String> {
        if self.buffer.is_empty() {
            return None;
        }
        let text = String::from_utf8_lossy(&self.buffer)
            .trim_end_matches('\r')
            .to_string();
        self.buffer.clear();
        self.event_bytes = 0;
        Some(text)
    }
}

pub fn sse_data(line: &str) -> Option<&str> {
    line.strip_prefix("data:").map(str::trim_start)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRecord {
    pub ts: String,
    /// Unique upstream attempt id; legacy rows used the logical request id.
    pub request_id: String,
    /// Stable id across failover attempts. Missing on legacy v1 rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logical_request_id: Option<String>,
    pub agent: Option<String>,
    pub session: Option<String>,
    pub endpoint: String,
    pub provider: String,
    pub requested_model: String,
    pub upstream_model: String,
    pub wire: String,
    pub stream: bool,
    pub status: u16,
    pub ok: bool,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub latency_ms: u64,
    pub error: Option<String>,
    /// Routing group id when the Agent asked for `group/<id>` (T10.267).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// The `provider/model` member that served this attempt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<String>,
}

pub struct Ledger {
    path: PathBuf,
    lock: Mutex<()>,
}

impl Ledger {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join(LEDGER_FILE),
            lock: Mutex::new(()),
        }
    }

    pub fn append(&self, record: &LedgerRecord) -> Result<(), String> {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        }
        let dir = self.path.parent().ok_or("网关账本目录缺失")?;
        if !accounting::append(dir, record)? {
            log::warn!("gateway diagnostic rotation deferred: legacy accounting import pending");
            return Ok(());
        }
        if let Err(error) = self.append_diagnostic(record) {
            // The billable identity is already committed. Do not report this as
            // a retryable accounting failure or charge the request twice.
            log::warn!("gateway diagnostic ledger: {error}");
        }
        Ok(())
    }

    fn append_diagnostic(&self, record: &LedgerRecord) -> Result<(), String> {
        if fs::metadata(&self.path)
            .map(|meta| meta.len() >= ROTATE_BYTES)
            .unwrap_or(false)
        {
            fs::rename(&self.path, self.path.with_extension("jsonl.1"))
                .map_err(|error| format!("轮转网关诊断日志失败：{error}"))?;
        }
        let mut line = serde_json::to_vec(record).map_err(|error| error.to_string())?;
        line.push(b'\n');
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut file| file.write_all(&line))
            .map_err(|error| format!("写入网关记账失败：{error}"))
    }

    pub fn recent(&self, limit: usize) -> Result<Vec<LedgerRecord>, String> {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let file = match fs::File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        let mut records: Vec<LedgerRecord> = BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| serde_json::from_str(&line).ok())
            .collect();
        let skip = records.len().saturating_sub(limit);
        records.drain(..skip);
        records.reverse();
        Ok(records)
    }
}

/// "codex_cli_rs/0.48.0 (Mac OS 15.0; arm64)" → "codex".
pub fn agent_from_user_agent(user_agent: &str) -> Option<String> {
    // Gemini CLI in a VS Code-family terminal sends "CloudCodeVSCode/… proxy_client=geminicli".
    if user_agent.contains("proxy_client=geminicli") {
        return Some("gemini-cli".to_string());
    }
    let product = user_agent
        .split_whitespace()
        .next()?
        .split('/')
        .next()?
        .to_ascii_lowercase();
    let known = [
        ("codex", "codex"),
        ("claude-cli", "claude-code"),
        ("claude-code", "claude-code"),
        ("opencode", "opencode"),
        ("gemini", "gemini-cli"),
        ("goose", "goose"),
        ("crush", "crush"),
    ];
    for (prefix, agent) in known {
        if product.starts_with(prefix) {
            return Some(agent.to_string());
        }
    }
    if product.is_empty() {
        None
    } else {
        Some(product.chars().take(32).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn responses_usage_is_net_of_cache() {
        let usage = Usage::from_responses(&json!({
            "input_tokens": 1200, "output_tokens": 80,
            "input_tokens_details": {"cached_tokens": 1000},
            "output_tokens_details": {"reasoning_tokens": 30}
        }))
        .unwrap();
        assert_eq!(
            usage,
            Usage {
                input: 200,
                output: 80,
                cache_read: 1000,
                cache_write: 0
            }
        );
    }

    #[test]
    fn chat_usage_reads_openai_and_deepseek_cache_fields() {
        let openai = Usage::from_chat(&json!({"prompt_tokens": 500, "completion_tokens": 20, "prompt_tokens_details": {"cached_tokens": 384}})).unwrap();
        assert_eq!((openai.input, openai.cache_read), (116, 384));
        let deepseek = Usage::from_chat(
            &json!({"prompt_tokens": 500, "completion_tokens": 20, "prompt_cache_hit_tokens": 448}),
        )
        .unwrap();
        assert_eq!((deepseek.input, deepseek.cache_read), (52, 448));
    }

    #[test]
    fn anthropic_usage_keeps_cache_out_of_input_and_merges_stream_events() {
        let start = Usage::absorb_anthropic(
            None,
            &json!({
                "input_tokens": 20, "output_tokens": 1,
                "cache_read_input_tokens": 9000, "cache_creation_input_tokens": 300
            }),
        );
        assert_eq!(
            start,
            Some(Usage {
                input: 20,
                output: 1,
                cache_read: 9000,
                cache_write: 300
            })
        );
        let done = Usage::absorb_anthropic(start, &json!({"output_tokens": 412}));
        assert_eq!(
            done,
            Some(Usage {
                input: 20,
                output: 412,
                cache_read: 9000,
                cache_write: 300
            })
        );
        assert_eq!(Usage::absorb_anthropic(done, &json!({})), done);
        assert_eq!(Usage::absorb_anthropic(None, &json!({})), None);
    }

    #[test]
    fn sse_lines_keep_partial_tail() {
        let mut lines = SseLines::default();
        assert_eq!(lines.push(b"data: {\"a\"").unwrap(), Vec::<String>::new());
        assert_eq!(
            lines.push(b":1}\r\n\ndata: [DO").unwrap(),
            vec!["data: {\"a\":1}".to_string(), String::new()]
        );
        assert_eq!(lines.finish().as_deref(), Some("data: [DO"));
    }

    #[test]
    fn ledger_appends_and_reads_newest_first() {
        let dir = std::env::temp_dir().join(format!("tl-gw-ledger-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let ledger = Ledger::new(&dir);
        for index in 0..3u64 {
            ledger
                .append(&LedgerRecord {
                    ts: format!("2026-10-05T00:00:0{index}Z"),
                    request_id: format!("r{index}"),
                    logical_request_id: None,
                    agent: Some("codex".into()),
                    session: None,
                    endpoint: "responses".into(),
                    provider: "openai".into(),
                    requested_model: "openai/gpt-5.5".into(),
                    upstream_model: "gpt-5.5".into(),
                    wire: "responses".into(),
                    stream: true,
                    status: 200,
                    ok: true,
                    input: index,
                    output: 1,
                    cache_read: 0,
                    cache_write: 0,
                    latency_ms: 10,
                    error: None,
                    group: None,
                    member: None,
                })
                .unwrap();
        }
        let recent = ledger.recent(2).unwrap();
        assert_eq!(
            recent
                .iter()
                .map(|r| r.request_id.as_str())
                .collect::<Vec<_>>(),
            vec!["r2", "r1"]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rows_without_group_fields_still_parse() {
        let old = r#"{"ts":"t","requestId":"r","agent":null,"session":null,"endpoint":"responses","provider":"p","requestedModel":"p/m","upstreamModel":"m","wire":"responses","stream":false,"status":200,"ok":true,"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"latencyMs":5,"error":null}"#;
        let record: LedgerRecord = serde_json::from_str(old).unwrap();
        assert_eq!((&record.group, &record.member), (&None, &None));
        let line = serde_json::to_string(&record).unwrap();
        assert!(!line.contains("group") && !line.contains("member"));
    }

    #[test]
    fn user_agent_maps_to_agent_id() {
        assert_eq!(
            agent_from_user_agent("codex_cli_rs/0.48.0 (Mac OS)").as_deref(),
            Some("codex")
        );
        assert_eq!(
            agent_from_user_agent("claude-cli/2.3.1 (external, cli)").as_deref(),
            Some("claude-code")
        );
        assert_eq!(
            agent_from_user_agent("CloudCodeVSCode/0.62.0 (aidev_client; os_type=macOS; host_path=VSCode/3.2; proxy_client=geminicli)").as_deref(),
            Some("gemini-cli")
        );
        assert_eq!(agent_from_user_agent("").as_deref(), None);
    }
}
