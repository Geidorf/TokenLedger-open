//! Pure project-name derivation (T10.155 spec §2.4).
//!
//! Input is a session's raw working directory (and an optional repository root
//! reported by the source). Output is only a sanitized last-level folder name
//! or a fixed bucket. Full paths live in the caller's memory for the duration
//! of one call and are never returned, stored or logged.
//!
//! Everything here is host-independent: [`HostEnv`] carries the host's path
//! style, case rules and well-known directories, so Windows, macOS and Linux
//! path matrices are testable on any machine. Derivation touches the file
//! system only through the injected [`super::git_probe::GitProbe`], which is
//! disabled by default (see `GIT_PROBE_ENABLED`); [`HostEnv::detect`] only
//! asks the OS for spellings of the host's own directories.

use super::git_probe::GitProbe;

/// Maximum grapheme clusters of a stored label, including the ellipsis.
pub(crate) const LABEL_MAX_GRAPHEMES: usize = 64;
/// Hard cap on code points (clusters stacked with marks), well inside the
/// database constraint on label length.
pub(crate) const LABEL_MAX_CHARS: usize = 128;
/// Longer raw values are treated as invalid instead of being processed.
pub(crate) const MAX_RAW_PATH_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ProjectKind {
    Named,
    Home,
    Root,
    Temp,
    Managed,
    Unresolved,
}

impl ProjectKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Named => "named",
            Self::Home => "home",
            Self::Root => "root",
            Self::Temp => "temp",
            Self::Managed => "managed",
            Self::Unresolved => "unresolved",
        }
    }

    pub(crate) fn bucket_key(self) -> &'static str {
        match self {
            Self::Named => "n:",
            Self::Home => "@home",
            Self::Root => "@root",
            Self::Temp => "@temp",
            Self::Managed => "@managed",
            Self::Unresolved => "@unresolved",
        }
    }
}

/// How a session's project was determined, or the fixed reason code why it
/// could not be. These codes are the only failure detail that may reach logs,
/// the database or the front end (spec §3.8).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Resolution {
    GitRoot,
    GitWorktree,
    GitSubmodule,
    SourceGitRoot,
    WorktreeHeuristic,
    Folder,
    Bucket,
    UnsupportedSource,
    SourceMissing,
    SourceUnreadable,
    FieldMissing,
    InvalidPath,
    BudgetExceeded,
}

impl Resolution {
    pub(crate) const ALL: [Resolution; 13] = [
        Self::GitRoot,
        Self::GitWorktree,
        Self::GitSubmodule,
        Self::SourceGitRoot,
        Self::WorktreeHeuristic,
        Self::Folder,
        Self::Bucket,
        Self::UnsupportedSource,
        Self::SourceMissing,
        Self::SourceUnreadable,
        Self::FieldMissing,
        Self::InvalidPath,
        Self::BudgetExceeded,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::GitRoot => "git_root",
            Self::GitWorktree => "git_worktree",
            Self::GitSubmodule => "git_submodule",
            Self::SourceGitRoot => "source_git_root",
            Self::WorktreeHeuristic => "worktree_heuristic",
            Self::Folder => "folder",
            Self::Bucket => "bucket",
            Self::UnsupportedSource => "unsupported_source",
            Self::SourceMissing => "source_missing",
            Self::SourceUnreadable => "source_unreadable",
            Self::FieldMissing => "field_missing",
            Self::InvalidPath => "invalid_path",
            Self::BudgetExceeded => "budget_exceeded",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|item| item.as_str() == value)
    }

    /// Unresolved outcomes that may change without a rule change (a log that
    /// reappears, a locked database, a field written later). Full passes retry
    /// them; everything else is only recomputed after a resolver upgrade.
    pub(crate) fn is_retryable(self) -> bool {
        matches!(
            self,
            Self::SourceMissing | Self::SourceUnreadable | Self::FieldMissing
        )
    }
}

/// The per-session result that may be persisted: never a path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProjectRef {
    pub(crate) kind: ProjectKind,
    pub(crate) key: String,
    pub(crate) label: Option<String>,
    pub(crate) resolution: Resolution,
}

impl ProjectRef {
    /// A named project from a raw folder name; `None` when the name does not
    /// survive sanitization (empty, `.`, `..`).
    pub(crate) fn named(raw_name: &str, resolution: Resolution) -> Option<Self> {
        let label = sanitize_label(raw_name)?;
        Some(Self {
            kind: ProjectKind::Named,
            key: project_key_for_label(&label),
            label: Some(label),
            resolution,
        })
    }

    pub(crate) fn bucket(kind: ProjectKind) -> Self {
        debug_assert!(!matches!(
            kind,
            ProjectKind::Named | ProjectKind::Unresolved
        ));
        Self {
            kind,
            key: kind.bucket_key().to_string(),
            label: None,
            resolution: Resolution::Bucket,
        }
    }

    pub(crate) fn unresolved(resolution: Resolution) -> Self {
        Self {
            kind: ProjectKind::Unresolved,
            key: ProjectKind::Unresolved.bucket_key().to_string(),
            label: None,
            resolution,
        }
    }
}

/// `n:` + Unicode lower case of the sanitized label (spec §2.4 “项目键”).
pub(crate) fn project_key_for_label(label: &str) -> String {
    format!("n:{}", label.to_lowercase())
}

/// Display label for one project key: the spelling used by the most sessions,
/// ties broken by code-point order (spec §2.4). For the behavior aggregation.
pub(crate) fn choose_display_label<'a>(
    candidates: impl IntoIterator<Item = (&'a str, u64)>,
) -> Option<&'a str> {
    candidates
        .into_iter()
        .max_by(|(left_label, left_count), (right_label, right_count)| {
            left_count
                .cmp(right_count)
                .then_with(|| right_label.cmp(left_label))
        })
        .map(|(label, _)| label)
}

// ---------------------------------------------------------------------------
// Host description
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostStyle {
    Windows,
    Posix,
}

/// Host facts needed by the rules. Built once per pass; paths inside are the
/// host's own well-known directories, never session data.
#[derive(Clone, Debug)]
pub(crate) struct HostEnv {
    pub(crate) host: HostStyle,
    /// POSIX-style paths compare case-insensitively (macOS). Windows-style
    /// paths always do.
    pub(crate) posix_case_insensitive: bool,
    /// Every spelling of the user's home (see [`home_spellings`]).
    pub(crate) homes: Vec<NormPath>,
    pub(crate) temp_dirs: Vec<NormPath>,
    pub(crate) managed_dirs: Vec<NormPath>,
    /// User-content folders inside a managed tree (iCloud Drive and cloud
    /// storage mounts under macOS `~/Library`): never bucketed as managed.
    pub(crate) unmanaged_dirs: Vec<NormPath>,
    /// Direct children of home whose name starts with one of these prefixes
    /// are tool-managed task roots (Multica).
    pub(crate) managed_home_child_prefixes: Vec<String>,
    /// This host's account names, sanitized and lower-cased: the last
    /// component of every home spelling plus the login name. A label equal
    /// to one of them is never stored.
    pub(crate) account_names: Vec<String>,
}

