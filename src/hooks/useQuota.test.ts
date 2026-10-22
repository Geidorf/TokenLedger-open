import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings, QuotaProviderEnvelope } from '../types';
import { useQuota } from './useQuota';
import { useSettings } from './useSettings';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const invokeMock = invoke as unknown as Mock;
const NOW = Date.parse('2030-01-01T00:00:00Z');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function quotaProvider(resetOffsetMs: number): QuotaProviderEnvelope {
  const resetsAt = new Date(NOW + resetOffsetMs).toISOString();
  return {
    schemaVersion: 1,
    providerId: 'openai-codex-local',
    displayName: 'Codex',
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: 'stable',
    status: 'ok',
    windows: [{
      providerId: 'openai-codex-local',
      windowId: 'five-hour',
      windowLabel: '5 小时额度',
      scope: 'consumer-subscription',
      source: 'local-authorized',
      status: 'ok',
      used: 20,
      limit: 100,
      remaining: 80,
      unit: 'percent',
      resetsAt,
      observedAt: new Date(NOW).toISOString(),
      fetchedAt: new Date(NOW).toISOString(),
      staleAfterSeconds: 900,
    }],
  };
}

const hookProps = {
  showMessage: vi.fn(),
  confirm: vi.fn(async () => false),
  loadSettings: vi.fn(async () => {}),
  saveAppSettings: vi.fn(async () => true),
  appSettings: {} as AppSettings,
  setAppSettings: vi.fn(),
  clearPendingSettings: vi.fn(),
  setBusy: vi.fn(),
};

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

function renderQuotaWithSettings(confirm = vi.fn(async () => true)) {
  const showMessage = vi.fn();
  const setBusy = vi.fn();
  const settingsProps = {
    showMessage,
    confirm,
    loadStats: vi.fn(async () => {}),
    loadQuotas: vi.fn(async () => {}),
    loadQuotaSyncStatus: vi.fn(async () => {}),
    cloudStatus: { configured: false, authenticated: false, email: '', userId: '' },
    cloudSetup: { capabilityVerified: false, firstSyncCompleted: false },
    setSettingsAnchor: vi.fn(),
    setBusy,
  };
  const quotaProps = {
    ...hookProps,
    showMessage,
    confirm,
    setBusy,
  };
  const rendered = renderHook(() => {
    const settings = useSettings(settingsProps);
    return useQuota({ ...quotaProps, loadSettings: settings.loadSettings });
  });
  return { ...rendered, showMessage };
}

