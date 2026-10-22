#!/usr/bin/env node
// run 健康探针：把「这条 run 是不是已经不再产出」从人工发现变成可执行判定。
//
// 背景（JEID-38）：run `01a0adb4-8ecc-7f1c-b348-d0f29fd98292` 在 2026-09-17T04:51:41.946Z
// 之后 1h43m 零输出，服务器侧状态一直是 running，直到人工取消；期间 0 评论、0 提交，
// 没有任何自动信号提示「它已经不再产出」。本脚本给出该信号。
//
// 数据源（全部本地读取，脚本自身不发任何网络请求）：
//   1. `multica issue runs <issue> --output json` 的 status / started_at / completed_at。
//   2. daemon 心跳日志 `~/.multica/profiles/<profile>/daemon.log` 里的
//      `reported task messages ... task=<run> last_seq=N`，以及同一 run 的最后一条非终态行。
//   3. `<sessions-dir>/<UTC 时间戳>.jsonl` 会话文件（默认 `~/.multica/pi-sessions`）里的最后一条工具调用。
//
// 用法：
//   node scripts/check-run-health.mjs --issue <issue-id> [--json]
//   node scripts/check-run-health.mjs --run <run-id> [--issue <issue-id>] [--json]
//
// 日期推导（JEID-46 修正）：daemon.log 的行只有 HH:MM:SS.mmm，没有日期。最后一行所属的自然日
// 由锚点给出，优先级 `--daemon-log-date` > 文件头部 `# anchor-date: YYYY-MM-DD`（受控快照自带，
// 不继承 clone/checkout 会重写的 mtime）> 文件 mtime。往回走时只有回退 ≥ 6h 才算跨过零点：
// daemon 的并发写入会让相邻行出现毫秒级逆序（本机实测 0.001s–31.189s），把一条逆序行当成一天
// 会把活动时刻往前推 N 天，健康的在飞 run 就被报成 stalled——正是本探针要消灭的误杀方向。
//
// 退出码：0 = healthy 或 finished，1 = stalled，2 = unknown（缺 CLI、缺日志、日志不可读、状态未识别、证据不足）。
// unknown 不是通过：CI 上没有 `multica` CLI 时本脚本退化为 unknown/2，不会假绿。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_STALL_THRESHOLD_SECONDS = 900;

// 跨零点判定阈值：两行之间只有「大幅回退」才算跨过零点。daemon 的并发写入造成的逆序实测
// 0.001s–31.189s，真跨零点实测 86394.324s（≈24h），两者相差三个数量级，6h 落在中间且两边都有余量。
// 残留局限（runbook §4 有说明）：若同一份文件里出现 >18h 的静默缺口跨过零点，回退量会小于 6h
// 而不被识别为跨天；历史回放请用 `--daemon-log-date` 或自带 `# anchor-date:` 的受控快照显式锚定。
export const DAY_CROSSING_MIN_BACKWARD_MS = 6 * 60 * 60 * 1000;

// 受控快照可以在文件头部自带日期锚点，取值是「最后一条日志行所属的本地自然日」：
//   # anchor-date: 2026-09-17
// 这样新 checkout 不依赖 mtime 也能复现判定（clone/checkout 会把 mtime 改写成当天）。
export const LOG_ANCHOR_LINE = /^\s*#\s*anchor-date:\s*(\d{4}-\d{2}-\d{2})\s*$/u;

const ANCHOR_SOURCE_LABEL = {
  flag: '--daemon-log-date',
  header: '快照头部 anchor-date',
  mtime: '文件 mtime',
};

// 判定用「双白名单」：显式已知在飞集合 + 显式已知终态集合。两个集合都不匹配的非空状态
// 一律归 unknown/2，不得静默算终态——平台一旦新增一种在飞状态，静默算终态就会报
// 「已结束、无需处置」，正是本探针要消灭的假绿（T10.145 返工项）。
//
// 在飞状态 `multica issue runs --active` 的文档集合（queued / dispatched / running /
// waiting_local_directory），外加队列别名 `pending` / `in_progress`。
export const IN_FLIGHT_STATUSES = [
  'queued',
  'dispatched',
  'running',
  'waiting_local_directory',
  'pending',
  'in_progress',
];

