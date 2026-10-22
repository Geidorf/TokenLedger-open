# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). If that is unavailable, email the maintainer through the address listed in the repository's GitHub profile.

Include: affected version or commit, platform, a description of the issue, and reproduction steps. Please allow a reasonable time for a fix before disclosing publicly.

## What counts as a security issue here

TokenLedger reads local AI tool logs and, optionally, syncs aggregated statistics to a cloud backend. The following are in scope:

- **Credential exposure** — any path by which an API key, OAuth token, session, or cookie stored in the system keychain or in a config file could be read, logged, uploaded, or displayed.
- **Unauthorized cloud access** — a way to read or modify another user's rows in the cloud database, including bypasses of row-level security.
- **Injection in the local gateway** — a way to make the local model gateway forward a request to an unintended host, or to leak a provider credential to a host other than its owner.
- **Local data disclosure** — a way to make the app upload or expose local file contents, prompt text, or session transcripts that the user did not intend to share.
- **Signature and update chain** — a way to obtain a release build signed with the project's release key, or to make an update channel deliver an unverified artifact.

## Out of scope

- Vulnerabilities in upstream dependencies with no demonstrated impact in this project — report those to the upstream project.
- Findings that require an attacker to already control the user's machine or account.
- Missing hardening headers on the local-only HTTP surface, which is bound to loopback by default.
- Denial of service through deliberate local resource exhaustion.

## Security-relevant design rules

These hold for every contribution:

1. **Credentials stay in the system credential store.** The frontend never receives key material — only a boolean such as `hasApiKey`. Keys are never written to settings files, never uploaded, and never logged.
2. **Requests carry credentials only to their owner.** A key is sent only to the host that key belongs to, or to a user-configured same-origin relay endpoint. No cross-provider forwarding.
3. **No private consumer APIs.** Undeclared internal endpoints of consumer products are off limits — see [the compliance notes](docs/design/quota-source-compliance.md).
4. **The cloud enforces row-level security.** Every read and write path is scoped by the authenticated user id; the client never holds a service-role key.
5. **Local-only surfaces bind to loopback.** The local gateway and the local model API listen on `127.0.0.1` unless the user explicitly changes it, and refuse to send credentials embedded in a URL.
