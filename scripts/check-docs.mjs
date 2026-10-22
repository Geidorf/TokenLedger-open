#!/usr/bin/env node
// 协作文档门禁：把 docs/PROJECT.md §3.2 与 docs/task-logs/README.md 里靠自觉执行的规则
// 变成机器校验。设计依据 docs/archive/audits/collaboration-process-20260725.md §六。
//
// 用法：
//   node scripts/check-docs.mjs            校验，失败退出码 1
//   node scripts/check-docs.mjs --json     以 JSON 输出全部问题（供 CI 注解使用）
//
// 本脚本只读；不修改任何被跟踪文件。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = path.join(ROOT, 'docs/TASKS.md');
const PROJECT = path.join(ROOT, 'docs/PROJECT.md');
const LOG_DIR = path.join(ROOT, 'docs/task-logs');
// T10.211：台账归档。存在时按与主台账同样的规则校验，不存在时门禁照常通过。
export const TASKS_ARCHIVE = path.join(ROOT, 'docs/TASKS-archive.md');
const ARCHIVE_LABEL = 'docs/TASKS-archive.md';

// ---------------------------------------------------------------- 枚举定义
// 与 docs/PROJECT.md §3.2 保持一致。改动这里必须同步改 PROJECT。
export const INTEGRATION_VALUES = [
  'not-started',
  'uncommitted',
  'committed',
  'review',
  'partial',
  'merged-local',
  'merged-remote',
  'blocked',
];

export const VALIDATION_VALUES = [
  'not-run',
  'platform-pending',
  'local-passed',
  'target-device-passed',
  'external-pending',
  'blocked',
  'complete',
];

// 日志 status 额外允许两个仅日志适用的终态。
const LOG_STATUS_VALUES = [...INTEGRATION_VALUES, 'historical', 'superseded'];

// `[x]` 的充分必要条件（docs/PROJECT.md §3.2 / §5 DoD 第 8 条）。
const DONE_INTEGRATION = new Set(['merged-local', 'merged-remote']);

const OVERALL_STATUS = ['[ ]', '[~]', '[r]', '[v]', '[x]', '[!]', '[?]'];

// 日志 front matter 必填字段（docs/task-logs/README.md §2）。
const REQUIRED_LOG_FIELDS_LEGACY = [
  'task_id',
  'status',
  'owner',
  'machine',
  'branch',
  'base_sha',
  'target_branch',
  'path_ownership',
];

// 2026-07-25 规范修订新增的必填字段。只对修订日之后的新日志生效——
// 对历史日志强制回填等于事后编造当时未记录的验证事实，见 README §2.3。
const REQUIRED_LOG_FIELDS_NEW = [
  ...REQUIRED_LOG_FIELDS_LEGACY,
  'validation',
  'verification',
];

// 规范修订日。日志文件名以 YYYYMMDD- 开头，据此判定新旧。
const SPEC_REVISION_DATE = 20260725;

// 修订前实际使用过的 status 值 → 新枚举。仅对修订日之前的日志接受，
// 用于保留历史可读性，不允许新日志继续使用。见 README §2.1 迁移说明。
const LEGACY_STATUS_ALIASES = new Map([
  ['active', 'uncommitted'],
  ['merged', 'merged-local'],
  ['integrated', 'merged-local'],
  ['implemented', 'committed'],
  ['in-progress', 'uncommitted'],
  ['local-complete', 'local-passed'],
]);

const PUSH_STATUS_VALUES = ['not-attempted', 'pushed', 'blocked', 'bundle-only'];

// 同上，仅对修订日之前的日志接受。
const LEGACY_PUSH_STATUS = [
  [/^pushed-through-/u, 'pushed'],
  [/^up-to-date$/u, 'pushed'],
  [/^blocked-/u, 'blocked'],
];

function logDateOf(fileName) {
  const m = fileName.match(/^(\d{8})-/u);
  return m ? Number(m[1]) : 0;
}

