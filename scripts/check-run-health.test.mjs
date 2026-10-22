import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_STALL_THRESHOLD_SECONDS,
  TERMINAL_STATUSES,
  classifyRunStatus,
  evaluateHealth,
  matchSessionFile,
  normalizeRuns,
  parseAnchorDate,
  parseArgs,
  parseDaemonLog,
  readLastToolCalls,
  resolveLogAnchor,
  runEvidence,
  selectRun,
} from './check-run-health.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-run-health.mjs');

// 受控快照（真实 daemon.log 的切片）与它的固定读者：判定必须在新 checkout 上复现，
// 因此锚点写在快照头部，不继承 clone/checkout 会重写的 mtime。
const SNAPSHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SNAPSHOT_LOG = path.join(SNAPSHOT_DIR, 'run-health-daemon-slice.txt');
const SNAPSHOT_RUNS = path.join(SNAPSHOT_DIR, 'run-health-jeid37-runs.json');
const SNAPSHOT_SHA256 = '171a45dad6d1ee944903f0e15321fa7d8eae666b4ca242fa3b3f0cba5b6e6168';

// 夹具里的时间一律用“本地墙钟”构造：daemon.log 的行只有 HH:MM:SS.mmm，
// 日期由文件 mtime 反推，所以夹具必须自己固定 mtime，判定才能与真实时区无关。
const FIXTURE_DAY = { year: 2026, month: 9, day: 17 };
const RUN_ID = '01a0adb4-8ecc-7f1c-b348-d0f29fd98292';
const RUN_TAIL = RUN_ID.split('-').pop();
const ISSUE_ID = '01a0ad93-55db-7ef1-8ddb-cc28b3e5f662';

function localIso(hour, minute, second, ms = 0) {
  return new Date(FIXTURE_DAY.year, FIXTURE_DAY.month - 1, FIXTURE_DAY.day, hour, minute, second, ms).toISOString();
}

function clock(hour, minute, second, ms = 0) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(ms, 3)}`;
}

function daemonLine(hour, minute, second, ms, level, message) {
  return `${clock(hour, minute, second, ms)} ${level} ${message}`;
}

function fixtureDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `run-health-${name}-`));
}

function withMtime(file, date) {
  fs.utimesSync(file, date, date);
  return file;
}

function writeDaemonLog(dir, lines, mtime) {
  const file = path.join(dir, 'daemon.log');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return withMtime(file, mtime);
}

function writeRunsJson(dir, runs) {
  const file = path.join(dir, 'runs.json');
  fs.writeFileSync(file, JSON.stringify(runs, null, 2));
  return file;
}

function sessionFileName(startedAt) {
  const date = new Date(startedAt);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}.000000000.jsonl`;
}

function writeSession(dir, { startedAt, cwd, calls }) {
  const file = path.join(dir, sessionFileName(startedAt));
  const entries = [
    { type: 'session', version: 3, id: 'session-fixture', timestamp: startedAt, cwd },
    {
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: startedAt,
      message: {
        role: 'assistant',
        content: calls.map((call, index) => ({
          type: 'toolCall',
          id: `call_${index}`,
          name: call.tool,
          arguments: call.arguments,
        })),
      },
    },
  ];
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return file;
}

// 与 JEID-37 事故同形的夹具：起跑、两批工具、然后 1h43m 静默，最后人工取消。
function hungRunFixture() {
  const dir = fixtureDir('hung');
  const startedAt = localIso(13, 0, 0);
  const lines = [
    daemonLine(13, 0, 0, 10, 'DBG', `task wakeup received component=daemon runtime_id=r1 task_id=${RUN_ID}`),
    daemonLine(13, 0, 0, 20, 'INF', `picked task component=daemon task=${RUN_ID} issue=${ISSUE_ID} agent=fixture provider=pi`),
    daemonLine(13, 0, 5, 100, 'DBG', `reported task messages component=daemon task=${RUN_ID} count=1 last_seq=4`),
    daemonLine(13, 0, 9, 200, 'INF', `tool #1: bash component=daemon task=${RUN_ID}`),
    daemonLine(13, 0, 9, 300, 'DBG', `reported task messages component=daemon task=${RUN_ID} count=1 last_seq=17`),
    // 事故之后的人工取消：这些行不得被当成“还有产出”。
    daemonLine(14, 43, 29, 581, 'INF', `task reached terminal state server-side, interrupting agent component=daemon task=${RUN_ID} status=cancelled`),
    daemonLine(14, 43, 29, 582, 'INF', `agent finished component=daemon task=${RUN_ID} status=cancelled duration=1h43m29s tools=6`),
    daemonLine(14, 43, 30, 846, 'INF', `execenv: local worktree finalized component=daemon task=${RUN_ID} produced_work=false`),
  ];
  const daemonLog = writeDaemonLog(dir, lines, new Date(FIXTURE_DAY.year, FIXTURE_DAY.month - 1, FIXTURE_DAY.day, 14, 43, 30));
  const sessionsDir = path.join(dir, 'pi-sessions');
  fs.mkdirSync(sessionsDir);
  writeSession(sessionsDir, {
    startedAt,
    cwd: `C:\\ws\\jeid-37-${RUN_TAIL}\\worktree`,
    calls: [
      { tool: 'bash', arguments: { command: 'cat skills-lock.json | head -50; find / -type d -name "x" 2>/dev/null | head' } },
      { tool: 'bash', arguments: { command: 'git log --oneline -5 2>/dev/null' } },
    ],
  });
  const runsJson = writeRunsJson(dir, [
    { id: RUN_ID, issue_id: ISSUE_ID, status: 'running', started_at: startedAt, completed_at: null },
  ]);
  return { dir, daemonLog, runsJson, sessionsDir, startedAt };
}