// 终态状态：只列**实测观测到**的取值，每条都写明来源。未列入者（包括尚未观测到的终止命名，
// 如 `timeout` / `timed_out`）一律归 unknown —— 猜一个终态名与原来的兜底同样可能把在飞状态
// 报成已结束（若平台把该名字用作在飞状态），而少列一个只会多报一次 unknown/2（安全方向）。
// 新增取值前先在本机发出证据（`multica issue runs --output json` 或 daemon.log），再往这里加。
export const TERMINAL_STATUSES = [
  'completed', // 实测：`multica issue runs --output json`（本机 36 个 issue 采样）
  'failed', // 实测：同上
  'cancelled', // 实测：同上（服务器侧终态 / 人工取消）
  'canceled', // 同义拼写（无观测样本，但只影响同一个语义）
  'aborted', // 实测：daemon.log `pi finished … status=aborted`
  'idle_watchdog', // 实测：daemon.log `agent finished … status=idle_watchdog`（空闲看门狗强停）
];

export const EXIT_CODES = { healthy: 0, finished: 0, stalled: 1, unknown: 2 };

const HEALTHY = 'healthy';
const STALLED = 'stalled';
const FINISHED = 'finished';
const UNKNOWN = 'unknown';

const DAEMON_LINE = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(TRC|DBG|INF|WRN|ERR)\s+(.*)$/u;
const SESSION_FILE_NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d+)$/u;

// 终态行不算「还活着」：它们只在 run 结束时出现，计入活动时间会掩盖真实停滞
// （JEID-37 的 `execenv: local worktree finalized` 就发生在人工取消之后）。
const TERMINAL_MARKERS = [
  /agent finished/u,
  /agent result detail/u,
  /task reached terminal state/u,
  /task cancelled/u,
  /discarding result/u,
  /local worktree finalized/u,
  /execenv:/u,
  /task_phase=(?:finished|turn_completed|interrupted|aborted)\b/u,
];
const TERMINAL_STATUS = /status=([A-Za-z][\w-]*)/u;

function oneLine(text, limit = 300) {
  const flat = String(text).replace(/\s+/gu, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

// ---------------------------------------------------------------- 参数

export function parseArgs(argv) {
  const options = {
    issue: null,
    run: null,
    json: false,
    stallThresholdSeconds: DEFAULT_STALL_THRESHOLD_SECONDS,
    daemonLog: null,
    daemonLogDate: null,
    sessionsDir: null,
    profile: null,
    multica: 'multica',
    runsJson: null,
    now: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`参数 ${arg} 缺少取值`);
      return argv[index];
    };
    if (arg === '--issue') options.issue = next();
    else if (arg === '--run') options.run = next();
    else if (arg === '--json') options.json = true;
    else if (arg === '--stall-threshold-seconds') options.stallThresholdSeconds = Number(next());
    else if (arg === '--daemon-log') options.daemonLog = next();
    else if (arg === '--daemon-log-date') options.daemonLogDate = next();
    else if (arg === '--sessions-dir') options.sessionsDir = next();
    else if (arg === '--profile') options.profile = next();
    else if (arg === '--multica') options.multica = next();
    else if (arg === '--runs-json') options.runsJson = next();
    else if (arg === '--now') options.now = next();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isFinite(options.stallThresholdSeconds) || options.stallThresholdSeconds < 0) {
    throw new Error('--stall-threshold-seconds 必须是非负数');
  }
  if (options.daemonLogDate && !parseAnchorDate(options.daemonLogDate)) {
    throw new Error('--daemon-log-date 必须是 YYYY-MM-DD（例如 2026-09-17）');
  }
  return options;
}

// ---------------------------------------------------------------- runs 列表

export function normalizeRuns(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.runs) ? payload.runs : null;
  if (!list) throw new Error('runs 数据的顶层既不是数组也没有 runs 数组');
  return list.map((entry) => ({
    id: String(entry.id ?? entry.run_id ?? ''),
    status: String(entry.status ?? ''),
    startedAt: entry.started_at ?? entry.startedAt ?? null,
    completedAt: entry.completed_at ?? entry.completedAt ?? null,
    issue: entry.issue_id ?? entry.issueId ?? null,
    agentId: entry.agent_id ?? entry.agentId ?? null,
    kind: entry.kind ?? null,
  })).filter((entry) => entry.id);
}

