import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuotaProviderEnvelope, QuotaSyncStatus, QuotaWindowSnapshot } from '../types';
import { QuotaPanel } from './QuotaPanel';

const NOW = Date.parse('2026-07-15T06:30:00.000Z');
const MINUTE = 60_000;
const DISABLED_SYNC: QuotaSyncStatus = { enabled: false, state: 'disabled' };

function percentWindow(
  providerId: string,
  windowId: string,
  used: number,
  options: {
    /** null 表示来源没有给出窗口时长。 */
    windowMinutes?: number | null;
    resetInMinutes: number;
    /**
     * reset 与观测时刻之差另加的秒数。精确来源的 reset 带秒；0 表示恰好差整分钟 / 整小时 / 整天，
     * 规则层会把它推断成相对时间来源（T10.153 §3.1 第 4 条）。
     */
    resetExtraSeconds?: number;
    observedMinutesAgo?: number;
  },
): QuotaWindowSnapshot {
  const observedAt = new Date(NOW - (options.observedMinutesAgo ?? 0) * MINUTE).toISOString();
  return {
    providerId,
    windowId,
    windowLabel: windowId,
    scope: 'consumer-subscription',
    source: 'local-authorized',
    status: 'ok',
    used,
    limit: 100,
    remaining: 100 - used,
    unit: 'percent',
    windowMinutes: options.windowMinutes === null ? undefined : options.windowMinutes ?? 300,
    resetsAt: new Date(NOW + options.resetInMinutes * MINUTE + (options.resetExtraSeconds ?? 7) * 1_000).toISOString(),
    observedAt,
    fetchedAt: observedAt,
    staleAfterSeconds: 900,
  };
}

function provider(
  providerId: string,
  capability: QuotaProviderEnvelope['capability'],
  windows: QuotaWindowSnapshot[],
): QuotaProviderEnvelope {
  return {
    schemaVersion: 1,
    providerId,
    displayName: providerId,
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability,
    status: 'ok',
    windows,
  };
}

function renderPanel(providers: QuotaProviderEnvelope[]) {
  return render(
    <QuotaPanel
      providers={providers}
      loading={false}
      error=""
      quotaSyncStatus={DISABLED_SYNC}
      onRefresh={vi.fn()}
      onSyncNow={vi.fn()}
      onOpenSettings={vi.fn()}
      onNotify={vi.fn()}
    />,
  );
}

const paceLines = () => [...document.querySelectorAll<HTMLElement>('.quota-window-pace')];
const detailPace = () => [...document.querySelectorAll('.quota-detail-pace')].map((node) => node.textContent ?? '');
const spokenPace = (line: HTMLElement) => line.querySelector('.sr-only')?.textContent ?? '';

