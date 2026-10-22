import type { ReactNode } from 'react';
import type { WidgetLayout } from '../../utils/widgetConfig';
import type { MetricChange } from '../MetricsGrid';
import {
  QUOTA_OVERVIEW_LIMIT,
  TIER_WORDS,
  describeQuotaItem,
  hiddenQuotaHint,
  quotaStateTail,
  type CardModel,
  type CardQuota,
  type CardQuotaItem,
  type CardStatus,
} from './cardModel';
import { LedgerRing } from './LedgerRing';
import { ToolComposition } from './ToolComposition';
import { TrendSpark } from './TrendSpark';

/**
 * 「账本圆环」卡片的四种板式（T10.192，方案 §6.4）。尺寸与内容：
 * - 用量详情 364×388：标题行；44px 大数字 + 较昨日同期胶囊，右侧预估费用与记录数；74px 走势；
 *   输入 / 输出 / 缓存（单列）；8px 工具构成条 + 图例；两枚 44px 迷你圆环（最紧两个窗口）。
 * - 额度与用量 364×172：左 92px 圆环（最紧窗口）；右有效 Token + 胶囊、预估费用、「更新于 · 另有 N 个窗口」。
 * - 额度总览 364×272：2 行 × 3 个 64px 圆环，标题行写窗口总数，超过 6 个写「+N」。
 * - 单行消耗 364×104：有效 Token + 胶囊 │ 预估费用。
 * 托盘挂件在卡片上方多一条 26px 的顶栏（`WidgetChrome`），卡片本身不变。
 * DOM 顺序即视觉顺序（读屏按看到的顺序读）；桌面悬停工具条插在它要盖住的那一行后面。
 */

export interface QuotaNoticeActions {
  openSettings: () => void;
  openMain: () => void;
}

interface LedgerCardProps {
  layout: WidgetLayout;
  model: CardModel;
  now: number;
  /** 额度提示里的按钮：只有托盘挂件给；桌面小组件平时不显示任何按钮，设置页预览是静态的。 */
  noticeActions?: QuotaNoticeActions | null;
  /** 桌面小组件的悬停工具条。 */
  toolbar?: ReactNode;
}

function Status({ status, className = '' }: { status: CardStatus; className?: string }) {
  if (status.error) {
    return (
      <span className={`wl-meta is-error ${className}`} role="alert" title={status.description ?? status.text}>
        <span aria-hidden={status.description ? true : undefined}>{status.text}</span>
        {status.description && <span className="sr-only">{status.description}</span>}
      </span>
    );
  }
  return <span className={`wl-meta ${className}`}>{status.text}</span>;
}

/** 较上期同期胶囊：中性色，不用红绿表达好坏；读屏读完整句子（与看板 KPI 同一个 description）。 */
function ChangeChip({ change, short = false }: { change: MetricChange | null; short?: boolean }) {
  if (!change) return null;
  return (
    <span className="wl-chip" data-direction={change.direction ?? 'none'}>
      <span aria-hidden="true">{short ? change.headline : `${change.headline} ${change.period}`}</span>
      <span className="sr-only">{change.description}</span>
    </span>
  );
}

function TierWord({ item }: { item: CardQuotaItem }) {
  return <span className="wl-tier" data-level={item.level}>{TIER_WORDS[item.level]}</span>;
}

/**
 * 窗口名：「来源 · 分组 窗口」或「分组 窗口」。窄格子里只截前半（来源与分组），
 * 窗口短名永远写全——同一来源的两个「每周」靠它分开。
 */
function WindowName({ item, withProvider }: { item: CardQuotaItem; withProvider: boolean }) {
  const head = withProvider ? `${item.provider}${item.group ? ` · ${item.group}` : ''}` : item.group;
  const tail = head ? `${withProvider && !item.group ? ' · ' : ' '}${item.label}` : item.label;
  return (
    <span className="wl-wname">
      {head && <span className="wl-wname-head">{head}</span>}
      <span className="wl-wname-tail">{tail}</span>
    </span>
  );
}

