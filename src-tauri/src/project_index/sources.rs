//! Per-source working-directory lookup (T10.155 spec §2.2).
//!
//! For each source family this reads only the header or metadata field the
//! capability table names, from the same tool data stores the scanners read:
//! a JSONL header line, a metadata sidecar, or one column of the tool's own
//! SQLite database. Prompt and response content is never read into memory:
//! JSON values outside the whitelist are skipped by [`probe_lines`] /
//! [`probe_document`], and
//! SQLite `data` blobs are only inspected through `json_extract` inside SQLite.
//!
//! A lookup returns the raw working directory for the caller to reduce to a
//! project name immediately; indexes built here live only for one pass.

use super::json_probe::{probe_document, probe_lines, read_small_text, Flow, ProbeError};
use super::label::Resolution;
use rusqlite::{types::ValueRef, Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;
use walkdir::WalkDir;

const CLAUDE_MAX_VALUES: usize = 64;
const CLAUDE_MAX_BYTES: u64 = 256 * 1024;
const CODEX_MAX_BYTES: u64 = 1024 * 1024;
const HEADER_MAX_BYTES: u64 = 256 * 1024;
const WORKBUDDY_MAX_VALUES: usize = 64;
const METADATA_MAX_BYTES: u64 = 1024 * 1024;
const METADATA_MAX_VALUES: usize = 16;
/// Old single-document Gemini sessions may put `sessionId` after the
/// messages; those are skipped unparsed, so a larger budget stays cheap.
const GEMINI_JSON_MAX_BYTES: u64 = 16 * 1024 * 1024;
const KIMI_INDEX_MAX_BYTES: u64 = 8 * 1024 * 1024;
const KIMI_INDEX_MAX_VALUES: usize = 200_000;
const SMALL_FILE_MAX_BYTES: u64 = 4 * 1024;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
/// Upper bound on directory entries visited while building one family index.
const WALK_ENTRY_LIMIT: usize = 400_000;

/// Source family, decided by the `unique_key` prefix (spec §2.1): the `tool`
/// column is ambiguous (MiniMax rows may be `opencode`; two Hermes stores).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum SourceFamily {
    Claude,
    Codex,
    OpenCode,
    Kilo,
    MiniMax,
    WorkBuddyProject,
    Qclaw,
    Hermes,
    Reasonix,
    DeepSeekGui,
    Dsh,
    Grok,
    Gemini,
    Zcode,
    Kimi,
    KimiDesktop,
    Pi,
    Antigravity,
    MarvisTencent,
    Trae,
    WorkBuddyAgent,
    Unknown,
}

impl SourceFamily {
    /// Longest prefixes first where one prefix extends another.
    const PREFIXES: [(&'static str, SourceFamily); 21] = [
        ("claude_", Self::Claude),
        ("codex_", Self::Codex),
        ("opencode_", Self::OpenCode),
        ("kilo_", Self::Kilo),
        ("antigravity_", Self::Antigravity),
        ("marvis_tencent_", Self::MarvisTencent),
        ("mavis_", Self::MiniMax),
        ("workbuddy_project_", Self::WorkBuddyProject),
        ("workbuddy_", Self::WorkBuddyAgent),
        ("qclaw_jsonl_", Self::Qclaw),
        ("hermes_", Self::Hermes),
        ("reasonix_", Self::Reasonix),
        ("trae_", Self::Trae),
        ("deepseekgui_", Self::DeepSeekGui),
        ("dsh_", Self::Dsh),
        ("grok_", Self::Grok),
        ("gemini_cli_", Self::Gemini),
        ("zcode_", Self::Zcode),
        ("kimidesktop_", Self::KimiDesktop),
        ("kimi_", Self::Kimi),
        ("pi_", Self::Pi),
    ];

    pub(crate) fn from_unique_key(unique_key: &str) -> Self {
        Self::PREFIXES
            .iter()
            .find(|(prefix, _)| unique_key.starts_with(prefix))
            .map(|(_, family)| *family)
            .unwrap_or(Self::Unknown)
    }

    /// Inverse of [`SourceFamily::as_str`], for rows stored in the index.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        Self::PREFIXES
            .iter()
            .map(|(_, family)| *family)
            .chain(std::iter::once(Self::Unknown))
            .find(|family| family.as_str() == value)
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::Kilo => "kilo",
            Self::MiniMax => "minimax",
            Self::WorkBuddyProject => "workbuddy_project",
            Self::Qclaw => "qclaw",
            Self::Hermes => "hermes",
            Self::Reasonix => "reasonix",
            Self::DeepSeekGui => "deepseekgui",
            Self::Dsh => "dsh",
            Self::Grok => "grok",
            Self::Gemini => "gemini",
            Self::Zcode => "zcode",
            Self::Kimi => "kimi",
            Self::KimiDesktop => "kimidesktop",
            Self::Pi => "pi",
            Self::Antigravity => "antigravity",
            Self::MarvisTencent => "marvis_tencent",
            Self::Trae => "trae",
            Self::WorkBuddyAgent => "workbuddy_agent",
            Self::Unknown => "unknown",
        }
    }

    /// Families whose logs record no working directory (spec §2.2 “无”).
    pub(crate) fn is_supported(self) -> bool {
        !matches!(
            self,
            Self::Antigravity
                | Self::MarvisTencent
                | Self::Trae
                | Self::WorkBuddyAgent
                | Self::Unknown
        )
    }
}

/// The raw working-directory facts of one session. Lives only until the
/// caller has derived the project name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Workdir {
    pub(crate) cwd: String,
    pub(crate) repo_root: Option<String>,
    pub(crate) default_workspace: bool,
}

