import { describe, expect, it } from 'vitest';
import { en } from './en';
import { format, MESSAGES } from './index';
import { zh } from './zh';

// 已完整迁移到文案表的文件：这里列出的文件里不得再出现写死的中文（注释除外）。
// 迁完一个页面就把它加进来，防止后续改动又把中文写回组件里。
const FULLY_LOCALIZED = [
  'src/i18n/index.ts',
  'src/i18n/LanguageSelect.tsx',
  'src/components/settings/LanguageCard.tsx',
  'src/components/settings/CloudAccountSection.tsx',
  'src/components/settings/WallpaperSection.tsx',
  'src/features/onboarding/FirstRunGuide.tsx',
  'src/features/onboarding/onboardingState.ts',
  'src/features/gateway/RoutingPage.tsx',
  'src/features/gateway/RoutingStage.tsx',
  'src/features/gateway/routingScene.ts',
  'src/features/gateway/DecisionTrace.tsx',
  'src/features/gateway/GatewayPage.tsx',
  'src/features/gateway/ui.tsx',
  'src/components/usage/ContextComposition.tsx',
  'src/components/usage/AverageContextPanel.tsx',
  'src/utils/contextComposition.ts',
  'src/components/Sidebar.tsx',
  'src/components/AppHeader.tsx',
  'src/features/gateway/ModelWorkspace.tsx',
  'src/features/gateway/ProviderHealth.tsx',
  'src/features/gateway/ProvidersPage.tsx',
  'src/features/gateway/AgentsPage.tsx',
  'src/features/gateway/agents.ts',
  'src/components/settings/RoutingPublishCard.tsx',
  'src/components/settings/PeerSharedUsageCard.tsx',
  'src/components/LogsTable.tsx',
  'src/components/RangeControls.tsx',
  'src/components/FilterMultiSelect.tsx',
  'src/utils/detailGranularity.ts',
  'src/utils/quotaPace.ts',
  'src/components/SessionAnalysisDrawer.tsx',
  'src/types/sessionAnalysis.ts',
  'src/components/settings/BudgetSection.tsx',
  'src/hooks/useBudget.ts',
  'src/components/settings/SettingsPrimitives.tsx',
  'src/components/settings/PeerSyncCard.tsx',
  'src/components/settings/ProjectDimensionCard.tsx',
];

// 英文文案里允许出现中文的键：语言名用它自己的文字写。
const NATIVE_NAME_KEYS = new Set(['language.option.zh']);

const CJK = /[㐀-鿿＀-￯　-〿]/;
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function stripComments(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

// 键是 `/src/...` 形式的路径，值是源码原文。
const SOURCES = import.meta.glob<string>(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true });
const source = (path: string) => {
  const text = SOURCES[`/${path}`];
  if (text === undefined) throw new Error(`找不到源码：${path}`);
  return text;
};

describe('界面文案表', () => {
  it('中英文键一一对应', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('每条文案都非空，占位符中英一致', () => {
    for (const [key, text] of Object.entries(zh)) {
      const english = en[key as keyof typeof zh];
      expect(text.trim(), key).not.toBe('');
      expect(english.trim(), key).not.toBe('');
      expect(placeholders(english), key).toEqual(placeholders(text));
    }
  });

  it('英文文案里没有漏翻的中文', () => {
    const leftovers = Object.entries(en).filter(([key, text]) => !NATIVE_NAME_KEYS.has(key) && CJK.test(text));
    expect(leftovers.map(([key]) => key)).toEqual([]);
  });

  it('每个键都有代码在用', () => {
    const corpus = Object.entries(SOURCES)
      .filter(([path]) => path !== '/src/i18n/zh.ts' && path !== '/src/i18n/en.ts')
      .map(([, text]) => text)
      .join('\n');
    const unused = Object.keys(zh).filter((key) => !corpus.includes(`'${key}'`));
    expect(unused).toEqual([]);
  });

  it('已迁移文件里没有写死的中文', () => {
    const offenders = FULLY_LOCALIZED.flatMap((path) => stripComments(source(path))
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => CJK.test(line))
      .map(({ index }) => `${path}:${index + 1}`));
    expect(offenders).toEqual([]);
  });

  it('两种语言都能取到文案', () => {
    expect(MESSAGES.zh['onboarding.title.welcome']).toBe(zh['onboarding.title.welcome']);
    expect(MESSAGES.en['onboarding.title.welcome']).toBe('Welcome to TokenLedger');
    expect(format('{a}/{b} {c}', { a: 1, b: 2 })).toBe('1/2 {c}');
  });
});
