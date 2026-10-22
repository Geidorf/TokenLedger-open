//! L1: pure derivation matrix (spec §2.4) on synthetic Windows, macOS and
//! Linux hosts. Every path here is invented.

use super::Scratch;
use crate::project_index::git_probe::NoGitProbe;
use crate::project_index::label::{
    choose_display_label, derive_project, home_spellings, host_path_variants,
    project_key_for_label, sanitize_label, HostEnv, HostStyle, NormPath, ProjectKind, ProjectRef,
    Resolution, ResolverInput, LABEL_MAX_CHARS, LABEL_MAX_GRAPHEMES,
};
use std::path::{Path, PathBuf};

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn windows() -> HostEnv {
    HostEnv::from_dirs(
        HostStyle::Windows,
        false,
        &strings(&[r"C:\Users\Alice", r"C:\Users\ALICE~1"]),
        &strings(&[r"C:\Users\Alice\AppData\Local\Temp", r"C:\Windows\Temp"]),
        &strings(&[
            r"C:\Users\Alice\AppData\Roaming",
            r"C:\Users\Alice\AppData\Local",
            r"C:\Users\Alice\AppData",
            r"C:\Users\Alice\.multica",
        ]),
    )
}

fn macos() -> HostEnv {
    HostEnv::from_dirs(
        HostStyle::Posix,
        true,
        &strings(&["/Users/alice"]),
        &strings(&["/var/folders/xy/abc123/T", "/tmp", "/var/tmp"]),
        &strings(&["/Users/alice/Library", "/Users/alice/.multica"]),
    )
}

fn linux() -> HostEnv {
    HostEnv::from_dirs(
        HostStyle::Posix,
        false,
        &strings(&["/home/alice"]),
        &strings(&["/tmp", "/var/tmp", "/dev/shm"]),
        &strings(&[
            "/home/alice/.config",
            "/home/alice/.local/share",
            "/home/alice/.local/state",
            "/home/alice/.cache",
            "/home/alice/.multica",
        ]),
    )
}

fn derive(env: &HostEnv, cwd: &str) -> ProjectRef {
    derive_with(env, cwd, None, false)
}

fn derive_with(
    env: &HostEnv,
    cwd: &str,
    repo_root: Option<&str>,
    default_workspace: bool,
) -> ProjectRef {
    derive_project(
        &ResolverInput {
            cwd,
            repo_root,
            default_workspace,
        },
        env,
        &NoGitProbe,
    )
}

#[track_caller]
fn assert_named(project: &ProjectRef, label: &str, resolution: Resolution) {
    assert_eq!(project.kind, ProjectKind::Named, "{project:?}");
    assert_eq!(project.label.as_deref(), Some(label), "{project:?}");
    assert_eq!(project.key, project_key_for_label(label));
    assert_eq!(project.resolution, resolution, "{project:?}");
}

#[track_caller]
fn assert_bucket(project: &ProjectRef, kind: ProjectKind) {
    assert_eq!(project.kind, kind, "{project:?}");
    assert_eq!(project.label, None);
    assert_eq!(project.key, kind.bucket_key());
    assert_eq!(project.resolution, Resolution::Bucket);
}

#[track_caller]
fn assert_invalid(project: &ProjectRef) {
    assert_eq!(project.kind, ProjectKind::Unresolved, "{project:?}");
    assert_eq!(project.label, None);
    assert_eq!(project.key, "@unresolved");
    assert_eq!(project.resolution, Resolution::InvalidPath);
}

#[test]
fn windows_path_forms_normalize_to_the_folder_name() {
    let env = windows();
    for cwd in [
        r"D:\src\TokenLedger",
        r"D:\src\TokenLedger\",
        r"D:\src\TokenLedger\\",
        "d:/src/TokenLedger/",
        r"  D:\src\TokenLedger  ",
        r"\\?\D:\src\TokenLedger",
        r"D:\src\app\..\TokenLedger",
        r"D:\src\.\TokenLedger\.",
        "/d/src/TokenLedger",
        "/cygdrive/d/src/TokenLedger",
        "/mnt/d/src/TokenLedger",
    ] {
        assert_named(&derive(&env, cwd), "TokenLedger", Resolution::Folder);
    }
}