impl Workdir {
    fn cwd(cwd: String) -> Self {
        Self {
            cwd,
            repo_root: None,
            default_workspace: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Lookup {
    Found(Workdir),
    Unresolved(Resolution),
}

type HeaderHit = Result<Workdir, Resolution>;

/// Where each source keeps its data. Production mirrors the scanners'
/// discovery exactly (same helpers where they exist); tests point it at
/// fixture trees.
#[derive(Clone, Debug, Default)]
pub(crate) struct SourceRoots {
    pub(crate) claude_roots: Vec<PathBuf>,
    pub(crate) codex_roots: Vec<PathBuf>,
    pub(crate) opencode_db: PathBuf,
    pub(crate) kilo_db: PathBuf,
    /// `(path, is_runtime_v2)` in the scanner's order.
    pub(crate) minimax_dbs: Vec<(PathBuf, bool)>,
    pub(crate) workbuddy_projects: PathBuf,
    pub(crate) qclaw_agents: PathBuf,
    pub(crate) qclaw_hermes_responses: PathBuf,
    pub(crate) hermes_state_db: PathBuf,
    pub(crate) reasonix_session_roots: Vec<PathBuf>,
    pub(crate) deepseekgui_threads: PathBuf,
    pub(crate) dsh_sessions: PathBuf,
    pub(crate) grok_sessions: PathBuf,
    pub(crate) gemini_tmp: PathBuf,
    pub(crate) zcode_db: PathBuf,
    pub(crate) kimi_session_roots: Vec<PathBuf>,
    pub(crate) kimidesktop_session_roots: Vec<PathBuf>,
    pub(crate) pi_roots: Vec<PathBuf>,
}

impl SourceRoots {
    pub(crate) fn detect() -> Self {
        use crate::scanner;
        let home = scanner::helpers::get_home_dir();
        Self {
            claude_roots: scanner::claude::discover_claude_log_roots(),
            codex_roots: scanner::codex::discover_codex_log_roots_in(&home),
            // Same literals as the opencode/kilo calls in `scanner::runner`.
            opencode_db: home.join(".local/share/opencode/opencode.db"),
            kilo_db: home.join(".local/share/kilo/kilo.db"),
            minimax_dbs: scanner::minimax::minimax_database_sources(&home)
                .into_iter()
                .map(|source| {
                    let v2 = source.kind == scanner::minimax::MinimaxDatabaseKind::RuntimeV2;
                    (source.path, v2)
                })
                .collect(),
            workbuddy_projects: home.join(".workbuddy/projects"),
            qclaw_agents: home.join(".qclaw/agents"),
            qclaw_hermes_responses: home.join(".qclaw-hermes/response_store.db"),
            hermes_state_db: scanner::other_tools::hermes_state_db_path(&home),
            reasonix_session_roots: scanner::reasonix::reasonix_session_roots(
                &scanner::reasonix::reasonix_data_bases(),
            ),
            deepseekgui_threads: scanner::other_tools::deepseekgui_threads_dir(),
            dsh_sessions: scanner::dsh::dsh_sessions_root(&home),
            grok_sessions: scanner::grok::grok_home(&home).join("sessions"),
            gemini_tmp: scanner::gemini::gemini_chats_root(&scanner::gemini::gemini_home_dir()),
            zcode_db: scanner::other_tools::zcode_db_path(&home),
            kimi_session_roots: scanner::kimi::kimi_wire_candidates(&home),
            kimidesktop_session_roots: scanner::kimi::kimi_desktop_wire_candidates(),
            pi_roots: scanner::pi::pi_session_roots(&home),
        }
    }

    /// Every source at its default location below `home` (tests).
    #[cfg(test)]
    pub(crate) fn under(home: &Path) -> Self {
        Self {
            claude_roots: vec![home.join(".claude/projects")],
            codex_roots: vec![home.join(".codex/sessions")],
            opencode_db: home.join(".local/share/opencode/opencode.db"),
            kilo_db: home.join(".local/share/kilo/kilo.db"),
            minimax_dbs: vec![
                (home.join(".minimax/v2/sqlite/runtime-state.sqlite"), true),
                (home.join(".minimax/sqlite.db"), false),
            ],
            workbuddy_projects: home.join(".workbuddy/projects"),
            qclaw_agents: home.join(".qclaw/agents"),
            qclaw_hermes_responses: home.join(".qclaw-hermes/response_store.db"),
            hermes_state_db: home.join("hermes/state.db"),
            reasonix_session_roots: vec![home.join(".reasonix/sessions")]
                .into_iter()
                .chain(
                    fs::read_dir(home.join(".reasonix/projects"))
                        .into_iter()
                        .flatten()
                        .flatten()
                        .map(|entry| entry.path().join("sessions")),
                )
                .collect(),
            deepseekgui_threads: home.join(".deepseekgui/kun/threads"),
            dsh_sessions: home.join(".dsh/sessions"),
            grok_sessions: home.join(".grok/sessions"),
            gemini_tmp: home.join(".gemini/tmp"),
            zcode_db: home.join(".zcode/cli/db/db.sqlite"),
            kimi_session_roots: vec![home.join(".kimi-code/sessions")],
            kimidesktop_session_roots: vec![home.join("kimi-desktop/home/sessions")],
            pi_roots: vec![home.join(".pi/agent/sessions")],
        }
    }
}

/// Per-pass lookup state: lazily built indexes and open source databases.
pub(crate) struct SourceContext<'a> {
    roots: &'a SourceRoots,
    cancelled: &'a dyn Fn() -> bool,
    claude: Option<HashMap<String, Vec<PathBuf>>>,
    codex: Option<HashMap<String, Vec<PathBuf>>>,
    qclaw: Option<HashMap<String, Vec<PathBuf>>>,
    pi: Option<HashMap<String, HeaderHit>>,
    dsh: Option<HashMap<String, HeaderHit>>,
    workbuddy: Option<HashMap<String, HeaderHit>>,
    grok: Option<HashMap<String, HeaderHit>>,
    gemini: Option<HashMap<String, PathBuf>>,
    gemini_roots: HashMap<PathBuf, HeaderHit>,
    deepseek: Option<HashMap<String, HeaderHit>>,
    reasonix: Option<ReasonixIndex>,
    kimi: Option<KimiIndex>,
    kimidesktop: Option<KimiIndex>,
    databases: HashMap<PathBuf, Option<Connection>>,
}

impl<'a> SourceContext<'a> {
    pub(crate) fn new(roots: &'a SourceRoots, cancelled: &'a dyn Fn() -> bool) -> Self {
        Self {
            roots,
            cancelled,
            claude: None,
            codex: None,
            qclaw: None,
            pi: None,
            dsh: None,
            workbuddy: None,
            grok: None,
            gemini: None,
            gemini_roots: HashMap::new(),
            deepseek: None,
            reasonix: None,
            kimi: None,
            kimidesktop: None,
            databases: HashMap::new(),
        }
    }

    pub(crate) fn lookup(&mut self, family: SourceFamily, session_id: &str) -> Lookup {
        if !family.is_supported() {
            return Lookup::Unresolved(Resolution::UnsupportedSource);
        }
        let result = match family {
            SourceFamily::Claude => self.lookup_claude(session_id),
            SourceFamily::Codex => self.lookup_codex(session_id),
            SourceFamily::OpenCode => {
                let path = self.roots.opencode_db.clone();
                self.lookup_opencode(&path, session_id)
            }
            SourceFamily::Kilo => {
                let path = self.roots.kilo_db.clone();
                self.lookup_opencode(&path, session_id)
            }
            SourceFamily::MiniMax => self.lookup_minimax(session_id),
            SourceFamily::WorkBuddyProject => self.lookup_workbuddy(session_id),
            SourceFamily::Qclaw => self.lookup_qclaw(session_id),
            SourceFamily::Hermes => self.lookup_hermes(session_id),
            SourceFamily::Reasonix => self.lookup_reasonix(session_id),
            SourceFamily::DeepSeekGui => self.lookup_deepseek(session_id),
            SourceFamily::Dsh => self.lookup_dsh(session_id),
            SourceFamily::Grok => self.lookup_grok(session_id),
            SourceFamily::Gemini => self.lookup_gemini(session_id),
            SourceFamily::Zcode => self.lookup_zcode(session_id),
            SourceFamily::Kimi => self.lookup_kimi(session_id, false),
            SourceFamily::KimiDesktop => self.lookup_kimi(session_id, true),
            SourceFamily::Pi => self.lookup_pi(session_id),
            SourceFamily::Antigravity
            | SourceFamily::MarvisTencent
            | SourceFamily::Trae
            | SourceFamily::WorkBuddyAgent
            | SourceFamily::Unknown => Err(Resolution::UnsupportedSource),
        };
        match result {
            Ok(workdir) => Lookup::Found(workdir),
            Err(resolution) => Lookup::Unresolved(resolution),
        }
    }

    // -- file indexes -------------------------------------------------------

    fn walk_files(&self, roots: &[PathBuf], max_depth: usize, mut accept: impl FnMut(&Path)) {
        let mut visited = 0usize;
        for root in roots {
            if !root.is_dir() {
                continue;
            }
            for entry in WalkDir::new(root)
                .follow_links(false)
                .max_depth(max_depth)
                .into_iter()
                .filter_map(Result::ok)
            {
                visited += 1;
                if visited > WALK_ENTRY_LIMIT || (visited.is_multiple_of(512) && (self.cancelled)())
                {
                    return;
                }
                if entry.file_type().is_file() {
                    // `accept` may read the file's header: check before each
                    // one so a disable stops reading promptly.
                    if (self.cancelled)() {
                        return;
                    }
                    accept(entry.path());
                }
            }
        }
    }

    fn lookup_claude(&mut self, session_id: &str) -> HeaderHit {
        if self.claude.is_none() {
            let mut index: HashMap<String, Vec<PathBuf>> = HashMap::new();
            self.walk_files(&self.roots.claude_roots, usize::MAX, |path| {
                if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
                    if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
                        index
                            .entry(stem.to_string())
                            .or_default()
                            .push(path.to_path_buf());
                    }
                }
            });
            index.values_mut().for_each(|paths| paths.sort());
            self.claude = Some(index);
        }
        let candidates = self
            .claude
            .as_ref()
            .and_then(|index| index.get(session_id))
            .cloned()
            .ok_or(Resolution::SourceMissing)?;
        first_success(candidates.iter().map(|path| {
            read_line_string(path, &["cwd"], CLAUDE_MAX_VALUES, CLAUDE_MAX_BYTES).map(Workdir::cwd)
        }))
    }