impl HostEnv {
    pub(crate) fn empty(host: HostStyle, posix_case_insensitive: bool) -> Self {
        Self {
            host,
            posix_case_insensitive,
            homes: Vec::new(),
            temp_dirs: Vec::new(),
            managed_dirs: Vec::new(),
            unmanaged_dirs: Vec::new(),
            managed_home_child_prefixes: vec!["multica_workspaces_".to_string()],
            account_names: Vec::new(),
        }
    }

    /// Adds account names (for example the login name, which may differ
    /// from the profile folder name).
    pub(crate) fn with_account_names(mut self, names: &[String]) -> Self {
        for name in names {
            self.add_account_name(name);
        }
        self
    }

    /// Adds user-content folders that stay named even inside a managed tree.
    pub(crate) fn with_unmanaged_dirs(mut self, dirs: &[String]) -> Self {
        for dir in dirs {
            if let Some(path) = NormPath::parse(dir, self.host) {
                if !self.unmanaged_dirs.contains(&path) {
                    self.unmanaged_dirs.push(path);
                }
            }
        }
        self
    }

    fn add_account_name(&mut self, raw: &str) {
        if let Some(label) = sanitize_label(raw) {
            let folded = label.to_lowercase();
            if !self.account_names.contains(&folded) {
                self.account_names.push(folded);
            }
        }
    }

    /// A sanitized label that equals one of this host's account names.
    pub(crate) fn is_account_name(&self, label: &str) -> bool {
        self.account_names.contains(&label.to_lowercase())
    }

    /// `path` is a home directory (this host's in any spelling, or a
    /// conventional one of any account), a folder that holds home
    /// directories (`C:\Users`, `/home`), or an ancestor of this host's home.
    /// None of these is ever a project: their names are account names or
    /// system folders.
    pub(crate) fn is_home_or_above(&self, path: &NormPath) -> bool {
        let ci = self.case_insensitive(path);
        self.homes.iter().any(|home| home.is_within(path, ci))
            || is_conventional_home(path, ci)
            || is_home_container(path, ci)
    }

    /// Builds the environment from explicit raw directories; unparsable
    /// entries are dropped. Used by tests and by [`HostEnv::detect`].
    pub(crate) fn from_dirs(
        host: HostStyle,
        posix_case_insensitive: bool,
        homes: &[String],
        temp_dirs: &[String],
        managed_dirs: &[String],
    ) -> Self {
        let parse_all = |values: &[String]| -> Vec<NormPath> {
            let mut parsed: Vec<NormPath> = Vec::new();
            for value in values {
                let Some(path) = NormPath::parse(value, host) else {
                    continue;
                };
                for variant in path.macos_private_variants() {
                    if !parsed.contains(&variant) {
                        parsed.push(variant);
                    }
                }
            }
            parsed
        };
        let mut env = Self::empty(host, posix_case_insensitive);
        env.homes = parse_all(homes);
        env.temp_dirs = parse_all(temp_dirs);
        env.managed_dirs = parse_all(managed_dirs);
        let home_names: Vec<String> = env
            .homes
            .iter()
            .filter_map(|home| home.last().map(str::to_string))
            .collect();
        for name in home_names {
            env.add_account_name(&name);
        }
        env
    }

    /// The running host. Only reads environment variables and asks the OS for
    /// the long, short and physical spellings of the host's own well-known
    /// directories (see [`host_path_variants`]).
    pub(crate) fn detect() -> Self {
        let host = if cfg!(windows) {
            HostStyle::Windows
        } else {
            HostStyle::Posix
        };
        let home_dir = crate::scanner::helpers::get_home_dir();
        let env_dir = |name: &str| std::env::var_os(name).map(std::path::PathBuf::from);
        let mut unmanaged = Vec::new();
        let mut temps = vec![std::env::temp_dir()];
        let mut managed = vec![home_dir.join(".multica")];
        for name in ["TEMP", "TMP", "TMPDIR"] {
            if let Some(dir) = env_dir(name) {
                temps.push(dir);
            }
        }
        if cfg!(windows) {
            if let Some(local) = env_dir("LOCALAPPDATA") {
                temps.push(local.join("Temp"));
                managed.push(local);
            }
            if let Some(roaming) = env_dir("APPDATA") {
                managed.push(roaming);
            }
            // Covers Roaming, Local and LocalLow even when the variables are
            // redirected.
            managed.push(home_dir.join("AppData"));
            if let Some(system_root) = env_dir("SystemRoot") {
                temps.push(system_root.join("Temp"));
            }
        } else if cfg!(target_os = "macos") {
            managed.push(home_dir.join("Library"));
            // iCloud Drive and File Provider cloud folders hold user projects.
            unmanaged.push(home_dir.join("Library/Mobile Documents"));
            unmanaged.push(home_dir.join("Library/CloudStorage"));
            for fixed in ["/tmp", "/var/tmp", "/var/folders"] {
                temps.push(std::path::PathBuf::from(fixed));
            }
        } else {
            for fixed in ["/tmp", "/var/tmp", "/dev/shm"] {
                temps.push(std::path::PathBuf::from(fixed));
            }
            let config = env_dir("XDG_CONFIG_HOME").unwrap_or_else(|| home_dir.join(".config"));
            let data = env_dir("XDG_DATA_HOME").unwrap_or_else(|| home_dir.join(".local/share"));
            let state = env_dir("XDG_STATE_HOME").unwrap_or_else(|| home_dir.join(".local/state"));
            let cache = env_dir("XDG_CACHE_HOME").unwrap_or_else(|| home_dir.join(".cache"));
            managed.extend([config, data, state, cache]);
        }
        let expand = |dirs: Vec<std::path::PathBuf>| -> Vec<String> {
            let mut out = Vec::new();
            for dir in dirs {
                for variant in host_path_variants(&dir) {
                    let text = variant.to_string_lossy().into_owned();
                    if !out.contains(&text) {
                        out.push(text);
                    }
                }
            }
            out
        };
        let login_names: Vec<String> = ["USERNAME", "USER", "LOGNAME"]
            .iter()
            .filter_map(|name| std::env::var(name).ok())
            .collect();
        let home_texts = home_spellings(
            host,
            &home_dir,
            &|name| std::env::var(name).ok(),
            &host_path_variants,
        );
        Self::from_dirs(
            host,
            cfg!(target_os = "macos"),
            &home_texts,
            &expand(temps),
            &expand(managed),
        )
        .with_unmanaged_dirs(&expand(unmanaged))
        .with_account_names(&login_names)
    }

    fn is_home(&self, path: &NormPath) -> bool {
        self.homes
            .iter()
            .any(|home| path.same_as(home, self.case_insensitive(path)))
    }

    fn is_within_any(&self, path: &NormPath, dirs: &[NormPath]) -> bool {
        dirs.iter()
            .any(|dir| path.is_within(dir, self.case_insensitive(path)))
    }

