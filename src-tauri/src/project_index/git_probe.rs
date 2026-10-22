//! Optional git probe (T10.155 spec §2.4 step 3; open user question Q2).
//!
//! Off by default: `GIT_PROBE_ENABLED` in the module root is the only switch,
//! and [`NoGitProbe`] never touches the file system. When the switch is on,
//! [`FsGitProbe`] walks up from the session directory looking only at *where*
//! `.git` is. It reads at most two tiny files, each capped at
//! [`MAX_SMALL_FILE_BYTES`]: a `.git` *file* (for its `gitdir:` line) and that
//! gitdir's `commondir`. It never opens anything else inside `.git`
//! (config, HEAD, refs, objects), never runs git or a shell, never goes above
//! the user's home, and skips UNC, WSL, network and removable volumes.

use super::label::{HostEnv, HostStyle, NormPath, PathPrefix, Resolution};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

/// Session directory plus at most 23 ancestors.
pub(crate) const MAX_LEVELS: usize = 24;
pub(crate) const MAX_SMALL_FILE_BYTES: u64 = 4 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitProbeHit {
    /// Raw (unsanitized) folder name; the caller sanitizes it.
    pub(crate) name: String,
    pub(crate) resolution: Resolution,
}

pub(crate) trait GitProbe: Send + Sync {
    fn probe(&self, path: &NormPath, env: &HostEnv) -> Option<GitProbeHit>;
}

/// The default probe: string rules only, no file-system access at all.
pub(crate) struct NoGitProbe;

impl GitProbe for NoGitProbe {
    fn probe(&self, _path: &NormPath, _env: &HostEnv) -> Option<GitProbeHit> {
        None
    }
}

/// Which small files the probe opened. Only the two allowed names can ever be
/// recorded; tests use this to prove nothing else inside `.git` is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SmallFile {
    DotGit,
    CommonDir,
}

#[derive(Default)]
pub(crate) struct FsGitProbe {
    fixed_drives: Mutex<HashMap<char, bool>>,
    reads: Mutex<Vec<SmallFile>>,
}

enum DotGit {
    Missing,
    Directory,
    File(String),
    Unreadable,
}

impl FsGitProbe {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    pub(crate) fn reads(&self) -> Vec<SmallFile> {
        self.reads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn probe_allowed(&self, path: &NormPath, env: &HostEnv) -> bool {
        match (&path.prefix, env.host) {
            (PathPrefix::Drive(letter), HostStyle::Windows) => self.is_fixed_drive(*letter),
            (PathPrefix::Posix, HostStyle::Posix) => !is_remote_mount(path),
            // UNC (network shares, `\\wsl$`) and foreign-style paths.
            _ => false,
        }
    }

    fn is_fixed_drive(&self, letter: char) -> bool {
        let mut cache = self
            .fixed_drives
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *cache
            .entry(letter)
            .or_insert_with(|| drive_is_fixed(letter))
    }

    /// The only function that opens a file. `kind` names which of the two
    /// allowed files this is; the path's file name must match it.
    fn read_small_file(&self, path: &Path, kind: SmallFile) -> Option<String> {
        let expected = match kind {
            SmallFile::DotGit => ".git",
            SmallFile::CommonDir => "commondir",
        };
        if path.file_name().and_then(|name| name.to_str()) != Some(expected) {
            return None;
        }
        self.reads
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(kind);
        let file = fs::File::open(path).ok()?;
        let mut bytes = Vec::new();
        file.take(MAX_SMALL_FILE_BYTES)
            .read_to_end(&mut bytes)
            .ok()?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }

    fn inspect(&self, dir: &Path) -> DotGit {
        let dot_git = dir.join(".git");
        let metadata = match fs::symlink_metadata(&dot_git) {
            Ok(metadata) if metadata.file_type().is_symlink() => match fs::metadata(&dot_git) {
                Ok(target) => target,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return DotGit::Missing
                }
                Err(_) => return DotGit::Unreadable,
            },
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return DotGit::Missing,
            Err(_) => return DotGit::Unreadable,
        };
        if metadata.is_dir() {
            return DotGit::Directory;
        }
        if !metadata.is_file() {
            return DotGit::Unreadable;
        }
        let Some(text) = self.read_small_file(&dot_git, SmallFile::DotGit) else {
            return DotGit::Unreadable;
        };
        text.lines()
            .find_map(|line| line.trim_start_matches('\u{feff}').strip_prefix("gitdir:"))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(DotGit::File)
            .unwrap_or(DotGit::Unreadable)
    }

