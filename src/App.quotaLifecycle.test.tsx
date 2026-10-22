import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import ts from 'typescript';
import appSource from './App.tsx?raw';
import { useQuota } from './hooks/useQuota';
import type { AppSettings, CloudConfig } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);
const emptyConfig = { supabase_url: '', supabase_key: '' };
const savedConfig = { supabase_url: 'https://example.invalid', supabase_key: 'public-test-key' };
const props = {
  showMessage: vi.fn(), confirm: vi.fn(async () => false),
  loadSettings: vi.fn(async () => {}), saveAppSettings: vi.fn(async () => true),
  appSettings: {} as AppSettings, setAppSettings: vi.fn(), clearPendingSettings: vi.fn(), setBusy: vi.fn(),
};
const settings = { loadSettings: vi.fn(), loadPrices: vi.fn(), loadDbInfo: vi.fn(), setAppVersion: vi.fn() };
const clearCloudScopedState = vi.fn();
const loadStats = vi.fn();

// Execute the actual adjacent App effects, in their source order, with the real
// useQuota hook. Only unrelated UI/stats/settings and the native IPC are replaced.
// This guards integration ordering without maintaining a second copy of the effects.
const start = appSource.indexOf('  const quotaCloudLoadMode =');
const end = appSource.indexOf('  const checkCloudStatusAndOpenSettings =', start);
if (start < 0 || end < 0) throw new Error('App quota lifecycle boundaries changed; update the integration harness');
const compiled = ts.transpileModule(`function useAppQuotaEffects(context) {
  const { cloud, quota, activeTab, settings, clearCloudScopedState, loadStats, showMessage } = context;
  const { loadQuotas, loadQuotaSyncStatus } = quota;
  ${appSource.slice(start, end)}
}`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
const useAppQuotaEffects = new Function('useCallback', 'useEffect', 'useRef', 'useState', 'invoke',
  `${compiled}; return useAppQuotaEffects;`)(useCallback, useEffect, useRef, useState, invoke) as (context: unknown) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function useHarness({ tab = 'dashboard', identity = null as string | null, authenticated = false } = {}) {
  const quota = useQuota(props);
  const [activeCloudConfig, setActiveCloudConfig] = useState<CloudConfig>(emptyConfig);
  const observedCloudBinding = useRef<{ identity: string | null; publicKey: string } | undefined>(undefined);
  const cloud = {
    activeCloudConfig, setActiveCloudConfig, setCloudConfig: vi.fn(), observedCloudBinding,
    cloudIdentity: identity, cloudStatusKnown: authenticated, cloudStatus: { authenticated },
  };
  useAppQuotaEffects({ cloud, quota, activeTab: tab, settings, clearCloudScopedState, loadStats, showMessage: props.showMessage });
  return { quota, setActiveCloudConfig, activeCloudConfig };
}
const quotaCalls = () => invokeMock.mock.calls.filter(([command]) => /^(get|retry)(_local)?_quota_providers$/.test(command));
let config: ReturnType<typeof deferred<CloudConfig>>;
let reads: ReturnType<typeof deferred<unknown>>[];
beforeEach(() => {
  vi.clearAllMocks();
  config = deferred<CloudConfig>();
  reads = [];
  invokeMock.mockImplementation((command) => {
    if (command === 'get_cloud_config') return config.promise as Promise<never>;
    if (/^(get|retry)(_local)?_quota_providers$/.test(command)) {
      const read = deferred<unknown>(); reads.push(read); return read.promise as Promise<never>;
    }
    if (command === 'get_quota_snapshot_sync_status') return Promise.resolve({ enabled: false, state: 'disabled' }) as Promise<never>;
    return Promise.resolve('test') as Promise<never>;
  });
});
afterEach(cleanup);

describe('App quota lifecycle ordering', () => {
  it.each(['old-first', 'new-first'])('StrictMode independent config promises: %s never applies a discarded effect result', async (order) => {
    const staleConfig = deferred<CloudConfig>();
    const currentConfig = deferred<CloudConfig>();
    invokeMock.mockImplementationOnce(() => staleConfig.promise as Promise<never>);
    // The first effect also invokes get_app_version before StrictMode replays.
    invokeMock.mockImplementationOnce(() => Promise.resolve('test') as Promise<never>);
    invokeMock.mockImplementationOnce(() => currentConfig.promise as Promise<never>);
    const { result } = renderHook(() => useHarness(), { wrapper: StrictMode });
    expect(invokeMock.mock.calls.filter(([command]) => command === 'get_cloud_config')).toHaveLength(2);
    const old = { ...savedConfig, supabase_key: 'old-public-key' };
    if (order === 'old-first') {
      await act(async () => staleConfig.resolve(old));
      expect(quotaCalls()).toHaveLength(0);
      expect(result.current.activeCloudConfig).toEqual(emptyConfig);
      await act(async () => currentConfig.resolve(savedConfig));
    } else {
      await act(async () => currentConfig.resolve(savedConfig));
      await act(async () => staleConfig.resolve(old));
    }
    expect(result.current.activeCloudConfig).toEqual(savedConfig);
    expect(quotaCalls()).toHaveLength(1);
    await act(async () => reads[0].resolve([]));
    expect(result.current.quota.quotaLoading).toBe(false);
  });

  it('StrictMode discarded rejection cannot report an error or unlock startup', async () => {
    const staleConfig = deferred<CloudConfig>();
    const currentConfig = deferred<CloudConfig>();
    invokeMock.mockImplementationOnce(() => staleConfig.promise as Promise<never>);
    invokeMock.mockImplementationOnce(() => Promise.resolve('test') as Promise<never>);
    invokeMock.mockImplementationOnce(() => currentConfig.promise as Promise<never>);
    renderHook(() => useHarness(), { wrapper: StrictMode });
    await act(async () => staleConfig.reject(new Error('discarded config read')));
    expect(props.showMessage).not.toHaveBeenCalled();
    expect(quotaCalls()).toHaveLength(0);
    await act(async () => currentConfig.reject(new Error('active config read')));
    expect(props.showMessage).toHaveBeenCalledTimes(1);
    expect(props.showMessage).toHaveBeenCalledWith('error', expect.stringContaining('active config read'));
    expect(quotaCalls()).toHaveLength(1);
  });

  it.each(['dashboard', 'settings'])('%s starts once under StrictMode effect replay', async (tab) => {
    const { result } = renderHook(() => useHarness({ tab }), { wrapper: StrictMode });
    await act(async () => config.resolve(savedConfig));
    expect(quotaCalls()).toHaveLength(1);
    await act(async () => reads[0].resolve([]));
    expect(result.current.quota.quotaLoading).toBe(false);
  });

  it.each([['dashboard', 'settings'], ['settings', 'dashboard']])('navigation %s to %s during config hydration starts once', async (from, to) => {
    const { rerender } = renderHook(({ tab }) => useHarness({ tab }), { initialProps: { tab: from } });
    rerender({ tab: to });
    await act(async () => config.resolve(savedConfig));
    expect(quotaCalls()).toHaveLength(1);
  });

  it('blank saved config still starts one local read', async () => {
    renderHook(() => useHarness({ tab: 'settings' }));
    await act(async () => config.resolve(emptyConfig));
    expect(quotaCalls()).toHaveLength(1);
  });

  it('returning to settings still starts the existing refresh flow', async () => {
    const { rerender } = renderHook(({ tab }) => useHarness({ tab }), { initialProps: { tab: 'settings' } });
    await act(async () => config.resolve(savedConfig));
    await act(async () => reads[0].resolve([]));
    rerender({ tab: 'dashboard' });
    expect(quotaCalls()).toHaveLength(1);
    rerender({ tab: 'settings' });
    expect(quotaCalls()).toHaveLength(2);
  });

  it('late errors after account replacement cannot overwrite the new success', async () => {
    const { result, rerender } = renderHook(({ identity }) => useHarness({ identity }), { initialProps: { identity: 'account-a' } });
    await act(async () => config.resolve(savedConfig));
    rerender({ identity: 'account-b' });
    await act(async () => reads[1].resolve([]));
    await act(async () => reads[0].reject(new Error('old account timeout')));
    expect(result.current.quota.quotaLoading).toBe(false);
    expect(result.current.quota.quotaError).toBe('');
  });

  it.each(['dashboard', 'settings'])('%s cold start sends one local read after config hydration', async (tab) => {
    const { result } = renderHook(() => useHarness({ tab }));
    await act(async () => config.resolve(savedConfig));
    expect(quotaCalls().map(([command]) => command)).toEqual(['get_local_quota_providers']);
    expect(result.current.quota.quotaLoading).toBe(true);
    await act(async () => reads[reads.length - 1].resolve([]));
    expect(result.current.quota.quotaLoading).toBe(false);
  });

  it('config rejection still starts local quotas and reports the config error', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => config.reject(new Error('fixture config unavailable')));
    expect(quotaCalls()).toHaveLength(1);
    expect(props.showMessage).toHaveBeenCalledWith('error', expect.stringContaining('读取 Supabase 配置失败'));
    await act(async () => reads[0].resolve([]));
    expect(result.current.quota.quotaLoading).toBe(false);
  });

  it.each([['identity', 'dashboard'], ['publicKey', 'dashboard'], ['identity', 'settings'], ['publicKey', 'settings']])('a genuine %s change on %s starts a separate read; old finally cannot clear new loading', async (kind, tab) => {
    const { result, rerender } = renderHook(({ identity }) => useHarness({ identity, tab }), { initialProps: { identity: null as string | null } });
    await act(async () => config.resolve(savedConfig));
    const before = reads.length;
    if (kind === 'identity') rerender({ identity: 'account-b' });
    else act(() => result.current.setActiveCloudConfig({ ...savedConfig, supabase_key: 'other-public-key' }));
    expect(reads).toHaveLength(before + 1);
    await act(async () => reads[before - 1].resolve([]));
    expect(result.current.quota.quotaLoading).toBe(true);
    await act(async () => reads[before].resolve([]));
    expect(result.current.quota.quotaLoading).toBe(false);
  });

  it('explicit secure-storage retry and ordinary refresh remain new requests', async () => {
    const { result } = renderHook(() => useHarness());
    await act(async () => config.resolve(savedConfig));
    act(() => { void result.current.quota.loadQuotas(false, true); });
    expect(quotaCalls()[quotaCalls().length - 1]?.[0]).toBe('retry_local_quota_providers');
    act(() => { void result.current.quota.loadQuotas(false); });
    expect(quotaCalls()).toHaveLength(3);
    await act(async () => reads[1].resolve([]));
    expect(result.current.quota.quotaLoading).toBe(true);
    await act(async () => reads[2].resolve([]));
    expect(result.current.quota.quotaLoading).toBe(false);
  });

  it.each(['rejection', 'parse error'])('recovers after quota %s', async (failure) => {
    const { result } = renderHook(() => useHarness());
    await act(async () => config.resolve(savedConfig));
    await act(async () => { if (failure === 'rejection') reads[reads.length - 1].reject(new Error('timeout')); else reads[reads.length - 1].resolve({ malformed: true }); });
    expect(result.current.quota.quotaLoading).toBe(false);
    expect(result.current.quota.quotaError).not.toBe('');
    act(() => { void result.current.quota.loadQuotas(false, true); });
    expect(result.current.quota.quotaError).toBe('');
    await act(async () => reads[reads.length - 1].resolve([]));
    expect(result.current.quota.quotaLoading).toBe(false);
  });

  it('local settings start does not touch secure/cloud reads; explicit authenticated mode starts remote once', async () => {
    const { result, rerender } = renderHook(({ authenticated }) => useHarness({ tab: 'settings', authenticated }), { initialProps: { authenticated: false } });
    await act(async () => config.resolve(savedConfig));
    expect(invokeMock.mock.calls.some(([command]) => command === 'get_quota_providers' || command === 'get_quota_snapshot_sync_status')).toBe(false);
    rerender({ authenticated: true });
    expect(quotaCalls()[quotaCalls().length - 1]?.[0]).toBe('get_quota_providers');
    const remoteIndex = reads.length - 1;
    await act(async () => reads[remoteIndex - 1].resolve([]));
    expect(result.current.quota.quotaLoading).toBe(true);
    await act(async () => reads[remoteIndex].resolve([]));
    expect(result.current.quota.quotaLoading).toBe(false);
  });
});
