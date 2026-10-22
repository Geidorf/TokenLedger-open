import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { CloudStatus } from '../types';
import { useCloud } from './useCloud';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const STATUS_A: CloudStatus = {
  configured: true,
  authenticated: true,
  email: 'a@example.com',
  userId: 'user-a',
};

const STATUS_B: CloudStatus = {
  configured: true,
  authenticated: true,
  email: 'b@example.com',
  userId: 'user-b',
};

describe('useCloud 请求代次', () => {
  const showMessage = vi.fn();
  const onClearCloudScopedState = vi.fn();

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    showMessage.mockReset();
    onClearCloudScopedState.mockReset();
  });

  it.each(['signIn', 'signUp'] as const)('鉴权%s拒绝后释放忙碌、清空密码并安全显示错误', async (mode) => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Supabase authentication timed out. Please retry.'));
    const { result } = renderHook(() => useCloud({ showMessage, onClearCloudScopedState, currentTimezone: () => 'Asia/Shanghai' }));
    act(() => result.current.setAuthForm({ email: 'a@example.com', password: 'test-password' }));
    let busy = { auth: false };
    const setBusy = vi.fn((update) => { busy = update(busy); });
    await act(async () => { await result.current.submitAuth(mode, setBusy, vi.fn()); });
    expect(busy.auth).toBe(false);
    expect(result.current.authForm.password).toBe('');
    expect(result.current.cloudAuthError).toBe('登录服务响应超时，请检查网络后重试。');
    expect(showMessage).toHaveBeenCalledWith('error', expect.stringContaining('响应超时'));
  });

  it('鉴权未知错误不会显示服务器响应、密码、邮箱或项目钥匙', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('body: a@example.com test-password sb_publishable_private https://secret.invalid'));
    const { result } = renderHook(() => useCloud({ showMessage, onClearCloudScopedState, currentTimezone: () => 'Asia/Shanghai' }));
    act(() => result.current.setAuthForm({ email: 'a@example.com', password: 'test-password' }));
    await act(async () => { await result.current.submitAuth('signIn', vi.fn(), vi.fn()); });
    expect(result.current.cloudAuthError).toBe('登录服务暂时不可用，请稍后重试。');
    expect(JSON.stringify(showMessage.mock.calls)).not.toMatch(/test-password|sb_publishable_private|secret\.invalid|a@example\.com/);
  });

  it.each(['退出', '改配置', '卸载'] as const)('%s立即释放鉴权忙碌，迟到响应不显示或刷新旧会话', async (boundary) => {
    for (const fails of [false, true]) {
      const pending = deferred<{ message: string }>();
      vi.mocked(invoke).mockReturnValueOnce(pending.promise);
      const quotaReload = vi.fn();
      const { result, unmount } = renderHook(() => useCloud({ showMessage, onClearCloudScopedState, currentTimezone: () => 'Asia/Shanghai' }));
      act(() => result.current.setAuthForm({ email: 'a@example.com', password: 'test-password' }));
      let busy = { auth: false };
      const setBusy = vi.fn((update) => { busy = update(busy); });
      let request!: Promise<void>;
      act(() => { request = result.current.submitAuth('signUp', setBusy, quotaReload); });
      expect(busy.auth).toBe(true);
      act(() => {
        if (boundary === '退出') result.current.invalidateCloudRequests();
        else if (boundary === '改配置') result.current.setActiveCloudConfig({ supabase_url: 'https://other.supabase.co', supabase_key: 'other-key' });
        else unmount();
      });
      expect(busy.auth).toBe(false);
      if (boundary !== '卸载') expect(result.current.authForm.password).toBe('');
      await act(async () => {
        if (fails) pending.reject(new Error('old response with test-password'));
        else pending.resolve({ message: 'old signup success' });
        await request;
      });
      expect(showMessage).not.toHaveBeenCalled();
      expect(quotaReload).not.toHaveBeenCalled();
      expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'get_cloud_status')).toHaveLength(0);
      if (boundary !== '卸载') {
        expect(result.current.cloudAuthError).toBe('');
        unmount();
      }
    }
  });

  it('旧鉴权收尾不会释放新鉴权的忙碌或清除新输入的密码', async () => {
    const oldRequest = deferred<{ message: string }>();
    const newRequest = deferred<{ message: string }>();
    vi.mocked(invoke).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const { result } = renderHook(() => useCloud({ showMessage, onClearCloudScopedState, currentTimezone: () => 'Asia/Shanghai' }));
    act(() => result.current.setAuthForm({ email: 'a@example.com', password: 'old-password' }));
    let busy = { auth: false };
    const setBusy = vi.fn((update) => { busy = update(busy); });
    let oldPromise!: Promise<void>;
    let newPromise!: Promise<void>;
    act(() => { oldPromise = result.current.submitAuth('signIn', setBusy, vi.fn()); });
    act(() => {
      result.current.invalidateCloudRequests();
      result.current.setAuthForm({ email: 'b@example.com', password: 'new-password' });
    });
    act(() => { newPromise = result.current.submitAuth('signIn', setBusy, vi.fn()); });
    act(() => result.current.setAuthForm({ email: 'b@example.com', password: 'still-editing' }));
    await act(async () => { oldRequest.reject(new Error('old failure')); await oldPromise; });
    expect(busy.auth).toBe(true);
    expect(result.current.authForm.password).toBe('still-editing');
    expect(showMessage).not.toHaveBeenCalled();
    await act(async () => { newRequest.reject(new Error('current failure')); await newPromise; });
    expect(busy.auth).toBe(false);
    expect(result.current.authForm.password).toBe('');
  });

  it.each([false, true])('同配置保存（失败=%s）保留在途鉴权代次和忙碌直至鉴权结束', async (saveFails) => {
    const pendingAuth = deferred<{ message: string }>();
    const pendingSave = deferred<{ message: string }>();
    let authenticated = false;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'supabase_sign_in') return pendingAuth.promise;
      if (command === 'save_cloud_config') return pendingSave.promise;
      return Promise.resolve(authenticated ? STATUS_A : { ...STATUS_A, authenticated: false, email: '', userId: '' });
    });
    const { result } = renderHook(() => useCloud({ showMessage, onClearCloudScopedState, currentTimezone: () => 'Asia/Shanghai' }));
    const config = { supabase_url: 'https://fixture.supabase.co', supabase_key: 'sb_publishable_fixture_key' };
    act(() => {
      result.current.setActiveCloudConfig(config);
      result.current.setCloudConfig({ supabase_url: ` ${config.supabase_url}/ `, supabase_key: ` ${config.supabase_key} ` });
      result.current.setAuthForm({ email: 'a@example.com', password: 'test-password' });
    });
    let busy = { auth: false, config: false };
    const setBusy = vi.fn((update) => { busy = update(busy); });
    const quotaReload = vi.fn().mockResolvedValue(undefined);
    let authRequest!: Promise<void>;
    let saveRequest!: Promise<void>;
    act(() => { authRequest = result.current.submitAuth('signIn', setBusy, quotaReload); });
    act(() => { saveRequest = result.current.saveConfig({ preventDefault: vi.fn() } as unknown as React.FormEvent, setBusy); });
    expect(busy).toEqual({ auth: true, config: true });
    expect(invoke).toHaveBeenCalledWith('save_cloud_config', { config });
    await act(async () => {
      if (saveFails) pendingSave.reject(new Error('injected save failure'));
      else pendingSave.resolve({ message: 'same config saved' });
      await saveRequest;
    });
    expect(busy).toEqual({ auth: true, config: false });
    expect(quotaReload).not.toHaveBeenCalled();
    await act(async () => {
      authenticated = true;
      pendingAuth.resolve({ message: 'current auth success' });
      await authRequest;
    });
    expect(busy.auth).toBe(false);
    expect(result.current.cloudStatus).toEqual(STATUS_A);
    expect(showMessage).toHaveBeenCalledWith('success', 'current auth success');
    expect(quotaReload).toHaveBeenCalledOnce();
  });

  it('同配置赋值不会忽略在途鉴权错误或释放忙碌', async () => {
    const pending = deferred<{ message: string }>();
    vi.mocked(invoke).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useCloud({ showMessage, onClearCloudScopedState, currentTimezone: () => 'Asia/Shanghai' }));
    const config = { supabase_url: 'https://fixture.supabase.co', supabase_key: 'sb_publishable_fixture_key' };
    act(() => {
      result.current.setActiveCloudConfig(config);
      result.current.setAuthForm({ email: 'a@example.com', password: 'test-password' });
    });
    let busy = { auth: false };
    const setBusy = vi.fn((update) => { busy = update(busy); });
    let request!: Promise<void>;
    act(() => { request = result.current.submitAuth('signIn', setBusy, vi.fn()); });
    act(() => result.current.setActiveCloudConfig({ ...config }));
    expect(busy.auth).toBe(true);
    await act(async () => {
      pending.reject(new Error('Supabase authentication timed out. Please retry.'));
      await request;
    });
    expect(busy.auth).toBe(false);
    expect(result.current.cloudAuthError).toContain('响应超时');
  });

  it('鉴权成功后独立释放忙碌，不等待后续状态刷新结束', async () => {
    const status = deferred<CloudStatus>();
    vi.mocked(invoke).mockResolvedValueOnce({ message: 'Signed in to Supabase.' }).mockReturnValueOnce(status.promise);
    const { result } = renderHook(() => useCloud({ showMessage, onClearCloudScopedState, currentTimezone: () => 'Asia/Shanghai' }));
    act(() => result.current.setAuthForm({ email: 'a@example.com', password: 'test-password' }));
    let busy = { auth: false };
    const setBusy = vi.fn((update) => { busy = update(busy); });
    let request!: Promise<void>;
    await act(async () => { request = result.current.submitAuth('signIn', setBusy, vi.fn().mockResolvedValue(undefined)); });
    expect(busy.auth).toBe(false);
    expect(result.current.authForm.password).toBe('');
    await act(async () => { status.resolve(STATUS_A); await request; });
    expect(result.current.cloudStatus).toEqual(STATUS_A);
  });

  it('只允许最后一次状态检查写回', async () => {
    const first = deferred<CloudStatus>();
    const second = deferred<CloudStatus>();
    vi.mocked(invoke)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useCloud({
      showMessage,
      onClearCloudScopedState,
      currentTimezone: () => 'Asia/Shanghai',
    }));

    let firstRequest!: Promise<CloudStatus>;
    let secondRequest!: Promise<CloudStatus>;
    act(() => {
      firstRequest = result.current.refreshCloudStatus();
      secondRequest = result.current.refreshCloudStatus();
    });
    await act(async () => {
      second.resolve(STATUS_B);
      await secondRequest;
    });
    await act(async () => {
      first.resolve(STATUS_A);
      await firstRequest;
    });

    expect(result.current.cloudStatus).toEqual(STATUS_B);
    expect(result.current.authForm.email).toBe('b@example.com');
  });

  it.each([
    ['成功', (request: ReturnType<typeof deferred<CloudStatus>>) => request.resolve(STATUS_A)],
    ['失败', (request: ReturnType<typeof deferred<CloudStatus>>) => request.reject(new Error('old failure'))],
  ])('退出边界后忽略旧状态检查%s结果', async (_label, settle) => {
    const pending = deferred<CloudStatus>();
    vi.mocked(invoke).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useCloud({
      showMessage,
      onClearCloudScopedState,
      currentTimezone: () => 'Asia/Shanghai',
    }));

    let request!: Promise<CloudStatus>;
    act(() => { request = result.current.refreshCloudStatus(); });
    act(() => result.current.invalidateCloudRequests());
    await act(async () => {
      settle(pending);
      await request;
    });

    expect(result.current.cloudStatus.authenticated).toBe(false);
    expect(result.current.cloudStatusKnown).toBe(false);
    expect(result.current.cloudStatusError).toBe('');
    expect(showMessage).not.toHaveBeenCalled();
  });

  it('配置切换立即失效旧请求，新的身份结果保持最终状态', async () => {
    const oldRequest = deferred<CloudStatus>();
    const newRequest = deferred<CloudStatus>();
    vi.mocked(invoke)
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    const { result } = renderHook(() => useCloud({
      showMessage,
      onClearCloudScopedState,
      currentTimezone: () => 'Asia/Shanghai',
    }));

    let oldPromise!: Promise<CloudStatus>;
    act(() => { oldPromise = result.current.refreshCloudStatus(); });
    act(() => result.current.setActiveCloudConfig({
      supabase_url: 'https://new-project.supabase.co',
      supabase_key: 'publishable',
    }));
    let newPromise!: Promise<CloudStatus>;
    act(() => { newPromise = result.current.refreshCloudStatus(); });
    await act(async () => {
      newRequest.resolve(STATUS_B);
      await newPromise;
    });
    await act(async () => {
      oldRequest.resolve(STATUS_A);
      await oldPromise;
    });

    expect(result.current.activeCloudConfig.supabase_url).toContain('new-project');
    expect(result.current.cloudStatus).toEqual(STATUS_B);
  });

  it('切换配置后状态读取失败不会保留旧账户为已登录', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(STATUS_A)
      .mockRejectedValueOnce(new Error('new project keychain unavailable'));
    const { result } = renderHook(() => useCloud({
      showMessage,
      onClearCloudScopedState,
      currentTimezone: () => 'Asia/Shanghai',
    }));

    await act(async () => { await result.current.refreshCloudStatus(); });
    act(() => result.current.setActiveCloudConfig({
      supabase_url: 'https://new-project.supabase.co',
      supabase_key: 'publishable',
    }));
    await act(async () => { await result.current.refreshCloudStatus(); });

    expect(result.current.cloudStatus.authenticated).toBe(false);
    expect(result.current.cloudStatusKnown).toBe(false);
  });

  it.each([
    ['成功响应', (request: ReturnType<typeof deferred<unknown>>) => request.resolve({})],
    ['失败响应', (request: ReturnType<typeof deferred<unknown>>) => request.reject(new Error('old capability failure'))],
  ])('退出边界后忽略旧能力验证的%s', async (_label, settle) => {
    const statusRequest = deferred<CloudStatus>();
    const capabilityRequest = deferred<unknown>();
    vi.mocked(invoke)
      .mockReturnValueOnce(statusRequest.promise)
      .mockReturnValueOnce(capabilityRequest.promise);
    const { result } = renderHook(() => useCloud({
      showMessage,
      onClearCloudScopedState,
      currentTimezone: () => 'Asia/Shanghai',
    }));

    let statusPromise!: Promise<CloudStatus>;
    act(() => { statusPromise = result.current.refreshCloudStatus(); });
    await act(async () => {
      statusRequest.resolve(STATUS_A);
      await statusPromise;
    });
    let capabilityPromise!: Promise<void>;
    act(() => { capabilityPromise = result.current.verifyCloudCapability(); });
    act(() => result.current.invalidateCloudRequests());
    await act(async () => {
      settle(capabilityRequest);
      await capabilityPromise;
    });

    expect(result.current.cloudSetup.capabilityVerified).toBe(false);
    expect(result.current.cloudSetup.validating).toBe(false);
    expect(result.current.cloudSetup.lastError).toBe('');
    expect(showMessage).not.toHaveBeenCalledWith('success', 'Stats v2 能力验证通过');
    expect(showMessage).not.toHaveBeenCalledWith('error', expect.any(String));
  });

  it('状态检查和能力验证共享同一请求代次', async () => {
    const capabilityRequest = deferred<unknown>();
    const statusRequest = deferred<CloudStatus>();
    vi.mocked(invoke)
      .mockReturnValueOnce(capabilityRequest.promise)
      .mockReturnValueOnce(statusRequest.promise);
    const { result } = renderHook(() => useCloud({
      showMessage,
      onClearCloudScopedState,
      currentTimezone: () => 'Asia/Shanghai',
    }));

    act(() => result.current.setCloudStatus(STATUS_A));
    let capabilityPromise!: Promise<void>;
    let statusPromise!: Promise<CloudStatus>;
    act(() => {
      capabilityPromise = result.current.verifyCloudCapability();
      statusPromise = result.current.refreshCloudStatus();
    });
    await act(async () => {
      statusRequest.resolve(STATUS_B);
      await statusPromise;
    });
    await act(async () => {
      capabilityRequest.resolve({});
      await capabilityPromise;
    });

    expect(result.current.cloudStatus).toEqual(STATUS_B);
    expect(result.current.cloudSetup.capabilityVerified).toBe(false);
    expect(result.current.cloudSetup.lastError).toBe('');
    expect(showMessage).not.toHaveBeenCalledWith('error', expect.any(String));
  });

  it('同一账户重启并主动检查状态后恢复设置，不复用另一个账户的记录', async () => {
    window.localStorage.clear();
    vi.mocked(invoke).mockResolvedValue(STATUS_A);
    const { result, unmount } = renderHook(() => useCloud({
      showMessage,
      onClearCloudScopedState,
      currentTimezone: () => 'Asia/Shanghai',
    }));

    act(() => {
      result.current.setActiveCloudConfig({
        supabase_url: 'https://test-project.supabase.co',
        supabase_key: 'test-key',
      });
    });
    await act(async () => { await result.current.refreshCloudStatus(); });
    act(() => {
      result.current.setCloudSetup({
        capabilityVerified: true,
        firstSyncCompleted: true,
        validating: false,
        lastError: '',
      });
    });

    expect(result.current.cloudSetup.capabilityVerified).toBe(true);
    expect(result.current.cloudSetup.firstSyncCompleted).toBe(true);
    unmount();

    // 模拟软件重新启动：公开配置可读，但会话须等待用户主动检查。
    const secondHook = renderHook(() => useCloud({
      showMessage,
      onClearCloudScopedState,
      currentTimezone: () => 'Asia/Shanghai',
    }));

    act(() => {
      secondHook.result.current.setActiveCloudConfig({
        supabase_url: 'https://test-project.supabase.co',
        supabase_key: 'test-key',
      });
    });

    expect(secondHook.result.current.cloudSetup.capabilityVerified).toBe(false);
    expect(secondHook.result.current.cloudSetup.firstSyncCompleted).toBe(false);

    await act(async () => { await secondHook.result.current.refreshCloudStatus(); });
    expect(secondHook.result.current.cloudSetup.capabilityVerified).toBe(true);
    expect(secondHook.result.current.cloudSetup.firstSyncCompleted).toBe(true);

    vi.mocked(invoke).mockResolvedValueOnce(STATUS_B);
    await act(async () => { await secondHook.result.current.refreshCloudStatus(); });
    expect(secondHook.result.current.cloudSetup.capabilityVerified).toBe(false);
    expect(secondHook.result.current.cloudSetup.firstSyncCompleted).toBe(false);

    await act(async () => { await secondHook.result.current.refreshCloudStatus(); });
    expect(secondHook.result.current.cloudSetup.capabilityVerified).toBe(true);
    expect(secondHook.result.current.cloudSetup.firstSyncCompleted).toBe(true);
  });
});
