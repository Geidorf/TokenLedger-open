function rawQuotaErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Keep parser/transport details out of the user-facing dashboard alert. */
export function formatQuotaLoadError(error: unknown): string {
  const message = rawQuotaErrorMessage(error).toLowerCase();
  if (message.includes('额度 provider 契约无效') || message.includes('source_schema_unsupported')) {
    return '来源数据格式暂时无法识别。';
  }
  if (message.includes('auth') || message.includes('unauthor') || message.includes('授权') || message.includes('登录')) {
    return '额度来源需要重新授权。';
  }
  if (message.includes('timeout') || message.includes('timed out') || message.includes('超时')) {
    return '额度来源响应超时，已保留最近可用快照。';
  }
  return '额度来源暂时无法读取。';
}
