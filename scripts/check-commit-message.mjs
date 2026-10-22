import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HAN_CHARACTER = /\p{Script=Han}/u;

export function validateCommitSubject(subject) {
  const normalized = String(subject || '').trim();
  if (!normalized) return { valid: false, error: '提交主题不能为空。' };
  if (!HAN_CHARACTER.test(normalized)) {
    return {
      valid: false,
      error: `提交主题必须包含中文：${normalized}`,
    };
  }
  return { valid: true, error: '' };
}

function subjectFromMessage(raw) {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#')) || '';
}

function checkMessageFile(file) {
  const subject = subjectFromMessage(fs.readFileSync(file, 'utf8'));
  const result = validateCommitSubject(subject);
  if (!result.valid) throw new Error(result.error);
}

function checkRange(range) {
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  const result = spawnSync(git, ['log', '--format=%H%x1f%s', range], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || `无法读取提交范围：${range}`);
  }

  const violations = result.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.split('\u001f'))
    .filter(([, subject]) => !validateCommitSubject(subject).valid);
  if (violations.length > 0) {
    const details = violations.map(([sha, subject]) => `  ${sha.slice(0, 12)} ${subject}`).join('\n');
    throw new Error(`以下提交主题不含中文：\n${details}`);
  }
}

function usage() {
  return [
    '用法：',
    '  node scripts/check-commit-message.mjs --file <提交消息文件>',
    '  node scripts/check-commit-message.mjs --range <起点..终点>',
  ].join('\n');
}

function main(args) {
  const [mode, value] = args;
  if (!value || !['--file', '--range'].includes(mode)) throw new Error(usage());
  if (mode === '--file') checkMessageFile(path.resolve(value));
  else checkRange(value);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url && import.meta.url.endsWith('check-commit-message.mjs')) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`\n提交日志检查失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