describe('useQuota reset-aware refresh（T10.102b）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    setVisibility('visible');
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('在已观察 reset 后的五秒缓冲读取本地 non-retry 来源，并且同一边界只尝试一次', async () => {
    const { result } = renderHook(() => useQuota(hookProps));
    act(() => result.current.setQuotaProviders([quotaProvider(1_000)]));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_999);
    });
    expect(invokeMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith('get_local_quota_providers');

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('隐藏时不读取，恢复可见后为先前观察到的已到期 reset 读取一次', async () => {
    setVisibility('hidden');
    const { result } = renderHook(() => useQuota(hookProps));
    act(() => result.current.setQuotaProviders([quotaProvider(1_000)]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(invokeMock).not.toHaveBeenCalled();

    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith('get_local_quota_providers');
  });

  it('初次拿到已过期窗口不立即重读，卸载后也会清理未来 reset timer', async () => {
    const expired = renderHook(() => useQuota(hookProps));
    act(() => expired.result.current.setQuotaProviders([quotaProvider(-1_000)]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(invokeMock).not.toHaveBeenCalled();
    expired.unmount();

    const future = renderHook(() => useQuota(hookProps));
    act(() => future.result.current.setQuotaProviders([quotaProvider(12_000)]));
    future.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('自动信号合并到在途读取，但用户显式 retry 仍会实际发起请求', async () => {
    let resolveAutomatic: ((value: unknown) => void) | undefined;
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => { resolveAutomatic = resolve; }));
    invokeMock.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useQuota(hookProps));
    act(() => result.current.setQuotaProviders([quotaProvider(1_000)]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      void result.current.loadQuotas(false, true);
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith('retry_local_quota_providers');

    await act(async () => {
      resolveAutomatic?.([]);
      await Promise.resolve();
    });
  });

  it('reset 到期碰到更早的在途读取时，等待其完成后仍会读取一次', async () => {
    let resolveEarlierLoad: ((value: unknown) => void) | undefined;
    invokeMock.mockImplementationOnce(() => new Promise((resolve) => { resolveEarlierLoad = resolve; }));
    invokeMock.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useQuota(hookProps));
    act(() => {
      void result.current.loadQuotas();
      result.current.setQuotaProviders([quotaProvider(1_000)]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveEarlierLoad?.([]);
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith('get_local_quota_providers');
  });

  it('reset 读取失败后不为同一边界热循环', async () => {
    invokeMock.mockRejectedValueOnce(new Error('source unavailable'));
    const { result } = renderHook(() => useQuota(hookProps));
    act(() => result.current.setQuotaProviders([quotaProvider(1_000)]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.current.quotaError).not.toBe('');
  });

  it('远端合并读取成功后，前台自动刷新延续远端模式', async () => {
    invokeMock.mockResolvedValue([quotaProvider(60 * 60_000)]);
    const { result } = renderHook(() => useQuota(hookProps));

    await act(async () => {
      await result.current.loadQuotas(true);
    });
    expect(invokeMock).toHaveBeenLastCalledWith('get_quota_providers');
    invokeMock.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith('get_quota_providers');
  });

  it('失败的远端读取不改变最近成功的本地模式', async () => {
    invokeMock
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('remote unavailable'))
      .mockResolvedValueOnce([]);
    const { result } = renderHook(() => useQuota(hookProps));

    await act(async () => {
      await result.current.loadQuotas(false);
      await result.current.loadQuotas(true);
    });
    invokeMock.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith('get_local_quota_providers');
  });

  it('失败的显式本地读取不覆盖最近成功的远端模式', async () => {
    invokeMock
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('local unavailable'))
      .mockResolvedValueOnce([]);
    const { result } = renderHook(() => useQuota(hookProps));

    await act(async () => {
      await result.current.loadQuotas(true);
      await result.current.loadQuotas(false);
    });
    invokeMock.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith('get_quota_providers');
  });

  it('仅失效在途请求时保留远端模式，绑定重置后清空并恢复本地模式', async () => {
    invokeMock.mockResolvedValue([quotaProvider(60 * 60_000)]);
    const { result } = renderHook(() => useQuota(hookProps));

    await act(async () => {
      await result.current.loadQuotas(true);
    });
    act(() => result.current.invalidateQuotaRequests());
    invokeMock.mockClear();
    await act(async () => {
      await result.current.loadQuotas();
    });
    expect(invokeMock).toHaveBeenLastCalledWith('get_quota_providers');

    act(() => result.current.resetQuotaBinding());
    expect(result.current.quotaProviders).toEqual([]);
    expect(result.current.quotaError).toBe('');
    expect(result.current.quotaLoading).toBe(false);
    invokeMock.mockClear();
    await act(async () => {
      await result.current.loadQuotas();
    });
    expect(invokeMock).toHaveBeenLastCalledWith('get_local_quota_providers');
  });

  it('绑定重置后忽略旧远端成功响应且不会继承远端模式', async () => {
    const remote = deferred<unknown>();
    invokeMock.mockReturnValueOnce(remote.promise).mockResolvedValueOnce([]);
    const { result } = renderHook(() => useQuota(hookProps));

    let remoteLoad!: Promise<boolean | undefined>;
    act(() => { remoteLoad = result.current.loadQuotas(true); });
    act(() => result.current.resetQuotaBinding());
    await act(async () => {
      remote.resolve([quotaProvider(60 * 60_000)]);
      await remoteLoad;
    });
    expect(result.current.quotaProviders).toEqual([]);

    await act(async () => {
      await result.current.loadQuotas();
    });
    expect(invokeMock).toHaveBeenLastCalledWith('get_local_quota_providers');
  });

  it('绑定重置会移除永不返回的旧读取，保留后续自动刷新能力', async () => {
    const oldRemote = deferred<unknown>();
    invokeMock.mockReturnValueOnce(oldRemote.promise).mockResolvedValueOnce([]);
    const { result } = renderHook(() => useQuota(hookProps));

    act(() => { void result.current.loadQuotas(true); });
    act(() => result.current.resetQuotaBinding());
    await act(async () => { await result.current.loadQuotas(false); });
    invokeMock.mockClear();

    act(() => result.current.setQuotaProviders([quotaProvider(1_000)]));
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });

    expect(invokeMock).toHaveBeenLastCalledWith('get_local_quota_providers');
  });
});

describe('useQuota 云端额度快照删除提示（T10.116a）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command) => {
      if (command === 'delete_quota_snapshot_provider') {
        return Promise.resolve({ enabled: true, state: 'active', lastSyncedAt: '2030-01-01T00:00:00Z' });
      }
      if (command === 'clear_quota_snapshots') {
        return Promise.resolve({ enabled: false, state: 'disabled' });
      }
      return Promise.resolve([]);
    });
    hookProps.confirm.mockReset();
    hookProps.showMessage.mockReset();
    hookProps.loadSettings.mockReset();
    hookProps.loadSettings.mockResolvedValue(undefined);
  });

  it('删除单个来源时说明范围与新观测仍可同步', async () => {
    hookProps.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result } = renderHook(() => useQuota(hookProps));

    await act(async () => {
      await result.current.deleteQuotaSnapshotProvider('openai-codex-local', 'consumer-subscription');
    });

    expect(invokeMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.deleteQuotaSnapshotProvider('openai-codex-local', 'consumer-subscription');
    });

    expect(hookProps.confirm).toHaveBeenLastCalledWith({
      title: '删除这个来源的云端额度快照？',
      description: '仅删除这个来源的云端快照；之后新的本机观测仍可同步。',
      confirmLabel: '删除快照',
      tone: 'danger',
    });
    expect(invokeMock).toHaveBeenCalledWith('delete_quota_snapshot_provider', {
      providerId: 'openai-codex-local',
      scope: 'consumer-subscription',
    });
    expect(hookProps.showMessage).toHaveBeenCalledWith(
      'success',
      '已删除这个来源的云端额度快照；新的本机观测仍可同步',
    );
  });

  it('删除全部时说明关闭本机同步及恢复方式', async () => {
    hookProps.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result } = renderHook(() => useQuota(hookProps));

    await act(async () => {
      await result.current.clearQuotaSnapshots();
    });

    expect(invokeMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.clearQuotaSnapshots();
    });

    expect(hookProps.confirm).toHaveBeenLastCalledWith({
      title: '删除全部云端额度快照？',
      description: '会删除当前账户下全部云端额度历史，包括其他设备留下的快照；无法撤销，不会删除本机用量账本。发送删除前先关闭本机额度同步；删除失败仍保持关闭，不会自动恢复，之后需手动重新启用。取消确认不会发送删除或关闭同步；发送后若超时或取消，云端结果可能未知，请先检查状态，不要当作已撤销。',
      confirmLabel: '删除全部快照',
      tone: 'danger',
    });
    expect(invokeMock).toHaveBeenCalledWith('clear_quota_snapshots');
    expect(hookProps.showMessage).toHaveBeenCalledWith(
      'success',
      '已删除全部云端额度快照，本机额度同步已关闭；如需继续同步，请重新开启它',
    );
  });
});

