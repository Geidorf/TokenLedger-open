# 3. Usage pages

[← First-run guide](02-first-run.md) · [Contents](README.md) · Next: [Gateway and routing groups →](04-gateway-routing.md)

The middle of the top bar has five main pages: **Agents, Providers, Gateway, Routing, Usage (用量)**. The first four belong to the model gateway (see [chapter 4](04-gateway-routing.md)). This chapter covers Usage, which has four sub-pages: **Overview, Requests, Sessions and Quota (概览、请求、会话、额度)**.

On the right of the top bar: cloud status, refresh scan, cloud sync, share report, wallpaper, desktop widget and settings.

## Common controls

- **Time range**: Today, This week, This month, This year, All time, Custom. Today, This week and This month are compared with the **same point** in the previous period: at 14:30 today you are compared with 00:00–14:30 yesterday, not with all of yesterday.
- **This computer / Cloud total (本地机器 / 云端汇总)**: This computer shows only this computer's ledger. Cloud total adds up every synced device and needs [cloud sync](06-cloud-mobile.md).
- **Effective / Including cache (概览有效 / 概览含缓存)**: whether the headline numbers include cache. Effective tokens is the default.
- **Theme**: Auto (follows the system), Light, Dark.

## Overview

![Usage overview](../images/usage-overview.png)

From top to bottom:

1. **One-line summary**: how much you used today, the change against the same point last period, the tool with the biggest share and the cache reuse rate.
2. **Metric cards**: effective tokens (split into input and output), estimated cost, record count (with tokens per record) and cache reads, each with its change against last period.
3. **Quota at a glance**: the tightest quota windows, sorted by what is left. "View all quota" opens the Quota sub-page.
4. **Trend**: effective tokens and estimated cost over time, as a token view, cost view or both. The dashed line is the same point in the previous period. The Today view adds the hourly average and the unit cost (cost per million tokens).
5. **Usage split**: split by Agent, Model, Device or Account, measured in tokens, records or cost. Picking an item narrows the heatmap and lists below. The Account split only covers requests that went through the model gateway.
6. **Year heatmap**: one cell per day; darker means more usage. Click a day to drill into that day's records.

Click any tool or model name to open its **own dashboard**: trend, composition, devices, activity and matching records.

"Adjust display (调整显示)" hides or reorders the Overview sections. The share button in the top bar makes a "usage report" image or HTML summary you can send to someone; you get a preview first and can hide amounts.

The same page in the dark theme:

![Usage overview, dark](../images/usage-overview-dark.png)

## Requests

![Requests](../images/usage-requests.png)

One row per call: tool, model, input, output, total cache, estimated cost, time and device.

- **Filters**: combine tools, models and devices, and search by exact text. "Clear filters" resets them.
- **Details**: click a row to see the full token breakdown. Requests that carry context-composition data also show what the context was made of.
- **Export CSV**: exports the rows that match the current filters.

## Sessions

![Sessions](../images/usage-sessions.png)

Usage seen per session, for Today, the last 3, 7 or 30 days, or a custom range.

- **Daily activity / Hourly rhythm**: a date × hour heatmap of when you use AI during the day.
- **Tool ranking and session ranking**: which tool and which session used the most tokens. For a session you can open its records or a **turn-by-turn analysis** showing input, output and cache for each turn.
- **Per-project usage** (off by default): turn it on in **Settings › Data & help › Per-project usage** to group sessions by project folder. Project names are stored on this computer only and never uploaded. Turn on "Hide project names" before taking screenshots to show them as "Project 1" and so on.

## Quota

![Quota](../images/usage-quota.png)

Remaining quota for your subscriptions and providers in one place. TokenLedger only shows what the source actually reports. It never extrapolates or fills gaps:

- Percentages are always the **available** share. Below 50% is tight; below 20% is critical.
- Each window shows when it was observed and when it resets. Stale data is labelled as historical instead of pretending to be current.
- "Refresh quota" reads again now. "Pending sources" lists sources that are not authorized or cannot be read; "Go to settings" takes you to authorize them.

Each quota source is authorized separately in **Settings › Subscription quota (订阅额度)**, and all are off by default:

![Settings › Subscription quota](../images/settings-quota.png)

| Source | How it is read |
| --- | --- |
| Codex | Codex's official local interface; OAuth tokens are never read |
| Claude | Claude Code status line first, or the built-in `/usage` |
| Antigravity | Experimental; only talks to Antigravity running on this computer |
| Coding plans | Experimental; usage for some coding plans, using the API key you added on the Providers page |
| Company OpenAPI | Your company's quota endpoint and API key; the key goes only into this computer's secure storage |
| Provider balances | Reuses keys saved on the Providers page to read official balance endpoints; shows only the balance and currency |

You can turn on system notifications for windows running out (50%, 20% and 5% left) under **Subscription quota › Quota alerts**. Syncing quota across devices is a separate switch and is off by default.
