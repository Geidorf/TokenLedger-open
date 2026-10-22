/** 契约子模块共享的内部类型守卫，不进入 frontendContracts 的 barrel 公共面。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
