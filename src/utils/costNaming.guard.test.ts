/**
 * 旧费用叫法守卫（T10.154 §1 术语表「不再使用的叫法」、§6.3；T10.186）。
 *
 * 桌面界面源码（`src/**`，不含测试、类型声明与网页原型）里的字符串字面量、模板字符串片段、
 * JSX 文本与属性值不得再出现已退役的叫法。注释和标识符不算界面文字，不检查。
 *
 * 「缓存节省」单独使用本也在退役之列，但 T10.162 A2 之前它仍是缓存读取节省的现行标签
 * （REQUIREMENTS 现行口径），等缓存净节省上线后再把它加进来。
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type Sources = Readonly<Record<string, string>>;

const SOURCES: Sources = import.meta.glob<string>(
  ['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/**/*.d.ts', '!/src/prototypes/**'],
  { query: '?raw', import: 'default', eager: true },
);

interface RetiredWording {
  pattern: RegExp;
  use: string;
  /** 命中 pattern 但同时命中这里任意一条时放行（确指额度等合法用法），不算旧叫法。 */
  allow?: readonly RegExp[];
}

// 「金额」独立成句时确指额度（Quota v1），与本方案的预估费用是两条事实链，允许保留（T10.186 评审 P3-1）。
const AMOUNT_ALLOWED_USES: readonly RegExp[] = [/不上传金额/];

const RETIRED: readonly RetiredWording[] = [
  { pattern: /成本/, use: '预估费用 / 费用（预估成本、估算成本、预估总成本、预计成本、花费成本、成本密度、成本占比等都已退役）' },
  { pattern: /花费/, use: '预估费用（花费金额、花费成本、每百万 Token 花费已退役）' },
  {
    // 默认禁止 + 白名单（T10.186 评审 P3-1）：只要出现「金额」就先算旧叫法，例如金额视角、模型金额
    // 分布、金额占比、隐藏金额、金额数据、已知金额、未知金额、会包含金额、节省金额等；仅 allow 列出的
    // 确指额度用法（如「不上传金额」）放行，不必逐个新组合都加规则。
    pattern: /金额/,
    use: '费用 / 预估费用（「金额」已退役：金额视角、模型金额分布、金额占比、隐藏金额、金额数据、已知金额、未知金额、会包含金额等都不再使用；仅「不上传金额」这类确指额度的用法放行）',
    allow: AMOUNT_ALLOWED_USES,
  },
  { pattern: /(?<!预估)支出/, use: '费用（「支出」只留给 B 期的「预估支出」）' },
  { pattern: /估算节省|预估节省|节省估算/, use: '缓存节省（现行）/ 缓存净节省（T10.162）' },
  { pattern: /写入费用/, use: '缓存写入溢价' },
  { pattern: /\/1k\b/, use: '单位费用 ≈$x/百万 Token' },
  { pattern: /回本率|性价比|\bROI\b|划算/, use: '回本倍数（B 期）' },
  {
    // 默认禁止 + 白名单，与「金额」同一条机制（T10.197 评审 P3-6）：只收窄到「按实时汇率」「实时汇率
    // 换算」两句会漏掉不带前后缀的裸标签（比如单独一句「实时汇率」），必须像「金额」一样先假定
    // 「实时汇率」三个字本身就是旧叫法，只放行方案 §4.12 的合法原文「不联网获取实时汇率」。
    pattern: /实时汇率/,
    use: '换算汇率（仅「不联网获取实时汇率」这句合法原文放行）',
    allow: [/不联网获取实时汇率/],
  },
];

/** 源码里会显示给用户的文字：字符串字面量、模板字符串的静态片段、JSX 文本（属性值也是字符串字面量）。 */
function visibleTexts(file: string, source: string): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, kind);
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node)
      || ts.isJsxText(node)
    ) {
      texts.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return texts;
}

function retiredHits(file: string, source: string): string[] {
  const hits: string[] = [];
  for (const text of visibleTexts(file, source)) {
    for (const { pattern, use, allow } of RETIRED) {
      // 白名单先从文字里摘掉被允许的短语，剩下的部分才拿去匹配旧叫法——不是整句里出现过
      // 一次允许用法就放行整句。否则同一句里紧挨着的另一处真正旧叫法会被那次允许用法
      // 连带放过，检测不出来（T10.197 评审 P3-6，复查 FI-11）。
      const stripped = allow
        ? allow.reduce((acc, exempt) => acc.replace(new RegExp(exempt.source, 'g'), ''), text)
        : text;
      if (!pattern.test(stripped)) continue;
      hits.push(`${file}：「${text.trim()}」→ 改用 ${use}`);
    }
  }
  return hits;
}

