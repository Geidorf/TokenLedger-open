#!/usr/bin/env node
// 无头分支只读审计器（runbook：docs/runbooks/branch-hygiene.md）
//
// 来源：JEID-67《无头分支月度清点：判据 / 负责人 / 触发 / 审批》§0–§8。
// 本脚本只做「A1–A5 取候选 + B1–B3 归类 + G1 产出物」：产出一份可复核、可复算的
// cleanup-plan JSON，供质量位逐条复核（G2）和 owner 批准（G3/G4）。它不执行任何删除，
// 也不实现 G3/G4/G5 —— 那三类动作只属于人工，且必须先有 owner 的字面批准。
//
// 只读红线（JEID-68 派单约束 3 / runbook §6）：
//   本脚本用到的 git 能力仅限 for-each-ref、rev-parse、rev-list、merge-base、cherry、
//   diff、worktree list、ls-remote，以及会写 .git 的 `fetch`（`--no-fetch`/`--offline`
//   关闭）。默认的 fetch 不带 `--prune`：prune 会在任何人看到清单之前就删掉本地
//   remote-tracking ref，这是清点还没出报告就先销毁证据，只有显式传 `--prune` 才会
//   改成 `fetch --prune`（T10.157，评审 P2）。不调用任何删除或改写本地/远端分支 ref 的
//   子命令。scripts/branch-audit.test.mjs 用「源码文本断言 + 运行前后 ref 快照」两条
//   独立的检查守住这条线。
//
// 用法：
//   node scripts/branch-audit.mjs [--repo <path>] [--base origin/main] [--cooldown-days 14]
//                                [--cooldown 14]（同义别名）
//                                [--now <ISO8601>] [--out cleanup-plan.json]
//                                [--pr-heads-json <path>] [--issues-json <path>]
//                                [--tasks docs/TASKS.md] [--no-fetch] [--offline] [--prune]
//
// 退出码：0 = 产出完整清单；1 = 参数/环境致命错误；2 = 清单不完整（取不到 open PR head
// 集合时 A2 无法判定，此时按 unknown 处理并抑制候选，绝不静默当成「没有 open PR」）。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { parseTaskTable } from './check-docs.mjs';

export const DEFAULT_COOLDOWN_DAYS = 14;
// 观察区下界（天）：候选门槛与 B 档门槛之间的那段（runbook §2 A4 / §3）。
//   候选门槛 = now - min(--cooldown-days, OBSERVE_MIN_DAYS)：早于它才可能是候选；
//   B 档门槛 = now - --cooldown-days：早于它才进 B1/B2/B3；
//   夹在两者之间的 ref 落在观察区，只输出 verdict: "observe"，不进 B1/B2/B3。
// 于是默认值 14 下观察区正好是 [T-14, T-7)：7 天内不动的不进候选，7–14 天的只看不动，
// 而 %(committerdate) 恰等于 T-cooldown 的 ref 也落在观察区（左端闭、右端开）。
export const OBSERVE_MIN_DAYS = 7;
export const DEFAULT_BASE = 'origin/main';
export const DEFAULT_TASKS_PATH = 'docs/TASKS.md';
export const PR_HEAD_REF_GLOB = 'refs/pull/*/head';

// A1 的目标分支：main 及其远端跟踪名一律不进候选（JEID-67 §0 排除集）。
export const TARGET_BRANCH_NAMES = ['main', 'master'];

// A3：docs/TASKS.md §3 总状态里「仍占着这条路」的取值（runbook §1 A3）。
export const ACTIVE_OVERALL_STATUSES = ['[ ]', '[~]', '[r]', '[!]', '[?]'];

// A3：平台 issue 状态里同样算活跃认领的两个取值（JEID-67 §0 A3 原文）。
export const ACTIVE_ISSUE_STATUSES = ['in_progress', 'in_review'];

// X1：发布线前缀（JEID-67 §0 排除集「发布线/标签所在的分支」——A1–A5 未覆盖的那一格）。
export const RELEASE_LINE_PREFIXES = ['release/', 'rc/', 'hotfix/'];

export const EXIT_CODES = { ok: 0, fatal: 1, incomplete: 2 };

// ---------------------------------------------------------------- 判据原文锚点
// 这三组常量的 summary 必须逐字出现在 docs/runbooks/branch-hygiene.md 里：
// scripts/branch-audit.test.mjs 会读 runbook 做逐条比对（JEID-68 DoD 第 5 条），
// 因此判据只允许有一份措辞，runbook 与脚本不会各自漂移。

export const AUDIT_RULES = [
  {
    code: 'A1',
    summary: 'A1 不是目标分支：不等于基线本身——基线不论以 origin/develop（远端跟踪）还是 develop（本地）等非默认写法传入，其本地分支与远端跟踪分支都同样不进候选（另外兜底排除 main / master）',
  },
  {
    code: 'A2',
    summary: 'A2 不是 open PR 的 head：refs/pull/*/head 里已经是基线祖先的 SHA 先按「已合并/已关闭」剔除，剩余集合中不含 tip、也不含同名远端 ref 的 tip，且不存在某条 PR head 是 tip 的祖先，也不存在 tip 是某条 PR head 的祖先而 tip 又不是基线的祖先',
  },
  {
    code: 'A3',
    summary: 'A3 没有活跃认领：未被任何 worktree 检出、未登记在 docs/TASKS.md §2 Active Claims、对应任务在 §3 未处于在途状态（给了 --issues-json 时另查 issue 是否在 in_progress/in_review）',
  },
  {
    code: 'A4',
    summary: 'A4 冷却 14 天：%(committerdate) 早于 T-cooldown（--cooldown-days 默认 14）才进 B 档判定；落在 [T-cooldown, T-7) 的观察区只输出（verdict: "observe"，%(committerdate) 恰等于 T-cooldown 时判 observe）；不早于 T-7 的 ref 不进候选',
  },
  {
    code: 'A5',
    summary: 'A5 归属缺失或已终结（只参与 B2/B3 分档，不构成成员门禁）：对应任务在 docs/TASKS.md / 平台 issue 为 done/cancelled（台账侧等价取值 [x]/[v]），或根本找不到对应任务',
  },
  {
    code: 'X1',
    summary: 'X1 发布线保护（§0 排除集剩余一格）：分支名不以 release/ rc/ hotfix/ 开头，且 tip 上没有 tag',
  },
];