#[test]
fn unc_paths_are_named_but_share_roots_are_roots() {
    let env = windows();
    assert_named(
        &derive(&env, r"\\nas\share\report-2026"),
        "report-2026",
        Resolution::Folder,
    );
    assert_named(
        &derive(&env, r"\\?\UNC\nas\share\report-2026\"),
        "report-2026",
        Resolution::Folder,
    );
    assert_named(
        &derive(&env, "//nas/share/report-2026"),
        "report-2026",
        Resolution::Folder,
    );
    assert_bucket(&derive(&env, r"\\nas\share"), ProjectKind::Root);
    assert_bucket(&derive(&env, r"\\nas\share\"), ProjectKind::Root);
}

#[test]
fn relative_empty_and_drive_relative_values_are_invalid() {
    let env = windows();
    for cwd in [
        "",
        "   ",
        "C:",
        "C:foo",
        r"src\app",
        "app",
        r"\\",
        r"\\server",
    ] {
        assert_invalid(&derive(&env, cwd));
    }
    assert_invalid(&derive(&linux(), "relative/dir"));
    assert_invalid(&derive(&linux(), &format!("/{}", "a".repeat(9000))));
    assert_invalid(&derive(&linux(), "/tmp\0/x"));
}

#[test]
fn windows_fixed_groups() {
    let env = windows();
    assert_bucket(&derive(&env, r"C:\"), ProjectKind::Root);
    assert_bucket(&derive(&env, "D:/"), ProjectKind::Root);
    assert_bucket(&derive(&env, r"C:\Users\Alice"), ProjectKind::Home);
    assert_bucket(&derive(&env, r"c:\users\alice\"), ProjectKind::Home);
    // 8.3 short spelling of the same home.
    assert_bucket(&derive(&env, r"C:\Users\ALICE~1"), ProjectKind::Home);
    // Another account's profile is bucketed too: its name is a user name.
    assert_bucket(&derive(&env, r"C:\Users\Bob"), ProjectKind::Home);
    assert_bucket(
        &derive(&env, r"D:\Documents and Settings\Carol"),
        ProjectKind::Home,
    );
    // A Windows profile seen through MSYS/WSL spellings.
    assert_bucket(&derive(&env, "/c/Users/Bob"), ProjectKind::Home);
    assert_bucket(
        &derive(&env, r"C:\Users\Alice\AppData\Local\Temp\scratch-1"),
        ProjectKind::Temp,
    );
    assert_bucket(&derive(&env, r"C:\Windows\Temp\job"), ProjectKind::Temp);
    assert_bucket(
        &derive(
            &env,
            r"C:\Users\Alice\AppData\Roaming\Claude\local-agent-mode-sessions\abc",
        ),
        ProjectKind::Managed,
    );
    assert_bucket(
        &derive(&env, r"C:\Users\Alice\AppData\LocalLow\tool\ws"),
        ProjectKind::Managed,
    );
    assert_bucket(
        &derive(&env, r"C:\Users\Alice\multica_workspaces_1\task-9"),
        ProjectKind::Managed,
    );
    assert_bucket(
        &derive(&env, r"C:\Users\Alice\.multica\pi-sessions\x"),
        ProjectKind::Managed,
    );
    // Below home but not a managed or temp directory: a normal project.
    assert_named(
        &derive(&env, r"C:\Users\Alice\code\TokenLedger"),
        "TokenLedger",
        Resolution::Folder,
    );
}

#[test]
fn macos_fixed_groups_are_case_insensitive_and_follow_private_links() {
    let env = macos();
    assert_bucket(&derive(&env, "/"), ProjectKind::Root);
    assert_bucket(&derive(&env, "/Users/alice"), ProjectKind::Home);
    assert_bucket(&derive(&env, "/users/ALICE/"), ProjectKind::Home);
    assert_bucket(&derive(&env, "/Users/bob"), ProjectKind::Home);
    assert_bucket(&derive(&env, "/tmp/x"), ProjectKind::Temp);
    assert_bucket(&derive(&env, "/private/tmp/x"), ProjectKind::Temp);
    assert_bucket(
        &derive(&env, "/private/var/folders/xy/abc123/T/tmp.1"),
        ProjectKind::Temp,
    );
    assert_bucket(
        &derive(
            &env,
            "/Users/alice/Library/Application Support/Claude/sessions/x",
        ),
        ProjectKind::Managed,
    );
    assert_named(
        &derive(&env, "/Users/alice/code/TokenLedger/"),
        "TokenLedger",
        Resolution::Folder,
    );
    // NFD file names (macOS) are composed, so both spellings share a key.
    let nfd = derive(&env, "/Users/alice/code/Cafe\u{301}");
    let nfc = derive(&env, "/Users/alice/code/Caf\u{e9}");
    assert_named(&nfd, "Caf\u{e9}", Resolution::Folder);
    assert_eq!(nfd.key, nfc.key);
}

#[test]
fn linux_fixed_groups_are_case_sensitive() {
    let env = linux();
    assert_bucket(&derive(&env, "/home/alice"), ProjectKind::Home);
    assert_bucket(&derive(&env, "/home/alice/"), ProjectKind::Home);
    assert_bucket(&derive(&env, "/home/bob"), ProjectKind::Home);
    assert_bucket(&derive(&env, "/root"), ProjectKind::Home);
    assert_bucket(&derive(&env, "/var/home/dave"), ProjectKind::Home);
    assert_bucket(&derive(&env, "/mnt/c/Users/Bob"), ProjectKind::Home);
    assert_bucket(&derive(&env, "/dev/shm/job"), ProjectKind::Temp);
    assert_bucket(
        &derive(&env, "/home/alice/.config/tool/ws"),
        ProjectKind::Managed,
    );
    assert_bucket(
        &derive(&env, "/home/alice/.local/share/opencode/x"),
        ProjectKind::Managed,
    );
    // Case-sensitive host: `/HOME/carol` is not a home directory…
    assert_named(&derive(&env, "/HOME/carol"), "carol", Resolution::Folder);
    // …but a folder named like this host's account is never stored.
    assert_bucket(&derive(&env, "/HOME/alice"), ProjectKind::Home);
    assert_named(
        &derive(&env, "/home/alice/src/api-server"),
        "api-server",
        Resolution::Folder,
    );
    // WSL homes seen from Windows are bucketed as well.
    assert_bucket(
        &derive(&windows(), r"\\wsl$\Ubuntu\home\bob"),
        ProjectKind::Home,
    );
    assert_bucket(
        &derive(&windows(), r"\\wsl.localhost\Ubuntu\root"),
        ProjectKind::Home,
    );
}

#[test]
fn worktree_string_rules_fold_into_the_repository_name() {
    let env = windows();
    for (cwd, expected) in [
        (
            r"D:\src\TokenLedger-worktrees\T10.150-visual-refresh",
            "TokenLedger",
        ),
        (
            r"D:\src\TokenLedger-worktrees\T10.150-visual-refresh\src",
            "TokenLedger",
        ),
        (r"D:\src\TokenLedger.worktrees\fix", "TokenLedger"),
        (r"D:\src\TokenLedger_worktrees\fix", "TokenLedger"),
        (r"D:\src\TokenLedger\.claude\worktrees\fix-x", "TokenLedger"),
        (r"D:\src\TokenLedger\.worktrees\feature", "TokenLedger"),
        (
            r"C:\Users\Alice\.codex\worktrees\1a2b\TokenLedger",
            "TokenLedger",
        ),
        (
            r"C:\Users\Alice\.codex\worktrees\1a2b\TokenLedger\apps",
            "TokenLedger",
        ),
    ] {
        assert_named(&derive(&env, cwd), expected, Resolution::WorktreeHeuristic);
    }
    // The session directory itself ending in `-worktrees` is not a worktree.
    assert_named(
        &derive(&env, r"D:\src\TokenLedger-worktrees"),
        "TokenLedger-worktrees",
        Resolution::Folder,
    );
    assert_named(
        &derive(&linux(), "/srv/code/TokenLedger/.claude/worktrees/fix-x"),
        "TokenLedger",
        Resolution::WorktreeHeuristic,
    );
}

/// Neither the label nor the key may carry the account name.
#[track_caller]
fn assert_no_account_name(project: &ProjectRef, account: &str) {
    let account = account.to_lowercase();
    if let Some(label) = &project.label {
        assert_ne!(label.to_lowercase(), account, "{project:?}");
    }
    assert_ne!(project.key, format!("n:{account}"), "{project:?}");
}

#[test]
fn p1_home_repositories_never_name_a_project() {
    // Review P1-1: the home folder is itself a repository (dotfiles) and a
    // tool runs in one of its worktrees. The “repository name” would be the
    // account name, so these sessions count as home.
    let win = windows();
    for cwd in [
        r"C:\Users\Alice\.claude\worktrees\fix-x",
        r"C:\Users\Alice\.claude\worktrees\fix-x\src",
        r"c:\users\alice\.worktrees\feature",
        r"C:\Users\ALICE~1\.claude\worktrees\fix-x",
        r"C:\Users\Alice-worktrees\T1",
        r"C:\Users\Alice\.codex\worktrees\1a2b\Alice",
        r"C:\Users\Bob\.claude\worktrees\x",
        r"\\wsl$\Ubuntu\home\bob\.claude\worktrees\x",
        r"C:\Users\.worktrees\x",
    ] {
        let project = derive(&win, cwd);
        assert_bucket(&project, ProjectKind::Home);
        assert_no_account_name(&project, "alice");
        assert_no_account_name(&project, "bob");
    }
    for cwd in [
        "/home/alice/.claude/worktrees/x",
        "/home/alice/.worktrees/x/src",
        "/home/alice-worktrees/x",
        "/home/.worktrees/x",
    ] {
        assert_bucket(&derive(&linux(), cwd), ProjectKind::Home);
    }
    for cwd in [
        "/Users/alice/.worktrees/x",
        "/users/ALICE/.claude/worktrees/x",
    ] {
        assert_bucket(&derive(&macos(), cwd), ProjectKind::Home);
    }
    // Repository roots reported by a source go through the same checks.
    assert_named(
        &derive_with(
            &win,
            r"C:\Users\Alice\notes\x",
            Some(r"C:\Users\Alice"),
            false,
        ),
        "x",
        Resolution::Folder,
    );
    assert_bucket(
        &derive_with(
            &win,
            r"C:\Users\Alice\.claude\worktrees\w1\src",
            Some(r"C:\Users\Alice\.claude\worktrees\w1"),
            false,
        ),
        ProjectKind::Home,
    );
    for root in ["/home/bob", "/home", "/home/alice/.worktrees/w"] {
        let project = derive_with(&linux(), "/srv/x", Some(root), false);
        assert_named(&project, "x", Resolution::Folder);
    }
    // A worktree of an ordinary repository below home still folds.
    assert_named(
        &derive(
            &win,
            r"C:\Users\Alice\code\TokenLedger\.claude\worktrees\fix-x",
        ),
        "TokenLedger",
        Resolution::WorktreeHeuristic,
    );
}

#[test]
fn p1_drive_roots_and_home_ancestors_are_never_projects() {
    let win = windows();
    assert_bucket(&derive(&win, r"C:\"), ProjectKind::Root);
    assert_bucket(&derive(&win, r"C:\Users"), ProjectKind::Home);
    assert_bucket(&derive(&win, r"D:\Users\"), ProjectKind::Home);
    assert_bucket(&derive(&linux(), "/"), ProjectKind::Root);
    assert_bucket(&derive(&linux(), "/home"), ProjectKind::Home);
    assert_bucket(&derive(&macos(), "/Users"), ProjectKind::Home);
    // A repository at a drive root has no name to give.
    assert_named(
        &derive(&win, r"C:\.claude\worktrees\fix"),
        "fix",
        Resolution::Folder,
    );
    assert_named(
        &derive(&win, r"D:\.worktrees\feature"),
        "feature",
        Resolution::Folder,
    );
    for root in [r"D:\", r"C:\Users", r"C:\Users\Alice"] {
        assert_named(
            &derive_with(&win, r"D:\src\app", Some(root), false),
            "app",
            Resolution::Folder,
        );
    }
}

#[test]
fn p1_non_ascii_account_names_are_never_stored() {
    let chinese = HostEnv::from_dirs(
        HostStyle::Windows,
        false,
        &strings(&[r"C:\Users\张三"]),
        &[],
        &[],
    );
    for cwd in [
        r"C:\Users\张三",
        r"C:\Users\张三\.claude\worktrees\修复",
        r"C:\Users\张三-worktrees\x",
        r"C:\Users\张三\.codex\worktrees\9f\张三",
        r"D:\备份\张三",
    ] {
        let project = derive(&chinese, cwd);
        assert_bucket(&project, ProjectKind::Home);
        assert_no_account_name(&project, "张三");
    }
    assert_named(
        &derive(&chinese, r"C:\Users\张三\代码\项目"),
        "项目",
        Resolution::Folder,
    );

    let emoji = HostEnv::from_dirs(
        HostStyle::Posix,
        false,
        &strings(&["/home/🦊fox"]),
        &[],
        &[],
    );
    for cwd in ["/home/🦊fox", "/home/🦊fox/.worktrees/x", "/srv/🦊fox"] {
        let project = derive(&emoji, cwd);
        assert_bucket(&project, ProjectKind::Home);
        assert_no_account_name(&project, "🦊fox");
    }

    // macOS may record either normalization form of the same name.
    let mac = HostEnv::from_dirs(
        HostStyle::Posix,
        true,
        &strings(&["/Users/zo\u{eb}"]),
        &[],
        &[],
    );
    assert_bucket(&derive(&mac, "/Volumes/data/Zoe\u{308}"), ProjectKind::Home);
    assert_bucket(
        &derive(&mac, "/Users/zoe\u{308}/.worktrees/x"),
        ProjectKind::Home,
    );

    // A login name that differs from the profile folder is covered too.
    let login = windows().with_account_names(&strings(&["alice.smith"]));
    assert_bucket(&derive(&login, r"D:\share\Alice.Smith"), ProjectKind::Home);
}

#[test]
fn p3_network_homes_and_cloud_folders() {
    let win = windows();
    // Home-directory shares (review P3-1).
    assert_bucket(&derive(&win, r"\\fs01\home$\jdoe"), ProjectKind::Home);
    assert_bucket(&derive(&win, r"\\fs01\Users\jdoe\"), ProjectKind::Home);
    assert_bucket(&derive(&win, r"\\fs01\home$"), ProjectKind::Root);
    assert_named(
        &derive(&win, r"\\fs01\home$\jdoe\report"),
        "report",
        Resolution::Folder,
    );
    assert_bucket(&derive(&macos(), "/Network/Users/bob"), ProjectKind::Home);
    assert_bucket(&derive(&linux(), "/export/home/bob"), ProjectKind::Home);
    assert_bucket(&derive(&linux(), "/usr/home/bob"), ProjectKind::Home);

    // iCloud Drive and cloud storage under `~/Library` hold user projects
    // (review P3-9); the rest of `~/Library` stays managed.
    let mac = macos().with_unmanaged_dirs(&strings(&[
        "/Users/alice/Library/Mobile Documents",
        "/Users/alice/Library/CloudStorage",
    ]));
    assert_named(
        &derive(
            &mac,
            "/Users/alice/Library/Mobile Documents/com~apple~CloudDocs/Notes",
        ),
        "Notes",
        Resolution::Folder,
    );
    assert_named(
        &derive(
            &mac,
            "/Users/alice/Library/CloudStorage/OneDrive-Personal/Thesis",
        ),
        "Thesis",
        Resolution::Folder,
    );
    assert_bucket(
        &derive(&mac, "/Users/alice/Library/Application Support/Claude/x"),
        ProjectKind::Managed,
    );
}

fn no_vars(_: &str) -> Option<String> {
    None
}

fn identity_variants(dir: &Path) -> Vec<PathBuf> {
    vec![dir.to_path_buf()]
}

/// Windows home variables as a roaming profile would set them.
fn windows_vars(home: &'static str) -> impl Fn(&str) -> Option<String> {
    move |name: &str| match name {
        "HOME" => Some(home.to_string()),
        "HOMESHARE" => Some(r"\\fs01\users$\alice".to_string()),
        // `H:` + `\` is a bare drive root, never a home.
        "HOMEDRIVE" => Some("H:".to_string()),
        "HOMEPATH" => Some(r"\".to_string()),
        _ => None,
    }
}

#[test]
fn p3a_the_physical_path_behind_a_linked_home_is_a_home() {
    // Review P3-a: `/home/alice` is a symlink to `/data/users/alice.home`;
    // tools record the resolved path, and its name is an account name.
    let spellings = home_spellings(
        HostStyle::Posix,
        Path::new("/home/alice"),
        &|_: &str| -> Option<String> { panic!("POSIX hosts read no Windows home variables") },
        &|dir: &Path| vec![dir.to_path_buf(), PathBuf::from("/data/users/alice.home")],
    );
    assert_eq!(
        spellings,
        strings(&["/home/alice", "/data/users/alice.home"])
    );
    let env = HostEnv::from_dirs(HostStyle::Posix, false, &spellings, &[], &[]);
    for cwd in [
        "/data/users/alice.home",
        "/data/users/alice.home/.worktrees/x",
        "/data/users/alice.home/.claude/worktrees/fix/src",
        "/data/users/alice.home-worktrees/x",
        "/srv/copies/alice.home",
    ] {
        let project = derive(&env, cwd);
        assert_bucket(&project, ProjectKind::Home);
        assert_no_account_name(&project, "alice.home");
    }
    assert_named(
        &derive(&env, "/data/users/alice.home/src/api"),
        "api",
        Resolution::Folder,
    );

    // Windows: a junctioned profile; `canonicalize` returns a verbatim path.
    let spellings = home_spellings(
        HostStyle::Windows,
        Path::new(r"C:\Users\Alice"),
        &no_vars,
        &|dir: &Path| {
            vec![
                dir.to_path_buf(),
                PathBuf::from(r"\\?\D:\Profiles\Alice.Home"),
            ]
        },
    );
    let env = HostEnv::from_dirs(HostStyle::Windows, false, &spellings, &[], &[]);
    for cwd in [
        r"D:\Profiles\Alice.Home",
        r"d:\profiles\alice.home\.claude\worktrees\x",
        r"E:\copies\ALICE.HOME",
    ] {
        assert_bucket(&derive(&env, cwd), ProjectKind::Home);
    }
    assert_named(
        &derive(&env, r"D:\Profiles\Alice.Home\code\app"),
        "app",
        Resolution::Folder,
    );
}

/// A directory link as a user would create one: a junction on Windows
/// (no privilege needed, unlike a symlink), a symlink elsewhere.
#[cfg(windows)]
fn link_dir(target: &Path, link: &Path) -> bool {
    std::process::Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(unix)]
fn link_dir(target: &Path, link: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

#[test]
fn p3a_a_real_linked_home_is_resolved_on_this_host() {
    let scratch = Scratch::new("label_linked_home");
    let physical = scratch.join("physical").join("alice.home");
    std::fs::create_dir_all(&physical).expect("physical home");
    let link = scratch.join("home-link");
    assert!(link_dir(&physical, &link), "create the directory link");
    let host = if cfg!(windows) {
        HostStyle::Windows
    } else {
        HostStyle::Posix
    };
    let spellings = home_spellings(host, &link, &no_vars, &host_path_variants);
    let env = HostEnv::from_dirs(host, cfg!(target_os = "macos"), &spellings, &[], &[]);
    // What `getcwd` reports inside the linked home.
    let resolved = std::fs::canonicalize(&physical).expect("resolve the physical home");
    let resolved_path =
        NormPath::parse(&resolved.to_string_lossy(), host).expect("parse the physical home");
    assert!(
        env.homes.contains(&resolved_path),
        "the physical path is a home spelling"
    );
    assert_bucket(
        &derive(&env, &resolved.to_string_lossy()),
        ProjectKind::Home,
    );
    // Worktree layouts nearest to the session win, so wherever the scratch
    // directory lives, only the linked home decides these two.
    let worktree = resolved.join(".claude").join("worktrees").join("fix");
    assert_bucket(
        &derive(&env, &worktree.to_string_lossy()),
        ProjectKind::Home,
    );
    let nested = resolved
        .join("code")
        .join("app")
        .join(".worktrees")
        .join("feature");
    assert_named(
        &derive(&env, &nested.to_string_lossy()),
        "app",
        Resolution::WorktreeHeuristic,
    );
}

#[test]
fn p3a_windows_home_variables_are_homes() {
    // Review P3-a: `%HOME%` may differ from `%USERPROFILE%`.
    let spellings = home_spellings(
        HostStyle::Windows,
        Path::new(r"C:\Users\Alice"),
        &windows_vars(r"D:\alice-home"),
        &identity_variants,
    );
    assert_eq!(
        spellings,
        strings(&[r"C:\Users\Alice", r"D:\alice-home", r"\\fs01\users$\alice"])
    );
    let env = HostEnv::from_dirs(HostStyle::Windows, false, &spellings, &[], &[]);
    for cwd in [
        r"D:\alice-home",
        r"D:\alice-home\.claude\worktrees\x",
        r"d:\ALICE-HOME\.worktrees\y\src",
        r"E:\backup\alice-home",
        r"\\fs01\users$\alice\.worktrees\z",
    ] {
        let project = derive(&env, cwd);
        assert_bucket(&project, ProjectKind::Home);
        assert_no_account_name(&project, "alice-home");
    }
    assert_named(
        &derive(&env, r"D:\alice-home\code\app"),
        "app",
        Resolution::Folder,
    );

    // The Git Bash spelling of the profile adds no new home; a drive root is
    // never one, so other folders on that drive keep their names.
    let spellings = home_spellings(
        HostStyle::Windows,
        Path::new(r"C:\Users\Alice"),
        &windows_vars("/c/Users/Alice"),
        &identity_variants,
    );
    let env = HostEnv::from_dirs(HostStyle::Windows, false, &spellings, &[], &[]);
    assert_eq!(env.homes.len(), 2, "{:?}", env.homes);
    let spellings = home_spellings(
        HostStyle::Windows,
        Path::new(r"C:\Users\Alice"),
        &windows_vars(r"D:\"),
        &identity_variants,
    );
    assert_eq!(
        spellings,
        strings(&[r"C:\Users\Alice", r"\\fs01\users$\alice"])
    );
    let env = HostEnv::from_dirs(HostStyle::Windows, false, &spellings, &[], &[]);
    assert_named(&derive(&env, r"D:\proj"), "proj", Resolution::Folder);
    assert_named(&derive(&env, r"H:\proj"), "proj", Resolution::Folder);
}

#[test]
fn p3a_admin_and_other_shares_follow_the_drive_rules() {
    // Review P3-a: `\\<server>\<any share>\Users\<name>` is a home, like
    // `C:\Users\<name>`; WSL shares follow the POSIX rules.
    let win = windows();
    for cwd in [
        r"\\srv\c$\Users\bob",
        r"\\srv\C$\users\BOB\",
        r"\\?\UNC\srv\d$\Users\bob",
        r"\\srv\data\Users\bob",
        r"\\srv\c$\Documents and Settings\bob",
        r"\\srv\c$\Users",
        r"\\srv\c$\Users\bob\.claude\worktrees\x",
        r"\\srv\c$\Users\bob\.codex\worktrees\1a2b\bob",
        r"\\wsl$\Ubuntu\mnt\c\Users\bob",
        r"\\wsl.localhost\Debian\var\home\bob",
    ] {
        let project = derive(&win, cwd);
        assert_bucket(&project, ProjectKind::Home);
        assert_no_account_name(&project, "bob");
    }
    assert_named(
        &derive(&win, r"\\srv\c$\Users\bob\src\api"),
        "api",
        Resolution::Folder,
    );
    // Only `Users` right below the share root holds homes.
    assert_named(
        &derive(&win, r"\\srv\projects\home\website"),
        "website",
        Resolution::Folder,
    );
    assert_named(
        &derive(&win, r"\\srv\projects\team\Users\x"),
        "x",
        Resolution::Folder,
    );
    // A repository root reported on such a share is discarded.
    assert_named(
        &derive_with(&win, r"D:\src\x", Some(r"\\srv\c$\Users\bob"), false),
        "x",
        Resolution::Folder,
    );
}

#[test]
fn p3a_other_accounts_names_are_never_stored() {
    // Review P3-a: the home repository of another account seen through
    // `.codex/worktrees/<id>/<repo>` (no repository directory to check).
    let win = windows();
    for cwd in [
        r"C:\Users\Bob\.codex\worktrees\1a2b\Bob",
        r"C:\Users\Bob\.codex\worktrees\1a2b\bob\src",
        r"C:\Users\Bob\projects\Bob",
        r"\\fs01\home$\jdoe\.codex\worktrees\7\JDoe",
    ] {
        let project = derive(&win, cwd);
        assert_bucket(&project, ProjectKind::Home);
        assert_no_account_name(&project, "bob");
        assert_no_account_name(&project, "jdoe");
    }
    for cwd in [
        "/home/bob/.codex/worktrees/9f/bob",
        "/home/bob/.codex/worktrees/9f/bob/src",
        "/root/.codex/worktrees/1/root",
    ] {
        assert_bucket(&derive(&linux(), cwd), ProjectKind::Home);
    }
    assert_bucket(
        &derive(&macos(), "/Users/Carol/.codex/worktrees/1/CAROL"),
        ProjectKind::Home,
    );
    // That account's other repositories keep their names.
    assert_named(
        &derive(&win, r"C:\Users\Bob\.codex\worktrees\1a2b\TokenLedger"),
        "TokenLedger",
        Resolution::WorktreeHeuristic,
    );
    assert_named(
        &derive(&linux(), "/home/bob/src/bobsled"),
        "bobsled",
        Resolution::Folder,
    );
    // A reported repository root named like that account is discarded; the
    // session keeps its own folder name.
    assert_named(
        &derive_with(
            &win,
            r"D:\work\x",
            Some(r"C:\Users\Bob\.codex\worktrees\1a2b\Bob"),
            false,
        ),
        "x",
        Resolution::Folder,
    );
}

#[test]
fn source_repository_root_wins_over_folder_and_managed_rules() {
    let env = windows();
    assert_named(
        &derive_with(
            &env,
            r"D:\src\TokenLedger\apps\android",
            Some(r"D:\src\TokenLedger"),
            false,
        ),
        "TokenLedger",
        Resolution::SourceGitRoot,
    );
    // Worktree roots reported by the source fold like session paths.
    assert_named(
        &derive_with(
            &env,
            r"D:\src\TokenLedger-worktrees\T1\src",
            Some(r"D:\src\TokenLedger-worktrees\T1"),
            false,
        ),
        "TokenLedger",
        Resolution::SourceGitRoot,
    );
    // `/` (OpenCode global projects), home and temp roots are ignored.
    assert_named(
        &derive_with(&linux(), "/srv/notes", Some("/"), false),
        "notes",
        Resolution::Folder,
    );
    assert_named(
        &derive_with(&linux(), "/home/alice/notes", Some("/home/alice"), false),
        "notes",
        Resolution::Folder,
    );
    assert_named(
        &derive_with(&linux(), "/srv/x", Some("/tmp/repo"), false),
        "x",
        Resolution::Folder,
    );
    // A repository inside app data still names the project.
    assert_named(
        &derive_with(
            &env,
            r"C:\Users\Alice\AppData\Roaming\Codex\worktrees\9\app",
            Some(r"C:\Users\Alice\AppData\Roaming\Codex\worktrees\9\app"),
            false,
        ),
        "app",
        Resolution::SourceGitRoot,
    );
    // Default workspaces are managed; fixed groups still win over them.
    assert_bucket(
        &derive_with(&linux(), "/srv/minimax-default", None, true),
        ProjectKind::Managed,
    );
    assert_bucket(
        &derive_with(&linux(), "/home/alice", None, true),
        ProjectKind::Home,
    );
}

#[test]
fn labels_are_sanitized() {
    assert_eq!(
        sanitize_label("Tok\u{7}en\u{202E}Led\u{2066}ger\u{200B}").as_deref(),
        Some("TokenLedger")
    );
    assert_eq!(
        sanitize_label("  My \t  Project  ").as_deref(),
        Some("My Project")
    );
    assert_eq!(sanitize_label("a/b\\c").as_deref(), Some("a_b_c"));
    assert_eq!(sanitize_label("\u{feff}proj").as_deref(), Some("proj"));
    for invalid in ["", "   ", ".", "..", "\u{202E}", "\u{7}\u{8}"] {
        assert_eq!(sanitize_label(invalid), None, "{invalid:?}");
    }
    // Pinyin tone marks, kana voicing and Hangul jamo compose.
    assert_eq!(
        sanitize_label("xu\u{308}\u{304}").as_deref(),
        Some("x\u{1d6}")
    );
    assert_eq!(
        sanitize_label("\u{304b}\u{3099}").as_deref(),
        Some("\u{304c}")
    );
    assert_eq!(
        sanitize_label("\u{1100}\u{1161}\u{11a8}").as_deref(),
        Some("\u{ac01}")
    );
    // Lossy non-UTF-8 input keeps its replacement character, never panics.
    let lossy = String::from_utf8_lossy(b"proj\xff\xfename").into_owned();
    let label = sanitize_label(&lossy).expect("lossy label");
    assert!(label.starts_with("proj") && label.ends_with("name"));
}

#[test]
fn labels_truncate_by_grapheme_cluster() {
    let long = "x".repeat(70);
    let label = sanitize_label(&long).expect("label");
    assert_eq!(label.chars().count(), LABEL_MAX_GRAPHEMES);
    assert!(label.ends_with('…'));
    assert_eq!(
        label.trim_end_matches('…'),
        "x".repeat(LABEL_MAX_GRAPHEMES - 1)
    );

    // Decomposed accents are one cluster each and are composed first.
    let accents = "e\u{301}".repeat(70);
    let label = sanitize_label(&accents).expect("label");
    assert_eq!(label.chars().count(), LABEL_MAX_GRAPHEMES);

    // Clusters are never split, and stacked clusters respect the char cap.
    let family = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}".repeat(70);
    let label = sanitize_label(&family).expect("label");
    assert!(label.chars().count() <= LABEL_MAX_CHARS);
    assert!(label.ends_with('…'));
    assert_eq!((label.chars().count() - 1) % 5, 0);

    let flags = "\u{1f1e8}\u{1f1f3}".repeat(70);
    let label = sanitize_label(&flags).expect("label");
    assert_eq!((label.chars().count() - 1) % 2, 0);

    // Exactly at the limit: unchanged.
    let exact = "y".repeat(LABEL_MAX_GRAPHEMES);
    assert_eq!(sanitize_label(&exact).as_deref(), Some(exact.as_str()));
}

#[test]
fn keys_fold_case_and_display_label_prefers_the_majority() {
    assert_eq!(project_key_for_label("TokenLedger"), "n:tokenledger");
    assert_eq!(project_key_for_label("ÄPFEL"), "n:äpfel");
    let a = ProjectRef::named("TokenLedger", Resolution::Folder).expect("named");
    let b = ProjectRef::named("tokenledger", Resolution::Folder).expect("named");
    assert_eq!(a.key, b.key);
    assert_eq!(
        choose_display_label([("TokenLedger", 3), ("tokenledger", 5)]),
        Some("tokenledger")
    );
    assert_eq!(choose_display_label([("b", 2), ("B", 2)]), Some("B"));
    assert_eq!(choose_display_label(std::iter::empty()), None);
}

#[test]
fn normalization_is_lexical_only() {
    let parsed = NormPath::parse(r"\\?\C:\a\b\..\c", HostStyle::Windows).expect("parse");
    assert_eq!(parsed.parts, vec!["a".to_string(), "c".to_string()]);
    // `..` above the root stays at the root.
    let root = NormPath::parse("/../..", HostStyle::Posix).expect("parse");
    assert!(root.is_root());
    // MSYS drive forms only on Windows hosts.
    let posix = NormPath::parse("/c/src", HostStyle::Posix).expect("parse");
    assert_eq!(posix.parts, vec!["c".to_string(), "src".to_string()]);
}

#[test]
fn stored_values_never_contain_separators() {
    let env = windows();
    for cwd in [
        r"D:\src\a\b",
        r"\\nas\share\x",
        "/d/weird:name",
        r"C:\Users\Alice\code\with space",
    ] {
        let project = derive(&env, cwd);
        if let Some(label) = &project.label {
            assert!(!label.contains('/') && !label.contains('\\'), "{label}");
        }
        assert!(!project.key.contains('/') && !project.key.contains('\\'));
    }
}
