'use strict';

// 与看板、托盘共用的黄金用例：插件写出的 Token 与费用必须与它们逐字相同。
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { formatEstimatedUsd, formatPercent, formatResetsAt, formatTokens } = require('../src/format');

const fixtures = path.resolve(__dirname, '..', '..', '..', 'fixtures');
const tokenCases = require(path.join(fixtures, 'token-format-v1', 'cases.json')).cases;
const usdCases = require(path.join(fixtures, 'estimated-usd-format-v1', 'cases.json')).cases;

test('Token 缩写与 fixtures/token-format-v1 逐字一致', () => {
  for (const { input, expected } of tokenCases) {
    assert.equal(formatTokens(input), expected, `input ${input}`);
  }
});

test('预估费用与 fixtures/estimated-usd-format-v1 逐字一致', () => {
  for (const { input, expected } of usdCases) {
    assert.equal(formatEstimatedUsd(input === null ? null : Number(input)), expected, `input ${input}`);
  }
});

test('百分比与命令行同一写法', () => {
  assert.equal(formatPercent(37), '37%');
  assert.equal(formatPercent(85.4), '85.4%');
  assert.equal(formatPercent(14.02), '14%');
  assert.equal(formatPercent(null), '—');
});

test('重置时间按远近换写法', () => {
  const now = new Date('2026-10-24T10:00:00Z');
  assert.equal(formatResetsAt('2026-10-24T10:42:00Z', now), '42 分钟后重置');
  assert.equal(formatResetsAt('2026-10-24T11:35:00Z', now), '1 小时 35 分后重置');
  assert.equal(formatResetsAt('2026-10-24T12:00:00Z', now), '2 小时后重置');
  assert.equal(formatResetsAt('2026-10-24T09:00:00Z', now), '已到重置时间');
  assert.match(formatResetsAt('2026-10-28T10:00:00Z', now), /^\d\d-\d\d \d\d:\d\d 重置$/);
  assert.equal(formatResetsAt(undefined, now), '');
  assert.equal(formatResetsAt('不是时间', now), '');
});