    fn is_managed(&self, path: &NormPath) -> bool {
        if self.is_within_any(path, &self.unmanaged_dirs) {
            return false;
        }
        if self.is_within_any(path, &self.managed_dirs) {
            return true;
        }
        let ci = self.case_insensitive(path);
        self.homes.iter().any(|home| {
            if !path.is_within(home, ci) || path.parts.len() <= home.parts.len() {
                return false;
            }
            let child = &path.parts[home.parts.len()];
            self.managed_home_child_prefixes.iter().any(|prefix| {
                if ci {
                    child.to_lowercase().starts_with(&prefix.to_lowercase())
                } else {
                    child.starts_with(prefix.as_str())
                }
            })
        })
    }

    pub(crate) fn case_insensitive(&self, path: &NormPath) -> bool {
        match path.prefix {
            PathPrefix::Posix => self.posix_case_insensitive,
            PathPrefix::Drive(_) | PathPrefix::Unc { .. } => true,
        }
    }
}

/// Every spelling of this host's home that a tool may record (T10.165 review
/// P3-a). Home names never become project names, so each spelling and its
/// last component (an account name) must be known:
/// - the home directory with its `variants` (long, 8.3 short and physical
///   forms, see [`host_path_variants`]);
/// - on Windows, `%HOME%` (Git and POSIX tools may use a home other than
///   `%USERPROFILE%`), `%HOMESHARE%` and `%HOMEDRIVE%%HOMEPATH%` of roaming
///   or redirected profiles. These are taken verbatim: asking the OS for
///   other spellings of a network path could block.
///
/// Unparsable values and drive, share or POSIX roots are dropped: a root is
/// never a home.
pub(crate) fn home_spellings(
    host: HostStyle,
    home_dir: &std::path::Path,
    var: &dyn Fn(&str) -> Option<String>,
    variants: &dyn Fn(&std::path::Path) -> Vec<std::path::PathBuf>,
) -> Vec<String> {
    let mut candidates: Vec<String> = variants(home_dir)
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if host == HostStyle::Windows {
        candidates.extend(var("HOME"));
        candidates.extend(var("HOMESHARE"));
        if let (Some(drive), Some(path)) = (var("HOMEDRIVE"), var("HOMEPATH")) {
            candidates.push(format!("{drive}{path}"));
        }
    }
    let mut spellings: Vec<String> = Vec::new();
    for candidate in candidates {
        let candidate = candidate.trim().to_string();
        let usable = NormPath::parse(&candidate, host).is_some_and(|path| !path.is_root());
        if usable && !spellings.contains(&candidate) {
            spellings.push(candidate);
        }
    }
    spellings
}

/// Spellings of one of the host's own directories that tools may record:
/// the path itself, its physical path with symlinks and junctions resolved
/// (review P3-a: `getcwd` reports the resolved path, so a session started
/// in a symlinked home records the target), and on Windows its long and
/// 8.3 short forms. Every comparison against home/temp/app-data must accept
/// all of them.
pub(crate) fn host_path_variants(path: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut variants = vec![path.to_path_buf()];
    let physical = std::fs::canonicalize(path).ok();
    #[cfg(windows)]
    let spellings = [physical, windows_long_path(path), windows_short_path(path)];
    #[cfg(not(windows))]
    let spellings = [physical];
    for variant in spellings.into_iter().flatten() {
        if !variants.contains(&variant) {
            variants.push(variant);
        }
    }
    variants
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetLongPathNameW(short_path: *const u16, long_path: *mut u16, buffer_len: u32) -> u32;
    fn GetShortPathNameW(long_path: *const u16, short_path: *mut u16, buffer_len: u32) -> u32;
}

#[cfg(windows)]
fn windows_path_call(
    path: &std::path::Path,
    call: unsafe extern "system" fn(*const u16, *mut u16, u32) -> u32,
) -> Option<std::path::PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut buffer = vec![0u16; 1024];
    for _ in 0..2 {
        let written = unsafe { call(wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) };
        if written == 0 {
            return None;
        }
        let written = written as usize;
        if written < buffer.len() {
            buffer.truncate(written);
            return Some(std::path::PathBuf::from(std::ffi::OsString::from_wide(
                &buffer,
            )));
        }
        buffer = vec![0u16; written + 1];
    }
    None
}

#[cfg(windows)]
fn windows_long_path(path: &std::path::Path) -> Option<std::path::PathBuf> {
    windows_path_call(path, GetLongPathNameW)
}

#[cfg(windows)]
fn windows_short_path(path: &std::path::Path) -> Option<std::path::PathBuf> {
    windows_path_call(path, GetShortPathNameW)
}

// ---------------------------------------------------------------------------
// Lexical path normalization
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PathPrefix {
    /// Upper-case drive letter.
    Drive(char),
    /// `\\server\share`, stored in lower case (UNC names are case-insensitive).
    Unc {
        server: String,
        share: String,
    },
    Posix,
}

/// An absolute path split into components after lexical `.`/`..` removal.
/// Nothing is resolved against the file system.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NormPath {
    pub(crate) prefix: PathPrefix,
    pub(crate) parts: Vec<String>,
}

fn strip_prefix_ascii_ci<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let head = value.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &value[prefix.len()..])
}

fn is_windows_separator(ch: char) -> bool {
    ch == '\\' || ch == '/'
}

impl NormPath {
    /// Parses an absolute path. Accepted forms: `C:\…`, `C:/…`, `\\?\C:\…`,
    /// `\\?\UNC\server\share\…`, `\\server\share\…`, MSYS `/c/…` (Windows
    /// hosts only) and POSIX `/…`. Relative, drive-relative (`C:foo`), empty
    /// and over-long values yield `None` (`invalid_path`).
    pub(crate) fn parse(raw: &str, host: HostStyle) -> Option<Self> {
        let value = raw.trim();
        if value.is_empty() || value.len() > MAX_RAW_PATH_BYTES || value.contains('\0') {
            return None;
        }
        for verbatim_unc in [r"\\?\UNC\", r"\\.\UNC\", "//?/UNC/", "//./UNC/"] {
            if let Some(rest) = strip_prefix_ascii_ci(value, verbatim_unc) {
                return Self::parse_unc(rest);
            }
        }
        for verbatim in [r"\\?\", r"\\.\", "//?/", "//./"] {
            if let Some(rest) = value.strip_prefix(verbatim) {
                return Self::parse_drive(rest);
            }
        }
        let bytes = value.as_bytes();
        if bytes.len() >= 2 && is_windows_separator(bytes[0] as char) && bytes[0] == bytes[1] {
            // `\\server\share` is UNC everywhere; `//server/share` only on
            // Windows hosts (POSIX treats a leading `//` like `/`).
            if bytes[0] == b'\\' || host == HostStyle::Windows {
                return Self::parse_unc(&value[2..]);
            }
        }
        if let Some(path) = Self::parse_drive(value) {
            return Some(path);
        }
        if let Some(rest) = value.strip_prefix('/') {
            if host == HostStyle::Windows {
                // MSYS / Git Bash (`/c/…`), Cygwin (`/cygdrive/c/…`) and WSL
                // (`/mnt/c/…`) spellings of a drive path on a Windows host.
                let without_mount = strip_prefix_ascii_ci(rest, "cygdrive/")
                    .or_else(|| rest.strip_prefix("mnt/"))
                    .unwrap_or(rest);
                let mut pieces = without_mount.splitn(2, '/');
                let first = pieces.next().unwrap_or("");
                if first.len() == 1 && first.as_bytes()[0].is_ascii_alphabetic() {
                    let drive = first.as_bytes()[0].to_ascii_uppercase() as char;
                    let remainder = pieces.next().unwrap_or("");
                    return Some(Self {
                        prefix: PathPrefix::Drive(drive),
                        parts: normalize_parts(remainder.split(is_windows_separator)),
                    });
                }
            }
            return Some(Self {
                prefix: PathPrefix::Posix,
                parts: normalize_parts(rest.split('/')),
            });
        }
        None
    }