// `--run` 允许写短前缀（`multica issue cancel-task` 也接受短 ID）。
export function selectRun(runs, runId) {
  if (!runId) {
    // 未指定 run：优先最新的在飞 run，否则最新的 run（runs 默认最新在前）。
    const inFlight = runs.find((entry) => classifyRunStatus(entry.status) === 'in-flight');
    return inFlight ?? runs[0] ?? null;
  }
  const exact = runs.find((entry) => entry.id === runId);
  if (exact) return exact;
  const matches = runs.filter((entry) => entry.id.startsWith(runId));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`run 前缀 ${runId} 命中 ${matches.length} 条 run，无法唯一解析`);
  return null;
}

// 返回 'in-flight' | 'terminal' | 'unknown'。第三个取值是调用方必须处理的真实分支：
// 非空但不在任何一个已知集合里的状态（如平台新引入的 `quantum`）既不能当在飞，也不能当终态。
export function classifyRunStatus(status) {
  const value = String(status ?? '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (IN_FLIGHT_STATUSES.includes(value)) return 'in-flight';
  if (TERMINAL_STATUSES.includes(value)) return 'terminal';
  return 'unknown';
}

export function readRunsFromCli(multicaCommand, issueId) {
  // 夹具或非标准安装可以用 .mjs/.js/.cjs 脚本顶替 CLI（测试用），否则按原样执行。
  const useNode = /\.(mjs|cjs|js)$/u.test(multicaCommand);
  const command = useNode ? process.execPath : multicaCommand;
  const args = useNode
    ? [multicaCommand, 'issue', 'runs', issueId, '--output', 'json']
    : ['issue', 'runs', issueId, '--output', 'json'];
  const result = spawnSync(command, args, { encoding: 'utf8', env: process.env });
  if (result.error) return { state: 'unavailable', detail: result.error.message, runs: null };
  if (result.status !== 0) {
    return {
      state: 'failed',
      detail: oneLine(result.stderr || `退出码 ${result.status}`),
      runs: null,
    };
  }
  try {
    return { state: 'ok', detail: null, runs: normalizeRuns(JSON.parse(result.stdout)) };
  } catch (error) {
    return { state: 'failed', detail: oneLine(error.message), runs: null };
  }
}

// ---------------------------------------------------------------- 日期锚点

// 解析 `YYYY-MM-DD`，非法或不存在的日期（如 2026-02-31）返回 null。
export function parseAnchorDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
  return { year, month, day };
}

export function formatAnchorDate(target) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${target.year}-${pad(target.month)}-${pad(target.day)}`;
}

// 只认文件头部（第一条真实日志行之前）的 `# anchor-date:`，避免日志正文里的同名文本被当成锚点。
export function findHeaderAnchor(text) {
  for (const line of String(text).split(/\r?\n/u)) {
    if (DAEMON_LINE.test(line)) break;
    const match = LOG_ANCHOR_LINE.exec(line);
    if (match) return parseAnchorDate(match[1]);
  }
  return null;
}

// 锚点优先级：--daemon-log-date > 快照头部 anchor-date > 文件 mtime。
export function resolveLogAnchor({ text, mtimeMs, explicitDate = null }) {
  const base = new Date(Number.isFinite(mtimeMs) ? mtimeMs : Date.now());
  const mtimeDate = formatAnchorDate({
    year: base.getFullYear(),
    month: base.getMonth() + 1,
    day: base.getDate(),
  });
  const header = findHeaderAnchor(text);
  const explicit = parseAnchorDate(explicitDate);
  const chosen = explicit ?? header ?? null;
  return {
    anchorDate: chosen ? formatAnchorDate(chosen) : mtimeDate,
    anchorSource: explicit ? 'flag' : header ? 'header' : 'mtime',
    headerDate: header ? formatAnchorDate(header) : null,
    mtimeDate,
  };
}

// ---------------------------------------------------------------- daemon 日志

