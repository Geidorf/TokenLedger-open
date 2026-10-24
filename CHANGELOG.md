# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Unsigned Linux x64 packages (AppImage, deb, rpm) built by `unsigned-linux-packages.yml`, with `tokenledger-cli` bundled. Every build installs the deb and runs the AppImage under Xvfb to check the main window, tray registration, start-at-login entry, XDG data folder, first scan and single-instance handoff.
- Start at login on Linux: the toggle in Settings › Scan & startup writes an XDG autostart entry (for the AppImage it points at the image file and follows it when moved). Windows and macOS still show it as unsupported.
- Command-line tool `tokenledger-cli`: today/week/month usage with Agent, model and account breakdowns, quota remaining, budget status, gateway state and recent routes, on-demand scans, and CSV/JSON ledger export. Every command has table output and `--json` for scripts and status bars; numbers come from the same Rust code as the desktop app. See `docs/cli.md`.
- Local MCP server `tokenledger-cli mcp` (stdio, read-only): agents such as Claude Code and Codex can query usage and breakdowns, quota remaining, budget status, gateway health and recent routes, and usage anomalies, plus a `pace_usage` prompt for conserving tokens when quota is low. It opens no ports and never returns keys, credentials or request content. See `docs/mcp.md`.
- Local model gateway with a persistent accounting ledger: old logs import idempotently, and both local statistics and cloud aggregates read from that ledger. A failed import preserves newly billed usage instead of dropping it.
- Antigravity CLI scanning across both of its roots, reading real input, output, and cache-read values. Local schema advanced to v16 to record usage provenance and the "cache write unknown" state; rows estimated by older versions carry an estimate badge.
- Quota clearing now persists a local stop before dispatching, so an interrupted clear can recover. Compatible with older PostgREST versions; the cloud rejects observations more than five minutes in the future.
- Deep links into settings now switch pages correctly while the app is running. The usage records page shows the active filter and can clear it in one action.
- Android widget and dashboard visual refresh, including brand icons, input/output share bars on KPI cards, quota overview progress bars, and reduced visual noise in settings.
- VS Code status bar extension (`extensions/vscode/`): shows today's estimated cost or the tightest quota window's remaining percentage, with a hover card and details panel for quota bars, today's per-agent split, budgets and gateway health. All figures come from the local `tokenledger-cli`; the extension reads no credentials and makes no network requests. Packaged as a .vsix by a dependency-free script; not published to the marketplace.
- Settings cards open their target page directly, and an overview line reports a quota read that is still waiting for the first observation.

### Changed

- Linux scan paths honour `XDG_DATA_HOME` and `XDG_CONFIG_HOME` (OpenCode, Kilo, Hermes, Kimi Desktop, Trae, DeepSeek GUI, WorkBuddy), and the Marvis path on Linux no longer points at a macOS-style folder.

- The source and cross-platform build version moved from 1.2.77 to 2.0.0; the Android `versionCode` moved from 1002077 to 2000000.
- The version bump tool now accepts an explicit target version and keeps the Rust lockfile in sync; the default patch increment stays backwards compatible.
- Local schema v14 introduces a row revision so that a late-arriving upload acknowledgement can no longer swallow a newer change. Schema v16 adds usage provenance columns.
- A quota credential is now bound to the endpoint it was issued for, so a key cannot be replayed against a different host. Local Antigravity requests refuse redirects.
- Android session revocation and shared-refresh coordination are now persisted, so a revoked session stays revoked across restarts.

### Fixed

- A stale local row can no longer be overwritten by a late upload acknowledgement, which previously caused locally corrected usage to be lost.
- Quota percentages are computed from a single shared function, so the overview card, quota page, wallpaper, and widget report the same number for the same window.
- Settings deep links no longer land on the wrong tab.

### Removed

- The `check:scorecard` gate was removed. It parsed manually entered product scores and asserted each was above 8.5, which could only fail if someone deliberately lowered their own score, so it created the appearance of machine verification without providing it.

## [Unreleased — first public release candidate]

The first public release candidate has not been published yet. Signed release artifacts, a real Supabase deployment, and the full platform verification matrix are still outstanding.

## Notes

Dates in this file are the dates the entries were written, not build timestamps. Actual build time is captured at build start.
