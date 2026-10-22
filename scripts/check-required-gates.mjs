// 由改动路径推导本次必跑门禁，并可核对交付证据里的 gates.json 是否真的跑过。
//
// T10.118c 的教训：安卓源码级护栏住在 tests/frontend-contracts.test.mjs 里，
// 但当批开发只跑了 docs-check / commit-check / diff-check，主干因此带着真实的
// 无障碍回归走完了交付、集成和验收。同一轮 T10.118a 犯过同样的错并被项目经理
// 抓住，处理得很好，但那是一次口头派单，没有沉淀成规则，于是下一批原样复发。
// 这个脚本把「改了什么就必须跑什么」变成可核对的结构化条件。
//
// 用法：
//   node scripts/check-required-gates.mjs                      推导工作区未提交改动
//   node scripts/check-required-gates.mjs --range <base>..HEAD  推导某个提交范围
//   node scripts/check-required-gates.mjs --range <r> --gates <gates.json> [...]
//                                                              核对证据是否覆盖且全绿
//   node scripts/check-required-gates.mjs --rules               打印规则表

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 每条规则：命中任一 match 前缀/后缀的路径，就必须跑 gates 里的全部门禁。
// gate 名同时接受 npm 脚本名和 gates.json 里惯用的短名（见 ALIASES）。
const RULES = [
  {
    id: 'android-source',
    label: '安卓源码',
    match: (p) => p.startsWith('apps/android/') && (p.endsWith('.kt') || p.endsWith('.kts')),
    gates: ['test:frontend', 'android-compile', 'android-screenshot'],
    why: 'tests/frontend-contracts.test.mjs 直接扫描安卓 Kotlin 源码，守长标识行数上限、语义节点与死交互；'
      + 'android-compile 是"这份 Kotlin 编得过、JVM 单测跑得过"的最低证明；'
      + 'android-screenshot 是"这些屏真的画出来了"的证明——它渲染 226 张预览并断言触达区与视口，'
      + '契约与编译都拦不住版面问题：T10.131 的币种切换分段只有 46dp 宽（触达下限 48dp），'
      + '就是它抓出来的，而三轮源码扫描全绿',
  },
  {
    id: 'android-widget',
    label: '安卓小组件',
    match: (p) => p.startsWith('apps/android/') && /widget/i.test(p),
    gates: ['check:android:widget-previews'],
    why: '小组件预览资源与 info.xml、PNG 尺寸必须成套',
  },
  {
    id: 'frontend',
    label: '桌面前端',
    match: (p) => p.startsWith('src/') && /\.(ts|tsx|js|jsx|css)$/.test(p),
    gates: ['typecheck', 'lint', 'test:unit', 'test:frontend', 'build:web'],
    why: '类型、Hook 规则、单元测试、契约边界与生产构建同属前端改动范围',
  },
  {
    id: 'rust',
    label: 'Rust 侧',
    match: (p) => p.startsWith('src-tauri/') && p.endsWith('.rs'),
    gates: ['lint:rust:clippy', 'lint:rust:fmt', 'test:rust'],
    why: 'Rust 改动必须过 clippy、fmt 与单元测试',
  },
  {
    id: 'supabase',
    label: '云端迁移与 SQL',
    match: (p) => p.startsWith('supabase/'),
    gates: ['supabase-regression'],
    why: '迁移或 RPC 改动必须回放 SQL 回归；无本地容器时按 run-checks 的既有约定手工执行并记录',
  },
  {
    id: 'contracts',
    label: '跨端契约',
    match: (p) => p.startsWith('docs/contracts/'),
    gates: ['typecheck', 'test:frontend', 'test:unit'],
    why: '契约变更必须同步验证 TypeScript / Kotlin 消费者的解析边界',
  },
  {
    id: 'gate-scripts',
    label: '门禁脚本与测试',
    match: (p) => p.startsWith('scripts/') || p.startsWith('tests/'),
    gates: ['test:frontend'],
    why: '改门禁本身要先证明门禁还能跑',
  },
  {
    id: 'docs',
    label: '文档与台账',
    match: (p) => p.startsWith('docs/') || p === 'AGENTS.md' || p === 'CLAUDE.md',
    gates: ['check:docs'],
    why: 'PROJECT §4 与 CLAUDE.md 明写：改任何文档先跑 check:docs',
  },
  {
    id: 'versioned',
    label: '版本与依赖',
    match: (p) => ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
      'src-tauri/tauri.conf.json', 'apps/android/app/build.gradle.kts'].includes(p),
    gates: ['version:check'],
    why: '四端版本一致性是单写事实，改依赖或版本文件必须复核',
  },
  {
    id: 'tracked-paths',
    label: '任意受跟踪路径',
    match: () => true,
    gates: ['check:paths', 'diff-check'],
    why: 'Windows runner 会在超长路径上于 checkout 阶段就失败；空白错误同样零成本',
  },
];