    fn parse_drive(value: &str) -> Option<Self> {
        let bytes = value.as_bytes();
        if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
            return None;
        }
        let rest = &value[2..];
        if !rest.starts_with(is_windows_separator) {
            // `C:` and `C:foo` are relative to the drive's current directory.
            return None;
        }
        Some(Self {
            prefix: PathPrefix::Drive(bytes[0].to_ascii_uppercase() as char),
            parts: normalize_parts(rest.split(is_windows_separator)),
        })
    }

    fn parse_unc(rest: &str) -> Option<Self> {
        let mut pieces = rest
            .split(is_windows_separator)
            .filter(|piece| !piece.is_empty());
        let server = pieces.next()?.to_lowercase();
        let share = pieces.next()?.to_lowercase();
        if server == "." || server == "?" {
            return None;
        }
        Some(Self {
            prefix: PathPrefix::Unc { server, share },
            parts: normalize_parts(pieces),
        })
    }

    pub(crate) fn last(&self) -> Option<&str> {
        self.parts.last().map(String::as_str)
    }

    /// Drive root, POSIX root or UNC share root.
    pub(crate) fn is_root(&self) -> bool {
        self.parts.is_empty()
    }

    pub(crate) fn parent(&self) -> Option<Self> {
        if self.parts.is_empty() {
            return None;
        }
        let mut parent = self.clone();
        parent.parts.pop();
        Some(parent)
    }

    fn components_equal(left: &str, right: &str, case_insensitive: bool) -> bool {
        if case_insensitive {
            left == right || left.to_lowercase() == right.to_lowercase()
        } else {
            left == right
        }
    }

    pub(crate) fn same_as(&self, other: &Self, case_insensitive: bool) -> bool {
        self.prefix == other.prefix
            && self.parts.len() == other.parts.len()
            && self
                .parts
                .iter()
                .zip(&other.parts)
                .all(|(left, right)| Self::components_equal(left, right, case_insensitive))
    }

    /// `self` equals `dir` or lies below it.
    pub(crate) fn is_within(&self, dir: &Self, case_insensitive: bool) -> bool {
        self.prefix == dir.prefix
            && self.parts.len() >= dir.parts.len()
            && self
                .parts
                .iter()
                .zip(&dir.parts)
                .all(|(left, right)| Self::components_equal(left, right, case_insensitive))
    }

    /// `/var/…` ↔ `/private/var/…` and `/tmp` ↔ `/private/tmp` (macOS symlinks).
    fn macos_private_variants(&self) -> Vec<Self> {
        let mut variants = vec![self.clone()];
        if self.prefix != PathPrefix::Posix {
            return variants;
        }
        match self.parts.first().map(String::as_str) {
            Some("var") | Some("tmp") | Some("etc") => {
                let mut private = self.clone();
                private.parts.insert(0, "private".to_string());
                variants.push(private);
            }
            Some("private")
                if matches!(
                    self.parts.get(1).map(String::as_str),
                    Some("var") | Some("tmp") | Some("etc")
                ) =>
            {
                let mut public = self.clone();
                public.parts.remove(0);
                variants.push(public);
            }
            _ => {}
        }
        variants
    }

    /// Host-native path for file-system probing. `None` for forms that are not
    /// local to this host (UNC, POSIX paths on Windows, drive paths elsewhere).
    pub(crate) fn to_host_path(&self, host: HostStyle) -> Option<std::path::PathBuf> {
        match (&self.prefix, host) {
            (PathPrefix::Drive(letter), HostStyle::Windows) => {
                let mut text = format!("{letter}:\\");
                text.push_str(&self.parts.join("\\"));
                Some(std::path::PathBuf::from(text))
            }
            (PathPrefix::Posix, HostStyle::Posix) => {
                let mut text = String::from("/");
                text.push_str(&self.parts.join("/"));
                Some(std::path::PathBuf::from(text))
            }
            _ => None,
        }
    }

    pub(crate) fn join_relative(&self, relative: &str) -> Self {
        let separators: &[char] = match self.prefix {
            PathPrefix::Posix => &['/'],
            _ => &['\\', '/'],
        };
        let mut parts = self.parts.clone();
        parts.extend(relative.split(separators).map(str::to_string));
        Self {
            prefix: self.prefix.clone(),
            parts: normalize_parts(parts.iter().map(String::as_str)),
        }
    }
}

fn normalize_parts<'a>(pieces: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    for piece in pieces {
        match piece {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other.to_string()),
        }
    }
    parts
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/// Everything a source may provide for one session.
#[derive(Clone, Debug, Default)]
pub(crate) struct ResolverInput<'a> {
    /// First working directory of the session (absolute, raw).
    pub(crate) cwd: &'a str,
    /// Repository root reported by the source itself (Grok `git_root_dir`,
    /// Hermes `git_repo_root`, OpenCode `path.root`).
    pub(crate) repo_root: Option<&'a str>,
    /// Source marks the directory as its own default workspace (MiniMax
    /// `is_default_workspace = 1`).
    pub(crate) default_workspace: bool,
}

/// Spec §2.4, first match wins:
/// 1 normalize → 2 fixed buckets (home / root / home containers / temp) →
/// 3 git probe (switch) → 4 source repo root → 5 managed → 6 worktree string
/// rules → 7 folder; then the account-name guard.
///
/// Privacy rule (T10.165 review P1, P3-a): a home directory in any spelling
/// this module can recognize, a folder holding home directories, or anything
/// above this host's home is never a project, on any route — session folder,
/// git probe, source repository root or worktree layout. A label equal to an
/// account name is never stored either: this host's account names, and the
/// name of any conventional home the session path or the reported
/// repository root passes through (another account's, for example
/// `C:\Users\Bob\.codex\worktrees\<id>\Bob`). Both become the home group.
pub(crate) fn derive_project(
    input: &ResolverInput<'_>,
    env: &HostEnv,
    git: &dyn GitProbe,
) -> ProjectRef {
    let project = derive_by_rules(input, env, git);
    let names_account = match project.label.as_deref() {
        Some(label) => {
            let paths: Vec<NormPath> = std::iter::once(input.cwd)
                .chain(input.repo_root)
                .filter_map(|raw| NormPath::parse(raw, env.host))
                .collect();
            names_an_account(label, env, &paths)
        }
        None => false,
    };
    if names_account {
        ProjectRef::bucket(ProjectKind::Home)
    } else {
        project
    }
}

