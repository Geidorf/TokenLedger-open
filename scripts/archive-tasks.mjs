#!/usr/bin/env node
// docs/TASKS.md 归档器（T10.211）。
//
// 用法：
//   node scripts/archive-tasks.mjs [--before YYYY-MM-DD] [--dry-run]
//                                   [--pending-ids <file>] [--release-claims <file>]
//                                   [--tasks <path>] [--archive <path>]
//
// 把 §3 中同时满足「[x]、integration=merged-remote、validation=complete」的行，
// 连同 §2 里同 ID 的活跃认领，移到 docs/TASKS-archive.md（不存在就新建，表头与
// 主台账逐字节相同）。给出 --before 时，§4 集成日志里日期早于该参数的条目也
// 移入归档的同名一节，合并后仍保持最新在上；§4 既可以是 `### YYYY-MM-DD …` 小节，
// 也可以是 `- YYYY-MM-DD：…` 列表项，列表项移入归档时包成 `### YYYY-MM-DD` 小节。
//
// --pending-ids 指向一个每行一个任务 ID 的文件：其中 [v]、merged-remote 的平台待验行
// 也一并移入归档（docs/PROJECT.md §4.2），不满足条件的 ID 报错退出。
// §2 认领在任务已合入（integration=merged-local/merged-remote）且总状态不是 [~]/[r]
// 时自动释放并移入归档；--release-claims 文件里列出的 ID 无论状态都释放。
// §2 只把第一个 ### 子节之前的表格当作认领表，§2.1 等子节不受影响。
//
// 幂等：没有可移动的内容时，两个文件都不改动（包括不重写、不触碰 mtime 以外的
// 字节）。--dry-run 只计算并打印移动前后的行数与文件大小，不写任何文件。
//
// --tasks/--archive 覆盖默认路径，仅用于在副本上演示；默认路径是仓库里的真实
// docs/TASKS.md 与 docs/TASKS-archive.md——按 T10.211 的规则，只有 root 在合入
// 时才对真实文件运行本脚本。
//
// 本脚本只做「整行/整块搬移」，不重排列、不重新生成表格单元格内容，最大程度
// 保留原始 Markdown 字节，方便 diff 复核。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isArchivableRow, parseTaskTable } from './check-docs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TASKS = path.join(ROOT, 'docs/TASKS.md');
const DEFAULT_ARCHIVE = path.join(ROOT, 'docs/TASKS-archive.md');
const ARCHIVE_LABEL = 'docs/TASKS-archive.md';

const ARCHIVE_INTRO = [
  '# TokenLedger · 任务台账归档',
  '',
  '> 由 `scripts/archive-tasks.mjs` 生成与维护：已推送且验收完成（`[x]`、`merged-remote`、`complete`）的',
  '> 任务行、已推送且只差平台验收的 `[v]`/`merged-remote` 行（主台账「平台待验清单」留索引）、',
  '> 已释放的活跃认领与较早的集成日志从 `docs/TASKS.md` 移入此处，主台账只留进行中的工作。',
  '> `npm run check:docs` 把这里的 §3 行当作已知任务一并校验依赖、日志目录与里程碑，并禁止同一 ID',
  '> 同时出现在两个文件。请勿手工编辑表格行——重复运行归档脚本是幂等的；唯一例外是待验行验收闭合时，',
  '> 协调者就地改为 `[x]`/`complete`（docs/PROJECT.md §4.2）。',
];

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const args = {
    dryRun: false,
    before: null,
    pendingIdsPath: null,
    releaseClaimsPath: null,
    tasksPath: DEFAULT_TASKS,
    archivePath: DEFAULT_ARCHIVE,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--before') args.before = argv[i += 1];
    else if (a === '--pending-ids') args.pendingIdsPath = path.resolve(argv[i += 1]);
    else if (a === '--release-claims') args.releaseClaimsPath = path.resolve(argv[i += 1]);
    else if (a === '--tasks') args.tasksPath = path.resolve(argv[i += 1]);
    else if (a === '--archive') args.archivePath = path.resolve(argv[i += 1]);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  if (args.before && !/^\d{4}-\d{2}-\d{2}$/u.test(args.before)) {
    throw new Error(`--before 需要 YYYY-MM-DD 格式，实际：${args.before}`);
  }
  return args;
}

