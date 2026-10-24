import { deleteContentSamples, readContentSample, setContentSampling, contentSamplingStatus } from './api';
import type { ContentSample, ContentSamplingInput, ContentSamplingStatus } from './types';

export const contentSamplingApi = {
  status: contentSamplingStatus,
  set: setContentSampling,
  read: readContentSample,
  remove: deleteContentSamples,
};

/** 常见凭据格式在默认视图中打码；只有用户显式要求才显示原文。 */
export function maskSecrets(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1••••')
    .replace(/\b(AKIA)[A-Z0-9]{16}\b/g, '$1••••••••')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1••••••••')
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|token|secret|password)\b["']?\s*[:=]\s*["']?)([^\s"',}]{8,})/gi,
      '$1••••••••',
    );
}

export type SamplingStatusLoader = () => Promise<ContentSamplingStatus>;
export type SamplingStatusSetter = (input: ContentSamplingInput) => Promise<ContentSamplingStatus>;
export type SampleReader = (id: string) => Promise<ContentSample>;
