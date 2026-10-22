import { formatEstimatedUsd } from './format';

/** 净节省可为负；费用格式化仍保持只接受非负值的原契约。 */
export function formatCacheNetSavedUsd(value: number): string {
  if (!Number.isFinite(value)) return '不可得';
  if (value >= 0) return formatEstimatedUsd(value);
  return value > -0.01 ? '−<$0.01' : `≈−${formatEstimatedUsd(-value).slice(1)}`;
}