// ---------------------------------------------------------------- 小工具
function splitLines(text) {
  return text.split(/\r?\n/u);
}

function readIdList(file) {
  if (!file) return new Set();
  return new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/u).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function idSortKey(id) {
  return String(id).split(/(\d+)/u).map((part) => (/^\d+$/u.test(part) ? part.padStart(8, '0') : part));
}

function compareIds(a, b) {
  const ka = idSortKey(a);
  const kb = idSortKey(b);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i += 1) {
    const pa = ka[i] ?? '';
    const pb = kb[i] ?? '';
    if (pa !== pb) return pa < pb ? -1 : 1;
  }
  return 0;
}

function milestoneNumber(headingText) {
  const m = String(headingText || '').match(/^###\s+M(\d+)/u);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------- 顶层 “## N.” 小节边界
function topSectionRange(lines, n) {
  const re = new RegExp(`^##\\s+${n}\\.`, 'u');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (start === -1) {
      if (re.test(line)) start = i;
      continue;
    }
    if (/^##\s+\S/u.test(line)) { end = i; break; }
  }
  return start === -1 ? null : { start, end };
}

// ---------------------------------------------------------------- §2 活跃认领
function extractActiveClaims(lines, range) {
  let headerLine = null;
  let sepLine = null;
  const rows = [];
  for (let i = range.start; i < range.end; i += 1) {
    const trimmed = lines[i].trim();
    if (/^###\s/u.test(trimmed)) break;
    if (!trimmed.startsWith('|')) continue;
    if (headerLine === null) { headerLine = lines[i]; continue; }
    if (sepLine === null) { sepLine = lines[i]; continue; }
    const m = trimmed.match(/^\|\s*(TOKE-\d+|T\d+[^\s|]*)\s*\|/u);
    rows.push({ lineIdx: i, id: m ? m[1] : null, raw: lines[i] });
  }
  return { headerLine, sepLine, rows };
}

// ---------------------------------------------------------------- §3 任务表辅助
function computeMilestoneHeadingByLine(lines, range) {
  const headingText = new Array(lines.length).fill(null);
  let current = null;
  for (let i = range.start; i < range.end; i += 1) {
    if (/^###\s+M\d+/u.test(lines[i].trim())) current = lines[i];
    headingText[i] = current;
  }
  return headingText;
}

function extractTaskTableHeaderSep(lines, range) {
  for (let i = range.start; i < range.end - 1; i += 1) {
    if (/^\|\s*ID\s*\|/u.test(lines[i].trim())) {
      return { header: lines[i], sep: canonicalSep(lines[i], lines[i + 1]) };
    }
  }
  return null;
}

// 某一行所在表格自己的表头与分隔行：各里程碑表格的对齐写法不同，不能共用第一张表的。
function headerSepForLine(lines, lineIdx, range) {
  for (let i = lineIdx - 1; i >= range.start; i -= 1) {
    if (/^\|\s*ID\s*\|/u.test(lines[i].trim())) {
      return { header: lines[i], sep: canonicalSep(lines[i], lines[i + 1]) };
    }
  }
  return extractTaskTableHeaderSep(lines, range);
}

function cellCount(line) {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').length;
}

// 分隔行列数与表头不一致时 Markdown 不认作表格，按表头列数重写；一致则原样保留（含对齐写法）。
function canonicalSep(header, sep) {
  const n = cellCount(header);
  if (sep && cellCount(sep) === n) return sep;
  return `|${'---|'.repeat(n)}`;
}

// ---------------------------------------------------------------- §4 集成日志块
// 块起点：`### …` 小节标题，或以日期开头的顶层列表项 `- YYYY-MM-DD：…`。
// 标题块里的日期列表项属于该标题块（归档时列表项会被包进同日期标题），不另起一块。
const LOG_BULLET_RE = /^-\s+(\d{4}-\d{2}-\d{2})/u;

function extractLogBlocks(lines, range) {
  const starts = [];
  let insideHeading = false;
  for (let i = range.start; i < range.end; i += 1) {
    const line = lines[i];
    if (/^###\s+/u.test(line.trim())) {
      starts.push({ idx: i, bullet: false });
      insideHeading = true;
    } else if (!insideHeading && LOG_BULLET_RE.test(line)) {
      starts.push({ idx: i, bullet: true });
    }
  }
  return starts.map(({ idx: startIdx, bullet }, k) => {
    const endIdx = k + 1 < starts.length ? starts[k + 1].idx : range.end;
    const dateMatch = bullet
      ? lines[startIdx].match(LOG_BULLET_RE)
      : lines[startIdx].trim().match(/^###\s+(\d{4}-\d{2}-\d{2})/u);
    return { startIdx, endIdx, bullet, date: dateMatch ? dateMatch[1] : null };
  });
}

function logBlockForArchive(lines, block) {
  const body = lines.slice(block.startIdx, block.endIdx);
  if (!block.bullet) return body;
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  return [`### ${block.date}`, '', ...body, ''];
}

// ---------------------------------------------------------------- 统计（供 --dry-run 与正常运行共用）
function countStats(lines, eol) {
  const text = lines.join(eol);
  const bytes = Buffer.byteLength(text, 'utf8');
  let claims = 0;
  let tasks = 0;
  let logs = 0;
  const r2 = topSectionRange(lines, 2);
  if (r2) claims = extractActiveClaims(lines, r2).rows.length;
  const r3 = topSectionRange(lines, 3);
  if (r3) tasks = parseTaskTable(lines).length;
  const r4 = topSectionRange(lines, 4);
  if (r4) logs = extractLogBlocks(lines, r4).length;
  return { claims, tasks, logs, bytes, lineCount: lines.length };
}

function formatStats(s) {
  return `${s.claims} 认领 / ${s.tasks} 任务 / ${s.logs} 日志条目，${s.bytes} 字节（${s.lineCount} 行）`;
}

// ---------------------------------------------------------------- 解析既有归档为结构化数据
function parseExistingArchive(archiveLines) {
  const result = { intro: null, claims: { header: null, sep: null, rows: [] }, taskGroups: [], logBlocks: [] };
  if (archiveLines.length === 0) return result;

  const range2 = topSectionRange(archiveLines, 2);
  if (range2) {
    result.intro = archiveLines.slice(0, range2.start);
    while (result.intro.length > 0 && result.intro[result.intro.length - 1].trim() === '') result.intro.pop();
    const c = extractActiveClaims(archiveLines, range2);
    result.claims = {
      header: c.headerLine,
      sep: c.sepLine,
      rows: c.rows.map((r) => ({ id: r.id, raw: r.raw })),
    };
  }

  const range3 = topSectionRange(archiveLines, 3);
  if (range3) {
    const rows = parseTaskTable(archiveLines, ARCHIVE_LABEL);
    const headingByLine = computeMilestoneHeadingByLine(archiveLines, range3);
    const groups = new Map();
    for (const row of rows) {
      const heading = headingByLine[row.lineNo - 1] || '### M?（未归类）';
      if (!groups.has(heading)) {
        const headerSep = headerSepForLine(archiveLines, row.lineNo - 1, range3);
        groups.set(heading, { heading, header: headerSep?.header, sep: headerSep?.sep, rows: [] });
      }
      groups.get(heading).rows.push({ id: row.id, raw: archiveLines[row.lineNo - 1] });
    }
    result.taskGroups = [...groups.values()];
  }

  const range4 = topSectionRange(archiveLines, 4);
  if (range4) {
    result.logBlocks = extractLogBlocks(archiveLines, range4)
      .map((b) => ({ date: b.date, lines: archiveLines.slice(b.startIdx, b.endIdx) }));
  }

  return result;
}

// ---------------------------------------------------------------- 序列化归档
function serializeArchive(data) {
  const out = [...(data.intro && data.intro.length > 0 ? data.intro : ARCHIVE_INTRO)];
  out.push('', '## 2. 活跃认领', '');
  if (data.claims.header) {
    out.push(data.claims.header, data.claims.sep);
    for (const row of data.claims.rows) out.push(row.raw);
  }
  out.push('', '## 3. 任务表', '');
  for (const group of data.taskGroups) {
    out.push(group.heading, '');
    if (group.header) out.push(group.header, group.sep);
    for (const row of group.rows) out.push(row.raw);
    out.push('');
  }
  out.push('## 4. 集成日志（历史证据，只追加，最新在上）', '');
  for (const block of data.logBlocks) out.push(...block.lines);
  return out;
}

// ---------------------------------------------------------------- 主流程
function run(args) {
  const tasksText = fs.readFileSync(args.tasksPath, 'utf8');
  const eol = detectEol(tasksText);
  const tasksLines = splitLines(tasksText);

  const archiveExisted = fs.existsSync(args.archivePath);
  const archiveText = archiveExisted ? fs.readFileSync(args.archivePath, 'utf8') : '';
  const archiveIsEmpty = archiveText.trim() === '';
  const archiveLines = archiveIsEmpty ? [] : splitLines(archiveText);

  const range2 = topSectionRange(tasksLines, 2);
  const range3 = topSectionRange(tasksLines, 3);
  const range4 = topSectionRange(tasksLines, 4);
  if (!range2 || !range3) {
    throw new Error(`${args.tasksPath} 缺少 §2 或 §3，结构异常，拒绝继续`);
  }

  const allTaskRows = parseTaskTable(tasksLines);
  const pendingIds = readIdList(args.pendingIdsPath);
  const releaseIds = readIdList(args.releaseClaimsPath);
  const rowById = new Map(allTaskRows.map((r) => [r.id, r]));
  const range6 = topSectionRange(tasksLines, 6);
  // 只认 §6 表格行里的 ID，说明文字里顺带提到的 ID 不算登记
  const indexText = range6
    ? tasksLines.slice(range6.start, range6.end).filter((line) => line.trim().startsWith('|')).join('\n')
    : '';
  const indexed = new Set(indexText.split(/[\s|、，,；;（）()`]+/u));
  for (const id of pendingIds) {
    if (!indexed.has(id)) {
      throw new Error(`--pending-ids 里的 ${id} 未登记在 ${args.tasksPath} §6 平台待验清单；先登记再归档`);
    }
    const row = rowById.get(id);
    if (!row) throw new Error(`--pending-ids 里的 ${id} 不在 ${args.tasksPath} §3`);
    if (row.overall !== '[v]' || !isArchivableRow(row)) {
      throw new Error(`--pending-ids 里的 ${id} 不是 [v]/merged-remote 待验行（${row.overall} ${row.integration} ${row.validation}）`);
    }
  }
  const qualifying = allTaskRows.filter(
    (r) => (r.overall === '[x]' && r.integration === 'merged-remote' && r.validation === 'complete')
      || pendingIds.has(r.id),
  );
  const qualifyingIds = new Set(qualifying.map((r) => r.id));
  const headingTextByLine = computeMilestoneHeadingByLine(tasksLines, range3);
  const taskHeaderSep = extractTaskTableHeaderSep(tasksLines, range3);
  if (qualifying.length > 0 && !taskHeaderSep) {
    throw new Error(`${args.tasksPath} §3 找不到表头，结构异常，拒绝继续`);
  }

  const claims = extractActiveClaims(tasksLines, range2);
  const claimReleased = (id) => {
    if (qualifyingIds.has(id) || releaseIds.has(id)) return true;
    const row = rowById.get(id);
    return Boolean(row)
      && (row.integration === 'merged-local' || row.integration === 'merged-remote')
      && row.overall !== '[~]' && row.overall !== '[r]';
  };
  const movingClaims = claims.rows.filter((r) => r.id && claimReleased(r.id));

  const logBlocks = range4 ? extractLogBlocks(tasksLines, range4) : [];
  const movingLogBlocks = args.before ? logBlocks.filter((b) => b.date && b.date < args.before) : [];

  // ---- 从 TASKS.md 里删除被搬走的整行/整块 ----
  const removeLineIdx = new Set();
  for (const row of qualifying) removeLineIdx.add(row.lineNo - 1);
  for (const row of movingClaims) removeLineIdx.add(row.lineIdx);
  for (const block of movingLogBlocks) {
    for (let i = block.startIdx; i < block.endIdx; i += 1) removeLineIdx.add(i);
  }
  const newTasksLines = tasksLines.filter((_, idx) => !removeLineIdx.has(idx));

  // ---- 合并进归档的结构化表示 ----
  const existing = parseExistingArchive(archiveLines);

  for (const row of movingClaims) {
    // 同一任务可能有多条认领（例如子任务交接），按整行去重。
    if (!existing.claims.rows.some((r) => r.raw === row.raw)) {
      existing.claims.rows.push({ id: row.id, raw: row.raw });
    }
  }
  existing.claims.rows.sort((a, b) => compareIds(a.id, b.id));
  if (!existing.claims.header && claims.headerLine && movingClaims.length > 0) {
    existing.claims.header = claims.headerLine;
    existing.claims.sep = claims.sepLine;
  }

  for (const row of qualifying) {
    const heading = headingTextByLine[row.lineNo - 1] || '### M?（未归类）';
    let group = existing.taskGroups.find((g) => g.heading === heading);
    if (!group) {
      const own = headerSepForLine(tasksLines, row.lineNo - 1, range3);
      group = { heading, header: own?.header, sep: own?.sep, rows: [] };
      existing.taskGroups.push(group);
    }
    if (!group.rows.some((r) => r.id === row.id)) {
      group.rows.push({ id: row.id, raw: tasksLines[row.lineNo - 1] });
    }
  }
  for (const group of existing.taskGroups) group.rows.sort((a, b) => compareIds(a.id, b.id));
  existing.taskGroups.sort((a, b) => milestoneNumber(a.heading) - milestoneNumber(b.heading));

  const newLogEntries = movingLogBlocks.map((b) => ({ date: b.date, lines: logBlockForArchive(tasksLines, b) }));
  const combinedLogs = [...newLogEntries, ...existing.logBlocks];
  combinedLogs.sort((a, b) => {
    if (a.date === b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date < b.date ? 1 : -1;
  });
  existing.logBlocks = combinedLogs;

  const newArchiveLines = serializeArchive(existing);

  return {
    eol,
    tasksLines,
    newTasksLines,
    archiveLines,
    newArchiveLines,
    moved: { tasks: qualifying.length, claims: movingClaims.length, logs: movingLogBlocks.length },
  };
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('用法：node scripts/archive-tasks.mjs [--before YYYY-MM-DD] [--dry-run] [--pending-ids <file>] '
      + '[--release-claims <file>] [--tasks <path>] [--archive <path>]');
    return 0;
  }

  const result = run(args);
  const { eol } = result;

  const beforeTasks = countStats(result.tasksLines, eol);
  const afterTasks = countStats(result.newTasksLines, eol);
  const beforeArchive = countStats(result.archiveLines, eol);
  const afterArchive = countStats(result.newArchiveLines, eol);

  console.log(args.dryRun ? '[dry-run，未写入任何文件]' : '[已写入]');
  console.log(`${args.tasksPath}`);
  console.log(`  之前：${formatStats(beforeTasks)}`);
  console.log(`  之后：${formatStats(afterTasks)}`);
  console.log(`${args.archivePath}`);
  console.log(`  之前：${formatStats(beforeArchive)}`);
  console.log(`  之后：${formatStats(afterArchive)}`);
  console.log(
    `本次移动：§3 任务行 ${result.moved.tasks} 条、§2 认领 ${result.moved.claims} 条、`
    + `§4 集成日志 ${result.moved.logs} 条${args.before ? `（--before ${args.before}）` : '（未给 --before，不搬 §4）'}`,
  );

  if (!args.dryRun) {
    fs.writeFileSync(args.tasksPath, result.newTasksLines.join(eol));
    fs.writeFileSync(args.archivePath, result.newArchiveLines.join(eol));
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url && import.meta.url.endsWith('archive-tasks.mjs')) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`archive-tasks 失败：${error.message}`);
    process.exit(1);
  }
}
