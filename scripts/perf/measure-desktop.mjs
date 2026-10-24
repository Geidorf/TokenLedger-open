#!/usr/bin/env node
/**
 * 桌面前端性能测量：启动、大数据量请求列表、实时路由动画。
 *
 * 用生产模式的 React 构建，只把开发 mock 打开（`import.meta.env.DEV` 定义为 true），
 * 这样测到的是发布包的渲染开销，后端回包来自 src/devMockTauri.ts。
 * 产物写到系统临时目录，不碰 dist/。
 *
 *   node scripts/perf/measure-desktop.mjs                 # 全部场景，输出 JSON
 *   node scripts/perf/measure-desktop.mjs --runs 7 --cpu 4 --rows 2000
 *   node scripts/perf/measure-desktop.mjs --only requests,routing
 *   node scripts/perf/measure-desktop.mjs --chromium /path/to/chrome   # 指定浏览器
 *   node scripts/perf/measure-desktop.mjs --root ../main-checkout      # 测另一个检出作对照
 *
 * 数字是同一台机器上前后对比用的，不同机器之间不可比。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from '@playwright/test';


function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const RUNS = Number(arg('runs', 5));
const CPU = Number(arg('cpu', 4));
const ROWS = Number(arg('rows', 2000));
const ONLY = new Set(String(arg('only', 'startup,requests,loadmore,routing')).split(','));
const VIEWPORT = { width: 1280, height: 860 };
// --root 指向另一个检出（例如 main 的 worktree），同一脚本测出对照组。
const root = path.resolve(arg('root', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')));
const LOAD_MORE_TO = Number(arg('load-more-to', 1000));

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

async function withPage(browser, fn, { initScripts = [] } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light' });
  const page = await context.newPage();
  for (const [script, payload] of initScripts) await page.addInitScript(script, payload);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  try {
    return await fn(page, cdp);
  } finally {
    await context.close();
  }
}

async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.map(({ name, value }) => [name, value]));
}

/** 冷启动：导航到首屏图表画完，记首个内容绘制、主区域可见与主线程脚本时间。 */
async function measureStartup(browser, baseUrl) {
  const samples = [];
  for (let run = 0; run < RUNS; run += 1) {
    samples.push(await withPage(browser, async (page, cdp) => {
      const started = Date.now();
      await page.goto(`${baseUrl}/#overview`);
      await page.locator('main').first().waitFor();
      const mainVisible = Date.now() - started;
      await page.locator('main canvas').first().waitFor({ timeout: 30_000 });
      await page.waitForLoadState('networkidle');
      const chartsReady = Date.now() - started;
      const paint = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('paint').map((entry) => [entry.name, entry.startTime])));
      const m = await metrics(cdp);
      return {
        fcp: paint['first-contentful-paint'] ?? NaN,
        mainVisible,
        chartsReady,
        scriptMs: m.ScriptDuration * 1000,
        taskMs: m.TaskDuration * 1000,
        layoutMs: m.LayoutDuration * 1000,
        nodes: m.Nodes,
      };
    }));
  }
  const pick = (key) => round(median(samples.map((sample) => sample[key])));
  return { runs: RUNS, fcpMs: pick('fcp'), mainVisibleMs: pick('mainVisible'), chartsReadyMs: pick('chartsReady'), scriptMs: pick('scriptMs'), taskMs: pick('taskMs'), layoutMs: pick('layoutMs'), domNodes: pick('nodes') };
}

/**
 * 请求列表：把 mock 的一页放大成 `ROWS` 行（相当于点了很多次「加载更多」），
 * 测首次渲染、搜索框每次按键、展开一行、滚动的主线程耗时。
 */
