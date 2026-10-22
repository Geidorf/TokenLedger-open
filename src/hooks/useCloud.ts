import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  beginRequest,
  classifyCloudFailure,
  cloudStatsIdentity,
  invalidateRequest,
  isCurrentRequest,
  normalizeStatsQuery,
  parseStatsDataContract,
  isStatsV2Capable,
  validateCloudConnectionConfig,
  validateCloudCredentials,
} from '../utils/frontendContracts';
import { CloudConfig, CloudStatus, ToastType } from '../types';

const INITIAL_CLOUD: CloudStatus = { configured: false, authenticated: false, email: '', userId: '' };

const CLOUD_SETUP_STORAGE_KEY_PREFIX = 'tokenledger:cloud-setup:';

function safeAuthError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (text === 'Supabase authentication timed out. Please retry.') {
    return '登录服务响应超时，请检查网络后重试。';
  }
  if (text === 'Supabase authentication network connection failed. Please retry.') {
    return '暂时无法连接登录服务，请检查网络后重试。';
  }
  const status = /^Supabase authentication failed \(HTTP (\d{3})\)\.$/.exec(text)?.[1];
  if (status === '400' || status === '401' || status === '422') {
    return '邮箱、密码或账户状态未通过验证，请检查后重试。';
  }
  if (status === '429') return '登录或注册操作过于频繁，请稍后重试。';
  if (text === 'Please configure Supabase URL and publishable key first.') {
    return '请先保存有效的云端连接配置。';
  }
  if (/^Please sign out before (signing in to another account|creating or switching accounts)\.$/.test(text)) {
    return '请先退出当前账户，再登录或注册。';
  }
  if (classifyCloudFailure(error).kind === 'session-expired') {
    return '本机登录状态或安全存储暂不可用，请检查系统安全存储后重试。';
  }
  // Backend errors may originate in local storage as well as a remote service.
  // Authentication never renders untrusted body text, URLs, keys, or credentials.
  return '登录服务暂时不可用，请稍后重试。';
}

export interface PersistedCloudSetup {
  capabilityVerified: boolean;
  firstSyncCompleted: boolean;
}

export function readPersistedCloudSetup(identity: string | null): PersistedCloudSetup {
  if (!identity || typeof window === 'undefined') {
    return { capabilityVerified: false, firstSyncCompleted: false };
  }
  try {
    const raw = window.localStorage.getItem(`${CLOUD_SETUP_STORAGE_KEY_PREFIX}${identity}`);
    if (!raw) return { capabilityVerified: false, firstSyncCompleted: false };
    const parsed = JSON.parse(raw);
    return {
      capabilityVerified: parsed?.capabilityVerified === true,
      firstSyncCompleted: parsed?.firstSyncCompleted === true,
    };
  } catch {
    return { capabilityVerified: false, firstSyncCompleted: false };
  }
}

export function writePersistedCloudSetup(identity: string | null, setup: Partial<PersistedCloudSetup>): void {
  if (!identity || typeof window === 'undefined') return;
  try {
    const current = readPersistedCloudSetup(identity);
    const updated: PersistedCloudSetup = {
      capabilityVerified: setup.capabilityVerified !== undefined ? setup.capabilityVerified : current.capabilityVerified,
      firstSyncCompleted: setup.firstSyncCompleted !== undefined ? setup.firstSyncCompleted : current.firstSyncCompleted,
    };
    window.localStorage.setItem(`${CLOUD_SETUP_STORAGE_KEY_PREFIX}${identity}`, JSON.stringify(updated));
  } catch {
    // Ignore restricted storage environments
  }
}

export interface UseCloudProps {
  showMessage: (type: ToastType, text: string) => void;
  onClearCloudScopedState: () => void;
  currentTimezone: () => string;
}

