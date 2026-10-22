//! 设置页的本机额度来源检测（REQ-QUOTA-09）。
//!
//! 只复用既有的候选路径发现，看文件是否存在、是否可执行；不启动任何进程、不打开
//! 凭据或登录文件，结果只给设置页用，不进入 envelope、同步或日志。

use serde::Serialize;
use std::path::{Path, PathBuf};

use super::{ANTIGRAVITY_PROVIDER_ID, CLAUDE_PROVIDER_ID, CODEX_PROVIDER_ID};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSourceDetection {
    pub provider_id: &'static str,
    pub installed: bool,
    /// 检测到的可执行文件或应用位置，只用于界面说明。
    pub candidate_paths: Vec<String>,
}

pub(crate) fn detect_local_quota_sources(
    claude_config_dir: Option<&Path>,
) -> Vec<QuotaSourceDetection> {
    let codex = super::resolve_codex_launch_plans()
        .into_iter()
        .map(|plan| {
            plan.prefix_args
                .first()
                .map(PathBuf::from)
                .unwrap_or(plan.program)
        })
        .collect::<Vec<_>>();
    let mut antigravity = super::antigravity::resolve_agy_executables();
    antigravity.extend(
        antigravity_app_candidates(dirs::home_dir().as_deref())
            .into_iter()
            .filter(|path| path.exists()),
    );
    quota_source_detections(
        codex,
        super::claude_cli_candidate_paths(),
        claude_config_dir.is_some_and(Path::is_dir),
        antigravity,
    )
}

/// Claude Code 只要用过就会留下配置目录；即使 CLI 不在候选路径里（例如只装了
/// IDE 插件），status line 来源依然可用。
fn quota_source_detections(
    codex_paths: Vec<PathBuf>,
    claude_cli_paths: Vec<String>,
    claude_config_present: bool,
    antigravity_paths: Vec<PathBuf>,
) -> Vec<QuotaSourceDetection> {
    vec![
        QuotaSourceDetection {
            provider_id: CODEX_PROVIDER_ID,
            installed: !codex_paths.is_empty(),
            candidate_paths: display_paths(codex_paths),
        },
        QuotaSourceDetection {
            provider_id: CLAUDE_PROVIDER_ID,
            installed: claude_config_present || !claude_cli_paths.is_empty(),
            candidate_paths: claude_cli_paths,
        },
        QuotaSourceDetection {
            provider_id: ANTIGRAVITY_PROVIDER_ID,
            installed: !antigravity_paths.is_empty(),
            candidate_paths: display_paths(antigravity_paths),
        },
    ]
}

fn display_paths(paths: Vec<PathBuf>) -> Vec<String> {
    let mut seen = Vec::<String>::new();
    for path in paths {
        let text = path.to_string_lossy().to_string();
        let text = text
            .strip_prefix(super::WINDOWS_EXTENDED_PATH_PREFIX)
            .map(str::to_string)
            .unwrap_or(text);
        if !seen.contains(&text) {
            seen.push(text);
        }
    }
    seen
}

#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn antigravity_app_candidates(_home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/Applications/Antigravity.app"));
        if let Some(home) = _home {
            candidates.push(home.join("Applications/Antigravity.app"));
        }
    }
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        if local_app_data.is_absolute() {
            candidates.push(local_app_data.join("Programs/Antigravity/Antigravity.exe"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    candidates.extend([
        PathBuf::from("/usr/share/antigravity"),
        PathBuf::from("/opt/Antigravity"),
    ]);
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detections_report_each_local_source_once_in_a_stable_order() {
        let detections = quota_source_detections(
            vec![
                PathBuf::from("/opt/bin/codex"),
                PathBuf::from("/opt/bin/codex"),
            ],
            Vec::new(),
            true,
            Vec::new(),
        );
        assert_eq!(
            detections
                .iter()
                .map(|detection| (detection.provider_id, detection.installed))
                .collect::<Vec<_>>(),
            vec![
                (CODEX_PROVIDER_ID, true),
                (CLAUDE_PROVIDER_ID, true),
                (ANTIGRAVITY_PROVIDER_ID, false),
            ]
        );
        assert_eq!(detections[0].candidate_paths, vec!["/opt/bin/codex"]);
        assert!(detections[1].candidate_paths.is_empty());

        let none = quota_source_detections(Vec::new(), Vec::new(), false, Vec::new());
        assert!(none.iter().all(|detection| !detection.installed));
    }

    #[test]
    fn detection_serializes_only_presence_fields() {
        let value = serde_json::to_value(quota_source_detections(
            Vec::new(),
            vec!["/Users/demo/.local/bin/claude".to_string()],
            false,
            Vec::new(),
        ))
        .expect("serialize detections");
        assert_eq!(
            value[1],
            serde_json::json!({
                "providerId": CLAUDE_PROVIDER_ID,
                "installed": true,
                "candidatePaths": ["/Users/demo/.local/bin/claude"],
            })
        );
    }

    /// 生产代码里不得出现启动进程或打开文件的调用，也不得提到凭据文件；新增检测
    /// 只能看路径元数据。
    #[test]
    fn detection_source_never_launches_processes_or_reads_credentials() {
        let source = include_str!("detect.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("production section");
        for forbidden in [
            "Command::new",
            ".spawn(",
            ".output(",
            "read_to_string",
            "fs::read",
            "File::open",
            "auth.json",
            "credentials",
            "keyring",
            "oauth",
        ] {
            assert!(
                !production.contains(forbidden),
                "detection must not use {forbidden}"
            );
        }
    }

    /// 复用的 Codex 候选发现只解析路径：候选脚本一旦被执行就会留下标记文件。
    #[cfg(unix)]
    #[test]
    fn codex_candidate_discovery_does_not_execute_the_candidate() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "tokenledger-detect-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).expect("create bin");
        let marker = root.join("executed");
        let script = bin.join("codex");
        std::fs::write(
            &script,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .expect("write fake codex");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake codex");

        let plans = super::super::resolve_codex_launch_plans_from(None, Some(bin.as_os_str()), &[]);
        assert_eq!(plans.len(), 1);
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(!marker.exists(), "detection must not run the candidate");
        let _ = std::fs::remove_dir_all(&root);
    }
}
