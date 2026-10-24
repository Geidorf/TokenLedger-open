//! Mutation fuzzing and property tests for the file-based usage parsers.
//!
//! Every target starts from a small valid seed in its real on-disk layout and
//! runs randomly mutated copies (truncation, invalid UTF-8, broken JSON,
//! duplicated or shuffled lines, extreme counters, scrambled timestamps, BOM
//! and CRLF, long lines) through the production parser and the production
//! persist path. Each case must not panic, must finish quickly, must persist
//! only sane counters, must be idempotent on rescan, and — where the format
//! carries stable record ids — must not count duplicated records twice.
//!
//! `cargo test` runs a short deterministic pass. CI's fuzz smoke step raises
//! the case count with `TOKENLEDGER_FUZZ_ITERS` and varies the seed with
//! `TOKENLEDGER_FUZZ_SEED`; a failure prints the seed and case, and
//! `replay_reported_case` reruns exactly that input.

use super::antigravity::scan_antigravity_roots_checkpointed;
use super::claude::scan_claude_dir;
use super::codex::scan_codex_roots;
use super::dsh::scan_dsh_root_checkpointed;
use super::gemini::scan_gemini_root;
use super::grok::scan_grok_root;
use super::kimi::{scan_kimi_roots_checkpointed, KIMI_CHECKPOINT_SOURCE_KIND};
use super::other_tools::scan_deepseekgui_dir;
use super::pi::scan_pi_roots_checkpointed;
use super::qwen::scan_qwen_root;
use super::reasonix::{reasonix_session_roots, scan_reasonix_from};
use super::runner::{insert_cumulative_delta, persist_scan_batch_with_antigravity};
use super::types::{AntigravityRecordProvenance, LogRecord};
use serde_json::{json, Value};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Per-thread allocation accounting, so memory bounds hold under parallel tests.

struct CountingAlloc;

thread_local! {
    static LIVE: Cell<isize> = const { Cell::new(0) };
    static PEAK: Cell<isize> = const { Cell::new(0) };
}

fn track(delta: isize) {
    let _ = LIVE.try_with(|live| {
        let now = live.get() + delta;
        live.set(now);
        let _ = PEAK.try_with(|peak| {
            if now > peak.get() {
                peak.set(now);
            }
        });
    });
}

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            track(layout.size() as isize);
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        track(-(layout.size() as isize));
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            track(layout.size() as isize);
        }
        pointer
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(pointer, layout, new_size) };
        if !moved.is_null() {
            track(new_size as isize - layout.size() as isize);
        }
        moved
    }
}

#[global_allocator]
static ALLOCATOR: CountingAlloc = CountingAlloc;

/// Peak bytes allocated by this thread while `run` executes, above the
/// allocation level at entry.
fn peak_allocation<T>(run: impl FnOnce() -> T) -> (T, usize) {
    let base = LIVE.with(Cell::get);
    PEAK.with(|peak| peak.set(base));
    let value = run();
    let peak = PEAK.with(Cell::get);
    (value, (peak - base).max(0) as usize)
}

// ---------------------------------------------------------------------------
// Deterministic randomness (no dev-dependency).

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed ^ 0x9E37_79B9_7F4A_7C15 | 1)
    }

    fn next(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, bound: usize) -> usize {
        if bound == 0 {
            0
        } else {
            (self.next() % bound as u64) as usize
        }
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

fn base_seed() -> u64 {
    std::env::var("TOKENLEDGER_FUZZ_SEED")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0x5EED_2026_1024)
}

fn iterations() -> usize {
    std::env::var("TOKENLEDGER_FUZZ_ITERS")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(24)
}

// ---------------------------------------------------------------------------
// Temp layout and persistence helpers.

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "tokenledger_fuzz_{label}_{}_{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create fuzz temp dir");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_file(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture dir");
    fs::write(path, bytes).expect("write fixture");
}

#[derive(Default)]
struct Scan {
    logs: Vec<LogRecord>,
    provenance: HashMap<String, AntigravityRecordProvenance>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Totals {
    rows: i64,
    input: i64,
    output: i64,
    cached: i64,
}

fn persist(db: &Path, scan: Scan) -> Result<usize, String> {
    persist_scan_batch_with_antigravity(
        db,
        scan.logs,
        Vec::new(),
        Vec::new(),
        None,
        &scan.provenance,
    )
    .map(|outcome| outcome.inserted)
    .map_err(|error| error.to_string())
}

fn totals(db: &Path) -> Result<Totals, String> {
    let conn = crate::db::get_connection(db).map_err(|error| error.to_string())?;
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(cached_tokens), 0)
         FROM token_logs",
        [],
        |row| {
            Ok(Totals {
                rows: row.get(0)?,
                input: row.get(1)?,
                output: row.get(2)?,
                cached: row.get(3)?,
            })
        },
    )
    .map_err(|error| error.to_string())
}

/// Largest per-row counter the ledger accepts; see `runner::sanitize_log_record`.
const SANE_COUNTER: i64 = super::runner::MAX_TOKENS_PER_RECORD;

