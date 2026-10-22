import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WidgetLayout } from '../../utils/widgetConfig';
import { buildCardModel, type CardModel, type CardQuota, type CardQuotaItem } from './cardModel';
import { LedgerCard } from './LedgerCard';
import { LedgerRing, ringGeometry } from './LedgerRing';
import { sampleStats } from './WidgetPreview';

const NOW = new Date(2026, 6, 15, 14, 30).getTime();
const LOADED_AT = new Date(2026, 6, 15, 14, 31);

/** 与视觉稿同一组额度，按吃紧程度排好；多出的两条模拟公司额度的今日与本月。 */
const ROWS: Array<[string, string, string, number, CardQuotaItem['level'], number]> = [
  ['Claude', '', '5 小时', 14, 'critical', 38],
  ['Codex', '', '每周', 36, 'warn', 4_260],
  ['Antigravity', 'Claude / GPT', '每周', 55, 'ok', 4_260],
  ['Claude', '', '7 天', 59, 'ok', 4_260],
  ['Codex', '', '5 小时', 62, 'ok', 119],
  ['Antigravity', 'Gemini', '每周', 68, 'ok', 4_260],
  ['生产账号', '', '今日', 70, 'ok', 300],
  ['生产账号', '', '本月', 80, 'ok', 20_000],
];

function quota(count: number): CardQuota {
  return {
    kind: 'ready',
    items: ROWS.slice(0, count).map(([provider, group, label, available, level, minutes], index) => ({
      key: `k${index}`,
      provider,
      group,
      label,
      window: group ? `${group} ${label}` : label,
      available,
      level,
      stale: false,
      resetsAt: new Date(NOW + minutes * 60_000).toISOString(),
    })),
  };
}

function model(overrides: { quota?: CardQuota; error?: string; empty?: boolean } = {}): CardModel {
  return buildCardModel({
    range: 'today',
    stats: overrides.empty ? null : sampleStats('today'),
    loadedAt: overrides.empty ? null : LOADED_AT,
    error: overrides.error ?? '',
    quota: overrides.quota ?? quota(6),
    theme: 'dark',
  });
}

function renderCard(layout: WidgetLayout, cardModel: CardModel = model(), extra: Partial<Parameters<typeof LedgerCard>[0]> = {}) {
  return render(<LedgerCard layout={layout} model={cardModel} now={NOW} {...extra} />);
}

/** 胶囊的可见文字（读屏句另放在 sr-only 里）。 */
function chipText(container: HTMLElement): string | undefined {
  return container.querySelector('.wl-chip [aria-hidden="true"]')?.textContent ?? undefined;
}

describe('圆环几何与档位', () => {
  it('线宽取尺寸的 10%（至少 3px），弧长 = 可用比例 × 周长', () => {
    const mini = ringGeometry(44, 50);
    expect(mini).toMatchObject({ size: 44, stroke: 4, radius: 20 });
    expect(mini.circumference).toBeCloseTo(2 * Math.PI * 20);
    expect(mini.arc).toBeCloseTo(mini.circumference / 2);
    expect(ringGeometry(92, 100)).toMatchObject({ stroke: 9, radius: 41.5 });
    expect(ringGeometry(92, 100).arc).toBeCloseTo(ringGeometry(92, 100).circumference);
    expect(ringGeometry(64, 14)).toMatchObject({ stroke: 6, radius: 29 });
    expect(ringGeometry(64, 14).arc).toBeCloseTo(0.14 * 2 * Math.PI * 29);
  });

  it('比例夹回 0–100，读不出的数不画弧', () => {
    expect(ringGeometry(44, -10).arc).toBe(0);
    expect(ringGeometry(44, 150).arc).toBeCloseTo(ringGeometry(44, 100).circumference);
    expect(ringGeometry(44, Number.NaN).arc).toBe(0);
  });

  it('环按档位上色、数字不上色；可用 0% 与没有读数时只画轨道，没有读数写「—」', () => {
    const { container, rerender } = render(<LedgerRing size={64} available={36} level="warn" />);
    const ring = container.querySelector('.wl-ring')!;
    expect(ring).toHaveAttribute('data-level', 'warn');
    expect(ring).toHaveAttribute('aria-hidden', 'true');
    expect(ring.querySelector('.wl-ring-arc')).toHaveAttribute('stroke-dasharray', `${(0.36 * 2 * Math.PI * 29).toFixed(2)} ${(2 * Math.PI * 29).toFixed(2)}`);
    expect(ring.querySelector('.wl-ring-num')).toHaveTextContent('36%');
    expect(ring.querySelector('.wl-ring-num')?.getAttribute('style')).toBeNull();
    rerender(<LedgerRing size={64} available={0} level="critical" />);
    expect(container.querySelector('.wl-ring-arc')).toBeNull();
    expect(container.querySelector('.wl-ring-num')).toHaveTextContent('0%');
    rerender(<LedgerRing size={44} available={null} level={null} />);
    expect(container.querySelector('.wl-ring-arc')).toBeNull();
    expect(container.querySelector('.wl-ring-num')?.textContent).toBe('—');
    expect(container.querySelector('.wl-ring')).toHaveAttribute('data-level', 'none');
    rerender(<LedgerRing size={92} available={60} level="ok" stale sub="可用" />);
    expect(container.querySelector('.wl-ring')).toHaveAttribute('data-stale', 'true');
    expect(container.querySelector('.wl-ring-sub')).toHaveTextContent('可用');
  });
});