/// `label` (sanitized) is one of this host's account names, or the account
/// name of a conventional home that one of `paths` passes through.
fn names_an_account(label: &str, env: &HostEnv, paths: &[NormPath]) -> bool {
    if env.is_account_name(label) {
        return true;
    }
    let folded = label.to_lowercase();
    paths.iter().any(|path| {
        let ci = env.case_insensitive(path);
        (1..=path.parts.len()).any(|depth| {
            let ancestor = &path.parts[..depth];
            is_conventional_home_parts(&path.prefix, ancestor, ci)
                && sanitize_label(&ancestor[depth - 1])
                    .is_some_and(|name| name.to_lowercase() == folded)
        })
    })
}

fn derive_by_rules(input: &ResolverInput<'_>, env: &HostEnv, git: &dyn GitProbe) -> ProjectRef {
    let Some(path) = NormPath::parse(input.cwd, env.host) else {
        return ProjectRef::unresolved(Resolution::InvalidPath);
    };
    let ci = env.case_insensitive(&path);

    if env.is_home(&path) || is_conventional_home(&path, ci) {
        return ProjectRef::bucket(ProjectKind::Home);
    }
    if path.is_root() {
        return ProjectRef::bucket(ProjectKind::Root);
    }
    if env.is_home_or_above(&path) {
        // `C:\Users`, `/home` and the like: not a project either.
        return ProjectRef::bucket(ProjectKind::Home);
    }
    if env.is_within_any(&path, &env.temp_dirs) {
        return ProjectRef::bucket(ProjectKind::Temp);
    }

    if let Some(hit) = git.probe(&path, env) {
        if let Some(project) = ProjectRef::named(&hit.name, hit.resolution) {
            return project;
        }
    }

    if let Some(project) = input
        .repo_root
        .and_then(|raw| NormPath::parse(raw, env.host))
        .and_then(|root| source_root_project(&root, env))
    {
        return project;
    }

    if input.default_workspace || env.is_managed(&path) {
        return ProjectRef::bucket(ProjectKind::Managed);
    }

    if let Some(repo) = worktree_repo(&path, ci) {
        if repo
            .dir
            .as_ref()
            .is_some_and(|dir| env.is_home_or_above(dir))
        {
            // A worktree of the home folder's own repository (dotfiles) or of
            // a folder above it: its "repository name" is an account name.
            return ProjectRef::bucket(ProjectKind::Home);
        }
        if let Some(project) = ProjectRef::named(&repo.name, Resolution::WorktreeHeuristic) {
            return project;
        }
    }

    path.last()
        .and_then(|name| ProjectRef::named(name, Resolution::Folder))
        .unwrap_or_else(|| ProjectRef::unresolved(Resolution::InvalidPath))
}

/// The project named by a repository root the source reported, or `None`
/// when that root cannot name a project (a root, a home or anything above
/// it, a temp directory, a worktree of such a repository, or a repository
/// named like an account). The session's own folder rules then apply.
fn source_root_project(root: &NormPath, env: &HostEnv) -> Option<ProjectRef> {
    if root.is_root() || env.is_home_or_above(root) || env.is_within_any(root, &env.temp_dirs) {
        return None;
    }
    let name = match worktree_repo(root, env.case_insensitive(root)) {
        Some(repo)
            if repo
                .dir
                .as_ref()
                .is_some_and(|dir| env.is_home_or_above(dir)) =>
        {
            return None
        }
        Some(repo) => repo.name,
        None => root.last()?.to_string(),
    };
    ProjectRef::named(&name, Resolution::SourceGitRoot).filter(|project| {
        !project
            .label
            .as_deref()
            .is_some_and(|label| names_an_account(label, env, std::slice::from_ref(root)))
    })
}

/// A path that *is* a conventional home directory. Its last component is an
/// account name, so it is bucketed even when it is not this host's own home.
fn is_conventional_home(path: &NormPath, case_insensitive: bool) -> bool {
    is_conventional_home_parts(&path.prefix, &path.parts, case_insensitive)
}

/// [`is_conventional_home`] on a prefix and a slice of components:
/// - drive paths: `C:\Users\<name>` and `C:\Documents and Settings\<name>`;
/// - POSIX paths: `/home/<name>`, `/Users/<name>`, `/root`,
///   `/var/home/<name>`, macOS network homes `/Network/Users/<name>`,
///   `/export/home/<name>`, `/usr/home/<name>`, and a Windows profile
///   mounted into WSL, `/mnt/c/Users/<name>`;
/// - WSL shares (`\\wsl$\<distro>\…`, `\\wsl.localhost\<distro>\…`) hold a
///   distribution's POSIX paths and follow the POSIX rules;
/// - any other share follows the drive rules below the share (review P3-a:
///   `\\server\c$\Users\<name>`, `\\server\data\Users\<name>`), and a
///   home-directory share such as `\\server\home$` holds one home per
///   account (`\\server\home$\<name>`).
fn is_conventional_home_parts(
    prefix: &PathPrefix,
    parts: &[String],
    case_insensitive: bool,
) -> bool {
    let eq = component_eq(case_insensitive);
    match prefix {
        PathPrefix::Drive(_) => is_windows_home_parts(parts, &eq),
        PathPrefix::Posix => is_posix_home_parts(parts, &eq),
        PathPrefix::Unc { server, .. } if is_wsl_server(server) => is_posix_home_parts(parts, &eq),
        PathPrefix::Unc { share, .. } => {
            is_windows_home_parts(parts, &eq) || (parts.len() == 1 && is_home_share(share))
        }
    }
}

/// A folder that holds conventional home directories (`C:\Users`, `/home`,
/// `/Users`, `/var/home`, `\\server\c$\Users`, WSL `\\wsl$\<distro>\home`,
/// a home-directory share root, …), under the same prefix rules as
/// [`is_conventional_home_parts`].
fn is_home_container(path: &NormPath, case_insensitive: bool) -> bool {
    let eq = component_eq(case_insensitive);
    let parts = path.parts.as_slice();
    match &path.prefix {
        PathPrefix::Drive(_) => is_windows_home_container_parts(parts, &eq),
        PathPrefix::Posix => is_posix_home_container_parts(parts, &eq),
        PathPrefix::Unc { server, .. } if is_wsl_server(server) => {
            is_posix_home_container_parts(parts, &eq)
        }
        PathPrefix::Unc { share, .. } => {
            is_windows_home_container_parts(parts, &eq)
                || (parts.is_empty() && is_home_share(share))
        }
    }
}

fn component_eq(case_insensitive: bool) -> impl Fn(&str, &str) -> bool {
    move |value, expected| {
        if case_insensitive {
            value.eq_ignore_ascii_case(expected)
        } else {
            value == expected
        }
    }
}

fn is_wsl_server(server: &str) -> bool {
    server == "wsl$" || server == "wsl.localhost"
}

fn is_windows_home_parts(parts: &[String], eq: &dyn Fn(&str, &str) -> bool) -> bool {
    parts.len() == 2 && is_windows_home_container_name(&parts[0], eq)
}

fn is_windows_home_container_parts(parts: &[String], eq: &dyn Fn(&str, &str) -> bool) -> bool {
    parts.len() == 1 && is_windows_home_container_name(&parts[0], eq)
}