fn insane_rows(db: &Path) -> Result<i64, String> {
    let conn = crate::db::get_connection(db).map_err(|error| error.to_string())?;
    conn.query_row(
        "SELECT COUNT(*) FROM token_logs
         WHERE input_tokens NOT BETWEEN 0 AND ?1
            OR output_tokens NOT BETWEEN 0 AND ?1
            OR cached_tokens NOT BETWEEN 0 AND ?1
            OR cache_write_tokens NOT BETWEEN 0 AND ?1
            OR (cost_usd IS NOT NULL AND (cost_usd < 0 OR cost_usd > 1e6))
            OR typeof(input_tokens) != 'integer'",
        [SANE_COUNTER],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Targets.

/// How the seed is laid out: one JSON value per line, or one JSON document.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Shape {
    Lines,
    Document,
}

struct Target {
    name: &'static str,
    shape: Shape,
    seed: fn() -> Vec<Value>,
    /// Writes the (possibly mutated) bytes into the source's real layout.
    write: fn(&Path, &[u8]),
    scan: fn(&Path) -> Scan,
    /// Records carry stable ids, so repeating them must not add tokens.
    stable_ids: bool,
    /// Lines after the first may be reordered without changing totals.
    order_free: bool,
}

const CODEX_ID: &str = "00000000-0000-4000-8000-00000000f022";
const ANTIGRAVITY_SESSION: &str = "11111111-2222-4333-8444-555555555555";

fn claude_seed() -> Vec<Value> {
    let assistant = |id: &str, request: &str, output: i64, ts: &str| {
        json!({"type":"assistant","timestamp":ts,"requestId":request,"uuid":format!("u-{id}-{output}"),
            "message":{"id":id,"model":"claude-sonnet-4-5","role":"assistant",
                "content":[{"type":"text","text":"done ✓ 完成"}],
                "usage":{"input_tokens":120,"output_tokens":output,
                    "cache_read_input_tokens":900,"cache_creation_input_tokens":40}}})
    };
    vec![
        json!({"type":"user","timestamp":"2026-10-01T08:00:00.000Z","message":{"role":"user","content":"hi"}}),
        assistant("msg_a", "req_a", 1, "2026-10-01T08:00:01.000Z"),
        assistant("msg_a", "req_a", 75, "2026-10-01T08:00:02.000Z"),
        assistant("msg_b", "req_b", 33, "2026-10-01T08:01:00.000Z"),
    ]
}

fn codex_seed() -> Vec<Value> {
    let event = |ts: &str, total: (i64, i64, i64), last: (i64, i64, i64)| {
        json!({"timestamp":ts,"type":"event_msg","payload":{"type":"token_count","info":{
            "total_token_usage":{"input_tokens":total.0,"cached_input_tokens":total.1,
                "output_tokens":total.2,"total_tokens":total.0 + total.2},
            "last_token_usage":{"input_tokens":last.0,"cached_input_tokens":last.1,
                "output_tokens":last.2,"total_tokens":last.0 + last.2}}}})
    };
    vec![
        json!({"timestamp":"2026-07-15T00:00:00Z","type":"session_meta",
            "payload":{"id":CODEX_ID,"source":"cli"}}),
        json!({"timestamp":"2026-07-15T00:00:01Z","type":"turn_context","payload":{"model":"gpt-5.5"}}),
        event("2026-07-15T00:00:02Z", (1000, 200, 50), (1000, 200, 50)),
        event("2026-07-15T00:00:03Z", (1000, 200, 50), (1000, 200, 50)),
        event("2026-07-15T00:00:04Z", (2500, 900, 80), (1500, 700, 30)),
        event("2026-07-15T00:00:05Z", (4000, 1500, 130), (1500, 600, 50)),
    ]
}

fn gemini_message(id: &str, input: i64, output: i64, cached: i64) -> Value {
    json!({"id":id,"type":"gemini","model":"gemini-3.5-flash","timestamp":"2026-08-19T00:40:03.421Z",
        "tokens":{"input":input + cached,"output":output,"cached":cached,"thoughts":7,"tool":0,
            "total":input + cached + output + 7}})
}

fn gemini_lines_seed() -> Vec<Value> {
    vec![
        json!({"kind":"chat","sessionId":"0ac01f74-a7a1-400b-8ac5-408ae4c97cac",
            "startTime":"2026-08-19T00:39:53.525Z"}),
        json!({"id":"u1","type":"user","timestamp":"2026-08-19T00:39:53.525Z","content":[{"text":"hi"}]}),
        gemini_message("m1", 1600, 12, 0),
        gemini_message("m2", 300, 40, 1200),
        gemini_message("m3", 90, 5, 10),
    ]
}

fn gemini_document_seed() -> Vec<Value> {
    vec![json!({"sessionId":"legacy-session","messages":[
        {"id":"u1","type":"user","timestamp":"2026-08-19T00:39:53.525Z","content":"hi"},
        gemini_message("m1", 1600, 12, 0),
        gemini_message("m2", 300, 40, 1200),
    ]})]
}

fn grok_seed() -> Vec<Value> {
    let done = |sid: &str, ts: &str, loop_index: i64, prompt: i64| {
        json!({"msg":"shell.turn.inference_done","sid":sid,"ts":ts,
            "ctx":{"prompt_tokens":prompt,"cached_prompt_tokens":prompt / 3,
                "completion_tokens":17,"loop_index":loop_index}})
    };
    vec![
        json!({"msg":"shell.start","ts":"2026-09-01T10:00:00Z"}),
        done("sid-1", "2026-09-01T10:00:01Z", 0, 900),
        done("sid-1", "2026-09-01T10:00:05Z", 1, 1200),
        done("sid-2", "2026-09-01T11:00:00Z", 0, 300),
    ]
}

fn kimi_seed() -> Vec<Value> {
    let usage = |time: i64, scope: &str, other: i64| {
        json!({"type":"usage.record","usageScope":scope,"time":time,"model":"kimi-k2",
            "usage":{"inputOther":other,"output":21,"inputCacheRead":400,"inputCacheCreation":3}})
    };
    vec![
        json!({"type":"turn.begin","time":1_760_000_000}),
        usage(1_760_000_001, "turn", 120),
        usage(1_760_000_002, "turn", 140),
        usage(1_760_000_003, "session", 15),
    ]
}

fn pi_seed() -> Vec<Value> {
    let message = |id: &str, ts: i64, input: i64| {
        json!({"type":"message","id":id,"timestamp":"2026-10-01T00:00:00Z",
            "message":{"role":"assistant","model":"m-pi","timestamp":ts,
                "usage":{"input":input,"output":9,"cacheRead":30,"cacheWrite":2,
                    "totalTokens":input + 41}}})
    };
    vec![
        json!({"type":"session","id":"pi-session-1","timestamp":"2026-10-01T00:00:00Z"}),
        json!({"type":"model_change","id":"mc1","modelId":"m-pi"}),
        message("e1", 1_760_000_000_000, 100),
        message("e2", 1_760_000_001_000, 50),
        json!({"type":"compaction","id":"c1","timestamp":"2026-10-01T00:02:00Z",
            "usage":{"input":10,"output":4,"cacheRead":0,"cacheWrite":0}}),
    ]
}

fn qwen_seed() -> Vec<Value> {
    include_str!("../../tests/fixtures/qwen-code/session.jsonl")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("qwen fixture line"))
        .collect()
}