    fn lookup_codex(&mut self, session_id: &str) -> HeaderHit {
        if self.codex.is_none() {
            let mut index: HashMap<String, Vec<PathBuf>> = HashMap::new();
            self.walk_files(&self.roots.codex_roots, usize::MAX, |path| {
                if crate::scanner::codex::is_codex_rollout(path) {
                    if let Some(thread) = crate::scanner::codex::codex_thread_id_from_path(path) {
                        index.entry(thread).or_default().push(path.to_path_buf());
                    }
                }
            });
            index.values_mut().for_each(|paths| paths.sort());
            self.codex = Some(index);
        }
        // v2 rows key by the thread UUID; legacy rows by the rollout stem,
        // which ends with the same UUID.
        let thread = codex_thread_key(session_id).ok_or(Resolution::SourceMissing)?;
        let candidates = self
            .codex
            .as_ref()
            .and_then(|index| index.get(&thread))
            .cloned()
            .ok_or(Resolution::SourceMissing)?;
        first_success(candidates.iter().map(|path| {
            // Only the first line: the root `session_meta`. Parent metadata
            // replayed later in fork/sub-agent files is ignored, as in the
            // scanner.
            let mut out: Option<(Option<String>, Option<String>)> = None;
            let file = open_source(path)?;
            let result = probe_lines(
                BufReader::new(file),
                &[&["type"], &["payload", "cwd"]],
                1,
                CODEX_MAX_BYTES,
                |fields| {
                    out = Some((fields[0].clone(), fields[1].clone()));
                    Flow::Stop
                },
            );
            match out {
                Some((Some(kind), Some(cwd))) if kind == "session_meta" => Ok(Workdir::cwd(cwd)),
                _ => Err(probe_failure(result)),
            }
        }))
    }

