/**
 * 预测与额度速度不进入同步、分享海报、HTML 简报、导出、壁纸与挂件（T10.153，D2）。
 *
 * 守卫按 import 图做可达性检查，而不是只在入口文件里找字面量：预测经 insightRules 之类的
 * 共用模块转手、写成 `'../utils/forecast'`、带 `.ts` 后缀、`export … from` 或动态 `import()`，
 * 都会被发现。只解析相对路径（仓库没有路径别名）；包依赖不在图内。
 */
import { describe, expect, it } from 'vitest';

type Sources = Readonly<Record<string, string>>;

const SOURCES: Sources = import.meta.glob<string>(
  ['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/**/*.d.ts'],
  { query: '?raw', import: 'default', eager: true },
);

const FORECAST = '/src/utils/forecast.ts';
const QUOTA_PACE = '/src/utils/quotaPace.ts';

/** 这些表面会被截图、落盘或离开本机，预测与速度都不得进入（规格 §6）。 */
const FORBID_BOTH = [
  '/src/utils/reportExport.ts',
  '/src/utils/shareSummary.ts',
  '/src/utils/shareCardRenderer.ts',
  '/src/components/ShareCardModal.tsx',
  '/src/utils/liveWallpaper.ts',
  '/src/components/LiveWallpaperView.tsx',
];
/** 托盘挂件与桌面小组件 v1 不显示周期末预测；额度速度以后可选（它们已经引用额度面板）。 */
const FORBID_FORECAST = [
  '/src/components/WidgetView.tsx',
  '/src/utils/widgetConfig.ts',
];