function runScript(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------- 纯函数

test('参数默认值：停滞阈值 900 秒，CLI 默认为 multica', () => {
  const options = parseArgs(['--issue', ISSUE_ID]);
  assert.equal(options.stallThresholdSeconds, DEFAULT_STALL_THRESHOLD_SECONDS);
  assert.equal(DEFAULT_STALL_THRESHOLD_SECONDS, 900);
  assert.equal(options.multica, 'multica');
  assert.throws(() => parseArgs(['--issue']), /缺少取值/u);
  assert.throws(() => parseArgs(['--nope']), /未知参数/u);
  assert.throws(() => parseArgs(['--stall-threshold-seconds', '-5']), /非负数/u);
});

test('状态分类：在飞与终态取自 CLI 自己的 --active 词汇表', () => {
  for (const status of ['queued', 'dispatched', 'running', 'waiting_local_directory']) {
    assert.equal(classifyRunStatus(status), 'in-flight', status);
  }
  for (const status of ['completed', 'failed', 'cancelled']) {
    assert.equal(classifyRunStatus(status), 'terminal', status);
  }
  assert.equal(classifyRunStatus(''), 'unknown');
});

// T10.145 返工项：第一版把「非空且不在在飞集合里」一律当终态，于是 `unrecognized-status`
// 分支只在 status 为空时才可达。平台新增一种在飞状态就会报「已结束、无需处置」。
test('状态分类：非空但不在双白名单里的状态归 unknown，不得静默算终态', () => {
  for (const status of ['quantum', 'hibernating', 'resting', 'awaiting_approval']) {
    assert.equal(classifyRunStatus(status), 'unknown', status);
  }
  // 对照：已知集合不受影响——不是「把所有非空状态都打成 unknown」。
  for (const status of ['queued', 'dispatched', 'running', 'waiting_local_directory', 'pending', 'in_progress']) {
    assert.equal(classifyRunStatus(status), 'in-flight', status);
  }
  for (const status of ['completed', 'failed', 'cancelled', 'canceled', 'aborted', 'idle_watchdog']) {
    assert.equal(classifyRunStatus(status), 'terminal', status);
  }
  // 没有观测样本的终止命名一律不写进白名单：宁可 unknown/2，也不猜一个可能是在飞状态的终态名。
  for (const status of ['timeout', 'timed_out', 'expired', 'succeeded']) {
    assert.equal(classifyRunStatus(status), 'unknown', status);
    assert.equal(TERMINAL_STATUSES.includes(status), false, status);
  }
  // 终态白名单不得混进任何在飞取值，否则又会把在飞 run 报成已结束。
  for (const status of ['queued', 'dispatched', 'running', 'waiting_local_directory']) {
    assert.equal(TERMINAL_STATUSES.includes(status), false, status);
  }
  // 大小写与空白不影响判定
  assert.equal(classifyRunStatus(' Running '), 'in-flight');
  assert.equal(classifyRunStatus('Completed'), 'terminal');
  assert.equal(classifyRunStatus(' Quantum '), 'unknown');
});

test('run 选择：显式 run 支持短前缀，缺省优先最新在飞 run', () => {
  const runs = normalizeRuns([
    { id: `${RUN_ID}`, status: 'cancelled' },
    { id: '01a0ae25-acaa-72c3-aa57-e0f3a91a3da9', status: 'running' },
  ]);
  assert.equal(selectRun(runs, '01a0adb4').id, RUN_ID);
  assert.equal(selectRun(runs).id, '01a0ae25-acaa-72c3-aa57-e0f3a91a3da9');
  assert.equal(selectRun(runs, 'deadbeef'), null);
});

test('daemon 日志：无日期行按 mtime 反推，跨零点时日期递减', () => {
  const lines = [
    daemonLine(23, 59, 59, 0, 'DBG', `reported task messages component=daemon task=${RUN_ID} count=1 last_seq=1`),
    daemonLine(0, 0, 1, 0, 'DBG', `reported task messages component=daemon task=${RUN_ID} count=1 last_seq=2`),
  ];
  const entries = parseDaemonLog(`${lines.join('\n')}\n`, {
    mtimeMs: new Date(FIXTURE_DAY.year, FIXTURE_DAY.month - 1, FIXTURE_DAY.day, 0, 0, 2).getTime(),
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].at.getDate(), FIXTURE_DAY.day - 1);
  assert.equal(entries[0].at.getHours(), 23);
  assert.equal(entries[1].at.getDate(), FIXTURE_DAY.day);
  assert.equal(entries[1].lastSeq, 2);
});

// JEID-46：daemon 的并发写入会让相邻两行出现毫秒级逆序（本机真实日志里 8 次回退中 7 次如此）。
// 旧口径「任何回退即加一天」会把活动时刻往前推 N 天，于是刚出过活的 run 被报 stalled —— 误杀方向。
test('daemon 日志：活动行之后的毫秒逆序行不得把日期往前推（JEID-46 的误报成因）', () => {
  const activity = daemonLine(12, 51, 41, 946, 'DBG', `reported task messages component=daemon task=${RUN_ID} count=3 last_seq=17`);
  const noise = [
    daemonLine(19, 45, 11, 15, 'DBG', 'reported task messages component=daemon task=other-a count=1 last_seq=168'),
    daemonLine(19, 45, 11, 14, 'DBG', 'reported task messages component=daemon task=other-b count=3 last_seq=4'),
  ];
  const mtimeMs = new Date(FIXTURE_DAY.year, FIXTURE_DAY.month - 1, FIXTURE_DAY.day, 19, 45, 12).getTime();

  const clean = parseDaemonLog(`${activity}\n`, { mtimeMs });
  const noisy = parseDaemonLog(`${[activity, ...noise].join('\n')}\n`, { mtimeMs });
  assert.equal(noisy.length, 3);
  // 活动行的时刻与日期都不变；逆序行自己也不得被推成前一天
  assert.equal(noisy[0].at.getTime(), clean[0].at.getTime());
  assert.equal(noisy[0].at.getDate(), FIXTURE_DAY.day);
  assert.equal(noisy[0].at.getHours(), 12);
  assert.equal(noisy[2].at.getDate(), FIXTURE_DAY.day);

  // 判定层：加一行毫秒逆序行之前/之后，停滞秒数与判定必须一致（健康在飞 run 不得被误报 stalled）
  const dir = fixtureDir('ms-noise');
  const runsJson = writeRunsJson(dir, [
    { id: RUN_ID, issue_id: ISSUE_ID, status: 'running', started_at: localIso(12, 51, 33), completed_at: null },
  ]);
  const probe = (lines) => {
    const daemonLog = writeDaemonLog(dir, lines, new Date(mtimeMs));
    return runScript([
      '--issue', ISSUE_ID,
      '--run', RUN_ID,
      '--runs-json', runsJson,
      '--daemon-log', daemonLog,
      '--sessions-dir', path.join(dir, 'none'),
      '--now', localIso(12, 55, 41, 946),
      '--json',
    ]);
  };
  const before = probe([activity]);
  const after = probe([activity, ...noise]);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(after.status, 0, after.stderr);
  const beforePayload = JSON.parse(before.stdout);
  const afterPayload = JSON.parse(after.stdout);
  assert.equal(afterPayload.status, 'healthy');
  assert.equal(afterPayload.stallSeconds, 240);
  assert.equal(afterPayload.lastActivityAt, localIso(12, 51, 41, 946));
  assert.deepEqual(
    { status: afterPayload.status, stallSeconds: afterPayload.stallSeconds, lastActivityAt: afterPayload.lastActivityAt },
    { status: beforePayload.status, stallSeconds: beforePayload.stallSeconds, lastActivityAt: beforePayload.lastActivityAt },
  );
});

// JEID-46：只把「大幅回退」当跨零点，不得把日内噪声当跨天；真跨零点（含连续多次回退）仍逐日递减。
test('daemon 日志：真跨零点仍逐日递减，日内毫秒噪声不额外加天', () => {
  const messages = [
    daemonLine(23, 59, 58, 0, 'DBG', 'heartbeat: 前一天末尾'),
    daemonLine(0, 0, 5, 0, 'DBG', 'heartbeat: 跨零点后'),
    daemonLine(0, 0, 6, 0, 'DBG', 'heartbeat: 同日'),
    daemonLine(0, 0, 5, 500, 'DBG', 'heartbeat: 并发写入造成的 0.5s 逆序'),
    daemonLine(23, 59, 59, 0, 'DBG', 'heartbeat: 同日末尾'),
    daemonLine(0, 0, 7, 0, 'DBG', 'heartbeat: 文件最后一行所在日'),
  ];
  const entries = parseDaemonLog(messages.join('\n'), {
    mtimeMs: new Date(FIXTURE_DAY.year, FIXTURE_DAY.month - 1, FIXTURE_DAY.day, 0, 0, 8).getTime(),
  });
  assert.deepEqual(
    entries.map((entry) => [entry.at.getMonth() + 1, entry.at.getDate(), entry.hour, entry.minute, entry.second, entry.ms]),
    [
      [9, FIXTURE_DAY.day - 2, 23, 59, 58, 0],
      [9, FIXTURE_DAY.day - 1, 0, 0, 5, 0],
      [9, FIXTURE_DAY.day - 1, 0, 0, 6, 0],
      [9, FIXTURE_DAY.day - 1, 0, 0, 5, 500],
      [9, FIXTURE_DAY.day - 1, 23, 59, 59, 0],
      [9, FIXTURE_DAY.day, 0, 0, 7, 0],
    ],
  );
});

test('daemon 日志：只有回退 ≥ 6h 才算跨零点（阈值是闭区间下界）', () => {
  const mtimeMs = new Date(FIXTURE_DAY.year, FIXTURE_DAY.month - 1, FIXTURE_DAY.day, 0, 0, 1).getTime();
  const resolve = (first) => parseDaemonLog(
    `${[first, daemonLine(0, 0, 0, 0, 'DBG', 'heartbeat')].join('\n')}\n`,
    { mtimeMs },
  );
  // 06:00 → 00:00 正好回退 6h：算跨零点
  const exact = resolve(daemonLine(6, 0, 0, 0, 'DBG', 'heartbeat'));
  assert.equal(exact[0].at.getDate(), FIXTURE_DAY.day - 1);
  assert.equal(exact[0].at.getHours(), 6);
  // 05:59:59.999 → 00:00 回退 6h - 1ms：不算跨零点
  const short = resolve(daemonLine(5, 59, 59, 999, 'DBG', 'heartbeat'));
  assert.equal(short[0].at.getDate(), FIXTURE_DAY.day);
  assert.equal(short[0].at.getHours(), 5);
});

test('活动证据：终态行不计入活动时间，但会被单独报出来', () => {
  const lines = [
    daemonLine(13, 0, 9, 300, 'DBG', `reported task messages component=daemon task=${RUN_ID} count=1 last_seq=17`),
    daemonLine(14, 43, 29, 582, 'INF', `agent finished component=daemon task=${RUN_ID} status=cancelled duration=1h43m29s`),
  ];
  const entries = parseDaemonLog(lines.join('\n'), {
    mtimeMs: new Date(FIXTURE_DAY.year, FIXTURE_DAY.month - 1, FIXTURE_DAY.day, 14, 43, 30).getTime(),
  });
  const evidence = runEvidence(entries, RUN_ID);
  assert.equal(evidence.lastSeq, 17);
  assert.equal(evidence.lastActivityAt.getHours(), 13);
  assert.equal(evidence.teardownStatus, 'cancelled');
});

test('判定：停滞看最后活动时间与阈值，终态 run 一律 finished', () => {
  const liveness = {
    lastActivityAt: new Date(localIso(13, 0, 9)),
    lastSeq: 17,
    lastActivityLine: 'DBG reported task messages',
  };
  const base = {
    issue: ISSUE_ID,
    liveness,
    thresholdSeconds: 900,
    daemonLog: { file: 'daemon.log', state: 'ok' },
    session: null,
    toolCalls: null,
  };
  const running = { id: RUN_ID, status: 'running', startedAt: localIso(13, 0, 0), completedAt: null };

  const healthy = evaluateHealth({ ...base, run: running, now: new Date(localIso(13, 10, 0)) });
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.exitCode, 0);
  assert.equal(healthy.stallSeconds, 591);

  // 阈值是闭区间下界：正好 900s 即判停滞，避免把“刚好卡在门线上”当健康。
  const boundary = evaluateHealth({ ...base, run: running, now: new Date(localIso(13, 15, 9)) });
  assert.equal(boundary.stallSeconds, 900);
  assert.equal(boundary.status, 'stalled');
  assert.equal(boundary.exitCode, 1);

  const terminal = evaluateHealth({
    ...base,
    run: { ...running, status: 'cancelled', completedAt: localIso(14, 43, 29) },
    now: new Date(localIso(15, 0, 0)),
  });
  assert.equal(terminal.status, 'finished');
  assert.equal(terminal.exitCode, 0);
  assert.equal(terminal.stallSeconds, null);

  const noEvidence = evaluateHealth({
    ...base,
    run: running,
    liveness: { lastActivityAt: null },
    now: new Date(localIso(13, 10, 0)),
  });
  assert.equal(noEvidence.status, 'unknown');
  assert.equal(noEvidence.exitCode, 2);
  assert.equal(noEvidence.reason, 'no-liveness-evidence');

  const noRun = evaluateHealth({ ...base, run: null, now: new Date(localIso(13, 10, 0)) });
  assert.equal(noRun.status, 'unknown');
  assert.equal(noRun.reason, 'no-run');
});

