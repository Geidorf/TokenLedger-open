// 在已开机的模拟器（或真机）上量 Android 性能：冷启动首帧、明细列表滚动掉帧、路由动画帧率。
// 由 .github/workflows/android-perf-probe.yml 调用；本机有 adb 与 QA 包时也能直接跑：
//
//   node scripts/android-perf-probe.mjs --package com.jeidorf.tokenledger.mobile.qa --out build/perf
//
// 只读设备，不写仓库。模拟器用软件渲染，数字只适合同一台 runner 上前后对比，不代表真机绝对值。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_ACTIVITY = 'com.jeidorf.tokenledger.mobile.MainActivity';
const PROBE_ACTIVITY = 'com.jeidorf.tokenledger.mobile.PerfProbeActivity';

/** `am start -W` 输出里的 TotalTime（毫秒）；没有就返回 null。 */
export function parseTotalTime(output) {
  const match = /^TotalTime:\s*(\d+)/mu.exec(output);
  return match ? Number(match[1]) : null;
}

/** `dumpsys gfxinfo <包名>` 的汇总段：总帧数、掉帧数与帧耗时分位。 */
export function parseGfxinfo(output) {
  const number = (pattern) => {
    const match = pattern.exec(output);
    return match ? Number(match[1]) : null;
  };
  return {
    totalFrames: number(/Total frames rendered:\s*(\d+)/u),
    jankyFrames: number(/Janky frames:\s*(\d+)/u),
    jankyPercent: number(/Janky frames:\s*\d+\s*\(([\d.]+)%\)/u),
    p50Ms: number(/50th percentile:\s*(\d+)ms/u),
    p90Ms: number(/90th percentile:\s*(\d+)ms/u),
    p95Ms: number(/95th percentile:\s*(\d+)ms/u),
    p99Ms: number(/99th percentile:\s*(\d+)ms/u),
  };
}

export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** `--runs` 只收 1–50 的整数；不合法返回 null，免得一次都不跑却写出空中位数。 */
export function parseRuns(raw) {
  if (!/^\d+$/u.test(String(raw).trim())) return null;
  const runs = Number(raw);
  return runs >= 1 && runs <= 50 ? runs : null;
}

/** `wm size` 的物理分辨率（有 Override 时取 Override）。 */
export function parseScreenSize(output) {
  const override = /Override size:\s*(\d+)x(\d+)/u.exec(output);
  const physical = /Physical size:\s*(\d+)x(\d+)/u.exec(output);
  const match = override ?? physical;
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

const show = (value, unit = '') => (value === null || value === undefined ? '—' : `${value}${unit}`);

export function formatSummary(result) {
  const lines = [
    '## Android 性能探针',
    '',
    `设备：${result.device}；每项冷启动取 ${result.runs} 次中位数。模拟器为软件渲染，只用于同一 runner 上前后对比。`,
    '',
    '| 项目 | 结果 |',
    '|---|---|',
    `| 冷启动到登录屏首帧（MainActivity，中位数） | ${show(result.coldStartMain.medianMs, ' ms')} |`,
    `| 冷启动到「请求」页首帧（预览夹具，中位数） | ${show(result.coldStartRequests.medianMs, ' ms')} |`,
    `| 「请求」页滚动：总帧 / 掉帧 | ${show(result.scroll.totalFrames)} / ${show(result.scroll.jankyFrames)}（${show(result.scroll.jankyPercent, '%')}） |`,
    `| 「请求」页滚动：帧耗时 P50 / P90 / P99 | ${show(result.scroll.p50Ms, ' ms')} / ${show(result.scroll.p90Ms, ' ms')} / ${show(result.scroll.p99Ms, ' ms')} |`,
    `| 路由页静置 ${result.routing.seconds} 秒（有在途请求）：每秒重画帧数 | ${show(result.routing.framesPerSecond)} |`,
    '',
  ];
  return lines.join('\n');
}

function adb(args, { allowFailure = false } = {}) {
  const run = spawnSync('adb', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (run.status !== 0 && !allowFailure) {
    throw new Error(`adb ${args.join(' ')} 失败：${run.stderr || run.stdout}`);
  }
  return run.stdout ?? '';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function coldStart(pkg, activity, extras, runs) {
  const times = [];
  for (let index = 0; index < runs; index += 1) {
    adb(['shell', 'am', 'force-stop', pkg]);
    await sleep(800);
    const output = adb(['shell', 'am', 'start', '-W', '-S', '-n', `${pkg}/${activity}`, ...extras]);
    const total = parseTotalTime(output);
    if (total !== null) times.push(total);
    await sleep(1500);
  }
  return { samplesMs: times, medianMs: median(times) };
}

async function measureScroll(pkg, size, swipes) {
  adb(['shell', 'am', 'force-stop', pkg]);
  adb(['shell', 'am', 'start', '-W', '-n', `${pkg}/${PROBE_ACTIVITY}`, '--es', 'screen', 'requests']);
  await sleep(3000);
  adb(['shell', 'dumpsys', 'gfxinfo', pkg, 'reset']);
  const x = Math.round(size.width / 2);
  const low = Math.round(size.height * 0.75);
  const high = Math.round(size.height * 0.3);
  for (let index = 0; index < swipes; index += 1) {
    const [from, to] = index < swipes / 2 ? [low, high] : [high, low];
    adb(['shell', 'input', 'swipe', String(x), String(from), String(x), String(to), '250']);
    await sleep(400);
  }
  await sleep(1000);
  return parseGfxinfo(adb(['shell', 'dumpsys', 'gfxinfo', pkg]));
}

async function measureRouting(pkg, seconds) {
  adb(['shell', 'am', 'force-stop', pkg]);
  adb(['shell', 'am', 'start', '-W', '-n', `${pkg}/${PROBE_ACTIVITY}`, '--es', 'screen', 'routing']);
  await sleep(3000);
  adb(['shell', 'dumpsys', 'gfxinfo', pkg, 'reset']);
  await sleep(seconds * 1000);
  const stats = parseGfxinfo(adb(['shell', 'dumpsys', 'gfxinfo', pkg]));
  const framesPerSecond = stats.totalFrames === null ? null : Math.round((stats.totalFrames / seconds) * 10) / 10;
  return { seconds, framesPerSecond, ...stats };
}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const pkg = option('package', 'com.jeidorf.tokenledger.mobile.qa');
  const outDir = option('out', 'build/android-perf');
  const runs = parseRuns(option('runs', '10'));
  if (runs === null) {
    console.error(`--runs 需要 1 到 50 的整数，收到：${option('runs', '10')}`);
    process.exit(2);
  }
  const size = parseScreenSize(adb(['shell', 'wm', 'size'])) ?? { width: 1080, height: 2400 };
  const device = [
    adb(['shell', 'getprop', 'ro.product.model']).trim(),
    `API ${adb(['shell', 'getprop', 'ro.build.version.sdk']).trim()}`,
    `${size.width}x${size.height}`,
  ].join(' · ');

  const result = {
    device,
    runs,
    coldStartMain: await coldStart(pkg, MAIN_ACTIVITY, [], runs),
    coldStartRequests: await coldStart(pkg, PROBE_ACTIVITY, ['--es', 'screen', 'requests'], runs),
    scroll: await measureScroll(pkg, size, 20),
    routing: await measureRouting(pkg, 10),
  };
  adb(['shell', 'am', 'force-stop', pkg], { allowFailure: true });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'android-perf.json'), `${JSON.stringify(result, null, 2)}\n`);
  const summary = formatSummary(result);
  fs.writeFileSync(path.join(outDir, 'android-perf.md'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
