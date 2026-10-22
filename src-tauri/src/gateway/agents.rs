//! Agent registry for the config writer (T10.269, T10.291). Each Agent lives
//! in its own module and only knows where its files are and which keys to set.

use std::path::{Path, PathBuf};

mod claude_code;
mod crush;
mod gemini_cli;
mod goose;
mod hermes;
mod kimi;
mod minimax_code;
mod oh_my_opencode;
mod omp;
mod opencode;
mod pi;
pub(crate) mod yaml;
mod zed;

use super::agent_config::AgentConfig;

pub fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "找不到用户主目录。".to_string())
}

/// An absolute directory from `var`, else `fallback`.
pub fn env_dir(
    var: &str,
    fallback: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    match std::env::var_os(var) {
        Some(value) if !value.is_empty() => {
            let dir = PathBuf::from(value);
            if dir.is_absolute() {
                Ok(dir)
            } else {
                Err(format!("{var} 不是绝对路径，无法确定配置位置。"))
            }
        }
        _ => fallback(),
    }
}

/// `$XDG_CONFIG_HOME`, else `~/.config` (also on macOS and Windows, which is
/// where these CLIs look).
pub fn config_home() -> Result<PathBuf, String> {
    env_dir("XDG_CONFIG_HOME", || Ok(home()?.join(".config")))
}

/// Crush keeps its global config under `%LOCALAPPDATA%` on Windows.
fn crush_dir() -> Result<PathBuf, String> {
    if cfg!(windows) && std::env::var_os("XDG_CONFIG_HOME").is_none() {
        return dirs::data_local_dir()
            .map(|dir| dir.join("crush"))
            .ok_or_else(|| "找不到 %LOCALAPPDATA%。".to_string());
    }
    Ok(config_home()?.join("crush"))
}

/// Zed's `paths::config_dir`: `%APPDATA%\Zed` on Windows, always
/// `~/.config/zed` on macOS, and `$FLATPAK_XDG_CONFIG_HOME` or the XDG config
/// home plus `zed` on Linux.
fn zed_dir() -> Result<PathBuf, String> {
    if cfg!(windows) {
        return dirs::config_dir()
            .map(|dir| dir.join("Zed"))
            .ok_or_else(|| "找不到 %APPDATA%。".to_string());
    }
    if cfg!(target_os = "macos") {
        return Ok(home()?.join(".config").join("zed"));
    }
    Ok(env_dir("FLATPAK_XDG_CONFIG_HOME", config_home)?.join("zed"))
}

/// Goose keeps its config under `%APPDATA%\Block\goose\config` on Windows.
fn goose_dir() -> Result<PathBuf, String> {
    if cfg!(windows) {
        return dirs::config_dir()
            .map(|dir| dir.join("Block").join("goose").join("config"))
            .ok_or_else(|| "找不到 %APPDATA%。".to_string());
    }
    Ok(config_home()?.join("goose"))
}

/// Kimi CLI migrates `config.json` to `config.toml` on start only while the
/// TOML file is missing; creating it first would silently drop those settings.
fn kimi_dir() -> Result<PathBuf, String> {
    let dir = env_dir("KIMI_SHARE_DIR", || Ok(home()?.join(".kimi")))?;
    if !dir.join("config.toml").exists() && dir.join("config.json").exists() {
        return Err(
            "Kimi CLI 还在用旧的 config.json，请先运行一次 kimi 让它迁移成 config.toml，再来接入。"
                .to_string(),
        );
    }
    Ok(dir)
}

/// Oh My Pi: `$PI_CODING_AGENT_DIR`, else `~/<$PI_CONFIG_DIR or .omp>/agent`.
fn omp_dir() -> Result<PathBuf, String> {
    env_dir("PI_CODING_AGENT_DIR", || {
        let root = std::env::var_os("PI_CONFIG_DIR")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| ".omp".into());
        Ok(home()?.join(root).join("agent"))
    })
}

/// `$CLAUDE_CONFIG_DIR` (absolute or `~/…`), else `~/.claude`; the same file
/// the status line setup edits.
fn claude_dir() -> Result<PathBuf, String> {
    let home = home()?;
    if let Some(value) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty()) {
        let text = value.to_string_lossy();
        if let Some(rest) = text.strip_prefix("~/") {
            return Ok(home.join(rest));
        }
        let dir = PathBuf::from(&value);
        if dir.is_absolute() {
            return Ok(dir);
        }
    }
    Ok(home.join(".claude"))
}

/// oh-my-opencode's user layer: `$HOME`, else `%USERPROFILE%`, plus `.omo`
/// on every platform.
fn omo_dir() -> Result<PathBuf, String> {
    Ok(env_dir("HOME", || env_dir("USERPROFILE", home))?.join(".omo"))
}

pub fn discover(agent: &str, gateway_dir: &Path) -> Result<AgentConfig, String> {
    if agent == "claude-code" {
        return Ok(
            AgentConfig::new(claude_code::spec(&claude_dir()?), gateway_dir)
                .managed_keys(claude_code::MANAGED),
        );
    }
    if agent == "oh-my-opencode" {
        let spec = oh_my_opencode::spec(&omo_dir()?, &config_home()?.join("opencode"));
        return Ok(AgentConfig::new(spec, gateway_dir).managed_keys(oh_my_opencode::MANAGED));
    }
    if agent == "minimax-code" {
        let dir = env_dir("MINIMAX_DATA_DIR", || {
            env_dir("MAVIS_DATA_DIR", || minimax_code::data_dir(&home()?))
        })?;
        return Ok(AgentConfig::new(minimax_code::spec(&dir), gateway_dir)
            .managed_keys(minimax_code::MANAGED));
    }
    let spec = match agent {
        "opencode" => opencode::spec(&config_home()?.join("opencode")),
        "crush" => crush::spec(&crush_dir()?),
        "gemini-cli" => gemini_cli::spec(&env_dir("GEMINI_CLI_HOME", home)?.join(".gemini")),
        "pi" => pi::spec(&env_dir("PI_CODING_AGENT_DIR", || {
            Ok(home()?.join(".pi").join("agent"))
        })?),
        "kimi-cli" => kimi::spec(&kimi_dir()?),
        "hermes" => hermes::spec(&env_dir("HERMES_HOME", || Ok(home()?.join(".hermes")))?),
        "goose" => goose::spec(&goose_dir()?),
        "omp" => omp::spec(&omp_dir()?),
        "zed" => zed::spec(&zed_dir()?),
        _ => return Err(format!("暂不支持 Agent「{agent}」。")),
    };
    Ok(AgentConfig::new(spec, gateway_dir))
}
