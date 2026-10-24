import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  resolveWallpaperConsentSettings,
} from '../utils/frontendContracts';
import {
  AppSettings,
  CloudStatus,
  DbInfo,
  DEFAULT_SETTINGS,
  ModelsDevCandidate,
  ToastType,
} from '../types';
import type { RequestConfirmation } from '../utils/confirmation';

interface PriceSaveResult {
  message: string;
  saved?: boolean;
  repricing_pending?: boolean;
  warning?: string | null;
}

const PRICE_FIELDS = ['input', 'output', 'cache_input', 'cache_write'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validatePricesConfig(value: unknown): string | null {
  if (!isRecord(value)) return '价格表必须是 JSON 对象';

  for (const [model, config] of Object.entries(value)) {
    if (!model.trim()) return '价格表包含空模型名';
    if (!isRecord(config)) return `${model} 的价格配置必须是对象`;

    for (const required of ['input', 'output'] as const) {
      if (typeof config[required] !== 'number' || !Number.isFinite(config[required])) {
        return `${model}.${required} 必须是数字`;
      }
    }

    for (const field of PRICE_FIELDS) {
      const fieldValue = config[field];
      if (fieldValue === undefined) continue;
      if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue) || fieldValue < 0) {
        return `${model}.${field} 必须是大于等于 0 的数字`;
      }
    }
  }

  return null;
}

export interface UseSettingsProps {
  showMessage: (type: ToastType, text: string) => void;
  confirm: RequestConfirmation;
  loadStats: () => Promise<void>;
  loadQuotas: () => Promise<boolean | void>;
  loadQuotaSyncStatus: () => Promise<void>;
  cloudStatus: CloudStatus;
  cloudSetup: {
    capabilityVerified: boolean;
    firstSyncCompleted: boolean;
  };
  setSettingsAnchor: (anchor: string | null) => void;
  setBusy: (fn: (p: any) => any) => void;
}