const SPECIFIER_PATTERNS = [
  // import x from '…'、import type { X } from '…'、export { x } from '…'、export * from '…'（可跨行）
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // import '…'（只为副作用）
  /\bimport\s*['"]([^'"]+)['"]/g,
  // import('…')、typeof import('…')；带 ${} 的模板字符串不是字面量，由下面的模式报告
  /\bimport\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/g,
];
/** 静态看不出目标的写法：出现在受保护入口的可达范围内就要求人工确认。 */
const UNRESOLVABLE_PATTERNS = [
  /\bimport\s*\(\s*[^'"`\s)]/,
  /\bimport\s*\(\s*`[^`]*\$\{/,
  /\brequire\s*\(/,
];
const NON_CODE_EXTENSION = /\.(?:css|scss|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|txt|md|html)$/i;
/** 能静态读出首个参数的 glob 调用：不带泛型或只带不嵌套的泛型，参数为字符串或字符串数组字面量。 */
const LITERAL_GLOB_CALL = /import\.meta\.glob\s*(?:<[^<>()]*>)?\s*\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/y;

/**
 * 只匹配非代码资源（如 `*.svg`）的字面量 glob 拉不进代码；其余写法（嵌套泛型、变量参数、
 * 可匹配代码的 pattern）一律视为静态看不出目标，宁可多报。
 */
function hasCodeGlob(source: string): boolean {
  for (const occurrence of source.matchAll(/\bimport\.meta\.glob\b/g)) {
    LITERAL_GLOB_CALL.lastIndex = occurrence.index;
    const call = LITERAL_GLOB_CALL.exec(source);
    if (!call) return true;
    const patterns = [...call[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
    const included = patterns.filter((pattern) => !pattern.startsWith('!'));
    if (included.length === 0 || !included.every((pattern) => NON_CODE_EXTENSION.test(pattern))) return true;
  }
  return false;
}

function directoryOf(file: string): string {
  return file.slice(0, file.lastIndexOf('/'));
}

function joinPath(directory: string, relative: string): string {
  const parts = directory.split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function importSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** 解析相对 import；包依赖返回 null，非代码资源返回 'asset'，解析不到的代码路径返回 'unresolved'。 */
function resolveImport(sources: Sources, from: string, specifier: string): string | 'asset' | 'unresolved' | null {
  if (!specifier.startsWith('.')) return null;
  const clean = specifier.replace(/[?#].*$/, '');
  if (NON_CODE_EXTENSION.test(clean)) return 'asset';
  const base = joinPath(directoryOf(from), clean);
  const withoutJs = base.replace(/\.(?:m?jsx?)$/, '');
  const candidates = [
    base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, `${withoutJs}.ts`, `${withoutJs}.tsx`,
  ];
  return candidates.find((candidate) => candidate in sources) ?? 'unresolved';
}

interface Reachability {
  /** 可达文件 → 首次到达它的上一跳；入口映射到 null。 */
  parents: Map<string, string | null>;
  unresolved: string[];
  dynamic: string[];
}

function reachableFrom(sources: Sources, entry: string): Reachability {
  const parents = new Map<string, string | null>([[entry, null]]);
  const unresolved: string[] = [];
  const dynamic: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const source = sources[file];
    if (source === undefined) continue;
    if (UNRESOLVABLE_PATTERNS.some((pattern) => pattern.test(source)) || hasCodeGlob(source)) dynamic.push(file);
    for (const specifier of importSpecifiers(source)) {
      const target = resolveImport(sources, file, specifier);
      if (target === null || target === 'asset') continue;
      if (target === 'unresolved') {
        unresolved.push(`${file} → ${specifier}`);
        continue;
      }
      if (!parents.has(target)) {
        parents.set(target, file);
        queue.push(target);
      }
    }
  }
  return { parents, unresolved, dynamic };
}

function pathTo(parents: Map<string, string | null>, target: string): string {
  const chain: string[] = [];
  for (let file: string | null | undefined = target; file; file = parents.get(file)) chain.unshift(file);
  return chain.join(' → ');
}

function forbiddenPaths(sources: Sources, entry: string, forbidden: readonly string[]): string[] {
  const { parents } = reachableFrom(sources, entry);
  return forbidden.filter((target) => parents.has(target)).map((target) => pathTo(parents, target));
}

describe('import 图守卫本身', () => {
  it('能识别跨行、带后缀、上级目录、再导出与动态 import，并经共用模块转手追到预测', () => {
    const fake: Sources = {
      '/src/utils/reportExport.ts': "import {\n  buildRhythm,\n} from './insightRules';\nexport { x } from './format.ts';",
      '/src/utils/insightRules.ts': "import type { PeriodForecast } from '../utils/forecast';",
      '/src/utils/format.ts': "export * from './numbers';",
      '/src/utils/numbers.ts': "export const load = () => import('./quotaPace');",
      '/src/utils/forecast.ts': '',
      '/src/utils/quotaPace.ts': '',
    };
    expect(forbiddenPaths(fake, '/src/utils/reportExport.ts', [FORECAST, QUOTA_PACE])).toEqual([
      '/src/utils/reportExport.ts → /src/utils/insightRules.ts → /src/utils/forecast.ts',
      '/src/utils/reportExport.ts → /src/utils/format.ts → /src/utils/numbers.ts → /src/utils/quotaPace.ts',
    ]);
  });

  it('解析不到的相对代码路径与静态看不出目标的写法会被报告，而不是静默跳过', () => {
    const fake: Sources = {
      '/src/a.ts': "import { b } from './missing';\nimport './style.css';\nimport data from '../fixtures/x.json';",
      '/src/b.ts': 'const name = "forecast"; export const load = () => import(`./${name}`);',
      '/src/c.ts': "const target = './forecast'; export const load = () => import(target);",
      '/src/d.ts': "const icons = import.meta.glob('./icons/*.svg', { eager: true, query: '?raw' });",
      '/src/e.ts': "const mods = import.meta.glob<string>(['./utils/*.ts', '!./utils/*.test.ts']);",
      '/src/f.ts': 'const mods = import.meta.glob(PATTERN);',
      '/src/g.ts': "const mods = import.meta.glob<Record<string, unknown>>('./utils/*.ts');",
      '/src/h.ts': "const icons = import.meta.glob<string>(`./icons/*.svg`);",
    };
    expect(reachableFrom(fake, '/src/a.ts').unresolved).toEqual(['/src/a.ts → ./missing']);
    expect(reachableFrom(fake, '/src/b.ts')).toMatchObject({ dynamic: ['/src/b.ts'], unresolved: [] });
    expect(reachableFrom(fake, '/src/c.ts').dynamic).toEqual(['/src/c.ts']);
    expect(reachableFrom(fake, '/src/d.ts').dynamic).toEqual([]);
    expect(reachableFrom(fake, '/src/e.ts').dynamic).toEqual(['/src/e.ts']);
    expect(reachableFrom(fake, '/src/f.ts').dynamic).toEqual(['/src/f.ts']);
    expect(reachableFrom(fake, '/src/g.ts').dynamic).toEqual(['/src/g.ts']);
    expect(reachableFrom(fake, '/src/h.ts').dynamic).toEqual(['/src/h.ts']);
  });

  it('真实 import 图不是空的：入口确实能走到已知的共用模块', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
    expect(SOURCES[FORECAST].length).toBeGreaterThan(1_000);
    expect(SOURCES[QUOTA_PACE].length).toBeGreaterThan(1_000);
    expect(reachableFrom(SOURCES, '/src/utils/reportExport.ts').parents.has('/src/utils/insightRules.ts')).toBe(true);
    expect(reachableFrom(SOURCES, '/src/components/ShareCardModal.tsx').parents.has('/src/utils/shareSummary.ts')).toBe(true);
    expect(reachableFrom(SOURCES, '/src/components/WidgetView.tsx').parents.has('/src/components/QuotaPanel.tsx')).toBe(true);
    expect(reachableFrom(SOURCES, FORECAST).parents.has('/src/utils/insightRules.ts')).toBe(true);
  });
});

describe('预测与额度速度不进入同步、海报、简报、导出、壁纸与挂件', () => {
  it.each(FORBID_BOTH)('%s 的 import 图里没有预测与额度速度', (entry) => {
    expect(SOURCES[entry], entry).toBeDefined();
    const reach = reachableFrom(SOURCES, entry);
    expect(forbiddenPaths(SOURCES, entry, [FORECAST, QUOTA_PACE])).toEqual([]);
    expect(reach.unresolved).toEqual([]);
    expect(reach.dynamic).toEqual([]);
  });

  it.each(FORBID_FORECAST)('%s 的 import 图里没有周期末预测', (entry) => {
    expect(SOURCES[entry], entry).toBeDefined();
    const reach = reachableFrom(SOURCES, entry);
    expect(forbiddenPaths(SOURCES, entry, [FORECAST])).toEqual([]);
    expect(reach.unresolved).toEqual([]);
    expect(reach.dynamic).toEqual([]);
  });

  it('计算预测与速度不触达 IPC、持久化或网络（含全部依赖）', () => {
    for (const entry of [FORECAST, QUOTA_PACE]) {
      const reach = reachableFrom(SOURCES, entry);
      expect(reach.unresolved).toEqual([]);
      expect(reach.dynamic).toEqual([]);
      // 文案表只在本机存界面语言代码（zh / en），不经手预测或速度数据。
      const touching = [...reach.parents.keys()].filter((file) => file !== '/src/i18n/index.ts' && (
        /@tauri-apps|\binvoke\s*\(|localStorage|sessionStorage|indexedDB|\bfetch\s*\(|XMLHttpRequest|WebSocket/
          .test(SOURCES[file])
      ));
      expect(touching).toEqual([]);
    }
  });
});