fn dsh_seed() -> Vec<Value> {
    let message = |id: &str, time: i64, input: i64| {
        json!({"type":"assistant/message","time":time,"data":{
            "usage":{"inputTokens":input,"outputTokens":14,"cacheReadTokens":60,"reasoningTokens":3},
            "message":{"id":id,"source":{"model":"deepseek-chat"}}}})
    };
    vec![
        json!({"type":"session","id":"dsh-session-1","createdAt":1_760_000_000_000_i64}),
        json!({"type":"request/header","data":{"header":{"config":{"model":"deepseek-chat"}}}}),
        message("dm1", 1_760_000_001_000, 210),
        message("dm2", 1_760_000_002_000, 95),
    ]
}

fn deepseekgui_seed() -> Vec<Value> {
    let usage = |seq: i64, prompt: i64, hit: i64| {
        json!({"seq":seq,"timestamp":"2026-06-09T11:39:18.575Z","threadId":"thr_fuzz","kind":"usage",
            "model":"deepseek-v4-pro","turnId":format!("turn-{seq}"),
            "usage":{"promptTokens":prompt,"completionTokens":20,"cacheMissTokens":prompt - hit,
                "cacheHitTokens":hit}})
    };
    vec![
        json!({"seq":1,"timestamp":"2026-06-09T11:39:00.000Z","threadId":"thr_fuzz","kind":"message"}),
        usage(2, 1000, 300),
        usage(3, 700, 100),
    ]
}

fn antigravity_seed() -> Vec<Value> {
    let row = |step: i64, input: i64| {
        json!({"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","step_index":step,
            "created_at":"2026-10-08T00:00:00Z","input_tokens":input,"output_tokens":12,
            "cache_read_tokens":50,"thinking":"notes","content":"answer"})
    };
    vec![
        json!({"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<USER_SETTINGS_CHANGE>The user changed setting Model Selection from Auto to Gemini 3.5 Pro.</USER_SETTINGS_CHANGE>"}),
        row(1, 400),
        row(2, 650),
    ]
}

fn reasonix_seed() -> Vec<Value> {
    vec![
        json!({"version":2,"usage":{"promptTokens":10_000,"completionTokens":400,
        "totalTokens":10_400,"cacheHitTokens":7_000,"cacheMissTokens":3_000,"requestCount":3,
        "sessionCostUsd":0.12}}),
    ]
}

fn targets() -> Vec<Target> {
    vec![
        Target {
            name: "claude",
            shape: Shape::Lines,
            seed: claude_seed,
            write: |root, bytes| write_file(&root.join("projects/-work/sess-1.jsonl"), bytes),
            scan: |root| {
                let mut scan = Scan::default();
                scan_claude_dir(root, &mut scan.logs);
                scan
            },
            stable_ids: true,
            order_free: true,
        },
        Target {
            name: "codex",
            shape: Shape::Lines,
            seed: codex_seed,
            write: |root, bytes| {
                write_file(
                    &root.join(format!(
                        "2026/07/15/rollout-2026-07-15T00-00-00-{CODEX_ID}.jsonl"
                    )),
                    bytes,
                )
            },
            scan: |root| {
                let mut scan = Scan::default();
                scan_codex_roots(&[root.to_path_buf()], &mut scan.logs);
                scan
            },
            stable_ids: false,
            order_free: false,
        },
        Target {
            name: "gemini-jsonl",
            shape: Shape::Lines,
            seed: gemini_lines_seed,
            write: |root, bytes| {
                write_file(
                    &root.join("tmp/proj/chats/session-2026-08-19T00-39-0ac01f74.jsonl"),
                    bytes,
                )
            },
            scan: |root| {
                let mut scan = Scan::default();
                scan_gemini_root(
                    &root.join("tmp"),
                    &mut scan.logs,
                    &HashMap::new(),
                    &mut Vec::new(),
                );
                scan
            },
            stable_ids: true,
            order_free: true,
        },
        Target {
            name: "gemini-json",
            shape: Shape::Document,
            seed: gemini_document_seed,
            write: |root, bytes| {
                write_file(&root.join("tmp/proj/chats/session-legacy.json"), bytes)
            },
            scan: |root| {
                let mut scan = Scan::default();
                scan_gemini_root(
                    &root.join("tmp"),
                    &mut scan.logs,
                    &HashMap::new(),
                    &mut Vec::new(),
                );
                scan
            },
            stable_ids: true,
            order_free: true,
        },
        Target {
            name: "grok",
            shape: Shape::Lines,
            seed: grok_seed,
            write: |root, bytes| write_file(&root.join("logs/unified.jsonl"), bytes),
            scan: |root| {
                let mut scan = Scan::default();
                scan_grok_root(root, &mut scan.logs, &HashMap::new(), &mut Vec::new());
                scan
            },
            stable_ids: true,
            order_free: true,
        },
        Target {
            name: "kimi",
            shape: Shape::Lines,
            seed: kimi_seed,
            write: |root, bytes| {
                write_file(
                    &root.join("sessions/wd_a/session_b/agents/main/wire.jsonl"),
                    bytes,
                )
            },
            scan: |root| {
                let mut scan = Scan::default();
                scan_kimi_roots_checkpointed(
                    &[root.join("sessions")],
                    &HashMap::new(),
                    &mut scan.logs,
                    &mut Vec::new(),
                    "kimi",
                    KIMI_CHECKPOINT_SOURCE_KIND,
                );
                scan
            },
            // Session-scope rows are keyed by line number by design.
            stable_ids: false,
            order_free: false,
        },
        Target {
            name: "pi",
            shape: Shape::Lines,
            seed: pi_seed,
            write: |root, bytes| write_file(&root.join("sessions/--work--/s1.jsonl"), bytes),
            scan: |root| {
                let mut scan = Scan::default();
                scan_pi_roots_checkpointed(
                    &[root.join("sessions")],
                    &HashMap::new(),
                    &mut scan.logs,
                    &mut Vec::new(),
                );
                scan
            },
            stable_ids: true,
            order_free: false,
        },
        Target {
            name: "qwen",
            shape: Shape::Lines,
            seed: qwen_seed,
            write: |root, bytes| {
                write_file(
                    &root.join("-work-demo/chats/6f1d2c3a-0000-4000-8000-000000000001.jsonl"),
                    bytes,
                )
            },
            scan: |root| {
                let mut scan = Scan::default();
                scan_qwen_root(
                    root,
                    &mut scan.logs,
                    &HashMap::new(),
                    &mut Vec::new(),
                    &mut HashSet::new(),
                );
                scan
            },
            stable_ids: true,
            order_free: true,
        },
        Target {
            name: "dsh",
            shape: Shape::Lines,
            seed: dsh_seed,
            write: |root, bytes| {
                let compressed = zstd::encode_all(bytes, 3).expect("compress dsh fixture");
                write_file(
                    &root.join("dsh-session-1/session.v3.jsonl.zstd"),
                    &compressed,
                )
            },
            scan: |root| {
                let mut scan = Scan::default();
                scan_dsh_root_checkpointed(root, &mut scan.logs, &HashMap::new(), &mut Vec::new());
                scan
            },
            stable_ids: true,
            order_free: false,
        },
        Target {
            name: "deepseekgui",
            shape: Shape::Lines,
            seed: deepseekgui_seed,
            write: |root, bytes| write_file(&root.join("threads/thr_fuzz/events.jsonl"), bytes),
            scan: |root| {
                let mut scan = Scan::default();
                scan_deepseekgui_dir(&root.join("threads"), &mut scan.logs);
                scan
            },
            stable_ids: true,
            order_free: false,
        },
        Target {
            name: "antigravity",
            shape: Shape::Lines,
            seed: antigravity_seed,
            write: |root, bytes| {
                write_file(
                    &root.join(format!(
                        "app/{ANTIGRAVITY_SESSION}/.system_generated/logs/transcript.jsonl"
                    )),
                    bytes,
                )
            },
            scan: |root| {
                let batch = scan_antigravity_roots_checkpointed(
                    &[(root.join("app"), false)],
                    &HashMap::new(),
                );
                Scan {
                    logs: batch.logs,
                    provenance: batch.provenance,
                }
            },
            stable_ids: true,
            order_free: false,
        },
        Target {
            name: "reasonix",
            shape: Shape::Document,
            seed: reasonix_seed,
            write: |root, bytes| {
                write_file(
                    &root.join(".reasonix/sessions/desktop-202610010800-1.meta.json"),
                    bytes,
                )
            },
            scan: |root| {
                let bases = vec![root.join(".reasonix")];
                let roots = reasonix_session_roots(&bases);
                let mut scan = Scan::default();
                scan_reasonix_from(&roots, &bases, &mut scan.logs);
                scan
            },
            stable_ids: true,
            order_free: true,
        },
    ]
}

