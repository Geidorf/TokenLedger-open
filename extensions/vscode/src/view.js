'use strict';

// 把一轮命令行输出排成状态栏文字、悬停卡片（Markdown）与详情面板（HTML）。
// 纯函数，不依赖 vscode 模块，便于单测。所有数字原样来自命令行 JSON，这里只挑选与排版。

const {
  formatClock,
  formatCount,
  formatEstimatedUsd,
  formatPercent,
  formatResetsAt,
  formatTokens,
  formatUsdAmount,
} = require('./format');

/** 低于 20% 紧张、低于 50% 提醒，与看板、挂件、壁纸的额度着色同一组阈值。 */
function quotaLevel(remainingPercent) {
  if (!Number.isFinite(remainingPercent) || remainingPercent < 20) return 'critical';
  if (remainingPercent < 50) return 'warn';
  return 'ok';
}

const BUDGET_LEVEL_LABELS = { ok: '正常', warn: '接近上限', over: '已超出', unavailable: '不可用' };
const BUDGET_PERIOD_LABELS = { day: '今日', week: '本周', month: '本月' };
const QUOTA_STATUS_LABELS = { ok: '正常', stale: '过期', 'auth-required': '未授权', unsupported: '不支持', error: '出错' };
const TOP_AGENT_ROWS = 5;
const BAR_CELLS = 10;

function valueOf(section) {
  return section && section.value ? section.value : null;
}

/** 百分比窗口的可用百分比（与命令行 `status` 选最紧窗口用的是同一条规则）；其他单位为 null。 */
function windowRemainingPercent(window) {
  if (!window || window.unit !== 'percent') return null;
  if (typeof window.remaining === 'number' && Number.isFinite(window.remaining)) return window.remaining;
  if (typeof window.used === 'number' && Number.isFinite(window.used)) return Math.max(0, 100 - window.used);
  return null;
}

function trimNumber(value) {
  return Math.abs(value - Math.round(value)) < 1e-9 ? String(Math.round(value)) : value.toFixed(2);
}

function windowAmountText(window) {
  if (window.reasonCode === 'credits_unlimited') return '无限';
  const units = { usd: 'USD', credits: 'Credits', requests: '次', tokens: 'Token' };
  const unit = window.unit === 'currency' ? (window.currency || '') : (units[window.unit] || window.unit || '');
  const remaining = typeof window.remaining === 'number' && Number.isFinite(window.remaining) ? window.remaining : null;
  const limit = typeof window.limit === 'number' && Number.isFinite(window.limit) ? window.limit : null;
  if (remaining !== null && limit !== null) return `余 ${trimNumber(remaining)} / ${trimNumber(limit)} ${unit}`.trim();
  if (remaining !== null) return `余 ${trimNumber(remaining)} ${unit}`.trim();
  return '—';
}

// 来源短名：与看板、挂件、设置页同一个名字（src/utils/quotaOverview.ts providerDisplayName）。
const PROVIDER_DISPLAY_LABELS = {
  'openai-codex-local': 'Codex',
  'anthropic-claude-consumer': 'Claude',
  'google-antigravity-consumer': 'Antigravity',
};

function providerName(provider) {
  return PROVIDER_DISPLAY_LABELS[provider.providerId]
    || (provider.scope === 'manual-budget' ? '手动预算' : provider.displayName || provider.providerId || '额度');
}

/**
 * 额度列表：有窗口的来源每个窗口一行，百分比窗口给可用% 与等级，其余给剩余量。
 * 还没授权的来源不逐个列出，只计数（`pending`）；出错的来源单列一行写明。
 */
function quotaRows(quota) {
  const providers = quota && Array.isArray(quota.providers) ? quota.providers : [];
  const rows = [];
  let pending = 0;
  for (const provider of providers) {
    if (!provider || provider.status === 'unsupported') continue;
    const name = providerName(provider);
    const windows = Array.isArray(provider.windows) ? provider.windows : [];
    if (windows.length === 0) {
      if (provider.status === 'auth-required') pending += 1;
      else rows.push({ provider: name, window: '', note: QUOTA_STATUS_LABELS[provider.status] || provider.status || '' });
      continue;
    }
    for (const window of windows) {
      const hasValues = window.status === 'ok' || window.status === 'stale';
      const remaining = hasValues ? windowRemainingPercent(window) : null;
      rows.push({
        provider: name,
        window: window.windowLabel || window.windowId || '',
        remainingPercent: remaining,
        level: remaining === null ? null : quotaLevel(remaining),
        amount: hasValues && remaining === null ? windowAmountText(window) : null,
        resetsAt: window.resetsAt || null,
        stale: window.status === 'stale',
        note: hasValues ? '' : (QUOTA_STATUS_LABELS[window.status] || window.status || ''),
      });
    }
  }
  rows.pending = pending;
  return rows;
}

