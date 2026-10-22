import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RULES, canonical, readEvidence, requiredGates } from './check-required-gates.mjs';

const gatesOf = (paths) => [...requiredGates(paths).keys()];

test('安卓 Kotlin 改动必须带上扫描安卓源码的前端契约门禁', () => {
  const gates = gatesOf([
    'apps/android/app/src/main/java/com/jeidorf/tokenledger/mobile/LedgerDashboardV2Ui.kt',
  ]);
  assert.ok(gates.includes('test:frontend'),
    'T10.118c 正是漏掉这一项才让长标识回归走完全流程');
  assert.ok(gates.includes('check:paths'));
  assert.ok(gates.includes('diff-check'));
});

test('小组件路径在安卓源码门禁之外再要预览资源门禁', () => {
  const gates = gatesOf([
    'apps/android/app/src/main/java/com/jeidorf/tokenledger/mobile/widget/WidgetLayout.kt',
  ]);
  assert.ok(gates.includes('test:frontend'));
  assert.ok(gates.includes('check:android:widget-previews'));
});

test('前端、Rust、云端与文档各自命中自己的门禁集合', () => {
  assert.deepEqual(
    gatesOf(['src/utils/contracts/statsQuery.ts']).filter((gate) => gate !== 'check:paths' && gate !== 'diff-check'),
    ['typecheck', 'lint', 'test:unit', 'test:frontend', 'build:web'],
  );
  assert.ok(gatesOf(['src-tauri/src/commands/mod.rs']).includes('lint:rust:clippy'));
  assert.ok(gatesOf(['supabase/migrations/20260906080642_add_dashboard_daily_costs.sql'])
    .includes('supabase-regression'));
  assert.ok(gatesOf(['docs/AGENTS.md']).includes('check:docs'));
  assert.ok(gatesOf(['docs/PROJECT.md']).includes('check:docs'));
  assert.ok(gatesOf(['package-lock.json']).includes('version:check'));
});

test('契约文档同时要求两端解析边界的验证', () => {
  const gates = gatesOf(['docs/contracts/dashboard-stats-v2.md']);
  assert.ok(gates.includes('typecheck'));
  assert.ok(gates.includes('test:frontend'));
  assert.ok(gates.includes('check:docs'), '契约文档也在 docs/ 下，文档门禁不能因更具体的规则而丢失');
});

test('每条规则都写明理由，规则表不允许出现无解释的强制项', () => {
  for (const rule of RULES) {
    assert.ok(rule.why && rule.why.length > 8, `${rule.id} 缺少可核查的理由`);
    assert.ok(rule.gates.length > 0, `${rule.id} 没有门禁`);
  }
});

test('gates.json 的短名映射到 npm 脚本名', () => {
  assert.equal(canonical('docs-check'), 'check:docs');
  assert.equal(canonical('range-diff-check'), 'diff-check');
  assert.equal(canonical('test:frontend'), 'test:frontend');
});

test('同名门禁出现多次时，失败不会被后一次成功掩盖', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenledger-gate-evidence-'));
  const file = path.join(directory, 'gates.json');
  try {
    fs.writeFileSync(file, JSON.stringify([
      { name: 'test:frontend', exitCode: 1 },
      { name: 'test:frontend', exitCode: 0 },
      { name: 'docs-check', exitCode: 0 },
    ]));
    const evidence = readEvidence([file]);
    assert.equal(evidence.get('test:frontend').exitCode, 1);
    assert.equal(evidence.get('check:docs').exitCode, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('仓库里的 stats 回归 SQL 必须真的被门禁脚本执行，不能只躺在目录里', () => {
  // T10.119 随 dailyCosts 一起加了 custom_date_range_regression.sql，却只在
  // supabase/README.md 里写「需单独执行」：改动路径推导出 supabase-regression，
  // 但那一步当时并不会跑这个文件，等于新契约扩展没有任何自动门禁把关。
  const runners = [
    fs.readFileSync('scripts/run-checks.mjs', 'utf8'),
    fs.readFileSync('scripts/run-supabase-release-gate.mjs', 'utf8'),
  ];
  const wired = [
    'stats_v2_regression.sql',
    'custom_date_range_regression.sql',
    'quota_snapshot_v2_regression.sql',
    'quota_snapshot_v3_regression.sql',
  ];
  for (const runner of runners) {
    for (const file of wired) {
      assert.ok(runner.includes(file), `门禁脚本没有执行 ${file}`);
    }
  }
  assert.ok(gatesOf(['supabase/tests/custom_date_range_regression.sql']).includes('supabase-regression'));
});

test('T10.118c 的真实交付证据会被判为缺少必跑门禁', () => {
  const evidence = readEvidence([
    'docs/task-logs/T10.118c/dev/chart-quota-r1/evidence/gates.json',
  ]);
  const required = gatesOf([
    'apps/android/app/src/main/java/com/jeidorf/tokenledger/mobile/LedgerDashboardV2Ui.kt',
  ]);
  const missing = required.filter((gate) => !evidence.has(gate));
  assert.ok(missing.includes('test:frontend'),
    '这份历史证据只有 docs-check / commit-check / diff-check，核对必须能指出缺口');
});