export function parseDaemonLog(text, { mtimeMs, anchorDate } = {}) {
  const entries = [];
  const lines = String(text).split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const match = DAEMON_LINE.exec(lines[index]);
    if (!match) continue;
    const [, hh, mm, ss, ms, level, message] = match;
    const taskMatch = /(?:^|\s)task=(\S+)/u.exec(message);
    const seqMatch = /(?:^|\s)last_seq=(\d+)/u.exec(message);
    const issueMatch = /(?:^|\s)(?:issue|target)=(0[0-9a-f]{7}-[0-9a-f-]{27})/u.exec(message);
    entries.push({
      lineNo: index + 1,
      timeMs: ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + Number(ms),
      hour: Number(hh),
      minute: Number(mm),
      second: Number(ss),
      ms: Number(ms),
      level,
      message,
      task: taskMatch ? taskMatch[1] : null,
      lastSeq: seqMatch ? Number(seqMatch[1]) : null,
      issue: issueMatch ? issueMatch[1] : null,
      terminal: TERMINAL_MARKERS.some((pattern) => pattern.test(message)),
      at: null,
    });
  }
  // daemon.log 的行只有 HH:MM:SS.mmm，没有日期。锚点给出最后一行的自然日，然后从末尾往回走：
  // 只有回退 ≥ DAY_CROSSING_MIN_BACKWARD_MS（6h）才算跨过零点，毫秒级逆序是并发写入的噪声。
  const anchor = parseAnchorDate(anchorDate);
  const base = anchor
    ? new Date(anchor.year, anchor.month - 1, anchor.day)
    : new Date(Number.isFinite(mtimeMs) ? mtimeMs : Date.now());
  let dayOffset = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (index < entries.length - 1) {
      const backwardMs = entries[index].timeMs - entries[index + 1].timeMs;
      if (backwardMs >= DAY_CROSSING_MIN_BACKWARD_MS) dayOffset += 1;
    }
    const entry = entries[index];
    entry.at = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() - dayOffset,
      entry.hour,
      entry.minute,
      entry.second,
      entry.ms,
    );
  }
  return entries;
}

export function runEvidence(entries, runId) {
  const mine = entries.filter((entry) => entry.task === runId);
  const heartbeats = mine.filter((entry) => entry.lastSeq !== null);
  const alive = mine.filter((entry) => !entry.terminal);
  const lastHeartbeat = heartbeats.at(-1) ?? null;
  const lastActivity = alive.at(-1) ?? null;
  const teardown = mine.filter((entry) => entry.terminal).at(-1) ?? null;
  const statusLine = mine.filter((entry) => entry.terminal && TERMINAL_STATUS.test(entry.message)).at(-1) ?? null;
  const teardownStatus = statusLine ? TERMINAL_STATUS.exec(statusLine.message) : null;
  return {
    lineCount: mine.length,
    heartbeatCount: heartbeats.length,
    lastSeq: lastHeartbeat?.lastSeq ?? null,
    lastMessageReportedAt: lastHeartbeat?.at ?? null,
    lastActivityAt: lastActivity?.at ?? null,
    lastActivityLine: lastActivity ? oneLine(`${lastActivity.level} ${lastActivity.message}`) : null,
    // 本地 daemon 已收尾但服务器仍说在飞，是两个状态源不一致，必须说出来而不是静默。
    teardownAt: teardown?.at ?? null,
    teardownStatus: teardownStatus ? teardownStatus[1] : null,
    issue: mine.map((entry) => entry.issue).find(Boolean) ?? null,
  };
}

export function resolveProfileLog({ profile, explicitPath }) {
  if (explicitPath) return explicitPath;
  const root = path.join(os.homedir(), '.multica', 'profiles');
  if (profile) return path.join(root, profile, 'daemon.log');
  let candidates = [];
  try {
    candidates = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, 'daemon.log'))
      .filter((file) => fs.existsSync(file));
  } catch {
    return path.join(root, 'daemon.log');
  }
  if (candidates.length === 0) return path.join(root, 'daemon.log');
  // 多个 profile 时取最近写入的那个：daemon 正在跑的那份日志就是它。
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

export function loadDaemonLog(file, { explicitDate = null } = {}) {
  try {
    const stat = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8');
    const anchor = resolveLogAnchor({ text, mtimeMs: stat.mtimeMs, explicitDate });
    return {
      state: 'ok',
      file,
      anchorDate: anchor.anchorDate,
      anchorSource: anchor.anchorSource,
      headerAnchorDate: anchor.headerDate,
      mtimeAnchorDate: anchor.mtimeDate,
      entries: parseDaemonLog(text, { anchorDate: anchor.anchorDate }),
    };
  } catch (error) {
    return { state: 'unreadable', file, detail: oneLine(error.message), entries: [] };
  }
}