/** 状态栏里最紧额度的来源名：能在额度列表里对上就用短名，否则用命令行给的名字。 */
function tightestProviderName(status, quota) {
  const raw = status && status.quota ? status.quota.provider || '' : '';
  const providers = quota && Array.isArray(quota.providers) ? quota.providers : [];
  const match = providers.find((provider) => provider && provider.displayName === raw);
  return match ? providerName(match) : raw;
}

/** 今日按 Agent 拆分：取前几名，其余并成「其他」。 */
function agentRows(usage) {
  const rows = usage && usage.breakdown && Array.isArray(usage.breakdown.rows) ? usage.breakdown.rows : [];
  const top = rows.slice(0, TOP_AGENT_ROWS).map((row) => ({
    name: row.name || row.id || '未知',
    totalTokens: row.totalTokens,
    cost: row.cost,
  }));
  const rest = rows.slice(TOP_AGENT_ROWS);
  if (rest.length > 0) {
    const costs = rest.map((row) => row.cost);
    top.push({
      name: `其他 ${rest.length} 个`,
      totalTokens: rest.reduce((sum, row) => sum + (Number(row.totalTokens) || 0), 0),
      // 有一项费用不可得，合计就不可得，不把未知当 0。
      cost: costs.every((cost) => typeof cost === 'number' && Number.isFinite(cost))
        ? costs.reduce((sum, cost) => sum + cost, 0)
        : null,
    });
  }
  return top;
}

function budgetScopeLabel(status, toolNames) {
  const id = status.scopeId || '';
  switch (status.scopeKind) {
    case 'all': return '全部用量';
    case 'tool': return `Agent · ${toolNames.get(id) || id}`;
    case 'model': return `模型 · ${id}`;
    case 'provider': return `账号 · ${id}`;
    default: return status.scopeKind || '预算';
  }
}

/** `usage` 可选：用今日拆分里的 Agent 显示名替换预算范围里的 Agent 标识。 */
function budgetRows(budget, usage) {
  const statuses = budget && Array.isArray(budget.statuses) ? budget.statuses : [];
  const usageRows = usage && usage.breakdown && Array.isArray(usage.breakdown.rows) ? usage.breakdown.rows : [];
  const toolNames = new Map(usageRows.filter((row) => row && row.id && row.name).map((row) => [row.id, row.name]));
  return statuses.map((status) => {
    const isCost = status.metric === 'cost';
    const amount = (value) => (value === null || value === undefined ? '—' : isCost ? formatUsdAmount(value) : formatTokens(value));
    return {
      label: `${BUDGET_PERIOD_LABELS[status.period] || status.period || ''} · ${budgetScopeLabel(status, toolNames)}`,
      used: isCost ? formatEstimatedUsd(status.used) : amount(status.used),
      limit: amount(status.limit),
      percent: typeof status.percent === 'number' ? status.percent : null,
      level: status.level || 'unavailable',
      levelLabel: BUDGET_LEVEL_LABELS[status.level] || status.level || '',
    };
  });
}

/** 网关健康：是否在运行、供应商启用数、最近若干次请求的成功率。 */
function gatewaySummary(gateway) {
  if (!gateway) return null;
  const recent = Array.isArray(gateway.recent) ? gateway.recent : [];
  const ok = recent.filter((record) => record && record.ok === true).length;
  const lastFailure = recent.find((record) => record && record.ok === false) || null;
  let state;
  let health;
  if (gateway.running === true) {
    state = '运行中';
    health = recent.length > 0 && ok < recent.length ? 'warn' : 'ok';
  } else if (gateway.modelAccessEnabled === false) {
    state = '未开启';
    health = 'off';
  } else {
    state = '未运行';
    health = 'off';
  }
  if (gateway.configError) health = 'error';
  return {
    state,
    health,
    port: gateway.port,
    providers: `${formatCount(gateway.enabledProviderCount)}/${formatCount(gateway.providerCount)}`,
    routingGroups: gateway.routingGroupCount,
    recentCount: recent.length,
    recentOk: ok,
    successPercent: recent.length > 0 ? (ok / recent.length) * 100 : null,
    lastFailure: lastFailure
      ? { ts: lastFailure.ts, status: lastFailure.status, member: lastFailure.member || lastFailure.provider || '' }
      : null,
    configError: gateway.configError || null,
  };
}

