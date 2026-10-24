# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Local model gateway with a persistent accounting ledger: old logs import idempotently, and both local statistics and cloud aggregates read from that ledger. A failed import preserves newly billed usage instead of dropping it.
- Antigravity CLI scanning across both of its roots, reading real input, output, and cache-read values. Local schema advanced to v16 to record usage provenance and the "cache write unknown" state; rows estimated by older versions carry an estimate badge.
- Quota clearing now persists a local stop before dispatching, so an interrupted clear can recover. Compatible with older PostgREST versions; the cloud rejects observations more than five minutes in the future.
- Deep links into settings now switch pages correctly while the app is running. The usage records page shows the active filter and can clear it in one action.
- Android widget and dashboard visual refresh, including brand icons, input/output share bars on KPI cards, quota overview progress bars, and reduced visual noise in settings.
- Settings cards open their target page directly, and an overview line reports a quota read that is still waiting for the first observation.
- Model price table schema 2: dated price history so a price change only affects records after it takes effect, long-context tiers for GPT-5.6/GPT-6, Gemini Pro, Grok and MiniMax-M3 on per-request tools, and a daily online update from this repository with the bundled table as the offline fallback. Settings and the estimated-cost help show which table is in use, its revision and verification date.

### Changed

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
