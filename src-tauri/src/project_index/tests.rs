//! Project-index tests (T10.155 spec §7). All fixtures are synthetic and live
//! in per-test temporary directories; no test reads a real tool log.

mod git_probe_tests;
mod label_tests;
mod pass_tests;
mod source_tests;
mod static_guard_tests;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Canary strings placed in content, titles, branches and remotes of the
/// fixtures. None may ever appear in stored rows, statuses or errors.
pub(super) const CANARIES: &[&str] = &[
    "CANARY_PROMPT_TEXT",
    "CANARY_REPLY_TEXT",
    "CANARY_SESSION_TITLE",
    "CANARY_GIT_BRANCH",
    "CANARY_GIT_REMOTE",
    "CANARY_SYSTEM_PROMPT",
];

/// A unique scratch directory removed on drop.
pub(super) struct Scratch(PathBuf);

impl Scratch {
    pub(super) fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_project_index_{tag}_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create scratch dir");
        Self(path)
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }

    pub(super) fn join(&self, relative: impl AsRef<Path>) -> PathBuf {
        self.0.join(relative)
    }

    /// Raw string form, as a tool would record it.
    pub(super) fn raw(&self, relative: &str) -> String {
        self.join(relative).to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn write_file(path: &Path, content: impl AsRef<[u8]>) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create fixture parent");
    }
    fs::write(path, content).expect("write fixture");
}

pub(super) fn jsonl(values: &[serde_json::Value]) -> String {
    values
        .iter()
        .map(|value| format!("{value}\n"))
        .collect::<String>()
}

pub(super) fn assert_no_canary(text: &str) {
    for canary in CANARIES {
        assert!(!text.contains(canary), "canary {canary} leaked");
    }
}
