# 8. Tray and menu bar

[← Wallpapers and widgets](07-wallpaper-widgets.md) · [Contents](README.md) · Next: [Privacy →](09-privacy.md)

TokenLedger lives in the Windows system tray (bottom-right of the taskbar) or the macOS menu bar. Closing the main window only hides it to the tray; scanning, the gateway and sync keep running. To quit completely, use **Quit** in the tray menu.

## Tray icon

| Action | Result |
| --- | --- |
| Hover over the icon | After a short pause the tray widget pops up; it hides when you move away |
| Click | Opens or closes the tray widget; click the open widget to pin it so it stays |
| Double-click | Opens the main window |
| Right-click (Control-click on macOS) | Tray menu |

The tray menu has: Show window, Show / hide tray widget, Desktop widget (stays on desktop) and Quit.

The tooltip follows today's local usage. With [budgets](05-budget.md) set, it adds a line such as "Budget: 1 over · 2 close to limit". On macOS you can turn on "Show today's estimated cost in the menu bar" in **Settings › Scan & startup › Menu bar** to show the amount next to the icon.

## Tray widget

<img src="../images/tray-widget.png" alt="Tray widget" width="300">

A small window that pops up next to the tray icon. It takes no taskbar space and doesn't steal focus. Use the top to switch between today, this week and this month for the moment; the top-right buttons are refresh, open main window, settings and close.

In **Settings › Desktop widgets › Tray widget** you can set:

- **Pop up when pointing at the tray icon**: when off, only a click opens it.
- **Hover delay**: instant, 0.25 s, 0.45 s (standard) or 0.9 s, so passing the mouse over doesn't trigger it.
- **Pin the tray widget at startup**: show it right after login.
- **Layout, theme, default range, quota source**: the same options as the [desktop widget](07-wallpaper-widgets.md#desktop-widget-computer), set separately.

## Startup

In **Settings › Scan & startup**:

- **Start minimized to tray**: the main window stays hidden at startup and TokenLedger waits in the tray.
- **Scan interval**: about 15 minutes by default, 1 minute minimum.

To force the main window to show for one launch, start with `--show` (macOS: `open -n /Applications/tokenledger.app --args --show`).