describe('清空额度只在明确回执后提示成功（T10.308d）', () => {
  beforeEach(() => { vi.clearAllMocks(); invokeMock.mockReset(); });

  for (const status of [
    { enabled: true, state: 'active' },
    { enabled: false, state: 'disabled', reasonCode: 'quota_sync_clear_outcome_unknown' },
    { enabled: false, state: 'error', reasonCode: 'quota_sync_remote_clear_incomplete' },
    { enabled: false, state: 'auth-required', reasonCode: 'quota_sync_auth_required' },
    { enabled: false, state: 'error', reasonCode: 'quota_sync_clear_rejected_device_stopped' },
    { enabled: true, state: 'error', reasonCode: 'quota_sync_clear_dispatch_stop_incomplete' },
  ]) {
    it(`非明确清空回执 ${status.state}/${status.reasonCode ?? 'none'} 无成功提示`, async () => {
      invokeMock.mockImplementation((command) => Promise.resolve(
        command === 'clear_quota_snapshots' ? status : { enabled: false, state: 'disabled' },
      ));
      const props = { ...hookProps, confirm: vi.fn(async () => true) };
      const { result } = renderHook(() => useQuota(props));
      await act(async () => { expect(await result.current.clearQuotaSnapshots()).toBe(false); });
      expect(props.showMessage).not.toHaveBeenCalledWith('success', expect.anything());
      expect(props.showMessage).toHaveBeenCalledWith('error', expect.any(String));
      expect(props.loadSettings).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith('get_quota_snapshot_sync_status');
      expect(invokeMock.mock.calls.filter(([command]) => command === 'clear_quota_snapshots')).toHaveLength(1);
    });
  }

  for (const [error, expected] of [
    ['quota_sync_clear_outcome_unknown: 安全说明', /可能已在云端生效.*不代表已撤销/],
    ['quota_sync_clear_outcome_unknown_local_stop_incomplete: 安全说明', /本机关闭同步也未确认/],
    ['quota_sync_clear_local_stop_incomplete: 安全说明', /云端已确认删除.*不要因这个错误重复删除/],
    ['quota_sync_clear_busy: 安全说明', /本次清空尚未发送.*稍后重新确认/],
    ['quota_sync_clear_rejected_device_stopped: 安全说明', /本次删除请求被拒绝，不能视为删除完成.*本机额度同步已关闭.*不会自动恢复/],
    ['quota_sync_clear_dispatch_stop_incomplete: 安全说明', /关闭本机同步未完成.*本次云端删除尚未发送/],
    ['HTTP 403 secret=do-not-display', /处理登录或连接问题/],
  ] as const) {
    it(`清空拒绝 ${error.split(':')[0]} 重载真实状态且不假撤销`, async () => {
      invokeMock.mockImplementation((command) => command === 'clear_quota_snapshots'
        ? Promise.reject(error)
        : Promise.resolve({ enabled: false, state: 'disabled' }));
      const props = { ...hookProps, confirm: vi.fn(async () => true) };
      const { result } = renderHook(() => useQuota(props));
      await act(async () => { expect(await result.current.clearQuotaSnapshots()).toBe(false); });
      expect(props.showMessage).toHaveBeenCalledWith('error', expect.stringMatching(expected));
      expect(props.showMessage).not.toHaveBeenCalledWith('success', expect.anything());
      expect(JSON.stringify(props.showMessage.mock.calls)).not.toContain('do-not-display');
      expect(props.loadSettings).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith('get_quota_snapshot_sync_status');
      expect(invokeMock.mock.calls.filter(([command]) => command === 'clear_quota_snapshots')).toHaveLength(1);
    });
  }

  it('成功回执后重载设置期间切换账户不显示旧账户成功', async () => {
    const settings = deferred<void>();
    invokeMock.mockImplementation((command) => Promise.resolve(command === 'clear_quota_snapshots'
      ? { enabled: false, state: 'disabled' }
      : []));
    const props = { ...hookProps, confirm: vi.fn(async () => true), loadSettings: vi.fn(() => settings.promise) };
    const { result } = renderHook(() => useQuota(props));
    let pending!: Promise<boolean>;
    await act(async () => { pending = result.current.clearQuotaSnapshots(); });
    act(() => result.current.resetQuotaBinding());
    await act(async () => { settings.resolve(); expect(await pending).toBe(false); });
    expect(props.showMessage).not.toHaveBeenCalled();
    expect(result.current.quotaSyncStatus).toEqual({ enabled: false, state: 'disabled' });
  });

  it.each([
    ['设置回读失败', true, false],
    ['额度来源回读失败', false, true],
    ['设置与额度来源回读均失败', true, true],
    ['设置与额度来源回读均成功', false, false],
  ])('%s时按真实设置 loader 结果反馈，不再次发送删除', async (_label, failSettings, failQuotas) => {
    invokeMock.mockImplementation((command) => {
      if (command === 'clear_quota_snapshots') return Promise.resolve({ enabled: false, state: 'disabled' });
      if (command === 'get_settings' && failSettings) return Promise.reject(new Error('settings read failed'));
      if (command === 'get_local_quota_providers' && failQuotas) return Promise.reject(new Error('quota read failed'));
      if (command === 'get_quota_snapshot_sync_status') return Promise.resolve({ enabled: false, state: 'disabled' });
      return Promise.resolve([]);
    });
    const { result, showMessage } = renderQuotaWithSettings();
    await act(async () => {
      expect(await result.current.clearQuotaSnapshots()).toBe(!failSettings && !failQuotas);
    });

    const clearCalls = invokeMock.mock.calls.filter(([command]) => command === 'clear_quota_snapshots');
    expect(clearCalls).toHaveLength(1);
    if (failSettings || failQuotas) {
      expect(showMessage).toHaveBeenCalledWith('error', expect.stringMatching(/云端已确认删除且本机同步已关闭.*界面状态刷新失败.*不要重复删除/));
      expect(showMessage).not.toHaveBeenCalledWith('success', expect.anything());
    } else {
      expect(showMessage).toHaveBeenCalledWith('success', '已删除全部云端额度快照，本机额度同步已关闭；如需继续同步，请重新开启它');
    }
  });

  it('额度回读被较新的成功请求取代时将本次结果标为未确认', async () => {
    const staleQuotaRead = deferred<unknown>();
    let quotaReadCount = 0;
    invokeMock.mockImplementation((command) => {
      if (command === 'clear_quota_snapshots') return Promise.resolve({ enabled: false, state: 'disabled' });
      if (command === 'get_local_quota_providers') {
        quotaReadCount += 1;
        return quotaReadCount === 1 ? staleQuotaRead.promise : Promise.resolve([]);
      }
      if (command === 'get_settings') return Promise.resolve({});
      return Promise.resolve({ enabled: false, state: 'disabled' });
    });
    const { result, showMessage } = renderQuotaWithSettings();
    let clearPending!: Promise<boolean>;
    await act(async () => { clearPending = result.current.clearQuotaSnapshots(); });
    await act(async () => { await result.current.loadQuotas(); });
    await act(async () => {
      staleQuotaRead.resolve([]);
      expect(await clearPending).toBe(false);
    });

    expect(showMessage).toHaveBeenCalledWith('warning', expect.stringMatching(/云端已确认删除且本机同步已关闭.*额度界面刷新结果尚未确认.*不要重复删除/));
    expect(showMessage).not.toHaveBeenCalledWith('success', expect.anything());
    expect(showMessage).not.toHaveBeenCalledWith('error', expect.stringContaining('界面状态刷新失败'));
    expect(invokeMock.mock.calls.filter(([command]) => command === 'clear_quota_snapshots')).toHaveLength(1);
  });

  it('额度回读被较新的失败请求取代时反馈未确认而非推断结果', async () => {
    const staleQuotaRead = deferred<unknown>();
    let quotaReadCount = 0;
    invokeMock.mockImplementation((command) => {
      if (command === 'clear_quota_snapshots') return Promise.resolve({ enabled: false, state: 'disabled' });
      if (command === 'get_local_quota_providers') {
        quotaReadCount += 1;
        return quotaReadCount === 1 ? staleQuotaRead.promise : Promise.reject(new Error('newer quota read failed'));
      }
      if (command === 'get_settings') return Promise.resolve({});
      return Promise.resolve({ enabled: false, state: 'disabled' });
    });
    const { result, showMessage } = renderQuotaWithSettings();
    let clearPending!: Promise<boolean>;
    await act(async () => { clearPending = result.current.clearQuotaSnapshots(); });
    await act(async () => { expect(await result.current.loadQuotas()).toBe(false); });
    await act(async () => {
      staleQuotaRead.resolve([]);
      expect(await clearPending).toBe(false);
    });

    expect(showMessage).toHaveBeenCalledWith('warning', expect.stringMatching(/额度界面刷新结果尚未确认.*不要重复删除/));
    expect(showMessage).not.toHaveBeenCalledWith('success', expect.anything());
    expect(invokeMock.mock.calls.filter(([command]) => command === 'clear_quota_snapshots')).toHaveLength(1);
  });

  it('额度回读仍在途时本次清空回报未确认且不等待新请求', async () => {
    const staleQuotaRead = deferred<unknown>();
    const newerQuotaRead = deferred<unknown>();
    let quotaReadCount = 0;
    invokeMock.mockImplementation((command) => {
      if (command === 'clear_quota_snapshots') return Promise.resolve({ enabled: false, state: 'disabled' });
      if (command === 'get_local_quota_providers') {
        quotaReadCount += 1;
        return quotaReadCount === 1 ? staleQuotaRead.promise : newerQuotaRead.promise;
      }
      if (command === 'get_settings') return Promise.resolve({});
      return Promise.resolve({ enabled: false, state: 'disabled' });
    });
    const { result, showMessage } = renderQuotaWithSettings();
    let clearPending!: Promise<boolean>;
    await act(async () => { clearPending = result.current.clearQuotaSnapshots(); });
    let newerPending!: Promise<boolean | undefined>;
    act(() => { newerPending = result.current.loadQuotas(); });
    await act(async () => {
      staleQuotaRead.resolve([]);
      expect(await clearPending).toBe(false);
    });

    expect(showMessage).toHaveBeenCalledWith('warning', expect.stringMatching(/额度界面刷新结果尚未确认.*不要重复删除/));
    expect(showMessage).not.toHaveBeenCalledWith('success', expect.anything());
    await act(async () => {
      newerQuotaRead.resolve([]);
      await newerPending;
    });
    expect(showMessage).not.toHaveBeenCalledWith('success', expect.anything());
    expect(invokeMock.mock.calls.filter(([command]) => command === 'clear_quota_snapshots')).toHaveLength(1);
  });

  it('删除已确认但设置重载拒绝，不混淆为云端撤销或建议再次删除', async () => {
    invokeMock.mockImplementation((command) => Promise.resolve(command === 'clear_quota_snapshots'
      ? { enabled: false, state: 'disabled' }
      : []));
    const props = { ...hookProps, confirm: vi.fn(async () => true), loadSettings: vi.fn(async () => { throw new Error('reload failed'); }) };
    const { result } = renderHook(() => useQuota(props));
    await act(async () => { expect(await result.current.clearQuotaSnapshots()).toBe(false); });
    expect(props.showMessage).toHaveBeenCalledWith('error', expect.stringMatching(/云端已确认删除且本机同步已关闭.*界面状态刷新失败.*不要重复删除/));
    expect(props.showMessage).not.toHaveBeenCalledWith('success', expect.anything());
  });

  it('未知结果后设置重载也失败仍保持原未知反馈，不抛异常或重复清空', async () => {
    invokeMock.mockImplementation((command) => command === 'clear_quota_snapshots'
      ? Promise.reject('quota_sync_clear_outcome_unknown: safe')
      : Promise.resolve({ enabled: false, state: 'error', reasonCode: 'quota_sync_clear_outcome_unknown' }));
    const props = { ...hookProps, confirm: vi.fn(async () => true), loadSettings: vi.fn(async () => { throw new Error('reload failed'); }) };
    const { result } = renderHook(() => useQuota(props));
    await act(async () => { expect(await result.current.clearQuotaSnapshots()).toBe(false); });
    expect(props.showMessage).toHaveBeenCalledExactlyOnceWith('error', expect.stringMatching(/可能已在云端生效.*不代表已撤销/));
    expect(invokeMock.mock.calls.filter(([command]) => command === 'clear_quota_snapshots')).toHaveLength(1);
  });
});


