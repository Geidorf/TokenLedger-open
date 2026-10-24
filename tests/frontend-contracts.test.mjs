import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { invoke } from '@tauri-apps/api/core';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { evaluateChartBundle } from '../scripts/bundle-budget.mjs';
import { validateCommitSubject } from '../scripts/check-commit-message.mjs';
import { isFullGitSha } from '../scripts/check-docs.mjs';
import { createVisibleStatsReconciler, subscribeThenReconcile } from '../src/utils/statsRefreshSubscription.ts';
import { nextThemeMode, resolveEffectiveTheme } from '../src/utils/useTheme.ts';
import { isCloudComparisonBaselineUnverified } from '../src/components/TrendPanel.tsx';
import {
  cloudSyncDisabledReason,
  cloudSyncRecoveryCopy,
  dashboardRefreshCopy,
  heldRangeNoticeCopy,
  rangeControlLabel,
  shouldShowDeviceDistribution,
  statsErrorRecoveryCopy,
} from '../src/components/DashboardTab.tsx';
import { detailActionCopy } from '../src/components/LogsTable.tsx';
import { findSettingsDestinations, SETTINGS_DESTINATIONS } from '../src/utils/settingsNavigation.ts';
import {
  DEFAULT_TRAY_HOVER_DELAY_MS,
  TRAY_HOVER_DELAY_CHOICES,
  TRAY_HOVER_DELAY_MAX_MS,
  WIDGET_LAYOUTS,
  WIDGET_RANGES,
  WIDGET_THEMES,
  parseTrayHoverDelay,
  selectWidgetQuota,
  widgetConfigFromSettings,
} from '../src/utils/widgetConfig.ts';
import { cloudSidebarStatusCopy } from '../src/components/Sidebar.tsx';
import { assignToolChartSlots, colorsForToolsInView, toolChartSlot } from '../src/types.ts';
import { getChartThemeTokens } from '../src/utils/chartTheme.ts';
import { MetricsGrid } from '../src/components/MetricsGrid.tsx';
import { YearHeatmap } from '../src/components/YearHeatmap.tsx';
import {
  companyQuotaWindowLabel,
  isCompanyQuotaProvider,
  providerEmptyStateLabel,
  quotaProviderHasRenderableWindows,
  quotaWindowDisplayLabel,
  selectCompanyQuotaWindows,
} from '../src/components/QuotaPanel.tsx';
import { providerDisplayName } from '../src/utils/quotaOverview.ts';
import { orphanedCustomQuotaProviders } from '../src/components/settings/QuotaSection.tsx';
import {
  capabilityActionLabel,
  firstSyncActionHint,
  firstSyncActionLabel,
} from '../src/components/settings/CloudAccountSection.tsx';
import { settingsNavigationStatus } from '../src/utils/settingsNavigation.ts';
import { installDevMockTauri } from '../src/devMockTauri.ts';
import { DEFAULT_SETTINGS } from '../src/types.ts';
import { downloadVisualDigest, generateVisualDigestHtml } from '../src/utils/reportExport.ts';
import { rangeDisplayName } from '../src/utils/rangeDisplay.ts';
import { modelCostDistribution, splitModelCacheRead } from '../src/utils/modelDistribution.ts';
import { SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH, SHARE_LAYOUTS } from '../src/utils/shareCardRenderer.ts';
import { cacheDetailMetrics, resolveCacheBreakdown } from '../src/utils/cacheDisplay.ts';
import {
  handleWindowDragDoubleClick,
  handleWindowDragMouseDown,
  isWindowGesture,
} from '../src/components/AppHeader.tsx';
import {
  beginRequest,
  classifyCloudFailure,
  clearCloudStatsSnapshots,
  cloudStatsIdentity,
  deriveTrendComparison,
  describeTrendPeakShift,
  escapeHtml,
  focusWrapTarget,
  hasCloudCapability,
  invalidateRequest,
  isCurrentRequest,
  isMacPlatform,
  isStatsV2Capable,
  isSuccessfulCloudSyncResult,
  isUnavailableEnvelope,
  matchesLiteralQuerySearch,
  mergeUsageDetails,
  normalizeEntitySelector,
  normalizeStatsQuery,
  parseQuotaProviderEnvelopes,
  parseQuotaSyncStatus,
  quotaClearErrorFeedback,
  quotaClearFeedback,
  quotaSyncNowFeedback,
  parseStatsDataContract,
  queryEchoMatches,
  filtersForEntityDrilldown,
  scopeMachineSelection,
  quotaPercent,
  quotaStatusAllowsValues,
  sameStatsSnapshot,
  statsSnapshotKey,
  shouldRefreshVisibleQuotas,
  showsMacDynamicBackgroundControls,
  showsWindowsLockscreenControls,
  validateQuotaAction,
  validateQuotaProviderEnvelopeStructure,
  validateQuotaWindowTimeline,
  validateQuotaWindowValues,
  validateCloudConnectionConfig,
  validateCloudCredentials,
  normalizeCloudOrigin,
  resolveWallpaperConsentSettings,
  calculateCacheEfficiency,
} from '../src/utils/frontendContracts.ts';

// 仓库在 Windows 上以 CRLF 检出（core.autocrlf=true，且没有 .gitattributes 归一化），
// 而下面的源码契约大量使用硬编码换行符字面量。不归一化的话，同一份提交在 Linux CI
// 上是绿的、在 Windows 开发机上必红——门禁会因此在半数机器上失信（2026-08-23 实测
// 本机 5 条失败里有 2 条纯属换行符差异）。断言只表达「源码写成什么样」，不表达
// 「检出用了哪种换行符」。
function readSource(target) {
  return fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
}


test('task log SHA validation rejects annotations, abbreviations, and placeholders', () => {
  assert.equal(isFullGitSha('fee429c7624c7c2bc2fdcacd1e5841e5f62bbef8'), true);
  assert.equal(isFullGitSha('fee429c'), false);
  assert.equal(isFullGitSha('fee429c7624c7c2bc2fdcacd1e5841e5f62bbef8（第二轮）'), false);
  assert.equal(isFullGitSha('pending'), false);
});

test('首个云端同步的禁用态解释下一步，而不是留下无原因的主按钮', () => {
  assert.equal(firstSyncActionHint({ authenticated: false, capabilityVerified: false }, false), '请先登录云端账户');
  assert.equal(firstSyncActionHint({ authenticated: true, capabilityVerified: false }, false), '请先验证 Stats v2');
  assert.equal(firstSyncActionHint({ authenticated: true, capabilityVerified: true }, true), '正在同步，请稍候');
  assert.equal(firstSyncActionHint({ authenticated: true, capabilityVerified: true }, false), null);
  assert.equal(firstSyncActionLabel({ firstSyncCompleted: false }, false), '执行首次同步');
  assert.equal(firstSyncActionLabel({ firstSyncCompleted: true }, false), '同步最新数据');
  assert.equal(firstSyncActionLabel({ firstSyncCompleted: true }, true), '同步中');
  assert.equal(capabilityActionLabel({ capabilityVerified: false, validating: false }), '验证 Stats v2');
  assert.equal(capabilityActionLabel({ capabilityVerified: true, validating: false }), '重新验证 Stats v2');
  assert.equal(capabilityActionLabel({ capabilityVerified: true, validating: true }), '验证中');
});

test('云端看板恢复文案区分未登录与已登录待验证', () => {
  assert.deepEqual(
    cloudSyncRecoveryCopy({ authenticated: false, capabilityVerified: false }),
    { title: '先登录云端账户，再同步本机数据', description: '当前设备尚未建立云端会话，请先在设置中登录。' },
  );
  assert.deepEqual(
    cloudSyncRecoveryCopy({ authenticated: true, capabilityVerified: false }),
    { title: '先验证 Stats v2，再同步本机数据', description: '云端能力尚未确认，请先完成设置中的验证步骤。' },
  );
  assert.equal(cloudSyncRecoveryCopy({ authenticated: true, capabilityVerified: true }), null);
});

test('云端同步禁用原因按登录、能力验证和进行中状态收敛', () => {
  assert.equal(
    cloudSyncDisabledReason({ authenticated: false, capabilityVerified: false, busy: false }),
    '请先在设置与云端登录云端账户',
  );
  assert.equal(
    cloudSyncDisabledReason({ authenticated: true, capabilityVerified: false, busy: false }),
    '请先在设置与云端完成 Stats v2 验证',
  );
  assert.equal(
    cloudSyncDisabledReason({ authenticated: true, capabilityVerified: true, busy: true }),
    null,
  );
  assert.equal(
    cloudSyncDisabledReason({ authenticated: true, capabilityVerified: true, busy: false }),
    null,
  );
});

test('看板刷新入口根据本地或云端动作暴露准确的进行中文案', () => {
  assert.deepEqual(
    dashboardRefreshCopy({ scope: 'local', statsLoading: false, scanBusy: true, syncBusy: false }),
    { busy: true, label: '扫描中…', ariaLabel: '正在扫描本地日志并刷新看板' },
  );
  assert.deepEqual(
    dashboardRefreshCopy({ scope: 'cloud', statsLoading: false, scanBusy: false, syncBusy: true }),
    { busy: true, label: '同步中…', ariaLabel: '正在同步并刷新云端看板' },
  );
  assert.deepEqual(
    dashboardRefreshCopy({ scope: 'cloud', statsLoading: true, scanBusy: false, syncBusy: false }),
    { busy: true, label: '加载中…', ariaLabel: '正在加载云端看板' },
  );
  assert.deepEqual(
    dashboardRefreshCopy({ scope: 'local', statsLoading: false, scanBusy: false, syncBusy: false }),
    { busy: false, label: '刷新扫描', ariaLabel: '刷新并扫描本地日志' },
  );
});

test('顶栏云端同步入口在进行期间暴露动作级反馈并锁定重复工作', () => {
  const source = readSource(path.join(process.cwd(), 'src', 'components', 'Sidebar.tsx'));
  assert.match(source, /const syncActionAriaLabel = busy\.sync[\s\S]*?正在同步云端数据[\s\S]*?请先检查云端状态[\s\S]*?立即同步云端/);
  assert.match(source, /aria-label=\{syncActionAriaLabel\}[\s\S]*disabled=\{syncDisabled\}[\s\S]*aria-busy=\{busy\.sync \|\| undefined\}/);
  assert.match(source, /title=\{syncActionTitle\}/);
  assert.match(source, /<Cloud className=\{`h-4 w-4 \$\{busy\.sync \? 'animate-spin' : ''\}`\}/);
});

test('明细加载、搜索和分页入口暴露准确的进行中文案', () => {
  assert.deepEqual(detailActionCopy('retry', false), {
    busy: false,
    label: '重新加载',
    ariaLabel: '重新加载消耗明细',
  });
  assert.deepEqual(detailActionCopy('retry', true), {
    busy: true,
    label: '加载中…',
    ariaLabel: '正在加载消耗明细',
  });
  assert.deepEqual(detailActionCopy('search', true), {
    busy: true,
    label: '应用中…',
    ariaLabel: '正在应用明细搜索',
  });
  assert.deepEqual(detailActionCopy('loadMore', false), {
    busy: false,
    label: '加载更多',
    ariaLabel: '加载更多消耗明细',
  });
  assert.deepEqual(detailActionCopy('loadMore', true), {
    busy: true,
    label: '正在加载…',
    ariaLabel: '正在加载下一页消耗明细',
  });
});

test('本地与云端统计失败都保留可信快照并提供就地恢复语义', () => {
  assert.deepEqual(
    statsErrorRecoveryCopy('local', '加载本地数据失败: 读取超时', 'load'),
    { title: '本地刷新失败，仍在显示最近一次可信数据', description: '加载本地数据失败: 读取超时' },
  );
  assert.deepEqual(
    statsErrorRecoveryCopy('cloud', '网络暂时不可用'),
    { title: '云端刷新失败，仍在显示当前范围最后一次可信数据', description: '网络暂时不可用' },
  );
  assert.equal(statsErrorRecoveryCopy('local', '   '), null);
});

test('额度失败在长趋势内容前提供可执行恢复入口', () => {
  const dashboard = readSource(path.join(process.cwd(), 'src', 'components', 'DashboardTab.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(dashboard, /function QuotaRecoveryCue\([\s\S]*className="quota-recovery-cue cloud-recovery-banner"/);
  assert.match(dashboard, /className="quota-recovery-cue cloud-recovery-banner"[\s\S]*role="region"[\s\S]*aria-label="额度失败恢复入口"/);
  assert.match(dashboard, /quotaError && \([\s\S]*<QuotaRecoveryCue[\s\S]*onRefresh=\{onRefreshQuotas\}[\s\S]*onOpenSettings=\{onOpenQuotaSettings\}/);
  assert.match(dashboard, /详细额度区位于下方；可以直接重新读取，或检查来源配置。/);
  assert.match(css, /\.quota-recovery-cue \{[\s\S]*display: flex;[\s\S]*var\(--color-danger-soft-bg\)/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.quota-recovery-cue \{[\s\S]*display: flex;/);
});

test('窄屏额度连续列表把指标移到来源身份下方，并在最窄宽度改为单列', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(css, /@container quota-panel \(max-width: 640px\) \{[\s\S]*?\.quota-card-header \{ grid-column: 1; \}[\s\S]*?\.quota-window-list \{ grid-column: 1 \/ -1;/);
  assert.match(css, /@container quota-panel \(max-width: 300px\) \{[\s\S]*?\.quota-window-list \{ grid-template-columns: 1fr;/);
});

test('本地扫描失败写入看板恢复状态而不是只显示一次性 Toast', () => {
  const stats = readSource(path.join(process.cwd(), 'src', 'hooks', 'useStats.ts'));
  assert.match(stats, /const errorMessage = `扫描失败: \$\{err\}`;/);
  assert.match(stats, /setStatsErrorAction\('scan'\);/);
  assert.match(stats, /setStatsError\(errorMessage\);[\s\S]*showMessage\('error', errorMessage\);/);
  const dashboard = readSource(path.join(process.cwd(), 'src', 'components', 'DashboardTab.tsx'));
  assert.match(dashboard, /statsErrorAction === 'scan'[\s\S]*onScan/);
  assert.match(dashboard, /'本地扫描失败，仍在显示最近一次可信数据'/);
  assert.match(dashboard, /'重试扫描'/);
});

test('后台统计重试失败保留看板恢复态而不打断用户 Toast', () => {
  const stats = readSource(path.join(process.cwd(), 'src', 'hooks', 'useStats.ts'));
  assert.match(stats, /interface LoadStatsOptions \{[\s\S]*notifyOnError\?: boolean;/);
  assert.match(stats, /async \(\{ notifyOnError = true \}: LoadStatsOptions = \{\}\)/);
  assert.match(stats, /setStatsErrorAction\('load'\);[\s\S]*if \(notifyOnError\) showMessage\('error', errorMessage\);/);
  assert.equal((stats.match(/loadStatsRef\.current\?\.\(\{ notifyOnError: false \}\)/g) || []).length, 4);
  const app = readSource(path.join(process.cwd(), 'src', 'App.tsx'));
  assert.match(app, /onRetryStats=\{\(\) => void statsHook\.loadStats\(\)\}/);
});

test('统计查询切换不重绑长期事件监听', () => {
  const stats = readSource(path.join(process.cwd(), 'src', 'hooks', 'useStats.ts'));
  assert.match(stats, /const loadStatsRef = useRef<\(\(options\?: LoadStatsOptions\) => Promise<void>\) \| null>\(null\);/);
  assert.match(stats, /const loadedStatsQueryRef = useRef<\(\(options\?: LoadStatsOptions\) => Promise<void>\) \| null>\(null\);/);
  assert.match(stats, /loadStatsRef\.current = loadStats;[\s\S]*if \(loadedStatsQueryRef\.current === loadStats\) return;[\s\S]*loadedStatsQueryRef\.current = loadStats;[\s\S]*void loadStats\(\);/);
  assert.match(stats, /stalled listener must not[\s\S]*endless loading state/);
  assert.match(stats, /unlistenQuotaSync\.then\(\(fn\) => fn\(\)\);[\s\S]*\}, \[\]\);/);
  assert.doesNotMatch(stats, /useEffect\(\(\) => \{[\s\S]*subscribeThenReconcile[\s\S]*\}, \[activeTab/);
  const app = readSource(path.join(process.cwd(), 'src', 'App.tsx'));
  assert.match(app, /clearCloudScopedState\(\);[\s\S]*void loadStats\(\);/);
});

test('额度刷新失败保留上次来源快照并给出重试语义', () => {
  const quota = readSource(path.join(process.cwd(), 'src', 'components', 'QuotaPanel.tsx'));
  const dashboard = readSource(path.join(process.cwd(), 'src', 'components', 'DashboardTab.tsx'));
  const quotaHook = readSource(path.join(process.cwd(), 'src', 'hooks', 'useQuota.ts'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(quota, /const hasProviderSnapshot = providers\.length > 0;/);
  assert.match(quota, /\{\(!error \|\| showRecoveryActions\) && \([\s\S]*aria-label=\{quotaRefreshAriaLabel\}[\s\S]*\{error && \([\s\S]*className="quota-panel-error" role="alert"[\s\S]*<span>\{error\}<\/span>[\s\S]*hasProviderSnapshot[\s\S]*仍显示上次读取到的来源结果[\s\S]*检查额度来源/);
  assert.doesNotMatch(quota, /className="quota-panel-error-actions"[\s\S]*重新读取额度/);
  assert.match(quotaHook, /setQuotaError\(formatQuotaLoadError\(err\)\);/);
  assert.equal((dashboard.match(/showRecoveryActions=\{false\}/g) || []).length, 2);
  assert.match(quota, /\{providers\.length === 0 && loading \?/);
  assert.doesNotMatch(quota, /\{error \? \([\s\S]*quota-panel-loading/);
  assert.match(css, /\.quota-panel-error \{[\s\S]*overflow-wrap: anywhere;[\s\S]*white-space: normal;/);
  assert.match(css, /\.quota-panel-error-detail \{[\s\S]*color: var\(--color-text-secondary\)/);
  assert.match(css, /\.quota-panel-error-actions \{[\s\S]*flex-wrap: wrap;/);
});

test('数据库信息失败保留上次快照并明确刷新恢复路径', () => {
  const settings = readSource(path.join(process.cwd(), 'src', 'hooks', 'useSettings.ts'));
  const dataHelp = readSource(path.join(process.cwd(), 'src', 'components', 'settings', 'DataHelpSection.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(settings, /const \[dbInfoError, setDbInfoError\] = useState\(''\);/);
  assert.match(settings, /setDbInfoError\(''\);[\s\S]*setDbInfo\(await invoke<DbInfo>\('get_db_info'\)\)/);
  assert.match(settings, /const errorMessage = `读取数据库信息失败: \$\{err\}`;[\s\S]*setDbInfoError\(errorMessage\);/);
  assert.match(dataHelp, /dbInfoError: string;/);
  assert.match(dataHelp, /const hasDbInfoSnapshot = dbInfo !== null;/);
  assert.match(dataHelp, /className="settings-data-error" role="alert"[\s\S]*仍显示上次读取到的本地数据库信息，可点击“刷新信息”重试/);
  assert.match(css, /\.settings-data-error \{[\s\S]*overflow-wrap: anywhere;/);
  assert.match(css, /\.settings-data-error-detail \{[\s\S]*color: var\(--color-text-secondary\)/);
});

test('统计恢复错误详情在窄屏可收缩并对长路径任意断行', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(css, /\.cloud-recovery-banner > div:first-child\s*\{[\s\S]*min-inline-size:\s*0;/);
  assert.match(css, /\.cloud-recovery-banner span\s*\{[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*white-space:\s*normal;/);
  assert.match(css, /\.empty-panel\.details-state-error > div:nth-child\(2\)\s*\{[\s\S]*min-inline-size:\s*0;[\s\S]*max-inline-size:\s*min\(100%,\s*56rem\);/);
  assert.match(css, /\.empty-panel\.details-state-error p\s*\{[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*white-space:\s*normal;/);
});

test('统计恢复动作在重试期间暴露忙碌语义并更新可见动作文案', () => {
  const dashboard = readSource(path.join(process.cwd(), 'src', 'components', 'DashboardTab.tsx'));
  assert.match(dashboard, /const statsRecoveryBusy = statsErrorAction === 'scan' \? scanBusy : statsLoading;/);
  assert.match(dashboard, /const statsRecoveryButtonLabel = statsRecoveryBusy[\s\S]*'扫描中…'[\s\S]*'加载中…'/);
  assert.match(dashboard, /role="alert" aria-busy=\{statsRecoveryBusy\}/);
  assert.match(dashboard, /disabled=\{statsRecoveryBusy\}/);
});

test('侧栏云端状态区分待验证与待首次同步', () => {
  assert.deepEqual(
    cloudSidebarStatusCopy({ authenticated: true, capabilityVerified: true, ready: true, pendingUploads: 12, statusKnown: false }),
    { label: '本地就绪 · 云端状态待检查', compactLabel: '待检查' },
  );
  assert.deepEqual(
    cloudSidebarStatusCopy({ authenticated: false, capabilityVerified: false, ready: false, pendingUploads: 12 }),
    { label: '本地就绪 · 云端未登录', compactLabel: '未登录' },
  );
  assert.deepEqual(
    cloudSidebarStatusCopy({ authenticated: true, capabilityVerified: false, ready: false, pendingUploads: 12 }),
    { label: '云端账户已登录 · 待完成验证', compactLabel: '待验证' },
  );
  assert.deepEqual(
    cloudSidebarStatusCopy({ authenticated: true, capabilityVerified: true, ready: false, pendingUploads: 12 }),
    { label: '云端账户已登录 · 待首次同步', compactLabel: '待同步' },
  );
  assert.deepEqual(
    cloudSidebarStatusCopy({ authenticated: true, capabilityVerified: true, ready: true, pendingUploads: 12 }),
    { label: '云端可用 · 12 条待上传', compactLabel: '待上传' },
  );
  assert.deepEqual(
    cloudSidebarStatusCopy({ authenticated: true, capabilityVerified: true, ready: true, pendingUploads: 0 }),
    { label: '本地就绪 · 云端可用', compactLabel: '云端可用' },
  );
});

test('设置目录只从真实状态生成可执行的分区徽标', () => {
  const base = {
    cloud: { configured: true, authenticated: true, capabilityVerified: false, firstSyncCompleted: false },
    quotaSyncStatus: { enabled: false, state: 'disabled' },
    quotaProviders: [],
    appSettings: {
      quota_codex_local_enabled: false,
      quota_claude_statusline_enabled: false,
      quota_claude_codexbar_enabled: false,
      quota_antigravity_local_enabled: false,
      wallpaper_consent_version: 1,
      wallpaper_desktop_enabled: false,
      wallpaper_lockscreen_enabled: false,
      autostart_enabled: false,
      start_minimized: false,
    },
    pricing: { error: '', dirty: false },
    dbInfo: { unsyncedRecords: 12 },
    dbInfoError: '',
  };
  assert.deepEqual(settingsNavigationStatus('settings-cloud', base), { label: '待验证', tone: 'attention' });
  assert.deepEqual(settingsNavigationStatus('settings-data', base), { label: '先验证 · 12条', tone: 'attention' });
  assert.deepEqual(settingsNavigationStatus('settings-data', {
    ...base,
    cloud: { configured: false, authenticated: false, capabilityVerified: false, firstSyncCompleted: false },
  }), { label: '先配置 · 12条', tone: 'attention' });
  assert.deepEqual(settingsNavigationStatus('settings-data', {
    ...base,
    cloud: { configured: true, authenticated: false, capabilityVerified: false, firstSyncCompleted: false },
  }), { label: '先登录 · 12条', tone: 'attention' });
  assert.deepEqual(settingsNavigationStatus('settings-data', {
    ...base,
    cloud: { configured: true, authenticated: true, capabilityVerified: true, firstSyncCompleted: false },
  }), { label: '首次同步 · 12条', tone: 'attention' });
  assert.deepEqual(settingsNavigationStatus('settings-data', {
    ...base,
    cloud: { configured: true, authenticated: true, capabilityVerified: true, firstSyncCompleted: true },
  }), { label: '12 条待同步', tone: 'attention' });
  assert.deepEqual(settingsNavigationStatus('settings-quota', {
    ...base,
    appSettings: { ...base.appSettings, quota_codex_local_enabled: true },
  }), { label: '1 个启用', tone: 'ready' });
  assert.deepEqual(settingsNavigationStatus('settings-quota', {
    ...base,
    quotaProviders: [
      { providerId: 'company-openapi-rnd', status: 'ok' },
      { providerId: 'company-openapi-prod', status: 'stale' },
    ],
  }), { label: '2 个来源', tone: 'ready' });
  assert.deepEqual(settingsNavigationStatus('settings-pricing', {
    ...base,
    pricing: { error: '', dirty: true },
  }), { label: '未保存', tone: 'attention' });
  // 读取失败必须与「正在读」区分：`dbInfo` 为 null 这一个状态原本同时表示两者，
  // 面板里已经显示了错误，目录徽章却会永远停在「读取中」。
  assert.deepEqual(settingsNavigationStatus('settings-data', {
    ...base,
    dbInfo: null,
    dbInfoError: '读取数据库信息失败: database is locked',
  }), { label: '读取失败', tone: 'attention' });
  assert.deepEqual(settingsNavigationStatus('settings-data', {
    ...base,
    dbInfo: null,
  }), { label: '读取中', tone: 'neutral' });
});

class FakeElement {
  constructor({ tagName = 'div', parent = null, dragBlock = false } = {}) {
    this.tagName = tagName.toLowerCase();
    this.parentElement = parent;
    this.dragBlock = dragBlock;
  }

  contains(target) {
    for (let element = target; element; element = element.parentElement) {
      if (element === this) return true;
    }
    return false;
  }

  closest(selector) {
    const selectors = selector.split(',');
    for (let element = this; element; element = element.parentElement) {
      if (
        selectors.includes(element.tagName)
        || (element.dragBlock && selectors.includes('[data-window-drag-block]'))
      ) {
        return element;
      }
    }
    return null;
  }
}

function withFakeElement(run) {
  const originalElement = globalThis.Element;
  globalThis.Element = FakeElement;
  try {
    run();
  } finally {
    if (originalElement === undefined) {
      delete globalThis.Element;
    } else {
      globalThis.Element = originalElement;
    }
  }
}

function windowGestureEvent(currentTarget, target, overrides = {}) {
  return {
    button: 0,
    currentTarget,
    defaultPrevented: false,
    detail: 1,
    target,
    ...overrides,
  };
}

function eligibleWindowActions(event) {
  return {
    drag: isWindowGesture(event, 1),
    maximize: isWindowGesture(event, 2),
  };
}

async function withMockedWindow(run) {
  const originalElement = globalThis.Element;
  const originalWindow = globalThis.window;
  globalThis.Element = FakeElement;
  globalThis.window = globalThis;
  try {
    const commands = [];
    mockWindows('main');
    mockIPC((command) => {
      commands.push(command);
    });
    await run(commands);
  } finally {
    clearMocks();
    if (originalElement === undefined) delete globalThis.Element;
    else globalThis.Element = originalElement;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
}

function handledWindowGestureEvent(currentTarget, target, overrides = {}) {
  let preventDefaultCalls = 0;
  return {
    ...windowGestureEvent(currentTarget, target, overrides),
    preventDefault() {
      preventDefaultCalls += 1;
    },
    get preventDefaultCalls() {
      return preventDefaultCalls;
    },
  };
}

const summary = {
  totalTokens: 1, inputTokens: 1, outputTokens: 0, cachedTokens: 0,
  totalCost: 0, totalRequests: 1, avgTokensPerReq: 1,
};

function dashboardFixture(name) {
  return parseStatsDataContract(JSON.parse(readSource(
    path.join(process.cwd(), 'fixtures', 'dashboard-stats-v2', name))));
}

function queryFixture(name) {
  return JSON.parse(readSource(
    path.join(process.cwd(), 'fixtures', 'dashboard-stats-v2', name)));
}

function quotaFixture(name) {
  return JSON.parse(readSource(
    path.join(process.cwd(), 'fixtures', 'quota-provider-v1', name)));
}

function populatedDashboardSource() {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'DashboardTab.tsx'));
  return source.slice(source.lastIndexOf('\n  return ('));
}

function page(items, nextCursor = null) {
  return {
    items,
    nextCursor,
    hasMore: nextCursor !== null,
    totalCount: items.length,
    filteredSummary: summary,
    availableFilters: { tools: [], models: [], machines: [] },
    granularity: 'request',
  };
}

function comparisonSeries(tokens, bucket = 'hour', period = 'current') {
  return tokens.map((value, index) => ({
    bucket: bucket === 'hour'
      ? `${String(index).padStart(2, '0')}:00`
      : `2026-${period === 'current' ? '07' : '06'}-${String(index + 1).padStart(2, '0')}`,
    tokens: value,
    requests: value > 0 ? 1 : 0,
    cost: 0,
  }));
}

function comparisonFixture(current, previous, bucket = 'hour') {
  return {
    window: { bucket },
    current: { series: comparisonSeries(current, bucket, 'current') },
    previous: { series: comparisonSeries(previous, bucket, 'previous') },
  };
}

test('stats subscription reconciles after registration and receives later events', async () => {
  let registeredHandler = null;
  let finishRegistration = null;
  let reconciliations = 0;
  let events = 0;
  let unlistens = 0;
  const pending = subscribeThenReconcile(
    (handler) => new Promise((resolve) => {
      registeredHandler = handler;
      finishRegistration = () => resolve(() => { unlistens += 1; });
    }),
    () => { events += 1; },
    () => { reconciliations += 1; },
  );

  // A backend event emitted before Tauri resolves listen() cannot be replayed.
  // The post-registration reconciliation must still fetch the current state.
  assert.equal(reconciliations, 0);
  finishRegistration();
  const unlisten = await pending;
  assert.equal(reconciliations, 1);
  assert.equal(events, 0);

  registeredHandler();
  assert.equal(events, 1);
  unlisten();
  assert.equal(unlistens, 1);
});

test('stats subscription cleans up a late registration without stale reconciliation', async () => {
  let finishRegistration = null;
  let disposed = false;
  let reconciliations = 0;
  let unlistens = 0;
  const pending = subscribeThenReconcile(
    () => new Promise((resolve) => {
      finishRegistration = () => resolve(() => { unlistens += 1; });
    }),
    () => {},
    () => { reconciliations += 1; },
    () => disposed,
  );

  disposed = true;
  finishRegistration();
  assert.equal(await pending, null);
  assert.equal(reconciliations, 0);
  assert.equal(unlistens, 1);
});

test('focus and visibility recovery coalesces a visible burst', async () => {
  let reconciliations = 0;
  let visibility = 'hidden';
  const reconciler = createVisibleStatsReconciler(
    () => visibility,
    () => { reconciliations += 1; },
    5,
  );
  assert.equal(reconciler.request(), false);
  visibility = 'visible';
  assert.equal(reconciler.request(), true);
  assert.equal(reconciler.request(), true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(reconciliations, 1);
});

test('focus recovery cancellation prevents a post-unmount read', async () => {
  let reconciliations = 0;
  const reconciler = createVisibleStatsReconciler(
    () => 'visible',
    () => { reconciliations += 1; },
    5,
  );
  reconciler.request();
  reconciler.cancel();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(reconciliations, 0);
});

test('stats views wire subscribe-first and visible recovery into production effects', () => {
  const app = [
    readSource(path.join(process.cwd(), 'src', 'App.tsx')),
    readSource(path.join(process.cwd(), 'src', 'hooks', 'useStats.ts')),
  ].join('\n');
  const liveWallpaper = readSource(
    path.join(process.cwd(), 'src', 'components', 'LiveWallpaperView.tsx'));
  for (const source of [app]) {
    assert.match(source, /subscribeThenReconcile\(/);
    assert.match(source, /createVisibleStatsReconciler\(/);
    assert.match(source, /document\.addEventListener\('visibilitychange', reconcileVisibleStats\)/);
    assert.match(source, /document\.removeEventListener\('visibilitychange', reconcileVisibleStats\)/);
    assert.match(source, /visibleReconciler\.cancel\(\)/);
  }
  assert.match(liveWallpaper, /createVisibleStatsReconciler\(/);
  assert.match(liveWallpaper, /document\.addEventListener\('visibilitychange', visibleReconciler\.request\)/);
  assert.match(liveWallpaper, /document\.removeEventListener\('visibilitychange', visibleReconciler\.request\)/);
  assert.match(liveWallpaper, /visibleReconciler\.cancel\(\)/);
  assert.match(app, /window\.addEventListener\('focus', reconcileVisibleStats\)/);
  assert.match(app, /window\.removeEventListener\('focus', reconcileVisibleStats\)/);
});

test('request generations reject stale completions and explicit invalidation', () => {
  const generation = { current: 0 };
  const first = beginRequest(generation);
  const second = beginRequest(generation);
  assert.equal(isCurrentRequest(generation, first), false);
  assert.equal(isCurrentRequest(generation, second), true);
  invalidateRequest(generation);
  assert.equal(isCurrentRequest(generation, second), false);
});

test('detail append preserves prior order and takes next-page metadata', () => {
  const merged = mergeUsageDetails(page([{ id: 1 }], 'cursor-1'), page([{ id: 2 }]), true);
  assert.deepEqual(merged.items.map((item) => item.id), [1, 2]);
  assert.equal(merged.hasMore, false);
});

test('legacy unavailable envelopes are detected before nullable fields are read', () => {
  const unavailable = {
    status: 'unavailable', items: [], nextCursor: null, hasMore: null,
    totalCount: null, filteredSummary: null, availableFilters: null, granularity: null,
  };
  assert.equal(isUnavailableEnvelope(unavailable), true);
  assert.equal(isUnavailableEnvelope(page([])), false);
});

test('cloud v2 entry points fail closed when version or capability is absent', () => {
  assert.equal(hasCloudCapability(null, 'detailPagination'), false);
  assert.equal(hasCloudCapability({ meta: { contractVersion: 1 } }, 'detailPagination'), false);
  assert.equal(hasCloudCapability({ meta: { contractVersion: 2, capabilities: {} } }, 'entityDashboard'), false);
  assert.equal(hasCloudCapability({ meta: { contractVersion: 2, capabilities: { entityDashboard: true } } }, 'entityDashboard'), true);
});

// One tool per primary slot 1..8, none colliding — resolves straight to the
// 8 raw slot colours in slot order. Shared by the FI-5 mirror-guard test
// below and the T10.187 review P2-1 fixture-equality tests.
const SLOT_PROBE = ['antigravity', 'codex', 'pi', 'opencode', 'reasonix', 'claude', 'kilo', 'minimax'];

function extractChartHexTokens(section) {
  const found = {};
  for (const match of section.matchAll(/--chart-([1-8]):\s*(#[0-9a-fA-F]{6})/g)) {
    found[Number(match[1])] = match[2].toLowerCase();
  }
  return [1, 2, 3, 4, 5, 6, 7, 8].map((n) => found[n]);
}

function readPaletteBFixture() {
  return JSON.parse(readSource(path.join(process.cwd(), 'fixtures', 'tool-chart-slots-v1', 'palette-b.json')));
}

test('T10.178 review FI-5: types.ts\'s CHART_SLOT_COLORS mirror of src/styles/tokens.css --chart-1..8 has not silently drifted, in either scope', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'styles', 'tokens.css'));
  const lightScopeStart = css.indexOf(':root[data-theme="light"] {');
  const forcedColorsStart = css.indexOf('@media (forced-colors: active)');
  assert.ok(lightScopeStart > 0, 'tokens.css light scope marker moved or was removed');
  assert.ok(forcedColorsStart > lightScopeStart, 'tokens.css forced-colors marker moved or was removed');
  const cssDark = extractChartHexTokens(css.slice(0, lightScopeStart));
  const cssLight = extractChartHexTokens(css.slice(lightScopeStart, forcedColorsStart));
  assert.deepEqual(cssDark, colorsForToolsInView(SLOT_PROBE, 'dark').map((c) => c.toLowerCase()));
  assert.deepEqual(cssLight, colorsForToolsInView(SLOT_PROBE, 'light').map((c) => c.toLowerCase()));
});

test('T10.187 shared fixture: fixtures/tool-chart-slots-v1/slots.json matches toolChartSlot/assignToolChartSlots (also read by src-tauri/src/wallpaper.rs via include_str!; moved from tests/fixtures/ in the T10.187 review P3-3 fix round)', () => {
  const fixture = JSON.parse(readSource(path.join(process.cwd(), 'fixtures', 'tool-chart-slots-v1', 'slots.json')));

  const registered = Object.entries(fixture.registered);
  assert.ok(registered.length > 0, 'fixture.registered must not be empty');
  for (const [name, slot] of registered) {
    assert.equal(toolChartSlot(name), slot, `registered ${name}`);
  }

  const aliases = Object.entries(fixture.aliases);
  assert.ok(aliases.length > 0, 'fixture.aliases must not be empty');
  for (const [name, slot] of aliases) {
    assert.equal(toolChartSlot(name), slot, `alias ${name}`);
  }

  const hashed = Object.entries(fixture.hashedUnregistered);
  assert.ok(hashed.length > 0, 'fixture.hashedUnregistered must not be empty');
  for (const [name, slot] of hashed) {
    assert.equal(toolChartSlot(name), slot, `hashed ${JSON.stringify(name)}`);
  }

  const { namesInRankOrder: collisionNames, slots: collisionSlots } = fixture.collisionAndWrap;
  assert.deepEqual(assignToolChartSlots(collisionNames), collisionSlots, 'collisionAndWrap');

  const { namesInRankOrder: nineNames, assignment: nineAssignment } = fixture.nineToolView;
  assert.deepEqual(assignToolChartSlots(nineNames), nineAssignment, 'nineToolView');
});

test('T10.187 review P3-1: ECMAScript-trim edge cases from the shared fixture resolve to the same slot as toolChartSlot (desktop TS)', () => {
  // Desktop JS trim() is already ECMAScript by definition, so this test is a
  // regression lock, not a fix: the fix this round is in wallpaper.rs, which
  // reads the same 12 vectors via its own Rust test.
  const fixture = JSON.parse(readSource(path.join(process.cwd(), 'fixtures', 'tool-chart-slots-v1', 'slots.json')));
  const cases = fixture.trimProbes?.cases;
  assert.ok(Array.isArray(cases) && cases.length > 0, 'fixture.trimProbes.cases must be a non-empty array');
  for (const { name, slot } of cases) {
    assert.equal(toolChartSlot(name), slot, `toolChartSlot(${JSON.stringify(name)})`);
  }
});

test('T10.187 review P2-1: src/styles/tokens.css --chart-1..8 (dark and light) matches the shared palette-b fixture', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'styles', 'tokens.css'));
  const lightScopeStart = css.indexOf(':root[data-theme="light"] {');
  const forcedColorsStart = css.indexOf('@media (forced-colors: active)');
  assert.ok(lightScopeStart > 0, 'tokens.css light scope marker moved or was removed');
  assert.ok(forcedColorsStart > lightScopeStart, 'tokens.css forced-colors marker moved or was removed');
  const fixture = readPaletteBFixture();
  const cssDark = extractChartHexTokens(css.slice(0, lightScopeStart));
  const cssLight = extractChartHexTokens(css.slice(lightScopeStart, forcedColorsStart));
  assert.deepEqual(cssDark, fixture.dark.slots.map((c) => c.toLowerCase()), 'tokens.css dark --chart-1..8 vs fixture.dark.slots');
  assert.deepEqual(cssLight, fixture.light.slots.map((c) => c.toLowerCase()), 'tokens.css light --chart-1..8 vs fixture.light.slots');
});

test('T10.187 review P2-1: src/types.ts CHART_SLOT_COLORS_DARK/LIGHT and TOOL_COLOR_OTHER_DARK/LIGHT match the shared palette-b fixture', () => {
  // CHART_SLOT_COLORS_DARK/LIGHT and TOOL_COLOR_OTHER_DARK/LIGHT are
  // module-private; read them indirectly through the exported
  // colorsForToolsInView, the same technique the FI-5 test above uses, so
  // this test does not have to widen types.ts's public surface.
  const fixture = readPaletteBFixture();
  const NINE_TOOL_VIEW = [...SLOT_PROBE, 'gemini']; // gemini primary-hashes to slot 1, already taken -> 'other'
  assert.deepEqual(
    colorsForToolsInView(SLOT_PROBE, 'dark').map((c) => c.toLowerCase()),
    fixture.dark.slots.map((c) => c.toLowerCase()),
    'types.ts CHART_SLOT_COLORS_DARK vs fixture.dark.slots',
  );
  assert.deepEqual(
    colorsForToolsInView(SLOT_PROBE, 'light').map((c) => c.toLowerCase()),
    fixture.light.slots.map((c) => c.toLowerCase()),
    'types.ts CHART_SLOT_COLORS_LIGHT vs fixture.light.slots',
  );
  assert.equal(
    colorsForToolsInView(NINE_TOOL_VIEW, 'dark')[8].toLowerCase(),
    fixture.dark.other.toLowerCase(),
    'types.ts TOOL_COLOR_OTHER_DARK vs fixture.dark.other',
  );
  assert.equal(
    colorsForToolsInView(NINE_TOOL_VIEW, 'light')[8].toLowerCase(),
    fixture.light.other.toLowerCase(),
    'types.ts TOOL_COLOR_OTHER_LIGHT vs fixture.light.other',
  );
});

test('T10.187 review P2-1: src/utils/chartTheme.ts CHART_SERIES_FALLBACK matches the shared palette-b fixture (dark)', () => {
  // This file runs under plain Node (no document/window global), so
  // getChartThemeTokens() takes its own no-DOM branch and getCssToken()
  // returns CHART_SERIES_FALLBACK directly and deterministically -- the only
  // way to observe this module-private constant's value without widening
  // chartTheme.ts's exports.
  const fixture = readPaletteBFixture();
  const tokens = getChartThemeTokens('dark');
  assert.deepEqual(
    tokens.seriesPalette.map((c) => c.toLowerCase()),
    fixture.dark.slots.map((c) => c.toLowerCase()),
    'chartTheme.ts CHART_SERIES_FALLBACK vs fixture.dark.slots',
  );
});

test('T10.178 review P1-1 fix round: every tool-coloured panel resolves colours through same-view collision-shift, not a lone colorForTool(name, index) call', () => {
  // DashboardTab computes one screen-wide assignment from activeToolsList (the
  // same list ToolStrip/TrendPanel already use) and hands it to
  // CostEfficiencyQuadrantPanel, so a tool reads the same colour in every
  // panel on the tab instead of each panel resolving its own same-slot
  // collisions from a differently-ordered model/point list.
  const dashboardTab = readSource(path.join(process.cwd(), 'src', 'components', 'DashboardTab.tsx'));
  assert.match(dashboardTab, /const toolColors = toolColorMap\(activeToolsList\.map\(\(tool\) => tool\.name\), effective\);/);
  assert.match(dashboardTab, /<CostEfficiencyQuadrantPanel models=\{allModelsList\}[^>]*toolColors=\{toolColors\}/);

  const quadrantPanel = readSource(path.join(process.cwd(), 'src', 'components', 'CostEfficiencyQuadrantPanel.tsx'));
  assert.match(quadrantPanel, /toolColors\?: Map<string, string>/);
  assert.match(quadrantPanel, /colors\.get\(\(item\.model\.tool \|\| item\.model\.name\)\.toLowerCase\(\)\)/);
  assert.match(quadrantPanel, /pointOpacity = effectiveTheme === 'light' \? 1 : 0\.88/);

  const logsTable = readSource(path.join(process.cwd(), 'src', 'components', 'LogsTable.tsx'));
  assert.match(logsTable, /toolColorMap\(ranked, effective\)/);
  assert.match(logsTable, /toolColors\.get\(log\.tool\.toLowerCase\(\)\) \?\? colorForTool\(log\.tool, 0, effective\)/);

  const behaviorView = readSource(path.join(process.cwd(), 'src', 'components', 'BehaviorAnalysisView.tsx'));
  // Review P1-1: tool-ranking and session-ranking share one assignment computed
  // from data.tools, instead of the session list calling colorForTool alone.
  assert.match(behaviorView, /const toolColorAssignment = useMemo\(\s*\(\) => toolColorMap\(\(data\?\.tools \|\| \[\]\)\.map\(\(item\) => item\.id\), effective\),\s*\[data, effective\],\s*\);/);
  assert.match(behaviorView, /toolColorAssignment\.get\(item\.id\.toLowerCase\(\)\)/);
  assert.match(behaviorView, /toolColorAssignment\.get\(session\.tool\.toLowerCase\(\)\)/);

  const trendPanel = readSource(path.join(process.cwd(), 'src', 'components', 'TrendPanel.tsx'));
  // Review P2-5: without itemStyle.color, ECharts falls back to the default
  // palette for the legend swatch and tooltip marker, silently undoing the
  // same-view collision-shift for the one visible place it mattered most.
  assert.match(trendPanel, /lineStyle: \{ width: 2\.25, color \},[\s\S]*?itemStyle: \{ color \},/);
  assert.doesNotMatch(trendPanel, /color: getPalette\(effective\)/);
  // Review B1: colour is not the only cue — the line's own name sits at its
  // end, nudged apart from an overlapping neighbour instead of stacking on it.
  assert.match(trendPanel, /endLabel: \{[\s\S]*?formatter: \(\) => seriesLabel\(tool\),/);
  assert.match(trendPanel, /labelLayout: \{ moveOverlap: 'shiftY' \}/);
});

test('Android dashboard action rows merge visible content into explicit TalkBack actions', () => {
  // T10.143f 起看板界面拆在 LedgerDashboardV2Ui.kt 门面 + ui/** 里，取源方式见 readAndroidDashboardUi。
  const androidUi = readAndroidDashboardUi();
  assert.match(androidUi, /role = Role\.Button,\s*onClickLabel = "打开筛选",\s*onClick = onClick[\s\S]*?semantics\(mergeDescendants = true\)\s*\{\s*contentDescription = accessibilityDescription/);
  const sourceRow = androidUiDeclaration('V2SourceRow');
  assert.match(sourceRow, /clickable\(role = Role\.Button, onClickLabel = actionLabel, onClick = onClick\)/);
  assert.match(sourceRow, /semantics\(mergeDescendants = true\)[\s\S]*?contentDescription/);
  assert.match(sourceRow, /selectionState[\s\S]*?selected =/);
  assert.match(androidUi, /if \(isSelected\) "取消筛选工具/);
  assert.match(androidUi, /else "筛选工具/);
  assert.match(androidUi, /val actionLabel = if \(compact\) "打开日历洞察" else "查看活跃日历"[\s\S]*?onClickLabel = actionLabel[\s\S]*?semantics\(mergeDescendants = true\)/);
});

test('Android dashboard top actions and navigation expose explicit TalkBack actions', () => {
  const androidUi = readAndroidDashboardUi();
  // T10.72 把圆形底色移进 40dp 内层 Box，外层 IconButton 只留 48dp 命中区。
  // 契约要断言的是「命中区 + 显式 TalkBack 动作名」，不是当时那条 Modifier 链的
  // 书写顺序——所以这里按 V2RoundIconButton 的语义边界断言，不再钉死背景色调用。
  // 旧切片止于 V2NavigationBar，顺带覆盖了紧随其后的 V2IconAction，这里照原样一并取。
  const roundIconButton = androidUiDeclaration('V2RoundIconButton', 'V2IconAction');
  assert.match(roundIconButton, /\.size\(48\.dp\)\s*\.semantics\s*\{\s*onClick\(label, null\)\s*\}/);
  // T10.130 给按压加了缩放与底色补间，底色从字面量变成 animateColorAsState 的产物。
  // 契约仍然是「40dp 圆形实底 + 48dp 命中区」，所以只钉形状与实底，不钉那一次取色。
  assert.match(roundIconButton, /\.clip\(CircleShape\)\s*\.background\(\w+\)/);
  assert.match(roundIconButton, /animateColorAsState\([\s\S]{0,200}?Color\.Transparent/);
  assert.match(androidUi, /modifier = Modifier\.semantics\s*\{\s*onClick\("切换到\$\{destination\.label\}", null\)\s*\}/);
});

test('Android dashboard secondary actions keep explicit TalkBack labels', () => {
  const androidUi = readAndroidDashboardUi();
  assert.match(androidUi, /onClickLabel = "打开额度详情"/);
  assert.match(androidUi, /val actionLabel = actionLabelOverride \?\: if \(isExpanded != null\)[\s\S]*?\.clickable\(role = Role\.Button, onClickLabel = actionLabel, onClick = onClick\)/);
  assert.match(androidUi, /\.clickable\(role = Role\.Button, onClickLabel = "切换为\$nextVisualLabel"\)/);
  // 工具与模型的下钻行都走 V2SourceRow：默认动作名「打开 $label 专属看板」、48dp 命中区与按钮角色锁在这里。
  // 旧断言守的是零调用方的 V2ModelCostDistribution，T10.170 删除它后改守现行实现（T10.166 评审 §5.3）；
  // 旧的可见文字「查看「…」专属看板 →」在现行实现里没有对应物，不再断言。
  const drillRow = androidUiDeclaration('V2SourceRow');
  assert.match(drillRow, /"打开 \$label 专属看板"/);
  assert.match(drillRow, /\.heightIn\(min = 48\.dp\)[\s\S]*?\.clickable\(role = Role\.Button, onClickLabel = actionLabel, onClick = onClick\)/);
  assert.match(androidUi, /NavigationRailItem\([\s\S]*?modifier = Modifier\.semantics\s*\{\s*onClick\("切换到\$\{destination\.label\}", null\)/);
});

test('Android day review connects local navigation, system Back and complete query callbacks', () => {
  // 下面的锚点都在看板屏幕这一个组合函数里；只取它，免得 BackHandler 之类的通用锚点落到别的文件。
  const ui = androidUiDeclaration('LedgerDashboardV2Screen');
  const block = (start, end) => {
    const from = ui.indexOf(start);
    const to = ui.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `missing navigation block: ${start}`);
    return ui.slice(from, to);
  };
  const open = block('val openDayReview:', 'BackHandler(enabled');
  assert.match(open, /val origin = insightPane[\s\S]*?if \(onOpenDay\(date\)\) \{[\s\S]*?if \(!dayReviewOpen\) dayReviewOriginPane = origin[\s\S]*?dayReviewOpen = true[\s\S]*?dayBackCallback\.isEnabled = true[\s\S]*?openInsight\(InsightPane\.Details\)/);
  const returning = block('val returnFromDayReview =', 'val openDayReview:');
  assert.match(returning, /dayReviewOpen = false[\s\S]*?onReturnFromDay\(\)[\s\S]*?openInsight\(dayReviewOriginPane\)/);
  assert.match(returning, /OnBackPressedCallback\(false\)[\s\S]*?isEnabled = false[\s\S]*?currentDayReturn\(\)/);
  assert.match(returning, /SideEffect \{[\s\S]*?dayBackCallback\.isEnabled = !showSettings && \(dayReviewOpen \|\| state\.dayReviewReturn != null\)/);
  const back = block('BackHandler(enabled', 'fun selectDestination(');
  assert.match(back, /showSettings \|\| entityMode/);
  assert.doesNotMatch(back, /dayReviewReturn|returnFromDayReview/);
  const destination = block('fun selectDestination(', 'fun selectInsight(');
  assert.match(destination, /if \(dayReviewOpen \|\| state\.dayReviewReturn != null\) \{\s*dayReviewOpen = false\s*onReturnFromDay\(\)\s*insightPane = dayReviewOriginPane\s*\}[\s\S]*?destination = next/);
  // 路由、额度与我的不写回旧 DashboardSection（重构方案 v2 四分区）。T10.143c 把原先内联的
  // `MobileDestination.Quota, MobileDestination.Widget -> Unit` 分支收进
  // MobileDestination.dashboardSection(insightPane)，改为映射成 null 后由 `?.let` 跳过
  // （T10.143c 交付日志：「额度与展示不写回旧 section」）；两处一起守，语义不变。
  assert.match(destination, /next\.dashboardSection\(insightPane\)\?\.let\(onSectionChange\)/);
  assert.match(androidUiDeclaration('MobileDestination.dashboardSection'), /MobileDestination\.Routing, MobileDestination\.Quota, MobileDestination\.Me -> null/);
  const insight = block('fun selectInsight(', 'CompositionLocalProvider(');
  assert.match(insight, /if \(\(dayReviewOpen \|\| state\.dayReviewReturn != null\) && next != InsightPane\.Details\) \{\s*dayReviewOpen = false\s*onReturnFromDay\(\)\s*\}/);
  assert.match(ui, /onOpenDay = openDayReview/);
  assert.match(ui, /onReturnFromDay = returnFromDayReview/);
});

test('Android filter sheet exposes its title as a TalkBack heading', () => {
  // 旧写法从 V2FilterSheetContent 一直切到巨石文件末尾；拆分后只取这张筛选面板本身。
  const filterSheet = androidUiDeclaration('V2FilterSheetContent');
  assert.match(filterSheet, /Text\(\s*"筛选看板"[\s\S]{0,260}?modifier = Modifier\.semantics\s*\{\s*heading\(\)\s*\}/);
});

test('Android dashboard range and insight selectors expose one selected radio option', () => {
  // 各段覆盖的声明与拆分前的旧切片逐一对应（例如 V2RangeOption 那段原本一直切到 V2HeroCard，
  // 顺带跨过 V2QueryContext 与 V2FilterButton）。
  const block = (...names) => androidUiDeclaration(...names);
  const rangeSelector = block('V2GlobalRangeControl');
  assert.match(rangeSelector, /\.semantics \{ selectableGroup\(\) \}/);
  assert.match(rangeSelector, /V2RangeOption\(palette, range, query\.range == range, onSelect/);
  assert.match(rangeSelector, /selected = query\.range == RangeKey\.Custom[\s\S]*?role = Role\.RadioButton[\s\S]*?stateDescription = if \(query\.range == RangeKey\.Custom\) "已选择" else "未选择"/);
  const rangeOption = block('V2RangeOption', 'V2QueryContext', 'V2FilterButton');
  assert.match(rangeOption, /this\.selected = active[\s\S]*?role = Role\.RadioButton[\s\S]*?stateDescription = if \(active\) "已选择" else "未选择"/);
  // 重构 R2 把用量子页签换成下划线页签：不再走分段控件，单选语义在它自己身上查。
  const insightStrip = block('V2InsightStrip');
  assert.match(insightStrip, /\.semantics \{ selectableGroup\(\) \}/);
  assert.match(insightStrip, /val active = pane == selected/);
  assert.match(insightStrip, /\.clickable\(enabled = enabled, role = Role\.Tab\)[\s\S]*?this\.selected = active[\s\S]*?stateDescription = if \(active\) "已选择" else "未选择"/);
  const segmented = block('V2SegmentedToggle');
  assert.match(segmented, /\.semantics \{ selectableGroup\(\) \}/);
  assert.match(segmented, /val active = option\.value == selected/);
  assert.match(segmented, /this\.selected = active[\s\S]*?stateDescription = if \(active\) "已选择" else "未选择"/);
});

// T10.130：第 7 条「有双态的数据图表有些用切页有些用按钮，不统一」。
// 收敛前同一件事有四种长相与三种读屏角色；这条钉住"只有一个实现，所有切换都走它"。
test('Android 导航复用分段控件，内容指标直接点击切换', () => {
  const androidUi = readAndroidDashboardUi();

  assert.equal((androidUi.match(/(?:private|internal) fun <T> V2SegmentedToggle\(/gu) ?? []).length, 1);
  // 用量子页签（V2InsightStrip）自重构 R2 起是下划线页签，不在此列。
  for (const caller of ['V2MetricModeToggle', 'V2CurrencyToggle']) {
    assert.match(androidUiDeclaration(caller), /V2SegmentedToggle\(/u, `${caller} 没走共享分段控件`);
  }
  // Token 口径不走分段控件：REQ-ANDROID-01 要求它「向 TalkBack 暴露 Switch 状态，不额外侵占一整行
  // 分段按钮」，DESIGN §6.2 同样写明「以整卡 Switch 语义切换……不单列分段控制」。T10.130 曾把
  // V2TokenModeToggle 改成分段控件，T10.137 按评审 R4「维持直接点击的轻量方式」（用户批准）改回
  // 走 tokenModeToggle 的直接点击。它仍是内容指标的直接点击切换，正是本条标题说的那一类。
  const tokenToggle = androidUiDeclaration('V2TokenModeToggle');
  assert.doesNotMatch(tokenToggle, /V2SegmentedToggle\(/u, 'Token 口径又长出了一整行分段按钮');
  assert.match(tokenToggle, /\.tokenModeToggle\(current, onChange\)/u, 'Token 口径没走 Switch 语义的直接点击');
  // 模型分布此前是两个全宽 TextButton，语义还是 RadioButton，与趋势卡的 Tab 对不上。
  const modelCard = androidUiDeclaration('V2ModelDistributionCard');
  assert.match(modelCard, /clickable\(\s*role = Role\.Button, onClickLabel =/u);
  assert.match(modelCard, /heightIn\(min = 48\.dp\)/u);
  assert.doesNotMatch(modelCard, /V2SegmentedToggle\(/u);
  assert.doesNotMatch(modelCard, /ModelMetricMode\.entries\.forEach[\s\S]{0,400}?TextButton\(/u);

  // 布局高度（touchHeight）与可见高度（visibleHeight）仍分开计算，触达区不低于 48dp。
  // T10.130 曾把可见高度收回 40dp；T10.138（A2「触控目标 40dp→48dp 并全库扫描」，GLB-03，用户授权）
  // 把 V2_CONTROL_HEIGHT 改成直接取 V2_TOUCH_TARGET——它同时是几处按钮唯一的最小高度，40dp 时那几处
  // 触达区不足 48dp。所以这里钉的是「控件高度就取触达下限」，不再钉 40dp。
  // T10.208（A1 导航壳，root 决定 R-40）：320dp × 200% 下引入的五段范围控件会让某一段的文字
  // 真的走到两行兜底，钉死的 `.height(...)` 会把两行文字连同滑动胶囊一起裁掉一半（评审 R2-P3-1）。
  // 轨道与可点区改成 `heightIn(min = ...)`，随两行文字一起长高，不再钉死成单行的可见高度。
  const segmented = androidUiDeclaration('V2SegmentedToggle');
  assert.match(segmented, /\.heightIn\(min = touchHeight\)/u);
  assert.match(segmented, /\.heightIn\(min = visibleHeight\)/u);
  assert.match(androidUi, /(?:private|internal) val V2_CONTROL_HEIGHT = V2_TOUCH_TARGET\b/u);
  assert.match(androidUi, /(?:private|internal) val V2_TOUCH_TARGET = 48\.dp/u);
  // 分段控件与按钮都不得再写死超过触达下限的可见高度。
  assert.doesNotMatch(androidUi, /heightIn\(min = 49\.dp\)/u);
});

test('Android token and cost switches expose action-specific TalkBack labels', () => {
  const androidUi = readAndroidDashboardUi();
  // 概览卡的主数字本身就是切换入口（Modifier.tokenModeToggle），它仍然是 Switch；
  // T10.130 只把"卡片外的那个双态控件"换成了分段控件。
  assert.match(androidUi, /"\$\{current\.label\} Token，双击切换为\$\{next\.label\} Token"[\s\S]*?onClick\("切换为\$\{next\.label\} Token", null\)/);
  assert.match(androidUi, /contentDescription = costMaskAccessibilityDescription\(isCostMasked\)[\s\S]*?onClick\(costMaskActionLabel\(isCostMasked\), null\)/);
  // T10.207（T10.154 A02）：隐藏费用开关的动作名与描述只在 LedgerUiLogic 写一次，叫法「显示 / 隐藏预估费用」。
  const logic = readSource(
    path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile', 'LedgerUiLogic.kt'));
  assert.match(logic, /internal fun costMaskActionLabel\(masked: Boolean\): String =\s*if \(masked\) "显示预估费用" else "隐藏预估费用"/);
  assert.match(logic, /internal fun costMaskAccessibilityDescription\(masked: Boolean\): String =\s*if \(masked\) "预估费用已隐藏，双击显示" else "预估费用已显示，双击隐藏"/);
  assert.doesNotMatch(androidUi, /"(?:显示|隐身|隐藏)预估成本"/u, '隐藏费用开关又写回了旧叫法');
});

test('Android dashboard token mode exposes exactly one switch entry per surface', () => {
  const androidUi = readAndroidDashboardUi();
  // T10.130 曾把 V2TokenModeToggle 从"点一下轮转的开关 + 一行『切换口径』说明"改成两态并排的分段控件。
  // 这与 REQ-ANDROID-01（「向 TalkBack 暴露 Switch 状态，不额外侵占一整行分段按钮」）和 DESIGN §6.2
  // （「以整卡 Switch 语义切换，卡头显示当前口径与下一口径，不单列分段控制」）相反；T10.137 按评审
  // R4「维持直接点击的轻量方式」（用户批准）改回 tokenModeToggle 的 Switch。两个口径仍都要被读屏
  // 念到名字：不带数值时描述是「当前口径 Token，双击切换为下一口径 Token」。
  const tokenToggle = androidUiDeclaration('V2TokenModeToggle');
  assert.doesNotMatch(tokenToggle, /V2SegmentedToggle\(/u);
  assert.match(tokenToggle, /\.heightIn\(min = 48\.dp\)\.tokenModeToggle\(current, onChange\)/u);
  assert.match(
    androidUiDeclaration('Modifier.tokenModeToggle'),
    /role = Role\.Switch[\s\S]*?if \(displayedValue == null\) \{\s*"\$\{current\.label\} Token，双击切换为\$\{next\.label\} Token"/u,
  );
  assert.doesNotMatch(tokenToggle, /切换口径/u, '轮转开关的说明行应随控件一起删掉');

  // 下钻卡保留独立开关；概览卡与趋势卡（根据真机走查决策）以主数字作为唯一切换入口，
  // 消除重复按钮并保持 48dp 命中区与语义合并。
  const entityHero = androidUiDeclaration('V2EntityHeroCard');
  assert.doesNotMatch(entityHero, /Modifier\.tokenModeToggle/);
  assert.match(entityHero, /V2TokenModeToggle\(palette, tokenDisplayMode, onTokenDisplayModeChange\)/);

  const trendHero = androidUiDeclaration('V2TrendInsightCard');
  assert.doesNotMatch(trendHero, /V2TokenModeToggle\(/);
  assert.match(trendHero, /\.tokenModeToggle\(\s*current = tokenDisplayMode/);

  // 旧切片从 V2HeroCard 切到 V2MiniMetric，跨过了主卡的三个辅助声明，这里原样一并取。
  const overviewHero = androidUiDeclaration('V2HeroCard', 'V2HeroTokenValueRow', 'V2HeroCostToggle', 'V2HeroCostLabel');
  assert.doesNotMatch(overviewHero, /V2TokenModeToggle\(/);
  assert.match(
    overviewHero,
    /\.heightIn\(min = 48\.dp\)[\s\S]{0,160}?\.tokenModeToggle\(\s*current = tokenDisplayMode,[\s\S]{0,160}?displayedValue = formattedTokens/,
  );
  assert.match(
    androidUi,
    /fun Modifier\.tokenModeToggle\([\s\S]*?\.semantics\(mergeDescendants = displayedValue != null\)[\s\S]*?contentDescription = if \(displayedValue == null\)/,
  );
});

test('Android filter sheet exposes each filter group as a TalkBack heading', () => {
  const choiceSection = androidUiDeclaration('V2ChoiceSection');
  // 允许标题在 heading() 之前挂布局 Modifier（T10.72 加了 .weight(1f) 让「横向查看
  // 更多」提示不挤压标题）。契约管的是 heading 语义在不在，不管布局链多长。
  assert.match(choiceSection, /Text\(\s*title,[\s\S]{0,180}?modifier = Modifier[\w().\s,=]*?\.semantics\s*\{\s*heading\(\)\s*\}/);
});

test('Android share poster exposes period and layout groups as TalkBack headings', () => {
  const shareUi = readSource(
    path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile', 'SharePosterUi.kt'));
  assert.match(shareUi, /Text\(\s*"选择布局"[\s\S]{0,220}?modifier = Modifier\.semantics\s*\{\s*heading\(\)\s*\}/);
  const periodSelector = shareUi.slice(shareUi.indexOf('private fun SharePeriodSelector'), shareUi.indexOf('private fun SharePeriodOption'));
  assert.match(periodSelector, /Text\(\s*"总结周期"[\s\S]{0,220}?modifier = Modifier\.semantics\s*\{\s*heading\(\)\s*\}/);
});

test('Android share poster announces generation failures assertively', () => {
  const shareUi = readSource(
    path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile', 'SharePosterUi.kt'));
  const errorBlock = shareUi.slice(shareUi.indexOf('generationError?.let'), shareUi.indexOf('Button(\n                onClick = { onShare'));
  assert.match(errorBlock, /Text\(\s*error,[\s\S]{0,320}?semantics\s*\{\s*liveRegion = LiveRegionMode\.Assertive\s*\}/);
});

test('Android quota provider identities remain readable at regular and large text sizes', () => {
  const androidUi = readAndroidDashboardUi();
  // T10.118c 把「待处理」卡合并进 V2ProviderCard，标题行从两处变成一处；
  // 行数上限是这里要守的东西，卡片数量不是。
  // T10.217 把供应商标题迁到既有 LedgerType.titleM，字号、行高和字重作为一个层级复用。
  // T10.143f 把 Text(...) 改成括号内换行的写法，所以容许 `Text(` 后与收尾 `)` 前的空白。
  const providerNameHeaderBlocks = androidUi.match(/Text\(\s*providerName,[\s\S]{0,180}?style = LedgerType\.titleM,[\s\S]{0,180}?overflow = TextOverflow\.Ellipsis\s*\)/g) ?? [];
  assert.equal(providerNameHeaderBlocks.length, 1);
  providerNameHeaderBlocks.forEach((block) => assert.match(block, /maxLines = 2/));
  assert.doesNotMatch(androidUi, /Text\(\s*providerName,[\s\S]{0,180}?maxLines = if \(largeText\) 2 else 1/);
});

test('Android source analysis keeps long tool and model identities readable', () => {
  const androidUi = readAndroidDashboardUi();
  const sourceRow = androidUiDeclaration('V2SourceRow');
  assert.match(androidUi, /V2SourceRow\([\s\S]*?label = tool\.name/);
  assert.match(sourceRow, /maxWidth < 280\.dp \|\| LocalDensity\.current\.fontScale > 1\.3f/);
  assert.match(sourceRow, /Text\(\s*label,[\s\S]{0,260}?maxLines = 3,[\s\S]{0,100}?overflow = TextOverflow\.Ellipsis/);
  // T10.118c 把窄屏分支的 note 从与数值同行改成独占一行，挤压数值的风险随之消失；
  // 真正要守的是两个分支的 note 都不会无限换行，所以按分支各查一次。
  const noteBlocks = sourceRow.match(/Text\(\s*note,[\s\S]{0,300}?overflow = TextOverflow\.Ellipsis/g) ?? [];
  assert.equal(noteBlocks.length, 2);
  noteBlocks.forEach((block) => assert.match(block, /maxLines = 2/));
  assert.match(sourceRow, /heightIn\(min = 48\.dp\)/);
});

test('Android drill-down and ambient quota identities keep long labels readable', () => {
  const detailBlock = androidUiDeclaration('V2DetailRow');
  assert.match(detailBlock, /\$\{detail\.tool\} · \$\{detail\.model\}[\s\S]{0,260}?maxLines = 2,[\s\S]{0,100}?overflow = TextOverflow\.Ellipsis/);
  assert.match(detailBlock, /\$\{shortTime\(detail\.timestamp\)\} · \$\{detail\.machineId\}[\s\S]{0,180}?maxLines = 2,[\s\S]{0,100}?overflow = TextOverflow\.Ellipsis/);
  const ambientPill = androidUiDeclaration('V2WidgetQuotaPill');
  assert.match(ambientPill, /Text\(\s*providerName,[\s\S]{0,220}?maxLines = 2,[\s\S]{0,100}?overflow = TextOverflow\.Ellipsis/);
  const ambientQuotaRow = androidUiDeclaration('V2AmbientQuotaRow');
  assert.match(ambientQuotaRow, /"\$providerName · \$windowLabel"[\s\S]{0,220}?maxLines = 2,[\s\S]{0,100}?overflow = TextOverflow\.Ellipsis/);
});

test('Android quota windows and quota wall preserve long identities at every density', () => {
  // T10.143f 起额度页的窗口行由 V2ProviderCard.kt 里新写的 V2ProviderWindowRow 画，数值交给
  // V2QuotaHeadlineValue；旧的 V2QuotaWindow 仍声明在 ui/quota/V2QuotaWindow.kt，却已没有任何调用方。
  // 契约跟着真正渲染的那一份走，并先钉住这条调用链，免得换个名字又去守一段死代码。
  assert.match(androidUiDeclaration('V2ProviderCard'), /V2ProviderWindowRow\(palette, provider, window\)/);
  const quotaWindow = androidUiDeclaration('V2ProviderWindowRow');
  // T10.118c 把窗口标签和重置时间提成了 name / resetText 局部量，重置文案也升级为
  // 完整时间戳并区分「上次记录重置」。断言跟着结构走，行数上限一条都不放。
  assert.match(quotaWindow, /val name = window\.localizedWindowLabel\(provider\.localizedDisplayName\(\)\)/);
  assert.match(quotaWindow, /val resetText = [\s\S]{0,160}?quotaFullTimestamp\(window\.resetsAt\)/);
  const narrowQuotaRow = quotaWindow.slice(quotaWindow.indexOf('Column(verticalArrangement'), quotaWindow.indexOf('} else {'));
  const regularQuotaRow = quotaWindow.slice(quotaWindow.indexOf('} else {'));
  for (const row of [narrowQuotaRow, regularQuotaRow]) {
    // T10.143f 把 Text(...) 改成括号内换行的写法，容许 `Text(` 后与收尾 `)` 前的空白。
    assert.match(row, /Text\(\s*name,[\s\S]{0,220}?maxLines = 2, overflow = TextOverflow\.Ellipsis\s*\)/);
    assert.match(row, /V2QuotaHeadlineValue\(palette, value, presentation\.status, statusColor\)/);
  }
  // 数值在 T10.143f 升为大字 headline。此前这里要求数值也「两行 + 省略号」，但 T10.143b 方案 B 规格
  // §5.1 写明「文字放大时优先换行、单列、展开详情或显示 `+N`，不缩小字号、不截断数值、不把多列
  // 硬塞」——省略号截断正是它排除的做法。所以数值改守「不截断」：没有行数上限、没有 overflow。
  const headlineValue = androidUiDeclaration('V2QuotaHeadlineValue');
  assert.match(headlineValue, /val presentation = quotaHeadlinePresentation\(value, status\)/);
  const headlineWithQualifier = androidUiDeclaration('V2QuotaHeadlineWithQualifier');
  assert.match(headlineWithQualifier, /color = palette\.text,[\s\S]{0,80}?style = numberStyle/,
    '额度数字必须使用主文字色');
  assert.match(headlineWithQualifier, /presentation\.qualifier\?\.let[\s\S]{0,180}?style = LedgerType\.caption/,
    '「可用」必须是小号次级标签');
  assert.doesNotMatch(headlineValue, /maxLines|TextOverflow/u, '额度数值又会被截断');
  assert.match(quotaWindow, /FlowRow\([\s\S]{0,240}?severity\?\.let[\s\S]{0,260}?it\.label[\s\S]{0,260}?compactResetText/,
    '额度档位词与重置时间必须同处元数据行');
  // T10.130：外层只留一句相对说法（「3 天后」），完整时间戳进 contentDescription 与
  // 详情抽屉——详情里本来就有一份逐字相同的，此前两处并存。行数上限照旧要守。
  // 「现在」必须是注入进来的：这行渲染的是相对时间（`重置 4 小时后`），
  // 直接读系统时钟就会让钉死绝对时间戳的截图夹具每过一小时自己变红一次。
  assert.match(quotaWindow,
    /val compactResetText =[\s\S]{0,200}?v2RelativeReset\(window\.resetsAt, LocalLedgerNow\.current\(\)\)/u);
  assert.match(regularQuotaRow, /Text\(\s*compactResetText,[\s\S]{0,220}?maxLines = 1, overflow = TextOverflow\.Ellipsis\s*\)/);
  assert.match(quotaWindow, /contentDescription = quotaWindowAccessibilityDescription\([\s\S]{0,300}?resetText/);

  const quotaRing = androidUiDeclaration('V2AmbientQuotaRing');
  assert.match(quotaRing, /emphasized -> providerName/);
  assert.match(quotaRing, /"\$displayName · \$compactWindowLabel"[\s\S]{0,260}?maxLines = 2,[\s\S]{0,160}?overflow = TextOverflow\.Ellipsis/);
  assert.match(quotaRing, /TextAlign\.Center/);

  const quotaWall = androidUiDeclaration('V2AmbientQuotaWall');
  assert.match(quotaWall, /v2QuotaReason\(provider\.reasonCode, provider\.scope\)[\s\S]{0,180}?maxLines = 2,[\s\S]{0,100}?overflow = TextOverflow\.Ellipsis/);

  // 旧写法从这里切到巨石文件末尾，它恰是文件里最后一个声明，范围就是它本身。
  const freshnessFooter = androidUiDeclaration('V2AmbientFreshnessFooter');
  // T10.130 给这行加了 tnum（此前是 FontFamily.Monospace，中文会掉到另一套字形），
  // 参数多了一行，跨度放宽。要守的仍然是行数上限。
  assert.match(freshnessFooter, /provider\.localizedDisplayName\(\)[\s\S]{0,340}?maxLines = 2,[\s\S]{0,100}?overflow = TextOverflow\.Ellipsis/);
});

test('Android trend scrub never invents a cost and never reads another series', () => {
  const logic = readSource(
    path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile', 'LedgerUiLogic.kt'));
  const androidUi = readAndroidDashboardUi();

  // 费用未知必须是 null。写 0.0 会让提示卡显示「费用: ¥0.00」这个从未观测到的数字。
  assert.match(logic, /internal data class ScrubReadout\([\s\S]{0,400}?val cost: Double\?,/);
  const scrubReadout = logic.slice(logic.indexOf('internal fun scrubReadout('), logic.indexOf('private val SCRUB_HOUR_REGEX'));
  assert.match(scrubReadout, /if \(comparison != null\) return scrubReadoutForIndex\(comparison, index\)/);
  assert.match(scrubReadout, /cost = null,/);
  // comparison 存在时不得再落到 fallback：诚实空态下槽位数取两条序列的较大值，
  // 越界槽位一旦兜底到 stats.trends，读数就来自另一次查询的另一套时间桶。
  assert.doesNotMatch(scrubReadout, /scrubReadoutForIndex\(comparison, index\) \?:/);
  assert.doesNotMatch(androidUi, /scrubReadoutForIndex\(comparison, index\) \?:/);
  assert.match(androidUi, /scrubIndex\?\.let \{ index -> scrubReadout\(comparison, fallback, index, honestEmptyState, metricMode\) \}/);

  // 提示卡与读屏在费用缺失时都只能少一行，不能替来源编金额。
  // T10.207（T10.154 A08）：提示卡「费用: x」，读屏「预估费用 x」，读不到念「预估费用不可得」。
  assert.match(androidUi, /val costLabel = readout\.cost\?\.let \{ "费用: \$\{v2FormatMoney\(context, it, isCostMasked, currency\)\}" \}/);
  assert.match(androidUi, /if \(primaryLabel != null\) \{[\s\S]{0,400}?if \(secondaryLabel != null\) \{/);
  assert.match(logic, /ReportMetricMode\.Cost -> readout\.cost\?\.takeIf\(::isKnownCost\)\?\.let \{ "预估费用 \$\{currency\.format\(it, exchangeRate, isCostMasked\)\}" \}[\s\S]{0,40}?\?\: COST_UNAVAILABLE_SPOKEN/);
  assert.match(logic, /internal const val COST_UNAVAILABLE_SPOKEN = "预估费用不可得"/);

  // 额度数值按单位取整：remaining 常是 limit - used 的浮点差，
  // used = 99.9 曾经显示成「可用 0.09999999999999432%」。
  const quotaValue = logic.slice(logic.indexOf('internal fun quotaValueLabel('), logic.indexOf('internal fun quotaProviderHeadlineLabel('));
  assert.match(quotaValue, /fun number\(amount: Double, unit: QuotaUnit\): String/);
  assert.match(quotaValue, /\.setScale\(scale, java\.math\.RoundingMode\.HALF_UP\)/);
  assert.doesNotMatch(quotaValue, /BigDecimal\.valueOf\(value\)\.stripTrailingZeros/);
});

test('Android low-power ledger keeps long quote sources readable in the fixed footer', () => {
  const landscapeLedger = androidUiDeclaration('V2AmbientLedgerLandscape');
  assert.match(landscapeLedger, /"— \$\{quote\.source\}"[\s\S]{0,240}?lineHeight = 11\.sp,[\s\S]{0,120}?maxLines = 2,[\s\S]{0,120}?overflow = TextOverflow\.Ellipsis/);
});

test('Android quota summary keeps long provider identities readable on the overview', () => {
  // 旧切片止于 V2InsightStrip，顺带跨过了分段控件那几个声明，这里原样一并取。
  const summaryRow = androidUiDeclaration('V2QuotaSummaryRow', 'Modifier.observeChoiceBounds', 'V2SegmentedToggle');
  assert.match(summaryRow, /Text\(\s*providerName,[\s\S]{0,220}?maxLines = 2,[\s\S]{0,100}?overflow = TextOverflow\.Ellipsis/);
  assert.match(summaryRow, /window\.localizedCompactWindowLabel\(providerName\)[\s\S]{0,300}?maxLines = 2,[\s\S]{0,100}?overflow = TextOverflow\.Ellipsis/);
});

test('Android ambient console keeps long daily quote sources readable', () => {
  const dailyQuote = androidUiDeclaration('V2LandscapeDailyQuote');
  assert.match(dailyQuote, /Text\(\s*"— \$\{quote\.source\}"[\s\S]{0,260}?lineHeight = 12\.sp,[\s\S]{0,160}?maxLines = 2,[\s\S]{0,100}?overflow = TextOverflow\.Ellipsis/);
});

test('Android filter chips preserve long device, tool, and model identities', () => {
  const filterBlock = androidUiDeclaration('V2ChoiceSection');
  assert.match(filterBlock, /label = \{[\s\S]{0,180}?Text\([\s\S]{0,120}?label,[\s\S]{0,120}?maxLines = 2,[\s\S]{0,100}?overflow = TextOverflow\.Ellipsis/);
  assert.match(filterBlock, /heightIn\(min = 48\.dp\)/);
  assert.match(filterBlock, /horizontalScroll\(rememberScrollState\(\)\)/);
});

test('Android heatmap cards do not expose dead click actions', () => {
  // 各段覆盖的声明与拆分前的旧切片逐一对应：实体页那段顺带跨过 V2PaginationErrorCard，
  // 日历卡那段连着月历网格一起切（点整月打开日期选择的断言就落在 V2CalendarMonthGrid 里）。
  const block = (...names) => androidUiDeclaration(...names);
  const entity = block('V2EntityContent', 'V2PaginationErrorCard');
  assert.match(entity, /V2HeatmapCard\(palette, buildInsightCalendarAxis\(stats\.copy\(heatmap = entity\.heatmap\), state\.query\), compact = true, onClick = null\)/);
  const card = block('V2HeatmapCard');
  assert.match(card, /val cardModifier = onClick\?\.let \{ action ->[\s\S]*?\.clickable\(role = Role\.Button, onClickLabel = actionLabel, onClick = action\)[\s\S]*?\}\s*\?: Modifier/);
  assert.match(card, /if \(compact && onClick != null\) Icon\(Icons\.Default\.ChevronRight/);
  const calendar = block('V2InsightCalendarCard', 'V2CalendarMonthGrid');
  assert.match(calendar, /buildInsightCalendarAxis\(stats, query\)/);
  // T10.209：点整月不再是"抓月内第一个非空格子直接开单日"的临时接线（那样点哪个格子都一样，
  // 是名副其实的死点击），改成打开真的月面板，点面板里的可信日期才到 onOpenDay。
  assert.match(calendar, /V2CalendarMonthGrid\(palette, axis\) \{ month -> openMonth = month\.toString\(\) \}/);
  assert.match(calendar, /V2CalendarMonthPanel\(palette, yearMonth, axis, onDismiss = \{ openMonth = null \}\)[\s\S]*?onOpenDay\(date\)/);
  assert.match(calendar, /V2SingleDayDialog\(palette, axis, pickerDate,[\s\S]*?onOpenDay\(date\)/);
  assert.doesNotMatch(calendar, /Modifier\.clickable[\s\S]{0,100}onOpenDay\(cell\.date/);
  const chart = block('V2HeatmapChart');
  assert.match(chart, /axisCell\?\.selectable == true/);
  assert.match(chart, /if \(onOpenDay != null\) \{\s*onOpenDay\(date\)/);

});

test('Android 日历五级色阶图例与三处格子共用同一张表，不能各画各的', () => {
  // T10.209 范围 1（回归 P2-9：图例是硬编码 4 档透明度，格子按峰值线性插值，两边对不上）。
  // 不掏一份"色值断言"去比对（色值本身可能因主题/E-ink 变化），而是断言四处渲染点用的是
  // 同一个分级函数 heatLevel(...) 与同一张表 palette.tokens.heat——只要四处都读同一张表、
  // 同一个函数，就没有第二份色阶可以走偏；哪一处改用了别的表或自己重新分档，这里就会先红。
  const legend = withoutComments(androidUiDeclaration('V2HeatmapScaleLegend'));
  assert.match(legend, /palette\.tokens\.heat\.forEach/, '图例不再直接遍历 palette.tokens.heat');
  // 旧图例（V2ChartLegends.kt 的 V2HeatmapLegend，P2-9 的成因）是 `val blocks = listOf(palette.raised,
  // ...blue.copy(alpha = 0.35f)...)` 手写四档透明度；只挡这个具体形状。
  assert.doesNotMatch(legend, /listOf\(\s*palette\.raised/, '图例又开始手写透明度色阶（P2-9 的成因）');
  // R-69 P2-2（方案 §7.4）：色阶后面要有覆盖外 / 当前查询 / 未来三个线索键，样本与格子同一段画法。
  assert.match(legend, /V2HeatmapCueKey\(palette, "覆盖外"\)[\s\S]*?V2HeatmapCueKey\(palette, "当前查询"\)[\s\S]*?V2HeatmapCueKey\(palette, "未来"\)/u,
    '图例缺了覆盖外 / 当前查询 / 未来的线索键');
  assert.match(withoutComments(androidUiDeclaration('V2HeatmapCueKey')), /drawHeatmapCell\(/u, '图例键没有用格子的画法 drawHeatmapCell');

  // 三处格子（年度小格、月面板日格、近 12 周热力）不要求写成同一行内联；只要求分级接的是共享分级函数、
  // 上色都从 palette.tokens.heat[] 取——两个都在，才不是自己另起了一份。
  const miniMonth = withoutComments(androidUiDeclaration('V2MiniMonthCanvas'));
  assert.match(miniMonth, /heatLevel\(/, '年度小格没有调用共享分级函数 heatLevel');
  assert.match(miniMonth, /palette\.tokens\.heat\[/, '年度小格没有从共享色阶 palette.tokens.heat 取色');

  // 月面板（R-69 FI-3）：级别只从 monthPanelDays 拿——阈值取整条 axis（与年度小格同一把尺子）再经 heatLevel，
  // 行为由 JVM 测试 InsightCalendarMonthsTest.monthPanelLevelsUseTheAxisWideScale 锁住；日格自己不再分级。
  assert.match(withoutComments(androidUiDeclaration('V2CalendarMonthPanelContent')), /monthPanelDays\(axis, yearMonth\)/u,
    '月面板不再从共享的 monthPanelDays 取级别');
  const dayCell = withoutComments(androidUiDeclaration('V2CalendarDayCell'));
  assert.match(dayCell, /palette\.tokens\.heat\[level\]/, '月面板日格没有从共享色阶 palette.tokens.heat 取色');
  assert.doesNotMatch(dayCell, /heatLevel(?:Thresholds)?\(/u, '月面板日格又自己分级，没用 monthPanelDays 给的级别');
  const monthsSource = withoutComments(readSource(path.join(ANDROID_MOBILE_DIR, 'InsightCalendarMonths.kt')));
  const monthPanelDays = monthsSource.match(/internal fun monthPanelDays\([\s\S]*?\n\}/u)?.[0] ?? '';
  assert.match(monthPanelDays, /heatLevelThresholds\(knownNonZeroTokens\(axis\.cells\)\)[\s\S]*?heatLevel\(tokens, thresholds\)/u,
    '月面板的级别不再取整条 axis 的分位阈值与共享分级函数');

  const heatmapChart = withoutComments(androidUiDeclaration('V2HeatmapChart'));
  assert.match(heatmapChart, /heatLevel\(/, '近 12 周热力没有调用共享分级函数 heatLevel');
  assert.match(heatmapChart, /palette\.tokens\.heat\[/, '近 12 周热力没有从共享色阶 palette.tokens.heat 取色');
  assert.match(heatmapChart, /drawHeatmapCell\(plan, ink\)/u, '近 12 周热力没有用与图例键共用的画法 drawHeatmapCell');
  assert.doesNotMatch(heatmapChart, /\blerp\(/, '近 12 周热力又改回了线性插值（P2-9 的成因）');
});

test('Android quota summary keeps one actionable accessibility node', () => {
  assert.match(androidUiDeclaration('V2QuotaSummaryCard'), /\.clickable\(\s*role = Role\.Button,\s*onClickLabel = "打开额度详情",\s*onClick = onClick\s*\)\s*\.semantics\(mergeDescendants = true\)/);
});

test('CI keeps Android screenshot goldens on the macOS source host', () => {
  const workflow = readSource(
    path.join(process.cwd(), '.github', 'workflows', 'ci.yml'));
  const androidTest = workflow.match(/\n  android-test:\n([\s\S]*?)(?=\n  [a-z0-9-]+:\n)/)?.[1] ?? '';
  const androidScreenshot = workflow.match(/\n  android-screenshot:\n([\s\S]*?)(?=\n  [a-z0-9-]+:\n)/)?.[1] ?? '';
  assert.match(androidTest, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(androidTest, /validateDebugScreenshotTest/);
  assert.match(androidScreenshot, /runs-on: macos-14/);
  assert.match(androidScreenshot, /validateDebugScreenshotTest/);
});

test('cloud connection rejects secret credentials and non-local HTTP', () => {
  const url = 'https://example.supabase.co';
  const publishableKey = 'sb_publishable_1234567890';
  const serviceRoleJwt = [
    Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'),
    'signature',
  ].join('.');

  assert.match(
    validateCloudConnectionConfig({ supabase_url: url, supabase_key: 'sb_secret_12345678901234567890' }),
    /secret\/service role/,
  );
  assert.match(
    validateCloudConnectionConfig({ supabase_url: url, supabase_key: serviceRoleJwt }),
    /secret\/service role/,
  );
  assert.match(
    validateCloudConnectionConfig({
      supabase_url: 'http://example.supabase.co',
      supabase_key: publishableKey,
    }),
    /HTTPS/,
  );
  assert.equal(
    validateCloudConnectionConfig({
      supabase_url: 'http://localhost:54321',
      supabase_key: publishableKey,
    }),
    null,
  );
});

test('cloud credentials fail closed for malformed email and blank password', () => {
  assert.match(validateCloudCredentials('not-an-email', 'password'), /有效邮箱/);
  assert.match(validateCloudCredentials('user@example.com', ''), /密码/);
  assert.equal(validateCloudCredentials(' user@example.com ', 'password'), null);
});

test('cloud stats LKG keys bind the normalized project origin and authenticated user', () => {
  assert.equal(
    normalizeCloudOrigin(' HTTPS://Project.Example.COM:443/rest/v1/ '),
    'https://project.example.com',
  );
  assert.equal(normalizeCloudOrigin('https://user:secret@project.example.com'), null);
  assert.equal(normalizeCloudOrigin('not-a-url'), null);

  const first = statsSnapshotKey(
    'cloud',
    'today',
    'all_cloud',
    'https://project.example.com/rest/v1',
    'user-a',
  );
  const sameBinding = statsSnapshotKey(
    'cloud',
    'today',
    'all_cloud',
    'https://PROJECT.example.com:443/',
    ' user-a ',
  );
  const otherUser = statsSnapshotKey(
    'cloud',
    'today',
    'all_cloud',
    'https://project.example.com',
    'user-b',
  );
  const otherProject = statsSnapshotKey(
    'cloud',
    'today',
    'all_cloud',
    'https://other.example.com',
    'user-a',
  );
  assert.equal(first, sameBinding);
  assert.notEqual(first, otherUser);
  assert.notEqual(first, otherProject);
  assert.equal(cloudStatsIdentity('https://project.example.com', ''), null);
  assert.equal(
    statsSnapshotKey('cloud', 'today', 'all_cloud', 'https://project.example.com', ''),
    null,
    'unauthenticated failures cannot recover another user snapshot',
  );
  assert.equal(
    statsSnapshotKey('local', 'today', 'ignored', 'https://project.example.com', 'user-a'),
    'local\u001etoday\u001eall_cloud',
  );

  const snapshots = new Map([
    [first, { owner: 'user-a' }],
    [otherUser, { owner: 'user-b' }],
    ['local\u001etoday\u001eall_cloud', { owner: 'local' }],
  ]);
  clearCloudStatsSnapshots(snapshots);
  assert.deepEqual([...snapshots.keys()], ['local\u001etoday\u001eall_cloud']);
});

test('legacy cloud wallpaper consent stays paused until the cloud trust gates pass', () => {
  const legacy = {
    ...DEFAULT_SETTINGS,
    wallpaper_consent_version: 0,
    wallpaper_desktop_enabled: true,
    wallpaper_lockscreen_enabled: true,
    wallpaper_dynamic_bg_enabled: false,
    wallpaper_use_cloud: true,
  };
  const blocked = resolveWallpaperConsentSettings(legacy, true, false);
  assert.equal(blocked.kind, 'blocked');
  assert.match(blocked.message, /授权仍保持暂停/);

  const restored = resolveWallpaperConsentSettings(legacy, true, true);
  assert.equal(restored.kind, 'ready');
  assert.equal(restored.settings.wallpaper_consent_version, 1);
  assert.equal(restored.settings.wallpaper_desktop_enabled, true);
  assert.equal(restored.settings.wallpaper_lockscreen_enabled, true);
  assert.equal(restored.settings.wallpaper_use_cloud, true);

  const declined = resolveWallpaperConsentSettings(legacy, false, false);
  assert.equal(declined.kind, 'ready');
  assert.equal(declined.settings.wallpaper_consent_version, 1);
  assert.equal(declined.settings.wallpaper_desktop_enabled, false);
  assert.equal(declined.settings.wallpaper_lockscreen_enabled, false);
  assert.equal(declined.settings.wallpaper_dynamic_bg_enabled, false);
  assert.equal(declined.settings.wallpaper_use_cloud, false);
});

test('cloud recovery distinguishes expired sessions, missing RPC and offline failures', () => {
  // 不是 Rust 原文的来源（PostgREST 报错、浏览器 fetch、前端自检）走关键词兜底，归类不变。
  assert.equal(classifyCloudFailure(new Error('JWT expired')).kind, 'session-expired');
  assert.equal(
    classifyCloudFailure(new Error('function public.get_dashboard_stats_v2 does not exist')).kind,
    'capability-missing',
  );
  assert.equal(classifyCloudFailure(new TypeError('Failed to fetch')).kind, 'offline');
  assert.equal(classifyCloudFailure(new Error('Stats v2 RPC 尚未部署')).kind, 'capability-missing');
  assert.equal(classifyCloudFailure('permission denied for table usage_records').kind, 'permission');

  // T10.200（root R-60）：桌面端交给前端的云端错误原文，逐字从 Rust 源码里读出来再归类。Rust 改了
  // 措辞、加了新的失败种类而 classifyCloudFailure 没跟上时，这里变红，不会悄悄落进关键词兜底。
  const rust = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'commands', 'mod.rs'));
  const rustLiteral = (literal) => {
    assert.ok(rust.includes(`"${literal}"`), `Rust 源码里已找不到这句错误原文，请同步 classifyCloudFailure：${literal}`);
    return literal;
  };
  const rustConst = (name) => {
    const match = new RegExp(`const ${name}: &str =\\s*"([^"]*)";`).exec(rust);
    assert.ok(match, `Rust 源码里找不到常量 ${name}`);
    return match[1];
  };
  const format = (literal, ...values) => {
    let index = 0;
    return rustLiteral(literal).replace(/\{[a-z_]*\}/g, () => values[index++]);
  };
  const cases = [
    // CloudRpcFailure::safe_message
    [format("Cloud capability '{}' is unavailable.", 'get_dashboard_stats_v2'), 'capability-missing'],
    // 旧服务器诚实降级的统一措辞（含中文弯引号），原先写死中文原文的那条断言（T10.180 评审 P2-2、
    // T10.185 评审 FI-3a/FI-3b）改为直接读 Rust 常量，覆盖不变。
    [rustConst('CUSTOM_RANGE_CLOUD_UNSUPPORTED'), 'range-unsupported'],
    [rustLiteral('Cloud session is not authorized. Please sign in again.'), 'session-expired'],
    [format('Cloud RPC request failed (HTTP {status}).', '500'), 'service'],
    [format('Cloud RPC request failed (HTTP {status}).', '502'), 'service'],
    [format('Cloud RPC request failed (HTTP {status}).', '503'), 'service'],
    [format('Cloud RPC request failed (HTTP {status}).', '429'), 'service'],
    [format('Cloud RPC request failed (HTTP {status}).', '408'), 'offline'],
    [format('Cloud RPC request failed (HTTP {status}).', '403'), 'permission'],
    [format('Cloud RPC request failed (HTTP {status}).', '401'), 'session-expired'],
    [format('Cloud RPC request failed (HTTP {status}).', '400'), 'capability-missing'],
    [format('Cloud RPC request failed (HTTP {status}).', '404'), 'capability-missing'],
    [rustLiteral('Cloud RPC request could not be completed.'), 'offline'],
    [rustLiteral('Cloud RPC request was superseded by a newer session state.'), 'service'],
    [rustLiteral('Cloud RPC returned an invalid response.'), 'service'],
    // 看板取数的外层包装与响应校验
    [format('Cloud dashboard does not support the requested multi-filter/search query: {}', "Cloud capability 'get_dashboard_stats_v2' is unavailable."), 'capability-missing'],
    [rustLiteral('Cloud Stats v2 response is missing its query echo.'), 'capability-missing'],
    [rustLiteral('Cloud Stats v2 response has a malformed query echo.'), 'capability-missing'],
    [rustLiteral('Cloud Stats v2 response query echo does not match the request.'), 'capability-missing'],
    [rustLiteral('Cloud Stats v2 response is missing its entity echo.'), 'capability-missing'],
    [rustLiteral('Cloud Stats v2 response has a malformed entity echo.'), 'capability-missing'],
    [rustLiteral('Cloud Stats v2 response entity echo does not match the request.'), 'capability-missing'],
    [rustLiteral('Cloud Stats v2 response unexpectedly contains an entity echo.'), 'capability-missing'],
    [rustLiteral('cloud RPC returned a non-object response'), 'capability-missing'],
    [rustLiteral('cloud dashboard response is invalid'), 'capability-missing'],
    [format('Cloud client unavailable: {error}', 'builder error'), 'service'],
    // 会话刷新与会话闸门
    [rustLiteral('Please sign in to Supabase first.'), 'session-expired'],
    [rustLiteral('Please configure Supabase URL and publishable key first.'), 'session-expired'],
    [rustLiteral('Supabase session expired. Please sign in again.'), 'session-expired'],
    [format('Supabase API request failed (HTTP {}).', '502'), 'service'],
    [format('Supabase API request failed (HTTP {}).', '500'), 'service'],
    [format('Supabase API request failed (HTTP {}).', '404'), 'service'],
    [format('Supabase API request failed (HTTP {}).', '403'), 'permission'],
    [format('Supabase API request failed (HTTP {}).', '401'), 'session-expired'],
    [format('Supabase session refresh client unavailable: {error}', 'builder error'), 'service'],
    [rustLiteral('Invalid Supabase refresh response.'), 'service'],
    [rustConst('SESSION_OPERATION_SUPERSEDED'), 'service'],
    [rustConst('REFRESH_FLIGHT_INTERRUPTED'), 'service'],
    [rustLiteral('Supabase session use is blocked until sign-out cleanup completes.'), 'session-expired'],
    // 本机安全存储
    [rustLiteral('stored Supabase session is invalid: required session fields are empty.'), 'session-expired'],
    [rustLiteral('stored Supabase session is invalid: credential encoding or JSON shape is unsupported.'), 'session-expired'],
    [format('system keyring unavailable: {e}', 'Platform secure storage failure'), 'session-expired'],
    [format('failed to read Supabase session from keyring: {e}', 'Platform secure storage failure'), 'session-expired'],
    [format('failed to migrate legacy Supabase session in keyring: {e}', 'Platform secure storage failure'), 'session-expired'],
    [format('failed to store Supabase session in keyring: {e}', 'Platform secure storage failure'), 'session-expired'],
    [format('failed to clear Supabase session from keyring: {e}', 'Platform secure storage failure'), 'session-expired'],
    [rustConst('CACHED_KEYRING_READ_FAILURE'), 'session-expired'],
    [rustLiteral('Unable to read cloud session safety state.'), 'session-expired'],
    [rustLiteral('Unable to save cloud session safety state.'), 'session-expired'],
    [rustLiteral('Unable to read cloud session keyring safety state.'), 'session-expired'],
    [rustLiteral('Unable to save cloud session keyring safety state.'), 'session-expired'],
    [rustLiteral('Unable to acquire cloud session safety lock.'), 'session-expired'],
    [rustLiteral('Unable to release cloud session safety lock.'), 'session-expired'],
    [rustLiteral('Cloud session safety epoch is exhausted.'), 'session-expired'],
  ];
  // send_cloud_request_with_retry 的原文是「{context} failed [{种类}]: {reqwest 错误}」；会话刷新里
  // connect/timeout/network 是网络问题，不是登录过期（旧关键词兜底会因为 session 一词判成登录过期）。
  assert.ok(rust.includes('send_cloud_request_with_retry("Supabase session refresh"'));
  assert.ok(rust.includes('return Err(format!("{context} failed [{}]: {error}", kind.label()));'));
  for (const [label, kind] of [['connect', 'offline'], ['timeout', 'offline'], ['network', 'offline'], ['other', 'service']]) {
    assert.ok(rust.includes(`=> "${label}",`), `CloudSendErrorKind 不再有 ${label}`);
    cases.push([
      `Supabase session refresh failed [${label}]: error sending request for url (https://example.supabase.co/auth/v1/token?grant_type=refresh_token)`,
      kind,
    ]);
  }
  for (const [message, kind] of cases) {
    const described = classifyCloudFailure(new Error(message));
    assert.equal(described.kind, kind, message);
    assert.equal(described.message, message);
    assert.equal(classifyCloudFailure(message).kind, kind, message);
    // useStats 写进看板的是「标签：原文」；看板拿这段文字再归类，必须得到同一类（恢复动作按它选）。
    assert.deepEqual(classifyCloudFailure(`${described.label}：${described.message}`), described, message);
  }
  // root R-60 点名的几条：Superseded 不能说成「登录状态已过期」。
  assert.notEqual(classifyCloudFailure(rustConst('SESSION_OPERATION_SUPERSEDED')).label, '登录状态已过期');
  assert.notEqual(classifyCloudFailure('Cloud RPC request was superseded by a newer session state.').label, '登录状态已过期');

  // safe_message 的每一个分支都必须在上表里：CloudRpcFailureKind 新增一种、或改了某一支的原文，这里变红。
  const safeMessageStart = rust.indexOf('fn safe_message(self) -> String {');
  assert.ok(safeMessageStart > 0, 'Rust 源码里找不到 CloudRpcFailure::safe_message');
  const safeMessageBody = rust
    .slice(safeMessageStart, rust.indexOf('\n    }\n}', safeMessageStart))
    .replace(/\/\/[^\n]*/g, '');
  const coveredSources = new Set([
    "Cloud capability '{}' is unavailable.",
    'Cloud session is not authorized. Please sign in again.',
    'Cloud RPC request failed (HTTP {status}).',
    'Cloud RPC request could not be completed.',
    'Cloud RPC request was superseded by a newer session state.',
    'Cloud RPC returned an invalid response.',
  ]);
  const safeMessageLiterals = [...safeMessageBody.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(safeMessageLiterals)].sort(), [...coveredSources].sort());
  assert.match(safeMessageBody, /CloudRpcFailureKind::RangeUnsupported => CUSTOM_RANGE_CLOUD_UNSUPPORTED\.to_string\(\)/);
  const enumStart = rust.indexOf('enum CloudRpcFailureKind {');
  const enumBody = rust.slice(enumStart, rust.indexOf('\n}', enumStart)).replace(/\/\/[^\n]*/g, '');
  assert.deepEqual(
    [...enumBody.matchAll(/^\s{4}(\w+)/gm)].map((match) => match[1]).sort(),
    ['AuthRequired', 'Http', 'InvalidResponse', 'MissingSignature', 'RangeUnsupported', 'Superseded', 'Transport'],
  );
  assert.match(rust, /else if matches!\(status\.as_u16\(\), 401 \| 403\) \{\n\s*CloudRpcFailureKind::AuthRequired/);
});

test('Stats v2 and sync completion checks fail closed', () => {
  assert.equal(isStatsV2Capable(null), false);
  assert.equal(isStatsV2Capable({ meta: { contractVersion: 1 } }), false);
  assert.equal(isStatsV2Capable({ meta: { contractVersion: 2 } }), true);

  assert.equal(isSuccessfulCloudSyncResult(null), false);
  assert.equal(isSuccessfulCloudSyncResult({ success: false, message: '上传失败' }), false);
  assert.equal(isSuccessfulCloudSyncResult({ success: true }), false);
  assert.equal(isSuccessfulCloudSyncResult({ success: true, message: '上传完成' }), true);
  assert.equal(isSuccessfulCloudSyncResult({ success: true, message: '上传完成', warning: null }), true);
  assert.equal(isSuccessfulCloudSyncResult({ success: true, message: '上传完成', warning: '' }), true);
  assert.equal(isSuccessfulCloudSyncResult({
    success: true,
    message: '上传完成',
    warning: '汇总刷新待确认',
  }), false);
});

test('shared dashboard fixtures preserve v1, v2, missing and additive field semantics', () => {
  const legacy = dashboardFixture('legacy-v1.json');
  const complete = dashboardFixture('complete-v2.json');
  const missingOptionals = dashboardFixture('missing-optionals-v2.json');
  const unknownFields = dashboardFixture('unknown-fields-v2.json');
  const unknownCostAndCache = dashboardFixture('unknown-cost-cache-provenance-v2.json');

  assert.equal(legacy.meta?.contractVersion, undefined);
  assert.equal(hasCloudCapability(legacy, 'detailPagination'), false);

  assert.equal(complete.summary.inputTokens + complete.summary.outputTokens, 1200);
  assert.equal(complete.historyPage.totalCount, 3);
  assert.equal(hasCloudCapability(complete, 'detailPagination'), true);
  assert.equal(hasCloudCapability(complete, 'entityDashboard'), true);
  assert.equal(hasCloudCapability(complete, 'multiFilterSearch'), true);
  assert.equal(complete.comparison.current.series.length, 11);
  assert.equal(complete.machineDistribution[0].tokens, 1200);
  const completeTrend = deriveTrendComparison(complete.comparison);
  assert.ok(Math.abs(completeTrend.average.current - (1200 / 11)) < 1e-9);
  assert.ok(Math.abs(completeTrend.average.previous - (800 / 11)) < 1e-9);
  assert.ok(Math.abs(completeTrend.average.absolute - (400 / 11)) < 1e-9);
  assert.ok(Math.abs(completeTrend.average.percent - 50) < 1e-9);

  assert.equal(missingOptionals.comparison, undefined);
  assert.equal(missingOptionals.historyPage, undefined);
  assert.equal(missingOptionals.machineDistribution, undefined);
  assert.equal(hasCloudCapability(missingOptionals, 'detailPagination'), false);

  assert.equal(unknownFields.summary.inputTokens + unknownFields.summary.outputTokens, 3);
  assert.equal(hasCloudCapability(unknownFields, 'detailPagination'), true);
  assert.deepEqual(unknownFields.futureTopLevelEnvelope, { schema: 3 });

  assert.equal(unknownCostAndCache.models['known-free'].cost, 0);
  assert.equal(unknownCostAndCache.models['unknown-cost-combined-cache'].cost, undefined);
  const costRows = modelCostDistribution(
    Object.values(unknownCostAndCache.models),
    unknownCostAndCache.summary.totalCost,
  );
  assert.equal(costRows.find((row) => row.model.name === 'known-free')?.cost, 0);
  assert.equal(costRows.find((row) => row.model.name === 'unknown-cost-combined-cache')?.cost, null);
  assert.deepEqual(splitModelCacheRead(unknownCostAndCache.models['explicit-split']), {
    cacheRead: 80,
    cacheWrite: 20,
  });
  assert.deepEqual(splitModelCacheRead(unknownCostAndCache.models['unknown-cost-combined-cache']), {
    cacheRead: null,
    cacheWrite: null,
  });
  assert.deepEqual(splitModelCacheRead(unknownCostAndCache.models['inconsistent-cache-split']), {
    cacheRead: null,
    cacheWrite: null,
  });
});

test('device distribution is shown only for a supported all-device cloud query', () => {
  const complete = dashboardFixture('complete-v2.json');
  const allDevices = {
    ...complete,
    machineDistribution: [
      complete.machineDistribution[0],
      { ...complete.machineDistribution[0], value: 'studio-pc', tokens: 400 },
    ],
    meta: {
      ...complete.meta,
      query: { ...complete.meta.query, machines: [], machine: null },
    },
  };

  assert.equal(shouldShowDeviceDistribution('cloud', allDevices), true);
  assert.equal(shouldShowDeviceDistribution('local', allDevices), false);
  assert.equal(shouldShowDeviceDistribution('cloud', complete), false);
  assert.equal(
    shouldShowDeviceDistribution('cloud', dashboardFixture('missing-optionals-v2.json')),
    false,
  );
  assert.throws(
    () => parseStatsDataContract({
      ...complete,
      machineDistribution: [{ value: 'studio-pc', tokens: Number.NaN, requests: 1, cost: 0 }],
    }),
    /machineDistribution/,
  );
});

test('shared multi-filter fixtures freeze canonical arrays, aliases and literal search', () => {
  const multi = queryFixture('multi-filter-search-query-v2.json');
  const legacy = queryFixture('legacy-single-query-v2.json');

  assert.deepEqual(normalizeStatsQuery(multi.input), multi.normalized);
  assert.deepEqual(normalizeStatsQuery(multi.preservedWhitespaceCase.input), multi.preservedWhitespaceCase.normalized);
  for (const invalid of multi.invalidCases) {
    assert.throws(
      () => normalizeStatsQuery(invalid.input),
      (error) => error?.code === invalid.expectedError,
      invalid.name,
    );
  }

  assert.deepEqual(normalizeStatsQuery(legacy.oldV2ResponseMetaQuery), legacy.oldV2ResponseNormalized);
  for (const fixtureCase of legacy.cases) {
    if (fixtureCase.outcome === 'reject') {
      assert.throws(() => normalizeStatsQuery(fixtureCase.input), (error) => error?.code === 'singular-plural-conflict');
    } else {
      assert.deepEqual(normalizeStatsQuery(fixtureCase.input), fixtureCase.normalized);
    }
  }

  for (const searchCase of multi.searchCases) {
    const actual = searchCase.candidates
      .filter((candidate) => matchesLiteralQuerySearch(searchCase.query, [
        candidate.tool,
        candidate.model,
        candidate.machineId,
        candidate.sessionId,
      ]))
      .map((candidate) => candidate.id);
    assert.deepEqual(actual, searchCase.matchingIds, searchCase.query);
  }

  const entity = normalizeEntitySelector(multi.entityRequest.entity);
  const entityQuery = normalizeStatsQuery(multi.entityRequest.query);
  assert.equal(queryEchoMatches(entityQuery, entityQuery, entity, entity), true);
  assert.equal(queryEchoMatches(entityQuery, entityQuery, { ...entity, id: 'other' }, entity), false);
  assert.equal(queryEchoMatches(entityQuery, entityQuery, entity), false);
});

test('entity drill-down binds explicit tool identity and local scope drops cloud device state', () => {
  const inherited = {
    tools: ['claude', 'codex'],
    models: ['gpt-5-codex'],
    machines: ['Studio-PC'],
    search: 'SESSION-001',
  };
  assert.deepEqual(filtersForEntityDrilldown(inherited, 'model', 'codex'), {
    tools: ['codex'],
    models: [],
    machines: ['Studio-PC'],
    search: 'SESSION-001',
  });
  assert.deepEqual(filtersForEntityDrilldown(inherited, 'tool'), {
    tools: [],
    models: ['gpt-5-codex'],
    machines: ['Studio-PC'],
    search: 'SESSION-001',
  });
  assert.deepEqual(scopeMachineSelection('cloud', 'Studio-PC'), {
    deviceFilter: 'Studio-PC',
    machines: ['Studio-PC'],
  });
  assert.deepEqual(scopeMachineSelection('local', 'Studio-PC'), {
    deviceFilter: 'all_cloud',
    machines: [],
  });
  const entityHook = readSource(path.join(process.cwd(), 'src', 'hooks', 'useEntityDashboard.ts'));
  const logsTable = readSource(path.join(process.cwd(), 'src', 'components', 'LogsTable.tsx'));
  assert.match(entityHook, /getElementById\('details-page-title'\)/);
  assert.match(entityHook, /heading\.focus\(\{ preventScroll: true \}\)/);
  assert.match(logsTable, /<h1 id="details-page-title" className="page-title" tabIndex=\{-1\}>消耗明细<\/h1>/);
});

test('multi-filter capability fails closed when query echo is absent or conflicting', () => {
  const complete = queryFixture('complete-v2.json');
  assert.throws(
    () => parseStatsDataContract({ ...complete, meta: { ...complete.meta, query: undefined } }),
    /缺少 query echo/,
  );
  assert.throws(
    () => parseStatsDataContract({
      ...complete,
      meta: { ...complete.meta, query: { ...complete.meta.query, model: 'other' } },
    }),
    (error) => error?.code === 'singular-plural-conflict',
  );
});

test('metrics skeleton stays static and never staggers per card', () => {
  const skeleton = readSource(path.join(process.cwd(), 'src', 'components', 'LoadingSkeleton.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  // DESIGN §4.4: ordinary content stacks must not replay per-card entrance
  // animations; the skeleton placeholder must not look interactive either.
  assert.doesNotMatch(skeleton, /animationDelay/);
  assert.match(css, /\.metric-card\.is-skeleton,[\s\S]*?\.metric-card\.is-skeleton:hover \{[\s\S]*?transform:\s*none;[\s\S]*?pointer-events:\s*none;/);
  assert.match(css, /\.metric-card\.is-skeleton::before \{\s*display:\s*none;/);
});

test('dashboard defaults keep KPI then comparison trend while allowing stored module order', () => {
  const source = populatedDashboardSource();
  assert.match(
    source,
    /<MetricsGrid[^>]*\/>[\s\S]*?<TrendPanel[\s\S]*?<QuotaPanel/,
  );

  const trend = source.indexOf('<TrendPanel');
  const contributorGrid = source.indexOf('<UsageSplitPanel');
  assert.ok(trend !== -1 && contributorGrid !== -1 && trend < contributorGrid);
  const preferences = readSource(path.join(process.cwd(), 'src', 'utils', 'useDashboardDisplayPreferences.ts'));
  assert.match(preferences, /DASHBOARD_MODULE_IDS = \['kpi', 'trend', 'quota', 'distribution', 'insights'\]/);
  assert.match(source, /moduleOrder\.filter\(moduleVisible\)\.map/);
});

test('workbuddy 多维分析视图已作为死代码删除（T10.160），不应恢复', () => {
  // 组件曾是 513 行未渲染的死代码；直接断言文件不存在，比断言渲染源码不含标签
  // 更能防止死代码复活（该组件删除后已无法被 import，恢复会在此处先失败）。
  const componentPath = path.join(process.cwd(), 'src', 'components', 'WorkbuddyAnalyticsSection.tsx');
  assert.equal(fs.existsSync(componentPath), false);
});

test('overview day drill opens a single-day review and model cost reports use every model (T10.158)', () => {
  // Audit P0-1: search only covers tool/model/machine/session, so writing the
  // date into it always returned zero rows. The drill goes through the
  // single-day hook, which is disabled under cloud scope.
  const app = readSource(path.join(process.cwd(), 'src', 'App.tsx'));
  const dashboardProps = app.slice(app.indexOf('<DashboardTab'), app.indexOf('<BehaviorAnalysisView'));
  assert.doesNotMatch(app, /search: date/);
  assert.match(dashboardProps, /onSelectDate=\{dayDrill\.drillIntoDay\}/);
  assert.match(dashboardProps, /dateDrillUnavailable=\{dayDrill\.dayDrillUnavailable\}/);
  assert.match(app, /onReturnFromDayDrill=\{dayDrill\.returnFromDayDrill\}/);
  const drill = readSource(path.join(process.cwd(), 'src', 'hooks', 'useDayDrill.ts'));
  // 整体日历清空筛选；只看某个 Agent / 模型的日历只带上这一项（用量拆分焦点）。
  assert.match(drill, /changeRange\('custom', \{ start: date, end: date \}\);\s*setFilters\(entity\s*\? \{ \.\.\.EMPTY_DETAIL_FILTERS, tools: entity\.tools, models: entity\.models, \.\.\.\(entity\.providers\?\.length \? \{ providers: entity\.providers \} : \{\}\) \}\s*: EMPTY_DETAIL_FILTERS\);/);
  // Review P2-1: the header's cloud switch leaves a review first, so the
  // single-day range never reaches a cloud request; devices never cross scopes.
  assert.match(app, /onCloudScope=\{selectCloudScopeLeavingDayDrill\}/);
  assert.match(drill, /setFilters\(originFiltersFor\(/);
  // Audit P0-2: only the token ranking chart keeps a top 8.
  assert.match(dashboardProps, /allModels=\{statsHook\.allModels\}/);
  const stats = readSource(path.join(process.cwd(), 'src', 'hooks', 'useStats.ts'));
  // T10.200：排行算法抽成 project* 供旧画面换 Token 口径时共用；只有 Token 排行限前 8。
  assert.match(stats, /export function projectTopModels\(allModels: ModelStat\[\]\): ModelStat\[\] \{\n\s*return allModels\.filter\(\(m\) => \(m\.displayTotal \?\? 0\) > 0\)\.slice\(0, 8\);/);
  assert.match(stats, /const topModels = useMemo\(\(\) => projectTopModels\(allModels\), \[allModels\]\);/);
  assert.match(stats, /const allModels = useMemo\(\(\) => projectAllModels\(stats, showTotalTokens\), \[stats, showTotalTokens\]\);/);
  const source = populatedDashboardSource();
  assert.match(source, /<ModelCostDistributionPanel models=\{allModelsList\}/);
  assert.match(source, /<CostEfficiencyQuadrantPanel models=\{allModelsList\}/);
  // 模型排行并入用量拆分的模型维度（对齐 magpie Split by），同样看到全部模型。
  assert.match(source, /<UsageSplitPanel key=\{module\} stats=\{stats\}/);
});

test('populated dashboard groups insight panels in a cache-economics then time-behavior narrative', () => {
  const source = populatedDashboardSource();
  // 贡献者网格之后才是「消费洞察」组，缓存流向先于模型金额，
  // 模型金额先于探索性象限，时段节奏先于异常侦测。
  const grid = source.indexOf('className={`dashboard-grid');
  const cacheFlow = source.indexOf('<CacheFlowPanel');
  const modelCost = source.indexOf('<ModelCostDistributionPanel');
  const quadrant = source.indexOf('<CostEfficiencyQuadrantPanel');
  const temporal = source.indexOf('<TemporalInsightsSection');
  assert.ok(grid < cacheFlow, 'cache flow moves below the contributor grid');
  assert.ok(cacheFlow < modelCost && modelCost < quadrant, 'cache economics precedes model cost then the exploratory quadrant');
  assert.ok(quadrant < temporal, 'the combined time-behavior section follows cache economics');
  const temporalSource = readSource(path.join(process.cwd(), 'src', 'components', 'TemporalInsightsSection.tsx'));
  assert.match(temporalSource, /if \(!rhythm && !detection\) return null/);
  assert.ok(temporalSource.indexOf('<UsageRhythmPanel') < temporalSource.indexOf('<AnomalySpikePanel'));
  // T10.111：分时段节奏的详情卡与相对色阶。成本/请求/同期只来自小时桶的同期序列，
  // 格子颜色按“与本期峰值的比值”单色相渐进，不再按 K/M/B 数量级跳色相。
  assert.match(temporalSource, /buildRhythm\(trends, context, comparison\)/);
  assert.match(source, /<TemporalInsightsSection[^>]*comparison=\{stats\.comparison \?\? null\}/);
  const rhythmSource = readSource(path.join(process.cwd(), 'src', 'components', 'UsageRhythmPanel.tsx'));
  assert.match(rhythmSource, /role="tooltip"/);
  assert.match(rhythmSource, /data-level=\{rhythmLevel\(/);
  assert.doesNotMatch(rhythmSource, /heatLevel\(/, 'rhythm cells no longer use the magnitude-class heat palette');
  assert.match(rhythmSource, /aria-describedby=\{active\?\.index === index \? tooltipId : undefined\}/);
  const rhythmCss = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(rhythmCss, /\.rhythm-cell\[data-level='5'\],\s*\.rhythm-legend i\[data-level='5'\] \{ background: var\(--color-primary\)/);
  assert.match(rhythmCss, /\.rhythm-tooltip-anchor \{[\s\S]*?pointer-events: none;/);
  const entitySource = readSource(path.join(process.cwd(), 'src', 'components', 'EntityDashboardModal.tsx'));
  assert.match(entitySource, /aria-label="分布对比口径"/);
  assert.match(entitySource, /describeCompositionItem\(item, metric, total\)/);
  // 最近记录是单条记录，按记录精度显示（T10.154 §4.1、D41）。
  assert.match(entitySource, /describeCost\(item\.cost, 'record'\)\} · \{formatDateTime\(item\.timestamp\)\}/);
});

test('cache presentation keeps proven splits and falls back to one combined metric', () => {
  assert.deepEqual(
    resolveCacheBreakdown({ cachedTokens: 120, cacheReadTokens: 100, cacheWriteTokens: 20 }),
    { kind: 'split', total: 120, read: 100, write: 20 },
  );
  assert.deepEqual(
    cacheDetailMetrics({ cachedTokens: 120, cacheReadTokens: 100, cacheWriteTokens: 20 }),
    [
      { label: '缓存读取', tokens: 100 },
      { label: '缓存写入', tokens: 20 },
    ],
  );

  assert.deepEqual(
    resolveCacheBreakdown({ cachedTokens: 120 }),
    { kind: 'combined', total: 120 },
  );
  assert.deepEqual(
    cacheDetailMetrics({ cachedTokens: 120 }),
    [{ label: '缓存合计', tokens: 120 }],
  );

  const combinedMarkup = MetricsGrid({
    summary: {
      totalTokens: 30,
      inputTokens: 20,
      outputTokens: 10,
      cachedTokens: 120,
      totalCost: 0.12,
      totalRequests: 2,
      avgTokensPerReq: 15,
    },
    showTotalTokens: false,
  });
  const combinedText = JSON.stringify(combinedMarkup);
  assert.match(combinedText, /当前数据仅提供缓存合计/);
  assert.doesNotMatch(combinedText, /未拆分/);
});

test('dashboard visual hierarchy keeps contributor panels aligned and trend metrics semantic', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const trend = readSource(path.join(process.cwd(), 'src', 'components', 'TrendPanel.tsx'));
  const entity = readSource(path.join(process.cwd(), 'src', 'components', 'EntityDashboardModal.tsx'));
  assert.match(css, /\.dashboard-grid > \.chart-panel \{[\s\S]*height: auto;[\s\S]*min-height: 320px;/);
  assert.doesNotMatch(css, /\.chart-panel\.model-ranking-panel\s*\{[\s\S]*height:/);
  assert.match(css, /\.comparison-kpis \{[\s\S]*border:[\s\S]*background:/);
  assert.match(css, /\.chart-fill \{[\s\S]*width:\s*100%;[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;/);
  assert.match(css, /\.comparison-trend-panel \{\s*height:\s*auto;\s*grid-template-rows:\s*auto auto auto auto;/);
  assert.match(css, /\.comparison-trend-panel \.chart-fill \{\s*min-height:\s*220px;/);
  // T10.159（审计 Q3/Q4）：趋势卡不再重复 KPI 的总量行，小指标条只留按已完成桶计算的
  // 日均/小时均与单位费用，总量与总量变化只由 MetricsGrid 回答一次。
  assert.doesNotMatch(trend, /metricLabel="有效 Tokens"/);
  assert.match(trend, /completedBucketAverage\(comparison, 'tokens'\)/);
  // 单位费用的标签、计算与显示保护统一在 utils/unitCost（T10.159 决定 d，专属看板条带共用）。
  assert.match(trend, /label: UNIT_COST_LABEL/);
  assert.match(readSource(path.join(process.cwd(), 'src', 'utils', 'unitCost.ts')), /UNIT_COST_LABEL = '单位费用'/);
  assert.match(trend, /className="comparison-kpi-main"/);
  assert.match(css, /\.comparison-kpi-main \{[\s\S]*gap:\s*4px;/);
  assert.match(css, /\.comparison-kpi-main > b \{[\s\S]*flex:\s*1 1 auto;[\s\S]*min-width:\s*0;/);
  assert.match(css, /\.modal-content \.metrics-grid \{[\s\S]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(css, /@media \(max-width: 1240px\) \{[\s\S]*\.modal-content \.metrics-grid \{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.entity-modal-header \{[\s\S]*position:\s*sticky;[\s\S]*top:\s*calc\(-1 \* var\(--space-6\)\);[\s\S]*z-index:\s*2;[\s\S]*background:\s*var\(--color-bg-panel\);/);
  assert.match(css, /\.entity-dashboard-modal > \* \{[\s\S]*flex-shrink:\s*0;/);
  assert.match(css, /\.entity-modal-actions \{[\s\S]*gap:\s*6px;/);
  assert.match(css, /\.entity-modal-actions > \.ghost-inline,[\s\S]*\.entity-modal-actions > \.secondary-inline \{[\s\S]*white-space:\s*nowrap;/);
  assert.match(css, /\.entity-copy-fallback \{[\s\S]*border:\s*1px solid var\(--color-danger-soft-border\);[\s\S]*background:\s*var\(--color-danger-soft-bg\);/);
  assert.match(entity, /clipboard unavailable/);
  assert.match(entity, /模型 ID（手动复制）/);
  assert.match(css, /Responsive KPI density[\s\S]*@media \(min-width: 341px\) and \(max-width: 860px\) \{\s*\.metrics-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /Responsive KPI density[\s\S]*\.metric-card \{[\s\S]*grid-template-columns: 28px minmax\(0, 1fr\);[\s\S]*padding: 12px;/);
  assert.match(css, /Responsive KPI density[\s\S]*\.metric-value \{[\s\S]*font-size: 20px;[\s\S]*white-space: nowrap;/);
  assert.match(css, /Currency carries exact decision value[\s\S]*\.metric-card\.has-compact-value \.metric-value \{[\s\S]*font-size: 17px;[\s\S]*letter-spacing: -0\.03em;/);
  assert.match(readSource(path.join(process.cwd(), 'src', 'components', 'MetricsGrid.tsx')), /compactValue: true[\s\S]*has-compact-value/);
  assert.match(css, /Responsive KPI density[\s\S]*@media \(max-width: 340px\) \{[\s\S]*?\.metrics-grid \{\s*grid-template-columns: 1fr;[\s\S]*\.metric-value \{[\s\S]*font-size: 26px;[\s\S]*white-space: nowrap;/);
});

// T10.204（T10.191 评审待定点 3）：全应用统一写「有效 Token」（单数），不再是「有效 Tokens」。
// 守卫防回退：改动这些文件时若又长出「有效 Tokens」，这里先红。
test('effective-token wording never regresses to the plural "有效 Tokens" (T10.204)', () => {
  const files = [
    ['src', 'components', 'CostEfficiencyQuadrantPanel.tsx'],
    ['src', 'components', 'LogsTable.tsx'],
    ['src', 'components', 'MetricsGrid.tsx'],
    ['src', 'components', 'TrendPanel.tsx'],
    ['src', 'components', 'UsageRhythmPanel.tsx'],
    ['src', 'utils', 'reportExport.ts'],
  ];
  for (const segments of files) {
    const source = readSource(path.join(process.cwd(), ...segments));
    assert.doesNotMatch(source, /有效 Tokens/, `${segments.join('/')} 不应再出现「有效 Tokens」`);
  }
});

test('metric accounting explanations remain readable instead of being clipped', () => {
  const source = readSource(path.join(process.cwd(), 'src', 'components', 'MetricsGrid.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const metricSub = css.slice(css.indexOf('.metric-sub {'), css.indexOf('.page-heading {'));

  // U-102（T10.278）：副行只留一行短文本，补充说明（如 I/O 比）进 title，不靠省略号截断。
  assert.match(source, /className="metric-sub" title=\{card\.subTitle \? `\$\{card\.sub\} · \$\{card\.subTitle\}` : card\.sub\}/);
  assert.match(metricSub, /line-height:\s*1\.35/);
  assert.match(metricSub, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(metricSub, /white-space:\s*nowrap/);
  assert.doesNotMatch(metricSub, /text-overflow:\s*ellipsis/);
});

test('device table actions expose a quiet reversible filter instead of a tall input-like pill', () => {
  const source = readSource(path.join(process.cwd(), 'src', 'components', 'LogsTable.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(source, /aria-pressed=\{machineSelected\}/);
  assert.match(source, /从设备筛选中移除 \$\{machine\}/);
  assert.match(source, /machines\.filter\(\(item\) => item !== machine\)/);
  assert.match(source, /<Monitor[\s\S]*aria-hidden="true"/);
  assert.match(source, /className="machine-filter-surface"/);
  assert.match(css, /\.machine-filter-surface \{[\s\S]*min-height: 26px;[\s\S]*border-radius: var\(--radius-full\)/);
  assert.doesNotMatch(source, /className="machine-pill machine-filter-button"/);
});

test('development dashboards derive range, distribution and entity comparisons from one fact chain', async () => {
  const devMockSource = readSource(path.join(process.cwd(), 'src', 'devMockTauri.ts'));
  assert.doesNotMatch(devMockSource, /timestamp\.slice\(0,\s*10\)/, 'date buckets must use the local calendar');
  const originalWindow = globalThis.window;
  globalThis.window = globalThis;
  const assertSeriesMatchesSummary = (period) => {
    assert.equal(period.series.reduce((sum, point) => sum + point.tokens, 0), period.summary.totalTokens);
    assert.equal(period.series.reduce((sum, point) => sum + point.requests, 0), period.summary.totalRequests);
    assert.ok(Math.abs(period.series.reduce((sum, point) => sum + point.cost, 0) - period.summary.totalCost) < 0.0001);
  };
  const assertDashboardFactChain = (dashboard) => {
    const history = dashboard.history.reduce((summary, item) => ({
      input: summary.input + item.inputTokens,
      output: summary.output + item.outputTokens,
      cached: summary.cached + item.cachedTokens,
      requests: summary.requests + (item.requests || 1),
      cost: summary.cost + item.cost,
    }), { input: 0, output: 0, cached: 0, requests: 0, cost: 0 });
    assert.equal(dashboard.summary.totalTokens, history.input + history.output);
    assert.equal(dashboard.summary.inputTokens, history.input);
    assert.equal(dashboard.summary.outputTokens, history.output);
    assert.equal(dashboard.summary.cachedTokens, history.cached);
    assert.equal(dashboard.summary.totalRequests, history.requests);
    assert.ok(Math.abs(dashboard.summary.totalCost - history.cost) < 0.0001);

    for (const distribution of [Object.values(dashboard.tools), Object.values(dashboard.models)]) {
      assert.equal(distribution.reduce((sum, item) => sum + (item.input || 0) + (item.output || 0), 0), dashboard.summary.totalTokens);
      assert.equal(distribution.reduce((sum, item) => sum + (item.cached || 0), 0), dashboard.summary.cachedTokens);
      assert.equal(distribution.reduce((sum, item) => sum + item.requests, 0), dashboard.summary.totalRequests);
      assert.ok(Math.abs(distribution.reduce((sum, item) => sum + (item.cost || 0), 0) - dashboard.summary.totalCost) < 0.0001);
    }
    const trendTokens = dashboard.trends.reduce((total, point) => total + Object.entries(point)
      .reduce((sum, [key, value]) => key === 'date' ? sum : sum + Number(value), 0), 0);
    assert.equal(trendTokens, dashboard.summary.totalTokens);
    assert.equal(Object.values(dashboard.heatmap).reduce((sum, value) => sum + value, 0), dashboard.summary.totalTokens);
    if (dashboard.comparison) {
      assert.deepEqual(dashboard.comparison.current.summary, dashboard.summary);
      assertSeriesMatchesSummary(dashboard.comparison.current);
      assertSeriesMatchesSummary(dashboard.comparison.previous);
    }
  };
  const assertCompositionMatchesSummary = (entity) => {
    for (const distribution of Object.values(entity.composition)) {
      assert.equal(distribution.reduce((sum, item) => sum + item.tokens, 0), entity.summary.totalTokens);
      assert.equal(distribution.reduce((sum, item) => sum + item.requests, 0), entity.summary.totalRequests);
      assert.ok(Math.abs(distribution.reduce((sum, item) => sum + item.cost, 0) - entity.summary.totalCost) < 0.0001);
    }
  };
  try {
    clearMocks();
    installDevMockTauri();
    const globalToday = await invoke('get_cached_stats', { range: 'today' });
    const globalWeek = await invoke('get_cached_stats', { range: 'week' });
    const globalMonth = await invoke('get_cached_stats', { range: 'month' });
    assert.equal(globalToday.comparison.window.kind, 'dayOverDay');
    assert.equal(globalWeek.comparison.window.kind, 'weekOverWeek');
    assert.equal(globalMonth.comparison.window.kind, 'monthOverMonth');
    for (const dashboard of [globalToday, globalWeek, globalMonth]) {
      assert.equal(
        dashboard.comparison.current.series.length,
        dashboard.comparison.previous.series.length,
        'comparison periods must expose equal-progress bucket counts',
      );
    }
    assert.notEqual(globalWeek.comparison.window.currentStart, globalToday.comparison.window.currentStart);
    assert.notEqual(globalMonth.comparison.window.currentStart, globalWeek.comparison.window.currentStart);
    assert.notEqual(globalWeek.comparison.window.previousStart, globalToday.comparison.window.previousStart);
    assert.notEqual(globalMonth.comparison.window.previousStart, globalWeek.comparison.window.previousStart);
    assertDashboardFactChain(globalToday);
    assertDashboardFactChain(globalWeek);
    assertDashboardFactChain(globalMonth);
    assert.equal(globalToday.meta.generatedAt, globalToday.meta.lastRefreshedAt);
    assert.equal(globalToday.meta.generatedAt, globalToday.comparison.window.currentEnd);
    assert.equal(globalWeek.meta.generatedAt, globalToday.meta.generatedAt);
    assert.equal(globalMonth.meta.generatedAt, globalToday.meta.generatedAt);

    const all = await invoke('get_cached_stats', { range: 'all' });
    assert.ok(all.history.length >= 60 * 4);
    assert.ok(new Date(all.history[0].timestamp) - new Date(all.history.at(-1).timestamp) >= 59 * 86_400_000);
    assertDashboardFactChain(all);

    // T10.108: custom inclusive date ranges compare against the preceding equal-length span.
    const customFortnight = await invoke('get_cached_stats', { scope: 'local', range: 'custom', start: '2026-07-01', end: '2026-07-14' });
    assert.equal(customFortnight.comparison.window.kind, 'periodOverPeriod');
    assert.equal(customFortnight.comparison.window.bucket, 'day');
    assert.equal(customFortnight.comparison.current.series.length, 14);
    assert.equal(customFortnight.comparison.previous.series.length, 14);
    assert.equal(customFortnight.trends.length, 14);
    assert.equal(customFortnight.meta.range, 'custom');
    assert.equal(customFortnight.meta.query.start, '2026-07-01');
    assert.equal(customFortnight.meta.query.end, '2026-07-14');
    assertDashboardFactChain(customFortnight);
    const customDay = await invoke('get_cached_stats', { scope: 'local', range: 'custom', start: '2026-07-10', end: '2026-07-10' });
    assert.equal(customDay.comparison.window.bucket, 'hour');
    assert.equal(customDay.trends.length, 24);
    assertDashboardFactChain(customDay);
    // T10.185: cloud custom ranges are no longer rejected client-side (the
    // cloud Stats v2 RPC has accepted `custom` since T10.113); the mock now
    // exercises the same happy path as local custom, cloud scope included.
    const cloudCustomFortnight = await invoke('get_cached_stats', { scope: 'cloud', range: 'custom', start: '2026-07-01', end: '2026-07-14' });
    assert.equal(cloudCustomFortnight.comparison.window.kind, 'periodOverPeriod');
    assert.equal(cloudCustomFortnight.comparison.window.bucket, 'day');
    assert.equal(cloudCustomFortnight.comparison.current.series.length, 14);
    assert.equal(cloudCustomFortnight.comparison.previous.series.length, 14);
    assert.equal(cloudCustomFortnight.trends.length, 14);
    assert.equal(cloudCustomFortnight.meta.range, 'custom');
    assert.equal(cloudCustomFortnight.meta.query.start, '2026-07-01');
    assert.equal(cloudCustomFortnight.meta.query.end, '2026-07-14');
    assertDashboardFactChain(cloudCustomFortnight);
    const cloudCustomDay = await invoke('get_cached_stats', { scope: 'cloud', range: 'custom', start: '2026-07-10', end: '2026-07-10' });
    assert.equal(cloudCustomDay.comparison.window.bucket, 'hour');
    assert.equal(cloudCustomDay.trends.length, 24);
    assertDashboardFactChain(cloudCustomDay);
    await assert.rejects(
      () => invoke('get_cached_stats', { scope: 'local', range: 'custom', start: '2026-07-14', end: '2026-07-01' }),
      /自定义范围/,
    );

    const studioWeek = await invoke('get_cached_stats', { range: 'week', deviceFilter: 'Studio-PC' });
    assert.equal(studioWeek.meta.query.machine, 'Studio-PC');
    assert.ok(studioWeek.history.every((item) => item.machineId === 'Studio-PC'));
    assertDashboardFactChain(studioWeek);

    const today = await invoke('get_entity_dashboard', {
      query: { scope: 'local', range: 'today', model: 'gpt-5-codex' },
    });
    assert.ok(today.summary.totalTokens > 0);
    assert.ok(today.summary.totalTokens < globalToday.summary.totalTokens);
    assert.equal(today.comparison.window.kind, 'dayOverDay');
    assert.equal(today.comparison.current.summary.totalTokens, today.summary.totalTokens);
    assert.ok(today.comparison.current.series.every((point) => point.tokens <= today.summary.totalTokens));
    assertSeriesMatchesSummary(today.comparison.current);
    assertSeriesMatchesSummary(today.comparison.previous);
    assertCompositionMatchesSummary(today);
    assert.ok(today.peak.tokens <= today.summary.totalTokens);
    assert.ok(Object.entries(today.heatmap).every(([date, tokens]) => tokens < globalToday.heatmap[date] || !(date in globalToday.heatmap)));
    assert.equal(today.meta.generatedAt, globalToday.meta.generatedAt);
    assert.equal(today.historyPage.meta.generatedAt, globalToday.meta.generatedAt);

    const week = await invoke('get_entity_dashboard', {
      query: { scope: 'local', range: 'week', model: 'gpt-5-codex' },
    });
    assert.equal(week.comparison.window.kind, 'weekOverWeek');
    assert.ok(week.summary.totalTokens > today.summary.totalTokens);
    assert.notEqual(week.comparison.window.currentStart, today.comparison.window.currentStart);
    assert.notEqual(week.comparison.window.previousStart, today.comparison.window.previousStart);
    assert.equal(week.comparison.current.summary.totalTokens, week.summary.totalTokens);
    assert.equal(week.meta.query.range, 'week');
    assert.equal(week.historyPage.meta.query.range, 'week');
    assertSeriesMatchesSummary(week.comparison.current);
    assertSeriesMatchesSummary(week.comparison.previous);
    assertCompositionMatchesSummary(week);

    const month = await invoke('get_entity_dashboard', {
      query: { scope: 'local', range: 'month', model: 'gpt-5-codex' },
    });
    assert.equal(month.comparison.window.kind, 'monthOverMonth');
    assert.ok(month.summary.totalTokens > week.summary.totalTokens);
    assert.notEqual(month.comparison.window.currentStart, week.comparison.window.currentStart);
    assert.notEqual(month.comparison.window.previousStart, week.comparison.window.previousStart);
    assert.equal(month.comparison.current.summary.totalTokens, month.summary.totalTokens);
    assert.equal(month.meta.query.range, 'month');
    assert.equal(month.historyPage.meta.query.range, 'month');
    assertSeriesMatchesSummary(month.comparison.current);
    assertSeriesMatchesSummary(month.comparison.previous);
    assertCompositionMatchesSummary(month);

    const monthStudio = await invoke('get_entity_dashboard', {
      query: { scope: 'local', range: 'month', model: 'gpt-5-codex', machine: 'Studio-PC' },
    });
    assert.deepEqual(monthStudio.comparison.current.summary, month.comparison.current.summary);
    assert.deepEqual(monthStudio.comparison.previous.summary, month.comparison.previous.summary);
    const currentShare = month.comparison.current.summary.totalTokens / globalMonth.comparison.current.summary.totalTokens;
    const previousShare = month.comparison.previous.summary.totalTokens / globalMonth.comparison.previous.summary.totalTokens;
    assert.ok(Math.abs(currentShare - previousShare) > 0.0001, 'previous entity data must not reuse the current-period share');

    const impossibleMachineIntersection = await invoke('get_entity_dashboard', {
      query: { scope: 'local', range: 'week', model: 'gpt-5-codex', machine: 'Travel-Laptop' },
    });
    assert.equal(impossibleMachineIntersection.summary.totalTokens, 0);
    assert.deepEqual(impossibleMachineIntersection.composition, { tools: [], models: [], machines: [] });
    assert.deepEqual(impossibleMachineIntersection.heatmap, {});
    assert.equal(impossibleMachineIntersection.peak, undefined);
    assert.deepEqual(impossibleMachineIntersection.activity, {
      activeDays: 0,
      firstSeenAt: null,
      lastSeenAt: null,
    });
    assert.equal(impossibleMachineIntersection.meta.query.machine, 'Travel-Laptop');
    assert.equal(impossibleMachineIntersection.historyPage.meta.query.machine, 'Travel-Laptop');
    assert.equal(impossibleMachineIntersection.historyPage.meta.query.range, 'week');
    assert.equal(impossibleMachineIntersection.comparison.current.summary.totalTokens, 0);
    assert.equal(impossibleMachineIntersection.comparison.previous.summary.totalTokens, 0);

    await assert.rejects(
      invoke('get_usage_details', { query: { scope: 'local', range: 'week', cursor: 'mock:-1' } }),
      /invalid mock cursor/,
    );

    const year = await invoke('get_entity_dashboard', {
      query: { scope: 'local', range: 'year', model: 'gpt-5-codex' },
    });
    const modelTimeline = all.history
      .filter((item) => item.model === 'gpt-5-codex')
      .map((item) => item.timestamp)
      .sort();
    assert.equal(year.activity.firstSeenAt, modelTimeline[0]);
    assert.equal(year.activity.lastSeenAt, modelTimeline[modelTimeline.length - 1]);
    assert.equal(year.comparison, null);
    assert.deepEqual(today.heatmap, year.heatmap, 'entity heatmap remains annual but is scoped to the selected entity');
  } finally {
    clearMocks();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('development details apply multi-select, self-excluding facets, search and query-bound cursors', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = globalThis;
  try {
    clearMocks();
    installDevMockTauri();
    const query = normalizeStatsQuery({
      range: 'today',
      timezone: 'UTC',
      machines: ['Travel-Laptop', 'Studio-PC'],
      tools: ['claude', 'codex'],
      models: [],
      search: 'SESSION-00',
      tokenMode: 'effective',
    });
    const firstPage = await invoke('get_usage_details', {
      query: { scope: 'local', ...query, cursor: null, limit: 1 },
    });
    assert.equal(firstPage.totalCount, 2);
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.items.every((item) => query.tools.includes(item.tool)));
    assert.ok(firstPage.items.every((item) => query.machines.includes(item.machineId)));
    assert.equal(queryEchoMatches(firstPage.meta.query, query), true);
    assert.deepEqual(firstPage.availableFilters.tools.map((option) => option.value).sort(), [
      'antigravity', 'claude', 'codex', 'minimax',
    ]);
    assert.deepEqual(firstPage.availableFilters.models.map((option) => option.value).sort(), [
      'claude-sonnet-4', 'gpt-5-codex',
    ]);

    await assert.rejects(
      invoke('get_usage_details', {
        query: {
          scope: 'local',
          ...query,
          tools: ['claude'],
          cursor: firstPage.nextCursor,
          limit: 1,
        },
      }),
      /cursor query mismatch/,
    );

    const entityQuery = normalizeStatsQuery({
      range: 'today',
      timezone: 'UTC',
      machines: ['Studio-PC'],
      tools: ['codex'],
      models: [],
      search: null,
      tokenMode: 'effective',
    });
    const entity = { kind: 'model', id: 'gpt-5-codex' };
    const dashboard = await invoke('get_entity_dashboard', {
      query: { scope: 'local', entity, ...entityQuery },
    });
    assert.equal(dashboard.entity.kind, 'model');
    assert.ok(dashboard.summary.totalTokens > 0);
    assert.equal(queryEchoMatches(dashboard.meta.query, entityQuery, dashboard.meta.entity, entity), true);
    assert.equal(queryEchoMatches(dashboard.historyPage.meta.query, entityQuery, dashboard.historyPage.meta.entity, entity), true);
  } finally {
    clearMocks();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('detail multi-select keeps explicit checkbox buttons above stacked panels', () => {
  const componentSource = readSource(
    path.join(process.cwd(), 'src', 'components', 'FilterMultiSelect.tsx'));
  const cssSource = readSource(path.join(process.cwd(), 'src', 'index.css'));

  assert.match(componentSource, /<button[\s\S]{0,400}?role="checkbox"/);
  assert.match(componentSource, /role="dialog"[\s\S]*aria-describedby=\{selectionSummaryId\}/);
  assert.match(componentSource, /id=\{selectionSummaryId\}[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*aria-atomic="true"/);
  assert.doesNotMatch(componentSource, /<input[^>]*type="checkbox"/);
  assert.match(cssSource, /\.detail-filter-panel\s*\{[^}]*z-index:\s*2;/);
  assert.match(cssSource, /\.detail-option-row\s*\{[^}]*min-height:\s*44px;/);
  assert.match(componentSource, /const \[alignTop, setAlignTop\]/);
  assert.match(componentSource, /getFilterPopoverPlacement\(/);
  assert.match(componentSource, /visibleLeft = Math\.max\(scrollPortBounds\?\.left \?\? 0, 0\) \+ 8/);
  assert.match(componentSource, /style=\{\{[\s\S]*left: popoverLeft !== null \? `\$\{popoverLeft\}px`/);
  assert.match(componentSource, /optionSearchInputRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(componentSource, /const spaceBelow = Math\.max\(0, visibleBottom - bounds\.bottom - 7\)/);
  assert.match(componentSource, /alignTop \? ' align-top'/);
  assert.match(componentSource, /const scrollPort = rootRef\.current\.closest<HTMLElement>\('\.app-content'\)/);
  assert.match(componentSource, /style=\{\{[\s\S]*maxHeight: popoverMaxHeight/);
  assert.match(cssSource, /\.detail-multiselect-popover\.align-top\s*\{[\s\S]*bottom:\s*calc\(100% \+ 7px\)/);
  assert.match(cssSource, /\.detail-multiselect-popover\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/);
  assert.match(cssSource, /\.detail-option-list\s*\{[\s\S]*min-height:\s*0;/);
  assert.match(cssSource, /\.detail-option-footer button\s*\{[\s\S]*min-inline-size:\s*44px;[\s\S]*white-space:\s*nowrap;/);
  assert.match(cssSource, /@media \(max-width: 430px\)\s*\{[\s\S]*\.detail-option-footer\s*\{[\s\S]*display:\s*grid;[\s\S]*\.detail-option-footer-actions\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(44px, 1fr\)\) minmax\(76px, auto\);/);
});

test('dashboard runtime decoder rejects malformed required fields before rendering', () => {
  assert.throws(
    () => parseStatsDataContract({
      summary: { totalTokens: 3, inputTokens: 1, outputTokens: 2 },
      tools: {}, models: {}, trends: [], heatmap: {}, history: [],
    }),
    /summary\.cachedTokens/,
  );
  assert.throws(
    () => parseStatsDataContract({
      summary: {
        totalTokens: 3, inputTokens: 1, outputTokens: 2, cachedTokens: 0,
        totalCost: Number.NaN, totalRequests: 1, avgTokensPerReq: 3,
      },
      tools: {}, models: {}, trends: [], heatmap: {}, history: [],
    }),
    /summary\.totalCost/,
  );
});

test('quota percentages fail closed instead of clamping invalid provider values', () => {
  assert.equal(quotaPercent({ unit: 'percent', used: 42 }), 42);
  assert.equal(quotaPercent({ unit: 'percent', used: 106 }), null);
  assert.equal(quotaPercent({ unit: 'percent', used: -2 }), null);
  assert.equal(quotaPercent({ unit: 'percent', used: Number.NaN }), null);
  assert.equal(quotaPercent({ unit: 'percent', used: Number.POSITIVE_INFINITY }), null);
  assert.equal(quotaPercent({ unit: 'percent', used: 42, limit: 99 }), null);
  assert.equal(quotaPercent({ unit: 'percent', used: 42, remaining: 57 }), null);
  assert.equal(quotaPercent({ unit: 'tokens', used: 42 }), null);
  assert.equal(quotaPercent({ unit: 'percent' }), null);
});

test('quota absolute values reject invalid arithmetic while preserving valid Credits states', () => {
  assert.deepEqual(
    validateQuotaWindowValues({ unit: 'credits', remaining: 12.5 }),
    { kind: 'absolute', used: undefined, limit: undefined, remaining: 12.5 },
  );
  assert.deepEqual(
    validateQuotaWindowValues({ unit: 'credits', reasonCode: 'credits_unlimited' }),
    { kind: 'unlimited' },
  );
  assert.deepEqual(
    validateQuotaWindowValues({ unit: 'credits', used: 0.1, limit: 0.3, remaining: 0.2 }),
    { kind: 'absolute', used: 0.1, limit: 0.3, remaining: 0.2 },
  );
  assert.equal(
    validateQuotaWindowValues({ unit: 'credits', used: 4, limit: 10, remaining: 7 }),
    null,
  );
  assert.equal(validateQuotaWindowValues({ unit: 'usd', used: -1 }), null);
  assert.equal(validateQuotaWindowValues({ unit: 'tokens', limit: Number.POSITIVE_INFINITY }), null);
  assert.equal(
    validateQuotaWindowValues({ unit: 'credits', remaining: 10, reasonCode: 'credits_unlimited' }),
    null,
  );
});

test('quota timeline and status validation fail closed before values reach presentation', () => {
  const timeline = {
    observedAt: '2026-07-15T01:00:00.000Z',
    fetchedAt: '2026-07-15T01:00:01.000Z',
    resetsAt: '2026-07-15T06:00:00.000Z',
    staleAfterSeconds: 900,
    windowMinutes: 300,
  };
  assert.equal(validateQuotaWindowTimeline(timeline), true);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, observedAt: '2026-07-15T01:00:00' }), false);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, observedAt: '2026-07-15 01:00:00Z' }), false);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, observedAt: '2026-02-31T01:00:00Z' }), false);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, observedAt: '2026-07-15T09:00:00+08:00' }), true);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, observedAt: '2026-07-15t01:00:00z' }), true);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, observedAt: '2026-07-15T01:00:00.123456789012Z' }), true);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, observedAt: 'not-a-date' }), false);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, fetchedAt: 'not-a-date' }), false);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, resetsAt: 'not-a-date' }), false);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, staleAfterSeconds: 0 }), false);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, staleAfterSeconds: Number.NaN }), false);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, staleAfterSeconds: 0.5 }), false);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, staleAfterSeconds: 2_147_483_648 }), false);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, windowMinutes: -1 }), false);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, windowMinutes: 0.5 }), false);
  assert.equal(validateQuotaWindowTimeline({ ...timeline, windowMinutes: 2_147_483_648 }), false);
  assert.equal(quotaStatusAllowsValues('ok'), true);
  assert.equal(quotaStatusAllowsValues('stale'), true);
  assert.equal(quotaStatusAllowsValues('error'), false);
  assert.equal(quotaStatusAllowsValues('auth-required'), false);
});

test('shared quota fixtures drive the production reader and transport status parser directly', () => {
  const complete = quotaFixture('complete-v1.json');
  const providers = parseQuotaProviderEnvelopes(complete.providers);
  assert.equal(providers.length, 4);
  assert.equal(providers.flatMap((provider) => provider.windows).length, 10);
  for (const provider of providers) {
    for (const window of provider.windows) {
      assert.equal(validateQuotaWindowTimeline(window), true);
      if (quotaStatusAllowsValues(window.status)) {
        assert.notEqual(validateQuotaWindowValues(window), null);
      }
    }
  }

  const states = quotaFixture('states-v1.json');
  for (const fixtureCase of states.envelopeCases) {
    assert.deepEqual(parseQuotaProviderEnvelopes([fixtureCase.provider]), [fixtureCase.provider]);
  }
  assert.equal(states.absenceCase.outcome, 'unavailable-not-zero');

  const invalid = quotaFixture('invalid-v1.json');
  const timelineCases = new Set([
    'timestamp-without-zone',
    'fractional-window-minutes',
    'fractional-stale-after-seconds',
    'timeline-integer-overflow',
  ]);
  for (const fixtureCase of invalid.cases) {
    if (timelineCases.has(fixtureCase.name)) {
      assert.equal(validateQuotaWindowTimeline(fixtureCase.providers[0].windows[0]), false, fixtureCase.name);
    }
  }

  const transport = quotaFixture('transport-v1.json');
  assert.equal(transport.replaceRequest.p_transport_version, 1);
  assert.equal(transport.replaceRequest.p_epoch, 7);
  assert.deepEqual(parseQuotaSyncStatus({
    enabled: true,
    state: 'active',
    lastSyncedAt: transport.replaceExpected.generatedAt,
  }), {
    enabled: true,
    state: 'active',
    lastSyncedAt: transport.replaceExpected.generatedAt,
  });
  assert.throws(() => parseQuotaSyncStatus({ enabled: true, state: 'disabled' }), /额度同步状态契约无效/);
  assert.throws(() => parseQuotaSyncStatus({ enabled: true, state: 'active', lastSyncedAt: 'not-time' }), /额度同步状态契约无效/);
  assert.deepEqual(parseQuotaSyncStatus({
    enabled: false,
    state: 'error',
    reasonCode: 'quota_sync_remote_clear_incomplete',
  }), {
    enabled: false,
    state: 'error',
    reasonCode: 'quota_sync_remote_clear_incomplete',
  });
});

test('verified company OpenAPI quota uses CNY ratios and stays secret-free', () => {
  const custom = quotaFixture('custom-openapi-v1.json');
  const providers = parseQuotaProviderEnvelopes(custom.providers);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].providerId, custom.expected.providerId);
  assert.equal(providers[0].displayName, '研发账号额度');
  assert.equal(providers[0].scope, 'api-organization');
  assert.deepEqual(
    providers[0].windows.map((window) => window.windowId),
    custom.expected.windowIds,
  );
  assert.ok(providers[0].windows.every((window) => window.source === 'official-api'));
  assert.ok(providers[0].windows.every((window) => validateQuotaWindowValues(window) !== null));

  const backend = readSource(
    path.join(process.cwd(), 'src-tauri', 'src', 'quota', 'custom.rs'));
  const settings = readSource(
    path.join(process.cwd(), 'src-tauri', 'src', 'settings.rs'));
  const quotaSettings = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'QuotaSection.tsx'));
  const androidWidget = readSource(
    path.join(
      process.cwd(),
      'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf',
      'tokenledger', 'mobile', 'widget', 'WidgetConfigureActivity.kt',
    ));
  assert.match(backend, /KEYRING_SERVICE/);
  assert.match(backend, /redirect\(redirect::Policy::none\(\)\)/);
  assert.match(backend, /\.bearer_auth\(api_key\)/);
  assert.match(backend, /MAX_RESPONSE_BYTES/);
  assert.match(backend, /source_schema_unsupported/);
  assert.match(backend, /const RESPONSE_SCHEMA_VERIFIED: bool = true/);
  assert.match(backend, /RESPONSE_SCHEMA_VERIFIED && is_enabled_provider/);
  assert.match(backend, /key_day_cost_cny/);
  assert.match(backend, /key_daily_limit_effective_cny/);
  assert.match(backend, /day_cost_cny/);
  assert.match(backend, /day_limit_cny/);
  assert.match(backend, /month_cost_cny/);
  assert.match(backend, /month_limit_cny/);
  assert.match(settings, /API keys are deliberately not/);
  assert.doesNotMatch(settings, /pub api_key\s*:/);
  assert.match(settings, /api_key_configured/);
  // Presence metadata no longer proves an origin-bound credential is usable.
  // Keep this guard on the read-only listing boundary; Rust tests exercise its tri-state values.
  const viewProjection = backend.slice(backend.indexOf('fn view_for('), backend.indexOf('fn list_views('));
  assert.match(viewProjection, /has_api_key:/);
  assert.doesNotMatch(viewProjection, /load_api_key|credential_entry|decode_bound_key/);
  assert.match(quotaSettings, /只写入当前电脑的系统安全存储/);
  assert.match(quotaSettings, /删除云端快照/);
  assert.match(quotaSettings, /Key 当日消耗 ÷ Key 当日有效上限/);
  assert.match(quotaSettings, /不上传金额、URL、API key 或原始响应/);
  assert.match(quotaSettings, /Key 过期时间不冒充额度重置时间/);
  assert.match(quotaSettings, /打开设置只读取配置元数据/);
  assert.match(androidWidget, /选择全部可用来源，或固定一个来源。/);
  assert.match(
    androidWidget,
    /orderedQuotaProvidersForDisplay\(\)\s*\.map \{ ProviderOption\(it\.providerId, it\.localizedDisplayName\(\)\) \}/,
  );
  assert.match(androidWidget, /providers\.forEach \{ option ->/);
  assert.doesNotMatch(JSON.stringify(custom), /apiKey|api_key|Authorization|Bearer/);
});

test('deleted local company endpoints retain a per-provider cloud cleanup path', () => {
  const endpoints = [{
    id: '0123456789abcdef01234567',
    providerId: 'company-openapi-0123456789abcdef01234567',
    displayName: '仍在本机',
    url: 'https://your-gateway.example.com/v1/me/quota',
    enabled: true,
    hasApiKey: true,
    schemaVerified: false,
  }];
  const providers = [
    { providerId: endpoints[0].providerId, displayName: '仍在本机' },
    { providerId: 'company-openapi-89abcdef0123456789abcdef', displayName: '仅云端历史' },
    { providerId: 'company-openapi-89abcdef0123456789abcdef', displayName: '重复快照' },
    { providerId: 'openai-codex-local', displayName: 'Codex' },
  ];

  assert.deepEqual(orphanedCustomQuotaProviders(endpoints, providers), [{
    providerId: 'company-openapi-89abcdef0123456789abcdef',
    displayName: '仅云端历史',
  }]);
});

test('quota stop is local-only while cloud deletion remains explicit and tombstoned', () => {
  const appSource = [
    readSource(path.join(process.cwd(), 'src', 'App.tsx')),
    readSource(path.join(process.cwd(), 'src', 'hooks', 'useQuota.ts')),
  ].join('\n');
  const settingsSource = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'QuotaSection.tsx'));
  assert.match(appSource, /跨设备额度同步已关闭；本机停止读写，云端历史仍保留/);
  assert.match(appSource, /invoke<unknown>\('delete_quota_snapshot_provider'/);
  assert.match(appSource, /invoke<unknown>\('clear_quota_snapshots'/);
  assert.match(settingsSource, /只会停止这台设备，不会删除云端历史/);
  assert.match(settingsSource, /删除单个来源后，新的本机观测仍可同步；删除全部会关闭本机额度同步/);
  assert.match(settingsSource, /删除全部云端额度/);
  assert.doesNotMatch(settingsSource, /快照可能保留至 25 小时/);
});

test('本机额度同步容量超限提供关闭来源且不删云端的说明', () => {
  const feedback = quotaSyncNowFeedback({ enabled: true, state: 'error', reasonCode: 'quota_sync_invalid_provider_count' });
  assert.equal(feedback.type, 'error');
  assert.match(feedback.message, /本机待同步的活跃来源超过 8 个/);
  assert.match(feedback.message, /最多支持 8 个活跃来源/);
  assert.match(feedback.message, /额度设置.*关闭部分本机来源.*重试/);
  assert.match(feedback.message, /已保留的云端来源不会被删除/);
});

test('云端活跃容量拒绝说明关闭本机不释放名额、不自动清空', () => {
  const feedback = quotaSyncNowFeedback({ enabled: true, state: 'error', reasonCode: 'quota_sync_capacity_exceeded' });
  assert.equal(feedback.type, 'error');
  assert.match(feedback.message, /本次同步会使云端活跃来源超过 8 个上限.*本次新增来源未同步/);
  assert.match(feedback.message, /关闭本机来源不会删除云端历史或释放名额/);
  assert.match(feedback.message, /查看.*云端快照管理.*删除范围与代价/);
});

test('quota sync-now feedback reports success only for an unqualified active upload', () => {
  assert.deepEqual(
    quotaSyncNowFeedback({ enabled: true, state: 'active' }),
    { type: 'success', message: '额度快照已同步' },
  );
  for (const status of [
    { enabled: false, state: 'disabled' },
    { enabled: true, state: 'paused', reasonCode: 'quota_sync_stale_epoch' },
    { enabled: false, state: 'error', reasonCode: 'quota_sync_remote_clear_incomplete' },
    { enabled: true, state: 'auth-required', reasonCode: 'quota_sync_auth_required' },
    { enabled: true, state: 'unavailable', reasonCode: 'quota_sync_rpc_unavailable' },
    { enabled: true, state: 'syncing' },
    { enabled: true, state: 'active', reasonCode: 'quota_sync_rpc_unavailable' },
    { enabled: true, state: 'active', reasonCode: 'quota_sync_capacity_exceeded' },
  ]) {
    assert.notEqual(quotaSyncNowFeedback(status).type, 'success');
  }
});

test('清空反馈只接受明确停用成功状态；未知、拒绝和本机停用未确认均不成功', () => {
  assert.equal(quotaClearFeedback({ enabled: false, state: 'disabled' }).type, 'success');
  for (const status of [
    { enabled: true, state: 'active' },
    { enabled: false, state: 'disabled', reasonCode: 'quota_sync_clear_outcome_unknown' },
    { enabled: false, state: 'error', reasonCode: 'quota_sync_remote_clear_incomplete' },
    { enabled: false, state: 'error', reasonCode: 'quota_sync_clear_local_stop_incomplete' },
    { enabled: false, state: 'error', reasonCode: 'quota_sync_clear_outcome_unknown_local_stop_incomplete' },
    { enabled: false, state: 'error', reasonCode: 'quota_sync_clear_rejected_device_stopped' },
    { enabled: true, state: 'error', reasonCode: 'quota_sync_clear_dispatch_stop_incomplete' },
    { enabled: false, state: 'auth-required' },
  ]) {
    assert.equal(quotaClearFeedback(status).type, 'error');
  }
});

test('清空错误只识别安全原因码，不回显后端原文或宣称取消已撤销', () => {
  for (const error of [
    'quota_sync_clear_outcome_unknown: 安全说明',
    new Error('quota_sync_clear_outcome_unknown: 安全说明'),
  ]) {
    const feedback = quotaClearErrorFeedback(error);
    assert.equal(feedback.type, 'error');
    assert.match(feedback.message, /可能已在云端生效.*不代表已撤销/);
    assert.match(feedback.message, /本机额度同步已关闭.*须手动重新启用/);
  }
  assert.match(quotaClearErrorFeedback('quota_sync_clear_outcome_unknown_local_stop_incomplete: safe').message,
    /本机关闭同步也未确认/);
  assert.match(quotaClearErrorFeedback('quota_sync_clear_local_stop_incomplete: safe').message,
    /云端已确认删除.*不要因这个错误重复删除/);
  assert.match(quotaClearErrorFeedback('quota_sync_clear_busy: safe').message,
    /本次清空尚未发送.*稍后重新确认/);
  const rejected = quotaClearErrorFeedback('quota_sync_clear_rejected_device_stopped: safe');
  assert.equal(rejected.type, 'error');
  assert.match(rejected.message, /本次删除请求被拒绝，不能视为删除完成.*本机额度同步已关闭.*不会自动恢复.*须手动重新启用/);
  assert.doesNotMatch(rejected.message, /云端快照未清空/);
  assert.deepEqual(quotaClearFeedback({ enabled: false, state: 'error', reasonCode: 'quota_sync_clear_rejected_device_stopped' }), rejected);
  const notDispatched = quotaClearErrorFeedback('quota_sync_clear_dispatch_stop_incomplete: safe');
  assert.equal(notDispatched.type, 'error');
  assert.match(notDispatched.message, /关闭本机同步未完成.*本次云端删除尚未发送/);
  assert.deepEqual(quotaClearFeedback({ enabled: true, state: 'error', reasonCode: 'quota_sync_clear_dispatch_stop_incomplete' }), notDispatched);
  const unknown = quotaClearErrorFeedback('secret=hidden; quota_sync_clear_outcome_unknown');
  assert.equal(unknown.type, 'error');
  assert.doesNotMatch(unknown.message, /secret|hidden/);
  assert.match(unknown.message, /处理登录或连接问题/);
});

test('设置页额度同步在进行中暴露状态并禁用重复点击', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'QuotaSection.tsx'));
  const primitives = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'SettingsPrimitives.tsx'));
  assert.match(source, /const quotaSyncBusy = quotaSyncStatus\.state === 'syncing';/);
  assert.match(source, /const quotaSyncButtonLabel = quotaSyncBusy \? '同步中…' : '同步额度';/);
  assert.match(source, /const quotaSyncButtonAriaLabel = quotaSyncBusy \? '正在同步额度' : '同步额度';/);
  assert.match(source, /const quotaSyncActionDisabledReason = busy\.settings/);
  assert.match(source, /<SettingsRow label="跨设备同步状态" hint="停用或撤权只停止这台设备，云端历史仍保留。" busy=\{quotaSyncBusy\} wideControl=\{Boolean\(quotaSyncRecoveryMessage\)\}>/);
  assert.match(source, /style=\{quotaSyncRecoveryMessage \? \{ display: 'block', overflow: 'visible', WebkitLineClamp: 'unset' \} : undefined\}/);
  assert.match(source, /aria-label=\{quotaSyncButtonAriaLabel\}/);
  assert.match(source, /id="quota-sync-action-hint"/);
  assert.match(source, /aria-describedby=\{quotaSyncActionDisabledReason \? 'quota-sync-action-hint' : undefined\}/);
  assert.match(source, /title=\{quotaSyncButtonTitle\}/);
  assert.match(source, /disabled=\{busy\.settings \|\| !appSettings\.quota_snapshot_sync_enabled \|\| quotaSyncBusy\}/);
  assert.match(source, /\{quotaSyncButtonLabel\}/);
  assert.match(primitives, /aria-busy=\{rowBusy \|\| undefined\}/);
});

test('云端额度快照删除在进行中暴露 provider 级反馈并禁用重复点击', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'QuotaSection.tsx'));
  const hook = readSource(
    path.join(process.cwd(), 'src', 'hooks', 'useQuota.ts'));
  assert.match(source, /const runDeleteQuotaSnapshot = async/);
  assert.match(source, /const runClearQuotaSnapshots = async/);
  assert.match(source, /aria-label=\{cloudDeleteBusy \? `正在删除/);
  assert.match(source, /aria-busy=\{cloudDeleteBusy \|\| undefined\}/);
  assert.match(source, /\{cloudDeleteBusy \? '删除中…' : '删除云端快照'\}/);
  assert.match(source, /aria-busy=\{quotaSnapshotAllBusy \|\| undefined\}/);
  assert.match(source, /\{quotaSnapshotAllBusy \? '删除中…' : '删除全部云端额度'\}/);
  assert.match(hook, /if \(!\(await confirm\(\{[\s\S]*title: '删除这个来源的云端额度快照？'/);
  assert.match(hook, /if \(!\(await confirm\(\{[\s\S]*title: '删除全部云端额度快照？'/);
  assert.match(source, /onConfirm: RequestConfirmation/);
  assert.match(hook, /return true;[\s\S]*?return false;/);
});

test('设置危险操作统一使用可访问的确认对话框而不是原生 confirm', () => {
  const app = readSource(path.join(process.cwd(), 'src', 'App.tsx'));
  const settings = readSource(path.join(process.cwd(), 'src', 'hooks', 'useSettings.ts'));
  const quota = readSource(path.join(process.cwd(), 'src', 'hooks', 'useQuota.ts'));
  const quotaSection = readSource(path.join(process.cwd(), 'src', 'components', 'settings', 'QuotaSection.tsx'));
  const dialog = readSource(path.join(process.cwd(), 'src', 'components', 'ConfirmDialog.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(app, /const requestConfirmation = useCallback<RequestConfirmation>/);
  assert.match(app, /<ConfirmDialog[\s\S]*onCancel=\{\(\) => settleConfirmation\(false\)\}/);
  assert.doesNotMatch(`${settings}\n${quota}\n${quotaSection}`, /window\.confirm/);
  assert.match(dialog, /role="alertdialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /focusWrapTarget/);
  assert.match(css, /\.confirm-dialog \{[\s\S]*width: min\(480px/);
  assert.match(css, /\.confirm-dialog-danger \.confirm-dialog-icon/);
});

test('development mock supports read-only sync and keeps deletion explicit', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = globalThis;
  try {
    clearMocks();
    installDevMockTauri();
    const initial = await invoke('get_settings');
    assert.equal(initial.quota_snapshot_sync_enabled, false);
    const generic = await invoke('save_settings', {
      settings: { ...initial, quota_snapshot_sync_enabled: true },
    });
    assert.equal(generic.settings.quota_snapshot_sync_enabled, false);
    const enabled = parseQuotaSyncStatus(await invoke('set_quota_snapshot_sync_enabled', { enabled: true }));
    assert.equal(enabled.state, 'active');
    const deleted = parseQuotaSyncStatus(await invoke('delete_quota_snapshot_provider', {
      providerId: 'openai-codex-local',
      scope: 'consumer-subscription',
    }));
    assert.equal(deleted.state, 'active');
    const cleared = parseQuotaSyncStatus(await invoke('clear_quota_snapshots'));
    assert.equal(cleared.state, 'disabled');
    assert.equal((await invoke('get_settings')).quota_snapshot_sync_enabled, false);
    const deletedWhileStopped = parseQuotaSyncStatus(await invoke('delete_quota_snapshot_provider', {
      providerId: 'anthropic-claude-consumer',
      scope: 'consumer-subscription',
    }));
    assert.equal(deletedWhileStopped.state, 'disabled');
    await invoke('set_quota_snapshot_sync_enabled', { enabled: true });
    const signedOut = await invoke('supabase_sign_out');
    assert.match(signedOut.message, /停止额度同步/);
    assert.equal((await invoke('get_settings')).quota_snapshot_sync_enabled, false);
    assert.equal((await invoke('get_cloud_status')).authenticated, false);
    await invoke('supabase_sign_in', { credentials: { email: 'z@tokenledger.local', password: 'fixture-password' } });
    assert.equal((await invoke('get_cloud_status')).authenticated, true);
  } finally {
    clearMocks();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('development sync mock mirrors the Rust upload result and clears pending records', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = globalThis;
  try {
    clearMocks();
    installDevMockTauri();
    assert.equal((await invoke('get_db_info')).unsyncedRecords, 12);
    const result = await invoke('sync_to_supabase');
    assert.deepEqual(result, {
      success: true,
      message: '同步完成',
      synced_count: 12,
      purged_count: 0,
      summary_refreshed: true,
      warning: null,
    });
    assert.equal((await invoke('get_db_info')).unsyncedRecords, 0);
    const retry = await invoke('sync_to_supabase');
    assert.equal(retry.success, true);
    assert.equal(retry.synced_count, 0);
    assert.equal(retry.summary_refreshed, true);
  } finally {
    clearMocks();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('quota envelope structure rejects status, scope, provider and unsupported mismatches', () => {
  const windowSnapshot = {
    providerId: 'openai-codex-local',
    windowId: 'primary',
    windowLabel: '5 hour',
    scope: 'consumer-subscription',
    source: 'local-authorized',
    status: 'ok',
    unit: 'percent',
    used: 42,
    observedAt: '2026-07-15T01:00:00.000Z',
    fetchedAt: '2026-07-15T01:00:01.000Z',
    staleAfterSeconds: 900,
  };
  const provider = {
    schemaVersion: 1,
    providerId: 'openai-codex-local',
    displayName: 'Codex',
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: 'stable',
    status: 'ok',
    windows: [windowSnapshot],
  };
  assert.equal(validateQuotaProviderEnvelopeStructure(provider), true);
  assert.equal(validateQuotaProviderEnvelopeStructure({ ...provider, schemaVersion: 2 }), false);
  assert.equal(validateQuotaProviderEnvelopeStructure({
    ...provider,
    windows: [{ ...windowSnapshot, providerId: 'other' }],
  }), false);
  assert.equal(validateQuotaProviderEnvelopeStructure({
    ...provider,
    windows: [{ ...windowSnapshot, scope: 'manual-budget' }],
  }), false);
  assert.equal(validateQuotaProviderEnvelopeStructure({
    ...provider,
    status: 'auth-required',
  }), false);
  assert.equal(validateQuotaProviderEnvelopeStructure({
    ...provider,
    mode: 'unsupported',
    capability: 'unsupported',
    status: 'unsupported',
    windows: [],
  }), false);
  assert.equal(validateQuotaProviderEnvelopeStructure({
    ...provider,
    mode: 'unsupported',
    capability: 'unsupported',
    status: 'unsupported',
    reasonCode: 'consumer_api_unavailable',
    windows: [],
  }), true);
  assert.equal(validateQuotaProviderEnvelopeStructure({
    ...provider,
    reasonCode: 'unregistered_upstream_message',
  }), true, 'readers preserve forward compatibility and localize unknown reason codes safely');
  assert.equal(validateQuotaProviderEnvelopeStructure({
    ...provider,
    mode: 'unsupported',
    capability: 'unsupported',
    status: 'unsupported',
  }), false);
  const staleWindow = { ...windowSnapshot, windowId: 'weekly', status: 'stale' };
  const errorWindow = {
    ...windowSnapshot,
    windowId: 'secondary',
    status: 'error',
    used: undefined,
    reasonCode: 'upstream_unavailable',
  };
  assert.equal(validateQuotaProviderEnvelopeStructure({
    ...provider,
    windows: [windowSnapshot, staleWindow],
  }), true, 'fresh provider may expose an independently stale secondary window');
  assert.equal(validateQuotaProviderEnvelopeStructure({
    ...provider,
    windows: [windowSnapshot, errorWindow],
  }), true, 'fresh provider may expose an independently unavailable secondary window');
  assert.equal(validateQuotaProviderEnvelopeStructure({
    ...provider,
    status: 'stale',
    windows: [windowSnapshot, staleWindow],
  }), true, 'stale provider may retain an independently fresh secondary window');
  assert.equal(validateQuotaProviderEnvelopeStructure({
    ...provider,
    windows: [staleWindow],
  }), false, 'ok provider requires at least one fresh window');
  assert.equal(validateQuotaProviderEnvelopeStructure({
    ...provider,
    status: 'stale',
    windows: [windowSnapshot],
  }), false, 'stale provider requires at least one stale window');
  assert.deepEqual(parseQuotaProviderEnvelopes([provider]), [provider]);
  assert.throws(() => parseQuotaProviderEnvelopes([provider, provider]), /稳定键重复/);
  assert.throws(() => parseQuotaProviderEnvelopes(null), /额度 Provider 契约无效/);
  assert.throws(() => parseQuotaProviderEnvelopes({}), /额度 Provider 契约无效/);
  assert.throws(() => parseQuotaProviderEnvelopes([null]), /额度 Provider 契约无效/);
  assert.throws(
    () => parseQuotaProviderEnvelopes([{ ...provider, schemaVersion: 2 }]),
    /额度 Provider 契约无效/,
  );
});

test('quota actions use explicit settings and command allowlists and reject arbitrary URLs', () => {
  const codexSettings = {
    kind: 'open-settings',
    labelKey: 'quota.action.enableCodexLocal',
    value: 'codex-local',
  };
  assert.deepEqual(validateQuotaAction('openai-codex-local', codexSettings), codexSettings);
  assert.equal(validateQuotaAction('anthropic-claude-consumer', codexSettings), null);
  const claudeUsage = {
    kind: 'show-command',
    labelKey: 'quota.action.showClaudeUsage',
    value: '/usage',
  };
  assert.deepEqual(validateQuotaAction('anthropic-claude-consumer', claudeUsage), claudeUsage);
  assert.equal(validateQuotaAction('anthropic-claude-consumer', {
    ...claudeUsage,
    value: 'rm -rf ~',
  }), null);
  assert.equal(validateQuotaAction('openai-codex-local', {
    kind: 'open-url',
    labelKey: 'quota.action.openHelp',
    value: 'https://example.com/help',
  }), null);
  assert.equal(validateQuotaAction('openai-codex-local', {
    kind: 'open-url',
    labelKey: 'quota.action.openHelp',
    value: 'javascript:alert(1)',
  }), null);
  assert.equal(providerEmptyStateLabel({ status: 'auth-required' }, codexSettings), '需要授权');
  assert.equal(providerEmptyStateLabel({ status: 'unsupported' }, claudeUsage), '来源不可用');
  assert.equal(providerEmptyStateLabel({ status: 'error' }, null), '读取失败');
});

test('quota cards keep one shared validation path and do not invent percentage progress for balances', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'QuotaPanel.tsx'));
  const state = source.slice(source.indexOf('function quotaWindowState'), source.indexOf('interface QuotaDisplayGroup'));
  assert.match(state, /validateQuotaWindowValues\(window\)/);
  assert.match(state, /validateQuotaWindowTimeline\(window\)/);
  assert.match(source, /validateQuotaProviderEnvelopeStructure\(provider\)/);
  assert.match(state, /quotaStatusAllowsValues\(effectiveStatus\)/);
  assert.match(state, /valueContractRejected = \(/);
  assert.match(state, /isCompanyQuotaProvider\(window\.providerId\) && rawValues\.kind !== 'percent'/);
  assert.match(source, /values\?\.kind === 'absolute'/);
  assert.match(source, /values\?\.kind === 'unlimited'/);
  assert.match(source, /presentationProvider\.status === 'ok' \|\| presentationProvider\.status === 'stale'/);
  assert.match(source, /groupQuotaWindows\(view\.companyProvider \? view\.companyWindows : view\.presentationProvider\.windows\)/);
  assert.match(source, /window\.providerId}:\$\{window\.scope}:\$\{window\.windowId/);
  assert.doesNotMatch(source, /REASON_LABELS\[provider\.reasonCode \|\| ''\] \|\| provider\.reasonCode/);
  assert.doesNotMatch(source, /Math\.max\(0, window\.remaining\)/);
});

test('quota dashboard is a continuous provider list without legacy hero, rings, or saved display mode', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'QuotaPanel.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.doesNotMatch(source, /QuotaViewMode|tokenledger:quota-view-mode|localStorage|quota-hero|QuotaRing|collectQuotaHighlights|summarizeQuotaHighlights/);
  assert.doesNotMatch(css, /\.quota-ring|quota-ring-sweep|\.quota-hero|\.quota-view-switch/);
  assert.match(source, /ChevronDown/);
  assert.match(source, /<summary[^>]*aria-label=/);
  assert.match(source, /详情/);
  assert.match(source, /aria-label=\{`\$\{windowLabel\} 可用额度`\}/);
  assert.match(source, /<span style=\{\{ width: `\$\{100 - used\}%` \}\} \/>/);
  assert.match(css, /\.quota-dashboard \{[\s\S]{0,360}display: grid;[\s\S]{0,360}grid-template-columns: 1fr;/);
  assert.match(css, /\.quota-provider \{/);
  assert.match(css, /\.quota-window-list \{\s*display: grid;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /@container quota-panel \(max-width: 640px\) \{[\s\S]{0,1800}\.quota-provider/);
  assert.match(css, /@container quota-panel \(max-width: 300px\) \{[\s\S]{0,1000}\.quota-window-list \{[\s\S]{0,160}grid-template-columns: 1fr;/);
});

test('quota providers without displayable windows move into a compact pending group', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'QuotaPanel.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const baseWindow = {
    providerId: 'openai-codex-local',
    windowId: 'primary',
    windowLabel: '5 hour',
    scope: 'consumer-subscription',
    source: 'local-authorized',
    status: 'ok',
    unit: 'percent',
    used: 42,
    observedAt: '2026-07-15T01:00:00.000Z',
    fetchedAt: '2026-07-15T01:00:01.000Z',
    staleAfterSeconds: 900,
  };
  assert.equal(quotaProviderHasRenderableWindows({
    schemaVersion: 1,
    providerId: 'openai-codex-local',
    displayName: 'Codex',
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: 'stable',
    status: 'ok',
    windows: [baseWindow],
  }), true);
  assert.equal(quotaProviderHasRenderableWindows({
    schemaVersion: 1,
    providerId: 'company-openapi-0123456789abcdef01234567',
    displayName: '团队 API',
    scope: 'api-organization',
    mode: 'automatic',
    capability: 'stable',
    status: 'ok',
    windows: [{
      ...baseWindow,
      providerId: 'company-openapi-0123456789abcdef01234567',
      windowId: 'key-daily',
      windowLabel: 'Key daily',
      scope: 'api-organization',
      source: 'official-api',
    }],
  }), false);
  assert.equal(quotaProviderHasRenderableWindows({
    schemaVersion: 1,
    providerId: 'anthropic-claude-consumer',
    displayName: 'Claude',
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: 'plan-dependent',
    status: 'auth-required',
    windows: [],
  }), false);
  assert.match(source, /const renderableProviders = displayedProviderViews\.filter\(\(view\) => view\.hasRenderableWindows\)/);
  assert.match(source, /className="quota-pending-providers"/);
  assert.match(source, /<h3 id="quota-pending-title">待处理来源<\/h3>/);
  assert.match(source, /pending \? 'quota-provider-pending' : 'quota-provider'/);
  assert.match(css, /\.quota-pending-list \{[\s\S]*grid-template-columns: 1fr/);
  assert.match(css, /\.quota-provider-pending \{[\s\S]*background: var\(--color-bg-subtle\)/);
  // 公司来源仍只选择日/月窗口；与普通来源共用两列窗口网格，不能回退为旧的 320px 公司专用布局。
  assert.match(source, /selectCompanyQuotaWindows\(presentationProvider\.windows\)/);
  assert.match(source, /COMPANY_QUOTA_WINDOW_LABELS\.has\(window\.windowId\)/);
  assert.match(css, /\.quota-window-list \{\s*display: grid;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.doesNotMatch(css, /\.quota-company-window-list/);
});

test('quota dashboard keeps normal windows compact while preserving exceptional freshness details', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'QuotaPanel.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(source, /effectiveStatus !== 'ok'/);
  assert.match(source, /className="sr-only">数据最新，\{formatObserved\(window\.observedAt\)\}/);
  assert.match(source, /来源快照，不推算未提供的余额/);
  assert.match(source, /quota-panel-subtitle/);
  assert.match(source, /<section className="panel quota-panel" aria-labelledby="quota-panel-title"[^>]*>/);
  assert.match(source, /<h2 id="quota-panel-title" className="panel-title"/);
  assert.match(source, /function quotaWindowState\(window: QuotaWindowSnapshot, now: number\)/);
  // T10.159：行尾详情另收额度消耗速度的方法、区间与不预测的原因（T10.153 §5.2、§10 第 3 条），
  // 多一个可选的来源能力参数，交给 computeQuotaPace 判断。
  assert.match(source, /function QuotaDetails\(\{ windows, now, label(?:, providerCapability)? \}/);
  assert.match(source, /<details className="quota-details">[\s\S]{0,180}<summary aria-label=\{`\$\{label\}：查看额度详情`\}/);
  assert.match(source, /<QuotaDetails windows=\{windows\} now=\{now\} label=/);
  assert.match(source, /const sharedStatus = states\.length && states\.every\(state => state\.effectiveStatus === states\[0\]\.effectiveStatus\)[\s\S]{0,100}\? states\[0\]\.effectiveStatus : undefined;/);
  assert.match(source, /title="仅展示来源返回的真实额度，不推算未提供的余额"/);
  assert.match(source, /<p className="quota-panel-subtitle">剩余额度<\/p>/);
  assert.match(source, /<strong title=\{windowLabel\}>\{windowLabel\}<\/strong>/);
  assert.doesNotMatch(source, /effectiveStatus === 'ok' \? '最新'/);
  assert.doesNotMatch(source, /\{usedDisplay\}% 已使用/);
  assert.match(source, /const quotaRefreshBusy = loading \|\| quotaSyncBusy;/);
  assert.match(source, /const quotaRefreshButtonLabel = loading \? '读取中…' : quotaSyncBusy \? '同步中…' : '刷新额度';/);
  assert.match(source, /const quotaRefreshAriaLabel = loading \? '正在读取额度' : quotaSyncBusy \? '正在同步额度' : '刷新额度';/);
  assert.match(source, /aria-label=\{quotaRefreshAriaLabel\}/);
  assert.match(source, /aria-busy=\{quotaRefreshBusy\}/);
  assert.match(source, /title=\{quotaRefreshBusy \? quotaRefreshAriaLabel : '重新读取本机与已授权的额度来源'\}/);
  assert.match(source, /刷新额度/);
  assert.match(source, /providerEmptyActionLabel/);
  assert.match(source, /providerEmptyStateLabel/);
  assert.match(source, /className=\{`quota-provider-state quota-provider-state-\$\{provider\.status\}`\}/);
  assert.match(source, /const actionAriaLabel = safeAction/);
  assert.match(source, /aria-label=\{actionAriaLabel \|\| undefined\}/);
  assert.match(css, /\.quota-panel-actions \.ghost-inline \{[\s\S]*white-space: nowrap/);
  assert.match(css, /\.quota-provider-empty-heading \{[\s\S]*flex-wrap: wrap/);
  assert.match(css, /\.quota-provider-state-auth-required \{[\s\S]*var\(--color-warning-subtle\)/);
  assert.match(css, /@media \(max-width: 340px\) \{[\s\S]*\.quota-provider-empty \{[\s\S]*grid-template-columns: 1fr/);
  assert.match(css, /@media \(max-width: 340px\) \{[\s\S]*\.quota-provider-empty button \{[\s\S]*justify-self: end/);
});

test('额度刷新在读取或同步期间暴露进行中状态并禁用重复点击', () => {
  const source = readSource(path.join(process.cwd(), 'src', 'components', 'QuotaPanel.tsx'));
  assert.match(source, /disabled=\{quotaRefreshBusy\}/);
  assert.match(source, /className=\{`h-4 w-4 \$\{quotaRefreshBusy \? 'animate-spin' : ''\}`\}/);
  assert.match(source, /\{quotaRefreshButtonLabel\}/);
});

test('额度待处理来源的复制动作暴露进行中状态并禁用重复触发', () => {
  const source = readSource(path.join(process.cwd(), 'src', 'components', 'QuotaPanel.tsx'));
  assert.match(source, /const \[actionBusy, setActionBusy\] = useState\(false\)/);
  assert.match(source, /if \(actionBusy\) return/);
  assert.match(source, /setActionBusy\(true\)/);
  assert.match(source, /finally \{[\s\S]*setActionBusy\(false\)/);
  assert.match(source, /aria-busy=\{actionBusy \|\| undefined\}/);
  assert.match(source, /disabled=\{actionBusy\}/);
  assert.match(source, /复制中…/);
  assert.match(source, /LoaderCircle className="h-3\.5 w-3\.5 animate-spin"/);
});

test('quota dashboard uses one continuous provider list with a shared two-column window grid', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const dashboard = css.slice(css.indexOf('  .quota-dashboard {'), css.indexOf('  .quota-pending-providers {'));
  assert.match(dashboard, /grid-template-columns: 1fr;/);
  assert.doesNotMatch(dashboard, /data-view-mode|rings|grid-column: span/);
  assert.match(css, /container: quota-panel \/ inline-size/);
  const windows = css.slice(css.indexOf('  .quota-window-list {'), css.indexOf('  .quota-window-gauge {'));
  assert.match(windows, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  const names = css.slice(css.indexOf('  .quota-window-head strong {'), css.indexOf('  .quota-window-meta {'));
  assert.match(names, /min-width: 0;[\s\S]*overflow-wrap: anywhere;[\s\S]*white-space: normal;/);
  assert.doesNotMatch(names, /line-clamp|overflow: hidden|max-height/);
  assert.doesNotMatch(css, /\.quota-dashboard\[data-view-mode='rings'\] \.quota-window-list/);
});

test('all quota sources retain the shared two-column grid without legacy company-only truncation', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const windows = css.slice(css.indexOf('  .quota-window-list {'), css.indexOf('  .quota-window-gauge {'));
  assert.match(windows, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.doesNotMatch(css, /\.quota-company-window-list|\.quota-company-window-head|\.quota-company-window-value/);
});

test('company quota providers keep their daily/monthly filter while using the shared card path', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'QuotaPanel.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.equal(isCompanyQuotaProvider('company-openapi-0123456789abcdef01234567'), true);
  assert.equal(isCompanyQuotaProvider('openai-codex-local'), false);
  assert.equal(companyQuotaWindowLabel('user-daily'), '今日可用额度');
  assert.equal(companyQuotaWindowLabel('user-monthly'), '本月可用额度');
  assert.equal(companyQuotaWindowLabel('key-daily'), null);
  assert.deepEqual(
    selectCompanyQuotaWindows([
      { windowId: 'user-monthly' },
      { windowId: 'key-daily' },
      { windowId: 'user-daily' },
    ]).map((window) => window.windowId),
    ['user-daily', 'user-monthly'],
  );
  assert.match(source, /data-provider-kind=\{companyProvider \? 'company' : 'standard'\}/);
  assert.match(source, /selectCompanyQuotaWindows\(presentationProvider\.windows\)/);
  assert.match(source, /groupQuotaWindows\(view\.companyProvider \? view\.companyWindows : view\.presentationProvider\.windows\)/);
  assert.match(source, /isCompanyQuotaProvider\(window\.providerId\) && rawValues\.kind !== 'percent'/);
  assert.doesNotMatch(css, /\.quota-company-window|\.quota-company-progress/);
});

test('all percentage quota meters expose localized available-value text', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'QuotaPanel.tsx'));
  assert.equal(
    (source.match(/aria-valuetext=\{remainingDisplay === null \? undefined : `\$\{remainingDisplay\}% 可用`\}/g) || []).length,
    1,
  );
});

test('quota presentation localizes known provider and window machine labels without guessing unknown labels', () => {
  assert.equal(providerDisplayName({
    providerId: 'openai-codex-local',
    displayName: 'Codex local usage',
  }), 'Codex');
  assert.equal(providerDisplayName({
    providerId: 'anthropic-claude-consumer',
    displayName: 'Claude consumer usage',
  }), 'Claude');
  assert.equal(providerDisplayName({
    providerId: 'google-antigravity-consumer',
    displayName: 'Antigravity consumer usage',
  }), 'Antigravity');

  const base = {
    providerId: 'openai-codex-local',
    windowId: 'primary',
    windowLabel: 'Primary',
    windowMinutes: 300,
    unit: 'percent',
    reasonCode: undefined,
  };
  assert.equal(quotaWindowDisplayLabel(base), '5 小时额度');
  assert.equal(quotaWindowDisplayLabel({
    ...base,
    windowId: 'secondary',
    windowLabel: 'Secondary',
    windowMinutes: 10_080,
  }), '每周额度');
  assert.equal(quotaWindowDisplayLabel({
    ...base,
    windowId: 'codex:primary',
    windowLabel: 'codex · Primary',
  }), '5 小时额度');
  assert.equal(quotaWindowDisplayLabel({
    ...base,
    windowId: 'codex:credits',
    windowLabel: 'codex · Credits',
    windowMinutes: undefined,
    unit: 'credits',
  }), '额外用量余额');
  assert.equal(quotaWindowDisplayLabel({
    ...base,
    windowId: 'codexbar-sonnet-weekly',
    windowLabel: 'Sonnet only',
    windowMinutes: 10_080,
  }), 'Sonnet only · 每周额度');
  assert.equal(quotaWindowDisplayLabel({
    ...base,
    providerId: 'google-antigravity-consumer',
    windowId: 'antigravity:gemini-weekly',
    windowLabel: 'Gemini weekly',
    windowMinutes: 10_080,
  }), 'Gemini · 每周额度');
  assert.equal(quotaWindowDisplayLabel({
    ...base,
    providerId: 'google-antigravity-consumer',
    windowId: 'antigravity:gemini-five-hour-localized',
    windowLabel: 'Gemini 5 小时额度',
    windowMinutes: 300,
  }), 'Gemini · 5 小时额度');
  assert.equal(quotaWindowDisplayLabel({
    ...base,
    providerId: 'google-antigravity-consumer',
    windowId: 'antigravity:claude-five-hour',
    windowLabel: 'Claude/GPT 5-hour',
    windowMinutes: 300,
  }), 'Claude/GPT · 5 小时额度');
  assert.equal(quotaWindowDisplayLabel({
    ...base,
    windowId: 'codex:secondary',
    windowLabel: 'codex_bengalfox',
    windowMinutes: 10_080,
  }), 'codex_bengalfox · 每周额度');
  assert.equal(quotaWindowDisplayLabel({
    ...base,
    windowId: 'manual:2026-07',
    windowLabel: 'July budget',
    windowMinutes: undefined,
    unit: 'usd',
  }), 'July budget');
});

test('quota snapshots become stale in an open window and refresh on a bounded cadence', () => {
  const panel = readSource(
    path.join(process.cwd(), 'src', 'components', 'QuotaPanel.tsx'));
  const app = [
    readSource(path.join(process.cwd(), 'src', 'App.tsx')),
    readSource(path.join(process.cwd(), 'src', 'hooks', 'useQuota.ts')),
  ].join('\n');
  assert.match(panel, /now >= observedAt \+ window\.staleAfterSeconds \* 1_000/);
  assert.match(panel, /window\.status === 'ok' && \(staleByAge \|\| staleByReset\)/);
  assert.match(app, /window\.setInterval\(refreshVisibleQuotas, QUOTA_AUTO_REFRESH_INTERVAL_MS\)/);
  assert.match(app, /document\.addEventListener\('visibilitychange', refreshVisibleQuotas\)/);
  assert.match(app, /quotaLastRequestedAt\.current = Date\.now\(\)/);
  assert.match(app, /const command = retrySecureStorage/);
  assert.match(app, /'retry_quota_providers' : 'retry_local_quota_providers'/);
  assert.match(app, /'get_quota_providers' : 'get_local_quota_providers'/);
  assert.match(app, /const providers = parseQuotaProviderEnvelopes\(response\);[\s\S]*?setQuotaProviders\(providers\)/);

  const interval = 5 * 60_000;
  assert.equal(shouldRefreshVisibleQuotas('hidden', 1, interval + 1, interval), false);
  assert.equal(shouldRefreshVisibleQuotas('visible', 0, 1, interval), true);
  assert.equal(shouldRefreshVisibleQuotas('visible', 1, interval, interval), false);
  assert.equal(shouldRefreshVisibleQuotas('visible', 1, interval + 1, interval), true);
  assert.equal(shouldRefreshVisibleQuotas('visible', interval, 1, interval), true);
});

test('settings switches expose their visible labels to assistive technology', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'SettingsPrimitives.tsx'));
  const toggle = source.slice(source.indexOf('function SettingsToggleRow'), source.indexOf('function SettingsActionRow'));
  assert.match(toggle, /const actionLabel = busy \? `\$\{label\}，保存中` : label/);
  assert.match(toggle, /role="switch"[\s\S]*aria-label=\{actionLabel\}[\s\S]*aria-describedby=\{hint \? hintId : undefined\}[\s\S]*aria-checked=\{checked\}/);
  assert.match(toggle, /aria-busy=\{busy \|\| undefined\}/);
  assert.match(toggle, /settings-toggle-feedback[\s\S]*保存中…/);
});

test('settings switches share the saved-state busy signal across system and quota sections', () => {
  const source = [
    'SettingsPrimitives.tsx',
    'ScanStartupSection.tsx',
    'WallpaperSection.tsx',
    'QuotaSection.tsx',
  ].map((file) => readSource(path.join(process.cwd(), 'src', 'components', 'settings', file))).join('\n');
  assert.match(source, /className=\"settings-toggle-control\"/);
  assert.match(source, /busy=\{busy\.settings\}/);
  assert.match(source, /settings-toggle-feedback/);
  assert.match(readSource(path.join(process.cwd(), 'src', 'index.css')), /\.settings-toggle-feedback \{[\s\S]*white-space: nowrap/);
});

test('settings form fields expose explicit accessible names', () => {
  const sources = [
    'CloudAccountSection.tsx',
    'ScanStartupSection.tsx',
    'WallpaperSection.tsx',
    'DataHelpSection.tsx',
    'PricingSection.tsx',
  ].map((file) => readSource(path.join(process.cwd(), 'src', 'components', 'settings', file)));
  const source = sources.join('\n');
  for (const label of [
    'Supabase URL',
    'Publishable Key',
    '邮箱',
    '密码',
    '扫描间隔（秒）',
    '桌面壁纸刷新间隔（秒）',
    '锁屏壁纸刷新间隔（秒）',
    '壁纸统计设备范围',
    '清理截止日期',
    '模型价格 JSON',
  ]) {
    assert.match(source, new RegExp(`aria-label="${label}"`), `missing accessible name: ${label}`);
  }
});

test('settings section focus cue stays on the destination heading', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(css, /\.settings-section:focus-visible \{[\s\S]*outline: none;/);
  assert.match(css, /\.settings-section:focus-visible > \.settings-section-title \{[\s\S]*outline: 2px solid var\(--color-primary\);/);
  assert.match(css, /\.settings-section:focus-visible > \.settings-section-title,[\s\S]*outline: 2px solid Highlight !important;/);
});

test('a direct settings hash opens the settings tab before lazy content mounts', () => {
  const app = readSource(path.join(process.cwd(), 'src', 'App.tsx'));
  assert.match(app, /function initialTabFromLocation\(\): Tab/);
  assert.match(app, /window\.location\.hash\.startsWith\('#settings-'\) \? 'settings' : 'dashboard'/);
  assert.match(app, /useState<Tab>\(\(\) => initialTabFromLocation\(\)\)/);
});

test('persistent shell exposes a keyboard skip link to the scrollable main content', () => {
  const app = readSource(path.join(process.cwd(), 'src', 'App.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(app, /className="skip-link"[\s\S]*onClick=\{handleSkipToMainContent\}[\s\S]*onKeyDown=\{handleSkipToMainContentKeyDown\}/);
  assert.match(app, /content\.scrollTo\(\{ top: 0, left: 0, behavior: 'auto' \}\)/);
  assert.match(app, /content\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(app, /<section id="main-content" ref=\{contentRef\} className="app-content tl-scrollbar" tabIndex=\{-1\} aria-label="主要内容">/);
  assert.match(css, /\.skip-link \{[\s\S]*position: fixed;[\s\S]*transform: translateY\(calc\(-100% - 16px\)\);/);
  assert.match(css, /\.skip-link:focus-visible \{[\s\S]*transform: translateY\(0\);/);
});

test('desktop settings cards and loading states expose their information hierarchy', () => {
  const primitives = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'SettingsPrimitives.tsx'));
  const dashboard = readSource(path.join(process.cwd(), 'src', 'components', 'DashboardTab.tsx'));
  const logs = readSource(path.join(process.cwd(), 'src', 'components', 'LogsTable.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(primitives, /title && <h3 className="settings-card-title">\{title\}<\/h3>/);
  assert.match(dashboard, /className="content-stack" role="status" aria-label="正在加载看板" aria-busy="true"/);
  assert.match(logs, /className="details-state" role="status" aria-live="polite"/);
  assert.match(css, /\.settings-card-title \{[\s\S]*margin: 0 0 0 4px;/);
  assert.match(css, /\.settings-nav-status \{[\s\S]*border-radius: var\(--radius-full\);/);
  assert.match(css, /\.settings-nav-status-attention \{[\s\S]*background: var\(--color-warning-subtle\);/);
});

test('desktop settings directory preserves destination labels beside state chips', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(css, /\.settings-nav \{[\s\S]*flex:\s*0 0 184px;/);
  assert.match(css, /\.settings-nav-shell \{[\s\S]*flex:\s*0 0 184px;/);
  assert.match(css, /“数据与帮助”/);
});

test('data management actions expose action-specific busy feedback', () => {
  const dataHelp = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'DataHelpSection.tsx'));
  assert.match(dataHelp, /type DataAction = 'export' \| 'reset' \| 'refresh' \| 'cleanup' \| 'reclaim';/);
  assert.match(dataHelp, /if \(activeAction !== null \|\| busy\.db\) return;/);
  // T10.105c：空间回收与其它数据库动作共用同一把互斥锁与忙碌反馈。
  assert.match(dataHelp, /aria-busy=\{actionBusy\('reclaim'\) \|\| undefined\}/);
  assert.match(dataHelp, /activeAction === 'reclaim' \? '回收中…' : '回收空间'/);
  assert.match(dataHelp, /<SettingsActionRow busy=\{busy\.db \|\| activeAction !== null\}>/);
  assert.match(dataHelp, /aria-busy=\{actionBusy\('export'\) \|\| undefined\}/);
  assert.match(dataHelp, /activeAction === 'export' \? '导出中…' : '导出 CSV'/);
  assert.match(dataHelp, /activeAction === 'cleanup' \? '清理中…' : '清理旧数据'/);
});

test('detail filter actions preserve the shared 44px touch target', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(css, /\.detail-option-footer button,[\s\S]*\.detail-search-submit \{[\s\S]*min-block-size: 44px;/);
  assert.match(css, /\.detail-search-input input \{[\s\S]*?min-block-size: 44px;/);
  assert.match(css, /\.detail-search-input > button:not\(\.detail-search-submit\),[\s\S]*\.detail-option-search button \{[\s\S]*?min-block-size: 44px;/);
});

test('detail filter disabled actions preserve neutral legibility', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(css, /\.detail-filter-heading-actions > \.ghost-inline:disabled \{[\s\S]*color: var\(--color-text-tertiary\);[\s\S]*opacity: 1;/);
  assert.match(css, /\.detail-search-submit:disabled \{[\s\S]*border: 1px solid var\(--color-border\);[\s\S]*background: var\(--color-bg-elevated\);[\s\S]*color: var\(--color-text-tertiary\);[\s\S]*opacity: 1;/);
});

test('phone detail filters default to a collapsed result-first frame', () => {
  const logs = readSource(path.join(process.cwd(), 'src', 'components', 'LogsTable.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(logs, /const \[mobileFiltersOpen, setMobileFiltersOpen\] = useState\(false\);/);
  assert.match(logs, /className="detail-filter-toggle"[\s\S]*aria-expanded=\{mobileFiltersOpen\}[\s\S]*aria-controls="detail-filter-controls"/);
  assert.match(logs, /id="detail-filter-controls" className="detail-filter-grid"/);
  assert.match(css, /\.detail-filter-toggle \{[\s\S]*min-height:\s*44px;/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.detail-filter-panel:not\(\.is-mobile-filters-open\) \.detail-filter-grid \{[\s\S]*display:\s*none;/);
});

test('dashboard completion and freshness labels share a full local date-time format', () => {
  const format = readSource(path.join(process.cwd(), 'src', 'utils', 'format.ts'));
  const dashboard = readSource(path.join(process.cwd(), 'src', 'components', 'DashboardTab.tsx'));
  const stats = readSource(path.join(process.cwd(), 'src', 'hooks', 'useStats.ts'));
  assert.match(format, /export function formatLocalDateTime\(value: string \| Date\)/);
  assert.match(format, /year: 'numeric'/);
  assert.match(format, /second: '2-digit'/);
  assert.match(dashboard, /formatLocalDateTime\(value\)/);
  assert.match(dashboard, /完成于 \{formatLocalDateTime\(refreshCompletedAt\)\}/);
  assert.match(stats, /formatLocalDateTime\(completedAt\)/);
});

test('disabled settings actions remove the primary affordance and explain the next step', () => {
  const cloud = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'CloudAccountSection.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(cloud, /aria-describedby=\{firstSyncHintId\}/);
  assert.match(cloud, /className="settings-action-note" id=\{firstSyncHintId\}/);
  assert.match(css, /\.primary-inline:disabled \{[\s\S]*background: var\(--color-bg-elevated\);[\s\S]*color: var\(--color-text-tertiary\);/);
  assert.match(css, /\.secondary-inline:disabled \{[\s\S]*background: var\(--color-bg-elevated\);/);
  assert.match(css, /\.settings-action-note::before \{[\s\S]*content: "下一步：";/);
});

test('phone cloud setup keeps the next verification action in the first viewport', () => {
  const cloud = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'CloudAccountSection.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(cloud, /登录云端账户/);
  assert.match(cloud, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/);
  assert.match(cloud, /ref=\{emailInputRef\}/);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*?\.cloud-setup-steps li \{[\s\S]*?min-height:\s*44px;[\s\S]*?padding-block:\s*2px;/);
  assert.match(css, /@media \(max-width: 340px\)[\s\S]*?#settings-cloud > \.settings-card:first-of-type > \.cloud-setup-steps \{[\s\S]*?order:\s*2/);
  assert.match(css, /@media \(max-width: 340px\)[\s\S]*?#settings-cloud > \.settings-card:first-of-type > \.settings-action-row \{[\s\S]*?order:\s*1/);
});

test('云端同步主动作会随首次同步完成状态切换文案', () => {
  const cloud = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'CloudAccountSection.tsx'));
  assert.match(cloud, /firstSyncActionLabel\(props\.setup, props\.busy\.sync\)/);
  assert.match(cloud, /firstSyncCompleted \? '同步最新数据' : '执行首次同步'/);
});

test('云端连接动作在验证或同步期间暴露进行中语义并统一入口文案', () => {
  const cloud = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'CloudAccountSection.tsx'));
  const primitives = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'SettingsPrimitives.tsx'));
  assert.match(cloud, /const capabilityBusy = props\.setup\.validating;/);
  assert.match(cloud, /const capabilityButtonLabel = capabilityBusy \? '验证中…' : capabilityActionLabel\(props\.setup\);/);
  assert.match(cloud, /aria-label=\{capabilityButtonAriaLabel\}/);
  assert.match(cloud, /aria-busy=\{capabilityBusy \|\| undefined\}/);
  assert.match(cloud, /disabled=\{!props\.setup\.authenticated \|\| capabilityBusy \|\| props\.busy\.sync\}/);
  assert.match(cloud, /className=\{`h-4 w-4 \$\{capabilityBusy \? 'animate-pulse' : ''\}`\}/);
  assert.match(cloud, /<SettingsActionRow busy=\{capabilityBusy \|\| props\.busy\.sync\}>/);
  assert.match(cloud, /const firstSyncButtonAriaLabel = props\.busy\.sync/);
  assert.match(cloud, /aria-label=\{firstSyncButtonAriaLabel\}/);
  assert.match(cloud, /const quickSyncButtonLabel = props\.busy\.sync \? '同步中…' : '立即同步';/);
  assert.match(cloud, /aria-label=\{quickSyncButtonAriaLabel\}/);
  assert.match(cloud, /\{quickSyncButtonLabel\}/);
  assert.match(primitives, /settings-action-row" aria-busy=\{busy \|\| undefined\}/);
});

test('云端账户与连接配置动作在提交期间暴露进行中语义', () => {
  const cloud = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'CloudAccountSection.tsx'));
  assert.match(cloud, /const configButtonLabel = props\.busy\.config \? '保存中…' : '保存配置';/);
  assert.match(cloud, /aria-label=\{configButtonAriaLabel\}/);
  assert.match(cloud, /aria-busy=\{props\.busy\.config \|\| undefined\}/);
  assert.match(cloud, /\{props\.busy\.config && <RefreshCw className="h-4 w-4 animate-spin" \/>\}/);
  assert.match(cloud, /<SettingsActionRow busy=\{props\.busy\.config \|\| props\.busy\.sync\}>/);
  assert.match(cloud, /type AuthAction = 'sign-in' \| 'sign-up' \| 'sign-out';/);
  assert.match(cloud, /const \[activeAuthAction, setActiveAuthAction\] = useState<AuthAction \| null>\(null\);/);
  assert.match(cloud, /const authActionBusy = \(action: AuthAction\) => props\.busy\.auth && activeAuthAction === action;/);
  assert.match(cloud, /const runAuthAction = \(action: AuthAction, callback: \(\) => void\) =>/);
  assert.match(cloud, /aria-label=\{signInBusy \? '正在登录云端账户' : '登录'\}/);
  assert.match(cloud, /aria-label=\{signUpBusy \? '正在注册云端账户' : '注册'\}/);
  assert.match(cloud, /aria-label=\{signOutBusy \? '正在退出云端账户' : '退出云端账户'\}/);
  assert.match(cloud, /\{signInBusy \? '登录中…' : '登录'\}/);
  assert.match(cloud, /\{signUpBusy \? '注册中…' : '注册'\}/);
  assert.match(cloud, /\{signOutBusy \? '退出中…' : '退出'\}/);
  assert.match(cloud, /<SettingsActionRow busy=\{props\.busy\.auth\}>/);
});

test('top bar status changes are announced without making action buttons live content', () => {
  const sidebar = readSource(path.join(process.cwd(), 'src', 'components', 'Sidebar.tsx'));
  assert.match(sidebar, /className="topbar-status"[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*aria-atomic="true"/);
  assert.doesNotMatch(sidebar, /className="topbar-actions"[^>]*role="status"/);
});

test('top bar scan action exposes a visible and accessible busy state', () => {
  const sidebar = readSource(path.join(process.cwd(), 'src', 'components', 'Sidebar.tsx'));
  assert.match(sidebar, /const scanActionAriaLabel = busy\.scan \? '正在扫描本地各 AI 工具日志' : '扫描本地日志';/);
  assert.match(sidebar, /aria-label=\{scanActionAriaLabel\}[\s\S]*disabled=\{busy\.scan\}[\s\S]*aria-busy=\{busy\.scan \|\| undefined\}/);
  assert.match(sidebar, /aria-label=\{scanActionAriaLabel\}[\s\S]*data-tooltip=\{scanActionTitle\}/);
  assert.match(sidebar, /<RefreshCw className=\{`h-4 w-4 \$\{busy\.scan \? 'animate-spin' : ''\}`\}/);
});

test('看板同步与恢复入口共享进行中语义', () => {
  const dashboard = readSource(path.join(process.cwd(), 'src', 'components', 'DashboardTab.tsx'));
  assert.match(dashboard, /const cloudSyncButtonAriaLabel = syncBusy/);
  assert.match(dashboard, /const cloudSyncDisabledReasonText = scope === 'cloud'/);
  assert.match(dashboard, /aria-describedby=\{cloudSyncDescriptionId\}/);
  assert.match(dashboard, /id="cloud-sync-recovery" role="status"/);
  assert.match(dashboard, /aria-busy=\{syncBusy \|\| undefined\}/);
  assert.match(dashboard, /aria-busy=\{statsRecoveryBusy \|\| undefined\}/);
  assert.match(dashboard, /const dashboardRefresh = dashboardRefreshCopy\(\{ scope, statsLoading, scanBusy, syncBusy \}\);/);
  assert.match(dashboard, /aria-busy=\{dashboardRefresh\.busy \|\| undefined\}/);
  assert.match(dashboard, /className=\{`h-4 w-4 \$\{dashboardRefresh\.busy \? 'animate-spin' : ''\}`\}/);
});

test('保留旧画面时页头提示的范围写法与顶栏范围控件一致（T10.181 R-46，GLB-01）', () => {
  const header = readSource(path.join(process.cwd(), 'src', 'components', 'RangeControls.tsx'));
  const optionsStart = header.indexOf('const RANGE_OPTIONS');
  const options = [...header.slice(optionsStart, header.indexOf('];', optionsStart)).matchAll(/\['(\w+)', '([^']+)'\]/g)];
  assert.equal(options.length, 5);
  for (const [, key, label] of options) assert.equal(rangeControlLabel(key, null), label, `${key} 与范围控件不同写法`);
  assert.match(header, /const customRangeLabel = customRange \? formatCustomRangeLabel\(customRange\.start, customRange\.end\) : '自定义';/);
  assert.equal(rangeControlLabel('custom', { start: '2026-07-08', end: '2026-07-14' }), '7月8日—7月14日');
  assert.equal(rangeControlLabel('custom', null), '自定义');
  assert.equal(heldRangeNoticeCopy('本周', '今日'), '正在加载「本周」，下方暂为「今日」的数据');
  // 提示行放在页头标题旁常驻的 role="status" 里（有数据与空状态两个分支都有），沿用 .page-subtitle，不加新样式。
  // T10.200：标题与提示同一行、按基线对齐（Tailwind 工具类），用页头右侧按钮已撑出的高度，出现时下方内容不再下移；
  // 空状态的说明文字留在这一行下面，位置同样不动。
  const dashboard = readSource(path.join(process.cwd(), 'src', 'components', 'DashboardTab.tsx'));
  assert.match(dashboard, /const heldRangeStatus = \(\n\s*<div role="status">\n\s*\{heldRangeNotice \? <p className="page-subtitle">\{heldRangeNotice\}<\/p> : null\}/);
  // T10.306f：外层用量页提供可见标题；独立看板保留隐藏标题，范围提示与上下文位置不变。
  const headingWithContext = /\{!hasPageTitle && <h1 className="sr-only">Token 使用看板<\/h1>\}\n\s*<DashboardContextBar[\s\S]{0,400}?\/>\n\s*\{heldRangeStatus\}\n\s*<\/div>/g;
  assert.equal((dashboard.match(headingWithContext) || []).length, 2);
  assert.match(dashboard, /<div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">\n\s*\{!hasPageTitle && <h1 className="sr-only">Token 使用看板<\/h1>\}/);
  assert.match(dashboard, /<div className="flex flex-wrap items-baseline gap-x-3">\n\s*\{!hasPageTitle && <h1 className="sr-only">Token 使用看板<\/h1>\}/);
  assert.doesNotMatch(dashboard, /额度状态不依赖消耗记录/);
});

test('看板查询身份由 App 按口径、设备与云端账户接给 DashboardTab（T10.200，T10.181 R-46 P3-4）', () => {
  const app = readSource(path.join(process.cwd(), 'src', 'App.tsx'));
  const dashboardProps = app.slice(app.indexOf('<DashboardTab'), app.indexOf('<BehaviorAnalysisView'));
  assert.match(dashboardProps, /queryIdentity=\{dashboardQueryIdentity\(statsHook\.dataScope, statsHook\.deviceFilter, cloud\.cloudIdentity\)\}/);
  assert.match(app, /import \{ DashboardTab, dashboardQueryIdentity \} from '\.\/components\/DashboardTab';/);
});

test('看板恢复动作按失败种类给出且都有 44px 目标（T10.200，T10.185 评审 P3-5）', () => {
  const dashboard = readSource(path.join(process.cwd(), 'src', 'components', 'DashboardTab.tsx'));
  const header = readSource(path.join(process.cwd(), 'src', 'components', 'RangeControls.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  // 错误面板与两处恢复横幅共用同一份按种类的动作，不再各自写死「重试、重新登录、临时查看本机」。
  assert.equal((dashboard.match(/\{renderStatsRecoveryActions\('(?:panel|banner)'\)\}/g) || []).length, 3);
  assert.doesNotMatch(dashboard, /onClick=\{onRelogin\}>重新登录<\/button>/);
  // 「选择预设范围」把焦点移到范围控件：选择器依赖 RangeControl 这一组的无障碍名称。
  assert.match(dashboard, /const RANGE_CONTROL_GROUP_SELECTOR = '\[role="group"\]\[aria-label="统计时间范围"\]';/);
  assert.match(header, /className="segmented range-control tl-seg" role="group" aria-label="统计时间范围"/);
  // 动作只用这三种按钮类，它们在触控下限列表里（min-block-size: 44px）。
  assert.match(dashboard, /\? variant === 'panel' \? 'primary-inline' : 'secondary-inline'\n\s*: action === 'view-local' \? 'ghost-inline' : 'secondary-inline';/);
  assert.match(css, /\n\.nav-item,\n\.primary-inline,\n\.secondary-inline,\n\.ghost-inline,[^{]*\{\n\s*min-block-size: 44px;/);
});

test('明细加载、搜索和分页入口共享进行中语义', () => {
  const logs = readSource(path.join(process.cwd(), 'src', 'components', 'LogsTable.tsx'));
  assert.match(logs, /const detailRetry = detailActionCopy\('retry', loading\);/);
  assert.match(logs, /const detailSearch = detailActionCopy\('search', loading\);/);
  assert.match(logs, /const detailLoadMore = detailActionCopy\('loadMore', loadingMore\);/);
  assert.match(logs, /aria-busy=\{detailSearch\.busy \|\| undefined\}/);
  assert.match(logs, /aria-busy=\{detailRetry\.busy \|\| undefined\}/);
  assert.match(logs, /aria-busy=\{detailLoadMore\.busy \|\| undefined\}/);
  assert.match(logs, /detailLoadMore\.busy \? <LoaderCircle className="h-4 w-4 animate-spin" \/>/);
  assert.match(logs, /detailRetry\.busy \? 'animate-spin' : ''/);
});

test('cloud sync entry points share the Stats v2 capability gate', () => {
  const app = readSource(path.join(process.cwd(), 'src', 'App.tsx'));
  const sidebar = readSource(path.join(process.cwd(), 'src', 'components', 'Sidebar.tsx'));
  const dashboard = readSource(path.join(process.cwd(), 'src', 'components', 'DashboardTab.tsx'));
  const cloud = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'CloudAccountSection.tsx'));
  assert.match(app, /const triggerCloudSync = useCallback\(async \(\) => \{/);
  assert.match(app, /if \(!syncCloudStatusKnown\) \{[\s\S]*?await syncRefreshCloudStatus\(true\)/);
  assert.match(app, /if \(!capabilityVerified\)/);
  assert.match(sidebar, /cloudCapabilityVerified/);
  assert.match(sidebar, /disabled=\{syncDisabled\}/);
  assert.match(dashboard, /先验证 Stats v2，再同步本机数据/);
  assert.match(dashboard, /const cloudSyncDisabled = syncBusy \|\| !cloudAuthenticated \|\| !cloudCapabilityVerified/);
  assert.match(dashboard, /cloudSyncRecoveryCopy/);
  assert.match(app, /cloudAuthenticated=\{cloud\.cloudStatus\.authenticated\}/);
  assert.match(cloud, /!props\.setup\.capabilityVerified/);
});

test('top bar segments and icon actions preserve a 44px target (GLB-03)', () => {
  const shell = readSource(path.join(process.cwd(), 'src', 'styles', 'shell.css'));
  const sidebar = readSource(path.join(process.cwd(), 'src', 'components', 'Sidebar.tsx'));
  assert.match(shell, /\.topbar-nav > button,\n\.usage-subnav > button \{[^}]*min-height: 44px;/);
  assert.match(shell, /\.topbar-icon-btn,\n\.topbar-text-btn \{[^}]*min-height: 44px;/);
  assert.match(shell, /\.topbar-icon-btn,\n\.topbar-text-btn \{[^}]*min-width: 44px;/);
  assert.match(shell, /\n\.topbar-icon-btn \{\n  width: 44px;/);
  const surfaces = readSource(path.join(process.cwd(), 'src', 'styles', 'surfaces.css'));
  assert.match(surfaces, /\n\.app-header \.theme-toggle \{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
  // Enabled model-page switches keep a readable thumb on the pale dark-theme fill.
  assert.match(surfaces, /\.app-shell \.mw-switch\.is-on span \{[^}]*background: var\(--color-text-on-primary\);/);
  // The actions column never shrinks under its content, so it cannot overlap the switch.
  assert.match(shell, /\n\.app-topbar \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(max-content, 1fr\);/);
  // The visible thumb, track and hover fill are drawn inset, not the hit area.
  assert.match(shell, /--seg-inset-y: 8px;/);
  assert.match(shell, /\.topbar-icon-btn::after,\n\.topbar-text-btn::after \{[^}]*inset: 8px 7px;/);
  assert.match(sidebar, /role="group" aria-label="快捷工具与战报"/);
  assert.match(sidebar, /aria-label="生成数据战报卡片"[\s\S]*title="生成数据战报卡片"/);
  assert.match(sidebar, /aria-label=\{wallpaperBusy \? '正在设置桌面壁纸' : '一键设置桌面壁纸'\}/);
  assert.match(sidebar, /aria-label=\{wallpaperBusy \? '正在设置锁屏壁纸' : '一键设置锁屏壁纸'\}/);
  assert.match(sidebar, /className="topbar-status-label" aria-hidden="true"/);
  assert.match(sidebar, /title=\{cloudStatusLabel\}/);
  assert.match(sidebar, /aria-label=\{syncActionAriaLabel\}[\s\S]*data-tooltip=\{syncActionTitle\}/);
  assert.match(sidebar, /aria-label=\{syncRecoveryAriaLabel\}[\s\S]*data-tooltip=\{syncRecoveryLabel\}/);
  assert.match(sidebar, /id="sidebar-sync-recovery-hint"/);
});

test('侧栏紧凑布局：二级入口统一 44px，快捷工具桌面并排，恢复原因只留给读屏（T10.300e）', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const sidebar = readSource(path.join(process.cwd(), 'src', 'components', 'Sidebar.tsx'));
  assert.match(css, /\.app-sidebar \.nav-sub-item \{[^}]*min-height: 44px;[^}]*min-block-size: 44px;/);
  assert.match(css, /@media \(min-width: 861px\) \{\n  \.sidebar-tools \{[^}]*grid-auto-flow: column;/);
  assert.match(css, /\.sidebar-tools\[data-tool-count="3"\] \.sidebar-tool-item > span \{[^}]*clip-path: inset\(50%\);/);
  assert.match(css, /\n\.app-sidebar \.sidebar-sync-recovery-hint \{[^}]*position: absolute;[^}]*clip-path: inset\(50%\);/);
  assert.match(sidebar, /id="sidebar-sync-recovery-hint"/);
});

test('顶栏底色：浏览器不透明，只有原生 macOS 窗口标记毛玻璃（T10.277 延续）', () => {
  const shell = readSource(path.join(process.cwd(), 'src', 'styles', 'shell.css'));
  const sidebar = readSource(path.join(process.cwd(), 'src', 'components', 'Sidebar.tsx'));
  assert.match(shell, /\n\.app-topbar \{[^}]*background: var\(--color-bg-page\);/);
  assert.match(shell, /\.app-topbar\[data-vibrancy="native"\] \{[^}]*background: var\(--color-bg-header\);/);
  // macOS Overlay titlebar: the brand clears the window controls.
  assert.match(shell, /:root\[data-platform='macos'\] \.app-topbar \{[^}]*padding-left: 84px;/);
  assert.match(sidebar, /data-vibrancy=\{nativeVibrancy \? 'native' : undefined\}/);
  assert.match(sidebar, /internals\?\.metadata\?\.currentWindow\?\.label/);
});

test('danger settings actions preserve the shared 44px touch target', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(css, /\.primary-inline,[\s\S]*\.ghost-inline,[\s\S]*\.danger-inline,[\s\S]*\.modal-close,[\s\S]*min-block-size:\s*44px;/);
});

test('share modal actions preserve a 44px hit target', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(css, /\.share-modal-close,[\s\S]*\.detail-multiselect-trigger,[\s\S]*min-block-size:\s*44px;/);
  assert.match(css, /\.share-action-copy,\s*\.share-action-download\s*\{[\s\S]*min-block-size:\s*44px;/);
  assert.match(css, /\.modal-close,\s*\.share-modal-close,[\s\S]*min-inline-size:\s*44px;/);
});

test('price search inputs preserve the shared 44px hit target', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(css, /\.price-search input\s*\{[\s\S]*min-block-size:\s*44px;/);
  assert.match(css, /\.models-dev-search-input\s*\{[\s\S]*min-block-size:\s*44px;/);
});

test('phone page actions do not squeeze into vertical labels beside the heading', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const phoneBlock = css.slice(css.indexOf('@media (max-width: 600px)'));
  assert.match(phoneBlock, /\.page-heading \{[\s\S]*align-items:\s*stretch;[\s\S]*flex-direction:\s*column;/);
  assert.match(phoneBlock, /\.dashboard-refresh-status \{[\s\S]*display:\s*flex;[\s\S]*width:\s*100%;/);
  assert.match(phoneBlock, /\.dashboard-refresh-status \.secondary-inline \{[\s\S]*white-space:\s*nowrap;/);
});

test('phone trend comparison cards keep current values readable', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const phoneBlock = css.slice(css.indexOf('@media (max-width: 600px)'));
  assert.match(phoneBlock, /\.comparison-kpi-main \{[\s\S]*align-items:\s*flex-start;[\s\S]*flex-direction:\s*column;/);
  assert.match(phoneBlock, /\.comparison-kpi-main > b \{[\s\S]*overflow:\s*visible;[\s\S]*white-space:\s*normal;/);
  assert.match(phoneBlock, /\.comparison-kpi small \{[\s\S]*overflow:\s*visible;[\s\S]*white-space:\s*normal;/);
});

test('phone model ranking exposes every drilldown item without a hidden scrollbar', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const modelCost = readSource(path.join(process.cwd(), 'src', 'components', 'ModelCostDistributionPanel.tsx'));
  const phoneBlock = css.slice(css.lastIndexOf('@media (max-width: 600px)'));
  assert.match(css, /\.chart-access-list button \{[\s\S]*flex:\s*1 1 0;/);
  assert.match(phoneBlock, /\.chart-access-list \{[\s\S]*display:\s*grid;[\s\S]*overflow-x:\s*visible;/);
  assert.match(phoneBlock, /\.model-ranking-panel \{[\s\S]*height:\s*auto;[\s\S]*min-height:\s*0;/);
  assert.match(phoneBlock, /\.model-ranking-panel \.chart-fill \{[\s\S]*flex:\s*0 0 220px;[\s\S]*min-height:\s*220px;/);
  assert.match(phoneBlock, /\.chart-access-list button \{[\s\S]*width:\s*100%;/);
  assert.match(phoneBlock, /\.chart-access-list button span \{[\s\S]*white-space:\s*normal;/);
  assert.match(phoneBlock, /\.model-cost-row-btn \{[\s\S]*display:\s*grid;[\s\S]*grid-template-areas:/);
  assert.match(phoneBlock, /\.model-cost-name \{[\s\S]*overflow-wrap:\s*anywhere;/);
  // T10.154 D27：副标题换成统一叫法，未知仍排最后、不按 0 处理。
  assert.match(modelCost, /按预估费用排序 · 不可得的排在最后 · 展开行查看缓存构成/);
  assert.match(modelCost, /LayoutDashboard[\s\S]*model-cost-drilldown-label/);
  assert.match(css, /\.model-cost-drilldown-btn \{[\s\S]*min-width:\s*64px;[\s\S]*min-height:\s*44px;/);
  assert.match(css, /\.model-cost-row-btn\s*\{[\s\S]*min-block-size:\s*44px;/);
  assert.match(css, /\.model-cost-drilldown-label \{[\s\S]*font-size:\s*11px;/);
  assert.match(phoneBlock, /\.model-cost-row-btn > svg \{\s*display:\s*none;/);
  assert.match(phoneBlock, /\.model-cost-row-btn \{[\s\S]*grid-template-columns:\s*20px minmax\(0, 1fr\) auto;[\s\S]*"rank name amount"/);
  assert.match(phoneBlock, /\.model-cost-drilldown-btn \{[\s\S]*width:\s*44px;[\s\S]*min-width:\s*44px;[\s\S]*padding:\s*0;/);
  assert.match(phoneBlock, /\.model-cost-drilldown-label \{\s*display:\s*none;/);
});

test('desktop model ranking keeps long IDs distinguishable in the drilldown list', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const desktopBlock = css.slice(css.indexOf('@media (min-width: 601px)'));
  assert.match(desktopBlock, /\.chart-access-list button span \{[\s\S]*display:\s*-webkit-box;[\s\S]*-webkit-line-clamp:\s*2;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*white-space:\s*normal;[\s\S]*line-height:\s*1\.25;/);
});

test('desktop model cost distribution keeps long IDs readable before drilldown', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const modelCost = readSource(path.join(process.cwd(), 'src', 'components', 'ModelCostDistributionPanel.tsx'));
  const desktopBlock = css.slice(css.indexOf('@media (min-width: 601px)'));
  const phoneBlock = css.slice(css.lastIndexOf('@media (max-width: 600px)'));
  assert.match(desktopBlock, /\.model-cost-name \{[\s\S]*display:\s*-webkit-box;[\s\S]*-webkit-line-clamp:\s*2;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*white-space:\s*normal;[\s\S]*line-height:\s*1\.3;/);
  assert.match(phoneBlock, /\.model-cost-name \{[\s\S]*display:\s*block;[\s\S]*overflow:\s*visible;[\s\S]*white-space:\s*normal;[\s\S]*-webkit-line-clamp:\s*unset;/);
  assert.match(modelCost, /className="model-cost-name"/);
});

test('entity recent records keep long model IDs readable across viewport sizes', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const entityModal = readSource(path.join(process.cwd(), 'src', 'components', 'EntityDashboardModal.tsx'));
  const desktopBlock = css.slice(css.indexOf('.entity-recent-model'));
  const phoneBlock = css.slice(css.lastIndexOf('@media (max-width: 600px)'));
  assert.match(desktopBlock, /\.entity-recent-model\s*\{[\s\S]*display:\s*-webkit-box;[\s\S]*-webkit-line-clamp:\s*2;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*white-space:\s*normal;[\s\S]*line-height:\s*1\.3;/);
  assert.match(phoneBlock, /\.entity-recent-model\s*\{[\s\S]*display:\s*block;[\s\S]*overflow:\s*visible;[\s\S]*white-space:\s*normal;[\s\S]*-webkit-line-clamp:\s*unset;/);
  assert.match(entityModal, /className="entity-recent-model" title=\{item\.model\}/);
});

test('entity composition lists keep long identity values readable across viewport sizes', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const entityModal = readSource(path.join(process.cwd(), 'src', 'components', 'EntityDashboardModal.tsx'));
  const desktopBlock = css.slice(css.indexOf('.entity-composition-row strong'));
  const phoneBlock = css.slice(css.lastIndexOf('@media (max-width: 600px)'));
  assert.match(desktopBlock, /\.entity-composition-row strong\s*\{[\s\S]*display:\s*-webkit-box;[\s\S]*min-width:\s*0;[\s\S]*-webkit-line-clamp:\s*2;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*line-height:\s*1\.3;[\s\S]*white-space:\s*normal;/);
  assert.match(phoneBlock, /\.entity-composition-row strong\s*\{[\s\S]*display:\s*block;[\s\S]*overflow:\s*visible;[\s\S]*white-space:\s*normal;[\s\S]*-webkit-line-clamp:\s*unset;/);
  assert.equal((entityModal.match(/className="entity-composition-value" title=\{item\.value\}/g) || []).length, 2);
});

test('pricing and models.dev identity surfaces keep long model values distinguishable', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const pricingSource = readSource(path.join(process.cwd(), 'src', 'components', 'settings', 'PricingSection.tsx'));
  const importSource = readSource(path.join(process.cwd(), 'src', 'components', 'ModelsDevImportDialog.tsx'));
  assert.match(css, /\.price-model-name\s*\{[\s\S]*-webkit-line-clamp:\s*2;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*white-space:\s*normal;/);
  assert.match(css, /\.models-dev-candidate-title strong\s*\{[\s\S]*-webkit-line-clamp:\s*2;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*white-space:\s*normal;/);
  assert.match(css, /\.models-dev-candidate-main code\s*\{[\s\S]*-webkit-line-clamp:\s*2;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*white-space:\s*normal;/);
  assert.match(css, /@media \(max-width: 820px\)\s*\{[\s\S]*\.price-model-name,[\s\S]*\.models-dev-candidate-title strong,[\s\S]*-webkit-line-clamp:\s*unset;[\s\S]*overflow-wrap:\s*anywhere;/);
  assert.match(pricingSource, /className="price-model-name" title=\{model\}/);
  assert.match(importSource, /<strong title=\{candidate\.modelName\}>\{candidate\.modelName\}<\/strong>/);
  assert.match(importSource, /<code title=\{candidate\.modelId\}>\{candidate\.modelId\}<\/code>/);
  assert.match(importSource, /<strong title=\{selected\.modelName\}>\{selected\.modelName\}<\/strong>/);
  assert.match(importSource, /className="models-dev-preview-model-id" title=\{selected\.modelId\}/);
});

test('models.dev actions expose action-level progress while locking duplicate work', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const importSource = readSource(path.join(process.cwd(), 'src', 'components', 'ModelsDevImportDialog.tsx'));
  const importTest = readSource(path.join(process.cwd(), 'src', 'components', 'ModelsDevImportDialog.test.tsx'));
  assert.match(css, /\.models-dev-footer\s*\{[\s\S]*position:\s*sticky;[\s\S]*bottom:\s*0;[\s\S]*background:\s*var\(--color-bg-panel\);/);
  assert.match(css, /@media \(max-width: 820px\)\s*\{[\s\S]*\.models-dev-footer\s*\{[\s\S]*margin-bottom:\s*-16px;[\s\S]*padding-bottom:\s*16px;/);
  assert.match(importSource, /type SearchAction = 'initial' \| 'search' \| 'refresh' \| null/);
  assert.match(importSource, /if \(!isInitialLoad && \(loading \|\| saving\)\) return/);
  assert.match(importSource, /loadingAction === 'search'/);
  assert.match(importSource, /loadingAction === 'refresh'/);
  assert.match(importSource, /aria-busy=\{saving \|\| loading\}/);
  assert.match(importSource, /saving \? '保存中…' : '导入并保存'/);
  assert.match(importTest, /搜索和保存进行中显示动作级反馈并阻止重复触发/);
});

test('entity dashboard retry exposes loading feedback and a duplicate-click guard', () => {
  const entitySource = readSource(path.join(process.cwd(), 'src', 'components', 'EntityDashboardModal.tsx'));
  const entityTest = readSource(path.join(process.cwd(), 'src', 'components', 'EntityDashboardModal.test.tsx'));
  assert.match(entitySource, /aria-busy=\{loading\}/);
  assert.match(entitySource, /disabled=\{loading\}/);
  assert.match(entitySource, /loading \? '重新加载中…' : '重新加载'/);
  assert.match(entitySource, /title=\{loading \? '正在重新加载专属看板' : '重新加载专属看板'\}/);
  assert.match(entityTest, /实体看板失败恢复入口在重试期间显示进行中反馈并阻止重复点击/);
});

test('ID copy actions expose in-progress semantics and block duplicate clicks', () => {
  const entitySource = readSource(path.join(process.cwd(), 'src', 'components', 'EntityDashboardModal.tsx'));
  const logsSource = readSource(path.join(process.cwd(), 'src', 'components', 'LogsTable.tsx'));
  const entityTest = readSource(path.join(process.cwd(), 'src', 'components', 'EntityDashboardModal.test.tsx'));
  const logsTest = readSource(path.join(process.cwd(), 'src', 'components', 'LogsTable.test.tsx'));
  assert.match(entitySource, /modelCopyState === 'copying'/);
  assert.match(entitySource, /disabled=\{modelCopyState === 'copying'\}/);
  assert.match(entitySource, /aria-busy=\{modelCopyState === 'copying' \|\| undefined\}/);
  assert.match(entitySource, /'正在复制模型 ID'/);
  assert.match(logsSource, /status: 'copying'/);
  assert.match(logsSource, /disabled=\{isSessionCopying\}/);
  assert.match(logsSource, /aria-busy=\{isSessionCopying \|\| undefined\}/);
  assert.match(logsSource, /'正在复制 Session ID'/);
  assert.match(entityTest, /复制进行中显示忙碌语义并阻止重复点击/);
  assert.match(logsTest, /Session ID 复制进行中显示忙碌语义并阻止重复点击/);
});

test('detail model links and expanded IDs remain readable and selectable', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const logs = readSource(path.join(process.cwd(), 'src', 'components', 'LogsTable.tsx'));
  assert.match(css, /\.table-model-link\s*\{[\s\S]*-webkit-line-clamp:\s*2;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*white-space:\s*normal;/);
  assert.match(css, /\.log-detail-grid code\s*\{[\s\S]*overflow:\s*visible;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*text-overflow:\s*clip;[\s\S]*white-space:\s*normal;/);
  assert.match(logs, /<span>模型 ID<\/span><code title=\{log\.model\}>\{log\.model\}<\/code>/);
  assert.match(logs, /<span>Session ID<\/span><code title=\{log\.sessionId \|\| '—'\}>\{log\.sessionId \|\| '—'\}<\/code>/);
  assert.match(logs, /<span>完整时间<\/span><code title=\{log\.timestamp\}>\{log\.timestamp\}<\/code>/);
});

test('entity dashboard titles keep long identities readable across viewport sizes', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const entityModal = readSource(path.join(process.cwd(), 'src', 'components', 'EntityDashboardModal.tsx'));
  const desktopBlock = css.slice(css.indexOf('.entity-heading-line h2'));
  const phoneBlock = css.slice(css.lastIndexOf('@media (max-width: 600px)'));
  assert.match(desktopBlock, /\.entity-heading-line h2\s*\{[\s\S]*display:\s*-webkit-box;[\s\S]*-webkit-line-clamp:\s*2;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*white-space:\s*normal;/);
  assert.match(phoneBlock, /\.entity-heading-line h2\s*\{[\s\S]*display:\s*block;[\s\S]*max-width:\s*none;[\s\S]*overflow:\s*visible;[\s\S]*-webkit-line-clamp:\s*unset;[\s\S]*overflow-wrap:\s*anywhere;/);
  assert.match(entityModal, /<h2 id=\{titleId\} title=\{selection\.name\}>\{visibleEntityName\(selection\.kind, selection\.name\)\}<\/h2>/);
});

test('entity dashboard insight values keep peak and freshness text readable across viewport sizes', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const desktopBlock = css.slice(css.indexOf('.entity-insight-strip strong'));
  const phoneBlock = css.slice(css.lastIndexOf('@media (max-width: 600px)'));
  assert.match(desktopBlock, /\.entity-insight-strip strong\s*\{[\s\S]*display:\s*-webkit-box;[\s\S]*-webkit-line-clamp:\s*2;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*white-space:\s*normal;/);
  assert.match(phoneBlock, /\.entity-insight-strip strong\s*\{[\s\S]*display:\s*block;[\s\S]*overflow:\s*visible;[\s\S]*-webkit-line-clamp:\s*unset;[\s\S]*overflow-wrap:\s*anywhere;/);
});

test('detail filter options keep long identities readable across viewport sizes', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const desktopBlock = css.slice(css.indexOf('.detail-option-name'));
  const phoneBlock = css.slice(css.lastIndexOf('@media (max-width: 600px)'));
  assert.match(desktopBlock, /\.detail-option-name\s*\{[\s\S]*display:\s*-webkit-box;[\s\S]*-webkit-line-clamp:\s*2;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*white-space:\s*normal;/);
  assert.match(phoneBlock, /\.detail-option-name\s*\{[\s\S]*display:\s*block;[\s\S]*overflow:\s*visible;[\s\S]*-webkit-line-clamp:\s*unset;[\s\S]*overflow-wrap:\s*anywhere;/);
});

test('detail granularity distinguishes aggregated rows from per-request rows', () => {
  const logs = readSource(path.join(process.cwd(), 'src', 'components', 'LogsTable.tsx'));
  const granularity = readSource(path.join(process.cwd(), 'src', 'utils', 'detailGranularity.ts'));
  const entity = readSource(path.join(process.cwd(), 'src', 'components', 'EntityDashboardModal.tsx'));
  const logsTest = readSource(path.join(process.cwd(), 'src', 'components', 'LogsTable.test.tsx'));
  const entityTest = readSource(path.join(process.cwd(), 'src', 'components', 'EntityDashboardModal.test.tsx'));
  assert.match(logs, /import \{ detailGranularityLabel, rowGranularityLabel \} from '\.\.\/utils\/detailGranularity'/);
  assert.match(granularity, /export function detailGranularityLabel\(details: DetailGranularitySource \| null \| undefined\)/);
  assert.match(granularity, /details\.items\.some\(\(item\) => \(item\.requests \?\? 1\) > 1\) \? '日志聚合' : '逐次请求'/);
  assert.match(granularity, /export function rowGranularityLabel\(/);
  assert.match(entity, /import \{ detailGranularityLabel \} from '\.\.\/utils\/detailGranularity'/);
  assert.match(entity, /const granularityLabel = detailGranularityLabel\(data\?\.historyPage\)/);
  assert.match(logsTest, /当明细行承载多次请求时明确标记为日志聚合/);
  assert.match(entityTest, /实体看板最近明细沿用聚合日志粒度/);
});

test('phone detail tables announce horizontally hidden fields and expose a keyboard scroll region', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const logs = readSource(path.join(process.cwd(), 'src', 'components', 'LogsTable.tsx'));
  const phoneBlock = css.slice(css.indexOf('@media (max-width: 600px)'));
  assert.match(logs, /role="region"[\s\S]*aria-label="明细记录表格，可横向滚动查看更多字段"[\s\S]*tabIndex=\{0\}/);
  assert.match(logs, /scrollWidth - element\.clientWidth - element\.scrollLeft > 2/);
  assert.match(logs, /className=\{`log-table-scroll-cue\$\{hasMoreTableColumns \? ' is-visible' : ''\}`\}/);
  assert.match(logs, /aria-label="向右查看更多字段"[\s\S]*aria-controls="detail-log-table"/);
  assert.match(logs, /onClick=\{scrollTableColumnsForward\}[\s\S]*onKeyDown=\{handleTableScrollCueKeyDown\}/);
  assert.match(logs, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(logs, /aria-hidden=\{!hasMoreTableColumns\}[\s\S]*tabIndex=\{hasMoreTableColumns \? 0 : -1\}/);
  assert.match(logs, /table\.scrollTo\(\{[\s\S]*nextScrollLeft[\s\S]*behavior:/);
  assert.match(phoneBlock, /\.logs-panel-head \{[\s\S]*flex-wrap:\s*wrap;/);
  assert.match(phoneBlock, /\.log-table-scroll-cue\.is-visible \{[\s\S]*width:\s*100%;[\s\S]*justify-content:\s*flex-end;[\s\S]*min-height:\s*44px;/);
  assert.match(phoneBlock, /\.log-table-scroll-cue\.is-visible:focus-visible \{[\s\S]*outline:/);
  assert.match(phoneBlock, /\.log-table-wrap\[role='region'\]:focus-visible/);
});

test('phone detail rows surface effective tokens, cost and time before expansion', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const logs = readSource(path.join(process.cwd(), 'src', 'components', 'LogsTable.tsx'));
  const phoneBlock = css.slice(css.indexOf('@media (max-width: 600px)'));
  const narrowPhoneBlock = css.slice(css.indexOf('@media (max-width: 340px)'));
  // T10.154 D46：窄屏摘要的「成本」改为「费用」，金额按单条记录精度，未知写「不可得」。
  assert.match(logs, /className="log-mobile-summary"[\s\S]*?有效 Token[\s\S]*?formatEstimatedUsd\(log\.cost, 'record'\)[\s\S]*?费用[\s\S]*?缓存/);
  assert.match(logs, /<time className="log-mobile-time font-mono" dateTime=\{log\.timestamp\}>\{formatTimestamp\(log\.timestamp\)\}<\/time>/);
  assert.match(logs, /<td colSpan=\{10\}>/);
  assert.match(phoneBlock, /\.log-table \{[\s\S]*?min-width:\s*680px;[\s\S]*?table-layout:\s*auto;/);
  assert.match(phoneBlock, /\.log-table \.log-desktop-cell\.log-desktop-context \{[\s\S]*?display:\s*none;/);
  assert.match(phoneBlock, /\.log-table \.log-desktop-cell:not\(\.log-desktop-context\) \{[\s\S]*?display:\s*table-cell;/);
  assert.match(phoneBlock, /\.log-table th\.log-mobile-summary,[\s\S]*?display:\s*table-cell;/);
  assert.match(phoneBlock, /\.log-mobile-summary-stats \{[\s\S]*?flex-wrap:\s*wrap;/);
  assert.match(narrowPhoneBlock, /\.log-table th\.log-mobile-summary,[\s\S]*?min-width:\s*160px;[\s\S]*?width:\s*160px;/);
  assert.match(narrowPhoneBlock, /\.log-mobile-summary-topline \{[\s\S]*?flex-direction:\s*column;/);
  assert.match(narrowPhoneBlock, /\.log-mobile-summary-stats span:nth-child\(3\) \{[\s\S]*?display:\s*none;/);
});

test('phone-width toolbar keeps commands in a contained horizontal strip', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const tokens = readSource(path.join(process.cwd(), 'src', 'styles', 'tokens.css'));
  const header = readSource(path.join(process.cwd(), 'src', 'components', 'AppHeader.tsx'));
  const phoneBlock = css.slice(css.indexOf('@media (max-width: 600px)'));
  const mediumDesktopBlock = css.slice(css.lastIndexOf('@media (min-width: 601px) and (max-width: 1080px), (min-width: 601px) and (max-height: 640px)'));
  assert.match(phoneBlock, /\.header-controls \{[\s\S]*flex-wrap:\s*nowrap;[\s\S]*overflow-x:\s*auto;/);
  assert.match(phoneBlock, /\.header-controls > \* \{[\s\S]*flex:\s*0 0 auto;/);
  assert.match(phoneBlock, /\.header-controls \{[\s\S]*scroll-padding-inline-end:\s*84px;/);
  assert.match(phoneBlock, /\.header-controls > \.theme-menu \{[\s\S]*margin-left:\s*0;/);
  assert.match(css, /@media \(max-width: 1080px\)[\s\S]*?\.app-header\[data-surface='settings'\] \.header-controls-shell \{[\s\S]*width:\s*100%;/);
  assert.match(phoneBlock, /\.header-controls::-webkit-scrollbar \{[\s\S]*display:\s*none;/);
  assert.match(header, /className="header-controls"[\s\S]*role="group"[\s\S]*aria-label=\{headerControlsLabel\}/);
  // 范围、设备与战报都在用量页内工具行（T10.276；请求并入用量后顶栏不再托管任何一项）。
  assert.match(header, /aria-label="数据范围"/);
  assert.doesNotMatch(header, /<ShareCardButton|<CloudDeviceSelect|<RangeControl/);
  assert.match(header, /function scrollHeaderElement\(element: HTMLElement, left: number, behavior: ScrollBehavior\)[\s\S]*typeof element\.scrollTo === 'function'[\s\S]*element\.scrollTo\(\{ left, behavior \}\)[\s\S]*element\.scrollLeft = left/);
  assert.match(header, /scrollHeaderElement\(controls, 0, 'auto'\)[\s\S]*\}, \[activeTab\]\);/);
  assert.match(header, /headerControlsLabel[\s\S]*顶部控制器，可横向滚动查看更多命令/);
  assert.match(header, /headerControlsLabel[\s\S]*主题设置/);
  assert.match(phoneBlock, /\.header-controls-shell \{[\s\S]*position:\s*relative;[\s\S]*width:\s*100%;/);
  assert.match(header, /className=\{`header-controls-scroll-cue[\s\S]*type="button"[\s\S]*aria-label="向右查看更多顶部命令"[\s\S]*onClick=\{scrollHeaderControlsForward\}/);
  assert.match(header, /onKeyDown=\{handleHeaderControlsCueKeyDown\}/);
  assert.match(header, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(header, /aria-hidden=\{!hasMoreHeaderControls\}[\s\S]*tabIndex=\{hasMoreHeaderControls \? 0 : -1\}/);
  assert.match(header, /scrollHeaderElement\(\s*controls,\s*nextScrollLeft,[\s\S]*prefers-reduced-motion/);
  assert.match(header, /if \(event\.detail > 0\)[\s\S]*const controls = headerControlsRef\.current[\s\S]*scrollHeaderElement\(controls, 0, 'auto'\)/);
  assert.match(header, /keepFocusedControlVisible[\s\S]*target\.scrollIntoView\(\{[\s\S]*inline:\s*'nearest'[\s\S]*behavior:\s*'auto'/);
  assert.match(header, /controls\.addEventListener\('focusin', keepFocusedControlVisible\)/);
  assert.match(header, /controls\.removeEventListener\('focusin', keepFocusedControlVisible\)/);
  assert.match(phoneBlock, /\.header-controls-scroll-cue \{[\s\S]*pointer-events:\s*none;[\s\S]*cursor:\s*pointer[\s\S]*opacity:\s*0;/);
  assert.match(phoneBlock, /\.header-controls-scroll-cue \{[\s\S]*width:\s*44px;[\s\S]*min-width:\s*44px;[\s\S]*z-index:\s*1;/);
  assert.match(phoneBlock, /\.header-controls-scroll-cue\.is-visible \{[\s\S]*opacity:\s*1;/);
  assert.match(phoneBlock, /\.header-controls-scroll-cue\.is-visible \{[\s\S]*pointer-events:\s*auto;/);
  assert.match(phoneBlock, /\.header-controls-scroll-cue\.is-visible \{[\s\S]*border-left:\s*1px solid var\(--color-border\);[\s\S]*background:\s*var\(--color-bg-header-solid\);[\s\S]*color:\s*var\(--color-primary\);/);
  assert.match(css, /\.range-control button\s*\{[\s\S]*min-inline-size:\s*44px;/);
  // The cue covers scrolled controls, so both themes need an opaque header color
  // (the exact hex follows the palette; T10.150 moved it with the shell tones).
  const solidHeaderColors = [...tokens.matchAll(/--color-bg-header-solid:\s*(#[0-9a-fA-F]{6});/g)].map((match) => match[1]);
  assert.equal(solidHeaderColors.length, 2, 'dark and light themes each define an opaque header color');
  assert.notEqual(solidHeaderColors[0].toLowerCase(), solidHeaderColors[1].toLowerCase());
  assert.match(phoneBlock, /\.header-controls-scroll-cue \{[\s\S]*visibility:\s*hidden;/);
  assert.match(phoneBlock, /\.header-controls-scroll-cue\.is-visible \{[\s\S]*visibility:\s*visible;/);
  assert.match(phoneBlock, /\.header-controls-scroll-cue:focus-visible \{[\s\S]*outline:/);
  assert.match(phoneBlock, /\.detail-filter-heading-actions > \.ghost-inline \{[\s\S]*align-self:\s*flex-end;/);
  assert.match(css, /Keep the two highest-value context controls visible together/);
  assert.match(mediumDesktopBlock, /\.header-controls \{[\s\S]*flex-wrap:\s*nowrap;[\s\S]*overflow-x:\s*auto;[\s\S]*scroll-padding-inline-end:\s*56px;/);
  assert.match(mediumDesktopBlock, /\.header-controls > \.theme-menu \{[\s\S]*margin-left:\s*0;/);
  assert.match(mediumDesktopBlock, /\.header-controls-scroll-cue \{[\s\S]*width:\s*44px;[\s\S]*min-width:\s*44px;[\s\S]*visibility:\s*hidden;/);
  assert.match(mediumDesktopBlock, /\.header-controls-scroll-cue\.is-visible \{[\s\S]*pointer-events:\s*auto;/);
  assert.match(mediumDesktopBlock, /\.header-controls-scroll-cue\.is-visible \{[\s\S]*visibility:\s*visible;/);
  assert.match(css, /@media \(max-width: 340px\)[\s\S]*?\.header-controls > \.segmented:first-child \{[\s\S]*padding-inline: 2px;/);
  assert.match(css, /@media \(max-width: 340px\)[\s\S]*?\.header-controls > \.segmented:first-child button \{[\s\S]*padding-inline: 6px;[\s\S]*font-size: 11px;/);
  assert.match(css, /@media \(max-width: 340px\)[\s\S]*?\.header-controls > \.segmented:first-child button svg \{[\s\S]*display: none;/);
  assert.match(css, /@media \(max-width: 340px\)[\s\S]*?\.header-controls > \.share-card-toggle \{[\s\S]*width: 44px;[\s\S]*min-width: 44px;[\s\S]*padding-inline: 0;/);
  assert.match(css, /@media \(max-width: 340px\)[\s\S]*?\.header-controls > \.share-card-toggle span \{[\s\S]*display: none;/);
});

test('toast feedback sits in normal flow below the header instead of covering its context', () => {
  const app = readSource(path.join(process.cwd(), 'src', 'App.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(app, /<AppHeader[\s\S]*dataStatus=\{\{[\s\S]*\/>\}[\s\S]*\{message && <Toast message=\{message\} \/>\}[\s\S]*<section id="main-content"/);
  assert.match(css, /\.toast \{[\s\S]*position:\s*relative;[\s\S]*align-self:\s*flex-end;[\s\S]*margin:\s*8px 22px 0;/);
  assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*\.toast \{[\s\S]*align-self:\s*stretch;[\s\S]*margin:\s*8px 12px 0;[\s\S]*max-width:\s*none;/);
});

test('medium-width detail filters keep the clear action beside its heading', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(css, /@media \(min-width: 600px\) and \(max-width: 860px\)[\s\S]*?\.detail-filter-heading \{[\s\S]*?align-items:\s*flex-start;[\s\S]*?flex-direction:\s*row;[\s\S]*?\}/);
  assert.match(css, /\.detail-filter-heading-actions > \.ghost-inline \{[\s\S]*?flex:\s*none;[\s\S]*?margin-top:\s*2px;/);
});

test('narrow activity tables keep row actions visible while columns scroll', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const narrowTableBlock = css.slice(css.indexOf('@media (max-width: 1100px)'));
  assert.match(narrowTableBlock, /\.log-table th:last-child,[\s\S]*\.log-table td:last-child/);
  assert.match(narrowTableBlock, /position:\s*sticky/);
  assert.match(narrowTableBlock, /right:\s*0/);
  assert.match(narrowTableBlock, /background:\s*var\(--color-bg-panel\)/);
  assert.match(narrowTableBlock, /box-shadow:\s*-8px 0 12px -10px var\(--color-border-strong\)/);
});

test('background scan defaults to fifteen minutes and prevents sub-minute polling', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'ScanStartupSection.tsx'));
  assert.equal(DEFAULT_SETTINGS.scan_interval_secs, 900);
  assert.equal(DEFAULT_SETTINGS.scan_policy_version, 1);
  assert.match(source, /scanFrequencyHint\(appSettings.scan_interval_secs\)/);
  assert.match(source, /可从菜单栏或托盘打开它/);
  assert.match(source, /min=\{60\}/);
});

test('cold-start scans do not trigger idle cloud sync without local changes', () => {
  const nativeSource = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'lib.rs'));
  const startupBegin = nativeSource.indexOf('let _ = scan_sync_and_notify(&ctx, &app_handle, false);');
  const startupEnd = nativeSource.indexOf('let now = Instant::now();', startupBegin);
  assert.ok(startupBegin >= 0 && startupEnd > startupBegin, 'scheduler startup block must remain identifiable');
  const startupBlock = nativeSource.slice(startupBegin, startupEnd);
  assert.match(nativeSource, /let _ = scan_sync_and_notify\(&ctx, &app_handle, false\);/);
  assert.match(nativeSource, /Newly inserted rows still sync through `persisted_changes`/);
  assert.match(nativeSource, /first 15-minute retry window/);
  assert.doesNotMatch(startupBlock, /sync_quota_and_notify\(&ctx, &app_handle\);/);
  assert.match(nativeSource, /let mut next_quota_sync = now \+ Duration::from_secs\(5 \* 60\);/);
  assert.match(nativeSource, /quota_sync::background_sync_is_suppressed\(\)/);
  assert.match(nativeSource, /get_background_quota_snapshot_sync_status_impl/);
  assert.doesNotMatch(nativeSource, /Err\(error\)[\s\S]*get_quota_snapshot_sync_status_impl\(ctx\)/);
});

test('cloud status and remote quota reads require an explicit user check', () => {
  const app = readSource(path.join(process.cwd(), 'src', 'App.tsx'));
  const cloud = readSource(path.join(process.cwd(), 'src', 'hooks', 'useCloud.ts'));
  const commands = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'commands', 'mod.rs'));
  const quota = readSource(path.join(process.cwd(), 'src', 'hooks', 'useQuota.ts'));
  const native = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'lib.rs'));
  const sidebar = readSource(path.join(process.cwd(), 'src', 'components', 'Sidebar.tsx'));
  const cloudSection = readSource(path.join(process.cwd(), 'src', 'components', 'settings', 'CloudAccountSection.tsx'));
  assert.doesNotMatch(app, /\.catch\(\(err\) => showMessage\('error', `读取 Supabase 配置失败: \$\{err\}`\)\);\s*void cloud\.refreshCloudStatus\(\);/);
  assert.doesNotMatch(app, /cloudStatusLoadRequested/);
  assert.match(app, /const quotaCloudLoadMode = useRef<'none' \| 'local' \| 'remote'>\('none'\);/);
  assert.match(app, /const canReadRemote = cloud\.cloudStatusKnown && cloud\.cloudStatus\.authenticated;/);
  // 允许解构后的写法：T10.75 为了让 react-hooks/exhaustive-deps 能静态核对依赖，
  // 把 quota.loadQuotas 等成员解构成了同值的局部绑定。契约守的是「远端读取必须
  // 落在 canReadRemote 分支内」，不是成员访问的书写形式。
  assert.match(app, /if \(canReadRemote\) \{[\s\S]*loadQuotas\(true\)[\s\S]*loadQuotaSyncStatus\(\)/);
  assert.match(app, /else \{[\s\S]*void loadQuotas\(false\);/);
  assert.match(app, /onCheckCloudStatus=\{checkCloudStatusAndOpenSettings\}/);
  assert.match(app, /cloudStatusKnown=\{cloud\.cloudStatusKnown\}/);
  assert.match(cloud, /const \[cloudStatusKnown, setCloudStatusKnown\] = useState\(false\);/);
  assert.match(cloud, /const \[cloudStatusChecking, setCloudStatusChecking\] = useState\(false\);/);
  assert.match(cloud, /const \[cloudStatusError, setCloudStatusError\] = useState\(''\);/);
  assert.match(cloud, /setCloudStatusChecking\(true\);[\s\S]*setCloudStatusChecking\(false\);/);
  assert.match(cloud, /setCloudStatus\(status\);\s*setCloudStatusKnown\(true\);/);
  assert.match(commands, /fn load_public_cloud_config_file\(app: &AppContext\)/);
  assert.match(commands, /get_cloud_config_impl\(app: &AppContext\)[\s\S]*load_public_cloud_config_file\(app\)/);
  assert.match(quota, /const lastSuccessfulIncludeRemote = useRef\(false\);/);
  assert.match(quota, /const resolvedIncludeRemote = includeRemote \?\? lastSuccessfulIncludeRemote\.current;/);
  assert.match(quota, /const resetQuotaBinding[\s\S]*?lastSuccessfulIncludeRemote\.current = false;/);
  assert.match(quota, /retrySecureStorage/);
  assert.match(quota, /'retry_quota_providers' : 'retry_local_quota_providers'/);
  assert.match(quota, /'get_quota_providers' : 'get_local_quota_providers'/);
  assert.match(native, /quota::retry_quota_providers/);
  assert.match(native, /quota::retry_local_quota_providers/);
  assert.match(native, /quota::get_local_quota_providers/);
  assert.match(sidebar, /本地就绪 · 云端状态待检查/);
  assert.match(sidebar, /请先在设置与云端检查云端状态/);
  assert.match(sidebar, /onCheckCloudStatus\?: \(\) => void/);
  assert.match(sidebar, /if \(!cloudStatusKnown && onCheckCloudStatus\)/);
  assert.match(cloudSection, /查看登录状态会读取本机钥匙串，仅在你主动点击后执行/);
  assert.match(cloud, /当前授权周期内不会重复读取本机钥匙串；请确认登录钥匙串已解锁后，主动重试/);
  assert.match(cloudSection, /id=\{statusErrorId\}[\s\S]*statusErrorId/);
  assert.match(cloudSection, /aria-describedby=\{statusErrorId\}/);
  assert.match(cloudSection, /statusError \? '重试检查' : '检查账户状态'/);
});

test('native startup keeps the shell hidden until the resolved window mode is applied', () => {
  const baseConfig = JSON.parse(
    readSource(path.join(process.cwd(), 'src-tauri', 'tauri.conf.json')),
  );
  const macosConfig = JSON.parse(
    readSource(path.join(process.cwd(), 'src-tauri', 'tauri.macos.conf.json')),
  );
  const nativeSource = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'lib.rs'));
  assert.equal(baseConfig.app.windows[0].visible, false);
  assert.equal(macosConfig.app.windows[0].visible, false);
  assert.ok(macosConfig.app.windows[0].minWidth <= 1024, 'macOS minimum width must preserve the audited 1024px responsive state');
  assert.match(nativeSource, /if start_minimized \{[\s\S]*?hide_main_window_to_tray\(app\.handle\(\), &tray_state_for_setup\);[\s\S]*?\} else \{[\s\S]*?show_main_window_from_tray\(app\.handle\(\), &tray_state_for_setup\);/);
  // T10.105a：托盘单击弹出挂件，菜单仍保留“显示窗口”作为主窗口恢复入口，并与退出隔开。
  assert.match(nativeSource, /TrayIconBuilder::with_id\(widget_window::TRAY_ID\)/);
  assert.match(nativeSource, /tooltip\("TokenLedger · 悬停或单击查看托盘挂件 · 菜单显示窗口或退出"\)/);
  assert.match(nativeSource, /items\(&\[&show_i, &widget_i, &desktop_i, &menu_separator, &quit_i\]\)/, 'tray menu must separate recovery from exit');
  assert.match(nativeSource, /TrayIconEvent::Click \{[\s\S]*?MouseButtonState::Up,[\s\S]*?widget_window::toggle_on_main_thread\(/);
  assert.match(nativeSource, /TrayIconEvent::DoubleClick \{[\s\S]*?widget_window::dismiss_on_main_thread\([\s\S]*?show_main_window_from_tray\(/);
  assert.match(nativeSource, /else if should_hide_widget_window_on_close\(window\.label\(\)\) \{[\s\S]*?api\.prevent_close\(\);[\s\S]*?widget_window::release_pin\([\s\S]*?window\.hide\(\)/);
  // T10.110：指向托盘临时显示（受 tray_hover_widget_enabled 控制）、离开后延时收起、单击钉住；
  // 托盘菜单勾选项“桌面小组件”与设置页开关同源；桌面小组件关闭/拖动分别回写开关与位置。
  assert.match(nativeSource, /TrayIconEvent::Enter \{[\s\S]*?tray_hover_widget_enabled[\s\S]*?widget_window::on_tray_enter\(/);
  assert.match(nativeSource, /TrayIconEvent::Leave \{[\s\S]*?widget_window::on_tray_leave\(/);
  assert.match(nativeSource, /CheckMenuItemBuilder::with_id\(\s*"desktop-widget",\s*"桌面小组件（长驻桌面）",?\s*\)/);
  assert.match(nativeSource, /DESKTOP_WIDGET_LABEL \{[\s\S]*?widget_window::on_desktop_widget_closed\(/);
  assert.match(nativeSource, /WindowEvent::Moved\(position\)[\s\S]*?DESKTOP_WIDGET_LABEL[\s\S]*?widget_window::on_desktop_widget_moved\(/);
  assert.match(nativeSource, /"open-settings",\s*serde_json::json!\(\{ "anchor": "settings-widget" \}\)/);
  const widgetWindowSource = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'widget_window.rs'));
  assert.match(widgetWindowSource, /pub const HOVER_HIDE_DELAY_MS: u64 = 450;/);
  assert.match(widgetWindowSource, /window\.set_focusable\(focus\)/, 'hover-shown widget must not steal focus');
  assert.match(widgetWindowSource, /WebviewUrl::App\("index\.html\?view=widget&mode=desktop"\.into\(\)\)/);
  assert.match(widgetWindowSource, /\.always_on_bottom\(true\)[\s\S]*?\.skip_taskbar\(true\)[\s\S]*?\.focused\(false\)/);
  const capabilities = JSON.parse(readSource(path.join(process.cwd(), 'src-tauri', 'capabilities', 'default.json')));
  assert.deepEqual(capabilities.windows, ['main', 'widget', 'desktop-widget']);
  const widgetViewSource = readSource(path.join(process.cwd(), 'src', 'components', 'WidgetView.tsx'));
  assert.match(widgetViewSource, /invoke\('widget_pointer_hover', \{ inside \}\)/);
  assert.match(widgetViewSource, /invoke\('open_main_settings'\)/);
  assert.match(widgetViewSource, /invoke\('set_desktop_widget_enabled', \{ enabled: false \}\)/);
  assert.equal(DEFAULT_SETTINGS.tray_hover_widget_enabled, true);
  assert.equal(DEFAULT_SETTINGS.desktop_widget_enabled, false);
  assert.match(nativeSource, /activate_macos_application\(\)/);
  assert.match(nativeSource, /NSRunningApplication::currentApplication\(nil\)/);
  assert.match(nativeSource, /activateWithOptions_\(NSApplicationActivateIgnoringOtherApps\)/);
  assert.match(nativeSource, /activate_windows_window\(&window\)/);
  assert.match(nativeSource, /tauri_plugin_single_instance::init\(/);
  assert.match(nativeSource, /run_on_main_thread\(move \|\|/);
  assert.match(nativeSource, /"single-instance-restore"/);
  assert.match(nativeSource, /tauri::RunEvent::Reopen \{[\s\S]*?show_main_window_from_tray/);
  assert.match(nativeSource, /fn should_hide_main_window_on_close\(window_label: &str\) -> bool[\s\S]*?window_label == "main"/);
  assert.match(nativeSource, /CloseRequested[\s\S]*?should_hide_main_window_on_close\(window\.label\(\)\)/);
});

test('pricing settings default to a compact disclosure and reveal errors', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'PricingSection.tsx'));
  assert.match(source, /const \[pricingExpanded, setPricingExpanded\] = useState\(false\)/);
  assert.match(source, /aria-expanded=\{pricingExpanded\}/);
  assert.match(source, /pricingExpanded && <div className="settings-pricing-expanded"/);
  assert.match(source, /if \(props\.pricesError \|\| props\.pricesLoadError\) setPricingExpanded\(true\)/);
  assert.match(source, /pendingPriceCount[\s\S]*个待核价/);
});

test('pricing load failures retain the editor snapshot and expose a retry action', () => {
  const settings = readSource(path.join(process.cwd(), 'src', 'hooks', 'useSettings.ts'));
  const pricing = readSource(path.join(process.cwd(), 'src', 'components', 'settings', 'PricingSection.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(settings, /const \[pricesLoadError, setPricesLoadError\] = useState\(''\);/);
  assert.match(settings, /const \[pricesLoading, setPricesLoading\] = useState\(false\);/);
  assert.match(settings, /const pricesRequestId = useRef\(0\);/);
  assert.match(settings, /const requestId = \+\+pricesRequestId\.current;[\s\S]*setPricesLoadError\(''\);/);
  assert.match(settings, /const errorMessage = `读取价格表失败: \$\{err\}`;[\s\S]*setPricesLoadError\(errorMessage\);/);
  assert.match(pricing, /pricesLoadError: string;/);
  assert.match(pricing, /pricesLoading: boolean;/);
  assert.match(pricing, /onReloadPrices: \(\) => void \| Promise<void>;/);
  assert.match(pricing, /className="settings-pricing-load-error"[\s\S]*重新读取价格表/);
  assert.match(pricing, /仍显示上次读取到的价格表，可点击“重新读取”重试/);
  assert.match(css, /\.settings-pricing-load-error \{[\s\S]*overflow-wrap: anywhere;/);
  assert.match(css, /\.settings-pricing-load-error \{\n    flex-direction: column;/);
});

test('pricing save and reset actions expose progress while locking duplicate work', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'PricingSection.tsx'));
  assert.match(source, /const pricesBusy = props\.busy\.prices/);
  assert.match(source, /aria-busy=\{pricesBusy \|\| undefined\}/);
  assert.match(source, /pricesBusy \? '恢复中…' : '恢复默认'/);
  assert.match(source, /pricesBusy \? '保存中…' : '保存价格表'/);
  assert.match(source, /<SettingsActionRow busy=\{pricesBusy\}>/);
});

test('wallpaper consent and cleanup actions expose progress while locking duplicate work', () => {
  const wallpaper = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'WallpaperSection.tsx'));
  assert.match(wallpaper, /const \[activeAction, setActiveAction\] = useState<'restore-consent' \| 'disable-consent' \| 'cleanup' \| null>\(null\);/);
  assert.match(wallpaper, /aria-busy=\{activeAction !== null \|\| undefined\}/);
  assert.match(wallpaper, /正在确认并恢复历史壁纸设置/);
  assert.match(wallpaper, /确认中…/);
  assert.match(wallpaper, /正在关闭历史壁纸自动化/);
  assert.match(wallpaper, /处理中…/);
  assert.match(wallpaper, /正在清理历史壁纸/);
  assert.match(wallpaper, /清理中…/);
  assert.match(wallpaper, /<SettingsActionRow busy=\{actionLocked\}>/);
});

test('quota provider immediate-read actions expose progress while locking duplicate work', () => {
  const quota = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'QuotaSection.tsx'));
  assert.match(quota, /const \[activeQuotaRead, setActiveQuotaRead\] = useState<'claude' \| 'antigravity' \| null>\(null\);/);
  assert.match(quota, /const claudeReadBusy = activeQuotaRead === 'claude' && busy\.settings;/);
  assert.match(quota, /const antigravityReadBusy = activeQuotaRead === 'antigravity' && busy\.settings;/);
  assert.match(quota, /正在读取 Claude 订阅额度/);
  assert.match(quota, /正在读取 Antigravity 额度/);
  assert.match(quota, /读取中…/);
  // T10.283 起读取按钮统一放在来源状态卡上，忙碌态由各卡的 readBusy 驱动。
  assert.match(quota, /aria-busy=\{readBusy \|\| undefined\}/);
  assert.match(quota, /readBusy=\{claudeReadBusy\}/);
  assert.match(quota, /readBusy=\{antigravityReadBusy\}/);
  // Claude 那一路在读取的同时刷新接入状态（T10.83）：读完要能立刻反映出
  // 「是否已收到首个快照」，否则用户点了「立即读取」仍然只看到旧判断。
  assert.match(quota, /setClaudeSetupReloadKey\(\(key\) => key \+ 1\); runQuotaRead\('claude'\);/u);
  assert.match(quota, /\(\) => runQuotaRead\('antigravity'\)/);
});

test('custom quota endpoint actions expose provider-specific progress while locking duplicate work', () => {
  const quota = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'QuotaSection.tsx'));
  assert.match(quota, /activeCustomEndpointAction/);
  assert.match(quota, /正在启用/);
  assert.match(quota, /正在停用/);
  assert.match(quota, /正在删除本机配置/);
  assert.match(quota, /const customEndpointSaveBusy = customEndpointBusy && activeCustomEndpointAction === null;/);
  assert.match(quota, /aria-busy=\{customEndpointSaveBusy \|\| undefined\}/);
  assert.match(quota, /aria-label=\{customEndpointSaveLabel\}/);
  assert.match(quota, /正在添加公司额度来源/);
  assert.match(quota, /正在保存公司额度来源/);
  assert.match(quota, /aria-busy=\{toggleBusy \|\| undefined\}/);
  assert.match(quota, /aria-busy=\{deleteBusy \|\| undefined\}/);
  assert.match(quota, /处理中…/);
  assert.match(quota, /删除中…/);
});

test('settings status values remain readable across viewport sizes', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const baseStart = css.indexOf('  .settings-value {');
  const phoneStart = css.lastIndexOf('@media (max-width: 600px)');
  assert.ok(baseStart >= 0, 'settings value base rule must remain present');
  assert.ok(phoneStart > baseStart, 'phone override must follow the base settings value rule');
  const baseBlock = css.slice(baseStart, phoneStart);
  const phoneBlock = css.slice(phoneStart);
  assert.match(baseBlock, /\.settings-value \{[\s\S]*?display: -webkit-box;[\s\S]*?overflow-wrap: anywhere;[\s\S]*?-webkit-line-clamp: 2;[\s\S]*?white-space: normal;/);
  assert.match(baseBlock, /\.settings-row-control > \.settings-value,[\s\S]*?flex: 1 1 180px;/);
  assert.match(phoneBlock, /\.settings-value \{[\s\S]*?display: block;[\s\S]*?overflow: visible;[\s\S]*?-webkit-line-clamp: unset;[\s\S]*?white-space: normal;/);
});

test('database coverage values remain readable across viewport sizes', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const baseStart = css.indexOf('  .settings-info-value {');
  const phoneStart = css.lastIndexOf('@media (max-width: 600px)');
  assert.ok(baseStart >= 0, 'settings info value base rule must remain present');
  assert.ok(phoneStart > baseStart, 'phone override must follow the base settings info value rule');
  const baseBlock = css.slice(baseStart, phoneStart);
  const phoneBlock = css.slice(phoneStart);
  assert.match(baseBlock, /\.settings-info-value \{[\s\S]*?display: -webkit-box;[\s\S]*?overflow-wrap: anywhere;[\s\S]*?-webkit-line-clamp: 2;[\s\S]*?white-space: normal;/);
  assert.match(phoneBlock, /\.settings-info-value \{[\s\S]*?display: block;[\s\S]*?overflow: visible;[\s\S]*?-webkit-line-clamp: unset;[\s\S]*?white-space: normal;/);
});

test('Android prototype keeps forced landscape explicit, reversible, and responsive', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'AndroidDashboardPrototype.tsx'));
  const styles = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'android-dashboard-prototype.css'));
  assert.match(source, /FORCE_LANDSCAPE_STORAGE_KEY/);
  assert.match(source, /const \[forceLandscape, setForceLandscape\] = useState/);
  assert.match(source, /title="强制横屏"[\s\S]*description="关闭时跟随系统方向"/);
  assert.match(source, /role="switch"[\s\S]*aria-checked=\{checked\}/);
  assert.match(source, /data-orientation=\{forceLandscape \? 'landscape' : 'system'\}/);
  assert.match(styles, /@media \(max-width: 899px\) and \(orientation: landscape\)/);
  assert.match(styles, /grid-template-areas:[\s\S]*"nav status"[\s\S]*"nav content"/);
  assert.match(styles, /prototype-kpi-grid \{ grid-template-columns: repeat\(4/);
});

test('Android prototype resets scroll position when switching pages', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'AndroidDashboardPrototype.tsx'));
  assert.match(source, /const scrollAreaRef = useRef<HTMLDivElement>\(null\);/);
  assert.match(source, /useEffect\(\(\) => \{\s*scrollAreaRef\.current\?\.scrollTo\(\{ top: 0, left: 0, behavior: 'auto' \}\);\s*\}, \[tab\]\);/);
  assert.match(source, /<div ref=\{scrollAreaRef\} className="prototype-scroll-area">/);
});

test('Android prototype source insight does not expose a dead action', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'AndroidDashboardPrototype.tsx'));
  const styles = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'android-dashboard-prototype.css'));
  assert.doesNotMatch(source, /SOURCE_DATA\.map\(\(item\) => <SourceRow key=\{item\.name\} \{\.\.\.item\} onClick=\{\(\) => undefined\} \/>\)/);
  assert.match(source, /onClick\?: \(\) => void/);
  assert.match(source, /if \(!onClick\) return <div className=\{rowClass\}>\{rowContent\}<\/div>/);
  assert.match(source, /aria-label=\{compact \? `打开\$\{name\}来源分析` : `展开\$\{name\}缓存命中分布`\}/);
  assert.match(styles, /\.prototype-source-row\.is-static \{ grid-template-columns: 7px 1fr auto; cursor: default; \}/);
});

test('Android prototype keeps long identities readable in filters, sources, details, and ambient quota', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'AndroidDashboardPrototype.tsx'));
  const styles = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'android-dashboard-prototype.css'));
  assert.match(styles, /\.prototype-filter-button span \{[\s\S]*?-webkit-line-clamp: 2;/);
  assert.match(styles, /\.prototype-source-row strong,[\s\S]*?-webkit-line-clamp: 2;/);
  assert.match(styles, /\.prototype-detail-list strong,[\s\S]*?-webkit-line-clamp: 2;/);
  assert.match(styles, /\.prototype-provider-head strong,[\s\S]*?-webkit-line-clamp: 2;/);
  assert.match(styles, /\.prototype-window-row strong \{[\s\S]*?-webkit-line-clamp: 2;/);
  assert.match(styles, /\.prototype-ambient-quota span,[\s\S]*?-webkit-line-clamp: 2;/);
  assert.match(source, /<span title=\{machine\}>\{machine\}<\/span>/);
  assert.match(source, /<strong title=\{source\}>\{source\}<\/strong>/);
  assert.match(source, /<span title=\{`\$\{provider\} · 5 小时`\}>\{provider\} · 5 小时<\/span>/);
  assert.match(source, /<time title=\{`重置 \$\{reset\}`\}>重置 \{reset\}<\/time>/);
});

test('Android filter sheet owns keyboard focus and restores its trigger', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'AndroidDashboardPrototype.tsx'));
  assert.match(source, /const sheetRef = useRef<HTMLElement>\(null\)/);
  assert.match(source, /const closeButtonRef = useRef<HTMLButtonElement>\(null\)/);
  assert.match(source, /restoreFocusRef\.current = document\.activeElement instanceof HTMLElement/);
  assert.match(source, /closeButtonRef\.current\?\.focus\(\)/);
  assert.match(source, /if \(event\.key === 'Escape'\)/);
  assert.match(source, /if \(event\.key !== 'Tab'\) return/);
  assert.match(source, /document\.addEventListener\('keydown', handleKeyDown\)/);
  assert.match(source, /restoreFocusRef\.current\?\.focus\(\)/);
  assert.match(source, /role="dialog"[\s\S]*tabIndex=\{-1\}/);
});

test('Android prototype selection groups expose their visual state to assistive tech', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'AndroidDashboardPrototype.tsx'));
  assert.match(source, /className="prototype-segmented" role="group" aria-label="统计时间范围"[\s\S]*aria-pressed=\{range === item\}/);
  assert.match(source, /className="prototype-mode-strip" role="group" aria-label="洞察视图"[\s\S]*aria-pressed=\{mode === item\}/);
  assert.match(source, /className="prototype-widget-switch" role="group" aria-label="摆件显示模式"[\s\S]*aria-pressed=\{!eink\}/);
  assert.match(source, /className=\{eink \? 'is-selected' : ''\} aria-pressed=\{eink\}/);
});

test('Android prototype keeps only result-bearing affordances interactive', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'AndroidDashboardPrototype.tsx'));
  const styles = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'android-dashboard-prototype.css'));
  assert.match(source, /aria-label="分享数据战报" onClick=\{handleShare\}/);
  assert.match(source, /aria-label=\{refreshing \? '刷新数据中' : '刷新数据'\}/);
  assert.match(source, /className="prototype-detail-row"/);
  assert.doesNotMatch(source, /<button key=\{`\$\{time\}-\$\{source\}`\}/);
  assert.match(source, /className="prototype-sheet-row is-static"/);
  assert.doesNotMatch(source, /className="prototype-sheet-row" type="button"/);
  assert.match(source, /function SettingsRow\([\s\S]*return <div className="prototype-settings-row">/);
  assert.doesNotMatch(source, /return <button type="button"><span><Icon size=\{17\} \/><\/span><strong>\{title\}/);
  assert.match(styles, /\.prototype-action-status \{/);
  assert.match(styles, /\.prototype-detail-list > \.prototype-detail-row \{/);
  assert.match(styles, /\.prototype-sheet-row\.is-static \{[^}]*cursor: default;/);
  assert.match(styles, /\.prototype-settings-list > \.prototype-settings-row/);
});

test('Android prototype interactive surfaces preserve the 48dp touch target', () => {
  const styles = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'android-dashboard-prototype.css'));
  assert.match(styles, /\.prototype-icon-button \{ width: 48px; height: 48px;/);
  assert.match(styles, /\.prototype-segmented button \{ min-height: 48px;/);
  assert.match(styles, /\.prototype-filter-button \{ min-height: 48px;/);
  assert.match(styles, /\.prototype-card-link \{[\s\S]*?min-height: 48px;/);
  assert.match(styles, /\.prototype-section-head button \{ min-height: 48px;[\s\S]*?padding: 0 8px;/);
  assert.match(styles, /\.prototype-source-row\.is-compact \{ min-height: 48px; \}/);
  assert.match(styles, /\.prototype-mode-strip button,[\s\S]*?\.prototype-widget-switch button \{ min-height: 48px;/);
  assert.match(styles, /\.prototype-tabbar button \{ min-height: 48px;/);
  assert.match(styles, /\.prototype-sheet-head button \{ width: 48px; height: 48px;/);
  assert.match(styles, /\.prototype-choice-grid button \{ min-height: 48px;/);
  assert.match(styles, /\.prototype-sheet-row \{[\s\S]*?min-height: 48px;/);
  assert.match(styles, /@media \(max-width: 899px\) and \(orientation: landscape\)[\s\S]*?\.prototype-tabbar button \{ min-height: 48px; \}/);
});

test('Android ambient prototype is a control-free wake-locked data canvas', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'AndroidDashboardPrototype.tsx'));
  const styles = readSource(
    path.join(process.cwd(), 'src', 'prototypes', 'android-dashboard-prototype.css'));
  const ambient = source.slice(source.indexOf('function AmbientWidgetScreen'), source.indexOf('function AmbientQuota'));
  assert.match(source, /new URLSearchParams\(window\.location\.search\)\.get\('widget'\) === 'fullscreen'/);
  assert.match(source, /wakeLock\.request\('screen'\)/);
  assert.match(source, /sentinel\.release\(\)/);
  assert.match(source, /document\.addEventListener\('visibilitychange', handleVisibility\)/);
  assert.match(ambient, /return \([\s\S]*<main/);
  assert.match(ambient, /prototype-ambient-primary[\s\S]*aria-checked=\{tokenMode === 'all'\}/);
  assert.doesNotMatch(ambient, /prototype-tabbar|prototype-icon-button|ScreenRotation|RotateCw/);
  assert.match(styles, /prototype-ambient-widget[\s\S]*grid-template-rows:/);
  assert.match(styles, /prototype-ambient-trend[\s\S]*grid-area: trend/);
  assert.match(styles, /prototype-ambient-heatmap[\s\S]*grid-template-rows/);
  assert.match(source, /prototype-ambient-quota-value[\s\S]*<strong>\{remaining\}<small>%<\/small><\/strong>[\s\S]*<em>可用<\/em>/);
  assert.match(styles, /prototype-ambient-quotas[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /prototype-ambient-quota-value \{ position: absolute; inset: 0; display: grid; place-items: center/);
});

test('quota backend reason codes have localized user-facing copy', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'QuotaPanel.tsx'));
  for (const reason of [
    'local_authorization_required',
    'claude_local_authorization_required',
    'claude_statusline_snapshot_missing',
    'claude_statusline_snapshot_invalid',
    'claude_native_authorization_required',
    'claude_native_cli_unavailable',
    'claude_native_timeout',
    'claude_native_usage_unavailable',
    'claude_native_subscription_unavailable',
    'claude_native_response_invalid',
    'claude_codexbar_unavailable',
    'claude_codexbar_timeout',
    'claude_codexbar_response_invalid',
    'reset_elapsed',
    'source_not_found',
    'permission_denied',
    'secure_storage_unavailable',
    'source_schema_unsupported',
    'source_scan_truncated',
    'source_temporarily_unavailable',
    'provider_worker_failed',
    'provider_cache_unavailable',
    'observation_stale',
    'credits_unlimited',
    'admin_key_required',
    'rate_limited',
    'upstream_unavailable',
  ]) {
    assert.match(source, new RegExp(`\\b${reason}:`));
  }
  assert.match(source, /Claude Desktop 额度页可能正常/);
  // T10.143f 起这段安卓文案在 ui/foundation/V2Formatters.kt，读整个看板界面源码。
  const android = readAndroidDashboardUi();
  assert.match(android, /secure_storage_unavailable.*系统安全存储暂时无法读取/);
  assert.doesNotMatch(source, /请先在 Claude 中确认额度页可用/);
});

test('Claude enhanced quota prefers the bounded in-process PTY and keeps CodexBar as fallback', () => {
  const backend = readSource(
    path.join(process.cwd(), 'src-tauri', 'src', 'quota', 'mod.rs'));
  const settings = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'QuotaSection.tsx'));
  assert.match(backend, /capture_claude_cli_usage/);
  assert.match(backend, /native_pty_system/);
  assert.match(backend, /authorize_claude_native_quota/);
  assert.match(backend, /ClaudeProbe/);
  assert.match(backend, /resolve_claude_cli_executables/);
  assert.match(backend, /disableDeepLinkRegistration/);
  assert.match(backend, /retry_candidates/);
  assert.match(backend, /state\.recent\.remove\(app_data_dir\)/);
  assert.match(backend, /resolve_codexbar_executables/);
  assert.match(backend, /TOKENLEDGER_CODEXBAR_BIN/);
  assert.match(backend, /CodexBarCLI/);
  assert.match(backend, /capture_codexbar_provider_output\(program, app_data_dir, "claude", "auto", timeout\)/);
  assert.match(backend, /CLAUDE_CODEXBAR_MAX_OUTPUT_BYTES/);
  assert.match(backend, /claude_codexbar_envelope\(app_data_dir, fetched_at\)/);
  assert.doesNotMatch(backend, /api\/oauth\/usage|Claude Code-credentials/);
  // U-107：实验来源收进「高级」，默认不参与；边界说明仍写明不碰凭据。
  assert.match(settings, /实验来源：内置 \/usage 与 CodexBar/);
  assert.match(settings, /不读钥匙串、Cookie 或 OAuth Token/);
});

test('Antigravity quota is native-first on every desktop and restricts CodexBar to local CLI fallback', () => {
  const backend = readSource(
    path.join(process.cwd(), 'src-tauri', 'src', 'quota', 'antigravity.rs'));
  const settings = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'QuotaSection.tsx'));
  assert.match(backend, /RetrieveUserQuotaSummary/);
  assert.match(backend, /GetUserStatus/);
  assert.match(backend, /GetCommandModelConfigs/);
  assert.match(backend, /127\.0\.0\.1/);
  assert.match(backend, /danger_accept_invalid_certs\(true\)/);
  assert.match(backend, /\.no_proxy\(\)/);
  assert.match(backend, /ManagedAgyProcess/);
  assert.match(backend, /resolve_agy_executables/);
  assert.match(backend, /native_pty_system/);
  assert.match(backend, /capture_codexbar_provider_output\([\s\S]+"antigravity",[\s\S]+"cli"/);
  assert.match(backend, /Some\("app" \| "cli" \| "ide" \| "local"\)/);
  assert.doesNotMatch(backend, /api\/oauth|accounts\.google\.com/);
  assert.match(settings, /只请求当前用户 Antigravity App、IDE 或 agy 的 127\.0\.0\.1 本地服务/);
  assert.match(settings, /内置读取失败后才调用 CodexBar CLI/);
});

test('Windows lock-screen refresh uses a fresh setter file and never reports a rejected update as success', () => {
  const commands = readSource(
    path.join(process.cwd(), 'src-tauri', 'src', 'commands', 'mod.rs'));
  const scheduler = readSource(
    path.join(process.cwd(), 'src-tauri', 'src', 'lib.rs'));
  const app = [
    readSource(path.join(process.cwd(), 'src', 'App.tsx')),
    readSource(path.join(process.cwd(), 'src', 'hooks', 'useStats.ts')),
  ].join('\n');

  assert.match(commands, /let ls_history = ls_dir\.join\(format!\("lockscreen_\{\}\.png", stamp\)\)/);
  assert.match(commands, /apply_lockscreen_setter\([\s\S]+&ls_history,[\s\S]+wallpaper::set_lockscreen/);
  assert.match(commands, /fs::copy\(current_path, attempted_path\)/);
  assert.match(commands, /setter\(attempted_path\)/);
  assert.match(commands, /return Err\(format!\("Wallpaper target was not applied: \{target\}"\)\)/);
  assert.match(scheduler, /should_refresh_lockscreen\([\s\S]+stats_changed/);
  assert.match(app, /target === 'lockscreen'[\s\S]+res\.lockscreen/);
  assert.match(app, /if \(!applied\) throw new Error/);
});

test('Claude status-line setup uses the current installed executable instead of assuming PATH', () => {
  const source = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'QuotaSection.tsx'));
  // T10.83 起改用 get_claude_quota_setup：它在可执行路径之外还带回目标设置文件、
  // 接入状态与 CLI 候选，把「照着做了却接不上」变成界面能自己说清的事。
  assert.match(source, /invoke<ClaudeQuotaSetup>\('get_claude_quota_setup'\)/);
  assert.match(source, /claudeStatuslineBlock\.includes\('--claude-statusline'\)/);
  assert.doesNotMatch(source, /<code className="settings-code">tokenledger --claude-statusline<\/code>/);
});

test('focus trap wraps only at dialog boundaries', () => {
  assert.equal(focusWrapTarget('backward', true, false), 'last');
  assert.equal(focusWrapTarget('forward', false, true), 'first');
  assert.equal(focusWrapTarget('forward', true, false), null);
});

test('tooltip text escapes log-controlled HTML before ECharts innerHTML rendering', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="globalThis.pwned=1"> & model'),
    '&lt;img src=x onerror=&quot;globalThis.pwned=1&quot;&gt; &amp; model',
  );
});

test('stats refresh preserves React identity only when visual data is unchanged', () => {
  const base = {
    summary,
    tools: {}, models: {}, trends: [], heatmap: {}, history: [],
    meta: { generatedAt: '2026-06-09T09:59:00+08:00', lastRefreshedAt: 'first' },
  };
  assert.equal(sameStatsSnapshot(base, {
    ...base,
    meta: { generatedAt: '2026-06-09T10:01:00+08:00', lastRefreshedAt: 'second' },
  }), false, 'generatedAt can advance the insight cutoff across an hour or day boundary');
  assert.equal(sameStatsSnapshot(base, {
    ...base,
    meta: { ...base.meta, lastRefreshedAt: 'second' },
  }), true, 'lastRefreshedAt alone is not visual data');
  assert.equal(sameStatsSnapshot(base, { ...base, summary: { ...summary, totalTokens: 2 } }), false);
  assert.equal(sameStatsSnapshot(base, {
    ...base,
    meta: { generatedAt: base.meta.generatedAt, contractVersion: 2, capabilities: { entityDashboard: true } },
  }), false);
  assert.equal(sameStatsSnapshot(base, {
    ...base,
    comparison: { window: { kind: 'dayOverDay' }, current: {}, previous: {}, delta: {} },
  }), false);
});

test('derived trend average reports a zero baseline as new without infinity', () => {
  const analysis = deriveTrendComparison(comparisonFixture([10, 20], [0, 0]));
  assert.deepEqual(analysis.average, {
    unit: 'hour',
    bucketCount: 2,
    current: 15,
    previous: 0,
    absolute: 15,
    percent: null,
    direction: 'new',
  });
  assert.equal(analysis.peak, null, 'a zero-only baseline must not invent a peak position');

  const bothEmpty = deriveTrendComparison(comparisonFixture([0], [0]));
  assert.equal(bothEmpty.average?.direction, 'flat');
  assert.equal(bothEmpty.average?.percent, null);
});

test('derived trend insights fail closed for empty or mismatched series', () => {
  assert.deepEqual(
    deriveTrendComparison(comparisonFixture([], [])),
    { average: null, peak: null },
  );
  assert.deepEqual(
    deriveTrendComparison(comparisonFixture([10, 20], [10])),
    { average: null, peak: null },
  );
});

test('derived daily average uses the same aligned bucket count', () => {
  const analysis = deriveTrendComparison(comparisonFixture([100, 200], [50, 100], 'day'));
  assert.deepEqual(analysis.average, {
    unit: 'day',
    bucketCount: 2,
    current: 150,
    previous: 75,
    absolute: 75,
    percent: 100,
    direction: 'up',
  });
  assert.equal(describeTrendPeakShift(analysis.peak, 'day'), '峰值位置保持在周期第2日');
});

test('peak shift summary is deterministic for earlier, later, and aligned peaks', () => {
  const cases = [
    {
      current: [0, 20, 0],
      previous: [0, 0, 30],
      movement: 'earlier',
      offsetBuckets: -1,
      summary: '峰值从02:00提前到01:00',
    },
    {
      current: [0, 0, 30],
      previous: [0, 20, 0],
      movement: 'later',
      offsetBuckets: 1,
      summary: '峰值从01:00延后到02:00',
    },
    {
      current: [0, 30, 0],
      previous: [0, 20, 0],
      movement: 'same',
      offsetBuckets: 0,
      summary: '峰值时段保持在01:00',
    },
  ];

  for (const expected of cases) {
    const analysis = deriveTrendComparison(comparisonFixture(expected.current, expected.previous));
    assert.equal(analysis.peak?.movement, expected.movement);
    assert.equal(analysis.peak?.offsetBuckets, expected.offsetBuckets);
    assert.equal(describeTrendPeakShift(analysis.peak, 'hour'), expected.summary);
  }

  const tiedCurrentPeak = deriveTrendComparison(comparisonFixture([20, 20, 0], [0, 0, 30]));
  assert.equal(tiedCurrentPeak.peak?.current.index, 0, 'equal maxima keep the earliest bucket');
  assert.equal(describeTrendPeakShift(tiedCurrentPeak.peak, 'hour'), '峰值从02:00提前到00:00');
});

test('lock-screen controls are exposed only for Windows user agents', () => {
  assert.equal(showsWindowsLockscreenControls('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), true);
  assert.equal(showsWindowsLockscreenControls('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), false);
  assert.equal(showsWindowsLockscreenControls('Mozilla/5.0 (X11; Linux x86_64)'), false);
  assert.equal(showsWindowsLockscreenControls(''), false);
});

test('macOS dynamic background controls track only Apple platform user agents', () => {
  assert.equal(isMacPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), true);
  assert.equal(isMacPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), true);
  assert.equal(isMacPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), false);
  assert.equal(isMacPlatform('Mozilla/5.0 (X11; Linux x86_64)'), false);
  assert.equal(isMacPlatform(''), false);
  // The dynamic-background affordance is a thin alias over the platform check
  // so the two stay symmetric with showsWindowsLockscreenControls.
  assert.equal(
    showsMacDynamicBackgroundControls('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'),
    true,
  );
  assert.equal(showsMacDynamicBackgroundControls('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), false);
});

test('blank window surface routes the first left mousedown only to drag', () => {
  withFakeElement(() => {
    const surface = new FakeElement({ tagName: 'header' });
    const blankTarget = new FakeElement({ parent: surface });

    assert.deepEqual(
      eligibleWindowActions(windowGestureEvent(surface, blankTarget)),
      { drag: true, maximize: false },
    );
  });
});

test('second mousedown cannot drag and a double-click routes only to maximize', () => {
  withFakeElement(() => {
    const surface = new FakeElement({ tagName: 'aside' });
    const blankTarget = new FakeElement({ parent: surface });

    assert.deepEqual(
      eligibleWindowActions(windowGestureEvent(surface, blankTarget, { detail: 2 })),
      { drag: false, maximize: true },
    );
  });
});

test('shared handlers emit exactly one native action for each eligible gesture', async () => {
  await withMockedWindow(async (commands) => {
    const surface = new FakeElement({ tagName: 'header' });
    const blankTarget = new FakeElement({ parent: surface });
    const firstMouseDown = handledWindowGestureEvent(surface, blankTarget);
    const secondMouseDown = handledWindowGestureEvent(surface, blankTarget, { detail: 2 });
    const doubleClick = handledWindowGestureEvent(surface, blankTarget, { detail: 2 });

    await handleWindowDragMouseDown(firstMouseDown);
    assert.deepEqual(commands, ['plugin:window|start_dragging']);
    assert.equal(firstMouseDown.preventDefaultCalls, 1);

    await handleWindowDragMouseDown(secondMouseDown);
    assert.deepEqual(commands, ['plugin:window|start_dragging']);
    assert.equal(secondMouseDown.preventDefaultCalls, 0);

    await handleWindowDragDoubleClick(doubleClick);
    assert.deepEqual(commands, [
      'plugin:window|start_dragging',
      'plugin:window|toggle_maximize',
    ]);
    assert.equal(doubleClick.preventDefaultCalls, 1);
  });
});

test('interactive and explicitly blocked descendants reject all window gestures', () => {
  withFakeElement(() => {
    const surface = new FakeElement({ tagName: 'header' });
    const dragBlock = new FakeElement({ parent: surface, dragBlock: true });
    const cases = [
      ['button', new FakeElement({ tagName: 'button', parent: surface })],
      ['input', new FakeElement({ tagName: 'input', parent: surface })],
      ['data-window-drag-block descendant', new FakeElement({ parent: dragBlock })],
    ];

    for (const [label, target] of cases) {
      assert.deepEqual(
        eligibleWindowActions(windowGestureEvent(surface, target)),
        { drag: false, maximize: false },
        `${label} must not initiate a drag`,
      );
      assert.deepEqual(
        eligibleWindowActions(windowGestureEvent(surface, target, { detail: 2 })),
        { drag: false, maximize: false },
        `${label} must not toggle maximize`,
      );
    }
  });
});

test('external targets, non-left buttons, and prevented events reject window gestures', () => {
  withFakeElement(() => {
    const surface = new FakeElement({ tagName: 'header' });
    const internalTarget = new FakeElement({ parent: surface });
    const externalTarget = new FakeElement();
    const cases = [
      ['external target', windowGestureEvent(surface, externalTarget)],
      ['non-left button', windowGestureEvent(surface, internalTarget, { button: 2 })],
      ['default prevented', windowGestureEvent(surface, internalTarget, { defaultPrevented: true })],
    ];

    for (const [label, event] of cases) {
      assert.equal(isWindowGesture(event, 1), false, `${label} must not initiate a drag`);
      assert.equal(
        isWindowGesture({ ...event, detail: 2 }, 2),
        false,
        `${label} must not toggle maximize`,
      );
    }
  });
});

test('chart bundle budget accepts bounded core and renderer chunks', () => {
  const result = evaluateChartBundle([
    { file: 'charts-hash.js', bytes: 376_795, gzipBytes: 130_211 },
    { file: 'chart-renderer-hash.js', bytes: 176_068, gzipBytes: 58_405 },
    { file: 'prototype-chart-extras-hash.js', bytes: 36_750, gzipBytes: 12_390 },
  ]);

  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.aggregate, { bytes: 552_863, gzipBytes: 188_616 });
});

test('chart bundle budget rejects the previous monolithic chunk shape', () => {
  const result = evaluateChartBundle([
    { file: 'charts-legacy.js', bytes: 569_885, gzipBytes: 194_806 },
    { file: 'prototype-chart-extras-hash.js', bytes: 36_750, gzipBytes: 12_390 },
  ]);

  assert.ok(result.violations.some((message) => message.includes('chart-renderer must match exactly one')));
  assert.ok(result.violations.some((message) => message.includes('charts raw size')));
  assert.ok(result.violations.some((message) => message.includes('chart aggregate raw size')));
});

test('chart bundle budget caps aggregate size even when individual chunks pass', () => {
  const result = evaluateChartBundle([
    { file: 'charts-hash.js', bytes: 390_000, gzipBytes: 135_000 },
    { file: 'chart-renderer-hash.js', bytes: 180_000, gzipBytes: 60_000 },
    { file: 'prototype-chart-extras-hash.js', bytes: 36_750, gzipBytes: 12_390 },
  ]);

  assert.ok(result.violations.some((message) => message.includes('chart aggregate raw size')));
});

test('commit policy accepts Chinese subjects and rejects English-only history', () => {
  assert.equal(validateCommitSubject('界面：统一主题与额度仪表盘（T6.1）').valid, true);
  assert.equal(validateCommitSubject('merge: visual polish').valid, false);
  assert.equal(validateCommitSubject('').valid, false);
});

test('local build archives only current artifacts and requires configured Android packaging', () => {
  const packageJson = JSON.parse(
    readSource(path.join(process.cwd(), 'package.json')),
  );
  const buildScript = readSource(
    path.join(process.cwd(), 'scripts', 'build-all-local.sh'));
  const buildLauncher = readSource(
    path.join(process.cwd(), 'scripts', 'run-build-all-local.mjs'));
  const gradleLauncher = readSource(
    path.join(process.cwd(), 'scripts', 'run-android-gradle.mjs'));

  assert.match(buildScript, /npm run build/);
  assert.doesNotMatch(buildScript, /npm run tauri build/);
  assert.doesNotMatch(buildScript, /npm run check(?:\s|$)/);
  assert.match(buildScript, /git status --porcelain --untracked-files=normal/);
  assert.match(buildScript, /cargo test --manifest-path src-tauri\/Cargo\.toml/);
  assert.match(buildScript, /cargo clippy --manifest-path src-tauri\/Cargo\.toml/);
  assert.match(buildScript, /:app:packageConfiguredDebug/);
  assert.match(buildScript, /rm -f -- "\$ANDROID_APK"/);
  assert.match(buildScript, /INCOMPLETE\.txt/);
  assert.match(buildScript, /RUN_DIR="\$RELEASE_DIR\/local-builds\/\$BUILD_ID"/);
  assert.match(buildScript, /sourceCommit=/);
  assert.doesNotMatch(buildScript, /for file in "\$RELEASE_DIR"\/\*/);
  assert.equal(packageJson.scripts['build:local'], 'node scripts/run-build-all-local.mjs');
  assert.match(buildLauncher, /Git\\\\bin\\\\bash\.exe/);
  assert.doesNotMatch(buildLauncher, /spawnSync\(['"]bash['"]/);
  assert.match(gradleLauncher, /shell: process\.platform === 'win32'/);
});

test('macOS local signed install preserves rollback and verifies the installed binary', () => {
  const script = readSource(
    path.join(process.cwd(), 'scripts', 'build-macos-local-signed.sh'));

  assert.doesNotMatch(script, /rm -rf \/Applications\/tokenledger\.app/);
  assert.match(script, /BACKUP_PATH="\$BACKUP_DIR\/TokenLedger-pre-install-\$\(date \+%Y%m%d-%H%M%S\)\.app"/);
  assert.match(script, /mv "\$INSTALL_TARGET" "\$BACKUP_PATH"/);
  assert.match(script, /codesign --verify --deep --strict --verbose=2 "\$INSTALL_TARGET"/);
  assert.match(script, /INSTALLED_SHA=/);
  assert.match(script, /BUILT_SHA=/);
  assert.match(script, /if \[\[ "\$INSTALLED_SHA" != "\$BUILT_SHA" \]\]/);
});

test('theme state resolves one shared effective palette and cycles deterministically', () => {
  assert.equal(resolveEffectiveTheme('auto', true), 'light');
  assert.equal(resolveEffectiveTheme('auto', false), 'dark');
  assert.equal(resolveEffectiveTheme('light', false), 'light');
  assert.deepEqual(
    ['auto', 'light', 'dark', 'auto'],
    ['auto', nextThemeMode('auto'), nextThemeMode('light'), nextThemeMode('dark')],
  );
});

test('theme sync ignores incomplete browser-side Tauri markers before importing native APIs', () => {
  const source = readSource(path.join(process.cwd(), 'src', 'utils', 'useTheme.ts'));
  assert.match(source, /const internals = \(window as Window &/);
  assert.match(source, /if \(!internals\?\.metadata\?\.currentWindow\?\.label\) return;/);
  assert.match(source, /import\('@tauri-apps\/api\/window'\)/);
});

test('cloud comparison refuses to present an empty previous window as verified zero', () => {
  const comparison = {
    previous: { summary: { totalRequests: 0, totalTokens: 0 } },
  };
  assert.equal(isCloudComparisonBaselineUnverified('cloud', comparison), true);
  assert.equal(isCloudComparisonBaselineUnverified('local', comparison), false);
  comparison.previous.summary.totalRequests = 1;
  assert.equal(isCloudComparisonBaselineUnverified('cloud', comparison), false);
});

test('prompt cache efficiency calculates ratio and savings correctly', () => {
  const empty = calculateCacheEfficiency(null);
  assert.deepEqual(empty, {
    kind: 'unavailable',
    totalSavedUsd: null,
  });

  const zero = calculateCacheEfficiency({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0 });
  assert.equal(zero.kind, 'unavailable');

  const highEfficiency = calculateCacheEfficiency({
    inputTokens: 200,
    outputTokens: 50,
    cachedTokens: 800,
    cacheReadTokens: 800,
    cacheWriteTokens: 0,
    totalCost: 1.20,
    cacheSavedUsd: 10.80,
  });
  assert.equal(highEfficiency.kind, 'split');
  assert.equal(highEfficiency.cacheRatioPercent, 80);
  assert.equal(highEfficiency.totalSavedUsd, 10.80);

  const moderateEfficiency = calculateCacheEfficiency({
    inputTokens: 700,
    outputTokens: 100,
    cachedTokens: 300,
    cacheReadTokens: 300,
    cacheWriteTokens: 0,
    totalCost: 2.50,
  });
  assert.equal(moderateEfficiency.kind, 'split');
  assert.equal(moderateEfficiency.cacheRatioPercent, 30);
});

test('cache efficiency prefers cacheReadTokens over combined cachedTokens', () => {
  const result = calculateCacheEfficiency({
    inputTokens: 200,
    outputTokens: 50,
    cachedTokens: 1300,
    cacheReadTokens: 800,
    cacheWriteTokens: 500,
    totalCost: 1.20,
  });

  assert.equal(result.kind, 'split');
  assert.equal(result.cacheRatioPercent, 80); // 800/(200+800)，写入缓存不计入复用
  assert.equal(result.hasCachedData, true);
});

test('year heatmap wires onSelectDate drilldown to active day cells', () => {
  let selectedDate = null;
  const currentYear = new Date().getFullYear();
  const sampleDate = `${currentYear}-01-15`;
  const heatmapData = { [sampleDate]: 5000 };

  const markup = YearHeatmap({
    heatmap: heatmapData,
    onSelectDate: (date) => { selectedDate = date; },
  });

  const jsonText = JSON.stringify(markup);
  assert.match(jsonText, new RegExp(sampleDate));
  assert.match(jsonText, /点击查看当日明细/);
  assert.match(jsonText, /role":"group"/);
  assert.doesNotMatch(jsonText, /role":"img"/);
  assert.match(jsonText, /role":"button/);
  assert.match(jsonText, /tabIndex":0/);
});

test('year heatmap date buttons keep a visible keyboard focus ring', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(css, /\.heatmap-cell\[role="button"\]:focus-visible\s*\{[\s\S]*outline:\s*2px solid var\(--color-primary-focus\);/);
  assert.match(css, /\.heatmap-cell\[role="button"\]:focus-visible\s*\{[\s\S]*outline-offset:\s*1px;/);
  const phoneBlock = css.slice(css.lastIndexOf('@media (max-width: 600px)'));
  assert.match(phoneBlock, /\.year-heatmap \{[\s\S]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);[\s\S]*row-gap:\s*12px;/);
  assert.match(phoneBlock, /\.heatmap-month-title \{\s*font-size:\s*10px;/);
  assert.match(phoneBlock, /\.heatmap-weekdays \{\s*font-size:\s*9px;/);
});

test('visual digest report export generates valid self-contained HTML with escaped data', () => {
  const sampleStats = {
    summary: {
      totalTokens: 150000,
      inputTokens: 50000,
      outputTokens: 100000,
      cachedTokens: 80000,
      totalCost: 3.45,
      totalRequests: 25,
      avgTokensPerReq: 6000,
      cacheSavedUsd: 7.20,
    },
    tools: [
      { name: 'Claude <Code>', input: 30000, output: 60000, cached: 50000 },
      { name: 'Codex "Agent"', input: 20000, output: 40000, cached: 30000 },
    ],
    models: [
      { name: 'claude-3-5-sonnet', input: 50000, output: 100000, cached: 80000, cost: 3.45 },
    ],
    trends: [],
    heatmap: {},
    meta: { stale: true },
  };

  const html = generateVisualDigestHtml({
    stats: sampleStats,
    range: 'month',
    scope: 'local',
    appVersion: '1.2.71',
    generatedAt: '2026-08-16 12:00:00',
  });

  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /TokenLedger 消耗分析简报/);
  assert.match(html, /Claude &lt;Code&gt;/);
  assert.match(html, /Codex &quot;Agent&quot;/);
  assert.doesNotMatch(html, /Claude <Code>/);
  assert.match(html, /claude-3-5-sonnet/);
  assert.match(html, /≈\$3\.45/);
  assert.match(html, /缓存口径/);
  assert.match(html, /合计 80\.0K · 未拆分/);
  assert.doesNotMatch(html, />缓存命中</);
  assert.match(html, /数据状态：缓存快照（可能不是最新）/);
  // T10.253：没有可信读写拆分/净节省契约时保持不可得，旧毛值不能冒充净值。
  assert.match(html, /缓存净节省不可得/);
  assert.doesNotMatch(html, /缓存(?:净|读取)节省 ≈\$7\.20/);
  assert.match(html, /来源未提供读写拆分，不显示流向、复用率或缓存净节省/);
  assert.doesNotMatch(html, /节省估算|节省金额/);
  // 单文件离线简报仍提供打印样式，但不依赖按钮脚本、远端资源或内联事件。
  assert.match(html, /@media print/);
  assert.match(html, /print-color-adjust: exact/);
  assert.match(html, /Content-Security-Policy[^>]+default-src 'none'/);
  assert.doesNotMatch(html, /<script\b|<link\b|\bonclick\s*=|window\.print\(|https?:\/\//i);
});

test('visual digest normalizes production Record shapes and ranks by effective tokens', () => {
  const sampleStats = {
    summary: {
      totalTokens: 300000,
      inputTokens: 200000,
      outputTokens: 100000,
      cachedTokens: 60000,
      cacheReadTokens: 48000,
      cacheWriteTokens: 12000,
      cacheSavedUsd: 4.0,
      totalCost: 9.9,
      totalRequests: 40,
      avgTokensPerReq: 7500,
    },
    tools: {
      codex: { name: 'codex', input: 80000, output: 40000, cached: 30000, total: 150000, cost: 4, requests: 20 },
      claude: { name: 'claude', input: 120000, output: 60000, cached: 30000, total: 210000, cost: 5.9, requests: 20 },
    },
    models: {
      'gpt-x': { name: 'gpt-x', total: 150000, requests: 20, input: 80000, output: 40000, cached: 30000, cost: 4 },
      'sonnet-y': { name: 'sonnet-y', total: 210000, requests: 20, input: 120000, output: 60000, cached: 30000, cost: 5.9 },
    },
    trends: [],
    heatmap: {},
  };

  const html = generateVisualDigestHtml({
    stats: sampleStats,
    range: 'week',
    scope: 'local',
    appVersion: '1.2.74',
    generatedAt: '2026-08-30 10:00:00',
  });

  // Record (the real StatsData shape) must render ranked rows, not the empty
  // state — the old array-only check left both tables empty in the shipped app.
  assert.doesNotMatch(html, /暂无工具消耗记录/);
  assert.doesNotMatch(html, /暂无模型消耗记录/);
  assert.ok(html.indexOf('claude') < html.indexOf('codex'), 'tools ranked by effective tokens');
  assert.ok(html.indexOf('sonnet-y') < html.indexOf('gpt-x'), 'models ranked by effective tokens');
  assert.match(html, /命中读 48\.0K · 写 12\.0K/);
  assert.match(html, /缓存观察/);
  assert.doesNotMatch(html, /缓存能效评估：/);
});

test('visual digest drops the reuse rate when the cache split cannot be proven', () => {
  const sampleStats = {
    summary: {
      totalTokens: 300000,
      inputTokens: 200000,
      outputTokens: 100000,
      cachedTokens: 60000,
      totalCost: 9.9,
      totalRequests: 40,
      avgTokensPerReq: 7500,
    },
    tools: {},
    models: {},
    trends: [],
    heatmap: {},
  };

  const html = generateVisualDigestHtml({
    stats: sampleStats,
    range: 'week',
    scope: 'local',
    appVersion: '1.2.74',
    generatedAt: '2026-08-30 10:00:00',
  });

  // Without an explicit read/write split the reuse KPI must read 来源未提供读写拆分
  // rather than claiming a percentage built from the combined total.
  assert.match(html, /来源未提供读写拆分，无法给出复用率/);
  assert.doesNotMatch(html, /Prompt 缓存复用率<\/div>\s*<div class="kpi-value"[^>]*>\d+/);
});

test('visual digest includes rhythm and spike rows from the shared insight rules', () => {
  const baseSummary = {
    totalTokens: 1405000, inputTokens: 700000, outputTokens: 705000,
    cachedTokens: 0, totalCost: 1, totalRequests: 5, avgTokensPerReq: 281000,
  };
  const html = generateVisualDigestHtml({
    stats: {
      summary: baseSummary,
      tools: {},
      models: {},
      heatmap: {},
      trends: [
        { date: '2026-06-01', codex: 100000 },
        { date: '2026-06-02', codex: 110000 },
        { date: '2026-06-03', codex: 90000 },
        { date: '2026-06-04', codex: 105000 },
        { date: '2026-06-05', codex: 1000000 },
      ],
      meta: {
        generatedAt: '2026-06-06T10:00:00Z',
        range: 'month',
        timezone: 'UTC',
        query: { range: 'month', timezone: 'UTC' },
      },
    },
    range: 'month', scope: 'local', appVersion: '1.2.74', generatedAt: '2026-08-30 10:00:00',
  });
  assert.match(html, /时段节奏与突增/);
  assert.match(html, /星期节奏（日均）/);
  // T10.159（审计 Q4）：6/1–6/5 每个星期几最多 1 个完整日，不按星期取日均，只写原因。
  assert.match(html, /已完成 5 天，每个星期几都不足 2 天，暂不按星期聚合/);
  assert.doesNotMatch(html, /日均消耗峰值在/);
  assert.match(html, /检出 1 个突增时段：2026-06-05 1\.00M（9\.5×）/);
});

test('visual digest distinguishes missing trends from known zero without inventing rhythm', () => {
  const stats = {
    summary: { totalTokens: 60, inputTokens: 40, outputTokens: 20, cachedTokens: 0, totalCost: 1, totalRequests: 3, avgTokensPerReq: 20 },
    tools: {}, models: {}, trends: [], heatmap: { '2026-06-01': 60 },
    meta: { generatedAt: '2026-06-30T10:00:00Z', timezone: 'UTC' },
  };
  const options = { stats, range: 'month', scope: 'local', appVersion: 'test' };
  const missing = generateVisualDigestHtml(options);
  assert.match(missing, /趋势明细未提供，无法生成星期节奏/);
  assert.doesNotMatch(missing, /本期暂无消耗|日均消耗峰值在|检出 \d+ 个突增|均未出现超过阈值/);
  const zero = generateVisualDigestHtml({ ...options, stats: { ...stats,
    summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 }, heatmap: {},
  } });
  assert.match(zero, /本期暂无消耗，色阶留空/);
  assert.doesNotMatch(zero, /趋势明细未提供|日均消耗峰值在/);
});

test('visual digest omits the insight section when buckets carry no time semantics', () => {
  const html = generateVisualDigestHtml({
    stats: {
      summary: {
        totalTokens: 40, inputTokens: 20, outputTokens: 20, cachedTokens: 0,
        totalCost: 1, totalRequests: 4, avgTokensPerReq: 10,
      },
      tools: {}, models: {}, heatmap: {},
      trends: [
        { date: '3月', codex: 1 }, { date: '4月', codex: 2 },
        { date: '5月', codex: 3 }, { date: '6月', codex: 4 },
      ],
    },
    range: 'year', scope: 'local', appVersion: '1.2.74', generatedAt: '2026-08-30 10:00:00',
  });
  assert.doesNotMatch(html, /时段节奏与突增/);
});

test('visual digest report tolerates models missing optional cost and token fields', () => {
  const sampleStats = {
    summary: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalCost: 0,
      totalRequests: 0,
      avgTokensPerReq: 0,
    },
    tools: [],
    models: [
      { name: 'opaque-model', input: undefined, output: undefined, cached: undefined, cost: undefined },
    ],
    trends: [],
    heatmap: {},
  };

  assert.doesNotThrow(() => generateVisualDigestHtml({
    stats: sampleStats,
    range: 'week',
    scope: 'local',
    appVersion: '1.2.71',
  }));
  const html = generateVisualDigestHtml({
    stats: sampleStats,
    range: 'week',
    scope: 'local',
    appVersion: '1.2.71',
  });
  assert.match(html, /opaque-model/);
  assert.match(html, /opaque-model[\s\S]*<td class="num cost-cell">不可得<\/td>/);
  assert.doesNotMatch(html, /<th class="num">估算节省<\/th>/);
});

test('visual digest download reports browser export failure instead of claiming success', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: () => { throw new Error('blob api unavailable'); },
  });
  try {
    assert.equal(downloadVisualDigest({
      stats: {
        summary: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          totalCost: 0,
          totalRequests: 0,
          avgTokensPerReq: 0,
        },
        tools: [],
        models: [],
        trends: [],
        heatmap: {},
      },
      range: 'week',
      scope: 'local',
      appVersion: '1.2.72',
    }), false);
  } finally {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL,
    });
  }
});

test('range display names use calendar-window semantics without rolling-day labels', () => {
  assert.equal(rangeDisplayName('today'), '今日');
  assert.equal(rangeDisplayName('week'), '本周');
  assert.equal(rangeDisplayName('month'), '本月');
  assert.equal(rangeDisplayName('year'), '本年度');
  assert.equal(rangeDisplayName('all'), '全部历史');
  assert.equal(rangeDisplayName('custom'), '自定义区间');
  assert.equal(rangeDisplayName('custom', { start: '2026-08-01', end: '2026-08-31' }), '8月1日—8月31日');
});

test('share card renderer exposes five stable 1080×1920 layout contracts', () => {
  const layoutKeys = ['scorecard', 'journal', 'achievement', 'receipt', 'signal'];
  assert.deepEqual(Object.keys(SHARE_LAYOUTS), layoutKeys);
  assert.equal(SHARE_CARD_WIDTH, 1080);
  assert.equal(SHARE_CARD_HEIGHT, 1920);
  for (const key of layoutKeys) {
    const layout = SHARE_LAYOUTS[key];
    assert.ok(layout, `Layout ${key} should exist`);
    assert.equal(typeof layout.name, 'string');
    assert.equal(typeof layout.description, 'string');
    assert.match(layout.accent, /^#[0-9a-f]{6}$/i);
  }
});

test('share modal uses only defined dual-theme surface tokens', () => {
  const styles = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const tokens = readSource(path.join(process.cwd(), 'src', 'styles', 'tokens.css'));
  const source = readSource(path.join(process.cwd(), 'src', 'components', 'ShareCardModal.tsx'));
  const shareStyles = styles.slice(styles.indexOf('Share Card Modal & Preview'));
  const darkTokens = themeTokenBlock(tokens, 'dark');
  const lightTokens = themeTokenBlock(tokens, 'light');
  assert.doesNotMatch(shareStyles, /var\(--color-surface(?:-[\w-]+)?\s*[,)]/);
  assert.doesNotMatch(shareStyles, /var\(--color-bg\s*[,)]/);
  for (const token of [
    '--color-bg-panel',
    '--color-bg-elevated',
    '--color-bg-elevated-2',
    '--color-bg-inset',
    '--color-bg-hover-mid',
  ]) {
    assert.match(shareStyles, new RegExp(`var\\(${token}\\)`));
    assert.match(darkTokens, new RegExp(`${token}:`));
    assert.match(lightTokens, new RegExp(`${token}:`));
  }
  assert.match(source, /<footer className="share-modal-footer">[\s\S]*复制图片[\s\S]*保存高清图片/);
  // T10.163 复核修复 P2-3：披露摘要文案改为覆盖三个导出动作（图片与 HTML
  // 简报），「导出 HTML 简报」按钮也关联上同一条摘要，不再只在 title 里
  // 提金额——读屏、键盘和触屏用户都要能看到这句披露，不只是鼠标悬停可见。
  assert.match(source, /id="share-privacy-export-summary"[\s\S]*分享与导出前：费用已隐藏/);
  // T10.154 D54、D56：开关叫「隐藏费用」；关闭时按布局写这张图实际画了哪些费用，不再笼统写「会包含金额」。
  assert.match(source, /<strong>隐藏费用<\/strong>/);
  assert.match(source, /shareCardCostFacts\(layout,[\s\S]*这张图包含：[\s\S]*这张图不含费用[\s\S]*HTML 简报包含预估费用/);
  assert.doesNotMatch(source, /隐藏金额|会包含金额|金额已隐藏/);
  assert.equal((source.match(/aria-describedby="share-privacy-export-summary"/g) || []).length, 3);
  assert.match(source, /<button ref=\{closeButtonRef\}[^>]*type="button"[^>]*aria-label="关闭弹窗"/);
  assert.match(source, /role="dialog"[\s\S]*aria-busy=\{exporting \|\| undefined\}/);
  assert.match(source, /role="radio"[\s\S]*disabled=\{exporting\}/);
  assert.match(source, /role="switch"[\s\S]*disabled=\{exporting\}/);
  assert.match(source, /share-preview-retry[\s\S]*disabled=\{exporting\}/);
  assert.match(styles, /\.share-modal-footer\s*\{[\s\S]*border-top:\s*1px solid var\(--color-border-subtle\);/);
  assert.match(styles, /\.share-export-privacy\s*\{[\s\S]*color: var\(--color-text-secondary\);/);
  assert.match(styles, /\.share-export-privacy\.is-exposed\s*\{[\s\S]*color: var\(--color-warning\);/);
  assert.match(styles, /\.share-modal-body\s*\{[\s\S]*flex:\s*1 1 auto;/);
  assert.match(styles, /\.share-modal-preview-stage\s*\{[\s\S]*height:\s*100%;/);
  assert.match(styles, /\.share-modal-canvas-preview\s*\{[\s\S]*max-height:\s*100%;/);
  assert.match(styles, /@media \(max-width: 600px\)\s*\{[\s\S]*\.header-controls > \.share-card-toggle\s*\{[\s\S]*position:\s*sticky;[\s\S]*inset-inline-end:\s*44px;[\s\S]*margin-inline-end:\s*44px;/);
  assert.match(styles, /@media \(max-width: 600px\)\s*\{[\s\S]*\.header-controls > \.segmented:first-child button\s*\{[\s\S]*padding-inline:\s*4px;/);
  assert.match(styles, /\.share-privacy-mobile\s*\{[\s\S]*display:\s*none;/);
  assert.match(styles, /@media \(max-width: 600px\)\s*\{[\s\S]*\.share-modal-preview-wrapper\s*\{[\s\S]*min-height:\s*190px;/);
  assert.match(styles, /@media \(max-width: 600px\)\s*\{[\s\S]*\.share-privacy-section\s*\{[\s\S]*display:\s*none;[\s\S]*\.share-privacy-mobile\s*\{[\s\S]*display:\s*block;[\s\S]*\.share-privacy-toggle-footer\s*\{[\s\S]*min-block-size:\s*44px;/);
  assert.match(styles, /@media \(max-width: 340px\)\s*\{[\s\S]*\.share-layout-copy small\s*\{[\s\S]*-webkit-line-clamp:\s*2;/);
});

test('share modal actions flex-wrap stays unconditional so it leaves no breakpoint gap with index.css (复核修复 R2-4)', () => {
  // 复核修复 R2-4：这条规则最初包在 `@media (min-width: 769px)` 里，和
  // index.css 的 `@media (max-width: 768px)` 之间留了 (768, 769) 这段开区间
  // CSS px 的缝隙——缝隙内 `.share-modal-actions` 退回未加宽度限制的默认
  // row + nowrap，P1-1 页脚挤压会原样复现（例如系统缩放让物理像素换算出
  // 768.x 这样的宽度）。回归守卫：规则必须是顶层无条件规则（不缩进、不包在
  // 任何媒体查询里），且 index.css 里的 column 断点仍然是 768px——两者同时
  // 成立时中间才不会再出现缝隙。
  const shareStyles = readSource(path.join(process.cwd(), 'src', 'styles', 'shareCardModal.css'));
  const indexStyles = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(shareStyles, /^\.share-modal-actions \{\n {2}flex-wrap: wrap;\n\}$/m);
  assert.doesNotMatch(shareStyles, /@media[^{]*\{[^}]*\.share-modal-actions/);
  assert.match(indexStyles, /@media \(max-width: 768px\)\s*\{[\s\S]*?\.share-modal-actions\s*\{[\s\S]*?flex-direction:\s*column;/);
});

function themeTokenBlock(tokens, theme) {
  const marker = theme === 'dark' ? ':root,' : ':root[data-theme="light"]';
  const start = tokens.indexOf(marker);
  assert.notEqual(start, -1, `Missing ${theme} theme token block`);
  const open = tokens.indexOf('{', start);
  const close = tokens.indexOf('\n}', open);
  assert.ok(open >= 0 && close >= 0, `Malformed ${theme} theme token block`);
  // Product defaults now live in @theme; unlayered theme overrides win.
  // Keep the override first because opaqueToken resolves the first declaration.
  const defaults = tokens.match(/@theme\s*\{([\s\S]*?)\n\}/);
  assert.ok(defaults, 'Missing Tailwind theme defaults');
  return `${tokens.slice(open + 1, close)}\n${defaults[1]}`;
}

function opaqueToken(block, name) {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `Missing opaque token ${name}`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g).map((channel) => Number.parseInt(channel, 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

test('dark and light theme common text colors meet 4.5:1 contrast on panels', () => {
  const tokens = readSource(path.join(process.cwd(), 'src', 'styles', 'tokens.css'));
  const foregrounds = [
    '--color-text-primary',
    '--color-text-secondary',
    '--color-text-tertiary',
    '--color-primary',
    '--color-success',
    '--color-warning',
    '--color-danger',
    '--color-info',
  ];

  for (const theme of ['dark', 'light']) {
    const block = themeTokenBlock(tokens, theme);
    const background = opaqueToken(block, '--color-bg-panel');
    for (const foregroundName of foregrounds) {
      const ratio = contrastRatio(opaqueToken(block, foregroundName), background);
      assert.ok(ratio >= 4.5, `${theme} ${foregroundName} on ${background}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test('global focus-visible and reduced-motion safeguards remain present', () => {
  const styles = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const reducedMotionMarker = '@media (prefers-reduced-motion: reduce)';
  const firstReducedMotion = styles.indexOf(reducedMotionMarker);
  const finalReducedMotion = styles.lastIndexOf(reducedMotionMarker);
  const forcedColors = styles.lastIndexOf('@media (forced-colors: active)');
  assert.ok(firstReducedMotion >= 0);
  assert.ok(finalReducedMotion > firstReducedMotion);
  assert.ok(finalReducedMotion > forcedColors);
  assert.match(styles.slice(finalReducedMotion), /transition-delay:\s*0ms !important;/);
  assert.match(styles.slice(finalReducedMotion), /animation-delay:\s*0ms !important;/);
  assert.match(styles, /:where\(button, select, input, textarea, a\):focus-visible/);
  assert.match(styles, /outline:\s*2px solid var\(--color-primary\)/);
});

test('system high-contrast mode keeps surfaces, states, inputs and focus visible', () => {
  const styles = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const tokens = readSource(path.join(process.cwd(), 'src', 'styles', 'tokens.css'));
  assert.match(tokens, /@media \(forced-colors: active\)/);
  assert.match(tokens, /--color-bg-panel:\s*Canvas;/);
  assert.match(tokens, /--color-text-primary:\s*CanvasText;/);
  assert.match(tokens, /--color-primary:\s*Highlight;/);
  assert.match(tokens, /--color-text-on-primary:\s*HighlightText;/);
  assert.match(styles, /@media \(forced-colors: active\)/);
  assert.match(styles, /forced-color-adjust:\s*auto;/);
  assert.match(styles, /:where\(input, select, textarea\)[\s\S]*background:\s*Field;/);
  assert.match(styles, /:where\(button:disabled, input:disabled, select:disabled, textarea:disabled\)[\s\S]*opacity:\s*1;/);
  assert.match(styles, /\.nav-item-active,[\s\S]*\.settings-nav-link\[aria-current='true'\][\s\S]*background:\s*Highlight !important;/);
  assert.match(styles, /:where\(button, select, input, textarea, a\):focus-visible,[\s\S]*outline:\s*2px solid Highlight !important;/);
  // T10.181：MarkText 在所有 Chromium 强制配色里都是黑色，黑底高对比下警示与危险的文字、图标、边框会整片消失。
  const forcedTokens = tokens.slice(tokens.indexOf('@media (forced-colors: active)'));
  assert.doesNotMatch(forcedTokens, /:\s*MarkText;/, 'forced-colors tokens must not map a foreground to MarkText');
  assert.match(forcedTokens, /--color-warning:\s*CanvasText;/);
  assert.match(forcedTokens, /--color-text-danger:\s*CanvasText;/);
  // T10.181：价格导入按钮在强制色彩下是有可见边框的普通按钮，而不是边框与填充同为 Highlight 的色块；
  // 云端横幅里的「立即同步」原本无边框、字色映射成 CanvasText 后与正文无从区分，同一写法（R-46 P3-1）。
  const finalForced = styles.slice(styles.lastIndexOf('@media (forced-colors: active)'));
  assert.match(finalForced, /\.price-import-button,\s*\.data-coverage-banner button \{\s*background: ButtonFace;\s*color: ButtonText;\s*border: 1px solid ButtonText;/);
  // 装饰标记使用 Canvas 底、CanvasText 图形；侧栏与分享品牌的 currentColor 也必须落到系统前景色。
  assert.match(finalForced, /\.panel-icon\.tone-primary,\s*\.badge-subtle,\s*\.share-modal-icon \{\s*background: Canvas;\s*color: CanvasText;\s*\}/);
  assert.match(finalForced, /\.sidebar-logo \{\s*color: CanvasText;\s*\}/);
});

// T10.75：门禁真实性。这三条守的是「门禁必须真的度量了什么」，而不是某段代码
// 的写法——它们存在的原因是仓库曾经同时拥有一个恒真的自评分门禁，和五处不抑制
// 任何东西的 eslint-disable 注释。
test('前端 lint 门禁真实生效且拒绝空转的 eslint-disable', () => {
  const pkg = JSON.parse(readSource(path.join(process.cwd(), 'package.json')));
  const config = readSource(path.join(process.cwd(), 'eslint.config.js'));
  const checks = readSource(path.join(process.cwd(), 'scripts', 'run-checks.mjs'));
  const releaseChecks = readSource(path.join(process.cwd(), 'scripts', 'run-release-checks.mjs'));

  // 未抑制任何错误的 disable 必须让门禁失败，否则它又会退化成装饰性注释。
  assert.match(pkg.scripts.lint, /--report-unused-disable-directives/);
  assert.match(pkg.scripts.lint, /--max-warnings 0/);

  // 这两条规则是本门禁存在的全部理由（T10.60 的明细筛选死交互）；降级成 warn
  // 或删掉，等于把那次事故的防线重新拆掉。
  assert.match(config, /'react-hooks\/rules-of-hooks':\s*'error'/);
  assert.match(config, /'react-hooks\/exhaustive-deps':\s*'error'/);

  for (const pipeline of [checks, releaseChecks]) {
    assert.match(pipeline, /\['ESLint \(react-hooks\)', npm, \['run', 'lint'\]\]/);
    assert.match(pipeline, /\['tracked path length', npm, \['run', 'check:paths'\]\]/);
  }
});

test('已删除的自评分门禁不得回到门禁链', () => {
  const pkg = JSON.parse(readSource(path.join(process.cwd(), 'package.json')));
  const checks = readSource(path.join(process.cwd(), 'scripts', 'run-checks.mjs'));
  const releaseChecks = readSource(path.join(process.cwd(), 'scripts', 'run-release-checks.mjs'));

  // check:scorecard 解析任务日志里人工填写的产品评分并断言每项 > 8.5：除非有人
  // 主动调低自己的评分，否则它永远不会失败。它不度量任何产品事实，却让门禁看起来
  // 覆盖了产品质量，并把整仓门禁绑死在一个任务日志文件上。
  assert.equal(pkg.scripts['check:scorecard'], undefined);
  assert.equal(pkg.scripts['test:scorecard'], undefined);
  assert.doesNotMatch(checks, /scorecard/);
  assert.doesNotMatch(releaseChecks, /scorecard/);
});

test('明细页筛选变化必须触发重新拉取，且抑制依赖规则时写明理由', () => {
  const app = readSource(path.join(process.cwd(), 'src', 'App.tsx'));
  const logsEffect = app.slice(
    app.indexOf('const cloudDetailsCapable ='),
    app.indexOf("if (activeTab === 'settings' && !settings.pricesDirty)"),
  );

  // T10.60 的用户可感知回归：筛选器显示「已选 1 项」，表格纹丝不动。根因是
  // detailFilters 不在依赖数组里。这条断言比 ESLint 更强——该 effect 因为
  // loadDetails 会随 stats 刷新而换身份（会重置用户分页位置）必须抑制规则，
  // 抑制之后就只剩这条契约在守筛选身份。
  assert.match(logsEffect, /void usageDetails\.loadDetails\(\);/);
  assert.match(logsEffect, /usageDetails\.detailFilters,/);
  assert.match(logsEffect, /statsHook\.dataScope,[\s\S]*statsHook\.range,[\s\S]*statsHook\.deviceFilter,/);

  // 抑制必须指名具体规则；裸 eslint-disable 会连同未来的新错误一起吞掉。
  for (const directive of app.match(/\/\/ eslint-disable(?:-next)?-line[^\n]*/gu) ?? []) {
    assert.match(directive, /eslint-disable(?:-next)?-line\s+[a-z@][\w@/-]+/u, `裸 disable：${directive}`);
  }
});

// T10.76：桌面侧诚实度。这三条守的是「界面不能在自己不知道的时候假装知道」。
test('设置目录把「读取失败」与「读取中」区分开', () => {
  const navigation = readSource(path.join(process.cwd(), 'src', 'utils', 'settingsNavigation.ts'));
  const tab = readSource(path.join(process.cwd(), 'src', 'components', 'SettingsTab.tsx'));
  // dbInfo 为 null 原本同时表示「正在读」和「读失败了」，失败后徽章会永远停在
  // 「读取中」——面板里已经显示了错误，目录却在骗人。
  assert.match(navigation, /dbInfoError: string;/);
  assert.match(navigation, /if \(state\.dbInfoError\) return \{ label: ["']读取失败["'], tone: ["']attention["'] \};/);
  assert.match(tab, /dbInfoError: props\.dataHelp\.dbInfoError,/);
});

test('额度面板说明冷启动空窗，而不是留一片空白', () => {
  const panel = readSource(path.join(process.cwd(), 'src', 'components', 'QuotaPanel.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  // T10.71 移除了启动时的额度同步（避免开机即弹钥匙串），首次后台读取由 5 分钟
  // 周期接手。在此之前面板什么都不显示，用户无法区分「还没读」和「没有来源」。
  assert.match(panel, /providers\.length === 0 && !error/);
  assert.match(panel, /quota-panel-cold-start/);
  assert.match(panel, /启动约 5 分钟后进行/);
  assert.match(panel, /还没授权任何来源时/);
  assert.match(panel, /去设置授权/);
  assert.match(css, /\.quota-panel-cold-start \{/);
});

test('钥匙串闸门清除失败必须向上暴露，而不是静默吞掉', () => {
  const quota = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'quota', 'mod.rs'));
  const commands = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'commands', 'mod.rs'));
  // 删除这个标记是「停止再向系统要钥匙串」状态的唯一出口。删除失败却继续往下走，
  // 界面表现就是「点了重试，什么都没发生」，而闸门继续生效。
  assert.match(quota, /pub\(crate\) fn remove_private_app_data_file_checked\(\s*app_data_dir: &Path,\s*file_name: &str,\s*\) -> Result<\(\), String>/);
  assert.match(commands, /const KEYRING_GATE_CLEAR_FAILED: &str =/);
  assert.match(commands, /remove_private_app_data_file_checked\([\s\S]{0,160}?CLOUD_SESSION_KEYRING_FAILURE_FILE,[\s\S]{0,80}?\.map_err\(\|error\| format!\("\{KEYRING_GATE_CLEAR_FAILED\}（\{error\}）"\)\)\?;/);
  assert.doesNotMatch(
    commands,
    /crate::quota::remove_private_app_data_file\(\s*app\.app_data_dir\(\),\s*CLOUD_SESSION_KEYRING_FAILURE_FILE,/,
  );
});

test('图表包体报告暴露余量，而不是让 0.46% 和 30% 打印同一行通过信息', async () => {
  const { BUNDLE_HEADROOM_WARNING_RATIO, formatHeadroom, headroom, tightHeadroomGroups } =
    await import('../scripts/bundle-budget.mjs');

  assert.deepEqual(headroom(562_390, 565_000), { remainingBytes: 2_610, ratio: 2_610 / 565_000 });
  assert.match(formatHeadroom(562_390, 565_000), /余量 2\.61 kB \/ 0\.46%/u);

  // 判定不变：超限才失败。这里只要求「余量吃紧」能被点名，否则撞线要等到下一个
  // 人加图表特性时才被发现。
  const tight = tightHeadroomGroups(
    {
      groups: {
        charts: { bytes: 385_990, gzipBytes: 133_480, maxBytes: 400_000, maxGzipBytes: 140_000 },
      },
      aggregate: { bytes: 562_390, gzipBytes: 191_970 },
    },
    BUNDLE_HEADROOM_WARNING_RATIO,
  );
  assert.deepEqual(tight, ['charts raw', 'charts gzip', 'aggregate raw', 'aggregate gzip']);

  const roomy = tightHeadroomGroups(
    {
      groups: { charts: { bytes: 100_000, gzipBytes: 30_000, maxBytes: 400_000, maxGzipBytes: 140_000 } },
      aggregate: { bytes: 100_000, gzipBytes: 30_000 },
    },
    BUNDLE_HEADROOM_WARNING_RATIO,
  );
  assert.deepEqual(roomy, []);

  const reporter = readSource(path.join(process.cwd(), 'scripts', 'check-bundle-budget.mjs'));
  assert.match(reporter, /tightHeadroomGroups\(result\)/);
  assert.match(reporter, /不要顺手调高阈值/);
});

// T10.79：Android 视觉系统。原型是 Compose 侧的设计先行面（本机 Gradle 不可用），
// 这几条守住的是「规范本身没被悄悄改回去」，不是像素。
test('Android 原型字阶保持 8 个 role，且可交互界面下限是 11px', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'prototypes', 'android-dashboard-prototype.css'));

  // 立项依据：Compose 主 UI 有 18 种 fontSize、121 处低于 M3 下限 11sp。
  assert.match(css, /--type-caption: 11px;/);
  const declaredRoles = [...css.matchAll(/--type-([a-z-]+): (\d+)px;/gu)].map(([, role, px]) => [role, Number(px)]);
  assert.deepEqual(
    declaredRoles.map(([role]) => role).sort(),
    ['body', 'caption', 'display', 'display-sm', 'headline', 'label', 'subtitle', 'title'],
    '字阶 role 集合被改动了',
  );
  // caption 必须是最小的一个：它就是那条下限。
  const smallest = Math.min(...declaredRoles.map(([, px]) => px));
  assert.equal(smallest, 11, 'caption 之外出现了更小的 role，下限被绕开了');

  // 手机面（摆件区段之前）不得再出现裸像素字号，也不得出现比 caption 更小的 role。
  const ambientStart = css.indexOf('@media (orientation: portrait)');
  assert.ok(ambientStart > 0, '未找到摆件区段边界');
  const phoneCss = css.slice(0, ambientStart);
  assert.doesNotMatch(phoneCss, /font-size: \d+px/u, '手机面出现了绕开字阶的裸像素字号');
});

// T10.130：上面那条只钉住原型。原型的字阶立了以后一直没落到 Compose 上——主 UI 仍是
// 32 个互不相干的裸 sp，用户在 APK 上看到的就是「字体不规范」。这条把两边钉在一起。
test('Compose 主看板字阶与原型 --type-* 逐个对齐，且不留裸 sp', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'prototypes', 'android-dashboard-prototype.css'));
  const theme = readSource(path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile', 'LedgerTheme.kt'));

  // 唯一一处命名差异：CSS 侧的 role 叫 display-sm，Kotlin 里写全为 displaySmall。
  // 别名在这里显式声明，值仍然逐个比对。
  const ROLE_ALIAS = { displaySm: 'displaySmall' };
  const cssRoles = Object.fromEntries(
    [...css.matchAll(/--type-([a-z-]+): (\d+)px;/gu)].map(([, role, px]) => {
      const camel = role.replace(/-(\w)/gu, (_, c) => c.toUpperCase());
      return [ROLE_ALIAS[camel] ?? camel, Number(px)];
    }),
  );
  const ledgerFont = theme.slice(theme.indexOf('internal object LedgerFont'), theme.indexOf('internal object AmbientFont'));
  const composeRoles = Object.fromEntries(
    [...ledgerFont.matchAll(/val (\w+): TextUnit = (\d+)\.sp/gu)].map(([, role, sp]) => [role, Number(sp)]),
  );

  assert.deepEqual(composeRoles, cssRoles, 'Compose 的 LedgerFont 与原型 --type-* 不再一致');
  assert.equal(Math.min(...Object.values(composeRoles)), 11, 'caption 之外出现了更小的档位，11sp 下限被绕开了');

  // 主看板与分享面不得再出现裸 sp 字号。息屏 / 挂件预览走 AmbientFont（是一套独立的
  // 远距离阅读排版，见 LedgerTheme.kt 的注释），所以那边只要求落在档上，不要求同一套值。
  for (const file of ['LedgerDashboardV2Ui.kt', 'SharePosterUi.kt']) {
    const source = readSource(path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile', file));
    assert.doesNotMatch(source, /fontSize = \d/u, `${file} 出现了绕开字阶的裸 sp 字号`);
  }

  // Typography 的 15 个槽位必须填满：留白的槽会回落到 Material 默认（Roboto 16/14/12sp），
  // 于是没写 fontSize 的 Text() 会跳出本项目的档位——这正是收敛前的现象之一。
  // T10.177（T10.173 §3.7）：主题从 MainActivity.kt 移到 ui/foundation/LedgerMaterialTheme.kt，槽位改为引用
  // LedgerType 的文字样式；样式自己的字号仍只经 LedgerFont。bodyLarge / bodyMedium 是 Text() 的默认样式，
  // A0 暂按旧值直写 TextStyle(fontSize = LedgerFont.*)（root 2026-09-25 决定），同样必须经 LedgerFont。
  const activity = readSource(path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile', 'MainActivity.kt'));
  assert.doesNotMatch(activity, /\bTypography\(/u, 'MainActivity.kt 又自建了一套 Typography，主题应只在 LedgerMaterialTheme.kt');
  const materialTheme = readSource(path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile', 'ui', 'foundation', 'LedgerMaterialTheme.kt'));
  const typographyStart = materialTheme.indexOf('val LedgerTypography: Typography = Typography(');
  assert.ok(typographyStart >= 0, '找不到 LedgerTypography');
  const typography = materialTheme.slice(typographyStart, materialTheme.indexOf('\n)', typographyStart) + 2);
  const slots = Object.fromEntries(
    [...typography.matchAll(/^ {4}(\w+) = (.+?),?$/gmu)].map(([, slot, value]) => [slot, value]),
  );
  assert.deepEqual(
    Object.keys(slots).sort(),
    ['bodyLarge', 'bodyMedium', 'bodySmall', 'displayLarge', 'displayMedium', 'displaySmall', 'headlineLarge',
      'headlineMedium', 'headlineSmall', 'labelLarge', 'labelMedium', 'labelSmall', 'titleLarge', 'titleMedium', 'titleSmall'],
    'Typography 槽位没填满',
  );
  const typeStart = theme.indexOf('internal object LedgerType');
  assert.ok(typeStart >= 0, '找不到 LedgerType');
  const ledgerType = theme.slice(typeStart, theme.indexOf('\n}', typeStart));
  const typeStyles = new Set(
    [...ledgerType.matchAll(/val (\w+): TextStyle = ledgerTextStyle\(fontSize = LedgerFont\.\w+,/gu)].map(([, name]) => name),
  );
  assert.equal((ledgerType.match(/val \w+: TextStyle = /gu) ?? []).length, typeStyles.size, 'LedgerType 有样式的字号没有经 LedgerFont');
  assert.doesNotMatch(ledgerType, /fontSize = \d/u, 'LedgerType 里出现了裸 sp 字号');
  for (const [slot, value] of Object.entries(slots)) {
    const style = /^LedgerType\.(\w+)$/u.exec(value)?.[1];
    if (style) {
      assert.ok(typeStyles.has(style), `Typography.${slot} 引用的 LedgerType.${style} 不存在`);
    } else {
      assert.match(value, /^TextStyle\([^)]*\bfontSize = LedgerFont\.\w+[^)]*\)$/u, `Typography.${slot} 既不是 LedgerType 样式，字号也没经 LedgerFont：${value}`);
    }
  }
  assert.doesNotMatch(typography, /fontSize = \d/u, 'Typography 里出现了裸 sp 字号');
});

test('Android 原型动效覆盖「因果需要被看见」的位置，并真正尊重 reduced-motion', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'prototypes', 'android-dashboard-prototype.css'));

  for (const token of ['--motion-fast', '--motion-base', '--motion-slow', '--ease-standard', '--ease-decelerate']) {
    assert.ok(css.includes(`${token}: `), `缺少动效 token：${token}`);
  }
  // 立项时全 App 只有 1 处动效：点了筛选后画面整块换掉，用户无法确认是自己那
  // 一下起了作用还是后台刷新恰好撞上。
  assert.match(css, /@keyframes prototype-card-enter/);
  assert.match(css, /@keyframes prototype-value-swap/);
  assert.match(css, /@keyframes prototype-sheet-in/);
  assert.match(css, /\.prototype-source-detail \{[\s\S]*?grid-template-rows: 0fr;/);

  // 只关 transition 而不关 animation，对前庭敏感用户等于没关。
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /transition: none !important;/);
  assert.match(reduced, /animation: none !important;/);
});

// T10.130：上面那条只钉原型。Compose 主 UI 立项时全 App 只有 1 处动画（一个箭头旋转），
// 而且没有任何关掉的开关——墨水屏上每一帧重绘都是可见残影，补间动画在那儿必须没有。
// T10.130：中文套等宽字体是字面意义上的"字体不规范"——Android 的等宽族没有 CJK
// 字形，汉字会逐字回落到系统默认字体，同一行里出现两种字面。数字对齐用 tnum。
test('Compose 侧不把等宽字体套在含中文的文本上，图标尺寸只有两档', () => {
  const androidUi = readAndroidDashboardUi();
  const theme = readSource(path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile', 'LedgerTheme.kt'));

  assert.match(theme, /internal const val TABULAR_NUMERALS = "tnum"/u);

  // T10.143f 拆文件后逐个文件扫（一次 Text() 调用不会跨文件），报出的行号才对得上。
  const offenders = [];
  for (const file of androidDashboardUiFiles()) {
    const lines = readSource(file).split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (!/fontFamily = (?:FontFamily\.Monospace|mono)\b/u.test(line)) return;
      const window = lines.slice(Math.max(0, index - 10), index + 3).join('\n');
      const literals = window.match(/"[^"]*"/gu) ?? [];
      if (literals.some((item) => /[\u4e00-\u9fff]/u.test(item))) offenders.push(`${path.basename(file)}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `这些行把等宽字体套在了含中文的文本上：${offenders.join('、')}`);

  // 图标尺寸此前是 16/18/19/20/22/24 六个值在管两个角色。
  // 拆分后档位常量移到 ui/foundation，跨文件引用使它们从 private 变成 internal。
  // T10.177（T10.173 §3.5）：三档由 14 / 18 / 22 改为 16 / 20 / 24，值只写在 LedgerTokens.kt 的 LedgerSize，
  // V2_ICON_* 是它的别名——档位仍是三个，各自只有一个值。
  assert.match(androidUi, /(?:private|internal) val V2_ICON_TEXT = LedgerSize\.iconText$/mu);
  assert.match(androidUi, /(?:private|internal) val V2_ICON_INLINE = LedgerSize\.iconInline$/mu);
  assert.match(androidUi, /(?:private|internal) val V2_ICON_ACTION = LedgerSize\.iconAction$/mu);
  assert.match(androidUi, /val iconText: Dp = 16\.dp$/mu);
  assert.match(androidUi, /val iconInline: Dp = 20\.dp$/mu);
  assert.match(androidUi, /val iconAction: Dp = 24\.dp$/mu);
  const rawIconSizes = androidUi.match(/modifier = Modifier\.size\(\d+(?:\.\d+)?\.dp\)/gu) ?? [];
  assert.deepEqual(rawIconSizes, [], `图标写死了尺寸，应改用 V2_ICON_* 档位：${rawIconSizes.join('、')}`);
});

test('Compose 主看板的动效走统一时长，并且墨水屏与系统关动画时退化成 0', () => {
  const theme = readSource(path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile', 'LedgerTheme.kt'));
  const androidUi = readAndroidDashboardUi();

  for (const token of ['FAST_MILLIS', 'STANDARD_MILLIS', 'EMPHASIZED_MILLIS']) {
    assert.match(theme, new RegExp(`const val ${token} = \\d+`, 'u'), `缺少动效时长档位：${token}`);
  }
  // 关掉时不是"跳过动画"，是把时长压到 0：调用方因此不需要为墨水屏各写一条分支。
  // T10.177（T10.173 §3.9）：签名加了 delayMillis 与 easing；关掉时延迟也压成 0，否则错峰入场在墨水屏上
  // 仍要空等一拍才出现。
  assert.match(theme, /fun <T> ledgerTween\(\s*durationMillis: Int,\s*enabled: Boolean = true,\s*delayMillis: Int = 0,\s*easing: Easing = LedgerEasing\.\w+\s*\)/u);
  assert.match(theme, /tween\(\s*durationMillis = if \(enabled\) durationMillis else 0,\s*delayMillis = if \(enabled\) delayMillis else 0,/u);
  assert.match(theme, /fun ledgerMotionEnabled\(isEInk: Boolean\): Boolean = !isEInk && systemAnimationsEnabled\(\)/u);
  // 系统「移除动画」改完切回应用就要生效：只在首次组合读一次，这次会话里补间会照放（T10.173 §5 第 7 条）。
  // 只看文本邻近会被变量遮蔽骗过（T10.177 评审 P3-3：观察者里写 `val enabled = …` 照样全绿，外层状态却永远不更新），
  // 所以取出整个函数体：外层状态只许声明一次；ON_RESUME 分支里是对它赋值而不是新声明；返回的就是它。
  const animationStart = theme.indexOf('fun systemAnimationsEnabled(): Boolean {');
  assert.ok(animationStart >= 0, '找不到 systemAnimationsEnabled');
  const animationBody = withoutComments(theme.slice(animationStart, theme.indexOf('\n}\n', animationStart) + 2));
  const enabledDeclarations = animationBody.match(/\b(?:val|var)\s+enabled\b/gu) ?? [];
  assert.equal(enabledDeclarations.length, 1,
    `systemAnimationsEnabled 里 enabled 声明了 ${enabledDeclarations.length} 次：观察者里的新声明会遮蔽外层状态，重读永远不生效`);
  assert.match(animationBody, /^\s*var enabled by remember\(context\) \{ mutableStateOf\(readSystemAnimationsEnabled\(context\)\) \}$/mu,
    '首次组合没有直接读当前值，或状态不是 remember 住的可变状态');
  assert.match(animationBody, /if \(event == Lifecycle\.Event\.ON_RESUME\) \{\s*\n\s*enabled = readSystemAnimationsEnabled\(context\)\s*\n\s*\}/u,
    '关闭动画的系统设置没有在回到前台时重读');
  assert.match(animationBody, /removeObserver\(observer\)/u, '生命周期观察者没有在离开组合时移除');
  assert.match(animationBody, /\n\s*return enabled\n\}$/u, 'systemAnimationsEnabled 返回的不是那份会被重读的状态');

  // 因果需要被看见的四处：按压、模式切换、展开收起、数值/长度变化。
  assert.match(androidUi, /fun Modifier\.pressScale\([\s\S]{0,400}?collectIsPressedAsState\(\)/u, '图标缺少按压反馈');
  assert.match(androidUi, /animateColorAsState\([\s\S]{0,700}?label = "segmentContainer"/u, '分段控件选中态缺少过渡');
  assert.match(androidUi, /AnimatedVisibility\([\s\S]{0,300}?expandVertically\(\s*ledgerTween/u, '展开收起缺少动画');
  assert.match(androidUi, /animateFloatAsState\([\s\S]{0,300}?label = "dataBar"/u, '数据条长度变化缺少过渡');
  assert.match(androidUi, /animateFloatAsState\([\s\S]{0,300}?label = "quotaProgress"/u, '额度进度缺少过渡');

  // 每一处动效都必须经过 ledgerTween；直接写 tween(...) 就绕过了墨水屏开关。
  const rawTween = androidUi.match(/(?<!ledger)\btween\(/gu) ?? [];
  assert.deepEqual(rawTween, [], '主看板出现了绕开 ledgerTween 的裸 tween()');
  // animateFloatAsState / animateColorAsState 默认 spec 是 spring，同样绕过开关。
  const animateCalls = androidUi.match(/animate(?:Float|Color)AsState\([\s\S]{0,700}?label = "[^"]*"/gu) ?? [];
  assert.ok(animateCalls.length >= 4, `动效调用点太少：${animateCalls.length}`);
  for (const call of animateCalls) {
    assert.match(call, /animationSpec = ledgerTween\(/u, `这处动效没走 ledgerTween：${call.slice(0, 80)}`);
  }
});

test('Android 原型的额度条颜色只表达剩余量，厂商身份交给圆点', async () => {
  const { quotaSeverity } = await import('../src/prototypes/AndroidDashboardPrototype.tsx');
  const css = readSource(path.join(process.cwd(), 'src', 'prototypes', 'android-dashboard-prototype.css'));

  // 此前进度条是厂商色（violet/blue），同一个通道既说「哪个厂商」又被用来暗示
  // 「数据陈旧」；而且 57% 和 8% 剩余长得一模一样。
  // D4（T10.161）：与桌面、Android 应用和小组件同为严格小于 20% 告急、小于 50% 偏紧。
  assert.equal(quotaSeverity(72), 'healthy');
  assert.equal(quotaSeverity(50), 'healthy');
  assert.equal(quotaSeverity(49), 'warning');
  assert.equal(quotaSeverity(20), 'warning');
  assert.equal(quotaSeverity(19), 'critical');
  assert.equal(quotaSeverity(0), 'critical');

  assert.doesNotMatch(css, /\.prototype-progress span\.(violet|blue)/u, '进度条不得再用厂商色');
  for (const level of ['healthy', 'warning', 'critical']) {
    assert.ok(css.includes(`.prototype-progress span.${level}`), `进度条缺少档位：${level}`);
    assert.ok(css.includes(`.prototype-quota-remaining.${level}`), `百分比文字缺少档位：${level}`);
  }
  // 颜色不能是唯一线索。
  assert.match(css, /\.prototype-progress:has\(span\.critical\)[\s\S]*?box-shadow/u);
});

/** WCAG 相对亮度；入参是 Kotlin 里 `Color(0xAARRGGBB)` 的八位十六进制。 */
function wcagLuminance(argb) {
  const channel = (hex) => {
    const v = parseInt(hex, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(argb.slice(2, 4)) + 0.7152 * channel(argb.slice(4, 6)) + 0.0722 * channel(argb.slice(6, 8));
}

function wcagContrast(a, b) {
  const [x, y] = [wcagLuminance(a), wcagLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `ui/foundation/LedgerTokens.kt` 里三套令牌的单色角色（`名字 = Color(0xAARRGGBB)`），按主题分组。 */
function readAndroidTokenPalettes() {
  const source = readSource(path.join(ANDROID_MOBILE_DIR, 'ui', 'foundation', 'LedgerTokens.kt'));
  const themes = {};
  for (const [, theme, body] of source.matchAll(/val (\w+): LedgerColors = LedgerColors\(([\s\S]*?)\n {4}\)/gu)) {
    themes[theme] = Object.fromEntries(
      [...body.matchAll(/^\s+(\w+) = Color\(0x([0-9A-Fa-f]{8})\)/gmu)].map(([, role, argb]) => [role, argb.toUpperCase()]),
    );
  }
  return themes;
}

/**
 * 从 Kotlin 源码里读出三套配色，避免测试自带一份会过期的副本。
 *
 * T10.177 起色值只写在 LedgerTokens.kt；v2Palette 的旧字段（background、surface、blue、green…）是
 * MobileV2Palette 里 `val x: Color get() = tokens.y` 的别名。两边都从源码读：先取令牌，再按别名展开出旧字段名，
 * 契约检查的因此仍是界面真正拿来写字的那一档（green / amber / danger 指向 *Text，violet 指向 accent）。
 *
 * 每个 `val x: Color get() = …` 都必须是纯别名 `tokens.y`，否则就要原样列进 [MOBILE_V2_PALETTE_NON_ALIASES]：
 * 带变换的写法（`.copy(alpha = …)`、条件、运算）解析不出别名时，旧写法会回落到同名令牌去检查，
 * `faint = tokens.faint.copy(alpha = 0.5f)` 因此照样全绿（T10.177 评审 P3-2）。
 */
const MOBILE_V2_PALETTE_NON_ALIASES = {
  // 墨水屏没有「卡内较深的填充」，退到 raised；两个分支都是令牌，调用方不拿它写字，契约不展开。
  surfaceContainerHigh: 'if (tokens.isEInk) tokens.raised else tokens.surfaceContainerHigh',
};

function readAndroidPalettes() {
  const themes = readAndroidTokenPalettes();
  const palette = readSource(path.join(ANDROID_MOBILE_DIR, 'ui', 'foundation', 'MobileV2Palette.kt'));
  assert.doesNotMatch(palette, /Color\(0x/u, 'MobileV2Palette.kt 又写了色值：色值只许在 LedgerTokens.kt');
  const fields = [...palette.matchAll(/^ {4}val (\w+): Color\b(.*)$/gmu)];
  const aliases = [];
  const irregular = [];
  for (const [, field, rest] of fields) {
    const alias = /^ get\(\) = tokens\.(\w+)$/u.exec(rest);
    if (alias) {
      aliases.push([field, alias[1]]);
    } else if (!(field in MOBILE_V2_PALETTE_NON_ALIASES) || / get\(\) = (.+)$/u.exec(rest)?.[1] !== MOBILE_V2_PALETTE_NON_ALIASES[field]) {
      irregular.push(`${field}:${rest}`);
    }
  }
  assert.deepEqual(irregular, [],
    `MobileV2Palette 的这些颜色字段不是纯别名 tokens.x，也不在豁免表里（带变换的别名会让契约回落到同名令牌、漏检）：\n  ${irregular.join('\n  ')}`);
  for (const field of Object.keys(MOBILE_V2_PALETTE_NON_ALIASES)) {
    assert.ok(fields.some(([, name]) => name === field), `豁免表里的 ${field} 已不在 MobileV2Palette 里，请删掉这一条`);
  }
  assert.ok(aliases.length >= 15, `MobileV2Palette 的别名解析失败：只读到 ${aliases.length} 项`);
  // 下面这条契约拿来检查的旧字段必须都经别名解析：缺了别名就会悄悄改查同名令牌。
  for (const field of ['background', 'surface', 'raised', 'text', 'muted', 'faint', 'blue', 'green', 'amber', 'violet', 'danger']) {
    assert.ok(aliases.some(([name]) => name === field), `MobileV2Palette 缺少别名 ${field}，契约会回落到同名令牌去检查`);
  }
  const palettes = {};
  for (const [theme, roles] of Object.entries(themes)) {
    const resolved = { ...roles };
    for (const [field, role] of aliases) {
      assert.ok(roles[role], `${theme} 的别名 ${field} 指向不存在的令牌 ${role}`);
      resolved[field] = roles[role];
    }
    palettes[theme] = resolved;
  }
  return palettes;
}

test('Android 三套配色的正文色都过 WCAG AA', () => {
  const palettes = readAndroidPalettes();
  assert.deepEqual(Object.keys(palettes).sort(), ['Dark', 'EInk', 'Light']);

  // 全 App 最小的字（11sp caption）用的是 faint，此前它恰好是对比度最低的颜色——
  // 浅色卡片上只有 2.86:1，深色 3.39:1。最小的字最需要对比度，之前正好反了。
  // selected 不在其列：它只承载 palette.text（见 V2SegmentedToggle 的 contentColor）。
  // T10.177：浮层（底部面板、菜单、读数气泡）成为第四档表面 popover，一并检查。
  const surfaces = ['background', 'surface', 'raised', 'popover'];
  const foregrounds = ['text', 'muted', 'faint', 'blue', 'green', 'amber', 'violet', 'danger'];
  for (const [theme, roles] of Object.entries(palettes)) {
    for (const fg of foregrounds) {
      for (const bg of surfaces) {
        const contrast = wcagContrast(roles[fg], roles[bg]);
        assert.ok(contrast >= 4.5,
          `${theme} 的 ${fg} 落在 ${bg} 上只有 ${contrast.toFixed(2)}:1，AA 正文要求 4.5:1`);
      }
    }
  }

  // 三档必须仍然是三档：抬高 faint 之后 muted 也得跟着走，否则次级与三级会糊在一起。
  for (const [theme, roles] of Object.entries(palettes)) {
    const ladder = ['text', 'muted', 'faint'].map((role) => wcagContrast(roles[role], roles.raised));
    assert.ok(ladder[0] > ladder[1] && ladder[1] > ladder[2],
      `${theme} 的三档文字色不再单调递减：${ladder.map((v) => v.toFixed(2)).join(' > ')}`);
    assert.ok(ladder[1] / ladder[2] >= 1.4,
      `${theme} 的 muted 与 faint 挤在一起（${ladder[1].toFixed(2)} vs ${ladder[2].toFixed(2)}）`);
  }
});

/** 安卓主看板源码目录：下面几条契约都在这里取源。 */
const ANDROID_MOBILE_DIR = path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile');

/**
 * 去掉整行注释再做「两个片段挨得够近」这类断言。
 *
 * 注入验证时踩到过：`current.isEmpty()` 与 `drawLine(palette.divider` 之间隔着三行
 * 中文注释就超过了 200 字的窗口，于是 bug 注回去契约照样全绿。
 */
const withoutComments = (source) => source.replace(/^\s*\/\/.*$/gmu, '');

/**
 * 安卓看板界面的源码文件。T10.143f（`e491e0e3`）把 8,901 行的 LedgerDashboardV2Ui.kt 按职责拆进
 * `ui/**`，原文件只剩转发门面；跨文件调用又把这些声明从 private 改成了 internal。此后仍按
 * 「LedgerDashboardV2Ui.kt 里的 private fun X」取源的契约全部落空——`indexOf` 返回 -1，切出来的
 * 不是空串就是跨文件的错段，这批断言因此常红、被当成基线噪声（T10.166 逐条核对）。
 * 这些契约守的是「看板界面有没有这段语义」，与它落在哪个文件、写成哪种可见性无关：
 * 整体断言读门面 + `ui/**` 的全部源码，函数级断言按声明名只取那一个声明。
 */
function androidDashboardUiFiles() {
  const files = [path.join(ANDROID_MOBILE_DIR, 'LedgerDashboardV2Ui.kt')];
  (function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.kt')) files.push(child);
    }
  })(path.join(ANDROID_MOBILE_DIR, 'ui'));
  return files;
}

function readAndroidDashboardUi() {
  return androidDashboardUiFiles().map((file) => readSource(file)).join('\n');
}

/**
 * 按名字取 `ui/**` 里的顶层函数声明全文（到下一处顶格的声明、注解或注释为止），不看可见性修饰符。
 * 只在实现里找：门面 LedgerDashboardV2Ui.kt 里的同名函数只是一行转发。找不到或声明了不止一处
 * 都直接失败，不会像 `indexOf` 落空那样悄悄切出空串。传多个名字时按顺序拼接，对应旧切片
 * 一并跨过的那几个相邻声明。
 */
function androidUiDeclaration(...names) {
  const sources = androidDashboardUiFiles().slice(1).map((file) => readSource(file));
  return names.map((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const header = new RegExp(`^(?:(?:private|internal|public) )?fun (?:<[^>\\n]+> )?${escaped}\\(`, 'gmu');
    const hits = sources.flatMap((source) => [...source.matchAll(header)].map((match) => [source, match.index]));
    assert.equal(hits.length, 1, `${name} 应当在 ui/** 里恰好声明一次，实际 ${hits.length} 处`);
    const [source, start] = hits[0];
    // 块体函数以顶格 `}` 收尾、多行参数表以顶格 `)` 收尾，这两种顶格行仍属本声明。
    const next = /\n(?=[^\s)}])/gu;
    next.lastIndex = start;
    const end = next.exec(source)?.index ?? source.length;
    return source.slice(start, end);
  }).join('\n');
}

test('Android 排版间距落在 2px 栅格上', () => {
  const dir = path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile');
  const files = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.kt')) files.push(child);
    }
  })(dir);
  assert.ok(files.length >= 5, `安卓源码扫描到的文件太少：${files.length}`);
  const relative = (file) => path.relative(dir, file).split(path.sep).join('/');

  // T10.173 §3.6 / T10.177：改为 4dp 基础栅格，2dp 半格只能经 LedgerSpace.hairline（标题沿用旧名，便于按名定位）。
  // 新规则按路径逐步生效：A0 先管 ui/foundation/**；A1–A10 各自完成后把自己的路径加进 STRICT_GRID_PATHS，
  // A10 覆盖全部 mobile/** 后删掉下面的过渡期旧规则与 PENDING。
  const STRICT_GRID_PATHS = ['ui/foundation/'];
  const isStrict = (file) => STRICT_GRID_PATHS.some((prefix) => relative(file).startsWith(prefix));
  assert.ok(files.some(isStrict), `新规则的路径一个文件都没扫到：${STRICT_GRID_PATHS.join('、')}`);

  // ——新规则——间距（padding / spacedBy / Spacer / offset）与尺寸（size / width / height 系列）的 dp 字面量
  // 只能是 0 或 4 的倍数，其余写 LedgerSpace / LedgerSize 常量；厚度（border / BorderStroke / Stroke / drawLine /
  // strokeWidth / thickness）一律不许写 dp 字面量，只能用 LedgerStroke。字面量按「最内层还没闭合的调用」归类，
  // 跨行的调用同样认得出；旧规则那种「附近几行有没有 divider 字样就放行」的启发式在这里不用——
  // 同一个 1dp 放在不同位置结果不同，守不住。
  const SPACING_CALLS = new Set(['padding', 'absolutePadding', 'paddingFromBaseline', 'PaddingValues', 'spacedBy', 'Spacer', 'offset', 'absoluteOffset']);
  const SIZE_CALLS = new Set(['size', 'width', 'height', 'widthIn', 'heightIn', 'sizeIn', 'requiredSize', 'requiredWidth',
    'requiredHeight', 'requiredSizeIn', 'requiredWidthIn', 'requiredHeightIn', 'defaultMinSize']);
  const THICKNESS_CALLS = new Set(['border', 'BorderStroke', 'Stroke', 'drawLine']);
  const THICKNESS_KEYS = new Set(['strokeWidth', 'thickness']);
  // T10.177 评审 P3-4：圆角与绘制代码里的 `.dp.toPx()` 同样只能走令牌（LedgerRadius / LedgerSpace / LedgerSize / LedgerStroke）。
  const RADIUS_CALLS = new Set(['RoundedCornerShape', 'AbsoluteRoundedCornerShape', 'CutCornerShape', 'CornerRadius']);
  const RADIUS_KEYS = new Set(['cornerRadius', 'topStart', 'topEnd', 'bottomStart', 'bottomEnd']);
  // 注释与字符串换成空格（保留换行，行号不变），括号配对才不会被注释或字符串里的括号带偏。
  const codeOnly = (source) => {
    const out = [];
    let i = 0;
    const blank = (stop) => {
      out.push(source.slice(i, stop).replace(/[^\n]/gu, ' '));
      i = stop;
    };
    while (i < source.length) {
      if (source.startsWith('//', i)) blank(source.indexOf('\n', i) < 0 ? source.length : source.indexOf('\n', i));
      else if (source.startsWith('/*', i)) blank(source.indexOf('*/', i + 2) < 0 ? source.length : source.indexOf('*/', i + 2) + 2);
      else if (source.startsWith('"""', i)) blank(source.indexOf('"""', i + 3) < 0 ? source.length : source.indexOf('"""', i + 3) + 3);
      else if (source[i] === '"' || source[i] === "'") {
        let j = i + 1;
        while (j < source.length && source[j] !== source[i] && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
        blank(Math.min(j + 1, source.length));
      } else {
        out.push(source[i]);
        i += 1;
      }
    }
    return out.join('');
  };
  const enclosingCall = (code, index) => {
    let depth = 0;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (code[i] === ')') depth += 1;
      else if (code[i] === '(') {
        if (depth === 0) return /(\w+)\s*$/u.exec(code.slice(Math.max(0, i - 80), i))?.[1] ?? '';
        depth -= 1;
      }
    }
    return '';
  };
  const strictOffenders = [];
  for (const file of files.filter(isStrict)) {
    const code = codeOnly(readSource(file));
    for (const match of code.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)\.dp\b/gu)) {
      const value = Number(match[1]);
      const call = enclosingCall(code, match.index);
      const lineStart = code.lastIndexOf('\n', match.index) + 1;
      const key = /(\w+)\s*=(?![=>])[^=]*$/u.exec(code.slice(lineStart, match.index))?.[1];
      const where = `${relative(file)}:${code.slice(0, match.index).split('\n').length} ${match[0]}（${call || key || '?'}）`;
      if (THICKNESS_CALLS.has(call) || THICKNESS_KEYS.has(key)) {
        strictOffenders.push(`${where} — 厚度只能用 LedgerStroke.*`);
      } else if (RADIUS_CALLS.has(call) || RADIUS_KEYS.has(key)) {
        strictOffenders.push(`${where} — 圆角只能用 LedgerRadius.*`);
      } else if (code.startsWith('.toPx()', match.index + match[0].length)) {
        strictOffenders.push(`${where} — 绘制里的尺寸也要走令牌（LedgerSpace / LedgerSize / LedgerStroke / LedgerRadius）`);
      } else if ((SPACING_CALLS.has(call) || SIZE_CALLS.has(call)) && value % 4 !== 0) {
        strictOffenders.push(`${where} — 不在 4dp 栅格上（2dp 半格用 LedgerSpace.hairline）`);
      }
    }
  }
  assert.deepEqual(strictOffenders, [], `间距与尺寸不在 4dp 栅格上，或厚度、圆角、绘制尺寸没走令牌：\n  ${strictOffenders.join('\n  ')}`);

  // ——过渡期旧规则（尚未迁入新规则的路径）——原样保留：
  // T10.79 原型立了 --space-05..--space-8（2/4/8/12/16/20/24/32），Compose 这边一度是
  // 1/1.5/3/5/7/9/13/21 的临时值——同一种间隙在不同卡片里能写成 3dp、5dp、7dp 三个样子。
  // 奇数值一律视为"随手写的"，除非它是元件厚度（分隔线、进度条），那要在同一行自证。
  const spacingCall = /\b(?:padding|spacedBy|width|height|size)\s*\(\s*(?:[A-Za-z]+\s*=\s*)?(\d+(?:\.\d+)?)\.dp/gu;
  const shapeish = /RoundedCornerShape|cornerRadius|\.border\(|strokeWidth|blurRadius|elevation|CircleShape/u;
  const thickness = /divider|LinearProgressIndicator|正在刷新数据/u;
  // 已知越格、方案已定值、归属别的任务的，逐条列出；修掉（或该路径迁入新规则）后必须一并删掉这里的条目，
  // 下面会检查每条仍恰好命中一处，过期的条目不会悄悄留着变成豁免。
  const PENDING = [];
  const pendingHits = new Map(PENDING.map((item) => [item, 0]));

  const offGrid = [];
  for (const file of files.filter((candidate) => !isStrict(candidate))) {
    const lines = readSource(file).split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (shapeish.test(line)) return;
      for (const match of line.matchAll(spacingCall)) {
        const value = Number(match[1]);
        if (value % 2 === 0) continue;
        // 元件厚度可以是奇数，但必须自证：要么同行画的就是分隔线，
        // 要么前后几行是进度条。1dp 的发丝线、3dp 的刷新条都属此列。
        const context = lines.slice(Math.max(0, index - 5), index + 3).join('\n');
        if (thickness.test(context)) continue;
        const pending = PENDING.find((item) => item.file === relative(file) && line.includes(item.code));
        if (pending) {
          pendingHits.set(pending, pendingHits.get(pending) + 1);
          continue;
        }
        offGrid.push(`${relative(file)}:${index + 1} ${value}dp — ${line.trim().slice(0, 70)}`);
      }
    });
  }
  assert.deepEqual(offGrid, [], `排版间距不在 2px 栅格上：\n  ${offGrid.join('\n  ')}`);
  for (const [item, hits] of pendingHits) {
    assert.notEqual(hits, 0, `PENDING 的 ${item.file} ${item.code}（归 ${item.owner}）已经不在了：修掉了（或该路径迁入了新规则）就请删除这一条`);
    assert.equal(hits, 1, `PENDING 的 ${item.file} ${item.code}（归 ${item.owner}）命中 ${hits} 处：多出来的是新写的越格值，PENDING 只豁免登记时那一处，请把新的改到栅格上`);
  }
});

test('Android 错误横幅用 onErrorContainer，三套主题成对定义', () => {
  const main = readSource(path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java',
    'com', 'jeidorf', 'tokenledger', 'mobile', 'MainActivity.kt'));

  // 会话过期那一屏，横幅底是 errorContainer，字却用了 error（本意是画在 surface 上的强调色）。
  // 真机实测 #FF6B7A on #8C1D18 只有 3.31:1——唯一说明出了什么事的那行字最不可读。
  // 坐在 container 上的文字必须用 onContainer。
  assert.match(main, /containerColor = MaterialTheme\.colorScheme\.errorContainer[\s\S]{0,600}?color = MaterialTheme\.colorScheme\.onErrorContainer/u,
    '错误横幅的文字没有用 onErrorContainer');
  assert.doesNotMatch(main, /Text\([^)]*color = MaterialTheme\.colorScheme\.error\)/u,
    'error 又被当成正文色用了；它是画在 surface 上的强调色');

  // 自定义了 error 却让容器落回 M3 默认值，两者就不再是一对，对比度无人负责。
  // T10.177（T10.173 §3.2）：三套配色移到 ui/foundation/LedgerTokens.kt，M3 ColorScheme 由
  // LedgerMaterialTheme.kt 的 ledgerColorScheme 逐槽从令牌取值。「成对」因此分两处守：三套令牌各自写了
  // errorContainer 与 onErrorContainer，且这一对过 AA；ColorScheme 把 error 一族四个槽都显式接上令牌。
  assert.doesNotMatch(main, /(?:darkColorScheme|lightColorScheme)\(|\bColorScheme\(/u, 'MainActivity.kt 又自建了一套配色，应只在 LedgerMaterialTheme.kt');
  const tokens = readAndroidTokenPalettes();
  assert.deepEqual(Object.keys(tokens).sort(), ['Dark', 'EInk', 'Light'], `应有深色/浅色/墨水屏三套配色，实际 ${Object.keys(tokens).join('、')}`);
  for (const [theme, roles] of Object.entries(tokens)) {
    assert.ok(roles.errorContainer, `${theme} 没有定义 errorContainer`);
    assert.ok(roles.onErrorContainer, `${theme} 没有定义 onErrorContainer`);
    const ratio = wcagContrast(roles.onErrorContainer, roles.errorContainer);
    assert.ok(ratio >= 4.5, `${theme} 的 onErrorContainer 落在 errorContainer 上只有 ${ratio.toFixed(2)}:1`);
  }
  const materialTheme = readSource(path.join(ANDROID_MOBILE_DIR, 'ui', 'foundation', 'LedgerMaterialTheme.kt'));
  const schemeStart = materialTheme.indexOf('fun ledgerColorScheme(c: LedgerColors): ColorScheme = ColorScheme(');
  assert.ok(schemeStart >= 0, '找不到 ledgerColorScheme');
  const scheme = materialTheme.slice(schemeStart, materialTheme.indexOf('\n)', schemeStart));
  for (const slot of ['error', 'onError', 'errorContainer', 'onErrorContainer']) {
    assert.match(scheme, new RegExp(`\\n {4}${slot} = c\\.${slot === 'error' ? 'danger' : slot},?\\n`, 'u'), `ColorScheme 的 ${slot} 没有接上对应令牌`);
  }
  assert.match(materialTheme, /colorScheme = ledgerColorScheme\(LedgerPalettes\.of\(appearance\)\)/u, '三套外观没有都经 ledgerColorScheme');
});

test('Android 挂件与正文共用同一套配色', () => {
  const p = (...parts) => path.join(process.cwd(), 'apps', 'android', 'app', 'src', ...parts);
  const MOBILE = ['main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile'];
  const widgetTheme = readSource(p(...MOBILE, 'widget', 'WidgetTheme.kt'));
  const widgetUi = readSource(p(...MOBILE, 'widget', 'TokenLedgerWidget.kt'));

  // 挂件是同一套色的另一份实现。改正文而漏掉挂件，两边就会分叉——
  // 对比度整改时正好踩到：faint 在正文改了，挂件还留着旧值。
  // T10.177（T10.173 §3.1「规则」）：挂件不再有自己的色值，深浅两套直接取 LedgerTokens 的 LedgerPalettes，
  // 与正文是同一个对象。原先「两份拷贝逐项相等」的比对随之删除（已没有第二份可比），改为守住「没有第二份」：
  // WidgetTheme.kt 里不许出现任何 0x 色值字面量，每个 *Color 都直接取令牌。
  assert.doesNotMatch(widgetTheme, /0x[0-9A-Fa-f]{6}/u, 'WidgetTheme.kt 又出现了色值字面量，色值只许写在 LedgerTokens.kt');
  assert.doesNotMatch(widgetTheme, /\bpick\(/u, '挂件又出现了自己的 pick(day, night) 色板');
  assert.match(widgetTheme, /private val tokens: LedgerColors = if \(night\) LedgerPalettes\.Dark else LedgerPalettes\.Light/u,
    '挂件没有从 LedgerPalettes 取色');
  const colors = [...widgetTheme.matchAll(/^ {4}val (\w+Color): Color = (.+)$/gmu)];
  assert.ok(colors.length >= 10, `挂件配色解析失败：只读到 ${colors.length} 项`);
  for (const [, name, source] of colors) {
    assert.match(source, /^tokens\.\w+$/u, `挂件的 ${name} 没有直接取令牌：${source}`);
  }

  // 色值每个角色只许写一处：ColorProvider 与 Argb 都必须从 *Color 派生。
  const providers = [...widgetTheme.matchAll(/^ {4}val (\w+): ColorProvider = (.+)$/gmu)];
  assert.ok(providers.length >= 10, `挂件 ColorProvider 解析失败：只读到 ${providers.length} 项`);
  for (const [, name, source] of providers) {
    assert.match(source, /^ColorProvider\(\w+Color\)$/u, `挂件 ColorProvider ${name} 不是从单一色源派生：${source}`);
  }
  const argbs = [...widgetTheme.matchAll(/^ {4}val (\w+Argb): Int = (.+)$/gmu)];
  assert.ok(argbs.length >= 5, `挂件圆环位图色解析失败：只读到 ${argbs.length} 项`);
  for (const [, name, source] of argbs) {
    assert.match(source, /^\w+Color\.toArgb\(\)$/u, `挂件 ${name} 不是从 *Color 派生（圆环与进度条会分色）：${source}`);
  }
  assert.match(widgetUi, /faintArgb\(\): Int = faintColor\.toArgb\(\)/u, 'faintArgb 又抄了一份色值');

  // A0 验收（T10.173 §8.1）：除墨水屏灰阶与海报渲染器的艺术色外，色值只出现在 LedgerTokens.kt。
  // 墨水屏灰阶必须是不透明、无色相（R = G = B）的灰，并且就在「墨水屏为真」的分支里。
  // T10.177 评审 P3-1 收紧了两处：
  // ① 旧写法只看前两行有没有 EInk 字样，`if (palette.isEInk) Color(0xFF000000) else Color(0xFF9E9E9E)` 的
  //    非墨水屏灰因此被放行。现在只认 `if (…isEInk[ && …]) <这里>`、`if (…isEInk) {` 块内、`isEInk -> <这里>`（同一行）：
  //    isEInk 被取反，或它与字面量之间隔着 else、}、||、另一个 ->，都不算；
  // ② 命名色（Color.White / Color.Black 等、Color(red = …)、Color(0.5f, …)、android.graphics.Color）一并扫描，
  //    墨水屏分支之外刻意保留的逐条登记在 NAMED_COLOR_ALLOWED，写明理由或归属。
  const mobileFiles = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.kt')) mobileFiles.push(child);
    }
  })(ANDROID_MOBILE_DIR);
  const COLOR_SOURCE_EXEMPT = new Set(['ui/foundation/LedgerTokens.kt', 'SharePosterRenderer.kt']);
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, ' '))
    .replace(/\/\/[^\n]*/gu, (line) => ' '.repeat(line.length));
  const einkTrueBranch = (code, at) => {
    const window = code.slice(Math.max(0, at - 240), at);
    const marker = window.lastIndexOf('isEInk');
    if (marker < 0 || /!\s*(?:[\w.]+\.)?$/u.test(window.slice(0, marker))) return false;
    const between = window.slice(marker + 'isEInk'.length);
    if (/\belse\b|\}|\|\|/u.test(between)) return false;
    if (/^\s*->/u.test(between)) return !between.includes('\n');
    const condition = /^\s*(?:&&[^\n]*?)?\)\s*(\{)?/u.exec(between);
    if (!condition) return false;
    const rest = between.slice(condition[0].length);
    if (rest.includes('->')) return false;
    return condition[1] ? (rest.match(/\n/gu) ?? []).length <= 3 : !between.includes('\n');
  };
  const GREY_NAMED = new Set(['White', 'Black', 'Gray', 'Grey', 'DarkGray', 'LightGray']);
  const COLOR_USE = /\bColor\(0x([0-9A-Fa-f]+)\)|\bColor\.(White|Black|Red|Green|Blue|Gray|Grey|DarkGray|LightGray|Yellow|Cyan|Magenta)\b|\bColor\(\s*(?:red|green|blue|alpha)\s*=|\bColor\(\s*(?!0x)\d|\bColor\.(?:parseColor|rgb|argb|valueOf)\(|\bandroid\.graphics\.Color\.\w+/gu;
  const strayColors = [];
  for (const file of mobileFiles) {
    const rel = path.relative(ANDROID_MOBILE_DIR, file).split(path.sep).join('/');
    if (COLOR_SOURCE_EXEMPT.has(rel)) continue;
    const raw = readSource(file);
    const code = stripComments(raw);
    const lines = raw.split('\n');
    for (const match of code.matchAll(COLOR_USE)) {
      const [literal, argb, named] = match;
      const channels = argb?.length === 8 ? [0, 2, 4, 6].map((at) => argb.slice(at, at + 2).toUpperCase()) : null;
      const grey = channels
        ? channels[0] === 'FF' && channels[1] === channels[2] && channels[2] === channels[3]
        : GREY_NAMED.has(named);
      if (grey && einkTrueBranch(code, match.index)) continue;
      const line = code.slice(0, match.index).split('\n').length;
      strayColors.push({ rel, line, text: lines[line - 1].trim(), literal });
    }
  }
  // 墨水屏分支之外刻意保留的命名色：按声明或按原样代码登记，每条必须恰好命中登记的处数——
  // 多了是新写的色值，少了说明已经修掉，请删除这一条。
  const NAMED_COLOR_ALLOWED = [
    { file: 'SharePosterUi.kt', declaration: 'SharePosterFullscreenPreview', hits: 5, why: '海报全屏看图：黑底、白字、白图标，是看图器惯例，与外观无关' },
    { file: 'LowPowerDisplayScreen.kt', code: 'if (appearance == LedgerAppearance.Dark) Color.White else Color.Black', hits: 2, owner: 'A7（息屏刷新闪屏的反色块）' },
    { file: 'ui/charts/TrendChartCanvas.kt', code: 'if (palette.isEInk) Color.Black else Color.White', hits: 1, owner: 'A3（读数点内芯的白色改取令牌）' },
  ];
  const declarationRange = (rel, name) => {
    const lines = readSource(path.join(ANDROID_MOBILE_DIR, rel)).split('\n');
    const start = lines.findIndex((line) => new RegExp(`^(?:(?:private|internal|public) )?fun ${name}\\(`, 'u').test(line));
    if (start < 0) return null;
    const end = lines.findIndex((line, index) => index > start && /^[^\s)}]/u.test(line));
    return [start + 1, end < 0 ? lines.length + 1 : end + 1];
  };
  let unexplained = strayColors;
  for (const entry of NAMED_COLOR_ALLOWED) {
    const range = entry.declaration ? declarationRange(entry.file, entry.declaration) : null;
    assert.ok(!entry.declaration || range, `NAMED_COLOR_ALLOWED：${entry.file} 里找不到 ${entry.declaration}，请更新这一条`);
    const covered = unexplained.filter((item) => item.rel === entry.file
      && (range ? item.line >= range[0] && item.line < range[1] : item.text.includes(entry.code)));
    const label = `${entry.file} ${entry.declaration ?? entry.code}（${entry.why ?? `归 ${entry.owner}`}）`;
    assert.notEqual(covered.length, 0, `登记的命名色 ${label} 已经不在了：修掉了就请删除这一条`);
    assert.equal(covered.length, entry.hits, `登记的命名色 ${label} 应命中 ${entry.hits} 处，实际 ${covered.length}：多出来的是新写的色值，请改取令牌`);
    unexplained = unexplained.filter((item) => !covered.includes(item));
  }
  assert.deepEqual(unexplained.map((item) => `${item.rel}:${item.line} ${item.literal}`), [],
    `色值只许写在 LedgerTokens.kt（墨水屏灰阶只许在墨水屏为真的分支里）：\n  ${unexplained.map((item) => `${item.rel}:${item.line} ${item.literal}`).join('\n  ')}`);

  // 预览与截图夹具曾各自手抄一份，而且已经漂移过（夹具的 error 是 #D93025，
  // 挂件真身画的是 #B3261E）——那些截图验的是夹具自己的颜色，真身回归照样绿。
  // 两处都必须从 WidgetColors 取色。
  const fixtures = [
    ['挂件设计预览', p('debug', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile', 'widget', 'WidgetDesignPreview.kt')],
    ['挂件截图夹具', p('screenshotTest', 'kotlin', 'com', 'jeidorf', 'tokenledger', 'mobile', 'widget', 'WidgetLauncherScreenshotTest.kt')],
  ];
  for (const [label, file] of fixtures) {
    const source = readSource(file);
    assert.match(source, /WidgetColors\(/u, `${label}没有从 WidgetColors 取色`);
    for (const role of ['muted', 'faint', 'text', 'danger', 'amber', 'blue', 'ink', 'accent']) {
      assert.doesNotMatch(source, new RegExp(`\\b${role}\\s*=\\s*(?:if\\s*\\([^)]*\\)\\s*)?Color\\(0x`, 'u'),
        `${label}又把 ${role} 写成了自己的色值字面量`);
    }
  }
  // T10.177 评审 P2-2：上面只查八个角色，截图夹具的容器底色因此停在旧值（#08090C / #F4F4F7），
  // 75 张 Launcher 参考图都不是生产外观。夹具里不许再有任何色值字面量，容器底色取 WidgetColors。
  const launcherFixture = readSource(fixtures[1][1]);
  assert.doesNotMatch(launcherFixture, /Color\(0x/u, '挂件截图夹具又写了色值字面量，应从 WidgetColors 取');
  assert.match(launcherFixture, /\.background\(palette\.backgroundColor,/u, '挂件截图夹具的容器底色没有取 WidgetColors 的 backgroundColor');
});

test('Android 额度条按剩余量着色，与原型同一套阈值', () => {
  const logic = readSource(
    path.join(process.cwd(), 'apps', 'android', 'app', 'src', 'main', 'java', 'com', 'jeidorf', 'tokenledger', 'mobile', 'LedgerUiLogic.kt'));
  const androidUi = readAndroidDashboardUi();

  // 原型 T10.79 就改成按剩余量分档了，Compose 一直停在厂商状态色：
  // `if (healthy) palette.blue else palette.amber`——healthy 说的是「这个来源能不能
  // 读到数」，于是 3% 和 95% 同样是蓝色。
  // T10.152（D4）把阈值从与 T10.79 原型逐字一致的 15/40 统一改为与桌面
  // `quotaOverview.ts`/Android 小组件 `widgetAvailabilityBand` 一致的 20/50；
  // 原型 `AndroidDashboardPrototype.tsx` 与其上方 `quotaSeverity(...)` 断言
  // 已由 T10.161（a6f6d8cb）同步为 20/50，四端阈值一致。
  assert.match(logic, /remainingPercent < 20\.0 -> QuotaSeverity\.Critical/u, '严重度阈值与三端统一值分叉');
  assert.match(logic, /remainingPercent < 50\.0 -> QuotaSeverity\.Warning/u, '严重度阈值与三端统一值分叉');

  // 旧切片从 v2SeverityColor 切到 v2RelativeReset，正好覆盖配色函数与 V2QuotaProgressBar 两个声明。
  const bar = androidUiDeclaration('v2SeverityColor', 'V2QuotaProgressBar');
  assert.ok(bar.length > 0, '找不到额度进度条实现');
  assert.match(bar, /val severity = quotaSeverityForFraction\(fraction\)/u, '进度条没有按剩余量分档');
  // 分档算出来还得真的用上：颜色必须来自 v2SeverityColor，且条身不许再出现厂商色。
  assert.match(bar, /else v2SeverityColor\(palette, severity\)/u, '进度条算了档位却没拿它着色');
  assert.doesNotMatch(bar, /palette\.(?:blue|violet)\b/u, '进度条又用回了厂商色');
  assert.doesNotMatch(bar, /QuotaProviderStatus|QuotaWindowStatus/u, '进度条又开始看供应商状态着色');
  assert.match(bar, /animateColorAsState\([\s\S]{0,300}?label = "quotaProgressColor"/u, '档位切换缺少过渡');

  // 颜色不是唯一线索：墨水屏无色相，色觉障碍读不出红——见底那一档另外描边。
  assert.match(bar, /palette\.isEInk -> palette\.text/u, '墨水屏仍在用色相表达档位');
  assert.match(bar, /severity == QuotaSeverity\.Critical && !degraded[\s\S]{0,160}?Modifier\.border/u,
    '见底档缺少非颜色线索');
  // 读屏也要听得到同一件事。
  assert.match(androidUi, /severity\?\.let \{ "\$label（\$\{it\.label\}）" \}/u, '读屏描述里没有档位名');
  assert.match(logic, /Healthy\("额度充足"\),\s*Warning\("额度偏紧"\),\s*Critical\("额度告急"\)/u);
});

test('Android 原型趋势图带真实时间刻度，单值指标走网格', () => {
  const tsx = readSource(path.join(process.cwd(), 'src', 'prototypes', 'AndroidDashboardPrototype.tsx'));

  // 此前 xAxis.show = false：图上没有任何时间参照，正下方却写着「峰值位于 10:00」。
  assert.match(tsx, /axisLabels: string\[\];/);
  assert.match(tsx, /axisLabels: \['00:00',/);
  // 只约束手机端的同期趋势图。摆件的迷你走势（makeAmbientTrendOption）是远看的
  // 装饰性 sparkline，本来就不该有刻度，不在此列。
  const trendOption = tsx.slice(tsx.indexOf('function makeTrendOption'), tsx.indexOf('function makeSourceOption'));
  // 只看 xAxis 自身有没有被整体隐藏；axisTick 与 yAxis 的 show:false 是有意的。
  const xAxisBlock = trendOption.slice(trendOption.indexOf('xAxis: {'), trendOption.indexOf('yAxis:'));
  assert.doesNotMatch(xAxisBlock, /^\s{6}show: false,/mu, '同期趋势图不得再隐藏 X 轴');
  assert.match(xAxisBlock, /data: fixture\.axisLabels,/);
  assert.match(xAxisBlock, /interval:/u, '手机宽度放不下 12 个刻度，必须有抽稀策略');
  assert.match(trendOption, /bottom: 18/u, '需要给刻度留出行高');

  // 洞察页三个单值指标必须在同一个 2 列网格里，而不是三张整宽卡片。
  const grid = tsx.slice(tsx.indexOf('<div className="prototype-kpi-grid">'), tsx.indexOf('</div>', tsx.indexOf('<div className="prototype-kpi-grid">')));
  assert.equal((grid.match(/<KpiCard /gu) || []).length, 3);
});

// T10.83：Claude 额度接入必须能自己说清「接没接上」。
// 立项实测：用户两个开关都开着、界面只显示 10 天前的陈旧值，而 ~/.claude/settings.json
// 里根本没有 statusLine —— 界面既不检查也不提示，只给一行无法直接使用的 JSON 片段。
test('Claude 接入方式给出完整可粘贴的 statusLine 对象与目标文件路径', () => {
  const quota = readSource(path.join(process.cwd(), 'src', 'components', 'settings', 'QuotaSection.tsx'));
  const commands = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'commands', 'mod.rs'));

  // 后端必须能产出带 statusLine 外层与 type 的完整对象，而不只是 "command" 片段。
  assert.match(commands, /fn statusline_settings_block/u);
  assert.match(commands, /"statusLine": \{ "type": "command", "command": shell_command \}/u);
  // 目标文件路径要算出来给用户，而不是让他猜 ~ 在哪。
  assert.match(commands, /fn claude_settings_file_path/u);
  assert.match(commands, /\.join\("\.claude"\)\.join\("settings\.json"\)/u);

  // 前端复制的必须是完整对象。
  assert.match(quota, /const claudeStatuslineBlock = claudeSetup\?\.settingsBlock/u);
  assert.match(quota, /navigator\.clipboard\.writeText\(claudeStatuslineBlock\)/u);
  assert.match(quota, /复制完整配置/u);
  assert.match(quota, /把下面这段合并进 \$\{claudeSetup\.settingsPath\}/u);
});

test('额度来源状态卡五种状态各有文案与色调，Claude 没接上时直说（T10.283）', () => {
  const quota = readSource(path.join(process.cwd(), 'src', 'components', 'settings', 'QuotaSection.tsx'));
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));

  assert.match(quota, /statusLineWired/u);
  for (const [state, tone] of [['not-installed', 'pending'], ['needs-authorization', 'waiting'], ['connected', 'ready'], ['login-required', 'waiting'], ['read-failed', 'blocked']]) {
    assert.ok(quota.includes(`'${state}': '${tone}'`) || quota.includes(`${state}: '${tone}'`), `状态缺少色调：${state}`);
    assert.ok(css.includes(`.quota-setup-stage-${tone}`), `样式缺少档位：${tone}`);
  }
  // 颜色不能是唯一线索：文案本身已经把状态说清。
  for (const label of ['未安装', '待授权', '已连接', '需在原应用登录', '读取失败（保留旧值）']) {
    assert.ok(quota.includes(label), `状态缺少文案：${label}`);
  }
  // 没接上时必须直说，而不是让用户对着陈旧值干等。
  assert.match(quota, /还没接入 Claude Code，用下方「一键接入」完成。/u);
});

test('内置 /usage 探针在 Windows 上认得 npm 生成的 shim 并列出实际候选', () => {
  const rust = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'quota', 'mod.rs'));
  const quota = readSource(path.join(process.cwd(), 'src', 'components', 'settings', 'QuotaSection.tsx'));

  // npm 在 Windows 上只生成 claude / claude.cmd / claude.ps1，没有 .exe；
  // 此前只找 .exe，等于把用户 PATH 里真正在用的 CLI 整个跳过。
  assert.match(rust, /&\["claude\.exe", "claude\.cmd", "claude\.bat", "claude\.ps1"\]/u);
  // 批处理与 PowerShell 脚本不能直接 CreateProcess，必须由解释器调起。
  assert.match(rust, /fn claude_pty_launch/u);
  assert.match(rust, /"cmd" \| "bat" =>/u);
  assert.match(rust, /"ps1" =>/u);
  assert.match(rust, /fn claude_pty_command/u);
  // 候选要能透出到界面，否则用户看到失败也不知道探针在找什么。
  assert.match(rust, /pub\(crate\) fn claude_cli_candidate_paths/u);
  assert.match(quota, /cliCandidates/u);
  assert.match(quota, /本机找不到 Claude CLI，内置 \/usage 无法工作/u);
});

test('Prompt 缓存概览与节省头部保持单行两端对齐，避免副标题掉入第二行', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  assert.match(css, /\.cache-flow-panel \.panel-header\s*\{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*space-between;/);
  assert.match(css, /\.cache-flow-panel \.panel-title\s*\{[\s\S]*margin-bottom:\s*0;/);
});

test('弹窗与模态遮罩使用 Portal 挂载至根节点并保持最高层级，防止被侧边栏遮挡', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'index.css'));
  const modelsDevSource = readSource(path.join(process.cwd(), 'src', 'components', 'ModelsDevImportDialog.tsx'));
  const dashboardPrefSource = readSource(path.join(process.cwd(), 'src', 'components', 'DashboardDisplayPreferencesDialog.tsx'));
  const confirmSource = readSource(path.join(process.cwd(), 'src', 'components', 'ConfirmDialog.tsx'));

  // 模态遮罩层级必须高于侧边栏（macos .app-sidebar z-index: 2）
  assert.match(css, /\.modal-overlay\s*\{[\s\S]*z-index:\s*1000;/);
  assert.match(css, /\.confirm-overlay\s*\{[\s\S]*z-index:\s*1020;/);
  // macOS app-main 不人为限定在低层叠上下文（z-index: 1）
  assert.doesNotMatch(css, /:root\[data-platform='macos'\] \.app-main\s*\{[^}]*z-index:\s*1;/);

  // 设置页与首页弹窗均使用 createPortal 挂载至 document.body
  assert.match(modelsDevSource, /createPortal\(dialog,\s*document\.body\)/);
  assert.match(dashboardPrefSource, /createPortal\(dialog,\s*document\.body\)/);
  assert.match(confirmSource, /createPortal\(dialog,\s*document\.body\)/);
});
// T10.115 replaces the long-page scrollspy with one visible settings destination.
// Rendering, focus, history and retained form state are exercised in SettingsTab.test.tsx.
test('settings destinations stay reachable through user language and unique stable hashes', () => {
  assert.equal(new Set(SETTINGS_DESTINATIONS.map((item) => item.id)).size, 8);
  assert.equal(findSettingsDestinations('')[0].id, 'settings-scan');
  assert.equal(findSettingsDestinations('壁纸')[0].id, 'settings-wallpaper');
  assert.equal(findSettingsDestinations('不存在的设置关键词').length, 0);
  // T10.123：两块挂件此前没有目录条目，用户搜「挂件」什么都搜不到，
  // 只能靠翻「扫描与启动」碰运气；壁纸这种更边缘的功能反而有独立分区。
  assert.equal(findSettingsDestinations('挂件')[0].id, 'settings-widget');
  assert.equal(findSettingsDestinations('小组件')[0].id, 'settings-widget');
  // U-112：模型接入总开关有独立分区，搜「网关」直达。
  assert.equal(findSettingsDestinations('网关')[0].id, 'settings-model-access');
  // T10.272（U-99）：旧「API 配置」分区已下线，由侧栏模型接入四页取代。
  assert.equal(findSettingsDestinations('API endpoint').length, 0);
  assert.ok(!SETTINGS_DESTINATIONS.some((item) => item.id === 'settings-api-profiles'));
});

test('两块桌面挂件有唯一的名字，侧栏不再重复托盘的点击入口', () => {
  const sidebar = readSource(path.join(process.cwd(), 'src', 'components', 'Sidebar.tsx'));
  const app = readSource(path.join(process.cwd(), 'src', 'App.tsx'));
  const widgetSection = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'WidgetSection.tsx'));
  const scanSection = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'ScanStartupSection.tsx'));
  const nativeSource = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'lib.rs'));

  // 侧栏那个按钮只调 show_widget_window，与单击托盘图标完全等价，且方向是反的：
  // 挂件的用处是主窗口没开时扫一眼，从开着的主窗口里召唤它没有意义。
  assert.doesNotMatch(sidebar, /onOpenWidget/);
  assert.doesNotMatch(app, /show_widget_window/);

  // 三个开关全部迁到独立分区，「扫描与启动」只留托盘图标自身的菜单栏文字。
  for (const key of ['tray_hover_widget_enabled', 'widget_open_at_startup', 'desktop_widget_enabled']) {
    assert.match(widgetSection, new RegExp(key));
    assert.doesNotMatch(scanSection, new RegExp(key));
  }
  assert.match(scanSection, /tray_text_enabled/);

  // 命名收口：弹层一律叫「托盘挂件」，常驻那块一律叫「桌面小组件」。
  // widget_open_at_startup 打开的是前者，旧文案「启动时显示桌面挂件」指错了对象。
  assert.match(widgetSection, /title="托盘挂件"/);
  assert.match(widgetSection, /title="桌面小组件"/);
  assert.match(widgetSection, /label="启动时直接钉住托盘挂件"/);
  // 只禁 JSX 上的旧标签；正文注释里为了说明这次改名，仍要允许提到旧文案。
  assert.doesNotMatch(widgetSection, /label="启动时显示桌面挂件"/);
  assert.match(nativeSource, /"显示 \/ 隐藏托盘挂件"/);
  assert.match(nativeSource, /CheckMenuItemBuilder::with_id\(\s*"desktop-widget",\s*"桌面小组件（长驻桌面）",?\s*\)/);
});

test('两块挂件各存一份内容配置，取值与 Rust 侧的闭合集合逐字对齐', () => {
  const rust = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'settings.rs'));
  const rustWindow = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'widget_window.rs'));
  const types = readSource(path.join(process.cwd(), 'src', 'types.ts'));
  const config = readSource(path.join(process.cwd(), 'src', 'utils', 'widgetConfig.ts'));
  const widgetView = readSource(path.join(process.cwd(), 'src', 'components', 'WidgetView.tsx'));
  // 四种板式的渲染分支在 LedgerCard.tsx（T10.192 起），WidgetView.tsx 只传 layout 下去（P3-6）。
  const ledgerCard = readSource(
    path.join(process.cwd(), 'src', 'components', 'widget', 'LedgerCard.tsx'));
  const widgetSection = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'WidgetSection.tsx'));

  // 前后端用同一组字符串；任一边加了取值而另一边没加，这里就红。
  assert.ok(rust.includes('pub const WIDGET_LAYOUTS: [&str; 5] = ["usage", "combo", "quota", "compact", "routing"];'));
  assert.ok(rust.includes('pub const WIDGET_THEMES: [&str; 3] = ["system", "light", "dark"];'));
  assert.ok(rust.includes('pub const WIDGET_RANGES: [&str; 3] = ["today", "week", "month"];'));
  assert.deepEqual(WIDGET_LAYOUTS.map((item) => item.id), ['usage', 'combo', 'quota', 'compact', 'routing']);
  assert.deepEqual(WIDGET_THEMES.map((item) => item.id), ['system', 'light', 'dark']);
  assert.deepEqual(WIDGET_RANGES.map((item) => item.id), ['today', 'week', 'month']);
  // 写盘的是自由字符串（旧版本、手改文件、未来新取值都可能出现），
  // 必须在 sanitized() 一次性收敛，而不是到四处渲染点各写一遍兑底。
  assert.ok(rust.includes('fn sanitize_enum(value: &str, allowed: &[&str], fallback: &str) -> String'));

  for (const surface of ['popover', 'desktop']) {
    for (const field of ['layout', 'theme', 'range', 'provider']) {
      const key = `widget_${surface}_${field}`;
      assert.ok(rust.includes(`pub ${key}:`), `settings.rs 缺字段 ${key}`);
      assert.ok(rust.includes(`merge_changed_field!(${key});`), `部分更新会丢掉 ${key}`);
      assert.ok(types.includes(`${key}:`), `types.ts 缺字段 ${key}`);
      assert.ok(config.includes(`'${key}'`), `widgetConfig.ts 缺键 ${key}`);
    }
  }

  // 托盘挂件与桌面小组件各读各的：一块改板式不能拖动另一块。
  assert.equal(
    widgetConfigFromSettings({ widget_popover_layout: 'compact', widget_desktop_layout: 'quota' }, 'popover').layout,
    'compact');
  assert.equal(
    widgetConfigFromSettings({ widget_popover_layout: 'compact', widget_desktop_layout: 'quota' }, 'desktop').layout,
    'quota');
  // 未知取值回落默认，不能渲染成空白。
  assert.equal(widgetConfigFromSettings({ widget_popover_layout: 'multi_ring' }, 'popover').layout, 'usage');

  // 钉住的来源读不到时给空集合并报缺。Android 的 widgetLayoutProviders
  // 用 `?: providers` 兜底，结果钉在单一来源上的小组件在该来源掉线后
  // 开始显示别人的额度，用户完全看不出换了对象。
  const readable = [{ providerId: 'anthropic-claude-consumer', remaining: 13 }];
  assert.deepEqual(selectWidgetQuota(readable, 'openai-codex-local'),
    { highlights: [], pinnedMissing: true });
  assert.deepEqual(selectWidgetQuota(readable, null),
    { highlights: readable, pinnedMissing: false });

  // 旧实现把范围写进 localStorage，两块挂件共用一个键：
  // 在托盘挂件里切到本周，桌面小组件下次打开也跟着变。
  assert.ok(!widgetView.includes('tokenledger:widget-range'));
  assert.ok(widgetView.includes("widgetConfigFromSettings(await invoke<AppSettings>('get_settings'), mode)"));
  assert.ok(widgetView.includes("listen('settings-updated'"));
  // 窗口按板式定尺寸（T10.193）：Rust `widget_card_size` 与 cardModel.ts `widgetCardSize` 同一张表，
  // 两边一致由 Rust 单测 widget_card_size_matches_cardmodel_ts_widget_card_size 守着；换板式时贴着最近的角缩放。
  assert.ok(rustWindow.includes('pub fn widget_card_size(surface: &str, layout: &str) -> (f64, f64)'));
  assert.ok(rustWindow.includes('pub fn resize_anchored_to_nearest_corner('));
  for (const layout of WIDGET_LAYOUTS) {
    // 真正的板式分支在 LedgerCard.tsx；这里查 WidgetView.tsx 曾经空转过一轮，删分支也不会变红（P3-6）。
    // 「实时路由」不是账本卡片，分支在 WidgetView.tsx 与设置页预览里，画的是 RoutingCard。
    if (layout.id === 'routing') continue;
    assert.ok(ledgerCard.includes(`layout === '${layout.id}'`) || layout.id === 'usage',
      `LedgerCard 没有渲染分支 ${layout.id}`);
  }
  assert.ok(widgetView.includes("layout === 'routing' ? (") && widgetView.includes('<RoutingCard'), 'WidgetView 没有渲染「实时路由」分支');
  const widgetPreview = readSource(path.join(process.cwd(), 'src', 'components', 'widget', 'WidgetPreview.tsx'));
  assert.ok(widgetPreview.includes("config.layout === 'routing'") && widgetPreview.includes('<RoutingCard'), '设置页预览没有「实时路由」分支');

  // T10.123 的「暂不可自定义」占位卡已经兑现，不能再留在页上。
  assert.ok(!widgetSection.includes('暂不可自定义'));
  assert.ok(widgetSection.includes('widgetSettingKeys'));
});

test('托盘悬停要先停留才弹出，停留时长两端同源', () => {
  const settingsRs = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'settings.rs'));
  const widgetRs = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'widget_window.rs'));
  const libRs = readSource(path.join(process.cwd(), 'src-tauri', 'src', 'lib.rs'));
  const types = readSource(path.join(process.cwd(), 'src', 'types.ts'));
  const widgetSection = readSource(
    path.join(process.cwd(), 'src', 'components', 'settings', 'WidgetSection.tsx'));

  // T10.125：Enter 事件此前直接 show，托盘图标只有十几像素宽，鼠标去点旁边的图标
  // 或滑向右下角都会扫过它，于是「路过」被当成「想看」，一块 340x440 的窗口就弹了出来。
  assert.ok(widgetRs.includes('pub fn popover_should_show(tray_hovered: bool, visible: bool) -> bool'));
  assert.ok(widgetRs.includes('dwell_ms: u64,'));
  assert.ok(widgetRs.includes('std::thread::sleep(Duration::from_millis(dwell_ms));'));
  // 离开图标与显式关闭都必须作废还没到点的弹出，否则鼠标划走后它还会自己冒出来。
  assert.ok(widgetRs.includes('state.cancel_pending_show();'));

  // 默认值与上限只写一处（settings.rs），前端与托盘回退路径都引用它。
  assert.ok(settingsRs.includes('pub const DEFAULT_TRAY_HOVER_DELAY_MS: u64 = 450;'));
  assert.ok(settingsRs.includes('pub const TRAY_HOVER_DELAY_MAX_MS: u64 = 2000;'));
  assert.ok(settingsRs.includes('merge_changed_field!(tray_hover_delay_ms);'));
  assert.ok(libRs.includes('.unwrap_or((true, settings::DEFAULT_TRAY_HOVER_DELAY_MS));'));
  assert.equal(DEFAULT_TRAY_HOVER_DELAY_MS, 450);
  assert.equal(TRAY_HOVER_DELAY_MAX_MS, 2000);
  assert.ok(types.includes('tray_hover_delay_ms: 450,'));

  // 手改过的设置文件可能写出任意数字；夹回区间而不是渲染空白或无限等待。
  assert.equal(parseTrayHoverDelay(-1), 0);
  assert.equal(parseTrayHoverDelay(99999), TRAY_HOVER_DELAY_MAX_MS);
  assert.equal(parseTrayHoverDelay('450'), DEFAULT_TRAY_HOVER_DELAY_MS);
  // 默认值必须落在给出的选项里，否则下拉框一打开就是「自定义」。
  assert.ok(TRAY_HOVER_DELAY_CHOICES.some((item) => item.ms === DEFAULT_TRAY_HOVER_DELAY_MS));
  assert.deepEqual(TRAY_HOVER_DELAY_CHOICES.map((item) => item.ms), [0, 250, 450, 900]);
  assert.ok(widgetSection.includes('aria-label="托盘挂件停留多久才弹出"'));
});

test('Android 空图表说人话，不画占位横线', () => {
  // 旧切片从 V2TrendChart 切到 V2HeatmapChart，跨过了 V2DonutChart（与一个只有字段的数据类）；
  // 拆分后这两个函数各占一个文件，且都没有再拆出辅助函数，这里原样一并取。
  const chart = withoutComments(androidUiDeclaration('V2TrendChart', 'V2DonutChart'));
  assert.ok(chart.length > 0, '找不到趋势图实现');

  // 真机首屏抓到的：没有数据时这张图在正中横一条 divider 色的线，其余 82dp 全空。
  // 看上去不是「暂无数据」，是「这里渲染坏了」。而且零基线在底部，画在正中也不对。
  assert.doesNotMatch(chart, /current\.isEmpty\(\)[\s\S]{0,200}?drawLine\(palette\.divider/u,
    '空图表又开始画占位横线');

  // 空态说明不许再跟 honestEmptyState 绑定：七个调用点里只有洞察页那一个传 true，
  // 于是概览与摆件的同一张图什么都不写。有没有数据是图自己的事，与调用点无关。
  assert.match(chart, /if \(emptyMessage != null && current\.isEmpty\(\)\) \{/u,
    '空态说明仍绑在 honestEmptyState 上');
  assert.doesNotMatch(chart, /honestEmptyState && emptyMessage/u, '空态说明仍绑在 honestEmptyState 上');
  // 空图表右侧也不该悬着 paddedChartMaximum(空集) 推出来的假量程。
  assert.match(chart, /if \(!compact && current\.isNotEmpty\(\)\) \{/u, '空图表仍在画数值轴');
});

test('Android 金额千分位与整数一致，只有一份金额格式化', () => {
  const logic = readSource(path.join(ANDROID_MOBILE_DIR, 'LedgerUiLogic.kt'));

  // 首屏同一张卡里并排出现 `4,321` 和 `¥128640.34`——App 里两个金额格式化器分叉了：
  // dailyAmountLabel 走 %,.2f，CurrencyUnit.format 走 %.2f。
  // T10.207：应用、摆件、小组件与海报收成一个出口 formatCurrencyAmount（T10.154 §4.1 Android 行）。
  const amount = logic.slice(
    logic.indexOf('internal fun formatCurrencyAmount('), logic.indexOf('internal fun formatSignedCurrencyAmount('));
  assert.match(amount, /String\.format\(Locale\.US, "%s%,\.2f", symbol, value\)/u, '唯一的金额格式化丢了千分位');
  assert.doesNotMatch(logic, /String\.format\(Locale\.US, "%s%\.2f"/u, '又出现了不带千分位的金额格式化');
  assert.equal((logic.match(/"%s%,\.2f"/gu) || []).length, 1, '金额格式化又分叉成了多份');
  assert.match(logic, /fun format\([\s\S]{0,200}?\): String = formatCostForDisplay\(usdAmount, exchangeRate, masked, this\)/u,
    'CurrencyUnit.format 没走共用出口');
  const daily = logic.slice(
    logic.indexOf('internal fun dailyAmountLabel('), logic.indexOf('internal data class RecentDailyActivityRow('));
  assert.match(daily, /val text = formatCurrencyAmount\(amount, currency\)/u, 'dailyAmountLabel 没走共用出口');
  assert.doesNotMatch(daily, /String\.format/u, 'dailyAmountLabel 又自己格式化金额');
  // 小组件与海报不再各写一份不带千分位的 ¥%.2f。
  const widgetModel = readSource(path.join(ANDROID_MOBILE_DIR, 'widget', 'WidgetModel.kt'));
  assert.match(widgetModel,
    /internal fun formatCny\(value: Double\?, masked: Boolean = false\): String =\s*if \(masked\) "¥\*\*\*\.\*" else formatCurrencyAmount\(value, CurrencyUnit\.CNY\)/u,
    '小组件金额没走共用出口');
  const poster = readSource(path.join(ANDROID_MOBILE_DIR, 'SharePosterRenderer.kt'));
  assert.match(poster, /internal fun formatNetSavedCny\(value: Double\): String = formatCurrencyAmount\(value, CurrencyUnit\.CNY\)/u,
    '海报金额没走共用出口');
  assert.doesNotMatch(withoutComments(widgetModel + poster), /String\.format\([^)]*"¥%/u, '小组件或海报又自己格式化人民币');
});

test('Android 额度行副标题写窗口，不复述状态词', () => {
  // T10.143f 起在 ui/quota/V2QuotaSummaryCard.kt 且改为 internal；旧切片（到 observeChoiceBounds）恰好就是这一个函数。
  const row = androidUiDeclaration('V2QuotaSummaryRow');
  assert.ok(row.length > 0, '找不到额度摘要行实现');

  // 元数据行是「$statusText · 更新于 …」，副标题此前非 Ok 时也写 statusText，
  // 于是同一个词在三行之内出现两次（四种非 Ok 状态都如此），窗口标签反被挤掉——
  // 数据一转历史，就再也看不出这个百分比说的是 5 小时还是每周。
  assert.match(row, /Text\(\s*window\.localizedCompactWindowLabel\(providerName\),\s*color = palette\.faint,/u,
    '额度行副标题没有固定写窗口标签');
  assert.doesNotMatch(row, /\} else \{\s*statusText\s*\},/u, '额度行副标题又开始复述状态词');
  // 状态词只许出现在语义描述与元数据行；副标题那一段里不许有。
  const subtitle = withoutComments(
    row.slice(row.indexOf('Column(Modifier.weight(1f))'), row.indexOf('if (remainingFraction != null)')));
  assert.ok(subtitle.length > 0, '找不到额度行副标题那一段');
  assert.doesNotMatch(subtitle, /statusText/u, '额度行副标题又开始复述状态词');
});

test('Android 分段控件按最宽文案定宽，调用点不写死', () => {
  // T10.143f 起 V2SegmentedToggle 在 ui/foundation/V2AtomicComponents.kt，三个调用点在
  // ui/controls/V2SegmentedControls.kt，均改为 internal；按声明取，查的内容不变。
  const toggle = androidUiDeclaration('V2SegmentedToggle');
  assert.ok(toggle.length > 0, '找不到分段控件实现');

  // 调用点写死 136dp 时，两段均分只剩 62dp，「Token 消耗」被截成「Token …」；
  // 更糟的是那个宽度还乘了 fontScale，200% 时两个两字标签要吃掉 390dp 屏的 272dp，
  // 把同排的标题挤成「有效 / Toke / n」三行。宽度必须由内容推出。
  assert.match(toggle, /\.width\(IntrinsicSize\.Max\)\s*\n\s*\.widthIn\(min = minTrackWidth\)/u,
    '分段控件不再按最宽文案定宽');
  // 触达下限与 helper 同源，别再各写一份公式。
  assert.match(toggle, /val minTrackWidth = v2SegmentedToggleWidth\(widestRow\)/u,
    '分段控件又自己抄了一份最小宽度公式');

  // 三个调用点都不许再写死宽度。
  for (const fn of ['V2MetricModeToggle', 'V2CurrencyToggle', 'V2TokenModeToggle']) {
    const body = androidUiDeclaration(fn);
    assert.ok(body.length > 0, `找不到 ${fn}`);
    assert.doesNotMatch(body, /Modifier\.width\(/u, `${fn} 又写死了宽度，文案会被截断`);
    assert.doesNotMatch(body, /136f/u, `${fn} 又出现了写死的 136dp`);
  }
});

test('Android 截图夹具钉死「现在」，参考图不随时钟漂移', () => {
  const fixture = readSource(path.join(
    process.cwd(), 'apps', 'android', 'app', 'src', 'screenshotTest', 'kotlin',
    'com', 'jeidorf', 'tokenledger', 'mobile', 'ChartQuotaTestfixScreenshotTest.kt'));
  const theme = readSource(path.join(ANDROID_MOBILE_DIR, 'LedgerTheme.kt'));

  // 额度重置渲染的是相对时间，夹具钉的是绝对时间戳，两者一相减就随真实时钟漂移：
  // 2026-09-08 实测 `重置 4 小时后` → `3 小时后`，三张参考图无缘无故变红。
  // 会自己变红的门禁只会教人闭着眼睛去 update 参考图。
  assert.match(theme, /internal val LocalLedgerNow = staticCompositionLocalOf<\(\) -> Instant>/u,
    '缺少可注入的「现在」');
  assert.match(fixture, /private val FIXED_NOW: Instant = Instant\.parse\(/u, '截图夹具没有钉死「现在」');
  assert.match(fixture, /CompositionLocalProvider\(LocalLedgerNow provides \{ FIXED_NOW \}\)/u,
    '截图夹具没有把「现在」注入进渲染');
});

test('Android 额度页外层只写到分钟，完整时间戳留在详情', () => {
  // 额度页编排自 T10.143f 起在 ui/quota/V2QuotaSection.kt 的 v2QuotaItems。结束锚点是顶栏之后
  // 取来源列表的那一句：T10.143e（11cdb603）把待处理来源并入分组，调用从
  // orderedQuotaProvidersWithWindowsForFullDisplay() 改为 orderedQuotaProvidersForFullDisplay()，
  // 旧锚点从此找不到（-1），切片一路切到文件尾，把详情抽屉也算成了"外层"。
  const quotaItems = androidUiDeclaration('LazyListScope.v2QuotaItems');
  const headerStart = quotaItems.indexOf('V2QuotaTransportLine(');
  const headerEnd = quotaItems.indexOf('orderedQuotaProvidersForFullDisplay()');
  assert.ok(headerStart >= 0 && headerEnd > headerStart, '额度页顶栏切片锚点缺失或写反了');

  // 打开额度页第一眼是 `本机历史快照 · 2026-09-07 20:29:30 +00:00`——带秒和时区偏移的
  // 完整时间戳，大字体下还会被截成 `2026-07-28 03:59:…`。这种排障用的写法属于详情抽屉，
  // 那里已经有三份（云端投影 / 观测 / 抓取）。
  const header = withoutComments(quotaItems.slice(headerStart, headerEnd));
  assert.ok(header.length > 0, '找不到额度页顶栏');
  assert.match(header, /timestamp = v2ShortDateTime\(quota\.snapshot\.generatedAt\)/u,
    '额度页外层又用回了完整时间戳');
  assert.doesNotMatch(header, /quotaFullTimestamp/u, '额度页外层又用回了完整时间戳');

  // 详情抽屉那三处必须还在，别把「挪进详情」做成「两处都删」。
  // 详情抽屉自 T10.143f 起是 ui/quota/V2ProviderCard.kt 的 V2QuotaProviderDetails。
  const detailsSource = androidUiDeclaration('V2QuotaProviderDetails');
  const details = detailsSource.slice(
    detailsSource.indexOf('Text("云端投影'),
    detailsSource.indexOf('if (provider.windows.isEmpty())'));
  assert.equal((details.match(/quotaFullTimestamp\(/gu) || []).length, 4,
    '详情抽屉里的完整时间戳数量变了');
});

test('Android 额度窗口的重置与状态合成一行', () => {
  // T10.143f 起额度页窗口行由 V2ProviderCard 调用的 V2ProviderWindowRow 画；旧 V2QuotaWindow
  // 仍留在 ui/quota/V2QuotaWindow.kt 却已无调用方，守它等于守死代码。先钉住调用链再查实现。
  assert.match(androidUiDeclaration('V2ProviderCard'), /V2ProviderWindowRow\(palette, provider, window\)/u,
    '额度卡不再由 V2ProviderWindowRow 画窗口行，契约需要跟着真正渲染的那一份走');
  const win = withoutComments(androidUiDeclaration('V2ProviderWindowRow'));
  assert.ok(win.length > 0, '找不到额度窗口行实现');

  // 「重置 23 小时后」与「历史数据」是同一个窗口的两句注脚，此前各占一行；
  // 一张三窗口的卡片就多出三行 11sp 小字。合成一行，窄屏或大字体由 FlowRow 自己折。
  // T10.217 在同一 FlowRow 前置档位词，顺序为「档位 · 重置 · 状态」；窄屏或大字体由
  // FlowRow 自己折行，不能重新拆成彼此独立的固定行。
  assert.match(win,
    /FlowRow\([\s\S]{0,240}?severity\?\.let[\s\S]{0,520}?Text\(\s*compactResetText[\s\S]{0,800}?presentation\.status\.localizedLabel\(\)/u,
    '档位、重置与状态又拆回不同布局');
  assert.match(win, /Text\(\s*if \(presentation\.status == QuotaWindowStatus\.Stale\)[\s\S]{0,320}?历史数据 · 观测[\s\S]{0,180}?presentation\.status\.localizedLabel\(\)[\s\S]{0,120}?color = statusColor/u,
    '窗口状态不见了');
  // 两句仍分开着色：状态是琥珀色信号，不能被并进灰色注脚。
  assert.match(win, /Text\(\s*compactResetText, color = palette\.faint/u, '重置时间不该用状态色');
});

test('Android 空态不把「没有数据」说成「你条件设错了」', () => {
  // T10.143f 起洞察编排在 ui/LedgerDashboardV2Screen.kt 的 v2InsightsItems；在函数内按原锚点切。
  const insightsItems = androidUiDeclaration('LazyListScope.v2InsightsItems');
  const emptyStart = insightsItems.indexOf('item(key = "insights-detail-empty"');
  const emptyEnd = insightsItems.indexOf('items(details, key =');
  assert.ok(emptyStart >= 0 && emptyEnd > emptyStart, '明细空态切片锚点缺失或写反了');
  const empty = withoutComments(insightsItems.slice(emptyStart, emptyEnd));
  assert.ok(empty.length > 0, '找不到明细空态');

  // 一条筛选都没设却让人「调整筛选或搜索词」，说的是两件不同的事：
  // 「这段时间没有用量」的下一步是换范围，「条件太窄」的下一步才是放宽条件。
  assert.match(empty, /val narrowed = !state\.query\.search\.isNullOrBlank\(\)/u, '明细空态没有区分是否设了筛选');
  assert.match(empty, /state\.query\.machines\.isNotEmpty\(\)/u, '明细空态漏了设备筛选');
  assert.match(empty, /state\.query\.tools\.isNotEmpty\(\)/u, '明细空态漏了工具筛选');
  assert.match(empty, /state\.query\.models\.isNotEmpty\(\)/u, '明细空态漏了模型筛选');
  assert.match(empty, /if \(narrowed\) "没有匹配明细" else "当前范围没有明细"/u, '明细空态标题没有分支');
  assert.match(empty, /if \(narrowed\) "调整筛选或搜索词后再试。" else/u, '明细空态提示没有分支');
});

test('Android 洞察共用范围栏，日历明确区分高亮范围与全局覆盖', () => {
  // T10.143f 起洞察编排在 ui/LedgerDashboardV2Screen.kt 的 v2InsightsItems；在函数内按原锚点切。
  const insightsItems = androidUiDeclaration('LazyListScope.v2InsightsItems');
  const insightsStart = insightsItems.indexOf('item(key = "insights-tabs"');
  // 结束锚点必须真的排在起点之后：`InsightPane.Details ->` 在文件第 229 行就出现过一次，
  // 用它会切出一段空字符串，契约就变成了永远通过。
  const insightsEnd = insightsItems.indexOf('item(key = "insights-detail-search"');
  assert.ok(insightsStart >= 0 && insightsEnd > insightsStart, '洞察页面板编排切片锚点缺失或写反了');
  const insights = withoutComments(insightsItems.slice(insightsStart, insightsEnd));
  assert.ok(insights.length > 0, '找不到洞察页面板编排');

  // 日历自 T10.130 起画全局热力图，与所选范围无关；那一行顶在上面就成了假话
  // ——写着「当前范围：今日」，下面是整年的格子。
  // T10.137（fcba190b，审计 R1/R8 修复）删掉了洞察页自己那行 `insights-range`：范围改由顶栏下的
  // 查询摘要 V2QueryContext 统一呈现（概览、洞察四页与下钻共用，额度不继承），"高亮 vs 全局"改由
  // 日历卡自己说清。DESIGN「T10.137 查询上下文收束」：「统计页顶栏下保留紧凑查询摘要，长内容可展开
  // 且读屏读出全文」；日历保留自描述的色阶与描边键，移除重复解释句，保留全年视角。
  // T10.208（A1 导航壳，root 决定 V-Q3「筛选入口并入顶栏副标题」）把这行摘要从独立一行
  // V2QueryContext 并进了 V2TopBar 的 subtitle 参数，取值逻辑抽成纯函数 v2TopBarSubtitle
  // （ui/navigation/V2TopBar.kt）方便单测，调用点（LedgerDashboardV2Screen）只传参、不重复
  // 写分支。V2QueryContext 函数本身没删（供其它契约按声明计数），只是没人再调用。断言跟着
  // 并入后的新落点走，「概览/洞察/下钻共用、额度不继承」这条不变量本身没有变。
  const topBarSubtitle = androidUiDeclaration('v2TopBarSubtitle');
  assert.match(topBarSubtitle,
    /destination == MobileDestination\.Quota -> ""[\s\S]*?else -> querySummary/u,
    '洞察各页不再共用顶栏副标题里的查询摘要，或额度页又长出了摘要');
  const screen = androidUiDeclaration('LedgerDashboardV2Screen');
  assert.match(screen, /subtitle = v2TopBarSubtitle\(/u,
    '顶栏副标题不再调用 v2TopBarSubtitle（或摘要改读了别的查询）');
  assert.match(androidUiDeclaration('V2QueryContext'), /Text\(\s*dashboardQuerySummary\(query\),/u,
    '查询摘要不再显示当前查询');
  const auditPresentation = readSource(path.join(ANDROID_MOBILE_DIR, 'AuditPresentation.kt'));
  assert.match(auditPresentation, /dashboardQuerySummary\(query: DashboardQuery\): String = buildList \{\s*add\(dashboardRangeLabel\(query\)\)/u,
    '查询摘要不再以日期范围开头');
  const calendarCard = androidUiDeclaration('V2InsightCalendarCard');
  assert.match(calendarCard,
    /"全局用量日历"[\s\S]*?V2HeatmapScaleLegend\(palette\)[\s\S]*?V2CalendarMonthGrid\(/u,
    '全局日历必须在月历前保留色阶与当前查询描边图例');
  assert.doesNotMatch(calendarCard, /颜色深浅表示有效 Token 用量|点击月份选日，查看用量与费用/u,
    '全局日历不应在图例和可点击月份之外重复解释同一操作');
  assert.doesNotMatch(insights, /dashboardRangeLabel\(state\.dayReviewReturn/u,
    '复盘范围不得使用返回快照冒充当前日期');

  // 覆盖区间由「按日复盘」卡写（那里还带时区）。此前紧挨着的两张卡各写一遍。
  assert.doesNotMatch(insights, /V2CalendarSummary\(|V2CalendarTable\(/u, '日历不得堆叠重复摘要和金额表');
  // T10.143f 起在 ui/calendar/V2CalendarSummary.kt；旧切片（到 V2CalendarTable）恰好就是这一个函数。
  const summary = withoutComments(androidUiDeclaration('V2CalendarSummary'));
  assert.doesNotMatch(summary, /coverageLabel/u, '活跃日历卡又开始重复覆盖区间');
  // 但「按日复盘」那一份必须还在，别把「只写一次」做成「一次都不写」。
  assert.match(calendarCard, /\$\{axis\.selectableStart\} 至 \$\{axis\.selectableEnd\} · \$\{axis\.timezone\}/u,
    '按日复盘卡丢了覆盖区间');
});

test('Android 构成环没有来源时说「暂无构成」，不写「未显示 100%」', () => {
  // T10.143f 起在 ui/charts/DonutChartCanvas.kt；旧切片（到 HeatmapCellSelection）恰好就是这一个函数。
  const donut = withoutComments(androidUiDeclaration('V2DonutChart'));
  assert.ok(donut.length > 0, '找不到构成环实现');

  // segments 非空不等于「有构成」：一个来源都没有时仍会返回一段占满全圆的「未显示」，
  // 于是画出整圈灰环、圆心写总量、脚注写「未显示 100%」，看着像还没加载完。
  // 旧写法用的是 segments.isEmpty()，接不住这个状态。
  assert.match(donut, /val hasBreakdown = presentation\.segments\.any \{ it\.sourceIndex != null \}/u,
    '构成环没有区分「有段落」与「有构成」');
  assert.match(donut, /!hasBreakdown -> "暂无构成"/u, '构成环圆心没有空态');
  assert.match(donut, /!hasBreakdown -> "暂无来源构成"/u, '构成环读屏描述没有空态');
  assert.match(donut, /if \(hasBreakdown\) \{[\s\S]{0,260}?Text\("未显示 \$\{v2Share/u,
    '「未显示 X%」又会在没有构成时出现');
  assert.doesNotMatch(donut, /presentation\.segments\.isEmpty\(\) -> "暂无/u, '构成环又用回了 segments.isEmpty()');
});

test('Android 设置页不替别的屏改口：断网时不写「已连接／已同步」', () => {
  // T10.143f 起在 ui/settings/V2SettingsSections.kt；旧切片（到 V2WidgetSettings）恰好就是这一个函数。
  const settings = withoutComments(androidUiDeclaration('V2DataSettings'));
  assert.ok(settings.length > 0, '找不到数据与契约设置卡');

  // 断网走查时这两行写着「已连接 / 已同步」，而顶栏正写着「网络不可用」、
  // 额度页正写着「本机历史快照」。同一个 App 的三屏不能互相打脸。
  assert.doesNotMatch(settings, /"已连接"/u, '设置页又断言起了连接状态');
  assert.match(settings, /contractVersion \?: 1\) >= 2\) "已启用" else "兼容模式"/u,
    'Stats v2 那行说的是契约版本，不是连接');
  assert.match(settings, /is QuotaUiState\.Available -> if \(quota\.showingCachedData\) "本机历史快照" else "已同步"/u,
    '额度快照那行没有区分历史快照与已同步');
});

test('Android 自定义区间按钮随选中状态换底色与图标色，不铺旧版的透明/surface 底', () => {
  // T10.208（A1 导航壳，design §4.2/§4.3）把范围行从「V2SegmentedToggle 均分宽度 + 自定义区间
  // 按钮透明底」改成「按内容取宽、整行横向滚动，五个常规选项背后共用一枚滑动胶囊；自定义挪到
  // 轨道右侧独立的 48dp 方形按钮」。旧版「自定义」按钮靠 `palette.selected`/`Color.Transparent`
  // 表达选中，新版按 design 原文「按钮切为 primaryContainer + primary 图标」：未选中 raised、
  // 选中 primaryContainer，图标未选中 muted、选中 primary——旧的 `RangeKey.entries.chunked(columns)`
  // 均分逻辑已经整段删掉，找不到就是找错了地方，不是契约本身该改的信号。
  const rangeSources = androidUiDeclaration('V2GlobalRangeControl');
  assert.doesNotMatch(rangeSources, /RangeKey\.entries\.chunked\(columns\)/u,
    '范围行不该再等分宽度切列（那是旧版实现，design 已改成按内容取宽整行滚动）');
  assert.match(rangeSources, /\.background\(if \(customActive\) tokens\.primaryContainer else tokens\.raised\)/u,
    '自定义区间按钮底色不再随选中状态在 primaryContainer / raised 间切换');
  assert.match(rangeSources, /tint = if \(customActive\) tokens\.primary else tokens\.muted/u,
    '自定义区间按钮图标色不再随选中状态在 primary / muted 间切换');
  assert.doesNotMatch(rangeSources, /palette\.surface/u,
    '自定义区间按钮又铺回了旧版的 palette.surface 底');

  // R-18（T10.177 修复轮 FI-1b 实测：JVM 与契约都不拦，只有截图会红）：旧版 IconButton 选中时
  // 额外挂一圈 1dp palette.blue 描边，是不靠底色的选中线索。自定义按钮挪成独立方块后底色换了
  // 语汇（surface/selected → raised/primaryContainer），但这条非颜色线索本身不能跟着丢——
  // 五个常规选项的同款描边现画在共享滑动胶囊上（同一文件 `drawBehind` 块），这里单独钉住
  // 自定义按钮自己的那一圈。
  assert.match(rangeSources, /customActive -> Modifier\.border\(LedgerStroke\.hairline, tokens\.primary, customShape\)/u,
    '自定义区间按钮选中时丢了 R-18 的 1dp primary 描边（非颜色选中线索）');

  // R-67（评审 P1-3、FI-R3：删掉常规选项胶囊上的 R-18 描边后契约与截图全绿）：常规五项与分段控件
  // 共用一个胶囊绘制函数 drawV2SelectionPill，描边只写在那里。钉两头：函数里真的画了非墨水屏的
  // 1dp primary 描边；范围轨道与分段轨道都经它画胶囊，不另画一份没有描边的。
  const selectionPill = withoutComments(androidUiDeclaration('DrawScope.drawV2SelectionPill'));
  assert.match(selectionPill, /val hairline = LedgerStroke\.hairline\.toPx\(\)/u, '选中胶囊的描边不再取 1dp 发丝线令牌');
  assert.match(selectionPill,
    /if \(!colors\.isEInk\) \{[\s\S]*?drawRoundRect\(\s*color = colors\.primary,[\s\S]*?style = Stroke\(width = hairline\)/u,
    '选中胶囊丢了 R-18 的 1dp primary 描边（常规范围选项与分段控件的非颜色选中线索）');
  assert.match(withoutComments(rangeSources), /drawV2SelectionPill\(tokens, [^\n]*tokens\.selected\)/u,
    '范围轨道不再经共享的 drawV2SelectionPill 画选中胶囊（R-18 描边会跟着丢）');
  assert.match(withoutComments(androidUiDeclaration('Modifier.v2SegmentTrack')), /drawV2SelectionPill\(/u,
    '分段轨道不再经共享的 drawV2SelectionPill 画选中胶囊（R-18 描边会跟着丢）');

  // 五个常规选项靠父级共享的滑动胶囊表达选中（drawBehind 画在 V2GlobalRangeControl 里），
  // 不再各自持有 containerColor——两套「选中」视觉语言（胶囊 vs 逐项底色）混在一起才是真正的分叉。
  const option = withoutComments(androidUiDeclaration('V2RangeOption'));
  assert.doesNotMatch(option, /containerColor/u,
    '范围选项不该再有独立的 containerColor：选中视觉已经统一由父级共享滑动胶囊呈现');
});

test('Android 挂件预览按挂件的尺上色，不另立一套', () => {
  const cycling = readSource(path.join(ANDROID_MOBILE_DIR, 'widget', 'WidgetCycling.kt'));
  const widget = readSource(path.join(ANDROID_MOBILE_DIR, 'widget', 'TokenLedgerWidget.kt'));
  // T10.143f 起在 ui/ambient/V2WidgetPreviewCard.kt；旧切片（到 V2SettingsPage）恰好就是这一个函数。
  const pill = withoutComments(androidUiDeclaration('V2WidgetQuotaPill'));
  assert.ok(pill.length > 0, '找不到挂件预览胶囊');

  // 摆件页那块是**挂件预览**。此前它的条身写的是 `if (Ok) blue else amber`
  // ——说的是"读不读得到数"，不是"还剩多少"，于是 3% 与 95% 在预览里一模一样，
  // 而真身挂件是按剩余量分档的（providerAccentColor → widgetProgressColor）。
  // 预览与真身分叉时，用户照着预览挑板式，装到桌面才发现不是那个样子。
  assert.match(widget, /QuotaProviderStatus\.Ok -> provider\?\.primary\?\.availableFraction\?\.let \{ widgetProgressColor/u,
    '挂件真身不再按剩余量分档了，预览的参照也就没了');
  assert.match(pill, /when \(widgetAvailabilityBand\(remainingFraction\)\)/u, '挂件预览没按挂件的档位上色');
  assert.doesNotMatch(pill, /color = if \(status == QuotaProviderStatus\.Ok\) palette\.blue else palette\.amber/u,
    '挂件预览又用回了"能不能读到数"的配色');

  // 听到的与看到的必须是同一把尺：读屏档位名也走挂件那把。
  assert.match(pill, /val severity = remainingFraction\?\.let \{\s*when \(widgetAvailabilityBand\(it\)\)/u,
    '挂件预览的读屏档位与它画出来的颜色用了两把尺');
  assert.doesNotMatch(pill, /quotaSeverityForFraction/u, '挂件预览又混用了正文那把尺');

  // 两把尺各自的取值也钉住；T10.152（D4）把它们真的"顺手统一"到同一对边界
  // （20% / 50%，严格小于），两处一起改，而不是只改一边。
  assert.match(cycling, /availableFraction < 0\.20f -> WidgetThresholdBand\.Danger/u, '挂件档位阈值变了');
  assert.match(cycling, /availableFraction < 0\.50f -> WidgetThresholdBand\.Warn/u, '挂件档位阈值变了');
});

test('Android 摆件节奏图空手时不画那条假线，并把空态说出来', () => {
  // T10.143f 起节奏图在 ui/ambient/V2AmbientComponents.kt，预览卡在 ui/ambient/V2WidgetPreviewCard.kt。
  // 旧切片分别是「V2AmbientRhythmChart 这一个函数」与「V2AmbientModePreviewCard + V2EInkPreviewToggle」，
  // 按声明原样取；androidUiDeclaration 自己会确认每个声明恰好一处，替代原先的锚点先后检查。
  const chart = withoutComments(androidUiDeclaration('V2AmbientRhythmChart'));

  // 空态分支里不能再画线。在一张图表里，一条横线的意思是"数据平在这个高度"，
  // 不是"没有数据"——全屏节奏档这张图占竖屏近七成，那条假线就横跨了大半个息屏。
  // 只在空态分支里查：有数据时 drawLine(palette.divider,…) 是合法的底轴。
  const emptyBranchStart = chart.indexOf('if (series.current.isEmpty()) {');
  assert.ok(emptyBranchStart > 0, '找不到节奏图的空态分支');
  const emptyBranch = chart.slice(emptyBranchStart, chart.indexOf('} else {', emptyBranchStart));
  assert.ok(emptyBranch.length > 0, '空态分支切片为空');
  assert.doesNotMatch(emptyBranch, /drawLine\(/u, '节奏图空态又开始画线了');

  // 空态文案是入参而不是写死的：全屏一瞥与墨水日报那三个调用点在外面就把整块收掉了，
  // 那里再写一遍空态只是多一行噪声。
  assert.match(chart, /emptyMessage: String\? = null/u, '节奏图丢了空态文案入参');
  assert.match(
    chart,
    /if \(emptyMessage != null && series\.current\.isEmpty\(\)\)/u,
    '节奏图不再渲染空态文案',
  );

  // 摆件页的预览卡是应用内界面不是息屏：空着不说话，用户只会以为还没加载完。
  const preview = withoutComments(androidUiDeclaration('V2AmbientModePreviewCard', 'V2EInkPreviewToggle'));
  assert.match(
    preview,
    /AmbientElement\.RhythmChart -> V2AmbientRhythmChart\([\s\S]{0,400}?emptyMessage = trendAvailabilityMessage\(/u,
    '摆件预览卡的节奏图不再显示空态文案',
  );
});

test('Android 全屏节奏档的图例与时刻轴不替不存在的曲线背书', () => {
  // T10.143f 起节奏档在 ui/ambient/V2AmbientPulse.kt（旧切片到 V2AmbientConsole 恰好就是这一个函数）；
  // 下面"恰好 3 处"的全局计数按门面加 ui/** 全量数。
  const androidUi = readAndroidDashboardUi();
  const pulse = withoutComments(androidUiDeclaration('V2AmbientPulse'));

  assert.match(
    pulse,
    /emptyMessage = trendAvailabilityMessage\(/u,
    '全屏节奏档不再把"当前范围暂无 Token 趋势"说出来；这一档整屏就是这张图，空着不解释等于给一块占近七成屏幕的黑',
  );

  // 一块蓝色图例等于在说"本期那条线就在上面"。曲线没画出来时它必须一起收起，
  // 时刻轴同理——它们是给曲线用的脚手架，不是独立信息。
  const guard = pulse.indexOf('if (series.current.isNotEmpty()) {');
  assert.ok(guard > 0, '全屏节奏档的图例/时刻轴没有空态保护');
  assert.ok(
    pulse.indexOf('V2LineLegend(palette.blue, false, "本期"') > guard,
    '本期图例跑到了空态保护之外',
  );
  assert.ok(
    pulse.indexOf('listOf("00", "06", "12", "18")') > guard,
    '时刻轴跑到了空态保护之外',
  );

  // 息屏那三档（一瞥、墨水日报竖版与横版）反过来：整块收掉，不显示空态文案。
  // 数量钉死，省得哪天有人"统一空态处理"把节奏档也一并收掉——收掉了那片空白还在，
  // 只是连解释都没有了。
  const guards = withoutComments(androidUi).match(/if \(series\.hasData\)/gu) || [];
  assert.equal(
    guards.length,
    3,
    `息屏"整块收掉"的调用点应当恰好 3 处（一瞥 / 墨水日报竖版 / 墨水日报横版），实际 ${guards.length} 处`,
  );
});

test('Android 额度新鲜度不读墙上时钟，参考图不随日历漂移', () => {
  // T10.143f 把看板拆进 ui/**，门面只剩转发；「看板 UI」按门面加 ui/** 全量查，
  // 否则挪进 ui/quota/QuotaGrouping.kt 的 `now: Instant = Instant.now()` 默认参数就漏网了。
  const androidUi = readAndroidDashboardUi();
  const preview = readSource(path.join(
    process.cwd(), 'apps', 'android', 'app', 'src', 'debug', 'java', 'com', 'jeidorf',
    'tokenledger', 'mobile', 'LedgerDashboardPreview.kt'));

  // 额度的"新鲜 / 过期"完全由 now 裁决。组合里直接读 Instant.now() 会让同一份夹具随日历
  // 漂移：名叫「Quota fresh」的参考图上四个窗口全写「重置 已到期」，而按夹具自带时钟断言的
  // JVM 用例照样绿——图与单测各说各话，且重出一次参考图就把漂移固化进去。
  assert.doesNotMatch(withoutComments(androidUi), /Instant\.now\(\)/u,
    '看板 UI 里又出现了 Instant.now()；额度时钟必须走 LocalLedgerNow');
  const clockReads = withoutComments(androidUi).match(/LocalLedgerNow\.current\(\)/gu) || [];
  assert.ok(clockReads.length >= 6,
    `走 LocalLedgerNow 的取时点少于 6 处（实际 ${clockReads.length}），有调用点被改回墙上时钟了`);

  // 预览宿主统一钉一个"此刻"，且新鲜夹具的时间戳由同一个常量推出来。
  assert.match(preview, /internal val LEDGER_PREVIEW_NOW: Instant = Instant\.parse\("2026-07-28T04:00:00Z"\)/u,
    '预览固定时钟没了或改了取值');
  assert.match(preview, /internal fun ledgerFreshQuotaSnapshotFixture[\s\S]{0,400}?val now = LEDGER_PREVIEW_NOW/u,
    '新鲜额度夹具又用回了自己的日历字面量');
  const providers = preview.match(/CompositionLocalProvider\(LocalLedgerNow provides \{ LEDGER_PREVIEW_NOW \}\)/gu) || [];
  assert.equal(providers.length, 2,
    `看板与息屏两个预览宿主都必须钉时钟，实际 ${providers.length} 处`);
});

test('R-30 (T10.177 + T10.187): Android LedgerTokens.kt 的图表 8 槽与「其他」逐值等于共享夹具 palette-b.json（深浅两套）', () => {
  const source = readSource(path.join(ANDROID_MOBILE_DIR, 'ui', 'foundation', 'LedgerTokens.kt'));
  const fixture = readPaletteBFixture();
  const argbToHex = (literal) => {
    assert.match(literal, /^0xFF[0-9A-Fa-f]{6}$/u, `图表色必须不透明：${literal}`);
    return `#${literal.slice(4).toLowerCase()}`;
  };
  const chartList = (name) => {
    const match = source.match(new RegExp(`private val ${name}: List<Color> = listOf\\(([\\s\\S]*?)\\n\\s*\\)`, 'u'));
    assert.ok(match, `LedgerTokens.kt 找不到 ${name}`);
    return [...match[1].matchAll(/Color\((0x[0-9A-Fa-f]{8})\)/gu)].map((m) => argbToHex(m[1]));
  };
  const otherAfter = (marker) => {
    const at = source.indexOf(marker);
    assert.ok(at > 0, `LedgerTokens.kt 找不到 ${marker}`);
    const rest = source.slice(at + marker.length);
    const next = rest.indexOf('chart = ');
    const match = (next >= 0 ? rest.slice(0, next) : rest).match(/chartOther = Color\((0x[0-9A-Fa-f]{8})\)/u);
    assert.ok(match, `${marker} 所在配色没有 chartOther`);
    return argbToHex(match[1]);
  };
  assert.deepEqual(chartList('DarkChart'), fixture.dark.slots.map((c) => c.toLowerCase()), 'Android DarkChart 与 fixture.dark.slots 不一致');
  assert.deepEqual(chartList('LightChart'), fixture.light.slots.map((c) => c.toLowerCase()), 'Android LightChart 与 fixture.light.slots 不一致');
  assert.equal(otherAfter('chart = DarkChart,'), fixture.dark.other.toLowerCase(), 'Android 深色 chartOther 与 fixture.dark.other 不一致');
  assert.equal(otherAfter('chart = LightChart,'), fixture.light.other.toLowerCase(), 'Android 浅色 chartOther 与 fixture.light.other 不一致');
});

test('settings pages draw compact controls inside a 44px target (GLB-03)', () => {
  const css = readSource(path.join(process.cwd(), 'src', 'styles', 'settings-pages.css'));
  const main = readSource(path.join(process.cwd(), 'src', 'main.tsx'));
  // Loaded after the shared surfaces so it wins over index.css and the lazy section sheets.
  assert.match(main, /import '\.\/styles\/surfaces\.css';\nimport '\.\/styles\/settings-pages\.css';/);
  assert.match(css, /\.settings-directory-search \{[^}]*height: 44px;/);
  assert.match(css, /\.settings-directory-list > button \{[^}]*min-height: 44px;/);
  assert.match(css, /:is\(\.settings-input, \.settings-number, \.settings-select\) \{[^}]*height: 44px;[^}]*border: 6px solid transparent;/);
  assert.match(css, /:is\(\.primary-inline, \.secondary-inline, \.ghost-inline, \.danger-inline\) \{[^}]*min-height: 44px;/);
  assert.match(css, /:is\(\.primary-inline, \.secondary-inline, \.ghost-inline, \.danger-inline\)::before \{[^}]*inset: 6px 0;/);
  assert.match(css, /\.settings-input-affix \{[^}]*width: 44px;[^}]*height: 44px;/);
  assert.match(css, /\.share-modal-close \{[^}]*width: 44px;[^}]*height: 44px;/);
  assert.match(css, /\.share-privacy-toggle \{[^}]*min-height: 44px;/);
});