export function isFullGitSha(value) {
  const bare = String(value).replace(/[`'"]/gu, '');
  return /^[0-9a-f]{40}$/u.test(bare);
}

// 全 SHA 规则机器化前已提交的精确存量债务。只豁免已知文件+字段，避免扩大到
// 整份日志；新日志与其余字段仍必须写单一 40 位 SHA。后续修复时逐项删除。
const LOG_SHA_LEGACY_ALLOWLIST = new Set([
  'docs/task-logs/T10.16/20260803-0105-root-kimidesktop-scan.md::base_sha',
  'docs/task-logs/T10.16/20260803-0105-root-kimidesktop-scan.md::applies_to_sha',
  'docs/task-logs/T10.18/20260803-0917-root-session-gate-selfheal.md::implementation_sha',
  'docs/task-logs/T6.5/20260725-1010-cowork-ambient-preview-and-quota-gauges.md::base_sha',
  'docs/task-logs/T6.5/20260725-1010-cowork-ambient-preview-and-quota-gauges.md::applies_to_sha',
  'docs/task-logs/T6.5/20260725-2100-widget-binding-quota-window.md::base_sha',
  'docs/task-logs/T6.5/20260725-2100-widget-binding-quota-window.md::applies_to_sha',
]);

// 任务表以外、允许没有对应日志目录的任务 ID。
// 这些任务的证据只存在于提交信息里（规范建立前遗留），已在任务行的「验收」列注明。
const TASKS_WITHOUT_LOGS_ALLOWLIST = new Set([
  'T0.1', 'T0.2',
  'T1.1', 'T1.2', 'T1.3', 'T1.4',
  'T2.1', 'T2.2', 'T2.3', 'T2.4',
  'T3.1', 'T3.2', 'T3.3',
  'T4.0', 'T4.1', 'T4.2',
  'T5.1', 'T5.2', 'T5.3',
  'T5.4a', 'T8.8a',
  'T9.2',
]);

// ---------------------------------------------------------------- 工具
const problems = [];
function fail(rule, where, message) {
  problems.push({ rule, where, message });
}

// 警告：先观察一周再转为硬失败（`--strict` 或 TOKENLEDGER_DOCS_STRICT=1 立即
// 把警告当失败）。这三条规则针对 2026-09-03 评审发现的台账失真：[v] 与
// validation 不匹配、已 [x] 的任务仍占着 Active Claim、以及 merged-local 实际
// 早已在 origin/main 上。
const warnings = [];
function warn(rule, where, message) {
  warnings.push({ rule, where, message });
}

// [v] = 已合入、待平台/外部验收：只表达"仅缺真实平台/外部服务"。
const V_INTEGRATION = new Set(['merged-local', 'merged-remote']);
const V_VALIDATION = new Set(['platform-pending', 'external-pending', 'target-device-passed']);

export function evaluateOverallConsistency(row) {
  const findings = [];
  if (row.overall !== '[v]') return findings;
  if (!V_INTEGRATION.has(row.integration)) {
    findings.push({
      rule: 'v-integration',
      message: `${row.id} 标记 [v]（已合入、待平台/外部验收），但 integration=\`${row.integration}\`；未合入应写 [r] 或 [~]`,
    });
  }
  if (!V_VALIDATION.has(row.validation)) {
    findings.push({
      rule: 'v-validation',
      message: `${row.id} 标记 [v]，但 validation=\`${row.validation}\`；[v] 只表达"仅缺真实平台/外部服务"，应为 ${[...V_VALIDATION].join(' | ')}`,
    });
  }
  return findings;
}

// T10.211：归档行必须满足「可归档」条件与里程碑归属。可归档有两类（docs/PROJECT.md §4.2）：
// 已完成（[x]、merged-remote、complete），或代码已推送、只差平台验收的待验行（[v]、merged-remote，
// validation 不是 complete/not-run）；后者在主台账「平台待验清单」留 ID 索引。
// 纯函数、只返回发现，不直接写共享 problems 数组，方便单测。
// 归档待验行与主台账 [v] 同一口径，避免归档里出现主台账判为不一致的行。
const ARCHIVED_PENDING_VALIDATION = V_VALIDATION;

export function isArchivableRow(row) {
  if (row.integration !== 'merged-remote') return false;
  if (row.overall === '[x]') return row.validation === 'complete';
  if (row.overall === '[v]') return ARCHIVED_PENDING_VALIDATION.has(row.validation);
  return false;
}

