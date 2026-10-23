import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DetailFilters } from '../components/LogsTable';
import {
  beginRequest,
  hasCloudCapability,
  isCurrentRequest,
  isUnavailableEnvelope,
  mergeUsageDetails,
  normalizeStatsQuery,
  queryEchoMatches,
} from '../utils/frontendContracts';
import { collectAllDetails, REQUESTS_CSV_MAX_ROWS, requestsToCsv } from '../utils/requestsCsv';
import {
  CustomDateRange,
  DataScope,
  RangeKey,
  StatsData,
  UsageDetailsEnvelope,
  UsageDetailsQuery,
  UsageDetailsResponse,
} from '../types';

export const EMPTY_DETAIL_FILTERS: DetailFilters = { tools: [], models: [], machines: [], search: '' };

const BACKEND_REASON_LABELS: Record<string, string> = {
  cloud_stats_v2_unavailable: '云端尚未部署 Stats v2 RPC，请联系部署负责人发布最新迁移。',
  cloud_usage_details_unavailable: '云端消耗明细 RPC 尚未部署，请联系部署负责人发布最新迁移。',
  cloud_entity_dashboard_unavailable: '云端专属看板 RPC 尚未部署，请联系部署负责人发布最新迁移。',
  'cloud-stats-v2-rpc-unavailable': '云端尚未部署 Stats v2 RPC，请联系部署负责人发布最新迁移。',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function unavailableMessage(value: unknown, fallback: string) {
  if (!isRecord(value) || value.status !== 'unavailable') return null;
  const reason = typeof value.reasonCode === 'string' ? value.reasonCode : '';
  const unavailable = isRecord(value.unavailable) ? value.unavailable : null;
  const code = unavailable && typeof unavailable.code === 'string' ? unavailable.code : '';
  const message = unavailable && typeof unavailable.message === 'string' ? unavailable.message : '';
  return BACKEND_REASON_LABELS[reason] || BACKEND_REASON_LABELS[code] || message || reason || code || fallback;
}

export interface UseUsageDetailsProps {
  dataScope: DataScope;
  range: RangeKey;
  /** `range === 'custom'` 时的日期闭区间；其余范围忽略。 */
  customRange?: CustomDateRange | null;
  deviceFilter: string;
  stats: StatsData | null;
  /**
   * 统计契约的真实失败原因（`useStats.statsError`）。云端 stats 为 null 时，只有它非空才代表
   * 真的失败；为空时只是还没到达，不得诊断为旧版契约（T10.180，修正 stats 未到达时的误报）。
   */
  statsError: string;
  currentTimezone: () => string;
}

export function useUsageDetails({
  dataScope,
  range,
  customRange = null,
  deviceFilter,
  stats,
  statsError,
  currentTimezone,
}: UseUsageDetailsProps) {
  const [detailFilters, setDetailFilters] = useState<DetailFilters>(EMPTY_DETAIL_FILTERS);
  const [details, setDetails] = useState<UsageDetailsResponse | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsLoadingMore, setDetailsLoadingMore] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [detailsExporting, setDetailsExporting] = useState(false);
  const detailRequestId = useRef(0);

  const fetchDetailsPage = useCallback(async (cursor: string | null, limit: number): Promise<UsageDetailsResponse> => {
    const inheritedMachines = detailFilters.machines.length === 0
      && dataScope === 'cloud'
      && deviceFilter !== 'all_cloud'
      ? [deviceFilter]
      : detailFilters.machines;
    const canonicalQuery = normalizeStatsQuery({
      range,
      start: customRange?.start,
      end: customRange?.end,
      timezone: currentTimezone(),
      machines: inheritedMachines,
      tools: detailFilters.tools,
      models: detailFilters.models,
      search: detailFilters.search,
      tokenMode: 'effective',
    });
    const query: UsageDetailsQuery = {
      scope: dataScope,
      ...canonicalQuery,
      cursor,
      limit,
    };
    const response = await invoke<UsageDetailsEnvelope>('get_usage_details', { query });
    const unavailable = unavailableMessage(response, '当前数据源不支持完整消耗明细。');
    if (isUnavailableEnvelope(response)) throw new Error(unavailable || '当前数据源不支持完整消耗明细。');
    if (!queryEchoMatches(response.meta?.query, canonicalQuery, response.meta?.entity)) {
      throw new Error('明细响应与当前筛选不一致，请重试。');
    }
    return response;
  }, [currentTimezone, customRange, dataScope, detailFilters.machines, detailFilters.models, detailFilters.search, detailFilters.tools, deviceFilter, range]);

  const loadDetails = useCallback(async (cursor: string | null = null, append = false) => {
    const requestId = beginRequest(detailRequestId);
    // 云端 stats 还没到达时，还不知道是否具备明细分页能力，不能诊断为旧版契约：
    // 真的失败了就转述 statsError；没有失败就是仍在加载（T10.180）。
    if (dataScope === 'cloud' && !stats) {
      setDetails(null);
      setDetailsLoadingMore(false);
      setDetailsLoading(!statsError);
      setDetailsError(statsError);
      return;
    }
    const cloudDetailsSupported = hasCloudCapability(stats, 'detailPagination');
    if (dataScope === 'cloud' && !cloudDetailsSupported) {
      setDetails(null);
      setDetailsLoading(false);
      setDetailsLoadingMore(false);
      setDetailsError('当前云端仍使用旧版统计契约，完整消耗明细入口已停用。请联系部署负责人发布最新迁移，或切换到本地机器。');
      return;
    }
    setDetailsError('');
    if (append) setDetailsLoadingMore(true);
    else {
      setDetailsLoading(true);
      setDetails(null);
    }
    try {
      const response = await fetchDetailsPage(cursor, 50);
      if (!isCurrentRequest(detailRequestId, requestId)) return;
      setDetails((previous) => mergeUsageDetails(previous, response, append));
      setDetailsError('');
    } catch (err) {
      if (!isCurrentRequest(detailRequestId, requestId)) return;
      setDetailsError(err instanceof Error ? err.message : String(err));
      if (!append) setDetails(null);
    } finally {
      if (isCurrentRequest(detailRequestId, requestId)) {
        setDetailsLoading(false);
        setDetailsLoadingMore(false);
      }
    }
  }, [dataScope, fetchDetailsPage, stats, statsError]);

  /**
   * 用量 · 请求的「导出 CSV」：沿当前范围与筛选逐页取完（不只是已加载的行），生成 CSV 交给后端写文件。
   * 与列表共用同一份查询，导出的就是列表能翻到的全部行。
   */
  const exportDetailsCsv = useCallback(async (): Promise<{ message: string; path: string }> => {
    if (!details) throw new Error('明细尚未加载，无法导出');
    setDetailsExporting(true);
    try {
      const { items, truncated } = await collectAllDetails((cursor) => fetchDetailsPage(cursor, 100));
      const result = await invoke<{ message: string; path: string }>('export_usage_csv', { content: requestsToCsv(items) });
      return truncated
        ? { ...result, message: `${result.message}（已达单次上限 ${REQUESTS_CSV_MAX_ROWS.toLocaleString('zh-CN')} 行，请缩小范围导出其余部分）` }
        : result;
    } finally {
      setDetailsExporting(false);
    }
  }, [details, fetchDetailsPage]);

  const updateDetailFilter = useCallback((key: keyof DetailFilters, value: string | string[]) => {
    setDetailFilters((previous) => ({ ...previous, [key]: value }) as DetailFilters);
  }, []);

  return {
    detailFilters,
    setDetailFilters,
    details,
    setDetails,
    detailsLoading,
    detailsLoadingMore,
    detailsError,
    setDetailsError,
    detailRequestId,
    loadDetails,
    detailsExporting,
    exportDetailsCsv,
    updateDetailFilter,
  };
}