function QuotaNotice({ quota, actions, ringSize }: {
  quota: Exclude<CardQuota, { kind: 'ready' }>;
  actions?: QuotaNoticeActions | null;
  /** 只有「读取失败」用得到：虚线空槽按所在板式平时画的环尺寸给，其余状态不画环（P2-1）。 */
  ringSize: 44 | 64 | 92;
}) {
  if (quota.kind === 'loading') {
    return <div className="wl-notice" role="status"><span>正在读取额度…</span></div>;
  }
  if (quota.kind === 'failed') {
    // 整次读取失败：虚线空槽 + 「不可用」，与「没有来源」分开，不给「去授权」按钮
    // （P2-1，方案 §5、DESIGN §6.4）。环心仍写「—」，「不可用」写在环外，与其余状态词同一位置。
    return (
      <div className="wl-notice">
        <LedgerRing size={ringSize} available={null} level={null} unavailable />
        <span>额度读取失败，不可用。</span>
      </div>
    );
  }
  if (quota.kind === 'pinned-missing') {
    return (
      <div className="wl-notice">
        <span>已钉住「{quota.name}」，它现在没有可读的额度窗口。</span>
        {actions && <button type="button" className="wl-link" onClick={actions.openSettings}>去设置换来源</button>}
      </div>
    );
  }
  return (
    <div className="wl-notice">
      <span>还没有可展示的订阅额度。</span>
      {actions && <button type="button" className="wl-link" onClick={actions.openMain}>去主窗口授权来源</button>}
    </div>
  );
}

// ── 用量详情 ──────────────────────────────────────────────────────────────────

function MiniRing({ item, now }: { item: CardQuotaItem; now: number }) {
  const tail = quotaStateTail(item, now);
  return (
    <li className="wl-mini">
      <span className="sr-only">{describeQuotaItem(item, now)}</span>
      <LedgerRing size={44} available={item.available} level={item.level} stale={item.stale} />
      <span className="wl-mini-text" aria-hidden="true">
        <span className="wl-who">{`${item.provider} · ${item.window}`}</span>
        <span className="wl-st"><TierWord item={item} />{tail && ` · ${tail}`}</span>
      </span>
    </li>
  );
}

function UsageLayout({ model, now, noticeActions, toolbar }: Omit<LedgerCardProps, 'layout'>) {
  const quota = model.quota;
  return (
    <>
      <div className="wl-row wl-title">
        <span className="wl-cap">{model.rangeLabel} · 有效 Token</span>
        <Status status={model.status} className="wl-under-toolbar" />
      </div>
      {toolbar}
      <div className="wl-hero">
        <div className="wl-hero-main">
          <span className="wl-num wl-hero-num">{model.tokens}</span>
          <ChangeChip change={model.change} />
        </div>
        <div className="wl-hero-side">
          <span className="wl-meta">预估费用</span>
          <span className="wl-num wl-hero-cost">{model.cost}</span>
          <span className="wl-meta">记录数 {model.records}</span>
        </div>
      </div>
      <TrendSpark trend={model.trend} rangeLabel={model.rangeLabel} loading={model.loading} />
      <dl className="wl-kv">
        <div><dt>输入</dt><dd>{model.input}</dd></div>
        <div><dt>输出</dt><dd>{model.output}</dd></div>
        <div><dt>缓存（单列）</dt><dd>{model.cache}</dd></div>
      </dl>
      <ToolComposition tools={model.tools} loading={model.loading} />
      <hr className="wl-hr" />
      {quota.kind === 'ready' ? (
        <ul className="wl-minis" aria-label="最紧的额度窗口">
          {quota.items.slice(0, 2).map((item) => <MiniRing key={item.key} item={item} now={now} />)}
        </ul>
      ) : (
        <div className="wl-minis is-notice"><QuotaNotice quota={quota} actions={noticeActions} ringSize={44} /></div>
      )}
    </>
  );
}

// ── 额度与用量 ────────────────────────────────────────────────────────────────

