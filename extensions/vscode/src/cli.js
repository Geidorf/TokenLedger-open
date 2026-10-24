'use strict';

// 调用本机 tokenledger-cli 并解析它的 JSON。插件自己不读账本、不读密钥、不联网：
// 所有数字都是命令行（与桌面端同一个 Rust 核心）算好的。

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CLI_NAME = 'tokenledger-cli';
const SUPPORTED_SCHEMA = 1;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

class CliNotFoundError extends Error {
  constructor(tried) {
    super(`找不到 ${CLI_NAME}`);
    this.name = 'CliNotFoundError';
    this.tried = tried;
  }
}

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * 桌面安装包放命令行的位置（docs/cli.md「构建与安装」）。从 Dock 或开始菜单打开的
 * 编辑器不一定带着终端里的 PATH，所以 PATH 里找不到时再按安装位置找。
 */
function defaultCandidates(platform, env) {
  const exe = platform === 'win32' ? `${CLI_NAME}.exe` : CLI_NAME;
  const list = [exe];
  if (platform === 'darwin') {
    for (const root of ['/Applications', env.HOME && path.posix.join(env.HOME, 'Applications')]) {
      if (!root) continue;
      for (const app of ['TokenLedger.app', 'tokenledger.app']) {
        list.push(path.posix.join(root, app, 'Contents', 'MacOS', CLI_NAME));
      }
    }
    list.push('/usr/local/bin/tokenledger-cli', '/opt/homebrew/bin/tokenledger-cli');
  } else if (platform === 'win32') {
    for (const root of [env.LOCALAPPDATA, env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles]) {
      if (!root) continue;
      for (const dir of ['tokenledger', 'TokenLedger']) {
        list.push(path.win32.join(root, dir, exe));
      }
    }
  } else {
    list.push('/usr/bin/tokenledger-cli', '/usr/local/bin/tokenledger-cli');
    if (env.HOME) list.push(path.posix.join(env.HOME, '.local', 'bin', CLI_NAME));
  }
  return [...new Set(list)];
}

/** 设置里写了路径就只用它；否则按 PATH 与安装位置依次找。 */
function cliCandidates(configuredPath, platform = process.platform, env = process.env) {
  const configured = typeof configuredPath === 'string' ? configuredPath.trim() : '';
  if (configured) return [configured];
  return defaultCandidates(platform, env);
}

function isBareName(candidate) {
  return !candidate.includes('/') && !candidate.includes('\\');
}

/**
 * 执行一次命令，解析标准输出里的 JSON。退出码 1 时命令行在标准输出另给
 * `{"schemaVersion":1,"error":"…"}`，取出其中的说明。
 */
function runJson(file, args, { env, timeoutMs = DEFAULT_TIMEOUT_MS, execFile = childProcess.execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
          reject(Object.assign(new Error(error.message), { code: error.code }));
          return;
        }
        let value = null;
        try {
          value = stdout ? JSON.parse(stdout) : null;
        } catch {
          value = null;
        }
        if (error) {
          if (error.killed || error.signal) {
            reject(new CliError(`${CLI_NAME} ${args[0]} 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`));
            return;
          }
          const message = (value && typeof value.error === 'string' && value.error)
            || String(stderr || '').trim().split('\n')[0]
            || error.message;
          reject(new CliError(message));
          return;
        }
        if (!value || typeof value !== 'object') {
          reject(new CliError(`${CLI_NAME} ${args[0]} 的输出不是 JSON`));
          return;
        }
        if (value.schemaVersion !== SUPPORTED_SCHEMA) {
          reject(new CliError(`${CLI_NAME} 输出 schemaVersion ${value.schemaVersion}，插件只认 ${SUPPORTED_SCHEMA}，请更新插件`));
          return;
        }
        resolve(value);
      },
    );
  });
}

/**
 * 找到能跑的命令行：PATH 里的名字直接试 `version`，绝对路径先看文件在不在。
 * 返回可执行文件路径；都不行抛 CliNotFoundError。
 */
async function locateCli(candidates, { env, execFile = childProcess.execFile, exists = fs.existsSync } = {}) {
  for (const candidate of candidates) {
    if (!isBareName(candidate) && !exists(candidate)) continue;
    const ok = await new Promise((resolve) => {
      execFile(candidate, ['version'], { env, timeout: 5_000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        resolve(!error && String(stdout).startsWith(CLI_NAME));
      });
    });
    if (ok) return candidate;
  }
  throw new CliNotFoundError(candidates);
}

/** 一次刷新要跑的命令。`quota` 为假时连状态摘要也不查额度（`--no-quota`）。 */
function snapshotCommands({ quota, includeQuotaList }) {
  const commands = {
    status: ['status', ...(quota ? [] : ['--no-quota']), '--json'],
    usage: ['usage', 'today', '--by', 'agent', '--json'],
    budget: ['budget', '--json'],
    gateway: ['gateway', '--limit', '20', '--json'],
  };
  if (quota && includeQuotaList) commands.quota = ['quota', '--json'];
  return commands;
}

/**
 * 并行跑一轮命令。每一项单独成败：`{ value }` 或 `{ error }`，一项失败不拖累其他项。
 */
async function fetchSnapshot(run, options) {
  const commands = snapshotCommands(options);
  const keys = Object.keys(commands);
  const results = await Promise.allSettled(keys.map((key) => run(commands[key])));
  const snapshot = {};
  keys.forEach((key, index) => {
    const result = results[index];
    snapshot[key] = result.status === 'fulfilled'
      ? { value: result.value }
      : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
  });
  return snapshot;
}

module.exports = {
  CLI_NAME,
  CliError,
  CliNotFoundError,
  cliCandidates,
  defaultCandidates,
  fetchSnapshot,
  locateCli,
  runJson,
  snapshotCommands,
};
