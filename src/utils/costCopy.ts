// 费用叫法的固定文案（T10.154 §1 术语表、§4.2 说明文字）。各表面引用这里的常量，
// 不各写一份；数字格式在 `format.ts`（formatEstimatedUsd / formatSignedUsd）。

/** 金额主标签。 */
export const ESTIMATED_COST_LABEL = '预估费用';

/** 短注（D1 原文）：跟在预估费用、缓存节省等估算金额旁边。 */
export const ESTIMATED_COST_NOTE = '按价格表估算，非账单';

/** KPI「预估费用 ⓘ」帮助弹层的正文（§4.2 第一条；订阅相关的几条属于 B 期）。 */
export const ESTIMATED_COST_HELP = '按模型价格表估算；工具日志自带费用时直接采用。都不是供应商账单，实际以账单为准。价格表为标准档，长上下文加价、批处理与渠道加价未计入。';

/** 总额不可得时 KPI 副行的原因（§4.3「总额不可得」）。 */
export const ESTIMATED_COST_UNAVAILABLE_REASON = '来源未提供可验证的费用';