export function useCloud({ showMessage, onClearCloudScopedState, currentTimezone }: UseCloudProps) {
  const [cloudConfig, setCloudConfig] = useState<CloudConfig>({ supabase_url: '', supabase_key: '' });
  const [activeCloudConfig, setActiveCloudConfigState] = useState<CloudConfig>({ supabase_url: '', supabase_key: '' });
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>(INITIAL_CLOUD);
  const [cloudStatusKnown, setCloudStatusKnown] = useState(false);
  const [cloudStatusChecking, setCloudStatusChecking] = useState(false);
  const [cloudStatusError, setCloudStatusError] = useState('');
  const [authForm, setAuthForm] = useState({ email: '', password: '' });
  const [cloudConfigError, setCloudConfigError] = useState('');
  const [cloudAuthError, setCloudAuthError] = useState('');
  const [cloudSetup, setCloudSetupState] = useState<{
    capabilityVerified: boolean;
    firstSyncCompleted: boolean;
    validating: boolean;
    lastError: string;
  }>({
    capabilityVerified: false,
    firstSyncCompleted: false,
    validating: false,
    lastError: '',
  });

  const activeCloudConfigRef = useRef(activeCloudConfig);
  activeCloudConfigRef.current = activeCloudConfig;
  const cloudStatusRef = useRef(cloudStatus);
  cloudStatusRef.current = cloudStatus;

  const setCloudSetup = useCallback<React.Dispatch<React.SetStateAction<{
    capabilityVerified: boolean;
    firstSyncCompleted: boolean;
    validating: boolean;
    lastError: string;
  }>>>((action) => {
    setCloudSetupState((previous) => {
      const next = typeof action === 'function' ? action(previous) : action;
      const status = cloudStatusRef.current;
      const identity = status.authenticated
        ? cloudStatsIdentity(activeCloudConfigRef.current.supabase_url, status.userId)
        : null;
      if (identity) {
        writePersistedCloudSetup(identity, {
          capabilityVerified: next.capabilityVerified,
          firstSyncCompleted: next.firstSyncCompleted,
        });
      }
      return next;
    });
  }, []);

  const observedCloudBinding = useRef<{ identity: string | null; publicKey: string } | undefined>(undefined);
  const cloudRequestId = useRef(0);
  const authRequestId = useRef(0);
  const releaseAuthBusy = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    invalidateRequest(authRequestId);
    releaseAuthBusy.current?.();
    releaseAuthBusy.current = null;
  }, []);

  const cloudIdentity = useMemo(
    () => cloudStatus.authenticated ? cloudStatsIdentity(activeCloudConfig.supabase_url, cloudStatus.userId) : null,
    [activeCloudConfig.supabase_url, cloudStatus.authenticated, cloudStatus.userId],
  );

  const clearAuthPassword = useCallback(() => {
    setAuthForm((previous) => (previous.password ? { ...previous, password: '' } : previous));
  }, []);

  const invalidateCloudReads = useCallback(() => {
    invalidateRequest(cloudRequestId);
    setCloudStatusChecking(false);
    setCloudSetupState((previous) => (
      previous.validating ? { ...previous, validating: false } : previous
    ));
  }, []);

  const invalidateCloudRequests = useCallback(() => {
    invalidateCloudReads();
    invalidateRequest(authRequestId);
    releaseAuthBusy.current?.();
    releaseAuthBusy.current = null;
    clearAuthPassword();
    setCloudAuthError('');
  }, [clearAuthPassword, invalidateCloudReads]);

  const setActiveCloudConfig = useCallback<React.Dispatch<React.SetStateAction<CloudConfig>>>((nextConfig) => {
    const previous = activeCloudConfigRef.current;
    const next = typeof nextConfig === 'function' ? nextConfig(previous) : nextConfig;
    const bindingChanged = (
      next.supabase_url !== previous.supabase_url
      || next.supabase_key !== previous.supabase_key
    );
    if (bindingChanged) {
      invalidateCloudRequests();
      // 配置本身就是账户绑定的一部分。新连接尚未验证前，不能继续把旧项目的
      // 已登录状态交给同步、额度快照或退出操作使用。
      setCloudStatus(INITIAL_CLOUD);
      cloudStatusRef.current = INITIAL_CLOUD;
      setCloudStatusKnown(false);
      setCloudStatusError('');
      setCloudSetupState({ capabilityVerified: false, firstSyncCompleted: false, validating: false, lastError: '' });
    } else {
      invalidateCloudReads();
    }
    // 会话未确认前不能把同一项目的另一个账户标为已验证。
    activeCloudConfigRef.current = next;
    setActiveCloudConfigState(next);
  }, [invalidateCloudReads, invalidateCloudRequests]);

  const refreshCloudStatus = useCallback(async (silent = false, configOverride?: CloudConfig) => {
    const requestId = beginRequest(cloudRequestId);
    setCloudStatusChecking(true);
    setCloudSetupState((previous) => (
      previous.validating ? { ...previous, validating: false } : previous
    ));
    setCloudStatusError('');
    try {
      const status = await invoke<CloudStatus>('get_cloud_status');
      if (!isCurrentRequest(cloudRequestId, requestId)) return cloudStatus;
      const requestUrl = configOverride?.supabase_url ?? activeCloudConfig.supabase_url;
      const nextIdentity = status.authenticated ? cloudStatsIdentity(requestUrl, status.userId) : null;
      if (nextIdentity !== cloudIdentity) {
        onClearCloudScopedState();
        const persisted = readPersistedCloudSetup(nextIdentity);
        setCloudSetupState({ ...persisted, validating: false, lastError: '' });
      }
      cloudStatusRef.current = status;
      setCloudStatus(status);
      setCloudStatusKnown(true);
      setCloudStatusError('');
      if (status.email) setAuthForm((prev) => ({ ...prev, email: status.email }));
      return status;
    } catch (err) {
      if (!isCurrentRequest(cloudRequestId, requestId)) return cloudStatus;
      const failure = classifyCloudFailure(err);
      const raw = String(err ?? '').toLowerCase();
      const message = raw.includes('keyring') || raw.includes('keychain') || raw.includes('secure store')
        ? '系统安全存储暂时无法访问。当前授权周期内不会重复读取本机钥匙串；请确认登录钥匙串已解锁后，主动重试。'
        : `${failure.label}：${failure.message || '请稍后重试'}`;
      setCloudStatusError(message);
      if (!silent) showMessage('error', message);
      return cloudStatus;
    } finally {
      if (isCurrentRequest(cloudRequestId, requestId)) setCloudStatusChecking(false);
    }
  }, [activeCloudConfig.supabase_url, cloudIdentity, cloudStatus, onClearCloudScopedState, showMessage]);

  const saveConfig = useCallback(async (event: React.FormEvent, setBusy: (fn: (p: any) => any) => void) => {
    event.preventDefault();
    const validationError = validateCloudConnectionConfig(cloudConfig);
    setCloudConfigError(validationError || '');
    if (validationError) {
      showMessage('error', validationError);
      return;
    }
    const normalized = {
      supabase_url: cloudConfig.supabase_url.trim().replace(/\/+$/, ''),
      supabase_key: cloudConfig.supabase_key.trim(),
    };
    const bindingChanged = (
      normalized.supabase_url !== activeCloudConfigRef.current.supabase_url
      || normalized.supabase_key !== activeCloudConfigRef.current.supabase_key
    );
    // Saving the same binding does not cancel backend auth. Keep its result and
    // busy state until it settles, including when configuration saving fails.
    if (bindingChanged) invalidateCloudRequests();
    else invalidateCloudReads();
    setBusy((p: any) => ({ ...p, config: true }));
    try {
      const res = await invoke<{ message: string }>('save_cloud_config', { config: normalized });
      if (
        normalized.supabase_url !== activeCloudConfig.supabase_url
        || normalized.supabase_key !== activeCloudConfig.supabase_key
      ) {
        onClearCloudScopedState();
      }
      setCloudConfig(normalized);
      setActiveCloudConfig(normalized);
      setCloudConfigError('');
      showMessage('success', res.message);
      await refreshCloudStatus(false, normalized);
    } catch (err) {
      const failure = classifyCloudFailure(err);
      setCloudConfigError(failure.message || failure.label);
      showMessage('error', `保存配置失败: ${failure.message || failure.label}`);
    } finally {
      setBusy((p: any) => ({ ...p, config: false }));
    }
  }, [activeCloudConfig.supabase_key, activeCloudConfig.supabase_url, cloudConfig, invalidateCloudReads, invalidateCloudRequests, onClearCloudScopedState, refreshCloudStatus, setActiveCloudConfig, showMessage]);

  const submitAuth = useCallback(async (mode: 'signIn' | 'signUp', setBusy: (fn: (p: any) => any) => void, onQuotaSyncStatusReload: () => Promise<void>) => {
    const validationError = validateCloudCredentials(authForm.email, authForm.password);
    setCloudAuthError(validationError || '');
    if (validationError) {
      showMessage('error', validationError);
      setAuthForm((previous) => ({ ...previous, password: '' }));
      return;
    }
    invalidateCloudRequests();
    const requestId = beginRequest(authRequestId);
    setBusy((p: any) => ({ ...p, auth: true }));
    releaseAuthBusy.current = () => setBusy((p: any) => ({ ...p, auth: false }));
    try {
      const cmd = mode === 'signIn' ? 'supabase_sign_in' : 'supabase_sign_up';
      const credentials = { email: authForm.email.trim(), password: authForm.password };
      const res = await invoke<{ message: string }>(cmd, { credentials });
      if (!isCurrentRequest(authRequestId, requestId)) return;
      setCloudAuthError('');
      clearAuthPassword();
      releaseAuthBusy.current?.();
      releaseAuthBusy.current = null;
      showMessage('success', res.message);
      await Promise.all([refreshCloudStatus(), onQuotaSyncStatusReload()]);
    } catch (err) {
      if (!isCurrentRequest(authRequestId, requestId)) return;
      const message = safeAuthError(err);
      setCloudAuthError(message);
      showMessage('error', mode === 'signIn' ? `登录失败: ${message}` : `注册失败: ${message}`);
    } finally {
      if (isCurrentRequest(authRequestId, requestId)) {
        clearAuthPassword();
        releaseAuthBusy.current?.();
        releaseAuthBusy.current = null;
      }
    }
  }, [authForm.email, authForm.password, clearAuthPassword, invalidateCloudRequests, refreshCloudStatus, showMessage]);

  const verifyCloudCapability = useCallback(async () => {
    if (!cloudStatus.authenticated) {
      setCloudSetup((previous) => ({ ...previous, lastError: '请先登录云端账户' }));
      showMessage('info', '请先登录云端账户');
      return;
    }
    const requestId = beginRequest(cloudRequestId);
    setCloudStatusChecking(false);
    setCloudSetup((previous) => ({ ...previous, validating: true, lastError: '' }));
    try {
      const query = normalizeStatsQuery({
        range: 'today',
        timezone: currentTimezone(),
        machines: [],
        tools: [],
        models: [],
        search: null,
        tokenMode: 'effective',
      });
      const response = await invoke<unknown>('get_cached_stats', {
        scope: 'cloud',
        range: 'today',
        deviceFilter: 'all_cloud',
        timezone: query.timezone,
        machines: query.machines,
        tools: query.tools,
        models: query.models,
        search: query.search,
        tokenMode: query.tokenMode,
      });
      if (!isCurrentRequest(cloudRequestId, requestId)) return;
      const parsed = parseStatsDataContract(response);
      if (!isStatsV2Capable(parsed)) throw new Error('Stats v2 RPC 尚未部署');
      setCloudSetup((previous) => ({
        ...previous,
        capabilityVerified: true,
        validating: false,
        lastError: '',
      }));
      showMessage('success', 'Stats v2 能力验证通过');
    } catch (error) {
      if (!isCurrentRequest(cloudRequestId, requestId)) return;
      const failure = classifyCloudFailure(error);
      const text = `${failure.label}：${failure.message || '验证失败'}`;
      setCloudSetup((previous) => ({
        ...previous,
        capabilityVerified: false,
        validating: false,
        lastError: text,
      }));
      showMessage('error', text);
    }
  }, [cloudStatus.authenticated, currentTimezone, setCloudSetup, showMessage]);

  return {
    cloudConfig,
    setCloudConfig,
    activeCloudConfig,
    setActiveCloudConfig,
    cloudStatus,
    cloudStatusKnown,
    cloudStatusChecking,
    cloudStatusError,
    setCloudStatus,
    authForm,
    setAuthForm,
    cloudConfigError,
    setCloudConfigError,
    cloudAuthError,
    setCloudAuthError,
    cloudSetup,
    setCloudSetup,
    observedCloudBinding,
    cloudIdentity,
    clearAuthPassword,
    invalidateCloudRequests,
    refreshCloudStatus,
    saveConfig,
    submitAuth,
    verifyCloudCapability,
  };
}
