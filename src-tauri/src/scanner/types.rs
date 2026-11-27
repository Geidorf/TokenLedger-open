#[derive(Debug, Clone)]
pub struct LogRecord {
    pub tool: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub cache_write_tokens: i64,
    pub timestamp: String,
    pub session_id: String,
    pub unique_key: String,
    pub cost_usd: Option<f64>,
    pub cumulative: bool,
}

/// User settings that change where a scan looks.
#[derive(Debug, Clone)]
pub struct ScanOptions {
    /// Extra Codex homes or session directories from settings.
    pub codex_extra_dirs: Vec<String>,
    pub disabled_tools: std::collections::BTreeSet<String>,
    pub known_tools: std::collections::BTreeSet<String>,
    pub auto_enable_new_agents: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            codex_extra_dirs: Vec::new(),
            disabled_tools: std::collections::BTreeSet::new(),
            known_tools: std::collections::BTreeSet::new(),
            auto_enable_new_agents: true,
        }
    }
}

impl ScanOptions {
    pub fn from_settings(settings: &crate::settings::AppSettings) -> Self {
        Self {
            codex_extra_dirs: settings.codex_extra_dirs.clone(),
            disabled_tools: settings
                .disabled_scan_tools
                .iter()
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect(),
            known_tools: settings
                .known_scan_tools
                .iter()
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect(),
            auto_enable_new_agents: settings.scan_auto_enable_new_agents,
        }
    }

    pub fn is_tool_enabled(&self, tool: &str) -> bool {
        let normalized = tool.trim().to_ascii_lowercase();
        if self.disabled_tools.contains(&normalized) {
            return false;
        }
        if !self.auto_enable_new_agents
            && !self.known_tools.is_empty()
            && !self.known_tools.contains(&normalized)
        {
            return false;
        }
        true
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedScanAgent {
    pub id: String,
    pub label: String,
    pub detected: bool,
}

#[derive(Debug, Default, Clone)]
pub struct ScanOutcome {
    pub inserted: usize,
    pub discovered_models: Vec<String>,
    pub codex_rebuild_deferred: bool,
    pub codex_rebuild_failed_files: usize,
}

#[derive(Debug, Clone)]
pub struct CoordinatedScanOutcome {
    pub outcome: ScanOutcome,
    pub joined_existing: bool,
}

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CheckpointScanStats {
    pub(crate) parsed_files: usize,
    pub(crate) parsed_records: usize,
    pub(crate) skipped_files: usize,
    pub(crate) failed_files: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AntigravityUsageProvenance {
    Reported,
    Estimated,
}

impl AntigravityUsageProvenance {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Reported => "reported",
            Self::Estimated => "estimated",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AntigravityRecordProvenance {
    pub(crate) usage: AntigravityUsageProvenance,
    pub(crate) cache_write_known: bool,
}

#[derive(Default)]
pub(crate) struct AntigravityScanBatch {
    pub(crate) logs: Vec<LogRecord>,
    pub(crate) provenance: std::collections::HashMap<String, AntigravityRecordProvenance>,
    pub(crate) checkpoints: Vec<crate::db::ScanCheckpoint>,
}
