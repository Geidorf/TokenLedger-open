import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, '..');
const buildScript = path.join('scripts', 'build-all-local.sh');

function findBash() {
  if (process.platform !== 'win32') {
    return process.env.BASH || '/bin/bash';
  }

  const candidates = [
    process.env.TOKENLEDGER_GIT_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
}

const bash = findBash();
if (!bash) {
  console.error(
    '未找到 Git Bash。请安装 Git for Windows，或用 TOKENLEDGER_GIT_BASH 指定 bash.exe。',
  );
  process.exit(1);
}

const result = spawnSync(bash, [buildScript], {
  cwd: projectRoot,
  env: process.env,
  shell: false,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(`无法启动本地构建：${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
