import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type BusyState,
  type CloudStatus,
  type QuotaProviderEnvelope,
  type QuotaSyncStatus,
  type QuotaWindowSnapshot,
} from '../../types';
import { ConfirmDialog } from '../ConfirmDialog';
import type { ConfirmationRequest, RequestConfirmation } from '../../utils/confirmation';
import { parseQuotaSourceDetections, quotaOverviewSummary, quotaSourceCardView } from './QuotaSection';
import { QuotaSection } from './QuotaSection';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

function busyState(settings = false): BusyState {
  return {
    scan: false,
    sync: false,
    wallpaper: false,
    auth: false,
    config: false,
    settings,
    prices: false,
    db: false,
  };
}

const cloudStatus: CloudStatus = {
  configured: true,
  authenticated: true,
  email: 'test@example.com',
  userId: 'user-1',
};

const quotaSyncStatus: QuotaSyncStatus = { enabled: false, state: 'disabled' };

function quotaWindow(providerId: string, overrides: Partial<QuotaWindowSnapshot> = {}): QuotaWindowSnapshot {
  const observedAt = overrides.observedAt ?? new Date(Date.now() - 5 * 60_000).toISOString();
  return {
    providerId,
    windowId: 'five-hour',
    windowLabel: '5 小时窗口',
    scope: 'consumer-subscription',
    source: 'local-authorized',
    status: 'ok',
    used: 38,
    limit: 100,
    remaining: 62,
    unit: 'percent',
    windowMinutes: 300,
    resetsAt: new Date(Date.parse(observedAt) + 2 * 3_600_000).toISOString(),
    observedAt,
    fetchedAt: observedAt,
    staleAfterSeconds: 86_400,
    ...overrides,
  };
}

function sourceProvider(
  providerId: string,
  overrides: Partial<QuotaProviderEnvelope> = {},
): QuotaProviderEnvelope {
  return {
    schemaVersion: 1,
    providerId,
    displayName: providerId,
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: 'plan-dependent',
    status: 'ok',
    windows: [quotaWindow(providerId)],
    ...overrides,
  };
}

function claudeProvider(overrides: Partial<QuotaProviderEnvelope> = {}) {
  return sourceProvider('anthropic-claude-consumer', overrides);
}

interface QuotaDeleteHarnessProps {
  onDeleteOperation: () => Promise<void> | void;
  onClearOperation: () => Promise<void> | void;
}

function QuotaDeleteHarness({ onDeleteOperation, onClearOperation }: QuotaDeleteHarnessProps) {
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const confirmationResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const requestConfirmation = useCallback<RequestConfirmation>((request) => new Promise((resolve) => {
    confirmationResolverRef.current = resolve;
    setConfirmation(request);
  }), []);
  const settleConfirmation = (confirmed: boolean) => {
    const resolve = confirmationResolverRef.current;
    confirmationResolverRef.current = null;
    setConfirmation(null);
    resolve?.(confirmed);
  };
  const runConfirmedDelete = async (operation: () => Promise<void> | void) => {
    if (!(await requestConfirmation({
      title: '确认删除云端额度？',
      description: '测试确认流程。',
      confirmLabel: '确认删除',
      tone: 'danger',
    }))) return false;
    setSettingsBusy(true);
    try {
      await operation();
      return true;
    } finally {
      setSettingsBusy(false);
    }
  };

  return (
    <>
      <button type="button">其他有效操作</button>
      <QuotaSection
        appSettings={DEFAULT_SETTINGS}
        cloudStatus={cloudStatus}
        quotaProviders={[]}
        quotaSyncStatus={quotaSyncStatus}
        busy={busyState(settingsBusy)}
        onSettingChange={vi.fn()}
        onClaudeNativeQuotaChange={vi.fn()}
        onAntigravityLocalQuotaChange={vi.fn()}
        onAuthorizeClaudeNativeQuota={vi.fn()}
        onAuthorizeAntigravityQuota={vi.fn()}
        onQuotaSyncToggle={vi.fn()}
        onQuotaSyncNow={vi.fn()}
        onDeleteQuotaProvider={() => runConfirmedDelete(onDeleteOperation)}
        onClearQuotaSnapshots={() => runConfirmedDelete(onClearOperation)}
        onConfirm={requestConfirmation}
        onCustomQuotaChanged={vi.fn()}
      />
      {confirmation && (
        <ConfirmDialog
          {...confirmation}
          onCancel={() => settleConfirmation(false)}
          onConfirm={() => settleConfirmation(true)}
        />
      )}
    </>
  );
}