describe('用量详情 364×388', () => {
  it('标题行、大数字与较昨日同期、预估费用与记录数、走势、三列、工具构成、两枚迷你圆环', () => {
    const { container } = renderCard('usage');
    expect(screen.getByText('今日 · 有效 Token')).toBeInTheDocument();
    expect(container.querySelector('.wl-title .wl-meta')?.textContent).toMatch(/^更新于 /);
    expect(container.querySelector('.wl-hero-num')).toHaveTextContent('1.39M');
    expect(chipText(container)).toBe('−6.9% 较昨日同期');
    expect(screen.getByText('有效 Token较昨日同期减少 6.9%，绝对变化 −103.0K')).toHaveClass('sr-only');
    expect(container.querySelector('.wl-hero-cost')).toHaveTextContent('≈$18.04');
    expect(screen.getByText('记录数 3,148')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^今日有效 Token 走势：实线为今日，虚线为昨日同期；峰值 10:00 306\.0K$/ })).toBeInTheDocument();
    expect([...container.querySelectorAll('.wl-kv dt')].map((node) => node.textContent)).toEqual(['输入', '输出', '缓存（单列）']);
    const legend = screen.getByRole('list', { name: '工具构成（有效 Token 份额）' });
    expect(within(legend).getAllByRole('listitem').map((node) => node.textContent?.replace(/\s+/g, ' '))).toEqual([
      'Codex 44%', 'Claude 31%', 'Antigravity 15%', '其他 10%',
    ]);
    const minis = screen.getByRole('list', { name: '最紧的额度窗口' });
    const items = within(minis).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.querySelector('.sr-only')?.textContent)).toEqual([
      'Claude · 5 小时，可用 14%，告急，38 分钟后重置',
      'Codex · 每周，可用 36%，偏紧，2 天 23 小时后重置',
    ]);
    expect(container.querySelectorAll('.wl-ring[data-size="44"]')).toHaveLength(2);
    expect(within(items[0]).getByText('告急')).toHaveAttribute('data-level', 'critical');
    // 桌面小组件与设置页预览：平时没有任何按钮。
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('读屏顺序即视觉顺序：标题 → 更新于 → 大数字 → 胶囊 → 费用 → 记录数 → 走势 → 三列 → 构成 → 圆环', () => {
    const { container } = renderCard('usage');
    const text = container.textContent ?? '';
    const order = ['今日 · 有效 Token', '更新于', '1.39M', '−6.9% 较昨日同期', '预估费用', '≈$18.04', '记录数', '输入', '缓存（单列）', 'Codex', '其他', 'Claude · 5 小时，可用 14%'];
    const positions = order.map((part) => text.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // 走势（svg）夹在记录数与三列之间。
    const blocks = [...container.querySelector('.wl-card')!.children].map((node) => node.className);
    expect(blocks.indexOf('wl-trend')).toBeGreaterThan(blocks.indexOf('wl-hero'));
    expect(blocks.indexOf('wl-trend')).toBeLessThan(blocks.indexOf('wl-kv'));
  });

  it('额度还在读、没有额度、钉住的来源读不到、整次读取失败：各写一句，按钮只在托盘挂件给（失败态没有按钮）', () => {
    const { container, rerender } = renderCard('usage', model({ quota: { kind: 'loading' } }));
    expect(screen.getByRole('status')).toHaveTextContent('正在读取额度…');
    const actions = { openSettings: vi.fn(), openMain: vi.fn() };
    rerender(<LedgerCard layout="usage" model={model({ quota: { kind: 'empty' } })} now={NOW} noticeActions={actions} />);
    expect(screen.getByText('还没有可展示的订阅额度。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '去主窗口授权来源' }));
    expect(actions.openMain).toHaveBeenCalledTimes(1);
    rerender(<LedgerCard layout="usage" model={model({ quota: { kind: 'pinned-missing', name: 'Claude' } })} now={NOW} noticeActions={actions} />);
    expect(screen.getByText('已钉住「Claude」，它现在没有可读的额度窗口。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '去设置换来源' }));
    expect(actions.openSettings).toHaveBeenCalledTimes(1);
    rerender(<LedgerCard layout="usage" model={model({ quota: { kind: 'pinned-missing', name: 'Claude' } })} now={NOW} noticeActions={null} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // 整次读取失败（P2-1）：虚线空槽 + 「不可用」，不是「没有来源」的文案，也不给「去授权」按钮。
    rerender(<LedgerCard layout="usage" model={model({ quota: { kind: 'failed' } })} now={NOW} noticeActions={actions} />);
    expect(screen.getByText('额度读取失败，不可用。')).toBeInTheDocument();
    expect(screen.queryByText('还没有可展示的订阅额度。')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.querySelector('.wl-ring[data-unavailable="true"]')).not.toBeNull();
  });

  it('历史快照的圆环写「待刷新」，不给已经过去的倒计时', () => {
    const stale = quota(2);
    if (stale.kind !== 'ready') throw new Error('expected ready');
    stale.items[0] = { ...stale.items[0], stale: true, observedAt: new Date(2026, 6, 15, 13, 50).toISOString() };
    const { container } = renderCard('usage', model({ quota: stale }));
    expect(container.querySelector('.wl-ring[data-stale="true"]')).not.toBeNull();
    expect(screen.getByText('Claude · 5 小时，可用 14%，告急，待刷新，观测于 7/15 13:50')).toHaveClass('sr-only');
    expect(container.querySelector('.wl-mini .wl-st')?.textContent).toBe('告急 · 待刷新');
  });
});

describe('额度与用量 364×172', () => {
  it('左边 92px 圆环画最紧的窗口，右边有效 Token、短胶囊、预估费用与「更新于 · 另有 N 个窗口」', () => {
    const { container } = renderCard('combo');
    expect(container.querySelectorAll('.wl-ring')).toHaveLength(1);
    expect(container.querySelector('.wl-ring')).toHaveAttribute('data-size', '92');
    expect(container.querySelector('.wl-ring-sub')).toHaveTextContent('可用');
    expect(container.querySelector('.wl-combo-ring .sr-only')).toHaveTextContent('Claude · 5 小时，可用 14%，告急，38 分钟后重置');
    expect(container.querySelector('.wl-combo-ring .wl-who')?.textContent?.replace(/\s+/g, ' ')).toBe('Claude · 5 小时');
    expect(container.querySelector('.wl-combo-num')).toHaveTextContent('1.39M');
    // 窄栏里胶囊只写百分比，口径在读屏句里。
    expect(chipText(container)).toBe('−6.9%');
    expect(container.querySelector('.wl-combo-cost')).toHaveTextContent('≈$18.04');
    const meta = container.querySelector('.wl-combo-meta')!;
    expect(meta.textContent).toMatch(/^更新于 .* · 另有 5 个窗口，换「额度总览」板式可看全部$/);
    expect(within(meta as HTMLElement).getByText('，换「额度总览」板式可看全部')).toHaveClass('sr-only');
  });

  it('看全的提示不只放在 title 里（R-52 P3-1）：超过 6 个窗口时指向主窗口的额度看板', () => {
    const { container } = renderCard('combo', model({ quota: quota(8) }));
    expect(container.querySelector('.wl-combo-meta')?.textContent).toMatch(/ · 另有 7 个窗口，主窗口的额度看板可看全部$/);
    expect(container.querySelector('[title*="看全"]')).toBeNull();
  });

  it('只有一个窗口时不写「另有」', () => {
    const { container } = renderCard('combo', model({ quota: quota(1) }));
    expect(container.querySelector('.wl-combo-meta')?.textContent).not.toContain('另有');
  });
});

describe('额度总览 364×272', () => {
  it('最多 6 个 64px 圆环，标题行写窗口总数，多出的写「+N」并给读屏说去哪看全', () => {
    const { container } = renderCard('quota', model({ quota: quota(8) }));
    const list = screen.getByRole('list', { name: '额度窗口，按吃紧程度' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    expect(container.querySelectorAll('.wl-ring[data-size="64"]')).toHaveLength(6);
    const meta = container.querySelector('.wl-title .wl-meta')!;
    expect(meta.textContent).toMatch(/^8 个窗口 · \+2（另有 2 个未显示，主窗口的额度看板可看全部） · 更新于 /);
    expect(within(meta as HTMLElement).getByText('（另有 2 个未显示，主窗口的额度看板可看全部）')).toHaveClass('sr-only');
    expect(container.querySelector('[title*="看全"]')).toBeNull();
  });

  it('不超过 6 个时不写「+N」；每格写来源、分组 窗口与档位字，读屏读整句', () => {
    const { container } = renderCard('quota');
    expect(container.querySelector('.wl-title .wl-meta')?.textContent).toMatch(/^6 个窗口 · 更新于 /);
    const cells = [...container.querySelectorAll('.wl-cell')];
    expect(cells).toHaveLength(6);
    expect(cells[2].querySelector('.wl-who')?.textContent).toBe('Antigravity');
    expect(cells[2].querySelector('.wl-st')?.textContent?.replace(/\s+/g, ' ')).toBe('Claude / GPT 每周 · 充足');
    expect(cells[2].querySelector('.sr-only')?.textContent).toBe('Antigravity · Claude / GPT 每周，可用 55%，充足，2 天 23 小时后重置');
    expect(cells.map((cell) => cell.querySelector('.wl-ring')?.getAttribute('data-level'))).toEqual(['critical', 'warn', 'ok', 'ok', 'ok', 'ok']);
  });

  it('没有额度时整块写提示，不画空圆环', () => {
    const { container } = renderCard('quota', model({ quota: { kind: 'empty' } }));
    expect(container.querySelector('.wl-ring')).toBeNull();
    expect(screen.getByText('还没有可展示的订阅额度。')).toBeInTheDocument();
  });

  it('读取中 / 没有来源 / 钉住读不到 / 整次读取失败：标题行都不写「个窗口」（P3-8，未知不画 0）', () => {
    const { container, rerender } = renderCard('quota', model({ quota: { kind: 'loading' } }));
    const titleText = () => container.querySelector('.wl-title .wl-meta')?.textContent ?? '';
    expect(titleText()).not.toContain('个窗口');
    rerender(<LedgerCard layout="quota" model={model({ quota: { kind: 'empty' } })} now={NOW} />);
    expect(titleText()).not.toContain('个窗口');
    rerender(<LedgerCard layout="quota" model={model({ quota: { kind: 'pinned-missing', name: 'Claude' } })} now={NOW} />);
    expect(titleText()).not.toContain('个窗口');
    rerender(<LedgerCard layout="quota" model={model({ quota: { kind: 'failed' } })} now={NOW} />);
    expect(titleText()).not.toContain('个窗口');
    expect(screen.getByText('额度读取失败，不可用。')).toBeInTheDocument();
    expect(container.querySelector('.wl-ring[data-unavailable="true"]')).not.toBeNull();
  });
});

describe('单行消耗 364×104', () => {
  it('只有有效 Token + 短胶囊与预估费用；没有走势、构成与圆环', () => {
    const { container } = renderCard('compact');
    expect(container.querySelector('.wl-compact-num')).toHaveTextContent('1.39M');
    expect(chipText(container)).toBe('−6.9%');
    expect(container.querySelector('.wl-compact-side .wl-cap')).toHaveTextContent('预估费用');
    expect(container.querySelector('.wl-compact-cost')).toHaveTextContent('≈$18.04');
    expect(container.querySelector('.wl-ring, .wl-trend, .wl-legend, .wl-kv')).toBeNull();
    // 正常的「更新于」只给读屏。
    expect(container.querySelector('.wl-compact-main > .sr-only')?.textContent).toMatch(/^更新于 /);
    expect(container.querySelector('.wl-compact-main > .wl-meta')).toBeNull();
  });

  it('读取失败写出来并播报', () => {
    renderCard('compact', model({ error: '读取失败：数据库忙' }));
    expect(screen.getByRole('alert')).toHaveTextContent('失败 · 旧快照');
    expect(screen.getByRole('alert').querySelector('.sr-only')).toHaveTextContent('上次成功读取时间');
    expect(screen.getByRole('alert')).not.toHaveTextContent('数据库忙');
  });
});

describe('未知值（GLB-01）', () => {
  it.each(['usage', 'combo', 'quota', 'compact'] as const)('「%s」还没有统计时写「—」，不画 $0 或 0%%', (layout) => {
    const { container } = renderCard(layout, model({ empty: true, quota: { kind: 'loading' } }));
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\$0|(^|[^\d.])0%/);
    if (layout !== 'quota') expect(text).toContain('—');
    expect(text).toContain(layout === 'compact' ? '正在读取…' : '正在读取');
  });

  it('费用读不出写「不可得」', () => {
    const stats = sampleStats('today');
    const cardModel = buildCardModel({
      range: 'today', stats: { ...stats, summary: { ...stats.summary, totalCost: Number.NaN } },
      loadedAt: LOADED_AT, error: '', quota: quota(1), theme: 'dark',
    });
    const { container } = renderCard('usage', cardModel);
    expect(container.querySelector('.wl-hero-cost')).toHaveTextContent('不可得');
    expect(container.textContent).not.toContain('$0');
  });
});
