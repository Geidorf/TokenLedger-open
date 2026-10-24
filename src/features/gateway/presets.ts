import type { BrandIconId } from '../../prototypes/prototypeKit';
import type { WireApi } from './types';
import { t } from '../../i18n';

export interface ProviderPreset {
  id: string;
  name: string;
  monogram: string;
  icon?: BrandIconId;
  baseUrl: string;
  wire: WireApi;
  /** Editable suggestions; the user can change the list before saving. */
  models: string[];
  keyless?: boolean;
  authMode?: 'key' | 'none';
  custom?: boolean;
}

export interface ProviderPresetGroup {
  id: string;
  label: string;
  presets: ProviderPreset[];
}

// Endpoints from each vendor's public docs. The gateway speaks Responses,
// Chat Completions and Anthropic Messages upstream.
export const PROVIDER_PRESET_GROUPS: ProviderPresetGroup[] = [
  {
    id: 'global',
    get label() { return t('presets.group.global'); },
    presets: [
      { id: 'openai', name: 'OpenAI', monogram: 'AI', icon: 'openai', baseUrl: 'https://api.openai.com/v1', wire: 'responses', models: ['gpt-5', 'gpt-5-mini'] },
      { id: 'anthropic', name: 'Anthropic', monogram: 'A', icon: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', wire: 'anthropic', models: [] },
      { id: 'gemini', name: 'Google Gemini', monogram: 'G', icon: 'gemini-color', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', wire: 'chat', models: [] },
      { id: 'openrouter', name: 'OpenRouter', monogram: 'OR', icon: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', wire: 'chat', models: [] },
      { id: 'xai', name: 'xAI', monogram: 'X', icon: 'xai', baseUrl: 'https://api.x.ai/v1', wire: 'chat', models: [] },
      { id: 'mistral', name: 'Mistral', monogram: 'M', icon: 'mistral-color', baseUrl: 'https://api.mistral.ai/v1', wire: 'chat', models: [] },
      { id: 'groq', name: 'Groq', monogram: 'GQ', icon: 'groq', baseUrl: 'https://api.groq.com/openai/v1', wire: 'chat', models: [] },
    ],
  },
  {
    id: 'cn',
    get label() { return t('presets.group.cn'); },
    presets: [
      { id: 'deepseek', name: 'DeepSeek', monogram: 'DS', icon: 'deepseek-color', baseUrl: 'https://api.deepseek.com/v1', wire: 'chat', models: ['deepseek-chat', 'deepseek-reasoner'] },
      { id: 'kimi', name: 'Kimi', monogram: 'K', icon: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', wire: 'chat', models: [] },
      { id: 'glm', get name() { return t('presets.glm'); }, monogram: 'Z', icon: 'zhipu-color', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', wire: 'chat', models: [] },
      { id: 'qwen', get name() { return t('presets.qwen'); }, monogram: 'Q', icon: 'qwen-color', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', wire: 'chat', models: [] },
      { id: 'ark', get name() { return t('presets.ark'); }, monogram: '火', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', wire: 'chat', models: [] },
      { id: 'siliconflow', get name() { return t('presets.siliconflow'); }, monogram: 'SF', icon: 'siliconcloud-color', baseUrl: 'https://api.siliconflow.cn/v1', wire: 'chat', models: [] },
    ],
  },
  {
    id: 'relay',
    get label() { return t('presets.group.relay'); },
    presets: [
      { id: 'custom', get name() { return t('presets.customOpenai'); }, monogram: '+', baseUrl: '', wire: 'chat', models: [], custom: true },
      { id: 'custom-anthropic', get name() { return t('presets.customAnthropic'); }, monogram: '+A', baseUrl: '', wire: 'anthropic', models: [], custom: true },
    ],
  },
  {
    id: 'local',
    get label() { return t('presets.group.local'); },
    presets: [
      { id: 'ollama', name: 'Ollama', monogram: 'OL', icon: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', wire: 'chat', models: [], keyless: true, authMode: 'none' },
      { id: 'lmstudio', name: 'LM Studio', monogram: 'LM', baseUrl: 'http://127.0.0.1:1234/v1', wire: 'chat', models: [], keyless: true, authMode: 'none' },
    ],
  },
];

export const ALL_PRESETS = PROVIDER_PRESET_GROUPS.flatMap((group) => group.presets);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Best-effort brand match for a saved provider: same id, else same host. */
export function presetFor(provider: { id: string; baseUrl: string }): ProviderPreset | null {
  const host = hostOf(provider.baseUrl);
  return ALL_PRESETS.find((preset) => preset.id === provider.id)
    ?? ALL_PRESETS.find((preset) => !preset.custom && hostOf(preset.baseUrl) === host)
    ?? null;
}

export { hostOf };
