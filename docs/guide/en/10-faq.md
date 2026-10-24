# 10. FAQ

[← Privacy](09-privacy.md) · [Contents](README.md) · Next: [Request log →](11-request-log.md)

## Install and launch

**Windows says "Windows protected your PC" and there is no Run button.**
Click **More info** first; the button appears then. See [Install](01-install.md#windows).

**macOS says the app can't be opened because the developer can't be verified.**
Go to **System Settings › Privacy & Security** and click **Open Anyway**. See [Install](01-install.md#macos).

**Nothing appears after launch.**
"Start minimized to tray" is probably on. Double-click the tray (menu bar) icon to open the main window, or launch with `--show`.

## Data and numbers

**A tool's usage doesn't show up.**
Check that the tool has run sessions on this computer, then click **Refresh scan**. If Codex lives in a non-default folder, add it under **Settings › Scan & startup › Extra Codex log folders**. The list of supported tools is in the repository [README](../../../README.md).

**Why are my effective tokens lower than what the tool itself shows?**
TokenLedger's effective tokens are input + output only; cache reads and writes are listed separately. Switch to "Including cache" to see the total with cache.

**The estimated cost doesn't match my bill.**
Estimated cost comes from the local price table and carries a `≈`. Use it for trends and comparisons, not as a bill. New models first go to the "needs pricing" list in **Settings › Model prices** with a temporary fallback rate; you can search public prices and import one, or type the prices yourself.

**Is the same request ever counted twice?**
No. A request through the model gateway appears in both the gateway ledger and the agent's log, and TokenLedger merges them locally into one. For usage shared by other computers through an external gateway's WebDAV folder, only tick computers that don't run TokenLedger, or it will be counted twice.

**The dashboard says "unavailable".**
That number can't be read, for example because a model has no price yet so cost is incomplete, or there are no gateway records so there's no account split. TokenLedger doesn't pretend it is 0.

## Cloud and phone

**The OS asks for a password when I click "Check account status".**
That's the system keychain asking for permission. Enter your computer's password, not your cloud account password.

**Sign-in fails with `Could not find the function …`.**
The cloud doesn't have the latest migrations. Run `supabase db push` from the repository folder, wait a minute or two for Supabase to refresh, and try again. See [Cloud sync](06-cloud-mobile.md#set-up-the-cloud-once).

**The phone shows different numbers from the computer.**
The phone shows the cloud total: only data that has been synced, after the cloud totals refresh. Compare with **Cloud total** on the computer; **This computer** only counts that one machine. The phone also shows cost in CNY by default while the desktop uses USD.

**The phone wallpaper says "cloud not deployed" or "desktop offline".**
For the first, run `supabase db push`. For the second, check that TokenLedger is running on the computer, that "Sync live routing to the phone" is on, and that the network works. After 90 seconds without a snapshot the wallpaper shows offline.

## Gateway and routing

**An agent can't connect after switching it to the gateway.**
Check the Gateway page to see whether the gateway is running; a busy port shows up there. Then check that the provider behind the chosen model is enabled and has a key.

**My routing group keeps using the fallback.**
Open **Routing › Recent decisions** and expand **Why this choice**. The reason each member wasn't picked (rate limited, auth failed, cooling down, key missing…) is listed there.

**I want to turn the gateway off and restore my agents' configs.**
When you turn off **Settings › Model access**, choose "Restore original configs and turn off", or restore each agent on the Agents page.

## Other

**How do I switch to English?**
**Settings › Data & help › Interface language › English**, or use the language menu in the top-right corner of the first-run guide. The English UI is still being completed.

**Where do I report a problem?**
Open an issue on GitHub [Issues](https://github.com/Geidorf/TokenLedger-open/issues) with your OS version, TokenLedger version and steps to reproduce. Please don't paste API keys, account names or raw logs. Report security issues privately as described in [SECURITY.md](../../../SECURITY.md).
