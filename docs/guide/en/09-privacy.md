# 9. Privacy

[← Tray and menu bar](08-tray.md) · [Contents](README.md) · Next: [FAQ →](10-faq.md)

In short: **everything is counted on your computer first, and nothing is uploaded by default.** Totals only leave your computer when you turn on cloud sync, and then they go to your own Supabase project.

## What stays on your computer

| Data | Where it lives |
| --- | --- |
| Each AI tool's original logs and databases | Read in place; never copied or changed |
| The per-request usage ledger (session IDs, times, models, tokens) | Local database `tokenboard.db` |
| Prompts, model replies, file contents | TokenLedger does not read or keep them; it only takes the usage fields from logs |
| Provider API keys, company quota keys, cloud sign-in session | System keychain (Windows Credential Manager / macOS Keychain) |
| The model gateway's request ledger and provider health | Local app data folder |
| Budget rules and alert history | Local app data folder |
| Project folder names (when per-project usage is on) | Local database, never synced |
| Usage shared by other computers through an external gateway's WebDAV folder | Only added to local totals, never uploaded |
| Custom prices and interface settings | Local app data folder |

Scanning only reads each AI tool's own log and database folders. It never touches browser data, cookies, SSH keys or other general sensitive locations. Quota sources never copy OAuth tokens and never call undocumented internal endpoints of consumer products.

## What is uploaded once cloud sync is on

Everything goes to the Supabase project you entered in **Settings › Cloud account**. Each account can only read and write its own rows (row-level security in the database).

| When | What is uploaded | What is not |
| --- | --- | --- |
| Cloud sync (after sign-in) | Rows aggregated by device × tool × model × hour: device ID (a random number starting with `tl-`, generated the first time the app runs; it does not contain the computer's name), tool, model, hour, input / output / cache tokens, request count, estimated cost and how many of those requests went through the gateway | Session IDs, prompts, replies, file paths, project names, provider keys |
| Account | The email you registered with, kept by Supabase Auth | — |
| Quota sync across devices (separate switch, off by default) | Available share, reset time, observation time and source name for each quota window; for provider balances you turned on, only the amount and currency | Subscription credentials, cookies, account emails or organization names |
| Budget sync to phone (separate switch, off by default) | For each budget: the scope name (the same as in system notifications: the agent, model or account display name, or "All usage"), period, used percentage (rounded) and level. The device is a one-way hashed ID, not the computer's name | Amounts, limits, budgets without a reading; deleted when you turn the switch off, and snapshots not updated for 3 days are removed by the cloud |
| Phone live wallpaper (separate switch, off by default) | A routing snapshot of the last few minutes: agent names, `provider/model`, status codes and times | Sessions, accounts, keys, error bodies, request content; deleted when you turn the switch off, and old snapshots are cleaned up daily |

The device ID is kept in the `device-id` file in the app data folder, next to the local ledger. Older versions told devices apart by the computer's host name. After you update, the first sync of each cloud account moves the rows this computer uploaded under its host name to the device ID as they are, then deletes the rows under the host name, so no history is lost or counted twice and the computer's name no longer appears in the cloud. In device pickers this computer shows as **This device (tl-…)**.

If several computers share a host name, older versions mixed their rows under that one name. After the update, that shared history goes to whichever computer syncs first; from then on each computer is counted separately.

If you delete the app data folder (with the ledger), this computer gets a new device ID. Rows already synced under the old ID stay in the cloud and count as another device.

## Addresses TokenLedger connects to

| Connection | When |
| --- | --- |
| Your Supabase project | Only after you turn on cloud sync |
| Provider endpoints you configured | When the gateway forwards a request or reads a provider balance |
| Quota sources you authorized | Only when that source's switch is on |
| The public `models.dev` model catalog | When you search prices for an unpriced model under Model prices; cached for 24 hours |
| The public Hitokoto quote API (Android only) | At most once a day for the standby screen's daily quote; falls back to built-in quotes on failure |

TokenLedger contains no analytics or telemetry SDK.

## Screenshots and sharing

- The usage report has a preview before export and can hide cost.
- Per-project usage has "Hide project names", which shows them as "Project 1" and so on.
- Android's "Hide cost" replaces amounts with asterisks, widgets included.

## Deleting data

- **On this computer**: **Settings › Data & help › Danger zone › Delete old data** removes records before a chosen date. After uninstalling, delete the [data folder](01-install.md#upgrade-and-uninstall) to remove everything.
- **In the cloud**: the data is in your own Supabase project. Delete it from the Supabase dashboard, or delete the whole project. Quota sources also have their own "Delete cloud snapshot" under **Settings › Subscription quota**.

For the full technical boundaries, see the [Privacy section of the README](../../../README.md) and the [quota source compliance notes](../../design/quota-source-compliance.md) (both in Chinese). Report security issues privately as described in [SECURITY.md](../../../SECURITY.md).
