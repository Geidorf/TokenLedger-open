//! Local, on-demand session metadata. Deliberately separate from Stats v2,
//! cloud sync and persistent scanner records.
mod aggregate;
mod claude;
mod codex;
mod handle;
mod reader;
mod resolver;
mod types;

use crate::app_paths::AppContext;
use reader::Budget;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
pub use types::Analysis;

type ActiveRequest = (String, Arc<AtomicBool>);
static REQUESTS: OnceLock<Mutex<HashMap<String, ActiveRequest>>> = OnceLock::new();
fn registry() -> &'static Mutex<HashMap<String, ActiveRequest>> {
    REQUESTS.get_or_init(Default::default)
}
fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn roots_in(tool: &str, home: &std::path::Path) -> Vec<PathBuf> {
    match tool {
        "claude" => crate::scanner::claude::discover_claude_log_roots(),
        "codex" => crate::scanner::codex::discover_codex_log_roots_in(home),
        _ => Vec::new(),
    }
}

fn roots(tool: &str) -> Vec<PathBuf> {
    roots_in(tool, &crate::scanner::helpers::get_home_dir())
}

#[tauri::command]
pub async fn get_local_session_analysis(
    state: tauri::State<'_, Arc<AppContext>>,
    window: tauri::WebviewWindow,
    record_id: i64,
    request_id: String,
) -> Result<Analysis, String> {
    if !valid_request_id(&request_id) || record_id <= 0 {
        return Ok(Analysis::unavailable(record_id, "invalid_request"));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let label = window.label().to_owned();
    {
        let mut active = registry().lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, previous)) =
            active.insert(label.clone(), (request_id.clone(), cancel.clone()))
        {
            previous.store(true, Ordering::Release);
        }
    }
    let app = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut budget = Budget::new(cancel);
        let record = match resolver::record(&crate::db::get_db_path(&app), record_id) {
            Ok(record) => record,
            Err(reason) => return Analysis::unavailable(record_id, reason),
        };
        // Reject unsupported sources before discovering any external roots.
        if !matches!(record.tool.as_str(), "claude" | "codex") {
            return Analysis::unavailable(record_id, "unsupported_source");
        }
        let result = budget
            .check()
            .and_then(|_| resolver::analyze(&record, &roots(&record.tool), &mut budget));
        result.unwrap_or_else(|reason| {
            let mut result = Analysis::unavailable(record.id, reason);
            result.session_id = record.session_id;
            result.tool = record.tool;
            result
        })
    })
    .await;
    let mut active = registry().lock().unwrap_or_else(|e| e.into_inner());
    if active.get(&label).is_some_and(|(id, _)| *id == request_id) {
        active.remove(&label);
    }
    // Never return a panic/debug string containing a local path or content.
    Ok(result.unwrap_or_else(|_| Analysis::unavailable(record_id, "source_unreadable")))
}

#[tauri::command]
pub fn cancel_local_session_analysis(window: tauri::WebviewWindow, request_id: String) -> bool {
    let active = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some((id, cancel)) = active
        .get(window.label())
        .filter(|(id, _)| *id == request_id)
    {
        let _ = id;
        cancel.store(true, Ordering::Release);
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests;