test('会话文件：先按 run 尾段匹配 cwd，再退回起跑时间最近的一支', () => {
  const dir = fixtureDir('session');
  const startedAt = localIso(13, 0, 0);
  writeSession(dir, { startedAt, cwd: `C:\\ws\\jeid-37-${RUN_TAIL}\\worktree`, calls: [] });
  writeSession(dir, { startedAt: localIso(14, 0, 0), cwd: 'C:\\ws\\other\\worktree', calls: [] });

  const matched = matchSessionFile({ sessionsDir: dir, runId: RUN_ID, startedAt });
  assert.equal(matched.matchedBy, 'cwd-run-tail');
  assert.equal(path.basename(matched.file), sessionFileName(startedAt));

  const byTime = matchSessionFile({
    sessionsDir: dir,
    runId: '01a0ae25-acaa-72c3-aa57-000000000000',
    startedAt,
  });
  assert.equal(byTime.matchedBy, 'started-at');

  assert.equal(matchSessionFile({ sessionsDir: path.join(dir, 'missing'), runId: RUN_ID, startedAt }), null);
});

test('会话文件：最后一批工具调用可解析，缺文件与无调用都如实返回', () => {
  const dir = fixtureDir('tools');
  const file = writeSession(dir, {
    startedAt: localIso(13, 0, 0),
    cwd: 'C:\\ws\\x\\worktree',
    calls: [
      { tool: 'bash', arguments: { command: 'ls .pi/skills' } },
      { tool: 'read', arguments: { path: 'AGENTS.md' } },
    ],
  });
  const parsed = readLastToolCalls(file);
  assert.equal(parsed.state, 'ok');
  assert.deepEqual(parsed.calls, [
    { tool: 'bash', summary: 'ls .pi/skills' },
    { tool: 'read', summary: 'AGENTS.md' },
  ]);
  assert.equal(readLastToolCalls(path.join(dir, 'nope.jsonl')).state, 'unreadable');
  const empty = writeSession(dir, { startedAt: localIso(14, 0, 0), cwd: 'C:\\ws\\x\\worktree', calls: [] });
  assert.equal(readLastToolCalls(empty).state, 'no-tool-call');
});