describe('quotaOverviewSummary', () => {
  it('counts one capability per local provider and separates company enablement', () => {
    const summary = quotaOverviewSummary(
      {
        quota_codex_local_enabled: true,
        quota_claude_enabled: true,
        quota_antigravity_local_enabled: false,
      },
      [
        { id: 'one', providerId: 'company-openapi-one', displayName: '研发', url: 'https://example.com', enabled: true, hasApiKey: true, schemaVerified: true },
        { id: 'two', providerId: 'company-openapi-two', displayName: '生产', url: 'https://example.com', enabled: false, hasApiKey: true, schemaVerified: false },
      ],
      '已同步',
      ['connected', 'read-failed', 'not-installed'],
    );

    expect(summary).toEqual({
      localEnabledCount: 2,
      localConnectedCount: 1,
      localAttentionCount: 1,
      companyConfiguredCount: 2,
      companyEnabledCount: 1,
      syncLabel: '已同步',
    });
  });

  it('does not treat an unconfigured company source as enabled', () => {
    expect(quotaOverviewSummary(
      {
        quota_codex_local_enabled: false,
        quota_claude_enabled: false,
        quota_antigravity_local_enabled: false,
      },
      [],
      '未启用',
    ).companyEnabledCount).toBe(0);
  });

  it('额度容量超限时持续显示可操作说明', () => {
    render(<QuotaSection
      appSettings={{ ...DEFAULT_SETTINGS, quota_snapshot_sync_enabled: true }}
      cloudStatus={cloudStatus} quotaProviders={[]}
      quotaSyncStatus={{ enabled: true, state: 'error', reasonCode: 'quota_sync_invalid_provider_count' }}
      busy={busyState()} onSettingChange={vi.fn()} onClaudeNativeQuotaChange={vi.fn()}
      onAntigravityLocalQuotaChange={vi.fn()} onAuthorizeClaudeNativeQuota={vi.fn()}
      onAuthorizeAntigravityQuota={vi.fn()} onQuotaSyncToggle={vi.fn()} onQuotaSyncNow={vi.fn()}
      onDeleteQuotaProvider={vi.fn()} onClearQuotaSnapshots={vi.fn()}
      onConfirm={vi.fn(async () => true)} onCustomQuotaChanged={vi.fn()}
    />);
    expect(screen.getAllByText('本机待同步的活跃来源超过 8 个；跨设备额度同步最多支持 8 个活跃来源。请在额度设置中关闭部分本机来源后重试，已保留的云端来源不会被删除')
      .some((element) => element.getAttribute('role') === 'status')).toBe(true);
  });

  it('区分云端已有来源占满容量，并保留显式删除入口与代价', () => {
    const onClear = vi.fn();
    const onSync = vi.fn();
    render(<QuotaSection
      appSettings={{ ...DEFAULT_SETTINGS, quota_snapshot_sync_enabled: true }}
      cloudStatus={cloudStatus} quotaProviders={[]}
      quotaSyncStatus={{ enabled: true, state: 'error', reasonCode: 'quota_sync_capacity_exceeded' }}
      busy={busyState()} onSettingChange={vi.fn()} onClaudeNativeQuotaChange={vi.fn()}
      onAntigravityLocalQuotaChange={vi.fn()} onAuthorizeClaudeNativeQuota={vi.fn()}
      onAuthorizeAntigravityQuota={vi.fn()} onQuotaSyncToggle={vi.fn()} onQuotaSyncNow={onSync}
      onDeleteQuotaProvider={vi.fn()} onClearQuotaSnapshots={onClear}
      onConfirm={vi.fn(async () => true)} onCustomQuotaChanged={vi.fn()}
    />);
    const recoveryStatus = screen.getAllByText('本次同步会使云端活跃来源超过 8 个上限，本次新增来源未同步；关闭本机来源不会删除云端历史或释放名额。请先查看下方云端快照管理的删除范围与代价')
      .find((element) => element.getAttribute('role') === 'status');
    expect(recoveryStatus).toHaveStyle({ display: 'block', overflow: 'visible' });
    expect(recoveryStatus?.style.webkitLineClamp).toBe('unset');
    expect(recoveryStatus?.closest('.settings-row')).toHaveClass('settings-row-wide-control');
    expect(screen.getByText(/全部删除包括其他设备留下的账户额度历史，无法撤销/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除全部云端额度' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '同步额度' })).toBeEnabled();
    expect(onClear).not.toHaveBeenCalled();
    expect(onSync).not.toHaveBeenCalled();
  });

  it('清空结果未知持续解释可能生效而非撤销，不自动再删', () => {
    const onClear = vi.fn();
    render(<QuotaSection
      appSettings={DEFAULT_SETTINGS}
      cloudStatus={cloudStatus} quotaProviders={[]}
      quotaSyncStatus={{ enabled: false, state: 'error', reasonCode: 'quota_sync_clear_outcome_unknown' }}
      busy={busyState()} onSettingChange={vi.fn()} onClaudeNativeQuotaChange={vi.fn()}
      onAntigravityLocalQuotaChange={vi.fn()} onAuthorizeClaudeNativeQuota={vi.fn()}
      onAuthorizeAntigravityQuota={vi.fn()} onQuotaSyncToggle={vi.fn()} onQuotaSyncNow={vi.fn()}
      onDeleteQuotaProvider={vi.fn()} onClearQuotaSnapshots={onClear}
      onConfirm={vi.fn(async () => true)} onCustomQuotaChanged={vi.fn()}
    />);
    expect(screen.getAllByText('本机额度同步已关闭，但云端删除结果尚未确认；请求可能已在云端生效，不代表已撤销。请先查看最新状态，再决定是否重新确认删除全部快照；如需恢复同步，须手动重新启用')
      .some((element) => element.getAttribute('role') === 'status')).toBe(true);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('额度来源立即读取期间显示动作反馈并锁定重复入口', () => {
    const onAuthorizeClaudeNativeQuota = vi.fn();
    const view = render(
      <QuotaSection
        appSettings={{ ...DEFAULT_SETTINGS, quota_claude_enabled: true, quota_claude_codexbar_enabled: true }}
        cloudStatus={cloudStatus}
        quotaProviders={[claudeProvider()]}
        quotaSyncStatus={quotaSyncStatus}
        busy={busyState()}
        onSettingChange={vi.fn()}
        onClaudeNativeQuotaChange={vi.fn()}
        onAntigravityLocalQuotaChange={vi.fn()}
        onAuthorizeClaudeNativeQuota={onAuthorizeClaudeNativeQuota}
        onAuthorizeAntigravityQuota={vi.fn()}
        onQuotaSyncToggle={vi.fn()}
        onQuotaSyncNow={vi.fn()}
        onDeleteQuotaProvider={vi.fn()}
        onClearQuotaSnapshots={vi.fn()}
        onConfirm={vi.fn(async () => true)}
        onCustomQuotaChanged={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '立即读取 Claude 订阅额度' }));
    expect(onAuthorizeClaudeNativeQuota).toHaveBeenCalledTimes(1);
    view.rerender(
      <QuotaSection
        appSettings={{ ...DEFAULT_SETTINGS, quota_claude_enabled: true, quota_claude_codexbar_enabled: true }}
        cloudStatus={cloudStatus}
        quotaProviders={[claudeProvider()]}
        quotaSyncStatus={quotaSyncStatus}
        busy={busyState(true)}
        onSettingChange={vi.fn()}
        onClaudeNativeQuotaChange={vi.fn()}
        onAuthorizeClaudeNativeQuota={onAuthorizeClaudeNativeQuota}
        onAuthorizeAntigravityQuota={vi.fn()}
        onAntigravityLocalQuotaChange={vi.fn()}
        onQuotaSyncToggle={vi.fn()}
        onQuotaSyncNow={vi.fn()}
        onDeleteQuotaProvider={vi.fn()}
        onClearQuotaSnapshots={vi.fn()}
        onConfirm={vi.fn(async () => true)}
        onCustomQuotaChanged={vi.fn()}
      />,
    );

    const read = screen.getByRole('button', { name: '正在读取 Claude 订阅额度' });
    expect(read).toBeDisabled();
    expect(read).toHaveAttribute('aria-busy', 'true');
    expect(read).toHaveAttribute('title', '正在读取 Claude 订阅额度');
    expect(read).toHaveTextContent('读取中…');
    expect(read.querySelector('.animate-spin')).toBeTruthy();
  });

  it('额度权限边界折叠入口按来源提供唯一可访问名称', () => {
    render(
      <QuotaSection
        appSettings={DEFAULT_SETTINGS}
        cloudStatus={cloudStatus}
        quotaProviders={[]}
        quotaSyncStatus={quotaSyncStatus}
        busy={busyState()}
        onSettingChange={vi.fn()}
        onClaudeNativeQuotaChange={vi.fn()}
        onAntigravityLocalQuotaChange={vi.fn()}
        onAuthorizeClaudeNativeQuota={vi.fn()}
        onAuthorizeAntigravityQuota={vi.fn()}
        onQuotaSyncToggle={vi.fn()}
        onQuotaSyncNow={vi.fn()}
        onDeleteQuotaProvider={vi.fn()}
        onClearQuotaSnapshots={vi.fn()}
        onConfirm={vi.fn(async () => true)}
        onCustomQuotaChanged={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Codex：权限与数据边界' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claude：权限与数据边界' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Antigravity：权限与数据边界' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '公司 OpenAPI：权限与数据边界' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '跨设备同步：权限与数据边界' })).toBeInTheDocument();
  });

  it('额度同步禁用时关联下一步说明并同步到悬停提示', () => {
    render(
      <QuotaSection
        appSettings={DEFAULT_SETTINGS}
        cloudStatus={cloudStatus}
        quotaProviders={[]}
        quotaSyncStatus={quotaSyncStatus}
        busy={busyState()}
        onSettingChange={vi.fn()}
        onClaudeNativeQuotaChange={vi.fn()}
        onAntigravityLocalQuotaChange={vi.fn()}
        onAuthorizeClaudeNativeQuota={vi.fn()}
        onAuthorizeAntigravityQuota={vi.fn()}
        onQuotaSyncToggle={vi.fn()}
        onQuotaSyncNow={vi.fn()}
        onDeleteQuotaProvider={vi.fn()}
        onClearQuotaSnapshots={vi.fn()}
        onConfirm={vi.fn(async () => true)}
        onCustomQuotaChanged={vi.fn()}
      />,
    );

    const sync = screen.getByRole('button', { name: '同步额度' });
    expect(sync).toBeDisabled();
    expect(sync).toHaveAttribute('aria-describedby', 'quota-sync-action-hint');
    expect(sync).toHaveAttribute('title', '同步额度：请先启用跨设备同步');
    expect(screen.getByText('请先启用跨设备同步')).toHaveAttribute('id', 'quota-sync-action-hint');
  });

  it('公司额度来源编辑入口按来源提供唯一可访问名称', async () => {
    const endpoints = [
      {
        id: 'company-edit-1',
        providerId: 'company-openapi-edit-1',
        displayName: '研发账号额度',
        url: 'https://quota.example.com/research/v1/me/quota',
        enabled: true,
        hasApiKey: true,
        schemaVerified: true,
      },
      {
        id: 'company-edit-2',
        providerId: 'company-openapi-edit-2',
        displayName: '生产账号额度',
        url: 'https://quota.example.com/production/v1/me/quota',
        enabled: true,
        hasApiKey: true,
        schemaVerified: true,
      },
    ];
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'list_custom_quota_endpoints') return Promise.resolve(endpoints) as never;
      if (command === 'get_claude_statusline_command') return Promise.resolve('/usr/local/bin/tokenledger --claude-statusline') as never;
      return Promise.resolve([]) as never;
    });

    render(
      <QuotaSection
        appSettings={DEFAULT_SETTINGS}
        cloudStatus={cloudStatus}
        quotaProviders={[]}
        quotaSyncStatus={quotaSyncStatus}
        busy={busyState()}
        onSettingChange={vi.fn()}
        onClaudeNativeQuotaChange={vi.fn()}
        onAntigravityLocalQuotaChange={vi.fn()}
        onAuthorizeClaudeNativeQuota={vi.fn()}
        onAuthorizeAntigravityQuota={vi.fn()}
        onQuotaSyncToggle={vi.fn()}
        onQuotaSyncNow={vi.fn()}
        onDeleteQuotaProvider={vi.fn()}
        onClearQuotaSnapshots={vi.fn()}
        onConfirm={vi.fn(async () => true)}
        onCustomQuotaChanged={vi.fn()}
      />,
    );

    expect(await screen.findByRole('button', { name: '编辑 研发账号额度 公司额度来源' })).toHaveAttribute('title', '编辑 研发账号额度 公司额度来源');
    expect(await screen.findByRole('button', { name: '编辑 生产账号额度 公司额度来源' })).toHaveAttribute('title', '编辑 生产账号额度 公司额度来源');
    expect(screen.queryAllByRole('button', { name: /^编辑$/ })).toHaveLength(0);
  });

  it('旧公司额度配置只显示待检查，不因打开设置读取钥匙串', async () => {
    const endpoint = {
      id: 'company-legacy-key-state',
      providerId: 'company-openapi-company-legacy-key-state',
      displayName: '旧配置',
      url: 'https://quota.example.com/v1/me/quota',
      enabled: false,
      hasApiKey: null,
      schemaVerified: true,
    };
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'list_custom_quota_endpoints') return Promise.resolve([endpoint]) as never;
      if (command === 'get_claude_statusline_command') return Promise.resolve('/usr/local/bin/tokenledger --claude-statusline') as never;
      return Promise.resolve([]) as never;
    });

    render(
      <QuotaSection
        appSettings={DEFAULT_SETTINGS}
        cloudStatus={cloudStatus}
        quotaProviders={[]}
        quotaSyncStatus={quotaSyncStatus}
        busy={busyState()}
        onSettingChange={vi.fn()}
        onClaudeNativeQuotaChange={vi.fn()}
        onAntigravityLocalQuotaChange={vi.fn()}
        onAuthorizeClaudeNativeQuota={vi.fn()}
        onAuthorizeAntigravityQuota={vi.fn()}
        onQuotaSyncToggle={vi.fn()}
        onQuotaSyncNow={vi.fn()}
        onDeleteQuotaProvider={vi.fn()}
        onClearQuotaSnapshots={vi.fn()}
        onConfirm={vi.fn(async () => true)}
        onCustomQuotaChanged={vi.fn()}
      />,
    );

    expect(await screen.findByText(/key 状态待检查/)).toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === 'list_custom_quota_endpoints')).toHaveLength(1);
  });

  it('公司额度来源变更期间显示具体动作反馈并锁定重复入口', async () => {
    const endpoint = {
      id: 'company-1',
      providerId: 'company-openapi-company-1',
      displayName: '研发账号额度',
      url: 'https://quota.example.com/v1/me/quota',
      enabled: false,
      hasApiKey: true,
      schemaVerified: true,
    };
    let resolveToggle!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'list_custom_quota_endpoints') return Promise.resolve([endpoint]) as never;
      if (command === 'get_claude_statusline_command') return Promise.resolve('/usr/local/bin/tokenledger --claude-statusline') as never;
      if (command === 'upsert_custom_quota_endpoint') {
        return new Promise((resolve) => {
          resolveToggle = resolve;
        }) as never;
      }
      return Promise.resolve([]) as never;
    });

    const view = render(
      <QuotaSection
        appSettings={DEFAULT_SETTINGS}
        cloudStatus={cloudStatus}
        quotaProviders={[]}
        quotaSyncStatus={quotaSyncStatus}
        busy={busyState()}
        onSettingChange={vi.fn()}
        onClaudeNativeQuotaChange={vi.fn()}
        onAntigravityLocalQuotaChange={vi.fn()}
        onAuthorizeClaudeNativeQuota={vi.fn()}
        onAuthorizeAntigravityQuota={vi.fn()}
        onQuotaSyncToggle={vi.fn()}
        onQuotaSyncNow={vi.fn()}
        onDeleteQuotaProvider={vi.fn()}
        onClearQuotaSnapshots={vi.fn()}
        onConfirm={vi.fn(async () => true)}
        onCustomQuotaChanged={vi.fn()}
      />,
    );

    const toggle = await screen.findByRole('button', { name: '启用 研发账号额度' });
    fireEvent.click(toggle);
    const active = await screen.findByRole('button', { name: '正在启用 研发账号额度' });
    expect(active).toBeDisabled();
    expect(active).toHaveAttribute('aria-busy', 'true');
    expect(active).toHaveAttribute('title', '正在启用 研发账号额度');
    expect(active).toHaveTextContent('处理中…');
    expect(active.querySelector('.animate-spin')).toBeTruthy();
    fireEvent.click(active);
    expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === 'upsert_custom_quota_endpoint')).toHaveLength(1);

    await act(async () => {
      resolveToggle([{ ...endpoint, enabled: true }]);
    });
    view.unmount();
  });

  it('公司额度来源保存期间显示动作反馈并锁定重复入口', async () => {
    const endpoint = {
      id: 'company-3',
      providerId: 'company-openapi-company-3',
      displayName: '研发账号额度',
      url: 'https://quota.example.com/v1/me/quota',
      enabled: true,
      hasApiKey: true,
      schemaVerified: true,
    };
    let resolveSave!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'list_custom_quota_endpoints') return Promise.resolve([]) as never;
      if (command === 'get_claude_statusline_command') return Promise.resolve('/usr/local/bin/tokenledger --claude-statusline') as never;
      if (command === 'upsert_custom_quota_endpoint') {
        return new Promise((resolve) => {
          resolveSave = resolve;
        }) as never;
      }
      return Promise.resolve([]) as never;
    });

    const view = render(
      <QuotaSection
        appSettings={DEFAULT_SETTINGS}
        cloudStatus={cloudStatus}
        quotaProviders={[]}
        quotaSyncStatus={quotaSyncStatus}
        busy={busyState()}
        onSettingChange={vi.fn()}
        onClaudeNativeQuotaChange={vi.fn()}
        onAntigravityLocalQuotaChange={vi.fn()}
        onAuthorizeClaudeNativeQuota={vi.fn()}
        onAuthorizeAntigravityQuota={vi.fn()}
        onQuotaSyncToggle={vi.fn()}
        onQuotaSyncNow={vi.fn()}
        onDeleteQuotaProvider={vi.fn()}
        onClearQuotaSnapshots={vi.fn()}
        onConfirm={vi.fn(async () => true)}
        onCustomQuotaChanged={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: '公司额度来源名称' }), { target: { value: endpoint.displayName } });
    fireEvent.change(screen.getByRole('textbox', { name: '公司额度查询接口地址' }), { target: { value: endpoint.url } });
    fireEvent.change(screen.getByLabelText('公司额度 API key'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '添加并刷新额度' }));

    const active = await screen.findByRole('button', { name: '正在添加公司额度来源' });
    expect(active).toBeDisabled();
    expect(active).toHaveAttribute('aria-busy', 'true');
    expect(active).toHaveAttribute('title', '正在添加公司额度来源，请稍候');
    expect(active).toHaveTextContent('保存中…');
    expect(active.querySelector('.animate-spin')).toBeTruthy();
    fireEvent.click(active);

    await act(async () => {
      resolveSave([endpoint]);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '添加并刷新额度' })).toBeEnabled());
    view.unmount();
  });

  it('云端额度快照删除期间显示具体动作反馈并锁定重复入口', async () => {
    const endpoint = {
      id: 'company-2',
      providerId: 'company-openapi-company-2',
      displayName: '研发账号额度',
      url: 'https://quota.example.com/v1/me/quota',
      enabled: true,
      hasApiKey: true,
      schemaVerified: true,
    };
    let resolveDelete!: (value: boolean) => void;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'list_custom_quota_endpoints') return Promise.resolve([endpoint]) as never;
      if (command === 'get_claude_statusline_command') return Promise.resolve('/usr/local/bin/tokenledger --claude-statusline') as never;
      return Promise.resolve([]) as never;
    });
    const onDeleteQuotaProvider = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveDelete = resolve;
    }));

    const view = render(
      <QuotaSection
        appSettings={DEFAULT_SETTINGS}
        cloudStatus={cloudStatus}
        quotaProviders={[]}
        quotaSyncStatus={quotaSyncStatus}
        busy={busyState()}
        onSettingChange={vi.fn()}
        onClaudeNativeQuotaChange={vi.fn()}
        onAntigravityLocalQuotaChange={vi.fn()}
        onAuthorizeClaudeNativeQuota={vi.fn()}
        onAuthorizeAntigravityQuota={vi.fn()}
        onQuotaSyncToggle={vi.fn()}
        onQuotaSyncNow={vi.fn()}
        onDeleteQuotaProvider={onDeleteQuotaProvider}
        onClearQuotaSnapshots={vi.fn()}
        onConfirm={vi.fn(async () => true)}
        onCustomQuotaChanged={vi.fn()}
      />,
    );

    const deleteButton = await screen.findByRole('button', { name: '删除 研发账号额度 云端快照' });
    fireEvent.click(deleteButton);
    const active = await screen.findByRole('button', { name: '正在删除 研发账号额度 云端快照' });
    expect(active).toBeDisabled();
    expect(active).toHaveAttribute('aria-busy', 'true');
    expect(active).toHaveAttribute('title', '正在删除 研发账号额度 云端快照');
    expect(active).toHaveTextContent('删除中…');
    expect(active.querySelector('.animate-spin')).toBeTruthy();
    fireEvent.click(active);
    expect(onDeleteQuotaProvider).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDelete(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: '正在删除 研发账号额度 云端快照' })).not.toBeInTheDocument());
    view.unmount();
  });

  it.each([
    ['单个来源', '删除 Codex 云端快照', 'delete'],
    ['全部来源', '删除全部云端额度', 'clear'],
  ] as const)('%s删除确认按 Escape 取消后回到原触发按钮且不执行删除', async (_label, buttonName, operation) => {
    const onDeleteOperation = vi.fn();
    const onClearOperation = vi.fn();
    render(
      <QuotaDeleteHarness
        onDeleteOperation={onDeleteOperation}
        onClearOperation={onClearOperation}
      />,
    );

    const trigger = screen.getByRole('button', { name: buttonName });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(trigger, { detail: 0 });
    await waitFor(() => expect(screen.getByRole('button', { name: '取消' })).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toBeEnabled();
    expect(operation === 'delete' ? onDeleteOperation : onClearOperation).not.toHaveBeenCalled();
  });

  it('确认删除后等待外部 busy 解除再回焦，并抑制重复动作', async () => {
    let resolveDelete!: () => void;
    const onDeleteOperation = vi.fn(() => new Promise<void>((resolve) => {
      resolveDelete = resolve;
    }));
    render(
      <QuotaDeleteHarness
        onDeleteOperation={onDeleteOperation}
        onClearOperation={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: '删除 Codex 云端快照' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(onDeleteOperation).toHaveBeenCalledTimes(1));

    fireEvent.click(trigger);
    expect(onDeleteOperation).toHaveBeenCalledTimes(1);
    expect(trigger).toBeDisabled();

    await act(async () => {
      resolveDelete();
      await Promise.resolve();
    });

    await waitFor(() => expect(trigger).toBeEnabled());
    expect(trigger).toHaveFocus();
    expect(onDeleteOperation).toHaveBeenCalledTimes(1);
  });

  it('删除进行中用户主动移到其他有效控件时不抢回焦点', async () => {
    let resolveDelete!: () => void;
    const onDeleteOperation = vi.fn(() => new Promise<void>((resolve) => {
      resolveDelete = resolve;
    }));
    render(
      <QuotaDeleteHarness
        onDeleteOperation={onDeleteOperation}
        onClearOperation={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: '删除 Codex 云端快照' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(onDeleteOperation).toHaveBeenCalledTimes(1));
    const otherAction = screen.getByRole('button', { name: '其他有效操作' });
    otherAction.focus();

    await act(async () => {
      resolveDelete();
      await Promise.resolve();
    });

    await waitFor(() => expect(trigger).toBeEnabled());
    expect(otherAction).toHaveFocus();
  });

  it('删除失败后释放入口并恢复键盘焦点', async () => {
    const onDeleteOperation = vi.fn(async () => {
      throw new Error('删除失败');
    });
    render(
      <QuotaDeleteHarness
        onDeleteOperation={onDeleteOperation}
        onClearOperation={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: '删除 Codex 云端快照' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(trigger).toBeEnabled());
    expect(trigger).toHaveFocus();
    expect(onDeleteOperation).toHaveBeenCalledTimes(1);
  });

  it('全部删除尚未完成时卸载不会在异步收尾后回焦', async () => {
    let resolveClear!: () => void;
    const onClearOperation = vi.fn(() => new Promise<void>((resolve) => {
      resolveClear = resolve;
    }));
    const view = render(
      <QuotaDeleteHarness
        onDeleteOperation={vi.fn()}
        onClearOperation={onClearOperation}
      />,
    );

    const trigger = screen.getByRole('button', { name: '删除全部云端额度' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(onClearOperation).toHaveBeenCalledTimes(1));

    view.unmount();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    await act(async () => {
      resolveClear();
      await Promise.resolve();
    });

    expect(outside).toHaveFocus();
    outside.remove();
  });
});

describe('Claude 一键接入（T10.282）', () => {
  const baseSetup = {
    settingsBlock: '{\n  "statusLine": {\n    "type": "command",\n    "command": "tokenledger --claude-statusline"\n  }\n}',
    commandProperty: '"command": "tokenledger --claude-statusline"',
    settingsPath: '/Users/demo/.claude/settings.json',
    statusLineWired: false,
    snapshotPresent: false,
    cliCandidates: [],
    backup: null,
    chainPresent: false,
  };
  const preview = {
    settingsPath: '~/.claude/settings.json',
    fileExists: true,
    changed: true,
    keepsOriginal: true,
    beforeVersion: 'v-original',
    diff: '-     "command": "~/bin/line.sh",\n+     "command": "tokenledger --claude-statusline",',
  };

  function renderClaude(onConfirm: RequestConfirmation = vi.fn(async () => true), enabled = true) {
    return render(
      <QuotaSection
        appSettings={{ ...DEFAULT_SETTINGS, quota_claude_enabled: enabled }}
        cloudStatus={cloudStatus}
        quotaProviders={[]}
        quotaSyncStatus={quotaSyncStatus}
        busy={busyState()}
        onSettingChange={vi.fn()}
        onClaudeNativeQuotaChange={vi.fn()}
        onAntigravityLocalQuotaChange={vi.fn()}
        onAuthorizeClaudeNativeQuota={vi.fn()}
        onAuthorizeAntigravityQuota={vi.fn()}
        onQuotaSyncToggle={vi.fn()}
        onQuotaSyncNow={vi.fn()}
        onDeleteQuotaProvider={vi.fn()}
        onClearQuotaSnapshots={vi.fn()}
        onConfirm={onConfirm}
        onCustomQuotaChanged={vi.fn()}
      />,
    );
  }

  function mockSetup(handlers: Record<string, (args?: unknown) => unknown>) {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((command, args) => {
      const handler = handlers[command];
      if (handler) {
        try {
          return Promise.resolve(handler(args)) as never;
        } catch (error) {
          return Promise.reject(error) as never;
        }
      }
      return Promise.resolve([]) as never;
    });
  }

  async function readySetupButton() {
    const button = screen.getByRole('button', { name: '一键接入' });
    await waitFor(() => expect(button).toBeEnabled());
    return button;
  }

  it('先预览改动，确认后按预览版本写入并刷新为已接入', async () => {
    let wired = false;
    let resolveInitialSetup!: (setup: typeof baseSetup) => void;
    const initialSetup = new Promise<typeof baseSetup>((resolve) => {
      resolveInitialSetup = resolve;
    });
    mockSetup({
      get_claude_quota_setup: () => wired
        ? { ...baseSetup, statusLineWired: wired, chainPresent: wired }
        : initialSetup,
      preview_claude_statusline_setup: () => preview,
      apply_claude_statusline_setup: () => {
        wired = true;
        return { changed: true, version: 'v-applied', backupCreated: true };
      },
    });
    renderClaude();

    const loadingButton = screen.getByRole('button', { name: '一键接入' });
    expect(loadingButton).toBeDisabled();
    fireEvent.click(loadingButton);
    expect(invoke).not.toHaveBeenCalledWith('preview_claude_statusline_setup');
    await act(async () => resolveInitialSetup(baseSetup));

    fireEvent.click(await readySetupButton());
    const dialog = await screen.findByRole('dialog', { name: '写入 Claude Code 配置？' }, { timeout: 3000 });
    expect(dialog).toHaveTextContent('~/.claude/settings.json');
    expect(within(dialog).getByLabelText('statusLine 改动预览')).toHaveTextContent('--claude-statusline');
    expect(dialog).toHaveTextContent('原有 status line 会保留');
    expect(invoke).not.toHaveBeenCalledWith('apply_claude_statusline_setup', expect.anything());

    fireEvent.click(within(dialog).getByRole('button', { name: '确认写入' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('apply_claude_statusline_setup', { expectedVersion: 'v-original' }), { timeout: 3000 });
    expect(await screen.findByText('已写入，新开 Claude Code 会话后生效')).toBeInTheDocument();
    expect(await screen.findByText('正在等待首次读取。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '一键接入' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 3000 });
  });

  it('取消预览不写入；预览后文件被改动时显示后端拒绝原因', async () => {
    mockSetup({
      get_claude_quota_setup: () => baseSetup,
      preview_claude_statusline_setup: () => preview,
      apply_claude_statusline_setup: () => {
        throw 'Claude Code 配置在预览后被修改过，未做改动，请重新预览。';
      },
    });
    renderClaude();

    fireEvent.click(await readySetupButton());
    const dialog = await screen.findByRole('dialog', { name: '写入 Claude Code 配置？' }, { timeout: 3000 });
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 3000 });
    expect(invoke).not.toHaveBeenCalledWith('apply_claude_statusline_setup', expect.anything());

    fireEvent.click(await readySetupButton());
    const previewDialog = await screen.findByRole('dialog', { name: '写入 Claude Code 配置？' }, { timeout: 3000 });
    fireEvent.click(within(previewDialog).getByRole('button', { name: '确认写入' }));
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('请重新预览');
  });

  it('开关未打开时一键接入不可用，手动配置默认折叠', async () => {
    mockSetup({ get_claude_quota_setup: () => baseSetup });
    renderClaude(vi.fn(async () => true), false);

    expect(await screen.findByRole('button', { name: '一键接入' })).toBeDisabled();
    const manual = screen.getByRole('button', { name: 'Claude：手动配置' });
    expect(manual).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('复制完整配置')).not.toBeInTheDocument();
    fireEvent.click(manual);
    expect(screen.getByRole('button', { name: '复制完整配置' })).toBeEnabled();
  });

  it('恢复先确认；接入后文件被改过时要求强制恢复', async () => {
    const backup = { createdAt: '2026-10-04T04:00:00Z', originalExisted: true, restorableWithoutForce: true };
    let current: typeof backup | null = backup;
    mockSetup({
      get_claude_quota_setup: () => ({ ...baseSetup, statusLineWired: current !== null, backup: current, chainPresent: current !== null }),
      restore_claude_statusline_setup: () => {
        current = null;
        return { removed: false, version: 'v-original' };
      },
    });
    const onConfirm = vi.fn<RequestConfirmation>(async () => false);
    const { unmount } = renderClaude(onConfirm);

    fireEvent.click(await screen.findByRole('button', { name: '恢复原配置' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: '恢复 Claude 原配置？' })));
    expect(invoke).not.toHaveBeenCalledWith('restore_claude_statusline_setup', expect.anything());

    onConfirm.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: '恢复原配置' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('restore_claude_statusline_setup', { force: false }));
    expect(await screen.findByText('已恢复原配置')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '一键接入' })).toBeInTheDocument();
    unmount();

    current = { ...backup, restorableWithoutForce: false };
    renderClaude(onConfirm);
    fireEvent.click(await screen.findByRole('button', { name: '恢复原配置' }));
    await waitFor(() => expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({
      title: '强制恢复 Claude 原配置？',
      confirmLabel: '强制恢复',
      tone: 'danger',
    })));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('restore_claude_statusline_setup', { force: true }));
  });
});