export function evaluateArchiveRow(row) {
  const findings = [];
  if (!isArchivableRow(row)) {
    findings.push({
      rule: 'archive-criteria',
      message: `${row.id} 在归档中，但总状态=\`${row.overall}\` integration=\`${row.integration}\` `
        + `validation=\`${row.validation}\`；归档行只能是 [x]/merged-remote/complete，`
        + '或 [v]/merged-remote 的平台待验行',
    });
  }
  if (!row.milestone) {
    findings.push({ rule: 'milestone', message: `${row.id} 不在任何 ### M<n> 小节下` });
  }
  return findings;
}

// T10.211：同一任务 ID 不得同时出现在主台账与归档里；返回主台账里违规的行。
export function findCrossFileDuplicateIds(rows, archiveRows) {
  const archiveIds = new Set(archiveRows.map((r) => r.id));
  return rows.filter((row) => archiveIds.has(row.id));
}

export function selectLogSha(frontMatter) {
  for (const key of ['merge_sha', 'implementation_sha']) {
    const value = frontMatter?.[key];
    if (!value || value === 'null' || Array.isArray(value)) continue;
    const bare = String(value).replace(/[`'"]/gu, '');
    if (/^[0-9a-f]{40}$/u.test(bare)) return bare;
  }
  return null;
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u);
}

function unwrapCode(cell) {
  return cell.trim().replace(/^`+|`+$/gu, '').trim();
}

function splitRow(line) {
  // Markdown 表格行：去掉首尾竖线后按竖线切分。表格单元格内不允许出现裸竖线。
  const body = line.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return body.split('|').map((c) => c.trim());
}

// ---------------------------------------------------------------- 解析 TASKS §3
const TASK_TABLE_COLUMNS = 8;

export function parseTaskTable(lines, label = 'docs/TASKS.md') {
  const rows = [];
  let section = null;
  let inTaskSection = false;

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();

    if (/^##\s+3\./u.test(line)) { inTaskSection = true; return; }
    if (inTaskSection && /^##\s+(?!#)/u.test(line)) { inTaskSection = false; return; }
    if (!inTaskSection) return;

    const heading = line.match(/^###\s+(M\d+)\s+(.*)$/u);
    if (heading) { section = heading[1]; return; }

    if (!line.startsWith('|')) return;
    if (/^\|\s*ID\s*\|/u.test(line)) return;          // 表头
    if (/^\|[\s:-]+\|/u.test(line)) return;           // 分隔行

    const cells = splitRow(line);
    if (cells.length !== TASK_TABLE_COLUMNS) {
      fail('table-shape', `${label}:${lineNo}`,
        `任务表应为 ${TASK_TABLE_COLUMNS} 列，实际 ${cells.length} 列：${cells[0] || line.slice(0, 40)}`);
      return;
    }

    const [id, title, deps, refs, overall, integration, validation, acceptance] = cells;
    rows.push({
      id, title, deps, refs,
      overall: overall.trim(),
      integration: unwrapCode(integration),
      validation: unwrapCode(validation),
      acceptance,
      lineNo,
      milestone: section,
    });
  });

  return rows;
}

// ---------------------------------------------------------------- 解析日志 front matter
function parseFrontMatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = text.slice(text.indexOf('\n') + 1, end + 1);

  // 只解析顶层 `key: value` 与 `key:` + 缩进列表；足够覆盖本仓库的 front matter 形态，
  // 不引入 YAML 依赖，避免门禁本身成为新的依赖来源。
  const fields = {};
  let currentKey = null;
  for (const line of block.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const top = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u);
    if (top) {
      currentKey = top[1];
      fields[currentKey] = top[2].trim();
      continue;
    }
    if (/^\s+-\s+/u.test(line) && currentKey) {
      if (fields[currentKey] === '') fields[currentKey] = [];
      if (Array.isArray(fields[currentKey])) fields[currentKey].push(line.trim().slice(2).trim());
    }
  }
  return fields;
}

// ---------------------------------------------------------------- 校验
function checkEnumsMatchProject(projectText) {
  // PROJECT §3.2 是枚举的事实源；脚本里的常量必须与之一致，否则两边会各自漂移。
  for (const value of INTEGRATION_VALUES.concat(VALIDATION_VALUES)) {
    if (!projectText.includes(`\`${value}\``)) {
      fail('enum-sync', 'docs/PROJECT.md §3.2',
        `枚举值 \`${value}\` 在脚本中定义，但 PROJECT.md 未出现；两边必须同步`);
    }
  }
}

