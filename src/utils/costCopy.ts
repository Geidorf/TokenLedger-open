// 费用叫法的固定文案（T10.154 §1 术语表、§4.2 说明文字）。各表面引用这里的函数，
// 不各写一份；数字格式在 `format.ts`（formatEstimatedUsd / formatSignedUsd）。
// 文字在文案表里；`target` 让还没迁完的中文表面（导出报告等）固定取中文。
import { t, type Lang } from '../i18n';

/** 金额主标签。 */
export function estimatedCostLabel(target?: Lang): string {
  return t('cost.label', undefined, target);
}

/** 短注（D1 原文）：跟在预估费用、缓存节省等估算金额旁边。 */
export function estimatedCostNote(target?: Lang): string {
  return t('cost.note', undefined, target);
}

/** KPI「预估费用 ⓘ」帮助弹层的正文（§4.2 第一条；订阅相关的几条属于 B 期）。 */
export function estimatedCostHelp(target?: Lang): string {
  return t('cost.help', undefined, target);
}

/** 总额不可得时 KPI 副行的原因（§4.3「总额不可得」）。 */
export function estimatedCostUnavailableReason(target?: Lang): string {
  return t('cost.unavailableReason', undefined, target);
}