// ---------------------------------------------------------------------------
// Mutations.

const EXTREME_NUMBERS: &[&str] = &[
    "-1",
    "0",
    "-9223372036854775808",
    "9223372036854775807",
    "18446744073709551615",
    "1e308",
    "-1e308",
    "1.5",
    "1e400",
    "\"12\"",
    "\"inf\"",
    "\"NaN\"",
    "\"-1e30\"",
    "null",
    "true",
    "[]",
    "{}",
];

const ODD_TIMESTAMPS: &[&str] = &[
    "\"1970-01-01T00:00:00Z\"",
    "\"2099-12-31T23:59:59Z\"",
    "\"2026-13-45T99:99:99Z\"",
    "\"not-a-time\"",
    "\"\"",
    "0",
    "-1",
    "99999999999999999999",
    "1e300",
    "\"1760000000\"",
    "\"....\"",
    "null",
];

#[derive(Debug, Clone, Copy)]
enum Mutation {
    TruncateBytes,
    DropLine,
    DuplicateLine,
    SwapLines,
    GarbageLine,
    InvalidUtf8,
    FlipByte,
    ExtremeNumber,
    OddTimestamp,
    RemoveField,
    Bom,
    Crlf,
    LongLine,
    DeepNesting,
    NulBytes,
    StripTrailingNewline,
}

const MUTATIONS: &[Mutation] = &[
    Mutation::TruncateBytes,
    Mutation::DropLine,
    Mutation::DuplicateLine,
    Mutation::SwapLines,
    Mutation::GarbageLine,
    Mutation::InvalidUtf8,
    Mutation::FlipByte,
    Mutation::ExtremeNumber,
    Mutation::ExtremeNumber,
    Mutation::OddTimestamp,
    Mutation::RemoveField,
    Mutation::Bom,
    Mutation::Crlf,
    Mutation::LongLine,
    Mutation::DeepNesting,
    Mutation::NulBytes,
    Mutation::StripTrailingNewline,
];

fn render(shape: Shape, seed: &[Value]) -> Vec<Vec<u8>> {
    match shape {
        Shape::Lines => seed
            .iter()
            .map(|value| value.to_string().into_bytes())
            .collect(),
        Shape::Document => vec![serde_json::to_vec_pretty(&seed[0]).expect("render document")],
    }
}

fn join(lines: &[Vec<u8>], newline: &[u8], trailing: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        bytes.extend_from_slice(line);
        if trailing || index + 1 < lines.len() {
            bytes.extend_from_slice(newline);
        }
    }
    bytes
}

/// Byte ranges of JSON numbers that follow a `:` (object values).
fn number_spans(line: &[u8]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut index = 0;
    while index < line.len() {
        if line[index] == b':' {
            let start = index + 1;
            let mut end = start;
            while end < line.len() && matches!(line[end], b'-' | b'0'..=b'9' | b'.' | b'e' | b'E') {
                end += 1;
            }
            if end > start {
                spans.push((start, end));
            }
            index = end.max(index + 1);
        } else {
            index += 1;
        }
    }
    spans
}