// ---------------------------------------------------------------- 会话文件

export function readSessionHead(file) {
  try {
    const handle = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(16 * 1024);
      const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, read).toString('utf8').split('\n')[0];
      const parsed = JSON.parse(firstLine);
      return {
        id: parsed.id ? String(parsed.id) : null,
        cwd: parsed.cwd ? String(parsed.cwd) : null,
        timestamp: parsed.timestamp ?? null,
      };
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
}

export function matchSessionFile({ sessionsDir, runId, startedAt, toleranceSeconds = 600 }) {
  if (!sessionsDir) return null;
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return null;
  }
  const tail = runId.split('-').pop();
  const startMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const candidates = [];
  for (const name of names) {
    const match = SESSION_FILE_NAME.exec(name.replace(/\.jsonl$/u, ''));
    if (!match) continue;
    const [, year, month, day, hh, mm, ss] = match;
    const fileMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hh), Number(mm), Number(ss));
    const file = path.join(sessionsDir, name);
    const head = readSessionHead(file);
    // worktree 目录名形如 `jeid-38-e0f3a91a3da9`（run id 末段），会话 cwd 指向该目录下的 `worktree`，
    // 所以按路径段而非 basename 比对。
    const cwdMatchesRun = Boolean(tail) && Boolean(head?.cwd)
      && head.cwd.split(/[\\/]/u).some((segment) => segment.endsWith(`-${tail}`));
    const deltaMs = Number.isNaN(startMs) ? null : Math.abs(fileMs - startMs);
    candidates.push({
      file,
      name,
      sessionId: head?.id ?? null,
      cwd: head?.cwd ?? null,
      cwdMatchesRun,
      deltaMs,
    });
  }
  const byCwd = candidates.filter((entry) => entry.cwdMatchesRun)
    .sort((a, b) => (a.deltaMs ?? Number.MAX_SAFE_INTEGER) - (b.deltaMs ?? Number.MAX_SAFE_INTEGER));
  if (byCwd.length > 0) return { ...byCwd[0], matchedBy: 'cwd-run-tail' };
  const byTime = candidates
    .filter((entry) => entry.deltaMs !== null && entry.deltaMs <= toleranceSeconds * 1000)
    .sort((a, b) => a.deltaMs - b.deltaMs);
  if (byTime.length > 0) return { ...byTime[0], matchedBy: 'started-at' };
  return null;
}

export function readLastToolCalls(file, { maxCalls = 4 } = {}) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean);
  } catch (error) {
    return { state: 'unreadable', detail: oneLine(error.message) };
  }
  let last = null;
  let total = 0;
  let lastTimestamp = null;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'message') continue;
    if (entry.timestamp) lastTimestamp = entry.timestamp;
    const calls = (entry.message?.content ?? []).filter((part) => part?.type === 'toolCall');
    if (entry.message?.role !== 'assistant' || calls.length === 0) continue;
    total += calls.length;
    last = { at: entry.timestamp ?? null, calls };
  }
  if (!last) {
    return { state: 'no-tool-call', lineCount: lines.length, lastTimestamp, calls: [], totalCalls: 0 };
  }
  return {
    state: 'ok',
    at: last.at ?? lastTimestamp,
    totalCalls: total,
    truncated: last.calls.length > maxCalls,
    calls: last.calls.slice(0, maxCalls).map((call) => {
      const args = call.arguments ?? {};
      const summary = typeof args.command === 'string'
        ? args.command
        : typeof args.path === 'string'
          ? args.path
          : JSON.stringify(args);
      return { tool: String(call.name ?? 'unknown'), summary: oneLine(summary) };
    }),
  };
}

// ---------------------------------------------------------------- 判定