describe('额度来源状态卡（T10.283）', () => {
  const now = Date.parse('2026-10-04T08:00:00Z');
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const codexId = 'openai-codex-local';

  it('五种状态只由开关、检测与既有 envelope 推导', () => {
    const notInstalled = quotaSourceCardView({ name: 'Codex', enabled: false, installed: false, provider: undefined, now });
    expect(notInstalled).toMatchObject({ state: 'not-installed', label: '未安装', action: 'install', windows: [] });

    const pending = quotaSourceCardView({ name: 'Codex', enabled: false, installed: true, provider: undefined, now });
    expect(pending).toMatchObject({ state: 'needs-authorization', label: '待授权', action: null });

    const connected = quotaSourceCardView({
      name: 'Codex',
      enabled: true,
      installed: true,
      provider: sourceProvider(codexId, { windows: [quotaWindow(codexId, { observedAt: at(5) })] }),
      now,
    });
    expect(connected.state).toBe('connected');
    expect(connected.label).toBe('已连接 · 5 分钟前');
    expect(connected.windows).toEqual([
      { windowId: 'five-hour', label: '5 小时额度', remaining: 62, resetLabel: '115 分钟后重置' },
    ]);

    const login = quotaSourceCardView({
      name: 'Codex',
      enabled: true,
      installed: true,
      provider: sourceProvider(codexId, { status: 'error', windows: [], reasonCode: 'app_server_auth_required' }),
      now,
    });
    expect(login).toMatchObject({ state: 'login-required', label: '需在原应用登录' });
    expect(login.detail).toContain('app_server_auth_required');

    const kept = quotaSourceCardView({
      name: 'Codex',
      enabled: true,
      installed: true,
      provider: sourceProvider(codexId, {
        status: 'stale',
        reasonCode: 'app_server_timeout',
        windows: [quotaWindow(codexId, { status: 'stale', observedAt: at(90), reasonCode: 'observation_stale' })],
      }),
      now,
    });
    expect(kept).toMatchObject({ state: 'read-failed', label: '读取失败（保留旧值）', asOf: at(90) });
    expect(kept.windows).toHaveLength(1);

    const failed = quotaSourceCardView({
      name: 'Codex',
      enabled: true,
      installed: true,
      provider: sourceProvider(codexId, { status: 'error', windows: [], reasonCode: 'provider_worker_failed' }),
      now,
    });
    expect(failed).toMatchObject({ state: 'read-failed', label: '读取失败', action: 'read', windows: [] });
    expect(failed.asOf).toBeUndefined();
  });

  it('授权尚未生效与 status line 首个快照前都归为待授权', () => {
    expect(quotaSourceCardView({
      name: 'Claude Code',
      enabled: true,
      installed: true,
      provider: claudeProvider({ status: 'auth-required', windows: [], reasonCode: 'claude_local_authorization_required' }),
      now,
    }).state).toBe('needs-authorization');
    expect(quotaSourceCardView({
      name: 'Claude Code',
      enabled: true,
      installed: true,
      provider: claudeProvider({ status: 'error', windows: [], reasonCode: 'claude_statusline_snapshot_missing' }),
      now,
    }).state).toBe('needs-authorization');
  });

  it('检测结果只接受完整条目，未知结果不置灰', () => {
    const parsed = parseQuotaSourceDetections([
      { providerId: codexId, installed: false, candidatePaths: [] },
      { providerId: 'broken' },
      'noise',
    ]);
    expect([...parsed.keys()]).toEqual([codexId]);
    expect(parseQuotaSourceDetections(undefined).size).toBe(0);
    expect(quotaSourceCardView({ name: 'Codex', enabled: false, installed: null, provider: undefined, now }).state)
      .toBe('needs-authorization');
  });

  function renderSources(
    appSettings: Partial<AppSettings>,
    quotaProviders: QuotaProviderEnvelope[] = [],
    detections: unknown = [],
    onSettingChange = vi.fn(),
  ) {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'detect_quota_sources') return Promise.resolve(detections) as never;
      return Promise.resolve([]) as never;
    });
    return render(
      <QuotaSection
        appSettings={{ ...DEFAULT_SETTINGS, ...appSettings }}
        cloudStatus={cloudStatus}
        quotaProviders={quotaProviders}
        quotaSyncStatus={quotaSyncStatus}
        busy={busyState()}
        onSettingChange={onSettingChange}
        onClaudeNativeQuotaChange={vi.fn()}
        onAntigravityLocalQuotaChange={vi.fn()}
        onAuthorizeClaudeNativeQuota={vi.fn()}
        onAuthorizeAntigravityQuota={vi.fn()}
        onQuotaSyncToggle={vi.fn()}
        onQuotaSyncNow={vi.fn()}
        onDeleteQuotaProvider={vi.fn()}
        onClearQuotaSnapshots={vi.fn()}
        onConfirm={vi.fn(async () => true)}
        onCustomQuotaChanged={vi.fn()}
      />,
    );
  }

  it('未安装的来源开关置灰并给出官方安装说明', async () => {
    renderSources({}, [], [
      { providerId: codexId, installed: false, candidatePaths: [] },
      { providerId: 'anthropic-claude-consumer', installed: true, candidatePaths: ['/usr/local/bin/claude'] },
      { providerId: 'google-antigravity-consumer', installed: false, candidatePaths: [] },
    ]);

    await waitFor(() => expect(screen.getByRole('switch', { name: '读取 Codex 额度' })).toBeDisabled());
    expect(screen.getByRole('switch', { name: '读取 Antigravity 额度' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: '读取 Claude 额度' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Codex 官方安装说明' })).toHaveAttribute('href', 'https://developers.openai.com/codex/cli');
    expect(screen.getByRole('link', { name: 'Antigravity 官方安装说明' })).toHaveAttribute('href', 'https://antigravity.google/download');
    expect(screen.getAllByText('未安装')).toHaveLength(2);
    expect(invoke).toHaveBeenCalledWith('detect_quota_sources');
  });

  it('Claude 只剩一个主开关，实验来源在默认折叠的「高级」里', () => {
    const onSettingChange = vi.fn();
    renderSources({}, [], [], onSettingChange);

    expect(screen.queryByRole('switch', { name: '允许读取 Claude Code 额度快照' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: '授权读取 Claude 订阅额度' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: '读取 Claude 额度' }));
    expect(onSettingChange).toHaveBeenCalledWith('quota_claude_enabled', true);

    const advanced = screen.getByRole('button', { name: 'Claude：高级' });
    expect(advanced).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('switch', { name: '实验来源：内置 /usage 与 CodexBar' })).not.toBeInTheDocument();
    fireEvent.click(advanced);
    const experimental = screen.getByRole('switch', { name: '实验来源：内置 /usage 与 CodexBar' });
    expect(experimental).toHaveAttribute('aria-checked', 'false');
    expect(experimental).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Antigravity：高级' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('每张卡只有一句说明，边界说明默认折叠，失败原文在 ⓘ 里', () => {
    const { container } = renderSources(
      { quota_codex_local_enabled: true, quota_claude_enabled: true, quota_antigravity_local_enabled: true },
      [
        sourceProvider(codexId),
        claudeProvider({
          status: 'stale',
          reasonCode: 'claude_native_timeout',
          windows: [quotaWindow('anthropic-claude-consumer', { status: 'stale' })],
        }),
        sourceProvider('google-antigravity-consumer', { status: 'auth-required', windows: [], reasonCode: 'antigravity_native_authorization_required' }),
      ],
    );

    const cards = container.querySelectorAll('.quota-source-status');
    expect(cards).toHaveLength(3);
    cards.forEach((card) => expect(card.querySelectorAll('.quota-source-message p')).toHaveLength(1));
    expect(screen.getByText(/^已连接 · \d+ 分钟前$/)).toBeInTheDocument();
    expect(screen.getByText('读取失败（保留旧值）')).toBeInTheDocument();
    expect(screen.getByText(/^截至 /)).toBeInTheDocument();
    expect(screen.getByText('需在原应用登录')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Claude 详细原因：/)).toHaveAttribute('title', expect.stringContaining('claude_native_timeout'));
    expect(screen.getByRole('progressbar', { name: 'Codex 5 小时额度 剩余额度' })).toHaveAttribute('aria-valuenow', '62');
    for (const name of ['Codex', 'Claude', 'Antigravity']) {
      expect(screen.getByRole('button', { name: `${name}：权限与数据边界` })).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.getByText('本机订阅已连接').parentElement).toHaveTextContent('1/3');
    expect(screen.getByText('本机订阅已连接').parentElement).toHaveTextContent('3 个已开启 · 2 个需处理');
  });
});