export function checkTaskRows(rows, label = 'docs/TASKS.md', {
  reportFail = fail,
  reportWarn = warn,
  checkMilestone = true,
} = {}) {
  const seen = new Map();

  for (const row of rows) {
    const at = `${label}:${row.lineNo}`;

    // 允许：T6.4 / T5.1a / T6.4-A / T7.6b+c（并行合并任务）/ T8.2-T8.4（批次任务）
    // 以及 Multica Issue 直接入账的 TOKE-<数字>（docs/PROJECT.md §3.1）。
    const idOk = /^T\d+(\.\d+)?[a-z]*(\+[a-z])?(-[A-Z])?$/u.test(row.id)
      || /^T\d+\.\d+[a-z]*-T\d+\.\d+[a-z]*$/u.test(row.id)
      || /^TOKE-\d+$/u.test(row.id);
    if (!idOk) {
      reportFail('task-id', at, `任务 ID 形如 T<数字>.<数字>[后缀] 或 TOKE-<数字>，实际：${row.id}`);
    }

    if (seen.has(row.id)) {
      reportFail('duplicate-id', at, `任务 ID ${row.id} 重复，另一处在第 ${seen.get(row.id)} 行`);
    } else {
      seen.set(row.id, row.lineNo);
    }

    if (!OVERALL_STATUS.includes(row.overall)) {
      reportFail('overall-status', at, `${row.id} 总状态 \`${row.overall}\` 不在 ${OVERALL_STATUS.join(' ')} 之内`);
    }

    if (!INTEGRATION_VALUES.includes(row.integration)) {
      reportFail('integration-enum', at,
        `${row.id} integration=\`${row.integration}\` 不在枚举内。合法值：${INTEGRATION_VALUES.join(' | ')}`);
    }

    if (!VALIDATION_VALUES.includes(row.validation)) {
      reportFail('validation-enum', at,
        `${row.id} validation=\`${row.validation}\` 不在枚举内。合法值：${VALIDATION_VALUES.join(' | ')}`);
    }

    // DoD：`[x]` 的充分必要条件。
    const claimsDone = row.overall === '[x]';
    const meetsDone = DONE_INTEGRATION.has(row.integration) && row.validation === 'complete';
    if (claimsDone && !meetsDone) {
      reportFail('dod', at,
        `${row.id} 标记 [x]，但 integration=\`${row.integration}\` validation=\`${row.validation}\`；` +
        `[x] 要求 integration ∈ {merged-local, merged-remote} 且 validation=complete`);
    }
    if (!claimsDone && meetsDone) {
      reportFail('dod', at,
        `${row.id} 已满足 [x] 出口条件（${row.integration} / complete），但总状态仍是 ${row.overall}；` +
        `请升级为 [x] 或说明为何不满足`);
    }

    for (const finding of evaluateOverallConsistency(row)) {
      reportWarn(finding.rule, at, finding.message);
    }

    if (checkMilestone && !row.milestone) {
      reportFail('milestone', at, `${row.id} 不在任何 ### M<n> 小节下`);
    }

    if (!row.acceptance?.trim()) {
      reportFail('acceptance', at, `${row.id} 的「验收 / 当前缺口」列为空；状态必须有可复核依据`);
    }
  }

  return seen;
}