describe('QuotaPanel 额度消耗速度（T10.159 · T10.153 D2/D4）', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('可信来源的窗口在细条下方显示带“预测”标签的一行，读屏读规则层整句，方法与区间收在行尾详情', () => {
    // 5 小时窗口已过约 3 小时、已用 38%：照此速度重置时约用 63%，放慢/加快一半为 51%–76%。
    renderPanel([provider('openai-codex-local', 'stable', [percentWindow('openai-codex-local', 'codex:primary', 38, { resetInMinutes: 120 })])]);
    const [line] = paceLines();
    expect(line.querySelector('.badge')).toHaveTextContent(/^预测$/);
    expect(line).toHaveClass('text-secondary');
    expect(line.closest('.quota-window-meta')).not.toBeNull();
    // 可见的标签与结论不重复读：读屏只读 ariaLabel（以“预测：”开头，含方法与区间）。
    for (const visible of line.querySelectorAll(':scope > :not(.sr-only)')) expect(visible).toHaveAttribute('aria-hidden', 'true');
    expect(spokenPace(line)).toBe(
      '预测：照此速度，重置时约用 63%。按窗口开始以来的平均速度外推（已过 60% 时间，已用 38%）。区间：放慢一半到加快一半，重置时约用 51%–76%。',
    );
    expect(detailPace()).toEqual([
      '预测 · 按窗口开始以来的平均速度外推（已过 60% 时间，已用 38%）；区间：放慢一半到加快一半，重置时约用 51%–76%',
    ]);
    // 额度条仍按当前剩余着色（D4），速度不改颜色档位。
    expect(screen.getByRole('progressbar')).toHaveAttribute('data-level', 'ok');
  });

  it('语气只辅助着色，文字本身说清结论：偏紧用警示色，会提前用完用危险色', () => {
    renderPanel([
      provider('openai-codex-local', 'stable', [percentWindow('openai-codex-local', 'codex:primary', 55, { resetInMinutes: 120 })]),
      provider('anthropic-claude-consumer', 'plan-dependent', [percentWindow('anthropic-claude-consumer', 'five-hour', 82, { resetInMinutes: 90 })]),
    ]);
    const [tight, critical] = paceLines();
    expect(tight).toHaveTextContent('照此速度，重置时约剩 8%');
    expect(tight).toHaveClass('text-warning');
    expect(critical).toHaveTextContent('照此速度约 45 分钟后用完，早于重置');
    expect(critical).toHaveClass('text-danger');
    for (const line of paceLines()) expect(line.textContent).not.toMatch(/告急|偏紧|预估|估算/);
    expect(detailPace()).toEqual([
      '预测 · 按窗口开始以来的平均速度外推（已过 60% 时间，已用 55%）；区间：放慢一半到加快一半，重置时约用 73%–100%',
      '预测 · 按窗口开始以来的平均速度外推（已过 70% 时间，已用 82%）；区间：加快一半约 30 分钟后用完；放慢一半可撑到重置',
    ]);
  });

  it('reset 只精确到天或小时（Claude CLI “Resets in 2 days”一类）：行内不给数字，详情只写不预测的原因', () => {
    renderPanel([
      provider('anthropic-claude-consumer', 'plan-dependent', [
        percentWindow('anthropic-claude-consumer', 'seven-day', 60, { windowMinutes: 10_080, resetInMinutes: 2 * 1_440, resetExtraSeconds: 0 }),
      ]),
      provider('openai-codex-local', 'stable', [
        percentWindow('openai-codex-local', 'codex:primary', 38, { resetInMinutes: 120, resetExtraSeconds: 0 }),
      ]),
    ]);
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
    expect(paceLines()).toHaveLength(0);
    expect(detailPace()).toEqual([
      '预测 · 重置时间只精确到天，暂不计算速度',
      '预测 · 重置时间只精确到小时，暂不计算速度',
    ]);
    for (const text of detailPace()) expect(text).not.toMatch(/\d/);
  });

  it('实验性来源、缺窗口时长与观测不在窗口内：规则层不预测，详情说明原因且不带数字', () => {
    renderPanel([
      provider('google-antigravity-consumer', 'experimental', [percentWindow('google-antigravity-consumer', 'gemini-pro', 40, { resetInMinutes: 120 })]),
      provider('openai-codex-local', 'stable', [
        percentWindow('openai-codex-local', 'codex:primary', 40, { windowMinutes: null, resetInMinutes: 120 }),
        // 5 小时窗口却在 306 分钟后重置：观测早于窗口起点（容差 5 分钟）。
        percentWindow('openai-codex-local', 'codex:secondary', 40, { resetInMinutes: 296, observedMinutesAgo: 10 }),
      ]),
    ]);
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);
    expect(paceLines()).toHaveLength(0);
    expect(detailPace()).toEqual([
      '预测 · 实验性来源的窗口时长或重置时间可能不准，暂不计算速度',
      '预测 · 窗口时长未知，暂不计算速度',
      '预测 · 观测时间不在当前窗口内，暂不计算速度',
    ]);
    for (const text of detailPace()) expect(text).not.toMatch(/\d/);
  });

  it('窗口刚开始只在详情里说明；已用完（含 reset 精度不足的）与历史数据不重复说明', () => {
    renderPanel([provider('openai-codex-local', 'stable', [
      percentWindow('openai-codex-local', 'codex:primary', 5, { resetInMinutes: 290 }),
      percentWindow('openai-codex-local', 'codex:secondary', 100, { resetInMinutes: 60 }),
      percentWindow('openai-codex-local', 'codex:tertiary', 40, { resetInMinutes: 60, observedMinutesAgo: 20 }),
      percentWindow('openai-codex-local', 'codex:quaternary', 100, { resetInMinutes: 60, resetExtraSeconds: 0 }),
    ])]);
    expect(screen.getAllByRole('progressbar')).toHaveLength(4);
    expect(paceLines()).toHaveLength(0);
    expect(detailPace()).toEqual(['预测 · 窗口刚开始，暂不计算速度；窗口过去 30 分钟后才按平均速度预测']);
  });

  it('照此速度已经用完时不给自相矛盾的区间', () => {
    // 10 分钟前观测：已用 99%，窗口过去 30 分钟，按平均速度 18 秒后就已用完。
    renderPanel([provider('openai-codex-local', 'stable', [
      percentWindow('openai-codex-local', 'codex:primary', 99, { resetInMinutes: 260, observedMinutesAgo: 10, resetExtraSeconds: 0 }),
    ])]);
    expect(paceLines()[0]).toHaveTextContent('照此速度可能已经用完，等待来源刷新');
    expect(detailPace()).toEqual(['预测 · 按窗口开始以来的平均速度外推（已过 10% 时间，已用 99%）']);
  });
});
