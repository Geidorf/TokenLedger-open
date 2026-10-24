import type { PriceTableStatus } from '../types';
import { formatLocalDateTime } from './format';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isOptionalString = (value: unknown): value is string | null => value === null || typeof value === 'string';

/** 校验 `get_price_table_status` 的返回；形状不对时当作不可得，不拼凑出处。 */
export function parsePriceTableStatus(value: unknown): PriceTableStatus | null {
  if (!isRecord(value)) return null;
  const {
    source, revision, verifiedAt, updatedAt, bundledRevision, bundledVerifiedAt,
    fetchedAt, lastCheckedAt, lastError, autoUpdate, overrideModels,
  } = value;
  if (source !== 'bundled' && source !== 'online') return null;
  if (!isCount(revision) || !isCount(bundledRevision) || !isCount(overrideModels)) return null;
  if (typeof verifiedAt !== 'string' || typeof bundledVerifiedAt !== 'string') return null;
  if (![updatedAt, fetchedAt, lastCheckedAt, lastError].every(isOptionalString)) return null;
  if (typeof autoUpdate !== 'boolean') return null;
  return {
    source,
    revision,
    verifiedAt,
    updatedAt: updatedAt as string | null,
    bundledRevision,
    bundledVerifiedAt,
    fetchedAt: fetchedAt as string | null,
    lastCheckedAt: lastCheckedAt as string | null,
    lastError: lastError as string | null,
    autoUpdate,
    overrideModels,
  };
}

/** 一句话出处，例如「内置价格表（第 2 版）· 官方价核验于 2026-09-24」。 */
export function describePriceTableSource(status: PriceTableStatus): string {
  const origin = status.source === 'online' ? '在线更新的价格表' : '内置价格表';
  const parts = [`${origin}（第 ${status.revision} 版）`, `官方价核验于 ${status.verifiedAt}`];
  if (status.source === 'online' && status.fetchedAt) parts.push(`${formatLocalDateTime(status.fetchedAt)} 下载`);
  if (status.overrideModels > 0) parts.push(`${status.overrideModels} 个型号用自定义价格`);
  return parts.join(' · ');
}

/** 最近一次在线检查的结果。 */
export function describePriceTableCheck(status: PriceTableStatus): string {
  if (!status.lastCheckedAt) return status.autoUpdate ? '尚未检查在线更新' : '自动更新已关闭';
  const when = formatLocalDateTime(status.lastCheckedAt);
  return status.lastError ? `${when} 检查失败：${status.lastError}` : `${when} 检查过，已是最新`;
}