    fn lookup_qclaw(&mut self, session_id: &str) -> HeaderHit {
        if self.qclaw.is_none() {
            let mut index: HashMap<String, Vec<PathBuf>> = HashMap::new();
            let roots = [self.roots.qclaw_agents.clone()];
            self.walk_files(&roots, usize::MAX, |path| {
                if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
                    if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
                        index
                            .entry(stem.to_string())
                            .or_default()
                            .push(path.to_path_buf());
                    }
                }
            });
            index.values_mut().for_each(|paths| paths.sort());
            self.qclaw = Some(index);
        }
        let candidates = self
            .qclaw
            .as_ref()
            .and_then(|index| index.get(session_id))
            .cloned()
            .ok_or(Resolution::SourceMissing)?;
        first_success(candidates.iter().map(|path| {
            let header = read_session_header(open_source(path)?)?;
            header.cwd.map(Workdir::cwd).ok_or(Resolution::FieldMissing)
        }))
    }

    fn lookup_pi(&mut self, session_id: &str) -> HeaderHit {
        if self.pi.is_none() {
            let mut index: HashMap<String, HeaderHit> = HashMap::new();
            let roots = self.roots.pi_roots.clone();
            self.walk_files(&roots, 8, |path| {
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    return;
                }
                let Ok(file) = File::open(path) else {
                    return;
                };
                // Session identity is the header `id`; the file stem is only
                // the scanner's fallback when the header has none.
                match read_session_header(file) {
                    Ok(header) if header.is_session => {
                        let key = header
                            .id
                            .clone()
                            .filter(|id| !id.is_empty())
                            .or_else(|| stem_of(path));
                        if let Some(key) = key {
                            let hit = header.cwd.map(Workdir::cwd).ok_or(Resolution::FieldMissing);
                            insert_hit(&mut index, key, hit);
                        }
                    }
                    _ => {}
                }
            });
            self.pi = Some(index);
        }
        lookup_hit(self.pi.as_ref(), session_id)
    }

    fn lookup_dsh(&mut self, session_id: &str) -> HeaderHit {
        if self.dsh.is_none() {
            // Same selection as the scanner: highest log generation per dir.
            let mut selected: HashMap<PathBuf, (u32, PathBuf)> = HashMap::new();
            let roots = [self.roots.dsh_sessions.clone()];
            self.walk_files(&roots, 4, |path| {
                let Some(generation) = path
                    .file_name()
                    .and_then(crate::scanner::dsh::dsh_session_log_generation)
                else {
                    return;
                };
                let directory = path.parent().map(Path::to_path_buf).unwrap_or_default();
                match selected.get(&directory) {
                    Some((kept, _)) if *kept >= generation => {}
                    _ => {
                        selected.insert(directory, (generation, path.to_path_buf()));
                    }
                }
            });
            let mut index: HashMap<String, HeaderHit> = HashMap::new();
            let mut files: Vec<(PathBuf, PathBuf)> = selected
                .into_iter()
                .map(|(dir, (_, file))| (dir, file))
                .collect();
            files.sort();
            for (directory, file) in files {
                if (self.cancelled)() {
                    break;
                }
                let header = File::open(&file)
                    .map_err(|_| Resolution::SourceUnreadable)
                    .and_then(|file| {
                        zstd::stream::read::Decoder::new(file)
                            .map_err(|_| Resolution::SourceUnreadable)
                    })
                    .and_then(read_session_header);
                let hit = match &header {
                    Ok(header) if header.is_session => header
                        .cwd
                        .clone()
                        .map(Workdir::cwd)
                        .ok_or(Resolution::FieldMissing),
                    Ok(_) => Err(Resolution::FieldMissing),
                    Err(resolution) => Err(*resolution),
                };
                if let Ok(header) = &header {
                    if let Some(id) = header.id.clone().filter(|id| !id.is_empty()) {
                        insert_hit(&mut index, id, hit.clone());
                    }
                }
                if let Some(name) = directory.file_name().and_then(|name| name.to_str()) {
                    insert_hit(&mut index, name.to_string(), hit);
                }
            }
            self.dsh = Some(index);
        }
        lookup_hit(self.dsh.as_ref(), session_id)
    }

    fn lookup_workbuddy(&mut self, session_id: &str) -> HeaderHit {
        if self.workbuddy.is_none() {
            let mut index: HashMap<String, HeaderHit> = HashMap::new();
            let roots = [self.roots.workbuddy_projects.clone()];
            self.walk_files(&roots, usize::MAX, |path| {
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    return;
                }
                let Ok(file) = File::open(path) else {
                    return;
                };
                let mut first_session: Option<String> = None;
                let mut first_cwd: Option<String> = None;
                let result = probe_lines(
                    BufReader::new(file),
                    &[&["sessionId"], &["cwd"]],
                    WORKBUDDY_MAX_VALUES,
                    HEADER_MAX_BYTES,
                    |fields| {
                        if first_session.is_none() {
                            first_session = fields[0].clone().filter(|id| !id.is_empty());
                        }
                        if first_cwd.is_none() {
                            first_cwd = fields[1].clone();
                        }
                        if first_session.is_some() && first_cwd.is_some() {
                            Flow::Stop
                        } else {
                            Flow::Continue
                        }
                    },
                );
                let hit = first_cwd
                    .map(Workdir::cwd)
                    .ok_or_else(|| probe_failure(result));
                if let Some(id) = first_session {
                    insert_hit(&mut index, id, hit.clone());
                }
                if let Some(stem) = stem_of(path) {
                    insert_hit(&mut index, stem, hit);
                }
            });
            self.workbuddy = Some(index);
        }
        lookup_hit(self.workbuddy.as_ref(), session_id)
    }

    fn lookup_grok(&mut self, session_id: &str) -> HeaderHit {
        if self.grok.is_none() {
            let mut index: HashMap<String, HeaderHit> = HashMap::new();
            let roots = [self.roots.grok_sessions.clone()];
            self.walk_files(&roots, 3, |path| {
                if path.file_name().and_then(|value| value.to_str()) != Some("summary.json") {
                    return;
                }
                let Ok(file) = File::open(path) else {
                    return;
                };
                let (fields, result) = probe_document(
                    BufReader::new(file),
                    &[
                        &["id"],
                        &["info", "id"],
                        &["info", "cwd"],
                        &["git_root_dir"],
                    ],
                    METADATA_MAX_BYTES,
                );
                let Some(id) = fields[0]
                    .clone()
                    .or_else(|| fields[1].clone())
                    .filter(|id| !id.is_empty())
                else {
                    return;
                };
                // `git_root_dir` is the repository root; `info.cwd` the
                // session directory, falling back to the root when absent.
                let hit = match fields[2].clone().or_else(|| fields[3].clone()) {
                    Some(cwd) => Ok(Workdir {
                        cwd,
                        repo_root: fields[3].clone(),
                        default_workspace: false,
                    }),
                    None => Err(probe_failure(result)),
                };
                insert_hit(&mut index, id, hit);
            });
            self.grok = Some(index);
        }
        lookup_hit(self.grok.as_ref(), session_id)
    }

    fn lookup_gemini(&mut self, session_id: &str) -> HeaderHit {
        if self.gemini.is_none() {
            // Same file selection as the scanner: `.json`/`.jsonl` below a
            // `chats` component of `<tmp>/<project>/…`.
            let tmp = self.roots.gemini_tmp.clone();
            let mut index: HashMap<String, PathBuf> = HashMap::new();
            self.walk_files(std::slice::from_ref(&tmp), 8, |path| {
                let Ok(relative) = path.strip_prefix(&tmp) else {
                    return;
                };
                let in_chats = relative
                    .components()
                    .any(|component| component.as_os_str() == "chats");
                let extension = path.extension().and_then(|value| value.to_str());
                if !in_chats || !matches!(extension, Some("json") | Some("jsonl")) {
                    return;
                }
                let Some(project) = relative.components().next() else {
                    return;
                };
                let project_dir = tmp.join(project.as_os_str());
                let session =
                    gemini_session_id(path, extension == Some("jsonl")).or_else(|| stem_of(path));
                if let Some(session) = session {
                    index.entry(session).or_insert(project_dir);
                }
            });
            self.gemini = Some(index);
        }
        let project_dir = self
            .gemini
            .as_ref()
            .and_then(|index| index.get(session_id))
            .cloned()
            .ok_or(Resolution::SourceMissing)?;
        if let Some(hit) = self.gemini_roots.get(&project_dir) {
            return hit.clone();
        }
        // The project root is recorded by Gemini CLI in a marker file; the
        // session header's `projectHash` is not used (spec §2.2).
        let hit = match read_small_text(&project_dir.join(".project_root"), SMALL_FILE_MAX_BYTES) {
            Ok(text) => {
                // Only the first line is the path; anything after it is
                // ignored (review P3-2).
                let value = text
                    .trim_start()
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if value.is_empty() {
                    Err(Resolution::FieldMissing)
                } else {
                    Ok(Workdir::cwd(value))
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(Resolution::FieldMissing)
            }
            Err(_) => Err(Resolution::SourceUnreadable),
        };
        self.gemini_roots.insert(project_dir, hit.clone());
        hit
    }

    fn lookup_deepseek(&mut self, session_id: &str) -> HeaderHit {
        // The thread directory is normally named after the thread id.
        if is_plain_component(session_id) {
            let direct = self
                .roots
                .deepseekgui_threads
                .join(session_id)
                .join("metadata.jsonl");
            if direct.is_file() {
                return read_deepseek_metadata(&direct).1;
            }
        }
        if self.deepseek.is_none() {
            let mut index: HashMap<String, HeaderHit> = HashMap::new();
            if let Ok(entries) = fs::read_dir(&self.roots.deepseekgui_threads) {
                for entry in entries.flatten() {
                    if (self.cancelled)() {
                        break;
                    }
                    let metadata = entry.path().join("metadata.jsonl");
                    if !metadata.is_file() {
                        continue;
                    }
                    let (thread_id, hit) = read_deepseek_metadata(&metadata);
                    if let Some(thread_id) = thread_id {
                        insert_hit(&mut index, thread_id, hit.clone());
                    }
                    if let Some(name) = entry.file_name().to_str() {
                        insert_hit(&mut index, name.to_string(), hit);
                    }
                }
            }
            self.deepseek = Some(index);
        }
        lookup_hit(self.deepseek.as_ref(), session_id)
    }

    fn lookup_reasonix(&mut self, session_id: &str) -> HeaderHit {
        if self.reasonix.is_none() {
            self.reasonix = Some(ReasonixIndex::build(
                &self.roots.reasonix_session_roots,
                self.cancelled,
            ));
        }
        self.reasonix
            .as_ref()
            .map(|index| index.lookup(session_id))
            .unwrap_or(Err(Resolution::SourceMissing))
    }

    fn lookup_kimi(&mut self, session_id: &str, desktop: bool) -> HeaderHit {
        let slot = if desktop {
            &mut self.kimidesktop
        } else {
            &mut self.kimi
        };
        if slot.is_none() {
            let roots = if desktop {
                &self.roots.kimidesktop_session_roots
            } else {
                &self.roots.kimi_session_roots
            };
            *slot = Some(KimiIndex::build(roots, self.cancelled));
        }
        slot.as_ref()
            .map(|index| index.lookup(session_id))
            .unwrap_or(Err(Resolution::SourceMissing))
    }

    // -- SQLite sources -------------------------------------------------------

    /// Read-only, WAL-aware connection to a tool database; `None` when the
    /// database does not exist.
    fn database(&mut self, path: &Path) -> Result<Option<&Connection>, Resolution> {
        if !self.databases.contains_key(path) {
            let connection = if path.is_file() {
                let conn = Connection::open_with_flags(
                    path,
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )
                .map_err(|_| Resolution::SourceUnreadable)?;
                conn.busy_timeout(SQLITE_BUSY_TIMEOUT)
                    .map_err(|_| Resolution::SourceUnreadable)?;
                Some(conn)
            } else {
                None
            };
            self.databases.insert(path.to_path_buf(), connection);
        }
        Ok(self.databases.get(path).and_then(Option::as_ref))
    }

    fn lookup_opencode(&mut self, db_path: &Path, session_id: &str) -> HeaderHit {
        let conn = self.database(db_path)?.ok_or(Resolution::SourceMissing)?;
        // First assistant message that records `path.cwd`; its `path.root`
        // is the repository root for git projects and `/` for global ones
        // (the root form is ignored by the rules). `data` never leaves SQLite.
        let mut message_seen = false;
        if table_has_columns(conn, "message", &["id", "session_id", "data"])? {
            let order = if table_has_columns(conn, "message", &["time_created"])? {
                "time_created, id"
            } else {
                "id"
            };
            let sql = format!(
                "SELECT cwd, root FROM (
                     SELECT
                         CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END AS role,
                         CASE WHEN json_valid(data) THEN json_extract(data, '$.path.cwd') END AS cwd,
                         CASE WHEN json_valid(data) THEN json_extract(data, '$.path.root') END AS root,
                         {order}
                     FROM message
                     WHERE session_id = ?1
                 )
                 WHERE role = 'assistant' AND typeof(cwd) = 'text'
                 ORDER BY {order}
                 LIMIT 1"
            );
            let row = conn
                .query_row(&sql, [session_id], |row| {
                    Ok((text_lossy(row.get_ref(0)?), text_lossy(row.get_ref(1)?)))
                })
                .optional()
                .map_err(|_| Resolution::SourceUnreadable)?;
            if let Some((Some(cwd), root)) = row {
                return Ok(Workdir {
                    cwd,
                    repo_root: root,
                    default_workspace: false,
                });
            }
            message_seen = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM message WHERE session_id = ?1)",
                    [session_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|_| Resolution::SourceUnreadable)?;
        }
        if table_has_columns(conn, "session", &["id", "directory"])? {
            let directory = conn
                .query_row(
                    "SELECT directory FROM session WHERE id = ?1",
                    [session_id],
                    |row| Ok(text_lossy(row.get_ref(0)?)),
                )
                .optional()
                .map_err(|_| Resolution::SourceUnreadable)?;
            match directory {
                Some(Some(directory)) if !directory.trim().is_empty() => {
                    return Ok(Workdir::cwd(directory))
                }
                Some(_) => return Err(Resolution::FieldMissing),
                None => {}
            }
        }
        Err(if message_seen {
            Resolution::FieldMissing
        } else {
            Resolution::SourceMissing
        })
    }

    fn lookup_minimax(&mut self, session_id: &str) -> HeaderHit {
        let sources = self.roots.minimax_dbs.clone();
        let mut outcome = Err(Resolution::SourceMissing);
        for (path, runtime_v2) in sources {
            let Some(conn) = self.database(&path)? else {
                continue;
            };
            let found = if runtime_v2 {
                minimax_v2_workdir(conn, session_id)?
            } else {
                minimax_legacy_workdir(conn, session_id)?
            };
            match found {
                Some(Ok(workdir)) => return Ok(workdir),
                Some(Err(resolution)) => outcome = Err(resolution),
                None => {}
            }
        }
        outcome
    }

    fn lookup_zcode(&mut self, session_id: &str) -> HeaderHit {
        let path = self.roots.zcode_db.clone();
        let conn = self.database(&path)?.ok_or(Resolution::SourceMissing)?;
        let column = if table_has_columns(conn, "session", &["id", "directory"])? {
            "directory"
        } else if table_has_columns(conn, "session", &["id", "path"])? {
            "path"
        } else {
            return Err(Resolution::FieldMissing);
        };
        let sql = format!("SELECT {column} FROM session WHERE id = ?1");
        match conn
            .query_row(&sql, [session_id], |row| Ok(text_lossy(row.get_ref(0)?)))
            .optional()
            .map_err(|_| Resolution::SourceUnreadable)?
        {
            Some(Some(directory)) if !directory.trim().is_empty() => Ok(Workdir::cwd(directory)),
            Some(_) => Err(Resolution::FieldMissing),
            None => Err(Resolution::SourceMissing),
        }
    }

    fn lookup_hermes(&mut self, session_id: &str) -> HeaderHit {
        let state_path = self.roots.hermes_state_db.clone();
        if let Some(conn) = self.database(&state_path)? {
            if table_has_columns(conn, "sessions", &["id", "cwd"])? {
                let repo_expr = if table_has_columns(conn, "sessions", &["git_repo_root"])? {
                    "git_repo_root"
                } else {
                    "NULL"
                };
                let sql = format!("SELECT cwd, {repo_expr} FROM sessions WHERE id = ?1");
                let row = conn
                    .query_row(&sql, [session_id], |row| {
                        Ok((text_lossy(row.get_ref(0)?), text_lossy(row.get_ref(1)?)))
                    })
                    .optional()
                    .map_err(|_| Resolution::SourceUnreadable)?;
                match row {
                    Some((Some(cwd), repo_root)) if !cwd.trim().is_empty() => {
                        return Ok(Workdir {
                            cwd,
                            repo_root,
                            default_workspace: false,
                        })
                    }
                    // No `cwd` but a repository root: the root is where the
                    // session ran (spec §2.2 “git_repo_root，缺失时取 cwd”).
                    Some((_, Some(root))) if !root.trim().is_empty() => {
                        return Ok(Workdir {
                            cwd: root.clone(),
                            repo_root: Some(root),
                            default_workspace: false,
                        })
                    }
                    Some(_) => return Err(Resolution::FieldMissing),
                    None => {}
                }
            }
        }
        // Qclaw's Hermes response store shares the `hermes_` prefix but keys
        // sessions by response id and records no directory.
        let responses_path = self.roots.qclaw_hermes_responses.clone();
        if let Some(conn) = self.database(&responses_path)? {
            if table_has_columns(conn, "responses", &["response_id"])? {
                let known = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM responses WHERE response_id = ?1)",
                        [session_id],
                        |row| row.get::<_, bool>(0),
                    )
                    .map_err(|_| Resolution::SourceUnreadable)?;
                if known {
                    return Err(Resolution::UnsupportedSource);
                }
            }
        }
        Err(Resolution::SourceMissing)
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn open_source(path: &Path) -> Result<File, Resolution> {
    File::open(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => Resolution::SourceMissing,
        _ => Resolution::SourceUnreadable,
    })
}

