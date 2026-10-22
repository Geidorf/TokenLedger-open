import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

export const CHART_BUNDLE_BUDGET = Object.freeze({
  groups: Object.freeze({
    charts: Object.freeze({
      pattern: /^charts-[A-Za-z0-9_-]+\.js$/,
      maxBytes: 400_000,
      maxGzipBytes: 140_000,
    }),
    'chart-renderer': Object.freeze({
      pattern: /^chart-renderer-[A-Za-z0-9_-]+\.js$/,
      maxBytes: 190_000,
      maxGzipBytes: 65_000,
    }),
    'prototype-chart-extras': Object.freeze({
      pattern: /^prototype-chart-extras-[A-Za-z0-9_-]+\.js$/,
      maxBytes: 45_000,
      maxGzipBytes: 15_000,
      includeInAggregate: false,
    }),
  }),
  aggregate: Object.freeze({
    maxBytes: 565_000,
    maxGzipBytes: 195_000,
  }),
});

export function collectJavaScriptAssets(distDirectory) {
  const assetsDirectory = path.join(distDirectory, 'assets');
  if (!fs.existsSync(assetsDirectory)) {
    throw new Error(`Build assets directory does not exist: ${assetsDirectory}`);
  }

  return fs.readdirSync(assetsDirectory)
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => {
      const content = fs.readFileSync(path.join(assetsDirectory, file));
      return {
        file,
        bytes: content.byteLength,
        gzipBytes: gzipSync(content, { level: 9 }).byteLength,
      };
    });
}

export function evaluateChartBundle(assets, budget = CHART_BUNDLE_BUDGET) {
  const violations = [];
  const groups = {};

  for (const [name, limits] of Object.entries(budget.groups)) {
    const matches = assets.filter((asset) => limits.pattern.test(asset.file));
    if (matches.length !== 1) {
      violations.push(`${name} must match exactly one built asset; found ${matches.length}`);
    }

    const bytes = matches.reduce((total, asset) => total + asset.bytes, 0);
    const gzipBytes = matches.reduce((total, asset) => total + asset.gzipBytes, 0);
    groups[name] = { assets: matches, bytes, gzipBytes, ...limits };

    if (bytes > limits.maxBytes) {
      violations.push(`${name} raw size ${bytes} exceeds ${limits.maxBytes} bytes`);
    }
    if (gzipBytes > limits.maxGzipBytes) {
      violations.push(`${name} gzip size ${gzipBytes} exceeds ${limits.maxGzipBytes} bytes`);
    }
  }

  const aggregate = Object.values(groups)
    .filter((group) => group.includeInAggregate !== false)
    .reduce(
      (total, group) => ({
        bytes: total.bytes + group.bytes,
        gzipBytes: total.gzipBytes + group.gzipBytes,
      }),
      { bytes: 0, gzipBytes: 0 },
    );

  if (aggregate.bytes > budget.aggregate.maxBytes) {
    violations.push(
      `chart aggregate raw size ${aggregate.bytes} exceeds ${budget.aggregate.maxBytes} bytes`,
    );
  }
  if (aggregate.gzipBytes > budget.aggregate.maxGzipBytes) {
    violations.push(
      `chart aggregate gzip size ${aggregate.gzipBytes} exceeds ${budget.aggregate.maxGzipBytes} bytes`,
    );
  }

  return { groups, aggregate, violations };
}

export function formatKilobytes(bytes) {
  return `${(bytes / 1000).toFixed(2)} kB`;
}

/**
 * 余量低于这个比例时，报告里额外提醒一句。
 *
 * 这里刻意不改判定：门禁在超限时失败已经是对的。问题只在于此前报告只打绝对
 * 数值，2026-08-23 评审时 aggregate 是 562.39/565.00 kB——余量 0.46%，而输出
 * 看上去和余量 30% 时一模一样。撞线要等到下一个人加图表特性时才被发现。
 */
export const BUNDLE_HEADROOM_WARNING_RATIO = 0.05;

export function headroom(used, limit) {
  const remainingBytes = limit - used;
  return {
    remainingBytes,
    ratio: limit > 0 ? remainingBytes / limit : 0,
  };
}

export function formatHeadroom(used, limit) {
  const { remainingBytes, ratio } = headroom(used, limit);
  return `余量 ${formatKilobytes(remainingBytes)} / ${(ratio * 100).toFixed(2)}%`;
}

/** 余量吃紧的分组，供报告层单独点名。 */
export function tightHeadroomGroups(result, ratio = BUNDLE_HEADROOM_WARNING_RATIO, budget = CHART_BUNDLE_BUDGET) {
  const tight = [];
  for (const [name, group] of Object.entries(result.groups)) {
    if (headroom(group.bytes, group.maxBytes).ratio < ratio) tight.push(`${name} raw`);
    if (headroom(group.gzipBytes, group.maxGzipBytes).ratio < ratio) tight.push(`${name} gzip`);
  }
  if (headroom(result.aggregate.bytes, budget.aggregate.maxBytes).ratio < ratio) tight.push('aggregate raw');
  if (headroom(result.aggregate.gzipBytes, budget.aggregate.maxGzipBytes).ratio < ratio) tight.push('aggregate gzip');
  return tight;
}