export const B_VERDICTS = [
  {
    code: 'B1',
    summary: 'B1 零信息损失 → 可删：tip 是 base 的祖先，或 patch 等价（git cherry -v 无 + 行），或内容等价（git diff --name-only 为空）；删除动作仍需 G3 批准',
  },
  {
    code: 'B2',
    summary: 'B2 有独有提交、但有主 → 保留 + 挂账：在归属 issue 上回填「分支名 + tip SHA + 独有提交数 + 是否已推远端 + 预期合并或作废时间」，给 30 天窗口，到点仍未处理下月降级为 B3',
  },
  {
    code: 'B3',
    summary: 'B3 有独有提交、且无主 → 待认领，不删：在清点 issue 里列名并给 7 天认领窗口；无人认领时必须由 owner 决定「作废归档」或「继续保留」，执行位不得自行删除',
  },
];

// 观察区不是第四档：它不进 B1/B2/B3，只在清单里输出（JEID-68 修订 / JEID-67 参数修订）。
export const OBSERVE_VERDICT = {
  code: 'observe',
  summary: '观察区（[T-cooldown, T-7)，默认 [T-14, T-7)）：只输出、不判 B 档，不得混进 B1/B2/B3；进入 B 档判定要求 %(committerdate) 早于 T-cooldown（默认 T-14），%(committerdate) 恰等于 T-cooldown 时判 observe',
  action: 'observe-only-hold-until-cooldown-elapses',
};

export const CANDIDATE_VERDICTS = ['B1', 'B2', 'B3', OBSERVE_VERDICT.code];

// 成员门禁（JEID-67 §0 D1=A，2026-09-18 owner 裁定；runbook 抬头「对齐记录」）：
//   候选资格由 A1–A4 与 X1 决定；A5 只在「有独有提交」时参与 B2/B3 分档。
// 把 A5 放进门禁会让「归属未终结」的分支直接落进 excluded，与 §1 三分法（那种分支
// 应走 B2 挂账）互斥；A5 的 pass 标记保留为留证字段，分档读的是它解析出的归属
// （checks.A5.owner：能定位到归属 → B2 挂账，解析不出 → B3 待认领）。
export const CANDIDACY_GATES = ['A1', 'A2', 'A3', 'A4', 'X1'];
export const CLASSIFY_ONLY_CHECKS = ['A5'];

export const HUMAN_GATES = [
  {
    code: 'G1',
    summary: 'G1 清单产出：执行位产出 cleanup-plan.json，每条候选附 A1–A5 判定输出、tip SHA、所用命令原文、B 档归类',
  },
  {
    code: 'G2',
    summary: 'G2 独立复核：质量验收位逐条复核判据与 SHA；任何一条判据不成立即退回，禁止带疑点进 G3',
  },
  {
    code: 'G3',
    summary: 'G3 owner 批准本地删除：批准前必须先生成恢复 bundle（git bundle create 全量 + SHA-256 记录在案）并附路径；owner 在 issue 里给出字面批准；分批审批（2026-09-18 新增）：B1 集合只在当月最后一次清点里汇总送审一次，周中不逐条打扰 owner；B2/B3 只推增量',
  },
  {
    code: 'G4',
    summary: 'G4 owner 单独批准远端删除：逐条列出 ref 名 + tip SHA + 判据；无字面批准不得执行，也不得使用强制删除',
  },
  {
    code: 'G5',
    summary: 'G5 执行与回填：删除前 git rev-parse 与预期 SHA 逐一比对后才删；回填 cleanup-result.json 与 issue 评论',
  },
];

// ---------------------------------------------------------------- git 包装
// 所有 git 调用都从这里出去，argv 原文同时作为证据留档（runbook §1「命令原文」）。
function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    return { ok: false, code: null, stdout: '', stderr: result.error.message, argv: args };
  }
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    argv: args,
  };
}

