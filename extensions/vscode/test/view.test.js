'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sample = require('./fixtures/snapshot.json');
const {
  agentRows,
  budgetRows,
  detailsHtml,
  escapeMarkdown,
  gatewaySummary,
  quotaRows,
  statusBarModel,
  textBar,
  tooltipMarkdown,
} = require('../src/view');

const NOW = new Date('2026-10-24T10:00:00Z');

function stateFrom(sections, extra = {}) {
  const snapshot = {};
  for (const [key, value] of Object.entries(sections)) snapshot[key] = { value };
  return { snapshot, updatedAt: NOW, lastError: null, notFound: false, ...extra };
}

const full = stateFrom({ status: sample.status, usage: sample.usage, budget: sample.budget, gateway: sample.gateway, quota: sample.quota });

test('状态栏默认显示今日费用，写法与托盘相同', () => {
  const model = statusBarModel(full, 'cost');
  assert.equal(model.text, '$(graph) ≈$2.56');
  assert.equal(model.severity, 'warning'); // 预算 85.4% 接近上限
  assert.match(model.accessibility, /今日预估费用 ≈\$2\.56/);
});

test('状态栏可改为最紧额度的可用%，来源用看板同一个短名', () => {
  assert.equal(statusBarModel(full, 'quota').text, '$(dashboard) Claude 14%');
  assert.equal(statusBarModel(full, 'both').text, '$(graph) ≈$2.56  $(dashboard) Claude 14%');
  // 没有额度列表时用命令行给的名字。
  const noList = stateFrom({ status: sample.status });
  assert.equal(statusBarModel(noList, 'quota').text, '$(dashboard) Claude consumer usage 14%');
  // 没有可读额度时退回费用。
  const noQuota = stateFrom({ status: { ...sample.status, quota: null, budget: null } });
  assert.equal(statusBarModel(noQuota, 'quota').text, '$(graph) ≈$2.56');
  assert.equal(statusBarModel(noQuota, 'quota').severity, null);
});

test('费用不可得写「不可得」，不写 $0', () => {
  const state = stateFrom({ status: { ...sample.status, today: { ...sample.status.today, totalCost: null }, budget: null, quota: null } });
  assert.equal(statusBarModel(state, 'cost').text, '$(graph) 不可得');
});

test('底色：预算超出为错误，额度低于 20% 为警告', () => {
  const over = stateFrom({ status: { ...sample.status, budget: { ...sample.status.budget, level: 'over' } } });
  assert.equal(statusBarModel(over, 'cost').severity, 'error');
  const lowQuota = stateFrom({ status: { ...sample.status, budget: null } });
  assert.equal(statusBarModel(lowQuota, 'cost').severity, 'warning');
  const fine = stateFrom({ status: { ...sample.status, budget: null, quota: { ...sample.status.quota, remainingPercent: 60 } } });
  assert.equal(statusBarModel(fine, 'cost').severity, null);
});

test('找不到命令行与读取失败时状态栏给提示', () => {
  assert.equal(statusBarModel({ snapshot: null, notFound: true }, 'cost').text, '$(warning) TokenLedger');
  assert.match(tooltipMarkdown({ snapshot: null, notFound: true }), /tokenledger\.cliPath/);
  assert.match(tooltipMarkdown({ snapshot: null, notFound: true }), /command:tokenledger\.openSettings/);
  const failed = { snapshot: { status: { error: '账本打不开' } }, updatedAt: NOW };
  assert.equal(statusBarModel(failed, 'cost').severity, 'warning');
  assert.match(tooltipMarkdown(failed, { now: NOW }), /今日用量读取失败：账本打不开/);
});

test('额度条：百分比窗口给可用%，余额写剩余量，未授权只计数，不支持的不列', () => {
  const rows = quotaRows(sample.quota);
  assert.deepEqual(rows.map((row) => `${row.provider}|${row.window}`), [
    'Codex|5 hour window',
    'Codex|7 day window',
    'Codex|Credits balance',
    'Claude|5 hour window',
    '自建额度|',
  ]);
  assert.equal(rows[0].remainingPercent, 62);
  assert.equal(rows[0].level, 'ok');
  // 没有 remaining 时按 100 - used，与命令行同一条规则；过期照样显示并标出。
  assert.equal(rows[1].remainingPercent, 36);
  assert.equal(rows[1].level, 'warn');
  assert.equal(rows[1].stale, true);
  assert.equal(rows[2].remainingPercent, null);
  assert.equal(rows[2].amount, '余 12.50 Credits');
  assert.equal(rows[3].level, 'critical');
  assert.equal(rows[4].note, '出错');
  assert.equal(rows.pending, 1);
});

test('今日拆分：前 5 名，其余并成「其他」，有费用不可得时合计不可得', () => {
  const rows = agentRows(sample.usage);
  assert.equal(rows.length, 6);
  assert.equal(rows[5].name, '其他 2 个');
  assert.equal(rows[5].totalTokens, 1075);
  assert.equal(rows[5].cost, null);
});

