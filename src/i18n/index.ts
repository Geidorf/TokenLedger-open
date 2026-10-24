import { useSyncExternalStore } from 'react';
import { en } from './en';
import { zh, type MessageKey } from './zh';

export type { MessageKey } from './zh';

/** UI language actually rendered. */
export type Lang = 'zh' | 'en';
/** What the user picked; `system` follows the OS/browser language. */
export type LangPreference = Lang | 'system';

export const LANG_STORAGE_KEY = 'tokenledger.lang.v1';
export const MESSAGES: Record<Lang, Record<MessageKey, string>> = { zh, en };

type Vars = Record<string, string | number>;

// Chinese stays the default until every page has English copy, so a fresh
// install on an English OS does not land on a half-translated app.
const DEFAULT_PREFERENCE: LangPreference = 'zh';

function isPreference(value: unknown): value is LangPreference {
  return value === 'zh' || value === 'en' || value === 'system';
}

function readStoredPreference(): LangPreference {
  try {
    const query = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('lang') : null;
    if (isPreference(query)) return query;
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(LANG_STORAGE_KEY) : null;
    return isPreference(stored) ? stored : DEFAULT_PREFERENCE;
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

function systemLang(): Lang {
  const languages = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  const first = languages.find(Boolean) ?? 'zh';
  return first.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function resolveLang(preference: LangPreference): Lang {
  return preference === 'system' ? systemLang() : preference;
}

let preference: LangPreference = readStoredPreference();
let lang: Lang = resolveLang(preference);
const listeners = new Set<() => void>();

function applyDocumentLang() {
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}
applyDocumentLang();

export function getLang(): Lang {
  return lang;
}

export function getLangPreference(): LangPreference {
  return preference;
}

export function setLangPreference(next: LangPreference) {
  preference = next;
  try {
    localStorage.setItem(LANG_STORAGE_KEY, next);
  } catch {
    // Private windows may refuse storage; the choice still applies to this session.
  }
  const resolved = resolveLang(next);
  if (resolved === lang) {
    listeners.forEach((listener) => listener());
    return;
  }
  lang = resolved;
  applyDocumentLang();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Fills `{name}` placeholders; unknown placeholders are left as written. */
export function format(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** Translates outside React (pure helpers); components should use `useT`. */
export function t(key: MessageKey, vars?: Vars, target: Lang = lang): string {
  return format(MESSAGES[target][key] ?? zh[key], vars);
}

/** Number formatting that follows the UI language. */
export function formatCount(value: number, target: Lang = lang): string {
  return value.toLocaleString(target === 'zh' ? 'zh-CN' : 'en-US');
}

/** Re-renders the caller when the language changes. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

export function useLangPreference(): LangPreference {
  return useSyncExternalStore(subscribe, getLangPreference, getLangPreference);
}

/** `const t = useT(); t('key', { n: 1 })` */
export function useT(): (key: MessageKey, vars?: Vars) => string {
  const current = useLang();
  return (key, vars) => t(key, vars, current);
}

/**
 * A label table whose values are looked up on each read, so module-level maps
 * such as `STATUS_LABEL[code]` follow the current language.
 */
export function localized<K extends string>(keys: Record<K, MessageKey>): Record<K, string> {
  const table = {} as Record<K, string>;
  for (const name of Object.keys(keys) as K[]) {
    Object.defineProperty(table, name, { enumerable: true, get: () => t(keys[name]) });
  }
  return table;
}