function commandText(result) {
  const quote = (value) => (/[^\w@%+=:,./-]/u.test(value) ? `'${value}'` : value);
  return `git ${result.argv.map(quote).join(' ')}`;
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

// ---------------------------------------------------------------- ref 清单
const REF_FORMAT = '%(refname)|%(objectname)|%(committerdate:iso-strict)|%(committerdate:short)|%(symref)|%(subject)';

export function branchNameOf(refname) {
  if (refname.startsWith('refs/heads/')) return refname.slice('refs/heads/'.length);
  if (refname.startsWith('refs/remotes/')) {
    const rest = refname.slice('refs/remotes/'.length);
    const slash = rest.indexOf('/');
    return slash === -1 ? rest : rest.slice(slash + 1);
  }
  return refname;
}

// `git branch -a` 的写法：本地 `X`、远端 `origin/X`。两者是两个 ref，G3（本地）与
// G4（远端）也要分别批准，因此清单里各自占一行，不做合并。
export function displayNameOf(refname) {
  if (refname.startsWith('refs/heads/')) return refname.slice('refs/heads/'.length);
  if (refname.startsWith('refs/remotes/')) {
    const rest = refname.slice('refs/remotes/'.length);
    const slash = rest.indexOf('/');
    if (slash === -1) return rest;
    return `${rest.slice(0, slash)}/${rest.slice(slash + 1)}`;
  }
  return refname;
}

export function listRefs(repo) {
  const result = git(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes'], repo);
  if (!result.ok) {
    throw new Error(`git for-each-ref 失败：${oneLine(result.stderr)}`);
  }
  const refs = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    const [refname, objectname, committerDate, committerDateShort, symref] = parts;
    const subject = parts.slice(5).join('|');
    if (!refname || !objectname) continue;
    // origin/HEAD 这类符号引用不是分支，不参与清点。
    if (oneLine(symref)) continue;
    refs.push({
      ref: refname,
      name: displayNameOf(refname),
      branch: branchNameOf(refname),
      local: refname.startsWith('refs/heads/'),
      tip_sha: objectname,
      committer_date: committerDate,
      committer_date_short: committerDateShort,
      subject: oneLine(subject),
    });
  }
  return refs;
}

// 快照 digest：对全部参与清点的 ref 按 `refname|tip_sha` 排序后取 sha256。
// 同一次 ref 快照重跑必然得到同一个 digest；ref 集合（增删或 tip 移动）一变就变。
export function refSnapshotDigest(refs) {
  const lines = refs.map((entry) => `${entry.ref}|${entry.tip_sha}`).sort();
  return createHash('sha256').update(`${lines.join('\n')}\n`, 'utf8').digest('hex');
}

// ---------------------------------------------------------------- 任务台账
export function readActiveClaims(tasksPath) {
  const text = fs.readFileSync(tasksPath, 'utf8');
  const claims = [];
  let inClaims = false;
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (/^##\s+2\./u.test(line)) { inClaims = true; continue; }
    if (inClaims && /^##\s+(?!#)/u.test(line)) { inClaims = false; continue; }
    if (inClaims && /^###?\s/u.test(line)) { inClaims = false; continue; }
    if (!inClaims || !line.startsWith('|')) continue;
    if (/^\|\s*任务\s*\|/u.test(line) || /^\|[\s:-]+\|/u.test(line)) continue;
    const cells = line.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const taskId = cells[0].replace(/`/gu, '').trim();
    if (!/^T\d/u.test(taskId)) continue;
    const branches = [...cells[4].matchAll(/`([^`]+)`/gu)].map((match) => match[1].trim()).filter(Boolean);
    claims.push({
      task_id: taskId,
      owner: cells[1],
      branches,
      line: index + 1,
    });
  }
  return claims;
}

export function readTaskRows(tasksPath) {
  const rows = parseTaskTable(fs.readFileSync(tasksPath, 'utf8').split(/\r?\n/u));
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return byId;
}

// 分支名 → 任务 ID。`codex/T10.23-reasonix-third-party` → T10.23；
// `agent/agent/jeid-55` → JEID-55（JEID 是平台 issue 号，不是 §3 任务号）。
export function taskOwnerOf(branch) {
  const tasksMatch = branch.match(/(?:^|[/_-])(T\d+(?:\.\d+)?[a-z]*)(?=[-_./]|$)/u);
  if (tasksMatch) return { id: tasksMatch[1], kind: 'tasks' };
  const issueMatch = branch.match(/(?:^|[/_-])(JEID-\d+)(?=[-_./]|$)/iu);
  if (issueMatch) return { id: issueMatch[1].toUpperCase(), kind: 'issue' };
  return null;
}

export function normalizeIssues(raw) {
  const statuses = new Map();
  const push = (identifier, status) => {
    if (!identifier || !status) return;
    statuses.set(String(identifier).trim().toUpperCase(), String(status).trim());
  };
  const entries = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.issues) ? raw.issues : null);
  if (entries) {
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      push(entry.identifier ?? entry.key ?? entry.id, entry.status);
    }
    return { statuses, source: 'issues-json' };
  }
  if (raw && typeof raw === 'object') {
    for (const [identifier, status] of Object.entries(raw)) {
      if (typeof status === 'string') push(identifier, status);
    }
    return { statuses, source: 'issues-json' };
  }
  throw new Error('--issues-json 结构无法识别：需要 [{identifier,status}]、{issues:[...]} 或 {"JEID-55":"in_progress"}');
}

// ---------------------------------------------------------------- open PR head 集合（A2）
export function loadOpenPrHeads({ repo, prHeadsJson = null, offline = false }) {
  if (prHeadsJson) {
    const raw = JSON.parse(fs.readFileSync(prHeadsJson, 'utf8'));
    const list = Array.isArray(raw)
      ? raw.map((entry) => (typeof entry === 'string' ? entry : entry?.sha))
      : (Array.isArray(raw?.shas) ? raw.shas : []);
    const shas = list.filter((sha) => typeof sha === 'string' && /^[0-9a-f]{40}$/u.test(sha));
    return {
      available: true,
      source: `--pr-heads-json ${prHeadsJson}`,
      detail: null,
      shas: [...new Set(shas)].sort(),
    };
  }
  if (offline) {
    return {
      available: false,
      source: 'offline',
      detail: '--offline 且未提供 --pr-heads-json：A2 无法判定',
      shas: [],
    };
  }
  const result = git(['ls-remote', 'origin', PR_HEAD_REF_GLOB], repo);
  if (!result.ok) {
    return {
      available: false,
      source: `git ls-remote origin '${PR_HEAD_REF_GLOB}'`,
      detail: `取 open PR head 失败：${oneLine(result.stderr) || `退出码 ${result.code}`}`,
      shas: [],
    };
  }
  const shas = [];
  const refs = [];
  for (const line of result.stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/u);
    if (!sha || !ref) continue;
    shas.push(sha);
    refs.push({ ref, sha });
  }
  return {
    available: true,
    source: `git ls-remote origin '${PR_HEAD_REF_GLOB}'`,
    detail: null,
    shas: [...new Set(shas)].sort(),
    refs: refs.sort((a, b) => a.ref.localeCompare(b.ref)),
  };
}

// `refs/pull/*/head` 里既有 open PR，也有早已合并/关闭的 PR（GitHub 会永久保留该 ref）。
// 已经是基线祖先的 head 不可能再是「open PR 的 head」，先剔除；剩下的才当 open PR head 用。
// 方向是安全的：被关闭但未合并的 PR 仍会被当成 open（只会让候选变少，不会让删除面变大）。
// 两种来源（ls-remote / --pr-heads-json）过同一道过滤，因此清单里的 A2 证据是自洽的。
export function filterMergedPrHeads({ repo, base, rawHeads }) {
  if (!rawHeads.available || rawHeads.shas.length === 0) return rawHeads;
  const stillOpen = [];
  const merged = [];
  for (const sha of rawHeads.shas) {
    const ancestor = git(['merge-base', '--is-ancestor', sha, base], repo);
    (ancestor.ok ? merged : stillOpen).push(sha);
  }
  return { ...rawHeads, shas: stillOpen, merged_pr_heads: merged };
}