// ---------------------------------------------------------------- CLI 端到端

test('CLI：夹具回放判出 stalled，退出码 1，并给出 run、会话文件与最后工具调用', () => {
  const fixture = hungRunFixture();
  const now = new Date(localIso(15, 0, 0));
  const result = runScript([
    '--issue', ISSUE_ID,
    '--run', RUN_ID,
    '--runs-json', fixture.runsJson,
    '--daemon-log', fixture.daemonLog,
    '--sessions-dir', fixture.sessionsDir,
    '--now', now.toISOString(),
    '--json',
  ]);
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'stalled');
  assert.equal(
    payload.stallSeconds,
    Math.round((now.getTime() - new Date(localIso(13, 0, 9, 300)).getTime()) / 1000),
  );
  assert.ok(payload.stallSeconds > 900);
  assert.equal(payload.lastSeq, 17);
  assert.equal(payload.lastMessageReportedAt, localIso(13, 0, 9, 300));
  assert.equal(payload.session.matchedBy, 'cwd-run-tail');
  assert.equal(payload.lastToolCalls.length, 2);
  assert.match(payload.lastToolCalls[0].summary, /find \/ -type d/u);
  assert.equal(payload.daemonTeardownStatus, 'cancelled');
  assert.ok(payload.notes.some((note) => note.includes('两个状态源不一致')), payload.notes.join('|'));
});