/**
 * 状态栏文字。`metric`：`cost` 今日预估费用（与托盘、菜单栏标题一致），`quota` 最紧额度
 * 的可用%（读不到额度时退回费用），`both` 两个都显示。
 */
function statusBarModel(state, metric) {
  const status = valueOf(state && state.snapshot && state.snapshot.status);
  if (!status) {
    const notFound = state && state.notFound;
    return {
      text: '$(warning) TokenLedger',
      severity: 'warning',
      accessibility: notFound ? 'TokenLedger：找不到命令行工具' : 'TokenLedger：读取失败',
    };
  }
  const cost = formatEstimatedUsd(status.today ? status.today.totalCost : null);
  const quota = status.quota && typeof status.quota.remainingPercent === 'number' ? status.quota : null;
  const name = quota ? tightestProviderName(status, valueOf(state.snapshot.quota)) : '';
  const quotaText = quota ? `${name} ${formatPercent(quota.remainingPercent)}`.trim() : null;
  let text;
  if (metric === 'quota' && quotaText) text = `$(dashboard) ${quotaText}`;
  else if (metric === 'both' && quotaText) text = `$(graph) ${cost}  $(dashboard) ${quotaText}`;
  else text = `$(graph) ${cost}`;

  let severity = null;
  const budgetLevel = status.budget ? status.budget.level : null;
  if (budgetLevel === 'over') severity = 'error';
  else if (budgetLevel === 'warn' || (quota && quotaLevel(quota.remainingPercent) === 'critical')) severity = 'warning';

  const parts = [`TokenLedger 今日预估费用 ${cost}`];
  if (quota) parts.push(`${name} ${quota.window || ''} 可用 ${formatPercent(quota.remainingPercent)}`);
  if (status.budget && typeof status.budget.percent === 'number') parts.push(`预算已用 ${formatPercent(status.budget.percent)}`);
  return { text, severity, accessibility: parts.join('，') };
}

// ---------------------------------------------------------------- Markdown（悬停卡片）

function escapeMarkdown(text) {
  return String(text ?? '').replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

function textBar(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * BAR_CELLS);
  return `${'▰'.repeat(filled)}${'▱'.repeat(BAR_CELLS - filled)}`;
}

const LEVEL_ICONS = { ok: '$(pass)', warn: '$(warning)', critical: '$(error)', over: '$(error)', unavailable: '$(circle-slash)', error: '$(error)', off: '$(circle-slash)' };

function sectionErrorLine(section, label) {
  return section && section.error ? `$(warning) ${label}读取失败：${escapeMarkdown(section.error)}` : null;
}

