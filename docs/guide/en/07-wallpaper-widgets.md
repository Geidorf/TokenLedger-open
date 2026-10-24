# 7. Wallpapers and widgets

[← Cloud sync and the phone app](06-cloud-mobile.md) · [Contents](README.md) · Next: [Tray and menu bar →](08-tray.md)

See your usage without opening the main window: desktop wallpaper, the Windows lock screen, the desktop widget, Android home-screen widgets and the Android lock-screen live wallpaper.

## Desktop wallpaper and lock screen (computer)

Set these up in **Settings › Desktop wallpaper (桌面壁纸)**:

![Settings › Desktop wallpaper](../images/settings-wallpaper.png)

- **Enable desktop wallpaper**: the main switch, off by default. Turning it off pauses updates and keeps your chosen style.
- **Style**: "Static image" draws your usage into a wallpaper image and redraws it at the update interval (minimum 15 seconds). macOS also has "Live desktop", a live card above the system wallpaper and below the desktop icons that lets clicks pass through.
- **Lock-screen wallpaper** (Windows only): "Update the lock-screen wallpaper automatically" uses the same picture for the lock screen, refreshed at least every 30 seconds. macOS does not allow changing the lock screen.
- **Usage source**: this computer, or the cloud total (needs [cloud sync](06-cloud-mobile.md)). You can pick which devices count, separately from the dashboard filters.
- The page shows a preview; click **Apply now** to write it to the desktop.
- **Clean up old wallpapers** only deletes old images TokenLedger generated. It keeps the current image and your original wallpaper setting.

## Desktop widget (computer)

A card that stays on the desktop. Drag it anywhere; its position is remembered. Turn it on in **Settings › Desktop widgets (桌面挂件) › Desktop widget**, or tick "Desktop widget (stays on desktop)" in the tray menu.

![Settings › Desktop widgets](../images/settings-widgets.png)

| Layout | Content |
| --- | --- |
| Usage details (default) | Large effective-token number, change vs the same point yesterday, estimated cost, today's trend, input / output / cache, tool mix and the two tightest quotas |
| Quota and usage | The tightest quota ring plus effective tokens and cost |
| Quota overview | Up to 6 quota rings, tightest first |
| One-line usage | One row: effective tokens and estimated cost |
| Live routing | A compact version of the gateway's live routing stage |

Theme (system, light, dark), default range (today, this week, this month) and quota source are set separately for the desktop widget and the tray widget. The desktop widget has no buttons until you hover over it; then refresh, open main window, settings and remove-from-desktop appear in the top-right corner.

## Android home-screen widgets

Long-press an empty spot on your home screen › Widgets › TokenLedger. There are four:

| Widget | Main size | Content |
| --- | --- | --- |
| Quota rings | 2×2 | Available share for two quota sources as rings |
| One-line usage | 4×1 | Effective tokens, estimated cost and data time |
| Combined | 4×2 | Quota rings plus tokens and cost |
| Quota bars | 4×3 | One row per quota window with the available percentage and time to reset; can add the latest gateway route |

<p>
  <img src="../images/android/widget-ring.png" alt="Quota rings widget" width="300">
  <img src="../images/android/widget-combo.png" alt="Combined widget" width="300">
</p>

Widget percentages are always the **available** quota. Stale data is marked as waiting for refresh, with the observation date. Turning on **Hide cost** in the app hides amounts in widgets too.

## Phone lock-screen live wallpaper

Shows your desktop gateway's routing live on the Android lock screen: which agent's request is going to which provider, and where it switched on failure.

<img src="../images/android/routing.png" alt="Android routing tab" width="260">

To turn it on:

1. Finish [cloud sync](06-cloud-mobile.md) and make sure the cloud has the latest migrations (`supabase db push`). Without them, settings show "cloud not deployed yet".
2. On the computer, turn on **Settings › Desktop widgets › Phone live wallpaper › Sync live routing to the phone**.
3. On the phone, open **Me › Lock-screen live wallpaper** and set it as the lock screen (or home and lock screen) in the system wallpaper picker.

Notes:

- Every few seconds the desktop sends a live routing snapshot to your cloud and the phone reads it, so the phone is a few seconds to a minute behind. Requests that just finished stay lit for 30 seconds.
- When the computer is offline, no snapshot has arrived for 90 seconds, or the cloud isn't deployed, the wallpaper says so instead of playing a fake animation.
- A snapshot only contains agent names, `provider/model` and status codes. No sessions, accounts, keys or request content.
- Turning the switch off stops uploads and deletes this computer's snapshot from the cloud. The cloud also cleans up old snapshots regularly.
- The phone's **Routing** tab shows the same data if you don't want it as a wallpaper.
