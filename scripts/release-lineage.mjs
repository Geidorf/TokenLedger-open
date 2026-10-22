import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 发布血统：当前 tag 之前最近的一个正式发布（vMAJOR.MINOR.PATCH）。
//
// 上一版 release-rc.yml 把「私有签名 1.2.65 → 公开 RC 1.2.66」写死在 7 处脚本与
// 工作流里，版本号推进到 1.2.75 后整条正式发布链从未跑通。这里改为从 git tag
// 推导：取所有 `v*` 正式 tag 中严格小于当前版本的最大者；没有就返回 null，
// 表示"首个公开发布"，此时升级证据不适用，manifest 必须显式声明 previousRelease
// 为 null 而不是默默省略。仓库变量 TOKENLEDGER_PREVIOUS_RELEASE_TAG 可覆盖
// （`none` 表示强制视为首个发布）。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/u;

export function parseReleaseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(text ?? '').trim());
  if (!match) return null;
  return match.slice(1, 4).map((part) => Number.parseInt(part, 10));
}

export function compareReleaseVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function resolvePreviousRelease({ currentVersion, tags = [], override } = {}) {
  const current = parseReleaseVersion(currentVersion);
  if (!current) {
    throw new Error(`current release version must be MAJOR.MINOR.PATCH, got ${currentVersion ?? '<missing>'}`);
  }
  const forced = typeof override === 'string' ? override.trim() : '';
  if (forced) {
    if (forced === 'none') return null;
    if (!RELEASE_TAG.test(forced)) {
      throw new Error(`TOKENLEDGER_PREVIOUS_RELEASE_TAG must look like vMAJOR.MINOR.PATCH or none, got ${forced}`);
    }
    const version = parseReleaseVersion(forced);
    if (compareReleaseVersions(version, current) >= 0) {
      throw new Error(`previous release ${forced} is not older than v${current.join('.')}`);
    }
    return { tag: forced, version: version.join('.') };
  }
  const candidates = tags
    .map((tag) => String(tag).trim())
    .filter((tag) => RELEASE_TAG.test(tag))
    .map((tag) => ({ tag, version: parseReleaseVersion(tag) }))
    .filter((candidate) => compareReleaseVersions(candidate.version, current) < 0)
    .sort((left, right) => compareReleaseVersions(right.version, left.version));
  if (candidates.length === 0) return null;
  return { tag: candidates[0].tag, version: candidates[0].version.join('.') };
}

export function listReleaseTags(cwd = root) {
  return execFileSync('git', ['tag', '--list', 'v*'], { cwd, encoding: 'utf8' })
    .split(/\r?\n/u)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseArgs(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument ${flag ?? '<missing>'}`);
    }
    options.set(flag.slice(2), value);
  }
  return options;
}

function main(args) {
  const options = parseArgs(args);
  const currentVersion = options.get('current')
    ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const previous = resolvePreviousRelease({
    currentVersion,
    tags: listReleaseTags(),
    override: process.env.TOKENLEDGER_PREVIOUS_RELEASE_TAG,
  });
  const result = {
    currentVersion,
    previousTag: previous?.tag ?? null,
    previousVersion: previous?.version ?? null,
  };
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `previous_tag=${result.previousTag ?? ''}\nprevious_version=${result.previousVersion ?? ''}\n`,
    );
  }
  console.log(JSON.stringify(result));
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`release lineage error: ${error.message}`);
    process.exit(1);
  }
}