function tooltipMarkdown(state, options = {}) {
  const now = options.now || new Date();
  const snapshot = (state && state.snapshot) || {};
  const lines = [];
  const push = (line) => lines.push(line, '');

  if (state && state.notFound) {
    push('**TokenLedger**');
    push('$(warning) 找不到 `tokenledger-cli`。装好 TokenLedger 桌面端后，把命令行加进 PATH，或在设置 `tokenledger.cliPath` 里填它的完整路径。');
    push('[$(gear) 打开设置](command:tokenledger.openSettings)');
    return lines.join('\n').trim();
  }

  const status = valueOf(snapshot.status);
  push('**TokenLedger · 今日**');
  if (status && status.today) {
    const today = status.today;
    push(`预估费用 **${escapeMarkdown(formatEstimatedUsd(today.totalCost))}** · ${escapeMarkdown(formatTokens(today.totalTokens))} 有效 Token · ${escapeMarkdown(formatCount(today.totalRequests))} 次请求`);
  } else {
    const line = sectionErrorLine(snapshot.status, '今日用量');
    if (line) push(line);
  }

  // 额度条
  if (options.quotaEnabled === false) {
    push('**额度**  \n已在设置里关闭额度读取（`tokenledger.quota.enabled`）。');
  } else {
    const quota = valueOf(snapshot.quota);
    const rows = quotaRows(quota);
    const out = ['**额度**'];
    if (rows.length === 0 && !rows.pending) {
      out.push(sectionErrorLine(snapshot.quota, '额度') || '还没有可用的额度来源，可在桌面端「设置 · 订阅额度」里授权。');
    }
    for (const row of rows) {
      const name = escapeMarkdown(`${row.provider} ${row.window}`.trim());
      if (row.remainingPercent !== null && row.remainingPercent !== undefined) {
        const reset = formatResetsAt(row.resetsAt, now);
        out.push(`${LEVEL_ICONS[row.level]} ${name} \`${textBar(row.remainingPercent)}\` 可用 **${formatPercent(row.remainingPercent)}**${reset ? ` · ${reset}` : ''}${row.stale ? ' · 过期' : ''}`);
      } else if (row.amount) {
        out.push(`$(credit-card) ${name} · ${escapeMarkdown(row.amount)}${row.stale ? ' · 过期' : ''}`);
      } else {
        out.push(`$(circle-slash) ${name} · ${escapeMarkdown(row.note)}`);
      }
    }
    if (rows.pending > 0) {
      out.push(`${rows.length > 0 ? '另有 ' : ''}${rows.pending} 个来源未授权，可在桌面端「设置 · 订阅额度」里开启。`);
    }
    push(out.join('  \n'));
  }

  // 今日拆分
  const usage = valueOf(snapshot.usage);
  const agents = agentRows(usage);
  const usageOut = ['**今日拆分**'];
  if (agents.length === 0) usageOut.push(sectionErrorLine(snapshot.usage, '今日拆分') || '今天还没有记录。');
  for (const row of agents) {
    usageOut.push(`${escapeMarkdown(row.name)} · ${escapeMarkdown(formatEstimatedUsd(row.cost))} · ${escapeMarkdown(formatTokens(row.totalTokens))}`);
  }
  push(usageOut.join('  \n'));

  // 预算
  const budgets = budgetRows(valueOf(snapshot.budget), valueOf(snapshot.usage));
  const budgetOut = ['**预算**'];
  if (budgets.length === 0) budgetOut.push(sectionErrorLine(snapshot.budget, '预算') || '还没有启用的预算。');
  for (const row of budgets) {
    budgetOut.push(`${LEVEL_ICONS[row.level] || ''} ${escapeMarkdown(row.label)} · ${escapeMarkdown(row.used)} / ${escapeMarkdown(row.limit)}${row.percent === null ? '' : ` · ${formatPercent(row.percent)}`} · ${escapeMarkdown(row.levelLabel)}`);
  }
  push(budgetOut.join('  \n'));

  // 网关
  const gateway = gatewaySummary(valueOf(snapshot.gateway));
  const gatewayOut = ['**网关**'];
  if (!gateway) {
    gatewayOut.push(sectionErrorLine(snapshot.gateway, '网关') || '—');
  } else {
    const icon = { ok: '$(pass)', warn: '$(warning)', error: '$(error)', off: '$(circle-slash)' }[gateway.health];
    gatewayOut.push(`${icon} ${gateway.state}${gateway.state === '运行中' ? ` · 端口 ${gateway.port}` : ''} · 启用供应商 ${gateway.providers} · 路由组 ${formatCount(gateway.routingGroups)}`);
    if (gateway.recentCount > 0) {
      gatewayOut.push(`最近 ${gateway.recentCount} 次请求成功 ${gateway.recentOk} 次（${formatPercent(gateway.successPercent)}）`);
    }
    if (gateway.lastFailure) {
      const when = new Date(gateway.lastFailure.ts);
      gatewayOut.push(`最近一次失败：${Number.isNaN(when.getTime()) ? '' : `${formatClock(when)} `}${escapeMarkdown(gateway.lastFailure.member)} · ${escapeMarkdown(gateway.lastFailure.status)}`);
    }
    if (gateway.configError) gatewayOut.push(`$(error) 配置有误：${escapeMarkdown(gateway.configError)}`);
  }
  push(gatewayOut.join('  \n'));

  const footer = [];
  if (state && state.updatedAt) footer.push(`更新于 ${formatClock(state.updatedAt)}`);
  if (state && state.lastError) footer.push(`$(warning) 最近一次刷新失败：${escapeMarkdown(state.lastError)}`);
  footer.push('[$(refresh) 刷新](command:tokenledger.refresh)', '[$(open-preview) 详情](command:tokenledger.showDetails)');
  push(footer.join(' · '));
  return lines.join('\n').trim();
}