describe('云端额度删除的绑定隔离（T10.134）', () => {
  beforeEach(() => { vi.clearAllMocks(); invokeMock.mockReset(); });
  for (const action of ['deleteQuotaSnapshotProvider', 'clearQuotaSnapshots'] as const) {
    for (const fails of [false, true]) {
      it(action + (fails ? '：过期失败不提示或重载' : '：过期成功不恢复旧状态'), async () => {
        const response = deferred<unknown>();
        invokeMock.mockImplementation(() => response.promise);
        const props = { ...hookProps, confirm: vi.fn(async () => true) };
        const { result } = renderHook(() => useQuota(props));
        let pending!: Promise<boolean>;
        await act(async () => { pending = result.current[action]('provider', 'scope'); });
        act(() => result.current.resetQuotaBinding());
        await act(async () => {
          if (fails) response.reject(new Error('old binding'));
          else response.resolve({ enabled: true, state: 'active' });
          expect(await pending).toBe(false);
        });
        expect(result.current.quotaSyncStatus).toEqual({ enabled: false, state: 'disabled' });
        expect(props.showMessage).not.toHaveBeenCalled();
        expect(props.loadSettings).not.toHaveBeenCalled();
        expect(invokeMock).toHaveBeenCalledTimes(1);
      });
    }
    it(action + '：确认期间切换绑定不会向新账户发出删除', async () => {
      const confirmation = deferred<boolean>();
      const { result } = renderHook(() => useQuota({ ...hookProps, confirm: () => confirmation.promise }));
      let pending!: Promise<boolean>;
      act(() => { pending = result.current[action]('provider', 'scope'); });
      act(() => result.current.resetQuotaBinding());
      await act(async () => { confirmation.resolve(true); expect(await pending).toBe(false); });
      expect(invokeMock).not.toHaveBeenCalled();
    });
  }
});


