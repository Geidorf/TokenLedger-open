import type { CSSProperties } from 'react';
import type { BrandIconId } from '../../prototypes/prototypeKit';

let RAW_BRAND_SVGS: Record<string, string> = {};
try {
  RAW_BRAND_SVGS = import.meta.glob('../../prototypes/brand-icons/*.svg', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>;
} catch {
  RAW_BRAND_SVGS = {};
}

const CUSTOM_BRAND_SVGS: Record<string, string> = {
  antigravity: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="tl-agy" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse"><stop stop-color="#60A5FA"/><stop offset="0.55" stop-color="#818CF8"/><stop offset="1" stop-color="#C084FC"/></linearGradient></defs><path d="M12 2.75L14.65 9.35L21.25 12L14.65 14.65L12 21.25L9.35 14.65L2.75 12L9.35 9.35L12 2.75Z" fill="url(#tl-agy)"/><circle cx="12" cy="12" r="2.2" fill="#FFFFFF" fill-opacity="0.92"/></svg>`,
  trae: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="tl-trae" x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse"><stop stop-color="#34D399"/><stop offset="1" stop-color="#06B6D4"/></linearGradient></defs><rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="url(#tl-trae)"/><path d="M7.75 9H16.25M12 9V16.25" stroke="#081018" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  minimax: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="tl-mm" x1="3" y1="4" x2="21" y2="20" gradientUnits="userSpaceOnUse"><stop stop-color="#FB7185"/><stop offset="1" stop-color="#F97316"/></linearGradient></defs><rect x="3" y="4" width="18" height="16" rx="5" fill="url(#tl-mm)"/><path d="M6.75 15.25V8.75L10.1 13.1L12 10.5L13.9 13.1L17.25 8.75V15.25" stroke="#FFFFFF" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  pi: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="tl-pi" x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse"><stop stop-color="#8B5CF6"/><stop offset="1" stop-color="#3B82F6"/></linearGradient></defs><rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="url(#tl-pi)"/><path d="M7.5 9.25H16.5M10.1 9.25V15.75M14.1 9.25V14.4C14.1 15.15 14.65 15.75 15.4 15.75" stroke="#FFFFFF" stroke-width="2.05" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

export function resolveBrandIconKey(rawName?: string | null): BrandIconId | keyof typeof CUSTOM_BRAND_SVGS | null {
  if (!rawName) return null;
  const key = rawName.trim().toLowerCase();
  if (!key) return null;

  if (key.includes('claudecode') || key.includes('claude-code') || key.includes('claude_code') || key === 'claude') {
    return 'claudecode-color';
  }
  if (key.includes('anthropic') || key.startsWith('claude-')) {
    return 'claude-color';
  }
  if (key.includes('codex')) {
    return 'codex-color';
  }
  if (key.includes('openai') || key.startsWith('gpt-') || key.startsWith('o1') || key.startsWith('o3') || key.startsWith('o4')) {
    return 'openai';
  }
  if (key.includes('antigravity') || key === 'agy' || key.includes('google-antigravity')) {
    return 'antigravity';
  }
  if (key.includes('geminicli') || key.includes('gemini-cli') || key.includes('gemini_cli')) {
    return 'geminicli-color';
  }
  if (key.includes('gemini') || key.includes('google')) {
    return 'gemini-color';
  }
  if (key.includes('deepseek')) {
    return 'deepseek-color';
  }
  if (key.includes('cursor')) {
    return 'cursor';
  }
  if (key.includes('kimi')) {
    return 'kimi';
  }
  if (key.includes('moonshot')) {
    return 'moonshot';
  }
  if (key.includes('qwen') || key.includes('tongyi') || key.includes('dashscope')) {
    return 'qwen-color';
  }
  if (key.includes('zhipu') || key.includes('glm') || key.includes('chatglm')) {
    return 'zhipu-color';
  }
  if (key.includes('openrouter')) {
    return 'openrouter';
  }
  if (key.includes('opencode') || key.includes('open-code')) {
    return 'opencode';
  }
  if (key.includes('mistral') || key.includes('codestral')) {
    return 'mistral-color';
  }
  if (key.includes('groq')) {
    return 'groq';
  }
  if (key.includes('ollama')) {
    return 'ollama';
  }
  if (key.includes('silicon') || key.includes('siliconflow') || key.includes('siliconcloud')) {
    return 'siliconcloud-color';
  }
  if (key.includes('xai') || key.includes('grok')) {
    return 'xai';
  }
  if (key.includes('trae')) {
    return 'trae';
  }
  if (key.includes('minimax') || key.includes('abab')) {
    return 'minimax';
  }
  if (key === 'pi' || key.includes('pi-coding') || key.includes('pi_agent')) {
    return 'pi';
  }
  return null;
}

export interface BrandIconProps {
  name?: string | null;
  color?: string;
  size?: number;
  className?: string;
}

export function BrandIcon({ name, color, size = 18, className = '' }: BrandIconProps) {
  const iconKey = resolveBrandIconKey(name);
  const svg = iconKey
    ? CUSTOM_BRAND_SVGS[iconKey] ?? RAW_BRAND_SVGS[`../../prototypes/brand-icons/${iconKey}.svg`]
    : undefined;
  const style: CSSProperties = {
    width: size,
    height: size,
    '--tl-brand-accent': color || 'var(--color-primary)',
  } as CSSProperties;

  if (svg) {
    return (
      <span
        className={`tl-brand-badge ${className}`.trim()}
        style={style}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  const initial = (name || '?').trim().replace(/^[^a-zA-Z0-9\u4e00-\u9fff]+/, '').slice(0, 1).toUpperCase() || '?';
  return (
    <span
      className={`tl-brand-badge is-fallback ${className}`.trim()}
      style={{
        ...style,
        fontSize: Math.max(9, Math.round(size * 0.52)),
      }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

export default BrandIcon;