// A1 用：把 --base 的任意写法（origin/develop、develop、refs/heads/develop、
// refs/remotes/origin/develop……）统一解析成一份「基线身份」，给出全名/短名/展示名三种
// 形态，checkA1 三种都比对。修复前只做过字符串字面比较：--base 是默认的 origin/main 时
// 之所以看起来对，只是因为 main 恰好也在 TARGET_BRANCH_NAMES 硬编码兜底里；一旦
// --base 换成非默认分支（如 origin/develop），远端跟踪 ref 和它的本地同名分支都不会
// 被排除，基线本身反而可能被判成删除候选（T10.157，评审 P2）。
function resolveBaseIdentity(base, repo) {
  const symbolic = git(['rev-parse', '--symbolic-full-name', base], repo);
  const fullRef = symbolic.ok ? symbolic.stdout.trim() : '';
  if (fullRef && (fullRef.startsWith('refs/heads/') || fullRef.startsWith('refs/remotes/'))) {
    return { fullRef, shortName: branchNameOf(fullRef), displayName: displayNameOf(fullRef) };
  }
  // 解析不出符号引用（比如 --base 直接给的是裸 SHA）：退化为对原始字符串剥前缀，
  // 至少保住「origin/xxx」与裸分支名两种最常见写法。裸 SHA 场景下 shortName/
  // displayName 就是那串十六进制字面量，不会等于任何分支名，A1 的「排除基线自身」
  // 因此对裸 SHA 形同虚设（仍保留 main/master 硬编码兜底）——这是已知且刻意接受的
  // 限制（T10.157 评审 P3），不是回归：改动前同样没有针对裸 SHA 的基线自身保护，
  // runbook 也没有裸 SHA 用作 --base 的用法示例。不按「tip 恰好等于该 SHA」去反查
  // 匹配分支，是因为那会把 A1（排除基线本身）和 B1 的「ancestor/content-equivalent」
  // 判据混在一起：一个当前 tip 恰好等于该 SHA 的分支，应该被 B1 判成零信息损失的
  // 删除候选浮出来，而不是被 A1 直接排除到候选清单之外。
  return { fullRef: fullRef || null, shortName: branchNameOf(base), displayName: base };
}

// ---------------------------------------------------------------- 上下文
export function createContext(options) {
  const repo = path.resolve(options.repo ?? process.cwd());
  if (!fs.existsSync(path.join(repo, '.git'))) {
    throw new Error(`${repo} 不是 git 仓库根（缺 .git）`);
  }
  const base = options.base ?? DEFAULT_BASE;
  const baseResult = git(['rev-parse', '--verify', '--quiet', base], repo);
  if (!baseResult.ok) {
    throw new Error(`基线分支 ${base} 不可解析：${oneLine(baseResult.stderr)}`);
  }
  const baseIdentity = resolveBaseIdentity(base, repo);
  const tasksPath = path.resolve(repo, options.tasks ?? DEFAULT_TASKS_PATH);
  const cooldownDays = Number(options.cooldownDays ?? DEFAULT_COOLDOWN_DAYS);
  if (!Number.isFinite(cooldownDays) || cooldownDays < 0) {
    throw new Error(`--cooldown-days 必须是非负数，实际 ${options.cooldownDays}`);
  }
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error(`--now 不是合法时间：${options.now}`);
  }
  const DAY_MS = 24 * 60 * 60 * 1000;
  // 两道门槛（runbook §2 A4 / §3 观察区）：
  //   cutoff  = now - min(cooldownDays, OBSERVE_MIN_DAYS)  → 候选门槛（不早于它即不入候选）
  //   bCutoff = now - cooldownDays                          → B 档门槛（不早于它即落观察区）
  const observeMinDays = Math.min(cooldownDays, OBSERVE_MIN_DAYS);
  const cutoff = new Date(now.getTime() - observeMinDays * DAY_MS);
  const bCutoff = new Date(now.getTime() - cooldownDays * DAY_MS);

  // 默认只做普通 fetch，不带 --prune：--prune 会在任何人看到清单之前就删掉本地
  // remote-tracking ref（远端已经删除的分支，本地缓存的 ref 就是仅剩的痕迹），这属于
  // 清点还没出报告就先销毁证据，与「先出清单、人工批准后才有动作」的红线冲突
  // （T10.157，评审 P2）。只有显式传 --prune 才改回 fetch --prune；--no-fetch/--offline
  // 一样能整体关掉 fetch，行为不变。
  // fetchCommand 是本次配置下「会用到/失败提示要点名」的那条命令原文，即使这次因
  // --no-fetch/--offline 没有真的执行也照样按 --prune 取值算出来：read_only_guarantee
  // 与下面的 fetch 失败提示都从这一个值派生，不再各自硬编码字面量（T10.157 评审
  // P1/P2——两处旧硬编码字面量在改成默认不 prune 之后就没跟着改，导致工具自己的安全
  // 承诺文本与失败提示都还在断言「唯一/失败的动作带 --prune」，即使这次根本没传）。
  const fetchCommand = options.prune ? 'git fetch --prune origin' : 'git fetch origin';
  let fetched = 'skipped';
  let fetchFailure = null;
  if (!options.noFetch && !options.offline) {
    const fetch = options.prune
      ? git(['fetch', '--prune', 'origin'], repo)
      : git(['fetch', 'origin'], repo);
    fetched = fetch.ok ? (options.prune ? 'origin (--prune)' : 'origin (fetch)') : 'failed';
    if (!fetch.ok) fetchFailure = oneLine(fetch.stderr);
  } else if (options.offline) {
    fetched = 'offline';
  }

  const worktrees = git(['worktree', 'list', '--porcelain'], repo);
  const worktreeBranches = [];
  if (worktrees.ok) {
    let current = null;
    for (const line of worktrees.stdout.split('\n')) {
      if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
      if (line.startsWith('branch refs/heads/')) {
        worktreeBranches.push({ branch: branchNameOf(line.slice('branch '.length).trim()), worktree: current });
      }
    }
  }

  const tagShas = new Set();
  const tags = git(['for-each-ref', '--format=%(objectname)|%(*objectname)', 'refs/tags'], repo);
  if (tags.ok) {
    for (const line of tags.stdout.split('\n')) {
      for (const sha of line.split('|')) {
        if (/^[0-9a-f]{40}$/u.test(sha.trim())) tagShas.add(sha.trim());
      }
    }
  }

  return {
    repo,
    base,
    base_sha: baseResult.stdout.trim(),
    baseIdentity,
    cooldownDays,
    observeMinDays,
    now,
    cutoff,
    bCutoff,
    tasksPath,
    fetched,
    fetchFailure,
    fetchCommand,
    refs: listRefs(repo),
    worktreeBranches,
    activeClaims: readActiveClaims(tasksPath),
    taskRows: readTaskRows(tasksPath),
    tagShas,
    issues: options.issues
      ? { ...normalizeIssues(options.issues), path: options.issuesPath ?? null }
      : { statuses: new Map(), source: options.issuesPath ? `--issues-json ${options.issuesPath}` : 'repo-only' },
    openPrHeads: filterMergedPrHeads({
      repo,
      base,
      rawHeads: loadOpenPrHeads({
        repo,
        prHeadsJson: options.prHeadsJson ?? null,
        offline: Boolean(options.offline),
      }),
    }),
    _revList: new Map(),
    notes: [],
  };
}