test('预算：Agent 范围换成显示名，费用与 Token 分开写', () => {
  const rows = budgetRows(sample.budget, sample.usage);
  assert.deepEqual(rows.map((row) => [row.label, row.used, row.limit, row.levelLabel]), [
    ['今日 · 全部用量', '≈$2.56', '$3.00', '接近上限'],
    ['本月 · Agent · Claude', '46.1K', '2.00M', '正常'],
  ]);
});

test('网关：运行中、成功率与最近一次失败', () => {
  const gateway = gatewaySummary(sample.gateway);
  assert.equal(gateway.state, '运行中');
  assert.equal(gateway.health, 'warn');
  assert.equal(gateway.providers, '2/3');
  assert.equal(gateway.successPercent, 75);
  assert.deepEqual(gateway.lastFailure, { ts: '2026-10-24T09:58:00Z', status: 429, member: 'p2/m2' });
  assert.equal(gatewaySummary({ ...sample.gateway, running: false, modelAccessEnabled: false, recent: [] }).state, '未开启');
  assert.equal(gatewaySummary({ ...sample.gateway, running: false, recent: [] }).state, '未运行');
  assert.equal(gatewaySummary({ ...sample.gateway, configError: 'bad' }).health, 'error');
});

test('悬停卡片含四个区块与刷新、详情链接', () => {
  const markdown = tooltipMarkdown(full, { now: NOW });
  for (const heading of ['**TokenLedger · 今日**', '**额度**', '**今日拆分**', '**预算**', '**网关**']) {
    assert.ok(markdown.includes(heading), heading);
  }
  assert.match(markdown, /Claude 5 hour window `▰▱▱▱▱▱▱▱▱▱` 可用 \*\*14%\*\* · 42 分钟后重置/);
  assert.match(markdown, /1 个来源未授权/);
  assert.match(markdown, /最近 4 次请求成功 3 次（75%）/);
  assert.match(markdown, /command:tokenledger\.refresh/);
  assert.match(markdown, /command:tokenledger\.showDetails/);
});

test('关闭额度时卡片写明，不显示额度条', () => {
  const markdown = tooltipMarkdown(full, { now: NOW, quotaEnabled: false });
  assert.match(markdown, /已在设置里关闭额度读取/);
  assert.ok(!markdown.includes('▰'));
});

test('某一项失败只影响自己的区块，并在底部标出最近一次失败', () => {
  const state = stateFrom({ status: sample.status, usage: sample.usage, quota: sample.quota }, { lastError: '超时' });
  state.snapshot.budget = { error: '预算读不了' };
  state.snapshot.gateway = { error: '网关读不了' };
  const markdown = tooltipMarkdown(state, { now: NOW });
  assert.match(markdown, /预算读取失败：预算读不了/);
  assert.match(markdown, /网关读取失败：网关读不了/);
  assert.match(markdown, /最近一次刷新失败：超时/);
  assert.match(markdown, /Codex 5 hour window/);
});

test('详情面板：CSP 只放行带 nonce 的脚本与样式，名字转义', () => {
  const html = detailsHtml(full, { nonce: 'abc123', cspSource: 'vscode-resource:', now: NOW });
  assert.match(html, /default-src 'none'; style-src vscode-resource: 'nonce-abc123'; script-src 'nonce-abc123';/);
  assert.ok(!/style="/.test(html), '不用行内 style 属性（会被 CSP 拦掉）');
  assert.match(html, /aria-valuenow="14"/);
  assert.match(html, /class="fill critical w14"/);
  assert.match(html, /可用 62%/);
  assert.match(html, /接近上限/);
  assert.match(html, /成功 75%/);
  const missing = detailsHtml({ snapshot: null, notFound: true }, { nonce: 'n', cspSource: 'x' });
  assert.match(missing, /找不到命令行工具/);
  assert.match(missing, /data-command="openSettings"/);
});

test('Agent 名里的 Markdown 与 HTML 字符被转义', () => {
  const usage = { ...sample.usage, breakdown: { ...sample.usage.breakdown, rows: [{ id: 'x', name: '<img src=x>[a](command:evil)', totalTokens: 1, cost: 0 }] } };
  const state = stateFrom({ status: sample.status, usage });
  const markdown = tooltipMarkdown(state, { now: NOW });
  assert.ok(markdown.includes('\\<img src=x\\>\\[a\\]\\(command:evil\\)'));
  const html = detailsHtml(state, { nonce: 'n', cspSource: 'x', now: NOW });
  assert.ok(html.includes('&lt;img src=x&gt;'));
  assert.ok(!html.includes('<img'));
});

test('转义与文字条', () => {
  assert.equal(escapeMarkdown('[a](b)'), '\\[a\\]\\(b\\)');
  assert.equal(textBar(0), '▱▱▱▱▱▱▱▱▱▱');
  assert.equal(textBar(100), '▰▰▰▰▰▰▰▰▰▰');
  assert.equal(textBar(150), '▰▰▰▰▰▰▰▰▰▰');
});