// ---------------------------------------------------------------- HTML（详情面板）

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// 面板的 CSP 不放行行内 style 属性，条宽用整数百分比的类（.w0–.w100，样式表里生成）。
function htmlBar(percent, level) {
  const width = Math.round(Math.max(0, Math.min(100, percent)));
  return `<div class="bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width}"><div class="fill ${level} w${width}"></div></div>`;
}

const WIDTH_RULES = Array.from({ length: 101 }, (_, index) => `.w${index}{width:${index}%}`).join('');

function detailsHtml(state, { nonce, cspSource, now = new Date(), quotaEnabled = true }) {
  const snapshot = (state && state.snapshot) || {};
  const status = valueOf(snapshot.status);
  const sections = [];
  const errorBlock = (section, label) => (section && section.error
    ? `<p class="muted">${escapeHtml(label)}读取失败：${escapeHtml(section.error)}</p>`
    : '');

  if (state && state.notFound) {
    sections.push('<section><h2>找不到命令行工具</h2><p>装好 TokenLedger 桌面端后，把 <code>tokenledger-cli</code> 加进 PATH，或在设置 <code>tokenledger.cliPath</code> 里填它的完整路径。</p><p><button data-command="openSettings">打开设置</button></p></section>');
  } else {
    const today = status && status.today;
    sections.push(`<section class="hero">
  <div><div class="label">今日预估费用</div><div class="big">${escapeHtml(formatEstimatedUsd(today ? today.totalCost : null))}</div></div>
  <div><div class="label">有效 Token</div><div class="big">${escapeHtml(formatTokens(today ? today.totalTokens : null))}</div></div>
  <div><div class="label">请求</div><div class="big">${escapeHtml(formatCount(today ? today.totalRequests : null))}</div></div>
</section>${today ? '' : errorBlock(snapshot.status, '今日用量')}`);

    let quotaBody;
    if (!quotaEnabled) {
      quotaBody = '<p class="muted">已在设置里关闭额度读取（tokenledger.quota.enabled）。</p>';
    } else {
      const rows = quotaRows(valueOf(snapshot.quota));
      const pendingNote = rows.pending > 0
        ? `<p class="muted small">${rows.length > 0 ? '另有 ' : ''}${rows.pending} 个来源未授权，可在桌面端「设置 · 订阅额度」里开启。</p>`
        : '';
      quotaBody = rows.length === 0
        ? (errorBlock(snapshot.quota, '额度') || pendingNote || '<p class="muted">还没有可用的额度来源，可在桌面端「设置 · 订阅额度」里授权。</p>')
        : rows.map((row) => {
          const name = `<span><span class="name">${escapeHtml(row.provider)}</span> <span class="muted">${escapeHtml(row.window)}</span></span>`;
          if (row.remainingPercent !== null && row.remainingPercent !== undefined) {
            const reset = formatResetsAt(row.resetsAt, now);
            return `<div class="row"><div class="line">${name}<span class="value ${row.level}">可用 ${escapeHtml(formatPercent(row.remainingPercent))}</span></div>${htmlBar(row.remainingPercent, row.level)}<div class="muted small">${escapeHtml(reset)}${row.stale ? ' · 过期' : ''}</div></div>`;
          }
          return `<div class="row"><div class="line">${name}<span class="value">${escapeHtml(row.amount || row.note)}</span></div></div>`;
        }).join('') + pendingNote;
    }
    sections.push(`<section><h2>额度</h2>${quotaBody}</section>`);

    const agents = agentRows(valueOf(snapshot.usage));
    sections.push(`<section><h2>今日拆分</h2>${agents.length === 0
      ? (errorBlock(snapshot.usage, '今日拆分') || '<p class="muted">今天还没有记录。</p>')
      : `<table><thead><tr><th>Agent</th><th class="num">预估费用</th><th class="num">有效 Token</th></tr></thead><tbody>${agents.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td class="num">${escapeHtml(formatEstimatedUsd(row.cost))}</td><td class="num">${escapeHtml(formatTokens(row.totalTokens))}</td></tr>`).join('')}</tbody></table>`}</section>`);

    const budgets = budgetRows(valueOf(snapshot.budget), valueOf(snapshot.usage));
    const budgetClass = { ok: 'ok', warn: 'warn', over: 'critical', unavailable: '' };
    sections.push(`<section><h2>预算</h2>${budgets.length === 0
      ? (errorBlock(snapshot.budget, '预算') || '<p class="muted">还没有启用的预算，可在桌面端「设置 · 预算」里添加。</p>')
      : budgets.map((row) => `<div class="row"><div class="line"><span class="name">${escapeHtml(row.label)}</span><span class="value ${budgetClass[row.level] || ''}">${escapeHtml(row.levelLabel)}</span></div>${row.percent === null ? '' : htmlBar(row.percent, budgetClass[row.level] || 'ok')}<div class="muted small">${escapeHtml(row.used)} / ${escapeHtml(row.limit)}${row.percent === null ? '' : ` · ${escapeHtml(formatPercent(row.percent))}`}</div></div>`).join('')}</section>`);

    const gateway = gatewaySummary(valueOf(snapshot.gateway));
    const healthClass = { ok: 'ok', warn: 'warn', error: 'critical', off: '' };
    sections.push(`<section><h2>网关</h2>${!gateway ? errorBlock(snapshot.gateway, '网关') : `<div class="line"><span class="name">${escapeHtml(gateway.state)}${gateway.state === '运行中' ? ` · 端口 ${escapeHtml(gateway.port)}` : ''}</span><span class="value ${healthClass[gateway.health]}">${gateway.successPercent === null ? '—' : `成功 ${escapeHtml(formatPercent(gateway.successPercent))}`}</span></div>
<p class="muted small">启用供应商 ${escapeHtml(gateway.providers)} · 路由组 ${escapeHtml(formatCount(gateway.routingGroups))}${gateway.recentCount > 0 ? ` · 最近 ${gateway.recentCount} 次请求成功 ${gateway.recentOk} 次` : ''}</p>${gateway.lastFailure ? `<p class="muted small">最近一次失败：${escapeHtml(gateway.lastFailure.member)} · ${escapeHtml(gateway.lastFailure.status)}</p>` : ''}${gateway.configError ? `<p class="critical small">配置有误：${escapeHtml(gateway.configError)}</p>` : ''}`}</section>`);
  }

  const footer = [];
  if (state && state.updatedAt) footer.push(`更新于 ${formatClock(state.updatedAt)}`);
  if (state && state.lastError) footer.push(`最近一次刷新失败：${escapeHtml(state.lastError)}`);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TokenLedger</title>
<style nonce="${nonce}">
  body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 16px 20px; max-width: 720px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  h1 { font-size: 1.3em; margin: 0; font-weight: 600; }
  h2 { font-size: 1em; font-weight: 600; margin: 0 0 8px; }
  section { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); padding: 12px 0; }
  .hero { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; border-top: none; }
  .label, .muted { color: var(--vscode-descriptionForeground); }
  .big { font-size: 1.6em; font-weight: 600; font-variant-numeric: tabular-nums; }
  .small { font-size: .9em; margin: 4px 0 0; }
  .row { margin-bottom: 10px; }
  .line { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .name { font-weight: 500; }
  .value { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bar { height: 6px; border-radius: 3px; background: var(--vscode-editorWidget-border, rgba(128,128,128,.3)); overflow: hidden; margin-top: 4px; }
  .fill { height: 100%; border-radius: 3px; background: var(--vscode-charts-green, #3fb950); }
  .fill.warn { background: var(--vscode-charts-yellow, #d29922); }
  .fill.critical { background: var(--vscode-charts-red, #f85149); }
  .value.ok { color: var(--vscode-charts-green, inherit); }
  .value.warn, .warn:not(.fill) { color: var(--vscode-charts-yellow, inherit); }
  .value.critical, .critical:not(.fill) { color: var(--vscode-charts-red, inherit); }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 500; color: var(--vscode-descriptionForeground); padding: 2px 0; }
  td { padding: 3px 0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 4px 12px; border-radius: 2px; cursor: pointer; font: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  footer { color: var(--vscode-descriptionForeground); font-size: .9em; padding-top: 8px; }
  @media (max-width: 420px) { .hero { grid-template-columns: 1fr; } }
  ${WIDTH_RULES}
</style>
</head>
<body>
<header><h1>TokenLedger · 今日</h1><button data-command="refresh">刷新</button></header>
${sections.join('\n')}
<footer>${footer.join(' · ')}</footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-command]');
    if (target) vscode.postMessage({ command: target.dataset.command });
  });
</script>
</body>
</html>`;
}

module.exports = {
  agentRows,
  budgetRows,
  detailsHtml,
  escapeHtml,
  escapeMarkdown,
  gatewaySummary,
  quotaLevel,
  quotaRows,
  statusBarModel,
  textBar,
  tooltipMarkdown,
  providerName,
  tightestProviderName,
  windowRemainingPercent,
};