function revListSet(context, sha) {
  if (context._revList.has(sha)) return context._revList.get(sha);
  const result = git(['rev-list', sha], context.repo);
  const set = result.ok ? new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) : null;
  context._revList.set(sha, set);
  return set;
}

function isAncestor(context, ancestor, descendant) {
  const result = git(['merge-base', '--is-ancestor', ancestor, descendant], context.repo);
  return {
    ok: result.ok,
    command: commandText(result),
    exit_code: result.code,
  };
}

// ---------------------------------------------------------------- A1–A5 + X1
function checkA1(context, ref) {
  const identity = context.baseIdentity;
  // 三种比对各自独立成立即可：全名（同一个 ref）、短名（本地 develop ↔ 远端跟踪
  // origin/develop 互认，不论 --base 传的是哪一种写法）、展示名（兜底 origin/xxx 这类
  // 字面写法）。任一命中即认定 ref 就是基线自己（或基线的本地/远端跟踪镜像）。
  const isBaseItself = Boolean(
    (identity.fullRef && ref.ref === identity.fullRef)
    || (identity.shortName && ref.branch === identity.shortName)
    || (identity.displayName && ref.name === identity.displayName),
  );
  const isTarget = TARGET_BRANCH_NAMES.includes(ref.branch) || isBaseItself;
  return {
    pass: !isTarget,
    detail: isTarget
      ? `目标分支（main/master 或基线 ${context.base} 本身，含其本地分支与远端跟踪分支）不进候选`
      : `不是目标分支：${ref.name} 不在 ${[context.base, ...TARGET_BRANCH_NAMES].join(' / ')} 之列`,
    command: identity.fullRef ? `git rev-parse --symbolic-full-name ${context.base}  →  ${identity.fullRef}` : null,
  };
}

function checkA2(context, ref) {
  const heads = context.openPrHeads;
  if (!heads.available) {
    return {
      pass: false,
      unknown: true,
      detail: `${heads.detail} —— A2 无法判定，按「不是候选」处理（宁可漏报，不可把 open PR 的分支列进候选）`,
      command: heads.source,
    };
  }
  const hits = [];

  if (heads.shas.includes(ref.tip_sha)) {
    hits.push({ kind: 'tip-is-pr-head', pr_head: ref.tip_sha, detail: `tip 就是某条 open PR 的 head` });
  }

  // 同名远端 ref 的 tip 也在 open PR head 集合里（本地 ref 与远端 PR 分支是同一份工作）。
  const remoteTwin = context.refs.find(
    (candidate) => !candidate.local && candidate.branch === ref.branch && candidate.ref !== ref.ref,
  );
  if (remoteTwin && heads.shas.includes(remoteTwin.tip_sha)) {
    hits.push({
      kind: 'twin-is-pr-head',
      pr_head: remoteTwin.tip_sha,
      detail: `同名远端 ref ${remoteTwin.name} 的 tip 是某条 open PR 的 head`,
    });
  }

  // 祖先/后代关系：落在同一条 PR 线上都不是「无头」。两个方向分开判定，因为方向 3 必须
  // 排除「tip 只是基线老历史」的情况——否则所有早已合入 main 的功能分支都会被误判成 PR 相关，
  // B1（零信息损失）那一档会被 A2 吞掉。
  // 这条限定就是 JEID-67 rev 50 §0 A2 的 N5 operational 读法（「当该 tip 自身不在
  // origin/main 中时」才判祖先条）；literal 读法实测会把 10 条 B1 全部排除、台账变成
  // B1 0，已被 2026-09-18 裁定作废（见 runbook §2 A2 的实测矩阵）。
  const tipAncestors = revListSet(context, ref.tip_sha);
  for (const head of heads.shas) {
    if (head === ref.tip_sha) continue;
    const headAncestors = revListSet(context, head);
    if (tipAncestors && tipAncestors.has(head)) {
      hits.push({
        kind: 'pr-head-ancestor-of-tip',
        pr_head: head,
        detail: `open PR head ${head.slice(0, 8)} 是 tip 的祖先（本 ref 只是「PR 分支 + 未推送提交」）`,
      });
    } else if (headAncestors && headAncestors.has(ref.tip_sha)) {
      const baseAncestor = isAncestor(context, ref.tip_sha, context.base);
      if (!baseAncestor.ok) {
        hits.push({
          kind: 'tip-ancestor-of-pr-head',
          pr_head: head,
          detail: `tip 是 open PR head ${head.slice(0, 8)} 的祖先，且不是基线 ${context.base} 的祖先（这条提交只存在于该 PR 线上，属 PR 工作而非已合入的历史）`,
        });
      }
    }
    if (hits.length > 0) break;
  }

  if (hits.length === 0) {
    const filtered = heads.merged_pr_heads ? heads.merged_pr_heads.length : 0;
    return {
      pass: true,
      detail: `tip 与 ${heads.shas.length} 条 open PR head 的 SHA 集合无重合、无祖先/后代关系`
        + (filtered > 0 ? `（另有 ${filtered} 个 PR head 已是基线祖先，按已合并/已关闭剔除）` : ''),
      command: `${heads.source}  →  ${heads.shas.length} 个 SHA`,
    };
  }

  const hit = hits[0];
  const direction = hit.kind === 'pr-head-ancestor-of-tip'
    ? isAncestor(context, hit.pr_head, ref.tip_sha)
    : isAncestor(context, ref.tip_sha, hit.pr_head);
  return {
    pass: false,
    detail: hit.detail,
    command: direction.command,
    exit_code: direction.exit_code,
    pr_head: hit.pr_head,
  };
}

function checkA3(context, ref) {
  const evidence = [];
  const inWorktree = context.worktreeBranches.filter((entry) => entry.branch === ref.branch);
  if (inWorktree.length > 0) {
    evidence.push(`正被 worktree 检出：${inWorktree.map((entry) => entry.worktree).join('、')}`);
  }

  const claim = context.activeClaims.find((entry) => entry.branches.includes(ref.branch));
  if (claim) {
    evidence.push(`登记在 docs/TASKS.md §2 Active Claims（${claim.task_id}，第 ${claim.line} 行）`);
  }

  const owner = taskOwnerOf(ref.branch);
  const row = owner && owner.kind === 'tasks' ? context.taskRows.get(owner.id) : null;
  if (row && ACTIVE_OVERALL_STATUSES.includes(row.overall)) {
    evidence.push(`§3 ${row.id} 总状态 ${row.overall}（在途），integration=${row.integration}`);
  }

  if (owner && context.issues.source !== 'repo-only') {
    const status = context.issues.statuses.get(owner.id.toUpperCase());
    if (status && ACTIVE_ISSUE_STATUSES.includes(status)) {
      evidence.push(`issue ${owner.id} 状态 ${status}`);
    }
  }

  const missingPlatform = owner && context.issues.source === 'repo-only';
  return {
    pass: evidence.length === 0,
    detail: evidence.length > 0
      ? evidence.join('；')
      : `无活跃认领证据（worktree 检出 / §2 Active Claims / §3 在途 三处均未命中）`
        + (missingPlatform ? '；平台 issue 状态未查询（未给 --issues-json）' : ''),
    command: 'git worktree list --porcelain；docs/TASKS.md §2/§3 表格',
    a3_source: context.issues.source === 'repo-only' ? 'repo-only' : context.issues.source,
    platform_checked: context.issues.source !== 'repo-only',
  };
}