describe('额度同步异步收尾（T10.134）', () => {
  beforeEach(() => { vi.clearAllMocks(); invokeMock.mockReset(); });
  it('旧删除完成不会解除新同步操作的忙状态', async () => {
    const deletion = deferred<unknown>();
    const syncing = deferred<unknown>();
    invokeMock.mockImplementation((command) => command === 'delete_quota_snapshot_provider' ? deletion.promise : syncing.promise);
    let busy = { settings: false };
    const props = { ...hookProps, confirm: vi.fn(async () => true), setBusy: (update: (value: typeof busy) => typeof busy) => { busy = update(busy); } };
    const { result } = renderHook(() => useQuota(props));
    let old!: Promise<boolean>;
    let current!: Promise<void>;
    await act(async () => { old = result.current.deleteQuotaSnapshotProvider('provider', 'scope'); });
    act(() => result.current.resetQuotaBinding());
    act(() => { current = result.current.syncQuotaSnapshotsNow(); });
    await act(async () => { deletion.resolve({ enabled: true, state: 'active' }); await old; });
    expect(busy.settings).toBe(true);
    await act(async () => { syncing.resolve({ enabled: true, state: 'active' }); await current; });
    expect(busy.settings).toBe(false);
  });
  for (const action of ['syncQuotaSnapshotsNow', 'toggleQuotaSnapshotSync'] as const) {
    it(action + '：设置重载期间退出不再显示旧成功提示', async () => {
      invokeMock.mockResolvedValue({ enabled: true, state: 'active' });
      const settings = deferred<void>();
      const props = { ...hookProps, loadSettings: vi.fn(() => settings.promise) };
      const { result } = renderHook(() => useQuota(props));
      let pending!: Promise<void>;
      await act(async () => { pending = result.current[action](true); });
      act(() => result.current.resetQuotaBinding());
      await act(async () => { settings.resolve(); await pending; });
      expect(props.showMessage).not.toHaveBeenCalled();
      expect(result.current.quotaSyncStatus).toEqual({ enabled: false, state: 'disabled' });
    });
  }
});