/// Byte ranges of values for timestamp-like keys.
fn timestamp_spans(line: &[u8]) -> Vec<(usize, usize)> {
    let text = String::from_utf8_lossy(line);
    let mut spans = Vec::new();
    for key in [
        "\"timestamp\":",
        "\"ts\":",
        "\"time\":",
        "\"created_at\":",
        "\"createdAt\":",
    ] {
        let mut from = 0;
        while let Some(found) = text[from..].find(key) {
            let start = from + found + key.len();
            let rest = &line[start..];
            let end = if rest.first() == Some(&b'"') {
                rest[1..]
                    .iter()
                    .position(|byte| *byte == b'"')
                    .map_or(rest.len(), |pos| pos + 2)
            } else {
                rest.iter()
                    .position(|byte| matches!(byte, b',' | b'}'))
                    .unwrap_or(rest.len())
            };
            spans.push((start, start + end));
            from = start;
        }
    }
    spans
}

fn splice(line: &mut Vec<u8>, span: (usize, usize), replacement: &[u8]) {
    line.splice(span.0..span.1, replacement.iter().copied());
}

struct Mutated {
    bytes: Vec<u8>,
    lines: Vec<Vec<u8>>,
    applied: Vec<Mutation>,
}

fn mutate(shape: Shape, seed: &[Value], rng: &mut Rng) -> Mutated {
    let mut lines = render(shape, seed);
    let mut newline: &[u8] = b"\n";
    let mut trailing = true;
    let mut bom = false;
    let mut truncate_at: Option<f64> = None;
    let mut applied = Vec::new();
    let rounds = 1 + rng.below(3);
    for _ in 0..rounds {
        let mutation = *rng.pick(MUTATIONS);
        applied.push(mutation);
        let line_index = rng.below(lines.len());
        match mutation {
            Mutation::TruncateBytes => truncate_at = Some((rng.below(1000) as f64) / 1000.0),
            Mutation::DropLine if lines.len() > 1 => {
                lines.remove(line_index);
            }
            Mutation::DuplicateLine => {
                let copy = lines[line_index].clone();
                lines.insert(line_index + rng.below(2), copy);
            }
            Mutation::SwapLines if lines.len() > 1 => {
                let other = rng.below(lines.len());
                lines.swap(line_index, other);
            }
            Mutation::GarbageLine => {
                let length = rng.below(200);
                let garbage: Vec<u8> = (0..length)
                    .map(|_| (rng.next() & 0xFF) as u8)
                    .filter(|byte| *byte != b'\n')
                    .collect();
                lines.insert(rng.below(lines.len() + 1), garbage);
            }
            Mutation::InvalidUtf8 => {
                let line = &mut lines[line_index];
                // Prefer the inside of a string so the JSON stays parseable.
                let quotes: Vec<usize> = line
                    .iter()
                    .enumerate()
                    .filter(|(_, byte)| **byte == b'"')
                    .map(|(index, _)| index)
                    .collect();
                let at = if quotes.len() >= 4 && rng.chance(80) {
                    quotes[quotes.len() - 2] + 1
                } else {
                    rng.below(line.len() + 1)
                };
                let bad: &[u8] = rng.pick(&[&b"\xFF"[..], b"\xC3", b"\xE4\xB8", b"\xED\xA0\x80"]);
                line.splice(at..at, bad.iter().copied());
            }
            Mutation::FlipByte => {
                let line = &mut lines[line_index];
                if !line.is_empty() {
                    let at = rng.below(line.len());
                    line[at] ^= 1 << rng.below(8);
                    if line[at] == b'\n' {
                        line[at] = b' ';
                    }
                }
            }
            Mutation::ExtremeNumber => {
                let spans = number_spans(&lines[line_index]);
                if !spans.is_empty() {
                    let span = *rng.pick(&spans);
                    let value = rng.pick(EXTREME_NUMBERS).as_bytes().to_vec();
                    splice(&mut lines[line_index], span, &value);
                }
            }
            Mutation::OddTimestamp => {
                let spans = timestamp_spans(&lines[line_index]);
                if !spans.is_empty() {
                    let span = *rng.pick(&spans);
                    let value = rng.pick(ODD_TIMESTAMPS).as_bytes().to_vec();
                    splice(&mut lines[line_index], span, &value);
                }
            }
            Mutation::RemoveField => {
                if let Ok(mut value) = serde_json::from_slice::<Value>(&lines[line_index]) {
                    remove_random_field(&mut value, rng);
                    lines[line_index] = match shape {
                        Shape::Lines => value.to_string().into_bytes(),
                        Shape::Document => serde_json::to_vec_pretty(&value).unwrap(),
                    };
                }
            }
            Mutation::Bom => bom = true,
            Mutation::Crlf => newline = b"\r\n",
            Mutation::LongLine => {
                let length = 1024 + rng.below(512 * 1024);
                let mut line = br#"{"type":"noise","pad":""#.to_vec();
                line.extend(std::iter::repeat_n(b'x', length));
                line.extend_from_slice(br#""}"#);
                lines.insert(rng.below(lines.len() + 1), line);
            }
            Mutation::DeepNesting => {
                let depth = 200 + rng.below(5000);
                let mut line = vec![b'['; depth];
                line.extend(std::iter::repeat_n(b']', depth));
                lines.insert(rng.below(lines.len() + 1), line);
            }
            Mutation::NulBytes => {
                let line = &mut lines[line_index];
                let at = rng.below(line.len() + 1);
                line.splice(at..at, [0u8, 0, 0]);
            }
            Mutation::StripTrailingNewline => trailing = false,
            Mutation::DropLine | Mutation::SwapLines => {}
        }
    }
    let mut bytes = join(&lines, newline, trailing);
    if bom {
        bytes.splice(0..0, *b"\xEF\xBB\xBF");
    }
    if let Some(fraction) = truncate_at {
        let at = ((bytes.len() as f64) * fraction) as usize;
        bytes.truncate(at.max(1));
    }
    Mutated {
        bytes,
        lines,
        applied,
    }
}

fn remove_random_field(value: &mut Value, rng: &mut Rng) {
    let mut current = value;
    for _ in 0..4 {
        let Some(object) = current.as_object_mut() else {
            return;
        };
        if object.is_empty() {
            return;
        }
        let key = object.keys().nth(rng.below(object.len())).cloned().unwrap();
        let descend = object.get(&key).is_some_and(Value::is_object) && rng.chance(60);
        if !descend {
            object.remove(&key);
            return;
        }
        current = object.get_mut(&key).unwrap();
    }
}

// ---------------------------------------------------------------------------
// Running one case.

const CASE_TIME_LIMIT: Duration = Duration::from_secs(20);

fn scan_dir(target: &Target, dir: &Path) -> Result<(Scan, Duration), String> {
    let started = Instant::now();
    let scan = catch_unwind(AssertUnwindSafe(|| (target.scan)(dir)))
        .map_err(|panic| format!("parser panicked: {}", panic_message(&panic)))?;
    Ok((scan, started.elapsed()))
}

fn panic_message(panic: &Box<dyn std::any::Any + Send>) -> String {
    panic
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| panic.downcast_ref::<&str>().map(|text| text.to_string()))
        .unwrap_or_else(|| "non-string panic".to_string())
}