function checkA4(context, ref) {
  const committedAt = new Date(ref.committer_date);
  const valid = !Number.isNaN(committedAt.getTime());
  const pass = valid && committedAt.getTime() < context.cutoff.getTime();
  const inObserveWindow = pass && committedAt.getTime() >= context.bCutoff.getTime();
  return {
    pass,
    observe_window: inObserveWindow,
    detail: valid
      ? `%(committerdate)=${ref.committer_date}（${ref.committer_date_short}）`
        + `${pass ? ' 早于' : ' 不早于'}候选门槛 cutoff ${context.cutoff.toISOString()}（T-${context.observeMinDays}）`
        + `；B 档门槛 ${context.bCutoff.toISOString()}（T-${context.cooldownDays}）`
        + `${inObserveWindow ? '；落在观察区：只输出、不判 B 档' : ''}`
      : `%(committerdate) 不可解析：${ref.committer_date}`,
    command: `git for-each-ref --format='%(committerdate:iso-strict)' ${ref.ref}`,
  };
}

// A5 不是候选门禁（见 CANDIDACY_GATES）：它产出的是
//   · owner：归属能不能定位到任务（B2/B3 分档的输入）
//   · pass ：A5 本身成立与否（归属缺失/已终结），只作留证，不参与候选判定。
function checkA5(context, ref) {
  const owner = taskOwnerOf(ref.branch);
  if (!owner) {
    return {
      pass: true,
      detail: '分支名解析不出任何任务 ID：归属缺失（冷却期满后终局为 B3 待认领，不删）',
      command: null,
      owner: null,
    };
  }
  const row = owner.kind === 'tasks' ? context.taskRows.get(owner.id) : null;
  if (row) {
    const pass = !ACTIVE_OVERALL_STATUSES.includes(row.overall);
    return {
      pass,
      detail: `§3 ${row.id} 总状态 ${row.overall}，integration=${row.integration}`,
      command: 'docs/TASKS.md §3',
      owner: { ...owner, in_tasks_table: true, overall: row.overall },
    };
  }
  if (context.issues.source !== 'repo-only') {
    const status = context.issues.statuses.get(owner.id.toUpperCase());
    if (status) {
      const pass = !ACTIVE_ISSUE_STATUSES.includes(status);
      return {
        pass,
        detail: `§3 无 ${owner.id} 行；issue 状态 ${status}`,
        command: `--issues-json（${context.issues.source}）`,
        owner: { ...owner, in_tasks_table: false, issue_status: status },
      };
    }
  }
  return {
    pass: true,
    detail: `§3 没有 ${owner.id} 这一行，也没有 issue 状态证据：归属未登记（终局为 B2 挂账，不删）`,
    command: 'docs/TASKS.md §3',
    owner: { ...owner, in_tasks_table: false },
  };
}

function checkX1(context, ref) {
  const releaseLine = RELEASE_LINE_PREFIXES.find((prefix) => ref.branch.startsWith(prefix));
  if (releaseLine) {
    return {
      pass: false,
      detail: `分支名以 ${releaseLine} 开头，属发布线，永不进候选`,
      command: null,
    };
  }
  if (context.tagShas.has(ref.tip_sha)) {
    return {
      pass: false,
      detail: `tip ${ref.tip_sha.slice(0, 8)} 上有 tag，属发布线，永不进候选`,
      command: `git for-each-ref --format='%(objectname)|%(*objectname)' refs/tags`,
    };
  }
  return { pass: true, detail: '不属发布线，tip 上没有 tag', command: null };
}

const CHECKS = {
  A1: checkA1,
  A2: checkA2,
  A3: checkA3,
  A4: checkA4,
  A5: checkA5,
  X1: checkX1,
};

// ---------------------------------------------------------------- B1–B3
function classify(context, ref, checks) {
  const ancestor = isAncestor(context, ref.tip_sha, context.base);
  if (ancestor.ok) {
    return {
      verdict: 'B1',
      rule_hit: 'ancestor',
      action: 'delete-only-after-G3-literal-owner-approval',
      commands: [ancestor.command],
      ahead_commits: 0,
    };
  }

  const cherry = git(['cherry', '-v', context.base, ref.ref], context.repo);
  if (cherry.ok) {
    const plusLines = cherry.stdout.split('\n').filter((line) => line.startsWith('+'));
    if (plusLines.length === 0) {
      return {
        verdict: 'B1',
        rule_hit: 'patch-equivalent',
        action: 'delete-only-after-G3-literal-owner-approval',
        commands: [ancestor.command, commandText(cherry)],
        ahead_commits: 0,
      };
    }
  }

  const diff = git(['diff', '--name-only', context.base, ref.ref], context.repo);
  if (diff.ok) {
    const names = diff.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (names.length === 0) {
      return {
        verdict: 'B1',
        rule_hit: 'content-equivalent',
        action: 'delete-only-after-G3-literal-owner-approval',
        commands: [ancestor.command, commandText(diff)],
        ahead_commits: 0,
      };
    }
    const count = git(['rev-list', '--count', `${context.base}..${ref.ref}`], context.repo);
    const ahead = count.ok ? Number(count.stdout.trim()) : null;
    const owner = checks.A5.owner;
    return {
      verdict: owner ? 'B2' : 'B3',
      rule_hit: owner ? 'distinct-commits-with-owner' : 'distinct-commits-without-owner',
      action: owner
        ? 'record-on-owner-issue-and-hold-30d'
        : 'list-for-claim-and-hold-7d',
      commands: [ancestor.command, commandText(diff), commandText(count)],
      ahead_commits: ahead,
    };
  }

  return {
    verdict: 'B3',
    rule_hit: 'inconclusive',
    action: 'list-for-claim-and-hold-7d',
    commands: [ancestor.command, commandText(diff)],
    ahead_commits: null,
  };
}