// gates.json 与 npm 脚本之间的既有叫法差异。左侧是证据里出现过的短名。
const ALIASES = new Map([
  ['docs-check', 'check:docs'],
  ['diff-check', 'diff-check'],
  ['range-diff-check', 'diff-check'],
  ['commit-check', 'commit-check'],
  ['frontend-contracts', 'test:frontend'],
  ['final-jvm', 'android-compile'],
  ['android-jvm', 'android-compile'],
  ['focus-compile', 'android-compile'],
  // Gradle 的 testDebugUnitTest + assembleDebug 严格强于离线检查，记哪个都算数。
  ['android:verify', 'android-compile'],
  ['android:test', 'android-compile'],
  ['android:check:offline', 'android-compile'],
  ['validateDebugScreenshotTest', 'android-screenshot'],
  ['android:screenshot', 'android-screenshot'],
  ['screenshot-test', 'android-screenshot'],
]);

export const canonical = (name) => ALIASES.get(name) ?? name;

export { RULES };

function parseArgs(argv) {
  const options = { range: null, gates: [], rules: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--rules') options.rules = true;
    else if (arg === '--range') options.range = argv[++index] ?? null;
    else if (arg === '--gates') options.gates.push(argv[++index]);
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function changedPaths(range) {
  const args = range
    ? ['diff', '--name-only', range]
    : ['status', '--porcelain=v1', '--untracked-files=all'];
  const output = execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  if (range) return output.split('\n').map((line) => line.trim()).filter(Boolean);
  return output
    .split('\n')
    .filter(Boolean)
    // porcelain v1 行首两位是状态码；重命名用 " -> " 分隔，取目标路径。
    .map((line) => line.slice(3).trim())
    .map((entry) => (entry.includes(' -> ') ? entry.split(' -> ')[1] : entry))
    .map((entry) => entry.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

export function requiredGates(paths) {
  const required = new Map();
  for (const rule of RULES) {
    const hits = paths.filter((entry) => rule.match(entry));
    if (hits.length === 0) continue;
    for (const gate of rule.gates) {
      const existing = required.get(gate) ?? { reasons: [], samples: new Set(), matched: new Set() };
      existing.reasons.push(`${rule.label}：${rule.why}`);
      hits.forEach((hit) => existing.matched.add(hit));
      // 只留少量样例便于阅读；总数单独记，输出时必须说清这是样例而不是全部命中。
      hits.slice(0, 3).forEach((hit) => existing.samples.add(hit));
      required.set(gate, existing);
    }
  }
  return required;
}

export function readEvidence(files) {
  const seen = new Map();
  for (const file of files) {
    const absolute = path.isAbsolute(file) ? file : path.join(root, file);
    if (!fs.existsSync(absolute)) throw new Error(`证据文件不存在：${file}`);
    const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.gates) ? parsed.gates : [];
    if (entries.length === 0) throw new Error(`证据文件没有可读的门禁数组：${file}`);
    for (const entry of entries) {
      const name = canonical(entry.name ?? entry.gate ?? '');
      if (!name) continue;
      // 同名多次出现时，任何一次非零都保留为失败，不允许用后一次成功掩盖。
      const previous = seen.get(name);
      const exitCode = Number(entry.exitCode ?? entry.status ?? 0);
      if (previous === undefined || previous.exitCode === 0) seen.set(name, { exitCode, file });
    }
  }
  return seen;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.rules) {
    console.log('改动路径 → 必跑门禁：\n');
    for (const rule of RULES) {
      console.log(`  ${rule.label}（${rule.id}）`);
      console.log(`    门禁：${rule.gates.join('、')}`);
      console.log(`    理由：${rule.why}\n`);
    }
    return;
  }

  const paths = changedPaths(options.range);
  if (paths.length === 0) {
    console.log('没有改动路径，无需门禁。');
    return;
  }

  const required = requiredGates(paths);
  const scope = options.range ? `范围 ${options.range}` : '工作区未提交改动';
  console.log(`${scope}：${paths.length} 个路径，推导出 ${required.size} 项必跑门禁\n`);

  for (const [gate, info] of required) {
    console.log(`  ${gate}`);
    const samples = [...info.samples];
    const total = info.matched.size;
    const suffix = total > samples.length ? `（共 ${total} 个，下列为样例）` : '';
    console.log(`    命中${suffix}：${samples.join('、')}`);
    console.log(`    理由：${[...new Set(info.reasons)].join('；')}`);
  }

  if (options.gates.length === 0) {
    console.log('\n未提供 --gates，仅推导不核对。交付时请附 gates.json 再跑一次核对。');
    return;
  }

  const evidence = readEvidence(options.gates);
  const missing = [];
  const failed = [];
  for (const gate of required.keys()) {
    const record = evidence.get(gate);
    if (record === undefined) missing.push(gate);
    else if (record.exitCode !== 0) failed.push(`${gate}（exitCode=${record.exitCode}，见 ${record.file}）`);
  }

  console.log('');
  if (missing.length === 0 && failed.length === 0) {
    console.log(`门禁覆盖核对通过：${required.size} 项必跑门禁均有证据且退出码为 0。`);
    return;
  }
  if (missing.length > 0) {
    console.error(`证据缺少 ${missing.length} 项必跑门禁：${missing.join('、')}`);
    console.error('缺门禁不等于门禁通过；补跑后再声明交付。');
  }
  if (failed.length > 0) {
    console.error(`证据中 ${failed.length} 项必跑门禁未通过：${failed.join('、')}`);
  }
  process.exitCode = 1;
}

// 以模块方式 import（单元测试）时不执行 CLI，避免测试触发 git 调用。
const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    main();
  } catch (error) {
    console.error(`门禁推导失败：${error.message}`);
    process.exitCode = 1;
  }
}