async function measureRequests(browser, baseUrl) {
  // 先拿一份真实回包，保留 meta.query 回显，只把 items 放大。
  const seed = await withPage(browser, async (page) => {
    await page.goto(`${baseUrl}/#requests`);
    await page.locator('.log-table tbody tr').first().waitFor();
    return page.evaluate(async () => {
      const calls = window.__TOKENLEDGER_E2E__?.calls ?? [];
      const last = calls.filter((call) => call.cmd === 'get_usage_details').at(-1);
      return window.__TAURI_INTERNALS__.invoke('get_usage_details', last.args);
    });
  }, { initScripts: [[() => { window.__TOKENLEDGER_E2E__ ??= {}; }, undefined]] });

  const big = { ...seed, hasMore: false, nextCursor: null, totalCount: ROWS };
  big.items = Array.from({ length: ROWS }, (_, index) => {
    const base = seed.items[index % seed.items.length];
    return { ...base, id: index + 1, sessionId: `${base.sessionId || 'session'}-${index}` };
  });

  const install = (response) => {
    window.__TOKENLEDGER_E2E__ ??= {};
    (window.__TOKENLEDGER_E2E__.overrides ??= {}).get_usage_details = { value: response };
  };

  const samples = [];
  for (let run = 0; run < RUNS; run += 1) {
    samples.push(await withPage(browser, async (page, cdp) => {
      await page.goto(`${baseUrl}/#overview`);
      await page.locator('main').first().waitFor();
      const before = await metrics(cdp);
      const started = Date.now();
      await page.evaluate(() => { window.location.hash = '#requests'; });
      await page.locator('.log-table tbody tr').nth(ROWS - 1).waitFor({ state: 'attached', timeout: 60_000 });
      const renderMs = Date.now() - started;
      const after = await metrics(cdp);

      // 每次按键与展开一行：从派发事件到下一帧可以画出来为止（含 React 提交与样式布局）。
      const keystrokes = await page.evaluate(async () => {
        const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const input = document.querySelector('.detail-search-input input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        const times = [];
        let text = '';
        for (const char of 'zzzz') {
          text += char;
          const t0 = performance.now();
          setter.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await frame();
          times.push(performance.now() - t0);
        }
        return times;
      });
      // 防抖到期后会按新搜索重新取数；清空搜索并等列表回来，后面的测量才对得上同一份数据。
      await page.locator('.detail-search-input button[aria-label="清除文本搜索"]').click();
      await page.locator('.log-table tbody tr').nth(ROWS - 1).waitFor({ state: 'attached', timeout: 60_000 });

      const expand = await page.evaluate(async () => {
        const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const times = [];
        for (const index of [3, 3, 10, 10, 25, 25]) {
          const button = document.querySelectorAll('.log-detail-toggle')[index];
          const t0 = performance.now();
          button.click();
          await frame();
          times.push(performance.now() - t0);
        }
        return times;
      });

      // 滚动：按帧推进 6000px，记每帧间隔。
      const frames = await page.evaluate(async () => {
        const scroller = document.querySelector('.app-main-scroll, main') ?? document.scrollingElement;
        const target = [scroller, document.scrollingElement].find((element) => element && element.scrollHeight > element.clientHeight + 100) ?? document.scrollingElement;
        target.scrollTop = 0;
        const gaps = [];
        let last = performance.now();
        for (let step = 0; step < 120; step += 1) {
          target.scrollTop += 50;
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const nowTs = performance.now();
          gaps.push(nowTs - last);
          last = nowTs;
        }
        return gaps;
      });

      return {
        renderMs,
        renderScriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
        domNodes: after.Nodes,
        keyMedian: median(keystrokes),
        keyMax: Math.max(...keystrokes),
        expandMedian: median(expand),
        frameP95: percentile(frames, 95),
        longFrames: frames.filter((gap) => gap > 50).length,
      };
    }, { initScripts: [[install, big]] }));
  }
  const pick = (key) => round(median(samples.map((sample) => sample[key])));
  return {
    rows: ROWS,
    runs: RUNS,
    renderMs: pick('renderMs'),
    renderScriptMs: pick('renderScriptMs'),
    domNodes: pick('domNodes'),
    keystrokeMedianMs: pick('keyMedian'),
    keystrokeMaxMs: pick('keyMax'),
    expandRowMedianMs: pick('expandMedian'),
    scrollFrameP95Ms: pick('frameP95'),
    scrollLongFrames: pick('longFrames'),
  };
}

/**
 * 加载更多：真实用法是每次 50 行地往下翻。每次点「加载更多」都回一页新行，
 * 记从点击到新行画出来的耗时，看它随已加载行数怎么变。
 */
async function measureLoadMore(browser, baseUrl) {
  const samples = [];
  for (let run = 0; run < RUNS; run += 1) {
    samples.push(await withPage(browser, async (page) => {
      await page.goto(`${baseUrl}/#overview`);
      await page.locator('main').first().waitFor();
      await page.evaluate((total) => {
        const internals = window.__TAURI_INTERNALS__;
        const original = internals.invoke.bind(internals);
        internals.invoke = async (cmd, args, options) => {
          if (cmd !== 'get_usage_details') return original(cmd, args, options);
          const offset = Number(String(args.query.cursor ?? 'perf:0').split(':')[1]) || 0;
          const response = await original(cmd, { query: { ...args.query, cursor: null } }, options);
          const seed = response.items;
          const items = Array.from({ length: 50 }, (_, index) => {
            const base = seed[(offset + index) % seed.length];
            return { ...base, id: offset + index + 1, sessionId: `${base.sessionId || 'session'}-${offset + index}` };
          });
          const next = offset + items.length;
          return { ...response, items, totalCount: total, hasMore: next < total, nextCursor: next < total ? `perf:${next}` : null };
        };
      }, LOAD_MORE_TO);
      await page.evaluate(() => { window.location.hash = '#requests'; });
      const rows = page.locator('.log-table tbody tr:not(.log-detail-row)');
      await rows.nth(49).waitFor({ state: 'attached' });
      const timings = [];
      for (let loaded = 50; loaded < LOAD_MORE_TO; loaded += 50) {
        const elapsed = await page.evaluate(async (expected) => {
          const button = document.querySelector('.details-load-more button');
          const t0 = performance.now();
          button.click();
          while (document.querySelectorAll('.log-table tbody tr:not(.log-detail-row)').length < expected) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
          return performance.now() - t0;
        }, loaded + 50);
        timings.push({ loaded: loaded + 50, ms: elapsed });
      }
      return timings;
    }));
  }
  const at = (count) => round(median(samples.map((timings) => timings.find((entry) => entry.loaded === count)?.ms ?? NaN)));
  const marks = [100, 500, LOAD_MORE_TO].filter((count, index, list) => count <= LOAD_MORE_TO && list.indexOf(count) === index);
  return { runs: RUNS, pageSize: 50, clickToPaintMs: Object.fromEntries(marks.map((count) => [`at${count}`, at(count)])) };
}

/** 路由页：在途请求一直流动时，10 秒内的主线程占用、样式重算与 DOM 改动次数。 */
async function measureRouting(browser, baseUrl, agents) {
  const seed = (agents) => {
    const startedAt = Date.now();
    const active = Array.from({ length: agents }, (_, index) => ({
      id: index + 1,
      agent: ['claude', 'codex', 'opencode', 'gemini'][index % 4],
      model: 'model-x',
      provider: ['anthropic', 'openai', 'zhipu', 'relay', 'deepseek'][index % 5],
      started: new Date(startedAt - 1000).toISOString(),
      ms: 1000,
      phase: 'upstream',
    }));
    window.__TOKENLEDGER_E2E__ ??= {};
    (window.__TOKENLEDGER_E2E__.overrides ??= {}).peer_live_snapshot = {
      value: { reachable: true, port: 3425, requests: agents, waiting: 0, tools: 0, active, recent: [] },
    };
  };

  const samples = [];
  for (let run = 0; run < RUNS; run += 1) {
    samples.push(await withPage(browser, async (page, cdp) => {
      await page.goto(`${baseUrl}/#routing`);
      await page.locator('.rs-stage').first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2000);
      await page.evaluate(() => {
        window.__perfMutations = 0;
        new MutationObserver((records) => { window.__perfMutations += records.length; })
          .observe(document.querySelector('main') ?? document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      });
      const before = await metrics(cdp);
      await page.waitForTimeout(10_000);
      const after = await metrics(cdp);
      const mutations = await page.evaluate(() => window.__perfMutations);
      const animations = await page.evaluate(() => document.getAnimations().length);
      const delta = (key) => (after[key] - before[key]) * 1000;
      return {
        taskMs: delta('TaskDuration'),
        scriptMs: delta('ScriptDuration'),
        styleMs: delta('RecalcStyleDuration'),
        layoutMs: delta('LayoutDuration'),
        mutations,
        animations,
      };
    }, { initScripts: [[seed, agents]] }));
  }
  const pick = (key) => round(median(samples.map((sample) => sample[key])));
  return {
    runs: RUNS,
    inflight: agents,
    windowSeconds: 10,
    mainThreadBusyMs: pick('taskMs'),
    mainThreadBusyPct: round(pick('taskMs') / 100),
    scriptMs: pick('scriptMs'),
    recalcStyleMs: pick('styleMs'),
    layoutMs: pick('layoutMs'),
    domMutations: pick('mutations'),
    runningAnimations: pick('animations'),
  };
}

async function main() {
  const outDir = await mkdtemp(path.join(tmpdir(), 'tokenledger-perf-'));
  try {
    await build({
      root,
      logLevel: 'warn',
      define: { 'import.meta.env.DEV': 'true' },
      build: { outDir, emptyOutDir: true },
    });
    const server = await preview({ root, logLevel: 'warn', build: { outDir }, preview: { port: Number(arg('port', 4317)), strictPort: true, host: '127.0.0.1' } });
    const baseUrl = server.resolvedUrls.local[0].replace(/\/$/, '');
    // 本机 Playwright 浏览器版本与 @playwright/test 不配套时，用 --chromium 指定可执行文件。
    const browser = await chromium.launch(arg('chromium', '') ? { executablePath: arg('chromium', '') } : {});
    const result = { cpuThrottle: CPU, viewport: VIEWPORT };
    try {
      if (ONLY.has('startup')) result.startup = await measureStartup(browser, baseUrl);
      if (ONLY.has('requests')) result.requests = await measureRequests(browser, baseUrl);
      if (ONLY.has('loadmore')) result.loadMore = await measureLoadMore(browser, baseUrl);
      if (ONLY.has('routing')) {
        result.routingIdle = await measureRouting(browser, baseUrl, 0);
        result.routing = await measureRouting(browser, baseUrl, 6);
      }
    } finally {
      await browser.close();
      await server.close();
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

await main();