fn probe_failure(result: Result<(), ProbeError>) -> Resolution {
    match result {
        Err(ProbeError::BudgetExceeded) => Resolution::BudgetExceeded,
        Err(ProbeError::Io) => Resolution::SourceUnreadable,
        Ok(()) | Err(ProbeError::Malformed) => Resolution::FieldMissing,
    }
}

/// First `Ok` wins; otherwise the most informative failure.
fn first_success(attempts: impl Iterator<Item = HeaderHit>) -> HeaderHit {
    let mut failure = Resolution::SourceMissing;
    for attempt in attempts {
        match attempt {
            Ok(workdir) => return Ok(workdir),
            Err(resolution) => failure = more_informative(failure, resolution),
        }
    }
    Err(failure)
}

fn more_informative(current: Resolution, next: Resolution) -> Resolution {
    let rank = |resolution: Resolution| match resolution {
        Resolution::SourceMissing => 0,
        Resolution::FieldMissing => 1,
        Resolution::BudgetExceeded => 2,
        Resolution::SourceUnreadable => 3,
        _ => 4,
    };
    if rank(next) > rank(current) {
        next
    } else {
        current
    }
}

fn insert_hit(index: &mut HashMap<String, HeaderHit>, key: String, hit: HeaderHit) {
    match index.get(&key) {
        Some(Ok(_)) => {}
        _ => {
            index.insert(key, hit);
        }
    }
}

