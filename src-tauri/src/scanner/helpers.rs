use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use serde_json::Value;
use std::path::PathBuf;

/// Helper to get the home directory on Windows and macOS.
pub fn get_home_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Users\\default"))
    } else {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/home/default"))
    }
}

/// `$XDG_DATA_HOME`, else `~/.local/share`. Relative values are ignored, as
/// the XDG base-directory spec requires. Tools built on xdg-basedir (opencode,
/// kilo) use this on every platform; Linux desktop apps use it for app data.
pub fn xdg_data_home() -> PathBuf {
    xdg_dir("XDG_DATA_HOME").unwrap_or_else(|| get_home_dir().join(".local/share"))
}

/// `$XDG_CONFIG_HOME`, else `~/.config`, with the same relative-path rule.
/// Electron apps keep their `userData` here on Linux.
pub fn xdg_config_home() -> PathBuf {
    xdg_dir("XDG_CONFIG_HOME").unwrap_or_else(|| get_home_dir().join(".config"))
}

fn xdg_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

/// The SQLite database of an opencode-style CLI (`opencode`, `kilo`):
/// `<data home>/<tool>/<tool>.db`.
pub fn opencode_like_db_path(tool_name: &str) -> PathBuf {
    xdg_data_home()
        .join(tool_name)
        .join(format!("{tool_name}.db"))
}

/// Parses a timestamp into "YYYY-MM-DD HH:MM:SS" local time.
///
/// `None` means the value cannot be parsed. Callers skip the row instead of
/// substituting the current wall-clock time: corrupt or unknown-format rows
/// stamped "now" land in today's totals and corrupt daily usage, budget
/// alerts and anomaly detection, and a key built from "now" changes on every
/// scan so the same record is re-inserted each time.
pub(crate) fn parse_timestamp(ts_val: &Value) -> Option<String> {
    match ts_val {
        Value::Number(num) => {
            if let Some(val) = num.as_f64() {
                // If it looks like milliseconds, scale down to seconds
                let secs = if val > 1e11 { val / 1000.0 } else { val };
                if let Some(dt) = Local.timestamp_opt(secs as i64, 0).single() {
                    return Some(dt.format("%Y-%m-%d %H:%M:%S").to_string());
                }
            }
            None
        }
        Value::String(s) => {
            let s = s.trim();
            // Check if string is representing a numeric epoch (milliseconds or seconds)
            if s.chars().all(|c| c.is_ascii_digit() || c == '.') {
                if let Ok(val) = s.parse::<f64>() {
                    let secs = if val > 1e11 { val / 1000.0 } else { val };
                    if let Some(dt) = Local.timestamp_opt(secs as i64, 0).single() {
                        return Some(dt.format("%Y-%m-%d %H:%M:%S").to_string());
                    }
                }
            }

            // ISO 8601 or similar formats
            // Try parsing with timezone offset first (e.g. 2026-04-13T10:30:26.211Z -> RFC 3339)
            if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
                let local_dt: DateTime<Local> = dt.with_timezone(&Local);
                return Some(local_dt.format("%Y-%m-%d %H:%M:%S").to_string());
            }

            // Try parsing as ISO format without offset or custom format.
            // A trailing `Z` marks UTC; with a space instead of `T` the value
            // is not RFC 3339, so it gets here unparsed. Reading it as local
            // time would shift every row by the zone offset and can move it
            // into the wrong day bucket. No suffix keeps the legacy local
            // reading.
            let s_t = s.replace('T', " ");
            let (s_without_suffix, is_utc) = match s_t.strip_suffix('Z') {
                Some(rest) => (rest, true),
                None => (s_t.as_str(), false),
            };
            let s_no_frac = s_without_suffix
                .split('.')
                .next()
                .unwrap_or(s_without_suffix);

            // Try naive datetime parse
            if let Ok(dt) = NaiveDateTime::parse_from_str(s_no_frac, "%Y-%m-%d %H:%M:%S") {
                if is_utc {
                    return Some(
                        dt.and_utc()
                            .with_timezone(&Local)
                            .format("%Y-%m-%d %H:%M:%S")
                            .to_string(),
                    );
                }
                return Some(dt.format("%Y-%m-%d %H:%M:%S").to_string());
            }

            None
        }
        _ => None,
    }
}

/// Normalizes a raw model identifier by trimming whitespace and stripping provider or proxy
/// prefixes (e.g., "minimax-cn-anthropic/MiniMax-M3" -> "MiniMax-M3",
/// "BC_CLAUD/deepseek-v4-flash" -> "deepseek-v4-flash", "models/gemini-1.5-pro" -> "gemini-1.5-pro").
pub fn clean_model_name(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    trimmed
        .rsplit('/')
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

pub(crate) fn to_int(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_f64().map(|f| f as i64))
        .or_else(|| {
            v.as_str()
                .and_then(|s| s.parse::<f64>().ok().map(|f| f as i64))
        })
        .unwrap_or(0)
}

pub(crate) fn to_float(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_i64().map(|i| i as f64))
        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
}

pub(crate) fn nested_get<'a>(val: &'a Value, path: &[&str]) -> &'a Value {
    let mut cur = val;
    for key in path {
        if let Some(next) = cur.get(key) {
            cur = next;
        } else {
            return &Value::Null;
        }
    }
    cur
}

pub(crate) fn sqlite_value_to_string(val: rusqlite::types::Value) -> Option<String> {
    match val {
        rusqlite::types::Value::Null => None,
        rusqlite::types::Value::Integer(i) => Some(i.to_string()),
        rusqlite::types::Value::Real(f) => Some(f.to_string()),
        rusqlite::types::Value::Text(s) => Some(s),
        rusqlite::types::Value::Blob(b) => Some(String::from_utf8_lossy(&b).to_string()),
    }
}
