<!-- Maintainer workstations: start the first visible line with [workstation name] (see docs/COLLABORATION.md). The PR title becomes the squash commit subject and must contain Chinese. -->

## What this changes

<!-- One or two sentences. Link the issue if there is one, e.g. `Closes #12`. -->

## Why

<!-- What problem does this solve? What changes for the user? -->

## Checklist

- [ ] The change is focused on one logical unit
- [ ] Checks I ran, with results:
  - [ ] `npm run typecheck`
  - [ ] `npm run check:docs`
  - [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
  - [ ] Other: <!-- specify -->
- [ ] Checks I did **not** run, and why: <!-- be explicit; an empty answer is fine if everything was run -->
- [ ] Commit subjects contain Chinese
- [ ] I staged only the files I own (no `git add .` / `git add -A`)
- [ ] If this touches a data contract: the contract document and contract test are updated, and old data stays readable
- [ ] If this changes effective-token semantics: I did not fold cache reads or writes back into the effective total
- [ ] If this touches quota sources: no undeclared internal endpoint of any consumer product is used
- [ ] If this is user-visible: screenshots were taken at the target sizes and themes, and their SHA-256 plus external location are recorded in the task log (screenshots are not committed)

## Risk

- [ ] This touches user data reads or writes, cloud permissions, database migrations, cross-platform statistics semantics, or release prerequisites — if so, an independent review is required before merge

## Level (maintainer workstations)

- [ ] A: docs, tests, UI, fixes outside sensitive paths — merges when CI is green
- [ ] B: contracts, cross-platform stats, Supabase migrations/RLS, sync format, secret storage, quota sources, `.github/`, release scripts, new dependencies — needs a review from another workstation
- [ ] C: AGENTS.md rules, public-repo red lines, version bumps and releases, architecture decisions — also needs the maintainer's approval

## Handoff

<!-- Where this stands, what is left, and the first step for whoever picks it up. Write "none" when the PR is complete. -->

## Notes for the reviewer

<!-- Anything that is not obvious from the diff. -->