test('CLI：未识别状态判 unknown/2 并点出该状态，已知在飞/终态仍按原契约判定', () => {
  const fixture = hungRunFixture();
  const probe = (status) => {
    const runsJson = writeRunsJson(fixture.dir, [
      { id: RUN_ID, issue_id: ISSUE_ID, status, started_at: fixture.startedAt, completed_at: null },
    ]);
    const result = runScript([
      '--issue', ISSUE_ID,
      '--run', RUN_ID,
      '--runs-json', runsJson,
      '--daemon-log', fixture.daemonLog,
      '--sessions-dir', fixture.sessionsDir,
      '--now', localIso(15, 0, 0),
      '--json',
    ]);
    return { result, payload: JSON.parse(result.stdout) };
  };

  // 1. 未识别状态：既不得当在飞，也不得静默当终态。
  const unrecognized = probe('quantum');
  assert.equal(unrecognized.result.status, 2, unrecognized.result.stderr);
  assert.equal(unrecognized.payload.status, 'unknown');
  assert.equal(unrecognized.payload.exitCode, 2);
  assert.equal(unrecognized.payload.reason, 'unrecognized-status');
  assert.match(unrecognized.payload.message, /状态 quantum 未识别/u);
  assert.equal(unrecognized.payload.run.status, 'quantum');

  // 2. 对照：同一份证据、同一个时刻，仅状态不同 —— 在飞仍走停滞判定。
  const inFlight = probe('running');
  assert.equal(inFlight.result.status, 1, inFlight.result.stderr);
  assert.equal(inFlight.payload.status, 'stalled');
  assert.equal(inFlight.payload.exitCode, 1);
  assert.equal(
    inFlight.payload.stallSeconds,
    Math.round((new Date(localIso(15, 0, 0)).getTime() - new Date(localIso(13, 0, 9, 300)).getTime()) / 1000),
  );

  // 3. 对照：显式已知终态仍判 finished/0。
  const terminal = probe('completed');
  assert.equal(terminal.result.status, 0, terminal.result.stderr);
  assert.equal(terminal.payload.status, 'finished');
  assert.equal(terminal.payload.exitCode, 0);
  assert.equal(terminal.payload.stallSeconds, null);
});

