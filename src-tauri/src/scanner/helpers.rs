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

/// Normalizes timestamp to "YYYY-MM-DD HH:MM:SS" local time.
pub fn normalize_timestamp(ts_val: &Value) -> String {
    parse_timestamp(ts_val).unwrap_or_else(|| Local::now().format("%Y-%m-%d %H:%M:%S").to_string())
}

/// Same parse as [`normalize_timestamp`] without the wall-clock fallback.
/// Use it wherever the timestamp feeds a unique key: a key built from "now"
/// changes on every scan and re-inserts the same record each time.
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

            // Try parsing as ISO format without offset or custom format
            let s_cleaned = s.replace('T', " ").replace('Z', "");
            let s_no_frac = s_cleaned.split('.').next().unwrap_or(&s_cleaned);

            // Try naive datetime parse
            if let Ok(dt) = NaiveDateTime::parse_from_str(s_no_frac, "%Y-%m-%d %H:%M:%S") {
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