it('同一账户的状态刷新不会撤销用户正在确认的删除', async () => {
  vi.clearAllMocks();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command) => command === 'get_local_quota_providers' ? [] : { enabled: true, state: 'active' });
  const confirmation = deferred<boolean>();
  const { result } = renderHook(() => useQuota({ ...hookProps, confirm: () => confirmation.promise }));
  let pending!: Promise<boolean>;
  act(() => { pending = result.current.deleteQuotaSnapshotProvider('provider', 'scope'); });
  await act(async () => { await result.current.loadQuotaSyncStatus(); });
  await act(async () => { confirmation.resolve(true); expect(await pending).toBe(true); });
  expect(invokeMock).toHaveBeenCalledWith('delete_quota_snapshot_provider', { providerId: 'provider', scope: 'scope' });
});


it('删除期间的后台读取不取消删除，迟到读取也不能覆盖删除结果', async () => {
  vi.clearAllMocks();
  invokeMock.mockReset();
  const deletion = deferred<unknown>();
  const statusRead = deferred<unknown>();
  invokeMock.mockImplementation((command) => {
    if (command === 'delete_quota_snapshot_provider') return deletion.promise;
    if (command === 'get_quota_snapshot_sync_status') return statusRead.promise;
    return Promise.resolve([]);
  });
  const { result } = renderHook(() => useQuota({ ...hookProps, confirm: vi.fn(async () => true) }));
  let pending!: Promise<boolean>;
  let reading!: Promise<void>;
  await act(async () => { pending = result.current.deleteQuotaSnapshotProvider('provider', 'scope'); });
  act(() => { reading = result.current.loadQuotaSyncStatus(); });
  await act(async () => { deletion.resolve({ enabled: false, state: 'disabled' }); expect(await pending).toBe(true); });
  await act(async () => { statusRead.resolve({ enabled: true, state: 'active' }); await reading; });
  expect(result.current.quotaSyncStatus).toEqual({ enabled: false, state: 'disabled' });
  expect(invokeMock).toHaveBeenCalledWith('get_local_quota_providers');
  expect(hookProps.showMessage).toHaveBeenCalledTimes(1);
});