export function evaluateHealth(input) {
  const {
    issue,
    run,
    liveness,
    now,
    thresholdSeconds,
    daemonLog,
    session,
    toolCalls,
    notes = [],
  } = input;
  const base = {
    issue: issue ?? null,
    run: run
      ? {
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      }
      : null,
    stallThresholdSeconds: thresholdSeconds,
    stallSeconds: null,
    lastSeq: liveness?.lastSeq ?? null,
    lastMessageReportedAt: liveness?.lastMessageReportedAt ? liveness.lastMessageReportedAt.toISOString() : null,
    lastActivityAt: liveness?.lastActivityAt ? liveness.lastActivityAt.toISOString() : null,
    lastActivityLine: liveness?.lastActivityLine ?? null,
    daemonTeardownAt: liveness?.teardownAt ? liveness.teardownAt.toISOString() : null,
    daemonTeardownStatus: liveness?.teardownStatus ?? null,
    startedSecondsAgo: liveness?.startedSecondsAgo ?? null,
    session: session
      ? { file: session.file, sessionId: session.sessionId, cwd: session.cwd, matchedBy: session.matchedBy }
      : null,
    lastToolCallAt: toolCalls?.at ?? null,
    lastToolCalls: toolCalls?.calls ?? null,
    daemonLog,
    notes: [...notes],
  };

  if (!run) {
    return {
      ...base,
      status: UNKNOWN,
      exitCode: EXIT_CODES.unknown,
      reason: 'no-run',
      message: issue
        ? `issue ${issue} 没有任何 run 记录，无法判定健康度`
        : '既没有可解析的 run，也没有足够的本地证据',
    };
  }

  const kind = classifyRunStatus(run.status);
  if (kind === 'terminal') {
    return {
      ...base,
      status: FINISHED,
      exitCode: EXIT_CODES.finished,
      reason: 'run-terminal',
      message: `run ${run.id} 已结束（status=${run.status || 'unknown'}${run.completedAt ? `, completed_at=${run.completedAt}` : ''}）`,
    };
  }
  if (kind === 'unknown') {
    const raw = String(run.status ?? '').trim();
    return {
      ...base,
      status: UNKNOWN,
      exitCode: EXIT_CODES.unknown,
      reason: 'unrecognized-status',
      message: raw
        ? `run ${run.id} 的状态 ${raw} 未识别：既不在已知在飞状态里，也不在已知终态状态里，`
          + '无法判定是否还有产出，按 unknown 处理（不静默当已结束）'
        : `run ${run.id} 的 status 为空，无法判定在飞还是终态`,
    };
  }
  if (!liveness?.lastActivityAt) {
    return {
      ...base,
      status: UNKNOWN,
      exitCode: EXIT_CODES.unknown,
      reason: 'no-liveness-evidence',
      message: `run ${run.id} 在飞，但 daemon 日志里没有它的活动行；无法判定是否停滞`,
    };
  }

  const stallSeconds = Math.max(0, Math.round((now.getTime() - liveness.lastActivityAt.getTime()) / 1000));
  const stalled = stallSeconds >= thresholdSeconds;
  return {
    ...base,
    stallSeconds,
    status: stalled ? STALLED : HEALTHY,
    exitCode: stalled ? EXIT_CODES.stalled : EXIT_CODES.healthy,
    reason: stalled ? 'no-progress-beyond-threshold' : 'progress-within-threshold',
    message: stalled
      ? `run ${run.id} 已 ${stallSeconds}s 无产出（阈值 ${thresholdSeconds}s），最后活动 ${liveness.lastActivityAt.toISOString()}`
      : `run ${run.id} 在 ${stallSeconds}s 内有产出（阈值 ${thresholdSeconds}s）`,
  };
}

// ---------------------------------------------------------------- 输出