export function useSettings({
  showMessage,
  confirm,
  loadStats,
  loadQuotas,
  loadQuotaSyncStatus,
  cloudStatus,
  cloudSetup,
  setSettingsAnchor,
  setBusy,
}: UseSettingsProps) {
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [wallpaperError, setWallpaperError] = useState('');
  const [pricesText, setPricesText] = useState('');
  const [pricesError, setPricesError] = useState('');
  const [pricesLoadError, setPricesLoadError] = useState('');
  const [pricesLoading, setPricesLoading] = useState(false);
  const [pricesDirty, setPricesDirty] = useState(false);
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [dbInfoError, setDbInfoError] = useState('');
  const [cleanupDate, setCleanupDate] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [showTotalTokens, setShowTotalTokens] = useState(() => localStorage.getItem('show_total_tokens') === 'true');

  const settingsDebounceTimer = useRef<number | null>(null);
  const pendingSettingsRef = useRef<AppSettings | null>(null);
  const pricesRequestId = useRef(0);

  const toggleTokenMode = useCallback(() => {
    setShowTotalTokens((prev) => {
      const next = !prev;
      localStorage.setItem('show_total_tokens', String(next));
      return next;
    });
  }, []);

  const loadSettings = useCallback(async (silent = false): Promise<boolean> => {
    try {
      setAppSettings(await invoke<AppSettings>('get_settings'));
      return true;
    } catch (err) {
      if (!silent) showMessage('error', `读取设置失败: ${err}`);
      return false;
    }
  }, [showMessage]);

  const loadPrices = useCallback(async () => {
    const requestId = ++pricesRequestId.current;
    setPricesLoading(true);
    setPricesLoadError('');
    try {
      const nextPricesText = JSON.stringify(await invoke<Record<string, unknown>>('get_prices'), null, 2);
      if (requestId !== pricesRequestId.current) return;
      setPricesText(nextPricesText);
      setPricesDirty(false);
    } catch (err) {
      if (requestId !== pricesRequestId.current) return;
      const errorMessage = `读取价格表失败: ${err}`;
      setPricesLoadError(errorMessage);
      showMessage('error', errorMessage);
    } finally {
      if (requestId === pricesRequestId.current) setPricesLoading(false);
    }
  }, [showMessage]);

  // 价格表在别处被改（本机备份恢复、扫描发现新模型）后，没有未保存修改的
  // 价格编辑器跟着重读，免得下一次保存把旧整表写回去。
  const pricesDirtyRef = useRef(pricesDirty);
  pricesDirtyRef.current = pricesDirty;
  const reloadCleanPrices = useCallback(() => {
    if (!pricesDirtyRef.current) void loadPrices();
  }, [loadPrices]);

  // 托盘菜单勾选“桌面小组件”、关闭小组件窗口等原生入口改了设置后，
  // 设置页的开关要跟着刷新，不能停在旧值（T10.110）。价格表同理（见上）。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const install = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const cleanups = [
          await listen('settings-updated', () => void loadSettings(true)),
          await listen('prices-updated', reloadCleanPrices),
        ];
        const cleanup = () => cleanups.forEach((stop) => stop());
        if (cancelled) cleanup();
        else unlisten = cleanup;
      } catch {
        // 浏览器 fixture 没有原生事件桥。
      }
    };
    void install();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadSettings, reloadCleanPrices]);

  const loadDbInfo = useCallback(async () => {
    setDbInfoError('');
    try {
      setDbInfo(await invoke<DbInfo>('get_db_info'));
    } catch (err) {
      const errorMessage = `读取数据库信息失败: ${err}`;
      setDbInfoError(errorMessage);
      showMessage('error', errorMessage);
    }
  }, [showMessage]);

  const saveAppSettings = useCallback(async (next: AppSettings): Promise<boolean> => {
    setBusy((p: any) => ({ ...p, settings: true }));
    try {
      const res = await invoke<{ message: string; settings: AppSettings; quotaCleanupPending?: boolean; wallpaperWarning?: string; autostartWarning?: string }>('save_settings', { settings: next });
      setAppSettings(res.settings);
      setWallpaperError(res.wallpaperWarning || '');
      const warning = res.wallpaperWarning || res.autostartWarning;
      showMessage(warning ? 'warning' : res.quotaCleanupPending ? 'info' : 'success', warning || res.message);
      if (
        next.quota_codex_local_enabled !== appSettings.quota_codex_local_enabled
        || next.quota_claude_enabled !== appSettings.quota_claude_enabled
        || next.quota_claude_statusline_enabled !== appSettings.quota_claude_statusline_enabled
        || next.quota_claude_codexbar_enabled !== appSettings.quota_claude_codexbar_enabled
        || next.quota_antigravity_local_enabled !== appSettings.quota_antigravity_local_enabled
        || next.quota_antigravity_codexbar_enabled !== appSettings.quota_antigravity_codexbar_enabled
      ) {
        await loadQuotas();
        await loadQuotaSyncStatus();
      }
      return true;
    } catch (err) {
      showMessage('error', `保存设置失败: ${err}`);
      await loadSettings();
      return false;
    } finally {
      setBusy((p: any) => ({ ...p, settings: false }));
    }
  }, [appSettings.quota_antigravity_codexbar_enabled, appSettings.quota_antigravity_local_enabled, appSettings.quota_claude_codexbar_enabled, appSettings.quota_claude_enabled, appSettings.quota_claude_statusline_enabled, appSettings.quota_codex_local_enabled, loadQuotaSyncStatus, loadQuotas, loadSettings, setBusy, showMessage]);

  const clearPendingSettings = useCallback(() => {
    if (settingsDebounceTimer.current !== null) {
      window.clearTimeout(settingsDebounceTimer.current);
      settingsDebounceTimer.current = null;
    }
    pendingSettingsRef.current = null;
  }, []);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    if (
      key === 'wallpaper_use_cloud'
      && value === true
      && !(cloudStatus.authenticated && cloudSetup.capabilityVerified && cloudSetup.firstSyncCompleted)
    ) {
      showMessage('warning', '请先完成登录、Stats v2 验证和首次同步');
      return;
    }
    clearPendingSettings();
    const next = { ...appSettings, [key]: value };
    setAppSettings(next);
    void saveAppSettings(next);
  }, [appSettings, clearPendingSettings, cloudSetup.capabilityVerified, cloudSetup.firstSyncCompleted, cloudStatus.authenticated, saveAppSettings, showMessage]);

  const updateSettingDebounced = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next = { ...appSettings, [key]: value };
    setAppSettings(next);
    pendingSettingsRef.current = next;
    if (settingsDebounceTimer.current !== null) window.clearTimeout(settingsDebounceTimer.current);
    settingsDebounceTimer.current = window.setTimeout(() => {
      settingsDebounceTimer.current = null;
      const pending = pendingSettingsRef.current;
      pendingSettingsRef.current = null;
      if (pending) void saveAppSettings(pending);
    }, 600);
  }, [appSettings, saveAppSettings]);

  const flushSettingsDebounced = useCallback(() => {
    if (settingsDebounceTimer.current === null) return;
    window.clearTimeout(settingsDebounceTimer.current);
    settingsDebounceTimer.current = null;
    const pending = pendingSettingsRef.current;
    pendingSettingsRef.current = null;
    if (pending) void saveAppSettings(pending);
  }, [saveAppSettings]);

  const savePrices = useCallback(async () => {
    setBusy((p: any) => ({ ...p, prices: true }));
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(pricesText);
      } catch {
        throw new Error('JSON 格式无效，请检查后重试');
      }
      const validationError = validatePricesConfig(parsed);
      if (validationError) {
        setPricesError(validationError);
        showMessage('error', validationError);
        return;
      }
      // 整表提交；后端只把与内置价、待核价兜底价不同的字段写入覆盖文件（T10.171）。
      const res = await invoke<PriceSaveResult>('save_prices', { prices: parsed });
      setPricesError('');
      setPricesDirty(false);
      showMessage(res.warning || res.repricing_pending ? 'warning' : 'success', res.warning || res.message);
      await Promise.all([loadPrices(), loadStats()]);
    } catch (err) {
      showMessage('error', `保存价格表失败: ${err}`);
    } finally {
      setBusy((p: any) => ({ ...p, prices: false }));
    }
  }, [loadPrices, loadStats, pricesText, setBusy, showMessage]);

  const importModelsDevPrice = useCallback(async (modelKey: string, candidate: ModelsDevCandidate) => {
    if (!candidate.importable || candidate.input == null || candidate.output == null) {
      showMessage('error', '该 models.dev 候选项缺少输入或输出价格，无法导入');
      return false;
    }
    if (pricesDirty && !(await confirm({
      title: '价格表尚未保存',
      description: '继续导入会同时保存当前修改。确认继续导入这个 models.dev 候选项吗？',
      confirmLabel: '继续导入',
    }))) {
      return false;
    }

    setBusy((previous: any) => ({ ...previous, prices: true }));
    try {
      const parsed = JSON.parse(pricesText) as unknown;
      if (!isRecord(parsed)) throw new Error('当前价格表格式无效');
      const current = parsed[modelKey];
      if (!isRecord(current)) throw new Error(`未找到待核价模型 ${modelKey}`);

      const currentInput = typeof current.input === 'number' && Number.isFinite(current.input)
        ? current.input
        : candidate.input;
      const estimatedFields: string[] = [];
      const cacheInput = candidate.cacheInput ?? (
        typeof current.cache_input === 'number' && Number.isFinite(current.cache_input)
          ? current.cache_input
          : currentInput * 0.1
      );
      if (candidate.cacheInput == null) estimatedFields.push('cache_input');
      const cacheWrite = candidate.cacheWrite ?? (
        typeof current.cache_write === 'number' && Number.isFinite(current.cache_write)
          ? current.cache_write
          : currentInput * 1.25
      );
      if (candidate.cacheWrite == null) estimatedFields.push('cache_write');

      // 保留 fallback_key：models.dev 缺的缓存价仍按原兜底估算，后端据此在读取时补齐，
      // 覆盖文件只存导入的价格（T10.171）。其余行原样提交，未改动的待核价行由后端跳过。
      const preservedMeta: Record<string, unknown> = isRecord(current._meta) ? { ...current._meta } : {};
      const next = {
        ...parsed,
        [modelKey]: {
          ...current,
          input: candidate.input,
          output: candidate.output,
          cache_input: cacheInput,
          cache_write: cacheWrite,
          _meta: {
            ...preservedMeta,
            status: 'models_dev_imported',
            price_source: 'models.dev',
            provider_id: candidate.providerId,
            provider_name: candidate.providerName,
            source_model_id: candidate.modelId,
            source_model_name: candidate.modelName,
            source_last_updated: candidate.lastUpdated,
            imported_at: new Date().toISOString(),
            has_tiered_pricing: candidate.hasTieredPricing,
            estimated_fields: estimatedFields,
          },
        },
      };
      const validationError = validatePricesConfig(next);
      if (validationError) throw new Error(validationError);

      const res = await invoke<PriceSaveResult>('save_prices', { prices: next });
      setPricesText(JSON.stringify(next, null, 2));
      setPricesError('');
      setPricesDirty(false);
      const estimateNote = estimatedFields.length > 0 ? '，缺失的缓存价格继续使用原兜底估算' : '';
      showMessage(res.warning || res.repricing_pending ? 'warning' : 'success', res.warning || (res.repricing_pending ? res.message : `已从 ${candidate.providerName} 导入 ${candidate.modelName}${estimateNote}`));
      await Promise.all([loadPrices(), loadStats()]);
      return true;
    } catch (error) {
      showMessage('error', `导入 models.dev 价格失败: ${error}`);
      return false;
    } finally {
      setBusy((previous: any) => ({ ...previous, prices: false }));
    }
  }, [confirm, loadPrices, loadStats, pricesDirty, pricesText, setBusy, showMessage]);

  const resetPrices = useCallback(async () => {
    const confirmed = await confirm({
      title: '恢复默认价格表？',
      description: '手动编辑或从 models.dev 导入的价格都会被覆盖，此操作不可撤销。',
      confirmLabel: '恢复默认',
      tone: 'danger',
    });
    if (!confirmed) {
      showMessage('info', '已取消恢复默认');
      return;
    }
    setBusy((p: any) => ({ ...p, prices: true }));
    try {
      const res = await invoke<PriceSaveResult & { prices: Record<string, unknown> }>('reset_prices');
      setPricesText(JSON.stringify(res.prices, null, 2));
      setPricesDirty(false);
      showMessage(res.warning || res.repricing_pending ? 'warning' : 'success', res.warning || res.message);
      await loadStats();
    } catch (err) {
      showMessage('error', `重置价格表失败: ${err}`);
    } finally {
      setBusy((p: any) => ({ ...p, prices: false }));
    }
  }, [confirm, loadStats, setBusy, showMessage]);

  const exportCsv = useCallback(async () => {
    setBusy((p: any) => ({ ...p, db: true }));
    try {
      const res = await invoke<{ message: string; path: string }>('export_db_csv');
      showMessage('success', `${res.message} → ${res.path}`);
    } catch (err) {
      showMessage('error', `导出失败: ${err}`);
    } finally {
      setBusy((p: any) => ({ ...p, db: false }));
    }
  }, [setBusy, showMessage]);

  const resetSyncStatus = useCallback(async () => {
    const confirmed = await confirm({
      title: '重置本机同步状态？',
      description: '本机所有记录会重新标记为未同步，下次同步将重新向云端上传全部数据，可能耗时较长。',
      confirmLabel: '重置同步',
      tone: 'danger',
    });
    if (!confirmed) {
      showMessage('info', '已取消重置同步');
      return;
    }
    setBusy((p: any) => ({ ...p, db: true }));
    try {
      const res = await invoke<{ message: string }>('reset_local_sync');
      showMessage('success', res.message);
      await loadDbInfo();
    } catch (err) {
      showMessage('error', `重置同步状态失败: ${err}`);
    } finally {
      setBusy((p: any) => ({ ...p, db: false }));
    }
  }, [confirm, loadDbInfo, setBusy, showMessage]);

  const runCleanup = useCallback(async () => {
    if (!cleanupDate) {
      showMessage('error', '请先选择截止日期');
      return;
    }
    const earliest = dbInfo?.earliest ? dbInfo.earliest.slice(0, 10) : '未知';
    const latest = dbInfo?.latest ? dbInfo.latest.slice(0, 10) : '未知';
    const confirmed = await confirm({
      title: `永久清理 ${cleanupDate} 之前的本地记录？`,
      description: `预计影响范围：${earliest} ~ ${cleanupDate} 前；当前数据范围：${earliest} ~ ${latest}。此操作不可撤销，建议先导出 CSV。`,
      confirmLabel: '永久删除',
      tone: 'danger',
    });
    if (!confirmed) {
      showMessage('info', '已取消清理');
      return;
    }
    setBusy((p: any) => ({ ...p, db: true }));
    try {
      const res = await invoke<{ message: string }>('cleanup_db', { beforeDate: cleanupDate });
      showMessage('success', res.message);
      await loadDbInfo();
      await loadStats();
    } catch (err) {
      showMessage('error', `清理失败: ${err}`);
    } finally {
      setBusy((p: any) => ({ ...p, db: false }));
    }
  }, [cleanupDate, confirm, dbInfo?.earliest, dbInfo?.latest, loadDbInfo, loadStats, setBusy, showMessage]);

  const reclaimDbSpace = useCallback(async () => {
    const reclaimableMb = ((dbInfo?.reclaimableBytes ?? 0) / 1_048_576).toFixed(1);
    const confirmed = await confirm({
      title: '回收数据库空闲空间？',
      description: `会重写本地数据库文件以释放约 ${reclaimableMb} MB 空闲页；期间扫描与同步会短暂等待，通常几秒内完成，不会删除任何记录。`,
      confirmLabel: '开始回收',
      tone: 'primary',
    });
    if (!confirmed) return;
    setBusy((p: any) => ({ ...p, db: true }));
    try {
      const res = await invoke<{ message: string; freedBytes: number }>('reclaim_db_space');
      showMessage('success', res.message);
      await loadDbInfo();
    } catch (err) {
      showMessage('error', `空间回收失败: ${err}`);
    } finally {
      setBusy((p: any) => ({ ...p, db: false }));
    }
  }, [confirm, dbInfo?.reclaimableBytes, loadDbInfo, setBusy, showMessage]);

  const refreshWallpaper = useCallback(async () => {
    setBusy((previous: any) => ({ ...previous, wallpaper: true }));
    try {
      const result = await invoke<{ desktop: boolean; message: string }>('update_wallpaper', { target: 'desktop' });
      if (!result.desktop) throw new Error('系统尚未应用桌面壁纸');
      setWallpaperError('');
      showMessage('success', result.message);
    } catch (error) {
      const message = `壁纸应用失败：${error}`;
      setWallpaperError(message);
      showMessage('error', message);
    } finally {
      setBusy((previous: any) => ({ ...previous, wallpaper: false }));
    }
  }, [setBusy, showMessage]);

  const cleanupWallpaper = useCallback(async () => {
    const confirmed = await confirm({
      title: '清理历史壁纸？',
      description: '仅删除 TokenLedger 生成的历史图片，保留当前使用的图片和壁纸设置，不会重置系统桌面或重启 Dock。',
      confirmLabel: '开始清理',
      tone: 'danger',
    });
    if (!confirmed) {
      showMessage('info', '已取消清理');
      return;
    }
    setBusy((p: any) => ({ ...p, settings: true }));
    try {
      const res = await invoke<{ message: string }>('cleanup_wallpaper');
      showMessage('success', res.message);
      await loadSettings();
    } catch (err) {
      showMessage('error', `清理失败: ${err}`);
    } finally {
      setBusy((p: any) => ({ ...p, settings: false }));
    }
  }, [confirm, loadSettings, setBusy, showMessage]);

  const resolveWallpaperConsent = useCallback(async (restoreHistoricalChoices: boolean) => {
    clearPendingSettings();
    const cloudWallpaperReady = cloudStatus.authenticated
      && cloudSetup.capabilityVerified
      && cloudSetup.firstSyncCompleted;
    const resolution = resolveWallpaperConsentSettings(
      appSettings,
      restoreHistoricalChoices,
      cloudWallpaperReady,
    );
    if (resolution.kind === 'blocked') {
      setSettingsAnchor('settings-cloud');
      showMessage('warning', resolution.message);
      return;
    }
    const next = resolution.settings;
    setAppSettings(next);
    const saved = await saveAppSettings(next);
    if (saved) {
      showMessage(
        'success',
        restoreHistoricalChoices ? '已确认并恢复历史壁纸设置' : '壁纸自动化已全部保持关闭',
      );
    }
  }, [appSettings, clearPendingSettings, cloudSetup.capabilityVerified, cloudSetup.firstSyncCompleted, cloudStatus.authenticated, saveAppSettings, setSettingsAnchor, showMessage]);

  return {
    appSettings,
    setAppSettings,
    pricesText,
    setPricesText,
    pricesError,
    setPricesError,
    pricesLoadError,
    pricesLoading,
    pricesDirty,
    setPricesDirty,
    dbInfo,
    dbInfoError,
    setDbInfo,
    cleanupDate,
    setCleanupDate,
    appVersion,
    setAppVersion,
    showTotalTokens,
    toggleTokenMode,
    loadSettings,
    loadPrices,
    loadDbInfo,
    saveAppSettings,
    clearPendingSettings,
    updateSetting,
    updateSettingDebounced,
    flushSettingsDebounced,
    savePrices,
    importModelsDevPrice,
    resetPrices,
    exportCsv,
    resetSyncStatus,
    runCleanup,
    reclaimDbSpace,
    wallpaperError,
    refreshWallpaper,
    cleanupWallpaper,
    resolveWallpaperConsent,
  };
}
