//! L2: the optional git probe on hand-built `.git` layouts (no git binary).
//! The probe is off in production until user question Q2 is answered; these
//! tests exercise `FsGitProbe` directly so the switch can be flipped safely.

use super::{write_file, Scratch};
use crate::project_index::git_probe::{FsGitProbe, NoGitProbe, SmallFile, MAX_LEVELS};
use crate::project_index::label::{
    derive_project, HostEnv, HostStyle, ProjectKind, ProjectRef, Resolution, ResolverInput,
};
use crate::project_index::GIT_PROBE_ENABLED;
use std::fs;

fn host_env(home: &Scratch) -> HostEnv {
    let host = if cfg!(windows) {
        HostStyle::Windows
    } else {
        HostStyle::Posix
    };
    HostEnv::from_dirs(
        host,
        cfg!(target_os = "macos"),
        &[home.path().to_string_lossy().into_owned()],
        &[],
        &[],
    )
}

fn probe(scratch: &Scratch, relative: &str, git: &FsGitProbe) -> ProjectRef {
    let cwd = scratch.raw(relative);
    fs::create_dir_all(scratch.join(relative)).expect("create session dir");
    derive_project(
        &ResolverInput {
            cwd: &cwd,
            repo_root: None,
            default_workspace: false,
        },
        &host_env(scratch),
        git,
    )
}

fn gitdir_line(scratch: &Scratch, relative: &str) -> String {
    format!("gitdir: {}\n", scratch.raw(relative))
}

#[test]
fn the_git_probe_is_off_by_default() {
    // Q2 is open: production resolves with string rules only.
    assert!(!std::hint::black_box(GIT_PROBE_ENABLED));
    let scratch = Scratch::new("git_off");
    fs::create_dir_all(scratch.join("repo/.git")).expect("git dir");
    let cwd = scratch.raw("repo/sub");
    fs::create_dir_all(scratch.join("repo/sub")).expect("sub");
    let project = derive_project(
        &ResolverInput {
            cwd: &cwd,
            repo_root: None,
            default_workspace: false,
        },
        &host_env(&scratch),
        &NoGitProbe,
    );
    assert_eq!(project.label.as_deref(), Some("sub"));
    assert_eq!(project.resolution, Resolution::Folder);
}

#[test]
fn git_directory_names_the_repository_without_reading_files() {
    let scratch = Scratch::new("git_dir");
    write_file(
        &scratch.join("repo/.git/config"),
        "[remote \"origin\"]\n\turl = https://example.invalid/CANARY_GIT_REMOTE.git\n",
    );
    write_file(
        &scratch.join("repo/.git/HEAD"),
        "ref: refs/heads/CANARY_GIT_BRANCH\n",
    );
    let git = FsGitProbe::new();
    let project = probe(&scratch, "repo/apps/android", &git);
    assert_eq!(project.label.as_deref(), Some("repo"));
    assert_eq!(project.resolution, Resolution::GitRoot);
    assert!(
        git.reads().is_empty(),
        "a .git directory needs no file read"
    );
}

#[test]
fn linked_worktree_uses_commondir() {
    let scratch = Scratch::new("git_worktree");
    write_file(
        &scratch.join("main/.git/worktrees/wt1/commondir"),
        "../..\n",
    );
    write_file(&scratch.join("main/.git/config"), "CANARY_GIT_REMOTE\n");
    write_file(
        &scratch.join("wts/wt1/.git"),
        gitdir_line(&scratch, "main/.git/worktrees/wt1"),
    );
    let git = FsGitProbe::new();
    let project = probe(&scratch, "wts/wt1/src", &git);
    assert_eq!(project.label.as_deref(), Some("main"));
    assert_eq!(project.resolution, Resolution::GitWorktree);
    assert_eq!(git.reads(), vec![SmallFile::DotGit, SmallFile::CommonDir]);
}

#[test]
fn linked_worktree_without_commondir_falls_back_to_the_gitdir_parent() {
    let scratch = Scratch::new("git_worktree_nocommon");
    fs::create_dir_all(scratch.join("main/.git/worktrees/wt1")).expect("worktree dir");
    write_file(
        &scratch.join("wts/wt1/.git"),
        gitdir_line(&scratch, "main/.git/worktrees/wt1"),
    );
    let git = FsGitProbe::new();
    let project = probe(&scratch, "wts/wt1", &git);
    assert_eq!(project.label.as_deref(), Some("main"));
    assert_eq!(project.resolution, Resolution::GitWorktree);
}