function checkDependencies(rows, idSet, label = 'docs/TASKS.md') {
  for (const row of rows) {
    const deps = row.deps.split(/[,，、]/u).map((d) => d.trim()).filter(Boolean);
    for (const dep of deps) {
      if (/^M\d/u.test(dep) || !/^(?:T\d|TOKE-\d)/u.test(dep)) continue; // 里程碑级或散文式依赖不校验
      if (/[~～]/u.test(dep)) continue;                       // `T8.2~T8.7` 区间写法只表达范围
      const clean = dep.replace(/[`]/gu, '').split(/\s/u)[0];
      if (!idSet.has(clean)) {
        fail('dangling-dep', `${label}:${row.lineNo}`,
          `${row.id} 依赖 ${clean}，但任务表（含归档）中没有这一行`);
      }
    }
  }
}

function checkMilestonesDeclared(lines, rows) {
  const declared = new Set();
  let inMilestoneTable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+1\./u.test(line)) { inMilestoneTable = true; continue; }
    if (inMilestoneTable && /^##\s/u.test(line)) { inMilestoneTable = false; continue; }
    if (!inMilestoneTable || !line.startsWith('|')) continue;
    const m = line.match(/^\|\s*(M\d+)\s/u);
    if (m) declared.add(m[1]);
  }
  const used = new Set(rows.map((r) => r.milestone).filter(Boolean));
  for (const m of used) {
    if (!declared.has(m)) {
      fail('milestone-undeclared', 'docs/TASKS.md §1',
        `§3 存在 ### ${m} 小节，但 §1 里程碑表没有定义 ${m}`);
    }
  }
}

function checkLogs(idSet) {
  if (!fs.existsSync(LOG_DIR)) return;

  const dirs = fs.readdirSync(LOG_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const ids = [...idSet];

  // 双向：日志目录 → 任务行。
  // 目录可以聚合子任务（`T8/` 承载 `T8.2-T8.4`，`T7.6/` 承载 `T7.6a`），
  // 因此只要有任一任务 ID 以该目录名为前缀即视为已登记。
  for (const dir of dirs) {
    if (idSet.has(dir)) continue;
    if (ids.some((id) => id.startsWith(dir))) continue;
    fail('log-orphan', `docs/task-logs/${dir}/`,
      `存在任务日志目录，但 TASKS §3 与 ${ARCHIVE_LABEL} 都没有 ${dir} 的任务行；工作不得发生在台账之外`);
  }

  // 双向：任务行 → 日志目录。父任务可由子任务日志承载，反之亦然。
  const dirSet = new Set(dirs);
  for (const id of ids) {
    if (TASKS_WITHOUT_LOGS_ALLOWLIST.has(id)) continue;
    if (dirSet.has(id)) continue;
    const base = id.replace(/-[A-Z]$/u, '');                  // T6.4-A → T6.4
    if (dirSet.has(base)) continue;
    if (dirs.some((d) => d.startsWith(id) || id.startsWith(d))) continue;
    fail('task-without-log', `docs/TASKS.md §3 / ${ARCHIVE_LABEL} §3`,
      `${id} 有任务行但没有 docs/task-logs/${id}/；没有日志就没有可复核证据`);
  }

  // front matter 校验
  for (const dir of dirs) {
    const files = fs.readdirSync(path.join(LOG_DIR, dir)).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const rel = `docs/task-logs/${dir}/${file}`;
      const text = fs.readFileSync(path.join(LOG_DIR, dir, file), 'utf8');
      const fm = parseFrontMatter(text);

      // README §2.3 历史豁免：不以 --- 开头即规范建立前存量，跳过且不报错。
      if (!fm) continue;

      const isNew = logDateOf(file) >= SPEC_REVISION_DATE;
      const required = isNew ? REQUIRED_LOG_FIELDS_NEW : REQUIRED_LOG_FIELDS_LEGACY;

      for (const field of required) {
        if (!(field in fm) || fm[field] === '') {
          fail('log-field', rel, `front matter 缺少必填字段 \`${field}\`（见 task-logs/README.md §2）`);
        }
      }

      if (fm.status && !LOG_STATUS_VALUES.includes(fm.status)) {
        const alias = LEGACY_STATUS_ALIASES.get(fm.status)
          || (/^implemented-pending-/u.test(fm.status) ? 'committed' : null);
        if (isNew || !alias) {
          fail('log-status', rel,
            `status=\`${fm.status}\` 不在枚举内`
            + (alias ? `（历史别名，新日志应写 \`${alias}\`）` : '')
            + `。合法值：${LOG_STATUS_VALUES.join(' | ')}`);
        }
      }
      if (fm.validation && !VALIDATION_VALUES.includes(fm.validation)) {
        fail('log-validation', rel,
          `validation=\`${fm.validation}\` 不在枚举内。合法值：${VALIDATION_VALUES.join(' | ')}`);
      }
      if (fm.evidence && !['fixture', 'real-platform', 'external-service'].includes(fm.evidence)) {
        fail('log-evidence', rel,
          `evidence=\`${fm.evidence}\` 只能是 fixture | real-platform | external-service`);
      }
      if (fm.push_status && !PUSH_STATUS_VALUES.includes(fm.push_status)) {
        // 历史日志把 SHA 与原因编进了取值（`pushed-through-<sha>`、`blocked-credentials`、
        // `up-to-date`）。这些信息属于正文，不属于枚举；旧日志接受，新日志拒绝。
        const alias = LEGACY_PUSH_STATUS.find(([re]) => re.test(fm.push_status));
        if (isNew || !alias) {
          fail('log-push-status', rel,
            `push_status=\`${fm.push_status}\` 只能是 ${PUSH_STATUS_VALUES.join(' | ')}`
            + (alias ? `（历史写法，新日志应写 \`${alias[1]}\` 并把 SHA/原因写进正文）` : ''));
        }
      }

      for (const key of ['base_sha', 'implementation_sha', 'merge_sha', 'applies_to_sha']) {
        const value = fm[key];
        if (!value || value === 'null' || Array.isArray(value)) continue;
        const bare = value.replace(/[`'"]/gu, '');
        if (bare === 'pending' || bare === 'TBD') {
          fail('log-sha', rel, `${key}=\`${bare}\`：尚不存在的 SHA 必须写 null，不得用占位符冒充提交`);
        } else if (
          isNew
          && !isFullGitSha(bare)
          && !LOG_SHA_LEGACY_ALLOWLIST.has(`${rel}::${key}`)
        ) {
          fail('log-sha', rel, `${key}=\`${bare}\`：新日志必须使用单一完整 40 位 Git SHA`);
        }
      }

      if (fm.task_id) {
        const declared = String(fm.task_id).replace(/[`]/gu, '');
        const owning = fm.subtask_id && fm.subtask_id !== 'null' ? String(fm.subtask_id) : declared;
        const matchesDir = declared === dir || owning.startsWith(dir) || declared.startsWith(dir);
        if (!matchesDir) {
          fail('log-task-id', rel, `front matter task_id=${declared} 与所在目录 ${dir} 不一致`);
        }
      }
    }
  }
}

// 与 scripts/archive-tasks.mjs 的自动释放条件一致：已合入且不再是 [~]/[r]。
function isReleasedClaim(row) {
  if (!row) return false;
  if (row.overall === '[x]') return true;
  return DONE_INTEGRATION.has(row.integration) && row.overall !== '[~]' && row.overall !== '[r]';
}

function checkActiveClaims(lines, idSet, rowById = new Map()) {
  // Active Claims 表里登记的任务必须在 §3 存在。
  let inClaims = false;
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (/^##\s+2\./u.test(line)) { inClaims = true; return; }
    if (inClaims && /^###?\s/u.test(line) && !/^##\s+2\./u.test(line)) { inClaims = false; return; }
    if (!inClaims || !line.startsWith('|')) return;
    const m = line.match(/^\|\s*(TOKE-\d+|T\d+[^\s|]*)\s*\|/u);
    if (m && !idSet.has(m[1])) {
      fail('claim-orphan', `docs/TASKS.md:${index + 1}`,
        `Active Claim 登记了 ${m[1]}，但 §3 任务表没有这一行`);
    } else if (m && isReleasedClaim(rowById.get(m[1]))) {
      // 租约滞留：任务已合入主干却仍占着路径所有权，会让后续认领者误判冲突。
      warn('claim-stale', `docs/TASKS.md:${index + 1}`,
        `Active Claim 仍登记着已合入的 ${m[1]}；合入后应运行归档脚本从 §2 释放路径租约`);
    }
  });
}

function latestLogFrontMatter(taskId) {
  const candidates = [taskId, taskId.replace(/-[A-Z]$/u, '')];
  for (const dir of candidates) {
    const absolute = path.join(LOG_DIR, dir);
    if (!fs.existsSync(absolute)) continue;
    const files = fs.readdirSync(absolute).filter((f) => f.endsWith('.md')).sort();
    for (const file of files.reverse()) {
      const fm = parseFrontMatter(fs.readFileSync(path.join(absolute, file), 'utf8'));
      if (fm) return fm;
    }
  }
  return null;
}

function checkRemoteIntegration(rows) {
  // `merged-local` 但实现/合并提交早已在 origin/main 上 ⇒ 应升为 merged-remote。
  // 只在本地存在 origin/main 引用时检查；CI 与常规 clone 都有该引用。
  let hasOriginMain = false;
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], { cwd: ROOT, stdio: 'ignore' });
    hasOriginMain = true;
  } catch {
    hasOriginMain = false;
  }
  if (!hasOriginMain) return;

  for (const row of rows) {
    if (row.integration !== 'merged-local') continue;
    const sha = selectLogSha(latestLogFrontMatter(row.id));
    if (!sha) continue;
    let reachable = false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: ROOT, stdio: 'ignore' });
      reachable = true;
    } catch {
      reachable = false;
    }
    if (reachable) {
      warn('integration-remote', `docs/TASKS.md:${row.lineNo}`,
        `${row.id} 记为 merged-local，但日志里的 ${sha.slice(0, 8)} 已在 origin/main 上；应升为 merged-remote`);
    }
  }
}

// ---------------------------------------------------------------- main
export function runChecks() {
  problems.length = 0;
  warnings.length = 0;

  const taskLines = readLines(TASKS);
  const projectText = fs.readFileSync(PROJECT, 'utf8');

  checkEnumsMatchProject(projectText);

  const rows = parseTaskTable(taskLines);
  if (rows.length === 0) {
    fail('parse', 'docs/TASKS.md §3', '没有解析到任何任务行；表格结构可能已损坏');
    return { problems: [...problems], rowCount: 0 };
  }

  const idMap = checkTaskRows(rows);
  const idSet = new Set(idMap.keys());

  // T10.211：归档文件存在时，其 §3 行按同样规则校验，并入依赖/日志目录/里程碑三项已知任务集合。
  let archiveRows = [];
  if (fs.existsSync(TASKS_ARCHIVE)) {
    const archiveLines = readLines(TASKS_ARCHIVE);
    archiveRows = parseTaskTable(archiveLines, ARCHIVE_LABEL);
    checkTaskRows(archiveRows, ARCHIVE_LABEL, { checkMilestone: false });
    for (const row of archiveRows) {
      for (const finding of evaluateArchiveRow(row)) {
        fail(finding.rule, `${ARCHIVE_LABEL}:${row.lineNo}`, finding.message);
      }
    }
    for (const dup of findCrossFileDuplicateIds(rows, archiveRows)) {
      fail('archive-duplicate-id', `docs/TASKS.md:${dup.lineNo}`,
        `${dup.id} 同时出现在 docs/TASKS.md 与 ${ARCHIVE_LABEL}`);
    }
  }

  const archiveIdSet = new Set(archiveRows.map((row) => row.id));
  const combinedIdSet = new Set([...idSet, ...archiveIdSet]);

  checkDependencies(rows, combinedIdSet);
  if (archiveRows.length > 0) checkDependencies(archiveRows, combinedIdSet, ARCHIVE_LABEL);
  checkMilestonesDeclared(taskLines, [...rows, ...archiveRows]);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  checkActiveClaims(taskLines, idSet, rowById);
  checkLogs(combinedIdSet);
  checkRemoteIntegration(rows);
  checkPendingIndexed(taskLines, archiveRows);

  return {
    problems: [...problems],
    warnings: [...warnings],
    rowCount: rows.length,
    archiveRowCount: archiveRows.length,
  };
}

// 归档里的 [v] 待验行只能从 TASKS §6「平台待验清单」找到，漏登记就会从待验工作清单里消失。
export function findUnindexedPending(taskLines, archiveRows) {
  const start = taskLines.findIndex((line) => /^##\s+6\./u.test(line.trim()));
  let end = taskLines.length;
  if (start !== -1) {
    for (let i = start + 1; i < taskLines.length; i += 1) {
      if (/^##\s+\S/u.test(taskLines[i].trim())) { end = i; break; }
    }
  }
  const tableText = start === -1 ? '' : taskLines.slice(start, end).filter((line) => line.trim().startsWith('|')).join('\n');
  const indexed = new Set(tableText.split(/[\s|、，,；;（）()`]+/u));
  return archiveRows.filter((row) => row.overall === '[v]' && !indexed.has(row.id));
}

// 反向：§6 里列出的 ID 必须仍是归档 [v] 待验行；验收闭合改成 [x] 后要从清单删去（PROJECT §4.2）。
export function findStalePendingIndex(taskLines, archiveRows) {
  const start = taskLines.findIndex((line) => /^##\s+6\./u.test(line.trim()));
  if (start === -1) return [];
  let end = taskLines.length;
  for (let i = start + 1; i < taskLines.length; i += 1) {
    if (/^##\s+\S/u.test(taskLines[i].trim())) { end = i; break; }
  }
  const pending = new Set(archiveRows.filter((row) => row.overall === '[v]').map((row) => row.id));
  const stale = [];
  for (let i = start; i < end; i += 1) {
    if (!taskLines[i].trim().startsWith('|')) continue;
    for (const token of taskLines[i].split(/[\s|、，,；;（）()`]+/u)) {
      if (/^(?:TOKE-\d+|T\d+\.\S*)$/u.test(token) && !pending.has(token)) stale.push({ id: token, lineNo: i + 1 });
    }
  }
  return stale;
}

function checkPendingIndexed(taskLines, archiveRows) {
  for (const row of findUnindexedPending(taskLines, archiveRows)) {
    fail('pending-unindexed', `${ARCHIVE_LABEL}:${row.lineNo}`,
      `${row.id} 是归档里的 [v] 待验行，但没有登记在 docs/TASKS.md §6 平台待验清单`);
  }
  for (const entry of findStalePendingIndex(taskLines, archiveRows)) {
    fail('pending-stale', `docs/TASKS.md:${entry.lineNo}`,
      `${entry.id} 列在 §6 平台待验清单，但不是归档里的 [v] 待验行（已闭合请从清单删去）`);
  }
}

function printGrouped(items, label) {
  const byRule = new Map();
  for (const item of items) {
    if (!byRule.has(item.rule)) byRule.set(item.rule, []);
    byRule.get(item.rule).push(item);
  }
  for (const [rule, entries] of byRule) {
    console.error(`── ${rule}（${entries.length}）${label}`);
    for (const entry of entries) console.error(`   ${entry.where}\n     ${entry.message}`);
    console.error('');
  }
}

function main(args) {
  const asJson = args.includes('--json');
  const strict = args.includes('--strict') || process.env.TOKENLEDGER_DOCS_STRICT === '1';
  const result = runChecks();
  const found = strict ? [...result.problems, ...result.warnings] : result.problems;
  const softWarnings = strict ? [] : result.warnings;
  const { rowCount, archiveRowCount } = result;

  if (asJson) {
    console.log(JSON.stringify({
      ok: found.length === 0,
      rowCount,
      archiveRowCount,
      problems: found,
      warnings: softWarnings,
    }, null, 2));
    return found.length === 0 ? 0 : 1;
  }

  if (found.length === 0) {
    const archiveNote = archiveRowCount > 0 ? `（另含归档 ${archiveRowCount} 行）` : '';
    console.log(`文档门禁通过：${rowCount} 行任务${archiveNote}、状态枚举、DoD、依赖、里程碑与任务日志双向一致。`);
    if (softWarnings.length > 0) {
      console.error(`\n文档门禁警告：${softWarnings.length} 个（观察期内不阻断；加 --strict 或 TOKENLEDGER_DOCS_STRICT=1 转为失败）\n`);
      printGrouped(softWarnings, '· 警告');
    }
    return 0;
  }

  const byRule = new Map();
  for (const p of found) {
    if (!byRule.has(p.rule)) byRule.set(p.rule, []);
    byRule.get(p.rule).push(p);
  }

  const archiveSuffix = archiveRowCount > 0 ? `，另含归档 ${archiveRowCount} 行` : '';
  console.error(`\n文档门禁失败：${found.length} 个问题（共检查 ${rowCount} 行任务${archiveSuffix}）\n`);
  for (const [rule, items] of byRule) {
    console.error(`── ${rule}（${items.length}）`);
    for (const item of items) console.error(`   ${item.where}\n     ${item.message}`);
    console.error('');
  }
  console.error('规则定义见 docs/PROJECT.md §3.2 与 docs/task-logs/README.md。\n');
  return 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url && import.meta.url.endsWith('check-docs.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