fn lookup_hit(index: Option<&HashMap<String, HeaderHit>>, session_id: &str) -> HeaderHit {
    index
        .and_then(|index| index.get(session_id))
        .cloned()
        .unwrap_or(Err(Resolution::SourceMissing))
}

fn stem_of(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// A single, ordinary path component (used before joining ledger-derived ids
/// onto a source directory, so an id can never escape it).
fn is_plain_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value != "."
        && value != ".."
        && !value.contains(['/', '\\', ':', '\0'])
}

/// The first string at `key_path` within the first `max_lines` lines of a
/// JSONL file.
fn read_line_string(
    path: &Path,
    key_path: &[&str],
    max_lines: usize,
    max_bytes: u64,
) -> Result<String, Resolution> {
    let file = open_source(path)?;
    let mut found: Option<String> = None;
    let result = probe_lines(
        BufReader::new(file),
        &[key_path],
        max_lines,
        max_bytes,
        |fields| {
            if let Some(value) = fields[0].clone() {
                found = Some(value);
                Flow::Stop
            } else {
                Flow::Continue
            }
        },
    );
    found.ok_or_else(|| probe_failure(result))
}

/// The string at `key_path` of a single JSON document.
fn read_document_string(
    path: &Path,
    key_path: &[&str],
    max_bytes: u64,
) -> Result<String, Resolution> {
    let file = open_source(path)?;
    let (mut fields, result) = probe_document(BufReader::new(file), &[key_path], max_bytes);
    fields.pop().flatten().ok_or_else(|| probe_failure(result))
}

struct SessionHeader {
    is_session: bool,
    id: Option<String>,
    cwd: Option<String>,
}

/// Pi-style session header (Pi, Qclaw JSONL, DSH): the first JSON value is
/// `{"type":"session","id":…,"cwd":…}`.
fn read_session_header(reader: impl Read) -> Result<SessionHeader, Resolution> {
    let mut header: Option<SessionHeader> = None;
    let result = probe_lines(
        BufReader::new(reader),
        &[&["type"], &["id"], &["cwd"]],
        1,
        HEADER_MAX_BYTES,
        |fields| {
            header = Some(SessionHeader {
                is_session: fields[0].as_deref() == Some("session"),
                id: fields[1].clone(),
                cwd: fields[2].clone(),
            });
            Flow::Stop
        },
    );
    header.ok_or_else(|| probe_failure(result))
}

fn gemini_session_id(path: &Path, jsonl: bool) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut session: Option<String> = None;
    if jsonl {
        // The scanner takes `sessionId` from the first line carrying `kind`.
        let _ = probe_lines(
            BufReader::new(file),
            &[&["kind"], &["sessionId"]],
            METADATA_MAX_VALUES,
            HEADER_MAX_BYTES,
            |fields| {
                if fields[0].is_some() {
                    session = fields[1].clone().filter(|id| !id.is_empty());
                    Flow::Stop
                } else {
                    Flow::Continue
                }
            },
        );
    } else {
        // Old single-document layout: `sessionId` may follow the messages,
        // which are skipped without being kept.
        let (mut fields, _) = probe_document(
            BufReader::new(file),
            &[&["sessionId"]],
            GEMINI_JSON_MAX_BYTES,
        );
        session = fields.pop().flatten().filter(|id| !id.is_empty());
    }
    session
}

fn read_deepseek_metadata(path: &Path) -> (Option<String>, HeaderHit) {
    let file = match open_source(path) {
        Ok(file) => file,
        Err(resolution) => return (None, Err(resolution)),
    };
    let mut thread_id: Option<String> = None;
    let mut workspace: Option<String> = None;
    let result = probe_lines(
        BufReader::new(file),
        &[&["thread", "id"], &["thread", "workspace"]],
        METADATA_MAX_VALUES,
        METADATA_MAX_BYTES,
        |fields| {
            if thread_id.is_none() {
                thread_id = fields[0].clone().filter(|id| !id.is_empty());
            }
            if workspace.is_none() {
                workspace = fields[1].clone();
            }
            if workspace.is_some() {
                Flow::Stop
            } else {
                Flow::Continue
            }
        },
    );
    let hit = workspace
        .map(Workdir::cwd)
        .ok_or_else(|| probe_failure(result));
    (thread_id, hit)
}