// ---------------------------------------------------------------- 清单
export function buildPlan(options) {
  const context = createContext(options);
  const originTips = new Set(
    context.refs.filter((ref) => !ref.local).map((ref) => ref.tip_sha),
  );

  const candidates = [];
  const excluded = [];
  for (const ref of context.refs) {
    const checks = {};
    for (const [code, run] of Object.entries(CHECKS)) checks[code] = run(context, ref);
    // 门禁只取 CANDIDACY_GATES（A1–A4 / X1）；A5 落在 CLASSIFY_ONLY_CHECKS，
    // 只在下面 classify() 的分档里被读取，不参与「进不进候选」。
    const failed = CANDIDACY_GATES.map((code) => [code, checks[code]]).find(([, value]) => !value.pass);
    const twin = context.refs.find(
      (other) => !other.local && other.branch === ref.branch && other.ref !== ref.ref,
    );
    const base = {
      branch: ref.branch,
      name: ref.name,
      ref: ref.ref,
      kind: ref.local ? 'local' : 'remote',
      tip_sha: ref.tip_sha,
      committer_date: ref.committer_date,
      committer_date_short: ref.committer_date_short,
      subject: ref.subject,
      pushed: ref.local ? originTips.has(ref.tip_sha) : true,
      remote_ref: twin ? twin.name : null,
      remote_tip_sha: twin ? twin.tip_sha : null,
    };

    const detailChecks = Object.fromEntries(Object.entries(checks).map(([key, entry]) => [key, {
      pass: entry.pass,
      detail: entry.detail,
      command: entry.command ?? null,
    }]));

    if (failed) {
      const [code, value] = failed;
      excluded.push({
        ...base,
        rule_hit: code,
        detail: value.detail,
        command: value.command,
        exit_code: value.exit_code ?? null,
        checks: Object.fromEntries(Object.entries(checks).map(([key, entry]) => [key, entry.pass])),
      });
      continue;
    }

    // 观察区：A1–A5/X1 全部成立，但 tip 还没老过 B 档门槛。只输出，不做 B 档归类——
    // 也因此不去跑 cherry/diff/rev-list（那些命令的结论属于 B1/B2/B3，本格不产出）。
    if (checks.A4.observe_window) {
      candidates.push({
        ...base,
        task_owner: checks.A5.owner ? checks.A5.owner.id : null,
        owner_issue: checks.A5.owner ? checks.A5.owner.id : null,
        owner_in_tasks_table: checks.A5.owner ? Boolean(checks.A5.owner.in_tasks_table) : false,
        rule_hit: 'observe-window',
        command: checks.A4.command,
        commands: [checks.A4.command],
        checks: detailChecks,
        verdict: OBSERVE_VERDICT.code,
        action: OBSERVE_VERDICT.action,
        ahead_commits: null,
        a3_source: checks.A3.a3_source,
      });
      continue;
    }

    const verdict = classify(context, ref, checks);
    candidates.push({
      ...base,
      task_owner: checks.A5.owner ? checks.A5.owner.id : null,
      owner_issue: checks.A5.owner ? checks.A5.owner.id : null,
      owner_in_tasks_table: checks.A5.owner ? Boolean(checks.A5.owner.in_tasks_table) : false,
      rule_hit: verdict.rule_hit,
      command: verdict.commands[verdict.commands.length - 1],
      commands: verdict.commands,
      checks: detailChecks,
      verdict: verdict.verdict,
      action: verdict.action,
      ahead_commits: verdict.ahead_commits,
      a3_source: checks.A3.a3_source,
    });
  }

  const countByVerdict = (verdict) => candidates.filter((entry) => entry.verdict === verdict).length;
  const observeCount = countByVerdict(OBSERVE_VERDICT.code);
  const excludedByRule = {};
  for (const entry of excluded) {
    excludedByRule[entry.rule_hit] = (excludedByRule[entry.rule_hit] ?? 0) + 1;
  }

  // read_only_guarantee 的措辞要如实反映本次配置，不是永远断言默认值（T10.157 评审
  // P1）：从 context.fetchCommand 反推这次是不是显式 --prune，两种模式各自说清楚会不会
  // 修剪，而不是不管传没传 --prune 都印同一句话。
  const pruneClause = context.fetchCommand.includes('--prune')
    ? '本次显式传了 --prune，会修剪远端已删除分支对应的本地 remote-tracking ref'
    : '本次未传 --prune，不会修剪，只更新/新增 remote-tracking ref';

  const notes = [...context.notes];
  if (!context.openPrHeads.available) {
    notes.push(`A2 证据缺失：${context.openPrHeads.detail}；本次清单不完整（退出码 2），候选已全部抑制`);
  }
  if (context.issues.source === 'repo-only') {
    notes.push('A3 只覆盖仓库侧证据（worktree 检出 / §2 Active Claims / §3 在途）；未给 --issues-json 时平台 issue 状态未查，a3_source=repo-only 的条目进 G3 前必须补平台状态');
  }
  if (context.fetchFailure) {
    notes.push(`${context.fetchCommand} 失败，按现有 remote-tracking ref 清点：${context.fetchFailure}`);
  }
  notes.push('counts.candidates = B1 + B2 + B3 + observe：落在观察区 [T-cooldown, T-7) 的条目只输出、不判 B 档（verdict: "observe"），不得混进 B1');
  if (observeCount > 0) {
    notes.push(`本次有 ${observeCount} 条落在观察区（%(committerdate) ∈ [T-${context.cooldownDays}, T-7)）：只输出，不参与 B1/B2/B3 与后续 G3/G4 处置`);
  }

  return {
    schema: 'branch-cleanup-plan/v1',
    readonly: true,
    generated_at: new Date().toISOString(),
    repo: context.repo,
    base: context.base,
    base_sha: context.base_sha,
    cooldown_days: context.cooldownDays,
    now: context.now.toISOString(),
    cutoff: context.cutoff.toISOString(),
    b_cutoff: context.bCutoff.toISOString(),
    observe_window: {
      from: context.bCutoff.toISOString(),
      to: context.cutoff.toISOString(),
      days: [context.observeMinDays, context.cooldownDays],
      rule: OBSERVE_VERDICT.summary,
    },
    // 快照时刻与 digest：清点结论对 ref 快照敏感（实测 pool 74→75 只因为多了一条 ref），
    // 归档时必须与 taken_at 一起记录 digest，否则「结论变了」无法区分是现场变了还是判据不稳。
    snapshot: {
      taken_at: context.now.toISOString(),
      digest_algorithm: 'sha256',
      digest: refSnapshotDigest(context.refs),
      ref_count: context.refs.length,
      fetched: context.fetched,
    },
    read_only_guarantee: [
      '本清单由 scripts/branch-audit.mjs 产出；脚本不提供任何删除/改写子命令',
      `唯一写 .git 的动作是 ${context.fetchCommand}（--no-fetch/--offline 关闭）；${pruneClause}`,
      'G3/G4/G5（本地删除、远端删除、执行回填）只由人工在 owner 字面批准后执行',
    ],
    evidence: {
      ref_count: context.refs.length,
      fetched: context.fetched,
      open_pr_heads: {
        source: context.openPrHeads.source,
        available: context.openPrHeads.available,
        count: context.openPrHeads.shas.length,
        shas: context.openPrHeads.shas,
        merged_as_of_base: context.openPrHeads.merged_pr_heads ?? [],
      },
      worktrees: context.worktreeBranches.map((entry) => ({ branch: entry.branch, worktree: entry.worktree })),
      active_claims: context.activeClaims.map((entry) => ({ task_id: entry.task_id, branches: entry.branches })),
      task_table: { path: path.relative(context.repo, context.tasksPath) || context.tasksPath, rows: context.taskRows.size },
      issue_status: { source: context.issues.source, entries: context.issues.statuses.size },
      tags: context.tagShas.size,
    },
    counts: {
      pool: context.refs.length,
      candidates: candidates.length,
      B1: countByVerdict('B1'),
      B2: countByVerdict('B2'),
      B3: countByVerdict('B3'),
      observe: observeCount,
      excluded: excluded.length,
      excluded_by_rule: excludedByRule,
    },
    candidates,
    excluded,
    notes,
    exit_code: context.openPrHeads.available ? EXIT_CODES.ok : EXIT_CODES.incomplete,
  };
}

