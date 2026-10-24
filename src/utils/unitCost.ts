import { formatUsdApprox } from './format';
import { t } from '../i18n';

/**
 * 单位费用：每百万有效 Token 的预估费用（T10.154 术语表：单价写「单位费用」，不写「单位成本」）。
 * 总览趋势卡（T10.159）与专属看板条带（T10.163）共用这里的计算、显示与保护，两处不再各写一份。
 *
 * - 分母是有效 Token（输入 + 输出），缓存读写不计入；分子是按价格表估算的费用（含缓存读写费用），不是账单。
 * - 费用未知（null、非有限、负数）或有效 Token 不是正数时算不出，显示「不可得」，绝不写成 $0（GLB-01）。
 * - 大于 0 但不到 $0.01 时显示「<$0.01/百万 Token」，不四舍五入成 $0.00；其余显示「≈$x.xx/百万 Token」，
 *   ≈ 表示按价格表估算。
 *
 * 用法：标签用 `unitCostLabel()`，值用 `formatUnitCost(computeUnitCostUsd(costUsd, effectiveTokens))`。
 */
export function unitCostLabel(): string {
  return t('unitCost.label');
}

/** 单元格与 tooltip 的口径说明。 */
export function unitCostDescription(): string {
  return t('unitCost.description');
}

/** 算不出时的显示文字。 */
export function unitCostUnavailable(): string {
  return t('unitCost.unavailable');
}


/** 每百万有效 Token 的预估美元；费用未知或有效 Token 不是正数时返回 null。 */
export function computeUnitCostUsd(
  costUsd: number | null | undefined,
  effectiveTokens: number | null | undefined,
): number | null {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return null;
  if (typeof effectiveTokens !== 'number' || !Number.isFinite(effectiveTokens) || effectiveTokens <= 0) return null;
  return (costUsd / effectiveTokens) * 1_000_000;
}

/** `computeUnitCostUsd` 结果的显示文字：null 写「不可得」，0 < 值 < $0.01 写「<$0.01/百万 Token」。 */
export function formatUnitCost(valueUsd: number | null | undefined): string {
  if (typeof valueUsd !== 'number' || !Number.isFinite(valueUsd) || valueUsd < 0) return unitCostUnavailable();
  if (valueUsd > 0 && valueUsd < 0.01) return `<$0.01${t('unitCost.perMillion')}`;
  return `${formatUsdApprox(valueUsd)}${t('unitCost.perMillion')}`;
}