fn is_windows_home_container_name(name: &str, eq: &dyn Fn(&str, &str) -> bool) -> bool {
    eq(name, "Users") || eq(name, "Documents and Settings")
}

fn is_posix_home_parts(parts: &[String], eq: &dyn Fn(&str, &str) -> bool) -> bool {
    let is_root_home = parts.len() == 1 && eq(&parts[0], "root");
    is_root_home
        || parts
            .split_last()
            .is_some_and(|(_, container)| is_posix_home_container_parts(container, eq))
}

fn is_posix_home_container_parts(parts: &[String], eq: &dyn Fn(&str, &str) -> bool) -> bool {
    match parts {
        [one] => eq(one, "home") || eq(one, "Users"),
        [first, second] => {
            (eq(first, "var") && eq(second, "home"))
                || (eq(first, "Network") && eq(second, "Users"))
                || ((eq(first, "export") || eq(first, "usr")) && eq(second, "home"))
        }
        // A Windows profile folder mounted into WSL: `/mnt/c/Users`.
        [mnt, drive, users] => eq(mnt, "mnt") && drive.len() == 1 && eq(users, "Users"),
        _ => false,
    }
}

/// Share names conventionally used for per-user home folders (UNC shares
/// are stored in lower case).
fn is_home_share(share: &str) -> bool {
    matches!(
        share.trim_end_matches('$'),
        "home" | "homes" | "users" | "profiles" | "userhome" | "userhomes"
    )
}

/// A repository found by the worktree string rules.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorktreeRepo {
    /// Raw folder name of the repository.
    pub(crate) name: String,
    /// The repository directory when the layout names it; `None` for
    /// `…/.codex/worktrees/<id>/<repo>`, whose checkout lives elsewhere.
    pub(crate) dir: Option<NormPath>,
}