    fn resolve_git_file(
        &self,
        worktree_dir: &NormPath,
        gitdir_raw: &str,
        env: &HostEnv,
    ) -> Option<GitProbeHit> {
        let gitdir = NormPath::parse(gitdir_raw, env.host)
            .unwrap_or_else(|| worktree_dir.join_relative(gitdir_raw));
        let ci = env.case_insensitive(&gitdir);
        let eq = |value: &str, expected: &str| {
            if ci {
                value.eq_ignore_ascii_case(expected)
            } else {
                value == expected
            }
        };
        let parts = &gitdir.parts;
        if parts.len() >= 2 && eq(&parts[parts.len() - 2], "worktrees") {
            // Linked worktree: `<common>/worktrees/<name>`; the common dir is
            // named by `commondir` (usually `../..`).
            let fallback = || gitdir.parent().and_then(|worktrees| worktrees.parent());
            let common = match gitdir
                .to_host_path(env.host)
                .map(|dir| dir.join("commondir"))
                .and_then(|file| self.read_small_file(&file, SmallFile::CommonDir))
            {
                Some(text) => {
                    let value = text.trim();
                    if value.is_empty() {
                        fallback()?
                    } else {
                        NormPath::parse(value, env.host)
                            .unwrap_or_else(|| gitdir.join_relative(value))
                    }
                }
                None => fallback()?,
            };
            let last = common.last()?;
            let (repo_dir, name) = if eq(last, ".git") {
                let parent = common.parent()?;
                let name = parent.last()?.to_string();
                (parent, name)
            } else {
                // Bare repository: `<name>.git`, or any other folder name.
                let name = strip_git_suffix(last, ci).to_string();
                (common.clone(), name)
            };
            // The home folder's own repository (dotfiles), or one above it:
            // its name is an account or system folder name, not a project.
            if name.is_empty() || env.is_home_or_above(&repo_dir) {
                return None;
            }
            return Some(GitProbeHit {
                name,
                resolution: Resolution::GitWorktree,
            });
        }
        let in_modules = parts.iter().any(|part| eq(part, "modules"))
            && parts.iter().any(|part| eq(part, ".git"));
        let resolution = if in_modules {
            Resolution::GitSubmodule
        } else {
            // `--separate-git-dir`: the working tree is still the repository.
            Resolution::GitRoot
        };
        worktree_dir.last().map(|name| GitProbeHit {
            name: name.to_string(),
            resolution,
        })
    }
}

impl GitProbe for FsGitProbe {
    fn probe(&self, path: &NormPath, env: &HostEnv) -> Option<GitProbeHit> {
        if !self.probe_allowed(path, env) {
            return None;
        }
        let start = path.to_host_path(env.host)?;
        if !fs::metadata(&start)
            .map(|meta| meta.is_dir())
            .unwrap_or(false)
        {
            return None;
        }
        let mut current = path.clone();
        for _ in 0..MAX_LEVELS {
            // Home (this host's or any account's), the folders holding homes
            // and everything above this host's home: never walked past, and a
            // repository there never names a project.
            let at_home = env.is_home_or_above(&current);
            let dir = current.to_host_path(env.host)?;
            match self.inspect(&dir) {
                DotGit::Missing => {}
                // A repository rooted at home is a dotfiles repo: its name is
                // the account name and says nothing about the project.
                DotGit::Directory if at_home => return None,
                DotGit::Directory => {
                    return current.last().map(|name| GitProbeHit {
                        name: name.to_string(),
                        resolution: Resolution::GitRoot,
                    });
                }
                DotGit::File(_) if at_home => return None,
                DotGit::File(gitdir) => return self.resolve_git_file(&current, &gitdir, env),
                // Permission or I/O problems: fall through to string rules.
                DotGit::Unreadable => return None,
            }
            if at_home {
                return None;
            }
            current = current.parent()?;
        }
        None
    }
}

/// `name` without a trailing `.git` (ASCII, compared case-insensitively on
/// case-insensitive paths). Never slices inside a multi-byte character.
fn strip_git_suffix(name: &str, case_insensitive: bool) -> &str {
    const SUFFIX: &str = ".git";
    if name.len() <= SUFFIX.len() {
        return name;
    }
    let split_at = name.len() - SUFFIX.len();
    if !name.is_char_boundary(split_at) {
        return name;
    }
    let (head, tail) = name.split_at(split_at);
    let matches = if case_insensitive {
        tail.eq_ignore_ascii_case(SUFFIX)
    } else {
        tail == SUFFIX
    };
    if matches {
        head
    } else {
        name
    }
}

/// Mount points that are commonly network, removable or virtual file systems.
fn is_remote_mount(path: &NormPath) -> bool {
    matches!(
        path.parts.first().map(String::as_str),
        Some(
            "Volumes"
                | "Network"
                | "net"
                | "mnt"
                | "media"
                | "run"
                | "afs"
                | "proc"
                | "sys"
                | "dev"
                | "smb"
                | "nfs"
                | "cifs"
        )
    )
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetDriveTypeW(root_path_name: *const u16) -> u32;
}

#[cfg(windows)]
fn drive_is_fixed(letter: char) -> bool {
    const DRIVE_FIXED: u32 = 3;
    let root: Vec<u16> = format!("{letter}:\\")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_FIXED }
}

#[cfg(not(windows))]
fn drive_is_fixed(_letter: char) -> bool {
    false
}