/// Parses and persists `bytes` into a fresh ledger, then rescans it. Returns
/// the stored totals after the first pass.
fn ledger_after(target: &Target, bytes: &[u8]) -> Result<Totals, String> {
    let db_dir = TempDir::new("db");
    let db = db_dir.0.join("ledger.db");
    crate::db::init_test_db(&db).map_err(|error| error.to_string())?;

    let source = TempDir::new(target.name);
    (target.write)(&source.0, bytes);
    let (scan, elapsed) = scan_dir(target, &source.0)?;
    if elapsed > CASE_TIME_LIMIT {
        return Err(format!("parse took {elapsed:?}"));
    }
    catch_unwind(AssertUnwindSafe(|| persist(&db, scan)))
        .map_err(|panic| format!("persist panicked: {}", panic_message(&panic)))?
        .map_err(|error| format!("persist failed: {error}"))?;
    let first = totals(&db).map_err(|error| format!("SUM over ledger failed: {error}"))?;
    let insane = insane_rows(&db)?;
    if insane > 0 {
        return Err(format!(
            "{insane} persisted rows hold out-of-range counters"
        ));
    }

    let (rescan, _) = scan_dir(target, &source.0)?;
    let inserted = catch_unwind(AssertUnwindSafe(|| persist(&db, rescan)))
        .map_err(|panic| format!("rescan persist panicked: {}", panic_message(&panic)))?
        .map_err(|error| format!("rescan persist failed: {error}"))?;
    let second = totals(&db)?;
    if inserted != 0 || second != first {
        return Err(format!(
            "rescan of unchanged content changed the ledger: inserted {inserted}, {first:?} -> {second:?}"
        ));
    }
    Ok(first)
}

fn check_case(target: &Target, mutated: &Mutated) -> Result<(), String> {
    let base = ledger_after(target, &mutated.bytes)?;
    // Without the id field (removed, replaced by a non-id value, or its key
    // name damaged by a stray byte) records fall back to positional keys by
    // design, so repeats are not detectable.
    let ids_intact = !mutated.applied.iter().any(|mutation| {
        matches!(
            mutation,
            Mutation::RemoveField
                | Mutation::ExtremeNumber
                | Mutation::FlipByte
                | Mutation::InvalidUtf8
                | Mutation::NulBytes
        )
    });
    if !target.stable_ids || !ids_intact {
        return Ok(());
    }
    // Every line repeated next to itself, as a resumed or re-flushed log does.
    let doubled: Vec<Vec<u8>> = mutated
        .lines
        .iter()
        .flat_map(|line| [line.clone(), line.clone()])
        .collect();
    if target.shape == Shape::Lines {
        let doubled = ledger_after(target, &join(&doubled, b"\n", true))?;
        let single = ledger_after(target, &join(&mutated.lines, b"\n", true))?;
        if doubled != single {
            return Err(format!(
                "adjacent duplicate records were counted again: {single:?} -> {doubled:?}"
            ));
        }
    }
    let _ = base;
    Ok(())
}

fn run_target(target: &Target, cases: usize, seed: u64) -> Vec<String> {
    let seed_value = (target.seed)();
    // The unmutated seed must produce usage, otherwise the target fuzzes nothing.
    let clean = join(&render(target.shape, &seed_value), b"\n", true);
    match ledger_after(target, &clean) {
        Ok(totals) if totals.rows > 0 => {}
        Ok(totals) => {
            return vec![format!(
                "{}: seed produced no rows ({totals:?})",
                target.name
            )]
        }
        Err(error) => return vec![format!("{}: seed failed: {error}", target.name)],
    }

    let mut failures = Vec::new();
    for case in 0..cases {
        let mut rng = case_rng(seed, case, target.name);
        let mutated = mutate(target.shape, &seed_value, &mut rng);
        if let Err(error) = check_case(target, &mutated) {
            failures.push(format!(
                "{} case {case} (TOKENLEDGER_FUZZ_SEED={seed}) mutations {:?}: {error}",
                target.name, mutated.applied
            ));
            if failures.len() >= 5 {
                break;
            }
        }
    }
    failures
}

fn splitmix(value: u64) -> u64 {
    let mut z = value.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn case_rng(seed: u64, case: usize, target: &str) -> Rng {
    Rng::new(splitmix(splitmix(seed ^ fxhash(target)) ^ case as u64))
}

fn fxhash(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ byte as u64).wrapping_mul(0x100_0000_01B3)
    })
}

#[test]
fn mutated_logs_never_panic_hang_or_double_count() {
    let seed = base_seed();
    let cases = iterations();
    let failures: Vec<String> = targets()
        .iter()
        .flat_map(|target| run_target(target, cases, seed))
        .collect();
    assert!(
        failures.is_empty(),
        "fuzz failures:\n{}",
        failures.join("\n")
    );
}

#[test]
fn reordered_records_keep_their_totals() {
    let mut rng = Rng::new(base_seed());
    for target in targets()
        .iter()
        .filter(|target| target.order_free && target.shape == Shape::Lines)
    {
        let mut lines = render(target.shape, &(target.seed)());
        let expected = ledger_after(target, &join(&lines, b"\n", true)).unwrap();
        for _ in 0..6 {
            // Keep a leading header in place; shuffle everything after it.
            for index in (2..lines.len()).rev() {
                let other = 1 + rng.below(index);
                lines.swap(index, other);
            }
            let shuffled = ledger_after(target, &join(&lines, b"\n", true)).unwrap();
            assert_eq!(shuffled, expected, "{}: order changed totals", target.name);
        }
    }
}

