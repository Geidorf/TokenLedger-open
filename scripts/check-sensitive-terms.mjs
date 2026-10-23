import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 公开仓库红线：提交消息、PR 标题与正文、代码、注释、文档里不得出现竞品信息。
// 名单只以 SHA-256 摘要入库，脚本与 CI 日志都不会写出明文；命中时只报位置。
// 增删词条：把小写词条的 sha256 十六进制摘要加进来，长度写在 length 里。
export const TERM_DIGESTS = [
  { length: 6, sha256: '8a88fbb234ec0452991a71276cb1be9e6aca02cafbe4718831d165373b968a9b' },
  { length: 6, sha256: 'ea48b1b43f89e01d9236c8243f91285eeeaa249eba5902e64ed7ff1048e70e85' },
  { length: 8, sha256: 'f39ebf80473271f8697742c53d5549d9d240f54982521a0b1f4616cb894cea17' },
];

const DIGEST_SET = new Set(TERM_DIGESTS.map((term) => term.sha256));
const LENGTHS = [...new Set(TERM_DIGESTS.map((term) => term.length))];

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 是否含名单词条。按 [a-z0-9] 连续段切分后逐个子串比对摘要，所以驼峰、
 * 下划线、连字符拼接以及紧贴中文的写法都能命中。
 */
export function containsSensitiveTerm(text, digests = DIGEST_SET, lengths = LENGTHS) {
  const runs = String(text || '').toLowerCase().match(/[a-z0-9]+/gu) || [];
  for (const run of runs) {
    for (const length of lengths) {
      for (let start = 0; start + length <= run.length; start += 1) {
        if (digests.has(sha256(run.slice(start, start + length)))) return true;
      }
    }
  }
  return false;
}

/** 报位置用：把路径里含名单词的字母数字段换成 `***`，免得文件名把词带进公开日志。 */
export function redact(text, digests = DIGEST_SET, lengths = LENGTHS) {
  return String(text).replace(/[A-Za-z0-9]+/gu, (run) =>
    containsSensitiveTerm(run, digests, lengths) ? '***' : run,
  );
}

/** 逐行检查，返回命中的行号（从 1 开始）。 */
export function findSensitiveLines(text) {
  return String(text || '')
    .split(/\r?\n/u)
    .flatMap((line, index) => (containsSensitiveTerm(line) ? [index + 1] : []));
}

function git(args) {
  const command = process.platform === 'win32' ? 'git.exe' : 'git';
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || `git ${args[0]} 失败`);
  }
  return result.stdout;
}

/** 提交消息全文（主题与正文）。 */
function checkCommitMessages(range) {
  return git(['log', '--format=%H%x1f%B%x1e', range])
    .split('\u001e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split('\u001f'))
    .filter(([, body]) => containsSensitiveTerm(body))
    .map(([sha]) => `提交消息 ${sha.slice(0, 12)}`);
}

/** `A..B` 改成 `A...B`：只看 B 相对两者合并基点的改动，分支落后于 main 时不会把 main 的新内容算进来。 */
export function diffRange(range) {
  return range.includes('...') ? range : range.replace('..', '...');
}

/** diff 文件头里的新路径；`/dev/null`（文件被删）返回 null。 */
export function patchPath(raw) {
  if (raw === '/dev/null') return null;
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted;
}

/** 范围内新增的行与新增或改名后的文件路径；删除或原样保留已有内容不算违规。 */
function checkAddedContent(range) {
  const violations = [];
  const diff = diffRange(range);
  for (const file of git(['diff', '--name-only', '-z', '--diff-filter=AR', diff]).split('\0')) {
    if (file && containsSensitiveTerm(file)) violations.push(`文件路径 ${redact(file)}`);
  }
  // 已有的提及不追究：改动一行原本就含名单词的内容（例如改错字）不算新增，
  // 只有某个文件里含名单词的新增行多于删去的含名单词的行时，才把多出来的报出来。
  const files = new Map();
  let entry = null;
  let line = 0;
  let inHunk = false;
  for (const text of git(['-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-color', '--no-ext-diff', diff]).split('\n')) {
    if (text.startsWith('diff --git ')) {
      inHunk = false;
      entry = null;
    } else if (!inHunk && text.startsWith('--- ')) {
      continue;
    } else if (!inHunk && text.startsWith('+++ ')) {
      // 含引号、制表符等的路径仍会被 git 加引号；只用于报位置，取不准也照样扫内容。
      const file = patchPath(text.slice(4));
      entry = file === null ? null : { file, added: [], removed: 0 };
      if (entry) files.set(file, entry);
    } else if (text.startsWith('@@')) {
      inHunk = true;
      const match = /\+(\d+)/u.exec(text);
      line = match ? Number(match[1]) : 0;
    } else if (inHunk && text.startsWith('+')) {
      if (entry && containsSensitiveTerm(text.slice(1))) entry.added.push(line);
      line += 1;
    } else if (inHunk && text.startsWith('-')) {
      if (entry && containsSensitiveTerm(text.slice(1))) entry.removed += 1;
    }
  }
  for (const { file, added, removed } of files.values()) {
    for (const at of added.slice(removed)) violations.push(`${redact(file)}:${at}`);
  }
  return violations;
}

/** 全部受版本控制的文件路径与内容（二进制文件跳过）。 */
function checkTree() {
  const violations = [];
  for (const file of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
    if (containsSensitiveTerm(file)) violations.push(`文件路径 ${redact(file)}`);
    let content;
    try {
      content = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (content.includes(0)) continue;
    for (const line of findSensitiveLines(content.toString('utf8'))) violations.push(`${redact(file)}:${line}`);
  }
  return violations;
}

function checkPullRequestEvent(eventPath) {
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const pr = event.pull_request || {};
  const violations = [];
  if (containsSensitiveTerm(pr.title)) violations.push('PR 标题');
  for (const line of findSensitiveLines(pr.body)) violations.push(`PR 正文第 ${line} 行`);
  return violations;
}

function usage() {
  return [
    '用法：',
    '  node scripts/check-sensitive-terms.mjs --file <提交消息文件>',
    '  node scripts/check-sensitive-terms.mjs --range <起点..终点>   # 提交消息与新增内容',
    '  node scripts/check-sensitive-terms.mjs --pr-event <事件 JSON> # PR 标题与正文',
    '  node scripts/check-sensitive-terms.mjs --tree                 # 全部受控文件',
  ].join('\n');
}

export function run(args) {
  const [mode, value] = args;
  if (mode === '--tree') return checkTree();
  if (!value) throw new Error(usage());
  if (mode === '--file') {
    const message = fs
      .readFileSync(path.resolve(value), 'utf8')
      .split(/\r?\n/u)
      .filter((line) => !line.startsWith('#'))
      .join('\n');
    return containsSensitiveTerm(message) ? ['提交消息'] : [];
  }
  if (mode === '--range') return [...checkCommitMessages(value), ...checkAddedContent(value)];
  if (mode === '--pr-event') return checkPullRequestEvent(value);
  throw new Error(usage());
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    const violations = run(process.argv.slice(2));
    if (violations.length > 0) {
      // 只列位置，不回显命中的词，CI 日志是公开的。
      console.error(`\n公开仓库红线：以下位置含有竞品信息，请改用中性说法：\n${violations.map((v) => `  ${v}`).join('\n')}\n`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`\n竞品信息检查失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
