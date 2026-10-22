import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import completeFixture from '../../fixtures/quota-provider-v1/complete-v1.json';
import companyFixture from '../../fixtures/quota-provider-v1/custom-openapi-v1.json';
import currencyFixture from '../../fixtures/quota-provider-v1/currency-v1.json';
import type { QuotaProviderEnvelope, QuotaSyncStatus } from '../types';
import { ProviderEmpty, QuotaPanel, formatQuotaCurrencyAmount, groupQuotaWindows, quotaWindowDisplayLabel } from './QuotaPanel';

const CLAUDE_PROVIDER: QuotaProviderEnvelope = {
  schemaVersion: 1,
  providerId: 'anthropic-claude-consumer',
  displayName: 'Anthropic Claude',
  scope: 'consumer-subscription',
  mode: 'automatic',
  capability: 'plan-dependent',
  status: 'auth-required',
  windows: [],
  reasonCode: 'claude_statusline_snapshot_missing',
  action: { kind: 'show-command', labelKey: 'quota.action.showClaudeUsage', value: '/usage' },
};

const DISABLED_SYNC: QuotaSyncStatus = { enabled: false, state: 'disabled' };

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  window.localStorage.clear();
});

describe('QuotaPanel continuous quota list', () => {
  it('将独立的英文周期名直接本地化，不把数字误作账户前缀', () => {
    expect(quotaWindowDisplayLabel({windowId:'seven-day',windowLabel:'7-day',windowMinutes:10080,unit:'percent'})).toBe('每周额度');
    expect(quotaWindowDisplayLabel({windowId:'five-hour',windowLabel:'5-hour',windowMinutes:300,unit:'percent'})).toBe('5 小时额度');
    expect(quotaWindowDisplayLabel({windowId:'seven-day',windowLabel:'团队账号 · 7-day',windowMinutes:10080,unit:'percent'})).toBe('团队账号 · 每周额度');
  });
  const now = Date.now();
  const percentWindow = (
    providerId: string,
    windowId: string,
    windowLabel: string,
    used: number,
    resetOffsetMs: number,
  ) => ({
    providerId,
    windowId,
    windowLabel,
    scope: 'consumer-subscription' as const,
    source: 'local-authorized' as const,
    status: 'ok' as const,
    used,
    limit: 100,
    remaining: 100 - used,
    unit: 'percent' as const,
    windowMinutes: 300,
    resetsAt: new Date(now + resetOffsetMs).toISOString(),
    observedAt: new Date(now - 30_000).toISOString(),
    fetchedAt: new Date(now - 30_000).toISOString(),
    staleAfterSeconds: 900,
  });
  const CODEX: QuotaProviderEnvelope = {
    schemaVersion: 1,
    providerId: 'openai-codex-local',
    displayName: 'OpenAI Codex',
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: 'stable',
    status: 'ok',
    windows: [
      percentWindow('openai-codex-local', 'codex:primary', '5 小时窗口', 38, 7_200_000),
      percentWindow('openai-codex-local', 'codex:secondary', '周窗口', 64, 259_200_000),
    ],
  };
  const CLAUDE_OK: QuotaProviderEnvelope = {
    ...CLAUDE_PROVIDER,
    status: 'ok',
    reasonCode: undefined,
    action: undefined,
    windows: [percentWindow('anthropic-claude-consumer', 'five-hour', '5 小时窗口', 82, 5_400_000)],
  };

  it('遗留环形偏好不影响连续窗口列表，也不恢复英雄摘要或显示切换', () => {
    window.localStorage.setItem('tokenledger:quota-view-mode', 'rings');
    render(<QuotaPanel providers={[CODEX]} loading={false} error="" quotaSyncStatus={DISABLED_SYNC}
      onRefresh={vi.fn()} onSyncNow={vi.fn()} onOpenSettings={vi.fn()} onNotify={vi.fn()} />);

    expect(screen.queryByRole('group', { name: '最紧额度摘要' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '额度显示方式' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '条形' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '环形' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.quota-ring')).toHaveLength(0);
    expect(screen.getAllByRole('progressbar')).toHaveLength(CODEX.windows.length);
  });

  it('同账户周期固定排序且余额独立，不把多窗口铺成不规则网格', () => {
    const named = (id: string, minutes: number) => ({...CODEX.windows[0], windowId: id,
      windowLabel: `团队账户 · ${minutes === 300 ? '5-hour' : '7-day'}`, windowMinutes: minutes});
    render(<QuotaPanel providers={[{...CODEX, windows:[named('team:week',10080),
      {...CODEX.windows[0], windowId:'credits', windowLabel:'Credits', unit:'credits', used:undefined,
       limit:undefined, remaining:0, windowMinutes:undefined},
      named('team:short',300), CODEX.windows[0]]}]} loading={false} error="" quotaSyncStatus={DISABLED_SYNC}
      onRefresh={vi.fn()} onSyncNow={vi.fn()} onOpenSettings={vi.fn()} onNotify={vi.fn()} />);
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(2);
    const team = cards.find(card => card.textContent?.includes('团队账户'))!;
    expect(within(team).getAllByText('团队账户')).toHaveLength(1);
    expect([...team.querySelectorAll('.quota-window-head strong')].map(el=>el.textContent)).toEqual(['5 小时','每周']);
    expect(within(team).getAllByRole('progressbar')).toHaveLength(2);
    const credit = screen.getByText('0 额度点').closest('.quota-window-gauge')!;
    expect(credit).toHaveAttribute('data-value-kind', 'absolute');
    expect(within(credit as HTMLElement).queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('账户标签不作为窗口身份，分组后保留同周期的独立窗口和未知名称', () => {
    const raw = [
      {...CODEX.windows[0], accountLabel:'甲', windowId:'b', used:10,remaining:90},
      {...CODEX.windows[0], accountLabel:'乙', windowId:'c'},
      {...CODEX.windows[0], accountLabel:'甲', windowId:'a',used:50,remaining:50},
      {...CODEX.windows[0], windowId:'custom', windowMinutes:undefined,windowLabel:'实验 · 推广额度'},
    ];
    const groups=groupQuotaWindows(raw);
    expect(groups.flatMap(group=>group.windows)).toHaveLength(4);
    expect(groups.find(group=>group.label==='甲')?.windows.map(window=>window.windowId)).toEqual(['a','b']);
    expect(groups.find(group=>group.label==='乙')?.windows).toHaveLength(1);
    expect(groups.find(group=>group.label==='')?.windows[0].windowLabel).toBe('实验 · 推广额度');
    render(<QuotaPanel providers={[{...CODEX,windows:[raw[3]]}]} loading={false} error="" quotaSyncStatus={DISABLED_SYNC}
      onRefresh={vi.fn()} onSyncNow={vi.fn()} onOpenSettings={vi.fn()} onNotify={vi.fn()} />);
    expect(screen.getByRole('article').querySelector('.quota-window-head strong')).toHaveTextContent('实验 · 推广额度');
  });

  it('连续列表共用校验：余额和不限额无进度，公司非法数值不显示百分比', () => {
    const codex=structuredClone(completeFixture.providers[0]) as QuotaProviderEnvelope;
    const company=structuredClone(companyFixture.providers[0]) as QuotaProviderEnvelope;
    company.windows.find(window=>window.windowId==='user-daily')!.remaining=999;
    render(<QuotaPanel providers={[codex,company]} loading={false} error="" quotaSyncStatus={DISABLED_SYNC}
      onRefresh={vi.fn()} onSyncNow={vi.fn()} onOpenSettings={vi.fn()} onNotify={vi.fn()} />);
    const codexCard=screen.getByRole('article',{name:'Codex'});
    expect(within(codexCard).getAllByRole('progressbar')).toHaveLength(2);
    expect(within(codexCard).getByText('12.5 额度点')).toBeVisible();
    expect(within(codexCard).getByText('额外用量不限额')).toBeVisible();
    const companyCard=screen.getByRole('article',{name:'研发账号额度'});
    expect(within(companyCard).getAllByRole('progressbar')).toHaveLength(1);
    expect(companyCard).toHaveTextContent('不可用');
    expect(companyCard).not.toHaveTextContent('999');
    expect(companyCard).not.toHaveTextContent('API Key');
  });

  it('货币余额与设置页同规则：五种常见币种用符号、其余照写 ISO 代码，不画进度', () => {
    const providers=structuredClone(currencyFixture.validProviders) as QuotaProviderEnvelope[];
    render(<QuotaPanel providers={providers} loading={false} error="" quotaSyncStatus={DISABLED_SYNC}
      onRefresh={vi.fn()} onSyncNow={vi.fn()} onOpenSettings={vi.fn()} onNotify={vi.fn()} />);
    const cny=screen.getByText('¥12.50').closest('.quota-window-gauge')!;
    expect(cny).toHaveAttribute('data-value-kind', 'absolute');
    expect(within(cny as HTMLElement).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('$3.20')).toBeVisible();
    expect(screen.getByText('7.00 XTS')).toBeVisible();
    expect(document.body).not.toHaveTextContent('12.5 CNY');
  });

  it('币种格式化与 Android 共用一张符号表', () => {
    expect(formatQuotaCurrencyAmount(1234.5, 'CNY')).toBe('¥1,234.50');
    expect(formatQuotaCurrencyAmount(5, 'USD')).toBe('$5.00');
    expect(formatQuotaCurrencyAmount(7, 'EUR')).toBe('€7.00');
    expect(formatQuotaCurrencyAmount(0.5, 'GBP')).toBe('£0.50');
    expect(formatQuotaCurrencyAmount(1200, 'JPY')).toBe('JP¥1,200');
    expect(formatQuotaCurrencyAmount(8, 'HKD')).toBe('8.00 HKD');
  });

  it('历史原因默认收纳到可展开详情，主视图保留历史标记和真实数值', () => {
    render(<QuotaPanel providers={[{...CLAUDE_OK,status:'stale',windows:[{...CLAUDE_OK.windows[0],
      status:'stale',reasonCode:'observation_stale'}]}]} loading={false} error="" quotaSyncStatus={DISABLED_SYNC}
      onRefresh={vi.fn()} onSyncNow={vi.fn()} onOpenSettings={vi.fn()} onNotify={vi.fn()} />);
    const card=screen.getByRole('article');
    expect(within(card).getByText('历史数据')).toBeVisible();
    const reason=within(card).getByText(/当前数据源暂未刷新/);
    const details=reason.closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow','18');
    expect(details).toHaveTextContent('观测');
    expect(details).toHaveTextContent('读取');
  });

  it('不再浓缩最紧额度：每个来源窗口都留在连续列表中', () => {
    render(
      <QuotaPanel
        providers={[CODEX, CLAUDE_OK]}
        loading={false}
        error=""
        quotaSyncStatus={DISABLED_SYNC}
        onRefresh={vi.fn()}
        onSyncNow={vi.fn()}
        onOpenSettings={vi.fn()}
        onNotify={vi.fn()}
      />,
    );

    expect(screen.queryByRole('group', { name: '最紧额度摘要' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);
    expect(within(screen.getByRole('article', { name: 'Claude' })).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '18');
  });

  it('连续列表保留长窗口名称、历史观测和真实可用值，并把原因收在行尾详情', () => {
    const longLabel = '团队开发账号_codex_bengalfox · 5 小时额度';
    render(<QuotaPanel providers={[{...CODEX, status:'stale', windows:[{
      ...CODEX.windows[0], windowLabel:longLabel, status:'stale', reasonCode:'observation_stale',
    }]}]} loading={false} error="" quotaSyncStatus={DISABLED_SYNC} onRefresh={vi.fn()} onSyncNow={vi.fn()} onOpenSettings={vi.fn()} onNotify={vi.fn()} />);
    const provider = screen.getByRole('article', {name:/Codex/});
    expect(within(provider).getByText('团队开发账号_codex_bengalfox')).toBeVisible();
    expect(provider.querySelector('.quota-window-head strong')).toHaveTextContent('5 小时');
    expect(within(provider).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62');
    expect(provider).toHaveTextContent('历史数据');
    const details = within(provider).getByLabelText('Codex · 团队开发账号_codex_bengalfox：查看额度详情');
    expect(details.tagName).toBe('SUMMARY');
    expect(details).toHaveTextContent('详情');
    expect(window.localStorage.getItem('tokenledger:quota-view-mode')).toBeNull();
  });

  it('到期窗口的重置状态只显示一次', () => {
    const fixedNow = Date.parse('2026-09-04T05:30:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      render(<QuotaPanel providers={[{...CODEX, windows: [{
        ...CODEX.windows[0],
        resetsAt: new Date(fixedNow - 60_000).toISOString(),
        observedAt: new Date(fixedNow - 30_000).toISOString(),
        fetchedAt: new Date(fixedNow - 30_000).toISOString(),
      }]}]} loading={false} error="" quotaSyncStatus={DISABLED_SYNC}
        onRefresh={vi.fn()} onSyncNow={vi.fn()} onOpenSettings={vi.fn()} onNotify={vi.fn()} />);

      const reset = document.querySelector('.quota-window-meta')!;
      expect(reset).toHaveTextContent('正在重置');
      expect(reset).not.toHaveTextContent('正在重置重置');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('没有任何百分比窗口时不渲染已废弃的最紧额度摘要', () => {
    render(
      <QuotaPanel
        providers={[CLAUDE_PROVIDER]}
        loading={false}
        error=""
        quotaSyncStatus={DISABLED_SYNC}
        onRefresh={vi.fn()}
        onSyncNow={vi.fn()}
        onOpenSettings={vi.fn()}
        onNotify={vi.fn()}
      />,
    );
    expect(screen.queryByRole('group', { name: '最紧额度摘要' })).not.toBeInTheDocument();
  });

  it('按显示偏好排序来源并允许隐藏来源，待处理来源也使用同一偏好', () => {
    render(<QuotaPanel providers={[CODEX, CLAUDE_OK, CLAUDE_PROVIDER]} loading={false} error="" quotaSyncStatus={DISABLED_SYNC}
      sourceOrder={['anthropic-claude-consumer:consumer-subscription', 'openai-codex-local:consumer-subscription']}
      hiddenSourceIds={['openai-codex-local:consumer-subscription']}
      onRefresh={vi.fn()} onSyncNow={vi.fn()} onOpenSettings={vi.fn()} onNotify={vi.fn()} />);
    expect(screen.queryByRole('article', { name: 'Codex' })).not.toBeInTheDocument();
    expect(screen.getByText('待处理来源')).toBeInTheDocument();
    // 默认折叠：待处理来源只占一行摘要，不渲染完整卡片。
    expect(screen.getAllByRole('article', { name: 'Claude' })).toHaveLength(1);
    const toggle = screen.getByRole('button', { name: /1 个来源没有可展示额度/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Claude', { selector: '.quota-pending-summary-names' })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('article', { name: 'Claude' })).toHaveLength(2);
  });
});

describe('QuotaPanel empty provider actions', () => {
  it('将失败原因与恢复动作放在同一条可读路径中', () => {
    const onRefresh = vi.fn();
    const onOpenSettings = vi.fn();

    render(
      <QuotaPanel
        providers={[]}
        loading={false}
        error="来源数据格式暂时无法识别。"
        quotaSyncStatus={DISABLED_SYNC}
        onRefresh={onRefresh}
        onSyncNow={vi.fn()}
        onOpenSettings={onOpenSettings}
        onNotify={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('额度暂时无法更新');
    expect(screen.getByRole('alert')).toHaveTextContent('不会推算未提供的余额');
    fireEvent.click(screen.getByRole('button', { name: '刷新额度' }));
    fireEvent.click(screen.getByRole('button', { name: '检查额度来源' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('在看板已提供主恢复入口时只保留面板内的状态上下文', () => {
    render(
      <QuotaPanel
        providers={[CLAUDE_PROVIDER]}
        loading={false}
        error="来源数据格式暂时无法识别。"
        showRecoveryActions={false}
        quotaSyncStatus={DISABLED_SYNC}
        onRefresh={vi.fn()}
        onSyncNow={vi.fn()}
        onOpenSettings={vi.fn()}
        onNotify={vi.fn()}
      />,
    );

    expect(screen.getByRole('status', { name: '额度读取状态' })).toHaveTextContent('本次读取未完成');
    expect(screen.getByRole('status')).toHaveTextContent('恢复操作位于看板顶部');
    expect(screen.queryByRole('button', { name: '重新读取额度' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '刷新额度' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '检查额度来源' })).not.toBeInTheDocument();
  });

  it('无失败状态时保留面板内的刷新入口', () => {
    const onRefresh = vi.fn();

    render(
      <QuotaPanel
        providers={[]}
        loading={false}
        error=""
        quotaSyncStatus={DISABLED_SYNC}
        onRefresh={onRefresh}
        onSyncNow={vi.fn()}
        onOpenSettings={vi.fn()}
        onNotify={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '刷新额度' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('将公司额度的安全存储失败解释为不会后台重复读取并可主动恢复', () => {
    render(
      <ProviderEmpty
        provider={{
          ...CLAUDE_PROVIDER,
          providerId: 'company-openapi-testcompany',
          displayName: '公司额度',
          reasonCode: 'secure_storage_unavailable',
        }}
        onOpenSettings={vi.fn()}
        onNotify={vi.fn()}
      />,
    );

    expect(screen.getByText(/后台不会重复尝试/)).toBeInTheDocument();
    expect(screen.getByText(/确认钥匙串已解锁后点击刷新额度/)).toBeInTheDocument();
  });

  it('复制指令期间显示进行中反馈并阻止重复触发', async () => {
    let resolveWriteText: (() => void) | undefined;
    const writeText = vi.fn(() => new Promise<void>((resolve) => {
      resolveWriteText = resolve;
    }));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const onNotify = vi.fn();

    render(<ProviderEmpty provider={CLAUDE_PROVIDER} onOpenSettings={vi.fn()} onNotify={onNotify} />);

    const button = screen.getByRole('button', { name: 'Claude：复制 /usage' });
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Claude：正在复制指令' })).toBeDisabled();
    expect(writeText).toHaveBeenCalledTimes(1);

    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledTimes(1);

    resolveWriteText?.();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Claude：复制 /usage' })).toBeEnabled());
    expect(onNotify).toHaveBeenCalledWith('已复制 /usage');
  });
});