test('CLI：--run 短前缀且未给 --issue 时，note 说的是 issue 未推断，而不是 run 状态解析不了', () => {
  const dir = fixtureDir('shortrun');
  const startedAt = localIso(13, 0, 0);
  // 这份 daemon.log 只有心跳，没有 `picked task … issue=`，所以 issue 推断不出来；
  // 但 run 与它的状态由 --runs-json 正常提供。
  const daemonLog = writeDaemonLog(
    dir,
    [daemonLine(13, 0, 9, 300, 'DBG', `reported task messages component=daemon task=${RUN_ID} count=1 last_seq=5`)],
    new Date(FIXTURE_DAY.year, FIXTURE_DAY.month - 1, FIXTURE_DAY.day, 13, 0, 10),
  );
  const runsJson = writeRunsJson(dir, [
    { id: RUN_ID, issue_id: ISSUE_ID, status: 'running', started_at: startedAt, completed_at: null },
  ]);

  const result = runScript([
    '--run', '01a0adb4',
    '--runs-json', runsJson,
    '--daemon-log', daemonLog,
    '--sessions-dir', path.join(dir, 'none'),
    '--now', localIso(13, 5, 0),
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.issue, null);
  assert.equal(payload.run.id, RUN_ID); // 短前缀已解析出 run
  assert.equal(payload.status, 'healthy'); // 状态已由 --runs-json 判定
  assert.ok(payload.notes.some((note) => note.includes('无法推断所属 issue')), payload.notes.join('|'));
  assert.equal(payload.notes.some((note) => note.includes('无法解析 run 状态')), false, payload.notes.join('|'));
});

test('CLI：同一份历史证据在 04:55 时刻应判 healthy，而不是把未来当现在', () => {
  const fixture = hungRunFixture();
  const result = runScript([
    '--issue', ISSUE_ID,
    '--runs-json', fixture.runsJson,
    '--daemon-log', fixture.daemonLog,
    '--sessions-dir', fixture.sessionsDir,
    '--now', localIso(13, 0, 15),
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'healthy');
  assert.equal(payload.stallSeconds, 6);
  assert.equal(payload.daemonTeardownAt, null);
  assert.equal(payload.notes.length, 0);
});

test('CLI：--run 未配 --issue 时从 daemon 日志推断 issue，推断不到则 unknown/2', () => {
  const fixture = hungRunFixture();
  const inferred = runScript([
    '--run', RUN_ID,
    '--runs-json', fixture.runsJson,
    '--daemon-log', fixture.daemonLog,
    '--sessions-dir', fixture.sessionsDir,
    '--now', localIso(15, 0, 0),
    '--json',
  ]);
  assert.equal(inferred.status, 1, inferred.stderr);
  assert.equal(JSON.parse(inferred.stdout).issue, ISSUE_ID);

  const stray = runScript([
    '--run', '00000000-0000-0000-0000-000000000000',
    '--runs-json', fixture.runsJson,
    '--daemon-log', fixture.daemonLog,
    '--now', localIso(15, 0, 0),
    '--json',
  ]);
  assert.equal(stray.status, 2, stray.stderr);
  const payload = JSON.parse(stray.stdout);
  assert.equal(payload.status, 'unknown');
  assert.equal(payload.reason, 'no-run');
});

test('CLI：缺 multica CLI 时退化为 unknown/2，不静默通过', () => {
  const dir = fixtureDir('nocl');
  const daemonLog = writeDaemonLog(dir, [], new Date());
  const result = runScript([
    '--issue', ISSUE_ID,
    '--multica', path.join(dir, 'multica-does-not-exist'),
    '--daemon-log', daemonLog,
    '--now', localIso(15, 0, 0),
    '--json',
  ]);
  assert.equal(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'unknown');
  assert.ok(payload.notes.some((note) => note.includes('无法取得 run 列表')), payload.notes.join('|'));
});

test('CLI：daemon.log 不可读按 unknown/2 处理，不崩溃', () => {
  const fixture = hungRunFixture();
  const result = runScript([
    '--issue', ISSUE_ID,
    '--runs-json', fixture.runsJson,
    '--daemon-log', path.join(fixture.dir, 'missing-daemon.log'),
    '--sessions-dir', fixture.sessionsDir,
    '--now', localIso(15, 0, 0),
    '--json',
  ]);
  assert.equal(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'unknown');
  assert.equal(payload.reason, 'no-liveness-evidence');
  assert.equal(payload.daemonLog.state, 'unreadable');
  assert.ok(payload.notes.some((note) => note.includes('daemon.log 不存在或不可读')), payload.notes.join('|'));
});

test('CLI：已结束的 run 判 finished，退出码 0，且不把历史活动算成停滞', () => {
  const dir = fixtureDir('finished');
  const lines = [
    daemonLine(13, 0, 5, 100, 'DBG', `reported task messages component=daemon task=${RUN_ID} count=1 last_seq=9`),
    daemonLine(13, 0, 6, 100, 'INF', `agent finished component=daemon task=${RUN_ID} status=completed`),
  ];
  const daemonLog = writeDaemonLog(dir, lines, new Date(FIXTURE_DAY.year, FIXTURE_DAY.month - 1, FIXTURE_DAY.day, 13, 0, 7));
  const runsJson = writeRunsJson(dir, [
    { id: RUN_ID, issue_id: ISSUE_ID, status: 'completed', started_at: localIso(12, 0, 0), completed_at: localIso(13, 0, 6) },
  ]);
  const result = runScript([
    '--issue', ISSUE_ID,
    '--runs-json', runsJson,
    '--daemon-log', daemonLog,
    '--sessions-dir', path.join(dir, 'none'),
    '--now', localIso(18, 0, 0),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /run 健康度：finished/u);
  assert.match(result.stdout, /已结束（status=completed/u);
});

test('CLI：真实 multica CLI 路径可解析 runs 列表（缺 CLI 时同一路径给出 unknown）', (t) => {
  const probe = spawnSync('multica', ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    t.skip('本机没有 multica CLI，CLI 解析路径由缺 CLI 用例覆盖');
    return;
  }
  const result = runScript(['--issue', ISSUE_ID, '--json']);
  assert.ok([0, 1, 2].includes(result.status), result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(['healthy', 'stalled', 'finished', 'unknown'].includes(payload.status));
});

test('CLI：受控快照自带 anchor-date，同一快照不同 mtime 下判定与停滞秒数一致（JEID-46 硬要求）', () => {
  // 快照受控：改一个字节就必须同步更新本文与文档里的 SHA-256
  assert.equal(
    createHash('sha256').update(fs.readFileSync(SNAPSHOT_LOG)).digest('hex'),
    SNAPSHOT_SHA256,
    'scripts/fixtures/run-health-daemon-slice.txt 与登记的 SHA-256 不一致',
  );

  // 锚点优先级：头部 anchor-date > 文件 mtime；--daemon-log-date 最强
  const text = fs.readFileSync(SNAPSHOT_LOG, 'utf8');
  const otherDay = new Date(2020, 0, 1, 12, 0, 0).getTime();
  assert.equal(resolveLogAnchor({ text, mtimeMs: otherDay }).anchorSource, 'header');
  assert.equal(resolveLogAnchor({ text, mtimeMs: otherDay }).anchorDate, '2026-09-17');
  assert.equal(resolveLogAnchor({ text, mtimeMs: otherDay, explicitDate: '2026-09-18' }).anchorSource, 'flag');
  assert.equal(resolveLogAnchor({ text, mtimeMs: otherDay, explicitDate: '2026-09-18' }).anchorDate, '2026-09-18');
  const bare = resolveLogAnchor({ text: '12:00:00.000 INF heartbeat\n', mtimeMs: new Date(2026, 8, 12, 3).getTime() });
  assert.equal(bare.anchorSource, 'mtime');
  assert.equal(bare.anchorDate, '2026-09-12');
  assert.equal(parseAnchorDate('2026-09-17').day, 17);
  assert.equal(parseAnchorDate('2026-02-31'), null);
  assert.equal(parseAnchorDate('2026-9-1'), null);
  assert.equal(parseAnchorDate(''), null);
  assert.throws(() => parseArgs(['--daemon-log-date', '2026-9-1']), /YYYY-MM-DD/u);

  const probe = ({ mtime, now, extra = [] }) => {
    const dir = fixtureDir('snapshot');
    const copy = path.join(dir, 'daemon-slice.txt');
    fs.copyFileSync(SNAPSHOT_LOG, copy);
    fs.utimesSync(copy, mtime, mtime);
    const result = runScript([
      '--issue', ISSUE_ID,
      '--run', RUN_ID,
      '--runs-json', SNAPSHOT_RUNS,
      '--daemon-log', copy,
      '--sessions-dir', path.join(dir, 'none'),
      '--now', now,
      '--json',
      ...extra,
    ]);
    return { result, payload: JSON.parse(result.stdout) };
  };

  // 交付记录里的 5898s：同一份快照、两个不同 mtime（含模拟新 checkout 的 2020-01-01）得到同一结论
  const stalledFresh = probe({ mtime: new Date(2020, 0, 1), now: '2026-09-17T06:30:00Z' });
  const stalledToday = probe({ mtime: new Date(FIXTURE_DAY.year, FIXTURE_DAY.month - 1, FIXTURE_DAY.day, 20, 11, 0), now: '2026-09-17T06:30:00Z' });
  for (const { result, payload } of [stalledFresh, stalledToday]) {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(payload.status, 'stalled');
    assert.equal(payload.stallSeconds, 5898);
    assert.equal(payload.lastActivityAt, '2026-09-17T04:51:41.946Z');
    assert.equal(payload.lastSeq, 17);
    assert.equal(payload.daemonLog.anchorDate, '2026-09-17');
    assert.equal(payload.daemonLog.anchorSource, 'header');
  }
  assert.deepEqual(
    { s: stalledFresh.payload.stallSeconds, at: stalledFresh.payload.lastActivityAt },
    { s: stalledToday.payload.stallSeconds, at: stalledToday.payload.lastActivityAt },
  );

  // 同一快照在 198s 时刻判 healthy —— 交付记录里的两个数字都在快照上可复现
  for (const mtime of [new Date(2020, 0, 1), new Date(FIXTURE_DAY.year, FIXTURE_DAY.month - 1, FIXTURE_DAY.day, 20, 11, 0)]) {
    const { result, payload } = probe({ mtime, now: '2026-09-17T04:55:00Z' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(payload.status, 'healthy');
    assert.equal(payload.stallSeconds, 198);
    assert.equal(payload.lastActivityAt, '2026-09-17T04:51:41.946Z');
  }

  // 显式锚点与快照头部一致时用显式值；不一致时以命令行参数为准并把冲突说出来
  const explicitSame = probe({ mtime: new Date(2020, 0, 1), now: '2026-09-17T06:30:00Z', extra: ['--daemon-log-date', '2026-09-17'] });
  assert.equal(explicitSame.payload.stallSeconds, 5898);
  assert.equal(explicitSame.payload.daemonLog.anchorSource, 'flag');
  assert.equal(explicitSame.payload.notes.some((note) => note.includes('不一致')), false, explicitSame.payload.notes.join('|'));

  const conflicting = probe({ mtime: new Date(2020, 0, 1), now: '2026-09-17T06:30:00Z', extra: ['--daemon-log-date', '2026-09-18'] });
  assert.equal(conflicting.payload.daemonLog.anchorDate, '2026-09-18');
  assert.equal(conflicting.payload.daemonLog.anchorSource, 'flag');
  assert.equal(conflicting.payload.stallSeconds, 0);
  assert.ok(
    conflicting.payload.notes.some((note) => note.includes('anchor-date 2026-09-17') && note.includes('不一致')),
    conflicting.payload.notes.join('|'),
  );
});

test('CLI：缺参数时打印用法并以 2 退出', () => {
  const result = runScript([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /必须给出 --issue/u);
});