describe('旧费用叫法守卫本身', () => {
  it('只看界面文字：注释不算，JSX 文本、属性与模板字符串片段都算', () => {
    const fake = [
      '// 注释里提到预估成本不算',
      '/* 成本 */',
      "const label = '预估费用';",
      'export const a = <span title="今日成本">{label}金额视角</span>;',
      'export const b = `花费 ${label} 模型用量与支出分布`;',
      "export const c = ['金额', '缓存节省', '预估支出 ≈$42', '不上传金额、URL 或原始响应'];",
    ].join('\n');
    expect(retiredHits('/src/fake.tsx', fake)).toEqual([
      '/src/fake.tsx：「今日成本」→ 改用 ' + RETIRED[0].use,
      '/src/fake.tsx：「金额视角」→ 改用 ' + RETIRED[2].use,
      '/src/fake.tsx：「花费」→ 改用 ' + RETIRED[1].use,
      '/src/fake.tsx：「模型用量与支出分布」→ 改用 ' + RETIRED[3].use,
      '/src/fake.tsx：「金额」→ 改用 ' + RETIRED[2].use,
    ]);
  });

  it('「金额」默认禁止，白名单只放行确指额度的用法；节省估算与实时汇率旧句都能被拦（T10.186 评审 P3-1）', () => {
    const fake = [
      "export const a = ['金额数据不可用', '占比仅基于已知金额；未知金额保留在列表中。'];",
      "export const b = ['分享图片会包含金额', '节省估算不可得'];",
      "export const c = ['按实时汇率换算今天的余额', '实时汇率换算'];",
      "export const d = '不联网获取实时汇率。';",
      "export const e = '不上传金额、URL、API key 或原始响应。';",
    ].join('\n');
    const hits = retiredHits('/src/fake2.tsx', fake);
    expect(hits).toEqual([
      '/src/fake2.tsx：「金额数据不可用」→ 改用 ' + RETIRED[2].use,
      '/src/fake2.tsx：「占比仅基于已知金额；未知金额保留在列表中。」→ 改用 ' + RETIRED[2].use,
      '/src/fake2.tsx：「分享图片会包含金额」→ 改用 ' + RETIRED[2].use,
      '/src/fake2.tsx：「节省估算不可得」→ 改用 ' + RETIRED[4].use,
      '/src/fake2.tsx：「按实时汇率换算今天的余额」→ 改用 ' + RETIRED[8].use,
      '/src/fake2.tsx：「实时汇率换算」→ 改用 ' + RETIRED[8].use,
    ]);
    // 「不联网获取实时汇率」是方案 §4.12 的合法原文（B4），不应被拦；「不上传金额」确指额度，同样放行。
    // 单独重新扫描这两句（不与上面混在一起判断），避免和 RETIRED[2].use 自身文字里出现的
    // 「不上传金额」示例混淆。
    expect(retiredHits('/src/fake2.tsx', "export const d = '不联网获取实时汇率。';")).toEqual([]);
    expect(retiredHits('/src/fake2.tsx', "export const e = '不上传金额、URL、API key 或原始响应。';")).toEqual([]);
  });

  it('白名单只摘掉被允许的短语，同一句里紧挨着的另一处旧叫法仍要拦住（复查 FI-11）', () => {
    // 整句同时出现「不上传金额」（allow）与「金额视角」（真正的旧叫法）：旧的“整句放行”写法会把
    // 这句一起放过；摘掉允许短语后剩下「，但金额视角仍然可见。」仍命中「金额」，必须拦。
    const fake = "export const a = '不上传金额，但金额视角仍然可见。';";
    expect(retiredHits('/src/fi11.tsx', fake)).toEqual([
      '/src/fi11.tsx：「不上传金额，但金额视角仍然可见。」→ 改用 ' + RETIRED[2].use,
    ]);
  });

  it('「实时汇率」默认禁止：不带旧句前后缀的裸标签也要拦，只放行「不联网获取实时汇率」（复查 FI-12）', () => {
    // 旧写法只收窄到「按实时汇率」「实时汇率换算」两句，裸标签「实时汇率」不带这两种前后缀，
    // 会被漏检——必须像「金额」一样默认禁止整个词，只放行方案 §4.12 的那句合法原文。
    const fake = "export const label = '实时汇率';";
    expect(retiredHits('/src/fi12.tsx', fake)).toEqual([
      '/src/fi12.tsx：「实时汇率」→ 改用 ' + RETIRED[8].use,
    ]);
  });

  it('扫描范围是真实的桌面源码，且能读到新叫法', () => {
    const files = Object.keys(SOURCES);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.startsWith('/src/prototypes/'))).toBe(false);
    for (const file of [
      '/src/components/MetricsGrid.tsx',
      '/src/components/TrendPanel.tsx',
      '/src/components/WidgetView.tsx',
      '/src/components/ShareCardModal.tsx',
      '/src/utils/reportExport.ts',
      '/src/utils/costCopy.ts',
    ]) {
      expect(SOURCES[file], file).toBeDefined();
    }
    expect(visibleTexts('/src/components/TrendPanel.tsx', SOURCES['/src/components/TrendPanel.tsx']))
      .toContain('费用视角 · USD');
    expect(visibleTexts('/src/utils/costCopy.ts', SOURCES['/src/utils/costCopy.ts'])).toContain('预估费用');
  });
});

describe('桌面界面不再出现已退役的费用叫法（T10.154 §1）', () => {
  it('src/**（不含测试与原型）的界面文字里没有旧叫法', () => {
    const hits = Object.entries(SOURCES).flatMap(([file, source]) => retiredHits(file, source));
    expect(hits).toEqual([]);
  });
});