/// Worktree string rules (spec §2.4 step 6), nearest ancestor first:
/// - `…/.codex/worktrees/<id>/<repo>[/…]` → `<repo>`
/// - `…/<repo>/.claude/worktrees/<name>[/…]` → `<repo>`
/// - `…/<repo>/.worktrees/<name>[/…]` → `<repo>`
/// - `…/<repo>-worktrees|.worktrees|_worktrees/<name>[/…]` → sibling `<repo>`
pub(crate) fn worktree_repo(path: &NormPath, case_insensitive: bool) -> Option<WorktreeRepo> {
    let parts = &path.parts;
    let eq = |value: &str, expected: &str| {
        if case_insensitive {
            value.eq_ignore_ascii_case(expected)
        } else {
            value == expected
        }
    };
    let dir_of = |parts: Vec<String>| NormPath {
        prefix: path.prefix.clone(),
        parts,
    };
    // Ancestors only: the last component is the session directory itself.
    for index in (0..parts.len().saturating_sub(1)).rev() {
        let component = parts[index].as_str();
        if eq(component, "worktrees") && index >= 1 {
            let marker = parts[index - 1].as_str();
            if eq(marker, ".codex") {
                if let Some(repo) = parts.get(index + 2) {
                    return Some(WorktreeRepo {
                        name: repo.clone(),
                        dir: None,
                    });
                }
                continue;
            }
            if eq(marker, ".claude") && index >= 2 {
                return Some(WorktreeRepo {
                    name: parts[index - 2].clone(),
                    dir: Some(dir_of(parts[..index - 1].to_vec())),
                });
            }
        }
        if eq(component, ".worktrees") {
            if index >= 1 {
                return Some(WorktreeRepo {
                    name: parts[index - 1].clone(),
                    dir: Some(dir_of(parts[..index].to_vec())),
                });
            }
            continue;
        }
        for suffix in ["-worktrees", ".worktrees", "_worktrees"] {
            if component.len() > suffix.len() {
                let split_at = component.len() - suffix.len();
                if component.is_char_boundary(split_at) && eq(&component[split_at..], suffix) {
                    let name = component[..split_at].to_string();
                    let mut sibling = parts[..index].to_vec();
                    sibling.push(name.clone());
                    return Some(WorktreeRepo {
                        name,
                        dir: Some(dir_of(sibling)),
                    });
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Label sanitization
// ---------------------------------------------------------------------------

/// Spec §2.4 “项目名清洗”: NFC (common compositions, see [`compose_nfc`]),
/// drop control and bidi-override characters, trim and collapse whitespace,
/// replace path separators, truncate to [`LABEL_MAX_GRAPHEMES`] grapheme
/// clusters with `…`; empty, `.` and `..` are invalid.
pub(crate) fn sanitize_label(raw: &str) -> Option<String> {
    let composed = compose_nfc(raw);
    let filtered: String = composed
        .chars()
        .filter(|ch| !is_stripped_char(*ch))
        .map(|ch| if ch == '/' || ch == '\\' { '_' } else { ch })
        .collect();
    let collapsed = filtered.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() || collapsed == "." || collapsed == ".." {
        return None;
    }
    Some(truncate_graphemes(
        &collapsed,
        LABEL_MAX_GRAPHEMES,
        LABEL_MAX_CHARS,
    ))
}

fn is_stripped_char(ch: char) -> bool {
    ch.is_control()
        || matches!(
            ch,
            '\u{061C}'
                | '\u{200B}'
                | '\u{200E}'
                | '\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

/// Characters that attach to the preceding character in a user-perceived
/// character. An approximation of UAX #29 without a Unicode-data dependency
/// (the lockfile is coordinator-owned): combining marks of the common blocks,
/// variation selectors, emoji modifiers and tags, ZWJ, and kana voicing marks.
fn is_grapheme_extender(ch: char) -> bool {
    matches!(
        ch,
        '\u{0300}'..='\u{036F}'
            | '\u{0483}'..='\u{0489}'
            | '\u{0591}'..='\u{05BD}'
            | '\u{0610}'..='\u{061A}'
            | '\u{064B}'..='\u{065F}'
            | '\u{0900}'..='\u{0903}'
            | '\u{093A}'..='\u{094F}'
            | '\u{0E31}'
            | '\u{0E34}'..='\u{0E3A}'
            | '\u{0E47}'..='\u{0E4E}'
            | '\u{1AB0}'..='\u{1AFF}'
            | '\u{1DC0}'..='\u{1DFF}'
            | '\u{200C}'
            | '\u{200D}'
            | '\u{20D0}'..='\u{20FF}'
            | '\u{3099}'
            | '\u{309A}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FE20}'..='\u{FE2F}'
            | '\u{1F3FB}'..='\u{1F3FF}'
            | '\u{E0020}'..='\u{E007F}'
            | '\u{E0100}'..='\u{E01EF}'
    )
}

fn is_regional_indicator(ch: char) -> bool {
    ('\u{1F1E6}'..='\u{1F1FF}').contains(&ch)
}

/// Splits into approximate grapheme clusters (never inside a UTF-8 sequence).
fn grapheme_clusters(value: &str) -> Vec<&str> {
    let mut clusters = Vec::new();
    let mut start: Option<usize> = None;
    let mut previous: Option<char> = None;
    let mut regional_run = 0usize;
    for (index, ch) in value.char_indices() {
        let joins_previous = match previous {
            None => false,
            Some(prev) => {
                is_grapheme_extender(ch)
                    || prev == '\u{200D}'
                    || (is_regional_indicator(ch)
                        && is_regional_indicator(prev)
                        && regional_run % 2 == 1)
            }
        };
        if !joins_previous {
            if let Some(begin) = start {
                clusters.push(&value[begin..index]);
            }
            start = Some(index);
        }
        regional_run = if is_regional_indicator(ch) {
            regional_run + 1
        } else {
            0
        };
        previous = Some(ch);
    }
    if let Some(begin) = start {
        clusters.push(&value[begin..]);
    }
    clusters
}

fn truncate_graphemes(value: &str, max_clusters: usize, max_chars: usize) -> String {
    let clusters = grapheme_clusters(value);
    if clusters.len() <= max_clusters && value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out = String::new();
    let mut chars = 0usize;
    for cluster in clusters.iter().take(max_clusters.saturating_sub(1)) {
        let cluster_chars = cluster.chars().count();
        // Keep one code point for the ellipsis.
        if chars + cluster_chars + 1 > max_chars {
            break;
        }
        out.push_str(cluster);
        chars += cluster_chars;
    }
    let mut out = out.trim_end().to_string();
    out.push('…');
    out
}

// ---------------------------------------------------------------------------
// NFC composition (subset)
// ---------------------------------------------------------------------------

/// Canonical composition for the characters folder names realistically carry:
/// Latin-1 and Latin Extended-A letters, pinyin tone vowels, Japanese kana
/// voicing and Hangul syllables. Adjacent pairs are composed repeatedly (so
/// `u + ¨ + ¯` → `ǖ`). A complete NFC needs Unicode tables from a new crate,
/// which requires a coordinator lockfile change; other scripts pass through
/// unchanged and at worst split one folder into two spellings.
pub(crate) fn compose_nfc(input: &str) -> String {
    let mut out: Vec<char> = Vec::with_capacity(input.len());
    for ch in input.chars() {
        if let Some(last) = out.last_mut() {
            if let Some(composed) = compose_pair(*last, ch) {
                *last = composed;
                continue;
            }
        }
        out.push(ch);
    }
    out.into_iter().collect()
}

const HANGUL_S_BASE: u32 = 0xAC00;
const HANGUL_L_BASE: u32 = 0x1100;
const HANGUL_V_BASE: u32 = 0x1161;
const HANGUL_T_BASE: u32 = 0x11A7;
const HANGUL_L_COUNT: u32 = 19;
const HANGUL_V_COUNT: u32 = 21;
const HANGUL_T_COUNT: u32 = 28;
const HANGUL_N_COUNT: u32 = HANGUL_V_COUNT * HANGUL_T_COUNT;
const HANGUL_S_COUNT: u32 = HANGUL_L_COUNT * HANGUL_N_COUNT;

/// (base, combining mark, composed)
const LATIN_COMPOSITIONS: &[(u32, u32, u32)] = &[
    // Latin-1 Supplement
    (0x41, 0x300, 0xC0),
    (0x41, 0x301, 0xC1),
    (0x41, 0x302, 0xC2),
    (0x41, 0x303, 0xC3),
    (0x41, 0x308, 0xC4),
    (0x41, 0x30A, 0xC5),
    (0x43, 0x327, 0xC7),
    (0x45, 0x300, 0xC8),
    (0x45, 0x301, 0xC9),
    (0x45, 0x302, 0xCA),
    (0x45, 0x308, 0xCB),
    (0x49, 0x300, 0xCC),
    (0x49, 0x301, 0xCD),
    (0x49, 0x302, 0xCE),
    (0x49, 0x308, 0xCF),
    (0x4E, 0x303, 0xD1),
    (0x4F, 0x300, 0xD2),
    (0x4F, 0x301, 0xD3),
    (0x4F, 0x302, 0xD4),
    (0x4F, 0x303, 0xD5),
    (0x4F, 0x308, 0xD6),
    (0x55, 0x300, 0xD9),
    (0x55, 0x301, 0xDA),
    (0x55, 0x302, 0xDB),
    (0x55, 0x308, 0xDC),
    (0x59, 0x301, 0xDD),
    (0x61, 0x300, 0xE0),
    (0x61, 0x301, 0xE1),
    (0x61, 0x302, 0xE2),
    (0x61, 0x303, 0xE3),
    (0x61, 0x308, 0xE4),
    (0x61, 0x30A, 0xE5),
    (0x63, 0x327, 0xE7),
    (0x65, 0x300, 0xE8),
    (0x65, 0x301, 0xE9),
    (0x65, 0x302, 0xEA),
    (0x65, 0x308, 0xEB),
    (0x69, 0x300, 0xEC),
    (0x69, 0x301, 0xED),
    (0x69, 0x302, 0xEE),
    (0x69, 0x308, 0xEF),
    (0x6E, 0x303, 0xF1),
    (0x6F, 0x300, 0xF2),
    (0x6F, 0x301, 0xF3),
    (0x6F, 0x302, 0xF4),
    (0x6F, 0x303, 0xF5),
    (0x6F, 0x308, 0xF6),
    (0x75, 0x300, 0xF9),
    (0x75, 0x301, 0xFA),
    (0x75, 0x302, 0xFB),
    (0x75, 0x308, 0xFC),
    (0x79, 0x301, 0xFD),
    (0x79, 0x308, 0xFF),
    // Latin Extended-A
    (0x41, 0x304, 0x100),
    (0x61, 0x304, 0x101),
    (0x41, 0x306, 0x102),
    (0x61, 0x306, 0x103),
    (0x41, 0x328, 0x104),
    (0x61, 0x328, 0x105),
    (0x43, 0x301, 0x106),
    (0x63, 0x301, 0x107),
    (0x43, 0x302, 0x108),
    (0x63, 0x302, 0x109),
    (0x43, 0x307, 0x10A),
    (0x63, 0x307, 0x10B),
    (0x43, 0x30C, 0x10C),
    (0x63, 0x30C, 0x10D),
    (0x44, 0x30C, 0x10E),
    (0x64, 0x30C, 0x10F),
    (0x45, 0x304, 0x112),
    (0x65, 0x304, 0x113),
    (0x45, 0x306, 0x114),
    (0x65, 0x306, 0x115),
    (0x45, 0x307, 0x116),
    (0x65, 0x307, 0x117),
    (0x45, 0x328, 0x118),
    (0x65, 0x328, 0x119),
    (0x45, 0x30C, 0x11A),
    (0x65, 0x30C, 0x11B),
    (0x47, 0x302, 0x11C),
    (0x67, 0x302, 0x11D),
    (0x47, 0x306, 0x11E),
    (0x67, 0x306, 0x11F),
    (0x47, 0x307, 0x120),
    (0x67, 0x307, 0x121),
    (0x47, 0x327, 0x122),
    (0x67, 0x327, 0x123),
    (0x48, 0x302, 0x124),
    (0x68, 0x302, 0x125),
    (0x49, 0x303, 0x128),
    (0x69, 0x303, 0x129),
    (0x49, 0x304, 0x12A),
    (0x69, 0x304, 0x12B),
    (0x49, 0x306, 0x12C),
    (0x69, 0x306, 0x12D),
    (0x49, 0x328, 0x12E),
    (0x69, 0x328, 0x12F),
    (0x49, 0x307, 0x130),
    (0x4A, 0x302, 0x134),
    (0x6A, 0x302, 0x135),
    (0x4B, 0x327, 0x136),
    (0x6B, 0x327, 0x137),
    (0x4C, 0x301, 0x139),
    (0x6C, 0x301, 0x13A),
    (0x4C, 0x327, 0x13B),
    (0x6C, 0x327, 0x13C),
    (0x4C, 0x30C, 0x13D),
    (0x6C, 0x30C, 0x13E),
    (0x4E, 0x301, 0x143),
    (0x6E, 0x301, 0x144),
    (0x4E, 0x327, 0x145),
    (0x6E, 0x327, 0x146),
    (0x4E, 0x30C, 0x147),
    (0x6E, 0x30C, 0x148),
    (0x4F, 0x304, 0x14C),
    (0x6F, 0x304, 0x14D),
    (0x4F, 0x306, 0x14E),
    (0x6F, 0x306, 0x14F),
    (0x4F, 0x30B, 0x150),
    (0x6F, 0x30B, 0x151),
    (0x52, 0x301, 0x154),
    (0x72, 0x301, 0x155),
    (0x52, 0x327, 0x156),
    (0x72, 0x327, 0x157),
    (0x52, 0x30C, 0x158),
    (0x72, 0x30C, 0x159),
    (0x53, 0x301, 0x15A),
    (0x73, 0x301, 0x15B),
    (0x53, 0x302, 0x15C),
    (0x73, 0x302, 0x15D),
    (0x53, 0x327, 0x15E),
    (0x73, 0x327, 0x15F),
    (0x53, 0x30C, 0x160),
    (0x73, 0x30C, 0x161),
    (0x54, 0x327, 0x162),
    (0x74, 0x327, 0x163),
    (0x54, 0x30C, 0x164),
    (0x74, 0x30C, 0x165),
    (0x55, 0x303, 0x168),
    (0x75, 0x303, 0x169),
    (0x55, 0x304, 0x16A),
    (0x75, 0x304, 0x16B),
    (0x55, 0x306, 0x16C),
    (0x75, 0x306, 0x16D),
    (0x55, 0x30A, 0x16E),
    (0x75, 0x30A, 0x16F),
    (0x55, 0x30B, 0x170),
    (0x75, 0x30B, 0x171),
    (0x55, 0x328, 0x172),
    (0x75, 0x328, 0x173),
    (0x57, 0x302, 0x174),
    (0x77, 0x302, 0x175),
    (0x59, 0x302, 0x176),
    (0x79, 0x302, 0x177),
    (0x59, 0x308, 0x178),
    (0x5A, 0x301, 0x179),
    (0x7A, 0x301, 0x17A),
    (0x5A, 0x307, 0x17B),
    (0x7A, 0x307, 0x17C),
    (0x5A, 0x30C, 0x17D),
    (0x7A, 0x30C, 0x17E),
    // Pinyin tone vowels (Latin Extended-B)
    (0x41, 0x30C, 0x1CD),
    (0x61, 0x30C, 0x1CE),
    (0x49, 0x30C, 0x1CF),
    (0x69, 0x30C, 0x1D0),
    (0x4F, 0x30C, 0x1D1),
    (0x6F, 0x30C, 0x1D2),
    (0x55, 0x30C, 0x1D3),
    (0x75, 0x30C, 0x1D4),
    (0xDC, 0x304, 0x1D5),
    (0xFC, 0x304, 0x1D6),
    (0xDC, 0x301, 0x1D7),
    (0xFC, 0x301, 0x1D8),
    (0xDC, 0x30C, 0x1D9),
    (0xFC, 0x30C, 0x1DA),
    (0xDC, 0x300, 0x1DB),
    (0xFC, 0x300, 0x1DC),
    (0x4E, 0x300, 0x1F8),
    (0x6E, 0x300, 0x1F9),
];

fn compose_pair(first: char, second: char) -> Option<char> {
    let (a, b) = (first as u32, second as u32);
    // Hangul L + V → LV, LV + T → LVT.
    if (HANGUL_L_BASE..HANGUL_L_BASE + HANGUL_L_COUNT).contains(&a)
        && (HANGUL_V_BASE..HANGUL_V_BASE + HANGUL_V_COUNT).contains(&b)
    {
        let l_index = a - HANGUL_L_BASE;
        let v_index = b - HANGUL_V_BASE;
        return char::from_u32(
            HANGUL_S_BASE + (l_index * HANGUL_V_COUNT + v_index) * HANGUL_T_COUNT,
        );
    }
    if (HANGUL_S_BASE..HANGUL_S_BASE + HANGUL_S_COUNT).contains(&a)
        && (a - HANGUL_S_BASE).is_multiple_of(HANGUL_T_COUNT)
        && (HANGUL_T_BASE + 1..HANGUL_T_BASE + HANGUL_T_COUNT).contains(&b)
    {
        return char::from_u32(a + (b - HANGUL_T_BASE));
    }
    match b {
        0x3099 => compose_kana_voiced(a),
        0x309A => compose_kana_semi_voiced(a),
        0x300..=0x36F => LATIN_COMPOSITIONS
            .iter()
            .find(|(base, mark, _)| *base == a && *mark == b)
            .and_then(|(_, _, composed)| char::from_u32(*composed)),
        _ => None,
    }
}

fn compose_kana_voiced(base: u32) -> Option<char> {
    let composed = match base {
        // Hiragana か…ち (every second code point), つ, て, と
        0x304B..=0x3061 if (base - 0x304B).is_multiple_of(2) => base + 1,
        0x3064 | 0x3066 | 0x3068 => base + 1,
        // は ひ ふ へ ほ
        0x306F | 0x3072 | 0x3075 | 0x3078 | 0x307B => base + 1,
        0x3046 => 0x3094,
        0x309D => 0x309E,
        // Katakana カ…チ, ツ, テ, ト
        0x30AB..=0x30C1 if (base - 0x30AB).is_multiple_of(2) => base + 1,
        0x30C4 | 0x30C6 | 0x30C8 => base + 1,
        0x30CF | 0x30D2 | 0x30D5 | 0x30D8 | 0x30DB => base + 1,
        0x30A6 => 0x30F4,
        0x30EF => 0x30F7,
        0x30F0 => 0x30F8,
        0x30F1 => 0x30F9,
        0x30F2 => 0x30FA,
        0x30FD => 0x30FE,
        _ => return None,
    };
    char::from_u32(composed)
}

fn compose_kana_semi_voiced(base: u32) -> Option<char> {
    match base {
        0x306F | 0x3072 | 0x3075 | 0x3078 | 0x307B | 0x30CF | 0x30D2 | 0x30D5 | 0x30D8 | 0x30DB => {
            char::from_u32(base + 2)
        }
        _ => None,
    }
}
