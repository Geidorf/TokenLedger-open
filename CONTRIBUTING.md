# Contributing to TokenLedger

Thanks for your interest in improving TokenLedger. This guide covers how to set up a development environment, the conventions this codebase follows, and what a good pull request looks like.

## Code of Conduct

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Quick start

```bash
git clone https://github.com/Geidorf/TokenLedger-open.git
cd TokenLedger
npm install
npm run dev
```

`npm run dev` launches the Tauri desktop app. On a headless machine, run the Vite dev server instead:

```bash
npx vite --host 0.0.0.0 --port 1420
```

The UI works in a plain browser without Tauri — a development mock is installed automatically, so the overview, detail, and settings pages are all walkable at `http://127.0.0.1:1420/`.

## Running the checks

Run the checks that cover your change while developing:

```bash
npm run typecheck
npm run check:docs
cargo test --manifest-path src-tauri/Cargo.toml
```

Before a change is merged, a full gate runs against the integrated result:

```bash
npm run check
```

`npm run check` also verifies that the gate itself did not modify any tracked file. Android and Supabase steps are included only when the change touches them:

```bash
npm run android:verify
node scripts/run-android-gradle.mjs :app:validateDebugScreenshotTest
```

## Invariants that must not drift

These are the rules the test suite enforces. If your change touches one of them, expect tests to fail and explain why in your PR description.

1. **Effective tokens are input + output.** Cache reads and cache writes are reported separately and are never folded back into the effective total. The scan fields, dedup keys, and estimation tool are defined by the root `README.md` and the Rust scanner — not by whatever the current UI happens to do.

2. **One contract across every platform.** React, Rust, Supabase, and Android share the same `StatsData` shape. Any new field must stay compatible with data already in the cloud, and must come with a contract test.

3. **No private consumer APIs.** Never scrape, reverse-engineer, or call undeclared internal endpoints of ChatGPT/Codex, Claude, or any other consumer product. Only official documented APIs, explicitly authorized local sources, or manual configuration are allowed. See [the compliance notes](docs/design/quota-source-compliance.md) for the reasoning and the allowed source classes.

4. **Some files have a single writer.** `docs/PROJECT.md`, `docs/REQUIREMENTS.md`, `docs/DESIGN.md`, `docs/contracts/**`, Supabase migration numbering, lockfiles, and version files are maintained by the coordinator. If your change needs one of them, say so in the PR and wait for the assignment — do not edit them in passing.

   The project's internal task ledger is **not** published in this repository, so there is no `docs/TASKS.md` to claim a task in here. Open an issue to discuss anything beyond a small fix before you start. See [`docs/internal-collaboration-materials.md`](docs/internal-collaboration-materials.md) for what stays internal and why.

## Git conventions

- **One task, one branch.** Branch names follow `codex/<task-id>-<slug>`.
- **Commit subjects contain Chinese.** For example `统计：增加上一周期曲线（T1.2）`. Technical names, task IDs, and paths may stay in their original form.
- **Stage precisely.** Never use `git add .` or `git add -A`; add only the files you own.
- **Never rewrite published history.** Historical commit SHAs are referenced by task logs and multi-machine handoffs.
- **Run the commit hook** in your worktree: `git config core.hooksPath .githooks`.

## Pull requests

1. Open an issue first for anything beyond a small fix, so the approach can be agreed before the work.
2. Keep the diff focused — one logical change per PR.
3. In the description, state: what changed, which checks you ran and their results, and what you did **not** run and why.
4. If your change affects a data contract, include the contract test and note the compatibility decision.
5. If your change is user-visible, include screenshots at the target sizes and themes. Screenshots are not committed to the repository; record the SHA-256 and the external location instead.

## Reporting bugs

Please include: the operating system and version, the app version, the AI tool and version involved, the steps to reproduce, and what you expected versus what happened. Attach logs after removing anything sensitive — tokens, cookies, session data, and local file paths.

## Asking questions

Open a discussion or an issue. For questions about the data contract, read the contract documents first — they are the source of truth, and the code is not.