// ---------------------------------------------------------------- CLI
export function parseArgs(argv) {
  const options = { repo: null, base: DEFAULT_BASE, cooldownDays: DEFAULT_COOLDOWN_DAYS, now: null, out: null };
  const readValue = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} 需要一个取值`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help': case '-h': options.help = true; break;
      case '--repo': options.repo = readValue(index, arg); index += 1; break;
      case '--base': options.base = readValue(index, arg); index += 1; break;
      case '--cooldown-days': case '--cooldown':
        options.cooldownDays = Number(readValue(index, arg)); index += 1; break;
      case '--now': options.now = readValue(index, arg); index += 1; break;
      case '--out': options.out = readValue(index, arg); index += 1; break;
      case '--tasks': options.tasks = readValue(index, arg); index += 1; break;
      case '--pr-heads-json': options.prHeadsJson = readValue(index, arg); index += 1; break;
      case '--issues-json': options.issuesPath = readValue(index, arg); index += 1; break;
      case '--no-fetch': options.noFetch = true; break;
      case '--prune': options.prune = true; break;
      case '--offline': options.offline = true; options.noFetch = true; break;
      default: throw new Error(`未知参数 ${arg}`);
    }
  }
  if (!Number.isFinite(options.cooldownDays) || options.cooldownDays < 0) {
    throw new Error(`--cooldown-days 必须是非负数，实际 ${options.cooldownDays}`);
  }
  if (options.issuesPath) {
    options.issues = JSON.parse(fs.readFileSync(options.issuesPath, 'utf8'));
  }
  return options;
}

export function helpText() {
  return [
    '用法: node scripts/branch-audit.mjs [--repo <path>] [--base origin/main] [--cooldown-days 14]',
    '                                   [--now <ISO8601>] [--out <path>] [--tasks docs/TASKS.md]',
    '                                   [--pr-heads-json <path>] [--issues-json <path>]',
    '                                   [--no-fetch] [--offline] [--prune]',
    '',
    '选项:',
    '  --repo <path>            仓库路径（默认当前目录）',
    '  --base <ref>             基线分支（默认 origin/main）',
    '  --cooldown-days <n>      A4 冷却天数（默认 14，别名 --cooldown）；[T-n, T-7) 为观察区，只输出 verdict: "observe"（%(committerdate) 恰等于 T-n 时判 observe）',
    '  --now <ISO8601>          以该时刻作为「现在」，可复现历史判定',
    '  --out <path>             额外把 JSON 写一份到该路径（默认只写 stdout）',
    '  --tasks <path>           docs/TASKS.md 路径（默认仓库内 docs/TASKS.md）',
    '  --pr-heads-json <path>   A2 的 open PR head SHA 集合，格式 [{sha}] / {shas:[]} / ["<sha>"]',
    '  --issues-json <path>     A3/A5 的平台 issue 状态，格式 [{identifier,status}] / {issues:[]} / {"JEID-55":"in_progress"}',
    '  --no-fetch               不执行 git fetch origin（默认仍会做一次不带 --prune 的 fetch）',
    '  --prune                  显式让 fetch 带上 --prune；会修剪远端已删除分支对应的本地 remote-tracking ref，默认关闭',
    '  --offline                等价 --no-fetch，且未给 --pr-heads-json 时 A2 判 unknown',
    '',
    '退出码: 0 清单完整，1 参数/环境致命错误，2 清单不完整（A2 证据缺失，候选已抑制）',
    '',
    '只读：本脚本不提供任何删除/改写子命令；G3/G4/G5 只由人工在 owner 字面批准后执行。',
  ].join('\n');
}

export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`参数错误：${oneLine(error.message)}`);
    return EXIT_CODES.fatal;
  }
  if (options.help) {
    console.log(helpText());
    return EXIT_CODES.ok;
  }
  let plan;
  try {
    plan = buildPlan(options);
  } catch (error) {
    console.error(`审计失败：${oneLine(error.message)}`);
    return EXIT_CODES.fatal;
  }
  const json = JSON.stringify(plan, null, 2);
  if (options.out && options.out !== '-') {
    fs.writeFileSync(path.resolve(options.out), `${json}\n`);
    console.error(`cleanup-plan 已写入 ${path.resolve(options.out)}`);
  }
  console.log(json);
  return plan.exit_code;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url && import.meta.url.endsWith('branch-audit.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