describe('额度提醒设置（T10.287）', () => {
  function renderAlerts(initial: unknown, setImpl?: (settings: unknown) => Promise<unknown>) {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'get_quota_alert_settings') return Promise.resolve(initial) as never;
      if (command === 'set_quota_alert_settings') {
        const settings = (args as { settings: unknown }).settings;
        return (setImpl ? setImpl(settings) : Promise.resolve(settings)) as never;
      }
      return Promise.resolve([]) as never;
    });
    return render(
      <QuotaSection
        appSettings={DEFAULT_SETTINGS}
        cloudStatus={cloudStatus}
        quotaProviders={[]}
        quotaSyncStatus={quotaSyncStatus}
        busy={busyState()}
        onSettingChange={vi.fn()}
        onClaudeNativeQuotaChange={vi.fn()}
        onAntigravityLocalQuotaChange={vi.fn()}
        onAuthorizeClaudeNativeQuota={vi.fn()}
        onAuthorizeAntigravityQuota={vi.fn()}
        onQuotaSyncToggle={vi.fn()}
        onQuotaSyncNow={vi.fn()}
        onDeleteQuotaProvider={vi.fn()}
        onClearQuotaSnapshots={vi.fn()}
        onConfirm={vi.fn()}
        onCustomQuotaChanged={vi.fn()}
      />,
    );
  }

  it('默认关闭，默认档位 20%，关闭时档位不可改', async () => {
    renderAlerts({ enabled: false, thresholds: [20] });
    const toggle = await screen.findByRole('switch', { name: '额度不足时提醒' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: '20%' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '50%' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '5%' })).toHaveAttribute('aria-pressed', 'false');
    for (const name of ['50%', '20%', '5%']) expect(screen.getByRole('button', { name })).toBeDisabled();
  });

  it('开启后可多选档位，至少保留一档，每次改动写回 Rust', async () => {
    renderAlerts({ enabled: false, thresholds: [20] });
    const toggle = await screen.findByRole('switch', { name: '额度不足时提醒' });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_quota_alert_settings', { settings: { enabled: true, thresholds: [20] } }));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    expect(screen.getByRole('button', { name: '20%' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '5%' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_quota_alert_settings', { settings: { enabled: true, thresholds: [20, 5] } }));
    await waitFor(() => expect(screen.getByRole('button', { name: '5%' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: '50%' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_quota_alert_settings', { settings: { enabled: true, thresholds: [50, 20, 5] } }));
    await waitFor(() => expect(screen.getByRole('button', { name: '20%' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '20%' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_quota_alert_settings', { settings: { enabled: true, thresholds: [50, 5] } }));
  });

  it('保存失败时回到原值并提示', async () => {
    renderAlerts({ enabled: false, thresholds: [20] }, () => Promise.reject(new Error('disk full')));
    const toggle = await screen.findByRole('switch', { name: '额度不足时提醒' });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    expect(await screen.findByText('提醒设置未保存，请重试')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
