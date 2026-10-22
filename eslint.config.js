// 这份配置的存在理由是一次真实事故，不是「大家都装 ESLint」。
//
// T10.60 修复的「明细筛选死交互」——用户选了筛选、界面显示「已选 1 项」、表格
// 却纹丝不动——根因是一次重构把 loadDetails 从 effect 依赖里删掉，并用
// `// eslint-disable-next-line react-hooks/exhaustive-deps` 把告警盖住。而仓库
// 当时（直到 T10.75 之前）根本没有 ESLint：那行注释不抑制任何东西，纯装饰。
// 于是一个用户可感知的高危交互回归在主干上活了很久，没有任何机器拦得住它。
//
// 因此这里只做一件事，并且把它做成 error：让 react-hooks 的两条规则真正生效，
// 让 `eslint-disable` 重新变成一个有代价、必须写明理由的动作。
//
// 风格类规则、`no-unused-vars`、`no-control-regex` 之类一概不开。它们与本次
// 事故无关，打开会在本任务范围外的文件里造成十几条与用户无关的整改；需要时
// 单独立任务，不要在这里顺手加。

import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'apps/**', 'src/vite-env.d.ts'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // 两个非 React 模块里恰好存在名字以 use 开头的普通函数：echarts/core 的
    // `use()` 注册函数，以及 Canvas 绘制里的 `useTextRole()`。规则按命名判定
    // 「这是 Hook」，在这里必然误报。关掉的是误报，不是真实约束——这两个文件
    // 不含任何 React 组件。
    files: ['src/echartsRuntime.ts', 'src/echartsPrototypeRuntime.ts', 'src/utils/shareCardRenderer.ts'],
    rules: { 'react-hooks/rules-of-hooks': 'off' },
  },
);
