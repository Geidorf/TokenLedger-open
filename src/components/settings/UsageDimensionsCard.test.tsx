import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLangPreference } from '../../i18n';
import { DEFAULT_SETTINGS, type AppSettings, type BusyState } from '../../types';
import { UsageDimensionsCard, usageDimensionHint, type UsageDimensionStatus } from './UsageDimensionsCard';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const off: UsageDimensionStatus = { state: 'off', lastUploadedAt: null, error: null };
const ok: UsageDimensionStatus = { state: 'ok', lastUploadedAt: null, error: null };

function idleBusy(): BusyState {
  return { scan: false, sync: false, wallpaper: false, auth: false, config: false, settings: false, prices: false, db: false };
}

function renderCard(settings: Partial<AppSettings>, onSettingChange = vi.fn()) {
  render(
    <UsageDimensionsCard
      appSettings={{ ...DEFAULT_SETTINGS, ...settings }}
      busy={idleBusy()}
      onSettingChange={onSettingChange}
    />,
  );
  return onSettingChange;
}

describe('UsageDimensionsCard', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setLangPreference('zh');
  });

  afterEach(() => {
    vi.useRealTimers();
    setLangPreference('zh');
  });

  it('三项默认关闭，开关完全受控，并读取关闭后的清理状态', async () => {
    invokeMock.mockResolvedValue({ sessions: off, providers: off, context: off });
    const onSettingChange = renderCard({});
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(3);
    for (const item of switches) expect(item).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('usage_dimensions_publish_status'));

    const providers = screen.getByRole('switch', { name: '按账号拆分' });
    fireEvent.click(providers);
    expect(onSettingChange).toHaveBeenCalledWith('usage_dimension_providers_enabled', true);
    expect(providers).toHaveAttribute('aria-checked', 'false');
  });

  it('开启后分别显示旧云端、失败和未登录状态，不泄露原始错误', async () => {
    invokeMock.mockResolvedValue({
      sessions: { ...ok, state: 'not-deployed' },
      providers: { ...ok, state: 'error', error: 'Authorization: Bearer SECRET-TOKEN' },
      context: { ...ok, state: 'signed-out' },
    });
    renderCard({
      usage_dimension_sessions_enabled: true,
      usage_dimension_providers_enabled: true,
      usage_dimension_context_enabled: true,
    });
    expect(await screen.findByText(/云端尚未开通/)).toBeInTheDocument();
    expect(screen.getByText(/上传失败/)).toBeInTheDocument();
    expect(screen.getByText(/需要先在「云端同步」登录账户/)).toBeInTheDocument();
    expect(screen.queryByText(/SECRET-TOKEN/)).not.toBeInTheDocument();
  });

  it('开关关闭后仍显示清理中、清理失败和未登录，不能声称已清空', async () => {
    invokeMock.mockResolvedValue({
      sessions: { ...ok, state: 'clearing' },
      providers: { ...ok, state: 'error', error: 'HTTP 502: sensitive response' },
      context: { ...ok, state: 'signed-out' },
    });
    const { container } = render(
      <UsageDimensionsCard appSettings={DEFAULT_SETTINGS} busy={idleBusy()} onSettingChange={vi.fn()} />,
    );
    expect(await screen.findByText(/正在清理当前账号这一维度在所有设备的云端数据/)).toBeInTheDocument();
    const rows = container.querySelectorAll('.settings-row-hint');
    expect(rows[0]).toHaveTextContent('正在清理当前账号这一维度在所有设备的云端数据');
    expect(rows[1]).toHaveTextContent('云端清理尚未确认');
    expect(rows[2]).toHaveTextContent('需要登录原账号才能完成云端清理');
    expect(container).not.toHaveTextContent('sensitive response');
    expect(container).not.toHaveTextContent(/已经清空/);
    for (const item of screen.getAllByRole('switch')) expect(item).toHaveAttribute('aria-checked', 'false');
  });

  it('成功状态说明最近 90 天保留期与上次上传时间', () => {
    const now = Date.parse('2026-10-24T07:00:00Z');
    const text = usageDimensionHint(
      { fieldsKey: 'usageDimensions.sessions.fields' },
      { ...ok, lastUploadedAt: '2026-10-24T06:55:00Z' },
      true,
      now,
    );
    expect(text).toContain('5 分钟前');
    expect(text).toContain('90 天');
  });

  it.each(['resolve', 'reject'] as const)('忽略晚到的旧轮询 %s，保留最新清理状态', async (outcome) => {
    vi.useFakeTimers();
    let resolveOld!: (value: unknown) => void;
    let rejectOld!: (reason: Error) => void;
    invokeMock.mockImplementationOnce(() => new Promise((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    }));
    invokeMock.mockResolvedValue({
      sessions: { ...off, state: 'clearing' },
      providers: off,
      context: off,
    });
    renderCard({});
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/正在清理当前账号/)).toBeInTheDocument();

    await act(async () => {
      if (outcome === 'resolve') resolveOld({ sessions: off, providers: off, context: off });
      else rejectOld(new Error('old failure'));
    });
    expect(screen.getByText(/正在清理当前账号/)).toBeInTheDocument();
    expect(screen.queryByText(/云端清理尚未确认/)).not.toBeInTheDocument();
  });
});