function ComboLayout({ model, now, noticeActions, toolbar }: Omit<LedgerCardProps, 'layout'>) {
  const quota = model.quota;
  const top = quota.kind === 'ready' ? quota.items[0] : null;
  const hidden = quota.kind === 'ready' ? quota.items.length - 1 : 0;
  const tail = top ? quotaStateTail(top, now) : null;
  return (
    <>
      <div className="wl-combo-ring">
        {top ? (
          <>
            <span className="sr-only">{describeQuotaItem(top, now)}</span>
            <LedgerRing size={92} available={top.available} level={top.level} stale={top.stale} sub="可用" />
            <span className="wl-who" aria-hidden="true"><WindowName item={top} withProvider /></span>
            <span className="wl-st" aria-hidden="true"><TierWord item={top} />{tail && ` · ${tail}`}</span>
          </>
        ) : (
          <QuotaNotice quota={quota as Exclude<CardQuota, { kind: 'ready' }>} actions={noticeActions} ringSize={92} />
        )}
      </div>
      <span className="wl-vr" aria-hidden="true" />
      <div className="wl-combo-main">
        <div>
          <span className="wl-cap">{model.rangeLabel} · 有效 Token</span>
          <div className="wl-num-row">
            <span className="wl-num wl-combo-num">{model.tokens}</span>
            <ChangeChip change={model.change} short />
          </div>
        </div>
        <hr className="wl-hr" />
        <div>
          <span className="wl-cap">预估费用</span>
          <span className="wl-num wl-combo-cost">{model.cost}</span>
        </div>
        <p className="wl-meta wl-combo-meta wl-under-toolbar">
          <Status status={model.status} />
          {hidden > 0 && (
            <>
              {` · 另有 ${hidden} 个窗口`}
              <span className="sr-only">{`，${hiddenQuotaHint(hidden + 1)}`}</span>
            </>
          )}
        </p>
        {toolbar}
      </div>
    </>
  );
}

// ── 额度总览 ──────────────────────────────────────────────────────────────────

function QuotaCell({ item, now }: { item: CardQuotaItem; now: number }) {
  return (
    <li className="wl-cell">
      <span className="sr-only">{describeQuotaItem(item, now)}</span>
      <LedgerRing size={64} available={item.available} level={item.level} stale={item.stale} />
      <span className="wl-who" aria-hidden="true">{item.provider}</span>
      <span className="wl-st" aria-hidden="true">
        <WindowName item={item} withProvider={false} />
        <span className="wl-st-tier">{' · '}<TierWord item={item} /></span>
      </span>
    </li>
  );
}

function QuotaLayout({ model, now, noticeActions, toolbar }: Omit<LedgerCardProps, 'layout'>) {
  const quota = model.quota;
  const items = quota.kind === 'ready' ? quota.items : [];
  const shown = items.slice(0, QUOTA_OVERVIEW_LIMIT);
  const more = items.length - shown.length;
  return (
    <>
      <div className="wl-row wl-title">
        <span className="wl-cap">额度 · 按吃紧程度</span>
        <span className="wl-meta wl-under-toolbar">
          {quota.kind === 'ready' && (
            <>
              {`${items.length} 个窗口`}
              {more > 0 && (
                <>
                  {` · +${more}`}
                  <span className="sr-only">{`（另有 ${more} 个未显示，${hiddenQuotaHint(items.length)}）`}</span>
                </>
              )}
              {' · '}
            </>
          )}
          <Status status={model.status} />
        </span>
      </div>
      {toolbar}
      {quota.kind === 'ready' ? (
        <ul className="wl-quota-grid" aria-label="额度窗口，按吃紧程度">
          {shown.map((item) => <QuotaCell key={item.key} item={item} now={now} />)}
        </ul>
      ) : (
        <div className="wl-quota-grid is-notice"><QuotaNotice quota={quota} actions={noticeActions} ringSize={64} /></div>
      )}
    </>
  );
}

// ── 单行消耗 ──────────────────────────────────────────────────────────────────

function CompactLayout({ model, toolbar }: Omit<LedgerCardProps, 'layout'>) {
  return (
    <>
      <div className="wl-compact-main">
        <span className="wl-cap">{model.rangeLabel} · 有效 Token</span>
        <div className="wl-num-row">
          <span className="wl-num wl-compact-num">{model.tokens}</span>
          <ChangeChip change={model.change} short />
        </div>
        {/* 视觉稿里这块没有「更新于」：正常时只给读屏，读取中、历史快照与失败才写出来。 */}
        {model.status.notable ? <Status status={model.status} /> : <span className="sr-only">{model.status.text}</span>}
      </div>
      <span className="wl-vr" aria-hidden="true" />
      <div className="wl-compact-side">
        <span className="wl-cap wl-under-toolbar">预估费用</span>
        {toolbar}
        <span className="wl-num wl-compact-cost">{model.cost}</span>
      </div>
    </>
  );
}

export function LedgerCard({ layout, ...props }: LedgerCardProps) {
  return (
    <div className="wl-card" data-layout={layout}>
      {layout === 'combo' ? <ComboLayout {...props} />
        : layout === 'quota' ? <QuotaLayout {...props} />
          : layout === 'compact' ? <CompactLayout {...props} />
            : <UsageLayout {...props} />}
    </div>
  );
}
