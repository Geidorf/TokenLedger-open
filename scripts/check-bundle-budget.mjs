import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUNDLE_HEADROOM_WARNING_RATIO,
  CHART_BUNDLE_BUDGET,
  collectJavaScriptAssets,
  evaluateChartBundle,
  formatHeadroom,
  formatKilobytes,
  tightHeadroomGroups,
} from './bundle-budget.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(root, 'dist');

try {
  const result = evaluateChartBundle(collectJavaScriptAssets(distDirectory));

  console.log(`Chart bundle budget: ${path.relative(root, distDirectory) || '.'}`);
  for (const [name, group] of Object.entries(result.groups)) {
    const files = group.assets.map((asset) => asset.file).join(', ') || 'missing';
    console.log(
      `  ${name}: ${formatKilobytes(group.bytes)} raw / ${formatKilobytes(group.gzipBytes)} gzip `
      + `(limits ${formatKilobytes(group.maxBytes)} / ${formatKilobytes(group.maxGzipBytes)}; ${files})`,
    );
    console.log(
      `    raw ${formatHeadroom(group.bytes, group.maxBytes)}`
      + ` · gzip ${formatHeadroom(group.gzipBytes, group.maxGzipBytes)}`,
    );
  }
  console.log(
    `  aggregate: ${formatKilobytes(result.aggregate.bytes)} raw / `
    + `${formatKilobytes(result.aggregate.gzipBytes)} gzip `
    + `(limits ${formatKilobytes(CHART_BUNDLE_BUDGET.aggregate.maxBytes)} / `
    + `${formatKilobytes(CHART_BUNDLE_BUDGET.aggregate.maxGzipBytes)})`,
  );
  console.log(
    `    raw ${formatHeadroom(result.aggregate.bytes, CHART_BUNDLE_BUDGET.aggregate.maxBytes)}`
    + ` · gzip ${formatHeadroom(result.aggregate.gzipBytes, CHART_BUNDLE_BUDGET.aggregate.maxGzipBytes)}`,
  );

  // 判定不变：超限才失败。这里只是不再让「余量 0.46%」和「余量 30%」打印出
  // 一模一样的通过信息——否则撞线永远要等到下一个人加图表特性时才被发现。
  const tight = tightHeadroomGroups(result);
  if (tight.length > 0) {
    console.log(
      `  注意：${tight.join('、')} 的余量已低于 ${(BUNDLE_HEADROOM_WARNING_RATIO * 100).toFixed(0)}%，`
      + '下一次图表改动很可能直接撞线；先减重或先讨论上限，不要顺手调高阈值。',
    );
  }

  if (result.violations.length > 0) {
    console.error('Chart bundle budget violations:');
    for (const violation of result.violations) {
      console.error(`  - ${violation}`);
    }
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Chart bundle budget could not be evaluated: ${message}`);
  process.exitCode = 1;
}