#[test]
fn whole_file_copies_count_once_for_id_keyed_sources() {
    for target in targets()
        .iter()
        .filter(|target| target.stable_ids && target.shape == Shape::Lines)
    {
        let lines = render(target.shape, &(target.seed)());
        let once = ledger_after(target, &join(&lines, b"\n", true)).unwrap();
        let mut twice = lines.clone();
        twice.extend(lines.iter().skip(1).cloned());
        let twice = ledger_after(target, &join(&twice, b"\n", true)).unwrap();
        assert_eq!(
            twice, once,
            "{}: replayed history was counted again",
            target.name
        );
    }
}

/// A line far beyond the cap must be skipped without being buffered, and the
/// records after it must still be read.
#[test]
fn oversized_lines_are_skipped_with_bounded_memory() {
    let oversize = super::jsonl::MAX_JSONL_LINE_BYTES + 8 * 1024 * 1024;
    for target in targets()
        .iter()
        .filter(|target| target.shape == Shape::Lines && target.name != "dsh")
    {
        let lines = render(target.shape, &(target.seed)());
        let expected = ledger_after(target, &join(&lines, b"\n", true)).unwrap();

        let mut bytes = join(&lines[..1], b"\n", true);
        bytes.extend_from_slice(br#"{"type":"assistant","pad":""#);
        bytes.extend(std::iter::repeat_n(b'x', oversize));
        bytes.extend_from_slice(b"\"}\n");
        bytes.extend(join(&lines[1..], b"\n", true));

        let dir = TempDir::new(target.name);
        (target.write)(&dir.0, &bytes);
        drop(bytes);
        let (scan, peak) = peak_allocation(|| (target.scan)(&dir.0));
        assert!(
            peak < super::jsonl::MAX_JSONL_LINE_BYTES + 16 * 1024 * 1024,
            "{}: parsing a {oversize}-byte line peaked at {peak} bytes",
            target.name
        );
        let db_dir = TempDir::new("db");
        let db = db_dir.0.join("ledger.db");
        crate::db::init_test_db(&db).unwrap();
        persist(&db, scan).unwrap();
        let got = totals(&db).unwrap();
        // Positional keys (line numbers) may differ; token totals may not.
        assert_eq!(
            (got.input, got.output, got.cached),
            (expected.input, expected.output, expected.cached),
            "{}: records around an oversized line were lost",
            target.name
        );
    }
}

/// Large files of noise must stream: memory stays flat in the file size and
/// the scan finishes promptly.
#[test]
fn large_noise_files_stream_in_bounded_memory() {
    let noise = br#"{"type":"noise","msg":"tool.output","payload":{"text":"lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua"}}"#;
    let line_count = 120_000;
    for target in targets()
        .iter()
        .filter(|target| target.shape == Shape::Lines)
    {
        let lines = render(target.shape, &(target.seed)());
        let mut bytes = join(&lines, b"\n", true);
        for _ in 0..line_count {
            bytes.extend_from_slice(noise);
            bytes.push(b'\n');
        }
        let size = bytes.len();
        let dir = TempDir::new(target.name);
        (target.write)(&dir.0, &bytes);
        drop(bytes);
        let started = Instant::now();
        let (scan, peak) = peak_allocation(|| (target.scan)(&dir.0));
        let elapsed = started.elapsed();
        assert!(
            !scan.logs.is_empty(),
            "{}: usage before the noise was lost",
            target.name
        );
        assert!(
            peak < 8 * 1024 * 1024,
            "{}: a {size}-byte file peaked at {peak} bytes",
            target.name
        );
        assert!(
            elapsed < Duration::from_secs(60),
            "{}: took {elapsed:?}",
            target.name
        );
    }
}

/// Raw corruption of the compressed DSH stream (truncation, bit flips, a
/// different container) must fail closed without panicking.
#[test]
fn corrupt_dsh_streams_fail_closed() {
    let dsh = targets()
        .into_iter()
        .find(|target| target.name == "dsh")
        .unwrap();
    let plain = join(&render(Shape::Lines, &dsh_seed()), b"\n", true);
    let compressed = zstd::encode_all(&plain[..], 3).unwrap();
    let mut rng = Rng::new(base_seed());
    for case in 0..iterations().max(16) {
        let mut bytes = compressed.clone();
        match case % 3 {
            0 => bytes.truncate(rng.below(bytes.len())),
            1 => {
                let at = rng.below(bytes.len());
                bytes[at] ^= 1 << rng.below(8);
            }
            _ => bytes = plain.clone(),
        }
        let dir = TempDir::new("dsh_raw");
        write_file(&dir.0.join("dsh-session-1/session.v3.jsonl.zstd"), &bytes);
        let result = catch_unwind(AssertUnwindSafe(|| (dsh.scan)(&dir.0)));
        assert!(result.is_ok(), "dsh case {case} panicked");
    }
}

/// The cumulative-snapshot engine (sources that report session totals) must
/// store exactly the observed growth: regressions re-baseline instead of
/// subtracting, repeats add nothing, and extreme values never overflow.
#[test]
fn cumulative_snapshots_store_only_observed_growth() {
    let mut rng = Rng::new(base_seed() ^ 0xC0FFEE);
    for case in 0..iterations().max(16) {
        let dir = TempDir::new("cumulative");
        let db = dir.0.join("ledger.db");
        crate::db::init_test_db(&db).unwrap();
        let mut conn = crate::db::get_connection(&db).unwrap();

        let mut expected = (0i64, 0i64, 0i64);
        let mut baseline: Option<(i64, i64, i64)> = None;
        let mut current = (rng.below(1000) as i64, rng.below(100) as i64, 0i64);
        for _ in 0..(2 + rng.below(12)) {
            match rng.below(6) {
                0 => {} // unchanged repeat
                1 => {
                    // reset (source DB cleared or session id reused)
                    current = (rng.below(50) as i64, rng.below(5) as i64, 0);
                }
                _ => {
                    current.0 += rng.below(5000) as i64;
                    current.1 += rng.below(500) as i64;
                    current.2 += rng.below(3000) as i64;
                }
            }
            let snapshot = LogRecord {
                tool: "deepseek".to_string(),
                model: "deepseek-v4-pro".to_string(),
                input_tokens: current.0,
                output_tokens: current.1,
                cached_tokens: current.2,
                cache_write_tokens: 0,
                timestamp: "2026-10-01 08:00:00".to_string(),
                session_id: "s".to_string(),
                unique_key: "fuzz_cumulative_session".to_string(),
                cost_usd: None,
                cumulative: true,
            };
            let tx = conn.transaction().unwrap();
            insert_cumulative_delta(&tx, &snapshot, "machine").unwrap();
            tx.commit().unwrap();

            match baseline {
                None => {
                    expected = current;
                }
                Some(previous)
                    if current.0 < previous.0
                        || current.1 < previous.1
                        || current.2 < previous.2 => {}
                Some(previous) => {
                    expected.0 += current.0 - previous.0;
                    expected.1 += current.1 - previous.1;
                    expected.2 += current.2 - previous.2;
                }
            }
            baseline = Some(current);
        }
        let stored = totals(&db).unwrap();
        assert_eq!(
            (stored.input, stored.output, stored.cached),
            expected,
            "cumulative case {case} (TOKENLEDGER_FUZZ_SEED={})",
            base_seed()
        );
    }
}

#[test]
fn extreme_cumulative_snapshots_do_not_overflow() {
    let dir = TempDir::new("cumulative_extreme");
    let db = dir.0.join("ledger.db");
    crate::db::init_test_db(&db).unwrap();
    let snapshot = |input: i64, cost: Option<f64>| LogRecord {
        tool: "reasonix".to_string(),
        model: "m".to_string(),
        input_tokens: input,
        output_tokens: input,
        cached_tokens: input,
        cache_write_tokens: input,
        timestamp: "2026-10-01 08:00:00".to_string(),
        session_id: "s".to_string(),
        unique_key: "fuzz_extreme".to_string(),
        cost_usd: cost,
        cumulative: true,
    };
    for (input, cost) in [
        (i64::MIN, Some(f64::NAN)),
        (i64::MAX, Some(f64::INFINITY)),
        (-5, Some(-1.0)),
        (1_000, Some(0.5)),
        (i64::MAX, None),
        (2_000, Some(f64::MAX)),
    ] {
        let logs = vec![snapshot(input, cost)];
        let result = catch_unwind(AssertUnwindSafe(|| {
            super::runner::persist_scan_batch(&db, logs, Vec::new(), Vec::new(), None)
        }));
        assert!(result.is_ok(), "persisting {input} panicked");
        result.unwrap().unwrap();
    }
    assert_eq!(insane_rows(&db).unwrap(), 0);
    totals(&db).unwrap();
}

/// SQLite-backed sources read another app's database: odd column types,
/// extreme integers and corrupt files must neither panic nor reach the ledger
/// as out-of-range counters.
#[test]
fn hostile_sqlite_sources_stay_bounded() {
    let mut rng = Rng::new(base_seed() ^ 0x5A17);
    let values: &[&str] = &[
        "0",
        "-1",
        "9223372036854775807",
        "-9223372036854775808",
        "1e308",
        "'12'",
        "'abc'",
        "NULL",
        "x'FF00'",
        "4.5",
        "1700000000000",
    ];
    for case in 0..iterations().max(16) {
        let dir = TempDir::new("zcode");
        let source = dir.0.join("zcode.db");
        {
            let conn = rusqlite::Connection::open(&source).unwrap();
            conn.execute_batch(
                "CREATE TABLE model_usage (id, session_id, model_id, started_at, input_tokens,
                    output_tokens, reasoning_tokens, cache_creation_input_tokens,
                    cache_read_input_tokens)",
            )
            .unwrap();
            for row in 0..8 {
                let cells: Vec<&str> = (0..6).map(|_| *rng.pick(values)).collect();
                conn.execute_batch(&format!(
                    "INSERT INTO model_usage VALUES ('r{row}', 's', 'glm-4.6', {}, {}, {}, {}, {}, {})",
                    if rng.chance(70) { "1760000000000" } else { cells[0] },
                    cells[1],
                    cells[2],
                    cells[3],
                    cells[4],
                    cells[5],
                ))
                .unwrap();
            }
        }
        if case % 4 == 3 {
            // Corrupt the file below the header.
            let mut bytes = fs::read(&source).unwrap();
            let keep = 100 + rng.below(bytes.len().saturating_sub(100).max(1));
            bytes.truncate(keep);
            for _ in 0..16 {
                let at = rng.below(bytes.len());
                bytes[at] = (rng.next() & 0xFF) as u8;
            }
            fs::write(&source, bytes).unwrap();
        }
        let mut logs = Vec::new();
        let scanned = catch_unwind(AssertUnwindSafe(|| {
            super::other_tools::scan_zcode_db(&source, &mut logs)
        }));
        assert!(scanned.is_ok(), "zcode case {case} panicked");
        let db = dir.0.join("ledger.db");
        crate::db::init_test_db(&db).unwrap();
        persist(
            &db,
            Scan {
                logs,
                provenance: HashMap::new(),
            },
        )
        .unwrap();
        assert_eq!(insane_rows(&db).unwrap(), 0, "zcode case {case}");
        totals(&db).unwrap();
    }
}

/// Replays one reported failure with its mutated input printed:
/// `TOKENLEDGER_FUZZ_SEED=<seed> TOKENLEDGER_FUZZ_REPLAY=<target>:<case>
/// cargo test --lib replay_reported_case -- --nocapture`. No-op otherwise.
#[test]
fn replay_reported_case() {
    let Ok(replay) = std::env::var("TOKENLEDGER_FUZZ_REPLAY") else {
        return;
    };
    let (name, case) = replay.split_once(':').expect("<target>:<case>");
    let case: usize = case.parse().expect("numeric case");
    let target = targets()
        .into_iter()
        .find(|target| target.name == name)
        .expect("known target");
    let mut rng = case_rng(base_seed(), case, target.name);
    let mutated = mutate(target.shape, &(target.seed)(), &mut rng);
    eprintln!("mutations {:?}", mutated.applied);
    for line in &mutated.lines {
        eprintln!("{}", String::from_utf8_lossy(line));
    }
    check_case(&target, &mutated).unwrap();
}
