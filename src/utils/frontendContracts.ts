/**
 * 前端契约工具的统一 barrel。实现按域拆分到 `./contracts/` 子模块：
 * - cloud.ts     云端身份/故障分类/连接配置/壁纸授权/v2 能力
 * - statsQuery.ts 统计查询规范化/StatsData 契约/趋势/快照/平台探测
 * - quota.ts     额度 Provider/窗口/同步状态校验
 * - insights.ts  缓存复用率、消耗速率预测与 HTML 转义
 * 保持原有 `import { X } from '../utils/frontendContracts'` 导入面不变。
 */
export * from './contracts/cloud';
export * from './contracts/statsQuery';
export * from './contracts/quota';
export * from './contracts/insights';