#[test]
fn bare_repository_worktree_strips_the_git_suffix() {
    let scratch = Scratch::new("git_bare");
    write_file(&scratch.join("bare.git/worktrees/wt2/commondir"), "../..\n");
    write_file(
        &scratch.join("wt2/.git"),
        gitdir_line(&scratch, "bare.git/worktrees/wt2"),
    );
    let git = FsGitProbe::new();
    let project = probe(&scratch, "wt2", &git);
    assert_eq!(project.label.as_deref(), Some("bare"));
    assert_eq!(project.resolution, Resolution::GitWorktree);
}

#[test]
fn submodule_keeps_its_own_name() {
    let scratch = Scratch::new("git_submodule");
    fs::create_dir_all(scratch.join("super/.git/modules/sub")).expect("modules dir");
    write_file(
        &scratch.join("super/sub/.git"),
        "gitdir: ../.git/modules/sub\n",
    );
    let git = FsGitProbe::new();
    let project = probe(&scratch, "super/sub", &git);
    assert_eq!(project.label.as_deref(), Some("sub"));
    assert_eq!(project.resolution, Resolution::GitSubmodule);
    assert_eq!(git.reads(), vec![SmallFile::DotGit]);
}

#[test]
fn nested_repository_wins_over_the_outer_one() {
    let scratch = Scratch::new("git_nested");
    fs::create_dir_all(scratch.join("outer/.git")).expect("outer");
    fs::create_dir_all(scratch.join("outer/inner/.git")).expect("inner");
    let git = FsGitProbe::new();
    let project = probe(&scratch, "outer/inner/x", &git);
    assert_eq!(project.label.as_deref(), Some("inner"));
}

#[test]
fn dotfiles_repository_at_home_is_ignored() {
    let scratch = Scratch::new("git_dotfiles");
    // The scratch root is the synthetic home and itself a repository.
    fs::create_dir_all(scratch.join(".git")).expect("home repo");
    let git = FsGitProbe::new();
    let project = probe(&scratch, "notes", &git);
    assert_eq!(project.label.as_deref(), Some("notes"));
    assert_eq!(project.resolution, Resolution::Folder);
}

/// A linked worktree whose common git directory is `<scratch>/<repo>`.
fn linked_worktree(scratch: &Scratch, repo: &str, checkout: &str) {
    let admin = format!("{repo}/worktrees/wt");
    fs::create_dir_all(scratch.join(&admin)).expect("worktree admin dir");
    write_file(&scratch.join(format!("{admin}/commondir")), "../..\n");
    write_file(
        &scratch.join(format!("{checkout}/.git")),
        gitdir_line(scratch, &admin),
    );
}

#[test]
fn non_ascii_repository_names_never_panic() {
    // Review P2-2: bare repositories named with multi-byte characters and no
    // `.git` suffix used to slice inside a character and panic.
    let scratch = Scratch::new("git_non_ascii");
    let git = FsGitProbe::new();
    // The suffix is compared case-insensitively where paths are.
    let upper_suffix = if cfg!(any(windows, target_os = "macos")) {
        "数据"
    } else {
        "数据.GIT"
    };
    for (repo, checkout, expected) in [
        ("项目", "checkout-a", "项目"),
        ("🚀应用.git", "checkout-b", "🚀应用"),
        ("数据.GIT", "checkout-c", upper_suffix),
        ("ab", "checkout-d", "ab"),
        ("é.git", "checkout-e", "é"),
    ] {
        linked_worktree(&scratch, repo, checkout);
        let project = probe(&scratch, &format!("{checkout}/src"), &git);
        assert_eq!(project.label.as_deref(), Some(expected), "{repo}");
        assert_eq!(project.resolution, Resolution::GitWorktree);
    }
    // Plain repositories and nested session folders with CJK and emoji.
    fs::create_dir_all(scratch.join("代码库/.git")).expect("repo");
    let project = probe(&scratch, "代码库/子目录/😀", &git);
    assert_eq!(project.label.as_deref(), Some("代码库"));
    assert_eq!(project.resolution, Resolution::GitRoot);
}