describe('quota alert settings helpers (T10.287)', () => {
  it('parses only the closed threshold set and falls back to the 20% default', async () => {
    const { parseQuotaAlertSettings, DEFAULT_QUOTA_ALERT_SETTINGS } = await import('./useQuota');
    expect(DEFAULT_QUOTA_ALERT_SETTINGS).toEqual({ enabled: false, thresholds: [20] });
    expect(parseQuotaAlertSettings(null)).toEqual({ enabled: false, thresholds: [20] });
    expect(parseQuotaAlertSettings({ enabled: 'yes', thresholds: [7, 99] })).toEqual({ enabled: false, thresholds: [20] });
    expect(parseQuotaAlertSettings({ enabled: true, thresholds: [5, 50, 5] })).toEqual({ enabled: true, thresholds: [50, 5] });
  });

  it('toggles thresholds in canonical order and never empties the selection', async () => {
    const { toggleQuotaAlertThreshold } = await import('./useQuota');
    expect(toggleQuotaAlertThreshold([20], 5)).toEqual([20, 5]);
    expect(toggleQuotaAlertThreshold([20, 5], 50)).toEqual([50, 20, 5]);
    expect(toggleQuotaAlertThreshold([50, 20], 50)).toEqual([20]);
    expect(toggleQuotaAlertThreshold([20], 20)).toEqual([20]);
  });
});