export function renderText(result) {
  const lines = [`run 健康度：${result.status}（exit ${result.exitCode}）—— ${result.message}`];
  if (result.run) {
    lines.push(`  run: ${result.run.id}  status=${result.run.status || 'unknown'}`);
    if (result.run.startedAt) lines.push(`  started_at: ${result.run.startedAt}`);
  }
  if (result.stallSeconds !== null) lines.push(`  停滞秒数: ${result.stallSeconds}（阈值 ${result.stallThresholdSeconds}）`);
  if (result.lastSeq !== null) lines.push(`  最后 last_seq: ${result.lastSeq} @ ${result.lastMessageReportedAt}`);
  if (result.lastActivityAt) lines.push(`  最后 daemon 活动: ${result.lastActivityAt} —— ${result.lastActivityLine}`);
  if (result.daemonTeardownAt) {
    lines.push(`  本地 daemon 收尾行: ${result.daemonTeardownAt}${result.daemonTeardownStatus ? `（status=${result.daemonTeardownStatus}）` : ''}`);
  }
  if (result.session) lines.push(`  会话文件: ${result.session.file}`);
  if (result.lastToolCalls?.length) {
    lines.push(`  最后一批工具调用（${result.lastToolCallAt}${result.lastToolCalls.truncated ? '，已截断' : ''}）:`);
    for (const call of result.lastToolCalls) lines.push(`    - ${call.tool}: ${call.summary}`);
  }
  if (result.daemonLog?.state === 'ok') {
    lines.push(
      `  daemon 日志: ${result.daemonLog.file}（日期锚点 ${result.daemonLog.anchorDate}`
      + `${result.daemonLog.anchorSource ? `，来源 ${ANCHOR_SOURCE_LABEL[result.daemonLog.anchorSource] ?? result.daemonLog.anchorSource}` : ''}）`,
    );
  } else {
    lines.push(`  daemon 日志: ${result.daemonLog?.file ?? '（未知路径）'} —— ${result.daemonLog?.state}${result.daemonLog?.detail ? `：${result.daemonLog.detail}` : ''}`);
  }
  for (const note of result.notes) lines.push(`  注: ${note}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- CLI

function helpText() {
  return [
    '用法: node scripts/check-run-health.mjs --issue <issue-id> [--run <run-id>] [--json]',
    '',
    '选项:',
    '  --issue <id>                   issue ID（决定 run 列表来源）',
    '  --run <id>                     指定 run（可用短前缀）；缺省取最新在飞 run，否则取最新 run',
    '  --json                         输出 JSON',
    '  --stall-threshold-seconds <n>  停滞判定阈值，默认 900',
    '  --daemon-log <path>            daemon.log 路径（默认按 profile 自动定位；快照回放请给具体文件）',
    '  --daemon-log-date <YYYY-MM-DD> 最后一行日志所属的本地自然日（快照自带 anchor-date 时可省略）',
    '  --profile <name>               指定 profile（~/.multica/profiles/<name>/daemon.log）',
    '  --sessions-dir <path>          会话目录（默认 ~/.multica/pi-sessions）',
    '  --multica <path>               multica CLI 路径（默认 multica；.mjs/.cjs/.js 用当前 node 执行）',
    '  --runs-json <path>             从本地 JSON 读取 runs 列表，不调用 CLI（夹具/离线用）',
    '  --now <ISO8601>                以该时刻作为“现在”（可复现判定）',
    '',
    '退出码: 0 healthy|finished，1 stalled，2 unknown（缺 CLI、缺日志、日志不可读、状态未识别、证据不足）',
  ].join('\n');
}

function resolveIssueFromDaemon(entries, runId) {
  if (!runId) return null;
  const evidence = runEvidence(entries, runId);
  return evidence.issue;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`参数错误：${error.message}`);
    return EXIT_CODES.unknown;
  }
  if (options.help) {
    console.log(helpText());
    return EXIT_CODES.healthy;
  }
  if (!options.issue && !options.run) {
    console.error('必须给出 --issue <id> 或 --run <run-id>。\n');
    console.error(helpText());
    return EXIT_CODES.unknown;
  }

  const notes = [];
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`--now 不是合法时间：${options.now}`);
    return EXIT_CODES.unknown;
  }

  const daemonPath = resolveProfileLog({ profile: options.profile, explicitPath: options.daemonLog });
  const daemonLog = loadDaemonLog(daemonPath, { explicitDate: options.daemonLogDate });
  if (daemonLog.state !== 'ok') {
    notes.push('daemon.log 不存在或不可读：按 unknown 处理，不做健康声明');
  } else if (
    daemonLog.anchorSource === 'flag'
    && daemonLog.headerAnchorDate
    && daemonLog.headerAnchorDate !== daemonLog.anchorDate
  ) {
    notes.push(
      `--daemon-log-date ${options.daemonLogDate} 与日志头部 anchor-date ${daemonLog.headerAnchorDate}`
      + ` 不一致：按命令行参数取 ${daemonLog.anchorDate}`,
    );
  }

  let issue = options.issue ?? null;
  if (!issue && options.run) {
    const inferred = resolveIssueFromDaemon(daemonLog.entries, options.run);
    if (inferred) {
      issue = inferred;
      notes.push(`issue 由 daemon.log 推断：${inferred}`);
    } else {
      notes.push(
        '--run 未配 --issue，且 daemon.log 里没有该 run 的 issue 记录：无法推断所属 issue'
        + '（run 状态仍由 runs 列表来源判定：CLI 或 --runs-json）',
      );
    }
  }

  let runsResult = { state: 'unavailable', detail: '没有可用的 runs 来源', runs: null };
  if (options.runsJson) {
    try {
      runsResult = { state: 'ok', detail: null, runs: normalizeRuns(JSON.parse(fs.readFileSync(options.runsJson, 'utf8'))) };
    } catch (error) {
      runsResult = { state: 'failed', detail: oneLine(error.message), runs: null };
    }
  } else if (issue) {
    runsResult = readRunsFromCli(options.multica, issue);
  }

  let run = null;
  if (runsResult.state === 'ok') {
    try {
      run = selectRun(runsResult.runs, options.run);
    } catch (error) {
      notes.push(error.message);
    }
    if (!run) notes.push(`issue ${issue ?? '（未提供）'} 的 run 列表里没有匹配 ${options.run ?? '任何在飞 run'} 的记录`);
    const inFlightOthers = runsResult.runs.filter((entry) => classifyRunStatus(entry.status) === 'in-flight' && entry.id !== run?.id);
    if (inFlightOthers.length > 0) {
      notes.push(`同一 issue 还有 ${inFlightOthers.length} 条在飞 run：${inFlightOthers.map((entry) => entry.id.slice(0, 8)).join('、')}`);
    }
  } else if (runsResult.state === 'unavailable') {
    notes.push(`无法取得 run 列表（${runsResult.detail}）：按 unknown 处理，不静默通过`);
  } else {
    notes.push(`run 列表读取失败（${runsResult.detail}）`);
  }

  let session = null;
  let toolCalls = null;
  if (run) {
    const startedAt = run.startedAt ?? null;
    session = matchSessionFile({
      sessionsDir: options.sessionsDir ?? path.join(os.homedir(), '.multica', 'pi-sessions'),
      runId: run.id,
      startedAt,
    });
    if (session) {
      toolCalls = readLastToolCalls(session.file);
      if (toolCalls.state === 'unreadable') notes.push(`会话文件不可读：${toolCalls.detail}`);
    } else {
      notes.push('没有匹配到该 run 的会话文件（按 started_at 与 cwd 尾段匹配）');
    }
  }

  const liveness = run ? runEvidence(daemonLog.entries, run.id) : null;
  if (liveness) {
    liveness.startedSecondsAgo = run.startedAt
      ? Math.max(0, Math.round((now.getTime() - Date.parse(run.startedAt)) / 1000))
      : null;
    if (liveness.lineCount === 0 && daemonLog.state === 'ok') {
      notes.push('daemon.log 可读，但没有该 run 的任何行（日志可能已轮转或 run 不在本机）');
    }
    // --now 落在收尾之前时（历史回放），收尾行还沒发生，不能算进本次判定。
    if (liveness.teardownAt && liveness.teardownAt.getTime() > now.getTime()) {
      liveness.teardownAt = null;
      liveness.teardownStatus = null;
    }
    if (liveness.teardownAt && classifyRunStatus(run?.status ?? '') === 'in-flight') {
      notes.push(
        `本地 daemon 已在 ${liveness.teardownAt.toISOString()} 收尾`
        + `${liveness.teardownStatus ? `（status=${liveness.teardownStatus}）` : ''}`
        + `，但服务器仍报 status=${run?.status}：两个状态源不一致，先按本地收尾行判断真实性`,
      );
    }
  }

  const result = evaluateHealth({
    issue,
    run,
    liveness,
    now,
    thresholdSeconds: options.stallThresholdSeconds,
    daemonLog: {
      file: daemonLog.file,
      state: daemonLog.state,
      anchorDate: daemonLog.anchorDate ?? null,
      anchorSource: daemonLog.anchorSource ?? null,
    },
    session,
    toolCalls: toolCalls?.state === 'ok' ? toolCalls : null,
    notes,
  });

  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
  return result.exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url && import.meta.url.endsWith('check-run-health.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