#[test]
fn linked_worktree_of_the_home_repository_is_discarded() {
    // Review P1-1 / P2-2: the synthetic home is a dotfiles repository and a
    // tool works in one of its linked worktrees. The common directory's
    // parent is home, so the probe yields nothing and the string rules
    // bucket the session as home; a plain worktree folder keeps its own name.
    let scratch = Scratch::new("git_home_worktree");
    let home_name = scratch
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .expect("scratch name")
        .to_string();
    fs::create_dir_all(scratch.join(".git/worktrees/fix")).expect("home repo");
    write_file(&scratch.join(".git/worktrees/fix/commondir"), "../..\n");
    write_file(
        &scratch.join(".claude/worktrees/fix/.git"),
        gitdir_line(&scratch, ".git/worktrees/fix"),
    );
    write_file(
        &scratch.join("wt/fix/.git"),
        gitdir_line(&scratch, ".git/worktrees/fix"),
    );
    let git = FsGitProbe::new();
    let project = probe(&scratch, ".claude/worktrees/fix/src", &git);
    assert_eq!(project.kind, ProjectKind::Home);
    let project = probe(&scratch, "wt/fix", &git);
    assert_eq!(project.label.as_deref(), Some("fix"));
    assert_eq!(project.resolution, Resolution::Folder);
    for relative in [".claude/worktrees/fix/src", "wt/fix"] {
        let project = probe(&scratch, relative, &git);
        assert_ne!(
            project.label.as_deref().map(str::to_lowercase),
            Some(home_name.to_lowercase())
        );
    }
}

#[test]
fn probe_stops_after_the_level_limit() {
    let scratch = Scratch::new("git_levels");
    fs::create_dir_all(scratch.join("repo/.git")).expect("repo");
    let deep: Vec<String> = (1..=MAX_LEVELS + 2)
        .map(|level| format!("l{level}"))
        .collect();
    let relative = format!("repo/{}", deep.join("/"));
    let git = FsGitProbe::new();
    let project = probe(&scratch, &relative, &git);
    assert_eq!(project.resolution, Resolution::Folder);
    assert_eq!(
        project.label.as_deref(),
        Some(format!("l{}", MAX_LEVELS + 2).as_str())
    );
    // Exactly at the limit the repository is still found.
    let within: Vec<String> = (1..MAX_LEVELS).map(|level| format!("m{level}")).collect();
    let project = probe(&scratch, &format!("repo/{}", within.join("/")), &git);
    assert_eq!(project.resolution, Resolution::GitRoot);
}

#[test]
fn unusable_git_files_fall_back_to_string_rules() {
    let scratch = Scratch::new("git_unusable");
    write_file(&scratch.join("a/.git"), "not a gitdir line\n");
    // The gitdir line sits past the 4 KiB read cap.
    write_file(
        &scratch.join("b/.git"),
        format!(
            "{}\ngitdir: /elsewhere/.git/worktrees/x\n",
            "#".repeat(5000)
        ),
    );
    let git = FsGitProbe::new();
    assert_eq!(probe(&scratch, "a", &git).resolution, Resolution::Folder);
    assert_eq!(probe(&scratch, "b", &git).resolution, Resolution::Folder);
    assert!(git
        .reads()
        .iter()
        .all(|read| matches!(read, SmallFile::DotGit | SmallFile::CommonDir)));
}

#[test]
fn network_and_foreign_paths_are_never_probed() {
    let scratch = Scratch::new("git_network");
    let git = FsGitProbe::new();
    let env = host_env(&scratch);
    for cwd in [
        r"\\nas\share\report",
        "//nas/share/report",
        "/Volumes/usb/report",
    ] {
        let project = derive_project(
            &ResolverInput {
                cwd,
                repo_root: None,
                default_workspace: false,
            },
            &env,
            &git,
        );
        assert_eq!(project.kind, ProjectKind::Named);
        assert_eq!(project.label.as_deref(), Some("report"));
    }
    assert!(git.reads().is_empty());
}