/// The UUID a Codex session id refers to: v2 ids are the thread UUID, legacy
/// ids are the rollout stem ending with it.
fn codex_thread_key(session_id: &str) -> Option<String> {
    let tail = session_id.get(session_id.len().checked_sub(36)?..)?;
    let bytes = tail.as_bytes();
    let valid = bytes.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    });
    valid.then(|| tail.to_ascii_lowercase())
}

fn text_lossy(value: ValueRef<'_>) -> Option<String> {
    match value {
        ValueRef::Text(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        _ => None,
    }
}

fn table_has_columns(conn: &Connection, table: &str, columns: &[&str]) -> Result<bool, Resolution> {
    let mut statement = conn
        .prepare("SELECT name FROM pragma_table_info(?1)")
        .map_err(|_| Resolution::SourceUnreadable)?;
    let names = statement
        .query_map([table], |row| row.get::<_, String>(0))
        .map_err(|_| Resolution::SourceUnreadable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Resolution::SourceUnreadable)?;
    Ok(columns
        .iter()
        .all(|column| names.iter().any(|name| name == column)))
}

/// MiniMax Code v2: `local_runtime_sessions`. A non-default workspace uses
/// `project_workspace_dir`, falling back to `workspace_dir`; the default
/// workspace is a tool-managed directory (spec §2.2).
fn minimax_v2_workdir(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<HeaderHit>, Resolution> {
    if !table_has_columns(
        conn,
        "local_runtime_sessions",
        &["session_id", "workspace_dir"],
    )? {
        return Ok(None);
    }
    let project_expr =
        if table_has_columns(conn, "local_runtime_sessions", &["project_workspace_dir"])? {
            "project_workspace_dir"
        } else {
            "NULL"
        };
    let default_expr =
        if table_has_columns(conn, "local_runtime_sessions", &["is_default_workspace"])? {
            "is_default_workspace"
        } else {
            "0"
        };
    let sql = format!(
        "SELECT workspace_dir, {project_expr}, {default_expr}
         FROM local_runtime_sessions WHERE session_id = ?1"
    );
    let row = conn
        .query_row(&sql, [session_id], |row| {
            Ok((
                text_lossy(row.get_ref(0)?),
                text_lossy(row.get_ref(1)?),
                row.get_ref(2)?.as_i64().unwrap_or(0) == 1,
            ))
        })
        .optional()
        .map_err(|_| Resolution::SourceUnreadable)?;
    Ok(
        row.map(|(workspace, project_workspace, default_workspace)| {
            let cwd = project_workspace
                .filter(|value| !value.trim().is_empty())
                .or(workspace.filter(|value| !value.trim().is_empty()));
            match cwd {
                Some(cwd) => Ok(Workdir {
                    cwd,
                    repo_root: None,
                    default_workspace,
                }),
                None => Err(Resolution::FieldMissing),
            }
        }),
    )
}

fn minimax_legacy_workdir(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<HeaderHit>, Resolution> {
    if !table_has_columns(conn, "sessions", &["session_id", "workspace_dir"])? {
        return Ok(None);
    }
    let row = conn
        .query_row(
            "SELECT workspace_dir FROM sessions WHERE session_id = ?1",
            [session_id],
            |row| Ok(text_lossy(row.get_ref(0)?)),
        )
        .optional()
        .map_err(|_| Resolution::SourceUnreadable)?;
    Ok(row.map(|workspace| {
        workspace
            .filter(|value| !value.trim().is_empty())
            .map(Workdir::cwd)
            .ok_or(Resolution::FieldMissing)
    }))
}

// ---------------------------------------------------------------------------
// ReasoniX
// ---------------------------------------------------------------------------

struct ReasonixEntry {
    id: String,
    sessions_dir: PathBuf,
    workspace: Option<String>,
}

#[derive(Default)]
struct ReasonixIndex {
    /// Root session id → family members (crash-recovery forks share a root).
    families: HashMap<String, Vec<usize>>,
    /// Sessions directory → members, for sibling inference.
    by_dir: HashMap<PathBuf, Vec<usize>>,
    entries: Vec<ReasonixEntry>,
}

impl ReasonixIndex {
    fn build(session_roots: &[PathBuf], cancelled: &dyn Fn() -> bool) -> Self {
        let mut index = Self::default();
        for root in session_roots {
            let Ok(entries) = fs::read_dir(root) else {
                continue;
            };
            for entry in entries.flatten() {
                if cancelled() {
                    return index;
                }
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                // Classic `<id>.meta.json` carries `workspace`; newer
                // `<id>.jsonl.telemetry.json` sessions keep `workspace_root`
                // in the `<id>.jsonl.meta` sidecar (both read by the scanner).
                let (id, workspace) = if let Some(id) = name.strip_suffix(".meta.json") {
                    (
                        id.to_string(),
                        read_document_string(&path, &["workspace"], METADATA_MAX_BYTES).ok(),
                    )
                } else if let Some(id) = name.strip_suffix(".jsonl.telemetry.json") {
                    let sidecar = path.with_file_name(format!("{id}.jsonl.meta"));
                    (
                        id.to_string(),
                        read_document_string(&sidecar, &["workspace_root"], METADATA_MAX_BYTES)
                            .ok(),
                    )
                } else {
                    continue;
                };
                let position = index.entries.len();
                let root_id = crate::scanner::reasonix_root_session_id(&id);
                index.families.entry(root_id).or_default().push(position);
                index.by_dir.entry(root.clone()).or_default().push(position);
                index.entries.push(ReasonixEntry {
                    id,
                    sessions_dir: root.clone(),
                    workspace,
                });
            }
        }
        index
    }

    fn lookup(&self, root_id: &str) -> HeaderHit {
        let members = self
            .families
            .get(root_id)
            .ok_or(Resolution::SourceMissing)?;
        let own = members
            .iter()
            .map(|position| &self.entries[*position])
            .filter(|entry| entry.workspace.is_some());
        // The root session itself first, then any recovery fork.
        if let Some(entry) = own
            .clone()
            .find(|entry| entry.id == root_id)
            .or_else(|| own.clone().next())
        {
            return Ok(Workdir::cwd(entry.workspace.clone().unwrap_or_default()));
        }
        // Per-workspace layout `<base>/projects/<encoded workspace>/sessions`:
        // borrow a sibling's `workspace_root` only when encoding it
        // reproduces the directory name exactly (spec §2.2).
        for position in members {
            let entry = &self.entries[*position];
            let Some(encoded) = reasonix_encoded_dir(&entry.sessions_dir) else {
                continue;
            };
            let Some(siblings) = self.by_dir.get(&entry.sessions_dir) else {
                continue;
            };
            for sibling in siblings {
                let Some(workspace) = self.entries[*sibling].workspace.as_deref() else {
                    continue;
                };
                if reasonix_encodings(workspace)
                    .iter()
                    .any(|candidate| candidate == &encoded)
                {
                    return Ok(Workdir::cwd(workspace.to_string()));
                }
            }
        }
        Err(Resolution::FieldMissing)
    }
}

/// `<base>/projects/<encoded>/sessions` → `<encoded>`.
fn reasonix_encoded_dir(sessions_dir: &Path) -> Option<String> {
    if sessions_dir.file_name()?.to_str()? != "sessions" {
        return None;
    }
    let encoded_dir = sessions_dir.parent()?;
    if encoded_dir.parent()?.file_name()?.to_str()? != "projects" {
        return None;
    }
    encoded_dir.file_name()?.to_str().map(str::to_string)
}

/// Directory-name encodings observed on a local ReasoniX install (T10.165
/// structure probe: 2/2 matched both). Unknown encodings never match, so a
/// sibling is never borrowed on a guess.
fn reasonix_encodings(workspace: &str) -> [String; 2] {
    let lower = workspace.to_lowercase();
    [
        lower
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .collect(),
        lower
            .chars()
            .map(|ch| {
                if matches!(ch, '/' | '\\' | ':') {
                    '-'
                } else {
                    ch
                }
            })
            .collect(),
    ]
}

// ---------------------------------------------------------------------------
// Kimi Code / Kimi Desktop
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct KimiWorkspaces {
    #[serde(default)]
    workspaces: HashMap<String, KimiWorkspace>,
}

#[derive(Deserialize, Default)]
struct KimiWorkspace {
    #[serde(default, deserialize_with = "lenient_string")]
    root: Option<String>,
}

/// A string value, or `None` for any other JSON type. Non-string values are
/// skipped with `IgnoredAny`, never materialized (review P2-3, Q7 condition).
fn lenient_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};
    struct StringOnly;
    impl<'de> Visitor<'de> for StringOnly {
        type Value = Option<String>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("any JSON value")
        }
        fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
            Ok(Some(value.to_string()))
        }
        fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> {
            Ok(Some(value))
        }
        fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_some<D2: serde::Deserializer<'de>>(
            self,
            deserializer: D2,
        ) -> Result<Self::Value, D2::Error> {
            deserializer.deserialize_any(self)
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok(None)
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
            Ok(None)
        }
    }
    deserializer.deserialize_any(StringOnly)
}

