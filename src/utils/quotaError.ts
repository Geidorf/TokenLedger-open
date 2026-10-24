import { t } from '../i18n';

function rawQuotaErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Keep parser/transport details out of the user-facing dashboard alert. */
export function formatQuotaLoadError(error: unknown): string {
  const message = rawQuotaErrorMessage(error).toLowerCase();
  if (message.includes('额度 provider 契约无效') || message.includes('source_schema_unsupported')) {
    return t('quotaErr.schema');
  }
  if (message.includes('auth') || message.includes('unauthor') || message.includes('授权') || message.includes('登录')) {
    return t('quotaErr.auth');
  }
  if (message.includes('timeout') || message.includes('timed out') || message.includes('超时')) {
    return t('quotaErr.timeout');
  }
  return t('quotaErr.unavailable');
}