#[derive(Default)]
struct KimiIndex {
    /// Session directory name → (workspace directory name, session dir).
    sessions: HashMap<String, (String, PathBuf)>,
    /// `session_index.jsonl`: session id / session dir name → `workDir`.
    index_workdirs: HashMap<String, String>,
    /// `workspaces.json`: workspace key → `root`.
    workspace_roots: HashMap<String, String>,
}

impl KimiIndex {
    fn build(session_roots: &[PathBuf], cancelled: &dyn Fn() -> bool) -> Self {
        let mut index = Self::default();
        for root in session_roots {
            // Layout: `<home>/sessions/<wd_*>/<session_*>/`.
            if let Ok(workspaces) = fs::read_dir(root) {
                for workspace in workspaces.flatten() {
                    if cancelled() {
                        return index;
                    }
                    let Some(wd) = workspace.file_name().to_str().map(str::to_string) else {
                        continue;
                    };
                    let Ok(sessions) = fs::read_dir(workspace.path()) else {
                        continue;
                    };
                    for session in sessions.flatten() {
                        let path = session.path();
                        if !path.is_dir() {
                            continue;
                        }
                        if let Some(name) = session.file_name().to_str() {
                            index
                                .sessions
                                .entry(name.to_string())
                                .or_insert((wd.clone(), path));
                        }
                    }
                }
            }
            let Some(home) = root.parent() else {
                continue;
            };
            if let Ok(file) = File::open(home.join("session_index.jsonl")) {
                let workdirs = &mut index.index_workdirs;
                let _ = probe_lines(
                    BufReader::new(file),
                    &[&["sessionId"], &["sessionDir"], &["workDir"]],
                    KIMI_INDEX_MAX_VALUES,
                    KIMI_INDEX_MAX_BYTES,
                    |fields| {
                        if let Some(work_dir) = fields[2].clone() {
                            if let Some(id) = fields[0].clone().filter(|id| !id.is_empty()) {
                                workdirs.entry(id).or_insert_with(|| work_dir.clone());
                            }
                            if let Some(dir_name) = fields[1]
                                .as_deref()
                                .and_then(|dir| dir.rsplit(['/', '\\']).find(|p| !p.is_empty()))
                            {
                                workdirs.entry(dir_name.to_string()).or_insert(work_dir);
                            }
                        }
                        Flow::Continue
                    },
                );
            }
            if let Ok(file) = File::open(home.join("workspaces.json")) {
                let parsed: KimiWorkspaces =
                    serde_json::from_reader(BufReader::new(file.take(METADATA_MAX_BYTES)))
                        .unwrap_or_default();
                for (key, workspace) in parsed.workspaces {
                    if let Some(root) = workspace.root.filter(|root| !root.trim().is_empty()) {
                        index.workspace_roots.entry(key).or_insert(root);
                    }
                }
            }
        }
        index
    }

    /// Spec §2.2 order: `state.json.workDir` → index `workDir` →
    /// `state.json.cwd` → the workspace's `root`.
    fn lookup(&self, session_id: &str) -> HeaderHit {
        let session = self.sessions.get(session_id);
        let mut state_cwd: Option<String> = None;
        let mut failure = Resolution::SourceMissing;
        if let Some((_, dir)) = session {
            failure = Resolution::FieldMissing;
            let state = dir.join("state.json");
            if let Ok(file) = File::open(&state) {
                let (fields, result) = probe_document(
                    BufReader::new(file),
                    &[&["workDir"], &["cwd"]],
                    METADATA_MAX_BYTES,
                );
                match (&fields[0], &fields[1]) {
                    (Some(work_dir), _) if !work_dir.trim().is_empty() => {
                        return Ok(Workdir::cwd(work_dir.clone()))
                    }
                    (_, Some(cwd)) if !cwd.trim().is_empty() => state_cwd = Some(cwd.clone()),
                    _ => {
                        if result.is_err() {
                            failure = probe_failure(result);
                        }
                    }
                }
            }
        }
        if let Some(work_dir) = self
            .index_workdirs
            .get(session_id)
            .filter(|work_dir| !work_dir.trim().is_empty())
        {
            return Ok(Workdir::cwd(work_dir.clone()));
        }
        if let Some(cwd) = state_cwd {
            return Ok(Workdir::cwd(cwd));
        }
        if let Some((wd, _)) = session {
            if let Some(root) = self.workspace_roots.get(wd) {
                return Ok(Workdir::cwd(root.clone()));
            }
        }
        Err(failure)
    }
}
